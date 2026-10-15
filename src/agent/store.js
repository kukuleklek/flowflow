// The Agent's conversation: ONE PER ACCOUNT, kept on this device. Owner, 2026-10-15: "อย่าลืมนะ Chat Agent อะ
// 1 Account 1 Agent นะ ข้อมูลอยู่บน Local เขาพอ". Shared by the trade page's Chat tab and the /agent page (SPEC §1.4).
//
// Kept in localStorage, one key per account: the signed-in wallet's address (lower case), "mock" in a mock build,
// "guest" when signed out. WalletContext tells the store whose screen it is (chat.setAccount) whenever the wallet
// changes, and the store remembers the last account so the first paint, before the wallet has answered, shows that
// account's chat. Switching loads the other account's conversation: one account's messages and model history are
// never shown to, or sent on behalf of, another.
//
// Two lists per account: `messages` is what the screen shows (text, status lines, cards); `llm` is what the model
// sees (OpenAI-format user / assistant / tool messages), cut to the window api/chat.js reads (tools.js windowHistory).
// Each conversation has an id (`cid`); "New chat" starts a new one, and a loop still running for the old one can
// neither show nor write anything in the new one (chat.conversation(), pushLlmTo).
//
// 🔴 STORAGE IS THE TRUTH, AND EVERY CHANGE IS MADE ON ITS FRESHEST COPY. Two tabs of one account share one
// conversation. Each change (a message, a card's status, the model's history) reads the stored conversation, changes
// that, and writes it back; a tab never writes back its own older copy of the whole. So a card another tab filled
// stays filled: a tab that was busy meanwhile cannot put it back to "review" (a second order on mainnet).
//
// 🔴 A CARD IS CONFIRMED ONCE. patchCard(id, { status: "sending" }) is the claim: it goes through only while the
// stored card is still "review", and otherwise THROWS (CardTakenError), which stops the card's confirm before its
// order is sent. A settled card ("filled" / "cancelled") never changes again. A card being sent from another tab, or
// one that was being sent when its page went away ("unknown": not resumable), is shown as a line of text instead of
// a card, so no Confirm button is offered for it; once it settles, it comes back as the settled card. (TradeCard.jsx
// reads a card's status only when it mounts; this is what keeps a stale copy from offering Confirm.)
//
// Storage that refuses (private mode, quota, blocked site data) is not an error: the conversations then live in
// this tab's memory only. No import.meta, no Privy, no React beyond the hook: the Node suite drives it directly.
import { useSyncExternalStore } from "react";
import { HISTORY_MAX, windowHistory } from "./tools.js";

/** One conversation per account: CHAT_PREFIX + account key. */
export const CHAT_PREFIX = "flowflow.agent.chat.v3:";
/** The account whose conversation was on screen last, for the first paint. */
export const LAST_ACCOUNT_KEY = "flowflow.agent.account.v1";
/** The old per-tab conversation (sessionStorage), moved once into the first real account that signs in here. */
export const OLD_TAB_KEY = "flowflow.agent.chat.v2";

const MAX = 60;
const ADDR = /^0x[0-9a-f]{40}$/;
/** The id of a conversation saved before conversations had ids. */
const FIRST_CID = "c0";
/** A card's settled states: nothing changes them again. */
const SETTLED = new Set(["filled", "cancelled"]);

/** "0xabc…" (lower case), "mock" or "guest"; anything else is "guest". */
export function normalizeAccount(key) {
  const k = typeof key === "string" ? key.trim().toLowerCase() : "";
  return k === "mock" || k === "guest" || ADDR.test(k) ? k : "guest";
}

/**
 * Whose conversation the screen shows: the wallet's address, "mock" in a mock build, "guest" when signed out, or
 * null while a sign-in is still arriving (keep what is on screen until it has answered).
 * @param {{ mock?: boolean, address?: string|null, pending?: string|null }} o
 */
export function agentAccountKey({ mock = false, address = null, pending = null } = {}) {
  if (mock) return "mock";
  if (typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)) return address.toLowerCase();
  if (pending) return null;
  return "guest";
}

/** Thrown by patchCard when a card that is not up for review is claimed for sending: its order must not go out. */
export class CardTakenError extends Error {
  constructor(status) {
    super(status == null
      ? "This card is no longer in the chat, so nothing was sent."
      : `This card is already ${status === "review" ? "under review" : status}, so nothing was sent again.`);
    this.name = "CardTakenError";
    this.status = status;
  }
}

const EMPTY = Object.freeze({ cid: FIRST_CID, messages: Object.freeze([]), llm: Object.freeze([]) });

