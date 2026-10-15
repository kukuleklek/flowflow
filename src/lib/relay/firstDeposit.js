// ─────────────────────────────────────────────────────────────────────────────
// A FIRST deposit, routed so the one-time cost is never paid.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-27: "ทำเลยยยยยยยยยยยย เอาทุกเชน ให้มัน ครั้งแรก เกือบ noo fee" —
// do it, every chain, make the first one almost no fee; and, earlier,
// "ไม่อยากมี relayer" — no server of ours in the path.
//
// 🔴 WHAT THIS COSTS AND SAVES, MEASURED (2026-09-27, live quotes, fresh random
// recipients, 20 tokens each — the same nominal amount the direct plan is priced
// on). Every figure below is a total impact: what left minus what arrived.
//
//   direct plan, brand-new account, 25 USDC from Base   fee 1.245194  (-4.98%)
//   direct plan, brand-new account, 5 USDC from Base    fee 1.243194 (-24.86%)
//   this plan, 20 USDC from Base                        fee 0.127843  (-0.64%)
//   this plan, 20 USDC from BNB (the dearest USDC row)  fee 0.187831  (-0.94%)
//
// The saving is the one-time cost of creating the account, which the direct plan
// pays as relayer gas (1.222693 USDC, flat, on every amount) and this plan never
// pays at all: the money arrives as a plain token transfer into the venue's own
// deposit contract, sent by the customer's own wallet, and two brand-new
// accounts funded that way that day were credited with no fee line whatsoever.
//
// THE SHAPE OF THE ROUTE. One deposit address, quoted to the customer's OWN
// address on Arbitrum in USDC, with a small native gas top-up delivered in the
// same fill. The customer sends whatever they like from wherever they like, as
// before; their own wallet then makes the last hop (lib/relay/arbitrumBridge.js)
// and pays for it with the delivered gas. No key of ours, no server of ours.
//
// 🔴 THE TOP-UP SCALE IS NOT WHAT THE DOCS SAY. The quote API's own reference
// reads "The destination gas topup amount in USD decimal format, e.g 100000 =
// $1", and that example is wrong by ten times. Measured ladder on this exact
// route, reading details.currencyGasTopup.amountUsd: 1000 -> $0.001, 30000 ->
// $0.030, 100000 -> $0.100, 1000000 -> $1.000. So the scale is a MILLIONTH of a
// dollar, and TOPUP_GAS_AMOUNT below is $0.05. Worse, leaving the amount out
// while asking for gas takes the documented default of $2.00 — measured at
// 2.066983 USDC of fee, which is more than the cost this whole plan exists to
// remove. It is therefore always sent explicitly, and a quote whose answer does
// not carry the gas is refused rather than shown.
//
// WHY $0.05 OF GAS. The last hop is one token transfer on Arbitrum. Measured
// there the same day: a real deposit transfer into the contract used 65,907 gas
// at 0.020052 gwei = 0.000001321567 ETH, and the estimator says 68,100 gas. At
// the network's own floor price that is $0.0037. $0.05 buys 0.0000186 ETH,
// which is 13x the floor cost and still covers a tenfold spike in the L1 data
// fee on top of the highest price actually paid in a recent transfer. What the
// hop does not spend stays where it is: native gas in the customer's own
// wallet, on the key they already hold. It is not ours, it is not a fee, and it
// pays for their SECOND deposit's hop, which needs no top-up at all.
//
// Nothing here signs and nothing here sends: this file asks for a quote and
// verifies the answer. The cache, the live route check and the re-price are
// depositAddress.js's, shared with the direct plan.

import {
  getPerpDepositAddress, parseDepositQuote, unsafeQuote, RelayDepositError,
  DIRECT_PLAN,
} from "./depositAddress.js";
import { nominalAmount } from "./routes.js";
import {
  ARBITRUM_CHAIN_ID, ARBITRUM_CHAIN_NAME, ARBITRUM_USDC, ARBITRUM_USDC_DECIMALS,
  BRIDGE_MIN_USDC,
} from "./arbitrumBridge.js";

/** The plan's id, as the cache, the hooks and the sheet name it. */
export const FIRST_HOP_PLAN_ID = "arb-first";
export const FIRST_DEPOSIT_CACHE_PREFIX = "flowflow.perpFirst.v1:";

