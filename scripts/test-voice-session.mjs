/**
 * test-voice-session — the browser half of Voice Mode (src/agent/voice/session.js + voiceTools.js), without a
 * browser: the WebRTC call is driven with fake mic / peer connection / fetch, and the conversation with scripted
 * Realtime server events into a real chat store (store.js, memory only).
 *
 *   • transcripts land in the chat as { role: "user" | "assistant", text, via: "voice" }, in order;
 *   • the model's tool calls run through the same tools (runToolCall), with FlowFlow's caps, and their results go
 *     back as function_call_output, then a response;
 *   • 🔴 VOICE NEVER CONFIRMS: an action tool only adds a card in "review"; no confirm tool exists; a spoken
 *     "confirm" / "ยืนยัน" only adds the "tap Confirm" line; no voice file can touch a card's status;
 *   • the call always hangs up (time limit, errors) and a refused mic costs nothing.
 *
 * No network. Run: node --test scripts/test-voice-session.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatStore } from "../src/agent/store.js";
import { TOOLS } from "../src/agent/tools.js";
import { parsePerpMarkets } from "../src/lib/hyperliquid/markets.js";
import { quoteOpenLive, quoteAddLive } from "../src/perp/live/perpBackend.js";
import {
  createVoiceConversation, openVoiceCall, legacyRunToolCall, resolveRunToolCall, CALLS_URL, SESSION_URL, DATA_CHANNEL,
} from "../src/agent/voice/session.js";
import {
  saysConfirm, confirmNotice, voiceCard, followUp, functionCalls, contextNote, micErrorText, VOICE_CANT_CONFIRM,
  VOICE_STYLE, voiceInstructions, MAX_VOICE_STEPS,
} from "../src/agent/voice/voiceTools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tick = () => new Promise((r) => setImmediate(r));

/* ── a conversation rig ──────────────────────────────────────────────────────────────────────────────────── */

function rig({ runToolCall, navigate, clock, boxes, intentOf } = {}) {
  const chat = createChatStore({ storage: null, tabStorage: null });
  chat.setAccount("mock");
  const sent = [];
  const states = [];
  const fatal = [];
  const tools = [];
  const run = runToolCall || (async (name, args) => {
    tools.push({ name, args });
    if (name === "propose_open") return { result: { shown: true, note: "Trade card shown." }, card: { kind: "open", coin: "ETH", side: "buy", marginUsdc: 10, leverage: 3, status: "review" } };
    if (name === "open_deposit") return { result: { shown: true }, navigate: "/wallet?panel=deposit" };
    return { result: { coin: args.coin || null, price: "$2,450" } };
  });
  const convo = createVoiceConversation({
    send: (e) => { sent.push(e); return true; },
    runToolCall: (n, a, c) => run(n, a, c),
    toolCtx: (extra) => ({ via: "voice", ...extra }),
    navigate: navigate || (() => {}),
    chat,
    onState: (s) => states.push(s),
    onFatal: (r) => fatal.push(r),
    ...(clock ? { setTimer: clock.setTimer, clearTimer: clock.clearTimer } : {}),
    ...(boxes ? { boxes } : {}),
    ...(intentOf ? { intentOf } : {}),
  });
  return { chat, convo, sent, states, fatal, tools };
}

const say = (r, itemId, text) => {
  r.convo.handle({ type: "input_audio_buffer.speech_started", item_id: itemId });
  r.convo.handle({ type: "input_audio_buffer.committed", item_id: itemId });
  r.convo.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: text });
};
const callResponse = (id, calls) => ({
  type: "response.done",
  response: { id, status: "completed", output: calls.map(([callId, name, args]) => ({ type: "function_call", status: "completed", call_id: callId, name, arguments: JSON.stringify(args) })) },
});
const outputs = (sent) => sent.filter((e) => e.type === "conversation.item.create" && e.item.type === "function_call_output");
const creates = (sent) => sent.filter((e) => e.type === "response.create");

