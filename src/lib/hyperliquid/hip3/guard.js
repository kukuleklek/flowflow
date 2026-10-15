// ─────────────────────────────────────────────────────────────────────────────
// The stock order guard: FlowFlow's own limits on a stock perp, before anything
// is signed. Pure — a preview of what the ticket and the Agent's card may offer.
// ─────────────────────────────────────────────────────────────────────────────
//
// perp/guardrails.js holds the app-wide caps (MAX_MARGIN_USDC 20,
// AGENT_MAX_LEVERAGE 10) and this file reads them, never copies them. On top of
// them a stock order also answers to:
//
//   the dex's own maxLeverage   xyz: 10x–50x by market (2026-10-15). The lower
//                               of the two caps wins.
//   the whitelist and its gate  a held market takes no new position (closing
//                               one is never blocked here: this guards OPENS).
//   the OI cap                  a market in perpsAtOpenInterestCap takes no
//                               opening order; Hyperliquid would refuse it.
//   the US session              outside the core session the book is thin;
//                               on a weekend or holiday the price is the
//                               deployer's own model (hours.js xyzPriceSource),
//                               held inside its bounds and liable to gap when
//                               the outside price returns. Whenever the US
//                               market is shut (night, weekend, holiday) the
//                               Agent's leverage drops to closedAgentMaxLeverage
//                               and the card prints the warning; the form keeps
//                               the user's choice and prints the same warning.
//                               Why 5x: xyz bounds TSLA and NVDA at ±5% with 2
//                               re-anchors (docs.trade.xyz specification index),
//                               about 16% in all before the hard cap, and a 5x
//                               isolated position is liquidated near -17.5%
//                               (maintenance = half the initial margin at 20x).
//   isolated, always            FlowFlow opens every position isolated
//                               (exchange/orders.js isCross:false), so a stock's
//                               cross-or-isolated mode never changes the ticket;
//                               strictIsolated only means margin cannot be
//                               taken back out later, which is flagged.
//
// REFUSALS stop the order. WARNINGS are printed on the card and do not.

import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../../../perp/guardrails.js";
import { HL_MIN_ORDER_USD } from "../../../perp/perpTicket.js";
import { usEquitySession, xyzPriceSource } from "./hours.js";
import { gateReasons, isWhitelistedStock, STOCK_GATES, STOCK_WHITELIST } from "./whitelist.js";

/** The Agent's leverage ceiling on a stock while the US market is closed (owner question Q4; default). */
export const CLOSED_AGENT_MAX_LEVERAGE = 5;
/** |mark - oracle| past this many basis points is printed as a warning. */
export const ORACLE_GAP_WARN_BPS = 50;

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {{ row: object|null, side: string, marginUsdc: number, leverage: number,
 *   by?: "agent"|"form", now?: number, atCap?: Set<string>|null, listed?: boolean|null,
 *   whitelist?: ReadonlyArray<object>, gates?: object, closedAgentMaxLeverage?: number }} o
 *   listed  the caller's own gate verdict. The app's shared market rows (markets.js)
 *           carry no impact spread or OI-cap share, so gateReasons() would hold every
 *           one of them; the Agent passes trade/marketLists.js stockMarkets()'s answer
 *           here instead (true = listed, false = held). Omitted: this file's own gate.
 * @returns {{ ok: boolean, refusals: string[], warnings: string[], maxLeverage: number|null,
 *   notionalUsd: number|null, session: string|null, marginMode: "isolated" }}
 *   maxLeverage: the highest leverage this order may carry here and now (null: unknown)
 */
