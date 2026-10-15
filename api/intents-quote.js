// POST /api/intents-quote — one private-mode quote (1Click), guarded, with FlowFlow's partner key if there is one.
// GET  /api/intents-quote?probe=1 — what Private mode offers right now.
//
// The browser's builders and verifiers (src/lib/intents/deposit.js and the withdraw side) still check every answer;
// this function adds what a page cannot be trusted to do for itself (src/lib/intents/guard.js has the detail):
//
//   1. the kill switch: PRIVATE_MODE must be exactly "on", or every call answers 503 { error: "private_mode_off" };
//   2. our pages only (origin allow-list) and 60 quotes a minute per IP; with the partner key set, a POST with NO
//      Origin (curl, a script) is refused too, so the key is never an open relay (guard.js keyedCallerOk);
//   3. the body allow-listed field by field (no appFees, no message, no virtual-chain field; one of six pairs; a
//      deposit pays the wallet it refunds) and the privacy level forced to the server's: confidential only when
//      NEAR_INTENTS_JWT exists (server env, never VITE_), else "public" — which is NOT private;
//   4. the caps (10 / 5 USDC minimum, 500 per move, 1,000 per wallet per UTC day; an address-reserving quote is
//      counted BEFORE the first await and released if no address comes back, so concurrent quotes see each other);
//   5. the sanctions screen on every address in the quote (the server's SDN copy, the owner's env list, then the
//      oracle on every chain), failing closed;
//   6. the answer back verbatim (the key scrubbed from it), refused if its echo names another recipient or refundTo
//      than the one asked for; and one structured log line per address-reserving quote (plan §7.6: quote id,
//      address, wallet, time — the records a compliance request needs within 5 business days).
//
// The upstream fetch never follows a redirect (redirect: "error"): fetch's default would re-send x-api-key, the
// partner key, to wherever a Location header points.
//
// Nothing here signs, sends or holds money. A quote executes nothing.

import { INTENTS_QUOTE_UPSTREAM } from "../src/lib/intents/config.js";
import {
  privateModeOf, intentsKeyOf, serverConfidentiality, limitsFrom, originAllowed, keyedCallerOk, createRateLimiter,
  checkQuoteBody, createDayLedger, checkDayCap, screenAddresses, extraSanctionsList, sanctionsRpcsFrom,
  SANCTIONED_MESSAGE, SCREEN_UNAVAILABLE_MESSAGE,
} from "../src/lib/intents/guard.js";

const MAX_BODY = 16_000;
const RATE_PER_MIN = 60;
const TIMEOUT_MS = 20_000;
/* Cloudflare in front of the API refused a non-browser User-Agent with error 1010 (measured from Python). */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export const rateLimited = createRateLimiter(RATE_PER_MIN);
const LEDGER = createDayLedger();

const json = (status, obj) => ({ status, body: JSON.stringify(obj) });
const OFF = () => json(503, { error: "private_mode_off", enabled: false, message: "Private mode is off." });

/** GET ?probe — { enabled, confidential, confidentiality, limits }, or 503 when the switch is off. */
export function probeOnce({ env = process.env } = {}) {
  if (privateModeOf(env) !== "on") return OFF();
  const confidentiality = serverConfidentiality(env);
  const limits = limitsFrom(env);
  return json(200, {
    enabled: true,
    confidential: confidentiality !== "public",
    confidentiality,
    /* "public" is a working route that hides nothing: the page must label it a preview. */
    preview: confidentiality === "public",
    limits: {
      depositMinUsdc: limits.depositMinUsdc, withdrawMinUsdc: limits.withdrawMinUsdc,
      maxTxUsdc: limits.maxTxUsdc, maxDayUsdc: limits.maxDayUsdc,
    },
  });
}

