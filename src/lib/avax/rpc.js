// ─────────────────────────────────────────────────────────────────────────────
// A tiny, READ-ONLY JSON-RPC client for Avalanche C-Chain.
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. IT CANNOT SEND. Only the read methods in READ_METHODS are ever put on the
//      wire; eth_sendRawTransaction, eth_sendTransaction, eth_sign… throw before
//      a request is made. Sending is the Privy wallet's job, after a Confirm.
//   2. AN UNREADABLE ANSWER THROWS. A timeout, a non-2xx, a JSON-RPC error or a
//      result of the wrong shape is an AvaxRpcError, never a 0 or an empty
//      balance (docs/MONEY_RULES.md §0: unknown is null, never 0).
//   3. EVERY CALL HAS A TIMEOUT (RPC_TIMEOUT_MS) and honours the caller's signal.
//
// Nothing runs at import time; fetch and timers are injected so the node tests
// drive it with fixtures and no network.

import { AVAX_RPC, AVAX_CHAIN_ID, AVAX_CHAIN_ID_HEX } from "./config.js";
import { browserTimers } from "../hyperliquid/browser.js";

export const RPC_TIMEOUT_MS = 12000;

/** The only methods this client will ever put on the wire. */
export const READ_METHODS = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_call",
  "eth_estimateGas",
]);

const HEX_QTY_RE = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const HEX_DATA_RE = /^0x([0-9a-fA-F]{2})*$/;

export class AvaxRpcError extends Error {
  /**
   * @param {"method-not-allowed"|"network"|"timeout"|"http"|"rpc-error"|"bad-response"|"reverted"|"wrong-chain"} code
   */
  constructor(code, message, detail = null) {
    super(message);
    this.name = "AvaxRpcError";
    this.code = code;
    this.detail = detail;
  }
}

/** A JSON-RPC quantity ("0x1a") as a BigInt. Throws on anything else ("", "0x", "0x01", numbers). */
export function hexToBigInt(q) {
  if (typeof q !== "string" || !HEX_QTY_RE.test(q)) {
    throw new AvaxRpcError("bad-response", "The network's answer was not a number", { value: q });
  }
  return BigInt(q);
}

/** A non-negative BigInt as a JSON-RPC quantity. */
export function toHexQuantity(n) {
  if (typeof n !== "bigint" || n < 0n) throw new AvaxRpcError("bad-response", "Not a quantity", { value: String(n) });
  return `0x${n.toString(16)}`;
}

/** Is this 0x-prefixed, whole-byte hex data? */
export function isHexData(d) {
  return typeof d === "string" && HEX_DATA_RE.test(d);
}

function allowed(method) {
  if (!READ_METHODS.includes(method)) {
    throw new AvaxRpcError("method-not-allowed", `This client only reads; ${String(method)} is not allowed`, { method });
  }
}

/* Revert data out of a JSON-RPC error, when the node gave it. */
function revertData(err) {
  const d = err && (err.data && typeof err.data === "object" ? err.data.data : err.data);
  return isHexData(d) ? d : null;
}

async function post(body, { fetchImpl, timers, signal, timeoutMs, url }) {
  if (typeof fetchImpl !== "function") throw new AvaxRpcError("network", "No way to reach the network here");
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const guard = ctrl ? timers.setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  const onAbort = () => ctrl && ctrl.abort();
  if (signal && ctrl) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    if (timedOut) throw new AvaxRpcError("timeout", "Avalanche took too long to answer");
    throw new AvaxRpcError("network", "Couldn't reach Avalanche", { cause: String((e && e.message) || e) });
  } finally {
    if (guard != null) timers.clearTimeout(guard);
    if (signal && ctrl) signal.removeEventListener("abort", onAbort);
  }
  if (!res || !res.ok) throw new AvaxRpcError("http", "Avalanche's answer was not readable", { status: res ? res.status : null });
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  if (json === undefined || json === null) throw new AvaxRpcError("bad-response", "Avalanche's answer was not readable");
  return json;
}

function unwrap(json, method) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new AvaxRpcError("bad-response", "Avalanche's answer was not readable", { method });
  }
  if (json.error) {
    const data = revertData(json.error);
    const msg = typeof json.error.message === "string" ? json.error.message : "error";
    if (data !== null || /revert/i.test(msg)) throw new AvaxRpcError("reverted", msg, { method, data });
    throw new AvaxRpcError("rpc-error", msg, { method, code: json.error.code ?? null });
  }
  if (!Object.prototype.hasOwnProperty.call(json, "result")) {
    throw new AvaxRpcError("bad-response", "Avalanche's answer was not readable", { method });
  }
  return json.result;
}

/**
 * One read. Resolves the raw `result`; throws AvaxRpcError on anything unreadable.
 */
