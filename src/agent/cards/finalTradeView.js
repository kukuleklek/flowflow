// The final pre-trade popup (item 17, owner: "อยากให้มี Popup ก่อนเปิด เป็นหน้าตากราฟ TP SL เส้นอยู่บนกราฟเลย ... ฟีล Final ก่อนเปิด
// จริง"): every figure FinalTradeSheet prints, from the plan its caller priced. PURE: no React, no network; the clock is
// passed in.
//
// ONE SOURCE PER FIGURE. The caller hands over the plan it already quoted (useOrderQuote / plan_trade): entry, TP, SL,
// liquidation, notional, fee. Nothing here re-prices the order or invents a level: an unknown is the dash and draws no
// line. The only arithmetic is what a level is worth at that price — the notional's move to it, less the fees in and
// out — so the "$ at TP" and "$ at SL" labels match what the close would print (est., labelled as one).
//
// 🔴 THE MODEL NEVER DOES THIS MATHS, AND NEITHER DOES THE SHEET'S USER: Edit takes prices, this file checks only that
// each level sits on the right side of the entry (and the stop before liquidation); the caller re-checks the caps and
// re-prices before anything can be sent.
import { formatHlPrice } from "../../lib/hyperliquid/format.js";
import { usdcText } from "../../perp/live/perpLiveView.js";
import { coinLabel, isStockCoin, stockNameOf, stockKindOf, pctText, rrText, feeWords } from "./viewWords.js";
import { usMarketView } from "./usMarketView.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => (fin(v) && v > 0 ? v : null);

