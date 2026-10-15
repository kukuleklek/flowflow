// The Private Withdraw screen's words and decisions, as plain functions (tested in
// Node by scripts/test-private-withdraw-ui.mjs, drawn by wallet/WithdrawPanel.jsx).
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: the "Normal | Private" toggle, on Withdraw as on Deposit, and
// "เอา ARB, Avax, Base, Polygon พอแระ". The toggle, its label and the one rule
// that an error never moves the customer off Private are the Deposit's own
// (perp/deposit/privateDepositView.js, re-exported below): one set of rules for
// both sides. Normal is today's withdrawal, untouched.
//
// THE ROUTE (lib/intents/withdraw.js): the Perp USDC goes, in ONE visible
// signature, to a one-time address a REAL quote reserves; the service pays the
// address the customer TYPED, on the chain they picked. The real quote is asked
// for only on the customer's own press of "Review withdrawal".
//
// 🔴 HONEST WORDS. "Private" only when the probe says confidential AND the quote
// itself came back confidential; otherwise "Preview · not private yet".
//
// 🔴 THE ACTIVATION FEE (owner, commit 27f3a4a, and measured read-only 2026-10-15).
// Hyperliquid takes 1 USDC on top of a transfer when it ACTIVATES an address: the
// sender's own, on its first transfer out after a bridge deposit, or a new
// destination's. Its preTransferCheck reports the figure for exactly this
// transfer (source = the customer, user = the one-time address): 1.0 for a fresh
// destination whatever the source, 1.0 for an unactivated source to an activated
// destination, 0.0 only when both are activated — and 1.0, not 2.0, when both
// are new. A one-time address is always new, so a private withdrawal pays it
// EVERY time; the screen prints it as its own row and holds Confirm until it
// stays behind (readWithdrawPreflight's "insufficient"). The form already
// leaves the most it can be (1 USDC) behind, so a real address is not
// reserved for an amount that could not be sent.
//
// No React, no network, no clock (the time is an argument).

import { DASH } from "../../lib/format.js";
import { clampPrivateLimits } from "../../lib/intents/config.js";
import {
  PRIVATE_WITHDRAW_ROUTES, DEFAULT_PRIVATE_WITHDRAW_ROUTE_ID, privateWithdrawRouteById, validatePrivateDestination,
  parsePrivateWithdrawAmount, MAX_ACCOUNT_FEE_USDC, unitsToDecimal,
} from "../../lib/intents/withdraw.js";
import { inAppWithdrawCaution } from "../../lib/relay/withdraw.js";
import { privateAmountText } from "../../lib/signCopy.js";
import { privacyLabel, pairPaused, PREVIEW_LABEL } from "../deposit/privateDepositView.js";

export {
  MODE_NORMAL, MODE_PRIVATE, PRIVATE_SHEET_START, privateSheetReducer, privateToggleShown, privateToggleLabel, privacyLabel,
  PREVIEW_LABEL, PREVIEW_NOTE, PRIVATE_FOOTER, PRIVATE_ATTEST,
} from "../deposit/privateDepositView.js";
export { privateAmountText };

/** The most the activation fee can be (lib/intents/withdraw.js refuses a higher one): what the form leaves behind. */
export const ACTIVATION_RESERVE_USDC = MAX_ACCOUNT_FEE_USDC;

/** The toggle's Tip on Withdraw (the Deposit's, for money going out; plan §4 wording), with what each one costs on top. */
export const PRIVATE_WITHDRAW_TIP = `Private makes it harder for people browsing the blockchain to link your trading account to the address you withdraw to. It isn't anonymous, and each one costs ${privateAmountText(ACTIVATION_RESERVE_USDC)} more (an activation fee).`;
export const PRIVATE_WITHDRAW_PREVIEW_NOTE = "Until it's switched on, anyone browsing the blockchain can still see which account paid this withdrawal.";

/** The activation row's Tip: what it is and why every private withdrawal pays it ("on top" is the printed total row). */
export const ACTIVATION_TIP = "The trading network charges 1 USDC to activate a new address. Every private withdrawal uses a new one-time address, so every one pays it.";
/** The screening row's Tip. */
export const SCREEN_TIP = "Your account, the address you entered and the one-time address were each checked against sanctions lists before anything could be signed.";
/** How the one signature goes (a Tip under Confirm, like Normal's). */
export const HOW_IT_WORKS = "One signature in your wallet: the transfer to a one-time address, which then pays the address you entered.";

