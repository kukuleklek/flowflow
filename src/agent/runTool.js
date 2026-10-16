// Runs the Agent's tools IN THE BROWSER (Hyperliquid rate-limits per IP, so reads never go through our server).
// Everything is injected (ctx), so this file is a pure function of its inputs and is tested under Node.
//
// Results are deliberately small: rounded figures, no raw candles, no fields the model does not need. They go to a
// free-tier model with a token budget, and anything we send may be used by the provider.
import { SPOT_ACTIONS, spotHref, spotSymbol } from "./spotAsk.js";
import { formatHlPrice, formatHlPct, formatHlUsdCompact, formatHlFunding } from "../lib/hyperliquid/format.js";
import {
  balanceView, positionView, riskView, perpMarketFeeRate, perpCoinLabel, tpslBasisFromQuote, tpslLegView,
} from "../perp/live/perpLiveView.js";
import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { filterMarkets, mainMarkets, stockMarkets } from "../trade/marketLists.js";
import { whitelistAssets } from "../lib/avax/whitelist.js";
import { readFunds, marginShortfall } from "./funds.js";
import { isReadTool, isActionTool } from "./tools.js";
import {
  SETUP_INTERVAL, SETUP_BARS, buildSetups, setupsCard, setupsForModel, setupCandidates, withRecommendedTpSl, cleanCandles,
  heldCoins, trendGap,
} from "./setups.js";
import { readEarnApy, stakeCard, stakeForModel, EARN_ENABLED, peekEarnApy } from "./earn.js";
import { moneyMapFor } from "./moneyMap.js";
import { readUnlocks, readEmission, unlocksView, TOKENOMIST_ON } from "../lib/tokenomist/client.js";
import { isCovered } from "../lib/tokenomist/slugs.js";
import { analyzeMarket, analysisForModel } from "./analyze.js";
import {
  resolveMarket, stockMarketForModel, stockRowsForModel, checkAgentStockOrder, stockCandles, stockSetupsInput,
  STOCK_CANDLE_BARS, agentTicker, isStockCoin, langOf,
} from "./stocks.js";
import { planTradeToolCall } from "./tradePlan.js";
import { readNews as readNewsDefault, newsQueryFor, newsForModel, newsView } from "../lib/news/client.js";
import { buildPickCard, newsTopicFor, pickForModel } from "./picks.js";
import { closeAllPositions } from "./closeAll.js";
import { addCapCheck, heldLeverage } from "./caps.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);

/**
 * The live market for a name the model typed ("eth", "PEPE" → kPEPE, "TSLA" / "Tesla" / "US100" → the stock), or null.
 * Crypto on the main dex always wins; a US stock or index only when the Stock pill lists it right now (stocks.js
 * resolveMarket: one gate for the list and the Agent). A paused or unlisted stock is null here: marketFor() says why.
 */
export function resolveCoin(name, snapshot) {
  if (!name || !snapshot || !snapshot.byCoin) return null;
  const want = String(name).trim().toUpperCase().replace(/-USD$|-PERP$|\/USDC?$/, "");
  const list = mainMarkets(snapshot.markets || []);
  const crypto = list.find((m) => m.coin.toUpperCase() === want)
    || list.find((m) => m.coin.toUpperCase() === `K${want}`)
    || null;
  if (crypto) return crypto;
  let r = null;
  try { r = resolveMarket(String(name), snapshot.markets || [], { text: false }); } catch { r = null; }
  return r && r.ok && r.kind === "stock" ? r.row : null;
}

/**
 * The market for a name, or the plain reason there is none: { m } | { error }. A paused stock (NFLX) or one FlowFlow
 * does not list (GOLD, AVGO) says so and names listed ones to offer instead: no card, never a crypto by mistake.
 */
export function marketFor(name, snapshot) {
  const m = resolveCoin(name, snapshot);
  if (m) return { m };
  let r = null;
  try { r = name ? resolveMarket(String(name), (snapshot && snapshot.markets) || [], { text: false }) : null; } catch { r = null; }
  if (r && !r.ok) return { error: `${r.texts.en} No card: say this in one line and offer a listed one.` };
  return { error: `No market called ${name}.` };
}

/* A Spot Account coin's USD price, from the live market list only (a stable at its peg, BTC.b at BTC, AVAX / WAVAX at
   AVAX); anything else has no price here, so its value is unknown and the Spot total says it is partial. */
function spotPriceOf(snap) {
  const px = (c) => { const m = snap && snap.byCoin ? snap.byCoin[c] : null; return m && fin(m.px) && m.px > 0 ? m.px : null; };
  return (sym) => (sym === "USDC" || sym === "USDT" || sym === "USDt" ? 1 : sym === "BTC.b" ? px("BTC") : sym === "AVAX" || sym === "WAVAX" ? px("AVAX") : null);
}

/**
 * How many markets and coins FlowFlow has right now (item 22: "how many asset you have" answered "10 markets are shown"
 * — the length of a truncated list). Crypto perps: the Perps list; stocks: the Stock pill's list; Spot coins: the Spot
 * Account's swap whitelist. From the live lists, never a fixed number.
 */
export function marketCounts(snapshot) {
  const markets = (snapshot && Array.isArray(snapshot.markets)) ? snapshot.markets : [];
  let spot = null;
  try { spot = whitelistAssets().length; } catch { spot = null; }
  return { crypto_perps: mainMarkets(markets).length, stocks: stockMarkets(markets).length, spot_coins: spot };
}

/** A market as the MODEL reads it: the ticker ("TSLA", "US100"), never a venue-qualified id it would repeat. */
export const tickerOf = (coin) => (isStockCoin(coin) ? agentTicker(coin) : coin);

function marketRow(m) {
  return {
    coin: tickerOf(m.coin),
    price: formatHlPrice(m.px, m.szDecimals),
    change_24h: formatHlPct(m.change24hPct),
    volume_24h: formatHlUsdCompact(m.dayNtlVlm),
    funding_hourly: formatHlFunding(m.funding),
    max_leverage: m.maxLeverage,
  };
}

function summarizeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const first = candles[0];
  const last = candles[candles.length - 1];
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  const change = ((last.close - first.open) / first.open) * 100;
  const half = Math.floor(candles.length / 2);
  const avg = (xs) => xs.reduce((s, c) => s + c.close, 0) / xs.length;
  const trend = avg(candles.slice(half)) > avg(candles.slice(0, half)) * 1.002 ? "up" : avg(candles.slice(half)) < avg(candles.slice(0, half)) * 0.998 ? "down" : "flat";
  return { bars: candles.length, open: first.open, close: last.close, high: hi, low: lo, change_pct: r2(change), trend };
}

