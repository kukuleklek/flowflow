/**
 * test-avax-hardening — the guards that close scripts/test-avax-attack.mjs, tested on
 * their OTHER sides: what they still let through (the exit, a better re-quote, the
 * second stage of a plan), what they refuse that the attack file does not try, and the
 * cross-tab Web Lock path (an in-memory fake of navigator.locks).
 *
 * 🔴 MONEY SAFETY. Nothing here signs, sends or reaches a network. Every signer,
 * sender, fetch, lock and storage is an in-memory recorder; fixtures are the read-only
 * captures in scripts/fixtures/avax.
 *
 * Run: node --test scripts/test-avax-hardening.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFunctionData, parseAbi } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const SW = await imp("src/lib/relay/swap.js");
const SD = await imp("src/lib/avax/swapDecode.js");
const MO = await imp("src/lib/relay/moveOut.js");
const OM = await imp("src/lib/relay/ownMove.js");
const MI = await imp("src/lib/relay/moveIn.js");
const FL = await imp("src/avax/flows.js");
const GAS = await imp("src/lib/avax/gas.js");
const AT = await imp("src/lib/avax/aaveTx.js");
const PR = await imp("src/lib/avax/prices.js");
const RUN = await imp("src/lib/avax/run.js");
const PINS = await imp("src/lib/avax/relayPins.js");

const FIX = path.join(ROOT, "scripts/fixtures/avax");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

const DEAD = "0x000000000000000000000000000000000000dEaD";
const SIG = `0x${"ab".repeat(65)}`;
const GWEI = 10n ** 9n;
const HASH = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const TIMERS = { setTimeout: () => 0, clearTimeout: () => {} };
const okRes = (json = {}) => ({ ok: true, status: 200, json: async () => json });

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

/* An in-memory navigator.locks: one holder per name; ifAvailable answers null when held. */
class FakeLocks {
  constructor() { this.held = new Set(); this.requests = []; }
  request(name, opts, cb) {
    this.requests.push(name);
    if (this.held.has(name)) return Promise.resolve(cb(null));
    this.held.add(name);
    return Promise.resolve(cb({ name })).finally(() => this.held.delete(name));
  }
}

const LIVE_SWAP = load("live-swap-usdc-btcb-2.json");
const MOVE_IN = load("live-move-in-6-topup.json");
const MOVE_OUT = load("live-move-out-2.json");
const OUT_VB = MOVE_OUT.response.steps[0].items[0].data.sign.value.validBefore;
const OUT_NOW = (OUT_VB - 600) * 1000;

const parseLive = (json = LIVE_SWAP.response, now = LIVE_SWAP.capturedAt) => SD.parseSwapQuote(json, {
  own: LIVE_SWAP.body.user, from: LIVE_SWAP.body.originCurrency, to: LIVE_SWAP.body.destinationCurrency, amountRaw: LIVE_SWAP.body.amount, now,
});
const EXIT_FX = load("swap-q11-btcb-usdc.json");
const T_EXIT = 1792044000000;
const parseExit = () => SD.parseSwapQuote(EXIT_FX.response, {
  own: EXIT_FX.body.user, from: EXIT_FX.body.originCurrency, to: EXIT_FX.body.destinationCurrency, amountRaw: EXIT_FX.body.amount, now: T_EXIT,
});
const moveInReview = (json = MOVE_IN.response, extra = {}) => OM.parseOwnMoveQuote(json, {
  own: DEAD, dest: "usdc", amountRaw: "6000000", topupUsd: 0.3, maxDebitUsdc: MI.maxDebitUsdc(6, 0.3), now: MOVE_IN.capturedAt, ...extra,
});
const parseOut = (json = MOVE_OUT.response) => MO.parseMoveOutQuote(json, { own: DEAD, amountRaw: "2000000", now: OUT_NOW });

