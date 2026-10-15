// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid candles in the shape the chart already draws.
// ─────────────────────────────────────────────────────────────────────────────
//
// History: POST /info {type:"candleSnapshot", req:{coin, interval, startTime,
// endTime}}. Measured live 2026-09-22: rows are {t, T, s, i, o, c, h, l, v, n}
// with t/T in MILLISECONDS and o/h/l/c/v as STRINGS, ascending. The window is
// capped by the venue — a 5-day 1m ask returned 5228 rows covering only the
// newest 87 hours, the oldest 33 hours silently dropped — so never assume the
// answer spans the window asked for; read it from the rows.
//
// Live: WebSocket {type:"candle", coin, interval}; each push is the forming
// candle in the same row shape (strings again), so both paths share one parser.
//
// Out: {time (seconds, lightweight-charts' UTCTimestamp), open, high, low,
// close, volume} as numbers, sorted, one row per time. Volume is in COIN units
// (Hyperliquid's v), not USD. A row with an unreadable price is DROPPED, never
// zero-filled: a zero candle is a crash drawn on the chart.

import { hlInfo, HlInfoError } from "./info.js";
import { hlWs } from "./ws.js";
import { cachedFetch, cachedPeek } from "../reqCache.js";

export const HL_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"];

const MIN = 60_000;
export const HL_INTERVAL_MS = Object.freeze({
  "1m": MIN, "3m": 3 * MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN,
  "1h": 60 * MIN, "2h": 120 * MIN, "4h": 240 * MIN, "8h": 480 * MIN, "12h": 720 * MIN,
  "1d": 1440 * MIN, "3d": 3 * 1440 * MIN, "1w": 7 * 1440 * MIN,
  "1M": 31 * 1440 * MIN,   // a calendar month at its longest, for sizing a window only
});

