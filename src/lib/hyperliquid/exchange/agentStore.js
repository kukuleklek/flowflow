// ─────────────────────────────────────────────────────────────────────────────
// The TRADING KEY: a Hyperliquid agent ("API wallet") made on this device.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner: "ใช้ Privy นั้นแหละ คุม" — the user's own wallet stays in control. It
// signs ONE approval ("Enable trading"); from then on this key signs every
// order, cancel and TP/SL change with no popup. Hyperliquid does not let an
// agent withdraw or send funds (basic_agent.py: "The agent does not have
// permission to transfer or withdraw funds"; builder-codes docs: it cannot
// approve builder fees either). Whether an agent could sign vaultTransfer or
// subAccountTransfer is UNVERIFIED (hl-api verifier, critic_A), so this file
// makes no promise beyond "it trades".
//
// LIFECYCLE
//   prepare(master)          a FRESH key (viem generatePrivateKey, i.e. the
//                            browser's crypto.getRandomValues), state pending
//   markApproved(master, a)  Hyperliquid accepted approveAgent: active
//   markRejected(master, a)  Hyperliquid said "User or API Wallet ... does not
//                            exist" (pruned, replaced elsewhere): rejected
//   expiry                   valid_until minus a minute: expired
//   clear / clearAll         wiped from storage AND memory
//   clearAllExcept(master)   every other master's key wiped (a wallet arrives)
// Every state but active reads as "Enable trading again" to the page.
//
// NAME AND EXPIRY: "flowflow valid_until <ms>". A NAMED agent, so FlowFlow never
// replaces an unnamed agent the user runs elsewhere (1 unnamed + 3 named per
// account). HL_AGENT_TTL_MS is 24 hours, and deliberately short (critic_A):
//   - the key sits in this origin's localStorage, readable by any script that
//     runs on the page (an extension, an injected script);
//   - wiping it on logout removes OUR copy only; a stolen copy keeps working
//     on Hyperliquid until valid_until, whatever we delete;
//   - it cannot withdraw, but it CAN trade the account into a loss;
//   so the window a leaked key is live is one day, and the price is one
//   wallet prompt a day. Hyperliquid's own cap is 180 days.
//
// NEVER REUSE AN AGENT ADDRESS (nonces-and-api-wallets docs, "strongly"):
// once an agent is deregistered its nonce set may be pruned and old signed
// actions replayed. Every address this browser ever generated is remembered
// per network and refused by prepare(), even if a generator hands it back.
//
// ISOLATION: records live under (network, master lowercased); a record whose
// own master or network disagrees with its key is ignored, so a key approved by
// account A can never place orders while the page shows account B.
//
// ACROSS TABS: localStorage is shared by every tab of the origin, so all tabs
// trade with the same key, and a re-enable in one tab reaches the others
// through the storage event (subscribe). If storage is unusable (private mode,
// blocked site data) the key lives in this tab's memory only: persisted false.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const HL_AGENT_NAME = "flowflow";
/** 24 hours; see the header for why short. */
export const HL_AGENT_TTL_MS = 86_400_000;
/** An agent reads as expired this long before Hyperliquid's own cut-off. */
export const HL_AGENT_EXPIRY_MARGIN_MS = 60_000;

const MAX_FRESH_TRIES = 8;
const USED_MAX = 500;

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isKey = (k) => typeof k === "string" && /^0x[0-9a-fA-F]{64}$/.test(k);

