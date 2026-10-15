// ─────────────────────────────────────────────────────────────────────────────
// A SAME-CHAIN SWAP QUOTE ON AVALANCHE, DECODED DOWN TO THE CALLDATA, and
// refused unless what will be signed is exactly what the card shows.
// PURE: no env, no network, no clock (callers pass `now`), nothing at import.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15 (AD-9, approved "1.) ได้ 2.) เค 3.) ได้"):
//   1. the minimum received on the card is the one IN THE CALLDATA, and no other
//      call may ride along;
//   2. on an AVAX-in swap the recipient and refundTo must be the user's own wallet;
//   3. a worse re-quote is never signed without a new Confirm (lib/relay/swap.js
//      compareRequote — this file supplies the decoded figures it compares).
//
// WHAT A RELAY SWAP IS (captured live 2026-10-15; R-swap §1.2 + Verification):
//   ERC-20 in  → steps ["approve"?, "swap"]. approve(ApprovalProxy, EXACT amount)
//                then ApprovalProxy.transferAndMulticall(tokens, amounts, calls,
//                refundTo, nftRecipient, metadata). The calls run in Relay's
//                router, in one of these exact shapes (and nothing else):
//                  A (fee taken from what goes IN — USDC → X, q1/q3/live):
//                    from.approve(AllowanceHolder, ≤ amount)
//                    router.cleanupErc20s([from],[solver],[fee])
//                    AllowanceHolder.exec(settler, from, amount − fee, settler,
//                        Settler.execute({recipient: router, buyToken: to, minAmountOut}, …))
//                    router.cleanupErc20s([to],[own],[0])  |  router.cleanupNative(0, own)
//                  B (fee taken from what comes OUT — X → USDC, q11, THE EXIT SWAP):
//                    from.approve(AllowanceHolder, ≤ amount)
//                    AllowanceHolder.exec(settler, from, amount, settler, Settler.execute(…minAmountOut))
//                    router.cleanupErc20s([to],[solver],[fee])  |  cleanupNative(fee, solver)
//                    router.cleanupErc20s([to],[own],[0])  |  cleanupNative(0, own)
//                  C (no fee): A or B without the fee call.
//                The user's guaranteed minimum is minAmountOut (A, C) or
//                minAmountOut − fee (B); it must EQUAL details.currencyOut.
//                minimumAmount, or the quote is refused (rule 1).
//   AVAX in    → one "swap" step: router.multicall(calls, refundTo, nftRecipient,
//                metadata) with value = amount. Live answers carry refundTo =
//                nftRecipient = 0x0, which rule 2 refuses ("Swap unavailable");
//                the P1 way round is WAVAX.deposit() then the ERC-20 path.
//
// 🔴 PLAN DEVIATION, DELIBERATE (report it): plan §3.11 lists only layout A and
// "cleanup to the solver only in the `from` token". The live exit swap BTC.b →
// USDC (fixture q11) is layout B — the fee is paid in USDC after the swap — so
// that rule alone would have refused the way OUT. B is accepted with the same
// strictness: one fee call, to a pinned solver, ≤ 0.5 %, and the minimum the user
// is promised is computed after it.
//
// 🔴 THE MIN IS ONLY AS GOOD AS THE SETTLER. Settler.execute enforces
// minAmountOut, but a contract that merely shares the selector would not. So the
// exec target must be a 0x Settler this app trusts: the pinned pair, or the pair
// the read layer just read from 0x's Deployer registry (settlerRegistryCalls()).
// An unknown one is refused, never trusted.
//
// Every decoded call is RE-ENCODED and byte-compared with what Relay sent, so
// nothing can hide in trailing bytes or non-canonical offsets.

import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import {
  AVAX_CHAIN_ID, NATIVE, RELAY_PAIRS, RELAY_APPROVAL_PROXIES, RELAY_ROUTERS, RELAY_SOLVERS, ALLOWANCE_HOLDER,
  KNOWN_SETTLERS, SETTLER_DEPLOYER, SETTLER_FEATURE_TAKER, swapTokenByAddress, relayPairOf,
} from "./relayPins.js";

