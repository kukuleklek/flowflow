// ─────────────────────────────────────────────────────────────────────────────
// THE REACT SIDE OF THE AVAX MONEY ACTIONS. Thin on purpose: every rule lives in
// src/avax/money.js (review → confirm → run) and src/avax/watchFlows.js (settling
// with evidence). This file keeps ONE registry, ONE controller and ONE watcher per
// account per page, feeds them the live Main Account and Hyperliquid mids, and
// gives a card a small state machine.
// ─────────────────────────────────────────────────────────────────────────────
//
//   useAvaxMoney()        { ready, why, own, money, flows, inFlight }
//   useAvaxAction(kind)   { phase, review, progress, outcome, price(args), refresh(), confirm(), close(), canConfirm }
//     kind: "move-in" | "move-out" | "stake" | "unstake" | "swap"
//
// 🔴 RULES THIS FILE KEEPS
//   1. ONE REGISTRY PER ACCOUNT PER PAGE (module scope, not per component): a card
//      reviewed in one panel is the same record every other panel sees, and two
//      mounted cards can never hold two registries with two tab ids.
//   2. CONFIRM IS ONE CALL, SYNCHRONOUS AT ITS START: money.confirm() runs
//      registry.confirm(id) before its first await. A second tap gets "already-run"
//      and the card keeps showing the run it already has — never a second run.
//   3. LOGOUT / ACCOUNT SWITCH STOPS THE WATCHER and drops the controller; the next
//      account gets its own. Signers are re-read at every window by the executors.
//   4. A PRICE IS RE-QUOTED BEFORE IT EXPIRES while the card is open (and never
//      while a run is going). A WORSE one is said on screen ("The price changed…",
//      money.js worse()), and Confirm acts only on the review the tap was drawn with,
//      never within a second of its figures changing (src/avax/cardState.js).
//   5. THE MIDS ARE LIVE OR ABSENT. The independent prices a review uses are read from
//      the market store AT REVIEW TIME, and a coin whose row went stale (the stream
//      stopped: a hidden tab, a reconnect) is left out (money.js liveMids) — "No
//      independent price", never a frozen one.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBackend } from "../perp/BackendContext.jsx";
import { useWallet } from "../hooks/useWallet.js";
import { perpMarketsStore, usePerpMarkets } from "../lib/hyperliquid/index.js";
import { ownAvaxAddressWhy } from "../lib/avax/own.js";
import { getAvaxSigners, subscribeAvaxSigners } from "./signers.js";
import { createFlowRegistry, subscribeFlows } from "./flows.js";
import { createAvaxMoney, liveMids, MONEY_WHY } from "./money.js";
import { createFlowWatcher } from "./watchFlows.js";
import { CONFIRM_SETTLE_MS, figuresChanged, mayConfirm, refreshedState, settledState } from "./cardState.js";

/* ── one per account per page ─────────────────────────────────────────────── */

const PAGE = { own: null, registry: null, money: null, watcher: null };
/* What the controller reads at review / confirm time; refreshed by every mounted hook. */
const LIVE = { perp: null };
/* The mids as the market store holds them NOW (not as of the last render), stale coins left out. */
const midsNow = () => { try { return liveMids(perpMarketsStore().getSnapshot()); } catch { return {}; } };
let version = 0;
const subs = new Set();
const bump = () => { version += 1; for (const fn of [...subs]) { try { fn(); } catch { /* one subscriber */ } } };
const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const getVersion = () => version;

