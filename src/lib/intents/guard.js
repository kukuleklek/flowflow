// ─────────────────────────────────────────────────────────────────────────────
// THE SERVER'S GUARD on every private quote: the kill switch, the body
// allow-list, the caps, and the sanctions screen. Used by api/intents-quote.js
// and api/intents-status.js; pure apart from the screen's read-only eth_call.
// ─────────────────────────────────────────────────────────────────────────────
//
// What runs, in order, before a quote leaves our server (plan §7, R-compliance §6):
//
//   1. KILL SWITCH. PRIVATE_MODE must be exactly "on"; anything else answers
//      503 { error: "private_mode_off" } and the page hides the toggle.
//   2. THE BODY IS ALLOW-LISTED, field by field. One of INTENTS_PAIRS only; the
//      only swap type, deposit type, refund type and recipient type we use; no
//      appFees, no message, no virtual-chain recipient, no referral or rebate —
//      an unknown field is a 400 naming it. A DEPOSIT pair must pay the same
//      wallet it refunds (recipient = refundTo), here as well as in the page.
//      The privacy level is the SERVER's: confidential ("basic"/"advanced") only
//      when NEAR_INTENTS_JWT exists, else "public", and a body asking for any
//      other level is refused (409) so the page verifies what it really got.
//   3. CAPS (plan Q6): ≥ 10 USDC to deposit, ≥ 5 to withdraw, ≤ 500 per move,
//      ≤ 1,000 per wallet per UTC day (deposits and withdrawals together,
//      counted on address-reserving quotes). Env may LOWER the two caps, never
//      raise them. The day is RESERVED before the first await (the screen, the
//      upstream) and released if no address comes back, so quotes that arrive
//      together cannot all pass the check before any of them is counted.
//      🔴 The day ledger lives in this server instance's memory: a cold start
//      or a second instance does not share it. It is a guard rail, not an
//      accounting system.
//   4. SANCTIONS. Every address in the quote (recipient, refundTo) is checked
//      against the server's copy of the OFAC SDN ETH list (ofacSdn.js) and any
//      extra addresses the owner lists in env, then against the Chainalysis
//      sanctions oracle by eth_call on EVERY listed chain; any "yes" from any
//      source wins (live 2026-10-15 on Arbitrum and Ethereum: the SDN-listed
//      Ronin-exploit address answers true, a random one false).
//      🔴 FAIL CLOSED: an oracle no RPC can read refuses the quote
//      (screen_unavailable); it is never skipped. Chainalysis has said the
//      oracle is no longer actively maintained (R-compliance §6.3), which is
//      why the copy exists (its seed is not yet the full list: see ofacSdn.js).
//   5. WHO MAY SPEND THE PARTNER KEY. With NEAR_INTENTS_JWT set, a quote (POST)
//      must carry one of our pages' Origin headers (a browser always sends one
//      on a POST); a request without one (curl, a script) is refused before the
//      key is used. A status read (GET; a browser sends no Origin on a
//      same-origin GET) uses the key only when it carries our Origin or
//      Sec-Fetch-Site: same-origin, and is otherwise read keyless, exactly as
//      the public endpoint would answer it. Headers can be forged: this keeps
//      the proxy from being an open relay for the key, it does not prove who
//      owns the wallet (that needs a signed session, not built yet).
//
// Nothing here signs, holds a key in a response, or moves money.

import {
  PRIVATE_MODE_ON, PRIVATE_LIMITS, CONFIDENTIALITY, CONFIDENTIAL_LEVELS, DEFAULT_CONFIDENTIAL_LEVEL,
  MAX_SLIPPAGE_BPS, MAX_ASKED_DEADLINE_MS, MIN_ASKED_DEADLINE_MS,
} from "./config.js";
import { intentsPairOf, intentsAssetById, rawOf, parseUnitsExact, unitsNumber } from "./assets.js";
import { sdnListed } from "./ofacSdn.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => typeof a === "string" && ADDRESS_RE.test(a) && a.toLowerCase() !== ZERO;
const lc = (a) => String(a).toLowerCase();