function confirmed({ kind, storage = new MemStorage(), now, amounts = null, maxDebit = null, locks = null }) {
  const reg = FL.createFlowRegistry({ storage, own: DEAD, now, locks });
  const rec = reg.begin({ kind, amounts, maxDebit });
  assert.equal(reg.confirm(rec.id).ok, true, "setup: confirmed");
  return { reg, rec, storage };
}
function swapRig({ review = parseLive(), maxFeePerGasWei = 11n * GWEI, amounts = null, locks = null, storage } = {}) {
  const t = { now: review.quotedAt + 1000 };
  const { reg, rec } = confirmed({ kind: "swap", now: () => t.now, amounts, locks, storage });
  const sends = [];
  let n = 0;
  const o = {
    review, ownNow: () => DEAD, maxFeePerGasWei, flow: reg.handle(rec.id), now: () => t.now, readPendingNonce: async () => 7,
    sendTx: async (tx) => { sends.push([tx.purpose, tx.maxFeePerGas]); n += 1; return HASH(n); },
    waitReceipt: async () => ({ status: 1 }),
    preflight: async () => ({ ok: true }),
  };
  return { o, reg, rec, sends, t };
}

/* ── the registry ─────────────────────────────────────────────────────────── */

test("H1) a stage runs once; a plan's NEXT stage may still run under the same Confirm; a settled flow runs nothing", () => {
  const { reg, rec } = confirmed({ kind: "swap", now: () => 5_000_000 });
  const h = reg.handle(rec.id);
  assert.throws(() => h.beforeWindow({ step: "approve" }), (e) => e.code === "not-claimed", "no window before a claim");
  h.claim("own-move");
  assert.throws(() => h.claim("own-move"), (e) => e.code === "already-run");
  h.beforeWindow({ requestId: `0x${"11".repeat(32)}` });
  h.update({ state: "arriving" });
  assert.equal(h.claim("swap").stages, "own-move,swap", "stage 2 of the same plan");
  assert.throws(() => reg.handle(rec.id).claim("swap"), (e) => e.code === "already-run", "a fresh handle does not reset it: the claim is stored");
  reg.finish(rec.id, "done", "receipt status 1");
  assert.throws(() => reg.handle(rec.id).claim("gas-leg"), (e) => e.code === "bad-state");
  /* review cannot run, another page cannot run it, a stage name is checked */
  const r2 = reg.begin({ kind: "swap" });
  assert.throws(() => reg.claim(r2.id, "swap"), (e) => e.code === "bad-state");
  assert.throws(() => reg.claim(r2.id, "NOT A STAGE"), (e) => e.code === "bad-stage");
});

test("H2) what the user confirmed is fixed: no patch may change amounts, maxDebit, kind, the claimed stages…", () => {
  const { reg, rec } = confirmed({ kind: "move-in", now: () => 5_000_000, amounts: { out: "6" }, maxDebit: 6.7 });
  for (const patch of [{ maxDebit: 99 }, { amounts: { out: "60" } }, { kind: "swap" }, { stages: "" }, { tabId: "tEvil" }, { envelopeHash: "x" }, { auto: true }]) {
    assert.throws(() => reg.beforeWindow(rec.id, patch), (e) => e.code === "bad-record", JSON.stringify(patch));
    assert.throws(() => reg.update(rec.id, patch), (e) => e.code === "bad-record", JSON.stringify(patch));
  }
  for (const state of ["review", "confirmed", "arriving", "done", "unknown"]) {
    assert.throws(() => reg.beforeWindow(rec.id, { state }), (e) => e.code === "bad-state", state);
  }
  const after = reg.get(rec.id);
  assert.equal(after.maxDebit, 6.7);
  assert.deepEqual(after.amounts, { out: "6" });
  assert.equal(after.state, "confirmed");
});

