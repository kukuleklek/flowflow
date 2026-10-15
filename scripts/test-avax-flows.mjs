/**
 * test-avax-flows — THE MONEY MOVES BETWEEN THE USER'S OWN PERP ACCOUNT AND THEIR
 * OWN AVAX WALLET: move-in (with the printed gas top-up), gas top-up, move-out
 * (the EIP-3009 exit, ready for the 2026-10-26 MulticallAuthorization), and the
 * paid exit. Plan v2 §3.1–§3.8, AD-5 / AD-8.
 *
 * 🔴 MONEY SAFETY. Nothing here signs, holds a key or reaches a network: every
 * signer, sender and fetch is a recorder. The fixtures are read-only Relay
 * answers (scripts/fixtures/avax/*.json — "live-*" captured 2026-10-15 by this
 * track, the rest copied from plan-avax/relay-raw and gasdocs).
 *
 * Run: node --test scripts/test-avax-flows.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFunctionData, parseAbi, maxUint256 } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const OM = await imp("src/lib/relay/ownMove.js");
const MI = await imp("src/lib/relay/moveIn.js");
const MO = await imp("src/lib/relay/moveOut.js");
const GT = await imp("src/lib/relay/gasTopup.js");
const SW = await imp("src/lib/relay/swap.js");
const PINS = await imp("src/lib/avax/relayPins.js");
const FL = await imp("src/avax/flows.js");
const GAS = await imp("src/lib/avax/gas.js");

const FIX = path.join(ROOT, "scripts/fixtures/avax");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

const DEAD = "0x000000000000000000000000000000000000dEaD";
const ONE = "0x1111111111111111111111111111111111111111";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SIG = `0x${"ab".repeat(65)}`;

const MOVE_IN = load("live-move-in-6-topup.json");
const MOVE_OUT = load("live-move-out-2.json");

/* ── fakes ────────────────────────────────────────────────────────────────── */

class MemStorage {
  constructor() { this.m = new Map(); this.drop = false; this.throwOnSet = false; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.throwOnSet) throw new Error("QuotaExceededError"); if (!this.drop) this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const okRes = (json = {}) => ({ ok: true, status: 200, json: async () => json });
const badRes = (status = 500) => ({ ok: false, status, json: async () => ({ message: "nope" }) });

function moveInReview({ json = MOVE_IN.response, topupUsd = 0.3, max = MI.maxDebitUsdc(6, 0.3), now = MOVE_IN.capturedAt } = {}) {
  return OM.parseOwnMoveQuote(json, { own: DEAD, dest: "usdc", amountRaw: "6000000", topupUsd, maxDebitUsdc: max, now });
}
const throwsUnsafe = (fn, re) => assert.throws(fn, (e) => (e.code === "unsafe-quote" || e.code === "needs-gas") && (!re || re.test(e.message)), String(re));

/* ── move-in ──────────────────────────────────────────────────────────────── */

test("F1) the move-in body names only the user's own address, EXACT_OUTPUT, explicit gas", () => {
  const { body, gasRow, amountRaw } = MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: "6", topupUsd: 0.3, expectedAvaxWei: 31560061163398534n, recipient: OTHER });
  assert.deepEqual(body, {
    user: DEAD, recipient: DEAD, refundTo: DEAD, originChainId: 1337, originCurrency: "0x00000000000000000000000000000000",
    destinationChainId: 43114, destinationCurrency: PINS.AVAX_USDC, amount: "6000000", tradeType: "EXACT_OUTPUT",
    topupGas: true, topupGasAmount: "300000",
  });
  assert.equal(amountRaw, "6000000");
  assert.equal(gasRow.label, "Gas for later");
  assert.match(gasRow.text, /AVAX \(\$0\.30\) · stays in your Avax Wallet/);
  /* No gas asked → no gas in the body and no row. */
  const plain = MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 5 });
  assert.equal(plain.body.topupGas, undefined);
  assert.equal(plain.body.topupGasAmount, undefined);
  assert.equal(plain.gasRow, null);
});

test("F2) move-in caps: 1 ≤ X ≤ 20, 6 decimals, gas $0.20–0.50", () => {
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 21 }), (e) => e.code === "over-cap");
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 10, maxMoveUsdc: 50 }) && MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 25, maxMoveUsdc: 50 }), (e) => e.code === "over-cap", "env may lower the cap, never raise it");
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 0.5 }), (e) => e.code === "too-small");
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: "1.0000001" }), (e) => e.code === "bad-amount");
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 5, topupUsd: 0.6 }), (e) => e.code === "bad-topup");
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 5, topupUsd: 0.1 }), (e) => e.code === "bad-topup");
  assert.throws(() => MI.buildMoveInQuoteBody({ own: "0x0000000000000000000000000000000000000000", amountUsdc: 5 }), (e) => e.code === "bad-user");
  assert.equal(MI.stakeFeeCeiling(5), 0.25);
  assert.equal(MI.stakeFeeCeiling(20), 0.4);
  assert.equal(MI.maxDebitUsdc(6, 0.3), 6.7);
  assert.equal(MI.maxDebitUsdc(10, 0), 10.25);
  assert.equal(MI.maxDebitUsdc(null), null);
});

