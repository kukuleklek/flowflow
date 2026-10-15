// ─────────────────────────────────────────────────────────────────────────────
// hlInfo — the one POST /info client.
// ─────────────────────────────────────────────────────────────────────────────
//
//   • one JSON POST, straight from the browser (see config.js for why direct);
//   • a hard timeout that ABORTS the fetch rather than abandoning it;
//   • NO retries. A failed ask is reported, and the caller's own schedule (the
//     market store's refresh, the chart's next mount) is the retry. Retrying
//     here is how a blip becomes a storm against a per-IP limit;
//   • identical asks already in flight share one request, whatever the key order
//     of their bodies. Settled asks are not cached here — that is the caller's
//     choice (candles.js caches through lib/reqCache.js).
//
// Weights, for anyone adding a call (per IP, 1200 a minute): allMids and
// l2Book 2; meta, metaAndAssetCtxs and candleSnapshot 20 (candles add more per
// 60 returned). A metaAndAssetCtxs a minute is under 2% of the budget.

import { hlEndpoints } from "./config.js";
import { browserTimers } from "./browser.js";

export const HL_INFO_TIMEOUT_MS = 8000;

/** kind: "http" | "network" | "timeout" | "parse" | "aborted" */
export class HlInfoError extends Error {
  constructor(message, { kind, status = null } = {}) {
    super(message);
    this.name = "HlInfoError";
    this.kind = kind;
    this.status = status;
  }
}

/** JSON with object keys sorted, so equal bodies are one key. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const abortedError = () => new HlInfoError("Hyperliquid request aborted", { kind: "aborted" });

/**
 * Make an /info client. The default one (hlInfo below) uses the real fetch.
 * @returns {(body: object, opts?: { signal?: AbortSignal }) => Promise<any>}
 */
export function createHlInfo({
  url = hlEndpoints().info,
  fetchImpl = (...a) => globalThis.fetch(...a),
  timeoutMs = HL_INFO_TIMEOUT_MS,
  timers = browserTimers,
} = {}) {
  const inflight = new Map();

  function send(body) {
    const ctl = new AbortController();
    let timedOut = false;
    const id = timers.setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const late = () => new HlInfoError(`Hyperliquid did not answer in ${timeoutMs} ms`, { kind: "timeout" });
    /* The timer covers the BODY as well as the headers: a response that starts
       and then stalls is aborted too, and reported as the timeout it is. */
    return (async () => {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch (e) {
        if (timedOut) throw late();
        throw new HlInfoError(`Hyperliquid unreachable: ${(e && e.message) || e}`, { kind: "network" });
      }
      if (!res || !res.ok) {
        const status = res ? res.status : null;
        let detail = "";
        try { detail = String(await res.text()).slice(0, 160); } catch { /* no body */ }
        throw new HlInfoError(`Hyperliquid /info answered ${status}${detail ? `: ${detail}` : ""}`, { kind: "http", status });
      }
      try {
        return await res.json();
      } catch {
        if (timedOut) throw late();
        throw new HlInfoError("Hyperliquid /info answered something that is not JSON", { kind: "parse", status: res.status });
      }
    })().finally(() => timers.clearTimeout(id));
  }

  return function info(body, { signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortedError());
    const key = canonicalJson(body);
    let p = inflight.get(key);
    if (!p) {
      p = send(body).finally(() => { inflight.delete(key); });
      inflight.set(key, p);
    }
    if (!signal) return p;
    /* One caller giving up must not cancel what another caller is waiting on:
       the shared request carries only its own timeout, and this caller's
       signal only detaches this caller. */
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortedError());
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
        (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
      );
    });
  };
}

let shared = null;

/** POST /info on HL_NETWORK. Throws HlInfoError; never retries. */
export function hlInfo(body, opts) {
  if (!shared) shared = createHlInfo();
  return shared(body, opts);
}
