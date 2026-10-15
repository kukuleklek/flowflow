// ─────────────────────────────────────────────────────────────────────────────
// What the signing window says — in the words the button already said.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-30: "ปุ่มเซ็นของ Privy ไม่เฟี้ยวเลยอะ ตอนรูดซื้อขาย หรือโอนออก",
// and then, when asked whether money should be signed with no window at all:
// "ไม่ต้องเซ็นเงียบ แต่ทำ popup ให้สวย". The confirmation stays. It stops being
// a stranger.
//
// Every sentence here is built from a figure the app MEASURED and had in hand at
// the instant the customer pressed — the same object the confirm screen was
// drawn from, never a fresh read, so the window and the screen behind it can
// never disagree (docs/MONEY_RULES.md §1). A figure that is not in hand is the
// dash: an unpriced window says nothing about the price rather than saying 0.
//
// THE RULES THESE SENTENCES OBEY, which are the owner's screen rules:
//   · no provider and no venue is named, ever — not in a title, not in a
//     description, not in a button. The customer reads about their own money.
//   · the word Withdraw, never the name of the service that carries it.
//   · no warning block. The cautions live on the confirm screen the customer
//     just read; a window is not the place to start a new argument.
//   · the button says what the button they pressed said.
//
// WHAT THIS FILE CANNOT DO, and it matters: Privy's window draws the raw signed
// payload BELOW these words, as its own JSON tree, and nothing in this app
// reaches that. A title and a description are a header over it, not a
// replacement for it. Nobody in this change has seen that screen.

import { DASH, fmtUsd, short, usdcExact } from "./format.js";
import { SIGN_WORDS_TYPED_DATA, SIGN_WORDS_TRANSACTION } from "../services/signWords.js";

/* ── the figure, in the SHAPE THE SCREEN BEHIND IT USES ────────────────────
   There are two shapes in this app and a window has to pick the one its own
   screen picked, or the two of them print one amount two ways:

     `cents`  lib/format's usdcExact, two decimals at least. The Perp Withdraw
              sheet's rows are this, so its two windows are too. Without it a
              25 USDC withdrawal read "25.00 USDC" on the row and "25 USDC
              out." on the window — which is every round amount.
     plain    six decimals, no minimum. The recovery row and the gas row are
              this (deposit/firstDepositMove's moveAmountText), so those
              windows are as well.

   AND THE FLOOR SHAPE, FOR A FLOOR. "You receive at least" is a promise the contract
   has to keep: rounding 4210.5512345 up to 4,210.551235 puts the sentence
   5e-7 above the on-chain minimum, so the trade windows truncate instead.

   🔴 AND NEVER A ZERO THAT IS NOT ZERO. At 18 decimals a real figure can be
   smaller than the sixth decimal place, and `toLocaleString` drew it as "0" —
   "You receive at least 0 USDC." over a signature that receives something
   (docs/MONEY_RULES.md §0 forbids that outright). A figure that small prints
   as itself, to three significant digits, rather than as nothing. */

/** Six decimals, truncated toward zero — not multiply-and-floor, which wobbles. */
function floorAt6(n) {
  const s = n.toFixed(8);
  const dot = s.indexOf(".");
  if (dot < 0) return n;
  return Number(s.slice(0, dot + 7));
}

/**
 * A figure the way the screen behind the window prints it, or the dash.
 * @param {{ cents?: boolean, floor?: boolean }} shape which of the two shapes,
 *   and whether the figure is a floor that may not be rounded up
 */
export function signAmountText(amount, symbol = "USDC", { cents = false, floor = false } = {}) {
  const n = typeof amount === "string" && amount.trim() !== "" ? Number(amount) : amount;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return DASH;
  if (cents) return `${usdcExact(n)} ${symbol}`;
  const v = floor ? floorAt6(n) : n;
  let digits = v.toLocaleString("en-US", { maximumFractionDigits: 6 });
  if (n > 0 && Number(digits.replace(/,/g, "")) === 0) {
    digits = n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  }
  return `${digits} ${symbol}`;
}

/** A network's name, or null when the route did not carry one. */
function chainOf(route) {
  const n = route && typeof route.chainName === "string" ? route.chainName.trim() : "";
  return n || null;
}

/** A token's ticker, or null. */
function tokenOf(route) {
  const t = route && typeof route.token === "string" ? route.token.trim() : "";
  return t || null;
}

