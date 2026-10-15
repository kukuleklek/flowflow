/**
 * test-hl-user-events — the user-event feed reaches its subscribers.
 *
 *   node --test scripts/test-hl-user-events.mjs
 *
 * Slice 3's account builder reported that userEvents never arrived: the tab's
 * one socket (lib/hyperliquid/ws.js) matched a push to a subscription by
 * CHANNEL === subscription type, and Hyperliquid sends userEvents on channel
 * "user" (websocket subscriptions page; @nktkas/hyperliquid 0.33.3
 * api/subscription/_methods/userEvents.js subscribes to channel "user"). So a
 * liquidation that only userEvents carried never reached the account store.
 *
 * Pinned here, over the REAL ws.js on a fake socket (no network):
 *   U1-U3  every documented userEvents shape arrives on channel "user" and
 *          reaches the userEvents subscriber, and only it; notification pushes
 *          reach the notification subscriber;
 *   U4     an EVENT stream (userEvents, notification, orderUpdates) is never
 *          replayed to a late subscriber: an event is not a state, and a replay
 *          would toast a liquidation twice;
 *   U5     a push that NAMES another user does not reach this user's handler;
 *   U6-U9  through the REAL account store: a liquidation carried by userEvents
 *          alone is a live lead event; ADL from the fill stream; one occurrence
 *          reported by three streams is one lead; the risk stream (liquidation
 *          and ADL only, leads only) that a page toasts.
 *
 * The message shapes are the documented ones (WsUserEvent, Notification,
 * WsFill), with the field names Hyperliquid uses (liquidated_user, lid, ...).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { B, C, ADDR } from "./test-hl-account-fixtures.mjs";

globalThis.fetch = () => { throw new Error("test-hl-user-events: a real network call was attempted"); };

const { createHlWs } = await import("../src/lib/hyperliquid/ws.js");
const { createPerpAccountStore } = await import("../src/lib/hyperliquid/account/store.js");
const EV = await import("../src/lib/hyperliquid/account/events.js");

/* ── fakes ─────────────────────────────────────────────────────────────── */

function fakeClock(start = 1_790_070_500_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best[1].at)) best = [id, x];
        if (!best) break;
        timers.delete(best[0]);
        t = best[1].at;
        best[1].fn();
      }
      t = end;
    },
  };
}

function realWs(clock = fakeClock()) {
  const sockets = [];
  const ws = createHlWs({
    createSocket: (url) => {
      const s = {
        url, readyState: 0, sent: [],
        onopen: null, onmessage: null, onclose: null, onerror: null,
        send(x) { s.sent.push(JSON.parse(x)); },
        close() { s.readyState = 3; },
      };
      sockets.push(s);
      return s;
    },
    timers: clock.timers, now: clock.now, random: () => 0.5, isHidden: () => false, onVisibilityChange: () => () => {},
  });
  const sock = () => sockets[sockets.length - 1];
  return {
    ws, clock, sockets,
    open() { const s = sock(); s.readyState = 1; s.onopen({}); return s; },
    recv(obj) { sock().onmessage({ data: JSON.stringify(obj) }); },
  };
}

const LIQUIDATOR = "0x5555555555555555555555555555555555555555";

/* The documented WsUserEvent variants, as they arrive (channel "user"). */
const USER_EVENTS = (user) => ({
  liquidation: { channel: "user", data: { liquidation: { lid: 77, liquidator: LIQUIDATOR, liquidated_user: user, liquidated_ntl_pos: "15000.0", liquidated_account_value: "10.0" } } },
  nonUserCancel: { channel: "user", data: { nonUserCancel: [{ coin: "ETH", oid: 4 }] } },
  fills: { channel: "user", data: { fills: [{ coin: "BTC", px: "99000.0", sz: "0.1", side: "B", time: 1_790_070_500_000, startPosition: "0.0", dir: "Open Long", closedPnl: "0.0", hash: "0xabc", oid: 1, crossed: true, fee: "1.0", tid: 5, feeToken: "USDC" }] } },
  funding: { channel: "user", data: { funding: { time: 1_790_070_500_000, coin: "ETH", usdc: "-0.12", szi: "1.0", fundingRate: "0.0000125", nSamples: null } } },
});

