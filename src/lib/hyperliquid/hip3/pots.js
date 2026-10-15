// ─────────────────────────────────────────────────────────────────────────────
// A customer's money and positions on HIP-3 dexes, and what it adds to the
// Main Account total.
// ─────────────────────────────────────────────────────────────────────────────
//
// In standard mode Hyperliquid keeps ONE POT PER DEX. Measured 2026-10-15,
// read-only, a public standard-mode trader (fixtures user-std-*.json, address
// redacted): clearinghouseState dex "" answered accountValue 0.0 while dex
// "xyz" answered 151,858.80 with 8 positions. A total that read only the main
// dex would tell that customer they hold nothing.
//
// In unified / portfolio-margin mode the spot USDC balance backs every dex
// (fixtures user-uni-*.json: xyz accountValue 19,942.86, xyz withdrawable 0.0,
// spot USDC total 115,420.17 with hold 19,963.11 = the xyz totalMarginUsed).
// There the dex figure is ALREADY inside the spot total, and adding it would
// count the same dollars twice.
//
// account/balance.js applies exactly this rule to the venues the store reads
// today (HIP3_VENUES); hip3Equity() is the same rule for any list of dexes, so
// the Stocks plan can widen the list without a second copy of the arithmetic.
//
// WHY THE MODE MAP LIVES HERE TOO. The account layer (../account/) must stay
// out of the flag-off main chunk (scripts/test-hl-account-store.mjs I5), and
// the Stocks tab is a main-chunk page. So this file imports nothing from it and
// carries its own five-line copy of balanceSourceFor; scripts/test-hip3-account.mjs
// pins the two to each other for every mode, so they cannot drift.
//
// UNKNOWN IS NULL. A dex that has not answered makes the added figure null, not
// a smaller number: a part of the account is not the account (store.js).

import { splitHlMarket } from "../coins.js";

/** Which clearinghouse holds the account's USDC, by mode (= account/parse.js balanceSourceFor). */
export function potSourceFor(mode) {
  switch (mode) {
    case "unifiedAccount":
    case "portfolioMargin":
      return "spot";
    case "disabled":
    case "dexAbstraction":
    case "default":
      return "perp";
    default:
      return null;
  }
}

const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function parsePosition(p, dex) {
  if (!p || typeof p !== "object" || typeof p.coin !== "string") return null;
  /* A position of another dex inside this dex's answer is a mix-up, dropped. */
  if (splitHlMarket(p.coin).dex !== dex) return null;
  const szi = num(p.szi);
  const lev = p.leverage && typeof p.leverage === "object" ? p.leverage : {};
  const type = lev.type === "cross" || lev.type === "isolated" ? lev.type : null;
  return Object.freeze({
    coin: p.coin,
    szi,
    side: szi == null || szi === 0 ? null : szi > 0 ? "long" : "short",
    leverageType: type,
    leverage: num(lev.value),
    entryPx: num(p.entryPx),
    positionValue: num(p.positionValue),
    unrealizedPnl: num(p.unrealizedPnl),
    returnOnEquity: num(p.returnOnEquity),
    /* null in the answer when the position cannot be liquidated at any price
       the book can reach (deep cross margin). Kept null: "—", never 0. */
    liquidationPx: num(p.liquidationPx),
    marginUsed: num(p.marginUsed),
    maxLeverage: num(p.maxLeverage),
    fundingSinceOpen: p.cumFunding && typeof p.cumFunding === "object" ? num(p.cumFunding.sinceOpen) : null,
  });
}

/**
 * clearinghouseState { user, dex } -> this dex's pot, or null when unreadable.
 * @returns {{ dex, accountValue, withdrawable, marginUsed, notional, maintenanceUsed, positions, time }|null}
 */
export function parseDexUserState(json, { dex } = {}) {
  if (!json || typeof json !== "object" || !Array.isArray(json.assetPositions) || typeof dex !== "string" || !dex) return null;
  const ms = json.marginSummary && typeof json.marginSummary === "object" ? json.marginSummary : null;
  if (!ms) return null;
  const positions = [];
  for (const ap of json.assetPositions) {
    const p = parsePosition(ap && ap.position, dex);
    if (p && p.szi != null && p.szi !== 0) positions.push(p);
  }
  return Object.freeze({
    dex,
    accountValue: num(ms.accountValue),
    withdrawable: num(json.withdrawable),
    marginUsed: num(ms.totalMarginUsed),
    notional: num(ms.totalNtlPos),
    maintenanceUsed: num(json.crossMaintenanceMarginUsed),
    positions: Object.freeze(positions),
    time: num(json.time),
  });
}

/**
 * What the HIP-3 dexes add to the Main Account total.
 *
 * @param {{ mode: string|null, states: Array<{ dex: string, state: object|null }> }} o
 *   mode    userAbstraction ("disabled", "default", "dexAbstraction", "unifiedAccount", "portfolioMargin")
 *   states  one entry per dex the app lists; state null = not answered (yet)
 * @returns {{ addUsdc: number|null, knownUsdc: number, missing: string[], reason: string }}
 *   addUsdc   the figure to add, or null when it is not known
 *   knownUsdc the sum of the dexes that did answer (for a "partial" line, never as the total)
 *   reason    "pots" | "spot-backs" | "mode-unknown" | "dex-unanswered" | "none"
 */
export function hip3Equity({ mode = null, states = [] } = {}) {
  const list = Array.isArray(states) ? states.filter((s) => s && typeof s.dex === "string") : [];
  const source = potSourceFor(mode);
  if (source == null) return { addUsdc: null, knownUsdc: 0, missing: list.map((s) => s.dex), reason: "mode-unknown" };
  if (source === "spot") return { addUsdc: 0, knownUsdc: 0, missing: [], reason: "spot-backs" };
  if (!list.length) return { addUsdc: 0, knownUsdc: 0, missing: [], reason: "none" };
  let known = 0;
  const missing = [];
  for (const s of list) {
    const v = s.state ? s.state.accountValue : null;
    if (typeof v === "number" && Number.isFinite(v)) known += v;
    else missing.push(s.dex);
  }
  if (missing.length) return { addUsdc: null, knownUsdc: known, missing, reason: "dex-unanswered" };
  return { addUsdc: known, knownUsdc: known, missing: [], reason: "pots" };
}

/**
 * Idle money on a dex: Hyperliquid's own withdrawable when no position is open
 * there, else 0 (that money is margin). null when the state is unreadable.
 * exchange/venueCollateral.js planVenueSweep is what acts on it.
 */
export function idleDexUsdc(state) {
  if (!state || typeof state !== "object" || !Array.isArray(state.positions)) return null;
  if (state.positions.length > 0) return 0;
  return typeof state.withdrawable === "number" && Number.isFinite(state.withdrawable) ? state.withdrawable : null;
}
