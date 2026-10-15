/**
 * test-agent-stocks — the Agent knows stocks and the whole money map (src/agent/stocks.js, stockWords.js, moneyMap.js).
 *
 * Owner, 2026-10-15: "Agent เราตอนนี้คุณภาพโอเคยัง รู้ยังว่าเทรดหุ้นได้ … ทำความเข้าใจทุกอย่างหรือยังวะ" and, on the
 * venue: "คนไม่ต้องรู้ห่าอะไรเลย". Rows are the shared store's own parse of the 2026-10-15 captures (main dex + xyz), so
 * the gate reads exactly what the app reads. The clock is pinned; no network.
 *
 * Run: node --test scripts/test-agent-stocks.mjs
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
const { parseHlCandles } = await import("../src/lib/hyperliquid/candles.js");
const S = await import("../src/agent/stocks.js");
const W = await import("../src/agent/stockWords.js");
const M = await import("../src/agent/moneyMap.js");
const { buildSetups, SETUP_MAX_LEVERAGE, RANGE_BARS } = await import("../src/agent/setups.js");
const { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } = await import("../src/perp/guardrails.js");
const { CLOSED_AGENT_MAX_LEVERAGE } = await import("../src/lib/hyperliquid/hip3/guard.js");
const { perpLegOf } = await import("../src/lib/perpEquity.js");

const main = parsePerpMarkets(fx("hl-meta-and-asset-ctxs.json"), { now: 1 }).markets;
const xyz = parsePerpMarkets(fx("hip3/xyz-meta-and-asset-ctxs.json"), { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" }).markets;
const ALL = [...main, ...xyz];
const SNAP = { markets: ALL };

/* Pinned instants (UTC). New York is UTC-4 until 1 Nov 2026, UTC-5 after. */
const OPEN = Date.UTC(2026, 9, 15, 15, 0);        // Thu 11:00 ET, core session
const PRE = Date.UTC(2026, 9, 15, 12, 0);         // Thu 08:00 ET, early session
const NIGHT = Date.UTC(2026, 9, 15, 7, 37);       // Thu 03:37 ET, overnight (the capture's own instant)
const SAT = Date.UTC(2026, 9, 17, 15, 0);         // Sat 11:00 ET
const EST_OPEN = Date.UTC(2026, 10, 2, 15, 0);    // Mon 2 Nov 10:00 EST
const THANKS = Date.UTC(2026, 10, 26, 16, 0);     // Thanksgiving, 11:00 EST
const BREAK = Date.UTC(2026, 9, 13, 21, 30);      // Tue 17:30 ET: index futures' daily break

const clean = (s) => W.venueWordHits(s);

test("names, Thai and English, land on the one listed stock; crypto on the main dex always wins", () => {
  const cases = {
    TSLA: "xyz:TSLA", tsla: "xyz:TSLA", "เทสล่า": "xyz:TSLA", Tesla: "xyz:TSLA", "xyz:TSLA": "xyz:TSLA",
    "ซื้อ Tesla 10 ดอล": "xyz:TSLA", "long TSLA 10 3x": "xyz:TSLA", "short NVDA": "xyz:NVDA", "เอ็นวิเดีย": "xyz:NVDA",
    "ซื้อหุ้นแอปเปิ้ล 15 ดอลลาร์": "xyz:AAPL", "nasdaq จะขึ้นไหม": "xyz:XYZ100", US100: "xyz:XYZ100", "S&P 500": "xyz:SP500",
    "buy me some tesla": "xyz:TSLA", "is not tesla up": "xyz:TSLA",
  };
  for (const [q, coin] of Object.entries(cases)) {
    const r = S.resolveMarket(q, ALL);
    assert.ok(r && r.ok && r.kind === "stock", q);
    assert.equal(r.coin, coin, q);
    assert.equal(r.row.coin, coin, `${q}: the store's own row`);
  }
  /* Crypto first: the main dex's names, and everyday words written in capitals beside a stock. */
  for (const [q, coin] of Object.entries({ BTC: "BTC", eth: "ETH", PEPE: "kPEPE", SPX: "SPX", "long BTC 10 3x": "BTC", "close chip": "CHIP", "buy ME and tesla": "ME" })) {
    const r = S.resolveMarket(q, SNAP);
    assert.ok(r && r.ok && r.kind === "crypto", q);
    assert.equal(r.coin, coin, q);
  }
  for (const q of ["hey any plan", "", null, "which coin should I buy"]) assert.equal(S.resolveMarket(q, ALL), null, String(q));
  assert.equal(S.resolveMarket("TSLA", ALL).ticker, "TSLA");
  assert.equal(S.resolveMarket("nasdaq", ALL).ticker, "US100", "the model never reads the venue's own ticker");
  assert.equal(S.resolveMarket("nasdaq จะขึ้นไหม", ALL).name, "ดัชนี US 100");
});