/* ── the chains ──────────────────────────────────────────────────────────── */

/** The destinations offered, in the owner's order: exactly Base, Avalanche, Arbitrum and Polygon USDC. */
export function privateWithdrawChains() {
  return PRIVATE_WITHDRAW_ROUTES.filter((r) => r.enabled === true);
}

/** The offered route with this id, else the default (a disabled or unknown id is never handed out). */
export function privateWithdrawRouteFor(id) {
  const r = privateWithdrawRouteById(id);
  return r && r.enabled === true ? r : privateWithdrawRouteById(DEFAULT_PRIVATE_WITHDRAW_ROUTE_ID);
}

/* ── amounts ─────────────────────────────────────────────────────────────── */

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const count = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
const micro = (n) => BigInt(Math.round(n * 1e6));
/* Whole cents at or under a micro-USDC figure, as a number. */
const centsDown = (m) => Number(((m < 0n ? 0n : m) / 10_000n).toString()) / 100;

/** "Min 5 · Max 500 per withdrawal · 1,000 per day (USDC)" from the probe's limits (held to the owner's). */
export function privateWithdrawLimitsText(limits) {
  const l = clampPrivateLimits(limits);
  return `Min ${count(l.withdrawMinUsdc)} · Max ${count(l.maxTxUsdc)} per withdrawal · ${count(l.maxDayUsdc)} per day (USDC)`;
}

/**
 * "Withdrawable" as the header prints it: whole cents, rounded DOWN (never a cent
 * more than can leave), drawn two-decimal like Normal's; null when unknown.
 */
export function privateWithdrawableShown(withdrawableUsdc) {
  if (!fin(withdrawableUsdc) || withdrawableUsdc < 0) return null;
  return centsDown(micro(withdrawableUsdc));
}

/**
 * The Max button's figure: what can leave with the activation fee still behind,
 * in whole cents, held to the per-withdrawal cap; null when it is unknown or
 * below the minimum (nothing to offer).
 */
export function privateWithdrawMaxUsdc(withdrawableUsdc, limits) {
  if (!fin(withdrawableUsdc) || withdrawableUsdc <= 0) return null;
  const l = clampPrivateLimits(limits);
  const max = Math.min(l.maxTxUsdc, centsDown(micro(withdrawableUsdc) - micro(ACTIVATION_RESERVE_USDC)));
  return max >= l.withdrawMinUsdc ? max : null;
}

/**
 * What was typed, read for a private withdrawal:
 *   { ok, units, hl, usdc, error: null | { code, text } }
 * error is null for an empty entry (nothing to say yet). The amount leaves 1 USDC
 * of activation behind (ACTIVATION_RESERVE_USDC) when the balance is known.
 */
export function privateWithdrawAmountOf(text, { limits = null, withdrawableUsdc = null } = {}) {
  const t = String(text == null ? "" : text).trim();
  const none = { ok: false, units: null, hl: null, usdc: null, error: null };
  if (!t) return none;
  const p = parsePrivateWithdrawAmount(t);
  if (!p.ok) return { ...none, error: { code: "bad-amount", text: p.error } };
  const l = clampPrivateLimits(limits);
  const err = (code, msg) => ({ ...none, units: p.units, hl: p.hl, usdc: p.usdc, error: { code, text: msg } });
  if (p.usdc < l.withdrawMinUsdc) return err("below-min", `The smallest private withdrawal is ${count(l.withdrawMinUsdc)} USDC.`);
  if (p.usdc > l.maxTxUsdc) return err("over-tx-cap", `The largest private withdrawal is ${count(l.maxTxUsdc)} USDC.`);
  if (fin(withdrawableUsdc)) {
    const have = micro(withdrawableUsdc);
    const want = BigInt(p.units) / 100n;
    if (want > have) return err("over-balance", "That's more than you can withdraw.");
    /* The most that fits is the button under it (privateWithdrawAmountFix), so the sentence does not repeat it. */
    if (want + micro(ACTIVATION_RESERVE_USDC) > have) {
      return err("activation-reserve", `Leave ${privateAmountText(ACTIVATION_RESERVE_USDC)} in your balance for the activation fee.`);
    }
  }
  return { ok: true, units: p.units, hl: p.hl, usdc: p.usdc, error: null };
}

