// ─────────────────────────────────────────────────────────────────────────────
// What the user may trade on ONE coin: Hyperliquid's activeAssetData, per
// (MASTER address, coin). READ ONLY.
// ─────────────────────────────────────────────────────────────────────────────
//
// The account's free USDC (perpBalanceUsdc.availableUsdc) is not what a new
// order may use. Measured live on 2026-09-22 (fixtures, MEASURED.availableVsFree):
// a standard account with withdrawable 0.0 had 1703.80 available to trade on
// ETH; a unified one had 42166.04 free and 85261.29 available to trade on SOL.
// The trade ticket's "available" and its size cap come from HERE, as
// Hyperliquid computes them for this coin at the user's leverage setting.
//
// ONE SOURCE: the activeAssetData stream {type, user, coin} on the tab's one
// socket (ws.js, refcounted there), with a REST read (POST /info
// activeAssetData) on first use, on every resubscribe and after refresh(). ws.js
// matches these pushes by coin only, so each push is checked against the
// session's address before use. A push newer than a REST request wins over that
// request's answer.
//
// VISIBILITY. A hidden tab asks nothing: ws.js closes the socket while hidden
// and the store reads once on the way back. REST polling happens only when the
// server REJECTED the stream, and only while the tab is visible.
//
// UNKNOWN IS NULL. Until an answer lands every figure is null (a dash); a
// failed read keeps what was known and reports the error beside it.

import { hlInfo } from "../info.js";
import { hlWs } from "../ws.js";
import { browserTimers, browserNow, docHidden, onDocVisibility } from "../browser.js";
import { normAddress, parseActiveAssetData } from "./parse.js";

/** REST fallback interval for a REJECTED stream (visible tab only). */
export const PERP_ASSET_POLL_MS = 15_000;
/** Released (address, coin) sessions kept, flagged stale, so a return shows figures at once. */
export const PERP_ASSET_IDLE_KEPT = 8;

const NO_LEVERAGE = Object.freeze({ type: null, value: null, rawUsd: null });

const messageOf = (e) => String((e && e.message) || e || "unknown error");
const coinOf = (c) => (typeof c === "string" && c !== "" ? c : null);
const keyOf = (address, coin) => `${address}|${coin}`;

function blank(address, coin) {
  return Object.freeze({
    address,
    coin,
    answered: false,
    loading: false,
    stale: false,
    error: null,
    updatedAt: null,
    rejected: false,
    leverage: NO_LEVERAGE,
    availableToTrade: null,
    maxTradeSzs: null,
  });
}

/** The snapshot for no address or no coin. */
export const PERP_ASSET_EMPTY = blank(null, null);

/**
 * The per-coin store. Dependencies are injectable for the node suites; the app
 * uses perpAssetDataStore() (usePerpAccount.js).
 */
