// ─────────────────────────────────────────────────────────────────────────────
// MOVE-OUT: USDC from the user's own Avax Wallet back into their own Perp
// account — THE EXIT, built first and never behind a flag (plan v2 §3.3, §7.4).
// ─────────────────────────────────────────────────────────────────────────────
//
// Primary: Relay 43114 USDC → 1337 USDC (Perps) with usePermit + useMulticall-
// Authorization. The user signs, Relay's solver pays the gas: ZERO AVAX. Ported
// from the recover-fund module (parseRecoverQuote / recoverToPerp), with the
// 2026-10-26 change built in:
//   * today (v3 proxy) the permit step holds ONE item: EIP-3009
//     ReceiveWithAuthorization, `to` = the v3 ApprovalProxy (live capture
//     2026-10-15, 2 USDC → 1.969383, scripts/fixtures/avax/live-move-out-2.json);
//   * from 2026-10-26 (v3.2 proxy) it holds TWO: first a MulticallAuthorization
//     (domain RelayApprovalProxy 3.1, verifyingContract = v3.2 proxy) that pins
//     the exact calls run with the user's USDC, then the EIP-3009 item. Both are
//     signed in order, then POSTed in order — the MulticallAuthorization FIRST
//     (Relay answers 400 to an EIP-3009 posted first).
// Every item is checked before any window opens; the client loops over what
// the quote returns and never assumes one signature (R-gas C13).
//
// Fallback ("paid exit", plan §3.3): when the permit route is refused, the
// user's own wallet sends approve(Avax depository, X) + depository.depositErc20(
// own, USDC, X, orderId), REBUILT here by a closed builder and byte-compared with
// the quote (relay-raw/q11-back-plain.json). It costs ≈ 0.0005 AVAX, which the
// exit reserve holds.
//
// 🔴 MONEY RULES
//   * No recipient parameter: user = recipient = refundTo = own.
//   * The money window is the EIP-3009 POST: the flow registry is written before
//     it; a POST that fails or times out is UNKNOWN ("Not confirmed. Don't send it
//     again."), because the signature is valid until validBefore. A NEW permit is
//     allowed only after validBefore has passed AND USDC.authorizationState(own,
//     nonce) reads false (permitReuseAllowed).
//   * validBefore ≤ now + 600 s (+ a 120 s clock-skew allowance — plan says ≤ 600;
//     without the allowance a phone 2 s slow would refuse every exit) and at least
//     60 s ahead, so a window cannot be signed for nothing.
//   * What is EXPECTED in the Perp account is at least X − max(0.25, 2 % X) (STAKE_FEE_CEILING),
//     and the guaranteed minimum at most 5 % under that (see checkMoveOutOrder). The order the
//     user funds holds ONE payment, and its minimum / expected amount are exactly those figures.

import { HL_RELAY_CHAIN_ID, HL_PERP_USDC, HL_PERP_USDC_DECIMALS, RELAY_API } from "./routes.js";
import { isEvmAddress, sameAddress, RELAY_WITHDRAW_QUOTE_TTL_MS } from "./withdraw.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import {
  AVAX_CHAIN_ID, AVAX_USDC, AVAX_USDC_DECIMALS, AVAX_DEPOSITORY, RELAY_APPROVAL_PROXIES, RELAY_ROUTERS, RELAY_V32,
  USDC_PERMIT_DOMAIN, MULTICALL_AUTH_DOMAIN, NATIVE,
} from "../avax/relayPins.js";
import { toRaw, formatRaw } from "../avax/swapDecode.js";
import { OwnMoveError, postRelayQuote } from "./ownMove.js";
import { stakeFeeCeiling } from "./moveIn.js";
import { claimRun, confirmedNumber } from "../avax/run.js";

export const MIN_MOVE_OUT_USDC = 1;
/** How far under the expected amount Relay's guaranteed minimum may sit (live: 2.00–3.35 %). */
export const MOVE_OUT_MAX_SLIPPAGE_PCT = 5;
export const PERMIT_MAX_VALID_S = 600;
export const PERMIT_CLOCK_SKEW_S = 120;
export const PERMIT_MIN_LEFT_S = 60;
export const MOVE_OUT_POST_TIMEOUT_MS = 20000;
export const MOVE_OUT_QUOTE_TTL_MS = RELAY_WITHDRAW_QUOTE_TTL_MS;

export const MOVE_OUT_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