/**
 * The line under the amount field: the limits, or — once Max filled the most that
 * can leave with the activation fee behind — why that is less than "Withdrawable".
 */
export function privateWithdrawAmountNote({ amountText = "", withdrawableUsdc = null, limits = null } = {}) {
  const max = privateWithdrawMaxUsdc(withdrawableUsdc, limits);
  if (max != null && String(amountText).trim() === max.toFixed(2)) {
    const l = clampPrivateLimits(limits);
    /* Only when the fee is what holds it down (not the per-withdrawal cap). */
    if (centsDown(micro(withdrawableUsdc) - micro(ACTIVATION_RESERVE_USDC)) <= l.maxTxUsdc) {
      return `${privateAmountText(ACTIVATION_RESERVE_USDC)} stays behind for the activation fee.`;
    }
  }
  return privateWithdrawLimitsText(limits);
}

/**
 * The one-tap smaller amount under an amount refusal, when one would fit:
 * { usdc, text } ("Withdraw 19.50 USDC instead") or null.
 *   activation-reserve  the most that can leave with the fee behind (Max's figure)
 *   over-day-cap        what the day cap still allows (the server's own `left`), held to Max's figure too
 */
export function privateWithdrawAmountFix(error, { withdrawableUsdc = null, limits = null } = {}) {
  const c = error && error.code;
  const l = clampPrivateLimits(limits);
  const max = privateWithdrawMaxUsdc(withdrawableUsdc, l);
  let usdc = null;
  if (c === "activation-reserve") usdc = max;
  else if (c === "over-day-cap" && error.detail && fin(error.detail.left) && error.detail.left > 0) {
    const left = Math.min(l.maxTxUsdc, centsDown(micro(error.detail.left)));
    usdc = max == null && fin(withdrawableUsdc) ? null : max == null ? left : Math.min(left, max);
  }
  if (usdc == null || !fin(usdc) || usdc < l.withdrawMinUsdc) return null;
  return { usdc, text: `Withdraw ${usdc.toFixed(2)} USDC instead` };
}

/**
 * The amount the Private form lowers itself to when it would not leave the activation fee behind (every private
 * withdrawal pays it): the most that can go, only ever LOWER than typed. Null otherwise (other refusals keep their
 * own tap, e.g. today's limit).
 */
export function privateWithdrawAutoAmount(error, { amountText = "", withdrawableUsdc = null, limits = null } = {}) {
  if (!error || error.code !== "activation-reserve") return null;
  const fix = privateWithdrawAmountFix(error, { withdrawableUsdc, limits });
  const typed = Number(String(amountText).trim());
  return fix && fin(typed) && fix.usdc < typed ? fix.usdc : null;
}

/** The quiet line under an amount the Private form lowered. */
export const privateWithdrawAdjustedText = (usdc) =>
  `Adjusted to ${usdc.toFixed(2)}: ${privateAmountText(ACTIVATION_RESERVE_USDC)} stays behind for the activation fee, paid on every private withdrawal.`;

/* ── the destination ─────────────────────────────────────────────────────── */

/** The caution under the customer's own wallet typed as the destination (the panel offers "Use Normal withdraw" beside it). */
export const OWN_WALLET_CAUTION = "That's your own FlowFlow wallet, so Private hides nothing here.";
/** The in-app wallet on Arbitrum: the auto-mover puts it straight back, so the trip only costs the fees. */
export const OWN_ARBITRUM_REFUSAL = "On Arbitrum this lands straight back in your balance, minus the fees. Pick another address.";

/**
 * The address typed, checked for the route (lib/intents/withdraw.js: EIP-55, no
 * zero or burn address), as EXACTLY what was typed: { ok, address, error, caution, own }.
 * The customer's own wallet is allowed with one short caution (it gains no
 * privacy; `own` lets the panel offer Normal beside it), except the in-app wallet
 * on Arbitrum: there the money moves straight back into the balance, so it is
 * refused rather than charged a fee and an activation for nothing.
 */
export function privateWithdrawDestinationOf(text, route, { own = null, walletType = null } = {}) {
  const d = validatePrivateDestination(text, route, { own });
  if (!d.ok) return { ok: false, address: d.address, error: d.empty ? null : d.error, caution: null, own: false };
  if (!d.isOwn) return { ok: true, address: d.address, error: null, caution: null, own: false };
  const inApp = !!inAppWithdrawCaution({ address: d.address, wallet: own, walletType });
  if (inApp && route && route.id === "arbitrum-usdc") return { ok: false, address: d.address, error: OWN_ARBITRUM_REFUSAL, caution: null, own: true };
  return { ok: true, address: d.address, error: null, caution: OWN_WALLET_CAUTION, own: true };
}

