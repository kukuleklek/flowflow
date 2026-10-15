// The last hop of a deposit, made by itself: ONE runner for the whole tab.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ทำไมเงิน ไม่ Move To Account แบบ Auto วะ ทุกเชนเลย ทำไมคนต้อง
// มากดเองวะ" / "มันมีเส้นทางที่ไม่ต้องเสีย 1.22". A brand-new Perp account would
// pay a one-time cost if the deposit were credited straight into it, so a Privy
// wallet's deposit lands as USDC in the customer's OWN embedded wallet on
// Arbitrum (lib/relay/firstDeposit.js) and that wallet makes the last hop: one
// USDC transfer into the deposit contract, which costs nothing
// (lib/relay/arbitrumBridge.js). Until now that hop was made only while the
// Deposit panel was open, and only for an arrival the panel watched land; any
// other money sat there behind a button. Now it moves by itself, on every
// deposit chain, with the panel open or not (firstDepositMove's rule 2).
//
// This file is the one thing in the tab that may start that move. The Deposit
// panel's hook (useFirstDeposit.js) and the app-wide mover (AutoMover.jsx) both
// drive it and both read it, so the panel, the popup (DepositStatus.jsx) and the
// mover can never disagree about a move, and two of them can never start two.
//
// 🔴 THE MONEY RULES IT KEEPS
//
//   1. NEVER TWO SIGNATURES FOR ONE LANDING. One move in flight per tab (the
//      in-flight promise IS the lock: a second caller gets the first one's
//      answer), and across tabs the Web Locks API where the browser has it.
//      The attempt is written down BEFORE the signature, and an automatic move
//      re-reads that record as the last thing before signing: another tab that
//      wrote one first wins, and this one signs nothing. A written attempt the
//      chain has not shown to be finished is never retried by itself — it is a
//      button (firstDepositMove's rule 1). The record lives in storage AND in
//      this tab's memory, so storage that refuses the write (full, blocked)
//      cannot make an attempt disappear. And the very figure a move sent, read
//      back, never finishes its own attempt, whatever its receipt says: that is
//      a node that has not caught up, not money that left.
//   2. THE AMOUNT IS READ FROM THE CHAIN AT THAT MOMENT. The figures here are
//      for the screen; the transfer is built by moveArbitrumUsdcToPerp from the
//      balance it reads itself, immediately before it is signed.
//   3. NOTHING BELOW THE FLOOR. A balance under BRIDGE_MIN_RAW never starts a
//      move, and the lib refuses it again against its own read.
//   4. AN UNREADABLE BALANCE IS NOT A ZERO. A failed read is { raw: null } and
//      nothing moves on it; an unreadable receipt leaves the attempt unresolved.
//   5. ONLY THE CUSTOMER'S OWN EMBEDDED WALLET, signing with no window: the
//      sender must exist and be the same address as the wallet and the
//      connection, or nothing moves by itself. The one transaction it may sign is
//      built in lib/relay/arbitrumBridge.js and rebuilt in the Privy bridge.
//   6. A REFUSAL IS NOT RETRIED IN A LOOP. A move that came back refused stays
//      "failed" (a button) until the chain shows something new — a different
//      balance, or none at all — or the customer presses. Two refusals are let
//      go sooner, because nothing was written and nothing signed: a missing
//      signer (when it arrives) and a network blip on the way to the signature
//      (on the next OUTSIDE look — the tab, a landing, the panel — never on the
//      move's own after-look, so it is one try per event and never a loop).
//   7. ONLY THE WALLET ON SCREEN. A move that ends after a sign-out or a switch
//      writes its record and stops: it never reads, focuses or moves for a
//      wallet that has left. A read for the new wallet that a move held up is
//      made when that move ends.
//   8. NOT IN A MOCK BUILD. VITE_PERP_BACKEND=mock moves nothing by itself (a
//      press, the customer deciding, still can: the money is real).
//
// No React, no timer: it reads when it is asked (on sign-in, on a deposit
// landing, on the tab coming back, after a move) and never on a clock. Every
// dependency is injected, so the Node suite drives it with fakes.