test("the gate is the Stock pill's: a paused stock and an unlisted name get a reason and listed alternatives, no card", () => {
  const nflx = S.resolveMarket("short NFLX 10 3x", ALL);
  assert.equal(nflx.ok, false);
  assert.equal(nflx.reason, "held", "NFLX: $1.5M 24h volume, under the gate");
  assert.match(nflx.texts.en, /Netflix is paused/);
  assert.match(nflx.texts.th, /พักการเทรด/);
  assert.equal(nflx.alternatives.length, 3);
  for (const a of nflx.alternatives) assert.ok(S.stockListed(a.coin, ALL) && a.coin !== "xyz:NFLX", a.coin);
  for (const q of ["long GOLD 10", "long ทองคำ", "ทองคำ", "GOLD", "xyz:GOLD", "AVGO", "long broadcom 10 3x"]) {
    const r = S.resolveMarket(q, ALL);
    assert.ok(r && r.ok === false && r.kind === "unlisted" && r.reason === "not_listed", q);
    assert.ok(r.alternatives.length > 0, q);
    assert.deepEqual(clean(r.text), [], q);
  }
  assert.equal(S.resolveMarket("long ทองคำ", ALL).text.startsWith("ยังไม่มีทองคำ"), true);
  /* Whitelisted but its row missing while the stock list is loaded; nothing loaded at all. */
  assert.equal(S.resolveMarket("TSLA", ALL.filter((m) => m.coin !== "xyz:TSLA")).reason, "not_live");
  assert.equal(S.resolveMarket("TSLA", main).reason, "loading");
  /* A row under the gate today (no volume read) is never offered, whatever its name. */
  assert.equal(S.resolveMarket("TSLA", ALL.map((m) => (m.coin === "xyz:TSLA" ? { ...m, dayNtlVlm: null } : m))).ok, false);
  assert.equal(S.stockListed("xyz:TSM", ALL), true);
  assert.equal(S.stockListed("xyz:NFLX", ALL), false);
  assert.equal(S.stockListed("BTC", ALL), false);
});

