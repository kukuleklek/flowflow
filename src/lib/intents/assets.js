// ─────────────────────────────────────────────────────────────────────────────
// The assets, pairs and routes Private mode may quote, and exact unit arithmetic.
// PURE: no network, no env, no clock.
// ─────────────────────────────────────────────────────────────────────────────
//
// THE FIVE ASSETS. Each one checked against a live GET /v0/tokens on 2026-10-15
// (205 assets; the subset is scripts/fixtures/intents/tokens-subset.json):
//
//   HyperCore USDC  1cs_v1:hypercore:hip1:0x6d1e…e054   8 decimals. Credited to the
//                   recipient's PERPS balance (not spot, not HyperEVM). 🔴 The same
//                   list carries a second HyperCore "USDC" (erc20 0xb883…630f, 6
//                   decimals): that one is NOT the perps balance and is not ours.
//   Arbitrum USDC   nep141:arb-0xaf88…5831.omft.near            6 decimals (native USDC)
//   Avalanche USDC  nep245:v2_1.omni.hot.tg:43114_3atV…c47o     6 decimals (native 0xb97e…, not USDC.e)
//   Base USDC       nep141:base-0x8335…2913.omft.near           6 decimals (native USDC)
//   Polygon USDC    nep245:v2_1.omni.hot.tg:137_qiSt…Z6L        6 decimals (native 0x3c49…, not USDC.e 0x2791…)
//
// The contract addresses are written out here (not imported) so the intents
// proxy bundles nothing but this folder; scripts/test-intents-deposit.mjs holds
// them equal to lib/relay/routes.js and lib/relay/arbitrumBridge.js.
//
// THE PAIRS. Owner, 2026-10-15: "เอา ARB, Avax, Base, Polygon พอแระ" — the
// private origins (and the withdraw destinations) are EXACTLY those four USDC.
// Every quote the proxy forwards is one of these twelve, nothing else:
//
//   deposit   {Arbitrum, Avalanche, Base, Polygon} USDC → perps     (private-core)
//             {Arbitrum, Avalanche, Base, Polygon} USDC → Arbitrum  (private-arb: the
//                                       customer's own wallet; the auto-mover hops it)
//   withdraw  perps → {Arbitrum, Avalanche, Base, Polygon} USDC
//
// 🔴 EVM ORIGINS ONLY. A deposit's refundTo is the customer's own EVM address,
// which only exists on an EVM origin chain. A BTC or Solana origin would need a
// refund address the customer types, and that is not this version.

import { DEPOSIT_CHAINS } from "../relay/routes.js";
import { NEVER_A_DEPOSIT_ADDRESS, PRIVATE_RECOVER_READY } from "./config.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const HYPERCORE_USDC = Object.freeze({
  assetId: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
  blockchain: "hypercore",
  symbol: "USDC",
  decimals: 8,
  contractAddress: "0x6d1e7cde53ba9467b783cb7c530ce054",
  chainId: null,
  place: "perps",
  addressFormat: "evm",
});

export const ARBITRUM_INTENTS_USDC = Object.freeze({
  assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  blockchain: "arb",
  symbol: "USDC",
  decimals: 6,
  contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  chainId: 42161,
  place: "Arbitrum",
  addressFormat: "evm",
});

export const BASE_INTENTS_USDC = Object.freeze({
  assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  blockchain: "base",
  symbol: "USDC",
  decimals: 6,
  contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  chainId: 8453,
  place: "Base",
  addressFormat: "evm",
});

/* The two HOT-bridge (nep245) rows. Their ids are NOT derived from the contract
   (unlike nep141:<chain>-<contract>.omft.near): each was read off the live list,
   matched on blockchain, symbol, decimals AND contract, and intentsRouteProblems
   re-checks all four against every list it is given. */
export const AVALANCHE_INTENTS_USDC = Object.freeze({
  assetId: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
  blockchain: "avax",
  symbol: "USDC",
  decimals: 6,
  contractAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
  chainId: 43114,
  place: "Avalanche",
  addressFormat: "evm",
});

export const POLYGON_INTENTS_USDC = Object.freeze({
  assetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
  blockchain: "pol",
  symbol: "USDC",
  decimals: 6,
  contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  chainId: 137,
  place: "Polygon",
  addressFormat: "evm",
});

export const INTENTS_ASSETS = Object.freeze([HYPERCORE_USDC, ARBITRUM_INTENTS_USDC, AVALANCHE_INTENTS_USDC, BASE_INTENTS_USDC, POLYGON_INTENTS_USDC]);

