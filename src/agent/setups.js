// RECOMMENDED SETUPS (plan v2 §2.11, AD-7) and the recommended TP / SL every trade card gets. Pure: the market row,
// the candles and the account's free margin come in; nothing is fetched, signed or sent here.
//
// Owner: "ควรจะแบบมี กล่อง Recommended สีเขียวๆขึ้นมาเลย ว่า เห้ย ลอง Setup นี้ไหม RR เท่าไหร่ TP SL ตั้งให้เลย แล้วให้คนกดเลือก"
// and "อาจจะแนะนำ TP SL ให้เราเลย".
//
// 🔴 ONLY REAL DATA. Every figure comes from the live price, the last 1h candles (the average high–low range of the
// last 14 bars), funding and the caps. Missing data = no setup (an { ok:false, why }), never an invented number.
//   Safer     stop 2.0 × range, RR 1.5, up to 1x
//   Balanced  stop 1.5 × range, RR 2,   up to 2x
//   Bolder    stop 1.0 × range, RR 3,   up to 3x
// A suggested setup never goes past SETUP_MAX_LEVERAGE (plan v2 §2.11: "leverage ≤ min(cap, 3)"; the user's own
// trades keep the 10x Agent cap). Each leverage is lowered until the liquidation price sits at least LIQ_BUFFER × the
// stop distance away, and never passes FlowFlow's caps (guardrails.js) or the market's own maximum. TP / SL are ROE % (what the trade card takes),
// with the trigger prices recomputed from the rounded ROE so the box and the card print the same prices.
// A setup is data, not advice; choosing one only fills a normal trade card that waits for Confirm.
import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { estIsolatedLiqPx } from "../perp/perpTicket.js";
import { formatHlFunding } from "../lib/hyperliquid/format.js";
import { topMovers, mainMarkets } from "../trade/marketLists.js";
import { agentTicker } from "./stockWords.js";

export const SETUP_INTERVAL = "1h";
export const SETUP_BARS = 48;
export const RANGE_BARS = 14;
export const SETUP_BASIS = "1h candles · 14-bar range";
/** The liquidation price is at least this many stop distances away. */
export const LIQ_BUFFER = 2;
/** The most leverage a suggested setup carries (plan v2 §2.11), under FlowFlow's Agent cap. */
export const SETUP_MAX_LEVERAGE = Math.min(3, AGENT_MAX_LEVERAGE);
/** The margin a setup proposes when the free margin allows it (never above the cap). */
export const DEFAULT_SETUP_MARGIN_USDC = 10;

export const PROFILES = Object.freeze([
  Object.freeze({ label: "Safer", k: 2.0, rr: 1.5, lev: 1 }),
  Object.freeze({ label: "Balanced", k: 1.5, rr: 2, lev: 2 }),
  Object.freeze({ label: "Bolder", k: 1.0, rr: 3, lev: 3 }),
]);
const BALANCED = PROFILES[1];

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/** Valid bars only, oldest first. */
export function cleanCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .filter((c) => c && fin(c.high) && fin(c.low) && fin(c.close) && fin(c.open) && c.low > 0 && c.high >= c.low)
    .sort((a, b) => (fin(a.time) && fin(b.time) ? a.time - b.time : 0));
}

/** The average high–low of the last n bars (price units), or null with fewer bars. */
export function rangeOf(candles, n = RANGE_BARS) {
  const bars = cleanCandles(candles);
  if (bars.length < n) return null;
  const last = bars.slice(-n);
  const avg = last.reduce((s, c) => s + (c.high - c.low), 0) / n;
  return avg > 0 ? avg : null;
}

