// The deposits the app is watching, for the Deposit sheet AND the status strip.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-01, with a customer whose money looked stuck: "ตอนโอนเข้ามา มันควร
// มี Popup ขึ้นมาเลยดิ ... Status บนสุดจอแม่งขึ้น". Before this file the app knew
// about a deposit only while the Deposit sheet was open: closing it stopped the
// one tracker there was, and the customer who closed the sheet to go and send the
// money was exactly the one who never heard about it again.
//
// So the tracker is no longer the sheet's. It lives here, ONE per deposit address,
// and the sheet and the strip both read it: the same rows, the same look, so the
// two can never disagree about where a deposit is (MONEY_RULES section 1), and
// there is never a second poll beside the first.
//
// 🔴 WHEN IT LOOKS, AND WHEN IT STOPS
//
//   • While a Deposit sheet shows the address: always (the sheet's own rule).
//   • After the sheet closes: for WATCH_AFTER_SHOWN_MS, because an address the
//     customer has just been shown is an address money is about to be sent to.
//     A landing does not end it: "a small one first, then the real amount" is
//     two deposits to one address, and the second must be heard too.
//   • Past the window, for as long as a deposit there is on its way, but only a
//     recent one (WATCH_MOVING_MAX_MS by its own time): a request stuck for days
//     in the address's history is not money arriving now, and must not keep a
//     poll and a spinning strip alive for ever.
//   • An address the customer only glanced at (under WATCH_GLANCE_MS) and then
//     replaced with another network's gets no window at all: one watch per
//     network tapped is the request budget the open sheet itself needs.
//   • Never while the tab is hidden: lib/relay/depositAddress's trackDeposits
//     parks itself then and looks once on the way back, which is the moment a
//     phone customer returns from their exchange app.
//   • A customer who was never shown an address has no entry here at all: no
//     request, no timer, no pixel.
//
// 🔴 WHAT THE STRIP MAY ANNOUNCE, WITH NO CLOCK. A finished deposit is announced
// only if nobody has shown it to the customer yet. Everything the open sheet has
// on screen is acknowledged as it is drawn, so a deposit the customer watched land
// is never announced twice, and one that lands after they closed the sheet is.
// The acknowledged ids are saved with the address, so an app that is reloaded in
// between still knows which deposit is new. The one case with no list at all is
// a watch whose sheet never got an answer; there, a row made well before the
// address was shown (WATCH_OLD_ROW_MS) counts as old. That is the device clock
// against the deposit service's, and it is used for nothing but whether to SAY
// something: nothing here moves money. (What moves money is the chain's balance
// alone — perp/deposit/perpFunding.js — and this watch only tells it WHEN to
// look: see landingSig below.)
//
// What is saved: per wallet, the addresses still being watched, when the window
// ends, the acknowledged ids, and whether something there still needs saying (a
// deposit on its way, or a finished one nobody has seen) past the window. Such an
// entry survives a reload for up to WATCH_NEWS_MAX_MS and is looked at ONCE on
// the next start, so the strip can say it again. No figure is saved; every figure
// on the strip is the tracker's latest answer.

// 🔴 TWO DEPOSIT SERVICES, ONE WATCH (Private mode, 2026-10-15). An entry names
// the service whose address it is (`provider`): "relay" — the Normal deposit,
// and every entry saved before this field existed — or "near", a Private
// one-time address (lib/intents/status.js trackIntentsDeposit, same tracker
// contract, same rows). The watch picks the tracker by provider and changes
// nothing else: Relay entries are watched exactly as before, by `track`. A
// Private row can carry one status Relay never sends, "incomplete" (less arrived
// than was quoted; it is refunded after the deadline). It is neither moving nor
// finished here, so it is never announced as money and never as an arrival —
// but it IS news: the strip says it ("less than quoted · refunded after …") and
// keeps saying it until the customer closes it, under its own acknowledgement
// (perpDepositView incompleteAckId), so closing it never silences the refund.
//
// 🔴 BUT AN INCOMPLETE DEPOSIT IS STILL FOLLOWED. Its money sits with the service
// until its refund, up to ~72 h later (the quote's deadline, the row's
// refundAfter). The watch keeps looking — past the sheet's window, across
// reloads — until the row changes (refunded, failed, credited) or the refund time
// plus WATCH_REFUND_GRACE_MS has passed (never longer than WATCH_INCOMPLETE_MAX_MS
// after the row's own time), so the refund is HEARD and announced like any other
// finished deposit. Saved entries carry `waitUntil` for this (an additive field;
// entries without it resume exactly as before). Relay never sends "incomplete",
// so nothing changes for Relay entries.