/* ── U. the socket's routing ───────────────────────────────────────────── */

test("U1) a liquidation pushed on channel \"user\" reaches the userEvents subscriber", () => {
  const r = realWs();
  const got = [];
  r.ws.subscribe({ type: "userEvents", user: ADDR.B }, (d) => got.push(d));
  const s = r.open();
  assert.deepEqual(s.sent.filter((m) => m.method === "subscribe").map((m) => m.subscription), [{ type: "userEvents", user: ADDR.B }]);
  r.recv(USER_EVENTS(ADDR.B).liquidation);
  assert.equal(got.length, 1, "the userEvents push was dropped: channel user is not matched to the userEvents subscription");
  assert.equal(got[0].liquidation.liquidated_user, ADDR.B);
});

test("U2) every documented userEvents shape reaches the userEvents subscriber, and no other stream's subscriber", () => {
  const r = realWs();
  const seen = { userEvents: [], userFills: [], notification: [], orderUpdates: [] };
  for (const type of Object.keys(seen)) r.ws.subscribe({ type, user: ADDR.B }, (d) => seen[type].push(d));
  r.open();
  const shapes = USER_EVENTS(ADDR.B);
  for (const k of Object.keys(shapes)) r.recv(shapes[k]);
  assert.deepEqual(seen.userEvents.map((d) => Object.keys(d)[0]), ["liquidation", "nonUserCancel", "fills", "funding"]);
  assert.deepEqual(seen.userFills, []);
  assert.deepEqual(seen.notification, []);
  assert.deepEqual(seen.orderUpdates, []);
});

test("U3) a notification push reaches the notification subscriber (and not userEvents)", () => {
  const r = realWs();
  const note = [];
  const user = [];
  r.ws.subscribe({ type: "notification", user: ADDR.B }, (d) => note.push(d));
  r.ws.subscribe({ type: "userEvents", user: ADDR.B }, (d) => user.push(d));
  r.open();
  r.recv({ channel: "notification", data: { notification: "Your stop loss order for BTC was triggered" } });
  assert.deepEqual(note, [{ notification: "Your stop loss order for BTC was triggered" }]);
  assert.deepEqual(user, []);
});

test("U4) an EVENT stream is never replayed to a late subscriber; a STATE stream still is", () => {
  const r = realWs();
  const keep = [];
  r.ws.subscribe({ type: "userEvents", user: ADDR.B }, () => {});
  r.ws.subscribe({ type: "notification", user: ADDR.B }, () => {});
  r.ws.subscribe({ type: "orderUpdates", user: ADDR.B }, () => {});
  r.ws.subscribe({ type: "clearinghouseState", user: ADDR.B, dex: "" }, (d) => keep.push(d));
  r.open();
  r.recv(USER_EVENTS(ADDR.B).liquidation);
  r.recv({ channel: "notification", data: { notification: "Order filled" } });
  r.recv({ channel: "orderUpdates", data: [{ order: { coin: "BTC", side: "B", limitPx: "1", sz: "0", oid: 9, timestamp: 1, origSz: "1" }, status: "filled", statusTimestamp: 2 }] });
  r.recv({ channel: "clearinghouseState", data: { dex: "", user: ADDR.B, clearinghouseState: B.clearinghouseState } });
  const late = [];
  for (const type of ["userEvents", "notification", "orderUpdates"]) r.ws.subscribe({ type, user: ADDR.B }, (d) => late.push([type, d]));
  assert.deepEqual(late, [], "a late subscriber must not receive an old event as if it just happened");
  const lateState = [];
  r.ws.subscribe({ type: "clearinghouseState", user: ADDR.B, dex: "" }, (d) => lateState.push(d));
  assert.equal(lateState.length, 1, "a state stream still hands its last message to a late subscriber");
});