test("S1) what the user says shows at once as …, fills in from its transcript, and reaches the text Agent's history", () => {
  const r = rig();
  r.convo.handle({ type: "input_audio_buffer.speech_started", item_id: "i1" });
  r.convo.handle({ type: "input_audio_buffer.committed", item_id: "i1" });
  let m = r.chat.get().messages.at(-1);
  assert.deepEqual([m.role, m.text, m.via], ["user", "…", "voice"]);
  r.convo.handle({ type: "conversation.item.input_audio_transcription.delta", item_id: "i1", delta: "ราคา ETH " });
  assert.equal(r.chat.get().messages.at(-1).text, "ราคา ETH");
  r.convo.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "ราคา ETH เท่าไหร่" });
  m = r.chat.get().messages.at(-1);
  assert.equal(m.text, "ราคา ETH เท่าไหร่");
  assert.equal(m.pending, false);
  assert.deepEqual(r.chat.get().llm.at(-1), { role: "user", content: "ราคา ETH เท่าไหร่" });
  /* A failed transcript is said plainly, never left as … */
  r.convo.handle({ type: "input_audio_buffer.committed", item_id: "i2" });
  r.convo.handle({ type: "conversation.item.input_audio_transcription.failed", item_id: "i2" });
  assert.equal(r.chat.get().messages.at(-1).text, "(didn't catch that)");
});

test("S2) the Agent's spoken words land as { role: assistant, via: voice }; its history entry waits for the question", () => {
  const r = rig();
  r.convo.handle({ type: "input_audio_buffer.committed", item_id: "i1" });
  r.convo.handle({ type: "response.created", response: { id: "r1" } });
  r.convo.handle({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "ETH is about 2,450 dollars." });
  r.convo.handle({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
  const m = r.chat.get().messages.at(-1);
  assert.deepEqual([m.role, m.text, m.via], ["assistant", "ETH is about 2,450 dollars.", "voice"]);
  assert.equal(r.chat.get().llm.length, 0, "the answer waits for the words it answers");
  r.convo.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "eth price" });
  assert.deepEqual(r.chat.get().llm.map((x) => x.role), ["user", "assistant"]);
  assert.equal(r.chat.get().llm[1].content, "ETH is about 2,450 dollars.");
});

test("S3) a read tool: a work step in the chat, its result back to the model as function_call_output, then an answer", async () => {
  const r = rig();
  say(r, "i1", "how is eth");
  r.convo.handle(callResponse("r1", [["c1", "get_market", { coin: "eth" }]]));
  await tick();
  assert.deepEqual(r.tools, [{ name: "get_market", args: { coin: "eth" } }]);
  const step = r.chat.get().messages.find((x) => x.role === "status");
  assert.equal(step.tool, "get_market");
  assert.equal(step.state, "done");
  const out = outputs(r.sent);
  assert.equal(out.length, 1);
  assert.equal(out[0].item.call_id, "c1");
  assert.deepEqual(JSON.parse(out[0].item.output), { coin: "eth", price: "$2,450" });
  assert.deepEqual(creates(r.sent), [{ type: "response.create" }], "after reads the model may still use tools");
  /* The same call_id never runs twice. */
  r.convo.handle(callResponse("r1", [["c1", "get_market", { coin: "eth" }]]));
  await tick();
  assert.equal(r.tools.length, 1);
});

test("S4) 🔴 an action tool only adds a card in REVIEW (whatever the tool returned), then the model may only talk", async () => {
  for (const status of ["review", "sending", "filled", undefined]) {
    const r = rig({ runToolCall: async () => ({ result: { shown: true }, card: { kind: "open", coin: "ETH", side: "buy", marginUsdc: 10, leverage: 3, status } }) });
    say(r, "i1", "long eth 10 usdc 3x");
    r.convo.handle(callResponse("r1", [["c1", "propose_open", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3, reason: "x" }]]));
    await tick();
    const cards = r.chat.get().messages.filter((x) => x.role === "card");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].card.status, "review", `tool said ${status}`);
    assert.equal(cards[0].card.via, "voice");
    assert.deepEqual(creates(r.sent).at(-1), { type: "response.create", response: { tool_choice: "none" } });
  }
});

