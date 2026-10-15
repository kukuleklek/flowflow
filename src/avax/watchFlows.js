// ─────────────────────────────────────────────────────────────────────────────
// THE FLOW WATCHER: settles Avax money moves that are "arriving" or "unknown" —
// ONLY with evidence. Relay's status for the moves it carries, the receipt of the
// record's own tx, USDC's authorizationState for a permit, and the Spot Account's
// balance against the figure written down when the card was made.
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §3.6 (failure table), §3.7 (poll 4 s for 2 min → 15 s → 60 s after 15 min,
// only while the tab shows). usePortfolio already reads the registry (readFlows), so
// whatever this settles shows there with no change on that side.
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. NEVER SUCCESS WITHOUT EVIDENCE. "done" needs a Relay status of success, a
//      receipt with status 1 for the move's FINAL tx, or the Spot Account holding at
//      least what was promised more than when the card was made. An unreadable status,
//      a missing receipt or a balance that did not move is "keep watching", never done.
//   2. "NOTHING MOVED" ONLY WITH PROOF, through registry.settleNothingMoved, which
//      re-checks the proof against the record itself: a permit that expired unused, the
//      record's own tx reverted, a run that stopped at its allowance, or a run that never
//      reached a money window and has been idle for 15 minutes.
//   3. A HASH IS ONLY EVIDENCE FOR ITS OWN STEP. A record's txHash may still be the
//      approve's when the swap after it was lost; its receipt then proves nothing about
//      the swap (approveTx == txHash ⇒ the final step's hash is unknown).
//   4. A RECORD ANOTHER LIVE TAB MAY STILL BE RUNNING (the load rule's "loaded-elsewhere",
//      younger than 15 minutes) is only ever settled by a FINAL success or refund.
//   5. READ-ONLY. Nothing here signs, sends or retries anything.
//   6. A HASH IS BOUND TO ITS NONCE (Privy's in-window "Retry transaction"): a reverted
//      receipt says "nothing moved" only for the ONE tx sent at the nonce written before its
//      window, with nothing mined past it (txHelpers.nonceBinding).
//   7. AN UNKNOWN WITH IDS STILL SETTLES — with evidence, after UNREACHED_IDLE_MS idle and
//      only while no tab of this browser holds the account's lock (no window can be open):
//      a run stopped at its allowance; the wallet's nonce never used at the money window's
//      nonce; the effect of a stake / unstake read on chain; for a move from the Main
//      Account, its ledger holding no transfer for it. Anything else keeps watching — and
//      the exits stay open meanwhile (flows.js EXIT_PAST_UNKNOWN_MS).
//   8. THE GAS TOP-UP IS CHECKED, NOT ASSUMED: it is not part of the move's order, so a move
//      in that carried one is "done" only once the Spot Account's AVAX rose by it — or, after
//      GAS_ARRIVAL_GRACE_MS, done with the words that the gas did not arrive.

import { pollDelayMs, UNREACHED_IDLE_MS, LOADED_ELSEWHERE, ownTxRecord } from "./flows.js";
import { readWithdrawStatus } from "../lib/relay/withdraw.js";
import { readAvaxAccount } from "../lib/avax/read.js";
import {
  readReceipt as readReceiptDefault, readPermitUsed as readPermitUsedDefault, readPendingNonce as readPendingNonceDefault,
  readLatestNonce as readLatestNonceDefault, readTxNonce as readTxNonceDefault, nonceBinding,
} from "../lib/avax/txHelpers.js";
import { formatRaw, toRaw } from "../lib/avax/units.js";
import { swapTokenBySymbol, HL_DEPOSITORY } from "../lib/avax/relayPins.js";
import { snowtraceTx } from "../lib/avax/config.js";
import { hlInfo } from "../lib/hyperliquid/info.js";
import { browserNow, browserTimers, docHidden } from "../lib/hyperliquid/browser.js";

const WATCHED = Object.freeze(["arriving", "unknown"]);
/** The final step of each tx-carried kind: only ITS receipt can say "done". */
const FINAL_STEP = Object.freeze({ swap: "swap", stake: "supply", unstake: "withdraw" });
const RELAY_KINDS = Object.freeze(["move-in", "gas-topup", "move-out"]);
/** A move in's USDC is in but its gas top-up is not: keep looking this long after it was sent. */
export const GAS_ARRIVAL_GRACE_MS = 5 * 60_000;
/** Markers in a settled move in's evidence that the panel turns into words (settledWords). */
export const GAS_SEEN = "gas AVAX +";
export const GAS_NOT_SEEN = "gas not seen";
const TICK_MS = 2_000;
const RELAY_REQUEST_URL = "https://relay.link/transaction/";
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const big = (v) => { try { return v == null ? null : BigInt(v); } catch { return null; } };
const relayLink = (id) => (typeof id === "string" && HASH_RE.test(id) ? `${RELAY_REQUEST_URL}${id}` : null);

/**
 * How many ledger lines (userNonFundingLedgerUpdates, as Hyperliquid answers it) could be
 * THIS move's sendAsset: a transfer from `own` to Relay's pinned depository at or after
 * `sinceMs`, with this nonce or no nonce to compare (then it counts — conservative: a Perp
 * Withdraw in the meantime keeps the record watched, never settles it). null = unreadable.
 */
export function hlSendsFor(json, { own, hlNonce, sinceMs }) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.nonFundingLedgerUpdates) ? json.nonFundingLedgerUpdates : null;
  if (!list) return null;
  let n = 0;
  for (const row of list) {
    const d = row && row.delta;
    if (!d || (d.type !== "send" && d.type !== "spotTransfer")) continue;
    if (lower(d.user) !== lower(own) || lower(d.destination) !== HL_DEPOSITORY) continue;
    if (Number.isFinite(Number(row.time)) && Number(row.time) < sinceMs) continue;
    if (d.nonce != null && Number(d.nonce) !== Number(hlNonce)) continue;
    n += 1;
  }
  return n;
}

