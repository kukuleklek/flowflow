/**
 * test-hl-account-store — the ONE account store behind usePerpAccount(address):
 * refcounted per MASTER address, streamed over the tab's one Hyperliquid
 * WebSocket (lib/hyperliquid/ws.js), a REST snapshot on first use and on every
 * resubscribe, nothing polled while hidden, and every figure a number or null
 * with an answered flag.
 *
 *   node --test scripts/test-hl-account-store.mjs
 *
 * Answers replayed here are the live captures in
 * scripts/test-hl-account-fixtures.mjs. Nothing in this suite touches the
 * network: info is a fake, the socket manager is a fake, and section I runs the
 * REAL ws.js over a fake socket.
 *
 * Owner rule 4: one WebSocket per tab, no new sockets, visibility-gated.
 * MONEY_RULES: unknown is null, never 0; one source per figure; Perp money is
 * its own named figure and never enters the wallet's Cash or Portfolio.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToString } from "react-dom/server";
import { A, B, C, FRESH, WS, ADDR, PERP_DEXS } from "./test-hl-account-fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_DIR = "src/lib/hyperliquid/account";

/* Count any network or socket use from merely IMPORTING the modules. */
const touched = { fetch: 0, ws: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { touched.fetch++; return realFetch(...a); };
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class { constructor() { touched.ws++; throw new Error("no socket in tests"); } };

const S = await import("../src/lib/hyperliquid/account/store.js");
const H = await import("../src/lib/hyperliquid/account/usePerpAccount.js");
const IDX = await import("../src/lib/hyperliquid/account/index.js");
const { createHlWs } = await import("../src/lib/hyperliquid/ws.js");
const { createPerpAccountStore, PERP_ACCOUNT_POLL_MS } = S;

/* ── fakes ─────────────────────────────────────────────────────────────── */

function fakeClock(start = 1_790_070_500_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    pending: () => timers.size,
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

function fakeWs() {
  const subs = [];
  const statusFns = new Set();
  return {
    subs,
    subscribe(sub, onData, opts = {}) {
      const rec = { sub, onData, onError: opts.onError, live: true };
      subs.push(rec);
      return () => { rec.live = false; };
    },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    emitStatus(s) { for (const fn of [...statusFns]) fn(s); },
    live: (type) => subs.filter((r) => r.live && (!type || r.sub.type === type)),
    /* ws.js routes user streams by CHANNEL only, so every live handler of a
       type receives every push of that type, whoever it is for. */
    push(type, data) { for (const r of subs.filter((x) => x.live && x.sub.type === type)) r.onData(data); },
    reject(type, msg = "Invalid subscription") { for (const r of subs.filter((x) => x.live && x.sub.type === type)) if (r.onError) r.onError(msg); },
    statusListeners: () => statusFns.size,
  };
}

/* Answers per request type, from the live captures. */
function answersFor(who) {
  const byUser = {
    [ADDR.A]: { role: A.userRole, mode: A.userAbstraction, ch: A.clearinghouseState, spot: A.spotClearinghouseState, oo: A.frontendOpenOrders, fills: A.userFillsNewest6, fillsByTime: A.userFillsByTimeAtNewest, ledger: A.userNonFundingLedgerUpdates, xyz: A.xyzClearinghouseState, xyzOo: A.xyzFrontendOpenOrders },
    [ADDR.B]: { role: { role: "user" }, mode: B.userAbstraction, ch: B.clearinghouseState, spot: B.spotClearinghouseState, oo: [], fills: [], ledger: [], xyz: FRESH.clearinghouseState },
    [ADDR.C]: { role: { role: "user" }, mode: "disabled", ch: C.clearinghouseState, spot: FRESH.spotClearinghouseState, oo: C.frontendOpenOrders, fills: [], ledger: [], xyz: FRESH.clearinghouseState },
    [ADDR.FRESH]: { role: FRESH.userRole, mode: FRESH.userAbstraction, ch: FRESH.clearinghouseState, spot: FRESH.spotClearinghouseState, oo: [], fills: [], ledger: [], xyz: FRESH.clearinghouseState },
  };
  return (body) => {
    const u = byUser[body.user] || (who && byUser[who]);
    switch (body.type) {
      case "userRole": return u.role;
      case "userAbstraction": return u.mode;
      case "clearinghouseState": return body.dex === "xyz" ? u.xyz : body.dex ? FRESH.clearinghouseState : u.ch;
      case "spotClearinghouseState": return u.spot;
      /* THE DEX IS PART OF THE QUESTION. Measured 2026-09-23: without it,
         frontendOpenOrders answered 0 of one address's 380 xyz orders. */
      case "frontendOpenOrders": return body.dex === "xyz" ? (u.xyzOo || []) : body.dex ? [] : u.oo;
      case "userFills": return u.fills;
      /* startTime is inclusive (fixtures: userFillsByTimeAtNewest) */
      case "userFillsByTime": return (u.fillsByTime || u.fills).filter((f) => f.time >= body.startTime);
      case "userNonFundingLedgerUpdates": return u.ledger;
      case "perpDexs": return PERP_DEXS;
      default: throw new Error(`unexpected info ${body.type}`);
    }
  };
}

function rig({ hidden = false, answer = answersFor(), wsImpl = null } = {}) {
  const clock = fakeClock();
  const ws = wsImpl || fakeWs();
  const visFns = new Set();
  let isHid = hidden;
  const calls = [];
  const gates = [];
  let gated = null;
  const info = (body) => {
    calls.push(structuredClone(body));
    if (gated && gated(body)) return new Promise((res, rej) => gates.push({ body, res: () => res(structuredClone(answer(body))), rej }));
    try { return Promise.resolve(structuredClone(answer(body))); } catch (e) { return Promise.reject(e); }
  };
  const store = createPerpAccountStore({
    info, ws, timers: clock.timers, now: clock.now,
    isHidden: () => isHid,
    onVisibilityChange: (fn) => { visFns.add(fn); return () => visFns.delete(fn); },
  });
  return {
    clock, ws, store, calls, gates, answer,
    gate(pred) { gated = pred; },
    setHidden(h) { isHid = h; for (const fn of [...visFns]) fn(); },
    visListeners: () => visFns.size,
    types: () => calls.map((c) => c.type),
  };
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const snap = (r, a) => r.store.getSnapshot(a);

/* ── A. nothing at import ──────────────────────────────────────────────── */

test("A1) importing the account modules opens no socket and sends no request", () => {
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
  assert.equal(typeof IDX.usePerpAccount, "function");
  assert.equal(typeof IDX.createPerpAccountStore, "function");
  assert.equal(typeof IDX.resolvePerpBalance, "function");
});

/* ── B. first use: one REST snapshot, the streams keyed by the master ──── */

test("B1) retain: every figure starts unanswered (a dash), then one REST snapshot and nine streams keyed by the lowercased master", async () => {
  const r = rig();
  const release = r.store.retain(ADDR.A.toUpperCase().replace("0X", "0x"));
  const s0 = snap(r, ADDR.A);
  assert.equal(s0.address, ADDR.A);
  assert.equal(s0.ready, false);
  assert.equal(s0.perpBalanceUsdc.answered, false);
  assert.equal(s0.perpBalanceUsdc.equityUsdc, null);
  assert.equal(s0.positions.answered, false);
  assert.deepEqual(s0.positions.list, []);
  assert.equal(s0.mode.value, null);
  assert.deepEqual(r.ws.live().map((x) => x.sub.type).sort(), [
    "clearinghouseState", "notification", "openOrders", "orderUpdates", "spotState",
    "userEvents", "userFills", "userNonFundingLedgerUpdates", "webData3",
  ]);
  for (const x of r.ws.live()) assert.equal(x.sub.user, ADDR.A, x.sub.type);
  assert.equal(r.ws.live("clearinghouseState")[0].sub.dex, "");
  await settle();
  assert.deepEqual(r.types().sort(), [
    "clearinghouseState", "clearinghouseState",
    "frontendOpenOrders", "frontendOpenOrders", "perpDexs", "spotClearinghouseState", "userAbstraction", "userFills",
    "userNonFundingLedgerUpdates", "userRole",
  ], "the main dex and the ONE venue this build lists, each read as a pair; everything else once");
  /* CHEAPER THAN THE COUNT IT REPLACES. This used to poll clearinghouseState for
     all 10 other dexes every 5 minutes and keep only a position count from them
     (store.js: written every time, read by nothing). */
  assert.equal(r.calls.filter((c) => c.type === "clearinghouseState").length, 2);
  assert.deepEqual(r.calls.filter((c) => c.type === "clearinghouseState").map((c) => c.dex).sort(), ["", "xyz"]);
  assert.deepEqual(r.calls.filter((c) => c.type === "frontendOpenOrders").map((c) => c.dex ?? null).sort(), [null, "xyz"]);
  /* The venue's own pair of streams goes up as soon as the names are known. */
  assert.deepEqual(r.ws.live().map((x) => `${x.sub.type}|${x.sub.dex ?? "-"}`).sort(), [
    "clearinghouseState|", "clearinghouseState|xyz", "notification|-", "openOrders|", "openOrders|xyz",
    "orderUpdates|-", "spotState|-", "userEvents|-", "userFills|-", "userNonFundingLedgerUpdates|-", "webData3|-",
  ]);
  const ledgerCall = r.calls.find((c) => c.type === "userNonFundingLedgerUpdates");
  assert.ok(Number.isInteger(ledgerCall.startTime) && ledgerCall.startTime < r.clock.now());
  for (const c of r.calls) if (c.type !== "perpDexs") assert.equal(c.user, ADDR.A, c.type);
  release();
});

test("B2) after the snapshot: unified A reads its balance from SPOT, positions and TP/SL are Hyperliquid's", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  const s = snap(r, ADDR.A);
  assert.equal(s.ready, true);
  assert.equal(s.role.value, "user");
  assert.deepEqual([s.mode.value, s.mode.source, s.mode.answered], ["unifiedAccount", "spot", true]);
  assert.equal(s.perpBalanceUsdc.source, "spot");
  assert.equal(s.perpBalanceUsdc.equityUsdc, 155293.727137);
  assert.equal(s.positions.answered, true);
  /* 6 on the main dex and A's one xyz:HOOD: ONE list, main dex first. */
  assert.equal(s.positions.list.length, 7);
  assert.equal(s.positions.byCoin.BTC.liquidationPx, 61092.0544535562);
  assert.equal(s.positions.byCoin.AR.liquidationPx, null);
  assert.equal(s.orders.answered, true);
  /* 7 on the main dex and A's 2 venue orders, in the same one list. */
  assert.equal(s.orders.list.length, 9);
  assert.equal(s.orders.tpslByCoin.NEAR.sl.length, 3);
  assert.equal(s.fills.answered, true);
  assert.equal(s.fills.partial, false);
  assert.equal(s.fills.list.length, 6);
  assert.equal(s.ledger.answered, true);
  assert.equal(s.ledger.inbound.length, 1);
  assert.equal(s.ledger.inbound[0].usdc, 50137.38);
  assert.equal(s.stale, false);
  assert.ok(Object.isFrozen(s));
});

test("B3) a venue position is IN the list, its orders are IN the orders, and the list is complete", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  const s = snap(r, ADDR.A);
  /* THE WHOLE POINT OF THIS ROUND. A's xyz:HOOD used to be a count in a field
     nothing read; the old perp page looked it up by coin, found nothing, and showed no
     position card, no P&L, no close sheet and no TP/SL on a live position. */
  assert.ok(s.positions.byCoin["xyz:HOOD"], "the venue position is findable by its own coin name");
  assert.equal(s.positions.byCoin["xyz:HOOD"].dex, "xyz");
  assert.equal(s.positions.byCoin["xyz:HOOD"].szi, 163.316);
  assert.equal(s.positions.complete, true, "the venues are in the list, so it IS the account");
  assert.ok(s.orders.list.some((o) => o.coin === "xyz:META"), "a venue's resting order is in the orders");
  /* frontendOpenOrders with no dex answers none of these, so classifyTpSlOrders saw
     nothing on a venue and planTpSlMove would have left the old stop open. */
  assert.equal(s.orders.tpslByCoin["xyz:HOOD"].sl.length, 1);
  assert.equal(s.venues.answered, true);
  assert.deepEqual(s.venues.list.map((v) => [v.dex, v.positions, v.orders]), [["xyz", 1, 2]]);
  assert.equal(s.venues.list[0].equityUsdc, 4139.403823);
  assert.equal(s.venues.list[0].availableUsdc, 0);
  const rb = rig();
  rb.store.retain(ADDR.B);
  await settle();
  assert.equal(snap(rb, ADDR.B).positions.complete, true);
  assert.equal(snap(rb, ADDR.B).perpBalanceUsdc.complete, true);
});

test("B3b) ONE Perp balance: the main pot plus every venue pot, but only the MAIN one can leave", async () => {
  const r = rig();
  r.store.retain(ADDR.B);
  await settle();
  const b = snap(r, ADDR.B).perpBalanceUsdc;
  /* B is standard mode ("disabled"): its venue pot is its own money. The fixture
     rig answers FRESH's empty clearinghouse for B's xyz, so the venue part is 0
     and the equity is the main figure — the sum, not a coincidence. */
  assert.equal(b.source, "perp");
  assert.equal(b.equityUsdc, 2900.93691);
  assert.equal(b.venueEquityUsdc, 0);
  assert.equal(b.complete, true);
  /* A holds real money on the venue: the ONE equity is the two pots added. */
  const ra = rig();
  ra.store.retain(ADDR.C);
  await settle();
  const c = snap(ra, ADDR.C).perpBalanceUsdc;
  assert.equal(c.source, "perp");
  assert.equal(c.equityUsdc, 418.66173, "C's venue pot is empty in the fixtures");
  /* A standard account whose venue DOES hold money: the same store, C's main
     clearinghouse and A's venue one. */
  const mixed = rig({ answer: (body) => (body.type === "clearinghouseState" && body.dex === "xyz" ? A.xyzClearinghouseState : answersFor(ADDR.C)(body)) });
  mixed.store.retain(ADDR.C);
  await settle();
  const m = snap(mixed, ADDR.C).perpBalanceUsdc;
  assert.equal(m.equityUsdc, 418.66173 + 4139.403823, "ONE equity: the main pot plus the venue pot");
  assert.equal(m.venueEquityUsdc, 4139.403823);
  /* 🔴 availableUsdc IS NOT SUMMED. It feeds canWithdraw and the Withdraw sheet,
     and a withdrawal leaves the MAIN dex: a combined figure would promise money
     the way out cannot reach (balance.js ONE BALANCE). */
  assert.equal(m.availableUsdc, 0, "C's own main-dex withdrawable, not the venue's");
  assert.equal(m.venueAvailableUsdc, 0, "carried apart, for the code that moves it");
  assert.equal(m.complete, true);
});

test("B3c) the venue read FAILED: the figure is the main dex's and says it is not the whole account — never a smaller number presented as final", async () => {
  const base = answersFor(ADDR.B);
  const r = rig({ answer: (body) => { if (body.type === "perpDexs") throw new Error("HTTP 429"); return base(body); } });
  r.store.retain(ADDR.B);
  await settle();
  const s = snap(r, ADDR.B);
  assert.equal(s.perpBalanceUsdc.answered, true);
  assert.equal(s.perpBalanceUsdc.equityUsdc, 2900.93691, "what is known is shown");
  assert.equal(s.perpBalanceUsdc.complete, null, "and it is not claimed as final");
  assert.equal(s.perpBalanceUsdc.incompleteReason, "perp-venues-unanswered");
  assert.equal(s.positions.complete, null);
  assert.equal(s.venues.answered, false);
  assert.deepEqual(s.venues.list, []);
  assert.equal(s.error, "HTTP 429", "the failure is reported beside the figures, not swallowed");
  /* No venue stream goes up while the names are unknown: a guessed dex name
     answers HTTP 500 (measured 2026-09-23). */
  assert.deepEqual(r.ws.live().filter((x) => x.sub.dex === "xyz"), []);
  const ok = rig();
  ok.store.retain(ADDR.B);
  await settle();
  assert.equal(snap(ok, ADDR.B).perpBalanceUsdc.complete, true);
  assert.equal(snap(ok, ADDR.B).positions.complete, true);
});

test("B4) a never-used address is a known zero; a standard address reads the perp clearinghouse", async () => {
  const r = rig();
  r.store.retain(ADDR.FRESH);
  r.store.retain(ADDR.B);
  await settle();
  const f = snap(r, ADDR.FRESH);
  assert.equal(f.role.value, "missing");
  assert.equal(f.perpBalanceUsdc.answered, true);
  assert.equal(f.perpBalanceUsdc.equityUsdc, 0);
  assert.equal(f.perpBalanceUsdc.reason, "new-account");
  const b = snap(r, ADDR.B);
  assert.equal(b.perpBalanceUsdc.source, "perp");
  assert.equal(b.perpBalanceUsdc.equityUsdc, 2900.93691);
  assert.equal(b.perpBalanceUsdc.availableUsdc, 0);
  assert.equal(b.perpBalanceUsdc.idleSpotUsdc, 9380.04956985);
});

test("B5) no address, or not an address: the empty snapshot, and no request at all", async () => {
  const r = rig();
  for (const a of [null, undefined, "", "0xnope"]) {
    const release = r.store.retain(a);
    const s = snap(r, a);
    assert.equal(s.address, null);
    assert.equal(s.perpBalanceUsdc.equityUsdc, null);
    assert.equal(s.perpBalanceUsdc.answered, false);
    release();
  }
  await settle();
  assert.equal(r.calls.length, 0);
  assert.equal(r.ws.subs.length, 0);
});

/* ── C. refcount ───────────────────────────────────────────────────────── */

test("C1) two surfaces on one address (any letter case) share one snapshot request set and one set of streams", async () => {
  const r = rig();
  const off1 = r.store.retain(ADDR.B);
  const off2 = r.store.retain(ADDR.B.toUpperCase().replace("0X", "0x"));
  await settle();
  assert.equal(r.types().filter((t) => t === "userRole").length, 1);
  assert.equal(r.ws.live("webData3").length, 1);
  off1();
  assert.equal(r.ws.live().length, 11, "still held by the second surface: nine, plus the venue's own pair");
  off2();
  assert.equal(r.ws.live().length, 0, "the last one out unsubscribes everything");
  assert.equal(r.ws.statusListeners(), 0);
  assert.equal(r.visListeners(), 0);
  off2();
  assert.equal(r.ws.live().length, 0, "a double release is harmless");
});

/* ── D. streams: user-filtered, newer than a slow snapshot ─────────────── */

test("D1) a push for ANOTHER user on the same channel is ignored (ws.js routes user streams by channel only)", async () => {
  const r = rig();
  r.store.retain(ADDR.B);
  await settle();
  const before = snap(r, ADDR.B);
  r.ws.push("clearinghouseState", WS.clearinghouseStateA.data);
  r.ws.push("webData3", WS.webData3A.data);
  r.ws.push("spotState", WS.spotStateA.data);
  r.ws.push("openOrders", WS.openOrdersA_first2.data);
  r.ws.push("userFills", { isSnapshot: false, user: ADDR.A, fills: A.userFillsNewest6 });
  assert.equal(snap(r, ADDR.B), before, "nothing about B changed");
});

test("D2) a stream push newer than a slow snapshot request wins; the late answer does not roll it back", async () => {
  const r = rig();
  r.gate((b) => b.type === "clearinghouseState" && !b.dex);
  r.store.retain(ADDR.A);
  await settle();
  r.ws.push("clearinghouseState", WS.clearinghouseStateA.data);
  assert.equal(snap(r, ADDR.A).positions.byCoin.NEAR.szi, 36766.1);
  for (const g of r.gates) g.res();
  await settle();
  assert.equal(snap(r, ADDR.A).positions.byCoin.NEAR.szi, 36766.1, "the stream's newer state stands");
});

test("D3) an older clearinghouse state (by its own time) never replaces a newer one", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  r.ws.push("clearinghouseState", WS.clearinghouseStateA.data);
  const old = structuredClone(WS.clearinghouseStateA.data);
  old.clearinghouseState.time = 1;
  old.clearinghouseState.assetPositions = [];
  r.ws.push("clearinghouseState", old);
  assert.equal(snap(r, ADDR.A).positions.list.length, 7, "6 main-dex positions kept, plus A's venue one");
  assert.ok(snap(r, ADDR.A).positions.byCoin["xyz:HOOD"], "a main-dex push never drops a venue position");
});

