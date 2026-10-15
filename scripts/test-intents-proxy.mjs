/**
 * test-intents-proxy — api/intents-quote.js and api/intents-status.js: the server side of Private mode.
 * ════════════════════════════════════════════════════════════════════════════
 * What a page cannot be trusted to do for itself, pinned here:
 *
 *   K. the kill switch: PRIVATE_MODE must be exactly "on", or every call is 503 { error: "private_mode_off" };
 *   P. the probe: what is offered, the privacy level (confidential ONLY with the partner key), caps env can only lower;
 *   B. the body allow-list: no appFees / message / virtual-chain / referral field; six pairs; a deposit pays the
 *      wallet it refunds; the privacy level is the server's (409 otherwise);
 *   L. the caps: 10 / 5 USDC minimum, 500 per move, 1,000 per wallet per UTC day (address-reserving quotes);
 *   O. the sanctions screen on every address, FAILING CLOSED (live oracle answers are the fixture);
 *   F. forwarding: the key in x-api-key, never echoed, the answer verbatim, an echo naming another payee refused,
 *      one record line per address-reserving quote;
 *   S. the status proxy, and the page's probe reader.
 *
 * No network: the 1Click API and the RPCs are fake fetches; global fetch throws.
 * Run: node --test scripts/test-intents-proxy.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, `scripts/fixtures/intents/${name}`), "utf8"));

const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error("live network is forbidden in test-intents-proxy"); }; });
after(() => { globalThis.fetch = realFetch; });

let Q; let ST; let G; let C; let CL; let A; let RQ;
before(async () => {
  Q = await import("../api/intents-quote.js");
  ST = await import("../api/intents-status.js");
  G = await import("../src/lib/intents/guard.js");
  C = await import("../src/lib/intents/config.js");
  CL = await import("../src/lib/intents/client.js");
  A = await import("../src/lib/intents/assets.js");
  RQ = await import("../api/relay-quote.js");
});

const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TYPED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEP = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const NOW = Date.parse("2026-10-15T07:01:10.000Z");
const CAPTURE_USER = /0xa1581fb128e573fef727dd9fc2630d0d695a1956/gi;
const UP_QUOTE = "https://1click.chaindefuser.com/v0/quote";
const UP_STATUS = "https://1click.chaindefuser.com/v0/status";
const ORACLE = fixture("sanctions-oracle-live.json");
const LISTED = ORACLE.answers[0].address;
const ON = { PRIVATE_MODE: "on" };
const KEYED = { PRIVATE_MODE: "on", NEAR_INTENTS_JWT: "jwt-secret-123" };

/** A deposit body exactly as the page builds it (scripts/test-intents-deposit.mjs C4 holds the two equal). */
const depositBody = (over = {}) => ({
  dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
  originAsset: A.ARBITRUM_INTENTS_USDC.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: A.HYPERCORE_USDC.assetId,
  amount: "25000000", refundTo: USER, refundType: "ORIGIN_CHAIN", recipient: USER, recipientType: "DESTINATION_CHAIN",
  deadline: new Date(NOW + 3600000).toISOString(), confidentiality: "public", ...over,
});
/** A withdrawal body: perps → Arbitrum, to the address the customer typed, refunded to their own account. */
const withdrawBody = (over = {}) => depositBody({
  originAsset: A.HYPERCORE_USDC.assetId, destinationAsset: A.ARBITRUM_INTENTS_USDC.assetId,
  amount: "2500000000", recipient: TYPED, refundTo: USER, ...over,
});

/* The live dry answer, echoing whatever the body asked (the service echoes the request). */
function answerFor(body, mutate = null) {
  const j = JSON.parse(JSON.stringify(fixture("dry-arb-to-hc-25.json").answer).replace(CAPTURE_USER, USER));
  j.quoteRequest = { ...j.quoteRequest, ...body };
  if (!body.dry) j.quote = { ...j.quote, depositAddress: DEP, deadline: new Date(NOW + 72 * 3600000).toISOString(), timeWhenInactive: new Date(NOW + 72 * 3600000).toISOString() };
  if (mutate) mutate(j);
  return j;
}

