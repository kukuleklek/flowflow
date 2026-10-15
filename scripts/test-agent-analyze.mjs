/**
 * test-agent-analyze — the Analyze pill's answer (owner, 2026-10-15: "ช่วยคิด Downtrend หรือ มันจะ Uptrend วันไหน Emission
 * เป็นไง เสี่ยงอะไรไหม ไรงี้ RR ควรเปลี่ยนเท่าไหร่"): ONE compact analysis card from real data only.
 *
 *   analyze.js   trend up / down / range on 1h, 4h, 1d (EMA slope + swing structure); the 4h levels that would turn it
 *                (levels, never dates); emission (Tokenomist only with the key on and a coin it covers); risks graded
 *                low / medium / high; the RR now and suggested, with the setups' caps applied again in code; a held
 *                position gets a TP / SL card, never a new or opposite position
 *   intents.js   "Analyze X" (and the pill's words) → one analysis card and at most one short line
 *   runTool.js   get_analysis: a read tool for the model (a small summary, no address) that also shows the card
 *
 * No network: markets are Hyperliquid's own recorded answer; candles, unlocks and emission are injected fakes.
 * Run: node --test scripts/test-agent-analyze.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePerpMarkets } from "../src/lib/hyperliquid/markets.js";
import { quoteOpenLive, quoteAddLive } from "../src/perp/live/perpBackend.js";
import {
  analyzeMarket, frameTrend, flipLevels, gradeRisks, adjustSetup, adjustHeld, emissionOf, monthlyEmissionPct, swingPoints,
  structureOf, emaSeries, atrOf, analysisForModel, analysisLine, analysisNote, analysisOpenCard, trendEntry,
  setupFromCard, analyzePrompt, analyzable,
  ANALYSIS_FRAMES, ANALYSIS_BASIS, FLIP_BASIS, MIN_TREND_BARS, RR_AGAINST, RR_MAX, MIN_STOP_D1,
} from "../src/agent/analyze.js";
import { chipsFor } from "../src/agent/chips.js";
import { parseShortcut } from "../src/agent/shortcuts.js";
import { buildSetups, setupToOpenCard, SETUP_MAX_LEVERAGE, LIQ_BUFFER } from "../src/agent/setups.js";
import { detectIntent, describeCard } from "../src/agent/intents.js";
import { runToolCall, analysisFor } from "../src/agent/runTool.js";
import { askAgent } from "../src/agent/agent.js";
import { chat } from "../src/agent/store.js";
import { TOOLS, READ_TOOLS, isReadTool, toolsFor } from "../src/agent/tools.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { assetState, suggestAssets, lintItem } from "../src/agent/suggest.js";
import { readEmission } from "../src/lib/tokenomist/client.js";
import { estIsolatedLiqPx } from "../src/perp/perpTicket.js";
import { MAX_MARGIN_USDC } from "../src/perp/guardrails.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hl-meta-and-asset-ctxs.json"), "utf8"));
const parsed = parsePerpMarkets(fixture.response, { now: 1 });
const snapshot = { markets: parsed.markets, byCoin: parsed.byCoin };
const COINS = parsed.markets.filter((m) => !m.isHip3).map((m) => m.coin);
const ETH = parsed.byCoin.ETH;
const HYPE = parsed.byCoin.HYPE;
const NOW = Date.UTC(2026, 9, 15, 12);
const STEP = { "1h": 3_600_000, "4h": 4 * 3_600_000, "1d": 86_400_000 };

/* ── candles with a known shape, ending at the market's price ──────────────────────────────────────────────────── */

/* `bars` bars ending at `px`: a drift per bar, a zig-zag of `amp` over `period` bars (swings to read), each bar `range`
   wide. drift > 0 with a zig-zag: higher highs and higher lows; < 0: lower highs and lower lows; 0: a range. */
function shaped(px, { bars = 90, drift = 0, amp = 0, period = 8, range = 0.006, step = STEP["1h"] } = {}) {
  const raw = [];
  for (let i = 0; i <= bars; i++) raw.push((1 + drift) ** i * (1 + amp * Math.sin((2 * Math.PI * i) / period)));
  const k = px / raw[bars];
  const out = [];
  for (let i = 1; i <= bars; i++) {
    const o = raw[i - 1] * k;
    const c = raw[i] * k;
    out.push({ time: NOW - (bars - i + 1) * step, open: o, high: Math.max(o, c) * (1 + range / 2), low: Math.min(o, c) * (1 - range / 2), close: c, volume: 1 });
  }
  return out;
}
const UP = { drift: 0.004, amp: 0.012 };
const DOWN = { drift: -0.004, amp: 0.012 };
const RANGE = { drift: 0, amp: 0.02, period: 10 };
/* A fetchCandles fake: a shape per interval; every call recorded. */
function candlesBy(shapes, { fail = [] } = {}) {
  const calls = [];
  const f = async (coin, interval, { bars } = {}) => {
    calls.push({ coin, interval, bars });
    if (fail.includes(interval)) throw new Error("no candles");
    const m = parsed.byCoin[coin];
    if (!m) throw new Error("no market");
    return shaped(m.px, { bars, step: STEP[interval], ...(shapes[interval] || {}) });
  };
  f.calls = calls;
  return f;
}

const HYPE_UNLOCKS = {
  configured: true, covered: true, coin: "HYPE", ok: true, slug: "hyperliquid", source: "Tokenomist", url: "https://tokenomist.ai/hyperliquid",
  updatedAt: "2026-10-07", window: { start: "2026-10-15", end: "2027-01-13", days: 90 },
  token: { name: "Hyperliquid", symbol: "HYPE", circulatingSupply: 340_000_000, maxSupply: 1e9, marketCap: null },
  events: [{ date: "2026-10-25", amount: 9_920_000, valueUsd: 786_000_000, pctMcap: 2.9, to: [{ name: "Founder / Team", pct: 100 }], committed: null }],
  totalEvents: 1,
};
/* 13 weeks of 2.5M HYPE: 2.5M / 7 days × 30.44 / 340M ≈ 3.2% a month. */
const HYPE_EMISSION = { configured: true, covered: true, coin: "HYPE", weeks: Array.from({ length: 13 }, (_, i) => ({ start: `2026-10-${String(15 + i).padStart(2, "0")}`, amount: 2_500_000, valueUsd: null })), totalAmount: 32_500_000 };
function spy(answer) {
  const calls = [];
  const f = async (coin, o) => { calls.push({ coin, o }); return typeof answer === "function" ? answer(coin, o) : answer; };
  f.calls = calls;
  return f;
}

const ethPos = {
  coin: "ETH", side: "long", szi: 0.05, entryPx: ETH.px, positionValue: 0.05 * ETH.px, unrealizedPnl: 1.2, returnOnEquity: 0.06,
  liquidationPx: ETH.px * 0.8, marginUsed: 20, leverage: { type: "isolated", value: 5 }, cumFunding: { sinceOpen: 0 },
};
const live = ({ positions = [ethPos], orders = [], available = 100 } = {}) => ({
  connected: true, mock: false, feeRate: 0.00045, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  account: {
    mode: { source: "perp" },
    perpBalanceUsdc: { answered: true, source: "perp", equityUsdc: 120, availableUsdc: available, holdUsdc: 0, reason: null },
    positions: { answered: true, list: positions, byCoin: Object.fromEntries(positions.map((p) => [p.coin, p])) },
    orders: { answered: true, list: orders },
    fills: { answered: true, list: [] },
  },
  quoteOpen: (a) => quoteOpenLive(a),
  quoteAdd: (a) => quoteAddLive(a),
});
const guest = { connected: false, mock: false, account: null };
const words = (s) => String(s).trim().split(/\s+/).length;
const card0 = (o = {}) => analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: candlesBy({ "1h": UP, "4h": UP, "1d": UP }), tokenomistOn: false, now: NOW, ...o });

/* ── trend math ───────────────────────────────────────────────────────────────────────────────────────────────── */

