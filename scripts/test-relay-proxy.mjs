/**
 * test-relay-proxy — api/relay-quote.js: Relay needs an API key on every quote (from 2026-10-02) and the key must never
 * reach the browser. The proxy adds it, passes the answer back verbatim, never echoes the key, and only serves our pages.
 * M1b (plan v2 §2.7): the BODY is allow-listed — exactly the keys our own builders send, on our routes' chains — and
 * anything else (subsidizeFees, maxSubsidizationAmount, appFees, referrer, txs, an unknown key) is a 400 before Relay
 * is asked. Every body builder in src/lib/relay is run through it (M1).
 * No network: Relay is a fake fetch.
 * Run: node --test scripts/test-relay-proxy.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { relayQuoteOnce, originAllowed, rateLimited, relayQuoteBodyProblem, RELAY_QUOTE_CHAINS, RELAY_QUOTE_KEYS } from "../api/relay-quote.js";
import { RELAY_QUOTE_URL, RELAY_API, PERP_DEPOSIT_ROUTES } from "../src/lib/relay/routes.js";
import { buildDepositQuoteBody, checkedBody, DIRECT_PLAN } from "../src/lib/relay/depositAddress.js";
import { buildFirstDepositQuoteBody } from "../src/lib/relay/firstDeposit.js";
import { buildWithdrawQuoteBody, PERP_WITHDRAW_ROUTES } from "../src/lib/relay/withdraw.js";
import { buildOwnMoveQuoteBody } from "../src/lib/relay/ownMove.js";
import { buildMoveInQuoteBody } from "../src/lib/relay/moveIn.js";
import { buildGasTopupQuoteBody } from "../src/lib/relay/gasTopup.js";
import { buildMoveOutQuoteBody, buildPaidExitQuoteBody } from "../src/lib/relay/moveOut.js";
import { buildSwapQuoteBody, buildGasLegQuoteBody } from "../src/lib/relay/swap.js";

const USER = "0x14791697260E4c9A71f18484C9f997B308e59325";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/* A body exactly like a real move-in (lib/relay/ownMove.js). */
const MOVE_IN_BODY = () => ({
  user: USER, recipient: USER, refundTo: USER, originChainId: 1337, originCurrency: "0x00000000000000000000000000000000",
  destinationChainId: 43114, destinationCurrency: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", amount: "2000000", tradeType: "EXACT_OUTPUT",
});

const fake = (status, body) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }; };
  fn.calls = calls;
  return fn;
};

test("X1) the key goes in x-api-key on the way to Relay's /quote/v2; the body is passed unchanged", async () => {
  const f = fake(200, { steps: [] });
  const body = MOVE_IN_BODY();
  const r = await relayQuoteOnce({ body, env: { RELAY_API_KEY: "k-123" }, fetchImpl: f });
  assert.equal(r.status, 200);
  assert.equal(f.calls[0].url, "https://api.relay.link/quote/v2");
  assert.equal(f.calls[0].init.headers["x-api-key"], "k-123");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), body);
});

test("X2) Relay's answer comes back verbatim, status included, and the key is never in it", async () => {
  const r = await relayQuoteOnce({ body: MOVE_IN_BODY(), env: { RELAY_API_KEY: "secret-key" }, fetchImpl: fake(400, { message: "bad key secret-key" }) });
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.body, /secret-key/);
});

test("X3) no key configured: still asks (without the header) rather than failing the deposit screen", async () => {
  const f = fake(200, {});
  await relayQuoteOnce({ body: MOVE_IN_BODY(), env: {}, fetchImpl: f });
  assert.equal(f.calls[0].init.headers["x-api-key"], undefined);
});

test("X4) refused: not an object, a network failure is a plain 504", async () => {
  assert.equal((await relayQuoteOnce({ body: null, env: {}, fetchImpl: fake(200, {}) })).status, 400);
  assert.equal((await relayQuoteOnce({ body: [1], env: {}, fetchImpl: fake(200, {}) })).status, 400);
  const boom = async () => { throw new Error("down"); };
  assert.equal((await relayQuoteOnce({ body: MOVE_IN_BODY(), env: {}, fetchImpl: boom })).status, 504);
});

test("X5) only our own pages may use it; a per-IP limit trips after 60 a minute", () => {
  for (const ok of [undefined, "https://flowflow-alpha.vercel.app", "https://flowflow-abc123-flow-flow.vercel.app", "http://localhost:5173"]) assert.equal(originAllowed(ok), true, ok);
  for (const bad of ["https://evil.example", "https://flowflow-alpha.vercel.app.evil.example", "http://localhost.evil.example"]) assert.equal(originAllowed(bad), false, bad);
  const t = 1_700_000_000_000;
  let tripped = false;
  for (let i = 0; i < 61; i++) tripped = rateLimited("9.9.9.9", t + i);
  assert.equal(tripped, true);
});

test("X6) Node (tests, scripts) asks Relay directly; a page asks the proxy", () => {
  assert.equal(RELAY_QUOTE_URL, `${RELAY_API}/quote/v2`);
});

/* ── M1b: the body allow-list ─────────────────────────────────────────────── */