/* A margin the Main Account cannot use right now (funds.js marginShortfall: the FREE amount less the fee, the card's
   own test): the card would say "More than you can use right now", so the model is told to find out where the money
   is instead (get_funds). null when it fits or a figure is unread. */
function shortOf(ctx, m, marginUsdc, leverage) {
  return marginShortfall(ctx.backend, { marginUsdc, leverage, feeRate: perpMarketFeeRate(m, ctx.backend.feeRate), coin: m.coin });
}
const freeNote = (s) => (s.inPositionsUsdc > 0 ? ` (${s.freeUsdc} USDC free to use; the rest backs open positions or orders)` : "");
const SHORT_NOTE = (s) => `This margin is more than the Main Account can use right now: it holds ${s.balanceUsdc} USDC${freeNote(s)}, and at most ${s.maxMarginUsdc} USDC can go into this order. The card cannot be confirmed yet: call get_funds and tell the user where their money is and what happens next.`;
const CARD_SHORT_NOTE = (s) => `The Main Account holds ${s.balanceUsdc} USDC${freeNote(s)}, and at most ${s.maxMarginUsdc} USDC can go into this order, so the user cannot confirm the card yet. Do not propose it again: say where their money is and what happens next, from get_funds.`;

function heldOf(ctx, coin) {
  if (!ctx || !ctx.backend) return null;
  const pos = ctx.backend.account && ctx.backend.account.positions && ctx.backend.account.positions.byCoin ? ctx.backend.account.positions.byCoin[coin] : null;
  return pos && fin(pos.szi) && pos.szi !== 0 ? pos : null;
}

function quote(args0, ctx, m) {
  const b = ctx.backend;
  let args = args0;
  const side = args.side === "short" ? "sell" : "buy";
  const held = heldOf(ctx, m.coin);
  const heldSide = held ? (held.side === "short" ? "sell" : "buy") : null;
  if (held && heldSide !== side) {
    return { coin: tickerOf(m.coin), ok: false, problem: `The user already holds a ${tickerOf(m.coin)} ${held.side}. One position per market: close it first.` };
  }
  /* 🔴 A stock is priced at what its card would carry: the margin cap, min(its own max, 10x, 5x while the US market
     is closed), isolated (stocks.js checkAgentStockOrder). A refusal is said, never priced. */
  let stockNotes = [];
  if (isStockCoin(m.coin) && !held) {
    const chk = checkAgentStockOrder({ coin: m.coin, side, marginUsdc: fin(args.margin_usdc) ? args.margin_usdc : null, leverage: fin(args.leverage) ? args.leverage : null, markets: ctx.snapshot.markets, now: nowOf(ctx) });
    if (!chk.ok && !chk.ask) return { coin: tickerOf(m.coin), ok: false, problem: chk.text };
    args = { ...args, ...(chk.marginUsdc != null ? { margin_usdc: chk.marginUsdc } : {}), ...(chk.leverage != null ? { leverage: chk.leverage } : {}) };
    stockNotes = [...chk.notes, ...chk.warningTexts];
  }
  const adding = !!held;
  const lev = adding && held.leverage && fin(held.leverage.value) ? held.leverage.value : Math.min(fin(args.leverage) ? args.leverage : 1, m.maxLeverage || 1);
  const margin = fin(args.margin_usdc) ? args.margin_usdc : null;
  const q = margin == null ? null : adding ? b.quoteAdd({ market: m, position: held, marginUsdc: margin }) : b.quoteOpen({ market: m, side, marginUsdc: margin, leverage: lev });
  const risk = riskView({
    side, marginUsdc: margin, leverage: lev, market: m, feeRate: perpMarketFeeRate(m, b.feeRate),
    balanceSource: b.account && b.account.mode ? b.account.mode.source : null,
    notionalUsd: q && q.ok ? q.notionalUsd : null, liqPx: b.mock ? (q && q.ok ? q.liqPx : null) : undefined,
  });
  const basis = tpslBasisFromQuote(q, { side, leverage: lev, szDecimals: m.szDecimals, markPx: fin(m.markPx) ? m.markPx : m.px, liqPx: risk.liqPx });
  const tp = fin(args.tp_roe_pct) ? tpslLegView({ leg: "tp", mode: "roe", str: `+${args.tp_roe_pct}`, basis }) : null;
  const sl = fin(args.sl_roe_pct) ? tpslLegView({ leg: "sl", mode: "roe", str: `-${Math.abs(args.sl_roe_pct)}`, basis }) : null;
  const short = margin == null ? null : shortOf(ctx, m, margin, lev);
  return {
    coin: tickerOf(m.coin),
    side: args.side,
    ...(isStockCoin(m.coin) ? { margin_mode: "isolated", ...(stockNotes.length ? { limits_applied: stockNotes } : {}) } : {}),
    adds_to_existing_position: adding,
    margin_usdc: margin,
    leverage: lev,
    ok: !!(q && q.ok),
    problem: q && !q.ok ? q.message : null,
    size_usd: risk.sizeText,
    est_entry: q && q.ok ? formatHlPrice(q.refPx, m.szDecimals) : null,
    liquidation: risk.liqText,
    max_loss: risk.maxLossText,
    fee: risk.feeText,
    take_profit: tp ? (tp.error || `${tp.triggerText} ${tp.ifHitText}`) : null,
    stop_loss: sl ? (sl.error || `${sl.triggerText} ${sl.ifHitText}`) : null,
    ...(short ? { perp_balance_usdc: short.balanceUsdc, free_usdc: short.freeUsdc, funds_note: SHORT_NOTE(short) } : {}),
  };
}

/**
 * @param {string} name a READ tool
 * @param {object} args the model's arguments
 * @param {{ snapshot: object, backend: object, fetchCandles: (coin, interval, opts) => Promise<object[]> }} ctx
 * @returns {Promise<object>} a small JSON-able result (an { error } on a bad call: the model reads it and recovers)
 */