export function checkStockOrder({
  row = null, side, marginUsdc, leverage, by = "form", now = Date.now(), atCap = null, listed = null,
  whitelist = STOCK_WHITELIST, gates = STOCK_GATES, closedAgentMaxLeverage = CLOSED_AGENT_MAX_LEVERAGE,
} = {}) {
  const refusals = [];
  const warnings = [];
  const s = usEquitySession(now);
  const session = s.session;
  if (!row || typeof row.coin !== "string") {
    return { ok: false, refusals: ["market_unknown"], warnings, maxLeverage: null, notionalUsd: null, session, priceSource: null, marginMode: "isolated" };
  }
  if (!isWhitelistedStock(row.coin, whitelist)) refusals.push("not_listed");
  else if (listed === false || (listed !== true && gateReasons(row, gates).length)) refusals.push("held");
  if (atCap instanceof Set && atCap.has(row.coin)) refusals.push("at_cap");
  if (side !== "long" && side !== "short") refusals.push("bad_side");

  if (!fin(marginUsdc) || marginUsdc <= 0) refusals.push("bad_margin");
  else if (marginUsdc > MAX_MARGIN_USDC) refusals.push("margin_cap");

  const caps = [fin(row.maxLeverage) && row.maxLeverage >= 1 ? Math.floor(row.maxLeverage) : null];
  if (by === "agent") {
    caps.push(AGENT_MAX_LEVERAGE);
    if (s.closed) caps.push(closedAgentMaxLeverage);
  }
  const maxLeverage = caps.includes(null) ? null : Math.min(...caps);
  if (!Number.isInteger(leverage) || leverage < 1) refusals.push("bad_leverage");
  else if (maxLeverage == null) refusals.push("leverage_unknown");
  else if (leverage > maxLeverage) refusals.push("leverage_cap");

  const notionalUsd = fin(marginUsdc) && Number.isInteger(leverage) ? marginUsdc * leverage : null;
  if (notionalUsd != null && notionalUsd < HL_MIN_ORDER_USD) refusals.push("min_value");

  const kind = row.kind || (whitelist.find((w) => w.coin === row.coin) || {}).kind;
  const source = xyzPriceSource(now, kind === "index" ? "index" : "stock");
  if (source === "internal") warnings.push("us_market_closed");
  else if (session != null && session !== "regular") warnings.push("extended_hours");
  if (s.session != null && !s.calendarKnown) warnings.push("calendar_old");
  if (fin(row.markOracleGapBps) && Math.abs(row.markOracleGapBps) > ORACLE_GAP_WARN_BPS) warnings.push("price_off_oracle");
  if (row.takerFeeMultiplier == null) warnings.push("fee_unknown");
  if (row.canRemoveMargin === false) warnings.push("margin_locked");

  return { ok: refusals.length === 0, refusals, warnings, maxLeverage, notionalUsd, session, priceSource: source, marginMode: "isolated" };
}

/**
 * The words for each code, short (owner: Tips over sentences; money warnings
 * stay printed). English here; the plan lists the Thai the Agent says.
 */
export const STOCK_GUARD_TEXT = Object.freeze({
  market_unknown: "This market isn't available right now.",
  not_listed: "This stock isn't listed in FlowFlow yet.",
  held: "Trading is paused on this stock for now: the market is too thin.",
  at_cap: "This stock is at its open-interest limit. No new positions for now.",
  bad_side: "Pick Long or Short.",
  bad_margin: "Enter an amount.",
  margin_cap: `Max ${MAX_MARGIN_USDC} USDC per order in FlowFlow for now`,
  bad_leverage: "Pick a leverage.",
  leverage_unknown: "Couldn't read this market's leverage limit. Try again in a moment.",
  leverage_cap: "Leverage is above the limit for this stock right now.",
  min_value: `Orders must be worth at least $${HL_MIN_ORDER_USD}.`,
  us_market_closed: "US market closed: the price comes from the market's own model and can jump when it reopens.",
  extended_hours: "Outside US market hours: thinner trading, bigger moves.",
  calendar_old: "Market-hours calendar needs an update.",
  price_off_oracle: "Price is away from the reference price right now.",
  fee_unknown: "Couldn't read this market's fee, so it shows as —.",
  margin_locked: "Margin can't be taken out of this position once it's open.",
});
