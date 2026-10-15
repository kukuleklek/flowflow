/**
 * test-perp-funding-refute — THE AUTOMATIC LAST HOP, ATTACKED.
 * ════════════════════════════════════════════════════════════════════════════
 * A money-safety refutation of the 2026-10-15 change that makes the deposit's
 * last hop (Arbitrum USDC in the customer's own embedded wallet -> the Perp
 * deposit contract) run by itself, app-wide (src/perp/deposit/perpFunding.js,
 * AutoMover.jsx, DepositStatus.jsx, depositPopupView.js).
 *
 * Every test here FAILS against the code as written and names the rule it
 * breaks. Nothing signs, sends or reads a chain: every balance, receipt and
 * signature is a fake, and every address is made up.
 *
 *   RF1  a lagging balance node + a "success" receipt = a second signature
 *   RF2  storage that refuses writes: the attempt is never written down, so an
 *       unresolved attempt is retried by itself
 *   RF3  a network blip before anything was signed leaves the money behind a
 *       button for good (the owner: nobody should have to press)
 *   RF4  two windows: the window that waited says "Moving … No action needed"
 *       while nothing moves anywhere
 *   RF5  a sign-out (or wallet switch) mid-move: the runner re-focuses on the
 *       old wallet, reads it, and can start a NEW move for it
 *   RF6  a mock build: the app-wide mover still drives a real mainnet move
 *   RF7  a withdrawal to the customer's own in-app wallet on Arbitrum is sent
 *       straight back to the Perp account, and the screen never says so
 *   RF8  a transient Relay 429/503 on the first-deposit quote hands a brand-new
 *       account the direct plan, which charges the ~1.22 USDC activation
 *
 * Run: node --test scripts/test-perp-funding-refute.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { autoStubs, bundle, code } from "./lib/perpLiveHarness.mjs";

import * as MV from "../src/perp/deposit/firstDepositMove.js";
import * as PV from "../src/perp/deposit/depositPopupView.js";
import * as F from "../src/lib/relay/firstDeposit.js";
import * as D from "../src/lib/relay/depositAddress.js";
import { PerpMoveError, BRIDGE_MIN_RAW } from "../src/lib/relay/arbitrumBridge.js";
import { routeById } from "../src/lib/relay/routes.js";

const USER = "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e";
const OTHER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const HASH = `0x${"ab".repeat(32)}`;

const FUNDING = "src/perp/deposit/perpFunding.js";
const MOVER = "src/perp/deposit/AutoMover.jsx";
let FD;
let MOVER_LIVE;
let MOVER_MOCK;
before(async () => {
  FD = await bundle({
    entry: FUNDING,
    stubs: autoStubs([FUNDING], {
      keep: ["src/perp/deposit/firstDepositMove.js"],
      extra: { "src/lib/relay/arbitrumBridge.js": { real: "src/lib/relay/arbitrumBridge.js", only: ["readArbitrumUsdcBalance", "moveArbitrumUsdcToPerp", "readArbitrumTxReceipt"] } },
    }),
  });
  const moverStubs = autoStubs([MOVER]);
  MOVER_LIVE = await bundle({ entry: MOVER, stubs: moverStubs, env: { VITE_PERP_BACKEND: "live", DEV: false } });
  MOVER_MOCK = await bundle({ entry: MOVER, stubs: moverStubs, env: { VITE_PERP_BACKEND: "mock", DEV: false } });
});

const fakeStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
};
const tick = () => new Promise((r) => setImmediate(r));
const usdcOf = (raw) => Number(raw) / 1e6;
const signer = (address = USER) => () => ({ address, sendTransaction: async () => HASH });

/* ════════════════════════════════════════════════════════════════════════════
   RF1. 🔴 NEVER TWO SIGNATURES FOR ONE LANDING — against a node that lags.
   perpFunding.js:179-183 clears the written attempt as soon as the receipt says
   "success", even when the balance read in the same look still shows the very
   figure that was moved (a lagging node behind a load-balanced public RPC). The
   only guard left is `notRaw` (perpFunding.js:195, :256), which lives for ONE
   look: the next look (tab visible, a landing, the panel opening) sees the
   record gone, the same figure "new", and signs again. scripts/test-perp-
   funding.mjs F9 accepts exactly this (`signed.length <= 2`).
   ════════════════════════════════════════════════════════════════════════════ */
