/**
 * test-hl-exchange-state — THE TRADING KEY AND THE NONCE, ON THE DEVICE.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner: "ใช้ Privy นั้นแหละ คุม" — the user's own wallet stays in control. It
 * approves a short-lived TRADING KEY once ("Enable trading"); that key then signs
 * every order, cancel and TP/SL drag with no popup, and it can never withdraw.
 *
 *   K. agentStore.js
 *      - a fresh key per approval, stored under (network, master lowercased),
 *        named "flowflow" with a valid_until the store picked;
 *      - never reuse an agent address (pruned nonces make old actions
 *        replayable — nonces-and-api-wallets docs);
 *      - isolation: a key of master A is never handed out for master B, nor a
 *        mainnet key on testnet;
 *      - wipe: clear(master) / clearAll(), and wipeAgentOnWalletChange for
 *        disconnect, account change and Privy logout;
 *      - expiry and an HL rejection both read as "Enable trading again";
 *      - subscribe(): same-tab writes and other tabs' storage events;
 *      - a corrupt blob or a throwing storage never crashes; the private key
 *        never appears in a status object.
 *   N. nonce.js
 *      - monotonic per signer under CONCURRENT calls, across two "tabs" that
 *        share storage and a Web Locks manager;
 *      - a frozen clock still yields unique, increasing nonces;
 *      - corrected by server time (a phone 3 days slow still lands inside
 *        (T - 2d, T + 1d)); a stored nonce from a wrong clock is dropped;
 *      - per signer and per network; works with no storage and no locks.
 *
 * Run: node --test scripts/test-hl-exchange-state.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EX = (f) => pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/exchange", f)).href;

globalThis.fetch = () => { throw new Error("test-hl-exchange-state: a real network call was attempted"); };

let A, NC, N, viemAccounts;
before(async () => {
  A = await import(EX("agentStore.js"));
  NC = await import(EX("nonce.js"));
  N = await import(EX("network.js"));
  viemAccounts = await import("viem/accounts");
});

const MASTER_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const MASTER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DAY = 86_400_000;

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/* Deterministic keys: the Nth key generated. */
function keyGen(start = 1) {
  let i = start;
  return () => `0x${(i++).toString(16).padStart(64, "0")}`;
}

function store({ storage = memStorage(), network = "mainnet", now = () => 1_700_000_000_000, generateKey = keyGen(), listen = null } = {}) {
  return A.createAgentStore({ profile: N.hlNetworkProfile(network), storage, now, generateKey, listen });
}

/* ════════════════════════════════════════════════════════════════════════════
   K. THE AGENT STORE
   ════════════════════════════════════════════════════════════════════════════ */

test("K1) the name and the expiry: 'flowflow valid_until <ms>', 24 hours, and why short (the key trades but cannot withdraw)", () => {
  assert.equal(A.HL_AGENT_NAME, "flowflow");
  assert.equal(A.HL_AGENT_TTL_MS, DAY);
  assert.ok(A.HL_AGENT_TTL_MS <= 180 * DAY, "Hyperliquid's own cap is 180 days");
  assert.equal(A.agentNameWithExpiry(1700086400000), "flowflow valid_until 1700086400000");
});

test("K2) prepare() makes a FRESH key under (network, master lowercased), pending until the approval lands; the status never carries the private key", () => {
  const s = store();
  assert.equal(s.status(MASTER_A).state, "none");
  const rec = s.prepare(MASTER_A);
  const expectAddr = viemAccounts.privateKeyToAccount(`0x${(1).toString(16).padStart(64, "0")}`).address.toLowerCase();
  assert.equal(rec.address, expectAddr);
  assert.equal(rec.master, MASTER_A.toLowerCase());
  assert.equal(rec.network, "mainnet");
  assert.equal(rec.validUntil, 1_700_000_000_000 + DAY);
  assert.equal(rec.agentName, "flowflow valid_until 1700086400000");
  const st = s.status(MASTER_A);
  assert.equal(st.state, "pending");
  assert.equal(JSON.stringify(st).includes(rec.privateKey.slice(2)), false, "a status object is safe to log or render");
  assert.equal(s.account(MASTER_A), null, "a pending key signs nothing");
  s.markApproved(MASTER_A, rec.address);
  assert.equal(s.status(MASTER_A).state, "active");
  assert.equal(s.account(MASTER_A).address.toLowerCase(), rec.address);
});