/** "+$2.10" / "−$1.14" / "$0.00"; the dash for unknown. Never abbreviated (a P&L figure). */
export function usdSigned(v) {
  if (!fin(v)) return "—";
  if (Math.abs(v) < 0.005) return "$0.00";
  const body = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v > 0 ? "+" : "−"}$${body}`;
}

/** The fee rate a plan carries: its own, else its fee over its notional, else null (then no fee is assumed). */
export function feeRateOf(plan) {
  if (!plan) return null;
  if (fin(plan.feeRate) && plan.feeRate >= 0 && plan.feeRate < 0.01) return plan.feeRate;
  const n = pos(plan.notionalUsd);
  if (n != null && fin(plan.feeUsdc) && plan.feeUsdc >= 0) return plan.feeUsdc / n;
  return null;
}

/**
 * What the position would show closed at `px`, estimated: the notional's move from the entry to px, in the trade's
 * direction, less the fee in and the fee out (when the rate is known; `feesIn` says whether they are in).
 * @returns {{ usd: number, feesIn: boolean } | null}
 */
export function pnlAt(plan, px) {
  const entry = pos(plan && plan.entryPx);
  const n = pos(plan && plan.notionalUsd);
  const p = pos(px);
  if (entry == null || n == null || p == null) return null;
  const dir = plan.side === "sell" ? -1 : 1;
  const qty = n / entry;
  const gross = dir * qty * (p - entry);
  const rate = feeRateOf(plan);
  const fees = rate == null ? 0 : n * rate + qty * p * rate;
  return { usd: gross - fees, feesIn: rate != null };
}

/** Reward to risk from the prices: |TP − entry| / |entry − SL|. Null without both legs. */
export function rrFromPrices({ entryPx, tpPx, slPx } = {}) {
  const e = pos(entryPx);
  const t = pos(tpPx);
  const s = pos(slPx);
  if (e == null || t == null || s == null || s === e) return null;
  return Math.abs(t - e) / Math.abs(e - s);
}

/** A price typed by a person: "2,450.5", "$2450", " 0.0051 " → a number; anything else → null. */
export function parsePriceInput(str) {
  if (typeof str === "number") return pos(str);
  if (typeof str !== "string") return null;
  const t = str.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  return pos(Number(t));
}

/**
 * Edit's own check, before the caller re-prices: each level on its side of the entry, the stop before liquidation.
 * Empty input is "no leg" (null), which is allowed: a trade may go without a TP or an SL.
 * @returns {{ ok: boolean, tpPx: number|null, slPx: number|null, errors: { tp?: string, sl?: string } }}
 */
export function checkTpSlEdit({ side, entryPx, liqPx = null, tpStr = "", slStr = "" } = {}) {
  const buy = side !== "sell";
  const e = pos(entryPx);
  const liq = pos(liqPx);
  const errors = {};
  const blank = (s) => s == null || String(s).trim() === "";
  const tpPx = blank(tpStr) ? null : parsePriceInput(tpStr);
  const slPx = blank(slStr) ? null : parsePriceInput(slStr);
  if (!blank(tpStr) && tpPx == null) errors.tp = "Type a price";
  if (!blank(slStr) && slPx == null) errors.sl = "Type a price";
  if (e == null) {
    if (tpPx != null || slPx != null) errors.tp = errors.tp || "No entry price yet";
  } else {
    if (tpPx != null && (buy ? tpPx <= e : tpPx >= e)) errors.tp = buy ? "TP must be above the entry" : "TP must be below the entry";
    if (slPx != null && (buy ? slPx >= e : slPx <= e)) errors.sl = buy ? "SL must be below the entry" : "SL must be above the entry";
    /* 🔴 A stop past liquidation never triggers: the position is gone first. */
    if (slPx != null && !errors.sl && liq != null && (buy ? slPx <= liq : slPx >= liq)) errors.sl = "SL must sit before liquidation";
  }
  return { ok: Object.keys(errors).length === 0, tpPx, slPx, errors };
}

/** The level's distance from the entry as a signed percent of the price ("+3.50%", "−1.90%"). */
const movePct = (entry, px) => (pos(entry) != null && pos(px) != null ? ((px - entry) / entry) * 100 : null);

/**
 * Everything the sheet prints.
 * @param {object} plan { coin, side: "buy"|"sell", leverage, marginUsdc, entryPx, tpPx?, slPx?, liqPx?, notionalUsd?,
 *   feeUsdc?, feeRate?, szDecimals?, rr?, notes?: string[], mathLines?: string[] }
 * @param {{ now?: number, market?: object }} o
 */
export function finalTradeView(plan, { now = null, market = null } = {}) {
  const p = plan && typeof plan === "object" ? plan : {};
  const coin = typeof p.coin === "string" ? p.coin : "";
  const buy = p.side !== "sell";
  const Side = buy ? "Long" : "Short";
  const sz = Number.isInteger(p.szDecimals) ? p.szDecimals : market && Number.isInteger(market.szDecimals) ? market.szDecimals : null;
  const px = (v) => (pos(v) == null ? "—" : formatHlPrice(v, sz));
  const lev = fin(p.leverage) && p.leverage >= 1 ? Math.floor(p.leverage) : null;
  const entry = pos(p.entryPx);
  const tp = pos(p.tpPx);
  const sl = pos(p.slPx);
  const liq = pos(p.liqPx);
  const stock = isStockCoin(coin);
  const label = coinLabel(coin, market);
  const rr = fin(p.rr) && p.rr > 0 ? p.rr : rrFromPrices({ entryPx: entry, tpPx: tp, slPx: sl });
  const atTp = tp != null ? pnlAt(p, tp) : null;
  const atSl = sl != null ? pnlAt(p, sl) : null;
  const short = (v) => (pos(v) == null ? "" : formatHlPrice(v, sz, { prefix: "" }));

  /* The chart's lines (PriceChart ids: entry / tp / sl / liq, its own colours). A level unknown draws no line. */
  const lines = [];
  if (entry != null) lines.push({ id: "entry", price: entry, title: "Entry" });
  if (tp != null) lines.push({ id: "tp", price: tp, title: `TP ${pctText(movePct(entry, tp), 1)}${atTp ? ` ${usdSigned(atTp.usd)}` : ""}` });
  if (sl != null) lines.push({ id: "sl", price: sl, title: `SL ${pctText(movePct(entry, sl), 1)}${atSl ? ` ${usdSigned(atSl.usd)}` : ""}` });
  if (liq != null) lines.push({ id: "liq", price: liq, title: "Liq." });

  /* The legend under the chart, top to bottom in the chart's own order (highest price first): a long reads TP,
     entry, SL, liq.; a short reads liq., SL, entry, TP. */
  const legend = [];
  if (tp != null) legend.push({ id: "tp", label: "Take profit", priceText: px(tp), pctText: pctText(movePct(entry, tp)), usdText: atTp ? usdSigned(atTp.usd) : "—", tone: "pos" });
  if (entry != null) legend.push({ id: "entry", label: "Entry", priceText: px(entry), pctText: "", usdText: "", tone: "ink" });
  if (sl != null) legend.push({ id: "sl", label: "Stop loss", priceText: px(sl), pctText: pctText(movePct(entry, sl)), usdText: atSl ? usdSigned(atSl.usd) : "—", tone: "neg" });
  if (liq != null) legend.push({ id: "liq", label: "Liquidation", priceText: px(liq), pctText: pctText(movePct(entry, liq)), usdText: "", tone: "warn" });
  const at = { tp, entry, sl, liq };
  legend.sort((a, b) => at[b.id] - at[a.id]);

  const fee = fin(p.feeUsdc) && p.feeUsdc >= 0 ? p.feeUsdc : null;
  const notional = pos(p.notionalUsd);
  const usd = notional == null ? "—" : `$${notional.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const strings = (a, n) => (Array.isArray(a) ? a.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 140)).slice(0, n) : []);
  const ok = !!coin && entry != null && lev != null && fin(p.marginUsdc) && p.marginUsdc > 0;
  return {
    ok,
    coin,
    label,
    pair: stock ? label : `${label}-USD`,
    name: stock ? stockNameOf(coin) : null,
    isStock: stock,
    buy,
    Side,
    /* A stock is always isolated: the popup says so (its loss stops at the margin). */
    pill: `${lev != null ? `${lev}x ${Side}` : Side}${stock || p.isolated === true ? " · Isolated" : ""}`,
    isolated: stock || p.isolated === true,
    openLabel: `Open ${Side}`,
    marginText: usdcText(fin(p.marginUsdc) ? p.marginUsdc : null),
    sizeText: usd,
    rr,
    rrText: rrText(rr),
    feeText: fee == null ? "—" : feeWords(fee),
    feesIn: !!((atTp && atTp.feesIn) || (atSl && atSl.feesIn)),
    entryText: px(entry),
    tpInput: short(tp),
    slInput: short(sl),
    lines,
    legend,
    market: stock && fin(now) ? usMarketView(now, stockKindOf(coin) === "index" ? "index" : "stock") : null,
    /* The caller's own one-liners (a cap it applied: "Leverage 5x while the US market is closed"), and the risk-based
       plan's three lines of maths (item 13), printed as given, never re-worded. */
    notes: strings(p.notes, 3),
    mathLines: strings(p.mathLines, 3),
  };
}

