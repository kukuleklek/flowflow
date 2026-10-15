// ─────────────────────────────────────────────────────────────────────────────
// RECOVER: USDC sitting in the customer's OWN wallet on Base or Polygon → their
// Main Account, with no gas (Relay usePermit, EIP-3009).
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "เอา ARB, Avax, Base, Polygon พอแระ". A private deposit's
// refund goes back to refundTo on its ORIGIN chain — the customer's own EOA. On
// Arbitrum the auto-mover picks it up, on Avalanche it is the Spot Account; on
// Base and Polygon it would sit in a wallet with no gas and no way back. This file
// is that way back, and Base and Polygon stay off the private picker until it can
// SIGN (lib/intents/config.js PRIVATE_RECOVER_READY).
//
// THE ROUTE (live, read-only, 2026-10-15; scripts/fixtures/recover/):
//   POST /quote/v2 origin 8453 | 137 USDC → 1337 USDC (Perps), usePermit +
//   useMulticallAuthorization. One signature step: today ONE item, EIP-3009
//   ReceiveWithAuthorization on that chain's USDC (domain "USD Coin" v2, read on
//   chain), `to` = Relay's v3 ApprovalProxy; from 2026-10-26 (Relay v3.2) TWO,
//   a MulticallAuthorization first — the same two shapes lib/relay/moveOut.js
//   verifies on Avalanche, here per chain. The solver pays the gas: ZERO ETH/POL.
//   Measured: 10 USDC → 9.97678 (Base), 9.97428 (Polygon), minimum 98.0 % of it.
//
// 🔴 MONEY RULES
//   * No recipient parameter: user = recipient = refundTo = own, re-checked on the
//     answer (details, every order payment, every refund), not on what we sent.
//   * Fee ceiling: what is EXPECTED to arrive is at least X − max(0.25, 2 % X); the
//     guaranteed minimum at most 5 % under that (moveOut.js's two bounds).
//   * Every address a signature names is pinned below (live GET /chains + eth_getCode,
//     2026-10-15): the same Relay contracts on both chains (CREATE2).
//   * The quote lives RECOVER_QUOTE_TTL_MS; nothing is posted on an older one, and
//     the permit's validBefore must still leave 30 s.
//   * THE MONEY WINDOW is the EIP-3009 POST. Its record is WRITTEN before it, and a
//     POST that fails or times out is UNKNOWN ("Not confirmed. Don't send it
//     again."): the signature stays valid until validBefore. A NEW permit on that
//     chain is allowed only once validBefore has passed AND the chain answers
//     whether the old nonce was used (recoverAllowed).
//   * NOTHING HERE HOLDS A SIGNER. The signature comes from an injected
//     `signTypedData` (a VISIBLE typed-data window on chain 8453 / 137, never a
//     silent one); until one is provided (provideRecoverSigner) no Recover runs.
//
// Reads are public RPCs (eth_call balanceOf / authorizationState), read-only.

import { encodeFunctionData, decodeFunctionData, parseAbi } from "viem";
import { HL_RELAY_CHAIN_ID, HL_PERP_USDC, HL_PERP_USDC_DECIMALS, RELAY_API, RELAY_QUOTE_URL, DEPOSIT_CHAINS } from "./routes.js";
import { isEvmAddress, sameAddress } from "./depositAddress.js";
import { plainMoneyWords } from "./plainWords.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";

/* ── the pins ────────────────────────────────────────────────────────────── */

/* Relay's contracts on 8453 and 137 (live GET /chains 2026-10-15; code read on both
   chains: v3 proxy 7,746 B, v3.2 proxy 13,884 B, depository 8,628 B, routers 4,720 /
   7,185 B). The same addresses as on Avalanche (lib/avax/config.js RELAY_AVAX). */