test("RF1) 🔴 a node that has not caught up, with a 'success' receipt, never earns a second signature on a later look", async () => {
  const storage = fakeStore();
  const signed = [];
  /* The chain, behind a node that answers the pre-move balance for a few more
     reads after the transfer is mined (the receipt, from another node, is
     already "success"). move() reads through the same node, as the lib does. */
  let truth = 25000000n;
  let stale = null;
  let lagLeft = 0;
  const node = () => { if (lagLeft > 0) { lagLeft -= 1; return stale; } return truth; };
  const f = FD.createPerpFunding({
    storage, locks: null, now: () => 1, sender: signer(),
    read: async () => { await tick(); const raw = node(); return { raw, usdc: usdcOf(raw) }; },
    move: async ({ beforeSend }) => {
      await tick();
      const there = node();
      if (there < BRIDGE_MIN_RAW) throw new PerpMoveError("below-minimum", "short");
      beforeSend({ raw: there });
      signed.push(there);
      stale = truth;
      truth = 0n;
      lagLeft = 3;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => { await tick(); return "success"; },
  });
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 1, "the first move");
  /* The customer switches tabs and comes back: one more look. */
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 1, "the same 25 USDC, read back from a lagging node, was signed for a SECOND time");
});

/* ════════════════════════════════════════════════════════════════════════════
   RF2. 🔴 THE ATTEMPT IS WRITTEN DOWN BEFORE SIGNING — unless storage says no.
   firstDepositMove.js:88 swallows a refused setItem ("private mode: the session
   still holds it"), but nothing in the session holds it: perpFunding.js reads
   the record back from storage only (:196, :310, :334). Quota exceeded, or
   site data blocked, and rule 1 is gone: a send that failed AFTER beforeSend
   (Privy may already have broadcast it) is retried by itself as soon as the
   balance changes. scripts/test-perp-first-deposit.mjs H4 pins the opposite
   with working storage.
   ════════════════════════════════════════════════════════════════════════════ */
test("RF2) 🔴 storage that refuses the write: an attempt that failed after beforeSend is still never retried by itself", async () => {
  const m = new Map();
  const full = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: () => { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; },
    removeItem: (k) => m.delete(k),
  };
  let balance = 25000000n;
  const moves = [];
  let failNext = true;
  const f = FD.createPerpFunding({
    storage: full, locks: null, now: () => 1, sender: signer(),
    read: async () => { await tick(); return { raw: balance, usdc: usdcOf(balance) }; },
    move: async ({ beforeSend }) => {
      await tick();
      const there = balance;
      moves.push(there);
      beforeSend({ raw: there });
      if (failNext) { failNext = false; throw new PerpMoveError("send-failed", "The move didn't go through"); }
      balance = 0n;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => null,
  });
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(moves.length, 1);
  assert.equal(f.getState().status, "failed");
  /* Another deposit lands on top (the first send may be in the mempool). */
  balance = 40000000n;
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(moves.length, 1, "an attempt that reached beforeSend was retried BY ITSELF because the record never reached storage");
});

/* ════════════════════════════════════════════════════════════════════════════
   RF3. OWNER: "ทำไมคนต้องมากดเองวะ" — nobody should have to press.
   A balance read that flakes INSIDE move() (perpFunding.js:325, the lib's own
   read) throws "network" / "bad-response" before beforeSend: nothing written,
   nothing signed. perpFunding.js:245-253 then keeps it "failed" until the USDC
   balance changes; only "no-signer" is let go (SIGNER_CODES, :69). One RPC blip
   and the money sits behind "Try the move again" on every page, for good.
   Retrying on the NEXT event (tab back, a landing) is no loop and no second
   signature: there is no attempt to repeat.
   ════════════════════════════════════════════════════════════════════════════ */
