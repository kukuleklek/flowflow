// Voice Mode, the call itself (OpenAI's Realtime WebRTC guide): the browser asks /api/realtime-session for a
// short-lived client secret, opens the microphone, and connects straight to OpenAI with an SDP offer:
//   mic track ─▶ RTCPeerConnection ─▶ the model's voice on an <audio>;  data channel "oai-events" carries JSON events.
// The session (model, prompt, tools, voice, VAD, transcription) was set on the server; nothing here changes it.
//
// Two parts, both testable without a browser (everything they touch is passed in):
//   openVoiceCall()            the transport: mic, peer connection, data channel, level meters, hang-up
//   createVoiceConversation()  the events: transcripts into the chat, tool calls run by agent.js runToolCall (the
//                              same tools and guardrails as typing), their results back to the model
//
// 🔴 VOICE NEVER CONFIRMS. A tool call can only read, or put a card in the chat as "review" (voiceTools.voiceCard).
// Nothing here can reach a card's Confirm: this file never patches a card. A spoken "confirm" earns one line telling
// the user to tap Confirm, and the model is told the same (voiceTools.VOICE_STYLE).
//
// IT ALWAYS HANGS UP: on the time limit the server sets (maxSeconds), when the tab is hidden, when the page goes
// (useVoice.js), when the connection fails, and on every error. A hang-up is idempotent.
import { isReadTool, isActionTool } from "../tools.js";
import { chat as appChat } from "../store.js";
import { scrubVenueWords } from "../stockWords.js";
import {
  isVoiceTool, voiceCard, cardLine, confirmNotice, followUp, functionCalls, functionOutput, contextItem, contextNote,
  micErrorText, sessionErrorText, MAX_VOICE_STEPS,
} from "./voiceTools.js";

export const SESSION_URL = "/api/realtime-session";
/** ElevenLabs speech for the model's text answers (api/tts.js), when the session says tts: "elevenlabs". */
export const TTS_URL = "/api/tts";
const TTS_TIMEOUT_MS = 12_000;
export const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const DATA_CHANNEL = "oai-events";
const TOKEN_TIMEOUT_MS = 12_000;
const SDP_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;
/* A peer connection that says "disconnected" may come back; after this long it has not. */
const DISCONNECT_GRACE_MS = 6_000;
/* A transcript that never arrives stops holding the chat's history after this long. */
const TRANSCRIPT_WAIT_MS = 8_000;
/* After a panel-opening tool, the page changes once the model has said so (or after this long). */
const NAV_WAIT_MS = 6_000;
/* After a spoken "confirm", the model has this long to say "tap Confirm" itself before the app says it. */
const NOTICE_WAIT_MS = 5_000;
/* The model's words that already tell the user to tap Confirm. */
const SAYS_TAP = /confirm|ยืนยัน|คอนเฟิร์ม/i;
/* The client clamps the server's limit too. */
const MAX_SECONDS_CEILING = 300;

/* ── The one place tools run ──────────────────────────────────────────────────────────────────────────────────
   agent.js exports runToolCall(name, args, ctx) → { result, card?, navigate? } (shared with the text loop); useVoice.js
   hands its module in (resolveRunToolCall), so this file never imports the loop. Without that export, the same two
   functions the text loop has always called do the work, loaded on first use. */

/** The text loop's own tools, as { result, card?, navigate? }. Never sends anything. */
export async function legacyRunToolCall(name, args, ctx) {
  const { runReadTool, proposeAction } = await import("../runTool.js");
  if (isReadTool(name)) return { result: await runReadTool(name, args, ctx) };
  if (isActionTool(name)) {
    let p;
    try { p = proposeAction(name, args, ctx); } catch (e) { p = { ok: false, error: `That card could not be made: ${String((e && e.message) || e)}` }; }
    if (!p || typeof p !== "object") p = { ok: false, error: "That card could not be made." };
    if (!p.ok) return { result: { error: p.error } };
    let result = { shown: true, note: p.note };
    if (p.fundsShort) {
      try { result = { ...result, funds: await runReadTool("get_funds", {}, ctx) }; } catch { /* the note already says why */ }
    }
    return { result, card: p.card || null, navigate: p.navigate || null };
  }
  return { result: { error: `Unknown tool ${name}.` } };
}