test("N1) trend: up, down and range are told apart (EMA slope + swing structure); too few bars is null, never a guess", () => {
  const up = frameTrend(shaped(100, { bars: 60, ...UP }));
  const down = frameTrend(shaped(100, { bars: 60, ...DOWN }));
  const flat = frameTrend(shaped(100, { bars: 60, ...RANGE }));
  assert.equal(up.dir, "up");
  assert.equal(up.structure, "up", "higher highs and higher lows");
  assert.ok(up.emaSlopePct > 0);
  assert.equal(down.dir, "down");
  assert.equal(down.structure, "down", "lower highs and lower lows");
  assert.ok(down.emaSlopePct < 0);
  assert.equal(flat.dir, "range");
  assert.notEqual(flat.structure, "up");
  assert.notEqual(flat.structure, "down");
  /* A smooth climb has no swings at all: the slope and the close over the EMA still make it an uptrend. */
  const smooth = frameTrend(shaped(100, { bars: 48, drift: 0.003 }));
  assert.equal(smooth.dir, "up");
  assert.equal(smooth.structure, null);
  /* Too short a chart: null (the card prints a dash). */
  assert.equal(frameTrend(shaped(100, { bars: MIN_TREND_BARS - 1, ...UP })), null);
  assert.equal(frameTrend(null), null);
  assert.equal(frameTrend([{ open: 1, high: NaN, low: 1, close: 1 }]), null);
  /* The card keeps four fields; the note is at most 6 words. */
  for (const t of [up, down, flat, smooth]) {
    assert.deepEqual(Object.keys(trendEntry(t)).sort(), ["atrPct", "dir", "emaSlopePct", "note"]);
    assert.ok(words(t.note) <= 6, t.note);
  }
});

