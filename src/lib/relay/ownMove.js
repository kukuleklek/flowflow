// ─────────────────────────────────────────────────────────────────────────────
// A MOVE FROM THE USER'S OWN PERP ACCOUNT TO THEIR OWN AVAX WALLET: the quote it
// must be, and the two signatures that make it — with the flow registry written
// before the one that moves money.
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §3.2 steps 2–6, §3.6, §3.8. Two moves use this file:
//   * move-in (lib/relay/moveIn.js): 1337 USDC (Perps) → 43114 USDC, EXACT_OUTPUT
//     X, optionally with a gas top-up the user sees on the card;
//   * gas top-up (lib/relay/gasTopup.js): 1337 USDC (Perps) → 43114 native AVAX,
//     EXACT_OUTPUT.
// Both answer the SAME two steps as today's Withdraw (authorize, then the
// sendAsset to Relay's depository), so the signing is withdraw.js's own
// executeRelayWithdraw, UNCHANGED, wrapped here (plan: "executeRelayWithdraw ไม่แก้").
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. There is NO recipient parameter anywhere. user = recipient = refundTo =
//      the user's own embedded address, passed as `own` and re-read through
//      `ownNow()` before every window (plan §3.8.2). A quote that names any other
//      party — except Relay's pinned HyperCore depository — is refused.
//   2. parseOwnMoveQuote is stricter than parseWithdrawQuote (which it runs
//      first): exactly what arrives (amount == minimum == X), one payment to own,
//      no calls, no app fee, the top-up exactly as asked or absent, the debit
//      under maxDebit, the debit representable in the sendAsset's 6 decimals, and
//      the depository pinned rather than taken from the quote.
//   3. The flow registry is written BEFORE the sendAsset window (the window that
//      moves money). If it cannot be written, the window never opens.
//   4. A quote older than 60 s when the second window is due is "Price expired.
//      Nothing moved." — never signed.
//   5. A lost or unclear reply after the sendAsset is UNKNOWN, never a refusal:
//      "May have left your Perp account. Don't send it again." No Try again.
//
// 🔴 PLAN DEVIATION (report it): §3.2 says `output.extraData == 0x`. Every live
// 1337 → 43114 answer (q1, q6, q15, and the move-in captured 2026-10-15) carries
// extraData = the v3 erc20Router, abi-encoded. That rule would refuse every
// move-in, so extraData must be 0x OR one of the two pinned routers.
//
// Nothing here signs by itself, holds a key or talks to a chain: signAuthorize /
// sendDeposit are the exchange layer's own calls (the backend seam), and both
// show the wallet's window.

import {
  RELAY_QUOTE_URL, HL_RELAY_CHAIN_ID, HL_PERP_USDC, HL_PERP_USDC_DECIMALS,
} from "./routes.js";
import {
  parseWithdrawQuote, executeRelayWithdraw, isEvmAddress, sameAddress, plainMoneyWords,
  RELAY_WITHDRAW_QUOTE_TTL_MS, WITHDRAW_QUOTE_TIMEOUT_MS,
} from "./withdraw.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import {
  AVAX_CHAIN_ID, AVAX_USDC, AVAX_USDC_DECIMALS, NATIVE, HL_DEPOSITORY, RELAY_ROUTERS,
} from "../avax/relayPins.js";
import { formatRaw, toRaw } from "../avax/swapDecode.js";
import { gasRow } from "../avax/gas.js";
import { claimRun, confirmedNumber } from "../avax/run.js";

/** The quote TTL a move is signed within (plan §2.9 quoteTtlS 60). */
export const OWN_MOVE_QUOTE_TTL_MS = RELAY_WITHDRAW_QUOTE_TTL_MS;
/** A gas top-up answer may deliver between half and one and a half times what was asked (firstDeposit.js's rule). */
export const TOPUP_MIN_SHARE = 0.5;
export const TOPUP_MAX_SHARE = 1.5;
/** Relay's gas top-up scale: a MILLIONTH of a dollar per unit (measured, firstDeposit.js). */
export const TOPUP_SCALE_PER_USD = 1_000_000;
/**
 * The AVAX price a gas top-up may IMPLY (its own amountUsd ÷ its AVAX) when the caller
 * has no independent price to hand: anything outside is refused (ATK-12: 1 wei "worth"
 * $0.30). With `avaxUsd` passed, the AVAX delivered is valued at it instead, inside the
 * same 0.5×–1.5× band as the $ asked.
 */
