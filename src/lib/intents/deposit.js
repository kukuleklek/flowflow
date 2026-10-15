// ─────────────────────────────────────────────────────────────────────────────
// A PRIVATE deposit: a one-time address that pays the customer's own account.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน" (plan-private/PLAN-PRIVATE-MODE.md
// P0). The customer picks an amount, token and network FIRST — a 1Click address
// is bound to one quote, one amount and a deadline — then sends that exact
// amount from any wallet. Two plans (the destination the address pays):
//
//   private-core  (default)  USDC straight into the customer's PERPS balance.
//                            ~0.32 USDC on 20 (a flat 0.3153 withdraw fee),
//                            ~35–45 s, nothing to sign, works for every wallet.
//   private-arb              USDC into the customer's OWN wallet on Arbitrum;
//                            the existing auto-mover (perp/deposit/perpFunding.js,
//                            its one already-allowed silent transfer) makes the
//                            last hop. ~0.005 + the hop's gas. 🔴 ONLY when that
//                            wallet ALREADY holds the ETH for the hop: 1Click
//                            cannot deliver gas beside the USDC (one output per
//                            quote), and a Privy wallet with 0 ETH would leave
//                            the money sitting there (arbitrumBridge's no-gas).
//                            privatePlanFor below is that check, pure; nothing
//                            new signs anything, silently or otherwise.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. recipient = refundTo = the connected wallet. The body is built that way
//      and refused if it is not, and the ANSWER is checked on its own echo
//      (quoteRequest), not on what we sent: recipient, refundTo, their types,
//      both assets, the amount, the swap type, the slippage, a refund time
//      still ahead, the privacy level, and no fee, message, referral, session
//      or virtual-chain field we did not ask for. The quote's figures are held
//      to what the route can do: never more out than in, a cost within the
//      route's, and a GUARANTEED output (minAmountOut) no further below
//      amountOut than the slippage asked for (config.js MIN_OUT_TOLERANCE_BPS).
//      The one-time address is never the wallet, a burn address or a token
//      contract.
//   2. The address is shown only after every check passed AND the route is in
//      the live token list as we know it (contract, decimals, chain, symbol).
//   3. ONE ADDRESS, ONE DEPOSIT. A cached address is reused only while the
//      service still says PENDING_DEPOSIT for it, asked through OUR proxy (so
//      the server's kill switch also stops a saved address being shown again);
//      anything else — a deposit seen, an unreadable answer — forgets it and
//      quotes a new one. It is kept
//      under its own prefix, keyed by (user, route, plan, amount, privacy), and
//      hidden HIDE_BEFORE_INACTIVE_MS before it goes inactive.
//   4. Unknown is null, never 0. Amounts are BigInt end to end; nothing rounds.
//   5. Nothing here signs, sends or holds a key. Quotes are asked of our proxy
//      (api/intents-quote.js) in a page, which adds the key, the kill switch,
//      the caps and the sanctions screen.
//
// UNVERIFIED, and named so nobody reads it as measured: the quote's ed25519
// signature is NOT checked (no SDK here, and the docs do not publish where its
// public key comes from); it is kept with the answer for disputes. No deposit
// has been sent through this code (real money): the fixtures are live DRY
// quotes plus the one live non-dry answer's shape (scripts/fixtures/intents).

import { isAddress as isViemAddress } from "viem";
import { isEvmAddress, sameAddress } from "../relay/depositAddress.js";
import { BRIDGE_MIN_RAW, readArbitrumGasBalance } from "../relay/arbitrumBridge.js";
import { HL_NETWORK } from "../hyperliquid/config.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import {
  INTENTS_QUOTE_URL, INTENTS_STATUS_URL, INTENTS_STATUS_UPSTREAM, PROVIDER_NEAR,
  PRIVATE_CORE_PLAN_ID, PRIVATE_ARB_PLAN_ID, PRIVATE_LIMITS, CONFIDENTIALITY,
  DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, QUOTE_DEADLINE_MS, MAX_ANSWER_DEADLINE_MS,
  HIDE_BEFORE_INACTIVE_MS, MIN_SHOW_MS, INTENTS_PLATFORM_FEE_ACCOUNTS, MAX_PLATFORM_FEE_BPS,
  MAX_LOSS_FLAT_USDC, MAX_LOSS_SHARE, PRIVATE_DEPOSIT_PREFIX, MIN_OUT_TOLERANCE_BPS, clampPrivateLimits,
} from "./config.js";
import {
  HYPERCORE_USDC, ARBITRUM_INTENTS_USDC, INTENTS_ASSETS, PRIVATE_DEPOSIT_ROUTES, intentsPairOf, intentsRouteProblems,
  depositAddressShapeOk, rawOf, parseUnitsExact, formatUnitsExact, rescaleExact, unitsNumber,
} from "./assets.js";
import { IntentsError, postIntentsQuote, readIntentsTokens, fetchIntentsStatus, newIntentsTokensMemo } from "./client.js";
import { normalizeIntentsStatus } from "./status.js";

