/**
 * test-relay-deposit-fee — THE DEPOSIT SHEET'S FEE AFTER THE ACCOUNT IS ACTIVATED.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-22 (iPhone): "ถ้า Activate Account เสร็จ
 * แม่งยังโชว์ Fee 2.5 First time อยู่ ถ้า Activate เสร็จแล้ว แม่งควรจะไม่ขึ้น".
 *
 * The hooks in src/perp/deposit/usePerpDeposit.js, bundled with the
 * perp live harness (a hook runner, no DOM): the lib and the account layer are
 * stubbed by name, the view helpers are the real ones.
 *
 *   A. useDepositAccountNew reads the account layer for the connected wallet
 *      only while enabled, and answers true / false / null;
 *   F. useDepositFee re-prices a saved fee ONCE for the address on screen when
 *      it is out of date, shows the dash while it waits, never loops, retries a
 *      failure on the next open, and never shows a figure for another address.
 *
 * Run: node --test scripts/test-relay-deposit-fee.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { autoStubs, bundle } from "./lib/perpLiveHarness.mjs";

globalThis.fetch = () => { throw new Error("test-relay-deposit-fee: a real network call was attempted"); };

const HOOKS = "src/perp/deposit/usePerpDeposit.js";
const VIEW = "src/perp/deposit/perpDepositView.js";
/* Real, not stubbed: the view reads the first-deposit plan's own id from it, and
   a stub would make every plan comparison in here answer undefined. */
const FIRST = "src/lib/relay/firstDeposit.js";
const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEP = "0xbadfbe97b7244a57c0ef7c5cd8d2a907923f074d";

let M;
let RT;
before(async () => {
  /* The Relay lib is REAL except the two functions these tests drive: the
     first-deposit plan and the money rules it shares with the direct one are
     read through it (isEvmAddress, parseDepositQuote, DIRECT_PLAN), and a
     wholly stubbed module makes every one of them answer null. */
  const stubs = autoStubs([HOOKS], {
    keep: [VIEW, FIRST],
    extra: { "src/lib/relay/depositAddress.js": { real: "src/lib/relay/depositAddress.js", only: ["trackDeposits", "repriceDepositFee"] } },
  });
  M = await bundle({ entry: HOOKS, stubs });
  RT = await import("../src/lib/relay/routes.js");
});

const flushAsync = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/* A saved answer as usePerpDepositAddress hands it on: priced with the activation. */
const saved = (over = {}) => ({
  depositAddress: DEP, feeEstimateUsdc: 2.5, activationIncluded: true, feeStale: false, timeEstimateSec: 1,
  route: RT.routeById("base-usdc"), quotedAt: 1000, pricedAt: 1000, expiresAt: null, fromCache: true, ...over,
});

/* 🔴 EVERYTHING THIS HOOK HANDS THE SCREEN, in one place, so a figure that gets
   added to it can never quietly stop being checked. The floor travels WITH the
   fee because a re-price replaces both, and a fresh fee printed beside an
   hour-old smallest-deposit figure is the one disagreement on this sheet that can
   cost somebody their money (F8). */
const feeView = (over = {}) => ({ fee: null, activation: false, activationUsdc: null, minInputUsdc: null, ...over });

function feeWorld() {
  const asks = [];
  let answer = null;
  globalThis.__impl = {
    repriceDepositFee: (args) => {
      asks.push(args);
      return new Promise((resolve, reject) => { answer = { resolve, reject }; });
    },
    usePerpAccount: () => null,
  };
  const props = { user: USER, connected: USER, route: RT.routeById("base-usdc"), data: saved(), accountNew: false, requests: [], enabled: true };
  const h = M.mount(() => M.useDepositFee(props));
  h.render();
  h.flush();
  return { h, asks, props, answer: () => answer };
}

test("F1) 🔴 an activated account: the saved first-time fee is withheld (the dash), re-priced ONCE for the address on screen, and the new fee shows", async () => {
  const w = feeWorld();
  assert.deepEqual(w.h.value, feeView(), "never the 2.5 first-time fee");
  assert.equal(w.asks.length, 1);
  assert.equal(w.asks[0].user, USER);
  assert.equal(w.asks[0].connected, USER);
  assert.equal(w.asks[0].route, RT.routeById("base-usdc"), "the table's own route object");
  assert.equal(w.asks[0].depositAddress, DEP, "the address on screen, not a new one");
  w.h.render(); w.h.flush();
  assert.equal(w.asks.length, 1, "a re-render asks nothing more");
  w.answer().resolve({ depositAddress: DEP, feeEstimateUsdc: 0.029496, activationIncluded: false, timeEstimateSec: 1, pricedAt: 5000 });
  await flushAsync();
  w.h.flush();
  assert.deepEqual(w.h.value, feeView({ fee: 0.029496 }));
  w.h.render(); w.h.flush();
  assert.equal(w.asks.length, 1, "and still one ask");
  w.h.unmount();
});