export const TOPUP_IMPLIED_AVAX_USD = Object.freeze({ min: 0.5, max: 5000 });
/**
 * With an independent AVAX price, the AVAX a top-up delivers must be worth 0.9×–1.1× the $
 * asked: the card and the window print "includes ≈0.03 AVAX for gas (≈$0.30)" with the $
 * ASKED, so the AVAX must really be worth about that (live answers: 0.9977×–1.0004×). What
 * Relay charges for it beyond that is FEE (parseOwnMoveQuote nets the printed $, not Relay's).
 */
export const TOPUP_WORTH_MIN_SHARE = 0.9;
export const TOPUP_WORTH_MAX_SHARE = 1.1;

const SEND_ASSET_KEYS = Object.freeze(["hyperliquidChain", "destination", "sourceDex", "destinationDex", "token", "amount", "fromSubAccount", "nonce"]);

export class OwnMoveError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "OwnMoveError";
    this.code = code;
    this.detail = detail;
  }
}

const unsafe = (why) => new OwnMoveError("unsafe-quote", `The move's price did not check out (${why}); nothing is signed`, { why });
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const DIGITS = /^[0-9]+$/;
const big = (v) => (typeof v === "string" && DIGITS.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : typeof v === "bigint" ? v : null);
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pad32 = (addr) => `0x${"0".repeat(24)}${lower(addr).slice(2)}`;
const ROUTER_EXTRA = RELAY_ROUTERS.map(pad32);

/* ── one guarded POST /quote/v2 for every builder in this track ─────────── */

/**
 * POST one /quote/v2 body (through our key proxy in a page, straight to Relay
 * in Node) and return the JSON. Reads only: a quote executes nothing. Throws
 * OwnMoveError "network" | "relay-error" | "bad-response"; the service's own
 * words are scrubbed of its name before they can reach a screen.
 */
export async function postRelayQuote(body, { fetchImpl = globalThis.fetch, timers = browserTimers, signal = null, url = RELAY_QUOTE_URL, timeoutMs = WITHDRAW_QUOTE_TIMEOUT_MS } = {}) {
  const ctrl = !signal && typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal || (ctrl ? ctrl.signal : undefined),
    });
  } catch (e) {
    throw new OwnMoveError("network", "Couldn't reach the pricing service. Nothing moved.", { cause: String((e && e.message) || e) });
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    const msg = json && typeof json.message === "string" ? json.message : `the service answered ${res.status}`;
    throw new OwnMoveError("relay-error", plainMoneyWords(msg), { status: res.status, errorCode: (json && json.errorCode) || null });
  }
  if (!json || typeof json !== "object") throw new OwnMoveError("bad-response", "The price could not be read. Nothing moved.");
  return json;
}

/* ── the quote ────────────────────────────────────────────────────────────── */

/** Where an own move into Avalanche lands: USDC (6 dp) or native AVAX (18 dp). */
export const OWN_MOVE_DEST = Object.freeze({
  usdc: Object.freeze({ id: "usdc", chainId: AVAX_CHAIN_ID, address: AVAX_USDC, decimals: AVAX_USDC_DECIMALS, symbol: "USDC" }),
  avax: Object.freeze({ id: "avax", chainId: AVAX_CHAIN_ID, address: NATIVE, decimals: 18, symbol: "AVAX" }),
});

