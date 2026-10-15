// ─────────────────────────────────────────────────────────────────────────────
// MOCK perp trading: the arithmetic. Pure, dependency-free, runs in node.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner: "เราทำขึ้นมาก่อน เป็น Mock เดะ" — build it first, as a MOCK. Nothing here
// signs, orders or talks to any network. It models Hyperliquid ISOLATED perps
// (FOMO puts every position on isolated margin) on marks the caller supplies,
// with mock money: an account of 1000 USD that is NOT money. A mock figure must
// never reach usePortfolio, the Cash or Portfolio totals, the header pills, the
// leaderboard or copy (owner rule 2); every screen that prints one labels it MOCK.
//
// THE MODEL, per coin (one position per coin, as on Hyperliquid):
//   open   notional = margin x leverage; size = notional / entry, rounded to
//          the market's szDecimals; entry = the price given. The venue checks
//          the ROUNDED order against its $10 minimum, so this does too. The
//          margin actually used is size x entry / leverage (Hyperliquid's
//          initial margin), which keeps the leverage exact and the liquidation
//          price identical to the ticket's estimate (MONEY_RULES 1). Cash pays
//          margin + fee.
//   add    same side only; entry becomes the size-weighted average, margins
//          add, the leverage stays the position's, liquidation is recomputed.
//          The opposite side is not a flip here: the UI routes it to Close.
//   close  a fraction 0..1: realised = closed size x (mark - entry) x side;
//          cash += released margin + realised - fee; 100% removes it.
//   TP/SL  long: TP above the mark, SL below the mark AND above liquidation;
//          short mirrored. They fire on the MARK (as Hyperliquid's do) and fill
//          AT the trigger price, with no slippage — a real market trigger fills
//          worse. Liquidation takes the WHOLE isolated margin and is recorded
//          as Liquidated (Hyperliquid's book liquidation can hand back part of
//          the maintenance margin; the mock books the full loss, which never
//          overstates a result).
//   fees   notional x (HL taker 0.045% + builder fee), on every open, add and
//          close (fees.js; the rate arrives as ctx.feeRate).
//
// WHICH LEVEL FIRES when one mark is past several (a gap, or the first mark
// after the tab was away): the one the price met FIRST on the way there. For a
// long falling, a stop set inside liquidation fires before liquidation; a stop
// the liquidation price has overtaken (an add can do that) never gets its turn.
//
// LIMITS OF A MOCK: no funding is charged or paid, no slippage, no partial
// fills, no auto-deleveraging, and nothing past a market's FIRST margin tier
// (the ticket shows no liquidation estimate there, so the mock refuses such a
// size rather than invent one). Triggers only run while the app is open.
//
// Every function takes the state and returns a NEW state; nothing is mutated.
// Unknown in, null out (MONEY_RULES section 0).

import { estIsolatedLiqPx, marginTierFor, HL_MIN_ORDER_USD } from "../perpTicket.js";

export const PERP_MOCK_VERSION = 1;
export const PERP_MOCK_START_USD = 1000;
export const PERP_MOCK_STORAGE_KEY = "flowflow.perpMock.v1";

/** What each refusal means, in words a ticket can show. */
export const PERP_MOCK_ERROR_TEXT = Object.freeze({
  badCoin: "Pick a market first",
  badSide: "Pick Long or Short",
  badAmount: "Enter an amount",
  badLeverage: "Leverage is a whole number from 1x",
  leverageAboveMax: "Above this market's max leverage",
  leverageMismatch: "Adding uses the position's own leverage",
  marketUnknown: "Market details are still loading",
  priceUnknown: "No live mark price yet",
  feeUnknown: "The fee setting cannot be read",
  belowMin: "Hyperliquid's minimum order is $10",
  pastTier: "Too large for this market's first margin tier",
  tiersUnknown: "This market's margin tiers are not loaded",
  insufficientFunds: "Not enough mock balance",
  liqUnknown: "No liquidation price for this order",
  positionOpen: "You already hold this market: add to it or close it",
  noPosition: "No open position in this market",
  oppositeSide: "That is the other side: close the position instead",
  badFraction: "Pick how much to close",
  closeTooSmall: "Too small to close",
  badTp: "Enter a take-profit price",
  badSl: "Enter a stop-loss price",
  tpWrongSide: "Take profit must be past the mark price, in your favour",
  slWrongSide: "Stop loss must be past the mark price, against you",
  slPastLiq: "Stop loss must sit before the liquidation price",
  triggered: "The mark already reached a trigger on this position",
});

