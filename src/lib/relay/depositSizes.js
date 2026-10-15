// ─────────────────────────────────────────────────────────────────────────────
// What a deposit costs at other sizes: one live quote per size, nothing else.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-28: "ในช่องที่บอกว่า Fee Deposit เท่าไหร่ ขอปุ่มเล็กๆเป็น Break Down ด้วย
// เช่น ถ้า Deposit 100,1000,5000,10000,100000,500000,1M ไรงี้", then twice
// "เอาเรทสด" — LIVE rates, not a formula and not a table typed into this file —
// and "มีDropdown ให้กด", a dropdown he presses.
//
// 🔴 WHY THERE IS NO ARITHMETIC IN HERE AT ALL. Every route's fee decomposes
// cleanly into a flat part and a rate (measured 2026-09-28 across 42 answers:
// Base USDC 1.00 bp, BNB USDC 20.0 bp, Base USDT 51.0 bp), so a formula would
// have been easy and would have been wrong: on Base USDT the swap impact grows
// SUPER-linearly with the size (-0.0022 at 20, -12.88 at 100k, -308.35 at 1M),
// which is why that route's percentage turns back UP past 100,000 — 0.522% at
// 100k, 0.530% at 500k, 0.540% at 1M. A straight line through two points would
// have printed a fee about 300 USDC short on the biggest row on a money screen.
// So every row is one real POST /quote/v2 for the size it names.
//
// 🔴 AND NO ADDRESS COMES OUT OF HERE. These quotes carry one (the body is the
// same one the sheet's own address is asked for, with a different amount), and
// each is a fresh order with its own salt that nobody will ever send to. What
// this file returns is a fee and nothing else: no deposit address, and no
// minInputUsdc. That second omission is the sharp one — the first-deposit plan's
// floor is priced off the amount in the body, so it SCALES with the row, and the
// measured ladder for Base USDT is 6, 12, 37, 68, 627. A floor from the 100,000
// row reaching the sheet would tell a customer the smallest deposit he can make
// is 627 USDC. It is not returned, so it cannot.
//
// 🔴 AND WE ARE A GUEST AT THAT ENDPOINT. Measured: ~32 POSTs inside ~25 s and
// every request came back 429 for the next four runs, recovering after a 90 s
// pause. So SIZES_IN_FLIGHT is three, the answers are kept for as long as the
// sheet keeps its own fee (FEE_FRESH_MS), and one refusal for being too quick
// stops the whole burst instead of finishing it (see priceDepositSizes).
//
// Nothing here signs and nothing here sends. The safety checks, the body, the
// POST and the verifier are depositAddress.js's and firstDeposit.js's own, called
// here rather than copied, so a row's figure comes off the same code path as the
// figure printed above it.

import {
  DIRECT_PLAN, FEE_FRESH_MS, RelayDepositError,
  assertAskable, checkedBody, postQuote,
} from "./depositAddress.js";
import { NOMINAL_DEPOSIT, DEPOSIT_FEE_SIZES, depositAmount } from "./routes.js";
import { HL_NETWORK } from "../hyperliquid/config.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";

/* The sizes this file actually asks about (the owner's own list is routes.js's
   DEPOSIT_FEE_SIZES, beside the arithmetic that turns one into an amount).
   THE NOMINAL ONE IS NOT AMONG THEM:
   its figure is the one already on the screen, handed to the list rather than
   re-quoted, because two quotes minutes apart give two different answers (the
   one-time cost drifts with gas: 1.2411 and 1.2511 on two Base rows measured
   within a minute of each other) and MONEY_RULES section 1 says two surfaces
   showing the same figure must agree. The surest way for them to agree is for
   them to be one number. */
export const QUOTED_FEE_SIZES = Object.freeze(DEPOSIT_FEE_SIZES.filter((s) => s !== NOMINAL_DEPOSIT));

/** How many quotes may be in flight at once (see the note above). */
export const SIZES_IN_FLIGHT = 3;

/* 🔴 THREE ON THE PAGE, NOT THREE PER PRESS. The route is part of the list's own
   key, so every network or token tap ends one burst and starts another, and an
   ended burst is not aborted: its requests are still open at the service. Counted
   per call, the three above was a number we told ourselves and not one we kept —
   five taps with the list open overlap into six and more at once, which is how a
   walk across the networks reaches the refusal measured in the note above in
   under twenty seconds, and a refusal there is also the sheet's own deposit
   address refused, down this same path. One counter for the whole page keeps the
   promise: an ended burst's requests hold their places until they answer, and a
   new burst waits for them. */
let inFlightNow = 0;
const waitingForPlace = [];

/* A place, or a promise of the next one to come free. */
function takePlace(cap) {
  if (inFlightNow < cap) { inFlightNow += 1; return null; }
  return new Promise((resolve) => { waitingForPlace.push(resolve); });
}

/* The place goes to whoever is waiting for one, or back to the page. */
function freePlace() {
  const next = waitingForPlace.shift();
  if (next) next();
  else inFlightNow -= 1;
}

/** The status the quote service refuses a caller who is asking too fast. */
export const RATE_LIMIT_STATUS = 429;

/* One holder of priced sizes; the page keeps one, tests make their own. */
export function newSizeCache() {
  return new Map();
}
const SIZES = newSizeCache();

/** The cache key for one size on one (plan, wallet, route). */
export function sizeCacheKey(plan, user, route, size) {
  return `${plan.id}:${String(user).toLowerCase()}:${route.id}:${size}`;
}