/* ── Withdraw: two windows, one press ──────────────────────────────────────
   The customer pressed "Confirm and sign" on the review screen, having read
   "Two signatures in your wallet: the authorization, then the transfer
   itself." (perp/live/PerpWithdrawSheet). These two windows are those two
   signatures, and they say so in the sheet's own order and the sheet's own
   figures — from the quote that was reviewed, never a new one. */

/**
 * The words for a Withdraw's two windows: { authorize, deposit }.
 * @param {{ quote: object }} o the quote the review screen showed and is signing
 */
export function withdrawSignWords({ quote } = {}) {
  const q = quote || {};
  const route = q.route || {};
  /* The sheet's own shape, from the sheet's own function: its rows and these
     two windows are the pair MONEY_RULES §1 names, and one press draws both. */
  const out = signAmountText(q.amountUsdc, "USDC", { cents: true });
  const token = tokenOf(route) || "USDC";
  const gets = signAmountText(q.receiveAmount, token, { cents: true });
  const chain = chainOf(route);
  /* 🔴 NO CLAUSE OVER A DASH. "You receive —." tells the customer nothing and
     reads like a bug on a screen they are about to sign; a quote with no
     receive figure loses the sentence instead, and what leaves still stands. */
  /* 🔴 AND NO ADDRESS ON THIS ONE. The message this window is signing is the
     transfer INTO the carrier, so the address in its own payload — which the
     window draws below these words — is not the customer's recipient. A
     sentence naming the recipient directly above a payload naming somebody
     else is the app appearing to send the money somewhere it is not. The
     destination is on the review screen they just read and on the receipt
     after; it is not this window's to restate. */
  const lands = gets === DASH ? "" : [
    ` You receive ${gets}`,
    chain ? ` on ${chain}` : "",
    ".",
  ].join("");
  /* A dash is a figure nobody has, and a sentence built around one reads like
     a broken screen. The clause goes and the window says the one thing that is
     still true — which is the same rule the gas purchase below follows. */
  return Object.freeze({
    authorize: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      title: "Withdraw",
      description: out === DASH
        ? "Authorizing this withdrawal. Next, you confirm the transfer itself."
        : `Authorizing ${out} out. Next, you confirm the transfer itself.`,
      buttonText: "Authorize",
    }),
    deposit: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      primaryType: "HyperliquidTransaction:SendAsset",
      title: "Withdraw",
      description: out === DASH ? "This is the transfer itself." : `${out} out.${lands}`,
      buttonText: "Confirm the transfer",
    }),
  });
}

/* ── Private withdraw: ONE window, one press ───────────────────────────────
   The customer pressed "Confirm and sign" on the Private review (wallet/
   WithdrawPanel.jsx, perp/withdraw/privateWithdrawView.js), having read its
   rows. This is the one signature behind that press — the sendAsset to the
   quote's one-time address — and it says what those rows said, in the rows'
   own shape: privateAmountText below is the ONE formatter of both (two
   decimals, more only under a cent; a guarantee is never rounded up), so the
   window and the screen cannot print one figure two ways.
   🔴 NO ADDRESS ON IT, for the Relay window's reason: the payload below these
   words names the one-time address, not the customer's recipient.
   🔴 "Private" only when the QUOTE is (a partner-key quote): a keyless one is a
   preview, and the window must not claim more than the screen did. */

/* Normal's digit rule (owner, 2026-09-28: money on a money screen is two decimals), as the Private deposit prints
   it: 2, and more only for a figure under a cent, so a real fee is never rounded away to 0.00. */
const privateDigits = (v) => (v === 0 ? 2 : v < 0.0001 ? 6 : v < 0.01 ? 4 : 2);

/**
 * A Private money figure as the Private screens print it: "≈ 19.79 USDC", "1.00 USDC"; unknown is the dash, never 0.
 * `floor` rounds DOWN (a guarantee is never printed above what the quote promises): 19.596753 → "19.59".
 * @param {number|string|null} v
 * @param {{ approx?: boolean, floor?: boolean, symbol?: string }} o
 */
export function privateAmountText(v, { approx = false, floor = false, symbol = "USDC" } = {}) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return DASH;
  const d = privateDigits(n);
  /* Down in whole micro-USDC first, so the float never rounds the last digit up. */
  const shown = floor ? Math.floor(Math.round(n * 1e6) / 10 ** (6 - d)) / 10 ** d : n;
  const body = shown.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: d });
  return `${approx ? "≈ " : ""}${body} ${symbol}`;
}

