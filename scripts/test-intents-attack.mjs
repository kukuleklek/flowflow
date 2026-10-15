/**
 * test-intents-attack — a MONEY-SAFETY ATTACK on Private mode's backend (Normal | Private).
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "Start Now ทำ Backend ก่อน". Each test below is one finding: it FAILS against the code as
 * the builders reported it (2026-10-15) and passes once that finding is fixed. Nothing here edits source.
 *
 *   X1  a wallet step answering "bad_response" (Hyperliquid's own "check before trying again") is recorded
 *       "Nothing was sent" — the next withdrawal may sign a second sendAsset
 *   X2  with the partner key set, the quote proxy serves any caller that sends no Origin (curl): an open relay
 *   X3  the deposit verifier accepts a quote whose guaranteed output (minAmountOut) is 1 base unit
 *   X4  concurrent address-reserving quotes all pass the 1,000 USDC day cap (check-then-await-then-add)
 *   X5  kill switch OFF: a saved one-time deposit address is still shown again (new deposits invited)
 *   X6  the deposit verifier shows a burn address or the USDC token contract as the one-time address
 *   X7  the withdraw verifier accepts a quote that may deliver 14 % less (70 USDC of 500)
 *   X8  OFAC: an SDN address the (unmaintained) oracle no longer flags passes the proxy — no server SDN copy
 *   X9  an INCOMPLETE deposit: the watch stops 30 min after the sheet closes, so its refund is never heard
 *   X10 a status row with no wallet to check against is mapped (credited), not unknown (and the deposit result's
 *       `watch` hand-off carries no user, so a sheet that spreads it into depositWatch.show checks nobody)
 *   X11 executeIntentsWithdraw records the claim in ANOTHER wallet's journal and signs
 *   X12 the deposit verifier accepts amountOut > amountIn (a units mix-up) and prints a fee of 0
 *   X13 the deposit verifier ignores the echoed request deadline (one in the past passes)
 *   X14 the deposit verifier lets referral / sessionId through on the echo (the withdraw verifier refuses them)
 *   X15 the deposit builder takes caller-supplied limits that RAISE the per-move cap or LOWER the minimum
 *   X16 the proxies' upstream fetch follows redirects, carrying x-api-key (the partner key) to wherever it points
 *   T1  (todo, src/agent/funds.js is another workflow's) an INCOMPLETE private deposit is invisible to get_funds
 *   T2  (todo, owner decision plan Q5) Base-origin private deposits are offered though v1 is "Arbitrum only"
 *
 * No network: global fetch throws; every request goes through a fake. No signature, no dry:false quote.
 * Run: node --test scripts/test-intents-attack.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const fixture = (name) => JSON.parse(read(`scripts/fixtures/intents/${name.endsWith(".json") ? name : `${name}.json`}`));
const clone = (x) => JSON.parse(JSON.stringify(x));

const realFetch = globalThis.fetch;
const forbidden = () => { throw new Error("live network is forbidden in test-intents-attack"); };
before(() => { globalThis.fetch = forbidden; });
after(() => { globalThis.fetch = realFetch; });

let C; let A; let CL; let S; let D; let G; let Q; let ST; let W; let J; let DW; let F;
before(async () => {
  C = await import("../src/lib/intents/config.js");
  A = await import("../src/lib/intents/assets.js");
  CL = await import("../src/lib/intents/client.js");
  S = await import("../src/lib/intents/status.js");
  D = await import("../src/lib/intents/deposit.js");
  G = await import("../src/lib/intents/guard.js");
  Q = await import("../api/intents-quote.js");
  ST = await import("../api/intents-status.js");
  W = await import("../src/lib/intents/withdraw.js");
  J = await import("../src/lib/intents/withdrawJournal.js");
  DW = await import("../src/perp/deposit/depositWatch.js");
  F = await import("../src/agent/funds.js");
});

/* Public, well-known development addresses. */
const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEP = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const DEP2 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
/* OFAC SDN-listed (Lazarus Group), in the 0xB10C SDN ETH list the plan names (§7 guardrail 2). */
const SDN = "0x7F367cC41522cE07553e823bf3be79A889DEbe1B";
const BURN = "0x000000000000000000000000000000000000dEaD";
const ARB_USDC_CONTRACT = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const CAPTURE_USER = /0xa1581fb128e573fef727dd9fc2630d0d695a1956/gi;
const NOW = Date.parse("2026-10-15T07:01:10.000Z");
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const iso = (t) => new Date(t).toISOString();

