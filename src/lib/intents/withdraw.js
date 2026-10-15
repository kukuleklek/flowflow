// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE WITHDRAW: Perp USDC (HyperCore) -> a one-time intents deposit address
// -> the address the customer TYPED, on the chain they picked.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน" — the backend of the
// "Normal | Private" toggle (plan PLAN-PRIVATE-MODE.md §3 P1, "W1"). Real ZK is
// a later phase; this route is NOT zero-knowledge and, without the partner key
// (server env NEAR_INTENTS_JWT), NOT private either: the public explorer and the
// keyless status endpoint show sender -> recipient. The quote's echoed
// `confidentiality` says which one a customer got (`private` below), and the
// screen must say "Preview · not private yet" whenever it is "public".
//
// THE SHAPE (live, 2026-10-15, read-only dry quotes; R-near / R-fit):
//   1. POST /v0/quote, origin = HyperCore USDC (8 decimals), EXACT_INPUT,
//      recipient = what the customer typed, refundTo = the customer's own
//      HyperCore account. dry:true prices it; dry:false (ONLY on Review, ONLY
//      through the shared proxy api/intents-quote.js) reserves a one-time
//      `depositAddress` on HyperCore,
//      bound to this amount, with a `deadline` after which the address is dead.
//   2. Hyperliquid info, read-only: preTransferCheck for that address (is it
//      sanctioned, does sending to it cost the ~1.0 USDC new-account fee),
//      userRole (a fresh address is "missing"), and the Perp withdrawable.
//   3. ONE visible signature: a Hyperliquid sendAsset of exactly amountIn from
//      the Perp account to that depositAddress (exchange/intentsOut.js builds it
//      UNSIGNED; the exchange client signs it with the wallet's window — the
//      silent allow-list never grows, and sendAsset is not on it).
//   4. GET /v0/status?depositAddress= until SUCCESS (withdrawStatus.js).
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. recipient is ONLY what the customer typed (EVM: EIP-55 checked, never
//      re-cased; Solana: base58, 32 bytes, never altered). There is no default.
//   2. refundTo is the customer's own HyperCore account, checked on the ECHO.
//   3. Every answer is verified before anything is shown or signed, on the
//      echoed request (not on the body we sent) and on the quote: assets,
//      amount to the last unit, swap type, slippage, deadline, recipient,
//      refundTo, no extra recipients/memos/fee takers, a depositAddress that is
//      a plain HyperCore account (not the user, not the recipient, no memo),
//      0 < minAmountOut <= amountOut, a cost within the route's (amountOut) and
//      a GUARANTEE (minAmountOut) no further below amountOut than the echoed
//      slippage on the amount sent, and a deadline far enough ahead.
//   4. Unknown is null, never 0: a fee that cannot be read blocks Confirm.
//   5. Nothing here signs, sends or holds a key. The one money step goes through
//      an injected `sendIntentsDeposit` (the exchange client's, visible), after
//      an idempotency record is WRITTEN AND READ BACK (withdrawJournal.js) in
//      the quote's OWN wallet's journal. A lost reply — and ANY answer that
//      does not prove nothing was posted (WITHDRAW_NOT_SENT_CODES) — is "not
//      confirmed", blocks the next withdrawal until reads settle it, and is
//      never sent again.
//   6. Caps: 5 <= amount <= 500 USDC per withdrawal, 1,000 USDC per day per
//      wallet (plan §7 guardrail 3, config.js PRIVATE_LIMITS), here (the
//      journal) AND at the shared proxy (guard.js, deposits + withdrawals).
//   7. Every EVM address is screened before ANY quote (sanctionsOracle.js +
//      Hyperliquid's own isSanctioned here; the oracle again at the proxy).
//      Unknown screening refuses.
//   8. No provider name reaches a money screen (plainIntentsWords).
//
// UNVERIFIED, named so nobody reads it as measured: no withdrawal has been sent
// from this code. Whether Hyperliquid takes the ~1.0 USDC new-account fee ON TOP
// (from the Perp balance) or OUT OF the amount sent (which would land the quote in
// INCOMPLETE_DEPOSIT and refund it after the deadline) is unknown until the
// owner's live test T3; the preflight demands withdrawable >= amount + fee so
// either way the money exists. The quote's ed25519 signature is not verified
// (no SDK in the bundle): `signatureVerified` is false on every quote.

import { isAddress as isViemAddress } from "viem";

import { HL_NETWORK, hlEndpoints } from "../hyperliquid/config.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import { chainLogoUrl } from "../relay/routes.js";
import { armSignWords, disarmSignWords } from "../../services/signWords.js";
import { oracleSanctioned, SANCTIONS_WORDS } from "./sanctionsOracle.js";
import {
  INTENTS_API, INTENTS_QUOTE_URL, PRIVATE_LIMITS, INTENTS_PLATFORM_FEE_ACCOUNTS, MAX_PLATFORM_FEE_BPS as SHARED_MAX_PLATFORM_FEE_BPS,
  CONFIDENTIALITY, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, QUOTE_DEADLINE_MS, QUOTE_TIMEOUT_MS,
  MAX_LOSS_FLAT_USDC, MAX_LOSS_SHARE, MIN_OUT_TOLERANCE_BPS,
} from "./config.js";
import { sdnListed } from "./ofacSdn.js";
import { HYPERCORE_USDC, ARBITRUM_INTENTS_USDC, AVALANCHE_INTENTS_USDC, BASE_INTENTS_USDC, POLYGON_INTENTS_USDC } from "./assets.js";
import { IntentsError, plainIntentsWords, postIntentsQuote } from "./client.js";

/* ── where the service is (shared with the deposit side: lib/intents/config.js) ── */

export const ONECLICK_API = INTENTS_API;
/** A page asks the SHARED proxy (api/intents-quote.js: key, kill switch, caps, screening, one day ledger for
    deposits and withdrawals together); Node (tests, scripts) asks the service directly. */
export const INTENTS_WITHDRAW_QUOTE_URL = INTENTS_QUOTE_URL;

/* ── the assets (live GET /v0/tokens, 2026-10-15; lib/intents/assets.js) ───── */

/** USDC in the Perp account, as the intents service names it. 8 decimals. The perps balance, not spot. */
export const HL_INTENTS_USDC = HYPERCORE_USDC;

/** The sendAsset `token` for that USDC, Hyperliquid's own id. Mirrors exchange/relayOut.js HL_USDC_TOKEN.mainnet (the suite asserts they agree). */
export const HL_USDC_SEND_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";

function dest(id, o) {
  return Object.freeze({
    id,
    chainId: o.chainId,
    chainName: o.chainName,
    kind: o.kind,
    token: "USDC",
    assetId: o.assetId,
    blockchain: o.blockchain,
    contractAddress: o.contractAddress,
    decimals: o.decimals,
    enabled: o.enabled,
    offReason: o.offReason || null,
    logo: "/tokens/usdc.svg",
    chainLogo: o.chainId != null ? chainLogoUrl(o.chainId) : null,
  });
}
const fromAsset = (a) => ({ chainId: a.chainId, assetId: a.assetId, blockchain: a.blockchain, contractAddress: a.contractAddress, decimals: a.decimals });

/**
 * Where a Private withdrawal can go: the owner's four chains ("เอา ARB, Avax,
 * Base, Polygon พอแระ", 2026-10-15), in his chain order for the money screens
 * (Base, then Avalanche second, then the rest): the four withdraw pairs the
 * shared proxy forwards (assets.js INTENTS_PAIRS). Each row is the asset GET
 * /v0/tokens lists (same contract, same decimals; withdrawRouteTokenProblems
 * re-checks). Data only for now: the Withdraw screen's Private side comes later.
 *
 * SOLANA IS PRICED, NOT OFFERED — and the owner's four chains leave it out
 * (2026-10-15), so it stays off whatever a screen exists. Its recipient cannot be asked the sanctions
 * oracle (EVM only), rule 7 refuses an unscreened address, and the shared proxy
 * forwards no Solana pair; so the row is enabled:false until a Solana screen
 * exists (a server copy of the OFAC SDN SOL list) and the owner adds the pair.
 * The verifier handles its quotes (tested on the live capture), so turning it
 * on is a flag here plus a pair there.
 */
export const PRIVATE_WITHDRAW_ROUTES = Object.freeze([
  dest("base-usdc", { ...fromAsset(BASE_INTENTS_USDC), chainName: "Base", kind: "evm", enabled: true }),
  dest("avalanche-usdc", { ...fromAsset(AVALANCHE_INTENTS_USDC), chainName: "Avalanche", kind: "evm", enabled: true }),
  dest("arbitrum-usdc", { ...fromAsset(ARBITRUM_INTENTS_USDC), chainName: "Arbitrum", kind: "evm", enabled: true }),
  dest("polygon-usdc", { ...fromAsset(POLYGON_INTENTS_USDC), chainName: "Polygon", kind: "evm", enabled: true }),
  dest("solana-usdc", {
    chainId: null, chainName: "Solana", kind: "solana", blockchain: "sol", decimals: 6, enabled: false,
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    offReason: "Private withdrawals to Solana aren't available yet.",
  }),
]);

export const DEFAULT_PRIVATE_WITHDRAW_ROUTE_ID = "base-usdc";

/** The destination with this id, or null. Callers pass THIS object on, never a copy. */
export function privateWithdrawRouteById(id) {
  return PRIVATE_WITHDRAW_ROUTES.find((r) => r.id === id) || null;
}

/** What in a GET /v0/tokens answer disagrees with the table (empty = every row and the origin are listed as written). */
export function withdrawRouteTokenProblems(tokens) {
  if (!Array.isArray(tokens)) return ["no token list"];
  const out = [];
  const byId = new Map(tokens.filter((t) => t && typeof t.assetId === "string").map((t) => [t.assetId, t]));
  const check = (label, want) => {
    const t = byId.get(want.assetId);
    if (!t) { out.push(`${label}: ${want.assetId} is not listed`); return; }
    if (t.decimals !== want.decimals) out.push(`${label}: decimals are ${t.decimals}, not ${want.decimals}`);
    if (String(t.contractAddress).toLowerCase() !== String(want.contractAddress).toLowerCase()) out.push(`${label}: contract is ${t.contractAddress}`);
    if (t.symbol !== "USDC") out.push(`${label}: symbol is ${t.symbol}`);
    if (want.blockchain && t.blockchain !== want.blockchain) out.push(`${label}: chain is ${t.blockchain}`);
  };
  check("origin", HL_INTENTS_USDC);
  for (const r of PRIVATE_WITHDRAW_ROUTES) check(r.id, r);
  return out;
}

/* ── the limits (the owner's, lib/intents/config.js PRIVATE_LIMITS) ───────── */

/** Plan Q6: a private withdrawal costs ~1.2 USDC, so less than this is mostly fee. */
export const PRIVATE_WITHDRAW_MIN_USDC = PRIVATE_LIMITS.withdrawMinUsdc;
/** Plan §7 guardrail 3: per move, and per wallet per day (the server counts deposits and withdrawals together per UTC day;
    this page's journal counts private withdrawals over a rolling 24 h). */
export const PRIVATE_WITHDRAW_MAX_USDC = PRIVATE_LIMITS.maxTxUsdc;
export const PRIVATE_WITHDRAW_DAY_CAP_USDC = PRIVATE_LIMITS.maxDayUsdc;
export const PRIVATE_DAY_MS = 86_400_000;
/** 1% (bps), as every live capture was priced. The echo must say the same. */
export const WITHDRAW_SLIPPAGE_BPS = DEFAULT_SLIPPAGE_BPS;
/** The request deadline: when a refund BEGINS if the swap has not completed. */
export const WITHDRAW_REFUND_AFTER_MS = QUOTE_DEADLINE_MS;
/** A real quote older than this is quoted again before anything is signed. */
export const WITHDRAW_QUOTE_TTL_MS = 60_000;
/** A preflight older than this is read again before anything is signed. */
export const WITHDRAW_PREFLIGHT_TTL_MS = 60_000;
/** The deposit address must stay alive at least this long after the quote … */
export const WITHDRAW_MIN_DEADLINE_LEFT_MS = 30 * 60_000;
/** … and at least this long at the moment the wallet is asked. */
export const WITHDRAW_SIGN_DEADLINE_LEFT_MS = 10 * 60_000;
/** The keyless service adds its own platform fee to the echo (1 bp seen live; docs: up to 25), to its own account only. */
export const MAX_PLATFORM_FEE_BPS = SHARED_MAX_PLATFORM_FEE_BPS;
/** A quote that would eat more than this share of the amount (at the minimum out) is refused outright. The
    tighter bounds — the route's cost at amountOut, and the echoed slippage at minAmountOut — follow it. */
export const MAX_QUOTE_COST_BPS = 1500;
/** Hyperliquid's new-account fee is 1 USDC (preTransferCheck said "1.0"). A higher one is refused, not shown. */
export const MAX_ACCOUNT_FEE_USDC = 1;
export const WITHDRAW_QUOTE_TIMEOUT_MS = QUOTE_TIMEOUT_MS;
export const WITHDRAW_INFO_TIMEOUT_MS = 10_000;
/** The roles a deposit address may have on Hyperliquid: a fresh account, or a plain one. */
export const DEPOSIT_ADDRESS_ROLES = Object.freeze(["missing", "user"]);

/* ── errors and words ─────────────────────────────────────────────────────── */

/* ONE error class and ONE scrub for the whole Private route (lib/intents/client.js),
   so a screen words the deposit's and the withdrawal's refusals from one list of
   codes: below-min, over-tx-cap, over-day-cap, private-mode-off, sanctioned,
   screen-unavailable, confidentiality-mismatch, rate-limited, network,
   intents-error, unsafe-quote — plus this file's own: bad-user, bad-route,
   route-off, bad-recipient, bad-amount, bad-request, testnet-off, no-journal,
   unsettled, used, registry. */
export const IntentsWithdrawError = IntentsError;
export { plainIntentsWords };

export const PRIVATE_WITHDRAW_WORDS = Object.freeze({
  belowMin: (min = PRIVATE_WITHDRAW_MIN_USDC) => `A private withdrawal needs at least ${min} USDC.`,
  overTxCap: (max = PRIVATE_WITHDRAW_MAX_USDC) => `A private withdrawal can be at most ${max} USDC.`,
  dayCap: (left, cap = PRIVATE_WITHDRAW_DAY_CAP_USDC) => `Private withdrawals are limited to ${cap.toLocaleString("en-US")} USDC a day. You can withdraw ${left} USDC more today.`,
  off: "Private isn't available right now.",
  notSent: "Nothing was sent.",
  notConfirmed: "Your withdrawal wasn't confirmed. Check your Perp balance before trying again: it was NOT sent twice.",
  feeUnknown: "Couldn't read the one-time account fee, so this can't be confirmed yet. Try again in a moment.",
  balanceUnknown: "Couldn't read what you can withdraw right now, so this can't be confirmed yet.",
  insufficient: "That's more than you can withdraw once the one-time account fee is included.",
  stale: "That price is out of date. Getting a fresh one.",
  used: "This quote was already used. Get a new one.",
});

/* ── addresses ────────────────────────────────────────────────────────────── */

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const DIGITS = /^[0-9]+$/;

/** A 20-byte hex address that is not the zero address. */
export function isEvmAddress(a) {
  return typeof a === "string" && HEX40.test(a) && a.toLowerCase() !== ZERO;
}

/** Same EVM address, whatever the casing. */
export function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && HEX40.test(a) && HEX40.test(b) && a.toLowerCase() === b.toLowerCase();
}