test("K3) 🔴 never reuse an agent address: every prepare() is a new key, and an address once approved is refused forever after", () => {
  const storage = memStorage();
  const gen = keyGen();
  const s = store({ storage, generateKey: gen });
  const first = s.prepare(MASTER_A);
  s.markApproved(MASTER_A, first.address);
  const second = s.prepare(MASTER_A);
  assert.notEqual(second.address, first.address);
  /* A generator that hands back the old key (a bug, or a restored backup) is not trusted. */
  const again = [`0x${(1).toString(16).padStart(64, "0")}`, `0x${(1).toString(16).padStart(64, "0")}`, `0x${(99).toString(16).padStart(64, "0")}`];
  const s2 = store({ storage, generateKey: () => again.shift() });
  const third = s2.prepare(MASTER_A);
  assert.notEqual(third.address, first.address, "the used address was skipped");
  assert.equal(third.address, viemAccounts.privateKeyToAccount(`0x${(99).toString(16).padStart(64, "0")}`).address.toLowerCase());
  assert.throws(() => store({ storage, generateKey: () => `0x${(1).toString(16).padStart(64, "0")}` }).prepare(MASTER_A), /never reuse/);
  assert.equal(s.markApproved(MASTER_A, "0x0000000000000000000000000000000000000001"), null, "approving an address that is not the pending one does nothing");
});

test("K4) isolation: master A's key is never master B's, and a mainnet key is invisible on testnet (same browser storage)", () => {
  const storage = memStorage();
  const main = store({ storage, network: "mainnet" });
  const test = store({ storage, network: "testnet", generateKey: keyGen(50) });
  const a = main.prepare(MASTER_A);
  main.markApproved(MASTER_A, a.address);
  assert.equal(main.status(MASTER_B).state, "none");
  assert.equal(main.account(MASTER_B), null);
  assert.equal(test.status(MASTER_A).state, "none", "testnet does not see the mainnet key");
  assert.equal(main.account(MASTER_A.toLowerCase()).address.toLowerCase(), a.address, "the master's case does not matter");
  const keys = [...storage.m.keys()];
  assert.ok(keys.some((k) => k.startsWith("flowflow.hl.mainnet.") && k.includes(MASTER_A.toLowerCase())));
  assert.ok(keys.every((k) => !k.startsWith("flowflow.hl.testnet.") || !k.includes("agent.")), "nothing written under testnet");
  /* A record copied under another master's key is refused, not trusted. */
  const bKey = keys.find((k) => k.includes(MASTER_A.toLowerCase()) && /\.agent\./.test(k)).replace(MASTER_A.toLowerCase(), MASTER_B);
  storage.setItem(bKey, storage.getItem(keys.find((k) => k.includes(MASTER_A.toLowerCase()) && /\.agent\./.test(k))));
  assert.equal(main.status(MASTER_B).state, "none");
  assert.equal(main.account(MASTER_B), null);
});

test("K5) expiry: an approved key reads 'expired' a minute before its valid_until, and signs nothing", () => {
  let t = 1_700_000_000_000;
  const s = store({ now: () => t });
  const rec = s.prepare(MASTER_A);
  s.markApproved(MASTER_A, rec.address);
  t = rec.validUntil - 61_000;
  assert.equal(s.status(MASTER_A).state, "active");
  t = rec.validUntil - 59_000;
  assert.equal(s.status(MASTER_A).state, "expired");
  assert.equal(s.account(MASTER_A), null);
});

