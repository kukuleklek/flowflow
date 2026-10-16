/**
 * test-avax-money-hooks — THE SPOT ACCOUNT'S MONEY ACTIONS (src/avax/money.js), the
 * flow watcher (src/avax/watchFlows.js), the read helpers (src/lib/avax/txHelpers.js)
 * and the one pin table (src/lib/avax/relayPins.js re-exporting config / whitelist).
 *
 * 🔴 MONEY SAFETY. Nothing here signs, holds a key or reaches a network: every signer,
 * sender, RPC and fetch is a recorder fed by the read-only fixtures in
 * scripts/fixtures/avax (live quotes captured 2026-10-15). The fake signers run the
 * SIGNER AGENT'S OWN closed builders (src/avax/closedTx.js) on every request, so a
 * request these hooks build that the real signer would refuse fails here.
 *
 * Run: node --test scripts/test-avax-money-hooks.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const M = await imp("src/avax/money.js");
const WF = await imp("src/avax/watchFlows.js");
const FL = await imp("src/avax/flows.js");
const TH = await imp("src/lib/avax/txHelpers.js");
const PINS = await imp("src/lib/avax/relayPins.js");
const C = await imp("src/lib/avax/config.js");
const W = await imp("src/lib/avax/whitelist.js");
const SD = await imp("src/lib/avax/swapDecode.js");
const SW = await imp("src/lib/relay/swap.js");
const MO = await imp("src/lib/relay/moveOut.js");
const CT = fs.existsSync(path.join(ROOT, "src/avax/closedTx.js")) ? await imp("src/avax/closedTx.js") : null;

const FIX = path.join(ROOT, "scripts/fixtures/avax");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

const DEAD = "0x000000000000000000000000000000000000dead";
const ONE = "0x1111111111111111111111111111111111111111";
const OTHER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SIG = `0x${"ab".repeat(65)}`;
const GWEI = 1_000_000_000n;
const AVAX = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const MOVE_IN = load("live-move-in-6-topup.json");
const MOVE_OUT = load("live-move-out-2.json");
const SWAP = load("live-swap-usdc-btcb-2.json");
const LEG_50 = load("swap-gasleg-q-usdc-avax-500000.json");
const Q11 = load("relay-q11-back-plain.json");

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
const hashOf = (n) => `0x${n.toString(16).padStart(64, "0")}`;

/** readAvaxAccount's shape. `assets: false` = an account whose asset list nobody could read. */
function account({ owner = DEAD, usdc = 0n, avax = 0n, btcb = 0n, aUsdc = 0n, allowance = 0n, status = STATUS, assets = true } = {}) {
  const rows = [
    { symbol: "USDC", native: false, raw: usdc, decimals: 6 }, { symbol: "AVAX", native: true, raw: avax, decimals: 18 },
    { symbol: "WAVAX", native: false, raw: 0n, decimals: 18 }, { symbol: "BTC.b", native: false, raw: btcb, decimals: 8 },
    { symbol: "USDT", native: false, raw: 0n, decimals: 6 }, { symbol: "XAUt0", native: false, raw: 0n, decimals: 6 },
  ];
  return {
    owner, chainId: 43114, readAt: 0, avaxWei: avax,
    ...(assets ? { assets: rows } : {}),
    balances: Object.fromEntries(rows.map((r) => [r.symbol, r.raw])),
    aave: { suppliedRaw: aUsdc, suppliedUsdc: Number(aUsdc) / 1e6, poolAllowanceRaw: allowance, status },
  };
}

/**
 * A controller over fakes. `quote(body)` answers every POST /quote/v2 (a fixture's
 * response, or { status } for a refusal). Every request is logged.
 */
function rig({
  own = DEAD, at, env = { VITE_EARN: "on" }, acct = account({ owner: own }), quote = () => ({ status: 500 }),
  mids = { AVAX: 9.5, BTC: 81_433 }, relay = { USDC: 1, AVAX: 9.5, "BTC.b": 81_433 }, baseFeeGwei = 5,
  perp = { balance: { answered: true, availableUsdc: 50 }, positions: { answered: true, list: [], complete: true } },
  onTx = null, onSend = null, onTyped = null, preflight = async () => ({ ok: true }), receipt = async () => ({ status: 1 }),
  signers: makeSigners = true, chainTx = null,
} = {}) {
  const clock = { t: at };
  const now = () => clock.t;
  const storage = new MemStorage();
  const registry = FL.createFlowRegistry({ storage, own, now, locks: null });
  const log = [];
  const state = { acct };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    log.push(["fetch", u.replace(/\?.*/, ""), body]);
    if (u.endsWith("/quote/v2")) {
      const r = quote(body);
      return r && r.status ? badRes(r.status, r.message) : okRes(clone(r));
    }
    if (u.includes("/authorize") || u.includes("/execute/permits")) return okRes({});
    throw new Error(`unexpected fetch ${u}`);
  };
  let n = 0;
  /* The wallet's nonces as Avalanche would answer them: each tx a window sends takes the next
     nonce and is mined at once. `chainTx(n, chain)` may stand in for what one window does
     (e.g. Privy's "Retry transaction": two txs, the last hash handed back). */
  const chain = { nonce: 7n, byHash: new Map() };
  const signers = makeSigners ? {
    own,
    async sendAvaxTx(tx, o = {}) {
      log.push(["tx", tx, o.check]);
      /* The signer agent's own closed builder must accept every tx these hooks build. */
      if (CT) assert.ok(CT.avaxTxFromRequest(tx, o.check, own), `the closed builder accepts the ${o.check && o.check.kind} tx`);
      n += 1;
      const h = await (onTx ? onTx(tx, o, n) : hashOf(n));
      if (chainTx) chainTx(n, chain, h);
      else if (typeof h === "string") { chain.byHash.set(h, chain.nonce); chain.nonce += 1n; }
      return h;
    },
    async signAvaxTypedData(td, o = {}) {
      log.push(["typed", td.primaryType]);
      if (CT) assert.ok(CT.avaxTypedDataFromRequest(td, o.review, own, { now: clock.t }), "the closed builder accepts the permit");
      return onTyped ? onTyped(td, o) : SIG;
    },
    async signAuthorize(step) { log.push(["auth", step.id]); return { ok: true, signature: SIG }; },
    async sendDeposit(o) { log.push(["send", o]); return onSend ? onSend(o) : { ok: true }; },
  } : null;
  const money = M.createAvaxMoney({
    own, registry, env, signers: () => signers, now, timers: NO_TIMERS, fetchImpl,
    getPerp: () => perp, getMids: () => mids,
    readAccount: async () => { log.push(["read-account"]); return state.acct; },
    readFee: async () => ({ baseFeeWei: BigInt(baseFeeGwei) * GWEI }),
    readPrices: async () => relay,
    readSettlers: async () => [...PINS.KNOWN_SETTLERS],
    preflight: async (tx, o) => { log.push(["preflight", tx.to]); return preflight(tx, o); },
    waitReceipt: async (h) => { log.push(["receipt", h]); return receipt(h); },
    readPendingNonce: async () => chain.nonce,
    readLatestNonce: async () => chain.nonce,
    readTxNonce: async (h) => (chain.byHash.has(h) ? chain.byHash.get(h) : null),
  });
  return { money, registry, storage, log, clock, state, signers, chain };
}