import {
  moveArbitrumUsdcToPerp, readArbitrumUsdcBalance, readArbitrumTxReceipt,
  BRIDGE_MIN_RAW, PerpMoveError, usdcFromRaw,
} from "../../lib/relay/arbitrumBridge.js";
import { readMoveRecord, writeMoveRecord, clearMoveRecord, moveStorage, moveStep } from "./firstDepositMove.js";
import { privySilentTxSender } from "../../services/privy.js";

/** The cross-tab lock's name, per wallet (Web Locks API). */
export const FUNDING_LOCK_PREFIX = "flowflow.perpFunding:";

/** The states a move can be in, as the runner reports them. */
export const FUNDING_STATUSES = Object.freeze(["idle", "checking", "sending", "sent", "failed"]);

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lc = (a) => (isAddr(a) ? a.toLowerCase() : null);
const same = (a, b) => isAddr(a) && isAddr(b) && a.toLowerCase() === b.toLowerCase();
const isRaw = (v) => typeof v === "bigint";

/* A refusal that came from a missing signer is not one a retry would repeat:
   the move waits for the signer to arrive instead of waiting for new money. */
const SIGNER_CODES = Object.freeze(["no-signer"]);

/* A refusal that came from the network on the way to the signature (the lib's
   own balance read, before beforeSend): nothing written, nothing signed, and a
   later look may well get through. Let go on the next OUTSIDE look (rule 6). */
const BLIP_CODES = Object.freeze(["network", "bad-response"]);

/* 🔴 RULE 8: does this build move anything by itself? Not a mock build. Read
   once, from the build's own environment (absent in Node: a live build). */
export const FUNDING_AUTO_BUILD = (() => {
  try { return import.meta.env.VITE_PERP_BACKEND !== "mock"; } catch { return true; }
})();

const LOCKED = Symbol("locked");

function rawOf(rec) {
  if (!rec || typeof rec.raw !== "string" || !/^\d+$/.test(rec.raw)) return null;
  try { return BigInt(rec.raw); } catch { return null; }
}

function blankFor(user, keep = {}) {
  return Object.freeze({
    user,
    status: "idle",
    /* The last read of this wallet's balance: { raw, usdc }, raw null when the
       read failed; null when nothing has been read yet. */
    balance: null,
    /* The figure of the move on screen: the balance it started from while
       sending, what it moved once sent, what is sitting there once refused. */
    usdc: null,
    code: null,
    txHash: null,
    at: null,
    /* The attempt written down for this wallet, as last read. */
    record: null,
    /* The balance a refusal happened on: the refusal stands until it changes. */
    failedRaw: null,
    /* Counters carried across a wallet switch (they only ever go up). */
    seq: Number.isFinite(keep.seq) ? keep.seq : 0,
    ackSeq: Number.isFinite(keep.ackSeq) ? keep.ackSeq : -1,
    reads: Number.isFinite(keep.reads) ? keep.reads : 0,
  });
}

/**
 * One runner. Everything it touches is handed in:
 *
 *   read     readArbitrumUsdcBalance, or a fake
 *   move     moveArbitrumUsdcToPerp, or a fake
 *   receipt  readArbitrumTxReceipt, or a fake
 *   sender   () => the no-window sender, or null (services/privy)
 *   storage  where attempts are written (default localStorage; null: nowhere)
 *   locks    the Web Locks API (default navigator.locks; null: none)
 *   now      the clock, for the screen only (when a move started)
 *   autoBuild may anything move by itself in this build (default: not a mock build)
 */
