/**
 * test-agent-tools — the Agent's browser side: the read tools (src/agent/runTool.js), FlowFlow's limits on what it
 * may propose, and the loop (src/agent/agent.js) against a fake /api/chat. Markets are Hyperliquid's own answer
 * (scripts/fixtures/hl-meta-and-asset-ctxs.json, parsed by markets.js); quotes are FlowFlow's own.
 *
 * Run: node --test scripts/test-agent-tools.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePerpMarkets } from "../src/lib/hyperliquid/markets.js";
import { quoteOpenLive, quoteAddLive } from "../src/perp/live/perpBackend.js";
import { runReadTool, proposeAction, resolveCoin } from "../src/agent/runTool.js";
import { askAgent } from "../src/agent/agent.js";
import { chat } from "../src/agent/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hl-meta-and-asset-ctxs.json"), "utf8"));
const parsed = parsePerpMarkets(fixture.response, { now: 1 });
const snapshot = { markets: parsed.markets, byCoin: parsed.byCoin };
const ETH = parsed.byCoin.ETH;

const ethPos = {
  coin: "ETH", side: "long", szi: 0.05, entryPx: ETH.px, positionValue: 0.05 * ETH.px, unrealizedPnl: 1.2, returnOnEquity: 0.06,
  liquidationPx: ETH.px * 0.8, marginUsed: 20, leverage: { type: "isolated", value: 5 }, cumFunding: { sinceOpen: 0 },
};

const backend = {
  connected: true, mock: false, feeRate: 0.00045,
  account: {
    mode: { source: "perp" },
    perpBalanceUsdc: { answered: true, source: "perp", equityUsdc: 120.5, availableUsdc: 100.25, holdUsdc: 20, reason: null },
    positions: { answered: true, list: [ethPos], byCoin: { ETH: ethPos } },
    orders: { answered: true, list: [] },
    fills: { answered: true, list: [{ coin: "ETH", dir: "Open Long", sz: 0.05, px: ETH.px, closedPnl: 0, time: 1_700_000_000_000 }] },
  },
  quoteOpen: (a) => quoteOpenLive(a),
  quoteAdd: (a) => quoteAddLive(a),
};

const ctx = { snapshot, backend, fetchCandles: async () => [
  { time: 1, open: 100, high: 105, low: 99, close: 104 },
  { time: 2, open: 104, high: 110, low: 103, close: 109 },
  { time: 3, open: 109, high: 112, low: 107, close: 111 },
] };

test("T1) names the model types resolve to live markets; a made-up one does not", () => {
  assert.equal(resolveCoin("eth", snapshot).coin, "ETH");
  assert.equal(resolveCoin("ETH-USD", snapshot).coin, "ETH");
  assert.equal(resolveCoin("NOTACOIN", snapshot), null);
});

test("T2) get_markets: at most 10 small rows, sorted as asked", async () => {
  const r = await runReadTool("get_markets", { sort: "volume", limit: 50 }, ctx);
  assert.ok(r.markets.length <= 10 && r.markets.length > 0);
  assert.deepEqual(Object.keys(r.markets[0]).sort(), ["change_24h", "coin", "funding_hourly", "max_leverage", "price", "volume_24h"]);
});

test("T3) get_market / get_candles: figures come out formatted, candles only as a summary", async () => {
  const m = await runReadTool("get_market", { coin: "eth" }, ctx);
  assert.equal(m.coin, "ETH");
  assert.match(m.price, /^\$/);
  const c = await runReadTool("get_candles", { coin: "ETH", interval: "1h", bars: 3 }, ctx);
  assert.equal(c.bars, 3);
  assert.equal(c.trend, "up");
  assert.equal(c.change_pct, 11);
  assert.equal("candles" in c, false, "no raw bars go to the model");
});

test("T4) get_account: balance, positions with liquidation, and FlowFlow's limits; signed out says so", async () => {
  const a = await runReadTool("get_account", {}, ctx);
  assert.equal(a.signed_in, true);
  assert.equal(a.positions.length, 1);
  assert.equal(a.positions[0].coin, "ETH");
  assert.ok(a.positions[0].liquidation);
  assert.deepEqual(a.limits, { max_margin_usdc: 20, max_leverage: 10 });
  const out = await runReadTool("get_account", {}, { ...ctx, backend: { ...backend, connected: false } });
  assert.equal(out.signed_in, false);
});

test("T5) quote_trade prices with FlowFlow's own planner: size, liquidation, fee, TP/SL triggers", async () => {
  const q = await runReadTool("quote_trade", { coin: "ETH", side: "long", margin_usdc: 20, leverage: 5, tp_roe_pct: 25, sl_roe_pct: 10 }, ctx);
  assert.equal(q.ok, true, q.problem);
  assert.match(q.size_usd, /\$/);
  assert.match(q.liquidation, /≈/);
  assert.match(q.take_profit, /if hit/);
  assert.match(q.stop_loss, /if hit/);
});

test("T6) 🔴 propose_open never sends: it returns a card, capped at FlowFlow's limits", () => {
  /* BTC: not held in this ctx (ETH is held, and an add uses the position's own leverage: caps.js). */
  const p = proposeAction("propose_open", { coin: "BTC", side: "long", margin_usdc: 500, leverage: 50, tp_roe_pct: 25 }, ctx);
  assert.equal(p.ok, true);
  /* Pass-2 fix: a capped card says so on the card itself (the model's pre-clamp reason is not shown). */
  assert.deepEqual(p.card, { kind: "open", coin: "BTC", side: "buy", marginUsdc: 20, leverage: 10, tpPct: 25, slPct: null, status: "review", notes: ["Capped to 20 USDC · 10x (FlowFlow's limit)"] });
  assert.match(p.note, /margin capped at 20 USDC/);
  assert.match(p.note, /leverage capped at 10x/);
  assert.match(p.note, /Do not say it is filled/);
});