const quoteBodies = (log) => log.filter((x) => x[0] === "fetch" && x[1].endsWith("/quote/v2")).map((x) => x[2]);
const routeMoveIn = (body) => (body.originChainId === 1337 ? MOVE_IN.response : { status: 500 });
const routeMoveOut = (json = MOVE_OUT.response) => (body) => (body.originChainId === 43114 && body.destinationChainId === 1337 && body.usePermit ? json : { status: 500 });

/* ── caps, flags, own ─────────────────────────────────────────────────────── */

test("H1) caps: ≤ 20 USDC per move / stake, ≤ $20 per swap; env may LOWER them, never raise them", async () => {
  const three = (c) => ({ moveUsdc: c.moveUsdc, stakeUsdc: c.stakeUsdc, swapUsd: c.swapUsd });
  assert.deepEqual(three(M.resolveCaps({})), { moveUsdc: 20, stakeUsdc: 20, swapUsd: 20 });
  assert.deepEqual({ ...M.HARD_CAPS }, { moveUsdc: 20, stakeUsdc: 20, swapUsd: 20 });
  assert.deepEqual(three(M.resolveCaps({ VITE_MAX_MOVE_USDC: "5", VITE_MAX_STAKE_USDC: "3", VITE_MAX_SWAP_USD: "2" })), { moveUsdc: 5, stakeUsdc: 3, swapUsd: 2 });
  assert.deepEqual(three(M.resolveCaps({ VITE_MAX_MOVE_USDC: "500", VITE_MAX_STAKE_USDC: "1e9", VITE_MAX_SWAP_USD: "garbage" })), { moveUsdc: 20, stakeUsdc: 20, swapUsd: 20 });
  assert.equal(M.resolveCaps({ VITE_SWAP_MAX_LOSS_PCT: "9" }).swapMaxLossPct, 2, "the loss bound cannot be raised either");
  assert.equal(M.resolveCaps({ VITE_SWAP_MAX_LOSS_PCT: "1" }).swapMaxLossPct, 1);
  assert.equal(M.resolveCaps({ VITE_MAX_MOVE_USDC: "0" }).moveUsdc, 0, "0 turns moves off");

  const r = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, acct: account({ usdc: 30_000_000n, avax: AVAX(1), aUsdc: 30_000_000n }) });
  for (const [kind, args] of [["move-in", { amountUsdc: "21" }], ["move-out", { amountUsdc: "20.5" }], ["stake", { amountUsdc: "20.000001" }], ["swap", { from: "USDC", to: "BTC.b", amount: "25" }]]) {
    const rv = await r.money.review(kind, args);
    assert.equal(rv.confirmable, false, kind);
    assert.match(rv.whyNot, /Max \$?20/, kind);
    assert.equal(rv.id, null, `${kind}: no record, so no Confirm`);
  }
  assert.equal(quoteBodies(r.log).length, 0, "an amount over the cap is never even quoted");
  const low = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, env: { VITE_EARN: "on", VITE_MAX_MOVE_USDC: "5" } });
  assert.match((await low.money.review("move-in", { amountUsdc: "6" })).whyNot, /Max 5 USDC/);
  /* 6 decimals at most, and a real amount. */
  for (const bad of ["", "abc", "-1", "1.0000001", "0"]) assert.equal((await r.money.review("move-in", { amountUsdc: bad })).whyNot, "Enter an amount", bad);
});

test("H2) entries need VITE_EARN=on; exits (move out, unstake, swap X → USDC) never do", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, env: {}, acct: account({ usdc: 5_000_000n, avax: AVAX(1), aUsdc: 5_000_000n, btcb: 10_000n }) });
  assert.equal((await r.money.review("move-in", { amountUsdc: "2" })).whyNot, "Not on yet");
  assert.equal((await r.money.review("stake", { amountUsdc: "2" })).whyNot, "Not on yet");
  assert.equal((await r.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" })).whyNot, "Not on yet");
  assert.notEqual((await r.money.review("move-out", { amountUsdc: "2" })).whyNot, "Not on yet");
  assert.notEqual((await r.money.review("unstake", { amountUsdc: "all" })).whyNot, "Not on yet");
  assert.notEqual((await r.money.review("swap", { from: "BTC.b", to: "USDC", amount: "0.00002" })).whyNot, "Not on yet");
  assert.equal(M.entriesOn({ VITE_EARN: "on" }), true);
  assert.equal(M.entriesOn({ VITE_EARN: "true" }), false, "the same exact flag the Spot Account pills read");
});

test("H3) own only: every quote names the user's own address in every role; a caller cannot add a recipient", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: (b) => (b.originChainId === 1337 ? MOVE_IN.response : b.usePermit ? MOVE_OUT.response : b.originChainId === 43114 && b.destinationChainId === 43114 ? SWAP.response : { status: 500 }),
    acct: account({ usdc: 5_000_000n, avax: 0n, btcb: 10_000n }) });
  await r.money.review("move-in", { amountUsdc: "6", recipient: OTHER, to: OTHER });
  await r.money.review("move-out", { amountUsdc: "2", recipient: OTHER });
  const bodies = quoteBodies(r.log);
  assert.ok(bodies.length >= 2);
  for (const b of bodies) {
    assert.deepEqual([b.user, b.recipient, b.refundTo].map((x) => x.toLowerCase()), [DEAD, DEAD, DEAD]);
    assert.ok(!JSON.stringify(b).toLowerCase().includes(OTHER.slice(2)), "the other address never reaches a quote");
  }
  /* The controller is bound to one account: a registry for another account is refused. */
  const reg = FL.createFlowRegistry({ storage: new MemStorage(), own: ONE, locks: null });
  assert.throws(() => M.createAvaxMoney({ own: DEAD, registry: reg }), /own address/);
});

/* ── move in ──────────────────────────────────────────────────────────────── */

