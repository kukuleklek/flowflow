// The Private Withdraw sheet's hooks, over lib/intents (1Click through our shared
// proxies) and the exchange client's ONE visible signature.
// ─────────────────────────────────────────────────────────────────────────────
//
// usePrivateWithdrawLedger: this wallet's private-withdraw journal
// (lib/intents/withdrawJournal.js) as the sheet sees it. On open — on Normal as
// on Private — every record still in flight is settled from READS
// (settleFromReads: the status endpoint, then the account's own ledger); an
// unsettled one (claimed / unknown) is read again every SETTLE_EVERY_MS while the
// sheet is open, and BLOCKS the next private withdrawal until it is settled.
// Nothing here ever sends anything again.
//
// usePrivateWithdraw: one private withdrawal, in the order the customer meets it:
//   1. the amount, the network (the owner's four) and the address they TYPE,
//      each refused in plain words before anything leaves (privateWithdrawView);
//   2. a DRY quote while typing (debounced; it reserves nothing);
//   3. "Review withdrawal" — only on the customer's own press — asks for the
//      REAL quote (a one-time address, with the journal: the day cap and "nothing
//      unsettled" are read first) and then the preflight (Hyperliquid reads: is
//      the address clear, what activation fee, does the balance cover both);
//   4. "Confirm and sign" signs ONCE, visibly (executeIntentsWithdraw with the
//      backend's sendIntentsDeposit, its words armed for that one window). A
//      quote past its minute is quoted again and SHOWN before anything is signed;
//      a preflight past its minute is read again, and the press goes on only if
//      what it says is what the customer read;
//   5. the follow-up (trackIntentsWithdraw), which settles the journal as it goes.
//
// 🔴 A lost reply is "not confirmed": never offered again, never sent again; the
// ledger settles it by reads. An error never moves the sheet to Normal.
//
// Every outside call comes through `deps` (PRIVATE_WITHDRAW_DEPS by default), so
// the Node suite and the DEV preview drive the same hooks with fakes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readPrivateModeProbe } from "../../lib/intents/client.js";
import { clampPrivateLimits } from "../../lib/intents/config.js";
import {
  quoteIntentsWithdraw, readWithdrawPreflight, executeIntentsWithdraw, privateWithdrawReview, DEFAULT_PRIVATE_WITHDRAW_ROUTE_ID,
} from "../../lib/intents/withdraw.js";
import { createWithdrawJournal } from "../../lib/intents/withdrawJournal.js";
import { trackIntentsWithdraw, settleFromReads } from "../../lib/intents/withdrawStatus.js";
import { privateWithdrawSignWords } from "../../lib/signCopy.js";
import { privateWithdrawRouteFor, privateWithdrawAmountOf, privateWithdrawDestinationOf, IN_FLIGHT_STATES } from "./privateWithdrawView.js";

/** The outside world, injectable. Nothing in it signs: the one signature is the backend's sendIntentsDeposit. */
export const PRIVATE_WITHDRAW_DEPS = Object.freeze({
  readProbe: readPrivateModeProbe,
  quote: quoteIntentsWithdraw,
  preflight: readWithdrawPreflight,
  execute: executeIntentsWithdraw,
  track: trackIntentsWithdraw,
  settle: settleFromReads,
  journal: (user, o = {}) => createWithdrawJournal({ user, ...o }),
  now: () => Date.now(),
});

/** How long typing must pause before a dry quote is asked for (the Deposit's figure). */
export const DRY_QUOTE_DEBOUNCE_MS = 600;
/** How often an unsettled private withdrawal is read again while the sheet is open. */
export const SETTLE_EVERY_MS = 30_000;
/** Records older than this are not followed by the sheet any more (the journal still blocks until a deadline). */
export const LEDGER_WINDOW_MS = 4 * 24 * 3600_000;

const lc = (a) => String(a).toLowerCase();
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const IDLE = Object.freeze({ key: null, status: "idle", data: null, error: null });
const REVIEW_IDLE = Object.freeze({ key: null, status: "idle", quote: null, preflight: null, error: null, requoted: false, typed: null, ask: null });
const SEND_IDLE = Object.freeze({ phase: "idle", result: null });

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * This wallet's journal and what the sheet must say about it.
 * @returns {{ journal: object|null, records: object[], unsettled: object[], inFlight: object[], checking: boolean,
 *   recheck: () => void, refresh: () => void }}
 */
