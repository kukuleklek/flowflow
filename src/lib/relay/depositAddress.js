// ─────────────────────────────────────────────────────────────────────────────
// The Perp wallet's deposit address (Relay), and the deposits that reach it.
// ─────────────────────────────────────────────────────────────────────────────
//
// getPerpDepositAddress asks Relay for an open deposit address on one origin
// route (lib/relay/routes.js). Whatever arrives there in that token is swept by
// Relay and credited as USDC (Perps) to the user's OWN Hyperliquid account.
// trackDeposits then watches that address.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. recipient AND refundTo are the connected wallet, always. The caller hands
//      in both the user and the wallet it is connected to; they must be the same
//      address or nothing is requested. No FlowFlow address is ever a recipient.
//   2. Relay's answer is VERIFIED before an address is returned: the quoted
//      recipient, every refund recipient and every output payment in the order
//      must be the user; the destination must be chain 1337 USDC (Perps); the
//      origin token must be the route's; the transfer the step describes must
//      point at the same deposit address. Anything else is refused and the sheet
//      shows no address at all. An address that cannot be shown to pay the user
//      is never shown.
//   3. Unknown is null (the dash), never 0 (docs/MONEY_RULES.md section 0).
//
// 🔴 WHY THE CACHE IS REQUIRED, NOT AN OPTIMISATION. Live, 2026-09-22: two
// deposit-address quotes 20 s apart, same route, same user, gave two different
// addresses (0xbadf…074d, then 0xa907…f86a): each quote is a new order with a
// random salt. Each order carries a deadline 180 days out. So one address per
// (user, route) is kept, in memory for the session and in localStorage across
// visits, and renewed 14 days before its deadline. Without it every open of the
// sheet would show a different address, and a user who saved the first one (an
// exchange withdrawal whitelist) would be told it is wrong.
//
// 🔴 THE ROUTE IS RE-CHECKED BEFORE ANY ADDRESS IS SHOWN, cached or new. A
// saved address lives for months, and Relay may stop taking deposits on a
// chain or drop a token as a solver currency in that time; a non-solver token
// sent to a deposit address cannot be recovered (Relay's deposit-address docs,
// routes.js). So Relay's live chains list is read (at most once per
// ROUTE_CHECK_TTL_MS) and the route run through relayRouteProblems(): a route
// that fails shows no address and its saved one is forgotten. A chains list
// that cannot be read shows no address either (the safe side).
//
// 🔴 THE FEE IS RE-PRICED, THE ADDRESS IS NOT. A saved address keeps the fee
// of the quote it came with, and that fee goes out of date: after an hour
// (FEE_FRESH_MS, gas moves), and at once when the quote was made while the
// Hyperliquid account was new, because a first deposit pays the activation
// and every later one does not (owner, 2026-09-22: the sheet still showed the
// first-time fee after the account was activated). A new address would fix the
// fee and break the address, so repriceDepositFee asks Relay for a fresh quote
// on the same route for the same wallet, verifies it exactly like the first
// one, keeps ONLY its fee and time, and throws its freshly minted address away:
// that address is never returned and never saved. The saved entry gets the new
// figures (with pricedAt) only while it still holds the address the caller had
// on screen. Whether the account is new is the account layer's answer, read by
// the sheet (perp/deposit); this file never guesses it.
//
// UNVERIFIED (not testable without real money): that an open EXACT_INPUT
// address accepts any amount rather than the nominal one it was priced on. The
// docs say an open address is reusable for its route and that an underpaid
// deposit fills if it still covers fees and the minimum fill.
//
// Nothing runs at import time. No signing, no transaction, no key: this file
// only reads Relay's public API. The browser defaults (timers, visibility) come
// from lib/hyperliquid/browser.js; tests inject their own.

import {
  RELAY_API, RELAY_QUOTE_URL, HL_RELAY_CHAIN_ID, HL_PERP_USDC,
  PERP_DEPOSIT_ROUTES, routeById, nominalAmount, relayRouteProblems,
} from "./routes.js";
import { HL_NETWORK } from "../hyperliquid/config.js";
import { browserTimers, browserNow, docHidden, onDocVisibility } from "../hyperliquid/browser.js";
/* 🔴 THE SERVICE'S OWN WORDS, MADE PLAIN BEFORE THEY ARE THROWN. Every message
   below that is not ours is the quote service's, and the deposit sheet prints a
   relay-error's message verbatim (perpDepositView's depositErrorText), so an
   upstream refusal that names itself would name it on a money screen. Scrubbed
   at the throw, once, so every reader of these errors is clean however it
   renders them (owner, 2026-09-23; the withdraw path does the same). */
import { plainMoneyWords } from "./plainWords.js";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEPOSIT_CACHE_PREFIX = "flowflow.perpDeposit.v1:";
/* ── THE TWO PLANS A DEPOSIT CAN BE QUOTED ON ────────────────────────────────
   A plan is the destination a deposit address is quoted to, and everything that
   follows from it: the body asked for, the answer's verifier, the cache the
   address is kept in, and the extra figures that answer carries. There are two,
   and the account layer picks between them (perp/deposit):

     direct     straight to USDC (Perps) on 1337. Cheapest and simplest for an
                account that already exists, and it is what shipped first.
     arb-first  to the customer's OWN address on another chain, with gas beside
                it, so their own wallet makes the last hop (lib/relay/firstDeposit.js).
                It exists because a first deposit into a brand-new account pays a
                one-time cost that a plain transfer into the venue's deposit
                contract does not.

   This file owns the plumbing both share — the verifier, the cache, the
   re-price, the live route check — and knows nothing else about the second one.
   A plan's addresses live under its OWN cache prefix, so one plan can never
   hand back the other's address, and an entry saved before plans existed reads
   as the direct one it was. */