const RWA_FIELDS = Object.freeze([
  ["from", "address"], ["to", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"], ["nonce", "bytes32"],
]);
const MCA_FIELDS = Object.freeze([
  ["from", "address"], ["relayer", "address"], ["msgValue", "uint256"], ["refundTo", "address"], ["nftRecipient", "address"],
  ["metadata", "bytes"], ["fundingIndex", "uint256"], ["calls", "Call3Value[]"], ["funding", "FundingAuthorization[]"],
]);
const CALL3_FIELDS = Object.freeze([["target", "address"], ["allowFailure", "bool"], ["value", "uint256"], ["callData", "bytes"]]);
const FUNDING_FIELDS = Object.freeze([["token", "address"], ["from", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"]]);
const PERMIT_APIS = Object.freeze(["swap", "bridge", "user-swap"]);

export class MoveOutError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "MoveOutError";
    this.code = code;
    this.detail = detail;
  }
}

const unsafe = (why) => new MoveOutError("unsafe-quote", `The move's price did not check out (${why}); nothing is signed`, { why });
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const DIGITS = /^[0-9]+$/;
const big = (v) => (typeof v === "bigint" ? v : typeof v === "string" && DIGITS.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
const fieldsAre = (list, want) => Array.isArray(list) && list.length === want.length && list.every((f, i) => f && f.name === want[i][0] && f.type === want[i][1]);
const sameDomain = (dom, want) => dom && Object.keys(dom).length === Object.keys(want).length
  && dom.name === want.name && dom.version === want.version && Number(dom.chainId) === want.chainId && lower(dom.verifyingContract) === want.verifyingContract;

/* ── the quote ────────────────────────────────────────────────────────────── */

/** The amount in USDC base units (6 dp), from a typed decimal or from a raw balance read. */
function amountRawOf({ amountRaw = null, amountUsdc = null }) {
  const r = amountRaw != null ? big(amountRaw) : toRaw(amountUsdc, AVAX_USDC_DECIMALS);
  if (r == null || r <= 0n) throw new MoveOutError("bad-amount", "Enter a USDC amount, with at most 6 decimals.");
  if (r < BigInt(MIN_MOVE_OUT_USDC) * 10n ** BigInt(AVAX_USDC_DECIMALS)) throw new MoveOutError("too-small", `A move needs at least ${MIN_MOVE_OUT_USDC} USDC.`);
  return r;
}

/** The permit body: Avax Wallet USDC → Perp account, EIP-3009 (+ MulticallAuthorization after 10-26). */
export function buildMoveOutQuoteBody({ own, amountRaw = null, amountUsdc = null }) {
  if (!isEvmAddress(own)) throw new MoveOutError("bad-user", "Sign in first.");
  const raw = amountRawOf({ amountRaw, amountUsdc });
  return {
    user: own,
    recipient: own,
    refundTo: own,
    originChainId: AVAX_CHAIN_ID,
    originCurrency: AVAX_USDC,
    destinationChainId: HL_RELAY_CHAIN_ID,
    destinationCurrency: HL_PERP_USDC,
    amount: raw.toString(),
    tradeType: "EXACT_INPUT",
    usePermit: true,
    useMulticallAuthorization: true,
  };
}

/* What every move-out answer must say, whichever way it is paid. */
function checkMoveOutOrder(json, { own, raw }) {
  const d = json.details || {};
  if (!sameAddress(d.sender, own)) throw unsafe("the sender is not your wallet");
  if (!sameAddress(d.recipient, own)) throw unsafe("the money would be paid to another account");
  const cin = d.currencyIn || {};
  const cout = d.currencyOut || {};
  const ci = cin.currency || {};
  const co = cout.currency || {};
  if (Number(ci.chainId) !== AVAX_CHAIN_ID || lower(ci.address) !== AVAX_USDC || Number(ci.decimals) !== AVAX_USDC_DECIMALS) throw unsafe("the money leaving is not your Avax Wallet USDC");
  if (big(cin.amount) !== raw) throw unsafe("the amount leaving is not your amount");
  if (Number(co.chainId) !== HL_RELAY_CHAIN_ID || lower(co.address) !== HL_PERP_USDC || Number(co.decimals) !== HL_PERP_USDC_DECIMALS) throw unsafe("the destination is not your Perp account");
  const minOut = big(cout.minimumAmount);
  const expected = big(cout.amount);
  if (minOut == null || expected == null || minOut <= 0n || expected < minOut) throw unsafe("what arrives cannot be read");
  /* 🔴 PLAN DEVIATION (report it): §3.3 says minimumAmount ≥ X − STAKE_FEE_CEILING(X). Relay
     puts a 2–3.35 % destination slippage on this route (live 2026-10-15), so that rule refuses
     every exit above ≈ 13 USDC (the R-gas 20 USDC capture: min 19.563 < 19.6). The fee bound
     is held on what is EXPECTED to arrive, and the minimum may sit at most
     MOVE_OUT_MAX_SLIPPAGE_PCT under it. */
  const x = Number(raw) / 10 ** AVAX_USDC_DECIMALS;
  const floor = BigInt(Math.ceil((x - stakeFeeCeiling(x)) * 10 ** HL_PERP_USDC_DECIMALS));
  if (expected < floor) throw unsafe("too little would arrive in your Perp account");
  if (minOut * 10000n < expected * BigInt(10000 - MOVE_OUT_MAX_SLIPPAGE_PCT * 100)) throw unsafe("too little is guaranteed to arrive in your Perp account");
  const app = json.fees && json.fees.app;
  if (app && big(app.amount) !== 0n) throw unsafe("the answer adds an app fee");

  const v2 = json.protocol && json.protocol.v2;
  const order = v2 && v2.orderData;
  if (!order) throw unsafe("the order is missing");
  const out = order.output || {};
  if (out.chainId !== "hyperliquid") throw unsafe("the order pays on another network");
  const pays = Array.isArray(out.payments) ? out.payments : [];
  if (pays.length !== 1) throw unsafe("the order pays more than once");
  const pay = pays[0];
  if (!pay || !sameAddress(pay.recipient, own) || lower(pay.currency) !== HL_PERP_USDC) throw unsafe("an order payment is not to your Perp account");
  /* 🔴 THE ORDER IS WHAT THE USER FUNDS. The permit's deposit (checkMcaCalls) and the paid exit's
     depositErc20 both fund THIS order, so its own payment must promise exactly the figures the card
     and the window print ("At least X arrives", read from details above). A quote whose details say
     one minimum while the order lets the solver pay less is refused (move-in holds the same rule,
     ownMove.js). */
  if (big(pay.minimumAmount) !== minOut || big(pay.expectedAmount) !== expected) throw unsafe("the order pays another amount than the one shown");
  if (!Array.isArray(out.calls) || out.calls.length !== 0) throw unsafe("the order runs calls");
  const refunds = (order.inputs || []).flatMap((i) => (i && Array.isArray(i.refunds) ? i.refunds : []));
  if (!refunds.every((r) => r && sameAddress(r.recipient, own))) throw unsafe("a refund would go to another address");
  const pd = v2.paymentDetails || {};
  if (pd.chainId !== "avalanche" || lower(pd.depository) !== AVAX_DEPOSITORY || lower(pd.currency) !== AVAX_USDC || big(pd.amount) !== raw) {
    throw unsafe("the deposit is not to the known depository");
  }
  const relayer = json.fees && json.fees.relayer;
  const feeRaw = relayer && relayer.currency && lower(relayer.currency.address) === AVAX_USDC ? big(relayer.amount) : null;
  return {
    requestId: typeof json.requestId === "string" ? json.requestId : null,
    orderId: typeof v2.orderId === "string" ? v2.orderId : null,
    receiveUsdc: formatRaw(expected, HL_PERP_USDC_DECIMALS),
    minimumUsdc: formatRaw(minOut, HL_PERP_USDC_DECIMALS),
    feeUsdc: feeRaw == null ? null : formatRaw(feeRaw, AVAX_USDC_DECIMALS),
    timeEstimateSec: Number.isFinite(Number(d.timeEstimate)) ? Number(d.timeEstimate) : null,
    orderDeadline: Number.isFinite(Number(out.deadline)) ? Number(out.deadline) : null,
  };
}

/* The deadline of a grant, read against the user's clock. */
function checkWindow(validAfter, validBefore, nowS) {
  const vb = Number(validBefore);
  const va = Number(validAfter);
  if (!Number.isSafeInteger(vb) || vb <= 0) throw unsafe("the authorisation never expires");
  if (vb > nowS + PERMIT_MAX_VALID_S + PERMIT_CLOCK_SKEW_S) throw unsafe("the authorisation would stay usable too long");
  if (vb < nowS + PERMIT_MIN_LEFT_S) throw unsafe("the authorisation is about to expire");
  if (!Number.isSafeInteger(va) || va > nowS + PERMIT_CLOCK_SKEW_S) throw unsafe("the authorisation is not usable yet");
  return vb;
}

/* A permit item's POST: /execute/permits, this order, the expected kind. */
function checkPost(post, { requestId, kind }) {
  if (!post || post.endpoint !== "/execute/permits" || String(post.method || "").toUpperCase() !== "POST" || !post.body) throw unsafe("a signature does not say where to post it");
  const b = post.body;
  if (b.kind !== kind) throw unsafe(`a signature is posted as ${String(b.kind)}, not ${kind}`);
  if (typeof b.requestId !== "string" || b.requestId !== requestId) throw unsafe("a signature is for another order");
  if (!PERMIT_APIS.includes(b.api)) throw unsafe("a signature is posted to an unknown service");
  return Object.freeze({ endpoint: post.endpoint, method: "POST", body: b });
}

/*
 * The calls a MulticallAuthorization may pin: EXACTLY the deposit of the user's X
 * for THIS order, and nothing else (ATK-01a/b):
 *     [ USDC.approve(Avax depository, X) ]?  then  depository.depositErc20(own, USDC, X, orderId)
 * The id must be this quote's protocol.v2.orderId — the order whose payment to the
 * user's own Perp account checkMoveOutOrder verified. A deposit under any other id
 * funds an order nobody checked; a bare transfer funds no order at all; a deposit of
 * less than X leaves the rest in Relay's proxy. All refused before any window.
 * (UNVERIFIED against a live v3.2 answer — none can exist before 2026-10-26. A shape
 * this refuses sends the user to the paid exit, never to an unchecked signature.)
 */
function checkMcaCalls(calls, { own, raw, orderId }) {
  if (typeof orderId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(orderId)) throw unsafe("the order names no id");
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 2) throw unsafe("the authorised calls are not a deposit");
  let deposits = 0;
  calls.forEach((c, i) => {
    if (!c || c.allowFailure !== false || big(c.value) !== 0n) throw unsafe("an authorised call may fail or carries value");
    let d;
    try { d = decodeFunctionData({ abi: MOVE_OUT_ABI, data: c.callData }); } catch { throw unsafe("an authorised call cannot be read"); }
    if (encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: d.functionName, args: d.args }).toLowerCase() !== lower(c.callData)) throw unsafe("an authorised call carries bytes it should not");
    const target = lower(c.target);
    const last = i === calls.length - 1;
    if (d.functionName === "approve" || d.functionName === "transfer") {
      if (target !== AVAX_USDC) throw unsafe("an authorised call moves another token");
      const to = lower(d.args[0]);
      if (to !== AVAX_DEPOSITORY && !RELAY_ROUTERS.includes(to)) throw unsafe("an authorised call pays an unknown address");
      if (d.functionName === "transfer") throw unsafe("an authorised call moves your USDC outside this order");
      if (to !== AVAX_DEPOSITORY || last) throw unsafe("an authorised allowance is not for this deposit");
      if (d.args[1] !== raw) throw unsafe("an authorised allowance is for another amount");
    } else if (d.functionName === "depositErc20") {
      if (target !== AVAX_DEPOSITORY) throw unsafe("an authorised deposit goes to an unknown contract");
      if (!sameAddress(d.args[0], own) || lower(d.args[1]) !== AVAX_USDC) throw unsafe("an authorised deposit is not yours");
      if (d.args[2] !== raw) throw unsafe("an authorised deposit is for another amount");
      if (lower(d.args[3]) !== lower(orderId)) throw unsafe("an authorised deposit is for another order");
      if (!last) throw unsafe("an authorised deposit is not the last call");
      deposits += 1;
    } else {
      throw unsafe("an authorised call is not a deposit");
    }
  });
  if (deposits !== 1) throw unsafe("the authorised calls do not deposit your amount for this order");
}