export { PRIVATE_CORE_PLAN_ID, PRIVATE_ARB_PLAN_ID };

const MINUTE = 60000;

/* ── the two plans ───────────────────────────────────────────────────────── */

export const PRIVATE_CORE_PLAN = Object.freeze({
  id: PRIVATE_CORE_PLAN_ID,
  provider: PROVIDER_NEAR,
  destAsset: HYPERCORE_USDC,
  /** Lands in the Perp account itself: nothing follows. */
  landsInWallet: false,
  /** The least the answer may guarantee to deliver (null: no floor beyond > 0). */
  minOutRaw: null,
  wording: "the USDC in your Perp wallet",
});

export const PRIVATE_ARB_PLAN = Object.freeze({
  id: PRIVATE_ARB_PLAN_ID,
  provider: PROVIDER_NEAR,
  destAsset: ARBITRUM_INTENTS_USDC,
  /** Lands in the customer's own wallet on Arbitrum; the auto-mover makes the last hop. */
  landsInWallet: true,
  /* 🔴 The hop is refused below 5 USDC and money sent below it is lost
     (arbitrumBridge.js), so the GUARANTEED output must clear it. */
  minOutRaw: BRIDGE_MIN_RAW,
  wording: "the USDC in your own wallet on Arbitrum",
});

export const PRIVATE_PLANS = Object.freeze([PRIVATE_CORE_PLAN, PRIVATE_ARB_PLAN]);

/** The plan with this id (THIS file's object), or null. */
export function privatePlanById(id) {
  return PRIVATE_PLANS.find((p) => p.id === id) || null;
}

/* ── which plan: the gas check ───────────────────────────────────────────────
   The last hop is one USDC transfer on Arbitrum: 68,100 gas by the estimator,
   65,907 used, at 0.020052 gwei (measured 2026-09-27, lib/relay/firstDeposit.js).
   The floor is that gas at 0.1 gwei (five times the measured price, so a spike
   or the L1 data fee does not strand the money), three times over (plan §3:
   "ETH ≥ 3× the hop"): 0.00002043 ETH, about $0.05. A live price above 0.1 gwei
   raises it. */
export const PRIVATE_ARB_HOP_GAS = 68100n;
export const PRIVATE_ARB_MIN_GAS_PRICE_WEI = 100000000n;
export const PRIVATE_ARB_GAS_HEADROOM = 3n;

/** The ETH (wei) a wallet must already hold for private-arb. */
export function privateArbGasFloorWei(gasPriceWei = null) {
  const p = typeof gasPriceWei === "bigint" && gasPriceWei > PRIVATE_ARB_MIN_GAS_PRICE_WEI ? gasPriceWei : PRIVATE_ARB_MIN_GAS_PRICE_WEI;
  return PRIVATE_ARB_HOP_GAS * p * PRIVATE_ARB_GAS_HEADROOM;
}

/** true / false against the floor; null when the balance was not read (never a guess). */
export function privateArbGasOk({ gasWei = null, gasPriceWei = null } = {}) {
  if (typeof gasWei !== "bigint" || gasWei < 0n) return null;
  return gasWei >= privateArbGasFloorWei(gasPriceWei);
}

/**
 * The plan for this wallet, PURE. private-arb only for the in-app (Privy)
 * wallet — the auto-mover moves nothing else — AND only when its ETH on
 * Arbitrum was read and clears the floor. Every other case, an unread balance
 * included, is private-core (the safe side: nothing is left waiting for gas).
 * Freeze the answer while the sheet is open, like useDepositPlan.
 */
export function privatePlanFor({ walletType = null, gasWei = null, gasPriceWei = null } = {}) {
  if (walletType !== "privy") return PRIVATE_CORE_PLAN_ID;
  return privateArbGasOk({ gasWei, gasPriceWei }) === true ? PRIVATE_ARB_PLAN_ID : PRIVATE_CORE_PLAN_ID;
}

/**
 * The same choice with the gas READ (one public RPC read). Never rejects: a
 * failed read is private-core. Resolves { planId, gasWei } (gasWei null when unread).
 */
export async function choosePrivatePlan({ owner, walletType = null, readGas = (o) => readArbitrumGasBalance({ owner: o }) } = {}) {
  if (walletType !== "privy" || !isEvmAddress(owner)) return { planId: PRIVATE_CORE_PLAN_ID, gasWei: null };
  let gasWei = null;
  try { gasWei = await readGas(owner); } catch { gasWei = null; }
  if (typeof gasWei !== "bigint") gasWei = null;
  return { planId: privatePlanFor({ walletType, gasWei }), gasWei };
}

/* ── amounts ─────────────────────────────────────────────────────────────── */

/**
 * What the customer typed, as the route's base units, inside the owner's limits.
 * `limits` (the probe's) may only LOWER the cap or RAISE the minimum
 * (config.js clampPrivateLimits): a caller can never widen them.
 * Resolves { amountRaw (string), amountUsdc (number) }. Throws an IntentsError:
 * bad-amount (not a plain amount, or more decimals than the token carries — it
 * is refused, never rounded), below-min, over-tx-cap.
 */
