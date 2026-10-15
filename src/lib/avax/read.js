// ─────────────────────────────────────────────────────────────────────────────
// The Avax Wallet read: every whitelisted balance, native AVAX, the Aave USDC
// position, the allowances that matter and the Aave USDC reserve — in ONE
// eth_call to Multicall3.aggregate3 (allowFailure on every item).
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §4.3. READ-ONLY: eth_call, eth_getBalance, eth_gasPrice,
// eth_getBlockByNumber, eth_getTransactionCount on the public Avalanche RPC.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. ONE ITEM FAILING NULLS ONE FIELD. A failed call, an empty answer (a call
//      to an address with no code "succeeds" with no data), or data of the wrong
//      size makes THAT field null and adds a line to `problems`. It never reads 0.
//   2. THE WHOLE ANSWER UNREADABLE THROWS (AvaxRpcError / AbiError): the page
//      shows "Couldn't read Avalanche", never an empty wallet.
//   3. The owner must be a real address; this file never guesses one.

import { AAVE_V3, MULTICALL3, USDC, RELAY_AVAX, AVAX_CHAIN_ID, GWEI } from "./config.js";
import { ethCall, getLatestBlock, getGasPriceWei, getPendingNonce, avaxRpc, hexToBigInt } from "./rpc.js";
import { addressWord, boolWord, uintWord, strip0x, wordAt, wordToUint, wordToBool, decodeUint, AbiError } from "./abi.js";
import { whitelistAssets } from "./whitelist.js";
import { rawToNumber } from "./units.js";
import {
  reserveDataCall, virtualBalanceCall, aTokenTotalSupplyCall, aTokenBalanceCall, usdcPoolAllowanceCall,
  decodeReserveData, reserveStatus, SEL,
} from "./aave/v3.js";
import { isEvmAddress } from "../relay/depositAddress.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";

export const AGGREGATE3 = "0x82ad56cb";     // aggregate3((address,bool,bytes)[])
export const GET_ETH_BALANCE = "0x4d2301cc"; // Multicall3.getEthBalance(address)

/* ── Multicall3.aggregate3, encoded and decoded strictly ──────────────────── */

function bytesTail(hexBody) {
  const len = hexBody.length / 2;
  const padded = hexBody.padEnd(Math.ceil(hexBody.length / 64) * 64, "0");
  return uintWord(BigInt(len)) + padded;
}

/** [{target, data, allowFailure?=true}] → aggregate3 calldata. */
export function encodeAggregate3(calls) {
  if (!Array.isArray(calls) || calls.length === 0) throw new AbiError("No calls");
  const tuples = calls.map((c) => {
    const body = strip0x(c.data);
    return addressWord(c.target) + boolWord(c.allowFailure !== false) + uintWord(0x60n) + bytesTail(body);
  });
  let offset = BigInt(calls.length * 32);
  const heads = [];
  for (const t of tuples) {
    heads.push(uintWord(offset));
    offset += BigInt(t.length / 2);
  }
  return `${AGGREGATE3}${uintWord(0x20n)}${uintWord(BigInt(calls.length))}${heads.join("")}${tuples.join("")}`;
}

const num = (w) => {
  const n = wordToUint(w);
  if (n > 0xffffffffn) throw new AbiError("Offset out of range");
  return Number(n) * 2; // in hex chars
};

/**
 * aggregate3 return data → [{success, returnData}], exactly `expected` entries.
 * Throws AbiError on any offset or length that does not fit.
 */