/** The history entry's name on screen. */
export const PERP_MOCK_EVENT_LABEL = Object.freeze({
  open: "Opened",
  add: "Added",
  close: "Closed",
  tp: "Take profit",
  sl: "Stop loss",
  liquidated: "Liquidated",
  tpsl: "TP / SL set",
  reset: "Mock account reset",
});

/* ── small helpers ─────────────────────────────────────────────────────────── */

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => fin(v) && v > 0;
const SIGN = Object.freeze({ long: 1, short: -1 });
const TICKET_SIDE = Object.freeze({ long: "buy", short: "sell" });
const isSide = (s) => s === "long" || s === "short";
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The position held in a coin, or null. */
export function perpMockPositionOf(state, coin) {
  return state && state.positions && typeof coin === "string" && own(state.positions, coin) ? state.positions[coin] : null;
}

const validCoin = (c) => typeof c === "string" && c.length > 0 && c.length <= 40 && c !== "__proto__";

/** long | short from long/short or the ticket's buy/sell; null otherwise. */
export function perpMockSide(side) {
  if (side === "long" || side === "buy") return "long";
  if (side === "short" || side === "sell") return "short";
  return null;
}

const scaled = (x, d) => Number((x * 10 ** d).toPrecision(12));

/** A coin size rounded to the market's step (szDecimals), to the nearest step. Null for bad input. */
export function roundPerpSize(x, szDecimals) {
  if (!fin(x) || !Number.isInteger(szDecimals) || szDecimals < 0) return null;
  return Number((Math.round(scaled(x, szDecimals)) / 10 ** szDecimals).toFixed(szDecimals));
}

function floorPerpSize(x, szDecimals) {
  return Number((Math.floor(scaled(x, szDecimals)) / 10 ** szDecimals).toFixed(szDecimals));
}

/* What an order of this size costs: one path for the quote, the fill and the max. */
function orderCost(size, px, leverage, feeRate) {
  const notionalUsd = size * px;
  const marginUsd = notionalUsd / leverage;
  const feeUsd = notionalUsd * feeRate;
  return { notionalUsd, marginUsd, feeUsd, costUsd: marginUsd + feeUsd };
}

function readTiers(t) {
  if (!Array.isArray(t) || !t.length) return null;
  const out = [];
  for (const x of t) {
    if (!x || !fin(x.lowerBound) || x.lowerBound < 0 || !fin(x.maxLeverage) || x.maxLeverage < 1) return null;
    out.push(Object.freeze({ lowerBound: x.lowerBound, maxLeverage: x.maxLeverage }));
  }
  out.sort((a, b) => a.lowerBound - b.lowerBound);
  return Object.freeze(out);
}

/* A market row (lib/hyperliquid/markets.js) as the three facts the mock needs. */
function readMarket(m) {
  if (!m || typeof m !== "object") return null;
  const { szDecimals, maxLeverage } = m;
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || !fin(maxLeverage) || maxLeverage < 1) return null;
  return { szDecimals, maxLeverage, tiers: readTiers(m.marginTiers) };
}

/* Inside the first margin tier, or why not. Same rule as perpTicketPreview. */
function tierProblem(tiers, notionalUsd) {
  if (!tiers) return "tiersUnknown";
  const t = marginTierFor(tiers, notionalUsd);
  if (!t) return "tiersUnknown";
  return t === tiers[0] ? null : "pastTier";
}

/** The position's liquidation price: slice 1's estimate, so the ticket and the card agree. */
export function perpMockLiqPx(p) {
  if (!p || !isSide(p.side)) return null;
  return estIsolatedLiqPx({ side: TICKET_SIDE[p.side], entryPx: p.entryPx, leverage: p.leverage, maxLeverage: p.maxLeverage });
}

/* TP / SL against a mark and a liquidation price; only the levels given are checked. */
function levelProblem(side, markPx, liqPx, tp, sl) {
  const s = SIGN[side];
  if (tp != null) {
    if (!pos(tp)) return "badTp";
    if (s * (tp - markPx) <= 0) return "tpWrongSide";
  }
  if (sl != null) {
    if (!pos(sl)) return "badSl";
    if (s * (sl - markPx) >= 0) return "slWrongSide";
    if (liqPx != null && s * (sl - liqPx) <= 0) return "slPastLiq";
  }
  return null;
}

function fail(error, events = []) {
  return Object.freeze({ ok: false, error, message: PERP_MOCK_ERROR_TEXT[error] || error, events: Object.freeze([...events]) });
}

