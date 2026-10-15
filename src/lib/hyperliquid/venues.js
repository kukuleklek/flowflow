// ─────────────────────────────────────────────────────────────────────────────
// HIP-3 venues: the perp dexes beside Hyperliquid's own, and the ASSET ID maths.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY. The owner asked for a Stock chip holding the TradFi markets (equities,
// indices, commodities, FX). Those do not exist on the main dex: they are listed
// by HIP-3 dexes, third parties who deploy their own perp market on Hyperliquid.
// Measured read-only 2026-09-23, POST /info {type:"perpDexs"} answers 11 entries
// whose FIRST is null (the main dex), and /info {type:"metaAndAssetCtxs",
// dex:"xyz"} answers the same [meta, assetCtxs] shape as the main dex: 123
// assets, 15 delisted, names arriving ALREADY qualified ("xyz:TSLA").
//
// THE ASSET ID IS THE DANGEROUS PART. The id an order carries is not the coin
// name; it is a number, and the SAME number means a different market on each
// dex (docs, for-developers/api/asset-ids):
//
//   main dex perp   the coin's index in meta.universe          (0 .. 9999)
//   spot            10000 + the spot pair index
//   HIP-3 perp      100000 + perpDexIndex * 10000 + the coin's index in THAT
//                   dex's universe
//   HIP-4 outcome   100000000 + (10 * outcome + side)
//
// So xyz:TSLA (index 1 of the xyz universe) is 110001, while the bare number 1
// is main-dex ETH. A table of dex indexes written down here would be a wrong
// order away from selling someone's ETH when they asked for Tesla, which is why
// hlAssetId() takes the index from the LIVE perpDexs answer every time and this
// file holds no index at all. An id that cannot be computed is null, and a row
// with a null id is dropped by markets.js rather than listed: unlisted is a
// disappointment, a wrong id is somebody's money.
//
// HIP-4 OUTCOMES ARE REFUSED here (ids from 100000000): they are prediction
// market legs, not perps, and nothing in this app is built to price one.
//
// FEES. Hyperliquid's own taker fee is the main dex's tier-0 rate (perp/mock/
// fees.js owns that number; MONEY_RULES section 1 wants one source for a
// figure, so this file carries only the MULTIPLIER). The docs give the HIP-3
// formula from the deployer's own fee scale: below 1 it is (scale + 1) times the
// base fee, at or above 1 it is (scale * 2). xyz ships deployerFeeScale "1.0",
// so its taker fee is twice Hyperliquid's own — the ~0.090% against ~0.045% the
// owner was told to expect. GROWTH MODE: the docs' own developer formula
// (trading/fees, "Fee formula for developers", read 2026-10-15) multiplies by
// growthModeScale = growthMode ? 0.1 : 1, so a growth-mode stock at scale 1.0 is
// 2 × 0.1 = 0.2 times the base: 0.009% at tier 0, the top of the docs' "between
// 0.0045%-0.009%" band and trade[XYZ]'s own "0.0090%" table. A NUMBER, not a dash
// (docs/PLAN-HIP3-STOCKS.md, patch P1). An unreadable scale is still a dash.
//
// Nothing here fetches, and nothing here runs at import time.

import { hlMarketBase } from "./coins.js";

/** Hyperliquid's own name for the main dex in an /info body: the empty string. */
export const HL_MAIN_DEX = "";

/**
 * The HIP-3 dexes this build lists, in chip order after the main dex.
 *
 * ONE LINE PER VENUE is the whole extension story: add { dex, category } and the
 * store fetches one more pair of calls for it, the rows carry its name, and its
 * coins land under the venue's own category. xyz is a TradFi venue, so its
 * equities, indices, commodities and FX all read as Stock, which is where the
 * owner wants TradFi ("ใน Stock มีแบบ S&p500, Trad fi ต่างๆ") — and xyz:SP500 is
 * listed there, live. A coin of any venue can still be pinned elsewhere by name
 * in perpCategories.js, so a crypto market on a stock venue is one line away.
 */
export const HIP3_VENUES = Object.freeze([
  Object.freeze({ dex: "xyz", category: "stock" }),
]);

/* The id ranges, from the docs (for-developers/api/asset-ids). */
export const HL_MAIN_ID_MAX = 10_000;        // exclusive: a main-dex id is under this
export const HL_SPOT_ID_BASE = 10_000;
export const HL_HIP3_ID_BASE = 100_000;
export const HL_HIP3_DEX_STRIDE = 10_000;
export const HL_OUTCOME_ID_BASE = 100_000_000;

const isIndex = (v) => Number.isSafeInteger(v) && v >= 0;

/** A main-dex perp id (0 .. 9999)? */
export const isHlMainAssetId = (id) => isIndex(id) && id < HL_MAIN_ID_MAX;

/** A spot id (10000 .. 99999)? Never a perp. */
export const isHlSpotAssetId = (id) => isIndex(id) && id >= HL_SPOT_ID_BASE && id < HL_HIP3_ID_BASE;

/** A HIP-3 perp id (100000 .. 99999999)? */
export const isHlHip3AssetId = (id) => isIndex(id) && id >= HL_HIP3_ID_BASE && id < HL_OUTCOME_ID_BASE;

/** A HIP-4 outcome id (100000000 and up)? Refused everywhere in the Perp mode. */
export const isHlOutcomeAssetId = (id) => isIndex(id) && id >= HL_OUTCOME_ID_BASE;

