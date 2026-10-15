// ─────────────────────────────────────────────────────────────────────────────
// WHERE A PRIVATE WITHDRAWAL GOT TO: GET /v0/status?depositAddress=…, and the
// Hyperliquid ledger when the sendAsset's own reply was lost.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน". Plan §3 P1 step 6 and the
// status table (§3 P0): the service's seven statuses, folded into what the
// withdraw sheet says. INCOMPLETE_DEPOSIT IS NEVER "arrived", and an answer
// that names a different recipient, refund account, asset or amount than the
// quote that was signed is "unknown" (mismatch), never "arrived".
//
// THE LOST REPLY. When the sendAsset's reply never came back (journal state
// "unknown"), the deposit address's status is the first witness: anything past
// PENDING_DEPOSIT means the money left. The second is the customer's own
// Hyperliquid ledger (userNonFundingLedgerUpdates, read-only): a "send" to the
// deposit address is proof it left; a readable ledger with none, well after the
// attempt, is proof it did not. Only then may the journal say "not-sent" and
// let a new withdrawal start. Neither read is ever a reason to send again.
//
// Reads only. Nothing here signs, sends or posts to /exchange.

import { browserTimers, browserNow, docHidden, onDocVisibility } from "../hyperliquid/browser.js";
import {
  HL_INTENTS_USDC, privateWithdrawRouteById, sameAddress, sameRecipient, isEvmAddress, hlInfoRead,
} from "./withdraw.js";
import { recipientTag } from "./withdrawJournal.js";
import { INTENTS_STATUS_URL, INTENTS_STATUS_UPSTREAM } from "./config.js";
import { fetchIntentsStatus } from "./client.js";

/** The service's statuses, folded. Anything unmapped is "unknown", never "arrived". */
export const INTENTS_WITHDRAW_STATUS = Object.freeze({
  PENDING_DEPOSIT: "waiting",
  KNOWN_DEPOSIT_TX: "arriving",
  PROCESSING: "arriving",
  SUCCESS: "arrived",
  INCOMPLETE_DEPOSIT: "incomplete",
  REFUNDED: "refunded",
  FAILED: "failed",
});

/** The folded statuses that end a follow-up. */
export const WITHDRAW_FINAL_STATUSES = Object.freeze(["arrived", "refunded", "failed"]);

export const WITHDRAW_STATUS_TIMEOUT_MS = 12_000;
/** A ledger with no send this long after the attempt means it did not go. */
export const LEDGER_SETTLE_MS = 3 * 60_000;
/** Poll cadence: quick while it should be landing, then backing off. */
export const STATUS_FAST_MS = 4000;
export const STATUS_SLOW_MS = 30_000;
export const STATUS_FAST_ROUNDS = 20;
/** A follow-up stops by itself after this long, whatever it last read. */
export const STATUS_MAX_MS = 6 * 60 * 60_000;

const strs = (list) => (Array.isArray(list) ? list.map((x) => (x && typeof x.hash === "string" ? x.hash : typeof x === "string" ? x : null)).filter(Boolean) : []);
const dec = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null);

/**
 * One status answer, folded and CHECKED against what was signed.
 * @param {object|null} json the answer body
 * @param {number} httpStatus
 * @param {{ depositAddress: string, user: string, routeId: string, amountRaw: string,
 *   recipient?: string|null, recipientTag?: string|null }} expect
 * @returns {{ status: string, serviceStatus: string|null, mismatch: boolean, why: string|null,
 *   receive: string|null, refunded: string|null, refundReason: string|null,
 *   inTxHashes: string[], outTxHashes: string[], updatedAt: number|null }}
 */