test("RF3) a network blip before anything was written down does not leave the money behind a button: the next look moves it", async () => {
  let blip = true;
  const signed = [];
  let balance = 25000000n;
  const storage = fakeStore();
  const f = FD.createPerpFunding({
    storage, locks: null, now: () => 1, sender: signer(),
    read: async () => { await tick(); return { raw: balance, usdc: usdcOf(balance) }; },
    move: async ({ beforeSend }) => {
      await tick();
      if (blip) { blip = false; throw new PerpMoveError("network", "Couldn't reach the network to read your balance"); }
      const there = balance;
      beforeSend({ raw: there });
      signed.push(there);
      balance = 0n;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => null,
  });
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 0);
  assert.equal(MV.readMoveRecord(storage, USER), null, "nothing was written down: there is no attempt to protect");
  /* The tab comes back into view. */
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 1, "the money stayed behind 'Try the move again' after a read that merely flaked");
});

/* ════════════════════════════════════════════════════════════════════════════
   RF4. TWO WINDOWS MUST NOT TELL TWO STORIES (perpFunding.js:364-366 says so).
   Window A's move is refused before anything is written (no gas). Window B was
   locked out (:363), waits, finds no record, and re-reads with auto false
   (:386). Its step is then "auto", and the popup draws "Moving 25 USDC into
   your Perp account… · No action needed" with a spinner (depositPopupView.js
   :315-323) — while nothing moves in either window and A says it failed.
   ════════════════════════════════════════════════════════════════════════════ */
function lockManager() {
  const held = new Map();
  return {
    async request(name, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      while (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        await held.get(name);
      }
      let release;
      held.set(name, new Promise((r) => { release = r; }));
      try { return await cb({ name }); } finally { held.delete(name); release(); }
    },
  };
}

test("RF4) a window that waited on another window's REFUSED move never claims money is moving", { timeout: 20000 }, async () => {
  const storage = fakeStore();
  const locks = lockManager();
  const chain = {
    read: async () => { await tick(); return { raw: 25000000n, usdc: 25 }; },
    move: async () => { await tick(); await tick(); await tick(); throw new PerpMoveError("no-gas", "There is no gas in your own wallet"); },
    receipt: async () => null,
    sender: signer(),
  };
  const tabA = FD.createPerpFunding({ ...chain, storage, locks, now: () => 1 });
  const tabB = FD.createPerpFunding({ ...chain, storage, locks, now: () => 2 });
  await Promise.all([
    tabA.check({ user: USER, connected: USER, auto: true }),
    tabB.check({ user: USER, connected: USER, auto: true }),
  ]);
  const a = FD.fundingStep(tabA.getState(), USER, { canAuto: true });
  const b = FD.fundingStep(tabB.getState(), USER, { canAuto: true });
  assert.equal(a.step, "failed", "window A: refused, with a button");
  const boxB = PV.depositPopupView({ user: USER, move: b });
  assert.notEqual(boxB && boxB.kind, "moving", `window B says "${boxB && boxB.text}" while nothing is moving anywhere`);
});

/* ════════════════════════════════════════════════════════════════════════════
   RF5. ONLY THE SIGNED-IN WALLET. After a move, run() reads "once more" with
   auto (perpFunding.js:397) and check() re-focuses the runner on that wallet
   (:213) even if the app has since focused another wallet or nobody (the
   AutoMover's focus effect, AutoMover.jsx:45, does not run again). The runner
   then reads, and may start a NEW move for, a wallet that is no longer signed
   in; only the Privy bridge dropping its sender in time stands in the way.
   ════════════════════════════════════════════════════════════════════════════ */
