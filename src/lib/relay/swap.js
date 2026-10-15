// ─────────────────────────────────────────────────────────────────────────────
// SWAP ON AVALANCHE, in the user's own Avax Wallet, between whitelisted assets
// only — through Relay, same chain (43114 → 43114), the 0x route only.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner: AD-1 (swap + whitelist), AD-2 ("AvaxSwap ใช้ Relay.link ไปเลย"), AD-8 (the
// gas leg), AD-9 (the three rules, approved). Plan v2 §3.11, §3.4, §3.6.
//
// What this file does:
//   * buildSwapQuoteBody — the request: own as user / recipient / refundTo, EXACT_INPUT,
//     explicit slippage ("100", "30" for USDC↔USDT), includedSwapSources ["0x"]; never
//     usePermit (Permit2 = unlimited approve), topupGas (ignored same-chain), appFees, referrer.
//   * quoteSwap — one POST /quote/v2, then swapDecode.parseSwapQuote (rules 1 and 2).
//   * compareRequote — rule 3: a re-quote whose minimum is lower, whose gas is higher,
//     that needs an extra window, or that cannot be decoded is NEVER signed: the card
//     comes back for a new Confirm.
//   * swapLossCheck — the loss bound against an INDEPENDENT price (HL mids; USDT/USDC 1:1),
//     unknown price = refuse.
//   * the gas leg (AD-8, same chain): USDC → AVAX for $0.20–0.50 through the same parser,
//     with its "Gas for later … from your USDC" row.
//   * swapTxRequests / buildRemoveAllowanceTx — unsigned transactions with gas and
//     maxFeePerGas set by us (plan §3.4), for the closed builder in PrivyBridge.
//   * executeSwap — the run: registry → approve → receipt → eth_call preflight →
//     registry → swap → receipt. Injected sender / receipt / preflight; nothing here
//     holds a key or talks to a chain.

import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import { encodeFunctionData, parseAbi } from "viem";
import {
  AVAX_CHAIN_ID, AVAX_DEPOSITORY, RELAY_APPROVAL_PROXIES, STABLE_SYMBOLS, swapTokenBySymbol, swapTokenByAddress, SWAP_TOKENS,
} from "../avax/relayPins.js";
import { parseSwapQuote, swapGasUnits, toRaw, SwapQuoteError } from "../avax/swapDecode.js";
import { postRelayQuote, OwnMoveError } from "./ownMove.js";
import { TOPUP_USD, gasRow as gasRowOf, RESERVE_FEE_WEI, MAX_PRIORITY_FEE_WEI } from "../avax/gas.js";
import { claimRun } from "../avax/run.js";
import { nonceBinding } from "../avax/txHelpers.js";

/** Plan §2.9 SWAP, mirrored here until guardrails.resolveLimits exists (after gate). Env may lower, never raise. */
export const SWAP_LIMITS = Object.freeze({
  slippageBps: 100,
  stableSlippageBps: 30,
  maxLossPct: 2,
  priceSanityPct: 3,
  quoteTtlMs: 60_000,
  minUsd: 1,
  maxUsd: 20,
  sources: Object.freeze(["0x"]),
});

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== "0x0000000000000000000000000000000000000000";
const lower = (a) => String(a == null ? "" : a).toLowerCase();

function tokenOf(t) {
  if (t && typeof t === "object") return swapTokenByAddress(t.address);
  return swapTokenBySymbol(t) || swapTokenByAddress(t);
}

/** The slippage a pair is quoted at: 30 bps stable↔stable, 100 otherwise. */
export function swapSlippageBps(from, to) {
  const a = tokenOf(from);
  const b = tokenOf(to);
  return a && b && STABLE_SYMBOLS.includes(a.symbol) && STABLE_SYMBOLS.includes(b.symbol) ? SWAP_LIMITS.stableSlippageBps : SWAP_LIMITS.slippageBps;
}

/**
 * The swap /quote/v2 body. No recipient parameter: every role is `own`.
 * @param {{ own: string, from: string|object, to: string|object, amountRaw: string|bigint, slippageBps?: number }} o
 *   from / to: whitelist symbols ("USDC", "BTC.b") or SWAP_TOKENS rows.
 */
