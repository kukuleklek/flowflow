// POST /api/relay-quote — one Relay quote, passed through with FlowFlow's API key.
//
// Relay requires an API key on every POST /quote/v2 from 2026-10-02 ("x-api-key"), and its docs say never to expose it
// in client-side code. So the browser asks HERE (src/lib/relay/routes.js RELAY_QUOTE_URL) and this function adds the key
// from RELAY_API_KEY (serverless env, never VITE_). It holds nothing else: it does not change or build the quote body —
// the browser's own builders and verifiers (depositAddress.js, withdraw.js, ownMove.js, moveOut.js, swap.js) still
// check every answer — it adds the header, and it refuses anything that is not a plain quote request from our own pages
// (the origin, the rate, and since M1b the body's own keys, below).
//
// M1b (plan v2 §2.7): THE BODY IS ALLOW-LISTED, not passed through. The key is shared by every user, and a body
// can ask Relay for things that are billed to it or that no page of ours sends — `subsidizeFees` /
// `maxSubsidizationAmount` (Relay pays the user's fees from the key's balance), `appFees` / `referrer` (someone
// else's fee riding on our key), `txs` (arbitrary destination calls). So the proxy accepts EXACTLY the keys our own
// body builders send, each of the type they send it as, on the chains our routes use, and answers 400 to anything
// else before Relay is asked. The builders, and their keys:
//   deposit (lib/relay/depositAddress.js), first deposit (firstDeposit.js), fee sizes (depositSizes.js):
//       the core nine + useDepositAddress (+ topupGas, topupGasAmount on the first deposit)
//   withdraw, both trade types (withdraw.js):                the core nine
//   move-in / gas top-up (ownMove.js):                       the core nine + topupGas, topupGasAmount
//   move-out (moveOut.js):                                   the core nine + usePermit, useMulticallAuthorization
//   swap and its gas leg (swap.js):                          the core nine + slippageTolerance, includedSwapSources
// The core nine: user, recipient, refundTo, originChainId, originCurrency, destinationChainId, destinationCurrency,
// amount, tradeType. scripts/test-relay-proxy.mjs runs every one of those builders through this check.

import { PERP_DEPOSIT_ROUTES, HL_RELAY_CHAIN_ID } from "../src/lib/relay/routes.js";

const UPSTREAM = "https://api.relay.link/quote/v2";
const MAX_BODY = 32_000;
const RATE_PER_MIN = 60;
const TIMEOUT_MS = 20_000;

/* Our own pages: production, the project's preview deployments, and local dev. */
const ORIGIN_OK = [
  /^https:\/\/flowflow-alpha\.vercel\.app$/,
  /^https:\/\/www\.flowflow-alpha\.vercel\.app$/,
  /^https:\/\/flowflow-[a-z0-9-]+-flow-flow\.vercel\.app$/,
  /^http:\/\/localhost:\d{2,5}$/,
  /^http:\/\/127\.0\.0\.1:\d{2,5}$/,
];

export const originAllowed = (origin) => !origin || ORIGIN_OK.some((re) => re.test(origin));

/* ── M1b: the body allow-list ─────────────────────────────────────────────── */

/** Avalanche: the Avax Wallet's chain (moves in and out, swaps). Written out: this file reads no Avax module. */
const AVALANCHE = 43114;

/** Every chain a body may name: today's deposit / withdraw routes (withdraw's are a subset), HyperCore and Avalanche. */
export const RELAY_QUOTE_CHAINS = Object.freeze([...new Set([...PERP_DEPOSIT_ROUTES.map((r) => r.chainId), HL_RELAY_CHAIN_ID, AVALANCHE])].sort((a, b) => a - b));

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
/* A currency: an EVM address, or HyperCore's 16-byte USDC id (routes.js HL_PERP_USDC). */
const isCurrency = (v) => typeof v === "string" && /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{32})$/.test(v);
const isChain = (v) => Number.isSafeInteger(v) && RELAY_QUOTE_CHAINS.includes(v);
const isDigits = (v) => typeof v === "string" && /^[0-9]{1,78}$/.test(v);
const isBool = (v) => v === true || v === false;
const isSources = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every((s) => typeof s === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(s));

/** Each key a body may carry, and the shape our builders send it in. */
export const RELAY_QUOTE_KEYS = Object.freeze({
  user: isAddress,
  recipient: isAddress,
  refundTo: isAddress,
  originChainId: isChain,
  originCurrency: isCurrency,
  destinationChainId: isChain,
  destinationCurrency: isCurrency,
  amount: isDigits,
  tradeType: (v) => v === "EXACT_INPUT" || v === "EXACT_OUTPUT",
  useDepositAddress: isBool,
  topupGas: isBool,
  topupGasAmount: isDigits,
  usePermit: isBool,
  useMulticallAuthorization: isBool,
  slippageTolerance: isDigits,
  includedSwapSources: isSources,
});

/** The nine every builder sends. */
const REQUIRED = Object.freeze(["user", "recipient", "refundTo", "originChainId", "originCurrency", "destinationChainId", "destinationCurrency", "amount", "tradeType"]);

/**
 * Why this body may not go to Relay on our key, or null when it may.
 * @returns {{ error: string, key?: string }|null}
 */
export function relayQuoteBodyProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "bad_request" };
  for (const k of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(RELAY_QUOTE_KEYS, k)) return { error: "key_not_allowed", key: k };
    if (!RELAY_QUOTE_KEYS[k](body[k])) return { error: "bad_value", key: k };
  }
  for (const k of REQUIRED) if (!Object.prototype.hasOwnProperty.call(body, k)) return { error: "missing_key", key: k };
  return null;
}

const hits = new Map();
export function rateLimited(ip, now = Date.now()) {
  const k = ip || "unknown";
  const recent = (hits.get(k) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(k, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_PER_MIN;
}

/**
 * The exchange without HTTP (tests call this).
 * @returns {Promise<{ status: number, body: string }>}  body is Relay's answer, verbatim, or our own JSON error
 */
export async function relayQuoteOnce({ body, env = process.env, fetchImpl = fetch }) {
  const problem = relayQuoteBodyProblem(body);
  if (problem) return { status: 400, body: JSON.stringify(problem) };
  const key = String(env.RELAY_API_KEY || "").trim();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    /* Never echo the key, whatever the upstream says. */
    return { status: r.status, body: key ? text.split(key).join("[key]") : text };
  } catch (e) {
    return { status: 504, body: JSON.stringify({ message: e && e.name === "AbortError" ? "The quote service took too long." : "Couldn't reach the quote service." }) };
  } finally {
    clearTimeout(t);
  }
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

function send(res, status, text) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "method_not_allowed" }));
  if (!originAllowed(req.headers.origin)) return send(res, 403, JSON.stringify({ error: "forbidden" }));
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, 429, JSON.stringify({ message: "Too many quotes. Wait a minute." }));
  const body = await readBody(req);
  if (!body) return send(res, 400, JSON.stringify({ error: "bad_request" }));
  const out = await relayQuoteOnce({ body });
  return send(res, out.status, out.body);
}