test("D3b) a VENUE push lands on the venue, not on the main dex — and one it does not hold is ignored", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  const before = snap(r, ADDR.A);
  assert.equal(before.venues.list[0].equityUsdc, 4139.403823);
  assert.equal(before.positions.byCoin["xyz:HOOD"].szi, 163.316);
  /* ws.js routes a user stream by its CHANNEL, so this push is handed to the
     main-dex handler as well; data.dex is what tells them apart (measured
     2026-09-23: both subscriptions push live, each frame carrying its own dex). */
  r.ws.push("clearinghouseState", WS.clearinghouseStateXyzA.data);
  const s1 = snap(r, ADDR.A);
  assert.equal(s1.venues.list[0].equityUsdc, 4200, "the venue pot moved");
  assert.equal(s1.venues.list[0].availableUsdc, 60.596177);
  assert.equal(s1.perpBalanceUsdc.equityUsdc, 155293.727137, "A is unified: its equity is the spot total, venues never added to it");
  assert.equal(s1.positions.byCoin["xyz:TSLA"].szi, 363.829, "the venue's new position is in the ONE list");
  assert.equal(s1.positions.byCoin["xyz:HOOD"], undefined, "and the venue's OWN push replaced its OWN list");
  assert.equal(s1.positions.byCoin.BTC.szi, 4.81064, "the main dex is untouched");
  r.ws.push("openOrders", WS.openOrdersXyzA.data);
  const s2 = snap(r, ADDR.A);
  assert.equal(s2.orders.list.filter((o) => o.coin.startsWith("xyz:")).length, 1);
  assert.equal(s2.orders.tpslByCoin["xyz:TSLA"].sl.length, 1, "a venue stop is classified like any other");
  assert.equal(s2.orders.list.filter((o) => !o.coin.includes(":")).length, 7, "the main dex's own orders are still there");
  /* A dex this session does not hold is not this session's business. */
  const foreign = structuredClone(WS.clearinghouseStateXyzA.data);
  foreign.dex = "flx";
  foreign.clearinghouseState.marginSummary.accountValue = "999999.0";
  r.ws.push("clearinghouseState", foreign);
  assert.equal(snap(r, ADDR.A).venues.list.length, 1);
  assert.equal(snap(r, ADDR.A).venues.list[0].equityUsdc, 4200);
  /* And a push for somebody else never lands, whatever dex it names. */
  const other = structuredClone(WS.clearinghouseStateXyzA.data);
  other.user = ADDR.B;
  other.clearinghouseState.marginSummary.accountValue = "1.0";
  r.ws.push("clearinghouseState", other);
  assert.equal(snap(r, ADDR.A).venues.list[0].equityUsdc, 4200);
});