/**
 * Verify a move-out permit answer. Every step and item is checked; nothing is
 * assumed about how many signatures there are (1 today, 2 after 10-26).
 * A quote that needs a TRANSACTION (gas) is refused with code "needs-gas" —
 * the caller then prices the paid exit instead.
 *
 * @returns frozen review: { requestId, own, amountRaw, amountUsdc, receiveUsdc, minimumUsdc, feeUsdc,
 *   signatures: [{ kind, typedData, post }], permitNonce, validBefore, quotedAt, statusEndpoint }
 */
export function parseMoveOutQuote(json, { own, amountRaw = null, amountUsdc = null, now = Date.now() } = {}) {
  if (!isEvmAddress(own)) throw new MoveOutError("bad-user", "Sign in first.");
  const raw = amountRawOf({ amountRaw, amountUsdc });
  if (!json || typeof json !== "object") throw unsafe("no answer");
  const steps = Array.isArray(json.steps) ? json.steps : [];
  if (steps.some((s) => s && s.kind === "transaction")) throw new MoveOutError("needs-gas", "This route needs gas from your Avax Wallet.", { steps: steps.map((s) => s && s.id) });
  if (steps.length !== 1) throw unsafe("the move is not one signature step");
  const step = steps[0];
  if (!step || step.kind !== "signature" || !/^authorize\d*$/.test(String(step.id))) throw unsafe("the step is not an authorisation");
  const items = Array.isArray(step.items) ? step.items : [];
  if (items.length < 1 || items.length > 2) throw unsafe("the step asks for an unexpected number of signatures");
  const requestId = typeof json.requestId === "string" ? json.requestId : null;
  if (!requestId) throw unsafe("the answer names no order");
  const nowS = Math.floor(Number(now) / 1000);
  if (!Number.isFinite(nowS)) throw unsafe("there is no clock to check the authorisation against");

  const order = checkMoveOutOrder(json, { own, raw });
  const signatures = [];
  let rwa = null;
  let mca = null;
  items.forEach((it, i) => {
    const d = it && it.data;
    const sign = d && d.sign;
    if (!sign || sign.signatureKind !== "eip712" || !sign.types || !sign.value || !sign.domain) throw unsafe("a signature is not a readable EIP-712");
    const isLast = i === items.length - 1;
    if (isLast) {
      /* EIP-3009 ReceiveWithAuthorization on USDC itself. */
      if (sign.primaryType !== "ReceiveWithAuthorization") throw unsafe("the last signature is not the USDC authorisation");
      if (!sameDomain(sign.domain, USDC_PERMIT_DOMAIN)) throw unsafe("the authorisation is not for USDC on Avalanche");
      if (Object.keys(sign.types).length !== 1 || !fieldsAre(sign.types.ReceiveWithAuthorization, RWA_FIELDS)) throw unsafe("the authorisation's fields are not the ones it should be");
      const v = sign.value;
      if (!sameAddress(v.from, own)) throw unsafe("the authorisation is not from your wallet");
      if (!RELAY_APPROVAL_PROXIES.includes(lower(v.to))) throw unsafe("the authorisation pays an unknown contract");
      if (big(String(v.value)) !== raw) throw unsafe("the authorisation is for another amount");
      if (typeof v.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.nonce)) throw unsafe("the authorisation has no usable nonce");
      const vb = checkWindow(v.validAfter, v.validBefore, nowS);
      rwa = { to: lower(v.to), nonce: lower(v.nonce), validBefore: vb };
      signatures.push(Object.freeze({
        kind: "eip3009",
        typedData: Object.freeze({ domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message: v }),
        post: checkPost(d.post, { requestId, kind: "eip3009" }),
      }));
    } else {
      /* The v3.2 MulticallAuthorization, first of two. */
      if (sign.primaryType !== "MulticallAuthorization") throw unsafe("the first signature is not the call authorisation");
      if (!sameDomain(sign.domain, MULTICALL_AUTH_DOMAIN)) throw unsafe("the call authorisation is not for the known contract");
      const t = sign.types;
      if (Object.keys(t).length !== 3 || !fieldsAre(t.MulticallAuthorization, MCA_FIELDS) || !fieldsAre(t.Call3Value, CALL3_FIELDS) || !fieldsAre(t.FundingAuthorization, FUNDING_FIELDS)) {
        throw unsafe("the call authorisation's fields are not the ones it should be");
      }
      const v = sign.value;
      if (!sameAddress(v.from, own) || !sameAddress(v.refundTo, own)) throw unsafe("the call authorisation is not yours");
      if (!(sameAddress(v.nftRecipient, own) || lower(v.nftRecipient) === NATIVE)) throw unsafe("the call authorisation names another recipient");
      if (big(String(v.msgValue)) !== 0n) throw unsafe("the call authorisation spends AVAX");
      if (Number(v.fundingIndex) !== 0) throw unsafe("the call authorisation is funded oddly");
      const f = Array.isArray(v.funding) ? v.funding : [];
      if (f.length !== 1) throw unsafe("the call authorisation pulls more than one amount");
      if (lower(f[0].token) !== AVAX_USDC || !sameAddress(f[0].from, own) || big(String(f[0].value)) !== raw) throw unsafe("the call authorisation pulls another amount");
      checkWindow(f[0].validAfter, f[0].validBefore, nowS);
      checkMcaCalls(v.calls, { own, raw, orderId: order.orderId });
      mca = true;
      signatures.push(Object.freeze({
        kind: "multicall-authorization",
        typedData: Object.freeze({ domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message: v }),
        post: checkPost(d.post, { requestId, kind: "multicall-authorization" }),
      }));
    }
  });
  /* Two signatures only ever on the v3.2 proxy, and then the permit must name it too. */
  if (mca && rwa.to !== RELAY_V32.approvalProxy) throw unsafe("the two signatures are for different contracts");
  /* …and a permit to the v3.2 proxy never comes alone: its nonce is derived from the
     MulticallAuthorization (Relay docs, gasless-swaps), so a lone one would commit the
     user to calls they never saw (ATK-05). */
  if (!mca && rwa.to === RELAY_V32.approvalProxy) throw unsafe("the authorisation comes without the calls it commits to");

  const check = items[items.length - 1].check;
  return Object.freeze({
    ...order,
    kind: "move-out",
    route: "permit",
    own: lower(own),
    amountRaw: raw.toString(),
    amountUsdc: formatRaw(raw, AVAX_USDC_DECIMALS),
    signatures: Object.freeze(signatures),
    signatureCount: signatures.length,
    permitNonce: rwa.nonce,
    validBefore: rwa.validBefore,
    statusEndpoint: check && typeof check.endpoint === "string" ? check.endpoint : `/intents/status/v3?requestId=${requestId}`,
    quotedAt: Number(now),
  });
}