test("H3) cancel: the owner page still may (nothing moved); another page never may — its copy may be late", () => {
  const s = new MemStorage();
  const now = () => 5_000_000;
  const a = FL.createFlowRegistry({ storage: s, own: DEAD, now });
  const b = FL.createFlowRegistry({ storage: s, own: DEAD, now });
  const r = a.begin({ kind: "swap" });
  a.confirm(r.id);
  assert.throws(() => b.cancel(r.id, "x"), (e) => e.code === "not-owner");
  assert.equal(a.cancel(r.id, "user closed the window").state, "cancelled");
  /* a review card made elsewhere: another page's "review" may already be sending there */
  const r2 = a.begin({ kind: "swap" });
  assert.throws(() => b.cancel(r2.id, "stale"), (e) => e.code === "not-owner");
  /* a dead page's review settles by its TTL instead */
  const late = FL.createFlowRegistry({ storage: s, own: DEAD, now: () => 5_000_000 + FL.MONEY_CARD_TTL_MS });
  assert.equal(late.get(r2.id).state, "expired");
});

test("H4) the realm check sees a peer's late write only for a flow THIS storage knows and does not see settled", () => {
  /* Two unrelated browsers (separate storages) never block each other. */
  const one = confirmed({ kind: "swap", now: () => 7_000_000 });
  assert.equal(one.reg.get(one.rec.id).state, "confirmed");
  const other = FL.createFlowRegistry({ storage: new MemStorage(), own: DEAD, now: () => 7_000_000 });
  const x = other.begin({ kind: "move-out" });
  assert.equal(other.confirm(x.id).ok, true, "another storage: unrelated");
  /* Same storage, but this copy already sees the peer's flow settled: not a blocker. */
  const s = new MemStorage();
  const a = FL.createFlowRegistry({ storage: s, own: DEAD, now: () => 7_000_000 });
  const b = FL.createFlowRegistry({ storage: s, own: DEAD, now: () => 7_000_000 });
  const ra = a.begin({ kind: "swap" });
  a.confirm(ra.id);
  const rb = b.begin({ kind: "swap" });
  assert.equal(b.confirm(rb.id).code, "busy", "storage and peer agree: busy");
  a.cancel(ra.id, "user");
  assert.equal(b.confirm(rb.id).ok, true, "settled in storage: free");
});

test("H5) Web Locks: a held account lock refuses the run before any window, cancels only its own flow, and is released after a run", async () => {
  const locks = new FakeLocks();
  const rig = swapRig({ locks });
  const name = `${FL.FLOWS_KEY_PREFIX}lock:${FL.flowsKey(DEAD)}`;
  locks.held.add(name); /* another tab is mid-move */
  const r = await SW.executeSwap(rig.o);
  assert.equal(r.ok, false);
  assert.equal(r.code, "busy");
  assert.equal(r.message, SW.SWAP_WORDS.busy);
  assert.deepEqual(rig.sends, [], "no window while another tab holds the lock");
  assert.equal(rig.reg.get(rig.rec.id).state, "cancelled");
  locks.held.delete(name);
  /* free: it runs, and the lock is free again afterwards */
  const ok = swapRig({ locks });
  const r2 = await SW.executeSwap(ok.o);
  assert.equal(r2.ok, true);
  assert.equal(locks.held.size, 0, "released when the run ended");
  /* under the lock the registry is read again: another flow in flight refuses (storage caught up) */
  const s = new MemStorage();
  const t = { now: parseLive().quotedAt + 1000 };
  const reg = FL.createFlowRegistry({ storage: s, own: DEAD, now: () => t.now, locks: new FakeLocks() });
  const mine = reg.begin({ kind: "swap" });
  reg.confirm(mine.id);
  const theirs = { id: "fothertab01", kind: "move-out", state: "sending", startedAt: t.now, updatedAt: t.now, tabId: "tOther" };
  FL.writeFlows(s, DEAD, [...reg.list(), theirs]);
  const sends = [];
  const r3 = await SW.executeSwap({ ...swapRig().o, flow: reg.handle(mine.id), now: () => t.now, sendTx: async (tx) => { sends.push(tx.purpose); return HASH(1); } });
  assert.equal(r3.code, "busy");
  assert.deepEqual(sends, []);
});