test("D4) webData3 carries the live mode, the agent and the server clock; an absent mode keeps the snapshot's", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  r.store.retain(ADDR.FRESH);
  await settle();
  r.ws.push("webData3", WS.webData3A.data);
  r.ws.push("webData3", WS.webData3Fresh.data);
  const a = snap(r, ADDR.A);
  assert.deepEqual(a.agent, { answered: true, address: "0x460152803c358e0944f6b0bd6576542219947ce8", validUntil: 1790816563551 });
  assert.equal(a.server.time, 1790070599773);
  assert.equal(a.server.at, r.clock.now());
  const f = snap(r, ADDR.FRESH);
  assert.equal(f.mode.value, "default", "webData3 without an abstraction does not erase the answered mode");
  assert.deepEqual(f.agent, { answered: true, address: null, validUntil: null });
  const flip = structuredClone(WS.webData3A.data);
  flip.userState.abstraction = "disabled";
  r.ws.push("webData3", flip);
  assert.deepEqual([snap(r, ADDR.A).mode.value, snap(r, ADDR.A).perpBalanceUsdc.source], ["disabled", "perp"]);
});

test("D5) spot and open-order streams update their figures; fills merge by trade id", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  r.ws.push("spotState", WS.spotStateA.data);
  assert.equal(snap(r, ADDR.A).perpBalanceUsdc.equityUsdc, 155650.43365);
  r.ws.push("openOrders", WS.openOrdersA_first2.data);
  assert.equal(snap(r, ADDR.A).orders.list.length, 4, "the main dex's 2 from the push, and A's 2 venue orders kept");
  assert.equal(snap(r, ADDR.A).orders.list.filter((o) => !o.coin.includes(":")).length, 2);
  r.ws.push("userFills", WS.userFillsSnapshotA_4overlapping.data);
  assert.equal(snap(r, ADDR.A).fills.list.length, 6);
});