export function decodeAggregate3(hex, expected) {
  const body = strip0x(hex);
  const arr = num(wordAt(body, 0));
  const lenWord = body.slice(arr, arr + 64);
  if (lenWord.length !== 64) throw new AbiError("Short multicall answer");
  const n = Number(wordToUint(lenWord));
  if (n !== expected) throw new AbiError("Wrong number of answers", { n, expected });
  const base = arr + 64;
  const out = [];
  for (let i = 0; i < n; i++) {
    const headWord = body.slice(base + i * 64, base + i * 64 + 64);
    if (headWord.length !== 64) throw new AbiError("Short multicall answer");
    const t = base + num(headWord);
    const successWord = body.slice(t, t + 64);
    const offWord = body.slice(t + 64, t + 128);
    if (successWord.length !== 64 || offWord.length !== 64) throw new AbiError("Short multicall answer");
    const success = wordToBool(successWord);
    const b = t + num(offWord);
    const blen = body.slice(b, b + 64);
    if (blen.length !== 64) throw new AbiError("Short multicall answer");
    const len = Number(wordToUint(blen)) * 2;
    const data = body.slice(b + 64, b + 64 + len);
    if (data.length !== len) throw new AbiError("Short multicall answer");
    out.push({ success, returnData: `0x${data}` });
  }
  return out;
}

/**
 * Run `calls` through ONE aggregate3 eth_call. Each entry becomes
 * `{ ok, value, why }`: `decode(returnData)` runs only on success, and a throw
 * from it (wrong size, empty) is `ok:false` for that entry alone.
 */
export async function multicall(calls, opts = {}) {
  const data = encodeAggregate3(calls.map((c) => ({ target: c.to, data: c.data, allowFailure: true })));
  const hex = await ethCall({ to: MULTICALL3, data }, opts);
  const answers = decodeAggregate3(hex, calls.length);
  return answers.map((a, i) => {
    if (!a.success) return { ok: false, value: null, why: "call failed" };
    try {
      return { ok: true, value: calls[i].decode(a.returnData), why: null };
    } catch (e) {
      return { ok: false, value: null, why: (e && e.message) || "unreadable" };
    }
  });
}

/* ── the Avax Wallet ──────────────────────────────────────────────────────── */

const balanceOfCall = (token, owner) => ({ to: token, data: `${SEL.balanceOf}${addressWord(owner)}`, decode: decodeUint });
const allowanceCall = (token, owner, spender) => ({ to: token, data: `${SEL.allowance}${addressWord(owner)}${addressWord(spender)}`, decode: decodeUint });

/**
 * Everything the Avax Wallet shows for `owner`, in one eth_call.
 *
 * Resolves (frozen):
 *   { owner, chainId, readAt,
 *     avaxWei,                         native AVAX, BigInt | null
 *     assets: [{symbol, address, decimals, native, raw, amount}],   whitelist order; raw/amount null when unknown
 *     balances: {SYMBOL: raw|null},
 *     aave: { suppliedRaw, suppliedUsdc, poolAllowanceRaw, status },   status = reserveStatus() | null
 *     relayAllowances: { v3, "v3.2" },  USDC allowance to each Relay ApprovalProxy
 *     problems: [string] }
 * Throws when the read as a whole fails.
 */