export function privateDepositAmount(route, text, { limits = PRIVATE_LIMITS } = {}) {
  if (!route || !Number.isInteger(route.decimals)) throw new IntentsError("bad-route", "Not a private deposit route");
  let raw;
  try { raw = parseUnitsExact(text, route.decimals); } catch { throw new IntentsError("bad-amount", "Enter an amount like 25 or 25.5"); }
  return { amountRaw: raw.toString(), amountUsdc: checkDepositSize(raw, route, limits) };
}

function checkDepositSize(raw, route, askedLimits) {
  const limits = clampPrivateLimits(askedLimits);
  const usdc = unitsNumber(raw, route.decimals);
  if (usdc == null || raw <= 0n) throw new IntentsError("bad-amount", "Enter an amount");
  const min = parseUnitsExact(String(limits.depositMinUsdc), route.decimals);
  const max = parseUnitsExact(String(limits.maxTxUsdc), route.decimals);
  if (raw < min) throw new IntentsError("below-min", `The smallest private deposit is ${limits.depositMinUsdc} USDC`, { min: limits.depositMinUsdc });
  if (raw > max) throw new IntentsError("over-tx-cap", `The largest private deposit is ${limits.maxTxUsdc} USDC`, { max: limits.maxTxUsdc });
  return usdc;
}

/* ── the request ─────────────────────────────────────────────────────────── */

/* Everything checked BEFORE anything leaves. */
export function assertPrivateAskable({ user, connected, route, plan, amountRaw, confidentiality, network = HL_NETWORK, limits = PRIVATE_LIMITS }) {
  if (!isEvmAddress(user)) throw new IntentsError("bad-user", "Not a wallet address");
  if (!sameAddress(user, connected)) throw new IntentsError("not-connected", "The deposit address is only made for the wallet that is connected");
  if (!route || !PRIVATE_DEPOSIT_ROUTES.includes(route)) throw new IntentsError("bad-route", "Not a private deposit route");
  if (!plan || !PRIVATE_PLANS.includes(plan)) throw new IntentsError("bad-plan", "Not a private deposit plan");
  const pair = intentsPairOf(route.intentsAsset.assetId, plan.destAsset.assetId);
  if (!pair || pair.direction !== "deposit") throw new IntentsError("bad-route", "Not a private deposit route");
  /* The service credits MAINNET accounts. A testnet build must never take a real deposit. */
  if (network !== "mainnet") throw new IntentsError("testnet-off", "Deposits are open on mainnet only");
  if (!CONFIDENTIALITY.includes(confidentiality)) throw new IntentsError("confidentiality-mismatch", "Unknown privacy level");
  const raw = rawOf(amountRaw);
  if (raw == null || raw <= 0n) throw new IntentsError("bad-amount", "Enter an amount");
  checkDepositSize(raw, route, limits);
}

/**
 * The POST /quote body. recipient AND refundTo are the user, by construction,
 * and checked against the connected wallet once more on the way out. Nothing
 * else is ever in it: no appFees, no message, no virtual-chain field.
 */
export function buildIntentsDepositQuoteBody({
  user, connected, route, plan = PRIVATE_CORE_PLAN, amountRaw, dry = false, confidentiality = "public",
  now = Date.now(), slippageBps = DEFAULT_SLIPPAGE_BPS, network = HL_NETWORK, limits = PRIVATE_LIMITS,
}) {
  assertPrivateAskable({ user, connected, route, plan, amountRaw, confidentiality, network, limits });
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new IntentsError("bad-amount", "Unusable slippage");
  const body = {
    dry: dry === true,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    originAsset: route.intentsAsset.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: plan.destAsset.assetId,
    amount: String(amountRaw),
    refundTo: user,
    refundType: "ORIGIN_CHAIN",
    recipient: user,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + QUOTE_DEADLINE_MS).toISOString(),
    confidentiality,
  };
  if (!sameAddress(body.recipient, connected) || !sameAddress(body.refundTo, connected)) {
    throw new IntentsError("not-connected", "recipient and refundTo must be the connected wallet");
  }
  return body;
}

/* ── the answer ──────────────────────────────────────────────────────────── */

/** The refusal every unsafe answer gets; the sheet shows no address. */
export function unsafeIntentsQuote(why) {
  return new IntentsError("unsafe-quote", `The answer did not check out (${why}); no address is shown`, { why });
}
const unsafe = unsafeIntentsQuote;

const timeOf = (v) => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] != null && o[k] !== "" && !(Array.isArray(o[k]) && o[k].length === 0);

/* Fees on the echo: only the service's own platform account, and only up to its
   published keyless ceiling (config.js). Resolves the total in bps. */