function withEvent(state, fields) {
  const event = Object.freeze({ id: state.seq, t: fields.t, type: fields.type, label: PERP_MOCK_EVENT_LABEL[fields.type], ...fields });
  return { history: Object.freeze([...state.history, event]), seq: state.seq + 1, event };
}

/* ── the account ───────────────────────────────────────────────────────────── */

/**
 * A new mock account. Its first history entry says why it exists:
 * reason new (first visit), user (Reset), corrupt or version (an unreadable blob).
 */
export function perpMockFresh({ now = 0, startUsd = PERP_MOCK_START_USD, reason = "new", acct = 1 } = {}) {
  const base = { seq: 1, history: Object.freeze([]) };
  const { history, seq } = withEvent(base, { t: now, type: "reset", reason, availableUsd: startUsd });
  return Object.freeze({
    v: PERP_MOCK_VERSION,
    mock: true,
    acct,
    rev: 0,
    startUsd,
    availableUsd: startUsd,
    positions: Object.freeze({}),
    history,
    seq,
    createdAt: now,
    updatedAt: now,
  });
}

function nextState(state, patch) {
  return Object.freeze({ ...state, ...patch });
}

function setPosition(positions, coin, p) {
  const out = { ...positions };
  if (p) out[coin] = Object.freeze(p);
  else delete out[coin];
  return Object.freeze(out);
}

/* ── open ──────────────────────────────────────────────────────────────────── */

/**
 * What open() would book, without booking it — the ticket can print exactly
 * these figures. input: { coin, side, marginUsd, leverage, markPx, tp, sl, market };
 * ctx: { feeRate }.
 */
export function quotePerpMockOpen(state, input, ctx = {}) {
  const i = input || {};
  if (!validCoin(i.coin)) return fail("badCoin");
  const side = perpMockSide(i.side);
  if (!side) return fail("badSide");
  if (!pos(i.marginUsd)) return fail("badAmount");
  const m = readMarket(i.market);
  if (!m) return fail("marketUnknown");
  if (!Number.isInteger(i.leverage) || i.leverage < 1) return fail("badLeverage");
  if (i.leverage > m.maxLeverage) return fail("leverageAboveMax");
  if (!pos(i.markPx)) return fail("priceUnknown");
  if (perpMockPositionOf(state, i.coin)) return fail("positionOpen");
  const feeRate = ctx.feeRate;
  if (!fin(feeRate) || feeRate < 0) return fail("feeUnknown");

  const size = roundPerpSize((i.marginUsd * i.leverage) / i.markPx, m.szDecimals);
  if (!pos(size)) return fail("belowMin");
  const c = orderCost(size, i.markPx, i.leverage, feeRate);
  if (c.notionalUsd < HL_MIN_ORDER_USD) return fail("belowMin");
  const tier = tierProblem(m.tiers, c.notionalUsd);
  if (tier) return fail(tier);
  if (c.costUsd > state.availableUsd) return fail("insufficientFunds");
  const liqPx = estIsolatedLiqPx({ side: TICKET_SIDE[side], entryPx: i.markPx, leverage: i.leverage, maxLeverage: m.maxLeverage });
  if (liqPx == null) return fail("liqUnknown");
  const tp = i.tp == null ? null : i.tp;
  const sl = i.sl == null ? null : i.sl;
  const lv = levelProblem(side, i.markPx, liqPx, tp, sl);
  if (lv) return fail(lv);
  return Object.freeze({
    ok: true, mock: true, kind: "open",
    coin: i.coin, side, leverage: i.leverage, size, entryPx: i.markPx,
    notionalUsd: c.notionalUsd, marginUsd: c.marginUsd, feeUsd: c.feeUsd, costUsd: c.costUsd, feeRate,
    liqPx, tp, sl,
    availableAfterUsd: state.availableUsd - c.costUsd,
  });
}

