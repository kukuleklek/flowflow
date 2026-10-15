// ─────────────────────────────────────────────────────────────────────────────
// The READ-ONLY helpers every Avalanche money run needs around a wallet window:
// simulate the tx from the user's own address before its window opens, wait for
// its receipt after, read the pending nonce the registry writes down, and ask
// USDC whether a permit nonce was used. Built on rpc.js, which cannot send.
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §3.2 step 7 ("eth_call preflight จาก own"), §3.6 (pending nonce,
// authorizationState), §3.11 Run (receipt 30 s, preflight before the swap window).
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. NOTHING HERE SENDS. Every call is one of rpc.js's READ_METHODS (eth_call,
//      eth_getTransactionReceipt, eth_getTransactionByHash, eth_getTransactionCount). Sending is the visible
//      Privy window's job (src/avax/signers.js), after a Confirm.
//   2. UNKNOWN IS NULL, NEVER A YES. A receipt that cannot be read in time is null
//      ("not confirmed"), never "failed" and never "done"; a nonce or permit state
//      that cannot be read is null, never 0 / false. A preflight whose CHECK failed
//      is { ok: false } — no window opens on a simulation nobody could run.
//   3. THE SIMULATION RUNS FROM `own`. A tx that names any other sender is refused
//      before the network is asked.
//   4. EVERY WAIT ENDS. waitReceipt has a hard timeout; each read has rpc.js's own.

import { ethCall, avaxRpc, getPendingNonce, getLatestNonce, getTxNonce, hexToBigInt, toHexQuantity, AvaxRpcError } from "./rpc.js";
import { aaveRevertText } from "./aave/v3.js";
import { decodeRevert } from "./abi.js";
import { AAVE_V3, USDC } from "./config.js";
import { authorizationStateCall, readAuthorizationState } from "../relay/moveOut.js";
import { isEvmAddress, sameAddress } from "../relay/depositAddress.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";

/** How long a run waits for one tx's receipt before it says "not confirmed" (plan §3.11: 30 s; Avalanche blocks are ~2 s). */
export const RECEIPT_TIMEOUT_MS = 90_000;
/** Between two receipt reads. */
export const RECEIPT_POLL_MS = 2_000;

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const lower = (a) => String(a == null ? "" : a).toLowerCase();

/* bigint | number | hex | decimal string → a JSON-RPC quantity, or null. */
function qtyHex(v) {
  try {
    if (v == null) return "0x0";
    if (typeof v === "bigint") return toHexQuantity(v);
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return toHexQuantity(BigInt(v));
    if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return toHexQuantity(BigInt(v));
    if (typeof v === "string" && /^[0-9]+$/.test(v)) return toHexQuantity(BigInt(v));
  } catch { /* not a quantity */ }
  return null;
}

/* Plain words for a revert, from the contract it was sent to. */
function revertWords(to, data) {
  if (sameAddress(to, AAVE_V3.pool) || sameAddress(to, USDC)) return aaveRevertText(data).text;
  const { message } = decodeRevert(data);
  if (message && /exceeds allowance/i.test(message)) return "The allowance is too low for this right now";
  if (message && /exceeds balance/i.test(message)) return "Not enough in your Spot Account for this";
  return "This would fail on Avalanche right now";
}

/**
 * Simulate `tx` (eth_call at latest) FROM `own`, before its window opens.
 * Resolves (never throws):
 *   { ok: true }                                   it would go through now
 *   { ok: false, reverted: true, text }            the contract would refuse it: no window
 *   { ok: false, reverted: false, text }           the check itself failed: no window either
 *
 * @param {{ to: string, data: string, value?: any, from?: string }} tx
 * @param {string} own the user's own address (lowercase or checksummed)
 * @param {{ fetchImpl?, timers?, signal? }} [opts]
 */
export async function preflightTx(tx, own, opts = {}) {
  if (!isEvmAddress(own)) return { ok: false, reverted: false, text: "Sign in first" };
  if (!tx || typeof tx !== "object" || !isEvmAddress(tx.to) || typeof tx.data !== "string") {
    return { ok: false, reverted: false, text: "Not a transaction this app builds" };
  }
  /* 🔴 The simulation is FROM own, and a tx naming another sender is not simulated at all. */
  if (tx.from != null && !sameAddress(tx.from, own)) return { ok: false, reverted: false, text: "The sender is not your own wallet" };
  const value = qtyHex(tx.value);
  if (value == null) return { ok: false, reverted: false, text: "The amount of AVAX is not readable" };
  try {
    await ethCall({ from: lower(own), to: lower(tx.to), data: tx.data, value }, opts);
    return { ok: true };
  } catch (e) {
    if (e instanceof AvaxRpcError && e.code === "reverted") {
      return { ok: false, reverted: true, text: revertWords(tx.to, e.detail && e.detail.data) };
    }
    return { ok: false, reverted: false, text: "Couldn't check this with Avalanche" };
  }
}

/**
 * One receipt read. Resolves { status: 0|1, blockNumber, gasUsed, effectiveGasPrice }
 * once mined, null while not mined (or unreadable). Never throws.
 */
export async function readReceipt(hash, opts = {}) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
  let r;
  try { r = await avaxRpc("eth_getTransactionReceipt", [lower(hash)], opts); } catch { return null; }
  if (!r || typeof r !== "object") return null;
  let status;
  try { status = Number(hexToBigInt(r.status)); } catch { return null; }
  if (status !== 0 && status !== 1) return null;
  const big = (v) => { try { return hexToBigInt(v); } catch { return null; } };
  return Object.freeze({ status, blockNumber: big(r.blockNumber), gasUsed: big(r.gasUsed), effectiveGasPrice: big(r.effectiveGasPrice) });
}

