// The Perp Deposit sheet's words and figures, as plain functions (tested in Node
// by scripts/test-relay-deposit-sheet.mjs, rendered by PerpDepositSheet.jsx).
//
// The rules are written for someone about to send money from an exchange or
// another wallet: short, concrete, one fact per line, the route's own token and
// network named in each. They are not caveats about a figure; each one is a way
// to lose or delay a deposit.
//
// MONEY_RULES: an unknown fee, time or amount is the dash, never 0.

import { DASH } from "../../lib/format.js";
import { NOMINAL_DEPOSIT, DEPOSIT_FEE_SIZES, DEPOSIT_CHAINS } from "../../lib/relay/routes.js";
import { FIRST_HOP_PLAN_ID, TOPUP_GAS_USD, TOPUP_MAX_SHARE } from "../../lib/relay/firstDeposit.js";
import { DIRECT_PLAN, ACTIVATION_FLOOR_USDC } from "../../lib/relay/depositAddress.js";
import { PRIVATE_ARB_PLAN_ID } from "../../lib/intents/config.js";

/* 🔴 OUR OWN PRODUCT FLOOR, and the ONLY minimum this screen names.
   Owner, 2026-09-23: "โชว์ MINIMUM Deposit 5 usdc แค่นั้นพอ".
   Nothing upstream refuses 4 USDC. This number is FlowFlow's rule, chosen
   because a deposit that small is eaten by the fees of getting it here and a
   refund smaller than its own gas is never sent at all. It is ONE exported
   constant so the figure on the screen and the figure in any later check can
   never drift apart, and it must not be described to the user as anyone
   else's limit. */
export const MIN_DEPOSIT_USDC = 5;

/**
 * Is the user's Hyperliquid address still NEW (never activated)? Read off the
 * account layer's snapshot (usePerpAccount), for THIS wallet only:
 *   true   userRole answered "missing", and no USDC and no credit has shown up
 *          since (the role is a moment's answer; money arriving is newer news)
 *   false  any other role (the account exists), or USDC or a credit is there
 *   null   not answered yet, or a snapshot of another address
 * Owner, 2026-09-22: once the account is activated the first-deposit note and
 * the activation part of the fee must not show.
 */
export function perpAccountIsNew(snap, user) {
  if (!snap || typeof user !== "string" || typeof snap.address !== "string") return null;
  if (snap.address.toLowerCase() !== user.toLowerCase()) return null;
  const role = snap.role || {};
  if (role.answered !== true || typeof role.value !== "string") return null;
  if (role.value !== "missing") return false;
  const bal = snap.perpBalanceUsdc || {};
  if (bal.answered === true && bal.reason !== "new-account") return false;
  const ledger = snap.ledger || {};
  if (ledger.answered === true && Array.isArray(ledger.inbound) && ledger.inbound.length > 0) return false;
  return true;
}

/**
 * WHICH PLAN THIS WALLET'S DEPOSIT IS QUOTED ON, or null while nobody knows yet.
 *
 * 🔴 TWO THINGS DECIDE IT, AND BOTH ARE NECESSARY.
 *
 *   Is the account new? Only a never-used address pays the one-time cost, so
 *   only a never-used address is worth routing the long way round. Once the
 *   account exists the direct plan is cheaper and simpler, and it is used.
 *
 *   CAN THIS WALLET FINISH THE JOURNEY? The long way round ends with a transfer
 *   signed by the customer's own embedded wallet. A wallet that cannot make
 *   that transfer with no window — anything but a Privy login — must never be
 *   sent down it, because its money would land on the landing chain and stop
 *   there. That check is not a nicety; it is the difference between a cheap
 *   deposit and a customer's money sitting somewhere they did not ask for.
 *
 * A wallet that cannot finish is answered at once (the direct plan, exactly as
 * it ships today) without waiting for the account layer. A wallet that can waits
 * for the answer, because an address quoted on the wrong plan would have to be
 * replaced on screen, and an address that changes under somebody who has
 * already copied it is its own kind of loss. `accountFailed` is the account
 * layer having asked and got nothing back: the direct plan then stands in, so a
 * flaky read can never leave the screen with no address at all.
 */
export function walletCanFinishFirstHop(walletType) {
  return walletType === "privy";
}

export function depositPlanFor({ accountNew = null, walletType = null, accountFailed = false } = {}) {
  if (!walletCanFinishFirstHop(walletType)) return DIRECT_PLAN.id;
  if (accountNew === true) return FIRST_HOP_PLAN_ID;
  if (accountNew === false) return DIRECT_PLAN.id;
  return accountFailed ? DIRECT_PLAN.id : null;
}

