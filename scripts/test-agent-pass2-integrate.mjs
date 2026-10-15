/**
 * test-agent-pass2-integrate — FlowFlow pass 2 wired into the live chat (AGENT-STOCKS-AND-MAP items 1–21).
 *
 * The lanes' modules (stocks, picks, plan, close-all, news, final sheet) are tested on their own elsewhere; this suite
 * pins how the CHAT reaches them: which sentence goes where (a risk before a trade shortcut, a close-all before a
 * single close, a stock trade after the crypto shortcuts), what the model's tools return for stocks (tickers, never the
 * venue), the caps the cards carry, and the words FlowFlow shows. Rows are the store's own parse of the 2026-10-15
 * captures (main dex + xyz). No network: fetch throws; news is an injected reader.
 *
 * Run: node --test scripts/test-agent-pass2-integrate.mjs
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
const P = await import("../src/agent/picks.js");
const C = await import("../src/agent/closeAll.js");
const A = await import("../src/agent/agent.js");
const R = await import("../src/agent/runTool.js");
const I = await import("../src/agent/intents.js");
const T = await import("../src/agent/tools.js");
const { systemPrompt } = await import("../src/agent/prompt.js");
const { chipsFor } = await import("../src/agent/chips.js");
const { parseShortcut } = await import("../src/agent/shortcuts.js");
const { venueWordHits, scrubVenueWords } = await import("../src/agent/stockWords.js");
const { chat } = await import("../src/agent/store.js");
const { MAX_MARGIN_USDC } = await import("../src/perp/guardrails.js");

const main = parsePerpMarkets(fx("hl-meta-and-asset-ctxs.json"), { now: 1 }).markets;
const xyz = parsePerpMarkets(fx("hip3/xyz-meta-and-asset-ctxs.json"), { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" }).markets;
const ALL = [...main, ...xyz];
const byCoin = Object.fromEntries(ALL.map((m) => [m.coin, m]));
const SNAP = { markets: ALL, byCoin, ready: true };
const COINS = main.map((m) => m.coin);

const OPEN = Date.UTC(2026, 9, 15, 15, 0);   // Thu 11:00 ET: US core session
const SAT = Date.UTC(2026, 9, 17, 15, 0);    // Sat: US market closed

const pos = (coin, szi, extra = {}) => ({ coin, szi, side: szi > 0 ? "long" : "short", entryPx: byCoin[coin] ? byCoin[coin].px : 1, marginUsed: 5, leverage: { type: "isolated", value: 3 }, ...extra });
function backend({ positions = [], equity = 100 } = {}) {
  const list = positions;
  return {
    connected: true, mock: false, address: "0x1111111111111111111111111111111111111111", feeRate: 0.00045,
    account: {
      /* complete: the stock positions are in the list too (account store); pass-2 fix suite tests the loading case. */
      positions: { answered: true, list, byCoin: Object.fromEntries(list.map((p) => [p.coin, p])), complete: true },
      perpBalanceUsdc: { answered: true, equityUsdc: equity, availableUsdc: equity, source: "perp" },
      orders: { answered: true, list: [] },
    },
  };
}
const ctxOf = (b, o = {}) => ({ snapshot: SNAP, backend: b, fetchCandles: async () => [], readTimeoutMs: 50, now: () => OPEN, ...o });
const hasVenue = (x) => venueWordHits(JSON.stringify(x)).length > 0;

/* ── which sentence goes where ─────────────────────────────────────────────────────────────────────────────── */