/* ── env ─────────────────────────────────────────────────────────────────── */

/** "on" only when PRIVATE_MODE is exactly "on" (spaces trimmed); everything else is "off". */
export function privateModeOf(env = {}) {
  return String(env.PRIVATE_MODE == null ? "" : env.PRIVATE_MODE).trim() === PRIVATE_MODE_ON ? "on" : "off";
}

/** The partner key, or "" (server env only; never VITE_, never echoed). */
export function intentsKeyOf(env = {}) {
  return String(env.NEAR_INTENTS_JWT == null ? "" : env.NEAR_INTENTS_JWT).trim();
}

/** The privacy level this server gives: confidential only with a key, else "public". */
export function serverConfidentiality(env = {}) {
  if (!intentsKeyOf(env)) return "public";
  const want = String(env.NEAR_INTENTS_CONFIDENTIALITY || "").trim();
  return CONFIDENTIAL_LEVELS.includes(want) ? want : DEFAULT_CONFIDENTIAL_LEVEL;
}

/** The limits, with INTENTS_MAX_TX_USDC / INTENTS_MAX_DAY_USDC able to lower (never raise) the caps. */
export function limitsFrom(env = {}) {
  const lower = (k, envKey) => {
    const v = Number(env[envKey]);
    return Number.isFinite(v) && v > 0 && v < PRIVATE_LIMITS[k] ? v : PRIVATE_LIMITS[k];
  };
  return Object.freeze({ ...PRIVATE_LIMITS, maxTxUsdc: lower("maxTxUsdc", "INTENTS_MAX_TX_USDC"), maxDayUsdc: lower("maxDayUsdc", "INTENTS_MAX_DAY_USDC") });
}

/* ── who may call (our own pages), and how often ─────────────────────────── */

/* Our own pages: production, the project's preview deployments, local dev
   (the same list as api/relay-quote.js). */
const ORIGIN_OK = [
  /^https:\/\/flowflow-alpha\.vercel\.app$/,
  /^https:\/\/www\.flowflow-alpha\.vercel\.app$/,
  /^https:\/\/flowflow-[a-z0-9-]+-flow-flow\.vercel\.app$/,
  /^http:\/\/localhost:\d{2,5}$/,
  /^http:\/\/127\.0\.0\.1:\d{2,5}$/,
];
export const originAllowed = (origin) => !origin || ORIGIN_OK.some((re) => re.test(origin));

/* One header from a Node request's headers (lower-case keys), or "". */
function headerOf(headers, name) {
  const v = headers && typeof headers === "object" ? headers[name] : null;
  return String(Array.isArray(v) ? v[0] : v == null ? "" : v).trim();
}

/**
 * May this request spend the partner key? Always true without a key. With one:
 * a request carrying one of our pages' Origin headers, or (when `sameOriginGet`)
 * a GET that says Sec-Fetch-Site: same-origin (a browser sends no Origin on a
 * same-origin GET). Everything else — no Origin at all, as curl sends — is false.
 * Headers can be forged; this closes the open relay, it is not authentication.
 */
export function keyedCallerOk(headers, env = {}, { sameOriginGet = false } = {}) {
  if (!intentsKeyOf(env)) return true;
  const origin = headerOf(headers, "origin");
  if (origin) return ORIGIN_OK.some((re) => re.test(origin));
  return sameOriginGet && headerOf(headers, "sec-fetch-site").toLowerCase() === "same-origin";
}