const UP_QUOTE = "https://1click.chaindefuser.com/v0/quote";
const UP_STATUS = "https://1click.chaindefuser.com/v0/status";
const UP_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const TOKENS = fixture("tokens-subset.json").tokens;

const ON = { PRIVATE_MODE: "on" };
const KEYED = { PRIVATE_MODE: "on", NEAR_INTENTS_JWT: "jwt-attack-secret-777" };

/* ── deposit side ─────────────────────────────────────────────────────────── */

const quoteFor = (name, user = USER, mutate = null) => {
  const j = JSON.parse(JSON.stringify(fixture(name).answer).replace(CAPTURE_USER, user));
  if (mutate) mutate(j);
  return j;
};
const nonDryFor = (name, { user = USER, addr = DEP, life = 72 * HOUR, mutate = null } = {}) => quoteFor(name, user, (j) => {
  j.quoteRequest.dry = false;
  j.quote.depositAddress = addr;
  j.quote.deadline = iso(NOW + life);
  j.quote.timeWhenInactive = iso(NOW + life);
  if (mutate) mutate(j);
});
const arbRoute = () => A.privateRouteById("arbitrum-usdc");
const parseDeposit = (json, over = {}) => D.parseIntentsDepositQuote(json, {
  user: USER, route: arbRoute(), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", confidentiality: "public", dry: false, now: NOW, ...over,
});

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/* SYNTHETIC status answers, shaped like GetExecutionStatusResponse around the live quote echo. */
function statusOf(st, { user = USER, addr = DEP, swap = {}, updatedAt = NOW + 60000 } = {}) {
  return {
    correlationId: "synthetic-status",
    quoteResponse: nonDryFor("dry-arb-to-hc-25", { user, addr }),
    status: st,
    updatedAt: iso(updatedAt),
    swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...swap },
  };
}
const rowsOf = (st, o = {}) => S.normalizeIntentsStatus(statusOf(st, o), { user: USER, depositAddress: DEP });

/* ── proxy side ───────────────────────────────────────────────────────────── */

const depositBody = (over = {}) => ({
  dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
  originAsset: A.ARBITRUM_INTENTS_USDC.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: A.HYPERCORE_USDC.assetId,
  amount: "25000000", refundTo: USER, refundType: "ORIGIN_CHAIN", recipient: USER, recipientType: "DESTINATION_CHAIN",
  deadline: iso(NOW + HOUR), confidentiality: "public", ...over,
});
const withdrawBody = (over = {}) => depositBody({
  originAsset: A.HYPERCORE_USDC.assetId, destinationAsset: A.ARBITRUM_INTENTS_USDC.assetId,
  amount: "2500000000", recipient: OTHER, refundTo: USER, ...over,
});
function answerFor(body) {
  const j = quoteFor("dry-arb-to-hc-25");
  j.quoteRequest = { ...j.quoteRequest, ...body };
  if (!body.dry) j.quote = { ...j.quote, depositAddress: DEP, deadline: iso(NOW + 72 * HOUR), timeWhenInactive: iso(NOW + 72 * HOUR) };
  return j;
}
/* The 1Click API and the RPCs, faked. `oracle(address)` answers isSanctioned (true / false). */
function fakeNet({ oracle = () => false } = {}) {
  const calls = { upstream: [], rpc: [] };
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u === UP_QUOTE || u.startsWith(UP_STATUS)) {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.upstream.push({ url: u, init, body });
      const out = body ? answerFor(body) : statusOf("PENDING_DEPOSIT");
      return { status: body ? 201 : 200, ok: true, text: async () => JSON.stringify(out), json: async () => out };
    }
    const rpcBody = JSON.parse(init.body);
    calls.rpc.push({ url: u, body: rpcBody });
    const addr = `0x${rpcBody.params[0].data.slice(-40)}`;
    const v = oracle(addr, u) ? 1 : 0;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: `0x${v.toString(16).padStart(64, "0")}` }) };
  };
  fn.calls = calls;
  return fn;
}
const run = (body, { net = fakeNet(), env = ON, ledger = G.createDayLedger(), now = NOW } = {}) =>
  Q.intentsQuoteOnce({
    body, env, fetchImpl: net, rpcFetch: net, ledger, now: () => now, screenMemo: G.newSanctionsMemo(), log: () => {},
  }).then((r) => ({ ...r, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), net }));

/* ── withdraw side ────────────────────────────────────────────────────────── */