test("picks: the owner's sentences ask for ONE pick card; a sentence naming a market is that market's", () => {
  const d = (t) => P.detectPick(t, { coins: COINS });
  assert.deepEqual([d("วันนี้เทรดอะไรดี").group, d("What should I trade today?").group], ["today", "today"]);
  assert.deepEqual([d("เลือกหุ้นให้หน่อย").group, d("หุ้นตัวไหนดี").group], ["stocks", "stocks"]);
  assert.deepEqual([d("Short a stock").group, d("Short a stock").side], ["stocks", "sell"]);
  assert.deepEqual([d("meme ตัวไหนดี").group, d("Long a meme").side], ["meme", "buy"]);
  assert.equal(d("long MEME 10 3x"), null, "MEME in capitals is the market");
  assert.equal(d("มีข่าวอะไรบ้าง").group, "news");
  for (const t of ["hey any plan", "long ETH 20 5x", "Analyze HYPE", "Tesla", "Top movers", "stake 20 USDC"]) assert.equal(d(t), null, t);
  /* Through detectIntent: the pick wins over the old "plan" for "what to trade today"; "any plan" stays the plan. */
  assert.equal(I.detectIntent("วันนี้เทรดอะไรดี", { coins: COINS }).kind, "picks");
  assert.equal(I.detectIntent("hey any plan", { coins: COINS }).kind, "plan");
});

test("picks: four tiles of one group, by the side asked; stocks only for a stock ask (or the stronger group today)", () => {
  const s = P.buildPickCard({ group: "stocks", side: "sell", lang: "en" }, { markets: ALL });
  assert.equal(s.ok, true);
  assert.equal(s.card.tiles.length, 4);
  assert.ok(s.card.tiles.every((t) => t.coin.startsWith("xyz:")), "stocks only");
  const ch = s.card.tiles.map((t) => t.changePct);
  assert.deepEqual(ch, [...ch].sort((a, b) => a - b), "falling most first for a short");
  const m = P.buildPickCard({ group: "movers", lang: "th" }, { markets: ALL });
  assert.ok(m.card.tiles.every((t) => !t.coin.includes(":")), "movers stay crypto");
  assert.match(m.card.line, /เลือกมา 1 ตัว/);
  const meme = P.buildPickCard({ group: "meme", side: "buy" }, { markets: ALL });
  assert.ok(meme.ok && meme.card.tiles.length >= 1);
  const held = P.buildPickCard({ group: "movers" }, { markets: ALL, held: new Set([m.card.tiles[0].coin]) });
  assert.ok(!held.card.tiles.some((t) => t.coin === m.card.tiles[0].coin), "a held market is never a pick (one position per market)");
  for (const c of [s.card, m.card, meme.card]) assert.equal(venueWordHits(c.line).length, 0, c.line);
  assert.equal(P.pickTapWords("xyz:XYZ100", "sell"), "Short setups for US100", "a tap says the ticker, never the venue's id");
  /* Headlines ride on the card as published (title, source, link, time), at most two. */
  const news = [
    { title: "Tesla shares slide as deliveries miss", source: "Yahoo Finance", url: "https://finance.yahoo.com/a", publishedAt: "2026-10-15T10:00:00Z" },
    { title: "Stocks drift ahead of CPI", source: "CNBC", url: "https://www.cnbc.com/b", publishedAt: "2026-10-15T11:00:00Z" },
    { title: "Third", source: "CNBC", url: "https://www.cnbc.com/c", publishedAt: "2026-10-15T09:00:00Z" },
  ];
  const withNews = P.buildPickCard({ group: "stocks" }, { markets: ALL, news });
  assert.equal(withNews.card.headlines.length, 2);
  assert.ok(withNews.card.headlines.every((h) => /^https:/.test(h.url) && typeof h.at === "number"));
});

test("close all: the phrases, the answer to 'which market?', and several named markets", () => {
  const d = (t, o = {}) => C.detectCloseAll(t, { coins: COINS, ...o });
  for (const t of ["close all", "close all positions", "close everything", "ปิดทุก position", "ปิดทุก Position ของกู", "ปิดหมด", "ปิดทั้งหมด"]) {
    assert.deepEqual(d(t), { kind: "closeAll", coins: null, lang: /[฀-๿]/.test(t) ? "th" : "en" }, t);
  }
  assert.equal(d("เอาหมดเลยไอสัส"), null, "alone it is not a close");
  assert.equal(d("เอาหมดเลยไอสัส", { askedWhich: true }).kind, "closeAll", "as the answer to FlowFlow's own question");
  assert.equal(d("all", { askedWhich: true }).kind, "closeAll");
  assert.deepEqual(d("close BTC and CHIP").coins, ["BTC", "CHIP"]);
  assert.equal(d("close BTC"), null, "one market: the single close card");
  assert.equal(d("เปิดหมด"), null, "เปิด is OPEN");
});