/* The gas top-up, in the quote API's own units: a MILLIONTH of a dollar each
   (measured — see the note above, the reference example is ten times out). */
export const TOPUP_SCALE_PER_USD = 1000000;
export const TOPUP_GAS_USD = 0.05;
export const TOPUP_GAS_AMOUNT = String(Math.round(TOPUP_GAS_USD * TOPUP_SCALE_PER_USD));
/* An answer carrying less than half of what was asked for is refused: half of
   $0.05 is still about seven times one hop's measured cost, so this is loose
   enough for a moving gas price and tight enough to catch a missing top-up. */
export const TOPUP_MIN_SHARE = 0.5;
/* 🔴 AND A CEILING, because the printed fee is now the quote's own difference
   MINUS this figure (perp/deposit's depositFeeForDisplay). The floor above
   protects the last hop; nothing protected the subtraction, and the failure is
   the one documented at the top of this file: leaving the amount out of the body
   takes the published default of $2.00, measured at 2.066983 of fee. Netted
   against a top-up of 2.0 that prints about 0.07 for a deposit that really costs
   2.07 — a figure 30x too small on a money screen, which is worse than the
   overstatement all this was written to remove. Half again over the ask is loose
   enough for the answer's own rounding (measured 0.050022 against an ask of
   0.05) and tight enough that nothing the customer does not keep can hide inside
   it. Past it the quote's own difference stands, unnetted: it is high, but it is
   what that deposit costs. */
export const TOPUP_MAX_SHARE = 1.5;

/* The native token of a chain, as the quote names it in a currency block. */
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const NATIVE_DECIMALS = 18;

/* HOW LONG THE LAST HOP TAKES, in the deposit contract's own documented words:
   the transfer "is credited to the account that sent it in less than 1 minute".
   Added to the crossing's own estimate so the time on screen covers the whole
   journey rather than the part the quote can see. Not a guess of ours, and it
   errs slow. */
export const LAST_HOP_SEC = 60;

export const FIRST_HOP_DESTINATION = Object.freeze({
  chainId: ARBITRUM_CHAIN_ID,
  currency: ARBITRUM_USDC,
  orderChain: "arbitrum",
  /* 🔴 The credit lands in the customer's own wallet on a chain their address
     already exists on, so there is no account to create and no one-time cost to
     carry. This is the whole point of the plan and it is a fact of the
     destination, never an inference from the quote's gas. */
  carriesActivation: false,
  wording: "the USDC in your own wallet",
});

/** The /quote/v2 body. recipient and refundTo are the customer, by construction. */
export function buildFirstDepositQuoteBody({ user, route }) {
  return {
    user,
    recipient: user,
    refundTo: user,
    originChainId: route.chainId,
    originCurrency: route.address,
    destinationChainId: ARBITRUM_CHAIN_ID,
    destinationCurrency: ARBITRUM_USDC,
    amount: nominalAmount(route),
    tradeType: "EXACT_INPUT",
    useDepositAddress: true,
    topupGas: true,
    topupGasAmount: TOPUP_GAS_AMOUNT,
  };
}

/* A finite number from a number or a numeric string; null otherwise (never 0). */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * THE SMALLEST DEPOSIT THAT CAN FINISH THE JOURNEY, in whole tokens.
 *
 * 🔴 WHY IT IS NOT 5. The last hop is refused below BRIDGE_MIN_USDC and money
 * sent below it is lost, so what must clear 5 is not what the customer SENDS
 * but the least that can ARRIVE. Two things take a bite: a near-flat crossing
 * cost, and the destination slippage the quote itself allows for (measured 1.99%
 * on most routes, 0.99% on the two from Arbitrum). Both are read off THIS
 * quote — the guaranteed minimumAmount, not the expected one:
 *
 *     keeps = minimumAmount / expected      what survives slippage, at worst
 *     flat  = amountIn - expected           the crossing's own cost
 *     need  = 5 / keeps + flat
 *
 * Measured on 20-token quotes, 2026-09-27: Base 5.23, Avalanche 5.23, Arbitrum
 * 5.15, Optimism 5.21, Polygon 5.22, BNB 5.29, Base USDT 5.35, Ethereum 10.07.
 * Rounded UP to a whole token, so the figure on screen is above the real floor
 * with room to spare and reads like a number a person would type.
 *
 * Returns null when the quote's own figures cannot carry the arithmetic — and
 * a plan that cannot state its own floor is refused, never shown.
 */