/* A mixed-case EVM address must pass EIP-55 (one wrong character fails it);
   all-lower and all-upper carry no checksum. The same verdict master.js's
   readDestinationAddress gives, so no two screens disagree. */
function evmChecksumOk(a) {
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return isViemAddress(a, { strict: true });
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Base58 to bytes, or null. BigInt: exact. */
export function base58Decode(s) {
  if (typeof s !== "string" || !s || !B58_RE.test(s)) return null;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

/* Addresses that are valid base58 keys and certainly NOT a person's wallet:
   the all-zero key (System Program, where money is burned), the token programs
   and USDC's own mint. All are common paste mistakes. */
const SOLANA_NOT_A_WALLET = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
]);

/**
 * The destination a customer typed, checked for the route's chain.
 *   ok       the address EXACTLY as typed (trimmed; never re-cased or cut)
 *   error    why it cannot be used, in plain words (null when empty)
 *   checksum whether an EIP-55 checksum was checked (EVM, mixed case)
 *   isOwn    the customer's own wallet (allowed; the screen may say so)
 * @param {unknown} input
 * @param {object} route a PRIVATE_WITHDRAW_ROUTES row
 * @param {{ own?: string|null }} o
 */
export function validatePrivateDestination(input, route, { own = null } = {}) {
  const raw = String(input == null ? "" : input).trim();
  const base = { ok: false, address: raw, error: null, empty: false, checksum: false, isOwn: false, kind: route ? route.kind : null };
  if (!raw) return { ...base, empty: true };
  const no = (error) => ({ ...base, error });
  if (!route || privateWithdrawRouteById(route.id) !== route) return no("Pick a network first.");
  if (route.kind === "evm") {
    if (!/^0x/i.test(raw)) return no("An address on this network starts with 0x.");
    if (!HEX40.test(raw)) return no("An EVM address is 0x and 40 more characters. Check you pasted the whole thing.");
    if (raw.toLowerCase() === ZERO) return no("That is the zero address: money sent there is burned.");
    if (/^0x0{36}dead$/i.test(raw)) return no("That address can never send the money back. Check it and paste it again.");
    if (!evmChecksumOk(raw)) return no("That address has a typo: its capitalisation doesn't check out (EIP-55). Paste it again.");
    const body = raw.slice(2);
    const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
    return { ...base, ok: true, checksum: mixed, isOwn: !!(own && sameAddress(raw, own)) };
  }
  if (route.kind === "solana") {
    if (/^0x/i.test(raw)) return no("That's an EVM address. A Solana address doesn't start with 0x.");
    const bytes = base58Decode(raw);
    if (!bytes || bytes.length !== 32 || raw.length < 32 || raw.length > 44) return no("That isn't a Solana address. Check you pasted the whole thing.");
    if (SOLANA_NOT_A_WALLET.has(raw)) return no("That's a program or token address, not a wallet. Paste your wallet's address.");
    return { ...base, ok: true };
  }
  return no("This network isn't supported.");
}

