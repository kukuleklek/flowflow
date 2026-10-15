// ─────────────────────────────────────────────────────────────────────────────
// The ONLY Aave transactions FlowFlow will build on Avalanche, and the decoder
// that refuses every other shape before a wallet window could open.
// ─────────────────────────────────────────────────────────────────────────────
//
//   approve           USDC.approve(Pool, amount)            EXACT amount, never unlimited
//   remove-allowance  USDC.approve(Pool, 0)
//   supply            Pool.supply(USDC, amount, own, 0)
//   withdraw          Pool.withdraw(USDC, amount | MAX, own)
//
// R-aave §5–§7, plan §3.2 / §3.3 / §3.8.5. Nothing here signs or sends: a
// builder returns an UNSIGNED tx object for the visible Privy sender (after the
// gate: PrivyBridge's closed builder `avaxTxFromRequest` runs decodeAaveTx on
// the request and sends the REBUILT tx, never the request itself).
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. THE ADDRESS ARGUMENTS ARE THE OWN ADDRESS. In Aave V3 `onBehalfOf`
//      (supply) and `to` (withdraw) are FREE addresses: a wrong value gives the
//      deposit away. Both are written from `own` (lib/avax/own.js, re-read by
//      the caller just before) and decodeAaveTx refuses any other value.
//   2. NO UNLIMITED APPROVAL. approve is the exact amount being supplied, at
//      most the hard supply cap; MAX_UINT256 or anything ≥ 2^128 is refused.
//   3. CHAIN 43114, VALUE 0, AND THE FEES ARE STATED. A tx without gasLimit /
//      maxFeePerGas does not exist here. approve and supply are not exits and
//      are refused above 12 gwei; withdraw is the exit and is not. The tip is
//      never above the 1 gwei lib/avax/gas.js sets — on ANY tx, exits included: a
//      500 gwei tip would burn the AVAX reserve the exit is for (ATK-15).
//   4. CANONICAL BYTES. decodeAaveTx rebuilds the calldata from what it decoded
//      and requires byte equality, so dirty address bits, a non-zero referral or
//      trailing data are refused, not tolerated.
//   5. UNKNOWN KEYS ARE REFUSED (accessList, authorizationList, …).

import { AVAX_CHAIN_ID, AAVE_V3, USDC, USDC_DECIMALS } from "./config.js";
import { addressWord, uintWord, strip0x, wordAt, wordToUint, wordToAddress, MAX_UINT256, AbiError } from "./abi.js";
import { SEL, aaveRevertText } from "./aave/v3.js";
import { GAS_LIMITS, RESERVE_FEE_WEI, MAX_PRIORITY_FEE_WEI } from "./gas.js";
import { ethCall, toHexQuantity, AvaxRpcError } from "./rpc.js";
import { fromRaw } from "./units.js";
import { isEvmAddress, sameAddress } from "../relay/depositAddress.js";

/** Hard ceiling on one supply / approve: 20 USDC (plan §2.9 HARD.stakeUsdc; env may lower, never raise). */
export const AAVE_SUPPLY_HARD_CAP_RAW = 20n * 10n ** BigInt(USDC_DECIMALS);
/** Anything this large is an "unlimited" approval in disguise. */
const UNLIMITED_FLOOR = 1n << 128n;
/** No Aave tx may ask for more gas than this (all real ones are under 300k). */
export const AAVE_MAX_GAS_LIMIT = 600000n;

export const AAVE_TX_KINDS = Object.freeze(["approve", "remove-allowance", "supply", "withdraw"]);

export class AaveTxError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "AaveTxError";
    this.code = code;
    this.detail = detail;
  }
}

const refuse = (code, message, detail) => { throw new AaveTxError(code, message, detail); };

/* ── fees ─────────────────────────────────────────────────────────────────── */

