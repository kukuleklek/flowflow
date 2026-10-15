/**
 * test-avax-attack — MONEY-SAFETY ATTACK on the Avax account's money layer (plan v2
 * TRACK B, pre-gate). Every ATK-* test below is written to FAIL on the code as
 * delivered: each one is a way the user's money could leave, be lost, or be spent
 * without the Confirm / the guard the plan promises. A test turns green only when the
 * hole is closed. The HELD-* tests at the end are attacks that were tried and HELD
 * (kept so the suite proves it).
 *
 * Severity is in each name: [HIGH] money can go to someone else or the main guard
 * fails open · [MED] a guard the plan promises is missing at the boundary that
 * matters · [LOW] hardening / small sums / needs an unlikely caller.
 *
 * 🔴 MONEY SAFETY. Nothing here signs, sends or reaches a network. Every signer,
 * sender, fetch and storage is an in-memory recorder; fixtures are the read-only
 * captures in scripts/fixtures/avax.
 *
 * Run: node --test scripts/test-avax-attack.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";

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
const WL = await imp("src/lib/avax/whitelist.js");
const PINS = await imp("src/lib/avax/relayPins.js");

const FIX = path.join(ROOT, "scripts/fixtures/avax");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

const DEAD = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SIG = `0x${"ab".repeat(65)}`;
const GWEI = 10n ** 9n;
const HASH = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const TIMERS = { setTimeout: () => 0, clearTimeout: () => {} };
const okRes = (json = {}) => ({ ok: true, status: 200, json: async () => json });
const refusedWith = (fn, msg) => assert.throws(fn, (e) => e && typeof e.code === "string", msg);

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const LIVE_SWAP = load("live-swap-usdc-btcb-2.json");
const MOVE_IN = load("live-move-in-6-topup.json");
const MOVE_OUT = load("live-move-out-2.json");
const OUT_VB = MOVE_OUT.response.steps[0].items[0].data.sign.value.validBefore;
const OUT_NOW = (OUT_VB - 600) * 1000;

const parseLive = (json = LIVE_SWAP.response, now = LIVE_SWAP.capturedAt) => SD.parseSwapQuote(json, {
  own: LIVE_SWAP.body.user, from: LIVE_SWAP.body.originCurrency, to: LIVE_SWAP.body.destinationCurrency, amountRaw: LIVE_SWAP.body.amount, now,
});
const moveInReview = (json = MOVE_IN.response) => OM.parseOwnMoveQuote(json, {
  own: DEAD, dest: "usdc", amountRaw: "6000000", topupUsd: 0.3, maxDebitUsdc: MI.maxDebitUsdc(6, 0.3), now: MOVE_IN.capturedAt,
});

/* Rebuild the live swap's calldata after changing the Settler's minAmountOut (keeps Relay's requestId suffix). */
function liveSwapWithMin(min) {
  const j = clone(LIVE_SWAP.response);
  const it = j.steps.find((s) => s.id === "swap").items[0].data;
  const d = decodeFunctionData({ abi: SD.SWAP_ABI, data: it.data });
  const args = [...d.args];
  const calls = args[2].map((c) => ({ ...c }));
  const ex = decodeFunctionData({ abi: SD.SWAP_ABI, data: calls[2].callData });
  const inner = decodeFunctionData({ abi: SD.SWAP_ABI, data: ex.args[4] });
  const settle = encodeFunctionData({ abi: SD.SWAP_ABI, functionName: "execute", args: [{ ...inner.args[0], minAmountOut: min }, inner.args[1], inner.args[2]] });
  calls[2] = { ...calls[2], callData: encodeFunctionData({ abi: SD.SWAP_ABI, functionName: "exec", args: [ex.args[0], ex.args[1], ex.args[2], ex.args[3], settle] }) };
  args[2] = calls;
  it.data = encodeFunctionData({ abi: SD.SWAP_ABI, functionName: "transferAndMulticall", args }) + j.requestId.slice(2);
  j.details.currencyOut.minimumAmount = String(min);
  return j;
}

/* The 2026-10-26 move-out shape (Relay docs, gasless-swaps): MulticallAuthorization, then EIP-3009.
   `calls(j)` returns the calls the MulticallAuthorization pins. */
