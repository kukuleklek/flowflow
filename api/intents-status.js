// GET /api/intents-status?depositAddress=0x… — one status read for a one-time private-mode address (1Click).
//
// A status read is public and keyless for public quotes (CORS *). It comes through here so that a CONFIDENTIAL
// quote's status can carry the partner key (NEAR_INTENTS_JWT, server env, never VITE_) if it turns out to need it
// (UNVERIFIED until a key exists). The answer goes back verbatim, the key scrubbed from it.
//
// 🔴 THE KEY IS SPENT ONLY FOR OUR OWN PAGES. With NEAR_INTENTS_JWT set, a read that carries one of our pages'
// Origin headers, or Sec-Fetch-Site: same-origin (a browser sends no Origin on a same-origin GET), is forwarded with
// the key; any other caller (curl, a script, another site) is forwarded KEYLESS, so it learns exactly what the public
// endpoint would tell it and nothing a confidential quote's key would add. The upstream fetch never follows a redirect
// (redirect: "error"): fetch's default would carry x-api-key to wherever a Location header points.
//
// The kill switch answers 503 { error: "private_mode_off" } here too. 🔴 That stops NOTHING the customer already
// sent from being followed: the page's status read (src/lib/intents/client.js fetchIntentsStatus) then reads the
// public endpoint directly, once per look, so a deposit on its way keeps its row whatever the switch says.
//
// Read only: nothing here signs, sends or quotes.

import { INTENTS_STATUS_UPSTREAM } from "../src/lib/intents/config.js";
import { privateModeOf, intentsKeyOf, originAllowed, keyedCallerOk, createRateLimiter } from "../src/lib/intents/guard.js";

const RATE_PER_MIN = 120;
const TIMEOUT_MS = 15_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export const rateLimited = createRateLimiter(RATE_PER_MIN);

const json = (status, obj) => ({ status, body: JSON.stringify(obj) });

/**
 * The exchange without HTTP (tests call this).
 *   useKey  false: read keyless even when the server holds the partner key (a caller not shown to be our page)
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function intentsStatusOnce({ depositAddress, env = process.env, fetchImpl = fetch, useKey = true }) {
  if (privateModeOf(env) !== "on") return json(503, { error: "private_mode_off", enabled: false, message: "Private mode is off." });
  if (typeof depositAddress !== "string" || !ADDRESS_RE.test(depositAddress)) return json(400, { error: "bad_request", message: "Not a deposit address." });
  const serverKey = intentsKeyOf(env);
  const key = useKey === false ? "" : serverKey;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${INTENTS_STATUS_UPSTREAM}?depositAddress=${encodeURIComponent(depositAddress)}`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": UA, ...(key ? { "x-api-key": key } : {}) },
      /* Never follow a redirect: it would carry x-api-key to wherever Location points. */
      redirect: "error",
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { status: r.status, body: serverKey ? text.split(serverKey).join("[key]") : text };
  } catch (e) {
    return json(504, { message: e && e.name === "AbortError" ? "The deposit service took too long." : "Couldn't reach the deposit service." });
  } finally {
    clearTimeout(t);
  }
}

function queryOf(req) {
  if (req.query && typeof req.query === "object") return req.query;
  try { return Object.fromEntries(new URL(req.url || "/", "http://local").searchParams); } catch { return {}; }
}

function send(res, out) {
  res.statusCode = out.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(out.body);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, json(405, { error: "method_not_allowed" }));
  if (privateModeOf(process.env) !== "on") return send(res, json(503, { error: "private_mode_off", enabled: false, message: "Private mode is off." }));
  if (!originAllowed(req.headers.origin)) return send(res, json(403, { error: "forbidden" }));
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, json(429, { message: "Too many status reads. Wait a minute." }));
  const q = queryOf(req);
  const addr = Array.isArray(q.depositAddress) ? q.depositAddress[0] : q.depositAddress;
  /* The partner key only for our own pages; anybody else reads what the public endpoint shows. */
  const useKey = keyedCallerOk(req.headers, process.env, { sameOriginGet: true });
  return send(res, await intentsStatusOnce({ depositAddress: addr, useKey }));
}