export function echoedPlatformFeeBps(appFees) {
  if (appFees == null) return 0;
  if (!Array.isArray(appFees)) throw unsafe("the fee list is not a list");
  let total = 0;
  for (const f of appFees) {
    if (!f || typeof f !== "object") throw unsafe("a fee entry is not readable");
    if (!INTENTS_PLATFORM_FEE_ACCOUNTS.includes(f.recipient)) throw unsafe("a fee is paid to someone other than the service");
    if (!Number.isInteger(f.fee) || f.fee < 0) throw unsafe("a fee is not a whole number of basis points");
    total += f.fee;
  }
  if (total > MAX_PLATFORM_FEE_BPS) throw unsafe("the service's fee is above its published ceiling");
  return total;
}

/* Every token contract this folder knows (a 20-byte one): money sent to a token's
   own contract is not a deposit to anybody, and cannot be refunded. */
const TOKEN_CONTRACTS = Object.freeze(INTENTS_ASSETS.map((a) => a.contractAddress).filter((c) => isEvmAddress(c)));

/* A one-time address must be EVM-shaped for its origin (never the zero or the
   0x…dEaD burn address), not the user, not a token contract, and — when
   mixed-case — carry a valid EIP-55 checksum (a broken one is a corrupted answer). */
function checkDepositAddress(addr, { user, originAsset, others = [] }) {
  if (!depositAddressShapeOk(addr, originAsset)) throw new IntentsError("bad-deposit-address", "No usable deposit address came back", { depositAddress: addr ?? null });
  if (!isViemAddress(addr, { strict: true })) throw new IntentsError("bad-deposit-address", "The deposit address's checksum is wrong", { depositAddress: addr });
  if (sameAddress(addr, user)) throw new IntentsError("bad-deposit-address", "The deposit address is the wallet itself", { depositAddress: addr });
  for (const c of TOKEN_CONTRACTS) if (sameAddress(addr, c)) throw new IntentsError("bad-deposit-address", "The deposit address is a token contract, not a one-time address", { depositAddress: addr });
  for (const o of others) if (o && sameAddress(addr, o)) throw new IntentsError("bad-deposit-address", "The deposit address is not a one-time address", { depositAddress: addr });
}

/* Request keys the echo must never carry: each pays somebody we did not choose,
   changes where the money lands, or ties the quote to a session we did not open
   (the withdraw verifier's list, lib/intents/withdraw.js). */
const FORBIDDEN_ECHO_KEYS = Object.freeze([
  "customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient", "rebates", "referral", "sessionId", "connectedWallets",
]);

/**
 * Verify a POST /quote answer for a private deposit and read what the sheet
 * needs. Throws an IntentsError ("unsafe-quote" or "bad-deposit-address")
 * unless the answer provably pays THIS wallet on THIS plan for THIS amount.
 *
 *   dry          true for a price-only quote (no address may come back), false for the
 *                address itself (one must, with a deadline that leaves time to send)
 *   slippageBps  the slippage the body asked for (default 100): the echo must say the
 *                same, and it bounds how far below amountOut minAmountOut may sit
 *   deadline     the request deadline the body asked for, when the caller has it:
 *                the echo must say the same (it must always be readable and ahead)
 *
 * Resolves { plan, provider, depositAddress (lowercase, or null when dry),
 * amountIn, amountInRaw, amountOut, amountOutRaw, minAmountOut, minAmountOutRaw,
 * feeUsdc, withdrawFeeUsdc, refundFeeUsdc, platformFeeBps, timeEstimateSec,
 * expiresAt, inactiveAt, showUntil, quotedAt, quoteTimestamp, correlationId,
 * signature, signatureVerified: false, confidentiality, private }.
 */
