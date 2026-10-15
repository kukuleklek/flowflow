// The one place an order is priced before it is signed: the trade form and the Agent's trade card both read it,
// so the two can never quote the same order differently. Everything here is FlowFlow's own (perpLiveView,
// perpBackend quoteOpen / quoteAdd): no network, no signing.
//
// ONE POSITION PER MARKET (Hyperliquid's one-way mode): with a position already held on the
// SAME side the order becomes an ADD, at the position's own leverage and without new TP / SL legs (quoteAdd /
// addMarket); on the OPPOSITE side it is refused in plain words — close first.
import { usePerpTradeLimits } from "../perp/live/usePerpBackend.js";
import { clampLeverage, defaultLeverage } from "../perp/perpTicket.js";
import { riskView, perpMarketFeeRate, tpslBasisFromQuote, tpslLegView, perpCoinLabel } from "../perp/live/perpLiveView.js";
import { MAX_MARGIN_USDC, marginCapText } from "../perp/guardrails.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** The position held on this coin, or null (answered or not). */
export function heldPosition(b, coin) {
  const pos = b && b.account && b.account.positions && b.account.positions.byCoin ? b.account.positions.byCoin[coin] : null;
  return pos && fin(pos.szi) && pos.szi !== 0 ? pos : null;
}

/**
 * @param {object} b      the backend (useBackend)
 * @param {object} o      { coin, market, side "buy"|"sell", amount (USDC or null), leverage (picked or null),
 *                          tpStr, slStr (ROE %, "" for none), withLegs, stale }
 */
export function useOrderQuote(b, { coin, market, side, amount, leverage: levPick = null, tpStr = "", slStr = "", withLegs = true, stale = false }) {
  const held = heldPosition(b, coin);
  const heldSide = held ? (held.side === "short" ? "sell" : "buy") : null;
  const adding = !!held && heldSide === side;
  const opposite = !!held && heldSide !== side;
  const posLev = held && held.leverage && fin(held.leverage.value) ? held.leverage.value : null;
  const posCross = !!(held && held.leverage && held.leverage.type === "cross");

  const maxLev = market ? market.maxLeverage : null;
  const leverage = adding ? posLev : clampLeverage(levPick == null ? defaultLeverage(maxLev) : levPick, maxLev);
  const sz = market ? market.szDecimals : null;
  const isStale = !!stale || !!(market && market.stale === true);
  const tradeMarket = market ? { ...market, stale: isStale } : null;
  const limits = usePerpTradeLimits(b, { coin, leverage, market: tradeMarket }) || { answered: false, availableUsdc: null, maxMarginUsdc: null };
  const maxMargin = fin(limits.maxMarginUsdc) ? Math.min(limits.maxMarginUsdc, MAX_MARGIN_USDC) : null;

  const baseQuote = amount == null || !tradeMarket || opposite ? null
    : adding ? b.quoteAdd({ market: tradeMarket, position: held, marginUsdc: amount })
    : b.quoteOpen({ market: tradeMarket, side, marginUsdc: amount, leverage });
  const account = b.account || {};
  const feeRate = perpMarketFeeRate(market, b.feeRate);
  const risk = riskView({
    side, marginUsdc: amount, leverage, market, feeRate,
    balanceSource: account.mode ? account.mode.source : null,
    notionalUsd: baseQuote && baseQuote.ok ? baseQuote.notionalUsd : null,
    liqPx: adding ? null : b.mock ? (baseQuote && baseQuote.ok ? baseQuote.liqPx : null) : undefined,
    marginMode: adding && posCross ? "cross" : "isolated",
  });
  const basis = adding ? null : tpslBasisFromQuote(baseQuote, {
    side, leverage, szDecimals: sz,
    markPx: market && fin(market.markPx) ? market.markPx : (baseQuote && baseQuote.ok ? baseQuote.refPx : null),
    liqPx: risk.liqPx,
  });
  const legs = withLegs && !adding;
  const tpView = tpslLegView({ leg: "tp", mode: "roe", str: legs ? tpStr : "", basis });
  const slView = tpslLegView({ leg: "sl", mode: "roe", str: legs ? slStr : "", basis });
  const tp = legs && tpView.ok ? tpView.px : null;
  const sl = legs && slView.ok ? slView.px : null;
  const quote = baseQuote == null || adding || (tp == null && sl == null)
    ? baseQuote
    : b.quoteOpen({ market: tradeMarket, side, marginUsdc: amount, leverage, tp, sl });

  const overCap = amount != null && amount > MAX_MARGIN_USDC;
  const overMax = amount != null && fin(limits.maxMarginUsdc) && amount > limits.maxMarginUsdc;
  const legsBad = legs && (!!tpView.error || !!slView.error);
  const label = perpCoinLabel(coin, market);

  let blocker = null;
  if (!market) blocker = "Loading the market";
  else if (opposite) blocker = `You hold a ${label} ${heldSide === "buy" ? "long" : "short"}. Close it first, then open the ${side === "buy" ? "long" : "short"}.`;
  else if (amount == null) blocker = "Enter an amount in USDC";
  else if (isStale) blocker = "The price feed paused. Wait for a fresh price.";
  else if (overCap) blocker = marginCapText();
  else if (overMax) blocker = "More than you can use right now";
  else if (quote && !quote.ok && !quote.errors) blocker = quote.message;
  else if (legsBad || (quote && !quote.ok)) blocker = "Check your TP / SL";

  return {
    leverage, maxLev, sz, isStale, limits, maxMargin, quote, risk, tpView, slView, tp, sl,
    adding, opposite, held, overCap, overMax, blocker, ready: !!quote && quote.ok && !blocker,
  };
}