const MCA_ABI = parseAbi(["function approve(address,uint256)", "function depositErc20(address,address,uint256,bytes32)", "function transfer(address,uint256)"]);
const mcaCall = (target, functionName, args) => ({ target, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: MCA_ABI, functionName, args }) });
function moveOutWithMca(calls) {
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
          calls: calls(j),
          funding: [{ token: PINS.AVAX_USDC, from: DEAD, value: "2000000", validAfter: 0, validBefore: OUT_VB }],
        },
      },
      post: { endpoint: "/execute/permits", method: "POST", body: { kind: "multicall-authorization", requestId: j.requestId, api: "swap" } },
    },
  };
  j.steps[0].items = [mca, item];
  return j;
}
const parseOut = (json) => MO.parseMoveOutQuote(json, { own: DEAD, amountRaw: "2000000", now: OUT_NOW });

/* A confirmed flow in a fresh registry, and an executeSwap rig around it. */
function confirmedFlow({ kind, storage = new MemStorage(), now, amounts = null, maxDebit = null, own = DEAD }) {
  const reg = FL.createFlowRegistry({ storage, own, now });
  const rec = reg.begin({ kind, amounts, maxDebit });
  assert.equal(reg.confirm(rec.id).ok, true, "setup: the card is confirmed");
  return { reg, rec };
}
function swapRig({ review = parseLive(), maxFeePerGasWei = 11n * GWEI, readPendingNonce = async () => 7, amounts = null } = {}) {
  const t = { now: review.quotedAt + 1000 };
  const { reg, rec } = confirmedFlow({ kind: "swap", now: () => t.now, amounts });
  const sends = [];
  let n = 0;
  const o = {
    review, ownNow: () => DEAD, maxFeePerGasWei, flow: reg.handle(rec.id), now: () => t.now, readPendingNonce,
    sendTx: async (tx) => { sends.push(tx.purpose); n += 1; return HASH(n); },
    waitReceipt: async () => ({ status: 1 }),
    preflight: async () => ({ ok: true }),
  };
  return { o, reg, rec, sends, t };
}

/* ═════════════════════════════════════════════════════════════════════════
   [HIGH]
   ═════════════════════════════════════════════════════════════════════════ */

test("ATK-01a [HIGH] move-out MulticallAuthorization: a depositErc20 into ANOTHER order's id is refused (it funds someone else's order)", () => {
  /* The quote's orderData pays the user's own Perp account — but the calls the user
     signs deposit the USDC under a different order id, so the solver fills THAT order
     (whose recipient the parser never saw). checkMcaCalls checks depositor/token/amount,
     never args[3] (the id). moveOut.js:214-216. */
  const ATTACKER_ORDER = `0x${"66".repeat(32)}`;
  const j = moveOutWithMca(() => [
    mcaCall(PINS.AVAX_USDC, "approve", [PINS.AVAX_DEPOSITORY, 2000000n]),
    mcaCall(PINS.AVAX_DEPOSITORY, "depositErc20", [DEAD, PINS.AVAX_USDC, 2000000n, ATTACKER_ORDER]),
  ]);
  assert.notEqual(j.protocol.v2.orderId, ATTACKER_ORDER);
  refusedWith(() => parseOut(j), "a MulticallAuthorization whose deposit id is not this quote's orderId must be refused before any window");
});

test("ATK-01b [HIGH] move-out MulticallAuthorization: calls with NO deposit for this order (a bare transfer to the depository) are refused", () => {
  /* transfer(depository, X) moves the user's USDC with no order attached: nothing pays
     the Perp account. checkMcaCalls accepts any mix of approve/transfer/depositErc20
     and never requires the one deposit of exactly X for this order. moveOut.js:201-221. */
  const j = moveOutWithMca(() => [mcaCall(PINS.AVAX_USDC, "transfer", [PINS.AVAX_DEPOSITORY, 2000000n])]);
  refusedWith(() => parseOut(j), "the pinned calls must contain exactly one depositErc20(own, USDC, X, orderId)");
  const dust = moveOutWithMca((jj) => [
    mcaCall(PINS.AVAX_USDC, "approve", [PINS.AVAX_DEPOSITORY, 2000000n]),
    mcaCall(PINS.AVAX_DEPOSITORY, "depositErc20", [DEAD, PINS.AVAX_USDC, 1n, jj.protocol.v2.orderId]),
  ]);
  refusedWith(() => parseOut(dust), "a deposit of 1 unit against a 2 USDC order must be refused");
});

