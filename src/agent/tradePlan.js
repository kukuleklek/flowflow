// THE TRADE PLAN (plan_trade; owner items 13, 14, 16): free-form context in, a sized order out, ALL THE MATHS IN CODE.
// Owner: "มีเงินอยู่ 300 ยอมเสียได้ 15 ดอล เล่น RR ตั้ง TP SL เท่าไหร่ดี Short กับเหรียญ XXX แล้วคิดออกมาได้เลย" and "ดอลเดียวก็ควรได้ปะ".
// There is no Pro mode: one chat, and whatever the user states (risk in $ or %, balance, RR, side, stop, leverage,
// margin, "safe") is folded into one plan. The model never does arithmetic: it calls plan_trade and reads the answer.
//
//   stop      the user's (a price or a % away), else the last 1h swing low / high past 0.75–3 ATR (with a quarter-ATR
//             buffer), else 1.5 × ATR (2 × when "safe"). ATR: the 14-bar average true range of 1h candles; a STOCK
//             uses only the candles of US market hours (hip3/hours.js coreSessionCandles: a weekend bar is a third of a
//             trading day's, and a stop sized on it sits inside Monday's gap). Fewer than 14 bars: no stop (no guess).
//   size      risk ÷ (stop distance + the fees of the entry and of the exit at the stop), rounded DOWN to the lot;
//             with no risk: the user's margin × leverage; with nothing at all, the setups' default margin.
//   leverage  the LOWEST whole leverage at which the margin fits (≤ 20 USDC, ≤ the free margin); never past the caps,
//             and lowered until liquidation sits at least LIQ_BUFFER (2) × the stop distance from the entry (the same
//             rule as the setups, PLAN_LIQ_BUFFER, so the stop always fires before liquidation).
//   TP        entry ± RR × the stop distance (RR 2 unless the user said otherwise), or the user's own TP.
//   prices    on Hyperliquid's tick (≤ 5 significant figures, ≤ 6 − szDecimals decimals): the stop rounded TOWARD the
//             entry (the loss can only shrink), the TP to the nearest tick.
//
// 🔴 THE CAPS ARE CODE, NOT PROSE: ≤ 20 USDC margin per order (guardrails.js), the Agent ≤ 10x, a stock ≤ min(10, its
// market's max) and ≤ 5x while the US market is shut (hip3/guard.js checkStockOrder decides, by "agent"), "safe" ≤ 3x,
// ≥ $10 notional, isolated always. When the user's numbers need more than a cap allows, the plan is the CAPPED
// version and says so with the real risk it carries ("Max 20 USDC margin per order: this risks $4.31, not $15").
// Never a silent change: every number that differs from what the user said is in `capped` or `warnings`.
//
// 🔴 NOTHING HERE SENDS. A plan becomes a normal trade card (planToOpenCard) that waits for the user's Confirm, and
// the final chart popup is the only place an order goes out. planTrade is pure; planTradeFor only reads (candles).
import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { estIsolatedLiqPx, HL_MIN_ORDER_USD } from "../perp/perpTicket.js";
import { perpMarketFeeRate, perpFeeRateFor } from "../perp/live/perpLiveView.js";
/* The tick and lot rounding the order itself uses, without importing the order code here (planTicks.js says why). */
import { planOrderPx as roundHlOrderPx, planSize as roundHlSize, PLAN_SLIPPAGE as HL_DEFAULT_SLIPPAGE } from "./planTicks.js";
import { formatHlPrice, formatHlSize } from "../lib/hyperliquid/format.js";
import { checkStockOrder, STOCK_GUARD_TEXT, CLOSED_AGENT_MAX_LEVERAGE } from "../lib/hyperliquid/hip3/guard.js";
import { coreSessionCandles, usEquitySession, nextRegularOpen } from "../lib/hyperliquid/hip3/hours.js";
import { resolveStock } from "../lib/hyperliquid/hip3/names.js";
import { mainMarkets, stockMarkets, stockName } from "../trade/marketLists.js";
import { cleanCandles, trendOf, leanSide, LIQ_BUFFER, SETUP_MAX_LEVERAGE, DEFAULT_SETUP_MARGIN_USDC, SETUP_INTERVAL, SETUP_BARS } from "./setups.js";
import { swingPoints } from "./analyze.js";
import { DEFAULT_RISK_PCT, ASK } from "./riskParse.js";
import { statusText, usSessionView, stockKind } from "./stockWords.js";

export const PLAN_INTERVAL = SETUP_INTERVAL;
/** 1h bars read for a crypto plan (the setups' own read: the same cache entry). */
export const PLAN_BARS = SETUP_BARS;
/** 1h bars read for a stock: a week, so at least 14 of them fall in US market hours (hip3 brief §3). */
export const STOCK_PLAN_BARS = 168;
export const ATR_BARS = 14;
export const DEFAULT_RR = 2;
/** The stop in ATRs when nothing better is there: Balanced, and "safe". */
export const STOP_ATR = 1.5;
export const SAFE_STOP_ATR = 2;
/** A swing level is the stop when it sits this many ATRs from the entry (a nearer one is noise, a farther one too wide). */
export const SWING_MIN_ATR = 0.75;
export const SWING_MAX_ATR = 3;
/** How far past the swing level the stop goes. */
export const SWING_BUFFER_ATR = 0.25;
/** A user's stop closer than this many ATRs is flagged (it sits inside a normal hour's move). */
export const TIGHT_STOP_ATR = 0.5;
/** A stop this far away (share of the price) is no stop. */
export const MAX_STOP_FRAC = 0.5;
/**
 * Liquidation sits at least this many stop distances from the entry (the setups' LIQ_BUFFER, so a plan and a setup
 * answer the same rule): the stop is always hit first, with one more stop distance of room before liquidation.
 */
export const PLAN_LIQ_BUFFER = LIQ_BUFFER;
/** The most leverage a "safe" plan carries (the setups' own ceiling). */
export const SAFE_MAX_LEVERAGE = SETUP_MAX_LEVERAGE;
/**
 * 🔴 THE $10 MINIMUM IS CHECKED AT SEND TIME, NOT NOW, and on the LOWER of the mid and the order's own IOC price
 * (exchange/orders.js checkOpenMinimum): a short's price is the mid less the 5% slippage. So the smallest plan is
 * $10 grossed up by that slippage on a short and by 2% everywhere for the price moving before the user confirms.
 */