test("N2) the math underneath: EMA seeded by the average, ATR over true ranges, swings and structure", () => {
  const e = emaSeries([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2, "seeded with the simple average of the first 3");
  assert.equal(e[3], 3);
  assert.deepEqual(emaSeries([1, 2], 3), [null, null]);
  const bars = Array.from({ length: 16 }, (_, i) => ({ time: i, open: 10, high: 11, low: 9, close: 10 }));
  assert.equal(atrOf(bars, 14), 2);
  assert.equal(atrOf(bars.slice(0, 10), 14), null);
  /* A clean zig-zag: swing highs at the peaks, swing lows at the troughs. */
  const zz = [10, 12, 14, 12, 10, 13, 16, 13, 11, 14, 18, 14, 12].map((c, i) => ({ time: i, open: c, high: c + 0.5, low: c - 0.5, close: c }));
  const sw = swingPoints(zz);
  assert.deepEqual(sw.highs.map((x) => x.px), [14.5, 16.5, 18.5]);
  assert.deepEqual(sw.lows.map((x) => x.px), [9.5, 10.5]);
  assert.equal(structureOf(sw), "up");
  assert.equal(structureOf({ highs: [{ px: 2 }, { px: 1 }], lows: [{ px: 2 }, { px: 1 }] }), "down");
  assert.equal(structureOf({ highs: [{ px: 2 }, { px: 3 }], lows: [{ px: 2 }, { px: 1 }] }), "mixed");
  assert.equal(structureOf({ highs: [{ px: 2 }], lows: [] }), null);
});

/* ── flip levels ──────────────────────────────────────────────────────────────────────────────────────────────── */

test("N3) flip levels: a downtrend turns up above its last 4h swing high, an uptrend down below its last swing low, a range at its edges", () => {
  const px = 100;
  const down = frameTrend(shaped(px, { bars: 90, ...DOWN }));
  const fd = flipLevels(down, px);
  assert.equal(fd.basis, FLIP_BASIS);
  assert.equal(fd.downBelow, null, "a downtrend has nothing to turn down below");
  assert.ok(fd.upAbove > px, "the turn is above the price");
  assert.ok([down.highs.at(-1), down.ema].some((v) => Math.abs(v - fd.upAbove) < 1e-6 * px), "the last swing high (or, passed, the 21-EMA)");
  assert.ok(fd.upPct > 0 && fd.atrPct > 0, "how far, and the typical 4h range to say it in");
  const up = frameTrend(shaped(px, { bars: 90, ...UP }));
  const fu = flipLevels(up, px);
  assert.equal(fu.upAbove, null);
  assert.ok(fu.downBelow < px);
  assert.ok(fu.downPct > 0);
  const range = frameTrend(shaped(px, { bars: 90, ...RANGE }));
  const fr = flipLevels(range, px * 1.0001);
  assert.equal(range.dir, "range");
  assert.ok(fr.upAbove > px && fr.downBelow < px, "both edges of the range");
  /* A swing level already passed falls back to the EMA, and a level on the wrong side is never printed. */
  const passed = flipLevels({ ...down, highs: [px * 0.9, px * 0.95], ema: px * 1.02 }, px);
  assert.equal(passed.upAbove, Number((px * 1.02).toPrecision(6)));
  const none = flipLevels({ ...down, highs: [px * 0.9], ema: px * 0.97 }, px);
  assert.equal(none.upAbove, null);
  /* Unknown in, nulls out: never 0. */
  assert.deepEqual([flipLevels(null, px).upAbove, flipLevels(null, px).downBelow], [null, null]);
  assert.equal(flipLevels(up, null).downBelow, null);
});

/* ── risks ────────────────────────────────────────────────────────────────────────────────────────────────────── */

test("N4) risks: funding by who pays, liquidation in daily ranges, unlock overhang, volatility, thin volume; worst first, ≤ 10 words", () => {
  const m = (o) => ({ coin: "X", px: 100, funding: 0.0000125, dayNtlVlm: 5e8, ...o });
  const by = (list, id) => list.find((r) => r.id === id);
  /* Funding: 0.025%/h that longs pay is high for a long, low (and paid to them) for a short. */
  const hot = m({ funding: 0.00025 });
  assert.equal(by(gradeRisks({ market: hot, side: "buy" }), "funding").level, "high");
  assert.match(by(gradeRisks({ market: hot, side: "buy" }), "funding").text, /^Longs pay 0\.0250%\/h funding$/);
  assert.equal(by(gradeRisks({ market: hot, side: "sell" }), "funding").level, "low");
  assert.match(by(gradeRisks({ market: hot, side: "sell" }), "funding").text, /Funding pays shorts/);
  assert.equal(by(gradeRisks({ market: m({ funding: 0.00008 }), side: "buy" }), "funding").level, "medium");
  assert.equal(by(gradeRisks({ market: m({ funding: 0.0000125 }) }), "funding").level, "low");
  /* Liquidation: in typical daily ranges when the daily ATR is known, else by percent. */
  assert.equal(by(gradeRisks({ market: m(), side: "buy", refPx: 100, liqPx: 96, atrD1Pct: 4 }), "liq").level, "high");
  assert.equal(by(gradeRisks({ market: m(), side: "buy", refPx: 100, liqPx: 90, atrD1Pct: 4 }), "liq").level, "medium");
  assert.equal(by(gradeRisks({ market: m(), side: "buy", refPx: 100, liqPx: 60, atrD1Pct: 4 }), "liq").level, "low");
  assert.match(by(gradeRisks({ market: m(), side: "buy", refPx: 100, liqPx: 90, atrD1Pct: 4 }), "liq").text, /^Liquidation 10\.0% away, ≈2\.5 daily ranges$/);
  assert.equal(by(gradeRisks({ market: m(), side: "sell", refPx: 100, liqPx: 103 }), "liq").level, "high", "no ATR: under 5% is high");
  assert.equal(by(gradeRisks({ market: m(), side: "buy", refPx: 100, liqPx: 0 }), "liq").level, "low", "1x long: no liquidation above zero");
  /* Unlock overhang: big and soon is high; the monthly pace counts too. */
  const em = (o) => ({ configured: true, covered: true, nextUnlock: { date: "2026-10-25", inDays: 10, pctCirculating: 2.9, usd: 9e8 }, monthlyPct: null, ...o });
  assert.equal(by(gradeRisks({ market: m(), emission: em() }), "unlock").level, "high");
  assert.match(by(gradeRisks({ market: m(), emission: em() }), "unlock").text, /^Unlock of 2\.9% supply in 10d$/);
  assert.equal(by(gradeRisks({ market: m(), emission: em({ nextUnlock: { inDays: 25, pctCirculating: 0.8 } }) }), "unlock").level, "medium");
  assert.match(by(gradeRisks({ market: m(), emission: em({ nextUnlock: null, monthlyPct: 3.2 }) }), "unlock").text, /Supply grows 3\.2% a month/);
  assert.equal(by(gradeRisks({ market: m(), emission: em({ nextUnlock: null, monthlyPct: 3.2 }) }), "unlock").level, "high");
  /* Tokenomist off, not covered, or unreadable: no unlock risk at all (never a guess). */
  for (const e of [{ configured: false, covered: true }, { configured: true, covered: false }, { configured: true, covered: true, error: "quota" }, null]) {
    assert.equal(by(gradeRisks({ market: m(), emission: e }), "unlock"), undefined);
  }
  /* Volatility and volume. */
  assert.equal(by(gradeRisks({ market: m(), atrD1Pct: 10 }), "volatility").level, "high");
  assert.equal(by(gradeRisks({ market: m(), atrH1Pct: 0.5 }), "volatility").text, "Typical hourly range 0.5%");
  assert.equal(by(gradeRisks({ market: m({ dayNtlVlm: 4e5 }) }), "volume").level, "high");
  assert.match(by(gradeRisks({ market: m({ dayNtlVlm: 4e5 }) }), "volume").text, /^Thin: /);
  assert.equal(by(gradeRisks({ market: m({ dayNtlVlm: 5e6 }) }), "volume").level, "medium");
  /* No data, no row: an unknown funding or volume is left out, never graded as 0. */
  const bare = gradeRisks({ market: { coin: "X", px: 1 } });
  assert.deepEqual(bare, []);
  /* Worst first, and short. */
  const all = gradeRisks({ market: m({ dayNtlVlm: 4e5, funding: 0.0000125 }), side: "buy", refPx: 100, liqPx: 60, atrD1Pct: 6, emission: em() });
  const rank = { high: 2, medium: 1, low: 0 };
  for (let i = 1; i < all.length; i++) assert.ok(rank[all[i - 1].level] >= rank[all[i].level]);
  for (const r of all) assert.ok(words(r.text) <= 10, r.text);
});

/* ── the RR suggestion ────────────────────────────────────────────────────────────────────────────────────────── */

const setupOf = (o = {}) => {
  const r = buildSetups({ market: HYPE, candles: shaped(HYPE.px, { bars: 48, ...UP }), freeUsdc: 100, side: "buy", now: NOW });
  return { ...r.setups.find((s) => s.label === (o.label || "Balanced")), ...o };
};
const tr = (h1, h4, d1) => ({ h1: h1 && { dir: h1 }, h4: h4 && { dir: h4 }, d1: d1 && { dir: d1 } });

test("N5) RR: against the 4h / 1d trend a nearer TP and less leverage; with both a further TP (≤ 3); in a range the TP at the edge", () => {
  const s = setupOf();
  assert.equal(s.leverage, 2);
  assert.equal(s.rr, 2);
  const against = adjustSetup({ setup: s, market: HYPE, trend: tr("up", "down", "up") });
  assert.equal(against.suggested.rr, RR_AGAINST);
  assert.equal(against.suggested.lev, 1);
  assert.match(against.suggested.why, /^Against the 4h trend: nearer TP, less leverage/);
  assert.equal(against.adjustedSetup.side, "buy", "the same side: never the opposite trade");
  assert.ok(against.adjustedSetup.tpPx < s.tpPx, "a nearer TP");
  assert.ok(Math.abs(against.adjustedSetup.slPx - s.slPx) / s.entryPx < 0.001, "the stop stays where the chart put it");
  const withIt = adjustSetup({ setup: s, market: HYPE, trend: tr("up", "up", "up") });
  assert.equal(withIt.suggested.rr, 2.5);
  assert.equal(withIt.suggested.lev, 2, "never more leverage");
  assert.ok(withIt.adjustedSetup.tpPx > s.tpPx);
  const bold = adjustSetup({ setup: setupOf({ label: "Bolder" }), market: HYPE, trend: tr("up", "up", "up") });
  assert.ok(bold.suggested.rr <= RR_MAX);
  /* A range: the TP no further than the range's top. */
  const edge = s.entryPx + (s.tpPx - s.entryPx) * 0.6;
  const range = adjustSetup({ setup: s, market: HYPE, trend: tr("range", "range", "up"), flip: { upAbove: edge, downBelow: s.entryPx * 0.98 } });
  assert.match(range.suggested.why, /4h range: TP at the range top/);
  assert.ok(Math.abs(range.adjustedSetup.tpPx - edge) / edge < 0.002);
  /* Nothing to change: the same numbers, "Keep it", and no adjusted setup to offer. */
  const keep = adjustSetup({ setup: s, market: HYPE, trend: tr("range", "range", "range"), flip: { upAbove: s.tpPx * 1.1, downBelow: null } });
  assert.equal(keep.adjustedSetup, null);
  assert.match(keep.suggested.why, /^Keep it/);
  assert.equal(keep.suggested.rr, s.rr);
  /* Never "it fits" without the data to say so, and never "it fits" against the trend. */
  assert.match(adjustSetup({ setup: s, market: HYPE, trend: tr("up", null, null) }).suggested.why, /Not enough 4h \/ 1d data/);
  const safest = adjustSetup({ setup: setupOf({ label: "Safer" }), market: HYPE, trend: tr("up", "down", "down") });
  assert.equal(safest.adjustedSetup, null);
  assert.match(safest.suggested.why, /^Against the 4h and 1d trend, already at its safest/);
  /* High funding the side pays, a big unlock soon under a long, high volatility: one step less leverage each. */
  const risky = adjustSetup({ setup: setupOf({ label: "Bolder" }), market: HYPE, trend: tr("up", "up", "up"), risks: [{ id: "funding", level: "high" }, { id: "unlock", level: "high" }] });
  assert.equal(risky.suggested.lev, 1);
  assert.match(risky.suggested.why, /less leverage: high funding, unlock soon/);
});

test("N6) 🔴 RR caps in code: ≤ 3x, ≤ 20 USDC, liquidation LIQ_BUFFER stops away, stop before liquidation; the card it makes never sends", () => {
  /* A setup that claims 10x and 500 USDC (an old or forged object) comes back inside the caps. */
  const wild = setupOf({ leverage: 10, marginUsdc: 500 });
  const a = adjustSetup({ setup: wild, market: HYPE, trend: tr("up", "up", "up") });
  assert.ok(a.adjustedSetup.leverage <= SETUP_MAX_LEVERAGE);
  assert.ok(a.adjustedSetup.marginUsdc <= MAX_MARGIN_USDC);
  const liq = estIsolatedLiqPx({ side: "buy", entryPx: a.adjustedSetup.entryPx, leverage: a.adjustedSetup.leverage, maxLeverage: HYPE.maxLeverage });
  const stop = (a.adjustedSetup.entryPx - a.adjustedSetup.slPx) / a.adjustedSetup.entryPx;
  assert.ok(liq === 0 || (a.adjustedSetup.entryPx - liq) / a.adjustedSetup.entryPx >= LIQ_BUFFER * stop - 1e-9);
  assert.ok(a.adjustedSetup.slPx > liq, "the stop sits before liquidation");
  /* The trade card it becomes: caps again, review, recommended; nothing is sent. */
  const c = setupToOpenCard(a.adjustedSetup, { market: HYPE });
  assert.equal(c.kind, "open");
  assert.equal(c.status, "review");
  assert.ok(c.leverage <= SETUP_MAX_LEVERAGE && c.marginUsdc <= MAX_MARGIN_USDC);
  assert.equal(c.setupLabel, "Adjusted");
  /* A short mirrors it. */
  const r = buildSetups({ market: HYPE, candles: shaped(HYPE.px, { bars: 48, ...DOWN }), freeUsdc: 100, side: "sell", now: NOW });
  const sh = adjustSetup({ setup: r.setups[2], market: HYPE, trend: tr("down", "up", "down") });
  assert.equal(sh.adjustedSetup.side, "sell");
  assert.ok(sh.adjustedSetup.slPx > sh.adjustedSetup.entryPx && sh.adjustedSetup.tpPx < sh.adjustedSetup.entryPx);
  /* Garbage in: no suggestion, never a made-up one. */
  assert.equal(adjustSetup({ setup: { ...wild, slPx: null }, market: HYPE }), null);
  assert.equal(adjustSetup({ setup: { ...wild, side: "both" }, market: HYPE }), null);
  assert.equal(adjustSetup({ setup: wild, market: null }), null);
});

/* ── the card ─────────────────────────────────────────────────────────────────────────────────────────────────── */

test("N7) 🔴 the key-off path (no TOKENOMIST_API_KEY today): no Tokenomist read, emission all null with a short note, the rest from candles", async () => {
  const unl = spy(HYPE_UNLOCKS);
  const emi = spy(HYPE_EMISSION);
  const f = candlesBy({ "1h": UP, "4h": UP, "1d": UP });
  const c = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: f, readUnlocks: unl, readEmission: emi, tokenomistOn: false, now: NOW });
  assert.equal(unl.calls.length + emi.calls.length, 0, "not one Tokenomist call");
  assert.deepEqual(c.emission, { configured: false, covered: true, nextUnlock: null, monthlyPct: null, url: null, note: "Tokenomist not connected" });
  assert.ok(!c.risks.some((r) => r.id === "unlock"), "no unlock risk without the data");
  assert.deepEqual(f.calls.map((x) => x.interval), ["1h", "4h", "1d"]);
  assert.deepEqual(f.calls.map((x) => x.bars), ANALYSIS_FRAMES.map((x) => x.bars));
  /* The shared contract. */
  assert.equal(c.kind, "analysis");
  assert.equal(c.coin, "HYPE");
  assert.equal(c.at, NOW);
  assert.equal(c.price, HYPE.px);
  assert.equal(c.fundingPctPerHour, 0.00125);
  assert.equal(c.basis, ANALYSIS_BASIS);
  assert.deepEqual(Object.keys(c.trend), ["h1", "h4", "d1"]);
  assert.deepEqual(["up", "up", "up"], [c.trend.h1.dir, c.trend.h4.dir, c.trend.d1.dir]);
  assert.equal(c.flip.upAbove, null);
  assert.ok(c.flip.downBelow < c.price);
  assert.equal(c.rr.current.label, "Balanced", "no setup given: the app's own Balanced setup");
  assert.equal(c.rr.suggested.rr, 2.5, "all three up: room for a further TP");
  assert.equal(c.adjustedSetup.coin, "HYPE");
  assert.equal(c.tpsl, null);
  assert.equal(c.held, false);
  /* The words: one short line that adds what to change (not the trend row again); the model's summary says not to
     quote unlocks. */
  /* Pass-2 fix: nobody picked a setup here (the card weighs the app's default one), so the line says nothing about
     "the 2x long"; a setup the user picked or named still gets its sentence. */
  assert.equal(c.rr.current.source, "default");
  assert.equal(analysisLine(c), "HYPE: up on all three timeframes.");
  assert.equal(analysisLine(c, "th"), "HYPE: ขาขึ้นทั้ง 3 กรอบเวลา");
  const named = { ...c, rr: { ...c.rr, current: { ...c.rr.current, source: "words" } } };
  assert.equal(analysisLine(named), "HYPE: up on all three timeframes. The 2x long goes with the 4h and 1d trend; see the suggested change.");
  assert.match(analysisLine(named, "th"), /^HYPE: ขาขึ้นทั้ง 3 กรอบเวลา · 2x long ไปทางเดียวกับเทรนด์ 4h, 1d/);
  assert.doesNotMatch(analysisLine(c), /\$/, "no figure the card already prints");
  assert.equal(c.rr.current.source, "default", "nobody picked a setup: the card says it is the default one");
  assert.match(analysisForModel(c).rr_of, /default Balanced setup/);
  const r = analysisForModel(c);
  assert.match(r.emission, /not connected: never quote unlock/);
  assert.match(r.turns_down_below, /typical 4h ranges away/);
  assert.match(r.note, /never a date/);
  assert.doesNotMatch(JSON.stringify(r), /0x[0-9a-f]{40}/i, "no address");
  assert.match(analysisNote(c), /^Showed the HYPE analysis: 1h up, 4h up, 1d up; turns down below/);
});