/* ── E. reconnect, visibility, rejected streams ────────────────────────── */

test("E1) the first open is not a resubscribe; a reconnect marks the account stale and takes ONE fresh snapshot", async () => {
  const r = rig();
  r.store.retain(ADDR.B);
  await settle();
  const n0 = r.calls.length;
  r.ws.emitStatus("connecting");
  r.ws.emitStatus("open");
  await settle();
  assert.equal(r.calls.length, n0, "the first connect does not repeat the snapshot");
  r.ws.emitStatus("reconnecting");
  assert.equal(snap(r, ADDR.B).stale, true);
  assert.equal(snap(r, ADDR.B).perpBalanceUsdc.equityUsdc, 2900.93691, "the last figure stays, flagged stale, not blanked");
  r.ws.emitStatus("open");
  await settle();
  const again = r.calls.slice(n0).map((c) => c.type).sort();
  assert.deepEqual(again, [
    "clearinghouseState", "clearinghouseState", "frontendOpenOrders", "frontendOpenOrders",
    "spotClearinghouseState", "userAbstraction", "userFills", "userNonFundingLedgerUpdates",
  ], "role is known, and the venue names were resolved on the first open: the pair is re-read, perpDexs is not");
  assert.equal(r.calls.slice(n0).filter((c) => c.type === "perpDexs").length, 0);
  assert.equal(snap(r, ADDR.B).stale, false);
});

test("E1b) retained while the shared socket is ALREADY open: a later drop still marks the account stale and refreshes on return", async () => {
  const ws = fakeWs();
  ws.status = () => "open";
  const r = rig({ wsImpl: ws });
  r.store.retain(ADDR.B);
  await settle();
  const n0 = r.calls.length;
  ws.emitStatus("reconnecting");
  assert.equal(snap(r, ADDR.B).stale, true, "no open transition was seen, yet the socket was live");
  ws.emitStatus("open");
  await settle();
  assert.ok(r.calls.length > n0, "the resubscribe snapshot is taken");
  assert.equal(snap(r, ADDR.B).stale, false);
});

test("E2) hidden: nothing polls; a rejected stream falls back to REST only while visible", async () => {
  const r = rig({ hidden: true });
  r.store.retain(ADDR.B);
  await settle();
  const n0 = r.calls.length;
  assert.ok(n0 > 0, "the mount snapshot happens even in a hidden tab");
  r.ws.reject("clearinghouseState", "Too many users");
  r.clock.advance(PERP_ACCOUNT_POLL_MS * 4);
  await settle();
  assert.equal(r.calls.length, n0, "hidden: no polling at all");
  assert.deepEqual(snap(r, ADDR.B).streams.rejected, ["clearinghouseState"]);
  r.setHidden(false);
  await settle();
  const n1 = r.calls.length;
  assert.ok(r.calls.slice(n0).some((c) => c.type === "clearinghouseState"), "visible again: the fallback reads at once");
  r.clock.advance(PERP_ACCOUNT_POLL_MS);
  await settle();
  assert.ok(r.calls.slice(n1).some((c) => c.type === "clearinghouseState"), "and then on its interval");
  assert.ok(!r.calls.slice(n1).some((c) => c.type === "userRole"), "only what the rejected stream carried");
  r.setHidden(true);
  const n2 = r.calls.length;
  r.clock.advance(PERP_ACCOUNT_POLL_MS * 3);
  await settle();
  assert.equal(r.calls.length, n2, "hidden again: stops");
});

test("E2b) releasing forgets a rejection: the next surface asks the server again instead of polling", async () => {
  const r = rig();
  const off = r.store.retain(ADDR.B);
  await settle();
  r.ws.reject("spotState");
  assert.deepEqual(snap(r, ADDR.B).streams.rejected, ["spotState"]);
  off();
  r.store.retain(ADDR.B);
  await settle();
  assert.deepEqual(snap(r, ADDR.B).streams.rejected, []);
  assert.equal(r.ws.live("spotState").length, 1);
});

test("E2c) derived maps keep their identity when an unrelated figure moves", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  const a = snap(r, ADDR.A);
  r.ws.push("spotState", WS.spotStateA.data);
  const b = snap(r, ADDR.A);
  assert.notEqual(a, b, "the balance moved");
  assert.equal(a.orders.tpslByCoin, b.orders.tpslByCoin);
  assert.equal(a.fills.byCoin, b.fills.byCoin);
  assert.equal(a.positions.byCoin, b.positions.byCoin);
});

test("E3) a failed snapshot keeps what was known and reports the error; an unanswered figure stays a dash", async () => {
  const base = answersFor();
  const r = rig({ answer: (b) => { if (b.type === "spotClearinghouseState") throw new Error("HTTP 429"); return base(b); } });
  r.store.retain(ADDR.A);
  await settle();
  const s = snap(r, ADDR.A);
  assert.equal(s.perpBalanceUsdc.answered, false, "unified needs spot, and spot did not answer");
  assert.equal(s.perpBalanceUsdc.equityUsdc, null);
  assert.equal(s.perpBalanceUsdc.reason, "spot-unanswered");
  assert.match(s.error, /429/);
  assert.equal(s.positions.answered, true, "the figures that did answer are shown");
});

/* ── F. events ─────────────────────────────────────────────────────────── */

