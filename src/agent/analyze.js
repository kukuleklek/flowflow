// ANALYZE ONE MARKET (owner, 2026-10-15: "Position ที่แนะนำ ไม่เห็นมีปุ่ม Try to analytic with Tokenomist Logo อะ แล้วกด
// เข้าไป ช่วยคิด Downtrend หรือ มันจะ Uptrend วันไหน Emission เป็นไง เสี่ยงอะไรไหม ไรงี้ RR ควรเปลี่ยนเท่าไหร่"): the ONE compact
// "analysis" card the Analyze pill answers with (and the model's get_analysis reads).
//
//   trend     up / down / range on 1h, 4h and 1d. Three signals per timeframe: the 21-EMA's slope over the last 5 bars
//             (it counts when the EMA moved at least half an average bar range), where the close sits against the EMA
//             (a quarter of a range away or more), and the swing structure (the last two swing highs and lows: higher
//             highs and higher lows, or lower highs and lower lows). Two signals agree and none disagrees: that
//             direction. Anything else is a range.
//   flip      the price levels that would turn the 4h trend: a downtrend turns up above its last swing high (a
//             lower high), an uptrend turns down below its last swing low (a higher low), a range breaks at its edges
//             (the outer of its last two swing highs / lows, else the 20-bar high / low). A level already passed falls
//             back to the 4h 21-EMA. LEVELS, NEVER DATES: how far a level is is said in typical 4h ranges (ATR).
//   emission  Tokenomist, only with the key on and a coin it covers: the next unlock (date, days away, % of
//             circulating, USD at the live price) and the monthly emission pace (new supply a month, % of
//             circulating). Off or not covered: nulls and a short note, and nothing claims Tokenomist data.
//   risks     funding (who pays, per hour), liquidation distance (in typical daily ranges), unlock overhang,
//             volatility (the daily ATR), thin 24h volume. Each low / medium / high in ≤ 10 words.
//   rr        what the setup (or the held position's TP / SL) is now, and what the data suggests: against the 4h / 1d
//             trend a nearer TP (RR 1.5) and one step less leverage; with both a further TP (RR + 0.5, at most 3);
//             in a range the TP at the range's edge when that edge is at least one stop away (else the entry itself
//             sits at the edge, and that is what the card says); high funding against the side, a big unlock under
//             a long, or high volatility: one step less leverage each. The suggested setup goes through the setups'
//             caps again (≤ 3x, ≤ 20 USDC margin, liquidation at least LIQ_BUFFER stops away). A leg it does not move
//             keeps the setup's own price. A HELD position gets a TP / SL card for it, never a new or opposite
//             position: the user's own legs stay whenever they are better, the stop never sits closer to the mark than
//             half a daily range (MIN_STOP_D1), and nothing that does not raise the RR from the mark is offered.
//
// 🔴 ONLY REAL DATA: the live market row, the candles, Tokenomist and the account. Unknown is null (the card prints a
// dash), never 0. Every reader is injected, so the Node suite runs this with fakes. Nothing here signs, sends or moves
// money: the adjusted setup becomes a normal trade card only through setupToOpenCard, and that card waits for Confirm.
import { cleanCandles, buildSetups, recommendHeldTpSl, setupToOpenCard, LIQ_BUFFER, SETUP_MAX_LEVERAGE, SETUP_BARS } from "./setups.js";
import { estIsolatedLiqPx } from "../perp/perpTicket.js";
import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { unlocksView } from "../lib/tokenomist/client.js";
import { isCovered, tokenSymbolOf } from "../lib/tokenomist/slugs.js";
import { formatHlPrice, formatHlPct, formatHlUsdCompact } from "../lib/hyperliquid/format.js";
import { coreSessionCandles } from "../lib/hyperliquid/hip3/hours.js";
import { isStockCoin, stockKind, usSessionView, analysisRow, statusText, agentTicker, stockDisplayName } from "./stockWords.js";

/** 1h bars a STOCK's analysis reads: a week, so its setups still find 14 bars inside US market hours. */
export const STOCK_ANALYSIS_H1_BARS = 168;

/**
 * A stock's emission row: no Tokenomist (a share has no token unlocks); the row is the US market's state instead
 * (owner item 2: "US market: open / closed (opens in Xh)"), from hip3/hours.js through stockWords.js.
 */
export function stockMarketRow(coin, now = Date.now()) {
  const view = usSessionView(now, stockKind(coin) === "index" ? "index" : "stock");
  return {
    stock: true, configured: false, covered: false,
    state: view.state || null,
    usMarket: { en: analysisRow(view, "en"), th: analysisRow(view, "th") },
    status: { en: statusText(view, { lang: "en" }), th: statusText(view, { lang: "th" }) },
  };
}

/** The timeframes read: 1h shares the setups' own read (same bars, same cache entry), 4h about 15 days, 1d 3 months. */
export const ANALYSIS_FRAMES = Object.freeze([
  Object.freeze({ key: "h1", interval: "1h", bars: SETUP_BARS }),
  Object.freeze({ key: "h4", interval: "4h", bars: 90 }),
  Object.freeze({ key: "d1", interval: "1d", bars: 90 }),
]);
export const ANALYSIS_BASIS = "Hyperliquid candles 1h·4h·1d";
export const FLIP_BASIS = "4h swing";
export const EMA_BARS = 21;
export const SLOPE_BARS = 5;
export const ATR_BARS = 14;
/** A swing high / low is the extreme of this many bars on each side. */
export const PIVOT_BARS = 2;
export const MIN_TREND_BARS = EMA_BARS + SLOPE_BARS;
/** The EMA's slope counts when it moved at least this many average ranges over SLOPE_BARS. */
export const SLOPE_MIN_ATR = 0.5;
/** The close counts as above / below the EMA at least this many average ranges away. */
export const SIDE_MIN_ATR = 0.25;
/** A range's edges, when it has no two swings to read them from. */
export const EDGE_BARS = 20;
/** The unlock window read, in days. */
export const UNLOCK_DAYS = 90;
export const DAYS_PER_MONTH = 30.44;
/** RR targets the suggestion moves to: against the higher trend, and at most with it. */
export const RR_AGAINST = 1.5;
export const RR_WITH_STEP = 0.5;
export const RR_MAX = 3;
/** A held position's suggested stop keeps at least this many daily ranges (1d ATR) from the mark. */
export const MIN_STOP_D1 = 0.5;

/** Grading (percent): funding per hour the side pays, daily ATR, the next unlock's share of circulating, monthly
 *  emission, and 24h volume (USD). */