/** A per-key sliding one-minute limiter. */
export function createRateLimiter(perMinute) {
  const hits = new Map();
  return function limited(key, now = Date.now()) {
    const k = key || "unknown";
    const recent = (hits.get(k) || []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(k, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > perMinute;
  };
}

/* ── the body ────────────────────────────────────────────────────────────── */

export const REQUIRED_QUOTE_FIELDS = Object.freeze([
  "dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset",
  "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline", "confidentiality",
]);
export const OPTIONAL_QUOTE_FIELDS = Object.freeze(["quoteWaitingTimeMs", "depositMode"]);
const ALLOWED = new Set([...REQUIRED_QUOTE_FIELDS, ...OPTIONAL_QUOTE_FIELDS]);

const bad = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/**
 * One quote body, field by field. Resolves { ok: true, body (a fresh copy of
 * exactly the allowed fields), direction, amountUsdc, wallet (refundTo, lower
 * case), addresses (to screen) } or { ok: false, status, error, field?, message }.
 */
export function checkQuoteBody(body, { now = Date.now(), confidentiality = "public", limits = PRIVATE_LIMITS } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(400, "bad_request", { message: "Not a quote request." });
  for (const k of Object.keys(body)) if (!ALLOWED.has(k)) return bad(400, "field_not_allowed", { field: k, message: `The field ${k} is not allowed.` });
  for (const k of REQUIRED_QUOTE_FIELDS) if (body[k] == null) return bad(400, "field_missing", { field: k, message: `The field ${k} is missing.` });
  const b = body;
  if (typeof b.dry !== "boolean") return bad(400, "bad_field", { field: "dry" });
  if (b.swapType !== "EXACT_INPUT") return bad(400, "bad_field", { field: "swapType" });
  if (!Number.isInteger(b.slippageTolerance) || b.slippageTolerance < 0 || b.slippageTolerance > MAX_SLIPPAGE_BPS) return bad(400, "bad_field", { field: "slippageTolerance" });
  if (b.depositType !== "ORIGIN_CHAIN") return bad(400, "bad_field", { field: "depositType" });
  if (b.refundType !== "ORIGIN_CHAIN") return bad(400, "bad_field", { field: "refundType" });
  if (b.recipientType !== "DESTINATION_CHAIN") return bad(400, "bad_field", { field: "recipientType" });
  if (b.depositMode != null && b.depositMode !== "SIMPLE") return bad(400, "bad_field", { field: "depositMode" });
  if (b.quoteWaitingTimeMs != null && (!Number.isInteger(b.quoteWaitingTimeMs) || b.quoteWaitingTimeMs < 0 || b.quoteWaitingTimeMs > 10000)) return bad(400, "bad_field", { field: "quoteWaitingTimeMs" });
  const pair = intentsPairOf(b.originAsset, b.destinationAsset);
  if (!pair) return bad(400, "pair_not_allowed", { message: "That route is not offered." });
  if (!isAddr(b.recipient)) return bad(400, "bad_field", { field: "recipient" });
  if (!isAddr(b.refundTo)) return bad(400, "bad_field", { field: "refundTo" });
  /* 🔴 A deposit pays the wallet it refunds. Always. */
  if (pair.direction === "deposit" && lc(b.recipient) !== lc(b.refundTo)) return bad(400, "deposit_recipient", { message: "A deposit is only paid to the wallet that is refunded." });
  if (typeof b.deadline !== "string") return bad(400, "bad_field", { field: "deadline" });
  const dl = Date.parse(b.deadline);
  if (!Number.isFinite(dl) || dl < now + MIN_ASKED_DEADLINE_MS || dl > now + MAX_ASKED_DEADLINE_MS) return bad(400, "bad_field", { field: "deadline" });
  if (!CONFIDENTIALITY.includes(b.confidentiality)) return bad(400, "bad_field", { field: "confidentiality" });
  if (b.confidentiality !== confidentiality) {
    return bad(409, "confidentiality_mismatch", { confidentiality, message: "The privacy level changed. Reload and try again." });
  }
  const raw = rawOf(b.amount);
  if (raw == null || raw <= 0n) return bad(400, "bad_field", { field: "amount" });
  const origin = intentsAssetById(b.originAsset);
  const amountUsdc = unitsNumber(raw, origin.decimals);
  if (amountUsdc == null) return bad(400, "bad_field", { field: "amount" });
  const min = pair.direction === "deposit" ? limits.depositMinUsdc : limits.withdrawMinUsdc;
  if (raw < parseUnitsExact(String(min), origin.decimals)) return bad(422, "below_min", { min, message: `The smallest private ${pair.direction} is ${min} USDC.` });
  if (raw > parseUnitsExact(String(limits.maxTxUsdc), origin.decimals)) return bad(422, "over_tx_cap", { max: limits.maxTxUsdc, message: `The largest private move is ${limits.maxTxUsdc} USDC.` });
  const out = {};
  for (const k of [...REQUIRED_QUOTE_FIELDS, ...OPTIONAL_QUOTE_FIELDS]) if (b[k] != null) out[k] = b[k];
  const addresses = [...new Set([lc(b.recipient), lc(b.refundTo)])];
  return { ok: true, body: out, direction: pair.direction, amountUsdc, wallet: lc(b.refundTo), addresses };
}

/* ── the day cap ─────────────────────────────────────────────────────────── */

/** The UTC day of a time, "2026-10-15". */
export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

/** One instance's memory of what each wallet reserved today (see the top: a guard rail). */
export function createDayLedger() {
  const days = new Map();
  const keyOf = (wallet, now) => `${utcDay(now)}:${lc(wallet)}`;
  return {
    spent(wallet, now = Date.now()) { return days.get(keyOf(wallet, now)) || 0; },
    add(wallet, usdc, now = Date.now()) {
      const k = keyOf(wallet, now);
      if (days.size > 20000) for (const old of [...days.keys()]) if (!old.startsWith(utcDay(now))) days.delete(old);
      days.set(k, Math.round(((days.get(k) || 0) + usdc) * 1e6) / 1e6);
    },
    /**
     * Count `usdc` NOW, synchronously, against the day it is now; release()
     * takes it back off that same day (once). The proxy reserves before its
     * first await, so concurrent quotes see each other.
     */
    reserve(wallet, usdc, now = Date.now()) {
      const k = keyOf(wallet, now);
      this.add(wallet, usdc, now);
      let done = false;
      return {
        release() {
          if (done) return;
          done = true;
          const left = Math.round(((days.get(k) || 0) - usdc) * 1e6) / 1e6;
          if (left > 0) days.set(k, left); else days.delete(k);
        },
      };
    },
  };
}

/** Would this move pass the day cap? { ok } or { ok: false, status: 422, error: "over_day_cap", ... }. */
export function checkDayCap({ ledger, wallet, amountUsdc, limits = PRIVATE_LIMITS, now = Date.now() }) {
  const spent = ledger.spent(wallet, now);
  if (spent + amountUsdc > limits.maxDayUsdc + 1e-9) {
    return bad(422, "over_day_cap", { max: limits.maxDayUsdc, left: Math.max(0, Math.round((limits.maxDayUsdc - spent) * 1e6) / 1e6), message: `Private moves are limited to ${limits.maxDayUsdc} USDC a day.` });
  }
  return { ok: true };
}

/* ── the sanctions screen ────────────────────────────────────────────────── */

/** Chainalysis' on-chain sanctions oracle (same address on Ethereum and Arbitrum). */
export const SANCTIONS_ORACLE = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";
/** keccak256("isSanctioned(address)")[0..4]. */
export const IS_SANCTIONED_SELECTOR = "0xdf592f7d";
/** Read-only public RPCs where the oracle has code (it has NONE on Base: "0x" there is not a "no"). All are asked. */
export const SANCTIONS_RPCS = Object.freeze(["https://arb1.arbitrum.io/rpc", "https://ethereum-rpc.publicnode.com"]);
export const SANCTIONS_TIMEOUT_MS = 8000;
/** A screened address is re-read after this long. */
export const SANCTIONS_MEMO_MS = 10 * 60 * 1000;

/** The eth_call data for isSanctioned(address). */
export function sanctionsCalldata(address) {
  if (!isAddr(address)) throw new Error("not an address");
  return `${IS_SANCTIONED_SELECTOR}${lc(address).slice(2).padStart(64, "0")}`;
}

/** Extra addresses from env INTENTS_SANCTIONS_EXTRA (comma or space separated), lower case. */
export function extraSanctionsList(env = {}) {
  const s = String(env.INTENTS_SANCTIONS_EXTRA || "");
  return new Set(s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => ADDRESS_RE.test(x)));
}

/** RPCs from env INTENTS_SANCTIONS_RPC (comma list of https URLs), else the defaults. */
export function sanctionsRpcsFrom(env = {}) {
  const list = String(env.INTENTS_SANCTIONS_RPC || "").split(",").map((x) => x.trim()).filter((x) => /^https:\/\/[^\s]+$/.test(x));
  return list.length ? list : SANCTIONS_RPCS;
}

/* One eth_call to one RPC: true / false, or null when its answer is not readable. */
async function oracleOnce(rpc, address, { fetchImpl, timeoutMs }) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SANCTIONS_ORACLE, data: sanctionsCalldata(address) }, "latest"] }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    if (!res.ok || !j || j.error || typeof j.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(j.result)) return null;
    const v = BigInt(j.result);
    if (v === 1n) return true;
    if (v === 0n) return false;
    return null;
  } catch {
    return null;
  } finally {
    if (t != null) clearTimeout(t);
  }
}

