// ─────────────────────────────────────────────────────────────────────────────
// What the LIVE perp screens say: every figure and every sentence of the wallet
// strip, the trade ticket, the position card, the close / TP-SL / withdraw
// sheets and the event toasts. PURE: no React, no network, no env, no clock.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-22: "amount ขอเป็น USDC ได้ปะ" / "หน้า UXUI เน้นให้ใช้ USDC (with
// Logo) ด้วยนะ" / "ในหน้าซื้อขาย หน้า Position อะ ทำ Full Wire".
//
// UNITS. Money the user puts in or takes out (the amount, the balance, max
// loss, fees, what a close gives back, a withdrawal) is USDC, printed next to
// the USDC logo by the screens. Prices and position sizes stay in $, as
// Hyperliquid and FOMO print them.
//
// ONE SOURCE PER FIGURE (MONEY_RULES section 1). The position card prints
// Hyperliquid's OWN numbers from the account layer (clearinghouseState):
// nothing here re-derives a P&L, an entry or a liquidation price from a price.
// The only arithmetic is a close share applied to those numbers (the close
// sheet) and the ticket's estimate BEFORE a fill, which is labelled as one.
//
// UNKNOWN IS THE DASH (section 0): every function answers DASH for an input it
// does not have, never a zero. A new Hyperliquid account is a KNOWN zero.
//
// Perp money is its own named figure: nothing here feeds usePortfolio, Cash,
// the Portfolio totals or the header pills.

import { DASH, fmtCompact, fmtPnl } from "../../lib/format.js";
import { formatHlPrice, formatHlSize } from "../../lib/hyperliquid/format.js";
import { roundHlSize, roundHlOrderPx, validateTpSl, HL_MIN_ORDER_USDC } from "../../lib/hyperliquid/exchange/orders.js";
import {
  HL_WITHDRAW_FEE_USDC, HL_WITHDRAW_CHAIN, HL_WITHDRAW_ETA_MINUTES, HL_USDC_DECIMALS,
} from "../../lib/hyperliquid/exchange/master.js";
import { HL_TAKER_FEE_RATE } from "../mock/fees.js";
/* The venue's own multiple of that rate, from the one function that owns it.
   Aliased because perp/mock/fees.js exports a same-named function over a
   builder setting, and two different fees under one name is how a screen comes
   to print the wrong one. */
import { perpTakerFeeRate as venueTakerRate, hlMarketBase } from "../../lib/hyperliquid/venues.js";
import { estIsolatedLiqPx, marginTierFor } from "../perpTicket.js";

export { DASH };

/** The app's own USDC picture (public/tokens/usdc.svg), shared with the Deposit sheet. */
export const USDC_LOGO = "/tokens/usdc.svg";
export const USDC_SYMBOL = "USDC";

/** The ticket's amount chips, in USDC of margin. */
export const PERP_USDC_PRESETS = Object.freeze([10, 25, 50, 100]);

/** The close sheet's slider detents (FOMO: 25 / 50 / 75 / 100). */
export const CLOSE_DETENTS = Object.freeze([0.25, 0.5, 0.75, 1]);

/** Where the ticket remembers leverage, per market (this browser only). */
export const LEVERAGE_MEMORY_KEY = "flowflow.perp.leverage.v1";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/* ── USDC and $ ───────────────────────────────────────────────────────────── */

