// The Deposit sheet's hooks, over lib/relay/depositAddress.js and the account layer.
//
// usePerpDepositAddress: the deposit address for (wallet, route). The answer is
// keyed by BOTH, and an answer for another key is never handed back: a route
// switch shows "loading" until that route's own address is verified, never the
// previous route's address under the new route's name.
//
// useDepositTracker: the deposits reaching that address. The tracker is the
// app's one watch over it (perp/deposit/depositWatch.js), shared with the status
// strip: the sheet holds it while open, and it goes on for a while after the sheet
// closes so the strip can say where the money is. It parks itself when hidden.
//
// useDepositAccountNew: is the wallet's Hyperliquid address still new? The
// account layer's answer (usePerpAccount), true / false / null; it decides the
// first-deposit note and whether a fee priced with the activation may show.
//
// useDepositPlan: which plan this wallet's deposit is quoted on — the direct one
// or the first-deposit one whose last hop the wallet makes itself. It is the
// account layer's answer and the wallet's own kind, read together
// (perpDepositView's depositPlanFor), and it is FROZEN for as long as the sheet
// stays open: a deposit address is something people copy into an exchange, and
// one that changes while they are looking at it is its own kind of loss. The
// freeze is dropped when the sheet closes, so the next open reads the world
// again — which is how a wallet that has just finished its first deposit gets
// the cheaper direct address the moment it comes back. Waiting for that answer
// has an end (PLAN_DEADLINE_MS): the address waits for the plan, so a question
// nobody ever answers would otherwise leave this sheet with no address in it.
//
// useDepositSizes: what the SAME deposit would cost at the other sizes, for the
// breakdown in the Fee tile. It asks for nothing at all until it is enabled —
// which is the customer having pressed the control, never the sheet opening —
// and each size that lands is reported on its own, so a row with no answer yet
// stays unknown instead of waiting for the slowest one.
//
// useDepositFee: the fee the Estimate prints, AND the plan's own smallest
// deposit, because a re-price replaces both and the two may never be shown from
// different answers. When the saved fee is out of date
// (past its hour, priced with the activation for an account that now exists,
// or older than a credited deposit), it asks the lib to re-price it ONCE for
// the address on screen, and shows the dash until the new figure is in. The
// address itself never changes here.
//
// No hook signs, sends or holds a key; the lib only reads Relay's API.

import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { repriceDepositFee, DIRECT_PLAN } from "../../lib/relay/depositAddress.js";
import { depositWatch, sheetTrackView } from "./depositWatch.js";
import { getDepositAddressForPlan, FIRST_HOP_PLAN } from "../../lib/relay/firstDeposit.js";
import { priceDepositSizes, isRateLimited } from "../../lib/relay/depositSizes.js";
import { usePerpAccount } from "../../lib/hyperliquid/account/usePerpAccount.js";
import { perpAccountIsNew, depositFeeView, repriceReason, depositPlanFor, planIsFirstHop, depositFeeForDisplay, depositSizeNote } from "./perpDepositView.js";

const IDLE = Object.freeze({ key: null, status: "idle", data: null, error: null });

export function usePerpDepositAddress({ user, connected, route, planId = null, enabled = true }) {
  /* The plan is part of the key: two plans are two destinations and two
     addresses, and one plan's answer is never shown under the other's name. */
  const key = enabled && user && connected && route && planId ? `${String(user).toLowerCase()}|${String(connected).toLowerCase()}|${route.id}|${planId}` : null;
  const [answer, setAnswer] = useState(IDLE);
  const [attempt, retry] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    getDepositAddressForPlan({ user, connected, route, planId }).then(
      (data) => { if (live) setAnswer({ key, attempt, status: "ready", data, error: null }); },
      (error) => { if (live) setAnswer({ key, attempt, status: "error", data: null, error }); },
    );
    return () => { live = false; };
    // key carries user, connected, route.id and the plan; route objects come from one frozen table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  if (!key) return { ...IDLE, retry };
  /* Another key's answer, or the answer to an earlier attempt: this one is still loading. */
  if (answer.key !== key || answer.attempt !== attempt) return { key, status: "loading", data: null, error: null, retry };
  return { ...answer, retry };
}

export function useDepositTracker({ depositAddress, user, enabled = true, routeId = null, planId = null, watch = depositWatch }) {
  const on = !!(enabled && depositAddress);
  /* Which look this open started from. A look from before the sheet opened is
     not one this sheet watched, so it never counts as the sheet's first answer
     (depositWatch's sheetTrackView). */
  const [since, setSince] = useState(null);

  useEffect(() => {
    if (!on) return undefined;
    const h = watch.show({ user, address: depositAddress, routeId, planId });
    setSince({ address: String(depositAddress).toLowerCase(), seq: h.seq });
    /* Forgotten on close, so a reopen never starts from the last open's look. */
    return () => { h.release(); setSince(null); };
  }, [on, depositAddress, user, routeId, planId, watch]);

  const st = useSyncExternalStore(watch.subscribe, watch.getState, watch.getState);
  return sheetTrackView(st, on ? depositAddress : null, on ? since : null);
}