const FIX = JSON.parse(read("scripts/fixtures/intents/withdraw-live-2026-10-15.json"));
const REAL = FIX.real.response;
const REAL_AT = Date.parse(FIX.real.capturedAt);
const wRoute = (id) => W.privateWithdrawRouteById(id);
const realCtx = (over = {}) => ({
  user: REAL.quoteRequest.refundTo, recipient: REAL.quoteRequest.recipient, route: wRoute("arbitrum-usdc"), amountUsdc: "20", dry: false,
  deadline: REAL.quoteRequest.deadline, now: REAL_AT, ...over,
});
function memStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
function fakeInfo() {
  return async (body) => {
    if (body.type === "preTransferCheck") return FIX.hl.ptcFresh.response;
    if (body.type === "userRole") return { role: "missing" };
    if (body.type === "clearinghouseState") return { withdrawable: "100.0" };
    if (body.type === "userNonFundingLedgerUpdates") return [];
    throw new Error(`unexpected ${body.type}`);
  };
}
async function withdrawSetup({ journalUser = null } = {}) {
  const q = W.parseIntentsWithdrawQuote(clone(REAL), realCtx());
  const pf = await W.readWithdrawPreflight({ quote: q, info: fakeInfo(), now: () => q.quotedAt + 1000 });
  const now = () => q.quotedAt + 3000;
  const journal = J.createWithdrawJournal({ user: journalUser || q.user, storage: memStorage(), now });
  return { q, pf, journal, now };
}

/* ════════════════════════════════════════════════════════════════════════════
   HIGH
   ════════════════════════════════════════════════════════════════════════════ */

test("X1) 🔴 a wallet step that answers bad_response ('Hyperliquid answered something unreadable. Check … before trying again') is NOT 'nothing sent': it is unknown and blocks the next withdrawal", async () => {
  const { q, pf, journal, now } = await withdrawSetup();
  assert.equal(pf.ok, true, "setup: a fresh ok preflight");
  let asked = 0;
  /* Exactly what orders.js parseExchangeResponse returns for a 2xx it cannot read — the action may have executed. */
  const send = async () => {
    asked += 1;
    return { ok: false, code: "bad_response", message: "Hyperliquid answered something unreadable. Check your positions before trying again.", hlText: "<html>", needsEnable: false };
  };
  const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, now });
  assert.equal(asked, 1);
  assert.notEqual(r.nothingSent, true, "an unreadable answer after the post must never be told 'Nothing was sent'");
  assert.equal(r.notConfirmed, true, "it is 'not confirmed' — the sendAsset may have gone through");
  assert.equal(journal.get(q.depositAddress).state, "unknown", "the record must block a second withdrawal until reads settle it");
  assert.equal(journal.canStart({ amountRaw: q.amountRaw, now: now() }).ok, false, "a new private withdrawal must wait (else: a second sendAsset)");
});