test("before the shortcuts: a risk is a plan (never a $1-margin card), close-all wins, the plan's one question is answered", () => {
  const b = backend({ positions: [pos("BTC", 0.001), pos("CHIP", 100)] });
  const pre = (t, o = {}) => A.preIntent(t, { coins: COINS, snapshot: SNAP, owner: "test#c", backend: b, ...o });
  const r = pre("risk $1 long ETH");
  assert.equal(r.kind, "riskPlan");
  assert.deepEqual([r.parse.riskUsd, r.parse.coin, r.parse.side], [1, "ETH", "buy"]);
  assert.equal(pre("มี 300 ยอมเสียได้ 15 ดอล short SOL RR 2").parse.riskUsd, 15);
  assert.equal(pre("ปิดทุก position").kind, "closeAll");
  assert.equal(pre("long ETH 20 5x"), null, "a plain trade stays a shortcut");
  assert.equal(pre("long ETH 20 5x sl 10%"), null);
  assert.deepEqual([pre("Long a meme").kind, pre("Long a meme").group], ["picks", "meme"], "never a MEME card with no margin");
  assert.equal(pre("Short S&P 500 with max loss 5 USD").parse.coin, "xyz:SP500", "the index, never the S coin");
  assert.equal(pre("Long Tesla stock, risk 3 USD").parse.coin, "xyz:TSLA");
  /* A side and a market with no number: its setups on that side, never a card with a guessed margin. */
  assert.deepEqual([I.detectIntent("Long HYPE for me", { coins: COINS }).kind, I.detectIntent("Long HYPE for me", { coins: COINS }).side], ["setups", "buy"]);
});

test("a stock in a trade sentence: the stock's card intent, the index's own 500 never read as margin, a paused one refused", () => {
  const t = A.stockTradeIntent("long TSLA 10 3x", SNAP);
  assert.deepEqual([t.kind, t.coin, t.side, t.marginUsdc, t.leverage], ["trade", "xyz:TSLA", "buy", 10, 3]);
  const sp = A.stockTradeIntent("short S&P 500 10 2x", SNAP);
  assert.deepEqual([sp.coin, sp.marginUsdc, sp.leverage], ["xyz:SP500", 10, 2]);
  const th = A.stockTradeIntent("ซื้อ Tesla 10 ดอล", SNAP);
  assert.deepEqual([th.coin, th.side, th.marginUsdc, th.leverage], ["xyz:TSLA", "buy", 10, null], "S2: no leverage, none guessed");
  assert.equal(A.stockTradeIntent("short NFLX 10 3x", SNAP).kind, "stockRefused", "S6: paused, no card");
  assert.equal(A.stockTradeIntent("long ETH 20 5x", SNAP), null, "crypto is the shortcuts'");
  assert.equal(A.stockTradeIntent("Tesla", SNAP), null, "no trade words: the intents' (its setups)");
});

/* ── the model's tools on stocks ───────────────────────────────────────────────────────────────────────────── */

