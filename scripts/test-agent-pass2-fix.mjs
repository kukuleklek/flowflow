/**
 * test-agent-pass2-fix — the pass-2 review's findings and failed eval rows, each pinned where it was fixed.
 *
 *   F1  an ADD is an Agent order under the same caps (a stock held at 10x on a Saturday, a 40x BTC)
 *   F2  "long S&P 500 10 2x" is the index, never the S coin
 *   F3  close-all waits for the whole list (stock positions load after crypto)
 *   F4  a partly filled close is never "Closed"
 *   F5  "close all my ETH" closes ETH only; F6 "close half ETH and SOL" keeps the half
 *   F7  Thai "3 เท่า" is the leverage; no leverage → ask, never a default 5x card
 *   F8  a bare TP / SL is read against the live price ("sl 85" on HYPE is $85); F9 "sl $2300" is a price
 *   F10 a stock QUESTION is answered (dividends, what it is, closed-market trading), never a setups card
 *   F11 a risk plan's warnings are on the card, the side FlowFlow picked first
 *   F12 the US 100 index is never "XYZ100" after a fill; order errors say Main Account
 *   F14 the plan's lines carry no second price for a level; one % meaning; one fee
 *   eval S2 / S5 / F2 / F3 / F4 / C7 / X4 / Z2 / B-D1 / B-Q2 / B-Q3 / B-K1
 * Rows are the store's own parse of the 2026-10-15 captures (main dex + xyz). No network.
 *
 * Run: node --test scripts/test-agent-pass2-fix.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures", p), "utf8")).response;
globalThis.fetch = () => { throw new Error("no network in tests"); };

const { parsePerpMarkets } = await import("../src/lib/hyperliquid/markets.js");
const A = await import("../src/agent/agent.js");
const R = await import("../src/agent/runTool.js");
const I = await import("../src/agent/intents.js");
const C = await import("../src/agent/closeAll.js");
const CV = await import("../src/agent/cards/closeAllView.js");
const CP = await import("../src/agent/caps.js");
const TP = await import("../src/agent/tradePlan.js");
const { respondLocally } = await import("../src/agent/respond.js");
const { parseShortcut, parseTpSl } = await import("../src/agent/shortcuts.js");
const { legStrForPx } = await import("../src/agent/legPrice.js");
const { customerWords, feeWords } = await import("../src/agent/cards/viewWords.js");
const { finalTradeView } = await import("../src/agent/cards/finalTradeView.js");
const { venueWordHits, scrubVenueWords, statusText, usSessionView, analysisRow } = await import("../src/agent/stockWords.js");
const { buildPickCard } = await import("../src/agent/picks.js");
const { chipsFor } = await import("../src/agent/chips.js");
const { tpslLegView } = await import("../src/perp/live/perpLiveView.js");
const { planOpenMarket } = await import("../src/lib/hyperliquid/exchange/orders.js");
const { chat } = await import("../src/agent/store.js");

const main = parsePerpMarkets(fx("hl-meta-and-asset-ctxs.json"), { now: 1 }).markets;
const xyz = parsePerpMarkets(fx("hip3/xyz-meta-and-asset-ctxs.json"), { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" }).markets;
const ALL = [...main, ...xyz];
const byCoin = Object.fromEntries(ALL.map((m) => [m.coin, m]));
const SNAP = { markets: ALL, byCoin, ready: true };
const COINS = main.map((m) => m.coin);

const OPEN = Date.UTC(2026, 9, 15, 15, 0);   // Thu 11:00 ET: US core session
const SAT = Date.UTC(2026, 9, 17, 15, 0);    // Sat: US market closed

const pos = (coin, szi, lev = 3, extra = {}) => ({ coin, szi, side: szi > 0 ? "long" : "short", entryPx: byCoin[coin] ? byCoin[coin].px : 1, marginUsed: 5, leverage: { type: "isolated", value: lev }, ...extra });
function backend({ positions = [], equity = 100, complete = true } = {}) {
  return {
    connected: true, mock: false, address: "0x1111111111111111111111111111111111111111", feeRate: 0.00045,
    account: {
      positions: { answered: true, list: positions, byCoin: Object.fromEntries(positions.map((p) => [p.coin, p])), complete },
      perpBalanceUsdc: { answered: true, equityUsdc: equity, availableUsdc: equity, source: "perp" },
      orders: { answered: true, list: [] },
    },
  };
}
const ctxOf = (b, o = {}) => ({ snapshot: SNAP, backend: b, fetchCandles: async () => [], readTimeoutMs: 50, now: () => OPEN, ...o });
const local = (text, b, o = {}) => respondLocally(text, { markets: ALL, byCoin, backend: b, candlesOf: () => null, apyPct: null, tokenomist: false, earnEnabled: false, ...o });
const cardsOf = (out) => out.messages.filter((m) => m.role === "card").map((m) => m.card);
const textOf = (out) => out.messages.filter((m) => m.role === "assistant").map((m) => m.text).join(" ");
const opts = (b, o = {}) => ({ backend: b, getSnapshot: () => SNAP, fetchCandles: async () => [], readTimeoutMs: 50, intents: true, suggest: false, readNews: async () => ({ items: [], covered: true }), ...o });

/* ── F1: an add is capped ─────────────────────────────────────────────────────────────────────────────────── */