test("N8) a coin Tokenomist does not cover (key on): no read, 'No Tokenomist data'; covered + key on: next unlock, % of circulating, USD, monthly pace", async () => {
  const unl = spy(HYPE_UNLOCKS);
  const xrp = await analyzeMarket({ coin: "XRP", snapshot, backend: guest, fetchCandles: candlesBy({}), readUnlocks: unl, tokenomistOn: true, now: NOW });
  assert.equal(unl.calls.length, 0);
  assert.deepEqual([xrp.emission.configured, xrp.emission.covered, xrp.emission.nextUnlock, xrp.emission.monthlyPct], [true, false, null, null]);
  assert.equal(xrp.emission.note, "No Tokenomist data for XRP");
  const emi = spy(HYPE_EMISSION);
  const c = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: candlesBy({ "1h": UP, "4h": UP, "1d": UP }), readUnlocks: unl, readEmission: emi, tokenomistOn: true, now: NOW });
  assert.deepEqual(unl.calls.map((x) => [x.coin, x.o.days]), [["HYPE", 90]]);
  assert.deepEqual(emi.calls.map((x) => [x.coin, x.o.days]), [["HYPE", 90]]);
  assert.equal(c.emission.configured, true);
  assert.equal(c.emission.covered, true);
  assert.deepEqual(c.emission.nextUnlock, { date: "2026-10-25", inDays: 10, pctCirculating: 2.92, usd: Math.round(9_920_000 * HYPE.px * 100) / 100, amount: 9_920_000 });
  assert.equal(c.emission.monthlyPct, monthlyEmissionPct({ weeks: HYPE_EMISSION.weeks, circulatingSupply: 340_000_000 }));
  assert.ok(Math.abs(c.emission.monthlyPct - 3.2) < 0.01);
  assert.equal(c.emission.url, "https://tokenomist.ai/hyperliquid");
  const u = c.risks.find((r) => r.id === "unlock");
  assert.equal(u.level, "high");
  /* A big unlock in 10 days under a long: one step less leverage. */
  assert.match(c.rr.suggested.why, /unlock soon/);
  const r = analysisForModel(c);
  assert.match(r.emission.next_unlock, /^2026-10-25 \(in 10 days\), 2\.92% of circulating/);
  assert.equal(r.emission.source, "Tokenomist; scheduled, not certain");
  /* The server has no key after all (503 not_configured): "not connected", nulls. */
  const off = await emissionOf({ coin: "HYPE", tokenomistOn: true, readUnlocks: async () => ({ configured: false, coin: "HYPE" }), now: NOW });
  assert.deepEqual([off.configured, off.nextUnlock, off.monthlyPct, off.note], [false, null, null, "Tokenomist not connected"]);
  /* Unreadable (quota, network): an error note, never "no unlocks". */
  const bad = await emissionOf({ coin: "HYPE", tokenomistOn: true, readUnlocks: async () => ({ configured: true, error: "quota", coin: "HYPE" }), now: NOW });
  assert.equal(bad.error, "quota");
  assert.equal(bad.nextUnlock, null);
  assert.match(bad.note, /Couldn't read unlocks/);
  /* A reader that never answers is cut off: still a card. */
  const slow = await emissionOf({ coin: "HYPE", tokenomistOn: true, readUnlocks: () => new Promise(() => {}), now: NOW, timeoutMs: 20 });
  assert.equal(slow.nextUnlock, null);
  /* The pace from weekly rows: unknown circulating or no rows → null. */
  assert.equal(monthlyEmissionPct({ weeks: HYPE_EMISSION.weeks, circulatingSupply: null }), null);
  assert.equal(monthlyEmissionPct({ weeks: [], circulatingSupply: 1 }), null);
});