test("H6) a refused second run leaves the first run's record exactly as it was", async () => {
  const rig = swapRig();
  assert.equal((await SW.executeSwap(rig.o)).ok, true);
  const before = JSON.stringify(rig.reg.get(rig.rec.id));
  const again = await SW.executeSwap(rig.o);
  assert.deepEqual([again.ok, again.code, again.untouched, again.state], [false, "already-run", true, null]);
  assert.equal(JSON.stringify(rig.reg.get(rig.rec.id)), before);
  assert.doesNotMatch(again.message, /relay|try again/i);
  /* A handle that is not the registry's is never run. */
  const r = await SW.executeSwap({ ...rig.o, flow: { beforeWindow: () => {} } });
  assert.equal(r.code, "registry");
  assert.deepEqual(RUN.claimRun(null, "swap"), { ok: false, code: "registry" });
});

/* ── swaps ────────────────────────────────────────────────────────────────── */

test("H7) the 12 gwei rule binds every swap but the EXIT (X → USDC), which signs at any fee", async () => {
  const exit = parseExit();
  assert.equal(SW.swapIsExit(exit), true);
  assert.equal(SW.swapIsExit(parseLive()), false);
  assert.equal(SW.swapTxRequests(parseLive(), { maxFeePerGasWei: 13n * GWEI }), null);
  assert.equal(SW.swapTxRequests(parseLive(), { maxFeePerGasWei: 12n * GWEI }).length, 2, "exactly 12 passes");
  const txs = SW.swapTxRequests(exit, { maxFeePerGasWei: 100n * GWEI, maxPriorityFeePerGasWei: 500n * GWEI });
  assert.ok(txs.length >= 1);
  for (const t of txs) {
    assert.equal(t.maxFeePerGas, `0x${(100n * GWEI).toString(16)}`);
    assert.equal(t.maxPriorityFeePerGas, `0x${GWEI.toString(16)}`, "the tip is capped at 1 gwei");
  }
  const rig = swapRig({ review: exit, maxFeePerGasWei: 100n * GWEI });
  rig.t.now = exit.quotedAt + 1000;
  const r = await SW.executeSwap(rig.o);
  assert.equal(r.ok, true, `${r.code} ${r.message}`);
  assert.ok(rig.sends.every(([, fee]) => fee === `0x${(100n * GWEI).toString(16)}`));
  /* the gas leg (USDC → AVAX) is not an exit */
  const leg = SW.parseGasLegQuote(load("relay-q-gasleg-usdc-avax-300000.json").response, { own: DEAD, topupUsd: 0.3, now: T_EXIT });
  assert.equal(SW.swapIsExit(leg), false);
  assert.equal(SW.swapTxRequests(leg, { maxFeePerGasWei: 25n * GWEI }), null);
});

test("H8) AD-9.3 at the executor: an EQUAL or BETTER re-quote signs under the same Confirm; worse in any printed way does not", async () => {
  const shown = parseLive();
  const env = SW.swapEnvelope(shown);
  assert.deepEqual({ ...env }, { from: "USDC", to: "BTC.b", amountRaw: "2000000", minOutRaw: shown.minOutRaw, gasUnits: 73112 + 561858, approve: true, feeSide: shown.fee.side, feeRaw: shown.fee.raw });
  assert.equal(SW.swapOutsideConfirmed(env, shown), null);
  const ok = swapRig({ amounts: env });
  assert.equal((await SW.executeSwap(ok.o)).ok, true);
  const cases = [
    [{ ...env, minOutRaw: String(BigInt(shown.minOutRaw) + 1n) }, "min-lower"],
    [{ ...env, amountRaw: "1999999" }, "different-swap"],
    [{ ...env, to: "WAVAX" }, "different-swap"],
    [{ ...env, gasUnits: 1000 }, "gas-higher"],
    [{ ...env, approve: false }, "extra-window"],
    [{ ...env, feeRaw: "0" }, "fee-higher"],
    [{ ...env, feeSide: null, feeRaw: null }, "fee-higher"],
    [{ ...env, minOutRaw: "not a number" }, "not-decodable"],
    [{ in: "2.5" }, "different-swap"],
    [{ min: "0.001" }, "min-lower"],
  ];
  for (const [amounts, why] of cases) {
    assert.equal(SW.swapOutsideConfirmed(amounts, shown), why, JSON.stringify(amounts));
    const rig = swapRig({ amounts });
    const r = await SW.executeSwap(rig.o);
    assert.deepEqual([r.ok, r.needsConfirm, r.why], [false, true, why]);
    assert.deepEqual(rig.sends, []);
    assert.equal(rig.reg.get(rig.rec.id).state, "cancelled", "the stale Confirm is released for the new card");
  }
});