test("ATK-02 [HIGH] swap loss bound: a maxLossPct that is not a number (NaN, '2%', an unset env read) must NOT switch the bound off", () => {
  /* swap.js:155-156: cap = Math.min(Number(maxLossPct), 2) → NaN, and `lossPct > NaN` is
     false → { ok: true }. A caller doing Number(import.meta.env.VITE_SWAP_MAX_LOSS_PCT)
     with the variable unset accepts ANY loss. Here: 2 USDC for 0.00002456 BTC.b with
     BTC at $1,000 = a 98.8 % loss, approved. */
  const r = parseLive();
  for (const bad of [NaN, "2%", "abc", Number(undefined)]) {
    const out = SW.swapLossCheck({ review: r, priceInUsd: 1, priceOutUsd: 1000, maxLossPct: bad });
    assert.equal(out.ok, false, `maxLossPct=${String(bad)} accepted a ${out.lossPct && out.lossPct.toFixed(1)} % loss`);
  }
});

/* ═════════════════════════════════════════════════════════════════════════
   [MED]
   ═════════════════════════════════════════════════════════════════════════ */

test("ATK-03 [MED] the same confirmed swap can open its money windows TWICE (executor re-run / double effect) — the registry must refuse", async () => {
  /* flows.js:360-373 beforeWindow accepts a record already in "sending"/"arriving"
     for the SAME step, so a second executeSwap with the same handle (React StrictMode
     double effect, a retry, Autopilot + a tap) sends approve + swap again. The approve
     OVERWRITES the allowance back to X, so the second swap pulls X again. */
  const rig = swapRig();
  const first = await SW.executeSwap(rig.o);
  assert.equal(first.ok, true, "setup: the first run swaps");
  assert.deepEqual(rig.sends, ["approve", "swap"]);
  await SW.executeSwap(rig.o);
  assert.deepEqual(rig.sends, ["approve", "swap"], "a flow that already swapped must never open another window");
});

test("ATK-03b [MED] two concurrent runs of the same confirmed swap each send approve + swap", async () => {
  const rig = swapRig();
  await Promise.all([SW.executeSwap(rig.o), SW.executeSwap(rig.o)]);
  assert.equal(rig.sends.filter((s) => s === "swap").length, 1, `swap windows opened: ${rig.sends.join(", ")}`);
});

test("ATK-04a [MED] executeOwnMove takes more from the Perp account than the confirmed card's maxDebit", async () => {
  /* The registry records maxDebit (plan §3.7) but no executor reads it: the handle has no
     get(), and executeOwnMove trusts whatever review it is given. Card confirmed at
     maxDebit 6.10; the review handed in debits 6.342288 — sent. ownMove.js:307-366. */
  const t = { now: MOVE_IN.capturedAt + 1000 };
  const { reg, rec } = confirmedFlow({ kind: "move-in", now: () => t.now, maxDebit: 6.1 });
  let sent = 0;
  const r = await OM.executeOwnMove({
    review: moveInReview(), ownNow: () => DEAD, flow: reg.handle(rec.id), now: () => t.now, timers: TIMERS,
    signAuthorize: async () => ({ ok: true, signature: SIG }), fetchImpl: async () => okRes(),
    sendDeposit: async () => { sent += 1; return { ok: true }; },
  });
  assert.equal(moveInReview().amountIn > 6.1, true, "setup: the review debits more than the card allowed");
  assert.equal(sent, 0, `sendAsset of ${moveInReview().amountIn} USDC opened under a Confirm for at most 6.10 (result ok=${r.ok})`);
});

test("ATK-04b [MED] AD-9.3: a WORSE re-quote handed straight to executeSwap is signed — the executor never compares with what was confirmed", async () => {
  /* compareRequote() is correct, but nothing forces it: executeSwap signs any fresh
     review. The flow was confirmed for min 0.00002456 BTC.b; the executor signs a review
     with min 0.00002000 BTC.b. swap.js:281-303. */
  const shown = parseLive();
  const worse = parseLive(liveSwapWithMin(2000n));
  assert.equal(SW.compareRequote(shown, worse).why, "min-lower", "setup: the rule itself says no");
  const rig = swapRig({ review: worse, amounts: { minOutRaw: shown.minOutRaw } });
  await SW.executeSwap(rig.o);
  assert.deepEqual(rig.sends, [], "a re-quote worse than the confirmed card must come back as a card, never reach a window");
});

