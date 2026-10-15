/**
 * test-hl-info — the tiny POST /info client.
 *
 *   node --test scripts/test-hl-info.mjs
 *
 * The browser calls https://api.hyperliquid.xyz/info directly (CORS is open;
 * rate limits are per IP, so a proxy would pool every user under one budget).
 * What this pins: one JSON POST, a hard timeout, an error that says what went
 * wrong, NO retries, and identical in-flight asks sharing one request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HL_NETWORK, HL_ENDPOINTS, hlEndpoints } from "../src/lib/hyperliquid/config.js";
import { createHlInfo, HlInfoError, HL_INFO_TIMEOUT_MS } from "../src/lib/hyperliquid/info.js";

const okJson = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });

test("endpoints: mainnet by default, testnet one constant away", () => {
  assert.equal(HL_NETWORK, "mainnet");
  assert.equal(HL_ENDPOINTS.mainnet.info, "https://api.hyperliquid.xyz/info");
  assert.equal(HL_ENDPOINTS.mainnet.ws, "wss://api.hyperliquid.xyz/ws");
  assert.equal(HL_ENDPOINTS.testnet.info, "https://api.hyperliquid-testnet.xyz/info");
  assert.equal(HL_ENDPOINTS.testnet.ws, "wss://api.hyperliquid-testnet.xyz/ws");
  assert.equal(hlEndpoints().info, HL_ENDPOINTS.mainnet.info);
  assert.equal(hlEndpoints("testnet").ws, HL_ENDPOINTS.testnet.ws);
  assert.throws(() => hlEndpoints("devnet"), /network/);
  assert.ok(HL_INFO_TIMEOUT_MS >= 3000 && HL_INFO_TIMEOUT_MS <= 15000);
});

test("one JSON POST to /info, body as given, answer parsed", async () => {
  const calls = [];
  const info = createHlInfo({
    url: "https://x.test/info",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return okJson([{ universe: [] }, []]); },
  });
  const out = await info({ type: "metaAndAssetCtxs" });
  assert.deepEqual(out, [{ universe: [] }, []]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://x.test/info");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { type: "metaAndAssetCtxs" });
  assert.ok(calls[0].init.signal, "every request carries an abort signal (the timeout)");
});

test("an HTTP error is an HlInfoError with the status, and is NOT retried", async () => {
  let n = 0;
  const info = createHlInfo({
    url: "u",
    fetchImpl: async () => { n++; return { ok: false, status: 429, json: async () => null, text: async () => "rate limited" }; },
  });
  await assert.rejects(info({ type: "allMids" }), (e) => {
    assert.ok(e instanceof HlInfoError);
    assert.equal(e.kind, "http");
    assert.equal(e.status, 429);
    assert.match(e.message, /429/);
    return true;
  });
  assert.equal(n, 1, "no retry storm: one ask, one request");
});

test("an unparseable answer is an HlInfoError of kind parse", async () => {
  const info = createHlInfo({
    url: "u",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); }, text: async () => "<html>" }),
  });
  await assert.rejects(info({ type: "meta" }), (e) => e instanceof HlInfoError && e.kind === "parse");
});

test("a network failure is an HlInfoError of kind network", async () => {
  const info = createHlInfo({ url: "u", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(info({ type: "meta" }), (e) => e instanceof HlInfoError && e.kind === "network");
});

test("a request that never answers times out", async () => {
  let aborted = false;
  const info = createHlInfo({
    url: "u",
    timeoutMs: 25,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
    }),
  });
  await assert.rejects(info({ type: "meta" }), (e) => e instanceof HlInfoError && e.kind === "timeout");
  assert.equal(aborted, true, "the fetch itself is aborted, not merely abandoned");
});

test("identical asks in flight share ONE request; key order does not matter", async () => {
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const info = createHlInfo({ url: "u", fetchImpl: async () => { n++; await gate; return okJson({ ok: 1 }); } });
  const a = info({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: 1, endTime: 2 } });
  const b = info({ req: { endTime: 2, startTime: 1, interval: "1m", coin: "BTC" }, type: "candleSnapshot" });
  const c = info({ type: "candleSnapshot", req: { coin: "ETH", interval: "1m", startTime: 1, endTime: 2 } });
  release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(n, 2, "BTC twice is one request, ETH is another");
  assert.deepEqual(ra, rb);
  assert.deepEqual(rc, { ok: 1 });
  // Settled asks are not cached: the next ask is a new request.
  await info({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: 1, endTime: 2 } });
  assert.equal(n, 3);
});

test("one caller aborting does not cancel the request another caller shares", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let fetchAborted = false;
  const info = createHlInfo({
    url: "u",
    fetchImpl: async (url, init) => {
      init.signal.addEventListener("abort", () => { fetchAborted = true; });
      await gate;
      return okJson({ v: 1 });
    },
  });
  const ac = new AbortController();
  const a = info({ type: "meta" }, { signal: ac.signal });
  const b = info({ type: "meta" });
  ac.abort();
  await assert.rejects(a, (e) => e instanceof HlInfoError && e.kind === "aborted");
  release();
  assert.deepEqual(await b, { v: 1 });
  assert.equal(fetchAborted, false);
});

test("an already-aborted signal never sends a request", async () => {
  let n = 0;
  const info = createHlInfo({ url: "u", fetchImpl: async () => { n++; return okJson(1); } });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(info({ type: "meta" }, { signal: ac.signal }), (e) => e.kind === "aborted");
  assert.equal(n, 0);
});
