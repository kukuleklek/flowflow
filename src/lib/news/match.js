// Does a headline name THIS coin or THIS stock? The one rule the news proxy (api/news.js) filters with and the
// browser (src/lib/news/client.js) reuses to see which listed markets a headline names. Pure, no network.
//
// 🔴 PRECISION OVER RECALL. A headline shown under HYPE that is really about "AI hype" is worse than no headline: the
// user reads it as news about the coin. So a ticker counts only as written by a newsroom: in CAPITALS, as a whole word
// ("HYPE rallies", "$HYPE"), never "hype", "Hyped" or "HYPER". Project names count in any case ("Hyperliquid",
// "bitcoin") when they are not ordinary words; ordinary words count only in the exact form a headline uses for the
// project ("Sui", "Ether", "Meta") or as a longer phrase ("Near Protocol", "Curve Finance"). Tickers that are also
// common capitals in a finance headline (DOGE = the US department, SPX = the S&P index, APT = a hacking group, OP,
// DOT, TRUMP, S) never count alone: only their $TICKER or a project name does.
//
// Stocks reuse the HIP-3 whitelist and its names (src/lib/hyperliquid/hip3/names.js, read only): the ticker in
// capitals, the company name, the Latin aliases. The words names.js treats as ambiguous in chat (coin, oracle, meta,
// strategy, hood, mu) count only as the capital ticker or a distinctive name ("Coinbase", "Robinhood", "Micron"),
// except "Meta" and "Oracle" written with a capital, which in a stock headline are the company.
//
// Indexes (SP500, XYZ100) are not matched by name at all: their news is the US market's headlines (api/news.js). The
// US 100 index is never called Nasdaq-100 (whitelist.js), so headlines that name the Nasdaq-100 are left out of it.

import { STOCK_WHITELIST } from "../hyperliquid/hip3/whitelist.js";
import { STOCK_ALIASES, resolveStock } from "../hyperliquid/hip3/names.js";

/**
 * Bare ticker -> how a headline names it. Hand-kept for the most traded main-dex perps (by 24h volume, 2026-10-15),
 * like perpCategories.js. A coin not listed here still matches its $TICKER, and its capital ticker when that is not a
 * finance acronym (ACRONYMS).
 *   names  phrases matched in any case, whole words
 *   exact  phrases matched only exactly as written (ordinary words in lower case)
 *   ticker false: the capital ticker alone never counts (only $TICKER or a name)
 *   not    phrases taken out before matching ("Bitcoin Cash" is not BTC)
 */