export function usePrivateWithdrawLedger({ user, deps = PRIVATE_WITHDRAW_DEPS, limits = null } = {}) {
  const cap = clampPrivateLimits(limits).maxDayUsdc;
  const who = user ? lc(user) : null;
  const journal = useMemo(() => (who ? safe(() => deps.journal(who, { dayCapUsdc: cap }), null) : null), [who, cap, deps]);
  const [version, bump] = useState(0);
  const refresh = useCallback(() => bump((n) => n + 1), []);
  const [round, setRound] = useState(0);
  const recheck = useCallback(() => setRound((n) => n + 1), []);
  const [checking, setChecking] = useState(false);

  const now = deps.now();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const records = useMemo(() => (journal ? safe(() => journal.list(), []) : []), [journal, version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const unsettled = useMemo(() => (journal ? safe(() => journal.unsettled(now), []) : []), [journal, version]);
  const inFlight = records.filter((r) => IN_FLIGHT_STATES.includes(r.state) && now - r.createdAt < LEDGER_WINDOW_MS);

  /* On open, and on every look again: settle what is still in flight, from reads only. */
  useEffect(() => {
    if (!journal || !who) return undefined;
    const t = deps.now();
    const todo = safe(() => journal.list(), []).filter((r) => IN_FLIGHT_STATES.includes(r.state) && t - r.createdAt < LEDGER_WINDOW_MS);
    if (!todo.length) return undefined;
    let live = true;
    setChecking(true);
    (async () => {
      for (const record of todo) {
        if (!live) return;
        try { await deps.settle({ journal, record, user: who }); } catch { /* unknown stays unknown */ }
      }
      if (live) { setChecking(false); bump((n) => n + 1); }
    })();
    return () => { live = false; setChecking(false); };
    // deps is one frozen object per sheet; round asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, who, round]);

  /* While something is unsettled, look again by itself. */
  const open = unsettled.length;
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(() => setRound((n) => n + 1), SETTLE_EVERY_MS);
    return () => clearInterval(t);
  }, [open]);

  return { journal, records, unsettled, inFlight, checking, recheck, refresh };
}

/**
 * One private withdrawal for `user` (the connected wallet: the quote's refundTo
 * and the only signer).
 *   probe              usePrivateProbe's answer (its confidentiality and limits, as given)
 *   active             the customer is on Private (nothing is read or asked for otherwise)
 *   withdrawableUsdc   the balance the screen shows (the preflight holds amount + fee to it)
 *   sendIntentsDeposit the backend's one visible signature (null: nothing can be reviewed)
 *   ledger             usePrivateWithdrawLedger's answer (the journal; an unsettled record blocks)
 *   initial            DEV preview only: { routeId, amountText, toText, auto: "review" | "confirm" }
 */
export function usePrivateWithdraw({
  user, walletType = null, probe, active = false, withdrawableUsdc = null, sendIntentsDeposit = null, ledger = null,
  deps = PRIVATE_WITHDRAW_DEPS, initial = null,
} = {}) {
  const ready = !!(active && user && probe && probe.enabled === true && probe.confidentiality);
  const rawLimits = probe ? probe.limits : null;
  const limits = useMemo(() => clampPrivateLimits(rawLimits), [rawLimits]);
  const confidentiality = probe ? probe.confidentiality : null;
  const [routeId, setRouteIdRaw] = useState((initial && initial.routeId) || DEFAULT_PRIVATE_WITHDRAW_ROUTE_ID);
  const [amountText, setAmountTextRaw] = useState((initial && initial.amountText) || "");
  const [toText, setToTextRaw] = useState((initial && initial.toText) || "");
  const route = privateWithdrawRouteFor(routeId);
  const withdrawable = fin(withdrawableUsdc) ? withdrawableUsdc : null;
  const amount = useMemo(() => privateWithdrawAmountOf(amountText, { limits, withdrawableUsdc: withdrawable }), [amountText, limits, withdrawable]);
  const dest = useMemo(() => privateWithdrawDestinationOf(toText, route, { own: user, walletType }), [toText, route, user, walletType]);
  const journal = ledger ? ledger.journal : null;
  const blocked = !!(ledger && ledger.unsettled && ledger.unsettled.length);
  const canSign = typeof sendIntentsDeposit === "function";

  const [stage, setStage] = useState("form"); // form | review | result
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = useRef(false);

  /* What every quote is asked for; an answer for another ask is never shown under this one's name. */
  const askKey = ready && route && amount.ok && dest.ok
    ? `${lc(user)}|${route.id}|${amount.units}|${dest.address}|${confidentiality}|${limits.withdrawMinUsdc}/${limits.maxTxUsdc}/${limits.maxDayUsdc}`
    : null;
  const ask = askKey ? { user, recipient: dest.address, route, amountUsdc: amount.hl, confidentiality, limits } : null;

  /* 2. The dry quote, after typing pauses (not while a withdrawal is unsettled: nothing new may start). */
  const [dry, setDry] = useState(IDLE);
  const [dryRound, retryDry] = useState(0);
  useEffect(() => {
    if (!askKey || stage !== "form" || blocked) return undefined;
    let live = true;
    const key = askKey;
    const t = setTimeout(() => {
      setDry({ key, status: "loading", data: null, error: null });
      deps.quote({ ...ask, dry: true }).then(
        (data) => { if (live) setDry({ key, status: "ready", data, error: null }); },
        (error) => { if (live) setDry({ key, status: "error", data: null, error }); },
      );
    }, DRY_QUOTE_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
    // askKey carries every input of ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, dryRound, stage, blocked]);
  const quote = askKey && dry.key === askKey ? dry : askKey ? { key: askKey, status: "waiting", data: null, error: null } : IDLE;

  /* 3. The review: the REAL quote and its preflight, only on the customer's press. */
  const [rev, setRev] = useState(REVIEW_IDLE);
  const [send, setSend] = useState(SEND_IDLE);
  const canReview = !!(askKey && stage === "form" && !blocked && canSign && journal && quote.status === "ready" && rev.status !== "loading");

  const realReview = useCallback(async (a, typed, key) => {
    const q = await deps.quote({ ...a, dry: false, journal });
    const pf = await deps.preflight({ quote: q, withdrawableUsdc: withdrawable == null ? undefined : withdrawable });
    return { key, status: "ready", quote: q, preflight: pf, error: null, requoted: false, typed, ask: a };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, withdrawable]);

  const review = useCallback(async () => {
    if (!canReview || busy.current) return;
    busy.current = true;
    const key = askKey;
    const a = ask;
    const typed = String(amountText).trim();
    setSend(SEND_IDLE);
    setRev({ ...REVIEW_IDLE, key, status: "loading", typed, ask: a });
    setStage("review");
    try {
      const next = await realReview(a, typed, key);
      if (mounted.current) setRev(next);
    } catch (error) {
      /* Back to the form, the refusal shown there; Private stays. */
      if (mounted.current) { setRev({ ...REVIEW_IDLE, key, status: "error", error, typed, ask: a }); setStage("form"); }
    } finally {
      busy.current = false;
      if (ledger) ledger.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview, askKey, amountText, realReview]);

  /* The clock, while the review is on screen: a quote has a minute (withdraw.js WITHDRAW_QUOTE_TTL_MS). */
  const [now, setNow] = useState(() => deps.now());
  const reviewing = stage === "review" && rev.status === "ready";
  useEffect(() => {
    if (!reviewing) return undefined;
    setNow(deps.now());
    const t = setInterval(() => setNow(deps.now()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewing]);
  const reviewView = rev.status === "ready" && rev.quote ? safe(() => privateWithdrawReview({ quote: rev.quote, preflight: rev.preflight, now }), null) : null;

  /* 4. Confirm: one visible signature, or — when the figures are out of date — new ones, SHOWN first. */
  const confirm = useCallback(async () => {
    if (busy.current || rev.status !== "ready" || !rev.quote) return;
    if (send.phase === "signing" || send.phase === "refreshing" || send.phase === "sent" || send.phase === "unknown") return;
    let q = rev.quote;
    let pf = rev.preflight;
    let rv = safe(() => privateWithdrawReview({ quote: q, preflight: pf, now: deps.now() }), null);
    if (!rv) return;
    busy.current = true;
    try {
      if (rv.why === "stale" || (send.phase === "error" && send.result && send.result.nothingSent)) {
        /* A new quote is a new one-time address: priced, checked and SHOWN before anything is signed. */
        setSend({ phase: "refreshing", result: null });
        const next = await realReview(rev.ask, rev.typed, rev.key);
        if (!mounted.current) return;
        setRev({ ...next, requoted: true });
        setSend(SEND_IDLE);
        return;
      }
      if (rv.why === "recheck") {
        setSend({ phase: "refreshing", result: null });
        const p2 = await deps.preflight({ quote: q, withdrawableUsdc: withdrawable == null ? undefined : withdrawable });
        if (!mounted.current) return;
        const same = !!(p2 && p2.ok === true && pf && p2.accountFeeUsdc === pf.accountFeeUsdc);
        setRev((r) => ({ ...r, preflight: p2, requoted: r.requoted || !same }));
        if (!same) { setSend(SEND_IDLE); return; }
        pf = p2;
        rv = safe(() => privateWithdrawReview({ quote: q, preflight: pf, now: deps.now() }), null);
      }
      if (!rv || !rv.confirmable) { setSend(SEND_IDLE); return; }
      setSend({ phase: "signing", result: null });
      const r = await deps.execute({
        quote: q, preflight: pf, journal, sendIntentsDeposit, amountUsdc: rev.typed,
        signWords: privateWithdrawSignWords({ quote: q, review: rv }),
      });
      if (!mounted.current) return;
      if (r && r.ok === true) { setSend({ phase: "sent", result: r }); setStage("result"); }
      else if (r && r.notConfirmed) { setSend({ phase: "unknown", result: r }); setStage("result"); }
      else setSend({ phase: "error", result: r || { ok: false, code: "unexpected", message: "Nothing was sent.", nothingSent: true } });
    } catch (error) {
      /* Only a re-quote or a re-read can throw here (the executor never does): nothing was signed. */
      if (mounted.current) setSend({ phase: "error", result: { ok: false, code: error && error.code, message: error && error.message, error, nothingSent: true, before: true } });
    } finally {
      busy.current = false;
      if (ledger) ledger.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, send.phase, send.result, journal, sendIntentsDeposit, withdrawable, realReview]);

  /* A preflight that could not read something (or refused) is read again on the customer's press: reads only, the
     same one-time address. */
  const recheck = useCallback(async () => {
    if (busy.current || rev.status !== "ready" || !rev.quote || send.phase === "sent" || send.phase === "unknown") return;
    busy.current = true;
    setSend({ phase: "refreshing", result: null });
    try {
      const p2 = await deps.preflight({ quote: rev.quote, withdrawableUsdc: withdrawable == null ? undefined : withdrawable });
      if (mounted.current) { setRev((r) => ({ ...r, preflight: p2 })); setSend(SEND_IDLE); }
    } catch (error) {
      if (mounted.current) setSend({ phase: "error", result: { ok: false, code: error && error.code, message: error && error.message, nothingSent: true, before: true } });
    } finally {
      busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, send.phase, withdrawable]);

  /* 5. The follow-up, once the money step ended sent or not confirmed. */
  const [snapshot, setSnapshot] = useState(null);
  const sentAddress = (send.phase === "sent" || send.phase === "unknown") && rev.quote ? rev.quote.depositAddress : null;
  useEffect(() => {
    if (!sentAddress) return undefined;
    const q = rev.quote;
    let live = true;
    const h = deps.track({
      depositAddress: sentAddress,
      expect: { user: q.user, routeId: q.routeId, amountRaw: q.amountRaw, recipient: q.recipient },
      journal,
      onUpdate: (s) => { if (live) { setSnapshot(s); if (ledger) ledger.refresh(); } },
    });
    return () => { live = false; try { h && h.stop(); } catch { /* gone */ } };
    // the tracker follows one address for as long as the sheet shows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentAddress]);
  const journalState = sentAddress && journal ? safe(() => { const r = journal.get(sentAddress); return r ? r.state : null; }, null) : null;

  /* The DEV preview's "already pressed" (initial.auto): once, when its moment comes. */
  const auto = useRef({ review: false, confirm: false });
  useEffect(() => {
    if (!initial || !initial.auto || auto.current.review || !canReview) return;
    auto.current.review = true;
    review();
  }, [canReview]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!initial || initial.auto !== "confirm" || auto.current.confirm || rev.status !== "ready") return;
    auto.current.confirm = true;
    confirm();
  }, [rev.status]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The toggle and Edit hold still while a withdrawal is priced, signed — or FOLLOWED (sent / not confirmed), as
     Normal's do while its Relay withdrawal is followed: a tap to Normal would drop the live follow-up. */
  const locked = rev.status === "loading" || send.phase === "signing" || send.phase === "refreshing" || send.phase === "sent" || send.phase === "unknown";
  /* Back to the form (the reserved one-time address is simply never paid), optionally with a new amount
     ("Withdraw 19.50 USDC instead"). */
  const edit = useCallback((nextAmountText) => {
    if (busy.current || send.phase === "sent" || send.phase === "unknown") return;
    setStage("form");
    setRev(REVIEW_IDLE);
    setSend(SEND_IDLE);
    if (typeof nextAmountText === "string") setAmountTextRaw(nextAmountText);
  }, [send.phase]);
  const inForm = stage === "form" && !locked;

  return {
    ready,
    limits,
    stage,
    route,
    routeId: route ? route.id : null,
    setRouteId: (id) => { if (inForm) setRouteIdRaw(id); },
    amountText,
    setAmountText: (t) => { if (inForm) setAmountTextRaw(t); },
    toText,
    setToText: (t) => { if (inForm) setToTextRaw(t); },
    amount,
    dest,
    blocked,
    canSign,
    askKey,
    quote: { ...quote, retry: () => retryDry((n) => n + 1) },
    canReview,
    review,
    reviewState: rev,
    reviewView,
    now,
    confirm,
    recheck,
    send,
    locked,
    edit,
    snapshot,
    journalState,
  };
}
