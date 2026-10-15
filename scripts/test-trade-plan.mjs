/**
 * test-trade-plan — the risk-based plan (owner items 13, 14, 16): ONE normal chat, any phrasing and any amount, and the
 * maths in code, never the model's.
 *
 *   riskParse.js   Thai / English words → the plan's inputs ("ยอมเสียได้ 15 ดอล", "เสียได้ 3%", "มี 300", "RR 3", "1:2",
 *                  "risk $1", "short SOL", "tp sl เท่าไหร่ดี", "เซฟๆ"), and the ONE question when an essential is missing
 *   tradePlan.js   the stop (user / 1h swing / ATR; a stock's from US-market-hours bars only), the size from the risk
 *                  with fees, the LOWEST leverage that fits, liquidation ≥ 2 stops away, the caps (20 USDC margin,
 *                  Agent 10x, stock ≤ market max and 5x while the US market is shut, safe ≤ 3x, $10 minimum), the
 *                  capped version with its real risk, ticks and lots, the card and the model's view
 *
 * No network (fetch throws): markets are Hyperliquid's recorded answers, candles are shaped fakes or recorded ones.
 * Run: node --test scripts/test-trade-plan.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.fetch = () => { throw new Error("no network in tests"); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const { parsePerpMarkets } = await import("../src/lib/hyperliquid/markets.js");
const { parseHlCandles } = await import("../src/lib/hyperliquid/candles.js");
const { planOpenMarket, roundHlOrderPx } = await import("../src/lib/hyperliquid/exchange/orders.js");
const { estIsolatedLiqPx } = await import("../src/perp/perpTicket.js");
const { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } = await import("../src/perp/guardrails.js");
const { perpMarketFeeRate } = await import("../src/perp/live/perpLiveView.js");
const { HL_TAKER_FEE_RATE } = await import("../src/perp/mock/fees.js");
const { usEquitySession } = await import("../src/lib/hyperliquid/hip3/hours.js");
const RP = await import("../src/agent/riskParse.js");
const TP = await import("../src/agent/tradePlan.js");
const { LIQ_BUFFER, SETUP_MAX_LEVERAGE } = await import("../src/agent/setups.js");

const main = parsePerpMarkets(read("scripts/fixtures/hl-meta-and-asset-ctxs.json").response, { now: 1 });
const xyz = parsePerpMarkets(read("scripts/fixtures/hip3/xyz-meta-and-asset-ctxs.json").response, { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" });
const snapshot = { markets: [...main.markets, ...xyz.markets], byCoin: { ...main.byCoin, ...xyz.byCoin } };
const COINS = main.markets.filter((m) => !m.isHip3).map((m) => m.coin);
const { ETH, BTC, SOL, HYPE, kPEPE } = main.byCoin;
const TSLA = xyz.byCoin["xyz:TSLA"];
const AMD = xyz.byCoin["xyz:AMD"];
const NFLX = xyz.byCoin["xyz:NFLX"];
const FEE = HL_TAKER_FEE_RATE;

/* Instants in New York terms (hours.js decides; the tests assert the session they assume). */
const OPEN = Date.parse("2026-10-15T15:00:00Z"); /* Thu 11:00 ET */
const SATURDAY = Date.parse("2026-10-17T16:00:00Z"); /* Sat 12:00 ET */
const NIGHT = Date.parse("2026-10-15T06:00:00Z"); /* Thu 02:00 ET */

/* `bars` 1h bars ending at `px` (time in SECONDS, ending one hour before `end`): a drift per bar and a zig-zag of `amp`
   over `period` bars (swings to read), each bar `range` wide. */
function shaped(px, { bars = 48, drift = 0, amp = 0.01, period = 8, range = 0.006, end = OPEN } = {}) {
  const raw = [];
  for (let i = 0; i <= bars; i++) raw.push((1 + drift) ** i * (1 + amp * Math.sin((2 * Math.PI * i) / period)));
  const k = px / raw[bars];
  const t0 = Math.floor(end / 1000) - (bars + 1) * 3600;
  const out = [];
  for (let i = 1; i <= bars; i++) {
    const o = raw[i - 1] * k;
    const c = raw[i] * k;
    out.push({ time: t0 + i * 3600, open: o, close: c, high: Math.max(o, c) * (1 + range / 2), low: Math.min(o, c) * (1 - range / 2), volume: 1 });
  }
  return out;
}
/* A flat chart (no trend, no swings worth a stop): the ATR stop. */
const flat = (px, o = {}) => shaped(px, { amp: 0, drift: 0, range: 0.01, ...o });

const ETH_UP = shaped(ETH.midPx, { drift: 0.001 });
const ETH_DOWN = shaped(ETH.midPx, { drift: -0.001 });
const lots = (size, d) => Math.abs(size * 10 ** d - Math.round(size * 10 ** d)) < 1e-6;
const onTick = (px, d) => roundHlOrderPx(px, d, "nearest") === String(px);
const plan = (input, ctx = {}) => TP.planTrade(input, { feeRate: FEE, now: OPEN, candles: ETH_UP, market: ETH, ...ctx });