/**
 * Wait for `hash`'s receipt. Resolves the receipt ({ status }) or null when none came
 * within timeoutMs — null is "not confirmed yet", never "failed". Never throws.
 * @param {string} hash
 * @param {{ timeoutMs?: number, pollMs?: number, now?: () => number, timers?: object, fetchImpl?: Function, signal?: AbortSignal }} [o]
 */
export async function waitReceipt(hash, { timeoutMs = RECEIPT_TIMEOUT_MS, pollMs = RECEIPT_POLL_MS, now = browserNow, timers = browserTimers, ...opts } = {}) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
  const until = now() + Math.max(0, Number(timeoutMs) || 0);
  const sleep = (ms) => new Promise((resolve) => { timers.setTimeout(resolve, ms); });
  for (;;) {
    if (opts.signal && opts.signal.aborted) return null;
    const r = await readReceipt(hash, { ...opts, timers });
    if (r) return r;
    if (now() >= until) return null;
    await sleep(Math.max(1, Math.min(pollMs, until - now())));
  }
}

/** The pending nonce of `own` (what its next tx will use) as a BigInt, or null when unreadable. Never throws. */
export async function readPendingNonce(own, opts = {}) {
  if (!isEvmAddress(own)) return null;
  try { return await getPendingNonce(lower(own), opts); } catch { return null; }
}

/** The LATEST (mined) nonce of `own` as a BigInt, or null when unreadable. Never throws. */
export async function readLatestNonce(own, opts = {}) {
  if (!isEvmAddress(own)) return null;
  try { return await getLatestNonce(lower(own), opts); } catch { return null; }
}

/** The nonce `hash` was sent with, as a BigInt, or null when unknown / unreadable. Never throws. */
export async function readTxNonce(hash, opts = {}) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
  try { return await getTxNonce(lower(hash), opts); } catch { return null; }
}

const asBig = (v) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
};

/**
 * 🔴 IS THIS HASH THE ONE TX OF ITS WINDOW? Privy's send window, when its own receipt wait
 * fails after a broadcast, offers "Retry transaction" — which sends AGAIN with a new nonce
 * and, when the window closes, hands back only the LAST hash. So a hash in hand (with its
 * receipt) proves only itself. It is bound to the window when it was sent at the nonce
 * written before that window, and nothing past that nonce was mined.
 *   "ok"       hashNonce == txNonce (when read) and latestNonce ≤ txNonce + 1 (when read), and at least one was read
 *   "other"    another tx went out from this window: the outcome is UNKNOWN, never "nothing moved", never "done once"
 *   "unknown"  neither could be read, or no nonce was written: not bound — the outcome is unknown too
 * @param {{ txNonce: number|bigint|null, hashNonce: bigint|number|null, latestNonce: bigint|number|null }} p
 */
export function nonceBinding({ txNonce = null, hashNonce = null, latestNonce = null } = {}) {
  const n = asBig(txNonce);
  if (n == null) return "unknown";
  const h = asBig(hashNonce);
  const l = asBig(latestNonce);
  if (h != null && h !== n) return "other";
  if (l != null && l > n + 1n) return "other";
  return h == null && l == null ? "unknown" : "ok";
}

/**
 * Was this EIP-3009 permit nonce used on Avalanche USDC? true / false, or null when it
 * could not be read (null is never "unused": a new permit needs a real false, plan §3.6).
 */
export async function readPermitUsed({ own, nonce }, opts = {}) {
  const call = authorizationStateCall({ own, nonce });
  if (!call) return null;
  try { return readAuthorizationState(await ethCall(call, opts)); } catch { return null; }
}