test("S5) one card per thing said: a second action in the same turn is refused; a new turn may show another", async () => {
  const r = rig();
  say(r, "i1", "long eth and short btc");
  r.convo.handle(callResponse("r1", [["c1", "propose_open", { coin: "ETH" }], ["c2", "propose_open", { coin: "BTC" }]]));
  await tick();
  assert.equal(r.chat.get().messages.filter((x) => x.role === "card").length, 1);
  const out = outputs(r.sent);
  assert.match(JSON.parse(out[1].item.output).error, /already on screen/);
  say(r, "i2", "now short btc");
  r.convo.handle(callResponse("r2", [["c3", "propose_open", { coin: "BTC" }]]));
  await tick();
  assert.equal(r.chat.get().messages.filter((x) => x.role === "card").length, 2);
});

test("S6) 🔴 a tool the app doesn't have (confirm_order, …) gets an error: nothing runs, no card", async () => {
  const r = rig();
  say(r, "i1", "confirm it");
  r.convo.handle(callResponse("r1", [["c1", "confirm_order", { id: "x" }], ["c2", "execute_trade", {}]]));
  await tick();
  assert.equal(r.tools.length, 0);
  assert.equal(r.chat.get().messages.filter((x) => x.role === "card").length, 0);
  for (const o of outputs(r.sent)) assert.match(JSON.parse(o.item.output).error, /no tool called .*tap/i);
});

test("S7) 🔴 a spoken confirm never confirms: the card stays in review; the user is told to tap Confirm, once", async () => {
  const clock = timers();
  const fire = (ms) => { for (const t of clock.list.filter((x) => x.on && x.ms === ms)) { t.on = false; t.fn(); } };
  const r = rig({ clock });
  say(r, "i1", "long eth 10 usdc 3x");
  r.convo.handle(callResponse("r1", [["c1", "propose_open", { coin: "ETH" }]]));
  await tick();
  const toolsBefore = r.tools.length;
  /* The model does not say it: after a moment the app does. */
  for (const [i, words] of ["confirm", "Yes, place it", "ยืนยันเลย", "ตกลง ส่งเลย", "do it"].entries()) {
    say(r, `k${i}`, words);
    assert.notEqual(r.chat.get().messages.at(-1).text, VOICE_CANT_CONFIRM, "not before the model has had its turn");
    fire(5000);
    assert.equal(r.chat.get().messages.at(-1).text, VOICE_CANT_CONFIRM, words);
  }
  /* The model says it (before or after the transcript lands): the app adds nothing, so no line twice. */
  const lines = () => r.chat.get().messages.filter((m) => m.text === VOICE_CANT_CONFIRM).length;
  const before = lines();
  say(r, "k9", "confirm");
  r.convo.handle({ type: "response.output_audio_transcript.done", response_id: "r9", transcript: "You can't confirm by voice. Tap Confirm on the card." });
  fire(5000);
  r.convo.handle({ type: "input_audio_buffer.committed", item_id: "k10" });
  r.convo.handle({ type: "response.output_audio_transcript.done", response_id: "r10", transcript: "กดยืนยันบนการ์ดได้เลยครับ" });
  r.convo.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "k10", transcript: "ยืนยัน" });
  fire(5000);
  assert.equal(lines(), before);
  const card = r.chat.get().messages.find((x) => x.role === "card");
  assert.equal(card.card.status, "review");
  assert.equal(r.tools.length, toolsBefore, "saying confirm runs nothing");
  /* No card waiting: no line (the model answers). Words that aren't a confirm: no line. */
  const r2 = rig({ clock });
  say(r2, "i1", "confirm");
  fire(5000);
  assert.notEqual(r2.chat.get().messages.at(-1).text, VOICE_CANT_CONFIRM);
  assert.equal(saysConfirm("what is the price of eth"), false);
  assert.equal(confirmNotice("ยืนยัน", [{ role: "card", card: { kind: "open", status: "filled" } }]), null, "a settled card needs no tap");
  assert.equal(confirmNotice("ยืนยัน", [{ role: "card", card: { kind: "setups" } }]), null, "a card without Confirm");
  assert.equal(confirmNotice("confirm", [{ role: "card", card: { kind: "stake", enabled: false } }]), null, "a stake card that opens later");
  assert.equal(confirmNotice("confirm", [{ role: "card", card: { kind: "stake", enabled: true } }]), VOICE_CANT_CONFIRM);
});