/* Every ok plan obeys the rules, whatever produced it. */
function assertSound(p, label = "") {
  const at = `${label} ${JSON.stringify({ L: p.leverage, m: p.margin, size: p.size })}`;
  assert.equal(p.ok, true, at);
  assert.equal(p.steps.length, 3, `${at} three lines`);
  assert.equal(p.stepsTh.length, 3);
  assert.ok(p.margin > 0 && p.margin <= MAX_MARGIN_USDC + 1e-9, `${at} margin cap`);
  assert.ok(Number.isInteger(p.leverage) && p.leverage >= 1 && p.leverage <= AGENT_MAX_LEVERAGE, `${at} Agent cap`);
  assert.ok(lots(p.size, p.szDecimals), `${at} size on the lot`);
  assert.ok(onTick(p.sl, p.szDecimals) && onTick(p.tp, p.szDecimals), `${at} prices on the tick`);
  const buy = p.side === "buy";
  assert.ok(buy ? p.sl < p.entry && p.tp > p.entry : p.sl > p.entry && p.tp < p.entry, `${at} sides`);
  /* Liquidation at least LIQ_BUFFER stop distances away, so the stop always fires first. */
  const liq = estIsolatedLiqPx({ side: p.side, entryPx: p.entry, leverage: p.leverage, maxLeverage: Math.floor(snapshot.byCoin[p.coin].maxLeverage) });
  if (liq > 0) {
    const gap = buy ? (p.entry - liq) / p.entry : (liq - p.entry) / p.entry;
    assert.ok(gap >= TP.PLAN_LIQ_BUFFER * p.stopFrac - 1e-12, `${at} liq gap ${gap} vs stop ${p.stopFrac}`);
    assert.ok(buy ? p.sl > liq : p.sl < liq, `${at} stop before liquidation`);
  }
  /* The loss at the stop includes both fees; never more than the stated risk unless a cap raised it (min order). */
  const d = Math.abs(p.entry - p.sl);
  assert.ok(Math.abs(p.lossAtStop - (p.size * (d + p.feeRate * (p.entry + p.sl)))) < 0.006, `${at} loss incl. fees`);
  if (p.riskUsd != null && !(p.capped && p.capped.why === "min_notional")) assert.ok(p.lossAtStop <= p.riskUsd + 0.005, `${at} loss ≤ risk`);
  /* The send path rebuilds this exact size from the card's margin and leverage, and the $10 minimum passes. */
  const card = TP.planToOpenCard(p);
  assert.ok(card, `${at} card`);
  const order = planOpenMarket({ market: snapshot.byCoin[p.coin], side: card.side, marginUsdc: card.marginUsdc, leverage: card.leverage });
  assert.equal(order.ok, true, `${at} ${JSON.stringify(order)}`);
  assert.equal(Number(order.size), p.size, `${at} same size at send`);
  assert.equal(order.leverageAction.isCross, false, "isolated, always");
  /* The card's ROE stop reprices to the plan's stop (a stop rounded IN, never wider). */
  const slFromRoe = buy ? p.entry * (1 - card.slPct / 100 / card.leverage) : p.entry * (1 + card.slPct / 100 / card.leverage);
  assert.ok(buy ? slFromRoe >= p.sl - 1e-9 : slFromRoe <= p.sl + 1e-9, `${at} ROE stop not wider`);
  assert.ok(Math.abs(slFromRoe - p.sl) / p.entry < 0.0001 * card.leverage + 1e-9, `${at} ROE stop within a hundredth of a % ROE`);
  return p;
}

/* ── riskParse: the words ────────────────────────────────────────────────────────────────────────────────────── */

