// The Deposit panel's last step, as a hook.
//
// On the first-deposit plan the money lands in the customer's own wallet on the
// landing chain and their own wallet moves it into their Perp account. That
// move is made by the tab's ONE runner (perp/deposit/perpFunding.js), which the
// app-wide mover (AutoMover.jsx) drives whether or not this panel is open. This
// hook is the panel's view of that same runner: it asks it to read when the
// panel opens and when a deposit lands, and it says what the runner says —
// there is no second, local move here that could disagree with it.
//
// Money at or above the floor moves BY ITSELF, whether or not this panel saw it
// land (firstDepositMove's rule 2, owner 2026-10-15). A button appears only for
// an attempt already written down and not yet shown finished by the chain, for a
// refusal, or while the wallet's no-window sender is not there yet.
//
// WHAT IT NEVER DOES
//   • it never builds a transaction: lib/relay/arbitrumBridge.js builds the one
//     transfer that may be signed, and refuses everything else;
//   • it never holds a key or a signer: the runner asks services/privy's
//     no-window sender, at the moment of the move;
//   • it never trusts a remembered figure: the amount moved is the balance read
//     at that moment, and a balance that could not be read shows nothing.
//
// The balance is read on opening, on every arrival the tracker reports, and once
// more after a move — never on a timer.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { FIRST_HOP_PLAN_ID, FIRST_HOP_LANDING } from "../../lib/relay/firstDeposit.js";
import { moveCanPress, moveLines } from "./firstDepositMove.js";
import { perpFunding, fundingStep } from "./perpFunding.js";

/**
 * Props
 *   user, connected   the wallet, which must be the same address
 *   planId            the plan the address on screen was quoted on
 *   canFinish         can this wallet sign the last hop by itself?
 *   depositAddress    the address on screen (written into the attempt)
 *   minInputUsdc      the plan's smallest deposit, for the short sentence
 *   requests          the tracker's rows, newest first: a newly credited row is
 *                     money landing, and is read for
 *   enabled           the panel is open
 *   sender            the no-window sender factory (tests; default: the runner's)
 *   funding           the runner (tests; default: the tab's one runner)
 *
 * 🔴 WHY IT LOOKS ON EVERY PLAN, NOT JUST THE FIRST-DEPOSIT ONE. A deposit
 * address lives for months and the panel tells the customer it is reusable, so a
 * customer who saved their first-deposit address in an exchange can send to it
 * again long after their account exists — and that money lands in their own
 * wallet on the landing chain, one hop short. An embedded wallet has no key
 * export, so the app is the only way that money reaches the Perp account, and
 * it now takes it there by itself on every plan.
 *
 * Returns { step, usdc, landing, text, action, canPress, code, run }.
 */
export function useFirstDepositMove({
  user, connected, planId, depositAddress,
  canFinish = false,
  minInputUsdc = null,
  requests = [],
  enabled = true,
  sender = null,
  funding = perpFunding,
}) {
  const on = !!(enabled && user && connected && depositAddress && canFinish);
  const st = useSyncExternalStore(funding.subscribe, funding.getState, funding.getState);

  const key = on ? `${String(user).toLowerCase()}|${String(depositAddress).toLowerCase()}` : null;
  const rows = Array.isArray(requests) ? requests : [];
  const landed = rows.find((r) => r && r.status === "credited") || null;
  /* A crossing that fills is money landing on the chain: read it then. Not a
     clock and not a baseline — nothing here decides by WHEN something landed
     any more, only by what the chain holds now. */
  const sig = landed ? `${landed.id}|${landed.updatedAt}` : "none";

  /* Read on opening and on each landing, and let the runner move what is there
     (it moves nothing below the floor, nothing unreadable, nothing with an
     unresolved attempt written down, and nothing twice). */
  useEffect(() => {
    if (!on) return;
    funding.check({ user, connected, auto: true, sender: sender || null });
    // key carries the wallet and the address; sig is the arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key, sig]);

  const run = useCallback(() => {
    if (!on) return Promise.resolve(null);
    return funding.run({ user, connected, auto: false, sender: sender || null, address: depositAddress });
    // key carries the wallet and the address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key, funding]);

  const f = on
    ? fundingStep(st, user, { canAuto: funding.canRun(user, sender || null) })
    : fundingStep(null, null);
  const step = f.step;
  const lines = moveLines(step, {
    usdc: f.usdc, minInputUsdc, landing: FIRST_HOP_LANDING, code: f.code,
    /* Only this plan's address lands in this wallet, so only its sentence may
       tell the customer that another deposit to it joins what is already here. */
    sameAddressJoins: planId === FIRST_HOP_PLAN_ID,
  });
  return {
    step,
    usdc: f.usdc,
    landing: FIRST_HOP_LANDING,
    text: lines.text,
    action: lines.action,
    canPress: moveCanPress(step),
    code: f.code,
    run,
  };
}