test("ATK-05 [MED] move-out: a LONE EIP-3009 to the v3.2 ApprovalProxy (no MulticallAuthorization) is refused", () => {
  /* On v3.2 the EIP-3009 nonce is derived from the MulticallAuthorization (Relay docs,
     gasless-swaps). A lone permit to v3.2 signs a nonce that commits to calls the user
     never saw. moveOut.js:256-268 accepts `to` ∈ {v3, v3.2}; :301 only checks the
     two-item case. */
  const j = clone(MOVE_OUT.response);
  j.steps[0].items[0].data.sign.value.to = PINS.RELAY_V32.approvalProxy;
  refusedWith(() => parseOut(j), "a v3.2 permit without its MulticallAuthorization must be refused");
});

test("ATK-06 [MED] the exit reserve cannot pay for the exit once fees rise: Aave withdraw / paid exit refused with the reserve intact", () => {
  /* gas.js:56-61 sizes the reserve at gasLimit × 12 gwei, but exits sign at
     maxFee = 2 × base + 1 gwei with no cap (feeFields exit:true) and the up-front check
     needs gasLimit × maxFee. Base 12 gwei → withdraw needs 0.0065 > 0.006; base 7 gwei →
     the paid exit (withdraw + approve + deposit) needs 0.0066 > 0.006. A fee spike is
     when people exit, and the money in Aave has no other way out. */
  const reserve = GAS.exitReserveWei(0);
  const at = (baseGwei) => GAS.feeFields(BigInt(baseGwei) * GWEI, { exit: true }).maxFeePerGas;
  const withdraw = GAS.gasCheck({ avaxWei: reserve, gasLimits: [GAS.GAS_LIMITS.withdraw], maxFeePerGas: at(12), kind: "exit" });
  assert.equal(withdraw.ok, true, `Aave withdraw at base 12 gwei: ${withdraw.why}`);
  const paid = GAS.gasCheck({ avaxWei: reserve, gasLimits: [GAS.GAS_LIMITS.withdraw, GAS.GAS_LIMITS.exitApprove, GAS.GAS_LIMITS.exitDeposit], maxFeePerGas: at(7), kind: "exit" });
  assert.equal(paid.ok, true, `paid exit at base 7 gwei: ${paid.why}`);
});

test("ATK-07a [MED] a NON-exit swap (USDC → BTC.b) is sent at 100 gwei — the 12 gwei rule (plan §2.9 / §3.4) is not enforced on swaps", async () => {
  /* swapTxRequests (swap.js:208-226) accepts any cap > 0; executeSwap never calls
     feeFields/gasCheck. Aave non-exits refuse above 12 gwei (aaveTx.js:68); swaps do not. */
  const rig = swapRig({ maxFeePerGasWei: 100n * GWEI });
  const r = await SW.executeSwap(rig.o);
  assert.deepEqual(rig.sends, [], `USDC → BTC.b at 100 gwei: ok=${r.ok}, windows ${rig.sends.join(", ")}`);
});

test("ATK-07b [MED] gasCheck FAILS OPEN for a kind it does not know: no reserve kept, no fee cap", () => {
  /* gas.js:166-169: only kind === "normal" keeps the reserve and the 12 gwei cap; "swap",
     "stake", "non-exit", a typo… all get the exit treatment. */
  for (const kind of ["swap", "stake", "non-exit", "Normal"]) {
    const g = GAS.gasCheck({ avaxWei: 10n ** 16n, gasLimits: [1_000_000n], maxFeePerGas: 9n * GWEI, kind });
    assert.equal(g.ok && g.needWei === 9n * 10n ** 15n, false, `kind "${kind}" kept no reserve after the tx (need ${g.needWei})`);
  }
});

/* ═════════════════════════════════════════════════════════════════════════
   [LOW]
   ═════════════════════════════════════════════════════════════════════════ */

test("ATK-08 [LOW] selling XAUt0: the 'independent' price takes the LOWER of Relay / PAXG on the input side too, so the loss is understated", () => {
  /* prices.js:127-134 "the lower of the two, so a loss is never understated" — true only
     for what you BUY. For what you SELL the conservative price is the higher one. Sell 1
     XAUt0 (Relay 4,100 / PAXG 4,000, inside the 3 % band) for min 3,950 USDC: computed
     1.25 %, real 3.66 % against Relay's own price → the 2 % cap is passed. */
  const loss = PR.swapLossPct({ from: "XAUt0", amountRaw: 1_000_000n, to: "USDC", minOutRaw: 3_950_000_000n, relay: { XAUt0: 4100, USDC: 1 }, mids: { PAXG: "4000" } });
  assert.ok(loss > 2, `loss read as ${loss.toFixed(2)} % — a sale is valued at the lower price`);
});

