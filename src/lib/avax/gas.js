// ─────────────────────────────────────────────────────────────────────────────
// AVAX for gas in the Avax Wallet: the fee fields every tx carries, the exit
// reserve, the up-front check before a window opens, the top-up size, and the
// "Gas for later" row that must be PRINTED whenever the customer's own money
// buys AVAX.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner (USER-ADDENDUM AD-5, AD-8): Privy has no gas sponsorship on Avalanche,
// so the wallet holds a little AVAX of its own — carved from the customer's own
// move or swap, only when AVAX is short, and "PRINTED on the card before Confirm
// … never silent". Plan v2 §2.9 + §3.4; R-gas C17: the node (and Privy's
// hasFunds) want balance ≥ gasLimit × maxFeePerGas UP FRONT, so every size here
// is gasLimit × maxFeePerGas, never the gas a tx ends up using.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. EVERY TX STATES ITS OWN gasLimit, maxFeePerGas AND maxPriorityFeePerGas
//      (feeFields). maxFeePerGas = 2 × baseFee + 1 gwei.
//   2. THE EXIT RESERVE. A tx that is not an exit must leave ≥ exitReserveWei()
//      AFTER its own up-front cost, and is refused while maxFeePerGas > 12 gwei.
//      An exit (Aave withdraw, the paid move back, a swap back to USDC) may spend
//      the reserve: that is what it is for.
//        exit       (withdraw 260k + approve 80k + deposit 100k) × 25 gwei → 0.011 AVAX
//        swap-back  (approve 75k + swap 1M) × 12 gwei             → 0.013 AVAX each
//      (both rounded UP to 0.001 AVAX).
//      🔴 PLAN DEVIATION (report it): §2.9 sizes the exit reserve at 12 gwei (0.006).
//      Exits sign at 2 × base + 1 gwei with no cap, and the up-front check wants
//      gasLimit × maxFeePerGas, so 0.006 could NOT pay a withdraw once the base fee
//      passed ≈ 11 gwei, nor the paid exit past ≈ 6.3 gwei — a fee spike, which is
//      exactly when people leave (attack ATK-06). The exit part is therefore sized
//      at the exit's OWN fee rule for a base fee up to 12 gwei (2 × 12 + 1 = 25 gwei,
//      ≈ 2.4 × today's 5 gwei): 440k × 25 gwei = 0.011 AVAX. The swap-back part stays
//      at 12 gwei: sized at 25 it would be 0.027 per asset, and a first swap from an
//      empty wallet would then need more than the $0.50 top-up can buy.
//   3. TOP-UP ONLY WHEN AVAX < NEED, sized clamp(ceil$0.05(short × AVAXusd × 1.25),
//      $0.20, $0.50). More than $0.50 short → no top-up and no Confirm, with the
//      reason. An unknown AVAX price → no Confirm ("Still loading"), never a guess.
//   4. NO SILENT GAS. A quote body with topupGas, or a plan with a USDC → AVAX gas
//      leg, cannot be confirmed without a valid gasRow (gasRowProblem).
//   5. Unknown is null, never 0.

import { GWEI, WEI_PER_AVAX } from "./config.js";
import { formatRaw, rawToNumber } from "./units.js";

/** Gas limits used for sizing and sent on every tx (plan §2.9, measured ×1.2–1.6). */
export const GAS_LIMITS = Object.freeze({
  approve: 75000n,       // USDC approve: est. 56,240, real 35.5k–55.4k
  supply: 340000n,       // Aave V3 supply: first-time est. 285,265, repeat 196–198k
  withdraw: 260000n,     // Aave V3 withdraw: est. 212,336 (1 USDC) / 219,806 (max)
  exitApprove: 80000n,   // paid exit: USDC approve to the Avax depository
  exitDeposit: 100000n,  // paid exit: depository.deposit
  swapApprove: 75000n,   // swap: approve to the ApprovalProxy
  swapFallback: 1000000n, // swap when the quote gives no gas (0x 575k, Magpie 827k, XAUt0 941k)
});

