// Hyperliquid perp → Tokenomist token id ("slug", the CoinGecko id in every case seen), checked by hand on
// 2026-10-15 (plan-avax/R-tokenomist.md §4: 34 of the top 45 perps by volume have a Tokenomist page, plus APT).
// A coin missing here is "not covered": nothing is guessed. Shared by the server proxy (api/tokenomist.js) and the
// browser (src/lib/tokenomist/client.js). Pure data, no imports.
//
// k-markets: Hyperliquid's kPEPE is PEPE in thousands. Its PRICE is per 1,000 tokens, so a token amount is valued
// at price / 1000 (priceDivisor).

export const TOKENOMIST_SLUGS = Object.freeze({
  BTC: "bitcoin",
  ETH: "ethereum",
  HYPE: "hyperliquid",
  SOL: "solana",
  ZEC: "zcash",
  NEAR: "near",
  PUMP: "pump-fun",
  ENA: "ethena",
  LIT: "lighter",
  SUI: "sui",
  STRK: "starknet",
  WLD: "worldcoin-wld",
  ONDO: "ondo-finance",
  ZRO: "layerzero",
  UNI: "uniswap",
  DOGE: "dogecoin",
  LINK: "chainlink",
  VVV: "venice-token",
  kPEPE: "pepe",
  TAO: "bittensor",
  AVAX: "avalanche-2",
  ARB: "arbitrum",
  XPL: "plasma",
  CRV: "curve-dao-token",
  AAVE: "aave",
  INJ: "injective-protocol",
  GRASS: "grass",
  MON: "monad",
  NIL: "nillion",
  OP: "optimism",
  PENGU: "pudgy-penguins",
  ADA: "cardano",
  TIA: "celestia",
  JUP: "jupiter-exchange-solana",
  APT: "aptos",
});

/** A Tokenomist token id as the upstream accepts it (and nothing else reaches its path). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isK = (coin) => /^k[A-Z0-9]/.test(coin);

/* Upper-case lookups: "ETH", "eth", "KPEPE", and the k-market's token name "PEPE" all find their market. */
const BY_UPPER = (() => {
  const m = new Map();
  for (const coin of Object.keys(TOKENOMIST_SLUGS)) {
    m.set(coin.toUpperCase(), coin);
    if (isK(coin)) m.set(coin.slice(1).toUpperCase(), coin);
  }
  return m;
})();

const BY_SLUG = new Map(Object.entries(TOKENOMIST_SLUGS).map(([coin, slug]) => [slug, coin]));

/** The Hyperliquid market name ("kPEPE") for what a person or the model typed ("pepe", "PEPE-USD"), or null. */
export function hlCoinFor(input) {
  if (typeof input !== "string") return null;
  const want = input.trim().toUpperCase().replace(/-USD$|-PERP$|\/USDC?$/, "");
  if (!/^[A-Z0-9]{1,16}$/.test(want)) return null;
  return BY_UPPER.get(want) || null;
}

/** The Tokenomist id for a market, or null when Tokenomist has no page for it. */
export function slugFor(coin) {
  const c = hlCoinFor(coin);
  return c ? TOKENOMIST_SLUGS[c] : null;
}

/** The market for a Tokenomist id, or null. */
export function coinForSlug(slug) {
  return typeof slug === "string" ? BY_SLUG.get(slug) || null : null;
}

/** Is this market covered by Tokenomist? */
export const isCovered = (coin) => slugFor(coin) != null;

/** The token's page on tokenomist.ai (attribution link), only for an id of OUR map. */
export function tokenomistPage(slug) {
  return typeof slug === "string" && BY_SLUG.has(slug) ? `https://tokenomist.ai/${slug}` : null;
}

/** 1000 for a k-market (price per 1,000 tokens), 1 otherwise. */
export const priceDivisor = (coin) => (typeof coin === "string" && isK(coin) ? 1000 : 1);

/** The token's own symbol for a market: "PEPE" for kPEPE. */
export const tokenSymbolOf = (coin) => (typeof coin === "string" && isK(coin) ? coin.slice(1) : coin);