export function parseIntentsDepositQuote(json, {
  user, route, plan = PRIVATE_CORE_PLAN, amountRaw, confidentiality = "public", dry = false, now = Date.now(),
  slippageBps = DEFAULT_SLIPPAGE_BPS, deadline = null,
} = {}) {
  const j = json && typeof json === "object" ? json : null;
  const qr = j && j.quoteRequest && typeof j.quoteRequest === "object" ? j.quoteRequest : null;
  const q = j && j.quote && typeof j.quote === "object" ? j.quote : null;
  if (!qr || !q) throw unsafe("the answer carries no quote and no echo of the request");
  if (!route || !route.intentsAsset || !plan || !plan.destAsset) throw unsafe("no route or plan to check against");
  const origin = route.intentsAsset;
  const dest = plan.destAsset;

  /* 1. The echo: who is paid, who is refunded, and what was asked. */
  if (qr.dry !== (dry === true)) throw unsafe("the answer is not the kind of quote that was asked for");
  if (!sameAddress(qr.recipient, user)) throw unsafe("the recipient is not this wallet");
  if (!sameAddress(qr.refundTo, user)) throw unsafe("a refund is not to this wallet");
  if (qr.recipientType !== "DESTINATION_CHAIN") throw unsafe("the money is not paid out on the destination chain");
  if (qr.refundType !== "ORIGIN_CHAIN") throw unsafe("a refund is not paid back on the chain it came from");
  if (qr.depositType !== "ORIGIN_CHAIN") throw unsafe("the deposit is not a plain transfer on the origin chain");
  if (qr.depositMode != null && qr.depositMode !== "SIMPLE") throw unsafe("the deposit needs a memo");
  if (qr.swapType !== "EXACT_INPUT") throw unsafe("the quote is not for an exact amount");
  if (qr.originAsset !== origin.assetId) throw unsafe("the origin token is not the route's");
  if (qr.destinationAsset !== dest.assetId) throw unsafe(`the destination is not ${plan.wording}`);
  if (String(qr.amount) !== String(amountRaw)) throw unsafe("the amount is not the one asked for");
  if ((qr.confidentiality ?? "public") !== confidentiality) throw unsafe("the privacy level is not the one asked for");
  if (qr.insured === true) throw unsafe("an insurance fee was added");
  if (qr.slippageTolerance != null && (!Number.isInteger(qr.slippageTolerance) || qr.slippageTolerance < 0 || qr.slippageTolerance > MAX_SLIPPAGE_BPS)) throw unsafe("the slippage is outside what we allow");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw unsafe("no slippage to check against");
  if (qr.slippageTolerance != null && qr.slippageTolerance !== slippageBps) throw unsafe("the slippage is not the one asked for");
  /* The refund time (the request's deadline): readable, still ahead, and — when we know it — the one we asked. */
  const refundAt = timeOf(qr.deadline);
  if (refundAt == null) throw unsafe("the refund time cannot be read");
  if (refundAt <= now) throw unsafe("the refund time has already passed");
  if (deadline != null && refundAt !== timeOf(deadline)) throw unsafe("the refund time is not the one asked for");
  for (const k of FORBIDDEN_ECHO_KEYS) {
    if (has(qr, k)) throw unsafe(`the request carries ${k}, which was never asked for`);
  }
  for (const k of ["customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient", "depositMemo", "chainDepositAddresses"]) {
    if (has(q, k)) throw unsafe(`the quote carries ${k}`);
  }
  const platformFeeBps = echoedPlatformFeeBps(qr.appFees);

  /* 2. The amounts, exact. */
  const inRaw = rawOf(q.amountIn);
  const minInRaw = rawOf(q.minAmountIn);
  const outRaw = rawOf(q.amountOut);
  const minOutRaw = rawOf(q.minAmountOut);
  if (inRaw == null || String(inRaw) !== String(amountRaw)) throw unsafe("the amount in is not the one asked for");
  if (minInRaw == null || minInRaw !== inRaw) throw unsafe("a smaller deposit than the one quoted would be accepted");
  if (outRaw == null || minOutRaw == null || minOutRaw <= 0n || minOutRaw > outRaw) throw unsafe("the amount out is not readable");
  if (plan.minOutRaw != null && minOutRaw < plan.minOutRaw) throw unsafe("the least that can arrive is under what the last step can move");
  const scale = Math.max(origin.decimals, dest.decimals);
  const inC = rescaleExact(inRaw, origin.decimals, scale);
  const outC = rescaleExact(outRaw, dest.decimals, scale);
  const minOutC = rescaleExact(minOutRaw, dest.decimals, scale);
  /* USDC in, USDC out: more arriving than was sent is a units mix-up, never a gift. */
  if (outC > inC) throw unsafe("more would arrive than is sent, so the units are wrong");
  const loss = inC - outC;
  const flat = parseUnitsExact(String(MAX_LOSS_FLAT_USDC), scale);
  const share = (inC * BigInt(Math.round(MAX_LOSS_SHARE * 10000))) / 10000n;
  if (loss > flat + share) throw unsafe("the cost is far above what this route charges");
  /* 🔴 THE GUARANTEE. minAmountOut is all the service promises: it may sit below
     amountOut by the slippage asked for, applied to what goes in, and no more. */
  const slip = (inC * BigInt(slippageBps + MIN_OUT_TOLERANCE_BPS)) / 10000n;
  if (outC - minOutC > slip) throw unsafe("the least that can arrive is far below the quote");

  /* 3. The address and its life (a non-dry answer only). */
  let depositAddress = null;
  let expiresAt = null;
  let inactiveAt = null;
  let showUntil = null;
  if (dry) {
    if (q.depositAddress != null) throw unsafe("a price-only quote came back with an address");
  } else {
    checkDepositAddress(q.depositAddress, { user, originAsset: origin, others: [user] });
    depositAddress = q.depositAddress.toLowerCase();
    expiresAt = timeOf(q.deadline);
    inactiveAt = timeOf(q.timeWhenInactive) ?? expiresAt;
    if (expiresAt == null || inactiveAt == null) throw unsafe("the address has no deadline");
    if (expiresAt > now + MAX_ANSWER_DEADLINE_MS) throw unsafe("the deadline is not one we understand");
    const end = Math.min(expiresAt, inactiveAt);
    const life = end - now;
    /* Hidden 6 h before it goes cold — or at half its life, when that is shorter,
       so a short-lived address is still shown for its first half. */
    showUntil = end - Math.min(HIDE_BEFORE_INACTIVE_MS, Math.floor(life / 2));
    if (!(showUntil - now >= MIN_SHOW_MS)) throw unsafe("the address would expire before there is time to send to it");
  }

  const time = typeof q.timeEstimate === "number" && Number.isFinite(q.timeEstimate) && q.timeEstimate >= 0 ? q.timeEstimate : null;
  const fig = (raw, d) => (raw == null ? null : unitsNumber(raw, d));
  return {
    plan: plan.id,
    provider: PROVIDER_NEAR,
    depositAddress,
    amountIn: fig(inRaw, origin.decimals),
    amountInRaw: inRaw.toString(),
    symbolIn: origin.symbol,
    amountOut: fig(outRaw, dest.decimals),
    amountOutRaw: outRaw.toString(),
    minAmountOut: fig(minOutRaw, dest.decimals),
    minAmountOutRaw: minOutRaw.toString(),
    symbolOut: dest.symbol,
    feeUsdc: unitsNumber(loss, scale),
    withdrawFeeUsdc: fig(rawOf(q.withdrawFee), dest.decimals),
    /* What a refund costs, in the ORIGIN token (the service's own unit for it). */
    refundFeeUsdc: fig(rawOf(q.refundFee), origin.decimals),
    platformFeeBps,
    timeEstimateSec: time,
    expiresAt,
    inactiveAt,
    showUntil,
    quotedAt: now,
    quoteTimestamp: timeOf(j.timestamp),
    correlationId: typeof j.correlationId === "string" ? j.correlationId : null,
    signature: typeof j.signature === "string" ? j.signature : null,
    /* UNVERIFIED: see the top of this file. */
    signatureVerified: false,
    confidentiality,
    /* "Private" only when the service was asked for, and echoed, a confidential level. */
    private: confidentiality !== "public",
  };
}

