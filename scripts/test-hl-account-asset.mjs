/**
 * test-hl-account-asset — what the user may trade on ONE coin: Hyperliquid's
 * activeAssetData (leverage setting, available to trade, max trade size),
 * read per (MASTER address, coin) behind usePerpAssetData.
 *
 *   node --test scripts/test-hl-account-asset.mjs
 *
 * Why it exists: the account's free USDC (perpBalanceUsdc.availableUsdc) is
 * not what a new order may use. Measured live (MEASURED.availableVsFree in
 * scripts/test-hl-account-fixtures.mjs): a standard account with 0.0
 * withdrawable had 1703.80 available to trade. A ticket that capped the amount
 * at the free figure would refuse a trade Hyperliquid accepts.
 *
 * Nothing here touches the network: info and the socket manager are fakes,
 * and section E runs the REAL ws.js over a fake socket. Answers replayed are
 * the live captures in the fixtures file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { A, B, ADDR, MEASURED } from "./test-hl-account-fixtures.mjs";

const touched = { fetch: 0, ws: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { touched.fetch++; return realFetch(...a); };
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class { constructor() { touched.ws++; throw new Error("no socket in tests"); } };

const P = await import("../src/lib/hyperliquid/account/parse.js");
const AD = await import("../src/lib/hyperliquid/account/assetData.js");
const IDX = await import("../src/lib/hyperliquid/account/index.js");
const { createHlWs } = await import("../src/lib/hyperliquid/ws.js");

/* ── fakes (the same shapes as test-hl-account-store) ─────────────────── */

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

function fakeWs(initial = "idle") {
  const subs = [];
  const statusFns = new Set();
  let st = initial;
  return {
    subs,
    subscribe(sub, onData, opts = {}) {
      const rec = { sub, onData, onError: opts.onError, live: true };
      subs.push(rec);
      return () => { rec.live = false; };
    },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    status: () => st,
    emitStatus(s) { st = s; for (const fn of [...statusFns]) fn(s); },
    live: () => subs.filter((r) => r.live),
    /* ws.js matches an activeAssetData push by coin only, not by user */
    push(data) { for (const r of subs.filter((x) => x.live && x.sub.coin === data.coin)) r.onData(data); },
    reject(coin, msg = "Invalid subscription") { for (const r of subs.filter((x) => x.live && x.sub.coin === coin)) if (r.onError) r.onError(msg); },
    statusListeners: () => statusFns.size,
  };
}

const ANSWERS = {
  [`${ADDR.A}|SOL`]: A.activeAssetDataSOL,
  [`${ADDR.B}|ETH`]: B.activeAssetDataETH,
};