/* The record's own tx hash for its CURRENT step, or null when the hash on file is an earlier step's. */
function stepHash(rec) {
  if (!rec || typeof rec.txHash !== "string" || !rec.txHash) return null;
  if (rec.step !== "approve" && rec.approveTx && lower(rec.approveTx) === lower(rec.txHash)) return null;
  return rec.txHash;
}

/**
 * What the evidence says about one record. PURE.
 * @param {object} rec  a registry record
 * @param {{ status?: {status:string}|null, receipt?: {status:number}|null, permitUsed?: boolean|null, permitReadAtS?: number,
 *   account?: object|null, pendingNonce?: bigint|null }} ev  what inspectFlow read
 * @returns {{ action: "finish", state: "done"|"refunded", evidence: string }
 *   | { action: "settle", proof: object } | { action: "keep", note: string|null, href?: string|null }}
 */
export function judgeFlow(rec, ev = {}, { now = Date.now() } = {}) {
  if (!rec || !WATCHED.includes(rec.state)) return { action: "keep", note: null };
  const k = rec.kind;
  const a = rec.amounts && typeof rec.amounts === "object" ? rec.amounts : {};
  const st = ev.status && typeof ev.status.status === "string" ? ev.status.status : null;
  const idle = now - (rec.updatedAt || rec.startedAt || now);
  /* Rule 4: another live tab may still be running it — only a final success / refund settles it. */
  const maybeLive = rec.why === LOADED_ELSEWHERE && idle < UNREACHED_IDLE_MS;
  /* Rule 7: a time-based proof only once idle long enough AND no tab holds the account's lock. */
  const settledByTime = rec.state === "unknown" && idle >= UNREACHED_IDLE_MS && ev.lockFree !== false;
  const balances = ev.account && ev.account.balances ? ev.account.balances : null;

  /* Rule 8: the USDC of a move in is in — and its gas top-up, when it carried one? */
  const moveInDone = (base) => {
    const want = big(a.topupRaw);
    const before = big(a.avaxBeforeRaw);
    if (k !== "move-in" || want == null || want <= 0n || before == null) return { action: "finish", state: "done", evidence: base };
    const avax = ev.account && typeof ev.account.avaxWei === "bigint" ? ev.account.avaxWei : null;
    if (avax != null && avax - before >= want) return { action: "finish", state: "done", evidence: `${base}; ${GAS_SEEN}${formatRaw(avax - before, 18, 4)}` };
    const since = now - (rec.sentAt || rec.updatedAt || rec.startedAt || now);
    if (since < GAS_ARRIVAL_GRACE_MS) {
      return { action: "keep", note: avax == null ? "Arrived in your Spot Account. Checking the gas for later." : "Arrived in your Spot Account. The gas for later hasn't arrived yet.", href: relayLink(rec.requestId) };
    }
    const got = avax == null ? "unread" : `AVAX +${formatRaw(avax > before ? avax - before : 0n, 18, 4)}`;
    return { action: "finish", state: "done", evidence: `${base}; ${GAS_NOT_SEEN} (${got})` };
  };

  /* 1. Moves Relay carries: its status is the first evidence. */
  if (RELAY_KINDS.includes(k) && rec.requestId) {
    if (st === "arrived") return moveInDone(`status success ${rec.requestId}`);
    if (st === "refunded") return { action: "finish", state: "refunded", evidence: `status refund ${rec.requestId}` };
  }
  /* 2. A move in promises EXACTLY `out`: the Spot Account holding that much more is evidence. */
  if (k === "move-in" && rec.requestId && a.out != null && a.beforeRaw != null && balances && typeof balances.USDC === "bigint") {
    const want = toRaw(String(a.out), 6);
    const before = big(a.beforeRaw);
    if (want != null && before != null && balances.USDC - before >= want) {
      return moveInDone(`Spot Account USDC +${formatRaw(balances.USDC - before, 6, 6)} since the card`);
    }
  }
  /* Relay's "failure": money may have left and a refund usually follows — never "nothing moved". */
  if (RELAY_KINDS.includes(k) && rec.requestId && st === "failed") {
    const back = k === "move-out" ? "your Spot Account" : "your Main Account";
    return { action: "keep", note: `The route reported a problem. A refund to ${back} usually follows. Don't send it again.`, href: relayLink(rec.requestId) };
  }
  /* 3. A permit exit. */
  if (k === "move-out" && rec.permitNonce) {
    const vb = Number(rec.validBefore);
    const nowS = Math.floor(now / 1000);
    if (!maybeLive && ev.permitUsed === false && Number.isFinite(vb) && nowS > vb && Number(ev.permitReadAtS) > vb) {
      return { action: "settle", proof: { kind: "permit-unused", used: false, readAtS: Number(ev.permitReadAtS) } };
    }
    if (ev.permitUsed === true) return { action: "keep", note: "Left your Spot Account. On its way to your Main Account." };
  }
  /* 4. Txs from the Spot Account: the receipt of the record's own step. */
  const hash = stepHash(rec);
  if (hash && ev.receipt && (ev.receipt.status === 0 || ev.receipt.status === 1)) {
    /* Rule 6: a reverted hash proves "nothing" only as the ONE tx of its window. */
    if (ev.receipt.status === 0 && !maybeLive && nonceBinding({ txNonce: rec.txNonce, hashNonce: ev.hashNonce, latestNonce: ev.latestNonce }) === "ok") {
      return { action: "settle", proof: { kind: "reverted", txHash: hash, status: 0, hashNonce: Number(ev.hashNonce), latestNonce: Number(ev.latestNonce) } };
    }
    if (ev.receipt.status === 1) {
      if (rec.step === "approve") {
        if (!maybeLive) return { action: "settle", proof: { kind: "approve-only", txHash: hash, status: 1 } };
      } else if (FINAL_STEP[k] && rec.step === FINAL_STEP[k]) {
        return { action: "finish", state: "done", evidence: `receipt status 1 ${hash}` };
      } else if (k === "move-out" && rec.step === "deposit") {
        return { action: "keep", note: "Left your Spot Account. On its way to your Main Account.", href: snowtraceTx(hash) };
      }
    }
  }
  /* 5. A swap whose final hash was lost: the nonce moved on AND the bought token arrived. */
  if (k === "swap" && rec.step === "swap" && !hash && rec.txNonce != null && typeof ev.pendingNonce === "bigint" && ev.pendingNonce > BigInt(rec.txNonce)) {
    const t = swapTokenBySymbol(a.to, { allowOff: true });
    const now1 = t && ev.account ? (t.native ? ev.account.avaxWei : balances ? balances[t.symbol] : null) : null;
    const before = big(a.toBeforeRaw);
    const min = big(a.minOutRaw);
    if (typeof now1 === "bigint" && before != null && min != null && min > 0n && now1 - before >= min) {
      return { action: "finish", state: "done", evidence: `${a.to} +${formatRaw(now1 - before, t.decimals, Math.min(t.decimals, 8))} since the card (nonce ${rec.txNonce} used)` };
    }
  }
  /* 6. A run that never reached a money window, idle long enough that it never will. */
  const ids = ["requestId", "hlNonce", "txHash", "txNonce", "permitNonce", "step"].some((key) => rec[key] != null);
  if (!ids && settledByTime) return { action: "settle", proof: { kind: "unreached" } };

  /* 7. Rule 7 — an unknown run whose money step is the user's OWN Avalanche tx. */
  if (settledByTime && ownTxRecord(rec)) {
    /* Stopped at its allowance: the money window never opened (its step is written first). */
    if (rec.step === "approve") return { action: "settle", proof: { kind: "stopped-at-approve" } };
    const n = Number.isSafeInteger(rec.txNonce) ? BigInt(rec.txNonce) : null;
    const latest = typeof ev.latestNonce === "bigint" ? ev.latestNonce : null;
    const pending = typeof ev.pendingNonce === "bigint" ? ev.pendingNonce : null;
    if (n != null && latest === n && pending === n && Number.isFinite(ev.noncesReadAt)) {
      return { action: "settle", proof: { kind: "nonce-unused", latestNonce: rec.txNonce, pendingNonce: rec.txNonce, readAt: ev.noncesReadAt } };
    }
    /* The nonce was used: what it did is read on chain (the hash may never have been written). */
    if (n != null && latest != null && latest > n && ev.account) {
      const aave = ev.account.aave || {};
      const usdc = balances && typeof balances.USDC === "bigint" ? balances.USDC : null;
      const before = big(a.beforeRaw);
      const amt = a.in != null && a.in !== "all" ? toRaw(String(a.in), 6) : null;
      if (k === "stake" && rec.step === "supply" && before != null && amt != null && typeof aave.suppliedRaw === "bigint" && aave.suppliedRaw - before >= amt) {
        return { action: "finish", state: "done", evidence: `Aave USDC +${formatRaw(aave.suppliedRaw - before, 6, 6)} since the card (nonce ${rec.txNonce} used)` };
      }
      if (k === "unstake" && rec.step === "withdraw" && before != null && usdc != null && usdc > before
        && (a.in === "all" ? aave.suppliedRaw === 0n : amt != null && usdc - before >= amt)) {
        return { action: "finish", state: "done", evidence: `Spot Account USDC +${formatRaw(usdc - before, 6, 6)} since the card (nonce ${rec.txNonce} used)` };
      }
    }
  }

  /* 8. Rule 7 — a move from the Main Account whose sendAsset id was written: its ledger. */
  if (settledByTime && (k === "move-in" || k === "gas-topup") && rec.hlNonce != null && rec.txHash == null
    && (!ev.status || ev.status.relayStatus == null || ev.status.relayStatus === "waiting")
    && ev.ledger && ev.ledger.sends === 0) {
    return { action: "settle", proof: { kind: "hl-not-sent", sends: 0, readAt: ev.ledger.readAt, fromMs: ev.ledger.fromMs } };
  }

  /* Still moving (arriving) reads as on its way; only an unknown says "not confirmed". */
  const note = rec.state === "arriving" ? (k === "move-out" ? "On its way to your Main Account." : k === "move-in" ? "On its way to your Spot Account." : "On its way.")
    : "Not confirmed yet. Don't send it again.";
  return { action: "keep", note, href: hash ? snowtraceTx(hash) : relayLink(rec.requestId) };
}