/**
 * The /quote/v2 body of an own move INTO Avalanche. EXACT_OUTPUT: `amountRaw` is
 * what ARRIVES, in the destination's own base units, so the card can print a
 * guaranteed figure. No recipient parameter: every role is `own`.
 * @param {{ own: string, dest: "usdc"|"avax", amountRaw: string|bigint, topupUsd?: number|null }} o
 */
export function buildOwnMoveQuoteBody({ own, dest, amountRaw, topupUsd = null }) {
  if (!isEvmAddress(own)) throw new OwnMoveError("bad-user", "Sign in first.");
  const d = OWN_MOVE_DEST[dest];
  if (!d) throw new OwnMoveError("bad-dest", "That is not a place this app moves money to.");
  const raw = big(amountRaw);
  if (raw == null || raw <= 0n) throw new OwnMoveError("bad-amount", "Enter an amount to move.");
  const body = {
    user: own,
    recipient: own,
    refundTo: own,
    originChainId: HL_RELAY_CHAIN_ID,
    originCurrency: HL_PERP_USDC,
    destinationChainId: AVAX_CHAIN_ID,
    destinationCurrency: d.address,
    amount: raw.toString(),
    tradeType: "EXACT_OUTPUT",
  };
  if (topupUsd != null) {
    if (dest !== "usdc") throw new OwnMoveError("bad-topup", "Gas comes with a USDC move only.");
    const units = Math.round(Number(topupUsd) * TOPUP_SCALE_PER_USD);
    if (!Number.isSafeInteger(units) || units <= 0) throw new OwnMoveError("bad-topup", "The gas amount is not readable.");
    /* 🔴 Always explicit: leaving the amount out takes Relay's $2 default (firstDeposit.js). */
    body.topupGas = true;
    body.topupGasAmount = String(units);
  }
  return body;
}

/**
 * Verify an own-move answer (1337 → 43114) and read what the card and the two
 * windows need. Runs parseWithdrawQuote first (every Withdraw rule), then the
 * own-move rules on top (header, rule 2).
 *
 * @param {object} json
 * @param {{ own: string, dest: "usdc"|"avax", amountRaw: string|bigint, topupUsd?: number|null,
 *   maxDebitUsdc: number, now?: number }} o
 * @returns frozen review: requestId, amountRaw, amountIn (USDC leaving, number), amountInRaw (8 dp),
 *   maxDebitUsdc, feeUsdc (net of the top-up; null if unknown), topup ({ raw, avax, usd }|null),
 *   gasRow (the printed "Gas for later" row, or null), hlNonce, steps (raw, for the signer), quotedAt
 */