/** "1,234.50" for a USDC amount; "<0.01" under a cent; the dash for unknown. */
export function usdcNumber(v) {
  if (!fin(v)) return DASH;
  if (v === 0) return "0.00";
  if (Math.abs(v) < 0.005) return "<0.01";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "25.00 USDC", or the dash alone (no unit hanging off an unknown). */
export function usdcText(v) {
  return fin(v) ? `${usdcNumber(v)} ${USDC_SYMBOL}` : DASH;
}

/** "+1.30%" / "-0.24%" from a percent. */
function signedPct(pct) {
  if (!fin(pct)) return DASH;
  return `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(2)}%`;
}

/* A sub-cent figure prints as "<$0.01", which claims no direction; so is its colour. */
/* Under half a cent a position has not moved: no colour, no direction, and —
   since 2026-09-27 — no wording that claims one either (see positionView). */
const FLAT_USD = 0.005;
/* The same boundary for a percentage, which also prints two decimals: under half
   of the last one it rounds to 0.00% and a sign would claim a direction the
   figure no longer has. Each figure is measured against its OWN boundary — the
   amount can round flat while the return on a small margin does not. */
const FLAT_PCT = 0.005;
const toneOf = (v) => (!fin(v) || Math.abs(v) < FLAT_USD ? null : v > 0 ? "pos" : "neg");

/**
 * The all-in taker rate a ticket shows: Hyperliquid's 0.045% plus the builder
 * fee when (and only when) the builder config is whole. A half-set or
 * unreadable config is unknown (null): opens are refused then, and no fee is
 * printed as if it were charged.
 * @param {object} resolved the exchange layer's resolveBuilder() answer
 */
export function perpFeeRateFor(resolved) {
  if (!resolved || resolved.invalid) return null;
  return HL_TAKER_FEE_RATE + (resolved.enabled ? resolved.f / 100_000 : 0);
}

/**
 * 🔴 THE FEE OF THIS MARKET, not of the main dex. A HIP-3 venue's asset is
 * charged a MULTIPLE of Hyperliquid's own taker fee (the deployer's fee scale —
 * venues.js perpTakerFeeRate, which the market row already carries as
 * takerFeeMultiplier), and the build constant above is the main dex's all-in
 * rate. Priced with the constant, a 2x venue showed HALF the real fee and a
 * growth-mode asset — whose multiplier is deliberately unknown — showed a
 * confident main-dex number instead of the dash it is owed.
 *
 * The venue's scale applies to HYPERLIQUID'S share only; our builder fee rides
 * on top of it unchanged, so it is carried across rather than multiplied.
 * Unknown stays unknown: a null here is the dash everywhere it is spent
 * (riskView, closeView and liveLimits all already guard on a finite rate).
 *
 * @param {object|null} market  a market row (markets.js parsePerpMarkets)
 * @param {number|null} allInRate  the build's own all-in rate (PERP_FEE_RATE)
 * @returns {number|null}
 */
export function perpMarketFeeRate(market, allInRate) {
  if (!fin(allInRate)) return null;
  const venue = venueTakerRate(market, HL_TAKER_FEE_RATE);
  if (!fin(venue)) return null;
  return venue + (allInRate - HL_TAKER_FEE_RATE);
}

/**
 * 🔴 WHAT THE CUSTOMER CALLS THIS MARKET, on every screen that says its name out
 * loud. A HIP-3 venue market's coin name arrives from Hyperliquid ALREADY
 * QUALIFIED — "xyz:TSLA", measured 2026-09-23 — and the venue's name has no
 * business on a money screen or in what a screen reader reads (owner, 2026-09-23:
 * the customer's words are Deposit, Withdraw, Perp, Spot). "Slide to Long
 * xyz:TSLA" and "Your xyz:TSLA position" were both shipping that name.
 *
 * The market row's own label is the bare ticker (markets.js sets it), and
 * hlMarketBase answers the same thing from the name alone while the row is still
 * loading. The qualified name stays where it belongs: in the requests.
 *
 * @param {string|null} coin
 * @param {object|null} [market] a market row (markets.js)
 * @returns {string} the bare ticker, or "" when there is nothing to call it
 */
export function perpCoinLabel(coin, market = null) {
  const l = market && typeof market.label === "string" && market.label ? market.label : null;
  if (l) return l;
  if (typeof coin !== "string" || !coin) return "";
  return hlMarketBase(coin) || coin;
}

/* ── the wallet strip ─────────────────────────────────────────────────────── */

/**
 * The Perp balance as the strip prints it (the account layer's perpBalanceUsdc).
 *
 * TWO FIGURES, AND THEY ARE NOT THE SAME QUESTION: `text` is the account's
 * EQUITY (what it is worth) and `withdrawableText` is what can LEAVE it (margin
 * posted on an open position cannot). A screen asking "which account has the
 * money to take out" prints the second one; both are worded here, so neither is
 * re-derived by the screen that shows it (docs/MONEY_RULES.md section 1).
 *
 * @returns {{ known: boolean, text: string, primary: "deposit"|null, canWithdraw: boolean,
 *   withdrawableUsdc: number|null, withdrawableKnown: boolean, withdrawableText: string,
 *   note: string|null }}
 */
export function balanceView(bal) {
  const b = bal && typeof bal === "object" ? bal : null;
  if (!b || b.answered !== true || !fin(b.equityUsdc)) {
    const note = b && b.reason === "agent-address"
      ? "This address is an API wallet that trades for another account. Connect that account's own wallet."
      : null;
    return { known: false, text: DASH, primary: null, canWithdraw: false, withdrawableUsdc: null, withdrawableKnown: false, withdrawableText: DASH, note };
  }
  const withdrawable = fin(b.availableUsdc) ? b.availableUsdc : null;
  const fresh = b.reason === "new-account";
  /* What the figure leaves out, said beside it and never added to it. Not read
     yet (complete null) is no claim.
     🔴 THIS SENTENCE NAMES NO VENUE. It is printed on the wallet strip, which is
     a money screen - it carries the balance and the Deposit and Withdraw buttons -
     and on the chooser those buttons open, and the owner asked for no provider and
     no venue on a money screen (2026-09-23). What it tells the user is what the
     figure leaves out, which needs no name at all.
     🔴 ONE NOTE IS GONE, because it became a LIE. "USDC on another perp account
     is not counted here" was true while the account store read the other perp
     dexes and threw their state away; it now folds every HIP-3 venue's own
     accountValue into this one equity (account/balance.js ONE BALANCE, measured
     2026-09-23), so the money IS counted and there is nothing to say. A note that
     survives the thing it described is worse than no note. */
  const notes = [];
  if (b.complete === false && b.incompleteReason === "other-collateral") {
    notes.push("USDC only: your other collateral is not counted here.");
  } else if (b.complete === false && b.incompleteReason === "perp-venues-partial") {
    /* PART of the equity could not be read. Not a venue, not a dex: some of the
       customer's own Perp money is missing from a figure that says so. */
    notes.push("Part of your Perp balance couldn't be read just now.");
  }
  if (b.source === "perp" && fin(b.idleSpotUsdc) && b.idleSpotUsdc > 0) {
    notes.push(`${usdcNumber(b.idleSpotUsdc)} USDC in Spot, not used for perps.`);
  }
  return {
    known: true,
    text: usdcNumber(b.equityUsdc),
    primary: fresh || b.equityUsdc <= 0 ? "deposit" : null,
    /* 🔴 IS THERE ANYTHING TO TAKE OUT — NOT WHETHER IT CLEARS THE FLOOR. The
       floor of the way out belongs to the way out (lib/relay/withdraw.js
       RELAY_MIN_WITHDRAW_USDC, which the sheet states in words and applies
       INCLUSIVELY), and this flag only opens the door to it. It used to demand
       MORE than the exchange's 1 USDC bridge fee - the fee this round took off
       the screen altogether - so an account holding exactly 1.000000 USDC had
       every door to that sheet disabled while the sheet itself would have
       accepted it. */
    canWithdraw: !fresh && withdrawable != null && withdrawable > 0,
    withdrawableUsdc: withdrawable,
    withdrawableKnown: withdrawable != null,
    withdrawableText: withdrawable != null ? usdcNumber(withdrawable) : DASH,
    note: notes.length ? notes.join(" ") : null,
  };
}

/* ── the position card ────────────────────────────────────────────────────── */

/**
 * FOMO's position card from one Hyperliquid position (account layer's shape).
 *
 * 🔴 TWO QUANTITIES, TWO WORDS, EVERYWHERE (owner, 2026-09-27: "PC PNL Status
 * มันแปลกๆปะ Mobile ด้วยย", and two design reviews of the same screens). The same
 * two figures were called four different things across the card, the ticket,
 * the fill receipt and the close sheet, so a reader could not tell which two
 * numbers they were even looking at. From here on there are exactly two:
 *   MARGIN  the money this position is holding — an ISOLATED position's
 *           marginUsed, which Hyperliquid keeps with the uPnL IN IT, the very
 *           figure a 100% close gives back (closeView), so it prints in USDC
 *           (marginUnit "usdc", the number alone; the card adds the logo, the
 *           unit, and the note that says what is inside the figure). A CROSS
 *           position has no per-position margin at all: that is the account's,
 *           so it is the dash, with marginNote saying why (MONEY_RULES 0 — an
 *           unknown is never a zero and never some other figure standing in).
 *   SIZE    the notional, Hyperliquid's positionValue.
 * Neither is the hero any more: the card leads with the unrealized P&L, because
 * margin + P&L is a balance that barely moves and can never go negative, and
 * reading it means subtracting your own deposit to find out whether you are
 * winning.
 *
 * Funding: Hyperliquid's cumFunding is what the account PAID; its own frontend
 * prints minus sinceOpen, and so does this card.
 */
export function positionView(p, { szDecimals = null } = {}) {
  if (!p || typeof p !== "object" || !p.coin) return null;
  const side = p.side === "long" || p.side === "short" ? p.side : null;
  const Side = side === "long" ? "Long" : side === "short" ? "Short" : "";
  const lev = p.leverage && fin(p.leverage.value) ? p.leverage.value : null;
  const isolated = !!(p.leverage && p.leverage.type === "isolated");
  const marginUsd = isolated && fin(p.marginUsed) ? p.marginUsed : null;
  const sizeUsd = fin(p.positionValue) ? p.positionValue : null;
  const qty = fin(p.szi) ? Math.abs(p.szi) : null;
  const sinceOpen = p.cumFunding && fin(p.cumFunding.sinceOpen) ? p.cumFunding.sinceOpen : null;
  const fundingUsd = sinceOpen == null ? null : sinceOpen === 0 ? 0 : -sinceOpen;
  return {
    coin: p.coin,
    side,
    Side,
    leverage: lev,
    isolated,
    pill: lev != null && Side ? `${lev}x ${Side}` : Side || DASH,
    tone: side === "long" ? "pos" : side === "short" ? "neg" : null,
    marginUsd,
    marginUnit: marginUsd == null ? null : "usdc",
    marginText: marginUsd == null ? DASH : usdcNumber(marginUsd),
    /* 🔴 THE WORD ALONE IS NOT THE WHOLE FIGURE (both design reviews, and
       Hyperliquid's own numbers: fixture C's marginUsed is rawUsd minus
       positionValue, to the cent, so it moves with the mark). It is the margin
       with this position's unrealized result already inside it, and it is what
       a 100% close hands back. Printed as the bare word beside the P&L hero it
       invites the one sum that is wrong here — adding the two — and it will not
       reconcile with the return either, whose base is the margin at entry. So
       the figure says which it is, in the slot the cross note already uses.
       A cross position has none of its own: that margin is the account's, so
       the figure is the dash and the note says why. */
    marginNote: isolated ? "P&L included" : "cross margin",
    sizeUsd,
    sizeText: sizeUsd == null ? DASH : fmtCompact(sizeUsd),
    pnlUsd: fin(p.unrealizedPnl) ? p.unrealizedPnl : null,
    pnlCaption: "Unrealized P&L",
    /* 🔴 ONE SPELLING FOR A POSITION THAT HAS NOT MOVED (owner, 2026-09-27,
       holding his phone next to the desktop: "PC PNL Status มันแปลกๆปะ Mobile
       ด้วยย"). toneOf already called anything under half a cent flat and painted
       it in plain ink, but the words disagreed with each other AND across
       screens: fmtPnl says "$0.00" at exactly zero and "<$0.01" a hair above it,
       so the same flat position read "$0.00 +0.00%" on one screen and
       "<$0.01 +0.00%" on the other — a figure that refuses to claim a direction
       sitting under a plus sign that claims one. Flat now says $0.00 and 0.00%
       everywhere, unsigned. fmtPnl is untouched for every other caller: a
       sub-cent closed TRADE is a real result and still reads "<$0.01". */
    pnlText: !fin(p.unrealizedPnl) ? DASH
      : Math.abs(p.unrealizedPnl) < FLAT_USD ? "$0.00"
        : fmtPnl(p.unrealizedPnl),
    pnlTone: toneOf(p.unrealizedPnl),
    /* The two are ONE line in ONE colour, so an unreadable amount cannot carry a
       confident signed return beside it: unknown on either side is the dash.
       🔴 BUT EACH DROPS ITS SIGN ON ITS OWN ROUNDING, NEVER THE OTHER'S. This
       read the amount's flatness, so ANY sub-cent P&L printed the return as
       0.00% as well — and on a small margin a sub-cent amount is a real return:
       0.004 USDC on 0.50 of margin is 0.8%, shown as nothing at all, which is a
       zero standing in for a figure Hyperliquid did give us (MONEY_RULES 0). */
    roeText: !fin(p.returnOnEquity) || !fin(p.unrealizedPnl) ? DASH
      : Math.abs(p.returnOnEquity * 100) < FLAT_PCT ? "0.00%"
        : signedPct(p.returnOnEquity * 100),
    qtyText: qty == null ? DASH : `${formatHlSize(qty, szDecimals)} ${perpCoinLabel(p.coin)}`,
    entryText: formatHlPrice(p.entryPx, szDecimals),
    liqText: formatHlPrice(p.liquidationPx, szDecimals),
    fundingUsd,
    fundingText: fundingUsd == null ? DASH : fmtPnl(fundingUsd),
    fundingTone: toneOf(fundingUsd),
  };
}

/**
 * The position's TP and SL from the open orders (account layer's tpslByCoin).
 * A position TP/SL (size 0 = the whole position) wins over a fixed-size one.
 * Unanswered orders: the dash; answered with none set: "None".
 */
export function tpslView(orders, coin, { szDecimals = null, position = null } = {}) {
  const answered = !!(orders && orders.answered === true);
  const s = answered && orders.tpslByCoin && coin && Object.prototype.hasOwnProperty.call(orders.tpslByCoin, coin)
    ? orders.tpslByCoin[coin] : null;
  const pick = (leg) => (s ? s[leg === "tp" ? "positionTp" : "positionSl"] || (s[leg] && s[leg][0]) || null : null);
  const tpOrder = pick("tp");
  const slOrder = pick("sl");
  const tp = tpOrder && fin(tpOrder.triggerPx) ? tpOrder.triggerPx : null;
  const sl = slOrder && fin(slOrder.triggerPx) ? slOrder.triggerPx : null;
  const text = (px) => (!answered ? DASH : px == null ? "None" : formatHlPrice(px, szDecimals));
  /* The percentage beside a level is what it would DO: the ROE at that price,
     from Hyperliquid's own entry, size and leverage (tpslOutcome). No position
     handed in, no percentage — never a guessed one. */
  const basis = position ? tpslBasisFromPosition(position, { szDecimals }) : null;
  const pctText = (px) => {
    if (!basis || px == null) return "";
    const o = tpslOutcome(px, basis);
    return o.roePct == null ? "" : `(${roePctText(o.roePct)})`;
  };
  return {
    answered,
    tp, sl, tpOrder, slOrder,
    tpText: text(tp),
    slText: text(sl),
    tpPctText: pctText(tp),
    slPctText: pctText(sl),
    extraTp: s ? Math.max(0, s.tp.length - 1) : 0,
    extraSl: s ? Math.max(0, s.sl.length - 1) : 0,
  };
}

/* ── TP / SL by price, by profit or loss, or by ROE ───────────────────────── */
//
// Owner, 2026-09-22: "อยากให้ใส่กำไรไปได้เลย หรือ จะ SL รับได้เท่าไร / แล้วบอกด้วย
// ว่าขาดทุนกี่ %" — a take profit can be typed as the PROFIT wanted and a stop
// as the LOSS accepted, and every leg says what it would do, in USDC and in %.
//
// THE PERCENT IS HYPERLIQUID'S ROE: pnl / (size x entry / leverage), which
// reproduces the returnOnEquity it reports for an open position (pinned on
// trader C's fixture in scripts/test-perp-tpsl.mjs). So the % on the ticket,
// on the position card's row and on Hyperliquid's own screen are one number.
//
// THE BASIS is the position's own (Hyperliquid's entryPx, size and leverage)
// or, for a new order, the ticket's quote: the expected fill and the size it
// would send. No basis, no figure: the leg says so instead of guessing one.
//
// THE TRIGGER IS ROUNDED to Hyperliquid's price tick by the exchange layer's
// own roundHlOrderPx: a take profit to the nearest tick, a stop TOWARD THE
// ENTRY, so the loss can never come out larger than the one accepted. Every
// figure shown is then recomputed from the ROUNDED trigger, never from what
// was typed.

/** The three ways a leg can be entered. */
export const TPSL_MODES = Object.freeze([
  Object.freeze({ key: "price", label: "Price", unit: "$", aria: "price" }),
  Object.freeze({ key: "usdc", label: "P/L (USDC)", unit: "USDC", aria: "in USDC" }),
  Object.freeze({ key: "roe", label: "% (ROE)", unit: "%", aria: "in % ROE" }),
]);
export const TPSL_DEFAULT_MODE = "price";

/** The quick chips, in ROE percent. */
export const TP_ROE_CHIPS = Object.freeze([10, 25, 50, 100]);
export const SL_ROE_CHIPS = Object.freeze([10, 25, 50]);

const LEG_LABEL = Object.freeze({ tp: "Take profit", sl: "Stop loss" });

/** "+25%" for a take profit chip, "-25%" for a stop chip. */
export function tpslChipText(leg, pct) {
  return `${leg === "tp" ? "+" : "-"}${pct}%`;
}

/** The input's accessible name: "Take profit price" / "Stop loss in USDC" / "Take profit in % ROE". */
export function tpslInputLabel(leg, mode) {
  const m = TPSL_MODES.find((x) => x.key === mode) || TPSL_MODES[0];
  return `${LEG_LABEL[leg] || "Take profit"} ${m.aria}`;
}

/** "+25.0%" / "-12.7%" — the ROE beside a level. */
function roePctText(pct) {
  if (!fin(pct)) return DASH;
  return `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(1)}%`;
}

/** "+106.49 USDC" / "-19.97 USDC"; under a cent claims no direction. */
function signedUsdcText(v) {
  if (!fin(v)) return DASH;
  if (Math.abs(v) < 0.005) return `<0.01 ${USDC_SYMBOL}`;
  return `${v > 0 ? "+" : "-"}${usdcNumber(Math.abs(v))} ${USDC_SYMBOL}`;
}

const dirOf = (side) => (side === "long" ? 1 : side === "short" ? -1 : 0);

/** The basis of an OPEN position: Hyperliquid's own entry, size and leverage. */
export function tpslBasisFromPosition(p, { szDecimals = null, markPx = null } = {}) {
  if (!p || typeof p !== "object") return null;
  const side = p.side === "long" || p.side === "short" ? p.side : null;
  const size = fin(p.szi) ? Math.abs(p.szi) : null;
  const entryPx = fin(p.entryPx) ? p.entryPx : null;
  if (!side || size == null || size <= 0 || entryPx == null || entryPx <= 0) return null;
  const lev = p.leverage && fin(p.leverage.value) && p.leverage.value > 0 ? p.leverage.value : null;
  return Object.freeze({
    side,
    size,
    entryPx,
    leverage: lev,
    marginUsdc: lev == null ? null : (size * entryPx) / lev,
    liqPx: fin(p.liquidationPx) ? p.liquidationPx : null,
    liqEstimate: false,
    markPx: fin(markPx) ? markPx : null,
    szDecimals: Number.isInteger(szDecimals) ? szDecimals : null,
  });
}

/**
 * The basis of a NEW order: the ticket's own quote (the expected fill and the
 * size it would send), the chosen leverage, and the ESTIMATED liquidation
 * price where there is one.
 */
export function tpslBasisFromQuote(quote, { side = null, leverage = null, szDecimals = null, markPx = null, liqPx = null } = {}) {
  if (!quote || quote.ok !== true) return null;
  const s = side === "buy" || side === "long" ? "long" : side === "sell" || side === "short" ? "short" : null;
  const size = fin(quote.size) ? quote.size : null;
  const entryPx = fin(quote.refPx) ? quote.refPx : null;
  if (!s || size == null || size <= 0 || entryPx == null || entryPx <= 0) return null;
  const lev = fin(leverage) && leverage > 0 ? leverage : null;
  return Object.freeze({
    side: s,
    size,
    entryPx,
    leverage: lev,
    marginUsdc: lev == null ? null : (size * entryPx) / lev,
    liqPx: fin(liqPx) ? liqPx : null,
    liqEstimate: true,
    markPx: fin(markPx) ? markPx : null,
    szDecimals: Number.isInteger(szDecimals) ? szDecimals : null,
  });
}

/**
 * A typed amount: its sign (0 when none was typed), and its magnitude. A
 * thousands comma, a % sign, a USDC suffix and the typographic minus are read.
 * @returns {{ empty: boolean, sign: -1|0|1, value: number|null }}
 */
export function parseTpSlAmount(str) {
  const raw = String(str == null ? "" : str).trim();
  if (!raw) return { empty: true, sign: 0, value: null };
  const cleaned = raw.replace(/[\s,]/g, "").replace(/\u2212/g, "-").replace(/usdc$/i, "").replace(/%$/, "");
  const m = cleaned.match(/^([+-]?)(\d+(?:\.\d*)?|\.\d+)$/);
  if (!m) return { empty: false, sign: 0, value: null };
  const value = Number(m[2]);
  if (!fin(value)) return { empty: false, sign: 0, value: null };
  return { empty: false, sign: m[1] === "-" ? -1 : m[1] === "+" ? 1 : 0, value };
}

/** What a trigger price would do, from the basis: P&L in USDC and the ROE. */
export function tpslOutcome(px, basis) {
  const dir = basis ? dirOf(basis.side) : 0;
  if (!basis || !dir || !fin(px) || !fin(basis.size) || !fin(basis.entryPx)) return { pnlUsdc: null, roePct: null };
  const pnlUsdc = dir * basis.size * (px - basis.entryPx);
  const roePct = fin(basis.marginUsdc) && basis.marginUsdc > 0 ? (pnlUsdc / basis.marginUsdc) * 100 : null;
  return { pnlUsdc, roePct };
}

/* The trigger a typed amount asks for, before rounding. */
function targetPx({ leg, mode, value, basis }) {
  if (mode === "price") return value;
  const dir = dirOf(basis.side);
  const want = leg === "tp" ? 1 : -1;
  if (mode === "usdc") return basis.entryPx + (want * value) / (dir * basis.size);
  if (!fin(basis.leverage) || basis.leverage <= 0) return null;
  return basis.entryPx * (1 + (want * value) / (100 * dir * basis.leverage));
}

/* A stop rounds TOWARD the entry (never a bigger loss than the one accepted). */
function roundingFor(leg, side) {
  if (leg !== "sl") return "nearest";
  return side === "long" ? "up" : "down";
}

/** A level in the words of one mode: what the input shows after a mode switch. */
export function tpslInputFor({ leg, mode, px, basis = null }) {
  if (!fin(px)) return "";
  if (mode === "price") return String(px);
  const o = tpslOutcome(px, basis);
  if (mode === "usdc") return fin(o.pnlUsdc) ? `${o.pnlUsdc >= 0 ? "+" : "-"}${Math.abs(o.pnlUsdc).toFixed(2)}` : "";
  return fin(o.roePct) ? `${o.roePct >= 0 ? "+" : "-"}${Math.abs(o.roePct).toFixed(2)}` : "";
}

const legOut = (leg, mode, over = {}) => ({
  leg,
  mode,
  empty: false,
  pinned: false,
  px: null,
  error: null,
  triggerText: DASH,
  ifHitText: "",
  pnlUsdc: null,
  roePct: null,
  tone: null,
  ok: false,
  ...over,
});

/**
 * One leg, as its field prints it.
 * @param {{ leg: "tp"|"sl", mode: "price"|"usdc"|"roe", str: string,
 *   basis: object|null, pinPx?: number|null }} o
 *   pinPx: the level this field was CONVERTED from (a mode switch, or the
 *   position's current level). It is the trigger, so switching modes cannot
 *   move a stop by a tick, and an untouched level is never re-sent.
 * @returns {{ empty, px, error, triggerText, ifHitText, pnlUsdc, roePct, tone, ok }}
 */
export function tpslLegView({ leg = "tp", mode = TPSL_DEFAULT_MODE, str = "", basis = null, pinPx = null } = {}) {
  const out = (over) => legOut(leg, mode, over);
  const a = parseTpSlAmount(str);
  /* 🔴 A PIN IS A LEVEL, AND A LEVEL IS CHECKED. It was converted rather than
     typed, so it is already on the tick and is read as "unchanged" — but it
     OUTLIVES the amount, the leverage and the mark it was made under, and a
     stop that liquidation now reaches first must say so instead of being
     offered and sent. So the pin only replaces the parsing and the rounding
     below; every safety check runs on it exactly as on a typed level.
     It also wins over an empty string: a conversion that could not word the
     level in the chosen mode leaves the field blank, and a blank field that
     still holds a trigger is NOT the user clearing it (the TP/SL sheet reads
     "empty" as "cancel this trigger"). */
  const pinned = fin(pinPx);
  if (!pinned && a.empty) return out({ empty: true });
  const sz = basis ? basis.szDecimals : null;
  const show = (px) => {
    const o = tpslOutcome(px, basis);
    return {
      px,
      triggerText: formatHlPrice(px, sz),
      pnlUsdc: o.pnlUsdc,
      roePct: o.roePct,
      tone: toneOf(o.pnlUsdc),
      ifHitText: fin(o.pnlUsdc) ? `if hit: ${signedUsdcText(o.pnlUsdc)}${fin(o.roePct) ? ` (${roePctText(o.roePct)})` : ""}` : "",
    };
  };
  let px;
  if (pinned) {
    px = pinPx;
  } else {
    if (a.value == null) {
      return out({ error: mode === "price" ? "Enter a price" : mode === "usdc" ? "Enter an amount in USDC" : "Enter a percent" });
    }
    if (a.value <= 0) {
      return out({ error: mode === "price" ? "Enter a price" : "Enter more than 0" });
    }
    if (mode !== "price") {
      if (leg === "tp" && a.sign === -1) return out({ error: "A take profit is a gain: type how much you want to MAKE, like +50." });
      if (leg === "sl" && a.sign === 1) return out({ error: "A stop loss is a loss: type how much you accept to LOSE, like -20." });
      if (!basis) return out({ error: "Enter an amount first, so this can be priced." });
      if (mode === "roe" && !fin(basis.leverage)) return out({ error: "This position's leverage isn't known, so a % can't be priced." });
    }
    const raw = basis || mode === "price" ? targetPx({ leg, mode, value: a.value, basis }) : null;
    if (!fin(raw) || raw <= 0) {
      return out({ error: leg === "sl" ? "More than this position can lose: it would be liquidated first." : "That's more than this market's price can reach." });
    }
    const wire = roundHlOrderPx(raw, sz, roundingFor(leg, basis ? basis.side : null));
    px = wire == null ? raw : Number(wire);
  }
  const view = { ...show(px), pinned };
  const isLong = basis ? basis.side === "long" : true;
  /* Hyperliquid's own rule first: a trigger on the wrong side of the MARK
     fires the moment it is placed (the exchange layer's words, once). */
  if (basis && fin(basis.markPx)) {
    const check = validateTpSl({ isLong, refPx: basis.markPx, tp: leg === "tp" ? px : null, sl: leg === "sl" ? px : null });
    if (check.errors[leg]) return out({ ...view, error: check.errors[leg] });
  }
  if (basis && fin(view.pnlUsdc)) {
    if (leg === "tp" && view.pnlUsdc <= 0) {
      return out({ ...view, error: `A take profit must be a profit: ${isLong ? "above" : "below"} your entry ${formatHlPrice(basis.entryPx, sz)}.` });
    }
    if (!pinned && leg === "sl" && mode !== "price" && view.pnlUsdc === 0) {
      return out({ ...view, error: "Too small for this market's price step." });
    }
    if (leg === "sl" && fin(basis.liqPx) && (isLong ? px <= basis.liqPx : px >= basis.liqPx)) {
      return out({
        ...view,
        error: `Past your ${basis.liqEstimate ? "estimated liquidation price" : "liquidation price"} (${formatHlPrice(basis.liqPx, sz)}): you would be liquidated before this stop fires. Take a smaller loss.`,
      });
    }
    if (leg === "sl" && !fin(basis.liqPx) && fin(basis.marginUsdc) && -view.pnlUsdc > basis.marginUsdc) {
      return out({ ...view, error: `More than the ${usdcText(basis.marginUsdc)} margin backing this position: it would be liquidated first.` });
    }
  }
  return out({ ...view, ok: true });
}

/* Where a fill left the position: startPosition plus the signed size, or null. */
function fillEnd(f) {
  const sp = f && fin(f.startPosition) ? f.startPosition : null;
  if (sp == null || !fin(f.sz) || (f.side !== "buy" && f.side !== "sell")) return null;
  return sp + (f.side === "buy" ? f.sz : -f.sz);
}

/* Did this fill open the position from flat, or flip it through zero? */
function opensPosition(f) {
  const sp = f && fin(f.startPosition) ? f.startPosition : null;
  if (sp === 0) return true;
  const end = fillEnd(f);
  return sp != null && end != null && end !== 0 && Math.sign(end) !== Math.sign(sp);
}

/**
 * The fills of the CURRENT position: newest first, back to (and including) the
 * fill that opened it from flat or flipped it.
 *
 * One market order that sweeps several levels makes several fills in the same
 * millisecond, and a sort by time leaves their order to chance: a sibling of
 * the opening fill may sit AFTER it. So once the opening fill is found, the
 * fills of that same millisecond that ADD to the new side are taken too (a
 * flip's other half, which only closed the old side, is not).
 *
 * Whole or not (fills.partial, the account layer):
 *   the opening fill is in the list        whole, whatever the flag says
 *   false  (REST answered: whole history)  whole
 *   true   (past Hyperliquid's fill cap)   "N+", reason "cap"
 *   null   (only the socket's snapshot, measured at 30 fills, has answered)
 *                                          "N+", reason "loading": the REST read
 *                                          that decides has not landed yet
 * @param {object[]|null} list fills.byCoin[coin] (newest first)
 * @param {{ partial: boolean|null }} opts fills.partial
 * @returns {{ list: object[], complete: boolean|null, reason: "cap"|"loading"|null, countText: string }}
 */
export function positionFills(list, { partial = null } = {}) {
  if (!Array.isArray(list)) return { list: [], complete: null, reason: null, countText: DASH };
  let out = [];
  let opener = null;
  let i = 0;
  for (; i < list.length; i++) {
    const f = list[i];
    out.push(f);
    if (opensPosition(f)) { opener = f; i++; break; }
  }
  if (opener && fin(opener.time)) {
    const side = Math.sign(fillEnd(opener) ?? 0);
    /* Same millisecond as the opener: on the new side it is part of this
       position, on the old side it closed the previous one. */
    const oldSide = (g) => {
      const sp = g && fin(g.startPosition) ? g.startPosition : null;
      return g !== opener && g && g.time === opener.time && sp != null && sp !== 0 && Math.sign(sp) !== side;
    };
    if (side !== 0) out = out.filter((g) => !oldSide(g));
    for (; i < list.length; i++) {
      const g = list[i];
      if (!g || g.time !== opener.time) break;
      const sp = fin(g.startPosition) ? g.startPosition : null;
      if (side !== 0 && sp != null && sp !== 0 && Math.sign(sp) === side) out.push(g);
    }
  }
  const complete = !!opener || partial === false;
  const reason = complete ? null : partial === true ? "cap" : "loading";
  const n = out.length;
  let countText;
  if (complete) countText = `${n} transaction${n === 1 ? "" : "s"}`;
  else countText = n ? `${n}+ transactions` : `${DASH} transactions`;
  return { list: out, complete, reason, countText };
}

/**
 * The chart's labelled levels (ChartPanel priceLines): FOMO's Avg. entry,
 * Liquidation, Take profit and Stop loss. A level that is unknown draws no line.
 * Liquidation is not kept in view: it shows only when the candles reach it.
 */
export function chartLinesFor(position, tpsl, { mock = false } = {}) {
  if (!position) return [];
  const pre = mock ? "MOCK " : "";
  const out = [];
  const add = (id, price, color, title, keep) => {
    if (!fin(price) || price <= 0) return;
    const line = { id, price, color, title: pre + title, style: "dashed" };
    if (keep) line.keepInView = true;
    out.push(line);
  };
  add("entry", position.entryPx, "ink2", "Avg. entry", true);
  add("liq", position.liquidationPx, "gold", "Liquidation", false);
  if (tpsl) {
    add("tp", tpsl.tp, "pos", "Take profit", true);
    add("sl", tpsl.sl, "var(--p-orange, #ff8a34)", "Stop loss", true);
  }
  return out;
}

/** How near the mark may come to liquidation before the card warns: 5%. */
export const LIQ_WARN_WITHIN = 0.05;

/**
 * HOW FAR A PRICE IS FROM LIQUIDATION, as a fraction of that price, measured in
 * the direction the position loses. THE ONE FUNCTION: the leverage control's
 * pre-trade estimate and the open position's own warning both read it, so the
 * distance the ticket promises and the distance the position later reports
 * cannot be two different arithmetics (MONEY_RULES section 1).
 *
 * Either side's words are accepted ("buy" on the ticket, "long" on the
 * position). Unknown in, null out. At or past the price, zero: a position
 * cannot have negative room.
 * @param {{ side: string, px: number|null, liqPx: number|null }} o
 * @returns {number|null}
 */
export function liqGap({ side, px, liqPx } = {}) {
  const dir = side === "long" || side === "buy" ? 1 : side === "short" || side === "sell" ? -1 : 0;
  const p = fin(px) && px > 0 ? px : null;
  const liq = fin(liqPx) && liqPx > 0 ? liqPx : null;
  if (!dir || p == null || liq == null) return null;
  const gap = dir === 1 ? (p - liq) / p : (liq - p) / p;
  return gap > 0 ? gap : 0;
}

/**
 * The card's warning as the mark nears the liquidation price (critic_A: "a
 * warning as the margin ratio nears maintenance"). Two figures, each from its
 * one source: Hyperliquid's own liquidationPx (clearinghouseState) and the
 * market's mark (the market store), the price Hyperliquid liquidates on.
 * Nothing is re-derived. Unknown either way (a null liquidation price stays
 * null): no warning at all, never a made-up distance.
 * @returns {{ pct: number, near: boolean, text: string }|null}
 */
export function liqWarningView(position, markPx, { within = LIQ_WARN_WITHIN } = {}) {
  if (!position || (position.side !== "long" && position.side !== "short")) return null;
  const gap = liqGap({ side: position.side, px: markPx, liqPx: position.liquidationPx });
  if (gap == null) return null;
  if (gap <= 0) return { pct: 0, near: true, text: "Mark price is at the liquidation price" };
  const pct = gap * 100;
  return { pct, near: gap <= within + 1e-12, text: `Mark price is ${pct.toFixed(1)}% from liquidation` };
}

/* ── the ticket ───────────────────────────────────────────────────────────── */

/* 🔴 THERE WAS A leverageChips HERE, and it is gone with its only caller
   (2026-09-27). It spelled a SECOND row of leverage buttons — 2x 5x 10x 20x and
   the market's maximum — under the control's own detent labels, which named four
   of the same values. The control is one track with one row of labels now
   (PerpLeverage.jsx), so this had no reader left, and a view function nobody
   calls is a decision nobody is making. The detents themselves are
   LEVERAGE_DETENTS plus the market maximum, below. */

/* ── the leverage control (owner, 2026-09-23) ─────────────────────────────── */
//
// "ตอนเลือก Leverage ด้วย ... ให้โหดกว่านี้ หรูกว่านี้" — the wrapping chip grid is
// replaced by a drag track with detents, a big value coloured by risk, a live
// liquidation line with a distance bar, and a plain-words warning past 20x.
//
// EVERY FIGURE HERE IS riskView'S. This computes no liquidation price of its
// own: it re-words the one estimate the ticket already shows and the position
// later reports (liqGap). Where that estimate does not exist, this says why in
// one short line and prints the dash — a leverage screen is the last place a
// made-up number belongs.

/** The track's detents: 1 / 5 / 10 / 20, then the market's own maximum. */
export const LEVERAGE_DETENTS = Object.freeze([1, 5, 10, 20]);

/** Past this the ticket warns in plain words (owner: "past 20x"). */
export const LEVERAGE_WARN_ABOVE = 20;

/** How near a detent a drag must come to click onto it (fraction of the track). */
export const LEVERAGE_SNAP = 0.035;

/** The full bar: 25% of room or more fills it. */
const LIQ_BAR_FULL_PCT = 25;

/** The colour each risk band paints the big value (the theme tokens). */
export const LEVERAGE_TONE_COLOR = Object.freeze({
  low: "var(--p-ink)",
  mid: "var(--p-blue-2)",
  high: "var(--p-gold)",
  extreme: "var(--p-neg)",
});

/** 1 / 5 / 10 / 20 under the market's maximum, then the maximum itself. */
export function leverageMarks(maxLeverage) {
  const max = fin(maxLeverage) && maxLeverage >= 1 ? Math.floor(maxLeverage) : null;
  if (max == null) return [];
  const out = LEVERAGE_DETENTS.filter((d) => d < max);
  out.push(max);
  return out;
}

/**
 * Where a leverage sits on the track, 0..1. LOG spaced: each doubling of risk
 * takes the same travel, which keeps 1x / 5x / 10x from being crushed into the
 * left edge of a 40x market (linear spacing put the first three detents inside
 * the leftmost quarter).
 */
export function leverageRatio(value, maxLeverage) {
  const max = fin(maxLeverage) && maxLeverage >= 1 ? Math.floor(maxLeverage) : null;
  if (max == null || max <= 1) return 0;
  const v = Math.min(max, Math.max(1, fin(value) ? value : 1));
  return Math.log(v) / Math.log(max);
}

/** The leverage a drag to `ratio` picks: an integer, clamped, magnetised to a nearby detent. */
export function leverageFromRatio(ratio, maxLeverage, { snap = LEVERAGE_SNAP } = {}) {
  const max = fin(maxLeverage) && maxLeverage >= 1 ? Math.floor(maxLeverage) : null;
  if (max == null) return 1;
  const r = fin(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  for (const m of leverageMarks(max)) {
    if (Math.abs(leverageRatio(m, max) - r) <= snap) return m;
  }
  const raw = Math.round(Math.exp(r * Math.log(max)));
  return Math.min(max, Math.max(1, raw));
}

/** The next detent up or down from a value (PageUp / PageDown, and a chip's neighbour). */
export function leverageStepDetent(value, maxLeverage, dir) {
  const marks = leverageMarks(maxLeverage);
  if (!marks.length) return 1;
  const v = fin(value) ? value : 1;
  if (dir > 0) return marks.find((m) => m > v) ?? marks[marks.length - 1];
  return [...marks].reverse().find((m) => m < v) ?? marks[0];
}

/**
 * The risk band the value is painted in: from the LIQUIDATION DISTANCE when it
 * can be estimated (that is what the risk actually is, and it differs between
 * markets at the same leverage), and from the leverage itself when it cannot.
 */
export function leverageTone(leverage, distPct) {
  if (fin(distPct)) return distPct >= 15 ? "low" : distPct >= 7 ? "mid" : distPct >= 3 ? "high" : "extreme";
  const v = fin(leverage) ? leverage : 1;
  return v <= 5 ? "low" : v <= 10 ? "mid" : v <= LEVERAGE_WARN_ABOVE ? "high" : "extreme";
}

/** Why there is no liquidation estimate, in one short line, or null when none is owed. */
function liqReasonNote(reason, riskNote) {
  if (reason === "unified") return `${riskNote || "Liquidation price shows after the fill"}.`;
  if (reason === "tier") return "This size is past the first margin tier, so the estimate shows only after the fill.";
  if (reason === "tiers-unknown") return "This market's margin tiers aren't in yet, so no estimate is shown.";
  if (reason === "unknown") return "This account's liquidation price can't be estimated before the fill.";
  return null;
}

/**
 * THE LEVERAGE CONTROL'S WORDS AND GEOMETRY.
 *   value / marks / ratio   the track
 *   tone                    the colour band (LEVERAGE_TONE_COLOR)
 *   liqText / distText      "≈ $68,585" and "19.0% away", or the dash
 *   line                    the one line: "Liq ≈ $68,585 · 19.0% away"
 *   barPct                  the distance bar, 0..1, null when there is no distance
 *   estimate / estimateText it is an estimate until the order fills — and both
 *                           are empty where there is no estimate to qualify
 *   note                    why there is no estimate (one short line) or null
 *   warn                    past 20x: the real distance and the real max loss
 * @param {{ leverage, maxLeverage, marginUsdc, market, side, risk }} o riskView's answer as `risk`
 */
export function leverageView({ leverage = null, maxLeverage = null, marginUsdc = null, market = null, side = "buy", risk = null } = {}) {
  const max = fin(maxLeverage) && maxLeverage >= 1 ? Math.floor(maxLeverage) : (market && fin(market.maxLeverage) ? Math.floor(market.maxLeverage) : null);
  const value = fin(leverage) ? Math.min(max ?? leverage, Math.max(1, Math.round(leverage))) : 1;
  const r = risk || {};
  const liq = fin(r.liqPx) ? r.liqPx : null;
  const distPct = fin(r.liqGapPct) ? r.liqGapPct : null;
  const liqText = r.liqText || DASH;
  const distText = distPct == null ? DASH : `${distPct.toFixed(1)}% away`;
  const parts = [liqText];
  if (distPct != null) parts.push(distText);
  /* 🔴 NO RED BLOCK ABOVE A LEVERAGE (owner, 2026-09-27, holding a screenshot of
     the 40x ticket: "ไม่ต้องเตือน แดงๆหรอก ถ้า Leverage มันเยอะอะ"). It said a
     move against you closes the position and you lose what you put in — which
     the line right above it already says as a number: the liquidation price and
     how far away it is. A second, louder copy of a figure is not information.
     The colour of the value stays (leverageTone answers "extreme" past
     LEVERAGE_WARN_ABOVE), because a colour is a reading, not a lecture. */
  return {
    value,
    maxLeverage: max,
    marks: leverageMarks(max),
    ratio: leverageRatio(value, max),
    valueText: `${value}x`,
    tone: leverageTone(value, distPct),
    liqPx: liq,
    liqText,
    distPct,
    distText,
    line: `Liq ${parts.join(" · ")}`,
    barPct: distPct == null ? null : Math.min(1, Math.max(0.02, distPct / LIQ_BAR_FULL_PCT)),
    /* 🔴 ONLY WHERE THERE IS ONE. This pair used to be unconditional, so a
       screen with a dash where the price goes carried a line promising that the
       dash was provisional — two claims about one figure, one of them false. */
    estimate: liq != null,
    estimateText: liq == null ? null : "An estimate until the order fills.",
    note: liq == null ? liqReasonNote(r.liqReason, r.liqNote) : null,
    side,
  };
}

function readMemory(storage) {
  const raw = storage.getItem(LEVERAGE_MEMORY_KEY);
  if (!raw) return {};
  const j = JSON.parse(raw);
  return j && typeof j === "object" && !Array.isArray(j) ? j : {};
}

/** The leverage last used on this market in this browser, or null. Never throws. */
export function readLeverageMemory(storage, coin) {
  try {
    if (!storage || !coin) return null;
    const v = readMemory(storage)[coin];
    return Number.isInteger(v) && v >= 1 ? v : null;
  } catch {
    return null;
  }
}

/** Remember a market's leverage. Never throws (private mode, blocked storage). */
export function writeLeverageMemory(storage, coin, leverage) {
  try {
    if (!storage || !coin || !Number.isInteger(leverage) || leverage < 1) return;
    let m = {};
    try { m = readMemory(storage); } catch { m = {}; }
    m[coin] = leverage;
    storage.setItem(LEVERAGE_MEMORY_KEY, JSON.stringify(m));
  } catch {
    /* the pick lives for this visit only */
  }
}

/**
 * The amount chips: greyed above what can be spent, or when the notional would
 * be under Hyperliquid's $10 minimum. An unknown balance greys nothing (it is
 * not a zero).
 */
export function presetView({ maxMarginUsdc = null, leverage = null, presets = PERP_USDC_PRESETS } = {}) {
  return presets.map((v) => ({
    kind: "amount",
    value: v,
    label: String(v),
    disabled: (fin(maxMarginUsdc) && v > maxMarginUsdc) || (fin(leverage) && v * leverage < HL_MIN_ORDER_USDC),
  }));
}

/**
 * The ticket's ONE row of amounts: the chips above plus Max, which is
 * everything the account can actually put behind this order (the fee already
 * out, usePerpTradeLimits). Max with no known limit is greyed, never a zero.
 * Owner, 2026-09-23: "one row of presets 10/25/50/100/Max".
 */
export function amountPresetView({ maxMarginUsdc = null, leverage = null, presets = PERP_USDC_PRESETS } = {}) {
  const max = fin(maxMarginUsdc) && maxMarginUsdc > 0 ? maxMarginUsdc : null;
  return [
    ...presetView({ maxMarginUsdc, leverage, presets }),
    { kind: "max", value: max, label: "Max", disabled: max == null },
  ];
}

/**
 * The risk line above the slide: "Size $250 · Liq ≈ $X (−Y%) · Max loss 50 USDC
 * · Fee ≈ Z USDC".
 *   notionalUsd  the order's size x the mid it is priced from (the quote)
 *   liq          an ESTIMATE before the fill (Hyperliquid's isolated formula,
 *                first margin tier) and only on a standard account: a unified
 *                or portfolio-margin account has no supported pre-trade input
 *                (critic_A, spike S4), so it is the dash there. A mock quote
 *                passes its own liquidation price (liqPx).
 *   max loss     the isolated margin, which is all an isolated position can lose.
 *                Adding to a CROSS position (one opened on Hyperliquid itself,
 *                marginMode "cross"): the whole Perp balance backs it, so no
 *                max loss is claimed (the dash, and a note says why).
 * @param {{ side, marginUsdc, leverage, market, feeRate, balanceSource, notionalUsd, liqPx?, marginMode? }} o
 */
export function riskView({ side, marginUsdc, leverage, market, feeRate, balanceSource, notionalUsd, liqPx, marginMode = "isolated" } = {}) {
  const margin = fin(marginUsdc) && marginUsdc > 0 ? marginUsdc : null;
  /* 🔴 A DASH IS FOR AN UNKNOWN, AND THIS IS NOT ONE (owner, 2026-09-27; both
     design reviews caught it on the phone). The quote is the better figure —
     the lot-rounded size at the price it would fill at — but it is the only one
     the ticket had, so any refusal from the seam blanked the size the reader
     had just typed: on the mock, opening a second order in a market that
     already holds a position refuses the quote, and the amount, the leverage
     and the mark were all on screen the whole time. Size IS the amount times
     the leverage; that is the definition, not an estimate, and it needs no
     exchange to answer. Missing either input is still the dash.
     AND THE MARGIN TIER BELOW READS THIS SAME FIGURE, deliberately: a refused
     quote used to leave the tier unanswered and withhold the liquidation
     estimate with it. The estimate is never built from the notional — it is the
     mark, the leverage and the market's own cap (estIsolatedLiqPx) — so the
     tier lookup is the whole of what the fallback changes there. What it costs:
     this figure is not lot-rounded, so both it and the fee it drives can sit one
     rounding step above the order that finally goes out, which is why each
     carries its own approximately-equal mark on screen. */
  const quoted = fin(notionalUsd) && notionalUsd > 0 ? notionalUsd : null;
  const notional = quoted != null ? quoted
    : margin != null && fin(leverage) && leverage > 0 ? margin * leverage
      : null;
  const sz = market ? market.szDecimals : null;
  const px = market && fin(market.px) ? market.px : null;
  let liq = null;
  let liqNote = null;
  /* WHY there is no estimate, so a leverage screen can say it in one line
     instead of printing a number nobody computed (MONEY_RULES section 0). */
  let liqReason = null;
  if (liqPx !== undefined) {
    liq = fin(liqPx) ? liqPx : null;
    /* 🔴 AN EMPTY AMOUNT BOX IS NOT A BROKEN ACCOUNT (owner's own flow,
       2026-09-27, mobile-2-ticket). A caller that prices the estimate itself
       hands this one in explicitly, and with nothing typed it has no quote to
       take one from, so it hands in null — which read as "this account cannot
       be estimated" and printed exactly that under the dash. Nothing was wrong
       with the account: there was no amount yet. So the missing amount answers
       first, with the reason the branch below has always given it, and that
       reason is answered with silence rather than a sentence. */
    if (liq == null) liqReason = margin == null ? "no-amount" : "unknown";
  } else if (balanceSource === "perp") {
    const tiers = market && Array.isArray(market.marginTiers) && market.marginTiers.length ? market.marginTiers : null;
    const tier = tiers && notional != null ? marginTierFor(tiers, notional) : null;
    if (margin == null) liqReason = "no-amount";
    else if (!tiers) liqReason = "tiers-unknown";
    else if (!tier || tier !== tiers[0]) liqReason = "tier";
    else {
      liq = estIsolatedLiqPx({ side, entryPx: px, leverage, maxLeverage: market ? market.maxLeverage : null });
      if (liq == null) liqReason = "unknown";
    }
  } else {
    liqNote = "Liquidation price shows after the fill";
    liqReason = "unified";
  }
  const liqPct = liq != null && liq > 0 && px ? ((liq - px) / px) * 100 : null;
  /* The DISTANCE, from the one function the position's own warning reads. */
  const gap = liqGap({ side, px, liqPx: liq });
  const fee = notional != null && fin(feeRate) ? notional * feeRate : null;
  return {
    sizeText: notional == null ? DASH : fmtCompact(notional),
    liqPx: liq,
    liqText: liq == null ? DASH : liq === 0 ? "None" : `≈ ${formatHlPrice(liq, sz)}`,
    liqPctText: liqPct == null ? "" : `(${liqPct < 0 ? "-" : "+"}${Math.abs(liqPct).toFixed(1)}%)`,
    liqGapPct: gap == null ? null : gap * 100,
    liqReason,
    liqNote,
    maxLossText: margin == null || marginMode === "cross" ? DASH : usdcText(margin),
    /* All of an isolated margin is, by definition, -100% of it (ROE). */
    maxLossPctText: margin == null || marginMode === "cross" ? "" : "(-100%)",
    maxLossNote: marginMode === "cross" ? "Cross margin: your whole Perp balance backs this position" : null,
    feeUsdc: fee,
    feeText: fee == null ? DASH : `≈ ${usdcText(fee)}`,
  };
}

/* ── the close sheet ──────────────────────────────────────────────────────── */

/**
 * What closing a share of the position gives back, from Hyperliquid's numbers
 * times the share: value (an isolated position's margin with its P&L), size,
 * est. P&L (before the fee) and the fee. A cross position's value is the dash:
 * its margin is the account's, not the position's.
 *
 * The share is the one the close SENDS: under 100% the size rounds DOWN to the
 * market's lot (orders.js planCloseFraction), and every figure is scaled by
 * that rounded size over the position's size, never by the raw pick. A share
 * that rounds to nothing sends nothing, so its figures are the dash. The size
 * decimals unknown, the share the close sends is unknown too: the dash.
 */
export function closeView(p, fraction, { feeRate = null, szDecimals = null } = {}) {
  const f = fin(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  if (!p) return { valueUsdc: null, valueText: DASH, pctText: DASH, qtyText: DASH, pnlText: DASH, pnlTone: null, feeText: DASH, notionalText: DASH };
  const isolated = !!(p.leverage && p.leverage.type === "isolated");
  const abs = fin(p.szi) ? Math.abs(p.szi) : null;
  const qtyStr = abs == null || !Number.isInteger(szDecimals) ? null : f === 1 ? String(abs) : roundHlSize(abs * f, szDecimals, "down");
  const qty = qtyStr == null ? null : Number(qtyStr);
  /* The share actually sent: 1 for a full close, rounded size / size otherwise. */
  const sent = f === 1 ? 1 : qty != null && abs > 0 && qty > 0 ? Math.min(1, qty / abs) : null;
  const valueUsdc = sent != null && isolated && fin(p.marginUsed) ? p.marginUsed * sent : null;
  const pnl = sent != null && fin(p.unrealizedPnl) ? p.unrealizedPnl * sent : null;
  const notional = sent != null && fin(p.positionValue) ? p.positionValue * sent : null;
  const fee = notional != null && fin(feeRate) ? notional * feeRate : null;
  return {
    valueUsdc,
    valueText: valueUsdc == null ? DASH : usdcNumber(valueUsdc),
    pctText: `${Math.round(f * 100)}%`,
    qtyText: qtyStr == null ? DASH : `${qtyStr} ${perpCoinLabel(p.coin)}`,
    /* 🔴 THE CARD'S OWN SPELLING FOR A POSITION THAT HAS NOT MOVED
       (positionView, and MONEY_RULES 4). The card reads "$0.00" and this sheet
       is one tap away from it on the same unrealized figure: "<$0.01" here was
       the owner's complaint moved rather than answered. A closed TRADE is a
       real result and fmtPnl still spells its last half cent. */
    pnlText: pnl == null ? DASH : Math.abs(pnl) < FLAT_USD ? "$0.00" : fmtPnl(pnl),
    pnlTone: toneOf(pnl),
    notionalText: notional == null ? DASH : fmtCompact(notional),
    feeText: fee == null ? DASH : `≈ ${usdcText(fee)}`,
  };
}

/* ── errors and results ───────────────────────────────────────────────────── */

const ENABLE_CODES = new Set(["needs_enable", "agent_missing", "builder_not_approved"]);
const CONNECT_CODES = new Set(["no_wallet", "wallet_mismatch", "wallet_chain_unknown"]);
const RETRY_CODES = new Set([
  "busy", "state_unknown", "price_stale", "price_unknown", "rate_limited", "no_match", "no_liquidity",
  "market_unknown", "nonce", "oracle_far", "network", "superseded", "orphan_cancel_failed", "signature_rejected",
]);
/* The outcome is not known: a lost reply, an answer nobody can read, or a
   surprise inside the seam. Each message already says "check your positions";
   the next step is that check, never a second send. */
const UNKNOWN_CODES = new Set(["unknown_outcome", "bad_response", "unexpected"]);

/**
 * A refusal in plain words and the one next step:
 *   deposit    Hyperliquid accepts nothing from an address that never deposited
 *   enable     the trading key is missing, expired or replaced
 *   connect    no wallet, or the wallet is not the account shown
 *   positions  the reply was lost: check before trying again (never re-sent)
 *   retry      a moment later should work
 * The message is the exchange layer's own (Hyperliquid's text verbatim when it
 * is one the layer does not know).
 */
export function tradeErrorView(r) {
  if (!r || r.ok !== false) return null;
  const code = r.code || "";
  let next = null;
  if (code === "must_deposit") next = "deposit";
  else if (r.needsEnable === true || ENABLE_CODES.has(code)) next = "enable";
  else if (CONNECT_CODES.has(code)) next = "connect";
  else if (UNKNOWN_CODES.has(code) || (code === "network" && r.lost === true)) next = "positions";
  else if (RETRY_CODES.has(code)) next = "retry";
  return {
    code,
    next,
    title: next === "positions" ? "Not confirmed" : "Didn't go through",
    text: r.message || "Something went wrong. Nothing was sent.",
  };
}

const LEG_NAME = Object.freeze({ tp: "Take profit", sl: "Stop loss" });

/** What an open (or an add) did, in lines; a TP/SL leg that did not land is a warning. */
export function openResultView(r, { szDecimals = null, adding = false } = {}) {
  if (!r || r.ok !== true) return null;
  const Side = r.side === "buy" || r.side === "long" ? "Long" : "Short";
  const lev = fin(r.leverage) ? `${r.leverage}x ` : "";
  const lines = [];
  const warnings = [];
  const coin = perpCoinLabel(r.coin);
  if (r.status === "filled" && r.filled) {
    const at = r.filled.avgPx != null ? ` at ${formatHlPrice(Number(r.filled.avgPx), szDecimals)}` : " at market";
    lines.push(r.partial ? `Partly filled: ${r.filled.totalSz} of ${r.size} ${coin}${at}` : `Filled ${r.filled.totalSz} ${coin}${at}`);
  } else {
    lines.push("The order is on the book, not filled yet. Check it on the position.");
  }
  const tpsl = r.tpsl || {};
  for (const leg of ["tp", "sl"]) {
    const st = tpsl[leg];
    const name = LEG_NAME[leg];
    if (st === "placed") lines.push(`${name} set`);
    else if (st === "placed_after_fill") lines.push(`${name} set after the fill`);
    else if (st === "unverified") warnings.push(`${name} isn't confirmed yet: check it on the position.`);
    else if (st === "failed") warnings.push(`${name} was not set: ${(r.tpslError && r.tpslError.message) || "set it again from the position."}`);
  }
  if (Array.isArray(r.tpslResized) && r.tpslResized.length) lines.push("TP / SL resized to the new position");
  if (r.warning) warnings.push(r.warning);
  if (Array.isArray(r.clearedOrphans) && r.clearedOrphans.length) {
    lines.push(`Cleared ${r.clearedOrphans.length} old TP/SL order${r.clearedOrphans.length === 1 ? "" : "s"} first`);
  }
  if (r.recovered) lines.push("Hyperliquid's reply was lost; the order was found by its id.");
  const title = r.status === "filled"
    ? (adding ? `Added to ${coin} ${Side.toLowerCase()}` : `${lev}${Side} ${coin} opened`)
    : `${lev}${Side} ${coin} order placed`;
  return { title, lines, warnings, warn: warnings.length > 0 };
}

/* ── the filled state (owner, 2026-09-23) ─────────────────────────────────── */
//
// "หรือตอนซื้อขาย เสร็จด้วย" — a fill used to leave two lines of text and a Done
// button. It now shows the position itself: a check, what was done, what it
// filled at, the position's own figures, a nudge when nothing protects it, and
// somewhere to go next.
//
// 🔴 NOT ONE FIGURE HERE IS RE-DERIVED. The fill price and size are the ORDER
// RESULT'S (Hyperliquid's own response); the value, P&L, entry and liquidation
// price are the ACCOUNT'S (clearinghouseState, through positionView); the fee
// is the ACCOUNT'S OWN FILL for this order id — not the ticket's fee estimate,
// which was an estimate. Until the account has caught up with the order, those
// figures carry `settling` and the screen pulses them (MONEY_RULES section 0:
// unknown is the dash or the pulse, never a zero and never a guess).
//
// CAUGHT UP means the account reports a position on the right side whose size
// has reached what this order left behind: the size it had before (priorSz, 0
// on an open) plus the size that filled. A snapshot taken a moment before the
// fill shows the OLD position, and printing that as the new one is the whole
// failure this flag exists to stop.

/** The fill's own fee, from the account's fills for THIS order id. Unknown: null. */
function feeOfOrder(fills, oid) {
  const list = fills && Array.isArray(fills.list) ? fills.list : Array.isArray(fills) ? fills : null;
  if (oid == null || !list) return null;
  const mine = list.filter((f) => f && f.oid === oid && fin(f.fee));
  return mine.length ? mine.reduce((s, f) => s + f.fee, 0) : null;
}

/**
 * What the screen shows after a slide that went through.
 * @param {object} r the exchange layer's own answer (openMarket / addMarket)
 * @param {{ position, fills, priorSz, szDecimals, adding }} o the account's slice for this coin
 */
export function fillView(r, { position = null, fills = null, priorSz = null, szDecimals = null, adding = false } = {}) {
  if (!r || r.ok !== true) return null;
  const base = openResultView(r, { szDecimals, adding }) || { lines: [], warnings: [], warn: false };
  /* coin stays the qualified name the caller handed in; name is what is printed. */
  const coin = r.coin || "";
  const name = perpCoinLabel(coin);
  const long = r.side === "buy" || r.side === "long";
  const lev = fin(r.leverage) ? `${r.leverage}x` : null;
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const filledSz = r.status === "filled" && r.filled ? num(r.filled.totalSz) : null;
  const avgPx = r.filled ? num(r.filled.avgPx) : null;
  /* 🔴 AN ORDER ON THE BOOK HAS NOT BOUGHT ANYTHING YET. The check, the
     title and the rows are one card: "Longed BTC" over six dashes reads as a
     position the reader does not have, so an unfilled order says what did
     happen and the rows stay honest under it. */
  const title = [
    filledSz == null
      ? `${name} ${long ? "long" : "short"} order placed`
      : adding ? `Added to your ${name} ${long ? "long" : "short"}` : `${long ? "Longed" : "Shorted"} ${name}`,
    lev,
  ].filter(Boolean).join(" · ");
  let fillText;
  if (filledSz == null) {
    fillText = "On the book — not filled yet. It shows on the position the moment it fills.";
  } else {
    const at = avgPx == null ? "at market" : `at ${formatHlPrice(avgPx, szDecimals)}`;
    const size = r.partial ? `${r.filled.totalSz} of ${r.size} ${name}` : `${r.filled.totalSz} ${name}`;
    fillText = `Filled ${at} · size ${size}`;
  }
  /* Has the account caught up with this order? */
  const p = position && (position.side === "long" || position.side === "short") && (position.side === "long") === long ? position : null;
  const have = p && fin(p.szi) ? Math.abs(p.szi) : null;
  const want = filledSz == null ? null : Math.abs(fin(priorSz) ? priorSz : 0) + filledSz;
  const caught = !!(have != null && want != null && have >= want * (1 - 1e-6));
  const v = caught ? positionView(p, { szDecimals }) : null;
  const feeOid = r.filled ? r.filled.oid ?? null : null;
  const feeUsdc = feeOfOrder(fills, feeOid);
  const feeAnswered = Array.isArray(fills) || !!(fills && fills.answered === true);
  const feeSettling = feeUsdc == null && (!caught || !feeAnswered);
  const rows = [
    /* 🔴 THE RECEIPT USES THE CARD'S TWO WORDS. This row was labelled "Position
       value" while the figure it printed was the margin — one of the four names
       two quantities carried across these screens. It is the position card's own
       spelling of that figure, so the two cannot disagree, and the size now has
       a row of its own here instead of being left for the reader to infer. */
    { key: "value", label: "Margin", note: v ? v.marginNote : null, text: v ? v.marginText : DASH, unit: v && v.marginUnit === "usdc" ? "usdc" : null, tone: null, settling: !caught },
    { key: "size", label: "Size", text: v ? v.sizeText : DASH, unit: null, tone: null, settling: !caught },
    { key: "pnl", label: v ? v.pnlCaption : "Unrealized P&L", text: v ? `${v.pnlText} ${v.roeText}` : DASH, unit: null, tone: v ? v.pnlTone : null, settling: !caught },
    { key: "entry", label: "Avg. entry", text: v ? v.entryText : DASH, unit: null, tone: null, settling: !caught },
    { key: "liq", label: "Liq. price", text: v ? v.liqText : DASH, unit: null, tone: null, settling: !caught },
    /* 🔴 A DASH UNDER A CHARGE THAT LANDED (owner's own flow, 2026-09-27,
       desktop-3-filled): the ticket had quoted a figure six rows above, the
       balance moved, and this row printed the dash. What that flow could not
       show is why. The development account's own answer carries no order id, so
       no fill of its can ever be matched to it and the row can only ever be the
       dash there. On the exchange the id is real, and an order that crossed the
       book was charged: the row is owed. Its answer also arrives on a
       subscription of its own, a moment apart from the one carrying the
       position — so dropping the row on sight of a dash took it out from under
       the reader on whichever of the two landed first, stepping Set TP/SL and
       everything below it up one row and back down again when the fill arrived.
       The row is therefore dropped only where nothing could ever answer it:
       nothing filled, or no order id to match. Otherwise it stays — the figure
       once it is in, the pulse while it may still land, the dash if the answer
       never carries it. What is NOT done here is print the ticket's own figure
       instead: that one was marked approximate on the screen the reader just
       left, and printing an approximation as paid would be a charge this app
       invented. */
    ...(feeUsdc != null || (filledSz != null && feeOid != null) ? [
      { key: "fee", label: "Fee paid", text: feeUsdc == null ? DASH : usdcNumber(feeUsdc), unit: feeUsdc == null ? null : "usdc", tone: null, settling: feeSettling },
    ] : []),
  ];
  /* 🔴 THE ONE FACT THAT BLOCK WAS CARRYING, IN THE LIST THAT ALREADY
     CARRIES ITS OPPOSITE. The block above the actions went because a trading
     screen carries no warning block (the owner's standing rule), and it was
     also the only thing on this receipt that said nothing is protecting the
     position. The card that spells both legs out is in the DESKTOP RAIL; on the
     phone this receipt fills a sheet over the page, with no card to read behind
     it, and the button below reads the same whether a leg exists or not. So the
     fact stays, as one quiet line in the list that names a leg when one did
     land, and the fright stays gone. Only on a position this order OPENED: on
     an add, what protects it was settled before this order and this answer does
     not carry it. A leg the exchange has not confirmed counts as a leg — it
     probably exists, and the list already says it is unconfirmed. */
  const legs = r.tpsl || {};
  const legLive = (st) => st === "placed" || st === "placed_after_fill" || st === "unverified";
  const unprotected = !adding && filledSz != null && !legLive(legs.tp) && !legLive(legs.sl);
  return {
    ok: true,
    coin,
    title,
    side: long ? "long" : "short",
    tone: long ? "pos" : "neg",
    filled: filledSz != null,
    partial: !!r.partial,
    fillText,
    rows,
    /* 🔴 NO WARNING BLOCK ON A TRADING SCREEN (the owner's standing rule).
       A block used to appear here whenever neither leg had landed, telling the
       reader what a move against them would do. One row below it stands the
       button that sets a leg, so the block was carrying the fright: it is gone,
       and the fact it also carried is a line in cardLines below, which is where
       this receipt says what did and did not happen to a leg. */
    moreLabel: long ? "Buy more" : "Sell more",
    /* 🔴 ONE FACT, ONE PLACE ON THIS CARD. base.lines is what the TOAST reads
       (the page's onTradeDone joins them), and its first line says the fill again
       in other words — measured 2026-09-27 on a real fill: the card printed
       "Filled at $84,087 · size 0.05634 BTC" under the title and, four rows
       lower, "Filled 0.05634 BTC at $84,087". The toast keeps every line,
       because it carries no fillText of its own; the card drops the one it has
       already said. An order left on the book was the same card twice over for
       the same reason, in two spellings of one sentence, and goes the same way. */
    lines: base.lines,
    cardLines: [
      ...(fillText
        ? base.lines.filter((l) => !/^(Filled|Partly filled)\b/.test(l) && !/^The order is on the book\b/.test(l))
        : base.lines),
      ...(unprotected ? ["No take profit or stop loss yet."] : []),
    ],
    warnings: base.warnings,
    warn: base.warn,
    caughtUp: caught,
    settling: !caught || feeSettling,
    shareable: caught,
  };
}

/** What a close did. */
export function closeResultView(r, { szDecimals = null } = {}) {
  if (!r || r.ok !== true) return null;
  const coin = perpCoinLabel(r.coin);
  const lines = [];
  const warnings = [];
  if (r.status === "filled" && r.filled) {
    const at = r.filled.avgPx != null ? ` at ${formatHlPrice(Number(r.filled.avgPx), szDecimals)}` : "";
    lines.push(r.partial ? `Partly closed: ${r.filled.totalSz} of ${r.size} ${coin}${at}` : `Closed ${r.filled.totalSz} ${coin}${at}`);
  } else {
    lines.push("The close is on the book, not filled yet. Check the position.");
  }
  const c = r.cleanup;
  if (c) {
    const n = Array.isArray(c.cancelled) ? c.cancelled.length : 0;
    const bad = Array.isArray(c.failed) ? c.failed.length : 0;
    if (n) lines.push(`${n} TP/SL order${n === 1 ? "" : "s"} cancelled`);
    if (bad) warnings.push(`${bad} TP/SL order${bad === 1 ? "" : "s"} couldn't be cancelled. Cancel ${bad === 1 ? "it" : "them"} from the position page.`);
    if (c.skipped) warnings.push("Couldn't check for leftover TP/SL orders. Look at the position page.");
  }
  return { title: r.closesAll ? `${coin} position closed` : `Closed part of ${coin}`, lines, warnings, warn: warnings.length > 0 };
}

/** What a TP/SL change did. */
export function tpslResultView(r, { szDecimals = null } = {}) {
  if (!r || r.ok !== true) return null;
  const lines = [];
  const warnings = [];
  for (const leg of ["tp", "sl"]) {
    const p = r.placed && r.placed[leg];
    if (p) lines.push(`${LEG_NAME[leg]} set at ${formatHlPrice(Number(p.triggerPx), szDecimals)}`);
    const f = r.failedLegs && r.failedLegs[leg];
    if (f) warnings.push(`${LEG_NAME[leg]} was not set: ${f.message || "try again."}`);
  }
  if (!lines.length && Array.isArray(r.cancelled) && r.cancelled.length) lines.push("TP / SL removed");
  if (r.warning) warnings.push(r.warning);
  else if (Array.isArray(r.cancelFailed) && r.cancelFailed.length) warnings.push("The old TP/SL couldn't be cancelled yet, so both are open. Try again to remove the old one.");
  return { title: "TP / SL updated", lines, warnings, warn: warnings.length > 0 };
}

/* ── withdraw ─────────────────────────────────────────────────────────────── */

/* A typed USDC amount as Hyperliquid's decimal string, or null (never rounded). */
function parseUsdc(raw) {
  const s = String(raw == null ? "" : raw).replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { amount: null, tooPrecise: false };
  let [int, frac = ""] = s.split(".");
  frac = frac.replace(/0+$/, "");
  if (frac.length > HL_USDC_DECIMALS) return { amount: null, tooPrecise: true };
  int = int.replace(/^0+(?=\d)/, "");
  const out = frac ? `${int}.${frac}` : int;
  return { amount: Number(out) > 0 ? out : null, tooPrecise: false };
}

/** Cut (never round) a balance to USDC's 6 decimals: Max can never exceed it. */
function floorUsdc(v) {
  if (!fin(v) || v <= 0) return v === 0 ? "0" : null;
  const [int, frac = ""] = v.toFixed(8).split(".");
  const f = frac.slice(0, HL_USDC_DECIMALS).replace(/0+$/, "");
  return f ? `${int}.${f}` : int;
}

export const WITHDRAW_FACTS = Object.freeze({
  feeUsdc: HL_WITHDRAW_FEE_USDC, chain: HL_WITHDRAW_CHAIN, etaMinutes: HL_WITHDRAW_ETA_MINUTES,
});

/**
 * THE FLOOR THE HYPERLIQUID BRIDGE PUTS UNDER A WITHDRAWAL: its $1 fee, and
 * EXCLUSIVE — an amount equal to the fee pays out nothing. It is this way
 * out's rule, not the screen's: Relay's floor is its own (withdraw.js's
 * RELAY_MIN_WITHDRAW_USDC) and it is inclusive, so the sheet hands the floor
 * of the way out the user picked rather than re-wording this one's refusal
 * afterwards — which refused exactly 1 USDC while telling the user 1 USDC was
 * enough.
 */
export const HL_WITHDRAW_FLOOR = Object.freeze({
  usdc: HL_WITHDRAW_FEE_USDC,
  exclusive: true,
  error: `The amount must be more than the ${HL_WITHDRAW_FEE_USDC} USDC fee.`,
});

/**
 * The withdraw sheet: Max = what can be withdrawn, cut to 6 decimals; the 1
 * USDC Hyperliquid fee; what arrives on Arbitrum One.
 * @param {{ amountStr?: string, withdrawableUsdc?: number|null,
 *   floor?: { usdc: number, exclusive: boolean, error: string } }} o
 */
export function withdrawView({ amountStr = "", withdrawableUsdc = null, floor = HL_WITHDRAW_FLOOR } = {}) {
  const typed = String(amountStr == null ? "" : amountStr).trim();
  const { amount, tooPrecise } = typed ? parseUsdc(typed) : { amount: null, tooPrecise: false };
  const n = amount == null ? null : Number(amount);
  const f = floor && fin(floor.usdc) ? floor : HL_WITHDRAW_FLOOR;
  let error = null;
  if (typed && amount == null) error = tooPrecise ? "USDC takes at most 6 decimals." : "Enter a USDC amount.";
  else if (n != null && (f.exclusive ? n <= f.usdc : n < f.usdc)) error = f.error;
  else if (n != null && fin(withdrawableUsdc) && n > withdrawableUsdc) error = "That's more than you can withdraw right now.";
  return {
    amount: error ? null : amount,
    maxStr: floorUsdc(withdrawableUsdc),
    error,
    feeText: usdcText(HL_WITHDRAW_FEE_USDC),
    receiveText: n != null && !error ? usdcText(Math.round((n - HL_WITHDRAW_FEE_USDC) * 1e6) / 1e6) : DASH,
    chain: HL_WITHDRAW_CHAIN,
    etaMinutes: HL_WITHDRAW_ETA_MINUTES,
  };
}

/* ── events ───────────────────────────────────────────────────────────────── */

/**
 * A toast for a LIVE account event (account layer, events.js), or null. Only a
 * group's lead toasts, so one liquidation seen by three streams is one toast.
 * A trigger fill is named TP or SL from the orders the page knew (triggerKinds:
 * oid -> "tp" | "sl"); any other fill is the ticket's to report.
 */
export function eventToast(e, { triggerKinds = {} } = {}) {
  if (!e || e.lead !== true) return null;
  const on = e.coin ? ` on ${e.coin}` : "";
  switch (e.kind) {
    case "liquidation":
      return { title: `Liquidated${on}`, sub: "Hyperliquid closed the position at its liquidation price.", tone: "neg", icon: "warning", ms: 6500 };
    case "adl":
      return { title: `Auto-deleveraged${on}`, sub: "Hyperliquid reduced the position to cover a liquidation.", tone: "neg", icon: "warning", ms: 6500 };
    case "systemCancel":
      return { title: `Order cancelled by Hyperliquid${on}`, tone: "info", icon: "info" };
    case "order": {
      const oid = e.detail ? e.detail.oid : null;
      const kind = e.status === "filled" && oid != null ? triggerKinds[oid] : null;
      if (kind !== "tp" && kind !== "sl") return null;
      return { title: `${LEG_NAME[kind]} filled${on}`, tone: kind === "tp" ? "pos" : "neg", icon: "check_circle" };
    }
    case "notification":
      return e.text ? { title: "Hyperliquid", sub: e.text, tone: "info", icon: "info" } : null;
    default:
      return null;
  }
}

/** A toast for a MOCK trigger (tp / sl / liquidated), always labelled MOCK. */
export function mockEventToast(e) {
  if (!e || !e.coin) return null;
  if (e.type === "tp") return { title: `MOCK · Take profit hit on ${e.coin}`, tone: "pos", icon: "check_circle" };
  if (e.type === "sl") return { title: `MOCK · Stop loss hit on ${e.coin}`, tone: "neg", icon: "warning" };
  if (e.type === "liquidated") return { title: `MOCK · Liquidated on ${e.coin}`, tone: "neg", icon: "warning" };
  return null;
}