/** agent.js's runToolCall when the module given has it, else the text loop's tools. */
export function resolveRunToolCall(mod = null) {
  return mod && typeof mod.runToolCall === "function" ? mod.runToolCall : legacyRunToolCall;
}

/* fn's answer, or { error } when it throws or takes longer than ms. Never rejects. */
function within(fn, ms, setTimer, clearTimer) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimer(t); resolve(v); } };
    const t = setTimer(() => finish({ error: "That took too long." }), ms);
    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    p.then((v) => finish(v), (e) => finish({ error: String((e && e.message) || e || "Failed.") }));
  });
}

const STATUS = {
  get_markets: "Read markets", get_market: "Read market", get_candles: "Read chart", get_account: "Checked account",
  get_funds: "Checked your money", get_fills: "Read your trades", quote_trade: "Quoted trade", get_unlocks: "Read unlocks",
  get_analysis: "Read charts",
};

/* ── The conversation ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Turns the Realtime server events into the chat, and the model's tool calls into FlowFlow tool runs.
 * @param {object} o
 * @param {(event: object) => boolean} o.send          a client event onto the data channel
 * @param {(name, args, ctx) => Promise<{result, card?, navigate?}>} [o.runToolCall]
 * @param {(extra: object) => object} o.toolCtx         the tool context (snapshot, backend, fetchCandles, …)
 * @param {(to: string) => void} [o.navigate]
 * @param {object} [o.chat]                             the chat store (store.js)
 * @param {string} [o.owner]                            chat.conversation() when the call started
 * @param {(s: "listening"|"thinking"|"speaking") => void} [o.onState]
 * @param {(reason: string) => void} [o.onFatal]        the call must end (quota, expired session)
 * @param {(coin: string) => string|null} [o.coinOf]    the app's name for a market the model named
 * @param {(words: string) => ({ name: string, args: object }|null)} [o.intentOf] the card typing would show for these
 *   words (agent's longTradeIntent → propose_setups): it is shown at once, and the model is told to say it
 */