const PARSE = [
  /* The owner's own sentences (items 13 and 14). */
  ["มี 300 ยอมเสียได้ 15 ดอล เล่น RR ตั้ง TP SL เท่าไหร่ดี Short กับเหรียญ SOL", { mode: "plan", coin: "SOL", side: "sell", balanceUsd: 300, riskUsd: 15, rrAsked: true, ask: null }],
  ["ยอมเสียได้ 15 ดอล", { mode: "plan", riskUsd: 15, ask: "coin" }],
  ["เสียได้ 3% ETH", { mode: "plan", riskPct: 3, coin: "ETH", ask: null }],
  ["มี 300 long ETH", { mode: "plan", balanceUsd: 300, riskPct: 1, assumed: ["riskPct"], side: "buy" }],
  ["RR 3 HYPE", { mode: "plan", rr: 3, coin: "HYPE" }],
  ["1:2 short BTC risk 5", { mode: "plan", rr: 2, side: "sell", riskUsd: 5 }],
  ["risk $1", { mode: "plan", riskUsd: 1, ask: "coin" }],
  ["risk $1 long ETH", { mode: "plan", riskUsd: 1, coin: "ETH", side: "buy", ask: null }],
  ["ยอมเสีย 1 ดอล SOL", { mode: "plan", riskUsd: 1, coin: "SOL" }],
  ["ยอมเสียดอลเดียว long BTC", { mode: "plan", riskUsd: 1, coin: "BTC", side: "buy" }],
  ["มี 50 เสียได้ 2 HYPE", { mode: "plan", balanceUsd: 50, riskUsd: 2, coin: "HYPE" }],
  ["short SOL RR 3", { mode: "plan", coin: "SOL", side: "sell", rr: 3 }],
  ["short SOL", { mode: null, coin: "SOL", side: "sell" }],
  ["tp sl เท่าไหร่ดี", { mode: "setups", levelsAsked: true }],
  ["TP SL เท่าไหร่ดี ETH", { mode: "setups", coin: "ETH" }],
  ["เซฟๆ ETH", { mode: "setups", style: "safer", coin: "ETH" }],
  ["เซฟๆ ETH มี 200", { mode: "plan", style: "safer", balanceUsd: 200, riskPct: 1 }],
  /* Voice writes numbers out. */
  ["ยอมเสียได้สิบห้าดอล ETH", { mode: "plan", riskUsd: 15 }],
  ["I can lose five bucks on BTC long", { mode: "plan", riskUsd: 5, coin: "BTC", side: "buy" }],
  ["ยอมเสียได้ ๒๐ ดอล ETH", { mode: "plan", riskUsd: 20 }],
  ["มี 1k ยอมเสีย 2% ETH", { mode: "plan", balanceUsd: 1000, riskPct: 2 }],
  ["risk 1% of my 300 on ETH", { mode: "plan", riskPct: 1, balanceUsd: 300, coin: "ETH" }],
  ["เสียได้ 2% ของพอร์ต 500 short HYPE", { mode: "plan", riskPct: 2, balanceUsd: 500, side: "sell" }],
  ["$5 risk ETH short", { mode: "plan", riskUsd: 5 }],
  /* Stops, TPs, leverage and margin inside a plan sentence. */
  ["risk 5% long eth sl 140", { mode: "plan", riskPct: 5, stopNum: 140, stopPct: null }],
  ["ยอมเสีย 10 ดอล SOL long sl 2%", { mode: "plan", riskUsd: 10, stopPct: 2 }],
  ["ตัดขาดทุนที่ 140 SOL ยอมเสีย 10", { mode: "plan", riskUsd: 10, stopNum: 140 }],
  ["คัทได้ 10 ดอล SOL long", { mode: "plan", riskUsd: 10, stopNum: null }],
  ["ยอมตัดขาดทุน 10 ดอล ETH long", { mode: "plan", riskUsd: 10, stopNum: null }],
  ["ตัดขาดทุนได้ 4 ดอล ETH long", { mode: "plan", riskUsd: 4, stopNum: null }],
  ["short btc risk 2 rr 1:3 10x", { mode: "plan", riskUsd: 2, rr: 3, leverage: 10, side: "sell" }],
  ["long ETH ใช้ 10 ดอล ยอมเสีย 1 ดอล", { mode: "plan", marginUsd: 10, riskUsd: 1 }],
  ["risk 3 long ETH tp 2r", { mode: "plan", rr: 2, riskUsd: 3 }],
  /* Stocks: crypto first, then the stock names (hip3/names.js). */
  ["ซื้อ Tesla ยอมเสีย 5 ดอล", { mode: "plan", coin: "xyz:TSLA", coinKind: "stock", side: "buy", riskUsd: 5 }],
  ["เทสล่า ยอมเสีย 2 ดอล", { mode: "plan", coin: "xyz:TSLA" }],
  ["short NVDA risk $3 rr 2", { mode: "plan", coin: "xyz:NVDA", side: "sell", riskUsd: 3, rr: 2 }],
  /* Not plans: these belong to shortcuts.js / intents.js. */
  ["long ETH 20 5x sl 10%", { mode: null }],
  ["ETH 14:43 risk 3", { mode: "plan", rr: null, riskUsd: 3 }],
  ["close half ETH", { mode: null }],
  /* A common word is not a market unless written as a ticker. */
  ["not more than $5 risk on SOL", { coin: "SOL", riskUsd: 5 }],
  ["risk $2 on ME long", { coin: "ME" }],
  /* News, not a budget; a plain trade sentence with its own levels; "ลงทุน" is a margin, not a balance. */
  ["ETH เสีย 5% วันนี้ short ไหม", { mode: null, riskPct: null }],
  ["ETH is losing 5% today", { mode: null, riskPct: null }],
  ["ขาดทุนไป 20 ดอล ETH", { mode: null, riskUsd: null }],
  ["long ETH 20 5x tp 10% sl 5%?", { mode: null, levelsAsked: false }],
  ["long ETH ลงทุน 10 ดอล ยอมเสีย 1", { mode: "plan", marginUsd: 10, balanceUsd: null, riskUsd: 1 }],
  ["ไม่มี 300 หรอก risk 2 ETH long", { balanceUsd: null, riskUsd: 2 }],
  /* The one question. */
  ["ยอมเสียได้กี่ดอลดี ETH", { mode: "plan", ask: "risk" }],
  ["how much should I risk on ETH", { mode: "plan", ask: "risk" }],
];

for (const [text, want] of PARSE) {
  test(`parseRisk: ${text}`, () => {
    const r = RP.parseRisk(text, { coins: COINS });
    for (const [k, v] of Object.entries(want)) {
      if (k === "ask") assert.equal(r.ask ? r.ask.field : null, v, `${k}: ${JSON.stringify(r)}`);
      else assert.deepEqual(r[k], v, `${k}: ${JSON.stringify(r)}`);
    }
  });
}

test("parseRisk: the page's market stands in when the sentence names none, and the language follows the words", () => {
  const r = RP.parseRisk("ยอมเสียได้ 3 ดอล", { coins: COINS, contextCoin: "HYPE" });
  assert.equal(r.coin, "HYPE");
  assert.equal(r.coinFrom, "context");
  assert.equal(r.ask, null);
  assert.equal(r.lang, "th");
  assert.equal(RP.parseRisk("risk $2", { coins: COINS, contextCoin: "xyz:TSLA" }).coinKind, "stock");
  assert.equal(RP.askLine("risk", "th"), "ยอมเสียได้กี่ดอล?");
  assert.equal(RP.askLine("coin", "en"), "Which coin or stock?");
});

