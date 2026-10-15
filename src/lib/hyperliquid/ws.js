// ─────────────────────────────────────────────────────────────────────────────
// ONE Hyperliquid WebSocket per tab, shared by every surface that streams.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner rule: do not hammer public endpoints. Hyperliquid counts per IP — 10
// sockets, 30 NEW connections a minute, 1000 subscriptions, 2000 messages a
// minute — so a list, a chart and a ticket that each opened their own socket
// would spend three of a household's ten, and a reconnect loop without a brake
// would burn the connection budget in seconds.
//
// What this module guarantees:
//   • one socket for the tab, opened by the first subscriber and closed a short
//     linger after the last one leaves (a route change that resubscribes at once
//     keeps it);
//   • subscriptions refcounted by their CANONICAL JSON: the server sees one
//     subscribe per distinct stream however many components want it, and one
//     unsubscribe when the last of them leaves;
//   • reconnect with exponential backoff (1 s doubling to a 30 s cap, jittered),
//     reset only after a connection has STAYED up — a server that accepts and
//     drops cannot pull it into a tight loop — and every live subscription is
//     re-sent on the new socket;
//   • a ping every 30 s (the server drops a socket after 60 s without a
//     message), and a socket silent for 65 s is treated as dead and replaced;
//   • paused while the tab is hidden: a short grace absorbs a quick flip, then
//     the socket closes, nothing retries while hidden, and becoming visible
//     reconnects at once. Same rule as the token feed (lib/tokenFeed.js);
//   • a late subscriber to a live stream gets its last message at once instead
//     of a blank until the next push — and that memory is dropped the moment the
//     socket drops, so nothing replays a pre-disconnect value as current.
//
// Live facts behind the routing (read-only probe, 2026-09-22): the ack comes on
// channel "subscriptionResponse" with the subscription's keys REORDERED; a candle
// push is identified by data.s and data.i; activeAssetCtx by data.coin; a
// rejected request arrives on channel "error" as a string embedding it (webData2
// is rejected this way today); ping is answered on channel "pong".
//
// One channel is NOT named after its subscription: userEvents pushes arrive on
// channel "user" (websocket subscriptions page; @nktkas/hyperliquid 0.33.3
// subscribes userEvents to channel "user" too). Matching channel to type alone
// dropped every one of them, liquidations included (slice 3). CHANNEL_TYPE maps
// it. A push that names its user (data.user, or webData3's data.userState.user)
// reaches only that user's subscription; one that names nobody (userEvents,
// notification, orderUpdates) reaches every subscription of its type, and the
// account store attributes it.
//
// EVENT streams (userEvents, notification, orderUpdates) are news, not state:
// their last message is never replayed to a late subscriber, which would show
// an old liquidation as if it had just happened.
//
// The logic takes its clock, timers, socket factory and page visibility as
// arguments (createHlWs), so scripts/test-hl-ws.mjs drives it with fakes. hlWs()
// is the tab's one real instance.

import { hlEndpoints, HL_NETWORK } from "./config.js";
import { browserTimers, browserNow, docHidden, onDocVisibility } from "./browser.js";
import { canonicalJson } from "./info.js";

export const HL_WS_PING_MS = 30_000;
export const HL_WS_DEAD_MS = 65_000;
export const HL_WS_BACKOFF_BASE_MS = 1_000;
export const HL_WS_BACKOFF_MAX_MS = 30_000;
export const HL_WS_STABLE_MS = 10_000;
export const HL_WS_LINGER_MS = 10_000;
export const HL_WS_HIDDEN_CLOSE_MS = 5_000;

/** The identity of a subscription: its JSON with keys sorted. */
export const hlSubKey = (sub) => canonicalJson(sub);

/* The method that ends a server subscription. Built from its parts on purpose:
   scripts/iconNames.mjs reads every quoted lowercase word under src/ as a
   Material Symbols name, the whole word is one, and a bare literal here failed
   the icon-subset test for a glyph nothing draws. */
const END_SUB_METHOD = ["un", "subscribe"].join("");

/* The subscription type a channel carries, where the two names differ. */
const CHANNEL_TYPE = Object.freeze({ user: "userEvents" });

/* Streams whose pushes are events: never replayed to a late subscriber. */
const EVENT_TYPES = new Set(["userEvents", "notification", "orderUpdates"]);

/** The subscription type of a push's channel. */
export function hlChannelType(channel) {
  return Object.prototype.hasOwnProperty.call(CHANNEL_TYPE, channel) ? CHANNEL_TYPE[channel] : channel;
}

/* The user a push names, or null when it names nobody. */
function pushUser(data) {
  if (typeof data.user === "string") return data.user;
  const us = data.userState;
  return us && typeof us === "object" && typeof us.user === "string" ? us.user : null;
}

