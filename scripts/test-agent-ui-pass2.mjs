/**
 * test-agent-ui-pass2 — the Agent pass-2 cards' pure views (items 7, 12, 17, 18 of AGENT-STOCKS-AND-MAP.md):
 *
 *   pickView.js        the pick-4 card: one group, at most four tiles, no venue words, safe links, the faint chart
 *   finalTradeView.js  the final pre-trade sheet: chart lines, $ at TP / SL, Edit checks, the ONE-SEND latch
 *   closeAllView.js    close all: every position, one by one, only closes, honest partial failures
 *   askAboutView.js    the trade page's Chat tab: three boxes for THIS market (Tokenomist only when on, stocks' hours)
 *   usMarketView.js    the US market's three states, aligned with the 5x guard
 *   viewWords.js       labels ("US 100", never "xyz:…"), signed %, banned words
 *
 * No network, no React: views only. Run: node --test scripts/test-agent-ui-pass2.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickView, sparkPaths, headlineView, ageText, safeHref, pickWords, GROUP_LINE, PICK_TILES } from "../src/agent/cards/pickView.js";
import {
  finalTradeView, pnlAt, rrFromPrices, checkTpSlEdit, parsePriceInput, openOutcome, createOpenLatch, usdSigned, feeRateOf,
} from "../src/agent/cards/finalTradeView.js";
import { closeAllRows, totalPnl, closeOutcome, closeAllSummary, runCloseAll, closeAllLabel } from "../src/agent/cards/closeAllView.js";
import { askAboutView, askAboutChips, ASK_WORDS } from "../src/agent/cards/askAboutView.js";
import { usMarketView, durationText } from "../src/agent/cards/usMarketView.js";
import { coinLabel, pctText, hasBannedWord, isStockCoin, rrText } from "../src/agent/cards/viewWords.js";
import { STOCK_GUARD_TEXT } from "../src/lib/hyperliquid/hip3/guard.js";

/* New York instants (EDT, UTC-4, in October 2026). */
const ny = (date, hh, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`);
const THU_OPEN = ny("2026-10-15", 11, 0);     // Thursday, core session
const THU_PRE = ny("2026-10-15", 7, 30);      // pre-market
const THU_POST = ny("2026-10-15", 17, 0);     // after hours
const THU_NIGHT = ny("2026-10-15", 23, 0);    // overnight (closed for the guard)
const SAT = ny("2026-10-17", 12, 0);          // weekend: model price

const candles = (closes) => closes.map((c, i) => ({ time: 1_760_000_000 + i * 3600, open: i ? closes[i - 1] : c, high: c, low: c, close: c, volume: 1 }));
const pos = (coin, szi, upnl, { lev = 3, side = szi > 0 ? "long" : "short", value = 60 } = {}) => ({
  coin, szi, side, unrealizedPnl: upnl, returnOnEquity: upnl / 20, positionValue: value, entryPx: 100, liquidationPx: 70,
  leverage: { type: "isolated", value: lev }, marginUsed: 20, cumFunding: { sinceOpen: 0 },
});

/* ── viewWords ───────────────────────────────────────────────────────────────────────────────────────────────── */

test("labels: tickers only, the venue never shows, XYZ100 is US 100", () => {
  assert.equal(coinLabel("xyz:TSLA"), "TSLA");
  assert.equal(coinLabel("BTC"), "BTC");
  assert.equal(coinLabel("xyz:XYZ100"), "US 100");
  assert.equal(isStockCoin("xyz:TSLA"), true);
  assert.equal(isStockCoin("xyz:GOLD"), false, "an unlisted venue market is not a stock card");
  assert.equal(isStockCoin("BTC"), false);
});

test("banned words: venue, dex, pot, กอง, HIP-3, Nasdaq-100 — and ordinary words pass", () => {
  for (const t of ["HIP-3 stock", "trade on xyz", "the xyz dex", "money in the pot", "ย้ายเงินไปกองหุ้น", "Nasdaq-100 is up", "trade[XYZ] TSLA", "the venue"]) {
    assert.equal(hasBannedWord(t), true, t);
  }
  for (const t of ["Tesla stock is up", "potential upside", "US 100 index", "AI stocks moving most today. Pick one.", "หุ้น AI วิ่งแรงสุดวันนี้ เลือกมา 1 ตัว"]) {
    assert.equal(hasBannedWord(t), false, t);
  }
});

test("signed percent and RR spellings", () => {
  assert.equal(pctText(3.214), "+3.21%");
  assert.equal(pctText(-1.4), "−1.40%");
  assert.equal(pctText(0.001), "0.00%");
  assert.equal(pctText(null), "—");
  assert.equal(rrText(2), "1 : 2.0");
  assert.equal(rrText(null), "—");
});

/* ── PickCard ────────────────────────────────────────────────────────────────────────────────────────────────── */

test("pick: one group only — the first tile decides, the other kind is dropped", () => {
  const v = pickView({ kind: "pick", group: "stocks", line: "AI stocks today. Pick one.", tiles: [
    { coin: "xyz:NVDA", changePct: 3.1 }, { coin: "BTC", changePct: 1 }, { coin: "xyz:TSLA", changePct: -2 },
    { coin: "xyz:AMD", changePct: 0.5 }, { coin: "xyz:MSFT", changePct: 1.2 },
  ] });
  assert.deepEqual(v.tiles.map((t) => t.coin), ["xyz:NVDA", "xyz:TSLA", "xyz:AMD", "xyz:MSFT"]);
  assert.equal(v.stocks, true);
  assert.equal(v.complete, true);
  assert.ok(v.tiles.every((t) => !/xyz/i.test(t.label)), "no tile shows the venue");
  const c = pickView({ kind: "pick", tiles: [{ coin: "HYPE" }, { coin: "xyz:TSLA" }, { coin: "SOL" }] });
  assert.deepEqual(c.tiles.map((t) => t.coin), ["HYPE", "SOL"]);
  assert.equal(c.complete, false, "fewer than four still draw, and say so");
});

test("pick: at most four tiles, each market once; an unlisted venue market is no tile", () => {
  const v = pickView({ tiles: ["BTC", "ETH", "ETH", "flx:FOO", "SOL", "HYPE", "DOGE"].map((coin) => ({ coin })) });
  assert.equal(v.tiles.length, PICK_TILES);
  assert.deepEqual(v.tiles.map((t) => t.coin), ["BTC", "ETH", "SOL", "HYPE"]);
});

test("pick: the line is the app's voice — a banned word swaps it for the group's plain line", () => {
  const bad = pickView({ group: "stocks", line: "Top HIP-3 stocks on the xyz dex", tiles: [{ coin: "xyz:TSLA" }] });
  assert.equal(bad.line, GROUP_LINE.stocks);
  const th = pickView({ group: "ai", line: "หุ้น AI วิ่งแรงสุดวันนี้ เลือกมา 1 ตัว", tiles: [{ coin: "xyz:NVDA" }] });
  assert.equal(th.line, "หุ้น AI วิ่งแรงสุดวันนี้ เลือกมา 1 ตัว");
  assert.equal(pickView({ tiles: [{ coin: "BTC" }] }).line, GROUP_LINE.movers, "no line: the group's own");
});

test("pick: headlines — at most two, http(s) links only, title + source + age, no article text", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const v = pickView({ tiles: [{ coin: "BTC" }], headlines: [
    { title: "  Bitcoin   holds above   $100K  ", source: "CoinDesk", url: "https://www.coindesk.com/a", at: now - 25 * 60_000 },
    { title: "Evil", source: "x", url: "javascript:alert(1)", at: now },
    { title: "No link", source: "x", url: "", at: now },
    { title: "ETH ETF flows", url: "https://www.theblock.co/b", at: now - 3 * 3_600_000 },
    { title: "Third", source: "x", url: "https://example.com/c", at: now },
  ] }, { now });
  assert.equal(v.headlines.length, 2);
  assert.deepEqual(v.headlines.map((h) => [h.title, h.source, h.age]), [["Bitcoin holds above $100K", "CoinDesk", "25m"], ["ETH ETF flows", "theblock.co", "3h"]]);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  /* A headline is shown as published (news lane: Yahoo's terms): too long to show is left out, never cut. */
  assert.equal(headlineView({ title: "x".repeat(400), url: "https://a.b/c" }, now), null);
  assert.equal(headlineView({ title: "y".repeat(200), url: "https://a.b/c" }, now).title.length, 200);
  assert.equal(ageText(now - 2 * 86_400_000, now), "2d");
  assert.equal(ageText(now + 3_600_000, now), null, "a future time is no age");
});

test("pick: the 24h % prefers the live market row; the tile colour follows the printed %", () => {
  const v = pickView({ tiles: [{ coin: "BTC", changePct: 5 }, { coin: "ETH", changePct: null, candles: candles([10, 9, 8]) }] },
    { byCoin: { BTC: { coin: "BTC", label: "BTC", change24hPct: -1.25 } } });
  assert.equal(v.tiles[0].changeText, "−1.25%");
  assert.equal(v.tiles[0].tone, "neg");
  assert.equal(v.tiles[1].tone, "neg", "unknown %: the chart's own direction");
  assert.equal(v.tiles[1].changeText, "—");
});

test("pick: the faint chart — 24 bars, an open line and a closed area, its direction, nothing from < 2 closes", () => {
  const up = sparkPaths(candles(Array.from({ length: 40 }, (_, i) => 100 + i)), { w: 120, h: 36 });
  assert.ok(up.line.startsWith("M0,"));
  assert.ok(up.area.endsWith("L120,36L0,36Z"));
  assert.equal(up.dir, "up");
  assert.equal(up.line.split("L").length, 24, "the last 24 candles only");
  assert.equal(sparkPaths(candles([5, 4, 3])).dir, "down");
  assert.ok(sparkPaths(candles([7, 7, 7])).line.includes(",18"), "a flat day is a flat mid line");
  assert.equal(sparkPaths(candles([1])), null);
  assert.equal(sparkPaths(null), null);
});

test("pick: the words a pick says name the ticker, never the venue", () => {
  assert.equal(pickWords("xyz:TSLA"), "Setups for TSLA");
  assert.equal(pickWords("HYPE"), "Setups for HYPE");
  assert.equal(pickView({ tiles: [{ coin: "xyz:TSLA" }], chosen: "xyz:TSLA" }).chosen, "xyz:TSLA");
  assert.equal(pickView({ tiles: [{ coin: "xyz:TSLA" }], chosen: "BTC" }).chosen, null, "a chosen coin not on the card is no choice");
});

/* ── FinalTradeSheet ─────────────────────────────────────────────────────────────────────────────────────────── */

const LONG = { coin: "ETH", side: "buy", leverage: 3, marginUsdc: 20, entryPx: 2000, tpPx: 2070, slPx: 1960, liqPx: 1380, notionalUsd: 60, feeUsdc: 0.027, szDecimals: 4 };

test("sheet: four lines on the chart (entry, TP, SL, liq) with %, $ and the plan's own colours by id", () => {
  const v = finalTradeView(LONG, { now: THU_OPEN });
  assert.equal(v.ok, true);
  assert.deepEqual(v.lines.map((l) => l.id), ["entry", "tp", "sl", "liq"]);
  assert.equal(v.lines[1].title, "TP +3.5% +$2.05");
  assert.equal(v.lines[2].title, "SL −2.0% −$1.25");
  assert.equal(v.pair, "ETH-USD");
  assert.equal(v.pill, "3x Long");
  assert.equal(v.openLabel, "Open Long");
  assert.equal(v.marginText, "20.00 USDC");
  assert.equal(v.rrText, "1 : 1.8");
  assert.equal(v.feeText, "≈ 0.03 USDC");
  assert.deepEqual(v.legend.map((r) => [r.id, r.tone]), [["tp", "pos"], ["entry", "ink"], ["sl", "neg"], ["liq", "warn"]]);
  assert.equal(v.legend[0].usdText, "+$2.05");
  assert.equal(v.legend[3].pctText, "−31.00%");
  assert.equal(v.market, null, "crypto: no US market row");
  assert.equal(v.feesIn, true);
});

test("sheet: $ at a level is the notional's move less the fee in and the fee out", () => {
  const r = pnlAt(LONG, 2070);
  /* qty 0.03 · +70 = 2.10; fees 60 × 0.00045 + 0.03 × 2070 × 0.00045 = 0.054945 */
  assert.ok(Math.abs(r.usd - (2.1 - 0.054945)) < 1e-9);
  assert.equal(r.feesIn, true);
  assert.equal(feeRateOf(LONG), 0.00045);
  const noFee = pnlAt({ ...LONG, feeUsdc: null }, 1960);
  assert.equal(noFee.feesIn, false);
  assert.ok(Math.abs(noFee.usd + 1.2) < 1e-9);
  assert.equal(pnlAt({ ...LONG, notionalUsd: null }, 2070), null, "no size: no made-up dollars");
  assert.equal(usdSigned(-1.2), "−$1.20");
  assert.equal(usdSigned(0.001), "$0.00");
});

test("sheet: a short mirrors — TP below, SL above, Open Short", () => {
  const v = finalTradeView({ ...LONG, side: "sell", tpPx: 1930, slPx: 2040, liqPx: 2620 });
  assert.equal(v.openLabel, "Open Short");
  assert.equal(v.pill, "3x Short");
  assert.equal(v.lines.find((l) => l.id === "tp").title.startsWith("TP −3.5% +$"), true);
  assert.equal(v.legend.find((r) => r.id === "sl").usdText.startsWith("−$"), true);
  assert.deepEqual(v.legend.map((r) => r.id), ["liq", "sl", "entry", "tp"], "the chart's order: highest price first");
});

test("sheet: an unknown level draws no line; no entry is not a plan to open", () => {
  const v = finalTradeView({ ...LONG, tpPx: null, liqPx: undefined });
  assert.deepEqual(v.lines.map((l) => l.id), ["entry", "sl"]);
  assert.equal(v.rr, null);
  const none = finalTradeView({ ...LONG, entryPx: null });
  assert.equal(none.ok, false);
  assert.equal(finalTradeView({ ...LONG, marginUsdc: 0 }).ok, false);
});

test("sheet: RR from the prices unless the plan carries its own", () => {
  assert.equal(rrFromPrices({ entryPx: 100, tpPx: 104, slPx: 98 }), 2);
  assert.equal(rrFromPrices({ entryPx: 100, tpPx: 104, slPx: 100 }), null);
  assert.equal(finalTradeView({ ...LONG, rr: 2.5 }).rrText, "1 : 2.5");
});

test("sheet Edit: prices on the right side, the stop before liquidation, blanks allowed, junk refused", () => {
  const ok = checkTpSlEdit({ side: "buy", entryPx: 2000, liqPx: 1380, tpStr: "2,100", slStr: "$1,950.5" });
  assert.deepEqual([ok.ok, ok.tpPx, ok.slPx], [true, 2100, 1950.5]);
  assert.equal(checkTpSlEdit({ side: "buy", entryPx: 2000, tpStr: "1990" }).errors.tp, "TP must be above the entry");
  assert.equal(checkTpSlEdit({ side: "buy", entryPx: 2000, slStr: "2010" }).errors.sl, "SL must be below the entry");
  assert.equal(checkTpSlEdit({ side: "buy", entryPx: 2000, liqPx: 1380, slStr: "1300" }).errors.sl, "SL must sit before liquidation");
  assert.equal(checkTpSlEdit({ side: "sell", entryPx: 2000, liqPx: 2620, slStr: "2700" }).errors.sl, "SL must sit before liquidation");
  assert.equal(checkTpSlEdit({ side: "sell", entryPx: 2000, tpStr: "2100" }).errors.tp, "TP must be below the entry");
  const blank = checkTpSlEdit({ side: "buy", entryPx: 2000, tpStr: "", slStr: " " });
  assert.deepEqual([blank.ok, blank.tpPx, blank.slPx], [true, null, null]);
  assert.equal(checkTpSlEdit({ side: "buy", entryPx: 2000, tpStr: "abc" }).errors.tp, "Type a price");
  assert.equal(parsePriceInput("0.0051"), 0.0051);
  assert.equal(parsePriceInput("-5"), null);
  assert.equal(parsePriceInput("1e9"), null);
});

test("sheet: a stock shows its name and the US market — closed hours print the gap warning", () => {
  const plan = { coin: "xyz:TSLA", side: "buy", leverage: 5, marginUsdc: 10, entryPx: 430, tpPx: 450, slPx: 420, liqPx: 350, notionalUsd: 50, szDecimals: 3 };
  const open = finalTradeView(plan, { now: THU_OPEN });
  assert.equal(open.pair, "TSLA");
  assert.equal(open.name, "Tesla");
  assert.equal(open.market.state, "open");
  assert.equal(open.market.label, "US market open");
  assert.equal(open.market.sub, "closes in 5h");
  const sat = finalTradeView(plan, { now: SAT });
  assert.equal(sat.market.state, "closed");
  assert.equal(sat.market.modelPrice, true);
  assert.equal(sat.market.note, STOCK_GUARD_TEXT.us_market_closed);
  /* Nothing the customer reads names the venue. */
  const words = JSON.stringify({ ...sat, coin: null, lines: sat.lines.map((l) => l.title) });
  assert.equal(hasBannedWord(words), false);
});

test("sheet: the caller's notes and the risk maths print as given, three at most", () => {
  const v = finalTradeView({ ...LONG, notes: ["Leverage 5x while the US market is closed", "", 7], mathLines: ["Risk $15 · stop 2.1% away", "size $714 · 3x · margin $238", "a", "b"] });
  assert.deepEqual(v.notes, ["Leverage 5x while the US market is closed"]);
  assert.equal(v.mathLines.length, 3);
});

test("open outcome: filled, a clean refusal (tap again), or LOCKED when the outcome is unknown", () => {
  assert.equal(openOutcome({ ok: true }).state, "ok");
  assert.deepEqual(openOutcome({ ok: false, code: "rate_limited", message: "Too many requests." }), { state: "retry", text: "Too many requests." });
  assert.equal(openOutcome({ ok: false, next: "positions" }).state, "locked");
  assert.equal(openOutcome({ ok: false, code: "unknown_outcome" }).state, "locked");
  assert.equal(openOutcome(undefined).state, "locked");
  assert.equal(openOutcome(null).state, "locked");
});

test("🔴 the send latch: a burst of taps sends ONCE; a fill or an unknown stays latched; a refusal reopens", async () => {
  let calls = 0;
  let release;
  const latch = createOpenLatch(() => { calls++; return new Promise((r) => { release = r; }); });
  const a = latch.fire();
  const b = latch.fire();
  const c = latch.fire();
  assert.equal(latch.state, "sending");
  release({ ok: true });
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(calls, 1);
  assert.deepEqual([ra.state, rb.state, rc.state], ["ok", "ignored", "ignored"]);
  assert.equal(latch.state, "done");
  await latch.fire();
  assert.equal(calls, 1, "a filled review never sends again");

  let n2 = 0;
  const lost = createOpenLatch(async () => { n2++; throw new Error("socket closed"); });
  const lostAnswer = await lost.fire();
  assert.deepEqual(lostAnswer, { state: "locked", text: "Not confirmed. Check your positions before trying again." }, "a throw is said in plain words");
  lost.reset();
  await lost.fire();
  assert.equal(n2, 1, "an unknown outcome is never re-sent, not even after a re-open");

  let n3 = 0;
  const refused = createOpenLatch(async () => { n3++; return { ok: false, code: "price_stale", message: "Wait for a fresh price." }; });
  assert.equal((await refused.fire()).state, "retry");
  assert.equal(refused.state, "idle");
  await refused.fire();
  assert.equal(n3, 2, "a clean refusal lets a NEW tap try again");
  assert.equal((await createOpenLatch(null).fire()).state, "ignored");
});

/* ── CloseAllCard ────────────────────────────────────────────────────────────────────────────────────────────── */

const POSITIONS = [pos("BTC", 0.001, 0.4), pos("CHIP", 100, -2.5), pos("xyz:TSLA", 0.1, 1.1, { lev: 5 }), pos("ETH", 0, 0), pos("BTC", 0.001, 0.4)];

test("close all: every open position once (crypto and stocks), biggest P&L first", () => {
  const rows = closeAllRows(POSITIONS);
  assert.deepEqual(rows.map((r) => r.coin), ["CHIP", "xyz:TSLA", "BTC"]);
  const tsla = rows.find((r) => r.coin === "xyz:TSLA");
  assert.deepEqual([tsla.label, tsla.name, tsla.isStock, tsla.pill], ["TSLA", "Tesla", true, "5x Long"]);
  assert.ok(Math.abs(totalPnl(rows) - (-1)) < 1e-9);
  assert.equal(totalPnl([{ pnlUsd: 1 }, { pnlUsd: null }]), null, "an unknown row: no partial sum");
  assert.equal(closeAllLabel(3), "Close all · 3");
  assert.equal(closeAllLabel(1), "Close 1 position");
});

test("close all: each answer read honestly", () => {
  assert.equal(closeOutcome({ ok: true }).state, "done");
  assert.deepEqual(closeOutcome({ ok: false, code: "no_position", message: "x" }), { state: "gone", text: "Already closed" });
  const f = closeOutcome({ ok: false, code: "rate_limited", message: "Too many requests. Try again in a moment." });
  assert.deepEqual(f, { state: "failed", text: "Too many requests. Try again in a moment." });
  assert.equal(closeOutcome({ ok: false, code: "unknown_outcome", message: "Lost." }).state, "unknown");
  assert.equal(closeOutcome(undefined).state, "unknown");
});

test("🔴 close all runs one by one, only closeOne, only the listed coins, each once, and never stops early", async () => {
  const seen = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const closeOne = async (coin) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    seen.push(coin);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (coin === "CHIP") return { ok: false, code: "rate_limited", message: "Too many requests." };
    if (coin === "SOL") throw new Error("boom");
    return { ok: true };
  };
  const states = [];
  const out = await runCloseAll({ coins: ["CHIP", "xyz:TSLA", "CHIP", "SOL", "BTC", "", null], closeOne, onState: (c, o) => states.push([c, o.state]) });
  assert.deepEqual(seen, ["CHIP", "xyz:TSLA", "SOL", "BTC"], "in order, each once, nothing else");
  assert.equal(maxInFlight, 1, "sequential: never two closes at once");
  assert.deepEqual(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.state])), { CHIP: "failed", "xyz:TSLA": "done", SOL: "unknown", BTC: "done" });
  assert.deepEqual(states.slice(0, 2), [["CHIP", "closing"], ["CHIP", "failed"]]);
  assert.deepEqual(await runCloseAll({ coins: ["BTC"], closeOne: null }), {}, "no closeOne: nothing runs");
});

test("close all: the summary says what happened — all, partial, not confirmed — and only refusals are retried", () => {
  const rows = closeAllRows(POSITIONS);
  assert.equal(closeAllSummary(rows, {}).settled, false);
  assert.equal(closeAllSummary(rows, { CHIP: { state: "closing" } }).settled, false);
  const all = closeAllSummary(rows, { CHIP: { state: "done" }, "xyz:TSLA": { state: "gone" }, BTC: { state: "done" } });
  assert.deepEqual([all.settled, all.text, all.retry], [true, "Closed all 3 positions.", []]);
  const part = closeAllSummary(rows, { CHIP: { state: "failed" }, "xyz:TSLA": { state: "done" }, BTC: { state: "unknown" } });
  assert.equal(part.text, "Closed 1 of 3. CHIP didn't close. BTC not confirmed: check it before trying again.");
  assert.deepEqual(part.retry, ["CHIP"], "a not-confirmed close is never retried from the card");
  assert.equal(hasBannedWord(part.text), false);
});

/* ── AskAboutCoin ────────────────────────────────────────────────────────────────────────────────────────────── */

test("ask about: crypto with Tokenomist on — emission, news, plan; the words run the real things", () => {
  const v = askAboutView({ coin: "HYPE", tokenomist: true });
  assert.deepEqual(v.boxes.map((b) => b.id), ["emission", "news", "plan"]);
  assert.deepEqual(v.boxes.map((b) => b.words), ["Analyze HYPE with Tokenomist", "News and trend for HYPE", "Setups for HYPE"]);
  assert.equal(v.boxes[0].mark, "tokenomist");
  assert.equal(v.boxes[0].title, "Emission & unlocks");
});

test("ask about: Tokenomist off — plain Unlocks, muted, never a claim of Tokenomist data", () => {
  const v = askAboutView({ coin: "HYPE", tokenomist: false });
  assert.deepEqual([v.boxes[0].title, v.boxes[0].sub, v.boxes[0].muted, v.boxes[0].mark, v.boxes[0].words], ["Unlocks", "Tokenomist not connected", true, null, "HYPE unlocks"]);
});

test("ask about: held — Your position (with its pill and P&L) replaces Plan a position", () => {
  const v = askAboutView({ coin: "BTC", tokenomist: true, held: { pill: "3x Long", pnlText: "+$1.20", pnlTone: "pos" } });
  const last = v.boxes[v.boxes.length - 1];
  assert.deepEqual([last.id, last.title, last.sub, last.words, last.tone], ["position", "Your position", "3x Long · +$1.20", "Set TP SL for BTC", "pos"]);
  assert.equal(v.boxes.some((b) => b.id === "plan"), false);
});

test("ask about: a stock — US market box, earnings & news, no Tokenomist, no venue in any word", () => {
  const us = usMarketView(SAT);
  const v = askAboutView({ coin: "xyz:TSLA", tokenomist: true, us });
  assert.deepEqual(v.boxes.map((b) => b.id), ["market", "news", "plan"]);
  assert.equal(v.boxes[0].title, "US market closed");
  assert.match(v.boxes[0].sub, /^opens in 1d/);
  assert.equal(v.boxes[1].title, "Earnings & news");
  assert.equal(v.name, "Tesla");
  const all = JSON.stringify(v);
  assert.equal(/tokenomist/i.test(all), false, "never Tokenomist on a stock");
  assert.equal(hasBannedWord(all), false);
  assert.deepEqual(v.boxes.map((b) => b.words), [ASK_WORDS.market("TSLA"), ASK_WORDS.news("TSLA"), ASK_WORDS.plan("TSLA")]);
  assert.equal(askAboutView({ coin: "xyz:XYZ100" }).label, "US 100");
});

test("ask about: the composer chips are this market's — no Top movers", () => {
  const c = askAboutChips({ coin: "HYPE" });
  assert.deepEqual(c.map((x) => x.text), ["Setups for HYPE", "Analyze HYPE", "News and trend for HYPE"]);
  assert.equal(askAboutChips({ coin: "HYPE", held: true })[0].text, "Set TP SL for HYPE");
  assert.equal(c.some((x) => /movers/i.test(x.text)), false);
});

/* ── US market ───────────────────────────────────────────────────────────────────────────────────────────────── */

test("US market: open / extended / closed — closed exactly when the guard caps at 5x", () => {
  assert.equal(usMarketView(THU_OPEN).state, "open");
  const pre = usMarketView(THU_PRE);
  assert.deepEqual([pre.state, pre.label, pre.sub], ["extended", "US pre-market", "opens in 2h"]);
  const post = usMarketView(THU_POST);
  assert.deepEqual([post.state, post.label], ["extended", "US after hours"]);
  const night = usMarketView(THU_NIGHT);
  assert.deepEqual([night.state, night.modelPrice, night.sub], ["closed", false, "opens in 10h 30m"]);
  const sat = usMarketView(SAT);
  assert.deepEqual([sat.state, sat.modelPrice, sat.tone], ["closed", true, "warn"]);
  assert.equal(usMarketView(NaN), null);
});

test("durations read short", () => {
  assert.equal(durationText(20_000), "1m");
  assert.equal(durationText(35 * 60_000), "35m");
  assert.equal(durationText(5 * 3_600_000 + 20 * 60_000), "5h 20m");
  assert.equal(durationText(30 * 3_600_000), "1d 6h");
  assert.equal(durationText(48 * 3_600_000), "2d");
  assert.equal(durationText(-1), null);
});