export function normalizeWithdrawStatus(json, httpStatus, expect = {}) {
  const empty = { serviceStatus: null, mismatch: false, why: null, receive: null, refunded: null, refundReason: null, inTxHashes: [], outTxHashes: [], updatedAt: null };
  if (httpStatus === 404) return { ...empty, status: "not-found" };
  if (!(httpStatus >= 200 && httpStatus < 300) || !json || typeof json !== "object") return { ...empty, status: "unknown", why: `answered ${httpStatus}` };
  const serviceStatus = typeof json.status === "string" ? json.status : null;
  const folded = (serviceStatus && INTENTS_WITHDRAW_STATUS[serviceStatus]) || "unknown";
  const qr = json.quoteResponse && typeof json.quoteResponse === "object" ? json.quoteResponse : {};
  const req = qr.quoteRequest && typeof qr.quoteRequest === "object" ? qr.quoteRequest : {};
  const q = qr.quote && typeof qr.quote === "object" ? qr.quote : {};
  const route = privateWithdrawRouteById(expect.routeId);

  /* The answer must be about the withdrawal that was signed. */
  let why = null;
  if (!route) why = "no route to check against";
  else if (q.depositAddress != null && !sameAddress(q.depositAddress, expect.depositAddress)) why = "another deposit address";
  else if (req.originAsset !== HL_INTENTS_USDC.assetId) why = "another origin";
  else if (req.destinationAsset !== route.assetId) why = "another destination token";
  else if (req.amount !== expect.amountRaw) why = "another amount";
  else if (!sameAddress(req.refundTo, expect.user)) why = "another refund account";
  else if (expect.recipient != null) { if (!sameRecipient(route, req.recipient, expect.recipient)) why = "another recipient"; }
  else if (expect.recipientTag != null) { if (recipientTag(req.recipient) !== expect.recipientTag) why = "another recipient"; }
  else why = "no recipient to check against";

  const sd = json.swapDetails && typeof json.swapDetails === "object" ? json.swapDetails : {};
  const updatedAt = Date.parse(json.updatedAt);
  const out = {
    serviceStatus,
    receive: folded === "arrived" ? dec(sd.amountOutFormatted) : null,
    refunded: dec(sd.refundedAmountFormatted),
    refundReason: typeof sd.refundReason === "string" ? sd.refundReason : null,
    inTxHashes: strs(sd.originChainTxHashes),
    outTxHashes: strs(sd.destinationChainTxHashes),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
  };
  if (why) return { ...out, status: "unknown", mismatch: true, why };
  return { ...out, status: folded, mismatch: false, why: null };
}

/**
 * Read one deposit address's status (GET, read-only), through the shared
 * transport (lib/intents/client.js fetchIntentsStatus: our status proxy in a
 * page, which carries the key; and, when the kill switch is off, ONE read of
 * the keyless endpoint instead, so money already sent is still followed).
 * Never throws: a failure is { status: "unknown" }, which is not "arrived".
 */
export async function readIntentsWithdrawStatus({
  depositAddress, expect, fetchImpl = globalThis.fetch, timers = browserTimers, url = INTENTS_STATUS_URL, fallbackUrl = INTENTS_STATUS_UPSTREAM,
} = {}) {
  if (!isEvmAddress(depositAddress)) return { ...normalizeWithdrawStatus(null, 0, {}), status: "unknown", why: "no deposit address" };
  let json;
  try {
    json = await fetchIntentsStatus({ depositAddress, fetchImpl, timers, url, fallbackUrl });
  } catch (e) {
    return { ...normalizeWithdrawStatus(null, 0, {}), status: "unknown", why: String((e && (e.code || e.message)) || e) };
  }
  if (json === null) return normalizeWithdrawStatus(null, 404, { ...expect, depositAddress });
  return normalizeWithdrawStatus(json, 200, { ...expect, depositAddress });
}

/**
 * Did the Perp account's sendAsset to this deposit address happen? Read from
 * the customer's own ledger. true: a send is there; false: the ledger was read,
 * has none, and the attempt is older than LEDGER_SETTLE_MS; null: anything else.
 */
export async function readSendOutcome({ user, depositAddress, since, info = hlInfoRead, fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow } = {}) {
  if (!isEvmAddress(user) || !isEvmAddress(depositAddress) || !Number.isFinite(since)) return { sent: null, hash: null };
  let rows = null;
  try {
    rows = await info({ type: "userNonFundingLedgerUpdates", user, startTime: Math.max(0, since - 60_000) }, { fetchImpl, timers });
  } catch {
    return { sent: null, hash: null };
  }
  if (!Array.isArray(rows)) return { sent: null, hash: null };
  const hit = rows.find((e) => e && e.delta && e.delta.type === "send" && sameAddress(e.delta.destination, depositAddress)
    && (e.delta.user == null || sameAddress(e.delta.user, user)));
  if (hit) return { sent: true, hash: typeof hit.hash === "string" ? hit.hash : null, amount: typeof hit.delta.amount === "string" ? hit.delta.amount : null, fee: typeof hit.delta.fee === "string" ? hit.delta.fee : null };
  return { sent: now() - since >= LEDGER_SETTLE_MS ? false : null, hash: null };
}