const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The exchange without HTTP (tests call this).
 *   rpcFetch  fetch for the sanctions screen's eth_call (default fetch)
 *   ledger    the day ledger (default: this instance's)
 *   log       one line per address-reserving quote (default console.log)
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function intentsQuoteOnce({
  body, env = process.env, fetchImpl = fetch, rpcFetch = fetchImpl, ledger = LEDGER, now = Date.now,
  screenMemo, log = (line) => console.log(line),
}) {
  if (privateModeOf(env) !== "on") return OFF();
  const confidentiality = serverConfidentiality(env);
  const limits = limitsFrom(env);
  const checked = checkQuoteBody(body, { now: now(), confidentiality, limits });
  if (!checked.ok) {
    const { ok, status, ...rest } = checked;
    return json(status, rest);
  }
  const day = checkDayCap({ ledger, wallet: checked.wallet, amountUsdc: checked.amountUsdc, limits, now: now() });
  if (!day.ok) { const { ok, status, ...rest } = day; return json(status, rest); }
  /* 🔴 Counted NOW, before the first await: a second quote for this wallet arriving while this one is being
     screened or quoted sees it. Taken back below unless an address really comes back. */
  const held = checked.body.dry ? null : reserveDay(ledger, checked.wallet, checked.amountUsdc, now());
  let out = null;
  try {
    out = await quoteChecked({ checked, env, confidentiality, fetchImpl, rpcFetch, now, screenMemo, log });
  } finally {
    if (held && !(out && out.reserved)) held.release();
  }
  return { status: out.status, body: out.body };
}

/* The ledger's own reservation, or (a ledger without one) add now and subtract on release. */
function reserveDay(ledger, wallet, usdc, at) {
  if (typeof ledger.reserve === "function") return ledger.reserve(wallet, usdc, at);
  ledger.add(wallet, usdc, at);
  let done = false;
  return { release() { if (!done) { done = true; ledger.add(wallet, -usdc, at); } } };
}

/* Screen, forward, check the echo. { status, body, reserved } — reserved only when an address came back. */
async function quoteChecked({ checked, env, confidentiality, fetchImpl, rpcFetch, now, screenMemo, log }) {
  const screen = await screenAddresses(checked.addresses, {
    rpcUrls: sanctionsRpcsFrom(env), fetchImpl: rpcFetch, extra: extraSanctionsList(env), now,
    ...(screenMemo ? { memo: screenMemo } : {}),
  });
  if (!screen.ok) {
    return screen.code === "sanctioned"
      ? json(451, { error: "sanctioned", message: SANCTIONED_MESSAGE })
      : json(503, { error: "screen_unavailable", message: SCREEN_UNAVAILABLE_MESSAGE });
  }

  const key = intentsKeyOf(env);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status;
  let text;
  try {
    const r = await fetchImpl(INTENTS_QUOTE_UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA, ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify(checked.body),
      /* Never follow a redirect: it would carry x-api-key to wherever Location points. */
      redirect: "error",
      signal: ctrl.signal,
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    return json(504, { message: e && e.name === "AbortError" ? "The quote service took too long." : "Couldn't reach the quote service." });
  } finally {
    clearTimeout(t);
  }
  /* Never echo the key, whatever the upstream says. */
  if (key) text = text.split(key).join("[key]");
  if (status < 200 || status >= 300) return { status, body: text };

  let answer = null;
  try { answer = JSON.parse(text); } catch { answer = null; }
  const echo = answer && answer.quoteRequest;
  /* 🔴 A second pair of eyes on the one thing that matters most: the answer pays and refunds who we asked. */
  if (!echo || !sameAddr(echo.recipient, checked.body.recipient) || !sameAddr(echo.refundTo, checked.body.refundTo)) {
    return json(502, { error: "upstream_mismatch", message: "The quote didn't check out, so nothing is shown. Try again." });
  }
  if (!checked.body.dry) {
    try {
      log(JSON.stringify({
        evt: "intents.quote",
        at: new Date(now()).toISOString(),
        direction: checked.direction,
        correlationId: answer.correlationId || null,
        depositAddress: (answer.quote && answer.quote.depositAddress) || null,
        deadline: (answer.quote && answer.quote.deadline) || null,
        wallet: checked.wallet,
        recipient: checked.body.recipient.toLowerCase(),
        originAsset: checked.body.originAsset,
        destinationAsset: checked.body.destinationAsset,
        amount: checked.body.amount,
        confidentiality,
      }));
    } catch { /* a record that cannot be written does not undo a quote the page will verify */ }
    return { status, body: text, reserved: true };
  }
  return { status, body: text };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body).length <= MAX_BODY ? req.body : null;
  if (typeof req.body === "string") { if (req.body.length > MAX_BODY) return null; try { return JSON.parse(req.body); } catch { return null; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function send(res, out) {
  res.statusCode = out.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(out.body);
}

export default async function handler(req, res) {
  if (privateModeOf(process.env) !== "on") return send(res, OFF());
  if (!originAllowed(req.headers.origin)) return send(res, json(403, { error: "forbidden" }));
  if (req.method === "GET") return send(res, probeOnce());
  if (req.method !== "POST") return send(res, json(405, { error: "method_not_allowed" }));
  /* 🔴 With the partner key set, a POST must come from one of our pages (a browser always sends Origin on a
     POST): a caller with no Origin at all is refused before the key is used. */
  if (!keyedCallerOk(req.headers, process.env)) return send(res, json(403, { error: "forbidden" }));
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, json(429, { message: "Too many quotes. Wait a minute." }));
  const body = await readBody(req);
  if (!body) return send(res, json(400, { error: "bad_request" }));
  return send(res, await intentsQuoteOnce({ body }));
}
