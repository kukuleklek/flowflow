// ─────────────────────────────────────────────────────────────────────────────
// The Perp USDC balance: ONE named figure, from ONE clearinghouse.
// ─────────────────────────────────────────────────────────────────────────────
//
// Hyperliquid keeps a user's USDC in one of two places, and which one depends
// on the account's mode (parse.js, balanceSourceFor):
//
//   spot  (unifiedAccount, portfolioMargin)
//         equityUsdc     spot USDC total. Measured live on 2026-09-22: for a
//                        unified account it moved cent-for-cent with the
//                        per-dex accountValue between pushes, so it carries
//                        unrealized P&L; it is the account's USDC equity.
//         holdUsdc       spot USDC hold (margin and orders)
//         availableUsdc  total minus hold: the USDC not held for margin or
//                        orders (the earlier capture session read
//                        app.hyperliquid.xyz's bundle as computing a unified
//                        account's available balance so). The per-dex
//                        withdrawable is NOT used: the docs call per-dex states
//                        "not meaningful" here, and the same account answered
//                        withdrawable 0.0 by REST and 670.29 by WS seconds apart.
//   perp  (disabled, dexAbstraction, default)
//         equityUsdc     clearinghouseState marginSummary.accountValue, PLUS
//                        every HIP-3 venue's own accountValue (see ONE BALANCE)
//         availableUsdc  clearinghouseState withdrawable, MAIN DEX ONLY
//         idleSpotUsdc   spot USDC, reported APART: in standard mode it is not
//                        perp margin until the user moves it
//
// ONE BALANCE, AND WHY ONLY THE EQUITY IS COMBINED (owner, 2026-09-23: the
// customer sees ONE Perp balance). In standard mode Hyperliquid keeps a
// SEPARATE pot per HIP-3 venue. Measured that day, POST /info read-only:
// 0xdd966dff… (mode "disabled") holds accountValue 30,000.00 on the main dex and
// 1,272,516.69 on the xyz dex, with 10 positions there. That second figure is
// the same customer's Perp money, so the equity is the sum — anything less
// showed a millionaire a rounding error of his own account.
//
//   availableUsdc IS NOT SUMMED, on purpose. It feeds canWithdraw and the
//   Withdraw sheet, and a withdrawal leaves sourceDex "" (relayOut.js): a
//   combined figure would promise money the way out cannot reach. Each venue's
//   own withdrawable is carried apart as venueAvailableUsdc, for the code that
//   moves it (exchange/venueCollateral.js), and the sweep brings it to the main
//   dex when a venue position closes.
//
//   THE SPOT SOURCE IS NEVER SUMMED. For unified / portfolio margin the spot
//   USDC total already IS the whole account's equity and backs every venue
//   (measured: a unifiedAccount address with xyz accountValue 0.0 answered
//   availableToTrade 142,094.80 on xyz:TSLA), so adding a venue figure there
//   would count the same money twice.
//
// availableUsdc is FREE USDC, not "available to trade". Measured 2026-09-22: a
// standard account with withdrawable 0.0 had 1703.80 available to trade on
// ETH. The trade ticket reads that per coin from assetData.js
// (usePerpAssetData), never from this figure.
//
// The two are never added together (MONEY_RULES section 1: one source per
// figure). This figure is Perp money: it must never enter usePortfolio, Cash,
// Portfolio totals or the header pills.
//
// UNKNOWN IS NULL (section 0), with a reason a screen can word:
//   mode-unanswered   the mode has not answered yet
//   mode-unknown      a mode string this code does not know
//   spot-unanswered / perp-unanswered   the chosen clearinghouse has not answered
//   agent-address     the address is someone's API wallet (master named)
// A never-used address (userRole "missing") is a KNOWN zero, reason new-account.

import { balanceSourceFor } from "./parse.js";

const EMPTY = Object.freeze({
  answered: false,
  source: null,
  equityUsdc: null,
  availableUsdc: null,
  holdUsdc: null,
  idleSpotUsdc: null,
  /* The venue part of the one equity, and what of it can leave those pots.
     Reported apart so the screens that spend each figure spend the right one. */
  venueEquityUsdc: null,
  venueAvailableUsdc: null,
  complete: null,
  incompleteReason: null,
  reason: null,
  master: null,
});

const unknown = (reason, extra = {}) => ({ ...EMPTY, reason, ...extra });

/* Portfolio margin also counts HYPE, BTC and USDT as collateral: a USDC-only
   figure is then honest only if it says so. */