/* One fake for the API and the RPCs. `oracle(address, rpc)` answers the eth_call (true / false / "fail"). */
function fakeNet({ upstream = (body) => ({ status: 201, body: answerFor(body) }), oracle = () => false } = {}) {
  const calls = { upstream: [], rpc: [] };
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u === UP_QUOTE || u.startsWith(UP_STATUS)) {
      calls.upstream.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
      const r = upstream(init.body ? JSON.parse(init.body) : null, u, init);
      if (r instanceof Error) throw r;
      return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)), json: async () => r.body };
    }
    const rpcBody = JSON.parse(init.body);
    calls.rpc.push({ url: u, body: rpcBody });
    const data = rpcBody.params[0].data;
    const addr = `0x${data.slice(-40)}`;
    const v = oracle(addr, u);
    if (v === "fail") return { ok: false, status: 502, json: async () => ({ error: { message: "bad gateway" } }) };
    if (v === "garbage") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: `0x${(v ? 1 : 0).toString(16).padStart(64, "0")}` }) };
  };
  fn.calls = calls;
  return fn;
}

const run = (body, opts = {}) => {
  const net = opts.net || fakeNet();
  const logs = [];
  const p = Q.intentsQuoteOnce({
    body, env: opts.env || ON, fetchImpl: net, rpcFetch: net, ledger: opts.ledger || G.createDayLedger(),
    now: () => (opts.now ?? NOW), screenMemo: opts.memo || G.newSanctionsMemo(), log: (l) => logs.push(l),
  });
  return p.then((r) => ({ ...r, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), net, logs }));
};

/* ════════════════════════════════════════════════════════════════════════════
   K. KILL SWITCH
   ════════════════════════════════════════════════════════════════════════════ */

test("K1) 🔴 anything but PRIVATE_MODE=on is off: every quote, probe and status read answers 503 private_mode_off, and nothing leaves", async () => {
  for (const env of [{}, { PRIVATE_MODE: "off" }, { PRIVATE_MODE: "preview" }, { PRIVATE_MODE: "ON" }, { PRIVATE_MODE: "true" }, { PRIVATE_MODE: "1" }, { ...KEYED, PRIVATE_MODE: "" }]) {
    const r = await run(depositBody(), { env });
    assert.equal(r.status, 503, JSON.stringify(env));
    assert.equal(r.json.error, "private_mode_off");
    assert.equal(r.net.calls.upstream.length + r.net.calls.rpc.length, 0, "nothing leaves");
    const p = Q.probeOnce({ env });
    assert.equal(p.status, 503);
    assert.equal(JSON.parse(p.body).enabled, false);
    const net = fakeNet();
    const s = await ST.intentsStatusOnce({ depositAddress: DEP, env, fetchImpl: net });
    assert.equal(s.status, 503);
    assert.equal(JSON.parse(s.body).error, "private_mode_off");
    assert.equal(net.calls.upstream.length, 0);
  }
  assert.equal(G.privateModeOf({ PRIVATE_MODE: " on " }), "on", "surrounding spaces from a dashboard paste are trimmed");
});