test("answerAsk: the reply to the ONE question fills the pending plan (owner item 14: ask, never refuse)", () => {
  const p1 = RP.parseRisk("ยอมเสียได้กี่ดอล ETH long", { coins: COINS });
  assert.equal(p1.ask.field, "risk");
  for (const [reply, want] of [["15", { riskUsd: 15 }], ["ดอลเดียว", { riskUsd: 1 }], ["3%", { riskPct: 3 }], ["ยอมเสียได้ 5 ดอล rr 3", { riskUsd: 5, rr: 3 }]]) {
    const a = RP.answerAsk(p1, reply, { coins: COINS });
    for (const [k, v] of Object.entries(want)) assert.equal(a[k], v, `${reply}: ${k}`);
    assert.equal(a.ask, null, reply);
    assert.equal(a.coin, "ETH");
    assert.equal(a.side, "buy");
  }
  const p2 = RP.parseRisk("ยอมเสียได้ 15 ดอล", { coins: COINS });
  assert.equal(p2.ask.field, "coin");
  const a2 = RP.answerAsk(p2, "เทสล่า", { coins: COINS });
  assert.equal(a2.coin, "xyz:TSLA");
  assert.equal(a2.riskUsd, 15);
  assert.equal(a2.ask, null);
  assert.equal(RP.answerAsk(p2, "อะไรก็ได้", { coins: COINS }).ask.field, "coin", "still no market: the same one question");
});

test("planInput: an ambiguous stop number is a price near the live price, else a percent", () => {
  const r = RP.parseRisk("risk 5 long SOL sl 140", { coins: COINS });
  assert.equal(RP.planInput(r, { midPx: 150 }).stopPx, 140);
  assert.equal(RP.planInput(RP.parseRisk("risk 5 long SOL sl 2", { coins: COINS }), { midPx: 150 }).stopPct, 2);
  assert.equal(RP.planInput(RP.parseRisk("risk 5 long BTC sl 2", { coins: COINS }), { midPx: 80_000 }).stopPct, 2);
  const unknown = RP.planInput(RP.parseRisk("risk 5 long BTC sl 79000", { coins: COINS }), {});
  assert.equal(unknown.stopPx, null, "no price to read it against: not guessed");
  assert.equal(unknown.stopPct, null);
  const all = RP.planInput(RP.parseRisk("มี 300 ยอมเสียได้ 15 ดอล RR 3 short SOL 5x", { coins: COINS }), { midPx: 150 });
  assert.deepEqual({ coin: all.coin, side: all.side, riskUsd: all.riskUsd, balanceUsd: all.balanceUsd, rr: all.rr, leverage: all.leverage, lang: all.lang },
    { coin: "SOL", side: "sell", riskUsd: 15, balanceUsd: 300, rr: 3, leverage: 5, lang: "th" });
});

test("thaiNumber / normalizeAmounts", () => {
  assert.equal(RP.thaiNumber("สิบห้า"), 15);
  assert.equal(RP.thaiNumber("ยี่สิบ"), 20);
  assert.equal(RP.thaiNumber("สามร้อย"), 300);
  assert.equal(RP.thaiNumber("ห้าสิบ"), 50);
  assert.equal(RP.thaiNumber("พันห้าร้อย"), 1500);
  assert.match(RP.normalizeAmounts("ห้ามเกิน 10 ดอล"), /ห้ามเกิน 10/, "ห้า inside ห้าม is not five");
  assert.match(RP.normalizeAmounts("มี 1,000 usd"), /1000/);
  assert.match(RP.normalizeAmounts("long kPEPE 1k"), /kpepe 1000/);
});

/* ── planTrade: the maths ────────────────────────────────────────────────────────────────────────────────────── */