test("caps in code: 20 USDC margin, ≤ min(10x, market max), ≤ 5x while the US market is closed, ≥ $10, isolated", () => {
  assert.equal(MAX_MARGIN_USDC, 20);
  assert.equal(AGENT_MAX_LEVERAGE, 10);
  assert.equal(CLOSED_AGENT_MAX_LEVERAGE, 5);
  const o = (coin, side, margin, lev, now, lang = "en") => S.checkAgentStockOrder({ coin, side, marginUsdc: margin, leverage: lev, markets: ALL, now, lang });

  const s1 = o("TSLA", "long", 10, 3, OPEN);
  assert.equal(s1.ok, true);
  assert.deepEqual([s1.coin, s1.leverage, s1.marginUsdc, s1.marginMode, s1.notionalUsd], ["xyz:TSLA", 3, 10, "isolated", 30]);
  assert.deepEqual(s1.notes, []);
  assert.deepEqual(s1.warnings, []);

  const s3 = o("TSLA", "long", 10, 10, SAT);
  assert.equal(s3.ok, true);
  assert.equal(s3.leverage, 5);
  assert.deepEqual(s3.notes, ["Max 5x on stocks while the US market is closed"]);
  assert.ok(s3.warnings.includes("us_market_closed"));
  assert.equal(o("TSLA", "long", 10, 10, NIGHT).leverage, 5, "a weekday night is closed too");
  assert.equal(o("TSLA", "long", 10, 10, PRE).leverage, 10, "the early session is not closed");
  assert.ok(o("TSLA", "long", 10, 10, PRE).warnings.includes("extended_hours"));
  assert.equal(o("TSLA", "long", 10, 10, THANKS).leverage, 5, "US holiday");
  assert.equal(o("SP500", "long", 10, 40, OPEN).leverage, 10, "SP500 allows 50x; the Agent stays at 10x");
  assert.deepEqual(o("SP500", "long", 10, 40, OPEN).notes, ["Max 10x for trades FlowFlow proposes"]);

  const s4 = o("AMD", "long", 15, 20, OPEN);
  assert.equal(s4.leverage, 10);
  assert.deepEqual(s4.notes, ["AMD allows at most 10x"]);
  assert.deepEqual(o("AMD", "long", 15, 20, SAT, "th").notes, ["ตลาดหุ้น US ปิดอยู่ หุ้นใช้ได้สูงสุด 5x"]);

  const s5 = o("Apple", "long", 50, 3, OPEN);
  assert.equal(s5.ok, true);
  assert.equal(s5.marginUsdc, 20);
  assert.deepEqual(s5.notes, ["Max 20 USDC per order in FlowFlow for now"]);

  const small = o("TSLA", "long", 3, 2, OPEN);
  assert.equal(small.ok, false);
  assert.ok(small.refusals.includes("min_value"));
  assert.deepEqual(small.fix, { marginUsdc: 5 });
  assert.match(small.text, /at least \$10.*5 USDC/);

  const s2 = o("Tesla", "long", 10, null, OPEN, "th");
  assert.equal(s2.ok, false, "no leverage: never guessed");
  assert.match(s2.ask, /leverage/);
  assert.equal(s2.text, null, "a missing figure is a question, not a refusal");
  assert.match(o("Tesla", "long", null, 3, OPEN).ask, /USDC margin/);

  const s6 = o("NFLX", "short", 10, 3, OPEN);
  assert.equal(s6.ok, false);
  assert.deepEqual(s6.refusals, ["held"]);
  assert.ok(s6.alternatives.length > 0);
  assert.deepEqual(o("GOLD", "long", 10, 3, OPEN).refusals, ["not_listed"]);
  assert.deepEqual(o("BTC", "long", 10, 3, OPEN).refusals, ["market_unknown"], "a crypto is not a stock order");
  for (const r of [s1, s3, s4, s5, small, s2, s6]) {
    for (const line of [...r.notes, ...r.warningTexts, r.text || "", r.ask || ""]) assert.deepEqual(clean(line), [], line);
  }
});

