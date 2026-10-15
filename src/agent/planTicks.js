// Hyperliquid's price tick and size lot, for the trade plan (tradePlan.js). PURE.
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 WHY A COPY. The exchange layer (lib/hyperliquid, exchange/orders.js) is reachable only from the lazy perp
// surfaces: the always-loaded Agent code must not import it (scripts/test-hl-exchange-orders.mjs G4: a main-chunk
// import would ship order code in the flag-off build). The plan needs the SAME rounding the order will use, so this is
// a line-for-line copy of orders.js roundHlOrderPx / roundHlSize and its default slippage, held equal by
// scripts/test-trade-plan.mjs, which checks every plan's prices and sizes against the real orders.js (onTick, and the
// size planOpenMarket sends). Change one, change both.
import { HL_PRICE_SIG_FIGS, HL_PERP_MAX_DECIMALS } from "../lib/hyperliquid/format.js";

/** The official Python SDK's DEFAULT_SLIPPAGE for market orders (orders.js HL_DEFAULT_SLIPPAGE). */
export const PLAN_SLIPPAGE = 0.05;

const TENS = { nearest: Math.round, down: Math.floor, up: Math.ceil };

const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/* Strip binary noise (0.1 + 0.2) before any decimal step. */
const clean = (n) => Number(n.toPrecision(15));

/* n x 10^d through the decimal exponent, so 0.29 x 100 is 29 and not 28.999... */
function shift(n, d) {
  const [m, e] = n.toExponential().split("e");
  return Number(`${m}e${Number(e) + d}`);
}

const exponentOf = (n) => Number(n.toExponential().split("e")[1]);

function fromScaled(k, d) {
  if (!Number.isSafeInteger(k) || k < 0) return null;
  if (d <= 0) return String(k);
  const s = String(k).padStart(d + 1, "0");
  const int = s.slice(0, -d);
  const frac = s.slice(-d).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

function roundDecimals(n, d, mode) {
  const f = TENS[mode];
  if (!f) return null;
  return fromScaled(f(shift(clean(n), d)), d);
}

const validSzDecimals = (d) => Number.isInteger(d) && d >= 0 && d <= 8;

/** A valid perp ORDER price as a wire string, or null (≤ 5 significant figures, ≤ 6 − szDecimals decimals). */
export function planOrderPx(px, szDecimals, mode = "nearest") {
  const n = num(px);
  if (n == null || n <= 0 || !validSzDecimals(szDecimals)) return null;
  const c = clean(n);
  const cap = Math.max(0, HL_PERP_MAX_DECIMALS - szDecimals);
  const d = c >= 1e5 ? 0 : Math.min(Math.max(0, HL_PRICE_SIG_FIGS - 1 - exponentOf(c)), cap);
  const s = roundDecimals(c, d, mode);
  return s == null || Number(s) <= 0 ? null : s;
}

/** A size rounded to the market's szDecimals, as a wire string ("0" when it rounds away); null when unreadable. */
export function planSize(sz, szDecimals, mode = "nearest") {
  const n = num(sz);
  if (n == null || n < 0 || !validSzDecimals(szDecimals)) return null;
  if (n === 0) return "0";
  return roundDecimals(n, szDecimals, mode);
}