export function useDepositAccountNew({ user, enabled = true }) {
  const snap = usePerpAccount(enabled && user ? user : null);
  return enabled && user ? perpAccountIsNew(snap, user) : null;
}

/* 🔴 HOW LONG THE SCREEN MAY HAVE NO ADDRESS ON IT AT ALL.
   The plan waits for the account layer, and the address waits for the plan, so
   a question that is never answered used to mean a Deposit sheet with no QR code
   in it for as long as the customer cared to look — and before any of this, an
   address always appeared. A read that FAILS already falls back on its own
   (accountAskFailed below), but not every silence is an error: a snapshot of
   another address answers nothing and reports nothing wrong, which is what the
   localhost view makes, and a question still in flight is not a failure either.
   So the wait has an end, and today's route stands in when it is reached.
   It is past one whole attempt at the account layer's own limit
   (lib/hyperliquid/info's 8s), because standing in EARLY would cost a brand-new
   account the one-time fee this plan exists to avoid, and that is the customer's
   money — where waiting a few seconds longer only costs them a few seconds. */
export const PLAN_DEADLINE_MS = 12000;

/* Has the account layer asked about THIS wallet and got nothing back? Not the
   same as "not yet": a read that failed must not hold the screen for ever. */
function accountAskFailed(snap, user) {
  if (!snap || typeof snap.address !== "string" || typeof user !== "string") return false;
  if (snap.address.toLowerCase() !== user.toLowerCase()) return false;
  const role = snap.role || {};
  return role.answered !== true && !!snap.error && snap.loading !== true;
}

/**
 * { accountNew, planId } for this wallet. planId is null while the answer that
 * decides it is still out, and once set it does not change until the sheet
 * closes (see the note at the top of this file). An answer that never comes runs
 * out of time after PLAN_DEADLINE_MS and today's route stands in, so this screen
 * always ends up with an address on it.
 */
export function useDepositPlan({ user, walletType = null, enabled = true, deadlineMs = PLAN_DEADLINE_MS }) {
  const snap = usePerpAccount(enabled && user ? user : null);
  const accountNew = enabled && user ? perpAccountIsNew(snap, user) : null;
  const [late, setLate] = useState(false);
  const who = user ? String(user).toLowerCase() : null;

  /* The wait starts again for each wallet and each open, and ends with the sheet:
     nothing here runs for a screen nobody is looking at. */
  useEffect(() => {
    setLate(false);
    if (!enabled || !who) return undefined;
    const t = setTimeout(() => setLate(true), deadlineMs);
    return () => clearTimeout(t);
  }, [enabled, who, deadlineMs]);

  const chosen = enabled && user
    ? depositPlanFor({ accountNew, walletType, accountFailed: accountAskFailed(snap, user) || late })
    : null;
  const held = useRef({ user: null, planId: null });
  if (!enabled || held.current.user !== who) held.current = { user: who, planId: null };
  if (chosen && !held.current.planId) held.current = { user: who, planId: chosen };
  return { accountNew, planId: held.current.planId };
}

/* One re-price per (wallet, route, address, the price it replaces). The answer
   is keyed, so one that lands after the sheet closed still serves the next
   open; a failed one is asked again on the next open, never in a loop. */