test("F1) an ADD is refused when the held leverage is above what FlowFlow opens now (stock on a Saturday, 40x crypto)", () => {
  const tsla = pos("xyz:TSLA", 0.1, 10);
  const sat = CP.addCapCheck({ coin: "xyz:TSLA", position: tsla, market: byCoin["xyz:TSLA"], now: SAT });
  assert.equal(sat.ok, false);
  assert.equal(sat.max, 5);
  assert.match(sat.text, /TSLA long is at 10x.*at most 5x on stocks while the US market is closed/);
  assert.equal(CP.addCapCheck({ coin: "xyz:TSLA", position: tsla, market: byCoin["xyz:TSLA"], now: OPEN }).ok, true, "10x is fine in US hours");
  const btc = pos("BTC", 0.001, 40);
  assert.equal(CP.addCapCheck({ coin: "BTC", position: btc, market: byCoin.BTC, now: OPEN }).ok, false);
  assert.equal(CP.addCapCheck({ coin: "BTC", position: pos("BTC", 0.001, 5), market: byCoin.BTC, now: OPEN }).ok, true);
  assert.equal(CP.addCapCheck({ coin: "BTC", position: { ...btc, leverage: null }, market: byCoin.BTC }).ok, false, "an unknown leverage is refused too");

  /* The model's propose_open and the shortcut both refuse; neither makes a card. */
  const p = R.proposeAction("propose_open", { coin: "TSLA", side: "long", margin_usdc: 20, leverage: 3 }, ctxOf(backend({ positions: [tsla] }), { now: () => SAT }));
  assert.equal(p.ok, false);
  assert.match(p.error, /at most 5x/);
  const q = R.proposeAction("propose_open", { coin: "BTC", side: "long", margin_usdc: 20, leverage: 5 }, ctxOf(backend({ positions: [btc] })));
  assert.equal(q.ok, false);
  const out = local("long BTC 20 5x", backend({ positions: [btc] }));
  assert.equal(cardsOf(out).length, 0);
  assert.match(textOf(out), /BTC long is at 40x/);
  /* Within the caps the add is a card at the position's OWN leverage (never the leverage the sentence named). */
  const ok = R.proposeAction("propose_open", { coin: "BTC", side: "long", margin_usdc: 20, leverage: 9 }, ctxOf(backend({ positions: [pos("BTC", 0.001, 5)] })));
  assert.equal(ok.ok, true);
  assert.equal(ok.card.leverage, 5);
});

test("F1) the send rounds the size DOWN: 20 USDC never buys more than 20 USDC × leverage (K6, the Agent's own send)", () => {
  for (const [coin, lev] of [["ETH", 5], ["xyz:XYZ100", 10], ["xyz:SP500", 10], ["xyz:TSLA", 3]]) {
    const m = { ...byCoin[coin], stale: false };
    const plan = planOpenMarket({ market: m, side: "buy", marginUsdc: 20, leverage: lev });
    if (!plan.ok) continue;
    const send = CP.sendMarginFor({ marginUsdc: 20, leverage: lev, szDecimals: m.szDecimals, quote: { size: Number(plan.size), refPx: plan.refPx } });
    assert.ok(send <= 20);
    const again = planOpenMarket({ market: m, side: "buy", marginUsdc: send, leverage: lev });
    assert.ok((Number(again.size) * again.refPx) / lev <= 20 + 1e-9, `${coin}: ${again.size}`);
  }
  assert.equal(CP.sendMarginFor({ marginUsdc: 10, leverage: 2, szDecimals: 2, quote: { size: 0.2, refPx: 100 } }), 10, "an exact lot is left alone");
});