test("H4) move in: the gas top-up only when AVAX < reserve, PRINTED; Confirm → authorize, registry, sendAsset capped at the card's debit", async () => {
  /* BTC.b worth ~$8 counts one swap-back: reserve 0.024 AVAX; 0 AVAX → $0.30 of gas (0.024 × 9.5 × 1.25 → 0.30). */
  const r = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, acct: account({ avax: 0n, btcb: 10_000n }) });
  const rv = await r.money.review("move-in", { amountUsdc: "6" });
  assert.equal(rv.confirmable, true, rv.whyNot);
  const [body] = quoteBodies(r.log);
  assert.equal(body.topupGas, true);
  assert.equal(body.topupGasAmount, "300000");
  assert.equal(rv.gasText, "includes ≈0.0315 AVAX for gas (≈$0.30)");
  assert.match(rv.gasRowText, /≈0\.0315 AVAX \(\$0\.30\) · stays in your Spot Account/);
  assert.deepEqual(rv.rows.map((x) => x.key), ["amount", "debit", "fee", "gas", "receive", "to", "time", "windows"]);
  assert.equal(rv.rows.find((x) => x.key === "debit").value, "6.342288 USDC");
  assert.equal(rv.rows.find((x) => x.key === "receive").value, "6 USDC");
  assert.equal(rv.windows, 2);
  assert.ok(Object.isFrozen(rv) && !("q" in rv) && !("int" in rv), "the UI gets display figures only");
  const rec = r.registry.get(rv.id);
  assert.equal(rec.state, "review");
  assert.equal(rec.maxDebit, 6.7);
  assert.deepEqual({ out: rec.amounts.out, topupUsd: rec.amounts.topupUsd }, { out: "6", topupUsd: 0.3 });

  const out = await r.money.confirm(rv);
  assert.equal(out.ok, true, out.message);
  assert.equal(out.state, "arriving");
  assert.equal(out.requestId, MOVE_IN.response.requestId);
  const seq = r.log.filter((x) => ["auth", "send"].includes(x[0]) || (x[0] === "fetch" && x[1].endsWith("/authorize")));
  assert.deepEqual(seq.map((x) => x[0] === "fetch" ? "post" : x[0]), ["auth", "post", "send"]);
  assert.equal(seq[2][1].maxDebitUsdc, 6.7, "the sendAsset is capped at the card's own ceiling");
  assert.equal(seq[2][1].amountUsdc, 6.342288);
  assert.equal(r.registry.get(rv.id).state, "arriving");
  assert.equal(r.registry.get(rv.id).requestId, MOVE_IN.response.requestId);

  /* Enough AVAX: no top-up asked, none printed. */
  const r2 = rig({ at: MOVE_IN.capturedAt, quote: (b) => (b.topupGas ? MOVE_IN.response : { status: 400, message: "no plain fixture" }), acct: account({ avax: AVAX(1) }) });
  const rv2 = await r2.money.review("move-in", { amountUsdc: "6" });
  assert.equal(quoteBodies(r2.log)[0].topupGas, undefined, "AVAX ≥ reserve: no topupGas in the body");
  assert.equal(rv2.gasText, null);
});

test("H5) a double Confirm is ONE run: the second call is 'already-run' (not a failure) and touches nothing", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, acct: account({ avax: 0n, btcb: 10_000n }) });
  const rv = await r.money.review("move-in", { amountUsdc: "6" });
  const p1 = r.money.confirm(rv);
  const p2 = r.money.confirm(rv); /* same tick: the gate is synchronous */
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.alreadyRun, true);
  assert.equal(b.code, "already-run");
  assert.equal(r.log.filter((x) => x[0] === "send").length, 1);
  assert.equal(r.log.filter((x) => x[0] === "auth").length, 1);
  /* …and later too. */
  const c = await r.money.confirm(rv);
  assert.equal(c.alreadyRun, true);
  assert.equal(r.log.filter((x) => x[0] === "send").length, 1);
});

test("H6) unknown is never success: a lost sendAsset reply is 'unknown' with where to look, and stays watched", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, acct: account({ avax: 0n, btcb: 10_000n }),
    onSend: () => ({ ok: false, code: "not_confirmed", lost: true, message: "Hyperliquid didn't confirm this." }) });
  const rv = await r.money.review("move-in", { amountUsdc: "6" });
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, false);
  assert.equal(out.state, "unknown");
  assert.equal(out.unknown, true);
  assert.match(out.message, /Don't send it again/);
  assert.doesNotMatch(out.message, /try again/i);
  assert.match(out.whereToLook.text, /Main Account and your Spot Account/);
  assert.equal(r.registry.get(rv.id).state, "unknown");
  /* A new move cannot start while it is unknown. */
  const next = await r.money.review("move-in", { amountUsdc: "6" });
  assert.equal(next.confirmable, false);
  assert.match(next.whyNot, /isn't confirmed yet/);
  /* The watcher: no evidence → keep; Relay success → done. */
  const rec = r.registry.get(rv.id);
  assert.equal(WF.judgeFlow(rec, { status: { status: "unknown" } }, { now: r.clock.t }).action, "keep");
  assert.equal(WF.judgeFlow(rec, { status: { status: "sending" } }, { now: r.clock.t }).action, "keep");
  assert.equal(WF.judgeFlow(rec, { status: null }, { now: r.clock.t + 3_600_000 }).action, "keep", "a lost reply with an id is never 'nothing moved'");
  /* Relay's success settles the USDC; the move carried a gas top-up, which is NOT in the order, so
     "done" also needs the Spot Account's AVAX up by it (watchFlows rule 8). */
  const gas = BigInt(rec.amounts.topupRaw);
  const j = WF.judgeFlow(rec, { status: { status: "arrived" }, account: account({ avax: gas }) }, { now: r.clock.t });
  assert.deepEqual([j.action, j.state], ["finish", "done"]);
  assert.match(j.evidence, /; gas AVAX \+0\.0315/);
});

test("H7) the Main Account check (plan §3.5): withdrawable, then 15 % from liquidation on every cross position; unknown refuses", () => {
  const bal = { answered: true, availableUsdc: 10 };
  const pos = (list, complete = true) => ({ answered: true, list, complete });
  assert.equal(M.perpMoveCheck({ balance: null, positions: pos([]), debitUsdc: 2 }).why, M.MONEY_WHY.perpLoading);
  assert.equal(M.perpMoveCheck({ balance: bal, positions: pos([]), debitUsdc: 11 }).why, M.MONEY_WHY.perpShort);
  assert.equal(M.perpMoveCheck({ balance: bal, positions: { answered: false, list: [] }, debitUsdc: 2 }).ok, false);
  assert.equal(M.perpMoveCheck({ balance: bal, positions: pos([], false), debitUsdc: 2 }).why, M.MONEY_WHY.perpPartial);
  /* A cross long, mark 100, liq 80 (20 %), size 1: moving 6 lifts liq to 86 (14 %) → refused; 4 → 84 (16 %) → fine. */
  const long = { coin: "ETH", szi: 1, positionValue: 100, liquidationPx: 80, leverage: { type: "cross" } };
  const a = M.perpMoveCheck({ balance: bal, positions: pos([long]), debitUsdc: 6 });
  assert.equal(a.ok, false);
  assert.match(a.why, /ETH within 15% of liquidation/);
  assert.equal(a.liq[0].afterText, "86");
  assert.equal(M.perpMoveCheck({ balance: bal, positions: pos([long]), debitUsdc: 4 }).ok, true);
  /* A short the other way round; isolated positions are not touched by the move. */
  const short = { coin: "BTC", szi: -2, positionValue: 200, liquidationPx: 125, leverage: { type: "cross" } };
  assert.equal(M.perpMoveCheck({ balance: bal, positions: pos([short]), debitUsdc: 10 }).ok, true, "125 → 120 is still 20 % above 100");
  const iso = { ...long, liquidationPx: 99, leverage: { type: "isolated" } };
  assert.equal(M.perpMoveCheck({ balance: bal, positions: pos([iso]), debitUsdc: 6 }).ok, true);
  /* Unknown liquidation price on a cross position: "—", no Confirm. */
  const dash = M.perpMoveCheck({ balance: bal, positions: pos([{ ...long, liquidationPx: null }]), debitUsdc: 1 });
  assert.equal(dash.ok, false);
  assert.equal(dash.liq[0].afterText, "—");
});