test("K2) the HTTP handlers obey it before anything else, and refuse other methods and other sites", async () => {
  const saved = { ...process.env };
  const call = async (handler, { method = "POST", origin = undefined, url = "/", body = null } = {}) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: origin ? { origin } : {}, socket: { remoteAddress: "10.0.0.1" } });
    const out = { headers: {} };
    const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: (t) => { out.body = t; } };
    await handler(req, res);
    out.status = res.statusCode;
    return out;
  };
  try {
    delete process.env.PRIVATE_MODE;
    assert.equal((await call(Q.default, { method: "GET", url: "/?probe=1" })).status, 503);
    assert.equal((await call(Q.default, { body: depositBody() })).status, 503);
    assert.equal((await call(ST.default, { method: "GET", url: `/?depositAddress=${DEP}` })).status, 503);
    process.env.PRIVATE_MODE = "on";
    const probe = await call(Q.default, { method: "GET", url: "/?probe=1" });
    assert.equal(probe.status, 200);
    assert.equal(probe.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(probe.body).enabled, true);
    assert.equal((await call(Q.default, { method: "PUT" })).status, 405);
    assert.equal((await call(Q.default, { origin: "https://evil.example", body: depositBody() })).status, 403);
    assert.equal((await call(ST.default, { method: "POST" })).status, 405);
    assert.equal((await call(ST.default, { method: "GET", origin: "https://evil.example", url: `/?depositAddress=${DEP}` })).status, 403);
    assert.equal((await call(ST.default, { method: "GET", url: "/?depositAddress=nope" })).status, 400);
    assert.equal((await call(Q.default, { body: null })).status, 400, "an empty body");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   P. THE PROBE
   ════════════════════════════════════════════════════════════════════════════ */

test("P1) the probe: public (a PREVIEW, not private) without the key; confidential only with it; the key never in it", () => {
  const pub = JSON.parse(Q.probeOnce({ env: ON }).body);
  assert.deepEqual(pub, { enabled: true, confidential: false, confidentiality: "public", preview: true, limits: { depositMinUsdc: 10, withdrawMinUsdc: 5, maxTxUsdc: 500, maxDayUsdc: 1000 } });
  const keyed = Q.probeOnce({ env: KEYED });
  assert.doesNotMatch(keyed.body, /jwt-secret-123/);
  assert.equal(JSON.parse(keyed.body).confidentiality, "basic");
  assert.equal(JSON.parse(keyed.body).confidential, true);
  assert.equal(JSON.parse(keyed.body).preview, false);
  assert.equal(JSON.parse(Q.probeOnce({ env: { ...KEYED, NEAR_INTENTS_CONFIDENTIALITY: "advanced" } }).body).confidentiality, "advanced");
  assert.equal(JSON.parse(Q.probeOnce({ env: { ...KEYED, NEAR_INTENTS_CONFIDENTIALITY: "public" } }).body).confidentiality, "basic", "with a key, the level is a confidential one");
  assert.equal(JSON.parse(Q.probeOnce({ env: { ...ON, NEAR_INTENTS_CONFIDENTIALITY: "advanced" } }).body).confidentiality, "public", "no key: no confidential level, whatever env asks");
});

test("P2) env may LOWER the caps, never raise them", () => {
  assert.equal(G.limitsFrom({ INTENTS_MAX_TX_USDC: "100", INTENTS_MAX_DAY_USDC: "300" }).maxTxUsdc, 100);
  assert.equal(G.limitsFrom({ INTENTS_MAX_TX_USDC: "100", INTENTS_MAX_DAY_USDC: "300" }).maxDayUsdc, 300);
  assert.equal(G.limitsFrom({ INTENTS_MAX_TX_USDC: "5000" }).maxTxUsdc, 500);
  assert.equal(G.limitsFrom({ INTENTS_MAX_DAY_USDC: "abc" }).maxDayUsdc, 1000);
  assert.equal(G.limitsFrom({ INTENTS_MAX_TX_USDC: "-1" }).maxTxUsdc, 500);
});

/* ════════════════════════════════════════════════════════════════════════════
   B. THE BODY
   ════════════════════════════════════════════════════════════════════════════ */

test("B1) 🔴 fields we never send are refused by name, and nothing leaves: appFees, a message, a virtual-chain recipient, referral, rebates…", async () => {
  const extra = {
    appFees: [{ recipient: "flowflow.near", fee: 50 }], customRecipientMsg: "x.near", virtualChainRecipient: TYPED,
    virtualChainRefundRecipient: TYPED, referral: "flowflow", rebates: [{ recipient: "x.near", share: 100 }],
    connectedWallets: [USER], sessionId: "s", insured: true, __proto_hack: 1,
  };
  for (const [k, v] of Object.entries(extra)) {
    const r = await run(depositBody({ [k]: v }));
    assert.equal(r.status, 400, k);
    assert.equal(r.json.error, "field_not_allowed", k);
    assert.equal(r.json.field, k);
    assert.equal(r.net.calls.upstream.length + r.net.calls.rpc.length, 0, `${k}: nothing leaves`);
  }
});

test("B2) the only shapes we use: one swap type, origin-chain deposit and refund, destination-chain payout, six pairs", async () => {
  const bad = [
    ["swapType", { swapType: "FLEX_INPUT" }], ["swapType", { swapType: "ANY_INPUT" }],
    ["depositType", { depositType: "CONFIDENTIAL_INTENTS" }], ["refundType", { refundType: "INTENTS" }],
    ["recipientType", { recipientType: "INTENTS" }], ["depositMode", { depositMode: "MEMO" }],
    ["slippageTolerance", { slippageTolerance: 500 }], ["slippageTolerance", { slippageTolerance: 1.5 }],
    ["dry", { dry: "false" }], ["amount", { amount: "25.5" }], ["amount", { amount: "0" }], ["amount", { amount: 25000000 }],
    ["recipient", { recipient: "0x123", refundTo: "0x123" }], ["refundTo", { refundTo: "alice.near" }],
    ["deadline", { deadline: new Date(NOW - 1000).toISOString() }], ["deadline", { deadline: new Date(NOW + 3 * 86400000).toISOString() }],
    ["deadline", { deadline: "tomorrow" }], ["quoteWaitingTimeMs", { quoteWaitingTimeMs: 60000 }],
    ["confidentiality", { confidentiality: "secret" }],
  ];
  for (const [field, over] of bad) {
    const r = await run(depositBody(over));
    assert.equal(r.status, 400, `${field} ${JSON.stringify(over)}`);
    assert.ok(["bad_field", "field_missing"].includes(r.json.error), `${field}: ${r.json.error}`);
  }
  for (const missing of G.REQUIRED_QUOTE_FIELDS) {
    const b = depositBody();
    delete b[missing];
    const r = await run(b);
    assert.equal(r.status, 400, missing);
    assert.equal(r.json.field, missing);
  }
  for (const [o, d] of [[A.HYPERCORE_USDC.assetId, A.HYPERCORE_USDC.assetId], [A.BASE_INTENTS_USDC.assetId, A.BASE_INTENTS_USDC.assetId], ["nep141:wrap.near", A.HYPERCORE_USDC.assetId], [A.ARBITRUM_INTENTS_USDC.assetId, "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f"]]) {
    const r = await run(depositBody({ originAsset: o, destinationAsset: d }));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "pair_not_allowed");
  }
  assert.equal((await run(depositBody({ quoteWaitingTimeMs: 0, depositMode: "SIMPLE" }))).status, 201, "the two optional fields, when sane");
});