export const GRADE = Object.freeze({
  fundingMedium: 0.005, fundingHigh: 0.02,
  atrD1Medium: 5, atrD1High: 9,
  atrH1Medium: 1, atrH1High: 2,
  unlockMedium: 0.5, unlockHigh: 2, unlockSoonDays: 30, unlockHighDays: 14,
  monthlyMedium: 0.5, monthlyHigh: 2,
  liqHighRanges: 1.5, liqMediumRanges: 3, liqHighPct: 5, liqMediumPct: 12,
  volumeHighUsd: 1e6, volumeMediumUsd: 1e7,
});

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
/* Prices without float noise (Hyperliquid prices carry at most 5 significant figures; 6 keeps them exact). */
const sig = (v) => (fin(v) ? Number(v.toPrecision(6)) : null);
const RANK = { low: 0, medium: 1, high: 2 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/* ── trend math (pure) ──────────────────────────────────────────────────────────────────────────────────────── */

/** The EMA of a series, seeded with the simple average of its first n values; null before that. */
export function emaSeries(values, n = EMA_BARS) {
  const xs = Array.isArray(values) ? values : [];
  const out = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  const k = 2 / (n + 1);
  let e = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < xs.length; i++) {
    e = xs[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** The average true range of the last n bars (price units), or null with too few bars. */
export function atrOf(candles, n = ATR_BARS) {
  const bars = cleanCandles(candles);
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }
  const atr = sum / n;
  return atr > 0 ? atr : null;
}

/** Swing highs and lows: a bar whose high (low) is the extreme of PIVOT_BARS bars on each side, oldest first. */
export function swingPoints(candles, p = PIVOT_BARS) {
  const bars = cleanCandles(candles);
  const highs = [];
  const lows = [];
  for (let i = p; i < bars.length - p; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - p; j <= i + p && (hi || lo); j++) {
      if (j === i) continue;
      /* Strictly beyond the bars before it, at least level with the bars after it (a flat top counts once). */
      if (j < i ? bars[j].high >= bars[i].high : bars[j].high > bars[i].high) hi = false;
      if (j < i ? bars[j].low <= bars[i].low : bars[j].low < bars[i].low) lo = false;
    }
    if (hi) highs.push({ i, px: bars[i].high });
    if (lo) lows.push({ i, px: bars[i].low });
  }
  return { highs, lows };
}

/** "up" (higher highs and higher lows), "down" (lower highs and lower lows), "mixed", or null with fewer than two of each. */
export function structureOf({ highs = [], lows = [] } = {}) {
  if (highs.length < 2 || lows.length < 2) return null;
  const [h1, h2] = highs.slice(-2).map((x) => x.px);
  const [l1, l2] = lows.slice(-2).map((x) => x.px);
  if (h2 > h1 && l2 > l1) return "up";
  if (h2 < h1 && l2 < l1) return "down";
  return "mixed";
}

function noteOf(dir, structure, slope) {
  if (dir === "up") return structure === "up" ? "Higher highs, higher lows" : "Above a rising average";
  if (dir === "down") return structure === "down" ? "Lower highs, lower lows" : "Below a falling average";
  return slope === 0 ? "Flat average, sideways" : "Mixed signals, no clear side";
}

/**
 * One timeframe's trend, or null with fewer than MIN_TREND_BARS bars.
 * @returns {{ dir: "up"|"down"|"range", emaSlopePct: number, note: string, atrPct: number, close: number, ema: number,
 *   structure: string|null, highs: number[], lows: number[], recentHigh: number, recentLow: number } | null}
 *   highs / lows: the last two swing highs / lows (oldest first)
 */
export function frameTrend(candles) {
  const bars = cleanCandles(candles);
  if (bars.length < MIN_TREND_BARS) return null;
  const closes = bars.map((c) => c.close);
  const ema = emaSeries(closes);
  const e = ema[ema.length - 1];
  const e0 = ema[ema.length - 1 - SLOPE_BARS];
  const close = closes[closes.length - 1];
  const atr = atrOf(bars);
  if (!(e > 0) || !(e0 > 0) || !(close > 0) || atr == null) return null;
  const slopePct = ((e - e0) / e0) * 100;
  const atrPct = (atr / close) * 100;
  const slope = Math.abs(slopePct) >= SLOPE_MIN_ATR * atrPct ? Math.sign(slopePct) : 0;
  const side = Math.abs(close - e) >= SIDE_MIN_ATR * atr ? Math.sign(close - e) : 0;
  const sw = swingPoints(bars);
  const structure = structureOf(sw);
  const score = slope + side + (structure === "up" ? 1 : structure === "down" ? -1 : 0);
  const dir = score >= 2 ? "up" : score <= -2 ? "down" : "range";
  const recent = bars.slice(-EDGE_BARS);
  return {
    dir,
    emaSlopePct: r2(slopePct),
    note: noteOf(dir, structure, slope),
    atrPct: r2(atrPct),
    close,
    ema: e,
    structure,
    highs: sw.highs.slice(-2).map((x) => x.px),
    lows: sw.lows.slice(-2).map((x) => x.px),
    recentHigh: Math.max(...recent.map((c) => c.high)),
    recentLow: Math.min(...recent.map((c) => c.low)),
  };
}

/** What the card keeps of a timeframe: { dir, emaSlopePct, note, atrPct }, or null. */
export const trendEntry = (t) => (t ? { dir: t.dir, emaSlopePct: t.emaSlopePct, note: t.note, atrPct: t.atrPct } : null);

/**
 * The levels that would turn the 4h trend (see the head of this file), with how far they are from the price (%) and
 * the 4h ATR (% of price) to say that distance in typical 4h ranges. Nulls when unknown or not a flip.
 */
export function flipLevels(t4, price) {
  const out = { upAbove: null, downBelow: null, basis: FLIP_BASIS, upPct: null, downPct: null, atrPct: t4 ? t4.atrPct : null };
  if (!t4 || !fin(price) || price <= 0) return out;
  const highs = Array.isArray(t4.highs) ? t4.highs.filter(fin) : [];
  const lows = Array.isArray(t4.lows) ? t4.lows.filter(fin) : [];
  const range = t4.dir === "range";
  const up = range ? (highs.length >= 2 ? Math.max(...highs) : t4.recentHigh) : highs.length ? highs[highs.length - 1] : null;
  const down = range ? (lows.length >= 2 ? Math.min(...lows) : t4.recentLow) : lows.length ? lows[lows.length - 1] : null;
  const pick = (list, ok) => list.find((v) => fin(v) && ok(v));
  if (t4.dir !== "up") out.upAbove = sig(pick([up, range ? null : t4.ema], (v) => v > price) ?? null);
  if (t4.dir !== "down") out.downBelow = sig(pick([down, range ? null : t4.ema], (v) => v < price) ?? null);
  if (out.upAbove != null) out.upPct = r2((out.upAbove / price - 1) * 100);
  if (out.downBelow != null) out.downPct = r2((1 - out.downBelow / price) * 100);
  return out;
}

/* ── emission (Tokenomist) ──────────────────────────────────────────────────────────────────────────────────── */

/** New supply a month as % of circulating, from weekly emission rows; null when either is unknown. */
export function monthlyEmissionPct({ weeks, circulatingSupply } = {}) {
  const circ = fin(circulatingSupply) && circulatingSupply > 0 ? circulatingSupply : null;
  const known = (Array.isArray(weeks) ? weeks : []).filter((w) => w && fin(w.amount) && w.amount >= 0);
  if (circ == null || !known.length) return null;
  const total = known.reduce((s, w) => s + w.amount, 0);
  return r2((((total / (known.length * 7)) * DAYS_PER_MONTH) / circ) * 100);
}

const coveredCoin = (coin) => {
  if (typeof coin !== "string" || !coin || coin.includes(":")) return false;
  try { return isCovered(coin); } catch { return false; }
};

const NOTE = {
  off: "Tokenomist not connected",
  uncovered: (sym) => `No Tokenomist data for ${sym}`,
  error: "Couldn't read unlocks right now",
  none: (days) => `No scheduled unlock in ${days} days`,
};

/** A promise's answer, or null when it rejects or takes longer than ms. */
function settle(p, ms) {
  let t = null;
  return Promise.race([
    Promise.resolve(p).catch(() => null).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); }),
  ]);
}

/**
 * The emission row. Key off (tokenomistOn false) or a coin Tokenomist does not cover: no read at all, nulls and a
 * note. On: the unlocks (and, when a reader is given, the weekly emission) for the next UNLOCK_DAYS.
 */
