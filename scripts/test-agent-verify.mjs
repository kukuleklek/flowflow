/**
 * test-agent-verify — the adversarial verifier's findings on "one account, one Agent", get_funds and the hardening
 * (store.js, funds.js, runTool.js, agent.js, api/chat.js). Each test here FAILED on the code as it was verified.
 *
 * All ten are fixed, so they now run as ordinary tests (each one's `OPEN` / todo option was removed with its fix).
 * Run: node --test scripts/test-agent-verify.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatStore, chat, CHAT_PREFIX } from "../src/agent/store.js";
import { readFunds } from "../src/agent/funds.js";
import { runReadTool, proposeAction } from "../src/agent/runTool.js";
import { respondLocally } from "../src/agent/respond.js";
import { askAgent } from "../src/agent/agent.js";
import { TOOLS } from "../src/agent/tools.js";
import { cleanMessages, chatOnce } from "../api/chat.js";
import { parsePerpMarkets } from "../src/lib/hyperliquid/markets.js";
import { quoteOpenLive, quoteAddLive } from "../src/perp/live/perpBackend.js";
import { FIRST_HOP_PLAN_ID } from "../src/lib/relay/firstDeposit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hl-meta-and-asset-ctxs.json"), "utf8"));
const parsed = parsePerpMarkets(fixture.response, { now: 1 });
const snapshot = { markets: parsed.markets, byCoin: parsed.byCoin };

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USER = "0x1111111111111111111111111111111111111111";
const DEP = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000_000;

function memStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const wallet = (usdc) => async () => ({ raw: BigInt(Math.round(usdc * 1e6)), usdc });
const noDeposits = () => ({ entries: [] });

function live({ equity = 0, available = 0, reason = null, positions = [], complete = true, incompleteReason = null } = {}) {
  const byCoin = Object.fromEntries(positions.map((p) => [p.coin, p]));
  return {
    connected: true, mock: false, address: USER, feeRate: 0.00045,
    account: {
      mode: { source: "perp" },
      perpBalanceUsdc: { answered: true, source: "perp", equityUsdc: equity, availableUsdc: available, holdUsdc: null, idleSpotUsdc: null, reason, complete, incompleteReason },
      positions: { answered: true, list: positions, byCoin },
      orders: { answered: true, list: [] },
      fills: { answered: true, list: [] },
    },
    quoteOpen: (a) => quoteOpenLive(a),
    quoteAdd: (a) => quoteAddLive(a),
  };
}

/* ── V1 (HIGH) ─────────────────────────────────────────────────────────────────────────────────────────────── */
test("V1) 🔴 two tabs on one account: a tab that was busy while the other FILLED a card writes it back as 'review'", () => {
  const handlers = [];
  const had = globalThis.addEventListener;
  globalThis.addEventListener = (type, fn) => { if (type === "storage") handlers.push(fn); };
  try {
    const shared = memStorage();
    const tab1 = createChatStore({ storage: shared, tabStorage: null, listen: true });
    const tab2 = createChatStore({ storage: shared, tabStorage: null, listen: true });
    const [toTab1, toTab2] = handlers;
    const key = CHAT_PREFIX + A;
    tab1.setAccount(A);
    tab2.setAccount(A);
    const card = tab1.push({ role: "card", card: { kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, status: "review" } });
    toTab2({ key });
    tab2.setBusy(true); /* tab 2's own Agent loop is running */
    tab1.patchCard(card, { status: "sending" }); toTab2({ key });
    tab1.patchCard(card, { status: "filled", title: "Long ETH" }); toTab2({ key });
    tab2.push({ role: "status", text: "Read market", state: "running" }); /* tab 2's loop writes its own copy */
    toTab1({ key });
    const reloaded = createChatStore({ storage: shared, tabStorage: null });
    reloaded.setAccount(A);
    /* TradeCard renders any status but filled / cancelled as an active Confirm: a 'review' here is a second order. */
    assert.equal(reloaded.get().messages.find((m) => m.id === card).card.status, "filled", "a filled card never goes back to review");
    assert.equal(tab1.get().messages.find((m) => m.id === card).card.status, "filled", "nor in the tab that filled it");
  } finally {
    if (had === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = had;
  }
});

/* ── V2 (MEDIUM) ───────────────────────────────────────────────────────────────────────────────────────────── */
test("V2) a deposit watch that has not answered (loading / error / throws) is not 'No money is on its way'", async () => {
  const entry = (state) => () => ({ entries: [{ address: DEP, user: USER, routeId: "base-usdc", planId: FIRST_HOP_PLAN_ID, watching: true, state, error: state === "error" ? "x" : null, requests: [], movingNow: [] }] });
  for (const [name, readDeposits] of [["loading", entry("loading")], ["error", entry("error")], ["throws", () => { throw new Error("watch down"); }]]) {
    const f = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(0), readDeposits, now: () => NOW });
    assert.doesNotMatch(f.summary, /No money is on its way/, `${name}: an unread watch is no claim that nothing is coming`);
    assert.notEqual(f.next, "open_deposit", `${name}: no push to deposit again while a deposit may be arriving`);
  }
});