import { trackDeposits, isEvmAddress } from "../../lib/relay/depositAddress.js";
import { FIRST_HOP_PLAN_ID } from "../../lib/relay/firstDeposit.js";
import { browserNow } from "../../lib/hyperliquid/browser.js";
import { markWalletFunds } from "./walletFunds.js";
import { trackIntentsDeposit } from "../../lib/intents/status.js";
import { PROVIDER_RELAY, PROVIDER_NEAR, PRIVATE_ARB_PLAN_ID } from "../../lib/intents/config.js";
import { incompleteAckId } from "./perpDepositView.js";

const MINUTE = 60000;

export const WATCH_PREFIX = "flowflow.depositWatch.v1:";
/** How long an address the customer was shown is still expected to receive money. */
export const WATCH_AFTER_SHOWN_MS = 30 * MINUTE;
/** With no acknowledged list, a row made this long before the address was shown is old news. */
export const WATCH_OLD_ROW_MS = 10 * MINUTE;
/** Acknowledged ids kept per address (newest kept). */
export const WATCH_ACKED_MAX = 100;
/** A deposit on its way keeps the watch past its window only while it is younger than this. */
export const WATCH_MOVING_MAX_MS = 120 * MINUTE;
/** Something still to say keeps a watch across reloads for this long after its window. */
export const WATCH_NEWS_MAX_MS = 24 * 60 * MINUTE;
/** An address on screen for less than this, then replaced by another, was only glanced at. */
export const WATCH_GLANCE_MS = 20000;
/** An INCOMPLETE deposit is followed until this long after its refund time (refundAfter) … */
export const WATCH_REFUND_GRACE_MS = 6 * 60 * MINUTE;
/** … and never longer than this after the row's own time (a 72 h deadline plus margin). */
export const WATCH_INCOMPLETE_MAX_MS = 80 * 60 * MINUTE;

/** The row statuses that are an end: the strip may announce each once. */
export const FINISHED_STATUSES = Object.freeze(["credited", "refunded", "failed"]);

/** The deposit services an entry may name. A missing provider is "relay" (every entry saved before Private mode). */
export const DEPOSIT_PROVIDERS = Object.freeze([PROVIDER_RELAY, PROVIDER_NEAR]);
/** The trackers for providers other than "relay" (Relay's is `track`, as it always was). */
export const DEPOSIT_TRACKERS = Object.freeze({ [PROVIDER_NEAR]: trackIntentsDeposit });

/* A saved or shown provider: missing reads as "relay"; a name the watch does
   not know is null (that entry is not watched by the wrong service). */
const providerOf = (p) => (p == null ? PROVIDER_RELAY : DEPOSIT_PROVIDERS.includes(p) ? p : null);

/* The plans whose credited deposit is money in the customer's own wallet, one
   hop short of their Perp account: Normal's first deposit and Private's
   private-arb. A landing there makes Recover's earlier look stale. */
const LANDS_IN_WALLET = Object.freeze([FIRST_HOP_PLAN_ID, PRIVATE_ARB_PLAN_ID]);

const isFinished = (r) => !!r && typeof r.id === "string" && FINISHED_STATUSES.includes(r.status);
const isMoving = (r) => !!r && r.status === "arriving";
/* Less arrived than was quoted: the money waits with the service for its refund. */
const isWaiting = (r) => !!r && r.status === "incomplete";

/* Until when an INCOMPLETE row is worth following (null: it is not one, or no time is known). */
function waitUntilOf(r) {
  if (!isWaiting(r)) return null;
  const cap = Number.isFinite(r.createdAt) ? r.createdAt + WATCH_INCOMPLETE_MAX_MS : null;
  const ref = Number.isFinite(r.refundAfter) ? r.refundAfter + WATCH_REFUND_GRACE_MS : null;
  if (ref != null && cap != null) return Math.min(ref, cap);
  return ref ?? cap;
}
const lc = (a) => (typeof a === "string" ? a.toLowerCase() : null);

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** The saved key for one wallet's watched addresses. */
export function watchKey(user) {
  return `${WATCH_PREFIX}${String(user).toLowerCase()}`;
}

