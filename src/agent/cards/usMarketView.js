// The US market's state as a stock card prints it: "US market open · closes in 2h 10m", "After hours · opens in
// 14h", "US market closed · opens in 1d 6h". PURE apart from Intl (hip3/hours.js); the caller passes the clock.
//
// THREE STATES, ALIGNED WITH THE GUARD (hip3/guard.js): the Agent's leverage drops to 5x whenever usEquitySession()
// says `closed` (a weekday night, a weekend, an NYSE holiday), so this file calls exactly those hours "closed" too.
// A card that is capped at 5x "because the US market is closed" must never say "extended hours" beside it.
//   open       the core session (9:30–16:00 ET)
//   extended   pre-market (4:00–9:30) and after hours (to 20:00): real prices, thin trading
//   closed     overnight, weekend, holiday. On a weekend or holiday the price is the market's own model
//              (xyzPriceSource "internal") and can jump at the open: that note is printed, never folded.
// Never names the venue: "US market", "stock", the company — nothing else (owner: "คนไม่ต้องรู้ห่าอะไรเลย").
import { usEquitySession, xyzPriceSource, nextRegularOpen, nyParts } from "../../lib/hyperliquid/hip3/hours.js";
import { STOCK_GUARD_TEXT } from "../../lib/hyperliquid/hip3/guard.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const MIN = 60_000;

/** "35m", "5h 20m", "1d 6h"; null for an unknown or negative span. Under a minute is "1m" (never "0m"). */
export function durationText(ms) {
  if (!fin(ms) || ms < 0) return null;
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * @param {number} now   the clock (ms)
 * @param {"stock"|"index"} [kind]
 * @returns {{ state: "open"|"extended"|"closed", label: string, sub: string|null, short: string, note: string|null,
 *   modelPrice: boolean, tone: "pos"|"warn"|"muted", session: string } | null}  null: the clock is unknown
 */
export function usMarketView(now, kind = "stock") {
  if (!fin(now)) return null;
  const s = usEquitySession(now);
  if (!s.session) return null;
  const modelPrice = xyzPriceSource(now, kind === "index" ? "index" : "stock") === "internal";
  const next = nextRegularOpen(now);
  const opensIn = next != null ? durationText(next - now) : null;
  if (s.open) {
    const closeMin = s.earlyClose ? 13 * 60 : 16 * 60;
    const left = closeMin - nyParts(now).minutes;
    return {
      state: "open", label: "US market open", sub: left > 0 ? `closes in ${durationText(left * MIN)}` : null,
      short: "Open", note: null, modelPrice, tone: "pos", session: s.session,
    };
  }
  if (!s.closed) {
    return {
      state: "extended", label: s.session === "pre" ? "US pre-market" : "US after hours", sub: opensIn ? `opens in ${opensIn}` : null,
      short: s.session === "pre" ? "Pre-market" : "After hours", note: STOCK_GUARD_TEXT.extended_hours, modelPrice, tone: "warn", session: s.session,
    };
  }
  return {
    state: "closed", label: "US market closed", sub: opensIn ? `opens in ${opensIn}` : null, short: "Closed",
    /* 🔴 A MONEY WARNING, PRINTED: on a weekend or holiday the price is a model and a stop can be jumped at the open. */
    note: modelPrice ? STOCK_GUARD_TEXT.us_market_closed : "US market closed: thin trading until the open.",
    modelPrice, tone: modelPrice ? "warn" : "muted", session: s.session,
  };
}