/** Open a position. Returns { state, result, events }. */
export function perpMockOpen(state, input, ctx = {}) {
  const q = quotePerpMockOpen(state, input, ctx);
  if (!q.ok) return { state, result: q, events: [] };
  const now = fin(ctx.now) ? ctx.now : 0;
  const m = readMarket(input.market);
  const id = state.seq;
  const position = {
    id, coin: q.coin, side: q.side, size: q.size, entryPx: q.entryPx, marginUsd: q.marginUsd,
    leverage: q.leverage, maxLeverage: m.maxLeverage, szDecimals: m.szDecimals, tiers: m.tiers,
    liqPx: q.liqPx, tp: q.tp, sl: q.sl, feesUsd: q.feeUsd, fills: 1, openedAt: now, updatedAt: now,
  };
  const availableUsd = state.availableUsd - q.costUsd;
  const { history, seq, event } = withEvent(state, {
    t: now, type: "open", posId: id, coin: q.coin, side: q.side, leverage: q.leverage,
    size: q.size, px: q.entryPx, notionalUsd: q.notionalUsd, marginUsd: q.marginUsd,
    feeUsd: q.feeUsd, pnlUsd: null, availableUsd, tp: q.tp, sl: q.sl,
  });
  const positions = setPosition(state.positions, q.coin, position);
  const next = nextState(state, { availableUsd, positions, history, seq });
  return { state: next, result: Object.freeze({ ...q, event, position: positions[q.coin], events: Object.freeze([]) }), events: [] };
}

/**
 * The largest margin (USD) whose order, at this leverage and mark, fits the
 * balance with its fee — already on the market's size step, so open() books it
 * exactly. Null for unknown input; 0 when not even one step fits.
 */
export function maxPerpMockMarginUsd({ availableUsd, leverage, feeRate, markPx, szDecimals } = {}) {
  if (!fin(availableUsd) || availableUsd < 0 || !Number.isInteger(leverage) || leverage < 1) return null;
  if (!fin(feeRate) || feeRate < 0 || !pos(markPx) || !Number.isInteger(szDecimals) || szDecimals < 0) return null;
  const step = 10 ** -szDecimals;
  let size = floorPerpSize(availableUsd / (markPx * (1 / leverage + feeRate)), szDecimals);
  while (size > 0 && orderCost(size, markPx, leverage, feeRate).costUsd > availableUsd) size = roundPerpSize(size - step, szDecimals);
  return size > 0 ? orderCost(size, markPx, leverage, feeRate).marginUsd : 0;
}

/* ── triggers ──────────────────────────────────────────────────────────────── */

/**
 * The level this mark sets off, or null: { type: tp | sl | liquidated, px }.
 * px is the level itself (the fill price of a TP / SL, the liquidation price).
 */
export function perpMockTrigger(p, markPx) {
  if (!p || !isSide(p.side) || !pos(markPx)) return null;
  const s = SIGN[p.side];
  const liq = fin(p.liqPx) ? p.liqPx : null;
  const reached = (level) => s * (markPx - level) <= 0;
  if (p.sl != null && (liq == null || s * (p.sl - liq) > 0) && reached(p.sl)) return { type: "sl", px: p.sl };
  if (liq != null && reached(liq)) return { type: "liquidated", px: liq };
  if (p.tp != null && s * (markPx - p.tp) >= 0) return { type: "tp", px: p.tp };
  return null;
}

function closeFigures(p, size, px, feeRate, full) {
  const notionalUsd = size * px;
  const pnlUsd = SIGN[p.side] * size * (px - p.entryPx);
  const feeUsd = notionalUsd * feeRate;
  const marginReleasedUsd = full ? p.marginUsd : p.marginUsd * (size / p.size);
  return { notionalUsd, pnlUsd, feeUsd, marginReleasedUsd, receiveUsd: marginReleasedUsd + pnlUsd - feeUsd };
}

function applyClose(state, p, { size, px, full, type, markPx = null }, ctx) {
  const now = fin(ctx.now) ? ctx.now : 0;
  const f = closeFigures(p, size, px, ctx.feeRate, full);
  const availableUsd = state.availableUsd + f.receiveUsd;
  const remainingSize = full ? 0 : roundPerpSize(p.size - size, p.szDecimals);
  const kept = full ? null : {
    ...p, size: remainingSize, marginUsd: p.marginUsd - f.marginReleasedUsd,
    feesUsd: p.feesUsd + f.feeUsd, fills: p.fills + 1, updatedAt: now,
  };
  const { history, seq, event } = withEvent(state, {
    t: now, type, posId: p.id, coin: p.coin, side: p.side, leverage: p.leverage,
    size, px, markPx, notionalUsd: f.notionalUsd, marginUsd: f.marginReleasedUsd,
    feeUsd: f.feeUsd, pnlUsd: f.pnlUsd, remainingSize, availableUsd, entryPx: p.entryPx,
  });
  const positions = setPosition(state.positions, p.coin, kept);
  return { state: nextState(state, { availableUsd, positions, history, seq }), event, figures: f, remainingSize };
}