export function parseOwnMoveQuote(json, { own, dest, amountRaw, topupUsd = null, maxDebitUsdc, avaxUsd = null, now = Date.now() } = {}) {
  if (!isEvmAddress(own)) throw new OwnMoveError("bad-user", "Sign in first.");
  const d0 = OWN_MOVE_DEST[dest];
  if (!d0) throw new OwnMoveError("bad-dest", "That is not a place this app moves money to.");
  const want = big(amountRaw);
  if (want == null || want <= 0n) throw new OwnMoveError("bad-amount", "Enter an amount to move.");
  const ceiling = num(maxDebitUsdc);
  if (ceiling == null || ceiling <= 0) throw new OwnMoveError("bad-ceiling", "The most this move may cost was not set.");

  let base;
  try {
    base = parseWithdrawQuote(json, { user: own, recipient: own, route: { id: `own-${dest}`, chainId: d0.chainId, address: d0.address }, amountUsdc: null, now });
  } catch (e) {
    throw unsafe(e && e.detail && e.detail.why ? e.detail.why : String((e && e.message) || e));
  }

  const det = json.details || {};
  const cin = det.currencyIn || {};
  const cout = det.currencyOut || {};
  if (Number(cout.currency && cout.currency.decimals) !== d0.decimals) throw unsafe("the token arriving is not the one asked for");
  if (Number(cin.currency && cin.currency.decimals) !== HL_PERP_USDC_DECIMALS) throw unsafe("the money leaving is not your Perp USDC");
  /* EXACT_OUTPUT: what arrives is exact, not a hope. */
  if (big(cout.amount) !== want || big(cout.minimumAmount) !== want) throw unsafe("what arrives is not exactly the amount asked for");

  const v2 = json.protocol.v2;
  const out = v2.orderData.output || {};
  if (out.chainId !== "avalanche") throw unsafe("the order pays on another network");
  const pays = Array.isArray(out.payments) ? out.payments : [];
  if (pays.length !== 1) throw unsafe("the order pays more than once");
  const p = pays[0];
  if (!sameAddress(p.recipient, own) || lower(p.currency) !== d0.address) throw unsafe("the order does not pay your own wallet");
  if (big(p.minimumAmount) !== want || big(p.expectedAmount) !== want) throw unsafe("the order pays another amount");
  if (!Array.isArray(out.calls) || out.calls.length !== 0) throw unsafe("the order runs calls on Avalanche");
  const extra = lower(out.extraData == null ? "0x" : out.extraData);
  if (extra !== "0x" && !ROUTER_EXTRA.includes(extra)) throw unsafe("the order carries data it should not");
  const refunds = (v2.orderData.inputs || []).flatMap((i) => (i && Array.isArray(i.refunds) ? i.refunds : []));
  if (!refunds.every((r) => r && sameAddress(r.recipient, own))) throw unsafe("a refund would go to another address");

  const app = json.fees && json.fees.app;
  if (app && big(app.amount) !== 0n) throw unsafe("the answer adds an app fee");

  /* What leaves the Perp account. */
  const inRaw = big(cin.amount);
  if (inRaw == null || inRaw <= 0n) throw unsafe("the amount leaving cannot be read");
  if (inRaw % 100n !== 0n) throw unsafe("the amount leaving has more decimals than the Perp account sends");
  const amountIn = Number(inRaw) / 10 ** HL_PERP_USDC_DECIMALS;
  if (Math.abs(amountIn - base.amountUsdc) > 1e-8) throw unsafe("the amount leaving is stated two ways");
  if (amountIn > ceiling + 1e-9) {
    /* The figures ride along so a caller can say "Max ≈N USDC per move" when the ceiling is the
       per-move cap (fee and gas come on top of what arrives) rather than a bare refusal. */
    const e = unsafe(`it would take ${amountIn} USDC, over the ${ceiling} USDC this move may take`);
    e.detail = { ...e.detail, overCeiling: true, amountIn, ceiling };
    throw e;
  }
  const pd = v2.paymentDetails || {};
  if (pd.chainId !== "hyperliquid" || big(pd.amount) !== inRaw) throw unsafe("the deposit is not the amount leaving");

  /* The sendAsset: exactly Hyperliquid's field set, to the PINNED depository. */
  const params = base.sendAsset;
  const keys = Object.keys(params).sort();
  if (keys.length !== SEND_ASSET_KEYS.length || !SEND_ASSET_KEYS.every((k) => keys.includes(k))) throw unsafe("the transfer carries fields it should not");
  if (lower(params.destination) !== HL_DEPOSITORY || base.depository !== HL_DEPOSITORY) throw unsafe("the transfer is not to the known depository");

  /* The gas top-up: exactly as asked, or absent. */
  const top = det.currencyGasTopup || null;
  let topup = null;
  if (topupUsd == null) {
    if (top) throw unsafe("the answer adds gas nobody asked for");
  } else {
    const tc = (top && top.currency) || {};
    if (!top) throw unsafe("the answer carries no gas");
    if (Number(tc.chainId) !== AVAX_CHAIN_ID || lower(tc.address) !== NATIVE || Number(tc.decimals) !== 18) throw unsafe("the gas is not AVAX");
    const tRaw = big(top.amount);
    if (tRaw == null || tRaw <= 0n || big(top.minimumAmount) !== tRaw) throw unsafe("the gas is not guaranteed");
    const usd = num(top.amountUsd);
    const asked = Number(topupUsd);
    if (usd == null || usd < asked * TOPUP_MIN_SHARE || usd > asked * TOPUP_MAX_SHARE) throw unsafe("the gas is not the size asked for");
    /* The AVAX itself, not only the answer's own $ figure (ATK-12). */
    const avaxAmt = Number(tRaw) / 1e18;
    const indep = typeof avaxUsd === "number" && Number.isFinite(avaxUsd) && avaxUsd > 0 ? avaxUsd : null;
    if (indep != null) {
      /* The printed "(≈$0.30)" must be true of the AVAX itself (TOPUP_WORTH_*), not only of Relay's own figure. */
      const worth = avaxAmt * indep;
      if (!(worth >= asked * TOPUP_WORTH_MIN_SHARE) || worth > asked * TOPUP_WORTH_MAX_SHARE) throw unsafe("the gas is not the size asked for");
    } else {
      const implied = avaxAmt > 0 ? usd / avaxAmt : Infinity;
      if (!(implied >= TOPUP_IMPLIED_AVAX_USD.min && implied <= TOPUP_IMPLIED_AVAX_USD.max)) throw unsafe("the gas amount does not match its price");
    }
    topup = Object.freeze({ raw: tRaw.toString(), avax: formatRaw(tRaw, 18), usd });
  }

  /* What the move costs, net of the gas the user KEEPS (firstDeposit.js's netting) — at the $
     the card and the window PRINT for that gas (the $ asked, gasRow below), never Relay's own
     amountUsd: Fee + "Gas for later" then always add up to what leaves beyond X, and anything
     Relay charges for the gas over the printed $ shows as fee. */
  const outUsd = dest === "usdc" ? Number(want) / 10 ** d0.decimals : num(cout.amountUsd);
  const feeRaw = outUsd == null ? null : amountIn - outUsd - (topup ? Number(topupUsd) : 0);
  const feeUsdc = feeRaw == null || feeRaw < -1e-6 ? null : Math.max(0, Math.round(feeRaw * 1e6) / 1e6);

  return Object.freeze({
    ...base,
    kind: dest === "usdc" ? "move-in" : "gas-topup",
    dest: d0.id,
    own: lower(own),
    amountRaw: want.toString(),
    amountOut: formatRaw(want, d0.decimals),
    amountIn,
    amountInRaw: inRaw.toString(),
    maxDebitUsdc: ceiling,
    feeUsdc,
    topup,
    /* The row the card MUST print (AD-8), in lib/avax/gas.js's own shape so its
       gasRowProblem() can hold the Confirm: the AVAX the quote says arrives, the $ asked.
       🔴 The top-up is NOT part of the order (output.payments holds the USDC only), so it is
       EXPECTED, not proven: the flow watcher (src/avax/watchFlows.js) compares the Spot
       Account's AVAX after the move with this figure and says so when it did not arrive. */
    gasRow: topup ? gasRow({ avaxWei: BigInt(topup.raw), usd: Number(topupUsd), source: "move" }) : null,
    hlNonce: Number(params.nonce),
    orderDeadline: Number.isFinite(Number(out.deadline)) ? Number(out.deadline) : null,
  });
}