/** The model's window: never split mid-step, never emptied while a question is in it. */
const trimLlm = (list) => windowHistory(list, HISTORY_MAX);

const statusOf = (card) => (card && typeof card.status === "string" ? card.status : "review");

function parseConv(raw) {
  let j = null;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || !Array.isArray(j.messages)) return null;
  const ok = (m) => m && typeof m === "object" && typeof m.role === "string";
  return {
    cid: typeof j.cid === "string" && j.cid ? j.cid.slice(0, 40) : FIRST_CID,
    messages: j.messages.filter(ok).slice(-MAX),
    llm: Array.isArray(j.llm) ? trimLlm(j.llm.filter(ok)) : [],
  };
}

/* What a card is called in the line shown in its place. */
function cardName(card) {
  const coin = card && typeof card.coin === "string" ? card.coin : "this market's";
  if (card && card.kind === "close") return `close ${coin} card`;
  if (card && card.kind === "tpsl") return `TP / SL card for ${coin}`;
  return `${card && card.side === "sell" ? "short" : "long"} ${coin} card`;
}

const globalStorage = (name) => {
  try { return globalThis[name] || null; } catch { return null; }
};

/**
 * A chat store over the given storage. The app has one (`chat`, below); the tests make their own.
 *   storage     per-device storage (default localStorage; null: memory only)
 *   tabStorage  where the old per-tab conversation lived (default sessionStorage; null: none)
 *   listen      follow other tabs' writes to the same account's conversation
 */
