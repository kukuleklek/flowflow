/**
 * test-avax-fixes — the confirmed findings of the Avax signing review, each held by a test
 * that fails on the code before its fix (X1–X19, one per finding; X8 and X9 have parts).
 *
 * 🔴 MONEY SAFETY. Nothing here signs, holds a key or reaches a network: every signer,
 * sender, RPC, ledger read and fetch is a recorder fed by the read-only fixtures in
 * scripts/fixtures/avax (live quotes captured 2026-10-15). The fake signers run the
 * signer agent's own closed builders (src/avax/closedTx.js) on every request.
 *
 * Run: node --test scripts/test-avax-fixes.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const has = (p) => fs.existsSync(path.join(ROOT, p));
const M = await imp("src/avax/money.js");
const WF = await imp("src/avax/watchFlows.js");
const FL = await imp("src/avax/flows.js");
const OM = await imp("src/lib/relay/ownMove.js");
const MI = await imp("src/lib/relay/moveIn.js");
const MO = await imp("src/lib/relay/moveOut.js");
const SW = await imp("src/lib/relay/swap.js");
const SD = await imp("src/lib/avax/swapDecode.js");
const SC = await imp("src/lib/signCopy.js");
const PINS = await imp("src/lib/avax/relayPins.js");
const PV = await imp("src/wallet/avax/panelView.js");
const PF = await imp("src/wallet/portfolio.js");
const CT = has("src/avax/closedTx.js") ? await imp("src/avax/closedTx.js") : null;
const CS = has("src/avax/cardState.js") ? await imp("src/avax/cardState.js") : {};

const FIX = path.join(ROOT, "scripts/fixtures/avax");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DEAD = "0x000000000000000000000000000000000000dead";
const ONE = "0x1111111111111111111111111111111111111111";
const SIG = `0x${"ab".repeat(65)}`;
const GWEI = 1_000_000_000n;
const AVAX = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const hashOf = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const MIN = 60_000;

const MOVE_IN = load("live-move-in-6-topup.json");
const MOVE_OUT = load("live-move-out-2.json");
const SWAP = load("live-swap-usdc-btcb-2.json");
const LEG_50 = load("swap-gasleg-q-usdc-avax-500000.json");
const Q11 = load("relay-q11-back-plain.json");
const TOPUP_RAW = BigInt(MOVE_IN.response.details.currencyGasTopup.amount);

/* ── fakes ────────────────────────────────────────────────────────────────── */

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const okRes = (json = {}) => ({ ok: true, status: 200, json: async () => json });
const badRes = (status = 400, message = "nope") => ({ ok: false, status, json: async () => ({ message }) });
const NO_TIMERS = Object.freeze({ setTimeout: () => 0, clearTimeout: () => {} });
const STATUS = Object.freeze({ active: true, frozen: false, paused: false, uncapped: false, capRoomRaw: 10n ** 12n, liquidityRaw: 10n ** 12n, apyPct: 5.7 });

function account({ owner = DEAD, usdc = 0n, avax = 0n, btcb = 0n, aUsdc = 0n, allowance = 0n, status = STATUS } = {}) {
  const rows = [
    { symbol: "USDC", native: false, raw: usdc, decimals: 6 }, { symbol: "AVAX", native: true, raw: avax, decimals: 18 },
    { symbol: "WAVAX", native: false, raw: 0n, decimals: 18 }, { symbol: "BTC.b", native: false, raw: btcb, decimals: 8 },
    { symbol: "USDT", native: false, raw: 0n, decimals: 6 }, { symbol: "XAUt0", native: false, raw: 0n, decimals: 6 },
  ];
  return {
    owner, chainId: 43114, readAt: 0, avaxWei: avax, assets: rows,
    balances: Object.fromEntries(rows.map((r) => [r.symbol, r.raw])),
    aave: { suppliedRaw: aUsdc, suppliedUsdc: Number(aUsdc) / 1e6, poolAllowanceRaw: allowance, status },
  };
}

/**
 * A controller over fakes (test-avax-money-hooks' rig): every POST /quote/v2 answered by `quote(body)`,
 * the wallet's nonces kept as Avalanche would (each window's tx takes the next nonce, mined at once),
 * and `chainTx(n, chain, hash)` standing in for what window n does on chain (Privy's Retry: two txs).
 */