function applyLiquidation(state, p, markPx, ctx) {
  const now = fin(ctx.now) ? ctx.now : 0;
  const { history, seq, event } = withEvent(state, {
    t: now, type: "liquidated", posId: p.id, coin: p.coin, side: p.side, leverage: p.leverage,
    size: p.size, px: p.liqPx, markPx, notionalUsd: p.size * p.liqPx, marginUsd: p.marginUsd,
    feeUsd: 0, pnlUsd: -p.marginUsd, remainingSize: 0, availableUsd: state.availableUsd, entryPx: p.entryPx,
  });
  const positions = setPosition(state.positions, p.coin, null);
  return { state: nextState(state, { positions, history, seq }), event };
}

/* Let a mark do what it does to a coin's position before anything else runs. */
function settle(state, coin, markPx, ctx) {
  const p = perpMockPositionOf(state, coin);
  const hit = perpMockTrigger(p, markPx);
  if (!hit) return { state, events: [] };
  if (hit.type === "liquidated") {
    const r = applyLiquidation(state, p, markPx, ctx);
    return { state: r.state, events: [r.event] };
  }
  /* A TP / SL fill pays a fee; with the fee unknown it waits rather than guess. */
  if (!fin(ctx.feeRate) || ctx.feeRate < 0) return { state, events: [] };
  const r = applyClose(state, p, { size: p.size, px: hit.px, full: true, type: hit.type, markPx }, ctx);
  return { state: r.state, events: [r.event] };
}

/**
 * A mark for a coin: fires TP / SL / liquidation when it reaches them.
 * Returns { state, result: events, events } — events is empty when nothing fired.
 */
export function perpMockOnMark(state, input, ctx = {}) {
  const i = input || {};
  const r = settle(state, i.coin, i.markPx, ctx);
  const events = Object.freeze(r.events);
  return { state: r.state, result: events, events };
}

/* ── add ───────────────────────────────────────────────────────────────────── */

/** What add() would book. input: { coin, side, marginUsd, markPx, leverage? }; ctx: { feeRate }. */
export function quotePerpMockAdd(state, input, ctx = {}) {
  const i = input || {};
  if (!validCoin(i.coin)) return fail("badCoin");
  const p = perpMockPositionOf(state, i.coin);
  if (!p) return fail("noPosition");
  const side = perpMockSide(i.side);
  if (!side) return fail("badSide");
  if (side !== p.side) return fail("oppositeSide");
  if (i.leverage != null && i.leverage !== p.leverage) return fail("leverageMismatch");
  if (!pos(i.marginUsd)) return fail("badAmount");
  if (!pos(i.markPx)) return fail("priceUnknown");
  const feeRate = ctx.feeRate;
  if (!fin(feeRate) || feeRate < 0) return fail("feeUnknown");

  const addSize = roundPerpSize((i.marginUsd * p.leverage) / i.markPx, p.szDecimals);
  if (!pos(addSize)) return fail("belowMin");
  const c = orderCost(addSize, i.markPx, p.leverage, feeRate);
  if (c.notionalUsd < HL_MIN_ORDER_USD) return fail("belowMin");
  const size = roundPerpSize(p.size + addSize, p.szDecimals);
  const tier = tierProblem(p.tiers, size * i.markPx);
  if (tier) return fail(tier);
  if (c.costUsd > state.availableUsd) return fail("insufficientFunds");
  const entryPx = (p.size * p.entryPx + addSize * i.markPx) / (p.size + addSize);
  const marginUsd = p.marginUsd + c.marginUsd;
  const liqPx = estIsolatedLiqPx({ side: TICKET_SIDE[side], entryPx, leverage: p.leverage, maxLeverage: p.maxLeverage });
  if (liqPx == null) return fail("liqUnknown");
  return Object.freeze({
    ok: true, mock: true, kind: "add",
    coin: i.coin, side, leverage: p.leverage, addSize, addPx: i.markPx,
    notionalUsd: c.notionalUsd, addMarginUsd: c.marginUsd, feeUsd: c.feeUsd, costUsd: c.costUsd, feeRate,
    size, entryPx, marginUsd, liqPx,
    slPastLiq: p.sl != null && SIGN[side] * (p.sl - liqPx) <= 0,
    availableAfterUsd: state.availableUsd - c.costUsd,
  });
}