/* ── the label ───────────────────────────────────────────────────────────── */

/**
 * { private, label } for the chip: "Private" only when the probe is confidential
 * AND (once there is one) the quote came back confidential too.
 */
export function privateWithdrawPrivacy({ probe = null, quote = null } = {}) {
  const p = privacyLabel(probe);
  if (!p.private || (quote && quote.private !== true)) return { private: false, label: PREVIEW_LABEL, tone: "warning" };
  return p;
}

/* ── the review ──────────────────────────────────────────────────────────── */

const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** "~34s", "~2 min", or the dash. */
export function arrivesText(sec) {
  if (!fin(sec) || sec < 0) return DASH;
  return sec < 60 ? `~${Math.round(sec)}s` : `~${Math.round(sec / 60)} min`;
}

/** The screening row's value: "Passed" only on a verified quote whose preflight read the one-time address as clear. */
export function screeningText(preflight) {
  if (!preflight) return DASH;
  if (preflight.isSanctioned === true || preflight.code === "sanctioned") return "Refused";
  return preflight.isSanctioned === false ? "Passed" : DASH;
}

/* The Deposit's rows (privateDepositView privateQuoteRows): the guaranteed floor rides in the receive row's Tip and
   the refund fee in the Fee row's, so neither reads as a charge of its own. */
function receiveTip(q, chain, token, where = "below") {
  const at = chain ? `On ${chain}, at the address ${where === "below" ? "below" : "you entered"}.` : null;
  const min = q.minReceive != null && privateAmountText(q.minReceive) !== DASH
    ? `At least ${privateAmountText(q.minReceive, { floor: true, symbol: token })} arrives, or it's refunded to your balance.` : null;
  return [at, min].filter(Boolean).join(" ") || null;
}
const feeTip = (q) => (q.refundFeeUsdc != null && privateAmountText(q.refundFeeUsdc) !== DASH ? `If it's refunded, ${privateAmountText(q.refundFeeUsdc)} is kept.` : null);

/**
 * The review's rows, in the order a reader needs them, each { key, label, value,
 * tip?, strong? }; every figure is the verified quote's or the preflight's, or
 * the dash (never 0):
 *   You send · You receive · Fee · [Activation fee · From your balance] · Arrives in
 * The activation row is there when it applies (a fee above 0) or when it could not
 * be read (the dash, and Confirm is held), and then "From your balance" prints
 * what leaves: the amount plus that fee, taken on top. The screening is a row only
 * when it refused (the refusal box says why); passing it is not news.
 * @param {{ quote: object, review: object|null, preflight: object|null }} o
 */
export function privateWithdrawRows({ quote = null, review = null, preflight = null } = {}) {
  const q = quote || {};
  const r = review || {};
  const chain = q.route && q.route.chainName ? q.route.chainName : r.chainName || null;
  const token = q.route && q.route.token ? q.route.token : "USDC";
  const fee = num(r.accountFeeUsdc);
  const feeUnread = preflight && fee == null;
  const sent = num(q.amountUsdc);
  const rows = [
    { key: "send", label: "You send", value: privateAmountText(q.amountUsdc) },
    { key: "receive", label: "You receive", value: privateAmountText(q.receive, { approx: true, symbol: token }), strong: true, tip: receiveTip(q, chain, token) },
    { key: "fee", label: "Fee", value: privateAmountText(q.serviceFeeUsdc), tip: feeTip(q) },
  ];
  if ((fee != null && fee > 0) || feeUnread) {
    rows.push(
      { key: "activation", label: "Activation fee", value: fee == null ? DASH : privateAmountText(fee), tip: ACTIVATION_TIP },
      { key: "total", label: "From your balance", value: fee != null && sent != null ? privateAmountText(leavesOf(sent, fee)) : DASH, strong: true },
    );
  }
  rows.push({ key: "time", label: "Arrives in", value: arrivesText(q.timeEstimateSec) });
  if (screeningText(preflight) === "Refused") rows.push({ key: "screen", label: "Sanctions check", value: "Refused", tip: SCREEN_TIP });
  return rows;
}