export const COIN_NEWS_NAMES = Object.freeze({
  BTC: { names: ["Bitcoin"], not: ["Bitcoin Cash", "Bitcoin SV", "Bitcoin Gold"] },
  ETH: { names: ["Ethereum"], exact: ["Ether"], not: ["Ethereum Classic", "Ether.fi", "Etherfi"] },
  HYPE: { names: ["Hyperliquid"] },
  ZEC: { names: ["Zcash"] },
  SOL: { names: ["Solana"] },
  NEAR: { names: ["Near Protocol"] },
  XRP: { names: ["XRP Ledger"], exact: ["Ripple"] },
  PEPE: { names: ["Pepe coin", "pepecoin"], exact: ["Pepe"] },
  TAO: { names: ["Bittensor"] },
  DOGE: { names: ["Dogecoin"], ticker: false },
  SUI: { exact: ["Sui"] },
  ENA: { names: ["Ethena"] },
  XMR: { names: ["Monero"] },
  UNI: { names: ["Uniswap"] },
  PUMP: { names: ["Pump.fun", "Pumpfun"], ticker: false },
  VVV: { names: ["Venice AI"] },
  ARB: { names: ["Arbitrum"] },
  XPL: { names: ["Plasma XPL"] },
  WLD: { names: ["Worldcoin", "World Network"] },
  LIT: { names: ["Lighter DEX", "Lighter exchange"] },
  AVAX: { exact: ["Avalanche"] },
  AAVE: { exact: ["Aave"] },
  FARTCOIN: { names: ["Fartcoin"] },
  LINK: { names: ["Chainlink"] },
  LTC: { names: ["Litecoin"] },
  ONDO: { names: ["Ondo Finance"], exact: ["Ondo"] },
  BNB: { names: ["BNB Chain", "Binance Coin"] },
  ADA: { names: ["Cardano"] },
  CRV: { names: ["Curve Finance", "Curve DAO"] },
  PENGU: { names: ["Pudgy Penguins"] },
  FIL: { names: ["Filecoin"] },
  JUP: { names: ["Jupiter Exchange", "Jupiter DEX"] },
  INJ: { names: ["Injective"] },
  FET: { names: ["Fetch.ai", "Artificial Superintelligence Alliance"] },
  TRUMP: { names: ["Trump memecoin", "Trump meme coin", "Official Trump", "TRUMP token"], ticker: false },
  ETHFI: { names: ["Ether.fi", "Etherfi"] },
  SPX: { names: ["SPX6900"], ticker: false },
  MON: { names: ["Monad"] },
  MORPHO: { exact: ["Morpho"] },
  STRK: { names: ["Starknet"] },
  XLM: { names: ["Stellar Lumens"], exact: ["Stellar"] },
  APT: { names: ["Aptos"], ticker: false },
  PENDLE: { exact: ["Pendle"] },
  SEI: { names: ["Sei Network"] },
  ZRO: { names: ["LayerZero"] },
  WIF: { names: ["dogwifhat"] },
  ICP: { names: ["Internet Computer"] },
  BONK: { exact: ["Bonk"] },
  SHIB: { names: ["Shiba Inu"] },
  BCH: { names: ["Bitcoin Cash"] },
  AR: { names: ["Arweave"], ticker: false },
  VIRTUAL: { names: ["Virtuals Protocol"], exact: ["Virtuals"] },
  POL: { names: ["Polygon"] },
  DOT: { names: ["Polkadot"], ticker: false },
  RENDER: { names: ["Render Network"] },
  HBAR: { names: ["Hedera"] },
  LDO: { names: ["Lido"] },
  JTO: { names: ["Jito"] },
  OP: { names: ["OP Mainnet", "Optimism network", "OP Stack", "Superchain"], ticker: false },
  TRX: { names: ["Tron"] },
  PAXG: { names: ["PAX Gold"] },
  ALGO: { names: ["Algorand"] },
  PYTH: { exact: ["Pyth"] },
  EIGEN: { names: ["EigenLayer", "EigenCloud"] },
  TIA: { names: ["Celestia"] },
  WLFI: { names: ["World Liberty Financial"] },
  KAS: { names: ["Kaspa"] },
  RUNE: { names: ["THORChain"] },
  POPCAT: { exact: ["Popcat"] },
  MNT: { names: ["Mantle network"], exact: ["Mantle"] },
  STX: { names: ["Stacks blockchain", "Stacks network"] },
  DYDX: { names: ["dYdX"] },
  ATOM: { names: ["Cosmos Hub"], exact: ["Cosmos"] },
  BERA: { names: ["Berachain"] },
  S: { names: ["Sonic Labs", "Sonic network"], ticker: false },
  TON: { names: ["Toncoin", "TON blockchain"] },
});

/** Capitals that are finance words, not coins: an unmapped coin of this name matches only as $TICKER. */
export const ACRONYMS = Object.freeze(new Set([
  "AI", "API", "ATH", "ATM", "BOE", "BOJ", "CEO", "CFO", "CFTC", "CPI", "CEX", "DAO", "DEX", "DOJ", "ECB", "EPS", "ETF",
  "ETFS", "EU", "FBI", "FDIC", "FED", "FOMC", "FX", "GDP", "IMF", "IPO", "IRS", "LLC", "NFT", "NYSE", "OTC", "PCE", "PPI",
  "SEC", "TVL", "UK", "UN", "US", "USA", "USD", "USDC", "USDT", "WSJ", "CEOS", "NEW", "TOP", "WHY", "HOW", "BIG", "ONE",
]));

/* Ordinary words that are also stock names: in a headline they count only as below (see the header). */
const STOCK_AMBIGUOUS = new Set(["coin", "oracle", "meta", "strategy", "hood", "mu"]);
/* Distinctive names headlines use that the chat aliases do not need. */
const STOCK_EXTRA = Object.freeze({
  "xyz:GOOGL": { names: ["GOOG"] },
  "xyz:AMZN": { names: ["AWS"] },
  "xyz:META": { names: ["Meta Platforms"], exact: ["Meta"] },
  "xyz:ORCL": { exact: ["Oracle"] },
  "xyz:MSTR": { names: ["Strategy Inc"] },
  "xyz:TSM": { names: ["Taiwan Semiconductor"] },
});

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/* Whole word: no letter or digit right before or after (an apostrophe, a dot, a dash or a space is a boundary). */
const wordRe = (phrase, flags = "") => new RegExp(`(^|[^A-Za-z0-9])${escape(phrase)}(?![A-Za-z0-9])`, flags);
const tickerRe = (t) => new RegExp(`(^|[^A-Za-z0-9$])${escape(t)}(?![A-Za-z0-9])`);
const dollarRe = (t) => new RegExp(`(^|[^A-Za-z0-9])\\$${escape(t)}(?![A-Za-z0-9])`, "i");

