// ─────────────────────────────────────────────────────────────────────────────
// THE FLOW REGISTRY: every money move on the Avax side, written down BEFORE the
// window that moves money, so that a reload, a second tab or a crash can never
// bring a Confirm button back for money that may already be on its way.
// PURE: storage, clock and tab id are injected; nothing runs at import time; no React.
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §3.7 (+ §2.4, §2.9 last row, §3.6, §2.12 usage-ledger rule). The plan
// reviewer's blocker: "a reload can never resurrect a Confirm".
//
// HOW THAT IS HELD
//   1. One localStorage key per account: `flowflow.flows.v1:<own lowercase>`. The
//      address is in the KEY only; a record holds no address at all (no recipient,
//      nothing 0x + 40 hex — sanitizeRecord refuses it). Switching account switches
//      registries (the chat and the Autopilot grant use the same account key).
//   2. CONFIRMABLE is computed, never stored: a record may show Confirm only when
//      its state is "review", it was created by THIS page instance (tabId, which is
//      new on every load), and it is younger than MONEY_CARD_TTL_MS. A reload gets a
//      new tabId, so every review it finds says "Ask again" — and nothing else does.
//   3. On load, every state that is not settled (TERMINAL) and not "review" becomes
//      "unknown" (resumeFrom keeps what it was), and is PERSISTED that way. Unknown is
//      watched (requestId / txHash / permitNonce) and never offers Confirm or Send again.
//   4. confirm() is the synchronous double-tap guard: review → "confirmed", written
//      and read back before it returns ok. A second confirm() of the same record fails.
//   5. beforeWindow() writes the state and the ids of the window about to open, then
//      READS THEM BACK; if storage did not keep them it THROWS, and the executors
//      (ownMove.js, moveOut.js, swap.js) do not open the window.
//   6. canStart(): no other flow may be in flight (any tab), and no flow may be
//      unknown. Storage that cannot be written means no money flow starts here.
//      THE EXIT IS NEVER WALLED IN: an unknown record idle past EXIT_PAST_UNKNOWN_MS
//      no longer holds an exit (move out, unstake, swap X → USDC) — see isExitRecord.
//   7. ONE RUN PER STAGE (ATK-03): an executor CLAIMS its stage ("own-move",
//      "move-out", "swap", "gas-leg") synchronously, before anything can yield; the
//      claim is persisted and read back, and a second claim of the same stage — a
//      React double effect, a retry, Autopilot plus a tap, two concurrent runs — is
//      refused and touches nothing. A handle's beforeWindow refuses until its stage
//      was claimed through that handle.
//   8. WHAT WAS CONFIRMED IS FIXED (ATK-04): kind, amounts, maxDebit, envelopeHash,
//      auto, tabId, startedAt and the claimed stages can never be patched after the
//      card was made; the handle's get() hands executors the record so they compare
//      the price they are about to sign with the one the user confirmed.
//   9. ACROSS TABS (ATK-11): localStorage reaches other processes late, so confirm()
//      and acquire() also ask every live registry of the same account in THIS JS realm
//      (a record this page knows, which a live page says is in flight, is in flight),
//      and acquire() — awaited by every executor before its first window — takes the
//      browser's exclusive Web Lock for the account (navigator.locks, when present)
//      and re-reads the registry under it. Two tabs whose confirms raced can then never
//      both open a window: whoever is second finds the lock held or the other flow.
//  10. Only the page that made a card may call it nothing (cancel is owner-only, ATK-10a;
//      a dead page's stale review expires by TTL); beforeWindow only ever writes
//      "sending" (it can never walk a flow back to review, ATK-10b).
//
// States
//   review            card shown, nothing signed                      (no lock)
//   confirmed         Confirm pressed; windows about to open           (locks)
//   sending           a money window is open or was just answered      (locks)
//   arriving          sent; waiting for the status / receipt / balance (locks)
//   unknown           may have moved; watched, never retried           (locks)
//   done | refunded | cancelled | error-before-money | expired          settled

export const FLOWS_KEY_PREFIX = "flowflow.flows.v1:";
export const FLOWS_VERSION = 1;
export const FLOW_KINDS = Object.freeze(["stake", "unstake", "move-in", "move-out", "swap", "gas-topup", "remove-allowance"]);
export const TERMINAL_STATES = Object.freeze(["done", "refunded", "cancelled", "error-before-money", "expired"]);
export const IN_FLIGHT_STATES = Object.freeze(["confirmed", "sending", "arriving", "unknown"]);
export const ALL_STATES = Object.freeze(["review", ...IN_FLIGHT_STATES, ...TERMINAL_STATES]);
/** A review card older than this asks again (plan §2.9 MONEY_CARD_TTL_MS). */
export const MONEY_CARD_TTL_MS = 600_000;
/** Settled records kept per account (newest first); unsettled ones are never dropped. */
export const FLOWS_KEEP_SETTLED = 20;
/** The `why` of an "unknown" the load rule wrote (as opposed to an outcome nobody could read). */
export const LOADED_ELSEWHERE = "loaded-elsewhere";
/** An unknown that never wrote a money-window id may be called "nothing moved" after this long idle (settleNothingMoved). */
export const UNREACHED_IDLE_MS = 15 * 60_000;
/**
 * THE EXIT IS NEVER WALLED IN (plan §3.3). An "unknown" record idle this long no longer
 * blocks an EXIT (move out, unstake, swap X → USDC): every window of it has closed (each
 * executor writes before its window, and a permit lives ≤ 12 min), and an exit only moves
 * what the Spot Account holds NOW back to the user's own accounts — it can never send the
 * unknown move again. Entries stay blocked until the record settles with evidence.
 */
