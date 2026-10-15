/**
 * test-hl-markets — metaAndAssetCtxs into market rows, and the one market store
 * behind usePerpMarkets() / usePerpMarket(coin).
 *
 *   node --test scripts/test-hl-markets.mjs
 *
 * Live facts pinned (read-only, 2026-09-22): metaAndAssetCtxs answers
 * [meta{universe, marginTables, collateralToken}, assetCtxs[]]; every number is
 * a STRING; 56 of 234 main-dex assets carry isDelisted:true; a delisted asset
 * has midPx null and premium null. The fixture rows below are copied from that
 * answer (plus two synthetic rows for the unknown and isolated cases).
 *
 * MONEY_RULES section 0: an unknown is null here and a dash on screen, never 0.
 * Section 1: two surfaces showing the same figure must be incapable of
 * disagreeing, so the list and the single-market page read ONE store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import React from "react";

/* Count any network or socket use from merely IMPORTING the modules. */
const touched = { fetch: 0, ws: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { touched.fetch++; return realFetch(...a); };
globalThis.WebSocket = class { constructor() { touched.ws++; throw new Error("no socket in tests"); } };

const M = await import("../src/lib/hyperliquid/markets.js");
await import("../src/lib/hyperliquid/index.js");
const {
  parsePerpMarkets, applyMids, createPerpMarketsStore, isPerpMarketStale,
  usePerpMarkets, usePerpMarket, PERP_MARKETS_REFRESH_MS,
} = M;

const FIXTURE = [
  {
    universe: [
      { szDecimals: 5, name: "BTC", maxLeverage: 40, marginTableId: 56 },
      { szDecimals: 4, name: "ETH", maxLeverage: 25, marginTableId: 55 },
      { szDecimals: 1, name: "MATIC", maxLeverage: 20, marginTableId: 20, isDelisted: true },
      { szDecimals: 0, name: "kPEPE", maxLeverage: 10, marginTableId: 52 },
      { szDecimals: 0, name: "HPOS", maxLeverage: 3, marginTableId: 3, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" },
      { szDecimals: 2, name: "ISO", maxLeverage: 5, marginTableId: 5, onlyIsolated: true, marginMode: "strictIsolated" },
      { szDecimals: 2, name: "BLANK", maxLeverage: 3, marginTableId: 3 },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  [
    { funding: "0.0000125", openInterest: "43783.58574", prevDayPx: "81352.0", dayNtlVlm: "4978314588.7248125076", premium: "0.0005472071", oraclePx: "85525.2", markPx: "85573.0", midPx: "85572.5", impactPxs: ["85572.0", "85573.0"], dayBaseVlm: "58579.6650099998" },
    { funding: "0.0000125", openInterest: "1134050.2109999994", prevDayPx: "2663.5", dayNtlVlm: "2062545208.2272090912", premium: "0.0001426946", oraclePx: "2733.11", markPx: "2734.2", midPx: "2733.55", impactPxs: ["2733.5", "2733.6"], dayBaseVlm: "753915.9263999998" },
    { funding: "0.0", openInterest: "0.0", prevDayPx: "0.37621", dayNtlVlm: "0.0", premium: null, oraclePx: "0.3754", markPx: "0.37621", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
    { funding: "0.000183796", openInterest: "10733474102.0", prevDayPx: "0.004011", dayNtlVlm: "140311839.3819201887", premium: "0.002744022", oraclePx: "0.005102", markPx: "0.005114", midPx: "0.005116", impactPxs: ["0.005116", "0.005118"], dayBaseVlm: "29520980362.0" },
    { funding: "0.0", openInterest: "0.0", prevDayPx: "0.041845", dayNtlVlm: "0.0", premium: null, oraclePx: "0.042203", markPx: "0.041873", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
    { funding: "0.00001", openInterest: "100.0", prevDayPx: "10.0", dayNtlVlm: "5000.0", premium: "0.0", oraclePx: "11.0", markPx: "11.0", midPx: "11.0", impactPxs: ["11.0", "11.0"], dayBaseVlm: "500.0" },
    { funding: "", openInterest: null, prevDayPx: "0.0", dayNtlVlm: undefined, premium: null, oraclePx: "abc", markPx: "", midPx: null, impactPxs: null, dayBaseVlm: "0.0" },
  ],
];

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

/* ── parsing ───────────────────────────────────────────────────────────── */

test("delisted assets are filtered; assetIndex is the index in the FULL universe", () => {
  const { markets, byCoin, universeSize, delistedCount } = parsePerpMarkets(FIXTURE);
  assert.equal(universeSize, 7);
  assert.equal(delistedCount, 2);
  assert.deepEqual(markets.map((m) => m.coin), ["BTC", "ETH", "kPEPE", "ISO", "BLANK"]);
  assert.equal(byCoin.kPEPE.assetIndex, 3, "an order needs the universe index, delisted rows included");
  assert.equal(byCoin.ISO.assetIndex, 5);
  assert.equal(byCoin.MATIC, undefined);
});

test("numbers arrive as strings and leave as numbers", () => {
  const { byCoin: { BTC } } = parsePerpMarkets(FIXTURE);
  assert.equal(BTC.coin, "BTC");
  assert.equal(BTC.szDecimals, 5);
  assert.equal(BTC.maxLeverage, 40);
  assert.equal(BTC.onlyIsolated, false);
  assert.equal(BTC.markPx, 85573);
  assert.equal(BTC.midPx, 85572.5);
  assert.equal(BTC.oraclePx, 85525.2);
  assert.equal(BTC.prevDayPx, 81352);
  assert.equal(BTC.funding, 0.0000125);
  assert.equal(BTC.premium, 0.0005472071);
  near(BTC.dayNtlVlm, 4978314588.7248125076);
  assert.equal(BTC.openInterest, 43783.58574);
  for (const k of ["markPx", "midPx", "oraclePx", "prevDayPx", "funding", "dayNtlVlm", "openInterest", "openInterestUsd", "change24hPct", "px"]) {
    assert.equal(typeof BTC[k], "number", k);
  }
});

test("derived figures: open interest in USD is openInterest x markPx; 24h change follows the shown price", () => {
  const { byCoin: { BTC, ISO } } = parsePerpMarkets(FIXTURE);
  near(BTC.openInterestUsd, 43783.58574 * 85573);
  assert.equal(BTC.px, 85572.5, "the shown price is the mid when there is one");
  near(BTC.change24hPct, ((85572.5 - 81352) / 81352) * 100);
  near(BTC.change24hUsd, 85572.5 - 81352);
  assert.equal(ISO.onlyIsolated, true);
  assert.equal(ISO.marginMode, "strictIsolated");
  near(ISO.change24hPct, 10);
});

test("unknowns are null, never 0 — and a measured zero stays zero", () => {
  const { byCoin: { BLANK } } = parsePerpMarkets(FIXTURE);
  for (const k of ["markPx", "midPx", "oraclePx", "funding", "openInterest", "dayNtlVlm", "openInterestUsd", "px", "change24hPct", "change24hUsd", "premium"]) {
    assert.equal(BLANK[k], null, k);
  }
  assert.equal(BLANK.prevDayPx, 0, "a measured zero is a number");
});

test("a 24h change against a zero previous price is unknown, not Infinity", () => {
  const j = structuredClone(FIXTURE);
  j[1][0].prevDayPx = "0.0";
  const { byCoin: { BTC } } = parsePerpMarkets(j);
  assert.equal(BTC.change24hPct, null);
});

test("a malformed answer parses to nothing rather than throwing into a render", () => {
  for (const bad of [null, {}, [], [{}], [{ universe: "x" }, []], "oops"]) {
    const out = parsePerpMarkets(bad);
    assert.deepEqual(out.markets, []);
  }
  // Contexts shorter than the universe: the row exists, its market figures are unknown.
  const j = structuredClone(FIXTURE);
  j[1] = j[1].slice(0, 1);
  const { byCoin } = parsePerpMarkets(j);
  assert.equal(byCoin.ETH.markPx, null);
  assert.equal(byCoin.ETH.szDecimals, 4);
});

test("applyMids moves the shown price and the 24h change; the mark stays the exchange's mark", () => {
  const base = parsePerpMarkets(FIXTURE).markets;
  const { markets, changed } = applyMids(base, { BTC: "85600.0", ETH: "not a number", "@1": "3.2", "#12090": "0.5", "PURR/USDC": "0.1" }, 5);
  assert.equal(changed, true);
  const btc = markets.find((m) => m.coin === "BTC");
  assert.equal(btc.px, 85600);
  assert.equal(btc.midPx, 85600);
  assert.equal(btc.markPx, 85573, "a mid is not a mark; the field must not lie");
  near(btc.change24hPct, ((85600 - 81352) / 81352) * 100);
  assert.equal(btc.at, 5);
  const eth0 = base.find((m) => m.coin === "ETH");
  assert.equal(markets.find((m) => m.coin === "ETH"), eth0, "an unreadable mid changes nothing, the row keeps its identity");
  const again = applyMids(markets, { BTC: "85600.0" }, 6);
  assert.equal(again.changed, false);
  assert.equal(again.markets, markets, "no change, same array");
});

/* ── the store ─────────────────────────────────────────────────────────── */

function fakeClock() {
  let t = 1_000_000;
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
    set(ms) { t = ms; },
  };
}

function fakeWs() {
  const subs = [];
  const statusFns = new Set();
  return {
    subs,
    subscribe(sub, onData) {
      const rec = { sub, onData, live: true };
      subs.push(rec);
      return () => { rec.live = false; };
    },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    emitStatus(s) { for (const fn of [...statusFns]) fn(s); },
    live: (type) => subs.filter((r) => r.live && r.sub.type === type),
    statusListeners: () => statusFns.size,
  };
}

/* MAIN DEX ONLY here (venues: []): this suite pins the store's request budget,
   its interval and its one stream against Hyperliquid's own table, one call per
   refresh. The HIP-3 venues — their extra calls, their asset ids, their own
   allMids stream — are scripts/test-hl-markets-venues.mjs. */
function rig({ hidden = false, answer = () => structuredClone(FIXTURE), venues = [] } = {}) {
  const clock = fakeClock();
  const ws = fakeWs();
  const visFns = new Set();
  let isHid = hidden;
  const calls = [];
  const gates = [];
  let gated = false;
  const info = (body) => {
    calls.push(body);
    if (gated) return new Promise((res, rej) => gates.push({ res: () => res(answer()), rej }));
    try { return Promise.resolve(answer()); } catch (e) { return Promise.reject(e); }
  };
  const store = createPerpMarketsStore({
    info, ws, venues, timers: clock.timers, now: clock.now,
    isHidden: () => isHid,
    onVisibilityChange: (fn) => { visFns.add(fn); return () => visFns.delete(fn); },
  });
  return {
    clock, ws, store, calls, gates,
    gate(on = true) { gated = on; },
    setHidden(h) { isHid = h; for (const fn of [...visFns]) fn(); },
    visListeners: () => visFns.size,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test("the store does nothing until retained; two list surfaces cost one fetch and one allMids stream", async () => {
  const r = rig();
  assert.equal(r.calls.length, 0);
  const s0 = r.store.getSnapshot();
  assert.equal(s0.ready, false);
  assert.deepEqual(s0.markets, []);
  assert.equal(s0.error, null);
  const rel1 = r.store.retainList();
  const rel2 = r.store.retainList();
  await flush();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { type: "metaAndAssetCtxs" });
  assert.equal(r.ws.live("allMids").length, 1);
  const s1 = r.store.getSnapshot();
  assert.equal(s1.ready, true);
  assert.equal(s1.markets.length, 5);
  assert.equal(s1.updatedAt, r.clock.now());
  assert.equal(r.store.getSnapshot(), s1, "an unchanged store hands back the SAME snapshot (useSyncExternalStore needs that)");
  rel1();
  assert.equal(r.ws.live("allMids").length, 1, "one surface still open");
  rel2();
  assert.equal(r.ws.live("allMids").length, 0);
});

test("listeners hear every change; the allMids stream patches the list", async () => {
  const r = rig();
  let n = 0;
  const off = r.store.subscribe(() => n++);
  r.store.retainList();
  await flush();
  const before = n;
  r.ws.live("allMids")[0].onData({ mids: { BTC: "90000.0" } });
  assert.ok(n > before);
  assert.equal(r.store.getSnapshot().byCoin.BTC.px, 90000);
  assert.equal(r.store.getSnapshot().markets.find((m) => m.coin === "BTC").px, 90000, "list and byCoin agree");
  off();
});

test("the list refreshes on a modest interval, and only while the tab is visible", async () => {
  assert.ok(PERP_MARKETS_REFRESH_MS >= 30_000, "no tight polling");
  const r = rig();
  r.store.retainList();
  await flush();
  assert.equal(r.calls.length, 1);
  r.clock.advance(PERP_MARKETS_REFRESH_MS);
  await flush();
  assert.equal(r.calls.length, 2);
  r.setHidden(true);
  r.clock.advance(PERP_MARKETS_REFRESH_MS * 5);
  await flush();
  assert.equal(r.calls.length, 2, "hidden: nobody is looking, nothing is fetched");
  r.setHidden(false);
  await flush();
  assert.equal(r.calls.length, 3, "back to visible with a refresh due: fetch at once");
  r.setHidden(true);
  r.setHidden(false);
  await flush();
  assert.equal(r.calls.length, 3, "a quick flip with fresh data costs nothing");
});

test("mounted in a hidden tab: ONE table fetch for the first paint, then nothing ticks until visible", async () => {
  /* Same rule as useTokenFeed: the mount fetch happens regardless, only the
     repeat is gated. (The in-app browser pane always runs hidden, so a page
     that fetched nothing there would look broken while being correct.) */
  const r = rig({ hidden: true });
  r.store.retainList();
  await flush();
  assert.equal(r.calls.length, 1);
  assert.equal(r.store.getSnapshot().ready, true);
  assert.equal(r.clock.pending(), 0, "no refresh timer while hidden");
  r.clock.advance(PERP_MARKETS_REFRESH_MS * 3);
  await flush();
  assert.equal(r.calls.length, 1);
  r.setHidden(false);
  await flush();
  assert.equal(r.calls.length, 2, "visible with a refresh due: fetch at once");
  const c = rig({ hidden: true });
  c.store.retainCoin("ETH");
  await flush();
  assert.equal(c.calls.length, 1, "a single market mounted hidden also gets its table");
});

test("releasing the last list surface leaves no timer, no stream, no listener — and keeps the data", async () => {
  const r = rig();
  const rel = r.store.retainList();
  await flush();
  rel();
  assert.equal(r.clock.pending(), 0);
  assert.equal(r.ws.live("allMids").length, 0);
  assert.equal(r.visListeners(), 0);
  assert.equal(r.ws.statusListeners(), 0);
  assert.equal(r.store.getSnapshot().markets.length, 5, "coming back paints the last list at once");
  r.clock.advance(PERP_MARKETS_REFRESH_MS * 3);
  await flush();
  assert.equal(r.calls.length, 1);
});

test("one market: activeAssetCtx streams that coin into the SAME store, no polling", async () => {
  const r = rig();
  const rel = r.store.retainCoin("ETH");
  await flush();
  assert.equal(r.calls.length, 1, "the market table is fetched once for szDecimals and leverage");
  const subs = r.ws.live("activeAssetCtx");
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0].sub, { type: "activeAssetCtx", coin: "ETH" });
  assert.equal(r.ws.live("allMids").length, 0, "one coin does not need every mid");
  const btc0 = r.store.getSnapshot().byCoin.BTC;
  subs[0].onData({ coin: "ETH", ctx: { ...FIXTURE[1][1], markPx: "2800.0", midPx: "2799.5", openInterest: "10.0" } });
  const s = r.store.getSnapshot();
  assert.equal(s.byCoin.ETH.markPx, 2800);
  assert.equal(s.byCoin.ETH.px, 2799.5);
  assert.equal(s.byCoin.ETH.openInterestUsd, 28000);
  assert.equal(s.byCoin.BTC, btc0, "other coins untouched");
  subs[0].onData({ coin: "BTC", ctx: { markPx: "1" } });
  assert.equal(r.store.getSnapshot().byCoin.BTC, btc0, "a push for another coin is ignored");
  r.clock.advance(PERP_MARKETS_REFRESH_MS * 3);
  await flush();
  assert.equal(r.calls.length, 1, "no poll for a single market: the stream is its refresh");
  rel();
  assert.equal(r.ws.live("activeAssetCtx").length, 0);
  assert.equal(r.clock.pending(), 0);
});

test("stale: after the stream drops, figures are flagged until something fresh lands", async () => {
  const r = rig();
  r.store.retainList();
  r.store.retainCoin("ETH");
  await flush();
  r.ws.emitStatus("open");
  let s = r.store.getSnapshot();
  assert.equal(s.stale, false);
  r.ws.emitStatus("reconnecting");
  s = r.store.getSnapshot();
  assert.equal(s.stale, true);
  assert.equal(isPerpMarketStale(s, "ETH"), true);
  assert.equal(isPerpMarketStale(s, "BTC"), true);
  r.clock.advance(10);
  r.ws.live("activeAssetCtx")[0].onData({ coin: "ETH", ctx: FIXTURE[1][1] });
  s = r.store.getSnapshot();
  assert.equal(isPerpMarketStale(s, "ETH"), false, "ETH has a fresh push");
  assert.equal(isPerpMarketStale(s, "BTC"), true, "BTC has not");
  r.clock.advance(10);
  r.ws.live("allMids")[0].onData({ mids: { BTC: "1.0" } });
  s = r.store.getSnapshot();
  assert.equal(s.stale, false);
  assert.equal(isPerpMarketStale(s, "BTC"), false);
});

test("a failed first load is an error with no rows, and the next success clears it", async () => {
  let fail = true;
  const r = rig({ answer: () => { if (fail) throw new Error("HL down"); return structuredClone(FIXTURE); } });
  r.store.retainList();
  await flush();
  let s = r.store.getSnapshot();
  assert.equal(s.ready, false);
  assert.match(s.error, /HL down/);
  assert.deepEqual(s.markets, []);
  fail = false;
  r.clock.advance(PERP_MARKETS_REFRESH_MS);
  await flush();
  s = r.store.getSnapshot();
  assert.equal(s.ready, true);
  assert.equal(s.error, null);
});

test("a failed refresh keeps the rows it had (and says so)", async () => {
  let fail = false;
  const r = rig({ answer: () => { if (fail) throw new Error("blip"); return structuredClone(FIXTURE); } });
  r.store.retainList();
  await flush();
  fail = true;
  r.clock.advance(PERP_MARKETS_REFRESH_MS);
  await flush();
  const s = r.store.getSnapshot();
  assert.equal(s.markets.length, 5);
  assert.match(s.error, /blip/);
});

test("a refresh that was sent before the latest stream push cannot roll the price back", async () => {
  const r = rig();
  r.store.retainList();
  await flush();
  r.gate(true);
  r.clock.advance(PERP_MARKETS_REFRESH_MS);           // refresh sent at this instant
  r.clock.advance(5);
  r.ws.live("allMids")[0].onData({ mids: { BTC: "99999.0" } });
  r.gate(false);
  r.gates.shift().res();                               // answers with the older mid 85572.5
  await flush();
  assert.equal(r.store.getSnapshot().byCoin.BTC.px, 99999);
  assert.equal(r.store.getSnapshot().byCoin.BTC.markPx, 85573, "the mark comes from the refresh");
});

test("mids that land before the first table are applied when it arrives", async () => {
  const r = rig();
  r.gate(true);
  r.store.retainList();
  r.clock.advance(5);
  r.ws.live("allMids")[0].onData({ mids: { ETH: "3000.0" } });
  r.gate(false);
  r.gates.shift().res();
  await flush();
  assert.equal(r.store.getSnapshot().byCoin.ETH.px, 3000);
});

test("importing the modules opened no socket and sent no request", () => {
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
});

test("the hooks render on the server without touching the network, and say not-ready", () => {
  let list;
  let one;
  function Probe() {
    list = usePerpMarkets();
    one = usePerpMarket("BTC");
    return React.createElement("i", null, list.ready ? "ready" : "wait");
  }
  const html = renderToString(React.createElement(Probe));
  assert.match(html, /wait/);
  assert.equal(list.ready, false);
  assert.deepEqual(list.markets, []);
  assert.equal(one.market, null);
  assert.equal(one.ready, false);
  assert.equal(one.stale, false);
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
});