test("T7) propose_open without margin or leverage is refused back to the model (it must ask)", () => {
  assert.equal(proposeAction("propose_open", { coin: "ETH", side: "long", leverage: 5 }, ctx).ok, false);
  /* BTC is not held here (ETH is: an add needs no leverage, it uses the position's own — under the caps, caps.js). */
  assert.equal(proposeAction("propose_open", { coin: "BTC", side: "long", margin_usdc: 10 }, ctx).ok, false);
  assert.equal(proposeAction("propose_open", { coin: "FAKE", side: "long", margin_usdc: 10, leverage: 2 }, ctx).ok, false);
});

test("T8) propose_close needs an open position; deposit / withdraw only open the app's own panels", () => {
  assert.equal(proposeAction("propose_close", { coin: "BTC", fraction: 1 }, ctx).ok, false);
  assert.deepEqual(proposeAction("propose_close", { coin: "ETH", fraction: 0.5 }, ctx).card, { kind: "close", coin: "ETH", fraction: 0.5, status: "review" });
  assert.equal(proposeAction("open_deposit", {}, ctx).navigate, "/wallet?panel=deposit");
  assert.equal(proposeAction("open_withdraw", { amount_usdc: 5 }, ctx).navigate, "/wallet?panel=withdraw");
});

test("T9) propose_tpsl: a card for an open position only, and only with a level to set", () => {
  assert.deepEqual(proposeAction("propose_tpsl", { coin: "ETH", tp_roe_pct: 25, sl_roe_pct: -10 }, ctx).card, { kind: "tpsl", coin: "ETH", tpPct: 25, slPct: 10, status: "review" });
  assert.equal(proposeAction("propose_tpsl", { coin: "BTC", tp_roe_pct: 25 }, ctx).ok, false);
  assert.equal(proposeAction("propose_tpsl", { coin: "ETH" }, ctx).ok, false);
});

