// ─────────────────────────────────────────────────────────────────────────────
// The MOCK perp account as a store: state + persistence + two-tab sync.
// ─────────────────────────────────────────────────────────────────────────────
//
// The arithmetic lives in perpMockMath.js; this file only holds the current
// account, saves it, tells readers, and keeps two tabs from overwriting each
// other. Its dependencies are arguments, so the node suite runs it with a fake
// storage, a fake clock and a fake second tab:
//
//   storage  { getItem, setItem } or null. Every read and write is wrapped in
//            try: private mode, a full quota or a blocked storage must never
//            crash the page. When a write fails the account keeps working in
//            memory and the snapshot says persisted: false, with the error.
//   listen   (handler) -> remove; the handler receives the browser storage
//            event from OTHER tabs. The newer account is adopted and readers
//            are told.
//   feeRate  HL taker + builder fee as a fraction (config.js). Null means the
//            fee is unknown, and every fee-bearing action is refused.
//
// NO LOST UPDATE. Every action first re-reads the saved account (another tab
// may have written it before its event reached us), applies itself to THAT,
// then saves. Two tabs feeding the same mark therefore close a TP once.
//
// MARKS are kept in memory only, never saved: a mark tick must not rewrite the
// blob. A tick that fires nothing costs one comparison and one notify.
//
// A CORRUPT OR FOREIGN BLOB at start-up is replaced by a fresh account whose
// first history entry records why (reason corrupt / version); loadNote says so
// too, so a screen can mention that the mock account was reset.
//
// MOCK LIMITATION: TP, SL and liquidation run only while FlowFlow is open (and
// its mark stream is fresh). A level the market crossed while the app was
// closed fires on the first fresh mark after it reopens, at its own price.

import {
  PERP_MOCK_STORAGE_KEY, PERP_MOCK_START_USD,
  perpMockFresh, parsePerpMockBlob, perpMockOpen, perpMockAdd, perpMockClose, perpMockSetTpSl,
  perpMockOnMark, perpMockTrigger, perpMockPositionOf, quotePerpMockOpen, quotePerpMockAdd, quotePerpMockClose,
  derivePerpMockPosition, perpMockAccount,
} from "./perpMockMath.js";

const messageOf = (e) => String((e && e.message) || e || "storage error");
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * @param {{ storage?: object|null, key?: string, listen?: Function|null,
 *   now?: () => number, feeRate?: number|null, startUsd?: number }} deps
 */