/** Price a move-out (permit route) and verify it. One POST /quote/v2; nothing is signed. */
export async function quoteMoveOut({ own, amountRaw = null, amountUsdc = null, fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, signal = null } = {}) {
  const body = buildMoveOutQuoteBody({ own, amountRaw, amountUsdc });
  const json = await postRelayQuote(body, { fetchImpl, timers, signal });
  return { body, review: parseMoveOutQuote(json, { own, amountRaw: body.amount, now: now() }) };
}

/* ── doing it ─────────────────────────────────────────────────────────────── */

export const MOVE_OUT_WORDS = Object.freeze({
  cancelled: "Cancelled. Nothing moved.",
  expired: "Price expired. Nothing moved.",
  wallet: "Your wallet changed. Nothing moved.",
  registry: "This browser couldn't record the move, so nothing was sent.",
  notSent: "Not sent. Nothing moved.",
  unknown: "Not confirmed. Don't send it again.",
  overConfirmed: "This moves more than you confirmed. Check the new amount. Nothing moved.",
  busy: "Another move is still running. Nothing moved.",
});

/** "Unstake all" moves the measured amount if it is at most what was confirmed × 1.001 (plan §3.3). */
export const MOVE_OUT_CONFIRM_SLACK = 1.001;

/**
 * Why `review` moves more than the user confirmed (null when it does not): at most the
 * record's maxDebit, and at most `amounts.in` (or `amounts.amountRaw`) × 1.001. A card
 * that recorded neither is not bounded here — the exit pays only the user's own Perp
 * account, checked by the parser — and the after-gate card must record one.
 */