export async function avaxRpc(method, params = [], {
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  signal = null,
  timeoutMs = RPC_TIMEOUT_MS,
  url = AVAX_RPC,
} = {}) {
  allowed(method);
  const json = await post({ jsonrpc: "2.0", id: 1, method, params }, { fetchImpl, timers, signal, timeoutMs, url });
  return unwrap(json, method);
}

/**
 * Several reads in ONE JSON-RPC batch. Resolves one entry per request, in order:
 * `{ ok: true, result }` or `{ ok: false, error }`. One failed entry never fails
 * the others; a batch whose answer is unreadable as a whole throws.
 */
export async function avaxRpcBatch(requests, {
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  signal = null,
  timeoutMs = RPC_TIMEOUT_MS,
  url = AVAX_RPC,
} = {}) {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  for (const r of requests) allowed(r && r.method);
  const body = requests.map((r, i) => ({ jsonrpc: "2.0", id: i + 1, method: r.method, params: r.params || [] }));
  const json = await post(body, { fetchImpl, timers, signal, timeoutMs, url });
  if (!Array.isArray(json)) throw new AvaxRpcError("bad-response", "Avalanche's answer was not readable");
  const byId = new Map();
  for (const item of json) if (item && typeof item === "object" && Number.isInteger(item.id)) byId.set(item.id, item);
  return requests.map((r, i) => {
    const item = byId.get(i + 1);
    if (!item) return { ok: false, error: new AvaxRpcError("bad-response", "No answer for this read", { method: r.method }) };
    try { return { ok: true, result: unwrap(item, r.method) }; } catch (e) { return { ok: false, error: e }; }
  });
}

/* ── typed reads ──────────────────────────────────────────────────────────── */

/** eth_call at `block` (default latest). Resolves the return data (hex). Reverts throw code "reverted". */
export async function ethCall({ to, data, from = undefined, value = undefined }, opts = {}) {
  const call = { to, data };
  if (from) call.from = from;
  if (value !== undefined) call.value = typeof value === "bigint" ? toHexQuantity(value) : value;
  const out = await avaxRpc("eth_call", [call, opts.block || "latest"], opts);
  if (!isHexData(out)) throw new AvaxRpcError("bad-response", "The contract's answer was not readable", { to });
  return out;
}

/** Native AVAX balance in wei (BigInt). Throws when unreadable, never 0. */
export async function getBalanceWei(address, opts = {}) {
  return hexToBigInt(await avaxRpc("eth_getBalance", [String(address).toLowerCase(), "latest"], opts));
}

/** eth_gasPrice in wei. */
export async function getGasPriceWei(opts = {}) {
  return hexToBigInt(await avaxRpc("eth_gasPrice", [], opts));
}

/** The latest block's number, time and base fee. */
export async function getLatestBlock(opts = {}) {
  const b = await avaxRpc("eth_getBlockByNumber", ["latest", false], opts);
  if (!b || typeof b !== "object") throw new AvaxRpcError("bad-response", "The latest block was not readable");
  return {
    number: hexToBigInt(b.number),
    timestamp: hexToBigInt(b.timestamp),
    baseFeePerGas: hexToBigInt(b.baseFeePerGas),
  };
}

/** The pending nonce (what the next tx from `address` will use). */
export async function getPendingNonce(address, opts = {}) {
  return hexToBigInt(await avaxRpc("eth_getTransactionCount", [String(address).toLowerCase(), "pending"], opts));
}

/** The latest nonce: how many txs from `address` are MINED (the next unmined one's nonce). */
export async function getLatestNonce(address, opts = {}) {
  return hexToBigInt(await avaxRpc("eth_getTransactionCount", [String(address).toLowerCase(), "latest"], opts));
}

/** The nonce a tx was sent with (eth_getTransactionByHash), or null when the node does not know the hash. */
export async function getTxNonce(hash, opts = {}) {
  const tx = await avaxRpc("eth_getTransactionByHash", [String(hash).toLowerCase()], opts);
  if (tx == null) return null;
  if (typeof tx !== "object") throw new AvaxRpcError("bad-response", "The transaction was not readable");
  return hexToBigInt(tx.nonce);
}

/** Throws "wrong-chain" unless the endpoint really is Avalanche C-Chain. */
export async function assertAvalanche(opts = {}) {
  const id = await avaxRpc("eth_chainId", [], opts);
  if (typeof id !== "string" || id.toLowerCase() !== AVAX_CHAIN_ID_HEX) {
    throw new AvaxRpcError("wrong-chain", "That endpoint is not Avalanche", { chainId: id, want: AVAX_CHAIN_ID });
  }
  return AVAX_CHAIN_ID;
}