/** Does an echoed recipient equal the one typed? EVM: any casing; Solana: exactly. */
export function sameRecipient(route, a, b) {
  if (!route || typeof a !== "string" || typeof b !== "string") return false;
  return route.kind === "evm" ? sameAddress(a, b) : a === b;
}

/* ── amounts (BigInt, never a float) ──────────────────────────────────────── */

/**
 * A typed USDC amount, read for this route: { ok, units, hl, usdc } or
 * { ok:false, error }. `units` is the origin's 8 decimals as digits; `hl` is
 * Hyperliquid's 6-decimal string the sendAsset will carry. More than 6 decimals
 * is refused (Hyperliquid cannot send them), never rounded.
 */
export function parsePrivateWithdrawAmount(input) {
  const s = typeof input === "number" ? (Number.isFinite(input) ? input.toFixed(8).replace(/\.?0+$/, "") : "") : String(input == null ? "" : input).trim();
  if (!s || !/^\d*\.?\d*$/.test(s) || s === ".") return { ok: false, error: "Enter a USDC amount." };
  const [int = "", frac = ""] = s.split(".");
  if (frac.length > 6) return { ok: false, error: "USDC moves in steps of 0.000001. Use at most 6 decimals." };
  const units = BigInt(int || "0") * 10n ** 8n + BigInt((frac || "").padEnd(8, "0"));
  if (units <= 0n) return { ok: false, error: "Enter a USDC amount." };
  return { ok: true, units: units.toString(), hl: unitsToDecimal(units, 8), usdc: Number(unitsToDecimal(units, 8)) };
}