export const DIRECT_DESTINATION = Object.freeze({
  chainId: HL_RELAY_CHAIN_ID,
  currency: HL_PERP_USDC,
  orderChain: "hyperliquid",
  /* 🔴 A first deposit to a never-used account is charged here, and only here:
     the credit is an internal transfer to an address that does not exist yet. */
  carriesActivation: true,
  wording: "the USDC in your Perp wallet",
});
/** The plan that shipped first, and the default of every function below. */
export const DIRECT_PLAN = Object.freeze({
  id: "direct",
  prefix: DEPOSIT_CACHE_PREFIX,
  destination: DIRECT_DESTINATION,
  body: buildDepositQuoteBody,
  parse: parseDepositQuote,
  /* Figures beyond the shared ones that this plan's answer carries into the
     cache and back out to the sheet. The direct plan has none. */
  figures: Object.freeze([]),
});
/** Renew an address this long before its order's deadline. */
export const RENEW_BEFORE_MS = 14 * DAY;
/** An answer with no deadline is treated as living this long. */
export const FALLBACK_TTL_MS = 30 * DAY;
/** A cached fee older than this is withheld (the dash): fees move with gas. */
export const FEE_FRESH_MS = HOUR;
/** A first deposit to a new Hyperliquid account carries about 1.2 USDC of relayerGas. */
export const ACTIVATION_FLOOR_USDC = 1;
/* Origin chains whose sweep gas ALONE can pass that floor (Ethereum L1): there a
   large relayerGas may be gas, the activation, or both, so it is not claimed. */
export const GAS_CAN_PASS_ACTIVATION = Object.freeze([1]);
export const QUOTE_TIMEOUT_MS = 20000;
/** Relay's chains list is re-read after this long (once per page load in practice). */
export const ROUTE_CHECK_TTL_MS = 30 * MINUTE;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TRANSFER_SELECTOR = "0xa9059cbb";

export class RelayDepositError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "RelayDepositError";
    this.code = code;
    this.detail = detail;
  }
}

/** A 20-byte hex address that is not the zero address. */
export function isEvmAddress(a) {
  return typeof a === "string" && ADDRESS_RE.test(a) && a.toLowerCase() !== ZERO_ADDRESS;
}

/** Same address, whatever the checksum casing. False for anything that is not an address. */
export function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && ADDRESS_RE.test(a) && ADDRESS_RE.test(b) && a.toLowerCase() === b.toLowerCase();
}

/* A finite number from a number or a numeric string; null otherwise (never 0). */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/* 🔴 A FIGURE THE SCREEN NAMES USDC HAS TO BE IN USDC.
   Every figure the Deposit sheet prints is named USDC, and an answer states each
   of its own legs twice: in the leg's own token, and in dollars. So a leg already
   quoted in USDC is read in USDC, and a leg in any other token is read at the
   answer's OWN dollar value — never at its token amount, which is not what the
   word beside it says. Measured 2026-09-28 on a 20 USDT deposit from Base:
   amountFormatted "20.0" beside amountUsd "19.977960", and the one-time cost on
   that route 1.225998 in USDT beside 1.224647 in dollars.
   A leg whose own figure cannot be read is unknown (null, the dash).

   🔴 WHICH TOKEN A LEG IS IN IS THE ROUTE'S ANSWER, NOT THE LEG'S OWN. The
   currency block's symbol is the one field in a leg that nothing above verifies:
   the origin leg is pinned by chainId and address against the route, the
   destination leg against the plan's destination, and the symbol beside them is
   checked by nobody. A money figure's UNIT decided by an unverified field is a
   money figure decided by nothing. It also reads wrong where it looks right —
   the direct plan's two legs are Base USDC and USDC (Perps) on 1337, which are
   two different tokens under one symbol. So the unit is taken from route.token,
   which routes.js cross-checks against the live chains list, and from the
   destination, which is that same USDC on both plans by construction. The sweep
   cost is stated in the ORIGIN token (measured 2026-09-28: every USDT route's
   relayerGas carries the origin token's own symbol), so it reads the same way. */
function originIsUsdc(route) {
  return !!route && route.token === "USDC";
}
function usdcAmount(leg, route) {
  if (!leg || typeof leg !== "object") return null;
  return originIsUsdc(route) ? num(leg.amountFormatted) : num(leg.amountUsd);
}