/** Is this review still fresh enough to sign? */
export function ownMoveFresh(review, now = Date.now(), ttlMs = OWN_MOVE_QUOTE_TTL_MS) {
  return !!review && Number.isFinite(review.quotedAt) && now - review.quotedAt < ttlMs;
}

/* ── doing it ─────────────────────────────────────────────────────────────── */

/* The move's own words for every way it can end (plan §3.6, D2 "พิมพ์เสมอ").
   None names a provider; none says "try again" after money may have moved. */
export const OWN_MOVE_WORDS = Object.freeze({
  cancelled: "Cancelled. Nothing moved.",
  expired: "Price expired. Nothing moved.",
  wallet: "Your wallet changed. Nothing moved.",
  registry: "This browser couldn't record the move, so nothing was sent.",
  notSent: "Not sent. Nothing moved.",
  unknown: "May have left your Perp account. Don't send it again.",
  overConfirmed: "This costs more than you confirmed. Check the new price. Nothing moved.",
  changed: "This is not the move you confirmed. Check the new one. Nothing moved.",
  noLimit: "This move has no confirmed limit, so nothing was sent.",
  busy: "Another move is still running. Nothing moved.",
});

/**
 * Why `review` is NOT the move the user confirmed (null when it is). The record's
 * maxDebit is REQUIRED — it is the most that may leave the Perp account (plan §3.7);
 * `amounts.out` (what arrives) and `amounts.topupUsd` are compared when the card
 * recorded them.
 */