test("U5) a push that NAMES another user does not reach this user's handler; a push naming nobody reaches every subscriber of its stream", () => {
  const r = realWs();
  const got = { B: [], C: [], evB: [], evC: [], wB: [] };
  r.ws.subscribe({ type: "clearinghouseState", user: ADDR.B, dex: "" }, (d) => got.B.push(d));
  r.ws.subscribe({ type: "clearinghouseState", user: ADDR.C, dex: "" }, (d) => got.C.push(d));
  r.ws.subscribe({ type: "userEvents", user: ADDR.B }, (d) => got.evB.push(d));
  r.ws.subscribe({ type: "userEvents", user: ADDR.C }, (d) => got.evC.push(d));
  r.ws.subscribe({ type: "webData3", user: ADDR.B }, (d) => got.wB.push(d));
  r.open();
  r.recv({ channel: "clearinghouseState", data: { dex: "", user: ADDR.C, clearinghouseState: C.clearinghouseState } });
  assert.equal(got.B.length, 0, "B's handler never sees C's account");
  assert.equal(got.C.length, 1);
  r.recv({ channel: "clearinghouseState", data: { dex: "", user: ADDR.B.toUpperCase().replace("0X", "0x"), clearinghouseState: B.clearinghouseState } });
  assert.equal(got.B.length, 1, "the address is compared case-insensitively");
  r.recv({ channel: "webData3", data: { userState: { user: ADDR.C, serverTime: 1 } } });
  assert.equal(got.wB.length, 0, "webData3 names its user inside userState");
  r.recv(USER_EVENTS(ADDR.C).nonUserCancel);
  assert.equal(got.evB.length, 1, "userEvents carry no user: every userEvents subscriber receives them (the store attributes)");
  assert.equal(got.evC.length, 1);
});

/* ── through the REAL account store ────────────────────────────────────── */

function answersFor() {
  const byUser = {
    [ADDR.B]: { role: { role: "user" }, mode: B.userAbstraction, ch: B.clearinghouseState, spot: B.spotClearinghouseState, oo: [], fills: [], ledger: [] },
    [ADDR.C]: { role: { role: "user" }, mode: "disabled", ch: C.clearinghouseState, spot: B.spotClearinghouseState, oo: [], fills: [], ledger: [] },
  };
  return (body) => {
    const u = byUser[body.user];
    switch (body.type) {
      case "userRole": return u.role;
      case "userAbstraction": return u.mode;
      case "clearinghouseState": return body.dex ? { ...u.ch, assetPositions: [], marginSummary: { ...u.ch.marginSummary, accountValue: "0.0" } } : u.ch;
      case "spotClearinghouseState": return u.spot;
      case "frontendOpenOrders": return u.oo;
      case "userFills": case "userFillsByTime": return u.fills;
      case "userNonFundingLedgerUpdates": return u.ledger;
      case "perpDexs": return [null];
      default: throw new Error(`unexpected info ${body.type}`);
    }
  };
}

function storeRig() {
  const r = realWs();
  const answer = answersFor();
  const store = createPerpAccountStore({
    info: (body) => Promise.resolve(structuredClone(answer(body))),
    ws: r.ws, timers: r.clock.timers, now: r.clock.now, isHidden: () => false, onVisibilityChange: () => () => {},
  });
  return { ...r, store };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((res) => setImmediate(res)); };

test("U6) a liquidation carried by userEvents ALONE (no fill, no ledger line) is a live lead event for the liquidated account", async () => {
  const r = storeRig();
  r.store.retain(ADDR.B);
  await settle();
  r.open();
  const seen = [];
  r.store.onEvent(ADDR.B, (e) => seen.push(e));
  r.recv(USER_EVENTS(ADDR.B).liquidation);
  assert.equal(seen.length, 1, "the liquidation never reached the store");
  assert.equal(seen[0].kind, "liquidation");
  assert.equal(seen[0].lead, true);
  assert.equal(seen[0].source, "userEvents");
  assert.equal(seen[0].detail.lid, 77);
  assert.equal(r.store.getSnapshot(ADDR.B).events[0].kind, "liquidation");
});