/** Non-exit txs are refused above this maxFeePerGas; the swap-back reserve is sized at it. */
export const MAX_FEE_GWEI_NON_EXIT = 12n;
export const RESERVE_FEE_WEI = MAX_FEE_GWEI_NON_EXIT * GWEI;
/** The tip every tx offers (the node suggests ~150 wei; 1 gwei is a safe floor) — and the most any tx here may offer. */
export const PRIORITY_FEE_WEI = 1n * GWEI;
export const MAX_PRIORITY_FEE_WEI = PRIORITY_FEE_WEI;
/** The base fee up to which the exit reserve pays the WHOLE way out at the exit's own fee rule. */
export const EXIT_SIZING_BASE_WEI = 12n * GWEI;
/** That fee rule at that base: 2 × 12 + 1 = 25 gwei (maxFeeFor, below). */
export const EXIT_SIZING_FEE_WEI = 2n * EXIT_SIZING_BASE_WEI + PRIORITY_FEE_WEI;

const MILLI_AVAX = WEI_PER_AVAX / 1000n;
const ceilTo = (x, step) => ((x + step - 1n) / step) * step;
/** gasLimit × feeWei, rounded up to 0.001 AVAX. */
export const reserveForGasAt = (gas, feeWei) => ceilTo(gas * feeWei, MILLI_AVAX);
/** gasLimit × 12 gwei, rounded up to 0.001 AVAX. */
export const reserveForGas = (gas) => reserveForGasAt(gas, RESERVE_FEE_WEI);

export const EXIT_GAS = GAS_LIMITS.withdraw + GAS_LIMITS.exitApprove + GAS_LIMITS.exitDeposit; // 440,000
export const SWAP_BACK_GAS = GAS_LIMITS.swapApprove + GAS_LIMITS.swapFallback;                 // 1,075,000
export const EXIT_RESERVE_WEI = reserveForGasAt(EXIT_GAS, EXIT_SIZING_FEE_WEI); // 0.011 AVAX
export const SWAP_BACK_RESERVE_WEI = reserveForGas(SWAP_BACK_GAS);             // 0.013 AVAX

export const TOPUP_USD = Object.freeze({ min: 0.2, max: 0.5, step: 0.05, margin: 1.25 });

export class GasError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "GasError";
    this.code = code;
    this.detail = detail;
  }
}

export const GAS_WHY = Object.freeze({
  loading: "Still loading",
  feeHigh: "Avalanche fees are high right now. Try again in a few minutes.",
  topupTooBig: "This needs more gas than a $0.50 top-up gives",
});

/* ── fee fields ───────────────────────────────────────────────────────────── */

/** maxFeePerGas for a base fee: 2 × baseFee + 1 gwei. */
export function maxFeeFor(baseFeeWei) {
  if (typeof baseFeeWei !== "bigint" || baseFeeWei <= 0n) return null;
  return 2n * baseFeeWei + PRIORITY_FEE_WEI;
}

/**
 * The fee fields a tx carries, from the fee state (readFeeState) or a base fee.
 * Throws GasError "loading" when the base fee is unknown, and "fee-high" for a
 * non-exit tx above 12 gwei. Exits are never refused for the fee level (the
 * up-front balance check still applies).
 */
export function feeFields(feeStateOrBaseFee, { exit = false } = {}) {
  const base = typeof feeStateOrBaseFee === "bigint" ? feeStateOrBaseFee : feeStateOrBaseFee && feeStateOrBaseFee.baseFeeWei;
  const maxFeePerGas = maxFeeFor(base);
  if (maxFeePerGas == null) throw new GasError("loading", GAS_WHY.loading);
  if (!exit && maxFeePerGas > RESERVE_FEE_WEI) {
    throw new GasError("fee-high", GAS_WHY.feeHigh, { maxFeeGwei: Number(maxFeePerGas) / Number(GWEI) });
  }
  return Object.freeze({ maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE_WEI });
}