export const MIN_NOTIONAL_BUFFER = 0.02;
/** The fee when the market's fee is unknown: Hyperliquid's base taker fee plus the largest builder fee (an upper bound:
 *  100 tenths of a basis point, Hyperliquid's perp cap), through perpLiveView's own rate helper (only src/perp may
 *  import the mock's fee table: scripts/test-perp-mock.mjs L3). */
export const FALLBACK_FEE_RATE = perpFeeRateFor({ enabled: true, f: 100 });
export const PLAN_BASIS = "1h candles · ATR 14 · swing stops";
export const STOCK_PLAN_BASIS = "1h candles in US market hours · ATR 14";
const READ_TIMEOUT_MS = 8000;

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => (fin(v) && v > 0 ? v : null);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);
const floor2 = (v) => Math.floor(v * 100 + 1e-9) / 100;
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/* ── market maths (pure) ─────────────────────────────────────────────────────────────────────────────────────── */

/** The average true range of the last n bars (the first of them uses its own high − low); null with fewer than n. */
export function planAtr(candles, n = ATR_BARS) {
  const bars = cleanCandles(candles);
  if (bars.length < n) return null;
  const last = bars.slice(-n);
  let sum = 0;
  last.forEach((b, i) => {
    const prev = i > 0 ? last[i - 1].close : bars.length > n ? bars[bars.length - n - 1].close : null;
    sum += prev == null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  const atr = sum / n;
  return atr > 0 ? atr : null;
}

/* The lot rounding as a number: DOWN for a planned size (never more risk than asked), UP for the minimum. */
const sizeDown = (sz, d) => Number(roundHlSize(Math.max(0, sz), d, "down") || 0);
const sizeUp = (sz, d) => Number(roundHlSize(Math.max(0, sz), d, "up") || 0);

/**
 * The stop distance (price units) a plan uses, and where it came from. The user's stop wins; else the last swing
 * past SWING_MIN_ATR..SWING_MAX_ATR; else k × ATR.
 */
export function planStop({ side, entry, candles, stopPx = null, stopPct = null, style = null } = {}) {
  const buy = side === "buy";
  const atr = planAtr(candles);
  if (pos(stopPx)) {
    const d = buy ? entry - stopPx : stopPx - entry;
    if (!(d > 0)) return { ok: false, why: "stop-wrong-side" };
    return { ok: true, d, from: "user", atr };
  }
  if (pos(stopPct)) return { ok: true, d: (entry * stopPct) / 100, from: "user", atr };
  if (atr == null) return { ok: false, why: "no-candles" };
  const { highs, lows } = swingPoints(cleanCandles(candles));
  const levels = (buy ? lows : highs).map((x) => x.px).filter((px) => (buy ? px < entry : px > entry));
  const level = levels.length ? levels[levels.length - 1] : null;
  if (level != null) {
    const d = Math.abs(entry - level) + SWING_BUFFER_ATR * atr;
    if (d >= SWING_MIN_ATR * atr && d <= SWING_MAX_ATR * atr) return { ok: true, d, from: "swing", level, atr };
  }
  const k = style === "safer" ? SAFE_STOP_ATR : STOP_ATR;
  return { ok: true, d: k * atr, from: "atr", k, atr };
}

/* The stop distance a fixed size and a stated risk leave (fees of the entry and the exit at the stop included). */
function stopFromRisk({ side, entry, size, riskUsd, f }) {
  const u = riskUsd / size;
  const d = side === "buy" ? (u - 2 * f * entry) / (1 - f) : (u - 2 * f * entry) / (1 + f);
  return d > 0 ? d : null;
}

/* Gap from the entry to the estimated liquidation, as a share of the entry (1 = never liquidated). */
function liqGap({ side, entry, lev, maxLeverage }) {
  const liq = estIsolatedLiqPx({ side, entryPx: entry, leverage: lev, maxLeverage });
  if (liq == null) return { liq: null, gap: null };
  if (liq === 0) return { liq, gap: 1 };
  return { liq, gap: side === "buy" ? (entry - liq) / entry : (liq - entry) / entry };
}

/* ── words ───────────────────────────────────────────────────────────────────────────────────────────────────── */

const usd = (v) => {
  if (!fin(v)) return "—";
  const a = Math.abs(v);
  const body = a >= 100 ? Math.round(a).toLocaleString("en-US") : (Math.round(a * 100) / 100).toFixed(2).replace(/\.00$/, "");
  return `${v < 0 ? "-" : ""}$${body}`;
};
const pctText = (frac) => {
  const p = frac * 100;
  return `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
};
const minNotionalText = `$${HL_MIN_ORDER_USD}`;

/* The name a customer reads: the bare ticker, never the venue's qualified name (owner: "คนไม่ต้องรู้ห่าอะไรเลย"). */
const labelOf = (market) => {
  if (market && typeof market.label === "string" && market.label) return market.label;
  const c = market && typeof market.coin === "string" ? market.coin : "";
  return c.includes(":") ? c.slice(c.indexOf(":") + 1) : c;
};

export const PLAN_FAIL_TEXT = Object.freeze({
  "no-coin": { en: ASK.coin.en, th: ASK.coin.th },
  "no-market": { en: "That market isn't available in FlowFlow.", th: "ตัวนี้ยังไม่มีใน FlowFlow" },
  "no-price": { en: "No live price for this market right now. Try again in a moment.", th: "ตอนนี้ยังไม่มีราคาสด ลองใหม่อีกที" },
  "no-candles": { en: "Couldn't read the 1h chart, so there's no stop to plan from. Give a stop (a price or a % away).", th: "อ่านกราฟ 1h ไม่ได้ เลยยังคิด SL ให้ไม่ได้ บอก SL มาได้เลย (ราคา หรือ % จากราคาเข้า)" },
  "no-direction": { en: ASK.side.en, th: ASK.side.th },
  "no-balance": { en: ASK.balance.en, th: ASK.balance.th },
  "stop-wrong-side": { en: "That stop is on the winning side of the price. A stop sits below a long's entry, above a short's.", th: "SL อยู่ผิดฝั่ง: Long ต้องต่ำกว่าราคาเข้า Short ต้องสูงกว่า" },
  "stop-too-wide": { en: "That stop is too far away for any leverage: liquidation would come first.", th: "SL ไกลเกินไป จะโดน liquidation ก่อน" },
  "tp-wrong-side": { en: "That take profit is on the losing side of the price.", th: "TP อยู่ผิดฝั่งของราคา" },
  "too-small": { en: `That's under the smallest order (${minNotionalText}) with the margin and leverage available.`, th: `เล็กกว่าออเดอร์ขั้นต่ำ (${minNotionalText}) ด้วย margin และ leverage ที่มี` },
  "no-funds": { en: "No free margin in the Main Account right now.", th: "ตอนนี้ไม่มีเงินว่างใน Main Account" },
  "fees-over-risk": { en: "The fees alone are more than that risk at this size.", th: "แค่ค่าธรรมเนียมก็เกินที่ยอมเสียแล้ว" },
  held: { en: "You already hold this market. One position per market: close it or set its TP / SL.", th: "มี position ตัวนี้อยู่แล้ว (ได้ตัวละ 1 position) ปิดก่อน หรือตั้ง TP / SL" },
  "stock-refused": { en: "This stock can't take a new position right now.", th: "หุ้นตัวนี้เปิด position ใหม่ไม่ได้ตอนนี้" },
  "bad-input": { en: "That plan doesn't add up. Check the numbers.", th: "ตัวเลขไม่เข้ากัน ลองเช็คอีกที" },
});

const STOCK_GUARD_TH = Object.freeze({
  market_unknown: "ตอนนี้ตัวนี้ยังเทรดไม่ได้",
  not_listed: "หุ้นตัวนี้ยังไม่มีใน FlowFlow",
  held: "พักการเทรดหุ้นตัวนี้ไว้ก่อน (ซื้อขายบาง)",
  at_cap: "หุ้นตัวนี้เต็มลิมิตแล้ว เปิดใหม่ไม่ได้ตอนนี้",
  leverage_unknown: "อ่านลิมิต leverage ของตัวนี้ไม่ได้ ลองใหม่อีกที",
  us_market_closed: "ตลาดหุ้น US ปิด: ราคามาจาก model ของตลาด และอาจกระโดดตอนเปิด",
  extended_hours: "นอกเวลาตลาด US: ซื้อขายบาง ราคาแกว่งแรง",
  calendar_old: "ปฏิทินวันหยุดตลาด US ต้องอัปเดต",
  price_off_oracle: "ราคาห่างจากราคาอ้างอิงตอนนี้",
  fee_unknown: "อ่านค่าธรรมเนียมตัวนี้ไม่ได้",
  margin_locked: "เปิดแล้วถอน margin ออกจาก position นี้ไม่ได้",
});

const WARN = {
  /* 🔴 A side the user never said is said, first, on the card and in the line above it (pass-2 review: "risk $1 HYPE"
     came back a Short with no word about who chose it). */
  side_from_trend: (p) => ({
    en: `FlowFlow picked ${p.side === "buy" ? "Long" : "Short"}: the 1h trend is ${p.side === "buy" ? "up" : "down"}`,
    th: `FlowFlow เลือก ${p.side === "buy" ? "Long" : "Short"} ตามเทรนด์ 1h ${p.side === "buy" ? "ขาขึ้น" : "ขาลง"}`,
  }),
  side_from_data: (p) => ({ en: `FlowFlow picked ${p.side === "buy" ? "Long" : "Short"}: the side the 1h chart leans to`, th: `FlowFlow เลือก ${p.side === "buy" ? "Long" : "Short"} ตามที่กราฟ 1h เอียงไป` }),
  leverage_capped: (p) => ({ en: `Leverage capped at ${p.leverage}x`, th: `leverage สูงสุด ${p.leverage}x` }),
  leverage_lowered: (p) => ({ en: `Leverage lowered to ${p.leverage}x (you said ${p.userLeverage}x) so liquidation stays past the stop`, th: `ลด leverage เหลือ ${p.leverage}x (ขอมา ${p.userLeverage}x) ให้ liq อยู่ไกลกว่า SL` }),
  leverage_whole: (p) => ({ en: `Leverage is a whole number: ${p.leverage}x`, th: `leverage ต้องเป็นจำนวนเต็ม: ${p.leverage}x` }),
  us_closed_cap: () => ({ en: `US market closed: max ${CLOSED_AGENT_MAX_LEVERAGE}x on stocks now`, th: `ตลาดหุ้น US ปิด: หุ้นใช้ได้สูงสุด ${CLOSED_AGENT_MAX_LEVERAGE}x ตอนนี้` }),
  stop_tight: () => ({ en: "Stop is inside a normal 1h move", th: "SL ใกล้ไป ราคาแกว่งปกติก็โดน" }),
  rr_low: () => ({ en: "RR under 1: the target is closer than the stop", th: "RR ต่ำกว่า 1: TP ใกล้กว่า SL" }),
  fee_assumed: () => ({ en: "Fee unknown: priced at the highest it can be", th: "ไม่รู้ค่าธรรมเนียม: คิดที่สูงสุดไว้ก่อน" }),
  risk_assumed: (p) => ({ en: `Risk set to ${DEFAULT_RISK_PCT}% of ${usd(p.balanceUsd)}`, th: `ตั้งยอมเสีย ${DEFAULT_RISK_PCT}% ของ ${usd(p.balanceUsd)}` }),
  margin_default: () => ({ en: `No risk given: ${DEFAULT_SETUP_MARGIN_USDC} USDC margin`, th: `ไม่ได้บอกยอมเสีย: ใช้ margin ${DEFAULT_SETUP_MARGIN_USDC} USDC` }),
};

/** A plan's warnings as short lines in a language (stock codes use the guard's own words). */
export function warningTexts(plan, lang = "en") {
  const th = lang === "th";
  return (plan && Array.isArray(plan.warnings) ? plan.warnings : []).map((w) => {
    if (WARN[w]) return WARN[w](plan)[th ? "th" : "en"];
    if (th && STOCK_GUARD_TH[w]) return STOCK_GUARD_TH[w];
    return STOCK_GUARD_TEXT[w] || null;
  }).filter(Boolean);
}

function cappedText({ why, realRiskUsd, wantedRiskUsd, wantedMarginUsd, margin, freeUsdc, leverage }) {
  const real = usd(realRiskUsd);
  const tailEn = wantedRiskUsd != null ? `this risks ${real}, not ${usd(wantedRiskUsd)}` : `margin ${usd(margin)}, not ${usd(wantedMarginUsd)}`;
  const tailTh = wantedRiskUsd != null ? `แผนนี้เสียได้จริง ${real} ไม่ใช่ ${usd(wantedRiskUsd)}` : `margin ${usd(margin)} ไม่ใช่ ${usd(wantedMarginUsd)}`;
  if (why === "margin_cap") return { en: `Max ${MAX_MARGIN_USDC} USDC margin per order: ${tailEn}`, th: `มาร์จิ้นสูงสุด ${MAX_MARGIN_USDC} USDC ต่อออเดอร์: ${tailTh}` };
  if (why === "free_margin") return { en: `${usd(freeUsdc)} free to trade: ${tailEn}`, th: `มีเงินว่างเทรดได้ ${usd(freeUsdc)}: ${tailTh}` };
  if (why === "your_margin") return { en: `Your ${usd(wantedMarginUsd)} margin at ${leverage}x: ${tailEn}`, th: `margin ${usd(wantedMarginUsd)} ที่ ${leverage}x: ${tailTh}` };
  return { en: `Smallest order is ${minNotionalText}: ${tailEn}`, th: `ออเดอร์ขั้นต่ำ ${minNotionalText}: ${tailTh}` };
}

/* The plan's three lines (item 13). 🔴 DISTANCES AND DOLLARS, NO PRICE LEVELS (pass-2 review): the lines are written
   when the plan is made, while the card's rows and the final popup price the TP / SL / liquidation from the live quote,
   so a level printed here showed a second price for the same stop ($104.61 here, $104.60 on the row). The levels are
   on the card's rows and the popup's chart, once each. */
function stepsOf(p, lang) {
  const th = lang === "th";
  const fromEn = { swing: ` (1h swing ${p.side === "buy" ? "low" : "high"})`, atr: ` (${p.stopAtrK}× 1h ATR)`, risk: " (from your risk)", user: "" }[p.stopFrom] || "";
  const fromTh = { swing: ` (swing ${p.side === "buy" ? "low" : "high"} 1h)`, atr: ` (${p.stopAtrK}× ATR 1h)`, risk: " (จากที่ยอมเสีย)", user: "" }[p.stopFrom] || "";
  const stop = th ? `SL ห่าง ${pctText(p.stopFrac)}${fromTh}` : `stop ${pctText(p.stopFrac)} away${fromEn}`;
  let head;
  if (p.riskFrom === "usd") head = th ? `ยอมเสีย ${usd(p.riskUsd)}` : `Risk ${usd(p.riskUsd)}`;
  else if (p.riskFrom === "pct") {
    const tailEn = p.riskPctAssumed ? `, default` : "";
    const tailTh = p.riskPctAssumed ? ` ค่าเริ่มต้น` : "";
    head = th ? `ยอมเสีย ${usd(p.riskUsd)} (${p.riskPct}% ของ ${usd(p.balanceUsd)}${tailTh})` : `Risk ${usd(p.riskUsd)} (${p.riskPct}% of ${usd(p.balanceUsd)}${tailEn})`;
  } else head = th ? `มาร์จิ้น ${usd(p.wantedMarginUsd)}${p.riskFrom === "default" ? " (ค่าเริ่มต้น)" : ""}` : `Margin ${usd(p.wantedMarginUsd)}${p.riskFrom === "default" ? " (default)" : ""}`;
  const size = `${formatHlSize(p.size, p.szDecimals)} ${p.label} ≈ ${usd(p.notional)} · ${p.leverage}x · ${th ? "มาร์จิ้น" : "margin"} ${usd(p.margin)}`;
  const capWord = !p.capped ? "" : {
    margin_cap: th ? `มาร์จิ้นสูงสุด ${MAX_MARGIN_USDC} USDC → ` : `Max ${MAX_MARGIN_USDC} USDC margin → `,
    free_margin: th ? `เงินว่าง ${usd(p.freeUsdc)} → ` : `${usd(p.freeUsdc)} free → `,
    your_margin: th ? `มาร์จิ้นของคุณ → ` : `Your margin → `,
    min_notional: th ? `ขั้นต่ำ ${minNotionalText} → ` : `Smallest order ${minNotionalText} → `,
  }[p.capped.why] || "";
  const line2 = `${capWord}${th ? "ขนาด" : "size"} ${size}`;
  const line3 = th
    ? `โดน SL เสีย ≈ ${usd(p.lossAtStop)} รวมค่าธรรมเนียม · RR ${p.rr}`
    : `Loss at stop ≈ ${usd(p.lossAtStop)} incl. fees · RR ${p.rr}`;
  return [`${head} · ${stop}`, line2.charAt(0).toUpperCase() + line2.slice(1), line3];
}

/* ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────── */

const fail = (why, extra = {}) => {
  const text = PLAN_FAIL_TEXT[why] || PLAN_FAIL_TEXT["bad-input"];
  const ask = why === "no-coin" ? ASK.coin : why === "no-direction" ? ASK.side : why === "no-balance" ? ASK.balance : null;
  return { ok: false, why, text, ...(ask ? { ask } : {}), ...extra };
};

/**
 * One trade plan from what the user said and the market's live data. Pure.
 * @param {{ coin?: string, side?: "buy"|"sell"|"long"|"short"|null, riskUsd?: number|null, riskPct?: number|null,
 *   riskPctAssumed?: boolean, balanceUsd?: number|null, rr?: number|null, stopPct?: number|null, stopPx?: number|null,
 *   tpPct?: number|null, tpPx?: number|null, leverage?: number|null, marginUsd?: number|null, style?: "safer"|null,
 *   lang?: "en"|"th" }} input stopPct / tpPct: % of the PRICE away from the entry (not ROE)
 * @param {{ market: object, candles?: object[]|null, freeUsdc?: number|null, balanceUsdc?: number|null,
 *   feeRate?: number|null, now?: number, listed?: boolean|null, position?: object|null }} ctx
 *   market: a market row (lib/hyperliquid/markets.js); freeUsdc: the Main Account's free margin (null: not read);
 *   balanceUsdc: its balance (for a % risk when the user gave none); feeRate: the market's all-in taker rate;
 *   listed: a stock's stockMarkets() verdict; position: the user's open position on this market, if any
 * @returns {object} { ok: true, coin, label, kind, side, entry, sl, tp, rr, size, notional, leverage, margin, liq,
 *   lossAtStop, feeUsd, gainAtTp, tpRoePct, slRoePct, capped: { why, realRiskUsd, wantedRiskUsd, text } | null,
 *   steps: [3 lines], warnings: [codes], ... } or { ok: false, why, text: { en, th }, ask? }
 */
export function planTrade(input = {}, { market = null, candles = null, freeUsdc = null, balanceUsdc = null, feeRate = null, now = Date.now(), listed = null, position = null } = {}) {
  const inp = input && typeof input === "object" ? input : {};
  const lang = inp.lang === "th" ? "th" : "en";
  if (!market || typeof market.coin !== "string") return fail(inp.coin ? "no-market" : "no-coin");
  const szDecimals = market.szDecimals;
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 8) return fail("no-market");
  /* The price an order is sized at: what planOpenMarket reads (mid, else the last price). */
  const entry = pos(market.midPx) ?? pos(market.px) ?? pos(market.markPx);
  if (entry == null) return fail("no-price");
  if (market.stale === true) return fail("no-price");
  const stock = !!market.isHip3;
  const warnings = [];

  /* One position per market (Hyperliquid's own rule). */
  if (position && fin(position.szi) && position.szi !== 0) return fail("held");

  /* A stock answers to its guard: listed, not paused, not at its cap; its leverage ceiling here and now. */
  let stockCheck = null;
  if (stock) {
    stockCheck = checkStockOrder({ row: market, side: "long", marginUsdc: 10, leverage: 1, by: "agent", now, listed });
    const stops = stockCheck.refusals.filter((r) => ["market_unknown", "not_listed", "held", "at_cap", "leverage_unknown"].includes(r));
    if (stops.length) {
      return fail("stock-refused", {
        refusals: stops,
        text: { en: STOCK_GUARD_TEXT[stops[0]] || PLAN_FAIL_TEXT["stock-refused"].en, th: STOCK_GUARD_TH[stops[0]] || PLAN_FAIL_TEXT["stock-refused"].th },
      });
    }
  }

  /* The bars the stop is sized on: a stock's only in US market hours. */
  const all = cleanCandles(candles);
  const bars = stock ? coreSessionCandles(all) : all;

  /* The side: the user's, else the side the chart leans to (said on the card), else ask. */
  let side = inp.side === "buy" || inp.side === "long" ? "buy" : inp.side === "sell" || inp.side === "short" ? "sell" : null;
  if (!side) {
    const trend = trendOf(all);
    side = leanSide({ trend, funding: market.funding, change24hPct: market.change24hPct });
    if (!side) return fail("no-direction");
    warnings.push(trend === "up" || trend === "down" ? "side_from_trend" : "side_from_data");
  }
  const buy = side === "buy";
  const f = fin(feeRate) && feeRate >= 0 ? feeRate : FALLBACK_FEE_RATE;
  if (!(fin(feeRate) && feeRate >= 0)) warnings.push("fee_assumed");

  /* The leverage ceiling: the Agent's, the market's own, a stock's here-and-now (5x while the US market is shut), "safe". */
  const marketMax = fin(market.maxLeverage) && market.maxLeverage >= 1 ? Math.floor(market.maxLeverage) : null;
  if (marketMax == null) return fail("no-market");
  let levCap = Math.min(AGENT_MAX_LEVERAGE, marketMax);
  if (stock && fin(stockCheck.maxLeverage)) levCap = Math.min(levCap, stockCheck.maxLeverage);
  const closedCapBinds = stock && usEquitySession(now).closed && CLOSED_AGENT_MAX_LEVERAGE < Math.min(AGENT_MAX_LEVERAGE, marketMax);
  if (inp.style === "safer") levCap = Math.min(levCap, SAFE_MAX_LEVERAGE);
  levCap = Math.max(1, Math.floor(levCap));

  /* The risk budget: $; else % of the balance the user gave, else of the account; else the margin; else the default. */
  const userLevRaw = pos(inp.leverage);
  const userLev = userLevRaw != null ? Math.max(1, Math.floor(userLevRaw)) : null;
  const userMargin = pos(inp.marginUsd);
  let riskUsd = pos(inp.riskUsd);
  let riskFrom = riskUsd != null ? "usd" : null;
  let riskPct = null;
  let balanceUsd = null;
  if (riskUsd == null && pos(inp.riskPct) != null) {
    riskPct = inp.riskPct;
    if (riskPct > 100) return fail("bad-input");
    balanceUsd = pos(inp.balanceUsd) ?? pos(balanceUsdc);
    if (balanceUsd == null) return fail("no-balance");
    riskUsd = r2((balanceUsd * riskPct) / 100);
    if (!(riskUsd > 0)) return fail("bad-input");
    riskFrom = "pct";
    if (inp.riskPctAssumed) warnings.push("risk_assumed");
  }
  if (riskUsd == null && userMargin == null && pos(inp.balanceUsd) != null) {
    riskPct = DEFAULT_RISK_PCT;
    balanceUsd = inp.balanceUsd;
    riskUsd = r2((balanceUsd * riskPct) / 100);
    riskFrom = "pct";
    warnings.push("risk_assumed");
  }
  let wantedMarginUsd = null;
  if (riskUsd == null) {
    wantedMarginUsd = userMargin ?? DEFAULT_SETUP_MARGIN_USDC;
    riskFrom = userMargin != null ? "margin" : "default";
    if (userMargin == null) warnings.push("margin_default");
  }

  /* The stop: the user's, else derived from a fixed size and a stated risk, else the chart's. */
  let st;
  const sizeFixed = riskUsd != null && userMargin != null && userLev != null && !pos(inp.stopPx) && !pos(inp.stopPct);
  if (sizeFixed) {
    const dRisk = stopFromRisk({ side, entry, size: (userMargin * userLev) / entry, riskUsd, f });
    if (dRisk == null) return fail("fees-over-risk");
    st = { ok: true, d: dRisk, from: "risk", atr: planAtr(bars) };
  } else {
    st = planStop({ side, entry, candles: bars, stopPx: inp.stopPx, stopPct: inp.stopPct, style: inp.style });
  }
  if (!st.ok) return fail(st.why);
  if (!(st.d / entry < MAX_STOP_FRAC)) return fail("stop-too-wide");

  /* The stop on its tick, rounded toward the entry (the loss can only shrink). */
  const slWire = roundHlOrderPx(buy ? entry - st.d : entry + st.d, szDecimals, buy ? "up" : "down");
  const sl = slWire == null ? null : Number(slWire);
  if (sl == null || !(sl > 0)) return fail("stop-too-wide");
  const d = buy ? entry - sl : sl - entry;
  if (!(d > 0)) return fail("stop-wrong-side");
  const stopFrac = d / entry;
  if (st.from === "user" && st.atr != null && d < TIGHT_STOP_ATR * st.atr) warnings.push("stop_tight");

  /* The TP: the user's, else RR × the stop distance. */
  let tpDist;
  if (pos(inp.tpPx)) {
    tpDist = buy ? inp.tpPx - entry : entry - inp.tpPx;
    if (!(tpDist > 0)) return fail("tp-wrong-side");
  } else if (pos(inp.tpPct)) tpDist = (entry * inp.tpPct) / 100;
  else tpDist = (pos(inp.rr) ?? DEFAULT_RR) * d;
  const tpRaw = buy ? entry + tpDist : entry - tpDist;
  if (!(tpRaw > 0)) return fail("bad-input");
  const tpWire = roundHlOrderPx(tpRaw, szDecimals, "nearest");
  const tp = tpWire == null ? null : Number(tpWire);
  if (tp == null) return fail("bad-input");
  const tpD = buy ? tp - entry : entry - tp;
  if (!(tpD > 0)) return fail("bad-input");
  const rr = r2(tpD / d);
  if (rr < 1) warnings.push("rr_low");

  /* The highest leverage whose liquidation sits at least LIQ_BUFFER stop distances from the entry. */
  let levLiq = null;
  for (let L = levCap; L >= 1; L--) {
    const g = liqGap({ side, entry, lev: L, maxLeverage: marketMax });
    if (g.gap == null) return fail("no-market");
    if (g.gap >= PLAN_LIQ_BUFFER * stopFrac) { levLiq = L; break; }
  }
  if (levLiq == null) return fail("stop-too-wide");

  /* The size the user's numbers ask for. */
  const unitLoss = d + f * (entry + sl);
  let sizeWant;
  if (sizeFixed) sizeWant = (userMargin * userLev) / entry;
  else if (riskUsd != null) sizeWant = riskUsd / unitLoss;
  else sizeWant = null; /* margin-sized: after the leverage */

  /* The leverage: the user's (capped, and lowered for the liquidation rule), else the lowest at which the margin fits. */
  const free = fin(freeUsdc) ? Math.max(0, freeUsdc) : null;
  if (free != null && free <= 0) return fail("no-funds");
  const room = (L) => Math.min(MAX_MARGIN_USDC, userMargin ?? Infinity, free != null ? free / (1 + L * f) : Infinity);
  let L;
  if (userLev != null) {
    L = Math.min(userLev, levLiq);
    if (userLevRaw !== userLev) warnings.push("leverage_whole");
    if (userLev > levCap) warnings.push(closedCapBinds && userLev > CLOSED_AGENT_MAX_LEVERAGE ? "us_closed_cap" : "leverage_capped");
    else if (L < userLev) warnings.push("leverage_lowered");
  } else if (sizeWant == null) {
    L = Math.min(SETUP_MAX_LEVERAGE, levLiq);
  } else {
    L = 1;
    while (L < levLiq && (sizeWant * entry) / L > room(L)) L++;
  }
  if (sizeWant == null) sizeWant = (wantedMarginUsd * L) / entry;
  if (closedCapBinds && userLev == null && (sizeWant * entry) / levCap > room(levCap) && !warnings.includes("us_closed_cap")) warnings.push("us_closed_cap");

  /* Fit the margin: over a limit, the size is the limit's (and the plan says so). */
  let capWhy = null;
  let notional = sizeWant * entry;
  const lim = room(L);
  if (notional / L > lim + 1e-9) {
    notional = lim * L;
    capWhy = lim === MAX_MARGIN_USDC ? "margin_cap" : free != null && lim === free / (1 + L * f) ? "free_margin" : "your_margin";
    /* The user's own margin is a choice, not a cap, when the plan sizes from it. */
    if (capWhy === "your_margin" && riskUsd == null) capWhy = null;
  }
  let size = sizeDown(notional / entry, szDecimals);

  /* The $10 minimum, as the venue will check it at send time. */
  const minNotional = (HL_MIN_ORDER_USD * (1 + MIN_NOTIONAL_BUFFER)) / (buy ? 1 : 1 - HL_DEFAULT_SLIPPAGE);
  if (size * entry < minNotional) {
    const sizeMin = sizeUp(minNotional / entry, szDecimals);
    let Lm = L;
    /* A leverage the user named is theirs: it is never raised to reach the minimum. */
    while (userLev == null && Lm < levLiq && (sizeMin * entry) / Lm > room(Lm)) Lm++;
    if ((sizeMin * entry) / Lm > room(Lm) + 1e-9) return fail("too-small");
    size = sizeMin;
    L = Lm;
    capWhy = "min_notional";
  }
  if (!(size > 0)) return fail("too-small");

  /* The margin the card carries (USDC's 6 decimals): margin × leverage ÷ mid gives this exact size back at send time. */
  let margin = round6((size * entry) / L);
  while (margin > MAX_MARGIN_USDC && size > 0) {
    size = sizeDown(size - 10 ** -szDecimals, szDecimals);
    margin = round6((size * entry) / L);
  }
  if (!(size > 0)) return fail("too-small");
  notional = size * entry;

  /* 🔴 THE CAPS, AGAIN, ON THE FINAL NUMBERS (defence in depth: a bug above must not reach a card). */
  if (!(margin <= MAX_MARGIN_USDC) || !(L <= AGENT_MAX_LEVERAGE) || !(L <= marketMax) || !(L <= levCap) || !(L >= 1) || !Number.isInteger(L)) return fail("bad-input");
  if (stock) {
    const final = checkStockOrder({ row: market, side: buy ? "long" : "short", marginUsdc: margin, leverage: L, by: "agent", now, listed });
    if (!final.ok) return fail("stock-refused", { refusals: final.refusals });
    for (const w of final.warnings) if (!warnings.includes(w)) warnings.push(w);
  }

  const liqRaw = liqGap({ side, entry, lev: L, maxLeverage: marketMax }).liq;
  const liq = liqRaw != null && liqRaw > 0 ? Number(roundHlOrderPx(liqRaw, szDecimals, "nearest")) || null : null;
  const feeUsd = size * f * (entry + sl);
  const lossAtStop = size * unitLoss;
  const gainAtTp = size * tpD - size * f * (entry + tp);
  const realRiskUsd = r2(lossAtStop);
  let capped = null;
  if (capWhy) {
    capped = {
      why: capWhy, realRiskUsd, wantedRiskUsd: riskUsd, wantedMarginUsd: riskUsd == null ? wantedMarginUsd : null,
    };
    capped.text = cappedText({ ...capped, margin, freeUsdc: free, leverage: L });
  }

  const label = labelOf(market);
  const plan = {
    ok: true,
    coin: market.coin,
    label,
    name: stock ? stockName(market.coin) : null,
    kind: stock ? "stock" : "crypto",
    side,
    sideFrom: inp.side ? "user" : "chart",
    userLeverage: userLev,
    lang,
    entry,
    sl,
    tp,
    rr,
    size,
    sizeWire: roundHlSize(size, szDecimals, "down"),
    notional: r2(notional),
    leverage: L,
    margin,
    marginMode: "isolated",
    liq,
    lossAtStop: r2(lossAtStop),
    feeUsd: r2(feeUsd),
    gainAtTp: r2(gainAtTp),
    feeRate: f,
    /* What the trade card takes: ROE % at this leverage. The stop rounds IN (2 decimals) so the card's stop is never wider. */
    slRoePct: floor2(stopFrac * L * 100),
    tpRoePct: r2((tpD / entry) * L * 100),
    stopFrac,
    stopFrom: st.from,
    stopAtrK: st.k ?? null,
    stopLevel: st.level ?? null,
    riskUsd,
    riskPct,
    riskPctAssumed: warnings.includes("risk_assumed"),
    riskFrom,
    balanceUsd,
    wantedMarginUsd,
    freeUsdc: free,
    capped,
    warnings,
    szDecimals,
    basis: stock ? STOCK_PLAN_BASIS : PLAN_BASIS,
    at: now,
    ...(stock ? { us: usState(now) } : {}),
  };
  if (!(plan.slRoePct > 0) || !(plan.tpRoePct > 0)) return fail("bad-input");
  plan.steps = stepsOf(plan, lang);
  plan.stepsTh = lang === "th" ? plan.steps : stepsOf(plan, "th");
  plan.stepsEn = lang === "en" ? plan.steps : stepsOf(plan, "en");
  return plan;
}

