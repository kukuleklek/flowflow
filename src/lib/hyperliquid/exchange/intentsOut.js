// ─────────────────────────────────────────────────────────────────────────────
// THE GATE ON A PRIVATE WITHDRAWAL'S ONE MONEY STEP, and the UNSIGNED action.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน". The sibling of relayOut.js
// for the Private route (plan §3 P1 step 4, R-fit "intentsOut"): it decides
// what a Private withdrawal may make the wallet sign, and builds that action
// UNSIGNED. Nothing here signs, holds a key or posts. It lives in the exchange
// folder because only the lazy perp surfaces may reach the signing layer
// (test-hl-exchange-orders G4); the quote it trusts is lib/intents/withdraw.js's.
//
// WHAT MAY BE SIGNED: exactly one Hyperliquid sendAsset, and only when
//   * the quote is one withdraw.js VERIFIED (by identity: a copy, a JSON
//     round-trip or a hand-made object is refused), real (not priced-only),
//     younger than its TTL, with its address alive for 10 more minutes;
//   * the preflight is that quote's own, ok and fresh (not sanctioned, a plain
//     account, a readable account fee, a balance that covers amount + fee);
//   * the signer is the account the quote refunds to (quote.user);
//   * destination = the quote's depositAddress — never the user's own wallet,
//     never the typed recipient, never anything hard-coded;
//   * token = USDC's own Hyperliquid id; sourceDex "" (the Perp account);
//     destinationDex "" (as Relay's depository takes it; UNVERIFIED for the
//     intents address until the owner's live test T3); fromSubAccount "";
//   * amount = the quote's amountIn (8 decimals) as Hyperliquid's 6-decimal
//     string, EXACTLY — a set digit below the sixth decimal is refused, never
//     rounded; and the same figure the customer typed;
//   * the nonce is inside Hyperliquid's window.
//
// TWO CLOCKS. The quote's quotedAt and the preflight's checkedAt are stamped by
// the BROWSER's clock (withdraw.js), so their freshness is judged on that same
// clock (`now`); only the nonce window is judged on Hyperliquid-corrected time
// (`serverNow`). Judging browser stamps against corrected time would refuse every
// press on a device whose clock is a minute off — and every retry would reserve
// another one-time address.
//
// WHICH WINDOW. Always the wallet's own. sendAsset is not on
// HL_SILENT_MASTER_ACTIONS (master.js) and this file refuses to build one if
// that ever changes, so a Private withdrawal can never be signed silently, and
// the Privy bridge's allow-list (PrivyBridge.jsx) is untouched by this route.
//
// THE CALLER is the exchange client (a new method, sendIntentsDeposit, which
// allocates the nonce, calls buildIntentsSendAsset, signs with sendMaster()
// — visible — and posts ONCE; a lost reply is not_confirmed, retry:false).
// That client method is not written yet (the UI phase wires it); this file is its gate.

import { buildSendAssetAction, formatUsdcAmount, HL_SILENT_MASTER_ACTIONS } from "./master.js";
import { HL_USDC_TOKEN, RELAY_SEND_ASSET_TYPE, RELAY_SEND_ASSET_FIELDS, HL_NONCE_PAST_MS, HL_NONCE_FUTURE_MS } from "./relayOut.js";
import { HL_USER_SIGNED_TYPES } from "./signing.js";
import {
  isVerifiedWithdrawQuote, withdrawQuoteFresh, preflightFresh, hlAmountFromUnits, parsePrivateWithdrawAmount,
  sameAddress, isEvmAddress, HL_USDC_SEND_TOKEN,
} from "../../intents/withdraw.js";

/** The one action a Private withdrawal signs, and its EIP-712 primary type. */
export const INTENTS_SEND_ACTION = "sendAsset";
export const INTENTS_SEND_PRIMARY_TYPE = RELAY_SEND_ASSET_TYPE;

const fail = (code, message) => ({ ok: false, code, message });
const BAD = "This withdrawal isn't the one you reviewed, so nothing was signed. Get a new quote and try again.";
const STALE = "That price is out of date, so nothing was signed. Getting a fresh one.";

/**
 * The sendAsset fields for this quote, or a refusal. Every check runs before
 * any wallet is asked for anything.
 * @param {{ quote: object, preflight: object, profile: object, master: string, amountUsdc?: string|number|null, now?: number }} o
 *   amountUsdc: what the customer TYPED (checked against the quote again), when the caller has it
 */