export function firstDepositMinInput({ amountIn, amountOut, minimumOut } = {}) {
  const inn = num(amountIn);
  const out = num(amountOut);
  const min = num(minimumOut);
  if (inn == null || out == null || min == null) return null;
  if (inn <= 0 || out <= 0 || min <= 0 || min > out) return null;
  const keeps = min / out;
  const flat = inn - out;
  /* A favourable rate can make the crossing cost less than nothing; it is read
     as nothing rather than as a discount on the floor. */
  const need = BRIDGE_MIN_USDC / keeps + (flat > 0 ? flat : 0);
  if (!Number.isFinite(need) || need <= 0 || need > 1000) return null;
  const whole = Math.ceil(need);
  return whole < BRIDGE_MIN_USDC ? BRIDGE_MIN_USDC : whole;
}

/**
 * Verify a /quote/v2 answer for the first-deposit route and read what the sheet
 * needs. Everything the direct plan checks is checked here by the same code —
 * one deposit step, the recipient, every order payment and every refund to the
 * customer, no calls on the destination, the step's own transfer pointing at
 * this very address — and then the two things only this plan has:
 *
 *   THE GAS. details.currencyGasTopup must be native on the destination chain,
 *   and its amount must equal its minimumAmount (the top-up is not exposed to
 *   slippage, unlike the money). Without gas the customer cannot make the last
 *   hop, so a quote that does not carry it is refused rather than shown.
 *
 *   THE FLOOR. firstDepositMinInput above, from this quote's own figures.
 *
 * Throws a RelayDepositError ("unsafe-quote" or "bad-deposit-address") unless
 * the answer provably pays the customer and provably funds the last hop.
 *
 * 🔴 needFloor false: EVERY CHECK ABOVE STILL RUNS, AND THE FLOOR IS ALLOWED TO
 * BE UNKNOWN. The floor is priced off the amount in the body, so it SCALES with
 * it, and past a crossing cost of 1000 the arithmetic above gives up and returns
 * null — measured 2026-09-28: a good answer, a real impact, and the whole quote
 * thrown away at 500,000 on BNB USDC and 200,000 on Base USDT. That is the right
 * answer for an ADDRESS, which is money a customer is about to send and must not
 * send under a floor nobody can state. The fee breakdown asks for no address and
 * shows none: it prices sizes of 100 and up purely to print what each one costs,
 * and every one of them is far above any floor this route could have. So there
 * it is not a refusal, and the figure the customer reads is the answer's own.
 * A caller that passes false must not let minInputUsdc reach a screen: it is the
 * floor for THAT size, not for the deposit anybody is making
 * (lib/relay/depositSizes.js returns no floor at all).
 */
export function parseFirstDepositQuote(json, { user, route, now = Date.now(), needFloor = true } = {}) {
  const base = parseDepositQuote(json, { user, route, now, dest: FIRST_HOP_DESTINATION });
  const d = (json && json.details) || {};
  const cout = (d.currencyOut && d.currencyOut.currency) || {};
  if (Number(cout.decimals) !== ARBITRUM_USDC_DECIMALS) throw unsafeQuote("the destination token is not the one this route reads");

  const top = d.currencyGasTopup;
  const tc = (top && top.currency) || {};
  if (!top) throw unsafeQuote("the answer carries no gas for the last step");
  if (Number(tc.chainId) !== ARBITRUM_CHAIN_ID || String(tc.address).toLowerCase() !== NATIVE_TOKEN || Number(tc.decimals) !== NATIVE_DECIMALS) {
    throw unsafeQuote("the gas for the last step is not this chain's own");
  }
  if (!top.amount || String(top.amount) !== String(top.minimumAmount)) throw unsafeQuote("the gas for the last step is not guaranteed");
  const topupUsd = num(top.amountUsd);
  if (topupUsd == null || topupUsd < TOPUP_GAS_USD * TOPUP_MIN_SHARE) throw unsafeQuote("the gas for the last step is too little to make it");

  const minimumOut = num(d.currencyOut && d.currencyOut.minimumAmount);
  const minInputUsdc = firstDepositMinInput({
    amountIn: num(d.currencyIn && d.currencyIn.amountFormatted),
    amountOut: num(d.currencyOut && d.currencyOut.amountFormatted),
    minimumOut: minimumOut == null ? null : minimumOut / 10 ** ARBITRUM_USDC_DECIMALS,
  });
  if (minInputUsdc == null && needFloor) throw unsafeQuote("the smallest deposit this route can carry could not be read");

  return {
    ...base,
    /* The whole journey, not the part the quote can see (LAST_HOP_SEC above). */
    timeEstimateSec: base.timeEstimateSec == null ? null : base.timeEstimateSec + LAST_HOP_SEC,
    minInputUsdc,
    topupUsd,
  };
}