/**
 * The words for a Private withdrawal's one window (executeIntentsWithdraw arms
 * them for exactly that signature and disarms them after).
 * @param {{ quote: object, review?: object|null }} o the verified quote the review
 *   showed, and privateWithdrawReview's reading of it (its activation figure)
 */
export function privateWithdrawSignWords({ quote, review = null } = {}) {
  const q = quote || {};
  const r = review || {};
  const route = q.route || {};
  const token = tokenOf(route) || "USDC";
  const out = privateAmountText(q.amountUsdc);
  const gets = privateAmountText(q.receive, { approx: true, symbol: token });
  const chain = chainOf(route) || (typeof r.chainName === "string" && r.chainName.trim() ? r.chainName.trim() : null);
  const feeN = r.accountFeeUsdc == null ? null : Number(r.accountFeeUsdc);
  const fee = feeN != null && Number.isFinite(feeN) && feeN > 0 ? privateAmountText(feeN) : null;
  /* No clause over a dash (the Relay window's rule): what is known still stands. */
  const lands = gets === DASH ? "" : ` You receive ${gets}${chain ? ` on ${chain}` : ""}.`;
  const also = fee ? ` A ${fee} activation fee also leaves your balance.` : "";
  return Object.freeze({
    method: SIGN_WORDS_TYPED_DATA,
    primaryType: "HyperliquidTransaction:SendAsset",
    title: q.private === true ? "Private withdraw" : "Withdraw",
    description: out === DASH ? "This is the withdrawal itself." : `${out} out.${lands}${also}`,
    buttonText: "Confirm the withdrawal",
  });
}

/* ── Buy the gas: the same two windows, pointed at gas ─────────────────────
   The customer pressed "Buy the gas" under the sentence the recovery row
   already prints, word for word (perp/recover/recoverFundView). It is the same
   pair of signatures as a Withdraw, so it reads as the same pair — and the
   second one repeats the sentence they pressed under, because that is the
   sentence they used to decide.

   TWO FIGURES OR NEITHER. The row refuses the press when either is a dash, so
   this window is only ever built over two real figures; if one is missing
   anyway, both clauses go and the window says what it does know. */

/**
 * The words for a gas purchase's two windows: { authorize, deposit }.
 * @param {{ ask: number, arrivesUsd: number, chainName: string }} o
 *   ask what leaves the Perp account, arrivesUsd what arrives as gas
 */
export function gasBuySignWords({ ask = null, arrivesUsd = null, chainName = null } = {}) {
  const out = signAmountText(ask, "USDC");
  const usd = fmtUsd(arrivesUsd);
  const chain = typeof chainName === "string" && chainName.trim() ? chainName.trim() : null;
  const priced = out !== DASH && usd !== DASH && !!chain;
  return Object.freeze({
    authorize: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      title: "Buy gas",
      description: out === DASH
        ? "Authorizing the purchase. Next, you confirm the transfer itself."
        : `Authorizing ${out} out of your Perp account. Next, you confirm the transfer itself.`,
      buttonText: "Authorize",
    }),
    deposit: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      primaryType: "HyperliquidTransaction:SendAsset",
      title: "Buy gas",
      description: priced
        ? `${out} leaves your Perp account and ${usd} of ${chain} gas arrives in your own wallet there.`
        : "This is the transfer that pays for the gas.",
      buttonText: "Confirm the transfer",
    }),
  });
}

/* ── Recover: one window, and it must not promise the wrong end ────────────
   The customer pressed "Move it into your Perp account" or "Try the move
   again". `landsOn` is the network the money arrives on when a SECOND, small
   move follows, and null when this one signature finishes the journey — the
   quote's own answer. Naming the Perp account on a signature that lands
   somewhere else would be the window promising one step where the sheet
   already said there are two. Both sentence shapes are the recovery line's
   own (perp/recover/recoverFundView's recoverMoveLine). */

/**
 * The words for the recovery permit's one window.
 * @param {{ amount: number, token: string, chainName: string, landsOn: string|null }} o
 *   amount the balance re-read from the chain one line before the signature
 */
