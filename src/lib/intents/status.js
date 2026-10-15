// ─────────────────────────────────────────────────────────────────────────────
// A one-time address's status, as the deposit watch's rows, and its tracker.
// ─────────────────────────────────────────────────────────────────────────────
//
// GET /status?depositAddress= answers ONE swap per address (one quote, one
// address), so a look gives at most one row. Its statuses, folded into the
// watch's own words (perp/deposit/depositWatch.js, perpDepositView.js):
//
//   PENDING_DEPOSIT      no row      "Waiting for your deposit" — nothing sent yet
//   KNOWN_DEPOSIT_TX     arriving    the deposit is seen on its chain
//   PROCESSING           arriving
//   SUCCESS              credited
//   REFUNDED             refunded
//   FAILED               failed
//   INCOMPLETE_DEPOSIT   incomplete  🔴 LESS ARRIVED THAN WAS QUOTED. It is refunded
//                                    after the deadline; it is NEVER "credited".
//   anything else        unknown     never credited (the pill is the dash)
//   404                  no row      the address has not been seen at all
//
// 🔴 A ROW THAT IS NOT THE CUSTOMER'S IS "unknown". The answer echoes the quote
// it was made from; on a deposit its recipient AND its refundTo must be the
// wallet being watched (the deposit rule), the address it answers for must be
// the one asked about, and both assets must be ones this folder quotes. Any of
// those off and the row is unknown: shown as the dash, never announced, never
// counted as money (the same rule Relay rows follow: normalizeRelayRequest).
// A row with NOBODY to hold the echo to (no wallet, no `expect`) is unknown too:
// an answer that was not checked is not money anybody can count.
//
// The tracker has the SAME contract as lib/relay/depositAddress.js's
// trackDeposits — { stop, refresh, snapshot } and the same onUpdate snapshot —
// and the same gentle schedule (nextPollDelay), so the watch can run either.
// Nothing here signs or sends; every request is a read.

import { isEvmAddress, sameAddress, nextPollDelay, TRACK_TIMEOUT_MS } from "../relay/depositAddress.js";
import { browserTimers, browserNow, docHidden, onDocVisibility } from "../hyperliquid/browser.js";
import { INTENTS_STATUS_URL, INTENTS_STATUS_UPSTREAM, PROVIDER_NEAR, PRIVATE_CORE_PLAN_ID, PRIVATE_ARB_PLAN_ID } from "./config.js";
import { intentsAssetById, intentsPairOf, rawOf, formatUnitsExact, HYPERCORE_USDC } from "./assets.js";
import { fetchIntentsStatus, IntentsError } from "./client.js";

/** 1Click status → the watch's row status. PENDING_DEPOSIT is not here: it is no row at all. */
export const INTENTS_STATUS_ROW = Object.freeze({
  KNOWN_DEPOSIT_TX: "arriving",
  PROCESSING: "arriving",
  SUCCESS: "credited",
  REFUNDED: "refunded",
  FAILED: "failed",
  INCOMPLETE_DEPOSIT: "incomplete",
});
export const INTENTS_NO_ROW = Object.freeze(["PENDING_DEPOSIT"]);

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const timeOf = (v) => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/* A figure from the answer's base units at the asset's OWN decimals (the ones
   this folder pinned and the token list confirmed), else from its formatted
   twin, else null. Never 0 for unknown. */
function figure(raw, formatted, asset) {
  const r = rawOf(raw);
  if (r != null && asset) {
    const n = Number(formatUnitsExact(r, asset.decimals));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof formatted === "string" && formatted.trim() && Number.isFinite(Number(formatted))) return Number(formatted);
  return null;
}

function firstHash(list) {
  if (!Array.isArray(list)) return null;
  for (const t of list) if (t && typeof t.hash === "string" && HASH_RE.test(t.hash)) return t.hash;
  return null;
}

/** Which private plan a status answer is on (from its own assets), or null. */
export function planOfStatus(originAssetId, destinationAssetId) {
  const pair = intentsPairOf(originAssetId, destinationAssetId);
  if (!pair) return null;
  if (pair.direction === "withdraw") return "withdraw";
  return destinationAssetId === HYPERCORE_USDC.assetId ? PRIVATE_CORE_PLAN_ID : PRIVATE_ARB_PLAN_ID;
}

