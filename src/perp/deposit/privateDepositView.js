// The Private Deposit screen's words and decisions, as plain functions (tested in
// Node by scripts/test-private-deposit-ui.mjs, drawn by wallet/DepositPanel.jsx).
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "เริ่มทำหน้าจอ Private mode เลย ฝั่ง Deposit ก่อน" and "เอา ARB,
// Avax, Base, Polygon พอแระ". A "Normal | Private" toggle on Deposit, shown only
// when the server's probe says Private is on (lib/intents/client.js
// readPrivateModeProbe). Normal is today's flow, untouched.
//
// 🔴 HONEST WORDS (plan §4). Without the partner key a quote is "public": the
// public explorer shows sender → recipient. The screen then says "Preview · not
// private yet" and never "Private"; the label is derived from the probe's
// `confidential` and from nothing else.
//
// 🔴 PRIVATE STAYS PRIVATE ON AN ERROR. A failed quote is shown in plain words
// and the customer stays on Private; only their own tap goes back to Normal.
// Falling back by itself would hand them a Normal address (which links their
// wallet to their account) while they think they asked for the other kind.
//
// No React, no network, no clock (the time is an argument).

import { DASH } from "../../lib/format.js";
import { clampPrivateLimits, PRIVATE_ARB_PLAN_ID, PRIVATE_RECOVER_READY } from "../../lib/intents/config.js";
import { privateDepositRoutesOffered, offeredPrivateRoute, rawOf, formatUnitsExact } from "../../lib/intents/assets.js";
import { privateDepositAmount, privateArbGasOk } from "../../lib/intents/deposit.js";
import { IntentsError } from "../../lib/intents/client.js";

export const MODE_NORMAL = "normal";
export const MODE_PRIVATE = "private";

/** The toggle's Tip (plan §4, word for word). */
export const PRIVATE_TIP = "Private makes it harder for people browsing the blockchain to link the wallet you pay from to your trading account. It isn't anonymous, costs a little more, and uses a one-time address.";
/** The preview label: a working route that hides nothing yet (no partner key). */
export const PREVIEW_LABEL = "Preview · not private yet";
export const PREVIEW_NOTE = "Until it's switched on, anyone browsing the blockchain can still see which wallet paid this deposit.";
/** The footer every Private screen carries (plan §4, mandatory). */
export const PRIVATE_FOOTER = "FlowFlow never holds your funds. Every move is signed by your own wallet. Not available to residents of the US, Ontario, or sanctioned countries.";
/** The one-time attestation before the first address (plan §7 guardrail 4). No workaround is ever named. */
export const PRIVATE_ATTEST = "I am not a resident of the US, Ontario, or a sanctioned country, and I am not on a sanctions list.";

/** Is the toggle shown? Only on a clear "on" from the server — or while the customer is ON Private (their way back). */
export function privateToggleShown(probe, mode = MODE_NORMAL) {
  return !!(probe && probe.enabled === true) || mode === MODE_PRIVATE;
}

/** { private, label, tone } for the mode chip: "Private" only when the probe says confidential. */
export function privacyLabel(probe) {
  const yes = !!(probe && probe.enabled === true && probe.confidential === true && probe.confidentiality && probe.confidentiality !== "public");
  return yes ? { private: true, label: "Private", tone: "plain" } : { private: false, label: PREVIEW_LABEL, tone: "warning" };
}

/** The toggle's own label: "Private" only when the chip says so too, never beside "not private yet". */
export function privateToggleLabel(probe) {
  return privacyLabel(probe).private ? "Private" : "Private · preview";
}

/**
 * Does this sentence keep its own words through the Wallet's shim (wallet/words.js
 * customerWords, which folds every account into "your balance")? Only a sentence
 * naming the Spot Account: the owner's own words for where an Avalanche refund
 * lands ("Refunds go to your Spot Account"), a different place from the balance a
 * deposit lands in, so the two must never read the same.
 */
export function keepsOwnWords(s) {
  return typeof s === "string" && /\bSpot Account\b/.test(s);
}

/**
 * Can Recover sign for THIS wallet? Base and Polygon (and the Recover rows) are for
 * it only: PRIVATE_RECOVER_READY is on, and the injected Recover signer (PrivyBridge's,
 * the embedded wallet's) names this very address. Any other wallet — an injected
 * MetaMask or Rabby — would have a refund land on Base or Polygon with no way back
 * in the app, so for it they are not offered (and Normal draws no Recover rows).
 * @param {string|null} user   the connected wallet
 * @param {Function|null} signer  recoverStranded's injected signer (its `address` is the wallet it signs for)
 */
export function recoverReadyFor(user, signer, { ready = PRIVATE_RECOVER_READY } = {}) {
  if (ready !== true || typeof user !== "string" || !user) return false;
  if (typeof signer !== "function" || typeof signer.address !== "string") return false;
  return signer.address.toLowerCase() === user.toLowerCase();
}