test("ATK-09 [LOW] move-out: the permit that moves money is POSTed 5 minutes after the quote (plan §3.6: > 60 s before money moves = 'Price expired')", async () => {
  /* executeMoveOut checks freshness only BEFORE the signing windows (moveOut.js:385-387);
     after them it checks validBefore − 30 s only (:404). executeOwnMove re-checks the TTL
     right before its money window (ownMove.js:331); the exit does not. */
  const review = parseOut(MOVE_OUT.response);
  const t = { now: OUT_NOW + 1000 };
  const { reg, rec } = confirmedFlow({ kind: "move-out", now: () => t.now });
  const posted = [];
  const r = await MO.executeMoveOut({
    review, ownNow: () => DEAD, flow: reg.handle(rec.id), now: () => t.now, timers: TIMERS,
    signTypedData: async () => { t.now += 300_000; return SIG; },
    fetchImpl: async (u, init) => { posted.push(JSON.parse(init.body).kind); return okRes(); },
  });
  assert.deepEqual(posted, [], `posted ${posted.join(", ")} on a 5-minute-old price (ok=${r.ok})`);
});

test("ATK-10a [LOW] registry: another tab can CANCEL a flow whose money window is open — the lock drops and a second move can start", () => {
  /* flows.js:393-400 cancel() has no owner check for "confirmed"/"sending" (beforeWindow
     and update do). Tab B, open before A sent, cancels A's "sending" record. */
  const s = new MemStorage();
  const now = () => 5_000_000;
  const a = FL.createFlowRegistry({ storage: s, own: DEAD, now });
  const b = FL.createFlowRegistry({ storage: s, own: DEAD, now });
  const rec = a.begin({ kind: "swap" });
  a.confirm(rec.id);
  a.beforeWindow(rec.id, { step: "swap" });
  assert.throws(() => b.cancel(rec.id, "stale card"), (e) => e && e.code === "not-owner", "only the page running the move may call it nothing");
});

test("ATK-10b [LOW] registry: beforeWindow({ state: 'review' }) puts a confirmed flow back to review — and Confirm comes back", () => {
  /* flows.js:368 takes patch.state as given; update() limits it, beforeWindow does not. */
  const a = FL.createFlowRegistry({ storage: new MemStorage(), own: DEAD, now: () => 5_000_000 });
  const rec = a.begin({ kind: "swap" });
  a.confirm(rec.id);
  let threw = false;
  try { a.beforeWindow(rec.id, { state: "review" }); } catch { threw = true; }
  assert.equal(threw || !a.view(a.get(rec.id)).confirmable, true, "a confirmed move must never show Confirm again");
});

test("ATK-11 [LOW] two tabs: each tab's localStorage view lags the other's writes, and both Confirm gates pass (two moves in flight)", () => {
  /* Chrome and Firefox keep a per-process copy of localStorage that other processes'
     writes reach asynchronously. confirm() is read → check lock → write → read back on
     THIS tab's copy (flows.js:271-280, 337-352), so two tabs inside that window both
     pass. Web Locks (navigator.locks) or a BroadcastChannel claim would close it. */
  const backing = new Map();
  const tabs = [];
  class TabStorage {
    constructor() { this.cache = new Map(backing); this.queue = []; tabs.push(this); }
    getItem(k) { return this.cache.has(k) ? this.cache.get(k) : null; }
    setItem(k, v) { this.cache.set(k, String(v)); this.queue.push([k, String(v)]); }
    removeItem(k) { this.cache.delete(k); this.queue.push([k, null]); }
    flush() {
      for (const [k, v] of this.queue) { if (v == null) backing.delete(k); else backing.set(k, v); }
      this.queue = [];
      for (const t of tabs) t.cache = new Map(backing);
    }
  }
  const sa = new TabStorage();
  const sb = new TabStorage();
  const now = () => 7_000_000;
  const a = FL.createFlowRegistry({ storage: sa, own: DEAD, now });
  const b = FL.createFlowRegistry({ storage: sb, own: DEAD, now });
  const ra = a.begin({ kind: "swap" }); sa.flush();
  const rb = b.begin({ kind: "move-out" }); sb.flush();
  const ca = a.confirm(ra.id);
  const cb = b.confirm(rb.id);
  assert.equal(ca.ok && cb.ok, false, "two money flows confirmed at once across tabs");
});

