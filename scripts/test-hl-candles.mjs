/**
 * test-hl-candles — Hyperliquid candleSnapshot and the live candle stream,
 * in the shape the chart already draws.
 *
 *   node --test scripts/test-hl-candles.mjs
 *
 * Live facts this pins (read-only calls, 2026-09-22): candleSnapshot answers
 * [{t, T, s, i, o, c, h, l, v, n}] with t/T in MILLISECONDS and o/h/l/c/v as
 * STRINGS, ascending; the WebSocket candle push has the same shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HL_INTERVALS, HL_INTERVAL_MS, FLOWFLOW_TF_TO_HL, hlInterval,
  parseHlCandle, parseHlCandles, mergeHlCandle,
  fetchHlCandles, peekHlCandles, subscribeHlCandles,
} from "../src/lib/hyperliquid/candles.js";

const RAW = { t: 1790047140000, T: 1790047199999, s: "BTC", i: "1m", o: "85579.0", c: "85520.0", h: "85589.0", l: "85520.0", v: "2.81784", n: 106 };

test("one live candle becomes {time (s), open, high, low, close, volume} numbers", () => {
  assert.deepEqual(parseHlCandle(RAW), { time: 1790047140, open: 85579, high: 85589, low: 85520, close: 85520, volume: 2.81784 });
});

test("a candle with an unreadable price is dropped, never zero-filled", () => {
  assert.equal(parseHlCandle({ ...RAW, c: "" }), null);
  assert.equal(parseHlCandle({ ...RAW, o: null }), null);
  assert.equal(parseHlCandle({ ...RAW, h: "x" }), null);
  assert.equal(parseHlCandle({ ...RAW, t: undefined }), null);
  assert.equal(parseHlCandle(null), null);
  // Volume unknown is null; a measured zero volume stays zero.
  assert.equal(parseHlCandle({ ...RAW, v: undefined }).volume, null);
  assert.equal(parseHlCandle({ ...RAW, v: "0.0" }).volume, 0);
});

test("a snapshot is sorted ascending and deduplicated by time (the later row wins)", () => {
  const a = { ...RAW, t: 1790047080000, c: "1" };
  const b = { ...RAW, t: 1790047140000, c: "2" };
  const b2 = { ...RAW, t: 1790047140000, c: "3" };
  const out = parseHlCandles([b, { ...RAW, c: "" }, a, b2]);
  assert.deepEqual(out.map((c) => [c.time, c.close]), [[1790047080, 1], [1790047140, 3]]);
  assert.deepEqual(parseHlCandles(null), []);
  assert.deepEqual(parseHlCandles({ error: "x" }), []);
});

test("The chart timeframes map to Hyperliquid intervals", () => {
  // ChartPanel's TF ids are seconds: 60, 300, 900, 3600, 14400, 86400.
  assert.deepEqual(FLOWFLOW_TF_TO_HL, { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" });
  assert.equal(hlInterval(60), "1m");
  assert.equal(hlInterval(14400), "4h");
  assert.equal(hlInterval("1H"), "1h");
  assert.equal(hlInterval("1D"), "1d");
  assert.equal(hlInterval("1W"), "1w");
  assert.equal(hlInterval("1M"), "1M");     // a month, not a minute
  assert.equal(hlInterval("1m"), "1m");
  assert.equal(hlInterval("15m"), "15m");
  assert.equal(hlInterval(7), null);
  assert.equal(hlInterval("2y"), null);
  assert.equal(hlInterval(null), null);
  for (const i of HL_INTERVALS) assert.ok(HL_INTERVAL_MS[i] > 0, i);
  assert.equal(HL_INTERVAL_MS["1h"], 3_600_000);
});

test("mergeHlCandle replaces the forming candle, appends a new one, ignores an older one", () => {
  const list = parseHlCandles([{ ...RAW, t: 1790047080000 }, RAW]);
  const same = mergeHlCandle(list, { ...parseHlCandle(RAW), close: 1 });
  assert.equal(same.length, 2);
  assert.equal(same[1].close, 1);
  assert.notEqual(same, list, "a new array, so React sees the change");
  const next = mergeHlCandle(list, { ...parseHlCandle(RAW), time: 1790047200 });
  assert.equal(next.length, 3);
  const old = mergeHlCandle(list, { ...parseHlCandle(RAW), time: 1790047020 });
  assert.equal(old, list, "an older candle changes nothing");
  assert.deepEqual(mergeHlCandle(null, parseHlCandle(RAW)).length, 1);
  assert.equal(mergeHlCandle(list, null), list);
});

test("fetchHlCandles asks candleSnapshot for the window, once, and hands back chart candles", async () => {
  const calls = [];
  const info = async (body) => { calls.push(body); return [{ ...RAW, t: 1790047080000 }, RAW]; };
  const end = 1790047200000;
  const out = await fetchHlCandles("BTC", 60, { bars: 10, endTime: end, info });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: end - 10 * 60_000, endTime: end } });
  assert.equal(out.length, 2);
  assert.equal(out[1].time, 1790047140);
  // A second caller inside the TTL shares the answer instead of asking again.
  const again = await fetchHlCandles("BTC", 60, { bars: 10, endTime: end, info });
  assert.equal(calls.length, 1);
  assert.deepEqual(again, out);
  assert.deepEqual(peekHlCandles("BTC", 60, { bars: 10 }), out);
  assert.equal(peekHlCandles("ETH", 60, { bars: 10 }), null);
});

test("fetchHlCandles: an unknown timeframe or coin is refused without a request", async () => {
  let n = 0;
  const info = async () => { n++; return []; };
  await assert.rejects(fetchHlCandles("BTC", 7, { info }), /interval/);
  await assert.rejects(fetchHlCandles("", 60, { info }), /coin/);
  assert.equal(n, 0);
});

test("fetchHlCandles: a failure is not cached as an empty chart", async () => {
  let n = 0;
  const bad = async () => { n++; throw new Error("boom"); };
  await assert.rejects(fetchHlCandles("SOL", 300, { bars: 5, endTime: 1, info: bad }), /boom/);
  const good = async () => { n++; return [RAW]; };
  const out = await fetchHlCandles("SOL", 300, { bars: 5, endTime: 1, info: good });
  assert.equal(n, 2);
  assert.equal(out.length, 1);
});

test("subscribeHlCandles streams the same shape and unsubscribes cleanly", () => {
  const subs = [];
  const ws = {
    subscribe(sub, onData) {
      const rec = { sub, onData, live: true };
      subs.push(rec);
      return () => { rec.live = false; };
    },
  };
  const got = [];
  const off = subscribeHlCandles("BTC", 60, (c) => got.push(c), { ws });
  assert.deepEqual(subs[0].sub, { type: "candle", coin: "BTC", interval: "1m" });
  subs[0].onData(RAW);
  subs[0].onData({ ...RAW, s: "ETH" });   // not ours: ignored
  subs[0].onData({ ...RAW, c: "" });      // unreadable: ignored
  assert.deepEqual(got, [parseHlCandle(RAW)]);
  off();
  assert.equal(subs[0].live, false);
  assert.throws(() => subscribeHlCandles("BTC", 7, () => {}, { ws }), /interval/);
});

test("fetchHlCandles: a caller that aborts does not fail the request the next caller joined (one request, both answered)", async () => {
  const bodies = [];
  let release;
  const info = (body, opts) => {
    bodies.push({ body, opts });
    return new Promise((r) => { release = () => r([RAW]); });
  };
  const first = new AbortController();
  const a = fetchHlCandles("DOGE", 60, { bars: 7, endTime: 1, info, signal: first.signal });
  // ChartPanel's load(): abort the previous load, then ask again at once.
  first.abort();
  const second = new AbortController();
  const b = fetchHlCandles("DOGE", 60, { bars: 7, endTime: 1, info, signal: second.signal });
  await assert.rejects(a, (e) => e.kind === "aborted", "the caller that gave up is told so");
  release();
  const out = await b;
  assert.equal(out.length, 1, "the caller that stayed gets the answer");
  assert.equal(bodies.length, 1, "one request for both");
  assert.equal(bodies[0].opts, undefined, "no caller's signal rides on the shared request");
  assert.deepEqual(peekHlCandles("DOGE", 60, { bars: 7 }), out, "and the answer is kept");
});

test("fetchHlCandles: an already-aborted signal asks nothing", async () => {
  let n = 0;
  const info = async () => { n++; return [RAW]; };
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(fetchHlCandles("AVAX", 60, { bars: 3, info, signal: ac.signal }), (e) => e.kind === "aborted");
  assert.equal(n, 0);
});

test("fetchHlCandles: fresh skips a settled answer inside the TTL but still joins one in the air", async () => {
  let n = 0;
  let release = null;
  const info = () => { n++; return new Promise((r) => { release = () => r([{ ...RAW, c: String(85000 + n) }]); }); };
  const tick = () => new Promise((r) => setImmediate(r));   // reqCache starts the fetch on a microtask
  const p1 = fetchHlCandles("LINK", 60, { bars: 4, endTime: 1, info });
  await tick();
  release();
  const one = await p1;
  assert.equal(n, 1);
  const cached = await fetchHlCandles("LINK", 60, { bars: 4, endTime: 1, info });
  assert.equal(n, 1, "without fresh, the TTL answer is reused");
  assert.equal(cached, one);
  const f1 = fetchHlCandles("LINK", 60, { bars: 4, endTime: 1, info, fresh: true });
  const f2 = fetchHlCandles("LINK", 60, { bars: 4, endTime: 1, info, fresh: true });
  await tick();
  assert.equal(n, 2, "fresh asks again, and a second fresh caller joins that request");
  release();
  const [a, b] = await Promise.all([f1, f2]);
  assert.equal(a, b);
  assert.equal(a[0].close, 85002, "the new answer, not the cached one");
  assert.deepEqual(peekHlCandles("LINK", 60, { bars: 4 }), a);
});