test("F3) the LIVE move-in answer (6 USDC + $0.30 gas) parses: debit, net fee, gas row, pinned depository", () => {
  const r = moveInReview();
  assert.equal(r.kind, "move-in");
  assert.equal(r.amountIn, 6.342288);
  assert.equal(r.amountInRaw, "634228800");
  assert.equal(r.feeUsdc, 0.042288, "the fee is net of the gas the user keeps");
  assert.equal(r.topup.raw, "31560061163398534");
  assert.equal(r.topup.usd, 0.3);
  assert.equal(typeof r.gasRow.avaxWei, "bigint");
  assert.equal(r.gasRow.avaxWei, 31560061163398534n);
  assert.match(r.gasRow.text, /^Gas for later ≈0\.031\d AVAX \(\$0\.30\) · stays in your Avax Wallet$/);
  assert.equal(r.depository, PINS.HL_DEPOSITORY);
  assert.equal(r.hlNonce, 1792044083340);
  assert.equal(r.maxDebitUsdc, 6.7);
  assert.equal(r.recipient.toLowerCase(), DEAD.toLowerCase());
});

test("F4) 🔴 AD-8: a body with topupGas and no Gas-for-later row can never be confirmed", () => {
  const withRow = MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 6, topupUsd: 0.3, expectedAvaxWei: 30000000000000000n });
  const noRow = MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 6, topupUsd: 0.3 });
  assert.equal(noRow.gasRow, null, "no expected AVAX → no provisional row");
  assert.equal(MI.moveInConfirmable({ body: noRow.body, gasRow: null }).ok, false);
  assert.equal(MI.moveInConfirmable({ body: withRow.body, gasRow: withRow.gasRow }).ok, true);
  const review = moveInReview();
  assert.equal(MI.moveInConfirmable({ body: noRow.body, review }).ok, true, "the quote's own row makes it confirmable");
  assert.equal(MI.moveInConfirmable({ body: noRow.body, review: { ...review, gasRow: null } }).ok, false);
  assert.equal(MI.moveInConfirmable({ body: noRow.body, review: { ...review, topup: null } }).ok, false);
  /* A row with nothing buying gas is a lie too. */
  const plain = MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 6 });
  assert.equal(MI.moveInConfirmable({ body: plain.body, gasRow: withRow.gasRow }).ok, false);
  assert.equal(MI.moveInConfirmable({ body: plain.body, gasRow: null }).ok, true);
  /* gas.js holds the same rule. */
  assert.equal(GAS.gasRowProblem({ body: noRow.body, gasRow: null }), "Gas for later is missing from the card");
});

test("F5) the move-in parser refuses every answer that is not exactly the user's own move", () => {
  const J = MOVE_IN.response;
  const mut = (fn) => { const j = clone(J); fn(j); return j; };
  const v2 = (j) => j.protocol.v2;
  const cases = [
    [mut((j) => { j.details.recipient = OTHER; }), /recipient/],
    [mut((j) => { v2(j).orderData.output.payments[0].recipient = OTHER; }), /payment/],
    [mut((j) => { v2(j).orderData.inputs[0].refunds[1].recipient = OTHER; }), /refund/],
    [mut((j) => { v2(j).orderData.output.calls = ["0x00"]; }), /calls/],
    [mut((j) => { v2(j).orderData.output.extraData = `0x${"0".repeat(24)}${OTHER.slice(2).toLowerCase()}`; }), /data it should not/],
    [mut((j) => { j.fees.app.amount = "1000"; }), /app fee/],
    [mut((j) => { delete j.details.currencyGasTopup; }), /no gas/],
    [mut((j) => { j.details.currencyGasTopup.amountUsd = "0.900000"; }), /size/],
    [mut((j) => { j.details.currencyGasTopup.minimumAmount = "1"; }), /guaranteed/],
    [mut((j) => { j.details.currencyOut.minimumAmount = "5900000"; }), /exactly/],
    [mut((j) => { v2(j).orderData.output.payments[0].expectedAmount = "6100000"; }), /another amount/],
    [mut((j) => { j.details.currencyIn.amount = "634228801"; v2(j).paymentDetails.amount = "634228801"; }), /decimals|stated two ways/],
    [mut((j) => { j.steps[1].items[0].data.action.parameters.extra = "x"; }), /fields/],
    [mut((j) => { j.steps[1].items[0].data.action.parameters.destination = OTHER; v2(j).paymentDetails.depository = OTHER; }), /known depository|wallet/],
    [mut((j) => { j.steps[1].items[0].data.action.parameters.amount = "6.342289"; }), /amount/],
    [mut((j) => { j.details.currencyOut.currency.chainId = 42161; }), /destination|token/],
    [mut((j) => { v2(j).paymentDetails.amount = "100"; }), /deposit/],
  ];
  for (const [j, re] of cases) throwsUnsafe(() => moveInReview({ json: j }), re);
  /* The debit ceiling. */
  throwsUnsafe(() => moveInReview({ max: 6.3 }), /over the 6\.3 USDC/);
  /* Gas nobody asked for. */
  throwsUnsafe(() => moveInReview({ topupUsd: null, max: 10 }), /nobody asked/);
  /* A quote WITH calls (the one-shot stake shape, q4) is not an own move. */
  throwsUnsafe(() => OM.parseOwnMoveQuote(load("relay-q4-calls-topup5c.json").response, { own: DEAD, dest: "usdc", amountRaw: "10000000", topupUsd: 0.05, maxDebitUsdc: 11 }));
  /* EXACT_INPUT (q1): what arrives is not guaranteed, so it is not this move. */
  throwsUnsafe(() => OM.parseOwnMoveQuote(load("relay-q1-plain.json").response, { own: DEAD, dest: "usdc", amountRaw: "9973824", maxDebitUsdc: 11 }), /exactly/);
  /* EXACT_INPUT with gas (q6, and R-gas's 20 USDC + $0.50): refused for the same reason. */
  throwsUnsafe(() => OM.parseOwnMoveQuote(load("relay-q6-plain-topup10c.json").response, { own: DEAD, dest: "usdc", amountRaw: "9856861", topupUsd: 0.1, maxDebitUsdc: 11 }), /exactly/);
  throwsUnsafe(() => OM.parseOwnMoveQuote(load("gas-q-in.json").response, { own: ONE, dest: "usdc", amountRaw: "19450000", topupUsd: 0.5, maxDebitUsdc: 21 }), /exactly/);
  /* Another wallet's quote. */
  throwsUnsafe(() => OM.parseOwnMoveQuote(J, { own: OTHER, dest: "usdc", amountRaw: "6000000", topupUsd: 0.3, maxDebitUsdc: 7 }));
});

