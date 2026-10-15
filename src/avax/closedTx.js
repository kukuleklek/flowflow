// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSED BUILDERS OF THE AVAX WALLET'S WINDOWS: what an Avalanche
// transaction or typed-data signature may be, REBUILT from the review it belongs
// to, and refused before Privy is asked when it is anything else.
// PURE: no env, no network, no React; the clock is a parameter.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
// Privy เลย". Every Avalanche transaction and every Avalanche typed-data
// signature opens Privy's VISIBLE window (PrivyBridge's shown pair) — and what
// that window is asked to sign is not the caller's request. It is what one of
// the two functions below BUILDS from the request and from the review it names:
//
//   avaxTxFromRequest(tx, check, own)
//     check { kind: "aave" }                       decodeAaveTx(tx, own) must succeed
//     check { kind: "swap", review, index }        tx == swapTxRequests(review)[index]
//     check { kind: "swap-allowance-reset", args } tx == buildRemoveAllowanceTx(args)
//     check { kind: "paid-exit", review, index }   tx == buildPaidExitTxs(review)[index]
//   avaxTypedDataFromRequest(typedData, review, own)
//     the EIP-3009 ReceiveWithAuthorization or the MulticallAuthorization that
//     parseMoveOutQuote produced for THIS review, field by field
//
// PrivyBridge runs them at the moment Privy is asked (the last gate) and
// src/avax/signers.js runs them first (so a refusal never reaches the bridge).
// Either answers null for anything else, and the signer throws AvaxSignRefused.
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. THE RECIPIENT IS `own`. Every address an approve, supply, withdraw,
//      deposit, swap payout, refund or permit names is either `own` or one of the
//      pinned contracts (Aave Pool, Relay's approval proxies / routers / Avax
//      depository, the whitelist tokens). There is no recipient parameter.
//   2. CHAIN 43114, VALUE 0. An AVAX-in swap is the only kind of transaction that
//      would carry value, and it is refused today (live answers carry refundTo =
//      0x0, swap rule 2), so every transaction here carries none.
//   3. THE FEES ARE CAPPED ON EVERY TRANSACTION: the tip at 1 gwei (gas.js
//      MAX_PRIORITY_FEE_WEI — a 500 gwei tip would burn the exit reserve,
//      ATK-15) and maxFeePerGas at 12 gwei (gas.js MAX_FEE_GWEI_NON_EXIT) unless
//      the transaction is an EXIT: an Aave withdraw, the paid exit, or a swap
//      back to USDC (swap.js swapIsExit). Exits may spend the reserve; that is
//      what it is for.
//   4. THE WORDS ARE THE DECODED ONES. The window's sentence is built here, from
//      the figures read out of what is about to be signed (lib/signCopy.js),
//      never from a caller's text.
//   5. EXITS ARE NOT CAPPED HERE. The 20 USDC cap bounds what LEAVES the Main
//      Account (plan §2.9 / §3.5 "debit ≤ MAX_MOVE_USDC", enforced on the
//      HyperCore sendAsset by signers.js + relayOut.js) and what goes INTO Aave
//      (aaveTx's own 20 USDC supply cap). A cap on the way OUT would trap money:
//      "Unstake all" of a 20 USDC stake withdraws 20 plus interest. Every exit
//      still pays only `own`.

import { decodeFunctionData, encodeFunctionData } from "viem";
import { AVAX_CHAIN_ID, USDC, USDC_DECIMALS } from "../lib/avax/config.js";
import { decodeAaveTx } from "../lib/avax/aaveTx.js";
import { GAS_LIMITS, RESERVE_FEE_WEI, MAX_PRIORITY_FEE_WEI } from "../lib/avax/gas.js";
import { SWAP_ABI, readSwapCalls, swapWindowWords, formatRaw } from "../lib/avax/swapDecode.js";
import {
  RELAY_APPROVAL_PROXIES, RELAY_V32, RELAY_SOLVERS, AVAX_DEPOSITORY, USDC_PERMIT_DOMAIN, MULTICALL_AUTH_DOMAIN, NATIVE,
  STABLE_SYMBOLS, swapTokenByAddress, relayPairOf,
} from "../lib/avax/relayPins.js";
import { swapTxRequests, buildRemoveAllowanceTx, SWAP_LIMITS } from "../lib/relay/swap.js";
import { buildPaidExitTxs, MOVE_OUT_ABI, PERMIT_MAX_VALID_S, PERMIT_CLOCK_SKEW_S } from "../lib/relay/moveOut.js";
import {
  aaveSignWords, swapSignWords, allowanceResetSignWords, paidExitSignWords, moveOutSignWords,
} from "../lib/signCopy.js";
import { readSignWords } from "../services/signWords.js";