function rig({
  own = DEAD, at, env = { VITE_EARN: "on" }, acct = account({ owner: own }), quote = () => ({ status: 500 }),
  mids = { AVAX: 9.5, BTC: 81_433 }, relay = { USDC: 1, AVAX: 9.5, "BTC.b": 81_433 }, fee = { gwei: 5 },
  perp = { balance: { answered: true, availableUsdc: 50 }, positions: { answered: true, list: [], complete: true } },
  onTx = null, preflight = async () => ({ ok: true }), receipt = async () => ({ status: 1 }), chainTx = null,
} = {}) {
  const clock = { t: at };
  const now = () => clock.t;
  const storage = new MemStorage();
  const registry = FL.createFlowRegistry({ storage, own, now, locks: null });
  const log = [];
  const state = { acct, quote };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    log.push(["fetch", u.replace(/\?.*/, ""), body]);
    if (u.endsWith("/quote/v2")) {
      const r = state.quote(body);
      return r && r.status ? badRes(r.status, r.message) : okRes(clone(r));
    }
    if (u.includes("/authorize") || u.includes("/execute/permits")) return okRes({});
    throw new Error(`unexpected fetch ${u}`);
  };
  let n = 0;
  const chain = { nonce: 7n, byHash: new Map() };
  const signers = {
    own,
    async sendAvaxTx(tx, o = {}) {
      log.push(["tx", tx, o.check]);
      if (CT) assert.ok(CT.avaxTxFromRequest(tx, o.check, own), `the closed builder accepts the ${o.check && o.check.kind} tx`);
      n += 1;
      const h = await (onTx ? onTx(tx, o, n) : hashOf(n));
      if (chainTx && chainTx(n, chain, h)) return h;
      chain.byHash.set(h, chain.nonce);
      chain.nonce += 1n;
      return h;
    },
    async signAvaxTypedData(td, o = {}) {
      log.push(["typed", td.primaryType]);
      if (CT) assert.ok(CT.avaxTypedDataFromRequest(td, o.review, own, { now: clock.t }), "the closed builder accepts the permit");
      return SIG;
    },
    async signAuthorize(step) { log.push(["auth", step.id]); return { ok: true, signature: SIG }; },
    async sendDeposit(o) { log.push(["send", o]); return { ok: true }; },
  };
  const money = M.createAvaxMoney({
    own, registry, env, signers: () => signers, now, timers: NO_TIMERS, fetchImpl,
    getPerp: () => perp, getMids: () => mids,
    readAccount: async () => { log.push(["read-account"]); return state.acct; },
    readFee: async () => ({ baseFeeWei: BigInt(fee.gwei) * GWEI }),
    readPrices: async () => relay,
    readSettlers: async () => [...PINS.KNOWN_SETTLERS],
    preflight: async (tx, o) => { log.push(["preflight", tx.to]); return preflight(tx, o); },
    waitReceipt: async (h) => { log.push(["receipt", h]); return receipt(h); },
    readPendingNonce: async () => chain.nonce,
    readLatestNonce: async () => chain.nonce,
    readTxNonce: async (h) => (chain.byHash.has(h) ? chain.byHash.get(h) : null),
  });
  return { money, registry, storage, log, clock, state, chain, fee };
}

const txs = (log) => log.filter((x) => x[0] === "tx");
const routeMoveIn = (body) => (body.originChainId === 1337 ? MOVE_IN.response : { status: 500 });
const routeMoveOut = (json = MOVE_OUT.response) => (body) => (body.originChainId === 43114 && body.destinationChainId === 1337 && body.usePermit ? json : { status: 500 });
const routePaid = (b) => (b.originChainId === 43114 && b.destinationChainId === 1337 ? (b.usePermit ? { status: 400, message: "no permit" } : Q11.response) : { status: 500 });
const moveInReview = ({ json = MOVE_IN.response, avaxUsd = 9.5 } = {}) => OM.parseOwnMoveQuote(json, {
  own: DEAD, dest: "usdc", amountRaw: "6000000", topupUsd: 0.3, maxDebitUsdc: MI.maxDebitUsdc(6, 0.3), avaxUsd, now: MOVE_IN.capturedAt,
});

/* The live USDC → BTC.b answer, verified (what executeSwap is handed). */
const liveSwap = () => SD.parseSwapQuote(SWAP.response, {
  own: DEAD, from: PINS.swapTokenBySymbol("USDC").address, to: PINS.swapTokenBySymbol("BTC.b").address, amountRaw: "2000000", now: SWAP.capturedAt,
});

/* A registry on its own clock; `reload()` is the same storage seen by a NEW page (the load rule). */
function regAt(t0) {
  const clock = { t: t0 };
  const storage = new MemStorage();
  const now = () => clock.t;
  const reg = FL.createFlowRegistry({ storage, own: DEAD, now, locks: null });
  return { reg, clock, now, reload: () => FL.createFlowRegistry({ storage, own: DEAD, now, locks: null }) };
}

/* ── X1 (F1) the window's gas $ is the card's ─────────────────────────────── */

test("X1) move-in window: the gas clause prints the card's 'Gas for later' $ (the $ asked), never Relay's own amountUsd", () => {
  const j = clone(MOVE_IN.response);
  j.details.currencyGasTopup.amountUsd = "0.330000"; /* inside Relay's accepted band, not the $0.30 asked */
  const q = moveInReview({ json: j });
  assert.equal(q.gasRow.usd, 0.3, "the card prints the $ asked");
  const w = SC.ownMoveSignWords(q);
  assert.match(w.deposit.description, /It includes ≈0\.0315 AVAX for gas \(≈\$0\.30\)\.$/);
  assert.doesNotMatch(w.deposit.description, /\$0\.33/);
});

/* ── X2 (F2) move-out: the order the user funds pays what the card prints ─── */

test("X2) move out: an order whose own payment minimum / expected amount differs from the printed figures is refused (permit and paid)", () => {
  const throwsUnsafe = (fn) => assert.throws(fn, (e) => e && e.code === "unsafe-quote" && /another amount|more than once/.test(e.message));
  const permitWith = (fn) => { const j = clone(MOVE_OUT.response); fn(j.protocol.v2.orderData.output.payments); return j; };
  const parsePermit = (j) => MO.parseMoveOutQuote(j, { own: DEAD, amountRaw: "2000000", now: MOVE_OUT.capturedAt });
  assert.equal(parsePermit(MOVE_OUT.response).minimumUsdc, "1.903408", "the live answer still parses");
  throwsUnsafe(() => parsePermit(permitWith((p) => { p[0].minimumAmount = "1"; p[0].expectedAmount = "1"; })));
  throwsUnsafe(() => parsePermit(permitWith((p) => { p[0].minimumAmount = "190340799"; })));
  throwsUnsafe(() => parsePermit(permitWith((p) => { p.push({ ...p[0] }); })));
  const paidWith = (fn) => { const j = clone(Q11.response); fn(j.protocol.v2.orderData.output.payments); return j; };
  const parsePaid = (j) => MO.parsePaidExitQuote(j, { own: ONE, amountRaw: "10000000", now: 1792044000000 });
  assert.equal(parsePaid(Q11.response).txs.length, 2, "the live paid answer still parses");
  throwsUnsafe(() => parsePaid(paidWith((p) => { p[0].minimumAmount = "1"; p[0].expectedAmount = "1"; })));
  throwsUnsafe(() => parsePaid(paidWith((p) => { p[0].expectedAmount = "997599801"; })));
});

