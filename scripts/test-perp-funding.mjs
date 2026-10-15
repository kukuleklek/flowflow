/**
 * test-perp-funding — THE LAST HOP MOVES BY ITSELF, AND A BOX SAYS WHERE THE MONEY IS.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "ทำไมเงิน ไม่ Move To Account แบบ Auto วะ ทุกเชนเลย ทำไมคนต้อง
 * มากดเองวะ" / "มันมีเส้นทางที่ไม่ต้องเสีย 1.22" — the deposit that lands in the
 * customer's own wallet on Arbitrum (the route with no one-time cost) goes the
 * rest of the way by itself, on every chain, with no panel open and no press;
 * and "ตอน Deposit Asset Pending อยู่ ต้องมีขึ้นบนจอด้วยดิ เป็นกล่อง popup ว่า
 * Pending" — while it is on its way, a box on every page says so.
 *
 * WHAT THIS PINS
 *
 *   F. the runner (src/perp/deposit/perpFunding.js), with every dependency faked:
 *      one move per tab however many callers, the record re-read before the
 *      signature, money already there moving by itself, an unresolved attempt
 *      never moving by itself, the floor, an unreadable balance, only the
 *      customer's own wallet, and the sent / failed transitions;
 *   P. the popup's words (src/perp/deposit/depositPopupView.js): one box per
 *      state, silent while the Deposit panel is open, no provider and no venue,
 *      and "in your Perp account" only when it is;
 *   S. source guards: the mover and the popup are mounted once, the mover never
 *      starts a move except through the runner's checks, nothing polls, and the
 *      preview exists in a dev build only.
 *
 * Nothing here signs, sends or reads a chain: every balance, receipt and
 * signature is a fake, and every address is made up.
 *
 * Run: node --test scripts/test-perp-funding.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { autoStubs, bundle, code } from "./lib/perpLiveHarness.mjs";

import * as MV from "../src/perp/deposit/firstDepositMove.js";
import * as PV from "../src/perp/deposit/depositPopupView.js";
import * as W from "../src/perp/deposit/depositWatch.js";
import { PerpMoveError, BRIDGE_MIN_RAW } from "../src/lib/relay/arbitrumBridge.js";
import { FIRST_HOP_PLAN_ID } from "../src/lib/relay/firstDeposit.js";

const USER = "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e";
const OTHER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const DEP = "0xd8236f7217cef2aa2e1627eded1ae59de850e341";
const HASH = `0x${"ab".repeat(32)}`;
const HASH2 = `0x${"cd".repeat(32)}`;

const FUNDING = "src/perp/deposit/perpFunding.js";
let FD;
before(async () => {
  FD = await bundle({
    entry: FUNDING,
    stubs: autoStubs([FUNDING], {
      keep: ["src/perp/deposit/firstDepositMove.js"],
      extra: { "src/lib/relay/arbitrumBridge.js": { real: "src/lib/relay/arbitrumBridge.js", only: ["readArbitrumUsdcBalance", "moveArbitrumUsdcToPerp", "readArbitrumTxReceipt"] } },
    }),
  });
});

const fakeStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
};
const tick = () => new Promise((r) => setImmediate(r));
const usdcOf = (raw) => Number(raw) / 1e6;

/**
 * A runner over a fake chain. `balance` is base units as a string (null:
 * unreadable). A move reads the chain itself (as the lib does), refuses below
 * the floor, calls beforeSend, "signs", and empties the wallet.
 *
 *   failBefore   a refusal before the signature (nothing written down)
 *   fail         a refusal after beforeSend (the attempt IS written down)
 *   beforeSign   runs just before beforeSend: another tab acting in between
 */