test("B2b) 🔴 THE FOUR CHAINS (owner: \"เอา ARB, Avax, Base, Polygon พอแระ\"): exactly their USDC in and out, and nothing else", async () => {
  const H = A.HYPERCORE_USDC.assetId;
  const FOUR = [A.ARBITRUM_INTENTS_USDC, A.AVALANCHE_INTENTS_USDC, A.BASE_INTENTS_USDC, A.POLYGON_INTENTS_USDC];
  for (const a of FOUR) {
    for (const dry of [true, false]) {
      const toPerps = await run(depositBody({ dry, originAsset: a.assetId, destinationAsset: H }));
      assert.equal(toPerps.status, 201, `${a.place} → perps dry=${dry}: ${toPerps.body}`);
      const toArb = await run(depositBody({ dry, originAsset: a.assetId, destinationAsset: A.ARBITRUM_INTENTS_USDC.assetId }));
      assert.equal(toArb.status, 201, `${a.place} → own Arbitrum wallet dry=${dry}`);
    }
    const out = await run(withdrawBody({ dry: true, destinationAsset: a.assetId }));
    assert.equal(out.status, 201, `perps → ${a.place}`);
  }
  /* Ethereum, BNB, OP USDC; Solana USDC; BTC; ETH on Arbitrum; Polygon's bridged USDC.e; the decoy HyperCore USDC. */
  const OTHERS = [
    "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
    "nep141:op-0x0b2c639c533813f4aa9d7837caf62653d097ff85.omft.near",
    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    "nep141:btc.omft.near",
    "nep141:arb.omft.near",
    "nep245:v2_1.omni.hot.tg:137_2791bca1f2de4661ed88a30c99a7a9449aa84174",
    "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f",
  ];
  for (const o of OTHERS) {
    for (const body of [depositBody({ dry: true, originAsset: o }), depositBody({ dry: true, originAsset: o, destinationAsset: A.ARBITRUM_INTENTS_USDC.assetId }), withdrawBody({ dry: true, destinationAsset: o })]) {
      const net = fakeNet();
      const r = await run(body, { net });
      assert.equal(r.status, 400, o);
      assert.equal(r.json.error, "pair_not_allowed", o);
      assert.equal(net.calls.upstream.length + net.calls.rpc.length, 0, "refused before the screen and the service");
    }
  }
  /* Between two of the four chains is not a private deposit either (only into perps or the own Arbitrum wallet). */
  for (const [o, d] of [[A.BASE_INTENTS_USDC, A.AVALANCHE_INTENTS_USDC], [A.AVALANCHE_INTENTS_USDC, A.POLYGON_INTENTS_USDC], [A.POLYGON_INTENTS_USDC, A.POLYGON_INTENTS_USDC]]) {
    const r = await run(depositBody({ dry: true, originAsset: o.assetId, destinationAsset: d.assetId }));
    assert.equal(r.json.error, "pair_not_allowed", `${o.place} → ${d.place}`);
  }
});