function ema(values, n) {
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** The 9 / 21 EMA gap of the closes as a share of the last close (+ up, − down); null with fewer than 21 bars. */
export function trendGap(candles) {
  const bars = cleanCandles(candles);
  if (bars.length < 21) return null;
  const closes = bars.map((c) => c.close);
  const last = closes[closes.length - 1];
  return last > 0 ? (ema(closes, 9) - ema(closes, 21)) / last : null;
}

/** "up" | "down" | "flat" from a 9 / 21 EMA of the closes; null with fewer than 21 bars. */
export function trendOf(candles) {
  const gap = trendGap(candles);
  if (gap == null) return null;
  return gap > 0.001 ? "up" : gap < -0.001 ? "down" : "flat";
}

/** The side the data leans to: the trend; when flat, the side funding pays; else the 24h move. */
export function leanSide({ trend = null, funding = null, change24hPct = null } = {}) {
  if (trend === "up") return "buy";
  if (trend === "down") return "sell";
  if (fin(funding) && funding !== 0) return funding > 0 ? "sell" : "buy";
  if (fin(change24hPct) && change24hPct !== 0) return change24hPct > 0 ? "buy" : "sell";
  return null;
}

const entryOf = (market) => (market && fin(market.px) && market.px > 0 ? market.px : market && fin(market.markPx) && market.markPx > 0 ? market.markPx : null);
const maxLevOf = (market) => Math.max(1, Math.min(AGENT_MAX_LEVERAGE, market && fin(market.maxLeverage) && market.maxLeverage >= 1 ? market.maxLeverage : AGENT_MAX_LEVERAGE));

/* Prices for an ROE % at a leverage: a move of roe / lev percent. */
const pxAt = (entry, side, roePct, lev, toward) => {
  const move = roePct / 100 / lev;
  const up = (side === "buy") === (toward === "tp");
  return up ? entry * (1 + move) : entry * (1 - move);
};

/* One profile at one side, or null when it cannot be built honestly. */
function profileSetup({ market, entry, range, side, margin, feeRate, p, at, reasonTail }) {
  const d = p.k * range;
  const dPct = d / entry;
  if (!(dPct > 0) || dPct >= 0.5) return null;
  const maxLev = market.maxLeverage;
  let lev = Math.max(1, Math.floor(Math.min(p.lev, SETUP_MAX_LEVERAGE, maxLevOf(market))));
  let liq = null;
  for (; lev >= 1; lev--) {
    liq = estIsolatedLiqPx({ side, entryPx: entry, leverage: lev, maxLeverage: maxLev });
    if (liq == null) return null;
    const gap = side === "buy" ? (entry - liq) / entry : (liq - entry) / entry;
    if (liq === 0 || gap >= LIQ_BUFFER * dPct) break;
  }
  if (lev < 1) return null;
  const slPct = r1(dPct * lev * 100);
  const tpPct = r1(slPct * p.rr);
  if (!(slPct > 0) || !(tpPct > 0)) return null;
  const slPx = pxAt(entry, side, slPct, lev, "sl");
  const tpPx = pxAt(entry, side, tpPct, lev, "tp");
  if (!(tpPx > 0) || !(slPx > 0)) return null;
  /* The stop must sit before liquidation. */
  if (liq != null && liq > 0 && (side === "buy" ? slPx <= liq : slPx >= liq)) return null;
  const fees = fin(feeRate) && feeRate > 0 ? margin * lev * feeRate * 2 : 0;
  return {
    id: `${market.coin}-${side}-${p.label.toLowerCase()}-${Math.floor(at / 60_000)}`,
    coin: market.coin,
    side,
    label: p.label,
    leverage: lev,
    marginUsdc: margin,
    entryPx: entry,
    tpPx,
    slPx,
    tpPct,
    slPct,
    rr: r1(tpPct / slPct),
    maxLossUsdc: r2((margin * slPct) / 100 + fees),
    liqPx: liq,
    reason: `${reasonTail}stop ${p.k}× the 14-bar range.`,
  };
}

/**
 * 2–3 setups for one market from real data, or { ok:false, why } when the data is not there.
 * @param {{ market: object, candles: object[], freeUsdc?: number|null, side?: "buy"|"sell"|null, feeRate?: number|null,
 *   now?: number, profiles?: object[] }} o
 */
export function buildSetups({ market, candles, freeUsdc = null, side = null, feeRate = null, now = Date.now(), profiles = PROFILES } = {}) {
  if (!market || typeof market.coin !== "string") return { ok: false, why: "no-market" };
  const entry = entryOf(market);
  if (entry == null) return { ok: false, why: "no-price" };
  const range = rangeOf(candles);
  if (range == null) return { ok: false, why: "no-candles" };
  const trend = trendOf(candles);
  const lean = side === "buy" || side === "sell" ? side : leanSide({ trend, funding: market.funding, change24hPct: market.change24hPct });
  if (!lean) return { ok: false, why: "no-direction" };
  /* The margin: the user's free margin, under the cap and the default; unknown or empty → the default, flagged. */
  const cap = Math.min(MAX_MARGIN_USDC, DEFAULT_SETUP_MARGIN_USDC);
  const freeKnown = fin(freeUsdc);
  const margin = freeKnown && freeUsdc >= 1 ? Math.max(1, Math.min(cap, Math.floor(freeUsdc))) : cap;
  const trendWord = trend === "up" ? "1h trend up" : trend === "down" ? "1h trend down" : "1h flat";
  const fund = fin(market.funding) ? `, funding ${formatHlFunding(market.funding)}/h` : "";
  const reasonTail = `${trendWord}${fund}; `;
  const setups = profiles.map((p) => profileSetup({ market, entry, range, side: lean, margin, feeRate, p, at: now, reasonTail })).filter(Boolean);
  if (!setups.length) return { ok: false, why: "no-room" };
  return {
    ok: true,
    coin: market.coin,
    side: lean,
    trend,
    rangePct: r2((range / entry) * 100),
    marginUsdc: margin,
    fundsKnown: freeKnown,
    fundsShort: freeKnown ? freeUsdc < margin : null,
    setups,
    basis: SETUP_BASIS,
    at: now,
  };
}

/** The "setups" card (shared contract): one market's profiles, or the Balanced one of several markets (coin null). */
export function setupsCard(list, { coin = null, at = Date.now() } = {}) {
  const setups = (Array.isArray(list) ? list : []).filter(Boolean);
  return { kind: "setups", coin, setups, basis: SETUP_BASIS, at };
}

/**
 * The recommended TP / SL for a trade at the user's own leverage: the Balanced profile (stop 1.5 × range, RR 2),
 * pulled in when it would sit past half the way to liquidation. Null when the data is not there.
 */
export function recommendTpSl({ market, candles, side, leverage, entryPx = null } = {}) {
  const entry = fin(entryPx) && entryPx > 0 ? entryPx : entryOf(market);
  const range = rangeOf(candles);
  const lev = fin(leverage) && leverage >= 1 ? leverage : null;
  if (!market || entry == null || range == null || lev == null || (side !== "buy" && side !== "sell")) return null;
  let dPct = (BALANCED.k * range) / entry;
  const liq = estIsolatedLiqPx({ side, entryPx: entry, leverage: lev, maxLeverage: market.maxLeverage });
  if (liq != null && liq > 0) {
    const gap = side === "buy" ? (entry - liq) / entry : (liq - entry) / entry;
    if (gap > 0) dPct = Math.min(dPct, gap / LIQ_BUFFER);
  }
  if (!(dPct > 0)) return null;
  const slPct = r1(dPct * lev * 100);
  const tpPct = r1(slPct * BALANCED.rr);
  if (!(slPct > 0) || !(tpPct > 0)) return null;
  const tpPx = pxAt(entry, side, tpPct, lev, "tp");
  const slPx = pxAt(entry, side, slPct, lev, "sl");
  if (!(tpPx > 0) || !(slPx > 0)) return null;
  return { tpPct, slPct, rr: r1(tpPct / slPct), tpPx, slPx, recommended: true, basis: SETUP_BASIS };
}

/**
 * The recommended TP / SL for a position the user ALREADY HOLDS (the "Set TP SL" box), as ROE % from its entry — what
 * the TP / SL card and Hyperliquid take. Priced from where the market is NOW, not from the entry: a long that is down
 * more than one stop distance would otherwise get a stop above the mark (it fires at once, and the card's own editor
 * refuses it). So, for a long (a short mirrors it):
 *   stop  one Balanced distance (1.5 × the 1h range) under the lower of entry and mark, pulled in to at most half the
 *         way to liquidation: always under the mark, under the entry (a loss, as an SL is), and before liquidation;
 *   TP    RR 2 of that distance over the higher of entry and mark: always over the mark and over the entry (a profit).
 * Null when the data is not there, or when there is no room before liquidation.
 * rr: the reward the TP aims at, in stop distances (default the Balanced 2; an analysis asks for less against the
 * trend, more with it). minStop: the least distance (price units) the stop keeps from the mark (an analysis passes
 * half the daily range, so a normal day does not hit it); when liquidation leaves less room than that, the stop takes
 * what room there is and the answer says belowFloor.
 */
export function recommendHeldTpSl({ market, candles, side, leverage, entryPx, markPx = null, liqPx = null, rr = BALANCED.rr, minStop = 0 } = {}) {
  const lev = fin(leverage) && leverage >= 1 ? leverage : null;
  const entry = fin(entryPx) && entryPx > 0 ? entryPx : null;
  const mark = fin(markPx) && markPx > 0 ? markPx : market && fin(market.markPx) && market.markPx > 0 ? market.markPx : entryOf(market);
  const range = rangeOf(candles);
  if (!market || entry == null || mark == null || range == null || lev == null || (side !== "buy" && side !== "sell")) return null;
  const buy = side === "buy";
  const low = Math.min(entry, mark);
  const high = Math.max(entry, mark);
  let d = BALANCED.k * range;
  /* The floor is measured from the mark; d is measured from the lower of entry and mark (a long), so a long in
     profit already keeps its distance from the mark plus d. */
  const floor = fin(minStop) && minStop > 0 ? Math.max(0, minStop - (buy ? mark - low : high - mark)) : 0;
  d = Math.max(d, floor);
  const liq = fin(liqPx) && liqPx > 0 ? liqPx : estIsolatedLiqPx({ side, entryPx: entry, leverage: lev, maxLeverage: market.maxLeverage });
  if (liq != null && liq > 0) {
    const room = buy ? low - liq : liq - high;
    if (!(room > 0)) return null;
    d = Math.min(d, room / LIQ_BUFFER);
  }
  if (!(d > 0)) return null;
  const belowFloor = floor > 0 && d < floor * 0.999;
  const slPx0 = buy ? low - d : high + d;
  const want = fin(rr) && rr > 0 ? rr : BALANCED.rr;
  const tpPx0 = buy ? high + want * d : low - want * d;
  if (!(slPx0 > 0) || !(tpPx0 > 0)) return null;
  /* ROE % from the entry (what the card takes), to 0.1, and the prices again from the rounded ROE (the box and the
     card print the same prices). A rounding that would carry a leg across the mark goes the other way. */
  const roe = (px) => (Math.abs(px - entry) / entry) * lev * 100;
  const wrongSide = (leg, px) => (leg === "sl" ? (buy ? px >= mark : px <= mark) : (buy ? px <= mark : px >= mark));
  const legOf = (leg, px0) => {
    let pct = r1(roe(px0));
    let px = pxAt(entry, side, pct, lev, leg);
    if (wrongSide(leg, px)) {
      /* Up: a larger ROE moves either leg away from the entry, so away from the mark. */
      pct = Math.ceil(roe(px0) * 10) / 10;
      px = pxAt(entry, side, pct, lev, leg);
    }
    return { pct, px };
  };
  const sl = legOf("sl", slPx0);
  const tp = legOf("tp", tpPx0);
  const slPct = sl.pct;
  const tpPct = tp.pct;
  const slPx = sl.px;
  const tpPx = tp.px;
  if (!(slPct > 0) || !(tpPct > 0) || !(slPx > 0) || !(tpPx > 0)) return null;
  if (buy ? slPx >= mark || tpPx <= mark : slPx <= mark || tpPx >= mark) return null;
  if (liq != null && liq > 0 && (buy ? slPx <= liq : slPx >= liq)) return null;
  return { tpPct, slPct, rr: r1(tpPct / slPct), tpPx, slPx, recommended: true, basis: SETUP_BASIS, ...(belowFloor ? { belowFloor: true } : {}) };
}

/**
 * An open card with the recommended TP / SL filled in when the user gave neither (a TP / SL the user typed always
 * wins: then the card is returned as it was). Flag: recommended:true, with the RR.
 */
export function withRecommendedTpSl(card, { market, candles } = {}) {
  if (!card || card.kind !== "open" || card.tpPct != null || card.slPct != null) return card;
  const rec = recommendTpSl({ market, candles, side: card.side, leverage: card.leverage });
  if (!rec) return card;
  return { ...card, tpPct: rec.tpPct, slPct: rec.slPct, recommended: true, rr: rec.rr };
}

/**
 * The normal trade card a chosen setup becomes (it never sends: the card waits for Confirm). The caps are applied
 * again here, in code, whatever the setup says: a SETUP's own (SETUP_MAX_LEVERAGE, 3x: an object saved by an older
 * build, or any setup over it, never becomes a 5x–10x card tagged Recommended), FlowFlow's margin cap, and the
 * market's maximum.
 */
export function setupToOpenCard(setup, { market = null } = {}) {
  if (!setup || typeof setup.coin !== "string" || (setup.side !== "buy" && setup.side !== "sell")) return null;
  const maxLev = Math.min(SETUP_MAX_LEVERAGE, market && fin(market.maxLeverage) && market.maxLeverage >= 1 ? market.maxLeverage : SETUP_MAX_LEVERAGE);
  const lev = fin(setup.leverage) ? Math.max(1, Math.min(Math.floor(setup.leverage), Math.floor(maxLev))) : null;
  const margin = fin(setup.marginUsdc) && setup.marginUsdc > 0 ? Math.min(setup.marginUsdc, MAX_MARGIN_USDC) : null;
  if (lev == null || margin == null) return null;
  return {
    kind: "open",
    coin: setup.coin,
    side: setup.side,
    marginUsdc: margin,
    leverage: lev,
    tpPct: fin(setup.tpPct) ? Math.abs(setup.tpPct) : null,
    slPct: fin(setup.slPct) ? Math.abs(setup.slPct) : null,
    status: "review",
    recommended: true,
    rr: fin(setup.rr) ? setup.rr : null,
    setupId: typeof setup.id === "string" ? setup.id : null,
    setupLabel: typeof setup.label === "string" ? setup.label : null,
  };
}

/** The setups a model reads (small, rounded). */
export function setupsForModel(card) {
  return (card && Array.isArray(card.setups) ? card.setups : []).map((s) => ({
    /* The ticker ("TSLA"), never a venue-qualified id the model would repeat. */
    coin: agentTicker(s.coin), side: s.side === "buy" ? "long" : "short", label: s.label, leverage: s.leverage, margin_usdc: s.marginUsdc,
    tp_roe_pct: s.tpPct, sl_roe_pct: s.slPct, rr: s.rr, max_loss_usdc: s.maxLossUsdc,
  }));
}

/** The coins the account holds a position on (one position per market: a new setup there would collide with it). */
export function heldCoins(backend) {
  const acc = backend && backend.connected && backend.account ? backend.account : null;
  const list = acc && acc.positions && acc.positions.answered ? acc.positions.list || [] : [];
  return new Set(list.filter((p) => p && typeof p.coin === "string" && fin(p.szi) && p.szi !== 0).map((p) => p.coin));
}

/**
 * The markets worth a setup when the user named none: the market in focus, the biggest mover among the most traded,
 * then the most traded markets. Distinct, live (price known), at most n. A market the account already holds is never
 * a candidate (Hyperliquid keeps one position per market: its box offers TP / SL or Close instead).
 */
export function setupCandidates(snapshot, backend = null, { focus = [], n = 3 } = {}) {
  const byCoin = (snapshot && snapshot.byCoin) || {};
  const main = mainMarkets((snapshot && snapshot.markets) || []).filter((m) => entryOf(m) != null);
  const held = heldCoins(backend);
  const ok = (c) => typeof c === "string" && byCoin[c] && !byCoin[c].isHip3 && entryOf(byCoin[c]) != null && !held.has(c);
  const out = [];
  const add = (c) => { if (out.length < n && ok(c) && !out.includes(c)) out.push(c); };
  (Array.isArray(focus) ? focus : []).slice(0, 1).forEach(add);
  const movers = topMovers(main, 3);
  if (movers.length) add(movers[0].coin);
  [...main].sort((a, b) => (fin(b.dayNtlVlm) ? b.dayNtlVlm : 0) - (fin(a.dayNtlVlm) ? a.dayNtlVlm : 0)).forEach((m) => add(m.coin));
  return out;
}