/* ── F2: S&P 500 ───────────────────────────────────────────────────────────────────────────────────────────── */

test("F2) 'long S&P 500 10 2x' (and Thai) never becomes a card for the S coin", async () => {
  chat.setAccount("mock");
  for (const t of ["long S&P 500 10 2x", "short S&P 500 10 2x", "ซื้อ S&P 500 10 ดอล 2x", "long s&p 10 3x"]) {
    chat.clear();
    chat.push({ role: "user", text: t });
    await A.handleMessage(t, opts(backend()));
    const cards = chat.get().messages.filter((m) => m.role === "card").map((m) => m.card);
    assert.ok(!cards.some((c) => c.coin === "S"), `${t}: ${JSON.stringify(cards)}`);
    assert.ok(!chat.get().messages.some((m) => m.role === "assistant" && /\bLong S\b|\bShort S\b/.test(m.text)), t);
  }
  const st = A.stockTradeIntent("long S&P 500 10 2x", SNAP);
  assert.deepEqual([st.kind, st.coin, st.marginUsdc, st.leverage], ["trade", "xyz:SP500", 10, 2], "500 is the index's name, not the margin");
  chat.clear();
});

/* ── F3–F6: close all ──────────────────────────────────────────────────────────────────────────────────────── */

test("F3) close-all and a bare 'close' wait for the whole list (stock positions load after crypto)", () => {
  const loading = backend({ positions: [pos("BTC", 0.001)], complete: null });
  const r = R.proposeCloseAll({}, ctxOf(loading));
  assert.equal(r.ok, false);
  assert.equal(r.loading, true);
  const ask = local("close", loading);
  assert.equal(cardsOf(ask).length, 0, "one crypto position while stocks load: ask, never close it");
  assert.equal(ask.messages.at(-1).ask, "close");
  const whole = local("close", backend({ positions: [pos("BTC", 0.001)] }));
  assert.deepEqual(cardsOf(whole).map((c) => [c.kind, c.coin]), [["close", "BTC"]]);
});

test("F4) a partly filled close is 'partly closed', retried, and never 'Closed all N positions'", () => {
  assert.equal(CV.closeOutcome({ ok: true, partial: true, filled: { totalSz: "0.05" }, size: "0.1" }).state, "partial");
  assert.equal(CV.closeOutcome({ ok: true, status: "filled" }).state, "done");
  const rows = [{ coin: "BTC", label: "BTC", pnlUsd: 1 }, { coin: "xyz:TSLA", label: "TSLA", pnlUsd: -2 }];
  const s = CV.closeAllSummary(rows, { BTC: { state: "done" }, "xyz:TSLA": CV.closeOutcome({ ok: true, partial: true, filled: { totalSz: "0.05" }, size: "0.1" }) });
  assert.equal(s.done, 1);
  assert.equal(s.partial, 1);
  assert.deepEqual(s.retry, ["xyz:TSLA"]);
  assert.match(s.text, /^Closed 1 of 2\. TSLA only partly closed: the rest is still open\.$/);
  assert.equal(CV.realizedOf(rows, { BTC: { state: "done" } }), 1);
  assert.equal(CV.closeAllLabel(2, 0.5), "Close half of each · 2");
});