test("tools: a stock resolves by ticker or name; results name the ticker, never the venue; refusals say why", async () => {
  assert.equal(R.resolveCoin("TSLA", SNAP).coin, "xyz:TSLA");
  assert.equal(R.resolveCoin("Tesla", SNAP).coin, "xyz:TSLA");
  assert.equal(R.resolveCoin("US100", SNAP).coin, "xyz:XYZ100");
  assert.equal(R.resolveCoin("ETH", SNAP).coin, "ETH");
  assert.match(R.marketFor("NFLX", SNAP).error, /paused/);
  assert.match(R.marketFor("GOLD", SNAP).error, /isn't listed/);
  const b = backend();
  const gm = (await R.runToolCall("get_market", { coin: "US100" }, ctxOf(b))).result;
  assert.equal(gm.coin, "US100");
  assert.equal(gm.margin, "isolated");
  assert.ok(!hasVenue(gm), JSON.stringify(gm));
  const list = (await R.runToolCall("get_markets", { kind: "stock" }, ctxOf(b))).result;
  assert.ok(Array.isArray(list.stocks) && list.stocks.length > 0);
  assert.ok(!hasVenue(list));
  const crypto = (await R.runToolCall("get_markets", {}, ctxOf(b))).result;
  assert.ok(crypto.markets.every((m) => !String(m.coin).includes(":")), "crypto by default");
});

test("propose_open on a stock: the stock limits in code (5x while the US market is closed), isolated, notes on the card", async () => {
  const b = backend();
  const open = await R.runToolCall("propose_open", { coin: "TSLA", side: "long", margin_usdc: 50, leverage: 10, reason: "x" }, ctxOf(b, { now: () => OPEN, noTpSl: true }));
  assert.deepEqual([open.card.coin, open.card.marginUsdc, open.card.leverage, open.card.marginMode], ["xyz:TSLA", MAX_MARGIN_USDC, 10, "isolated"]);
  const closed = await R.runToolCall("propose_open", { coin: "TSLA", side: "long", margin_usdc: 10, leverage: 10, reason: "x" }, ctxOf(b, { now: () => SAT, noTpSl: true }));
  assert.equal(closed.card.leverage, 5, "S3: at most 5x while the US market is closed");
  assert.ok(closed.card.notes.some((n) => /5x/.test(n)));
  const amd = await R.runToolCall("propose_open", { coin: "AMD", side: "long", margin_usdc: 15, leverage: 20, reason: "x" }, ctxOf(b, { now: () => OPEN, noTpSl: true }));
  assert.equal(amd.card.leverage, 10, "S4: AMD's own max");
  const ask = await R.runToolCall("propose_open", { coin: "TSLA", side: "long", margin_usdc: 10, reason: "x" }, ctxOf(b, { now: () => OPEN }));
  assert.match(ask.result.error, /leverage/i, "no leverage: ask (with the cap now), never guess");
  const nflx = await R.runToolCall("propose_open", { coin: "NFLX", side: "short", margin_usdc: 10, leverage: 3, reason: "x" }, ctxOf(b));
  assert.equal(nflx.card, undefined);
  assert.match(nflx.result.error, /paused/);
  for (const r of [open, closed, amd]) assert.ok(!hasVenue(r.result), JSON.stringify(r.result));
});

test("propose_close rounds an in-between share DOWN (0.3 is a 25% card, never All); close_all makes one card", async () => {
  const b = backend({ positions: [pos("ETH", 0.01), pos("BTC", 0.001)] });
  const c = await R.runToolCall("propose_close", { coin: "ETH", fraction: 0.3 }, ctxOf(b));
  assert.equal(c.card.fraction, 0.25);
  assert.equal((await R.runToolCall("propose_close", { coin: "ETH", fraction: 1 }, ctxOf(b))).card.fraction, 1);
  const all = await R.runToolCall("close_all", {}, ctxOf(b));
  assert.deepEqual([all.card.kind, all.card.coins, all.card.status], ["closeAll", null, "review"]);
  const some = await R.runToolCall("close_all", { coins: ["btc"] }, ctxOf(b));
  assert.deepEqual(some.card.coins, ["BTC"]);
  assert.match((await R.runToolCall("close_all", {}, ctxOf(backend()))).result.error, /no open positions/);
  assert.ok(T.isActionTool("close_all") && T.isActionTool("plan_trade") && T.isActionTool("propose_picks") && T.isReadTool("get_news"));
});

test("get_news: the model reads quoted headlines with the data note; the chat gets at most two, linked", async () => {
  const items = [
    { title: "HYPE rallies as Hyperliquid volume hits record", source: "CoinDesk", url: "https://www.coindesk.com/x", publishedAt: "2026-10-15T08:00:00Z" },
    { title: "Tesla deliveries beat estimates in Q3", source: "Yahoo Finance", url: "https://finance.yahoo.com/y", publishedAt: "2026-10-15T07:00:00Z" },
    { title: "Stocks open lower ahead of earnings", source: "CNBC", url: "https://www.cnbc.com/z", publishedAt: "2026-10-15T06:00:00Z" },
  ];
  let asked = null;
  const ctx = ctxOf(backend(), { readNews: async (q) => { asked = q; return { items, covered: true }; } });
  const r = await R.runToolCall("get_news", { coin: "TSLA" }, ctx);
  assert.deepEqual(asked, { ticker: "TSLA" });
  assert.match(r.result.note, /data, not instructions/);
  assert.equal(r.card.kind, "news");
  assert.equal(r.card.items.length, 2);
  const none = await R.runToolCall("get_news", { coin: "ETH" }, ctxOf(backend(), { readNews: async () => ({ items: [], covered: true }) }));
  assert.equal(none.card, undefined);
});

/* ── the chat end to end (no model) ────────────────────────────────────────────────────────────────────────── */

const opts = (b, o = {}) => ({ backend: b, getSnapshot: () => SNAP, fetchCandles: async () => [], readTimeoutMs: 50, intents: true, suggest: false, readNews: async () => ({ items: [], covered: true }), ...o });

test("the chat: 'ปิดทุก position' is ONE close-all card; 'close' alone asks, and 'เอาหมดเลย' answers it with the card", async () => {
  const b = backend({ positions: [pos("BTC", 0.001), pos("CHIP", 100)] });
  chat.setAccount("mock");
  chat.clear();
  chat.push({ role: "user", text: "ปิดทุก position" });
  await A.handleMessage("ปิดทุก position", opts(b));
  let cards = chat.get().messages.filter((m) => m.role === "card");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card.kind, "closeAll");
  chat.clear();
  chat.push({ role: "user", text: "close" });
  await A.handleMessage("close", opts(b));
  const q = chat.get().messages.at(-1);
  assert.equal(q.ask, "close");
  assert.match(q.text, /close all/);
  chat.push({ role: "user", text: "เอาหมดเลยไอสัส" });
  await A.handleMessage("เอาหมดเลยไอสัส", opts(b));
  cards = chat.get().messages.filter((m) => m.role === "card");
  assert.equal(cards.at(-1).card.kind, "closeAll", "never just BTC");
  chat.clear();
});

