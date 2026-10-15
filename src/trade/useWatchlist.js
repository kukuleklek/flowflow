import { useCallback, useSyncExternalStore } from "react";
import { perpWatchKey, perpStarsOf } from "../lib/perpFlag.js";

/* The starred markets, per browser (a convenience, never money). Stored as watch keys ("perp:btc"). */
const KEY = "flowflow.watchlist.v1";
const subs = new Set();
let cache = null;

function read() {
  if (cache) return cache;
  let list = [];
  try { list = JSON.parse(globalThis.localStorage?.getItem(KEY) || "[]"); } catch { list = []; }
  cache = new Set(perpStarsOf(Array.isArray(list) ? list : []));
  return cache;
}

function write(set) {
  cache = new Set(set);
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify([...cache].map((c) => perpWatchKey(c)))); } catch { /* storage refused */ }
  subs.forEach((f) => f());
}

const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };

export function useWatchlist() {
  const set = useSyncExternalStore(subscribe, read, read);
  const toggle = useCallback((coin) => {
    const k = String(coin).toLowerCase();
    const next = new Set(read());
    if (next.has(k)) next.delete(k); else next.add(k);
    write(next);
  }, []);
  return { set, has: (coin) => set.has(String(coin).toLowerCase()), toggle };
}