test("S7b) a card the user can't confirm for lack of money: voice reads where the money is (get_funds), like typing", async () => {
  const calls = [];
  const r = rig({
    runToolCall: async (name) => {
      calls.push(name);
      if (name === "propose_open") return { result: { shown: true, note: "short" }, card: { kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5 }, fundsShort: true };
      if (name === "get_funds") return { result: { summary: "4.20 USDC in Perp; 15 USDC arriving." } };
      return { result: {} };
    },
  });
  say(r, "i1", "long eth 20 5x");
  r.convo.handle(callResponse("r1", [["c1", "propose_open", { coin: "ETH" }]]));
  await tick();
  await tick();
  assert.deepEqual(calls, ["propose_open", "get_funds"]);
  assert.equal(JSON.parse(outputs(r.sent)[0].item.output).funds.summary, "4.20 USDC in Perp; 15 USDC arriving.");
  assert.equal(r.chat.get().messages.find((m) => m.role === "status").tool, "get_funds");
  assert.deepEqual(creates(r.sent).at(-1), { type: "response.create", response: { tool_choice: "none" } });
});

test("S8) 🔴 the voice files never touch a card's status or Confirm; the model is told voice can't confirm", () => {
  for (const f of ["session.js", "useVoice.js", "VoiceButton.jsx", "voiceTools.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "src/agent/voice", f), "utf8");
    assert.doesNotMatch(src, /patchCard|CardTakenError|placeOrder|sendOrder|signTypedData|exchange\./, f);
    assert.doesNotMatch(src, /status:\s*"(sending|filled|cancelled)"/, f);
  }
  assert.match(VOICE_STYLE, /YOU CAN NEVER CONFIRM, AND NEITHER CAN THE USER'S VOICE/);
  assert.match(VOICE_STYLE, /tap Confirm on the card/);
  assert.match(VOICE_STYLE, /ยืนยัน/);
  assert.ok(voiceInstructions("BASE").startsWith("BASE\n\n"));
  assert.equal(voiceCard({ kind: "open", status: "sending" }).status, "review");
  assert.equal(voiceCard(null), null);
});

test("S9) through the real tools, voice gets FlowFlow's caps: margin ≤ 20 USDC, leverage ≤ 10x, nothing sent", async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hl-meta-and-asset-ctxs.json"), "utf8"));
  const parsed = parsePerpMarkets(fixture.response, { now: 1 });
  const backend = {
    connected: true, mock: false, feeRate: 0.00045,
    account: {
      mode: { source: "perp" },
      perpBalanceUsdc: { answered: true, source: "perp", equityUsdc: 120.5, availableUsdc: 100.25, holdUsdc: 0, reason: null },
      positions: { answered: true, list: [], byCoin: {} },
      orders: { answered: true, list: [] },
      fills: { answered: true, list: [] },
    },
    quoteOpen: (a) => quoteOpenLive(a),
    quoteAdd: (a) => quoteAddLive(a),
  };
  const ctx = { snapshot: { markets: parsed.markets, byCoin: parsed.byCoin }, backend, fetchCandles: async () => [] };
  const out = await legacyRunToolCall("propose_open", { coin: "eth", side: "long", margin_usdc: 500, leverage: 40, reason: "x" }, ctx);
  assert.equal(out.card.marginUsdc, 20);
  assert.equal(out.card.leverage, 10);
  assert.equal(out.card.status, "review");
  assert.match(out.result.note, /margin capped at 20 USDC/);
  assert.match(out.result.note, /leverage capped at 10x/);
  const read = await legacyRunToolCall("get_market", { coin: "ETH" }, ctx);
  assert.equal(read.result.coin, "ETH");
  assert.match((await legacyRunToolCall("confirm_order", {}, ctx)).result.error, /Unknown tool/);
  /* The shared runToolCall (runTool.js, re-exported by agent.js), driven by a voice conversation: same caps. */
  const shared = await import("../src/agent/runTool.js");
  if (typeof shared.runToolCall === "function") {
    const r = rig({ runToolCall: (n, a) => shared.runToolCall(n, a, ctx) });
    say(r, "i1", "long eth 500 usdc 40x");
    r.convo.handle(callResponse("r1", [["c1", "propose_open", { coin: "eth", side: "long", margin_usdc: 500, leverage: 40, reason: "x" }]]));
    for (let i = 0; i < 20 && !r.chat.get().messages.some((m) => m.role === "card"); i++) await tick();
    const card = r.chat.get().messages.find((m) => m.role === "card").card;
    assert.equal(card.marginUsdc, 20);
    assert.equal(card.leverage, 10);
    assert.equal(card.status, "review");
  }
  /* The text loop's runToolCall, when agent.js has it; these tools otherwise. */
  assert.equal(resolveRunToolCall({}), legacyRunToolCall);
  const mine = async () => ({ result: {} });
  assert.equal(resolveRunToolCall({ runToolCall: mine }), mine);
});

test("S10) the step limit: after 5 tool rounds for one question the model must answer in words", async () => {
  const r = rig();
  say(r, "i1", "scan everything");
  for (let i = 0; i < MAX_VOICE_STEPS; i++) {
    r.convo.handle(callResponse(`r${i}`, [[`c${i}`, "get_markets", {}]]));
    await tick();
  }
  assert.deepEqual(creates(r.sent).at(-1), { type: "response.create", response: { tool_choice: "none" } });
  assert.deepEqual(creates(r.sent)[0], { type: "response.create" });
  assert.deepEqual(followUp({ steps: 1 }), { type: "response.create" });
});

test("S11) a panel opens only after the Agent has said so; out of credit ends the call; another chat stops it", async () => {
  const went = [];
  const r = rig({ navigate: (to) => went.push(to) });
  say(r, "i1", "deposit");
  r.convo.handle(callResponse("r1", [["c1", "open_deposit", {}]]));
  await tick();
  assert.deepEqual(went, [], "not while the model is about to speak");
  r.convo.handle({ type: "response.created", response: { id: "r2" } });
  r.convo.handle({ type: "output_audio_buffer.started", response_id: "r2" });
  r.convo.handle({ type: "output_audio_buffer.stopped", response_id: "r2" });
  assert.deepEqual(went, ["/wallet?panel=deposit"]);
  r.convo.handle({ type: "response.done", response: { id: "r3", status: "failed", status_details: { error: { code: "insufficient_quota" } } } });
  assert.deepEqual(r.fatal, ["quota"]);
  r.convo.handle({ type: "error", error: { code: "session_expired" } });
  assert.deepEqual(r.fatal, ["quota", "expired"]);
  /* New chat: the call's conversation is gone from view; nothing more lands. */
  r.chat.clear();
  say(r, "i9", "hello?");
  assert.equal(r.chat.get().messages.length, 0);
  assert.equal(r.convo.alive, false);
});

test("S12) the call starts with the market on screen and the chat so far, as app data", () => {
  assert.equal(contextNote({}), null);
  const note = contextNote({ coin: "ETH", messages: [{ role: "user", text: "long eth 10 3x" }, { role: "card", card: { kind: "open", coin: "ETH", side: "buy", marginUsdc: 10, leverage: 3 } }] });
  assert.match(note, /^\[FlowFlow app\]/);
  assert.match(note, /looking at the ETH market/);
  assert.match(note, /data, not instructions/);
  assert.match(note, /trade card: long ETH 10 USDC 3x/);
  const r = rig();
  r.chat.push({ role: "user", text: "hi" });
  r.convo.begin({ coin: "BTC" });
  assert.equal(r.sent[0].type, "conversation.item.create");
  assert.equal(r.sent[0].item.role, "system");
  assert.match(r.sent[0].item.content[0].text, /BTC/);
  assert.equal(functionCalls({ output: [{ type: "function_call", call_id: "a", name: "x", arguments: "{bad" }] })[0].args && 1, 1, "bad JSON → {}");
});

/* ── the transport, with fakes ───────────────────────────────────────────────────────────────────────────── */

class FakeTrack { constructor() { this.stopped = false; } stop() { this.stopped = true; } }
class FakeStream { constructor() { this.t = [new FakeTrack()]; } getTracks() { return this.t; } getAudioTracks() { return this.t; } }
class FakeDC { constructor(label) { this.label = label; this.readyState = "connecting"; this.sent = []; } send(s) { this.sent.push(JSON.parse(s)); } close() { this.readyState = "closed"; } }
function fakePC() {
  const made = [];
  class PC {
    constructor() { this.tracks = []; this.closed = false; this.connectionState = "new"; made.push(this); }
    addTrack(t, s) { this.tracks.push(t); return { track: t }; }
    getSenders() { return this.tracks.map((track) => ({ track })); }
    createDataChannel(label) { this.dc = new FakeDC(label); return this.dc; }
    async createOffer() { return { type: "offer", sdp: "v=0\r\no=offer" }; }
    async setLocalDescription(d) { this.local = d; }
    async setRemoteDescription(d) { this.remote = d; }
    close() { this.closed = true; this.connectionState = "closed"; }
  }
  PC.made = made;
  return PC;
}
function timers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => { const t = { fn, ms, on: true }; list.push(t); return t; },
    clearTimer: (t) => { if (t) t.on = false; },
  };
}
function fetchSeq(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = answers[calls.length - 1];
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  fn.calls = calls;
  return fn;
}