function checkFees(fees, { exit }) {
  if (!fees || typeof fees.maxFeePerGas !== "bigint" || typeof fees.maxPriorityFeePerGas !== "bigint") {
    refuse("no-fees", "The network fee is not known yet");
  }
  const { maxFeePerGas, maxPriorityFeePerGas } = fees;
  if (maxFeePerGas <= 0n || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas) refuse("bad-fees", "The network fee is not valid");
  if (maxPriorityFeePerGas > MAX_PRIORITY_FEE_WEI) refuse("bad-fees", "The network fee is not valid", { tipWei: maxPriorityFeePerGas.toString() });
  if (!exit && maxFeePerGas > RESERVE_FEE_WEI) refuse("fee-high", "Avalanche fees are high right now. Try again in a few minutes.");
  return { maxFeePerGas, maxPriorityFeePerGas };
}

function tx({ own, to, data, gasLimit, fees }) {
  return Object.freeze({
    chainId: AVAX_CHAIN_ID,
    from: own,
    to,
    data,
    value: "0x0",
    gasLimit: toHexQuantity(gasLimit),
    maxFeePerGas: toHexQuantity(fees.maxFeePerGas),
    maxPriorityFeePerGas: toHexQuantity(fees.maxPriorityFeePerGas),
  });
}

function ownOf(own) {
  if (!isEvmAddress(own)) refuse("no-own", "Sign in first");
  return own.toLowerCase();
}

function supplyAmount(amountRaw) {
  if (typeof amountRaw !== "bigint" || amountRaw <= 0n) refuse("bad-amount", "Enter an amount");
  if (amountRaw > AAVE_SUPPLY_HARD_CAP_RAW) refuse("over-cap", "Over the most FlowFlow puts into Aave at once", { amountRaw: amountRaw.toString() });
  return amountRaw;
}

/* ── calldata ─────────────────────────────────────────────────────────────── */

const approveData = (amountRaw) => `${SEL.approve}${addressWord(AAVE_V3.pool)}${uintWord(amountRaw)}`;
const supplyData = (own, amountRaw) => `${SEL.supply}${addressWord(USDC)}${uintWord(amountRaw)}${addressWord(own)}${uintWord(0n)}`;
const withdrawData = (own, amountRaw) => `${SEL.withdraw}${addressWord(USDC)}${uintWord(amountRaw)}${addressWord(own)}`;

/* ── builders ─────────────────────────────────────────────────────────────── */

/** USDC.approve(Pool, amountRaw): the exact supply amount, 0 < amount ≤ hard cap. */
export function buildApproveTx({ own, amountRaw, fees }) {
  const o = ownOf(own);
  const amt = supplyAmount(amountRaw);
  return tx({ own: o, to: USDC, data: approveData(amt), gasLimit: GAS_LIMITS.approve, fees: checkFees(fees, { exit: false }) });
}

/** USDC.approve(Pool, 0): take back an allowance that was not used. Allowed at any fee level. */
export function buildRemoveAllowanceTx({ own, fees }) {
  const o = ownOf(own);
  return tx({ own: o, to: USDC, data: approveData(0n), gasLimit: GAS_LIMITS.approve, fees: checkFees(fees, { exit: true }) });
}

/** Pool.supply(USDC, amountRaw, own, 0). */
export function buildSupplyTx({ own, amountRaw, fees }) {
  const o = ownOf(own);
  const amt = supplyAmount(amountRaw);
  return tx({ own: o, to: AAVE_V3.pool, data: supplyData(o, amt), gasLimit: GAS_LIMITS.supply, fees: checkFees(fees, { exit: false }) });
}

/** Pool.withdraw(USDC, amountRaw | MAX, own). `amountRaw: "max"` withdraws everything. The exit: any fee level. */
export function buildWithdrawTx({ own, amountRaw, fees }) {
  const o = ownOf(own);
  const all = amountRaw === "max";
  if (!all && (typeof amountRaw !== "bigint" || amountRaw <= 0n || amountRaw >= MAX_UINT256)) refuse("bad-amount", "Enter an amount");
  const amt = all ? MAX_UINT256 : amountRaw;
  return tx({ own: o, to: AAVE_V3.pool, data: withdrawData(o, amt), gasLimit: GAS_LIMITS.withdraw, fees: checkFees(fees, { exit: true }) });
}

/** Does a supply of `amountRaw` need an approve first? null when the allowance is unknown. */
export function needsApprove(allowanceRaw, amountRaw) {
  if (typeof allowanceRaw !== "bigint" || typeof amountRaw !== "bigint") return null;
  return allowanceRaw < amountRaw;
}

