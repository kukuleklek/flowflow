// ─────────────────────────────────────────────────────────────────────────────
// The 1Click transport: one quote, the token list, one status read, the probe.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every call here is a READ or a QUOTE. A quote executes nothing: a non-dry one
// reserves a one-time deposit address, which only moves money if somebody later
// sends to it. Nothing here signs, holds a key or posts a transaction.
//
// In a page every request goes through our own proxies (api/intents-quote.js,
// api/intents-status.js): the partner key, the kill switch, the caps and the
// sanctions screen are there. The proxies' refusals come back as IntentsError
// codes the screens can word (below).
//
// 🔴 THE SERVICE'S OWN WORDS ARE MADE PLAIN BEFORE THEY ARE THROWN. Owner,
// 2026-09-23: no money screen names the provider or the venue. An upstream
// message can name either, so it passes lib/relay/plainWords.js (the venue's
// names) and plainIntentsWords below (this provider's) at the throw.

import { plainMoneyWords } from "../relay/plainWords.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import {
  INTENTS_QUOTE_URL, INTENTS_STATUS_URL, INTENTS_STATUS_UPSTREAM, INTENTS_TOKENS_URL, INTENTS_PROBE_URL,
  QUOTE_TIMEOUT_MS, TOKENS_TTL_MS, CONFIDENTIALITY, PRIVATE_LIMITS,
} from "./config.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Codes (the screens word them; none of them is the provider's name):
 *   bad-user, not-connected, bad-route, bad-plan, bad-amount, testnet-off   refused before anything leaves
 *   below-min, over-tx-cap, over-day-cap                                     the owner's limits (plan §7.3)
 *   private-mode-off      the server's kill switch is off: Private is not offered
 *   sanctioned            an address is on a sanctions list (plan §4's wording, no workaround)
 *   screen-unavailable    the sanctions screen could not be read: refused, never skipped
 *   confidentiality-mismatch  the page asked for another privacy level than the server gives
 *   rate-limited          too many quotes; wait a minute
 *   network               the request never got an answer
 *   intents-error         the quote service refused (its plain message is the error's)
 *   bad-response          an answer that is not readable
 *   route-unavailable     the token list does not carry the route as we know it
 *   unsafe-quote, bad-deposit-address   the answer did not check out: no address
 */
export class IntentsError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "IntentsError";
    this.code = code;
    this.detail = detail;
  }
}

/* This provider's names, as a sentence on a money screen must not carry them.
   "NEAR" only in capitals (the English word "near" is left alone). */
const INTENTS_NAMES = [
  /\bNEAR\s+Intents\b/g,
  /\bNEAR\b/g,
  /\b1-?click\b/gi,
  /\bchaindefuser(?:\.com)?\b/gi,
  /\bdefuse\b/gi,
  /\bintents\b/gi,
];

/** One borrowed message with the provider's and the venue's names replaced. */
export function plainIntentsWords(text) {
  let s = String(text == null ? "" : text);
  for (const re of INTENTS_NAMES) s = s.replace(re, "the private route service");
  return plainMoneyWords(s.replace(/\bthe the\b/gi, "the"));
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

/* Our proxies' refusals, by their own error field → a code. */
const PROXY_CODES = Object.freeze({
  private_mode_off: "private-mode-off",
  sanctioned: "sanctioned",
  screen_unavailable: "screen-unavailable",
  below_min: "below-min",
  over_tx_cap: "over-tx-cap",
  over_day_cap: "over-day-cap",
  confidentiality_mismatch: "confidentiality-mismatch",
  forbidden: "intents-error",
});

/* The figures a proxy refusal carries (guard.js: below_min's min, over_tx_cap's max,
   over_day_cap's max and left): the screen prints the server's own, so a cap the
   owner lowered after the page read its probe is the cap the customer reads. */
const REFUSAL_FIGURES = Object.freeze(["min", "max", "left"]);

/** A non-2xx answer as an IntentsError (proxy refusals keep their own code, and their figures). */
export function intentsErrorOf(status, json) {
  const proxy = json && typeof json.error === "string" && PROXY_CODES[json.error];
  if (proxy) {
    const detail = { status, error: json.error, field: json.field || null };
    for (const k of REFUSAL_FIGURES) if (typeof json[k] === "number" && Number.isFinite(json[k]) && json[k] >= 0) detail[k] = json[k];
    return new IntentsError(proxy, plainIntentsWords(json.message || json.error), detail);
  }
  if (status === 429) return new IntentsError("rate-limited", "Too many requests. Wait a minute and try again.", { status });
  const msg = json && typeof json.message === "string" ? json.message : `the service answered ${status}`;
  const err = new IntentsError("intents-error", plainIntentsWords(msg), { status, error: (json && json.error) || null });
  return err;
}

async function timed(fetchImpl, url, init, timers, ms = QUOTE_TIMEOUT_MS) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctrl ? timers.setTimeout(() => ctrl.abort(), ms) : null;
  if (init && init.signal && ctrl) {
    if (init.signal.aborted) ctrl.abort();
    else init.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: ctrl ? ctrl.signal : init && init.signal });
  } finally {
    if (t != null) timers.clearTimeout(t);
  }
}

/**
 * One POST /quote with a body built by this folder's builders. Resolves the
 * answer's JSON (NOT yet verified: the caller's parser does that). Rejects with
 * an IntentsError.
 */
export async function postIntentsQuote(body, { fetchImpl = globalThis.fetch, timers = browserTimers, url = INTENTS_QUOTE_URL } = {}) {
  let res;
  try {
    res = await timed(fetchImpl, url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timers);
  } catch (e) {
    throw new IntentsError("network", e && e.name === "AbortError" ? "The quote service took too long." : "Couldn't reach the quote service.", { cause: String((e && e.message) || e) });
  }
  const json = await readJson(res);
  if (!res.ok) throw intentsErrorOf(res.status, json);
  if (!json || typeof json !== "object") throw new IntentsError("bad-response", "The quote was not readable");
  return json;
}

