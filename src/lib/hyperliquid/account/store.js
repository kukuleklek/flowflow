// ─────────────────────────────────────────────────────────────────────────────
// The Perp ACCOUNT store: one per tab, sessions keyed by the MASTER address.
// ─────────────────────────────────────────────────────────────────────────────
//
// READ ONLY. Nothing here signs, sends an action, or moves money. Info queries
// are keyed by the master address: an agent (API wallet) address answers empty
// (nonces-and-api-wallets page), and an address whose userRole is "agent" is
// reported as such, never read as an empty account.
//
// ONE SOURCE PER FIGURE, each a venue stream with a REST snapshot behind it:
//   mode       userAbstraction (REST), then webData3 userState.abstraction
//   role       userRole (REST only; asked again while it says "missing")
//   perpBalanceUsdc   the clearinghouse the mode names (balance.js):
//              clearinghouseState or spotState / spotClearinghouseState, never
//              both. Named for what it is: Perp money, never wallet money.
//   positions  clearinghouseState, the main dex AND every HIP-3 venue
//   orders     openOrders / frontendOpenOrders (trigger fields included), the
//              main dex AND every HIP-3 venue
//   fills      userFills: REST history (cap 2000, flagged partial) + live pushes;
//              later reads ask only the gap (userFillsByTime, see REFRESH COST)
//   ledger     userNonFundingLedgerUpdates: snapshot + live
//   events     liquidation / ADL from fills and ledger, userEvents, orderUpdates,
//              notification (events.js)
//   agent, server clock   webData3 userState
//   venues     every HIP-3 venue this build lists (venues.js HIP3_VENUES,
//              resolved against the LIVE perpDexs answer): its own
//              clearinghouseState and its own frontendOpenOrders, both streamed
//              and both read by every snapshot
//
// A VENUE IS PART OF THE ACCOUNT, NOT A FOOTNOTE (owner, 2026-09-23: the
// customer sees ONE Perp balance, and a venue market has to be tradable).
// Measured that day, POST /info read-only:
//   clearinghouseState{user, dex:"xyz"} is a SEPARATE pot. 0xdd966dff… holds
//   30,000.00 on the main dex and 1,272,516.69 on xyz, with 10 positions there.
//   frontendOpenOrders with no dex answered 0 of 0xd0956a1e…'s 380 xyz orders;
//   with dex:"xyz" it answered all of them. So a venue position had no card, no
//   P&L and no TP/SL, and planTpSlMove would have placed a second stop without
//   cancelling the first.
// What used to live here instead was a count: the other dexes were read, their
// state thrown away, and a flag set saying the balance was incomplete. It was
// the repo's own execRouter trap — written every five minutes, read by nothing.
// Now the state IS the account's: the positions list, the orders list and the
// equity are the main dex plus every venue, and positions.complete is a real
// true. It is also CHEAPER: 2 reads and 2 streams for the one venue this build
// lists, against 10 clearinghouseState polls every five minutes.
//
// Only the EQUITY is combined. availableUsdc stays the main dex's withdrawable,
// because that is where a withdrawal leaves from (balance.js ONE BALANCE).
//
// A stream push newer than a REST request wins over that request's answer, and
// a clearinghouse state older than the one held (by its own time) is dropped,
// so a slow snapshot never rolls a live figure back.
//
// ONE SOCKET (owner rule 4). Streams go through the tab's shared socket
// (ws.js), refcounted there. ws.js drops a push that names another user, and
// every push is still checked against this session's address before use.
// Three streams carry no address at all (orderUpdates, notification, and
// userEvents system cancels): they are used only while ONE address is held
// (streams.attributable). userEvents arrive on channel "user" (subscriptions
// page), which ws.js maps to the userEvents subscription; a liquidation names
// its victim, so it is attributed however many addresses are held. The same
// liquidation also arrives as a fill and a ledger line: one group, one lead.
//
// VISIBILITY. The first snapshot is taken even in a hidden tab (one request
// set, so the first paint has figures). After that a hidden tab asks nothing:
// ws.js closes the socket while hidden, and on its way back the store takes one
// REST snapshot (the resubscribe refresh). REST polling happens only for a
// stream the server REJECTED (for example the 10-users-per-IP cap), only for
// that stream's figures, and only while the tab is visible.
//
// REFRESH COST. Hyperliquid budgets 1200 weight a minute per IP, shared with
// the market list and the charts. A full userFills page weighs 20 plus 1 per 20
// fills (up to 120 for a busy trader), so it is read in full only once. After
// that the fills are read from the newest fill a REST answer reported
// (userFillsByTime, startTime inclusive, measured 2026-09-22): the gap, never
// the page again. The anchor is Hyperliquid's own time, so the phone's clock
// plays no part, and a WS push never moves it (a push after a dropped socket
// can be newer than fills the gap still holds). A gap read that comes back
// full may have left fills out: the history is flagged partial and the newest
// page is read in full at once. refresh() after an action reads only what an
// action moves (perp, spot, orders, the fill gap, the ledger): the mode rides
// webData3 and is re-read there only if that stream was rejected. A reconnect
// still reads the mode as well. An action also re-reads each venue's own pair,
// because a venue order moves a venue pot and a venue book. Measured by the
// documented weights for a trader near the fill cap: 183 for the old full
// re-read, 86 now — and the 86 pays for both venue reads, which the 183 did not
// do at all (scripts/test-hl-account-store.mjs K2).
//
// UNKNOWN IS NULL. Every figure is a number or null with an answered flag; a
// failed request keeps what was known and reports the error beside it.