test("RF5) a sign-out mid-move: nothing more is read or moved for the wallet that left, and the runner stays on nobody", async () => {
  let balance = 25000000n;
  const reads = [];
  const signed = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = FD.createPerpFunding({
    storage: fakeStore(), locks: null, now: () => 1,
    /* The bridge re-registers a tick after the sign-out: the sender lingers. */
    sender: signer(),
    read: async ({ owner }) => { reads.push(owner); await tick(); return { raw: balance, usdc: usdcOf(balance) }; },
    move: async ({ beforeSend }) => {
      const there = balance;
      beforeSend({ raw: there });
      signed.push(there);
      await gate;
      /* A second deposit lands while the first is being signed. */
      balance = 7000000n;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => null,
  });
  const p = f.check({ user: USER, connected: USER, auto: true });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(signed.length, 1, "the move is in flight");
  /* The customer signs out: the mover focuses nobody. */
  f.focus(null);
  const readsAtSignOut = reads.length;
  release();
  await p;
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(signed.length, 1, "a NEW move (the 7 USDC) was signed for a wallet that is no longer signed in");
  assert.equal(reads.length, readsAtSignOut, "the signed-out wallet's balance was read again");
  assert.equal(f.getState().user, null, "the runner was pulled back onto the wallet that signed out");
});

/* ════════════════════════════════════════════════════════════════════════════
   RF6. NOT IN A MOCK BUILD. The mock dev server (VITE_PERP_BACKEND=mock, port
   5174) loads the same .env.local, so Privy is configured, the bridge registers
   its no-window sender (PrivyBridge.jsx:31 gates on PERP_ENABLED, not on the
   backend) and WalletContext reports walletType "privy". AutoMover.jsx:39 checks
   neither the backend nor anything else: a demo build signed into a real Privy
   account moves real mainnet money by itself, with no panel open.
   ════════════════════════════════════════════════════════════════════════════ */
function mountMover(M) {
  const checks = [];
  const focused = [];
  globalThis.__impl = {
    useWallet: () => ({ address: USER, walletType: "privy" }),
    walletCanFinishFirstHop: (t) => t === "privy",
    landingSig: () => "",
    subscribePrivyApi: () => () => {},
    privyApiSeq: () => 1,
  };
  const watch = { subscribe: () => () => {}, getState: () => ({ entries: [] }), focus: () => {} };
  const funding = {
    canRun: () => true,
    check: (o) => { checks.push(o); return Promise.resolve(null); },
    focus: (w) => focused.push(w),
    run: (o) => { checks.push({ ...o, run: true }); return Promise.resolve(null); },
  };
  const h = M.mount(() => M.default({ watch, funding }));
  h.render();
  h.flush();
  h.unmount();
  return { checks, focused };
}

test("RF6) 🔴 a MOCK build never drives a real move: the app-wide mover stands down", () => {
  const live = mountMover(MOVER_LIVE);
  assert.equal(live.checks.length, 1, "control: a live build asks the runner to read and move");
  const mock = mountMover(MOVER_MOCK);
  const runnerRefusesMock = /PERP_BACKEND|VITE_PERP_BACKEND/.test(code(FUNDING));
  assert.ok(mock.checks.length === 0 || runnerRefusesMock,
    "a VITE_PERP_BACKEND=mock build asked the real runner to move real Arbitrum USDC into the real Perp account");
});

/* ════════════════════════════════════════════════════════════════════════════
   RF7. THE RUNNER CANNOT TELL A DEPOSIT FROM A WITHDRAWAL. The Withdraw sheet
   lets a customer send USDC to their own in-app wallet on Arbitrum
   (withdraw.js:310-338 "a caution, not a block"; WithdrawPanel.jsx:81). The
   runner moves "any balance at or above the floor" (firstDepositMove.js:30), so
   that withdrawal goes straight back into the Perp account on the next look —
   a silent signature the customer never asked for, and the withdraw fee lost.
   Either the screen refuses that destination, or it says so before they send.
   ════════════════════════════════════════════════════════════════════════════ */
test("RF7) a withdrawal to the customer's own in-app wallet is refused, or the caution says it goes straight back", async () => {
  const W = await import("../src/lib/relay/withdraw.js");
  /* The runner does move such money by itself (the balance is all it sees). */
  const signed = [];
  let balance = 20000000n;
  const f = FD.createPerpFunding({
    storage: fakeStore(), locks: null, now: () => 1, sender: signer(),
    read: async () => ({ raw: balance, usdc: usdcOf(balance) }),
    move: async ({ beforeSend }) => { const there = balance; beforeSend({ raw: there }); signed.push(there); balance = 0n; return { txHash: HASH, raw: there, usdc: usdcOf(there) }; },
    receipt: async () => null,
  });
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 1, "control: the 20 USDC the customer withdrew to their own wallet was moved back by itself");
  const dest = W.validateWithdrawDestination(USER, { own: USER });
  const caution = W.inAppWithdrawCaution({ address: USER, wallet: USER, walletType: "privy" });
  const refused = dest.ok === false;
  const told = typeof caution === "string" && /Perp account/i.test(caution);
  assert.ok(refused || told, `the customer is told only: "${caution}"`);
});