export async function emissionOf({ coin, market = null, tokenomistOn = false, readUnlocks = null, readEmission = null, now = Date.now(), timeoutMs = 12_000 } = {}) {
  const covered = coveredCoin(coin);
  const sym = tokenSymbolOf(coin) || coin;
  const base = { configured: !!tokenomistOn, covered, nextUnlock: null, monthlyPct: null, url: null, note: null };
  if (!tokenomistOn || typeof readUnlocks !== "function") return { ...base, configured: false, note: NOTE.off };
  if (!covered) return { ...base, note: NOTE.uncovered(sym) };
  const [rawU, rawE] = await Promise.all([
    settle(readUnlocks(coin, { days: UNLOCK_DAYS }), timeoutMs),
    typeof readEmission === "function" ? settle(readEmission(coin, { days: UNLOCK_DAYS }), timeoutMs) : Promise.resolve(null),
  ]);
  const v = unlocksView(rawU || { configured: true, error: "unavailable", coin }, { coin, market, now, days: UNLOCK_DAYS }).card;
  if (v.configured === false) return { ...base, configured: false, note: NOTE.off };
  if (v.covered === false) return { ...base, covered: false, note: NOTE.uncovered(sym) };
  const circ = rawU && rawU.token && fin(rawU.token.circulatingSupply) ? rawU.token.circulatingSupply : null;
  const okE = rawE && rawE.configured !== false && rawE.covered !== false && !rawE.error;
  const monthlyPct = okE ? monthlyEmissionPct({ weeks: rawE.weeks, circulatingSupply: circ }) : null;
  if (v.error) return { ...base, url: v.url, monthlyPct, error: v.error, note: NOTE.error };
  const n = v.next;
  return {
    ...base,
    nextUnlock: n ? { date: n.date, inDays: n.inDays, pctCirculating: n.pctCirculating, usd: n.usd, amount: n.amount } : null,
    monthlyPct,
    url: v.url,
    updatedAt: v.updatedAt,
    note: n ? null : NOTE.none(v.windowDays),
  };
}

/* ── risks (pure) ───────────────────────────────────────────────────────────────────────────────────────────── */