/** The four chains' USDC, in the picker's order (Arbitrum first: its refunds move by themselves). */
export const PRIVATE_CHAIN_ASSETS = Object.freeze([ARBITRUM_INTENTS_USDC, AVALANCHE_INTENTS_USDC, BASE_INTENTS_USDC, POLYGON_INTENTS_USDC]);

/** The asset with this 1Click id, or null. */
export function intentsAssetById(id) {
  return INTENTS_ASSETS.find((a) => a.assetId === id) || null;
}

const pair = (origin, destination, direction) => Object.freeze({ origin: origin.assetId, destination: destination.assetId, direction });

export const INTENTS_PAIRS = Object.freeze([
  ...PRIVATE_CHAIN_ASSETS.map((a) => pair(a, HYPERCORE_USDC, "deposit")),
  ...PRIVATE_CHAIN_ASSETS.map((a) => pair(a, ARBITRUM_INTENTS_USDC, "deposit")),
  ...PRIVATE_CHAIN_ASSETS.map((a) => pair(HYPERCORE_USDC, a, "withdraw")),
]);

/** The pair for (origin, destination) ids, or null when it is not one Private mode quotes. */
export function intentsPairOf(originAssetId, destinationAssetId) {
  return INTENTS_PAIRS.find((p) => p.origin === originAssetId && p.destination === destinationAssetId) || null;
}

/* ── the routes a private deposit may come FROM ──────────────────────────────
   Same ids as lib/relay/routes.js, on purpose: the deposit watch, the status
   strip and the Agent's get_funds read a row's route by id (routeById), and the
   same id gives them the same chain name and token for the same money.

   WHERE A REFUND LANDS decides whether a route is offered. A refund goes back to
   refundTo on the ORIGIN chain, which is the customer's own embedded wallet:
     "auto-move"  Arbitrum: exactly where the auto-mover already picks USDC up
                  (≥ 5 USDC, with gas) and hops it into the Main Account.
     "spot"       Avalanche: the same EOA IS the Spot Account, which the app shows.
     "recover"    Base, Polygon: it sits there with no gas. Only the gasless
                  Recover path brings it back, so these two are offered only once
                  that path can sign (config.js PRIVATE_RECOVER_READY). */
function makePrivateRoute(id, asset, refundLands) {
  const chain = DEPOSIT_CHAINS[asset.chainId];
  return Object.freeze({
    id,
    provider: "near",
    chainId: asset.chainId,
    chainName: chain ? chain.name : asset.place,
    token: asset.symbol,
    address: asset.contractAddress,
    decimals: asset.decimals,
    intentsAsset: asset,
    logo: "/tokens/usdc.svg",
    chainLogo: chain ? chain.logo : null,
    explorer: chain ? chain.explorer : null,
    refundLands,
    refundAutoMoves: refundLands === "auto-move",
  });
}

export const PRIVATE_DEPOSIT_ROUTES = Object.freeze([
  makePrivateRoute("arbitrum-usdc", ARBITRUM_INTENTS_USDC, "auto-move"),
  makePrivateRoute("avalanche-usdc", AVALANCHE_INTENTS_USDC, "spot"),
  makePrivateRoute("base-usdc", BASE_INTENTS_USDC, "recover"),
  makePrivateRoute("polygon-usdc", POLYGON_INTENTS_USDC, "recover"),
]);
export const DEFAULT_PRIVATE_ROUTE_ID = "arbitrum-usdc";

/** The private route with this id (THIS table's object), or null. */
export function privateRouteById(id) {
  return PRIVATE_DEPOSIT_ROUTES.find((r) => r.id === id) || null;
}

/**
 * The private origins a screen may OFFER: every route whose refund has a way
 * back. A "recover" route only once the Recover path can sign (the one switch,
 * config.js PRIVATE_RECOVER_READY; `recoverReady` is for tests).
 */
export function privateDepositRoutesOffered({ recoverReady = PRIVATE_RECOVER_READY } = {}) {
  return PRIVATE_DEPOSIT_ROUTES.filter((r) => r.refundLands !== "recover" || recoverReady === true);
}

/** The offered route with this id, else the default (a stale or hidden id never stands). */
export function offeredPrivateRoute(id, { recoverReady = PRIVATE_RECOVER_READY } = {}) {
  const list = privateDepositRoutesOffered({ recoverReady });
  return list.find((r) => r.id === id) || list.find((r) => r.id === DEFAULT_PRIVATE_ROUTE_ID) || list[0] || null;
}