/** Base units as a plain decimal string ("19794700", 6 -> "19.7947"). */
export function unitsToDecimal(raw, decimals) {
  const n = typeof raw === "bigint" ? raw : BigInt(raw);
  if (n < 0n) throw new Error("negative amount");
  if (decimals === 0) return n.toString();
  const s = n.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/**
 * 8-decimal origin units as Hyperliquid's 6-decimal amount string, or null when
 * a digit below the sixth decimal is set (refused, never rounded).
 */
export function hlAmountFromUnits(raw) {
  if (typeof raw !== "string" || !DIGITS.test(raw)) return null;
  const n = BigInt(raw);
  if (n <= 0n || n % 100n !== 0n) return null;
  return unitsToDecimal(n, 8);
}

/* An amount of a `decimals`-place token in 8-decimal origin units (exact; a
   destination with more than 8 decimals is floored, which only ever makes a
   figure we compare against SMALLER, i.e. stricter). */
function toOriginUnits(raw, decimals) {
  const n = BigInt(raw);
  if (decimals === 8) return n;
  if (decimals < 8) return n * 10n ** BigInt(8 - decimals);
  return n / 10n ** BigInt(decimals - 8);
}

const big = (v) => (typeof v === "string" && DIGITS.test(v) ? BigInt(v) : null);
const fin = (v) => typeof v === "number" && Number.isFinite(v);

/* ── the quote request ────────────────────────────────────────────────────── */

/** The request deadline we ask for: second precision, so the echo compares exactly. */
export function refundDeadlineIso(now) {
  return new Date(Math.floor((now + WITHDRAW_REFUND_AFTER_MS) / 1000) * 1000).toISOString();
}

/**
 * The POST /v0/quote body. Origin is the Perp account's USDC; the customer
 * pays (refundTo = their own HyperCore account) and the typed address is paid.
 * `confidentiality` is the level the server's probe offers (readPrivateModeProbe):
 * the shared proxy refuses any other (409), so the page always knows which one it
 * asked for and the verifier holds the echo to it. No appFees, no memo, no
 * referral: a body is exactly these 13 keys and nothing else.
 */
export function buildIntentsWithdrawBody({ user, recipient, route, amountUsdc, dry, now, slippageBps = WITHDRAW_SLIPPAGE_BPS, confidentiality = "public" }) {
  if (!isEvmAddress(user)) throw new IntentsWithdrawError("bad-user", "Connect a wallet first.");
  if (!route || privateWithdrawRouteById(route.id) !== route) throw new IntentsWithdrawError("bad-route", "Pick a network first.");
  const to = validatePrivateDestination(recipient, route);
  if (!to.ok) throw new IntentsWithdrawError("bad-recipient", to.error || "Enter the address to withdraw to.");
  if (to.address !== recipient) throw new IntentsWithdrawError("bad-recipient", "Paste the address without spaces around it.");
  const amt = parsePrivateWithdrawAmount(amountUsdc);
  if (!amt.ok) throw new IntentsWithdrawError("bad-amount", amt.error);
  if (typeof dry !== "boolean") throw new IntentsWithdrawError("bad-request", "A quote is priced-only or real; say which.");
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new IntentsWithdrawError("bad-request", "Slippage out of range.");
  if (!CONFIDENTIALITY.includes(confidentiality)) throw new IntentsWithdrawError("bad-request", "Unknown privacy level.");
  if (!fin(now)) throw new IntentsWithdrawError("bad-request", "No clock.");
  return {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    originAsset: HL_INTENTS_USDC.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: route.assetId,
    amount: amt.units,
    refundTo: user.toLowerCase(),
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: refundDeadlineIso(now),
    confidentiality,
  };
}

/* ── the verifier ─────────────────────────────────────────────────────────── */

function unsafe(why) {
  return new IntentsWithdrawError("unsafe-quote", `The quote did not check out (${why}); nothing is signed`, { why });
}

/* What this file has verified, by identity: the signing gate takes nothing else. */
const VERIFIED_QUOTES = new WeakSet();
const VERIFIED_PREFLIGHTS = new WeakSet();

/** Did parseIntentsWithdrawQuote make this object (and nothing has copied it)? */
export function isVerifiedWithdrawQuote(q) {
  return !!q && typeof q === "object" && VERIFIED_QUOTES.has(q);
}

/** Did readWithdrawPreflight make this object? */
export function isVerifiedPreflight(p) {
  return !!p && typeof p === "object" && VERIFIED_PREFLIGHTS.has(p);
}

/* Request keys the echo must not carry: each one either pays somebody we did
   not choose, changes where the money lands, or ties the quote to a session. */
const FORBIDDEN_ECHO_KEYS = Object.freeze([
  "customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient", "connectedWallets", "sessionId", "referral", "rebates",
]);
const FORBIDDEN_QUOTE_KEYS = Object.freeze(["customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient", "depositMemo", "chainDepositAddresses"]);
const present = (v) => !(v == null || v === "" || (Array.isArray(v) && v.length === 0));

/**
 * Verify a POST /v0/quote answer for a Private withdrawal. Throws
 * IntentsWithdrawError("unsafe-quote") unless the answer provably takes exactly
 * `amountUsdc` of the user's Perp USDC and pays the TYPED recipient on this
 * route, refunding to the user. Returns a frozen, branded reading.
 *
 * @param {object} json the service's answer, as parsed
 * @param {{ user: string, recipient: string, route: object, amountUsdc: string|number, dry: boolean,
 *   deadline?: string|null, slippageBps?: number, now: number, expectConfidentiality?: string|null }} ctx
 *   deadline: the request deadline we sent (the echo must match it), when known
 */
export function parseIntentsWithdrawQuote(json, ctx = {}) {
  const { user, recipient, route, amountUsdc, dry, deadline = null, slippageBps = WITHDRAW_SLIPPAGE_BPS, now, expectConfidentiality = null } = ctx;
  if (!isEvmAddress(user)) throw new IntentsWithdrawError("bad-user", "Connect a wallet first.");
  if (!route || privateWithdrawRouteById(route.id) !== route) throw new IntentsWithdrawError("bad-route", "Pick a network first.");
  const to = validatePrivateDestination(recipient, route);
  if (!to.ok) throw new IntentsWithdrawError("bad-recipient", to.error || "Enter the address to withdraw to.");
  const amt = parsePrivateWithdrawAmount(amountUsdc);
  if (!amt.ok) throw new IntentsWithdrawError("bad-amount", amt.error);
  if (typeof dry !== "boolean" || !fin(now)) throw new IntentsWithdrawError("bad-request", "Nothing to check against.");

  if (!json || typeof json !== "object" || Array.isArray(json)) throw unsafe("the answer is not a quote");
  const q = json.quote && typeof json.quote === "object" ? json.quote : null;
  const r = json.quoteRequest && typeof json.quoteRequest === "object" ? json.quoteRequest : null;
  if (!q || !r) throw unsafe("the answer has no quote, or does not say what it was asked");

  /* 1. THE ECHO: what the service says it was asked. Ours, field by field. */
  if (r.dry !== dry) throw unsafe(dry ? "a priced-only request came back as a real one" : "a real request came back priced-only");
  if (r.swapType !== "EXACT_INPUT") throw unsafe("the swap type is not exact-input");
  if (r.slippageTolerance !== slippageBps) throw unsafe("the slippage is not the one asked for");
  if (r.originAsset !== HL_INTENTS_USDC.assetId) throw unsafe("the money does not leave from your Perp USDC");
  if (r.depositType !== "ORIGIN_CHAIN") throw unsafe("the deposit is not on the origin chain");
  if (r.destinationAsset !== route.assetId) throw unsafe("the destination token is not the route's");
  if (r.amount !== amt.units) throw unsafe("the amount is not the amount you entered");
  if (!sameAddress(r.refundTo, user)) throw unsafe("a refund would not come back to your account");
  if (r.refundType !== "ORIGIN_CHAIN") throw unsafe("a refund would not come back on the origin chain");
  if (!sameRecipient(route, r.recipient, recipient)) throw unsafe("the recipient is not the address you entered");
  if (r.recipientType !== "DESTINATION_CHAIN") throw unsafe("the recipient is not on the destination chain");
  if (r.depositMode != null && r.depositMode !== "SIMPLE") throw unsafe("the deposit mode is not the simple one");
  if (deadline != null && Date.parse(r.deadline) !== Date.parse(deadline)) throw unsafe("the refund time is not the one asked for");
  const refundStartsAt = Date.parse(r.deadline);
  if (!Number.isFinite(refundStartsAt)) throw unsafe("the refund time cannot be read");
  for (const k of FORBIDDEN_ECHO_KEYS) if (present(r[k])) throw unsafe(`the request carries ${k}`);

  const confidentiality = r.confidentiality == null ? "public" : r.confidentiality;
  if (!CONFIDENTIALITY.includes(confidentiality)) throw unsafe("the privacy mode cannot be read");
  if (expectConfidentiality != null && confidentiality !== expectConfidentiality) throw unsafe("the privacy mode is not the one this app asked for");

  /* The keyless service adds its OWN platform fee to the echo (live: 1 bp to its
     account 5880ad2b…47dd on Base and Solana, none on Arbitrum). Our body never
     carries one and the proxy refuses a body that does, so an echoed fee is
     accepted only to that account (config.js INTENTS_PLATFORM_FEE_ACCOUNTS, the
     deposit side's rule too) and only up to 25 bps; it is already inside amountOut. */
  const appFees = r.appFees == null ? [] : r.appFees;
  if (!Array.isArray(appFees)) throw unsafe("the fee list cannot be read");
  let platformFeeBps = 0;
  for (const f of appFees) {
    if (!f || typeof f !== "object" || typeof f.recipient !== "string" || !Number.isSafeInteger(f.fee) || f.fee < 0) throw unsafe("a fee cannot be read");
    if (!INTENTS_PLATFORM_FEE_ACCOUNTS.includes(f.recipient)) throw unsafe("a fee would be paid to somebody this app does not know");
    platformFeeBps += f.fee;
  }
  if (platformFeeBps > MAX_PLATFORM_FEE_BPS) throw unsafe("the service fee is higher than this app accepts");

  /* 2. THE QUOTE: amounts in base units, exactly. */
  if (q.amountIn !== amt.units) throw unsafe("the amount leaving is not the amount you entered");
  if (q.minAmountIn != null && q.minAmountIn !== amt.units) throw unsafe("the minimum deposit is not the amount you entered");
  const inRaw = BigInt(amt.units);
  const outRaw = big(q.amountOut);
  const minOutRaw = big(q.minAmountOut);
  if (outRaw == null || minOutRaw == null) throw unsafe("what arrives cannot be read");
  if (minOutRaw <= 0n || minOutRaw > outRaw) throw unsafe("the minimum that arrives is not below what is quoted");
  const outO = toOriginUnits(outRaw, route.decimals);
  const minOutO = toOriginUnits(minOutRaw, route.decimals);
  if (outO > inRaw) throw unsafe("more would arrive than leaves, so the units are wrong");
  if ((inRaw - minOutO) * 10000n > inRaw * BigInt(MAX_QUOTE_COST_BPS)) throw unsafe("the fees would take too much of this amount");
  /* The route's own cost (amountOut): what these routes charge, measured live (~0.21 USDC on 20), is far inside
     a flat 0.5 USDC plus 1 % (config.js, the deposit side's bound too). */
  const flatO = BigInt(Math.round(MAX_LOSS_FLAT_USDC * 1e8));
  const shareO = (inRaw * BigInt(Math.round(MAX_LOSS_SHARE * 10000))) / 10000n;
  if (inRaw - outO > flatO + shareO) throw unsafe("the fees would take too much of this amount (far above what this route charges)");
  /* 🔴 THE GUARANTEE (minAmountOut, the one figure the service promises) may sit below amountOut by the echoed
     slippage on the amount sent, plus a small tolerance (every live answer: exactly 1 %), and no further. */
  if (outO - minOutO > (inRaw * BigInt(slippageBps + MIN_OUT_TOLERANCE_BPS)) / 10000n) {
    throw unsafe("the fees would take too much of this amount (the least that arrives is far below the quote)");
  }
  const refundFeeRaw = q.refundFee == null ? null : big(q.refundFee);
  if (q.refundFee != null && refundFeeRaw == null) throw unsafe("the refund fee cannot be read");
  if (refundFeeRaw != null && refundFeeRaw >= inRaw) throw unsafe("a refund would return nothing");
  const withdrawFeeRaw = q.withdrawFee == null ? null : big(q.withdrawFee);
  const time = fin(q.timeEstimate) && q.timeEstimate >= 0 ? q.timeEstimate : null;
  for (const k of FORBIDDEN_QUOTE_KEYS) if (present(q[k])) throw unsafe(`the quote carries ${k}`);

  /* 3. THE DEPOSIT ADDRESS (a real quote only): a plain HyperCore account. */
  let depositAddress = null;
  let deadlineAt = null;
  let inactiveAt = null;
  if (dry) {
    if (present(q.depositAddress)) throw unsafe("a priced-only quote came with an address");
  } else {
    const a = q.depositAddress;
    if (!isEvmAddress(a)) throw unsafe("the deposit address is not a HyperCore account");
    if (/^0x0{36}dead$/i.test(a)) throw unsafe("the deposit address is a burn address");
    if (!evmChecksumOk(a)) throw unsafe("the deposit address fails its own checksum");
    if (sameAddress(a, user)) throw unsafe("the deposit address is your own account");
    if (route.kind === "evm" && sameAddress(a, recipient)) throw unsafe("the deposit address is the recipient");
    deadlineAt = Date.parse(q.deadline);
    if (!Number.isFinite(deadlineAt)) throw unsafe("the deposit address has no readable deadline");
    if (deadlineAt - now < WITHDRAW_MIN_DEADLINE_LEFT_MS) throw unsafe("the deposit address expires too soon");
    if (q.timeWhenInactive != null) {
      inactiveAt = Date.parse(q.timeWhenInactive);
      if (!Number.isFinite(inactiveAt)) throw unsafe("the deposit address has an unreadable inactive time");
      if (inactiveAt - now < WITHDRAW_MIN_DEADLINE_LEFT_MS) throw unsafe("the deposit address goes cold too soon");
    }
    depositAddress = a;
  }

  const serviceFeeO = inRaw - outO;
  const out = Object.freeze({
    dry,
    route,
    routeId: route.id,
    user: user.toLowerCase(),
    recipient,
    amountRaw: amt.units,
    amountUsdc: amt.hl,
    hlAmount: amt.hl,
    receiveRaw: outRaw.toString(),
    receive: unitsToDecimal(outRaw, route.decimals),
    minReceiveRaw: minOutRaw.toString(),
    minReceive: unitsToDecimal(minOutRaw, route.decimals),
    serviceFeeUsdc: unitsToDecimal(serviceFeeO < 0n ? 0n : serviceFeeO, 8),
    refundFeeRaw: refundFeeRaw == null ? null : refundFeeRaw.toString(),
    refundFeeUsdc: refundFeeRaw == null ? null : unitsToDecimal(refundFeeRaw, 8),
    withdrawFee: withdrawFeeRaw == null ? null : unitsToDecimal(withdrawFeeRaw, route.decimals),
    platformFeeBps,
    slippageBps,
    timeEstimateSec: time,
    depositAddress,
    deadlineAt,
    inactiveAt,
    refundStartsAt,
    confidentiality,
    private: confidentiality !== "public",
    correlationId: typeof json.correlationId === "string" ? json.correlationId : null,
    signature: typeof json.signature === "string" ? json.signature : null,
    signatureVerified: false,
    quotedAt: now,
  });
  VERIFIED_QUOTES.add(out);
  return out;
}

/** Is a real quote still fresh enough to sign, with its address alive long enough? */
export function withdrawQuoteFresh(quote, now = Date.now()) {
  if (!isVerifiedWithdrawQuote(quote) || quote.dry) return false;
  if (!fin(quote.quotedAt) || now - quote.quotedAt >= WITHDRAW_QUOTE_TTL_MS || now < quote.quotedAt) return false;
  return fin(quote.deadlineAt) && quote.deadlineAt - now >= WITHDRAW_SIGN_DEADLINE_LEFT_MS;
}

/* ── Hyperliquid info, read-only ──────────────────────────────────────────── */

/**
 * One POST to Hyperliquid's /info. Throws on a network failure, a non-2xx or
 * an unreadable body (the callers turn that into null, never into 0).
 */
export async function hlInfoRead(body, { fetchImpl = globalThis.fetch, timers = browserTimers, timeoutMs = WITHDRAW_INFO_TIMEOUT_MS, url = null, network = HL_NETWORK } = {}) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url || hlEndpoints(network).info, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || !res.ok) throw new Error(`info answered ${res ? res.status : "nothing"}`);
    return await res.json();
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
}