/**
 * Read what judgeFlow needs for one record. Never throws: a failed read is null.
 * @param {object} rec
 * @param {{ own: string, readStatus?: Function, readAccount?: Function, readReceipt?: Function,
 *   readPermitUsed?: Function, readPendingNonce?: Function, readLatestNonce?: Function, readTxNonce?: Function,
 *   readLedger?: Function, lockFree?: Function, now?: () => number }} deps
 *   lockFree: () => true | false | null — is the account's browser lock free (registry.lockFree)
 */
export async function inspectFlow(rec, deps = {}) {
  const {
    own, now = browserNow,
    readStatus = (o) => readWithdrawStatus(o),
    readAccount = (o) => readAvaxAccount(o),
    readReceipt = (h) => readReceiptDefault(h),
    readPermitUsed = (o) => readPermitUsedDefault(o),
    readPendingNonce = (o) => readPendingNonceDefault(o),
    readLatestNonce = (o) => readLatestNonceDefault(o),
    readTxNonce = (h) => readTxNonceDefault(h),
    readLedger = ({ own: user, startTime }) => hlInfo({ type: "userNonFundingLedgerUpdates", user, startTime }),
    lockFree = null,
  } = deps;
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };
  const ev = {
    status: null, receipt: null, permitUsed: null, permitReadAtS: null, account: null,
    pendingNonce: null, latestNonce: null, noncesReadAt: null, hashNonce: null, ledger: null, lockFree: null,
  };
  if (!rec) return ev;
  const k = rec.kind;
  const a = rec.amounts && typeof rec.amounts === "object" ? rec.amounts : {};
  const idleLong = rec.state === "unknown" && now() - (rec.updatedAt || rec.startedAt || now()) >= UNREACHED_IDLE_MS;
  if (RELAY_KINDS.includes(k) && rec.requestId) ev.status = await safe(() => readStatus({ requestId: rec.requestId }));
  const hash = stepHash(rec);
  if (hash) ev.receipt = await safe(() => readReceipt(hash));
  /* A reverted receipt is evidence only bound to its window's nonce (rule 6). */
  if (hash && ev.receipt && ev.receipt.status === 0) {
    ev.hashNonce = await safe(() => readTxNonce(hash));
    ev.latestNonce = await safe(() => readLatestNonce(own));
  }
  if (k === "move-out" && rec.permitNonce) {
    /* The time BEFORE the read: the chain answered at least this late. */
    const at = Math.floor(now() / 1000);
    const used = await safe(() => readPermitUsed({ own, nonce: rec.permitNonce }));
    ev.permitUsed = used === true || used === false ? used : null;
    ev.permitReadAtS = at;
  }
  const settled = ev.status && (ev.status.status === "arrived" || ev.status.status === "refunded");
  /* An idle unknown whose money step is an own tx, with no success receipt to settle it: its nonces
     (a reverted receipt that is not bound to its window — Privy's Retry — falls here too: what the
     FIRST tx at the window's nonce did is read on chain). */
  const ownTxIdle = idleLong && ownTxRecord(rec) && rec.step !== "approve" && Number.isSafeInteger(rec.txNonce) && !(ev.receipt && ev.receipt.status === 1);
  const swapLost = k === "swap" && rec.step === "swap" && !hash && rec.txNonce != null;
  if (swapLost || ownTxIdle) {
    /* The time BEFORE the reads: the chain answered at least this late. */
    const at = now();
    ev.pendingNonce = await safe(() => readPendingNonce(own));
    if (ownTxIdle) {
      ev.latestNonce = ev.latestNonce ?? await safe(() => readLatestNonce(own));
      ev.noncesReadAt = at;
    }
  }
  const nonceUsed = ownTxIdle && typeof ev.latestNonce === "bigint" && ev.latestNonce > BigInt(rec.txNonce) && (k === "stake" || k === "unstake");
  const needsBalance = (k === "move-in" && rec.requestId && !settled && ev.status)
    || (k === "move-in" && a.topupRaw != null && ev.status && ev.status.status === "arrived")
    || (k === "swap" && rec.step === "swap" && !hash)
    || nonceUsed;
  if (needsBalance) ev.account = await safe(() => readAccount(own));
  /* A move from the Main Account whose sendAsset id was written, idle: its ledger since the card. */
  if (idleLong && (k === "move-in" || k === "gas-topup") && rec.hlNonce != null && !settled) {
    const fromMs = Math.max(0, (rec.startedAt || 0) - 60_000);
    const at = now();
    const json = await safe(() => readLedger({ own, startTime: fromMs }));
    const sends = json == null ? null : hlSendsFor(json, { own, hlNonce: rec.hlNonce, sinceMs: fromMs });
    ev.ledger = sends == null ? null : { sends, readAt: at, fromMs };
  }
  if (idleLong && typeof lockFree === "function") {
    const f = await safe(() => lockFree());
    ev.lockFree = f === true || f === false ? f : null;
  }
  return ev;
}

