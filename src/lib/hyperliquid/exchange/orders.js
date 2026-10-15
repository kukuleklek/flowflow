// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid orders: the wire form, the plans, and what a reply means. PURE.
// ─────────────────────────────────────────────────────────────────────────────
//
// No network, no clock, no storage: every function turns inputs into an action
// object (or a refusal) and every reply into a plain result, so the node suite
// (scripts/test-hl-exchange-orders.mjs) runs the exact bytes that get signed.
//
// AMOUNTS ARE USDC OF MARGIN (owner: "amount ขอเป็น USDC"). A market order is:
//   size   = margin x leverage / the CURRENT mid, rounded to szDecimals
//   price  = the mid moved by the slippage (IOC — Hyperliquid has no native
//            market order), rounded to a valid tick
//   check  = the $10 minimum on the ROUNDED size, valued at the LOWER of the
//            mid and the order's own price, so it passes whichever price the
//            venue measures (which one it uses is not documented)
//
// TICK RULE (tick-and-lot-size docs, 2026-09-22): at most 5 significant figures
// and at most 6 - szDecimals decimals, and an INTEGER price is always valid —
// so at or above 100,000 a price rounds to a whole number, not to 5 figures
// (critic_A: without that, BTC would snap in steps of 10). Rounding happens ONCE,
// on the decimal value, never twice and never on the binary value.
//
// TP / SL are market TRIGGER orders on the MARK price, always reduce-only, on
// the closing side, with the trigger as their price (Hyperliquid applies its own
// 10% slippage tolerance to a market trigger, per the TP/SL docs page).
//   on the entry          grouping normalTpsl: [entry, tp?, sl?] in ONE action
//   on an open position   grouping positionTpsl, sized to the whole position
//   a move                place the NEW trigger first, cancel the OLD after
//                         (planTpSlMove), so a stop is never missing
//
// BUILDER FEE: attached as {b, f} (f in tenths of a basis point) only when an
// address AND a fee are both configured (resolveBuilder). The config itself is
// passed in by the perp page; nothing here reads the environment.
//
// ERRORS: known Hyperliquid strings map to plain English; an unknown one is
// passed through VERBATIM. The exact Hyperliquid text is always kept (hlText).

import { HL_PRICE_SIG_FIGS, HL_PERP_MAX_DECIMALS } from "../format.js";

/** "Order must have minimum value of $10." (error-responses docs). */
export const HL_MIN_ORDER_USDC = 10;
/** The official Python SDK's DEFAULT_SLIPPAGE for market orders. */
export const HL_DEFAULT_SLIPPAGE = 0.05;
export const HL_MIN_SLIPPAGE = 0.001;
/** Hyperliquid's own tolerance for market TP/SL; a wider market order is refused here. */
export const HL_MAX_SLIPPAGE = 0.1;
/** Builder fee cap on perps: 0.1% = 100 tenths of a basis point. */
export const HL_BUILDER_MAX_TENTHS_BP = 100;

const TENS = { nearest: Math.round, down: Math.floor, up: Math.ceil };

const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/* Strip binary noise (0.1 + 0.2) before any decimal step. 15 digits is inside
   a double's precision, and far past any price or size Hyperliquid accepts. */
const clean = (n) => Number(n.toPrecision(15));

/* n x 10^d through the decimal exponent, so 0.29 x 100 is 29 and not 28.999... */
function shift(n, d) {
  const [m, e] = n.toExponential().split("e");
  return Number(`${m}e${Number(e) + d}`);
}

const exponentOf = (n) => Number(n.toExponential().split("e")[1]);

/* A non-negative integer k with d decimals, as a normalised decimal string. */
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

/**
 * A valid perp ORDER price as a wire string, or null.
 * @param {number|string} px
 * @param {number} szDecimals the market's size decimals
 * @param {"nearest"|"down"|"up"} [mode]
 */