test("ATK-12 [LOW] gas top-up: a quote that delivers 1 wei of AVAX for the $0.30 the user pays is accepted", () => {
  /* ownMove.js:239-247 bounds the top-up by the quote's OWN amountUsd (0.5×–1.5× of the
     $ asked) and never the AVAX amount; the card then prints "<0.0001 AVAX ($0.30)". */
  const j = clone(MOVE_IN.response);
  j.details.currencyGasTopup.amount = "1";
  j.details.currencyGasTopup.minimumAmount = "1";
  refusedWith(() => moveInReview(j), "1 wei of AVAX is not $0.30 of gas");
});

test("ATK-13a [LOW] move-in: the debit from Perp may exceed the 20 USDC per-move cap (plan §2.9 / §3.5 'debit ≤ MAX_MOVE_USDC')", () => {
  /* moveIn.js:74-76 caps X (what arrives); maxDebitUsdc(20, 0.5) = 21.15 is what
     parseOwnMoveQuote then allows to leave the Perp account. */
  assert.ok(MI.maxDebitUsdc(20, 0.5) <= MI.HARD_MAX_MOVE_USDC, `maxDebit for X = 20 is ${MI.maxDebitUsdc(20, 0.5)}`);
});

test("ATK-13b [LOW] move-in: an env cap of 0 ('moves off') becomes the 20 USDC hard cap", () => {
  /* moveIn.js:74: Math.min(Number(0) || 20, 20) = 20. "Env may lower it, never raise it." */
  assert.throws(() => MI.buildMoveInQuoteBody({ own: DEAD, amountUsdc: 20, maxMoveUsdc: 0 }), (e) => e && e.code === "over-cap");
});

test("ATK-14 [LOW] unknown is not 0: swapBackCount(no account read) answers 0, so the exit reserve forgets every non-USDC asset", () => {
  /* gas.js:117 `(account && account.assets) || []`. An unreadable account must be null
     ("Still loading"), not "holds nothing to swap back". */
  assert.notEqual(GAS.swapBackCount(null), 0);
  assert.notEqual(GAS.swapBackCount({}), 0);
});

test("ATK-15 [LOW] exits accept any priority fee: an Aave withdraw tipping 500 gwei passes the closed builder (burns the AVAX reserve)", () => {
  /* aaveTx.js:62-69 caps maxFeePerGas only for non-exits and never caps the tip;
     decodeAaveTx (:189) rebuilds with the request's own fees. gas.js sets the tip at 1 gwei. */
  const fees = { maxFeePerGas: 500n * GWEI, maxPriorityFeePerGas: 500n * GWEI };
  refusedWith(() => AT.buildWithdrawTx({ own: DEAD, amountRaw: 1_000_000n, fees }), "the builder must not set a 500 gwei tip");
  const ok = AT.buildWithdrawTx({ own: DEAD, amountRaw: 1_000_000n, fees: GAS.feeFields(5n * GWEI, { exit: true }) });
  refusedWith(() => AT.decodeAaveTx({ ...ok, maxFeePerGas: "0x746a528800", maxPriorityFeePerGas: "0x746a528800" }, DEAD), "the closed builder must refuse a 500 gwei tip");
});

test("ATK-16 [LOW] executeSwap drops the pending nonce the read layer returns (a BigInt) — the registry never records txNonce", async () => {
  /* read.js readPendingNonce → rpc.js getPendingNonce → hexToBigInt (a BigInt); swap.js:306-309
     keeps it only if Number.isSafeInteger → null. Plan §3.6: after a throw with no hash,
     "pending nonce higher than recorded = sent" needs that number. */
  const rig = swapRig({ readPendingNonce: async () => 7n });
  const r = await SW.executeSwap(rig.o);
  assert.equal(r.ok, true);
  assert.equal(rig.reg.get(rig.rec.id).txNonce, 7);
});

/* ═════════════════════════════════════════════════════════════════════════
   HELD — attacks tried that the code refuses (these pass)
   ═════════════════════════════════════════════════════════════════════════ */