/**
 * Thrown — by signers.js and by the Privy bridge — BEFORE Privy is asked, when a
 * request is not one the closed builders build. Nothing was sent.
 *
 * 🔴 ITS MESSAGE SAYS "Cancelled", ON PURPOSE. executeSwap reads any throw from
 * its sender that is not the user saying no as UNKNOWN ("Don't send it again"),
 * which would lock every money flow on this browser behind a move that never
 * left. A refusal here is the opposite of unknown — the wallet was never asked
 * — so it reads as the cancel it is (swap.js isRejection matches /cancel/), and
 * the card says "Cancelled. Nothing moved.", which is true.
 */
export class AvaxSignRefused extends Error {
  constructor(why = "not-built", detail = null) {
    super("Cancelled before your wallet was asked: this is not a transaction FlowFlow builds. Nothing was sent.");
    this.name = "AvaxSignRefused";
    this.code = "refused";
    this.why = why;
    this.detail = detail;
  }
}

/** The four kinds of Avalanche transaction this app sends, and nothing else. */
export const AVAX_TX_CHECKS = Object.freeze(["aave", "swap", "swap-allowance-reset", "paid-exit"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIGITS = /^[0-9]+$/;
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const isAddr = (a) => typeof a === "string" && ADDRESS_RE.test(a) && lower(a) !== NATIVE;
const isPlain = (o) => !!o && typeof o === "object" && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));
const hexQ = (n) => `0x${n.toString(16)}`;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* A quantity the way a tx carries one: bigint, safe integer, 0x-hex or decimal digits. Null otherwise. */
function qty(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^[0-9]{1,78}$/.test(v)) return BigInt(v);
  return null;
}

const rawOf = (v) => (typeof v === "string" && DIGITS.test(v) ? BigInt(v) : typeof v === "bigint" && v >= 0n ? v : null);

const isAvalanche = (c) => c === AVAX_CHAIN_ID || c === BigInt(AVAX_CHAIN_ID)
  || (typeof c === "string" && (lower(c) === "0xa86a" || c === String(AVAX_CHAIN_ID)));

/* The keys a request may carry. `purpose` is how swap.js / moveOut.js name their
   own outputs; nonce, accessList, authorizationList and the rest are refused. */
const TX_KEYS = Object.freeze(["chainId", "from", "to", "data", "value", "gasLimit", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "type", "purpose"]);
/* What aaveTx.decodeAaveTx itself accepts (it refuses `purpose`). */
const AAVE_KEYS = Object.freeze(["chainId", "from", "to", "data", "value", "gasLimit", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "type"]);

/**
 * Read a request into numbers, or null. Every common rule is here: 43114, from
 * own (when stated), type 2 (when stated), value 0, a gas limit and both fees
 * stated, readable calldata.
 */
function readRequest(tx, own) {
  if (!isPlain(tx)) return null;
  for (const k of Object.keys(tx)) if (!TX_KEYS.includes(k)) return null;
  if (!isAvalanche(tx.chainId)) return null;
  if (tx.from !== undefined && lower(tx.from) !== own) return null;
  if (tx.type !== undefined && Number(tx.type) !== 2) return null;
  if (!isAddr(tx.to)) return null;
  if (typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2}){4,}$/.test(tx.data)) return null;
  if (tx.value !== undefined && qty(tx.value) !== 0n) return null;
  const g1 = tx.gasLimit === undefined ? undefined : qty(tx.gasLimit);
  const g2 = tx.gas === undefined ? undefined : qty(tx.gas);
  if (g1 === null || g2 === null) return null;
  if (g1 !== undefined && g2 !== undefined && g1 !== g2) return null;
  const gas = g1 !== undefined ? g1 : g2;
  if (gas === undefined || gas <= 0n) return null;
  const maxFee = qty(tx.maxFeePerGas);
  const tip = qty(tx.maxPriorityFeePerGas);
  if (maxFee == null || tip == null) return null;
  if (tx.purpose !== undefined && typeof tx.purpose !== "string") return null;
  return { to: lower(tx.to), data: lower(tx.data), gas, maxFee, tip, purpose: tx.purpose };
}