export function buildSwapQuoteBody({ own, from, to, amountRaw, slippageBps = null }) {
  if (!isAddr(own)) throw new SwapQuoteError("bad-user", "Swaps use your FlowFlow wallet.");
  const a = tokenOf(from);
  const b = tokenOf(to);
  if (!a || !b) throw new SwapQuoteError("not-whitelisted", "Only the assets listed in your Avax Wallet can be swapped.");
  if (a === b) throw new SwapQuoteError("same-asset", "Pick two different assets.");
  const raw = typeof amountRaw === "bigint" ? amountRaw : /^[0-9]+$/.test(String(amountRaw)) ? BigInt(amountRaw) : null;
  if (raw == null || raw <= 0n) throw new SwapQuoteError("bad-amount", "Enter an amount to swap.");
  const bps = slippageBps == null ? swapSlippageBps(a, b) : Math.min(Number(slippageBps), swapSlippageBps(a, b));
  if (!Number.isInteger(bps) || bps <= 0) throw new SwapQuoteError("bad-slippage", "The slippage is not readable.");
  return {
    user: own,
    recipient: own,
    refundTo: own,
    originChainId: AVAX_CHAIN_ID,
    destinationChainId: AVAX_CHAIN_ID,
    originCurrency: a.address,
    destinationCurrency: b.address,
    amount: raw.toString(),
    tradeType: "EXACT_INPUT",
    slippageTolerance: String(bps),
    includedSwapSources: [...SWAP_LIMITS.sources],
  };
}

/**
 * Price a swap and verify it. One POST /quote/v2; nothing is signed.
 * @returns {Promise<{ body, review }>} review = parseSwapQuote's frozen answer.
 */
export async function quoteSwap({
  own, from, to, amountRaw, slippageBps = null, settlers = undefined,
  fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, signal = null,
} = {}) {
  const body = buildSwapQuoteBody({ own, from, to, amountRaw, slippageBps });
  let json;
  try {
    json = await postRelayQuote(body, { fetchImpl, timers, signal });
  } catch (e) {
    if (e instanceof OwnMoveError && e.code === "relay-error") throw new SwapQuoteError("swap-unavailable", "Swap unavailable for this pair right now. Nothing is signed.", e.detail);
    throw e;
  }
  const review = parseSwapQuote(json, {
    own, from: body.originCurrency, to: body.destinationCurrency, amountRaw: body.amount,
    slippageBps: Number(body.slippageTolerance), ...(settlers ? { settlers } : {}), now: now(),
  });
  return { body, review };
}

/** Is this swap review still fresh enough to sign? */
export function swapFresh(review, now = Date.now(), ttlMs = SWAP_LIMITS.quoteTtlMs) {
  return !!review && Number.isFinite(review.quotedAt) && now - review.quotedAt < ttlMs;
}

/**
 * RULE 3 (AD-9.3). May a fresh quote be signed under the Confirm the user gave
 * the shown one? Only when it is the same swap and no worse in any way the card
 * printed. Anything else → { sign: false, needsConfirm: true, why } and the card
 * is shown again. Under Autopilot the same answer sends it back to a card.
 */
export function compareRequote(shown, fresh) {
  const no = (why) => ({ sign: false, needsConfirm: true, why });
  if (!shown) return no("nothing-shown");
  if (!fresh) return no("not-decodable");
  if (fresh.own !== shown.own || fresh.from !== shown.from || fresh.to !== shown.to || fresh.amountRaw !== shown.amountRaw) return no("different-swap");
  if (BigInt(fresh.minOutRaw) < BigInt(shown.minOutRaw)) return no("min-lower");
  if (fresh.needsApprove && !shown.needsApprove) return no("extra-window");
  const g0 = swapGasUnits(shown);
  const g1 = swapGasUnits(fresh);
  if (g1.approve + g1.swap > g0.approve + g0.swap) return no("gas-higher");
  if (shown.fee && fresh.fee && (fresh.fee.side !== shown.fee.side || BigInt(fresh.fee.raw) > BigInt(shown.fee.raw))) return no("fee-higher");
  if (!shown.fee && fresh.fee) return no("fee-higher");
  return { sign: true, needsConfirm: false, why: null };
}