/* 🔴 WHAT THE DEPOSIT LOSES BETWEEN TWO LEGS, in one unit for both of them.
   USDC on both sides is a plain difference in USDC, which is exact and is what
   every USDC route prints today. A route whose origin token is NOT the USDC the
   destination pays out takes BOTH sides in dollars, because one of each is how
   20.0 USDT minus 19.758931 USDC became a fee printed as 0.24 USDC on a deposit
   that really lost 0.171044 (measured 2026-09-28, the answer's own
   details.totalImpact.usd). Taken in dollars the same answer gives 0.221044
   before the gas top-up comes out of it, and 0.171044 after — the answer's own
   figure, to the last digit it states.
   A side that cannot be read, or an answer that gives out more than went in, is
   unknown (null, the dash), never a mixed subtraction and never a 0.

   🔴 AND WHAT THE USDC BRANCH GIVES UP BY STAYING IN TOKENS, measured rather
   than assumed. Taken in tokens, the figure misses the answer's own dollars by
   the two legs' peg difference — two USDC tokens on two chains are not priced
   to the same digit — and that gap grows with the size quoted. Re-parsed across
   all 33 recorded USDC answers of 2026-09-28, the worst at the 20 tokens this
   screen prices on is 0.00031 (Optimism), against 0.000000 on every one of the
   15 USDT answers, which take both legs in dollars. A third of a thousandth of
   a cent cannot move a figure printed to two decimals, and the fee is always
   priced on that same 20, so it is left alone: taking these in dollars too
   would move every USDC route's stored figure to buy nothing anybody can see.
   The gap is not the gas top-up and does not scale with it. */
function lossBetween(inLeg, outLeg, route) {
  if (!inLeg || typeof inLeg !== "object" || !outLeg || typeof outLeg !== "object") return null;
  const same = originIsUsdc(route);
  const went = same ? num(inLeg.amountFormatted) : num(inLeg.amountUsd);
  const came = same ? num(outLeg.amountFormatted) : num(outLeg.amountUsd);
  if (went == null || came == null || went < came) return null;
  return round6(went - came);
}

/* 🔴 WHICH DEFINITION WROTE A SAVED FEE. A cache entry holds a figure, not the
   arithmetic that made it, and that arithmetic has just changed: on a route
   whose origin token is not USDC the fee and the one-time cost are the answer's
   own dollars now, where they used to be a token amount under the word USDC
   (lossBetween above). An entry written by the older one is still well formed,
   still this user's, still this route's and still inside its hour, so nothing
   else here refuses it — and the same figure computed two ways on two screens
   within one hour is the disagreement MONEY_RULES exists to stop. Measured on
   the recorded 20 USDT answer from Base: the old definition prints 0.19 where
   the new one prints 0.17, decided only by when the customer last opened the
   sheet. So a saved fee names the definition that wrote it, and one written by
   any other is withheld for its age exactly as an hour-old fee is: the address
   stays (an address that changes under somebody who has already copied it is
   its own kind of loss) and the re-price the sheet already asks for brings the
   figure back under the arithmetic on screen. A USDC route's saved fee is
   untouched, because the change cannot move it. */
export const FEE_DEFINITION = 2;

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

const MEMORY = new Map();
const INFLIGHT = new Map();

/** A fresh holder for one chains list (the page keeps one; tests make their own). */
export function newRelayChainsMemo() {
  return { at: null, chains: null, running: null };
}
const CHAINS = newRelayChainsMemo();

/** The cache key for one (user, route) on one plan. Each plan has its own prefix. */
export function depositCacheKey(user, routeId, plan = DIRECT_PLAN) {
  return `${plan.prefix}${String(user).toLowerCase()}:${routeId}`;
}

/** The /quote/v2 body. recipient and refundTo are the user, by construction. */
export function buildDepositQuoteBody({ user, route }) {
  return {
    user,
    recipient: user,
    refundTo: user,
    originChainId: route.chainId,
    originCurrency: route.address,
    destinationChainId: HL_RELAY_CHAIN_ID,
    destinationCurrency: HL_PERP_USDC,
    amount: nominalAmount(route),
    tradeType: "EXACT_INPUT",
    useDepositAddress: true,
  };
}

/* The refusal every unsafe answer gets. The reason is kept for the console and
   the report; the sheet shows no address. Exported because the second plan's
   verifier (lib/relay/firstDeposit.js) refuses in exactly the same words. */
export function unsafeQuote(why) {
  return new RelayDepositError("unsafe-quote", `The answer did not check out (${why}); no address is shown`, { why });
}
const unsafe = unsafeQuote;

/**
 * Verify a /quote/v2 answer for (user, route) and read what the sheet needs.
 * Throws RelayDepositError ("bad-deposit-address" or "unsafe-quote") unless the
 * answer provably pays the user; fee, time and deadline are null when unreadable.
 */