export function createVoiceConversation({
  send, runToolCall = resolveRunToolCall(), toolCtx = () => ({}), navigate = () => {}, chat = appChat,
  owner = null, onState = () => {}, onFatal = () => {}, coinOf = (c) => (typeof c === "string" && c ? c.toUpperCase() : null),
  readTimeoutMs = READ_TIMEOUT_MS, maxSteps = MAX_VOICE_STEPS, setTimer = setTimeout, clearTimer = clearTimeout,
  boxes = () => null, intentOf = () => null,
} = {}) {
  const convo = owner || chat.conversation();
  let disposed = false;
  const alive = () => !disposed && chat.conversation() === convo;

  let seq = 0;
  const newTurn = () => ({ id: ++seq, run: `voice${Date.now().toString(36)}${seq}`, steps: 0, cards: 0, lines: [], focus: [], boxed: false });
  let turn = newTurn();
  let responseActive = false;
  let speaking = false;
  let pendingNav = null;
  let navTimer = null;
  const handled = new Set();
  /* item_id → { mid, text, timer } for what the user said, shown at once as "…" and filled in by its transcript. */
  const userItems = new Map();
  /* The text Agent's history: an answer waits until the words it answers are in (transcripts can come late). */
  const llmQueue = [];
  /* Transcripts per response, for the history entry. */
  const said = new Map();
  /* The "tap Confirm" line after a spoken confirm: shown only if the model does not say it first (no echo). */
  let noticeTimer = null;
  let toldTapSince = 0;
  let userSeq = 0;
  /* NEVER SILENT. The user is speaking (server VAD), tool work still running, and a spoken answer still owed: tool
     results the model has not answered, or a card the app showed for the user's words. A long sentence said with
     pauses is several turns: the follow-up of the first one's reads was skipped and the next response ended empty, so
     the call fell silent after "Checked 2 things". An owed answer is asked for once more (no tools), then written. */
  let hearing = false;
  let inflight = 0;
  let owed = false;
  let nudged = false;
  let lastWords = "";
  const owe = () => { owed = true; nudged = false; };
  const askAnswer = (o) => { if (!responseActive && !hearing && alive()) send(followUp(o)); };

  const state = (s) => { if (alive()) onState(s); };

  function flushLlm() {
    if (userItems.size || !llmQueue.length || !alive()) return;
    for (const m of llmQueue.splice(0)) chat.pushLlmTo(convo, m);
  }

  function settleUser(itemId, text) {
    const u = userItems.get(itemId);
    if (!u) return;
    userItems.delete(itemId);
    clearTimer(u.timer);
    const words = String(text || "").trim();
    if (alive()) {
      chat.patch(u.mid, { text: words || "(didn't catch that)", pending: false });
      if (words) {
        lastWords = words;
        chat.pushLlmTo(convo, { role: "user", content: words });
        routeLocal(words).catch(() => {});
        /* A spoken confirm with a card waiting: the card stays as it is (voice never confirms), and the user is
           told to tap it, by the model or, if it has not said so within NOTICE_WAIT_MS, by the app. */
        const notice = confirmNotice(words, chat.get().messages);
        if (notice && toldTapSince < u.seq) {
          clearTimer(noticeTimer);
          const since = u.seq;
          noticeTimer = setTimer(() => {
            noticeTimer = null;
            if (alive() && toldTapSince < since) chat.push({ role: "assistant", text: notice, via: "voice", notice: true });
          }, NOTICE_WAIT_MS);
        }
      }
    }
    flushLlm();
  }

  /* As typing: words that name one market and ask to open it get that market's setups card from the app itself (the
     model answered such a sentence with an account summary, or with nothing). The model is told what is on screen and
     says it; its own card for the same words is refused (one card per turn). */
  async function routeLocal(words) {
    let call = null;
    try { call = intentOf(words); } catch { call = null; }
    const mine = turn;
    if (!call || !isVoiceTool(call.name) || !isActionTool(call.name) || mine.cards > 0) return;
    mine.cards++;
    inflight++;
    let out = null;
    try {
      out = await within(() => runToolCall(call.name, call.args || {}, toolCtx({ coin: call.args && call.args.coin })), readTimeoutMs, setTimer, clearTimer);
    } catch { out = null; } finally { inflight--; }
    if (!alive()) return;
    const card = voiceCard(out && out.card);
    if (!card) { mine.cards--; return; }
    chat.push({ role: "card", card });
    const line = cardLine(card);
    mine.lines.push(line);
    send(contextItem(`The app has just shown the user this card for what they said: ${line}. Say in one or two short sentences, in the user's language, what it shows and that they tap a setup to fill a trade card. Do not call a tool for it.`));
    owe();
    askAnswer({ actions: 1 });
  }

  function goNow() {
    clearTimer(navTimer);
    navTimer = null;
    const to = pendingNav;
    pendingNav = null;
    if (to && alive()) { try { navigate(to); } catch { /* the model said where to find it */ } }
  }

  async function runCalls(calls) {
    inflight++;
    try { await runCallsNow(calls); } finally { inflight--; }
  }

  async function runCallsNow(calls) {
    const mine = turn;
    mine.steps++;
    let actions = 0;
    for (const c of calls) {
      if (!alive()) return;
      handled.add(c.call_id);
      let result;
      try {
        if (!isVoiceTool(c.name)) {
          result = { error: `There is no tool called ${c.name}. Voice can only read data and show cards; the user confirms by tapping the card.` };
        } else if (isActionTool(c.name)) {
          if (mine.cards > 0) {
            result = { error: "A card for this request is already on screen. Do not show another: tell the user to check it and tap Confirm on the card." };
          } else {
            const out = await within(() => runToolCall(c.name, c.args, toolCtx({ coin: c.args.coin, navigate: (to) => { pendingNav = to; } })), readTimeoutMs, setTimer, clearTimer);
            if (!alive()) return;
            const card = voiceCard(out && out.card);
            if (card) {
              chat.push({ role: "card", card });
              mine.cards++;
              mine.lines.push(cardLine(card));
            }
            if (out && typeof out.navigate === "string") pendingNav = out.navigate;
            actions++;
            result = out && out.result !== undefined ? out.result : out && out.error ? { error: out.error } : { shown: !!card };
            /* A card the user cannot confirm for lack of money: read where the money is, as the text loop does,
               so the spoken answer can say it. */
            if (card && out && out.fundsShort && alive()) {
              const sid = chat.push({ role: "status", text: STATUS.get_funds, tool: "get_funds", coin: null, run: mine.run, state: "running", via: "voice" });
              const f = await within(() => runToolCall("get_funds", {}, toolCtx({})), readTimeoutMs, setTimer, clearTimer);
              if (!alive()) return;
              const funds = f && f.result !== undefined ? f.result : f;
              chat.patch(sid, { state: !funds || funds.error ? "error" : "done" });
              result = { ...(result && typeof result === "object" ? result : {}), funds };
            }
          }
        } else {
          /* A read (or an info tool that may bring a read-only card): a step in the work block, then on. */
          const fc = coinOf(c.args.coin);
          if (fc && !mine.focus.includes(fc)) mine.focus.push(fc);
          const sid = chat.push({ role: "status", text: STATUS[c.name] || "Read data", tool: c.name, coin: fc, run: mine.run, state: "running", via: "voice" });
          const out = await within(() => runToolCall(c.name, c.args, toolCtx({ coin: c.args.coin })), readTimeoutMs, setTimer, clearTimer);
          if (!alive()) return;
          result = out && out.result !== undefined ? out.result : out && out.error ? { error: out.error } : out || { error: "No result." };
          chat.patch(sid, { state: result && result.error ? "error" : "done" });
          const card = voiceCard(out && out.card);
          if (card) { chat.push({ role: "card", card }); mine.lines.push(cardLine(card)); }
        }
      } catch (e) {
        result = { error: String((e && e.message) || e || "Failed.") };
      }
      send(functionOutput(c.call_id, result));
    }
    if (!alive()) return;
    /* Answer out loud now; while the user is still speaking (a new turn), the response their words make answers it. */
    owe();
    askAnswer({ actions, steps: mine.steps, maxSteps });
  }

  function handle(evt) {
    if (!evt || typeof evt.type !== "string" || !alive()) return;
    switch (evt.type) {
      case "input_audio_buffer.speech_started":
        hearing = true;
        turn = newTurn();
        state("listening");
        return;
      case "input_audio_buffer.speech_stopped":
        hearing = false;
        return;
      case "input_audio_buffer.committed": {
        hearing = false;
        const id = typeof evt.item_id === "string" ? evt.item_id : null;
        if (!id || userItems.has(id)) return;
        const mid = chat.push({ role: "user", text: "…", via: "voice", pending: true });
        const timer = setTimer(() => settleUser(id, ""), TRANSCRIPT_WAIT_MS);
        userItems.set(id, { mid, text: "", timer, seq: ++userSeq });
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const u = userItems.get(evt.item_id);
        if (!u || typeof evt.delta !== "string") return;
        u.text += evt.delta;
        chat.patch(u.mid, { text: u.text.trim() || "…" });
        return;
      }
      case "conversation.item.input_audio_transcription.completed":
        settleUser(evt.item_id, typeof evt.transcript === "string" ? evt.transcript : "");
        return;
      case "conversation.item.input_audio_transcription.failed":
        settleUser(evt.item_id, "");
        return;
      case "response.created":
        responseActive = true;
        if (!speaking) state("thinking");
        return;
      case "response.output_audio_transcript.done":
      case "response.output_text.done": {
        const text = String(evt.transcript || evt.text || "").trim();
        if (!text) return;
        /* What the user reads of the spoken answer never names the venue a stock trades on (the prompt forbids it;
           this is the line's own guard). The model's history below keeps what it said. */
        const shown = scrubVenueWords(text, { fallback: "" });
        if (shown) chat.push({ role: "assistant", text: shown, via: "voice" });
        if (SAYS_TAP.test(text)) {
          toldTapSince = userSeq;
          if (noticeTimer) { clearTimer(noticeTimer); noticeTimer = null; }
        }
        const rid = evt.response_id || "?";
        said.set(rid, [...(said.get(rid) || []), text]);
        return;
      }
      case "output_audio_buffer.started":
        speaking = true;
        state("speaking");
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        speaking = false;
        state(responseActive ? "thinking" : "listening");
        if (pendingNav) goNow();
        return;
      case "response.done": {
        responseActive = false;
        const r = evt.response || {};
        const rid = r.id || "?";
        const words = said.get(rid) || [];
        said.delete(rid);
        if (r.status === "failed") {
          const err = (r.status_details && r.status_details.error) || {};
          if (err.code === "insufficient_quota") { onFatal("quota"); return; }
          chat.push({ role: "assistant", text: "I couldn't answer that. Say it again, or type it.", tone: "error", via: "voice" });
        }
        const calls = r.status === "completed" || r.status == null
          ? functionCalls(r).filter((c) => !handled.has(c.call_id))
          : [];
        if (words.length) owed = false;
        else if (!calls.length && owed && r.status !== "failed" && !hearing && !inflight) {
          if (!nudged) {
            nudged = true;
            send(followUp({ actions: 1 }));
          } else {
            owed = false;
            const line = turn.lines.length ? turn.lines.join(" ") : "I read that but couldn't answer out loud. Say it again, or type it.";
            chat.push({ role: "assistant", text: line, via: "voice", ...(turn.lines.length ? {} : { tone: "error" }) });
          }
        }
        if (words.length || (!calls.length && turn.lines.length)) {
          const content = [...words, ...(calls.length ? [] : turn.lines.splice(0))].join(" ").trim();
          if (content) { llmQueue.push({ role: "assistant", content }); flushLlm(); }
        }
        /* While the words said before the tool call are still playing, the button keeps showing speech. */
        if (calls.length) { if (!speaking) state("thinking"); runCalls(calls).catch(() => {}); return; }
        /* Never a dead end (as typing): a spoken answer that ends in words, with no card for the user's move, gets the
           asset boxes under it, once per turn. Boxes only say words or open pages; nothing moves money. */
        if (words.length && r.status !== "failed" && turn.cards === 0 && !turn.boxed) {
          turn.boxed = true;
          let card = null;
          try { card = boxes({ focus: [...turn.focus], words: lastWords }); } catch { card = null; }
          if (card && alive()) chat.push({ role: "card", card });
        }
        if (!speaking) state("listening");
        /* A panel to open and nothing being said: open it now. */
        if (pendingNav && !speaking) {
          clearTimer(navTimer);
          navTimer = setTimer(goNow, NAV_WAIT_MS);
        }
        return;
      }
      case "error": {
        const e = evt.error || {};
        const code = String(e.code || e.type || "");
        if (code === "insufficient_quota") onFatal("quota");
        else if (code === "session_expired") onFatal("expired");
        /* Others (a response.create racing a new turn, a cancel with nothing to cancel) are harmless. */
        return;
      }
      default:
    }
  }

  return {
    handle,
    /** Tell the model where the user is and what was just said in the chat. */
    begin({ coin = null } = {}) {
      if (!alive()) return;
      const note = contextNote({ coin, messages: chat.get().messages });
      if (note) send(contextItem(note));
      state("listening");
    },
    /** Stop: nothing more lands in the chat; transcripts still missing are closed. */
    dispose() {
      if (disposed) return;
      for (const [id] of userItems) settleUser(id, "");
      flushLlm();
      disposed = true;
      clearTimer(navTimer);
      clearTimer(noticeTimer);
    },
    get alive() { return alive(); },
  };
}

