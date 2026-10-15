// The Private Deposit sheet's hooks, over lib/intents (1Click through our proxies)
// and the app's one deposit watch.
// ─────────────────────────────────────────────────────────────────────────────
//
// usePrivateProbe: what the server offers right now ({ enabled, confidential,
// confidentiality, limits }), read ONCE when the sheet opens (a GET, no key, no
// quote). Anything but a clear "on" hides the toggle (client.js
// readPrivateModeProbe). `reread()` asks again — after a confidentiality-mismatch
// or a private-mode-off answer, so the label on screen is the server's.
//
// usePrivateDeposit: one private deposit, in the order the customer meets it:
//   1. the plan, chosen ONCE per open (choosePrivatePlan: private-arb only for an
//      in-app wallet whose ETH on Arbitrum was read and clears the hop), and then
//      held: the address is bound to it;
//   2. the amount and the network, each refused in plain words before anything
//      leaves (privateAmountOf, the offered routes only);
//   3. a DRY quote while typing (debounced; no address is reserved by it);
//   4. the address, only on the customer's own press of "Get address" (a non-dry
//      quote reserves a real one-time address), shown until its showUntil and
//      then hidden for good; inputs change → the address is dropped from screen
//      (and `dropped` says once: don't send to the previous one);
//   5. the watch: the address is held on depositWatch with provider "near" for
//      as long as the sheet has it (shown, used or expired), so the Pending
//      popup and the strip follow it after the sheet closes and the sheet keeps
//      its rows under any later message; the moment the watch shows ANY row for
//      it, the address is USED: the saved one is forgotten
//      (forgetPrivateDepositAddress) and the screen stops offering it (no QR, no
//      copy, no countdown), so it is never sent to twice.
//
// The plan's gas read is kept (gasWei): on Arbitrum it decides what the screen may
// promise about a refund (privateDepositView arbitrumRefundPath → refundPath).
//
// 🔴 Errors stay on Private (privateDepositView's reducer). Every async answer is
// keyed and checked against the inputs it was asked for, and nothing lands after
// unmount. No hook signs, sends or holds a key.
//
// Every outside call comes through `deps` (PRIVATE_DEPS by default), so the
// Node suite and the DEV preview drive the same hook with fakes.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { readPrivateModeProbe } from "../../lib/intents/client.js";
import { PRIVATE_LIMITS } from "../../lib/intents/config.js";
import { DEFAULT_PRIVATE_ROUTE_ID } from "../../lib/intents/assets.js";
import {
  choosePrivatePlan, quotePrivateDeposit, getPrivateDepositAddress, forgetPrivateDepositAddress, privatePlanById,
  PRIVATE_CORE_PLAN_ID,
} from "../../lib/intents/deposit.js";
import { readStrandedUsdc, quoteRecover, executeRecover, createRecoverJournal, readPermitUsed, recoverSigner, onRecoverSigner } from "../../lib/relay/recoverStranded.js";
import { depositWatch, sheetTrackView } from "./depositWatch.js";
import { privateAmountOf, privateRouteFor, addressVisible, addressUsed, arbitrumRefundPath } from "./privateDepositView.js";

/** The outside world, injectable. */
export const PRIVATE_DEPS = Object.freeze({
  readProbe: readPrivateModeProbe,
  choosePlan: choosePrivatePlan,
  quote: quotePrivateDeposit,
  getAddress: getPrivateDepositAddress,
  forget: forgetPrivateDepositAddress,
  watch: depositWatch,
  now: () => Date.now(),
});

/** How long typing must pause before a dry quote is asked for. */
export const DRY_QUOTE_DEBOUNCE_MS = 600;

const PROBE_LOADING = Object.freeze({ status: "loading", enabled: false, confidential: false, confidentiality: null, limits: PRIVATE_LIMITS });

export function usePrivateProbe({ enabled = true, deps = PRIVATE_DEPS } = {}) {
  const [probe, setProbe] = useState(PROBE_LOADING);
  const [round, reread] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    deps.readProbe().then(
      (p) => { if (live) setProbe({ status: "ready", ...p }); },
      () => { if (live) setProbe({ ...PROBE_LOADING, status: "ready" }); },
    );
    return () => { live = false; };
    // deps is a frozen object per sheet; round re-asks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, round]);
  return { ...probe, reread: useCallback(() => reread((n) => n + 1), []) };
}

const IDLE = Object.freeze({ key: null, status: "idle", data: null, error: null });

/**
 * One private deposit for `user` (the connected wallet; recipient = refundTo).
 *   probe     usePrivateProbe's answer (its confidentiality and limits are used as given)
 *   active    the customer is on Private (nothing is read or asked for otherwise)
 *   onError   the reducer's "error" (the sheet shows it and stays on Private)
 */