export async function readAvaxAccount(owner, {
  env = undefined,
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  now = browserNow,
  signal = null,
} = {}) {
  if (!isEvmAddress(owner)) throw new AbiError("Not a wallet address", { owner: owner ?? null });
  const own = owner.toLowerCase();
  const list = env === undefined ? whitelistAssets() : whitelistAssets(env);
  const calls = [];
  const slot = {};
  const push = (key, call) => { slot[key] = calls.length; calls.push(call); };

  for (const a of list) {
    if (a.native) push(`bal:${a.symbol}`, { to: MULTICALL3, data: `${GET_ETH_BALANCE}${addressWord(own)}`, decode: decodeUint });
    else push(`bal:${a.symbol}`, balanceOfCall(a.address, own));
  }
  push("aUsdc", { ...aTokenBalanceCall(own), decode: decodeUint });
  push("poolAllowance", { ...usdcPoolAllowanceCall(own), decode: decodeUint });
  push("relay:v3", allowanceCall(USDC, own, RELAY_AVAX.v3.approvalProxy));
  push("relay:v3.2", allowanceCall(USDC, own, RELAY_AVAX["v3.2"].approvalProxy));
  push("reserve", { ...reserveDataCall(), decode: decodeReserveData });
  push("aTotal", { ...aTokenTotalSupplyCall(), decode: decodeUint });
  push("virtual", { ...virtualBalanceCall(), decode: decodeUint });

  const res = await multicall(calls, { fetchImpl, timers, signal });
  const problems = [];
  const get = (key) => {
    const r = res[slot[key]];
    if (!r.ok) problems.push(`${key}: ${r.why}`);
    return r.ok ? r.value : null;
  };

  const assets = list.map((a) => {
    const raw = get(`bal:${a.symbol}`);
    return Object.freeze({ symbol: a.symbol, address: a.address, decimals: a.decimals, native: a.native, raw, amount: rawToNumber(raw, a.decimals) });
  });
  const balances = Object.freeze(Object.fromEntries(assets.map((a) => [a.symbol, a.raw])));
  const avax = assets.find((a) => a.native);
  const suppliedRaw = get("aUsdc");
  const reserve = get("reserve");
  const status = reserveStatus({ reserve, aTokenTotalSupplyRaw: get("aTotal"), virtualBalanceRaw: get("virtual") });

  return Object.freeze({
    owner: own,
    chainId: AVAX_CHAIN_ID,
    readAt: now(),
    avaxWei: avax ? avax.raw : null,
    assets: Object.freeze(assets),
    balances,
    aave: Object.freeze({
      suppliedRaw,
      suppliedUsdc: rawToNumber(suppliedRaw, 6),
      poolAllowanceRaw: get("poolAllowance"),
      status,
    }),
    relayAllowances: Object.freeze({ v3: get("relay:v3"), "v3.2": get("relay:v3.2") }),
    problems: Object.freeze(problems),
  });
}

/**
 * The Aave USDC reserve alone (no owner): APY, flags, cap room, free liquidity.
 * Resolves reserveStatus() or throws when the reserve itself is unreadable.
 */
export async function readAaveUsdcMarket({ fetchImpl = globalThis.fetch, timers = browserTimers, signal = null } = {}) {
  const res = await multicall([
    { ...reserveDataCall(), decode: decodeReserveData },
    { ...aTokenTotalSupplyCall(), decode: decodeUint },
    { ...virtualBalanceCall(), decode: decodeUint },
  ], { fetchImpl, timers, signal });
  if (!res[0].ok) throw new AbiError("The Aave USDC reserve was not readable", { why: res[0].why });
  return reserveStatus({ reserve: res[0].value, aTokenTotalSupplyRaw: res[1].value, virtualBalanceRaw: res[2].value });
}

/**
 * The network fee state right now: base fee (latest block), eth_gasPrice and
 * the node's suggested tip. Throws when the base fee is unreadable.
 */
export async function readFeeState({ fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, signal = null } = {}) {
  const opts = { fetchImpl, timers, signal };
  const block = await getLatestBlock(opts);
  let gasPriceWei = null;
  try { gasPriceWei = await getGasPriceWei(opts); } catch { gasPriceWei = null; }
  let tipWei = null;
  try { tipWei = hexToBigInt(await avaxRpc("eth_maxPriorityFeePerGas", [], opts)); } catch { tipWei = null; }
  return Object.freeze({
    baseFeeWei: block.baseFeePerGas,
    baseFeeGwei: Number(block.baseFeePerGas) / Number(GWEI),
    gasPriceWei,
    suggestedTipWei: tipWei,
    blockNumber: block.number,
    blockTime: Number(block.timestamp),
    readAt: now(),
  });
}

/** The pending nonce of `owner` (for the flow registry, plan §3.6). */
export async function readPendingNonce(owner, { fetchImpl = globalThis.fetch, timers = browserTimers, signal = null } = {}) {
  if (!isEvmAddress(owner)) throw new AbiError("Not a wallet address", { owner: owner ?? null });
  return getPendingNonce(owner, { fetchImpl, timers, signal });
}