export function parseDepositQuote(json, { user, route, now = Date.now(), dest = DIRECT_DESTINATION } = {}) {
  const steps = json && Array.isArray(json.steps) ? json.steps : null;
  if (!steps || steps.length !== 1) throw unsafe("expected exactly one deposit step");
  const step = steps[0] || {};
  const addr = step.depositAddress;
  if (!isEvmAddress(addr)) throw new RelayDepositError("bad-deposit-address", "No usable deposit address came back", { depositAddress: addr ?? null });
  if (sameAddress(addr, user)) throw new RelayDepositError("bad-deposit-address", "The deposit address is the wallet itself", { depositAddress: addr });

  const d = json.details || {};
  if (!sameAddress(d.recipient, user)) throw unsafe("the recipient is not this wallet");
  const cin = (d.currencyIn && d.currencyIn.currency) || {};
  const cout = (d.currencyOut && d.currencyOut.currency) || {};
  if (Number(cin.chainId) !== route.chainId || String(cin.address).toLowerCase() !== route.address) throw unsafe("the origin token is not the route's");
  if (Number(cout.chainId) !== dest.chainId || String(cout.address).toLowerCase() !== dest.currency) throw unsafe(`the destination is not ${dest.wording}`);

  /* The order itself: who gets paid, and who gets a refund. */
  const order = json.protocol && json.protocol.v2 && json.protocol.v2.orderData;
  if (!order) throw unsafe("the order is missing, so its recipients cannot be checked");
  const output = order.output || {};
  const payments = Array.isArray(output.payments) ? output.payments : [];
  if (output.chainId !== dest.orderChain) throw unsafe("the order pays out on another chain");
  if (!payments.length || !payments.every((p) => p && sameAddress(p.recipient, user))) throw unsafe("an order payment is not to this wallet");
  if (!payments.every((p) => String(p.currency).toLowerCase() === dest.currency)) throw unsafe("an order payment is not the destination's own USDC");
  /* Relay's deposit-address guide: calldata execution on the destination is not
     allowed. The live answer carries an empty list; any call is a way to move
     the credited USDC on after paying the user, so it is refused. */
  if (output.calls !== undefined && !(Array.isArray(output.calls) && output.calls.length === 0)) throw unsafe("the order runs calls on the destination chain");
  const inputs = Array.isArray(order.inputs) ? order.inputs : [];
  const refunds = inputs.flatMap((i) => (i && Array.isArray(i.refunds) ? i.refunds : []));
  if (!inputs.length || !refunds.length || !refunds.every((r) => r && sameAddress(r.recipient, user))) throw unsafe("a refund is not to this wallet");

  /* The step's own transaction, when present: a transfer of the route's token,
     on the route's chain, to this same deposit address. */
  const tx = Array.isArray(step.items) && step.items[0] && step.items[0].data;
  if (tx) {
    const data = String(tx.data || "").toLowerCase();
    const to = data.startsWith(TRANSFER_SELECTOR) ? `0x${data.slice(10 + 24, 10 + 64)}` : null;
    if (Number(tx.chainId) !== route.chainId) throw unsafe("the transfer is on another chain");
    if (String(tx.to).toLowerCase() !== route.address) throw unsafe("the transfer is of another token");
    if (!to || !sameAddress(to, addr)) throw unsafe("the transfer points at another address");
  }

  const fee = lossBetween(d.currencyIn, d.currencyOut, route);
  const time = num(d.timeEstimate);
  const gas = usdcAmount(json.fees && json.fees.relayerGas, route);
  const deadline = num(output.deadline);
  /* A destination that cannot be charged the one-time cost is not guessed at
     from its gas: on the second plan the credit lands in the customer's own
     wallet on a chain they already exist on, so there is nothing to activate. */
  const activationIncluded = !dest.carriesActivation ? false
    : gas == null ? null
    : gas < ACTIVATION_FLOOR_USDC ? false
    : GAS_CAN_PASS_ACTIVATION.includes(route.chainId) ? null : true;
  return {
    depositAddress: addr.toLowerCase(),
    feeEstimateUsdc: fee,
    timeEstimateSec: time != null && time >= 0 ? time : null,
    activationIncluded,
    /* THE LIVE ONE-TIME COST, for the first-deposit line (owner, 2026-09-23:
       "with the live figure"). It is this quote's own relayerGas, and only
       where the quote is the kind that carries the activation: on a route
       whose sweep gas alone can pass the floor the figure would be gas, the
       activation, or both, and a figure nobody can tell apart is not printed. */
    activationUsdc: activationIncluded === true ? gas : null,
    expiresAt: deadline != null && deadline > 0 ? deadline * 1000 : null,
    quotedAt: now,
    requestId: typeof json.requestId === "string" ? json.requestId : null,
  };
}

/* A cache entry is used only if it is well formed and is for exactly this user
   and this route. A tampered or foreign entry is ignored, never trusted. */
function entryUsable(e, user, route, now, plan = DIRECT_PLAN) {
  if (!e || typeof e !== "object" || e.v !== 1) return false;
  /* An entry saved before plans existed is the direct one it was quoted as. */
  if ((e.plan || DIRECT_PLAN.id) !== plan.id) return false;
  if (!sameAddress(e.user, user) || e.routeId !== route.id || e.chainId !== route.chainId || e.currency !== route.address) return false;
  if (!isEvmAddress(e.depositAddress) || sameAddress(e.depositAddress, user)) return false;
  if (!Number.isFinite(e.quotedAt) || e.quotedAt > now + 10 * MINUTE) return false;
  const end = Number.isFinite(e.expiresAt) ? e.expiresAt : e.quotedAt + FALLBACK_TTL_MS;
  return now < end - RENEW_BEFORE_MS;
}

function readEntry(storage, memory, key, user, route, now, plan = DIRECT_PLAN) {
  const m = memory.get(key);
  if (entryUsable(m, user, route, now, plan)) return m;
  if (!storage) return null;
  let raw = null;
  try { raw = storage.getItem(key); } catch { return null; }
  if (!raw) return null;
  let e = null;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!entryUsable(e, user, route, now, plan)) return null;
  memory.set(key, e);
  return e;
}

/* When the entry's fee was priced: its own re-price, else the quote itself. A
   pricedAt that is not a sane time is ignored (the quote's time stands). */
function pricedAtOf(e, now) {
  return Number.isFinite(e.pricedAt) && e.pricedAt >= e.quotedAt && e.pricedAt <= now + 10 * MINUTE ? e.pricedAt : e.quotedAt;
}

function writeEntry(storage, memory, key, entry) {
  memory.set(key, entry);
  if (!storage) return;
  try { storage.setItem(key, JSON.stringify(entry)); } catch { /* private mode: the session copy still holds */ }
}