/**
 * One GET /status answer as the watch's rows: [] or [row].
 *
 *   user            the wallet being watched (a deposit: recipient = refundTo = user)
 *   depositAddress  the address asked about
 *   expect          { recipient, refundTo } to hold the echo to instead (a
 *                   withdrawal: recipient is what the customer typed)
 *
 * With neither a wallet nor both halves of `expect`, every row is "unknown".
 *
 * A row: { id, provider, intentsStatus, relayStatus: null, status, mismatch,
 * direction, planId, amountIn, symbolIn, amountOut, symbolOut, refundedAmount,
 * inTxHash, inChainId, outTxHash, createdAt, updatedAt, quotedAt, failReason,
 * refundAfter }. Unknown fields are null.
 */
export function normalizeIntentsStatus(json, { user = null, depositAddress = null, expect = null } = {}) {
  const j = json && typeof json === "object" ? json : null;
  if (!j) return [];
  const st = typeof j.status === "string" ? j.status : null;
  if (INTENTS_NO_ROW.includes(st)) return [];
  const qresp = j.quoteResponse && typeof j.quoteResponse === "object" ? j.quoteResponse : {};
  const qr = qresp.quoteRequest && typeof qresp.quoteRequest === "object" ? qresp.quoteRequest : {};
  const q = qresp.quote && typeof qresp.quote === "object" ? qresp.quote : {};
  const sd = j.swapDetails && typeof j.swapDetails === "object" ? j.swapDetails : {};

  const want = expect && typeof expect === "object" ? expect : (isEvmAddress(user) ? { recipient: user, refundTo: user } : null);
  /* 🔴 Checked only when there is a recipient AND a refundTo to hold the echo to. */
  const unchecked = !want || !want.recipient || !want.refundTo;
  let mismatch = false;
  if (want && want.recipient && !sameAddress(qr.recipient, want.recipient)) mismatch = true;
  if (want && want.refundTo && !sameAddress(qr.refundTo, want.refundTo)) mismatch = true;
  /* The answer is about the address we asked about (when it says which). */
  if (depositAddress && q.depositAddress != null && !sameAddress(q.depositAddress, depositAddress)) mismatch = true;
  const originA = intentsAssetById(qr.originAsset);
  const destA = intentsAssetById(qr.destinationAsset);
  const pair = intentsPairOf(qr.originAsset, qr.destinationAsset);
  const foreign = !originA || !destA || !pair;
  const status = unchecked || mismatch || foreign ? "unknown" : (st && INTENTS_STATUS_ROW[st]) || "unknown";

  const updatedAt = timeOf(j.updatedAt);
  const quotedAt = timeOf(qresp.timestamp);
  const addr = String(depositAddress || q.depositAddress || "").toLowerCase();
  const ended = st === "REFUNDED" || st === "FAILED" || st === "INCOMPLETE_DEPOSIT";
  return [{
    id: `near:${addr}`,
    provider: PROVIDER_NEAR,
    intentsStatus: st,
    relayStatus: null,
    status,
    mismatch,
    direction: pair ? pair.direction : null,
    planId: planOfStatus(qr.originAsset, qr.destinationAsset),
    /* What was really sent to the address: the deposit as the chain saw it, or
       (once settled) the amount the swap took in. Never the quote's promise. */
    amountIn: figure(sd.depositedAmount, sd.depositedAmountFormatted, originA) ?? (st === "SUCCESS" ? figure(sd.amountIn, sd.amountInFormatted, originA) : null),
    symbolIn: originA ? originA.symbol : null,
    /* What landed: only on SUCCESS, from the settled swap. */
    amountOut: st === "SUCCESS" ? figure(sd.amountOut, sd.amountOutFormatted, destA) : null,
    symbolOut: destA ? destA.symbol : null,
    refundedAmount: st === "REFUNDED" ? figure(sd.refundedAmount, sd.refundedAmountFormatted, originA) : null,
    inTxHash: firstHash(sd.originChainTxHashes),
    inChainId: originA && Number.isInteger(originA.chainId) ? originA.chainId : null,
    outTxHash: firstHash(sd.destinationChainTxHashes),
    /* 🔴 THE ROW'S TIME IS ITS LAST CHANGE, not the quote's. A one-time address
       can be shown for hours before money is sent to it; the watch reads
       createdAt to decide whether money is "arriving now" (WATCH_MOVING_MAX_MS),
       and the quote's birth would call a deposit made this minute stale. The
       service's updatedAt is the latest thing it knows about this swap; the
       quote's own timestamp stands in only when that is missing. */
    createdAt: updatedAt ?? quotedAt,
    updatedAt,
    quotedAt,
    failReason: ended && typeof sd.refundReason === "string" && sd.refundReason ? sd.refundReason : null,
    /* "Less than quoted · refunded after {deadline}" (plan §4). */
    refundAfter: st === "INCOMPLETE_DEPOSIT" ? timeOf(q.deadline) : null,
  }];
}

