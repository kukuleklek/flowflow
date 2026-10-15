// ─────────────────────────────────────────────────────────────────────────────
// The Avax Wallet's asset whitelist: the ONLY assets FlowFlow shows, reads,
// swaps or builds a call for on Avalanche.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner (USER-ADDENDUM AD-1): "เรา Whitelist Asset เข้าไปด้วย ในหน้า AVAX WALLET".
// The starting list was the owner's screenshot (Relay's default Avalanche
// list). Plan v2 §3.11 + OWNER Q8 default:
//   ON   USDC (base), AVAX (gas, native), WAVAX, BTC.b, USDT, XAUt0
//   OFF  XSGD — works, but behind VITE_SWAP_XSGD; and even with the flag on it
//        has no independent price, so the swap loss bound still refuses it
//   OUT  bUSDC (a third-party wrapper named like USDC, $170k supply) and PHAR
//        (a volatile DEX governance token). They are listed in EXCLUDED only so a
//        test can prove they never get in.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. PINNED, NOT FETCHED. Each address, symbol and decimals was read on chain
//      at block 97,586,600 and re-checked at 97,588,260 (R-swap.md §3 and its
//      Verification): code present, name/symbol/decimals as below. A token list
//      from any API is compared against this table, never trusted instead of it.
//   2. AN ADDRESS NOT HERE IS NOT AN ASSET. assetByAddress() answers null for it
//      and every builder refuses it.
//   3. The Agent picks a SYMBOL from SWAP_SYMBOLS (an enum), never an address.

import { USDC, NATIVE_TOKEN } from "./config.js";
import { sameAddress } from "../relay/depositAddress.js";

/* Vite's env in the browser; nothing (defaults) under Node. Read lazily, per call. */
const viteEnv = () => {
  try { return (typeof import.meta !== "undefined" && import.meta.env) || {}; } catch { return {}; }
};
const flagOn = (v) => /^(1|true|on|yes)$/i.test(String(v ?? "").trim());

export const WHITELIST_VERIFIED_AT_BLOCK = 97586600;

/**
 * @typedef {object} AvaxAsset
 * @property {string} symbol      display symbol (what the card and the Agent say)
 * @property {string} name        display name
 * @property {string} address     lowercase; NATIVE_TOKEN for AVAX
 * @property {number} decimals
 * @property {boolean} native
 * @property {"base"|"gas"|null} role
 * @property {string|null} logo   a LOCAL file (no third-party image on a money screen)
 * @property {string|null} hlMid  Hyperliquid market whose mid is this asset's independent price
 * @property {number|null} peg    a USD peg used as the independent price (stables)
 * @property {{hlMid:string,pct:number}|null} sanity  a looser independent band (gold vs PAXG)
 * @property {string|null} onchainSymbol  when the chain spells it differently
 * @property {string|null} tip    a short honest note for the card
 * @property {boolean} relayVerified  Relay's own "verified" flag (the ⚠ in its picker)
 * @property {string|null} flag   the env flag that turns it on (null = always on)
 */

const asset = (a) => Object.freeze({
  native: false, role: null, logo: null, hlMid: null, peg: null, sanity: null,
  onchainSymbol: null, tip: null, relayVerified: true, flag: null, ...a,
});

/** Every asset FlowFlow knows on Avalanche, in display order. */
export const AVAX_ASSETS = Object.freeze([
  asset({ symbol: "USDC", name: "USD Coin", address: USDC, decimals: 6, role: "base", logo: "/tokens/usdc.svg", peg: 1 }),
  asset({ symbol: "AVAX", name: "Avalanche", address: NATIVE_TOKEN, decimals: 18, native: true, role: "gas", logo: "/hl-coins/AVAX.svg", hlMid: "AVAX" }),
  asset({ symbol: "WAVAX", name: "Wrapped AVAX", address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", decimals: 18, logo: "/hl-coins/AVAX.svg", hlMid: "AVAX",
    tip: "Wrapped AVAX is a token, not the AVAX that pays gas." }),
  asset({ symbol: "BTC.b", name: "Bitcoin (BTC.b)", address: "0x152b9d0fdc40c096757f570a51e494bd4b943e50", decimals: 8, logo: "/hl-coins/BTC.svg", hlMid: "BTC" }),
  asset({ symbol: "USDT", name: "Tether USD", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6, logo: "/tokens/usdt.svg", peg: 1, onchainSymbol: "USDt" }),
  asset({ symbol: "XAUt0", name: "Tether Gold (XAUt0)", address: "0x2775d5105276781b4b85ba6ea6a6653beed1dd32", decimals: 6, logo: "/tokens/xaut0.png",
    sanity: { hlMid: "PAXG", pct: 3 }, relayVerified: false, tip: "Thin market on Avalanche (about 408 oz). The price impact is checked on every swap." }),
  asset({ symbol: "XSGD", name: "XSGD", address: "0xb2f85b7ab3c2b6f62df06de6ae7d09c010a5096e", decimals: 6, logo: "/tokens/xsgd.png", flag: "VITE_SWAP_XSGD" }),
]);