/** A decimal-string figure from an info answer, or null. */
function decimalOrNull(v) {
  if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * preTransferCheck, read: { isSanctioned, userExists, feeUsdc, userHasSentTx } with null for
 * anything unreadable. `user` is the DESTINATION, `source` the sender (live 2026-10-15:
 * a fresh address answers fee "1.0", userExists false; the Lazarus address isSanctioned true).
 */
export function readPreTransferCheck(json) {
  const o = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  return {
    isSanctioned: typeof o.isSanctioned === "boolean" ? o.isSanctioned : null,
    userExists: typeof o.userExists === "boolean" ? o.userExists : null,
    feeUsdc: decimalOrNull(o.fee),
    feeText: typeof o.fee === "string" ? o.fee : null,
    userHasSentTx: typeof o.userHasSentTx === "boolean" ? o.userHasSentTx : null,
  };
}

/* ── screening (before ANY quote) ─────────────────────────────────────────── */

const SCREEN_MEMO_MS = 10 * 60_000;
const screenMemo = new Map();

/**
 * Screen every address a Private withdrawal names, before it is quoted:
 * the user's own account and the recipient. EVM addresses are held to the
 * OFAC SDN copy (ofacSdn.js: listed refuses, no network), then asked the
 * sanctions oracle (REQUIRED: unknown refuses) and Hyperliquid's own
 * isSanctioned (ADDITIVE: a yes refuses, an unreadable answer is ignored).
 * A non-EVM recipient needs `screenOther`; without one it is unknown.
 *
 * @returns {Promise<{ ok: boolean, code: null|"sanctioned"|"screen-unavailable", message: string|null, results: object[] }>}
 */
export async function screenWithdrawAddresses({
  user, recipient, route,
  oracle = oracleSanctioned, info = hlInfoRead, screenOther = null,
  fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow,
} = {}) {
  const asks = [{ role: "user", address: user }, { role: "recipient", address: recipient }];
  const results = await Promise.all(asks.map(async ({ role, address }) => {
    if (route && route.kind !== "evm" && role === "recipient") {
      let s = null;
      try { s = typeof screenOther === "function" ? await screenOther(address, route) : null; } catch { s = null; }
      return { role, address, sanctioned: typeof s === "boolean" ? s : null, oracle: null, hl: null };
    }
    if (!isEvmAddress(address)) return { role, address, sanctioned: null, oracle: null, hl: null };
    /* The OFAC SDN copy (ofacSdn.js): no network, refuses before any other source is asked. */
    if (sdnListed(address)) return { role, address, sanctioned: true, oracle: null, hl: null, sdn: true };
    const key = address.toLowerCase();
    const memo = screenMemo.get(key);
    if (memo && now() - memo.at < SCREEN_MEMO_MS) return { role, address, ...memo.v };
    const [o, h] = await Promise.all([
      Promise.resolve().then(() => oracle(address, { fetchImpl, timers })).catch(() => ({ sanctioned: null })),
      Promise.resolve().then(() => info({ type: "preTransferCheck", user: address, source: isEvmAddress(user) ? user : address }, { fetchImpl, timers }))
        .then((j) => readPreTransferCheck(j).isSanctioned).catch(() => null),
    ]);
    const oracleSaid = o && typeof o.sanctioned === "boolean" ? o.sanctioned : null;
    const sanctioned = oracleSaid === true || h === true ? true : oracleSaid === false ? false : null;
    const v = { sanctioned, oracle: oracleSaid, hl: h };
    if (sanctioned !== null) screenMemo.set(key, { at: now(), v });
    if (screenMemo.size > 500) screenMemo.clear();
    return { role, address, ...v };
  }));
  if (results.some((x) => x.sanctioned === true)) return { ok: false, code: "sanctioned", message: SANCTIONS_WORDS.listed, results };
  if (results.some((x) => x.sanctioned !== false)) return { ok: false, code: "screen-unavailable", message: SANCTIONS_WORDS.unknown, results };
  return { ok: true, code: null, message: null, results };
}

/** Forget remembered screening answers (tests; a sign-out). */
export function clearScreenMemo() {
  screenMemo.clear();
}

/* ── the quote, end to end ────────────────────────────────────────────────── */

/**
 * Price a Private withdrawal (dry:true), or reserve its one-time address
 * (dry:false: only from Review, with the journal, never in a test or a
 * script). Reads only: screening, one POST through the shared transport
 * (lib/intents/client.js postIntentsQuote → api/intents-quote.js in a page),
 * nothing signed, nothing sent. Refusals are IntentsError codes (see above).
 *
 * @param {{ user: string, recipient: string, route: object, amountUsdc: string|number, dry?: boolean,
 *   confidentiality?: string, limits?: object, journal?: object|null, screen?: Function, fetchImpl?: Function,
 *   now?: () => number, timers?: object, network?: string, quoteUrl?: string }} o
 *   confidentiality, limits: what readPrivateModeProbe() said (the server may lower the caps, never raise them)
 * @returns {Promise<object>} the verified quote (parseIntentsWithdrawQuote)
 */
export async function quoteIntentsWithdraw({
  user, recipient, route, amountUsdc, dry = true, confidentiality = "public", limits = PRIVATE_LIMITS, journal = null,
  screen = screenWithdrawAddresses, fetchImpl = globalThis.fetch, now = browserNow, timers = browserTimers,
  network = HL_NETWORK, quoteUrl = INTENTS_WITHDRAW_QUOTE_URL,
} = {}) {
  if (network !== "mainnet") throw new IntentsWithdrawError("testnet-off", "Withdrawals work on mainnet only.");
  if (!isEvmAddress(user)) throw new IntentsWithdrawError("bad-user", "Connect a wallet first.");
  if (!route || privateWithdrawRouteById(route.id) !== route) throw new IntentsWithdrawError("bad-route", "Pick a network first.");
  if (!route.enabled) throw new IntentsWithdrawError("route-off", route.offReason || "This network isn't available for private withdrawals yet.");
  const to = validatePrivateDestination(recipient, route);
  if (!to.ok) throw new IntentsWithdrawError("bad-recipient", to.error || "Enter the address to withdraw to.");
  const amt = parsePrivateWithdrawAmount(amountUsdc);
  if (!amt.ok) throw new IntentsWithdrawError("bad-amount", amt.error);
  if (!CONFIDENTIALITY.includes(confidentiality)) throw new IntentsWithdrawError("bad-request", "Unknown privacy level.");
  const lim = limits && typeof limits === "object" ? limits : PRIVATE_LIMITS;
  /* The server may only LOWER a cap or RAISE a minimum (client.js readPrivateModeProbe); never the other way here either. */
  const min = Math.max(PRIVATE_WITHDRAW_MIN_USDC, fin(lim.withdrawMinUsdc) ? lim.withdrawMinUsdc : 0);
  const max = Math.min(PRIVATE_WITHDRAW_MAX_USDC, fin(lim.maxTxUsdc) && lim.maxTxUsdc > 0 ? lim.maxTxUsdc : PRIVATE_WITHDRAW_MAX_USDC);
  if (amt.usdc < min) throw new IntentsWithdrawError("below-min", PRIVATE_WITHDRAW_WORDS.belowMin(min));
  if (amt.usdc > max) throw new IntentsWithdrawError("over-tx-cap", PRIVATE_WITHDRAW_WORDS.overTxCap(max));

  /* A real quote reserves an address the customer is about to pay: the day cap
     and the "nothing unsettled" rule are read from the journal first. */
  if (!dry) {
    if (!journal || typeof journal.canStart !== "function") throw new IntentsWithdrawError("no-journal", "This browser can't keep a record of the withdrawal, so nothing was priced.");
    if (journal.user != null && !sameAddress(journal.user, user)) throw new IntentsWithdrawError("wrong-journal", "This record belongs to a different wallet, so nothing was priced. Reconnect and try again.");
    const can = journal.canStart({ amountRaw: amt.units, now: now() });
    /* The journal's day cap counts the last 24 hours: its `left` rides along (as the server's does) so the screen can
       print it in two decimals and offer it as the smaller amount. */
    const left = can && can.code === "over-day-cap" && can.leftUsdc != null ? Number(can.leftUsdc) : null;
    if (!can || can.ok !== true) {
      throw new IntentsWithdrawError((can && can.code) || "unsettled", (can && can.message) || "Another withdrawal is still settling.", Number.isFinite(left) ? { left, rolling: true } : null);
    }
  }

  /* Screening, before ANY quote (the shared proxy screens again, server-side). */
  const s = await screen({ user, recipient, route, fetchImpl, timers, now });
  if (!s || s.ok !== true) throw new IntentsWithdrawError((s && s.code) || "screen-unavailable", (s && s.message) || SANCTIONS_WORDS.unknown);

  const body = buildIntentsWithdrawBody({ user, recipient, route, amountUsdc, dry, now: now(), confidentiality });
  const json = await postIntentsQuote(body, { fetchImpl, timers, url: quoteUrl });
  return parseIntentsWithdrawQuote(json, {
    user, recipient, route, amountUsdc, dry, deadline: body.deadline, now: now(), expectConfidentiality: confidentiality,
  });
}

/* ── the preflight: what Hyperliquid says about this transfer ─────────────── */

/**
 * Read, for a REAL quote, what the sendAsset will meet: is the deposit address
 * sanctioned, a plain account, and what does sending to it cost (the one-time
 * account fee)? And can the Perp account cover amount + that fee? Reads only.
 * Never throws. ok:false names what blocks Confirm; an unreadable figure is
 * null and blocks it too (rule 4).
 *
 * @param {{ quote: object, withdrawableUsdc?: number|null, info?: Function,
 *   fetchImpl?: Function, timers?: object, now?: () => number }} o
 *   withdrawableUsdc: the Perp withdrawable the screen already shows; when
 *   absent, clearinghouseState's own `withdrawable` is read.
 */
export async function readWithdrawPreflight({ quote, withdrawableUsdc = undefined, info = hlInfoRead, fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow } = {}) {
  const refuse = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });
  if (!isVerifiedWithdrawQuote(quote) || quote.dry || !quote.depositAddress) return refuse("bad-quote", "There is no real quote to check yet.");
  const opts = { fetchImpl, timers };
  const [ptc, role, chs] = await Promise.all([
    info({ type: "preTransferCheck", user: quote.depositAddress, source: quote.user }, opts).then(readPreTransferCheck).catch(() => null),
    info({ type: "userRole", user: quote.depositAddress }, opts).then((j) => (j && typeof j.role === "string" ? j.role : null)).catch(() => null),
    withdrawableUsdc === undefined || withdrawableUsdc === null
      ? info({ type: "clearinghouseState", user: quote.user }, opts).then((j) => decimalOrNull(j && j.withdrawable)).catch(() => null)
      : Promise.resolve(fin(withdrawableUsdc) && withdrawableUsdc >= 0 ? withdrawableUsdc : null),
  ]);
  const checkedAt = now();
  const base = {
    depositAddress: quote.depositAddress,
    quotedAt: quote.quotedAt,
    checkedAt,
    role,
    isSanctioned: ptc ? ptc.isSanctioned : null,
    userExists: ptc ? ptc.userExists : null,
    accountFeeUsdc: ptc ? ptc.feeUsdc : null,
    withdrawableUsdc: chs,
  };
  if (!ptc || ptc.isSanctioned === null) return refuse("check-unknown", "Couldn't check the transfer just now, so this can't be confirmed yet.", base);
  if (ptc.isSanctioned === true) return refuse("sanctioned", SANCTIONS_WORDS.listed, base);
  if (role === null) return refuse("check-unknown", "Couldn't check the transfer just now, so this can't be confirmed yet.", base);
  if (!DEPOSIT_ADDRESS_ROLES.includes(role)) return refuse("bad-deposit-address", "The quote's deposit address isn't a plain account, so nothing was signed. Get a new quote.", base);
  if (ptc.feeUsdc === null) return refuse("fee-unknown", PRIVATE_WITHDRAW_WORDS.feeUnknown, base);
  if (ptc.feeUsdc > MAX_ACCOUNT_FEE_USDC) return refuse("fee-high", "The one-time account fee is higher than expected, so nothing was signed.", base);
  if (chs === null) return refuse("balance-unknown", PRIVATE_WITHDRAW_WORDS.balanceUnknown, base);
  /* In micro-USDC, so 0.1 + 0.2 is never a problem. */
  const needMicro = BigInt(quote.amountRaw) / 100n + BigInt(Math.round(ptc.feeUsdc * 1e6));
  const haveMicro = BigInt(Math.floor(chs * 1e6));
  if (haveMicro < needMicro) return refuse("insufficient", PRIVATE_WITHDRAW_WORDS.insufficient, { ...base, needsUsdc: unitsToDecimal(needMicro, 6) });
  const out = Object.freeze({ ok: true, code: null, message: null, ...base, needsUsdc: unitsToDecimal(needMicro, 6) });
  VERIFIED_PREFLIGHTS.add(out);
  return out;
}