/** "flowflow valid_until 1700086400000" — the name approveAgent carries. */
export function agentNameWithExpiry(validUntil) {
  return `${HL_AGENT_NAME} valid_until ${validUntil}`;
}

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function defaultListen(handler) {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/**
 * @param {{ profile: object, storage?: Storage|null, now?: () => number,
 *   generateKey?: () => string, listen?: ((h: Function) => Function)|null }} o
 */
export function createAgentStore({ profile, storage = defaultStorage(), now = () => Date.now(), generateKey = generatePrivateKey, listen = defaultListen } = {}) {
  if (!profile || typeof profile.storagePrefix !== "string" || typeof profile.network !== "string") {
    throw new Error("createAgentStore needs a network profile");
  }
  const network = profile.network;
  const recordPrefix = `${profile.storagePrefix}.agent.`;
  const usedKey = `${profile.storagePrefix}.agentsUsed`;
  const mem = new Map();
  const listeners = new Set();
  let version = 0;
  let detach = null;

  const keyFor = (masterLc) => recordPrefix + masterLc;

  function emit() {
    version++;
    for (const fn of [...listeners]) {
      try { fn(); } catch { /* a reader's bug is not the store's */ }
    }
  }

  function rawGet(key) {
    if (mem.has(key)) return mem.get(key);
    if (!storage) return null;
    try { return storage.getItem(key); } catch { return null; }
  }

  /* true when the value reached storage; otherwise it is kept in memory. */
  function rawSet(key, value) {
    if (storage) {
      try {
        storage.setItem(key, value);
        mem.delete(key);
        return true;
      } catch { /* fall through to memory */ }
    }
    mem.set(key, value);
    return false;
  }

  function rawRemove(key) {
    mem.delete(key);
    if (!storage) return;
    try { storage.removeItem(key); } catch { /* nothing more to do */ }
  }

  function readUsed() {
    try {
      const v = JSON.parse(rawGet(usedKey) || "[]");
      return Array.isArray(v) ? v.filter((a) => typeof a === "string") : [];
    } catch {
      return [];
    }
  }

  function readRecord(masterLc) {
    const raw = rawGet(keyFor(masterLc));
    if (!raw) return null;
    let r;
    try { r = JSON.parse(raw); } catch { return null; }
    if (!r || typeof r !== "object") return null;
    if (r.master !== masterLc || r.network !== network) return null;
    if (!isKey(r.privateKey) || !isAddress(r.address) || !Number.isSafeInteger(r.validUntil)) return null;
    if (!["pending", "approved", "rejected"].includes(r.state)) return null;
    return { ...r, persisted: !mem.has(keyFor(masterLc)) };
  }

  function writeRecord(r) {
    const { persisted, ...plain } = r;
    return rawSet(keyFor(r.master), JSON.stringify(plain));
  }

  const lcMaster = (m) => (isAddress(m) ? m.toLowerCase() : null);

  function stateOf(r) {
    if (!r) return "none";
    if (r.state === "pending") return "pending";
    if (r.state === "rejected") return "rejected";
    return now() >= r.validUntil - HL_AGENT_EXPIRY_MARGIN_MS ? "expired" : "active";
  }

  const store = {
    network,

    /** Safe to render or log: never carries the private key. */
    status(master) {
      const m = lcMaster(master);
      const r = m ? readRecord(m) : null;
      const state = stateOf(r);
      if (!r) return { state, address: null, validUntil: null, reason: null, persisted: null };
      return { state, address: r.address, validUntil: r.validUntil, reason: r.reason ?? null, persisted: r.persisted };
    },

    /**
     * A fresh key for this master, pending until markApproved. Replaces any
     * record the master had. at: the corrected clock (Hyperliquid's time) the
     * expiry is counted from; default this store's clock.
     */
    prepare(master, { at } = {}) {
      const m = lcMaster(master);
      if (!m) throw new Error("prepare needs the master wallet's address");
      const used = new Set(readUsed().map((a) => a.toLowerCase()));
      let key = null;
      let address = null;
      for (let i = 0; i < MAX_FRESH_TRIES && !key; i++) {
        const k = generateKey();
        if (!isKey(k)) continue;
        const a = privateKeyToAccount(k).address.toLowerCase();
        if (used.has(a)) continue;
        key = k;
        address = a;
      }
      if (!key) throw new Error("the key generator keeps returning used agent addresses; never reuse an agent address");
      const base = Number.isFinite(at) ? Math.floor(at) : now();
      const validUntil = base + HL_AGENT_TTL_MS;
      rawSet(usedKey, JSON.stringify([...readUsed(), address].slice(-USED_MAX)));
      const rec = {
        master: m, network, address, privateKey: key, validUntil,
        agentName: agentNameWithExpiry(validUntil), state: "pending", reason: null, createdAt: now(),
      };
      const persisted = writeRecord(rec);
      emit();
      return { ...rec, persisted };
    },

    /** Hyperliquid accepted approveAgent for this address. Null when it is not the pending key. */
    markApproved(master, address) {
      const m = lcMaster(master);
      const r = m ? readRecord(m) : null;
      if (!r || !isAddress(address) || r.address !== address.toLowerCase() || r.state !== "pending") return null;
      writeRecord({ ...r, state: "approved", approvedAt: now() });
      emit();
      return store.status(m);
    },

    /** Hyperliquid refused this key. A late verdict on an OLD key is ignored. */
    markRejected(master, address, reason = "agent_missing") {
      const m = lcMaster(master);
      const r = m ? readRecord(m) : null;
      if (!r || !isAddress(address) || r.address !== address.toLowerCase()) return null;
      writeRecord({ ...r, state: "rejected", reason });
      emit();
      return store.status(m);
    },

    /** Drop a key that was never approved (a declined popup, a refused approval). */
    discardPending(master, address) {
      const m = lcMaster(master);
      const r = m ? readRecord(m) : null;
      if (!r || r.state !== "pending" || !isAddress(address) || r.address !== address.toLowerCase()) return false;
      rawRemove(keyFor(m));
      emit();
      return true;
    },

    /** The signer for an ACTIVE key (a viem local account), else null. */
    account(master) {
      const m = lcMaster(master);
      const r = m ? readRecord(m) : null;
      if (stateOf(r) !== "active") return null;
      return privateKeyToAccount(r.privateKey);
    },

    /** The full record, private key included, for the signing path only. Never render it. */
    read(master) {
      const m = lcMaster(master);
      return m ? readRecord(m) : null;
    },

    /** Wipe this master's key from storage and memory. */
    clear(master) {
      const m = lcMaster(master);
      if (!m) return;
      const had = rawGet(keyFor(m)) != null;
      rawRemove(keyFor(m));
      if (had) emit();
    },

    /** Wipe every key of this network. */
    clearAll() {
      store.clearAllExcept(null);
    },

    /**
     * Wipe every key of this network but the one master's (null: all of them).
     * The first wallet a page load sees: a key another account approved on this
     * device, before an account switch no open tab witnessed, goes now.
     */
    clearAllExcept(master) {
      const keep = lcMaster(master);
      const keepKey = keep ? keyFor(keep) : null;
      const keys = new Set([...mem.keys()].filter((k) => k.startsWith(recordPrefix)));
      if (storage) {
        try {
          for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (typeof k === "string" && k.startsWith(recordPrefix)) keys.add(k);
          }
        } catch { /* unreadable storage: memory is still cleared */ }
      }
      if (keepKey) keys.delete(keepKey);
      for (const k of keys) rawRemove(k);
      if (keys.size) emit();
      return keys.size;
    },

    /** useSyncExternalStore-friendly: subscribe + version. */
    subscribe(fn) {
      listeners.add(fn);
      if (!detach && typeof listen === "function") {
        detach = listen((e) => {
          const k = e ? e.key : null;
          if (k == null || (typeof k === "string" && k.startsWith(`${profile.storagePrefix}.agent`))) emit();
        });
      }
      return () => {
        listeners.delete(fn);
        if (!listeners.size && detach) {
          const d = detach;
          detach = null;
          try { d(); } catch { /* already gone */ }
        }
      };
    },
    version: () => version,
  };
  return store;
}

/**
 * Disconnect, account change and Privy logout: the OLD master's key is wiped.
 * A wallet arriving (the first one a page load sees, or a switch to it) keeps
 * only its own key: every other master's key on this device is wiped, so an
 * account change made while no tab was open does not leave the old account's
 * key at rest. The same account in another letter case is not a change.
 */
export function wipeAgentOnWalletChange(store, prevMaster, nextMaster) {
  if (!store) return false;
  const prev = isAddress(prevMaster) ? prevMaster.toLowerCase() : null;
  const next = isAddress(nextMaster) ? nextMaster.toLowerCase() : null;
  if (next) {
    if (prev === next) return false;
    store.clearAllExcept(next);
    return true;
  }
  if (!prev) return false;
  store.clear(prev);
  return true;
}
