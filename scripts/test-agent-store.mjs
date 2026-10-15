/**
 * test-agent-store — ONE ACCOUNT, ONE AGENT, kept on this device (src/agent/store.js).
 *
 * Owner, 2026-10-15: "อย่าลืมนะ Chat Agent อะ 1 Account 1 Agent นะ ข้อมูลอยู่บน Local เขาพอ". Each account (the wallet
 * address, "mock", or "guest") has its own conversation in localStorage; switching never shows one account's messages
 * or model history to another; a reload comes back to the last account's chat; the old per-tab chat moves in once;
 * storage that refuses leaves everything working in memory.
 *
 * Run: node --test scripts/test-agent-store.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createChatStore, agentAccountKey, normalizeAccount, CHAT_PREFIX, LAST_ACCOUNT_KEY, OLD_TAB_KEY, CardTakenError,
} from "../src/agent/store.js";

const A = "0xAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const a = A.toLowerCase();
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

const refusing = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("SecurityError"); },
};

test("S1) the account key: the wallet (lower case), mock, guest — and null while a sign-in is still arriving", () => {
  assert.equal(agentAccountKey({ address: A }), a);
  assert.equal(agentAccountKey({ mock: true, address: A }), "mock", "a mock build has one practice account");
  assert.equal(agentAccountKey({ address: null }), "guest");
  assert.equal(agentAccountKey({ address: null, pending: "restoring" }), null, "keep what is on screen until it answers");
  assert.equal(agentAccountKey({ address: null, pending: "wallet" }), null);
  assert.equal(normalizeAccount("0xNOTANADDRESS"), "guest");
  assert.equal(normalizeAccount(undefined), "guest");
  assert.equal(normalizeAccount(" MOCK "), "mock");
});

test("S2) 🔴 switching accounts never leaks messages or the model history, both ways", () => {
  const st = memStorage();
  const chat = createChatStore({ storage: st, tabStorage: null });
  chat.setAccount(A);
  chat.push({ role: "user", text: "long eth 20 5x" });
  chat.pushLlm({ role: "user", content: "long eth 20 5x" }, { role: "assistant", content: "A's answer" });
  assert.equal(chat.account(), a);

  chat.setAccount(B);
  assert.equal(chat.account(), B);
  assert.deepEqual(chat.get().messages, [], "B sees nothing of A's");
  assert.deepEqual(chat.get().llm, [], "and the model sees nothing of A's on B's behalf");
  chat.push({ role: "user", text: "B's question" });
  chat.pushLlm({ role: "user", content: "B's question" });

  chat.setAccount("guest");
  assert.deepEqual(chat.get().messages, [], "signing out shows the guest's own (empty) chat");
  assert.deepEqual(chat.get().llm, []);

  chat.setAccount(A);
  assert.deepEqual(chat.get().messages.map((m) => m.text), ["long eth 20 5x"]);
  assert.deepEqual(chat.get().llm.map((m) => m.content), ["long eth 20 5x", "A's answer"]);
  assert.ok(!JSON.stringify(chat.get()).includes("B's question"));
  /* Each account has its own key on the device. */
  assert.ok(st.map.has(CHAT_PREFIX + a) && st.map.has(CHAT_PREFIX + B));
  assert.ok(!st.map.get(CHAT_PREFIX + a).includes("B's question"));
  assert.ok(!st.map.get(CHAT_PREFIX + B).includes("A's answer"));
  /* New chat clears this account only. */
  chat.clear();
  chat.setAccount(B);
  assert.equal(chat.get().messages.length, 1);
});

test("S3) a reload comes back to the last account's chat on the first paint; a card mid-signature loads as unknown", () => {
  const st = memStorage();
  const one = createChatStore({ storage: st, tabStorage: null });
  one.setAccount(A);
  one.push({ role: "user", text: "hi" });
  const card = one.push({ role: "card", card: { kind: "open", coin: "ETH", status: "review" } });
  one.push({ role: "status", text: "Read markets", state: "running" });
  one.patchCard(card, { status: "sending" });
  one.setBusy(true);

  const two = createChatStore({ storage: st, tabStorage: null });
  assert.equal(two.account(), a, "before the wallet has answered, the last account's chat is the one shown");
  assert.equal(st.map.get(LAST_ACCOUNT_KEY), a);
  const msgs = two.get().messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].card.status, "unknown", "not resumable after a reload");
  assert.equal(msgs[2].state, "done");
  assert.equal(two.get().busy, false, "busy never survives a reload");
  /* The wallet then answers with another account: the switch happens, nothing leaks. */
  two.setAccount(B);
  assert.deepEqual(two.get().messages, []);
});