test("$1 risk fits the caps: just the card, no cap note (owner: \"ดอลเดียวก็ควรได้ปะ\")", () => {
  const p = assertSound(plan({ riskUsd: 1, side: "buy" }), "$1");
  assert.equal(p.capped, null);
  assert.ok(p.lossAtStop <= 1 && p.lossAtStop > 0.9, String(p.lossAtStop));
  assert.ok(p.notional >= 10);
  assert.match(p.steps[0], /^Risk \$1 · stop /);
  /* Pass-2 fix: the lines carry distances and dollars, never a price level (the card's rows and the popup print those
     once, from the live quote). */
  assert.match(p.steps[2], /^Loss at stop ≈ \$[\d.]+ incl\. fees · RR 2$/);
  assert.ok(!/\$\d[\d,]*\.\d{2,}\b.*\(1h|at \$|TP \$|liq \$/.test(p.steps.join(" ")), p.steps.join(" | "));
});

test("$15 risk over the 20 USDC cap: the capped plan, with the real risk printed and never the user's number claimed", () => {
  const p = assertSound(plan({ riskUsd: 15, side: "sell" }, { candles: ETH_DOWN }), "$15");
  assert.equal(p.capped.why, "margin_cap");
  assert.equal(p.leverage, Math.min(AGENT_MAX_LEVERAGE, ETH.maxLeverage), "the highest allowed leverage carries the most it can");
  assert.ok(p.margin <= MAX_MARGIN_USDC && p.margin > MAX_MARGIN_USDC - 0.3);
  assert.ok(p.capped.realRiskUsd < 15);
  assert.equal(p.capped.realRiskUsd, p.lossAtStop);
  assert.equal(p.capped.text.en, `Max ${MAX_MARGIN_USDC} USDC margin per order: this risks $${p.lossAtStop.toFixed(2)}, not $15`);
  assert.match(p.capped.text.th, /^มาร์จิ้นสูงสุด 20 USDC ต่อออเดอร์: แผนนี้เสียได้จริง \$[\d.]+ ไม่ใช่ \$15$/);
  assert.match(p.steps[1], /^Max 20 USDC margin → size /);
});

test("the leverage is the LOWEST whole leverage at which the margin fits", () => {
  for (const risk of [0.5, 1, 2, 3, 5, 8]) {
    const p = assertSound(plan({ riskUsd: risk, side: "buy" }), `risk ${risk}`);
    if (p.capped) continue;
    if (p.leverage > 1) assert.ok((p.notional) / (p.leverage - 1) > MAX_MARGIN_USDC - 1e-6, `${risk}: ${p.leverage - 1}x would also fit`);
  }
});

test("% risk: of the balance the user gave, else of the account; neither → ONE question", () => {
  const p = assertSound(plan({ riskPct: 3, balanceUsd: 300, side: "buy" }), "3% of 300");
  assert.equal(p.riskUsd, 9);
  assert.match(p.steps[0], /^Risk \$9 \(3% of \$300\)/);
  const acc = assertSound(plan({ riskPct: 2, side: "buy" }, { balanceUsdc: 150 }), "2% of account");
  assert.equal(acc.riskUsd, 3);
  const none = plan({ riskPct: 2, side: "buy" });
  assert.equal(none.ok, false);
  assert.equal(none.why, "no-balance");
  assert.equal(none.ask.th, "มีเงินในบัญชีกี่ดอล?");
  const def = assertSound(plan({ balanceUsd: 200, side: "buy", lang: "th" }), "balance only");
  assert.equal(def.riskUsd, 2, "1% of 200, said as the default");
  assert.ok(def.warnings.includes("risk_assumed"));
  assert.match(def.steps[0], /ค่าเริ่มต้น/);
});

test("no budget at all: the setups' default 10 USDC margin at ≤ 3x, said on the card", () => {
  const p = assertSound(plan({ side: "buy" }), "default");
  assert.ok(p.margin <= 10 + 1e-9 && p.margin > 9);
  assert.ok(p.leverage <= SETUP_MAX_LEVERAGE);
  assert.ok(p.warnings.includes("margin_default"));
  assert.match(p.steps[0], /^Margin \$10 \(default\)/);
});

test("the $10 minimum: a tiny risk is raised to the smallest order, the real risk printed; a short is grossed up for its slippage", () => {
  for (const side of ["buy", "sell"]) {
    const p = assertSound(plan({ riskUsd: 0.05, side }, { candles: side === "buy" ? ETH_UP : ETH_DOWN }), `min ${side}`);
    assert.equal(p.capped.why, "min_notional");
    assert.ok(p.capped.realRiskUsd > 0.05);
    assert.match(p.capped.text.en, /^Smallest order is \$10: this risks \$[\d.]+, not \$0\.05$/);
    const value = p.size * Math.min(p.entry, side === "buy" ? p.entry * 1.05 : p.entry * 0.95);
    assert.ok(value >= 10, `${side}: ${value} at the venue's own check`);
  }
  /* A leverage the user named is never raised to reach the minimum. */
  const own = plan({ marginUsd: 2, leverage: 2, side: "buy" });
  assert.equal(own.ok, false);
  assert.equal(own.why, "too-small");
});

test("rounding: size DOWN to the lot, the stop on the tick toward the entry, the TP on the nearest tick", () => {
  for (const [m, risk] of [[BTC, 3], [ETH, 2], [SOL, 1.5], [HYPE, 2.5], [kPEPE, 1]]) {
    const c = shaped(m.midPx, { drift: 0.0008 });
    const p = assertSound(TP.planTrade({ riskUsd: risk, side: "buy" }, { market: m, candles: c, feeRate: FEE, now: OPEN }), m.coin);
    const raw = (risk / (Math.abs(p.entry - p.sl) + FEE * (p.entry + p.sl)));
    if (!p.capped) assert.ok(p.size <= raw + 1e-12 && raw - p.size < 10 ** -m.szDecimals + 1e-12, `${m.coin} size ${p.size} vs ${raw}`);
    assert.ok(String(p.sl).replace(/^\d+\.?/, "").length <= Math.max(0, 6 - m.szDecimals), `${m.coin} decimals`);
  }
  /* A stop given as a % lands on the tick and never further than asked. */
  const p = assertSound(plan({ riskUsd: 2, side: "sell", stopPct: 1.234 }, { candles: ETH_DOWN }), "stop %");
  assert.ok(p.sl - p.entry <= p.entry * 0.01234 + 1e-9);
});

test("the stop: the user's price wins; a stop on the wrong side or past any leverage's liquidation is refused, never moved", () => {
  const p = assertSound(plan({ riskUsd: 3, side: "buy", stopPx: 2650 }), "stop px");
  assert.equal(p.sl, 2650);
  assert.equal(p.stopFrom, "user");
  assert.equal(plan({ riskUsd: 3, side: "buy", stopPx: 2900 }).why, "stop-wrong-side");
  assert.equal(plan({ riskUsd: 3, side: "sell", stopPx: 2600 }).why, "stop-wrong-side");
  assert.equal(plan({ riskUsd: 3, side: "buy", stopPct: 60 }).why, "stop-too-wide");
  assert.equal(plan({ riskUsd: 3, side: "buy", tpPx: 2500 }).why, "tp-wrong-side");
  const tight = plan({ riskUsd: 3, side: "buy", stopPct: 0.05 });
  assert.ok(tight.ok && tight.warnings.includes("stop_tight"), "a stop inside the noise is allowed and flagged");
});

test("the liquidation rule is the setups' own (one rule for a plan and a setup)", () => {
  assert.equal(TP.PLAN_LIQ_BUFFER, LIQ_BUFFER);
});

test("the chart's stop: a swing past 0.75–3 ATR, else 1.5 ATR (2 ATR when safe); too few bars → no guess", () => {
  const swing = plan({ riskUsd: 2, side: "buy" });
  assert.equal(swing.stopFrom, "swing");
  assert.match(swing.steps[0], /1h swing low/);
  const atr = plan({ riskUsd: 2, side: "buy" }, { candles: flat(ETH.midPx) });
  assert.equal(atr.stopFrom, "atr");
  assert.equal(atr.stopAtrK, TP.STOP_ATR);
  const a = TP.planAtr(flat(ETH.midPx));
  assert.ok(Math.abs(Math.abs(atr.entry - atr.sl) - 1.5 * a) < ETH.midPx * 0.0001);
  const safe = plan({ riskUsd: 2, side: "buy", style: "safer" }, { candles: flat(ETH.midPx) });
  assert.equal(safe.stopAtrK, TP.SAFE_STOP_ATR);
  assert.ok(safe.leverage <= TP.SAFE_MAX_LEVERAGE);
  const few = plan({ riskUsd: 2, side: "buy" }, { candles: flat(ETH.midPx, { bars: 10 }) });
  assert.equal(few.ok, false);
  assert.equal(few.why, "no-candles");
  assert.match(few.text.th, /บอก SL มาได้เลย/);
});

test("liquidation: a user leverage that would put liquidation inside 2 stops is lowered and said; caps clamp and say", () => {
  const wide = assertSound(plan({ riskUsd: 2, side: "buy", stopPct: 8, leverage: 10 }), "wide stop 10x");
  assert.ok(wide.leverage < 10);
  assert.ok(wide.warnings.includes("leverage_lowered"));
  const over = assertSound(plan({ riskUsd: 2, side: "buy", leverage: 40 }), "40x");
  assert.equal(over.leverage, AGENT_MAX_LEVERAGE);
  assert.ok(over.warnings.includes("leverage_capped"));
  assert.ok(TP.warningTexts(over, "en").includes(`Leverage capped at ${AGENT_MAX_LEVERAGE}x`));
  const frac = assertSound(plan({ riskUsd: 2, side: "buy", leverage: 2.5 }), "2.5x");
  assert.equal(frac.leverage, 2);
  assert.ok(frac.warnings.includes("leverage_whole"));
});

test("RR: default 2, the user's own, a TP price; RR under 1 is flagged", () => {
  assert.equal(plan({ riskUsd: 2, side: "buy" }).rr, 2);
  const three = plan({ riskUsd: 2, side: "buy", rr: 3 });
  assert.ok(Math.abs(three.rr - 3) < 0.02);
  const tpp = plan({ riskUsd: 2, side: "buy", stopPx: 2700, tpPx: 2800 });
  assert.equal(tpp.tp, 2800);
  assert.equal(tpp.rr, Math.round(((2800 - tpp.entry) / (tpp.entry - 2700)) * 100) / 100);
  assert.ok(plan({ riskUsd: 2, side: "buy", rr: 0.5 }).warnings.includes("rr_low"));
});

test("the side: the user's, else the chart's lean (said); no lean at all → ONE question", () => {
  const up = plan({ riskUsd: 2 });
  assert.equal(up.side, "buy");
  assert.ok(up.warnings.includes("side_from_trend"));
  assert.equal(TP.warningTexts(up, "th")[0], "FlowFlow เลือก Long ตามเทรนด์ 1h ขาขึ้น");
  assert.equal(TP.warningTexts(up, "en")[0], "FlowFlow picked Long: the 1h trend is up");
  /* Pass-2 fix: the side the app picked is on the card, first (never only in the model's history). */
  const card = TP.planToOpenCard(up);
  assert.equal(card.notes[0], "FlowFlow picked Long: the 1h trend is up");
  const none = TP.planTrade({ riskUsd: 2 }, { market: { ...ETH, funding: 0, change24hPct: 0 }, candles: flat(ETH.midPx), feeRate: FEE, now: OPEN });
  assert.equal(none.why, "no-direction");
  assert.equal(none.ask.th, "Long หรือ Short?");
});

test("free margin: the leverage fits it; short of it, the capped plan says so; none → no plan", () => {
  const fit = assertSound(plan({ riskUsd: 2, side: "buy" }, { freeUsdc: 8 }), "free 8");
  assert.ok(fit.margin * (1 + fit.leverage * FEE) <= 8 + 1e-9);
  const short = assertSound(plan({ riskUsd: 15, side: "buy" }, { freeUsdc: 5 }), "free 5");
  assert.equal(short.capped.why, "free_margin");
  assert.match(short.capped.text.en, /^\$5 free to trade: this risks \$[\d.]+, not \$15$/);
  assert.equal(plan({ riskUsd: 2, side: "buy" }, { freeUsdc: 0 }).why, "no-funds");
  assert.equal(plan({ riskUsd: 2, side: "buy" }, { freeUsdc: 0.5 }).why, "too-small");
});

test("margin + leverage + risk and no stop: the stop comes from the risk; one position per market", () => {
  const p = assertSound(plan({ riskUsd: 2, marginUsd: 10, leverage: 5, side: "buy" }), "fixed size");
  assert.equal(p.stopFrom, "risk");
  assert.ok(Math.abs(p.lossAtStop - 2) < 0.06, String(p.lossAtStop));
  assert.ok(Math.abs(p.margin - 10) < 0.3);
  assert.equal(plan({ riskUsd: 0.01, marginUsd: 10, leverage: 5, side: "buy" }).why, "fees-over-risk");
  assert.equal(plan({ riskUsd: 2, side: "buy" }, { position: { coin: "ETH", szi: 0.1 } }).why, "held");
});

test("an unknown fee is priced at its ceiling and said", () => {
  const p = assertSound(plan({ riskUsd: 2, side: "buy" }, { feeRate: null }), "fee unknown");
  assert.equal(p.feeRate, TP.FALLBACK_FEE_RATE);
  assert.ok(p.warnings.includes("fee_assumed"));
});

/* ── stocks ──────────────────────────────────────────────────────────────────────────────────────────────────── */

const STOCK_FEE = perpMarketFeeRate(TSLA, FEE);
const tslaBars = (end) => shaped(TSLA.midPx, { bars: 168, drift: 0.0003, amp: 0.008, range: 0.004, end });
const stock = (input, ctx = {}) => TP.planTrade(input, { market: TSLA, candles: tslaBars(ctx.now ?? OPEN), feeRate: STOCK_FEE, listed: true, now: OPEN, ...ctx });

test("stocks: the US session the tests assume", () => {
  assert.equal(usEquitySession(OPEN).session, "regular");
  assert.equal(usEquitySession(SATURDAY).session, "weekend");
  assert.equal(usEquitySession(NIGHT).session, "overnight");
  assert.ok(Math.abs(STOCK_FEE - 0.00009) < 1e-12, "0.009% taker");
});

test("stock, US market open: ≤ min(10, market max), isolated, the stop from US-hours bars only, no venue words", () => {
  const p = assertSound(stock({ riskUsd: 15, side: "buy", leverage: 20 }), "TSLA open");
  assert.equal(p.kind, "stock");
  assert.equal(p.leverage, 10, "TSLA max 20, the Agent's 10");
  assert.equal(p.marginMode, "isolated");
  assert.equal(p.us.open, true);
  assert.equal(p.basis, TP.STOCK_PLAN_BASIS);
  const order = planOpenMarket({ market: TSLA, side: "buy", marginUsdc: p.margin, leverage: p.leverage });
  assert.equal(order.asset, 110001, "xyz:TSLA = 100000 + 1×10000 + 1");
  const words = JSON.stringify([p.steps, p.stepsTh, TP.planForModel(p), TP.planForModel(p, "th"), p.capped && p.capped.text, TP.warningTexts(p), TP.warningTexts(p, "th")]);
  assert.doesNotMatch(words, /xyz|HIP-?3|\bdex\b|venue|\bpot\b|กอง/i);
  assert.match(p.steps[1], / TSLA ≈ /);
});

test("stock, US market CLOSED (weekend, night): ≤ 5x, said in one line, and the guard's gap warning rides along", () => {
  for (const now of [SATURDAY, NIGHT]) {
    const p = assertSound(stock({ riskUsd: 15, side: "buy", leverage: 10 }, { now }), `TSLA closed ${now}`);
    assert.ok(p.leverage <= 5, String(p.leverage));
    assert.ok(p.warnings.includes("us_closed_cap"));
    /* The weekend's price is the market's own model; a weekday night still has an outside price, but a thin one. */
    assert.ok(p.warnings.includes(now === SATURDAY ? "us_market_closed" : "extended_hours"), JSON.stringify(p.warnings));
    assert.equal(p.us.closed, true);
    assert.ok(p.us.opensInMin > 0);
    assert.ok(TP.warningTexts(p, "en").includes("US market closed: max 5x on stocks now"));
    assert.ok(TP.warningTexts(p, "th").includes("ตลาดหุ้น US ปิด: หุ้นใช้ได้สูงสุด 5x ตอนนี้"));
    const auto = assertSound(stock({ riskUsd: 15, side: "buy" }, { now }), "auto closed");
    assert.ok(auto.leverage <= 5);
    assert.ok(auto.warnings.includes("us_closed_cap"), "the 5x ceiling cost size: said");
  }
  /* A tampered plan over 5x while closed never becomes a card. */
  const p = stock({ riskUsd: 2, side: "buy" }, { now: SATURDAY });
  assert.equal(TP.planToOpenCard({ ...p, leverage: 8 }), null);
});

test("stock: AMD's own 10x max; a paused stock (NFLX) and an unlisted name get no plan, with the reason", () => {
  const amd = assertSound(TP.planTrade({ riskUsd: 5, side: "sell", leverage: 20 }, { market: AMD, candles: shaped(AMD.midPx, { bars: 168, drift: -0.0003, amp: 0.008 }), feeRate: perpMarketFeeRate(AMD, FEE), listed: true, now: OPEN }), "AMD");
  assert.equal(amd.leverage, 10);
  assert.ok(amd.warnings.includes("leverage_capped"));
  const nflx = TP.planTrade({ riskUsd: 5, side: "sell" }, { market: NFLX, candles: shaped(NFLX.midPx, { bars: 168 }), feeRate: FEE, listed: false, now: OPEN });
  assert.equal(nflx.why, "stock-refused");
  assert.deepEqual(nflx.refusals, ["held"]);
  assert.equal(nflx.text.th, "พักการเทรดหุ้นตัวนี้ไว้ก่อน (ซื้อขายบาง)");
  assert.equal(TP.planMarket("GOLD", snapshot), null);
  assert.equal(TP.planMarket("ทองคำ", snapshot), null);
});

test("stock: recorded weekend candles hold too few US-hours bars → no guessed stop; the user's own stop still plans", () => {
  const rec = parseHlCandles(read("scripts/fixtures/hip3/xyz-candles-TSLA-1h-weekend.json").response);
  const none = TP.planTrade({ riskUsd: 5, side: "buy" }, { market: TSLA, candles: rec, feeRate: STOCK_FEE, listed: true, now: SATURDAY });
  assert.equal(none.why, "no-candles", "a weekend's narrow bars would put the stop inside Monday's gap");
  const own = assertSound(TP.planTrade({ riskUsd: 5, side: "buy", stopPct: 3 }, { market: TSLA, candles: rec, feeRate: STOCK_FEE, listed: true, now: SATURDAY }), "own stop");
  assert.ok(own.leverage <= 5);
});

/* ── into the chat ───────────────────────────────────────────────────────────────────────────────────────────── */

test("planToOpenCard: the normal trade card (Confirm still required) with the plan's maths; a tampered plan gives none", () => {
  const p = plan({ riskUsd: 3, side: "buy" });
  const card = TP.planToOpenCard(p);
  assert.equal(card.kind, "open");
  assert.equal(card.status, "review");
  assert.equal(card.marginUsdc, p.margin);
  assert.equal(card.leverage, p.leverage);
  assert.equal(card.slPct, p.slRoePct);
  assert.equal(card.tpPct, p.tpRoePct);
  assert.deepEqual(card.plan.steps, p.steps);
  assert.equal(card.plan.tpPx, p.tp);
  assert.equal(card.plan.slPx, p.sl);
  assert.equal(TP.planToOpenCard({ ...p, margin: 25 }), null);
  assert.equal(TP.planToOpenCard({ ...p, leverage: 11 }), null);
  assert.equal(TP.planToOpenCard({ ...p, leverage: 2.5 }), null);
  assert.equal(TP.planToOpenCard({ ok: false }), null);
});

test("planForModel: rounded words, no maths left for the model; a failure carries the one question", () => {
  const m = TP.planForModel(plan({ riskUsd: 15, side: "sell" }, { candles: ETH_DOWN }));
  assert.equal(m.side, "short");
  assert.match(m.capped, /^Max 20 USDC margin per order: this risks \$[\d.]+, not \$15$/);
  assert.equal(m.steps.length, 3);
  assert.match(m.entry, /^\$[\d,.]+$/);
  const f = TP.planForModel(plan({ riskPct: 2, side: "buy" }), "th");
  assert.equal(f.ask_user, "มีเงินในบัญชีกี่ดอล?");
});

test("planTradeFor / planTradeToolCall: reads candles, the account and the fee; Tesla by name; GOLD and a held market refused", async () => {
  const calls = [];
  const backend = {
    connected: true, feeRate: FEE,
    account: { perpBalanceUsdc: { answered: true, complete: true, equityUsdc: 300, availableUsdc: 250 }, positions: { answered: true, byCoin: { SOL: { coin: "SOL", szi: 2 } }, list: [] } },
  };
  const ctx = {
    snapshot, backend, now: () => OPEN,
    fetchCandles: async (coin, interval, { bars }) => { calls.push([coin, interval, bars]); return coin === "xyz:TSLA" ? tslaBars(OPEN) : shaped(snapshot.byCoin[coin].midPx, { drift: 0.001 }); },
  };
  const p = await TP.planTradeFor(ctx, { coin: "eth", riskPct: 2, side: "buy" });
  assertSound(p, "planTradeFor ETH");
  assert.equal(p.riskUsd, 6, "2% of the account's 300");
  assert.deepEqual(calls.at(-1), ["ETH", "1h", TP.PLAN_BARS]);
  const t = await TP.planTradeFor(ctx, { coin: "Tesla", riskUsd: 4, side: "buy" });
  assertSound(t, "Tesla");
  assert.deepEqual(calls.at(-1), ["xyz:TSLA", "1h", TP.STOCK_PLAN_BARS]);
  assert.equal((await TP.planTradeFor(ctx, { coin: "GOLD", riskUsd: 4 })).why, "no-market");
  assert.equal((await TP.planTradeFor(ctx, { coin: "SOL", riskUsd: 4, side: "buy" })).why, "held");
  assert.equal((await TP.planTradeFor(ctx, { riskUsd: 4 })).why, "no-coin");
  const slow = await TP.planTradeFor({ ...ctx, readTimeoutMs: 20, fetchCandles: () => new Promise(() => {}) }, { coin: "ETH", riskUsd: 2, side: "buy" });
  assert.equal(slow.why, "no-candles", "a read that never answers ends");
  const tool = await TP.planTradeToolCall(ctx, { coin: "ETH", side: "short", risk_usd: 15, rr: 3 });
  assert.equal(tool.card.kind, "open");
  assert.equal(tool.card.side, "sell");
  assert.equal(tool.result.shown, true);
  assert.match(tool.result.plan.capped, /not \$15/);
  assert.match(tool.result.note, /Waiting for the user to confirm/);
  const ask = await TP.planTradeToolCall(ctx, { risk_usd: 15 });
  assert.equal(ask.card, undefined);
  assert.equal(ask.result.ask_user, "Which coin or stock?");
});

test("a sentence end to end: parse → plan → card, Thai", async () => {
  const parsed = RP.parseRisk("มี 300 ยอมเสียได้ 15 ดอล เล่น RR 3 ตั้ง TP SL เท่าไหร่ดี Short กับเหรียญ ETH", { coins: COINS });
  assert.equal(parsed.mode, "plan");
  const input = RP.planInput(parsed, { midPx: ETH.midPx });
  const p = assertSound(TP.planTrade(input, { market: ETH, candles: ETH_DOWN, feeRate: FEE, now: OPEN }), "sentence");
  assert.equal(p.side, "sell");
  assert.ok(Math.abs(p.rr - 3) < 0.02);
  assert.equal(p.capped.why, "margin_cap");
  assert.match(p.steps[0], /^ยอมเสีย \$15 · SL ห่าง /);
  assert.match(p.capped.text.th, /ไม่ใช่ \$15$/);
});

test("nothing here can send: no network, no signer, no exchange client", () => {
  for (const f of ["src/agent/tradePlan.js", "src/agent/riskParse.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(|exchange\/client|signing|openMarket\s*\(|sendAsset|usdClassTransfer|window\.|localStorage/, f);
    /* A lookbehind regex throws when the module loads on Safari before 16.4 (Vite's default target includes Safari 14). */
    assert.doesNotMatch(src, /\(\?<[!=]/, `${f}: no lookbehind`);
  }
});