/* Rule 3: the tip is capped on every tx, the fee on every tx that is not an exit. */
function feesOk(r, exit) {
  if (r.maxFee <= 0n || r.tip > r.maxFee) return false;
  if (r.tip > MAX_PRIORITY_FEE_WEI) return false;
  if (!exit && r.maxFee > RESERVE_FEE_WEI) return false;
  return true;
}

/* What Privy is handed: its own key names, hex quantities, our fields only. */
function privyTx(r, own) {
  return Object.freeze({
    chainId: AVAX_CHAIN_ID,
    from: own,
    to: r.to,
    data: r.data,
    value: "0x0",
    gasLimit: hexQ(r.gas),
    maxFeePerGas: hexQ(r.maxFee),
    maxPriorityFeePerGas: hexQ(r.tip),
  });
}

function built(kind, r, own, exit, words) {
  if (!feesOk(r, exit)) return null;
  const w = readSignWords(words);
  if (!w) return null;
  return Object.freeze({ kind, exit, tx: privyTx(r, own), words: w });
}

/* ── the four transaction kinds ───────────────────────────────────────────── */

function aaveTx(tx, r, own) {
  const req = {};
  for (const k of AAVE_KEYS) if (has(tx, k)) req[k] = tx[k];
  let d;
  try { d = decodeAaveTx(req, own); } catch { return null; }
  /* The rebuilt tx IS the request, byte for byte (decodeAaveTx's rule 4); the
     values read here are the decoder's own. */
  if (lower(d.tx.to) !== r.to || lower(d.tx.data) !== r.data || BigInt(d.tx.gasLimit) !== r.gas) return null;
  const exit = d.kind === "withdraw";
  const words = aaveSignWords({ kind: d.kind, amount: d.amountRaw != null ? formatRaw(d.amountRaw, USDC_DECIMALS) : null, all: d.all });
  return built(`aave-${d.kind}`, r, own, exit, words);
}

const APPROVE = (spender, amount) => encodeFunctionData({ abi: SWAP_ABI, functionName: "approve", args: [spender, amount] });

