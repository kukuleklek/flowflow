// FlowFlow's leverage ceiling for an order the Agent proposes, for a NEW position and for an ADD to one already held.
// PURE: the market row, the held position and the clock come in; nothing is read or sent.
//
// 🔴 AN ADD IS AN AGENT ORDER UNDER THE SAME CAPS (pass-2 review, finding 1). Hyperliquid adds to a position at the
// position's OWN leverage, so "long TSLA 20 3x" on a TSLA long opened at 10x in US hours (allowed then) went out on a
// Saturday at 10x — the card said 3x, the model's history said 3x, the send used 10x. Crypto the same: a BTC long held
// at 40x (opened on the trade page) plus "long BTC 20 5x" added $800 at 40x. So an add is refused, in plain words,
// whenever the position's leverage is above what FlowFlow would open now:
//   crypto  min(AGENT_MAX_LEVERAGE, the market's own max)
//   stock   min(AGENT_MAX_LEVERAGE, the market's own max), and CLOSED_AGENT_MAX_LEVERAGE while the US market is closed
// The same check runs where the card is made (runTool.js propose_open, respond.js) and again at the one send
// (TradeCard.jsx openNow), with the leverage the send would actually use.
import { AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { CLOSED_AGENT_MAX_LEVERAGE } from "../lib/hyperliquid/hip3/guard.js";
import { isStockCoin, stockKind, usSessionView, agentTicker } from "./stockWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * The highest leverage FlowFlow proposes on this market right now.
 * @param {{ coin: string, market?: object|null, now?: number }} o market: the live row (its maxLeverage)
 * @returns {{ max: number, binds: "agent"|"market"|"closed" }}
 */
export function agentLeverageCap({ coin, market = null, now = Date.now() } = {}) {
  const own = market && fin(market.maxLeverage) && market.maxLeverage >= 1 ? Math.floor(market.maxLeverage) : null;
  let max = AGENT_MAX_LEVERAGE;
  let binds = "agent";
  if (own != null && own < max) { max = own; binds = "market"; }
  if (isStockCoin(coin)) {
    const v = usSessionView(now, stockKind(coin) === "index" ? "index" : "stock");
    /* An unreadable calendar is treated as closed: the lower ceiling, never the higher one. */
    const closed = !v || !v.state ? true : !!v.leverageClosed;
    if (closed && CLOSED_AGENT_MAX_LEVERAGE < max) { max = CLOSED_AGENT_MAX_LEVERAGE; binds = "closed"; }
  }
  return { max: Math.max(1, max), binds };
}

/** The held position's leverage, or null when it is not known. */
export const heldLeverage = (pos) => (pos && pos.leverage && fin(pos.leverage.value) && pos.leverage.value > 0 ? pos.leverage.value : null);

/**
 * May the Agent add to this held position now? 🔴 An unknown leverage is refused too: the add would go out at a
 * leverage nobody has seen.
 * @param {{ coin: string, position: object, market?: object|null, now?: number, lang?: "en"|"th" }} o
 * @returns {{ ok: boolean, leverage: number|null, max: number, binds: string, text: string|null }}
 */
export function addCapCheck({ coin, position, market = null, now = Date.now(), lang = "en" } = {}) {
  const cap = agentLeverageCap({ coin, market, now });
  const lev = heldLeverage(position);
  if (lev != null && lev <= cap.max) return { ok: true, leverage: lev, max: cap.max, binds: cap.binds, text: null };
  const th = lang === "th";
  const name = isStockCoin(coin) ? agentTicker(coin) === "US100" ? "US 100" : agentTicker(coin) : String(coin || "");
  const side = position && (position.side === "short" || (fin(position.szi) && position.szi < 0)) ? "short" : "long";
  const why = cap.binds === "closed"
    ? (th ? `ตอนตลาด US ปิด FlowFlow เพิ่มหุ้นได้สูงสุด ${cap.max}x` : `FlowFlow adds at most ${cap.max}x on stocks while the US market is closed`)
    : (th ? `FlowFlow เพิ่มได้สูงสุด ${cap.max}x` : `FlowFlow adds at most ${cap.max}x`);
  const text = lev == null
    ? (th ? `อ่าน leverage ของ ${name} ที่ถืออยู่ไม่ได้ จึงไม่ออกการ์ดเพิ่ม ตั้ง TP / SL หรือปิดแทนได้` : `I can't read the leverage of your ${name} ${side}, so there's no add card. Set its TP / SL or close it instead.`)
    : (th ? `${name} ที่ถืออยู่ใช้ ${lev}x แต่${why} จึงไม่ออกการ์ดเพิ่ม ตั้ง TP / SL หรือปิดแทนได้` : `Your ${name} ${side} is at ${lev}x and ${why}, so there's no add card. Set its TP / SL or close it instead.`);
  return { ok: false, leverage: lev, max: cap.max, binds: cap.binds, text };
}

/**
 * 🔴 THE MARGIN THE ONE SEND USES, so the size rounds DOWN to the lot, never up (pass-2 review / EXECUTION K6): the
 * order layer sizes an order as margin × leverage ÷ price rounded to the NEAREST lot, so a 20 USDC card could buy a
 * little more than 20 USDC × leverage (ETH 20 USDC 5x → 0.0365 ETH = 20.0162 USDC of margin), and a stock's automatic
 * top-up, sized on the card's margin, could fall short of the rounded order. When the quote's size is above the size
 * the margin itself buys, the margin sent is the one whose size is the lot below. Never more than the card's margin.
 * @param {{ marginUsdc: number, leverage: number, szDecimals: number, quote: { size: number, refPx: number } }} o
 *   quote: the fresh quote at marginUsdc (useOrderQuote / perpBackend quoteOpen or quoteAdd)
 * @returns {number} the margin to send (marginUsdc itself when the nearest lot was already the lot below)
 */
export function sendMarginFor({ marginUsdc, leverage, szDecimals, quote } = {}) {
  if (!fin(marginUsdc) || marginUsdc <= 0 || !fin(leverage) || leverage <= 0 || !Number.isInteger(szDecimals) || !quote) return marginUsdc;
  const px = quote.refPx;
  const size = quote.size;
  if (!fin(px) || px <= 0 || !fin(size)) return marginUsdc;
  const lot = 10 ** -szDecimals;
  const floorSz = Math.floor((marginUsdc * leverage) / px / lot + 1e-9) * lot;
  if (!(floorSz > 0) || !(size > floorSz + lot / 2)) return marginUsdc;
  /* Six decimals (USDC's), floored: margin × leverage ÷ price is then a hair under the lot, which rounds to it. */
  return Math.min(marginUsdc, Math.floor(((floorSz * px) / leverage) * 1e6) / 1e6);
}