/** Is a preflight this quote's, ok, and fresh enough to sign on? */
export function preflightFresh(preflight, quote, now = Date.now()) {
  return isVerifiedPreflight(preflight) && preflight.ok === true && isVerifiedWithdrawQuote(quote)
    && sameAddress(preflight.depositAddress, quote.depositAddress) && preflight.quotedAt === quote.quotedAt
    && fin(preflight.checkedAt) && now - preflight.checkedAt < WITHDRAW_PREFLIGHT_TTL_MS && now >= preflight.checkedAt;
}

/* ── the review the screen prints ─────────────────────────────────────────── */

/**
 * The figures of the confirm screen, every one from the verified quote and
 * the preflight (null when unknown — the screen prints a dash, never 0).
 * `confirmable` is the ONE answer to "may the Confirm button work".
 */
export function privateWithdrawReview({ quote, preflight = null, now = Date.now() } = {}) {
  if (!isVerifiedWithdrawQuote(quote)) return null;
  const fee = preflight && preflight.accountFeeUsdc != null ? preflight.accountFeeUsdc : null;
  const toMicro = (dec) => BigInt(Math.round(Number(dec) * 1e6));
  const total = fee == null ? null : unitsToDecimal(toMicro(quote.serviceFeeUsdc) + BigInt(Math.round(fee * 1e6)), 6);
  let why = null;
  if (quote.dry) why = "priced-only";
  else if (!withdrawQuoteFresh(quote, now)) why = "stale";
  else if (!preflight) why = "unchecked";
  else if (preflight.ok !== true) why = preflight.code || "blocked";
  else if (!preflightFresh(preflight, quote, now)) why = "recheck";
  return Object.freeze({
    amountUsdc: quote.amountUsdc,
    chainName: quote.route.chainName,
    recipient: quote.recipient,
    receive: quote.receive,
    minReceive: quote.minReceive,
    serviceFeeUsdc: quote.serviceFeeUsdc,
    accountFeeUsdc: fee == null ? null : unitsToDecimal(BigInt(Math.round(fee * 1e6)), 6),
    totalFeeUsdc: total,
    refundFeeUsdc: quote.refundFeeUsdc,
    etaSec: quote.timeEstimateSec,
    private: quote.private,
    confidentiality: quote.confidentiality,
    deadlineAt: quote.deadlineAt,
    confirmable: why === null,
    why,
    message: why && preflight && preflight.ok !== true ? preflight.message : null,
  });
}