/* ── the ABI the parser reads (selectors pinned in SELECTORS and tested) ───── */

export const SWAP_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata)",
  "function multicall((address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata)",
  "function cleanupErc20s(address[] tokens, address[] recipients, uint256[] amounts, bytes metadata)",
  "function cleanupNative(uint256 amount, address recipient, bytes metadata)",
  "function exec(address operator, address token, uint256 amount, address target, bytes data)",
  "function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid)",
]);

export const SELECTORS = Object.freeze({
  approve: "0x095ea7b3",
  transferAndMulticall: "0xf9e4bab4",
  multicall: "0xcd6e13f7",
  cleanupErc20s: "0x9bb43718",
  cleanupNative: "0xa6bd8c96",
  exec: "0x2213bc0b",
  execute: "0x1fff991f",
});

const REGISTRY_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function prev(uint128 tokenId) view returns (address)",
]);

/** 0x Settler's sentinel for "native" as a buyToken. */
export const SETTLER_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** Most a swap may pay the solver: 0.5 % (live: 0.15 % minor, 0.01 % stable). */
export const MAX_SWAP_FEE_BPS = 50n;
/** When an item carries no `gas`, these units are assumed (plan §3.11 "Gas"; never fees.gas alone). */
export const SWAP_GAS_FALLBACK = Object.freeze({ approve: 75_000, swap: 1_000_000 });

export class SwapQuoteError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "SwapQuoteError";
    this.code = code;
    this.detail = detail;
  }
}

/* Plain words: the swap card prints these, so no provider or venue is named. */
const unsafe = (why) => new SwapQuoteError("unsafe-quote", `The swap price did not check out (${why}); nothing is signed`, { why });
const unavailable = (why) => new SwapQuoteError("swap-unavailable", "Swap unavailable for this pair right now. Nothing is signed.", { why });

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const isAddr = (a) => typeof a === "string" && ADDRESS_RE.test(a);
const isOwnAddress = (a) => isAddr(a) && lower(a) !== NATIVE;
const same = (a, b) => isAddr(a) && isAddr(b) && lower(a) === lower(b);
const DIGITS = /^[0-9]+$/;

function bigOf(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && DIGITS.test(v)) return BigInt(v);
  return null;
}