/** Add to a position (same side). A mark already past a trigger fires it first and refuses the add. */
export function perpMockAdd(state, input, ctx = {}) {
  const i = input || {};
  const st = settle(state, i.coin, i.markPx, ctx);
  if (st.events.length) return { state: st.state, result: fail("triggered", st.events), events: st.events };
  const q = quotePerpMockAdd(st.state, i, ctx);
  if (!q.ok) return { state: st.state, result: q, events: [] };
  const now = fin(ctx.now) ? ctx.now : 0;
  const p = perpMockPositionOf(st.state, i.coin);
  const availableUsd = st.state.availableUsd - q.costUsd;
  const next = {
    ...p, size: q.size, entryPx: q.entryPx, marginUsd: q.marginUsd, liqPx: q.liqPx,
    feesUsd: p.feesUsd + q.feeUsd, fills: p.fills + 1, updatedAt: now,
  };
  const { history, seq, event } = withEvent(st.state, {
    t: now, type: "add", posId: p.id, coin: p.coin, side: p.side, leverage: p.leverage,
    size: q.addSize, px: q.addPx, notionalUsd: q.notionalUsd, marginUsd: q.addMarginUsd,
    feeUsd: q.feeUsd, pnlUsd: null, availableUsd, entryPx: q.entryPx, totalSize: q.size,
  });
  const positions = setPosition(st.state.positions, p.coin, next);
  const out = nextState(st.state, { availableUsd, positions, history, seq });
  return { state: out, result: Object.freeze({ ...q, event, position: positions[p.coin], events: Object.freeze([]) }), events: [] };
}

/* ── close ─────────────────────────────────────────────────────────────────── */

/**
 * What close() would book — the close sheet's figures. input: { coin, fraction, markPx }.
 * A partial close under the venue's $10 is refused; closing everything never is.
 * A partial share rounds DOWN to the lot, as the live planner does: never more
 * than the share picked.
 */
export function quotePerpMockClose(state, input, ctx = {}) {
  const i = input || {};
  if (!validCoin(i.coin)) return fail("badCoin");
  const p = perpMockPositionOf(state, i.coin);
  if (!p) return fail("noPosition");
  if (!fin(i.fraction) || i.fraction <= 0 || i.fraction > 1) return fail("badFraction");
  if (!pos(i.markPx)) return fail("priceUnknown");
  const feeRate = ctx.feeRate;
  if (!fin(feeRate) || feeRate < 0) return fail("feeUnknown");
  let full = i.fraction === 1;
  let size = full ? p.size : floorPerpSize(p.size * i.fraction, p.szDecimals);
  if (!pos(size)) return fail("closeTooSmall");
  if (size >= p.size) { size = p.size; full = true; }
  if (!full && size * i.markPx < HL_MIN_ORDER_USD) return fail("belowMin");
  const f = closeFigures(p, size, i.markPx, feeRate, full);
  return Object.freeze({
    ok: true, mock: true, kind: "close",
    coin: p.coin, side: p.side, size, full, fraction: full ? 1 : size / p.size, px: i.markPx, feeRate,
    notionalUsd: f.notionalUsd, pnlUsd: f.pnlUsd, feeUsd: f.feeUsd, netUsd: f.pnlUsd - f.feeUsd,
    marginReleasedUsd: f.marginReleasedUsd, receiveUsd: f.receiveUsd,
    remainingSize: full ? 0 : roundPerpSize(p.size - size, p.szDecimals),
    availableAfterUsd: state.availableUsd + f.receiveUsd,
  });
}

/** Close a fraction of a position at a mark. A mark already past a trigger fires it instead. */
export function perpMockClose(state, input, ctx = {}) {
  const i = input || {};
  const st = settle(state, i.coin, i.markPx, ctx);
  if (st.events.length) return { state: st.state, result: fail("triggered", st.events), events: st.events };
  const q = quotePerpMockClose(st.state, i, ctx);
  if (!q.ok) return { state: st.state, result: q, events: [] };
  const p = perpMockPositionOf(st.state, i.coin);
  const r = applyClose(st.state, p, { size: q.size, px: q.px, full: q.full, type: "close" }, ctx);
  return {
    state: r.state,
    result: Object.freeze({ ...q, event: r.event, position: perpMockPositionOf(r.state, i.coin), events: Object.freeze([]) }),
    events: [],
  };
}

/* ── TP / SL ───────────────────────────────────────────────────────────────── */

/**
 * Set or clear a position's take profit / stop loss against the current mark.
 * input: { coin, tp, sl, markPx } — a level left undefined keeps its value,
 * null clears it, a number is validated (only the levels given are checked).
 */