test("F6) PLAN DEVIATION held: output.extraData may be 0x or a pinned router (every live move-in carries the v3 router)", () => {
  assert.equal(MOVE_IN.response.protocol.v2.orderData.output.extraData, `0x${"0".repeat(24)}${PINS.RELAY_V3.router.slice(2)}`);
  const j = clone(MOVE_IN.response);
  j.protocol.v2.orderData.output.extraData = "0x";
  assert.equal(moveInReview({ json: j }).amountIn, 6.342288);
  j.protocol.v2.orderData.output.extraData = `0x${"0".repeat(24)}${PINS.RELAY_V32.router.slice(2)}`;
  assert.equal(moveInReview({ json: j }).amountIn, 6.342288);
});

/* ── executing an own move ────────────────────────────────────────────────── */

function registryFor(storage, { now = () => MOVE_IN.capturedAt } = {}) {
  return FL.createFlowRegistry({ storage, own: DEAD, now });
}
function ownMoveRig({ review = moveInReview(), clock = MOVE_IN.capturedAt + 1000, sendDeposit, signAuthorize, fetchImpl, storage = new MemStorage(), ownNow = () => DEAD } = {}) {
  const t = { now: clock };
  const reg = registryFor(storage, { now: () => t.now });
  const rec = reg.begin({ kind: "move-in", amounts: { out: "6", in: "6.342288", topupUsd: 0.3 }, maxDebit: 6.7 });
  assert.equal(reg.confirm(rec.id).ok, true);
  const log = [];
  const o = {
    review, ownNow, flow: reg.handle(rec.id), now: () => t.now,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    signAuthorize: signAuthorize || (async (step) => { log.push(["sign", step.id]); return { ok: true, signature: SIG }; }),
    fetchImpl: fetchImpl || (async (url) => { log.push(["post", String(url).replace(/\?.*/, "")]); return okRes(); }),
    sendDeposit: sendDeposit || (async ({ step, amountUsdc }) => {
      const at = reg.get(rec.id);
      log.push(["send", step.id, amountUsdc, at.state, at.requestId, at.hlNonce]);
      return { ok: true };
    }),
  };
  return { o, reg, rec, log, t, storage };
}

test("F7) executeOwnMove: authorize, POST, REGISTRY WRITTEN, then the sendAsset — in that order", async () => {
  const { o, reg, rec, log } = ownMoveRig();
  const r = await OM.executeOwnMove(o);
  assert.equal(r.ok, true);
  assert.equal(r.state, "arriving");
  assert.deepEqual(log.map((x) => x[0]), ["sign", "post", "send"]);
  assert.equal(log[1][1], "https://api.relay.link/authorize");
  const send = log[2];
  assert.equal(send[2], 6.342288, "the signer is asked for the debit on the card");
  assert.equal(send[3], "sending", "the registry said 'sending' before the money window opened");
  assert.equal(send[4], o.review.requestId);
  assert.equal(send[5], 1792044083340);
  assert.equal(reg.get(rec.id).state, "arriving");
});