function swapTx(r, own, { review, index } = {}) {
  if (!review || typeof review !== "object" || review.own !== own) return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  /* The token rows are the WHITELIST's, read from the review's addresses: a
     review that names a token the whitelist does not hold, or names it with
     other decimals, is not a swap this app priced. */
  const fromT = review.from && swapTokenByAddress(review.from.address);
  const toT = review.to && swapTokenByAddress(review.to.address);
  if (!fromT || !toT || fromT === toT) return null;
  if (review.from.symbol !== fromT.symbol || review.to.symbol !== toT.symbol) return null;
  if (Number(review.from.decimals) !== fromT.decimals || Number(review.to.decimals) !== toT.decimals) return null;
  /* AVAX in carries value and live answers refund it to 0x0 (rule 2): refused today. */
  if (fromT.native) return null;
  const amt = rawOf(review.amountRaw);
  const min = rawOf(review.minOutRaw);
  if (amt == null || amt <= 0n || min == null || min <= 0n) return null;
  /* A stable sold is a dollar figure this file can read: over the swap cap is not a
     swap this app offers. Any other asset is priced by the card (an independent
     price), which holds the same cap. */
  if (STABLE_SYMBOLS.includes(fromT.symbol) && amt > BigInt(SWAP_LIMITS.maxUsd) * 10n ** BigInt(fromT.decimals)) return null;

  let list;
  try { list = swapTxRequests(review, { maxFeePerGasWei: r.maxFee, maxPriorityFeePerGasWei: r.tip }); } catch { return null; }
  if (!Array.isArray(list) || index >= list.length) return null;
  const want = list[index];
  if (r.purpose !== undefined && r.purpose !== want.purpose) return null;
  /* Byte for byte what swapTxRequests builds from the review, at the fees asked. */
  if (lower(want.from) !== own || lower(want.to) !== r.to || lower(want.data) !== r.data) return null;
  if (qty(want.value) !== 0n || qty(want.gas) !== r.gas) return null;
  if (qty(want.maxFeePerGas) !== r.maxFee || qty(want.maxPriorityFeePerGas) !== r.tip) return null;

  /* And then read again, on its own, whatever the review says: the swap call pays
     own and only own, and its minimum is the review's minimum (swap rule 1). */
  const sw = list.find((t) => t.purpose === "swap");
  if (!sw) return null;
  const proxy = lower(sw.to);
  const pair = relayPairOf(proxy);
  if (!RELAY_APPROVAL_PROXIES.includes(proxy) || !pair) return null;
  let decoded;
  try {
    const d = decodeFunctionData({ abi: SWAP_ABI, data: sw.data });
    if (d.functionName !== "transferAndMulticall") return null;
    const [tokens, amounts, calls, refundTo, nftRecipient] = d.args;
    if (tokens.length !== 1 || lower(tokens[0]) !== fromT.address || amounts.length !== 1 || amounts[0] !== amt) return null;
    if (lower(refundTo) !== own || lower(nftRecipient) !== own) return null;
    decoded = readSwapCalls(calls, { router: pair.router, from: fromT, to: toT, own, amountRaw: amt, solvers: RELAY_SOLVERS, settlers: [lower(review.settler)] });
  } catch {
    return null;
  }
  if (decoded.minOut !== min) return null;
  const approves = list.some((t) => t.purpose === "approve");
  if (want.purpose === "approve") {
    if (r.to !== fromT.address || r.data !== lower(APPROVE(proxy, amt))) return null;
  } else if (want.purpose !== "swap") {
    return null;
  }
  /* A swap back to USDC is an exit (swap.js swapIsExit), read off the whitelist rows. */
  const exit = toT.symbol === "USDC" && fromT.symbol !== "USDC";
  const ww = swapWindowWords({ needsApprove: approves, amount: formatRaw(amt, fromT.decimals), minOut: formatRaw(min, toT.decimals), from: fromT, to: toT });
  const words = swapSignWords(ww)[want.purpose];
  return built(`swap-${want.purpose}`, r, own, exit, words);
}

function allowanceResetTx(r, own, { args } = {}) {
  let want;
  try { want = buildRemoveAllowanceTx(args || {}); } catch { return null; }
  if (lower(want.to) !== r.to || lower(want.data) !== r.data || qty(want.value) !== 0n) return null;
  if (r.purpose !== undefined && r.purpose !== want.purpose) return null;
  /* An approve to 0: never more gas than an approve is sized at. */
  if (r.gas > GAS_LIMITS.swapApprove) return null;
  const t = swapTokenByAddress(want.to, { allowOff: true });
  return built("swap-allowance-reset", r, own, false, allowanceResetSignWords({ symbol: t ? t.symbol : null }));
}

function paidExitTx(r, own, { review, index } = {}) {
  if (!review || typeof review !== "object" || review.own !== own) return null;
  if (review.kind !== "move-out" || review.route !== "paid") return null;
  if (index !== 0 && index !== 1) return null;
  let list;
  try { list = buildPaidExitTxs({ own, amountRaw: review.amountRaw, orderId: review.orderId }); } catch { return null; }
  const want = list[index];
  if (r.purpose !== undefined && r.purpose !== want.purpose) return null;
  if (lower(want.to) !== r.to || lower(want.data) !== r.data || qty(want.value) !== 0n) return null;
  /* The exit reserve is sized at these limits (gas.js EXIT_GAS); a larger one could not be paid from it. */
  if (r.gas > (want.purpose === "approve" ? GAS_LIMITS.exitApprove : GAS_LIMITS.exitDeposit)) return null;
  const words = paidExitSignWords({ amount: formatRaw(rawOf(review.amountRaw), USDC_DECIMALS), minimum: review.minimumUsdc })[want.purpose];
  return built(`paid-exit-${want.purpose}`, r, own, true, words);
}