test("S4) the old per-tab chat moves in ONCE, into the first real account, only if that account has none", () => {
  const old = JSON.stringify({ messages: [{ id: "o1", role: "user", text: "old tab chat" }, { id: "o2", role: "card", card: { kind: "open", status: "sending" } }], llm: [{ role: "user", content: "old" }] });
  const tab = memStorage({ [OLD_TAB_KEY]: old });
  const st = memStorage();
  const chat = createChatStore({ storage: st, tabStorage: tab });
  chat.setAccount("guest");
  assert.deepEqual(chat.get().messages, [], "never into guest: it belonged to whoever was signed in");
  assert.ok(tab.map.has(OLD_TAB_KEY));
  chat.setAccount(A);
  assert.deepEqual(chat.get().messages.map((m) => (m.card ? m.card.status : m.text)), ["old tab chat", "unknown"]);
  assert.notEqual(chat.get().messages[1].role, "card", "a card whose result is unknown is never offered with a Confirm");
  assert.deepEqual(chat.get().llm, [{ role: "user", content: "old" }]);
  assert.equal(tab.map.has(OLD_TAB_KEY), false, "removed: it moves once");
  chat.setAccount(B);
  assert.deepEqual(chat.get().messages, [], "B does not get it too");

  /* An account that already has its own chat keeps it; the old one is dropped, not mixed in. */
  const tab2 = memStorage({ [OLD_TAB_KEY]: old });
  const st2 = memStorage({ [CHAT_PREFIX + a]: JSON.stringify({ v: 3, messages: [{ id: "x", role: "user", text: "mine" }], llm: [] }) });
  const c2 = createChatStore({ storage: st2, tabStorage: tab2 });
  c2.setAccount(A);
  assert.deepEqual(c2.get().messages.map((m) => m.text), ["mine"]);
  assert.equal(tab2.map.has(OLD_TAB_KEY), false);
});

test("S5) storage that refuses everything: in-memory, no crash, and accounts still never mix", () => {
  for (const storage of [refusing, null]) {
    const chat = createChatStore({ storage, tabStorage: refusing });
    assert.equal(chat.account(), "guest");
    chat.setAccount(A);
    chat.push({ role: "user", text: "kept in memory" });
    chat.pushLlm({ role: "user", content: "kept in memory" });
    chat.setAccount(B);
    assert.deepEqual(chat.get().messages, []);
    chat.setAccount(A);
    assert.deepEqual(chat.get().messages.map((m) => m.text), ["kept in memory"], "this tab's memory holds it");
    assert.equal(chat.get().llm.length, 1);
  }
  /* A quota that refuses one write: the newest copy is the one in memory, not the older one on disk. */
  const st = memStorage();
  const chat = createChatStore({ storage: st, tabStorage: null });
  chat.setAccount(A);
  chat.push({ role: "user", text: "one" });
  const real = st.setItem;
  st.setItem = (k, v) => { if (k.startsWith(CHAT_PREFIX)) throw new Error("QuotaExceededError"); real(k, v); };
  chat.push({ role: "user", text: "two" });
  chat.setAccount(B);
  chat.setAccount(A);
  assert.deepEqual(chat.get().messages.map((m) => m.text), ["one", "two"]);
});