/** A fresh memo for screened addresses (one per server instance). */
export function newSanctionsMemo() {
  return new Map();
}
const SCREENED = newSanctionsMemo();

/**
 * Screen every address. Resolves { ok: true } or { ok: false, code: "sanctioned",
 * address } or { ok: false, code: "screen_unavailable", address } — never throws.
 * The server's SDN copy (`sdn`, ofacSdn.js) and the owner's env list (`extra`)
 * are read first and refuse without asking any chain.
 *
 * EVERY RPC IS ASKED, AND ANY "YES" WINS: the oracle on each chain is updated by
 * its own transactions, so one may be ahead of the other (the same rule as the
 * withdraw side's lib/intents/sanctionsOracle.js). Clear needs at least one
 * definite "no" and no "yes"; no definite answer at all is screen_unavailable.
 */
export async function screenAddresses(addresses, {
  rpcUrls = SANCTIONS_RPCS, fetchImpl = globalThis.fetch, extra = new Set(), timeoutMs = SANCTIONS_TIMEOUT_MS,
  memo = SCREENED, now = Date.now, sdn = sdnListed,
} = {}) {
  const list = [...new Set((addresses || []).map((a) => lc(a)))];
  /* The lists first (no network), for every address, before any oracle read. */
  for (const a of list) {
    if (!isAddr(a)) return { ok: false, code: "screen_unavailable", address: a };
    if (extra.has(a) || sdn(a)) return { ok: false, code: "sanctioned", address: a };
  }
  for (const a of list) {
    const m = memo.get(a);
    let hit = m && now() - m.at < SANCTIONS_MEMO_MS ? m.sanctioned : null;
    if (hit == null) {
      const answers = await Promise.all(rpcUrls.map((rpc) => oracleOnce(rpc, a, { fetchImpl, timeoutMs })));
      hit = answers.includes(true) ? true : answers.includes(false) ? false : null;
      if (hit == null) return { ok: false, code: "screen_unavailable", address: a };
      memo.set(a, { sanctioned: hit, at: now() });
      if (memo.size > 20000) memo.clear();
    }
    if (hit) return { ok: false, code: "sanctioned", address: a };
  }
  return { ok: true };
}

/** The words a refused screen gets (plan §4; never a workaround). */
export const SANCTIONED_MESSAGE = "This address can't be used. It appears on a sanctions or stolen-funds list. Contact support if you think this is a mistake.";
export const SCREEN_UNAVAILABLE_MESSAGE = "The safety check couldn't run just now, so nothing was quoted. Try again in a minute.";