test("market state: open / outside hours / closed, Thai hours across the clock change, model band, fee, a perp not a share", () => {
  const f = (coin, now) => S.stockFacts(coin, { markets: ALL, now });
  const open = f("xyz:TSLA", OPEN);
  assert.deepEqual([open.state, open.priceSource, open.leverageClosed, open.hoursThai, open.closesInMin], ["open", "live", false, "20:30–03:00", 300]);
  assert.equal(open.maxLeverage, 10);
  assert.equal(open.setupMaxLeverage, SETUP_MAX_LEVERAGE);
  assert.equal(open.feeText, "0.009%");
  assert.equal(open.marginMode, "isolated");
  assert.equal(open.status.en, "US market open · closes in 5h");

  const pre = f("xyz:TSLA", PRE);
  assert.deepEqual([pre.state, pre.opensInMin, pre.leverageClosed], ["extended", 90, false]);
  /* Pass-2 fix: one name per state everywhere (the popup's): pre-market, after hours, closed. */
  assert.match(pre.status.th, /^ก่อนตลาดหุ้น US เปิด · เปิด 20:30 เวลาไทย \(อีก 1 ชม\. 30 นาที\): ซื้อขายบาง/);
  assert.match(pre.status.en, /^US pre-market · opens in 1h 30m: thinner trading, bigger moves$/);
  const night = f("xyz:TSLA", NIGHT);
  assert.deepEqual([night.state, night.leverageClosed, night.maxLeverage], ["extended", true, 5], "overnight: an outside price, but closed for leverage");

  const sat = f("xyz:TSLA", SAT);
  assert.deepEqual([sat.state, sat.priceSource, sat.maxLeverage], ["closed", "model", 5]);
  assert.deepEqual(sat.modelBand, { pct: 5, ranges: 3, from: "docs" });
  assert.match(sat.status.en, /^US market closed · opens in 1d 22h: the price comes from the market's own model \(±5% at a time\) and can jump at the open$/);
  assert.match(sat.status.th, /^ตลาดหุ้น US ปิด · เปิดอีก 1 วัน 22 ชม\.: ราคามาจาก model ของตลาดเอง \(ขยับได้ทีละ ±5%\) เปิดตลาดอาจกระโดด$/);
  assert.equal(f("xyz:AMD", SAT).modelBand.pct, 10, "others: ±(1 / max leverage)");

  assert.equal(f("xyz:TSLA", EST_OPEN).hoursThai, "21:30–04:00", "after 1 Nov");
  assert.equal(f("xyz:TSLA", Date.UTC(2026, 9, 30, 15)).hoursThai, "20:30–03:00");
  const hol = f("xyz:TSLA", THANKS);
  assert.deepEqual([hol.state, hol.holiday], ["closed", "Thanksgiving Day"]);
  /* An index's price follows the futures clock: its daily break is "closed", a stock at that hour is "outside hours". */
  assert.equal(f("xyz:SP500", BREAK).state, "closed");
  assert.equal(f("xyz:TSLA", BREAK).state, "extended");

  assert.match(open.whatItIs.en, /not the share: no dividends, no votes/);
  assert.match(open.whatItIs.th, /ไม่ใช่หุ้นจริง ไม่มีปันผล/);
  assert.deepEqual(open.analysisRow.en, { label: "US market", value: "Open", tone: "ok" });
  assert.deepEqual(sat.analysisRow.en, { label: "US market", value: "Closed · opens in 1d 22h", tone: "warn" });
  assert.equal(S.stockFacts("BTC", { markets: ALL, now: OPEN }), null);
});

test("what the model reads: tickers and plain words only, never the venue", () => {
  const m = S.stockMarketForModel("nasdaq", { markets: ALL, now: OPEN });
  assert.equal(m.coin, "US100");
  assert.equal(m.name, "US 100 index");
  assert.equal(m.market_status, "open");
  assert.equal(m.max_leverage_now, 10);
  assert.deepEqual(clean(JSON.stringify(m)), []);
  const closed = S.stockMarketForModel("TSLA", { markets: ALL, now: SAT });
  assert.equal(closed.market_status, "closed");
  assert.equal(closed.model_moves_up_to_pct, 5);
  assert.equal(closed.max_leverage_now, 5);
  const list = S.stockRowsForModel(SNAP, { now: OPEN, limit: 5 });
  assert.equal(list.stocks.length, 5);
  assert.deepEqual(list.stocks.slice(0, 3).map((r) => r.coin), ["US100", "SP500", "NVDA"], "the Stock pill's order: 24h volume");
  assert.match(list.us_market, /^US market open/);
  assert.deepEqual(clean(JSON.stringify(list)), []);
  assert.equal(S.stockMarketForModel("NFLX", { markets: ALL, now: OPEN }).listed, false);
  assert.deepEqual(S.stockCandidates(ALL, { n: 4, held: new Set(["xyz:XYZ100"]) }).length, 4);
  assert.equal(S.stockCandidates(ALL, { n: 4, held: new Set(["xyz:XYZ100"]) }).includes("xyz:XYZ100"), false);
});

/* 1h candles for every hour of Mon 12 – Fri 16 Oct 2026 (seconds), around 360 with a 2-dollar range. */
function weekdayCandles() {
  const out = [];
  const start = Date.UTC(2026, 9, 12, 0) / 1000;
  for (let i = 0; i < 24 * 5; i++) {
    const o = 360 + Math.sin(i / 5) * 4 + i * 0.05;
    out.push({ time: start + i * 3600, open: o, high: o + 1.2, low: o - 0.8, close: o + 0.3, volume: 100 });
  }
  return out;
}

test("setups for a stock read only US-hours candles, and stay ≤ 3x (≤ 5x closed never loosens it)", () => {
  const weekend = parseHlCandles(fx("hip3/xyz-candles-TSLA-1h-weekend.json"));
  const few = S.stockSetupsInput({ coin: "TSLA", candles: weekend, markets: ALL, now: SAT });
  assert.equal(few.ok, false);
  assert.equal(few.why, "few-core-candles");
  assert.ok(few.bars < RANGE_BARS, String(few.bars));
  assert.equal(S.stockCandles(weekend), null, "no recommended TP / SL from a weekend's range");

  const bars = weekdayCandles();
  const inp = S.stockSetupsInput({ coin: "TSLA", candles: bars, markets: ALL, now: Date.UTC(2026, 9, 16, 21) });
  assert.equal(inp.ok, true);
  assert.equal(inp.candles.length, 30, "6 core hours a day × 5 days");
  assert.ok(inp.candles.every((c) => W.usSessionView(c.time * 1000).state === "open"));
  assert.ok(inp.profiles.every((p) => p.lev <= SETUP_MAX_LEVERAGE && p.lev <= CLOSED_AGENT_MAX_LEVERAGE));
  const r = buildSetups({ market: inp.market, candles: inp.candles, profiles: inp.profiles, freeUsdc: 50, now: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.setups.length >= 1);
  for (const s of r.setups) assert.ok(s.leverage <= SETUP_MAX_LEVERAGE && s.marginUsdc <= MAX_MARGIN_USDC, JSON.stringify(s));
  assert.equal(S.stockSetupsInput({ coin: "NFLX", candles: bars, markets: ALL }).ok, false);
  assert.equal(S.stockSetupsInput({ coin: "BTC", candles: bars, markets: ALL }).why, "not-listed");
});

test("the scrubber rewrites what has a plain name and drops what is plumbing; ordinary words pass", () => {
  const cases = [
    ["Long xyz:TSLA at 3x.", "Long TSLA at 3x."],
    ["XYZ100 is up 1%.", "US 100 index is up 1%."],
    ["The XYZ100 index tracks the Nasdaq-100.", "The US 100 index tracks the US 100 index."],
    ["ดัชนี XYZ100 ขึ้น 1%", "ดัชนี US 100 ขึ้น 1%"],
    ["แนสแด็ก 100 ขึ้น", "ดัชนี US 100 ขึ้น"],
    ["Prices come from trade[XYZ]'s model.", "Prices come from the market's model."],
    ["TSLA is a HIP-3 stock perp.", "TSLA is a stock perp."],
    ["หุ้น HIP-3 เทรดได้ 24 ชม.", "หุ้น เทรดได้ 24 ชม."],
    ["Your order is ready. Margin moves to the xyz dex first. Tap Confirm.", "Your order is ready. Tap Confirm."],
    ["Money sits in a separate pot. TSLA is open.", "TSLA is open."],
    ["Trading venue is closed.\nTSLA closes at 03:00.", "TSLA closes at 03:00."],
    ["Moving money to your stock account now.", ""],
  ];
  for (const [inp, out] of cases) assert.equal(S.scrubVenueWords(inp), out, inp);
  assert.equal(S.scrubVenueWords("เงินอยู่ในกองหุ้น", { fallback: "ดูการ์ดด้านบน" }), "ดูการ์ดด้านบน", "all of it was plumbing: the caller's fallback");
  for (const ok of ["Your Spot Account holds 5 USDC.", "The S&P 500 index is up.", "ซื้อกองทุนรวมดีไหม", "Long ETH 20 5x", "TSLA closes in 5h", "The index is up"]) {
    assert.equal(S.scrubVenueWords(ok), ok, ok);
    assert.deepEqual(W.venueWordHits(ok), [], ok);
  }
  const d = S.scrubVenueWordsDetailed("Margin moves to the xyz dex. Done.");
  assert.deepEqual([d.text, d.changed, d.dropped], ["Done.", true, 1]);
  assert.deepEqual(d.hits.sort(), ["dex", "xyz"]);
  for (const w of ["xyz", "HIP-3", "trade[XYZ]", "dex", "venue", "pot", "กอง", "Nasdaq-100"]) assert.ok(W.BANNED_VENUE_WORDS.includes(w), w);
});

test("stocks are offered only when the user asks about stocks, or asks what to trade today", () => {
  for (const t of ["หุ้นตัวไหนดี", "เลือกหุ้นให้หน่อย", "any stocks to buy?", "Tesla", "nasdaq จะขึ้นไหม", "ซื้อหุ้น Apple ได้ปันผลไหม", "S&P 500 today"]) {
    assert.equal(W.asksAboutStocks(t), true, t);
    assert.equal(W.mayOfferStocks(t), true, t);
  }
  for (const t of ["วันนี้เทรดอะไรดี", "what should I trade today"]) {
    assert.equal(W.asksAboutStocks(t), false, t);
    assert.equal(W.mayOfferStocks(t), true, t);
  }
  for (const t of ["long BTC 10 3x", "top movers", "hey", "meme ตัวไหนดี", "which coin", ""]) assert.equal(W.mayOfferStocks(t), false, t);
});

/* A backend with a Tesla long and an ETH short, standard mode, 4 USDC kept apart. */
function backendWith({ positions = true, idle = 4 } = {}) {
  const list = positions ? [
    { coin: "ETH", dex: "", szi: -0.01, side: "short", marginUsed: 6.5 },
    { coin: "xyz:TSLA", dex: "xyz", szi: 0.08, side: "long", marginUsed: 9.7 },
  ] : [];
  return {
    connected: true, mock: false,
    account: {
      perpBalanceUsdc: { answered: true, source: "perp", equityUsdc: 50.12, availableUsdc: 33.9, idleSpotUsdc: idle, venueEquityUsdc: 9.9, complete: true, reason: null },
      positions: { answered: true, list, byCoin: Object.fromEntries(list.map((p) => [p.coin, p])) },
    },
  };
}

test("the money map: Main Account counts stocks, Spot Account holds AVAX coins and USDC Staked, Private only for outside money", () => {
  const p = M.moneyMapPrompt({ now: OPEN });
  for (const w of ["Main Account", "Spot Account", "USDC Staked · AAVE (AVAX)", "Normal | Private", "Private is only for money from or to the outside",
    "never Private", "Never offer a move for a stock", "at most 20 USDC per order", "at most 10x", "5x while the US market is closed", `setups at most ${SETUP_MAX_LEVERAGE}x`,
    "no dividends", "20:30–03:00 Thai time", "ดัชนี US 100"]) {
    assert.ok(p.includes(w), w);
  }
  /* The only place a banned word appears is the line that bans it. */
  const words = p.split("\n").filter((l) => !/Never say xyz|talk about moving money|never Nasdaq-100/.test(l)).join("\n");
  assert.deepEqual(clean(words), []);
  assert.equal(M.moneyMapPrompt({ maxLeverage: 2 }).includes("setups at most 2x"), true, "env may only lower");
  assert.deepEqual(clean(JSON.stringify(M.MONEY_MAP)), []);
  assert.deepEqual([...M.MONEY_MAP.privateOnlyFor], ["deposit", "withdraw"]);
  for (const mv of M.MONEY_MAP.moves) if (!M.MONEY_MAP.privateOnlyFor.includes(mv.id)) assert.equal(mv.modes.includes("Private"), false, mv.id);
  for (const name of ["Hyperliquid", "Relay", "NEAR", "Privy", "Arbitrum"]) assert.equal(p.includes(name), false, name);

  /* S10: "เงินฉันอยู่ไหน" with a TSLA position: one Main Account figure, the stock inside it, no venue word. */
  const b = backendWith();
  const map = M.moneyMapFor({ backend: b, spot: null });
  assert.equal(map.main_account.total_usdc, perpLegOf(b.account).usdc, "the home Balance's own Main leg");
  assert.equal(map.main_account.total_usdc, 54.12);
  assert.equal(map.main_account.in_positions_usdc, 16.2);
  assert.equal(map.main_account.in_stock_positions_usdc, 9.7);
  assert.deepEqual(map.main_account.stock_positions, [{ stock: "Tesla", ticker: "TSLA", side: "long", margin_usdc: 9.7 }]);
  assert.equal(map.main_account.crypto_positions, 1);
  assert.equal(map.spot_account.read, false);
  assert.equal(map.balance_usdc, null, "an unread Spot Account is not 0");
  assert.match(map.balance_note, /Spot Account not read/);
  assert.match(map.summary, /Your Main Account holds 54\.12 USDC \(33\.9 USDC free, 16\.2 USDC in open positions\)\. That includes your stock position \(Tesla long\): 9\.7 USDC of it backs that position\. Your Spot Account wasn't checked just now\./);
  assert.deepEqual(clean(JSON.stringify(map)), []);

  /* The Spot Account read: USDC counts as itself, another coin only at a price; staked USDC counted. */
  const spot = { assets: [{ symbol: "USDC", amount: 5 }, { symbol: "AVAX", amount: 0.02 }, { symbol: "BTC.b", amount: 0 }], aave: { suppliedUsdc: 3 } };
  const unpriced = M.moneyMapFor({ backend: b, spot, apyPct: 5.7 });
  assert.equal(unpriced.spot_account.partial, true);
  assert.equal(unpriced.spot_account.total_usdc, 8, "the counted part, flagged partial");
  assert.equal(unpriced.balance_usdc, null);
  assert.deepEqual(unpriced.spot_account.coins.map((c) => c.symbol), ["USDC", "AVAX"], "a zero balance is not listed");
  assert.match(unpriced.summary, /Your Spot Account holds 5 USDC, 0\.02 AVAX, 3 USDC Staked at 5\.7% APY \(part of it couldn't be priced or read\)\./);
  const priced = M.moneyMapFor({ backend: b, spot, priceOf: (s) => (s === "AVAX" ? 25 : null) });
  assert.equal(priced.spot_account.total_usdc, 8.5);
  assert.equal(priced.balance_usdc, 62.62, "one Balance = Main + Spot");

  /* funds' own summary leads (it already says what is on its way in); the stock and Spot lines follow. */
  const withFunds = M.moneyMapFor({ backend: b, spot, priceOf: () => 25, funds: { summary: "Your Main Account holds 50.12 USDC.", perp: { inSpotUsdc: 4 }, arbitrumWallet: { usdc: 9.918, waitingToMove: true }, depositsOnTheWay: [] } });
  assert.ok(withFunds.summary.startsWith("Your Main Account holds 50.12 USDC. That includes your stock position (Tesla long)"));
  assert.equal(withFunds.main_account.incoming_usdc, 9.918);
  assert.equal(withFunds.main_account.kept_apart_usdc, 4);
  assert.equal(M.moneyMapFor({ backend: b, funds: { summary: "x", depositsUnread: "loading", depositsOnTheWay: [] } }).main_account.incoming_usdc, null, "unread is not 0");

  const unread = M.moneyMapFor({ backend: { connected: true, account: { perpBalanceUsdc: { answered: false }, positions: { answered: false } } } });
  assert.equal(unread.main_account.total_usdc, null);
  assert.equal(unread.main_account.stock_positions, null);
  assert.match(unread.summary, /hasn't loaded yet/);
});

/* AGENT-STOCKS-BRIEF §2 item 4: the ten stock prompts, the parts code decides (the live eval scores the model's prose). */
test("the ten stock eval prompts S1–S10, deterministic half", () => {
  const card = (text, margin, lev, now) => {
    const r = S.resolveMarket(text, ALL);
    if (!r || r.kind !== "stock" || !r.ok) return { r };
    return { r, o: S.checkAgentStockOrder({ coin: r.ticker, side: /short|ขาย/i.test(text) ? "short" : "long", marginUsdc: margin, leverage: lev, markets: ALL, now, lang: W.langOf(text) }) };
  };
  const s1 = card("long TSLA 10 3x", 10, 3, OPEN);
  assert.equal(s1.o.ok && s1.o.coin === "xyz:TSLA" && s1.o.name === "Tesla" && s1.o.marginMode === "isolated", true, "S1");
  assert.ok(S.stockCandles(weekdayCandles()), "S1: core candles enough for the recommended TP / SL");
  assert.ok(card("ซื้อ Tesla 10 ดอล", 10, null, OPEN).o.ask, "S2: asks the leverage, never guesses");
  assert.equal(card("long TSLA 10 10x", 10, 10, SAT).o.leverage, 5, "S3");
  assert.equal(card("long AMD 15 20x", 15, 20, OPEN).o.leverage, 10, "S4");
  assert.equal(card("ซื้อ Apple 50 ดอล", 50, 3, OPEN).o.marginUsdc, 20, "S5");
  assert.equal(card("short NFLX 10 3x", 10, 3, OPEN).r.reason, "held", "S6");
  const s7 = S.resolveMarket("long ทองคำ", ALL);
  assert.equal(s7.kind === "unlisted" && !s7.ok, true, "S7: no stock card, and not a crypto either");
  const s8 = S.stockMarketForModel(S.resolveMarket("nasdaq จะขึ้นไหม", ALL).ticker, { markets: ALL, now: OPEN });
  assert.equal(s8.name, "US 100 index", "S8");
  assert.equal(S.scrubVenueWords("ดัชนี Nasdaq-100 ขึ้น"), "ดัชนี US 100 ขึ้น", "S8: never Nasdaq-100");
  assert.match(S.stockFacts("xyz:AAPL", { markets: ALL, now: OPEN }).whatItIs.th, /ไม่มีปันผล/, "S9");
  const s10 = M.moneyMapFor({ backend: backendWith() });
  assert.match(s10.summary, /Main Account/);
  assert.match(s10.summary, /Tesla/);
  assert.deepEqual(clean(s10.summary), [], "S10");
});