/** The bare ticker of a market name: "kPEPE" -> "PEPE", "xyz:TSLA" -> "TSLA", "hype" -> "HYPE". Null when unreadable. */
export function newsBase(coin) {
  if (typeof coin !== "string") return null;
  let s = coin.trim();
  const i = s.indexOf(":");
  if (i >= 0) s = s.slice(i + 1);
  if (/^k[A-Z0-9]{2,}$/.test(s)) s = s.slice(1);   // Hyperliquid's 1000x unit markets: kPEPE is PEPE
  s = s.toUpperCase();
  return /^[A-Z0-9]{1,20}$/.test(s) ? s : null;
}

/* One matcher per coin, built once and kept (a coin page asks again and again). */
const COIN_MATCHERS = new Map();
function coinMatcher(base) {
  if (COIN_MATCHERS.has(base)) return COIN_MATCHERS.get(base);
  const spec = Object.prototype.hasOwnProperty.call(COIN_NEWS_NAMES, base) ? COIN_NEWS_NAMES[base] : {};
  const tickerOk = spec.ticker !== false && !ACRONYMS.has(base) && (base.length >= 3 || Object.prototype.hasOwnProperty.call(COIN_NEWS_NAMES, base));
  const tests = [dollarRe(base)];
  if (tickerOk) tests.push(tickerRe(base));
  for (const n of spec.names || []) tests.push(wordRe(n, "i"));
  for (const n of spec.exact || []) tests.push(wordRe(n));
  const not = (spec.not || []).map((n) => new RegExp(escape(n), "gi"));
  const m = { tests, not };
  COIN_MATCHERS.set(base, m);
  if (COIN_MATCHERS.size > 500) COIN_MATCHERS.clear();
  return m;
}

/**
 * Does this headline name the crypto coin?
 * @param {string} title a headline (already cleaned)
 * @param {string} coin "HYPE", "kPEPE", "BTC"
 */
export function headlineMentionsCoin(title, coin) {
  const base = newsBase(coin);
  if (!base || typeof title !== "string" || !title) return false;
  const { tests, not } = coinMatcher(base);
  let t = title;
  for (const re of not) t = t.replace(re, " ");
  return tests.some((re) => re.test(t));
}

/* Stock coin -> matcher, from the whitelist (one per listed name). */
const STOCK_MATCHERS = new Map();
for (const w of STOCK_WHITELIST) {
  if (w.kind !== "stock") continue;
  const ticker = w.coin.slice(w.coin.indexOf(":") + 1);
  const tests = [tickerRe(ticker), dollarRe(ticker)];
  const extra = STOCK_EXTRA[w.coin] || {};
  const latin = [w.name, ...(STOCK_ALIASES[w.coin] || []), ...(extra.names || [])]
    .filter((n) => /^[A-Za-z0-9&. ]+$/.test(n) && n.length >= 3 && !STOCK_AMBIGUOUS.has(n.toLowerCase()));
  for (const n of new Set(latin.map((x) => x.toLowerCase()))) tests.push(wordRe(n, "i"));
  for (const n of extra.exact || []) tests.push(wordRe(n));
  STOCK_MATCHERS.set(w.coin, tests);
}

/**
 * Does this headline name the stock? Indexes always answer false: their news is not matched by name.
 * @param {string} title
 * @param {string} stock "TSLA", "xyz:TSLA", "Tesla"
 */
export function headlineMentionsStock(title, stock) {
  const coin = resolveStock(typeof stock === "string" ? stock : "");
  const tests = coin ? STOCK_MATCHERS.get(coin) : null;
  if (!tests || typeof title !== "string" || !title) return false;
  return tests.some((re) => re.test(title));
}

/** A headline that names the Nasdaq-100: kept away from the US 100 index, which is never called that. */
export const NASDAQ_100_RE = /nasdaq[\s-]*100|\bNDX\b/i;

/**
 * The listed markets a headline names (for "in the news" picks): crypto by COIN rules, "xyz:…" stocks by stock rules.
 * @param {string} title
 * @param {string[]} markets market names as the app lists them ("BTC", "kPEPE", "xyz:TSLA")
 * @returns {string[]} the ones named, in the order given
 */
export function marketsInHeadline(title, markets) {
  if (typeof title !== "string" || !title || !Array.isArray(markets)) return [];
  return markets.filter((m) => typeof m === "string" && (m.includes(":") ? headlineMentionsStock(title, m) : headlineMentionsCoin(title, m)));
}

/**
 * A ticker list dressed as a headline ("After Hours Most Active: MMED, RBLX, NVDA, VZ…", "…CRWV, MU, TSM, TSLA Stocks
 * In Focus"): it names the stock but says nothing about it, so a stock's news leaves it out. Three or more
 * comma-separated bare tickers make a list.
 */
export function isTickerRoundup(title) {
  if (typeof title !== "string") return false;
  return title.split(",").filter((seg) => /^\s*\$?[A-Z]{1,5}\s*$/.test(seg)).length >= 3;
}