function rig({ hidden = false, wsImpl = null, answer = null } = {}) {
  const clock = fakeClock();
  const ws = wsImpl || fakeWs();
  const visFns = new Set();
  let isHid = hidden;
  const calls = [];
  const gates = [];
  let gated = null;
  const reply = answer || ((body) => {
    const a = ANSWERS[`${body.user}|${body.coin}`];
    if (!a) throw new Error(`no capture for ${body.user} ${body.coin}`);
    return a;
  });
  const info = (body) => {
    calls.push(structuredClone(body));
    if (gated && gated(body)) return new Promise((res, rej) => gates.push({ body, res: () => res(structuredClone(reply(body))), rej }));
    try { return Promise.resolve(structuredClone(reply(body))); } catch (e) { return Promise.reject(e); }
  };
  const store = AD.createPerpAssetDataStore({
    info, ws, timers: clock.timers, now: clock.now,
    isHidden: () => isHid,
    onVisibilityChange: (fn) => { visFns.add(fn); return () => visFns.delete(fn); },
  });
  return {
    clock, ws, store, calls, gates,
    gate(pred) { gated = pred; },
    setHidden(h) { isHid = h; for (const fn of [...visFns]) fn(); },
    visListeners: () => visFns.size,
  };
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

/* ── A. parsing the live answer ────────────────────────────────────────── */

test("A1) importing the module opens no socket and sends no request", () => {
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
  assert.equal(typeof IDX.usePerpAssetData, "function");
  assert.equal(typeof IDX.createPerpAssetDataStore, "function");
  assert.equal(typeof IDX.parseActiveAssetData, "function");
});

test("A2) activeAssetData: the leverage setting and Hyperliquid's own pairs, strings become numbers; the mark is NOT taken from here", () => {
  const b = P.parseActiveAssetData(B.activeAssetDataETH);
  assert.deepEqual(b, {
    user: ADDR.B,
    coin: "ETH",
    leverage: { type: "cross", value: 25, rawUsd: null },
    maxTradeSzs: [15.4857, 15.4857],
    availableToTrade: [1703.800459, 1703.800459],
  });
  assert.equal("markPx" in b, false, "the market layer owns the mark: one source per figure");
  const a = P.parseActiveAssetData({ channel: "activeAssetData", data: A.activeAssetDataSOL }.data);
  assert.deepEqual(a.availableToTrade, [85261.294132, 85261.294132]);
});

test("A3) unreadable is null, never a zero; one bad entry in a pair is that entry's dash", () => {
  for (const bad of [null, "x", [], {}, { coin: "ETH" }, { user: ADDR.B }]) assert.equal(P.parseActiveAssetData(bad), null, JSON.stringify(bad));
  const odd = P.parseActiveAssetData({ ...B.activeAssetDataETH, availableToTrade: ["12.5", "NaN"], maxTradeSzs: "nope", leverage: null });
  assert.deepEqual(odd.availableToTrade, [12.5, null]);
  assert.equal(odd.maxTradeSzs, null);
  assert.deepEqual(odd.leverage, { type: null, value: null, rawUsd: null });
  const short = P.parseActiveAssetData({ ...B.activeAssetDataETH, availableToTrade: ["1.0"] });
  assert.equal(short.availableToTrade, null, "a pair that is not a pair is not read");
});

test("A4) MEASURED: the free USDC and the available-to-trade are different figures; this layer never swaps one for the other", () => {
  const m = MEASURED.availableVsFree;
  assert.ok(m.B.availableToTrade > 1000 && m.B.withdrawable === 0);
  assert.ok(Math.abs((m.A.spotTotal - m.A.spotHold) - m.A.availableToTrade) > 1000);
});

/* ── B. the store: one REST read and one stream per (master, coin) ─────── */

test("B1) retain: unanswered first (every figure a dash), then ONE REST read and ONE stream keyed by the lowercased master and the coin", async () => {
  const r = rig();
  const release = r.store.retain(ADDR.B.toUpperCase().replace("0X", "0x"), "ETH");
  const s0 = r.store.getSnapshot(ADDR.B, "ETH");
  assert.deepEqual([s0.address, s0.coin, s0.answered], [ADDR.B, "ETH", false]);
  assert.equal(s0.availableToTrade, null);
  assert.equal(s0.maxTradeSzs, null);
  assert.deepEqual(s0.leverage, { type: null, value: null, rawUsd: null });
  assert.deepEqual(r.ws.live().map((x) => x.sub), [{ type: "activeAssetData", user: ADDR.B, coin: "ETH" }]);
  await settle();
  assert.deepEqual(r.calls, [{ type: "activeAssetData", user: ADDR.B, coin: "ETH" }]);
  const s = r.store.getSnapshot(ADDR.B, "ETH");
  assert.equal(s.answered, true);
  assert.deepEqual(s.availableToTrade, [1703.800459, 1703.800459]);
  assert.deepEqual(s.maxTradeSzs, [15.4857, 15.4857]);
  assert.deepEqual(s.leverage, { type: "cross", value: 25, rawUsd: null });
  assert.equal(s.stale, false);
  assert.ok(Object.isFrozen(s));
  assert.equal(r.store.getSnapshot(ADDR.B, "ETH"), s, "stable until something changes");
  release();
  assert.equal(r.ws.live().length, 0);
});

test("B2) two surfaces on one (master, coin) share one read and one stream; another coin is its own", async () => {
  const r = rig();
  const x = r.store.retain(ADDR.A, "SOL");
  const y = r.store.retain(ADDR.A.toUpperCase().replace("0X", "0x"), "SOL");
  await settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.ws.live().length, 1);
  x();
  assert.equal(r.ws.live().length, 1, "the other surface still holds it");
  y();
  assert.equal(r.ws.live().length, 0);
});