/**
 * The asset id an order must carry, or null when it cannot be computed safely.
 *
 * @param {{ dexIndex?: number|null, assetIndex: number }} a dexIndex 0 (or null)
 *   is the main dex; anything else is the position of that dex in the LIVE
 *   perpDexs answer. assetIndex is the coin's position in THAT dex's universe.
 * @returns {number|null}
 */
export function hlAssetId({ dexIndex = 0, assetIndex } = {}) {
  if (!isIndex(assetIndex) || assetIndex >= HL_MAIN_ID_MAX) return null;
  const d = dexIndex == null ? 0 : dexIndex;
  if (!isIndex(d)) return null;
  if (d === 0) return assetIndex;
  const id = HL_HIP3_ID_BASE + d * HL_HIP3_DEX_STRIDE + assetIndex;
  /* A dex far enough down the list would reach the outcome range; refuse rather
     than send an id that means a prediction market leg. */
  return isHlHip3AssetId(id) ? id : null;
}

/**
 * perpDexs -> the live dex order. Positions are kept EXACTLY as answered (entry
 * 0 is the main dex and is null in every answer measured), because the position
 * is the number the id maths needs.
 * @returns {{ list: Array<{ index: number, name: string, fullName: string|null }>,
 *   byName: Map<string, { index: number, name: string, fullName: string|null }>, count: number }}
 */
export function parsePerpDexs(json) {
  const list = [];
  const byName = new Map();
  if (!Array.isArray(json)) return { list, byName, count: 0 };
  json.forEach((e, index) => {
    if (!e || typeof e !== "object") return;
    const name = typeof e.name === "string" && e.name ? e.name : null;
    if (!name || index === 0) return;   // index 0 is the main dex, which has no name of its own
    const fullName = typeof e.fullName === "string" && e.fullName ? e.fullName : null;
    const row = Object.freeze({ index, name, fullName });
    list.push(row);
    if (!byName.has(name)) byName.set(name, row);
  });
  return { list, byName, count: json.length };
}

/**
 * The venues this build lists that are LIVE right now, with their index.
 * A configured venue missing from the answer is left out (never guessed at an
 * index); a venue is listed once, whatever the config repeats.
 * @param {any} dexsJson the perpDexs answer
 * @param {ReadonlyArray<{dex: string, category: string}>} [venues]
 * @returns {Array<{ dex: string, index: number, fullName: string|null, category: string }>}
 */
export function resolveVenues(dexsJson, venues = HIP3_VENUES) {
  const { byName } = parsePerpDexs(dexsJson);
  const out = [];
  const seen = new Set();
  for (const v of venues || []) {
    const name = v && typeof v.dex === "string" ? v.dex : null;
    if (!name || seen.has(name)) continue;
    const live = byName.get(name);
    if (!live) continue;
    seen.add(name);
    out.push({ dex: name, index: live.index, fullName: live.fullName, category: v.category || "crypto" });
  }
  return out;
}

/** Growth mode's fee factor (docs, trading/fees developer formula: growthModeScale). */
export const HIP3_GROWTH_FEE_SCALE = 0.1;

/**
 * How many times Hyperliquid's own taker fee this market charges.
 *
 * Docs (trading/fees, "Fee formula for developers"): a HIP-3 asset's fee follows
 * the deployer's fee scale — under 1 it is (scale + 1) times the base rate, at or
 * above 1 it is (scale * 2) — times growthModeScale, 0.1 in growth mode, else 1.
 *
 * @returns {{ multiplier: number|null, unknownReason: null|"unreadable" }}
 */
export function venueTakerFeeMultiplier({ isHip3 = false, feeScale = null, growthMode = false } = {}) {
  if (!isHip3) return { multiplier: 1, unknownReason: null };
  const s = typeof feeScale === "number" && Number.isFinite(feeScale) ? feeScale : null;
  if (s == null || s < 0) return { multiplier: null, unknownReason: "unreadable" };
  const m = (s < 1 ? s + 1 : s * 2) * (growthMode ? HIP3_GROWTH_FEE_SCALE : 1);
  return Number.isFinite(m) && m > 0 ? { multiplier: m, unknownReason: null } : { multiplier: null, unknownReason: "unreadable" };
}

/**
 * The taker fee of a market row as a fraction of notional, from the caller's own
 * base rate (perp/mock/fees.js HL_TAKER_FEE_RATE is that one source).
 * @returns {number|null} null when the venue's fee is unknown: show a dash.
 */
export function perpTakerFeeRate(market, baseRate) {
  const base = typeof baseRate === "number" && Number.isFinite(baseRate) && baseRate >= 0 ? baseRate : null;
  const mult = market && typeof market.takerFeeMultiplier === "number" ? market.takerFeeMultiplier : null;
  if (base == null || mult == null) return null;
  return base * mult;
}

/* NO NOTICE RIDES ON A VENUE MARKET (owner, 2026-09-23: take the party-label
   words off the rows, and no notices at all). The row chip and the market page's
   paragraph that used to be built here are gone, code and strings both. What
   stays is what a figure IS: the venue's NAME as a plain label in the market
   page's subtitle, and the fee above, whose dash is the figure itself when the
   multiplier is unknown (MONEY_RULES section 0) — never a number we cannot stand
   behind, and never a notice. */

/** The bare ticker a qualified market name carries ("xyz:TSLA" -> "TSLA"). */
export { hlMarketBase };