const SIDE_WORD = { buy: "long", sell: "short" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The risks, worst first. Each { id, level: "low"|"medium"|"high", text (≤ 10 words) }; a risk with no data is left out.
 * @param {{ market?: object, side?: "buy"|"sell"|null, refPx?: number|null, liqPx?: number|null, atrD1Pct?: number|null,
 *   atrH1Pct?: number|null, emission?: object|null }} o refPx / liqPx: the entry (a setup) or the mark (a position) and
 *   its liquidation price
 */
export function gradeRisks({ market = null, side = null, refPx = null, liqPx = null, atrD1Pct = null, atrH1Pct = null, emission = null } = {}) {
  const out = [];
  const mine = SIDE_WORD[side] || null;
  /* Funding: Hyperliquid's rate is a fraction per hour; positive, longs pay shorts. */
  const f = market && fin(market.funding) ? market.funding : null;
  if (f != null) {
    const pct = Math.abs(f) * 100;
    const rate = `${pct.toFixed(4)}%/h`;
    const payer = f > 0 ? "long" : f < 0 ? "short" : null;
    if (!payer) out.push({ id: "funding", level: "low", text: "No funding cost right now" });
    else if (mine && mine !== payer) out.push({ id: "funding", level: "low", text: `Funding pays ${mine}s ${rate}` });
    else out.push({ id: "funding", level: pct >= GRADE.fundingHigh ? "high" : pct >= GRADE.fundingMedium ? "medium" : "low", text: `${cap(payer)}s pay ${rate} funding` });
  }
  /* Liquidation: how far, in typical daily ranges when the daily ATR is known. */
  if (fin(refPx) && refPx > 0 && fin(liqPx)) {
    if (liqPx <= 0) out.push({ id: "liq", level: "low", text: "No liquidation unless the price nears zero" });
    else {
      const gap = (side === "sell" ? liqPx - refPx : side === "buy" ? refPx - liqPx : Math.abs(refPx - liqPx)) / refPx * 100;
      if (gap > 0) {
        const ranges = fin(atrD1Pct) && atrD1Pct > 0 ? gap / atrD1Pct : null;
        const level = ranges != null
          ? (ranges < GRADE.liqHighRanges ? "high" : ranges < GRADE.liqMediumRanges ? "medium" : "low")
          : (gap < GRADE.liqHighPct ? "high" : gap < GRADE.liqMediumPct ? "medium" : "low");
        out.push({ id: "liq", level, text: `Liquidation ${gap.toFixed(1)}% away${ranges != null ? `, ≈${r1(ranges)} daily ranges` : ""}` });
      } else {
        out.push({ id: "liq", level: "high", text: "At or past the liquidation price" });
      }
    }
  }
  /* Unlock overhang: the next unlock's size and nearness, and the monthly emission pace. */
  if (emission && emission.configured && emission.covered && !emission.error) {
    const n = emission.nextUnlock;
    let level = "low";
    let text = null;
    if (n && fin(n.pctCirculating) && fin(n.inDays) && n.inDays <= GRADE.unlockSoonDays) {
      level = n.pctCirculating >= GRADE.unlockHigh && n.inDays <= GRADE.unlockHighDays ? "high"
        : n.pctCirculating >= GRADE.unlockMedium ? "medium" : "low";
      text = `Unlock of ${r1(n.pctCirculating)}% supply in ${n.inDays}d`;
    }
    if (fin(emission.monthlyPct)) {
      const lv = emission.monthlyPct >= GRADE.monthlyHigh ? "high" : emission.monthlyPct >= GRADE.monthlyMedium ? "medium" : "low";
      if (!text || RANK[lv] > RANK[level]) { text = `Supply grows ${r1(emission.monthlyPct)}% a month`; level = worse(lv, level); }
    }
    if (!text) text = n && fin(n.inDays) ? `Next unlock in ${n.inDays}d` : `No scheduled unlock in ${UNLOCK_DAYS} days`;
    out.push({ id: "unlock", level, text });
  }
  /* Volatility: the typical daily range (the hourly one when the daily chart is short). */
  if (fin(atrD1Pct)) {
    out.push({ id: "volatility", level: atrD1Pct >= GRADE.atrD1High ? "high" : atrD1Pct >= GRADE.atrD1Medium ? "medium" : "low", text: `Typical daily range ${r1(atrD1Pct)}%` });
  } else if (fin(atrH1Pct)) {
    out.push({ id: "volatility", level: atrH1Pct >= GRADE.atrH1High ? "high" : atrH1Pct >= GRADE.atrH1Medium ? "medium" : "low", text: `Typical hourly range ${r1(atrH1Pct)}%` });
  }
  /* Volume: thin books move hard and fill worse. */
  const vol = market && fin(market.dayNtlVlm) ? market.dayNtlVlm : null;
  if (vol != null) {
    const level = vol < GRADE.volumeHighUsd ? "high" : vol < GRADE.volumeMediumUsd ? "medium" : "low";
    out.push({ id: "volume", level, text: `${level === "high" ? "Thin: " : ""}${formatHlUsdCompact(vol)} traded in 24h` });
  }
  return out.map((r, i) => ({ r, i })).sort((a, b) => RANK[b.r.level] - RANK[a.r.level] || a.i - b.i).map((x) => x.r);
}

/* ── RR: the suggestion (pure) ──────────────────────────────────────────────────────────────────────────────── */

/* The price at an ROE % on a leverage (setups.js prices the same way): a move of roe / lev percent. */
const pxAt = (entry, side, roePct, lev, toward) => {
  const move = roePct / 100 / lev;
  const up = (side === "buy") === (toward === "tp");
  return up ? entry * (1 + move) : entry * (1 - move);
};
const maxLevOf = (market) => Math.max(1, Math.min(AGENT_MAX_LEVERAGE, market && fin(market.maxLeverage) && market.maxLeverage >= 1 ? market.maxLeverage : AGENT_MAX_LEVERAGE));
const TF_NAME = { h4: "4h", d1: "1d" };

/* Which way the 4h / 1d trends lean against a side: "against", "with" (both, and the 1h not against), or "range". */
function trendFit(trend, side) {
  const want = side === "buy" ? "up" : "down";
  const opp = side === "buy" ? "down" : "up";
  const t = trend || {};
  const against = ["h4", "d1"].filter((k) => t[k] && t[k].dir === opp);
  if (against.length) return { fit: "against", names: against.map((k) => TF_NAME[k]).join(" and ") };
  if (t.h4 && t.d1 && t.h4.dir === want && t.d1.dir === want && !(t.h1 && t.h1.dir === opp)) return { fit: "with", names: "4h and 1d" };
  return { fit: "range", names: "4h" };
}

/* The risks that take a step of leverage off: high funding the side pays, a big unlock soon under a long, high
   volatility. */
function levCuts(risks, side) {
  const list = Array.isArray(risks) ? risks : [];
  const high = (id) => list.find((r) => r && r.id === id && r.level === "high") || null;
  const out = [];
  if (high("funding")) out.push("high funding");
  const unlock = high("unlock");
  if (unlock && side === "buy") out.push(/^Supply grows/.test(unlock.text || "") ? "fast emission" : "unlock soon");
  if (high("volatility")) out.push("high volatility");
  return out;
}

/**
 * The suggested change to a setup (setups.js shape), from the trends, the 4h flip levels and the risks. Never raises
 * leverage, never past the setups' caps, the stop always before liquidation (LIQ_BUFFER stops away). The stop stays
 * where the chart put it; a TP the suggestion does not move keeps the setup's own price.
 * @returns {{ suggested: { side, lev, entry, tp, sl, rr, why, moved: { tp, sl, lev } }, adjustedSetup: object|null } | null}
 *   adjustedSetup is null when nothing changes (suggested then repeats the setup, keep: true, why "Keep it…")
 */
export function adjustSetup({ setup, market, trend = null, flip = null, risks = [], feeRate = null, now = Date.now() } = {}) {
  if (!setup || !market || (setup.side !== "buy" && setup.side !== "sell")) return null;
  const side = setup.side;
  const buy = side === "buy";
  const entry = fin(setup.entryPx) && setup.entryPx > 0 ? setup.entryPx : null;
  if (entry == null || !fin(setup.slPx) || !fin(setup.tpPx)) return null;
  const slDist = buy ? entry - setup.slPx : setup.slPx - entry;
  const tpDist0 = buy ? setup.tpPx - entry : entry - setup.tpPx;
  if (!(slDist > 0) || !(tpDist0 > 0)) return null;
  const maxLev = Math.floor(Math.min(SETUP_MAX_LEVERAGE, maxLevOf(market)));
  /* The leverage it carries now (a trade card the user typed may carry up to the Agent's 10x); the suggestion starts
     from the setups' cap. */
  const levNow = fin(setup.leverage) && setup.leverage >= 1 ? Math.floor(setup.leverage) : null;
  const lev0 = levNow != null ? Math.max(1, Math.min(levNow, maxLev)) : null;
  const margin = fin(setup.marginUsdc) && setup.marginUsdc > 0 ? Math.min(setup.marginUsdc, MAX_MARGIN_USDC) : null;
  if (lev0 == null || margin == null) return null;
  const rr0 = tpDist0 / slDist;
  const current = { side, lev: levNow, entry, tp: setup.tpPx, sl: setup.slPx, rr: fin(setup.rr) ? setup.rr : r1(rr0) };

  const { fit, names } = trendFit(trend, side);
  let rr = rr0;
  let lev = lev0;
  let head = null;
  let edgeNote = null;
  if (fit === "against") {
    if (rr0 > RR_AGAINST + 0.05) rr = RR_AGAINST;
    if (lev0 > 1) lev = lev0 - 1;
    if (rr !== rr0 || lev !== lev0) head = `Against the ${names} trend: ${[rr !== rr0 ? "nearer TP" : null, lev !== lev0 ? "less leverage" : null].filter(Boolean).join(", ")}`;
  } else if (fit === "with") {
    const want = Math.min(RR_MAX, r1(rr0 + RR_WITH_STEP));
    if (want > rr0 + 0.05) { rr = want; head = "4h and 1d trends agree: room for a further TP"; }
  } else {
    /* A range (or no clear higher trend): the TP at the 4h range's edge on the setup's side, but only when that edge
       is at least one stop away. Nearer than that, a TP "at the top" would sit past the top (RR under 1 is never
       offered): the entry itself is at the edge, and that is what the card says. */
    const edge = flip ? (buy ? flip.upAbove : flip.downBelow) : null;
    const edgeDist = fin(edge) ? (buy ? edge - entry : entry - edge) : null;
    if (edgeDist != null && edgeDist > 0 && edgeDist < tpDist0 * 0.95) {
      if (edgeDist / slDist >= 1) {
        rr = edgeDist / slDist;
        head = `4h range: TP at the range ${buy ? "top" : "bottom"}`;
      } else {
        edgeNote = `the entry is near the 4h range ${buy ? "top" : "bottom"}`;
      }
    }
  }
  const cuts = levCuts(risks, side);
  if (cuts.length) lev = Math.max(1, lev - cuts.length);
  /* The liquidation price at least LIQ_BUFFER stops away (the setups' own rule), lowering leverage until it is. */
  let liq = null;
  for (; lev >= 1; lev--) {
    liq = estIsolatedLiqPx({ side, entryPx: entry, leverage: lev, maxLeverage: market.maxLeverage });
    if (liq == null) return null;
    const gap = buy ? (entry - liq) / entry : (liq - entry) / entry;
    if (liq === 0 || gap >= LIQ_BUFFER * (slDist / entry)) break;
  }
  if (lev < 1) return null;
  const slPct = r1((slDist / entry) * lev * 100);
  const tpPct = r1(slPct * rr);
  if (!(slPct > 0) || !(tpPct > 0)) return null;
  /* The stop never moves here, and a TP the suggestion keeps keeps its price: re-rounding the ROE at another leverage
     would drift either by a few cents, and the card would draw that as a change. */
  const tpMoved = rr !== rr0;
  const tpPx = tpMoved ? pxAt(entry, side, tpPct, lev, "tp") : setup.tpPx;
  const slPx = setup.slPx;
  if (!(tpPx > 0) || !(slPx > 0) || (liq != null && liq > 0 && (buy ? slPx <= liq : slPx >= liq))) return null;
  const rrNew = tpMoved ? r1(tpPct / slPct) : current.rr;
  const changed = lev !== levNow || tpMoved || !fin(setup.tpPct) || !fin(setup.slPct) || Math.abs(tpPct - setup.tpPct) >= 0.1 || Math.abs(slPct - setup.slPct) >= 0.1;
  if (!changed) {
    const t = trend || {};
    const keep = edgeNote ? `Keep it: ${edgeNote}`
      : !t.h4 && !t.d1 ? "Not enough 4h / 1d data to change it"
        : fit === "against" ? `Against the ${names} trend, already at its safest`
          : fit === "with" ? "Trends agree: it already fits"
            : "Keep it: the trend and risks fit this setup";
    return { suggested: { ...current, why: keep, keep: true, moved: { tp: false, sl: false, lev: false } }, adjustedSetup: null };
  }
  const levWhy = lev < lev0 && cuts.length ? `less leverage: ${cuts.join(", ")}`
    : levNow > maxLev ? `a suggested setup stays at ${maxLev}x or less`
      : lev < lev0 && !head ? "less leverage to keep liquidation far" : null;
  const why = [head, levWhy, edgeNote].filter(Boolean).join("; ") || "Re-priced from the live data";
  const fees = fin(feeRate) && feeRate > 0 ? margin * lev * feeRate * 2 : 0;
  const adjusted = {
    id: `${setup.coin}-${side}-adjusted-${Math.floor((fin(now) ? now : Date.now()) / 60_000)}`,
    coin: setup.coin,
    side,
    label: "Adjusted",
    basedOn: typeof setup.label === "string" ? setup.label : null,
    leverage: lev,
    marginUsdc: margin,
    entryPx: entry,
    tpPx,
    slPx,
    tpPct,
    slPct,
    rr: rrNew,
    maxLossUsdc: r2((margin * slPct) / 100 + fees),
    liqPx: liq,
    reason: `${why}.`,
  };
  /* The trade card it would become, with every cap applied again in code: no card, no adjusted setup. */
  if (!setupToOpenCard(adjusted, { market })) return null;
  return {
    suggested: { side, lev, entry, tp: tpPx, sl: slPx, rr: rrNew, why, moved: { tp: tpMoved, sl: false, lev: lev !== levNow } },
    adjustedSetup: adjusted,
  };
}

/**
 * A pending trade card's own terms as a setup, so the Analyze pill under it weighs THAT trade (its side, leverage,
 * margin and TP / SL), priced from the live price, its liquidation at its own leverage. Null without a side, a price,
 * a leverage or a margin. Never a trade by itself: the analysis only reads it.
 */
export function setupFromCard(card, market, { now = Date.now() } = {}) {
  if (!card || (card.side !== "buy" && card.side !== "sell") || !market || typeof market.coin !== "string") return null;
  if (typeof card.coin === "string" && card.coin !== market.coin) return null;
  const side = card.side;
  const entry = fin(market.px) && market.px > 0 ? market.px : fin(market.markPx) && market.markPx > 0 ? market.markPx : null;
  const lev = fin(card.leverage) && card.leverage >= 1 ? Math.min(Math.floor(card.leverage), Math.floor(maxLevOf(market))) : null;
  const margin = fin(card.marginUsdc) && card.marginUsdc > 0 ? Math.min(card.marginUsdc, MAX_MARGIN_USDC) : null;
  if (entry == null || lev == null || margin == null) return null;
  const off = card.tpslRemoved === true;
  const tpPct = !off && fin(card.tpPct) && card.tpPct !== 0 ? Math.abs(card.tpPct) : null;
  const slPct = !off && fin(card.slPct) && card.slPct !== 0 ? Math.abs(card.slPct) : null;
  const liq = estIsolatedLiqPx({ side, entryPx: entry, leverage: lev, maxLeverage: market.maxLeverage });
  return {
    id: `${market.coin}-${side}-card-${Math.floor((fin(now) ? now : Date.now()) / 60_000)}`,
    coin: market.coin,
    side,
    label: typeof card.setupLabel === "string" && card.setupLabel ? card.setupLabel : null,
    source: "card",
    leverage: lev,
    marginUsdc: margin,
    entryPx: entry,
    tpPx: tpPct != null ? pxAt(entry, side, tpPct, lev, "tp") : null,
    slPx: slPct != null ? pxAt(entry, side, slPct, lev, "sl") : null,
    tpPct,
    slPct,
    rr: tpPct != null && slPct != null ? r1(tpPct / slPct) : null,
    liqPx: liq,
    maxLossUsdc: null,
    reason: null,
  };
}

/* ── a held position ────────────────────────────────────────────────────────────────────────────────────────── */

const sideOfPos = (p) => (p && (p.side === "short" || (p.side !== "long" && fin(p.szi) && p.szi < 0)) ? "sell" : "buy");

/* The position's TP / SL now: its open trigger orders on that coin. */
function heldLegs(orders, coin) {
  const list = Array.isArray(orders) ? orders : [];
  const px = (o) => (fin(o.triggerPx) && o.triggerPx > 0 ? o.triggerPx : fin(o.limitPx) && o.limitPx > 0 ? o.limitPx : null);
  const tp = list.find((o) => o && o.coin === coin && o.tpsl === "tp" && px(o) != null);
  const sl = list.find((o) => o && o.coin === coin && o.tpsl === "sl" && px(o) != null);
  return { tp: tp ? px(tp) : null, sl: sl ? px(sl) : null };
}

/* "+4.6%" / "-1.7%": how far a price is from a reference (the mark), signed. */
const awayPct = (px, ref) => {
  const v = ((px / ref) - 1) * 100;
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}%`;
};

/**
 * The held position's RR now and the suggested TP / SL for it (setups.js recommendHeldTpSl at an RR the trends call
 * for), with the TP / SL card that sets it. Never a new or opposite position. Its RR is FROM THE MARK (rrFrom "mark"):
 * what is at stake from here, which is what a change to its TP / SL decides; measured from the entry, a position in
 * a loss would show the same small RR before and after, whatever the change.
 *
 * The user's own legs stay whenever they are better: a stop at or past the suggested one on the safe side (a long's
 * stop at or above it, still under the mark; a short mirrors it: a stop that locks in profit is never moved back), and
 * a TP the suggested one would not beat for the stop kept. The suggested stop never sits closer to the mark than
 * MIN_STOP_D1 daily ranges (a normal day would hit it); when liquidation leaves no more room than that, a stop the
 * user set stays. Nothing that does not raise the RR from the mark is offered: "Keep it", and no card. The why says
 * what moves, measured from the mark, then the trend as the reason.
 * @param {{ atrD1Pct?: number|null }} o the daily ATR (% of price) the stop's floor comes from (none when unknown)
 */
export function adjustHeld({ position, market, candles, trend = null, orders = [], atrD1Pct = null } = {}) {
  if (!position || !market) return { rr: { current: null, suggested: null }, tpsl: null };
  const side = sideOfPos(position);
  const buy = side === "buy";
  const entry = fin(position.entryPx) && position.entryPx > 0 ? position.entryPx : null;
  const lev = position.leverage && fin(position.leverage.value) ? position.leverage.value : null;
  const mark = fin(market.markPx) && market.markPx > 0 ? market.markPx : fin(market.px) && market.px > 0 ? market.px : null;
  const legs = heldLegs(orders, position.coin);
  const rrOf = (tp, sl) => (mark != null && fin(tp) && fin(sl) && (buy ? sl < mark && tp > mark : sl > mark && tp < mark)
    ? r1(Math.abs(tp - mark) / Math.abs(mark - sl)) : null);
  const current = { side, lev, entry, tp: legs.tp, sl: legs.sl, rr: rrOf(legs.tp, legs.sl), rrFrom: "mark", mark };
  const { fit, names } = trendFit(trend, side);
  const target = fit === "against" ? RR_AGAINST : fit === "with" ? 2 + RR_WITH_STEP : 2;
  const minStop = mark != null && fin(atrD1Pct) && atrD1Pct > 0 ? mark * (atrD1Pct / 100) * MIN_STOP_D1 : 0;
  const rec = recommendHeldTpSl({
    market, candles, side, leverage: lev, entryPx: entry, markPx: mark,
    liqPx: fin(position.liquidationPx) ? position.liquidationPx : null, rr: target, minStop,
  });
  if (!rec || mark == null) return { rr: { current, suggested: null }, tpsl: null };
  const keep = (why) => ({ rr: { current, suggested: { ...current, why, keep: true, moved: { tp: false, sl: false, lev: false } } }, tpsl: null });

  /* The stop: the user's stays when it protects at least as much (or when the only stop room left is inside a normal
     day's range). */
  const slSet = legs.sl != null && (buy ? legs.sl < mark : legs.sl > mark);
  const keepSl = slSet && ((buy ? legs.sl >= rec.slPx : legs.sl <= rec.slPx) || !!rec.belowFloor);
  const sl = keepSl ? legs.sl : rec.slPx;
  /* The TP: the user's stays unless the suggested one pays more for the stop that is kept. */
  const tpSet = legs.tp != null && rrOf(legs.tp, sl) != null;
  const keepTp = tpSet && !(rrOf(rec.tpPx, sl) > rrOf(legs.tp, sl));
  const tp = keepTp ? legs.tp : rec.tpPx;
  const rrNew = rrOf(tp, sl);
  if ((keepSl && keepTp) || rrNew == null) return keep("Keep it: your TP and stop already fit");
  if (current.rr != null && !(rrNew > current.rr)) return keep("Keep it: a change would not pay more for the risk");

  /* The words come from the numbers: what moves (from the mark), then the trend as the reason. */
  const px = (v) => formatHlPrice(v, fin(market.szDecimals) ? market.szDecimals : null);
  const stop = keepSl ? null
    : legs.sl == null ? `Adds a stop at ${px(sl)} (${awayPct(sl, mark)})`
      : `Stop ${sl > legs.sl ? "up" : "down"} to ${px(sl)} (${awayPct(sl, mark)})`;
  const nearer = legs.tp != null && Math.abs(tp - mark) < Math.abs(legs.tp - mark);
  const tpWhat = legs.tp == null ? (stop ? "a TP" : "Adds a TP") : `${stop ? "a " : ""}${stop ? (nearer ? "nearer" : "further") : cap(nearer ? "nearer" : "further")} TP`;
  const tpWords = keepTp ? null : `${tpWhat} at ${px(tp)} (${awayPct(tp, mark)})`;
  const move = [stop, tpWords].filter(Boolean).join(stop && tpWords && legs.tp == null && legs.sl == null ? " and " : ", ");
  const reason = fit === "against" ? `Against the ${names} trend` : fit === "with" ? "4h and 1d trends agree" : null;
  const tight = rec.belowFloor && !keepSl ? "tight: liquidation is near" : null;
  const why = `${move}: RR 1 : ${rrNew}${[reason, tight].filter(Boolean).length ? `. ${[reason, tight].filter(Boolean).join(", ")}` : ""}`;
  return {
    rr: {
      current,
      suggested: { side, lev, entry, tp, sl, rr: rrNew, rrFrom: "mark", mark, why, moved: { tp: !keepTp, sl: !keepSl, lev: false } },
    },
    /* A leg that stays is left out: the TP / SL editor keeps the position's own leg as it is. */
    tpsl: { kind: "tpsl", coin: position.coin, tpPct: keepTp ? null : rec.tpPct, slPct: keepSl ? null : rec.slPct, status: "review", recommended: true, rr: rrNew },
  };
}

/* ── the card ───────────────────────────────────────────────────────────────────────────────────────────────── */

const freeUsdcOf = (b) => {
  const bal = b && b.connected && b.account ? b.account.perpBalanceUsdc : null;
  if (!bal || bal.answered !== true || bal.complete === false) return null;
  return fin(bal.availableUsdc) ? bal.availableUsdc : null;
};
const heldOf = (b, coin) => {
  const pos = b && b.connected && b.account && b.account.positions && b.account.positions.byCoin ? b.account.positions.byCoin[coin] : null;
  return pos && fin(pos.szi) && pos.szi !== 0 ? pos : null;
};
const marketOf = (snapshot, coin) => {
  const byCoin = (snapshot && snapshot.byCoin) || {};
  if (byCoin[coin]) return byCoin[coin];
  const want = String(coin || "").toUpperCase();
  const k = Object.keys(byCoin).find((c) => c.toUpperCase() === want);
  return k ? byCoin[k] : null;
};
const PROFILE_NAMES = ["Safer", "Balanced", "Bolder"];

/**
 * The analysis card for one market. Never rejects: a part that could not be read is null.
 * @param {{ coin: string, backend?: object, snapshot?: object, market?: object, fetchCandles: (coin, interval, { bars }) => Promise<object[]>,
 *   readUnlocks?: Function, readEmission?: Function, tokenomistOn?: boolean, position?: object|null, setup?: object|null,
 *   card?: object|null, side?: "buy"|"sell"|null, profile?: string|null, leverage?: number|null, now?: number|Function,
 *   timeoutMs?: number }} o
 *   position: the held position (default: the account's, from backend); setup: the setup the pill sat on; card: the
 *   pending trade card the pill sat under (its own terms, setupFromCard); else the app's own setup for this market,
 *   `profile` (Safer / Balanced / Bolder) or the one at `leverage` on `side` (default the 1h lean), Balanced by default.
 *   A held position wins over all of them (one position per market). rr.current.source says which: "position",
 *   "setup", "card", "words" (side / profile / leverage named) or "default" (nobody picked one: the card says so).
 * @returns {Promise<object>} the "analysis" card (shared contract; see the head of this file)
 */
export async function analyzeMarket({
  coin, backend = null, snapshot = null, market = null, fetchCandles, readUnlocks = null, readEmission = null, tokenomistOn = false,
  position, setup = null, card = null, side = null, profile = null, leverage = null, now = Date.now(), timeoutMs = 8000,
} = {}) {
  const at = typeof now === "function" ? now() : fin(now) ? now : Date.now();
  const m = market || marketOf(snapshot, coin);
  const name = m ? m.coin : typeof coin === "string" ? coin : null;
  const held = position === undefined ? heldOf(backend, name) : position && fin(position.szi) && position.szi !== 0 ? position : null;

  /* A stock: a week of 1h bars (its setups use US-hours bars only), and the US market's state where a token's emission
     row would be: Tokenomist is never asked about a share. */
  const stock = isStockCoin(name);
  const read = (f) => (typeof fetchCandles === "function" && name
    ? settle(Promise.resolve().then(() => fetchCandles(name, f.interval, { bars: stock && f.key === "h1" ? Math.max(f.bars, STOCK_ANALYSIS_H1_BARS) : f.bars })), timeoutMs)
    : Promise.resolve(null));
  const [charts, emission] = await Promise.all([
    Promise.all(ANALYSIS_FRAMES.map(read)),
    stock ? Promise.resolve(stockMarketRow(name, at))
      : emissionOf({ coin: name, market: m, tokenomistOn, readUnlocks, readEmission, now: at, timeoutMs: Math.max(timeoutMs, 12_000) }),
  ]);
  const candles = Object.fromEntries(ANALYSIS_FRAMES.map((f, i) => [f.key, cleanCandles(charts[i])]));
  /* The setup a stock's RR weighs is sized on US-hours bars only (stocks.js stockCandles' rule). */
  const setupBars = stock ? cleanCandles(coreSessionCandles(candles.h1)) : candles.h1;
  const t = Object.fromEntries(ANALYSIS_FRAMES.map((f) => [f.key, frameTrend(candles[f.key])]));
  const price = m && fin(m.px) && m.px > 0 ? m.px : m && fin(m.markPx) && m.markPx > 0 ? m.markPx : null;
  const flip = flipLevels(t.h4, price);
  const trend = { h1: trendEntry(t.h1), h4: trendEntry(t.h4), d1: trendEntry(t.d1) };
  const feeRate = backend && fin(backend.feeRate) ? backend.feeRate : null;

  /* What the risks and the RR are about: the held position (one per market), else the setup the pill sat on, else
     the app's own setup for this market (the same one its setups card shows). */
  let s = null;
  let source = null;
  let subject = { side: null, refPx: null, liqPx: null };
  if (held && m) {
    subject = { side: sideOfPos(held), refPx: fin(m.markPx) ? m.markPx : price, liqPx: fin(held.liquidationPx) ? held.liquidationPx : null };
  } else if (m) {
    s = setup && setup.coin === m.coin && (setup.side === "buy" || setup.side === "sell") ? setup : null;
    if (s) source = "setup";
    if (!s && card) { s = setupFromCard(card, m, { now: at }); if (s) source = "card"; }
    if (!s && setupBars.length) {
      const built = buildSetups({ market: m, candles: setupBars, freeUsdc: freeUsdcOf(backend), side: side === "buy" || side === "sell" ? side : null, feeRate, now: at });
      const want = PROFILE_NAMES.find((p) => String(profile || "").toLowerCase() === p.toLowerCase()) || null;
      const lv = fin(leverage) && leverage >= 1 ? Math.floor(leverage) : null;
      if (built.ok) {
        const atLev = lv != null ? built.setups.filter((x) => x.leverage === lv) : [];
        s = (want && built.setups.find((x) => x.label === want))
          || (atLev.length ? atLev.find((x) => x.label === "Balanced") || atLev[atLev.length - 1] : null)
          || built.setups.find((x) => x.label === "Balanced") || built.setups[0];
        source = want || lv != null || side === "buy" || side === "sell" ? "words" : "default";
      }
    }
    if (s) subject = { side: s.side, refPx: fin(s.entryPx) ? s.entryPx : null, liqPx: fin(s.liqPx) ? s.liqPx : null };
  }
  const risks = gradeRisks({
    market: m, side: subject.side, refPx: subject.refPx, liqPx: subject.liqPx,
    atrD1Pct: t.d1 ? t.d1.atrPct : null, atrH1Pct: t.h1 ? t.h1.atrPct : null, emission,
  });

  let rr = { current: null, suggested: null };
  let adjustedSetup = null;
  let tpsl = null;
  if (held && m) {
    const orders = backend && backend.account && backend.account.orders && backend.account.orders.answered ? backend.account.orders.list : [];
    const a = adjustHeld({ position: held, market: m, candles: candles.h1, trend, orders, atrD1Pct: t.d1 ? t.d1.atrPct : null });
    rr = a.rr;
    if (rr.current) rr.current = { ...rr.current, source: "position" };
    tpsl = a.tpsl;
  } else if (s) {
    rr.current = { side: s.side, lev: s.leverage, entry: s.entryPx, tp: fin(s.tpPx) ? s.tpPx : null, sl: fin(s.slPx) ? s.slPx : null, rr: fin(s.rr) ? s.rr : null, label: s.label || null, source };
    const adj = adjustSetup({ setup: s, market: m, trend, flip, risks, feeRate, now: at });
    if (adj) {
      rr.suggested = adj.suggested;
      adjustedSetup = adj.adjustedSetup;
    }
  }

  return {
    kind: "analysis",
    coin: name,
    at,
    price: price != null ? price : null,
    change24hPct: m && fin(m.change24hPct) ? r2(m.change24hPct) : null,
    fundingPctPerHour: m && fin(m.funding) ? Math.round(m.funding * 100 * 1e6) / 1e6 : null,
    volume24hUsd: m && fin(m.dayNtlVlm) ? Math.round(m.dayNtlVlm) : null,
    szDecimals: m && fin(m.szDecimals) ? m.szDecimals : null,
    trend,
    flip,
    emission,
    risks,
    rr,
    adjustedSetup,
    tpsl,
    held: !!held,
    basis: ANALYSIS_BASIS,
  };
}

/** The normal trade card the analysis' "Use adjusted setup" makes (caps applied again in code), or null. Never sends. */
export function analysisOpenCard(card, { market = null } = {}) {
  return card && card.kind === "analysis" && !card.held && card.adjustedSetup ? setupToOpenCard(card.adjustedSetup, { market }) : null;
}

/** Is there an Analyze pill for this market? Any main market the analysis reads: never USDC, never a HIP-3 venue
 *  market ("xyz:TSLA": its words would fall back to another market). */
export const analyzable = (coin) => typeof coin === "string" && !!coin.trim() && coin.trim().toUpperCase() !== "USDC" && (!coin.includes(":") || isStockCoin(coin.trim()));

/* ── words ──────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The words an Analyze pill says to the Agent (intents.js reads them back), as a person would say them: "with
 * Tokenomist" only when the key is on and Tokenomist covers the coin (never a claim of its data otherwise); a pill on a
 * setup box or under a trade card names the leverage and side that box or card shows: "Analyze ZEC 3x short". (The
 * pill also hands the setup or card itself to the analysis, so it weighs that very one; typed, the words pick the
 * app's setup at that leverage and side.)
 * @param {{ tokenomistOn?: boolean, setup?: { side: "buy"|"sell", leverage?: number }|null }} o
 */
export function analyzePrompt(coin, { tokenomistOn = false, setup = null } = {}) {
  /* The words a person would say: the ticker for a stock ("Analyze TSLA"), never its venue-qualified id. */
  const c = typeof coin === "string" ? agentTicker(coin.trim()) : "";
  if (!c) return "Analyze";
  const s = setup && (setup.side === "buy" || setup.side === "sell") ? setup : null;
  const lev = s && fin(s.leverage) && s.leverage >= 1 ? ` ${Math.min(Math.floor(s.leverage), AGENT_MAX_LEVERAGE)}x` : "";
  const side = s ? `${lev} ${s.side === "sell" ? "short" : "long"}` : "";
  return `Analyze ${c}${side}${tokenomistOn && coveredCoin(c) ? " with Tokenomist" : ""}`;
}

const DIR_EN = { up: "up", down: "down", range: "sideways" };
const DIR_TH = { up: "ขาขึ้น", down: "ขาลง", range: "ไซด์เวย์" };

/* The trend in a few words: "Down on all three" when every timeframe read agrees, else the timeframes grouped by
   direction, the larger group first ("4h and 1d down, 1h up"). */
function trendWords(tr, th) {
  const frames = [["1d", tr.d1], ["4h", tr.h4], ["1h", tr.h1]].filter(([, t]) => t && DIR_EN[t.dir]);
  if (!frames.length) return null;
  const dirs = [...new Set(frames.map(([, t]) => t.dir))];
  if (dirs.length === 1) {
    const d = dirs[0];
    if (th) return frames.length === 3 ? `${DIR_TH[d]}ทั้ง 3 กรอบเวลา` : `${DIR_TH[d]} (${frames.map(([k]) => k).join(", ")})`;
    return frames.length === 3 ? `${cap(DIR_EN[d])} on all three timeframes` : `${cap(DIR_EN[d])} on ${frames.map(([k]) => k).reverse().join(" and ")}`;
  }
  /* The larger group first (ties: the one with the higher timeframe). */
  const groups = dirs.map((d) => [d, frames.filter(([, t]) => t.dir === d).map(([k]) => k).reverse()]).sort((a, b) => b[1].length - a[1].length);
  const out = groups.map(([d, ks]) => (th ? `${ks.join(", ")} ${DIR_TH[d]}` : `${ks.join(" and ")} ${DIR_EN[d]}`)).join(", ");
  return th ? out : cap(out);
}

/* What the card's rows do not say at a glance, without repeating its numbers: for a position, how far its stop is
   now ("Your stop is 5.0% away; see the suggested one."); for a setup, how its side sits with the 4h / 1d trend ("The
   3x short goes with the 4h and 1d trend; see the suggested change."). */
function nextWords(card, th) {
  const rr = (card && card.rr) || {};
  const cur = rr.current;
  const sug = rr.suggested;
  if (!cur) return null;
  if (card.held) {
    if (sug && sug.keep) return th ? "TP / SL ที่ตั้งไว้ยังโอเค" : "Your TP and stop fit as set.";
    const ref = fin(cur.mark) && cur.mark > 0 ? cur.mark : null;
    const away = fin(cur.sl) && ref != null ? Math.abs(cur.sl / ref - 1) * 100 : null;
    const head = away != null ? (th ? `stop ของคุณห่าง ${away.toFixed(1)}%` : `Your stop is ${away.toFixed(1)}% away`) : (th ? "ยังไม่มี stop" : "No stop on it yet");
    return sug ? (th ? `${head} ดูที่แนะนำในการ์ด` : `${head}; see the suggested one.`) : th ? head : `${head}.`;
  }
  if (cur.side !== "buy" && cur.side !== "sell") return null;
  /* 🔴 Nobody picked a setup (the card weighs the app's default Balanced one, and says so): no sentence about "the 2x
     short" the user never chose (pass-2 review: "News and trend for TSLA" ended "The 2x short has the 4h trend behind
     it, and fits as set."). */
  if (cur.source === "default") return null;
  const t = card.trend || {};
  const want = cur.side === "buy" ? "up" : "down";
  const frames = (dir) => ["h4", "d1"].filter((k) => t[k] && t[k].dir === dir).map((k) => TF_NAME[k]);
  const against = frames(want === "up" ? "down" : "up");
  const agree = frames(want);
  const what = `${fin(cur.lev) ? `${cur.lev}x ` : ""}${cur.side === "sell" ? "short" : "long"}`;
  if (th) {
    const rel = against.length ? `สวนเทรนด์ ${against.join(", ")}` : agree.length ? `ไปทางเดียวกับเทรนด์ ${agree.join(", ")}` : "ยังไม่มีเทรนด์ 4h / 1d ชัด";
    return `${what} ${rel}${sug && !sug.keep ? " ดูที่แนะนำในการ์ด" : ""}`;
  }
  const rel = against.length ? `goes against the ${against.join(" and ")} trend`
    : agree.length === 2 ? "goes with the 4h and 1d trend"
      : agree.length ? `has the ${agree[0]} trend behind it` : "has no clear 4h / 1d trend behind it";
  return `The ${what} ${rel}${sug && !sug.keep ? "; see the suggested change." : sug && sug.keep ? ", and fits as set." : "."}`;
}

/**
 * The one short line the Agent says over the card. It adds what the card's rows do not say at a glance, and never
 * repeats its numbers: the trend in a few words, then where the position's stop is or how the setup's side sits with
 * the trend ("ETH: down on all three timeframes. Your stop is 5.0% away; see the suggested one.").
 */
export function analysisLine(card, lang = "en") {
  const th = lang === "th";
  /* The name the user reads: the ticker for a stock ("TSLA"), the index by its name ("ดัชนี US 100", "US 100 index":
     never Nasdaq-100), never a venue-qualified id. */
  const c = card && card.coin ? (stockKind(card.coin) === "index" ? stockDisplayName(card.coin, th ? "th" : "en") : agentTicker(card.coin)) : "";
  const tr = (card && card.trend) || {};
  const head = trendWords(tr, th);
  if (!head) return th ? `${c}: อ่านกราฟไม่ได้ตอนนี้` : `${c}: the charts couldn't be read right now.`;
  const tail = nextWords(card, th);
  return th ? `${c}: ${head}${tail ? ` · ${tail}` : ""}` : `${c}: ${head.charAt(0).toLowerCase()}${head.slice(1)}.${tail ? ` ${tail}` : ""}`;
}