test("S6) a card's result and note stay with ITS account, even when the screen switched while the order was out", async () => {
  const st = memStorage();
  const chat = createChatStore({ storage: st, tabStorage: null });
  chat.setAccount(A);
  const card = chat.push({ role: "card", card: { kind: "open", coin: "ETH", status: "review" } });
  chat.patchCard(card, { status: "sending" });
  chat.setAccount(B);
  /* TradeCard's own sequence once the order answers: patch, then note. */
  chat.patchCard(card, { status: "filled", title: "Long ETH" });
  chat.noteLlm("The user confirmed the trade card: Long ETH.");
  assert.deepEqual(chat.get().messages, [], "nothing lands on B's screen");
  assert.deepEqual(chat.get().llm, [], "and B's model never hears about A's order");
  await Promise.resolve();
  chat.noteLlm("A later note with no card is the screen's own.");
  assert.equal(chat.get().llm.length, 1);
  chat.setAccount(A);
  assert.equal(chat.get().messages[0].card.status, "filled");
  assert.match(chat.get().llm.at(-1).content, /Long ETH/);
  /* pushLlmTo writes to the named account, on screen or not. */
  chat.setAccount(B);
  chat.pushLlmTo(A, { role: "user", content: "x" });
  assert.equal(chat.get().llm.length, 1);
  chat.setAccount(A);
  assert.equal(chat.get().llm.at(-1).content, "x");
});

test("S7) switching notifies the screen; setting the same account again does not", () => {
  const chat = createChatStore({ storage: memStorage(), tabStorage: null });
  let n = 0;
  chat.subscribe(() => { n++; });
  chat.setAccount(A);
  const after = n;
  assert.ok(after >= 1);
  chat.setAccount(A);
  chat.setAccount(a);
  assert.equal(n, after);
  chat.setAccount("guest");
  assert.equal(n, after + 1);
});

test("S8) a saved conversation that is garbage loads as an empty one", () => {
  const st = memStorage({ [LAST_ACCOUNT_KEY]: a, [CHAT_PREFIX + a]: "{not json" });
  const chat = createChatStore({ storage: st, tabStorage: null });
  assert.equal(chat.account(), a);
  assert.deepEqual(chat.get().messages, []);
  const st2 = memStorage({ [LAST_ACCOUNT_KEY]: "evil<script>", [CHAT_PREFIX + "guest"]: JSON.stringify({ messages: [null, 3, { role: "user", text: "ok" }], llm: "no" }) });
  const c2 = createChatStore({ storage: st2, tabStorage: null });
  assert.equal(c2.account(), "guest");
  assert.deepEqual(c2.get().messages.map((m) => m.text), ["ok"]);
  assert.deepEqual(c2.get().llm, []);
});