/* ── X3 (F3) no frozen mid ────────────────────────────────────────────────── */

test("X3) the mids a review prices with leave out a coin whose market row went stale; the hook reads the store at review time", () => {
  assert.equal(typeof M.liveMids, "function");
  const by = { AVAX: { px: 9.5 }, BTC: { px: 81_433 }, PAXG: { px: 4_000 } };
  assert.deepEqual(M.liveMids({ byCoin: by, stale: false, staleSince: null }), { AVAX: 9.5, BTC: 81_433, PAXG: 4_000 });
  /* The stream stopped at t=1000; only AVAX has been refreshed since. */
  assert.deepEqual(M.liveMids({ byCoin: by, stale: true, staleSince: 1000, coinFreshAt: { AVAX: 2000, BTC: 900 } }), { AVAX: 9.5 });
  assert.deepEqual(M.liveMids({ byCoin: by, stale: true }), {}, "stale with no time: nothing is fresh");
  assert.deepEqual(M.liveMids(null), {});
  const hook = strip(read("src/avax/useAvaxMoney.js"));
  assert.match(hook, /liveMids\(perpMarketsStore\(\)\.getSnapshot\(\)\)/, "the controller reads the store itself, stale coins left out");
  assert.ok(!/LIVE\.mids/.test(hook), "no mids frozen at the last render");
});

/* ── X4 (F4) unread venue positions ───────────────────────────────────────── */

test("X4) the Main Account check refuses while the position list is not complete (complete: null — HIP-3 venues unread)", () => {
  const bal = { answered: true, availableUsdc: 10 };
  for (const complete of [null, undefined]) {
    const r = M.perpMoveCheck({ balance: bal, positions: { answered: true, list: [], complete }, debitUsdc: 2 });
    assert.equal(r.ok, false, String(complete));
    assert.equal(r.why, M.MONEY_WHY.perpLoading);
  }
  assert.equal(M.perpMoveCheck({ balance: bal, positions: { answered: true, list: [], complete: false }, debitUsdc: 2 }).why, M.MONEY_WHY.perpPartial);
  assert.equal(M.perpMoveCheck({ balance: bal, positions: { answered: true, list: [], complete: true }, debitUsdc: 2 }).ok, true);
});

/* ── X5 (F5) the paid exit's printed network fee holds at Confirm ─────────── */

test("X5) paid exit: a re-quote at Confirm with a higher network fee cap is a new card — nothing signed", async () => {
  const r = rig({ own: ONE, at: 1792044000000, quote: routePaid, acct: account({ owner: ONE, usdc: 10_000_000n, avax: AVAX(0.05) }) });
  const rv = await r.money.review("move-out", { amountUsdc: "10" });
  assert.equal(rv.route, "paid");
  assert.equal(rv.confirmable, true, rv.whyNot);
  r.clock.t += 61_000;
  r.fee.gwei = 30; /* 2 × 30 + 1 = 61 gwei, where the card printed 11 */
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, false);
  assert.equal(out.code, "requote-worse");
  assert.equal(out.why, "fee-higher");
  assert.equal(txs(r.log).length, 0, "nothing was signed");
  assert.match(out.review.networkFeeText, /^up to ≈0\.0109 AVAX/, "the new card prints the new fee (180k gas × 61 gwei)");
});

/* ── X6 (F6) Fee + Gas for later add up to what leaves ────────────────────── */

test("X6) move in: the fee is net of the PRINTED gas $, and AVAX worth far less than the $ printed is refused", () => {
  const j = clone(MOVE_IN.response);
  j.details.currencyGasTopup.amountUsd = "0.330000"; /* Relay says the gas cost $0.33; the card prints $0.30 */
  const q = moveInReview({ json: j });
  assert.equal(q.feeUsdc, 0.042288, "the $0.03 Relay charges over the printed gas shows as fee");
  assert.ok(Math.abs(q.feeUsdc + q.gasRow.usd - (q.amountIn - 6)) < 1e-6, "Fee + Gas for later = what leaves beyond X");
  /* The finding's example: Relay claims $0.44 of gas and delivers 0.0158 AVAX (≈$0.15 at $9.5). */
  const k = clone(MOVE_IN.response);
  k.details.currencyGasTopup.amountUsd = "0.440000";
  k.details.currencyGasTopup.amount = "15800000000000000";
  k.details.currencyGasTopup.minimumAmount = "15800000000000000";
  assert.throws(() => moveInReview({ json: k }), (e) => e.code === "unsafe-quote" && /size asked/.test(e.message));
});

/* ── X7 (F7) the gas top-up is checked, not assumed ───────────────────────── */