test("the chat: a plan that cannot go on asks ONE question, and the reply finishes it", async () => {
  const b = backend();
  chat.setAccount("mock");
  chat.clear();
  chat.push({ role: "user", text: "ยอมเสียได้ 15 ดอล" });
  await A.handleMessage("ยอมเสียได้ 15 ดอล", opts(b));
  assert.equal(chat.get().messages.at(-1).text, "เหรียญหรือหุ้นตัวไหน?");
  chat.push({ role: "user", text: "SOL" });
  await A.handleMessage("SOL", opts(b));
  /* No candles in this test: the plan says why (no stop is guessed), it never falls back to a 15 USDC margin card. */
  const last = chat.get().messages.filter((m) => m.role !== "status").at(-1);
  assert.ok(last.role === "assistant" || (last.card && last.card.planned), JSON.stringify(last));
  assert.ok(!chat.get().messages.some((m) => m.card && m.card.kind === "open" && m.card.marginUsdc === 15 && !m.card.planned));
  chat.clear();
});

test("the chat: picks, a stock's trade card and its refusal, through handleMessage", async () => {
  const b = backend();
  chat.setAccount("mock");
  chat.clear();
  await A.handleMessage("Short a stock", opts(b));
  const pick = chat.get().messages.find((m) => m.card && m.card.kind === "pick");
  assert.ok(pick && pick.card.tiles.length === 4 && pick.card.side === "sell");
  chat.clear();
  await A.handleMessage("short NFLX 10 3x", opts(b));
  const said = chat.get().messages.filter((m) => m.role === "assistant").map((m) => m.text).join(" ");
  assert.match(said, /Netflix is paused/);
  assert.ok(!chat.get().messages.some((m) => m.card && m.card.kind === "open"));
  for (const m of chat.get().messages) assert.equal(venueWordHits(m.text || "").length, 0, m.text);
  chat.clear();
});