/* What the RR row is about, for the model. */
const SOURCE_WORDS = {
  position: "the user's open position (RR from the mark)",
  setup: "the setup box the user tapped Analyze on",
  card: "the trade card the user tapped Analyze under",
  words: "the app's setup at the side / leverage the user named",
  default: "the app's default Balanced setup (the user picked none)",
};

/** What the model reads (get_analysis): the same card, small and in words. No address, nothing to act on. */
export function analysisForModel(card) {
  if (!card || card.kind !== "analysis") return { error: "No analysis." };
  const px = (v) => (fin(v) ? formatHlPrice(v, card.szDecimals) : null);
  const tr = (t) => (t ? `${t.dir}: ${t.note.toLowerCase()} (21-EMA ${t.emaSlopePct >= 0 ? "+" : ""}${t.emaSlopePct}% over ${SLOPE_BARS} bars)` : null);
  const f = card.flip || {};
  const away = (pct) => (fin(pct) && fin(f.atrPct) && f.atrPct > 0 ? `, about ${r1(pct / f.atrPct)} typical 4h ranges away` : "");
  const e = card.emission || {};
  const n = e.nextUnlock;
  const leg = (x) => (x ? `${x.side === "sell" ? "short" : "long"}${fin(x.lev) ? ` ${x.lev}x` : ""} entry ${px(x.entry) || "?"} TP ${px(x.tp) || "none"} SL ${px(x.sl) || "none"} RR ${fin(x.rr) ? x.rr : "?"}` : null);
  return {
    coin: agentTicker(card.coin),
    ...(e.stock ? { kind: "stock", note_stock: "A perp that tracks the share price: no dividends, no votes." } : {}),
    price: px(card.price),
    change_24h: fin(card.change24hPct) ? formatHlPct(card.change24hPct) : null,
    funding_hourly: fin(card.fundingPctPerHour) ? `${card.fundingPctPerHour >= 0 ? "+" : ""}${card.fundingPctPerHour.toFixed(4)}%` : null,
    volume_24h: fin(card.volume24hUsd) ? formatHlUsdCompact(card.volume24hUsd) : null,
    trend: { "1h": tr(card.trend && card.trend.h1), "4h": tr(card.trend && card.trend.h4), "1d": tr(card.trend && card.trend.d1) },
    turns_up_above: f.upAbove != null ? `${px(f.upAbove)} (+${f.upPct}%${away(f.upPct)})` : null,
    turns_down_below: f.downBelow != null ? `${px(f.downBelow)} (-${f.downPct}%${away(f.downPct)})` : null,
    emission: e.stock ? `A stock: no token unlocks. US market: ${(e.status && e.status.en) || "unknown"}.`
      : !e.configured ? "Unlock data (Tokenomist) is not connected: never quote unlock or emission figures."
      : !e.covered ? `Tokenomist has no data for ${card.coin}.`
        : e.error ? "Unlock data couldn't be read right now."
          : {
            next_unlock: n ? `${n.date}${fin(n.inDays) ? ` (in ${n.inDays} days)` : ""}${fin(n.pctCirculating) ? `, ${n.pctCirculating}% of circulating` : ""}${fin(n.usd) ? `, about ${formatHlUsdCompact(n.usd)}` : ""}` : `none in the next ${UNLOCK_DAYS} days`,
            monthly_emission_pct_of_circulating: fin(e.monthlyPct) ? `${e.monthlyPct}%` : null,
            source: "Tokenomist; scheduled, not certain",
          },
    risks: (card.risks || []).map((r) => `${r.level} ${r.id}: ${r.text}`),
    position_held: !!card.held,
    rr_of: SOURCE_WORDS[(card.rr && card.rr.current && card.rr.current.source) || ""] || null,
    now: leg(card.rr && card.rr.current),
    suggested: card.rr && card.rr.suggested ? `${leg(card.rr.suggested)} (${card.rr.suggested.why})` : null,
    card_offers: card.adjustedSetup ? "a 'Use adjusted setup' button (a trade card that waits for Confirm)" : card.tpsl ? "a TP / SL card for the held position" : null,
    note: "Shown to the user as a card. From candles and market data, not advice. A trend turn is a price level, never a date: if asked when, give the level and how many typical 4h ranges away it is.",
  };
}