/**
 * What a settled move in's evidence says about its gas top-up (rule 8), for the card:
 *   { seen: "0.0316" }        the AVAX that really arrived (the receipt line, plan §3.2)
 *   { missing: true, got }   the USDC arrived, the gas did not (got: "AVAX +0" or null when unread)
 *   null                     no top-up on this move, or nothing said
 */
export function gasNoteOf(evidence) {
  const e = typeof evidence === "string" ? evidence : "";
  const seen = e.indexOf(`; ${GAS_SEEN}`);
  if (seen >= 0) {
    const m = /^[<0-9.]+/.exec(e.slice(seen + 2 + GAS_SEEN.length));
    return m ? Object.freeze({ seen: m[0] }) : null;
  }
  const miss = /; gas not seen \((unread|AVAX \+[<0-9.]+)\)/.exec(e);
  if (miss) return Object.freeze({ missing: true, got: miss[1] === "unread" ? null : miss[1] });
  return null;
}

/**
 * The card's stages once its record settled with evidence (the run itself had left the last
 * one spinning, "arrive"): done → every stage done; refunded → the money went out and came
 * back, so "arrive" is ✗ and the stages before it are done; nothing moved → the open one ✗.
 */
export function settledProgress(stages, state) {
  if (!Array.isArray(stages)) return stages;
  return stages.map((x) => {
    if (state === "done") return { ...x, state: "done" };
    if (state === "refunded") return { ...x, state: x.key === "arrive" ? "failed" : x.state === "failed" || x.state === "unknown" ? x.state : "done" };
    if (state === "error-before-money") return { ...x, state: x.state === "active" || x.state === "unknown" ? "failed" : x.state };
    return x;
  });
}

