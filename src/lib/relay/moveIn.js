// ─────────────────────────────────────────────────────────────────────────────
// MOVE-IN: USDC from the user's own Perp account into their own Avax Wallet
// (stake ①, swap ①, "Move to Avax Wallet"), with a gas top-up only when the
// wallet's AVAX is below what the plan needs — and then PRINTED, never silent.
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §3.1 (Move-in row), §3.2, §3.4 (AD-5, AD-8). Live 2026-10-15 (read-only
// quote, scripts/fixtures/avax/live-move-in-6-topup.json): 6 USDC arriving with
// $0.30 of gas costs 6.342288 from the Perp account — 0.031560 AVAX delivered,
// 0.042 of fee — in about 1 s, two windows (authorize + sendAsset), no AVAX needed.
//
// 🔴 RULES
//   * No recipient parameter (plan §3.8.3). The body is built from `own`.
//   * EXACT_OUTPUT: X is what arrives; the debit is capped by maxDebitUsdc
//     (plan §2.9: X + max(0.25, 2 % X) + 1.5 × topupUsd), refused above it.
//   * topupGas is ALWAYS sent with an explicit amount in [$0.20, $0.50] (sized by
//     lib/avax/gas.js from need − AVAX); out of that band is refused here too.
//   * {body, gasRow}: a body with topupGas and no gasRow can never be confirmed
//     (moveInConfirmable), and the test suite holds that.
//
// Pure apart from quoteMoveIn's one POST /quote/v2 (a quote executes nothing).

import { isEvmAddress } from "./withdraw.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import { AVAX_USDC_DECIMALS } from "../avax/relayPins.js";
import { toRaw } from "../avax/swapDecode.js";
import { TOPUP_USD, gasRow as gasRowOf, gasRowProblem } from "../avax/gas.js";
import {
  OwnMoveError, buildOwnMoveQuoteBody, parseOwnMoveQuote, postRelayQuote, TOPUP_SCALE_PER_USD,
} from "./ownMove.js";

/** Relay's own floor for a USDC move (the Withdraw sheet's RELAY_MIN_WITHDRAW_USDC). Stake asks 5 (guardrails). */
export const MIN_MOVE_IN_USDC = 1;
/** Hard ceiling per move (plan §2.9 HARD.moveUsdc / stakeUsdc). Env may lower it, never raise it. */
export const HARD_MAX_MOVE_USDC = 20;
/** The gas top-up band (plan §2.9 TOPUP_USD) — lib/avax/gas.js's, re-exported. */
export { TOPUP_USD };

/** The most a stake/move may cost on top of what arrives: max(0.25, 2 % of X) (plan §2.9 STAKE_FEE_CEILING). */
export function stakeFeeCeiling(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.max(0.25, 0.02 * n) : null;
}

/**
 * The per-move cap an env value asks for, clamped to the hard cap. Env may LOWER it,
 * never raise it (ATK-13b): 0 means moves are off, unset or unreadable means the
 * hard cap, a negative is read as off.
 */
export function resolveMoveCapUsdc(maxMoveUsdc = HARD_MAX_MOVE_USDC) {
  if (maxMoveUsdc == null || (typeof maxMoveUsdc === "string" && !maxMoveUsdc.trim())) return HARD_MAX_MOVE_USDC;
  const n = typeof maxMoveUsdc === "number" ? maxMoveUsdc
    : typeof maxMoveUsdc === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(maxMoveUsdc.trim()) ? Number(maxMoveUsdc) : NaN;
  if (!Number.isFinite(n)) return HARD_MAX_MOVE_USDC;
  return n <= 0 ? 0 : Math.min(n, HARD_MAX_MOVE_USDC);
}

/**
 * maxDebit(X, topupUsd) = X + STAKE_FEE_CEILING(X) + 1.5 × topupUsd, rounded UP to 6 dp —
 * and never above the per-move cap (plan §2.9 / §3.5 "debit ≤ MAX_MOVE_USDC": the cap
 * bounds what LEAVES the Perp account, not only what arrives — ATK-13a). Null when X is unusable.
 */
export function maxDebitUsdc(x, topupUsd = 0, maxMoveUsdc = HARD_MAX_MOVE_USDC) {
  const c = stakeFeeCeiling(x);
  const t = topupUsd == null ? 0 : Number(topupUsd);
  if (c == null || !Number.isFinite(t) || t < 0) return null;
  const formula = Math.ceil((Number(x) + c + 1.5 * t) * 1e6 - 1e-6) / 1e6;
  return Math.min(formula, resolveMoveCapUsdc(maxMoveUsdc));
}

/** Is this top-up size inside the band? null (no top-up) is fine. */
export function topupUsdOk(usd) {
  if (usd == null) return true;
  const n = Number(usd);
  return Number.isFinite(n) && n >= TOPUP_USD.min - 1e-9 && n <= TOPUP_USD.max + 1e-9;
}

/**
 * The move-in body and the row the card must print for it.
 * @param {{ own: string, amountUsdc: string|number, topupUsd?: number|null, expectedAvaxWei?: bigint|null, maxMoveUsdc?: number }} o
 *   topupUsd / expectedAvaxWei: gas.js topupPlan()'s `usd` and `expectedAvaxWei` (only when AVAX < need).
 * @returns {{ body: object, gasRow: object|null, amountRaw: string }}
 *   gasRow (gas.js shape) is the PROVISIONAL row from the expected AVAX; the quote's own
 *   row replaces it (quoteMoveIn). With topupGas in the body and no expectedAvaxWei it is
 *   null — and then moveInConfirmable says no, which is the point.
 */
export function buildMoveInQuoteBody({ own, amountUsdc, topupUsd = null, expectedAvaxWei = null, maxMoveUsdc = HARD_MAX_MOVE_USDC }) {
  if (!isEvmAddress(own)) throw new OwnMoveError("bad-user", "Sign in first.");
  const raw = toRaw(amountUsdc, AVAX_USDC_DECIMALS);
  if (raw == null || raw <= 0n) throw new OwnMoveError("bad-amount", "Enter a USDC amount, with at most 6 decimals.");
  const x = Number(amountUsdc);
  const cap = resolveMoveCapUsdc(maxMoveUsdc);
  if (cap <= 0) throw new OwnMoveError("over-cap", "Moves are off in FlowFlow for now.");
  if (x < MIN_MOVE_IN_USDC) throw new OwnMoveError("too-small", `A move needs at least ${MIN_MOVE_IN_USDC} USDC.`);
  if (x > cap) throw new OwnMoveError("over-cap", `Max ${cap} USDC per move in FlowFlow for now.`);
  if (!topupUsdOk(topupUsd)) throw new OwnMoveError("bad-topup", `Gas for later is between $${TOPUP_USD.min.toFixed(2)} and $${TOPUP_USD.max.toFixed(2)}.`);
  const body = buildOwnMoveQuoteBody({ own, dest: "usdc", amountRaw: raw, topupUsd });
  const gasRow = topupUsd == null ? null : gasRowOf({ avaxWei: expectedAvaxWei, usd: Number(topupUsd), source: "move" });
  return { body, gasRow, amountRaw: raw.toString() };
}

/**
 * MAY THIS CARD SHOW CONFIRM? Only when every figure the user pays is on it
 * (AD-8, MONEY_RULES). A body that asks for gas without a gasRow, or a review
 * whose top-up has no row, is never confirmable.
 */
export function moveInConfirmable({ body, gasRow = null, review = null } = {}) {
  if (!body || typeof body !== "object") return { ok: false, why: "no-body" };
  const asksGas = body.topupGas === true || body.topupGasAmount != null;
  const problem = gasRowProblem({ body, gasRow: review ? review.gasRow : gasRow });
  if (problem) return { ok: false, why: problem };
  if (asksGas && body.topupGas !== true) return { ok: false, why: "gas-flag-missing" };
  if (review) {
    if (asksGas && (!review.topup || !review.gasRow)) return { ok: false, why: "gas-row-missing" };
    if (!asksGas && review.topup) return { ok: false, why: "unasked-gas" };
    if (asksGas && Math.round(Number(review.topup.usd) * TOPUP_SCALE_PER_USD) > Number(body.topupGasAmount) * 1.5) return { ok: false, why: "gas-over-ask" };
  }
  return { ok: true, why: null };
}

/**
 * Price a move-in and verify the answer. One POST /quote/v2; nothing is signed.
 * @returns {Promise<{ body, gasRow, review }>} gasRow is the quote's own row ("≈0.0316 AVAX ($0.30) · …").
 */
export async function quoteMoveIn({
  own, amountUsdc, topupUsd = null, maxMoveUsdc = HARD_MAX_MOVE_USDC, avaxUsd = null,
  fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, signal = null,
} = {}) {
  const { body, amountRaw } = buildMoveInQuoteBody({ own, amountUsdc, topupUsd, maxMoveUsdc });
  const json = await postRelayQuote(body, { fetchImpl, timers, signal });
  const review = parseOwnMoveQuote(json, {
    own, dest: "usdc", amountRaw, topupUsd, maxDebitUsdc: maxDebitUsdc(Number(amountUsdc), topupUsd || 0, maxMoveUsdc), avaxUsd, now: now(),
  });
  return { body, gasRow: review.gasRow, review };
}