export function createPerpMockEngine({
  storage = null,
  key = PERP_MOCK_STORAGE_KEY,
  listen = null,
  now = () => Date.now(),
  feeRate = null,
  startUsd = PERP_MOCK_START_USD,
} = {}) {
  let state = null;
  let lastRaw = null;
  let persisted = !!storage;
  let saveError = null;
  let loadNote = null;
  let marks = Object.freeze({});

  const listeners = new Set();
  const eventListeners = new Set();
  let snap = null;

  const ctx = () => ({ feeRate, now: now() });

  function readRaw() {
    if (!storage) return { ok: false, raw: null };
    try { return { ok: true, raw: storage.getItem(key) }; } catch (e) { saveError = messageOf(e); persisted = false; return { ok: false, raw: null }; }
  }

  function save() {
    if (!storage) { persisted = false; return; }
    const raw = JSON.stringify(state);
    try {
      storage.setItem(key, raw);
      lastRaw = raw;
      persisted = true;
      saveError = null;
    } catch (e) {
      persisted = false;
      saveError = messageOf(e);
    }
  }

  function build() {
    const list = Object.keys(state.positions)
      .map((c) => derivePerpMockPosition(state.positions[c], marks[c] || null))
      .sort((a, b) => b.openedAt - a.openedAt || b.id - a.id);
    return Object.freeze({
      mock: true,
      version: state.v,
      acct: state.acct,
      rev: state.rev,
      startUsd: state.startUsd,
      availableUsd: state.availableUsd,
      positions: state.positions,
      list: Object.freeze(list),
      account: perpMockAccount(state, marks),
      history: state.history,
      marks,
      feeRate,
      persisted,
      saveError,
      loadNote,
    });
  }

  function emit() {
    snap = build();
    for (const fn of [...listeners]) { try { fn(); } catch { /* a reader's own */ } }
  }

  function tellEvents(events) {
    if (!events || !events.length) return;
    for (const fn of [...eventListeners]) { try { fn(events); } catch { /* a reader's own */ } }
  }

  /* Adopt a newer saved account (another tab's), if there is one. */
  function pull() {
    const { ok, raw } = readRaw();
    if (!ok || raw == null || raw === lastRaw) return false;
    const { state: s } = parsePerpMockBlob(raw);
    if (!s) return false;
    state = s;
    lastRaw = raw;
    return true;
  }

  /* One action: re-read, apply the pure step to the latest account, save, tell. */
  function run(step) {
    const adopted = pull();
    const before = state;
    const r = step(state, ctx());
    if (r.state !== before) {
      state = Object.freeze({ ...r.state, rev: before.rev + 1, updatedAt: now() });
      save();
    }
    if (r.state !== before || adopted) emit();
    tellEvents(r.events);
    return r.result;
  }

  /* ── start-up ── */
  {
    const { raw } = readRaw();
    const { state: s, problem } = parsePerpMockBlob(raw);
    if (s) {
      state = s;
      lastRaw = raw;
    } else {
      state = perpMockFresh({ now: now(), startUsd, reason: problem || "new" });
      loadNote = problem;
      if (problem) save();
    }
    snap = build();
  }

  function onStorage(e) {
    if (!e || e.key !== key || e.newValue == null || e.newValue === lastRaw) return;
    const { state: s } = parsePerpMockBlob(e.newValue);
    if (!s) return;
    state = s;
    lastRaw = e.newValue;
    emit();
  }
  let offStorage = typeof listen === "function" ? listen(onStorage) : null;

  const markFor = (coin) => {
    const m = marks[coin];
    return m && !m.stale ? m.px : null;
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    getSnapshot: () => snap,

    /** Trigger events (tp / sl / liquidated) as they fire, from marks or from an action. */
    onEvents(fn) {
      eventListeners.add(fn);
      return () => { eventListeners.delete(fn); };
    },

    quoteOpen(coin, side, marginUsd, leverage, markPx, tpsl = {}, market = null) {
      const t = tpsl || {};
      return quotePerpMockOpen(state, { coin, side, marginUsd, leverage, markPx, tp: t.tp, sl: t.sl, market }, ctx());
    },
    open(coin, side, marginUsd, leverage, markPx, tpsl = {}, market = null) {
      const t = tpsl || {};
      return run((s, c) => perpMockOpen(s, { coin, side, marginUsd, leverage, markPx, tp: t.tp, sl: t.sl, market }, c));
    },

    quoteAdd(coin, side, marginUsd, markPx, opts = {}) {
      return quotePerpMockAdd(state, { coin, side, marginUsd, markPx, leverage: (opts || {}).leverage }, ctx());
    },
    add(coin, side, marginUsd, markPx, opts = {}) {
      return run((s, c) => perpMockAdd(s, { coin, side, marginUsd, markPx, leverage: (opts || {}).leverage }, c));
    },

    /** markPx may be omitted: the last FRESH mark this engine was fed is used. */
    quoteClose(coin, fraction, markPx = undefined) {
      return quotePerpMockClose(state, { coin, fraction, markPx: markPx === undefined ? markFor(coin) : markPx }, ctx());
    },
    close(coin, fraction, markPx = undefined) {
      const px = markPx === undefined ? markFor(coin) : markPx;
      return run((s, c) => perpMockClose(s, { coin, fraction, markPx: px }, c));
    },

    /** { tp, sl }: undefined keeps a level, null clears it. markPx defaults to the last fresh mark. */
    setTpSl(coin, levels = {}, markPx = undefined) {
      const l = levels || {};
      const px = markPx === undefined ? markFor(coin) : markPx;
      return run((s, c) => perpMockSetTpSl(s, { coin, tp: l.tp, sl: l.sl, markPx: px }, c));
    },

    /**
     * A fresh MARK for a coin. Remembered in memory; fires TP / SL / liquidation
     * when it reaches one. Returns the events that fired (usually none).
     */
    onMark(coin, markPx) {
      if (typeof coin !== "string" || !coin || !posNum(markPx)) return [];
      const prev = marks[coin];
      const changed = !prev || prev.px !== markPx || prev.stale;
      if (changed) marks = Object.freeze({ ...marks, [coin]: Object.freeze({ px: markPx, at: now(), stale: false }) });
      /* Only a mark that reaches a level pays for a storage read. */
      if (perpMockTrigger(perpMockPositionOf(state, coin), markPx)) {
        return run((s, c) => perpMockOnMark(s, { coin, markPx }, c));
      }
      if (changed) emit();
      return [];
    },

    /** The stream for this coin stopped: keep the last mark, flagged, and fire nothing on it. */
    markStale(coin) {
      const m = marks[coin];
      if (!m || m.stale) return;
      marks = Object.freeze({ ...marks, [coin]: Object.freeze({ ...m, stale: true }) });
      emit();
    },

    /** A fresh 1000 USD mock account. */
    reset() {
      return run((s) => {
        const fresh = perpMockFresh({ now: now(), startUsd, reason: "user", acct: s.acct + 1 });
        const next = Object.freeze({ ...fresh, rev: s.rev });
        return { state: next, result: Object.freeze({ ok: true, mock: true, kind: "reset" }), events: [] };
      });
    },

    /** Stop listening to other tabs (tests, or a torn-down page). */
    destroy() {
      if (offStorage) { offStorage(); offStorage = null; }
      listeners.clear();
      eventListeners.clear();
    },
  };
}