/* What the sheet gets. A cached fee older than FEE_FRESH_MS is withheld, and
   says so (feeStale): withheld for its age is not the same as unknown, since a
   re-price can bring it back. */
function resultOf(e, route, now, fromCache, plan = DIRECT_PLAN) {
  const pricedAt = pricedAtOf(e, now);
  /* A fee the arithmetic on screen did not write is withheld like an old one
     (FEE_DEFINITION above). USDC routes are unmoved by the change, so an entry
     saved before the marker existed still stands on them. */
  const ourArithmetic = originIsUsdc(route) || e.feeDefinition === FEE_DEFINITION;
  const fresh = ourArithmetic && now - pricedAt <= FEE_FRESH_MS;
  /* A plan's own figures are NOT withheld for their age. The one the second
     plan carries is the smallest deposit that can finish the journey, and a
     screen with no figure there is a screen that cannot warn anybody; it is
     rounded up to a whole token, so an hour of fee drift cannot reach it, and
     the hard check happens against the chain at the moment of the move. */
  const own = {};
  for (const k of plan.figures) own[k] = Number.isFinite(e[k]) ? e[k] : null;
  return {
    plan: plan.id,
    ...own,
    depositAddress: e.depositAddress,
    feeEstimateUsdc: fresh ? e.feeEstimateUsdc : null,
    activationIncluded: fresh ? e.activationIncluded : null,
    activationUsdc: fresh && Number.isFinite(e.activationUsdc) ? e.activationUsdc : null,
    feeStale: !fresh && e.feeEstimateUsdc != null,
    timeEstimateSec: e.timeEstimateSec,
    route,
    quotedAt: e.quotedAt,
    pricedAt,
    expiresAt: e.expiresAt,
    requestId: e.requestId,
    fromCache,
  };
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

/**
 * Relay's live chains list (GET /chains), kept for ROUTE_CHECK_TTL_MS. Two
 * readers at once share one request. Rejects with a RelayDepositError (network,
 * relay-error, bad-response); a failure is not kept, so the next open asks again.
 */
export async function readRelayChains({ fetchImpl = globalThis.fetch, memo = CHAINS, now = browserNow, timers = browserTimers } = {}) {
  const t = now();
  if (memo.chains && Number.isFinite(memo.at) && t >= memo.at && t - memo.at < ROUTE_CHECK_TTL_MS) return memo.chains;
  if (memo.running) return memo.running;
  const job = (async () => {
    let res;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS) : null;
    try {
      res = await fetchImpl(`${RELAY_API}/chains`, { method: "GET", signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      throw new RelayDepositError("network", "Couldn't reach the deposit service to check the route", { cause: String((e && e.message) || e) });
    } finally {
      if (guard != null) timers.clearTimeout(guard);
    }
    const json = await readJson(res);
    if (!res.ok) {
      const msg = json && typeof json.message === "string" ? json.message : `the service answered ${res.status}`;
      throw new RelayDepositError("relay-error", plainMoneyWords(msg), { status: res.status });
    }
    if (!json || !Array.isArray(json.chains)) throw new RelayDepositError("bad-response", "The network list was not readable");
    memo.chains = json.chains;
    memo.at = now();
    return json.chains;
  })();
  memo.running = job;
  try { return await job; } finally { memo.running = null; }
}

/** What in a chains list stops THIS route (its own lines, and the destination's). Empty: the route is live. */
export function routeProblemsIn(chains, route) {
  const own = `${route.id}:`;
  return relayRouteProblems(chains).filter((line) => line.startsWith(own) || !/^[a-z0-9-]+:/.test(line));
}

/* One POST /quote/v2 with a body built by buildDepositQuoteBody, answered as
   JSON. Rejects with a RelayDepositError (network, relay-error).

   Exported for the fee breakdown (lib/relay/depositSizes.js), which prices the
   same route on other deposit sizes: ONE path to this endpoint, so its timeout,
   its scrubbed refusal and the status and code it carries on the refusal cannot
   come out differently on one screen than on another. */
export async function postQuote(body, { fetchImpl, timers }) {
  let res;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctrl ? timers.setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS) : null;
  try {
    res = await fetchImpl(RELAY_QUOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    throw new RelayDepositError("network", "Couldn't reach the deposit service", { cause: String((e && e.message) || e) });
  } finally {
    if (t != null) timers.clearTimeout(t);
  }
  const json = await readJson(res);
  if (!res.ok) {
    const msg = json && typeof json.message === "string" ? json.message : `the service answered ${res.status}`;
    throw new RelayDepositError("relay-error", plainMoneyWords(msg), { status: res.status, errorCode: (json && json.errorCode) || null });
  }
  return json;
}

/* The checks every request for (user, route) passes BEFORE anything leaves.
   Exported for the same reason postQuote is: the breakdown's quotes are refused
   by this function, in these words, or they do not leave either. */
export function assertAskable({ user, connected, route, network }) {
  if (!isEvmAddress(user)) throw new RelayDepositError("bad-user", "Not a wallet address");
  if (!sameAddress(user, connected)) throw new RelayDepositError("not-connected", "The deposit address is only made for the wallet that is connected");
  if (!route || routeById(route.id) !== route || !PERP_DEPOSIT_ROUTES.includes(route)) {
    throw new RelayDepositError("bad-route", "Not a supported deposit route");
  }
  /* Relay credits MAINNET Hyperliquid. A testnet build showing testnet balances
     must never take a real deposit. */
  if (network !== "mainnet") throw new RelayDepositError("testnet-off", "Deposits are open on mainnet only");
}

/* The quote body, with recipient and refundTo checked against the connected wallet.
   Exported: the breakdown builds its own bodies from this one, changing nothing
   but the amount, so no body can ever leave with another recipient in it. */
export function checkedBody(user, connected, route, plan = DIRECT_PLAN) {
  const body = plan.body({ user, route });
  if (!sameAddress(body.recipient, connected) || !sameAddress(body.refundTo, connected)) {
    throw new RelayDepositError("not-connected", "recipient and refundTo must be the connected wallet");
  }
  return body;
}

/* The route must still be live on Relay; a dead one forgets its saved address. */
async function assertRouteLive({ route, fetchImpl, chainsMemo, now, timers, storage, memory, key }) {
  const chains = await readRelayChains({ fetchImpl, memo: chainsMemo, now, timers });
  const problems = routeProblemsIn(chains, route);
  if (problems.length) {
    forgetEntry(storage, memory, key);
    throw new RelayDepositError("route-unavailable", `This deposit is closed right now (${problems.join("; ")}); no address is shown`, { problems });
  }
}

function forgetEntry(storage, memory, key) {
  memory.delete(key);
  if (!storage) return;
  try { storage.removeItem(key); } catch { /* the session copy is gone; the saved one fails the same check next time */ }
}

/**
 * The Perp wallet's deposit address for one route.
 *
 *   user       the wallet the deposit is for (recipient and refundTo)
 *   connected  the address the wallet context is connected to RIGHT NOW; must
 *              equal user, or nothing is requested
 *   route      a route object from lib/relay/routes.js (the table's own object)
 *
 * Resolves { depositAddress, feeEstimateUsdc, timeEstimateSec, route,
 * activationIncluded, activationUsdc, quotedAt, expiresAt, requestId, fromCache }. Rejects with a
 * RelayDepositError: not-connected, bad-user, bad-route, testnet-off, network,
 * relay-error, bad-response, route-unavailable, bad-deposit-address, unsafe-quote.
 */
export async function getPerpDepositAddress({
  user, connected, route,
  plan = DIRECT_PLAN,
  fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
  memory = MEMORY,
  now = browserNow,
  network = HL_NETWORK,
  timers = browserTimers,
  chainsMemo = CHAINS,
} = {}) {
  assertAskable({ user, connected, route, network });
  const key = depositCacheKey(user, route.id, plan);
  /* The route must still be live on Relay before ANY address is shown. */
  await assertRouteLive({ route, fetchImpl, chainsMemo, now, timers, storage, memory, key });
  const hit = readEntry(storage, memory, key, user, route, now(), plan);
  if (hit) return resultOf(hit, route, now(), true, plan);
  const running = INFLIGHT.get(key);
  if (running) return running;

  const body = checkedBody(user, connected, route, plan);

  const job = (async () => {
    const json = await postQuote(body, { fetchImpl, timers });
    const q = plan.parse(json, { user, route, now: now() });
    const entry = {
      v: 1,
      plan: plan.id,
      user: user.toLowerCase(),
      routeId: route.id,
      chainId: route.chainId,
      currency: route.address,
      depositAddress: q.depositAddress,
      feeEstimateUsdc: q.feeEstimateUsdc,
      feeDefinition: FEE_DEFINITION,
      activationIncluded: q.activationIncluded,
      activationUsdc: q.activationUsdc,
      timeEstimateSec: q.timeEstimateSec,
      quotedAt: q.quotedAt,
      pricedAt: q.quotedAt,
      expiresAt: q.expiresAt,
      requestId: q.requestId,
    };
    for (const k of plan.figures) entry[k] = Number.isFinite(q[k]) ? q[k] : null;
    writeEntry(storage, memory, key, entry);
    return resultOf(entry, route, now(), false, plan);
  })();
  INFLIGHT.set(key, job);
  try { return await job; } finally { INFLIGHT.delete(key); }
}

/**
 * A fresh fee for an address already on screen (see THE FEE IS RE-PRICED above).
 *
 *   user, connected, route   as getPerpDepositAddress, refused the same way
 *   depositAddress           the address the sheet shows for (user, route)
 *
 * Resolves { depositAddress, feeEstimateUsdc, activationIncluded, activationUsdc,
 * timeEstimateSec, pricedAt }: depositAddress is the one given, never the
 * re-quote's. The saved entry takes the new figures only while it holds that
 * same address; a re-price never creates an entry. Rejects with a
 * RelayDepositError (the address's codes, plus bad-deposit-address).
 */
export async function repriceDepositFee({
  user, connected, route, depositAddress,
  plan = DIRECT_PLAN,
  fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
  memory = MEMORY,
  now = browserNow,
  network = HL_NETWORK,
  timers = browserTimers,
  chainsMemo = CHAINS,
} = {}) {
  assertAskable({ user, connected, route, network });
  if (!isEvmAddress(depositAddress) || sameAddress(depositAddress, user)) {
    throw new RelayDepositError("bad-deposit-address", "Not a deposit address");
  }
  const key = depositCacheKey(user, route.id, plan);
  await assertRouteLive({ route, fetchImpl, chainsMemo, now, timers, storage, memory, key });
  const flight = `reprice:${key}:${depositAddress.toLowerCase()}`;
  const running = INFLIGHT.get(flight);
  if (running) return running;
  const body = checkedBody(user, connected, route, plan);

  const job = (async () => {
    const json = await postQuote(body, { fetchImpl, timers });
    /* Verified like any quote: it must pay this wallet, on this route. */
    const q = plan.parse(json, { user, route, now: now() });
    const priced = {
      feeEstimateUsdc: q.feeEstimateUsdc,
      /* The fresh figure carries its own arithmetic, so re-pricing an entry
         saved by the older one retires it for good (never a second ask). */
      feeDefinition: FEE_DEFINITION,
      activationIncluded: q.activationIncluded,
      activationUsdc: q.activationUsdc,
      timeEstimateSec: q.timeEstimateSec,
      pricedAt: q.quotedAt,
    };
    /* A fresh price refreshes the plan's own figures too, so the smallest safe
       deposit on screen is always the one this answer supports. */
    for (const k of plan.figures) priced[k] = Number.isFinite(q[k]) ? q[k] : null;
    const e = readEntry(storage, memory, key, user, route, now(), plan);
    if (e && sameAddress(e.depositAddress, depositAddress)) writeEntry(storage, memory, key, { ...e, ...priced });
    return { depositAddress: depositAddress.toLowerCase(), ...priced };
  })();
  INFLIGHT.set(flight, job);
  try { return await job; } finally { INFLIGHT.delete(flight); }
}

/* ── deposits arriving: GET /requests/v2?depositAddress= ─────────────────────
   Relay's request statuses (its docs, and the Relay integration inside the FOMO
   bundle: delayed / waiting / pending in flight, success, refund, failure),
   folded into what the sheet says. Anything unmapped is "unknown", never
   "credited". */
export const REQUEST_STATUS = Object.freeze({
  waiting: "arriving",
  depositing: "arriving",
  pending: "arriving",
  submitted: "arriving",
  delayed: "arriving",
  success: "credited",
  refund: "refunded",
  refunded: "refunded",
  failure: "failed",
  failed: "failed",
});

const hashOf = (v) => (typeof v === "string" && HASH_RE.test(v) ? v : null);
const timeOf = (v) => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** One Relay request as a row. Unknown fields are null. */
export function normalizeRelayRequest(req, { user = null } = {}) {
  const r = req && typeof req === "object" ? req : {};
  const data = r.data && typeof r.data === "object" ? r.data : {};
  const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const inTx = Array.isArray(data.inTxs) ? data.inTxs[0] || null : null;
  const outTx = Array.isArray(data.outTxs) ? data.outTxs[0] || null : null;
  const recipient = r.recipient || meta.recipient || null;
  const mismatch = !!(user && recipient && !sameAddress(recipient, user));
  const relayStatus = typeof r.status === "string" ? r.status : null;
  const cin = meta.currencyIn || {};
  const cout = meta.currencyOut || {};
  const chainId = inTx ? num(inTx.chainId) : null;
  return {
    id: typeof r.id === "string" ? r.id : null,
    relayStatus,
    status: mismatch ? "unknown" : (relayStatus && REQUEST_STATUS[relayStatus]) || "unknown",
    mismatch,
    amountIn: num(cin.amountFormatted),
    symbolIn: (cin.currency && typeof cin.currency.symbol === "string" && cin.currency.symbol) || null,
    amountOut: num(cout.amountFormatted),
    symbolOut: (cout.currency && typeof cout.currency.symbol === "string" && cout.currency.symbol) || null,
    inTxHash: hashOf(inTx && inTx.hash),
    inChainId: chainId != null && Number.isInteger(chainId) ? chainId : null,
    outTxHash: hashOf(outTx && outTx.hash),
    createdAt: timeOf(r.createdAt),
    updatedAt: timeOf(r.updatedAt),
    failReason: typeof data.failReason === "string" && data.failReason && data.failReason !== "N/A" ? data.failReason : null,
  };
}

/** Newest first; a row with no time sorts last. */
function byNewest(a, b) {
  const x = a.createdAt == null ? -1 : a.createdAt;
  const y = b.createdAt == null ? -1 : b.createdAt;
  return y - x;
}

/** One look at the deposits made to an address. Throws on a failed or malformed answer. */
export async function fetchDepositRequests({ depositAddress, user = null, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!isEvmAddress(depositAddress)) throw new RelayDepositError("bad-deposit-address", "Not a deposit address");
  const res = await fetchImpl(`${RELAY_API}/requests/v2?depositAddress=${encodeURIComponent(depositAddress)}`, { method: "GET", signal });
  const json = await readJson(res);
  if (!res.ok) {
    const err = new RelayDepositError("relay-error", plainMoneyWords((json && typeof json.message === "string" && json.message) || `the service answered ${res.status}`), { status: res.status });
    err.status = res.status;
    throw err;
  }
  if (!json || !Array.isArray(json.requests)) throw new RelayDepositError("bad-response", "The deposit list was not readable");
  return json.requests.map((q) => normalizeRelayRequest(q, { user })).sort(byNewest);
}

/* ── the poll schedule ───────────────────────────────────────────────────────
   Gentle on purpose: Relay allows about 200 status reads a minute per API key
   and publishes nothing for keyless callers. It runs once per deposit address
   the app is watching (perp/deposit/depositWatch.js): the one an open sheet
   shows, and for a while after it closes, each starting again at the idle
   cadence and backing off to the cap. */
export const TRACK_IN_FLIGHT_MS = 8000;
/* A deposit on its way is looked at every 8 s for this many unchanged looks;
   after that (a delayed or stuck request) the in-flight cadence backs off like
   the idle one, to the same 60 s cap. */
export const TRACK_IN_FLIGHT_GRACE_ROUNDS = 3;
export const TRACK_IDLE_MS = 12000;
export const TRACK_IDLE_MAX_MS = 60000;
export const TRACK_ERROR_MS = 15000;
export const TRACK_ERROR_MAX_MS = 120000;
export const TRACK_RATE_LIMIT_MS = 60000;
export const TRACK_TIMEOUT_MS = 20000;

/** How long until the next look. Pure: the tests drive it directly. */
export function nextPollDelay({ errorStreak = 0, rateLimited = false, inFlight = false, idleRounds = 0 } = {}) {
  if (errorStreak > 0) {
    const back = Math.min(TRACK_ERROR_MS * 2 ** (errorStreak - 1), TRACK_ERROR_MAX_MS);
    return rateLimited ? Math.max(back, TRACK_RATE_LIMIT_MS) : back;
  }
  if (inFlight) {
    const over = idleRounds > TRACK_IN_FLIGHT_GRACE_ROUNDS ? idleRounds - TRACK_IN_FLIGHT_GRACE_ROUNDS : 0;
    return Math.min(Math.round(TRACK_IN_FLIGHT_MS * 1.5 ** over), TRACK_IDLE_MAX_MS);
  }
  return Math.min(Math.round(TRACK_IDLE_MS * 1.5 ** idleRounds), TRACK_IDLE_MAX_MS);
}

/**
 * Watch the deposits to one address while the tab is visible.
 *
 * onUpdate({ depositAddress, state: "loading" | "ok" | "error", requests, checkedAt, error })
 * is called after every look. A hidden tab does no work at all; coming back looks
 * at once. Returns { stop, refresh, snapshot }; refresh() says whether its look
 * is the next answer (see below).
 */
export function trackDeposits({
  depositAddress,
  user = null,
  onUpdate = () => {},
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  now = browserNow,
  isHidden = docHidden,
  onVisibility = onDocVisibility,
} = {}) {
  if (!isEvmAddress(depositAddress)) throw new RelayDepositError("bad-deposit-address", "Not a deposit address");
  let stopped = false;
  let timer = null;
  let busy = false;
  let ctrl = null;
  let guard = null;
  let errorStreak = 0;
  let rateLimited = false;
  let idleRounds = 0;
  let lastSig = null;
  /* A refresh asked for while a look was already out: that look answers first,
     and one more is made straight after it. */
  let again = false;
  let snap = { depositAddress, state: "loading", requests: [], checkedAt: null, error: null };

  const clear = () => { if (timer != null) { timers.clearTimeout(timer); timer = null; } };
  const schedule = () => {
    clear();
    if (stopped || isHidden()) return;
    const inFlight = snap.requests.some((r) => r.status === "arriving");
    timer = timers.setTimeout(poll, nextPollDelay({ errorStreak, rateLimited, inFlight, idleRounds }));
  };

  async function poll() {
    timer = null;
    if (stopped || busy || isHidden()) return;
    busy = true;
    const mine = typeof AbortController === "function" ? new AbortController() : null;
    ctrl = mine;
    const myGuard = mine ? timers.setTimeout(() => mine.abort(), TRACK_TIMEOUT_MS) : null;
    guard = myGuard;
    try {
      const rows = await fetchDepositRequests({ depositAddress, user, fetchImpl, signal: mine ? mine.signal : undefined });
      if (stopped) return;
      const sig = JSON.stringify(rows.map((r) => [r.id, r.status, r.updatedAt]));
      if (sig === lastSig) idleRounds += 1; else { idleRounds = 0; lastSig = sig; }
      errorStreak = 0;
      rateLimited = false;
      snap = { depositAddress, state: "ok", requests: rows, checkedAt: now(), error: null };
    } catch (e) {
      if (stopped) return;
      errorStreak += 1;
      rateLimited = !!(e && e.status === 429);
      const message = e && e.name === "AbortError" ? "The deposit service took too long to answer" : String((e && e.message) || e);
      /* Rows already on screen stay: a failed look is not an empty list. */
      snap = { ...snap, state: snap.checkedAt == null ? "error" : "ok", error: message };
    } finally {
      if (myGuard != null) timers.clearTimeout(myGuard);
      if (guard === myGuard) guard = null;
      if (ctrl === mine) ctrl = null;
      busy = false;
    }
    if (stopped) return;
    onUpdate(snap);
    if (again && !stopped) { again = false; poll(); return; }
    schedule();
  }

  const offVisibility = onVisibility(() => {
    if (stopped) return;
    if (isHidden()) { clear(); return; }
    if (!busy) { clear(); poll(); }
  });

  if (!isHidden()) poll();

  return {
    stop() {
      stopped = true;
      clear();
      if (guard != null) { timers.clearTimeout(guard); guard = null; }
      if (ctrl) { try { ctrl.abort(); } catch { /* already settled */ } ctrl = null; }
      offVisibility();
    },
    /* true: the next answer is a look made now. false: a look sent earlier is
       still out and answers first; the one made for this refresh follows it. */
    refresh() {
      if (stopped) return true;
      if (busy) { again = true; return false; }
      clear();
      poll();
      return true;
    },
    snapshot: () => snap,
  };
}