/* ── the route must be live ──────────────────────────────────────────────── */

const TOKENS = newIntentsTokensMemo();

/** The route's two assets must be in the live token list exactly as this folder knows them. */
export async function assertIntentsRouteLive({ route, plan, fetchImpl = globalThis.fetch, memo = TOKENS, now = browserNow, timers = browserTimers } = {}) {
  const tokens = await readIntentsTokens({ fetchImpl, memo, now, timers });
  const problems = intentsRouteProblems(tokens, [route.intentsAsset, plan.destAsset]);
  if (problems.length) throw new IntentsError("route-unavailable", `This private deposit is closed right now (${problems.join("; ")}); no address is shown`, { problems });
}

/* ── the one-time address, kept between opens ───────────────────────────── */

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
const MEMORY = new Map();
const INFLIGHT = new Map();

/** The cache key: one address per (user, route, plan, amount, privacy level). */
export function privateDepositCacheKey(user, routeId, planId, amountRaw, confidentiality) {
  return `${PRIVATE_DEPOSIT_PREFIX}${String(user).toLowerCase()}:${routeId}:${planId}:${amountRaw}:${confidentiality}`;
}

/* An entry is used only if it is well formed and is for exactly this ask. A
   tampered or foreign entry is ignored, never trusted. */
function entryUsable(e, { user, route, plan, amountRaw, confidentiality }, now) {
  if (!e || typeof e !== "object" || e.v !== 1 || e.provider !== PROVIDER_NEAR) return false;
  if (!sameAddress(e.user, user) || e.routeId !== route.id || e.planId !== plan.id) return false;
  if (e.originAsset !== route.intentsAsset.assetId || e.destinationAsset !== plan.destAsset.assetId) return false;
  if (e.amountRaw !== String(amountRaw) || e.confidentiality !== confidentiality) return false;
  if (!isEvmAddress(e.depositAddress) || sameAddress(e.depositAddress, user)) return false;
  if (!Number.isFinite(e.quotedAt) || e.quotedAt > now + 10 * MINUTE) return false;
  if (!Number.isFinite(e.showUntil) || !Number.isFinite(e.expiresAt) || e.showUntil > e.expiresAt) return false;
  return now < e.showUntil;
}

function readEntry(storage, memory, key, ask, now) {
  const m = memory.get(key);
  if (entryUsable(m, ask, now)) return m;
  if (!storage) return null;
  let raw = null;
  try { raw = storage.getItem(key); } catch { return null; }
  if (!raw) return null;
  let e = null;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!entryUsable(e, ask, now)) return null;
  memory.set(key, e);
  return e;
}

function writeEntry(storage, memory, key, entry) {
  memory.set(key, entry);
  if (!storage) return;
  try { storage.setItem(key, JSON.stringify(entry)); } catch { /* private mode: the session copy still holds */ }
}

function forgetKey(storage, memory, key) {
  memory.delete(key);
  if (!storage) return;
  try { storage.removeItem(key); } catch { /* the saved one fails the status check next time */ }
}

/**
 * Forget every saved one-time address equal to `depositAddress` for this user
 * (a deposit was seen there: it must never be offered again). Returns how many.
 */
