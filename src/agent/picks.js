// THE PICK-4 CARD'S PRODUCER (item 12; owner: "ถามมันว่า วันนี้เทรดอะไรดี มีข่าวอะไรบ้าง แล้วมีเหรียญเด้งมาให้เลือก 4 อัน กลุ่มนั้นๆ
// (โชว์แต่กราฟ) แล้วพอเลือกเสร็จแม่ง ออก Propose Order ให้ต่อ"): which sentences ask for a pick, which ONE group answers,
// and the four markets in it. PURE: the market rows and the headlines come in; nothing is fetched or sent here.
// cards/PickCard.jsx draws the card (cards/pickView.js holds its rules); a tap says "Setups for TSLA" (with the side
// the user asked for) and the setups card proposes the order, which still waits for Confirm.
//
//   "วันนี้เทรดอะไรดี", "what should I trade today"   → the stronger of the crypto movers and the stocks (owner item 15:
//                                                     a stock group may be one of the picks only here)
//   "เลือกหุ้นให้หน่อย", "หุ้นตัวไหนดี", "Short a stock" → four stocks (by the side asked: falling most for a short)
//   "meme ตัวไหนดี", "Long a meme", "AI coins", "L1s"  → that crypto group
//   "มีข่าวอะไรบ้าง", "any news"                       → the markets the headlines name ("in the news"), else movers
//
// 🔴 ONE GROUP, FOUR TILES, NO VENUE WORDS: every tile a stock or every tile crypto, never mixed (pickView enforces it
// again), the line in the app's own words, and stocks only when the user asked about stocks or what to trade today
// (Top movers and the home boxes stay crypto). Headlines are third-party titles, shown as published with source, age
// and link; they never pick a market by themselves beyond naming it.
import { mainMarkets, stockMarkets } from "../trade/marketLists.js";
import { rankPerpMarkets, perpCategoryOf } from "../lib/hyperliquid/index.js";
import { findStockInText } from "../lib/hyperliquid/hip3/names.js";
import { marketsInNews } from "../lib/news/client.js";
import { findCoin } from "./shortcuts.js";
import { agentTicker } from "./stockWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const TH = /[฀-๿]/;
const langOf = (t) => (TH.test(String(t || "")) ? "th" : "en");

/** The crypto groups the owner named besides memes (owner-editable, like perpCategories.js). Bare tickers. */
export const PICK_GROUP_COINS = Object.freeze({
  ai: Object.freeze(["TAO", "FET", "RENDER", "VIRTUAL", "AI16Z", "WLD", "ARKM", "IO", "AIXBT", "GRASS", "ZEREBRO", "KAITO", "NIL", "PROMPT"]),
  l1: Object.freeze(["BTC", "ETH", "SOL", "HYPE", "AVAX", "SUI", "APT", "SEI", "TON", "NEAR", "ADA", "TIA", "INJ", "BERA", "S", "TRX", "DOT", "ATOM", "BNB"]),
  defi: Object.freeze(["AAVE", "UNI", "LDO", "CRV", "PENDLE", "ENA", "ONDO", "MKR", "COMP", "JUP", "SNX", "DYDX", "GMX", "MORPHO", "ETHFI", "EIGEN"]),
});

/** Markets thinner than this are never a tile (a 24h move on no volume is noise). */
export const PICK_MIN_VOLUME_USD = 1_000_000;
export const PICK_N = 4;

/* ── which sentences ask for a pick ─────────────────────────────────────────────────────────────────────────── */