/* The US market's state for a stock's card line ("US market: closed (opens in 5h)"). */
function usState(now) {
  const s = usEquitySession(now);
  const next = s.open ? null : nextRegularOpen(now);
  return { session: s.session, open: s.open, closed: s.closed, opensInMin: next != null ? Math.max(0, Math.round((next - now) / 60_000)) : null };
}

/* ── into the chat ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The normal trade card a plan becomes: it waits for Confirm, and the card's Confirm opens the final chart (item 17).
 * The caps are applied AGAIN here, in code: a plan object over any cap (an older build, a bug) gives no card.
 */
export function planToOpenCard(plan) {
  if (!plan || plan.ok !== true || typeof plan.coin !== "string" || (plan.side !== "buy" && plan.side !== "sell")) return null;
  if (!fin(plan.margin) || plan.margin <= 0 || plan.margin > MAX_MARGIN_USDC) return null;
  if (!Number.isInteger(plan.leverage) || plan.leverage < 1 || plan.leverage > AGENT_MAX_LEVERAGE) return null;
  if (plan.kind === "stock" && plan.us && plan.us.closed && plan.leverage > CLOSED_AGENT_MAX_LEVERAGE) return null;
  const lang = plan.lang === "th" ? "th" : "en";
  /* 🔴 THE PLAN'S WARNINGS ARE ON THE CARD (pass-2 review: they reached only the model's history, so a Short the app
     picked and a leverage it lowered showed as if they were the user's). The side first; a stock's market state is the
     card's one status line (statusNote), not a second copy of the guard's words. */
  const order = (w) => (w === "side_from_trend" || w === "side_from_data" ? 0 : w === "leverage_lowered" || w === "leverage_capped" || w === "us_closed_cap" ? 1 : 2);
  const shown = (Array.isArray(plan.warnings) ? plan.warnings : []).filter((w) => w !== "extended_hours" && w !== "us_market_closed").sort((a, b) => order(a) - order(b));
  const notes = warningTexts({ ...plan, warnings: shown }, lang).slice(0, 3);
  const statusNote = plan.kind === "stock" ? statusText(usSessionView(fin(plan.at) ? plan.at : Date.now(), stockKind(plan.coin) === "index" ? "index" : "stock"), { lang }) : null;
  return {
    kind: "open",
    coin: plan.coin,
    side: plan.side,
    marginUsdc: plan.margin,
    leverage: plan.leverage,
    tpPct: plan.tpRoePct,
    slPct: plan.slRoePct,
    rr: plan.rr,
    status: "review",
    planned: true,
    ...(notes.length ? { notes } : {}),
    ...(statusNote ? { statusNote } : {}),
    ...(plan.kind === "stock" ? { marginMode: "isolated" } : {}),
    plan: {
      steps: plan.steps,
      capped: plan.capped ? { why: plan.capped.why, realRiskUsd: plan.capped.realRiskUsd, wantedRiskUsd: plan.capped.wantedRiskUsd, text: plan.capped.text } : null,
      warnings: plan.warnings,
      entryPx: plan.entry, tpPx: plan.tp, slPx: plan.sl, liqPx: plan.liq,
      size: plan.size, notionalUsd: plan.notional, lossAtStopUsd: plan.lossAtStop, feeUsd: plan.feeUsd, gainAtTpUsd: plan.gainAtTp,
      riskUsd: plan.riskUsd, stopFrom: plan.stopFrom, marginMode: plan.marginMode, basis: plan.basis, at: plan.at,
      ...(plan.us ? { us: plan.us } : {}),
    },
  };
}