export async function runReadTool(name, args = {}, ctx) {
  const snap = ctx.snapshot;
  const b = ctx.backend;
  switch (name) {
    case "get_markets": {
      const limit = Math.max(1, Math.min(10, Math.floor(args.limit || 8)));
      /* Stocks have their own list (the Stock pill), never mixed into crypto's (owner item 15). */
      const counts = marketCounts(snap);
      if (args.kind === "stock" || args.kind === "stocks") return { ...stockRowsForModel(snap.markets, { now: nowOf(ctx), limit }), counts };
      const sort = { gainers: "gainers", losers: "losers", funding: "funding" }[args.sort] || "trending";
      return { markets: filterMarkets(snap.markets, { filter: sort, query: args.query || "" }).slice(0, limit).map(marketRow), counts };
    }
    case "get_market": {
      const f = marketFor(args.coin, snap);
      if (!f.m) return { error: f.error };
      const m = f.m;
      /* A stock: its market state (open / outside US hours / closed, Thai hours), max leverage now, isolated, fee. */
      if (isStockCoin(m.coin)) return stockMarketForModel(m.coin, { markets: snap.markets, now: nowOf(ctx), ...(fin(b.feeRate) ? { feeRate: b.feeRate } : {}) }) || { error: `${tickerOf(m.coin)} couldn't be read right now.` };
      return {
        ...marketRow(m),
        mark: formatHlPrice(m.markPx, m.szDecimals),
        oracle: formatHlPrice(m.oraclePx, m.szDecimals),
        open_interest: formatHlUsdCompact(m.openInterestUsd),
      };
    }
    case "get_candles": {
      const f = marketFor(args.coin, snap);
      if (!f.m) return { error: f.error };
      const m = f.m;
      const interval = ["15m", "1h", "4h", "1d"].includes(args.interval) ? args.interval : "1h";
      const bars = Math.max(6, Math.min(48, Math.floor(args.bars || 24)));
      try {
        const s = summarizeCandles(await ctx.fetchCandles(m.coin, interval, { bars }));
        return s ? { coin: tickerOf(m.coin), interval, ...s } : { error: "No candles right now." };
      } catch {
        return { error: "Candles are unavailable right now." };
      }
    }
    case "get_account": {
      if (!b.connected) return { signed_in: false, note: "The user is not signed in." };
      const acc = b.account || {};
      const bal = balanceView(acc.perpBalanceUsdc);
      const list = acc.positions && acc.positions.answered ? (acc.positions.list || []).filter((p) => fin(p.szi) && p.szi !== 0) : null;
      const orders = acc.orders && acc.orders.answered ? acc.orders.list || [] : null;
      return {
        signed_in: true,
        mock: !!b.mock,
        balance_usdc: bal.known ? bal.text : null,
        available_usdc: acc.perpBalanceUsdc && fin(acc.perpBalanceUsdc.availableUsdc) ? r2(acc.perpBalanceUsdc.availableUsdc) : null,
        positions: list == null ? null : list.map((p) => {
          const m = snap.byCoin[p.coin];
          const v = positionView(p, { szDecimals: m ? m.szDecimals : null });
          return { coin: isStockCoin(p.coin) ? tickerOf(p.coin) : perpCoinLabel(p.coin, m), ...(isStockCoin(p.coin) ? { kind: "stock" } : {}), side: v.pill, size: v.qtyText, entry: v.entryText, pnl: v.pnlText, roe: v.roeText, liquidation: v.liqText, margin_usdc: v.marginText };
        }),
        open_orders: orders == null ? null : orders.slice(0, 10).map((o) => ({ coin: tickerOf(o.coin), type: o.tpsl === "tp" ? "take profit" : o.tpsl === "sl" ? "stop loss" : o.orderType || "limit", side: o.side, price: o.isTrigger ? o.triggerPx : o.limitPx })),
        limits: { max_margin_usdc: MAX_MARGIN_USDC, max_leverage: AGENT_MAX_LEVERAGE },
      };
    }
    case "get_funds": {
      const f = await readFunds({ backend: b, ...(ctx.funds || {}) });
      /* The whole money map (moneyMap.js): the Main Account with its stock positions by name, and the Spot Account
         (coins on AVAX, USDC Staked) when a reader is wired (browser only; never in a mock build). */
      let spot;
      const readSpot = ctx.funds && typeof ctx.funds.readSpot === "function" ? ctx.funds.readSpot : null;
      if (readSpot && b.connected && !b.mock && typeof b.address === "string") {
        try { spot = await withEnd(readSpot(b.address), Math.min((ctx && ctx.readTimeoutMs) || STEP_TIMEOUT_MS, 6000)); } catch { spot = null; }
      }
      let map = null;
      try { map = moneyMapFor({ funds: f, backend: b, spot, apyPct: peekEarnApy(), priceOf: spotPriceOf(snap) }); } catch { map = null; }
      return map ? { ...f, map: { main_account: map.main_account, spot_account: map.spot_account, balance_usdc: map.balance_usdc, balance_note: map.balance_note, summary: map.summary } } : f;
    }
    case "get_analysis":
      return (await analysisFor(ctx, args.coin)).result;
    case "get_fills": {
      if (!b.connected) return { signed_in: false };
      const fills = b.account && b.account.fills && b.account.fills.answered ? b.account.fills.list || [] : [];
      const limit = Math.max(1, Math.min(20, Math.floor(args.limit || 10)));
      return { fills: fills.slice(0, limit).map((f) => ({ coin: tickerOf(f.coin), dir: f.dir, size: f.sz, price: f.px, realized_pnl: r2(f.closedPnl), time: f.time ? new Date(f.time).toISOString() : null })) };
    }
    case "quote_trade": {
      const f = marketFor(args.coin, snap);
      if (!f.m) return { error: f.error };
      return quote(args, ctx, f.m);
    }
    case "get_news":
      return (await newsFor(ctx, args)).result;
    default:
      return { error: `Unknown tool ${name}.` };
  }
}

/**
 * Turns an action tool call into a card for the chat, after FlowFlow's own limits. Never sends anything.
 * @returns {{ ok: true, card?: object, navigate?: string, note: string } | { ok: false, error: string }}
 */