export function forgetPrivateDepositAddress({ user, depositAddress, storage = defaultStorage(), memory = MEMORY } = {}) {
  if (!isEvmAddress(depositAddress)) return 0;
  const prefix = `${PRIVATE_DEPOSIT_PREFIX}${String(user).toLowerCase()}:`;
  let n = 0;
  for (const [k, e] of [...memory.entries()]) {
    if (k.startsWith(prefix) && e && sameAddress(e.depositAddress, depositAddress)) { memory.delete(k); n += 1; }
  }
  if (storage && typeof storage.key === "function") {
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(prefix)) keys.push(k); }
      for (const k of keys) {
        let e = null;
        try { e = JSON.parse(storage.getItem(k)); } catch { e = null; }
        if (e && sameAddress(e.depositAddress, depositAddress)) { storage.removeItem(k); n += 1; }
      }
    } catch { /* storage that cannot be listed: the status check still refuses a used address */ }
  }
  return n;
}

/* The figures the sheet shows, from an entry. */
function resultOf(e, route, plan, fromCache) {
  return {
    provider: PROVIDER_NEAR,
    plan: plan.id,
    route,
    depositAddress: e.depositAddress,
    amountIn: unitsNumber(e.amountRaw, route.decimals),
    amountInRaw: e.amountRaw,
    symbolIn: route.token,
    amountOut: Number.isFinite(e.amountOut) ? e.amountOut : null,
    minAmountOut: Number.isFinite(e.minAmountOut) ? e.minAmountOut : null,
    symbolOut: plan.destAsset.symbol,
    feeUsdc: Number.isFinite(e.feeUsdc) ? e.feeUsdc : null,
    withdrawFeeUsdc: Number.isFinite(e.withdrawFeeUsdc) ? e.withdrawFeeUsdc : null,
    refundFeeUsdc: Number.isFinite(e.refundFeeUsdc) ? e.refundFeeUsdc : null,
    platformFeeBps: Number.isFinite(e.platformFeeBps) ? e.platformFeeBps : null,
    timeEstimateSec: Number.isFinite(e.timeEstimateSec) ? e.timeEstimateSec : null,
    expiresAt: e.expiresAt,
    inactiveAt: e.inactiveAt,
    showUntil: e.showUntil,
    quotedAt: e.quotedAt,
    correlationId: e.correlationId || null,
    signatureVerified: false,
    confidentiality: e.confidentiality,
    private: e.confidentiality !== "public",
    fromCache,
    /* What the Deposit sheet hands depositWatch.show(...) to follow this address. */
    watch: Object.freeze({ address: e.depositAddress, routeId: route.id, planId: plan.id, provider: PROVIDER_NEAR }),
  };
}

/* Is a saved address still unused? Only an explicit PENDING_DEPOSIT, for THIS
   wallet and THIS address, says yes. A 404, any other status, a mismatch or a
   failed read all say no — and no is always safe: a new address is quoted. */
async function stillUnused(e, user, { fetchImpl, timers, statusUrl }) {
  try {
    /* 🔴 NO FALLBACK HERE. The public endpoint keeps answering PENDING_DEPOSIT
       when the server's kill switch is off; reading it would show the saved
       address again and invite a new deposit the owner switched off. (The
       deposit WATCH still falls back: following money already sent is not
       inviting more.) A page with no proxy (Node) passes the API itself as
       statusUrl, so nothing changes there. */
    const json = await fetchIntentsStatus({ depositAddress: e.depositAddress, fetchImpl, timers, url: statusUrl, fallbackUrl: null });
    if (!json || json.status !== "PENDING_DEPOSIT") return false;
    const qr = (json.quoteResponse && json.quoteResponse.quoteRequest) || {};
    const q = (json.quoteResponse && json.quoteResponse.quote) || {};
    if (!sameAddress(qr.recipient, user) || !sameAddress(qr.refundTo, user)) return false;
    if (q.depositAddress != null && !sameAddress(q.depositAddress, e.depositAddress)) return false;
    return normalizeIntentsStatus(json, { user, depositAddress: e.depositAddress }).length === 0;
  } catch (err) {
    /* The switch is off: say so (the saved address is kept for when it is back on, and re-checked then). */
    if (err && err.code === "private-mode-off") throw err;
    return false;
  }
}

/**
 * The one-time private deposit address for (user, route, plan, amount).
 *
 *   user, connected   the wallet the deposit is for, and the one connected now (must be equal)
 *   route             a PRIVATE_DEPOSIT_ROUTES object (this table's own)
 *   plan              PRIVATE_CORE_PLAN (default) or PRIVATE_ARB_PLAN (privatePlanFor decides)
 *   amountRaw         base units of the route's token (privateDepositAmount makes it)
 *   confidentiality   the server's level, from the probe ("public" = preview, NOT private)
 *
 * Resolves resultOf(...) above, with `watch` for depositWatch.show. Rejects with
 * an IntentsError: bad-user, not-connected, bad-route, bad-plan, bad-amount,
 * below-min, over-tx-cap, testnet-off, confidentiality-mismatch, network,
 * intents-error, bad-response, route-unavailable, private-mode-off, sanctioned,
 * screen-unavailable, over-day-cap, rate-limited, unsafe-quote, bad-deposit-address.
 */