test("X7) move in with a gas top-up: 'done' needs the AVAX too; missing gas is said, never silent", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, acct: account({ avax: 0n, btcb: 10_000n }) });
  const rv = await r.money.review("move-in", { amountUsdc: "6" });
  const rec0 = r.registry.get(rv.id);
  assert.equal(rec0.amounts.topupRaw, String(TOPUP_RAW), "the card records the gas it printed");
  assert.equal(rec0.amounts.avaxBeforeRaw, "0");
  const t0 = MOVE_IN.capturedAt;
  const rec = { ...rec0, state: "arriving", requestId: hashOf(9), sentAt: t0 };
  const arrived = { status: { status: "arrived", relayStatus: "success" } };
  let j = WF.judgeFlow(rec, { ...arrived, account: account({ avax: TOPUP_RAW }) }, { now: t0 + 10_000 });
  assert.deepEqual([j.action, j.state], ["finish", "done"]);
  assert.match(j.evidence, /gas AVAX \+0\.0315/);
  j = WF.judgeFlow(rec, { ...arrived, account: account({ avax: 0n }) }, { now: t0 + 10_000 });
  assert.equal(j.action, "keep", "the USDC is in, the gas is not yet: keep looking");
  assert.match(j.note, /gas for later hasn't arrived yet/);
  j = WF.judgeFlow(rec, { ...arrived, account: account({ avax: 0n }) }, { now: t0 + WF.GAS_ARRIVAL_GRACE_MS + 1 });
  assert.deepEqual([j.action, j.state], ["finish", "done"]);
  assert.match(j.evidence, /gas not seen \(AVAX \+0\)/);
  /* The card says so, with the request's link. */
  const s = CS.settledState({ phase: "arriving", progress: [{ key: "arrive", state: "active" }], outcome: null }, { kind: "move-in", rec: { state: "done", evidence: j.evidence, requestId: hashOf(9) } });
  assert.match(s.outcome.message, /gas for later didn't arrive/);
  assert.equal(PV.outcomeView({ kind: "move-in", phase: s.phase, outcome: s.outcome }).links.some((l) => /relay\.link/.test(l.href)), true);
  /* inspectFlow reads the account once Relay says arrived, for the gas. */
  const reads = [];
  await WF.inspectFlow(rec, { own: DEAD, now: () => t0, readStatus: async () => arrived.status, readAccount: async () => { reads.push("acct"); return account(); },
    readReceipt: async () => null, readPermitUsed: async () => null, readPendingNonce: async () => null });
  assert.deepEqual(reads, ["acct"]);
});

/* ── X8 (F8) an unknown with ids still settles with evidence; the exit is never walled in ── */

test("X8a) a stake whose page closed on Privy's success screen settles: nonce used + Aave up → done; nonce never used → nothing moved", async () => {
  for (const [latest, aUsdc, want] of [[6n, 2_000_100n, "done"], [5n, 0n, "error-before-money"]]) {
    const t0 = 1792044000000;
    const { reg, clock, reload } = regAt(t0);
    const rec = reg.begin({ kind: "stake", maxDebit: 2, amounts: { in: "2", approve: true, beforeRaw: "0" } });
    reg.confirm(rec.id);
    const h = reg.handle(rec.id);
    h.claim("stake");
    h.beforeWindow({ step: "approve", txNonce: 4 });
    h.update({ txHash: hashOf(1), approveTx: hashOf(1) });
    h.beforeWindow({ step: "supply", txNonce: 5 });
    const reg2 = reload(); /* the page closed: the load rule makes it unknown */
    assert.equal(reg2.get(rec.id).state, "unknown");
    assert.equal(reg2.canStart().code, "unknown");
    clock.t += 7 * 24 * 60 * MIN;
    const cur = reg2.get(rec.id);
    const ev = await WF.inspectFlow(cur, {
      own: DEAD, now: () => clock.t, readStatus: async () => null, readReceipt: async () => null, readPermitUsed: async () => null,
      readPendingNonce: async () => latest, readLatestNonce: async () => latest, readAccount: async () => account({ aUsdc }), lockFree: async () => true,
    });
    const j = WF.judgeFlow(cur, ev, { now: clock.t });
    if (j.action === "finish") reg2.finish(cur.id, j.state, j.evidence);
    else if (j.action === "settle") reg2.settleNothingMoved(cur.id, j.proof);
    assert.equal(reg2.get(rec.id).state, want, j.action);
    assert.equal(reg2.canStart().ok, true, "the wallet is free again");
  }
});

test("X8b) a move in reloaded with its sendAsset window open settles from the Main Account's ledger; a send in the ledger keeps it", async () => {
  const t0 = 1792044000000;
  const hlNonce = t0 + 5_000;
  const mk = () => {
    const x = regAt(t0);
    const rec = x.reg.begin({ kind: "move-in", maxDebit: 2.3, amounts: { out: "2", beforeRaw: "0" } });
    x.reg.confirm(rec.id);
    const h = x.reg.handle(rec.id);
    h.claim("own-move");
    h.beforeWindow({ requestId: hashOf(9), hlNonce, orderDeadline: Math.floor(t0 / 1000) + 600 });
    const reg2 = x.reload();
    x.clock.t += 30 * MIN;
    return { ...x, reg2, id: rec.id };
  };
  const deps = (x, ledger, lock = true) => ({
    own: DEAD, now: () => x.clock.t, readStatus: async () => ({ status: "sending", relayStatus: "waiting" }), readReceipt: async () => null,
    readPermitUsed: async () => null, readAccount: async () => account(), readLedger: async () => ledger, lockFree: async () => lock,
  });
  let x = mk();
  let cur = x.reg2.get(x.id);
  let j = WF.judgeFlow(cur, await WF.inspectFlow(cur, deps(x, [])), { now: x.clock.t });
  assert.deepEqual([j.action, j.proof && j.proof.kind], ["settle", "hl-not-sent"]);
  assert.equal(x.reg2.settleNothingMoved(x.id, j.proof).state, "error-before-money");
  /* The ledger holds this move's sendAsset: money left — keep watching. */
  x = mk();
  cur = x.reg2.get(x.id);
  const sent = [{ time: t0 + 6_000, hash: hashOf(3), delta: { type: "send", user: DEAD, destination: PINS.HL_DEPOSITORY, token: "USDC", amount: "2.3", nonce: hlNonce } }];
  assert.equal(WF.judgeFlow(cur, await WF.inspectFlow(cur, deps(x, sent)), { now: x.clock.t }).action, "keep");
  /* Another tab holds the account's lock (a window may be open): keep. */
  assert.equal(WF.judgeFlow(cur, await WF.inspectFlow(cur, deps(x, [], false)), { now: x.clock.t }).action, "keep");
  /* The registry re-checks the proof itself. */
  assert.throws(() => x.reg2.settleNothingMoved(x.id, { kind: "hl-not-sent", sends: 1, readAt: x.clock.t, fromMs: 0 }), (e) => e.code === "no-evidence");
});