test("T10) one position per market: a held long makes a long an ADD, and a short is refused with words", async () => {
  const add = await runReadTool("quote_trade", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 20 }, ctx);
  assert.equal(add.adds_to_existing_position, true);
  assert.equal(add.leverage, 5, "an add is at the position's own leverage");
  const opp = await runReadTool("quote_trade", { coin: "ETH", side: "short", margin_usdc: 10, leverage: 3 }, ctx);
  assert.equal(opp.ok, false);
  assert.match(opp.problem, /close it first/);
  assert.equal(proposeAction("propose_open", { coin: "ETH", side: "short", margin_usdc: 10, leverage: 3 }, ctx).ok, false);
  assert.match(proposeAction("propose_open", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 }, ctx).note, /adds to the existing position/);
});

/* The last thing the Agent SAID (a text answer may be followed by the asset boxes card). */
const lastSaid = () => [...chat.get().messages].reverse().find((m) => m.role === "assistant");
const lastCard = () => [...chat.get().messages].reverse().find((m) => m.role === "card");

function fakeApi(answers) {
  const seen = [];
  const f = async (url, init) => {
    seen.push(JSON.parse(init.body).messages);
    const a = answers[seen.length - 1];
    return { status: a.status || 200, json: async () => a.body };
  };
  f.seen = seen;
  return f;
}

test("L1) the loop: read tools run in the browser, the card stops the loop, and every call is answered", async () => {
  chat.clear();
  const api = fakeApi([
    { body: { message: { role: "assistant", content: "", tool_calls: [
      { id: "c1", type: "function", function: { name: "get_account", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "quote_trade", arguments: JSON.stringify({ coin: "ETH", side: "long", margin_usdc: 20, leverage: 5 }) } },
    ] } } },
    { body: { message: { role: "assistant", content: "Here is the order.", tool_calls: [
      { id: "c3", type: "function", function: { name: "propose_open", arguments: JSON.stringify({ coin: "ETH", side: "long", margin_usdc: 20, leverage: 5 }) } },
    ] } } },
    { body: { message: { role: "assistant", content: "SHOULD NOT BE ASKED" } } },
  ]);
  await askAgent("long eth 20 5x", { backend, fetchImpl: api, getSnapshot: () => snapshot, fetchCandles: ctx.fetchCandles });
  assert.equal(api.seen.length, 2, "the card ended the loop: the next move is the user's");
  const shown = chat.get().messages;
  assert.deepEqual(shown.filter((m) => m.role === "status").map((m) => m.text), ["Checked account", "Quoted trade"]);
  assert.equal(shown.find((m) => m.role === "card").card.coin, "ETH");
  /* Item 8 (owner, pass 2): beside an action card the model's own prose is not shown; the card says what it is. */
  assert.ok(!shown.some((m) => m.role === "assistant" && m.text === "Here is the order."));
  const llm = chat.get().llm;
  const ids = llm.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(ids, ["c1", "c2", "c3"], "every tool call has its result, in order");
});

test("L2) no model on the server (503): one honest line, and the shortcuts still work", async () => {
  chat.clear();
  await askAgent("what is funding", { backend, fetchImpl: fakeApi([{ status: 503, body: { error: "not_configured" } }]), getSnapshot: () => snapshot });
  const last = lastSaid();
  assert.match(last.text, /isn't set up/);
  /* Never a dead end: the asset boxes come under the line. */
  assert.equal(chat.get().messages.at(-1).card.kind, "assets");
});

test("L3) a runaway model is stopped after 5 calls", async () => {
  chat.clear();
  const loop = { body: { message: { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "get_markets", arguments: "{}" } }] } } };
  const api = fakeApi([loop, loop, loop, loop, loop, loop, loop]);
  await askAgent("loop", { backend, fetchImpl: api, getSnapshot: () => snapshot });
  assert.equal(api.seen.length, 5);
  assert.match(lastSaid().text, /too many steps/);
});

