// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid coin logos — ours, first, cached.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner's iron rule: coin logos come FIRST, complete on the first painted frame,
// with no fade, and they are CACHED ("รูปก็ต้องเก็บใน Cache ด้วย กฎเหล็ก").
//
// Hyperliquid's own logo URL cannot meet it: measured 2026-09-22, it serves no
// Cache-Control and no CORS header, so the browser can neither keep it for long
// nor copy its bytes into the IndexedDB logo store. So the logos are snapshotted
// into perp-public/hl-coins/ by scripts/fetch-hl-coin-logos.mjs (copied into
// dist/hl-coins/ only by a flag-on build, vite.config.js), and this module
// hands out OUR URL with a content version: /hl-coins/BTC.svg?v=<hash>. The
// _headers rule for /hl-coins/* is a year, immutable — honest only because
// every URL built here carries that version (a changed file is a changed URL).
//
// EVERY MARKET, not only the main dex (owner, 2026-09-23: "เหรียญไหนไม่มีรูป
// เอารูปจาก Hyperliquid มาให้ครบ" — whatever has no picture gets its picture from
// Hyperliquid, completely). A HIP-3 market is named "xyz:TSLA", and its logo is
// served under exactly that qualified name: measured read-only 2026-09-23,
// /coins/xyz%3ATSLA.svg is an 880-byte image/svg+xml while the unqualified
// TSLA.svg is the app shell (200 text/html). Asking for the short name was why
// every Stock row used to fall back to its identicon.
//
// A logo whose SVG runs to megabytes (HMSTR's is 3.1 MB) is snapshotted as a
// 128 px PNG instead of being dropped, so it still arrives with its row and the
// phone downloads tens of kilobytes: the file name in the table says which, and
// nothing here needs to care beyond that (owner, 2026-09-23: png 128px).
//
// Resolution, synchronous so a row can paint its logo on its first frame:
//   1. a snapshotted market    -> /hl-coins/{FILE}?v=...  (BTC.svg, HMSTR.png,
//      xyz-TSLA.svg; the colon cannot be a file name, hlLogoFileName owns the
//      one mapping and the snapshot script writes the manifest with it)
//   2. a market KNOWN to have no usable logo at snapshot time -> null (no
//      request that is known to fail; the page shows its own plate)
//   3. a market listed after the snapshot -> Hyperliquid's URL, as a stopgap
//      until the script is rerun. The production CSP img-src allows that host
//      only in a flag-on build (vite.config.js); it is not cached (no
//      Cache-Control), so rerunning the script is the real fix.
//
// k-prefixed coins (kPEPE) use the plain ticker's file (PEPE.svg): Hyperliquid
// files them that way. hlLogoUrls() feeds a page's preload/decode gate (the
// ui.jsx preloadImage / TokenLogo src pattern) — nothing here fades anything.

import { HL_LOGO_FILES, HL_LOGO_NONE } from "./logoManifest.js";
import { hlLogoName, hlRemoteLogoName, isHlMarketName } from "./coins.js";

export const HL_LOGO_DIR = "/hl-coins/";
export const HL_REMOTE_LOGO_BASE = "https://app.hyperliquid.xyz/coins/";

const NONE = new Set(HL_LOGO_NONE);
const has = (coin) => Object.prototype.hasOwnProperty.call(HL_LOGO_FILES, coin);

/** Does the snapshot hold this market's logo? */
export function hasLocalHlLogo(coin) {
  return isHlMarketName(coin) && has(coin);
}

/**
 * The logo URL for a Hyperliquid market, or null when there is none to show.
 * @param {string} coin as Hyperliquid lists it ("BTC", "kPEPE", "xyz:TSLA")
 * @returns {string|null}
 */
export function hlLogoUrl(coin) {
  if (!isHlMarketName(coin)) return null;
  if (has(coin)) return `${HL_LOGO_DIR}${HL_LOGO_FILES[coin]}`;
  if (NONE.has(coin)) return null;
  return `${HL_REMOTE_LOGO_BASE}${encodeURIComponent(hlRemoteLogoName(coin))}.svg`;
}

/** The distinct logo URLs for a list of markets, in order, nulls dropped — for a preload gate. */
export function hlLogoUrls(coins) {
  const out = [];
  const seen = new Set();
  for (const c of coins || []) {
    const u = hlLogoUrl(c);
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

export { hlLogoName };