/** What the model reads (small, rounded, words it can repeat; no maths left for it to do). */
export function planForModel(plan, lang = "en") {
  if (!plan || plan.ok !== true) {
    const p = plan || {};
    return { error: (p.text && p.text[lang === "th" ? "th" : "en"]) || "No plan.", ...(p.ask ? { ask_user: p.ask[lang === "th" ? "th" : "en"] } : {}) };
  }
  const px = (v) => formatHlPrice(v, plan.szDecimals);
  return {
    market: plan.name ? `${plan.label} · ${plan.name}` : plan.label,
    kind: plan.kind,
    side: plan.side === "buy" ? "long" : "short",
    entry: px(plan.entry),
    stop_loss: px(plan.sl),
    take_profit: px(plan.tp),
    rr: plan.rr,
    size_usd: usd(plan.notional),
    leverage: plan.leverage,
    margin_usdc: r2(plan.margin),
    loss_at_stop: usd(plan.lossAtStop),
    gain_at_tp: usd(plan.gainAtTp),
    fees_at_stop: usd(plan.feeUsd),
    liquidation: plan.liq != null ? px(plan.liq) : null,
    capped: plan.capped ? plan.capped.text[lang === "th" ? "th" : "en"] : null,
    warnings: warningTexts(plan, lang),
    steps: lang === "th" ? plan.stepsTh : plan.stepsEn,
    ...(plan.us ? { us_market: plan.us.open ? "open" : plan.us.closed ? "closed" : "outside hours", opens_in_min: plan.us.opensInMin } : {}),
  };
}