/* ── The transport ─────────────────────────────────────────────────────────────────────────────────────────── */

/* The same meter on an <audio> element (the ElevenLabs answers), routed on to the speakers. null when it can't be. */
function elementMeter(ctx, el) {
  if (!ctx || !el || typeof ctx.createMediaElementSource !== "function") return null;
  try {
    const src = ctx.createMediaElementSource(el);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.5;
    src.connect(an);
    an.connect(ctx.destination);
    const buf = new Uint8Array(an.fftSize);
    return {
      read() {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; s += x * x; }
        return Math.min(1, Math.sqrt(s / buf.length) * 4);
      },
      close() { try { src.disconnect(); an.disconnect(); } catch { /* gone */ } },
    };
  } catch {
    return null;
  }
}

/* A level meter on one audio stream: read() → 0..1, a fast RMS of the waveform. */
function meter(ctx, stream) {
  if (!ctx || !stream) return null;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.5;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    return {
      read() {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; s += x * x; }
        return Math.min(1, Math.sqrt(s / buf.length) * 4);
      },
      close() { try { src.disconnect(); } catch { /* gone */ } },
    };
  } catch {
    return null;
  }
}

/** Whether this browser can make a voice call at all. */
export function voiceSupported(g = globalThis) {
  try {
    return !!(g.navigator && g.navigator.mediaDevices && typeof g.navigator.mediaDevices.getUserMedia === "function" && typeof g.RTCPeerConnection === "function");
  } catch {
    return false;
  }
}