test("O1) the mic first: a refusal ends the call with a clear line, and nothing is fetched (it costs nothing)", async () => {
  const f = fetchSeq([]);
  const ends = [];
  const call = openVoiceCall({
    fetchImpl: f, PeerConnection: fakePC(), AudioCtx: null, makeAudio: () => null,
    mediaDevices: { getUserMedia: async () => { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; } },
    onEnd: (e) => ends.push(e), ...timers(),
  });
  assert.equal(await call.start(), false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(ends, [{ reason: "mic", message: micErrorText({ name: "NotAllowedError" }) }]);
  assert.match(ends[0].message, /Microphone blocked/);
  const none = openVoiceCall({ fetchImpl: f, mediaDevices: null, PeerConnection: fakePC(), onEnd: (e) => ends.push(e), ...timers() });
  assert.equal(await none.start(), false);
  assert.equal(ends.at(-1).reason, "unsupported");
});

test("O2) the WebRTC handshake per OpenAI's guide: secret from our server, mic track, oai-events channel, SDP to /realtime/calls", async () => {
  const PC = fakePC();
  const mic = new FakeStream();
  const t = timers();
  const f = fetchSeq([{ status: 200, body: { value: "ek_test", maxSeconds: 180 } }, { status: 201, body: "v=0\r\no=answer" }]);
  const ends = [];
  const events = [];
  let opened = 0;
  const call = openVoiceCall({
    fetchImpl: f, PeerConnection: PC, AudioCtx: null, makeAudio: () => ({}), mediaDevices: { getUserMedia: async () => mic },
    onEnd: (e) => ends.push(e), onEvent: (e) => events.push(e), onOpen: () => opened++, ...t, now: () => 1_000,
  });
  assert.equal(await call.start(), true);
  assert.equal(f.calls[0].url, SESSION_URL);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[1].url, CALLS_URL);
  assert.equal(f.calls[1].init.headers.authorization, "Bearer ek_test");
  assert.equal(f.calls[1].init.headers["content-type"], "application/sdp");
  assert.equal(f.calls[1].init.body, "v=0\r\no=offer");
  const pc = PC.made[0];
  assert.equal(pc.tracks[0], mic.t[0]);
  assert.equal(pc.dc.label, DATA_CHANNEL);
  assert.deepEqual(pc.remote, { type: "answer", sdp: "v=0\r\no=answer" });
  assert.equal(call.endsAt, 1_000 + 180_000);
  /* Events both ways once the channel opens. */
  assert.equal(call.send({ type: "x" }), false, "nothing is sent before the channel opens");
  pc.dc.readyState = "open";
  pc.dc.onopen();
  assert.equal(opened, 1);
  assert.equal(call.send({ type: "response.create" }), true);
  assert.deepEqual(pc.dc.sent, [{ type: "response.create" }]);
  pc.dc.onmessage({ data: JSON.stringify({ type: "session.created" }) });
  pc.dc.onmessage({ data: "not json" });
  assert.deepEqual(events, [{ type: "session.created" }]);
  /* Hang up: everything closes, once. */
  call.stop("user");
  call.stop("user");
  assert.equal(pc.closed, true);
  assert.equal(mic.t[0].stopped, true);
  assert.deepEqual(ends, [{ reason: "user", message: null }]);
  assert.equal(call.send({ type: "x" }), false);
});