test("N9) 🔴 a HELD position: a TP / SL card for it (same side, stop before liquidation), never a new or opposite position", async () => {
  const orders = [
    { coin: "ETH", tpsl: "tp", isTrigger: true, triggerPx: ETH.px * 1.1, limitPx: null, side: "sell" },
    { coin: "ETH", tpsl: "sl", isTrigger: true, triggerPx: ETH.px * 0.95, limitPx: null, side: "sell" },
  ];
  const backend = live({ orders });
  /* Even when the words name the other side ("Analyze ETH short"). */
  const c = await analyzeMarket({ coin: "ETH", snapshot, backend, fetchCandles: candlesBy({ "1h": DOWN, "4h": DOWN, "1d": UP }), tokenomistOn: false, side: "sell", now: NOW });
  assert.equal(c.held, true);
  assert.equal(c.adjustedSetup, null, "no trade to open");
  assert.equal(analysisOpenCard(c, { market: ETH }), null);
  assert.equal(c.tpsl.kind, "tpsl");
  assert.equal(c.tpsl.coin, "ETH");
  assert.equal(c.tpsl.status, "review");
  assert.deepEqual([c.rr.current.side, c.rr.current.lev, c.rr.current.entry, c.rr.current.source], ["buy", 5, ETH.px, "position"]);
  assert.equal(c.rr.current.tp, ETH.px * 1.1);
  assert.equal(c.rr.current.sl, ETH.px * 0.95);
  assert.equal(c.rr.current.rr, 2);
  assert.equal(c.rr.suggested.side, "buy", "the position's own side");
  assert.ok(c.rr.suggested.sl < ETH.markPx && c.rr.suggested.sl > ethPos.liquidationPx, "stop under the mark, before liquidation");
  assert.ok(c.rr.suggested.tp > ETH.markPx);
  /* The user's far TP pays more than a nearer one for the tighter stop: it stays (left out of the card), and only
     the stop moves. The why says that move first, from the mark, then the trend as the reason. */
  assert.equal(c.rr.suggested.tp, ETH.px * 1.1);
  assert.equal(c.tpsl.tpPct, null, "a TP that stays is left out of the card (the editor keeps it)");
  assert.ok(c.tpsl.slPct > 0);
  assert.ok(c.rr.suggested.rr > c.rr.current.rr, "only a change that pays more for the risk is offered");
  assert.match(c.rr.suggested.why, /^Stop up to \$[\d,.]+ \(-[\d.]+%\): RR 1 : [\d.]+\. Against the 4h trend$/);
  assert.match(analysisLine(c), /^ETH: 1h and 4h down, 1d up\. Your stop is 5\.\d% away; see the suggested one\.$/);
  /* No stop set yet: the suggestion says it adds one (and a TP). */
  const bare = await analyzeMarket({ coin: "ETH", snapshot, backend: live(), fetchCandles: candlesBy({ "1h": DOWN, "4h": DOWN, "1d": UP }), now: NOW });
  assert.equal(bare.rr.current.sl, null);
  assert.equal(bare.rr.current.rr, null, "no TP / SL now: no RR now (never 0)");
  assert.match(bare.rr.suggested.why, /^Adds a stop at \$[\d,.]+ \(-[\d.]+%\) and a TP at \$[\d,.]+ \(\+[\d.]+%\): RR 1 : /);
  assert.ok(bare.tpsl.tpPct > 0 && bare.tpsl.slPct > 0);
  assert.ok(c.risks.some((r) => r.id === "liq"), "its liquidation distance is graded");
  /* Against the trend the TP aims nearer than with it (no legs set: nothing of the user's to keep). */
  const w = await analyzeMarket({ coin: "ETH", snapshot, backend: live(), fetchCandles: candlesBy({ "1h": UP, "4h": UP, "1d": UP }), tokenomistOn: false, now: NOW });
  assert.ok(w.rr.suggested.tp > bare.rr.suggested.tp);
  /* The RR is from the mark (what is at stake from here): a long 3% under water still shows what the change does. */
  const under = { ...ethPos, entryPx: ETH.markPx * 1.03, liquidationPx: ETH.markPx * 0.82 };
  const u = await analyzeMarket({ coin: "ETH", snapshot, backend: live({ positions: [under], orders }), fetchCandles: candlesBy({ "1h": UP, "4h": UP, "1d": UP }), now: NOW });
  assert.deepEqual([u.rr.current.rrFrom, u.rr.current.mark, u.rr.suggested.rrFrom], ["mark", ETH.markPx, "mark"]);
  assert.ok(u.rr.suggested.rr >= 2, "from here, the suggested TP / SL pays at least twice its risk");
  assert.equal(u.tpsl.kind, "tpsl");
  assert.equal(adjustHeld({ position: null, market: ETH }).tpsl, null);
  assert.match(analysisForModel(c).card_offers, /TP \/ SL card for the held position/);
});

/* A held position, built by hand: a market, 1h candles, the trend, the orders. */
const heldCase = ({ side = "long", entry = 2000, mark = 2500, lev = 3, liq = null, tp = null, sl = null, trend = tr("down", "down", "down"), atrD1Pct = 4 } = {}) => {
  const market = { ...ETH, px: mark, markPx: mark, szDecimals: 4 };
  const pos = { coin: "ETH", side, szi: side === "long" ? 0.1 : -0.1, entryPx: entry, leverage: { type: "isolated", value: lev }, liquidationPx: liq ?? estIsolatedLiqPx({ side: side === "long" ? "buy" : "sell", entryPx: entry, leverage: lev, maxLeverage: ETH.maxLeverage }) };
  const orders = [tp != null ? { coin: "ETH", tpsl: "tp", triggerPx: tp } : null, sl != null ? { coin: "ETH", tpsl: "sl", triggerPx: sl } : null].filter(Boolean);
  return adjustHeld({ position: pos, market, candles: shaped(mark, { bars: 48, ...DOWN }), trend, orders, atrD1Pct });
};

test("N17) 🔴 a held long in profit with a stop that locks it in: the stop is never moved back under it ('Keep it', no card)", () => {
  /* The review's case: entry 2000, mark 2500, TP 2700, SL 2420 (about +63% ROE locked), 4h / 1d down. */
  const a = heldCase({ entry: 2000, mark: 2500, tp: 2700, sl: 2420 });
  assert.equal(a.rr.current.rr, 2.5);
  assert.equal(a.rr.suggested.sl, 2420, "the user's stop stays");
  assert.equal(a.rr.suggested.tp, 2700, "the user's TP stays");
  assert.equal(a.tpsl, null, "nothing to set");
  assert.match(a.rr.suggested.why, /^Keep it/);
  /* Trends up, or no trend data: the same. A suggestion never puts a stop under the one the user has. */
  for (const trend of [tr("up", "up", "up"), null]) {
    const b = heldCase({ entry: 2000, mark: 2500, tp: 2700, sl: 2420, trend });
    assert.ok(b.rr.suggested.sl >= 2420, "never a stop below the current one");
    assert.ok(b.tpsl == null || b.tpsl.slPct == null);
  }
  /* A short mirrors it: a stop under its entry (locking profit) stays. */
  const s = heldCase({ side: "short", entry: 2500, mark: 2000, tp: 1800, sl: 2080, trend: tr("up", "up", "up") });
  assert.ok(s.rr.suggested.sl <= 2080);
  assert.ok(s.tpsl == null || s.tpsl.slPct == null);
  /* The stop alone would not help but a further TP pays more: only the TP moves, and the why says so. */
  const t = heldCase({ entry: 2000, mark: 2500, tp: 2520, sl: 2420, trend: tr("up", "up", "up") });
  if (t.tpsl) {
    assert.equal(t.tpsl.slPct, null);
    assert.match(t.rr.suggested.why, /^Further TP at /);
    assert.ok(t.rr.suggested.rr > t.rr.current.rr);
  }
});

test("N18) a held position's suggested stop keeps half a daily range from the mark; the why says the stop move first, with its distance", () => {
  /* ETH long 5x under water, its stop far: the suggestion tightens the stop, but never inside half a daily range. */
  const atr = 3.9;
  const a = heldCase({ entry: 2422.2, mark: 2374, lev: 5, liq: 1977.3, tp: 2546.4, sl: 2250, atrD1Pct: atr });
  const away = (2374 - a.rr.suggested.sl) / 2374 * 100;
  assert.ok(away >= atr * MIN_STOP_D1 - 0.01, `stop ${away.toFixed(2)}% from the mark, at least ${atr * MIN_STOP_D1}%`);
  assert.match(a.rr.suggested.why, /^Stop up to \$2,3[\d.,]+ \(-[\d.]+%\)/);
  assert.match(a.rr.suggested.why, /RR 1 : [\d.]+\. Against the 4h and 1d trend$/);
  assert.equal(a.rr.suggested.tp, 2546.4, "the TP pays more as it is: kept");
  /* Liquidation leaves no room outside the noise: a stop the user has stays ("Keep it"), never one inside it. */
  const tight = heldCase({ entry: 2422.2, mark: 2374, lev: 5, liq: 2330, tp: 2546.4, sl: 2335, atrD1Pct: atr });
  assert.equal(tight.rr.suggested.sl, 2335);
  assert.ok(tight.tpsl == null || tight.tpsl.slPct == null);
  /* No stop at all, and no room outside the noise: one is still added (better than none), and the why says it is tight. */
  const none = heldCase({ entry: 2422.2, mark: 2374, lev: 5, liq: 2300, atrD1Pct: atr });
  assert.ok(none.tpsl && none.tpsl.slPct > 0);
  assert.match(none.rr.suggested.why, /tight: liquidation is near/);
});