test("L4) a card proposed with no text shows the model's `reason` above it, once", async () => {
  chat.clear();
  const card = (content) => fakeApi([{ body: { message: { role: "assistant", content, tool_calls: [
    { id: "r1", type: "function", function: { name: "propose_open", arguments: JSON.stringify({ coin: "ETH", side: "long", margin_usdc: 10, leverage: 3, reason: "ETH −3.7% in 24h on $1.2B volume; liq. near $1,610." }) } },
  ] } } }]);
  await askAgent("pick one and long it 10 3x", { backend, fetchImpl: card(""), getSnapshot: () => snapshot, fetchCandles: ctx.fetchCandles });
  let shown = chat.get().messages;
  const i = shown.findIndex((m) => m.role === "card");
  assert.equal(shown[i - 1].role, "assistant");
  assert.match(shown[i - 1].text, /liq\. near/);

  chat.clear();
  await askAgent("long eth 10 3x", { backend, fetchImpl: card("Here is the order."), getSnapshot: () => snapshot, fetchCandles: ctx.fetchCandles });
  shown = chat.get().messages;
  assert.equal(shown.filter((m) => m.role === "assistant").length, 1, "the model's own text wins; no second line");
});

test("L5) each step says which tool ran on which market, running then done, grouped by message", async () => {
  chat.clear();
  const api = fakeApi([
    { body: { message: { role: "assistant", content: "", tool_calls: [
      { id: "s1", type: "function", function: { name: "get_market", arguments: JSON.stringify({ coin: "eth" }) } },
      { id: "s2", type: "function", function: { name: "get_markets", arguments: "{}" } },
    ] } } },
    { body: { message: { role: "assistant", content: "ETH is down today." } } },
  ]);
  await askAgent("how is eth", { backend, fetchImpl: api, getSnapshot: () => snapshot, fetchCandles: ctx.fetchCandles });
  const steps = chat.get().messages.filter((m) => m.role === "status");
  assert.deepEqual(steps.map((s) => [s.tool, s.coin, s.state]), [["get_market", "ETH", "done"], ["get_markets", null, "done"]]);
  assert.ok(steps[0].run && steps[0].run === steps[1].run, "one message, one group");
  await askAgent("and btc", { backend, fetchImpl: fakeApi([{ body: { message: { role: "assistant", content: "", tool_calls: [
    { id: "s3", type: "function", function: { name: "get_market", arguments: JSON.stringify({ coin: "NOPE" }) } },
  ] } } }, { body: { message: { role: "assistant", content: "ok" } } }]), getSnapshot: () => snapshot, fetchCandles: ctx.fetchCandles });
  const later = chat.get().messages.filter((m) => m.role === "status").at(-1);
  assert.notEqual(later.run, steps[0].run, "the next message starts a new group");
  assert.equal(later.coin, null, "an unknown market draws no logo");
});

/* ── hardening: the Agent must not die after use ───────────────────────────── */

const ACCOUNT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const callOf = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const answered = (calls) => {
  const ids = chat.get().llm.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  for (const c of calls) assert.ok(ids.includes(c), `tool call ${c} has a result`);
};

