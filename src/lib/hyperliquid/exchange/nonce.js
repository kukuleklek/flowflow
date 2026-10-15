// ─────────────────────────────────────────────────────────────────────────────
// Nonces: one strictly increasing counter per SIGNER, shared by every tab.
// ─────────────────────────────────────────────────────────────────────────────
//
// Hyperliquid's rules (nonces-and-api-wallets docs, 2026-09-22):
//   - nonces are tracked per signer (the trading key for orders, the user's
//     wallet for approveAgent / approveBuilderFee / withdraw3);
//   - the 100 highest are kept; a new one must beat the smallest of them and
//     never have been used;
//   - it must fall inside (T - 2 days, T + 1 day) of Hyperliquid's own clock;
//   - "use the current timestamp in milliseconds".
//
// So a nonce is max(corrected now, last + 1):
//   corrected now   the device clock plus the offset to Hyperliquid's clock,
//                   learned from the time field /info replies carry
//                   (noteServerTime). A phone clock three days slow would
//                   otherwise get EVERY action rejected;
//   last + 1        the highest nonce this signer was ever given, persisted in
//                   localStorage so a second tab (which shares the trading key)
//                   continues from it instead of colliding.
//
// ACROSS TABS the read-modify-write runs under a Web Lock (navigator.locks),
// exclusive per signer. Where Web Locks are missing, the whole step is
// synchronous, so this tab alone still never hands out a nonce twice.
//
// A stored value from a clock that ran FAST (past the upper edge of the window)
// is dropped: continuing from it would push every later nonce out of range.

import { browserNow } from "../browser.js";

const DAY_MS = 86_400_000;
/** Hyperliquid accepts nonces strictly inside (T - 2 days, T + 1 day). */
export const HL_NONCE_WINDOW = Object.freeze({ pastMs: 2 * DAY_MS, futureMs: DAY_MS });
/* A counter this close to the upper edge is treated as poisoned. */
const FUTURE_GUARD_MS = 60_000;

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Is this nonce inside Hyperliquid's window around server time T? */
export function isNonceInWindow(nonce, serverNowMs) {
  if (!Number.isSafeInteger(nonce) || !Number.isFinite(serverNowMs)) return false;
  return nonce > serverNowMs - HL_NONCE_WINDOW.pastMs && nonce < serverNowMs + HL_NONCE_WINDOW.futureMs;
}

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function defaultLocks() {
  try {
    const l = typeof navigator !== "undefined" ? navigator.locks : null;
    return l && typeof l.request === "function" ? l : null;
  } catch { return null; }
}

/**
 * @param {{ profile: object, storage?: Storage|null, locks?: LockManager|null, now?: () => number }} o
 *   profile: network.js hlNetworkProfile(); its storagePrefix keeps mainnet
 *   and testnet counters apart.
 * @returns {{ next: (signer: string) => Promise<number>,
 *   noteServerTime: (serverMs: number, localMs?: number) => void,
 *   clockOffset: () => number, serverNow: () => number }}
 */
export function createNonceAllocator({ profile, storage = defaultStorage(), locks = defaultLocks(), now = browserNow } = {}) {
  if (!profile || typeof profile.storagePrefix !== "string") throw new Error("createNonceAllocator needs a network profile");
  const prefix = `${profile.storagePrefix}.nonce.`;
  const mem = new Map();
  let offset = 0;

  const serverNow = () => Math.floor(now() + offset);

  function readStored(key) {
    if (!storage) return null;
    try {
      const v = Number(storage.getItem(key));
      return Number.isSafeInteger(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  function writeStored(key, v) {
    if (!storage) return;
    try { storage.setItem(key, String(v)); } catch { /* private mode: this tab's memory still counts */ }
  }

  /* Synchronous on purpose: with no lock manager, nothing can interleave. */
  function allocate(signer) {
    const key = prefix + signer;
    const t = serverNow();
    const ceiling = t + HL_NONCE_WINDOW.futureMs - FUTURE_GUARD_MS;
    const usable = (v) => (v != null && v < ceiling ? v : null);
    const last = Math.max(usable(readStored(key)) ?? 0, usable(mem.get(key)) ?? 0);
    const n = Math.max(t, last + 1);
    mem.set(key, n);
    writeStored(key, n);
    return n;
  }

  return {
    /** The next nonce for this signer (an address; case does not matter). */
    next(signer) {
      if (!isAddress(signer)) return Promise.reject(new Error("a nonce needs the signer's address"));
      const who = signer.toLowerCase();
      if (!locks) {
        try { return Promise.resolve(allocate(who)); } catch (e) { return Promise.reject(e); }
      }
      return locks.request(`${prefix}${who}`, { mode: "exclusive" }, () => allocate(who));
    },
    /**
     * Record Hyperliquid's clock: serverMs is a time field from a reply,
     * localMs the device clock when that reply arrived. Unreadable values are
     * ignored.
     */
    noteServerTime(serverMs, localMs = now()) {
      const s = Number(serverMs);
      const l = Number(localMs);
      if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(l) || l <= 0) return;
      offset = s - l;
    },
    /** Hyperliquid's clock minus this device's, in ms (0 until a reply taught it). */
    clockOffset: () => offset,
    /** This device's clock corrected to Hyperliquid's. */
    serverNow,
  };
}