/** The dry quote's rows under the form: the activation is the 1.00 USDC every private withdrawal pays. */
export function privateWithdrawDryRows(quote) {
  const q = quote || null;
  const token = q && q.route && q.route.token ? q.route.token : "USDC";
  const chain = q && q.route ? q.route.chainName : null;
  return [
    { key: "receive", label: "You receive", value: q ? privateAmountText(q.receive, { approx: true }) : DASH, strong: true, tip: q ? receiveTip(q, chain, token, "entered") : null },
    { key: "fee", label: "Fee", value: q ? privateAmountText(q.serviceFeeUsdc) : DASH, tip: q ? feeTip(q) : null },
    { key: "activation", label: "Activation fee", value: q ? privateAmountText(ACTIVATION_RESERVE_USDC) : DASH, tip: ACTIVATION_TIP },
    { key: "time", label: "Arrives in", value: q ? arrivesText(q.timeEstimateSec) : DASH },
  ];
}

/* The amount plus the activation fee, to the micro-USDC (what leaves the balance). */
function leavesOf(amountUsdc, feeUsdc) {
  return Math.round((amountUsdc + (fin(feeUsdc) ? feeUsdc : 0)) * 1e6) / 1e6;
}

/**
 * The "it has to stay behind" rule on the review: { applies, feeUsdc, short, maxUsdc, text }.
 *   applies  the preflight read an activation fee above 0
 *   short    the preflight refused because amount + fee is more than can be withdrawn
 *   maxUsdc  the most that can leave with the fee behind (whole cents), when it is at least the minimum
 */
export function privateWithdrawActivation({ preflight = null, withdrawableUsdc = null, limits = null } = {}) {
  const fee = preflight ? num(preflight.accountFeeUsdc) : null;
  const applies = fee != null && fee > 0;
  const short = !!(preflight && preflight.code === "insufficient");
  const have = fin(withdrawableUsdc) ? withdrawableUsdc : preflight && fin(preflight.withdrawableUsdc) ? preflight.withdrawableUsdc : null;
  const l = clampPrivateLimits(limits);
  let maxUsdc = null;
  if (short && have != null && fee != null) {
    const m = Math.min(l.maxTxUsdc, centsDown(micro(have) - micro(fee)));
    maxUsdc = m >= l.withdrawMinUsdc ? m : null;
  }
  /* The smaller amount is the button under it ("Withdraw X instead"), so the sentence does not repeat it. */
  const text = short ? `The ${privateAmountText(fee)} activation fee has to stay in your balance.` : null;
  return { applies, feeUsdc: fee, short, maxUsdc, text };
}

/* ── the refusals, in plain words ────────────────────────────────────────── */

/* Codes whose own (already plain) message is the best sentence. */
const OWN_MESSAGE = Object.freeze([
  "bad-amount", "bad-recipient", "route-off", "wrong-journal", "no-journal", "registry", "used", "unsettled",
  "check-unknown", "fee-unknown", "balance-unknown", "fee-high", "bad-deposit-address", "stale-quote", "recheck",
  "amount_mismatch", "bad-quote",
]);

/**
 * One refusal (an IntentsError from a quote, a preflight refusal, or an executor
 * answer), in the customer's words. Never names the provider; sanctions in
 * plan §4's words with no workaround.
 */