/**
 * THE LOSS BOUND (plan §3.11): (USD in − USD of the decoded minimum) / USD in must
 * be ≤ maxLossPct, priced from INDEPENDENT prices (HL mids; 1 for USDC/USDT; XAUt0
 * from a PAXG mid). An unknown price refuses — it is never read as "no loss".
 */
export function swapLossCheck({ review, priceInUsd, priceOutUsd, maxLossPct = SWAP_LIMITS.maxLossPct } = {}) {
  const pin = Number(priceInUsd);
  const pout = Number(priceOutUsd);
  if (!review || !(pin > 0) || !(pout > 0) || priceInUsd == null || priceOutUsd == null) return { ok: false, code: "no-price", lossPct: null, usdIn: null };
  const usdIn = Number(review.amount) * pin;
  const usdMin = Number(review.minOut) * pout;
  if (!(usdIn > 0) || !Number.isFinite(usdMin)) return { ok: false, code: "no-price", lossPct: null, usdIn: null };
  const lossPct = ((usdIn - usdMin) / usdIn) * 100;
  if (!Number.isFinite(lossPct)) return { ok: false, code: "no-price", lossPct: null, usdIn: null };
  const cap = swapLossCapPct(maxLossPct);
  return lossPct > cap ? { ok: false, code: "loss", lossPct, usdIn } : { ok: true, code: null, lossPct, usdIn };
}

/**
 * The loss cap an env value asks for, clamped to the hard 2 %. Env may LOWER it, never
 * raise it — and a value that is not a number (NaN, "2%", an unset env read) lowers
 * nothing: it is the hard cap, never "no bound" (ATK-02: Math.min(NaN, 2) is NaN, and
 * `loss > NaN` is false for every loss).
 */
export function swapLossCapPct(maxLossPct = SWAP_LIMITS.maxLossPct) {
  const n = typeof maxLossPct === "number" ? maxLossPct
    : typeof maxLossPct === "string" && /^[0-9]+(\.[0-9]+)?$/.test(maxLossPct.trim()) ? Number(maxLossPct) : NaN;
  if (!Number.isFinite(n)) return SWAP_LIMITS.maxLossPct;
  return Math.max(0, Math.min(n, SWAP_LIMITS.maxLossPct));
}

/** Two prices for the same thing agree within `pct` (XAUt0 vs PAXG ± 3 %, USDT vs 1 ± 1 %). */
export function pricesAgree(a, b, pct = SWAP_LIMITS.priceSanityPct) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0) || a == null || b == null) return false;
  return Math.abs(x - y) / y * 100 <= pct;
}

/* ── the gas leg (AD-8): a little of the user's own USDC into AVAX ──────── */

/** USDC base units for a gas leg of `topupUsd` (in the $0.20–0.50 band), or null. */
export function gasLegUsdcRaw(topupUsd) {
  const u = Number(topupUsd);
  if (!Number.isFinite(u) || u < TOPUP_USD.min - 1e-9 || u > TOPUP_USD.max + 1e-9) return null;
  return toRaw(u.toFixed(2), 6);
}

/** The gas leg's body: USDC → native AVAX, through the very same swap builder. */
export function buildGasLegQuoteBody({ own, topupUsd }) {
  const raw = gasLegUsdcRaw(topupUsd);
  if (raw == null) throw new SwapQuoteError("bad-topup", `Gas for later is between $${TOPUP_USD.min.toFixed(2)} and $${TOPUP_USD.max.toFixed(2)}.`);
  return buildSwapQuoteBody({ own, from: "USDC", to: "AVAX", amountRaw: raw });
}

/**
 * Verify a gas-leg answer with parseSwapQuote and add the row the card MUST print
 * ("Gas for later ≈0.0310 AVAX ($0.30) · from your USDC"), sized from the DECODED
 * minimum (what is guaranteed), never the expected figure.
 */