export const EXIT_PAST_UNKNOWN_MS = UNREACHED_IDLE_MS;

/**
 * Does this record's money step go out as the user's OWN Avalanche transaction (so its
 * nonce says whether it was sent)? Stake, unstake, a swap, an allowance removal, the paid
 * exit — never a permit exit (Relay's solver submits it) or a move from the Main Account.
 */
export function ownTxRecord(rec) {
  if (!rec || typeof rec !== "object" || rec.hlNonce != null) return false;
  if (["stake", "unstake", "swap", "remove-allowance"].includes(rec.kind)) return true;
  return rec.kind === "move-out" && !rec.permitNonce && rec.step != null;
}

/** Is this record a way OUT (plan §2.9: move out, unstake, swap X → USDC)? */
export function isExitRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (rec.kind === "move-out" || rec.kind === "unstake") return true;
  const a = rec.amounts && typeof rec.amounts === "object" ? rec.amounts : null;
  return rec.kind === "swap" && !!a && a.to === "USDC" && typeof a.from === "string" && a.from !== "USDC";
}

/** The fields a record may carry (plan §3.7) — and nothing else. */
const RECORD_KEYS = Object.freeze([
  "id", "kind", "state", "resumeFrom", "startedAt", "updatedAt", "tabId", "auto", "envelopeHash",
  "amounts", "maxDebit", "requestId", "hlNonce", "txHash", "txNonce", "permitNonce", "validBefore", "orderDeadline",
  "step", "steps", "approveTx", "swapTx", "sentAt", "why", "evidence", "allowanceLeft", "stages",
]);
/** Fixed once the card is made: what the user confirmed and who runs it. No patch may touch them. */
export const FIXED_KEYS = Object.freeze([
  "id", "kind", "startedAt", "updatedAt", "tabId", "auto", "envelopeHash", "amounts", "maxDebit", "stages", "resumeFrom", "evidence",
]);
/** A stage name an executor claims (one run each, ever). */
const STAGE_RE = /^[a-z][a-z0-9-]{0,23}$/;
const BUSY_WORDS = "Another move is still running.";
const UNKNOWN_WORDS = "A move isn't confirmed yet. It has to settle before another one starts.";
const STEP_KEYS = Object.freeze(["kind", "state", "txHash", "requestId"]);

export class FlowRegistryError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "FlowRegistryError";
    this.code = code;
    this.detail = detail;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_INSIDE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const lower = (a) => String(a == null ? "" : a).toLowerCase();

/** The storage key for an account, or null when `own` is not an address. */
export function flowsKey(own) {
  return typeof own === "string" && ADDRESS_RE.test(own) && lower(own) !== "0x0000000000000000000000000000000000000000"
    ? `${FLOWS_KEY_PREFIX}${lower(own)}` : null;
}

export const isTerminal = (state) => TERMINAL_STATES.includes(state);
export const isInFlight = (state) => IN_FLIGHT_STATES.includes(state);

/** The stages already claimed on a record, in order. */
export const stagesOf = (rec) => (rec && typeof rec.stages === "string" && rec.stages ? rec.stages.split(",") : []);

/* A patch may carry window ids and progress, never what the user confirmed. */
function checkPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new FlowRegistryError("bad-record", "Not a flow update.");
  for (const k of Object.keys(patch)) {
    if (FIXED_KEYS.includes(k)) throw new FlowRegistryError("bad-record", `A move's ${k} is fixed once its card is made.`, { key: k });
  }
}

/* ── live registries in THIS JS realm (ATK-11) ─────────────────────────────
   localStorage reaches other processes late; registries living in the same realm
   (two panels, a StrictMode double mount, tests' "tabs") can tell each other at once.
   Held weakly: a registry the page dropped is forgotten. */
const PEERS = new Map();
const weak = (o) => (typeof WeakRef === "function" ? new WeakRef(o) : { deref: () => o });
function addPeer(key, peer) {
  if (!key) return;
  if (!PEERS.has(key)) PEERS.set(key, new Set());
  PEERS.get(key).add(weak(peer));
}
function livePeers(key, self) {
  const set = PEERS.get(key);
  if (!set) return [];
  const out = [];
  for (const ref of set) {
    const p = ref.deref();
    if (!p) { set.delete(ref); continue; }
    if (p !== self) out.push(p);
  }
  return out;
}

/* Ask the browser for the account's exclusive lock without waiting. Resolves a release
   function, or null when another tab holds it (or the API refuses). */