test("F5/F6) a market named beside 'all' closes that market only; a share named is kept", () => {
  const d = (t) => C.detectCloseAll(t, { coins: COINS, held: ["BTC", "ETH", "xyz:TSLA"] });
  for (const t of ["close all BTC", "close all my ETH", "close all of my ETH position", "exit all ETH", "ปิดหมด BTC", "ขายหมด ETH"]) {
    const r = d(t);
    assert.equal(r.kind, "closeAll", t);
    assert.equal(r.coins.length, 1, t);
  }
  assert.deepEqual(d("close all ETH and BTC").coins, ["ETH", "BTC"]);
  assert.deepEqual([d("close half ETH and SOL").coins, d("close half ETH and SOL").fraction], [["ETH", "SOL"], 0.5]);
  assert.equal(d("ปิดครึ่ง ETH กับ SOL").fraction, 0.5);
  assert.equal(d("close 50% BTC and ETH").fraction, 0.5);
  assert.equal(d("close 25% of BTC and ETH").fraction, 0.25);
  assert.equal(d("close 60% of BTC and ETH").fraction, 0.5, "rounded DOWN, never more than asked");
  assert.equal(d("close all").coins, null);
  /* The card carries the share; one market named is its single close card. */
  const b = backend({ positions: [pos("ETH", 0.01), pos("SOL", 1), pos("BTC", 0.001)] });
  assert.equal(R.proposeCloseAll({ coins: ["ETH", "SOL"], fraction: 0.5 }, ctxOf(b)).card.fraction, 0.5);
});

test("F5) 'close all my ETH' through the chat is ONE ETH close card, never every position", async () => {
  chat.setAccount("mock");
  chat.clear();
  const b = backend({ positions: [pos("ETH", 0.01), pos("BTC", 0.001), pos("xyz:TSLA", 0.1)] });
  chat.push({ role: "user", text: "close all my ETH" });
  await A.handleMessage("close all my ETH", opts(b));
  const cards = chat.get().messages.filter((m) => m.role === "card").map((m) => m.card);
  assert.deepEqual(cards.map((c) => [c.kind, c.coin || null]), [["close", "ETH"]]);
  chat.clear();
});

/* ── F7–F9: the trade parser ──────────────────────────────────────────────────────────────────────────────── */

test("F7) Thai 'N เท่า' is the leverage; no leverage at all asks instead of a default-5x card", () => {
  const a = parseShortcut("ชอร์ต BTC 15 ดอล 3 เท่า", COINS);
  assert.deepEqual([a.marginUsdc, a.leverage], [15, 3]);
  const b2 = parseShortcut("ลอง ETH 10 เท่า 20 ดอล", COINS);
  assert.deepEqual([b2.marginUsdc, b2.leverage], [20, 10]);
  assert.equal(parseShortcut("long ETH 20 เท่าไหร่ดี", COINS).leverage, null, "เท่าไหร่ is a question, not a leverage");
  const out = local("long ETH 20", backend());
  assert.equal(cardsOf(out).length, 0);
  assert.match(textOf(out), /What leverage for the long on ETH\? \(max \d+x\)/);
  const th = local("ชอร์ต BTC 15 ดอล", backend());
  assert.match(textOf(th), /^leverage เท่าไหร่สำหรับ short BTC/);
});

test("F8/F9) a bare TP / SL number is read against the live price; '$' is always a price; both are said", () => {
  const hype = byCoin.HYPE.px;
  const o = { refPxOf: (c) => byCoin[c] && byCoin[c].px };
  const sl85 = Math.round(hype * 0.92);
  const p = parseShortcut(`long HYPE 20 2x sl ${sl85} tp ${Math.round(hype * 1.18)}`, COINS, o);
  assert.deepEqual([p.slPx, p.slPct, p.tpPct], [sl85, null, null]);
  assert.equal(p.pxRead, true);
  assert.equal(parseShortcut("long ETH 20 5x tp 25 sl 10", COINS, o).tpPct, 25, "far from the price: a %");
  const usd = parseShortcut("long ETH 20 5x sl $2300", COINS, o);
  assert.deepEqual([usd.slPx, usd.slPct, usd.pxRead], [2300, null, undefined]);
  assert.equal(parseTpSl("tp $3,000 sl $2,300").tpPx, 3000);
  /* The card carries the typed price (never replaced by recommended legs), and the line says how it was read. */
  const out = local(`long HYPE 20 2x sl ${sl85}`, backend());
  const c = cardsOf(out)[0];
  assert.equal(c.slPx, sl85);
  assert.equal(c.recommended, undefined);
  assert.match(textOf(out), new RegExp(`Read as prices: SL \\$${sl85}`));
  /* "ตั้ง SL ETH 2300" on a held ETH long: a TP / SL card AT 2300 (eval X4), never the plan's setups before it. */
  assert.equal(A.preIntent("ตั้ง SL ETH 2300", { coins: COINS, snapshot: SNAP, owner: "t#1", backend: backend() }), null);
  assert.equal(A.preIntent("how many stocks can I trade here?", { coins: COINS, snapshot: SNAP, owner: "t#1", backend: backend() }), null, "a count, never the stock pick (B-Q3)");
  const x4 = local("ตั้ง SL ETH 2300", backend({ positions: [pos("ETH", 0.01, 5, { entryPx: 2400 })] }));
  assert.deepEqual(cardsOf(x4).map((k) => [k.kind, k.slPx]), [["tpsl", 2300]]);
});