/**
 * Is this the plan whose last hop the customer's own wallet makes? Normal's
 * first-deposit plan, and Private's "private-arb" (it lands in the customer's own
 * wallet on Arbitrum and the same auto-mover makes the hop): both read "In your
 * wallet" when they land, never "in your Perp account" before they are.
 */
export function planIsFirstHop(planId) {
  return planId === FIRST_HOP_PLAN_ID || planId === PRIVATE_ARB_PLAN_ID;
}

/**
 * The live one-time activation cost as words ("1.2075 USDC"), or null when the
 * quote carried no figure anyone could tell apart. Both sentences below are
 * built from this one function, so the rule line and the fee caption can never
 * print two different amounts for the same quote.
 */
export function activationAmountText(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDC`;
}

/**
 * The first-deposit line, or null. Owner, 2026-09-23: it shows ONLY while the
 * account does not exist yet, and it carries the LIVE figure — the quote's own
 * one-time cost, never a constant typed in here. An unknown figure drops the
 * number and keeps the sentence (MONEY_RULES section 0: no invented amount).
 * No venue is named: the user is opening a Perp account, not someone's product.
 */
export function activationNote(activationUsdc) {
  const amount = activationAmountText(activationUsdc);
  return amount
    ? `First deposit only — about ${amount} one-time account activation.`
    : "First deposit only — a one-time account activation is taken from it.";
}

/** The same fact under the Fee, where the figure is already the fee's own. */
export function activationCaption(activationUsdc) {
  const amount = activationAmountText(activationUsdc);
  return amount ? `includes the ${amount} activation` : "includes the one-time account activation";
}

/**
 * The rules for one route, in the order a reader needs them. The activation
 * line only while the account layer says the address is new (accountNew true),
 * and it prints the live figure the quote carried (activationUsdc).
 *
 * NO PROVIDER AND NO VENUE (owner, 2026-09-23: "ไม่ต้องบอกด้วย ว่าใช้ Deposit ด้วย
 * Relay" / "ไม่ต้องไปอ้าง Hyperliquid"). These lines name the token, the network
 * the user is sending on, and our own wallet. Who moves the money is our
 * plumbing, and the user is not asked to care.
 */
export function depositRules(route, { accountNew = null, activationUsdc = null, planId = null, minInputUsdc = null } = {}) {
  const tok = route.token;
  const net = route.chainName;
  const first = planIsFirstHop(planId);
  /* 🔴 THE FLOOR THIS PLAN CAN ACTUALLY CARRY. On the direct plan it is our own
     product floor, the figure the owner asked for. On the first-deposit plan it
     is the quote's own arithmetic (lib/relay/firstDeposit's firstDepositMinInput),
     because what has to clear the floor there is not what the customer sends but
     the least that can arrive — measured 5.15 to 5.35 across the routes, and
     10.07 from Ethereum. A first-deposit plan with no figure of its own states
     no figure: 5 would be the one number on this screen that could cost
     somebody a top-up, and it is not printed as a guess. */
  const floor = first ? (Number.isFinite(minInputUsdc) && minInputUsdc > 0 ? minInputUsdc : null) : MIN_DEPOSIT_USDC;
  const rules = [
    { key: "only", tone: "strong", text: `Send only ${tok} on ${net}.` },
  ];
  if (floor != null) rules.push({ key: "min", tone: "plain", text: `Minimum deposit ${floor} USDC.` });
  rules.push({ key: "refund", tone: "plain", text: `Refunds return to your own address on ${net}.` });
  /* The one-time cost is a fact of the DIRECT plan only. On the first-deposit
     plan there is nothing to activate and nothing to say about it: the fee on
     screen is the whole of what this deposit costs. */
  if (accountNew === true && !first) rules.push({ key: "activate", tone: "plain", text: activationNote(activationUsdc) });
  rules.push({ key: "credit", tone: "plain", text: "Credited as USDC in your Perp wallet." });
  return rules;
}

/** "≈ 0.03 USDC"; two decimals; a sub-cent fee keeps its digits; unknown is the dash. */
export function feeText(v) {
  if (v == null || !Number.isFinite(v) || v < 0) return DASH;
  /* TWO DECIMALS, because this is money on a money screen. Owner, 2026-09-28:
     the app still told him the first deposit was expensive, and one of the two
     reasons was arithmetic (see depositFeeForDisplay); the other was that
     today's own figures rendered 0.097236 as "0.1" and 1.302769 as "1.3".
     A figure under a cent keeps more of them, so a real fee is never rounded
     away to 0.00; six is all the quote's own rounding can carry. */
  const digits = v === 0 ? 2 : v < 0.0001 ? 6 : v < 0.01 ? 4 : 2;
  const body = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
  return `≈ ${body} USDC`;
}

/**
 * What the fee was priced on: "on a 20 USDC deposit".
 *
 * 🔴 THE AMOUNT IS AN ARGUMENT, and it defaults to the one figure the whole app
 * prices on (routes.js's NOMINAL_DEPOSIT, which is also where the body's own
 * amount comes from — depositAmount(route, NOMINAL_DEPOSIT) — so the 20 in this
 * sentence and the 20 that was quoted can never drift apart). It took an amount
 * the moment a second figure appeared in this tile: a sentence that says 20 under
 * a fee priced on 1,000,000 is two statements about the same money in one box.
 */
export function feeBasisText(route, amount = NOMINAL_DEPOSIT) {
  return `on a ${depositSizeLabel(amount)} ${route.token} deposit`;
}

/** A deposit size as a reader writes it: "20", "1,000", "1,000,000". */
export function depositSizeLabel(size) {
  return Number.isFinite(size) ? size.toLocaleString("en-US") : DASH;
}

/**
 * THE FEE AS A SHARE OF THE DEPOSIT — "6.22%", "0.33%", "0.01%" — which is the
 * whole point of the breakdown: it is what shows that a big deposit is
 * proportionally cheap. Measured 2026-09-28 on Base USDC, direct plan: 6.216% on
 * 20 falling to 0.0102% on 500,000, because the flat one-time cost that is 6.2%
 * of a 20 deposit is 0.0024% of a 500,000 one.
 *
 * THREE SIGNIFICANT DIGITS, NOT A FIXED NUMBER OF DECIMALS, because a fixed
 * number destroys the thing this column exists to show. Two decimals print
 * 0.016% and 0.011% as one 0.02%, and 0.0112% at 100,000 and 0.0102% at 500,000
 * as one 0.01% — and those two are the measured convergence itself, the last and
 * best part of the fall. Three digits keeps every row on every route apart and
 * never pads: 6.22%, 1.25%, 0.33%, 0.134%, 0.0348%, 0.0112%. A share too small
 * for even that keeps taking digits rather than printing a row of zeros
 * (MONEY_RULES: a figure is never rounded away into a 0 it is not), and an
 * unknown fee is the dash.
 */
export function depositShareText(fee, size) {
  if (fee == null || !Number.isFinite(fee) || fee < 0) return DASH;
  if (!Number.isFinite(size) || size <= 0) return DASH;
  const pct = (fee / size) * 100;
  if (!Number.isFinite(pct)) return DASH;
  if (pct === 0) return "0.00%";
  /* The trailing zeros are KEPT (minimum and maximum are the same), so every row
     of the column shows the same three digits of the same figure: 0.0112% above
     0.0102% above 0.0100%, and not 0.0112% above 0.0102% above 0.01%. A ladder
     whose last rung changes shape reads as a different measurement. */
  const three = Math.max(2, 2 - Math.floor(Math.log10(pct)));
  for (let digits = three; digits <= 16; digits += 1) {
    const body = pct.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (/[1-9]/.test(body)) return `${body}%`;
  }
  return DASH;
}

/**
 * WHY A SIZE HAS NO FIGURE, in our own words, or null. There is exactly one
 * reason a reader needs told apart, and it is the honest one: the destination can
 * only take so much at once. Measured 2026-09-28, the same refusal on all three
 * routes at 1,000,000, with the ceiling live in the refusal itself and moving by
 * a few hundred dollars between requests (about $565k that day).
 *
 * Everything else — too quick, unreachable, an answer that did not check out —
 * is one sentence, because the difference between them is our plumbing and the
 * customer can do the same thing about all of them. NO PROVIDER AND NO VENUE is
 * named, and the upstream message is not repeated: these are not caveats about a
 * figure, they are why a row has none.
 */
export function depositSizeNote(error) {
  if (!error) return null;
  const code = error.detail && error.detail.errorCode;
  if (code === "INSUFFICIENT_LIQUIDITY") return "Too large for one deposit right now.";
  return "Couldn't price this size.";
}

/* Nothing priced yet: the dash, and no sentence to explain a row still coming. */
const NO_SIZE = Object.freeze({ fee: null, note: null });

/**
 * THE BREAKDOWN'S ROWS: every size the owner asked for, what each one costs, and
 * what that is as a share of it.
 *
 * 🔴 THE NOMINAL ROW IS THE FIGURE ABOVE IT, THE SAME NUMBER AND NOT A SECOND
 * QUOTE FOR THE SAME SIZE. MONEY_RULES section 1: two surfaces showing the same
 * figure must agree, and two quotes for 20 taken a minute apart do not — the
 * one-time cost drifts with gas (measured 1.2411 and 1.2511 within a minute on
 * Base). So `fee` here is the Estimate's own fee, straight through, and when the
 * Estimate is showing the dash this row shows the dash with it.
 *
 * Every other row's figure came off the same funnel as that one: the plan's own
 * body with a different amount, the plan's own verifier, depositFeeForDisplay so
 * the gas top-up is netted out on the plan that carries one, and feeText.
 */
export function depositSizeRows(fee, priced) {
  const by = priced && typeof priced === "object" ? priced : {};
  /* 🔴 A WITHHELD HEADLINE WITHHOLDS THE WHOLE LADDER, not only its own row. The
     tile prints no figure when the quote's fee carries the destination's one-time
     account cost and this screen cannot say the customer will be charged it
     (depositFeeView). Every row is the same body at another amount, on the same
     plan, to the same destination — so every row carries that same cost, flat and
     unexplained, and a ladder of 1.25, 1.34, 2.24 under a dash is the screen
     claiming money it has just refused to claim. The rows come back the moment
     the figure above them does, from the answers already in hand. A row still
     says why it has no figure of its own. */
  const held = fee == null;
  return DEPOSIT_FEE_SIZES.map((size) => {
    const nominal = size === NOMINAL_DEPOSIT;
    const got = nominal ? { fee, note: null } : by[size] || NO_SIZE;
    const shown = held ? null : got.fee;
    return {
      size,
      nominal,
      sizeLabel: depositSizeLabel(size),
      feeLabel: feeText(shown),
      shareLabel: depositShareText(shown, size),
      note: got.note,
    };
  });
}

/** Relay's time estimate after the origin chain confirms: "~1s", "~2 min"; unknown is the dash. */
export function timeText(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return DASH;
  if (sec < 60) return `~${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)} min`;
}

/** "Valid until 21 Mar 2027", or null when Relay stated no deadline. */
export function validUntilText(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `Valid until ${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
}

