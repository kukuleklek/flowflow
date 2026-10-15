// ─────────────────────────────────────────────────────────────────────────────
// Stock logos: OUR files under /hip3-logos/, with a content version.
// ─────────────────────────────────────────────────────────────────────────────
//
// The set is the HIP-3 logo hand-over (2026-10-15): 115 SVGs filed
// "xyz-TSLA.svg" for the market "xyz:TSLA" (a colon cannot be a file name;
// coins.js hlLogoFileName is the same rule), originally snapshotted from
// app.hyperliquid.xyz/coins/{COIN}.svg. Every file passed the safety verdict in
// scripts/test-hip3-logos.mjs (no script, no handler, no reference that leaves
// the document), because these are third-party files served from our origin.
//
// Resolution, synchronous so a row paints its logo on its first frame:
//   1. a market in HIP3_LOGO_FILES  -> /hip3-logos/{file}?v=...
//   2. a market known to have none  -> null (the row draws its plate; no request
//      that is known to fail)
//   3. anything else qualified      -> null as well. Unlike logos.js there is no
//      fallback to Hyperliquid's URL: it sends no Cache-Control (measured
//      2026-09-22), and a stock listed tomorrow is not on the whitelist anyway.
// A main-dex coin is not this file's business: logos.js hlLogoUrl answers it.
//
// No CDN or company site is ever asked for a logo (plan Q8: trademarks).

import { splitHlMarket } from "../coins.js";
import { HIP3_LOGO_FILES, HIP3_LOGO_MISSING } from "./logoFiles.js";

export { HIP3_LOGO_FILES, HIP3_LOGO_MISSING };

export const HIP3_LOGO_DIR = "/hip3-logos/";

const has = (coin) => Object.prototype.hasOwnProperty.call(HIP3_LOGO_FILES, coin);

/** Does the set hold this market's logo? */
export function hasStockLogo(coin) {
  return splitHlMarket(coin).dex != null && has(coin);
}

/**
 * The logo URL for a HIP-3 market ("xyz:TSLA"), or null.
 * @returns {string|null}
 */
export function stockLogoUrl(coin) {
  const { dex, base } = splitHlMarket(coin);
  if (!dex || !base) return null;
  return has(coin) ? `${HIP3_LOGO_DIR}${HIP3_LOGO_FILES[coin]}` : null;
}