export function proposeAction(name, args = {}, ctx) {
  const snap = ctx.snapshot;
  if (name === "open_spot") {
    const action = SPOT_ACTIONS.includes(args.action) ? args.action : null;
    if (!action) return { ok: false, error: "Which one: swap, stake, unstake, move-in or move-out?" };
    const enabled = typeof ctx.earnEnabled === "boolean" ? ctx.earnEnabled : EARN_ENABLED;
    const exit = action === "unstake" || action === "move-out" || (action === "swap" && spotSymbol(args.to) === "USDC");
    if (!enabled && !exit) return { ok: false, error: "This opens with the Spot Account soon. Today: trade, or move and sell back to USDC." };
    const to = spotHref({ action, from: args.from, to: args.to, amount: fin(args.amount) ? args.amount : null });
    return { ok: true, navigate: to, note: `The ${action} panel is open in the Spot Account, filled in. The user checks the quote and confirms there.` };
  }
  if (name === "open_deposit") return { ok: true, navigate: "/wallet?panel=deposit", note: "Deposit panel opened." };
  if (name === "open_withdraw") return { ok: true, navigate: "/wallet?panel=withdraw", note: "Withdraw panel opened. The user types the address." };
  if (name === "close_all") return proposeCloseAll(args, ctx);
  const f = marketFor(args.coin, snap);
  if (!f.m) return { ok: false, error: f.error };
  const m = f.m;
  const T = tickerOf(m.coin);
  const posOf = (c) => (ctx.backend.account && ctx.backend.account.positions && ctx.backend.account.positions.byCoin ? ctx.backend.account.positions.byCoin[c] : null);
  if (name === "propose_close") {
    const pos = posOf(m.coin);
    if (!pos) return { ok: false, error: `The user has no open ${T} position.` };
    /* The card closes 25 / 50 / 75 / 100%: an in-between share rounds DOWN to the step under it (never more than asked;
       a model's 0.3 is a 25% card, not "All"), and anything under 25% is 25%. */
    const want = fin(args.fraction) && args.fraction > 0 ? Math.min(1, args.fraction) : 1;
    const fraction = [0.25, 0.5, 0.75, 1].filter((d) => d <= want + 1e-9).pop() || 0.25;
    const rounded = Math.abs(fraction - want) > 1e-9;
    return { ok: true, card: { kind: "close", coin: m.coin, fraction, status: "review" }, note: `Close card shown${rounded ? ` for ${Math.round(fraction * 100)}% (the card closes 25%, 50%, 75% or all; the user can change it on the card)` : ""}. Waiting for the user to confirm or cancel.` };
  }
  if (name === "propose_tpsl") {
    const pos = posOf(m.coin);
    if (!pos) return { ok: false, error: `The user has no open ${T} position.` };
    if (!fin(args.tp_roe_pct) && !fin(args.sl_roe_pct)) return { ok: false, error: "Ask the user for a take profit or a stop loss (% ROE)." };
    return {
      ok: true,
      card: { kind: "tpsl", coin: m.coin, tpPct: fin(args.tp_roe_pct) ? Math.abs(args.tp_roe_pct) : null, slPct: fin(args.sl_roe_pct) ? Math.abs(args.sl_roe_pct) : null, status: "review" },
      note: "TP/SL card shown. Waiting for the user to confirm or cancel.",
    };
  }
  if (name === "propose_open") {
    if (!fin(args.margin_usdc) || args.margin_usdc <= 0) return { ok: false, error: "Ask the user for the margin in USDC, or call plan_trade if they gave a risk or a budget instead." };
    const held = heldOf(ctx, m.coin);
    const want = args.side === "short" ? "short" : "long";
    const lang = args.lang === "th" ? "th" : "en";
    if (held && held.side !== want) return { ok: false, error: `The user holds a ${T} ${held.side}. One position per market: offer propose_close first.` };
    /* 🔴 AN ADD IS AN AGENT ORDER UNDER THE SAME CAPS (caps.js): it goes out at the POSITION's leverage, whatever this
       call says, so a position held above what FlowFlow would open now (10x on a stock on a Saturday, 40x BTC from the
       trade page) gets no add card. The leverage the call names is not asked for: the add cannot use it. */
    if (held) {
      const add = addCapCheck({ coin: m.coin, position: held, market: m, now: nowOf(ctx), lang });
      if (!add.ok) return { ok: false, refused: true, error: `${add.text} No card: say this in one line.` };
    }
    /* A stock asks its own question for a missing leverage (with its cap right now), below. */
    if (!held && (!fin(args.leverage) || args.leverage < 1) && !isStockCoin(m.coin)) {
      const cap = Math.min(AGENT_MAX_LEVERAGE, m.maxLeverage || AGENT_MAX_LEVERAGE);
      return { ok: false, ask: lang === "th" ? `leverage เท่าไหร่? ${T} ได้สูงสุด ${cap}x` : `What leverage? ${T} goes up to ${cap}x`, error: `Ask the user: ${lang === "th" ? `leverage เท่าไหร่? ${T} ได้สูงสุด ${cap}x` : `What leverage? ${T} goes up to ${cap}x`}` };
    }
    const capped = [];
    let margin = args.margin_usdc;
    let lev = held ? heldLeverage(held) : args.leverage;
    let notes = [];
    if (isStockCoin(m.coin) && !held) {
      /* 🔴 A stock's card is made only after FlowFlow's stock limits, in code: margin ≤ the cap, leverage ≤ min(its own
         max, 10x, 5x while the US market is closed), isolated, ≥ $10. A paused or unlisted stock, or an order under
         the minimum, gets no card: the model says why (and the margin that would work). */
      const chk = checkAgentStockOrder({ coin: m.coin, side: want, marginUsdc: margin, leverage: lev, markets: snap.markets, now: nowOf(ctx), lang });
      if (!chk.ok) {
        /* A missing figure is asked, with any limit already applied said first ("ซื้อ Apple 50 ดอล": the $50 is over
           the 20 USDC cap, and the reply says so before it asks the leverage). */
        if (chk.ask) {
          const ask = [...chk.notes, chk.ask].join(lang === "th" ? " · " : ". ");
          return { ok: false, ask, error: `Ask the user: ${ask}` };
        }
        const alts = chk.alternatives && chk.alternatives.length ? ` Listed stocks to offer: ${chk.alternatives.map((x) => x.ticker).join(", ")}.` : "";
        return { ok: false, refused: true, error: `${chk.text || "That stock order can't be made."}${chk.fix ? ` Offer ${chk.fix.marginUsdc} USDC at ${chk.leverage}x instead.` : ""}${alts}` };
      }
      if (chk.marginUsdc !== margin) capped.push(`margin capped at ${chk.marginUsdc} USDC`);
      if (chk.leverage !== Math.floor(lev)) capped.push(`leverage capped at ${chk.leverage}x`);
      margin = chk.marginUsdc;
      lev = chk.leverage;
      notes = [...chk.notes, ...chk.warningTexts].slice(0, 3);
    } else {
      if (margin > MAX_MARGIN_USDC) { margin = MAX_MARGIN_USDC; capped.push(`margin capped at ${MAX_MARGIN_USDC} USDC`); }
      const maxLev = Math.min(AGENT_MAX_LEVERAGE, m.maxLeverage || AGENT_MAX_LEVERAGE);
      if (!held && lev > maxLev) { lev = maxLev; capped.push(`leverage capped at ${maxLev}x`); }
      /* The card says what was capped (item 8: the model's own line, written before the clamp, is not shown then). */
      if (capped.length) {
        const what = [margin !== args.margin_usdc ? `${margin} USDC` : null, !held && Math.floor(lev) !== Math.floor(args.leverage) ? `${Math.floor(lev)}x` : null].filter(Boolean).join(" · ");
        notes = [lang === "th" ? `ปรับเป็น ${what} ตามลิมิตของ FlowFlow` : `Capped to ${what} (FlowFlow's limit)`];
      }
    }
    /* An add goes in at the position's own leverage (the card's quote does the same). */
    const short = shortOf(ctx, m, margin, Math.floor(lev));
    return {
      ok: true,
      capped: capped.length > 0,
      card: {
        kind: "open", coin: m.coin, side: args.side === "short" ? "sell" : "buy", marginUsdc: margin, leverage: Math.floor(lev),
        tpPct: fin(args.tp_roe_pct) ? Math.abs(args.tp_roe_pct) : null, slPct: fin(args.sl_roe_pct) ? Math.abs(args.sl_roe_pct) : null, status: "review",
        ...(isStockCoin(m.coin) ? { marginMode: "isolated" } : {}),
        ...(notes.length ? { notes } : {}),
      },
      note: `Trade card shown${held ? ` (adds to the existing position at its own ${Math.floor(lev)}x; TP / SL stay as set)` : ""}${capped.length ? ` (${capped.join(", ")})` : ""}. Waiting for the user to confirm or cancel. Do not say it is filled.${short ? ` ${CARD_SHORT_NOTE(short)}` : ""}`,
      ...(short ? { fundsShort: true } : {}),
    };
  }
  return { ok: false, error: `Unknown action ${name}.` };
}

