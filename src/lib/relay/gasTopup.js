// ─────────────────────────────────────────────────────────────────────────────
// TOP UP GAS: a little AVAX from the user's own Perp account into their own Avax
// Wallet, as its own step in a PLAN or its own card (chip R14).
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §3.1 ("Top up gas" row), §3.4: Relay 1337 USDC (Perps) → 43114 native
// AVAX, EXACT_OUTPUT ≈ $0.30, two windows (authorize + sendAsset), no AVAX needed.
// Used when AVAX is below even the same-chain gas leg's up-front cost, and as
// the R14 fixing step. Live shape: relay-raw/q15-gasbuy.json (0.005 AVAX for
// 0.135582 USDC — a flat ≈ $0.08 fee, so the card always prints the debit).
//
// 🔴 RULES: no recipient parameter; the AVAX amount is EXACT (what arrives) and
// sized from an independent AVAX price (HL mid), in the $0.20–0.50 band; the
// debit is capped by gasTopupMaxDebitUsdc; the AVAX stays in the user's own
// wallet and the card says so (gasRow, AD-8). The signing is ownMove.js's.

import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import { OwnMoveError, buildOwnMoveQuoteBody, parseOwnMoveQuote, postRelayQuote } from "./ownMove.js";
import { TOPUP_USD, gasRow as gasRowOf } from "../avax/gas.js";

/** The default size of a stand-alone top-up (plan §3.1: ≈ $0.30). */
export const GAS_TOPUP_USD = 0.3;
/** AVAX is rounded DOWN to this many wei (0.000001 AVAX), so a quote amount is readable on a card. */
const WEI_STEP = 10n ** 12n;

/**
 * Wei of AVAX worth `usd` at `avaxUsd` (an independent price, e.g. the HL mid),
 * rounded down to 0.000001 AVAX. Null when either input is unknown — never a
 * guessed size (unknown is null, never 0).
 */
export function gasTopupWei({ usd = GAS_TOPUP_USD, avaxUsd } = {}) {
  const u = Number(usd);
  const p = Number(avaxUsd);
  if (!Number.isFinite(u) || !Number.isFinite(p) || p <= 0) return null;
  if (u < TOPUP_USD.min - 1e-9 || u > TOPUP_USD.max + 1e-9) return null;
  const microAvax = Math.floor((u / p) * 1e6);
  if (!Number.isSafeInteger(microAvax) || microAvax <= 0) return null;
  return BigInt(microAvax) * WEI_STEP;
}

/**
 * The most a top-up of `usd` may take from the Perp account: the AVAX's value with
 * 5 % for the two prices disagreeing, plus the fee ceiling max(0.25, 2 %).
 * ($0.30 → 0.565.) The measured flat fee is ≈ $0.08 (q15).
 */
export function gasTopupMaxDebitUsdc(usd = GAS_TOPUP_USD) {
  const u = Number(usd);
  if (!Number.isFinite(u) || u <= 0) return null;
  return Math.ceil((u * 1.05 + Math.max(0.25, 0.02 * u)) * 1e6) / 1e6;
}

/** The body: 1337 USDC (Perps) → 43114 AVAX, EXACT_OUTPUT `avaxWei`. Every role is `own`. */
export function buildGasTopupQuoteBody({ own, avaxWei }) {
  if (typeof avaxWei !== "bigint" || avaxWei <= 0n) throw new OwnMoveError("bad-amount", "The gas amount is not readable.");
  return buildOwnMoveQuoteBody({ own, dest: "avax", amountRaw: avaxWei });
}

/**
 * Price a gas top-up and verify the answer. One POST /quote/v2; nothing is signed.
 * @returns {Promise<{ body, review, gasRow }>} gasRow: "≈0.0309 AVAX ($0.30) · stays in your Avax Wallet".
 */
export async function quoteGasTopup({
  own, usd = GAS_TOPUP_USD, avaxUsd, fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, signal = null,
} = {}) {
  const wei = gasTopupWei({ usd, avaxUsd });
  if (wei == null) throw new OwnMoveError("no-price", "The AVAX price isn't known right now, so gas can't be priced.");
  const body = buildGasTopupQuoteBody({ own, avaxWei: wei });
  const json = await postRelayQuote(body, { fetchImpl, timers, signal });
  const review = parseOwnMoveQuote(json, { own, dest: "avax", amountRaw: wei, maxDebitUsdc: gasTopupMaxDebitUsdc(usd), now: now() });
  const gasRow = gasRowOf({ avaxWei: wei, usd: Number(usd), source: "move" });
  return { body, review: Object.freeze({ ...review, gasRow }), gasRow };
}