function requestLock(locks, name) {
  return new Promise((resolve) => {
    let free = null;
    const held = new Promise((r) => { free = r; });
    try {
      const p = locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(null); return null; }
        resolve(() => free());
        return held;
      });
      if (p && typeof p.catch === "function") p.catch(() => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/* A scalar a record may hold: string / finite number / boolean / null. Never an address. */
function scalarOk(v) {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length <= 200 && !(v.length === 42 && ADDRESS_RE.test(v)) && !ADDRESS_INSIDE.test(v.replace(/0x[0-9a-fA-F]{64}/g, ""));
  return false;
}

/**
 * A record as it may be stored: known keys only, scalars only (amounts and
 * steps one level deep), no address anywhere. Throws FlowRegistryError
 * "bad-record" otherwise — a record that cannot be stored safely is not stored.
 */
export function sanitizeRecord(rec) {
  if (!rec || typeof rec !== "object") throw new FlowRegistryError("bad-record", "Not a flow record.");
  const out = {};
  for (const k of Object.keys(rec)) {
    if (!RECORD_KEYS.includes(k)) throw new FlowRegistryError("bad-record", `A flow record may not carry "${k}".`, { key: k });
    const v = rec[k];
    if (v === undefined) continue;
    if (k === "amounts") {
      if (v === null) { out.amounts = null; continue; }
      if (typeof v !== "object" || Array.isArray(v)) throw new FlowRegistryError("bad-record", "amounts must be a flat object.");
      const a = {};
      for (const [ak, av] of Object.entries(v)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(ak) || !scalarOk(av)) throw new FlowRegistryError("bad-record", `amounts.${ak} is not storable.`, { key: ak });
        a[ak] = av;
      }
      out.amounts = a;
      continue;
    }
    if (k === "steps") {
      if (!Array.isArray(v) || v.length > 8) throw new FlowRegistryError("bad-record", "steps must be a short list.");
      out.steps = v.map((s) => {
        if (!s || typeof s !== "object") throw new FlowRegistryError("bad-record", "A step must be an object.");
        const o = {};
        for (const [sk, sv] of Object.entries(s)) {
          if (!STEP_KEYS.includes(sk) || !scalarOk(sv)) throw new FlowRegistryError("bad-record", `A step may not carry "${sk}".`, { key: sk });
          o[sk] = sv;
        }
        return o;
      });
      continue;
    }
    if (!scalarOk(v)) throw new FlowRegistryError("bad-record", `${k} is not storable.`, { key: k });
    out[k] = v;
  }
  if (typeof out.id !== "string" || !/^[a-z0-9-]{6,64}$/.test(out.id)) throw new FlowRegistryError("bad-record", "A flow needs an id.");
  if (!FLOW_KINDS.includes(out.kind)) throw new FlowRegistryError("bad-record", "Not a kind of flow this app runs.", { kind: out.kind ?? null });
  if (!ALL_STATES.includes(out.state)) throw new FlowRegistryError("bad-record", "Not a state a flow can be in.", { state: out.state ?? null });
  return out;
}

/* ── raw storage: read / write the whole list for one account ───────────── */

/**
 * The records stored for this account, exactly as stored (no load mapping).
 * { ok: true, flows } or { ok: false, code } — an unreadable store is NOT an
 * empty one, so callers treat it as "can't start".
 */
export function readFlows(storage, own) {
  const key = flowsKey(own);
  if (!key) return { ok: false, code: "bad-user", flows: [] };
  if (!storage || typeof storage.getItem !== "function") return { ok: false, code: "storage", flows: [] };
  let raw;
  try { raw = storage.getItem(key); } catch { return { ok: false, code: "storage", flows: [] }; }
  if (raw == null || raw === "") return { ok: true, flows: [] };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: "corrupt", flows: [] }; }
  if (!parsed || parsed.v !== FLOWS_VERSION || !Array.isArray(parsed.flows)) return { ok: false, code: "corrupt", flows: [] };
  const flows = [];
  for (const r of parsed.flows) {
    try { flows.push(sanitizeRecord(r)); } catch { return { ok: false, code: "corrupt", flows: [] }; }
  }
  return { ok: true, flows };
}