test("U7) ADL from the fill stream and a system cancel from userEvents become events; another account's liquidation does not", async () => {
  const r = storeRig();
  r.store.retain(ADDR.B);
  await settle();
  r.open();
  const seen = [];
  r.store.onEvent(ADDR.B, (e) => seen.push(e.kind));
  r.recv({ channel: "userFills", data: { isSnapshot: false, user: ADDR.B, fills: [{ coin: "ETH", px: "2900.0", sz: "1.0", side: "B", time: r.clock.now(), startPosition: "-3.0", dir: "Auto-Deleveraging", closedPnl: "-40.0", hash: "0xadl", oid: 8, crossed: true, fee: "0.0", tid: 81, feeToken: "USDC" }] } });
  r.recv(USER_EVENTS(ADDR.B).nonUserCancel);
  r.recv(USER_EVENTS(LIQUIDATOR).liquidation);
  assert.deepEqual(seen, ["adl", "systemCancel"]);
});

test("U8) one liquidation reported by userEvents, userFills AND the ledger is ONE lead", async () => {
  const r = storeRig();
  r.store.retain(ADDR.B);
  await settle();
  r.open();
  const leads = [];
  r.store.onEvent(ADDR.B, (e) => { if (e.lead) leads.push(e); });
  const t = r.clock.now();
  r.recv(USER_EVENTS(ADDR.B).liquidation);
  r.recv({ channel: "userFills", data: { isSnapshot: false, user: ADDR.B, fills: [{ coin: "BTC", px: "99000.0", sz: "0.17449", side: "B", time: t, startPosition: "-0.17449", dir: "Close Short", closedPnl: "-2300.0", hash: "0xliq", oid: 9, crossed: true, fee: "5.0", tid: 79, feeToken: "USDC", liquidation: { liquidatedUser: ADDR.B, markPx: "99010.0", method: "market" } }] } });
  r.recv({ channel: "userNonFundingLedgerUpdates", data: { isSnapshot: false, user: ADDR.B, nonFundingLedgerUpdates: [{ time: t, hash: "0xliq", delta: { type: "liquidation", liquidatedNtlPos: "15000.0", accountValue: "10.0", leverageType: "Isolated", liquidatedPositions: [{ coin: "BTC", szi: "-0.17449" }] } }] } });
  assert.equal(leads.length, 1, "three streams, one occurrence, one toast");
  assert.equal(r.store.getSnapshot(ADDR.B).events.filter((e) => e.kind === "liquidation").length, 3, "each report is kept in the history");
});

test("U9) the risk stream: liquidation and ADL only, leads only, live only — what a page toasts", async () => {
  assert.deepEqual([...EV.PERP_RISK_EVENT_KINDS], ["liquidation", "adl"]);
  assert.equal(EV.isPerpRiskEvent({ kind: "liquidation", lead: true }), true);
  assert.equal(EV.isPerpRiskEvent({ kind: "adl", lead: true }), true);
  assert.equal(EV.isPerpRiskEvent({ kind: "adl", lead: false }), false, "a second report of the same occurrence is not a second toast");
  for (const kind of ["systemCancel", "order", "notification"]) assert.equal(EV.isPerpRiskEvent({ kind, lead: true }), false, kind);
  assert.equal(EV.isPerpRiskEvent(null), false);

  const r = storeRig();
  const risk = [];
  const stop = r.store.watchRiskEvents(ADDR.B, (e) => risk.push(e.kind));
  await settle();
  r.open();
  r.recv(USER_EVENTS(ADDR.B).nonUserCancel);
  r.recv({ channel: "notification", data: { notification: "hello" } });
  r.recv(USER_EVENTS(ADDR.B).liquidation);
  r.recv({ channel: "userFills", data: { isSnapshot: false, user: ADDR.B, fills: [{ coin: "ETH", px: "2900.0", sz: "1.0", side: "B", time: r.clock.now() + 60_000, startPosition: "-3.0", dir: "Auto-Deleveraging", closedPnl: "-40.0", hash: "0xadl2", oid: 8, crossed: true, fee: "0.0", tid: 82, feeToken: "USDC" }] } });
  assert.deepEqual(risk, ["liquidation", "adl"]);
  stop();
  r.recv(USER_EVENTS(ADDR.B).liquidation);
  assert.deepEqual(risk, ["liquidation", "adl"], "nothing after the stop");
  assert.equal(r.store.getSnapshot(ADDR.B).stale, true, "the watch retained the address, and its stop released it");
});
