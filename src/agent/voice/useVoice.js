// Voice Mode in React: one call at a time for the whole app, started by a tap on the mic (VoiceButton.jsx).
//
// The call belongs to the conversation on screen when it started (store.js: one account, one Agent). It hangs up
// when the user taps again, when the server's time limit runs out, when the tab is hidden or the page is left, when
// the component that started it unmounts, and when the account or the chat on screen changes. What the call says
// lands in that conversation only.
//
// The state lives at module level (useVoiceState), so a status strip elsewhere on the page can show it.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useBackend } from "../../perp/BackendContext.jsx";
import { perpMarketsStore, fetchHlCandles } from "../../lib/hyperliquid/index.js";
import { chat } from "../store.js";
import * as agentModule from "../agent.js";
import { resolveCoin, TOOL_FLAGS } from "../runTool.js";
import { assetState, suggestAssets, assetsCard, boxesWanted } from "../suggest.js";
import { longTradeIntent } from "../intents.js";
import { mainMarkets } from "../../trade/marketLists.js";
import { peekEarnApy } from "../earn.js";
import { openVoiceCall, createVoiceConversation, resolveRunToolCall, coinFromSnapshot, voiceSupported } from "./session.js";
import { endText } from "./voiceTools.js";

const IDLE = Object.freeze({ state: "idle", endsAt: null, maxSeconds: null });
const subs = new Set();
let snap = IDLE;
/* The call in progress: { call, convo, unsub, owner }. */
let current = null;

function set(p) {
  const next = Object.freeze({ ...snap, ...p });
  if (next.state === snap.state && next.endsAt === snap.endsAt && next.maxSeconds === snap.maxSeconds) return;
  snap = next;
  for (const f of [...subs]) { try { f(); } catch { /* a reader never breaks the call */ } }
}
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const getSnap = () => snap;

/** { state: "idle"|"connecting"|"listening"|"thinking"|"speaking", endsAt, maxSeconds } */
export function useVoiceState() {
  return useSyncExternalStore(subscribe, getSnap, getSnap);
}

/** The live levels (0..1) of the mic and of the Agent's voice, read every frame by the button's meter. */
export function voiceLevels() {
  return current ? current.call.levels() : { mic: 0, out: 0 };
}

/** Hang up the call in progress, if any. */
export function stopVoice(reason = "user") {
  if (current) current.call.stop(reason);
}

/**
 * @param {{ coin?: string|null }} o the market on screen (told to the model when the call starts)
 */
export function useVoice({ coin = null } = {}) {
  const backend = useBackend();
  const navigate = useNavigate();
  const live = useRef({ backend, coin, navigate });
  live.current = { backend, coin, navigate };
  const started = useRef(null);
  const s = useVoiceState();

  const start = useCallback(() => {
    if (current) return;
    const owner = chat.conversation();
    let convo = null;
    const call = openVoiceCall({
      onEvent: (e) => { if (convo) convo.handle(e); },
      onOpen: () => { if (convo) convo.begin({ coin: live.current.coin }); },
      onState: (st) => {
        if (st === "connecting") set({ state: "connecting" });
        else if (st === "live") set({ state: "listening", endsAt: call.endsAt, maxSeconds: call.maxSeconds });
      },
      onEnd: ({ reason, message }) => {
        if (convo) convo.dispose();
        if (current && current.call === call) { current.unsub(); current = null; }
        const line = message || endText(reason, call.maxSeconds);
        if (line && chat.conversation() === owner) chat.push({ role: "assistant", text: line, via: "voice", ...(message ? { tone: "error" } : {}) });
        set(IDLE);
      },
    });
    const snapshot = () => perpMarketsStore().getSnapshot();
    convo = createVoiceConversation({
      send: (e) => call.send(e),
      runToolCall: resolveRunToolCall(agentModule),
      /* The same context the text loop gives its tools (agent.js toolCtxFrom: the funds reader, the feature flags),
         read fresh for every call. Steps stay quiet: the voice conversation shows one step per read itself. */
      toolCtx: (extra = {}) => Object.assign(
        typeof agentModule.toolCtxFrom === "function"
          ? agentModule.toolCtxFrom({ backend: live.current.backend, getSnapshot: snapshot, step: null })
          : {
            get snapshot() { return snapshot(); },
            backend: live.current.backend,
            fetchCandles: (c, interval, opts) => fetchHlCandles(c, interval, { bars: opts && opts.bars ? opts.bars : 24 }),
            funds: {},
          },
        { coin: live.current.coin, via: "voice" },
        typeof extra.navigate === "function" ? { navigate: extra.navigate } : {},
      ),
      navigate: (to) => live.current.navigate(to),
      owner,
      onState: (st) => { if (snap.state !== "idle" && snap.state !== "connecting") set({ state: st }); },
      onFatal: (reason) => call.stop(reason),
      coinOf: coinFromSnapshot(snapshot, resolveCoin),
      /* Spoken like typed: "อยากเปิดลอง Nvidia … TP SL เท่าไหร่ดี" is NVDA's setups card, from the app (intents.js). */
      intentOf: (words) => {
        const markets = (snapshot() && snapshot().markets) || [];
        const coins = mainMarkets(markets).map((m) => m.coin);
        const it = longTradeIntent(words, { coins, markets, anyLength: true });
        return it ? { name: "propose_setups", args: { coin: it.coin, ...(it.side ? { side: it.side === "buy" ? "long" : "short" } : {}) } } : null;
      },
      /* The asset boxes under a spoken answer that ends in words (the text Agent does the same). */
      boxes: ({ focus = [], words = "" } = {}) => {
        if (!boxesWanted(chat.get().messages, words)) return null;
        const items = suggestAssets(assetState({
          backend: live.current.backend, snapshot: snapshot(), apyPct: peekEarnApy(), earnEnabled: TOOL_FLAGS.earnEnabled, tokenomist: TOOL_FLAGS.tokenomist,
        }), { surface: "after", focus: [...focus, live.current.coin].filter(Boolean) });
        return items.length ? assetsCard(items) : null;
      },
    });
    /* Another account or a New chat on screen: this call's conversation is gone from view, so the call ends. */
    const unsub = chat.subscribe(() => { if (chat.conversation() !== owner) call.stop("account"); });
    current = { call, convo, unsub, owner };
    started.current = call;
    call.start();
  }, []);

  const stop = useCallback((reason = "user") => stopVoice(reason), []);
  const toggle = useCallback(() => { if (current) stopVoice("user"); else start(); }, [start]);

  /* Leaving the page (or this component going away) ends the call it started. */
  useEffect(() => () => {
    if (current && started.current && current.call === started.current) current.call.stop("unmount");
  }, []);

  /* A hidden tab ends the call: nobody is listening, and the clock keeps costing. */
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onHide = () => { if (document.visibilityState === "hidden") stopVoice("hidden"); };
    const onLeave = () => stopVoice("unmount");
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
    };
  }, []);

  return { ...s, active: s.state !== "idle", supported: voiceSupported(), start, stop, toggle };
}