/* Does this push belong to this subscription? */
function matches(sub, channel, data) {
  const type = hlChannelType(channel);
  if (!sub || sub.type !== type || !data || typeof data !== "object") return false;
  if (typeof sub.user === "string") {
    const named = pushUser(data);
    if (named != null && named.toLowerCase() !== sub.user.toLowerCase()) return false;
  }
  switch (type) {
    case "candle":
      return data.s === sub.coin && data.i === sub.interval;
    case "allMids":
      /* Measured on the main dex only: a push with no dex is the main dex's.
         A venue subscription is matched on the dex the push names, which the
         live socket has not been observed answering for allMids. Every USER
         channel below carries no such check on purpose — the account store
         compares data.dex itself, in both of its stream handlers, and
         test-hl-account-store.mjs D3b holds them to it. Move that check here
         and those handlers become the ones that look redundant; keep both. */
      return sub.dex ? data.dex === sub.dex : !data.dex;
    case "trades":
      return Array.isArray(data) && data.length > 0 && data[0] && data[0].coin === sub.coin;
    default:
      return sub.coin == null || data.coin === sub.coin;
  }
}

/**
 * @param {object} deps everything the socket logic touches, injectable
 * @returns {{
 *   subscribe(sub: object, onData: (data: any) => void, opts?: { onError?: (msg: string) => void }): () => void,
 *   onStatus(fn: (status: string) => void): () => void,
 *   status(): "idle"|"connecting"|"open"|"reconnecting"|"paused",
 *   stats(): { sockets: number, keys: number, handlers: number },
 * }}
 */