test("H8) a move in that would push a position toward liquidation shows the row and no Confirm", async () => {
  const long = { coin: "ETH", szi: 1, positionValue: 100, liquidationPx: 80, leverage: { type: "cross" } };
  const r = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, acct: account({ avax: 0n, btcb: 10_000n }),
    perp: { balance: { answered: true, availableUsdc: 50 }, positions: { answered: true, list: [long], complete: true } } });
  const rv = await r.money.review("move-in", { amountUsdc: "6" });
  assert.equal(rv.confirmable, false);
  assert.match(rv.whyNot, /within 15% of liquidation/);
  assert.equal(rv.rows.find((x) => x.key === "liq-ETH").value, "80 → 86.7");
});

/* ── move out ─────────────────────────────────────────────────────────────── */

test("H9) move out (permit): 0 AVAX, the signature(s) through signAvaxTypedData, then the POST; the record is written first", async () => {
  const r = rig({ at: MOVE_OUT.capturedAt, quote: routeMoveOut(), acct: account({ usdc: 2_000_000n, avax: 0n }) });
  const rv = await r.money.review("move-out", { amountUsdc: "2" });
  assert.equal(rv.confirmable, true, rv.whyNot);
  assert.equal(rv.route, "permit");
  assert.equal(rv.exit, true);
  assert.equal(rv.receiveText, "1.969383 USDC");
  assert.equal(rv.minimumText, "1.903408 USDC");
  assert.equal(rv.feeText, "0.030617 USDC");
  assert.equal(rv.windows, 1);
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, true, out.message);
  assert.equal(out.state, "arriving");
  const typed = r.log.findIndex((x) => x[0] === "typed");
  const post = r.log.findIndex((x) => x[0] === "fetch" && x[1].endsWith("/execute/permits"));
  assert.ok(typed >= 0 && post > typed);
  const rec = r.registry.get(rv.id);
  assert.equal(rec.state, "arriving");
  assert.equal(rec.permitNonce, MOVE_OUT.response.steps[0].items[0].data.sign.value.nonce.toLowerCase());
  assert.equal(rec.amounts.in, "2");
});

test("H10) AD-9 rule 3 for every kind: an expired price is re-quoted at Confirm; WORSE → the new card, nothing signed; same → it runs", async () => {
  const worse = clone(MOVE_OUT.response);
  worse.details.currencyOut.amount = "195000000";
  /* The order the user funds says the same (moveOut.js: its payment IS the printed figures). */
  worse.protocol.v2.orderData.output.payments[0].expectedAmount = "195000000";
  let answer = MOVE_OUT.response;
  const r = rig({ at: MOVE_OUT.capturedAt, quote: (b) => routeMoveOut(answer)(b), acct: account({ usdc: 2_000_000n }) });
  const rv = await r.money.review("move-out", { amountUsdc: "2" });
  r.clock.t += 61_000;
  answer = worse;
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, false);
  assert.equal(out.needsConfirm, true);
  assert.equal(out.code, "requote-worse");
  assert.equal(out.why, "less-arrives");
  assert.equal(r.log.filter((x) => x[0] === "typed").length, 0, "nothing was signed");
  assert.equal(r.registry.get(rv.id).state, "cancelled");
  assert.equal(out.review.confirmable, true, "the new card can be confirmed — with a new tap");
  assert.equal(out.review.receiveText, "1.95 USDC");
  assert.notEqual(out.review.id, rv.id);

  /* The same price again: the run goes on under the first tap. */
  answer = MOVE_OUT.response;
  const r2 = rig({ at: MOVE_OUT.capturedAt, quote: (b) => routeMoveOut(answer)(b), acct: account({ usdc: 2_000_000n }) });
  const rv2 = await r2.money.review("move-out", { amountUsdc: "2" });
  r2.clock.t += 61_000;
  const ok = await r2.money.confirm(rv2);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(r2.log.filter((x) => x[0] === "typed").length, 1);
});

test("H11) permit route refused → the paid exit is offered ONLY when the Spot Account's AVAX pays for it; its txs pass the closed builder", async () => {
  const route = (b) => (b.originChainId === 43114 && b.destinationChainId === 1337 ? Q11.response : { status: 500 });
  const at = 1792044000000;
  const poor = rig({ own: ONE, at, quote: route, acct: account({ owner: ONE, usdc: 10_000_000n, avax: 0n }) });
  const rv0 = await poor.money.review("move-out", { amountUsdc: "10" });
  assert.equal(rv0.route, "paid");
  assert.equal(rv0.confirmable, false);
  assert.match(rv0.whyNot, /^Needs ≈0\.0019 more AVAX for gas$/);
  assert.match(rv0.networkFeeText, /^up to ≈0\.0019 AVAX/);

  const r = rig({ own: ONE, at, quote: route, acct: account({ owner: ONE, usdc: 10_000_000n, avax: AVAX(0.01) }) });
  const rv = await r.money.review("move-out", { amountUsdc: "10" });
  assert.equal(rv.confirmable, true, rv.whyNot);
  assert.equal(rv.route, "paid");
  assert.equal(rv.windows, 2);
  assert.ok(rv.warnings.some((w) => /network fee is paid in AVAX/.test(w)));
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, true, out.message);
  assert.equal(out.state, "arriving");
  const txs = r.log.filter((x) => x[0] === "tx");
  assert.deepEqual(txs.map((x) => [x[2].kind, x[2].index]), [["paid-exit", 0], ["paid-exit", 1]]);
  for (const [, tx] of txs) {
    assert.deepEqual(Object.keys(tx).sort(), ["chainId", "data", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "to", "value"]);
    assert.equal(tx.maxFeePerGas, `0x${(11n * GWEI).toString(16)}`);
  }
  assert.equal(r.log.filter((x) => x[0] === "preflight").length, 2, "each tx simulated from own before its window");
  const rec = r.registry.get(rv.id);
  assert.equal(rec.requestId, Q11.response.requestId, "the deposit's order id is written before its window");
  assert.equal(rec.state, "arriving");
});

/* ── stake / unstake ──────────────────────────────────────────────────────── */

