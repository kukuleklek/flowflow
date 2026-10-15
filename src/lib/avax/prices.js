// ─────────────────────────────────────────────────────────────────────────────
// USD prices for the Avax Wallet: what a balance is worth (display), and an
// INDEPENDENT price the swap loss bound checks a quote against.
// ─────────────────────────────────────────────────────────────────────────────
//
// R-swap §4 + Verification, plan §3.11:
//   DISPLAY   Relay GET /currencies/token/price?address=…&chainId=43114 → {price}.
//             No key, CORS *, 200/min bucket; cached 60 s. Falls back to the
//             Hyperliquid mid for AVAX / WAVAX / BTC.b, and to the $1 peg for USDC
//             (the app's base unit). Never priced from a quote: quotes spend the
//             shared 50/min key budget and include fees.
//   CHECK     The loss bound must not trust the quoting provider's own price, so
//             the independent price is the Hyperliquid mid (AVAX, WAVAX, BTC.b),
//             the $1 peg for USDC / USDT (and Relay's own price must sit within
//             ±1% of it), and for XAUt0 the PAXG mid inside ±3% of Relay's price.
//             Anything else (XSGD) has no independent price → null → refuse.
//
// 🔴 Unknown is null, never 0. A failed price fetch is null, a price of 0 or a
// negative is null, a missing mid is null; USD values of a null price are null.

import { AVAX_CHAIN_ID } from "./config.js";
import { RELAY_API } from "../relay/routes.js";
import { assetBySymbol, AVAX_ASSETS } from "./whitelist.js";
import { rawToNumber } from "./units.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";

export const PRICE_TTL_MS = 60000;
export const PRICE_TIMEOUT_MS = 8000;
/** USDC / USDT must sit within this of $1 for the peg to stand in as the independent price. */
export const STABLE_PEG_BAND_PCT = 1;
/** Default sanity band between the display price and the independent one. */
export const PRICE_SANITY_PCT = 3;

const positive = (v) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

/** A process-wide price cache (address → {usd, at}). Tests pass their own Map. */
export const priceCache = new Map();

/**
 * Relay's USD price for one Avalanche token address. Resolves a positive number
 * or null (never throws, never 0). Cached for PRICE_TTL_MS, including misses
 * for a short while so a broken endpoint is not hammered.
 */
export async function fetchRelayPrice(address, {
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  now = browserNow,
  cache = priceCache,
  api = RELAY_API,
} = {}) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && now() - hit.at < (hit.usd == null ? PRICE_TTL_MS / 4 : PRICE_TTL_MS)) return hit.usd;
  let usd = null;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), PRICE_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(`${api}/currencies/token/price?address=${key}&chainId=${AVAX_CHAIN_ID}`, {
      method: "GET",
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (res && res.ok) {
      const json = await res.json().catch(() => null);
      usd = positive(json && json.price);
    }
  } catch {
    usd = null;
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
  cache.set(key, { usd, at: now() });
  return usd;
}

/**
 * Relay prices for every symbol given (default: all known assets), in parallel.
 * Resolves {SYMBOL: number|null}.
 */
export async function fetchRelayPrices(symbols = AVAX_ASSETS.map((a) => a.symbol), opts = {}) {
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    const a = AVAX_ASSETS.find((x) => x.symbol === s);
    out[s] = a ? await fetchRelayPrice(a.address, opts) : null;
  }));
  return out;
}

/** A Hyperliquid mid out of an allMids-shaped map ({"BTC":"81489.5"}). null when absent. */
export function hlMid(mids, coin) {
  if (!mids || typeof mids !== "object" || !coin) return null;
  return positive(mids[coin]);
}

/**
 * The price a balance is shown at: Relay, else the HL mid, else the USDC peg.
 * Resolves {usd, source: "relay"|"hl"|"peg"|null}.
 */
export function displayPrice(symbol, { relay = {}, mids = null } = {}) {
  const a = AVAX_ASSETS.find((x) => x.symbol === symbol);
  if (!a) return { usd: null, source: null };
  const r = positive(relay && relay[symbol]);
  if (r != null) return { usd: r, source: "relay" };
  const m = a.hlMid ? hlMid(mids, a.hlMid) : null;
  if (m != null) return { usd: m, source: "hl" };
  if (a.role === "base" && a.peg != null) return { usd: a.peg, source: "peg" };
  return { usd: null, source: null };
}

/**
 * The INDEPENDENT price of `symbol` for the swap loss bound, or null (refuse).
 * Never Relay's own number, except as the thing a peg or a band is checked against.
 *
 * `side` says which way the swap moves the asset, so a band asset (XAUt0 vs PAXG)
 * is priced on the side that never understates the loss (ATK-08):
 *   "out" (default) — what the user BUYS: the lower of the two;
 *   "in"            — what the user SELLS: the higher of the two.
 */
export function independentPrice(symbol, { relay = {}, mids = null, side = "out" } = {}) {
  const a = AVAX_ASSETS.find((x) => x.symbol === symbol);
  if (!a) return null;
  if (a.hlMid) return hlMid(mids, a.hlMid);
  if (a.peg != null) {
    const r = positive(relay && relay[symbol]);
    /* The peg stands in only while the market agrees with it (a depeg refuses). */
    if (r == null || Math.abs(r - a.peg) / a.peg * 100 > STABLE_PEG_BAND_PCT) return null;
    return a.peg;
  }
  if (a.sanity) {
    const m = hlMid(mids, a.sanity.hlMid);
    const r = positive(relay && relay[symbol]);
    if (m == null || r == null) return null;
    if (Math.abs(r - m) / m * 100 > a.sanity.pct) return null;
    /* Inside the band: the side that never understates a loss — what is sold at
       the higher of the two, what is bought at the lower. */
    return side === "in" ? Math.max(r, m) : Math.min(r, m);
  }
  return null;
}

/** USD value of `raw` base units of an asset at `usd`. null when either is unknown. */
export function usdValue(raw, decimals, usd) {
  const amt = rawToNumber(raw, decimals);
  const p = positive(usd);
  return amt == null || p == null ? null : amt * p;
}

/**
 * The worst-case loss of a swap, in percent of what goes in, priced
 * independently: (USD in − USD of the minimum out) / USD in × 100.
 * null when any side is unknown (the caller refuses on null).
 */
export function swapLossPct({ from, amountRaw, to, minOutRaw, relay = {}, mids = null, env = undefined }) {
  const fa = env === undefined ? assetBySymbol(from) : assetBySymbol(from, env);
  const ta = env === undefined ? assetBySymbol(to) : assetBySymbol(to, env);
  if (!fa || !ta) return null;
  const inUsd = usdValue(amountRaw, fa.decimals, independentPrice(from, { relay, mids, side: "in" }));
  const outUsd = usdValue(minOutRaw, ta.decimals, independentPrice(to, { relay, mids, side: "out" }));
  if (inUsd == null || outUsd == null || inUsd <= 0) return null;
  return ((inUsd - outUsd) / inUsd) * 100;
}

/** Do two prices agree within `pct`? false when either is unknown. */
export function pricesAgree(a, b, pct = PRICE_SANITY_PCT) {
  const x = positive(a);
  const y = positive(b);
  if (x == null || y == null) return false;
  return (Math.abs(x - y) / Math.min(x, y)) * 100 <= pct;
}
