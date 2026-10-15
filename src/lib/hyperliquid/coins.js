// Hyperliquid coin names, and the name a coin's logo is filed under.
//
// Kept apart from logos.js on purpose: scripts/fetch-hl-coin-logos.mjs needs
// the same naming rule BEFORE the logo table it generates exists, and one rule
// imported by both cannot drift.

/* Main-dex perp names are plain letters and digits (all 234 were, 2026-09-22).
   Anything else is refused here, so a coin name can never become a path. */
const COIN_RE = /^[A-Za-z0-9]{1,24}$/;

export function isHlCoinName(coin) {
  return typeof coin === "string" && COIN_RE.test(coin);
}

/* A HIP-3 market carries its dex in its name: Hyperliquid answers "xyz:TSLA"
   for every one of them, and that is the name candles, activeAssetCtx, fills and
   positions all use (measured read-only 2026-09-23). The dex key is lowercase
   letters and digits in every live answer. Kept apart from isHlCoinName on
   purpose: that one still guards a logo PATH, and a path may never hold a
   colon. */
const DEX_RE = /^[a-z0-9]{1,16}$/;

/**
 * A market name split into the dex that lists it and the bare ticker.
 * A main-dex coin has a null dex. An unreadable name answers a null base.
 * @returns {{ dex: string|null, base: string|null }}
 */
export function splitHlMarket(name) {
  const s = typeof name === "string" ? name : "";
  const i = s.indexOf(":");
  if (i < 0) return { dex: null, base: isHlCoinName(s) ? s : null };
  const dex = s.slice(0, i);
  const base = s.slice(i + 1);
  if (!DEX_RE.test(dex) || !isHlCoinName(base)) return { dex: null, base: null };
  return { dex, base };
}

/** The ticker to SHOW for a market name: "xyz:TSLA" reads as "TSLA". */
export function hlMarketBase(name) {
  const { base } = splitHlMarket(name);
  return base || (typeof name === "string" ? name : "");
}

/** Is this a market this app can route to — a main-dex coin, or a HIP-3 "dex:COIN"? */
export function isHlMarketName(name) {
  return splitHlMarket(name).base != null;
}

/**
 * The logo file name for a coin. Hyperliquid lists 1000x-unit coins with a
 * lowercase k (kPEPE, kBONK, kSHIB ...) but files their logos under the plain
 * ticker: measured 2026-09-22, PEPE.svg is an image and kPEPE.svg is the app
 * shell. Only a lowercase k followed by an uppercase letter is that prefix.
 */
export function hlLogoName(coin) {
  const c = String(coin == null ? "" : coin);
  return /^k[A-Z]/.test(c) ? c.slice(1) : c;
}

/**
 * The one character that stands in for the colon of a qualified market name in
 * a logo FILE name: "xyz:TSLA" is filed as "xyz-TSLA.svg".
 *
 * A colon cannot be the file name itself. It is reserved in a URL path segment
 * on some servers, and on Windows it is not a legal name at all, so a snapshot
 * that used one would be a snapshot that cannot be checked out. The hyphen is
 * safe in both and is unambiguous here: a dex key is lowercase letters and
 * digits (DEX_RE) and a ticker is letters and digits (COIN_RE), so neither side
 * can contain one, the FIRST hyphen is always the separator, and a main-dex file
 * — which has no hyphen at all — can never collide with a venue's.
 */
export const HL_LOGO_DEX_SEP = "-";

/**
 * The two extensions a snapshotted logo may wear. An SVG is what Hyperliquid
 * serves; a PNG is what the snapshot script writes instead when that SVG is too
 * heavy to put in front of a phone (owner, 2026-09-23: "แก้ให้เป็น png 128px"),
 * so the picture is complete either way. Nothing else is a logo file.
 */
export const HL_LOGO_EXTS = Object.freeze(["svg", "png"]);

/**
 * The file a market's logo is snapshotted as, or null when the name is not one
 * this app will route to (so a name can never become a path).
 *
 *   "BTC"       -> "BTC.svg"
 *   "kPEPE"     -> "PEPE.svg"      (hlLogoName: Hyperliquid files it that way)
 *   "xyz:TSLA"  -> "xyz-TSLA.svg"
 *   "HMSTR", "png" -> "HMSTR.png"  (its SVG is 3.1 MB; the snapshot rasterises it)
 *
 * The k rule is the MAIN DEX's, measured there and nowhere else, so a venue's
 * ticker keeps every letter it was listed with. The extension never comes from
 * anything a server said — the caller passes "svg" or "png" and nothing else is
 * accepted, so a content type can never choose a file name.
 *
 * @param {string} name a market name as Hyperliquid lists it
 * @param {string} [ext] "svg" (default) or "png"
 * @returns {string|null}
 */
export function hlLogoFileName(name, ext = "svg") {
  const { dex, base } = splitHlMarket(name);
  if (!base || !HL_LOGO_EXTS.includes(ext)) return null;
  return dex ? `${dex}${HL_LOGO_DEX_SEP}${base}.${ext}` : `${hlLogoName(base)}.${ext}`;
}

/**
 * The name to ASK Hyperliquid for when there is no snapshot of a market yet.
 *
 * Measured read-only 2026-09-23: app.hyperliquid.xyz/coins/xyz%3ATSLA.svg is an
 * 880-byte image/svg+xml, while the unqualified TSLA.svg is the app shell
 * (200 text/html). A venue's logo lives under its QUALIFIED name, so that is the
 * name that gets asked for; only a main-dex coin drops its k.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function hlRemoteLogoName(name) {
  const { dex, base } = splitHlMarket(name);
  if (!base) return null;
  return dex ? `${dex}:${base}` : hlLogoName(base);
}
