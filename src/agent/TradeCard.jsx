import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { perpMarketsStore, hlInfo } from "../lib/hyperliquid/index.js";
import { readBackFill } from "../lib/hyperliquid/readBack.js";
import { AutoHeight, AnimatedNumber, IconSwap, SuccessCheck, TextSwap } from "../ui/kit/index.ts";
import Button from "../ui/Button.jsx";
import Icon, { Spinner } from "../ui/Icon.jsx";
import Seg from "../ui/Seg.jsx";
import CoinLogo from "../ui/CoinLogo.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import { sidePill } from "../ui/badge.js";
import { minus } from "../ui/num.js";
import ConnectCard from "../auth/ConnectCard.jsx";
import { toast } from "../ui/toast.jsx";
import { useBackend } from "../perp/BackendContext.jsx";
import { usePerpMarket, formatHlPrice } from "../lib/hyperliquid/index.js";
import { fillView, tradeErrorView, perpCoinLabel, closeView, closeResultView, positionView, CLOSE_DETENTS } from "../perp/live/perpLiveView.js";
import { AGENT_MAX_LEVERAGE, MAX_MARGIN_USDC } from "../perp/guardrails.js";
import { clampLeverage, defaultLeverage } from "../perp/perpTicket.js";
import { useOrderQuote } from "../trade/useOrderQuote.js";
import MiniChart from "./MiniChart.jsx";
import { TpSlEditor } from "../trade/PositionsPanel.jsx";
import PositionHero from "./PositionHero.jsx";
import { chat } from "./store.js";
import SetupsCard, { rrOf, rrText } from "./cards/SetupsCard.jsx";
import StakeCard from "./cards/StakeCard.jsx";
import UnlockCard from "./cards/UnlockCard.jsx";
import AnalysisCard from "./cards/AnalysisCard.jsx";
import { AssetsCard } from "./cards/AssetBoxes.jsx";
import FinalTradeSheet from "./cards/FinalTradeSheet.jsx";
import PickCard from "./cards/PickCard.jsx";
import CloseAllCard from "./cards/CloseAllCard.jsx";
import NewsCard from "./cards/NewsCard.jsx";
import ChoicesCard from "./cards/ChoicesCard.jsx";
import { useChatActions } from "./cards/ChatActions.jsx";
import { coinLabel, pairLabel, isStockCoin, customerWords, pctText, feeWords } from "./cards/viewWords.js";
import { pnlAt, usdSigned } from "./cards/finalTradeView.js";
import { legStrForPx } from "./legPrice.js";
import { addCapCheck, agentLeverageCap, heldLeverage, sendMarginFor } from "./caps.js";
import { pickTapWords } from "./picks.js";
import { closeAllPositions } from "./closeAll.js";
import { checkAgentStockOrder, agentTicker } from "./stocks.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const QUOTE_TTL_S = 30;
/** The one action that leads to a send, on a short: solid, never the pale tint a disabled button also has. */
export const SHORT_SOLID = "!bg-destructive !text-white hover:!bg-destructive/90";

/* An order error in the customer's words: the two accounts are Main and Spot (USER-ADDENDUM), never "Perp account"
   or the exchange's name (the order layer's own strings: needs a rename there, this is the stopgap). */
function customerError(e) {
  if (!e || typeof e !== "object") return e;
  return { ...e, title: customerWords(e.title), text: customerWords(e.text) };
}

/* The assistant line right above a card, in the same answer, restated once the card settled (item 8). Only a trade's
   own line ("Long SOL at about …") is ever replaced. */
function restateLine(mid, text) {
  try {
    const list = chat.get().messages || [];
    const i = list.findIndex((m) => m && m.id === mid);
    for (let j = i - 1; j >= 0; j--) {
      const m = list[j];
      if (!m || m.role === "user") return;
      if (m.role === "card") return;
      if (m.role === "assistant") {
        if (/^(Long|Short) /.test(String(m.text || ""))) chat.patch(m.id, { text });
        return;
      }
    }
  } catch { /* the thread moved on */ }
}
const toneClass = (t) => (t === "pos" ? "text-success" : t === "neg" ? "text-destructive" : "text-foreground");

/* One summary row (TradeForm's recipe): label left, tabular figure right. */
function Row({ label, children, tone = "" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`num text-right font-medium ${tone}`}>{children}</dd>
    </div>
  );
}

/* The card's identity (USER-REQUESTS A1): the market's logo, its pair, and the side pill. */
function CardHead({ coin, title, side, pill, children = null }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <CoinLogo coin={coin} size={24} />
      <span className="truncate text-h2">{title}</span>
      {pill ? <span className={sidePill(side)}>{pill}</span> : null}
      {children}
    </span>
  );
}

/* A settled card, one line: what happened, to which market. */
function OneLiner({ ok, coin, title, sub = null, warn = false }) {
  return (
    <div className="t-swap-in flex items-center gap-2.5 px-4 py-3">
      {warn ? <Icon name="alert" size={18} className="text-warning" /> : ok ? <SuccessCheck size={20} className="text-success" /> : <Icon name="x" size={16} className="text-muted-foreground" />}
      {coin ? <CoinLogo coin={coin} size={20} /> : null}
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {sub ? <div className="num text-xs text-muted-foreground">{sub}</div> : null}
      </div>
    </div>
  );
}

function useCountdown(seconds, key) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const t = setInterval(() => setLeft((s) => (s <= 1 ? seconds : s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds, key]);
  return left;
}

/* Is the card narrower than `px` (a phone, the trade aside's Chat tab)? Its chart's height is a number, so it reads
   the card's own width rather than a CSS container query. */
