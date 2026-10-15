// The pick-4 card (item 12, owner: "มีเหรียญเด้งมาให้เลือก 4 อัน กลุ่มนั้นๆ (โชว์แต่กราฟ) แล้วพอเลือกเสร็จแม่ง ออก Propose Order ให้ต่อ"):
// what PickCard draws, made safe. PURE: no React, no network, no clock (the caller passes `now`).
//
// Card kind "pick" (the producer is the Agent's logic lane; this file only draws what it is given):
//   { kind: "pick", group: "stocks"|"movers"|"meme"|"ai"|"l1"|"defi"|"news", line: string,
//     headlines?: [{ title, source, url, at (ms) }], tiles: [{ coin, changePct?, candles? }], chosen?: coin }
//
// The rules held HERE, whatever the producer sends:
//   ONE GROUP     every tile is a stock, or every tile is crypto (the first tile decides); never mixed.
//   FOUR TILES    at most four, each market once. Fewer still draw (honest) and `complete` says so.
//   NO VENUE      the line is the app's own voice: a banned word (viewWords.js) and it is replaced by the group's
//                 plain line. Tiles show the ticker ("TSLA"), never "xyz:TSLA".
//   HEADLINES     at most two; title + source + age + an http(s) link, nothing else (copyright: no article text).
//                 A headline without a usable link or title is dropped, never shown unlinked.
import { coinLabel, isStockCoin, hasBannedWord, pctText, toneOfPct } from "./viewWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
export const PICK_TILES = 4;
export const PICK_HEADLINES = 2;
/** The mini chart reads the last day: 24 one-hour candles. */
export const PICK_BARS = 24;
const GROUPS = new Set(["stocks", "movers", "meme", "ai", "l1", "defi", "news"]);

/** The plain line per group, used when the producer's line is missing or carries a banned word. */
export const GROUP_LINE = Object.freeze({
  stocks: "Stocks moving most today. Pick one.",
  movers: "Biggest movers today. Pick one.",
  meme: "Meme coins moving today. Pick one.",
  ai: "AI coins today. Pick one.",
  l1: "Layer 1s today. Pick one.",
  defi: "DeFi today. Pick one.",
  news: "In the news today. Pick one.",
});

const clean = (s, n) => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!t) return "";
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** "4m", "3h", "2d" since `at`; null when unknown or in the future (a clock skew of a minute is "1m"). */
export function ageText(at, now) {
  if (!fin(at) || !fin(now)) return null;
  const s = (now - at) / 1000;
  if (s < -60) return null;
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** An http(s) link, or null. Anything else (javascript:, data:, relative) is never a link. */
export function safeHref(url) {
  if (typeof url !== "string" || url.length > 2048) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** The longest headline drawn (api/news.js TITLE_MAX): a longer one is left out, never cut (a headline is shown as it
 *  was published; the tile clamps lines with CSS, not words). */
export const HEADLINE_MAX = 300;

/** One headline as drawn: { title, source, age, href, key } or null. */
export function headlineView(h, now) {
  if (!h || typeof h !== "object") return null;
  const raw = typeof h.title === "string" ? h.title.replace(/\s+/g, " ").trim() : "";
  const title = raw.length <= HEADLINE_MAX ? raw : "";
  const href = safeHref(h.url);
  if (!title || !href) return null;
  let source = clean(h.source, 32);
  if (!source) { try { source = new URL(href).hostname.replace(/^www\./, ""); } catch { source = ""; } }
  return { title, source, age: ageText(h.at, now), href, key: href };
}

/**
 * The mini chart's paths in a w × h box: the closes as one line, and the same line closed down to the floor as the
 * faint area. dir: "up" when the last close is at or above the first candle's open.
 * @param {Array<{open:number, close:number}>} candles
 * @returns {{ line: string, area: string, dir: "up"|"down" } | null}  null: fewer than two usable closes
 */
export function sparkPaths(candles, { w = 120, h = 36, pad = 3, bars = PICK_BARS } = {}) {
  const list = (Array.isArray(candles) ? candles : []).filter((c) => c && fin(c.close)).slice(-bars);
  if (list.length < 2) return null;
  const closes = list.map((c) => c.close);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo;
  const step = w / (list.length - 1);
  const y = (v) => (span > 0 ? pad + ((hi - v) / span) * (h - 2 * pad) : h / 2);
  const r = (n) => Math.round(n * 100) / 100;
  const pts = closes.map((c, i) => `${r(i * step)},${r(y(c))}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${r(w)},${h}L0,${h}Z`;
  const first = fin(list[0].open) ? list[0].open : closes[0];
  return { line, area, dir: closes[closes.length - 1] >= first ? "up" : "down" };
}

/**
 * The card as drawn.
 * @param {object} card   kind "pick" (above)
 * @param {{ byCoin?: object, now?: number }} o  byCoin: the live market rows (the 24h % prefers the live one)
 * @returns {{ group: string, line: string, headlines: object[], tiles: object[], complete: boolean, stocks: boolean,
 *   chosen: string|null }}
 */
export function pickView(card, { byCoin = {}, now = null } = {}) {
  const c = card && typeof card === "object" ? card : {};
  const raw = (Array.isArray(c.tiles) ? c.tiles : []).filter((t) => t && typeof t.coin === "string" && t.coin.trim());
  const stocks = raw.length ? isStockCoin(raw[0].coin) : c.group === "stocks";
  const seen = new Set();
  const tiles = [];
  for (const t of raw) {
    if (tiles.length >= PICK_TILES) break;
    const coin = t.coin.trim();
    /* One group: a stock among crypto tiles (or the reverse) is dropped, never drawn beside them. */
    if (seen.has(coin) || isStockCoin(coin) !== stocks) continue;
    /* A "dex:NAME" market that is not a listed stock is no tile at all. */
    if (coin.includes(":") && !isStockCoin(coin)) continue;
    seen.add(coin);
    const m = byCoin && byCoin[coin] ? byCoin[coin] : null;
    const changePct = m && fin(m.change24hPct) ? m.change24hPct : fin(t.changePct) ? t.changePct : null;
    const candles = Array.isArray(t.candles) ? t.candles : null;
    const spark = candles ? sparkPaths(candles) : null;
    /* The colour follows the printed 24h % (so a "+0.4%" never sits on a red line); unknown %: the chart's own way. */
    const tone = toneOfPct(changePct) || (spark ? (spark.dir === "up" ? "pos" : "neg") : null);
    tiles.push({ coin, label: coinLabel(coin, m), changePct, changeText: pctText(changePct, changePct != null && Math.abs(changePct) >= 10 ? 1 : 2), tone, candles });
  }
  const group = GROUPS.has(c.group) ? c.group : stocks ? "stocks" : "movers";
  const own = clean(c.line, 120);
  const line = own && !hasBannedWord(own) ? own : GROUP_LINE[group];
  const headlines = (Array.isArray(c.headlines) ? c.headlines : [])
    .map((h) => headlineView(h, now))
    .filter(Boolean)
    .filter((h, i, a) => a.findIndex((x) => x.key === h.key) === i)
    .slice(0, PICK_HEADLINES);
  const chosen = typeof c.chosen === "string" && tiles.some((t) => t.coin === c.chosen) ? c.chosen : null;
  return { group, line, headlines, tiles, complete: tiles.length === PICK_TILES, stocks, chosen };
}

/** The words a pick says to the Agent when the caller has no onPick of its own: the ticker, so it proposes the order. */
export const pickWords = (coin, market = null) => `Setups for ${coinLabel(coin, market)}`;