export const RECOVER_RELAY = Object.freeze({
  v3: Object.freeze({ erc20Router: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", approvalProxy: "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be" }),
  "v3.2": Object.freeze({ erc20Router: "0x0729e2a4716d9f7dd17858d5d504426d228697f7", approvalProxy: "0x5567954cd026cebfe486062cb75848e0f1c12e58" }),
  depository: "0x4cd00e387622c35bddb9b4c962c136462338bc31",
});
const APPROVAL_PROXIES = Object.freeze([RECOVER_RELAY.v3.approvalProxy, RECOVER_RELAY["v3.2"].approvalProxy]);
const ROUTERS = Object.freeze([RECOVER_RELAY.v3.erc20Router, RECOVER_RELAY["v3.2"].erc20Router]);

function chainPins(chainId, relayName, usdc, rpcs) {
  const c = DEPOSIT_CHAINS[chainId];
  return Object.freeze({
    chainId,
    chainName: c.name,
    chainLogo: c.logo,
    /* Relay's own name for the chain in protocol.v2 (paymentDetails, refunds). */
    relayName,
    usdc,
    decimals: 6,
    /* name() "USD Coin", version() "2"; DOMAIN_SEPARATOR() equals this domain's hash (read 2026-10-15). */
    domain: Object.freeze({ name: "USD Coin", version: "2", chainId, verifyingContract: usdc }),
    mcaDomain: Object.freeze({ name: "RelayApprovalProxy", version: "3.1", chainId, verifyingContract: RECOVER_RELAY["v3.2"].approvalProxy }),
    /* Public, read-only, CORS open to our pages (checked 2026-10-15). Asked in order. */
    rpcs: Object.freeze(rpcs),
  });
}

/** The chains Recover reads and moves from: where a refund can strand with no gas. */
export const RECOVER_CHAINS = Object.freeze({
  8453: chainPins(8453, "base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]),
  137: chainPins(137, "polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", ["https://polygon-bor-rpc.publicnode.com"]),
});
export const RECOVER_CHAIN_IDS = Object.freeze([8453, 137]);

/** Less than this is not worth a move (the fee floor is 0.25 of it at worst); it is listed, not offered. */
export const MIN_RECOVER_USDC = 1;
export const RECOVER_MAX_SLIPPAGE_PCT = 5;
export const RECOVER_QUOTE_TTL_MS = 60000;
export const PERMIT_MAX_VALID_S = 600;
export const PERMIT_CLOCK_SKEW_S = 120;
export const PERMIT_MIN_LEFT_S = 60;
export const RECOVER_POST_TIMEOUT_MS = 20000;
const READ_TIMEOUT_MS = 8000;

export const RECOVER_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);

export class RecoverError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "RecoverError";
    this.code = code;
    this.detail = detail;
  }
}