/**
 * The close-all card (item 7): every open position (crypto and stocks), or only the markets named. 🔴 A card only:
 * it closes nothing until the user's one Confirm, and then one by one through the same reduce-only close a single
 * close card sends. It never opens anything.
 */
export function proposeCloseAll(args = {}, ctx) {
  const b = ctx.backend || {};
  if (!b.connected) return { ok: false, error: "The user is not signed in." };
  const acc = b.account || {};
  if (!acc.positions || !acc.positions.answered) return { ok: false, error: "The positions haven't loaded yet: say so and ask again in a moment." };
  /* 🔴 "Every position" only from the WHOLE list: stock positions join it after the crypto ones (account store:
     positions.complete), so a close-all made while they load (or while their read fails) would list BTC alone and
     settle to "Closed your position." with TSLA still open. */
  if (acc.positions.complete !== true) return { ok: false, loading: true, error: "The stock positions haven't loaded yet: say so (\"Your stock positions are still loading\") and ask again in a moment. No card." };
  const names = Array.isArray(args.coins) ? args.coins.filter((c) => typeof c === "string" && c.trim()).slice(0, 20) : [];
  const coins = [];
  for (const n of names) {
    const f = marketFor(n, ctx.snapshot);
    const c = f.m ? f.m.coin : (acc.positions.list || []).find((p) => p && tickerOf(p.coin).toUpperCase() === String(n).trim().toUpperCase())?.coin;
    if (c && !coins.includes(c)) coins.push(c);
  }
  /* A share of each ("close half of ETH and SOL"): rounded DOWN to the close steps, never more than asked. */
  const want = fin(args.fraction) && args.fraction > 0 ? Math.min(1, args.fraction) : 1;
  const fraction = [0.25, 0.5, 0.75, 1].filter((d) => d <= want + 1e-9).pop() || 0.25;
  const rows = closeAllPositions(acc.positions.list, coins.length ? coins : null);
  if (!rows.length) return { ok: false, error: coins.length ? "None of those markets has an open position." : "The user has no open positions." };
  return {
    ok: true,
    card: { kind: "closeAll", coins: coins.length ? coins : null, ...(fraction < 1 ? { fraction } : {}), status: "review" },
    note: `Close-all card shown for ${rows.length} position${rows.length === 1 ? "" : "s"} (${rows.map((p) => tickerOf(p.coin)).join(", ")})${fraction < 1 ? `, ${Math.round(fraction * 100)}% of each` : ""}. Nothing closes until the user confirms; it never opens anything.`,
  };
}

/**
 * Headlines for one market or a topic, from our own /api/news (keyless feeds, cached): what the model reads (quoted,
 * with the note that they are data) and the small headline card the chat draws (title · source · age · link, never
 * article text). Reads only; never rejects.
 */
export async function newsFor(ctx, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  let query = null;
  let coin = null;
  const name = typeof a.coin === "string" && a.coin.trim() ? a.coin : typeof a.ticker === "string" && a.ticker.trim() ? a.ticker : null;
  if (name) {
    const f = marketFor(name, ctx.snapshot);
    if (!f.m) return { result: { error: f.error } };
    coin = f.m.coin;
    query = newsQueryFor(coin);
  } else if (["crypto", "stocks", "market"].includes(a.topic)) query = { topic: a.topic };
  if (!query) return { result: { error: "Give a coin, a stock ticker or a topic (crypto, stocks, market)." } };
  const label = coin ? tickerOf(coin) : a.topic;
  const done = stepOf(ctx, "get_news", coin, { run: `Reading ${label} news…`, done: `Read ${label} news`, fail: `Couldn't read ${label} news` });
  let r = null;
  try {
    const read = typeof ctx.readNews === "function" ? ctx.readNews : (q) => readNewsDefault(q, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});
    r = await withEnd(read(query), (ctx && ctx.readTimeoutMs) || STEP_TIMEOUT_MS);
  } catch {
    r = null;
  }
  const items = r && Array.isArray(r.items) ? r.items : [];
  done(items.length > 0);
  if (!items.length) return { result: { headlines: [], note: r && r.covered === false ? `No news source covers ${label}.` : `No headlines for ${label} right now.` } };
  const shown = newsView(items, { max: 2, now: nowOf(ctx) }).map((it) => ({ title: it.title, source: it.source, url: it.url, publishedAt: it.publishedAt }));
  return {
    result: { ...newsForModel(items, { now: nowOf(ctx) }), shown_to_user: "the 2 newest headlines, linked, under your answer" },
    card: { kind: "news", coin, topic: coin ? null : a.topic, items: shown },
  };
}

