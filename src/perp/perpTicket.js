// ─────────────────────────────────────────────────────────────────────────────
// The perp ticket's arithmetic — a PREVIEW, not an order.
// ─────────────────────────────────────────────────────────────────────────────
//
// Slice 1 has no signing, no orders, no deposits: nothing in this file (or in
// PerpTicket.jsx) touches the network or a wallet. It turns what the reader typed
// into the figures a FOMO-style ticket shows before the (disabled) button:
// position size, coin quantity, an ESTIMATED liquidation price, and the estimated
// result at a take-profit or a stop-loss.
//
// Pure and dependency-free, so the node suite runs the exact numbers the sheet
// prints. Unknown in, null out (MONEY_RULES section 0) — never a zero guess.

/** Hyperliquid rejects an order whose VALUE (size x price) is under $10
 *  ("Order must have minimum value of $10", error-responses docs, 2026-09-22). */
export const HL_MIN_ORDER_USD = 10;

/** Amount chips, in USD of margin. The smallest is the venue minimum itself, so
 *  no chip can produce an order Hyperliquid would refuse at any leverage. */
export const PERP_AMOUNT_PRESETS = Object.freeze([10, 25, 50, 100]);

/** What the final button says in slice 1. It is disabled, and says why. */
export const PERP_TICKET_CTA = "Trading opens soon";

/** Where a slider's quick-pick marks may sit (the market's maximum is always one). */
const DETENTS = [1, 2, 3, 5, 10, 20, 25, 40, 50];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The leverage marks for a market: every standard mark up to its maximum, plus the maximum. */
export function leverageDetents(maxLeverage) {
  const max = num(maxLeverage);
  if (max == null || max < 1) return [1];
  const top = Math.floor(max);
  const out = DETENTS.filter((d) => d <= top);
  if (out[out.length - 1] !== top) out.push(top);
  return out;
}

/** Hyperliquid leverage is an integer between 1 and the market's maximum. */
export function clampLeverage(v, maxLeverage) {
  const max = num(maxLeverage);
  const top = max != null && max >= 1 ? Math.floor(max) : 1;
  const n = num(typeof v === "string" ? Number(v) : v);
  if (n == null) return 1;
  return Math.min(top, Math.max(1, Math.round(n)));
}

/** Where the slider starts before the reader picks: 5x, or the market's maximum if lower. */
export function defaultLeverage(maxLeverage) {
  const max = num(maxLeverage);
  return clampLeverage(max == null ? 1 : Math.min(5, max), maxLeverage);
}

/** Keep a typed amount to digits and one point, two decimals at most. */
export function sanitizeAmountInput(raw) {
  let s = String(raw == null ? "" : raw).replace(/,/g, "").replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "").slice(0, 2);
  return s;
}