/* ── doing it: the one money step ─────────────────────────────────────────── */

/**
 * The wallet step's answers that PROVE the sendAsset was never executed: the
 * gate or the client refused before anything was signed or posted, the wallet
 * declined or never answered, or Hyperliquid itself answered with a refusal
 * (an "err" reply or a 4xx). ONLY these record "not-sent". Every other answer —
 * a lost reply, "bad_response" (a 2xx Hyperliquid answered that could not be
 * read: the action may have executed), "network", "not_confirmed", an unknown
 * code — is "not confirmed": the record stays "unknown" and blocks the next
 * withdrawal until the status follow-up (reads only) settles it.
 */
export const WITHDRAW_NOT_SENT_CODES = Object.freeze([
  /* refused before the wallet was asked (exchange/intentsOut.js, the exchange client's gate) */
  "unsupported", "no_wallet", "wallet_mismatch", "wallet_chain_unknown", "wallet_not_ready", "walletconnect_unsupported",
  "busy", "state_unknown", "bad_quote", "wrong_network", "quote_expired", "recheck", "amount_mismatch", "not_usdc",
  "silent_list_changed", "bad_nonce", "bad_types",
  /* the wallet declined, failed to sign, or never answered (the request was dropped) */
  "user_rejected", "signature_rejected", "signature_failed", "wallet_timeout", "wallet_chain_mismatch",
  /* Hyperliquid answered, and the answer was a refusal */
  "hl_error", "rate_limited", "signature_not_recognized", "must_deposit", "agent_missing",
]);
const NOT_SENT_CODES = new Set(WITHDRAW_NOT_SENT_CODES);