/**
 * Is `addr` a usable deposit address for an origin asset? Every origin this
 * folder quotes is EVM-shaped (the four chains and HyperCore), so: 20 bytes of hex,
 * not the zero address and not the 0x…dEaD burn address (config.js
 * NEVER_A_DEPOSIT_ADDRESS: money sent there cannot come back). The EIP-55
 * casing is checked by the verifiers (a mixed case that fails its checksum is a
 * corrupted answer), and so is "not a token contract".
 */
export function depositAddressShapeOk(addr, originAsset) {
  if (!originAsset || originAsset.addressFormat !== "evm") return false;
  return typeof addr === "string" && ADDRESS_RE.test(addr) && !NEVER_A_DEPOSIT_ADDRESS.includes(addr.toLowerCase());
}

/**
 * What in a /v0/tokens answer stops these assets, as readable lines. Empty: each
 * one is listed with the same blockchain, symbol, decimals and contract.
 */
export function intentsRouteProblems(tokens, assets = INTENTS_ASSETS) {
  if (!Array.isArray(tokens)) return ["no token list"];
  const out = [];
  for (const a of assets) {
    const t = tokens.find((x) => x && x.assetId === a.assetId);
    if (!t) { out.push(`${a.assetId}: not listed`); continue; }
    if (t.blockchain !== a.blockchain) out.push(`${a.assetId}: blockchain is ${t.blockchain}, not ${a.blockchain}`);
    if (t.symbol !== a.symbol) out.push(`${a.assetId}: symbol is ${t.symbol}, not ${a.symbol}`);
    if (t.decimals !== a.decimals) out.push(`${a.assetId}: decimals are ${t.decimals}, not ${a.decimals}`);
    if (String(t.contractAddress || "").toLowerCase() !== a.contractAddress) out.push(`${a.assetId}: contract is ${t.contractAddress}, not ${a.contractAddress}`);
  }
  return out;
}

/* ── exact units ─────────────────────────────────────────────────────────────
   BigInt in, BigInt out. Nothing here ever rounds: a figure that cannot be
   carried exactly is refused (plan §6.7: "8↔6 decimals use BigInt, never round"). */

const DIGITS = /^\d+$/;

/** A base-unit integer string ("25000000") as a BigInt, or null. */
export function rawOf(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v !== "string" || !DIGITS.test(v) || v.length > 60) return null;
  return BigInt(v);
}

/**
 * "12.5" with `decimals` → 12500000n (decimals 6). Refuses (throws RangeError)
 * a sign, an exponent, an empty part, or more fractional digits than the asset
 * carries — it never rounds them away.
 */
export function parseUnitsExact(text, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError("no usable decimals");
  const s = typeof text === "number" ? (Number.isFinite(text) ? String(text) : "") : String(text == null ? "" : text).trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s) || /^()\.(\d+)$/.exec(s);
  if (!m) throw new RangeError("not a plain decimal amount");
  const whole = m[1] || "0";
  const frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length > decimals) throw new RangeError(`more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac || "0").padEnd(decimals, "0"));
}

/** 12500000n with decimals 6 → "12.5" (no trailing zeros; "0" for zero). */
export function formatUnitsExact(raw, decimals) {
  if (typeof raw !== "bigint" || raw < 0n || !Number.isInteger(decimals) || decimals < 0) throw new RangeError("not a base-unit amount");
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = decimals ? (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * The same amount at another scale, EXACTLY. Up-scaling always works; scaling
 * down (8 → 6) throws a RangeError when digits would be lost — a sub-micro
 * remainder is refused, never rounded.
 */
export function rescaleExact(raw, fromDecimals, toDecimals) {
  if (typeof raw !== "bigint" || raw < 0n) throw new RangeError("not a base-unit amount");
  if (!Number.isInteger(fromDecimals) || !Number.isInteger(toDecimals) || fromDecimals < 0 || toDecimals < 0) throw new RangeError("no usable decimals");
  if (toDecimals >= fromDecimals) return raw * 10n ** BigInt(toDecimals - fromDecimals);
  const div = 10n ** BigInt(fromDecimals - toDecimals);
  if (raw % div !== 0n) throw new RangeError("the amount has digits the other side cannot carry");
  return raw / div;
}

/** Base units as a number for a SCREEN (never for arithmetic that moves money); null when not exact enough. */
export function unitsNumber(raw, decimals) {
  const r = typeof raw === "bigint" ? raw : rawOf(raw);
  if (r == null || !Number.isInteger(decimals)) return null;
  const n = Number(formatUnitsExact(r, decimals));
  return Number.isFinite(n) && n <= 1e12 ? n : null;
}