/* ── V3 (MEDIUM-LOW) ───────────────────────────────────────────────────────────────────────────────────────── */
test("V3) the last hop mid-send with the wallet already at 0 is money on its way, not 'No money is on its way'", async () => {
  const f = await readFunds({
    backend: live({ reason: "new-account" }), readArbitrum: wallet(0), readDeposits: noDeposits, now: () => NOW,
    readMove: async () => ({ step: "sending", code: null, usdc: 9.918, at: NOW - 5_000 }),
  });
  assert.doesNotMatch(f.summary, /No money is on its way/);
  assert.notEqual(f.next, "open_deposit");
  assert.match(f.summary, /9\.918/, "the moving figure is said");
});

/* ── V4 (MEDIUM) ───────────────────────────────────────────────────────────────────────────────────────────── */
test("V4) a card blocked because the money is IN POSITIONS (free 2 < margin 20) still sends the model to get_funds", async () => {
  const btc = { coin: "BTC", side: "long", szi: 0.001, marginUsed: 28, leverage: { type: "isolated", value: 5 } };
  const b = live({ equity: 30, available: 2, positions: [btc] });
  const p = proposeAction("propose_open", { coin: "ETH", side: "long", margin_usdc: 20, leverage: 5, reason: "x" }, { snapshot, backend: b });
  assert.equal(p.ok, true);
  assert.equal(p.fundsShort, true, "the card will say 'More than you can use right now': the model must say why");
  const q = await runReadTool("quote_trade", { coin: "ETH", side: "long", margin_usdc: 20, leverage: 5 }, { snapshot, backend: b });
  assert.ok(q.funds_note, "the quote warns too");
  const r = respondLocally("long ETH 20 5x", { markets: snapshot.markets, byCoin: snapshot.byCoin, backend: b });
  assert.equal(r.messages.length, 4, "the shortcut card says why under it");
});

/* ── V5 (MEDIUM-LOW) ───────────────────────────────────────────────────────────────────────────────────────── */
const fanOutTurn = (steps, k) => {
  const out = [{ role: "user", content: "compare BTC ETH SOL HYPE DOGE" }];
  let n = 0;
  for (let s = 0; s < steps; s++) {
    const calls = Array.from({ length: k }, () => ({ id: `c${n++}`, type: "function", function: { name: "get_market", arguments: "{\"coin\":\"ETH\"}" } }));
    out.push({ role: "assistant", content: "", tool_calls: calls });
    for (const c of calls) out.push({ role: "tool", tool_call_id: c.id, content: "{}" });
  }
  return out;
};