/**
 * What the Open button's answer means for the sheet.
 *   ok           filled: the caller closes the sheet and the position card shows
 *   retry        refused before anything reached the exchange: the person may tap again
 *   locked       the outcome is not known (a lost reply, a throw): 🔴 never a second send from here; check positions
 * @param {object|undefined} r  the caller's result: { ok, message?, next?, unknown?, code? } (tradeErrorView-shaped)
 */
export function openOutcome(r) {
  if (r && r.ok === true) return { state: "ok", text: null };
  const unknown = !r || r.unknown === true || r.next === "positions" || r.code === "unknown_outcome" || r.code === "bad_response" || r.code === "unexpected";
  const text = (r && typeof (r.message || r.text) === "string" && (r.message || r.text).trim()) || null;
  if (unknown) return { state: "locked", text: text || "Not confirmed. Check your positions before trying again." };
  return { state: "retry", text: text || "Didn't go through. Nothing was sent." };
}

/**
 * 🔴 THE SEND LATCH: the one thing between the Open button and the caller's send. However many times fire() is called
 * — a double tap, Enter held down, a re-render — onOpen runs at most once until the answer comes back, and after it:
 *   ok      latched for good ("done"): this review never sends again
 *   locked  latched for good: the outcome is unknown, the person checks their positions first
 *   retry   a clean refusal (nothing was sent): the latch opens again for a NEW tap
 * reset() starts a new review (the sheet opened again). It cannot open a latch while a send is on its way, and it
 * never opens a LOCKED one: an order whose outcome was not known is not sent again by re-opening the same sheet (the
 * caller mounts a new sheet, with a new quote, once the person has checked).
 * @param {() => Promise<object>} onOpen the caller's send (read at fire time, so the newest one runs)
 */
export function createOpenLatch(onOpen) {
  let state = "idle"; // idle | sending | done | locked
  return {
    get state() { return state; },
    async fire() {
      if (state !== "idle" || typeof onOpen !== "function") return { state: "ignored", text: null };
      state = "sending";
      let r;
      /* A throw is an unknown outcome, said in the app's words (never a raw "socket closed"). */
      try { r = await onOpen(); } catch { r = { ok: false, unknown: true }; }
      const o = openOutcome(r);
      state = o.state === "ok" ? "done" : o.state === "locked" ? "locked" : "idle";
      return o;
    },
    reset() { if (state !== "sending" && state !== "locked") state = "idle"; },
  };
}