/* ── reading what a plan needs (the browser; never sends) ─────────────────────────────────────────────────────── */

/**
 * The market row for a name, and whether a stock is listed: a main-dex market first (case-insensitive, k-prefixed),
 * then a whitelisted stock (hip3/names.js) whose row the store has loaded. Null when there is none.
 */
export function planMarket(name, snapshot) {
  if (typeof name !== "string" || !name.trim() || !snapshot || !snapshot.byCoin) return null;
  const want = name.trim().toUpperCase().replace(/-USD$|-PERP$|\/USDC?$/, "");
  const main = mainMarkets(snapshot.markets || []);
  const m = main.find((x) => x.coin.toUpperCase() === want) || main.find((x) => x.coin.toUpperCase() === `K${want}`);
  if (m) return { market: m, listed: null, stock: false };
  const coin = resolveStock(name.trim());
  const row = coin ? snapshot.byCoin[coin] : null;
  if (!row) return null;
  return { market: row, listed: stockMarkets(snapshot.markets || []).some((x) => x.coin === coin), stock: true };
}

function withEnd(promise, ms) {
  let t = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); }),
  ]);
}

/**
 * A plan with its data read: the market row, the 1h candles (ctx.fetchCandles), the Main Account's free margin and
 * balance, the market's fee. Reads only; never rejects.
 * @param {{ snapshot: object, backend?: object, fetchCandles?: Function, feeRate?: number, now?: () => number,
 *   readTimeoutMs?: number }} ctx the same ctx runTool.js passes its tools
 * @param {object} input planTrade's input (riskParse.planInput, or planArgsFromModel)
 */
