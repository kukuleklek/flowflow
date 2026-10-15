// ─────────────────────────────────────────────────────────────────────────────
// What customers call a stock: "TSLA", "Tesla", "เทสล่า" -> "xyz:TSLA".
// ─────────────────────────────────────────────────────────────────────────────
//
// For the Agent (owner, 2026-10-15: "Agent AI จะเทรดหุ้นให้เป็นด้วย"): the
// model's coin argument and the user's own words both have to land on the ONE
// market FlowFlow lists for that company, or on nothing. Pure, no network.
//
//   resolveStock(name)       a single name the model passed ("TSLA", "tesla",
//                            "Apple", "แอปเปิ้ล", "S&P 500") -> the coin, or null.
//                            Call it AFTER the main-dex lookup fails: a crypto
//                            market of the same ticker always wins (none clash
//                            today, scripts/test-hip3-names.mjs pins that).
//   findStockInText(text)    the first whitelisted stock named in a sentence
//                            ("ซื้อ Tesla 10 ดอล", "long TSLA 10 3x") -> coin, or null.
//
// AMBIGUOUS WORDS ARE TICKERS ONLY IN CAPITALS. "coin", "oracle", "meta",
// "strategy", "hood" and "mu" are ordinary words in a trading chat ("which coin",
// "the oracle price"), so in free text they count only as the upper-case ticker
// (COIN, ORCL, META, MSTR, HOOD, MU); resolveStock, which gets one name on its
// own, accepts them in any case.
//
// "nasdaq" finds XYZ100 as a SEARCH convenience only: the deployer never calls
// XYZ100 Nasdaq-100 ("100 of the largest … non-financial companies"), so the
// Agent never says it is one; it says "US 100 index". "spx" is NOT an alias:
// SPX is a main-dex meme coin.

import { STOCK_WHITELIST } from "./whitelist.js";

/** coin -> extra names (lower case). The ticker and the whitelist name are implied. */
export const STOCK_ALIASES = Object.freeze({
  "xyz:SP500": ["s&p", "s&p500", "s&p 500", "sp500", "sp 500", "s and p", "เอสแอนด์พี", "เอสแอนด์พี 500", "ดัชนี s&p"],
  "xyz:XYZ100": ["xyz100", "us100", "us 100", "us tech 100", "nasdaq", "nasdaq100", "nasdaq 100", "แนสแด็ก", "แนสแดค", "นาสแดก"],
  "xyz:NVDA": ["nvidia", "เอ็นวิเดีย", "เอนวิเดีย", "เอ็นวิดิเอ"],
  "xyz:TSLA": ["tesla", "เทสล่า", "เทสลา"],
  "xyz:AAPL": ["apple", "แอปเปิ้ล", "แอปเปิล", "แอปเปิ้ล"],
  "xyz:MSFT": ["microsoft", "ไมโครซอฟท์", "ไมโครซอฟต์"],
  "xyz:GOOGL": ["google", "alphabet", "กูเกิล", "กูเกิ้ล", "อัลฟาเบท"],
  "xyz:AMZN": ["amazon", "อเมซอน", "แอมะซอน"],
  "xyz:META": ["facebook", "เมต้า", "เมตา", "เฟซบุ๊ก", "เฟสบุ๊ค"],
  "xyz:AMD": ["เอเอ็มดี"],
  "xyz:MU": ["micron", "ไมครอน"],
  "xyz:INTC": ["intel", "อินเทล"],
  "xyz:PLTR": ["palantir", "พาลันเทียร์", "พาแลนเทียร์"],
  "xyz:COIN": ["coinbase", "คอยน์เบส"],
  "xyz:HOOD": ["robinhood", "โรบินฮู้ด"],
  "xyz:MSTR": ["microstrategy", "ไมโครสแตรทิจี", "สแตรทิจี"],
  "xyz:ORCL": ["ออราเคิล", "โอราเคิล"],
  "xyz:NFLX": ["netflix", "เน็ตฟลิกซ์", "เนตฟลิกซ์"],
  "xyz:TSM": ["tsmc", "ทีเอสเอ็มซี"],
});

/* Ordinary words that are also tickers or names: in free text, upper-case ticker only. */
const AMBIGUOUS = new Set(["coin", "oracle", "meta", "strategy", "hood", "mu"]);

const norm = (s) => String(s == null ? "" : s).normalize("NFC").trim().toLowerCase()
  .replace(/^\$/, "").replace(/^หุ้น\s*/, "").replace(/(-perp|-usd|\/usdc?|\s+stock)$/i, "").replace(/\s+/g, " ");

/* name (lower case) -> coin, built once from the whitelist, its names and the aliases. */
const BY_NAME = new Map();
const TICKER = new Map();   // TICKER (upper) -> coin
for (const w of STOCK_WHITELIST) {
  const ticker = w.coin.slice(w.coin.indexOf(":") + 1);
  TICKER.set(ticker, w.coin);
  for (const n of [ticker, w.name, ...(STOCK_ALIASES[w.coin] || [])]) BY_NAME.set(norm(n), w.coin);
}

/**
 * One name -> the whitelisted stock it means, or null.
 * @param {string} name "TSLA", "xyz:TSLA", "Tesla", "เทสล่า", "หุ้น Apple"
 * @returns {string|null} "xyz:TSLA"
 */
export function resolveStock(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  const raw = name.trim();
  if (raw.includes(":")) return STOCK_WHITELIST.some((w) => w.coin === raw) ? raw : null;
  return BY_NAME.get(norm(raw)) || null;
}

const isLatin = (s) => /^[a-z0-9&\s.]+$/i.test(s);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Longest names first, so "s&p 500" wins over "s&p" and "microstrategy" over "strategy". */
const SCAN = [...BY_NAME.entries()]
  .filter(([n]) => !AMBIGUOUS.has(n))
  .sort((a, b) => b[0].length - a[0].length)
  .map(([n, coin]) => ({
    coin,
    re: isLatin(n) ? new RegExp(`(^|[^a-z0-9&])${escape(n)}($|[^a-z0-9&])`, "i") : new RegExp(escape(n)),
  }));

/**
 * The first whitelisted stock named in a sentence, or null.
 * Upper-case tickers count as written ("long TSLA", "COIN 10 3x"); company and
 * Thai names in any case; ambiguous words only as the upper-case ticker.
 * @param {string} text
 * @returns {string|null}
 */
export function findStockInText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const t = text.normalize("NFC");
  /* Tickers as written in capitals, whole words: earliest in the sentence wins. */
  let best = null;
  for (const [ticker, coin] of TICKER) {
    const m = new RegExp(`(^|[^A-Za-z0-9])\\$?${escape(ticker)}($|[^A-Za-z0-9])`).exec(t);
    if (m && (best == null || m.index < best.at)) best = { at: m.index, coin };
  }
  if (best) return best.coin;
  for (const s of SCAN) if (s.re.test(t)) return s.coin;
  return null;
}