test("HELD-1 whitelist pins == R-swap Verification (a): address and decimals, in BOTH tables; bUSDC / PHAR unreachable", () => {
  const verified = {
    USDC: ["0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", 6], WAVAX: ["0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", 18],
    "BTC.b": ["0x152b9d0fdc40c096757f570a51e494bd4b943e50", 8], USDT: ["0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", 6],
    XAUt0: ["0x2775d5105276781b4b85ba6ea6a6653beed1dd32", 6], XSGD: ["0xb2f85b7ab3c2b6f62df06de6ae7d09c010a5096e", 6],
    AVAX: ["0x0000000000000000000000000000000000000000", 18],
  };
  for (const [sym, [addr, dp]] of Object.entries(verified)) {
    const a = WL.AVAX_ASSETS.find((x) => x.symbol === sym);
    const p = PINS.SWAP_TOKENS.find((x) => x.symbol === sym);
    assert.deepEqual([a.address, a.decimals], [addr, dp], `whitelist.js ${sym}`);
    assert.deepEqual([p.address, p.decimals], [addr, dp], `relayPins.js ${sym}`);
  }
  for (const bad of ["0x038dbe3d967bb8389190446dacdfe7b95b44f73d", "0x13a466998ce03db73abc2d4df3bbd845ed1f28e7"]) {
    assert.equal(WL.assetByAddress(bad, { VITE_SWAP_XSGD: "on" }), null);
    assert.equal(PINS.swapTokenByAddress(bad, { allowOff: true }), null);
  }
  assert.equal(PINS.swapTokenBySymbol("XSGD"), null, "XSGD off for swaps whatever the env says");
});

test("HELD-2 chain-id confusion (43114 vs 42161 vs 1337) is refused by every parser and the closed builder", () => {
  const supply = AT.buildSupplyTx({ own: DEAD, amountRaw: 1_000_000n, fees: GAS.feeFields(5n * GWEI) });
  for (const chainId of [42161, 1337, 1, "43114"]) assert.throws(() => AT.decodeAaveTx({ ...supply, chainId }, DEAD), (e) => e.code === "wrong-chain", String(chainId));
  const sw = clone(LIVE_SWAP.response);
  sw.steps.find((s) => s.id === "swap").items[0].data.chainId = 42161;
  assert.throws(() => parseLive(sw), (e) => e.code === "unsafe-quote");
  const out = clone(MOVE_OUT.response);
  out.steps[0].items[0].data.sign.domain.chainId = 42161;
  assert.throws(() => parseOut(out), (e) => e.code === "unsafe-quote");
  const mi = clone(MOVE_IN.response);
  mi.details.currencyOut.currency.chainId = 42161;
  assert.throws(() => moveInReview(mi), (e) => e.code === "unsafe-quote");
});

test("HELD-3 Aave: onBehalfOf / to not the user, unlimited or wrong-token approvals are refused by the closed builder", () => {
  const fees = GAS.feeFields(5n * GWEI);
  const supply = AT.buildSupplyTx({ own: DEAD, amountRaw: 1_000_000n, fees });
  const swapArg = (data, from, to) => data.replace(from.slice(2).toLowerCase().padStart(64, "0"), to.slice(2).toLowerCase().padStart(64, "0"));
  assert.throws(() => AT.decodeAaveTx({ ...supply, data: swapArg(supply.data, DEAD, OTHER) }, DEAD), (e) => e.code === "not-own");
  const wd = AT.buildWithdrawTx({ own: DEAD, amountRaw: "max", fees });
  assert.throws(() => AT.decodeAaveTx({ ...wd, data: swapArg(wd.data, DEAD, OTHER) }, DEAD), (e) => e.code === "not-own");
  const ap = AT.buildApproveTx({ own: DEAD, amountRaw: 1_000_000n, fees });
  assert.throws(() => AT.decodeAaveTx({ ...ap, data: `${ap.data.slice(0, 74)}${"f".repeat(64)}` }, DEAD), (e) => e.code === "unlimited");
  assert.throws(() => AT.decodeAaveTx({ ...ap, to: PINS.SWAP_TOKENS[4].address }, DEAD), (e) => e.code === "not-allowed");
  assert.throws(() => AT.buildApproveTx({ own: DEAD, amountRaw: 21_000_000n, fees }), (e) => e.code === "over-cap");
});