test("X8c) Relay 'failure' is a printed note (a refund usually follows), never 'On its way' and never 'nothing moved'", () => {
  const rec = { id: "fabcdef5", kind: "move-in", state: "arriving", startedAt: 1, updatedAt: 1, tabId: "t1", requestId: hashOf(9), amounts: { out: "2" } };
  const j = WF.judgeFlow(rec, { status: { status: "failed", relayStatus: "failure" } }, { now: 2 });
  assert.equal(j.action, "keep");
  assert.match(j.note, /refund to your Main Account usually follows/);
  assert.match(j.href, /^https:\/\/relay\.link\/transaction\/0x0+9$/);
});

test("X8d) the exit is never walled in: an unknown idle past 15 min no longer blocks Move out / Unstake / a swap to USDC; entries stay blocked", () => {
  const t0 = 1792044000000;
  const x = regAt(t0);
  const stuck = x.reg.begin({ kind: "move-in", maxDebit: 2.3, amounts: { out: "2" } });
  x.reg.confirm(stuck.id);
  x.reg.markUnknown(stuck.id, "not_confirmed");
  x.clock.t += 5 * MIN;
  assert.equal(x.reg.canStart({ exit: true }).code, "unknown", "a fresh unknown may still have a window open");
  x.clock.t += 11 * MIN;
  assert.equal(x.reg.canStart({ exit: true }).ok, true);
  assert.equal(x.reg.canStart().code, "unknown", "entries still wait for evidence");
  const out = x.reg.begin({ kind: "move-out", maxDebit: 2, amounts: { in: "2" } });
  assert.equal(x.reg.confirm(out.id).ok, true, "Move out confirms");
  x.reg.cancel(out.id, "test");
  const back = x.reg.begin({ kind: "swap", amounts: { from: "BTC.b", to: "USDC", amountRaw: "2400" } });
  assert.equal(x.reg.confirm(back.id).ok, true, "a swap back to USDC is an exit");
  x.reg.cancel(back.id, "test");
  const stake = x.reg.begin({ kind: "stake", maxDebit: 2, amounts: { in: "2" } });
  assert.equal(x.reg.confirm(stake.id).code, "unknown", "Stake is an entry");
  assert.equal(FL.isExitRecord({ kind: "swap", amounts: { from: "USDC", to: "BTC.b" } }), false);
});

test("X8e) a run stopped at its approve with no receipt to read settles after 15 idle minutes (allowance named); not before", () => {
  const t0 = 1792044000000;
  const x = regAt(t0);
  const rec = x.reg.begin({ kind: "swap", amounts: { from: "USDC", to: "BTC.b", amountRaw: "2000000" } });
  x.reg.confirm(rec.id);
  const h = x.reg.handle(rec.id);
  h.claim("swap");
  h.beforeWindow({ step: "approve", txNonce: 7 });
  const reg2 = x.reload();
  x.clock.t += 2 * MIN;
  assert.equal(WF.judgeFlow(reg2.get(rec.id), {}, { now: x.clock.t }).action, "keep");
  x.clock.t += 14 * MIN;
  const j = WF.judgeFlow(reg2.get(rec.id), { lockFree: true }, { now: x.clock.t });
  assert.deepEqual([j.action, j.proof.kind], ["settle", "stopped-at-approve"]);
  const done = reg2.settleNothingMoved(rec.id, j.proof);
  assert.equal(done.state, "error-before-money");
  assert.equal(done.allowanceLeft, true);
});

/* ── X9 (F9) Privy's in-window Retry ──────────────────────────────────────── */

test("X9a) stake: the supply window sends twice (Privy Retry) and hands back a reverted second hash → UNKNOWN, never 'Only the network fee was spent'", async () => {
  const r = rig({
    at: MOVE_IN.capturedAt, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05) }),
    /* window 2: tx1 (the supply) mined at nonce n, the Retry's tx2 at n+1 reverted — and only tx2's hash comes back */
    chainTx: (n, chain, h) => { if (n !== 2) return false; chain.byHash.set(h, chain.nonce + 1n); chain.nonce += 2n; return true; },
    receipt: async (h) => ({ status: h === hashOf(2) ? 0 : 1 }),
  });
  const rv = await r.money.review("stake", { amountUsdc: "2" });
  assert.equal(rv.windows, 2);
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, false);
  assert.equal(out.state, "unknown");
  assert.doesNotMatch(out.message, /network fee/);
  assert.equal(r.registry.get(rv.id).state, "unknown");
  /* …and the watcher never calls that receipt "nothing moved" either. */
  const rec = r.registry.get(rv.id);
  assert.equal(rec.txNonce, 8);
  assert.equal(WF.judgeFlow(rec, { receipt: { status: 0 }, hashNonce: 9n, latestNonce: 10n }, { now: r.clock.t }).action, "keep");
  /* Once idle, what the FIRST tx at the window's nonce did is read on chain: the USDC is in Aave → done. */
  r.clock.t += 16 * MIN;
  const ev = await WF.inspectFlow(rec, {
    own: DEAD, now: () => r.clock.t, readStatus: async () => null, readReceipt: async () => ({ status: 0 }), readPermitUsed: async () => null,
    readTxNonce: async () => 9n, readLatestNonce: async () => 10n, readPendingNonce: async () => 10n,
    readAccount: async () => account({ aUsdc: 2_000_000n }), lockFree: async () => true,
  });
  const j = WF.judgeFlow(rec, ev, { now: r.clock.t });
  assert.deepEqual([j.action, j.state], ["finish", "done"]);
});

test("X9b) unstake: a window that sent twice and succeeded is UNKNOWN, never 'done' once", async () => {
  const r = rig({
    at: MOVE_IN.capturedAt, acct: account({ usdc: 0n, avax: AVAX(0.05), aUsdc: 5_000_000n }),
    chainTx: (n, chain, h) => { chain.byHash.set(h, chain.nonce + 1n); chain.nonce += 2n; return true; },
  });
  const rv = await r.money.review("unstake", { amountUsdc: "2" });
  const out = await r.money.confirm(rv);
  assert.equal(out.state, "unknown");
  assert.notEqual(r.registry.get(rv.id).state, "done");
});