/* ════════════════════════════════════════════════════════════════════════════
   RF8. THE ROUTE WITH NO 1.22 (owner: "มันมีเส้นทางที่ไม่ต้องเสีย 1.22"). Not
   introduced by this change, but still open: FALL_BACK_ON (firstDeposit.js:265)
   includes "relay-error", which postQuote (depositAddress.js:510-512) raises for
   ANY non-2xx — a 429 rate limit or a 503 included. A transient error on the
   first-deposit quote therefore hands a brand-new account the DIRECT plan's
   address, whose first deposit pays the ~1.22 USDC activation, and the plan is
   then frozen for the open sheet (usePerpDeposit.js useDepositPlan). A network
   error ("network") does NOT fall back; a 429/503 is no less transient.
   ════════════════════════════════════════════════════════════════════════════ */
const answer = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const MIN_CHAINS = [
  { id: 1337, depositEnabled: true, disabled: false, vmType: "hypevm", solverCurrencies: [{ address: "0x00000000000000000000000000000000", symbol: "USDC", decimals: 8 }] },
  { id: 8453, depositEnabled: true, disabled: false, vmType: "evm", solverCurrencies: [{ address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 }] },
];
test("RF8) a transient 429 / 503 on the first-deposit quote never hands a brand-new account the 1.22-activation route", async () => {
  for (const status of [429, 503]) {
    const posts = [];
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith("/chains")) return answer({ chains: MIN_CHAINS });
      const body = JSON.parse(init.body);
      posts.push(body);
      if (posts.length === 1) return answer({ message: status === 429 ? "Too many requests" : "Service unavailable" }, false, status);
      return answer({ message: "the direct plan was asked" }, false, 400);
    };
    await assert.rejects(() => F.getDepositAddressForPlan({
      planId: F.FIRST_HOP_PLAN_ID,
      user: USER, connected: USER, route: routeById("base-usdc"),
      storage: fakeStore(), memory: new Map(), chainsMemo: D.newRelayChainsMemo(),
      network: "mainnet", timers: { setTimeout: () => 1, clearTimeout: () => {} }, now: () => 1759000000000,
      fetchImpl,
    }));
    assert.deepEqual(posts.map((p) => p.destinationChainId), [42161],
      `HTTP ${status} on the no-activation quote fell back to the direct (1.22 USDC activation) plan`);
  }
});

/* Sanity: the floor this file leans on is the lib's own. */
test("RF0) the floor is 5 USDC in base units", () => {
  assert.equal(BRIDGE_MIN_RAW, 5000000n);
});