test("N19) a held position's why matches its numbers: a further TP is never called nearer, a missing TP is 'adds', the stop is measured from the mark", () => {
  /* The review's case (a): trends down, the user's TP 2440 is NEARER than the suggestion. */
  const a = heldCase({ entry: 2422.2, mark: 2376.1, lev: 5, liq: 1977.3, tp: 2440, sl: 2250, atrD1Pct: 3.9 });
  if (a.rr.suggested.moved && a.rr.suggested.moved.tp) {
    const further = Math.abs(a.rr.suggested.tp - 2376.1) > Math.abs(2440 - 2376.1);
    assert.match(a.rr.suggested.why, further ? /further TP/ : /nearer TP/);
  }
  assert.doesNotMatch(a.rr.suggested.why, /a nearer TP, a tighter stop/);
  /* (c) no TP set: "adds", never "nearer". */
  const c = heldCase({ entry: 2422.2, mark: 2376.1, lev: 5, liq: 1977.3, sl: 2250, atrD1Pct: 3.9 });
  assert.match(c.rr.suggested.why, /a TP at /);
  assert.doesNotMatch(c.rr.suggested.why, /nearer|further/);
  /* Every distance printed is from the mark. */
  for (const x of [a, c]) {
    const m = /\(([+-][\d.]+)%\)/.exec(x.rr.suggested.why);
    if (m && x.rr.suggested.moved.sl) assert.equal(Number(m[1]), Number(((x.rr.suggested.sl / 2376.1 - 1) * 100).toFixed(1)));
  }
});

test("N20) a range: 'TP at the range top' only when the top is at least one stop away; nearer, the entry is at the edge and nothing is moved past it", () => {
  const s = setupOf();
  const slDist = s.entryPx - s.slPx;
  /* The top half a stop away: the TP is not pushed past it, and the card says the entry is near the top. */
  const near = adjustSetup({ setup: s, market: HYPE, trend: tr("range", "range", "range"), flip: { upAbove: s.entryPx + slDist * 0.5, downBelow: null } });
  assert.doesNotMatch(near.suggested.why, /TP at the range top/);
  assert.match(near.suggested.why, /entry is near the 4h range top/);
  assert.equal(near.suggested.tp, s.tpPx, "the TP stays where it was");
  /* The top 1.2 stops away: the TP sits at the top, as said. */
  const far = adjustSetup({ setup: s, market: HYPE, trend: tr("range", "range", "range"), flip: { upAbove: s.entryPx + slDist * 1.2, downBelow: null } });
  assert.match(far.suggested.why, /4h range: TP at the range top/);
  assert.ok(Math.abs(far.adjustedSetup.tpPx - (s.entryPx + slDist * 1.2)) / s.entryPx < 0.002);
});

test("N21) a leg the suggestion does not move keeps the setup's own price (a leverage-only change is drawn as one)", () => {
  const s = setupOf({ label: "Bolder" });
  assert.equal(s.leverage, 3);
  /* High volatility: one step less leverage, nothing else. */
  const a = adjustSetup({ setup: s, market: HYPE, trend: tr("range", "range", "range"), risks: [{ id: "volatility", level: "high" }] });
  assert.equal(a.suggested.lev, 2);
  assert.equal(a.suggested.tp, s.tpPx, "same TP price, not a re-rounded one");
  assert.equal(a.suggested.sl, s.slPx, "same stop price");
  assert.deepEqual(a.suggested.moved, { tp: false, sl: false, lev: true });
  assert.equal(a.suggested.rr, s.rr);
  assert.equal(analysisLine({ coin: "HYPE", trend: tr("range", "range", "range"), rr: { current: { side: "buy", lev: 3 }, suggested: a.suggested } }), "HYPE: sideways on all three timeframes. The 3x long has no clear 4h / 1d trend behind it; see the suggested change.");
});

test("N22) 🔴 the Analyze pill under a pending trade card weighs THAT card: its side, its leverage, its liquidation; never the other side", async () => {
  const tradeCard = { kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 10, tpPct: 25, slPct: 10, status: "review", setupLabel: null };
  const s = setupFromCard(tradeCard, ETH, { now: NOW });
  assert.deepEqual([s.side, s.leverage, s.marginUsdc, s.source, s.entryPx], ["buy", 10, 20, "card", ETH.px]);
  assert.equal(s.liqPx, estIsolatedLiqPx({ side: "buy", entryPx: ETH.px, leverage: 10, maxLeverage: ETH.maxLeverage }));
  assert.ok(Math.abs(s.slPx - ETH.px * 0.99) < 1e-6 && Math.abs(s.tpPx - ETH.px * 1.025) < 1e-6);
  /* 1h lean down, and the words say nothing of a side: still the card's long. */
  const c = await analyzeMarket({ coin: "ETH", snapshot, backend: guest, fetchCandles: candlesBy({ "1h": DOWN, "4h": DOWN, "1d": DOWN }), card: tradeCard, now: NOW });
  assert.deepEqual([c.rr.current.side, c.rr.current.lev, c.rr.current.source], ["buy", 10, "card"]);
  const liq = c.risks.find((r) => r.id === "liq");
  const gap = ((ETH.px - s.liqPx) / ETH.px) * 100;
  assert.match(liq.text, new RegExp(`^Liquidation ${gap.toFixed(1).replace(".", "\\.")}% away`), "the card's own 10x liquidation");
  assert.ok(!c.adjustedSetup || c.adjustedSetup.side === "buy", "never an adjusted setup on the other side");
  if (c.adjustedSetup) assert.ok(c.adjustedSetup.leverage <= SETUP_MAX_LEVERAGE, "a suggestion stays at 3x or less");
  /* Its words: "Analyze ETH 10x long". */
  assert.equal(analyzePrompt("ETH", { setup: tradeCard }), "Analyze ETH 10x long");
  /* Garbage in: nothing. */
  assert.equal(setupFromCard({ ...tradeCard, side: "both" }, ETH), null);
  assert.equal(setupFromCard({ ...tradeCard, coin: "BTC" }, ETH), null);
  /* Through the intent: the card handed over with the words is the one weighed. */
  chat.clear();
  await askAgent("Analyze ETH 10x long", opts({ fetchCandles: candlesBy({ "1h": DOWN, "4h": DOWN, "1d": DOWN }), subject: { card: tradeCard } }));
  assert.deepEqual([cards()[0].rr.current.source, cards()[0].rr.current.lev], ["card", 10]);
  chat.clear();
});