function useNarrow(ref, px = 520) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const set = (w) => setNarrow(w > 0 && w < px);
    set(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver((es) => { const e = es[es.length - 1]; if (e) set(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return narrow;
}

function shakeEl(el) {
  if (!el) return;
  el.classList.remove("is-shaking");
  void el.offsetWidth;
  el.classList.add("is-shaking");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => Math.round(v * 100) / 100;
/* An outcome the exchange layer could not confirm either way: the sheet LOCKS (never a second send from it). */
const UNKNOWN_CODES = /unknown|timeout|bad_response|unexpected|network|no_answer/i;

/**
 * 🔴 THE READ-BACK (EXECUTION-ASSURANCE item 3, lib/hyperliquid/readBack.js): after a fill, Hyperliquid's own position
 * and open orders are read and compared with what the user confirmed (side, size within a lot, leverage, isolated, the
 * TP / SL legs at the prices SENT). A mismatch first re-reads once 1.5 s later (a new order can take a moment to show);
 * whatever remains is a row on the position card, never silent. Reads only; a mock build reads nothing (its account is
 * not on the exchange).
 */
async function verifyFill({ b, mid, rb }) {
  if (!b || b.mock || typeof b.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.address)) return;
  const read = () => readBackFill({ info: (body) => hlInfo(body), user: b.address, card: rb });
  let v = null;
  try { v = await read(); } catch { v = null; }
  if (!v || !v.ok) {
    await sleep(1500);
    try { v = await read(); } catch { v = null; }
  }
  const rows = v ? v.mismatches.map((m) => ({ text: m.text, severity: m.severity })) : [{ text: "Couldn't read your position back just now, so this trade isn't verified yet. Check your positions.", severity: "error" }];
  try { chat.patchCard(mid, { readBack: { ok: !!(v && v.ok), unknown: !v || !!v.unknown, rows: rows.slice(0, 4), at: Date.now() } }); } catch { /* the card moved on */ }
  if (v && !v.ok) chat.noteLlm(`The read-back after the fill found: ${rows.map((x) => x.text).join(" ")}`);
}

/** The FlowFlow proposed order. It re-quotes itself from the live market; the LLM's own numbers are never shown.
 *  🔴 Its Confirm no longer sends (owner item 17): it opens the final chart sheet (cards/FinalTradeSheet.jsx), whose ONE
 *  Open button is the only send, once, after the freshness and cap re-checks below. */
function OpenCard({ mid, card, latest }) {
  const b = useBackend();
  const { market, stale } = usePerpMarket(card.coin);
  const [phase, setPhase] = useState(card.status === "filled" ? "done" : card.status === "cancelled" ? "cancelled" : "review");
  const [error, setError] = useState(null);
  const [signIn, setSignIn] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const [edited, setEdited] = useState(null);
  const box = useRef(null);
  const buy = card.side === "buy";
  const lev = fin(card.leverage) ? Math.min(card.leverage, AGENT_MAX_LEVERAGE) : null;
  /* A recommended TP / SL (AD-7: the trade arrives with legs from the same data as the Recommended setups) carries a
     small tag and a one-tap Remove. What the user typed is never marked: it is theirs. */
  const recObj = card.recommended && typeof card.recommended === "object" ? card.recommended : null;
  const isRec = !!(card.recommended === true || recObj || card.tpslSource === "recommended" || card.tpslFrom === "recommended");
  const tpPct0 = fin(card.tpPct) ? Math.abs(card.tpPct) : recObj && fin(recObj.tpPct) ? Math.abs(recObj.tpPct) : null;
  const slPct0 = fin(card.slPct) ? Math.abs(card.slPct) : recObj && fin(recObj.slPct) ? Math.abs(recObj.slPct) : null;
  const [removed, setRemoved] = useState(card.tpslRemoved === true);
  /* Legs typed in the final sheet's Edit win over the card's own (and over Remove). */
  const tpPct = edited ? edited.tpPct : removed ? null : tpPct0;
  const slPct = edited ? edited.slPct : removed ? null : slPct0;
  const rr = rrOf({ rr: fin(card.rr) ? card.rr : recObj && fin(recObj.rr) ? recObj.rr : null, tpPct: tpPct0, slPct: slPct0 });
  /* A TP / SL the user typed as a PRICE ("sl $2300", "sl 85" on HYPE) is priced on exactly that tick from this card's
     own quote (legPrice.js), not re-derived from a rounded ROE that moves with the entry. Edit's legs and Remove win. */
  const amount = fin(card.marginUsdc) ? card.marginUsdc : null;
  let tpStr = fin(tpPct) ? `+${tpPct}` : "";
  let slStr = fin(slPct) ? `-${slPct}` : "";
  if (!edited && !removed && (fin(card.tpPx) || fin(card.slPx)) && market && amount != null) {
    const levQ = clampLeverage(lev == null ? defaultLeverage(market.maxLeverage) : lev, market.maxLeverage);
    let base = null;
    try { base = b.quoteOpen({ market, side: card.side, marginUsdc: amount, leverage: levQ }); } catch { base = null; }
    const at = { side: card.side, entryPx: base && base.ok ? base.refPx : null, leverage: levQ, szDecimals: market.szDecimals };
    const tpL = fin(card.tpPx) ? legStrForPx({ leg: "tp", px: card.tpPx, ...at }) : null;
    const slL = fin(card.slPx) ? legStrForPx({ leg: "sl", px: card.slPx, ...at }) : null;
    if (tpL) tpStr = tpL.str;
    if (slL) slStr = slL.str;
  }
  const q = useOrderQuote(b, {
    coin: card.coin, market, side: card.side, amount, leverage: lev,
    tpStr, slStr, withLegs: true, stale,
  });
  const left = useCountdown(QUOTE_TTL_S, card.coin);
  const label = coinLabel(card.coin, market) || perpCoinLabel(card.coin, market);
  const Side = buy ? "Long" : "Short";
  /* A phone (review, polish 1: 503px of a 533px thread): a shorter chart, 20px rows, Max loss and Fee on one row;
     Liq. price keeps its own amber row and Confirm keeps its 44px. */
  const narrow = useNarrow(box);
  const plan = card.plan && typeof card.plan === "object" ? card.plan : null;
  /* The plan's lines come in the language the user wrote in; its capped line follows them. */
  const planThai = !!(plan && Array.isArray(plan.steps) && /[฀-๿]/.test(plan.steps.join(" ")));

  /* The card's Confirm: the final chart sheet, nothing sent yet. */
  const confirm = () => {
    if (phase !== "review" || !q.ready) return;
    setError(null);
    setSheet(true);
  };

  /* 🔴 THE ONE SEND (FinalTradeSheet's Open, latched there to one call per tap). Before it: a fresh price (the market
     store's row now, not the one the card rendered with), a stock's limits AGAIN at this moment (a card made in US
     hours and confirmed after the close goes out at most at 5x, never at the card's 10x: EXECUTION-ASSURANCE need 6),
     a fresh quote, and the card's claim (store.js: a card is confirmed once, in one tab). */
  const openNow = async () => {
    const snapNow = perpMarketsStore().getSnapshot();
    const live = snapNow && snapNow.byCoin ? snapNow.byCoin[card.coin] : null;
    if (!live || live.stale === true || q.isStale) return { ok: false, message: "The price feed paused. Nothing was sent: wait for a fresh price." };
    if (!q.ready) return { ok: false, message: `${q.blocker || "This order can't go out right now"}. Nothing was sent.` };
    /* 🔴 FLOWFLOW'S CAPS AGAIN, AT THE SEND, with the leverage the send will USE (pass-2 review): 20 USDC of margin, and
       an ADD (which goes out at the position's own leverage) only while that leverage is within what FlowFlow would
       open now — a stock held at 10x is never added to on a Saturday, a 40x BTC never from here (caps.js). */
    if (!fin(card.marginUsdc) || card.marginUsdc <= 0 || card.marginUsdc > MAX_MARGIN_USDC) return { ok: false, message: `Max ${MAX_MARGIN_USDC} USDC margin per order. Nothing was sent.` };
    if (q.adding) {
      const add = addCapCheck({ coin: card.coin, position: q.held, market: live, now: Date.now() });
      if (!add.ok) return { ok: false, message: `${add.text} Nothing was sent.` };
    } else if (!isStockCoin(card.coin)) {
      const cap = agentLeverageCap({ coin: card.coin, market: live, now: Date.now() });
      if (!fin(q.leverage) || q.leverage > cap.max) return { ok: false, message: `FlowFlow trades at most ${cap.max}x here. Nothing was sent: ask for a new card.` };
    }
    if (isStockCoin(card.coin) && !q.adding) {
      const chk = checkAgentStockOrder({ coin: card.coin, side: card.side, marginUsdc: card.marginUsdc, leverage: q.leverage, markets: snapNow.markets, now: Date.now() });
      if (!chk.ok || chk.leverage !== q.leverage || chk.marginUsdc !== card.marginUsdc) {
        return { ok: false, message: `${chk.text || chk.notes.join(" ") || "This stock's limits changed"}. Nothing was sent: ask for a new card.` };
      }
    }
    const sendLev = q.adding ? heldLeverage(q.held) : q.leverage;
    const quoteAt = (marginUsdc) => (q.adding ? b.quoteAdd({ market: live, position: q.held, marginUsdc })
      : b.quoteOpen({ market: live, side: card.side, marginUsdc, leverage: q.leverage, tp: q.tp, sl: q.sl }));
    let sendMargin = card.marginUsdc;
    let fresh = quoteAt(sendMargin);
    if (!fresh || !fresh.ok) return { ok: false, message: `${(fresh && fresh.message) || "The price moved and the order no longer fits"}. Nothing was sent.` };
    /* 🔴 THE SIZE ROUNDS DOWN, NEVER UP (the order layer rounds to the NEAREST lot, so a 20 USDC card could use a little
       more than 20 USDC, and a stock's automatic top-up could fall short of the rounded order): when the nearest lot is
       above the margin's own size, the margin sent is the one whose size is the lot below. Never more than the card. */
    const down = sendMarginFor({ marginUsdc: sendMargin, leverage: sendLev, szDecimals: q.sz, quote: fresh });
    if (down !== sendMargin) {
      sendMargin = down;
      fresh = quoteAt(sendMargin);
      if (!fresh || !fresh.ok) return { ok: false, message: `${(fresh && fresh.message) || "The order no longer fits at the lot below"}. Nothing was sent.` };
    }
    if (fin(sendLev) && sendLev > 0 && fin(fresh.notionalUsd) && fresh.notionalUsd / sendLev > MAX_MARGIN_USDC + 1e-6) {
      return { ok: false, message: `That size needs more than ${MAX_MARGIN_USDC} USDC of margin. Nothing was sent.` };
    }
    try {
      chat.patchCard(mid, { status: "sending" });
    } catch (e) {
      return { ok: false, unknown: true, message: String((e && e.message) || "This card is already being sent.") };
    }
    setPhase("sending");
    const priorSzi = q.held && fin(q.held.szi) ? q.held.szi : null;
    let r;
    try {
      r = q.adding
        ? await b.addMarket({ coin: card.coin, marginUsdc: sendMargin })
        : await b.openMarket({ coin: card.coin, side: card.side, marginUsdc: sendMargin, leverage: q.leverage, tp: q.tp, sl: q.sl });
    } catch (e) {
      r = { ok: false, code: "unexpected", message: String(e?.message || e) };
    }
    if (r && r.ok) {
      const v0 = fillView(r, { szDecimals: q.sz, adding: q.adding });
      /* The customer's words for the market ("US 100", never the index's venue ticker). */
      const v = { ...v0, title: customerWords(v0.title), fillText: v0.fillText ? customerWords(v0.fillText) : v0.fillText };
      const avg = r.filled && r.filled.avgPx != null ? Number(r.filled.avgPx) : null;
      chat.patchCard(mid, { status: "filled", fillText: v.fillText || null, title: v.title, entryPx: Number.isFinite(avg) ? avg : null });
      /* The line above the card now says what happened (item 8: it said "Long SOL at about $102.03" over "Filled ·
         Entry $101.97"). */
      if (Number.isFinite(avg)) restateLine(mid, `${Side} ${label} filled at ${formatHlPrice(avg, q.sz)}.`);
      chat.noteLlm(`The user confirmed the trade: ${v.title}${v.fillText ? ` (${v.fillText})` : ""}.`);
      toast({ title: v.title, text: v.fillText || null });
      verifyFill({
        b, mid,
        rb: {
          kind: q.adding ? "add" : "open", coin: card.coin, side: card.side, size: r.size, filledSz: r.filled ? r.filled.totalSz : null,
          szDecimals: q.sz, leverage: fin(r.leverage) ? r.leverage : q.leverage, marginMode: "isolated", label,
          ...(q.adding ? { priorSzi } : { tpPx: q.tp ?? null, slPx: q.sl ?? null }),
        },
      });
      /* The sheet shows "Filled" for a beat, closes, and the position card (the big live P&L) takes the card's place. */
      setTimeout(() => { setSheet(false); setPhase("done"); }, 700);
      return { ok: true };
    }
    const err = customerError(tradeErrorView(r || {}));
    const unknown = !!(r && (r.unknown === true || UNKNOWN_CODES.test(String(r.code || ""))));
    try { chat.patchCard(mid, { status: unknown ? "unknown" : "review" }); } catch { /* moved on */ }
    setPhase("review");
    setError(err);
    return { ok: false, unknown, code: r && r.code, message: `${err.title}: ${err.text}` };
  };

  /* Edit in the sheet: prices typed, back to the card's ROE legs at this leverage (the quote re-prices them on the
     tick, and its own checks hold: a leg on the wrong side is refused before anything can be sent). */
  const onEdit = ({ tpPx, slPx }) => {
    const entry = q.quote && q.quote.ok && fin(q.quote.refPx) ? q.quote.refPx : market ? market.px : null;
    if (!fin(entry) || !fin(q.leverage)) return;
    const roe = (px) => (fin(px) ? r2((Math.abs(px - entry) / entry) * q.leverage * 100) : null);
    setEdited({ tpPct: roe(tpPx), slPct: roe(slPx) });
    chat.noteLlm(`The user edited the ${Side.toLowerCase()} ${label} legs in the final check: TP ${tpPx ?? "none"}, SL ${slPx ?? "none"}.`);
  };

  const setLegs = (off) => {
    if (phase !== "review") return;
    setRemoved(off);
    try { chat.patchCard(mid, { tpslRemoved: off }); } catch { /* the card moved on: nothing to change */ }
    chat.noteLlm(off ? `The user removed the recommended TP / SL from the ${Side.toLowerCase()} ${label} card.` : `The user put the recommended TP / SL back on the ${Side.toLowerCase()} ${label} card.`);
  };

  const cancel = () => { setPhase("cancelled"); chat.patchCard(mid, { status: "cancelled" }); chat.noteLlm(`The user cancelled the ${Side.toLowerCase()} ${label} card. Nothing was sent.`); };

  if (phase === "done") return <PositionHero card={card} />;
  if (phase === "cancelled") return <OneLiner ok={false} coin={card.coin} title={`${Side} ${label} cancelled`} />;

  const r = q.risk;
  const busy = phase !== "review";
  const stock = isStockCoin(card.coin);
  const capped = fin(card.leverage) && card.leverage > AGENT_MAX_LEVERAGE;
  const addingNote = q.adding && !busy;
  const blockerNote = q.blocker && !busy;
  const notes = Array.isArray(card.notes) ? card.notes.filter((n) => typeof n === "string" && n).slice(0, 3) : [];
  /* A stock's US market state: one line, on the card only (the popup has its own header line for it). */
  const statusNote = typeof card.statusNote === "string" && card.statusNote ? card.statusNote : null;
  const hasNotes = capped || addingNote || blockerNote || !!error || notes.length > 0 || !!statusNote;
  /* What the final sheet prints and draws: the quote this card holds, the TP / SL at the prices that would be SENT
     (q.tp / q.sl, on the tick: EXECUTION-ASSURANCE need 7), the liquidation estimate, and a plan's own three lines. */
  const sheetPlan = {
    coin: card.coin, side: card.side, leverage: q.leverage, marginUsdc: card.marginUsdc,
    entryPx: q.quote && q.quote.ok && fin(q.quote.refPx) ? q.quote.refPx : market ? market.px : null,
    tpPx: q.adding ? null : q.tp, slPx: q.adding ? null : q.sl,
    liqPx: fin(r.liqPx) ? r.liqPx : plan && fin(plan.liqPx) ? plan.liqPx : null,
    notionalUsd: q.quote && q.quote.ok ? q.quote.notionalUsd : null,
    /* ONE fee for the card and the popup: the market's own rate (a stock's 0.009%), as the card's row prints it. */
    feeUsdc: fin(r.feeUsdc) ? r.feeUsdc : q.quote && q.quote.ok && fin(q.quote.feeUsdc) ? q.quote.feeUsdc : null,
    szDecimals: q.sz,
    rr: edited ? null : rr,
    notes: [...notes, ...(plan && plan.capped && plan.capped.text ? [planThai ? plan.capped.text.th || plan.capped.text.en : plan.capped.text.en] : [])].slice(0, 3),
    mathLines: plan && Array.isArray(plan.steps) ? plan.steps : [],
    isolated: stock || card.marginMode === "isolated",
  };
  /* ONE meaning of % on the card and in the popup: the PRICE move from the entry (the popup's). The loss the user reads
     is the loss AT THE STOP, fees in (finalTradeView pnlAt: the popup's "$ at SL"); the whole margin is the worst case
     only if the stop does not fill (pass-2 review: "Max loss 16.92 USDC" under a $1-risk plan). */
  const entryNow = sheetPlan.entryPx;
  const movePct = (px) => (fin(px) && fin(entryNow) && entryNow > 0 ? ((px - entryNow) / entryNow) * 100 : null);
  const atSl = !q.adding && fin(q.sl) ? pnlAt(sheetPlan, q.sl) : null;
  return (
    <div ref={box} className="ff-shake relative">
      <span
        aria-hidden="true"
        className="ff-quote-rule absolute inset-x-5 top-0 h-0.5 rounded-full bg-foreground"
        data-reset={left === QUOTE_TTL_S ? "true" : "false"}
        style={{ transform: `scaleX(${left / QUOTE_TTL_S})` }}
      />
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-2.5 [@container(min-width:520px)]:pb-2.5 [@container(min-width:520px)]:pt-3">
        <CardHead coin={card.coin} title={pairLabel(card.coin, market)} side={buy ? "long" : "short"} pill={`${q.adding ? "Add · " : ""}${q.leverage ?? "—"}x ${Side}${stock ? " · Isolated" : ""}`} />
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">Quote · {left}s</span>
      </div>

      {/* A risk-based plan (plan_trade, items 13–16): its maths in three short lines, and, when a cap made it smaller,
          the capped line with the real risk, said plainly (never a silent change of the user's numbers). */}
      {plan && ((Array.isArray(plan.steps) && plan.steps.length) || plan.capped) ? (
        <div className="space-y-0.5 border-t border-hairline px-4 py-2">
          {(plan.steps || []).slice(0, 3).map((l) => <p key={l} className="text-[12px] leading-[1.5] tabular-nums text-muted-foreground">{l}</p>)}
          {plan.capped && plan.capped.text ? <p className="pt-0.5 text-xs font-medium text-warning">{planThai ? plan.capped.text.th || plan.capped.text.en : plan.capped.text.en}</p> : null}
        </div>
      ) : null}

      <div className="grid border-t border-hairline [@container(min-width:520px)]:grid-cols-2">
        <div className="min-w-0 px-4 py-2 [@container(min-width:520px)]:py-3">
          <div className="mb-1 flex items-baseline justify-between gap-3 [@container(min-width:520px)]:mb-1.5">
            <span className="font-mono text-[11px] text-muted-foreground">Price · 1h</span>
            <TickNumber value={market ? formatHlPrice(market.px, q.sz) : "—"} className="num text-sm font-medium" />
          </div>
          <MiniChart coin={card.coin} live={latest} height={narrow ? 76 : 96} lines={[{ id: "tp", price: q.tp }, { id: "sl", price: q.sl }]} />
        </div>
        <div className="min-w-0 border-t border-hairline px-4 py-2 [@container(min-width:520px)]:border-l [@container(min-width:520px)]:border-t-0 [@container(min-width:520px)]:py-3">
          <dl className="text-[13px] leading-5 [@container(min-width:520px)]:space-y-1.5 [@container(min-width:520px)]:text-xs [@container(min-width:520px)]:leading-normal">
            <Row label="Margin">{fin(card.marginUsdc) ? `${card.marginUsdc.toFixed(2)} USDC` : "—"}</Row>
            <Row label="Size"><AnimatedNumber value={r.sizeText} /></Row>
            <Row label="Liq. price" tone="text-warning">{q.adding ? "after fill" : <AnimatedNumber value={r.liqText} />}</Row>
            {q.adding ? <Row label="TP / SL">stay as set</Row> : null}
            {!q.adding && isRec && !edited && (fin(tpPct0) || fin(slPct0)) ? (
              <div className="my-1 flex items-center justify-between gap-2 border-t border-hairline pt-1.5 [@container(min-width:520px)]:mb-0 [@container(min-width:520px)]:mt-0 [@container(min-width:520px)]:pt-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="inline-flex h-5 items-center gap-1 rounded-full bg-success/[.1] px-1.5 text-[11px] font-medium text-success ring-1 ring-inset ring-success/20">
                    <Icon name="check" size={11} strokeWidth={2.4} />{card.planned ? "Planned" : "Recommended"}
                  </span>
                  {!removed && fin(rr) ? <span className="num whitespace-nowrap text-muted-foreground">RR {rrText(rr)}</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => setLegs(!removed)}
                  disabled={busy}
                  className="ff-press ff-hit -mr-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45"
                >
                  {removed ? <><Icon name="plus" size={12} />Add back</> : <><Icon name="x" size={12} />Remove</>}
                </button>
              </div>
            ) : null}
            {!q.adding && removed && isRec && !edited ? <Row label="TP / SL"><span className="font-normal text-muted-foreground">None</span></Row> : null}
            {!q.adding && fin(tpPct) ? (
              <Row label="Take profit">
                {q.tpView.error
                  ? <span className="text-destructive">Check TP</span>
                  : <><span className="text-success">{q.tpView.triggerText}</span> <span className="font-normal text-muted-foreground">{minus(pctText(movePct(q.tp)))}</span></>}
              </Row>
            ) : null}
            {!q.adding && fin(slPct) ? (
              <Row label="Stop loss">
                {q.slView.error
                  ? <span className="text-destructive">Check SL</span>
                  : <><span className="text-destructive">{q.slView.triggerText}</span> <span className="font-normal text-muted-foreground">{minus(pctText(movePct(q.sl)))}</span></>}
              </Row>
            ) : null}
            {atSl ? (
              <>
                {narrow
                  ? <Row label="Loss at SL · fee" tone="text-destructive">{minus(usdSigned(atSl.usd))} <span className="font-normal text-muted-foreground">· {feeWords(r.feeUsdc)}</span></Row>
                  : <Row label="Loss at SL" tone="text-destructive">{minus(usdSigned(atSl.usd))}</Row>}
                <p className="num text-right text-[11px] text-muted-foreground">Worst case {r.maxLossText} if the SL doesn't fill</p>
                {narrow ? null : <Row label="Fee">{feeWords(r.feeUsdc)}</Row>}
              </>
            ) : narrow ? (
              <Row label="Worst case · fee">{r.maxLossText} <span className="font-normal text-muted-foreground">· {feeWords(r.feeUsdc)}</span></Row>
            ) : (
              <>
                <Row label="Worst case">{r.maxLossText}</Row>
                <Row label="Fee">{feeWords(r.feeUsdc)}</Row>
              </>
            )}
          </dl>
        </div>
      </div>

      {hasNotes ? (
        <div className="space-y-1.5 px-4 pt-2.5 text-xs">
          {capped ? <p className="text-muted-foreground">Leverage capped at {AGENT_MAX_LEVERAGE}x for FlowFlow.</p> : null}
          {notes.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
          {statusNote ? <p className={/closed|ปิด/i.test(statusNote) ? "text-warning" : "text-muted-foreground"}>{statusNote}</p> : null}
          {addingNote ? <p className="text-muted-foreground">You already hold a {label} {Side.toLowerCase()}: this adds {fin(card.marginUsdc) ? card.marginUsdc : "—"} USDC to it at its {q.leverage}x.</p> : null}
          {blockerNote ? <p className={q.opposite ? "text-warning" : "text-muted-foreground"}>{q.blocker}</p> : null}
          {error ? <p role="alert" className="text-destructive">{error.title}: {error.text}</p> : null}
        </div>
      ) : null}

      {/* The actions close the card. Confirm opens the final check (the chart with every level on it); only its Open
          button sends. */}
      {!b.connected ? (
        <div className={`border-t border-hairline px-4 pb-3 pt-2.5 ${hasNotes ? "mt-2.5" : ""}`}>
          {signIn
            ? <div className="t-swap-in"><ConnectCard start="list" bare onDone={() => setSignIn(false)} /></div>
            : <Button variant="primary" size="md" className="w-full" onClick={() => setSignIn(true)}>Sign in to confirm</Button>}
        </div>
      ) : (
        <div className={`grid grid-cols-[2fr_1fr] gap-2 border-t border-hairline px-4 pb-3 pt-2.5 ${hasNotes ? "mt-2.5" : ""}`}>
          {/* A short's Confirm is solid red like a long's lime (pass-2 review: the 12% tint read as disabled). */}
          <Button variant={buy ? "brand" : "short"} size="md" className={buy ? "" : SHORT_SOLID} onClick={confirm} disabled={!q.ready && phase === "review"} aria-busy={busy} aria-haspopup="dialog">
            <IconSwap state={phase === "sending" ? "b" : "a"} a={<Icon name="check" size={16} />} b={<Spinner size={16} />} c={<Icon name="check" size={16} strokeWidth={2.4} />} />
            <TextSwap text={phase === "sending" ? "Placing…" : q.adding ? "Confirm add" : `Confirm ${Side.toLowerCase()}`} />
          </Button>
          <Button variant="outline" size="md" onClick={cancel} disabled={busy}>Cancel</Button>
        </div>
      )}
      {/* Into <body>: the card's frame clips (overflow-hidden) and is a size container, either of which would trap a
          fixed layer inside the card. */}
      {typeof document !== "undefined" ? createPortal(
        <FinalTradeSheet
          key={sheetKey}
          open={sheet}
          onClose={() => { setSheet(false); if (card.status === "unknown") setSheetKey((k) => k + 1); }}
          plan={sheetPlan}
          market={market}
          onOpen={openNow}
          onEdit={q.adding ? null : onEdit}
          stale={!!q.isStale}
        />,
        document.body,
      ) : null}
    </div>
  );
}

/** Close all or part of a position, with the close figures the close sheet prints. */
function CloseCard({ mid, card }) {
  const b = useBackend();
  const { market } = usePerpMarket(card.coin);
  const [fraction, setFraction] = useState(card.fraction || 1);
  const [phase, setPhase] = useState(card.status === "filled" ? "done" : card.status === "cancelled" ? "cancelled" : "review");
  const box = useRef(null);
  const pos = b.account && b.account.positions && b.account.positions.byCoin ? b.account.positions.byCoin[card.coin] : null;
  const sz = market ? market.szDecimals : null;
  const cv = closeView(pos, fraction, { feeRate: b.feeRate, szDecimals: sz });
  const pv = pos ? positionView(pos, { szDecimals: sz }) : null;
  const label = coinLabel(card.coin, market) || perpCoinLabel(card.coin, market);

  const confirm = async () => {
    if (phase !== "review" || !pos) return;
    setPhase("sending");
    chat.patchCard(mid, { status: "sending" });
    let r;
    try { r = await b.closeFraction(card.coin, fraction); } catch (e) { r = { ok: false, code: "unexpected", message: String(e?.message || e) }; }
    if (r && r.ok) {
      const v = closeResultView(r, { szDecimals: sz });
      /* 🔴 A PART-FILLED close is not "position closed" (a thin book overnight can fill only part of a reduce-only IOC):
         the title says so, and the warnings (TP / SL orders that could not be cancelled) are printed, never dropped. */
      const partial = r.partial === true || (r.status && r.status !== "filled");
      const title = customerWords(partial ? `Partly closed ${label}` : v ? v.title : `Closed ${label}`);
      const fillText = customerWords([...(v ? v.lines : []), ...(v ? v.warnings : []), ...(partial ? ["The rest is still open."] : [])].join(" · ")) || null;
      chat.patchCard(mid, { status: "filled", title, fillText, partial: !!partial, warn: !!(partial || (v && v.warn)) });
      chat.noteLlm(`The user confirmed the close: ${title}${fillText ? ` (${fillText})` : ""}.`);
      toast({ title, text: fillText, tone: partial || (v && v.warn) ? "info" : "success" });
      setPhase("beat");
      setTimeout(() => setPhase("done"), 700);
    } else {
      const err = customerError(tradeErrorView(r || {}));
      toast({ title: err.title, text: err.text, tone: "error" });
      chat.patchCard(mid, { status: "review" });
      setPhase("review");
      shakeEl(box.current);
    }
  };

  if (phase === "done" || phase === "cancelled") {
    const ok = phase === "done";
    return <OneLiner ok={ok && !card.partial} warn={ok && !!card.warn} coin={card.coin} title={ok ? card.title || `Closed ${label}` : `Close ${label} cancelled`} sub={ok ? card.fillText : null} />;
  }
  if (!pos) {
    return <p className="p-4 text-sm text-muted-foreground">No open {label} position to close.</p>;
  }
  const busy = phase !== "review";
  return (
    <div ref={box} className="ff-shake space-y-2.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <CardHead coin={card.coin} title={`Close ${label}`} side={pv ? pv.side : null} pill={pv && pv.side ? pv.pill : null} />
        <span className="num shrink-0 text-xs text-muted-foreground">{cv.qtyText}</span>
      </div>
      <Seg label="How much to close" full size="sm" value={fraction} onChange={setFraction}
        items={CLOSE_DETENTS.map((f) => ({ value: f, label: f === 1 ? "All" : `${Math.round(f * 100)}%` }))} />
      <dl className="space-y-1.5 text-xs">
        <Row label="You get back">{cv.valueText} USDC</Row>
        <Row label="P&L" tone={toneClass(cv.pnlTone)}>{minus(cv.pnlText)}</Row>
        <Row label="Fee">{cv.feeText}</Row>
      </dl>
      <div className="grid grid-cols-[2fr_1fr] gap-2">
        <Button variant="primary" size="md" onClick={confirm} disabled={busy}>
          <IconSwap state={phase === "sending" ? "b" : phase === "beat" ? "c" : "a"} a={<Icon name="check" size={16} />} b={<Spinner size={16} />} c={<Icon name="check" size={16} strokeWidth={2.4} />} />
          <TextSwap text={phase === "sending" ? "Closing…" : phase === "beat" ? "Done" : "Confirm close"} />
        </Button>
        <Button variant="outline" size="md" disabled={busy} onClick={() => { setPhase("cancelled"); chat.patchCard(mid, { status: "cancelled" }); chat.noteLlm(`The user cancelled the close card for ${label}.`); }}>Cancel</Button>
      </div>
    </div>
  );
}

/** Set or change TP / SL on an open position: the position row's own editor, pre-filled with what was asked. */
function TpSlCard({ mid, card }) {
  const b = useBackend();
  const { market } = usePerpMarket(card.coin);
  const [phase, setPhase] = useState(card.status === "filled" ? "done" : card.status === "cancelled" ? "cancelled" : "review");
  const acc = b.account || {};
  const pos = acc.positions && acc.positions.byCoin ? acc.positions.byCoin[card.coin] : null;
  const pv = pos ? positionView(pos, { szDecimals: market ? market.szDecimals : null }) : null;
  const label = coinLabel(card.coin, market) || perpCoinLabel(card.coin, market);
  /* A level typed as a PRICE ("ตั้ง SL ETH 2300") is handed to the editor as the ROE string that lands on exactly that
     tick from the position's own entry and leverage (legPrice.js); a % is handed as typed. */
  const at = pos ? { side: pos.side === "short" || pos.szi < 0 ? "sell" : "buy", entryPx: pos.entryPx, leverage: heldLeverage(pos), szDecimals: market ? market.szDecimals : null } : null;
  const tpL = at && fin(card.tpPx) ? legStrForPx({ leg: "tp", px: card.tpPx, ...at }) : null;
  const slL = at && fin(card.slPx) ? legStrForPx({ leg: "sl", px: card.slPx, ...at }) : null;
  const initTp = tpL ? tpL.str : fin(card.tpPct) ? `+${card.tpPct}` : null;
  const initSl = slL ? slL.str : fin(card.slPct) ? `-${card.slPct}` : null;
  if (phase === "done" || phase === "cancelled") {
    const ok = phase === "done";
    return <OneLiner ok={ok} coin={card.coin} title={ok ? customerWords(card.title || `TP / SL set on ${label}`) : `TP / SL for ${label} cancelled`} sub={ok ? customerWords(card.fillText) : null} />;
  }
  if (!pos) return <p className="p-4 text-sm text-muted-foreground">No open {label} position to protect.</p>;
  return (
    <div className="space-y-2.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <CardHead coin={card.coin} title={`TP / SL on ${label}`} side={pv ? pv.side : null} pill={pv && pv.side ? pv.pill : null} />
        <Button variant="ghost" size="sm" className="-mr-2 shrink-0" onClick={() => { setPhase("cancelled"); chat.patchCard(mid, { status: "cancelled" }); chat.noteLlm(`The user cancelled the TP / SL card for ${label}.`); }}>Cancel</Button>
      </div>
      <TpSlEditor
        compact
        p={pos}
        market={market}
        orders={acc.orders}
        initTp={initTp}
        initSl={initSl}
        onDone={(ok, v) => {
          if (!ok) return;
          const text = v ? v.lines.join(" · ") : null;
          chat.patchCard(mid, { status: "filled", title: v ? v.title : "TP / SL updated", fillText: text });
          chat.noteLlm(`The user confirmed TP / SL on ${label}${text ? `: ${text}` : ""}.`);
          setPhase("done");
        }}
      />
    </div>
  );
}

/* A card kind this build does not draw (a newer app wrote it): a quiet line, never another card's controls. */
function UnknownCard() {
  return <p className="px-4 py-3 text-sm text-muted-foreground">This card needs a newer version of the app.</p>;
}

/* The pick-4 card (item 12): a tap marks the tile and asks for its setups, with the side the user asked for, by the
   ticker (never a venue name). The setups end in a trade card that still waits for Confirm. */
function PickWrap({ mid, card }) {
  const ctx = useChatActions();
  const pick = (coin) => {
    try { chat.patchCard(mid, { chosen: coin }); } catch { /* the card moved on */ }
    if (ctx && typeof ctx.send === "function") ctx.send(pickTapWords(coin, card.side || null, agentTicker(coin)));
  };
  return <PickCard card={card} onPick={pick} disabled={!!(ctx && ctx.busy)} />;
}

/* A close-all that finished: one line with what it realized, and the rows behind a small Details toggle (pass-2 review:
   the rows and the P&L the user just took vanished into "Closed all 2 positions."). */
function SettledCloseAll({ card }) {
  const [open, setOpen] = useState(false);
  const rows = Array.isArray(card.rows) ? card.rows.filter((r) => r && typeof r.coin === "string") : [];
  return (
    <div>
      <OneLiner ok coin={null} title={card.resultText || "Closed all positions"} />
      {rows.length ? (
        <div className="-mt-1 px-4 pb-3">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ff-press ff-hit inline-flex h-6 items-center gap-1 rounded-md px-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
            Details<Icon name="chevronDown" size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open ? (
            <ul className="t-swap-in mt-1 space-y-1 text-xs">
              {rows.map((r) => (
                <li key={r.coin} className="flex items-center gap-2">
                  <CoinLogo coin={r.coin} size={16} />
                  <span className="font-medium">{r.label || r.coin}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.text || ""}</span>
                  <span className={`num ${r.pnlTone === "pos" ? "text-success" : r.pnlTone === "neg" ? "text-destructive" : ""}`}>{r.pnlText}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* Close all (item 7): every open position (or the ones named), closed one by one through the same reduce-only close a
   single card sends. 🔴 The card is claimed (store.js) at the first close of a run, so a second tab or a second tap can
   never run it twice; it settles to "filled" only when every row closed, and a partial result stays up for review so
   the refused rows can be tried again. A row whose answer was lost is "unknown": never re-sent from here. */
function CloseAllWrap({ mid, card }) {
  const b = useBackend();
  const claimed = useRef(false);
  if (card.status === "filled" || card.status === "cancelled") {
    if (card.status === "filled") return <SettledCloseAll card={card} />;
    return <OneLiner ok={false} coin={null} title="Close all cancelled. Nothing was sent." />;
  }
  const ps = b.account && b.account.positions ? b.account.positions : null;
  const list = ps && ps.answered ? ps.list : [];
  /* 🔴 THE WHOLE LIST OR NO CONFIRM: stock positions join the list after the crypto ones (positions.complete), so a
     card confirmed before they load would close BTC, settle to "Closed your position." and leave TSLA open. */
  const whole = !!(ps && ps.complete === true);
  const positions = closeAllPositions(list, Array.isArray(card.coins) && card.coins.length ? card.coins : null);
  /* The share of each the sentence asked ("close half ETH and SOL"): the close steps only, never more than asked. */
  const fraction = [0.25, 0.5, 0.75, 1].includes(card.fraction) ? card.fraction : 1;
  const closeOne = async (coin) => {
    if (!claimed.current) {
      try { chat.patchCard(mid, { status: "sending" }); claimed.current = true; } catch (e) { return { ok: false, code: "taken", message: String((e && e.message) || "This card is already running.") }; }
    }
    try { return await b.closeFraction(coin, fraction); } catch (e) { return { ok: false, code: "unexpected", message: String((e && e.message) || e) }; }
  };
  const onSettled = (s) => {
    claimed.current = false;
    const all = !s.failed && !s.unknown;
    try { chat.patchCard(mid, { status: all ? "filled" : s.unknown ? "unknown" : "review", resultText: s.text || null, ...(Array.isArray(s.rows) ? { rows: s.rows.slice(0, 20) } : {}) }); } catch { /* moved on */ }
    chat.noteLlm(`Close all: ${s.text || `${s.done} of ${s.total} closed`}.`);
  };
  const onCancel = () => {
    try { chat.patchCard(mid, { status: "cancelled" }); } catch { /* moved on */ }
    chat.noteLlm("The user cancelled the close-all card. Nothing was sent.");
  };
  if (b.connected && !whole) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3 text-sm text-muted-foreground" role="status">
        <Spinner size={14} />Your stock positions are still loading. The close-all list shows once every position is in.
      </div>
    );
  }
  return <CloseAllCard positions={positions} fraction={fraction} closeOne={b.connected ? closeOne : null} onSettled={onSettled} onCancel={onCancel} />;
}

export default function TradeCard({ message, latest }) {
  const card = message.card || {};
  /* Setups, asset boxes, picks and headlines are boxes of their own: no frame around them. */
  if (card.kind === "setups") return <SetupsCard mid={message.id} card={card} />;
  if (card.kind === "assets") return <AssetsCard card={card} />;
  if (card.kind === "pick") return <PickWrap mid={message.id} card={card} />;
  if (card.kind === "news") return <NewsCard card={card} />;
  if (card.kind === "choices") return <ChoicesCard card={card} />;
  /* Every other card gets the Agent's frame: white, one ring, rounded-2xl (owner, USER-REQUESTS E). Its inner grids
     follow the card's own width (a container), so it lays out the same in the 760px thread and in the trade aside's
     Chat tab. */
  const kind = card.kind || "open";
  return (
    <div className="t-rise overflow-hidden rounded-2xl bg-card ring-1 ring-border [container-type:inline-size]">
      <AutoHeight>
        {kind === "close" ? <CloseCard mid={message.id} card={card} />
          : kind === "closeAll" ? <CloseAllWrap mid={message.id} card={card} />
          : kind === "tpsl" ? <TpSlCard mid={message.id} card={card} />
          : kind === "stake" ? <StakeCard mid={message.id} card={card} />
          : kind === "unlocks" ? <UnlockCard card={card} />
          : kind === "analysis" ? <AnalysisCard mid={message.id} card={card} />
          : kind === "open" ? <OpenCard mid={message.id} card={card} latest={latest} />
          : <UnknownCard />}
      </AutoHeight>
    </div>
  );
}