const EMPTY_SNAP = Object.freeze({ state: "loading", requests: Object.freeze([]), checkedAt: null, error: null });

/**
 * A watch over the deposit addresses this app has shown. Everything it needs from
 * the world is injected, so the Node suite drives it with a fake tracker.
 *
 *   track     trackDeposits (lib/relay/depositAddress.js), or a fake: the "relay" entries' tracker
 *   trackers  { [provider]: tracker } for every other provider (default DEPOSIT_TRACKERS:
 *             "near" → lib/intents/status.js trackIntentsDeposit), or fakes
 *   storage   localStorage, or null (nothing saved)
 *   now       the clock
 */
export function createDepositWatch({ track = trackDeposits, trackers = DEPOSIT_TRACKERS, storage, now = browserNow } = {}) {
  const store = () => (storage === undefined ? defaultStorage() : storage);
  const entries = new Map();
  const subs = new Set();
  let state = Object.freeze({ entries: Object.freeze([]) });

  /* The tracker for an entry's provider: Relay's is `track`, exactly as before. */
  const trackerFor = (provider) => (provider === PROVIDER_RELAY ? track : trackers && typeof trackers[provider] === "function" ? trackers[provider] : null);

  function newEntry(address, user, provider = PROVIDER_RELAY) {
    return {
      address, user, routeId: null, planId: null, provider,
      holders: 0, until: 0, shownAt: now(),
      acked: new Set(), baselined: false,
      snap: EMPTY_SNAP, seq: 0, okSeq: 0,
      tracker: null, live: false, token: null,
      glance: false, releasedAt: 0, resume: false, credited: null,
      /* An INCOMPLETE deposit here is followed until then (null: none). */
      waitUntil: null,
    };
  }

  /* A deposit on its way that is recent enough to be money arriving now. The
     row's time is the deposit service's and the clock is the device's; this
     only decides how long to keep looking and whether to say "Arriving". */
  const movingNow = (r) => isMoving(r) && Number.isFinite(r.createdAt) && now() - r.createdAt < WATCH_MOVING_MAX_MS;
  const anyMoving = (e) => e.snap.requests.some(movingNow);
  const hasNews = (e) => e.snap.requests.some((r) => isFinished(r) && !e.acked.has(r.id));
  /* An INCOMPLETE deposit whose refund has not been heard yet, still inside its time. */
  const waiting = (e) => Number.isFinite(e.waitUntil) && now() < e.waitUntil;
  /* Past its window, is there still something to look at or to say? */
  const holds = (e) => ((anyMoving(e) || hasNews(e) || e.resume) && now() - e.until < WATCH_NEWS_MAX_MS) || waiting(e);

  function publish() {
    state = Object.freeze({
      entries: Object.freeze([...entries.values()].map((e) => Object.freeze({
        address: e.address,
        user: e.user,
        routeId: e.routeId,
        planId: e.planId,
        provider: e.provider,
        held: e.holders > 0,
        watching: e.live,
        seq: e.seq,
        okSeq: e.okSeq,
        state: e.snap.state,
        requests: e.snap.requests,
        checkedAt: e.snap.checkedAt,
        error: e.snap.error,
        acked: Object.freeze([...e.acked]),
        /* Per row: on its way AND recent. An old stuck row is never "Arriving". */
        movingNow: Object.freeze(e.snap.requests.map(movingNow)),
      }))),
    });
    for (const fn of [...subs]) { try { fn(); } catch { /* a reader never breaks the watch */ } }
  }

  /* While a sheet shows the address the window has not started; saved as if it
     started now, so an app that dies with the sheet open still resumes it. */
  const untilOf = (e) => (e.holders > 0 ? now() + WATCH_AFTER_SHOWN_MS : e.until);

  function persist(user) {
    const st = store();
    if (!st || !user) return;
    const list = [];
    for (const e of entries.values()) {
      if (e.user !== user) continue;
      const until = untilOf(e);
      const hold = holds(e);
      if (!(until > now()) && !hold) continue;
      const saved = {
        address: e.address, routeId: e.routeId, planId: e.planId, shownAt: e.shownAt, until,
        baselined: e.baselined, acked: [...e.acked].slice(-WATCH_ACKED_MAX), hold,
      };
      /* A Relay entry is saved exactly as before (no field); any other names its service. */
      if (e.provider !== PROVIDER_RELAY) saved.provider = e.provider;
      /* An INCOMPLETE deposit still waiting for its refund: resumed after a reload until then. */
      if (waiting(e)) saved.waitUntil = e.waitUntil;
      list.push(saved);
    }
    try {
      if (list.length) st.setItem(watchKey(user), JSON.stringify({ v: 1, list }));
      else st.removeItem(watchKey(user));
    } catch { /* private mode: the session still holds it */ }
  }

  function readSaved(user) {
    const st = store();
    if (!st || !user) return [];
    let raw = null;
    try { raw = st.getItem(watchKey(user)); } catch { return []; }
    if (!raw) return [];
    let j = null;
    try { j = JSON.parse(raw); } catch { return []; }
    if (!j || j.v !== 1 || !Array.isArray(j.list)) return [];
    return j.list.filter((r) => r && isEvmAddress(r.address) && Number.isFinite(r.until) && Number.isFinite(r.shownAt) && providerOf(r.provider) != null);
  }

  /* A saved entry's INCOMPLETE wait, if it is still running (else null). */
  const savedWait = (r) => (Number.isFinite(r.waitUntil) && now() < r.waitUntil ? r.waitUntil : null);

  function stopTracker(e) {
    e.live = false;
    e.token = null;
    if (e.tracker) { try { e.tracker.stop(); } catch { /* already stopped */ } }
    e.tracker = null;
  }

  function start(e) {
    if (e.live) return;
    const trackFn = trackerFor(e.provider);
    /* A provider with no tracker here is not watched at all (never by another service's). */
    if (!trackFn) return;
    e.live = true;
    /* A stopped tracker's late answer is not this one's. */
    const token = {};
    e.token = token;
    const t = trackFn({ depositAddress: e.address, user: e.user, onUpdate: (s) => onLook(e, s, token) });
    /* A tracker that was stopped while it was being made stays stopped. */
    if (e.live) e.tracker = t; else { try { t.stop(); } catch { /* nothing to stop */ } }
  }

  /* Every finished row on screen in an open sheet is the sheet's to tell. */
  function ackShown(e) {
    for (const r of e.snap.requests) if (isFinished(r)) e.acked.add(r.id);
  }

  /* Stop once the window is over, nothing recent is on its way and no
     INCOMPLETE deposit is waiting for its refund. A finished deposit nobody has
     seen needs no more looking: its row stays on the strip. */
  function settle(e) {
    if (e.holders > 0 || !e.live) return;
    if (now() < e.until || anyMoving(e) || waiting(e)) return;
    stopTracker(e);
  }

  function onLook(e, s, token) {
    if (!e.live || e.token !== token || entries.get(e.address) !== e || !s) return;
    const requests = Array.isArray(s.requests) ? s.requests : [];
    e.snap = { state: s.state, requests, checkedAt: s.checkedAt ?? null, error: s.error ?? null };
    e.seq += 1;
    const fresh = s.state === "ok" && s.error == null;
    if (fresh) {
      e.okSeq = e.seq;
      e.resume = false;
      /* A first deposit that landed since the last answer is money now in the
         customer's own wallet: Recover's look from before it is stale. */
      const credited = requests.filter((r) => r && r.status === "credited" && typeof r.id === "string").map((r) => r.id);
      if (LANDS_IN_WALLET.includes(e.planId) && e.user && e.credited && credited.some((id) => !e.credited.has(id))) markWalletFunds(e.user);
      e.credited = new Set(credited);
      /* The latest INCOMPLETE row's time to follow it by (an answer without one ends the wait). */
      const waits = requests.map(waitUntilOf).filter((t) => Number.isFinite(t));
      e.waitUntil = waits.length ? Math.max(...waits) : null;
      for (const r of requests) {
        if (!isFinished(r) || e.acked.has(r.id)) continue;
        if (e.holders > 0) { e.acked.add(r.id); continue; }
        if (e.baselined) continue;
        const made = r.createdAt;
        if (!(Number.isFinite(made) && made >= e.shownAt - WATCH_OLD_ROW_MS)) e.acked.add(r.id);
      }
      e.baselined = true;
    }
    settle(e);
    persist(e.user);
    publish();
  }

  /**
   * A Deposit sheet is showing this address. Returns { seq, release }: seq is the
   * look count when it opened (a look after it is the sheet's own), and release()
   * is the sheet closing, which starts the window.
   */
  function show({ user = null, address, routeId = null, planId = null, provider = PROVIDER_RELAY } = {}) {
    const prov = providerOf(provider);
    if (!isEvmAddress(address) || prov == null) return { seq: 0, release() {} };
    const key = lc(address);
    const who = isEvmAddress(user) ? lc(user) : null;
    let e = entries.get(key);
    if (!e || e.user !== who || e.provider !== prov) {
      if (e) stopTracker(e);
      e = newEntry(key, who, prov);
      entries.set(key, e);
    }
    e.holders += 1;
    if (routeId) e.routeId = routeId;
    if (planId) e.planId = planId;
    e.shownAt = now();
    e.glance = false;
    ackShown(e);
    /* An address just glanced at and replaced by this one (a network tapped
       past) is not where the money is going: its window is dropped, unless
       something there is moving or still to be said. */
    for (const o of [...entries.values()]) {
      if (o === e || o.user !== who || o.holders > 0 || !o.glance) continue;
      if (now() - o.releasedAt >= WATCH_GLANCE_MS || anyMoving(o) || hasNews(o)) continue;
      stopTracker(o);
      entries.delete(o.address);
    }
    /* A look already out when the sheet opened answers first, and it was sent
       before the sheet opened: it is not this open's first answer. */
    let seq = e.seq;
    if (e.live && e.tracker) { if (e.tracker.refresh() === false) seq += 1; } else start(e);
    persist(who);
    publish();
    let done = false;
    return {
      seq,
      release() {
        if (done) return;
        done = true;
        if (entries.get(key) !== e) return;
        e.holders = Math.max(0, e.holders - 1);
        if (e.holders === 0) {
          ackShown(e);
          e.until = now() + WATCH_AFTER_SHOWN_MS;
          e.releasedAt = now();
          e.glance = now() - e.shownAt < WATCH_GLANCE_MS;
        }
        persist(who);
        publish();
      },
    };
  }

  /**
   * The wallet on screen. Watches of any other wallet stop (unless a sheet holds
   * them), and this wallet's watches resume: the saved ones still inside their
   * window or still holding something to say, and any stopped in this session
   * that still have a reason to look. null: nobody is connected, so nothing is
   * watched but an open sheet.
   */
  function focus(user = null) {
    const who = isEvmAddress(user) ? lc(user) : null;
    for (const e of entries.values()) if (e.user !== who && e.holders === 0 && e.live) stopTracker(e);
    if (who) {
      for (const r of readSaved(who)) {
        const inWindow = r.until > now();
        const wait = savedWait(r);
        if (!inWindow && !(r.hold === true && now() - r.until < WATCH_NEWS_MAX_MS) && wait == null) continue;
        const key = lc(r.address);
        let e = entries.get(key);
        if (e && e.user !== who) continue;
        if (!e) {
          e = newEntry(key, who, providerOf(r.provider));
          e.routeId = typeof r.routeId === "string" ? r.routeId : null;
          e.planId = typeof r.planId === "string" ? r.planId : null;
          e.shownAt = r.shownAt;
          e.until = r.until;
          e.baselined = r.baselined === true;
          if (Array.isArray(r.acked)) for (const id of r.acked) if (typeof id === "string") e.acked.add(id);
          /* Past its window, it is back for one look: what it held is unknown
             until that look answers. */
          e.resume = !inWindow;
          e.waitUntil = wait;
          entries.set(key, e);
        } else if (e.holders === 0) {
          e.until = Math.max(e.until, r.until);
          if (wait != null && !(Number.isFinite(e.waitUntil) && e.waitUntil >= wait)) e.waitUntil = wait;
        }
        start(e);
      }
      /* Stopped in this session by a wallet switch, with a reason to go on. */
      for (const e of entries.values()) {
        if (e.user === who && e.holders === 0 && !e.live && (now() < e.until || anyMoving(e) || waiting(e))) start(e);
      }
      persist(who);
    }
    publish();
  }

  /** The customer has seen this finished deposit (tapped it, or closed it). */
  function dismiss(address, id) {
    const e = entries.get(lc(address));
    if (!e || typeof id !== "string") return;
    e.acked.add(id);
    settle(e);
    persist(e.user);
    publish();
  }

  /** Tests and teardown only: stop every tracker. */
  function stopAll() {
    for (const e of entries.values()) stopTracker(e);
    publish();
  }

  return {
    show,
    focus,
    dismiss,
    stopAll,
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/** The app's one watch. Nothing runs until a sheet shows an address or a wallet is focused. */
export const depositWatch = createDepositWatch();

/**
 * What the Deposit sheet's tracker hook hands the sheet, from the watch's state.
 * `since` is { address, seq } from show(): until a look made after the sheet
 * opened has ANSWERED, checkedAt stays null, because the first deposit's last hop
 * takes "the tracker has answered" as its baseline and an answer from before the
 * sheet opened is not one this sheet watched (the panel's tracker baseline).
 */
export function sheetTrackView(state, depositAddress, since) {
  if (!depositAddress) return { depositAddress: null, state: "idle", requests: [], checkedAt: null, error: null };
  const key = lc(depositAddress);
  const e = state && Array.isArray(state.entries) ? state.entries.find((x) => x.address === key) : null;
  const mine = !!(e && since && since.address === key);
  if (!e) return { depositAddress, state: "loading", requests: [], checkedAt: null, error: null };
  if (mine && e.okSeq > since.seq) return { depositAddress, state: "ok", requests: e.requests, checkedAt: e.checkedAt, error: e.error };
  if (mine && e.seq > since.seq) return { depositAddress, state: "error", requests: e.requests, checkedAt: null, error: e.error };
  return { depositAddress, state: "loading", requests: e.requests, checkedAt: null, error: null };
}

/**
 * The ONE deposit the status strip speaks about for this wallet, or null.
 *
 *   • nothing while a Deposit sheet is open: the sheet is already saying it;
 *   • a deposit on its way first (newest), since that is money moving now, but
 *     only while the watch is still looking at it and it is recent: a spinner
 *     over a look that has stopped would be a claim nobody is checking;
 *   • otherwise the newest finished deposit nobody has shown the customer yet,
 *     or the newest INCOMPLETE one nobody has closed (its money waits for a
 *     refund up to ~72 h; it is said, never as money and never as an arrival).
 *
 * A row in no known state ("unknown": another wallet's, or a status the app does
 * not map) is never announced. Returns { address, routeId, planId, row }.
 */
export function pickDepositStatus(state, user) {
  const who = isEvmAddress(user) ? lc(user) : null;
  if (!who || !state || !Array.isArray(state.entries)) return null;
  const mine = state.entries.filter((e) => e.user === who);
  if (mine.some((e) => e.held)) return null;
  let best = null;
  let bestRank = 0;
  let bestAt = -Infinity;
  for (const e of mine) {
    (e.requests || []).forEach((r, i) => {
      let rank = 0;
      if (isMoving(r)) rank = e.watching && e.movingNow && e.movingNow[i] ? 2 : 0;
      else if (isFinished(r) && !e.acked.includes(r.id)) rank = 1;
      else if (isWaiting(r) && typeof r.id === "string" && !e.acked.includes(incompleteAckId(r.id))) rank = 1;
      if (!rank) return;
      const at = Number.isFinite(r.createdAt) ? r.createdAt : -1;
      if (rank > bestRank || (rank === bestRank && at > bestAt)) {
        best = { address: e.address, routeId: e.routeId, planId: e.planId, provider: e.provider || PROVIDER_RELAY, row: r };
        bestRank = rank;
        bestAt = at;
      }
    });
  }
  return best;
}

/**
 * A short signature of this wallet's FINISHED deposits ("id:status", sorted):
 * it changes exactly when one of them lands, comes back or fails. The app-wide
 * mover (perp/deposit/AutoMover.jsx) reads the wallet's balance on each change —
 * a landing is the moment money may be sitting one hop short — and not on every
 * look the watch makes, which would be a chain read per poll for nothing.
 */
export function landingSig(state, user) {
  const who = isEvmAddress(user) ? lc(user) : null;
  if (!who || !state || !Array.isArray(state.entries)) return "";
  const out = [];
  for (const e of state.entries) {
    if (e.user !== who) continue;
    for (const r of e.requests || []) if (isFinished(r)) out.push(`${r.id}:${r.status}`);
  }
  return out.sort().join(",");
}