test("B3) no address, not an address, or no coin: the empty snapshot and nothing asked", async () => {
  const r = rig();
  for (const [a, c] of [[null, "ETH"], ["0xnope", "ETH"], [ADDR.B, ""], [ADDR.B, null], [ADDR.B, 7]]) {
    const release = r.store.retain(a, c);
    const s = r.store.getSnapshot(a, c);
    assert.equal(s.answered, false);
    assert.equal(s.availableToTrade, null);
    release();
  }
  await settle();
  assert.equal(r.calls.length, 0);
  assert.equal(r.ws.subs.length, 0);
});

/* ── C. streams ────────────────────────────────────────────────────────── */

test("C1) a push for ANOTHER user on the same coin is ignored; the user's own push moves the figures", async () => {
  const r = rig();
  r.store.retain(ADDR.B, "ETH");
  await settle();
  r.ws.push({ ...B.activeAssetDataETH, user: ADDR.A, availableToTrade: ["9.0", "9.0"] });
  assert.deepEqual(r.store.getSnapshot(ADDR.B, "ETH").availableToTrade, [1703.800459, 1703.800459]);
  r.ws.push({ ...B.activeAssetDataETH, leverage: { type: "isolated", value: 5, rawUsd: "-12.0" }, availableToTrade: [1500.5, 1400.25] });
  const s = r.store.getSnapshot(ADDR.B, "ETH");
  assert.deepEqual(s.availableToTrade, [1500.5, 1400.25], "the WS frame sends numbers, REST sends strings: both read");
  assert.deepEqual(s.leverage, { type: "isolated", value: 5, rawUsd: -12 });
});

test("C2) a push newer than a slow REST read wins; the late answer does not roll it back", async () => {
  const r = rig();
  r.gate(() => true);
  r.store.retain(ADDR.B, "ETH");
  await settle();
  r.ws.push({ ...B.activeAssetDataETH, availableToTrade: ["42.0", "42.0"] });
  for (const g of r.gates) g.res();
  await settle();
  assert.deepEqual(r.store.getSnapshot(ADDR.B, "ETH").availableToTrade, [42, 42]);
});

test("C3) a failed read keeps what was known and says why; an unanswered figure stays a dash", async () => {
  let fail = true;
  const r = rig({ answer: (b) => { if (fail) throw new Error("Hyperliquid unreachable"); return B.activeAssetDataETH; } });
  r.store.retain(ADDR.B, "ETH");
  await settle();
  let s = r.store.getSnapshot(ADDR.B, "ETH");
  assert.equal(s.answered, false);
  assert.equal(s.availableToTrade, null);
  assert.match(s.error, /unreachable/);
  fail = false;
  await r.store.refresh(ADDR.B, "ETH");
  await settle();
  s = r.store.getSnapshot(ADDR.B, "ETH");
  assert.deepEqual([s.answered, s.error], [true, null]);
  fail = true;
  await r.store.refresh(ADDR.B, "ETH");
  await settle();
  s = r.store.getSnapshot(ADDR.B, "ETH");
  assert.deepEqual(s.availableToTrade, [1703.800459, 1703.800459], "known figures stay");
  assert.match(s.error, /unreachable/);
});

/* ── D. reconnect, visibility, rejection ───────────────────────────────── */

test("D1) a reconnect marks it stale and takes ONE fresh read; the first open is not a resubscribe", async () => {
  const r = rig();
  r.store.retain(ADDR.B, "ETH");
  await settle();
  r.ws.emitStatus("connecting");
  r.ws.emitStatus("open");
  await settle();
  assert.equal(r.calls.length, 1, "the first open does not re-read");
  r.ws.emitStatus("reconnecting");
  assert.equal(r.store.getSnapshot(ADDR.B, "ETH").stale, true);
  assert.deepEqual(r.store.getSnapshot(ADDR.B, "ETH").availableToTrade, [1703.800459, 1703.800459], "flagged, not blanked");
  r.ws.emitStatus("open");
  await settle();
  assert.equal(r.calls.length, 2);
  assert.equal(r.store.getSnapshot(ADDR.B, "ETH").stale, false);
});

