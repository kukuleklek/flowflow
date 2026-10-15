// ─────────────────────────────────────────────────────────────────────────────
// The last hop of a first deposit: the customer's own USDC on Arbitrum, moved
// into their own Perp account by their own wallet.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS FILE EXISTS. A first deposit that is credited straight into a Perp
// account pays a one-time cost of 1 quote token, measured at 1.238 USDC of
// relayer fee on 25 USDC from Base (2026-09-27) against 0.032 for an account
// that already exists. A deposit that arrives as a plain token transfer into
// the venue's own deposit contract pays nothing at all: two brand-new accounts
// were funded that way that day (0x1003…e260 with 15.500731 and 0xbc17…8527
// with 15.0) and neither ledger shows a fee line. So the first deposit is
// routed to the customer's own address on Arbitrum with a little native gas
// beside it (lib/relay/firstDeposit.js), and this file makes the last hop.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. NOTHING BELOW THE MINIMUM IS EVER SENT. The deposit contract has no
//      amount check of its own — the token transfer succeeds, the balance
//      grows, and a sub-minimum transfer is simply never credited. There is no
//      refund path and no queue: the money is gone. So BRIDGE_MIN_USDC is
//      checked against the balance READ FROM THE CHAIN, immediately before the
//      transfer is built, and a short balance throws instead of sending.
//   2. THE SENDER IS THE CUSTOMER. Credit follows the `from` of the token
//      transfer, so the transfer must come from the same address the Perp
//      account lives at. The owner, the connected wallet and the signer's own
//      address are all compared before anything is signed; any disagreement
//      throws.
//   3. THE AMOUNT IS WHAT IS THERE, not what a quote promised. Only the balance
//      read at that moment is used, and a failed read THROWS rather than
//      reading as nothing: an unknown balance must never look like an empty one.
//   4. Unknown is null, never 0 (docs/MONEY_RULES.md section 0).
//
// NO SERVER OF OURS (owner, 2026-09-27: "ไม่อยากมี relayer"). The transfer is
// signed by the customer's own embedded wallet and paid for with the gas the
// route delivered beside the money. FlowFlow holds no key, runs no relayer and
// tops up no gas. The signer is handed in by the caller (services/privy's
// no-window sender, through the tab's one runner in perp/deposit/perpFunding.js); this file only
// builds what it may sign and refuses everything else.
//
// The one host here is a public Arbitrum RPC, and every call to it is a read:
// the token balance, whether there is any native gas to pay the hop with, and
// the receipt of a transfer this app already sent (was it mined?).
// Nothing runs at import time.

import { isEvmAddress, sameAddress } from "./depositAddress.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";

export const ARBITRUM_CHAIN_ID = 42161;
/** The network's name as the customer reads it, where their money is theirs to see. */
export const ARBITRUM_CHAIN_NAME = "Arbitrum";
/** Native (not bridged) USDC on Arbitrum, 6 decimals: the route's destination. */
export const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
export const ARBITRUM_USDC_DECIMALS = 6;
/** Read-only JSON-RPC. CORS is open (access-control-allow-origin *, checked 2026-09-27). */
export const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

/* THE DEPOSIT CONTRACT, from the venue's own docs: a token transfer to it is
   credited to the account that sent it, in under a minute. Its live USDC
   balance read 563,430,000+ on 2026-09-27, and eleven USDC transfers reached it
   in the twelve minutes before this was written, so it is very much in use. */
export const PERP_DEPOSIT_CONTRACT = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";

/* 🔴 THE FLOOR, in the docs' own words: "The minimum deposit amount is 5 USDC.
   If you send an amount less than this, it will not be credited and be lost
   forever." Read as base units too, so the check is BigInt against BigInt and
   no float ever decides whether money is safe. */
export const BRIDGE_MIN_USDC = 5;
export const BRIDGE_MIN_RAW = 5000000n;

const TRANSFER_SELECTOR = "0xa9059cbb";
const BALANCE_SELECTOR = "0x70a08231";
const RPC_TIMEOUT_MS = 15000;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export class PerpMoveError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "PerpMoveError";
    this.code = code;
    this.detail = detail;
  }
}

/** 6-decimal USDC base units as a number, or null. Exact for every real balance. */
export function usdcFromRaw(raw) {
  if (typeof raw !== "bigint" || raw < 0n) return null;
  const whole = raw / 1000000n;
  if (whole > 9000000000n) return null;
  return Number(whole) + Number(raw % 1000000n) / 1e6;
}