test("F1) a fills SNAPSHOT never toasts; a live liquidation fill does, once, and the ledger line for it joins its group", async () => {
  const r = rig();
  r.store.retain(ADDR.B);
  await settle();
  const seen = [];
  const off = r.store.onEvent(ADDR.B, (e) => seen.push(e));
  const liq = { coin: "BTC", px: "99000.0", sz: "0.17449", side: "B", time: r.clock.now(), startPosition: "-0.17449", dir: "Close Short", closedPnl: "-2300.0", hash: "0xliq", oid: 9, crossed: true, fee: "5.0", tid: 77, feeToken: "USDC", liquidation: { liquidatedUser: ADDR.B, markPx: "99010.0", method: "market" } };
  r.ws.push("userFills", { isSnapshot: true, user: ADDR.B, fills: [liq] });
  assert.equal(seen.length, 0, "history is not news");
  assert.equal(snap(r, ADDR.B).events.length, 1, "but it is kept in the event history");
  r.ws.push("userFills", { isSnapshot: false, user: ADDR.B, fills: [{ ...liq, tid: 78, hash: "0xliq2" }] });
  assert.deepEqual(seen.map((e) => [e.kind, e.lead]), [["liquidation", true]]);
  r.ws.push("userNonFundingLedgerUpdates", { isSnapshot: false, user: ADDR.B, nonFundingLedgerUpdates: [{ time: r.clock.now() + 500, hash: "0xliq2", delta: { type: "liquidation", accountValue: "10.0", leverageType: "Cross", liquidatedPositions: [{ coin: "BTC", szi: "-0.17449" }] } }] });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].lead, false, "same liquidation from a second stream: grouped, the screen toasts once");
  off();
});

test("F2) streams that carry no user (userEvents, orderUpdates, notification) count only when ONE address is held", async () => {
  const r = rig();
  r.store.retain(ADDR.B);
  await settle();
  const seen = [];
  r.store.onEvent(ADDR.B, (e) => seen.push(e.kind));
  r.ws.push("orderUpdates", [{ order: { coin: "SOL", side: "A", limitPx: "1.0", sz: "0.0", oid: 3, timestamp: 1, origSz: "1.0" }, status: "reduceOnlyCanceled", statusTimestamp: 5 }]);
  r.ws.push("notification", { notification: "Order filled" });
  r.ws.push("userEvents", { nonUserCancel: [{ coin: "ETH", oid: 4 }] });
  assert.deepEqual(seen, ["order", "notification", "systemCancel"]);
  r.store.retain(ADDR.FRESH);
  await settle();
  r.ws.push("notification", { notification: "Whose is this?" });
  assert.deepEqual(seen, ["order", "notification", "systemCancel"], "two addresses held: an unattributable push is dropped");
  assert.equal(snap(r, ADDR.B).streams.attributable, false);
});

test("F3) a never-used address that receives a credit asks its role again (missing becomes user)", async () => {
  let role = FRESH.userRole;
  const base = answersFor();
  const r = rig({ answer: (b) => (b.type === "userRole" ? role : base(b)) });
  r.store.retain(ADDR.FRESH);
  await settle();
  assert.equal(snap(r, ADDR.FRESH).role.value, "missing");
  role = { role: "user" };
  r.ws.push("userNonFundingLedgerUpdates", { isSnapshot: false, user: ADDR.FRESH, nonFundingLedgerUpdates: [{ time: r.clock.now(), hash: "0xdep", delta: { type: "send", user: "0x3333333333333333333333333333333333333333", destination: ADDR.FRESH, sourceDex: "spot", destinationDex: "", token: "USDC", amount: "18.778", usdcValue: "18.778", fee: "0.0" } }] });
  r.clock.advance(5_000);
  await settle();
  assert.equal(snap(r, ADDR.FRESH).role.value, "user");
  assert.deepEqual(IDX.arrivalsSince(snap(r, ADDR.FRESH).ledger.list, r.clock.now() - 60_000).map((l) => l.usdc), [18.778]);
});

/* ── J. the named Perp figure, the fill cap, a toast host alone, Arrived ── */

test("J1) the Perp money is ONE named figure, perpBalanceUsdc; there is no generic balance key to mistake for wallet money", async () => {
  const r = rig();
  r.store.retain(ADDR.B);
  assert.equal("balance" in snap(r, ADDR.B), false);
  assert.equal("balance" in IDX.PERP_ACCOUNT_EMPTY, false);
  assert.equal(snap(r, ADDR.B).perpBalanceUsdc.answered, false);
  await settle();
  const b = snap(r, ADDR.B).perpBalanceUsdc;
  assert.deepEqual([b.source, b.equityUsdc, b.availableUsdc], ["perp", 2900.93691, 0]);
  assert.ok(Object.isFrozen(b));
});

test("J2) a live push that takes the fill history past the venue's cap flags it partial (the oldest were dropped)", async () => {
  const mk = (i) => ({ coin: "BTC", px: "100.0", sz: "0.001", side: "B", time: 1_700_000_000_000 + i, startPosition: "0.0", dir: "Open Long", closedPnl: "0.0", hash: `0x${i}`, oid: i, crossed: true, fee: "0.0", tid: i + 1, feeToken: "USDC" });
  const page = Array.from({ length: 1999 }, (_, i) => mk(i)).reverse();
  const base = answersFor();
  const r = rig({ answer: (q) => (q.type === "userFills" ? page : base(q)) });
  r.store.retain(ADDR.B);
  await settle();
  assert.equal(snap(r, ADDR.B).fills.partial, false, "1999 fills: the whole history");
  r.ws.push("userFills", { isSnapshot: false, user: ADDR.B, fills: [mk(5000)] });
  assert.equal(snap(r, ADDR.B).fills.list.length, 2000);
  assert.equal(snap(r, ADDR.B).fills.partial, false, "exactly the cap, nothing dropped yet");
  r.ws.push("userFills", { isSnapshot: false, user: ADDR.B, fills: [mk(5001)] });
  const f = snap(r, ADDR.B).fills;
  assert.equal(f.list.length, 2000);
  assert.equal(f.partial, true, "the oldest fill fell off: no longer the whole history");
  assert.equal(f.oldestTime, 1_700_000_000_001);
});

test("J3) watchEvents alone keeps the address streamed (a toast host with no page), and one cleanup undoes both", async () => {
  const r = rig();
  const seen = [];
  const stop = r.store.watchEvents(ADDR.B.toUpperCase().replace("0X", "0x"), (e) => seen.push(e.kind));
  await settle();
  assert.equal(r.ws.live().length, 11, "the streams are up without usePerpAccount mounted");
  r.ws.push("userFills", { isSnapshot: false, user: ADDR.B, fills: [{ coin: "BTC", px: "99000.0", sz: "0.17449", side: "B", time: r.clock.now(), startPosition: "-0.17449", dir: "Auto-Deleveraging", closedPnl: "-10.0", hash: "0xadl", oid: 1, crossed: true, fee: "0.0", tid: 91, feeToken: "USDC" }] });
  assert.deepEqual(seen, ["adl"]);
  const release = r.store.retain(ADDR.B);
  assert.equal(r.ws.live().length, 11, "a page on the same address shares the streams");
  stop();
  assert.equal(r.ws.live().length, 11, "the page still holds them");
  release();
  assert.equal(r.ws.live().length, 0);
  stop();
  release();
  assert.equal(r.ws.live().length, 0, "a second cleanup is a no-op");
  assert.equal(typeof r.store.watchEvents(null, () => {}), "function");
});