test("N23) stocks: a listed stock is analyzable (pass 2: its row is the US market's state); an unlisted venue market never analyzes the page's market instead", async () => {
  assert.equal(analyzable("xyz:TSLA"), true, "a whitelisted stock: its analysis reads the US market, not Tokenomist");
  assert.equal(analyzable("xyz:GOLD"), false, "not a stock FlowFlow lists");
  assert.equal(analyzable("USDC"), false);
  assert.equal(analyzable("ETH"), true);
  const d = detectIntent("Analyze xyz:GOLD", { coins: COINS, contextCoin: "ETH" });
  assert.deepEqual([d.kind, d.coin, d.venue], ["analyze", null, true]);
  assert.equal(detectIntent("Analyze", { coins: COINS, contextCoin: "ETH" }).coin, "ETH", "no market named: the page's");
  assert.equal(detectIntent("Analyze HYPE", { coins: COINS, contextCoin: "ETH" }).coin, "HYPE");
  chat.clear();
  await askAgent("Analyze xyz:GOLD", opts());
  assert.match(said()[0], /isn't listed/);
  assert.ok(!cards().some((c) => c.kind === "analysis"));
  chat.clear();
});

test("N24) follow-up chips follow the newest card: never a fixed 5x long, never more of a side the analysis called down, in words at 3x or less", () => {
  const all = (o) => chipsFor(o).map((c) => c.label);
  const texts = (o) => chipsFor(o).map((c) => c.text);
  /* After the analysis of a held ETH long that calls it down: TP / SL on it, another held coin, movers, PnL. */
  const an = { kind: "analysis", coin: "ETH", held: true, trend: tr("down", "down", "down") };
  assert.deepEqual(all({ cards: [an], coin: "ETH", held: ["ETH", "BTC"] }), ["TP / SL on ETH", "Analyze BTC", "Top movers", "My PnL"]);
  /* Not held, called down: its setups (they follow the trend's side), no long chip. */
  const zec = { kind: "analysis", coin: "ZEC", held: false, trend: tr("down", "down", "down") };
  assert.ok(!texts({ cards: [zec], coin: "ZEC" }).some((t) => /^Long /.test(t)));
  assert.equal(texts({ cards: [zec], coin: "ZEC" })[0], "Setups for ZEC");
  /* Nothing on screen yet: a trade chip in words, 3x, never 5x; after a down analysis of that market, the short. */
  assert.equal(all({ coin: "ETH" })[0], "Long ETH · 20 USDC · 3x");
  assert.equal(all({ cards: [{ kind: "assets", items: [] }, { ...an, held: false }], coin: "ETH" })[0], "Short ETH · 20 USDC · 3x");
  for (const o of [{}, { cards: [an] }, { cards: [zec] }, { coin: "BTC", held: ["BTC"] }, { cards: [{ kind: "stake" }] }]) {
    for (const t of texts(o)) assert.doesNotMatch(t, /\b([4-9]|\d{2,})x\b|tp \d|sl \d/i, t);
    assert.ok(chipsFor(o).length <= 4);
  }
  /* The trade chip's words are a real order sentence: a card at 3x with 20 USDC (still waits for Confirm). */
  const sc = parseShortcut("Long ETH · 20 USDC · 3x", COINS);
  assert.deepEqual([sc.kind, sc.side, sc.coin, sc.marginUsdc, sc.leverage], ["open", "buy", "ETH", 20, 3]);
  /* A stock's chips name its ticker, never the venue; a market FlowFlow does not list never gets a chip. */
  const st = chipsFor({ cards: [{ kind: "analysis", coin: "xyz:TSLA" }], coin: "xyz:TSLA" });
  assert.ok(st.some((c) => c.text === "Setups for TSLA"));
  assert.ok(!st.some((c) => /xyz/i.test(`${c.text} ${c.label}`)));
  assert.ok(!chipsFor({ cards: [{ kind: "analysis", coin: "xyz:GOLD" }], coin: "xyz:GOLD" }).some((c) => (c.coin || "").includes(":")));
});

test("N10) unknown is null, never 0: charts that fail, a market with no funding or volume", async () => {
  const c = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: candlesBy({}, { fail: ["1h", "4h", "1d"] }), tokenomistOn: false, now: NOW });
  assert.deepEqual([c.trend.h1, c.trend.h4, c.trend.d1], [null, null, null]);
  assert.deepEqual([c.flip.upAbove, c.flip.downBelow], [null, null]);
  assert.deepEqual(c.rr, { current: null, suggested: null }, "no chart, no setup: nothing invented");
  assert.equal(c.adjustedSetup, null);
  assert.match(analysisLine(c), /charts couldn't be read/);
  const bare = { ...HYPE, funding: null, dayNtlVlm: null, change24hPct: null };
  const b = await analyzeMarket({ coin: "HYPE", market: bare, backend: guest, fetchCandles: candlesBy({ "1h": UP }, { fail: ["4h", "1d"] }), tokenomistOn: false, now: NOW });
  assert.deepEqual([b.fundingPctPerHour, b.volume24hUsd, b.change24hPct], [null, null, null]);
  assert.equal(b.trend.h1.dir, "up");
  assert.equal(b.trend.d1, null);
  assert.ok(!b.risks.some((r) => r.id === "funding" || r.id === "volume"));
  /* A candle reader that hangs is cut off. */
  const hang = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: () => new Promise(() => {}), tokenomistOn: false, now: NOW, timeoutMs: 20 });
  assert.equal(hang.trend.h4, null);
  /* The words limits hold on every card built here. */
  for (const x of [c, b, await card0()]) {
    for (const k of ["h1", "h4", "d1"]) if (x.trend[k]) assert.ok(words(x.trend[k].note) <= 6);
    for (const r of x.risks) assert.ok(words(r.text) <= 10, r.text);
  }
});

test("N11) the setup the pill sat on is the one analyzed; its words pick the profile and side ('Analyze ETH long Bolder')", async () => {
  const d = (t, o) => detectIntent(t, { coins: COINS, ...o });
  assert.deepEqual([d("Analyze ETH long Bolder").kind, d("Analyze ETH long Bolder").side, d("Analyze ETH long Bolder").profile], ["analyze", "buy", "Bolder"]);
  assert.deepEqual([d("Analyze HYPE with Tokenomist").coin, d("Analyze HYPE with Tokenomist").profile, d("Analyze HYPE with Tokenomist").side], ["HYPE", null, null]);
  assert.equal(d("Analyze HYPE").kind, "analyze", "the plain pill (key off) is the same ask");
  assert.equal(d("วิเคราะห์ SOL safer").profile, "Safer");
  const f = candlesBy({ "1h": UP, "4h": UP, "1d": UP });
  const bold = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: f, profile: "Bolder", side: "buy", now: NOW });
  assert.equal(bold.rr.current.label, "Bolder");
  const given = { ...setupOf({ label: "Safer" }) };
  const g = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: f, setup: given, now: NOW });
  assert.equal(g.rr.current.label, "Safer");
  assert.equal(g.rr.current.tp, given.tpPx);
  /* A setup for another market is not this market's. */
  const other = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: f, setup: { ...given, coin: "ETH" }, now: NOW });
  assert.equal(other.rr.current.label, "Balanced");
});

/* ── the Agent: intent, tool, prompt ──────────────────────────────────────────────────────────────────────────── */

const never = async () => ({ status: 500, json: async () => ({ message: "SHOULD NOT BE ASKED" }) });
const opts = (o = {}) => ({ backend: guest, getSnapshot: () => snapshot, fetchCandles: candlesBy({ "1h": UP, "4h": UP, "1d": UP }), readApy: async () => ({ apyPct: 5.78 }), tokenomist: false, earnEnabled: false, fetchImpl: never, ...o });
const cards = () => chat.get().messages.filter((m) => m.role === "card").map((m) => m.card);
const said = () => chat.get().messages.filter((m) => m.role === "assistant").map((m) => m.text);

test("N12) 'Analyze HYPE' (the pill's words): ONE analysis card and one short line, its reads shown as steps, the model never asked", async () => {
  chat.clear();
  await askAgent("Analyze HYPE", opts());
  assert.deepEqual(cards().map((c) => c.kind), ["analysis"]);
  assert.equal(said().length, 1);
  assert.match(said()[0], /^HYPE: up on all three timeframes\./);
  const steps = chat.get().messages.filter((m) => m.role === "status");
  assert.deepEqual(steps.map((s) => [s.tool, s.coin, s.state]), [["get_analysis", "HYPE", "done"]], "key off: no unlocks step");
  assert.equal(steps[0].text, "Read HYPE 1h · 4h · 1d charts");
  assert.match(chat.get().llm.at(-1).content, /Showed the HYPE analysis/);
  /* Key on, covered: the unlocks step too, with the Tokenomist read in the card. */
  chat.clear();
  await askAgent("Analyze HYPE with Tokenomist", opts({ tokenomist: true, readUnlocks: async () => HYPE_UNLOCKS, readEmission: async () => HYPE_EMISSION }));
  assert.deepEqual(cards().map((c) => c.kind), ["analysis"]);
  assert.equal(cards()[0].emission.nextUnlock.date, "2026-10-25");
  assert.deepEqual(chat.get().messages.filter((m) => m.role === "status").map((s) => s.tool), ["get_analysis", "get_unlocks"]);
  assert.ok(chat.get().messages.filter((m) => m.role === "status").every((s) => s.state === "done"));
  /* Held (ETH): its card carries the TP / SL suggestion, and still only one card. */
  chat.clear();
  await askAgent("Analyze ETH short", opts({ backend: live() }));
  assert.deepEqual(cards().map((c) => c.kind), ["analysis"]);
  assert.equal(cards()[0].tpsl.kind, "tpsl");
  assert.equal(cards()[0].adjustedSetup, null);
  /* No coin: which one? */
  chat.clear();
  await askAgent("analyze", opts());
  assert.match(said()[0], /Which coin/);
  assert.equal(chat.get().busy, false);
  chat.clear();
});