/** Verified on chain, deliberately NOT supported (OWNER Q8 default). Never returned by any lookup. */
export const EXCLUDED_ASSETS = Object.freeze([
  Object.freeze({ symbol: "bUSDC", address: "0x038dbe3d967bb8389190446dacdfe7b95b44f73d", why: "Third-party USDC wrapper, not Circle USDC" }),
  Object.freeze({ symbol: "PHAR", address: "0x13a466998ce03db73abc2d4df3bbd845ed1f28e7", why: "Volatile DEX governance token" }),
]);

/** Is this asset switched on under `env`? */
export function assetEnabled(a, env = viteEnv()) {
  if (!a) return false;
  return a.flag == null ? true : flagOn(env && env[a.flag]);
}

/** The enabled assets, in display order. */
export function whitelistAssets(env = viteEnv()) {
  return AVAX_ASSETS.filter((a) => assetEnabled(a, env));
}

/** The symbols the Agent's enum may name (enabled only). */
export function swapSymbols(env = viteEnv()) {
  return whitelistAssets(env).map((a) => a.symbol);
}

/** The default swap enum with every flag off: USDC AVAX WAVAX BTC.b USDT XAUt0. */
export const SWAP_SYMBOLS = Object.freeze(AVAX_ASSETS.filter((a) => a.flag == null).map((a) => a.symbol));

/** An ENABLED asset by its display symbol (exact, case-sensitive: "BTC.b"), or null. */
export function assetBySymbol(symbol, env = viteEnv()) {
  if (typeof symbol !== "string") return null;
  const a = AVAX_ASSETS.find((x) => x.symbol === symbol);
  return a && assetEnabled(a, env) ? a : null;
}

/** An ENABLED asset by address (any casing; NATIVE_TOKEN = AVAX), or null. */
export function assetByAddress(address, env = viteEnv()) {
  if (typeof address !== "string") return null;
  if (EXCLUDED_ASSETS.some((x) => sameAddress(x.address, address))) return null;
  const a = AVAX_ASSETS.find((x) => x.address === address.toLowerCase());
  return a && assetEnabled(a, env) ? a : null;
}

/** The ERC-20s among the enabled assets (everything but native AVAX). */
export function erc20Assets(env = viteEnv()) {
  return whitelistAssets(env).filter((a) => !a.native);
}

/** Assets that need a swap back to USDC before they can leave Avalanche (every ERC-20 but USDC). */
export function needsSwapBack(a) {
  return !!a && !a.native && a.role !== "base";
}

/**
 * Compare the pin against a token list from Relay (`/currencies/v2` items:
 * {chainId, address, symbol, decimals}). Returns the problems (empty = agrees).
 * A pinned asset missing from the list is not a problem (lists are partial);
 * a DIFFERENT decimals or chain for a pinned address is.
 */
export function whitelistDrift(list) {
  const problems = [];
  if (!Array.isArray(list)) return ["not a token list"];
  for (const t of list) {
    if (!t || typeof t.address !== "string") continue;
    const pin = AVAX_ASSETS.find((a) => a.address === t.address.toLowerCase());
    if (!pin) continue;
    if (Number(t.chainId) !== 43114) problems.push(`${pin.symbol}: chain ${t.chainId}`);
    if (Number(t.decimals) !== pin.decimals) problems.push(`${pin.symbol}: decimals ${t.decimals} != ${pin.decimals}`);
  }
  return problems;
}
