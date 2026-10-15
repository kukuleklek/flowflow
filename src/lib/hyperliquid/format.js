// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid figures for DISPLAY: prices, compact USD, percentages, funding.
// ─────────────────────────────────────────────────────────────────────────────
//
// Prices follow the venue's own tick rule for perps (tick-and-lot-size docs,
// seen 2026-09-22): at most 5 significant figures and at most 6 - szDecimals
// decimals, and an integer price is always allowed. So BTC (szDecimals 5) shows
// "$85,573", ETH (4) "$2,733.6", kPEPE (0) "$0.005116". The decimals are FIXED
// for a given magnitude, which keeps a live ticker from jittering in width.
//
// Display only. The raw feed does not obey the rule either — measured live,
// oraclePx and midPx are routinely off it (SOL oracle 116.6953, BNB mark
// 790.605), so an ORDER price must be rounded separately when trading exists.
//
// MONEY_RULES section 0: an unknown is the dash, never "$0". Compact USD and
// percentages reuse lib/format.js, so the Perp page words a figure the same way
// as every other page instead of forking the rules.

import { DASH, fmtCompact, fmtPct } from "../format.js";

export const HL_PRICE_SIG_FIGS = 5;
export const HL_PERP_MAX_DECIMALS = 6;

/** A finite number, or null. Null, undefined, "" and non-numeric strings are unknown. */
const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/* Round half-up on the DECIMAL value. Plain toFixed rounds the binary value, so
   1.005 (stored as 1.00499...) would come out 1.00. */
function roundTo(n, d) {
  if (d <= 0) return Math.sign(n) * Math.round(Math.abs(n));
  /* Shift through the exponent form, so a tiny value (1e-7, whose String is
     already exponential) shifts as cleanly as 116.725 does. */
  const [m, e] = Math.abs(n).toExponential().split("e");
  const r = Number(`${Math.round(Number(`${m}e${Number(e) + d}`))}e-${d}`);
  return n < 0 ? -r : r;
}

/* Base-10 exponent from the decimal representation, not Math.log10 (which is
   not exact at powers of ten). */
const exponentOf = (n) => Number(Math.abs(n).toExponential().split("e")[1]);

/**
 * How many decimals Hyperliquid would quote this price with.
 * @param {number|string} px
 * @param {number|null} szDecimals the market's size decimals; unknown -> the perp cap
 * @returns {number|null} null when the price is unknown
 */
export function hlPriceDecimals(px, szDecimals) {
  const n = num(px);
  if (n == null) return null;
  const sz = num(szDecimals);
  const cap = Math.max(0, HL_PERP_MAX_DECIMALS - (sz == null ? 0 : sz));
  if (n === 0) return 0;
  const sf = Math.max(0, HL_PRICE_SIG_FIGS - 1 - exponentOf(n));
  return Math.min(sf, cap);
}

/** The price rounded as it would be quoted (display rounding). Null when unknown. */
export function roundHlPrice(px, szDecimals) {
  const n = num(px);
  if (n == null) return null;
  return roundTo(n, hlPriceDecimals(n, szDecimals));
}

const trimZeros = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/**
 * "$85,573", "$2,733.6", "$0.005116". Unknown -> the dash.
 * @param {{ prefix?: string, signed?: boolean, trim?: boolean }} [opts]
 *   signed: a leading + or - (for deltas); trim: drop trailing zeros (default on
 *   for signed figures, off for prices, whose fixed width is the point)
 */
export function formatHlPrice(px, szDecimals, { prefix = "$", signed = false, trim = signed } = {}) {
  const n = num(px);
  if (n == null) return DASH;
  if (n === 0) return `${prefix}0`;
  const d = hlPriceDecimals(n, szDecimals);
  const r = roundTo(Math.abs(n), d);
  const sign = n < 0 ? "-" : signed ? "+" : "";
  if (r === 0) {
    /* A real, positive price must never print as a confident zero. */
    return `${n < 0 ? "-" : ""}<${prefix}${(10 ** -d).toFixed(d)}`;
  }
  let body = r.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (trim) body = trimZeros(body);
  return `${sign}${prefix}${body}`;
}

/** Compact USD for open interest and volume: "$200M". The app's one compact rule. */
export const formatHlUsdCompact = (n) => fmtCompact(n);

/** Signed percent, 2 decimals: "-3.19%". The app's one percent rule. */
export const formatHlPct = (n, dp = 2) => fmtPct(n, dp);

/**
 * Hyperliquid funding is an HOURLY rate as a fraction (0.0000125 = 0.00125%/h).
 * Shown as a signed percent with 4 decimals: "+0.0013%". Unknown -> the dash.
 */
export function formatHlFunding(rate) {
  const n = num(rate);
  if (n == null) return DASH;
  const pct = roundTo(n * 100, 4);
  return `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(4)}%`;
}

/** The hourly funding rate as an annualised percent (x 24 x 365), to 0.01. Null when unknown. */
export function hlFundingAprPct(rate) {
  const n = num(rate);
  if (n == null) return null;
  return roundTo(n * 24 * 365 * 100, 2);
}

/** A size at the market's szDecimals: "1.23", "4,800". Unknown -> the dash. */
export function formatHlSize(sz, szDecimals) {
  const n = num(sz);
  if (n == null) return DASH;
  const d = Math.max(0, Math.min(8, num(szDecimals) ?? 4));
  return roundTo(n, d).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