export async function planTradeFor(ctx = {}, input = {}) {
  try {
    const inp = input && typeof input === "object" ? input : {};
    if (!inp.coin) return fail("no-coin");
    const found = planMarket(inp.coin, ctx.snapshot);
    if (!found) return fail("no-market");
    const { market, listed, stock } = found;
    const b = ctx.backend || {};
    const positions = b.account && b.account.positions && b.account.positions.byCoin ? b.account.positions.byCoin : null;
    const position = positions ? positions[market.coin] || null : null;
    let candles = Array.isArray(inp.candles) ? inp.candles : null;
    if (!candles && typeof ctx.fetchCandles === "function") {
      try {
        candles = await withEnd(ctx.fetchCandles(market.coin, PLAN_INTERVAL, { bars: stock ? STOCK_PLAN_BARS : PLAN_BARS }), ctx.readTimeoutMs || READ_TIMEOUT_MS);
      } catch {
        candles = null;
      }
    }
    const bal = b.connected && b.account ? b.account.perpBalanceUsdc : null;
    const known = !!(bal && bal.answered === true && bal.complete !== false);
    const now = typeof ctx.now === "function" ? ctx.now() : Date.now();
    const feeRate = fin(ctx.feeRate) ? ctx.feeRate : perpMarketFeeRate(market, b.feeRate);
    return planTrade(inp, {
      market, candles, listed, position, now, feeRate,
      freeUsdc: known && fin(bal.availableUsdc) ? bal.availableUsdc : null,
      balanceUsdc: known && fin(bal.equityUsdc) ? bal.equityUsdc : null,
    });
  } catch (e) {
    return fail("bad-input", { error: String((e && e.message) || e) });
  }
}