/* Every body FlowFlow's own builders send today, built by the builders themselves. */
function everyBuilderBody() {
  const out = [];
  for (const route of PERP_DEPOSIT_ROUTES) {
    out.push([`deposit ${route.id}`, buildDepositQuoteBody({ user: USER, route })]);
    out.push([`deposit size ${route.id}`, { ...checkedBody(USER, USER, route, DIRECT_PLAN), amount: "100000000" }]);
    out.push([`first deposit ${route.id}`, buildFirstDepositQuoteBody({ user: USER, route })]);
  }
  for (const route of PERP_WITHDRAW_ROUTES) {
    out.push([`withdraw ${route.id}`, buildWithdrawQuoteBody({ user: USER, recipient: OTHER, route, amountUsdc: "5" })]);
    out.push([`withdraw exact-output ${route.id}`, buildWithdrawQuoteBody({ user: USER, recipient: USER, route, amountRaw: "5000", tradeType: "EXACT_OUTPUT" })]);
  }
  out.push(["move-in", buildMoveInQuoteBody({ own: USER, amountUsdc: "2" }).body]);
  out.push(["move-in + gas", buildMoveInQuoteBody({ own: USER, amountUsdc: "2", topupUsd: 0.3, expectedAvaxWei: 30000000000000000n }).body]);
  out.push(["own move to AVAX", buildOwnMoveQuoteBody({ own: USER, dest: "avax", amountRaw: 30000000000000000n })]);
  out.push(["gas top-up", buildGasTopupQuoteBody({ own: USER, avaxWei: 30000000000000000n })]);
  out.push(["move-out", buildMoveOutQuoteBody({ own: USER, amountUsdc: "2" })]);
  out.push(["paid exit", buildPaidExitQuoteBody({ own: USER, amountUsdc: "2" })]);
  out.push(["swap USDC → BTC.b", buildSwapQuoteBody({ own: USER, from: "USDC", to: "BTC.b", amountRaw: "2000000" })]);
  out.push(["swap BTC.b → USDC", buildSwapQuoteBody({ own: USER, from: "BTC.b", to: "USDC", amountRaw: "2400" })]);
  out.push(["swap USDC → USDT", buildSwapQuoteBody({ own: USER, from: "USDC", to: "USDT", amountRaw: "2000000" })]);
  out.push(["gas leg", buildGasLegQuoteBody({ own: USER, topupUsd: 0.3 })]);
  return out;
}

test("M1) every body our own builders send passes the allow-list unchanged (deposit, first deposit, sizes, withdraw both ways, move-in, gas, move-out, paid exit, swaps)", async () => {
  const bodies = everyBuilderBody();
  assert.ok(bodies.length >= 40);
  for (const [name, body] of bodies) {
    assert.equal(relayQuoteBodyProblem(body), null, `${name}: ${JSON.stringify(relayQuoteBodyProblem(body))}`);
    const f = fake(200, {});
    const r = await relayQuoteOnce({ body, env: { RELAY_API_KEY: "k" }, fetchImpl: f });
    assert.equal(r.status, 200, name);
    assert.deepEqual(JSON.parse(f.calls[0].init.body), JSON.parse(JSON.stringify(body)), `${name} goes to Relay exactly as built`);
  }
  /* The keys the allow-list holds are exactly the union of what the builders send. */
  const sent = new Set(bodies.flatMap(([, b]) => Object.keys(b)));
  assert.deepEqual([...sent].sort(), Object.keys(RELAY_QUOTE_KEYS).sort());
});

test("M2) 🔴 the fields that would spend the KEY's money or carry someone else's call are refused before Relay is asked", async () => {
  const smuggled = {
    subsidizeFees: true, maxSubsidizationAmount: "1000000", appFees: [{ recipient: OTHER, fee: "100" }], referrer: "someone",
    txs: [{ to: OTHER, data: "0x", value: "0" }], useExternalLiquidity: true, source: "x", __proto__x: 1,
  };
  for (const [k, v] of Object.entries(smuggled)) {
    const f = fake(200, {});
    const r = await relayQuoteOnce({ body: { ...MOVE_IN_BODY(), [k]: v }, env: { RELAY_API_KEY: "k" }, fetchImpl: f });
    assert.equal(r.status, 400, k);
    assert.deepEqual(JSON.parse(r.body), { error: "key_not_allowed", key: k });
    assert.equal(f.calls.length, 0, `${k}: Relay was never asked`);
  }
});

test("M3) every allowed key must have the shape our builders give it; the core nine are required; chains are our routes' plus HyperCore and Avalanche", async () => {
  assert.deepEqual(RELAY_QUOTE_CHAINS, [1, 10, 56, 137, 1337, 8453, 42161, 43114]);
  for (const r of [...PERP_DEPOSIT_ROUTES, ...PERP_WITHDRAW_ROUTES]) assert.ok(RELAY_QUOTE_CHAINS.includes(r.chainId), r.id);
  const bad = [
    { originChainId: 999 }, { destinationChainId: "43114" }, { amount: 2000000 }, { amount: "-1" }, { amount: "1e6" },
    { user: "0x1234" }, { recipient: null }, { originCurrency: "USDC" }, { tradeType: "EXPECTED_OUTPUT" },
    { topupGas: "true" }, { topupGasAmount: 300000 }, { usePermit: 1 }, { slippageTolerance: 100 },
    { includedSwapSources: "0x" }, { includedSwapSources: [] }, { includedSwapSources: [{ a: 1 }] },
  ];
  for (const over of bad) {
    const f = fake(200, {});
    const r = await relayQuoteOnce({ body: { ...MOVE_IN_BODY(), ...over }, env: {}, fetchImpl: f });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(JSON.parse(r.body).error, "bad_value", JSON.stringify(over));
    assert.equal(f.calls.length, 0);
  }
  for (const k of ["user", "recipient", "refundTo", "originChainId", "originCurrency", "destinationChainId", "destinationCurrency", "amount", "tradeType"]) {
    const b = MOVE_IN_BODY();
    delete b[k];
    assert.deepEqual(relayQuoteBodyProblem(b), { error: "missing_key", key: k });
  }
  assert.deepEqual(relayQuoteBodyProblem({ a: 1 }), { error: "key_not_allowed", key: "a" });
});
