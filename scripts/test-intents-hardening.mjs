/**
 * test-intents-hardening — what the fixes for test-intents-attack.mjs (X1–X16) added, pinned beyond the attack cases.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "Start Now ทำ Backend ก่อน" (Normal | Private). Each test pins one NEW behaviour:
 *
 *   H1  the status proxy spends the partner key only for our pages; anybody else is read KEYLESS (never 403)
 *   H2  the quote proxy's keyed fence: our Origin passes, no Origin is 403, the GET probe stays open
 *   H3  the day ledger's reservation: counted at once, released once, on the day it was taken
 *   H4  a refused or failed address quote gives its reservation back (concurrent quotes, one sanctioned)
 *   H5  clampPrivateLimits: a caller may only lower a cap or raise a minimum
 *   H6  the SDN copy: well-formed, read before any chain on both sides, and the published list parses
 *   H7  an INCOMPLETE deposit survives a reload past the 24 h news window, and stops after its refund time
 *   H8  the withdraw step: only the listed codes are "nothing sent"; a lost flag always wins
 *
 * No network: global fetch throws unless a test installs a fake. Nothing is signed, nothing is sent.
 * Run: node --test scripts/test-intents-hardening.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const fixture = (name) => JSON.parse(read(`scripts/fixtures/intents/${name}`));
const clone = (x) => JSON.parse(JSON.stringify(x));

const realFetch = globalThis.fetch;
const forbidden = () => { throw new Error("live network is forbidden in test-intents-hardening"); };
before(() => { globalThis.fetch = forbidden; });
after(() => { globalThis.fetch = realFetch; });

let C; let A; let S; let G; let Q; let ST; let W; let J; let DW; let SDN;
before(async () => {
  C = await import("../src/lib/intents/config.js");
  A = await import("../src/lib/intents/assets.js");
  S = await import("../src/lib/intents/status.js");
  G = await import("../src/lib/intents/guard.js");
  Q = await import("../api/intents-quote.js");
  ST = await import("../api/intents-status.js");
  W = await import("../src/lib/intents/withdraw.js");
  J = await import("../src/lib/intents/withdrawJournal.js");
  DW = await import("../src/perp/deposit/depositWatch.js");
  SDN = await import("../src/lib/intents/ofacSdn.js");
});

const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEP = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const LAZARUS = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const CAPTURE_USER = /0xa1581fb128e573fef727dd9fc2630d0d695a1956/gi;
const NOW = Date.parse("2026-10-15T07:01:10.000Z");
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const iso = (t) => new Date(t).toISOString();
const UP_QUOTE = "https://1click.chaindefuser.com/v0/quote";
const UP_STATUS = "https://1click.chaindefuser.com/v0/status";
const KEY = "jwt-hardening-secret-555";

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
  return Promise.resolve().then(fn).finally(restore);
}
function fakeRes() {
  const out = { headers: {} };
  const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: (t) => { out.body = t; } };
  return { res, out: () => ({ ...out, status: res.statusCode }) };
}
const quoteAnswer = (body) => {
  const j = JSON.parse(JSON.stringify(fixture("dry-arb-to-hc-25.json").answer).replace(CAPTURE_USER, body.refundTo));
  j.quoteRequest = { ...j.quoteRequest, ...body };
  if (!body.dry) j.quote = { ...j.quote, depositAddress: DEP, deadline: iso(NOW + 72 * HOUR), timeWhenInactive: iso(NOW + 72 * HOUR) };
  return j;
};
function fakeNet({ oracle = () => false, gate = null } = {}) {
  const calls = { upstream: [], rpc: [] };
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u === UP_QUOTE || u.startsWith(UP_STATUS)) {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.upstream.push({ url: u, init, body });
      if (gate) await gate;
      const out = body ? quoteAnswer(body) : { status: "PENDING_DEPOSIT", note: `echo ${KEY}` };
      return { status: body ? 201 : 200, ok: true, text: async () => JSON.stringify(out), json: async () => out };
    }
    const rpcBody = JSON.parse(init.body);
    calls.rpc.push({ url: u, body: rpcBody });
    const v = oracle(`0x${rpcBody.params[0].data.slice(-40)}`) ? 1 : 0;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: `0x${v.toString(16).padStart(64, "0")}` }) };
  };
  fn.calls = calls;
  return fn;
}
const depositBody = (over = {}) => ({
  dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
  originAsset: A.ARBITRUM_INTENTS_USDC.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: A.HYPERCORE_USDC.assetId,
  amount: "25000000", refundTo: USER, refundType: "ORIGIN_CHAIN", recipient: USER, recipientType: "DESTINATION_CHAIN",
  deadline: iso(NOW + HOUR), confidentiality: "public", ...over,
});

/* ── H1 ───────────────────────────────────────────────────────────────────── */