export function parseGasLegQuote(json, { own, topupUsd, now = Date.now(), settlers = undefined } = {}) {
  const raw = gasLegUsdcRaw(topupUsd);
  if (raw == null) throw new SwapQuoteError("bad-topup", "The gas amount is not readable.");
  const usdc = swapTokenBySymbol("USDC");
  const avax = swapTokenBySymbol("AVAX");
  const review = parseSwapQuote(json, { own, from: usdc, to: avax, amountRaw: raw, slippageBps: SWAP_LIMITS.slippageBps, now, ...(settlers ? { settlers } : {}) });
  const gasRow = gasRowOf({ avaxWei: BigInt(review.minOutRaw), usd: Number(topupUsd), source: "usdc" });
  if (!gasRow) throw new SwapQuoteError("unsafe-quote", "The gas amount could not be read; nothing is signed.");
  return Object.freeze({ ...review, purpose: "gas-leg", gasRow });
}

/* ── the transactions, as the closed builder will receive them ──────────── */

const hex = (v) => `0x${BigInt(v).toString(16)}`;

/**
 * Is this swap an EXIT (plan §2.9: "swap X → USDC" is a way out — open whatever the
 * flags say, may spend the reserve, never refused for the fee level)? Everything else
 * — USDC → X, X → Y, the gas leg USDC → AVAX — is not, and obeys the 12 gwei rule.
 */
export function swapIsExit(review) {
  return !!review && !!review.to && review.to.symbol === "USDC" && !!review.from && review.from.symbol !== "USDC";
}

/**
 * The unsigned transactions of a verified swap, in order, with OUR gas limit
 * (the item's own, or the fallback when it has none) and OUR fee cap (plan §3.4:
 * maxFeePerGas = 2 × baseFee + 1 gwei, from lib/avax/gas.js). Null fee cap = null.
 * A swap that is not an exit above 12 gwei = null (ATK-07a); the tip is never
 * above the 1 gwei gas.js sets.
 */
export function swapTxRequests(review, { maxFeePerGasWei, maxPriorityFeePerGasWei = MAX_PRIORITY_FEE_WEI } = {}) {
  if (!review || !Array.isArray(review.txs)) return null;
  let cap;
  let want;
  try { cap = BigInt(maxFeePerGasWei); want = BigInt(maxPriorityFeePerGasWei); } catch { return null; }
  if (cap <= 0n || want < 0n) return null;
  if (!swapIsExit(review) && cap > RESERVE_FEE_WEI) return null;
  const tipCap = want > MAX_PRIORITY_FEE_WEI ? MAX_PRIORITY_FEE_WEI : want;
  const tip = tipCap > cap ? cap : tipCap;
  const g = swapGasUnits(review);
  return review.txs.map((t) => Object.freeze({
    purpose: t.purpose,
    chainId: AVAX_CHAIN_ID,
    from: t.from,
    to: t.to,
    data: t.data,
    value: t.value,
    gas: hex(t.purpose === "approve" ? g.approve : g.swap),
    maxFeePerGas: hex(cap),
    maxPriorityFeePerGas: hex(tip),
  }));
}

/** Up-front AVAX (wei) the swap's transactions need at `maxFeePerGasWei`: Σ gas × maxFee (plan §3.4). */
export function swapUpfrontWei(review, maxFeePerGasWei) {
  const g = swapGasUnits(review);
  let cap;
  try { cap = BigInt(maxFeePerGasWei); } catch { return null; }
  if (!g || cap <= 0n) return null;
  return BigInt(g.approve + g.swap) * cap;
}

const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);

/**
 * REMOVE ALLOWANCE (plan §3.6 "Allowed but not swapped", and the v3 allowances
 * left behind after 2026-10-26): approve(spender, 0) on a whitelisted token, to
 * one of the known spenders only. Unsigned; a visible window always.
 */