test("B3) 🔴 a DEPOSIT pays the wallet it refunds; a WITHDRAWAL pays the address typed and refunds the customer's own", async () => {
  const r = await run(depositBody({ recipient: TYPED }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "deposit_recipient");
  assert.equal(r.net.calls.upstream.length, 0);
  const w = await run(withdrawBody());
  assert.equal(w.status, 201);
  assert.equal(w.net.calls.upstream[0].body.recipient, TYPED);
  assert.equal(w.net.calls.upstream[0].body.refundTo, USER);
  /* Case is not identity: the same wallet in two casings is the same wallet. */
  assert.equal((await run(depositBody({ recipient: USER.toLowerCase() }))).status, 201);
});

test("B4) 🔴 the privacy level is the server's: a body asking another one is refused (409) and told which; a match goes through unchanged", async () => {
  const a = await run(depositBody({ confidentiality: "basic" }), { env: ON });
  assert.equal(a.status, 409);
  assert.equal(a.json.error, "confidentiality_mismatch");
  assert.equal(a.json.confidentiality, "public");
  const b = await run(depositBody({ confidentiality: "public" }), { env: KEYED });
  assert.equal(b.status, 409);
  assert.equal(b.json.confidentiality, "basic");
  const c = await run(depositBody({ confidentiality: "basic" }), { env: KEYED });
  assert.equal(c.status, 201);
  assert.equal(c.net.calls.upstream[0].body.confidentiality, "basic");
});

/* ════════════════════════════════════════════════════════════════════════════
   L. CAPS
   ════════════════════════════════════════════════════════════════════════════ */

test("L1) minimums by direction (10 to deposit, 5 to withdraw) and 500 per move, on dry and address quotes alike", async () => {
  const codeOf = async (b) => { const r = await run(b); return r.status === 201 ? "ok" : r.json.error; };
  assert.equal(await codeOf(depositBody({ amount: "9999999" })), "below_min");
  assert.equal(await codeOf(depositBody({ amount: "10000000" })), "ok");
  assert.equal(await codeOf(depositBody({ amount: "500000000" })), "ok");
  assert.equal(await codeOf(depositBody({ amount: "500000001" })), "over_tx_cap");
  assert.equal(await codeOf(depositBody({ amount: "500000001", dry: true })), "over_tx_cap");
  assert.equal(await codeOf(withdrawBody({ amount: "499999999" })), "below_min", "4.99999999 USDC at 8 decimals");
  assert.equal(await codeOf(withdrawBody({ amount: "500000000" })), "ok", "5 USDC at 8 decimals");
  assert.equal(await codeOf(withdrawBody({ amount: "50000000001" })), "over_tx_cap");
  const r = await run(depositBody({ amount: "9999999" }));
  assert.equal(r.status, 422);
  assert.equal(r.net.calls.upstream.length + r.net.calls.rpc.length, 0);
});

test("L2) 1,000 a day per wallet: address quotes count (deposits and withdrawals together), dry ones do not; another wallet and the next UTC day start fresh", async () => {
  const ledger = G.createDayLedger();
  const go = (b, o = {}) => run(b, { ledger, ...o });
  for (let i = 0; i < 3; i++) assert.equal((await go(depositBody({ amount: "500000000", dry: true }))).status, 201, "a price is not a reservation");
  assert.equal(ledger.spent(USER, NOW), 0);
  assert.equal((await go(depositBody({ amount: "500000000" }))).status, 201);
  assert.equal((await go(withdrawBody({ amount: "40000000000" }))).status, 201, "400 out, same wallet");
  assert.equal(ledger.spent(USER, NOW), 900);
  const over = await go(depositBody({ amount: "100000001" }));
  assert.equal(over.status, 422);
  assert.equal(over.json.error, "over_day_cap");
  assert.equal(over.json.left, 100);
  assert.equal(over.net.calls.upstream.length, 0);
  assert.equal((await go(depositBody({ amount: "100000000" }))).status, 201, "exactly to the cap");
  assert.equal((await go(depositBody({ amount: "10000000", dry: true }))).json.error, "over_day_cap", "a price past the cap is refused too");
  assert.equal((await go(depositBody({ amount: "10000000", recipient: TYPED, refundTo: TYPED }))).status, 201, "another wallet");
  assert.equal((await go(depositBody({ amount: "10000000", deadline: new Date(NOW + 86400000 + 3600000).toISOString() }), { now: NOW + 86400000 })).status, 201, "the next UTC day");
  /* A refused or failed upstream answer reserves nothing and costs nothing. */
  const l2 = G.createDayLedger();
  await run(depositBody({ amount: "500000000" }), { ledger: l2, net: fakeNet({ upstream: () => ({ status: 400, body: { message: "Quoting for this pair is not available" } }) }) });
  assert.equal(l2.spent(USER, NOW), 0);
  const lowered = await run(depositBody({ amount: "300000000" }), { env: { ...ON, INTENTS_MAX_DAY_USDC: "200" } });
  assert.equal(lowered.json.error, "over_day_cap");
});

/* ════════════════════════════════════════════════════════════════════════════
   O. SANCTIONS
   ════════════════════════════════════════════════════════════════════════════ */

test("O1) the live oracle's answers: the SDN-listed address is refused (451, plan §4's words, no workaround); the clean one passes", async () => {
  const listed = ORACLE.answers.find((a) => BigInt(a.result) === 1n).address;
  const clean = ORACLE.answers.find((a) => BigInt(a.result) === 0n).address;
  const oracle = (addr) => (addr.toLowerCase() === listed.toLowerCase() ? true : false);
  const w = await run(withdrawBody({ recipient: listed }), { net: fakeNet({ oracle }) });
  assert.equal(w.status, 451);
  assert.equal(w.json.error, "sanctioned");
  assert.equal(w.json.message, G.SANCTIONED_MESSAGE);
  assert.doesNotMatch(w.json.message, /VPN|another address|try a different/i);
  assert.equal(w.net.calls.upstream.length, 0, "nothing is quoted");
  const d = await run(depositBody({ recipient: listed, refundTo: listed }), { net: fakeNet({ oracle }) });
  assert.equal(d.status, 451);
  const ok = await run(depositBody({ recipient: clean, refundTo: clean }), { net: fakeNet({ oracle }) });
  assert.equal(ok.status, 201);
  /* The read is the oracle's own call: isSanctioned(address) on 0x40C5…C8fb. */
  const call = ok.net.calls.rpc[0].body;
  assert.equal(call.method, "eth_call");
  assert.equal(call.params[0].to, ORACLE.oracle);
  assert.equal(call.params[0].data, G.sanctionsCalldata(clean));
  assert.equal(G.sanctionsCalldata(clean).slice(0, 10), "0xdf592f7d");
  assert.equal(ok.net.calls.rpc[0].url, "https://arb1.arbitrum.io/rpc");
});

test("O2) 🔴 FAIL CLOSED: an oracle no RPC can read refuses the quote (503 screen_unavailable); every chain is asked and ANY yes wins", async () => {
  for (const v of ["fail", "garbage"]) {
    const r = await run(depositBody(), { net: fakeNet({ oracle: () => v }) });
    assert.equal(r.status, 503, v);
    assert.equal(r.json.error, "screen_unavailable");
    assert.equal(r.net.calls.upstream.length, 0);
    assert.equal(r.net.calls.rpc.length, G.SANCTIONS_RPCS.length, "every RPC was tried");
  }
  const thrown = await run(depositBody(), { net: (() => { const n = fakeNet(); const f = async (u, i) => { if (String(u) !== UP_QUOTE) throw new Error("dns"); return n(u, i); }; f.calls = n.calls; return f; })() });
  assert.equal(thrown.status, 503);
  const second = await run(depositBody(), { net: fakeNet({ oracle: (a, rpc) => (rpc === G.SANCTIONS_RPCS[0] ? "fail" : false) }) });
  assert.equal(second.status, 201, "one chain down, the other's definite no clears");
  assert.deepEqual(second.net.calls.rpc.map((c) => c.url), G.SANCTIONS_RPCS);
  /* The two lists are updated separately: one chain ahead of the other still refuses. */
  for (const ahead of G.SANCTIONS_RPCS) {
    const r = await run(depositBody(), { net: fakeNet({ oracle: (a, rpc) => rpc === ahead }) });
    assert.equal(r.status, 451, `a yes on ${ahead} alone`);
    assert.equal(r.net.calls.upstream.length, 0);
  }
  /* "0x" (no contract at that address, as on Base) is not a no. */
  const empty = await run(depositBody(), { net: fakeNet({ oracle: () => "garbage" }) });
  assert.equal(empty.status, 503);
});

test("O3) the owner's own list (env) refuses without asking the chain; a screened address is not re-read for ten minutes", async () => {
  const net = fakeNet();
  const r = await run(withdrawBody({ recipient: TYPED }), { env: { ...ON, INTENTS_SANCTIONS_EXTRA: `0xdead, ${TYPED.toLowerCase()}` }, net });
  assert.equal(r.status, 451);
  const memo = G.newSanctionsMemo();
  const n1 = fakeNet();
  await run(depositBody(), { memo, net: n1 });
  assert.equal(n1.calls.rpc.length, G.SANCTIONS_RPCS.length, "every chain, once");
  const n2 = fakeNet();
  await run(depositBody({ dry: true }), { memo, net: n2 });
  assert.equal(n2.calls.rpc.length, 0, "remembered");
  const n3 = fakeNet();
  await run(depositBody({ dry: true }), { memo, net: n3, now: NOW + 11 * 60000 });
  assert.equal(n3.calls.rpc.length, G.SANCTIONS_RPCS.length, "read again after ten minutes");
  assert.deepEqual(G.sanctionsRpcsFrom({ INTENTS_SANCTIONS_RPC: "https://rpc.example/a, http://insecure, nonsense" }), ["https://rpc.example/a"]);
  assert.deepEqual(G.sanctionsRpcsFrom({}), [...G.SANCTIONS_RPCS]);
});

/* ════════════════════════════════════════════════════════════════════════════
   F. FORWARDING
   ════════════════════════════════════════════════════════════════════════════ */

test("F1) the key rides in x-api-key with a browser User-Agent; the body forwarded is exactly the checked copy; no key, no header", async () => {
  const k = await run(depositBody(), { env: { ...KEYED }, net: fakeNet() }).catch((e) => e);
  assert.equal(k.status, 409, "with a key the level is basic, so a public body is refused first");
  const r = await run(depositBody({ confidentiality: "basic" }), { env: KEYED });
  const up = r.net.calls.upstream[0];
  assert.equal(up.url, UP_QUOTE);
  assert.equal(up.init.method, "POST");
  assert.equal(up.init.headers["x-api-key"], "jwt-secret-123");
  assert.match(up.init.headers["user-agent"], /^Mozilla\/5\.0/);
  assert.deepEqual(up.body, depositBody({ confidentiality: "basic" }));
  const n = await run(depositBody(), { env: ON });
  assert.equal(n.net.calls.upstream[0].init.headers["x-api-key"], undefined);
});

test("F2) the answer comes back verbatim, status included, and the key is never in it", async () => {
  const net = fakeNet({ upstream: (b) => ({ status: 201, body: JSON.stringify(answerFor(b, (j) => { j.note = "echo jwt-secret-123"; })) }) });
  const r = await run(depositBody({ confidentiality: "basic" }), { env: KEYED, net });
  assert.equal(r.status, 201);
  assert.doesNotMatch(r.body, /jwt-secret-123/);
  assert.equal(r.json.quote.depositAddress, DEP);
  const e401 = fixture("refused-confidential-401.json");
  const x = await run(depositBody({ confidentiality: "basic" }), { env: KEYED, net: fakeNet({ upstream: () => ({ status: 401, body: { ...e401.answer, leaked: "jwt-secret-123" } }) }) });
  assert.equal(x.status, 401);
  assert.doesNotMatch(x.body, /jwt-secret-123/);
  const down = await run(depositBody(), { net: fakeNet({ upstream: () => new Error("down") }) });
  assert.equal(down.status, 504);
});

test("F3) 🔴 an answer whose echo pays or refunds anybody else is refused here too (502), and reserves nothing", async () => {
  for (const m of [(j) => { j.quoteRequest.recipient = TYPED; }, (j) => { j.quoteRequest.refundTo = TYPED; }, (j) => { delete j.quoteRequest; }]) {
    const ledger = G.createDayLedger();
    const r = await run(depositBody(), { ledger, net: fakeNet({ upstream: (b) => ({ status: 201, body: answerFor(b, m) }) }) });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, "upstream_mismatch");
    assert.doesNotMatch(r.body, new RegExp(DEP, "i"), "the address never reaches the page");
    assert.equal(ledger.spent(USER, NOW), 0);
    assert.equal(r.logs.length, 0);
  }
});