export function createPerpAssetDataStore({
  info = hlInfo,
  ws = null,
  getWs = null,
  timers = browserTimers,
  now = browserNow,
  isHidden = docHidden,
  onVisibilityChange = onDocVisibility,
  pollMs = PERP_ASSET_POLL_MS,
  idleKept = PERP_ASSET_IDLE_KEPT,
} = {}) {
  const sock = () => (ws || (getWs ? getWs() : hlWs()));
  const sessions = new Map();        // key -> session
  const placeholders = new Map();    // key -> blank snapshot, stable per key
  const listeners = new Set();
  let offStatus = null;
  let offVis = null;

  const clear = (id) => { if (id != null) timers.clearTimeout(id); return null; };
  const held = () => [...sessions.values()].filter((s) => s.holds > 0);

  function notify() {
    for (const fn of [...listeners]) { try { fn(); } catch { /* a listener's bug stays its own */ } }
  }

  function build(s) {
    const d = s.data;
    return Object.freeze({
      address: s.address,
      coin: s.coin,
      answered: d != null,
      loading: s.inflight != null,
      stale: s.staleSince != null,
      error: s.error,
      updatedAt: s.updatedAt,
      rejected: s.rejected,
      leverage: d ? Object.freeze({ ...d.leverage }) : NO_LEVERAGE,
      availableToTrade: d && d.availableToTrade ? Object.freeze([...d.availableToTrade]) : null,
      maxTradeSzs: d && d.maxTradeSzs ? Object.freeze([...d.maxTradeSzs]) : null,
    });
  }

  function emit(s) {
    s.snap = build(s);
    notify();
  }

  function markFresh(s, at) {
    if (s.staleSince != null && at >= s.staleSince) s.staleSince = null;
  }

  /* ── REST ──────────────────────────────────────────────────────────── */

  function refresh(s) {
    if (s.inflight) { s.again = true; return s.inflight; }
    const sentAt = now();
    let p;
    try { p = Promise.resolve(info({ type: "activeAssetData", user: s.address, coin: s.coin })); } catch (e) { p = Promise.reject(e); }
    s.inflight = p.then(
      (json) => {
        const d = parseActiveAssetData(json);
        if (!d || d.user !== s.address || d.coin !== s.coin) {
          s.error = "Hyperliquid answered an unreadable activeAssetData state";
          return;
        }
        if (!(s.wsAt != null && s.wsAt >= sentAt)) s.data = d;
        s.error = null;
        markFresh(s, sentAt);
      },
      (e) => { s.error = messageOf(e); },
    ).then(() => {
      s.inflight = null;
      s.updatedAt = now();
      emit(s);
      schedulePoll(s);
      if (s.again && s.holds > 0) { s.again = false; refresh(s); }
    });
    emit(s);
    return s.inflight;
  }

  function schedulePoll(s) {
    s.pollT = clear(s.pollT);
    if (s.holds === 0 || !s.rejected || isHidden()) return;
    s.pollT = timers.setTimeout(() => {
      s.pollT = null;
      if (s.holds > 0 && !isHidden()) refresh(s);
    }, pollMs);
  }

  /* ── the stream ────────────────────────────────────────────────────── */

  function onPush(s, data) {
    if (s.holds === 0) return;
    const d = parseActiveAssetData(data);
    if (!d || d.user !== s.address || d.coin !== s.coin) return;
    const at = now();
    s.data = d;
    s.wsAt = at;
    s.error = null;
    markFresh(s, at);
    emit(s);
  }

  function onRejected(s) {
    if (s.rejected) return;
    s.rejected = true;
    emit(s);
    schedulePoll(s);
  }

  /* ── socket status and page visibility ─────────────────────────────── */

  function onWsStatus(st) {
    for (const s of held()) {
      if (st === "open") {
        s.wsSeenOpen = true;
        if (s.wsLost) { s.wsLost = false; refresh(s); }
      } else if (st === "reconnecting" || st === "paused" || st === "idle") {
        s.wsLost = true;
        if (s.wsSeenOpen && s.staleSince == null) {
          s.staleSince = now();
          emit(s);
        }
      }
    }
  }

  function onVis() {
    for (const s of held()) {
      if (isHidden()) { s.pollT = clear(s.pollT); continue; }
      if (s.rejected && !s.inflight) refresh(s);
    }
  }

  function attachShared() {
    if (!offStatus) offStatus = sock().onStatus(onWsStatus);
    if (!offVis) offVis = onVisibilityChange(onVis);
  }

  function detachShared() {
    if (held().length) return;
    if (offStatus) { offStatus(); offStatus = null; }
    if (offVis) { offVis(); offVis = null; }
  }

  /* ── sessions ──────────────────────────────────────────────────────── */

  function newSession(address, coin) {
    const s = {
      address, coin, holds: 0, off: null, data: null, wsAt: null, error: null,
      updatedAt: null, rejected: false, staleSince: null, wsLost: false,
      wsSeenOpen: false, inflight: null, again: false, pollT: null, snap: null,
    };
    s.snap = build(s);
    return s;
  }

  function evictIdle() {
    const idle = [...sessions.entries()].filter(([, s]) => s.holds === 0);
    while (idle.length > idleKept) sessions.delete(idle.shift()[0]);
  }

  function retain(addressIn, coinIn) {
    const address = normAddress(addressIn);
    const coin = coinOf(coinIn);
    if (!address || !coin) return () => {};
    const key = keyOf(address, coin);
    let s = sessions.get(key);
    if (!s) { s = newSession(address, coin); sessions.set(key, s); }
    else if (s.holds === 0) { sessions.delete(key); sessions.set(key, s); }
    s.holds++;
    if (s.holds === 1) {
      attachShared();
      const w = sock();
      const st = typeof w.status === "function" ? w.status() : null;
      s.wsSeenOpen = st === "open";
      s.wsLost = st === "paused" || st === "reconnecting";
      s.rejected = false;
      s.off = w.subscribe({ type: "activeAssetData", user: address, coin }, (data) => onPush(s, data), { onError: () => onRejected(s) });
      refresh(s);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      s.holds--;
      if (s.holds > 0) return;
      if (s.off) { try { s.off(); } catch { /* already gone */ } s.off = null; }
      s.pollT = clear(s.pollT);
      s.again = false;
      if (s.staleSince == null) s.staleSince = now();
      detachShared();
      evictIdle();
      emit(s);
    };
  }

  return {
    /** Listen for any change (for useSyncExternalStore). Returns the remover. */
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    /** The frozen snapshot for (address, coin); stable until something changes. */
    getSnapshot(addressIn, coinIn) {
      const address = normAddress(addressIn);
      const coin = coinOf(coinIn);
      if (!address || !coin) return PERP_ASSET_EMPTY;
      const key = keyOf(address, coin);
      const s = sessions.get(key);
      if (s) return s.snap;
      let p = placeholders.get(key);
      if (!p) {
        if (placeholders.size > 32) placeholders.clear();
        p = blank(address, coin);
        placeholders.set(key, p);
      }
      return p;
    },
    /** Keep (address, coin) streamed. Returns the release function. */
    retain,
    /** Read again now, for example right after a leverage change or an order. */
    refresh(addressIn, coinIn) {
      const address = normAddress(addressIn);
      const coin = coinOf(coinIn);
      const s = address && coin ? sessions.get(keyOf(address, coin)) : null;
      return s && s.holds > 0 ? refresh(s) : Promise.resolve();
    },
  };
}
