// ─────────────────────────────────────────────────────────────────────────────
// WHICH CHIP A PERP LIVES UNDER. The owner's map — this file is meant to be
// edited by hand.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-23: "ขอเป็นหมวดด้วยดิ Perp: Crypto l Stock I Meme ... ใน Stock
// มีแบบ S&p500, Trad fi ต่างๆ" — the Perp list gets chips, and everything TradFi
// (shares, indices, metals, currencies) lives under Stock.
//
// Three categories, no more: crypto | meme | stock. Every market gets exactly
// one, and a market nobody mapped is crypto — the quiet default, so a coin
// listed tomorrow shows up in the list instead of vanishing from every chip.
//
// HOW A MARKET IS DECIDED, first answer wins:
//
//   1. PERP_CATEGORY_OVERRIDES by its full name ("xyz:BTC"), then by its bare
//      ticker ("BTC"). The escape hatch for anything the rules get wrong.
//   2. the VENUE's own category, when that venue is not a crypto venue. A TradFi
//      venue lists TSLA, GOLD, EUR and an index in one universe; naming them one
//      by one would go stale on the venue's next listing, and the venue already
//      knows what it is (lib/hyperliquid/venues.js HIP3_VENUES).
//      Deliberately ABOVE the meme list: a stock venue's SPX is the index, not
//      the frog.
//   3. PERP_MEME_COINS, matched on the bare ticker with Hyperliquid's 1000x "k"
//      prefix removed, so kPEPE is matched as PEPE.
//   4. crypto.
//
// The meme list is a judgement call, not a fact, which is exactly why it sits in
// one small file the owner can edit. Every name below was a live main-dex market
// on 2026-09-23 (scripts/fixtures/hl-meta-and-asset-ctxs.json).

/** The chips, in order. "all" is not a category: it is every category at once. */
export const PERP_CATEGORIES = Object.freeze(["crypto", "meme", "stock"]);

/** Bare tickers (no "k" prefix, no dex) that read as memes. Edit freely. */
export const PERP_MEME_COINS = Object.freeze([
  "PEPE", "WIF", "BONK", "FARTCOIN", "TRUMP", "PENGU", "POPCAT", "MOODENG",
  "GOAT", "PNUT", "BRETT", "MEW", "SPX", "DOGE", "SHIB", "FLOKI", "BOME",
  "TURBO", "NEIRO", "MELANIA", "HMSTR", "PEOPLE", "MEME", "PURR", "USELESS",
  "CASHCAT", "MOG", "BABYDOGE", "WOJAK", "GIGA",
]);

/**
 * The exceptions, by full market name or by bare ticker. A full name wins over a
 * ticker, so one venue's coin can differ from everybody else's.
 * Example: "xyz:BTC": "crypto" would pull a stock venue's bitcoin market back
 * under Crypto.
 */
export const PERP_CATEGORY_OVERRIDES = Object.freeze({
  /* Hyperliquid's own equity-style index and the metals are already Stock
     through their venue; nothing needs pinning here today. */
});

const MEMES = new Set(PERP_MEME_COINS.map((c) => String(c).toUpperCase()));

/* Hyperliquid lists 1000x-unit coins with a lowercase k (kPEPE, kBONK). Only a
   lowercase k before an uppercase letter is that prefix — KAITO keeps its K. */
const unK = (c) => (/^k[A-Z]/.test(c) ? c.slice(1) : c);

const known = (c) => (PERP_CATEGORIES.includes(c) ? c : null);

/**
 * The category of one market.
 * @param {string} coin the market name as Hyperliquid answers it ("BTC", "xyz:TSLA")
 * @param {{ dex?: string|null, base?: string|null, venueCategory?: string|null }} [opts]
 *   venueCategory is the listing venue's own category (venues.js); main-dex
 *   markets have none.
 * @returns {"crypto"|"meme"|"stock"}
 */
export function perpCategoryOf(coin, { dex = null, base = null, venueCategory = null } = {}) {
  const full = typeof coin === "string" ? coin : "";
  const bare = (base || (full.includes(":") ? full.slice(full.indexOf(":") + 1) : full) || "").trim();
  const byFull = known(PERP_CATEGORY_OVERRIDES[full]);
  if (byFull) return byFull;
  const byBare = known(PERP_CATEGORY_OVERRIDES[bare]);
  if (byBare) return byBare;
  const venue = known(venueCategory);
  if (venue && venue !== "crypto") return venue;
  if (MEMES.has(unK(bare).toUpperCase())) return "meme";
  return venue || "crypto";
}

/**
 * The markets of one chip. "all" (or anything unknown) is every market, in the
 * order it was given — the caller has already ranked them.
 */
export function filterPerpMarkets(markets, category) {
  const list = Array.isArray(markets) ? markets : [];
  if (!category || category === "all" || !PERP_CATEGORIES.includes(category)) return list;
  return list.filter((m) => m && m.category === category);
}

/** How many markets each chip would show: { all, crypto, meme, stock }. */
export function perpCategoryCounts(markets) {
  const out = { all: 0, crypto: 0, meme: 0, stock: 0 };
  for (const m of Array.isArray(markets) ? markets : []) {
    if (!m) continue;
    out.all++;
    if (Object.prototype.hasOwnProperty.call(out, m.category)) out[m.category]++;
  }
  return out;
}