test("K6) an HL rejection ('User or API Wallet ... does not exist') turns the key into 'rejected' — Enable trading again", () => {
  const s = store();
  const rec = s.prepare(MASTER_A);
  s.markApproved(MASTER_A, rec.address);
  s.markRejected(MASTER_A, rec.address, "agent_missing");
  const st = s.status(MASTER_A);
  assert.equal(st.state, "rejected");
  assert.equal(st.reason, "agent_missing");
  assert.equal(s.account(MASTER_A), null);
  s.markRejected(MASTER_A, "0x0000000000000000000000000000000000000009", "agent_missing");
  const next = s.prepare(MASTER_A);
  s.markApproved(MASTER_A, next.address);
  s.markRejected(MASTER_A, rec.address, "agent_missing");
  assert.equal(s.status(MASTER_A).state, "active", "a late rejection of the OLD key does not kill the new one");
});

test("K7) wipe: clear(master), clearAll(), and wipeAgentOnWalletChange for disconnect / account change / Privy logout", () => {
  const storage = memStorage();
  const s = store({ storage });
  for (const m of [MASTER_A, MASTER_B]) { const r = s.prepare(m); s.markApproved(m, r.address); }
  s.clear(MASTER_A);
  assert.equal(s.status(MASTER_A).state, "none");
  assert.equal(s.status(MASTER_B).state, "active");
  assert.equal([...storage.m.values()].some((v) => /privateKey/.test(v) && v.includes(MASTER_A.toLowerCase())), false, "the key is gone from storage, not just hidden");
  const r = s.prepare(MASTER_A); s.markApproved(MASTER_A, r.address);
  A.wipeAgentOnWalletChange(s, MASTER_A, MASTER_A.toLowerCase());
  assert.equal(s.status(MASTER_A).state, "active", "the same account (any case) is not a change");
  A.wipeAgentOnWalletChange(s, MASTER_A, MASTER_B);
  assert.equal(s.status(MASTER_A).state, "none", "account change wipes the OLD master's key");
  A.wipeAgentOnWalletChange(s, MASTER_B, null);
  assert.equal(s.status(MASTER_B).state, "none", "disconnect / logout wipes");
  const r2 = s.prepare(MASTER_A); s.markApproved(MASTER_A, r2.address);
  s.clearAll();
  assert.equal(s.status(MASTER_A).state, "none");
  assert.equal([...storage.m.values()].some((v) => /privateKey/.test(v)), false);
});

test("K7b) a wallet ARRIVING keeps only its own key: an account switch no open tab saw (A approved, the next load connects B) wipes A's key", () => {
  const storage = memStorage();
  /* Last visit: A approved a key, then the tab closed while A was connected. */
  const first = store({ storage });
  const ra = first.prepare(MASTER_A); first.markApproved(MASTER_A, ra.address);
  const rb = first.prepare(MASTER_B); first.markApproved(MASTER_B, rb.address);
  /* This load: a fresh page (fresh store, same storage) and the wallet is B. */
  const s = store({ storage, generateKey: keyGen(100) });
  assert.equal(s.status(MASTER_A).state, "active", "the control: A's key was at rest");
  assert.equal(A.wipeAgentOnWalletChange(s, null, MASTER_B), true);
  assert.equal(s.status(MASTER_A).state, "none", "A's key is gone on the first wallet this load sees");
  assert.equal([...storage.m.values()].some((v) => v.includes(MASTER_A.toLowerCase()) && /privateKey/.test(v)), false, "gone from storage, not just hidden");
  assert.equal(s.status(MASTER_B).state, "active", "the connected wallet's own key stays");
  assert.equal(A.wipeAgentOnWalletChange(s, null, MASTER_B.toUpperCase().replace("0X", "0x")), true);
  assert.equal(s.status(MASTER_B).state, "active", "the same account in another case keeps its key");
  assert.equal(A.wipeAgentOnWalletChange(s, null, null), false, "no wallet before and none now: nothing to do");
  assert.equal(s.status(MASTER_B).state, "active");
  assert.equal(s.clearAllExcept(MASTER_B), 0, "nothing else left to wipe");
  assert.equal(s.clearAllExcept(null), 1, "null keeps nobody");
  assert.equal(s.status(MASTER_B).state, "none");
});