export function perpMockSetTpSl(state, input, ctx = {}) {
  const i = input || {};
  const st = settle(state, i.coin, i.markPx, ctx);
  if (st.events.length) return { state: st.state, result: fail("triggered", st.events), events: st.events };
  if (!validCoin(i.coin)) return { state: st.state, result: fail("badCoin"), events: [] };
  const p = perpMockPositionOf(st.state, i.coin);
  if (!p) return { state: st.state, result: fail("noPosition"), events: [] };
  if (!pos(i.markPx)) return { state: st.state, result: fail("priceUnknown"), events: [] };
  const lv = levelProblem(p.side, i.markPx, p.liqPx, i.tp === undefined ? null : i.tp, i.sl === undefined ? null : i.sl);
  if (lv) return { state: st.state, result: fail(lv), events: [] };
  const tp = i.tp === undefined ? p.tp : i.tp;
  const sl = i.sl === undefined ? p.sl : i.sl;
  if (tp === p.tp && sl === p.sl) {
    return { state: st.state, result: Object.freeze({ ok: true, mock: true, kind: "tpsl", coin: p.coin, tp, sl, event: null, position: p, events: Object.freeze([]) }), events: [] };
  }
  const now = fin(ctx.now) ? ctx.now : 0;
  const { history, seq, event } = withEvent(st.state, {
    t: now, type: "tpsl", posId: p.id, coin: p.coin, side: p.side, tp, sl, markPx: i.markPx,
  });
  const positions = setPosition(st.state.positions, p.coin, { ...p, tp, sl, updatedAt: now });
  const out = nextState(st.state, { positions, history, seq });
  return { state: out, result: Object.freeze({ ok: true, mock: true, kind: "tpsl", coin: p.coin, tp, sl, event, position: positions[p.coin], events: Object.freeze([]) }), events: [] };
}

/* ── what the screens read ─────────────────────────────────────────────────── */

const markOf = (mark) => {
  if (pos(mark)) return { px: mark, stale: false, at: null };
  if (mark && typeof mark === "object" && pos(mark.px)) return { px: mark.px, stale: mark.stale === true, at: fin(mark.at) ? mark.at : null };
  return null;
};

/**
 * The position card (FOMO's): value = margin + uPnL, uPnL in $ and % of
 * margin, the leveraged size in $ and in coin, entry, liquidation, and the
 * result at TP / SL (before fees). Priced at the MARK; with no mark every
 * priced figure is null (the dash), never 0. mark: a number or { px, stale, at }.
 */
export function derivePerpMockPosition(p, mark = null) {
  if (!p || !isSide(p.side)) return null;
  const s = SIGN[p.side];
  const m = markOf(mark);
  const px = m ? m.px : null;
  const uPnlUsd = px == null ? null : s * p.size * (px - p.entryPx);
  const at = (level) => (level == null ? null : s * p.size * (level - p.entryPx));
  return Object.freeze({
    mock: true,
    id: p.id, coin: p.coin, side: p.side, leverage: p.leverage,
    size: p.size, entryPx: p.entryPx, liqPx: p.liqPx, marginUsd: p.marginUsd, tp: p.tp, sl: p.sl,
    markPx: px, markStale: !!(m && m.stale), markAt: m ? m.at : null,
    uPnlUsd,
    uPnlPct: uPnlUsd == null || !(p.marginUsd > 0) ? null : (uPnlUsd / p.marginUsd) * 100,
    valueUsd: uPnlUsd == null ? null : p.marginUsd + uPnlUsd,
    notionalUsd: px == null ? null : p.size * px,
    entryNotionalUsd: p.size * p.entryPx,
    tpPnlUsd: at(p.tp),
    slPnlUsd: at(p.sl),
    slPastLiq: p.sl != null && fin(p.liqPx) && s * (p.sl - p.liqPx) <= 0,
    feesUsd: p.feesUsd, fills: p.fills, openedAt: p.openedAt, updatedAt: p.updatedAt,
  });
}

/**
 * The mock account: available cash, margin in positions, uPnL, equity
 * (available + every position's value), realised and fees since the last
 * reset. One position without a mark makes uPnL, equity and total unknown
 * (null) rather than short. marks: { [coin]: number | { px, stale, at } }.
 */