export function roundHlOrderPx(px, szDecimals, mode = "nearest") {
  const n = num(px);
  if (n == null || n <= 0 || !validSzDecimals(szDecimals)) return null;
  const c = clean(n);
  const cap = Math.max(0, HL_PERP_MAX_DECIMALS - szDecimals);
  const d = c >= 1e5 ? 0 : Math.min(Math.max(0, HL_PRICE_SIG_FIGS - 1 - exponentOf(c)), cap);
  const s = roundDecimals(c, d, mode);
  return s == null || Number(s) <= 0 ? null : s;
}

/**
 * A size rounded to the market's szDecimals, as a wire string ("0" when it
 * rounds away). Null for a negative or unreadable size.
 */
export function roundHlSize(sz, szDecimals, mode = "nearest") {
  const n = num(sz);
  if (n == null || n < 0 || !validSzDecimals(szDecimals)) return null;
  if (n === 0) return "0";
  return roundDecimals(n, szDecimals, mode);
}

/**
 * The Python SDK's float_to_wire: a normalised decimal string with at most 8
 * decimals and no exponent. Null when that would need rounding, or for a
 * negative, non-numeric or exponent-notation input.
 */
export function hlDecimalString(x) {
  let n;
  if (typeof x === "string") {
    if (!/^\d+(\.\d+)?$/.test(x.trim())) return null;
    n = Number(x.trim());
  } else if (typeof x === "number") {
    n = x;
  } else return null;
  if (!Number.isFinite(n) || n < 0 || n > 1e15) return null;
  const fixed = n.toFixed(8);
  if (Math.abs(Number(fixed) - n) >= 1e-12) return null;
  const out = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return out === "-0" ? "0" : out;
}

const validSlippage = (s) => typeof s === "number" && Number.isFinite(s) && s >= HL_MIN_SLIPPAGE && s <= HL_MAX_SLIPPAGE;

/** The IOC limit price of a market order: the mid moved by the slippage, on a valid tick. */
export function hlSlippagePx({ refPx, isBuy, slippage = HL_DEFAULT_SLIPPAGE, szDecimals }) {
  const ref = num(refPx);
  if (ref == null || ref <= 0 || !validSlippage(slippage)) return null;
  return roundHlOrderPx(isBuy ? ref * (1 + slippage) : ref * (1 - slippage), szDecimals, "nearest");
}

/** The $10 minimum, on the rounded size, at the lower of the mid and the order price. */
export function checkOpenMinimum({ size, refPx, limitPx }) {
  const s = num(size);
  const r = num(refPx);
  const l = num(limitPx);
  if (s == null || r == null || l == null) return { ok: false, valueUsdc: null };
  const valueUsdc = s * Math.min(r, l);
  return { ok: valueUsdc >= HL_MIN_ORDER_USDC, valueUsdc };
}