/* ── the reserve ──────────────────────────────────────────────────────────── */

/**
 * How many held assets need a swap back to USDC before they can leave. Counts
 * an asset when it needs one (every ERC-20 but USDC), its balance is > 0, and its
 * USD value is unknown or ≥ $1 (below the $1 swap minimum it can't be swapped
 * anyway). `planned` adds symbols a plan is about to buy.
 *
 * 🔴 An account that was not read (null, or no `assets` list) is UNKNOWN → null,
 * never 0: "holds nothing to swap back" would shrink the exit reserve (ATK-14).
 *
 * @param {{assets:{symbol:string,native:boolean,raw:bigint|null,decimals:number}[]}|null} account  readAvaxAccount()
 * @param {{prices?:Record<string,number|null>, planned?:string[], minUsd?:number}} [o]
 * @returns {number|null}
 */
export function swapBackCount(account, { prices = {}, planned = [], minUsd = 1 } = {}) {
  if (!account || typeof account !== "object" || !Array.isArray(account.assets)) return null;
  const held = new Set();
  for (const a of account.assets) {
    if (!a || typeof a !== "object") return null;
    if (a.native || a.symbol === "USDC") continue;
    if (typeof a.raw !== "bigint") { held.add(a.symbol); continue; } // unknown: count it (safe side)
    if (a.raw === 0n) continue;
    const p = prices && prices[a.symbol];
    const usd = typeof p === "number" && p > 0 ? rawToNumber(a.raw, a.decimals) * p : null;
    if (usd == null || usd >= minUsd) held.add(a.symbol);
  }
  for (const s of planned || []) if (s && s !== "USDC" && s !== "AVAX") held.add(s);
  return held.size;
}

/**
 * The AVAX to keep for the way out: 0.011 + 0.013 × assets that need a swap back.
 * null when the count is unknown (swapBackCount said null) or not a count — never
 * the bare 0.011, which would forget the assets nobody could read.
 */
export function exitReserveWei(swapBackAssets = 0) {
  if (!Number.isSafeInteger(swapBackAssets) || swapBackAssets < 0) return null;
  return EXIT_RESERVE_WEI + BigInt(swapBackAssets) * SWAP_BACK_RESERVE_WEI;
}

/* ── the up-front check ───────────────────────────────────────────────────── */

/** Σ gasLimit × maxFeePerGas. null when anything is unknown. */
export function upfrontWei(gasLimits, maxFeePerGas) {
  if (!Array.isArray(gasLimits) || typeof maxFeePerGas !== "bigint" || maxFeePerGas <= 0n) return null;
  let sum = 0n;
  for (const g of gasLimits) {
    if (typeof g !== "bigint" || g <= 0n) return null;
    sum += g * maxFeePerGas;
  }
  return sum;
}

/** The two kinds that are NOT a normal tx. Anything else — a typo included — is normal (ATK-07b). */
export const GAS_KINDS = Object.freeze(["exit", "gas-leg", "normal"]);

/**
 * May these Avalanche txs open their windows now?
 *
 * @param {object} p
 * @param {bigint|null} p.avaxWei         AVAX in the wallet now
 * @param {bigint[]} p.gasLimits          each tx's gasLimit
 * @param {bigint} p.maxFeePerGas         from feeFields()
 * @param {"exit"|"gas-leg"|"normal"} [p.kind]  exit: may spend the reserve, no fee cap ·
 *        gas-leg (USDC → AVAX for gas): the 12 gwei cap, but only the up-front cost (its
 *        result is more AVAX) · normal: the 12 gwei cap, up-front + the reserve after.
 *        🔴 FAILS CLOSED: any kind that is not exactly "exit" or "gas-leg" is "normal".
 * @param {bigint|null} [p.reserveAfterWei]  exitReserveWei() as it will be AFTER these txs
 *        (omitted: the bare exit reserve; null = unknown → "Still loading", never a yes)
 * @returns {{ok:boolean, upfrontWei:bigint|null, needWei:bigint|null, shortWei:bigint|null, why:string|null}}
 */