test("K8) subscribe(): told on every write in this tab and on another tab's storage event for our namespace, not for others", () => {
  let handler = null;
  const s = store({ listen: (h) => { handler = h; return () => { handler = null; }; } });
  let calls = 0;
  const off = s.subscribe(() => { calls++; });
  const r = s.prepare(MASTER_A);
  s.markApproved(MASTER_A, r.address);
  assert.equal(calls, 2);
  const v = s.version();
  handler({ key: `flowflow.hl.mainnet.agent.${MASTER_A.toLowerCase()}` });
  assert.equal(calls, 3);
  assert.ok(s.version() > v, "useSyncExternalStore sees a new version");
  handler({ key: "flowflow.perpMock.v1" });
  assert.equal(calls, 3, "someone else's key");
  handler({ key: null });
  assert.equal(calls, 4, "a storage clear() elsewhere could have removed our key");
  off();
  assert.equal(handler, null, "the last reader detaches the storage listener");
  s.clear(MASTER_A);
  assert.equal(calls, 4);
});

test("K9) a corrupt blob or a throwing storage never crashes: unknown reads as 'none'; with no usable storage the key lives in this tab only, and says so", () => {
  const storage = memStorage();
  storage.setItem(`flowflow.hl.mainnet.agent.${MASTER_A.toLowerCase()}`, "{not json");
  const s = store({ storage });
  assert.equal(s.status(MASTER_A).state, "none");
  const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); }, removeItem() { throw new Error("SecurityError"); }, key: () => null, length: 0 };
  for (const bad of [broken, null]) {
    const b = A.createAgentStore({ profile: N.hlNetworkProfile("mainnet"), storage: bad, now: () => 1_700_000_000_000, generateKey: keyGen() });
    assert.equal(b.status(MASTER_A).state, "none");
    const rec = b.prepare(MASTER_A);
    assert.equal(rec.persisted, false, "private mode: a reload will ask for Enable trading again");
    b.markApproved(MASTER_A, rec.address);
    assert.equal(b.status(MASTER_A).state, "active");
    assert.equal(b.status(MASTER_A).persisted, false);
    assert.ok(b.account(MASTER_A));
    assert.doesNotThrow(() => b.clear(MASTER_A));
    assert.equal(b.status(MASTER_A).state, "none", "a wipe also wipes the in-memory copy");
  }
});

test("K10) a bad master is refused outright", () => {
  const s = store();
  for (const bad of [null, "", "0x123", "hello"]) {
    assert.equal(s.status(bad).state, "none");
    assert.throws(() => s.prepare(bad), /master/);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   N. THE NONCE
   ════════════════════════════════════════════════════════════════════════════ */

/* A LockManager like navigator.locks: exclusive, FIFO per name, async callback. */
function fakeLocks() {
  const queues = new Map();
  let held = 0; let maxHeld = 0;
  return {
    get maxHeld() { return maxHeld; },
    request(name, opts, cb) {
      const fn = typeof opts === "function" ? opts : cb;
      const prev = queues.get(name) || Promise.resolve();
      const run = prev.then(async () => { held++; maxHeld = Math.max(maxHeld, held); try { return await fn({ name }); } finally { held--; } });
      queues.set(name, run.catch(() => {}));
      return run;
    },
  };
}

const SIGNER = "0x5e9ee1089755c3435139848e47e6635505d5a13a";

test("N1) 🔴 monotonic under CONCURRENT calls across two tabs sharing storage and Web Locks — unique, increasing per tab, no gaps skipped into the past", async () => {
  const storage = memStorage();
  const locks = fakeLocks();
  const t0 = 1_700_000_000_000;
  const tabA = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage, locks, now: () => t0 });
  const tabB = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage, locks, now: () => t0 });
  const pa = Array.from({ length: 100 }, () => tabA.next(SIGNER));
  const pb = Array.from({ length: 100 }, () => tabB.next(SIGNER));
  const [a, b] = [await Promise.all(pa), await Promise.all(pb)];
  const all = [...a, ...b];
  assert.equal(new Set(all).size, 200, "no nonce is ever handed out twice");
  for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], "tab A increases in call order");
  for (let i = 1; i < b.length; i++) assert.ok(b[i] > b[i - 1], "tab B increases in call order");
  assert.equal(Math.min(...all), t0, "a frozen clock starts at now");
  assert.equal(Math.max(...all), t0 + 199, "and counts up by one, never skipping far into the future");
  assert.equal(locks.maxHeld, 1, "the read-modify-write is exclusive");
});