/** The origins the picker offers, in order (Base and Polygon only once Recover can sign). */
export function privateChainOptions({ recoverReady } = {}) {
  return recoverReady == null ? privateDepositRoutesOffered() : privateDepositRoutesOffered({ recoverReady });
}

/** The route on screen: the offered one with this id, else the default. */
export function privateRouteFor(routeId, { recoverReady } = {}) {
  return recoverReady == null ? offeredPrivateRoute(routeId) : offeredPrivateRoute(routeId, { recoverReady });
}

const usd = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** "Min 10 · Max 500 per deposit · 1,000 per day (USDC)" from the probe's limits (held to the owner's). */
export function privateLimitsText(limits) {
  const l = clampPrivateLimits(limits);
  return `Min ${usd(l.depositMinUsdc)} · Max ${usd(l.maxTxUsdc)} per deposit · ${usd(l.maxDayUsdc)} per day (USDC)`;
}

/**
 * What was typed, read: { amountRaw, amountUsdc, error } — error is an IntentsError
 * (bad-amount, below-min, over-tx-cap) for a non-empty entry that cannot be quoted,
 * null for an empty one (nothing to say yet). More decimals than the token carries
 * is its own bad-amount (detail.decimals), so the screen can say what is wrong.
 */
export function privateAmountOf(route, text, limits) {
  const t = String(text == null ? "" : text).trim();
  if (!t || !route) return { amountRaw: null, amountUsdc: null, error: null };
  const frac = /^\d*\.(\d+)$/.exec(t);
  if (frac && Number.isInteger(route.decimals) && frac[1].replace(/0+$/, "").length > route.decimals) {
    return { amountRaw: null, amountUsdc: null, error: new IntentsError("bad-amount", `${route.token} has up to ${route.decimals} decimals`, { decimals: route.decimals, token: route.token }) };
  }
  try {
    const { amountRaw, amountUsdc } = privateDepositAmount(route, t, { limits });
    return { amountRaw, amountUsdc, error: null };
  } catch (error) {
    return { amountRaw: null, amountUsdc: null, error };
  }
}

/* Normal's digit rule (perpDepositView feeText, owner 2026-09-28: money on a money
   screen is two decimals): 2, and more only for a figure under a cent, so a real
   fee is never rounded away to 0.00. */
const digitsFor = (v) => (v === 0 ? 2 : v < 0.0001 ? 6 : v < 0.01 ? 4 : 2);

/**
 * "≈ 0.32 USDC"; unknown is the dash, never 0. `floor` rounds DOWN (a guarantee is
 * never printed above what the quote promises): 24.434753 → "24.43".
 */
export function privateUsdcText(v, { approx = true, floor = false } = {}) {
  if (v == null || !Number.isFinite(v) || v < 0) return DASH;
  const d = digitsFor(v);
  /* Down in whole micro-USDC first, so the float never rounds the last digit up. */
  const shown = floor ? Math.floor(Math.round(v * 1e6) / 10 ** (6 - d)) / 10 ** d : v;
  const body = shown.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: d });
  return `${approx ? "≈ " : ""}${body} USDC`;
}

/** The guaranteed floor, for its Tip ("At least 24.43 USDC is guaranteed to arrive, or it is refunded."), or null. */
export function privateMinimumText(q) {
  if (!q || q.minAmountOut == null || !Number.isFinite(q.minAmountOut)) return null;
  return `At least ${privateUsdcText(q.minAmountOut, { approx: false, floor: true })} is guaranteed to arrive, or it is refunded.`;
}

/* ── where a refund lands ────────────────────────────────────────────────────
   A refund goes back to refundTo on the ORIGIN chain: the customer's own wallet.
   On Arbitrum what happens next depends on facts read when the sheet opened, and
   the screen promises only what they support:
     "auto"        the in-app wallet with ETH for the hop (deposit.js privateArbGasOk,
                   the floor private-arb is chosen on): the auto-mover moves it in;
     "needs-gas"   the in-app wallet without it: the mover stops on no-gas, so the
                   money waits in that wallet until there is a little ETH;
     "own-wallet"  any other wallet: the auto-mover never moves for it, so the
                   refund is simply back in the wallet it was paid from.
   The gas balance is the one choosePrivatePlan read (null when unread: not "auto"). */
export const REFUND_AUTO = "auto";
export const REFUND_NEEDS_GAS = "needs-gas";
export const REFUND_OWN_WALLET = "own-wallet";

export function arbitrumRefundPath({ walletType = null, gasWei = null, planId = null } = {}) {
  if (walletType !== "privy") return REFUND_OWN_WALLET;
  if (planId === PRIVATE_ARB_PLAN_ID || privateArbGasOk({ gasWei }) === true) return REFUND_AUTO;
  return REFUND_NEEDS_GAS;
}