export function buildRemoveAllowanceTx({ token, spender }) {
  const t = tokenOf(token) || swapTokenByAddress(token, { allowOff: true });
  if (!t || t.native) throw new SwapQuoteError("not-whitelisted", "Only the assets listed in your Avax Wallet have allowances here.");
  const s = lower(spender);
  if (!RELAY_APPROVAL_PROXIES.includes(s) && s !== AVAX_DEPOSITORY) throw new SwapQuoteError("bad-spender", "That is not an allowance this app gave.");
  return Object.freeze({ purpose: "remove-allowance", chainId: AVAX_CHAIN_ID, to: t.address, value: "0x0", data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [s, 0n] }) });
}

/* ── the run ──────────────────────────────────────────────────────────────── */

export const SWAP_WORDS = Object.freeze({
  cancelled: "Cancelled. Nothing moved.",
  expired: "Price expired. Get a new price.",
  wallet: "Your wallet changed. Nothing moved.",
  registry: "This browser couldn't record the swap, so nothing was sent.",
  priceMoved: "Price moved. Nothing was swapped.",
  allowedNotSwapped: "Allowed but not swapped.",
  allowFailed: "The allowance didn't go through. Nothing was swapped.",
  unknown: "Not confirmed yet. Don't send it again.",
  newCard: "The price changed from the one you confirmed. Check the new one. Nothing was swapped.",
  feeHigh: "Avalanche fees are high right now. Nothing was swapped.",
  busy: "Another move is still running. Nothing was swapped.",
});

/* ── what the user confirmed (ATK-04b, AD-9 rule 3 at the executor) ──────── */

/**
 * The figures a swap card records when the user confirms it (registry `amounts`):
 * flat scalars, no address. The executor signs only a review inside them.
 */
export function swapEnvelope(review) {
  if (!review || !review.from || !review.to) return null;
  const g = swapGasUnits(review);
  return Object.freeze({
    from: review.from.symbol,
    to: review.to.symbol,
    amountRaw: String(review.amountRaw),
    minOutRaw: String(review.minOutRaw),
    gasUnits: g ? g.approve + g.swap : null,
    approve: !!review.needsApprove,
    feeSide: review.fee ? review.fee.side : null,
    feeRaw: review.fee ? String(review.fee.raw) : null,
  });
}

const rawOrNull = (v) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
};

/**
 * Why `review` is NOT the swap the user confirmed (null when it is, or better). The
 * same reasons as compareRequote. Reads the registry `amounts` as swapEnvelope() wrote
 * them, and the plain card figures `in` / `min` (decimals) too; a field the card did
 * not record is not compared, a field it recorded that cannot be read refuses.
 */
export function swapOutsideConfirmed(amounts, review) {
  if (!amounts || typeof amounts !== "object") return null;
  if (!review || !review.from || !review.to) return "not-decodable";
  const has = (k) => Object.prototype.hasOwnProperty.call(amounts, k) && amounts[k] !== undefined;
  if (has("from") && amounts.from !== review.from.symbol) return "different-swap";
  if (has("to") && amounts.to !== review.to.symbol) return "different-swap";
  const amt = BigInt(review.amountRaw);
  const min = BigInt(review.minOutRaw);
  if (has("amountRaw")) { const a = rawOrNull(amounts.amountRaw); if (a == null) return "not-decodable"; if (a !== amt) return "different-swap"; }
  if (has("in")) { const a = toRaw(String(amounts.in), review.from.decimals); if (a == null) return "not-decodable"; if (a !== amt) return "different-swap"; }
  if (has("minOutRaw")) { const m = rawOrNull(amounts.minOutRaw); if (m == null) return "not-decodable"; if (min < m) return "min-lower"; }
  if (has("min")) { const m = toRaw(String(amounts.min), review.to.decimals); if (m == null) return "not-decodable"; if (min < m) return "min-lower"; }
  if (has("approve") && amounts.approve === false && review.needsApprove) return "extra-window";
  if (has("gasUnits") && amounts.gasUnits != null) {
    const g = swapGasUnits(review);
    if (typeof amounts.gasUnits !== "number" || !Number.isFinite(amounts.gasUnits)) return "not-decodable";
    if (!g || g.approve + g.swap > amounts.gasUnits) return "gas-higher";
  }
  if (has("feeSide") || has("feeRaw")) {
    if (amounts.feeSide == null) {
      if (review.fee) return "fee-higher";
    } else if (review.fee) {
      const f = rawOrNull(amounts.feeRaw);
      if (f == null) return "not-decodable";
      if (review.fee.side !== amounts.feeSide || BigInt(review.fee.raw) > f) return "fee-higher";
    }
  }
  return null;
}