export function gasCheck({ avaxWei, gasLimits, maxFeePerGas, kind = "normal", reserveAfterWei = EXIT_RESERVE_WEI }) {
  const k = kind === "exit" || kind === "gas-leg" ? kind : "normal";
  const up = upfrontWei(gasLimits, maxFeePerGas);
  if (up == null || typeof avaxWei !== "bigint") {
    return { ok: false, upfrontWei: up, needWei: null, shortWei: null, why: GAS_WHY.loading };
  }
  if (k !== "exit" && maxFeePerGas > RESERVE_FEE_WEI) {
    return { ok: false, upfrontWei: up, needWei: null, shortWei: null, why: GAS_WHY.feeHigh };
  }
  if (k === "normal" && !(typeof reserveAfterWei === "bigint" && reserveAfterWei > 0n)) {
    return { ok: false, upfrontWei: up, needWei: null, shortWei: null, why: GAS_WHY.loading };
  }
  const keep = k === "normal" ? reserveAfterWei : 0n;
  const need = up + keep;
  if (avaxWei >= need) return { ok: true, upfrontWei: up, needWei: need, shortWei: 0n, why: null };
  const short = need - avaxWei;
  return { ok: false, upfrontWei: up, needWei: need, shortWei: short, why: `Needs ${avaxAmount(short)} more AVAX for gas` };
}

/* ── the top-up ───────────────────────────────────────────────────────────── */

/** Top up only when the wallet holds less AVAX than the plan needs. */
export const TOPUP_WHEN = (avaxWei, needWei) => typeof avaxWei === "bigint" && typeof needWei === "bigint" && avaxWei < needWei;

/**
 * How much of the customer's own move (or USDC) to turn into AVAX.
 *
 * @param {{avaxWei:bigint|null, needWei:bigint|null, avaxUsd:number|null}} p
 * @returns {{needed:false} | {needed:true, ok:false, why:string} |
 *           {needed:true, ok:true, usd:number, topupGasAmount:string, expectedAvaxWei:bigint}}
 *   topupGasAmount is USD with 6 decimals as a string ("300000" = $0.30), the
 *   unit Relay's topupGasAmount takes (R-gas C12).
 */
export function topupPlan({ avaxWei, needWei, avaxUsd }) {
  if (typeof avaxWei !== "bigint" || typeof needWei !== "bigint") return { needed: true, ok: false, why: GAS_WHY.loading };
  if (!TOPUP_WHEN(avaxWei, needWei)) return { needed: false };
  if (typeof avaxUsd !== "number" || !Number.isFinite(avaxUsd) || avaxUsd <= 0) return { needed: true, ok: false, why: GAS_WHY.loading };
  const shortAvax = Number(needWei - avaxWei) / Number(WEI_PER_AVAX);
  const raw = shortAvax * avaxUsd * TOPUP_USD.margin;
  const stepped = Math.ceil(raw / TOPUP_USD.step - 1e-9) * TOPUP_USD.step;
  if (stepped > TOPUP_USD.max + 1e-9) return { needed: true, ok: false, why: GAS_WHY.topupTooBig };
  const usd = Math.round(Math.max(TOPUP_USD.min, stepped) * 100) / 100;
  const micro = BigInt(Math.round(usd * 1e6));
  const expectedAvaxWei = BigInt(Math.floor((usd / avaxUsd) * 1e18));
  return { needed: true, ok: true, usd, topupGasAmount: micro.toString(), expectedAvaxWei };
}

/* ── the printed row ──────────────────────────────────────────────────────── */