test("F8) executeOwnMove: a registry that cannot be written means the money window never opens", async () => {
  const storage = new MemStorage();
  let sent = 0;
  const { o, reg, rec } = ownMoveRig({ storage, sendDeposit: async () => { sent += 1; return { ok: true }; } });
  storage.drop = true; /* writes now vanish silently */
  const r = await OM.executeOwnMove(o);
  assert.equal(sent, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, "registry");
  assert.match(r.message, /couldn't record the move, so nothing was sent/);
  storage.drop = false;
  assert.notEqual(reg.get(rec.id).state, "sending");
});

test("F9) executeOwnMove: the price expires while the first window is open → 'Price expired. Nothing moved.'", async () => {
  let sent = 0;
  const rig = ownMoveRig({ sendDeposit: async () => { sent += 1; return { ok: true }; } });
  rig.o.signAuthorize = async () => { rig.t.now += 61_000; return { ok: true, signature: SIG }; };
  const r = await OM.executeOwnMove(rig.o);
  assert.equal(sent, 0);
  assert.equal(r.message, "Price expired. Nothing moved.");
  assert.equal(r.state, "cancelled");
  assert.equal(rig.reg.get(rig.rec.id).state, "cancelled");
});

test("F10) executeOwnMove: a lost sendAsset reply is UNKNOWN — 'Don't send it again', watched, never retried", async () => {
  for (const reply of [{ ok: false, code: "not_confirmed" }, { ok: false, lost: true }, { ok: false, code: "unexpected" }]) {
    const rig = ownMoveRig({ sendDeposit: async () => reply });
    const r = await OM.executeOwnMove(rig.o);
    assert.equal(r.ok, false);
    assert.equal(r.unknown, true);
    assert.equal(r.message, "May have left your Perp account. Don't send it again.");
    assert.equal(rig.reg.get(rig.rec.id).state, "unknown");
    assert.equal(rig.reg.canStart().code, "unknown", "no new money flow while one is unknown");
    assert.doesNotMatch(r.message, /try again/i);
  }
  /* A throw inside the window is unknown too. */
  const rig = ownMoveRig({ sendDeposit: async () => { throw new Error("socket hang up"); } });
  const r = await OM.executeOwnMove(rig.o);
  assert.equal(r.unknown, true);
});

test("F11) executeOwnMove: nothing is signed when the wallet is not the one the quote was for", async () => {
  let signed = 0;
  const rig = ownMoveRig({ ownNow: () => OTHER, signAuthorize: async () => { signed += 1; return { ok: true, signature: SIG }; } });
  const r = await OM.executeOwnMove(rig.o);
  assert.equal(signed, 0);
  assert.equal(r.code, "wallet");
  /* The user closes the first window: cancelled, nothing moved. */
  const rig2 = ownMoveRig({ signAuthorize: async () => ({ ok: false, code: "rejected", message: "User rejected" }) });
  const r2 = await OM.executeOwnMove(rig2.o);
  assert.equal(r2.message, "Cancelled. Nothing moved.");
  assert.equal(rig2.reg.get(rig2.rec.id).state, "cancelled");
});

/* ── gas top-up ───────────────────────────────────────────────────────────── */

test("F12) Top up gas: EXACT AVAX from an independent price, native body, debit ceiling, row printed", () => {
  const wei = GT.gasTopupWei({ usd: 0.3, avaxUsd: 9.5 });
  assert.equal(wei, 31578000000000000n, "0.3 / 9.5 = 0.031578 AVAX, rounded down to 1e-6");
  assert.equal(GT.gasTopupWei({ usd: 0.3, avaxUsd: null }), null, "unknown price → no size, never a guess");
  assert.equal(GT.gasTopupWei({ usd: 1, avaxUsd: 9.5 }), null, "outside $0.20–0.50");
  const body = GT.buildGasTopupQuoteBody({ own: DEAD, avaxWei: wei });
  assert.deepEqual(body, {
    user: DEAD, recipient: DEAD, refundTo: DEAD, originChainId: 1337, originCurrency: "0x00000000000000000000000000000000",
    destinationChainId: 43114, destinationCurrency: PINS.NATIVE, amount: "31578000000000000", tradeType: "EXACT_OUTPUT",
  });
  assert.equal(GT.gasTopupMaxDebitUsdc(0.3), 0.565);
  /* The captured buy (q15: 0.005 AVAX for 0.135582) is an own move of AVAX. */
  const q15 = load("relay-q15-gasbuy.json").response;
  const r = OM.parseOwnMoveQuote(q15, { own: ONE, dest: "avax", amountRaw: "5000000000000000", maxDebitUsdc: 0.3 });
  assert.equal(r.kind, "gas-topup");
  assert.equal(r.amountIn, 0.135582);
  assert.equal(r.amountOut, "0.005");
  throwsUnsafe(() => OM.parseOwnMoveQuote(q15, { own: ONE, dest: "avax", amountRaw: "5000000000000000", maxDebitUsdc: 0.1 }), /over/);
  throwsUnsafe(() => OM.parseOwnMoveQuote(q15, { own: ONE, dest: "avax", amountRaw: "6000000000000000", maxDebitUsdc: 1 }), /exactly/);
  assert.throws(() => OM.buildOwnMoveQuoteBody({ own: DEAD, dest: "avax", amountRaw: wei, topupUsd: 0.3 }), (e) => e.code === "bad-topup");
});

test("F12b) quoteGasTopup / quoteMoveIn go through ONE POST with the body built here, and verify the answer", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return okRes(MOVE_IN.response); };
  const out = await MI.quoteMoveIn({ own: DEAD, amountUsdc: 6, topupUsd: 0.3, fetchImpl, now: () => MOVE_IN.capturedAt, timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.relay.link/quote/v2", "Node asks Relay directly; a page asks /api/relay-quote");
  assert.equal(calls[0].body.topupGasAmount, "300000");
  assert.equal(out.gasRow.avaxWei, 31560061163398534n);
  assert.equal(MI.moveInConfirmable({ body: out.body, review: out.review }).ok, true);
  /* A refused quote surfaces in plain words, no provider name. */
  const refused = async () => ({ ok: false, status: 400, json: async () => ({ message: "Relay could not quote", errorCode: "NO_QUOTES" }) });
  await assert.rejects(MI.quoteMoveIn({ own: DEAD, amountUsdc: 6, fetchImpl: refused, timers: { setTimeout: () => 0, clearTimeout: () => {} } }), (e) => e.code === "relay-error" && !/relay/i.test(e.message));
});

/* ── move-out (the exit) ──────────────────────────────────────────────────── */

const outNow = () => (MOVE_OUT.response.steps[0].items[0].data.sign.value.validBefore - 600) * 1000;
const moveOutReview = (json = MOVE_OUT.response, now = outNow(), amountRaw = "2000000", own = DEAD) => MO.parseMoveOutQuote(json, { own, amountRaw, now });

test("F13) the move-out body: own in every role, usePermit + useMulticallAuthorization, ≥ 1 USDC", () => {
  assert.deepEqual(MO.buildMoveOutQuoteBody({ own: DEAD, amountUsdc: "2", recipient: OTHER }), {
    user: DEAD, recipient: DEAD, refundTo: DEAD, originChainId: 43114, originCurrency: PINS.AVAX_USDC,
    destinationChainId: 1337, destinationCurrency: "0x00000000000000000000000000000000", amount: "2000000", tradeType: "EXACT_INPUT",
    usePermit: true, useMulticallAuthorization: true,
  });
  assert.throws(() => MO.buildMoveOutQuoteBody({ own: DEAD, amountUsdc: "0.5" }), (e) => e.code === "too-small");
  const paid = MO.buildPaidExitQuoteBody({ own: DEAD, amountRaw: "2000000" });
  assert.equal(paid.usePermit, undefined);
  assert.equal(paid.useMulticallAuthorization, undefined);
});

test("F14) the LIVE move-out answer (2 USDC → Perp): one EIP-3009 signature, nothing else, zero AVAX", () => {
  const r = moveOutReview();
  assert.equal(r.signatureCount, 1);
  assert.equal(r.signatures[0].kind, "eip3009");
  assert.equal(r.signatures[0].typedData.primaryType, "ReceiveWithAuthorization");
  assert.equal(r.signatures[0].typedData.message.to, PINS.RELAY_V3.approvalProxy);
  assert.equal(r.signatures[0].post.endpoint, "/execute/permits");
  assert.equal(r.receiveUsdc, "1.969383");
  assert.equal(r.minimumUsdc, "1.903408");
  assert.ok(Number(r.receiveUsdc) >= 2 - MI.stakeFeeCeiling(2), "the fee bound holds on what is expected");
  assert.ok(Number(r.minimumUsdc) >= Number(r.receiveUsdc) * (1 - MO.MOVE_OUT_MAX_SLIPPAGE_PCT / 100));
  assert.equal(r.feeUsdc, "0.030617");
  assert.match(r.permitNonce, /^0x[0-9a-f]{64}$/);
  assert.equal(r.validBefore, 1792044682);
  /* The older 10 USDC capture (q13) and the R-gas one (20 USDC, useMulticallAuthorization) read the same way. */
  const q13 = load("relay-q13-back-permit.json").response;
  assert.equal(MO.parseMoveOutQuote(q13, { own: ONE, amountRaw: "10000000", now: (q13.steps[0].items[0].data.sign.value.validBefore - 600) * 1000 }).receiveUsdc, "9.96762");
  const qo = load("gas-q-out.json").response;
  assert.equal(MO.parseMoveOutQuote(qo, { own: ONE, amountRaw: "20000000", now: (qo.steps[0].items[0].data.sign.value.validBefore - 600) * 1000 }).signatureCount, 1);
});

/* The 2026-10-26 shape (Relay docs, gasless-swaps): two items, MulticallAuthorization first. SYNTHETIC — no live
   capture can exist before the switch; built from the live answer + the documented typed data. */
const MOVE_OUT_ABI = parseAbi(["function approve(address,uint256)", "function depositErc20(address,address,uint256,bytes32)", "function transfer(address,uint256)"]);
function withMca(mutate = null) {
  const j = clone(MOVE_OUT.response);
  const item = j.steps[0].items[0];
  item.data.sign.value.to = PINS.RELAY_V32.approvalProxy;
  const vb = item.data.sign.value.validBefore;
  const mca = {
    status: "incomplete",
    data: {
      sign: {
        signatureKind: "eip712",
        domain: { name: "RelayApprovalProxy", version: "3.1", chainId: 43114, verifyingContract: PINS.RELAY_V32.approvalProxy },
        types: {
          MulticallAuthorization: [
            { name: "from", type: "address" }, { name: "relayer", type: "address" }, { name: "msgValue", type: "uint256" },
            { name: "refundTo", type: "address" }, { name: "nftRecipient", type: "address" }, { name: "metadata", type: "bytes" },
            { name: "fundingIndex", type: "uint256" }, { name: "calls", type: "Call3Value[]" }, { name: "funding", type: "FundingAuthorization[]" },
          ],
          Call3Value: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }],
          FundingAuthorization: [{ name: "token", type: "address" }, { name: "from", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }],
        },
        primaryType: "MulticallAuthorization",
        value: {
          from: DEAD, relayer: PINS.RELAY_SOLVERS[0], msgValue: "0", refundTo: DEAD, nftRecipient: DEAD, metadata: "0x", fundingIndex: 0,
          calls: [
            { target: PINS.AVAX_USDC, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "approve", args: [PINS.AVAX_DEPOSITORY, 2000000n] }) },
            { target: PINS.AVAX_DEPOSITORY, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "depositErc20", args: [DEAD, PINS.AVAX_USDC, 2000000n, j.protocol.v2.orderId] }) },
          ],
          funding: [{ token: PINS.AVAX_USDC, from: DEAD, value: "2000000", validAfter: 0, validBefore: vb }],
        },
      },
      post: { endpoint: "/execute/permits", method: "POST", body: { kind: "multicall-authorization", requestId: j.requestId, api: "swap" } },
    },
  };
  j.steps[0].items = [mca, item];
  if (mutate) mutate(j, mca.data.sign.value, item.data.sign.value, mca.data);
  return j;
}