const unsafe = (why) => new RecoverError("unsafe-quote", `The move's price did not check out (${why}); nothing is signed`, { why });
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const DIGITS = /^[0-9]+$/;
const big = (v) => (typeof v === "bigint" ? v : typeof v === "string" && DIGITS.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
const fmt = (raw, d) => {
  const base = 10n ** BigInt(d);
  const frac = (raw % base).toString().padStart(d, "0").replace(/0+$/, "");
  return frac ? `${raw / base}.${frac}` : `${raw / base}`;
};
const RWA_FIELDS = [["from", "address"], ["to", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"], ["nonce", "bytes32"]];
const MCA_FIELDS = [["from", "address"], ["relayer", "address"], ["msgValue", "uint256"], ["refundTo", "address"], ["nftRecipient", "address"], ["metadata", "bytes"], ["fundingIndex", "uint256"], ["calls", "Call3Value[]"], ["funding", "FundingAuthorization[]"]];
const CALL3_FIELDS = [["target", "address"], ["allowFailure", "bool"], ["value", "uint256"], ["callData", "bytes"]];
const FUNDING_FIELDS = [["token", "address"], ["from", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"]];
const PERMIT_APIS = ["swap", "bridge", "user-swap"];
const NATIVE = "0x0000000000000000000000000000000000000000";
const fieldsAre = (list, want) => Array.isArray(list) && list.length === want.length && list.every((f, i) => f && f.name === want[i][0] && f.type === want[i][1]);
const sameDomain = (dom, want) => !!dom && Object.keys(dom).length === Object.keys(want).length
  && dom.name === want.name && dom.version === want.version && Number(dom.chainId) === want.chainId && lower(dom.verifyingContract) === lower(want.verifyingContract);

/** The pins for a chain id, or a RecoverError. */
export function recoverChain(chainId) {
  const c = RECOVER_CHAINS[Number(chainId)];
  if (!c) throw new RecoverError("bad-chain", "Recover moves USDC from Base or Polygon only.");
  return c;
}

/** The most this move may cost on top of what arrives: max(0.25, 2 % of X) (lib/relay/moveIn.js's ceiling). */
export function recoverFeeCeiling(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.max(0.25, 0.02 * n) : null;
}

/* ── reading what is there ───────────────────────────────────────────────── */

async function rpcCall(rpc, call, { fetchImpl, timers }) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctrl ? timers.setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    if (!res.ok || !j || j.error || typeof j.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(j.result)) return null;
    return BigInt(j.result);
  } catch {
    return null;
  } finally {
    if (t != null) timers.clearTimeout(t);
  }
}

/* The first readable answer among the chain's RPCs, or null (never 0 for unknown). */
async function readOne(chain, call, opts) {
  for (const rpc of chain.rpcs) {
    const v = await rpcCall(rpc, call, opts);
    if (v != null) return v;
  }
  return null;
}

/**
 * The customer's own USDC on each Recover chain: [{ chainId, chainName, chainLogo,
 * raw (bigint | null), usdc (number | null), offered }] — raw null when no RPC
 * answered; `offered` when there is at least MIN_RECOVER_USDC to move. Never throws.
 */
export async function readStrandedUsdc({ own, chainIds = RECOVER_CHAIN_IDS, fetchImpl = globalThis.fetch, timers = browserTimers } = {}) {
  if (!isEvmAddress(own)) return [];
  return Promise.all(chainIds.map(async (id) => {
    const c = recoverChain(id);
    const raw = await readOne(c, { to: c.usdc, data: encodeFunctionData({ abi: RECOVER_ABI, functionName: "balanceOf", args: [own] }) }, { fetchImpl, timers });
    const usdc = raw == null ? null : Number(fmt(raw, c.decimals));
    return Object.freeze({
      chainId: c.chainId, chainName: c.chainName, chainLogo: c.chainLogo, raw, usdc,
      offered: raw != null && raw >= BigInt(MIN_RECOVER_USDC) * 10n ** BigInt(c.decimals),
    });
  }));
}

/** Was this permit nonce used? true / false, or null when unreadable (never "unused"). */
export async function readPermitUsed({ own, chainId, nonce, fetchImpl = globalThis.fetch, timers = browserTimers } = {}) {
  if (!isEvmAddress(own) || typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  const c = recoverChain(chainId);
  const v = await readOne(c, { to: c.usdc, data: encodeFunctionData({ abi: RECOVER_ABI, functionName: "authorizationState", args: [own, nonce] }) }, { fetchImpl, timers });
  return v === 1n ? true : v === 0n ? false : null;
}

/* ── the quote ───────────────────────────────────────────────────────────── */

function amountRawOf(amountRaw, chain) {
  const r = big(amountRaw);
  if (r == null || r <= 0n) throw new RecoverError("bad-amount", "Nothing to move.");
  if (r < BigInt(MIN_RECOVER_USDC) * 10n ** BigInt(chain.decimals)) throw new RecoverError("too-small", `A move needs at least ${MIN_RECOVER_USDC} USDC.`);
  return r;
}

/** The permit body: own USDC on Base / Polygon → own Main Account. Every key is one api/relay-quote.js allows. */
export function buildRecoverQuoteBody({ own, chainId, amountRaw }) {
  if (!isEvmAddress(own)) throw new RecoverError("bad-user", "Sign in first.");
  const c = recoverChain(chainId);
  const raw = amountRawOf(amountRaw, c);
  return {
    user: own,
    recipient: own,
    refundTo: own,
    originChainId: c.chainId,
    originCurrency: c.usdc,
    destinationChainId: HL_RELAY_CHAIN_ID,
    destinationCurrency: HL_PERP_USDC,
    amount: raw.toString(),
    tradeType: "EXACT_INPUT",
    usePermit: true,
    useMulticallAuthorization: true,
  };
}

/* What every answer must say: from own, to own, this chain's USDC, this amount, the fee bounds, one order to own. */
function checkOrder(json, { own, raw, chain }) {
  const d = json.details || {};
  if (!sameAddress(d.sender, own)) throw unsafe("the sender is not your wallet");
  if (!sameAddress(d.recipient, own)) throw unsafe("the money would be paid to another account");
  const cin = d.currencyIn || {};
  const cout = d.currencyOut || {};
  const ci = cin.currency || {};
  const co = cout.currency || {};
  if (Number(ci.chainId) !== chain.chainId || lower(ci.address) !== chain.usdc || Number(ci.decimals) !== chain.decimals) throw unsafe(`the money leaving is not your USDC on ${chain.chainName}`);
  if (big(cin.amount) !== raw) throw unsafe("the amount leaving is not your amount");
  if (Number(co.chainId) !== HL_RELAY_CHAIN_ID || lower(co.address) !== HL_PERP_USDC || Number(co.decimals) !== HL_PERP_USDC_DECIMALS) throw unsafe("the destination is not your Main Account");
  const minOut = big(cout.minimumAmount);
  const expected = big(cout.amount);
  if (minOut == null || expected == null || minOut <= 0n || expected < minOut) throw unsafe("what arrives cannot be read");
  /* Scaled exactly: 6 → 8 decimals. */
  const scale = 10n ** BigInt(HL_PERP_USDC_DECIMALS - chain.decimals);
  if (expected > raw * scale) throw unsafe("more would arrive than is sent, so the units are wrong");
  const x = Number(fmt(raw, chain.decimals));
  const floor = BigInt(Math.ceil((x - recoverFeeCeiling(x)) * 10 ** HL_PERP_USDC_DECIMALS));
  if (expected < floor) throw unsafe("too little would arrive in your Main Account");
  if (minOut * 10000n < expected * BigInt(10000 - RECOVER_MAX_SLIPPAGE_PCT * 100)) throw unsafe("too little is guaranteed to arrive in your Main Account");
  const app = json.fees && json.fees.app;
  if (app && big(app.amount) !== 0n) throw unsafe("the answer adds an app fee");

  const v2 = json.protocol && json.protocol.v2;
  const order = v2 && v2.orderData;
  if (!order) throw unsafe("the order is missing");
  const out = order.output || {};
  if (out.chainId !== "hyperliquid") throw unsafe("the order pays on another network");
  const pays = Array.isArray(out.payments) ? out.payments : [];
  if (!pays.length || !pays.every((p) => p && sameAddress(p.recipient, own) && lower(p.currency) === HL_PERP_USDC)) throw unsafe("an order payment is not to your Main Account");
  if (!Array.isArray(out.calls) || out.calls.length !== 0) throw unsafe("the order runs calls");
  const refunds = (order.inputs || []).flatMap((i) => (i && Array.isArray(i.refunds) ? i.refunds : []));
  if (!refunds.length || !refunds.every((r) => r && sameAddress(r.recipient, own))) throw unsafe("a refund would go to another address");
  const pd = v2.paymentDetails || {};
  if (pd.chainId !== chain.relayName || lower(pd.depository) !== RECOVER_RELAY.depository || lower(pd.currency) !== chain.usdc || big(pd.amount) !== raw) {
    throw unsafe("the deposit is not to the known depository");
  }
  const relayer = json.fees && json.fees.relayer;
  const feeRaw = relayer && relayer.currency && lower(relayer.currency.address) === chain.usdc && Number(relayer.currency.chainId) === chain.chainId ? big(relayer.amount) : null;
  return {
    requestId: typeof json.requestId === "string" ? json.requestId : null,
    orderId: typeof v2.orderId === "string" ? v2.orderId : null,
    receiveUsdc: fmt(expected, HL_PERP_USDC_DECIMALS),
    minimumUsdc: fmt(minOut, HL_PERP_USDC_DECIMALS),
    /* What the move costs: what leaves minus what is expected, exactly (the fee lines are Relay's own split of it). */
    costUsdc: fmt(raw * scale - expected, HL_PERP_USDC_DECIMALS),
    relayerFeeUsdc: feeRaw == null ? null : fmt(feeRaw, chain.decimals),
    timeEstimateSec: Number.isFinite(Number(d.timeEstimate)) ? Number(d.timeEstimate) : null,
    orderDeadline: Number.isFinite(Number(out.deadline)) ? Number(out.deadline) : null,
  };
}

function checkWindow(validAfter, validBefore, nowS) {
  const vb = Number(validBefore);
  const va = Number(validAfter);
  if (!Number.isSafeInteger(vb) || vb <= 0) throw unsafe("the authorisation never expires");
  if (vb > nowS + PERMIT_MAX_VALID_S + PERMIT_CLOCK_SKEW_S) throw unsafe("the authorisation would stay usable too long");
  if (vb < nowS + PERMIT_MIN_LEFT_S) throw unsafe("the authorisation is about to expire");
  if (!Number.isSafeInteger(va) || va > nowS + PERMIT_CLOCK_SKEW_S) throw unsafe("the authorisation is not usable yet");
  return vb;
}

function checkPost(post, { requestId, kind }) {
  if (!post || post.endpoint !== "/execute/permits" || String(post.method || "").toUpperCase() !== "POST" || !post.body) throw unsafe("a signature does not say where to post it");
  const b = post.body;
  if (b.kind !== kind) throw unsafe(`a signature is posted as ${String(b.kind)}, not ${kind}`);
  if (typeof b.requestId !== "string" || b.requestId !== requestId) throw unsafe("a signature is for another order");
  if (!PERMIT_APIS.includes(b.api)) throw unsafe("a signature is posted to an unknown service");
  return Object.freeze({ endpoint: post.endpoint, method: "POST", body: b });
}

/* The calls a MulticallAuthorization may pin: [approve(depository, X)]? then depositErc20(own, USDC, X, orderId). */
function checkMcaCalls(calls, { own, raw, orderId, chain }) {
  if (typeof orderId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(orderId)) throw unsafe("the order names no id");
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 2) throw unsafe("the authorised calls are not a deposit");
  let deposits = 0;
  calls.forEach((c, i) => {
    if (!c || c.allowFailure !== false || big(c.value) !== 0n) throw unsafe("an authorised call may fail or carries value");
    let d;
    try { d = decodeFunctionData({ abi: RECOVER_ABI, data: c.callData }); } catch { throw unsafe("an authorised call cannot be read"); }
    if (encodeFunctionData({ abi: RECOVER_ABI, functionName: d.functionName, args: d.args }).toLowerCase() !== lower(c.callData)) throw unsafe("an authorised call carries bytes it should not");
    const target = lower(c.target);
    const last = i === calls.length - 1;
    if (d.functionName === "approve") {
      if (target !== chain.usdc) throw unsafe("an authorised call moves another token");
      const to = lower(d.args[0]);
      if (to !== RECOVER_RELAY.depository && !ROUTERS.includes(to)) throw unsafe("an authorised call pays an unknown address");
      if (to !== RECOVER_RELAY.depository || last) throw unsafe("an authorised allowance is not for this deposit");
      if (d.args[1] !== raw) throw unsafe("an authorised allowance is for another amount");
    } else if (d.functionName === "depositErc20") {
      if (target !== RECOVER_RELAY.depository) throw unsafe("an authorised deposit goes to an unknown contract");
      if (!sameAddress(d.args[0], own) || lower(d.args[1]) !== chain.usdc) throw unsafe("an authorised deposit is not yours");
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
 * Verify a Recover permit answer for (own, chain, amount). Throws a RecoverError:
 * "needs-gas" (a transaction step: there is no gas on that chain, so this route is
 * not offered at all), "unsafe-quote" for anything else that does not check out.
 *
 * @returns frozen review: { requestId, orderId, own, chainId, chainName, amountRaw, amountUsdc, receiveUsdc,
 *   minimumUsdc, costUsdc, relayerFeeUsdc, signatures: [{ kind, typedData, post }], permitNonce, validBefore,
 *   orderDeadline, quotedAt }
 */
export function parseRecoverQuote(json, { own, chainId, amountRaw, now = Date.now() } = {}) {
  if (!isEvmAddress(own)) throw new RecoverError("bad-user", "Sign in first.");
  const chain = recoverChain(chainId);
  const raw = amountRawOf(amountRaw, chain);
  if (!json || typeof json !== "object") throw unsafe("no answer");
  const steps = Array.isArray(json.steps) ? json.steps : [];
  if (steps.some((s) => s && s.kind === "transaction")) throw new RecoverError("needs-gas", `This move would need gas on ${chain.chainName}, and there is none there.`);
  if (steps.length !== 1) throw unsafe("the move is not one signature step");
  const step = steps[0];
  if (!step || step.kind !== "signature" || !/^authorize\d*$/.test(String(step.id))) throw unsafe("the step is not an authorisation");
  const items = Array.isArray(step.items) ? step.items : [];
  if (items.length < 1 || items.length > 2) throw unsafe("the step asks for an unexpected number of signatures");
  const requestId = typeof json.requestId === "string" ? json.requestId : null;
  if (!requestId) throw unsafe("the answer names no order");
  const nowS = Math.floor(Number(now) / 1000);
  if (!Number.isFinite(nowS)) throw unsafe("there is no clock to check the authorisation against");

  const order = checkOrder(json, { own, raw, chain });
  if (order.requestId !== requestId) throw unsafe("the answer names two orders");
  const signatures = [];
  let rwa = null;
  let mca = false;
  items.forEach((it, i) => {
    const d = it && it.data;
    const sign = d && d.sign;
    if (!sign || sign.signatureKind !== "eip712" || !sign.types || !sign.value || !sign.domain) throw unsafe("a signature is not a readable EIP-712");
    if (i === items.length - 1) {
      if (sign.primaryType !== "ReceiveWithAuthorization") throw unsafe("the last signature is not the USDC authorisation");
      if (!sameDomain(sign.domain, chain.domain)) throw unsafe(`the authorisation is not for USDC on ${chain.chainName}`);
      if (Object.keys(sign.types).length !== 1 || !fieldsAre(sign.types.ReceiveWithAuthorization, RWA_FIELDS)) throw unsafe("the authorisation's fields are not the ones it should be");
      const v = sign.value;
      if (!sameAddress(v.from, own)) throw unsafe("the authorisation is not from your wallet");
      if (!APPROVAL_PROXIES.includes(lower(v.to))) throw unsafe("the authorisation pays an unknown contract");
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
      if (sign.primaryType !== "MulticallAuthorization") throw unsafe("the first signature is not the call authorisation");
      if (!sameDomain(sign.domain, chain.mcaDomain)) throw unsafe("the call authorisation is not for the known contract");
      const t = sign.types;
      if (Object.keys(t).length !== 3 || !fieldsAre(t.MulticallAuthorization, MCA_FIELDS) || !fieldsAre(t.Call3Value, CALL3_FIELDS) || !fieldsAre(t.FundingAuthorization, FUNDING_FIELDS)) {
        throw unsafe("the call authorisation's fields are not the ones it should be");
      }
      const v = sign.value;
      if (!sameAddress(v.from, own) || !sameAddress(v.refundTo, own)) throw unsafe("the call authorisation is not yours");
      if (!(sameAddress(v.nftRecipient, own) || lower(v.nftRecipient) === NATIVE)) throw unsafe("the call authorisation names another recipient");
      if (big(String(v.msgValue)) !== 0n) throw unsafe("the call authorisation spends gas money");
      if (Number(v.fundingIndex) !== 0) throw unsafe("the call authorisation is funded oddly");
      const f = Array.isArray(v.funding) ? v.funding : [];
      if (f.length !== 1) throw unsafe("the call authorisation pulls more than one amount");
      if (lower(f[0].token) !== chain.usdc || !sameAddress(f[0].from, own) || big(String(f[0].value)) !== raw) throw unsafe("the call authorisation pulls another amount");
      checkWindow(f[0].validAfter, f[0].validBefore, nowS);
      checkMcaCalls(v.calls, { own, raw, orderId: order.orderId, chain });
      mca = true;
      signatures.push(Object.freeze({
        kind: "multicall-authorization",
        typedData: Object.freeze({ domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message: v }),
        post: checkPost(d.post, { requestId, kind: "multicall-authorization" }),
      }));
    }
  });
  /* Two signatures only on the v3.2 proxy, and a permit to the v3.2 proxy never alone (moveOut.js ATK-05). */
  if (mca && rwa.to !== RECOVER_RELAY["v3.2"].approvalProxy) throw unsafe("the two signatures are for different contracts");
  if (!mca && rwa.to === RECOVER_RELAY["v3.2"].approvalProxy) throw unsafe("the authorisation comes without the calls it commits to");

  return Object.freeze({
    ...order,
    kind: "recover",
    own: lower(own),
    chainId: chain.chainId,
    chainName: chain.chainName,
    amountRaw: raw.toString(),
    amountUsdc: fmt(raw, chain.decimals),
    signatures: Object.freeze(signatures),
    signatureCount: signatures.length,
    permitNonce: rwa.nonce,
    validBefore: rwa.validBefore,
    quotedAt: Number(now),
  });
}

/* One quote through our proxy (the key stays on the server). Plain words on a refusal. */
async function postQuote(body, { fetchImpl, timers, url }) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctrl ? timers.setTimeout(() => ctrl.abort(), RECOVER_POST_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
    throw new RecoverError("network", "Couldn't reach the pricing service. Nothing moved.", { cause: String((e && e.message) || e) });
  } finally {
    if (t != null) timers.clearTimeout(t);
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) throw new RecoverError("relay-error", plainMoneyWords(json && typeof json.message === "string" ? json.message : `the service answered ${res.status}`), { status: res.status });
  if (!json || typeof json !== "object") throw new RecoverError("bad-response", "The price could not be read. Nothing moved.");
  return json;
}

/** Price a Recover and verify it. One POST /quote/v2; nothing is signed. */
export async function quoteRecover({ own, chainId, amountRaw, fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, url = RELAY_QUOTE_URL } = {}) {
  const body = buildRecoverQuoteBody({ own, chainId, amountRaw });
  const json = await postQuote(body, { fetchImpl, timers, url });
  return parseRecoverQuote(json, { own, chainId, amountRaw: body.amount, now: now() });
}

/* ── the record of a permit in flight (one per wallet and chain) ─────────── */

export const RECOVER_PREFIX = "flowflow.recover.v1:";

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** A fresh in-memory record (tests; and the page's fallback when storage is refused). */
export function createRecoverJournal({ storage = defaultStorage() } = {}) {
  const memory = new Map();
  const key = (own, chainId) => `${RECOVER_PREFIX}${lower(own)}:${Number(chainId)}`;
  return {
    get(own, chainId) {
      const k = key(own, chainId);
      if (memory.has(k)) return memory.get(k);
      if (!storage) return null;
      try {
        const e = JSON.parse(storage.getItem(k) || "null");
        return e && typeof e.nonce === "string" && Number.isFinite(e.validBefore) ? e : null;
      } catch { return null; }
    },
    /** Written AND read back, or false: the money window opens only on true. */
    put(own, chainId, entry) {
      const k = key(own, chainId);
      memory.set(k, entry);
      if (!storage) return true;
      try {
        storage.setItem(k, JSON.stringify(entry));
        return JSON.parse(storage.getItem(k) || "null")?.nonce === entry.nonce;
      } catch { return false; }
    },
    clear(own, chainId) {
      const k = key(own, chainId);
      memory.delete(k);
      if (!storage) return;
      try { storage.removeItem(k); } catch { /* the entry expires by its own validBefore */ }
    },
  };
}

/**
 * May a NEW permit be signed on this chain? Only when no earlier one can still
 * execute: no record, or its validBefore has passed AND the chain answered
 * whether its nonce was used (true: the money went; false: it never did). An
 * unreadable answer (null) is not "unused".
 */
export function recoverAllowed(entry, { used = null, now = Date.now() } = {}) {
  if (!entry) return true;
  const vb = Number(entry.validBefore);
  if (!Number.isFinite(vb)) return false;
  return Math.floor(Number(now) / 1000) > vb && (used === true || used === false);
}

/* ── doing it ────────────────────────────────────────────────────────────── */

export const RECOVER_WORDS = Object.freeze({
  cancelled: "Cancelled. Nothing moved.",
  expired: "Price expired. Nothing moved.",
  wallet: "Your wallet changed. Nothing moved.",
  record: "This browser couldn't record the move, so nothing was sent.",
  notSent: "Not sent. Nothing moved.",
  unknown: "Not confirmed. Don't send it again.",
  noSigner: "This wallet can't sign this move here yet. Nothing moved.",
  busy: "A move from this network is still settling. Try again in a few minutes.",
  /* The closed builder (recoverClosed.js) stopped it before the wallet's window: said as safety, not as blame. */
  refused: "Stopped for safety before your wallet opened. Nothing moved. Try again.",
});

/* ── the signer, injected (PrivyBridge provides it; nothing here holds one) ── */

let SIGNER = null;
const SIGNER_SUBS = new Set();

/**
 * PrivyBridge hands Recover its typed-data signer: (typedData: { domain, types,
 * primaryType, message }, review) => Promise<"0x…" 65-byte signature>, showing
 * the wallet's OWN window for that chain (8453 / 137), on the bridge's SHOWN
 * hook, after lib/relay/recoverClosed.js rebuilt the request from the review.
 * Never a silent signer. Its `address` (when it carries one) is the wallet it
 * signs for. Returns the function that takes it back.
 */
export function provideRecoverSigner(fn) {
  SIGNER = typeof fn === "function" ? fn : null;
  for (const s of [...SIGNER_SUBS]) { try { s(); } catch { /* a reader never breaks this */ } }
  return () => { if (SIGNER === fn) provideRecoverSigner(null); };
}
export const recoverSigner = () => SIGNER;
export function onRecoverSigner(fn) { SIGNER_SUBS.add(fn); return () => SIGNER_SUBS.delete(fn); }

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

async function postPermit({ post, signature, fetchImpl, timers }) {
  const url = `${RELAY_API}${post.endpoint}${post.endpoint.includes("?") ? "&" : "?"}signature=${encodeURIComponent(signature)}`;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), RECOVER_POST_TIMEOUT_MS) : null;
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
 * Sign every item in order (the injected window), then POST them in order — the
 * EIP-3009 last, after its record is written and read back. Never throws.
 *
 *   review         parseRecoverQuote's answer
 *   ownNow         () => the connected wallet now (must still be review.own)
 *   signTypedData  the injected VISIBLE signer (default: the provided one)
 *   journal        createRecoverJournal() (one per page)
 *   used           the chain's answer for the previous record's nonce (recoverAllowed)
 *
 * @returns {Promise<{ ok: true, requestId, state: "arriving" } | { ok: false, code, message, state, unknown?: true }>}
 */
export async function executeRecover({
  review, ownNow, signTypedData = SIGNER, journal, used = null,
  fetchImpl = globalThis.fetch, now = browserNow, timers = browserTimers,
} = {}) {
  const fail = (state, code, message, extra = {}) => ({ ok: false, code, message, state, ...extra });
  if (!review || review.kind !== "recover" || !Array.isArray(review.signatures) || !review.signatures.length) return fail("error-before-money", "bad-quote", "No price to move with. Nothing moved.");
  if (typeof signTypedData !== "function") return fail("error-before-money", "no-signer", RECOVER_WORDS.noSigner);
  if (!journal) return fail("error-before-money", "record", RECOVER_WORDS.record);
  const ownIs = () => {
    let o = null;
    try { o = typeof ownNow === "function" ? ownNow() : null; } catch { o = null; }
    return isEvmAddress(o) && sameAddress(o, review.own);
  };
  const fresh = () => Number.isFinite(review.quotedAt) && now() - review.quotedAt < RECOVER_QUOTE_TTL_MS && review.validBefore >= Math.floor(now() / 1000) + 30;
  if (!ownIs()) return fail("error-before-money", "wallet", RECOVER_WORDS.wallet);
  if (!recoverAllowed(journal.get(review.own, review.chainId), { used, now: now() })) return fail("cancelled", "busy", RECOVER_WORDS.busy);
  if (!fresh()) return fail("cancelled", "price_expired", RECOVER_WORDS.expired);

  /* 1. every signature, in the order given; nothing is posted yet. The signer is
     handed the review too: PrivyBridge rebuilds the window from it
     (lib/relay/recoverClosed.js) and refuses anything else before Privy is asked. */
  const signed = [];
  for (const s of review.signatures) {
    let sig;
    try {
      sig = await signTypedData(s.typedData, review);
    } catch (e) {
      if (e && e.code === "refused") return fail("cancelled", "refused", RECOVER_WORDS.refused);
      return fail("cancelled", "cancelled", RECOVER_WORDS.cancelled);
    }
    if (typeof sig !== "string" || !SIGNATURE_RE.test(sig)) return fail("cancelled", "cancelled", RECOVER_WORDS.cancelled);
    signed.push({ ...s, signature: sig });
  }
  if (!fresh()) return fail("cancelled", "price_expired", RECOVER_WORDS.expired);
  if (!ownIs()) return fail("error-before-money", "wallet", RECOVER_WORDS.wallet);

  /* 2. the MulticallAuthorization first (moves nothing on its own). */
  for (const s of signed.slice(0, -1)) {
    const r = await postPermit({ post: s.post, signature: s.signature, fetchImpl, timers });
    if (!r.ok) return fail("error-before-money", "post_refused", RECOVER_WORDS.notSent);
  }

  /* 3. the record, then the POST that moves money — still on a live price. */
  if (!fresh()) return fail("cancelled", "price_expired", RECOVER_WORDS.expired);
  const entry = { nonce: review.permitNonce, validBefore: review.validBefore, requestId: review.requestId, amountRaw: review.amountRaw, at: now(), state: "sending" };
  if (!journal.put(review.own, review.chainId, entry)) return fail("error-before-money", "record", RECOVER_WORDS.record);
  const last = signed[signed.length - 1];
  const r = await postPermit({ post: last.post, signature: last.signature, fetchImpl, timers });
  if (!r.ok) return fail("unknown", "not_confirmed", RECOVER_WORDS.unknown, { unknown: true, requestId: review.requestId, permitNonce: review.permitNonce, validBefore: review.validBefore });
  journal.put(review.own, review.chainId, { ...entry, state: "sent" });
  return { ok: true, requestId: review.requestId, state: "arriving" };
}