test("X9c) executeSwap: the swap's hash must be the one tx at its window's nonce; no nonce before the window → no window", async () => {
  const review = liveSwap();
  const mk = ({ hashNonce, pending = async () => 7 }) => {
    const reg = FL.createFlowRegistry({ storage: new MemStorage(), own: DEAD, now: () => SWAP.capturedAt + 1000, locks: null });
    const rec = reg.begin({ kind: "swap", amounts: SW.swapEnvelope(review) });
    reg.confirm(rec.id);
    let n = 0;
    const sent = [];
    return {
      reg, rec, sent,
      o: {
        review, ownNow: () => DEAD, maxFeePerGasWei: 11n * GWEI, flow: reg.handle(rec.id), now: () => SWAP.capturedAt + 1000,
        readPendingNonce: pending, readTxNonce: async () => hashNonce, readLatestNonce: async () => (hashNonce == null ? null : hashNonce + 1n),
        sendTx: async (tx) => { sent.push(tx.purpose); n += 1; return hashOf(n); },
        /* the approve went through; the swap's own receipt (window 2) reverted */
        waitReceipt: async (h) => ({ status: h === hashOf(2) ? 0 : 1 }), preflight: async () => ({ ok: true }),
      },
    };
  };
  let x = mk({ hashNonce: 8n }); /* the Retry's tx at 8, the window was written at 7 */
  let r = await SW.executeSwap(x.o);
  assert.equal(r.state, "unknown");
  assert.notEqual(r.message, SW.SWAP_WORDS.priceMoved);
  x = mk({ hashNonce: 7n });
  r = await SW.executeSwap(x.o);
  assert.equal(r.message, SW.SWAP_WORDS.priceMoved, "bound: the revert is the swap's own");
  x = mk({ hashNonce: 7n, pending: async () => null });
  r = await SW.executeSwap(x.o);
  assert.equal(r.code, "no_nonce");
  assert.deepEqual(x.sent, ["approve"], "the swap window never opened");
});

/* ── X10 / X13 (F10, F13) after the gas leg, never "Nothing moved" ────────── */

test("X10) swap with a gas leg: when the main swap then stops (rejected, re-priced, fee moved), the outcome says the gas is in and the swap didn't run", async () => {
  const legRig = (o) => rig({
    at: SWAP.capturedAt, mids: { AVAX: 10.5, BTC: 81_433 }, relay: { USDC: 1, AVAX: 10.5, "BTC.b": 81_433 },
    quote: (b) => (b.destinationCurrency === PINS.NATIVE ? LEG_50.response : SWAP.response), acct: account({ usdc: 5_000_000n, avax: AVAX(0.0065) }), ...o,
  });
  const check = (out, r) => {
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.message, /Nothing (moved|was swapped)/);
    assert.match(out.message, /^Gas for later is in your Spot Account/);
    assert.match(out.message, /The swap itself didn't run/);
    assert.ok(out.txHashes.includes(hashOf(2)), "the leg's swap is linked");
    assert.deepEqual(r.registry.list().map((f) => f.state).sort(), ["cancelled", "done"].sort());
  };
  /* (a) the user says no to the main approve (window 3) */
  let r = legRig({ onTx: (tx, o, n) => { if (n === 3) { const e = new Error("User rejected the request"); e.code = 4001; throw e; } return hashOf(n); } });
  let rv = await r.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" });
  assert.equal(rv.windows, 4);
  check(await r.money.confirm(rv), r);
  /* (b) the leg took past the main quote's 60 s, and the new price can't be had */
  r = legRig({ onTx: (tx, o, n) => { if (n === 2) { r.clock.t += 61_000; r.state.quote = (b) => (b.destinationCurrency === PINS.NATIVE ? LEG_50.response : { status: 500 }); } return hashOf(n); } });
  rv = await r.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" });
  let out = await r.money.confirm(rv);
  assert.doesNotMatch(out.message, /Nothing (moved|was swapped)/);
  assert.match(out.message, /^Gas for later is in your Spot Account/);
  /* (c) the network fee jumped during the leg */
  r = legRig({ onTx: (tx, o, n) => { if (n === 2) r.fee.gwei = 30; return hashOf(n); } });
  rv = await r.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" });
  out = await r.money.confirm(rv);
  assert.equal(out.code, "fee-moved");
  check(out, r);
});

/* ── X11 (F11) the swap window opens only on a live price ─────────────────── */

test("X11) executeSwap: an approve that outlives the 60 s price never leads to the swap window ('Allowed but not swapped. Price expired.')", async () => {
  const review = liveSwap();
  const t = { now: SWAP.capturedAt + 50_000 };
  const reg = FL.createFlowRegistry({ storage: new MemStorage(), own: DEAD, now: () => t.now, locks: null });
  const rec = reg.begin({ kind: "swap", amounts: SW.swapEnvelope(review) });
  reg.confirm(rec.id);
  const sent = [];
  const r = await SW.executeSwap({
    review, ownNow: () => DEAD, maxFeePerGasWei: 11n * GWEI, flow: reg.handle(rec.id), now: () => t.now, readPendingNonce: async () => 7,
    sendTx: async (tx) => { sent.push(tx.purpose); t.now += 100_000; return hashOf(sent.length); },
    waitReceipt: async () => ({ status: 1 }), preflight: async () => ({ ok: true }),
  });
  assert.deepEqual(sent, ["approve"], "the swap window never opened on a 150 s old price");
  assert.equal(r.code, "price_expired");
  assert.equal(r.allowanceLeft, true);
  assert.match(r.message, /Allowed but not swapped/);
});

/* ── X12 (F12) a refund leaves no spinner ─────────────────────────────────── */