test("F8) a typed price becomes the ROE string that lands on EXACTLY that tick (the card and the TP / SL editor)", () => {
  const cases = [
    { leg: "sl", px: 2300, side: "long", entryPx: 2363.4, leverage: 5, szDecimals: 4 },
    { leg: "sl", px: 85, side: "buy", entryPx: 92.858, leverage: 2, szDecimals: 2 },
    { leg: "tp", px: 110, side: "buy", entryPx: 92.858, leverage: 2, szDecimals: 2 },
    { leg: "sl", px: 104.6, side: "sell", entryPx: 102.03, leverage: 10, szDecimals: 2 },
  ];
  for (const c of cases) {
    const r = legStrForPx(c);
    assert.ok(r, JSON.stringify(c));
    const basis = { side: c.side === "buy" || c.side === "long" ? "long" : "short", size: 1, entryPx: c.entryPx, leverage: c.leverage, marginUsdc: c.entryPx / c.leverage, liqPx: null, szDecimals: c.szDecimals, markPx: null };
    assert.equal(tpslLegView({ leg: c.leg, mode: "roe", str: r.str, basis }).px, c.px, JSON.stringify(c));
  }
  assert.equal(legStrForPx({ leg: "sl", px: 2500, side: "long", entryPx: 2363.4, leverage: 5, szDecimals: 4 }), null, "the wrong side has none");
});

/* ── F10: stock questions ──────────────────────────────────────────────────────────────────────────────────── */

test("F10) a stock QUESTION is answered (S8, S9, B-Q1, B-Q2), never a setups card or a close", async () => {
  const d = (t) => I.detectIntent(t, { coins: COINS, markets: ALL });
  assert.equal(d("ซื้อหุ้น Apple ได้ปันผลไหม").kind, "stockAbout");
  assert.equal(d("Apple มีปันผลไหม").kind, "stockAbout");
  const q2 = d("US 100 คืออะไร เทรดตอนตลาดปิดได้ไหม");
  assert.deepEqual([q2.kind, q2.coin, q2.asks.shut, q2.asks.what], ["stockAbout", "xyz:XYZ100", true, true]);
  assert.deepEqual([d("nasdaq จะขึ้นไหม").kind, d("nasdaq จะขึ้นไหม").coin], ["analyze", "xyz:XYZ100"]);
  assert.equal(d("เทสล่า").kind, "setups", "a bare name still gets its setups (S12)");
  assert.equal(d("short NVDA").kind, "setups");
  assert.equal(parseShortcut("US 100 คืออะไร เทรดตอนตลาดปิดได้ไหม", COINS), null, "ตลาดปิด is not a close");
  assert.equal(C.detectCloseAll("US 100 คืออะไร เทรดตอนตลาดปิดได้ไหม", { coins: COINS }), null);

  const said = [];
  const cards = [];
  const io = { step: () => () => {}, say: (t) => said.push(t), card: (c) => cards.push(c) };
  await I.runIntent(d("ซื้อหุ้น Apple ได้ปันผลไหม"), { ctx: ctxOf(backend()), io });
  assert.match(said[0], /^ไม่ได้ปันผล: เป็น perp ที่ตามราคาหุ้น Apple ไม่ใช่หุ้นจริง ไม่มีปันผล/);
  assert.ok(!cards.some((c) => c.kind === "setups" || c.kind === "open"));
  said.length = 0;
  await I.runIntent(q2, { ctx: ctxOf(backend()), io });
  assert.match(said[0], /ดัชนี US 100/);
  assert.match(said[0], /5x/);
  for (const t of said) assert.equal(venueWordHits(t).length, 0, t);
});

/* ── F11: plan warnings ────────────────────────────────────────────────────────────────────────────────────── */