test("H9) the loss cap: env may lower it, nothing unreadable can lift or remove it", () => {
  assert.equal(SW.swapLossCapPct(), 2);
  assert.equal(SW.swapLossCapPct(1), 1);
  assert.equal(SW.swapLossCapPct("0.5"), 0.5);
  assert.equal(SW.swapLossCapPct(9), 2);
  assert.equal(SW.swapLossCapPct("9"), 2);
  for (const bad of [NaN, "2%", "abc", undefined, null, Infinity, "", "1e3"]) assert.equal(SW.swapLossCapPct(bad), 2, String(bad));
  assert.equal(SW.swapLossCapPct(-1), 0, "a negative lowers to no loss at all");
  const r = parseLive();
  assert.equal(SW.swapLossCheck({ review: r, priceInUsd: 1, priceOutUsd: 81000, maxLossPct: NaN }).ok, true, "a fair swap still passes");
});

test("H10) a sale of a band asset is valued at the HIGHER price, a buy at the LOWER", () => {
  const relay = { XAUt0: 4100, USDC: 1 };
  const mids = { PAXG: "4000" };
  assert.equal(PR.independentPrice("XAUt0", { relay, mids }), 4000);
  assert.equal(PR.independentPrice("XAUt0", { relay, mids, side: "out" }), 4000);
  assert.equal(PR.independentPrice("XAUt0", { relay, mids, side: "in" }), 4100);
  /* buying XAUt0 for 4,000 USDC with a min of 0.98 oz: valued at 4,000 → 2 % */
  const buy = PR.swapLossPct({ from: "USDC", amountRaw: 4_000_000_000n, to: "XAUt0", minOutRaw: 980_000n, relay, mids });
  assert.ok(Math.abs(buy - 2) < 1e-9, String(buy));
  /* the hl-mid and peg assets are one price either way */
  assert.equal(PR.independentPrice("BTC.b", { relay, mids: { BTC: "80000" }, side: "in" }), 80000);
});

/* ── own moves ────────────────────────────────────────────────────────────── */