test("F15) ready for 2026-10-26: MulticallAuthorization + EIP-3009, checked item by item, in order", () => {
  const r = moveOutReview(withMca());
  assert.equal(r.signatureCount, 2);
  assert.deepEqual(r.signatures.map((s) => s.kind), ["multicall-authorization", "eip3009"]);
  const bad = [
    [withMca((j, m) => { m.calls[1].callData = encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "transfer", args: [OTHER, 2000000n] }); m.calls[1].target = PINS.AVAX_USDC; }), /unknown address/],
    [withMca((j, m) => { m.calls.push({ target: OTHER, allowFailure: false, value: "0", callData: "0x" }); }), /call|read/],
    [withMca((j, m) => { m.funding[0].value = "3000000"; }), /another amount/],
    [withMca((j, m) => { m.refundTo = OTHER; }), /not yours/],
    [withMca((j, m) => { m.msgValue = "1"; }), /AVAX/],
    [withMca((j, m, r, d) => { d.sign.domain.verifyingContract = PINS.RELAY_V3.approvalProxy; }), /known contract/],
    [withMca((j, m, r) => { r.to = PINS.RELAY_V3.approvalProxy; }), /different contracts/],
    [withMca((j, m, r, d) => { d.post.body.kind = "eip3009"; }), /posted as/],
    [withMca((j, m) => { m.calls[1].callData = encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "depositErc20", args: [OTHER, PINS.AVAX_USDC, 2000000n, j.protocol.v2.orderId] }); }), /not yours/],
  ];
  for (const [j, re] of bad) throwsUnsafe(() => moveOutReview(j), re);
  /* The MulticallAuthorization must come FIRST: reversed order is refused. */
  const rev = withMca((j) => { j.steps[0].items.reverse(); });
  throwsUnsafe(() => moveOutReview(rev));
});