/* ── builder ──────────────────────────────────────────────────────────────── */

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** "0.05%" for f = 50 (f / 1000 percent). Null outside 1..100. */
export function builderMaxFeeRate(f) {
  if (!Number.isInteger(f) || f < 1 || f > HL_BUILDER_MAX_TENTHS_BP) return null;
  return `${(f / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/**
 * The builder config as the perp page passes it: { address, feeTenthsBp }.
 * feeTenthsBp is perp/mock/config.js's reading (0 when unset, null when
 * unreadable). ON only when a valid address AND a fee of 1..100 are both set.
 * Half-set or unreadable is INVALID: opens are refused rather than trade with a
 * fee the ticket does not show.
 */
export function resolveBuilder({ address, feeTenthsBp } = {}) {
  const invalid = (reason) => ({ enabled: false, invalid: true, reason });
  const a = typeof address === "string" ? address.trim() : address == null ? "" : address;
  const hasAddr = a !== "";
  if (feeTenthsBp === null) return invalid("bad_fee");
  const f = feeTenthsBp;
  const hasFee = f !== undefined && f !== 0;
  if (!hasAddr && !hasFee) return { enabled: false, invalid: false, reason: "unset" };
  if (hasAddr && !isAddress(a)) return invalid("bad_address");
  if (f !== undefined && !(Number.isInteger(f) && f >= 0 && f <= HL_BUILDER_MAX_TENTHS_BP)) return invalid("bad_fee");
  if (!hasAddr || f === undefined) return invalid("half_set");
  if (f === 0) return { enabled: false, invalid: false, reason: "zero_fee" };
  return { enabled: true, invalid: false, reason: null, b: a.toLowerCase(), f, maxFeeRate: builderMaxFeeRate(f) };
}

/* ── wire builders ────────────────────────────────────────────────────────── */

const isCloid = (c) => typeof c === "string" && /^0x[0-9a-fA-F]{32}$/.test(c);

/**
 * One order in the wire's key order {a, b, p, s, r, t, c?} — msgpack key order is
 * part of the signed hash. A trigger's keys are {isMarket, triggerPx, tpsl}.
 */
export function buildOrderWire({ asset, isBuy, px, sz, reduceOnly, tif, trigger, cloid }) {
  if (!Number.isSafeInteger(asset) || asset < 0) throw new Error("an order needs its asset index");
  if (typeof px !== "string" || typeof sz !== "string") throw new Error("an order's price and size are wire strings");
  const t = trigger
    ? { trigger: { isMarket: !!trigger.isMarket, triggerPx: String(trigger.triggerPx), tpsl: trigger.tpsl } }
    : { limit: { tif } };
  const w = { a: asset, b: !!isBuy, p: px, s: sz, r: !!reduceOnly, t };
  if (cloid != null) {
    if (!isCloid(cloid)) throw new Error("a cloid is 0x and 32 hex digits");
    w.c = cloid.toLowerCase();
  }
  return w;
}

/** {type, orders, grouping, builder?} — builder only when resolved ON. */
export function buildOrderAction({ orders, grouping = "na", builder = null }) {
  const action = { type: "order", orders, grouping };
  if (builder && builder.enabled === true) action.builder = { b: builder.b, f: builder.f };
  return action;
}

/** {type:"cancel", cancels:[{a, o}]} for a list of { asset, oid }. */
export function buildCancelAction(list) {
  if (!Array.isArray(list) || !list.length) throw new Error("nothing to cancel");
  return {
    type: "cancel",
    cancels: list.map(({ asset, oid }) => {
      if (!Number.isSafeInteger(asset) || asset < 0 || !Number.isSafeInteger(oid) || oid < 0) throw new Error("a cancel needs an asset and an oid");
      return { a: asset, o: oid };
    }),
  };
}

/** Isolated by default: FOMO puts every position on isolated margin. */
export function buildUpdateLeverageAction({ asset, leverage, isCross = false }) {
  if (!Number.isSafeInteger(asset) || asset < 0) throw new Error("updateLeverage needs an asset index");
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("leverage is a whole number from 1");
  return { type: "updateLeverage", asset, isCross: !!isCross, leverage };
}

/* ── plans ────────────────────────────────────────────────────────────────── */

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

const MSG = {
  market: "This market isn't loaded yet. Try again in a moment.",
  price: "No live price for this market right now. Try again in a moment.",
  stale: "The price feed paused, so the price may be old. Wait for it to update and try again.",
  side: "Pick Buy or Sell.",
  margin: "Enter an amount in USDC.",
  slippage: "Slippage must be between 0.1% and 10%.",
  builder: "The builder fee setting is incomplete: set both the builder address and the fee, or leave both empty.",
  tpsl: "Check your TP/SL: the take-profit must be on the winning side and the stop-loss on the losing side of the current price.",
  noPosition: "You have no open position in this market.",
};

function sideIsBuy(side) {
  if (side === "buy" || side === "long") return true;
  if (side === "sell" || side === "short") return false;
  return null;
}

/* The market row (lib/hyperliquid/markets.js) as far as trading needs it. */
function readMarket(m, { allowStale = false } = {}) {
  if (!m || typeof m !== "object") return { err: fail("market_unknown", MSG.market) };
  const asset = m.assetIndex;
  const perp = Number.isSafeInteger(asset) && asset >= 0 && (asset < 10_000 || (asset >= 100_000 && asset < 100_000_000));
  const maxLev = num(m.maxLeverage);
  if (!perp || !validSzDecimals(m.szDecimals) || maxLev == null || maxLev < 1) return { err: fail("market_unknown", MSG.market) };
  if (m.stale === true && !allowStale) return { err: fail("price_stale", MSG.stale) };
  const refPx = num(m.midPx) ?? num(m.px);
  if (refPx == null || refPx <= 0) return { err: fail("price_unknown", MSG.price) };
  const markPx = num(m.markPx) ?? refPx;
  return { coin: m.coin, asset, szDecimals: m.szDecimals, maxLeverage: Math.floor(maxLev), refPx, markPx };
}

const readSzi = (position) => (position && typeof position === "object" ? num(position.szi) : null);
const readLeverage = (position) => {
  if (!position) return null;
  const l = position.leverage;
  return typeof l === "object" && l !== null ? num(l.value) : num(l);
};

/** Would a TP / SL at these prices trigger at once? Checked against the MARK. */
export function validateTpSl({ isLong, refPx, tp = null, sl = null }) {
  const ref = num(refPx);
  const errors = {};
  const check = (v, leg) => {
    if (v == null) return;
    const px = num(v);
    if (ref == null || px == null || px <= 0) { errors[leg] = "No current price to check this against."; return; }
    const above = px > ref;
    const below = px < ref;
    const want = leg === "tp" ? (isLong ? above : below) : (isLong ? below : above);
    if (!want) {
      errors[leg] = leg === "tp"
        ? `Take-profit must be ${isLong ? "above" : "below"} the current price.`
        : `Stop-loss must be ${isLong ? "below" : "above"} the current price.`;
    }
  };
  check(tp, "tp");
  check(sl, "sl");
  return { ok: Object.keys(errors).length === 0, errors };
}

/* A requested trigger price rounded to a tick, or undefined (not asked), or false (unreadable). */
function triggerPx(v, szDecimals) {
  if (v === undefined || v === null) return undefined;
  const s = roundHlOrderPx(v, szDecimals, "nearest");
  return s == null ? false : s;
}

function triggerWire({ asset, closeIsBuy, size, px, leg, cloid }) {
  return buildOrderWire({
    asset, isBuy: closeIsBuy, px, sz: size, reduceOnly: true,
    trigger: { isMarket: true, triggerPx: px, tpsl: leg }, cloid: cloid ?? null,
  });
}

function minFail(size, valueUsdc) {
  const v = valueUsdc == null ? "" : ` (this one is $${valueUsdc.toFixed(2)})`;
  return fail("min_value", `Order must be worth at least $${HL_MIN_ORDER_USDC} USDC after rounding${v}.`, { size, valueUsdc });
}

/**
 * A new position at market, TP / SL optional.
 * @param {{ market: object, side: "buy"|"sell"|"long"|"short", marginUsdc: number,
 *   leverage: number, tp?: number|null, sl?: number|null, slippage?: number,
 *   builder?: object, cloids?: { entry?: string, tp?: string, sl?: string } }} o
 */
export function planOpenMarket({ market, side, marginUsdc, leverage, tp = null, sl = null, slippage = HL_DEFAULT_SLIPPAGE, builder = null, cloids = {} }) {
  if (builder && builder.invalid) return fail("builder_config_invalid", MSG.builder);
  const m = readMarket(market);
  if (m.err) return m.err;
  const isBuy = sideIsBuy(side);
  if (isBuy == null) return fail("bad_input", MSG.side);
  const margin = num(marginUsdc);
  if (typeof marginUsdc !== "number" || margin == null || margin <= 0) return fail("bad_input", MSG.margin);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > m.maxLeverage) {
    return fail("bad_input", `Leverage must be a whole number from 1x to ${m.maxLeverage}x.`);
  }
  if (!validSlippage(slippage)) return fail("bad_input", MSG.slippage);
  const size = roundHlSize((margin * leverage) / m.refPx, m.szDecimals, "nearest");
  const limitPx = hlSlippagePx({ refPx: m.refPx, isBuy, slippage, szDecimals: m.szDecimals });
  if (size == null || limitPx == null) return fail("price_unknown", MSG.price);
  const tpPx = triggerPx(tp, m.szDecimals);
  const slPx = triggerPx(sl, m.szDecimals);
  if (tpPx === false || slPx === false) return fail("bad_input", "Enter TP/SL as prices.");
  const v = validateTpSl({ isLong: isBuy, refPx: m.markPx, tp: tpPx ?? null, sl: slPx ?? null });
  if (!v.ok) return fail("invalid_tpsl", MSG.tpsl, { errors: v.errors });
  const min = checkOpenMinimum({ size, refPx: m.refPx, limitPx });
  if (!min.ok) return minFail(size, min.valueUsdc);
  const orders = [buildOrderWire({ asset: m.asset, isBuy, px: limitPx, sz: size, reduceOnly: false, tif: "Ioc", cloid: cloids.entry ?? null })];
  if (tpPx) orders.push(triggerWire({ asset: m.asset, closeIsBuy: !isBuy, size, px: tpPx, leg: "tp", cloid: cloids.tp }));
  if (slPx) orders.push(triggerWire({ asset: m.asset, closeIsBuy: !isBuy, size, px: slPx, leg: "sl", cloid: cloids.sl }));
  return {
    ok: true, coin: m.coin, asset: m.asset, isBuy, size, limitPx, refPx: m.refPx, valueUsdc: min.valueUsdc,
    leverage, marginUsdc: margin, tpPx: tpPx ?? null, slPx: slPx ?? null,
    leverageAction: buildUpdateLeverageAction({ asset: m.asset, leverage, isCross: false }),
    action: buildOrderAction({ orders, grouping: orders.length > 1 ? "normalTpsl" : "na", builder }),
    cloids: { entry: cloids.entry ?? null, tp: tpPx ? cloids.tp ?? null : null, sl: slPx ? cloids.sl ?? null : null },
  };
}

/** More of an open position ("Long more" / "Short more"), at the position's own leverage. */
export function planAddMarket({ market, position, marginUsdc, slippage = HL_DEFAULT_SLIPPAGE, builder = null, cloid = null }) {
  if (builder && builder.invalid) return fail("builder_config_invalid", MSG.builder);
  const m = readMarket(market);
  if (m.err) return m.err;
  const szi = readSzi(position);
  if (szi == null || szi === 0) return fail("no_position", MSG.noPosition);
  const leverage = readLeverage(position);
  if (!Number.isInteger(leverage) || leverage < 1) return fail("state_unknown", "Couldn't read this position's leverage. Try again.");
  const margin = num(marginUsdc);
  if (typeof marginUsdc !== "number" || margin == null || margin <= 0) return fail("bad_input", MSG.margin);
  if (!validSlippage(slippage)) return fail("bad_input", MSG.slippage);
  const isBuy = szi > 0;
  const size = roundHlSize((margin * leverage) / m.refPx, m.szDecimals, "nearest");
  const limitPx = hlSlippagePx({ refPx: m.refPx, isBuy, slippage, szDecimals: m.szDecimals });
  if (size == null || limitPx == null) return fail("price_unknown", MSG.price);
  const min = checkOpenMinimum({ size, refPx: m.refPx, limitPx });
  if (!min.ok) return minFail(size, min.valueUsdc);
  const orders = [buildOrderWire({ asset: m.asset, isBuy, px: limitPx, sz: size, reduceOnly: false, tif: "Ioc", cloid })];
  return {
    ok: true, coin: m.coin, asset: m.asset, isBuy, size, limitPx, refPx: m.refPx, valueUsdc: min.valueUsdc,
    leverage, marginUsdc: margin, action: buildOrderAction({ orders, grouping: "na", builder }), cloid: cloid ?? null,
  };
}

/**
 * Close a fraction (0 < f <= 1) of the position: a reduce-only IOC. Never held
 * to the client $10 guard (critic_A: a dust position must stay closable). A
 * share under 100% rounds DOWN to the market's lot, so the close is never more
 * than the share picked (a share that rounds to nothing is refused as too
 * small); 100% sends the position's exact size.
 */
export function planCloseFraction({ market, position, fraction, slippage = HL_DEFAULT_SLIPPAGE, builder = null, cloid = null }) {
  const m = readMarket(market, { allowStale: true });
  if (m.err) return m.err;
  const szi = readSzi(position);
  if (szi == null || szi === 0) return fail("no_position", MSG.noPosition);
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    return fail("bad_input", "Pick how much to close, up to 100%.");
  }
  if (!validSlippage(slippage)) return fail("bad_input", MSG.slippage);
  const abs = Math.abs(szi);
  const whole = hlDecimalString(clean(abs));
  if (whole == null) return fail("state_unknown", "Couldn't read this position's size. Try again.");
  let size = fraction === 1 ? whole : roundHlSize(abs * fraction, m.szDecimals, "down");
  let closesAll = fraction === 1;
  if (size != null && Number(size) >= abs) { size = whole; closesAll = true; }
  if (size == null || Number(size) <= 0) return fail("too_small", "That is less than the smallest size this market trades. Close a bigger share.");
  const isBuy = szi < 0;
  const limitPx = hlSlippagePx({ refPx: m.refPx, isBuy, slippage, szDecimals: m.szDecimals });
  if (limitPx == null) return fail("price_unknown", MSG.price);
  const orders = [buildOrderWire({ asset: m.asset, isBuy, px: limitPx, sz: size, reduceOnly: true, tif: "Ioc", cloid })];
  return {
    ok: true, coin: m.coin, asset: m.asset, isBuy, size, limitPx, refPx: m.refPx, closesAll,
    action: buildOrderAction({ orders, grouping: "na", builder }), cloid: cloid ?? null,
  };
}

/**
 * TP and/or SL on the WHOLE open position (grouping positionTpsl), TP first.
 * @returns {{ ok: true, action: object, legs: object[] } | { ok: false }}
 */
export function planPositionTpsl({ market, position, tp, sl, builder = null, cloids = {} }) {
  const m = readMarket(market, { allowStale: true });
  if (m.err) return m.err;
  const szi = readSzi(position);
  if (szi == null || szi === 0) return fail("no_position", MSG.noPosition);
  const whole = hlDecimalString(clean(Math.abs(szi)));
  if (whole == null) return fail("state_unknown", "Couldn't read this position's size. Try again.");
  const isLong = szi > 0;
  const tpPx = triggerPx(tp, m.szDecimals);
  const slPx = triggerPx(sl, m.szDecimals);
  if (tpPx === false || slPx === false) return fail("bad_input", "Enter TP/SL as prices.");
  if (!tpPx && !slPx) return fail("bad_input", "Set a take-profit or a stop-loss.");
  const v = validateTpSl({ isLong, refPx: m.markPx, tp: tpPx ?? null, sl: slPx ?? null });
  if (!v.ok) return fail("invalid_tpsl", MSG.tpsl, { errors: v.errors });
  const legs = [];
  const orders = [];
  for (const [leg, px] of [["tp", tpPx], ["sl", slPx]]) {
    if (!px) continue;
    orders.push(triggerWire({ asset: m.asset, closeIsBuy: !isLong, size: whole, px, leg, cloid: cloids[leg] }));
    legs.push({ leg, triggerPx: px, size: whole, cloid: cloids[leg] ?? null });
  }
  return { ok: true, coin: m.coin, asset: m.asset, action: buildOrderAction({ orders, grouping: "positionTpsl", builder }), legs };
}

/**
 * The coin's reduce-only TRIGGER orders from frontendOpenOrders, split into TP
 * and SL by their orderType ("Take Profit Market", "Stop Market", ...).
 */
export function classifyTpSlOrders(openOrders, coin) {
  const out = { tp: [], sl: [] };
  if (!Array.isArray(openOrders)) return out;
  for (const o of openOrders) {
    if (!o || o.coin !== coin || o.isTrigger !== true || o.reduceOnly !== true) continue;
    const oid = num(o.oid);
    if (!Number.isSafeInteger(oid)) continue;
    const kind = String(o.orderType || "");
    const leg = /take profit/i.test(kind) ? "tp" : /stop/i.test(kind) ? "sl" : null;
    if (!leg) continue;
    out[leg].push({ oid, triggerPx: num(o.triggerPx), sz: num(o.sz), isPositionTpsl: o.isPositionTpsl === true, cloid: o.cloid ?? null });
  }
  return out;
}

/**
 * Set, move or remove the position's TP / SL.
 *   tp / sl undefined   leave that leg alone
 *   null                remove it (cancel only)
 *   a price             place a new positionTpsl trigger, then cancel the old
 * Returns the STEPS in the order they must run: placeNew first, cancelOld after.
 */
export function planTpSlMove({ market, position, openOrders, tp, sl, builder = null, cloids = {} }) {
  const wantTp = tp !== undefined;
  const wantSl = sl !== undefined;
  const m = readMarket(market, { allowStale: true });
  if (m.err) return m.err;
  const szi = readSzi(position);
  if (szi == null || szi === 0) return fail("no_position", MSG.noPosition);
  if (!wantTp && !wantSl) return fail("bad_input", "Nothing to change.");
  const existing = classifyTpSlOrders(openOrders, m.coin);
  const steps = [];
  const placeTp = wantTp && tp !== null ? tp : undefined;
  const placeSl = wantSl && sl !== null ? sl : undefined;
  if (placeTp !== undefined || placeSl !== undefined) {
    const p = planPositionTpsl({ market, position, tp: placeTp, sl: placeSl, builder, cloids });
    if (!p.ok) return p;
    steps.push({ kind: "placeNew", action: p.action, legs: p.legs });
  }
  const cancelOids = { tp: wantTp ? existing.tp.map((x) => x.oid) : [], sl: wantSl ? existing.sl.map((x) => x.oid) : [] };
  const oids = [...cancelOids.tp, ...cancelOids.sl];
  if (oids.length) steps.push({ kind: "cancelOld", action: buildCancelAction(oids.map((oid) => ({ asset: m.asset, oid }))), oids });
  return { ok: true, coin: m.coin, asset: m.asset, steps, cancelOids };
}

/* ── replies ──────────────────────────────────────────────────────────────── */

const ERRORS = [
  [/User or API Wallet .* does not exist/i, "agent_missing", "Your trading key expired or was replaced (for example by Enable trading on another device). Enable trading again.", true],
  [/Must deposit before performing actions/i, "must_deposit", "Deposit USDC to your Perp account first. Hyperliquid accepts nothing from an address that has never deposited."],
  [/minimum value of/i, "min_value", `Order must be worth at least $${HL_MIN_ORDER_USDC} USDC after rounding.`],
  [/Insufficient margin/i, "insufficient_margin", "Not enough USDC in your Perp account for this order's margin and fee."],
  [/Reduce only order would increase position/i, "reduce_only", "This close would increase your position, so it may already be closed. Refresh your positions."],
  [/Invalid TP\/SL price/i, "invalid_tpsl", "That TP/SL price would trigger immediately. Put the take-profit on the winning side and the stop-loss on the losing side of the current price."],
  [/too many (cumulative )?requests|rate.?limit/i, "rate_limited", "Hyperliquid is rate-limiting this account. Wait a few seconds and try again."],
  [/open interest (is )?capped|open interest too quickly|open interest cap/i, "oi_cap", "This market is at its open-interest cap right now. Try a smaller order, or try later."],
  [/too far from oracle/i, "oracle_far", "The order price is too far from Hyperliquid's oracle price. Try again, or use a smaller slippage."],
  [/No liquidity available for market order/i, "no_liquidity", "No liquidity to trade against right now. Try again in a moment."],
  [/could not immediately match/i, "no_match", "Nothing to match at this price: the market moved. Try again."],
  [/margin tier limit/i, "margin_tier", "This position is too large for the chosen leverage. Lower the leverage or the amount."],
  [/divisible by tick size/i, "tick_size", "The order price has more digits than this market allows."],
  [/never placed, already canceled, or filled/i, "order_gone", "That order is already gone (filled or cancelled)."],
  [/builder.*(approv|max(imum)? (builder )?fee|exceed)|(approv|max(imum)? (builder )?fee).*builder/i, "builder_not_approved", "FlowFlow's builder fee isn't approved on this account. Enable trading again to approve it.", true],
  [/nonce/i, "nonce", "Signing clock problem: check that your device sets its date and time automatically, then try again."],
];

/**
 * A Hyperliquid error string in plain English. Unknown text passes through
 * verbatim; hlText always keeps the original.
 * @returns {{ code: string, message: string, hlText: string, needsEnable: boolean }}
 */
export function mapHlError(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return { code: "hl_error", message: "Hyperliquid refused the request without saying why.", hlText: t, needsEnable: false };
  for (const [re, code, message, needsEnable] of ERRORS) {
    if (re.test(t)) return { code, message, hlText: t, needsEnable: !!needsEnable };
  }
  return { code: "hl_error", message: t, hlText: t, needsEnable: false };
}

function parseStatus(s) {
  if (s === "success") return { kind: "success" };
  if (s === "waitingForFill") return { kind: "waitingForFill" };
  if (s === "waitingForTrigger") return { kind: "waitingForTrigger" };
  if (s && typeof s === "object") {
    if (s.filled && typeof s.filled === "object") {
      const f = s.filled;
      return { kind: "filled", totalSz: f.totalSz == null ? null : String(f.totalSz), avgPx: f.avgPx == null ? null : String(f.avgPx), oid: f.oid ?? null, cloid: f.cloid ?? null };
    }
    if (s.resting && typeof s.resting === "object") return { kind: "resting", oid: s.resting.oid ?? null, cloid: s.resting.cloid ?? null };
    if ("error" in s) return { kind: "error", ...mapHlError(typeof s.error === "string" ? s.error : JSON.stringify(s.error)) };
  }
  return { kind: "unknown", raw: s };
}

/**
 * Any /exchange reply.
 *   { ok: true, type, statuses: [...] }  per-order statuses: filled | resting |
 *     error (mapped) | waitingForFill | waitingForTrigger | success | unknown
 *   { ok: false, code, message, hlText, needsEnable }  the whole request refused
 * @param {any} json the parsed body (null when it was not JSON)
 * @param {number} [httpStatus]
 * @param {string} [text] the raw body, for non-JSON answers
 */
export function parseExchangeResponse(json, httpStatus = 200, text = "") {
  if (httpStatus === 429) {
    const m = mapHlError(text || "Too many requests");
    return { ok: false, ...m, code: "rate_limited", message: mapHlError("rate limit").message, needsEnable: false };
  }
  if (httpStatus >= 400) {
    const raw = text || (typeof json === "string" ? json : "") || `Hyperliquid answered HTTP ${httpStatus}.`;
    return { ok: false, ...mapHlError(raw) };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, code: "bad_response", message: "Hyperliquid answered something unreadable. Check your positions before trying again.", hlText: String(text || ""), needsEnable: false };
  }
  if (json.status === "err") {
    return { ok: false, ...mapHlError(typeof json.response === "string" ? json.response : JSON.stringify(json.response)) };
  }
  if (json.status !== "ok" || !json.response || typeof json.response !== "object") {
    return { ok: false, code: "bad_response", message: "Hyperliquid answered something unreadable. Check your positions before trying again.", hlText: String(text || ""), needsEnable: false };
  }
  const data = json.response.data;
  const statuses = data && Array.isArray(data.statuses) ? data.statuses.map(parseStatus) : [];
  return { ok: true, type: json.response.type ?? null, statuses };
}