test("H11) executeOwnMove runs only under a recorded maxDebit, for the X the card printed", async () => {
  const run = async (opts) => {
    const t = { now: MOVE_IN.capturedAt + 1000 };
    const { reg, rec } = confirmed({ kind: "move-in", now: () => t.now, ...opts });
    let sent = 0;
    const r = await OM.executeOwnMove({
      review: moveInReview(), ownNow: () => DEAD, flow: reg.handle(rec.id), now: () => t.now, timers: TIMERS,
      signAuthorize: async () => ({ ok: true, signature: SIG }), fetchImpl: async () => okRes(),
      sendDeposit: async () => { sent += 1; return { ok: true }; },
    });
    return { r, sent, state: reg.get(rec.id).state };
  };
  let x = await run({ maxDebit: null });
  assert.deepEqual([x.r.code, x.sent, x.state], ["no-limit", 0, "error-before-money"], "unknown limit is never 'no limit'");
  x = await run({ maxDebit: 6.7, amounts: { out: "5" } });
  assert.deepEqual([x.r.code, x.sent], ["different-move", 0]);
  x = await run({ maxDebit: 6.7, amounts: { out: "6", topupUsd: 0.5 } });
  assert.deepEqual([x.r.code, x.sent], ["different-move", 0]);
  x = await run({ maxDebit: 6.7, amounts: { out: "6", topupUsd: null } });
  assert.deepEqual([x.r.code, x.sent], ["different-move", 0], "gas the card said it would not buy");
  x = await run({ maxDebit: 6.7, amounts: { out: "6", topupUsd: 0.3 } });
  assert.deepEqual([x.r.ok, x.sent, x.state], [true, 1, "arriving"]);
  for (const w of Object.values(OM.OWN_MOVE_WORDS)) assert.doesNotMatch(w, /relay|hyperliquid|try again/i, w);
});

test("H12) the gas top-up: valued at an independent AVAX price when given; without one, an implausible implied price is refused", () => {
  assert.equal(moveInReview().topup.raw, "31560061163398534");
  /* AVAX at $9.5: 0.03156 AVAX = $0.2998 — inside 0.5×–1.5× of $0.30 */
  assert.equal(moveInReview(MOVE_IN.response, { avaxUsd: 9.5 }).topup.usd, 0.3);
  /* the quote's own $ figure says 0.30, but at an independent $9.5 the AVAX is worth $0.0095 */
  const j = clone(MOVE_IN.response);
  j.details.currencyGasTopup.amount = "1000000000000000";
  j.details.currencyGasTopup.minimumAmount = "1000000000000000";
  assert.throws(() => moveInReview(j, { avaxUsd: 9.5 }), (e) => e.code === "unsafe-quote");
  /* without an independent price, the implied $300/AVAX still sits inside the sanity band — the card must pass avaxUsd */
  assert.equal(moveInReview(j).topup.raw, "1000000000000000");
  j.details.currencyGasTopup.amount = "10000000000000";
  j.details.currencyGasTopup.minimumAmount = "10000000000000";
  assert.throws(() => moveInReview(j), (e) => e.code === "unsafe-quote", "implied $30,000/AVAX");
});

test("H13) the per-move cap: env lowers it (0 = off), never raises it; the debit is held under it", () => {
  assert.equal(MI.resolveMoveCapUsdc(), 20);
  assert.equal(MI.resolveMoveCapUsdc(10), 10);
  assert.equal(MI.resolveMoveCapUsdc("15"), 15);
  assert.equal(MI.resolveMoveCapUsdc(50), 20);
  assert.equal(MI.resolveMoveCapUsdc(0), 0);
  assert.equal(MI.resolveMoveCapUsdc("0"), 0);
  assert.equal(MI.resolveMoveCapUsdc(-5), 0);
  for (const unset of [undefined, null, "", "abc", NaN]) assert.equal(MI.resolveMoveCapUsdc(unset), 20, String(unset));
  assert.equal(MI.maxDebitUsdc(20, 0.5), 20);
  assert.equal(MI.maxDebitUsdc(6, 0.3), 6.7, "below the cap: the plan's formula");
  assert.equal(MI.maxDebitUsdc(9, 0.3, 9.5), 9.5, "an env cap of 9.5 holds the debit too");
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 5, maxMoveUsdc: "0" }), (e) => e.code === "over-cap");
  assert.equal(MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 5, maxMoveUsdc: "abc" }).amountRaw, "5000000");
});

/* ── move-out ─────────────────────────────────────────────────────────────── */