test("F4) one record line per address-reserving quote (plan §7.6), none for a price", async () => {
  const r = await run(depositBody());
  assert.equal(r.logs.length, 1);
  const line = JSON.parse(r.logs[0]);
  assert.equal(line.evt, "intents.quote");
  assert.equal(line.direction, "deposit");
  assert.equal(line.depositAddress, DEP);
  assert.equal(line.wallet, USER.toLowerCase());
  assert.equal(line.correlationId, fixture("dry-arb-to-hc-25.json").answer.correlationId);
  assert.equal(line.confidentiality, "public");
  assert.equal(line.at, new Date(NOW).toISOString());
  assert.doesNotMatch(r.logs[0], /jwt/i);
  assert.equal((await run(depositBody({ dry: true }))).logs.length, 0);
});

test("F5) our pages only (the same list as the Relay proxy), and a per-IP limit", () => {
  for (const o of [undefined, "https://flowflow-alpha.vercel.app", "https://flowflow-abc123-flow-flow.vercel.app", "http://localhost:5173", "https://evil.example", "https://flowflow-alpha.vercel.app.evil.example", "http://localhost.evil.example"]) {
    assert.equal(G.originAllowed(o), RQ.originAllowed(o), String(o));
  }
  const lim = G.createRateLimiter(60);
  let tripped = false;
  for (let i = 0; i < 61; i++) tripped = lim("9.9.9.9", NOW + i);
  assert.equal(tripped, true);
  assert.equal(lim("8.8.8.8", NOW), false, "another IP");
  assert.equal(lim("9.9.9.9", NOW + 61_000), false, "a minute later");
});