/**
 * The supply step's txs in order: [approve?, supply]. Refuses while the
 * allowance is unknown (it must be read immediately before).
 */
export function buildSupplySteps({ own, amountRaw, allowanceRaw, fees }) {
  const need = needsApprove(allowanceRaw, amountRaw);
  if (need == null) refuse("loading", "Still loading");
  const steps = [];
  if (need) steps.push({ kind: "approve", tx: buildApproveTx({ own, amountRaw, fees }) });
  steps.push({ kind: "supply", tx: buildSupplyTx({ own, amountRaw, fees }) });
  return steps;
}

/* ── the allow-list decoder ───────────────────────────────────────────────── */

const ALLOWED_KEYS = new Set(["chainId", "from", "to", "data", "value", "gasLimit", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "type"]);

function qty(v, field) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return refuse("bad-field", `The ${field} is not a number`, { field });
}

/**
 * Decode a tx request and accept it ONLY if it is one of the four shapes above,
 * for `own`, on 43114, value 0, with its fees stated.
 *
 * Returns { kind, amountRaw, all, tx } where `tx` is the REBUILT canonical tx
 * (the thing to send). Throws AaveTxError for anything else.
 */
export function decodeAaveTx(request, own) {
  const o = ownOf(own);
  if (!request || typeof request !== "object" || Array.isArray(request)) refuse("bad-tx", "Not a transaction");
  for (const k of Object.keys(request)) if (!ALLOWED_KEYS.has(k)) refuse("bad-key", `Unexpected field ${k}`, { key: k });

  const chain = request.chainId;
  const chainOk = chain === AVAX_CHAIN_ID || chain === BigInt(AVAX_CHAIN_ID) || (typeof chain === "string" && chain.toLowerCase() === "0xa86a");
  if (!chainOk) refuse("wrong-chain", "Not an Avalanche transaction", { chainId: chain ?? null });
  if (request.value !== undefined && qty(request.value, "value") !== 0n) refuse("value", "This must not send AVAX");
  if (request.from !== undefined && !sameAddress(request.from, o)) refuse("not-own", "The sender is not your own wallet");
  if (request.type !== undefined && Number(request.type) !== 2) refuse("bad-type", "Unexpected transaction type");

  const gasIn = request.gasLimit !== undefined ? request.gasLimit : request.gas;
  if (gasIn === undefined || request.maxFeePerGas === undefined || request.maxPriorityFeePerGas === undefined) {
    refuse("no-fees", "The network fee is not stated");
  }
  const gasLimit = qty(gasIn, "gasLimit");
  if (gasLimit <= 0n || gasLimit > AAVE_MAX_GAS_LIMIT) refuse("bad-gas", "The gas limit is out of range", { gasLimit: gasLimit.toString() });
  const fees = { maxFeePerGas: qty(request.maxFeePerGas, "maxFeePerGas"), maxPriorityFeePerGas: qty(request.maxPriorityFeePerGas, "maxPriorityFeePerGas") };

  let body;
  try { body = strip0x(request.data); } catch { refuse("bad-data", "The call is not readable"); }
  if (body.length < 8) refuse("bad-data", "The call is not readable");
  const sel = `0x${body.slice(0, 8)}`;
  const args = body.slice(8);
  const word = (i) => {
    try { return wordAt(args, i); } catch { return refuse("bad-data", "The call is not readable"); }
  };
  const addr = (i, field) => {
    try { return wordToAddress(word(i)); } catch { return refuse("bad-data", `The ${field} is not an address`); }
  };

  let decoded;
  if (sameAddress(request.to, USDC) && sel === SEL.approve) {
    if (args.length !== 2 * 64) refuse("bad-data", "The call is not readable");
    const spender = addr(0, "spender");
    if (!sameAddress(spender, AAVE_V3.pool)) refuse("bad-spender", "The allowance is not for Aave", { spender });
    const amt = wordToUint(word(1));
    if (amt >= UNLIMITED_FLOOR) refuse("unlimited", "Unlimited allowances are not allowed");
    if (amt === 0n) decoded = { kind: "remove-allowance", amountRaw: 0n, all: false, tx: buildRemoveAllowanceTx({ own: o, fees }) };
    else decoded = { kind: "approve", amountRaw: amt, all: false, tx: buildApproveTx({ own: o, amountRaw: amt, fees }) };
  } else if (sameAddress(request.to, AAVE_V3.pool) && sel === SEL.supply) {
    if (args.length !== 4 * 64) refuse("bad-data", "The call is not readable");
    if (!sameAddress(addr(0, "asset"), USDC)) refuse("bad-asset", "Only USDC goes into Aave here");
    const amt = wordToUint(word(1));
    if (!sameAddress(addr(2, "onBehalfOf"), o)) refuse("not-own", "The deposit is not for your own wallet");
    if (wordToUint(word(3)) !== 0n) refuse("bad-data", "Unexpected referral code");
    decoded = { kind: "supply", amountRaw: amt, all: false, tx: buildSupplyTx({ own: o, amountRaw: amt, fees }) };
  } else if (sameAddress(request.to, AAVE_V3.pool) && sel === SEL.withdraw) {
    if (args.length !== 3 * 64) refuse("bad-data", "The call is not readable");
    if (!sameAddress(addr(0, "asset"), USDC)) refuse("bad-asset", "Only USDC comes out of Aave here");
    const amt = wordToUint(word(1));
    if (!sameAddress(addr(2, "to"), o)) refuse("not-own", "The withdrawal is not to your own wallet");
    const all = amt === MAX_UINT256;
    decoded = { kind: "withdraw", amountRaw: all ? null : amt, all, tx: buildWithdrawTx({ own: o, amountRaw: all ? "max" : amt, fees }) };
  } else {
    refuse("not-allowed", "FlowFlow does not send this", { to: request.to ?? null, selector: sel });
  }

  /* Canonical bytes: what we would build from the decoded values must be what was asked,
     down to the gas limit (the reserve maths assumes GAS_LIMITS, so nothing else is sent). */
  if (decoded.tx.data !== `0x${body}`) refuse("not-canonical", "The call carries extra or unexpected bytes");
  if (BigInt(decoded.tx.gasLimit) !== gasLimit) {
    refuse("bad-gas", "The gas limit is not the one FlowFlow sets", { gasLimit: gasLimit.toString() });
  }
  return Object.freeze(decoded);
}