export function usePrivateDeposit({ user, walletType = null, probe, active = false, deps = PRIVATE_DEPS, recoverReady, initial = null } = {}) {
  const ready = !!(active && user && probe && probe.enabled === true && probe.confidentiality);
  const limits = (probe && probe.limits) || PRIVATE_LIMITS;
  const confidentiality = probe ? probe.confidentiality : null;
  const [routeId, setRouteId] = useState((initial && initial.routeId) || DEFAULT_PRIVATE_ROUTE_ID);
  const [amountText, setAmountText] = useState((initial && initial.amountText) || "");
  const route = privateRouteFor(routeId, recoverReady == null ? {} : { recoverReady });
  const amount = useMemo(() => privateAmountOf(route, amountText, limits), [route, amountText, limits]);

  /* 1. The plan, once per open and wallet, with the gas it was chosen on. */
  const [planState, setPlanState] = useState({ user: null, planId: null, gasWei: null });
  const who = user ? String(user).toLowerCase() : null;
  useEffect(() => {
    if (!ready || planState.user === who) return undefined;
    let live = true;
    deps.choosePlan({ owner: user, walletType }).then(
      (r) => { if (live) setPlanState({ user: who, planId: (r && r.planId) || PRIVATE_CORE_PLAN_ID, gasWei: r && typeof r.gasWei === "bigint" ? r.gasWei : null }); },
      () => { if (live) setPlanState({ user: who, planId: PRIVATE_CORE_PLAN_ID, gasWei: null }); },
    );
    return () => { live = false; };
    // the plan is held for the open: it is asked once per wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, who]);
  const planId = planState.user === who ? planState.planId : null;
  const plan = planId ? privatePlanById(planId) : null;
  /* What an Arbitrum refund can promise (unknown until the plan is read: the careful words). */
  const refundPath = arbitrumRefundPath({ walletType, gasWei: planState.user === who ? planState.gasWei : null, planId });

  /* What every quote is asked for; an answer for another ask is never shown under this one's name. */
  const askKey = ready && plan && route && amount.amountRaw
    ? `${who}|${route.id}|${plan.id}|${amount.amountRaw}|${confidentiality}|${limits.depositMinUsdc}/${limits.maxTxUsdc}/${limits.maxDayUsdc}`
    : null;
  const ask = askKey ? { user, connected: user, route, plan, amountRaw: amount.amountRaw, confidentiality, limits } : null;

  /* 3. The dry quote, after typing pauses. */
  const [dry, setDry] = useState(IDLE);
  const [dryRound, retryDry] = useState(0);
  useEffect(() => {
    if (!askKey) return undefined;
    let live = true;
    const t = setTimeout(() => {
      setDry({ key: askKey, status: "loading", data: null, error: null });
      deps.quote(ask).then(
        (data) => { if (live) setDry({ key: askKey, status: "ready", data, error: null }); },
        (error) => { if (live) setDry({ key: askKey, status: "error", data: null, error }); },
      );
    }, DRY_QUOTE_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
    // askKey carries every input of ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, dryRound]);
  const quote = askKey && dry.key === askKey ? dry : askKey ? { key: askKey, status: "waiting", data: null, error: null } : IDLE;

  /* 4. The address: only on the customer's press. */
  const [addr, setAddr] = useState(IDLE);
  const [dropped, setDropped] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const getAddress = useCallback(() => {
    if (!askKey || addr.status === "loading") return;
    const key = askKey;
    setDropped(false);
    setAddr({ key, status: "loading", data: null, error: null });
    deps.getAddress(ask).then(
      (data) => { if (mounted.current) setAddr((a) => (a.key === key ? { key, status: "ready", data, error: null } : a)); },
      (error) => { if (mounted.current) setAddr((a) => (a.key === key ? { key, status: "error", data: null, error } : a)); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, addr.status]);
  const address = addr.key && addr.key === askKey ? addr : IDLE;
  /* Dropping an address the customer was shown says once: don't send to it (it may already be copied). */
  const wasShown = address.status === "ready";
  const clearAddress = useCallback(() => {
    if (wasShown) setDropped(true);
    setAddr(IDLE);
  }, [wasShown]);
  /* The DEV preview's "already pressed" (initial.press): once, when its ask is ready. */
  const pressed = useRef(false);
  useEffect(() => {
    if (!initial || !initial.press || pressed.current || !askKey) return;
    pressed.current = true;
    getAddress();
  }, [askKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The clock, while an address is on screen: the countdown, and the moment it hides. */
  const [now, setNow] = useState(() => deps.now());
  const showing = address.status === "ready";
  useEffect(() => {
    if (!showing) return undefined;
    setNow(deps.now());
    const t = setInterval(() => setNow(deps.now()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing]);
  const visible = showing && addressVisible(address.data, now);
  const expired = showing && !visible;
  /* The address the sheet holds (shown, used or expired): watched, and its rows drawn. */
  const depositAddress = showing && address.data.depositAddress ? address.data.depositAddress : null;

  /* 5. The watch: held while the sheet has the address (provider "near"). */
  const watch = deps.watch;
  const [since, setSince] = useState(null);
  const watchArgs = showing ? address.data.watch : null;
  useEffect(() => {
    if (!watchArgs || !user) return undefined;
    const h = watch.show({ user, address: watchArgs.address, routeId: watchArgs.routeId, planId: watchArgs.planId, provider: watchArgs.provider });
    setSince({ address: String(watchArgs.address).toLowerCase(), seq: h.seq });
    return () => { h.release(); setSince(null); };
  }, [watchArgs, user, watch]);
  const st = useSyncExternalStore(watch.subscribe, watch.getState, watch.getState);
  const track = sheetTrackView(st, depositAddress, depositAddress ? since : null);

  /* …and the saved address is forgotten the moment the watch sees it used. */
  const used = !!depositAddress && addressUsed(track.requests);
  const forgotten = useRef(null);
  useEffect(() => {
    if (!depositAddress || !addressUsed(track.requests)) return;
    if (forgotten.current === depositAddress) return;
    forgotten.current = depositAddress;
    try { deps.forget({ user, depositAddress }); } catch { /* the status check still refuses a used address */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositAddress, track.requests]);

  return {
    ready,
    planId,
    refundPath,
    route,
    routeId: route ? route.id : null,
    setRouteId: (id) => { setRouteId(id); setAddr(IDLE); },
    amountText,
    setAmountText: (t) => { setAmountText(t); },
    amount,
    quote: { ...quote, retry: () => retryDry((n) => n + 1) },
    /* visible: before showUntil; used: the watch saw a row (never offered again); dropped: say "don't send to the previous one". */
    address: { ...address, visible: visible && !used, expired, used, now },
    dropped,
    getAddress,
    clearAddress,
    track,
  };
}

/* ── Recover: USDC stranded on Base / Polygon, back into the Main Account ──── */

const JOURNAL = typeof window === "undefined" ? null : createRecoverJournal();

/** The injected Recover signer, as React state (PrivyBridge provides it; null until then). */
export function useRecoverSigner() {
  return useSyncExternalStore(onRecoverSigner, recoverSigner, recoverSigner);
}

/**
 * The stranded USDC and one move per chain. Reads only when `enabled` (Private
 * mode, PRIVATE_RECOVER_READY): one balanceOf per chain on open, and again after
 * a move. Pressing a row prices it (quote → verified review); confirm() signs
 * through the injected signer and posts (executeRecover). Never throws.
 */
export function useStrandedRecover({ user, enabled = false, deps = null } = {}) {
  const d = deps || { read: readStrandedUsdc, quote: quoteRecover, execute: executeRecover, used: readPermitUsed, journal: JOURNAL, signer: null };
  const injected = useRecoverSigner();
  const signer = d.signer !== undefined && d.signer !== null ? d.signer : injected;
  const [rows, setRows] = useState(null);
  const [round, reread] = useState(0);
  const [job, setJob] = useState({ chainId: null, status: "idle", review: null, result: null, error: null });
  /* The wallet connected NOW, read through the signing window: executeRecover's
     "is it still the same wallet?" must see a switch made after confirm began. */
  const own = useRef(user);
  own.current = user;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    if (!enabled || !user) { setRows(null); return undefined; }
    let ok = true;
    d.read({ own: user }).then((r) => { if (ok) setRows(r); }, () => { if (ok) setRows([]); });
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, user, round]);

  const price = useCallback((row) => {
    if (!row || !row.offered || job.status === "pricing" || job.status === "signing") return;
    setJob({ chainId: row.chainId, status: "pricing", review: null, result: null, error: null });
    d.quote({ own: user, chainId: row.chainId, amountRaw: row.raw.toString() }).then(
      (review) => { if (live.current) setJob({ chainId: row.chainId, status: "review", review, result: null, error: null }); },
      (error) => { if (live.current) setJob({ chainId: row.chainId, status: "error", review: null, result: null, error }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, job.status]);

  const confirm = useCallback(async () => {
    if (job.status !== "review" || !job.review) return;
    const review = job.review;
    setJob((j) => ({ ...j, status: "signing" }));
    const prev = d.journal ? d.journal.get(review.own, review.chainId) : null;
    const used = prev ? await d.used({ own: review.own, chainId: review.chainId, nonce: prev.nonce }) : null;
    const result = await d.execute({ review, ownNow: () => own.current, signTypedData: signer, journal: d.journal, used });
    if (!live.current) return;
    setJob({ chainId: review.chainId, status: result.ok ? "sent" : "failed", review, result, error: null });
    reread((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, user, signer]);

  const cancel = useCallback(() => setJob({ chainId: null, status: "idle", review: null, result: null, error: null }), []);
  /* A signer that names its wallet (PrivyBridge's does) signs only for that wallet: another one connected here reads as
     "can't sign this move here yet" before any press, rather than a window refused after it. */
  const canSign = typeof signer === "function"
    && (typeof signer.address !== "string" || (!!user && signer.address.toLowerCase() === String(user).toLowerCase()));
  return { rows, job, price, confirm, cancel, canSign, reread: () => reread((n) => n + 1) };
}