export function recoverSignWords({ amount = null, token = "USDC", chainName = null, landsOn = null } = {}) {
  const sym = typeof token === "string" && token.trim() ? token.trim() : "USDC";
  const moving = signAmountText(amount, sym);
  const chain = typeof chainName === "string" && chainName.trim() ? chainName.trim() : null;
  const to = typeof landsOn === "string" && landsOn.trim() ? landsOn.trim() : null;
  /* No figure means no figure in the sentence — but the DOOR still has to be
     right, because that is the half a customer cannot work out for themselves. */
  const what = moving === DASH ? "your money" : moving;
  const description = to
    ? `Moving ${what} to your own wallet on ${to}. From there, one more move puts it into your Perp account.`
    : chain
      ? `Moving ${what} from your own wallet on ${chain} into your Perp account.`
      : `Moving ${what} into your Perp account.`;
  return Object.freeze({
    method: SIGN_WORDS_TYPED_DATA,
    /* lib/relay/recoverFund refuses a quote whose signature is not this one
       (its PERMIT_PRIMARY_TYPE), so naming it here is not a guess — and it
       means these words can only ever land on that message. This is the one
       money window with nothing after it to clear the arming, so it limits
       itself instead. A test pins the two together. */
    primaryType: "ReceiveWithAuthorization",
    title: "Move it",
    description,
    buttonText: "Move it",
  });
}

/* ── THE AVAX WALLET: every window, in the owner's names ───────────────────
   Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
   Privy เลย". Owner naming (USER-ADDENDUM, via the design session): the
   Hyperliquid side is the "Main Account", the wallet on Avalanche is the "Spot
   Account", and the windows say so: "Move 2 USDC to your Spot Account",
   "Move 2 USDC to your Main Account". Aave is a sponsor and is named (AD-12).

   🔴 DECODED FIGURES ONLY. Every builder below takes figures that were READ OUT
   of the very transaction, typed data or verified quote the window is over —
   by the closed builders in src/avax/closedTx.js, or by the move's own parser
   (lib/relay/ownMove.js parseOwnMoveQuote) — never a caller's sentence, never a
   typed value, never anything an agent wrote. A figure that is missing loses
   its clause; no window says "—" over money.

   The Aave sentences are lib/avax/aaveTx.js aaveTxSummary's, word for word, and
   the swap sentences are lib/avax/swapDecode.js swapWindowWords' own, so the
   card and the window over it cannot say two different things
   (scripts/test-avax-signers.mjs holds both pairs together). */

/** A decoded amount string ("2", "10.5"), or null. */
const amountOf = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null);

/* An exact decimal cut DOWN to `dp` places — never rounded up, and a non-zero
   amount never printed as "0" — the shape the card's "Gas for later" row uses
   for AVAX (lib/avax/gas.js avaxAmount: 18 decimals, 4 shown). */
function cutDecimal(s, dp) {
  const [w, f = ""] = s.split(".");
  const cut = f.slice(0, dp).replace(/0+$/, "");
  if (/^0*$/.test(w) && !cut) return /[1-9]/.test(f) ? `<0.${"0".repeat(dp - 1)}1` : "0";
  return cut ? `${w}.${cut}` : w;
}

/**
 * The words for one Aave transaction's window.
 * @param {{ kind: "approve"|"remove-allowance"|"supply"|"withdraw", amount?: string|null, all?: boolean }} d
 *   amount: the decoded USDC amount as an exact decimal string; all: Pool.withdraw(MAX)
 */
export function aaveSignWords({ kind, amount = null, all = false } = {}) {
  const usdc = amountOf(amount);
  const w = (title, description, buttonText) => Object.freeze({ method: SIGN_WORDS_TRANSACTION, title, description, buttonText });
  switch (kind) {
    case "approve":
      return w("Allow USDC for Aave", usdc ? `Allow exactly ${usdc} USDC for Aave` : "Allow USDC for Aave", "Allow");
    case "remove-allowance":
      return w("Remove allowance", "Remove the USDC allowance for Aave", "Remove");
    case "supply":
      return w("Stake", usdc ? `Supply ${usdc} USDC to Aave on Avalanche` : "Supply USDC to Aave on Avalanche", "Stake");
    case "withdraw":
      return w("Unstake", all ? "Withdraw all your USDC from Aave" : usdc ? `Withdraw ${usdc} USDC from Aave` : "Withdraw USDC from Aave", "Unstake");
    default:
      return null;
  }
}