const TODAY = /what\s+(?:should|can|do)\s+i\s+trade|what\s+to\s+trade|what(?:'s|\s+is)\s+good\s+to\s+trade|trade\s+today|วันนี้\s*(?:เทรด|เล่น|ซื้อ)\s*อะไร|(?:เทรด|เล่น)\s*อะไร\s*ดี|มีอะไรน่า\s*(?:เทรด|เล่น)/i;
const NEWS = /\b(?:any|what(?:'s|\s+is)?|the)\s+(?:latest\s+)?news\b|\bnews\s+today\b|\bin\s+the\s+news\b|\bheadlines?\b|มีข่าว|ข่าวอะไร|ข่าววันนี้|ข่าวล่าสุด/i;
const STOCK_WORD = /\b(?:stocks?|shares?|equit(?:y|ies))\b|หุ้น/i;
const MEME = /\bmemes?\b|\bmemecoins?\b|มีม/i;
const AI = /\bai\s*(?:coins?|tokens?|crypto|plays?|names?)\b|เหรียญ\s*ai|\bai\b(?=.*(?:ตัวไหน|which|pick|best))/i;
const L1 = /\b(?:l1s?|layer[\s-]*1s?)\b/i;
const DEFI = /\bdefi\b/i;
/* The words that make a group word a request to pick: a question, a side, "pick", "a meme". */
const PICKY = /ตัวไหน|อันไหน|เลือก|แนะนำ|น่า(?:เล่น|เทรด|ซื้อ)|\b(?:which|pick|choose|best|top|any|good|some)\b|\b(?:long|short|buy|sell)\s+(?:a|an|some)\b|\?/i;
const SIDE_BUY = /(^|\s)(long|buy|ลอง|ซื้อ)(?=\s|$)/i;
const SIDE_SELL = /(^|\s)(short|sell|ชอร์ต|ชอต|ขาย)(?=\s|$)/i;

/**
 * Is this sentence asking FlowFlow to pick a market? A sentence that names one market is not (that market's own
 * answer is better), nor is a long question (the model's).
 * @param {string} text
 * @param {{ coins?: string[] }} o the live main-market names
 * @returns {{ kind: "picks", group: "today"|"stocks"|"meme"|"ai"|"l1"|"defi"|"news", side: "buy"|"sell"|null,
 *   lang: "en"|"th" } | null}
 */
export function detectPick(text, { coins = [] } = {}) {
  const t = String(text || "").trim();
  if (!t) return null;
  const lang = langOf(t);
  if (lang === "th" ? t.length > 60 : t.split(/\s+/).length > 14) return null;
  const padded = ` ${t} `;
  const side = SIDE_SELL.test(padded) ? "sell" : SIDE_BUY.test(padded) ? "buy" : null;
  /* A named market (crypto or a listed stock's name) is that market's question, not a pick. The group words written in
     lower case are words, not tickers: "Long a meme" is the meme group, not the MEME market ("MEME" in capitals is). */
  const named = t.replace(/\b(?:memes?|memecoins?|ai|defi|l1s?)\b/g, " ");
  if (findCoin(named, coins) || findStockInText(t)) return null;
  if (STOCK_WORD.test(padded) && (PICKY.test(t) || side || TODAY.test(t))) return { kind: "picks", group: "stocks", side, lang };
  if (NEWS.test(t)) return { kind: "picks", group: "news", side, lang };
  const picky = PICKY.test(t) || !!side;
  if (MEME.test(t) && picky) return { kind: "picks", group: "meme", side, lang };
  if (AI.test(t) && picky) return { kind: "picks", group: "ai", side, lang };
  if (L1.test(t) && picky) return { kind: "picks", group: "l1", side, lang };
  if (DEFI.test(t) && picky) return { kind: "picks", group: "defi", side, lang };
  if (TODAY.test(t)) return { kind: "picks", group: "today", side, lang };
  return null;
}

/* ── which four ─────────────────────────────────────────────────────────────────────────────────────────────── */

const liquid = (m) => m && fin(m.dayNtlVlm) && m.dayNtlVlm >= PICK_MIN_VOLUME_USD && fin(m.change24hPct);
const bySide = (side) => (side === "sell" ? (a, b) => a.change24hPct - b.change24hPct
  : side === "buy" ? (a, b) => b.change24hPct - a.change24hPct
    : (a, b) => Math.abs(b.change24hPct) - Math.abs(a.change24hPct));
const bare = (coin) => String(coin || "").replace(/^k(?=[A-Z])/, "").toUpperCase();

/** The rows of one group, best first for the side asked (falling most for a short, rising most for a long, moving
 *  most otherwise). Held markets are left out (one position per market: a pick there could not open). */
export function groupRows(group, markets, { side = null, held = null } = {}) {
  const list = Array.isArray(markets) ? markets : [];
  const notHeld = (m) => !(held instanceof Set && held.has(m.coin));
  let rows;
  if (group === "stocks") rows = stockMarkets(list).filter((m) => fin(m.change24hPct));
  else if (group === "meme") rows = mainMarkets(list).filter((m) => liquid(m) && perpCategoryOf(m.coin) === "meme");
  else if (PICK_GROUP_COINS[group]) {
    const want = new Set(PICK_GROUP_COINS[group]);
    rows = mainMarkets(list).filter((m) => liquid(m) && want.has(bare(m.coin)) && perpCategoryOf(m.coin) !== "stock");
  } else {
    /* movers: the 40 most traded crypto markets (the Top movers list's own pool). */
    rows = rankPerpMarkets(mainMarkets(list).filter(liquid)).slice(0, 40);
  }
  return rows.filter(notHeld).slice().sort(bySide(side));
}

/** How strongly a group moves today: the mean |24h %| of its best four. */
const strength = (rows) => {
  const top = rows.slice(0, PICK_N).filter((m) => fin(m.change24hPct));
  return top.length ? top.reduce((s, m) => s + Math.abs(m.change24hPct), 0) / top.length : 0;
};

const LINES = Object.freeze({
  stocks: { en: ["Stocks moving most today. Pick one.", "Stocks rising most today. Pick one.", "Stocks falling most today. Pick one."], th: ["หุ้นที่ขยับแรงสุดวันนี้ เลือกมา 1 ตัว", "หุ้นที่ขึ้นแรงสุดวันนี้ เลือกมา 1 ตัว", "หุ้นที่ลงแรงสุดวันนี้ เลือกมา 1 ตัว"] },
  movers: { en: ["Biggest movers today. Pick one.", "Rising most today. Pick one.", "Falling most today. Pick one."], th: ["เหรียญที่ขยับแรงสุดวันนี้ เลือกมา 1 ตัว", "เหรียญที่ขึ้นแรงสุดวันนี้ เลือกมา 1 ตัว", "เหรียญที่ลงแรงสุดวันนี้ เลือกมา 1 ตัว"] },
  meme: { en: ["Meme coins moving most today. Pick one.", "Meme coins rising most today. Pick one.", "Meme coins falling most today. Pick one."], th: ["เหรียญมีมที่ขยับแรงสุดวันนี้ เลือกมา 1 ตัว", "เหรียญมีมที่ขึ้นแรงสุดวันนี้ เลือกมา 1 ตัว", "เหรียญมีมที่ลงแรงสุดวันนี้ เลือกมา 1 ตัว"] },
  ai: { en: ["AI coins moving most today. Pick one.", "AI coins rising most today. Pick one.", "AI coins falling most today. Pick one."], th: ["เหรียญ AI ที่ขยับแรงสุดวันนี้ เลือกมา 1 ตัว", "เหรียญ AI ที่ขึ้นแรงสุดวันนี้ เลือกมา 1 ตัว", "เหรียญ AI ที่ลงแรงสุดวันนี้ เลือกมา 1 ตัว"] },
  l1: { en: ["Layer 1s moving most today. Pick one.", "Layer 1s rising most today. Pick one.", "Layer 1s falling most today. Pick one."], th: ["Layer 1 ที่ขยับแรงสุดวันนี้ เลือกมา 1 ตัว", "Layer 1 ที่ขึ้นแรงสุดวันนี้ เลือกมา 1 ตัว", "Layer 1 ที่ลงแรงสุดวันนี้ เลือกมา 1 ตัว"] },
  defi: { en: ["DeFi moving most today. Pick one.", "DeFi rising most today. Pick one.", "DeFi falling most today. Pick one."], th: ["DeFi ที่ขยับแรงสุดวันนี้ เลือกมา 1 ตัว", "DeFi ที่ขึ้นแรงสุดวันนี้ เลือกมา 1 ตัว", "DeFi ที่ลงแรงสุดวันนี้ เลือกมา 1 ตัว"] },
  news: { en: ["In the news today. Pick one."], th: ["ตัวที่อยู่ในข่าววันนี้ เลือกมา 1 ตัว"] },
});
/* The line over the tiles. No side asked: the neutral "moving most" (Thai "ขยับแรงสุด": "วิ่งแรงสุด" reads as rising, and
   sat over four falling tiles), or the up / down line when all four tiles moved the same way. */
const lineOf = (group, side, lang, tiles = []) => {
  const l = (LINES[group] || LINES.movers)[lang === "th" ? "th" : "en"];
  let s = side;
  if (!s && tiles.length) {
    const ch = tiles.map((t) => t.changePct).filter(fin);
    if (ch.length === tiles.length && ch.every((c) => c > 0)) s = "buy";
    else if (ch.length === tiles.length && ch.every((c) => c < 0)) s = "sell";
  }
  return l[s === "buy" ? 1 : s === "sell" ? 2 : 0] || l[0];
};

/** The headline rows a pick card carries (pickView's shape), from /api/news items. */
export function pickHeadlines(items, { tiles = [], n = 2 } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.title === "string" && typeof it.url === "string");
  const named = new Set(marketsInNews(list, tiles).map((h) => h.market));
  /* Headlines naming a tile first, then the newest. */
  const score = (it) => (marketsInNews([it], tiles).some((h) => named.has(h.market)) ? 1 : 0);
  return list.slice().sort((a, b) => score(b) - score(a))
    .slice(0, n)
    .map((it) => ({ title: it.title, source: it.source, url: it.url, at: Date.parse(it.publishedAt) || null }));
}

/**
 * The pick card for an intent.
 * @param {{ group: string, side?: "buy"|"sell"|null, lang?: "en"|"th" }} intent detectPick()
 * @param {{ markets: object[], held?: Set<string>, news?: object[], usOpen?: boolean }} o markets: the live rows;
 *   news: /api/news items (topic crypto / stocks / market as the group needs; [] when none)
 * @returns {{ ok: true, card: object, group: string } | { ok: false, why: string }}
 */
export function buildPickCard(intent, { markets = [], held = null, news = [] } = {}) {
  const side = intent && (intent.side === "buy" || intent.side === "sell") ? intent.side : null;
  const lang = intent && intent.lang === "th" ? "th" : "en";
  let group = intent && intent.group ? intent.group : "movers";
  let rows = [];
  if (group === "news") {
    /* The markets the headlines name, of ONE kind (the kind named most), at most four; fewer than two: movers, with
       the headlines still shown. */
    const crypto = rankPerpMarkets(mainMarkets(markets)).slice(0, 120).map((m) => m.coin);
    const stocks = stockMarkets(markets).map((m) => m.coin);
    const hits = marketsInNews(news, [...crypto, ...stocks]);
    const stockHits = hits.filter((h) => h.market.includes(":"));
    const cryptoHits = hits.filter((h) => !h.market.includes(":"));
    const pick = stockHits.length > cryptoHits.length ? stockHits : cryptoHits;
    const byCoin = new Map((Array.isArray(markets) ? markets : []).map((m) => [m.coin, m]));
    rows = pick.map((h) => byCoin.get(h.market)).filter((m) => m && !(held instanceof Set && held.has(m.coin)));
    if (rows.length < 2) { group = "movers"; rows = groupRows("movers", markets, { side, held }); }
  } else if (group === "today") {
    const movers = groupRows("movers", markets, { side, held });
    const stocks = groupRows("stocks", markets, { side, held });
    group = stocks.length >= PICK_N && strength(stocks) > strength(movers) ? "stocks" : "movers";
    rows = group === "stocks" ? stocks : movers;
  } else {
    rows = groupRows(group, markets, { side, held });
  }
  const tiles = rows.slice(0, PICK_N).map((m) => ({ coin: m.coin, changePct: fin(m.change24hPct) ? m.change24hPct : null }));
  if (!tiles.length) return { ok: false, why: group === "stocks" ? "no-stocks" : "no-markets" };
  return {
    ok: true,
    group,
    card: {
      kind: "pick",
      group,
      side,
      line: lineOf(group, side, lang, tiles),
      headlines: pickHeadlines(news, { tiles: tiles.map((x) => x.coin) }),
      tiles,
      status: "review",
    },
  };
}

/** The words a tile says when tapped: the side the user asked for, and the ticker (never a venue name). */
export function pickTapWords(coin, side = null, label = null) {
  const name = label || agentTicker(coin);
  return side === "sell" ? `Short setups for ${name}` : side === "buy" ? `Long setups for ${name}` : `Setups for ${name}`;
}

/** The news topic a group's headlines come from. */
export const newsTopicFor = (group) => (group === "stocks" ? "stocks" : group === "news" ? "market" : "crypto");

/** The pick card in words, for the model's history. */
export function pickForModel(card) {
  if (!card || card.kind !== "pick") return "";
  const tiles = (card.tiles || []).map((t) => `${agentTicker(t.coin)}${fin(t.changePct) ? ` ${t.changePct >= 0 ? "+" : ""}${Math.round(t.changePct * 10) / 10}%` : ""}`);
  return `Showed a pick card (${card.group}${card.side ? `, ${card.side === "sell" ? "short" : "long"}` : ""}): ${tiles.join(", ")}. The user taps one to get its setups.`;
}