const REJECTED = /reject|denied|cancel|closed|user refused/i;
const isRejection = (e) => !!e && (e.code === 4001 || e.code === "ACTION_REJECTED" || REJECTED.test(String(e.message || e)));

/**
 * Run a verified swap. Never throws. Returns { ok: true, state: "arriving", swapTx }
 * when the swap's receipt is a success (the caller then reads the balance delta and
 * finishes the flow with it), or { ok: false, code, message, state, allowanceLeft?, unknown?, txHash?,
 * needsConfirm?, why?, untouched? }.
 *
 * 🔴 Before any window: the flow's stage is CLAIMED (once, ever — a second run touches
 * nothing), the review is compared with what the user CONFIRMED (registry amounts — a
 * worse re-quote comes back as a card, AD-9 rule 3), a swap that is not an exit is
 * refused above 12 gwei, and the cross-tab lock is taken.
 *
 * @param {{ review: object, ownNow: () => string|null, maxFeePerGasWei: bigint|string,
 *   sendTx: (tx: object, o: { words: string|null }) => Promise<string>,      // the visible sender; resolves the hash
 *   waitReceipt: (hash: string) => Promise<{ status: number }|null>,        // null = no receipt in time
 *   preflight: (tx: object) => Promise<{ ok: boolean }>,                   // eth_call from own
 *   readPendingNonce?: () => Promise<number|bigint|null>,
 *   readTxNonce?: (hash: string) => Promise<bigint|null>,        // with readLatestNonce: binds the swap's hash to its window (below)
 *   readLatestNonce?: () => Promise<bigint|null>,
 *   flow: object,   // registry.handle(id) — claim / get / acquire / beforeWindow / update / unknown / cancel
 *   words?: { approve?: string|null, swap?: string|null }, now?: () => number }} o
 *
 * 🔴 ONE HASH, ONE WINDOW (given readTxNonce / readLatestNonce, as money.js always does): Privy's
 * in-window "Retry transaction" can send the swap a second time and hand back only the last
 * hash. The swap's hash must be the one tx at the nonce written before its window, with nothing
 * mined past it (txHelpers.nonceBinding) — otherwise the outcome is UNKNOWN, never "Price moved.
 * Nothing was swapped." and never "swapped once". No nonce before the window → no window.
 * 🔴 THE PRICE IS STILL LIVE AT THE SWAP WINDOW: the approve's window and receipt can take
 * minutes, so the quote's 60 s TTL is checked again right before the swap (plan §3.6).
 */
