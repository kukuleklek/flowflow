// ─────────────────────────────────────────────────────────────────────────────
// THE ADDRESSES A MONEY MOVE ON AVALANCHE MAY NAME, pinned. No network, no clock,
// nothing runs at import time.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ใช้ Aave V3 USDC บน Avalanche (5.70%)" and the swap rules
// "1.) ได้ 2.) เค 3.) ได้". Every move between the user's own Perp account and their
// own Avax Wallet, and every same-chain swap, goes through Relay's contracts. A
// quote names those contracts itself; this file is what each quote is checked
// AGAINST, so an answer that names any other address is refused before a window
// opens (plan v2 §3.1 "Pin", §3.8 "คู่สัญญาที่ยอมรับ").
//
// 🔴 ONE PIN TABLE (after gate). This file used to hold its own copy of the
// addresses and of the token whitelist, next to lib/avax/config.js and
// lib/avax/whitelist.js, with a test (S9 / R11) proving the two agreed. It now
// RE-EXPORTS those two files under the names the swap / move parsers already
// import, so there is one verified value per address and nothing can drift:
//   * config.js — chain, USDC (+ its EIP-712 domain), both Relay generations,
//     the Avalanche and HyperCore depositories, the solver, AllowanceHolder,
//     Multicall3 (each read on chain 2026-10-15, blocks 97,586,280–97,591,655);
//   * whitelist.js — the swap whitelist and the never-swappable pair.
// Only what those files do not hold lives here: the v3.2 MulticallAuthorization
// domain and the 0x Settler registry pins.
//
// WHERE EACH LOCAL VALUE CAME FROM (read-only, 2026-10-15):
//   * GET https://api.relay.link/chains — relayPinProblems() re-checks every pin
//     against any /chains answer, and the suite runs it on the saved one
//     (scripts/fixtures/avax/relay-chains.json).
//   * eth_call on https://api.avax.network/ext/bc/C/rpc — the 0x Deployer's
//     ownerOf(2) / prev(2) for the Settlers.
//
// 🔴 BOTH RELAY GENERATIONS STAY ALLOWED THROUGH AND AFTER 2026-10-26. Relay moves
// quotes to the v3.2 router / approval proxy that day and approvals do not carry
// over, so a quote on either pair is valid, but a router and a proxy from
// DIFFERENT generations in one quote are not (RELAY_PAIRS).
//
// 🔴 XSGD: ONE RULE IN ONE PLACE. It is swappable only when whitelist.js's
// assetEnabled() says its flag (VITE_SWAP_XSGD) is on, read lazily per call —
// so the read track and every swap builder / parser always agree, and the default
// is OFF. Even when on, it has no independent price (prices.js), so the swap loss
// bound still refuses every XSGD swap until a price source exists (plan §3.11).
//
// 🔴 ADDRESSES ARE LOWERCASE HERE AND COMPARED LOWERCASE EVERYWHERE. Nothing in
// this file is ever shown to the user; the screen prints the user's own address
// from the wallet, never one of these.

import {
  AVAX_CHAIN_ID as CHAIN, NATIVE_TOKEN, USDC, USDC_DECIMALS, USDC_EIP712_DOMAIN, RELAY_AVAX, RELAY_HL_DEPOSITORY,
  MULTICALL3 as MC3,
} from "./config.js";
import { AVAX_ASSETS, EXCLUDED_ASSETS, assetEnabled } from "./whitelist.js";

export const AVAX_CHAIN_ID = CHAIN;
export const NATIVE = NATIVE_TOKEN;

/** Circle's native USDC on Avalanche (FiatTokenProxy, 6 dp, EIP-3009 domain "USD Coin" v2). */
export const AVAX_USDC = USDC;
export const AVAX_USDC_DECIMALS = USDC_DECIMALS;
export const USDC_PERMIT_DOMAIN = USDC_EIP712_DOMAIN;

/** Relay's depository on HyperCore (sendAsset destination of every own move INTO Avalanche). */
export const HL_DEPOSITORY = RELAY_HL_DEPOSITORY;
/** Relay's depository on Avalanche (paymentDetails of every move OUT, and the paid exit's spender). */
export const AVAX_DEPOSITORY = RELAY_AVAX.depository;

/** One Relay generation: the router that runs calls and the proxy users approve. */
export const RELAY_V3 = Object.freeze({
  id: "v3",
  router: RELAY_AVAX.v3.erc20Router,
  approvalProxy: RELAY_AVAX.v3.approvalProxy,
});
export const RELAY_V32 = Object.freeze({
  id: "v3.2",
  router: RELAY_AVAX["v3.2"].erc20Router,
  approvalProxy: RELAY_AVAX["v3.2"].approvalProxy,
});
export const RELAY_PAIRS = Object.freeze([RELAY_V3, RELAY_V32]);
export const RELAY_ROUTERS = Object.freeze(RELAY_PAIRS.map((p) => p.router));
export const RELAY_APPROVAL_PROXIES = Object.freeze(RELAY_PAIRS.map((p) => p.approvalProxy));

/** The MulticallAuthorization domain of the v3.2 proxy (Relay docs, gasless-swaps, 2026-10). */
export const MULTICALL_AUTH_DOMAIN = Object.freeze({
  name: "RelayApprovalProxy", version: "3.1", chainId: AVAX_CHAIN_ID, verifyingContract: RELAY_V32.approvalProxy,
});

/** Relay's solver on Avalanche: the only party a swap may pay a fee to. */
export const RELAY_SOLVERS = RELAY_AVAX.solvers;