export function createChatStore({ storage, tabStorage, listen = false } = {}) {
  const ls = () => (storage !== undefined ? storage : globalStorage("localStorage"));
  const ss = () => (tabStorage !== undefined ? tabStorage : globalStorage("sessionStorage"));
  const subs = new Set();
  /* What this tab knows of every account it has shown. The only copy when storage refuses a write. */
  const mem = new Map();
  /* The stored text each copy in `mem` was read from or written as: an unchanged text is the same copy. */
  const rawOf = new Map();
  const unsaved = new Set();
  /* Cards this tab claimed for sending: they stay cards here whatever their status, since this tab's own card is
     the one placing the order. */
  const claimed = new Set();
  /* Messages that were mid-way (a card being sent, a step running) when their conversation came on screen in this
     tab: the page that was doing it may be gone, so here a card reads as "unknown" and a step as done. */
  const atLoad = new Set();
  let migrated = false;
  /* The conversation the last patched card lives in, for the note about it that follows in the same turn. */
  let noteTo = null;
  /* Message ids unique across tabs: two tabs of one account write into one conversation. */
  const tag = Math.random().toString(36).slice(2, 6);
  let seq = Date.now();
  const id = () => `m${tag}${(seq++).toString(36)}`;

  function readConv(key) {
    let c = null;
    if (!unsaved.has(key)) {
      const st = ls();
      if (st) {
        try {
          const raw = st.getItem(CHAT_PREFIX + key);
          if (raw != null && raw === rawOf.get(key) && mem.has(key)) c = mem.get(key);
          else if (raw != null) {
            c = parseConv(raw);
            if (c) rawOf.set(key, raw);
          }
        } catch { c = null; }
      }
    }
    if (!c && mem.has(key)) c = mem.get(key);
    if (!c) c = EMPTY;
    mem.set(key, c);
    return c;
  }

  function writeConv(key, conv) {
    mem.set(key, conv);
    const st = ls();
    if (!st) { unsaved.add(key); return; }
    try {
      const raw = JSON.stringify({ v: 3, cid: conv.cid, messages: conv.messages, llm: conv.llm });
      st.setItem(CHAT_PREFIX + key, raw);
      rawOf.set(key, raw);
      unsaved.delete(key);
    } catch {
      unsaved.add(key); /* storage refused: this tab's memory holds it */
    }
  }

  /* A conversation coming on screen: note what was mid-way in it then. */
  function load(key) {
    const c = readConv(key);
    for (const m of c.messages) {
      if ((m.role === "status" && m.state === "running") || (m.card && statusOf(m.card) === "sending")) atLoad.add(m.id);
    }
    return c;
  }

  function readLastAccount() {
    const st = ls();
    if (!st) return "guest";
    try { return normalizeAccount(st.getItem(LAST_ACCOUNT_KEY)); } catch { return "guest"; }
  }

  function remember(key) {
    const st = ls();
    if (!st) return;
    try { st.setItem(LAST_ACCOUNT_KEY, key); } catch { /* storage refused */ }
  }

  /* The screen's copy of the messages. A card nobody here can act on is a line of text, not a card with a Confirm. */
  function view(messages) {
    return messages.map((m) => {
      if (m.role === "status" && m.state === "running" && atLoad.has(m.id)) return { ...m, state: "done" };
      if (m.role !== "card" || !m.card || claimed.has(m.id)) return m;
      const s = statusOf(m.card);
      if (s === "sending" && !atLoad.has(m.id)) {
        return { ...m, role: "assistant", notice: true, text: `The ${cardName(m.card)} is being sent. Its result shows here once it answers.` };
      }
      if (s === "sending" || s === "unknown") {
        return {
          ...m, role: "assistant", notice: true, card: { ...m.card, status: "unknown" },
          text: `The ${cardName(m.card)} was being sent from another tab or a page that has since closed, so whether it went through isn't known here. Check your positions before you trade again.`,
        };
      }
      return m;
    });
  }

  let state = null;
  let snap = null;
  function show(next) {
    state = { ...state, ...next };
    snap = Object.freeze({ ...state, messages: view(state.messages) });
  }

  function notify() {
    for (const f of [...subs]) { try { f(); } catch { /* a reader never breaks the store */ } }
  }

  const first = readLastAccount();
  show({ account: first, ...load(first), busy: false });

  /* Change one account's conversation on its freshest copy and save it. fn returns the conversation unchanged for
     "nothing to do", and then nothing is written. */
  function mutate(key, fn) {
    const cur = readConv(key);
    const next = fn(cur);
    if (!next || next === cur) {
      /* Nothing to write, but the screen catches up with what another tab wrote meanwhile. */
      if (key === state.account && (cur.messages !== state.messages || cur.llm !== state.llm || cur.cid !== state.cid)) {
        show(cur);
        notify();
      }
      return false;
    }
    const conv = { cid: next.cid || cur.cid, messages: next.messages.slice(-MAX), llm: trimLlm(next.llm) };
    writeConv(key, conv);
    if (key === state.account) { show(conv); notify(); }
    return true;
  }

  /* The old per-tab conversation, once, into the first real account shown in this tab, if that account has none
     of its own. Never into "guest": a tab's old chat belonged to whoever was signed in there. */
  function migrate() {
    migrated = true;
    const st = ss();
    if (!st) return;
    let raw = null;
    try { raw = st.getItem(OLD_TAB_KEY); } catch { return; }
    if (raw == null) return;
    try { st.removeItem(OLD_TAB_KEY); } catch { /* the flag above still makes it once in this tab */ }
    const c = parseConv(raw);
    if (!c || (!c.messages.length && !c.llm.length)) return;
    mutate(state.account, (cur) => {
      if (cur.messages.length || cur.llm.length) return cur;
      for (const m of c.messages) {
        if ((m.role === "status" && m.state === "running") || (m.card && statusOf(m.card) === "sending")) atLoad.add(m.id);
      }
      return { ...cur, messages: c.messages, llm: c.llm };
    });
  }

  /* Change one message wherever it lives: on screen, or in another account's conversation this tab has shown
     (a card whose order was still out when the account switched). Returns the account it was found in. */
  function patchMessage(mid, fn) {
    for (const key of [state.account, ...[...mem.keys()].filter((k) => k !== state.account)]) {
      let found = false;
      mutate(key, (c) => {
        const i = c.messages.findIndex((m) => m.id === mid);
        if (i < 0) return c;
        found = true;
        const next = fn(c.messages[i]);
        if (next === c.messages[i]) return c;
        const messages = c.messages.slice();
        messages[i] = next;
        return { ...c, messages };
      });
      if (found) return key;
    }
    return null;
  }

  /* The model's history carries the market page a message came from too (item 21: a market's Chat tab sends the model
     only that market's own history; agent.js filters by it). The server drops the field (api/chat.js shapeMessages). */
  function appendLlm(key, msgs, cid = null) {
    const tagged = scope ? msgs.map((m) => (m && typeof m === "object" && m.scope === undefined ? { ...m, scope } : m)) : msgs;
    mutate(key, (c) => (cid != null && c.cid !== cid ? c : { ...c, llm: [...c.llm, ...tagged] }));
  }

  if (listen && typeof globalThis.addEventListener === "function") {
    /* Another tab of the same account wrote its conversation: show it here too, busy or not. This tab's own next
       change is made on that copy (mutate), so nothing the other tab wrote is lost or undone. */
    try {
      globalThis.addEventListener("storage", (e) => {
        if (!e || (e.key != null && e.key !== CHAT_PREFIX + state.account)) return;
        show(readConv(state.account));
        notify();
      });
    } catch { /* no events: each tab reads the stored copy at its next change */ }
  }

  let scope = null;
  return {
    get: () => snap,
    /** The account whose conversation is on screen. */
    account: () => state.account,
    /** The conversation on screen ("account#cid"): a loop belongs to one, and stops when it is no longer shown. */
    conversation: () => `${state.account}#${state.cid}`,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    /** Show this account's conversation: loads that one, never mixes the two. */
    setAccount(key) {
      const k = normalizeAccount(key);
      const before = snap;
      if (k !== state.account) show({ account: k, ...load(k), busy: false });
      if (!migrated && k !== "guest") migrate();
      remember(k);
      if (snap !== before) notify();
    },
    /** The market page a send comes from ("BTC", "xyz:TSLA"), or null for the Agent page: every message pushed while
     *  it is set carries it, so a market's Chat tab shows only that market's own history (owner: "แชท รายเหรียญก็ควรมีแต่
     *  ประวัติของเหรียญนั้น"). The Agent page shows everything. */
    setScope(s) { scope = typeof s === "string" && s ? s : null; },
    push(msg) {
      const m = { id: id(), at: Date.now(), ...(scope && msg && msg.scope === undefined ? { scope } : {}), ...msg };
      mutate(state.account, (c) => ({ ...c, messages: [...c.messages, m] }));
      return m.id;
    },
    patch(mid, p) {
      patchMessage(mid, (m) => ({ ...m, ...p }));
    },
    /**
     * Change a card. { status: "sending" } claims it for sending: only a card still up for review can be claimed;
     * otherwise this THROWS CardTakenError and the caller's order must not go out. A settled card never changes, and
     * a cancel only lands on a card still up for review. The note that follows (noteLlm) goes with the card's own
     * account, or nowhere when the card is gone or the change did not land.
     */
    patchCard(mid, cardPatch) {
      const p = cardPatch && typeof cardPatch === "object" ? cardPatch : {};
      const to = typeof p.status === "string" ? p.status : null;
      const claim = to === "sending";
      /* Claimed before the write, so this tab's own card stays a card while it sends. */
      if (claim) claimed.add(mid);
      let refused = null;
      const where = patchMessage(mid, (m) => {
        if (!m.card) return m;
        const from = statusOf(m.card);
        if ((claim || to === "cancelled") && from !== "review") { refused = from; return m; }
        if (to && SETTLED.has(from)) { refused = from; return m; }
        return { ...m, card: { ...m.card, ...p } };
      });
      const mine = { key: where && !refused ? where : null };
      noteTo = mine;
      Promise.resolve().then(() => { if (noteTo === mine) noteTo = null; });
      if (claim && (!where || refused)) {
        /* A second copy of the card (one mounted again while its order is out) has a stale Confirm: the card turns
           into a line until it settles, then comes back as the settled card. */
        claimed.delete(mid);
        show({});
        notify();
        throw new CardTakenError(where ? refused : null);
      }
    },
    /** Append to what the model sees. */
    pushLlm(...msgs) { appendLlm(state.account, msgs); },
    /** Append to what one conversation's model sees, on screen or not: `target` is chat.conversation() (dropped if
     *  that conversation was replaced by a new chat since), or an account key (its current conversation). */
    pushLlmTo(target, ...msgs) {
      const t = typeof target === "string" ? target : "";
      const at = t.indexOf("#");
      if (at < 0) { appendLlm(normalizeAccount(t), msgs); return; }
      appendLlm(normalizeAccount(t.slice(0, at)), msgs, t.slice(at + 1));
    },
    /** Tell the model what happened on a card (it never sees the click itself). */
    noteLlm(text) {
      const to = noteTo;
      noteTo = null;
      if (to && to.key == null) return; /* its card is gone, or the change did not land: say nothing */
      appendLlm(to ? to.key : state.account, [{ role: "user", content: `[FlowFlow app] ${text}` }]);
    },
    setBusy(busy) {
      if (state.busy === !!busy) return;
      show({ busy: !!busy });
      notify();
    },
    /** New chat: a new conversation for this account. `busy` stays as it is: a loop still running for the old one
     *  stops on its own (it no longer owns the screen) and gives `busy` back when it ends. */
    clear() {
      const cid = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      mutate(state.account, () => ({ cid, messages: [], llm: [] }));
    },
  };
}

export const chat = createChatStore({ listen: true });

export function useChat() {
  return useSyncExternalStore(chat.subscribe, chat.get, chat.get);
}