export function privateWithdrawErrorText(error, { chainName = null, now = null } = {}) {
  const c = error && error.code;
  const d = (error && error.detail) || {};
  const msg = error && typeof error.message === "string" ? error.message : "";
  if (c === "private-mode-off") return "Private withdrawals are off right now. Use Normal withdraw, or try again later.";
  if (c === "sanctioned") return "This withdrawal can't go through Private. Your account or the address you entered appears on a sanctions or stolen-funds list. Contact support if you think this is a mistake.";
  if (c === "screen-unavailable") return "The safety check couldn't run just now. Try again in a minute.";
  if (c === "below-min") return `The smallest private withdrawal is ${fin(d.min) ? count(d.min) : 5} USDC.`;
  if (c === "over-tx-cap") return `The largest private withdrawal is ${fin(d.max) ? count(d.max) : 500} USDC.`;
  if (c === "over-day-cap") {
    /* This browser's own record counts the last 24 hours; the server counts the UTC day, said in the reader's time. */
    if (d.rolling === true) {
      if (fin(d.left) && d.left > 0) return `Over the private limit for the last 24 hours. You can withdraw up to ${privateAmountText(d.left)} more privately now.`;
      return "You've reached the private limit for the last 24 hours. Try again later.";
    }
    const reset = shortTimeText(nextUtcMidnight(now)) || "00:00 UTC";
    if (fin(d.left) && d.left > 0) return `Over today's private limit. You can withdraw up to ${privateAmountText(d.left)} more privately today (resets ${reset}).`;
    if (fin(d.left)) return `You've reached today's private limit. Try again after ${reset}.`;
    return msg || "Over today's private limit. Try a smaller amount, or tomorrow.";
  }
  if (c === "confidentiality-mismatch") return "The privacy setting just changed. Check the label above and try again.";
  if (c === "rate-limited") return "Too many requests. Wait a minute and try again.";
  if (c === "testnet-off") return "Withdrawals work on mainnet only.";
  if (c === "bad-user" || c === "not-connected") return "Connect a wallet first.";
  if (c === "intents-error" && pairPaused(error)) return `Private withdrawals${chainName ? ` to ${chainName}` : ""} are paused right now. Try again later, or use Normal withdraw.`;
  if (c === "intents-error") return msg ? `Couldn't get a private quote: ${msg}` : "Couldn't get a private quote. Try again.";
  if (c === "network") return "Couldn't reach the withdrawal service. Check your connection and try again.";
  if (c === "unsafe-quote") return "The quote didn't check out, so nothing was signed. Try again.";
  if (c === "bad-response") return "The answer wasn't readable, so nothing was signed. Try again.";
  if (c === "insufficient") return "That's more than you can withdraw once the activation fee is included.";
  /* The network's own refusal when the activation fee can't stay behind (Normal's wallet/words.js says it for the
     first withdrawal; on Private it is every withdrawal). It refused: nothing moved. */
  if (c === "hl_error" && /token transfer gas/i.test(msg)) return `Leave ${privateAmountText(ACTIVATION_RESERVE_USDC)} in your balance for the activation fee, then try again. Nothing was sent.`;
  if (c === "not_confirmed" || (error && error.notConfirmed)) return "Your withdrawal wasn't confirmed. Check your balance before trying again: it was NOT sent twice.";
  if (OWN_MESSAGE.includes(c) && msg) return msg;
  return msg || "Couldn't do that just now. Nothing was sent.";
}

/* The refusals that are about the AMOUNT: said under the amount field, fixed by changing it. */
const AMOUNT_ERRORS = Object.freeze(["bad-amount", "below-min", "over-tx-cap", "over-day-cap"]);

/** Where a refusal is drawn: "amount" (under the field) or "box" (under the price). */
export function privateWithdrawErrorPlace(error) {
  return error && AMOUNT_ERRORS.includes(error.code) ? "amount" : "box";
}

/**
 * The buttons beside a refusal shown in a box, the stronger first:
 *   "normal"  Use Normal withdraw (the customer's own tap; never automatic)
 *   "retry"   Try again
 * None for sanctions (no workaround) and for "unsettled" (it settles by itself).
 */
export function privateWithdrawErrorActions(error) {
  const c = error && error.code;
  if (c === "sanctioned" || c === "unsettled") return [];
  if (c === "private-mode-off" || pairPaused(error)) return ["normal", "retry"];
  return ["retry", "normal"];
}