/** A 20-byte address as one 32-byte word. */
function word(addr) {
  return String(addr).toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** A non-negative BigInt as one 32-byte word. */
function amountWord(raw) {
  return raw.toString(16).padStart(64, "0");
}

/** The calldata that reads an address's token balance. */
export function balanceCalldata(owner) {
  if (!isEvmAddress(owner)) throw new PerpMoveError("bad-address", "Not a wallet address", { owner: owner ?? null });
  return `${BALANCE_SELECTOR}${word(owner)}`;
}

/**
 * The ONE transaction this file will ever build: transfer `raw` base units of
 * Arbitrum USDC to the deposit contract, from the customer's own address.
 *
 * Refuses anything that is not exactly that, and re-reads the address out of
 * the calldata it just built, so the destination on the wire is checked rather
 * than assumed (the same reading the quote verifier gives a transfer).
 */
export function bridgeTransferCall({ owner, raw } = {}) {
  if (!isEvmAddress(owner)) throw new PerpMoveError("bad-address", "Not a wallet address", { owner: owner ?? null });
  if (typeof raw !== "bigint") throw new PerpMoveError("bad-amount", "The amount to move was not read from the chain");
  if (raw < BRIDGE_MIN_RAW) throw new PerpMoveError("below-minimum", "Too little to move into your Perp account", { raw: raw.toString() });
  const data = `${TRANSFER_SELECTOR}${word(PERP_DEPOSIT_CONTRACT)}${amountWord(raw)}`;
  const to = `0x${data.slice(10 + 24, 10 + 64)}`;
  if (!sameAddress(to, PERP_DEPOSIT_CONTRACT)) throw new PerpMoveError("bad-call", "The transfer points somewhere else");
  if (BigInt(`0x${data.slice(10 + 64)}`) !== raw) throw new PerpMoveError("bad-call", "The transfer carries another amount");
  return Object.freeze({ chainId: ARBITRUM_CHAIN_ID, to: ARBITRUM_USDC, data, value: "0x0" });
}

/* `want` is the shape of a readable answer: a hex string for the balance reads,
   an object or null for a receipt (null is the chain's own "not mined"). */
async function rpc(method, params, { fetchImpl, timers, signal }, want = "string") {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS) : null;
  if (signal && ctrl) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  let res;
  try {
    res = await fetchImpl(ARBITRUM_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    throw new PerpMoveError("network", "Couldn't reach the network to read your balance", { cause: String((e && e.message) || e) });
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  const shaped = want === "string"
    ? !!json && typeof json.result === "string"
    : !!json && Object.prototype.hasOwnProperty.call(json, "result") && (json.result === null || typeof json.result === "object");
  if (!res.ok || !json || json.error || !shaped) {
    throw new PerpMoveError("bad-response", "The network's answer was not readable", { status: res.status });
  }
  return json.result;
}

/**
 * The customer's own USDC balance on Arbitrum, read from the chain right now.
 *
 * Resolves { raw, usdc }: raw is BigInt base units, usdc the same figure as a
 * number. Rejects (never resolves 0) when the read fails, so an unreadable
 * balance can never be mistaken for an empty wallet.
 */
export async function readArbitrumUsdcBalance({
  owner,
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  now = browserNow,
  signal,
} = {}) {
  const data = balanceCalldata(owner);
  const hex = await rpc("eth_call", [{ to: ARBITRUM_USDC, data }, "latest"], { fetchImpl, timers, signal });
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(hex)) throw new PerpMoveError("bad-response", "The balance was not readable", { hex });
  const raw = BigInt(hex);
  const usdc = usdcFromRaw(raw);
  if (usdc == null) throw new PerpMoveError("bad-response", "The balance was not readable", { hex });
  return { raw, usdc, readAt: now() };
}

/**
 * The customer's own NATIVE balance on Arbitrum, in wei, read from the chain
 * right now. Resolves a BigInt; rejects (never resolves 0) when the read fails,
 * so an unreadable balance can never be mistaken for an empty one.
 *
 * It answers one question only: is there anything at all to pay the last hop
 * with? What the hop costs is the network's business, and this file states no
 * price for it.
 */
export async function readArbitrumGasBalance({
  owner,
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  signal,
} = {}) {
  if (!isEvmAddress(owner)) throw new PerpMoveError("bad-address", "Not a wallet address", { owner: owner ?? null });
  const hex = await rpc("eth_getBalance", [String(owner).toLowerCase(), "latest"], { fetchImpl, timers, signal });
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(hex)) throw new PerpMoveError("bad-response", "The gas in your wallet was not readable", { hex });
  return BigInt(hex);
}

/**
 * What the chain says about ONE transfer this app already sent, by its hash:
 *   "success"   mined, and it did what it said: the money left the wallet
 *   "reverted"  mined, and it did nothing: the money never left
 *   null        no receipt yet: still on its way, or never mined at all
 * Rejects when the answer cannot be read. An unreadable receipt is not a missing
 * one, exactly as an unreadable balance is not an empty one (rule 4): the caller
 * that cannot tell must treat the attempt as still unresolved.
 *
 * It exists for ONE question (perp/deposit/perpFunding.js): is the attempt that
 * was written down finished, so that money in the wallet now is NEW money that
 * may move by itself? Only "success" ever says yes.
 */