test("X12) refunded: the card's 'Arrive' stage stops spinning (✗), the stages before it are done", () => {
  const s = { phase: "arriving", review: {}, outcome: null, progress: [{ key: "authorize", state: "done" }, { key: "send", state: "done" }, { key: "arrive", state: "active" }] };
  const n = CS.settledState(s, { kind: "move-in", rec: { state: "refunded", requestId: hashOf(9) } });
  assert.equal(n.phase, "refunded");
  assert.ok(!n.progress.some((x) => x.state === "active"), "no spinner left");
  assert.equal(n.progress.find((x) => x.key === "arrive").state, "failed");
  assert.equal(n.outcome.message, "Refunded to your Main Account.");
  assert.equal(WF.settledProgress([{ key: "x", state: "active" }], "done")[0].state, "done");
});

/* ── X13: see X10 (the same defect from the UX side) ─────────────────────── */

test("X13) the gas-leg outcome reaches the panel as a failure that names the gas, not 'Nothing moved'", async () => {
  const r = rig({
    at: SWAP.capturedAt, mids: { AVAX: 10.5, BTC: 81_433 }, relay: { USDC: 1, AVAX: 10.5, "BTC.b": 81_433 },
    quote: (b) => (b.destinationCurrency === PINS.NATIVE ? LEG_50.response : SWAP.response), acct: account({ usdc: 5_000_000n, avax: AVAX(0.0065) }),
    onTx: (tx, o, n) => { if (n === 3) { const e = new Error("User rejected the request"); e.code = 4001; throw e; } return hashOf(n); },
  });
  const rv = await r.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" });
  const out = await r.money.confirm(rv);
  const v = PV.outcomeView({ kind: "swap", phase: "failed", outcome: out });
  assert.doesNotMatch(v.title, /Nothing moved/);
  assert.match(v.title, /Gas for later is in your Spot Account/);
  assert.ok(v.links.length >= 1, "the leg's Snowtrace link");
});

/* ── X14 (F14) after the panel closes ─────────────────────────────────────── */

test("X14) every record carries the amount the Wallet page prints, and an unknown row keeps where to look and its link", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: (b) => (b.originChainId === 1337 ? MOVE_IN.response : b.usePermit ? MOVE_OUT.response : SWAP.response),
    acct: account({ usdc: 5_000_000n, avax: 0n, btcb: 10_000n, aUsdc: 3_000_000n }) });
  const rows = async (kind, args) => {
    const rv = await r.money.review(kind, args);
    const rec = { ...r.registry.get(rv.id), state: "arriving" };
    r.money.close(rv);
    return PF.inFlightRows({ flows: [rec] })[0].amountText;
  };
  assert.equal(await rows("move-in", { amountUsdc: "6" }), "6 USDC");
  r.clock.t = MOVE_OUT.capturedAt;
  assert.equal(await rows("move-out", { amountUsdc: "2" }), "2 USDC");
  r.state.acct = account({ usdc: 5_000_000n, avax: AVAX(0.05), aUsdc: 3_000_000n });
  assert.equal(await rows("stake", { amountUsdc: "2" }), "2 USDC");
  assert.equal(await rows("unstake", { amountUsdc: "1.5" }), "1.5 USDC");
  r.clock.t = SWAP.capturedAt;
  assert.equal(await rows("swap", { from: "USDC", to: "BTC.b", amount: "2" }), "2 USDC");
  /* An unknown move with no watcher note yet still says where to look, with its own Relay link. */
  const u = PV.flowRowView({ id: "a", kind: "move-in", state: "unknown", requestId: hashOf(9), amounts: { out: "2" }, view: { unknown: true }, note: null });
  assert.match(u.where, /Main Account and your Spot Account/);
  assert.equal(u.note.href, `https://relay.link/transaction/${hashOf(9)}`);
  const actions = strip(read("src/wallet/avax/SpotActions.jsx"));
  assert.match(actions, /<SpotMoves unknownOnly \/>/, "the Wallet page's watcher draws the not-confirmed moves");
});

/* ── X15 (F15) the exits never wait for the flag ──────────────────────────── */

test("X15) with VITE_EARN off, Move out / Unstake / a swap to USDC still confirm when there is something to take out; Move in / Stake do not", () => {
  const v = { assets: [{ symbol: "USDC", amount: 2, status: "ok" }, { symbol: "BTC.b", amount: 0.0001, status: "ok" }, { symbol: "AVAX", amount: 0.02, status: "ok", native: true }], aave: { status: "ok", suppliedUsdc: 1 } };
  assert.deepEqual({ ...PV.exitsOpen(v) }, { moveOut: true, unstake: true, swap: true, any: true });
  assert.deepEqual({ ...PV.exitsOpen({ assets: [{ symbol: "USDC", amount: null, status: "unknown" }], aave: { status: "unknown" } }) }, { moveOut: false, unstake: false, swap: false, any: false });
  const action = (review) => ({ ready: true, why: null, phase: "review", canConfirm: true, outcome: null, review: {
    confirmable: true, whyNot: null, windows: 1, rows: [{ key: "amount", label: "You move", value: "2 USDC" }], ...review } });
  assert.equal(PV.confirmGate({ earnOn: false, kind: "move-out", action: action({}) }).enabled, true);
  assert.equal(PV.confirmGate({ earnOn: false, kind: "unstake", action: action({}) }).enabled, true);
  assert.equal(PV.confirmGate({ earnOn: false, kind: "swap", action: action({ exit: true }) }).enabled, true);
  assert.equal(PV.confirmGate({ earnOn: false, kind: "swap", action: action({ exit: false }) }).why, "Opens after the live test");
  assert.equal(PV.confirmGate({ earnOn: false, kind: "move-in", action: action({}) }).why, "Opens after the live test");
  assert.equal(PV.confirmGate({ earnOn: false, kind: "stake", action: action({}) }).why, "Opens after the live test");
  const card = strip(read("src/wallet/avax/AvaxWallet.jsx"));
  assert.match(card, /<ActionPill glyph="out" exit=\{exits\.moveOut\}/);
  assert.match(card, /<ActionPill glyph="out" exit=\{exits\.unstake\}/);
});