test("N2) without Web Locks (old Safari, a worker) one tab is still strictly monotonic under concurrency", async () => {
  const t0 = 1_700_000_000_000;
  const n = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage: memStorage(), locks: null, now: () => t0 });
  const got = await Promise.all(Array.from({ length: 50 }, () => n.next(SIGNER)));
  assert.deepEqual(got, Array.from({ length: 50 }, (_, i) => t0 + i));
});

test("N3) per signer and per network: the agent and the master each have their own counter, and mainnet never advances testnet", async () => {
  const storage = memStorage();
  const t0 = 1_700_000_000_000;
  const main = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage, locks: fakeLocks(), now: () => t0 });
  const test = NC.createNonceAllocator({ profile: N.hlNetworkProfile("testnet"), storage, locks: fakeLocks(), now: () => t0 });
  assert.equal(await main.next(SIGNER), t0);
  assert.equal(await main.next(SIGNER), t0 + 1);
  assert.equal(await main.next(MASTER_A), t0, "another signer starts at now");
  assert.equal(await test.next(SIGNER), t0, "another network starts at now");
  assert.equal(await main.next(SIGNER.toUpperCase().replace("0X", "0x")), t0 + 2, "the signer's case does not split the counter");
});

test("N4) corrected by SERVER time: a phone clock 3 days slow still signs inside (T - 2d, T + 1d)", async () => {
  const serverNow = 1_700_000_000_000;
  const local = serverNow - 3 * DAY;
  const n = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage: memStorage(), locks: null, now: () => local });
  n.noteServerTime(serverNow, local);
  assert.equal(n.clockOffset(), 3 * DAY);
  const nonce = await n.next(SIGNER);
  assert.equal(nonce, serverNow);
  assert.ok(NC.isNonceInWindow(nonce, serverNow));
  assert.equal(NC.isNonceInWindow(serverNow - 2 * DAY, serverNow), false, "the window is open at both ends");
  assert.equal(NC.isNonceInWindow(serverNow + DAY, serverNow), false);
  n.noteServerTime(NaN, local);
  assert.equal(n.clockOffset(), 3 * DAY, "an unreadable server time changes nothing");
});

test("N5) a stored nonce from a clock that ran FAST (beyond T + 1d) is dropped instead of dragging every later nonce out of the window", async () => {
  const storage = memStorage();
  const t0 = 1_700_000_000_000;
  const fast = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage, locks: null, now: () => t0 + 5 * DAY });
  await fast.next(SIGNER);
  const right = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage, locks: null, now: () => t0 });
  const n = await right.next(SIGNER);
  assert.equal(n, t0);
  assert.ok(NC.isNonceInWindow(n, t0));
});

test("N6) no storage at all (private mode): still unique and increasing in this tab", async () => {
  const t0 = 1_700_000_000_000;
  const n = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage: null, locks: null, now: () => t0 });
  const a = await n.next(SIGNER);
  const b = await n.next(SIGNER);
  assert.ok(b > a);
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); }, removeItem() {}, key: () => null, length: 0 };
  const m = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage: throwing, locks: fakeLocks(), now: () => t0 });
  assert.equal(await m.next(SIGNER), t0);
  assert.equal(await m.next(SIGNER), t0 + 1);
});

test("N7) a moving clock: the nonce follows real time when it is ahead of the counter", async () => {
  let t = 1_700_000_000_000;
  const n = NC.createNonceAllocator({ profile: N.hlNetworkProfile("mainnet"), storage: memStorage(), locks: null, now: () => t });
  assert.equal(await n.next(SIGNER), t);
  t += 5000;
  assert.equal(await n.next(SIGNER), t);
  assert.equal(await n.next(SIGNER), t + 1);
});