test("F16) the move-out parser refuses every grant that is not exactly this exit", () => {
  const mut = (fn) => { const j = clone(MOVE_OUT.response); fn(j, j.steps[0].items[0].data.sign); return j; };
  const vb = MOVE_OUT.response.steps[0].items[0].data.sign.value.validBefore;
  const cases = [
    [mut((j, s) => { s.value.from = OTHER; }), /not from your wallet/],
    [mut((j, s) => { s.value.value = "2000001"; }), /another amount/],
    [mut((j, s) => { s.value.to = OTHER; }), /unknown contract/],
    [mut((j, s) => { s.value.validBefore = vb + 3600; }), /too long/],
    [mut((j, s) => { s.domain.chainId = 1; }), /USDC on Avalanche/],
    [mut((j, s) => { s.domain.verifyingContract = PINS.SWAP_EXCLUDED.bUSDC; }), /USDC on Avalanche/],
    [mut((j, s) => { s.types.ReceiveWithAuthorization.pop(); }), /fields/],
    [mut((j) => { j.protocol.v2.orderData.output.payments[0].recipient = OTHER; }), /Perp account/],
    [mut((j) => { j.details.recipient = OTHER; }), /another account/],
    [mut((j) => { j.details.currencyOut.minimumAmount = "170000000"; }), /too little is guaranteed/],
    [mut((j) => { j.details.currencyOut.amount = "170000000"; j.details.currencyOut.minimumAmount = "165000000"; }), /too little would arrive/],
    [mut((j) => { j.protocol.v2.paymentDetails.depository = OTHER; }), /depository/],
    [mut((j) => { j.protocol.v2.orderData.inputs[0].refunds[0].recipient = OTHER; }), /refund/],
    [mut((j) => { j.steps[0].items[0].data.post.body.requestId = "0x01"; }), /another order/],
    [mut((j) => { j.steps[0].items[0].data.post.endpoint = "/execute/swap"; }), /where to post/],
    [mut((j) => { j.fees.app.amount = "5"; }), /app fee/],
  ];
  for (const [j, re] of cases) throwsUnsafe(() => moveOutReview(j), re);
  /* Expired at the user's clock, or about to. */
  throwsUnsafe(() => moveOutReview(MOVE_OUT.response, (vb - 30) * 1000), /about to expire/);
  /* Clock skew is allowed both ways within 2 minutes; beyond, refused. */
  assert.equal(moveOutReview(MOVE_OUT.response, (vb - 600 - 100) * 1000).validBefore, vb);
  throwsUnsafe(() => moveOutReview(MOVE_OUT.response, (vb - 600 - 200) * 1000), /too long/);
  /* A route that needs a transaction (the plain answer, q11) is not the permit exit. */
  assert.throws(() => MO.parseMoveOutQuote(load("relay-q11-back-plain.json").response, { own: ONE, amountRaw: "10000000" }), (e) => e.code === "needs-gas");
  /* An aToken origin (q14 with permit) is not USDC: refused. */
  assert.throws(() => MO.parseMoveOutQuote(load("relay-q14-aToken-permit.json").response, { own: ONE, amountRaw: "10000000" }));
});