/** The pick-4 card for the model's propose_picks (picks.js), with the group's headlines. Reads only. */
export async function picksCardFor(ctx, { group = "movers", side = null, lang = "en" } = {}) {
  const g = ["today", "stocks", "meme", "ai", "l1", "defi", "news", "movers"].includes(group) ? group : "movers";
  const held = heldCoins(ctx.backend);
  let news = [];
  try {
    const read = typeof ctx.readNews === "function" ? ctx.readNews : (q) => readNewsDefault(q, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});
    const r = await withEnd(read({ topic: newsTopicFor(g === "today" ? "movers" : g) }), PICK_NEWS_MS);
    news = r && Array.isArray(r.items) ? r.items : [];
  } catch {
    news = [];
  }
  const s = side === "short" || side === "sell" ? "sell" : side === "long" || side === "buy" ? "buy" : null;
  return buildPickCard({ group: g, side: s, lang }, { markets: (ctx.snapshot && ctx.snapshot.markets) || [], held, news });
}

/** A pick card waits at most this long for its headlines (it shows without them). */
export const PICK_NEWS_MS = 3500;

/* ── runToolCall: THE one place a tool runs (the text loop and voice mode alike) ─────────────────────────────────
   Read tools answer data; get_unlocks and get_analysis also return an info card (no Confirm); action tools return a
   card (or a panel to open) and never act. The caller pushes what comes back. Every wait inside has an end (READ_TIMEOUT_MS).

   ctx: { snapshot, backend, fetchCandles(coin, interval, {bars}), funds?, fetchImpl? (our /api/tokenomist and the
          Avalanche RPC), readApy?() (the Aave reading, injectable), readUnlocks? / readEmission? (Tokenomist,
          injectable), tokenomist? (flag), earnEnabled? (flag),
          step?(tool, coin, words) → finish(ok), readTimeoutMs?, now?() } */

const STEP_TIMEOUT_MS = 8000;
/** A trade card waits at most this long for the chart its recommended TP / SL comes from. */
export const RECOMMEND_TIMEOUT_MS = 4000;

function withEnd(promise, ms) {
  let t = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); }),
  ]);
}

/* A status step when the caller shows them (agent.js), else nothing. */
function stepOf(ctx, tool, coin, words) {
  try {
    const f = ctx && typeof ctx.step === "function" ? ctx.step(tool, coin, words) : null;
    return typeof f === "function" ? f : () => {};
  } catch {
    return () => {};
  }
}

const nowOf = (ctx) => (ctx && typeof ctx.now === "function" ? ctx.now() : Date.now());
/* The Main Account's FREE USDC, or null when it was not read: free USDC that was not read is not the whole balance,
   and a balance read only in part (complete:false) is not known (the setups then use the default margin, flagged). */
const freeOf = (b) => {
  const bal = b && b.connected && b.account ? b.account.perpBalanceUsdc : null;
  if (!bal || bal.answered !== true || bal.complete === false) return null;
  return fin(bal.availableUsdc) ? bal.availableUsdc : null;
};

/** The last 1h candles of one market (the setups' and the recommended TP / SL's data), or null. Never rejects. */
export async function chartFor(ctx, coin, { quiet = false, timeoutMs = null } = {}) {
  const done = quiet ? () => {} : stepOf(ctx, "get_candles", coin);
  /* A stock reads a week of 1h bars and keeps only those inside US market hours (stocks.js stockCandles: a weekend's
     14-bar range is a third of a trading day's, and a stop sized on it sits inside Monday's gap). Fewer than 14 of
     them: no chart, so nothing is recommended rather than guessed. */
  const stock = isStockCoin(coin);
  let bars = null;
  try {
    bars = await withEnd(ctx.fetchCandles(coin, SETUP_INTERVAL, { bars: stock ? STOCK_CANDLE_BARS : SETUP_BARS }), timeoutMs || (ctx && ctx.readTimeoutMs) || STEP_TIMEOUT_MS);
  } catch {
    bars = null;
  }
  const clean = stock ? stockCandles(bars) || [] : cleanCandles(bars);
  done(clean.length > 0);
  return clean.length ? clean : null;
}

/** How many of the most traded markets the featured pick reads (one chart each). */
export const FEATURED_CANDIDATES = 4;

/**
 * The featured market when none is named (the Agent page on open, "any plan"): the market in focus, else the one of
 * the most traded markets (not held) whose 1h trend is clearest. Its three profiles are the card (Safer / Balanced /
 * Bolder), so the boxes differ in leverage, stop and RR instead of being three "Balanced 2x" alike.
 */
async function featuredSetups(ctx, { side = null, focus = [], free, feeRate, at }) {
  const snap = ctx.snapshot;
  const byCoin = (snap && snap.byCoin) || {};
  const held = heldCoins(ctx.backend);
  const live = (c) => typeof c === "string" && byCoin[c] && !byCoin[c].isHip3 && !held.has(c);
  const first = (Array.isArray(focus) ? focus : []).map((c) => (resolveCoin(c, snap) || {}).coin).find(live) || null;
  const pool = first ? [first] : setupCandidates(snap, ctx.backend, { n: FEATURED_CANDIDATES + 1 })
    .filter(live)
    .sort((a, b) => (fin(byCoin[b].dayNtlVlm) ? byCoin[b].dayNtlVlm : 0) - (fin(byCoin[a].dayNtlVlm) ? byCoin[a].dayNtlVlm : 0))
    .slice(0, FEATURED_CANDIDATES);
  if (!pool.length) return null;
  const charts = await Promise.all(pool.map((c) => chartFor(ctx, c)));
  const ranked = pool.map((c, i) => ({ c, candles: charts[i], gap: trendGap(charts[i]) }))
    .filter((x) => x.candles)
    .sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0));
  for (const x of ranked) {
    const r = buildSetups({ market: byCoin[x.c], candles: x.candles, freeUsdc: free, side, feeRate, now: at });
    if (r.ok) return { r, coin: x.c };
  }
  return null;
}

/**
 * The "setups" card for one market; or, when no market is named, the featured market's three profiles (featured:
 * the Agent page and "any plan") or the Balanced setup of each of the best candidates (several markets: "top movers
 * setups", and the model's propose_setups with no coin).
 */