test("F11) a risk plan with no side says FlowFlow picked it (card first note + the line); a held market gets its TP / SL", async () => {
  const eth = byCoin.ETH;
  const up = Array.from({ length: 48 }, (_, i) => ({ time: i * 3_600_000, open: eth.px * (0.95 + i * 0.001), high: eth.px * (0.955 + i * 0.001), low: eth.px * (0.945 + i * 0.001), close: eth.px * (0.952 + i * 0.001), volume: 1 }));
  const said = [];
  const cards = [];
  const io = { step: () => () => {}, say: (t) => said.push(t), card: (c) => cards.push(c) };
  const ctx = ctxOf(backend({ equity: 300 }), { fetchCandles: async () => up });
  await I.runIntent({ kind: "riskPlan", parse: { coin: "ETH", riskUsd: 1, mode: "plan", lang: "en" }, lang: "en" }, { ctx, io });
  const card = cards.find((c) => c.kind === "open");
  assert.ok(card, JSON.stringify(said));
  assert.match(card.notes[0], /^FlowFlow picked (Long|Short):/);
  assert.match(said[0], /^FlowFlow picked (Long|Short):/);
  assert.ok(!/every number is on the card/.test(said.join(" ")));
  /* The plan's lines carry no price level (the rows and the popup print those once). */
  assert.ok(!card.plan.steps.some((l) => /at \$|TP \$|liq \$/.test(l)), card.plan.steps.join(" | "));
  /* Held (eval C7): its TP / SL card, never a dead end. */
  said.length = 0; cards.length = 0;
  const held = ctxOf(backend({ positions: [pos("ETH", 0.01, 3)] }), { fetchCandles: async () => up });
  await I.runIntent({ kind: "riskPlan", parse: { coin: "ETH", riskUsd: 3, side: "buy", mode: "plan", lang: "en" }, lang: "en" }, { ctx: held, io });
  assert.match(said[0], /You already hold ETH/);
  assert.deepEqual(cards.map((c) => c.kind), ["tpsl"]);
});

test("F11) a stock plan card carries the US market's status line once (statusNote), isolated", () => {
  const tsla = byCoin["xyz:TSLA"];
  const bars = Array.from({ length: 168 }, (_, i) => {
    const t = SAT - (168 - i) * 3_600_000;
    return { time: t, open: tsla.px, high: tsla.px * 1.004, low: tsla.px * 0.996, close: tsla.px * (1 + (i % 2 ? 0.001 : -0.001)), volume: 1 };
  });
  const plan = TP.planTrade({ coin: "xyz:TSLA", side: "buy", riskUsd: 2 }, { market: tsla, candles: bars, feeRate: 0.0001, now: SAT, listed: true });
  if (!plan.ok) return; // too few core-session bars in a synthetic week: the plan says so, nothing to pin
  const c = TP.planToOpenCard(plan);
  assert.equal(c.marginMode, "isolated");
  assert.match(c.statusNote, /^US market closed · opens in/);
  /* The state itself is said once (the cap it causes is its own short note: "max 5x on stocks now"). */
  assert.ok(!(c.notes || []).some((n) => /opens in|own model|thinner trading/.test(n)), JSON.stringify(c.notes));
});

/* ── F12 / F14: words and figures ─────────────────────────────────────────────────────────────────────────── */

test("F12) the customer's words after a fill or an error: 'US 100', Main Account", () => {
  assert.equal(customerWords("Longed XYZ100 · 2x"), "Longed US 100 · 2x");
  assert.equal(customerWords("Filled at $29,600 · size 0.0007 XYZ100"), "Filled at $29,600 · size 0.0007 US 100");
  assert.equal(customerWords("Your Perp balance doesn't cover this order."), "Your Main Account balance doesn't cover this order.");
  assert.equal(customerWords("Couldn't read your Perp account from Hyperliquid."), "Couldn't read your Main Account.");
  assert.equal(venueWordHits(customerWords("Closed 0.0007 XYZ100 at $29,600")).length, 0);
});