/**
 * Opens one call. start() resolves true once connected; every failure ends the call with onEnd({ reason, message }).
 * reasons: "user" | "timeout" | "hidden" | "unmount" | "account" | "dropped" | "mic" | "session" | "connect" |
 * "unsupported" | "quota" | "expired".
 */
export function openVoiceCall({
  onEvent = () => {}, onOpen = () => {}, onState = () => {}, onEnd = () => {},
  fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null,
  mediaDevices = globalThis.navigator ? globalThis.navigator.mediaDevices : null,
  PeerConnection = globalThis.RTCPeerConnection,
  AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext,
  makeAudio = () => (typeof globalThis.Audio === "function" ? new globalThis.Audio() : null),
  sessionUrl = SESSION_URL, callsUrl = CALLS_URL, ttsUrl = TTS_URL,
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(),
} = {}) {
  let ended = false;
  let pc = null;
  let dc = null;
  let mic = null;
  let audio = null;
  let ctx = null;
  let micMeter = null;
  let outMeter = null;
  let maxTimer = null;
  let dropTimer = null;
  let endsAt = null;
  let maxSeconds = null;
  const aborts = new Set();
  /* ElevenLabs mode: the model answers in text, each answer is fetched as speech (in order, fetched at once) and played
     here. The mic is muted while it plays, so the model never hears its own answer as the user (no echo loop). */
  let ttsMode = false;
  let ttsAudio = null;
  let ttsMeter = null;
  let ttsQueue = [];
  let ttsPlaying = false;
  let ttsGen = 0;
  let unmuteTimer = null;

  function micOn(on) {
    try { if (mic) for (const t of mic.getAudioTracks ? mic.getAudioTracks() : mic.getTracks()) t.enabled = on; } catch { /* fine */ }
  }

  function fetchSpeech(text) {
    return fetchWithin(ttsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }, TTS_TIMEOUT_MS)
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);
  }

  function say(text) {
    if (ended || !ttsAudio || typeof text !== "string" || !text.trim()) return;
    ttsQueue.push(fetchSpeech(text.trim()));
    if (ttsPlaying) return;
    ttsPlaying = true;
    clearTimer(unmuteTimer);
    micOn(false);
    onEvent({ type: "output_audio_buffer.started", via: "tts" });
    pump();
  }

  async function pump() {
    const gen = ttsGen;
    const next = ttsQueue.shift();
    if (!next) {
      ttsPlaying = false;
      /* A short tail before the mic opens again: the room's echo of the last word dies down. */
      unmuteTimer = setTimer(() => { if (!ended && !ttsPlaying) micOn(true); }, 250);
      onEvent({ type: "output_audio_buffer.stopped", via: "tts" });
      return;
    }
    const blob = await next;
    if (ended || gen !== ttsGen) return;
    if (!blob || !ttsAudio || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") { pump(); return; }
    const url = URL.createObjectURL(blob);
    const done = () => { try { URL.revokeObjectURL(url); } catch { /* gone */ } if (!ended && gen === ttsGen) pump(); };
    ttsAudio.onended = done;
    ttsAudio.onerror = done;
    ttsAudio.src = url;
    try { const p = ttsAudio.play && ttsAudio.play(); if (p && p.catch) p.catch(done); } catch { done(); }
  }

  function hush() {
    ttsGen += 1;
    ttsQueue = [];
    try { if (ttsAudio) { ttsAudio.pause && ttsAudio.pause(); ttsAudio.onended = null; ttsAudio.onerror = null; } } catch { /* gone */ }
    if (ttsPlaying) { ttsPlaying = false; micOn(true); }
  }

  function fetchWithin(url, init, ms) {
    const ctrl = new AbortController();
    aborts.add(ctrl);
    const t = setTimer(() => ctrl.abort(), ms);
    return fetchImpl(url, { ...init, signal: ctrl.signal }).finally(() => { clearTimer(t); aborts.delete(ctrl); });
  }

  function stop(reason = "user", message = null) {
    if (ended) return;
    hush();
    clearTimer(unmuteTimer);
    ended = true;
    clearTimer(maxTimer);
    clearTimer(dropTimer);
    for (const c of aborts) { try { c.abort(); } catch { /* done */ } }
    aborts.clear();
    try { if (dc) dc.close(); } catch { /* closed */ }
    try { if (pc) { for (const s of pc.getSenders ? pc.getSenders() : []) { try { if (s.track) s.track.stop(); } catch { /* stopped */ } } pc.close(); } } catch { /* closed */ }
    try { if (mic) for (const t of mic.getTracks()) t.stop(); } catch { /* stopped */ }
    try { if (audio) { audio.pause && audio.pause(); audio.srcObject = null; } } catch { /* gone */ }
    if (micMeter) micMeter.close();
    if (outMeter) outMeter.close();
    if (ttsMeter) ttsMeter.close();
    try { if (ttsAudio) { ttsAudio.pause && ttsAudio.pause(); ttsAudio.removeAttribute && ttsAudio.removeAttribute("src"); } } catch { /* gone */ }
    try { if (ctx && ctx.close) ctx.close(); } catch { /* closed */ }
    pc = null; dc = null; mic = null; audio = null; ctx = null; micMeter = null; outMeter = null; ttsAudio = null; ttsMeter = null;
    onState("idle");
    onEnd({ reason, message });
  }

  function send(evt) {
    if (ended || !dc || dc.readyState !== "open") return false;
    try { dc.send(JSON.stringify(evt)); return true; } catch { return false; }
  }

  async function start() {
    if (ended) return false;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function" || typeof PeerConnection !== "function" || !fetchImpl) {
      stop("unsupported", micErrorText({ name: "unsupported" }));
      return false;
    }
    /* Made inside the tap (Safari only lets audio start from a gesture); resumed once the call is up. */
    try { ctx = AudioCtx ? new AudioCtx() : null; } catch { ctx = null; }
    audio = makeAudio();
    if (audio) { audio.autoplay = true; try { audio.setAttribute && audio.setAttribute("playsinline", ""); } catch { /* fine */ } }
    /* Also made inside the tap: the element that plays the ElevenLabs answers (unused when the model speaks itself). */
    ttsAudio = makeAudio();
    if (ttsAudio) { try { ttsAudio.setAttribute && ttsAudio.setAttribute("playsinline", ""); } catch { /* fine */ } }
    onState("connecting");

    /* 1. The microphone first: a refusal costs nothing. */
    try {
      mic = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      stop("mic", micErrorText(e));
      return false;
    }
    if (ended) { try { for (const t of mic.getTracks()) t.stop(); } catch { /* stopped */ } return false; }

    /* 2. A client secret from our server (it holds the key and sets the session). */
    let token;
    try {
      const r = await fetchWithin(sessionUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, TOKEN_TIMEOUT_MS);
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      if (ended) return false;
      if (!r.ok || !body || typeof body.value !== "string") { stop("session", sessionErrorText(r.status, body)); return false; }
      token = body;
      ttsMode = body.tts === "elevenlabs" && !!ttsAudio;
      if (ttsMode) ttsMeter = elementMeter(ctx, ttsAudio);
    } catch {
      if (!ended) stop("session", "Couldn't reach voice. Check your connection and try again.");
      return false;
    }
    maxSeconds = Math.max(10, Math.min(MAX_SECONDS_CEILING, Number(token.maxSeconds) || 180));
    endsAt = now() + maxSeconds * 1000;
    maxTimer = setTimer(() => stop("timeout"), maxSeconds * 1000);

    /* 3. The peer connection: the model's voice in, the mic out, events both ways. */
    try {
      pc = new PeerConnection();
      pc.ontrack = (e) => {
        const stream = e && e.streams && e.streams[0];
        if (!stream || ended) return;
        if (audio) { audio.srcObject = stream; try { const p = audio.play && audio.play(); if (p && p.catch) p.catch(() => {}); } catch { /* autoplay */ } }
        outMeter = meter(ctx, stream);
      };
      const track = mic.getAudioTracks ? mic.getAudioTracks()[0] : mic.getTracks()[0];
      pc.addTrack(track, mic);
      micMeter = meter(ctx, mic);
      dc = pc.createDataChannel(DATA_CHANNEL);
      dc.onmessage = (e) => {
        let evt = null;
        try { evt = JSON.parse(e.data); } catch { return; }
        if (ended) return;
        onEvent(evt);
        /* ElevenLabs mode: each finished text answer is spoken (the chat already shows it). */
        if (ttsMode && evt && evt.type === "response.output_text.done") say(String(evt.text || ""));
      };
      dc.onopen = () => {
        if (ended) return;
        try { if (ctx && ctx.resume) ctx.resume(); } catch { /* fine */ }
        onState("live");
        onOpen();
      };
      dc.onclose = () => { if (!ended) stop("dropped"); };
      pc.onconnectionstatechange = () => {
        if (ended || !pc) return;
        const s = pc.connectionState;
        if (s === "failed" || s === "closed") stop("dropped");
        else if (s === "disconnected") { clearTimer(dropTimer); dropTimer = setTimer(() => { if (pc && pc.connectionState === "disconnected") stop("dropped"); }, DISCONNECT_GRACE_MS); }
        else if (s === "connected") clearTimer(dropTimer);
      };
      const offer = await pc.createOffer();
      if (ended) return false;
      await pc.setLocalDescription(offer);
      if (ended) return false;
      const r = await fetchWithin(callsUrl, {
        method: "POST",
        body: offer.sdp,
        headers: { authorization: `Bearer ${token.value}`, "content-type": "application/sdp" },
      }, SDP_TIMEOUT_MS);
      const sdp = await r.text();
      if (ended) return false;
      if (!r.ok || !/^v=0/.test(sdp)) { stop("connect", "Couldn't connect the voice call. Try again."); return false; }
      await pc.setRemoteDescription({ type: "answer", sdp });
      return !ended;
    } catch {
      if (!ended) stop("connect", "Couldn't connect the voice call. Try again.");
      return false;
    }
  }

  return {
    start,
    stop,
    send,
    /** Mic and Agent levels, 0..1 each (for the button's meter). */
    levels() {
      if (ended) return { mic: 0, out: 0 };
      let m = 0;
      let o = 0;
      try { m = micMeter ? micMeter.read() : 0; } catch { m = 0; }
      try { o = ttsMode ? (ttsMeter && ttsPlaying ? ttsMeter.read() : 0) : outMeter ? outMeter.read() : 0; } catch { o = 0; }
      return { mic: m, out: o };
    },
    get ended() { return ended; },
    get endsAt() { return endsAt; },
    get maxSeconds() { return maxSeconds; },
  };
}

/** The app's name for a market the model named ("eth" → "ETH", "pepe" → "kPEPE"), or null. resolveCoin is
 *  runTool.js's, handed in by useVoice.js. */
export function coinFromSnapshot(snapshot, resolveCoin) {
  return (name) => {
    try {
      const m = typeof resolveCoin === "function" ? resolveCoin(name, snapshot()) : null;
      return m ? m.coin : null;
    } catch {
      return null;
    }
  };
}