/**
 * Where a refund lands, per origin (the route's `refundLands`) and, on Arbitrum,
 * per refund path (arbitrumRefundPath; unknown is the careful "needs-gas"):
 *   Arbitrum   back in the wallet on Arbitrum; moved in only when the mover can
 *   Avalanche  the Spot Account (the same wallet on Avalanche; owner's words)
 *   Base, Polygon  their own wallet there, and Recover moves it in with no gas
 */
export function privateRefundText(route, path = REFUND_NEEDS_GAS) {
  if (!route) return null;
  if (route.refundLands === "auto-move") {
    if (path === REFUND_AUTO) return "If refunded, the money returns to your Main Account automatically.";
    if (path === REFUND_OWN_WALLET) return `If refunded, the money goes back to your own wallet on ${route.chainName}.`;
    return `If refunded, the money goes back to your wallet on ${route.chainName}. Moving it into your Main Account then needs a little ETH there for gas.`;
  }
  if (route.refundLands === "spot") return "Refunds go to your Spot Account.";
  if (route.refundLands === "recover") return `If refunded, the money goes back to your own wallet on ${route.chainName}. Recover moves it into your Main Account with no gas.`;
  return null;
}

/** The address warning's Tip: why a deposit is refunded at all (where it goes is printed: privateRefundText). */
export const LESS_ARRIVES_TIP = "If less than the exact amount arrives (some exchanges take a fee), it isn't credited: it's refunded.";

/** The money warning under the network (a warning, never a Tip). */
export function privateSendOnlyText(route) {
  return route ? `Send only ${route.token} on ${route.chainName}. Other tokens or networks can be lost.` : null;
}

/** "25 USDC": the amount the ADDRESS is bound to (its own base units), else what was typed. */
export function exactAmountText(result, route, amountText = "") {
  const raw = result ? rawOf(result.amountInRaw) : null;
  const dec = route && Number.isInteger(route.decimals) ? route.decimals : null;
  const amt = raw != null && dec != null ? formatUnitsExact(raw, dec) : String(amountText || "").trim() || null;
  return amt ? `${amt} ${route ? route.token : "USDC"}` : null;
}

/** Step 02's title (plan §4), the money-critical instruction: "Send exactly 25 USDC on Arbitrum". */
export function oneTimeAddressTitle(result, route, amountText) {
  if (!route) return "One-time address";
  const amt = exactAmountText(result, route, amountText);
  return amt ? `Send exactly ${amt} on ${route.chainName}` : `Send on ${route.chainName}`;
}

/** The printed warning under the address (a warning, never a Tip); why a refund happens is its Tip (LESS_ARRIVES_TIP). */
export function oneTimeAddressWarning() {
  return "One transfer only. Other tokens or networks can be lost. Don't reuse this address.";
}

/** Step 01 folded once the address is up: "25 USDC · Arbitrum". */
export function privateSummaryText(result, route, amountText) {
  const amt = exactAmountText(result, route, amountText);
  return [amt, route ? route.chainName : null].filter(Boolean).join(" · ");
}

/** What the "used" state prints in place of the address. */
export const ADDRESS_USED_TEXT = "This one-time address has been used. Don't send to it again. Get a new one for another deposit.";
/** Printed once after the customer drops an address they were shown. */
export const ADDRESS_DROPPED_TEXT = "Don't send to the previous address.";

/** Is the address still shown? Only before its showUntil (and only with a time to compare). */
export function addressVisible(result, now) {
  return !!(result && result.depositAddress && Number.isFinite(result.showUntil) && Number.isFinite(now) && now < result.showUntil);
}