/**
 * One watcher per account per page. Polls every arriving / unknown record at
 * pollDelayMs (flows.js), only while the page shows, and applies judgeFlow's answer.
 *
 * @param {{ registry: object, own: string, deps?: object, now?: () => number, timers?: object,
 *   isVisible?: () => boolean, onChange?: (id: string) => void }} o
 * @returns {{ start, stop, poke, tick, noteOf, running }}
 */
export function createFlowWatcher({
  registry, own, deps = {}, now = browserNow, timers = browserTimers,
  isVisible = () => !docHidden(), onChange = () => {},
} = {}) {
  const due = new Map();
  const notes = new Map();
  let handle = null;
  let stopped = true;
  let busy = false;

  const schedule = (ms) => {
    if (stopped) return;
    if (handle != null) timers.clearTimeout(handle);
    handle = timers.setTimeout(() => { handle = null; tick(); }, ms);
  };

  async function check(rec) {
    const ev = await inspectFlow(rec, { own, now, lockFree: () => (typeof registry.lockFree === "function" ? registry.lockFree() : null), ...deps });
    /* Re-read: another tab (or the run itself) may have settled it while we read. */
    const cur = registry.get(rec.id);
    if (!cur || !WATCHED.includes(cur.state)) return;
    const j = judgeFlow(cur, ev, { now: now() });
    try {
      if (j.action === "finish") {
        registry.finish(cur.id, j.state, j.evidence);
        notes.delete(cur.id);
        onChange(cur.id);
      } else if (j.action === "settle") {
        registry.settleNothingMoved(cur.id, j.proof);
        notes.delete(cur.id);
        onChange(cur.id);
      } else {
        const before = notes.get(cur.id);
        const next = j.note ? Object.freeze({ text: j.note, href: j.href || null }) : null;
        notes.set(cur.id, next);
        if (!before || !next || before.text !== next.text || before.href !== next.href) onChange(cur.id);
      }
    } catch {
      /* The registry refused (evidence it did not accept, storage): keep watching. */
    }
  }

  /** One pass over the due records. Resolves when done (tests await it). */
  async function tick({ force = false } = {}) {
    if (busy) return;
    busy = true;
    try {
      if (!force && !isVisible()) return;
      const list = registry.list().filter((f) => WATCHED.includes(f.state));
      const t = now();
      for (const rec of list) {
        if (!force && (due.get(rec.id) ?? 0) > t) continue;
        await check(rec);
        due.set(rec.id, now() + pollDelayMs(rec, now()));
      }
      for (const id of [...due.keys()]) if (!list.some((f) => f.id === id)) due.delete(id);
    } finally {
      busy = false;
      schedule(TICK_MS);
    }
  }

  return Object.freeze({
    start: () => { if (!stopped) return; stopped = false; schedule(0); },
    /** Logout / account switch: no more reads, no more writes. */
    stop: () => { stopped = true; if (handle != null) { timers.clearTimeout(handle); handle = null; } },
    /** Look at one record now (an executor just returned). */
    poke: (id) => { if (id) due.delete(id); schedule(50); },
    tick,
    noteOf: (id) => notes.get(id) || null,
    running: () => !stopped,
  });
}