test("O3) it hangs up by itself at the server's time limit (clamped by the client too) and when the connection fails", async () => {
  for (const [given, want] of [[180, 180], [9_999, 300], [undefined, 180]]) {
    const t = timers();
    const ends = [];
    const call = openVoiceCall({
      fetchImpl: fetchSeq([{ status: 200, body: { value: "ek_t", maxSeconds: given } }, { status: 201, body: "v=0" }]),
      PeerConnection: fakePC(), AudioCtx: null, makeAudio: () => null, mediaDevices: { getUserMedia: async () => new FakeStream() },
      onEnd: (e) => ends.push(e), ...t,
    });
    await call.start();
    const max = t.list.find((x) => x.on && x.ms === want * 1000);
    assert.ok(max, `a ${want}s hang-up timer for maxSeconds=${given}`);
    max.fn();
    assert.equal(ends[0].reason, "timeout");
  }
  const PC = fakePC();
  const ends = [];
  const call = openVoiceCall({
    fetchImpl: fetchSeq([{ status: 200, body: { value: "ek_t" } }, { status: 201, body: "v=0" }]),
    PeerConnection: PC, AudioCtx: null, makeAudio: () => null, mediaDevices: { getUserMedia: async () => new FakeStream() },
    onEnd: (e) => ends.push(e), ...timers(),
  });
  await call.start();
  PC.made[0].connectionState = "failed";
  PC.made[0].onconnectionstatechange();
  assert.equal(ends[0].reason, "dropped");
});