test("H12) stake: exact approve only when the allowance is short, then supply; preflight + receipt each; done with the receipt as evidence", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05), allowance: 0n }) });
  const rv = await r.money.review("stake", { amountUsdc: "2" });
  assert.equal(rv.confirmable, true, rv.whyNot);
  assert.deepEqual(rv.stages.map((s) => s.label), ["Allow exactly 2 USDC for Aave", "Supply 2 USDC to Aave on Avalanche"]);
  assert.match(rv.networkFeeText, /^up to ≈0\.0045 AVAX \(\$0\.04\)$/);
  r.state.acct = account({ usdc: 3_000_000n, avax: AVAX(0.045), aUsdc: 2_000_000n });
  const progress = [];
  const out = await r.money.confirm(rv, { onProgress: (s) => progress.push(s.map((x) => x.state).join(",")) });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.state, "done");
  assert.equal(out.message, "2 USDC is in Aave.");
  assert.equal(out.receiptText, "Aave USDC +2");
  assert.deepEqual(r.log.filter((x) => x[0] === "tx").map((x) => x[2].kind), ["aave", "aave"]);
  const rec = r.registry.get(rv.id);
  assert.equal(rec.state, "done");
  assert.match(rec.evidence, /^receipt status 1 0x0+2; Aave USDC \+2$/);
  assert.ok(progress.length >= 3 && progress[progress.length - 1] === "done,done");

  /* Allowance already enough: one window. */
  const r2 = rig({ at: MOVE_IN.capturedAt, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05), allowance: 2_000_000n }) });
  assert.equal((await r2.money.review("stake", { amountUsdc: "2" })).windows, 1);
});

test("H13) the gas reserve unknown → 'Still loading', no Confirm (never read as 0)", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05), assets: false }) });
  const rv = await r.money.review("stake", { amountUsdc: "2" });
  assert.equal(rv.confirmable, false);
  assert.equal(rv.whyNot, "Still loading");
  assert.equal(rv.id, null);
  /* An account that could not be read at all. */
  const r2 = rig({ at: MOVE_IN.capturedAt, acct: null });
  for (const [k, a] of [["stake", { amountUsdc: "2" }], ["unstake", { amountUsdc: "all" }], ["move-out", { amountUsdc: "2" }], ["swap", { from: "USDC", to: "BTC.b", amount: "2" }]]) {
    assert.equal((await r2.money.review(k, a)).whyNot, "Still loading", k);
  }
  /* Move in with the reserve unknown: no top-up guess, no Confirm, no quote. */
  const r3 = rig({ at: MOVE_IN.capturedAt, quote: routeMoveIn, acct: account({ avax: 0n, assets: false }) });
  assert.equal((await r3.money.review("move-in", { amountUsdc: "6" })).whyNot, "Still loading");
  assert.equal(quoteBodies(r3.log).length, 0);
});

test("H14) a stake that would leave too little AVAX for the way out has no Confirm; a fee spike refuses entries, never the unstake", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, acct: account({ usdc: 5_000_000n, avax: AVAX(0.01) }) });
  assert.match((await r.money.review("stake", { amountUsdc: "2" })).whyNot, /^Needs ≈0\.0055 more AVAX for gas$/);
  const hot = rig({ at: MOVE_IN.capturedAt, baseFeeGwei: 8, acct: account({ usdc: 5_000_000n, avax: AVAX(1), aUsdc: 5_000_000n }) });
  assert.match((await hot.money.review("stake", { amountUsdc: "2" })).whyNot, /fees are high/);
  const un = await hot.money.review("unstake", { amountUsdc: "all" });
  assert.equal(un.confirmable, true, un.whyNot);
  assert.match(un.amountText, /^5 USDC \(all/);
});

test("H15) a refused or reverted Aave preflight opens no window; a reverted supply after the approve says the allowance is left", async () => {
  const r = rig({ at: MOVE_IN.capturedAt, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05) }), preflight: async () => ({ ok: false, reverted: true, text: "Aave USDC is paused right now" }) });
  const rv = await r.money.review("stake", { amountUsdc: "2" });
  assert.equal(rv.confirmable, false);
  assert.equal(rv.whyNot, "Aave USDC is paused right now");

  let calls = 0;
  const r2 = rig({ at: MOVE_IN.capturedAt, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05) }), preflight: async () => { calls += 1; return calls === 3 ? { ok: false, reverted: true, text: "Aave would refuse this right now" } : { ok: true }; } });
  const rv2 = await r2.money.review("stake", { amountUsdc: "2" });
  const out = await r2.money.confirm(rv2);
  assert.equal(out.ok, false);
  assert.equal(out.state, "error-before-money");
  assert.equal(out.allowanceLeft, true);
  assert.match(out.message, /^Allowed but not sent\. Aave would refuse this right now\. Nothing moved\.$/);
  assert.equal(r2.log.filter((x) => x[0] === "tx").length, 1, "only the approve window opened");
  assert.equal(r2.registry.get(rv2.id).allowanceLeft, true);
});

/* ── swap ─────────────────────────────────────────────────────────────────── */

