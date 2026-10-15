// ─────────────────────────────────────────────────────────────────────────────
// THE PRIVATE-WITHDRAW JOURNAL: one record per one-time deposit address,
// written and read back BEFORE the wallet is asked to sign.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน". Plan §6 rules 5–6: a one-time
// address is used once, and a lost reply is "not confirmed" and is never sent
// again. The same idea as the Avax flow registry (src/avax/flows.js: "a reload
// can never resurrect a Confirm"), sized for one kind of move.
//
// HOW IT HOLDS
//   1. THE KEY IS THE DEPOSIT ADDRESS. A quote's address is bound to its amount
//      and is paid once. claim() refuses an address it has seen in ANY state,
//      so a double tap, a retry, a React double effect or a second tab can
//      never sign a second sendAsset for it. A new attempt is a new quote.
//   2. WRITTEN, THEN READ BACK. claim() stores the record with a random token
//      and reads it back; storage that did not keep it means the window never
//      opens (executeIntentsWithdraw returns nothingSent).
//   3. NOTHING NEW WHILE AN OUTCOME IS UNKNOWN. A record left "claimed" (the
//      page died while the wallet was open) or "unknown" (the reply was lost)
//      blocks the next private withdrawal until the status follow-up settles it
//      (withdrawStatus.js) or its address is past its deadline, so a customer
//      who thinks the first one failed cannot quietly send it twice.
//   4. THE DAY CAP COUNTS WHAT LEFT. Every record of the last 24 h except
//      "not-sent" and "expired" (nothing moved) counts toward the 1,000 USDC
//      day cap. A refund still counts: conservative, and the cap is about
//      exposure, not balance.
//   5. ONE KEY PER RECORD (prefix + wallet + address), so two records are never
//      one read-modify-write apart and a slow tab cannot drop another's record.
//
// WHAT IS STORED, and what is not: the deposit address (needed to follow the
// status after a reload), the route, the amount, the fee, the times, the state.
// NOT the recipient: only a keccak fingerprint of it, so the device does not
// keep a readable list of where private withdrawals went, while the status
// follow-up can still prove the service is paying the address that was typed.
//
// PURE: storage and clock are injected; nothing runs at import time.

import { keccak256, stringToHex } from "viem";

import { PRIVATE_WITHDRAW_DAY_CAP_USDC, PRIVATE_DAY_MS, PRIVATE_WITHDRAW_WORDS, unitsToDecimal, isEvmAddress } from "./withdraw.js";

export const PRIVATE_WITHDRAW_PREFIX = "flowflow.privateWithdraw.v1:";
export const JOURNAL_VERSION = 1;
/** Settled records kept per wallet (newest first); unsettled ones are never dropped. */
export const JOURNAL_KEEP = 50;

export const JOURNAL_STATES = Object.freeze([
  "claimed", "sent", "unknown", "not-sent", "arriving", "incomplete", "arrived", "refunded", "failed", "expired",
]);
/** The money step's outcome is not known: blocks the next withdrawal. */
export const UNSETTLED_STATES = Object.freeze(["claimed", "unknown"]);
/** Nothing left the Perp account. */
export const NOTHING_MOVED_STATES = Object.freeze(["not-sent", "expired"]);
/** Ends. An arrived/refunded/failed record never changes again; a nothing-moved one only on proof that money left. */
export const FINAL_STATES = Object.freeze(["not-sent", "expired", "arrived", "refunded", "failed"]);

/* Which state may follow which. Anything else is ignored (a late, stale answer
   cannot walk a record backwards). "not-sent" and "expired" are a reading of
   silence, so evidence that the money DID leave (a status past
   PENDING_DEPOSIT, a ledger send) still overrides them — the safe direction:
   the record then blocks and counts again. */
const LEFT_AFTER_ALL = ["sent", "arriving", "arrived", "incomplete", "refunded", "failed"];
const NEXT = Object.freeze({
  "not-sent": LEFT_AFTER_ALL,
  expired: LEFT_AFTER_ALL,
  claimed: ["sent", "unknown", "not-sent", "arriving", "arrived", "incomplete", "refunded", "failed"],
  unknown: ["sent", "not-sent", "arriving", "arrived", "incomplete", "refunded", "failed", "expired"],
  sent: ["arriving", "arrived", "incomplete", "refunded", "failed"],
  arriving: ["arrived", "incomplete", "refunded", "failed"],
  incomplete: ["refunded", "failed", "arrived"],
});