/* 🔴 IS THIS THE SERVICE TELLING US TO SLOW DOWN? Only a refusal that says so.
   Anything else is about the size that was asked for and must not stop the row
   beside it from being priced.
   THE REFUSAL'S OWN SHAPE IS WHAT IS READ, not the class it was built from: this
   answer is read in perp/deposit's own hook now as well as here, and a build that
   hands the two sides their own copy of the error class would turn a plain slow
   down into a refusal about the size — quietly, and in the direction of asking
   again. A refusal carries a code of ours and the status it came back with;
   nothing else does. */
export function isRateLimited(e) {
  return !!(e && typeof e.code === "string" && e.detail && e.detail.status === RATE_LIMIT_STATUS);
}

/**
 * What one deposit size costs on one route and plan, live.
 *
 * The body is the plan's own, built by the same function the sheet's address is
 * built by, with ONE field changed: the amount. The answer is verified by the
 * plan's own parser (the first-deposit plan's, with needFloor false — every
 * check still runs; see lib/relay/firstDeposit.js).
 *
 * Resolves { plan, size, feeEstimateUsdc, topupUsd, quotedAt } — the three
 * fields perp/deposit's depositFeeForDisplay reads, and no address and no floor.
 * Rejects with a RelayDepositError, exactly as an address request does.
 */
export async function quoteDepositSize({
  user, connected, route, size,
  plan = DIRECT_PLAN,
  fetchImpl = globalThis.fetch,
  now = browserNow,
  network = HL_NETWORK,
  timers = browserTimers,
} = {}) {
  assertAskable({ user, connected, route, network });
  if (!Number.isInteger(size) || size <= 0) throw new RelayDepositError("bad-size", "Not a deposit size");
  const body = { ...checkedBody(user, connected, route, plan), amount: depositAmount(route, size) };
  const json = await postQuote(body, { fetchImpl, timers });
  const q = plan.parse(json, { user, route, now: now(), needFloor: false });
  return {
    plan: plan.id,
    size,
    feeEstimateUsdc: q.feeEstimateUsdc,
    /* The gas the first-deposit plan delivers into the customer's own wallet,
       which comes back OUT of the printed figure (depositFeeForDisplay). It does
       not scale with the size — measured 0.050000 flat at every one of them —
       so the netting stays live on the biggest row as on the smallest. */
    topupUsd: Number.isFinite(q.topupUsd) ? q.topupUsd : null,
    quotedAt: q.quotedAt,
  };
}

/* A kept answer is as good as the sheet's own fee for as long as the sheet's own
   fee is: fees move with gas, and an hour is the window the whole screen already
   uses (depositAddress's FEE_FRESH_MS). */
function readSize(cache, key, at) {
  const e = cache.get(key);
  if (!e || !Number.isFinite(e.at) || at < e.at || at - e.at > FEE_FRESH_MS) return null;
  return e;
}

/**
 * Price a list of sizes and report each one as it lands.
 *
 *   onSize(size, quote, error)   quote for an answer, error for a refusal; a
 *                                size that has not landed yet is never reported
 *                                at all, so the caller can show it as unknown
 *   cache                        kept per (plan, wallet, route, size)
 *
 * Returns a stop() for the caller's cleanup. After stop() nothing new is asked
 * for and nothing is reported — but an answer already in flight is still KEPT,
 * so a customer who closes the list and opens it again pays for nothing twice.
 *
 * 🔴 A REFUSAL IS NOT KEPT, and that is measured, not cautious: the same size
 * that answered 200 four times refused once, minutes later, on a genuine dip in
 * the landing side's own liquidity ("Max amount is $93,003 USD"), then answered
 * nine more times. Keeping that refusal for an hour would freeze a moment's dip
 * into a dash the customer cannot clear.
 *
 * 🔴 AND A REFUSAL FOR ASKING TOO FAST STOPS THE BURST. The remaining sizes are
 * reported with the same refusal rather than left looking like they are still
 * coming, and nothing further is sent: finishing the burst is how a customer who
 * opens the list twice gets every row refused.
 */
export function priceDepositSizes({
  user, connected, route,
  plan = DIRECT_PLAN,
  sizes = QUOTED_FEE_SIZES,
  onSize = null,
  cache = SIZES,
  inFlight = SIZES_IN_FLIGHT,
  now = browserNow,
  ...quoteOpts
} = {}) {
  let stopped = false;
  const queue = [...sizes];
  const tell = (size, quote, error) => {
    if (!stopped && typeof onSize === "function") onSize(size, quote, error);
  };

  const many = Number.isInteger(inFlight) && inFlight > 0 ? inFlight : 1;

  const worker = async () => {
    while (!stopped && queue.length) {
      const size = queue.shift();
      let place = false;
      try {
        /* Inside the try with the request: a bad plan or route is a refusal
           reported against the row, never a rejection nobody is waiting on. */
        const key = sizeCacheKey(plan, user, route, size);
        const hit = readSize(cache, key, now());
        if (hit) { tell(size, hit.quote, null); continue; }
        /* A kept answer costs the page nothing, so the place is taken here,
           after the cache and before the request. */
        const wait = takePlace(many);
        place = true;
        if (wait) await wait;
        /* Closed while waiting: the place is handed on rather than spent. */
        if (stopped) return;
        const quote = await quoteDepositSize({ user, connected, route, size, plan, now, ...quoteOpts });
        cache.set(key, { quote, at: now() });
        tell(size, quote, null);
      } catch (e) {
        tell(size, null, e);
        if (isRateLimited(e)) {
          const rest = queue.splice(0, queue.length);
          for (const other of rest) tell(other, null, e);
          return;
        }
      } finally {
        if (place) freePlace();
      }
    }
  };

  for (let i = 0; i < many; i++) worker();
  return () => { stopped = true; };
}
