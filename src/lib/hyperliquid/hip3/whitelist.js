// ─────────────────────────────────────────────────────────────────────────────
// Which stock perps FlowFlow lists: a hand-kept whitelist, then a live gate.
// ─────────────────────────────────────────────────────────────────────────────
//
// TWO LAYERS, because each catches what the other cannot:
//
//   1. STOCK_WHITELIST: names a person chose. Only the xyz dex for now: it holds
//      USDC collateral (the Main Account's own money can fund it), the deepest
//      books (2026-10-15: SP500 $504M and NVDA $245M 24h volume, impact spread
//      0.1–1.0 bps) and caps far above anything a 20 USDC order can move. Every
//      name below was a live xyz market that day AND has a snapshotted logo in
//      public/hl-coins (the test checks both). AVGO was liquid enough but has
//      no logo there, so it waits.
//   2. STOCK_GATES: the live test a listed name must pass on every refresh. A
//      name that falls below it (volume dries up, the spread blows out, the
//      market nears its OI cap, any figure unreadable) is HELD: not offered for
//      a new trade, while any position on it still shows and can be closed.
//
// Same-ticker markets on other dexes (para:AVGO, io:NBIS, mkts:US500) are not
// listed: one TSLA in the list, never two that disagree by a few cents.
//
// Edit this file by hand, like perpCategories.js. Kinds: stock | index | etf.

export const STOCK_DEX = "xyz";

export const STOCK_WHITELIST = Object.freeze([
  { coin: "xyz:SP500", name: "S&P 500", kind: "index" },
  /* docs.trade.xyz: "100 of the largest, most actively-traded, non-financial
     companies" listed in the US. It is never called Nasdaq-100 there, so neither
     is it here. SP500 is licensed from S&P Dow Jones Indices; its market page
     links the deployer's S&P 500 disclaimers (plan §6.2). */
  { coin: "xyz:XYZ100", name: "US 100 index", kind: "index" },
  { coin: "xyz:NVDA", name: "NVIDIA", kind: "stock" },
  { coin: "xyz:TSLA", name: "Tesla", kind: "stock" },
  { coin: "xyz:AAPL", name: "Apple", kind: "stock" },
  { coin: "xyz:MSFT", name: "Microsoft", kind: "stock" },
  { coin: "xyz:GOOGL", name: "Alphabet", kind: "stock" },
  { coin: "xyz:AMZN", name: "Amazon", kind: "stock" },
  { coin: "xyz:META", name: "Meta", kind: "stock" },
  { coin: "xyz:AMD", name: "AMD", kind: "stock" },
  { coin: "xyz:MU", name: "Micron", kind: "stock" },
  { coin: "xyz:INTC", name: "Intel", kind: "stock" },
  { coin: "xyz:PLTR", name: "Palantir", kind: "stock" },
  { coin: "xyz:COIN", name: "Coinbase", kind: "stock" },
  { coin: "xyz:HOOD", name: "Robinhood", kind: "stock" },
  { coin: "xyz:MSTR", name: "Strategy", kind: "stock" },
  { coin: "xyz:ORCL", name: "Oracle", kind: "stock" },
  { coin: "xyz:NFLX", name: "Netflix", kind: "stock" },
  { coin: "xyz:TSM", name: "TSMC", kind: "stock" },
].map((e) => Object.freeze(e)));

/**
 * The live gate. Defaults sized for a 20 USDC × 10x order (≤ $200 notional):
 * the point is not that the order moves the market, it is that a thin market's
 * price is easy to push around the customer's stop.
 */
export const STOCK_GATES = Object.freeze({
  minDayVolumeUsd: 5_000_000,
  minOpenInterestUsd: 5_000_000,
  maxImpactSpreadBps: 5,
  maxOiCapUse: 0.9,
});

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** Why a row does not pass the gate ([] when it does). An unknown figure is a reason: unknown never passes. */
export function gateReasons(row, gates = STOCK_GATES) {
  const g = { ...STOCK_GATES, ...(gates || {}) };
  if (!row) return ["not_live"];
  const out = [];
  if (!fin(row.dayNtlVlm)) out.push("volume_unknown");
  else if (row.dayNtlVlm < g.minDayVolumeUsd) out.push("volume_low");
  if (!fin(row.openInterestUsd)) out.push("oi_unknown");
  else if (row.openInterestUsd < g.minOpenInterestUsd) out.push("oi_low");
  if (!fin(row.impactSpreadBps)) out.push("spread_unknown");
  else if (row.impactSpreadBps > g.maxImpactSpreadBps) out.push("spread_wide");
  /* No cap answered is not a pass either: a market with no known cap may be one fill from it. */
  if (!fin(row.oiCapUse)) out.push("cap_unknown");
  else if (row.oiCapUse >= g.maxOiCapUse) out.push("cap_near");
  if (!fin(row.px) || row.px <= 0) out.push("price_unknown");
  return out;
}

/**
 * The Stocks list: whitelisted rows that pass the gate, by 24h volume, and the
 * whitelisted names that are held back (with why). A name on the whitelist that
 * the dex no longer lists is held as "not_live".
 *
 * @param {Map<string, object>|Record<string, object>} byCoin parseStockRows().byCoin
 * @param {{ whitelist?: ReadonlyArray<{coin:string,name:string,kind:string}>, gates?: object, atCap?: Set<string> }} [o]
 * @returns {{ listed: object[], held: Array<{ coin: string, name: string, reasons: string[] }> }}
 *   listed rows are the market rows plus { name, kind }
 */
export function screenStocks(byCoin, { whitelist = STOCK_WHITELIST, gates = STOCK_GATES, atCap = null } = {}) {
  const get = (c) => (byCoin instanceof Map ? byCoin.get(c) : byCoin ? byCoin[c] : null) || null;
  const listed = [];
  const held = [];
  whitelist.forEach((w, order) => {
    const row = get(w.coin);
    const reasons = row ? gateReasons(row, gates) : ["not_live"];
    if (row && atCap instanceof Set && atCap.has(w.coin)) reasons.push("at_cap");
    if (reasons.length) { held.push({ coin: w.coin, name: w.name, reasons }); return; }
    listed.push({ ...row, name: w.name, kind: w.kind, order });
  });
  listed.sort((a, b) => b.dayNtlVlm - a.dayNtlVlm || a.order - b.order);
  return { listed: listed.map(({ order, ...r }) => Object.freeze(r)), held };
}

/** Is a coin on the whitelist at all (whatever the gate says today)? */
export function isWhitelistedStock(coin, whitelist = STOCK_WHITELIST) {
  return whitelist.some((w) => w.coin === coin);
}