export async function setupsCardFor(ctx, { coin = null, side = null, focus = [], featured = false, candles: given = null } = {}) {
  const snap = ctx.snapshot;
  const b = ctx.backend || {};
  const free = freeOf(b);
  const feeRate = fin(b.feeRate) ? b.feeRate : null;
  const at = nowOf(ctx);
  const s = side === "short" || side === "sell" ? "sell" : side === "long" || side === "buy" ? "buy" : null;
  if (coin) {
    const f = marketFor(coin, snap);
    if (!f.m) return { ok: false, error: f.error };
    const m = f.m;
    /* One position per market: a new setup on a market the user holds would be blocked on its card. */
    const held = heldOf(ctx, m.coin);
    if (held) {
      const hs = held.side === "short" || held.szi < 0 ? "short" : "long";
      return { ok: false, held: true, coin: m.coin, error: `The user already holds a ${hs} on ${tickerOf(m.coin)} (one position per market), so there is no new setup for it. Offer a recommended TP / SL for it (propose_tpsl) or propose_close.` };
    }
    /* The chart this answer already read (an "Analyze" read), else a read of its own. */
    const candles = Array.isArray(given) && given.length ? given : await chartFor(ctx, m.coin);
    let r;
    if (isStockCoin(m.coin)) {
      /* A stock: US-hours candles and profiles capped at min(3x, the stock's cap now) (stocks.js stockSetupsInput). */
      const si = stockSetupsInput({ coin: m.coin, candles: candles || [], markets: snap.markets, now: at });
      if (!si.ok) {
        return { ok: false, error: `No setup for ${tickerOf(m.coin)}: ${si.why === "few-core-candles" ? "not enough US market hours on the chart yet" : si.text || "it can't be traded right now"}.`, why: si.why, coin: m.coin };
      }
      r = buildSetups({ market: si.market, candles: si.candles, freeUsdc: free, side: s, feeRate: perpMarketFeeRate(m, feeRate), now: at, profiles: si.profiles });
    } else {
      r = buildSetups({ market: m, candles, freeUsdc: free, side: s, feeRate, now: at });
    }
    if (!r.ok) return { ok: false, error: `No setup for ${tickerOf(m.coin)}: ${r.why === "no-candles" ? "the chart could not be read" : "the data does not allow one right now"}.`, why: r.why, coin: m.coin };
    return { ok: true, card: setupsCard(r.setups, { coin: m.coin, at }), fundsShort: r.fundsShort, trend: r.trend };
  }
  if (featured) {
    const f = await featuredSetups(ctx, { side: s, focus, free, feeRate, at });
    if (!f) return { ok: false, error: "No setup right now: the charts could not be read." };
    return { ok: true, card: setupsCard(f.r.setups, { coin: f.coin, at }), fundsShort: f.r.fundsShort, featured: true, trend: f.r.trend };
  }
  const coins = setupCandidates(snap, b, { focus, n: 3 });
  const charts = await Promise.all(coins.map((c) => chartFor(ctx, c)));
  const picks = [];
  let short = null;
  coins.forEach((c, i) => {
    const r = buildSetups({ market: snap.byCoin[c], candles: charts[i], freeUsdc: free, side: s, feeRate, now: at });
    if (!r.ok) return;
    picks.push(r.setups.find((x) => x.label === "Balanced") || r.setups[0]);
    short = short || r.fundsShort;
  });
  if (!picks.length) return { ok: false, error: "No setup right now: the charts could not be read." };
  return { ok: true, card: setupsCard(picks, { coin: null, at }), fundsShort: short };
}

/** The "stake" card with the live USDC Staked AAVE APY (Aave V3 on AVAX). Reads only. */
export async function stakeCardFor(ctx, { amountUsdc = null } = {}) {
  const done = stepOf(ctx, "read_apy", null, { run: "Reading USDC Staked AAVE rate…", done: "Read USDC Staked AAVE rate", fail: "Couldn't read the USDC Staked AAVE rate" });
  let apy = null;
  try {
    apy = typeof ctx.readApy === "function" ? await withEnd(ctx.readApy(), (ctx.readTimeoutMs) || STEP_TIMEOUT_MS) : await readEarnApy({ fetchImpl: ctx.fetchImpl });
  } catch {
    apy = null;
  }
  done(!!(apy && fin(apy.apyPct)));
  const enabled = typeof ctx.earnEnabled === "boolean" ? ctx.earnEnabled : EARN_ENABLED;
  return stakeCard({ amountUsdc, apy, enabled, perpFreeUsdc: freeOf(ctx.backend) });
}

/** The "unlocks" card and the model's result for one market (Tokenomist through /api/tokenomist). */
export async function unlocksFor(ctx, coin, { days = 90 } = {}) {
  const m = resolveCoin(coin, ctx.snapshot);
  /* A stock has no token unlocks (and Tokenomist is never asked about one). */
  if (m && isStockCoin(m.coin)) return { result: { error: `${tickerOf(m.coin)} is a stock: it has no token unlocks. Use get_analysis or get_market.` } };
  const name = m ? m.coin : typeof coin === "string" ? coin.trim().toUpperCase() : null;
  if (!name) return { result: { error: "Which market? Give a coin." } };
  const label = m ? perpCoinLabel(m.coin, m) : name;
  const done = stepOf(ctx, "get_unlocks", m ? m.coin : null, { run: `Reading ${label} unlocks…`, done: `Read ${label} unlocks`, fail: `Couldn't read ${label} unlocks` });
  let raw = null;
  try {
    raw = typeof ctx.readUnlocks === "function"
      ? await withEnd(ctx.readUnlocks(name, { days }), (ctx.readTimeoutMs) || 12_000)
      : await readUnlocks(name, { days, fetchImpl: ctx.fetchImpl });
  } catch {
    raw = null;
  }
  const v = unlocksView(raw || { configured: true, error: "unavailable", coin: name }, { coin: name, market: m, now: nowOf(ctx), days });
  done(!v.card.error && v.card.configured !== false);
  return { result: v.result, card: v.card };
}

/**
 * The "analysis" card for one market (analyze.js: trend on 1h / 4h / 1d and the levels that turn it, emission, risks,
 * the RR now and suggested) and the model's small result. Its work shows as one step for the charts and, with
 * Tokenomist on and a coin it covers, one for the unlocks. Reads only; never rejects.
 * @param {{ side?: "buy"|"sell"|null, profile?: string|null, leverage?: number|null, setup?: object|null,
 *   card?: object|null }} o the setup or pending trade card the pill sat on, or the side / leverage / profile its words
 *   named
 */