export function ownMoveOutsideConfirmed(record, review) {
  const cap = confirmedNumber(record && record.maxDebit);
  if (cap == null) return "no-limit";
  if (!review || typeof review.amountIn !== "number" || !Number.isFinite(review.amountIn)) return "not-decodable";
  if (review.amountIn > cap + 1e-9) return "over-confirmed";
  const a = record.amounts && typeof record.amounts === "object" ? record.amounts : {};
  if (a.out != null) {
    const d = OWN_MOVE_DEST[review.dest];
    const want = d ? toRaw(String(a.out), d.decimals) : null;
    if (want == null || String(want) !== String(review.amountRaw)) return "different-move";
  }
  if (a.topupUsd != null) {
    const usd = review.gasRow ? review.gasRow.usd : null;
    if (typeof usd !== "number" || Math.abs(usd - Number(a.topupUsd)) > 0.005) return "different-move";
  } else if (a.topupUsd === null && review.topup) {
    return "different-move";
  }
  return null;
}

/**
 * Run an own move: the authorize window, then — after a fresh-quote check, an
 * own-address check and a registry write — the sendAsset window.
 *
 * @param {{ review: object, ownNow: () => string|null,
 *   signAuthorize: Function, sendDeposit: Function,
 *   flow: { beforeWindow: (patch: object) => any, update?: (patch: object) => any, unknown?: (why: string) => any,
 *     cancel?: (why: string, state: "cancelled"|"error-before-money") => any },
 *   signWords?: object|null, fetchImpl?: Function, now?: () => number, timers?: object, onPhase?: Function }} o
 *   flow: the registry handle for THIS flow (src/avax/flows.js flowHandle). beforeWindow MUST throw
 *   when the record could not be written, and then the money window never opens.
 * @returns {Promise<{ ok: true, requestId, state: "arriving" } | { ok: false, code, message, state, unknown?: true, requestId? }>}
 *   Never throws.
 */