/* What a folded status means for the journal record (null: leave it). */
const JOURNAL_FOR = Object.freeze({ arriving: "arriving", arrived: "arrived", incomplete: "incomplete", refunded: "refunded", failed: "failed" });

/**
 * Settle one journal record from what can be read now. Used by the tracker,
 * and by a page that finds unsettled records on load. Returns the new state,
 * or null when nothing could be decided. Never sends anything.
 */
export async function settleFromReads({ journal, record, user, fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, info = hlInfoRead, url = INTENTS_STATUS_URL, fallbackUrl = INTENTS_STATUS_UPSTREAM } = {}) {
  if (!journal || !record) return null;
  const st = await readIntentsWithdrawStatus({
    depositAddress: record.id,
    expect: { user, routeId: record.routeId, amountRaw: record.amountRaw, recipientTag: record.recipientTag },
    fetchImpl, timers, url, fallbackUrl,
  });
  const target = JOURNAL_FOR[st.status];
  if (target && !st.mismatch) {
    const r = journal.settle(record.id, target, { why: st.serviceStatus, now: now() });
    return r ? r.state : null;
  }
  if (record.state === "claimed" || record.state === "unknown") {
    const since = record.createdAt;
    const led = await readSendOutcome({ user, depositAddress: record.id, since, info, fetchImpl, timers, now });
    if (led.sent === true) { const r = journal.settle(record.id, "sent", { why: "ledger", now: now() }); return r ? r.state : null; }
    if (led.sent === false && (st.status === "not-found" || st.status === "waiting")) {
      const r = journal.settle(record.id, "not-sent", { why: "ledger-none", now: now() });
      return r ? r.state : null;
    }
    if ((st.status === "waiting" || st.status === "not-found") && Number.isFinite(record.deadlineAt) && now() > record.deadlineAt) {
      const r = journal.settle(record.id, "expired", { why: "deadline", now: now() });
      return r ? r.state : null;
    }
  }
  return null;
}

/**
 * Follow one Private withdrawal until it ends. Polls the status (never while
 * the tab is hidden), settles the journal record as it goes, and stops by
 * itself at an end or after STATUS_MAX_MS.
 * @returns {{ stop: () => void, refresh: () => void, snapshot: () => object|null }}
 */
export function trackIntentsWithdraw({
  depositAddress, expect, journal = null, onUpdate = () => {},
  fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, hidden = docHidden, onVisibility = onDocVisibility,
  url = INTENTS_STATUS_URL, fallbackUrl = INTENTS_STATUS_UPSTREAM,
} = {}) {
  let stopped = false;
  let timer = null;
  let rounds = 0;
  let last = null;
  let inFlight = false;
  const startedAt = now();
  let unlisten = () => {};

  const schedule = () => {
    if (stopped) return;
    const ms = rounds < STATUS_FAST_ROUNDS ? STATUS_FAST_MS : STATUS_SLOW_MS;
    timer = timers.setTimeout(tick, ms);
  };

  async function tick() {
    timer = null;
    if (stopped || inFlight) return;
    if (now() - startedAt > STATUS_MAX_MS) { stop(); return; }
    if (hidden()) return; /* parked: the visibility listener looks once on the way back */
    inFlight = true;
    rounds += 1;
    try {
      last = await readIntentsWithdrawStatus({ depositAddress, expect, fetchImpl, timers, url, fallbackUrl });
      const target = JOURNAL_FOR[last.status];
      if (journal && target && !last.mismatch) {
        try { journal.settle(depositAddress, target, { why: last.serviceStatus, now: now() }); } catch { /* the screen still shows it */ }
      }
      try { onUpdate(last); } catch { /* a screen's problem is not the tracker's */ }
      if (WITHDRAW_FINAL_STATUSES.includes(last.status) && !last.mismatch) { stop(); return; }
    } finally {
      inFlight = false;
    }
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer != null) timers.clearTimeout(timer);
    timer = null;
    try { unlisten(); } catch { /* gone */ }
  }

  function refresh() {
    if (stopped) return;
    if (timer != null) timers.clearTimeout(timer);
    timer = null;
    void tick();
  }

  try { unlisten = onVisibility(() => { if (!hidden()) refresh(); }) || (() => {}); } catch { unlisten = () => {}; }
  void tick();
  return { stop, refresh, snapshot: () => last };
}
