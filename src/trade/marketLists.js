// Pure list logic for the markets screen: which rows, in which order. No React, no network.
import { rankPerpMarkets, perpCategoryOf } from "../lib/hyperliquid/index.js";
import { STOCK_WHITELIST } from "../lib/hyperliquid/hip3/whitelist.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** Hyperliquid's own perps only: the Perps list, Top movers and the Agent's picks. Stocks have their own filter. */
export function mainMarkets(markets) {
  return (markets || []).filter((m) => !m.isHip3);
}

/* The Stock filter (owner, 2026-10-15: "เพิ่มเข้าไปใน นี้เลย ชื่อ Stock"): the whitelisted stock perps
   (lib/hyperliquid/hip3/whitelist.js, docs/PLAN-HIP3-STOCKS.md §0.2), by 24h volume. The store's rows carry volume
   and open interest, so the live gate here is those two; the spread and OI-cap halves need the two fields patch P3a
   adds to markets.js. A name that falls under the gate is not listed (its position still shows and can be closed). */
const STOCK_NAMES = new Map(STOCK_WHITELIST.map((w) => [w.coin, w.name]));
const STOCK_MIN_VOLUME_USD = 5_000_000;
const STOCK_MIN_OI_USD = 5_000_000;

/** The company or index name of a whitelisted stock market ("xyz:TSLA" -> "Tesla"), or null. */
export const stockName = (coin) => STOCK_NAMES.get(coin) || null;

export function stockMarkets(markets) {
  return (markets || [])
    .filter((m) => m && m.isHip3 && STOCK_NAMES.has(m.coin)
      && fin(m.px) && m.px > 0
      && fin(m.dayNtlVlm) && m.dayNtlVlm >= STOCK_MIN_VOLUME_USD
      && fin(m.openInterestUsd) && m.openInterestUsd >= STOCK_MIN_OI_USD)
    .sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
}

export const FILTERS = Object.freeze([
  { value: "trending", label: "Trending" },
  { value: "gainers", label: "Gainers" },
  { value: "losers", label: "Losers" },
  { value: "funding", label: "Funding" },
  { value: "meme", label: "Meme" },
  { value: "stock", label: "Stock" },
]);

/** The rows for a chip, a search and (optionally) a watchlist. */
export function filterMarkets(markets, { filter = "trending", query = "", watch = null } = {}) {
  let rows = filter === "stock" ? stockMarkets(markets) : mainMarkets(markets);
  if (watch) rows = rows.filter((m) => watch.has(m.coin.toLowerCase()));
  const q = query.trim().toLowerCase();
  if (q) {
    rows = rows.filter((m) => m.coin.toLowerCase().includes(q) || String(m.label || "").toLowerCase().includes(q)
      || String(stockName(m.coin) || "").toLowerCase().includes(q));
  }
  const liquid = (m) => fin(m.dayNtlVlm) && m.dayNtlVlm >= 250_000;
  switch (filter) {
    case "gainers":
      return rows.filter((m) => liquid(m) && fin(m.change24hPct)).sort((a, b) => b.change24hPct - a.change24hPct);
    case "losers":
      return rows.filter((m) => liquid(m) && fin(m.change24hPct)).sort((a, b) => a.change24hPct - b.change24hPct);
    case "funding":
      return rows.filter((m) => liquid(m) && fin(m.funding)).sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding));
    case "meme":
      return rankPerpMarkets(rows.filter((m) => perpCategoryOf(m.coin) === "meme"));
    case "stock":
      return rows;
    default:
      return rankPerpMarkets(rows);
  }
}

/** The biggest 24h moves among the 40 most traded markets. */
export function topMovers(markets, n = 6) {
  return rankPerpMarkets(mainMarkets(markets))
    .slice(0, 40)
    .filter((m) => fin(m.change24hPct))
    .sort((a, b) => Math.abs(b.change24hPct) - Math.abs(a.change24hPct))
    .slice(0, n);
}

/** "BTC" for "BTC", the ticker for a venue name. */
export const marketLabel = (m) => (m && (m.label || m.coin)) || "";