test("J4) Arrived: unknown until the ledger answers, then any USDC credit at or after the start on HYPERLIQUID's clock", async () => {
  const r = rig();
  const t0 = r.clock.now();
  assert.deepEqual(IDX.perpDepositArrival(snap(r, ADDR.FRESH), { sinceMs: t0 }), { answered: false, arrived: null, lines: [], clock: null });
  r.store.retain(ADDR.FRESH);
  await settle();
  let a = IDX.perpDepositArrival(snap(r, ADDR.FRESH), { sinceMs: t0, minUsdc: 5 });
  assert.deepEqual([a.answered, a.arrived, a.lines.length, a.clock], [true, false, 0, "device"], "answered, nothing yet: a known no, not a dash");
  /* The phone runs 3 minutes FAST: Hyperliquid stamps the credit before the
     phone's start time, and only the server offset from webData3 catches it. */
  const serverNow = r.clock.now() - 180_000;
  r.ws.push("webData3", { userState: { ...WS.webData3Fresh.data.userState, serverTime: serverNow }, perpDexStates: [] });
  const credit = (amount, dt) => ({ time: serverNow + dt, hash: `0x${amount}`, delta: { type: "send", user: "0x3333333333333333333333333333333333333333", destination: ADDR.FRESH, sourceDex: "spot", destinationDex: "", token: "USDC", amount, usdcValue: amount, fee: "0.0" } });
  r.ws.push("userNonFundingLedgerUpdates", { isSnapshot: false, user: ADDR.FRESH, nonFundingLedgerUpdates: [credit("0.5", 2_000)] });
  a = IDX.perpDepositArrival(snap(r, ADDR.FRESH), { sinceMs: t0, minUsdc: 5 });
  assert.deepEqual([a.arrived, a.clock], [false, "server"], "a dust credit under the floor is not the deposit");
  r.ws.push("userNonFundingLedgerUpdates", { isSnapshot: false, user: ADDR.FRESH, nonFundingLedgerUpdates: [credit("18.778", 4_000)] });
  a = IDX.perpDepositArrival(snap(r, ADDR.FRESH), { sinceMs: t0, minUsdc: 5 });
  assert.equal(a.arrived, true);
  assert.deepEqual(a.lines.map((l) => l.usdc), [18.778]);
  const raw = IDX.arrivalsSince(snap(r, ADDR.FRESH).ledger.list, t0, { minUsdc: 5 });
  assert.equal(raw.length, 0, "by the phone's own clock the credit looks older than the deposit: the reason for the offset");
  assert.deepEqual(IDX.perpDepositArrival(null, { sinceMs: t0 }), { answered: false, arrived: null, lines: [], clock: null });
});

/* ── K. the refresh budget: an action or a reconnect re-reads only the gap ── */

/* Hyperliquid's documented /info weights (rate-limits page, read 2026-09-22):
   clearinghouseState and spotClearinghouseState 2, userRole 60, every other
   documented info request 20, and userFills / userFillsByTime 1 more per 20
   fills returned. The budget is 1200 a minute per IP, shared with the market
   list and the charts. */
function weightOf(call, answerOf) {
  if (call.type === "clearinghouseState" || call.type === "spotClearinghouseState") return 2;
  if (call.type === "userRole") return 60;
  if (call.type === "userFills" || call.type === "userFillsByTime") return 20 + Math.floor(answerOf(call).length / 20);
  return 20;
}
const weight = (r, calls) => calls.reduce((t, c) => t + weightOf(c, r.answer), 0);

const FILL_T0 = 1_780_000_000_000;
const mkFill = (i) => ({ coin: "BTC", px: "100.0", sz: "0.001", side: "B", time: FILL_T0 + i * 1000, startPosition: "0.0", dir: "Open Long", closedPnl: "0.0", hash: `0x${i.toString(16)}`, oid: i, crossed: true, fee: "0.0", tid: 10_000 + i, feeToken: "USDC" });
const newestFirst = (list) => [...list].sort((a, b) => b.time - a.time);

test("K1) after an action, refresh() reads what an action moves, and the fills only from Hyperliquid's own newest fill (inclusive), never the whole page again", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  assert.deepEqual([snap(r, ADDR.A).fills.list.length, snap(r, ADDR.A).fills.partial], [6, false]);
  const n0 = r.calls.length;
  await r.store.refresh(ADDR.A);
  await settle();
  const again = r.calls.slice(n0);
  assert.deepEqual(again.map((c) => c.type).sort(), [
    "clearinghouseState", "clearinghouseState", "frontendOpenOrders", "frontendOpenOrders",
    "spotClearinghouseState", "userFillsByTime", "userNonFundingLedgerUpdates",
  ], "no userAbstraction (webData3 streams the mode), no userRole (known), and the venue pair because a venue order moves a venue pot");
  assert.deepEqual(again.filter((c) => c.type === "clearinghouseState").map((c) => c.dex).sort(), ["", "xyz"]);
  assert.deepEqual(again.find((c) => c.type === "userFillsByTime"), { type: "userFillsByTime", user: ADDR.A, startTime: A.userFillsByTimeStart });
  const f = snap(r, ADDR.A).fills;
  assert.equal(f.answered, true);
  assert.equal(f.list.length, 16, "the 10 other fills of that millisecond join by trade id; the 6 already held are not doubled");
  assert.equal(f.partial, false, "a small window read says nothing new about the cap");
});

test("K2) MEASURED by the documented weights: for a trader near the fill cap an action's refresh costs about a third of the old full re-read", async () => {
  const history = newestFirst(Array.from({ length: 1999 }, (_, i) => mkFill(i)));
  const base = answersFor();
  const answer = (q) => (q.type === "userFills" ? history
    : q.type === "userFillsByTime" ? history.filter((f) => f.time >= q.startTime) : base(q));
  const r = rig({ answer });
  r.store.retain(ADDR.B);
  await settle();
  const mount = weight(r, r.calls);
  const n0 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  const action = weight(r, r.calls.slice(n0));
  /* the old refresh: the mode and the full 1999-fill page, plus the same three states and the ledger */
  const oldAction = weight(r, [
    { type: "userAbstraction" }, { type: "clearinghouseState" }, { type: "spotClearinghouseState" },
    { type: "frontendOpenOrders" }, { type: "userFills", user: ADDR.B }, { type: "userNonFundingLedgerUpdates" },
  ]);
  assert.equal(oldAction, 20 + 2 + 2 + 20 + (20 + 99) + 20);
  /* The venue pair is part of an action refresh now — a venue order moves a venue
     pot and a venue book, and neither was read at all before this round. Even
     paying for both, an action costs less than half what the full re-read did. */
  assert.equal(action, 2 + 2 + 20 + (20 + 0) + 20 + 2 + 20, "the main figures, the fill gap, and the venue's own pair");
  assert.ok(action * 2 < oldAction, `${action} vs ${oldAction}`);
  assert.ok(mount > action);
  assert.equal(snap(r, ADDR.B).fills.list.length, 1999);
  assert.equal(snap(r, ADDR.B).fills.partial, false);
});

test("K3) a reconnect re-reads the mode and the gap: fills from the newest fill REST reported, not from a newer one the WS snapshot brought", async () => {
  const r = rig();
  r.store.retain(ADDR.A);
  await settle();
  r.ws.emitStatus("open");
  r.ws.emitStatus("reconnecting");
  /* The new socket's snapshot carries a fill a minute newer. Fills between the
     REST read and that one may have been missed while the socket was down, so
     the gap read must still start at the REST anchor. */
  const newer = { ...A.userFillsNewest6[0], tid: 1, time: A.userFillsByTimeStart + 60_000, hash: "0xnewer" };
  r.ws.push("userFills", { isSnapshot: true, user: ADDR.A, fills: [newer] });
  const n0 = r.calls.length;
  r.ws.emitStatus("open");
  await settle();
  const again = r.calls.slice(n0);
  assert.deepEqual(again.map((c) => c.type).sort(), [
    "clearinghouseState", "clearinghouseState", "frontendOpenOrders", "frontendOpenOrders",
    "spotClearinghouseState", "userAbstraction", "userFillsByTime", "userNonFundingLedgerUpdates",
  ]);
  assert.equal(again.find((c) => c.type === "userFillsByTime").startTime, A.userFillsByTimeStart);
  assert.equal(snap(r, ADDR.A).fills.list[0].tid, 1, "the pushed fill is kept, newest first");
  assert.equal(snap(r, ADDR.A).stale, false);
});