test("H1) the status proxy spends the partner key only for our pages: anybody else is read keyless, never refused", async () => {
  const net = fakeNet();
  globalThis.fetch = net;
  try {
    await withEnv({ PRIVATE_MODE: "on", NEAR_INTENTS_JWT: KEY }, async () => {
      const ask = async (headers) => {
        const { res, out } = fakeRes();
        await ST.default({ method: "GET", url: `/?depositAddress=${DEP}`, headers, socket: { remoteAddress: "10.0.0.7" } }, res);
        return out();
      };
      const curl = await ask({});
      assert.equal(curl.status, 200, "a stranger still reads what the public endpoint shows");
      assert.equal(net.calls.upstream[0].init.headers["x-api-key"], undefined, "but never with our key");
      assert.doesNotMatch(curl.body, new RegExp(KEY), "and the key is scrubbed from whatever comes back");
      await ask({ "sec-fetch-site": "same-origin" });
      assert.equal(net.calls.upstream[1].init.headers["x-api-key"], KEY, "a same-origin GET from our page carries it");
      await ask({ origin: "http://localhost:5173" });
      assert.equal(net.calls.upstream[2].init.headers["x-api-key"], KEY, "so does our Origin");
      await ask({ "sec-fetch-site": "cross-site" });
      assert.equal(net.calls.upstream[3].init.headers["x-api-key"], undefined, "a cross-site read without Origin does not");
      for (const c of net.calls.upstream) assert.equal(c.init.redirect, "error");
    });
  } finally {
    globalThis.fetch = forbidden;
  }
  assert.equal(G.keyedCallerOk({}, {}), true, "no key: nothing to protect");
  assert.equal(G.keyedCallerOk({ origin: "https://evil.example" }, { NEAR_INTENTS_JWT: KEY }), false);
  assert.equal(G.keyedCallerOk({ "sec-fetch-site": "same-origin" }, { NEAR_INTENTS_JWT: KEY }), false, "a POST needs Origin itself");
});

/* ── H2 ───────────────────────────────────────────────────────────────────── */

test("H2) the quote proxy's keyed fence: our Origin reaches the service, no Origin is 403, and the GET probe stays open", async () => {
  const net = fakeNet();
  globalThis.fetch = net;
  try {
    await withEnv({ PRIVATE_MODE: "on", NEAR_INTENTS_JWT: KEY }, async () => {
      const post = async (headers) => {
        const { res, out } = fakeRes();
        const t = Date.now();
        const body = depositBody({ dry: true, confidentiality: "basic", deadline: iso(t + HOUR) });
        await Q.default({ method: "POST", headers, body, socket: { remoteAddress: "10.0.0.8" } }, res);
        return out();
      };
      assert.equal((await post({})).status, 403);
      assert.equal(net.calls.upstream.length, 0);
      const ours = await post({ origin: "https://flowflow-alpha.vercel.app" });
      assert.equal(ours.status, 201, ours.body);
      assert.equal(net.calls.upstream.length, 1);
      assert.equal(net.calls.upstream[0].init.headers["x-api-key"], KEY);
      const { res, out } = fakeRes();
      await Q.default({ method: "GET", url: "/?probe=1", headers: {}, socket: { remoteAddress: "10.0.0.8" } }, res);
      assert.equal(out().status, 200, "the probe uses no key: a same-origin GET (no Origin) still learns the toggle");
      assert.equal(JSON.parse(out().body).confidential, true);
    });
  } finally {
    globalThis.fetch = forbidden;
  }
});