/**
 * THE CLOSED TRANSACTION BUILDER. The transaction Privy may be asked to send for
 * this request, rebuilt; or null when the request is not exactly the one the
 * check names.
 *
 * @param {object} tx     { chainId: 43114, to, data, value?, gasLimit|gas, maxFeePerGas, maxPriorityFeePerGas, from?, type?, purpose? }
 * @param {{ kind: "aave" } | { kind: "swap", review: object, index: number }
 *   | { kind: "swap-allowance-reset", args: { token, spender } } | { kind: "paid-exit", review: object, index: 0|1 }} check
 * @param {string} own    the embedded wallet's address (the only recipient)
 * @returns {Readonly<{ kind: string, exit: boolean, tx: object, words: object }>|null}
 *   tx: Privy's key names, hex quantities, chainId 43114, value 0x0 · words: the window's, from decoded values
 */
export function avaxTxFromRequest(tx, check, own) {
  if (!isAddr(own)) return null;
  const o = lower(own);
  if (!isPlain(check) || !AVAX_TX_CHECKS.includes(check.kind)) return null;
  const r = readRequest(tx, o);
  if (!r) return null;
  try {
    switch (check.kind) {
      case "aave": return aaveTx(tx, r, o);
      case "swap": return swapTx(r, o, check);
      case "swap-allowance-reset": return allowanceResetTx(r, o, check);
      case "paid-exit": return paidExitTx(r, o, check);
      default: return null;
    }
  } catch {
    return null;
  }
}

/* ── typed data: the move back to the Main Account ────────────────────────── */