/** The model's plan_trade arguments as planTrade's input. */
export function planArgsFromModel(args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const n = (v) => (fin(v) && v > 0 ? v : null);
  return {
    coin: typeof a.coin === "string" ? a.coin : null,
    side: a.side === "long" || a.side === "buy" ? "buy" : a.side === "short" || a.side === "sell" ? "sell" : null,
    riskUsd: n(a.risk_usd),
    riskPct: n(a.risk_pct),
    balanceUsd: n(a.balance_usd),
    rr: n(a.rr),
    stopPct: n(a.stop_pct),
    stopPx: n(a.stop_px),
    tpPx: n(a.tp_px),
    leverage: n(a.leverage),
    marginUsd: n(a.margin_usdc),
    style: a.safe === true ? "safer" : null,
    lang: a.lang === "th" ? "th" : "en",
  };
}

/**
 * The plan_trade tool, run: the plan as the model's small result and the trade card it shows (or the one question
 * to ask). Never sends. Shape matches runTool.runToolCall's: { result, card? }.
 */
export async function planTradeToolCall(ctx = {}, args = {}) {
  const input = planArgsFromModel(args);
  const plan = await planTradeFor(ctx, input);
  const lang = input.lang;
  if (!plan.ok) return { result: planForModel(plan, lang) };
  const card = planToOpenCard(plan);
  if (!card) return { result: { error: "That plan could not be made into a card." } };
  return {
    result: {
      shown: true,
      plan: planForModel(plan, lang),
      note: `Trade card shown with the plan's maths (code, not advice). Waiting for the user to confirm or cancel. Do not say it is filled.${plan.capped ? " Say the capped line plainly; never claim the user's original risk." : ""}`,
    },
    card,
  };
}