/* ── H3 / H4 ──────────────────────────────────────────────────────────────── */

test("H3) the day ledger's reservation: counted at once, released once, and on the day it was taken", () => {
  const l = G.createDayLedger();
  const r = l.reserve(USER, 300, NOW);
  assert.equal(l.spent(USER, NOW), 300);
  r.release();
  r.release();
  assert.equal(l.spent(USER, NOW), 0, "released once, never below what others reserved");
  l.add(USER, 200, NOW);
  const late = l.reserve(USER, 100, NOW);
  const nextDay = NOW + 24 * HOUR;
  l.add(USER, 50, nextDay);
  late.release();
  assert.equal(l.spent(USER, NOW), 200, "the release comes off the day it was reserved on");
  assert.equal(l.spent(USER, nextDay), 50, "not the next one");
});

test("H4) concurrent address quotes: one is sanctioned, its reservation is given back; the cap counts only what reserved an address", async () => {
  const ledger = G.createDayLedger();
  const run = (body, net) => Q.intentsQuoteOnce({ body, env: { PRIVATE_MODE: "on" }, fetchImpl: net, rpcFetch: net, ledger, now: () => NOW, screenMemo: G.newSanctionsMemo(), log: () => {} });
  const ok = fakeNet();
  const listedNet = fakeNet({ oracle: () => true });
  const [a, b] = await Promise.all([run(depositBody({ amount: "400000000" }), ok), run(depositBody({ amount: "400000000" }), listedNet)]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 451);
  assert.equal(ledger.spent(USER, NOW), 400, "the refused one gave its 400 back");
  const c = await run(depositBody({ amount: "500000000" }), fakeNet());
  assert.equal(c.status, 201, "so 400 + 500 still fits the 1,000 day");
  assert.equal(ledger.spent(USER, NOW), 900);
});

/* ── H5 ───────────────────────────────────────────────────────────────────── */

test("H5) clampPrivateLimits: a cap only goes down, a minimum only up; nonsense is the owner's figure", () => {
  const L = C.PRIVATE_LIMITS;
  assert.deepEqual({ ...C.clampPrivateLimits({ maxTxUsdc: 9999, maxDayUsdc: 5000, depositMinUsdc: 1, withdrawMinUsdc: 0.5 }) }, { ...L });
  assert.deepEqual({ ...C.clampPrivateLimits({ maxTxUsdc: 100, maxDayUsdc: 200, depositMinUsdc: 20, withdrawMinUsdc: 8 }) }, { maxTxUsdc: 100, maxDayUsdc: 200, depositMinUsdc: 20, withdrawMinUsdc: 8 });
  for (const bad of [null, undefined, "x", { maxTxUsdc: NaN, maxDayUsdc: -1, depositMinUsdc: Infinity, withdrawMinUsdc: "50" }]) {
    assert.deepEqual({ ...C.clampPrivateLimits(bad) }, { ...L }, JSON.stringify(bad));
  }
});

/* ── H6 ───────────────────────────────────────────────────────────────────── */