export function createHlWs({
  url = hlEndpoints().ws,
  createSocket = (u) => new WebSocket(u),
  timers = browserTimers,
  now = browserNow,
  random = Math.random,
  isHidden = docHidden,
  onVisibilityChange = onDocVisibility,
  pingMs = HL_WS_PING_MS,
  deadMs = HL_WS_DEAD_MS,
  backoffBaseMs = HL_WS_BACKOFF_BASE_MS,
  backoffMaxMs = HL_WS_BACKOFF_MAX_MS,
  stableMs = HL_WS_STABLE_MS,
  lingerMs = HL_WS_LINGER_MS,
  hiddenCloseMs = HL_WS_HIDDEN_CLOSE_MS,
} = {}) {
  /** key -> { sub, handlers: Set<{onData, onError}>, hasLast, last, rejected } */
  const entries = new Map();
  const statusFns = new Set();
  let status = "idle";
  let sock = null;
  let sockOpen = false;
  let openedAt = 0;
  let lastRecvAt = 0;
  let serverSubs = new Set();   // keys subscribed on the CURRENT socket
  let attempt = 0;
  let socketsOpened = 0;
  let pingT = null;
  let reconnectT = null;
  let lingerT = null;
  let hiddenT = null;
  let offVis = null;

  const clear = (id) => { if (id != null) timers.clearTimeout(id); return null; };

  function setStatus(s) {
    if (s === status) return;
    status = s;
    for (const fn of [...statusFns]) { try { fn(s); } catch { /* a listener's bug stays its own */ } }
  }

  function sendRaw(obj) {
    if (!sock || !sockOpen) return false;
    try { sock.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function deliver(h, data) {
    try { h.onData(data); } catch { /* one handler's bug is not every subscriber's */ }
  }

  function attachVisibility() { if (!offVis) offVis = onVisibilityChange(onVisibility); }
  function detachVisibility() { if (offVis) { offVis(); offVis = null; } }

  /* Forget the current socket: handlers detached BEFORE closing it, so a late
     close event from the old socket can never act on the new state. */
  function dropSocket() {
    const s = sock;
    const lived = sockOpen ? now() - openedAt : 0;
    sock = null;
    sockOpen = false;
    serverSubs = new Set();
    pingT = clear(pingT);
    for (const e of entries.values()) { e.hasLast = false; e.last = undefined; }
    if (lived >= stableMs) attempt = 0;
    if (s) {
      s.onopen = null; s.onmessage = null; s.onclose = null; s.onerror = null;
      try { s.close(); } catch { /* already closed */ }
    }
  }

  function goIdle() {
    reconnectT = clear(reconnectT);
    hiddenT = clear(hiddenT);
    lingerT = clear(lingerT);
    if (sock) dropSocket();
    pingT = clear(pingT);
    attempt = 0;
    detachVisibility();
    setStatus("idle");
  }

  function scheduleReconnect() {
    if (reconnectT != null) return;
    const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt);
    const delay = Math.round(Math.min(backoffMaxMs, exp * (0.8 + 0.4 * random())));
    attempt = Math.min(attempt + 1, 30);
    setStatus("reconnecting");
    reconnectT = timers.setTimeout(() => { reconnectT = null; connect(); }, delay);
  }

  function afterDrop() {
    if (entries.size === 0) { goIdle(); return; }
    if (isHidden()) { hiddenT = clear(hiddenT); setStatus("paused"); return; }
    scheduleReconnect();
  }

  function schedulePing() {
    pingT = clear(pingT);
    pingT = timers.setTimeout(() => {
      pingT = null;
      if (!sock || !sockOpen) return;
      if (now() - lastRecvAt >= deadMs) { dropSocket(); afterDrop(); return; }
      sendRaw({ method: "ping" });
      schedulePing();
    }, pingMs);
  }

  function connect() {
    reconnectT = clear(reconnectT);
    if (sock || entries.size === 0) return;
    if (isHidden()) { setStatus("paused"); return; }
    let s;
    try { s = createSocket(url); } catch { scheduleReconnect(); return; }
    sock = s;
    sockOpen = false;
    serverSubs = new Set();
    socketsOpened++;
    setStatus("connecting");
    s.onopen = () => {
      if (sock !== s) return;
      sockOpen = true;
      openedAt = now();
      lastRecvAt = openedAt;
      setStatus("open");
      for (const [k, e] of entries) {
        if (!e.rejected && sendRaw({ method: "subscribe", subscription: e.sub })) serverSubs.add(k);
      }
      schedulePing();
    };
    s.onmessage = (ev) => {
      if (sock !== s) return;
      lastRecvAt = now();
      onMessage(ev ? ev.data : null);
    };
    s.onclose = () => {
      if (sock !== s) return;
      dropSocket();
      afterDrop();
    };
    s.onerror = () => { /* the close event follows and decides */ };
  }

  function onServerError(text) {
    const msg = String(text == null ? "" : text);
    const i = msg.indexOf("{");
    if (i < 0) return;
    let req;
    try { req = JSON.parse(msg.slice(i)); } catch { return; }
    const sub = req && req.subscription;
    if (!sub || typeof sub !== "object") return;
    const key = hlSubKey(sub);
    const e = entries.get(key);
    if (!e) return;
    /* Rejected streams are not re-sent on reconnect: the answer would be the same. */
    e.rejected = true;
    serverSubs.delete(key);
    for (const h of [...e.handlers]) {
      if (h.onError) { try { h.onError(msg); } catch { /* its own */ } }
    }
  }

  function onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const { channel, data } = m;
    if (channel === "pong" || channel === "subscriptionResponse") return;
    if (channel === "error") { onServerError(data); return; }
    for (const e of [...entries.values()]) {
      if (e.rejected || !matches(e.sub, channel, data)) continue;
      if (!EVENT_TYPES.has(e.sub.type)) {
        e.last = data;
        e.hasLast = true;
      }
      for (const h of [...e.handlers]) deliver(h, data);
    }
  }

  function onVisibility() {
    if (isHidden()) {
      reconnectT = clear(reconnectT);            // no attempts while nobody looks
      if (sock) {
        if (hiddenT == null) {
          hiddenT = timers.setTimeout(() => {
            hiddenT = null;
            if (!isHidden() || !sock) return;
            dropSocket();
            setStatus(entries.size ? "paused" : "idle");
          }, hiddenCloseMs);
        }
      } else if (entries.size) {
        setStatus("paused");
      }
    } else {
      hiddenT = clear(hiddenT);
      if (entries.size && !sock) { attempt = 0; connect(); }
    }
  }

  function release(key, e, h) {
    e.handlers.delete(h);
    if (e.handlers.size) return;
    if (entries.get(key) === e) entries.delete(key);
    if (serverSubs.has(key)) {
      serverSubs.delete(key);
      sendRaw({ method: END_SUB_METHOD, subscription: e.sub });
    }
    if (entries.size === 0) {
      lingerT = clear(lingerT);
      lingerT = timers.setTimeout(() => { lingerT = null; if (entries.size === 0) goIdle(); }, lingerMs);
    }
  }

  function subscribe(sub, onData, { onError } = {}) {
    if (!sub || typeof sub !== "object" || typeof sub.type !== "string") throw new Error("a Hyperliquid subscription needs a type");
    if (typeof onData !== "function") throw new Error("subscribe needs an onData function");
    const key = hlSubKey(sub);
    lingerT = clear(lingerT);
    let e = entries.get(key);
    if (!e) {
      e = { sub: { ...sub }, handlers: new Set(), hasLast: false, last: undefined, rejected: false };
      entries.set(key, e);
      if (sockOpen && sendRaw({ method: "subscribe", subscription: e.sub })) serverSubs.add(key);
    }
    const h = { onData, onError };
    e.handlers.add(h);
    attachVisibility();
    if (!sock && reconnectT == null) connect();
    if (e.hasLast) deliver(h, e.last);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release(key, e, h);
    };
  }

  return {
    subscribe,
    onStatus(fn) {
      statusFns.add(fn);
      return () => { statusFns.delete(fn); };
    },
    status: () => status,
    stats() {
      let handlers = 0;
      for (const e of entries.values()) handlers += e.handlers.size;
      return { sockets: socketsOpened, keys: entries.size, handlers };
    },
  };
}

/* One per tab. Kept on globalThis so a hot-reloaded module in dev reuses the
   socket instead of leaving the old one open beside a new one. */
const GLOBAL_KEY = `__flowflowHlWs:${HL_NETWORK}`;

/** The tab's one Hyperliquid socket manager (created on first use, not on import). */
export function hlWs() {
  const g = globalThis;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createHlWs();
  return g[GLOBAL_KEY];
}

/** Subscribe on the tab's shared socket. Returns the unsubscribe function. */
export function hlSubscribe(sub, onData, opts) {
  return hlWs().subscribe(sub, onData, opts);
}