/* ── words for the card and the window ────────────────────────────────────── */

/** Plain words for a decoded Aave tx, from the DECODED values only. */
export function aaveTxSummary(decoded) {
  if (!decoded) return null;
  const usdc = decoded.amountRaw != null ? fromRaw(decoded.amountRaw, USDC_DECIMALS) : null;
  switch (decoded.kind) {
    case "approve": return `Allow exactly ${usdc} USDC for Aave`;
    case "remove-allowance": return "Remove the USDC allowance for Aave";
    case "supply": return `Supply ${usdc} USDC to Aave on Avalanche`;
    case "withdraw": return decoded.all ? "Withdraw all your USDC from Aave" : `Withdraw ${usdc} USDC from Aave`;
    default: return null;
  }
}

/* ── preflight (eth_call from own: read-only) ─────────────────────────────── */

/**
 * Simulate the tx from `own` before its window opens. Resolves
 *   { ok: true }                         it would go through now
 *   { ok: false, reverted: true, name, text }   Aave (or USDC) would refuse it: no window
 *   { ok: false, reverted: false, text }  the check itself failed: no window either
 * The request is decoded first, so only an allowed shape is ever simulated.
 */
export async function preflightAaveTx(request, own, opts = {}) {
  const d = decodeAaveTx(request, own);
  try {
    await ethCall({ from: d.tx.from, to: d.tx.to, data: d.tx.data, value: 0n }, opts);
    return { ok: true };
  } catch (e) {
    if (e instanceof AvaxRpcError && e.code === "reverted") {
      const { name, text } = aaveRevertText(e.detail && e.detail.data);
      return { ok: false, reverted: true, name, text };
    }
    if (e instanceof AbiError || e instanceof AvaxRpcError) return { ok: false, reverted: false, text: "Couldn't check this with Avalanche" };
    throw e;
  }
}