function moveOutRig({ review = moveOutReview(withMca()), storage = new MemStorage(), signTypedData, fetchImpl } = {}) {
  const t = { now: outNow() + 1000 };
  const reg = FL.createFlowRegistry({ storage, own: DEAD, now: () => t.now });
  const rec = reg.begin({ kind: "move-out", amounts: { in: "2" } });
  assert.equal(reg.confirm(rec.id).ok, true);
  const log = [];
  const o = {
    review, ownNow: () => DEAD, flow: reg.handle(rec.id), now: () => t.now, timers: { setTimeout: () => 0, clearTimeout: () => {} },
    signTypedData: signTypedData || (async (td) => { log.push(["sign", td.primaryType]); return SIG; }),
    fetchImpl: fetchImpl || (async (url, init) => { const st = reg.get(rec.id).state; log.push(["post", JSON.parse(init.body).kind, st, url.includes(`signature=${SIG}`)]); return okRes(); }),
  };
  return { o, reg, rec, log, t, storage };
}

test("F17) executeMoveOut: sign every item first, then POST the call authorisation, write the registry, POST the permit", async () => {
  const { o, reg, rec, log } = moveOutRig();
  const r = await MO.executeMoveOut(o);
  assert.equal(r.ok, true);
  assert.deepEqual(log.map((x) => x.slice(0, 2)), [["sign", "MulticallAuthorization"], ["sign", "ReceiveWithAuthorization"], ["post", "multicall-authorization"], ["post", "eip3009"]]);
  assert.equal(log[2][2], "confirmed", "the call authorisation moves nothing: no money window yet");
  assert.equal(log[3][2], "sending", "the registry said 'sending' before the permit that moves money");
  assert.equal(log[3][3], true, "the signature rides as the query parameter");
  const after = reg.get(rec.id);
  assert.equal(after.state, "arriving");
  assert.equal(after.permitNonce, o.review.permitNonce);
  assert.equal(after.validBefore, o.review.validBefore);
});

test("F17b) executeMoveOut failures: permit POST lost → UNKNOWN; call-auth POST refused → nothing moved; a window closed → cancelled", async () => {
  for (const fail of [async (u, i) => (JSON.parse(i.body).kind === "eip3009" ? badRes(500) : okRes()), async (u, i) => { if (JSON.parse(i.body).kind === "eip3009") throw new Error("timeout"); return okRes(); }]) {
    const rig = moveOutRig({ fetchImpl: fail });
    const r = await MO.executeMoveOut(rig.o);
    assert.equal(r.unknown, true);
    assert.equal(r.message, "Not confirmed. Don't send it again.");
    assert.equal(r.validBefore, rig.o.review.validBefore);
    assert.equal(rig.reg.get(rig.rec.id).state, "unknown");
  }
  let posted = [];
  const rig = moveOutRig({ fetchImpl: async (u, i) => { posted.push(JSON.parse(i.body).kind); return JSON.parse(i.body).kind === "multicall-authorization" ? badRes(400) : okRes(); } });
  const r = await MO.executeMoveOut(rig.o);
  assert.deepEqual(posted, ["multicall-authorization"], "the permit is never posted after the call authorisation was refused");
  assert.equal(r.message, "Not sent. Nothing moved.");
  posted = [];
  let n = 0;
  const rig2 = moveOutRig({ signTypedData: async () => { n += 1; if (n === 2) throw new Error("User rejected the request"); return SIG; }, fetchImpl: async (u, i) => { posted.push(1); return okRes(); } });
  const r2 = await MO.executeMoveOut(rig2.o);
  assert.equal(r2.message, "Cancelled. Nothing moved.");
  assert.equal(posted.length, 0, "nothing is posted until every window is signed");
  /* Registry that cannot be written: the permit is never posted. */
  const storage = new MemStorage();
  const kinds = [];
  const rig3 = moveOutRig({ storage, fetchImpl: async (u, i) => { kinds.push(JSON.parse(i.body).kind); storage.drop = true; return okRes(); } });
  const r3 = await MO.executeMoveOut(rig3.o);
  assert.deepEqual(kinds, ["multicall-authorization"]);
  assert.equal(r3.code, "registry");
  /* A non-signature answer from the wallet is not posted. */
  const rig4 = moveOutRig({ review: moveOutReview(), signTypedData: async () => "0xdeadbeef" });
  assert.equal((await MO.executeMoveOut(rig4.o)).message, "Cancelled. Nothing moved.");
});

test("F18) a NEW permit only after validBefore has passed AND the chain says the old nonce is unused", () => {
  const vb = 1792044682;
  assert.equal(MO.permitReuseAllowed({ validBefore: vb, used: false, now: (vb + 1) * 1000 }), true);
  assert.equal(MO.permitReuseAllowed({ validBefore: vb, used: false, now: vb * 1000 }), false, "not yet past");
  assert.equal(MO.permitReuseAllowed({ validBefore: vb, used: true, now: (vb + 99) * 1000 }), false, "it was used: the money left");
  assert.equal(MO.permitReuseAllowed({ validBefore: vb, used: null, now: (vb + 99) * 1000 }), false, "unknown is never 'unused'");
  const call = MO.authorizationStateCall({ own: DEAD, nonce: `0x${"11".repeat(32)}` });
  assert.equal(call.to, PINS.AVAX_USDC);
  assert.equal(call.data.slice(0, 10), "0xe94a0102");
  assert.equal(MO.readAuthorizationState(`0x${"0".repeat(63)}1`), true);
  assert.equal(MO.readAuthorizationState(`0x${"0".repeat(64)}`), false);
  assert.equal(MO.readAuthorizationState("0x"), null);
  assert.equal(MO.authorizationStateCall({ own: DEAD, nonce: "0x12" }), null);
});