/**
 * The words for a swap's windows, from swapDecode.swapWindowWords() of the
 * VERIFIED swap: { approve: words|null, swap: words }.
 */
export function swapSignWords(windowWords = {}) {
  const ww = windowWords || {};
  const line = (s) => (typeof s === "string" && s.trim() ? s.trim() : null);
  const approve = line(ww.approve);
  const swap = line(ww.swap);
  return Object.freeze({
    approve: approve ? Object.freeze({ method: SIGN_WORDS_TRANSACTION, title: "Allow the swap", description: `${approve}. Nothing is swapped by this.`, buttonText: "Allow" }) : null,
    swap: Object.freeze({ method: SIGN_WORDS_TRANSACTION, title: "Swap", description: swap || "This is the swap you just priced.", buttonText: "Swap" }),
  });
}

/** The words for taking back a swap allowance that was not used. Nothing of the customer's moves. */
export function allowanceResetSignWords({ symbol = null } = {}) {
  const sym = typeof symbol === "string" && symbol.trim() ? symbol.trim() : null;
  return Object.freeze({
    method: SIGN_WORDS_TRANSACTION,
    title: "Remove allowance",
    description: sym ? `Remove the ${sym} allowance you gave for a swap. Nothing moves.` : "Remove the allowance you gave for a swap. Nothing moves.",
    buttonText: "Remove",
  });
}

/**
 * The words for a move FROM the Main Account into the Spot Account — its two
 * windows, { authorize, deposit } — from the move's own verified review
 * (lib/relay/ownMove.js parseOwnMoveQuote). executeOwnMove takes them as its
 * `signWords`, and withdraw.js arms each one for exactly its own window.
 * @param {{ kind: "move-in"|"gas-topup", amountOut: string, amountIn: number, topup: { avax: string }|null,
 *   gasRow: { usd: number }|null }} review  the $ of the gas clause is gasRow.usd (what the card prints)
 */
export function ownMoveSignWords(review = {}) {
  const r = review || {};
  const gasMove = r.kind === "gas-topup";
  /* What leaves the Main Account, in the plain six-decimal shape the move card
     prints its debit row in. */
  const debit = signAmountText(r.amountIn, "USDC");
  const out = amountOf(r.amountOut);
  const topup = r.topup && typeof r.topup === "object" ? r.topup : null;
  const cut = topup && amountOf(topup.avax) ? cutDecimal(topup.avax, 4) : null;
  const avax = cut && cut !== "0" ? (cut.startsWith("<") ? cut : `≈${cut}`) : null;
  /* Two decimals, the way the card's "Gas for later" row prints it — and FROM that row
     (review.gasRow.usd, the $ asked), never the quote's own topup.usd: Relay may answer
     anywhere in a band around the ask, and the window over the money-moving sendAsset must
     print the very figure the card printed (AD-8, rule D). No row, no $ clause. */
  const row = topup && r.gasRow && typeof r.gasRow === "object" ? r.gasRow : null;
  const usd = row && typeof row.usd === "number" && Number.isFinite(row.usd) && row.usd > 0 ? `$${row.usd.toFixed(2)}` : null;
  /* "includes ≈0.02 AVAX for gas (≈$0.20)": the owner's own sentence (AD-8),
     and only when the AVAX figure is in hand. */
  const gasClause = avax ? ` It includes ${avax} AVAX for gas${usd ? ` (≈${usd})` : ""}.` : "";
  const title = gasMove ? "Gas for your Spot Account" : "Move to Spot Account";
  const authorize = Object.freeze({
    method: SIGN_WORDS_TYPED_DATA,
    title,
    description: debit === DASH
      ? "Authorizing this move out of your Main Account. Next, you confirm the move itself."
      : `Authorizing ${debit} out of your Main Account. Next, you confirm the move itself.`,
    buttonText: "Authorize",
  });
  const leaves = debit === DASH ? "" : ` ${debit} leaves your Main Account.`;
  const deposit = Object.freeze({
    method: SIGN_WORDS_TYPED_DATA,
    primaryType: "HyperliquidTransaction:SendAsset",
    title,
    description: gasMove
      ? `${avax ? `Buy ${avax} AVAX for gas in your Spot Account.` : "Buy AVAX for gas in your Spot Account."}${leaves}`
      : `${out ? `Move ${out} USDC to your Spot Account.` : "Move USDC to your Spot Account."}${leaves}${gasClause}`,
    buttonText: "Confirm the move",
  });
  return Object.freeze({ authorize, deposit });
}