function world({ raw = "25000000", storage = fakeStore(), signer = USER, receipt = null, fail = null, failBefore = null, locks = null } = {}) {
  const calls = { reads: 0, moves: 0, signed: [], receipts: [] };
  let balance = raw;
  const hooks = { beforeSign: null };
  const f = FD.createPerpFunding({
    storage,
    locks,
    now: () => 5000,
    read: async ({ owner }) => {
      calls.reads += 1;
      assert.equal(owner, USER.toLowerCase(), "only ever this wallet's own balance");
      await tick();
      if (balance === null) throw new PerpMoveError("network", "unreadable");
      return { raw: BigInt(balance), usdc: usdcOf(balance), readAt: 1 };
    },
    move: async ({ owner, connected, sender, beforeSend }) => {
      calls.moves += 1;
      if (!sender) throw new PerpMoveError("no-signer", "no signer");
      assert.equal(owner, connected.toLowerCase());
      await tick();
      if (balance === null) throw new PerpMoveError("network", "unreadable");
      const there = BigInt(balance);
      if (there < BRIDGE_MIN_RAW) throw new PerpMoveError("below-minimum", "short");
      if (failBefore) throw failBefore;
      if (hooks.beforeSign) hooks.beforeSign();
      beforeSend({ raw: there, usdc: usdcOf(there), call: {} });
      if (fail) throw fail;
      calls.signed.push(there);
      await tick();
      balance = "0";
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async ({ txHash }) => {
      calls.receipts.push(txHash);
      await tick();
      if (receipt instanceof Error) throw receipt;
      return typeof receipt === "function" ? receipt() : receipt;
    },
    sender: () => (signer ? { address: signer, sendTransaction: async () => HASH } : null),
  });
  const statuses = [];
  f.subscribe(() => { const s = f.getState().status; if (statuses[statuses.length - 1] !== s) statuses.push(s); });
  return {
    f, calls, storage, hooks, statuses,
    setBalance: (v) => { balance = v; },
    step: () => FD.fundingStep(f.getState(), USER, { canAuto: f.canRun(USER) }),
    check: (o = {}) => f.check({ user: USER, connected: USER, auto: true, ...o }),
    press: (o = {}) => f.run({ user: USER, connected: USER, auto: false, ...o }),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   F. THE RUNNER
   ════════════════════════════════════════════════════════════════════════════ */

test("F1) 🔴 ONE MOVE PER TAB: two presses, two automatic reads, a read and a press — one signature every time", async () => {
  const a = world();
  const [x, y] = await Promise.all([a.press(), a.press()]);
  assert.equal(a.calls.signed.length, 1, "two presses at once are one move");
  assert.deepEqual(x, y, "the second caller gets the first one's answer");
  assert.equal(x.ok, true);

  const b = world();
  await Promise.all([b.check(), b.check(), b.check()]);
  assert.equal(b.calls.reads >= 1, true);
  assert.equal(b.calls.signed.length, 1, "the panel and the app-wide mover reading at once start one move");

  const c = world();
  await Promise.all([c.check(), c.press()]);
  assert.equal(c.calls.signed.length, 1, "a read that lands while a press is moving the money starts nothing");

  /* And a second wallet cannot start a move while this one's is in flight. */
  const d = world();
  const first = d.press();
  const other = await d.f.run({ user: OTHER, connected: OTHER, auto: false });
  assert.equal(other.skipped, "busy");
  await first;
  assert.equal(d.calls.signed.length, 1);
});

test("F2) 🔴 THE RECORD IS READ AGAIN BEFORE THE SIGNATURE: another tab that wrote its attempt first wins, and this one signs nothing", async () => {
  const a = world();
  /* Another tab writes its attempt between this tab's balance read and its signature. */
  a.hooks.beforeSign = () => MV.writeMoveRecord(a.storage, { user: USER, raw: "25000000", at: 1 });
  await a.check();
  assert.equal(a.calls.moves, 1, "the move was under way");
  assert.equal(a.calls.signed.length, 0, "and stopped short of the signature");
  assert.equal(MV.readMoveRecord(a.storage, USER).at, 1, "the other tab's record is untouched");
  assert.notEqual(a.f.getState().status, "failed", "not a refusal: somebody else is moving it");
  assert.equal(a.step().step, "again", "here it is a button, never a second automatic try");

  /* Written before this tab even started: no move is attempted at all. */
  const b = world();
  MV.writeMoveRecord(b.storage, { user: USER, raw: "25000000", at: 1 });
  await b.check();
  assert.equal(b.calls.moves, 0);

  /* 🔴 THE WEB LOCK: another tab holding it means this tab does not move. */
  const asked = [];
  const held = world({ locks: { request: async (name, opts, cb) => { asked.push([name, opts]); return cb(null); } } });
  const out = await held.press();
  assert.equal(out.skipped, "locked");
  assert.equal(held.calls.moves, 0);
  assert.deepEqual(asked[0], [`${FD.FUNDING_LOCK_PREFIX}${USER.toLowerCase()}`, { ifAvailable: true }]);
  /* A free lock is taken, and the move happens inside it. */
  let inside = false;
  const free = world({ locks: { request: async (name, opts, cb) => { inside = true; const r = await cb({ name }); inside = false; return r; } } });
  free.hooks.beforeSign = () => assert.equal(inside, true, "the signature happens while the lock is held");
  await free.press();
  assert.equal(free.calls.signed.length, 1);
  /* A browser whose lock API refuses to run at all still has the record. */
  const broken = world({ locks: { request: async () => { throw new Error("SecurityError"); } } });
  await broken.press();
  assert.equal(broken.calls.signed.length, 1);
});

test("F3) 🔴 MONEY ALREADY THERE MOVES BY ITSELF: no panel, no arrival watched, no press", async () => {
  const w = world({ raw: "9920000" });
  await w.check();
  assert.equal(w.calls.signed.length, 1);
  assert.equal(w.calls.signed[0], 9920000n, "the amount is the chain's, read at the moment of the move");
  const s = w.f.getState();
  assert.equal(s.status, "sent");
  assert.equal(s.usdc, 9.92);
  assert.equal(s.txHash, HASH);
  assert.equal(w.step().step, "sent");
  /* Read again after the move: the wallet is empty, so the record has nothing to guard. */
  assert.equal(MV.readMoveRecord(w.storage, USER), null);
  assert.equal(w.f.getState().balance.raw, 0n);
  /* And nothing more moves on the next look. */
  await w.check();
  assert.equal(w.calls.signed.length, 1);
  assert.equal(w.step().step, "sent", "the sentence about the move outlives the empty wallet");
});

test("F4) 🔴 AN UNRESOLVED ATTEMPT NEVER MOVES BY ITSELF — and only the chain resolves one", async () => {
  /* Written, never answered (the app died mid-signature): a button. */
  const a = world();
  MV.writeMoveRecord(a.storage, { user: USER, raw: "25000000", at: 1 });
  await a.check();
  assert.equal(a.calls.moves, 0);
  assert.equal(a.step().step, "again");
  /* The customer decides: a press moves it over the record. */
  await a.press();
  assert.equal(a.calls.signed.length, 1);

  /* Sent, with no receipt yet / a reverted one / an unreadable one: unresolved.
     (The wallet holds MORE than the attempt moved, so only the receipt can say
     whether that attempt finished.) */
  for (const receipt of [null, "reverted", new Error("rpc down")]) {
    const w = world({ receipt });
    MV.writeMoveRecord(w.storage, { user: USER, raw: "20000000", txHash: HASH2, at: 1 });
    await w.check();
    assert.deepEqual(w.calls.receipts, [HASH2], String(receipt));
    assert.equal(w.calls.moves, 0, String(receipt));
    assert.equal(w.step().step, "again", String(receipt));
    assert.ok(MV.readMoveRecord(w.storage, USER), "kept");
  }

  /* 🔴 The very figure it moved, read back, with a "success" receipt: a node
     that has not caught up. The record stays, and nothing moves by itself. */
  const lag = world({ receipt: "success" });
  MV.writeMoveRecord(lag.storage, { user: USER, raw: "25000000", txHash: HASH2, at: 1 });
  await lag.check();
  await lag.check();
  assert.equal(lag.calls.moves, 0, "the same 25 read back is never moved again by itself");
  assert.ok(MV.readMoveRecord(lag.storage, USER), "kept until the chain shows the money gone");
  assert.equal(lag.step().step, "again");

  /* Mined and done, and there is NEW money: the old attempt is finished, the new
     money moves by itself. */
  const done = world({ raw: "30000000", receipt: "success" });
  MV.writeMoveRecord(done.storage, { user: USER, raw: "25000000", txHash: HASH2, at: 1 });
  await done.check();
  assert.equal(done.calls.signed.length, 1);
  assert.equal(done.calls.signed[0], 30000000n);

  /* The balance below what the attempt moved: the money left, no receipt needed. */
  const less = world({ raw: "10000000" });
  MV.writeMoveRecord(less.storage, { user: USER, raw: "25000000", txHash: HASH2, at: 1 });
  await less.check();
  assert.deepEqual(less.calls.receipts, [], "the balance alone proves it");
  assert.equal(less.calls.signed[0], 10000000n);

  /* An empty wallet clears it, and moves nothing. */
  const empty = world({ raw: "0" });
  MV.writeMoveRecord(empty.storage, { user: USER, raw: "25000000", at: 1 });
  await empty.check();
  assert.equal(MV.readMoveRecord(empty.storage, USER), null);
  assert.equal(empty.calls.moves, 0);

  /* A record from before raw was written (no figure in it) is never guessed at. */
  const old = world({ raw: "10000000" });
  MV.writeMoveRecord(old.storage, { user: USER, at: 1 });
  await old.check();
  assert.equal(old.calls.moves, 0);
  assert.equal(old.step().step, "again");
});

test("F5) the move's states: sending → sent, ended by NEW money; a refusal stays a button until the chain shows something new", async () => {
  const w = world();
  await w.check();
  assert.deepEqual(w.statuses.filter((s) => s !== "checking" && s !== "idle"), ["sending", "sent"]);
  assert.equal(w.f.getState().seq, 1);
  assert.equal(w.step().acked, false, "the popup has not shown it yet");
  w.f.acknowledge(1);
  assert.equal(w.step().acked, true);
  /* New money lands: the last move's sentence ends, and the new money moves. */
  w.setBalance("12000000");
  await w.check();
  assert.equal(w.calls.signed.length, 2);
  assert.equal(w.f.getState().usdc, 12);
  assert.equal(w.f.getState().seq, 2);
  assert.equal(w.step().acked, false, "a new move is news again");

  /* Refused AFTER the attempt was written: a button, and never an automatic retry. */
  const r = world({ fail: new PerpMoveError("send-failed", "The move didn't go through") });
  await r.check();
  assert.equal(r.f.getState().status, "failed");
  assert.equal(r.step().step, "failed");
  assert.equal(r.step().code, "send-failed");
  assert.equal(r.step().usdc, 25, "the money sitting there, read from the chain");
  r.setBalance("40000000");
  await r.check();
  assert.equal(r.calls.moves, 1, "new money does not resolve an attempt the chain has not finished");

  /* Refused BEFORE anything was written (no gas): it stands on the same balance,
     with no loop of attempts, and goes by itself once the chain shows new money. */
  const g = world({ failBefore: new PerpMoveError("no-gas", "no gas") });
  await g.check();
  assert.equal(g.calls.moves, 1);
  assert.equal(g.step().code, "no-gas");
  assert.equal(MV.readMoveRecord(g.storage, USER), null, "nothing was signed, nothing written");
  await g.check();
  await g.check();
  assert.equal(g.calls.moves, 1, "the same balance: no second try, however often it looks");
  g.setBalance("26000000");
  await g.check();
  assert.equal(g.calls.moves, 2, "a new deposit (with its gas) is a new chance");
});

test("F6) 🔴 nothing under the floor and nothing on an unreadable balance — and an unreadable balance is never a zero", async () => {
  const short = world({ raw: "4999999" });
  await short.check();
  assert.equal(short.calls.moves, 0);
  assert.equal(short.step().step, "short");
  assert.equal(short.step().usdc, 4.999999);

  const unread = world({ raw: null });
  await unread.check();
  assert.equal(unread.calls.moves, 0);
  const s = unread.f.getState();
  assert.equal(s.balance.raw, null, "unknown, not 0");
  assert.equal(unread.step().step, "idle");
  assert.equal(unread.step().usdc, null);
});

test("F7) 🔴 only the customer's own embedded wallet moves by itself: its own signer, its own connection", async () => {
  const none = world({ signer: null });
  await none.check();
  assert.equal(none.calls.moves, 0, "no no-window sender: nothing moves by itself");
  assert.equal(none.step().step, "offer");
  const foreign = world({ signer: OTHER });
  await foreign.check();
  assert.equal(foreign.calls.moves, 0, "a sender for another address is not this wallet's");
  const other = world();
  await other.check({ connected: OTHER });
  assert.equal(other.calls.moves, 0, "the connection must be this wallet");
  const nobody = world();
  assert.equal(await nobody.f.check({ user: null, auto: true }), null);
  assert.equal(nobody.calls.reads, 0, "no wallet, no read");

  /* A press with no signer is refused without a record, and the signer arriving
     lets the money go by itself. */
  let signer = null;
  let bal = 25000000n;
  const late = world();
  const lateF = FD.createPerpFunding({
    storage: late.storage, locks: null, now: () => 1,
    read: async () => ({ raw: bal, usdc: usdcOf(bal) }),
    move: async ({ sender, beforeSend }) => {
      if (!sender) throw new PerpMoveError("no-signer", "none");
      const there = bal;
      beforeSend({ raw: there });
      late.calls.signed.push(there);
      bal = 0n;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => null,
    sender: () => (signer ? { address: signer, sendTransaction: async () => HASH } : null),
  });
  await lateF.run({ user: USER, connected: USER });
  assert.equal(lateF.getState().code, "no-signer");
  signer = USER;
  await lateF.check({ user: USER, connected: USER, auto: true });
  assert.equal(late.calls.signed.length, 1, "the sender arrived, and the money went");
});

test("F8) a switch of wallet drops the old wallet's figures, and a late answer for it is never shown under the new one", async () => {
  const w = world();
  const p = w.f.check({ user: USER, connected: USER, auto: false });
  w.f.focus(OTHER);
  await p;
  const s = w.f.getState();
  assert.equal(s.user, OTHER.toLowerCase());
  assert.equal(s.balance, null, "nothing read for this wallet yet");
  assert.equal(FD.fundingStep(s, USER).step, "idle", "and another wallet's view of it is nothing");
});

test("F9) 🔴 NO LOOP OF SIGNATURES, whatever the chain answers: a node that has not caught up, or a deposit landing mid-move", { timeout: 20000 }, async () => {
  const runner = (o) => FD.createPerpFunding({ storage: fakeStore(), locks: null, now: () => 1, sender: () => ({ address: USER, sendTransaction: async () => HASH }), ...o });
  /* A chain that never shows the money leaving, while every receipt says it did. */
  const signed = [];
  const liar = runner({
    read: async () => ({ raw: 25000000n, usdc: 25 }),
    move: async ({ beforeSend }) => { await tick(); beforeSend({ raw: 25000000n }); signed.push(25000000n); return { txHash: HASH, raw: 25000000n, usdc: 25 }; },
    receipt: async () => "success",
  });
  await liar.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 1, "the figure it has just moved, read back, is not new money");
  await liar.check({ user: USER, connected: USER, auto: true });
  await liar.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 1, "nor on any later look: a 'success' receipt does not clear the record while the same figure is read back (RF1)");

  /* A chain whose every answer is a NEW figure: one look, at most one move after
     the first, and then it waits for the next landing, the tab or a press. */
  let drift = 25000000n;
  const drifted = [];
  const drifter = runner({
    read: async () => ({ raw: drift, usdc: usdcOf(drift) }),
    move: async ({ beforeSend }) => { await tick(); const there = drift; beforeSend({ raw: there }); drifted.push(there); drift -= 1000000n; return { txHash: HASH, raw: there, usdc: usdcOf(there) }; },
    receipt: async () => "success",
  });
  await drifter.check({ user: USER, connected: USER, auto: true });
  assert.equal(drifted.length, 2, "a move, and one more for what the after-look found — never a chain of them");

  /* 7 USDC lands while 25 is moving: the after-look moves the 7 — once — and stops
     there even if the chain then keeps answering 7. */
  let bal = 25000000n;
  const moved = [];
  const busy = runner({
    read: async () => ({ raw: bal, usdc: usdcOf(bal) }),
    move: async ({ beforeSend }) => { await tick(); const there = bal; beforeSend({ raw: there }); moved.push(there); bal = 7000000n; return { txHash: HASH, raw: there, usdc: usdcOf(there) }; },
    receipt: async () => "success",
  });
  await busy.check({ user: USER, connected: USER, auto: true });
  assert.deepEqual(moved, [25000000n, 7000000n], "the new deposit went too, by itself");
  assert.equal(busy.getState().status, "sent");
  assert.equal(busy.getState().usdc, 7);
});

/* The Web Locks API, as two windows of one browser share it. */
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

test("F10) 🔴 TWO WINDOWS, ONE SIGNATURE: the second window waits for the first, and then says what the first one did", { timeout: 20000 }, async () => {
  const storage = fakeStore();
  const locks = lockManager();
  let balance = 25000000n;
  const signed = [];
  const chain = {
    read: async () => { await tick(); return { raw: balance, usdc: usdcOf(balance) }; },
    move: async ({ beforeSend }) => {
      await tick();
      const there = balance;
      beforeSend({ raw: there });
      signed.push(there);
      await tick();
      await tick();
      balance = 0n;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => null,
    sender: () => ({ address: USER, sendTransaction: async () => HASH }),
  };
  const tabA = FD.createPerpFunding({ ...chain, storage, locks, now: () => 1 });
  const tabB = FD.createPerpFunding({ ...chain, storage, locks, now: () => 2 });
  const seenB = [];
  tabB.subscribe(() => { const s = tabB.getState().status; if (seenB[seenB.length - 1] !== s) seenB.push(s); });
  await Promise.all([
    tabA.check({ user: USER, connected: USER, auto: true }),
    tabB.check({ user: USER, connected: USER, auto: true }),
  ]);
  assert.equal(signed.length, 1, "one signature across both windows");
  for (const tab of [tabA, tabB]) {
    const f = FD.fundingStep(tab.getState(), USER);
    assert.equal(f.step, "sent", "both windows say the same thing");
    assert.equal(f.usdc, 25);
  }
  assert.ok(!seenB.includes("failed"), "the waiting window never calls it a refusal");
  assert.equal(MV.readMoveRecord(storage, USER), null, "and the record is gone once the money has left");
});

test("F11) a wallet switch mid-move: the new wallet's look that the move held up is made when the move ends — the old wallet is never read again", async () => {
  const bal = { [USER.toLowerCase()]: 25000000n, [OTHER.toLowerCase()]: 9000000n };
  const reads = [];
  const signed = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let who = USER;
  const f = FD.createPerpFunding({
    storage: fakeStore(), locks: null, now: () => 1,
    sender: () => ({ address: who, sendTransaction: async () => HASH }),
    read: async ({ owner }) => { reads.push(owner); await tick(); return { raw: bal[owner], usdc: usdcOf(bal[owner]) }; },
    move: async ({ owner, beforeSend }) => {
      const there = bal[owner];
      beforeSend({ raw: there });
      signed.push([owner, there]);
      if (owner === USER.toLowerCase()) await gate;
      bal[owner] = 0n;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => null,
  });
  const p = f.check({ user: USER, connected: USER, auto: true });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(signed.length, 1);
  /* Another account signs in while the first move is still being signed. */
  who = OTHER;
  f.focus(OTHER);
  await f.check({ user: OTHER, connected: OTHER, auto: true });
  assert.equal(signed.length, 1, "one move per tab at a time");
  release();
  await p;
  for (let i = 0; i < 30; i++) await tick();
  assert.deepEqual(signed.map(([o]) => o), [USER.toLowerCase(), OTHER.toLowerCase()], "the held-up look moved the new wallet's money");
  assert.equal(reads.filter((o) => o === USER.toLowerCase()).length, 1, "the wallet that left was never read again");
  assert.equal(f.getState().user, OTHER.toLowerCase());
});

test("F12) 🔴 a MOCK build moves nothing by itself, and says so honestly (a button, never \"moving\") — a press still moves the real money", async () => {
  let balance = 25000000n;
  const signed = [];
  const f = FD.createPerpFunding({
    storage: fakeStore(), locks: null, now: () => 1, autoBuild: false,
    sender: () => ({ address: USER, sendTransaction: async () => HASH }),
    read: async () => ({ raw: balance, usdc: usdcOf(balance) }),
    move: async ({ beforeSend }) => { const there = balance; beforeSend({ raw: there }); signed.push(there); balance = 0n; return { txHash: HASH, raw: there, usdc: usdcOf(there) }; },
    receipt: async () => null,
  });
  assert.equal(f.canRun(USER), false);
  await f.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 0);
  assert.equal((await f.run({ user: USER, connected: USER, auto: true })).skipped, "mock-build");
  assert.equal(FD.fundingStep(f.getState(), USER, { canAuto: f.canRun(USER) }).step, "offer");
  await f.run({ user: USER, connected: USER, auto: false });
  assert.equal(signed.length, 1, "the customer pressed: their own money, moved");
  assert.equal(FD.FUNDING_AUTO_BUILD, true, "a build with no VITE_PERP_BACKEND is live");
});

test("F13) the window that waited on a refused move tries itself on its NEXT outside look — only while storage holds — and never on its own after-look", { timeout: 20000 }, async () => {
  const storage = fakeStore();
  const locks = lockManager();
  let gas = false;
  const signed = [];
  let balance = 25000000n;
  const chain = {
    read: async () => { await tick(); return { raw: balance, usdc: usdcOf(balance) }; },
    move: async ({ beforeSend }) => {
      await tick(); await tick(); await tick();
      if (!gas) throw new PerpMoveError("no-gas", "There is no gas in your own wallet");
      const there = balance; beforeSend({ raw: there }); signed.push(there); balance = 0n;
      return { txHash: HASH, raw: there, usdc: usdcOf(there) };
    },
    receipt: async () => null,
    sender: () => ({ address: USER, sendTransaction: async () => HASH }),
  };
  const tabA = FD.createPerpFunding({ ...chain, storage, locks, now: () => 1 });
  const tabB = FD.createPerpFunding({ ...chain, storage, locks, now: () => 2 });
  await Promise.all([tabA.check({ user: USER, connected: USER, auto: true }), tabB.check({ user: USER, connected: USER, auto: true })]);
  assert.equal(tabB.getState().status, "failed", "the waiting window says it didn't go");
  assert.equal(tabB.getState().code, "elsewhere");
  assert.equal(signed.length, 0);
  /* The gas arrives; the customer comes back to window B. */
  gas = true;
  await tabB.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, 1, "window B's next look moved it");

  /* Storage that refuses writes: window B could not see window A's attempt, so it never tries by itself. */
  const m = new Map();
  const full = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: (k) => m.delete(k) };
  balance = 25000000n;
  gas = false;
  /* Another window holds the lock and writes nothing this window can see. */
  const heldLocks = { request: async (name, opts, cb) => { if (typeof opts === "function") return opts(); return cb(null); } };
  const blind = FD.createPerpFunding({ ...chain, storage: full, locks: heldLocks, now: () => 5 });
  await blind.check({ user: USER, connected: USER, auto: true });
  assert.equal(blind.getState().code, "elsewhere");
  gas = true;
  const before = signed.length;
  await blind.check({ user: USER, connected: USER, auto: true });
  assert.equal(signed.length, before, "storage that holds nothing: no automatic try");
});

/* ════════════════════════════════════════════════════════════════════════════
   P. THE POPUP'S WORDS
   ════════════════════════════════════════════════════════════════════════════ */

const t0 = 1760000000000;
const rowOf = (status, extra = {}) => ({ id: `r-${status}`, status, inChainId: 8453, createdAt: t0, updatedAt: t0, ...extra });
const pickOf = (row, planId = FIRST_HOP_PLAN_ID, routeId = "base-usdc") => ({ address: DEP, routeId, planId, row });
const moveOf = (step, usdc = null, extra = {}) => ({ step, usdc, code: null, seq: 1, acked: false, balanceRead: true, balanceRaw: null, checking: false, ...extra });
const view = (o) => PV.depositPopupView({ user: USER, ...o });
const LANDED = rowOf("credited", { amountOut: 9.92, symbolOut: "USDC", amountIn: 10, symbolIn: "USDC" });

test("P1) on its way: \"Deposit pending · 20 USDC from Base\", a live mark, a tap to the Deposit panel", () => {
  const v = view({ pick: pickOf(rowOf("arriving", { amountIn: 20, symbolIn: "USDC" })) });
  assert.equal(v.kind, "arriving");
  assert.equal(v.text, "Deposit pending · 20 USDC from Base");
  assert.equal(v.live, true);
  assert.equal(v.lingers, false);
  assert.equal(v.leaves, false);
  assert.equal(v.go, "/wallet?panel=deposit");
  assert.equal(v.tokenLogo, "/tokens/usdc.svg");
  assert.match(v.chainLogo, /^\/chain-logos\/8453\.png/);
  assert.equal(v.ackRow, null, "a deposit on its way is never acknowledged away");
  /* USDT on Arbitrum, with no amount known: the token, never a dash. */
  const t = view({ pick: pickOf(rowOf("arriving", { inChainId: 42161 }), FIRST_HOP_PLAN_ID, "arbitrum-usdt") });
  assert.equal(t.text, "Deposit pending · USDT from Arbitrum");
  assert.equal(t.tokenLogo, "/tokens/usdt.svg");
});

test("P2) landed and moving: \"Moving 9.92 USDC into your Perp account…\" — in flight, about to start, or found with no row", () => {
  const sending = view({ pick: pickOf(LANDED), move: moveOf("sending", 9.92) });
  assert.equal(sending.kind, "moving");
  assert.equal(sending.title, "Moving 9.92 USDC into your Perp account…");
  assert.equal(sending.live, true);
  assert.match(sending.sub, /from Base/);
  /* Landed, read, and about to move (the runner starts it on the same read). */
  const auto = view({ pick: pickOf(LANDED), move: moveOf("auto", 9.92) });
  assert.equal(auto.kind, "moving");
  assert.equal(auto.title, "Moving 9.92 USDC into your Perp account…");
  /* Money found in the wallet with no deposit row (a reload, an old deposit). */
  const found = view({ move: moveOf("auto", 12.5) });
  assert.equal(found.title, "Moving 12.5 USDC into your Perp account…");
  /* An unknown figure is words, never a dash in a sentence. */
  assert.equal(view({ move: moveOf("sending", null) }).title, "Moving your deposit into your Perp account…");
  /* Landed but not read yet: it says what the row says and claims nothing more. */
  const unread = view({ pick: pickOf(LANDED), move: moveOf("idle", null, { balanceRead: false }) });
  assert.equal(unread.kind, "landed");
  assert.equal(unread.title, "+9.92 USDC landed in your wallet");
  assert.equal(unread.live, true);
});

test("P3) 🔴 credited: \"+9.92 USDC in your Perp account\" only when it IS — a sent hop is \"on its way\"", () => {
  const direct = view({ pick: pickOf(LANDED, "direct") });
  assert.equal(direct.kind, "credited");
  assert.equal(direct.title, "+9.92 USDC in your Perp account");
  assert.equal(direct.check, true);
  assert.equal(direct.leaves, true, "it leaves by itself");
  assert.deepEqual(direct.ackRow, { address: DEP, id: LANDED.id });
  const sent = view({ pick: pickOf(LANDED), move: moveOf("sent", 9.92) });
  assert.equal(sent.kind, "sent");
  assert.equal(sent.title, "+9.92 USDC on its way to your Perp account");
  assert.equal(sent.check, true);
  assert.equal(sent.leaves, true);
  assert.equal(sent.ackMove, true);
  assert.deepEqual(sent.ackRow, { address: DEP, id: LANDED.id }, "closing it closes the landing too, so it is not announced twice");
  assert.equal(sent.moveSeq, 1);
  /* Landed earlier and already gone from the wallet: on its way, said once. */
  const gone = view({ pick: pickOf(LANDED), move: moveOf("idle", 0, { balanceRaw: 0n }) });
  assert.equal(gone.kind, "sent");
  assert.equal(gone.title, "+9.92 USDC on its way to your Perp account");
  /* Once the popup has shown the move, the move says nothing more. */
  assert.equal(view({ move: moveOf("sent", 9.92, { acked: true }) }), null);
  for (const v of [sent, gone]) assert.doesNotMatch(v.title, /in your Perp account/, "the hop is sent, not seen credited");
});

test("P4) refunded, failed, a refused move: they stay, with ×; only the refused move has a press", () => {
  const ref = view({ pick: pickOf(rowOf("refunded", { amountIn: 20, symbolIn: "USDC" })) });
  assert.equal(ref.kind, "refunded");
  assert.equal(ref.text, "Deposit refunded · 20 USDC went back to your own address on Base");
  assert.equal(ref.lingers, true);
  assert.equal(ref.action, null);
  const fail = view({ pick: pickOf(rowOf("failed", { amountIn: 20, symbolIn: "USDC" })) });
  assert.equal(fail.kind, "failed");
  assert.equal(fail.text, "Deposit didn't go through · 20 USDC from Base");
  assert.equal(fail.lingers, true);
  assert.equal(fail.action, null);
  const mf = view({ pick: pickOf(LANDED), move: moveOf("failed", 9.92, { code: "send-failed" }) });
  assert.equal(mf.kind, "move-failed");
  assert.equal(mf.title, "9.92 USDC is waiting in your wallet");
  assert.equal(mf.sub, "The move into your Perp account didn't go through.");
  assert.equal(mf.action, "Move it now");
  assert.equal(mf.lingers, true);
  assert.equal(mf.ackMove, true);
  const gas = view({ move: moveOf("failed", 9.92, { code: "no-gas" }) });
  assert.match(gas.sub, /needs a little Arbitrum gas there, and there is none yet/);
  const again = view({ move: moveOf("again", 9.92, { seq: 0 }) });
  assert.equal(again.kind, "move-failed", "an attempt that never answered is a press too");
  assert.equal(again.action, "Move it now");
  /* Closed by the customer: the move says nothing more; the landing it was
     about was acknowledged with it. */
  assert.equal(view({ move: moveOf("failed", 9.92, { acked: true }) }), null);
  /* Under the floor, after landing: it stays and says what it takes. */
  const short = view({ pick: pickOf(rowOf("credited", { amountOut: 4.2, symbolOut: "USDC" })), move: moveOf("short", 4.2) });
  assert.equal(short.kind, "short");
  assert.equal(short.text, "4.2 USDC is waiting in your wallet · It takes 5 USDC to move into your Perp account.");
});

test("P5) 🔴 SILENT while the Deposit panel is open, with no wallet, and with nothing new to say", () => {
  const every = [
    { pick: pickOf(rowOf("arriving", { amountIn: 20 })) },
    { pick: pickOf(LANDED, "direct") },
    { pick: pickOf(LANDED), move: moveOf("sending", 9.92) },
    { move: moveOf("failed", 9.92) },
    { move: moveOf("sent", 9.92) },
    { move: moveOf("auto", 9.92) },
  ];
  for (const o of every) {
    assert.ok(view(o), JSON.stringify(o.move || o.pick.row.status));
    assert.equal(view({ ...o, held: true }), null, "the panel is saying it");
    assert.equal(PV.depositPopupView({ ...o, user: null }), null, "no wallet, no box");
  }
  assert.equal(view({}), null);
  assert.equal(view({ move: moveOf("idle", 0, { balanceRaw: 0n }) }), null);
  assert.equal(view({ move: moveOf("short", 4.2) }), null, "dust with no deposit to go with it is the panel's business");
  assert.equal(view({ move: moveOf("offer", 9.92) }), null, "nothing to say until the wallet can sign");
  /* A status the app does not know is never announced. */
  assert.equal(view({ pick: pickOf(rowOf("weird")) }), null);
});

test("P6) 🔴 NO PROVIDER AND NO VENUE in any box, never \"free\", and never a bare 0 for an unknown", () => {
  const all = [
    view({ pick: pickOf(rowOf("arriving", { amountIn: 20 })) }),
    view({ pick: pickOf(rowOf("arriving")) }),
    view({ pick: pickOf(LANDED, "direct") }),
    view({ pick: pickOf(rowOf("credited", { symbolOut: "USDC" }), "direct") }),
    view({ pick: pickOf(LANDED), move: moveOf("sending", 9.92) }),
    view({ pick: pickOf(LANDED), move: moveOf("sent", 9.92) }),
    view({ pick: pickOf(LANDED), move: moveOf("idle", null, { balanceRead: false }) }),
    view({ pick: pickOf(LANDED), move: moveOf("short", 4.2) }),
    view({ pick: pickOf(rowOf("refunded")) }),
    view({ pick: pickOf(rowOf("failed")) }),
    view({ move: moveOf("failed", null, { code: "no-gas" }) }),
    view({ move: moveOf("again", null, { seq: 0 }) }),
    view({ move: moveOf("auto", null) }),
  ];
  for (const v of all) {
    assert.ok(v);
    for (const text of [v.title, v.sub, v.text, v.action]) {
      if (!text) continue;
      assert.doesNotMatch(text, /relay/i, v.kind);
      assert.doesNotMatch(text, /hyperliquid|hyper ?core|\bHL\b/i, v.kind);
      assert.doesNotMatch(text, /\bbridge\b|activation|\btopup\b|gas top-?up|\bRPC\b|privy/i, v.kind);
      assert.doesNotMatch(text, /\bfree\b/i, v.kind);
      assert.doesNotMatch(text, /—|\bundefined\b|\bnull\b|NaN/, `${v.kind}: ${text}`);
      assert.doesNotMatch(text, /(^|\s)\+?0 USDC/, `${v.kind}: an unknown is never a zero`);
    }
  }
});

test("P7) the watch, read for the box: one wallet's deposits only, held while a panel shows it, and a signature that changes only on a landing", () => {
  const sent = [];
  const watch = W.createDepositWatch({
    storage: null,
    now: () => t0,
    track: ({ onUpdate }) => { sent.push(onUpdate); return { stop() {}, refresh() { return true; } }; },
  });
  const h = watch.show({ user: USER, address: DEP, routeId: "base-usdc", planId: FIRST_HOP_PLAN_ID });
  const answer = (requests) => sent[0]({ state: "ok", requests, checkedAt: t0, error: null });
  answer([rowOf("arriving", { amountIn: 20, symbolIn: "USDC" })]);
  let st = watch.getState();
  assert.equal(PV.depositPanelOpen(st, USER), true);
  assert.equal(PV.depositPanelOpen(st, OTHER), false);
  assert.equal(W.pickDepositStatus(st, USER), null, "the panel is saying it");
  const sig0 = W.landingSig(st, USER);
  assert.equal(sig0, "", "a deposit on its way has not landed");
  h.release();
  st = watch.getState();
  assert.equal(PV.depositPanelOpen(st, USER), false);
  const pick = W.pickDepositStatus(st, USER);
  const v = PV.depositPopupView({ user: USER, pick, held: false, move: null });
  assert.equal(v.text, "Deposit pending · 20 USDC from Base", "the panel closed, the box speaks");
  answer([{ ...rowOf("arriving", { amountIn: 20, symbolIn: "USDC" }), status: "credited", amountOut: 19.87, symbolOut: "USDC" }]);
  st = watch.getState();
  const sig1 = W.landingSig(st, USER);
  assert.notEqual(sig1, sig0, "a landing changes it: the mover reads the wallet then");
  answer([{ ...rowOf("arriving", { amountIn: 20, symbolIn: "USDC" }), status: "credited", amountOut: 19.87, symbolOut: "USDC", updatedAt: t0 + 5 }]);
  assert.equal(W.landingSig(watch.getState(), USER), sig1, "another look at the same landing does not");
  assert.equal(W.landingSig(watch.getState(), OTHER), "", "another wallet's deposits are not this one's");
  watch.stopAll();
});

/* ════════════════════════════════════════════════════════════════════════════
   S. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

const MOVER = "src/perp/deposit/AutoMover.jsx";
const STATUS = "src/perp/deposit/DepositStatus.jsx";

test("S1) the mover and the box are mounted ONCE, inside the providers, beside the toasts", () => {
  const m = code("src/main.jsx");
  assert.equal((m.match(/<DepositAutoMover\s*\/>/g) || []).length, 1);
  assert.equal((m.match(/<DepositStatus\s*\/>/g) || []).length, 1);
  const inner = m.slice(m.indexOf("<BackendProvider>"), m.indexOf("</BackendProvider>"));
  for (const tag of ["<ToastHost />", "<DepositAutoMover />", "<DepositStatus />"]) assert.ok(inner.includes(tag), `${tag} inside the providers`);
  /* Nobody else mounts them. */
  for (const f of ["src/App.jsx", "src/layout/AppShell.jsx"]) assert.doesNotMatch(code(f), /DepositAutoMover|DepositStatus/, f);
});