/** A typed USD amount, or null when it is not a positive number. */
export function parseUsdAmount(raw) {
  const s = sanitizeAmountInput(raw);
  if (!s || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A typed price (TP / SL), or null. */
export function parsePriceInput(raw) {
  const s = String(raw == null ? "" : raw).replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const sideSign = (side) => (side === "buy" ? 1 : side === "sell" ? -1 : null);

/**
 * ESTIMATED liquidation price of a NEW ISOLATED position.
 *
 * Hyperliquid's formula (docs, Trading > Liquidations):
 *     liq = price - side * margin_available / position_size / (1 - l * side)
 *   side = 1 long, -1 short; l = 1 / MAINTENANCE_LEVERAGE;
 *   isolated: margin_available = isolated_margin - maintenance_margin_required.
 * Maintenance margin is half the initial margin at MAX leverage, so the
 * maintenance rate is mmr = 1 / (2 * maxLeverage) and l = mmr.
 *
 * For a position just opened at the entry price (entryPx) with margin M at leverage L:
 *     notional = M * L, size = notional / entryPx, M / size = entryPx / L
 *     margin_available / size = entryPx * (1/L - mmr)
 * which reduces to
 *     long:  liq = entryPx * (1 - 1/L) / (1 - mmr)
 *     short: liq = entryPx * (1 + 1/L) / (1 + mmr)
 *
 * WHAT THIS IGNORES, which is why every caller labels it an estimate: the
 * opening fee (it comes out of the isolated margin), slippage on the market
 * fill and funding paid while open. It is the FIRST margin tier's formula only:
 * past a tier's lowerBound (meta.marginTables) Hyperliquid lowers the maximum
 * leverage and raises the maintenance rate, so perpTicketPreview shows no
 * estimate for such a size (pastTier) rather than this one. A 1x long returns
 * 0: it is only liquidated at a price of zero.
 *
 * CROSS MARGIN cannot be estimated here: its liquidation depends on the whole
 * account's value, which slice 1 does not read. Callers show the dash for it.
 *
 * @returns {number|null}
 */
export function estIsolatedLiqPx({ side, entryPx, leverage, maxLeverage } = {}) {
  const s = sideSign(side);
  const px = num(entryPx);
  const lev = num(leverage);
  const max = num(maxLeverage);
  if (s == null || px == null || px <= 0 || lev == null || lev < 1 || max == null || max < 1) return null;
  const mmr = 1 / (2 * max);
  const liq = s === 1 ? (px * (1 - 1 / lev)) / (1 - mmr) : (px * (1 + 1 / lev)) / (1 + mmr);
  if (!Number.isFinite(liq)) return null;
  return Math.max(0, liq);
}

/**
 * The margin tier a position of this USD notional sits in: the tier with the
 * greatest lowerBound at or under it. Null when the table or the notional is
 * unknown. Tiers are the market row's marginTiers (lib/hyperliquid/markets.js).
 */
export function marginTierFor(tiers, notional) {
  const n = num(notional);
  if (!Array.isArray(tiers) || !tiers.length || n == null || n < 0) return null;
  let hit = null;
  for (const t of tiers) {
    if (!t || num(t.lowerBound) == null || num(t.maxLeverage) == null) return null;
    if (t.lowerBound <= n && (!hit || t.lowerBound >= hit.lowerBound)) hit = t;
  }
  return hit;
}

/**
 * Everything the ticket previews, from what was typed and the market row.
 * Every figure is null when any of its inputs is unknown.
 *
 * pastTier is { lowerBound, maxLeverage } when the position's notional reaches
 * past the market's first margin tier, and the liquidation estimate is null
 * then: the one-tier formula would print a price Hyperliquid would not use. An
 * unknown table is not assumed to be one tier, so it gives no estimate either.
 * @param {{ side: "buy"|"sell", amountUsd: number|null, leverage: number,
 *   market: object|null, tp?: number|null, sl?: number|null }} o
 */
export function perpTicketPreview({ side, amountUsd, leverage, market, tp = null, sl = null } = {}) {
  const s = sideSign(side);
  const entryPx = market ? num(market.px) : null;
  const maxLev = market ? num(market.maxLeverage) : null;
  const lev = clampLeverage(leverage, maxLev);
  const margin = num(amountUsd) != null && amountUsd > 0 ? amountUsd : null;
  const notional = margin != null ? margin * lev : null;
  const qty = notional != null && entryPx != null && entryPx > 0 ? notional / entryPx : null;
  const tiers = market && Array.isArray(market.marginTiers) && market.marginTiers.length ? market.marginTiers : null;
  const tier = notional != null ? marginTierFor(tiers, notional) : null;
  const pastTier = tier && tier !== tiers[0] ? { lowerBound: tier.lowerBound, maxLeverage: tier.maxLeverage } : null;
  const liqPx = margin != null && tier && !pastTier
    ? estIsolatedLiqPx({ side, entryPx, leverage: lev, maxLeverage: maxLev })
    : null;
  const belowMin = notional != null && notional < HL_MIN_ORDER_USD;
  /* Result at a trigger: size x the move, signed by side. Before fees. */
  const at = (px) => (px != null && qty != null && s != null && entryPx != null ? s * qty * (px - entryPx) : null);
  const tpPx = num(tp);
  const slPx = num(sl);
  /* A take-profit must be on the winning side of the entry, a stop-loss on the
     losing side; a stop beyond the estimated liquidation would never fire. */
  const tpWrongSide = tpPx != null && entryPx != null && s != null ? s * (tpPx - entryPx) <= 0 : false;
  const slWrongSide = slPx != null && entryPx != null && s != null ? s * (slPx - entryPx) >= 0 : false;
  const slPastLiq = slPx != null && liqPx != null && s != null && !slWrongSide ? s * (slPx - liqPx) <= 0 : false;
  return {
    entryPx, leverage: lev, margin, notional, qty, liqPx, belowMin, pastTier,
    tpPx, slPx, tpPnl: tpWrongSide ? null : at(tpPx), slPnl: slWrongSide ? null : at(slPx),
    tpWrongSide, slWrongSide, slPastLiq,
  };
}