export function moveOutOutsideConfirmed(record, review) {
  if (!review || typeof review.amountRaw !== "string" || !DIGITS.test(review.amountRaw)) return "not-decodable";
  const raw = BigInt(review.amountRaw);
  const cap = confirmedNumber(record && record.maxDebit);
  if (cap != null && Number(raw) / 10 ** AVAX_USDC_DECIMALS > cap + 1e-9) return "over-confirmed";
  const a = record && record.amounts && typeof record.amounts === "object" ? record.amounts : {};
  const confirmed = a.amountRaw != null ? big(String(a.amountRaw)) : a.in != null ? toRaw(String(a.in), AVAX_USDC_DECIMALS) : undefined;
  if (confirmed === null) return "not-decodable";
  if (confirmed !== undefined && raw * 1000n > confirmed * BigInt(Math.round(MOVE_OUT_CONFIRM_SLACK * 1000))) return "over-confirmed";
  return null;
}

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

async function postPermit({ post, signature, fetchImpl, timers }) {
  const url = `${RELAY_API}${post.endpoint}${post.endpoint.includes("?") ? "&" : "?"}signature=${encodeURIComponent(signature)}`;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), MOVE_OUT_POST_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(post.body), signal: ctrl ? ctrl.signal : undefined });
    return { ok: !!res && res.ok === true, status: res ? res.status : null };
  } catch (e) {
    return { ok: false, status: null, error: String((e && e.message) || e) };
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
}