test("H16) swap: independent-price loss bound, trusted Settlers, approve + swap through the closed builder, done with the balance delta", async () => {
  const r = rig({ at: SWAP.capturedAt, quote: (b) => (b.originChainId === 43114 && b.destinationChainId === 43114 ? SWAP.response : { status: 500 }),
    acct: account({ usdc: 5_000_000n, avax: AVAX(0.05) }) });
  const rv = await r.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" });
  assert.equal(rv.confirmable, true, rv.whyNot);
  assert.equal(rv.minimumText, "0.00002456 BTC.b");
  assert.equal(rv.feeText, "0.003 USDC");
  assert.deepEqual(rv.stages.map((s) => s.label), ["Allow exactly 2 USDC for this swap", "Swap 2 USDC for at least 0.00002456 BTC.b"]);
  assert.equal(r.registry.get(rv.id).amounts.minOutRaw, "2456");
  r.state.acct = account({ usdc: 3_000_000n, avax: AVAX(0.045), btcb: 2_470n });
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, true, out.message);
  assert.equal(out.state, "done");
  assert.equal(out.message, "Swapped 2 USDC: BTC.b +0.0000247");
  assert.deepEqual(r.log.filter((x) => x[0] === "tx").map((x) => [x[2].kind, x[2].index]), [["swap", 0], ["swap", 1]]);
  assert.equal(r.registry.get(rv.id).state, "done");

  /* No independent price for what is bought → refused, never "no loss". */
  const nop = rig({ at: SWAP.capturedAt, quote: () => SWAP.response, mids: { AVAX: 9.5 }, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05) }) });
  assert.match((await nop.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" })).whyNot, /No independent price/);
  /* A market 5 % above what the minimum is worth → over the 2 % bound. */
  const lossy = rig({ at: SWAP.capturedAt, quote: () => SWAP.response, mids: { AVAX: 9.5, BTC: 77_000 }, acct: account({ usdc: 5_000_000n, avax: AVAX(0.05) }) });
  assert.match((await lossy.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" })).whyNot, /could lose 5\.\d\d%, over the 2%/);
  /* AVAX in: refused before any quote (rule 2). */
  assert.match((await r.money.review("swap", { from: "AVAX", to: "USDC", amount: "0.1" })).whyNot, /Swaps from AVAX open later/);
  assert.match((await r.money.review("swap", { from: "USDC", to: "AVAX", amount: "1" })).whyNot, /Swaps into AVAX open later/);
});

test("H17) swap with too little AVAX: a PRINTED gas leg (USDC → AVAX) runs first under its own record, then the swap", async () => {
  const r = rig({ at: SWAP.capturedAt, mids: { AVAX: 10.5, BTC: 81_433 }, relay: { USDC: 1, AVAX: 10.5, "BTC.b": 81_433 },
    quote: (b) => (b.destinationCurrency === PINS.NATIVE ? LEG_50.response : SWAP.response),
    acct: account({ usdc: 5_000_000n, avax: AVAX(0.0065) }) });
  const rv = await r.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" });
  assert.equal(rv.confirmable, true, rv.whyNot);
  assert.match(rv.gasText, /^includes ≈0\.0516 AVAX for gas \(≈\$0\.50\)$/);
  assert.match(rv.gasRowText, /from your USDC, stays in your Spot Account/);
  assert.equal(rv.windows, 4);
  assert.equal(rv.stages[0].key, "leg");
  const out = await r.money.confirm(rv);
  assert.equal(out.ok, true, out.message);
  const flows = r.registry.list();
  assert.deepEqual(flows.map((f) => [f.kind, f.state]), [["swap", "done"], ["swap", "done"]]);
  assert.equal(r.log.filter((x) => x[0] === "tx").length, 4);

  /* Not even enough AVAX for the gas leg itself: no Confirm, and the fix is named. */
  const r2 = rig({ at: SWAP.capturedAt, mids: { AVAX: 10.5, BTC: 81_433 }, relay: { USDC: 1, AVAX: 10.5, "BTC.b": 81_433 },
    quote: (b) => (b.destinationCurrency === PINS.NATIVE ? LEG_50.response : SWAP.response), acct: account({ usdc: 5_000_000n, avax: AVAX(0.001) }) });
  const rv2 = await r2.money.review("swap", { from: "USDC", to: "BTC.b", amount: "2" });
  assert.equal(rv2.confirmable, false);
});

/* ── reviews and the registry ─────────────────────────────────────────────── */

test("H18) a refreshed price keeps the card's record when it binds the same move; closing the card cancels it; signers missing → no window", async () => {
  const r = rig({ at: MOVE_OUT.capturedAt, quote: routeMoveOut(), acct: account({ usdc: 2_000_000n, avax: AVAX(0.05) }) });
  const a = await r.money.review("move-out", { amountUsdc: "2" });
  const b = await r.money.refresh(a);
  assert.equal(b.id, a.id, "same move, same record");
  assert.equal(r.registry.list().length, 1);
  /* Another card (another kind or amount): a new record, and the old one is closed. */
  const c = await r.money.review("stake", { amountUsdc: "1" }, b);
  assert.equal(c.confirmable, true, c.whyNot);
  assert.notEqual(c.id, a.id);
  assert.equal(r.registry.get(a.id).state, "cancelled", "the old card's record is closed");
  r.money.close(c);
  assert.equal(r.registry.get(c.id).state, "cancelled");
  const late = await r.money.confirm(c);
  assert.deepEqual([late.ok, late.code], [false, "closed"]);
  assert.equal(r.log.filter((x) => x[0] === "tx").length, 0);

  const ns = rig({ at: MOVE_OUT.capturedAt, quote: routeMoveOut(), acct: account({ usdc: 2_000_000n }), signers: false });
  const rv = await ns.money.review("move-out", { amountUsdc: "2" });
  assert.equal(rv.confirmable, false);
  assert.equal(rv.whyNot, "Your wallet is still loading");
});

/* ── the watcher ──────────────────────────────────────────────────────────── */

function regAt(t0) {
  const clock = { t: t0 };
  const reg = FL.createFlowRegistry({ storage: new MemStorage(), own: DEAD, now: () => clock.t, locks: null });
  return { reg, clock };
}

test("H19) watcher evidence rules: a hash proves only its own step; receipts, permits, balances, and the 15-minute 'unreached' rule", () => {
  const t0 = 1792044000000;
  const H1 = hashOf(1);
  const H2 = hashOf(2);
  const base = { id: "fabcdef1", kind: "swap", state: "unknown", startedAt: t0, updatedAt: t0, tabId: "t1", amounts: { to: "BTC.b", minOutRaw: "2456", toBeforeRaw: "0" } };
  /* The swap's own hash, receipt 1 → done; 0 → nothing moved (reverted). */
  let j = WF.judgeFlow({ ...base, step: "swap", txHash: H2, approveTx: H1 }, { receipt: { status: 1 } }, { now: t0 });
  assert.deepEqual([j.action, j.state], ["finish", "done"]);
  /* A reverted receipt proves "nothing moved" only as the ONE tx of its window (bound to its nonce). */
  j = WF.judgeFlow({ ...base, step: "swap", txHash: H2, approveTx: H1, txNonce: 7 }, { receipt: { status: 0 }, hashNonce: 7n, latestNonce: 8n }, { now: t0 });
  assert.deepEqual([j.action, j.proof.kind], ["settle", "reverted"]);
  assert.equal(WF.judgeFlow({ ...base, step: "swap", txHash: H2, approveTx: H1 }, { receipt: { status: 0 } }, { now: t0 }).action, "keep", "no nonce: not bound");
  /* 🔴 The swap was lost (no hash): txHash is still the APPROVE's — its receipt says nothing about the swap. */
  j = WF.judgeFlow({ ...base, step: "swap", txHash: H1, approveTx: H1 }, { receipt: { status: 1 } }, { now: t0 });
  assert.equal(j.action, "keep");
  /* …unless the nonce moved on AND the bought token arrived. */
  j = WF.judgeFlow({ ...base, step: "swap", txHash: H1, approveTx: H1, txNonce: 7 }, { pendingNonce: 8n, account: account({ btcb: 2_456n }) }, { now: t0 });
  assert.deepEqual([j.action, j.state], ["finish", "done"]);
  j = WF.judgeFlow({ ...base, step: "swap", txHash: H1, approveTx: H1, txNonce: 7 }, { pendingNonce: 8n, account: account({ btcb: 2_000n }) }, { now: t0 });
  assert.equal(j.action, "keep", "less than the minimum arrived: not evidence");
  /* Stopped at its approve: an allowance, nothing moved. */
  j = WF.judgeFlow({ ...base, step: "approve", txHash: H1, approveTx: H1 }, { receipt: { status: 1 } }, { now: t0 });
  assert.deepEqual([j.action, j.proof.kind], ["settle", "approve-only"]);
  /* Another live tab may be running it: only a final success settles it. */
  const live = { ...base, why: FL.LOADED_ELSEWHERE, step: "approve", txHash: H1, approveTx: H1 };
  assert.equal(WF.judgeFlow(live, { receipt: { status: 1 } }, { now: t0 + 60_000 }).action, "keep");
  assert.equal(WF.judgeFlow(live, { receipt: { status: 1 } }, { now: t0 + FL.UNREACHED_IDLE_MS }).action, "settle");
  /* Never reached a money window: settled as nothing-moved only after 15 idle minutes. */
  const bare = { id: "fabcdef2", kind: "move-in", state: "unknown", startedAt: t0, updatedAt: t0, tabId: "t1", why: FL.LOADED_ELSEWHERE };
  assert.equal(WF.judgeFlow(bare, {}, { now: t0 + 60_000 }).action, "keep");
  assert.deepEqual(WF.judgeFlow(bare, {}, { now: t0 + FL.UNREACHED_IDLE_MS }).proof, { kind: "unreached" });
  /* A permit exit: unused AFTER validBefore → nothing moved; used → on its way, not done. */
  const vb = Math.floor(t0 / 1000) + 600;
  const permit = { id: "fabcdef3", kind: "move-out", state: "unknown", startedAt: t0, updatedAt: t0, tabId: "t1", requestId: hashOf(9), permitNonce: hashOf(5), validBefore: vb };
  assert.equal(WF.judgeFlow(permit, { permitUsed: false, permitReadAtS: vb - 10 }, { now: (vb - 10) * 1000 }).action, "keep", "still usable");
  assert.equal(WF.judgeFlow(permit, { permitUsed: null, permitReadAtS: vb + 5 }, { now: (vb + 5) * 1000 }).action, "keep", "unreadable is not unused");
  assert.equal(WF.judgeFlow(permit, { permitUsed: false, permitReadAtS: vb + 5 }, { now: (vb + 5) * 1000 }).proof.kind, "permit-unused");
  const used = WF.judgeFlow(permit, { permitUsed: true, permitReadAtS: vb + 5 }, { now: (vb + 5) * 1000 });
  assert.equal(used.action, "keep");
  assert.match(used.note, /Left your Spot Account/);
  assert.equal(WF.judgeFlow(permit, { status: { status: "refunded" } }, { now: t0 }).state, "refunded");
  /* A move in: the Spot Account holding the exact promise more is evidence; less is not. */
  const mi = { id: "fabcdef4", kind: "move-in", state: "arriving", startedAt: t0, updatedAt: t0, tabId: "t1", requestId: hashOf(9), amounts: { out: "2", beforeRaw: "1000000" } };
  assert.equal(WF.judgeFlow(mi, { status: { status: "sending" }, account: account({ usdc: 3_000_000n }) }, { now: t0 }).state, "done");
  assert.equal(WF.judgeFlow(mi, { status: { status: "sending" }, account: account({ usdc: 2_999_999n }) }, { now: t0 }).action, "keep");
});

test("H20) registry.settleNothingMoved re-checks every proof against the record; finish still refuses 'nothing moved' after money may have left", () => {
  const t0 = 1792044000000;
  const { reg, clock } = regAt(t0);
  const r = reg.begin({ kind: "move-out" });
  reg.confirm(r.id);
  const vb = Math.floor(t0 / 1000) + 600;
  reg.beforeWindow(r.id, { permitNonce: hashOf(5), validBefore: vb, requestId: hashOf(9) });
  reg.markUnknown(r.id, "not_confirmed");
  assert.throws(() => reg.finish(r.id, "error-before-money", "x"), (e) => e.code === "bad-state");
  assert.throws(() => reg.settleNothingMoved(r.id, { kind: "permit-unused", used: false, readAtS: vb + 1 }), (e) => e.code === "no-evidence", "not past validBefore yet");
  clock.t = (vb + 2) * 1000;
  assert.throws(() => reg.settleNothingMoved(r.id, { kind: "permit-unused", used: null, readAtS: vb + 1 }), (e) => e.code === "no-evidence");
  assert.throws(() => reg.settleNothingMoved(r.id, { kind: "unreached" }), (e) => e.code === "bad-state", "it reached a window");
  assert.throws(() => reg.settleNothingMoved(r.id, { kind: "guess" }), (e) => e.code === "no-evidence");
  const done = reg.settleNothingMoved(r.id, { kind: "permit-unused", used: false, readAtS: vb + 1 });
  assert.equal(done.state, "error-before-money");
  assert.match(done.evidence, /permit expired unused/);
  /* A tx: only ITS OWN hash, with the status the proof claims. */
  const s = reg.begin({ kind: "swap" });
  reg.confirm(s.id);
  reg.beforeWindow(s.id, { step: "swap", txNonce: 7 });
  reg.update(s.id, { txHash: hashOf(2) });
  reg.markUnknown(s.id, "swap_unconfirmed");
  assert.throws(() => reg.settleNothingMoved(s.id, { kind: "reverted", txHash: hashOf(3), status: 0, hashNonce: 7, latestNonce: 8 }), (e) => e.code === "no-evidence");
  assert.throws(() => reg.settleNothingMoved(s.id, { kind: "reverted", txHash: hashOf(2), status: 1, hashNonce: 7, latestNonce: 8 }), (e) => e.code === "no-evidence");
  assert.throws(() => reg.settleNothingMoved(s.id, { kind: "approve-only", txHash: hashOf(2), status: 1 }), (e) => e.code === "no-evidence", "it went past its approve");
  /* The reverted hash must be the ONE tx of its window (Privy's Retry): bound to the nonce written before it. */
  assert.throws(() => reg.settleNothingMoved(s.id, { kind: "reverted", txHash: hashOf(2), status: 0 }), (e) => e.code === "no-evidence", "no nonce evidence");
  assert.throws(() => reg.settleNothingMoved(s.id, { kind: "reverted", txHash: hashOf(2), status: 0, hashNonce: 8, latestNonce: 9 }), (e) => e.code === "no-evidence", "a retry at the next nonce");
  assert.equal(reg.settleNothingMoved(s.id, { kind: "reverted", txHash: hashOf(2), status: 0, hashNonce: 7, latestNonce: 8 }).state, "error-before-money");
  /* Unreached: no window id, and idle long enough. */
  const u = reg.begin({ kind: "move-in" });
  reg.confirm(u.id);
  reg.markUnknown(u.id, "x");
  assert.throws(() => reg.settleNothingMoved(u.id, { kind: "unreached" }), (e) => e.code === "bad-state", "idle too short");
  clock.t += FL.UNREACHED_IDLE_MS;
  assert.equal(reg.settleNothingMoved(u.id, { kind: "unreached" }).state, "error-before-money");
  assert.equal(reg.canStart().ok, true, "nothing left unknown");
});

test("H21) createFlowWatcher: polls arriving / unknown only, finishes with Relay's success, never writes without evidence, stops on logout", async () => {
  const t0 = 1792044000000;
  const { reg, clock } = regAt(t0);
  const r = reg.begin({ kind: "move-in", maxDebit: 2.3, amounts: { out: "2", beforeRaw: "0" } });
  reg.confirm(r.id);
  reg.beforeWindow(r.id, { requestId: hashOf(9), hlNonce: 1 });
  reg.update(r.id, { state: "arriving", sentAt: t0 });
  const review = reg.begin({ kind: "stake" });
  let status = "sending";
  const reads = [];
  const changes = [];
  const w = WF.createFlowWatcher({
    registry: reg, own: DEAD, now: () => clock.t, timers: NO_TIMERS, isVisible: () => true, onChange: (id) => changes.push(id),
    deps: {
      readStatus: async (o) => { reads.push(o.requestId); return { status }; },
      readAccount: async () => account({ usdc: 1_000_000n }),
      readReceipt: async () => null, readPermitUsed: async () => null, readPendingNonce: async () => null,
    },
  });
  await w.tick();
  assert.deepEqual(reads, [hashOf(9)], "the review card is not polled");
  assert.equal(reg.get(r.id).state, "arriving");
  assert.equal(w.noteOf(r.id).text, "On its way to your Spot Account.", "arriving reads as on its way, not as a problem");
  await w.tick();
  assert.equal(reads.length, 1, "not due yet (4 s)");
  clock.t += 4_000;
  status = "arrived";
  await w.tick();
  assert.equal(reg.get(r.id).state, "done");
  assert.match(reg.get(r.id).evidence, /^status success 0x0+9$/);
  assert.ok(changes.includes(r.id));
  assert.equal(reg.get(review.id).state, "review");
  w.start();
  assert.equal(w.running(), true);
  w.stop();
  assert.equal(w.running(), false);
});

/* ── read helpers and the pin table ───────────────────────────────────────── */

function rpcFake(answers, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const a = answers[body.method];
    const v = typeof a === "function" ? a(body) : a;
    if (v && v.error) return okRes({ jsonrpc: "2.0", id: body.id, error: v.error });
    return okRes({ jsonrpc: "2.0", id: body.id, result: v });
  };
}

test("H22) txHelpers: preflight from own only (a revert is plain words), receipts with a hard timeout, nonce / permit reads null when unknown", async () => {
  const calls = [];
  const tx = { to: C.AAVE_V3.pool, data: "0x617ba037", value: "0x0" };
  assert.deepEqual(await TH.preflightTx(tx, DEAD, { fetchImpl: rpcFake({ eth_call: "0x" }, calls), timers: NO_TIMERS }), { ok: true });
  assert.deepEqual(calls, ["eth_call"]);
  const rev = await TH.preflightTx(tx, DEAD, { fetchImpl: rpcFake({ eth_call: { error: { code: 3, message: "execution reverted", data: "0xd37f5f1c" } } }), timers: NO_TIMERS });
  assert.equal(rev.ok, false);
  assert.equal(rev.reverted, true);
  assert.equal(typeof rev.text, "string");
  const before = calls.length;
  assert.equal((await TH.preflightTx({ ...tx, from: OTHER }, DEAD, { fetchImpl: rpcFake({ eth_call: "0x" }, calls), timers: NO_TIMERS })).ok, false);
  assert.equal(calls.length, before, "another sender is never simulated");
  assert.equal((await TH.preflightTx(tx, DEAD, { fetchImpl: async () => { throw new Error("down"); }, timers: NO_TIMERS })).reverted, false);

  /* Receipts: mined on the third read; a never-mined hash is null after the timeout, never "failed". */
  const clock = { t: 0 };
  const timers = { setTimeout: (fn, ms) => { if (ms <= 5_000) { clock.t += ms; Promise.resolve().then(fn); } return 1; }, clearTimeout: () => {} };
  let n = 0;
  const mined = rpcFake({ eth_getTransactionReceipt: () => { n += 1; return n < 3 ? null : { status: "0x1", blockNumber: "0x10", gasUsed: "0x5208", effectiveGasPrice: "0x1" }; } });
  const rc = await TH.waitReceipt(hashOf(1), { fetchImpl: mined, timers, now: () => clock.t, timeoutMs: 30_000, pollMs: 2_000 });
  assert.equal(rc.status, 1);
  assert.equal(n, 3);
  clock.t = 0;
  const never = await TH.waitReceipt(hashOf(1), { fetchImpl: rpcFake({ eth_getTransactionReceipt: null }), timers, now: () => clock.t, timeoutMs: 10_000, pollMs: 2_000 });
  assert.equal(never, null);
  assert.equal(await TH.waitReceipt("0x12", {}), null);

  assert.equal(await TH.readPendingNonce(DEAD, { fetchImpl: rpcFake({ eth_getTransactionCount: "0x7" }), timers: NO_TIMERS }), 7n);
  assert.equal(await TH.readPendingNonce(DEAD, { fetchImpl: rpcFake({ eth_getTransactionCount: { error: { code: -32000, message: "x" } } }), timers: NO_TIMERS }), null);
  const one = `0x${"0".repeat(63)}1`;
  assert.equal(await TH.readPermitUsed({ own: DEAD, nonce: hashOf(5) }, { fetchImpl: rpcFake({ eth_call: one }), timers: NO_TIMERS }), true);
  assert.equal(await TH.readPermitUsed({ own: DEAD, nonce: hashOf(5) }, { fetchImpl: rpcFake({ eth_call: "0x" }), timers: NO_TIMERS }), null);
  assert.equal(await TH.readPermitUsed({ own: DEAD, nonce: "0x12" }, {}), null);
});

test("H23) ONE pin table: relayPins re-exports config / whitelist (same values, same rows); XSGD off unless its one flag says on", () => {
  assert.equal(PINS.AVAX_USDC, C.USDC);
  assert.equal(PINS.USDC_PERMIT_DOMAIN, C.USDC_EIP712_DOMAIN);
  assert.equal(PINS.HL_DEPOSITORY, C.RELAY_HL_DEPOSITORY);
  assert.equal(PINS.AVAX_DEPOSITORY, C.RELAY_AVAX.depository);
  assert.equal(PINS.RELAY_SOLVERS, C.RELAY_AVAX.solvers);
  assert.equal(PINS.ALLOWANCE_HOLDER, C.RELAY_AVAX.allowanceHolder);
  assert.equal(PINS.MULTICALL3, C.MULTICALL3);
  assert.deepEqual(PINS.SWAP_TOKENS.map((t) => [t.symbol, t.address, t.decimals]), W.AVAX_ASSETS.map((a) => [a.symbol, a.address, a.decimals]));
  const xsgd = PINS.SWAP_TOKENS.find((t) => t.symbol === "XSGD");
  assert.equal(xsgd.on, false);
  assert.equal(PINS.swapTokenBySymbol("XSGD"), null);
  assert.equal(PINS.swapTokenBySymbol("XSGD", { allowOff: true }), xsgd);
  const wl = W.AVAX_ASSETS.find((a) => a.symbol === "XSGD");
  assert.equal(W.assetEnabled(wl, {}), false);
  assert.equal(W.assetEnabled(wl, { VITE_SWAP_XSGD: "on" }), true, "the one rule both tables read");
  assert.deepEqual(PINS.SWAP_EXCLUDED, { bUSDC: "0x038dbe3d967bb8389190446dacdfe7b95b44f73d", PHAR: "0x13a466998ce03db73abc2d4df3bbd845ed1f28e7" });
  assert.ok(Object.isFrozen(PINS.SWAP_TOKENS[0]));
});

test("H24) nothing new signs silently, switches chain or sends raw: the new files hold none of it", () => {
  for (const f of ["src/avax/money.js", "src/avax/useAvaxMoney.js", "src/avax/watchFlows.js", "src/avax/cardState.js", "src/lib/avax/txHelpers.js", "src/lib/avax/relayPins.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["showWalletUIs", "switchChain", "eth_sendRawTransaction", "eth_sendTransaction", "privySilent", "VITE_RELAY", "RELAY_API_KEY", "x-api-key"]) {
      assert.ok(!src.includes(bad), `${f} must not contain ${bad}`);
    }
  }
});