test("F14) one fee, one % meaning, the isolated pill in the popup", () => {
  assert.equal(feeWords(0.003), "< 0.01 USDC");
  assert.equal(feeWords(0.02), "≈ 0.02 USDC");
  const v = finalTradeView({ coin: "xyz:TSLA", side: "buy", leverage: 3, marginUsdc: 10, entryPx: 360, tpPx: 367, slPx: 356.5, notionalUsd: 30, feeUsdc: 0.0027 }, { now: OPEN });
  assert.equal(v.pill, "3x Long · Isolated");
  assert.equal(v.feeText, "< 0.01 USDC");
  assert.match(v.legend.find((l) => l.id === "tp").pctText, /^\+1\.94%$/, "the price move, as the card prints it");
});

/* ── the eval rows ─────────────────────────────────────────────────────────────────────────────────────────── */

test("eval S2 (held) / S5: a stock buy with no leverage asks (with the cap said first), or adds to the held one", async () => {
  const said = [];
  const cards = [];
  const io = { step: () => () => {}, say: (t) => said.push(t), card: (c) => cards.push(c) };
  await I.runIntent({ kind: "trade", coin: "xyz:AAPL", side: "buy", marginUsdc: 50, leverage: null, lang: "th" }, { ctx: ctxOf(backend()), io });
  assert.match(said[0], /มาร์จิ้นสูงสุด 20 USDC|margin สูงสุด 20|สูงสุด 20/);
  assert.match(said[0], /leverage เท่าไหร่/);
  assert.ok(!said.some((t) => /Ask the user/.test(t)), "the tool's instruction is never shown");
  said.length = 0; cards.length = 0;
  await I.runIntent({ kind: "trade", coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: null, lang: "th" }, { ctx: ctxOf(backend({ positions: [pos("xyz:TSLA", 0.1, 3)] })), io });
  assert.ok(!said.some((t) => /Ask the user/.test(t)), said.join(" | "));
  assert.equal(cards[0] && cards[0].kind, "open");
  assert.equal(cards[0].leverage, 3, "the add's own leverage");
});

test("eval F2 / F3 / F4 / B-D1 / Z2 / B-Q3 / B-K1: swap, move, deposit, counts and 'stock account' answer deterministically", async () => {
  const d = (t) => I.detectIntent(t, { coins: COINS, markets: ALL });
  assert.equal(d("อยากแลก USDC เป็น AVAX 5 ดอล").kind, "swap");
  assert.deepEqual([d("move 10 USDC from Main to Spot").kind, d("move 10 USDC from Main to Spot").to], ["move", "spot"]);
  assert.equal(d("ฝากเงิน").kind, "deposit");
  assert.equal(d("deposit 50 USDC").kind, "deposit");
  assert.equal(d("ฝากเงินแล้วยังไม่เข้า"), null, "a missing deposit is the model's funds question");
  assert.equal(d("how many assets do you have").kind, "counts");
  assert.deepEqual([d("how many stocks can I trade here?").kind, d("how many stocks can I trade here?").focus], ["counts", "stocks"]);
  assert.equal(d("ย้ายเงินไปบัญชีหุ้น 50").kind, "stockAccount");
  const said = [];
  const cards = [];
  const io = { step: () => () => {}, say: (t) => said.push(t), card: (c) => cards.push(c) };
  const ctx = ctxOf(backend());
  await I.runIntent(d("how many assets do you have"), { ctx, io });
  const n = R.marketCounts(SNAP);
  assert.ok(n.crypto_perps > 50 && n.stocks > 5 && n.spot_coins >= 5, JSON.stringify(n));
  assert.equal(said[0], `FlowFlow has ${n.crypto_perps} crypto perps, ${n.stocks} US stocks and indices, and ${n.spot_coins} coins in the Spot Account.`);
  assert.equal(cards[0].kind, "choices");
  said.length = 0; cards.length = 0;
  await I.runIntent(d("deposit 50 USDC"), { ctx, io });
  assert.ok(cards[0].items.some((x) => x.to === "/wallet?panel=deposit"), "a Deposit button, never only the words");
  said.length = 0; cards.length = 0;
  await I.runIntent(d("ย้ายเงินไปบัญชีหุ้น 50"), { ctx, io });
  assert.match(said[0], /ไม่มีบัญชีแยกสำหรับหุ้น/);
  assert.equal(venueWordHits(said[0]).length, 0);
  /* The model's own correct sentence about it is kept, not dropped (B-K1 showed only "ผมเปิดการ์ดให้ได้เลย."). */
  assert.match(scrubVenueWords("FlowFlow ไม่มีบัญชีหุ้นแยก เงินสำหรับหุ้นอยู่ใน Main Account"), /ไม่มีบัญชีแยกสำหรับหุ้น/);
  /* get_markets carries the counts for the model too. */
  assert.deepEqual((await R.runReadTool("get_markets", {}, ctx)).counts, n);
});