/**
 * Sign every item in order, then POST them in order — the EIP-3009 last, after
 * the registry write. Never throws.
 *
 * 🔴 Before any window: the flow's "move-out" stage is CLAIMED (once, ever), the amount
 * is checked against what the user confirmed, and the cross-tab lock is taken. After
 * the signing windows — which may take minutes — the quote must STILL be inside its
 * 60 s TTL before anything is posted, and again right before the POST that moves money
 * (plan §3.6 "Price expired. Nothing moved.", ATK-09).
 *
 * @param {{ review: object, ownNow: () => string|null,
 *   signTypedData: (typedData: { domain, types, primaryType, message }) => Promise<string>,
 *   flow: object,   // registry.handle(id) — claim / get / acquire / beforeWindow / update / unknown / cancel
 *   onWindow?: (kind: string, index: number, count: number) => void,
 *   fetchImpl?: Function, now?: () => number, timers?: object }} o
 *   signTypedData shows the wallet's own window (the providerTypedSigner shape).
 * @returns {Promise<{ ok: true, requestId, state: "arriving" } | { ok: false, code, message, state, unknown?: true, permitNonce?, validBefore? }>}
 */
export async function executeMoveOut({
  review, ownNow, signTypedData, flow, onWindow = () => {},
  fetchImpl = globalThis.fetch, now = browserNow, timers = browserTimers,
} = {}) {
  /* 0. THE CLAIM — synchronous, before the first await. */
  const run = claimRun(flow, "move-out");
  if (!run.ok && run.untouched) return { ok: false, code: run.code, message: run.message, state: null, untouched: true };

  let release = () => {};
  const end = (state, code, message, extra = {}) => {
    try { release(); } catch { /* released */ }
    try {
      if (state === "unknown" && flow && typeof flow.unknown === "function") flow.unknown(code);
      else if (state !== "unknown" && flow && typeof flow.cancel === "function") flow.cancel(code, state);
    } catch { /* the outcome stands */ }
    return { ok: false, code, message, state, ...extra };
  };
  if (!run.ok) return end("error-before-money", "registry", MOVE_OUT_WORDS.registry);
  if (!review || !Array.isArray(review.signatures) || !review.signatures.length) return end("error-before-money", "bad-quote", "No price to move with. Nothing moved.");
  if (typeof signTypedData !== "function") return end("error-before-money", "no-signer", "This wallet can't sign this move here. Nothing moved.");
  const ownIs = () => {
    let o = null;
    try { o = typeof ownNow === "function" ? ownNow() : null; } catch { o = null; }
    return isEvmAddress(o) && sameAddress(o, review.own);
  };
  const fresh = () => Number.isFinite(review.quotedAt) && now() - review.quotedAt < MOVE_OUT_QUOTE_TTL_MS;
  if (!ownIs()) return end("error-before-money", "wallet", MOVE_OUT_WORDS.wallet);
  if (!fresh()) return end("cancelled", "price_expired", MOVE_OUT_WORDS.expired);

  /* 1. Bound to the card the user confirmed. */
  const outside = moveOutOutsideConfirmed(run.record, review);
  if (outside) return end("cancelled", outside, MOVE_OUT_WORDS.overConfirmed, { needsConfirm: true, why: outside });

  /* 2. The cross-tab lock and a fresh look at the registry, before the first window. */
  let lock = null;
  try { lock = await flow.acquire(); } catch { lock = null; }
  if (!lock || lock.ok !== true) {
    const storage = !!lock && lock.code === "storage";
    return end(storage ? "error-before-money" : "cancelled", storage ? "registry" : (lock && lock.code) || "busy", storage ? MOVE_OUT_WORDS.registry : MOVE_OUT_WORDS.busy);
  }
  release = typeof lock.release === "function" ? lock.release : () => {};
  try {
    return await moveOutWindows({ review, ownIs, fresh, signTypedData, flow, onWindow, fetchImpl, now, timers, end });
  } finally {
    try { release(); } catch { /* released */ }
  }
}