test("O4) our server says no (budget) → a clear line, the mic is released, no WebRTC; tapping again mid-connect cancels", async () => {
  const mic = new FakeStream();
  const PC = fakePC();
  const ends = [];
  const call = openVoiceCall({
    fetchImpl: fetchSeq([{ status: 429, body: { message: "That's 6 voice calls this hour. Type, or try again later." } }]),
    PeerConnection: PC, AudioCtx: null, makeAudio: () => null, mediaDevices: { getUserMedia: async () => mic },
    onEnd: (e) => ends.push(e), ...timers(),
  });
  assert.equal(await call.start(), false);
  assert.equal(ends[0].reason, "session");
  assert.match(ends[0].message, /6 voice calls this hour/);
  assert.equal(mic.t[0].stopped, true);
  assert.equal(PC.made.length, 0);
  /* Cancelled while the mic prompt is open: no secret is asked for. */
  let release;
  const slowMic = new FakeStream();
  const f = fetchSeq([]);
  const c2 = openVoiceCall({
    fetchImpl: f, PeerConnection: fakePC(), AudioCtx: null, makeAudio: () => null,
    mediaDevices: { getUserMedia: () => new Promise((r) => { release = () => r(slowMic); }) }, ...timers(),
  });
  const p = c2.start();
  await tick();
  c2.stop("user");
  release();
  assert.equal(await p, false);
  assert.equal(f.calls.length, 0);
  assert.equal(slowMic.t[0].stopped, true);
});