import { hlInfo } from "../info.js";
import { hlWs } from "../ws.js";
import { browserTimers, browserNow, docHidden, onDocVisibility } from "../browser.js";
import {
  normAddress, num, parseUserRole, parseUserAbstraction, balanceSourceFor,
  parseClearinghouse, positionsByCoin, parseSpotState, parseOpenOrders, tpslByCoin,
  parseFills, mergeFills, fillsByCoin, fillsPartial, HL_FILLS_CAP,
  parseLedger, mergeLedger,
} from "./parse.js";
import { resolvePerpBalance } from "./balance.js";
import { resolveVenues } from "../venues.js";
import {
  eventsFromFills, eventsFromLedger, eventsFromUserEvents, eventsFromOrderUpdates,
  eventFromNotification, mergeEvents, isPerpRiskEvent,
} from "./events.js";

/** REST fallback interval for a REJECTED stream (visible tab only). */
export const PERP_ACCOUNT_POLL_MS = 15_000;
/** How far back the ledger snapshot reads. */
export const PERP_ACCOUNT_LEDGER_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** After a credit reaches a never-used address, ask its role again this much later. */
export const PERP_ACCOUNT_ROLE_RECHECK_MS = 2_000;
/** Released sessions kept (flagged stale) so a return shows figures at once. */
export const PERP_ACCOUNT_IDLE_KEPT = 3;

/* The streams, and the REST figure that stands in for each if it is rejected. */
const STREAMS = Object.freeze([
  { type: "webData3", figure: "mode" },
  { type: "clearinghouseState", figure: "perp", dex: true },
  { type: "spotState", figure: "spot" },
  { type: "openOrders", figure: "openOrders", dex: true },
  { type: "orderUpdates", figure: null },
  { type: "userFills", figure: "fills" },
  { type: "userEvents", figure: null },
  { type: "userNonFundingLedgerUpdates", figure: "ledger" },
  { type: "notification", figure: null },
]);

/* The two streams a HIP-3 venue rides. They are the SAME TYPES the main dex
   rides, distinguished only by the subscription's dex — so ws.js delivers every
   push of a type to every handler of it and each handler checks data.dex
   (onStream), exactly as the main-dex handlers already did. */
const VENUE_STREAMS = Object.freeze(["clearinghouseState", "openOrders"]);

const STATE_FIGURES = Object.freeze(["role", "mode", "perp", "spot", "openOrders", "fills", "ledger", "venues"]);
/* What an order, a cancel, a TP/SL, a leverage change or a withdrawal can move.
   A venue order moves a venue's own pot and its own book, so "venues" is one. */
const ACTION_FIGURES = Object.freeze(["perp", "spot", "openOrders", "fills", "ledger", "venues"]);
const FRESH_SET = Object.freeze(["perp", "spot", "openOrders"]);

const messageOf = (e) => String((e && e.message) || e || "unknown error");

/* The newest time in a list of parsed fills, or null. */
function newestTime(fills) {
  let t = null;
  for (const f of fills) if (f.time != null && (t == null || f.time > t)) t = f.time;
  return t;
}

/* Would the union of two fill lists (by trade id) hold more than the cap? */
function overflows(held, incoming) {
  const tids = new Set();
  for (const f of held) tids.add(f.tid);
  for (const f of incoming) tids.add(f.tid);
  return tids.size > HL_FILLS_CAP;
}

const fig = () => ({ answered: false, wsAt: null, error: null });

/* ── snapshots ─────────────────────────────────────────────────────────── */

const NO_BALANCE = resolvePerpBalance({});
const EMPTY_LIST = Object.freeze([]);
const EMPTY_MAP = Object.freeze(Object.create(null));

function blankSnapshot(address) {
  return Object.freeze({
    address,
    ready: false,
    loading: false,
    stale: false,
    staleSince: null,
    error: null,
    updatedAt: null,
    role: Object.freeze({ value: null, master: null, answered: false }),
    mode: Object.freeze({ value: null, source: null, answered: false }),
    perpBalanceUsdc: NO_BALANCE,
    positions: Object.freeze({ answered: false, list: EMPTY_LIST, byCoin: EMPTY_MAP, complete: null }),
    orders: Object.freeze({ answered: false, list: EMPTY_LIST, tpslByCoin: EMPTY_MAP }),
    fills: Object.freeze({ answered: false, list: EMPTY_LIST, byCoin: EMPTY_MAP, partial: null, cap: HL_FILLS_CAP, oldestTime: null }),
    ledger: Object.freeze({ answered: false, list: EMPTY_LIST, inbound: EMPTY_LIST }),
    events: EMPTY_LIST,
    agent: Object.freeze({ answered: false, address: null, validUntil: null }),
    server: Object.freeze({ time: null, at: null }),
    venues: Object.freeze({ answered: false, list: EMPTY_LIST }),
    streams: Object.freeze({ rejected: EMPTY_LIST, attributable: true }),
  });
}

/** The snapshot for no address (not connected, or not an address). */
export const PERP_ACCOUNT_EMPTY = blankSnapshot(null);