/* ── X16 (F16) a worse background re-quote is said; Confirm acts on what is drawn ── */

test("X16) the card's background refresh: worse → 'The price changed…'; Confirm refuses a review not on screen, and waits a moment after a change", async () => {
  let answer = MOVE_OUT.response;
  const r = rig({ at: MOVE_OUT.capturedAt, quote: (b) => routeMoveOut(answer)(b), acct: account({ usdc: 2_000_000n }) });
  const a = await r.money.review("move-out", { amountUsdc: "2" });
  const same = await r.money.refresh(a);
  assert.equal(r.money.worse(a, same), null);
  const worse = clone(MOVE_OUT.response);
  worse.details.currencyOut.amount = "195000000";
  worse.protocol.v2.orderData.output.payments[0].expectedAmount = "195000000";
  answer = worse;
  const b = await r.money.refresh(same);
  assert.equal(r.money.worse(same, b), "less-arrives");
  const s0 = { phase: "review", review: same, progress: same.stages, outcome: null, changedAt: null };
  const s1 = CS.refreshedState(s0, { next: b, worse: "less-arrives", at: 1000 });
  assert.equal(s1.outcome.needsConfirm, true);
  assert.equal(s1.outcome.message, CS.PRICE_CHANGED_WORDS);
  assert.equal(s1.changedAt, 1000);
  assert.equal(CS.mayConfirm({ rendered: same, current: b, changedAt: null, at: 5000 }), false, "the tap was drawn with the old card");
  assert.equal(CS.mayConfirm({ rendered: b, current: b, changedAt: 1000, at: 1500 }), false, "the figures just changed");
  assert.equal(CS.mayConfirm({ rendered: b, current: b, changedAt: 1000, at: 1000 + CS.CONFIRM_SETTLE_MS }), true);
  const panels = strip(read("src/wallet/avax/AvaxPanels.jsx"));
  assert.match(panels, /a\.confirm\(a\.review\)/);
});

/* ── X17 (F17) the per-move cap reads as a limit ──────────────────────────── */

test("X17) a move in whose fee and gas take the debit past the per-move cap says the most that fits, quietly — not a refused quote", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, env: { VITE_EARN: "on", VITE_MAX_MOVE_USDC: "6" }, acct: account({ avax: 0n, btcb: 10_000n }) });
  const rv = await r.money.review("move-in", { amountUsdc: "6" });
  assert.equal(rv.confirmable, false);
  assert.equal(rv.whyNot, "Max ≈5.65 USDC this time: the fee and gas come on top, and at most 6 USDC leaves your Main Account per move.");
  assert.equal(PV.whyTone(rv.whyNot), "muted");
  assert.match(strip(read("src/wallet/avax/AvaxPanels.jsx")), /USDC per move, fee and gas included/);
});

/* ── X18 (F18) no "≈1 s" for a move between accounts ─────────────────────── */

test("X18) a move between the Main Account and the Spot Account never promises Relay's ≈1 s", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: (b) => (b.originChainId === 1337 ? MOVE_IN.response : routeMoveOut()(b)), acct: account({ usdc: 2_000_000n, avax: 0n, btcb: 10_000n }) });
  const mi = await r.money.review("move-in", { amountUsdc: "6" });
  assert.equal(mi.timeText, "≈1–2 min");
  assert.equal(mi.rows.find((x) => x.key === "time").value, "≈1–2 min");
  r.clock.t = MOVE_OUT.capturedAt;
  const mo = await r.money.review("move-out", { amountUsdc: "2" });
  assert.equal(mo.timeText, "≈1–2 min");
});

test("X18b) the move-out 'How it works' Tip agrees with the card beside it (2 windows from 2026-10-26, the paid route's AVAX)", () => {
  assert.match(PV.howItWorks("move-out", { route: "permit", windows: 1 }), /^One window/);
  assert.match(PV.howItWorks("move-out", { route: "permit", windows: 2 }), /^Two windows/);
  const paid = PV.howItWorks("move-out", { route: "paid", windows: 2 });
  assert.match(paid, /^Two windows/);
  assert.match(paid, /paid in AVAX/);
  assert.doesNotMatch(paid, /No AVAX/);
  assert.match(strip(read("src/wallet/avax/AvaxPanels.jsx")), /howItWorks\(kind, r\)/);
});

/* ── X19 (F19) the card prints where the money lands ─────────────────────── */

test("X19) every review prints the user's own address, shortened, '✓ your wallet' — from the signers, never a quote", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: (b) => (b.originChainId === 1337 ? MOVE_IN.response : b.usePermit ? MOVE_OUT.response : SWAP.response),
    acct: account({ usdc: 5_000_000n, avax: 0n, btcb: 10_000n, aUsdc: 3_000_000n }) });
  const to = async (kind, args) => { const rv = await r.money.review(kind, args); r.money.close(rv); return rv.rows.find((x) => x.key === "to"); };
  const want = "0x0000…dead ✓ your wallet";
  assert.equal((await to("move-in", { amountUsdc: "6" })).value, want);
  r.clock.t = MOVE_OUT.capturedAt;
  assert.equal((await to("move-out", { amountUsdc: "2" })).value, want);
  r.state.acct = account({ usdc: 5_000_000n, avax: AVAX(0.05), aUsdc: 3_000_000n });
  assert.equal((await to("stake", { amountUsdc: "2" })).value, want);
  assert.equal((await to("unstake", { amountUsdc: "all" })).value, want);
  r.clock.t = SWAP.capturedAt;
  assert.equal((await to("swap", { from: "USDC", to: "BTC.b", amount: "2" })).value, want);
});