/** The card in one sentence, for the model's history (so a later question can refer to it). */
export function analysisNote(card) {
  if (!card || card.kind !== "analysis") return "";
  const tr = card.trend || {};
  const d = (t) => (t ? t.dir : "unknown");
  const px = (v) => (fin(v) ? formatHlPrice(v, card.szDecimals) : "?");
  const f = card.flip || {};
  const parts = [`Showed the ${agentTicker(card.coin)} analysis: 1h ${d(tr.h1)}, 4h ${d(tr.h4)}, 1d ${d(tr.d1)}`];
  if (f.upAbove != null) parts.push(`turns up above ${px(f.upAbove)}`);
  if (f.downBelow != null) parts.push(`turns down below ${px(f.downBelow)}`);
  const s = card.rr && card.rr.suggested;
  if (s) parts.push(`suggested ${s.side === "sell" ? "short" : "long"}${fin(s.lev) ? ` ${s.lev}x` : ""} TP ${px(s.tp)} SL ${px(s.sl)} RR ${fin(s.rr) ? s.rr : "?"} (${s.why})`);
  const high = (card.risks || []).filter((r) => r && r.level === "high").map((r) => r.text);
  if (high.length) parts.push(`high risks: ${high.join(", ")}`);
  if (card.emission && card.emission.stock) parts.push(`US market: ${(card.emission.status && card.emission.status.en) || "unknown"}`);
  else if (!card.emission || !card.emission.configured) parts.push("unlock data not connected");
  return `${parts.join("; ")}.`;
}