test("X2) 🔴 with the partner key set, the quote proxy is not an open relay: a POST with no Origin (curl, a script) is refused before the key is used", async () => {
  const saved = { ...process.env };
  const net = fakeNet();
  globalThis.fetch = net;
  try {
    Object.assign(process.env, KEYED);
    const out = { headers: {} };
    const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: (t) => { out.body = t; } };
    const t = Date.now();
    /* A stranger's own wallet, a confidential quote through FlowFlow's partner account. */
    const body = depositBody({ dry: true, confidentiality: "basic", refundTo: DEP2, recipient: DEP2, deadline: iso(t + HOUR) });
    await Q.default({ method: "POST", headers: {}, body, socket: { remoteAddress: "203.0.113.9" } }, res);
    out.status = res.statusCode;
    assert.equal(net.calls.upstream.length, 0, "the partner key was used for an unauthenticated caller");
    assert.equal(out.status, 403);
  } finally {
    globalThis.fetch = forbidden;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("X3) 🔴 the deposit verifier refuses an answer whose GUARANTEED output is ~0 (minAmountOut = 1 base unit) while amountOut looks normal", () => {
  const json = nonDryFor("dry-arb-to-hc-25", { mutate: (j) => { j.quote.minAmountOut = "1"; } });
  assert.throws(() => parseDeposit(json), (e) => e instanceof CL.IntentsError && e.code === "unsafe-quote",
    "minAmountOut must sit within the echoed slippage (100 bps) of amountOut, not anywhere above 0");
  /* The same on a price-only quote (what the sheet shows as "you receive at least"). */
  const dry = quoteFor("dry-arb-to-hc-25", USER, (j) => { j.quote.minAmountOut = "1000"; });
  assert.throws(() => parseDeposit(dry, { dry: true }), (e) => e instanceof CL.IntentsError && e.code === "unsafe-quote");
});

/* ════════════════════════════════════════════════════════════════════════════
   MEDIUM
   ════════════════════════════════════════════════════════════════════════════ */

test("X4) concurrent address-reserving quotes cannot pass the 1,000 USDC day cap together (the ledger is checked before an await and added after it)", async () => {
  const ledger = G.createDayLedger();
  const body = depositBody({ amount: "500000000" }); // 500 USDC, dry:false: reserves an address, counts toward the day
  const outs = await Promise.all([run(body, { ledger }), run(body, { ledger }), run(body, { ledger })]);
  const ok = outs.filter((o) => o.status >= 200 && o.status < 300).length;
  assert.ok(ok <= 2, `${ok} × 500 USDC address quotes passed a 1,000 USDC/day cap for one wallet (ledger now ${ledger.spent(USER, NOW)})`);
});

test("X5) kill switch OFF: a saved one-time deposit address is NOT shown again (it would invite a new deposit the owner switched off)", async () => {
  const storage = fakeStorage();
  const memory = new Map();
  const base = {
    user: USER, connected: USER, route: arbRoute(), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", confidentiality: "public",
    storage, memory, now: () => NOW, network: "mainnet",
    quoteUrl: "/api/intents-quote", statusUrl: "/api/intents-status", statusFallbackUrl: UP_STATUS,
  };
  /* 1. Switch ON: the address is quoted and saved. */
  const on = async (url, init = {}) => {
    const u = String(url);
    if (u === UP_TOKENS) return jsonRes(200, TOKENS);
    if (u === "/api/intents-quote") return jsonRes(201, nonDryFor("dry-arb-to-hc-25", { mutate: (j) => { j.quoteRequest = { ...j.quoteRequest, ...JSON.parse(init.body), dry: false }; } }));
    throw new Error(`unexpected ${u}`);
  };
  const first = await D.getPrivateDepositAddress({ ...base, fetchImpl: on, tokensMemo: CL.newIntentsTokensMemo() });
  assert.equal(first.depositAddress, DEP.toLowerCase());
  /* 2. The owner flips PRIVATE_MODE off: both proxies answer 503; the keyless status still says PENDING_DEPOSIT. */
  const off = async (url) => {
    const u = String(url);
    if (u === UP_TOKENS) return jsonRes(200, TOKENS);
    if (u.startsWith("/api/")) return jsonRes(503, { error: "private_mode_off", enabled: false, message: "Private mode is off." });
    if (u.startsWith(UP_STATUS)) return jsonRes(200, statusOf("PENDING_DEPOSIT"));
    throw new Error(`unexpected ${u}`);
  };
  await assert.rejects(
    D.getPrivateDepositAddress({ ...base, fetchImpl: off, tokensMemo: CL.newIntentsTokensMemo() }),
    (e) => e instanceof CL.IntentsError && e.code === "private-mode-off",
    "with the switch off the sheet got the saved address back (fromCache) — a new deposit is invited",
  );
});

test("X6) the deposit verifier never shows a burn address or the route's own USDC token contract as the one-time address", () => {
  for (const [why, addr] of [["the 0x…dEaD burn address", BURN], ["Arbitrum USDC's own token contract", ARB_USDC_CONTRACT]]) {
    const json = nonDryFor("dry-arb-to-hc-25", { addr });
    assert.throws(() => parseDeposit(json), (e) => e instanceof CL.IntentsError && e.code === "bad-deposit-address", `${why} came back as a usable deposit address`);
  }
});

test("X7) the withdraw verifier refuses a quote that may deliver 14 % less than it takes (70 of 500 USDC): the bound is the route's cost plus the echoed slippage, not a flat 15 %", () => {
  const j = clone(REAL);
  const IN = "50000000000"; // 500 USDC at 8 decimals
  j.quoteRequest.amount = IN;
  j.quote.amountIn = IN;
  j.quote.minAmountIn = IN;
  j.quote.amountOut = "494800000"; // 494.8 USDC: looks like the live ~1 % cost
  j.quote.minAmountOut = "430000000"; // 430 USDC guaranteed: 13.1 % under amountOut with a 1 % slippage echo
  assert.throws(() => W.parseIntentsWithdrawQuote(j, realCtx({ amountUsdc: "500" })), (e) => e && e.code === "unsafe-quote",
    "70 USDC of a 500 USDC withdrawal may vanish and Confirm still works");
});

test("X8) OFAC (plan §7.2): an SDN address the oracle no longer flags is still refused by the proxy (server copy of the SDN list), with no env list set", async () => {
  const stale = fakeNet({ oracle: () => false }); // the oracle "is no longer maintained" (R-compliance §6.3)
  const w = await run(withdrawBody({ dry: true, recipient: SDN }), { net: stale });
  assert.equal(w.net.calls.upstream.length, 0, "a quote paying an SDN-listed address reached the service");
  assert.equal(w.status, 451);
  const d = await run(depositBody({ dry: true, recipient: SDN, refundTo: SDN }), { net: fakeNet({ oracle: () => false }) });
  assert.equal(d.status, 451, "a deposit crediting an SDN-listed wallet was quoted");
});

test("X9) an INCOMPLETE deposit (less arrived; refunded after the deadline, up to 72 h) keeps being followed after the sheet closes, so its refund is heard", () => {
  let t = NOW;
  const stops = [];
  const near = ({ depositAddress, onUpdate }) => { near.calls.push({ depositAddress, onUpdate }); return { stop() { stops.push(depositAddress); }, refresh() { return true; } }; };
  near.calls = [];
  const storage = fakeStorage();
  const watch = DW.createDepositWatch({ storage, now: () => t, track: () => ({ stop() {}, refresh() { return true; } }), trackers: { near } });
  const h = watch.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  near.calls[0].onUpdate({ state: "ok", requests: rowsOf("INCOMPLETE_DEPOSIT", { swap: { depositedAmount: "24000000" } }), checkedAt: t, error: null });
  h.release();
  t += DW.WATCH_AFTER_SHOWN_MS + MINUTE;
  near.calls[0].onUpdate({ state: "ok", requests: rowsOf("INCOMPLETE_DEPOSIT", { swap: { depositedAmount: "24000000" } }), checkedAt: t, error: null });
  assert.deepEqual(stops, [], "the watch stopped looking at 24 USDC that is waiting for its refund");
  const saved = storage.getItem(DW.watchKey(USER));
  assert.ok(saved && JSON.parse(saved).list.some((r) => r.address === DEP.toLowerCase()), "and forgot it across a reload");
  watch.stopAll();
});

test("X10) a status row with no wallet to check against is 'unknown', never credited (result.watch carries no user, so depositWatch.show({ ...result.watch }) checks nobody)", () => {
  /* A quote that pays SOMEONE ELSE, read with no user and no expect. */
  const rows = S.normalizeIntentsStatus(statusOf("SUCCESS", { user: OTHER }), { user: null, depositAddress: DEP });
  assert.equal(rows[0].status, "unknown", "another wallet's SUCCESS became 'credited' because nobody was checked");
  /* The same through the deposit watch: a sheet that shows the address without a user. */
  const near = ({ depositAddress, user, onUpdate }) => { near.calls.push({ depositAddress, user, onUpdate }); return { stop() {}, refresh() { return true; } }; };
  near.calls = [];
  const watch = DW.createDepositWatch({ storage: null, now: () => NOW, trackers: { near } });
  watch.show({ address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  assert.equal(near.calls[0].user, null, "setup: the tracker was started with no wallet");
  const viaWatch = S.normalizeIntentsStatus(statusOf("SUCCESS", { user: OTHER }), { user: near.calls[0].user, depositAddress: DEP });
  assert.notEqual(viaWatch[0].status, "credited");
  watch.stopAll();
});

/* ════════════════════════════════════════════════════════════════════════════
   LOW
   ════════════════════════════════════════════════════════════════════════════ */

test("X11) executeIntentsWithdraw refuses a journal that is not the quote's wallet (else the claim, the unsettled block and the day cap land on the wrong wallet)", async () => {
  const { q, pf, journal, now } = await withdrawSetup({ journalUser: OTHER });
  assert.notEqual(journal.user, q.user);
  let asked = 0;
  const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: async () => { asked += 1; return { ok: true }; }, now });
  assert.equal(asked, 0, "the wallet was asked to sign with another wallet's journal");
  assert.equal(r.nothingSent, true);
});

test("X12) the deposit verifier refuses amountOut above amountIn (a units mix-up), instead of printing 2,468 USDC arriving and a fee of 0", () => {
  const json = nonDryFor("dry-arb-to-hc-25", { mutate: (j) => { j.quote.amountOut = "246847000000"; j.quote.minAmountOut = "244347530000"; } });
  assert.throws(() => parseDeposit(json), (e) => e instanceof CL.IntentsError && e.code === "unsafe-quote");
});

test("X13) the deposit verifier refuses an echoed request deadline that has already passed (the withdraw verifier holds it to the one asked)", () => {
  const json = nonDryFor("dry-arb-to-hc-25", { mutate: (j) => { j.quoteRequest.deadline = iso(NOW - MINUTE); } });
  assert.throws(() => parseDeposit(json), (e) => e instanceof CL.IntentsError && e.code === "unsafe-quote");
});

test("X14) the deposit verifier refuses an echo carrying referral / sessionId / connectedWallets (the withdraw verifier already does)", () => {
  for (const [k, v] of [["referral", "someone-else"], ["sessionId", "sess-1"], ["connectedWallets", [OTHER]]]) {
    const json = nonDryFor("dry-arb-to-hc-25", { mutate: (j) => { j.quoteRequest[k] = v; } });
    assert.throws(() => parseDeposit(json), (e) => e instanceof CL.IntentsError && e.code === "unsafe-quote", k);
  }
});

test("X15) the deposit builder clamps caller limits like the withdraw side: a cap can only be LOWERED and a minimum only RAISED", () => {
  const b = (amountRaw, limits) => () => D.buildIntentsDepositQuoteBody({ user: USER, connected: USER, route: arbRoute(), amountRaw, dry: true, now: NOW, network: "mainnet", limits });
  assert.throws(b("600000000", { ...C.PRIVATE_LIMITS, maxTxUsdc: 9999 }), (e) => e && e.code === "over-tx-cap", "600 USDC passed with a caller-raised cap");
  assert.throws(b("5000000", { ...C.PRIVATE_LIMITS, depositMinUsdc: 1 }), (e) => e && e.code === "below-min", "5 USDC passed with a caller-lowered minimum");
});

test("X16) the proxies never follow an upstream redirect with the partner key on it (redirect: 'error' or 'manual')", async () => {
  const r = await run(depositBody({ dry: true, confidentiality: "basic" }), { env: KEYED });
  const up = r.net.calls.upstream[0];
  assert.equal(up.init.headers["x-api-key"], KEYED.NEAR_INTENTS_JWT);
  assert.ok(["error", "manual"].includes(up.init.redirect), `quote proxy: redirect is ${up.init.redirect} — fetch's default 'follow' re-sends x-api-key to any Location`);
  const net = fakeNet();
  await ST.intentsStatusOnce({ depositAddress: DEP, env: KEYED, fetchImpl: net });
  assert.ok(["error", "manual"].includes(net.calls.upstream[0].init.redirect), "status proxy: same");
});

/* ════════════════════════════════════════════════════════════════════════════
   TODO — findings whose fix lives outside this workflow's files (they run, and report, without failing the suite)
   ════════════════════════════════════════════════════════════════════════════ */

test("T1) an INCOMPLETE private deposit is visible to get_funds (src/agent/funds.js depositsFrom) — today it is neither on its way nor a problem", { todo: "src/agent/funds.js belongs to another workflow (depositsFrom reads only arriving/refunded/failed)" }, () => {
  const requests = rowsOf("INCOMPLETE_DEPOSIT", { swap: { depositedAmount: "24000000" } });
  const state = { entries: [{ address: DEP.toLowerCase(), user: USER.toLowerCase(), routeId: "arbitrum-usdc", planId: "private-core", provider: "near", held: false, watching: true, seq: 1, okSeq: 1, state: "ok", requests, checkedAt: NOW, error: null, acked: [], movingNow: [false] }] };
  const d = F.depositsFrom(state, USER, NOW + MINUTE);
  assert.equal(d.onTheWay.length + d.problems.length, 1, "24 USDC waiting up to 72 h for its refund is not mentioned at all");
});

test("T2) plan Q5 (v1 = Arbitrum USDC only): the proxy forwards no Base-origin private deposit until a Recover surface exists", { todo: "owner decision: assets.js/guard.js offer Base deposits; test-intents-deposit C4 asserts they pass" }, async () => {
  const r = await run(depositBody({ dry: true, originAsset: A.BASE_INTENTS_USDC.assetId }));
  assert.equal(r.status, 400);
});