test("F19) the paid exit is REBUILT by the closed builder and byte-compared with the quote", () => {
  const q11 = load("relay-q11-back-plain.json").response;
  const r = MO.parsePaidExitQuote(q11, { own: ONE, amountRaw: "10000000" });
  assert.equal(r.route, "paid");
  assert.deepEqual(r.txs.map((t) => [t.purpose, t.to, t.data.slice(0, 10), t.value, t.gas]), [
    ["approve", PINS.AVAX_USDC, "0x095ea7b3", "0x0", 73112],
    ["deposit", PINS.AVAX_DEPOSITORY, "0xe8017952", "0x0", 77170],
  ]);
  assert.equal(r.receiveUsdc, "9.975998");
  const mut = (fn) => { const j = clone(q11); fn(j); return j; };
  const evil = [
    mut((j) => { j.steps[0].items[0].data.data = encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "approve", args: [PINS.AVAX_DEPOSITORY, maxUint256] }); }),
    mut((j) => { j.steps[0].items[0].data.data = encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "approve", args: [OTHER, 10000000n] }); }),
    mut((j) => { j.steps[1].items[0].data.data = encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "depositErc20", args: [OTHER, PINS.AVAX_USDC, 10000000n, j.protocol.v2.orderId] }); }),
    mut((j) => { j.steps[1].items[0].data.to = OTHER; }),
    mut((j) => { j.steps[1].items[0].data.value = "1"; }),
    mut((j) => { j.steps[1].items[0].data.data += "00"; }),
  ];
  for (const j of evil) throwsUnsafe(() => MO.parsePaidExitQuote(j, { own: ONE, amountRaw: "10000000" }));
  /* Allowance already there: deposit only. */
  const one = mut((j) => { j.steps = [j.steps[1]]; });
  assert.deepEqual(MO.parsePaidExitQuote(one, { own: ONE, amountRaw: "10000000" }).txs.map((t) => t.purpose), ["deposit"]);
});

/* ── rules that hold across every builder ─────────────────────────────────── */

test("F20) 🔴 no builder takes a recipient: a recipient passed in is ignored, every role is the user's own", () => {
  const bodies = [
    MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 5, recipient: OTHER, refundTo: OTHER }).body,
    MO.buildMoveOutQuoteBody({ own: DEAD, amountUsdc: 5, recipient: OTHER }),
    MO.buildPaidExitQuoteBody({ own: DEAD, amountUsdc: 5, recipient: OTHER }),
    GT.buildGasTopupQuoteBody({ own: DEAD, avaxWei: 10n ** 16n, recipient: OTHER }),
    SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "BTC.b", amountRaw: "2000000", recipient: OTHER }),
    SW.buildGasLegQuoteBody({ own: DEAD, topupUsd: 0.3, recipient: OTHER }),
  ];
  for (const b of bodies) {
    assert.equal(b.user, DEAD);
    assert.equal(b.recipient, DEAD);
    assert.equal(b.refundTo, DEAD);
    assert.ok(!JSON.stringify(b).toLowerCase().includes(OTHER.toLowerCase().slice(2)));
    for (const k of ["subsidizeFees", "maxSubsidizationAmount", "appFees", "referrer", "txs"]) assert.equal(b[k], undefined, k);
  }
  /* The builders' own parameter lists name no recipient (source check). */
  for (const fn of [MI.buildMoveInQuoteBody, MO.buildMoveOutQuoteBody, MO.buildPaidExitQuoteBody, GT.buildGasTopupQuoteBody, OM.buildOwnMoveQuoteBody, SW.buildSwapQuoteBody, SW.buildGasLegQuoteBody]) {
    const params = String(fn).slice(String(fn).indexOf("("), String(fn).indexOf(")") + 1);
    assert.doesNotMatch(params, /recipient|refundTo|onBehalf|receiver|spender/i, fn.name);
  }
});

test("F21) 🔴 every word these flows can put on a screen names no provider and no venue (W3's rule)", () => {
  const words = [...Object.values(OM.OWN_MOVE_WORDS), ...Object.values(MO.MOVE_OUT_WORDS), ...Object.values(SW.SWAP_WORDS)];
  const thrown = [];
  const grab = (fn) => { try { fn(); } catch (e) { thrown.push(e.message); } };
  grab(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 99 }));
  grab(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 5, topupUsd: 2 }));
  grab(() => moveInReview({ max: 6 }));
  grab(() => moveOutReview(MOVE_OUT.response, 0));
  grab(() => MO.parseMoveOutQuote(load("relay-q11-back-plain.json").response, { own: ONE, amountRaw: "10000000" }));
  grab(() => SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "PHAR", amountRaw: "1" }));
  assert.ok(thrown.length >= 6);
  for (const text of [...words, ...thrown]) {
    assert.doesNotMatch(text, /relay/i, text);
    assert.doesNotMatch(text, /hyperliquid|hyper ?core|\bHL\b|privy|magpie|\b0x\b/i, text);
    assert.doesNotMatch(text, /\bbridge\b|\btopup\b|gas top-?up|\bRPC\b|\bfree\b/i, text);
    assert.doesNotMatch(text, /try again/i, text);
  }
});