/** 0x's AllowanceHolder (Cancun), the one contract a swap's DEX call may go through. */
export const ALLOWANCE_HOLDER = RELAY_AVAX.allowanceHolder;
/**
 * 0x's Deployer registry: ownerOf(2) is the current "taker submitted" Settler and
 * prev(2) the one before it (both stay valid during 0x's dwell time). Read live
 * 2026-10-15: ownerOf(2) = 0x5fd781c1…9599, prev(2) = 0xd377ac1a…6f01 — every
 * captured swap quote used the latter. The pinned pair is the default; the read
 * layer can refresh it with settlerRegistryCalls() (swapDecode.js).
 */
export const SETTLER_DEPLOYER = "0x00000000000004533fe15556b1e086bb1a72ceae";
export const SETTLER_FEATURE_TAKER = 2;
export const KNOWN_SETTLERS = Object.freeze([
  "0x5fd781c190aa767f97298cf3f53f9aa9823d9599",
  "0xd377ac1acb5d89683257347827dc9ba9ef166f01",
]);

export const MULTICALL3 = MC3;

/* One whitelist row in the shape the swap / move parsers read. `on` is a GETTER:
   a flagged row (XSGD) asks whitelist.js each time, so a builder and the read track
   can never disagree about it. Rows are frozen; identity is stable (the parsers
   compare rows with ===). */
function swapRow(a) {
  const row = {
    symbol: a.symbol,
    name: a.name,
    address: a.address,
    decimals: a.decimals,
    native: a.native,
    role: a.role,
    thin: a.relayVerified === false,
    onchainSymbol: a.onchainSymbol,
    flag: a.flag,
  };
  Object.defineProperty(row, "on", { enumerable: true, get: () => assetEnabled(a) });
  return Object.freeze(row);
}

/**
 * THE SWAP WHITELIST (owner AD-1, plan §3.11, default of Q8) — whitelist.js's
 * AVAX_ASSETS, same order, same addresses and decimals. A row whose `on` is false
 * is refused by every builder and parser: today that is XSGD unless its flag is on.
 * bUSDC and PHAR are not here at all, so nothing can name them.
 */
export const SWAP_TOKENS = Object.freeze(AVAX_ASSETS.map(swapRow));
/** Never swappable, whatever a flag says (default of OWNER Q8). Kept so a test can prove they are refused. */
export const SWAP_EXCLUDED = Object.freeze(Object.fromEntries(EXCLUDED_ASSETS.map((x) => [x.symbol, x.address])));
/** Stable pairs get the tighter slippage (plan §2.9 SWAP.stableSlippageBps). */
export const STABLE_SYMBOLS = Object.freeze(["USDC", "USDT"]);

const lower = (a) => String(a == null ? "" : a).toLowerCase();

/** The whitelisted token at this address (any casing), or null. `allowOff` also returns rows that are off. */
export function swapTokenByAddress(address, { allowOff = false } = {}) {
  const t = SWAP_TOKENS.find((x) => x.address === lower(address)) || null;
  return t && (t.on || allowOff) ? t : null;
}

/** The whitelisted token with this display symbol, or null. */
export function swapTokenBySymbol(symbol, { allowOff = false } = {}) {
  const t = SWAP_TOKENS.find((x) => x.symbol === symbol) || null;
  return t && (t.on || allowOff) ? t : null;
}

/** The Relay generation this router or proxy belongs to, or null. */
export function relayPairOf(address) {
  const a = lower(address);
  return RELAY_PAIRS.find((p) => p.router === a || p.approvalProxy === a) || null;
}

/**
 * What in a Relay GET /chains answer disagrees with the pins above. Empty means
 * every pin is what Relay itself lists today. THE SUITE'S CHECK and a runtime
 * pre-sign check for the panels (plan §3.1 "อ่านซ้ำจาก /chains ก่อนเซ็น ไม่ตรง =
 * refuse"); it never widens anything — a pin missing from /chains is a problem,
 * an address in /chains missing from the pins is simply not allowed.
 */
export function relayPinProblems(chains) {
  const list = Array.isArray(chains) ? chains : chains && Array.isArray(chains.chains) ? chains.chains : null;
  if (!list) return ["no chains list"];
  const out = [];
  const byId = new Map(list.map((c) => [Number(c && c.id), c]));
  const av = byId.get(AVAX_CHAIN_ID);
  const hl = byId.get(1337);
  if (!av || av.disabled === true) out.push("43114 is missing or off");
  if (!hl || hl.disabled === true) out.push("1337 is missing or off");
  if (av) {
    const c = av.contracts || {};
    const v3 = c.v3 || {};
    const v32 = c["v3.2"] || {};
    if (lower(v3.erc20Router) !== RELAY_V3.router) out.push("v3 router differs");
    if (lower(v3.approvalProxy) !== RELAY_V3.approvalProxy) out.push("v3 approval proxy differs");
    if (lower(v32.erc20Router) !== RELAY_V32.router) out.push("v3.2 router differs");
    if (lower(v32.approvalProxy) !== RELAY_V32.approvalProxy) out.push("v3.2 approval proxy differs");
    if (lower(c.multicall3) !== MULTICALL3) out.push("multicall3 differs");
    const solvers = (av.solverAddresses || []).map(lower);
    for (const s of RELAY_SOLVERS) if (!solvers.includes(s)) out.push(`solver ${s} is not listed`);
    const dep = av.protocol && av.protocol.v2 && av.protocol.v2.depository;
    if (lower(dep) !== AVAX_DEPOSITORY) out.push("avalanche depository differs");
  }
  if (hl) {
    const dep = hl.protocol && hl.protocol.v2 && hl.protocol.v2.depository;
    if (lower(dep) !== HL_DEPOSITORY) out.push("hyperliquid depository differs");
  }
  return out;
}