/** One look at one address: the rows, or [] when there is nothing yet. Throws an IntentsError. */
export async function lookIntentsDeposit({
  depositAddress, user = null, expect = null, fetchImpl = globalThis.fetch, signal, timers = browserTimers,
  statusUrl = INTENTS_STATUS_URL, fallbackUrl = INTENTS_STATUS_UPSTREAM,
} = {}) {
  const json = await fetchIntentsStatus({ depositAddress, fetchImpl, signal, timers, url: statusUrl, fallbackUrl });
  return json == null ? [] : normalizeIntentsStatus(json, { user, depositAddress, expect });
}

/**
 * Watch one one-time address while the tab is visible. Same contract as
 * trackDeposits: onUpdate({ depositAddress, state, requests, checkedAt, error })
 * after every look; a hidden tab does no work and coming back looks at once.
 * Returns { stop, refresh, snapshot }.
 */
export function trackIntentsDeposit({
  depositAddress,
  user = null,
  expect = null,
  onUpdate = () => {},
  fetchImpl = globalThis.fetch,
  timers = browserTimers,
  now = browserNow,
  isHidden = docHidden,
  onVisibility = onDocVisibility,
  statusUrl = INTENTS_STATUS_URL,
  fallbackUrl = INTENTS_STATUS_UPSTREAM,
} = {}) {
  if (!isEvmAddress(depositAddress)) throw new IntentsError("bad-deposit-address", "Not a deposit address");
  let stopped = false;
  let timer = null;
  let busy = false;
  let ctrl = null;
  let guard = null;
  let errorStreak = 0;
  let rateLimited = false;
  let idleRounds = 0;
  let lastSig = null;
  let again = false;
  let snap = { depositAddress, state: "loading", requests: [], checkedAt: null, error: null };

  const clear = () => { if (timer != null) { timers.clearTimeout(timer); timer = null; } };
  const schedule = () => {
    clear();
    if (stopped || isHidden()) return;
    const inFlight = snap.requests.some((r) => r.status === "arriving");
    timer = timers.setTimeout(poll, nextPollDelay({ errorStreak, rateLimited, inFlight, idleRounds }));
  };

  async function poll() {
    timer = null;
    if (stopped || busy || isHidden()) return;
    busy = true;
    const mine = typeof AbortController === "function" ? new AbortController() : null;
    ctrl = mine;
    const myGuard = mine ? timers.setTimeout(() => mine.abort(), TRACK_TIMEOUT_MS) : null;
    guard = myGuard;
    try {
      const rows = await lookIntentsDeposit({ depositAddress, user, expect, fetchImpl, signal: mine ? mine.signal : undefined, timers, statusUrl, fallbackUrl });
      if (stopped) return;
      const sig = JSON.stringify(rows.map((r) => [r.id, r.status, r.updatedAt]));
      if (sig === lastSig) idleRounds += 1; else { idleRounds = 0; lastSig = sig; }
      errorStreak = 0;
      rateLimited = false;
      snap = { depositAddress, state: "ok", requests: rows, checkedAt: now(), error: null };
    } catch (e) {
      if (stopped) return;
      errorStreak += 1;
      rateLimited = !!(e && (e.status === 429 || e.code === "rate-limited"));
      const message = e && e.name === "AbortError" ? "The deposit service took too long to answer" : String((e && e.message) || e);
      /* Rows already on screen stay: a failed look is not an empty list. */
      snap = { ...snap, state: snap.checkedAt == null ? "error" : "ok", error: message };
    } finally {
      if (myGuard != null) timers.clearTimeout(myGuard);
      if (guard === myGuard) guard = null;
      if (ctrl === mine) ctrl = null;
      busy = false;
    }
    if (stopped) return;
    onUpdate(snap);
    if (again && !stopped) { again = false; poll(); return; }
    schedule();
  }

  const offVisibility = onVisibility(() => {
    if (stopped) return;
    if (isHidden()) { clear(); return; }
    if (!busy) { clear(); poll(); }
  });

  if (!isHidden()) poll();

  return {
    stop() {
      stopped = true;
      clear();
      if (guard != null) { timers.clearTimeout(guard); guard = null; }
      if (ctrl) { try { ctrl.abort(); } catch { /* already settled */ } ctrl = null; }
      offVisibility();
    },
    refresh() {
      if (stopped) return true;
      if (busy) { again = true; return false; }
      clear();
      poll();
      return true;
    },
    snapshot: () => snap,
  };
}