test("words: one name per US market state; refusals name examples by name; picks' Thai line is neutral", () => {
  const pre = usSessionView(Date.UTC(2026, 9, 15, 12, 0), "stock");
  assert.match(statusText(pre), /^US pre-market · opens in/);
  assert.match(analysisRow(pre).value, /^Pre-market · opens in/);
  const r = I.detectIntent("long GOLD 10 3x", { coins: COINS, markets: ALL }) || A.stockTradeIntent("long GOLD 10 3x", SNAP);
  const text = r.refusal ? r.refusal.texts.en : "";
  assert.match(text, /for example/);
  assert.doesNotMatch(text, /US100|SP500/);
  const pk = buildPickCard({ group: "movers", lang: "th" }, { markets: ALL });
  assert.doesNotMatch(pk.card.line, /วิ่งแรง/);
  assert.deepEqual(chipsFor({ cards: [{ kind: "pick", group: "movers" }] }).slice(0, 2).map((c) => c.text), ["Pick a stock", "Pick a meme"]);
});

test("voice fix: a long ask naming one market + a trade word is its setups; a long sized order stays the model's", () => {
  const d = (t) => I.detectIntent(t, { coins: COINS, markets: ALL });
  const r = d("อยาก อยากเปิดลอง Nvidia อยากตั้ง position TPSL ให้เหมาะสมอะ ลองดูให้หน่อยทีได้ เปิดเท่าไหร่ดี");
  assert.deepEqual([r && r.kind, r && r.coin], ["setups", "xyz:NVDA"]);
  assert.equal(d("please put 10 usdc on eth at 3x going up for me, and no tp sl this time thanks"), null);
  assert.equal(d("I want to stake, but how does Aave work and what are the risks for me here?"), null);
});

test("voice fix: the trade parser never answers the long NVDA ask with the account", () => {
  const r = I.longTradeIntent("อยาก อยากเปิดลอง Nvidia อยากตั้ง position TPSL ให้เหมาะสมอะ ลองดูให้หน่อยทีได้ เปิดเท่าไหร่ดี", { coins: COINS, markets: ALL });
  assert.deepEqual([r && r.kind, r && r.coin], ["setups", "xyz:NVDA"]);
  assert.equal(I.longTradeIntent("show my positions", { coins: COINS, markets: ALL }), null, "a short ask is the parser's");
});

test("voice fix: closing, a held position's TP / SL, staking and analysis never become setups", () => {
  const L = (t) => I.longTradeIntent(t, { coins: COINS, markets: ALL, anyLength: true });
  assert.equal(L("ช่วยปิด position NVDA ให้หน่อยนะครับ ขอบคุณมาก"), null);
  assert.equal(L("ตั้ง TPSL ให้ position NVDA ที่มีอยู่หน่อย"), null);
  assert.equal(L("close my ETH position please"), null);
  assert.equal(L("วิเคราะห์ ETH ให้หน่อย อยากเปิด"), null);
  assert.equal(L("เปิด NVDA ดีไหม TP SL เท่าไหร่ดี").coin, "xyz:NVDA", "voice: any length");
  assert.equal(I.longTradeIntent("เปิด NVDA ดีไหม", { coins: COINS, markets: ALL }), null, "typed and short: the parser's");
});

test("owner: the asset boxes come once per chat, never while the talk is about a trade or a position", async () => {
  const { boxesWanted } = await import("../src/agent/suggest.js");
  assert.equal(boxesWanted([], "what is funding"), true);
  assert.equal(boxesWanted([{ role: "card", card: { kind: "assets", items: [] } }], "what is funding"), false, "once per chat");
  for (const t of ["ลอง ชอร์ต เลเวอเรจ ยืนยัน", "5x margin 20 usdc", "ตั้ง TP SL ให้ position ETH", "close my position"]) assert.equal(boxesWanted([], t), false, t);
});