const EIP712_DOMAIN_FIELDS = Object.freeze([
  ["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"],
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

const fieldList = (pairs) => pairs.map(([name, type]) => ({ name, type }));
const fieldsAre = (list, want) => Array.isArray(list) && list.length === want.length
  && list.every((f, i) => f && Object.keys(f).length === 2 && f.name === want[i][0] && f.type === want[i][1]);

/* The types a request carries: exactly `want` (by name), plus an EIP712Domain only when it is the standard one. */
function typesAre(types, want) {
  if (!isPlain(types)) return false;
  const keys = Object.keys(types).filter((k) => k !== "EIP712Domain");
  if (keys.length !== Object.keys(want).length) return false;
  if (has(types, "EIP712Domain") && !fieldsAre(types.EIP712Domain, EIP712_DOMAIN_FIELDS)) return false;
  return Object.entries(want).every(([k, fields]) => has(types, k) && fieldsAre(types[k], fields));
}

function domainIs(dom, want) {
  return !!dom && typeof dom === "object" && Object.keys(dom).length === 4 && dom.name === want.name && dom.version === want.version
    && Number(dom.chainId) === AVAX_CHAIN_ID && Number(want.chainId) === AVAX_CHAIN_ID && lower(dom.verifyingContract) === lower(want.verifyingContract);
}

const uintIs = (v, want) => { const n = qty(v); return n != null && n === want; };
const sameKeys = (o, pairs) => !!o && typeof o === "object" && Object.keys(o).length === pairs.length && pairs.every(([k]) => has(o, k));
const pick = (o, pairs) => Object.fromEntries(pairs.map(([k]) => [k, o[k]]));

/* The grant's deadline, against the user's clock: at most 600 s (+120 s skew) out, at least 30 s left. */
function windowOk(validAfter, validBefore, nowS) {
  const va = qty(validAfter);
  const vb = qty(validBefore);
  if (va == null || vb == null) return false;
  if (vb > BigInt(nowS + PERMIT_MAX_VALID_S + PERMIT_CLOCK_SKEW_S)) return false;
  if (vb < BigInt(nowS + 30)) return false;
  if (va > BigInt(nowS + PERMIT_CLOCK_SKEW_S)) return false;
  return true;
}

/* EIP-3009 ReceiveWithAuthorization on Avalanche USDC, from own, to a pinned Relay proxy, for exactly the review's amount. */
function readRwa(td, { review, own, raw, nowS, proxies }) {
  if (td.primaryType !== "ReceiveWithAuthorization") return null;
  if (!domainIs(td.domain, USDC_PERMIT_DOMAIN) || lower(USDC_PERMIT_DOMAIN.verifyingContract) !== USDC) return null;
  if (!typesAre(td.types, { ReceiveWithAuthorization: RWA_FIELDS })) return null;
  const m = td.message;
  if (!sameKeys(m, RWA_FIELDS)) return null;
  if (lower(m.from) !== own || !proxies.includes(lower(m.to))) return null;
  if (!uintIs(m.value, raw)) return null;
  if (typeof m.nonce !== "string" || lower(m.nonce) !== lower(review.permitNonce)) return null;
  if (!uintIs(m.validBefore, BigInt(review.validBefore))) return null;
  if (!windowOk(m.validAfter, m.validBefore, nowS)) return null;
  return Object.freeze({
    domain: Object.freeze({ name: USDC_PERMIT_DOMAIN.name, version: USDC_PERMIT_DOMAIN.version, chainId: AVAX_CHAIN_ID, verifyingContract: USDC }),
    types: Object.freeze({ EIP712Domain: fieldList(EIP712_DOMAIN_FIELDS), ReceiveWithAuthorization: fieldList(RWA_FIELDS) }),
    primaryType: "ReceiveWithAuthorization",
    message: Object.freeze(pick(m, RWA_FIELDS)),
  });
}

/* The calls a MulticallAuthorization may pin: [USDC.approve(Avax depository, X)]? then
   depository.depositErc20(own, USDC, X, orderId) — moveOut.js's checkMcaCalls rule, read again here. */
function mcaCallsOk(calls, { own, raw, orderId }) {
  if (typeof orderId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(orderId)) return false;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 2) return false;
  return calls.every((c, i) => {
    if (!sameKeys(c, CALL3_FIELDS) || c.allowFailure !== false || !uintIs(c.value, 0n)) return false;
    if (typeof c.callData !== "string") return false;
    let d;
    try { d = decodeFunctionData({ abi: MOVE_OUT_ABI, data: c.callData }); } catch { return false; }
    if (lower(encodeFunctionData({ abi: MOVE_OUT_ABI, functionName: d.functionName, args: d.args })) !== lower(c.callData)) return false;
    const last = i === calls.length - 1;
    if (d.functionName === "approve") {
      return !last && lower(c.target) === USDC && lower(d.args[0]) === AVAX_DEPOSITORY && d.args[1] === raw;
    }
    if (d.functionName === "depositErc20") {
      return last && lower(c.target) === AVAX_DEPOSITORY && lower(d.args[0]) === own && lower(d.args[1]) === USDC
        && d.args[2] === raw && lower(d.args[3]) === lower(orderId);
    }
    return false;
  });
}

function readMca(td, { review, own, raw, nowS }) {
  if (td.primaryType !== "MulticallAuthorization") return null;
  if (!domainIs(td.domain, MULTICALL_AUTH_DOMAIN) || lower(MULTICALL_AUTH_DOMAIN.verifyingContract) !== RELAY_V32.approvalProxy) return null;
  if (!typesAre(td.types, { MulticallAuthorization: MCA_FIELDS, Call3Value: CALL3_FIELDS, FundingAuthorization: FUNDING_FIELDS })) return null;
  const m = td.message;
  if (!sameKeys(m, MCA_FIELDS)) return null;
  if (lower(m.from) !== own || lower(m.refundTo) !== own) return null;
  if (!(lower(m.nftRecipient) === own || lower(m.nftRecipient) === NATIVE)) return null;
  if (!ADDRESS_RE.test(String(m.relayer)) || !uintIs(m.msgValue, 0n) || !uintIs(m.fundingIndex, 0n)) return null;
  if (typeof m.metadata !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(m.metadata)) return null;
  const f = Array.isArray(m.funding) && m.funding.length === 1 ? m.funding[0] : null;
  if (!sameKeys(f, FUNDING_FIELDS) || lower(f.token) !== USDC || lower(f.from) !== own || !uintIs(f.value, raw)) return null;
  if (!windowOk(f.validAfter, f.validBefore, nowS)) return null;
  if (!mcaCallsOk(m.calls, { own, raw, orderId: review.orderId })) return null;
  return Object.freeze({
    domain: Object.freeze({ ...pick(MULTICALL_AUTH_DOMAIN, EIP712_DOMAIN_FIELDS), chainId: AVAX_CHAIN_ID }),
    types: Object.freeze({
      EIP712Domain: fieldList(EIP712_DOMAIN_FIELDS), MulticallAuthorization: fieldList(MCA_FIELDS),
      Call3Value: fieldList(CALL3_FIELDS), FundingAuthorization: fieldList(FUNDING_FIELDS),
    }),
    primaryType: "MulticallAuthorization",
    message: Object.freeze({
      ...pick(m, MCA_FIELDS),
      calls: m.calls.map((c) => Object.freeze(pick(c, CALL3_FIELDS))),
      funding: [Object.freeze(pick(f, FUNDING_FIELDS))],
    }),
  });
}

/* A stable text of a typed data, for "the request is the review's own" (bigints as text). */
const stable = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x));