test("V5a) a tool-heavy turn (5 steps x 5 parallel reads) never wipes the model's whole history on the client", () => {
  const c = createChatStore({ storage: memStorage(), tabStorage: null });
  c.setAccount(A);
  c.pushLlm({ role: "user", content: "earlier" }, { role: "assistant", content: "earlier answer" });
  for (const m of fanOutTurn(5, 5)) c.pushLlm(m);
  const llm = c.get().llm;
  assert.ok(llm.length > 0, "the window is trimmed, not emptied");
  assert.equal(llm[0].role, "user");
});

test("V5b) the server answers a 25-message turn (4 steps x 5 reads) instead of 400 'Nothing to answer.'", async () => {
  const msgs = fanOutTurn(4, 5);
  assert.ok(cleanMessages(msgs).length > 0);
  const out = await chatOnce({
    messages: msgs, env: { LLM_BASE_URL: "https://llm.test", LLM_MODEL: "m", LLM_API_KEY: "k" },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) }),
  });
  assert.equal(out.status, 200);
});

/* ── V6 (LOW) ──────────────────────────────────────────────────────────────────────────────────────────────── */
test("V6) A's order result never lands in B's model history (A pressed New chat while the order was out, then switched)", async () => {
  const c = createChatStore({ storage: memStorage(), tabStorage: null });
  c.setAccount(A);
  const card = c.push({ role: "card", card: { kind: "open", coin: "ETH", status: "review" } });
  c.patchCard(card, { status: "sending" });
  await new Promise((r) => setTimeout(r, 0)); /* the order is out */
  c.clear();
  c.setAccount(B);
  /* TradeCard's own sequence once the order answers. */
  c.patchCard(card, { status: "filled", title: "Long ETH" });
  c.noteLlm("The user confirmed the trade card: Long ETH (0.01 ETH at 3000).");
  assert.deepEqual(c.get().llm, [], "B's model never hears about A's order");
});

/* ── V7 (LOW) ──────────────────────────────────────────────────────────────────────────────────────────────── */
test("V7) New chat while the Agent is answering: the old answer does not land in the new chat, and busy stays true until it ends", async () => {
  chat.setAccount(A);
  chat.clear();
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const api = async () => {
    n++;
    if (n === 1) {
      await gate;
      return { status: 200, json: async () => ({ message: { role: "assistant", content: "", tool_calls: [{ id: "x1", type: "function", function: { name: "get_funds", arguments: "{}" } }] } }) };
    }
    return { status: 200, json: async () => ({ message: { role: "assistant", content: "OLD ANSWER" } }) };
  };
  const run = askAgent("old question", { backend: { connected: false }, fetchImpl: api, getSnapshot: () => snapshot });
  await Promise.resolve();
  chat.clear(); /* AgentPage's "New chat" */
  const busyAfterClear = chat.get().busy;
  release();
  await run;
  const shown = chat.get().messages.map((m) => m.text);
  chat.setAccount("guest");
  assert.deepEqual(shown, [], "the new chat starts empty");
  assert.equal(busyAfterClear, true, "or, if the old loop goes on, the input is not handed back while it runs");
});

/* ── V8 (LOW) ──────────────────────────────────────────────────────────────────────────────────────────────── */
test("V8) a Perp balance read only in part (complete: false) is not 'at 0 USDC … No money is on its way'", async () => {
  const f = await readFunds({
    backend: live({ equity: 0, available: 0, complete: false, incompleteReason: "perp-venues-partial" }),
    readArbitrum: wallet(0), readDeposits: noDeposits, now: () => NOW,
  });
  assert.match(f.summary, /couldn't be read|part/i, "the partial read is said");
  assert.notEqual(f.next, "open_deposit");
});

/* ── V9 (LOW) ──────────────────────────────────────────────────────────────────────────────────────────────── */
test("V9) the model is never handed the deposit service's name (the prompt now says never to name it)", () => {
  const named = TOOLS.filter((t) => /relay/i.test(JSON.stringify(t))).map((t) => t.function.name);
  assert.deepEqual(named, [], "tools.js open_deposit says \"Relay deposit address\"");
});