test("K4) no fill yet means no anchor: the full page is read (for an empty history it costs the same); the first fill it reports becomes the start", async () => {
  let history = [];
  const base = answersFor();
  const r = rig({ answer: (q) => (q.type === "userFills" ? history
    : q.type === "userFillsByTime" ? history.filter((f) => f.time >= q.startTime) : base(q)) });
  r.store.retain(ADDR.B);
  await settle();
  const fillCalls = (from) => r.calls.slice(from).filter((c) => c.type.startsWith("userFills")).map((c) => [c.type, c.startTime]);
  let n0 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  assert.deepEqual(fillCalls(n0), [["userFills", undefined]]);
  assert.deepEqual([snap(r, ADDR.B).fills.answered, snap(r, ADDR.B).fills.list.length, snap(r, ADDR.B).fills.partial], [true, 0, false]);
  history = newestFirst([mkFill(1), mkFill(2)]);
  n0 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  assert.deepEqual(fillCalls(n0), [["userFills", undefined]]);
  n0 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  assert.deepEqual(fillCalls(n0), [["userFillsByTime", mkFill(2).time]]);
  assert.equal(snap(r, ADDR.B).fills.list.length, 2);
});

test("K5) a gap read that comes back FULL may have left fills out: the history is flagged partial and the newest page is read in full at once", async () => {
  let history = newestFirst(Array.from({ length: 1500 }, (_, i) => mkFill(i)));
  const base = answersFor();
  const r = rig({ answer: (q) => {
    if (q.type === "userFills") return history.slice(0, 2000);
    if (q.type === "userFillsByTime") return history.filter((f) => f.time >= q.startTime).reverse().slice(0, 2000);
    return base(q);
  } });
  r.store.retain(ADDR.B);
  await settle();
  assert.equal(snap(r, ADDR.B).fills.partial, false);
  history = newestFirst(Array.from({ length: 4000 }, (_, i) => mkFill(i)));
  const n0 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  const seq = r.calls.slice(n0).filter((c) => c.type.startsWith("userFills")).map((c) => c.type);
  assert.deepEqual(seq, ["userFillsByTime", "userFills"], "the full newest page follows the full gap page");
  const f = snap(r, ADDR.B).fills;
  assert.equal(f.partial, true, "a hole may sit between the pages: never presented as the whole history");
  assert.equal(f.list.length, 2000);
  assert.equal(f.list[0].tid, mkFill(3999).tid, "the newest fill is there");
  const n1 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  assert.deepEqual(r.calls.slice(n1).filter((c) => c.type.startsWith("userFills")).map((c) => [c.type, c.startTime]),
    [["userFillsByTime", mkFill(3999).time]], "the full page re-anchored the next read");
  assert.equal(snap(r, ADDR.B).fills.partial, true, "and a small read later does not clear the flag");
});

test("K6) a failed gap read keeps the history and its start: the error is reported and the next read asks from the same fill", async () => {
  let failing = false;
  const base = answersFor();
  const r = rig({ answer: (q) => { if (failing && q.type === "userFillsByTime") throw new Error("HTTP 429"); return base(q); } });
  r.store.retain(ADDR.A);
  await settle();
  failing = true;
  await r.store.refresh(ADDR.A);
  await settle();
  let s = snap(r, ADDR.A);
  assert.match(s.error, /429/);
  assert.deepEqual([s.fills.answered, s.fills.list.length, s.fills.partial], [true, 6, false], "what was known stays");
  failing = false;
  const n0 = r.calls.length;
  await r.store.refresh(ADDR.A);
  await settle();
  assert.equal(r.calls.slice(n0).find((c) => c.type === "userFillsByTime").startTime, A.userFillsByTimeStart);
  s = snap(r, ADDR.A);
  assert.equal(s.error, null);
  assert.equal(s.fills.list.length, 16);
});

test("K7) the mode rides webData3: an action's refresh re-reads it only when that stream was rejected", async () => {
  const r = rig();
  r.store.retain(ADDR.B);
  await settle();
  let n0 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  assert.equal(r.calls.slice(n0).some((c) => c.type === "userAbstraction"), false);
  r.ws.reject("webData3", "Too many users");
  n0 = r.calls.length;
  await r.store.refresh(ADDR.B);
  await settle();
  assert.equal(r.calls.slice(n0).filter((c) => c.type === "userAbstraction").length, 1);
  assert.deepEqual(snap(r, ADDR.B).mode.value, "disabled");
});

/* ── G. the hook ───────────────────────────────────────────────────────── */

test("G1) the hook's first render is the unknown one: every figure null, nothing fetched during render", () => {
  let seen = null;
  const Probe = ({ address }) => { seen = H.usePerpAccount(address); return React.createElement("i", null, seen.perpBalanceUsdc.equityUsdc == null ? "—" : String(seen.perpBalanceUsdc.equityUsdc)); };
  const html = renderToString(React.createElement(Probe, { address: ADDR.A }));
  assert.match(html, /—/);
  assert.equal(seen.perpBalanceUsdc.answered, false);
  assert.equal(seen.address, ADDR.A);
  const none = renderToString(React.createElement(Probe, { address: null }));
  assert.match(none, /—/);
  assert.deepEqual(touched, { fetch: 0, ws: 0 }, "a server render subscribes to nothing");
});

/* ── H. the real ws.js, over a fake socket ─────────────────────────────── */

test("H1) over the REAL ws.js: one socket, subscribe frames keyed by the master, pushes routed, foreign users filtered", async () => {
  const clock = fakeClock();
  const sockets = [];
  const hl = createHlWs({
    createSocket: () => {
      const s = { sent: [], readyState: 0, send(x) { s.sent.push(JSON.parse(x)); }, close() { s.readyState = 3; if (s.onclose) s.onclose({}); } };
      sockets.push(s);
      return s;
    },
    timers: clock.timers, now: clock.now, random: () => 0.5, isHidden: () => false, onVisibilityChange: () => () => {},
  });
  const r = rig({ wsImpl: hl });
  r.store.retain(ADDR.B);
  r.store.retain(ADDR.C);
  await settle();
  assert.equal(sockets.length, 1, "one socket for the tab, however many addresses and streams");
  const sock = sockets[0];
  sock.readyState = 1;
  sock.onopen({});
  const subs = sock.sent.filter((m) => m.method === "subscribe").map((m) => m.subscription);
  assert.equal(subs.length, 22, "nine streams plus the venue's own pair, for each of the two addresses");
  assert.ok(subs.every((s) => s.user === ADDR.B || s.user === ADDR.C));
  /* hlSubKey includes the dex, so the main dex's pair and the venue's are four
     DISTINCT server subscriptions, not two that overwrite each other. */
  for (const user of [ADDR.B, ADDR.C]) {
    assert.deepEqual(subs.filter((x) => x.user === user && x.type === "clearinghouseState").map((x) => x.dex).sort(), ["", "xyz"]);
    assert.deepEqual(subs.filter((x) => x.user === user && x.type === "openOrders").map((x) => x.dex).sort(), ["", "xyz"]);
  }
  const moved = structuredClone(C.clearinghouseState);
  moved.time = C.clearinghouseState.time + 1000;
  moved.assetPositions[0].position.unrealizedPnl = "-12.5";
  sock.onmessage({ data: JSON.stringify({ channel: "clearinghouseState", data: { dex: "", user: ADDR.C, clearinghouseState: moved } }) });
  assert.equal(snap(r, ADDR.C).positions.byCoin.BTC.unrealizedPnl, -12.5);
  assert.equal(snap(r, ADDR.B).positions.list.length, 2, "B's positions untouched by C's push");
  assert.equal(snap(r, ADDR.B).positions.byCoin.BTC.szi, -0.17449);
});