export async function executeSwap({
  review, ownNow, maxFeePerGasWei, sendTx, waitReceipt, preflight, readPendingNonce = null, readTxNonce = null, readLatestNonce = null,
  flow, words = null, now = browserNow,
} = {}) {
  /* 0. THE CLAIM — synchronous, before the first await. */
  const stage = review && review.purpose === "gas-leg" ? "gas-leg" : "swap";
  const run = claimRun(flow, stage);
  if (!run.ok && run.untouched) return { ok: false, code: run.code, message: run.message, state: null, untouched: true };

  let release = () => {};
  const end = (state, code, message, extra = {}) => {
    try { release(); } catch { /* released */ }
    try {
      if (state === "unknown" && flow && typeof flow.unknown === "function") flow.unknown(code);
      else if (state !== "unknown" && flow && typeof flow.cancel === "function") flow.cancel(code, state);
    } catch { /* the outcome stands */ }
    return { ok: false, code, message, state, ...extra };
  };
  if (!run.ok) return end("error-before-money", "registry", SWAP_WORDS.registry);
  if (!review || !Array.isArray(review.txs)) return end("error-before-money", "bad-quote", "No price to swap with. Nothing moved.");
  if (typeof sendTx !== "function" || typeof waitReceipt !== "function" || typeof preflight !== "function") {
    return end("error-before-money", "no-sender", "This wallet can't swap here. Nothing moved.");
  }
  const ownIs = () => {
    let o = null;
    try { o = typeof ownNow === "function" ? ownNow() : null; } catch { o = null; }
    return isAddr(o) && lower(o) === review.own;
  };
  if (!ownIs()) return end("error-before-money", "wallet", SWAP_WORDS.wallet);
  if (!swapFresh(review, now())) return end("cancelled", "requote", SWAP_WORDS.expired, { needsRequote: true });

  /* 1. Bound to the card the user confirmed: a worse price is a NEW card, never a window. */
  let outside;
  try { outside = swapOutsideConfirmed(run.record.amounts, review); } catch { outside = "not-decodable"; }
  if (outside) return end("cancelled", "requote-worse", SWAP_WORDS.newCard, { needsConfirm: true, why: outside });

  /* 2. The 12 gwei rule (plan §2.9 / §3.4) — exits (X → USDC) excepted. */
  let cap = null;
  try { cap = BigInt(maxFeePerGasWei); } catch { cap = null; }
  if (cap == null || cap <= 0n) return end("error-before-money", "no-gas-price", "The network fee isn't known right now. Nothing moved.");
  if (!swapIsExit(review) && cap > RESERVE_FEE_WEI) return end("cancelled", "fee-high", SWAP_WORDS.feeHigh);
  const txs = swapTxRequests(review, { maxFeePerGasWei: cap });
  if (!txs) return end("error-before-money", "no-gas-price", "The network fee isn't known right now. Nothing moved.");

  /* 3. The cross-tab lock and a fresh look at the registry, before the first window. */
  let lock = null;
  try { lock = await flow.acquire(); } catch { lock = null; }
  if (!lock || lock.ok !== true) {
    const code = lock && lock.code === "storage" ? "registry" : (lock && lock.code) || "busy";
    return end(code === "registry" ? "error-before-money" : "cancelled", code, code === "registry" ? SWAP_WORDS.registry : SWAP_WORDS.busy);
  }
  release = typeof lock.release === "function" ? lock.release : () => {};
  try {
    const bind = typeof readTxNonce === "function" || typeof readLatestNonce === "function" ? { readTxNonce, readLatestNonce } : null;
    const fresh = () => swapFresh(review, now());
    return await swapWindows({ review, txs, ownIs, fresh, sendTx, waitReceipt, preflight, readPendingNonce, bind, flow, words, end });
  } finally {
    try { release(); } catch { /* released */ }
  }
}