export function readIntentsSendStep({ quote, preflight, profile, master, amountUsdc = null, now = Date.now() } = {}) {
  if (!isVerifiedWithdrawQuote(quote) || quote.dry || !quote.depositAddress) return fail("bad_quote", BAD);
  if (!profile || profile.network !== "mainnet" || profile.hyperliquidChain !== "Mainnet") {
    return fail("wrong_network", "Private withdrawals work on mainnet only, so nothing was signed.");
  }
  if (!isEvmAddress(master)) return fail("no_wallet", "Connect a wallet first.");
  if (!sameAddress(master, quote.user)) return fail("wallet_mismatch", "This quote was made for a different wallet. Get a new quote and try again.");
  if (!withdrawQuoteFresh(quote, now)) return fail("quote_expired", STALE);
  if (!preflightFresh(preflight, quote, now)) return fail("recheck", "The transfer check is out of date, so nothing was signed. Checking again.");

  const destination = quote.depositAddress;
  if (!isEvmAddress(destination)) return fail("bad_quote", BAD);
  if (sameAddress(destination, master)) return fail("bad_quote", "This would send the money back to your own Perp account, so nothing was signed.");
  if (quote.route.kind === "evm" && sameAddress(destination, quote.recipient)) return fail("bad_quote", BAD);

  /* The amount: the quote's 8-decimal amountIn, exactly, as 6 decimals; and the
     same figure Hyperliquid's own formatter writes, and the customer typed. */
  const amount = hlAmountFromUnits(quote.amountRaw);
  if (!amount || amount !== quote.hlAmount || formatUsdcAmount(amount) !== amount) {
    return fail("amount_mismatch", "This amount can't be sent exactly, so nothing was signed.");
  }
  if (amountUsdc != null) {
    const typed = parsePrivateWithdrawAmount(amountUsdc);
    if (!typed.ok || typed.units !== quote.amountRaw) {
      return fail("amount_mismatch", "This quote is for a different amount than the one you entered, so nothing was signed.");
    }
  }

  const token = HL_USDC_TOKEN.mainnet;
  if (token !== HL_USDC_SEND_TOKEN) return fail("not_usdc", "This would move something other than your Perp USDC, so nothing was signed.");

  return {
    ok: true,
    fields: Object.freeze({ destination, sourceDex: "", destinationDex: "", token, amount, fromSubAccount: "" }),
  };
}

/**
 * The UNSIGNED Hyperliquid action for a Private withdrawal:
 * { ok: true, action, primaryType, types, visible: true, fields } or a refusal.
 * `action` is master.js's own buildSendAssetAction output, the exact object the
 * exchange client signs with the wallet's window and posts once.
 * @param {{ quote: object, preflight: object, profile: object, signatureChainId: string,
 *   nonce: number, master: string, amountUsdc?: string|number|null, now?: number, serverNow?: number }} o
 *   now: the clock that stamped the quote and the preflight (the browser's), for their freshness
 *   serverNow: Hyperliquid-corrected time (the client's nonces.serverNow()), for the nonce window; defaults to `now`
 */
export function buildIntentsSendAsset({ quote, preflight, profile, signatureChainId, nonce, master, amountUsdc = null, now = Date.now(), serverNow = now } = {}) {
  /* The window rule, held here as well as in master.js: if sendAsset ever joined
     the no-window list, refuse rather than build something that could be signed
     without the customer seeing it. */
  if (HL_SILENT_MASTER_ACTIONS.includes(INTENTS_SEND_ACTION)) {
    return fail("silent_list_changed", "This withdrawal must be signed in your wallet's window, so nothing was signed.");
  }
  const read = readIntentsSendStep({ quote, preflight, profile, master, amountUsdc, now });
  if (!read.ok) return read;
  if (!Number.isSafeInteger(nonce) || nonce <= 0) return fail("bad_nonce", BAD);
  if (!Number.isFinite(serverNow) || nonce < serverNow - HL_NONCE_PAST_MS || nonce > serverNow + HL_NONCE_FUTURE_MS) return fail("quote_expired", STALE);
  let action;
  try {
    action = buildSendAssetAction({ profile, signatureChainId, ...read.fields, nonce });
  } catch (e) {
    return fail("bad_quote", BAD);
  }
  const types = HL_USER_SIGNED_TYPES.sendAsset;
  const list = types && types[INTENTS_SEND_PRIMARY_TYPE];
  if (!Array.isArray(list) || list.length !== RELAY_SEND_ASSET_FIELDS.length
      || !list.every((f, i) => f.name === RELAY_SEND_ASSET_FIELDS[i][0] && f.type === RELAY_SEND_ASSET_FIELDS[i][1])) {
    return fail("bad_types", BAD);
  }
  return {
    ok: true,
    action,
    primaryType: INTENTS_SEND_PRIMARY_TYPE,
    types,
    visible: true,
    fields: read.fields,
    nonce,
  };
}