test("H6) the SDN copy: well-formed, says it is a seed, refuses before any chain is asked (proxy and withdraw), and parses the published list", async () => {
  assert.ok(SDN.OFAC_SDN_ETH.length >= 20);
  for (const a of SDN.OFAC_SDN_ETH) assert.ok(isAddress(a, { strict: false }) && a === a.toLowerCase(), a);
  assert.equal(new Set(SDN.OFAC_SDN_ETH).size, SDN.OFAC_SDN_ETH.length);
  assert.equal(SDN.OFAC_SDN_ETH_SOURCE.complete, false, "honest: the full list is still owed");
  assert.equal(SDN.sdnListed(LAZARUS), true);
  assert.equal(SDN.sdnListed(LAZARUS.toLowerCase()), true);
  assert.equal(SDN.sdnListed(USER), false);
  assert.equal(SDN.sdnListed("not an address"), false);
  /* The live oracle fixture's listed address is on the copy; its clean one is not. */
  const live = fixture("sanctions-oracle-live.json").answers;
  for (const a of live) assert.equal(SDN.sdnListed(a.address), BigInt(a.result) === 1n, a.address);
  /* Proxy: refused with no RPC call at all. */
  const net = fakeNet();
  const r = await G.screenAddresses([USER, LAZARUS], { fetchImpl: net, memo: G.newSanctionsMemo() });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "sanctioned" });
  assert.equal(net.calls.rpc.length, 0, "the copy is read before any chain");
  /* Withdraw side: the oracle and Hyperliquid both say no, and the copy still refuses. */
  W.clearScreenMemo();
  const w = await W.screenWithdrawAddresses({ user: USER, recipient: LAZARUS, route: W.privateWithdrawRouteById("arbitrum-usdc"), oracle: async () => ({ sanctioned: false }), info: async () => ({ isSanctioned: false, userExists: true, fee: "0.0" }), now: () => 0 });
  assert.equal(w.code, "sanctioned");
  W.clearScreenMemo();
  /* The published file's shape. */
  const parsed = SDN.parseSdnList(`# header\n${LAZARUS}\n\n  0x7F367cC41522cE07553e823bf3be79A889DEbe1B  \nnot-an-address\n0x123\r\n`);
  assert.deepEqual([...parsed].sort(), [LAZARUS.toLowerCase(), "0x7f367cc41522ce07553e823bf3be79a889debe1b"].sort());
});

/* ── H7 ───────────────────────────────────────────────────────────────────── */

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
function statusRows(st, { refundAfter = NOW + 72 * HOUR } = {}) {
  const j = JSON.parse(JSON.stringify(fixture("dry-arb-to-hc-25.json").answer).replace(CAPTURE_USER, USER));
  j.quoteRequest.dry = false;
  j.quote.depositAddress = DEP;
  j.quote.deadline = iso(refundAfter);
  j.quote.timeWhenInactive = iso(refundAfter);
  const answer = { correlationId: "synthetic", quoteResponse: j, status: st, updatedAt: iso(NOW + MINUTE), swapDetails: { depositedAmount: "24000000", refundedAmount: st === "REFUNDED" ? "23994700" : undefined, originChainTxHashes: [], destinationChainTxHashes: [] } };
  return S.normalizeIntentsStatus(answer, { user: USER, depositAddress: DEP });
}
function nearFake() {
  const fn = ({ depositAddress, user, onUpdate }) => {
    const me = { depositAddress, user, onUpdate, stopped: false };
    fn.calls.push(me);
    return { stop() { me.stopped = true; }, refresh() { return true; } };
  };
  fn.calls = [];
  return fn;
}

test("H7) an INCOMPLETE deposit is resumed after a reload past the 24 h news window, heard when refunded, and let go after its refund time", () => {
  let t = NOW;
  const storage = fakeStorage();
  const near = nearFake();
  const w1 = DW.createDepositWatch({ storage, now: () => t, track: nearFake(), trackers: { near } });
  const h = w1.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  near.calls[0].onUpdate({ state: "ok", requests: statusRows("INCOMPLETE_DEPOSIT"), checkedAt: t, error: null });
  h.release();
  const saved = JSON.parse(storage.getItem(DW.watchKey(USER))).list[0];
  assert.equal(saved.waitUntil, Math.min(NOW + 72 * HOUR + DW.WATCH_REFUND_GRACE_MS, NOW + MINUTE + DW.WATCH_INCOMPLETE_MAX_MS));
  w1.stopAll();

  /* 50 h later (window and the 24 h news hold long gone): a reload still resumes it. */
  t = NOW + 50 * HOUR;
  const near2 = nearFake();
  const w2 = DW.createDepositWatch({ storage, now: () => t, track: nearFake(), trackers: { near: near2 } });
  w2.focus(USER);
  assert.equal(near2.calls.length, 1, "the waiting deposit is followed again");
  near2.calls[0].onUpdate({ state: "ok", requests: statusRows("INCOMPLETE_DEPOSIT"), checkedAt: t, error: null });
  assert.equal(near2.calls[0].stopped, false);
  /* Said (until closed) as what it is, never as money: less than quoted, waiting for its refund. */
  assert.equal(DW.pickDepositStatus(w2.getState(), USER).row.status, "incomplete", "said as incomplete, never as money");
  /* The refund lands: it is heard, and announced like any finished deposit. */
  near2.calls[0].onUpdate({ state: "ok", requests: statusRows("REFUNDED"), checkedAt: t, error: null });
  assert.equal(DW.pickDepositStatus(w2.getState(), USER).row.status, "refunded");
  w2.stopAll();

  /* Past the refund time plus grace with no change: let go (not a poll for ever). */
  t = NOW + 72 * HOUR + DW.WATCH_REFUND_GRACE_MS + MINUTE;
  const near3 = nearFake();
  const storage3 = fakeStorage();
  const w3 = DW.createDepositWatch({ storage: storage3, now: () => NOW, track: nearFake(), trackers: { near: near3 } });
  const h3 = w3.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  near3.calls[0].onUpdate({ state: "ok", requests: statusRows("INCOMPLETE_DEPOSIT"), checkedAt: NOW, error: null });
  h3.release();
  w3.stopAll();
  const near4 = nearFake();
  const w4 = DW.createDepositWatch({ storage: storage3, now: () => t, track: nearFake(), trackers: { near: near4 } });
  w4.focus(USER);
  assert.equal(near4.calls.length, 0, "an old wait is not resumed");
  w4.stopAll();
});