/** Base units → exact decimal string ("0.00012137"), never a float. Null when unreadable. */
export function formatRaw(raw, decimals) {
  const r = bigOf(raw);
  if (r == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const unit = 10n ** BigInt(decimals);
  const whole = r / unit;
  const frac = (r % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** A decimal string or number → base units (BigInt), or null. Truncation is refused, never rounded. */
export function toRaw(amount, decimals) {
  const s = typeof amount === "number" ? (Number.isFinite(amount) ? amount.toFixed(Math.min(decimals, 18)).replace(/\.?0+$/, "") : "") : String(amount == null ? "" : amount).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [i = "", f = ""] = s.split(".");
  const frac = f.replace(/0+$/, "");
  if (frac.length > decimals) return null;
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((frac || "").padEnd(decimals, "0") || "0");
}

/* Decode one call against SWAP_ABI and prove it is canonical: re-encoding the
   decoded arguments must give back the very same bytes. `suffix`: the ONE thing
   allowed after them — Relay appends the quote's requestId (32 bytes) to the
   outer swap call (every capture, 2026-10-15), and nothing else may ride there. */
function decodeStrict(data, expect, { suffix = null } = {}) {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(data)) throw unsafe("a call is not readable hex");
  let d;
  try {
    d = decodeFunctionData({ abi: SWAP_ABI, data });
  } catch {
    throw unsafe(`a call could not be decoded (${data.slice(0, 10)})`);
  }
  if (expect && d.functionName !== expect) throw unsafe(`expected ${expect}, found ${d.functionName}`);
  let again;
  try {
    again = encodeFunctionData({ abi: SWAP_ABI, functionName: d.functionName, args: d.args });
  } catch {
    throw unsafe("a call does not re-encode");
  }
  const tail = lower(data).slice(again.length);
  if (!lower(data).startsWith(lower(again))) throw unsafe(`${d.functionName} carries bytes it should not`);
  if (tail && !(suffix && /^0x[0-9a-f]{64}$/.test(lower(suffix)) && tail === lower(suffix).slice(2))) {
    throw unsafe(`${d.functionName} carries bytes it should not`);
  }
  return d;
}

/* The Settler's own call inside AllowanceHolder.exec. */
function decodeSettler(data) {
  const d = decodeStrict(data, "execute");
  const [slip, actions, zid] = d.args;
  return { recipient: lower(slip.recipient), buyToken: lower(slip.buyToken), minAmountOut: slip.minAmountOut, actions: actions.length, zid };
}

const settlerToken = (t) => (t.native ? SETTLER_NATIVE : t.address);

/* One cleanup call, read: { kind: "erc20"|"native", token, recipient, amount } or a refusal. */
function readCleanup(call, router) {
  if (lower(call.target) !== router) throw unsafe("a payout runs somewhere other than the router");
  const d = decodeStrict(call.callData);
  if (d.functionName === "cleanupErc20s") {
    const [tokens, recipients, amounts] = d.args;
    if (tokens.length !== 1 || recipients.length !== 1 || amounts.length !== 1) throw unsafe("a payout moves more than one token");
    return { kind: "erc20", token: lower(tokens[0]), recipient: lower(recipients[0]), amount: amounts[0] };
  }
  if (d.functionName === "cleanupNative") {
    const [amount, recipient] = d.args;
    return { kind: "native", token: NATIVE, recipient: lower(recipient), amount };
  }
  throw unsafe(`a payout is ${d.functionName}, not a cleanup`);
}

/* The DEX call: AllowanceHolder.exec into a trusted Settler, paying the router. */
function readExec(call, { router, from, to, settlers, value }) {
  if (lower(call.target) !== ALLOWANCE_HOLDER) throw unsafe("the swap does not go through the allowance holder");
  if (BigInt(call.value) !== value) throw unsafe("the swap call carries the wrong value");
  const d = decodeStrict(call.callData, "exec");
  const [operator, token, amount, target, data] = d.args;
  if (lower(operator) !== lower(target)) throw unsafe("the swap's operator and target differ");
  if (!settlers.includes(lower(target))) throw unavailable("the swap venue is not one this app trusts");
  if (lower(token) !== (from.native ? NATIVE : from.address)) throw unsafe("the swap sells another token");
  const s = decodeSettler(data);
  if (s.recipient !== router) throw unsafe("the swap pays somewhere other than the router");
  if (s.buyToken !== settlerToken(to)) throw unsafe("the swap buys another token");
  if (s.minAmountOut <= 0n) throw unsafe("the swap has no minimum");
  return { settler: lower(target), amount, minAmountOut: s.minAmountOut };
}

/**
 * THE CALL SEQUENCE inside a swap, checked against layouts A / B / C (header).
 * Returns { layout, settler, minOut, fee: { side, token, raw } | null }.
 */
export function readSwapCalls(calls, { router, from, to, own, amountRaw, solvers = RELAY_SOLVERS, settlers = KNOWN_SETTLERS, native = false } = {}) {
  if (!Array.isArray(calls) || calls.length < 3 || calls.length > 4) throw unsafe("the swap runs an unexpected number of calls");
  if (!calls.every((c) => c && c.allowFailure === false)) throw unsafe("a swap call may fail silently");
  const solverSet = solvers.map(lower);
  const settlerSet = settlers.map(lower);
  const toTok = to.native ? NATIVE : to.address;
  const isFee = (c) => c && solverSet.includes(c.recipient);
  const last = readCleanup(calls[calls.length - 1], router);
  if (last.recipient !== lower(own)) throw unsafe("the last payout is not to your wallet");
  if (last.token !== toTok || (to.native ? last.kind !== "native" : last.kind !== "erc20")) throw unsafe("the last payout is not the token bought");
  if (last.amount !== 0n) throw unsafe("the last payout is not the whole balance");

  let i = 0;
  let approved = null;
  if (!native) {
    if (BigInt(calls[0].value) !== 0n) throw unsafe("a call carries value on a token swap");
    if (lower(calls[0].target) !== from.address) throw unsafe("the first call is not the sold token");
    const a = decodeStrict(calls[0].callData, "approve");
    if (lower(a.args[0]) !== ALLOWANCE_HOLDER) throw unsafe("the router approves someone other than the allowance holder");
    approved = a.args[1];
    if (approved > amountRaw) throw unsafe("the router approves more than you swap");
    i = 1;
  }
  const middle = calls.slice(i, calls.length - 1);
  let fee = null;
  let exec = null;
  if (middle.length === 2) {
    /* A: fee first (from the input), or B: exec first (fee from the output). */
    const firstIsExec = lower(middle[0].target) === ALLOWANCE_HOLDER;
    if (!firstIsExec) {
      const f = readCleanup(middle[0], router);
      if (!isFee(f)) throw unsafe("a payout goes to an address that is not the solver");
      if (f.token !== (from.native ? NATIVE : from.address)) throw unsafe("the fee before the swap is not in the sold token");
      if (f.amount <= 0n || f.amount * 10000n > amountRaw * MAX_SWAP_FEE_BPS) throw unsafe("the swap fee is over 0.5 %");
      if (BigInt(middle[0].value) !== 0n) throw unsafe("the fee call carries value");
      fee = { side: "in", token: f.token, raw: f.amount };
      exec = readExec(middle[1], { router, from, to, settlers: settlerSet, value: native ? amountRaw - f.amount : 0n });
      if (exec.amount !== amountRaw - f.amount) throw unsafe("the amount swapped is not your amount less the fee");
    } else {
      exec = readExec(middle[0], { router, from, to, settlers: settlerSet, value: native ? amountRaw : 0n });
      if (exec.amount !== amountRaw) throw unsafe("the amount swapped is not your amount");
      const f = readCleanup(middle[1], router);
      if (!isFee(f)) throw unsafe("a payout goes to an address that is not the solver");
      if (f.token !== toTok) throw unsafe("the fee after the swap is not in the token bought");
      if (f.amount <= 0n || f.amount * 10000n > exec.minAmountOut * MAX_SWAP_FEE_BPS) throw unsafe("the swap fee is over 0.5 %");
      if (BigInt(middle[1].value) !== 0n) throw unsafe("the fee call carries value");
      fee = { side: "out", token: f.token, raw: f.amount };
    }
  } else if (middle.length === 1) {
    exec = readExec(middle[0], { router, from, to, settlers: settlerSet, value: native ? amountRaw : 0n });
    if (exec.amount !== amountRaw) throw unsafe("the amount swapped is not your amount");
  } else {
    throw unsafe("the swap runs an unexpected call");
  }
  if (approved != null && approved < exec.amount) throw unsafe("the router approves less than it swaps");
  if (BigInt(calls[calls.length - 1].value) !== 0n) throw unsafe("the payout carries value");
  const minOut = fee && fee.side === "out" ? exec.minAmountOut - fee.raw : exec.minAmountOut;
  if (minOut <= 0n) throw unsafe("the minimum after the fee is nothing");
  const layout = fee ? (fee.side === "in" ? "A" : "B") : "C";
  return { layout, settler: exec.settler, minOut, fee };
}

const stepById = (steps, id) => steps.find((s) => s && s.id === id) || null;

/* One transaction item, read: the request exactly as it would be sent. */
function readTxItem(step, own) {
  if (!step || step.kind !== "transaction") throw unsafe("a swap step is not a transaction");
  if (!Array.isArray(step.items) || step.items.length !== 1) throw unsafe("a swap step has more than one item");
  const d = step.items[0] && step.items[0].data;
  if (!d || typeof d !== "object") throw unsafe("a swap step carries nothing");
  if (Number(d.chainId) !== AVAX_CHAIN_ID) throw unsafe("a swap step is for another network");
  if (!same(d.from, own)) throw unsafe("a swap step is from another wallet");
  if (!isAddr(d.to)) throw unsafe("a swap step goes nowhere");
  const value = bigOf(d.value == null ? "0" : d.value);
  if (value == null) throw unsafe("a swap step's value is unreadable");
  const gas = d.gas == null ? null : Number(d.gas);
  if (gas != null && (!Number.isSafeInteger(gas) || gas <= 0 || gas > 3_000_000)) throw unsafe("a swap step's gas is unreadable");
  const maxFee = bigOf(d.maxFeePerGas);
  return { to: lower(d.to), data: d.data, value, gas, quotedMaxFeePerGas: maxFee == null ? null : maxFee.toString(), check: step.items[0].check || null };
}

/**
 * Verify a same-chain swap /quote/v2 answer and read what the card and the two
 * windows need. Throws SwapQuoteError ("unsafe-quote" | "swap-unavailable") unless
 * the answer provably swaps exactly `amountRaw` of `from` for at least the
 * decoded minimum of `to`, paid to `own` and to nobody else.
 *
 * @param {object} json   the /quote/v2 answer
 * @param {{ own: string, from: object|string, to: object|string, amountRaw: string|bigint,
 *   slippageBps?: number|null, settlers?: string[], solvers?: string[], now?: number }} o
 *   from / to: a SWAP_TOKENS row or its address; both must be on the whitelist.
 */
export function parseSwapQuote(json, { own, from, to, amountRaw, slippageBps = null, settlers = KNOWN_SETTLERS, solvers = RELAY_SOLVERS, now = Date.now() } = {}) {
  if (!isOwnAddress(own)) throw new SwapQuoteError("bad-user", "Swaps use your FlowFlow wallet.");
  const fromT = typeof from === "object" && from ? swapTokenByAddress(from.address) : swapTokenByAddress(from);
  const toT = typeof to === "object" && to ? swapTokenByAddress(to.address) : swapTokenByAddress(to);
  if (!fromT || !toT) throw new SwapQuoteError("not-whitelisted", "Only the assets listed in your Avax Wallet can be swapped.");
  if (fromT === toT) throw new SwapQuoteError("same-asset", "Pick two different assets.");
  const amt = bigOf(amountRaw);
  if (amt == null || amt <= 0n) throw new SwapQuoteError("bad-amount", "Enter an amount to swap.");

  if (!json || typeof json !== "object") throw unsafe("no answer");
  const d = json.details || {};
  if (d.operation !== "swap") throw unsafe("the answer is not a swap");
  if (!same(d.sender, own)) throw unsafe("the sender is not your wallet");
  if (!same(d.recipient, own)) throw unsafe("the recipient is not your wallet");
  const cin = (d.currencyIn && d.currencyIn.currency) || {};
  const cout = (d.currencyOut && d.currencyOut.currency) || {};
  if (Number(cin.chainId) !== AVAX_CHAIN_ID || lower(cin.address) !== fromT.address || Number(cin.decimals) !== fromT.decimals) throw unsafe("the token sold is not the one asked for");
  if (Number(cout.chainId) !== AVAX_CHAIN_ID || lower(cout.address) !== toT.address || Number(cout.decimals) !== toT.decimals) throw unsafe("the token bought is not the one asked for");
  if (bigOf(d.currencyIn && d.currencyIn.amount) !== amt) throw unsafe("the amount sold is not your amount");
  const shownMin = bigOf(d.currencyOut && d.currencyOut.minimumAmount);
  const expected = bigOf(d.currencyOut && d.currencyOut.amount);
  if (shownMin == null || shownMin <= 0n) throw unsafe("the answer states no minimum");
  if (expected == null || expected < shownMin) throw unsafe("the expected amount is below the minimum");
  const route = d.route && d.route.origin && d.route.origin.router;
  if (route !== "0x") throw unavailable(`route ${String(route)} cannot be decoded`);
  if (slippageBps != null) {
    const total = Number(d.slippageTolerance && d.slippageTolerance.total);
    if (!Number.isFinite(total) || total > slippageBps) throw unsafe("the slippage is wider than asked");
  }
  const app = json.fees && json.fees.app;
  if (app && bigOf(app.amount) !== 0n) throw unsafe("the answer adds an app fee");

  /* The steps: exactly the ones a swap has, nothing that signs a message. */
  const steps = Array.isArray(json.steps) ? json.steps : [];
  const ids = steps.map((s) => s && s.id);
  const okIds = fromT.native ? [["swap"]] : [["approve", "swap"], ["swap"]];
  if (!okIds.some((w) => w.length === ids.length && w.every((x, k) => x === ids[k]))) {
    throw unsafe(`the steps are ${ids.join(", ") || "none"}, not a plain swap`);
  }
  if (steps.some((s) => s.kind !== "transaction")) throw unsafe("a step asks for a signature");
  const sw = readTxItem(stepById(steps, "swap"), own);
  const apStep = stepById(steps, "approve");
  const ap = apStep ? readTxItem(apStep, own) : null;

  let pair;
  let decoded;
  if (!fromT.native) {
    if (!RELAY_APPROVAL_PROXIES.includes(sw.to)) throw unsafe("the swap is not sent to the approval proxy");
    pair = relayPairOf(sw.to);
    if (sw.value !== 0n) throw unsafe("a token swap carries value");
    if (lower(String(sw.data).slice(0, 10)) !== SELECTORS.transferAndMulticall) throw unsafe("the swap is not transferAndMulticall");
    const t = decodeStrict(sw.data, "transferAndMulticall", { suffix: json.requestId });
    const [tokens, amounts, calls, refundTo, nftRecipient] = t.args;
    if (tokens.length !== 1 || lower(tokens[0]) !== fromT.address) throw unsafe("the swap pulls another token");
    if (amounts.length !== 1 || amounts[0] !== amt) throw unsafe("the swap pulls another amount");
    if (!same(refundTo, own)) throw unsafe("a refund would go to another address");
    if (!same(nftRecipient, own)) throw unsafe("the swap names another recipient");
    decoded = readSwapCalls(calls, { router: pair.router, from: fromT, to: toT, own, amountRaw: amt, solvers, settlers });
    if (ap) {
      if (ap.to !== fromT.address) throw unsafe("the approval is on another token");
      if (ap.value !== 0n) throw unsafe("the approval carries value");
      if (typeof ap.data !== "string" || ap.data.length !== 2 + 68 * 2) throw unsafe("the approval is not a plain approve");
      const a = decodeStrict(ap.data, "approve");
      if (lower(a.args[0]) !== sw.to) throw unsafe("the approval is for someone other than the swap");
      if (a.args[1] !== amt) throw unsafe("the approval is not for exactly your amount");
    }
  } else {
    /* AVAX in: rule 2. */
    if (!RELAY_ROUTERS.includes(sw.to)) throw unsafe("the AVAX swap is not sent to the router");
    pair = relayPairOf(sw.to);
    if (sw.value !== amt) throw unsafe("the AVAX sent is not your amount");
    const m = decodeStrict(sw.data, "multicall", { suffix: json.requestId });
    const [calls, refundTo, nftRecipient] = m.args;
    if (!same(refundTo, own) || !same(nftRecipient, own)) throw unavailable("an AVAX-in swap must refund to your own wallet");
    /* Live shape (q12): cleanupNative(fee, solver) → exec(value = amount − fee) → cleanupErc20s([to],[own],[0]). */
    decoded = readSwapCalls(calls, { router: pair.router, from: fromT, to: toT, own, amountRaw: amt, solvers, settlers, native: true });
    const sum = calls.reduce((s, c) => s + BigInt(c.value), 0n);
    if (sum + (decoded.fee && decoded.fee.side === "in" ? decoded.fee.raw : 0n) !== amt) throw unsafe("the AVAX sent does not add up");
  }

  /* RULE 1: the minimum on the card is the one in the calldata. */
  if (decoded.minOut !== shownMin) throw unsafe("the minimum in the transaction is not the minimum shown");

  const requestId = typeof json.requestId === "string" ? json.requestId : null;
  const tx = (s, purpose) => s && Object.freeze({
    purpose,
    chainId: AVAX_CHAIN_ID,
    from: lower(own),
    to: s.to,
    data: s.data,
    value: `0x${s.value.toString(16)}`,
    gas: s.gas,
    quotedMaxFeePerGas: s.quotedMaxFeePerGas,
  });
  const impact = Number(d.totalImpact && d.totalImpact.percent);
  return Object.freeze({
    requestId,
    own: lower(own),
    from: fromT,
    to: toT,
    amountRaw: amt.toString(),
    amount: formatRaw(amt, fromT.decimals),
    minOutRaw: decoded.minOut.toString(),
    minOut: formatRaw(decoded.minOut, toT.decimals),
    expectedOutRaw: expected.toString(),
    expectedOut: formatRaw(expected, toT.decimals),
    fee: decoded.fee ? Object.freeze({
      side: decoded.fee.side,
      raw: decoded.fee.raw.toString(),
      amount: formatRaw(decoded.fee.raw, decoded.fee.side === "in" ? fromT.decimals : toT.decimals),
      symbol: decoded.fee.side === "in" ? fromT.symbol : toT.symbol,
    }) : null,
    layout: decoded.layout,
    settler: decoded.settler,
    relay: pair.id,
    needsApprove: !!ap,
    txs: Object.freeze([tx(ap, "approve"), tx(sw, "swap")].filter(Boolean)),
    gasUnits: Object.freeze({
      approve: ap ? (ap.gas ?? null) : null,
      swap: sw.gas ?? null,
    }),
    slippageBps: Number.isFinite(Number(d.slippageTolerance && d.slippageTolerance.total)) ? Number(d.slippageTolerance.total) : null,
    impactPct: Number.isFinite(impact) ? impact : null,
    timeEstimateSec: Number.isFinite(Number(d.timeEstimate)) ? Number(d.timeEstimate) : null,
    statusEndpoint: sw.check && typeof sw.check.endpoint === "string" ? sw.check.endpoint : requestId ? `/intents/status/v3?requestId=${requestId}` : null,
    quotedAt: now,
  });
}

/** Gas units per tx for the up-front check, with the fallback when an item carries none. */
export function swapGasUnits(parsed) {
  if (!parsed) return null;
  return {
    approve: parsed.needsApprove ? (parsed.gasUnits.approve ?? SWAP_GAS_FALLBACK.approve) : 0,
    swap: parsed.gasUnits.swap ?? SWAP_GAS_FALLBACK.swap,
    estimated: parsed.gasUnits.swap == null || (parsed.needsApprove && parsed.gasUnits.approve == null),
  };
}

/**
 * The words for the two windows, from the DECODED figures only (plan §3.11
 * "หน้าต่าง Privy ใช้คำจากค่าที่ decode"). WAVAX is called "Wrapped AVAX".
 */
export function swapWindowWords(parsed) {
  if (!parsed) return null;
  const name = (t) => (t.symbol === "WAVAX" ? "Wrapped AVAX" : t.symbol);
  return Object.freeze({
    approve: parsed.needsApprove ? `Allow exactly ${parsed.amount} ${name(parsed.from)} for this swap` : null,
    swap: `Swap ${parsed.amount} ${name(parsed.from)} for at least ${parsed.minOut} ${name(parsed.to)}`,
  });
}

/* ── the Settler registry, so the trusted pair can follow 0x's rotation ──── */

/** The two read-only eth_calls that name the current and previous Settler. */
export function settlerRegistryCalls() {
  return [
    { to: SETTLER_DEPLOYER, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "ownerOf", args: [BigInt(SETTLER_FEATURE_TAKER)] }) },
    { to: SETTLER_DEPLOYER, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "prev", args: [BigInt(SETTLER_FEATURE_TAKER)] }) },
  ];
}

/**
 * The trusted Settlers from those two eth_call results (hex words). An
 * unreadable answer gives the pinned pair, never an empty list and never a guess.
 */
export function trustedSettlersFrom(results) {
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (typeof r === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(r)) {
      const a = `0x${r.slice(-40).toLowerCase()}`;
      if (a !== NATIVE && !out.includes(a)) out.push(a);
    }
  }
  return out.length ? out : [...KNOWN_SETTLERS];
}