test("F2) a NEW account: nothing is re-priced; the fee shows with its activation", () => {
  const w = feeWorld();
  w.props.accountNew = true;
  const h = M.mount(() => M.useDepositFee({ ...w.props, accountNew: true }));
  const before = w.asks.length;
  h.render(); h.flush();
  assert.deepEqual(h.value, feeView({ fee: 2.5, activation: true }));
  assert.equal(w.asks.length, before, "no ask for a new account");
  h.unmount();
  w.h.unmount();
});

test("F3) not answered yet (null): the fee priced with the activation is withheld and nothing is asked", () => {
  globalThis.__impl = { repriceDepositFee: () => { throw new Error("must not be asked"); }, usePerpAccount: () => null };
  const h = M.mount(() => M.useDepositFee({ user: USER, connected: USER, route: RT.routeById("base-usdc"), data: saved(), accountNew: null, requests: [], enabled: true }));
  h.render(); h.flush();
  assert.deepEqual(h.value, feeView());
  h.unmount();
});

test("F4) a stale fee is re-priced; a failed re-price stays the dash with no loop, and is asked again on the next open", async () => {
  const asks = [];
  const pending = [];
  globalThis.__impl = {
    repriceDepositFee: (args) => { asks.push(args); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    usePerpAccount: () => null,
  };
  const props = { user: USER, connected: USER, route: RT.routeById("base-usdc"), data: saved({ feeEstimateUsdc: null, activationIncluded: null, feeStale: true }), accountNew: null, requests: [], enabled: true };
  const h = M.mount(() => M.useDepositFee(props));
  h.render(); h.flush();
  assert.equal(asks.length, 1, "past its hour: re-priced");
  assert.deepEqual(h.value, feeView());
  pending[0].reject(new Error("Couldn't reach Relay"));
  await flushAsync();
  h.render(); h.flush();
  assert.equal(asks.length, 1, "a failure is not retried in a loop");
  assert.deepEqual(h.value, feeView(), "the dash, never 0");
  props.enabled = false; h.render(); h.flush();
  props.enabled = true; h.render(); h.flush();
  assert.equal(asks.length, 2, "the next open asks again");
  pending[1].resolve({ depositAddress: DEP, feeEstimateUsdc: 0.03, activationIncluded: false, timeEstimateSec: 1, pricedAt: 9000 });
  await flushAsync();
  h.flush();
  assert.deepEqual(h.value, feeView({ fee: 0.03 }));
  h.unmount();
});

test("F5) an answer that lands after the sheet closed still serves the next open, without a second ask", async () => {
  const asks = [];
  let done;
  globalThis.__impl = {
    repriceDepositFee: (args) => { asks.push(args); return new Promise((resolve) => { done = resolve; }); },
    usePerpAccount: () => null,
  };
  const props = { user: USER, connected: USER, route: RT.routeById("base-usdc"), data: saved(), accountNew: false, requests: [], enabled: true };
  const h = M.mount(() => M.useDepositFee(props));
  h.render(); h.flush();
  props.enabled = false; h.render(); h.flush();
  done({ depositAddress: DEP, feeEstimateUsdc: 0.03, activationIncluded: false, timeEstimateSec: 1, pricedAt: 5000 });
  await flushAsync();
  props.enabled = true; h.render(); h.flush();
  assert.equal(asks.length, 1);
  assert.deepEqual(h.value, feeView({ fee: 0.03 }));
  h.unmount();
});

test("F6) 🔴 a figure priced for ANOTHER address is never shown under this one", async () => {
  const w = feeWorld();
  w.answer().resolve({ depositAddress: "0xa9070019344b5a191b18721ef085b7e626daf86a", feeEstimateUsdc: 0.03, activationIncluded: false, timeEstimateSec: 1, pricedAt: 5000 });
  await flushAsync();
  w.h.flush();
  assert.deepEqual(w.h.value, feeView());
  w.h.unmount();
});

test("F7) a credited deposit after the price, on an activated account, is re-priced too", () => {
  const asks = [];
  globalThis.__impl = { repriceDepositFee: (args) => { asks.push(args); return new Promise(() => {}); }, usePerpAccount: () => null };
  const h = M.mount(() => M.useDepositFee({ user: USER, connected: USER, route: RT.routeById("base-usdc"), data: saved({ activationIncluded: false, feeEstimateUsdc: 0.03 }), accountNew: false, requests: [{ status: "credited", createdAt: 2000 }], enabled: true }));
  h.render(); h.flush();
  assert.equal(asks.length, 1);
  assert.deepEqual(h.value, feeView());
  h.unmount();
});

test("F8) 🔴 the fee and the plan's OWN FLOOR come out of ONE answer: a re-price replaces both, and never one of them", async () => {
  /* The floor is the smallest deposit this route can carry. Under it, what
     arrives is too small for the last hop to move at all and the money stops one
     hop short — so a screen showing a fresh fee beside the floor from an hour ago
     is the worst pair of figures on this sheet. The floor is never withheld for
     its age (lib/relay/depositAddress's resultOf), only replaced. */
  const asks = [];
  let done;
  globalThis.__impl = {
    repriceDepositFee: (args) => { asks.push(args); return new Promise((resolve) => { done = resolve; }); },
    usePerpAccount: () => null,
  };
  const props = { user: USER, connected: USER, route: RT.routeById("base-usdc"), data: saved({ minInputUsdc: 11 }), accountNew: false, requests: [], enabled: true };
  const h = M.mount(() => M.useDepositFee(props));
  h.render(); h.flush();
  /* The fee is withheld while the new one is out; the floor still stands, because
     the screen refusing to name a minimum is how money arrives below it. */
  assert.deepEqual(h.value, feeView({ minInputUsdc: 11 }));
  assert.equal(asks.length, 1);
  done({ depositAddress: DEP, feeEstimateUsdc: 0.029496, activationIncluded: false, timeEstimateSec: 1, pricedAt: 5000, minInputUsdc: 6 });
  await flushAsync();
  h.flush();
  assert.deepEqual(h.value, feeView({ fee: 0.029496, minInputUsdc: 6 }), "the new fee AND the new floor, from the same answer");
  h.unmount();
});

test("A1) useDepositAccountNew asks the account layer about the connected wallet only while enabled", () => {
  const read = [];
  const snap = { address: USER.toLowerCase(), role: { value: "user", master: null, answered: true }, perpBalanceUsdc: { answered: true, reason: null }, ledger: { answered: true, inbound: [] } };
  globalThis.__impl = { usePerpAccount: (a) => { read.push(a); return a ? snap : null; } };
  const props = { user: USER, enabled: true };
  const h = M.mount(() => M.useDepositAccountNew(props));
  h.render();
  assert.equal(read.at(-1), USER);
  assert.equal(h.value, false, "activated");
  snap.role = { value: "missing", master: null, answered: true };
  snap.perpBalanceUsdc = { answered: true, reason: "new-account" };
  h.render();
  assert.equal(h.value, true, "new");
  props.enabled = false;
  h.render();
  assert.equal(read.at(-1), null, "closed: nothing is read");
  assert.equal(h.value, null);
  h.unmount();
});

/* ════════════════════════════════════════════════════════════════════════════
   P. WHICH PLAN, AND WHY IT IS FROZEN WHILE THE SHEET IS OPEN
   ------------------------------------------------------------------------------
   A first deposit takes a different route from every later one (the one-time cost
   of a brand-new account, measured 1.245194 USDC on 25 from Base, which the long
   way round never pays — src/lib/relay/firstDeposit.js). The plan decides
   the destination, so it decides the ADDRESS, and an address is something people
   copy into an exchange withdrawal form. It is therefore chosen once per open and
   held: the answer that would change it arrives while the customer is looking at
   the QR code.
   ════════════════════════════════════════════════════════════════════════════ */

const NEW_ACCOUNT = Object.freeze({
  address: USER,
  role: { answered: true, value: "missing" },
  perpBalanceUsdc: { answered: true, reason: "new-account" },
  ledger: { answered: true, inbound: [] },
  error: null,
  loading: false,
});
const LIVE_ACCOUNT = Object.freeze({ ...NEW_ACCOUNT, role: { answered: true, value: "user" } });

function planWorld({ walletType = "privy", snap = NEW_ACCOUNT, enabled = true, deadlineMs = undefined } = {}) {
  const props = { user: USER, walletType, enabled, ...(deadlineMs === undefined ? {} : { deadlineMs }) };
  let account = snap;
  globalThis.__impl = { usePerpAccount: () => account };
  const h = M.mount(() => M.useDepositPlan(props));
  h.render();
  h.flush();
  return { h, props, set: (s) => { account = s; }, value: () => h.value };
}

test("P1) a brand-new account on a wallet that can finish the journey takes the first-deposit plan", () => {
  const w = planWorld();
  assert.deepEqual(w.value(), { accountNew: true, planId: "arb-first" });
  w.h.unmount();
});

test("P2) 🔴 the plan is FROZEN while the sheet is open: the address on screen cannot change under the customer", () => {
  const w = planWorld();
  assert.equal(w.value().planId, "arb-first");
  /* The deposit lands and the account exists now. The cheaper direct plan is
     right for the NEXT deposit, but swapping the address now would replace the
     one the customer is looking at. */
  w.set(LIVE_ACCOUNT);
  w.h.render();
  w.h.flush();
  assert.equal(w.value().accountNew, false, "the account layer's answer is not hidden");
  assert.equal(w.value().planId, "arb-first", "the plan it was quoted on stays");
  /* Closing the sheet lets go, so the next open reads the world again. */
  w.props.enabled = false;
  w.h.render();
  w.h.flush();
  assert.equal(w.value().planId, null);
  w.props.enabled = true;
  w.h.render();
  w.h.flush();
  assert.equal(w.value().planId, "direct", "the cheaper route, the moment it comes back");
  w.h.unmount();
});

test("P3) 🔴 a wallet that cannot sign the last hop itself is answered at once, with today's route", () => {
  for (const walletType of ["metamask", "walletconnect", null]) {
    const w = planWorld({ walletType, snap: null });
    assert.equal(w.value().planId, "direct", String(walletType));
    w.h.unmount();
  }
  /* A Privy wallet with no answer yet waits: no address is asked for. */
  const waiting = planWorld({ snap: null });
  assert.deepEqual(waiting.value(), { accountNew: null, planId: null });
  waiting.h.unmount();
});

test("P4) an account read that failed is not an account that is new: today's route stands in", () => {
  const w = planWorld({ snap: { address: USER, role: { answered: false, value: null }, error: "Couldn't reach it", loading: false } });
  assert.deepEqual(w.value(), { accountNew: null, planId: "direct" });
  w.h.unmount();
  /* Still loading is not a failure. */
  const loading = planWorld({ snap: { address: USER, role: { answered: false, value: null }, error: null, loading: true } });
  assert.equal(loading.value().planId, null);
  loading.h.unmount();
  /* A snapshot for another wallet decides nothing. */
  const other = planWorld({ snap: { ...NEW_ACCOUNT, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", error: "x", loading: false } });
  assert.equal(other.value().planId, null);
  other.h.unmount();
});

test("P4b) 🔴 AN ANSWER THAT NEVER COMES RUNS OUT OF TIME: the sheet always ends up with an address on it", async () => {
  /* The plan waits for the account layer and the ADDRESS waits for the plan, so a
     question nobody ever answers is a Deposit sheet with no QR code in it — and
     an error is not the only way to get one. A snapshot of another address
     answers nothing and reports nothing wrong (the localhost view makes one), and
     a read still in flight is not a failure either. Before any of this, an
     address always appeared; it has to keep appearing. */
  const stuck = { address: USER, role: { answered: false, value: null }, error: null, loading: true };
  const w = planWorld({ snap: stuck, deadlineMs: 1 });
  assert.equal(w.value().planId, null, "it waits first: standing in early costs a new account the one-time fee");
  await new Promise((r) => setTimeout(r, 10));
  w.h.render();
  w.h.flush();
  assert.deepEqual(w.value(), { accountNew: null, planId: "direct" }, "today's route, which every wallet can use");
  w.h.unmount();
  /* A snapshot that is somebody else's entirely, which reports no error at all. */
  const other = planWorld({ snap: { ...NEW_ACCOUNT, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }, deadlineMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  other.h.render();
  other.h.flush();
  assert.equal(other.value().planId, "direct");
  other.h.unmount();
  /* And the answer still wins when it arrives in time: the wait is not a way of
     quietly giving every customer the more expensive route. */
  const inTime = planWorld({ deadlineMs: 50 });
  assert.equal(inTime.value().planId, "arb-first");
  await new Promise((r) => setTimeout(r, 60));
  inTime.h.render();
  inTime.h.flush();
  assert.equal(inTime.value().planId, "arb-first", "and the plan it was quoted on stays put");
  inTime.h.unmount();
});

test("P5) a closed sheet and a wallet-less sheet read nothing and choose nothing", () => {
  const closed = planWorld({ enabled: false });
  assert.deepEqual(closed.value(), { accountNew: null, planId: null });
  closed.h.unmount();
});