test("H1) a /api/chat call that never answers ends at the timeout: one honest line, and busy is given back", async () => {
  chat.clear();
  const hang = () => new Promise(() => {});
  await askAgent("what is funding", { backend, fetchImpl: hang, getSnapshot: () => snapshot, fetchTimeoutMs: 30 });
  assert.match(lastSaid().text, /took too long/);
  assert.equal(chat.get().busy, false);
  /* A fetch that throws at once is "can't reach", and busy is given back too. */
  await askAgent("what is funding", { backend, fetchImpl: () => { throw new Error("offline"); }, getSnapshot: () => snapshot });
  assert.match(lastSaid().text, /can't reach/);
  assert.equal(chat.get().busy, false);
});

test("H2) a read tool that hangs is answered with an error at its own timeout, and the loop goes on", async () => {
  chat.clear();
  const api = fakeApi([
    { body: { message: { role: "assistant", content: "", tool_calls: [callOf("h1", "get_candles", { coin: "ETH" }), callOf("h2", "get_market", { coin: "ETH" })] } } },
    { body: { message: { role: "assistant", content: "ETH is flat." } } },
  ]);
  await askAgent("eth chart", { backend, fetchImpl: api, getSnapshot: () => snapshot, fetchCandles: () => new Promise(() => {}), readTimeoutMs: 30 });
  assert.equal(api.seen.length, 2);
  answered(["h1", "h2"]);
  const r1 = JSON.parse(chat.get().llm.find((m) => m.tool_call_id === "h1").content);
  assert.match(r1.error, /too long/);
  const steps = chat.get().messages.filter((m) => m.role === "status");
  assert.deepEqual(steps.map((s) => s.state), ["error", "done"]);
  assert.equal(lastSaid().text, "ETH is flat.");
  assert.equal(chat.get().busy, false);
});

test("H3) a tool that throws, a card that cannot be made and a panel that will not open: every call still gets an honest result", async () => {
  chat.clear();
  const broken = { ...backend, get account() { throw new Error("account store crashed"); } };
  let snaps = 0;
  const api = fakeApi([
    { body: { message: { role: "assistant", content: "", tool_calls: [
      callOf("t1", "get_account"), callOf("t2", "propose_open", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 }), callOf("t3", "not_a_tool"), { id: "t4", type: "function", function: { name: "get_markets", arguments: "{not json" } },
    ] } } },
    { body: { message: { role: "assistant", content: "", tool_calls: [callOf("t5", "open_deposit")] } } },
    { body: { message: { role: "assistant", content: "Open Deposit from the Wallet page." } } },
  ]);
  await askAgent("go", {
    backend: broken, fetchImpl: api,
    getSnapshot: () => { snaps++; if (snaps === 2) throw new Error("markets store crashed"); return snapshot; },
    navigate: () => { throw new Error("router gone"); },
  });
  answered(["t1", "t2", "t3", "t4", "t5"]);
  const res = (id) => JSON.parse(chat.get().llm.find((m) => m.tool_call_id === id).content);
  assert.match(res("t1").error, /crashed/);
  assert.ok(res("t2").error, "the card could not be made: the model is told");
  assert.match(res("t3").error, /Unknown tool/);
  assert.ok(Array.isArray(res("t4").markets), "unreadable arguments run with none");
  assert.match(res("t5").error, /could not be opened/, "a panel that did not open is not reported as open");
  assert.equal(api.seen.length, 3, "nothing waits on the user, so the model says what to do instead");
  assert.equal(lastSaid().text, "Open Deposit from the Wallet page.");
  assert.equal(chat.get().messages.some((m) => m.role === "card" && m.card.kind !== "assets"), false, "no trade card was made");
  assert.equal(chat.get().busy, false);
});

test("H4) an answer that is not a message is an honest error, not a crash", async () => {
  chat.clear();
  await askAgent("what now", { backend, fetchImpl: fakeApi([{ body: { message: "just a string" } }]), getSnapshot: () => snapshot });
  assert.equal(lastSaid().tone, "error");
  await askAgent("what now", { backend, fetchImpl: async () => ({ status: 200, json: async () => { throw new Error("bad json"); } }), getSnapshot: () => snapshot });
  assert.equal(lastSaid().tone, "error");
  assert.equal(chat.get().busy, false);
});

test("H5) 🔴 the account switches mid-loop: nothing more shows on the new account, and the old one's calls are all closed", async () => {
  chat.setAccount(ACCOUNT_A);
  chat.clear();
  const api = fakeApi([
    { body: { message: { role: "assistant", content: "", tool_calls: [callOf("w1", "get_candles", { coin: "ETH" }), callOf("w2", "get_market", { coin: "ETH" })] } } },
    { body: { message: { role: "assistant", content: "SHOULD NOT BE ASKED" } } },
  ]);
  const switching = () => { chat.setAccount(ACCOUNT_B); return new Promise(() => {}); };
  await askAgent("eth?", { backend, fetchImpl: api, getSnapshot: () => snapshot, fetchCandles: switching, readTimeoutMs: 5000 });
  assert.equal(api.seen.length, 1, "the loop stopped at once");
  assert.equal(chat.account(), ACCOUNT_B);
  assert.deepEqual(chat.get().messages, [], "nothing of A's on B's screen");
  assert.deepEqual(chat.get().llm, [], "nothing of A's in B's model history");
  assert.equal(chat.get().busy, false);
  chat.setAccount(ACCOUNT_A);
  answered(["w1", "w2"]);
  for (const id of ["w1", "w2"]) assert.match(JSON.parse(chat.get().llm.find((m) => m.tool_call_id === id).content).error, /interrupted/);
  assert.ok(chat.get().messages.every((m) => m.state !== "running"), "no step is left spinning");
  chat.setAccount("guest");
});