test("H2) over the REAL ws.js: a liquidation still surfaces through userFills even when userEvents stays silent", async () => {
  const clock = fakeClock();
  const sockets = [];
  const hl = createHlWs({
    createSocket: () => { const s = { sent: [], send(x) { s.sent.push(JSON.parse(x)); }, close() {} }; sockets.push(s); return s; },
    timers: clock.timers, now: clock.now, random: () => 0.5, isHidden: () => false, onVisibilityChange: () => () => {},
  });
  const r = rig({ wsImpl: hl });
  r.store.retain(ADDR.B);
  await settle();
  const sock = sockets[0];
  sock.onopen({});
  const seen = [];
  r.store.onEvent(ADDR.B, (e) => seen.push(e.kind));
  /* userEvents arrive on channel "user" (subscriptions page) */
  sock.onmessage({ data: JSON.stringify({ channel: "user", data: { liquidation: { lid: 1, liquidator: "0x5555555555555555555555555555555555555555", liquidated_user: ADDR.B, liquidated_ntl_pos: "15000.0", liquidated_account_value: "10.0" } } }) });
  sock.onmessage({ data: JSON.stringify({ channel: "userFills", data: { isSnapshot: false, user: ADDR.B, fills: [{ coin: "BTC", px: "99000.0", sz: "0.17449", side: "B", time: clock.now(), startPosition: "-0.17449", dir: "Close Short", closedPnl: "-2300.0", hash: "0xliq", oid: 9, crossed: true, fee: "5.0", tid: 79, feeToken: "USDC", liquidation: { liquidatedUser: ADDR.B, markPx: "99010.0", method: "market" } }] } }) });
  assert.ok(seen.includes("liquidation"));
  assert.equal(snap(r, ADDR.B).events.filter((e) => e.kind === "liquidation" && e.lead).length, 1, "one liquidation, one lead event, whichever streams carried it");
});

/* ── I. source guards (comments stripped) ─────────────────────────────── */

function stripComments(raw) {
  let out = "", i = 0, inBlock = false, inLine = false, quote = null;
  while (i < raw.length) {
    const two = raw.slice(i, i + 2);
    if (inBlock) { if (two === "*" + "/") { inBlock = false; i += 2; } else i += 1; continue; }
    if (inLine) { if (raw[i] === "\n") { inLine = false; out += "\n"; } i += 1; continue; }
    if (quote) { out += raw[i]; if (raw[i] === "\\") { out += raw[i + 1] || ""; i += 2; continue; } if (raw[i] === quote) quote = null; i += 1; continue; }
    if (raw[i] === '"' || raw[i] === "'" || raw[i] === "`") { quote = raw[i]; out += raw[i]; i += 1; continue; }
    if (two === "/" + "*") { inBlock = true; i += 2; continue; }
    if (two === "//") { inLine = true; i += 2; continue; }
    out += raw[i]; i += 1;
  }
  return out;
}
const accountFiles = () => fs.readdirSync(path.join(ROOT, ACCOUNT_DIR)).filter((f) => f.endsWith(".js")).map((f) => `${ACCOUNT_DIR}/${f}`);
const code = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));

test("I1) MONEY_RULES in the source: no zero fallback between an unknown and the screen", () => {
  const files = accountFiles();
  assert.ok(files.length >= 5, files.join(", "));
  for (const f of files) {
    const c = code(f);
    assert.doesNotMatch(c, /\?\?\s*0(?![.\d])/, `${f}: a ?? 0 turns an unknown into a confident zero`);
    assert.doesNotMatch(c, /\|\|\s*0(?![.\d])/, `${f}: an || 0 does the same`);
    assert.doesNotMatch(c, /Math\.max\(\s*0\s*,/, `${f}: a floor at zero hides a real negative`);
  }
});

test("I2) the account layer reads; it never signs, sends or opens a connection of its own", () => {
  for (const f of accountFiles()) {
    const c = code(f);
    assert.doesNotMatch(c, /new WebSocket|fetch\(|XMLHttpRequest|api\.hyperliquid|\/exchange|signTypedData|privateKey|sendTransaction|localStorage|import\.meta\.env/, `${f}`);
    for (const m of c.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      /* ../venues.js is a PURE leaf: it holds the HIP-3 venue list and the asset-id
         maths, imports only ./coins.js, fetches nothing and runs nothing at import
         time (its own header says so, and B7 of the exchange bundle suite proves
         the same rule for that layer). The store needs the venue NAMES from it. */
      assert.ok(spec === "react" || spec.startsWith("./") || ["../info.js", "../ws.js", "../browser.js", "../venues.js"].includes(spec), `${f} imports ${spec}`);
    }
  }
});

test("I4) every account file is LF-only", () => {
  for (const f of accountFiles()) assert.equal(fs.readFileSync(path.join(ROOT, f), "utf8").includes("\r\n"), false, f);
});

test("I5) the flag-off build ships none of this: the eager hyperliquid barrel never re-exports the account layer, and only perp surfaces import it", () => {
  assert.doesNotMatch(code("src/lib/hyperliquid/index.js"), /account/);
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, out); else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(rel);
    }
    return out;
  };
  const allowed = (f) => f.startsWith(`${ACCOUNT_DIR}/`) || f.startsWith("src/perp/")
    || f.startsWith("src/lib/hyperliquid/exchange/") || f.startsWith("src/lib/relay/");
  const importers = walk("src").filter((f) => /hyperliquid\/account|from\s+["']\.\/account/.test(code(f)));
  assert.deepEqual(importers.filter((f) => !allowed(f)), [], "a main-chunk import would put the account streams in the flag-off build");
});

/* ── L. the role is the one figure asked twice ─────────────────────────── */

/* Measured 2026-09-28: the deposit screen prices a first deposit on this one
   answer, and a single refusal used to buy the expensive route for the whole
   time the sheet stayed open, because nothing in the store ever asked again. */

function roleRig({ failures = 1 } = {}) {
  let left = failures;
  const base = answersFor();
  const asked = [];
  const answer = (body) => {
    if (body.type === "userRole") {
      asked.push(body.user);
      if (left > 0) { left -= 1; throw new Error("429 too many requests"); }
    }
    return base(body);
  };
  return { rig: rig({ answer }), asked };
}

test("L1) a role that failed is asked ONCE more, and the answer lands", async () => {
  const { rig: r, asked } = roleRig({ failures: 1 });
  const release = r.store.retain(ADDR.FRESH);
  await settle();
  assert.equal(asked.length, 1, "asked once to begin with");
  assert.equal(snap(r, ADDR.FRESH).role.answered, false, "and it did not answer");
  r.clock.advance(S.PERP_ACCOUNT_ROLE_RECHECK_MS);
  await settle();
  assert.equal(asked.length, 2, "asked again");
  assert.equal(snap(r, ADDR.FRESH).role.answered, true, "and the second answer is in");
  assert.equal(snap(r, ADDR.FRESH).role.value, FRESH.userRole.role);
  release();
});

test("L2) a second failure is NOT asked again: one re-ask per answer, never a loop", async () => {
  const { rig: r, asked } = roleRig({ failures: 9 });
  const release = r.store.retain(ADDR.FRESH);
  await settle();
  r.clock.advance(S.PERP_ACCOUNT_ROLE_RECHECK_MS);
  await settle();
  assert.equal(asked.length, 2, "the one re-ask");
  for (let i = 0; i < 4; i++) { r.clock.advance(S.PERP_ACCOUNT_ROLE_RECHECK_MS); await settle(); }
  assert.equal(asked.length, 2, "and no more, however long nobody answers");
  release();
});

test("L3) only the role is re-asked: another figure's failure schedules nothing", async () => {
  const base = answersFor();
  const spot = [];
  const answer = (body) => {
    if (body.type === "spotClearinghouseState") { spot.push(1); throw new Error("429 too many requests"); }
    return base(body);
  };
  const r = rig({ answer });
  const release = r.store.retain(ADDR.FRESH);
  await settle();
  assert.equal(spot.length, 1);
  r.clock.advance(S.PERP_ACCOUNT_ROLE_RECHECK_MS);
  await settle();
  assert.equal(spot.length, 1, "a figure a poll will correct is not worth a second request");
  release();
});

test.after(() => { globalThis.fetch = realFetch; globalThis.WebSocket = RealWebSocket; });