export function perpMockAccount(state, marks = {}) {
  let marginUsd = 0;
  let uPnl = 0;
  let value = 0;
  let known = true;
  let stale = false;
  let openCount = 0;
  for (const coin of Object.keys(state.positions)) {
    const p = state.positions[coin];
    openCount++;
    marginUsd += p.marginUsd;
    const d = derivePerpMockPosition(p, marks && own(marks, coin) ? marks[coin] : null);
    if (d.uPnlUsd == null) known = false;
    else { uPnl += d.uPnlUsd; value += d.valueUsd; if (d.markStale) stale = true; }
  }
  let realized = 0;
  let fees = 0;
  for (const h of state.history) {
    if (fin(h.pnlUsd)) realized += h.pnlUsd;
    if (fin(h.feeUsd)) fees += h.feeUsd;
  }
  const equityUsd = known ? state.availableUsd + value : null;
  return Object.freeze({
    mock: true,
    startUsd: state.startUsd,
    availableUsd: state.availableUsd,
    marginUsd,
    uPnlUsd: known ? uPnl : null,
    equityUsd,
    totalPnlUsd: equityUsd == null ? null : equityUsd - state.startUsd,
    realizedPnlUsd: realized,
    feesUsd: fees,
    openCount,
    stale,
  });
}

/* ── the saved blob ────────────────────────────────────────────────────────── */

function hydratePosition(coin, p) {
  if (!validCoin(coin) || !p || typeof p !== "object" || p.coin !== coin || !isSide(p.side)) return null;
  if (!Number.isInteger(p.id) || p.id < 1) return null;
  if (!pos(p.size) || !pos(p.entryPx) || !pos(p.marginUsd)) return null;
  if (!Number.isInteger(p.leverage) || p.leverage < 1 || !fin(p.maxLeverage) || p.leverage > p.maxLeverage) return null;
  if (!Number.isInteger(p.szDecimals) || p.szDecimals < 0) return null;
  if (!(p.tp === null || pos(p.tp)) || !(p.sl === null || pos(p.sl))) return null;
  if (!fin(p.feesUsd) || p.feesUsd < 0 || !Number.isInteger(p.fills) || p.fills < 1) return null;
  if (!fin(p.openedAt) || !fin(p.updatedAt)) return null;
  const tiers = p.tiers === null ? null : readTiers(p.tiers);
  if (p.tiers !== null && !tiers) return null;
  const out = {
    id: p.id, coin, side: p.side, size: p.size, entryPx: p.entryPx, marginUsd: p.marginUsd,
    leverage: p.leverage, maxLeverage: p.maxLeverage, szDecimals: p.szDecimals, tiers,
    liqPx: null, tp: p.tp, sl: p.sl, feesUsd: p.feesUsd, fills: p.fills, openedAt: p.openedAt, updatedAt: p.updatedAt,
  };
  /* Never trust a saved liquidation price: recompute it with today's formula. */
  out.liqPx = perpMockLiqPx(out);
  return out.liqPx == null ? null : Object.freeze(out);
}

/**
 * Read a saved blob. { state } when it is a readable v1 account; otherwise
 * { state: null, problem } with problem null (nothing saved), corrupt, or
 * version (a blob from another format version).
 */
export function parsePerpMockBlob(raw) {
  if (raw == null) return { state: null, problem: null };
  let j;
  try { j = JSON.parse(raw); } catch { return { state: null, problem: "corrupt" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { state: null, problem: "corrupt" };
  if (j.v !== PERP_MOCK_VERSION) return { state: null, problem: fin(j.v) ? "version" : "corrupt" };
  const bad = { state: null, problem: "corrupt" };
  if (j.mock !== true || !pos(j.startUsd) || !fin(j.availableUsd)) return bad;
  if (!Number.isInteger(j.seq) || j.seq < 1 || !Number.isInteger(j.rev) || j.rev < 0) return bad;
  if (!Number.isInteger(j.acct) || j.acct < 1 || !fin(j.createdAt) || !fin(j.updatedAt)) return bad;
  if (!j.positions || typeof j.positions !== "object" || Array.isArray(j.positions)) return bad;
  if (!Array.isArray(j.history)) return bad;
  for (const h of j.history) {
    if (!h || typeof h !== "object" || typeof h.type !== "string" || !Number.isInteger(h.id)) return bad;
  }
  const positions = {};
  for (const coin of Object.keys(j.positions)) {
    const p = hydratePosition(coin, j.positions[coin]);
    if (!p) return bad;
    positions[coin] = p;
  }
  return {
    state: Object.freeze({
      v: PERP_MOCK_VERSION, mock: true, acct: j.acct, rev: j.rev,
      startUsd: j.startUsd, availableUsd: j.availableUsd,
      positions: Object.freeze(positions),
      history: Object.freeze(j.history.map((h) => Object.freeze(h))),
      seq: j.seq, createdAt: j.createdAt, updatedAt: j.updatedAt,
    }),
    problem: null,
  };
}