export async function readArbitrumTxReceipt({
  txHash,
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  signal,
} = {}) {
  if (typeof txHash !== "string" || !HASH_RE.test(txHash)) throw new PerpMoveError("bad-hash", "Not a transaction hash", { txHash: txHash ?? null });
  const r = await rpc("eth_getTransactionReceipt", [txHash], { fetchImpl, timers, signal }, "object");
  if (r === null) return null;
  const hashOk = typeof r.transactionHash === "string" && r.transactionHash.toLowerCase() === txHash.toLowerCase();
  if (!hashOk || typeof r.blockNumber !== "string") throw new PerpMoveError("bad-response", "The transfer's receipt was not readable", { txHash });
  if (r.status === "0x1") return "success";
  if (r.status === "0x0") return "reverted";
  throw new PerpMoveError("bad-response", "The transfer's receipt was not readable", { txHash, status: r.status ?? null });
}

/**
 * Move everything the customer has on Arbitrum into their own Perp account.
 *
 *   owner      the wallet the Perp account belongs to
 *   connected  the address the app is connected to right now; must equal owner
 *   sender     { address, sendTransaction(tx) } — the customer's own embedded
 *              wallet. Its address must equal owner, or nothing is signed.
 *   beforeSend called once with { raw, usdc, call } immediately before the
 *              signer is asked, and only if every check above passed.
 *
 * Reads the balance, refuses below the floor, refuses an address with no gas at
 * all to pay the hop with, builds the one transfer above and hands it to the
 * signer. Resolves { txHash, raw, usdc }. Rejects with a PerpMoveError:
 * bad-address, not-connected, no-signer, wrong-signer, below-minimum, no-gas,
 * network, bad-response, bad-amount, bad-call, send-failed.
 */
export async function moveArbitrumUsdcToPerp({
  owner,
  connected,
  sender,
  beforeSend = null,
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  now = browserNow,
  signal,
} = {}) {
  if (!isEvmAddress(owner)) throw new PerpMoveError("bad-address", "Not a wallet address", { owner: owner ?? null });
  if (!sameAddress(owner, connected)) throw new PerpMoveError("not-connected", "Only the wallet that is connected can move its own money");
  if (!sender || typeof sender.sendTransaction !== "function") throw new PerpMoveError("no-signer", "This wallet can't make the move by itself");
  /* 🔴 RULE 2: the deposit is credited to whoever sent the tokens, so the
     signer must be the account's own address. Asserted, never assumed. */
  if (!sameAddress(sender.address, owner)) throw new PerpMoveError("wrong-signer", "The move must be signed by your own wallet", { signer: sender.address ?? null });

  const balance = await readArbitrumUsdcBalance({ owner, fetchImpl, timers, now, signal });
  if (balance.raw < BRIDGE_MIN_RAW) {
    throw new PerpMoveError("below-minimum", "Too little to move into your Perp account", { raw: balance.raw.toString(), usdc: balance.usdc });
  }
  /* 🔴 NOTHING TO PAY THE HOP WITH IS A STOP, NOT A FAILED SIGNATURE. The hop
     is paid for out of the native gas the route delivered beside the money. An
     address holding NONE of it cannot send anything, so it is refused here, with
     its own reason, instead of collapsing into a signature that fails and a
     button the customer can press for ever. ONLY AN EXACT ZERO REFUSES: what the
     hop costs is the network's own business and never a figure this file invents,
     and a read that failed does not block a move that might work (rule 4). */
  let gasWei = null;
  try { gasWei = await readArbitrumGasBalance({ owner, fetchImpl, timers, signal }); } catch { gasWei = null; }
  if (gasWei === 0n) throw new PerpMoveError("no-gas", "There is no gas in your own wallet to make the move", { owner });

  const call = bridgeTransferCall({ owner, raw: balance.raw });
  /* 🔴 THE LAST THING BEFORE THE SIGNATURE. The caller writes the attempt down
     here and nowhere earlier, so a refusal that happens before this point costs
     nothing, and an app that dies after it still comes back knowing it tried. */
  if (typeof beforeSend === "function") beforeSend({ raw: balance.raw, usdc: balance.usdc, call });
  let out;
  try {
    out = await sender.sendTransaction(call);
  } catch (e) {
    throw new PerpMoveError("send-failed", "The move didn't go through", { cause: String((e && e.message) || e) });
  }
  const txHash = typeof out === "string" ? out : out && typeof out.hash === "string" ? out.hash : null;
  if (!txHash || !HASH_RE.test(txHash)) throw new PerpMoveError("send-failed", "The move didn't go through", { hash: txHash });
  return { txHash, raw: balance.raw, usdc: balance.usdc };
}