export async function executeOwnMove({
  review, ownNow, signAuthorize, sendDeposit, flow, signWords = null,
  fetchImpl = globalThis.fetch, now = browserNow, timers = browserTimers, onPhase = () => {},
} = {}) {
  /* 0. THE CLAIM — synchronous, before the first await: one run of this step, ever. */
  const run = claimRun(flow, "own-move");
  if (!run.ok && run.untouched) return { ok: false, code: run.code, message: run.message, state: null, untouched: true };

  let release = () => {};
  const end = (state, code, message, extra = {}) => {
    try { release(); } catch { /* released */ }
    try {
      if (state === "unknown" && flow && typeof flow.unknown === "function") flow.unknown(code);
      else if (state !== "unknown" && flow && typeof flow.cancel === "function") flow.cancel(code, state);
    } catch { /* the outcome stands; the registry is best-effort after the window */ }
    return { ok: false, code, message, state, ...extra };
  };
  if (!run.ok) return end("error-before-money", "registry", OWN_MOVE_WORDS.registry);
  if (!review || !review.steps || review.dest == null) return end("error-before-money", "bad-quote", "No price to move with. Nothing moved.");
  const ownIs = () => {
    let o = null;
    try { o = typeof ownNow === "function" ? ownNow() : null; } catch { o = null; }
    return isEvmAddress(o) && sameAddress(o, review.own);
  };
  if (!ownIs()) return end("error-before-money", "wallet", OWN_MOVE_WORDS.wallet);
  if (!ownMoveFresh(review, now())) return end("cancelled", "price_expired", OWN_MOVE_WORDS.expired);

  /* 1. Bound to the card the user confirmed (ATK-04a): never more out of the Perp account than its maxDebit. */
  const outside = ownMoveOutsideConfirmed(run.record, review);
  if (outside === "no-limit") return end("error-before-money", "no-limit", OWN_MOVE_WORDS.noLimit);
  if (outside) return end("cancelled", outside, outside === "over-confirmed" ? OWN_MOVE_WORDS.overConfirmed : OWN_MOVE_WORDS.changed, { needsConfirm: true, why: outside });

  /* 2. The cross-tab lock and a fresh look at the registry, before the first window. */
  let lock = null;
  try { lock = await flow.acquire(); } catch { lock = null; }
  if (!lock || lock.ok !== true) {
    const storage = !!lock && lock.code === "storage";
    return end(storage ? "error-before-money" : "cancelled", storage ? "registry" : (lock && lock.code) || "busy", storage ? OWN_MOVE_WORDS.registry : OWN_MOVE_WORDS.busy);
  }
  release = typeof lock.release === "function" ? lock.release : () => {};
  try {
    return await ownMoveWindows({ review, ownIs, signAuthorize, sendDeposit, flow, signWords, fetchImpl, now, timers, onPhase, end });
  } finally {
    try { release(); } catch { /* released */ }
  }
}

async function ownMoveWindows({ review, ownIs, signAuthorize, sendDeposit, flow, signWords, fetchImpl, now, timers, onPhase, end }) {
  let reached = false;
  const guardedSend = async (args) => {
    /* The last moment before the window that moves money. */
    if (!ownMoveFresh(review, now())) return { ok: false, code: "price_expired", message: OWN_MOVE_WORDS.expired };
    if (!ownIs()) return { ok: false, code: "wallet", message: OWN_MOVE_WORDS.wallet };
    try {
      await flow.beforeWindow({ state: "sending", requestId: review.requestId, hlNonce: review.hlNonce, orderDeadline: review.orderDeadline });
    } catch {
      return { ok: false, code: "registry", message: OWN_MOVE_WORDS.registry };
    }
    reached = true;
    return sendDeposit(args);
  };

  let r;
  try {
    r = await executeRelayWithdraw({
      quote: review, amountUsdc: review.amountUsdc, signAuthorize, sendDeposit: guardedSend, signWords, fetchImpl, now, timers, onPhase,
    });
  } catch (e) {
    /* executeRelayWithdraw never throws; if it ever did, after the window it is unknown. */
    return reached ? end("unknown", "unexpected", OWN_MOVE_WORDS.unknown, { unknown: true, requestId: review.requestId })
      : end("error-before-money", "unexpected", OWN_MOVE_WORDS.notSent);
  }
  if (r && r.ok === true) {
    try { if (typeof flow.update === "function") flow.update({ state: "arriving", sentAt: r.sentAt }); } catch { /* watched by requestId */ }
    return { ok: true, requestId: review.requestId, state: "arriving" };
  }
  if (r && r.notConfirmed) return end("unknown", "not_confirmed", OWN_MOVE_WORDS.unknown, { unknown: true, requestId: review.requestId });
  const code = (r && r.code) || "send_failed";
  if (!reached) {
    if (code === "price_expired" || code === "stale-quote") return end("cancelled", "price_expired", OWN_MOVE_WORDS.expired);
    if (code === "wallet") return end("error-before-money", "wallet", OWN_MOVE_WORDS.wallet);
    if (code === "registry") return end("error-before-money", "registry", OWN_MOVE_WORDS.registry);
    return end("cancelled", code, OWN_MOVE_WORDS.cancelled);
  }
  /* The sendAsset was asked for and refused with a reason (not lost): nothing moved. */
  return end("error-before-money", code, OWN_MOVE_WORDS.notSent);
}
