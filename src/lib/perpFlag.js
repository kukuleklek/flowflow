// ─────────────────────────────────────────────────────────────────────────────
// The Perp mode switch.
// ─────────────────────────────────────────────────────────────────────────────
//
// FlowFlow IS the Perp mode, so it is ON unless a build sets VITE_PERP_ENABLED="0"
// (an earlier build defaulted to the opposite). The switch survives because the Privy
// bridge gates its no-window signers behind it, and its tests check both sides:
// with the mode off the bridge registers no silent signer at all.

export const PERP_ENABLED = import.meta.env.VITE_PERP_ENABLED !== "0";

/* A starred perp lives in the watchlist under a namespaced key ("perp:btc").
   Hyperliquid coin names are unique case-insensitively, so lowercasing loses nothing. */
export const PERP_WATCH_PREFIX = "perp:";

/** The watchlist key for a perp coin ("BTC" -> "perp:btc"). Empty for no coin. */
export function perpWatchKey(coin) {
  const c = coin == null ? "" : String(coin).trim();
  return c ? PERP_WATCH_PREFIX + c.toLowerCase() : "";
}

export function isPerpWatchKey(key) {
  return typeof key === "string" && key.startsWith(PERP_WATCH_PREFIX) && key.length > PERP_WATCH_PREFIX.length;
}

/** The starred perp coins in a watchlist, lowercased, newest first (the list's own order). */
export function perpStarsOf(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isPerpWatchKey).map((k) => k.slice(PERP_WATCH_PREFIX.length));
}