const MCA_ABI = parseAbi(["function approve(address,uint256)", "function depositErc20(address,address,uint256,bytes32)", "function transfer(address,uint256)"]);
const mcaCall = (target, functionName, args) => ({ target, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: MCA_ABI, functionName, args }) });
function withMca(calls) {
  const j = clone(MOVE_OUT.response);
  const item = j.steps[0].items[0];
  item.data.sign.value.to = PINS.RELAY_V32.approvalProxy;
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
          calls: calls(j.protocol.v2.orderId),
          funding: [{ token: PINS.AVAX_USDC, from: DEAD, value: "2000000", validAfter: 0, validBefore: OUT_VB }],
        },
      },
      post: { endpoint: "/execute/permits", method: "POST", body: { kind: "multicall-authorization", requestId: j.requestId, api: "swap" } },
    },
  };
  j.steps[0].items = [mca, item];
  return j;
}
const X = 2000000n;
const approve = (spender = PINS.AVAX_DEPOSITORY, amt = X) => mcaCall(PINS.AVAX_USDC, "approve", [spender, amt]);
const deposit = (id, amt = X) => mcaCall(PINS.AVAX_DEPOSITORY, "depositErc20", [DEAD, PINS.AVAX_USDC, amt, id]);

test("H14) the MulticallAuthorization may pin only [approve(depository, X)]? + depositErc20(own, USDC, X, this order)", () => {
  assert.equal(parseOut(withMca((id) => [approve(), deposit(id)])).signatureCount, 2);
  assert.equal(parseOut(withMca((id) => [deposit(id)])).signatureCount, 2, "allowance already in place");
  const bad = [
    [(id) => [approve(PINS.RELAY_V32.router), deposit(id)], /not for this deposit/],
    [(id) => [approve(PINS.AVAX_DEPOSITORY, X + 1n), deposit(id)], /another amount/],
    [(id) => [approve(PINS.AVAX_DEPOSITORY, X - 1n), deposit(id)], /another amount/],
    [(id) => [deposit(id), approve()], /not the last call/],
    [(id) => [deposit(id, X - 1n)], /another amount/],
    [(id) => [deposit(id), deposit(id)], /not the last call/],
    [(id) => [approve(), deposit(id), mcaCall(PINS.AVAX_USDC, "transfer", [PINS.AVAX_DEPOSITORY, 1n])], /not a deposit/],
    [() => [approve()], /not for this deposit/],
    [() => [mcaCall(PINS.AVAX_USDC, "transfer", [PINS.RELAY_V32.router, X])], /outside this order/],
  ];
  for (const [calls, re] of bad) assert.throws(() => parseOut(withMca(calls)), (e) => e.code === "unsafe-quote" && re.test(e.message), String(re));
  /* the lone permit to v3 (today) still reads; to v3.2 it never does */
  assert.equal(parseOut().signatureCount, 1);
});