const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "16 Oct, 09:14" in the reader's own time zone. */
export function shortTimeText(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * How long the address stays on screen, to showUntil — the moment it leaves, which
 * is before the service's own deadline — in the units a reader can act on:
 *   over a day   "Valid until 18 Oct, 10:30"
 *   1 h to 24 h  "Expires in 5 h 12 min"
 *   under 1 h    "Expires in 12:04"
 * null once past.
 */
export function countdownText(result, now) {
  if (!addressVisible(result, now)) return null;
  const s = Math.floor(Math.max(0, result.showUntil - now) / 1000);
  if (s > 24 * 3600) return `Valid until ${shortTimeText(result.showUntil)}`;
  if (s >= 3600) return `Expires in ${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `Expires in ${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/**
 * The quote's rows, in the order a reader needs them, each a label and a value in
 * the value column; every figure is the quote's own or the dash. What a refund
 * keeps is part of the Fee's Tip, not a second charge on every deposit.
 */
export function privateQuoteRows(q) {
  const v = q || {};
  const lands = v.plan === PRIVATE_ARB_PLAN_ID
    ? "Lands in your wallet on Arbitrum, then moves into your Main Account automatically."
    : "Lands in your Main Account.";
  const min = privateMinimumText(v);
  const rows = [
    { key: "receive", label: "You receive", value: privateUsdcText(v.amountOut), tip: q ? [lands, min].filter(Boolean).join(" ") : null, strong: true },
    { key: "fee", label: "Fee", value: privateUsdcText(v.feeUsdc), tip: Number.isFinite(v.refundFeeUsdc) ? `If the deposit is refunded, ${privateUsdcText(v.refundFeeUsdc, { approx: false })} is kept.` : null },
    { key: "time", label: "Arrives in", value: Number.isFinite(v.timeEstimateSec) && v.timeEstimateSec >= 0 ? (v.timeEstimateSec < 60 ? `~${Math.round(v.timeEstimateSec)}s` : `~${Math.round(v.timeEstimateSec / 60)} min`) : DASH },
  ];
  return rows;
}

/**
 * 🔴 THE FIGURES ON SCREEN ARE THE ONES THE SHOWN ADDRESS IS BOUND TO. Before
 * "Get address" they are the dry quote's (nothing is reserved yet); once an
 * address is up they are that address's own quote (its amountOut and its
 * guarantee, which may differ from the dry one), and while any error is shown
 * they are the dash. Returns the quote to draw, or null for dashes.
 */
export function privateFiguresOf({ quote = null, address = null } = {}) {
  if (address && address.status === "ready") return address.data || null;
  if ((address && address.status === "error") || (quote && quote.status === "error")) return null;
  return quote && quote.status === "ready" ? quote.data || null : null;
}

/**
 * What step 02 draws, from the address state and the watch:
 *   "loading" | "error" | "used" (a row was seen: the address is spent) |
 *   "expired" (past showUntil) | "address" (QR, copy, countdown) | null (nothing yet)
 * "used" wins over "address" and "expired": a spent one-time address is never
 * offered again, whatever its clock says.
 */
export function addressStepOf({ status = "idle", visible = false, expired = false, used = false } = {}) {
  if (status === "loading") return "loading";
  if (status === "error") return "error";
  if (status !== "ready") return null;
  if (used) return "used";
  if (expired || !visible) return "expired";
  return "address";
}

/* The errors that are about the AMOUNT: said under the amount field, fixed by changing it. */
const AMOUNT_ERRORS = Object.freeze(["bad-amount", "below-min", "over-tx-cap", "over-day-cap"]);

/** Where an error is drawn: "amount" (under the field) or "box" (in the quote or address step). */
export function privateErrorPlace(error) {
  return error && AMOUNT_ERRORS.includes(error.code) ? "amount" : "box";
}

/**
 * The buttons beside an error drawn in a box, first = the stronger (outline) one:
 *   "normal"  Use Normal deposit (the customer's own tap; never automatic)
 *   "retry"   Try again
 * Normal comes first when Private is off or the route is paused.
 */
export function privateErrorActions(error) {
  const c = error && error.code;
  if (c === "private-mode-off" || pairPaused(error)) return ["normal", "retry"];
  if (c === "sanctioned") return [];
  return ["retry", "normal"];
}

/** Is this the service saying the route itself is not quoting right now? */
export function pairPaused(error) {
  return !!(error && /pair is not available|not available for this pair/i.test(String(error.message || "")));
}

/* ── the sheet's mode and its one rule ──────────────────────────────────────
   One reducer, so the rule "an error never moves the customer off Private" is a
   property of the state, not of each place an error can arrive. */

export const PRIVATE_SHEET_START = Object.freeze({ mode: MODE_NORMAL, error: null, errorAt: null });

/**
 * actions:
 *   { type: "choose", mode }   the customer's own tap (the ONLY way the mode changes)
 *   { type: "error", error }   a quote or address failed: shown, mode kept
 *   { type: "clear" }          the error is no longer current
 *   { type: "probe", probe }   a probe answer: the mode is kept (an "off" answer shows
 *                              its own message on Private; the customer chooses Normal)
 */
export function privateSheetReducer(state = PRIVATE_SHEET_START, action = {}) {
  const s = state || PRIVATE_SHEET_START;
  switch (action.type) {
    case "choose":
      return action.mode === MODE_PRIVATE || action.mode === MODE_NORMAL ? { ...s, mode: action.mode, error: null } : s;
    case "error":
      return { ...s, error: action.error || null, errorAt: action.at ?? null };
    case "clear":
      return s.error ? { ...s, error: null } : s;
    case "probe":
      return s;
    default:
      return s;
  }
}

/** The watch has seen this address used: forget the saved one so it is never offered again. */
export function addressUsed(rows) {
  return Array.isArray(rows) && rows.some((r) => r && typeof r.id === "string");
}