async function moveOutWindows({ review, ownIs, fresh, signTypedData, flow, onWindow, fetchImpl, now, timers, end }) {
  /* 1. every signature, in the order given; nothing is posted yet. */
  const signed = [];
  for (let i = 0; i < review.signatures.length; i += 1) {
    const s = review.signatures[i];
    let sig;
    try {
      onWindow(s.kind, i, review.signatures.length);
      sig = await signTypedData(s.typedData);
    } catch {
      return end("cancelled", "cancelled", MOVE_OUT_WORDS.cancelled);
    }
    if (typeof sig !== "string" || !SIGNATURE_RE.test(sig)) return end("cancelled", "cancelled", MOVE_OUT_WORDS.cancelled);
    signed.push({ ...s, signature: sig });
  }
  /* The signing may have taken longer than the price lives: nothing is posted on an old one. */
  if (!fresh()) return end("cancelled", "price_expired", MOVE_OUT_WORDS.expired);
  const nowS = Math.floor(now() / 1000);
  if (review.validBefore < nowS + 30) return end("cancelled", "price_expired", MOVE_OUT_WORDS.expired);
  if (!ownIs()) return end("error-before-money", "wallet", MOVE_OUT_WORDS.wallet);

  /* 2. the MulticallAuthorization first (moves nothing on its own). */
  for (const s of signed.slice(0, -1)) {
    const r = await postPermit({ post: s.post, signature: s.signature, fetchImpl, timers });
    if (!r.ok) return end("error-before-money", "post_refused", MOVE_OUT_WORDS.notSent);
  }

  /* 3. the registry, then the POST that moves money — still on a live price. */
  if (!fresh() || review.validBefore < Math.floor(now() / 1000) + 30) return end("cancelled", "price_expired", MOVE_OUT_WORDS.expired);
  const last = signed[signed.length - 1];
  try {
    await flow.beforeWindow({ state: "sending", requestId: review.requestId, permitNonce: review.permitNonce, validBefore: review.validBefore, orderDeadline: review.orderDeadline });
  } catch {
    return end("error-before-money", "registry", MOVE_OUT_WORDS.registry);
  }
  const r = await postPermit({ post: last.post, signature: last.signature, fetchImpl, timers });
  if (!r.ok) {
    return end("unknown", "not_confirmed", MOVE_OUT_WORDS.unknown, { unknown: true, requestId: review.requestId, permitNonce: review.permitNonce, validBefore: review.validBefore });
  }
  try { if (typeof flow.update === "function") flow.update({ state: "arriving", sentAt: now() }); } catch { /* watched by requestId */ }
  return { ok: true, requestId: review.requestId, state: "arriving" };
}

/* ── after an unclear POST: may a NEW permit ever be signed? ─────────────── */