test("D2) retained while the shared socket is already open: a later drop still marks it stale and refreshes on return", async () => {
  const ws = fakeWs("open");
  const r = rig({ wsImpl: ws });
  r.store.retain(ADDR.B, "ETH");
  await settle();
  ws.emitStatus("paused");
  assert.equal(r.store.getSnapshot(ADDR.B, "ETH").stale, true);
  ws.emitStatus("open");
  await settle();
  assert.equal(r.calls.length, 2);
});

test("D3) a REJECTED stream falls back to REST every 15 s only while visible; hidden asks nothing; release stops it all", async () => {
  const r = rig();
  const release = r.store.retain(ADDR.B, "ETH");
  await settle();
  r.ws.reject("ETH");
  r.clock.advance(AD.PERP_ASSET_POLL_MS);
  await settle();
  assert.equal(r.calls.length, 2);
  r.setHidden(true);
  r.clock.advance(AD.PERP_ASSET_POLL_MS * 4);
  await settle();
  assert.equal(r.calls.length, 2, "nothing while hidden");
  r.setHidden(false);
  await settle();
  assert.equal(r.calls.length, 3, "coming back reads at once");
  release();
  r.clock.advance(AD.PERP_ASSET_POLL_MS * 4);
  await settle();
  assert.equal(r.calls.length, 3);
  assert.equal(r.clock.pending(), 0, "no timer left behind");
  assert.equal(r.ws.statusListeners(), 0);
  assert.equal(r.visListeners(), 0);
});

test("D4) refresh() right after an action reads again (a leverage change moves these figures)", async () => {
  const r = rig();
  r.store.retain(ADDR.B, "ETH");
  await settle();
  await r.store.refresh(ADDR.B, "ETH");
  await settle();
  assert.equal(r.calls.length, 2);
  await r.store.refresh(ADDR.A, "SOL");
  assert.equal(r.calls.length, 2, "not retained: nothing asked");
});

/* ── E. the real ws.js, the hook ───────────────────────────────────────── */

test("E1) over the REAL ws.js: rides the tab's one socket, keyed by master and coin; another user's push on the coin is dropped", async () => {
  const clock = fakeClock();
  const sockets = [];
  const hl = createHlWs({
    createSocket: () => { const s = { sent: [], send(x) { s.sent.push(JSON.parse(x)); }, close() {} }; sockets.push(s); return s; },
    timers: clock.timers, now: clock.now, random: () => 0.5, isHidden: () => false, onVisibilityChange: () => () => {},
  });
  const r = rig({ wsImpl: hl });
  r.store.retain(ADDR.B, "ETH");
  r.store.retain(ADDR.A, "SOL");
  await settle();
  assert.equal(sockets.length, 1);
  sockets[0].onopen({});
  assert.deepEqual(sockets[0].sent.map((m) => m.subscription), [
    { type: "activeAssetData", user: ADDR.B, coin: "ETH" },
    { type: "activeAssetData", user: ADDR.A, coin: "SOL" },
  ]);
  sockets[0].onmessage({ data: JSON.stringify({ channel: "activeAssetData", data: { ...B.activeAssetDataETH, user: ADDR.A, availableToTrade: [1, 1] } }) });
  assert.deepEqual(r.store.getSnapshot(ADDR.B, "ETH").availableToTrade, [1703.800459, 1703.800459]);
  sockets[0].onmessage({ data: JSON.stringify({ channel: "activeAssetData", data: { ...B.activeAssetDataETH, availableToTrade: [7, 8] } }) });
  assert.deepEqual(r.store.getSnapshot(ADDR.B, "ETH").availableToTrade, [7, 8]);
});

test("E2) the hook's first render is the unknown one, and a server render subscribes to nothing", () => {
  let seen = null;
  const Probe = ({ address, coin }) => {
    seen = IDX.usePerpAssetData(address, coin);
    return React.createElement("i", null, seen.availableToTrade == null ? "—" : String(seen.availableToTrade[0]));
  };
  assert.match(renderToString(React.createElement(Probe, { address: ADDR.B, coin: "ETH" })), /—/);
  assert.deepEqual([seen.address, seen.coin, seen.answered], [ADDR.B, "ETH", false]);
  assert.match(renderToString(React.createElement(Probe, { address: null, coin: "ETH" })), /—/);
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
});

test.after(() => { globalThis.fetch = realFetch; globalThis.WebSocket = RealWebSocket; });