function localStore() {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

/** The page's registry / controller / watcher for `own` (made once; a change of account replaces them). */
function pageFor(own) {
  if (PAGE.own === own) return PAGE;
  if (PAGE.watcher) PAGE.watcher.stop();
  PAGE.own = null;
  PAGE.registry = null;
  PAGE.money = null;
  PAGE.watcher = null;
  if (!own) return PAGE;
  const registry = createFlowRegistry({ storage: localStore(), own });
  const watcher = createFlowWatcher({ registry, own, onChange: bump });
  let money = null;
  try {
    money = createAvaxMoney({
      own, registry, signers: getAvaxSigners, env: import.meta.env,
      getPerp: () => LIVE.perp, getMids: midsNow,
      fetchImpl: (...a) => globalThis.fetch(...a),
      onFlow: (id) => { watcher.poke(id); bump(); },
    });
  } catch {
    money = null;
  }
  watcher.start();
  PAGE.own = own;
  PAGE.registry = registry;
  PAGE.money = money;
  PAGE.watcher = watcher;
  return PAGE;
}

/* ── the account-level hook ──────────────────────────────────────────────── */

/**
 * @returns {{ ready: boolean, why: string|null, own: string|null, money: object|null,
 *   flows: object[], inFlight: object[] }}
 *   flows: every record of this account (oldest first) with `view` (flows.js flowView) and
 *   `note` ({ text, href } from the watcher, or null). inFlight: the ones money may be moving in.
 */
export function useAvaxMoney() {
  const signers = useSyncExternalStore(subscribeAvaxSigners, getAvaxSigners, () => null);
  const b = useBackend();
  const w = useWallet();
  /* Keeps the market stream (and so the mids) alive while a card is mounted; the controller reads
     the store itself at review time (midsNow), so a render that lags never hands it an old price. */
  usePerpMarkets();
  useSyncExternalStore(subscribe, getVersion, getVersion);

  /* What the controller reads when a card is priced or confirmed. */
  LIVE.perp = b && b.account ? { balance: b.account.perpBalanceUsdc || null, positions: b.account.positions || null } : null;

  const own = signers ? signers.own : null;
  const page = useMemo(() => pageFor(own), [own]);

  /* Another tab wrote this account's registry: read it again. */
  useEffect(() => {
    if (!own || typeof window === "undefined") return undefined;
    return subscribeFlows(window, localStore(), own, () => bump());
  }, [own]);

  let why = null;
  if (!own) {
    const ow = ownAvaxAddressWhy({ wallet: w, backend: b, embeddedAddress: null });
    why = b && b.mock ? "Live only" : ow.why && ow.why !== MONEY_WHY.walletLoading ? ow.why : MONEY_WHY.walletLoading;
  } else if (!page.registry || !page.registry.available()) {
    why = MONEY_WHY.storage;
  } else if (!page.money) {
    why = MONEY_WHY.walletLoading;
  }
  const list = page.registry ? page.registry.list() : [];
  const flows = list.map((f) => Object.freeze({ ...f, view: page.registry.view(f), note: page.watcher ? page.watcher.noteOf(f.id) : null }));
  return {
    ready: !why && !!page.money,
    why,
    own,
    money: why ? null : page.money,
    flows,
    inFlight: flows.filter((f) => f.view && f.view.watching),
  };
}

/* ── one card ─────────────────────────────────────────────────────────────── */

/** Re-quote this long before a review's price expires. */
const REFRESH_LEAD_MS = 8_000;

function phaseOf(out) {
  if (!out) return "failed";
  if (out.ok && out.state === "done") return "done";
  if (out.ok) return "arriving";
  if (out.unknown || out.state === "unknown") return "unknown";
  if (out.alreadyRun) return "running";
  return "failed";
}

/**
 * A card's state machine over money.js.
 *   phase: "idle" | "pricing" | "review" | "running" | "arriving" | "done" | "refunded" | "unknown" | "failed"
 *   review: the frozen review (display-ready figures, `confirmable`, `whyNot`, `rows`, `stages`, `expiresAt`)
 *   progress: the review's stages with state "todo" | "active" | "done" | "failed" | "unknown"
 *   outcome: money.confirm()'s answer, or the watcher's settlement once it has evidence
 * Call price(args) when the user presses Review (not on every keystroke: each review is a record).
 *   move-in / move-out / stake: { amountUsdc }   unstake: { amountUsdc } or { amountUsdc: "all" }   swap: { from, to, amount }
 */
export function useAvaxAction(kind) {
  const m = useAvaxMoney();
  const money = m.money;
  const [st, setSt] = useState({ phase: "idle", review: null, progress: null, outcome: null, changedAt: null });
  const reviewRef = useRef(null);
  const changedRef = useRef(null);
  const seq = useRef(0);
  const running = useRef(false);

  const price = useCallback(async (args) => {
    if (!money || running.current) return null;
    const n = ++seq.current;
    setSt((s) => ({ ...s, phase: "pricing", outcome: null }));
    const prev = reviewRef.current;
    let r = null;
    try { r = await money.review(kind, args, prev); } catch { r = null; }
    if (n !== seq.current || running.current) {
      if (r) money.close(r);
      return null;
    }
    reviewRef.current = r;
    changedRef.current = null;
    setSt({ phase: r ? "review" : "failed", review: r, progress: r ? r.stages : null, outcome: r ? null : { ok: false, state: null, message: "Couldn't price this right now. Nothing moved." }, changedAt: null });
    return r;
  }, [money, kind]);

  const refresh = useCallback(async () => {
    const prev = reviewRef.current;
    if (!money || !prev || running.current) return null;
    const n = ++seq.current;
    let r = null;
    try { r = await money.refresh(prev); } catch { r = null; }
    if (!r || n !== seq.current || running.current) { if (r && r !== reviewRef.current) money.close(r); return null; }
    /* A worse price is SAID, above the new figures; Confirm waits a moment after any change (cardState rules 1–2). */
    let worse = null;
    try { worse = typeof money.worse === "function" ? money.worse(prev, r) : null; } catch { worse = "not-decodable"; }
    const at = Date.now();
    /* Both refs move together, before the render: a tap that lands in between is refused by mayConfirm. */
    if (figuresChanged(prev, r)) changedRef.current = at;
    reviewRef.current = r;
    setSt((s) => refreshedState(s, { next: r, worse, at }));
    return r;
  }, [money]);

  /* Confirm waits CONFIRM_SETTLE_MS after the figures changed: re-render when that has passed. */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (typeof st.changedAt !== "number") return undefined;
    const left = st.changedAt + CONFIRM_SETTLE_MS - Date.now();
    if (left <= 0) return undefined;
    const t = setTimeout(() => setTick((x) => x + 1), left + 20);
    return () => clearTimeout(t);
  }, [st.changedAt]);

  /* Re-quote shortly before the shown price expires, while the card is only being read. */
  useEffect(() => {
    if (st.phase !== "review" || !st.review || !Number.isFinite(st.review.expiresAt)) return undefined;
    const wait = Math.max(1_000, st.review.expiresAt - REFRESH_LEAD_MS - Date.now());
    const t = setTimeout(() => { refresh(); }, wait);
    return () => clearTimeout(t);
  }, [st.phase, st.review, refresh]);

  /* `rendered`: the review the tapped Confirm was drawn with. Only that one, when it is still the
     current one and its figures have settled, is confirmed (cardState rule 2). */
  const confirm = useCallback((rendered) => {
    const r = reviewRef.current;
    if (!money || !r || running.current) return null;
    if (!mayConfirm({ rendered, current: r, changedAt: changedRef.current, at: Date.now() })) return null;
    running.current = true;
    /* money.confirm's first act is the synchronous registry.confirm — the double-tap guard. */
    const p = money.confirm(r, { onProgress: (stages) => setSt((s) => ({ ...s, progress: stages })) });
    setSt((s) => ({ ...s, phase: "running", outcome: null }));
    p.then((out) => {
      running.current = false;
      if (out && out.needsConfirm && out.review) {
        reviewRef.current = out.review;
        changedRef.current = Date.now();
        setSt({ phase: "review", review: out.review, progress: out.review.stages, outcome: out, changedAt: changedRef.current });
        return;
      }
      setSt((s) => ({ ...s, phase: phaseOf(out), outcome: out }));
    }, () => {
      running.current = false;
      setSt((s) => ({ ...s, phase: "unknown", outcome: { ok: false, state: "unknown", unknown: true, message: "Not confirmed yet. Don't send it again." } }));
    });
    return p;
  }, [money]);

  const close = useCallback(() => {
    if (running.current) return;
    if (money && reviewRef.current) money.close(reviewRef.current);
    reviewRef.current = null;
    changedRef.current = null;
    seq.current += 1;
    setSt({ phase: "idle", review: null, progress: null, outcome: null, changedAt: null });
  }, [money]);

  /* An arriving / unknown run settles when the watcher has evidence: its stages too (a refund
     leaves no spinner on "Arrive"), and a move in's gas as it really came (cardState rule 3). */
  const rec = st.review ? m.flows.find((f) => f.id === st.review.id) : null;
  const recState = rec ? rec.state : null;
  const recEvidence = rec ? rec.evidence : null;
  const recRequest = rec ? rec.requestId || null : null;
  useEffect(() => {
    if (st.phase !== "arriving" && st.phase !== "unknown") return;
    if (recState !== "done" && recState !== "refunded" && recState !== "error-before-money") return;
    setSt((s) => settledState(s, { kind, rec: { state: recState, evidence: recEvidence, requestId: recRequest } }));
  }, [st.phase, recState, recEvidence, recRequest, kind]);

  return {
    ready: m.ready,
    why: m.why,
    phase: st.phase,
    review: st.review,
    progress: st.progress,
    outcome: st.outcome,
    note: rec ? rec.note : null,
    canConfirm: st.phase === "review" && !!st.review && st.review.confirmable && !running.current
      && !(typeof st.changedAt === "number" && Date.now() - st.changedAt < CONFIRM_SETTLE_MS),
    price,
    refresh,
    confirm,
    close,
  };
}

export default useAvaxMoney;