/** The first-deposit plan, for getPerpDepositAddress. */
export const FIRST_HOP_PLAN = Object.freeze({
  id: FIRST_HOP_PLAN_ID,
  prefix: FIRST_DEPOSIT_CACHE_PREFIX,
  destination: FIRST_HOP_DESTINATION,
  body: buildFirstDepositQuoteBody,
  parse: parseFirstDepositQuote,
  figures: Object.freeze(["minInputUsdc", "topupUsd"]),
});

/** Where the money lands before the last hop, for the one sentence that needs to say so. */
export const FIRST_HOP_LANDING = ARBITRUM_CHAIN_NAME;

/* 🔴 WHEN THE DIRECT PLAN TAKES OVER. A refusal that is about this route's
   PRICE or this answer's SHAPE means the cheaper plan is not available right
   now — and a customer in front of a screen with no deposit address is worse
   off than one who pays the one-time cost, so the direct plan is asked instead.
   Measured reason it can happen: on Ethereum L1 the quote is refused outright
   below a size that moves with L1 gas (AMOUNT_TOO_LOW, then GAS_IMPACT_TOO_HIGH
   as the amount rises). Every other refusal — not connected, not a route, the
   wrong network, the route closed, the service unreachable — would refuse the
   direct plan in exactly the same words, so it is passed straight through. */
export const FALL_BACK_ON = Object.freeze(["relay-error", "unsafe-quote", "bad-deposit-address", "bad-response"]);

/* 🔴 BUT NOT A MOMENTARY REFUSAL. Owner, 2026-10-15: "มันมีเส้นทางที่ไม่ต้องเสีย
   1.22". A "relay-error" is any answer that was not 2xx, and a rate limit (429),
   a timeout (408, 425) or a service that is down (5xx) says nothing about this
   route's price: asked again a moment later, the same quote goes through. Taking
   the direct plan on one of those would hand a brand-new account the address
   whose first deposit pays the ~1.22 USDC one-time cost — and the plan is frozen
   for the open sheet — so these are passed straight through, and the screen's
   own retry asks the no-cost route again. */
export function isMomentaryRefusal(e) {
  if (!e || e.code !== "relay-error") return false;
  const s = e.detail && Number(e.detail.status);
  if (!Number.isFinite(s)) return true;
  return s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599);
}

/**
 * The deposit address for one route, on the plan the caller asks for.
 *
 *   planId   FIRST_HOP_PLAN_ID for a first deposit this wallet can finish by
 *            itself (perp/deposit's depositPlanFor decides); anything else is
 *            the direct plan, which is cheaper once the account exists.
 *
 * Resolves what getPerpDepositAddress resolves, plus `plan` naming the plan the
 * ANSWER is on — which is the one the screen must describe, and not always the
 * one that was asked for, because of the fall-back above. On the first-deposit
 * plan it also carries `minInputUsdc` and `topupUsd`. Rejects with the same
 * RelayDepositErrors.
 */
export async function getDepositAddressForPlan({ planId = null, ...opts } = {}) {
  if (planId !== FIRST_HOP_PLAN_ID) return getPerpDepositAddress({ ...opts, plan: DIRECT_PLAN });
  try {
    return await getPerpDepositAddress({ ...opts, plan: FIRST_HOP_PLAN });
  } catch (e) {
    if (!(e instanceof RelayDepositError) || !FALL_BACK_ON.includes(e.code) || isMomentaryRefusal(e)) throw e;
    return getPerpDepositAddress({ ...opts, plan: DIRECT_PLAN });
  }
}