/** ChartPanel's timeframe ids are seconds (60 ... 86400). */
export const FLOWFLOW_TF_TO_HL = Object.freeze({ 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" });

const LABEL_TO_HL = { "1H": "1h", "2H": "2h", "4H": "4h", "8H": "8h", "12H": "12h", "1D": "1d", "3D": "3d", "1W": "1w" };

/**
 * A Hyperliquid interval for a chart timeframe: seconds (60, 14400, ...),
 * ChartPanel's labels ("1m", "1H", "4H", "1D") or a Hyperliquid interval
 * itself. "1M" is a month (Hyperliquid's own spelling), "1m" a minute.
 * @returns {string|null}
 */
export function hlInterval(tf) {
  if (tf == null || tf === "") return null;
  if (typeof tf === "number" || /^\d+$/.test(String(tf))) return FLOWFLOW_TF_TO_HL[Number(tf)] || null;
  const s = String(tf);
  if (HL_INTERVALS.includes(s)) return s;
  return LABEL_TO_HL[s] || null;
}

const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One Hyperliquid candle row -> a chart candle, or null when it cannot be drawn. */
export function parseHlCandle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = num(raw.t);
  const open = num(raw.o);
  const high = num(raw.h);
  const low = num(raw.l);
  const close = num(raw.c);
  if (t == null || open == null || high == null || low == null || close == null) return null;
  return { time: Math.floor(t / 1000), open, high, low, close, volume: num(raw.v) };
}

/** A candleSnapshot answer -> chart candles, ascending, one per time (a later row wins). */
export function parseHlCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map();
  for (const r of rows) {
    const c = parseHlCandle(r);
    if (c) byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Fold one live candle into a list: the forming candle is replaced, a newer one
 * appended, an older one ignored (same array back, so nothing re-renders).
 */
export function mergeHlCandle(list, candle) {
  if (!candle) return list;
  const arr = Array.isArray(list) ? list : [];
  const last = arr[arr.length - 1];
  if (!last || candle.time > last.time) return [...arr, candle];
  if (candle.time === last.time) return [...arr.slice(0, -1), candle];
  return list;
}

export const HL_CANDLE_BARS = 500;
/* How long a settled answer may be handed to a caller that does not ask for a
   fresh one. The chart always asks fresh (perp/perpChart.js): a cached history
   can be older than bars its stream already drew, and a bar that closed inside
   that gap would keep a partial OHLC for good. peekHlCandles still repaints a
   revisit from memory at once, whatever this is. */
export const HL_CANDLE_TTL_MS = 60_000;

const cacheKey = (coin, interval, bars) => `hl-candles|${coin}|${interval}|${bars}`;

const abortedError = () => new HlInfoError("Hyperliquid request aborted", { kind: "aborted" });

/* One caller's wait on a SHARED request. Its signal detaches only this caller:
   the request itself carries no caller's signal, so one caller giving up (the
   chart aborts its previous load and asks again at once) cannot fail the
   request that the next caller has just joined. hlInfo does the same one level
   down. */
function waitFor(p, signal) {
  if (!signal || typeof signal.addEventListener !== "function") return p;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/**
 * Candle history for a coin and timeframe, newest `bars` candles ending now.
 * Coalesced (callers asking while a request is in the air share it) and cached
 * for HL_CANDLE_TTL_MS (lib/reqCache.js). fresh skips the cached answer but
 * still joins a request already in the air. Rejects on a transport error or a
 * malformed answer — never resolves an empty chart for a failure.
 * @param {string} coin Hyperliquid coin name ("BTC", "kPEPE")
 * @param {number|string} tf chart timeframe or Hyperliquid interval
 * @param {{ bars?: number, endTime?: number, info?: Function, signal?: AbortSignal, fresh?: boolean }} [opts]
 *   endTime is only the clock for "now" (tests pin it); it is NOT part of the
 *   cache identity, so this is not a paging cursor for older history.
 */
export function fetchHlCandles(coin, tf, { bars = HL_CANDLE_BARS, endTime, info = hlInfo, signal, fresh = false } = {}) {
  const interval = hlInterval(tf);
  if (!coin || typeof coin !== "string") return Promise.reject(new Error("fetchHlCandles needs a coin"));
  if (!interval) return Promise.reject(new Error(`no Hyperliquid interval for timeframe ${tf}`));
  if (signal && signal.aborted) return Promise.reject(abortedError());
  const n = Math.max(1, Math.min(5000, Math.floor(bars)));
  const shared = cachedFetch(cacheKey(coin, interval, n), fresh ? 0 : HL_CANDLE_TTL_MS, async () => {
    const end = endTime ?? Date.now();
    const req = { coin, interval, startTime: end - n * HL_INTERVAL_MS[interval], endTime: end };
    const rows = await info({ type: "candleSnapshot", req });
    if (!Array.isArray(rows)) throw new Error("Hyperliquid candleSnapshot answered something that is not a list");
    return parseHlCandles(rows);
  });
  return waitFor(shared, signal);
}

/** The last candles fetched for this coin and timeframe, synchronously, or null. For repainting at once. */
export function peekHlCandles(coin, tf, { bars = HL_CANDLE_BARS } = {}) {
  const interval = hlInterval(tf);
  if (!coin || !interval) return null;
  const n = Math.max(1, Math.min(5000, Math.floor(bars)));
  return cachedPeek(cacheKey(coin, interval, n));
}

/**
 * Stream the forming candle for a coin and timeframe on the tab's shared socket.
 * onCandle receives {time, open, high, low, close, volume}. Returns unsubscribe.
 */
export function subscribeHlCandles(coin, tf, onCandle, { ws } = {}) {
  const interval = hlInterval(tf);
  if (!interval) throw new Error(`no Hyperliquid interval for timeframe ${tf}`);
  if (!coin) throw new Error("subscribeHlCandles needs a coin");
  const sock = ws || hlWs();
  return sock.subscribe({ type: "candle", coin, interval }, (data) => {
    if (!data || data.s !== coin || data.i !== interval) return;
    const c = parseHlCandle(data);
    if (c) onCandle(c);
  });
}