test("S2) 🔴 the mover moves nothing itself: it asks the runner to READ (with auto), focuses the watch, and keeps no timer", () => {
  const c = code(MOVER);
  assert.doesNotMatch(c, /\.run\(|moveArbitrumUsdcToPerp|sendTransaction|writeMoveRecord/, "every move goes through the runner's own checks");
  assert.match(c, /funding\.check\(\{ user: wallet, connected: wallet, auto: true \}\)/);
  assert.match(c, /watch\.focus\(wallet\)/, "saved watches resume after a reload");
  assert.match(c, /landingSig\(/, "it reads on a landing, not on every look");
  assert.match(c, /visibilitychange/, "and when the tab comes back");
  assert.match(c, /subscribePrivyApi/, "and when the no-window sender arrives");
  assert.match(c, /walletCanFinishFirstHop\(walletType\) && funding\.canRun\(wallet\)/, "only a Privy wallet whose own sender is there");
  for (const f of [MOVER, FUNDING]) assert.doesNotMatch(code(f), /setInterval|setTimeout/, `${f}: no polling of its own`);
});

test("S3) 🔴 the box's preview is a DEV build's only, and the box names no provider in its markup", () => {
  const c = code(STATUS);
  /* Every use of the preview is behind import.meta.env.DEV. */
  const uses = [...c.matchAll(/readPreview\(\)/g)].map((m) => m.index);
  assert.ok(uses.length >= 1);
  for (const i of uses) {
    const before = c.slice(Math.max(0, i - 200), i);
    if (/function readPreview/.test(c.slice(i - 20, i + 15))) continue;
    assert.match(before, /import\.meta\.env\.DEV \?/, "the preview is reached only in a dev build");
  }
  assert.doesNotMatch(c, /relay|hyperliquid|privy/i);
  assert.match(c, /role="status"/);
  assert.match(c, /aria-live="polite"/);
  /* 🔴 It sits UNDER the header (z-40), so the header's account / Sign-in menu
     opens over it (a box over that menu blocked it for a whole deposit), and
     under every sheet (z-70), the full-screen chart (z-60) and the toasts
     (z-80). It is a card at the top, never at the bottom, where the order
     button, the composer and the toasts are. */
  assert.match(c, /fixed inset-x-0 top-\[calc\([^\]]*var\(--header-h\)[^\]]*\)\] z-\[35\]/);
  assert.doesNotMatch(c, /z-\[55\]|md:bottom-|bottom-6/, "not over the header's menus, not at the bottom");
  /* Every state can be closed: the × is not conditional on the state. */
  assert.match(c, /aria-label="Close"/);
  assert.doesNotMatch(c, /\{v\.lingers \? \(\s*<button/, "the × is drawn for every state, not only the ones that stay");
});

test("S4) 🔴 the mover: a Privy wallet whose sender is not there yet is READ (so the box can say where its money is) and never moved; with the sender, read and moved; a mock build, neither", async () => {
  const live = await bundle({ entry: MOVER, stubs: autoStubs([MOVER]), env: { VITE_PERP_BACKEND: "live", DEV: false } });
  const mock = await bundle({ entry: MOVER, stubs: autoStubs([MOVER]), env: { VITE_PERP_BACKEND: "mock", DEV: false } });
  const mountWith = (M, { walletType = "privy", canRun = true } = {}) => {
    const checks = [];
    globalThis.__impl = {
      useWallet: () => ({ address: USER, walletType }),
      walletCanFinishFirstHop: (t) => t === "privy",
      landingSig: () => "",
      subscribePrivyApi: () => () => {},
      privyApiSeq: () => 1,
    };
    const watch = { subscribe: () => () => {}, getState: () => ({ entries: [] }), focus: () => {} };
    const funding = { canRun: () => canRun, check: (o) => { checks.push(o); return Promise.resolve(null); }, focus: () => {} };
    const h = M.mount(() => M.default({ watch, funding }));
    h.render();
    h.flush();
    h.unmount();
    return checks;
  };
  const withSender = mountWith(live);
  assert.equal(withSender.length, 1);
  assert.equal(withSender[0].auto, true, "the sender is there: read, and move what is there");
  const noSender = mountWith(live, { canRun: false });
  assert.equal(noSender.length, 1, "no sender yet: still read");
  assert.equal(noSender[0].auto, false, "but never moved");
  assert.deepEqual(mountWith(live, { walletType: "injected" }), [], "not an embedded wallet: nothing at all");
  assert.deepEqual(mountWith(mock), [], "a mock build: the mover stands down");
  assert.deepEqual(mountWith(mock, { canRun: false }), []);
});