export async function getPrivateDepositAddress({
  user, connected, route, plan = PRIVATE_CORE_PLAN, amountRaw, confidentiality = "public",
  limits = PRIVATE_LIMITS,
  fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
  memory = MEMORY,
  now = browserNow,
  network = HL_NETWORK,
  timers = browserTimers,
  tokensMemo = TOKENS,
  quoteUrl = INTENTS_QUOTE_URL,
  statusUrl = INTENTS_STATUS_URL,
  /* Kept for callers that pass it; the reuse check no longer falls back (see stillUnused). */
  statusFallbackUrl = INTENTS_STATUS_UPSTREAM, // eslint-disable-line no-unused-vars
} = {}) {
  assertPrivateAskable({ user, connected, route, plan, amountRaw, confidentiality, network, limits });
  const ask = { user, route, plan, amountRaw: String(amountRaw), confidentiality };
  const key = privateDepositCacheKey(user, route.id, plan.id, ask.amountRaw, confidentiality);
  /* The route must be live before ANY address is shown, cached or new. */
  try {
    await assertIntentsRouteLive({ route, plan, fetchImpl, memo: tokensMemo, now, timers });
  } catch (e) {
    if (e && e.code === "route-unavailable") forgetKey(storage, memory, key);
    throw e;
  }
  const running = INFLIGHT.get(key);
  if (running) return running;

  const job = (async () => {
    const hit = readEntry(storage, memory, key, ask, now());
    if (hit) {
      if (await stillUnused(hit, user, { fetchImpl, timers, statusUrl })) return resultOf(hit, route, plan, true);
      forgetKey(storage, memory, key);
    }
    const body = buildIntentsDepositQuoteBody({ user, connected, route, plan, amountRaw: ask.amountRaw, dry: false, confidentiality, now: now(), network, limits });
    const json = await postIntentsQuote(body, { fetchImpl, timers, url: quoteUrl });
    const q = parseIntentsDepositQuote(json, { user, route, plan, amountRaw: ask.amountRaw, confidentiality, dry: false, now: now() });
    const entry = {
      v: 1,
      provider: PROVIDER_NEAR,
      user: user.toLowerCase(),
      routeId: route.id,
      planId: plan.id,
      originAsset: route.intentsAsset.assetId,
      destinationAsset: plan.destAsset.assetId,
      amountRaw: ask.amountRaw,
      confidentiality,
      depositAddress: q.depositAddress,
      amountOut: q.amountOut,
      minAmountOut: q.minAmountOut,
      feeUsdc: q.feeUsdc,
      withdrawFeeUsdc: q.withdrawFeeUsdc,
      refundFeeUsdc: q.refundFeeUsdc,
      platformFeeBps: q.platformFeeBps,
      timeEstimateSec: q.timeEstimateSec,
      expiresAt: q.expiresAt,
      inactiveAt: q.inactiveAt,
      showUntil: q.showUntil,
      quotedAt: q.quotedAt,
      correlationId: q.correlationId,
      /* The service says to keep the whole signed answer for disputes. */
      answer: json,
    };
    writeEntry(storage, memory, key, entry);
    return resultOf(entry, route, plan, false);
  })();
  INFLIGHT.set(key, job);
  try { return await job; } finally { INFLIGHT.delete(key); }
}

/**
 * A price-only quote (dry: no address is reserved) for the amount the customer
 * is typing: the fee, the time and what arrives, verified by the same parser.
 * Rejects with the same IntentsErrors.
 */
export async function quotePrivateDeposit({
  user, connected, route, plan = PRIVATE_CORE_PLAN, amountRaw, confidentiality = "public",
  limits = PRIVATE_LIMITS,
  fetchImpl = globalThis.fetch,
  now = browserNow,
  network = HL_NETWORK,
  timers = browserTimers,
  tokensMemo = TOKENS,
  quoteUrl = INTENTS_QUOTE_URL,
} = {}) {
  assertPrivateAskable({ user, connected, route, plan, amountRaw, confidentiality, network, limits });
  await assertIntentsRouteLive({ route, plan, fetchImpl, memo: tokensMemo, now, timers });
  const body = buildIntentsDepositQuoteBody({ user, connected, route, plan, amountRaw: String(amountRaw), dry: true, confidentiality, now: now(), network, limits });
  const json = await postIntentsQuote(body, { fetchImpl, timers, url: quoteUrl });
  const q = parseIntentsDepositQuote(json, { user, route, plan, amountRaw: String(amountRaw), confidentiality, dry: true, now: now() });
  return { ...q, route };
}

/** Is this plan's credited deposit money in the customer's own wallet (the auto-mover's), not yet in Perps? */
export function privatePlanLandsInWallet(planId) {
  return planId === PRIVATE_ARB_PLAN_ID;
}

/** For tests: the shared inflight map is empty between cases. */
export function _privateDepositInflightSize() {
  return INFLIGHT.size;
}

/* A formatted amount for a sentence ("25", "25.5"); unknown is null. */
export function privateAmountText(amountRaw, route) {
  const r = rawOf(amountRaw);
  return r == null || !route ? null : formatUnitsExact(r, route.decimals);
}
