// ─────────────────────────────────────────────────────────────────────────────
// The perp fee: Hyperliquid's taker fee plus FlowFlow's builder fee. Pure.
// ─────────────────────────────────────────────────────────────────────────────
//
// FOMO shows one all-in figure ("0.09% fee" in the close sheet): Hyperliquid's
// base taker fee plus the frontend's builder fee. The same split here:
//
//   HL taker, main dex, volume tier 0 (the fee schedule a new account is on):
//       0.045% of the filled notional.
//   Builder fee: set per order as builder.f, in TENTHS OF A BASIS POINT
//       (Hyperliquid's own unit: f = 10 is 1 bp = 0.01%), at most 0.1% on
//       perps, so f is an integer from 0 to 100. It applies to BOTH sides of
//       a perp trade, so an open and a close each pay it.
//
// The value comes from VITE_PERP_BUILDER_FEE, read in exactly one place
// (config.js). The owner may not have set it yet ("Builder Fee อาจจะยังไม่ตั้ง"),
// so an EMPTY setting is 0 — a known zero, the fee is simply not charged yet.
// A setting that cannot be read is NOT 0: it is unknown (null), and the mock
// refuses fee-bearing trades rather than print a fee it cannot stand behind
// (MONEY_RULES section 0).

/** Hyperliquid perp taker fee, main dex, volume tier 0: 0.045%. */
export const HL_TAKER_FEE_RATE = 0.00045;

/** Hyperliquid caps a perp builder fee at 0.1% = 100 tenths of a basis point. */
export const HL_BUILDER_FEE_MAX_TENTHS_BP = 100;

/** One tenth of a basis point as a fraction of notional. */
const TENTH_BP = 1 / 100_000;

/**
 * The builder fee setting, in tenths of a basis point.
 * Unset or blank -> 0. A whole number 0..100 -> that number. Anything else -> null.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseBuilderFeeTenthsBp(raw) {
  if (raw == null) return 0;
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw <= HL_BUILDER_FEE_MAX_TENTHS_BP ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return 0;
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n <= HL_BUILDER_FEE_MAX_TENTHS_BP ? n : null;
}

/** The builder fee as a fraction of notional, or null when the setting is unknown. */
export function builderFeeRate(tenthsBp) {
  return Number.isInteger(tenthsBp) && tenthsBp >= 0 ? tenthsBp * TENTH_BP : null;
}

/** The all-in taker rate (HL taker + builder), or null when the builder fee is unknown. */
export function perpTakerFeeRate(tenthsBp) {
  const b = builderFeeRate(tenthsBp);
  return b == null ? null : HL_TAKER_FEE_RATE + b;
}

/** The fee in USD on a filled notional, or null when either input is unknown. */
export function perpFeeUsd(notionalUsd, rate) {
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return ok(notionalUsd) && ok(rate) ? notionalUsd * rate : null;
}