/**
 * Send the Private withdrawal: write the idempotency record, then ONE visible
 * signature through the exchange client's `sendIntentsDeposit` (which builds
 * the sendAsset with exchange/intentsOut.js and signs it with the wallet's window).
 * Never throws, never retries.
 *
 * @param {{ quote: object, preflight: object, journal: object,
 *   sendIntentsDeposit: (o: { quote: object, preflight: object, amountUsdc: string|number }) => Promise<{ ok: boolean, code?: string, message?: string, lost?: boolean }>,
 *   amountUsdc?: string|number|null, signWords?: object|null, now?: () => number, onPhase?: (p: string) => void }} o
 *   amountUsdc: what the customer typed (checked against the quote here, and again by the gate)
 * @returns {Promise<{ ok: true, depositAddress, sentAt } | { ok: false, code, message, notConfirmed?: true, nothingSent?: true, depositAddress? }>}
 *   notConfirmed: the reply was lost after the wallet was asked; the money may
 *   be on its way. The caller must NOT offer to send again; the status follow-up
 *   (withdrawStatus.js) settles it.
 */
export async function executeIntentsWithdraw({ quote, preflight, journal, sendIntentsDeposit, amountUsdc = null, signWords = null, now = browserNow, onPhase = () => {} } = {}) {
  const before = (code, message) => ({ ok: false, code, message: plainIntentsWords(message), nothingSent: true });
  if (!isVerifiedWithdrawQuote(quote) || quote.dry || !quote.depositAddress) return before("bad-quote", "No quote to send.");
  /* The amount the customer typed, when the screen hands it in: it must be the quote's to the last unit. */
  if (amountUsdc != null) {
    const typed = parsePrivateWithdrawAmount(amountUsdc);
    if (!typed.ok || typed.units !== quote.amountRaw) return before("amount_mismatch", "This quote is for a different amount than the one you entered, so nothing was sent.");
  }
  if (typeof sendIntentsDeposit !== "function") return before("unsupported", "This wallet can't sign a private withdrawal here yet, so nothing was sent.");
  if (!journal || typeof journal.claim !== "function" || typeof journal.settle !== "function") return before("no-journal", "This browser can't keep a record of the withdrawal, so nothing was sent.");
  /* 🔴 The record, the "nothing new while unsettled" block and the day cap are the QUOTE's wallet's. */
  if (!sameAddress(journal.user, quote.user)) return before("wrong-journal", "This record belongs to a different wallet, so nothing was sent. Reconnect and try again.");
  if (!withdrawQuoteFresh(quote, now())) return before("stale-quote", PRIVATE_WITHDRAW_WORDS.stale);
  if (!preflightFresh(preflight, quote, now())) return before("recheck", "The transfer check is out of date. Checking again.");

  /* THE RECORD, written and read back BEFORE the wallet is asked. A second run
     of this quote — a double tap, a retry, another tab — finds it and stops. */
  let claim;
  try {
    claim = journal.claim({
      depositAddress: quote.depositAddress,
      routeId: quote.routeId,
      recipient: quote.recipient,
      amountRaw: quote.amountRaw,
      accountFeeUsdc: preflight.accountFeeUsdc,
      deadlineAt: quote.deadlineAt,
      refundStartsAt: quote.refundStartsAt,
      correlationId: quote.correlationId,
      confidentiality: quote.confidentiality,
      now: now(),
    });
  } catch {
    claim = null;
  }
  if (!claim || claim.ok !== true) {
    return before((claim && claim.code) || "registry", (claim && claim.message) || "This browser couldn't record the withdrawal, so nothing was sent.");
  }
  const id = quote.depositAddress;
  const settle = (state, patch = {}) => { try { journal.settle(id, state, { ...patch, now: now() }); } catch { /* the outcome stands; status re-reads it */ } };

  let r;
  try {
    onPhase("sending");
    if (signWords) armSignWords(signWords); else disarmSignWords();
    r = await sendIntentsDeposit({ quote, preflight, amountUsdc: amountUsdc == null ? quote.amountUsdc : amountUsdc });
  } catch (e) {
    settle("unknown", { why: "threw" });
    return { ok: false, code: "unexpected", message: PRIVATE_WITHDRAW_WORDS.notConfirmed, notConfirmed: true, depositAddress: id };
  } finally {
    disarmSignWords();
  }
  if (!r || typeof r !== "object") {
    settle("unknown", { why: "no-answer" });
    return { ok: false, code: "unexpected", message: PRIVATE_WITHDRAW_WORDS.notConfirmed, notConfirmed: true, depositAddress: id };
  }
  if (r.ok !== true) {
    /* Refused with a reason that PROVES nothing was executed (declined in the
       wallet, the wallet timed out and the request was dropped, Hyperliquid said
       no): nothing moved. The record keeps this quote from being used again; a
       new withdrawal is a new quote. */
    if (r.lost !== true && NOT_SENT_CODES.has(r.code)) {
      settle("not-sent", { why: r.code });
      return { ok: false, code: r.code, message: plainIntentsWords(r.message || "The transfer was refused. Nothing was sent."), nothingSent: true, depositAddress: id };
    }
    /* Anything else may have gone through: unknown, blocks the next one, never sent again. */
    settle("unknown", { why: r.code || "lost" });
    return { ok: false, code: r.code || "not_confirmed", message: PRIVATE_WITHDRAW_WORDS.notConfirmed, notConfirmed: true, depositAddress: id };
  }
  const sentAt = now();
  settle("sent", { sentAt });
  onPhase("sent");
  return { ok: true, depositAddress: id, sentAt, amountUsdc: quote.amountUsdc, receive: quote.receive, route: quote.route, recipient: quote.recipient };
}
