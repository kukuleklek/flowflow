// ─────────────────────────────────────────────────────────────────────────────
// POST /exchange — the ONE place a signed action leaves the browser.
// ─────────────────────────────────────────────────────────────────────────────
//
// Straight from the browser to Hyperliquid (CORS is open on /exchange, verified
// 2026-09-22), for the same reason /info is direct: Hyperliquid rate-limits per
// IP, and a proxy would pool every FlowFlow user into one budget.
//
// NEVER RETRIED. A signed order that is sent twice can fill twice. When the
// reply is lost (network error, timeout) the outcome is UNKNOWN, and the caller
// looks the order up by its cloid (client.js) instead of sending it again —
// orders have landed on-chain while the API answered with an error before.
//
// HTTP errors are not thrown: the status and the raw body are handed back, and
// orders.js parseExchangeResponse decides what they mean (429 is rate limiting;
// a 422 text passes through verbatim).

import { browserTimers } from "../browser.js";

export const HL_EXCHANGE_TIMEOUT_MS = 10_000;

/** kind: "network" | "timeout" — the request may or may not have reached Hyperliquid. */
export class HlExchangeError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "HlExchangeError";
    this.kind = kind;
  }
}

/**
 * @returns {(body: { action: object, nonce: number, signature: object }) =>
 *   Promise<{ httpStatus: number, json: any, text: string }>}
 */
export function createHlExchange({ url, fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = HL_EXCHANGE_TIMEOUT_MS, timers = browserTimers } = {}) {
  if (typeof url !== "string" || !/^https:\/\/[^/]+\/exchange$/.test(url)) throw new Error("createHlExchange needs the /exchange URL");
  return async function post(body) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const id = timers.setTimeout(() => { timedOut = true; if (ctl) ctl.abort(); }, timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctl ? ctl.signal : undefined,
        });
      } catch (e) {
        if (timedOut) throw new HlExchangeError(`Hyperliquid did not answer in ${timeoutMs} ms`, "timeout");
        throw new HlExchangeError(`Hyperliquid unreachable: ${(e && e.message) || e}`, "network");
      }
      let text = "";
      try {
        text = String(await res.text());
      } catch (e) {
        if (timedOut) throw new HlExchangeError(`Hyperliquid did not answer in ${timeoutMs} ms`, "timeout");
        throw new HlExchangeError(`Hyperliquid's answer was cut off: ${(e && e.message) || e}`, "network");
      }
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { httpStatus: Number(res.status) || 0, json, text };
    } finally {
      timers.clearTimeout(id);
    }
  };
}