/* Two tabs of one account over one storage, with the browser's "storage" event delivered by hand. */
function twoTabs() {
  const handlers = [];
  const had = globalThis.addEventListener;
  globalThis.addEventListener = (type, fn) => { if (type === "storage") handlers.push(fn); };
  try {
    const shared = memStorage();
    const one = createChatStore({ storage: shared, tabStorage: null, listen: true });
    const two = createChatStore({ storage: shared, tabStorage: null, listen: true });
    one.setAccount(A);
    two.setAccount(A);
    const [toOne, toTwo] = handlers;
    const key = CHAT_PREFIX + a;
    return { shared, one, two, toOne: () => toOne({ key }), toTwo: () => toTwo({ key }) };
  } finally {
    if (had === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = had;
  }
}

test("S9) 🔴 a card is confirmed ONCE: a second claim throws (no second order), and a settled card never changes", () => {
  const chat = createChatStore({ storage: memStorage(), tabStorage: null });
  chat.setAccount(A);
  const card = chat.push({ role: "card", card: { kind: "open", coin: "ETH", side: "buy", status: "review" } });
  chat.patchCard(card, { status: "sending" });
  /* The same card mounted again (the page moved between /agent and the Chat tab) and Confirm pressed again. */
  assert.throws(() => chat.patchCard(card, { status: "sending" }), CardTakenError);
  assert.notEqual(chat.get().messages[0].role, "card", "the stale copy is unmounted: a line until the order answers");
  chat.patchCard(card, { status: "filled", title: "Long ETH" });
  assert.throws(() => chat.patchCard(card, { status: "sending" }), CardTakenError, "a filled card is never sent again");
  chat.patchCard(card, { status: "review" });
  chat.patchCard(card, { status: "cancelled" });
  assert.equal(chat.get().messages[0].card.status, "filled", "settled stays settled");
  assert.equal(chat.get().messages[0].role, "card", "this tab's own card stays a card");
  /* A card that is gone (New chat) cannot be claimed either. */
  const other = chat.push({ role: "card", card: { kind: "close", coin: "BTC", status: "review" } });
  chat.clear();
  assert.throws(() => chat.patchCard(other, { status: "sending" }), CardTakenError);
  /* A failed order gives the card back for review, and it can be confirmed again. */
  const again = chat.push({ role: "card", card: { kind: "open", coin: "SOL", side: "sell", status: "review" } });
  chat.patchCard(again, { status: "sending" });
  chat.patchCard(again, { status: "review" });
  assert.doesNotThrow(() => chat.patchCard(again, { status: "sending" }));
});

test("S10) 🔴 a cancel that did not land says nothing to the model", () => {
  const { one, two, toTwo } = twoTabs();
  const card = one.push({ role: "card", card: { kind: "open", coin: "ETH", side: "buy", status: "review" } });
  toTwo();
  one.patchCard(card, { status: "sending" });
  /* Tab 2 has not heard yet and presses Cancel on its stale copy. */
  two.patchCard(card, { status: "cancelled" });
  two.noteLlm("The user cancelled the long ETH card. Nothing was sent.");
  assert.deepEqual(two.get().llm, [], "the order is out: 'nothing was sent' would be false");
  assert.equal(two.get().messages.find((m) => m.id === card).card.status, "sending");
});

test("S11) 🔴 a second tab never offers a Confirm on a card the first tab is sending; it comes back once it settles", () => {
  const { one, two, toOne, toTwo } = twoTabs();
  const card = one.push({ role: "card", card: { kind: "open", coin: "ETH", side: "buy", status: "review" } });
  toTwo();
  assert.equal(two.get().messages[0].role, "card", "up for review: both tabs show the card");
  one.patchCard(card, { status: "sending" });
  toTwo();
  assert.equal(one.get().messages[0].role, "card", "the tab sending it keeps its card");
  const shown = two.get().messages[0];
  assert.notEqual(shown.role, "card", "the other tab shows a line, with no Confirm");
  assert.match(shown.text, /long ETH card is being sent/);
  assert.throws(() => two.patchCard(card, { status: "sending" }), CardTakenError, "and a stale Confirm there sends nothing");
  one.patchCard(card, { status: "filled", title: "Long ETH" });
  toTwo();
  assert.equal(two.get().messages[0].role, "card");
  assert.equal(two.get().messages[0].card.status, "filled", "settled: the card comes back, as filled");
  /* Both tabs write into one conversation: their ids never collide, and neither loses the other's messages. */
  for (let i = 0; i < 20; i++) { one.push({ role: "status", text: `one ${i}` }); two.push({ role: "status", text: `two ${i}` }); }
  toOne();
  const ids = one.get().messages.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(one.get().messages.length, 41);
});

test("S12) after a reload a card that was being sent is a line, not a card; New chat is a new conversation", () => {
  const st = memStorage();
  const one = createChatStore({ storage: st, tabStorage: null });
  one.setAccount(A);
  const card = one.push({ role: "card", card: { kind: "close", coin: "BTC", status: "review" } });
  one.patchCard(card, { status: "sending" });
  const two = createChatStore({ storage: st, tabStorage: null });
  const m = two.get().messages[0];
  assert.equal(m.card.status, "unknown");
  assert.notEqual(m.role, "card");
  assert.match(m.text, /close BTC card .* isn't known here/);
  assert.throws(() => two.patchCard(card, { status: "sending" }), CardTakenError);
  /* New chat: a new conversation id; a loop's write to the old one goes nowhere; busy is left to the loop. */
  const old = two.conversation();
  two.setBusy(true);
  two.clear();
  assert.notEqual(two.conversation(), old);
  assert.equal(two.get().busy, true);
  two.pushLlmTo(old, { role: "tool", tool_call_id: "x", content: "{}" });
  assert.deepEqual(two.get().llm, [], "nothing of the old chat lands in the new one");
  two.pushLlmTo(two.conversation(), { role: "user", content: "new" });
  assert.equal(two.get().llm.length, 1);
});