export function useDepositFee({ user, connected, route, data, accountNew = null, requests = [], enabled = true }) {
  const reason = enabled && data && route && user && connected ? repriceReason(data, { accountNew, requests }) : null;
  const at = data ? (Number.isFinite(data.pricedAt) ? data.pricedAt : data.quotedAt) : null;
  const key = reason ? `${String(user).toLowerCase()}|${route.id}|${String(data.depositAddress).toLowerCase()}|${at}` : null;
  const [priced, setPriced] = useState(null);
  const asked = useRef(null);

  useEffect(() => {
    if (!key || asked.current === key) return;
    asked.current = key;
    /* 🔴 THE SAME PLAN, OR THE FIGURE WOULD BE ANOTHER ROUTE'S. A re-price asks
       for a fresh quote to the same destination; asking the direct one for an
       address quoted the long way round would print a cost this deposit is not
       going to pay. The answer on screen says which plan it is, so that is what
       is asked again. */
    repriceDepositFee({
      user, connected, route,
      depositAddress: data.depositAddress,
      plan: planIsFirstHop(data.plan) ? FIRST_HOP_PLAN : DIRECT_PLAN,
    }).then(
      (value) => setPriced({ key, value }),
      () => { if (asked.current === key) asked.current = null; },
    );
    // key carries user, route.id, the address and the price it replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const fresh = priced && data && priced.key === key && priced.value.depositAddress === String(data.depositAddress).toLowerCase() ? priced.value : null;
  const shown = fresh ? { ...data, ...fresh, depositAddress: data.depositAddress, feeStale: false, repriced: true } : data;
  /* 🔴 THE PLAN'S OWN FLOOR COMES BACK WITH THE FEE, from the same answer. A
     re-price refreshes both, and the screen reads them both from here: a fresh
     fee printed beside an hour-old smallest-deposit figure is the one mismatch on
     this sheet that can cost somebody their money, because a deposit under the
     real floor arrives too small for the last hop to move at all. It is never
     withheld for its age (lib/relay/depositAddress's resultOf), only replaced. */
  const floor = shown && Number.isFinite(shown.minInputUsdc) ? shown.minInputUsdc : null;
  return { ...depositFeeView(shown, { accountNew, requests }), minInputUsdc: floor };
}

/* Nothing priced: not an empty list of rows, which reads as "all of them are
   unknown" and is exactly right. */
const NO_SIZES = Object.freeze({ key: null, rows: null });

/* 🔴 REFUSED FOR ASKING TOO FAST, SO NOT ASKED AGAIN AT ONCE. Measured
   2026-09-28 (the note in lib/relay/depositSizes.js): about 32 POSTs inside 25 s
   and every request was refused for the next four runs, recovering after a 90 s
   pause. A refusal for being too quick therefore parks the list for that pause —
   every route, not just the one refused, because it is one service and one
   budget. Without it, closing and re-pressing asks again straight away and is
   refused again, and the request this sheet cannot do without is asked down the
   same path: the customer's own deposit address. The rows keep their dash
   meanwhile and the list prices itself when the pause is over. */
const SIZES_COOLDOWN_MS = 90000;

/**
 * WHAT THE SAME DEPOSIT COSTS AT THE OTHER SIZES: { [size]: { fee, note } } for
 * every size that has landed, or null while none has.
 *
 *   planId   the plan the ANSWER on screen is on, never the one that was asked
 *            for: a customer whose cheap route fell back to the direct one is
 *            looking at direct figures, and the list must price what he is on
 *   enabled  the customer has pressed the control. 🔴 NOTHING IS ASKED FOR
 *            OTHERWISE, and that is the whole shape of this hook: eight quotes
 *            fired on every sheet open would be eight quotes nobody asked for,
 *            against an endpoint measured to start refusing at about 32 of them
 *            in 25 s (lib/relay/depositSizes.js).
 *   requests the crossings the tracker has seen at this address, the SAME list
 *            the headline's fee is read with: a row priced before a deposit was
 *            credited here is as out of date as the figure above it (the first
 *            deposit pays the one-time cost and the next one does not), so it is
 *            withheld with it rather than left printing the dearer ladder
 *
 * A fee is put through depositFeeForDisplay, the same funnel as the figure above
 * the list, so the gas top-up comes out of it on the plan that carries one and
 * the nominal row can be compared with the headline honestly. A refusal becomes
 * its own plain sentence (depositSizeNote) and its figure stays unknown — never
 * a 0, and never the last size's figure under this size's name.
 *
 * Changing the chain, the token or the plan changes the key, which drops every
 * row at once and prices the new route: figures for a route the customer has
 * just left are the one thing this list must never show.
 */
export function useDepositSizes({ user, connected, route, planId = null, requests = [], enabled = false }) {
  const key = enabled && user && connected && route && planId ? `${String(user).toLowerCase()}|${route.id}|${planId}` : null;
  const [got, setGot] = useState(NO_SIZES);
  /* Nothing is asked for again before this (SIZES_COOLDOWN_MS above). */
  const cool = useRef(0);

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    let stop = null;
    const start = () => {
      if (!live) return;
      stop = priceDepositSizes({
        user, connected, route,
        plan: planIsFirstHop(planId) ? FIRST_HOP_PLAN : DIRECT_PLAN,
        onSize: (size, quote, error) => {
          if (!live) return;
          if (isRateLimited(error)) cool.current = Date.now() + SIZES_COOLDOWN_MS;
          /* 🔴 THE ANSWER IS KEPT, NOT THE FIGURE READ OFF IT, because the
             reading is not a fact about the answer: it is withheld the moment a
             deposit is credited here, exactly as the headline's own is, and that
             happens while this list is on screen. Keeping the figure froze the
             pre-activation ladder beside a re-priced headline — a one-time cost
             already paid, printed on every row but the first. So the funnel runs
             where the row is read (below), with the crossings as they stand. */
          const row = { quote: quote || null, note: depositSizeNote(error) };
          setGot((prev) => (prev.key === key ? { key, rows: { ...prev.rows, [size]: row } } : { key, rows: { [size]: row } }));
        },
      });
    };
    /* Refused for asking too fast: the list waits out the pause, then prices. */
    const wait = cool.current - Date.now();
    const t = wait > 0 ? setTimeout(start, wait) : null;
    if (t == null) start();
    return () => { live = false; if (t != null) clearTimeout(t); if (stop) stop(); };
    // key carries the wallet, the route and the plan; route objects come from one frozen table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key || got.key !== key || !got.rows) return null;
  /* 🔴 THE SAME FUNNEL AS THE HEADLINE, with this row's own answer in it and the
     same crossings, so a row is withheld for the same reasons the figure above it
     is. An answer with no readable fee is unknown and says nothing, exactly as
     the Estimate's own is (MONEY_RULES: the dash, never 0). */
  const rows = {};
  for (const size of Object.keys(got.rows)) {
    const r = got.rows[size];
    rows[size] = { fee: r.quote ? depositFeeForDisplay(r.quote, requests) : null, note: r.note };
  }
  return rows;
}