test("S13) never a dead end, as typing: a spoken answer in words gets the asset boxes once; after a trade card, none", async () => {
  const asked = [];
  const boxes = ({ focus }) => { asked.push(focus); return { kind: "assets", items: [{ coin: "USDC", kind: "earn", title: "Aave USDC", figure: "5.78% APY", sub: "Avalanche", tone: "pos", actions: [{ id: "stake", label: "Stake" }] }] }; };
  const r = rig({ boxes });
  say(r, "i1", "how is eth");
  r.convo.handle(callResponse("r1", [["c1", "get_market", { coin: "eth" }]]));
  await tick();
  r.convo.handle({ type: "response.output_audio_transcript.done", response_id: "r2", transcript: "ETH is about 2,450 dollars." });
  r.convo.handle({ type: "response.done", response: { id: "r2", status: "completed", output: [] } });
  const kinds = r.chat.get().messages.filter((m) => m.role === "card").map((m) => m.card.kind);
  assert.deepEqual(kinds, ["assets"]);
  assert.deepEqual(asked, [["ETH"]], "the market the answer was about comes first");
  /* Once per turn. */
  r.convo.handle({ type: "response.output_audio_transcript.done", response_id: "r3", transcript: "Anything else?" });
  r.convo.handle({ type: "response.done", response: { id: "r3", status: "completed", output: [] } });
  assert.equal(r.chat.get().messages.filter((m) => m.role === "card").length, 1);
  /* A turn that showed a trade card leaves the user's move to that card: no boxes. */
  const t = rig({ boxes });
  say(t, "i1", "long eth 10 3x");
  t.convo.handle(callResponse("r1", [["c1", "propose_open", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 }]]));
  await tick();
  t.convo.handle({ type: "response.output_audio_transcript.done", response_id: "r2", transcript: "Check the card and tap Confirm." });
  t.convo.handle({ type: "response.done", response: { id: "r2", status: "completed", output: [] } });
  assert.deepEqual(t.chat.get().messages.filter((m) => m.role === "card").map((m) => m.card.kind), ["open"]);
  /* A boxes reader that throws costs nothing. */
  const x = rig({ boxes: () => { throw new Error("no state"); } });
  x.convo.handle({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "Hi." });
  x.convo.handle({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
  assert.equal(x.chat.get().messages.filter((m) => m.role === "card").length, 0);
});

test("S14) never silent: a sentence said with pauses, reads done while the user still talks, an empty answer → asked once more, then written", async () => {
  const r = rig();
  say(r, "i1", "อยาก อยากเปิดลอง Nvidia");
  r.convo.handle({ type: "response.created", response: { id: "r1" } });
  r.convo.handle(callResponse("r1", [["c1", "get_market", { coin: "NVDA" }], ["c2", "get_account", {}]]));
  r.convo.handle({ type: "input_audio_buffer.speech_started", item_id: "i2" });
  await tick();
  assert.equal(outputs(r.sent).length, 2);
  assert.equal(creates(r.sent).length, 0, "the user is still talking: their own response answers");
  r.convo.handle({ type: "input_audio_buffer.committed", item_id: "i2" });
  r.convo.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "i2", transcript: "เปิดเท่าไหร่ดี" });
  r.convo.handle({ type: "response.created", response: { id: "r2" } });
  r.convo.handle({ type: "response.done", response: { id: "r2", status: "completed", output: [] } });
  assert.deepEqual(creates(r.sent), [{ type: "response.create", response: { tool_choice: "none" } }], "asked once more, in words");
  r.convo.handle({ type: "response.created", response: { id: "r3" } });
  r.convo.handle({ type: "response.done", response: { id: "r3", status: "completed", output: [] } });
  const last = r.chat.get().messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.match(last.text, /type it/);
  assert.equal(creates(r.sent).length, 1, "never a loop");
});

test("S15) spoken like typed: a market + an opening word is the app's setups card at once; the model says it, and its own card is refused", async () => {
  const tools = [];
  const r = rig({
    intentOf: (w) => (/Nvidia/.test(w) ? { name: "propose_setups", args: { coin: "xyz:NVDA" } } : null),
    runToolCall: async (name, args) => {
      tools.push(name);
      if (name === "propose_setups") return { result: { shown: true }, card: { kind: "setups", coin: "xyz:NVDA", setups: [] } };
      return { result: { ok: true } };
    },
  });
  say(r, "i1", "อยาก อยากเปิดลอง Nvidia อยากตั้ง position TPSL ให้เหมาะสมอะ เปิดเท่าไหร่ดี");
  await tick();
  const cards = r.chat.get().messages.filter((m) => m.role === "card");
  assert.deepEqual(cards.map((m) => [m.card.kind, m.card.status]), [["setups", "review"]]);
  assert.ok(r.sent.some((e) => e.type === "conversation.item.create" && e.item.role === "system" && /setups for NVDA/.test(e.item.content[0].text)));
  assert.deepEqual(creates(r.sent), [{ type: "response.create", response: { tool_choice: "none" } }]);
  r.convo.handle(callResponse("r1", [["c1", "propose_setups", { coin: "NVDA" }]]));
  await tick();
  assert.match(JSON.parse(outputs(r.sent)[0].item.output).error, /already on screen/);
  assert.equal(r.chat.get().messages.filter((m) => m.role === "card").length, 1);
});