/**
 * The words for a move FROM the Spot Account back into the Main Account (the
 * exit, signed — no AVAX): { permit, authorize }. `permit` is the USDC
 * authorization that moves the money; `authorize` the call authorization that
 * may come before it (from 2026-10-26).
 * @param {{ amount: string, minimum?: string|null }} o decoded USDC amounts
 */
export function moveOutSignWords({ amount = null, minimum = null } = {}) {
  const usdc = amountOf(amount);
  const min = amountOf(minimum);
  return Object.freeze({
    permit: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      primaryType: "ReceiveWithAuthorization",
      title: "Move to Main Account",
      description: `${usdc ? `Move ${usdc} USDC to your Main Account.` : "Move your USDC to your Main Account."}${min ? ` At least ${min} USDC arrives.` : ""}`,
      buttonText: "Move",
    }),
    authorize: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      primaryType: "MulticallAuthorization",
      title: "Move to Main Account",
      description: usdc
        ? `Authorizing exactly ${usdc} USDC for this move. Next, you sign the move itself.`
        : "Authorizing this move. Next, you sign the move itself.",
      buttonText: "Authorize",
    }),
  });
}

/**
 * The words for the paid exit's two transactions (the fallback when the signed
 * exit is refused; it costs a little AVAX): { approve, deposit }.
 */
export function paidExitSignWords({ amount = null, minimum = null } = {}) {
  const usdc = amountOf(amount);
  const min = amountOf(minimum);
  return Object.freeze({
    approve: Object.freeze({
      method: SIGN_WORDS_TRANSACTION,
      title: "Move to Main Account",
      description: usdc ? `Allow exactly ${usdc} USDC for the move to your Main Account. Nothing moves yet.` : "Allow USDC for the move to your Main Account. Nothing moves yet.",
      buttonText: "Allow",
    }),
    deposit: Object.freeze({
      method: SIGN_WORDS_TRANSACTION,
      title: "Move to Main Account",
      description: `${usdc ? `Move ${usdc} USDC to your Main Account.` : "Move your USDC to your Main Account."}${min ? ` At least ${min} USDC arrives.` : ""}`,
      buttonText: "Move",
    }),
  });
}

/* ── Recover: USDC back in the customer's own wallet on Base or Polygon ─────
   A private deposit's refund lands in the customer's own wallet on its origin
   chain, and the Deposit sheet's Recover row moves it into the balance with no
   gas (lib/relay/recoverStranded.js). The row the customer pressed reads "You
   receive ≈ X in your balance · fee · no gas" and its button "Move in"; the
   window says the same move, from the figures lib/relay/recoverClosed.js
   decoded out of what is about to be signed. The guaranteed minimum is cut
   DOWN to cents, the way the Private screens print every "At least". */

/**
 * The words for Recover's windows: { permit, authorize }. `permit` is the USDC
 * authorization that moves the money; `authorize` the call authorization that
 * may come before it (from 2026-10-26).
 * @param {{ amount: string, minimum?: string|null, chainName?: string|null }} o decoded USDC amounts; the network it leaves
 */
export function recoverMoveInSignWords({ amount = null, minimum = null, chainName = null } = {}) {
  const usdc = amountOf(amount);
  const min = amountOf(minimum) ? cutDecimal(minimum, 2) : null;
  const chain = typeof chainName === "string" && chainName.trim() ? chainName.trim() : null;
  const from = chain ? ` from your wallet on ${chain}` : "";
  return Object.freeze({
    permit: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      primaryType: "ReceiveWithAuthorization",
      title: "Move into your balance",
      description: `${usdc ? `Move ${usdc} USDC${from} into your balance.` : `Move your USDC${from} into your balance.`}${min && min !== "0" ? ` At least ${min} USDC arrives.` : ""} No gas needed.`,
      buttonText: "Move in",
    }),
    authorize: Object.freeze({
      method: SIGN_WORDS_TYPED_DATA,
      primaryType: "MulticallAuthorization",
      title: "Move into your balance",
      description: usdc
        ? `Authorizing exactly ${usdc} USDC${from} for this move. Next, you sign the move itself.`
        : "Authorizing this move. Next, you sign the move itself.",
      buttonText: "Authorize",
    }),
  });
}