export function createPerpFunding({
  read = readArbitrumUsdcBalance,
  move = moveArbitrumUsdcToPerp,
  receipt = readArbitrumTxReceipt,
  sender = privySilentTxSender,
  storage,
  locks,
  now = Date.now,
  autoBuild = FUNDING_AUTO_BUILD,
} = {}) {
  const store = () => (storage === undefined ? moveStorage() : storage);
  /* 🔴 THE SESSION'S OWN COPY OF EVERY ATTEMPT THIS TAB WROTE (rule 1). Storage
     may refuse the write (full, blocked, private mode) and say nothing; this
     copy is what makes "written down before the signature" true anyway. The
     stored record wins when there is one (another tab may have written a newer
     one); this copy stands in when there is none, and it is cleared by exactly
     the same chain evidence as the stored one. */
  const mine = new Map();
  const recRead = (who) => readMoveRecord(store(), who) || mine.get(who) || null;
  const recWrite = (fields) => {
    const rec = writeMoveRecord(store(), fields);
    mine.set(rec.user, rec);
    return rec;
  };
  const recClear = (who) => { clearMoveRecord(store(), who); mine.delete(who); };
  /* Does storage take a write right now? Only then can another window's
     attempt be seen from this one. */
  const storageHolds = () => {
    const st = store();
    if (!st) return false;
    const k = `${FUNDING_LOCK_PREFIX}probe`;
    try { st.setItem(k, "1"); st.removeItem(k); return true; } catch { return false; }
  };
  const lockApi = () => {
    if (locks !== undefined) return locks;
    try {
      const l = typeof navigator !== "undefined" ? navigator.locks : null;
      return l && typeof l.request === "function" ? l : null;
    } catch { return null; }
  };
  const subs = new Set();
  let state = blankFor(null);
  let running = null; // { user, promise }: the one move in flight in this tab
  let reading = null; // { user, promise, auto, connected, sender }
  let held = null; // { user, connected, sender }: an automatic look another wallet's move held up

  function set(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const fn of [...subs]) { try { fn(); } catch { /* a reader never breaks the runner */ } }
  }

  /** The wallet on screen. Another wallet's figures are dropped, never shown under this one. */
  function focus(user) {
    const who = lc(user);
    if (state.user === who) return;
    reading = null;
    state = blankFor(who, state);
    set({});
  }

  function senderFor(fn) {
    let s = null;
    try { s = (fn || sender)(); } catch { s = null; }
    return s && typeof s.sendTransaction === "function" ? s : null;
  }

  /** Can this wallet move its own money by itself right now? Never in a mock build (rule 8). */
  function canRun(user, senderFn) {
    if (!autoBuild) return false;
    const s = senderFor(senderFn);
    return !!(s && same(s.address, user));
  }

  /* 🔴 IS THE ATTEMPT WRITTEN DOWN FINISHED? Only the chain can say so. The
     money left (the balance is 0, or below what the attempt moved — nothing
     but this app's own transfer takes USDC out of this wallet), or the
     transfer's own receipt says it was mined AND the balance shows money that
     is not the figure it moved. Anything else — no receipt yet, a reverted one,
     an unreadable one, or the very figure it moved read back — leaves it
     unresolved, and an unresolved attempt is a button, never a second
     signature. Cleared only if it is still the SAME attempt: another tab may
     have written a newer one while this read was out. */
  async function settleRecord(who, bal) {
    if (bal.raw === 0n) { recClear(who); return; }
    const rec = recRead(who);
    if (!rec || !isRaw(bal.raw)) return;
    const clearIfSame = () => {
      const now2 = recRead(who);
      if (now2 && now2.at === rec.at && now2.txHash === rec.txHash) recClear(who);
    };
    const moved = rawOf(rec);
    if (moved != null && bal.raw < moved) { clearIfSame(); return; }
    if (!rec.txHash || bal.raw < BRIDGE_MIN_RAW) return;
    /* 🔴 THE FIGURE IT MOVED, READ BACK, IS A NODE THAT HAS NOT CAUGHT UP. The
       receipt can come from a node that has the block while the balance comes
       from one that does not (a load-balanced public endpoint). A "success"
       there would clear the record, and the next look would sign the same
       money again. The record stays until the chain shows the money gone, or
       shows a different figure (new money on top). */
    if (moved != null && bal.raw === moved) return;
    let r = null;
    try { r = await receipt({ txHash: rec.txHash }); } catch { return; }
    if (r === "success") clearIfSame();
  }

  /* Everything an automatic move needs, checked at the moment it would start. */
  function autoReady(who, job) {
    if (running || state.user !== who) return false;
    if (state.status === "sending" || state.status === "failed") return false;
    const raw = state.balance ? state.balance.raw : null;
    if (!isRaw(raw) || raw < BRIDGE_MIN_RAW) return false;
    /* Right after a move, the very figure it just moved is not new money: it is
       the chain not having caught up (a lagging node), and never a reason to
       sign again. */
    if (isRaw(job.notRaw) && raw === job.notRaw) return false;
    if (recRead(who)) return false;
    if (!same(job.connected, who)) return false;
    return canRun(who, job.sender);
  }

  /**
   * Read this wallet's balance from the chain, settle the attempt written down,
   * and — with auto — start the move when everything above allows it. Resolves
   * the state it left (or the move's answer when it started one). Never throws.
   *
   *   user, connected   the wallet; they must be the same address to move
   *   auto              may this read start a move by itself?
   *   sender            the no-window sender factory (default: the runner's)
   */
  function check({ user, connected = null, auto = false, sender: senderFn = null, depth = 0, notRaw = null } = {}) {
    const who = lc(user);
    if (!who) return Promise.resolve(null);
    if (state.user !== who) focus(who);
    /* A move in flight reads again by itself when it ends. */
    if (running && running.user === who) return running.promise;
    if (reading && reading.user === who) {
      reading.auto = reading.auto || !!auto;
      if (isAddr(connected)) reading.connected = connected;
      if (senderFn) reading.sender = senderFn;
      /* The stricter of the two: a move's own after-look keeps its limits. */
      if (isRaw(notRaw)) reading.notRaw = notRaw;
      if (depth > reading.depth) reading.depth = depth;
      return reading.promise;
    }
    const job = { user: who, auto: !!auto, connected, sender: senderFn, depth, notRaw, promise: null };
    reading = job;
    if (state.status === "idle") set({ status: "checking" });
    job.promise = (async () => {
      let bal;
      try {
        const b = await read({ owner: who });
        bal = isRaw(b && b.raw) ? { raw: b.raw, usdc: Number.isFinite(b.usdc) ? b.usdc : null } : { raw: null, usdc: null };
      } catch {
        bal = { raw: null, usdc: null };
      }
      if (reading !== job || state.user !== who) return null;
      await settleRecord(who, bal);
      if (reading !== job || state.user !== who) return null;
      reading = null;
      const record = recRead(who);
      const patch = { balance: bal, record, reads: state.reads + 1 };
      if (state.status === "checking") patch.status = "idle";
      /* A refusal stands until the chain shows something new (rule 6), or — for
         a missing signer — until the signer is there, or — for a network blip
         before anything was written — until the next OUTSIDE look (depth 0:
         the tab, a landing, the panel; never the move's own after-look). */
      if (state.status === "failed" && isRaw(bal.raw) && !record) {
        /* A refusal made before any balance was read learns its balance now,
           rather than reading the first look after it as new money. */
        const known = isRaw(state.failedRaw);
        const newMoney = known && bal.raw !== state.failedRaw;
        const signerBack = SIGNER_CODES.includes(state.code) && canRun(who, job.sender);
        /* A window that waited on another window's refused move gets the same
           next-look chance, but only while storage holds: then the other
           window's attempt, had it written one, would be visible here. */
        const blipOver = job.depth === 0
          && (BLIP_CODES.includes(state.code) || (state.code === "elsewhere" && storageHolds()));
        if (newMoney || signerBack || blipOver) Object.assign(patch, { status: "idle", code: null, failedRaw: null, usdc: null });
        else if (!known) patch.failedRaw = bal.raw;
      }
      /* "Sent" describes the last move until NEW money is there: money at or
         over the floor with no unresolved attempt is not the money it moved. */
      const justMoved = isRaw(job.notRaw) && bal.raw === job.notRaw;
      if (state.status === "sent" && isRaw(bal.raw) && bal.raw >= BRIDGE_MIN_RAW && !record && !justMoved) {
        Object.assign(patch, { status: "idle", usdc: null, txHash: null });
      }
      set(patch);
      if (job.auto && autoReady(who, job)) {
        return run({ user: who, connected: job.connected, auto: true, sender: job.sender, depth: job.depth });
      }
      /* Another wallet's move (one that ended in a sign-out or a switch) held
         this look up: it is made again when that move ends (rule 7). */
      if (job.auto && running && running.user !== who) held = { user: who, connected: job.connected, sender: job.sender };
      return state;
    })();
    return job.promise;
  }

  /* Wait until no other window holds this wallet's lock (it has finished its
     move, or closed): the lock API releases a closed window's lock by itself. */
  async function waitForLock(who) {
    const api = lockApi();
    if (!api) return;
    try { await api.request(`${FUNDING_LOCK_PREFIX}${who}`, async () => {}); } catch { /* no lock to wait for */ }
  }

  async function withLock(who, fn) {
    const api = lockApi();
    if (!api) return fn();
    let ran = false;
    try {
      return await api.request(`${FUNDING_LOCK_PREFIX}${who}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return LOCKED;
        ran = true;
        return fn();
      });
    } catch {
      /* A lock API that refused to run at all is no lock: the record still
         guards the signature. One that ran and then failed has already
         answered through fn, which never throws. */
      return ran ? LOCKED : fn();
    }
  }

  /**
   * Make the move. With auto, only when nothing is written down; a press
   * (auto false) is the customer deciding, and goes ahead over an unresolved
   * attempt. A second call while one is in flight gets the first one's answer.
   * Resolves { ok, txHash?, usdc?, code?, skipped? }. Never throws.
   *
   *   address   the deposit address on screen, written into the attempt (optional)
   */
  function run({ user, connected = null, auto = false, sender: senderFn = null, address = null, depth = 0 } = {}) {
    const who = lc(user);
    if (!who) return Promise.resolve({ ok: false, skipped: "no-wallet" });
    if (running) return running.user === who ? running.promise : Promise.resolve({ ok: false, skipped: "busy" });
    if (state.user !== who) focus(who);
    const s = senderFor(senderFn);
    if (auto && !autoBuild) return Promise.resolve({ ok: false, skipped: "mock-build" });
    if (auto && !(s && same(s.address, who))) return Promise.resolve({ ok: false, skipped: "no-signer" });
    if (auto && recRead(who)) return Promise.resolve({ ok: false, skipped: "recorded" });
    const job = { user: who, promise: null };
    running = job;
    job.promise = (async () => {
      let out;
      let movedRaw = null;
      try {
        const startUsdc = state.balance && Number.isFinite(state.balance.usdc) ? state.balance.usdc : null;
        out = await withLock(who, async () => {
          /* Read again inside the lock: another tab may have moved it while
             this one waited. */
          if (auto && recRead(who)) return { ok: false, skipped: "recorded" };
          const at = now();
          set({ status: "sending", usdc: startUsdc, code: null, txHash: null, at, seq: state.seq + 1, failedRaw: null });
          try {
            const res = await move({
              owner: who,
              connected,
              sender: s,
              /* 🔴 THE LAST THING BEFORE THE SIGNATURE. An automatic move reads
                 the record once more here: a tab that wrote its attempt first
                 is moving this money, and this one signs nothing. Then the
                 attempt is written down, so one attempt can never become two. */
              beforeSend: ({ raw }) => {
                if (auto && recRead(who)) {
                  throw new PerpMoveError("already-tried", "Another window is already moving this money");
                }
                recWrite({ user: who, address, raw: isRaw(raw) ? raw.toString() : null, at });
              },
            });
            movedRaw = res.raw;
            recWrite({ user: who, address, raw: res.raw.toString(), txHash: res.txHash, at });
            if (state.user === who) set({ status: "sent", usdc: res.usdc, txHash: res.txHash, code: null, record: recRead(who) });
            return { ok: true, txHash: res.txHash, usdc: res.usdc };
          } catch (e) {
            const code = (e && e.code) || null;
            if (code === "already-tried") {
              if (state.user === who) set({ status: "idle", usdc: null, record: recRead(who) });
              return { ok: false, skipped: "recorded" };
            }
            if (state.user === who) {
              const bal = state.balance;
              set({
                status: "failed",
                code,
                failedRaw: bal ? bal.raw : null,
                usdc: bal && Number.isFinite(bal.usdc) ? bal.usdc : null,
                record: recRead(who),
              });
            }
            return { ok: false, code };
          }
        });
        if (out === LOCKED) {
          /* ANOTHER WINDOW OF THIS APP IS MOVING THIS MONEY right now. This one
             signs nothing; it says what is happening, waits for that window to
             finish, and then says what the other window wrote down — so two
             windows never tell the customer two different things. */
          if (state.user === who) set({ status: "sending", usdc: startUsdc, code: null, txHash: null, at: now(), seq: state.seq + 1 });
          await waitForLock(who);
          const rec = recRead(who);
          const theirs = rawOf(rec);
          movedRaw = theirs;
          if (state.user === who) {
            if (rec && rec.txHash && theirs != null) {
              set({ status: "sent", usdc: usdcFromRaw(theirs), txHash: rec.txHash, record: rec });
            } else if (rec) {
              set({ status: "idle", usdc: null, record: rec });
            } else {
              /* The other window wrote nothing: its move was refused before
                 its signature. Nothing is moving, so this window must not say
                 "Moving" (an "auto" step) — it says the move didn't go, with
                 the same button, until the chain shows something new. It does
                 not try by itself here: storage that refused the other
                 window's record would hide an attempt from this one. */
              const bal = state.balance;
              set({
                status: "failed",
                code: "elsewhere",
                failedRaw: bal ? bal.raw : null,
                usdc: bal && Number.isFinite(bal.usdc) ? bal.usdc : null,
                record: null,
              });
            }
          }
          out = { ok: false, skipped: "locked" };
        }
      } finally {
        running = null;
      }
      /* 🔴 RULE 7: a move that ended after a sign-out or a switch stops here.
         Its record is written (above); nothing more is read, focused or moved
         for a wallet that has left. A look for the wallet now on screen that
         this move held up is made now. */
      if (state.user !== who) {
        const h = held;
        held = null;
        if (h && h.user === state.user) check({ user: h.user, connected: h.connected, auto: true, sender: h.sender });
        return out;
      }
      held = null;
      /* Once more after a move: the money's new place, read from the chain. A
         refusal stands (rule 6) and an attempt stays written until the chain
         shows it finished, so this read can start a move only for NEW money
         (a deposit that landed while this one was moving) — and only ONCE: a
         move started by this read does not read-and-move again by itself. No
         chain answer, stale or wrong, can turn the runner into a loop of
         signatures; the next landing, the tab coming back or a press is what
         looks again. A window that only WAITED on another window's move reads
         without moving: the move was that window's. */
      const locked = !!(out && out.skipped === "locked");
      await check({ user: who, connected, auto: !locked && depth < 1, sender: senderFn, depth: depth + 1, notRaw: movedRaw });
      return out;
    })();
    return job.promise;
  }

  /** The popup has shown the customer the last move's end (sent or refused). */
  function acknowledge(seq = state.seq) {
    if (!Number.isFinite(seq) || seq <= state.ackSeq) return;
    set({ ackSeq: seq });
  }

  return {
    focus,
    check,
    run,
    canRun,
    acknowledge,
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/** The tab's one runner. Nothing runs until somebody asks it to read. */
export const perpFunding = createPerpFunding();

/**
 * Where the move stands for this wallet, as the panel and the popup both read
 * it: { step, usdc, code, seq, acked, balanceRead, checking }. One function, so
 * the two surfaces can never put one move in two states.
 *
 *   canAuto   can this wallet move by itself right now (runner.canRun)?
 */
export function fundingStep(state, user, { canAuto = true } = {}) {
  const who = lc(user);
  const none = { step: "idle", usdc: null, code: null, seq: 0, acked: true, balanceRead: false, balanceRaw: null, checking: false };
  if (!state || !who || state.user !== who) return none;
  const bal = state.balance;
  const raw = bal ? bal.raw : null;
  const sentUsdc = state.status === "sent" && Number.isFinite(state.usdc) ? state.usdc : null;
  const step = moveStep({
    raw,
    record: state.record,
    sending: state.status === "sending",
    sentUsdc,
    failed: state.status === "failed",
    canAuto,
  });
  const balUsdc = bal && Number.isFinite(bal.usdc) ? bal.usdc : null;
  const moving = step === "sent" || step === "sending";
  const usdc = moving && Number.isFinite(state.usdc) ? state.usdc : balUsdc;
  return {
    step,
    usdc,
    code: step === "failed" ? state.code : null,
    seq: state.seq,
    acked: state.ackSeq >= state.seq,
    balanceRead: !!bal,
    balanceRaw: raw,
    checking: state.status === "checking",
  };
}