/* ── H8 ───────────────────────────────────────────────────────────────────── */

const FIX = JSON.parse(read("scripts/fixtures/intents/withdraw-live-2026-10-15.json"));
function memStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
async function withdrawSetup() {
  const REAL = FIX.real.response;
  const q = W.parseIntentsWithdrawQuote(clone(REAL), {
    user: REAL.quoteRequest.refundTo, recipient: REAL.quoteRequest.recipient, route: W.privateWithdrawRouteById("arbitrum-usdc"),
    amountUsdc: "20", dry: false, deadline: REAL.quoteRequest.deadline, now: Date.parse(FIX.real.capturedAt),
  });
  const info = async (body) => {
    if (body.type === "preTransferCheck") return FIX.hl.ptcFresh.response;
    if (body.type === "userRole") return { role: "missing" };
    if (body.type === "clearinghouseState") return { withdrawable: "100.0" };
    throw new Error(`unexpected ${body.type}`);
  };
  const pf = await W.readWithdrawPreflight({ quote: q, info, now: () => q.quotedAt + 1000 });
  const now = () => q.quotedAt + 3000;
  return { q, pf, now, journal: J.createWithdrawJournal({ user: q.user, storage: memStorage(), now }) };
}

test("H8) only the listed codes are 'nothing sent'; a lost flag always wins; anything else blocks the next withdrawal", async () => {
  for (const code of ["user_rejected", "signature_rejected", "wallet_timeout", "hl_error", "rate_limited", "quote_expired"]) {
    const { q, pf, now, journal } = await withdrawSetup();
    const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: async () => ({ ok: false, code, message: "no" }), now });
    assert.equal(r.nothingSent, true, code);
    assert.equal(journal.get(q.depositAddress).state, "not-sent", code);
  }
  for (const answer of [{ ok: false, code: "bad_response" }, { ok: false, code: "hl_error", lost: true }, { ok: false, code: "something_new" }, { ok: false }]) {
    const { q, pf, now, journal } = await withdrawSetup();
    const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: async () => answer, now });
    assert.equal(r.notConfirmed, true, JSON.stringify(answer));
    assert.equal(r.nothingSent, undefined, JSON.stringify(answer));
    assert.equal(journal.get(q.depositAddress).state, "unknown", JSON.stringify(answer));
    assert.equal(journal.canStart({ amountRaw: q.amountRaw, now: now() }).code, "unsettled", JSON.stringify(answer));
  }
  assert.ok(!W.WITHDRAW_NOT_SENT_CODES.includes("bad_response"));
  assert.ok(!W.WITHDRAW_NOT_SENT_CODES.includes("network"));
  assert.ok(!W.WITHDRAW_NOT_SENT_CODES.includes("not_confirmed"));
});