/**
 * The account store. Dependencies are injectable for the node suites; the app
 * uses perpAccountStore() (usePerpAccount.js).
 */
export function createPerpAccountStore({
  info = hlInfo,
  ws = null,
  getWs = null,
  timers = browserTimers,
  now = browserNow,
  isHidden = docHidden,
  onVisibilityChange = onDocVisibility,
  pollMs = PERP_ACCOUNT_POLL_MS,
  ledgerWindowMs = PERP_ACCOUNT_LEDGER_WINDOW_MS,
  roleRecheckMs = PERP_ACCOUNT_ROLE_RECHECK_MS,
  idleKept = PERP_ACCOUNT_IDLE_KEPT,
} = {}) {
  const sock = () => (ws || (getWs ? getWs() : hlWs()));
  const sessions = new Map();        // address -> session
  const placeholders = new Map();    // address -> blank snapshot, stable per address
  const listeners = new Set();
  let offStatus = null;
  let offVis = null;

  const clear = (id) => { if (id != null) timers.clearTimeout(id); return null; };
  const held = () => [...sessions.values()].filter((s) => s.holds > 0);
  const attributable = () => held().length <= 1;

  function notify() {
    for (const fn of [...listeners]) { try { fn(); } catch { /* a listener's bug stays its own */ } }
  }

  /* ── building the snapshot ─────────────────────────────────────────── */

  /* Derived maps are rebuilt only when their source list changes, so a push
     that moves one figure does not hand every consumer new objects. */
  function memo(s, key, source, make) {
    const m = s.memo[key];
    if (m && m.source === source) return m.value;
    const value = Object.freeze(make(source));
    s.memo[key] = { source, value };
    return value;
  }

  /* The same, for a value two sources decide (the main dex's list and the
     venues'): both have to be the ones it was built from. */
  function memo2(s, key, a, b, make) {
    const m = s.memo[key];
    if (m && m.a === a && m.b === b) return m.value;
    const value = Object.freeze(make(a, b));
    s.memo[key] = { a, b, value };
    return value;
  }

  /* Every venue this session holds — or NULL while any one of them is still
     unread. A part of the account is not the account: a list or an equity that
     quietly left a venue out would be a WRONG figure, where null is an honest
     unknown the screens already print as a dash (MONEY_RULES section 0). */
  function venueRowsOf(s) {
    if (s.venueNames == null) return null;
    const out = [];
    for (const dex of s.venueNames) {
      const v = s.venues.get(dex);
      if (!v || !v.stateAnswered || !v.ordersAnswered) return null;
      out.push(v);
    }
    return out;
  }

  /* One list, main dex first. A venue coin name is qualified ("xyz:TSLA") and so
     unique, which is why keying by coin afterwards is safe. */
  function joinPositions(main, rows) {
    if (!rows || !rows.length) return main;
    let out = null;
    for (const v of rows) {
      if (!v.state.positions.length) continue;
      out = out || [...main];
      out.push(...v.state.positions);
    }
    return out || main;
  }

  function joinOrders(main, rows) {
    if (!rows || !rows.length) return main;
    let out = null;
    for (const v of rows) {
      if (!v.orders.length) continue;
      out = out || [...main];
      out.push(...v.orders);
    }
    return out || main;
  }

  function build(s) {
    const f = s.figs;
    const perp = f.perp.answered ? s.perp : null;
    const spot = f.spot.answered ? s.spot : null;
    const rows = memo(s, "venueRows", s.venueEpoch, () => venueRowsOf(s));
    let balance = resolvePerpBalance({
      role: f.role.answered ? s.role : null,
      master: s.master,
      mode: f.mode.answered ? s.mode : null,
      perp,
      spot,
      venues: rows ? rows.map((v) => v.state) : null,
    });
    /* The venues have not answered yet: the figure is the main dex's, and it says
       it is not the whole account rather than presenting itself as final. */
    if (balance.answered && balance.source === "perp" && balance.reason == null && rows == null) {
      balance = { ...balance, complete: null, incompleteReason: "perp-venues-unanswered" };
    }
    const mainPositions = perp ? perp.positions : EMPTY_LIST;
    const mainOrders = f.openOrders.answered && s.orders ? s.orders : EMPTY_LIST;
    const positions = memo2(s, "positionList", mainPositions, rows, joinPositions);
    const orders = memo2(s, "orderList", mainOrders, rows, joinOrders);
    const fills = s.fills;
    const partial = s.fillsPartial;
    const errors = STATE_FIGURES.map((k) => f[k].error).filter(Boolean);
    const ready = balance.answered && f.perp.answered && f.openOrders.answered;
    return Object.freeze({
      address: s.address,
      ready,
      loading: s.inflight != null,
      stale: s.staleSince != null,
      staleSince: s.staleSince,
      error: errors.length ? errors[errors.length - 1] : null,
      updatedAt: s.updatedAt,
      role: Object.freeze({ value: f.role.answered ? s.role : null, master: s.master, answered: f.role.answered }),
      mode: Object.freeze({ value: f.mode.answered ? s.mode : null, source: f.mode.answered ? balanceSourceFor(s.mode) : null, answered: f.mode.answered }),
      perpBalanceUsdc: Object.freeze(balance),
      positions: Object.freeze({
        answered: f.perp.answered,
        list: positions,
        byCoin: memo(s, "positions", positions, positionsByCoin),
        /* A REAL true: the venues are in the list above, not counted beside it. */
        complete: rows ? true : null,
      }),
      orders: Object.freeze({ answered: f.openOrders.answered, list: orders, tpslByCoin: memo(s, "tpsl", orders, tpslByCoin) }),
      fills: Object.freeze({
        answered: f.fills.answered,
        list: fills,
        byCoin: memo(s, "fills", fills, fillsByCoin),
        partial,
        cap: HL_FILLS_CAP,
        oldestTime: partial && fills.length ? fills[fills.length - 1].time : null,
      }),
      ledger: Object.freeze({ answered: f.ledger.answered, list: s.ledger, inbound: memo(s, "inbound", s.ledger, (l) => l.filter((x) => x.direction === "in")) }),
      events: s.events,
      agent: Object.freeze({ ...s.agent }),
      server: Object.freeze({ ...s.server }),
      /* What each venue pot holds, for the code that MOVES it (the exchange
         layer's collateral top-up and sweep) and for the diagnostics sheet.
         Every figure here is also inside perpBalanceUsdc and the lists above:
         this is the same money named per pot, never an extra total. */
      venues: Object.freeze({
        answered: rows != null,
        list: rows == null ? EMPTY_LIST : memo(s, "venueList", s.venueEpoch, () => rows.map((v) => Object.freeze({
          dex: v.dex,
          equityUsdc: v.state.accountValue,
          availableUsdc: v.state.withdrawable,
          positions: v.state.positions.length,
          orders: v.orders.length,
        }))),
      }),
      streams: Object.freeze({ rejected: Object.freeze([...s.rejected].sort()), attributable: attributable() }),
    });
  }

  function emit(s) {
    s.snap = build(s);
    notify();
  }

  function emitAll() {
    for (const s of sessions.values()) s.snap = build(s);
    notify();
  }

  /* ── stale and fresh ───────────────────────────────────────────────── */

  function markStale(s) {
    if (s.staleSince != null) return;
    s.staleSince = now();
    s.freshAfter = new Set();
  }

  function markFresh(s, name, at) {
    if (s.staleSince == null || at < s.staleSince) return;
    s.freshAfter.add(name);
    if (FRESH_SET.every((k) => s.freshAfter.has(k))) s.staleSince = null;
  }

  /* ── events ────────────────────────────────────────────────────────── */

  function addEvents(s, incoming, { live }) {
    if (!incoming.length) return false;
    const r = mergeEvents(s.events, incoming);
    s.events = Object.freeze(r.events);
    if (!r.added.length) return false;
    for (const e of r.added) {
      /* News: a live push, or something that happened while the stream was
         down (read by the resubscribe snapshot). Old history is not news. */
      const isNews = live || (s.gapFrom != null && e.time != null && e.time >= s.gapFrom);
      if (!isNews) continue;
      for (const fn of [...s.eventFns]) { try { fn(e); } catch { /* its own */ } }
    }
    return true;
  }

  /* ── REST ──────────────────────────────────────────────────────────── */

  /* One venue slot per dex this session holds: its own clearinghouse and its own
     open orders, each with the time the last STREAM push for it arrived (so a
     slower REST answer cannot roll a live figure back, the same rule the main
     dex follows). */
  function venueSlot(s, dex) {
    let v = s.venues.get(dex);
    if (!v) {
      v = { dex, state: null, stateAnswered: false, stateAt: null, orders: EMPTY_LIST, ordersAnswered: false, ordersAt: null };
      s.venues.set(dex, v);
    }
    return v;
  }

  function applyVenueState(v, p, at, live) {
    if (!p) return false;
    if (!live && v.stateAt != null && v.stateAt >= at) return false;
    if (v.state && v.state.time != null && p.time != null && p.time < v.state.time) return false;
    v.state = p;
    v.stateAnswered = true;
    if (live) v.stateAt = at;
    return true;
  }

  function applyVenueOrders(v, list, at, live) {
    if (!Array.isArray(list)) return false;
    if (!live && v.ordersAt != null && v.ordersAt >= at) return false;
    v.orders = list;
    v.ordersAnswered = true;
    if (live) v.ordersAt = at;
    return true;
  }

  /**
   * The HIP-3 venues, read as part of the account.
   *
   * The venue NAMES come from the live perpDexs answer crossed with this build's
   * own list (venues.js resolveVenues), so a venue that is configured but not
   * listed is left out rather than asked about — measured 2026-09-23, a dex name
   * Hyperliquid does not know answers HTTP 500, which would have put a permanent
   * error beside the balance. They are resolved ONCE per session: the set changes
   * when Hyperliquid lists a new venue, not while a page is open.
   *
   * Only the name is read from that answer here. The INDEX, which is the
   * dangerous part (it decides an order's asset id), is nobody's business but
   * markets.js's.
   */
  async function readVenues(s) {
    if (s.venueNames == null) {
      const dexs = await info({ type: "perpDexs" });
      if (!Array.isArray(dexs)) throw new Error("Hyperliquid answered an unexpected perp market list");
      s.venueNames = Object.freeze(resolveVenues(dexs).map((v) => v.dex));
      s.venueEpoch++;
    }
    return Promise.all(s.venueNames.map(async (dex) => {
      const [chJson, ooJson] = await Promise.all([
        info({ type: "clearinghouseState", user: s.address, dex }),
        info({ type: "frontendOpenOrders", user: s.address, dex }),
      ]);
      const state = parseClearinghouse(chJson, { dex });
      if (!state) throw new Error("Hyperliquid answered an unreadable Perp state");
      const orders = parseOpenOrders(ooJson);
      if (!orders) throw new Error("Hyperliquid answered unreadable open orders");
      return { dex, state, orders };
    }));
  }

  /* ctx.fillsSince: the fill anchor when this request set was sent (null: read the full page). */
  function request(s, name, sentAt, ctx) {
    const a = s.address;
    switch (name) {
      case "role": return info({ type: "userRole", user: a });
      case "mode": return info({ type: "userAbstraction", user: a });
      case "perp": return info({ type: "clearinghouseState", user: a, dex: "" });
      case "spot": return info({ type: "spotClearinghouseState", user: a });
      case "openOrders": return info({ type: "frontendOpenOrders", user: a });
      case "fills":
        return ctx.fillsSince != null
          ? info({ type: "userFillsByTime", user: a, startTime: ctx.fillsSince })
          : info({ type: "userFills", user: a });
      case "ledger": return info({ type: "userNonFundingLedgerUpdates", user: a, startTime: sentAt - ledgerWindowMs });
      case "venues": return readVenues(s);
      default: return Promise.reject(new Error(`unknown figure ${name}`));
    }
  }

  /* Apply one REST answer. Returns false when the answer could not be read. */
  function apply(s, name, json, sentAt, ctx) {
    const f = s.figs[name];
    const streamNewer = f.wsAt != null && f.wsAt >= sentAt;
    switch (name) {
      case "role": {
        const r = parseUserRole(json);
        if (!r.role) return false;
        s.role = r.role;
        s.master = r.master;
        s.roleRetried = false;
        break;
      }
      case "mode": {
        const m = parseUserAbstraction(json);
        if (m == null) return false;
        if (!streamNewer) s.mode = m;
        break;
      }
      case "perp": {
        const p = parseClearinghouse(json, { dex: "" });
        if (!p) return false;
        if (!streamNewer && !(s.perp && s.perp.time != null && p.time != null && p.time < s.perp.time)) s.perp = p;
        break;
      }
      case "spot": {
        const p = parseSpotState(json);
        if (!p) return false;
        if (!streamNewer) s.spot = p;
        break;
      }
      case "openOrders": {
        const p = parseOpenOrders(json);
        if (!p) return false;
        if (!streamNewer) s.orders = p;
        break;
      }
      case "fills": {
        const p = parseFills(json);
        if (!p) return false;
        const over = overflows(s.fills, p);
        s.fills = Object.freeze(mergeFills(s.fills, p));
        const newest = newestTime(p);
        if (ctx.fillsSince == null) {
          /* The full page: the most recent HL_FILLS_CAP fills. An empty
             history gives no anchor, and its next full read is as cheap. */
          s.fillsPartial = over || fillsPartial(p.length);
          s.fillsAnchor = newest;
        } else if (p.length >= HL_FILLS_CAP) {
          /* A full page of the gap: fills past it may be missing. Say so,
             and read the newest page in full right after this set. */
          s.fillsPartial = true;
          s.fillsAnchor = null;
          s.queued.add("fills");
        } else {
          s.fillsPartial = s.fillsPartial === true || over;
          s.fillsAnchor = newest != null && newest > ctx.fillsSince ? newest : ctx.fillsSince;
        }
        addEvents(s, eventsFromFills(p, s.address), { live: false });
        break;
      }
      case "ledger": {
        const p = parseLedger(json, s.address);
        if (!p) return false;
        s.ledger = Object.freeze(mergeLedger(s.ledger, p));
        addEvents(s, eventsFromLedger(p), { live: false });
        break;
      }
      case "venues": {
        if (!Array.isArray(json)) return false;
        for (const row of json) {
          const v = venueSlot(s, row.dex);
          applyVenueState(v, row.state, sentAt, false);
          applyVenueOrders(v, row.orders, sentAt, false);
        }
        s.venueEpoch++;
        /* The names are known now, so the pair of streams per venue can go up. */
        subscribeVenues(s);
        break;
      }
      default:
        return false;
    }
    f.answered = true;
    f.error = null;
    markFresh(s, name, sentAt);
    return true;
  }

  /* ONE RE-ASK FOR THE ROLE, AND FOR NOTHING ELSE.
     Measured 2026-09-28: this read is 18 bytes and answers in 0.21-0.48s, and
     it is the ONE figure a deposit is priced on — the deposit sheet asks
     whether this account exists yet, and an account that cannot be asked is
     treated as one that does, which hands a first-time customer the route that
     pays a one-time cost of about 1.21 USDC instead of the one that costs about
     0.07. Every other figure here is a number on a screen that a poll will
     correct a few seconds later; this one decides where money goes, and the
     answer was thrown away on the first refusal because nothing in this file
     ever asks twice.
     Once per answered role, never a loop: the flag is only lowered by a role
     that actually came back, so a second failure waits for the next poll like
     everything else, and a busy endpoint cannot be hammered by a screen. The
     wait is the one this file already uses to look again after a credit, and a
     session nobody holds re-asks nothing. */
  function retryRoleOnce(s) {
    if (s.roleRetried || s.holds < 1) return;
    s.roleRetried = true;
    s.roleT = clear(s.roleT);
    s.roleT = timers.setTimeout(() => { s.roleT = null; if (s.holds > 0) refresh(s, ["role"]); }, roleRecheckMs);
  }

  function wantedFigures(s, asked) {
    const t = now();
    return asked.filter((name) => {
      if (name === "role") return !s.figs.role.answered || s.role === "missing";
      return true;
    });
  }

  function refresh(s, asked = STATE_FIGURES) {
    if (s.inflight) {
      for (const n of asked) s.queued.add(n);
      return s.inflight;
    }
    const names = wantedFigures(s, asked);
    if (!names.length) return Promise.resolve();
    const sentAt = now();
    const ctx = { fillsSince: s.fillsAnchor };
    const jobs = names.map((name) => {
      let p;
      try { p = Promise.resolve(request(s, name, sentAt, ctx)); } catch (e) { p = Promise.reject(e); }
      return p.then(
        (json) => {
          try {
            if (!apply(s, name, json, sentAt, ctx)) s.figs[name].error = `Hyperliquid answered an unreadable ${name} state`;
          } catch (e) {
            s.figs[name].error = messageOf(e);
          }
        },
        (e) => { s.figs[name].error = messageOf(e); },
      ).then(() => { if (name === "role" && s.figs.role.error) retryRoleOnce(s); });
    });
    /* Every job settles (each catches its own failure), so the in-flight
       marker is always cleared and the next refresh can run. */
    s.inflight = Promise.all(jobs).then(() => {
      s.inflight = null;
      s.updatedAt = now();
      emit(s);
      schedulePoll(s);
      if (s.queued.size && s.holds > 0) {
        const next = [...s.queued];
        s.queued.clear();
        refresh(s, next);
      }
    });
    emit(s);
    return s.inflight;
  }

  /* ── the REST fallback for rejected streams ────────────────────────── */

  function fallbackFigures(s) {
    const out = [];
    for (const st of STREAMS) if (st.figure && s.rejected.has(st.type)) out.push(st.figure);
    /* A venue rides the SAME two stream types as the main dex, so either of them
       being rejected leaves the venue figures to REST as well. */
    if (s.venueNames != null && s.venueNames.length && VENUE_STREAMS.some((t) => s.rejected.has(t))) out.push("venues");
    return out;
  }

  function schedulePoll(s) {
    s.pollT = clear(s.pollT);
    if (s.holds === 0 || !s.rejected.size || isHidden()) return;
    s.pollT = timers.setTimeout(() => {
      s.pollT = null;
      if (s.holds === 0 || isHidden()) return;
      const figs = fallbackFigures(s);
      if (figs.length) refresh(s, figs); else schedulePoll(s);
    }, pollMs);
  }

  /* ── stream handlers ───────────────────────────────────────────────── */

  const mine = (s, user) => normAddress(user) === s.address;

  function onStream(s, type, data) {
    if (s.holds === 0) return;
    const at = now();
    switch (type) {
      case "webData3": {
        const us = data && data.userState;
        if (!us || !mine(s, us.user)) return;
        s.server = { time: num(us.serverTime), at };
        const agent = { answered: true, address: normAddress(us.agentAddress), validUntil: num(us.agentValidUntil) };
        const m = parseUserAbstraction(us.abstraction);
        const agentChanged = !s.agent.answered || agent.address !== s.agent.address || agent.validUntil !== s.agent.validUntil;
        const modeChanged = m != null && (m !== s.mode || !s.figs.mode.answered);
        s.agent = agent;
        if (m != null) {
          s.mode = m;
          s.figs.mode.answered = true;
          s.figs.mode.wsAt = at;
        }
        /* A push that only moves the server clock is not re-rendered; read
           serverClock() for it. */
        if (agentChanged || modeChanged) emit(s);
        return;
      }
      case "clearinghouseState": {
        if (!data || !mine(s, data.user)) return;
        /* WHICH POT THIS PUSH IS ABOUT. ws.js routes a user stream by its channel,
           so the main-dex handler and every venue handler are handed each other's
           pushes; the dex on the push is what tells them apart, and a dex this
           session does not hold is not this session's business. A push with no dex
           at all is the main one, as it has always been. */
        const dex = typeof data.dex === "string" ? data.dex : "";
        if (dex !== "") {
          const v = s.venues.get(dex);
          if (!v) return;
          const vp = parseClearinghouse(data);
          if (!applyVenueState(v, vp, at, true)) return;
          s.venueEpoch++;
          s.figs.venues.error = null;
          emit(s);
          return;
        }
        const p = parseClearinghouse(data);
        if (!p) return;
        if (s.perp && s.perp.time != null && p.time != null && p.time < s.perp.time) return;
        s.perp = p;
        s.figs.perp.answered = true;
        s.figs.perp.wsAt = at;
        s.figs.perp.error = null;
        markFresh(s, "perp", at);
        emit(s);
        return;
      }
      case "spotState": {
        if (!data || !mine(s, data.user)) return;
        const p = parseSpotState(data);
        if (!p) return;
        s.spot = p;
        s.figs.spot.answered = true;
        s.figs.spot.wsAt = at;
        s.figs.spot.error = null;
        markFresh(s, "spot", at);
        emit(s);
        return;
      }
      case "openOrders": {
        if (!data || !mine(s, data.user)) return;
        const dex = typeof data.dex === "string" ? data.dex : "";
        if (dex !== "") {
          const v = s.venues.get(dex);
          if (!v) return;
          if (!applyVenueOrders(v, parseOpenOrders(data), at, true)) return;
          s.venueEpoch++;
          s.figs.venues.error = null;
          emit(s);
          return;
        }
        const p = parseOpenOrders(data);
        if (!p) return;
        s.orders = p;
        s.figs.openOrders.answered = true;
        s.figs.openOrders.wsAt = at;
        s.figs.openOrders.error = null;
        markFresh(s, "openOrders", at);
        emit(s);
        return;
      }
      case "userFills": {
        if (!data || !mine(s, data.user)) return;
        const p = parseFills(data);
        if (!p) return;
        const snapshot = data.isSnapshot === true;
        const known = new Set(s.fills.map((x) => x.tid));
        const fresh = p.filter((x) => !known.has(x.tid));
        /* Past the cap the merge drops the oldest: the list is then no longer
           the whole history, whatever the last REST page said. */
        if (overflows(s.fills, p)) s.fillsPartial = true;
        s.fills = Object.freeze(mergeFills(s.fills, p));
        if (snapshot) s.figs.fills.answered = true;
        addEvents(s, eventsFromFills(fresh, s.address), { live: !snapshot });
        emit(s);
        return;
      }
      case "userNonFundingLedgerUpdates": {
        if (!data || !mine(s, data.user)) return;
        const p = parseLedger(data, s.address);
        if (!p) return;
        const snapshot = data.isSnapshot === true;
        s.ledger = Object.freeze(mergeLedger(s.ledger, p));
        if (snapshot) s.figs.ledger.answered = true;
        addEvents(s, eventsFromLedger(p), { live: !snapshot });
        /* A credit to an address the venue called never-used: ask again. */
        if (!snapshot && s.role === "missing" && p.some((l) => l.direction === "in")) {
          s.roleT = clear(s.roleT);
          s.roleT = timers.setTimeout(() => { s.roleT = null; if (s.holds > 0) refresh(s, ["role"]); }, roleRecheckMs);
        }
        emit(s);
        return;
      }
      case "userEvents": {
        /* A liquidation names its victim; a system cancel names nobody. */
        const events = eventsFromUserEvents(data, s.address, at)
          .filter((e) => e.kind === "liquidation" || attributable());
        if (addEvents(s, events, { live: true })) emit(s);
        return;
      }
      case "orderUpdates": {
        if (!attributable()) return;
        if (addEvents(s, eventsFromOrderUpdates(data), { live: true })) emit(s);
        return;
      }
      case "notification": {
        if (!attributable()) return;
        const e = eventFromNotification(data, at);
        if (e && addEvents(s, [e], { live: true })) emit(s);
        return;
      }
      default:
    }
  }

  function onRejected(s, type) {
    if (s.rejected.has(type)) return;
    s.rejected.add(type);
    emit(s);
    const figs = fallbackFigures(s);
    if (figs.length && !isHidden()) schedulePoll(s);
  }

  /* ── socket status and page visibility ─────────────────────────────── */

  function onWsStatus(st) {
    for (const s of held()) {
      if (st === "open") {
        s.wsSeenOpen = true;
        if (s.wsLost) {
          s.wsLost = false;
          refresh(s, STATE_FIGURES);
        }
      } else if (st === "reconnecting" || st === "paused" || st === "idle") {
        s.wsLost = true;
        if (s.wsSeenOpen) {
          if (s.gapFrom == null || s.staleSince == null) s.gapFrom = now();
          const was = s.staleSince;
          markStale(s);
          if (was == null) emit(s);
        }
      }
    }
  }

  function onVis() {
    for (const s of held()) {
      if (isHidden()) { s.pollT = clear(s.pollT); continue; }
      const figs = fallbackFigures(s);
      if (figs.length && !s.inflight) refresh(s, figs);
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

  function newSession(address) {
    const s = {
      address,
      holds: 0,
      offs: [],
      figs: { role: fig(), mode: fig(), perp: fig(), spot: fig(), openOrders: fig(), fills: fig(), ledger: fig(), venues: fig() },
      role: null,
      master: null,
      mode: null,
      perp: null,
      spot: null,
      orders: null,
      fills: EMPTY_LIST,
      fillsPartial: null,
      fillsAnchor: null,
      ledger: EMPTY_LIST,
      /* The HIP-3 venues this session holds: their names (resolved once, kept
         across a release so a return resubscribes at once) and one slot each. */
      venueNames: null,
      venues: new Map(),
      venueEpoch: 0,
      venueSubs: null,
      events: EMPTY_LIST,
      eventFns: new Set(),
      agent: { answered: false, address: null, validUntil: null },
      server: { time: null, at: null },
      rejected: new Set(),
      staleSince: null,
      freshAfter: new Set(),
      gapFrom: null,
      wsLost: false,
      wsSeenOpen: false,
      inflight: null,
      queued: new Set(),
      updatedAt: null,
      pollT: null,
      roleT: null,
      roleRetried: false,
      memo: Object.create(null),
      snap: null,
    };
    s.snap = build(s);
    return s;
  }

  function subscribeStreams(s) {
    const w = sock();
    for (const st of STREAMS) {
      const sub = st.dex ? { type: st.type, user: s.address, dex: "" } : { type: st.type, user: s.address };
      s.offs.push(w.subscribe(sub, (data) => onStream(s, st.type, data), { onError: () => onRejected(s, st.type) }));
    }
  }

  /* The pair of streams each venue rides, once the names are known. A returning
     session already knows them and subscribes at once; a first one subscribes as
     soon as the venues figure answers. hlSubKey includes the dex, so these are
     distinct subscriptions from the main dex's and the server sees one of each. */
  function subscribeVenues(s) {
    if (s.venueSubs != null || s.venueNames == null || s.holds === 0) return;
    const w = sock();
    s.venueSubs = [];
    for (const dex of s.venueNames) {
      for (const type of VENUE_STREAMS) {
        venueSlot(s, dex);
        const off = w.subscribe({ type, user: s.address, dex }, (data) => onStream(s, type, data), { onError: () => onRejected(s, type) });
        s.venueSubs.push(off);
        s.offs.push(off);
      }
    }
  }

  function evictIdle() {
    const idle = [...sessions.values()].filter((s) => s.holds === 0 && s.eventFns.size === 0);
    while (idle.length > idleKept) {
      const s = idle.shift();
      sessions.delete(s.address);
    }
  }

  function retain(addressIn) {
    const address = normAddress(addressIn);
    if (!address) return () => {};
    let s = sessions.get(address);
    if (!s) { s = newSession(address); sessions.set(address, s); }
    else if (s.holds === 0) { sessions.delete(address); sessions.set(address, s); }
    s.holds++;
    if (s.holds === 1) {
      attachShared();
      /* The shared socket may already be up (the market list streams on it)
         or paused (a hidden tab): no transition will announce that, so start
         from where it is. */
      const w = sock();
      const st = typeof w.status === "function" ? w.status() : null;
      s.wsSeenOpen = st === "open";
      s.wsLost = st === "paused" || st === "reconnecting";
      subscribeStreams(s);
      subscribeVenues(s);
      refresh(s, STATE_FIGURES);
      emitAll();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      s.holds--;
      if (s.holds > 0) return;
      for (const off of s.offs.splice(0)) { try { off(); } catch { /* already gone */ } }
      s.venueSubs = null;
      s.pollT = clear(s.pollT);
      s.roleT = clear(s.roleT);
      s.queued.clear();
      s.rejected.clear();
      /* Nobody maintains this session any more: the next surface sees its
         figures flagged until fresh data lands. */
      markStale(s);
      s.gapFrom = null;
      detachShared();
      evictIdle();
      emitAll();
    };
  }

  function onEvent(addressIn, fn) {
    const address = normAddress(addressIn);
    if (!address || typeof fn !== "function") return () => {};
    let s = sessions.get(address);
    if (!s) { s = newSession(address); sessions.set(address, s); }
    s.eventFns.add(fn);
    return () => { s.eventFns.delete(fn); };
  }

  function watchEvents(addressIn, fn) {
    const release = retain(addressIn);
    const off = onEvent(addressIn, fn);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      release();
    };
  }

  return {
    /** Listen for any change (for useSyncExternalStore). Returns the remover. */
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    /** The frozen snapshot for an address; stable until something changes. */
    getSnapshot(addressIn) {
      const address = normAddress(addressIn);
      if (!address) return PERP_ACCOUNT_EMPTY;
      const s = sessions.get(address);
      if (s) return s.snap;
      let p = placeholders.get(address);
      if (!p) {
        if (placeholders.size > 16) placeholders.clear();
        p = blankSnapshot(address);
        placeholders.set(address, p);
      }
      return p;
    },
    /** Keep an address streamed. Returns the release function. */
    retain,
    /**
     * Read again now what an action moves (call it right after an order, a
     * cancel, a TP/SL, a leverage change or a withdrawal): perp, spot, open
     * orders, the fills since the newest one read, the ledger. The mode too
     * when its stream was rejected.
     */
    refresh(addressIn) {
      const s = sessions.get(normAddress(addressIn));
      if (!s || s.holds === 0) return Promise.resolve();
      return refresh(s, s.rejected.has("webData3") ? [...ACTION_FIGURES, "mode"] : ACTION_FIGURES);
    },
    /**
     * Live events for an address (liquidation, adl, systemCancel, order,
     * notification): only news, never history. Toast the ones with lead true.
     */
    onEvent,
    /**
     * onEvent AND retain in one: a toast host mounted with no Perp page open
     * still gets its liquidation news, because the streams stay up while it
     * listens. One cleanup undoes both; the streams are shared (refcounted)
     * with any page on the same address.
     */
    watchEvents,
    /**
     * watchEvents narrowed to what a page toasts first: a liquidation or an
     * auto-deleveraging, leads only (one occurrence, one call), news only.
     */
    watchRiskEvents(addressIn, fn) {
      if (typeof fn !== "function") return () => {};
      return watchEvents(addressIn, (e) => { if (isPerpRiskEvent(e)) fn(e); });
    },
    /** The last server time webData3 reported and when it arrived here (for clock skew). */
    serverClock(addressIn) {
      const s = sessions.get(normAddress(addressIn));
      return s ? { ...s.server } : { time: null, at: null };
    },
  };
}