/* ── after the signature ─────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "16 Oct, 09:14" in the reader's own time zone, or null. */
export function shortTimeText(ms) {
  if (!fin(ms)) return null;
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next 00:00 UTC after `now` (the server's day cap resets then), or null without a clock. */
export function nextUtcMidnight(now) {
  if (!fin(now)) return null;
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * The result screen, from where the money step ended ("sent" | "unknown") and the
 * status follow-up's last reading (withdrawStatus.js, folded and CHECKED):
 *   { state, title, line?, note?, tone: "done"|"wait"|"warn"|"bad" }
 * A reading that names another withdrawal (mismatch) is never "arrived".
 */
export function privateWithdrawResultView({ phase, snapshot = null, journalState = null, chainName = null, refundStartsAt = null, leavesUsdc = null } = {}) {
  const s = snapshot && !snapshot.mismatch ? snapshot.status : null;
  /* The line under the title already names the chain. */
  if (s === "arrived" || journalState === "arrived") return { state: "arrived", title: "Arrived", tone: "done" };
  if (s === "refunded" || journalState === "refunded") return { state: "refunded", title: "Refunded", note: "It was sent back to your balance.", tone: "warn" };
  if (s === "failed" || journalState === "failed") return { state: "failed", title: "Couldn't be completed", note: "Your USDC is being returned to your balance.", tone: "bad" };
  if (s === "incomplete" || journalState === "incomplete") {
    const when = shortTimeText(refundStartsAt);
    return { state: "incomplete", title: "Less than expected", note: `Less than the quoted amount reached the one-time address, so it isn't delivered: it's refunded to your balance${when ? ` after ${when}` : ""}.`, tone: "warn" };
  }
  if (journalState === "not-sent" || journalState === "expired") return { state: "not-sent", title: "Not sent", note: "It never left your balance. You can start a new withdrawal.", tone: "warn" };
  if (s === "arriving" || journalState === "arriving" || journalState === "sent") return { state: "moving", title: "On its way", tone: "wait" };
  if (phase === "unknown") {
    /* 🔴 The figure to check is what LEAVES the balance (the amount plus the activation fee, taken on top), never the
       figure that arrives: a customer comparing the wrong one concludes it didn't go and sends it again. */
    const leaves = fin(leavesUsdc) && leavesUsdc > 0 ? privateAmountText(leavesUsdc) : null;
    return {
      state: "unknown", title: "Not confirmed", tone: "warn",
      note: `It may have gone through. Don't withdraw again yet: if your balance dropped by ${leaves || "this withdrawal and its activation fee"}, it went. We keep checking.`,
    };
  }
  return { state: "moving", title: "On its way", tone: "wait" };
}

/** A journal record's state, in words, for the rows of earlier private withdrawals. */
export function journalStateText(state) {
  switch (state) {
    case "claimed":
    case "unknown": return "Not confirmed yet";
    case "sent": return "Sent";
    case "arriving": return "On its way";
    case "incomplete": return "Less than expected · being refunded";
    case "arrived": return "Arrived";
    case "refunded": return "Refunded";
    case "failed": return "Couldn't be completed";
    case "not-sent": return "Not sent";
    case "expired": return "Not sent · expired";
    default: return "Checking…";
  }
}

/** A record's amount ("20.00 USDC") from its 8-decimal units, or the dash. */
export function journalAmountText(record) {
  try { return privateAmountText(Number(unitsToDecimal(record.amountRaw, 8))); } catch { return DASH; }
}

/** The records worth showing on the form: not settled for good yet (unsettled, sent, on its way, incomplete). */
export const IN_FLIGHT_STATES = Object.freeze(["claimed", "unknown", "sent", "arriving", "incomplete"]);

/**
 * What a journal record took out of the balance if it went: its amount plus the
 * activation fee its preflight read (taken on top; owner's live test T3 confirms
 * on top vs out of the amount — if out of it, this is the amount alone). null when
 * the amount is unreadable.
 */
export function journalLeavesUsdc(record) {
  let amount = null;
  try { amount = Number(unitsToDecimal(record.amountRaw, 8)); } catch { amount = null; }
  if (!fin(amount)) return null;
  const fee = num(record && record.accountFeeUsdc);
  return leavesOf(amount, fee != null && fee > 0 ? fee : 0);
}

/**
 * The block an unsettled private withdrawal puts on the next one, in plain words
 * (the journal's rule: claimed or unknown blocks until reads settle it or its
 * address is past its deadline). null when nothing blocks. The figure is what
 * would have LEFT the balance (journalLeavesUsdc). `normal`: said on Normal, where
 * the risk is sending the same money again another way.
 */
export function unsettledBlockText(records, { normal = false } = {}) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return null;
  const r = list[0];
  const leaves = journalLeavesUsdc(r);
  const amt = leaves != null ? privateAmountText(leaves) : journalAmountText(r);
  const when = shortTimeText(r.createdAt);
  const at = when ? ` (${when})` : "";
  if (normal) return `A private withdrawal of ${amt}${at} isn't confirmed yet. If your balance dropped by ${amt}, it went: don't send it again.`;
  return `Your private withdrawal of ${amt}${at} isn't confirmed yet. If your balance dropped by ${amt}, it went. A new private withdrawal waits until we know.`;
}