test("N13) get_analysis: a read tool (no address), its card shown by the loop; describeCard and the prompt know it", async () => {
  assert.ok(READ_TOOLS.includes("get_analysis") && isReadTool("get_analysis"));
  const t = TOOLS.find((x) => x.function.name === "get_analysis");
  assert.deepEqual(Object.keys(t.function.parameters.properties), ["coin"]);
  assert.match(t.function.description, /levels, never dates/);
  assert.ok(toolsFor({ unlocks: false }).some((x) => x.function.name === "get_analysis"), "offered without a Tokenomist key");
  const ctx = { snapshot, backend: guest, fetchCandles: candlesBy({ "1h": UP, "4h": DOWN, "1d": UP }), tokenomist: false, now: () => NOW };
  const r = await runToolCall("get_analysis", { coin: "hype" }, ctx);
  assert.equal(r.card.kind, "analysis");
  assert.equal(r.result.coin, "HYPE");
  assert.match(r.result.trend["4h"], /^down/);
  assert.ok(r.result.turns_up_above);
  assert.doesNotMatch(JSON.stringify(r.result), /0x[0-9a-f]{40}/i);
  assert.match((await runToolCall("get_analysis", { coin: "NOPE" }, ctx)).result.error, /No market called NOPE/);
  /* Steps through analysisFor: one for the charts. */
  const seen = [];
  await analysisFor({ ...ctx, step: (tool, coin, w) => { seen.push([tool, coin, w && w.run]); return () => {}; } }, "HYPE");
  assert.deepEqual(seen, [["get_analysis", "HYPE", "Reading HYPE 1h · 4h · 1d charts…"]]);
  /* The loop: the model calls get_analysis, the card shows, the loop goes on to its words; no second Analyze pill. */
  chat.clear();
  const answers = [
    { message: { role: "assistant", content: "", tool_calls: [{ id: "g1", type: "function", function: { name: "get_analysis", arguments: JSON.stringify({ coin: "HYPE" }) } }] } },
    { message: { role: "assistant", content: "HYPE turns down below the level on the card." } },
  ];
  let n = 0;
  const api = async () => ({ status: 200, json: async () => answers[n++] || answers.at(-1) });
  await askAgent("when does hype turn down?", opts({ fetchImpl: api }));
  assert.equal(cards()[0].kind, "analysis");
  const line = chat.get().messages.find((m) => m.role === "assistant");
  assert.equal(line.analyze, undefined, "the analysis is already on screen");
  assert.ok(chat.get().llm.some((m) => m.role === "tool" && m.tool_call_id === "g1"));
  chat.clear();
  /* History and prompt. */
  const card = await card0();
  assert.match(describeCard(card), /^Showed the HYPE analysis/);
  assert.match(systemPrompt(), /get_analysis/);
  assert.match(systemPrompt(), /never on a date/);
  assert.match(systemPrompt({ unlocks: false }), /never quote unlock figures/);
});

test("N14) Analyze is always on the boxes: 'with Tokenomist' only with the key on and a covered coin, plain 'Analyze' otherwise", () => {
  const off = suggestAssets(assetState({ backend: guest, snapshot, tokenomist: false }), { surface: "after", focus: ["HYPE"] });
  assert.deepEqual(off[0].actions.find((a) => a.id === "analyze"), { id: "analyze", label: "Analyze", prompt: "Analyze HYPE" });
  const on = suggestAssets(assetState({ backend: guest, snapshot, tokenomist: true }), { surface: "after", focus: ["HYPE"] });
  assert.equal(on[0].actions.find((a) => a.id === "analyze").prompt, "Analyze HYPE with Tokenomist");
  const xrp = suggestAssets(assetState({ backend: guest, snapshot, tokenomist: true }), { surface: "after", focus: ["XRP"] });
  assert.equal(xrp[0].actions.find((a) => a.id === "analyze").prompt, "Analyze XRP", "not covered: no Tokenomist claim");
  /* A position: TP / SL first, Analyze, Close last (never the primary action). */
  const pos = suggestAssets(assetState({ backend: live(), snapshot, tokenomist: false }), { surface: "account" });
  assert.deepEqual(pos[0].actions.map((a) => a.id), ["tpsl", "analyze", "close"]);
  for (const it of [...off, ...on, ...xrp, ...pos]) assert.deepEqual(lintItem(it), []);
});

test("N15) readEmission (the browser client): our proxy's op=emission, normalized; unknown stays null", async () => {
  const seen = [];
  const fake = (status, body) => async (url) => { seen.push(url); return { status, json: async () => body }; };
  const ok = await readEmission("HYPE", { fetchImpl: fake(200, { ok: true, op: "emission", coin: "HYPE", covered: true, weeks: [{ start: "2026-10-19", amount: 100, valueUsd: null }, { start: "2026-10-26", amount: null }], totalAmount: 100 }) });
  assert.match(seen[0], /^\/api\/tokenomist\?op=emission&coin=HYPE&days=90$/);
  assert.deepEqual(ok, { configured: true, covered: true, coin: "HYPE", weeks: [{ start: "2026-10-19", amount: 100, valueUsd: null }, { start: "2026-10-26", amount: null, valueUsd: null }], totalAmount: 100 });
  assert.deepEqual(await readEmission("HYPE", { fetchImpl: fake(503, { ok: false, error: "not_configured" }) }), { configured: false, coin: "HYPE" });
  assert.deepEqual(await readEmission("HYPE", { fetchImpl: fake(429, { ok: false, error: "quota" }) }), { configured: true, error: "quota", coin: "HYPE" });
  const n = seen.length;
  assert.deepEqual(await readEmission("XRP", { fetchImpl: fake(200, {}) }), { configured: true, covered: false, coin: "XRP" });
  assert.equal(seen.length, n, "an uncovered coin is never asked about");
  assert.deepEqual(await readEmission("HYPE", { fetchImpl: async () => { throw new Error("down"); } }), { configured: true, error: "unavailable", coin: "HYPE" });
});

test("N16) analyzePrompt: the pill's words, read back by the intent to the same coin, side and profile", async () => {
  assert.equal(analyzePrompt("HYPE"), "Analyze HYPE");
  assert.equal(analyzePrompt("HYPE", { tokenomistOn: true }), "Analyze HYPE with Tokenomist");
  assert.equal(analyzePrompt("XRP", { tokenomistOn: true }), "Analyze XRP", "not covered: no Tokenomist claim");
  const s = setupOf({ label: "Bolder" });
  const words = analyzePrompt("HYPE", { setup: s, tokenomistOn: true });
  assert.equal(words, "Analyze HYPE 3x long with Tokenomist", "as a person says it: the leverage and side the box shows");
  const d = detectIntent(words, { coins: COINS });
  assert.deepEqual([d.kind, d.coin, d.side, d.leverage], ["analyze", "HYPE", "buy", 3]);
  assert.equal(parseShortcut(words, COINS), null, "never a trade shortcut");
  /* Typed without the box, the words pick the app's setup at that leverage and side. */
  const c = await analyzeMarket({ coin: "HYPE", snapshot, backend: guest, fetchCandles: candlesBy({ "1h": UP, "4h": UP, "1d": UP }), side: d.side, leverage: d.leverage, now: NOW });
  assert.deepEqual([c.rr.current.label, c.rr.current.source], ["Bolder", "words"]);
  assert.equal(analyzePrompt("", {}), "Analyze");
});