/* ════════════════════════════════════════════════════════════════════════════
   S. STATUS PROXY, AND THE PAGE'S PROBE READER
   ════════════════════════════════════════════════════════════════════════════ */

test("S1) the status proxy: one GET upstream with the key if any, the answer verbatim (a 404 too), the key scrubbed", async () => {
  const net = fakeNet({ upstream: () => ({ status: 200, body: { status: "PENDING_DEPOSIT", note: "jwt-secret-123" } }) });
  const r = await ST.intentsStatusOnce({ depositAddress: DEP, env: KEYED, fetchImpl: net });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /jwt-secret-123/);
  assert.equal(net.calls.upstream[0].url, `${UP_STATUS}?depositAddress=${DEP}`);
  assert.equal(net.calls.upstream[0].init.headers["x-api-key"], "jwt-secret-123");
  const nf = fixture("status-404-madeup.json");
  const n = await ST.intentsStatusOnce({ depositAddress: nf.address, env: ON, fetchImpl: fakeNet({ upstream: () => ({ status: 404, body: nf.answer }) }) });
  assert.equal(n.status, 404);
  assert.equal(JSON.parse(n.body).message, nf.answer.message);
  assert.equal((await ST.intentsStatusOnce({ depositAddress: "0x12", env: ON, fetchImpl: net })).status, 400);
  assert.equal((await ST.intentsStatusOnce({ depositAddress: DEP, env: ON, fetchImpl: fakeNet({ upstream: () => new Error("down") }) })).status, 504);
});