/** An AVAX amount that never prints a non-zero as "0": "≈0.0313", "<0.0001", "—" (no unit). */
export function avaxAmount(wei, dp = 4) {
  if (typeof wei !== "bigint" || wei < 0n) return "—";
  const t = formatRaw(wei, 18, dp);
  return t.startsWith("<") ? t : `≈${t}`;
}

/** The same with its unit: "≈0.0313 AVAX", "<0.0001 AVAX", "—". */
export function avaxText(wei, dp = 4) {
  const t = avaxAmount(wei, dp);
  return t === "—" ? t : `${t} AVAX`;
}

const usdText = (usd) => (typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? `$${usd.toFixed(2)}` : "—");

export const GAS_ROW_LABEL = "Gas for later";
const SOURCE_NOTE = Object.freeze({
  move: "stays in your Avax Wallet",
  usdc: "from your USDC, stays in your Avax Wallet",
});

/**
 * The "Gas for later" row. `avaxWei` is what the quote says will arrive (the
 * move's gas top-up, or the gas leg's minimum out); `usd` what it costs the
 * customer. Returns null (→ no Confirm) unless both are known and > 0.
 */
export function gasRow({ avaxWei, usd, source = "move" }) {
  if (typeof avaxWei !== "bigint" || avaxWei <= 0n) return null;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
  const note = SOURCE_NOTE[source] || SOURCE_NOTE.move;
  return Object.freeze({
    label: GAS_ROW_LABEL,
    avaxWei,
    usd,
    source: SOURCE_NOTE[source] ? source : "move",
    value: `${avaxText(avaxWei, 4)} (${usdText(usd)})`,
    note,
    text: `${GAS_ROW_LABEL} ${avaxText(avaxWei, 4)} (${usdText(usd)}) · ${note}`,
  });
}

const validRow = (r) => !!r && r.label === GAS_ROW_LABEL && typeof r.avaxWei === "bigint" && r.avaxWei > 0n
  && typeof r.usd === "number" && r.usd > 0 && typeof r.text === "string" && r.text.includes("AVAX");

/**
 * Why a card carrying gas may NOT show Confirm (null = it may).
 *   • a quote body with topupGas needs a valid gasRow whose $ matches topupGasAmount
 *   • a plan with a gas leg (`gasLeg: true`) needs a valid gasRow from "usdc"
 *   • a gasRow with nothing that buys gas is also wrong (a row must be true)
 */
export function gasRowProblem({ body = null, gasLeg = false, gasRow: row = null } = {}) {
  const topup = !!(body && body.topupGas);
  if (topup) {
    if (!validRow(row)) return "Gas for later is missing from the card";
    const micro = Number(body.topupGasAmount);
    if (!Number.isFinite(micro) || Math.abs(micro / 1e6 - row.usd) > 0.005) return "Gas for later does not match the move";
    if (row.source !== "move") return "Gas for later names the wrong source";
    return null;
  }
  if (gasLeg) {
    if (!validRow(row)) return "Gas for later is missing from the card";
    if (row.source !== "usdc") return "Gas for later names the wrong source";
    return null;
  }
  if (row) return "Gas for later is shown but nothing buys gas";
  return null;
}

/**
 * The receipt line: the AVAX that really arrived, from two balance reads.
 * null when either read is unknown or the balance went down.
 */
export function gasArrivedWei(beforeWei, afterWei) {
  if (typeof beforeWei !== "bigint" || typeof afterWei !== "bigint" || afterWei < beforeWei) return null;
  return afterWei - beforeWei;
}

/** Is the wallet below its exit reserve while money sits on Avalanche? (chip R14) */
export function gasLow({ avaxWei, reserveWei, hasMoneyOnAvalanche }) {
  if (!hasMoneyOnAvalanche) return false;
  if (typeof avaxWei !== "bigint" || typeof reserveWei !== "bigint") return false; // unknown: no chip, no claim
  return avaxWei < reserveWei;
}