const DIGITS = /^[0-9]+$/;
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const lc = (a) => String(a).toLowerCase();

const UNSETTLED_WORDS = "A private withdrawal isn't confirmed yet. It has to settle before another one starts.";
const REGISTRY_WORDS = "This browser couldn't record the withdrawal, so nothing was sent.";

/** A fingerprint of a recipient: keccak of the address (EVM lowercased; others exactly as typed). */
export function recipientTag(recipient) {
  if (typeof recipient !== "string" || !recipient) return null;
  const norm = HEX40.test(recipient) ? recipient.toLowerCase() : recipient;
  return keccak256(stringToHex(norm));
}

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function randomToken() {
  try {
    const b = new Uint8Array(12);
    globalThis.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

/* A stored record, read defensively: anything malformed is ignored, never trusted. */
function readRecord(raw) {
  let r = null;
  try { r = JSON.parse(raw); } catch { return null; }
  if (!r || typeof r !== "object" || r.v !== JOURNAL_VERSION) return null;
  if (typeof r.id !== "string" || !HEX40.test(r.id)) return null;
  if (!JOURNAL_STATES.includes(r.state)) return null;
  if (typeof r.amountRaw !== "string" || !DIGITS.test(r.amountRaw)) return null;
  if (!Number.isFinite(r.createdAt)) return null;
  return r;
}

/**
 * The journal for one wallet.
 * @param {{ user: string, storage?: Storage|null, now?: () => number, dayCapUsdc?: number }} o
 *   storage: localStorage (default) or a fake with getItem/setItem/removeItem/key/length
 *   dayCapUsdc: the probe's maxDayUsdc when it is LOWER than the owner's 1,000 (never higher)
 */
export function createWithdrawJournal({ user, storage, now = () => Date.now(), dayCapUsdc: askedCap = PRIVATE_WITHDRAW_DAY_CAP_USDC } = {}) {
  const dayCapUsdc = Number.isFinite(askedCap) && askedCap > 0 ? Math.min(askedCap, PRIVATE_WITHDRAW_DAY_CAP_USDC) : PRIVATE_WITHDRAW_DAY_CAP_USDC;
  const own = isEvmAddress(user) ? lc(user) : null;
  const store = () => (storage === undefined ? defaultStorage() : storage);
  const prefix = own ? `${PRIVATE_WITHDRAW_PREFIX}${own}:` : null;
  const keyOf = (id) => `${prefix}${lc(id)}`;

  function usable() {
    const s = store();
    return !!(own && s && typeof s.getItem === "function" && typeof s.setItem === "function");
  }

  function get(id) {
    if (!usable() || typeof id !== "string" || !HEX40.test(id)) return null;
    let raw = null;
    try { raw = store().getItem(keyOf(id)); } catch { return null; }
    return raw ? readRecord(raw) : null;
  }

  /** Every record of this wallet, newest first. */
  function list() {
    if (!usable()) return [];
    const s = store();
    const out = [];
    let n = 0;
    try { n = typeof s.length === "number" ? s.length : 0; } catch { n = 0; }
    for (let i = 0; i < n; i++) {
      let k = null;
      try { k = s.key(i); } catch { k = null; }
      if (typeof k !== "string" || !k.startsWith(prefix)) continue;
      let raw = null;
      try { raw = s.getItem(k); } catch { raw = null; }
      const r = raw ? readRecord(raw) : null;
      if (r && keyOf(r.id) === k) out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /* An unsettled record still matters while its address can still be paid or refunded. */
  const blocking = (r, t) => UNSETTLED_STATES.includes(r.state) && !(Number.isFinite(r.deadlineAt) && r.deadlineAt < t);

  /** Raw 8-decimal units that left in the last 24 h. */
  function usedTodayRaw(t = now()) {
    return list()
      .filter((r) => t - r.createdAt < PRIVATE_DAY_MS && !NOTHING_MOVED_STATES.includes(r.state))
      .reduce((sum, r) => sum + BigInt(r.amountRaw), 0n);
  }

  /** May a new private withdrawal of `amountRaw` start? */
  function canStart({ amountRaw, now: t = now() } = {}) {
    if (!usable()) return { ok: false, code: "registry", message: REGISTRY_WORDS };
    if (typeof amountRaw !== "string" || !DIGITS.test(amountRaw) || BigInt(amountRaw) <= 0n) return { ok: false, code: "bad-amount", message: "Enter a USDC amount." };
    const open = list().filter((r) => blocking(r, t));
    if (open.length) return { ok: false, code: "unsettled", message: UNSETTLED_WORDS, depositAddress: open[0].id };
    const cap = BigInt(Math.round(dayCapUsdc * 1e6)) * 100n;
    const used = usedTodayRaw(t);
    if (used + BigInt(amountRaw) > cap) {
      const left = used >= cap ? 0n : cap - used;
      return { ok: false, code: "over-day-cap", message: PRIVATE_WITHDRAW_WORDS.dayCap(unitsToDecimal(left, 8), dayCapUsdc), leftUsdc: unitsToDecimal(left, 8) };
    }
    return { ok: true };
  }

  function write(rec) {
    const s = store();
    s.setItem(keyOf(rec.id), JSON.stringify(rec));
  }

  /**
   * Claim one deposit address, synchronously, before the wallet is asked.
   * { ok: true, record } or { ok: false, code, message } — and on a refusal
   * nothing was written.
   */
  function claim({ depositAddress, routeId = null, recipient = null, amountRaw, accountFeeUsdc = null, deadlineAt = null, refundStartsAt = null, correlationId = null, confidentiality = null, now: t = now() } = {}) {
    if (!usable()) return { ok: false, code: "registry", message: REGISTRY_WORDS };
    if (typeof depositAddress !== "string" || !HEX40.test(depositAddress)) return { ok: false, code: "bad-quote", message: "No quote to send." };
    if (get(depositAddress)) return { ok: false, code: "used", message: PRIVATE_WITHDRAW_WORDS.used };
    const can = canStart({ amountRaw, now: t });
    if (!can.ok) return can;
    const rec = {
      v: JOURNAL_VERSION,
      id: lc(depositAddress),
      token: randomToken(),
      state: "claimed",
      routeId: typeof routeId === "string" ? routeId : null,
      recipientTag: recipientTag(recipient),
      amountRaw,
      accountFeeUsdc: Number.isFinite(accountFeeUsdc) ? accountFeeUsdc : null,
      deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null,
      refundStartsAt: Number.isFinite(refundStartsAt) ? refundStartsAt : null,
      correlationId: typeof correlationId === "string" ? correlationId : null,
      confidentiality: typeof confidentiality === "string" ? confidentiality : null,
      createdAt: t,
      updatedAt: t,
      sentAt: null,
      why: null,
    };
    try { write(rec); } catch { return { ok: false, code: "registry", message: REGISTRY_WORDS }; }
    const back = get(depositAddress);
    if (!back || back.token !== rec.token || back.state !== "claimed") {
      return { ok: false, code: "registry", message: REGISTRY_WORDS };
    }
    prune(t);
    return { ok: true, record: back };
  }

  /**
   * Move a record on. Returns the record as stored, or null when the move is
   * not allowed (a final record never changes; an unknown id is not created).
   */
  function settle(id, state, { why = null, sentAt = null, now: t = now() } = {}) {
    if (!usable() || !JOURNAL_STATES.includes(state)) return null;
    const r = get(id);
    if (!r) return null;
    if (r.state === state) return r;
    if (!(NEXT[r.state] || []).includes(state)) return null;
    const next = { ...r, state, updatedAt: t, why: typeof why === "string" ? why.slice(0, 64) : r.why, sentAt: Number.isFinite(sentAt) ? sentAt : r.sentAt };
    try { write(next); } catch { return null; }
    return get(id);
  }

  /* Keep the newest JOURNAL_KEEP settled records; never drop an unsettled one. */
  function prune(t = now()) {
    const all = list();
    const settled = all.filter((r) => FINAL_STATES.includes(r.state) && t - r.createdAt >= PRIVATE_DAY_MS);
    for (const r of settled.slice(JOURNAL_KEEP)) {
      try { store().removeItem(keyOf(r.id)); } catch { /* kept */ }
    }
  }

  /** Records whose money step outcome is not known yet (and still matter). */
  function unsettled(t = now()) {
    return list().filter((r) => blocking(r, t));
  }

  return Object.freeze({ get, list, canStart, claim, settle, usedTodayRaw, unsettled, prune, user: own });
}