export async function analysisFor(ctx, coin, { side = null, profile = null, leverage = null, setup = null, card: subjectCard = null } = {}) {
  const f = marketFor(coin, ctx.snapshot);
  if (!f.m) return { result: { error: f.error } };
  const m = f.m;
  const label = tickerOf(m.coin) === m.coin ? perpCoinLabel(m.coin, m) || m.coin : tickerOf(m.coin);
  /* A stock has no Tokenomist: its emission row is the US market's state (analyze.js). */
  const on = isStockCoin(m.coin) ? false : typeof ctx.tokenomist === "boolean" ? ctx.tokenomist : TOKENOMIST_ON;
  const doneCharts = stepOf(ctx, "get_analysis", m.coin, { run: `Reading ${label} 1h · 4h · 1d charts…`, done: `Read ${label} 1h · 4h · 1d charts`, fail: `Couldn't read ${label} charts` });
  const doneUnlocks = on && isCovered(m.coin)
    ? stepOf(ctx, "get_unlocks", m.coin, { run: `Reading ${label} unlocks…`, done: `Read ${label} unlocks`, fail: `Couldn't read ${label} unlocks` })
    : null;
  /* Injected readers replace the network as a set: an injected unlocks reader with no emission reader reads no
     emission (tests, fakes). */
  const unl = typeof ctx.readUnlocks === "function" ? ctx.readUnlocks : (c, o) => readUnlocks(c, { ...o, fetchImpl: ctx.fetchImpl });
  const emi = typeof ctx.readEmission === "function" ? ctx.readEmission
    : typeof ctx.readUnlocks === "function" ? null : (c, o) => readEmission(c, { ...o, fetchImpl: ctx.fetchImpl });
  let card = null;
  try {
    card = await analyzeMarket({
      coin: m.coin, market: m, snapshot: ctx.snapshot, backend: ctx.backend, fetchCandles: ctx.fetchCandles,
      readUnlocks: unl, readEmission: emi, tokenomistOn: on, side, profile, leverage, setup, card: subjectCard, now: nowOf(ctx),
      timeoutMs: (ctx && ctx.readTimeoutMs) || STEP_TIMEOUT_MS,
    });
  } catch {
    card = null;
  }
  doneCharts(!!(card && (card.trend.h1 || card.trend.h4 || card.trend.d1)));
  if (doneUnlocks) doneUnlocks(!!(card && card.emission.configured && card.emission.covered && !card.emission.error));
  if (!card) return { result: { error: `${label} couldn't be analyzed right now.` } };
  return { result: analysisForModel(card), card };
}

/**
 * Run one tool. Never rejects.
 * @returns {Promise<{ result: object, card?: object, navigate?: string, fundsShort?: boolean }>}
 *   result  what the model reads (an { error } on a bad call: the model reads it and recovers)
 *   card    a card for the chat (action tools; get_unlocks' info card)
 *   navigate a panel to open (open_deposit / open_withdraw); the caller opens it and says so if it could not
 */
export async function runToolCall(name, args = {}, ctx = {}) {
  const a = args && typeof args === "object" ? args : {};
  try {
    if (name === "get_unlocks") {
      const days = Number.isInteger(a.days) ? Math.max(7, Math.min(365, a.days)) : 90;
      return await unlocksFor(ctx, a.coin, { days });
    }
    if (name === "get_analysis") return await analysisFor(ctx, a.coin);
    if (name === "get_news") return await newsFor(ctx, a);
    if (isReadTool(name)) return { result: await runReadTool(name, a, ctx) };
    /* The model never sizes a trade itself: the plan is code (tradePlan.js), and its card waits for Confirm. */
    if (name === "plan_trade") return await planTradeToolCall(ctx, { ...a, lang: a.lang === "th" || a.lang === "en" ? a.lang : langOf(a.coin) });
    if (name === "propose_picks") {
      const r = await picksCardFor(ctx, { group: a.group, side: a.side || null, lang: a.lang === "th" ? "th" : "en" });
      if (!r.ok) return { result: { error: r.why === "no-stocks" ? "Stocks couldn't be read right now." : "The markets haven't loaded yet." } };
      return { result: { shown: true, picks: pickForModel(r.card), note: "Pick card shown: four markets of one group with faint 24h charts. The user taps one to get its setups (a trade card that waits for Confirm). Say nothing about the four beyond one short line." }, card: r.card };
    }
    if (name === "propose_setups") {
      const r = await setupsCardFor(ctx, { coin: typeof a.coin === "string" && a.coin.trim() ? a.coin : null, side: a.side || null });
      if (!r.ok) return { result: { error: r.error } };
      return {
        result: {
          shown: true,
          setups: setupsForModel(r.card),
          note: `Setups card shown (from the 1h chart's range, funding and the user's free margin; not advice). The user taps one to get a trade card that waits for Confirm.${r.fundsShort ? " The Main Account's free margin is below these margins: if the user picks one, say where their money is (get_funds)." : ""}`,
        },
        card: r.card,
      };
    }
    if (name === "propose_stake") {
      const card = await stakeCardFor(ctx, { amountUsdc: fin(a.amount_usdc) ? a.amount_usdc : null });
      return { result: stakeForModel(card), card };
    }
    if (isActionTool(name)) {
      let p;
      try { p = proposeAction(name, a, ctx); } catch (e) { p = { ok: false, error: `That card could not be made: ${String((e && e.message) || e)}` }; }
      if (!p || typeof p !== "object") p = { ok: false, error: "That card could not be made." };
      if (!p.ok) return { result: { error: p.error }, ...(p.ask ? { ask: p.ask } : {}), ...(p.refused ? { refused: true } : {}) };
      let card = p.card || null;
      let note = p.note;
      /* A trade card with no TP / SL from the user gets the recommended one (the user's own always wins; "no tp sl"
         in the user's words, ctx.noTpSl, means none). */
      if (card && card.kind === "open" && card.tpPct == null && card.slPct == null && !ctx.noTpSl && !heldOf(ctx, card.coin)) {
        const m = resolveCoin(card.coin, ctx.snapshot);
        const candles = m ? await chartFor(ctx, m.coin, { quiet: true, timeoutMs: Math.min(RECOMMEND_TIMEOUT_MS, (ctx && ctx.readTimeoutMs) || RECOMMEND_TIMEOUT_MS) }) : null;
        const rec = m && candles ? withRecommendedTpSl(card, { market: m, candles }) : card;
        if (rec !== card) {
          card = rec;
          note = `${note} The app filled a recommended TP +${card.tpPct}% / SL -${card.slPct}% (ROE, RR ${card.rr}) from the 1h chart; the user can remove it.`;
        }
      }
      return {
        result: { shown: true, note },
        ...(card ? { card } : {}),
        ...(p.navigate ? { navigate: p.navigate } : {}),
        ...(p.fundsShort ? { fundsShort: true } : {}),
        ...(p.capped ? { capped: true } : {}),
      };
    }
    return { result: { error: `Unknown tool ${name}` } };
  } catch (e) {
    return { result: { error: String((e && e.message) || e || "Failed.") } };
  }
}

/** The flags runToolCall reads, as this build has them (tests pass their own). */
export const TOOL_FLAGS = Object.freeze({ tokenomist: TOKENOMIST_ON, earnEnabled: EARN_ENABLED });