/**
 * THE CLOSED TYPED-DATA BUILDER. The typed data Privy may be asked to sign for
 * this move back to the Main Account — rebuilt from the request, which must be
 * one of the signatures parseMoveOutQuote produced for THIS review, field by
 * field — or null.
 *
 * @param {object} typedData { domain, types, primaryType, message } as executeMoveOut hands it over
 * @param {object} review    the permit review (lib/relay/moveOut.js parseMoveOutQuote)
 * @param {string} own       the embedded wallet's address
 * @param {{ now?: number }} [o]
 * @returns {Readonly<{ kind: "eip3009"|"multicall-authorization", typedData: object, words: object }>|null}
 */
export function avaxTypedDataFromRequest(typedData, review, own, { now = Date.now() } = {}) {
  if (!isAddr(own)) return null;
  const o = lower(own);
  if (!typedData || typeof typedData !== "object" || Array.isArray(typedData)) return null;
  if (!review || typeof review !== "object" || review.kind !== "move-out" || review.route !== "permit" || review.own !== o) return null;
  const sigs = Array.isArray(review.signatures) ? review.signatures : null;
  if (!sigs || sigs.length < 1 || sigs.length > 2) return null;
  const raw = rawOf(review.amountRaw);
  if (raw == null || raw <= 0n || !Number.isSafeInteger(review.validBefore)) return null;
  const nowS = Math.floor(Number(now) / 1000);
  if (!Number.isFinite(nowS)) return null;

  /* Which of the review's own signatures this is, by its place: the call
     authorization comes FIRST and only with two (v3.2); the USDC authorization is
     always LAST, and with two it must name the v3.2 proxy, alone never (ATK-05). */
  const index = sigs.findIndex((s) => s && s.typedData && s.typedData.primaryType === typedData.primaryType);
  if (index < 0) return null;
  const last = index === sigs.length - 1;
  const ctx = { review, own: o, raw, nowS };
  let mine;
  let theirs;
  if (last) {
    const proxies = sigs.length === 2 ? [RELAY_V32.approvalProxy] : RELAY_APPROVAL_PROXIES.filter((p) => p !== RELAY_V32.approvalProxy);
    mine = readRwa(typedData, { ...ctx, proxies });
    theirs = readRwa(sigs[index].typedData, { ...ctx, proxies });
  } else {
    mine = readMca(typedData, ctx);
    theirs = readMca(sigs[index].typedData, ctx);
  }
  /* Both readable, and the request is the review's own signature — not another
     review's, not the same shape for another amount, nonce or deadline. */
  if (!mine || !theirs || stable(mine) !== stable(theirs)) return null;
  const words = moveOutSignWords({ amount: formatRaw(raw, USDC_DECIMALS), minimum: review.minimumUsdc });
  const w = readSignWords(last ? words.permit : words.authorize);
  if (!w) return null;
  return Object.freeze({ kind: last ? "eip3009" : "multicall-authorization", typedData: mine, words: w });
}