/** The 40 hex digits of an address in groups of four (the "0x" is drawn apart). */
export function addressGroups(addr) {
  return String(addr || "").replace(/^0x/i, "").match(/.{1,4}/g) || [];
}

/* When the figures were priced: a re-price's time, else the quote's. */
const pricedAtOf = (data) => (Number.isFinite(data.pricedAt) ? data.pricedAt : data.quotedAt);

/* Has a deposit been credited at this address since the fee was priced? */
function landedSince(data, requests) {
  const at = pricedAtOf(data);
  return (requests || []).some((r) => r && r.status === "credited" && Number.isFinite(r.createdAt) && Number.isFinite(at) && r.createdAt > at);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * 🔴 THE PRINTED FEE IS THE MONEY THE CUSTOMER LOSES, WHICH IS NOT WHAT THE
 * QUOTE SUBTRACTS. The quote's own figure is what went in minus what came out
 * (lib/relay/depositAddress), and on the first-deposit plan that difference
 * swallows the small native top-up delivered into the customer's OWN wallet on
 * the landing chain, which stays theirs and pays for their own last step
 * (lib/relay/firstDeposit: "It is not ours, it is not a fee"). Measured
 * 2026-09-28 on 20 from Base: the quote's difference is 0.116861, the top-up
 * 0.050022, and the answer's own stated impact -0.066849 — so the screen was
 * printing 1.75x what the deposit costs, on the one plan built to be cheap.
 *
 * The top-up comes out only on the plan that carries one, and only when the
 * answer stated it: an unreadable top-up, one BIGGER than the top-up this plan
 * asks for (lib/relay/firstDeposit's TOPUP_MAX_SHARE — a $2.00 top-up netted out
 * would print 0.07 for a deposit costing 2.07), or one that would leave nothing
 * or less than nothing of the fee, keeps the quote's own figure rather than
 * inventing a better one. An unknown fee stays the dash and never becomes 0.
 *
 * A quote made before a deposit that has since been credited is out of date (a
 * first deposit pays the activation, the next one does not), so its fee is
 * withheld.
 */
export function depositFeeForDisplay(data, requests) {
  if (!data || data.feeEstimateUsdc == null) return null;
  if (landedSince(data, requests)) return null;
  const gross = data.feeEstimateUsdc;
  if (!planIsFirstHop(data.plan)) return gross;
  const topup = data.topupUsd;
  if (typeof topup !== "number" || !Number.isFinite(topup) || topup <= 0) return gross;
  if (topup > TOPUP_GAS_USD * TOPUP_MAX_SHARE) return gross;
  const net = round6(gross - topup);
  return net > 0 ? net : gross;
}

/**
 * 🔴 DOES THIS ANSWER'S FEE CARRY THE ONE-TIME ACCOUNT ACTIVATION? One question
 * with three readers — the caption that states it, the withholding that refuses
 * to print it to an account that will not be charged it, and the re-price that
 * replaces it — so it is asked once, here, and they can never disagree.
 *
 * A quote that says it priced the activation is believed. The hard case is the
 * one the parse cannot answer: activationIncluded is left unknown BOTH on an
 * origin chain whose own sweep gas can pass the activation floor by itself (so
 * how much of the figure is the activation cannot be told) AND on any answer
 * whose sweep cost could not be read at all (lib/relay/depositAddress). Those
 * are two different unknowns and only one of them is a reason to tell somebody
 * their fee contains a one-time cost, so the unknown itself is not the question.
 *
 * What the screen can answer is asked instead: is this fee big enough to hold an
 * activation, on a plan whose destination charges one for an account that does
 * not exist yet? The floor is the parse's own, so the two can never drift. That
 * keeps the biggest figure on the dearest route explained (measured 2026-09-28:
 * Ethereum, brand-new account, 1.689480 of which about 1.21 is the activation)
 * and stops a fee far too small to contain one from claiming it — a 0.03 fee
 * told to contain 1.22 is the screen inventing money.
 *
 * The plan that pays no activation is never told it does: its destination is the
 * customer's own wallet on a chain their address already exists on.
 */
function feeCarriesActivation(data) {
  if (planIsFirstHop(data.plan)) return false;
  if (data.activationIncluded === true) return true;
  if (data.activationIncluded != null) return false;
  const fee = data.feeEstimateUsdc;
  return typeof fee === "number" && Number.isFinite(fee) && fee >= ACTIVATION_FLOOR_USDC;
}

/**
 * The fee as the Estimate prints it: { fee, activation }. fee null is the dash.
 * A fee priced WITH the activation is printed only while the account layer says
 * the address is new; activated or not yet known, it is withheld until a
 * re-price (useDepositFee) replaces it. A re-price made for an account known to
 * be activated stands as Relay priced it, without first-deposit words.
 */
export function depositFeeView(data, { accountNew = null, requests = [] } = {}) {
  const none = { fee: null, activation: false, activationUsdc: null };
  const fee = depositFeeForDisplay(data, requests);
  if (fee == null) return none;
  /* The live one-time cost the quote carried, for the first-deposit line. Only
     a quote that says it priced the activation has one to report. */
  const amount = typeof data.activationUsdc === "number" && Number.isFinite(data.activationUsdc) && data.activationUsdc > 0 ? data.activationUsdc : null;
  /* 🔴 THE FIGURE THAT CANNOT BE SPLIT IS STILL EXPLAINED, and it is still
     WITHHELD from the customer who will not be charged it. On the dearest origin
     chain the answer's sweep gas alone can pass the one-time cost, so how much
     of the fee is the activation cannot be told and no amount is printed for it;
     the activation is taken there all the same, because it is a fact of this
     destination for an account that does not exist yet. Before this, the biggest
     figure on the screen sat unexplained under a caption about a 20-token
     deposit while the rules beside it named a cost the estimate appeared not to
     contain — and the same figure, about 1.2 too big, was printed to an account
     that already existed and never re-priced. Both halves read one predicate
     now (feeCarriesActivation above, and repriceReason below). */
  if (feeCarriesActivation(data)) {
    if (accountNew === true) return { fee, activation: true, activationUsdc: amount };
    if (accountNew === false && data.repriced === true) return { fee, activation: false, activationUsdc: null };
    return none;
  }
  return { fee, activation: false, activationUsdc: null };
}

/**
 * Why the address on screen needs a fresh fee, or null:
 *   "stale"      the saved fee is past its hour (withheld for its age)
 *   "activated"  it was priced with the activation and the account now exists
 *   "landed"     a deposit was credited here after it was priced
 * An unknown account is not a reason to ask Relay, and a re-priced answer is
 * never re-priced again (one ask per address on screen, never a loop).
 */
export function repriceReason(data, { accountNew = null, requests = [] } = {}) {
  if (!data || !data.depositAddress || data.repriced === true) return null;
  if (data.feeStale === true) return "stale";
  if (data.feeEstimateUsdc == null) return null;
  if (accountNew === false && feeCarriesActivation(data)) return "activated";
  if (landedSince(data, requests)) return "landed";
  return null;
}

/** The three phases a deposit moves through, as the sheet draws them. */
export const DEPOSIT_PHASES = Object.freeze([
  Object.freeze({ key: "waiting", label: "Waiting" }),
  Object.freeze({ key: "arriving", label: "Arriving" }),
  Object.freeze({ key: "credited", label: "Credited" }),
]);

/* 🔴 THE SAME THREE PHASES SAY SOMETHING ELSE ON THE FIRST-DEPOSIT PLAN. There,
   the crossing ends in the customer's OWN wallet, so the last phase is not the
   money being in their Perp account — the move still has to happen. Calling it
   Credited would be the one lie on this screen, so it is called what it is, and
   the move that follows has its own line (perp/deposit/firstDepositMove.js). */
export const FIRST_HOP_PHASES = Object.freeze([
  DEPOSIT_PHASES[0],
  DEPOSIT_PHASES[1],
  Object.freeze({ key: "credited", label: "In your wallet" }),
]);

/* 🔴 AND SOMETHING ELSE AGAIN ONCE THE LAST HOP IS MADE. The money is not in
   the customer's own wallet any more: the sentence under the estimate says it is
   on its way to their Perp account, and a strip under it still reading "in your
   wallet" is two surfaces disagreeing about where one figure is. The move's own
   state is the only authority either of them reads (perp/deposit's MoveBlock and
   this label come from the same answer). */
export const FIRST_HOP_PHASES_MOVED = Object.freeze([
  DEPOSIT_PHASES[0],
  DEPOSIT_PHASES[1],
  Object.freeze({ key: "credited", label: "On its way" }),
]);

/** The phases for one plan, and for what the last hop has done about it. */
export function depositPhases(planId, { moved = false } = {}) {
  if (!planIsFirstHop(planId)) return DEPOSIT_PHASES;
  return moved ? FIRST_HOP_PHASES_MOVED : FIRST_HOP_PHASES;
}

/** The phase of the newest deposit ("waiting" when there is none). Rows are newest first. */
export function latestPhase(requests) {
  const r = (requests || [])[0];
  return r ? r.status : "waiting";
}

/** How far along the three phases a status is (-1 for an exit or an unknown). */
export function phaseIndex(status, planId = null) {
  return depositPhases(planId).findIndex((p) => p.key === status);
}

/* Each row's status pill. An unmapped status gets the dash, never "Credited".
   "incomplete" is a Private row's only (lib/intents/status.js): less arrived than
   was quoted, and it is refunded after the quote's deadline — never credited. Its
   label carries that date (depositRowView). */
const STATUS_VIEW = {
  arriving: { label: "Arriving", color: "var(--p-blue-2)", icon: "hourglass_top" },
  credited: { label: "Credited", color: "var(--p-pos)", icon: "check_circle" },
  refunded: { label: "Refunded", color: "var(--p-gold)", icon: "undo" },
  failed: { label: "Failed", color: "var(--p-neg)", icon: "error" },
  incomplete: { label: "Less than quoted", color: "var(--p-gold)", icon: "undo" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "18 Oct, 09:14" (the reader's own time zone), or null. */
export function refundAfterText(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Less than quoted · refunded after 18 Oct, 09:14" (plan §4); without a readable date, "… refunded later". */
export function incompleteLabel(refundAfter) {
  const when = refundAfterText(refundAfter);
  return when ? `Less than quoted · refunded after ${when}` : "Less than quoted · refunded later";
}

const fmtAmount = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
/* A Private row's figure: two decimals, as the Private screen prints money (more only under a cent). */
const fmtPrivate = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n !== 0 && n < 0.01 ? 4 : 2 });

/**
 * The id under which an INCOMPLETE row is acknowledged. A Private row keeps one id
 * for its whole life ("near:<address>"), so the box that said "less than quoted"
 * must be closed under its own name: closing it must never also close the refund
 * that follows it.
 */
export function incompleteAckId(id) {
  return `${id}#incomplete`;
}

/**
 * One deposit row: what arrived (or is arriving), its pill, and its origin tx
 * link. `moved` is the last hop having been made, which is what the pill on a
 * filled first-deposit crossing has to follow (see FIRST_HOP_PHASES_MOVED).
 */
export function depositRowView(req, route, planId = null, { moved = false } = {}) {
  const fmt = req.provider === "near" ? fmtPrivate : fmtAmount;
  let view = STATUS_VIEW[req.status] || { label: DASH, color: "var(--p-ink-3)", icon: null };
  /* On the first-deposit plan a filled crossing means the money is in the
     customer's own wallet, one step short of their Perp account — until the last
     hop takes it the rest of the way. */
  if (req.status === "credited" && planIsFirstHop(planId)) view = { ...view, label: moved ? "On its way" : "In your wallet" };
  if (req.status === "incomplete") view = { ...view, label: incompleteLabel(req.refundAfter) };
  /* 🔴 A LANDED ROW PRINTS WHAT LANDED, OR THE DASH. The amount sent is not what
     was credited (the crossing takes its fee, and a USDT deposit lands as USDC),
     so it never stands in for the amount out under a landed label. */
  let amount = DASH;
  if (req.status === "credited") {
    if (req.amountOut != null) amount = `+${fmt(req.amountOut)} ${req.symbolOut || "USDC"}`;
  } else if (req.amountIn != null) amount = `${fmt(req.amountIn)} ${req.symbolIn || route.token}`;
  const chain = DEPOSIT_CHAINS[req.inChainId] || null;
  const txUrl = chain && req.inTxHash ? `${chain.explorer}/tx/${req.inTxHash}` : null;
  return { key: req.id || req.inTxHash || "row", amount, ...view, txUrl };
}

/* 🔴 THE STATUS STRIP SPEAKS WITH THE ROW'S OWN WORDS. The strip at the top of
   every page (perp/deposit/DepositStatus.jsx) is the same deposit row, read by
   the same function, from the same tracker (perp/deposit/depositWatch.js): its
   figure, its pill and its colour ARE depositRowView's, so the strip and the
   sheet cannot print one deposit two ways. What a row in a list does not need,
   and the top of a page does, is the place to go, and that is all this adds.

   The place is the Perp account: where a deposit on its way lands, and where
   money between the two legs of a first deposit ("In your wallet") is offered
   its move (perp/recover's lines, which look again when it lands). The strip
   names the place, never a press: whether there is a button there is that
   screen's to measure, and a deposit too small to move has none. A deposit that
   came back or did not go has no place in the app, so it names none.

   Only what can still change stays until it is closed. Money between the legs
   is a present-tense claim about a wallet the strip does not read, so it says
   it and leaves, as a landed deposit does; the Perp account screen keeps
   pointing at it for as long as it is really there. The token is the one the
   figure is in, so the logo beside it is too. */
export const DEPOSIT_STATUS_PLACE = "Perp account";

/**
 * One deposit as the status strip draws it, or null for a row it does not
 * announce (a status the app does not know). { key, amount, label, color, icon,
 * token, live, go, lingers }: `live` is money on its way (a moving mark, not a
 * status icon); `go` is the place a tap opens, or null for none; `lingers` is a
 * state that stays until the customer has closed it.
 */
export function depositStatusView(req, route, planId = null) {
  if (!req || !route || !STATUS_VIEW[req.status]) return null;
  const row = depositRowView(req, route, planId);
  const landed = req.status === "credited";
  const token = landed ? (req.symbolOut || "USDC") : (req.amountIn != null ? (req.symbolIn || route.token) : route.token);
  /* An incomplete deposit is not money anywhere in the app yet: like a refund, it names no place and stays. */
  const ended = req.status === "refunded" || req.status === "failed" || req.status === "incomplete";
  return {
    key: row.key,
    amount: row.amount,
    label: row.label,
    color: row.color,
    icon: row.icon,
    token,
    live: req.status === "arriving",
    go: ended ? null : DEPOSIT_STATUS_PLACE,
    lingers: ended,
  };
}

/* An empty deposit list says "nothing yet" only once somebody has LOOKED. A first
   look that failed is not an answer, and the tracker keeps checking. */
export function depositListEmptyText(track) {
  return track && track.state === "ok" && track.checkedAt != null ? "Waiting for your deposit" : "Checking for deposits…";
}

/**
 * An error, in plain words, from its code. NO PROVIDER AND NO VENUE is named
 * (owner, 2026-09-23): a refusal tells the user what they can do about it, and
 * whose service refused is our problem, not theirs. The upstream message is
 * still carried through on the one code that has one, because a refusal nobody
 * can read is a support ticket.
 *
 * 🔴 THAT UPSTREAM MESSAGE IS NOT OURS AND IS NOT WORDED HERE. It is the quote
 * service's own text, and it arrives already made plain: lib/relay/plainWords.js
 * scrubs it where depositAddress.js throws, so the name is gone and the reason
 * is whole before it ever reaches this line. It is not scrubbed twice here: a
 * second pass on our own sentence is a second chance to garble it.
 */
const usdcCount = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });

export function depositErrorText(error, { chainName = null } = {}) {
  const c = error && error.code;
  const d = (error && error.detail) || {};
  if (c === "testnet-off") return "Deposits are open on mainnet only.";
  /* Private mode's refusals (lib/intents/client.js codes). Its upstream text is
     already made plain there (plainIntentsWords), like Relay's. The figures are
     the server's own (intentsErrorOf carries its min, max and left), so a cap the
     owner lowered is the cap the customer reads. */
  if (c === "private-mode-off") return "Private deposits are off right now. Use Normal deposit, or try again later.";
  /* plan §4: the facts, and no workaround. It names the customer's wallet, never "this address" (which reads as the one-time one). */
  if (c === "sanctioned") return "Your wallet can't use Private deposits. It appears on a sanctions or stolen-funds list. Contact support if you think this is a mistake.";
  if (c === "screen-unavailable") return "The safety check couldn't run just now. Try again in a minute.";
  if (c === "below-min") return `The smallest private deposit is ${Number.isFinite(d.min) ? usdcCount(d.min) : 10} USDC.`;
  if (c === "over-tx-cap") return `The largest private deposit is ${Number.isFinite(d.max) ? usdcCount(d.max) : 500} USDC.`;
  if (c === "over-day-cap") {
    const max = Number.isFinite(d.max) ? usdcCount(d.max) : "1,000";
    if (Number.isFinite(d.left) && d.left > 0) return `Over today's private limit. You can send up to ${usdcCount(d.left)} USDC more today (resets 00:00 UTC).`;
    if (Number.isFinite(d.left)) return `You've reached today's ${max} USDC private limit. Try again after 00:00 UTC.`;
    return `Over today's ${max} USDC private limit. Try a smaller amount, or after 00:00 UTC.`;
  }
  if (c === "confidentiality-mismatch") return "The privacy setting just changed. Check the label above and try again.";
  if (c === "rate-limited") return "Too many requests. Wait a minute and try again.";
  if (c === "bad-amount") return Number.isInteger(d.decimals) ? `${d.token || "USDC"} has up to ${d.decimals} decimals.` : "Enter an amount like 25 or 25.5.";
  /* Normal's own bad-route keeps its old sentence (the last line); only a private one reads this. */
  if (c === "bad-plan" || (c === "bad-route" && error.name === "IntentsError")) return "This deposit can't be priced right now. Close Deposit and open it again.";
  /* The service not quoting the route at all (measured 2026-10-15 09:08–09:45Z, every pair): a pause, in our words. */
  if (c === "intents-error" && /pair is not available|not available for this pair/i.test(String(error.message || ""))) {
    return `Private deposits${chainName ? ` from ${chainName}` : ""} are paused right now. Try again later, or use Normal deposit.`;
  }
  if (c === "intents-error") return error.message ? `Couldn't get a private quote: ${error.message}` : "Couldn't get a private quote. Try again.";
  if (c === "network") return "Couldn't reach the deposit service. Check your connection and try again.";
  if (c === "unsafe-quote" || c === "bad-deposit-address") return "The answer didn't check out, so no address is shown. Try again.";
  if (c === "route-unavailable") return "Deposits on this network and token are closed right now, so no address is shown. Don't send to an address you saved for it. Pick another network, or try again later.";
  if (c === "not-connected" || c === "bad-user") return "Connect a wallet to get your deposit address.";
  if (c === "relay-error" && error.message) return `Couldn't get a deposit address: ${error.message}`;
  return "Couldn't get a deposit address. Try again.";
}