/* Settled records beyond the keep window are dropped; unsettled ones never are. */
function prune(flows) {
  const open = flows.filter((f) => !isTerminal(f.state));
  const settled = flows.filter((f) => isTerminal(f.state)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, FLOWS_KEEP_SETTLED);
  return [...open, ...settled].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

/** Write the whole list and read it back. Throws FlowRegistryError "storage" if it did not stick. */
export function writeFlows(storage, own, flows) {
  const key = flowsKey(own);
  if (!key) throw new FlowRegistryError("bad-user", "No account to record the move for.");
  const clean = prune(flows.map(sanitizeRecord));
  const text = JSON.stringify({ v: FLOWS_VERSION, flows: clean });
  try {
    storage.setItem(key, text);
  } catch (e) {
    throw new FlowRegistryError("storage", "This browser couldn't record the move.", { cause: String((e && e.message) || e) });
  }
  let back = null;
  try { back = storage.getItem(key); } catch { back = null; }
  if (back !== text) throw new FlowRegistryError("storage", "This browser couldn't record the move.");
  return clean;
}

/**
 * THE LOAD RULE. Every record that is not settled and not "review" becomes
 * "unknown" (keeping resumeFrom); a "review" past the TTL becomes "expired". The
 * mapping is persisted. Returns { ok, flows, changed }.
 */
export function loadFlows(storage, own, { now = Date.now() } = {}) {
  const r = readFlows(storage, own);
  if (!r.ok) return { ok: false, code: r.code, flows: [], changed: 0 };
  let changed = 0;
  const flows = r.flows.map((f) => {
    if (f.state === "review") {
      if (!(now - (f.startedAt || 0) < MONEY_CARD_TTL_MS)) { changed += 1; return { ...f, state: "expired", updatedAt: now }; }
      return f;
    }
    if (isTerminal(f.state) || f.state === "unknown") return f;
    changed += 1;
    /* tabId is KEPT: if the page that started it is still alive (another tab), it alone
       may carry on; a reloaded page has a new tabId and never can. */
    return { ...f, state: "unknown", resumeFrom: f.state, why: LOADED_ELSEWHERE, updatedAt: now };
  });
  if (changed) {
    try { writeFlows(storage, own, flows); } catch { return { ok: false, code: "storage", flows, changed }; }
  }
  return { ok: true, flows, changed };
}

/* ── what a card may show ─────────────────────────────────────────────────── */

/**
 * What a money card / panel row may offer for this record, in THIS page:
 *   confirmable  Confirm may be shown (review, made by this page, inside the TTL)
 *   askAgain     the card is stale or from another page load: "Ask again"
 *   watching     money may be moving: progress / "Not confirmed. Don't send it again."
 *   settled      a final state
 * Nothing else ever shows Confirm.
 */
export function flowView(rec, { tabId, now = Date.now() } = {}) {
  if (!rec) return { confirmable: false, askAgain: false, watching: false, settled: false };
  const fresh = now - (rec.startedAt || 0) < MONEY_CARD_TTL_MS;
  if (rec.state === "review") {
    const mine = !!tabId && rec.tabId === tabId;
    return { confirmable: mine && fresh, askAgain: !(mine && fresh), watching: false, settled: false };
  }
  if (isInFlight(rec.state)) return { confirmable: false, askAgain: false, watching: true, settled: false, unknown: rec.state === "unknown" };
  return { confirmable: false, askAgain: rec.state === "expired", watching: false, settled: true };
}

/** How long to wait before the next status read (plan §3.7): 4 s for 2 min, 15 s to 15 min, then 60 s. */
export function pollDelayMs(rec, now = Date.now()) {
  const since = now - ((rec && (rec.sentAt || rec.startedAt)) || now);
  if (since < 120_000) return 4_000;
  if (since < 900_000) return 15_000;
  return 60_000;
}

/* ── the registry for one account in one page ─────────────────────────────── */

let tabCounter = 0;
/** A page-instance id (new on every load; never persisted to sessionStorage on purpose). */
export function newTabId(random = Math.random) {
  tabCounter += 1;
  return `t${Date.now().toString(36)}${Math.floor(random() * 1e9).toString(36)}${tabCounter}`;
}

/**
 * @param {{ storage: Storage, own: string, now?: () => number, tabId?: string, random?: () => number,
 *   locks?: { request: Function }|null }} o
 *   locks: the Web Locks API (default navigator.locks when the page has it; null = none).
 */
export function createFlowRegistry({
  storage, own, now = Date.now, tabId = null, random = Math.random,
  locks = (typeof globalThis !== "undefined" && globalThis.navigator && globalThis.navigator.locks) || null,
} = {}) {
  const key = flowsKey(own);
  const me = tabId || newTabId(random);
  const load = loadFlows(storage, own, { now: now() });
  let broken = !key || !load.ok;
  /* What THIS registry last wrote for each flow (other registries in the realm read it). */
  const local = new Map();
  const peer = { tabId: me, local };
  addPeer(key, peer);

  /* A probe write, so "can't record" is known BEFORE a card offers Confirm. */
  if (!broken) {
    const probe = `${FLOWS_KEY_PREFIX}probe`;
    try {
      storage.setItem(probe, me);
      if (storage.getItem(probe) !== me) broken = true;
      storage.removeItem(probe);
    } catch { broken = true; }
  }

  const read = () => {
    const r = readFlows(storage, own);
    if (!r.ok) { broken = true; throw new FlowRegistryError("storage", "This browser couldn't read the moves in progress."); }
    return r.flows;
  };
  const mutate = (id, fn) => {
    const flows = read();
    const i = flows.findIndex((f) => f.id === id);
    if (i < 0) throw new FlowRegistryError("not-found", "That move is not recorded here.", { id });
    const next = fn(flows[i], flows);
    if (next === flows[i]) return flows[i];
    flows[i] = { ...next, updatedAt: now() };
    writeFlows(storage, own, flows);
    local.set(id, flows[i].state);
    return flows[i];
  };

  /* A flow this page's storage knows (and does not see settled) that a live registry in
     this realm says is in flight — the copy here may simply be late. */
  const peerInFlight = (flows, exceptId = null) => {
    const mine = new Map(flows.map((f) => [f.id, f.state]));
    for (const p of livePeers(key, peer)) {
      for (const [fid, st] of p.local) {
        if (fid === exceptId || !mine.has(fid) || isTerminal(mine.get(fid))) continue;
        if (isInFlight(st)) return { id: fid, state: st };
      }
    }
    return null;
  };
  /* An unknown record that blocks THIS start: every one for an entry; for an exit only one
     that may still have a window open (idle < EXIT_PAST_UNKNOWN_MS). */
  const unknownBlocks = (f, exit) => f.state === "unknown" && !(exit && now() - (f.updatedAt || f.startedAt || 0) >= EXIT_PAST_UNKNOWN_MS);
  const blockerOf = (flows, exceptId, { exit = false } = {}) => {
    if (flows.some((f) => f.id !== exceptId && unknownBlocks(f, exit))) return { code: "unknown", message: UNKNOWN_WORDS };
    if (flows.some((f) => f.id !== exceptId && isInFlight(f.state) && f.state !== "unknown")) return { code: "busy", message: BUSY_WORDS };
    const p = peerInFlight(flows, exceptId);
    if (p) {
      if (p.state !== "unknown") return { code: "busy", message: BUSY_WORDS };
      const rec = flows.find((f) => f.id === p.id);
      if (!rec || unknownBlocks({ ...rec, state: "unknown" }, exit)) return { code: "unknown", message: UNKNOWN_WORDS };
    }
    return null;
  };

  const api = {
    tabId: me,
    own: key ? lower(own) : null,
    loaded: load,

    /** Can this browser record money moves at all? */
    available: () => !broken,

    /** Every record, oldest first (fresh from storage). */
    list: () => { try { return read(); } catch { return []; } },
    get: (id) => api.list().find((f) => f.id === id) || null,
    view: (rec) => flowView(rec, { tabId: me, now: now() }),

    /** Records money may be moving in (what the status watcher polls). */
    inFlight: () => api.list().filter((f) => isInFlight(f.state)),

    /**
     * May a NEW money flow start? { ok: true } or { ok: false, code, message }.
     * "busy": another flow is confirmed / sending / arriving (any tab);
     * "unknown": a flow is unknown — it must be resolved first; "storage": can't record.
     * `exit`: the new flow is a way out (isExitRecord) — an unknown record idle past
     * EXIT_PAST_UNKNOWN_MS does not hold it (plan §3.3: the exit is never walled in).
     */
    canStart: ({ exit = false } = {}) => {
      if (broken) return { ok: false, code: "storage", message: "This browser can't keep track of a money move, so none can start here." };
      let flows;
      try { flows = read(); } catch { return { ok: false, code: "storage", message: "This browser can't keep track of a money move, so none can start here." }; }
      const b = blockerOf(flows, null, { exit: !!exit });
      if (b) return { ok: false, ...b };
      return { ok: true, code: null, message: null };
    },

    /**
     * A new card: a record in "review". Written before the card can show Confirm;
     * throws FlowRegistryError when it cannot be (then the card shows no Confirm).
     */
    begin: ({ kind, amounts = null, maxDebit = null, envelopeHash = null, auto = false, steps = null } = {}) => {
      if (broken) throw new FlowRegistryError("storage", "This browser can't keep track of a money move, so none can start here.");
      const t = now();
      const rec = sanitizeRecord({
        id: `f${t.toString(36)}${Math.floor(random() * 1e9).toString(36)}`.slice(0, 40).toLowerCase(),
        kind, state: "review", startedAt: t, updatedAt: t, tabId: me, auto: !!auto,
        envelopeHash, amounts, maxDebit, steps: steps || undefined,
      });
      const flows = read();
      flows.push(rec);
      writeFlows(storage, own, flows);
      local.set(rec.id, rec.state);
      return rec;
    },

    /**
     * THE CONFIRM GATE (synchronous). review → confirmed, only for a card this page
     * made, inside the TTL, when nothing else is in flight. Written and read back.
     * { ok: true, record } or { ok: false, code, message } — a second tap gets "already".
     */
    confirm: (id) => {
      try {
        let refusal = null;
        const rec = mutate(id, (f, flows) => {
          if (f.state !== "review") { refusal = { code: "already", message: "This card was already confirmed." }; return f; }
          const v = flowView(f, { tabId: me, now: now() });
          if (!v.confirmable) { refusal = { code: "ask-again", message: "This price is out of date. Ask again." }; return f; }
          const b = blockerOf(flows, f.id, { exit: isExitRecord(f) });
          if (b) { refusal = b; return f; }
          return { ...f, state: "confirmed" };
        });
        return refusal ? { ok: false, ...refusal } : { ok: true, record: rec };
      } catch (e) {
        return { ok: false, code: e.code || "storage", message: "This browser couldn't record the move, so nothing was sent." };
      }
    },

    /**
     * WRITE BEFORE THE WINDOW. Patches the state ("sending") and the ids of the window
     * about to open (requestId, hlNonce, txNonce, permitNonce, validBefore, step…), and
     * proves the write stuck. THROWS when it did not — the executor then never opens it.
     * Only the page that confirmed the flow may open its windows.
     */
    beforeWindow: (id, patch = {}) => {
      if (broken) throw new FlowRegistryError("storage", "This browser couldn't record the move.");
      checkPatch(patch);
      /* A window only ever makes a flow "sending": never back to review, never settled (ATK-10b). */
      if (patch.state != null && patch.state !== "sending") throw new FlowRegistryError("bad-state", "A window can only mark a move as sending.");
      const rec = mutate(id, (f) => {
        if (f.tabId !== me) throw new FlowRegistryError("not-owner", "This move is running in another tab.");
        /* "unknown" here can only be another tab's load rule landing on a flow THIS live page
           is running; the owner may carry on. A reloaded page is never the owner. */
        const resumable = f.state === "unknown" && f.why === LOADED_ELSEWHERE;
        if (!["confirmed", "sending", "arriving"].includes(f.state) && !resumable) throw new FlowRegistryError("bad-state", `A ${f.state} move cannot open a window.`);
        return sanitizeRecord({ ...f, ...patch, state: "sending", why: resumable ? null : f.why });
      });
      const back = api.get(id);
      if (!back || back.state !== rec.state || back.updatedAt !== rec.updatedAt) throw new FlowRegistryError("storage", "This browser couldn't record the move.");
      return rec;
    },

    /**
     * ONE RUN PER STAGE. An executor claims its stage synchronously, before its first
     * await; the claim is written and READ BACK. Throws FlowRegistryError:
     *   "already-run"  this stage was claimed before (a second run of the same move);
     *   "not-owner"    another page confirmed it; "bad-state" not confirmed / settled;
     *   "storage"      the claim did not stick.
     */
    claim: (id, stage) => {
      if (broken) throw new FlowRegistryError("storage", "This browser couldn't record the move.");
      if (typeof stage !== "string" || !STAGE_RE.test(stage)) throw new FlowRegistryError("bad-stage", "Not a step this app runs.");
      const rec = mutate(id, (f) => {
        if (f.tabId !== me) throw new FlowRegistryError("not-owner", "This move is running in another tab.");
        const resumable = f.state === "unknown" && f.why === LOADED_ELSEWHERE;
        if (!["confirmed", "sending", "arriving"].includes(f.state) && !resumable) throw new FlowRegistryError("bad-state", `A ${f.state} move cannot run.`);
        const done = stagesOf(f);
        if (done.includes(stage)) throw new FlowRegistryError("already-run", "This step already ran. It is never sent twice.", { stage });
        return sanitizeRecord({ ...f, stages: [...done, stage].join(",") });
      });
      const back = api.get(id);
      if (!back || !stagesOf(back).includes(stage) || back.updatedAt !== rec.updatedAt) throw new FlowRegistryError("storage", "This browser couldn't record the move.");
      return rec;
    },

    /**
     * Before the FIRST window of a run: the account's exclusive browser lock (when the
     * page has Web Locks), then — under it — a fresh read: no other flow may be in flight
     * or unknown, in storage or in a live registry of this realm. Resolves
     * { ok: true, release } (call release when the run ends) or { ok: false, code, message }.
     */
    acquire: async (id) => {
      let release = () => {};
      if (locks && typeof locks.request === "function") {
        const r = await requestLock(locks, `${FLOWS_KEY_PREFIX}lock:${key || "none"}`);
        if (!r) return { ok: false, code: "busy", message: BUSY_WORDS };
        release = r;
      }
      let flows;
      try { flows = read(); } catch { release(); return { ok: false, code: "storage", message: "This browser couldn't record the move." }; }
      const self = flows.find((f) => f.id === id);
      if (!self || self.tabId !== me) { release(); return { ok: false, code: "not-owner", message: "This move is running in another tab." }; }
      const b = blockerOf(flows, id, { exit: isExitRecord(self) });
      if (b) { release(); return { ok: false, ...b }; }
      let done = false;
      return { ok: true, code: null, message: null, release: () => { if (!done) { done = true; release(); } } };
    },

    /**
     * Is the account's browser lock free right now — no run in any tab of this browser
     * holds it, so no window of any run is open? true / false, or null when the page has
     * no Web Locks. Taken and released at once; the watcher asks it before a time-based
     * "nothing moved" proof.
     */
    lockFree: async () => {
      if (!locks || typeof locks.request !== "function") return null;
      const r = await requestLock(locks, `${FLOWS_KEY_PREFIX}lock:${key || "none"}`);
      if (!r) return false;
      try { r(); } catch { /* released */ }
      return true;
    },

    /** After a window: hashes, "arriving", step progress. The owner page only; never back to review. */
    update: (id, patch = {}) => mutate(id, (f) => {
      checkPatch(patch);
      if (f.tabId !== me) throw new FlowRegistryError("not-owner", "This move is running in another tab.");
      if (patch.state && !["sending", "arriving", "unknown"].includes(patch.state)) throw new FlowRegistryError("bad-state", "Use finish() to settle a move.");
      if (isTerminal(f.state)) return f;
      const resumed = f.state === "unknown" && f.why === LOADED_ELSEWHERE;
      if (f.state === "unknown" && !resumed && patch.state && patch.state !== "unknown") throw new FlowRegistryError("bad-state", "An unconfirmed move settles only with evidence.");
      return sanitizeRecord({ ...f, ...patch, state: patch.state || (resumed ? f.resumeFrom || "sending" : f.state), why: resumed ? null : f.why });
    }),

    /** Money may have moved and nobody can say: watched, never retried. */
    markUnknown: (id, why = null) => mutate(id, (f) => (isTerminal(f.state) ? f : { ...f, state: "unknown", resumeFrom: f.state === "unknown" ? f.resumeFrom : f.state, why })),

    /**
     * Nothing moved: cancelled (the user said no, the price expired) or
     * error-before-money. Refused for a record that may already have moved
     * (arriving / unknown) — those settle only with evidence (finish).
     */
    cancel: (id, why = null, state = "cancelled") => mutate(id, (f) => {
      if (isTerminal(f.state)) return f;
      /* The live owner page knows nothing moved even if another tab's load rule wrote "unknown". */
      const ownerResumable = f.tabId === me && f.state === "unknown" && f.why === LOADED_ELSEWHERE && (f.resumeFrom === "confirmed" || f.resumeFrom === "sending");
      if ((f.state === "arriving" || f.state === "unknown") && !ownerResumable) throw new FlowRegistryError("bad-state", "A move that may have left can only settle with evidence.");
      /* Only the page that made the card may call it nothing (ATK-10a): another tab
         dropping a confirmed / sending move would release the lock under an open window,
         and another tab's copy of a "review" may simply be late (it may be sending). Stale
         reviews from dead pages settle through the TTL (expireStale / the load rule). */
      if (f.tabId !== me) throw new FlowRegistryError("not-owner", "This move is running in another tab.");
      if (state !== "cancelled" && state !== "error-before-money" && state !== "expired") throw new FlowRegistryError("bad-state", "Not a way to cancel.");
      return { ...f, state, why };
    }),

    /**
     * Settle with EVIDENCE (a status read, a receipt, a balance delta) — the only way
     * out of "arriving" or "unknown". Evidence is a short plain string.
     */
    finish: (id, state, evidence) => mutate(id, (f) => {
      if (!["done", "refunded", "error-before-money"].includes(state)) throw new FlowRegistryError("bad-state", "Not a way to settle a move.");
      if (typeof evidence !== "string" || !evidence.trim()) throw new FlowRegistryError("no-evidence", "A move settles only with evidence.");
      if (isTerminal(f.state)) return f;
      if (state === "error-before-money" && (f.state === "arriving" || f.state === "unknown")) throw new FlowRegistryError("bad-state", "A move that may have left cannot be called nothing.");
      return sanitizeRecord({ ...f, state, evidence: evidence.slice(0, 200) });
    }),

    /**
     * NOTHING MOVED, PROVEN — the only way an "unknown" (or "arriving") record may become
     * "error-before-money"; finish() refuses that on purpose. Without it a run that died
     * before its money window would stay unknown for ever and block every new move on the
     * account. `proof.kind` must be one of these, each checked HERE against the record:
     *   "unreached"      no money-window id was ever written (requestId, hlNonce, txHash,
     *                    txNonce, permitNonce, step) and the record has been idle for
     *                    UNREACHED_IDLE_MS. Every executor writes those ids BEFORE its money
     *                    window and refuses a quote older than 60 s, so such a run can no
     *                    longer open one anywhere.
     *   "permit-unused"  a permit exit whose validBefore has passed, and USDC's
     *                    authorizationState read AFTER it says the nonce was never used
     *                    (proof.used === false, proof.readAtS > validBefore): it can never execute.
     *   "reverted"       the record's own txHash has a receipt with status 0 AND that hash is
     *                    the ONE tx sent at the nonce written before its window (proof.hashNonce
     *                    === txNonce, proof.latestNonce ≤ txNonce + 1): Privy's in-window "Retry
     *                    transaction" can send a second tx and hand back only the last hash, so a
     *                    reverted retry says nothing about the first (F9).
     *   "approve-only"   the run stopped at its approve (step "approve") and that tx's receipt
     *                    says status 1: an allowance was set, no money moved.
     *   "stopped-at-approve"  the same with no receipt to read (the hash was never written — a
     *                    page closed on Privy's success screen): step "approve" means the money
     *                    window never opened (every executor writes its money step BEFORE that
     *                    window), idle UNREACHED_IDLE_MS. The allowance may be left.
     *   "nonce-unused"   a run whose money tx is the user's OWN Avalanche tx (stake, unstake, swap,
     *                    the paid exit — never a permit or a HyperCore move): idle
     *                    UNREACHED_IDLE_MS, then the latest AND the pending nonce, read after that,
     *                    both equal the nonce written before the window — nothing was mined or is
     *                    waiting at it, so that window sent nothing.
     *   "hl-not-sent"    a move from the Main Account (move-in / gas top-up) whose sendAsset id was
     *                    written: idle UNREACHED_IDLE_MS, then the Main Account's ledger, read
     *                    after that from before the card, holds no transfer to the depository for
     *                    it (proof.sends === 0) — the HyperCore window sent nothing.
     * Anything else throws (never settles on a guess). Evidence is written with it. The time-based
     * proofs are only offered by the watcher while no tab of this browser holds the account's
     * lock (lockFree), so no live page can still have a window open on them.
     */
    settleNothingMoved: (id, proof = {}) => mutate(id, (f) => {
      if (isTerminal(f.state)) return f;
      if (f.state !== "unknown" && f.state !== "arriving") throw new FlowRegistryError("bad-state", "Only a move nobody could confirm settles this way.");
      const p = proof && typeof proof === "object" ? proof : {};
      const t = now();
      let evidence = null;
      if (p.kind === "unreached") {
        const ids = ["requestId", "hlNonce", "txHash", "txNonce", "permitNonce", "step"].filter((k) => f[k] != null);
        if (ids.length || f.state !== "unknown") throw new FlowRegistryError("bad-state", "This move reached a money window.");
        if (!(t - (f.updatedAt || f.startedAt || t) >= UNREACHED_IDLE_MS)) throw new FlowRegistryError("bad-state", "This move may still be running in another tab.");
        evidence = "never reached a money window; nothing was sent";
      } else if (p.kind === "permit-unused") {
        const vb = Number(f.validBefore);
        if (!f.permitNonce || !Number.isFinite(vb)) throw new FlowRegistryError("bad-state", "This move has no permit to check.");
        if (!(Math.floor(t / 1000) > vb) || !(Number(p.readAtS) > vb) || p.used !== false) throw new FlowRegistryError("no-evidence", "The permit may still be used.");
        evidence = "permit expired unused (authorizationState false after validBefore)";
      } else if (p.kind === "reverted" || p.kind === "approve-only") {
        if (typeof f.txHash !== "string" || !f.txHash || String(p.txHash || "").toLowerCase() !== f.txHash.toLowerCase()) throw new FlowRegistryError("no-evidence", "That receipt is not this move's.");
        if (p.kind === "reverted" && Number(p.status) !== 0) throw new FlowRegistryError("no-evidence", "That transaction did not revert.");
        if (p.kind === "reverted") {
          /* 🔴 The reverted hash must be the ONE tx at the nonce written before its window. */
          const n = f.txNonce;
          if (!Number.isSafeInteger(n) || Number(p.hashNonce) !== n || !(Number(p.latestNonce) <= n + 1)) {
            throw new FlowRegistryError("no-evidence", "That receipt may not be the only transaction this move sent.");
          }
        }
        if (p.kind === "approve-only" && (f.step !== "approve" || Number(p.status) !== 1)) throw new FlowRegistryError("no-evidence", "That run went past its allowance.");
        evidence = p.kind === "reverted" ? `receipt status 0 ${f.txHash}` : `allowance only, receipt status 1 ${f.txHash}`;
      } else if (p.kind === "stopped-at-approve" || p.kind === "nonce-unused") {
        if (!ownTxRecord(f)) throw new FlowRegistryError("bad-state", "This move does not end in a transaction from your wallet.");
        if (f.state !== "unknown") throw new FlowRegistryError("bad-state", "Only a move nobody could confirm settles this way.");
        const since = f.updatedAt || f.startedAt || t;
        if (!(t - since >= UNREACHED_IDLE_MS)) throw new FlowRegistryError("bad-state", "This move may still be running in another tab.");
        if (p.kind === "stopped-at-approve") {
          if (f.step !== "approve") throw new FlowRegistryError("no-evidence", "That run went past its allowance.");
          evidence = "stopped at its allowance; no money window opened";
        } else {
          const n = f.txNonce;
          if (!Number.isSafeInteger(n) || Number(p.latestNonce) !== n || Number(p.pendingNonce) !== n) throw new FlowRegistryError("no-evidence", "A transaction may have been sent at this move's nonce.");
          if (!(Number(p.readAt) >= since + UNREACHED_IDLE_MS)) throw new FlowRegistryError("no-evidence", "The nonce was read too early to prove anything.");
          evidence = `nonce ${n} never used (latest = pending = ${n}); nothing was sent`;
        }
      } else if (p.kind === "hl-not-sent") {
        if (!(f.kind === "move-in" || f.kind === "gas-topup") || f.hlNonce == null || f.txHash != null) throw new FlowRegistryError("bad-state", "This move has no Main Account transfer to check.");
        if (f.state !== "unknown") throw new FlowRegistryError("bad-state", "Only a move nobody could confirm settles this way.");
        const since = f.updatedAt || f.startedAt || t;
        if (!(t - since >= UNREACHED_IDLE_MS)) throw new FlowRegistryError("bad-state", "This move may still be running in another tab.");
        if (p.sends !== 0 || !(Number(p.readAt) >= since + UNREACHED_IDLE_MS) || !(Number(p.fromMs) <= (f.startedAt || 0))) {
          throw new FlowRegistryError("no-evidence", "The Main Account may have sent it.");
        }
        evidence = "no transfer out of the Main Account for this move (ledger read); nothing was sent";
      } else {
        throw new FlowRegistryError("no-evidence", "A move settles only with evidence.");
      }
      return sanitizeRecord({ ...f, state: "error-before-money", evidence: evidence.slice(0, 200), allowanceLeft: p.kind === "approve-only" || p.kind === "stopped-at-approve" ? true : f.allowanceLeft });
    }),

    /** Stale review cards (TTL) become expired. Returns how many. */
    expireStale: () => {
      let n = 0;
      try {
        const flows = read();
        const t = now();
        const next = flows.map((f) => (f.state === "review" && !(t - (f.startedAt || 0) < MONEY_CARD_TTL_MS) ? (n += 1, { ...f, state: "expired", updatedAt: t }) : f));
        if (n) writeFlows(storage, own, next);
      } catch { /* nothing to expire on an unreadable store */ }
      return n;
    },

    /**
     * The handle an executor takes for ONE flow (ownMove / moveOut / swap), bound to the id:
     *   claim(stage)   one run per stage, synchronous (call it before the first await);
     *   get()          the record as stored — what the user confirmed (amounts, maxDebit);
     *   acquire()      the cross-tab lock + fresh check before the first window;
     *   beforeWindow   throws when not persisted — and until a stage was claimed HERE;
     *   update / unknown / cancel.
     */
    handle: (id) => {
      let claimed = false;
      return Object.freeze({
        id,
        get: () => api.get(id),
        claim: (stage) => { const r = api.claim(id, stage); claimed = true; return r; },
        acquire: () => api.acquire(id),
        beforeWindow: (patch) => {
          if (!claimed) throw new FlowRegistryError("not-claimed", "This move's step was not started properly, so nothing was sent.");
          return api.beforeWindow(id, patch);
        },
        update: (patch) => api.update(id, patch),
        unknown: (why) => api.markUnknown(id, why),
        cancel: (why, state) => api.cancel(id, why, state || "cancelled"),
      });
    },
  };
  return api;
}

/**
 * Cross-tab: call `cb(flows)` whenever another tab changes this account's
 * registry (the `storage` event). Returns the remover. Same-tab writes do not
 * fire it; the registry's own calls already return the new state.
 */
export function subscribeFlows(target, storage, own, cb) {
  const key = flowsKey(own);
  if (!key || !target || typeof target.addEventListener !== "function") return () => {};
  const on = (e) => {
    if (!e || e.key !== key) return;
    const r = readFlows(storage, own);
    cb(r.ok ? r.flows : null);
  };
  target.addEventListener("storage", on);
  return () => target.removeEventListener("storage", on);
}