/** The read-only eth_call that says whether this permit nonce was used. */
export function authorizationStateCall({ own, nonce }) {
  if (!isEvmAddress(own) || typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  return { to: AVAX_USDC, data: encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "authorizationState", args: [own, nonce] }) };
}

/** Read that eth_call's result: true (used), false (unused), null (unreadable — never "unused"). */
export function readAuthorizationState(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
  const v = BigInt(hex);
  return v === 1n ? true : v === 0n ? false : null;
}

/**
 * A NEW permit for the same money only once the old one can never execute:
 * its validBefore has passed AND the chain says its nonce is unused (plan §3.6).
 */
export function permitReuseAllowed({ validBefore, used, now = Date.now() } = {}) {
  const vb = Number(validBefore);
  if (!Number.isFinite(vb)) return false;
  return Math.floor(Number(now) / 1000) > vb && used === false;
}

/* ── the paid exit (fallback) ─────────────────────────────────────────────── */

/** The plain body (no permit): the user's own wallet sends approve + depositErc20. */
export function buildPaidExitQuoteBody({ own, amountRaw = null, amountUsdc = null }) {
  const b = buildMoveOutQuoteBody({ own, amountRaw, amountUsdc });
  delete b.usePermit;
  delete b.useMulticallAuthorization;
  return b;
}

/**
 * THE CLOSED BUILDER: the only two transactions a paid exit may be, rebuilt from
 * constants + own + the amount + the order id. Each is an unsigned request with
 * chainId 43114 and value 0; gas and maxFeePerGas are set by the sender.
 */
export function buildPaidExitTxs({ own, amountRaw, orderId }) {
  if (!isEvmAddress(own)) throw new MoveOutError("bad-user", "Sign in first.");
  const raw = big(amountRaw);
  if (raw == null || raw <= 0n) throw new MoveOutError("bad-amount", "Enter an amount to move.");
  if (typeof orderId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(orderId)) throw new MoveOutError("bad-order", "The order id is not readable.");
  return [
    Object.freeze({ purpose: "approve", chainId: AVAX_CHAIN_ID, to: AVAX_USDC, value: "0x0", data: encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "approve", args: [AVAX_DEPOSITORY, raw] }) }),
    Object.freeze({ purpose: "deposit", chainId: AVAX_CHAIN_ID, to: AVAX_DEPOSITORY, value: "0x0", data: encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: "depositErc20", args: [own, AVAX_USDC, raw, orderId] }) }),
  ];
}

/**
 * Verify a paid-exit answer by REBUILDING both transactions and byte-comparing
 * them with Relay's. The approve may be absent when the allowance already covers it.
 * @returns frozen review with `txs` (ours, not Relay's) and each item's quoted gas.
 */
export function parsePaidExitQuote(json, { own, amountRaw = null, amountUsdc = null, now = Date.now() } = {}) {
  if (!isEvmAddress(own)) throw new MoveOutError("bad-user", "Sign in first.");
  const raw = amountRawOf({ amountRaw, amountUsdc });
  if (!json || typeof json !== "object") throw unsafe("no answer");
  const order = checkMoveOutOrder(json, { own, raw });
  if (!order.orderId) throw unsafe("the order names no id");
  const steps = Array.isArray(json.steps) ? json.steps : [];
  const ids = steps.map((s) => s && s.id).join(",");
  if (ids !== "approve,deposit" && ids !== "deposit") throw unsafe(`the steps are ${ids || "none"}, not approve then deposit`);
  const ours = buildPaidExitTxs({ own, amountRaw: raw, orderId: order.orderId });
  const want = ids === "deposit" ? ours.slice(1) : ours;
  const gas = [];
  steps.forEach((s, i) => {
    if (s.kind !== "transaction" || !Array.isArray(s.items) || s.items.length !== 1) throw unsafe("a step is not one transaction");
    const d = s.items[0].data || {};
    if (Number(d.chainId) !== AVAX_CHAIN_ID || !sameAddress(d.from, own)) throw unsafe("a transaction is not from your wallet on Avalanche");
    if (lower(d.to) !== want[i].to || lower(d.data) !== lower(want[i].data)) throw unsafe("a transaction is not the one this app builds");
    if (big(String(d.value == null ? "0" : d.value)) !== 0n) throw unsafe("a transaction carries AVAX");
    const g = d.gas == null ? null : Number(d.gas);
    gas.push(Number.isSafeInteger(g) && g > 0 ? g : null);
  });
  return Object.freeze({
    ...order,
    kind: "move-out",
    route: "paid",
    own: lower(own),
    amountRaw: raw.toString(),
    amountUsdc: formatRaw(raw, AVAX_USDC_DECIMALS),
    txs: Object.freeze(want.map((t, i) => Object.freeze({ ...t, gas: gas[i] }))),
    quotedAt: Number(now),
  });
}