/* The read layer's pending nonce (rpc.js answers a BigInt): a safe integer, or null. */
async function pendingNonce(readPendingNonce) {
  if (typeof readPendingNonce !== "function") return null;
  let n;
  try { n = await readPendingNonce(); } catch { return null; }
  if (typeof n === "bigint") return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/* The swap's hash bound to its window's nonce (txHelpers.nonceBinding); a read that fails is null. */
async function bindingOf(bind, hash, txNonce) {
  const safe = async (fn) => { try { return typeof fn === "function" ? await fn() : null; } catch { return null; } };
  const hashNonce = await safe(() => bind.readTxNonce && bind.readTxNonce(hash));
  const latestNonce = await safe(() => bind.readLatestNonce && bind.readLatestNonce());
  return nonceBinding({ txNonce, hashNonce, latestNonce });
}

async function swapWindows({ review, txs, ownIs, fresh, sendTx, waitReceipt, preflight, readPendingNonce, bind, flow, words, end }) {
  /* One window: registry first, then the sender. A throw with no hash that is not
     the user saying no is UNKNOWN — the transaction may be out (plan §3.6). */
  const send = async (tx, label) => {
    const txNonce = await pendingNonce(readPendingNonce);
    /* The swap's hash is bound to this nonce afterwards: without it, no window. */
    if (bind && label === "swap" && txNonce == null) return { kind: "no-nonce" };
    try {
      await flow.beforeWindow({ state: "sending", step: label, txNonce });
    } catch {
      return { kind: "registry" };
    }
    let hash;
    try {
      hash = await sendTx(tx, { words: (words && words[label]) || null });
    } catch (e) {
      return isRejection(e) ? { kind: "rejected" } : { kind: "unknown", txNonce };
    }
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { kind: "unknown", txNonce };
    try { if (typeof flow.update === "function") flow.update({ [`${label}Tx`]: hash, txHash: hash, txNonce }); } catch { /* the hash is also returned */ }
    let rc = null;
    try { rc = await waitReceipt(hash); } catch { rc = null; }
    if (!rc) return { kind: "pending", hash };
    if (bind && label === "swap" && (await bindingOf(bind, hash, txNonce)) !== "ok") return { kind: "unbound", hash };
    return Number(rc.status) === 1 ? { kind: "ok", hash } : { kind: "reverted", hash };
  };

  let approved = false;
  const approveTx = txs.find((t) => t.purpose === "approve");
  const swapTx = txs.find((t) => t.purpose === "swap");
  if (approveTx) {
    const a = await send(approveTx, "approve");
    if (a.kind === "registry") return end("error-before-money", "registry", SWAP_WORDS.registry);
    if (a.kind === "rejected") return end("cancelled", "cancelled", SWAP_WORDS.cancelled);
    if (a.kind === "unknown" || a.kind === "pending") return end("unknown", "approve_unconfirmed", SWAP_WORDS.unknown, { unknown: true, txHash: a.hash || null });
    if (a.kind === "reverted") return end("error-before-money", "approve_reverted", SWAP_WORDS.allowFailed, { txHash: a.hash });
    approved = true;
  }

  /* The approve's window and receipt may have outlived the price: never a swap on an old one. */
  if (!fresh()) {
    return end(approved ? "error-before-money" : "cancelled", "price_expired", approved ? `${SWAP_WORDS.expired} ${SWAP_WORDS.allowedNotSwapped}` : SWAP_WORDS.expired, { allowanceLeft: approved, needsRequote: true });
  }

  /* The swap is simulated from the user's own address before its window: a revert
     here costs nothing (plan §3.11 Run). */
  let pf = null;
  try { pf = await preflight(swapTx); } catch { pf = null; }
  if (!pf || pf.ok !== true) {
    return end("error-before-money", "preflight_reverted", approved ? `${SWAP_WORDS.priceMoved} ${SWAP_WORDS.allowedNotSwapped}` : SWAP_WORDS.priceMoved, { allowanceLeft: approved });
  }
  if (!ownIs()) return end("error-before-money", "wallet", SWAP_WORDS.wallet, { allowanceLeft: approved });

  const s = await send(swapTx, "swap");
  if (s.kind === "no-nonce") return end("error-before-money", "no_nonce", approved ? `Couldn't check this with Avalanche. ${SWAP_WORDS.allowedNotSwapped}` : "Couldn't check this with Avalanche. Nothing moved.", { allowanceLeft: approved });
  if (s.kind === "registry") return end("error-before-money", "registry", SWAP_WORDS.registry, { allowanceLeft: approved });
  /* Another tx went out from the swap's window (Privy's Retry): it may have swapped — never "nothing", never "once". */
  if (s.kind === "unbound") return end("unknown", "swap_unbound", SWAP_WORDS.unknown, { unknown: true, txHash: s.hash });
  if (s.kind === "rejected") return end(approved ? "error-before-money" : "cancelled", "cancelled", approved ? SWAP_WORDS.allowedNotSwapped : SWAP_WORDS.cancelled, { allowanceLeft: approved });
  if (s.kind === "unknown" || s.kind === "pending") return end("unknown", "swap_unconfirmed", SWAP_WORDS.unknown, { unknown: true, txHash: s.hash || null });
  if (s.kind === "reverted") return end("error-before-money", "swap_reverted", SWAP_WORDS.priceMoved, { txHash: s.hash, allowanceLeft: approved });
  try { if (typeof flow.update === "function") flow.update({ state: "arriving" }); } catch { /* receipt is in hand */ }
  return { ok: true, state: "arriving", swapTx: s.hash };
}

export { SWAP_TOKENS };