test("H15) executeMoveOut is bound to the amount confirmed (×1.001 for 'all'), and posts only on a live price", async () => {
  const review = parseOut();
  const runOut = async ({ amounts = null, maxDebit = null, signDelayMs = 0, postDelayMs = 0 } = {}) => {
    const t = { now: OUT_NOW + 1000 };
    const { reg, rec } = confirmed({ kind: "move-out", now: () => t.now, amounts, maxDebit });
    const posted = [];
    const r = await MO.executeMoveOut({
      review, ownNow: () => DEAD, flow: reg.handle(rec.id), now: () => t.now, timers: TIMERS,
      signTypedData: async () => { t.now += signDelayMs; return SIG; },
      fetchImpl: async (u, init) => { posted.push(JSON.parse(init.body).kind); t.now += postDelayMs; return okRes(); },
    });
    return { r, posted, state: reg.get(rec.id).state };
  };
  assert.deepEqual((await runOut({ amounts: { in: "2" } })).posted, ["eip3009"]);
  assert.deepEqual((await runOut({ amounts: { in: "1.999" } })).posted, ["eip3009"], "within ×1.001 (unstake all, interest)");
  let x = await runOut({ amounts: { in: "1.99" } });
  assert.deepEqual([x.r.code, x.posted, x.state], ["over-confirmed", [], "cancelled"]);
  x = await runOut({ maxDebit: 1.5 });
  assert.deepEqual([x.r.code, x.posted], ["over-confirmed", []]);
  x = await runOut({ amounts: { amountRaw: "garbage" } });
  assert.deepEqual([x.r.code, x.posted], ["not-decodable", []]);
  x = await runOut({ signDelayMs: 58_000 });
  assert.deepEqual([x.r.ok, x.posted], [true, ["eip3009"]], "59 s after the quote: posted");
  x = await runOut({ signDelayMs: 59_000 });
  assert.deepEqual([x.r.message, x.posted], [MO.MOVE_OUT_WORDS.expired, []], "60 s after the quote: expired");
  /* two signatures: the call authorisation posted, then the price dies before the money POST */
  const two = MO.parseMoveOutQuote(withMca((id) => [approve(), deposit(id)]), { own: DEAD, amountRaw: "2000000", now: OUT_NOW });
  const t = { now: OUT_NOW + 1000 };
  const { reg, rec } = confirmed({ kind: "move-out", now: () => t.now });
  const posted = [];
  const r = await MO.executeMoveOut({
    review: two, ownNow: () => DEAD, flow: reg.handle(rec.id), now: () => t.now, timers: TIMERS,
    signTypedData: async () => SIG,
    fetchImpl: async (u, init) => { posted.push(JSON.parse(init.body).kind); t.now += 61_000; return okRes(); },
  });
  assert.deepEqual([r.message, posted, reg.get(rec.id).state], [MO.MOVE_OUT_WORDS.expired, ["multicall-authorization"], "cancelled"]);
});

/* ── gas and Aave ─────────────────────────────────────────────────────────── */

test("H16) gasCheck: the gas leg obeys the 12 gwei rule too; only 'exit' and 'gas-leg' are special", () => {
  const leg = GAS.gasCheck({ avaxWei: 10n ** 18n, gasLimits: [527303n], maxFeePerGas: 13n * GWEI, kind: "gas-leg" });
  assert.deepEqual([leg.ok, leg.why], [false, GAS.GAS_WHY.feeHigh]);
  assert.equal(GAS.gasCheck({ avaxWei: 10n ** 18n, gasLimits: [260000n], maxFeePerGas: 100n * GWEI, kind: "exit" }).ok, true);
  assert.equal(GAS.gasCheck({ avaxWei: 10n ** 18n, gasLimits: [260000n], maxFeePerGas: 100n * GWEI, kind: "EXIT" }).why, GAS.GAS_WHY.feeHigh, "a typo is normal, not an exit");
  assert.equal(GAS.gasCheck({ avaxWei: 10n ** 18n, gasLimits: [260000n], maxFeePerGas: 11n * GWEI, reserveAfterWei: null }).why, GAS.GAS_WHY.loading);
});

test("H17) Aave builders: the tip is at most the 1 gwei gas.js sets, on exits too; the fee level itself is still free for exits", () => {
  const fees = (tip, max = 50n * GWEI) => ({ maxFeePerGas: max, maxPriorityFeePerGas: tip });
  assert.ok(AT.buildWithdrawTx({ own: DEAD, amountRaw: 1_000_000n, fees: fees(GWEI) }));
  assert.ok(AT.buildWithdrawTx({ own: DEAD, amountRaw: 1_000_000n, fees: fees(0n) }));
  assert.throws(() => AT.buildWithdrawTx({ own: DEAD, amountRaw: 1_000_000n, fees: fees(GWEI + 1n) }), (e) => e.code === "bad-fees");
  assert.throws(() => AT.buildRemoveAllowanceTx({ own: DEAD, fees: fees(2n * GWEI) }), (e) => e.code === "bad-fees");
  assert.throws(() => AT.buildSupplyTx({ own: DEAD, amountRaw: 1_000_000n, fees: fees(2n * GWEI, 11n * GWEI) }), (e) => e.code === "bad-fees");
});