/** A fresh holder for one token list (the page keeps one; tests make their own). */
export function newIntentsTokensMemo() {
  return { at: null, tokens: null, running: null };
}
const TOKENS = newIntentsTokensMemo();

/**
 * GET /tokens, kept for TOKENS_TTL_MS; two readers at once share one request.
 * Public (no key, CORS *), so a page reads it directly. A failure is not kept.
 */
export async function readIntentsTokens({ fetchImpl = globalThis.fetch, memo = TOKENS, now = browserNow, timers = browserTimers, url = INTENTS_TOKENS_URL } = {}) {
  const t = now();
  if (memo.tokens && Number.isFinite(memo.at) && t >= memo.at && t - memo.at < TOKENS_TTL_MS) return memo.tokens;
  if (memo.running) return memo.running;
  const job = (async () => {
    let res;
    try {
      res = await timed(fetchImpl, url, { method: "GET" }, timers);
    } catch (e) {
      throw new IntentsError("network", "Couldn't reach the quote service to check the route", { cause: String((e && e.message) || e) });
    }
    const json = await readJson(res);
    if (!res.ok) throw intentsErrorOf(res.status, json);
    if (!Array.isArray(json)) throw new IntentsError("bad-response", "The token list was not readable");
    memo.tokens = json;
    memo.at = now();
    return json;
  })();
  memo.running = job;
  try { return await job; } finally { memo.running = null; }
}

/**
 * GET /status?depositAddress= — one read. Resolves the answer's JSON, or null
 * for a 404 (an address nobody has sent to yet is "nothing yet", not an error).
 *
 * 🔴 THE KILL SWITCH STOPS NEW QUOTES, NOT THE CUSTOMER'S VIEW OF THEIR MONEY.
 * When our status proxy answers private_mode_off, the same read goes once to
 * the public endpoint (keyless, CORS *), so a deposit already sent keeps its
 * status row. A read is not a signed action; repeating it moves nothing.
 *
 * Rejects with an IntentsError carrying .status (the tracker backs off on 429).
 */
export async function fetchIntentsStatus({
  depositAddress,
  fetchImpl = globalThis.fetch,
  signal,
  timers = browserTimers,
  url = INTENTS_STATUS_URL,
  fallbackUrl = INTENTS_STATUS_UPSTREAM,
} = {}) {
  if (typeof depositAddress !== "string" || !ADDRESS_RE.test(depositAddress)) throw new IntentsError("bad-deposit-address", "Not a deposit address");
  const once = async (base) => {
    let res;
    try {
      res = await timed(fetchImpl, `${base}?depositAddress=${encodeURIComponent(depositAddress)}`, { method: "GET", signal }, timers);
    } catch (e) {
      const err = new IntentsError("network", e && e.name === "AbortError" ? "The deposit service took too long to answer" : "Couldn't reach the deposit service", { cause: String((e && e.message) || e) });
      if (e && e.name === "AbortError") err.name = "AbortError";
      throw err;
    }
    return { res, json: await readJson(res) };
  };
  let { res, json } = await once(url);
  if (res.status === 503 && json && json.error === "private_mode_off" && fallbackUrl && fallbackUrl !== url) {
    ({ res, json } = await once(fallbackUrl));
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = intentsErrorOf(res.status, json);
    err.status = res.status;
    throw err;
  }
  if (!json || typeof json !== "object" || typeof json.status !== "string") throw new IntentsError("bad-response", "The deposit status was not readable");
  return json;
}

/**
 * What the server offers right now: { enabled, confidential, confidentiality,
 * limits }. Anything that is not a clear "on" — a 503, a network failure, an
 * unreadable answer — is { enabled: false }: the toggle is hidden, never guessed.
 */
export async function readPrivateModeProbe({ fetchImpl = globalThis.fetch, timers = browserTimers, url = INTENTS_PROBE_URL } = {}) {
  const off = { enabled: false, confidential: false, confidentiality: null, limits: PRIVATE_LIMITS };
  let res;
  try { res = await timed(fetchImpl, url, { method: "GET" }, timers, 8000); } catch { return off; }
  if (!res || !res.ok) return off;
  const j = await readJson(res);
  if (!j || j.enabled !== true || !CONFIDENTIALITY.includes(j.confidentiality)) return off;
  const confidential = j.confidentiality !== "public" && j.confidential === true;
  const l = j.limits && typeof j.limits === "object" ? j.limits : {};
  const pick = (k) => (Number.isFinite(l[k]) && l[k] > 0 && l[k] <= PRIVATE_LIMITS[k] ? l[k] : PRIVATE_LIMITS[k]);
  /* A server can only LOWER the caps the page enforces; a minimum it raises is taken as given. */
  return {
    enabled: true,
    confidential,
    confidentiality: confidential ? j.confidentiality : "public",
    limits: Object.freeze({
      depositMinUsdc: Number.isFinite(l.depositMinUsdc) && l.depositMinUsdc >= PRIVATE_LIMITS.depositMinUsdc ? l.depositMinUsdc : PRIVATE_LIMITS.depositMinUsdc,
      withdrawMinUsdc: Number.isFinite(l.withdrawMinUsdc) && l.withdrawMinUsdc >= PRIVATE_LIMITS.withdrawMinUsdc ? l.withdrawMinUsdc : PRIVATE_LIMITS.withdrawMinUsdc,
      maxTxUsdc: pick("maxTxUsdc"),
      maxDayUsdc: pick("maxDayUsdc"),
    }),
  };
}