function otherCollateral(spot) {
  return spot.balances.some((b) => b.token !== 0 && b.total != null && b.total !== 0);
}

/**
 * Every HIP-3 venue state this session holds, folded into two figures.
 * A venue whose accountValue could not be read makes the fold PARTIAL rather
 * than silently smaller (MONEY_RULES section 0: a figure that leaves money out
 * says so). withdrawable is summed only while every venue answered one.
 */
function foldVenues(venues) {
  let equityUsdc = 0;
  let availableUsdc = 0;
  let availableKnown = true;
  let partial = false;
  for (const v of venues) {
    const ch = v && typeof v === "object" ? v : null;
    const eq = ch && typeof ch.accountValue === "number" && Number.isFinite(ch.accountValue) ? ch.accountValue : null;
    const av = ch && typeof ch.withdrawable === "number" && Number.isFinite(ch.withdrawable) ? ch.withdrawable : null;
    if (eq == null) { partial = true; continue; }
    equityUsdc += eq;
    if (av == null) availableKnown = false;
    else availableUsdc += av;
  }
  return { equityUsdc, availableUsdc: availableKnown ? availableUsdc : null, partial };
}

/**
 * @param {{ role?: string|null, master?: string|null, mode?: string|null,
 *   perp?: object|null, spot?: object|null,
 *   venues?: Array<object>|null }} input parsed answers (parse.js), null for any
 *   that has not answered. venues: every HIP-3 venue's parsed clearinghouse
 *   (parseClearinghouse), or null when they have not been read — null keeps the
 *   answer this function gave before venues existed, so a caller that asks only
 *   about the main dex is told only about the main dex.
 * @returns {{ answered: boolean, source: "spot"|"perp"|null,
 *   equityUsdc: number|null, availableUsdc: number|null, holdUsdc: number|null,
 *   idleSpotUsdc: number|null, venueEquityUsdc: number|null,
 *   venueAvailableUsdc: number|null, complete: boolean|null,
 *   incompleteReason: string|null, reason: string|null, master: string|null }}
 */
export function resolvePerpBalance({ role = null, master = null, mode = null, perp = null, spot = null, venues = null } = {}) {
  const source = balanceSourceFor(mode);
  /* "missing" is the role's answer at the moment it was asked. A clearinghouse
     answer that shows USDC is newer news: the first deposit has landed. */
  const funded = (perp != null && perp.accountValue != null && perp.accountValue !== 0)
    || (spot != null && spot.usdc.total != null && spot.usdc.total !== 0);
  if (role === "missing" && !funded) {
    return { ...EMPTY, answered: true, source, equityUsdc: 0, availableUsdc: 0, holdUsdc: source === "spot" ? 0 : null, idleSpotUsdc: source === "perp" ? 0 : null, complete: true, reason: "new-account" };
  }
  if (role === "agent") return unknown("agent-address", { master });
  if (mode == null) return unknown("mode-unanswered");
  if (source == null) return unknown("mode-unknown");

  if (source === "spot") {
    if (!spot) return unknown("spot-unanswered", { source });
    const { total, hold } = spot.usdc;
    const pm = mode === "portfolioMargin" && otherCollateral(spot);
    return {
      ...EMPTY,
      answered: total != null,
      source,
      equityUsdc: total,
      holdUsdc: hold,
      availableUsdc: total != null && hold != null ? total - hold : null,
      complete: pm ? false : true,
      incompleteReason: pm ? "other-collateral" : null,
      reason: total == null ? "spot-unreadable" : null,
    };
  }

  if (!perp) return unknown("perp-unanswered", { source });
  /* THE ONE EQUITY. The main pot plus every venue pot, because they are all this
     customer's Perp money. Venues not read yet (null) leave the figure exactly
     what it was before venues existed, and the store flags it as pending. */
  const v = Array.isArray(venues) ? foldVenues(venues) : null;
  const main = perp.accountValue;
  return {
    ...EMPTY,
    answered: main != null,
    source,
    equityUsdc: main == null || v == null ? main : main + v.equityUsdc,
    /* MAIN ONLY: this is what can LEAVE the account (see ONE BALANCE). */
    availableUsdc: perp.withdrawable,
    idleSpotUsdc: spot ? spot.usdc.total : null,
    venueEquityUsdc: v ? v.equityUsdc : null,
    venueAvailableUsdc: v ? v.availableUsdc : null,
    complete: v == null || !v.partial,
    incompleteReason: v && v.partial ? "perp-venues-partial" : null,
    reason: main == null ? "perp-unreadable" : null,
  };
}