/* ── words and prompt ──────────────────────────────────────────────────────────────────────────────────────── */

test("the model's prose beside an action card is not shown; prose is scrubbed of venue words", async () => {
  const b = backend();
  chat.setAccount("mock");
  chat.clear();
  const reply = (content, calls) => ({ ok: true, status: 200, json: async () => ({ message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) } }) });
  const seq = [
    reply("TSLA trades on the xyz dex. Tesla is down 2% today.", null),
  ];
  await A.askAgent("how is tesla", { ...opts(b), intents: false, fetchImpl: async () => seq.shift() });
  const text = chat.get().messages.filter((m) => m.role === "assistant").map((m) => m.text);
  assert.deepEqual(text, ["Tesla is down 2% today."]);
  chat.clear();
  const seq2 = [reply("BTC is still open, liquidation around $80,343.", [{ id: "a1", type: "function", function: { name: "propose_close", arguments: JSON.stringify({ coin: "BTC", fraction: 1 }) } }])];
  await A.askAgent("close btc", { ...opts(backend({ positions: [pos("BTC", 0.001)] })), intents: false, fetchImpl: async () => seq2.shift() });
  assert.ok(!chat.get().messages.some((m) => m.role === "assistant" && /still open/.test(m.text)), "item 8");
  assert.ok(chat.get().messages.some((m) => m.card && m.card.kind === "close"));
  chat.clear();
  assert.equal(scrubVenueWords("XYZ100 is up."), "US 100 index is up.");
});

test("the prompt: FlowFlow by name, one chat with no Pro mode, the maths from plan_trade, the money map and stock rules", () => {
  const p = systemPrompt({ unlocks: true, now: new Date(OPEN) });
  assert.match(p, /^You are FlowFlow/);
  assert.doesNotMatch(p, /FlowFlow's Agent/);
  assert.match(p, /no "Pro mode"/);
  assert.match(p, /never do arithmetic/i);
  assert.match(p, /plan_trade/);
  assert.match(p, /close_all/);
  assert.match(p, /propose_picks/);
  assert.match(p, /third-party data/);
  assert.match(p, /US 100 index/);
  assert.match(p, /5x while the US market is closed/);
});

test("chips: a market's Chat tab gets only that market's next steps (no Top movers), by ticker", () => {
  const c = chipsFor({ coin: "xyz:TSLA", compact: true });
  assert.deepEqual(c.map((x) => x.text), ["Setups for TSLA", "Analyze TSLA", "News and trend for TSLA"]);
  const h = chipsFor({ coin: "HYPE", compact: true, held: ["HYPE"] });
  assert.equal(h[0].text, "Set TP SL for HYPE");
  assert.ok(!h.some((x) => x.text === "Top movers"));
});

test("shortcuts read a price TP / SL, a size in the coin and a $ position without turning them into margin (K5)", () => {
  const px = parseShortcut("long BTC 20 5x tp 90000 sl 80000", COINS);
  assert.deepEqual([px.tpPct, px.slPct, px.tpPx, px.slPx], [null, null, 90000, 80000]);
  const sz = parseShortcut("long 0.5 ETH 5x", COINS);
  assert.deepEqual([sz.marginUsdc, sz.sizeCoin], [null, 0.5]);
  const n = parseShortcut("long ETH 100 dollar position 10x", COINS);
  assert.deepEqual([n.marginUsdc, n.notionalUsd], [10, 100]);
  assert.equal(parseShortcut("long ETH 20 5x tp 25% sl 10%", COINS).tpPct, 25, "a % stays ROE");
});