const poor = { ...backend, address: ACCOUNT_A, account: { ...backend.account, positions: { answered: true, list: [], byCoin: {} },
  perpBalanceUsdc: { answered: true, source: "perp", equityUsdc: 0, availableUsdc: 0, holdUsdc: null, reason: "new-account" } } };
const funds = { readArbitrum: async () => ({ raw: 9918000n, usdc: 9.918 }), readDeposits: () => ({ entries: [] }), readMove: async () => null };
const openEth = { body: { message: { role: "assistant", content: "", tool_calls: [callOf("p1", "propose_open", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 })] } } };

test("H6) 🔴 a card the user cannot afford: the Agent checks where the money is and says it under the card", async () => {
  chat.clear();
  const api = fakeApi([openEth, { body: { message: { role: "assistant", content: "Your Main Account is at 0; 9.918 USDC is on its way into it and moves in by itself." } } }]);
  await askAgent("long eth 10 3x", { backend: poor, fetchImpl: api, getSnapshot: () => snapshot, funds, fetchCandles: ctx.fetchCandles });
  assert.equal(api.seen.length, 2, "one more turn, to explain");
  const shown = chat.get().messages;
  assert.ok(shown.some((m) => m.role === "card"), "the card still shows");
  assert.ok(shown.some((m) => m.role === "status" && m.text === "Checked your money" && m.state === "done"));
  assert.match(shown.at(-1).text, /9\.918 USDC/);
  const r = JSON.parse(chat.get().llm.find((m) => m.tool_call_id === "p1").content);
  assert.equal(r.shown, true);
  assert.equal(r.funds.arbitrumWallet.usdc, 9.918);
  assert.match(r.note, /cannot confirm/);
  assert.equal(chat.get().busy, false);
});

test("H7) that extra turn cannot show a second card, and if the model is busy the summary is said instead", async () => {
  chat.clear();
  const again = fakeApi([openEth, openEth, { body: { message: { role: "assistant", content: "Explained." } } }]);
  await askAgent("long eth 10 3x", { backend: poor, fetchImpl: again, getSnapshot: () => snapshot, funds, fetchCandles: ctx.fetchCandles });
  assert.equal(chat.get().messages.filter((m) => m.role === "card").length, 1);
  assert.equal(chat.get().messages.at(-1).text, "Explained.");
  answered(["p1"]);

  chat.clear();
  const busy = fakeApi([openEth, { status: 429, body: { error: "busy", message: "The free model is busy. Try again in a moment." } }]);
  await askAgent("long eth 10 3x", { backend: poor, fetchImpl: busy, getSnapshot: () => snapshot, funds, fetchCandles: ctx.fetchCandles });
  const last = chat.get().messages.at(-1);
  assert.match(last.text, /9\.918 USDC is on its way into your Main Account/);
  assert.notEqual(last.tone, "error");
  assert.equal(chat.get().busy, false);
});

test("H8) get_funds in the loop says 'Checked your money'", async () => {
  chat.clear();
  const api = fakeApi([
    { body: { message: { role: "assistant", content: "", tool_calls: [callOf("g1", "get_funds")] } } },
    { body: { message: { role: "assistant", content: "ok" } } },
  ]);
  await askAgent("where is my money", { backend: poor, fetchImpl: api, getSnapshot: () => snapshot, funds });
  assert.deepEqual(chat.get().messages.filter((m) => m.role === "status").map((m) => [m.tool, m.text, m.state]), [["get_funds", "Checked your money", "done"]]);
  assert.match(JSON.parse(chat.get().llm.find((m) => m.tool_call_id === "g1").content).summary, /9\.918/);
});