test("S2) the page's probe reader: only a clear 'on' shows the toggle; a server can lower the page's caps, never raise them", async () => {
  const res = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  assert.equal((await CL.readPrivateModeProbe({ fetchImpl: res(503, { error: "private_mode_off" }) })).enabled, false);
  assert.equal((await CL.readPrivateModeProbe({ fetchImpl: async () => { throw new Error("offline"); } })).enabled, false);
  assert.equal((await CL.readPrivateModeProbe({ fetchImpl: res(200, "nonsense") })).enabled, false);
  assert.equal((await CL.readPrivateModeProbe({ fetchImpl: res(200, { enabled: true, confidentiality: "mystery" }) })).enabled, false);
  const pub = await CL.readPrivateModeProbe({ fetchImpl: res(200, JSON.parse(Q.probeOnce({ env: ON }).body)) });
  assert.deepEqual({ ...pub, limits: { ...pub.limits } }, { enabled: true, confidential: false, confidentiality: "public", limits: { ...C.PRIVATE_LIMITS } });
  const keyed = await CL.readPrivateModeProbe({ fetchImpl: res(200, JSON.parse(Q.probeOnce({ env: KEYED }).body)) });
  assert.equal(keyed.confidential, true);
  assert.equal(keyed.confidentiality, "basic");
  const raised = await CL.readPrivateModeProbe({ fetchImpl: res(200, { enabled: true, confidential: false, confidentiality: "public", limits: { maxTxUsdc: 10000, maxDayUsdc: 50, depositMinUsdc: 1 } }) });
  assert.equal(raised.limits.maxTxUsdc, 500);
  assert.equal(raised.limits.maxDayUsdc, 50);
  assert.equal(raised.limits.depositMinUsdc, 10);
  /* "confidential: true" with a public level is not believed. */
  assert.equal((await CL.readPrivateModeProbe({ fetchImpl: res(200, { enabled: true, confidential: true, confidentiality: "public" }) })).confidential, false);
});

test("S3) the page asks the proxies, Node asks the API directly; the key's name is the server's only", () => {
  assert.equal(C.INTENTS_QUOTE_URL, UP_QUOTE, "no window in Node");
  assert.equal(C.INTENTS_STATUS_URL, UP_STATUS);
  assert.equal(C.INTENTS_QUOTE_PROXY, "/api/intents-quote");
  assert.equal(C.INTENTS_STATUS_PROXY, "/api/intents-status");
  assert.equal(C.INTENTS_PROBE_URL, "/api/intents-quote?probe=1");
  assert.equal(G.intentsKeyOf({ NEAR_INTENTS_JWT: "  k  " }), "k");
  assert.equal(G.intentsKeyOf({ VITE_NEAR_INTENTS_JWT: "k" }), "", "a VITE_ copy is never read");
});
