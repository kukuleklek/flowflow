// The last step of a first deposit, as a state and a sentence.
// ─────────────────────────────────────────────────────────────────────────────
//
// On the first-deposit plan the money lands in the customer's OWN wallet on the
// way in (lib/relay/firstDeposit.js), and their own wallet moves it the rest of
// the way (lib/relay/arbitrumBridge.js). This file is the little machine in
// between: what state that move is in, whether it may start by itself, and the
// one line the customer reads while it happens. The move itself is made by ONE
// runner per tab (perp/deposit/perpFunding.js), which the Deposit panel and the
// app-wide mover both drive, so there is one move and one sentence about it.
//
// 🔴 THE RULES IT EXISTS TO KEEP
//
//   1. NEVER TWO SIGNATURES FOR ONE LANDING. The attempt is written down BEFORE
//      it is signed, so an app that dies between the signature and the answer
//      still comes back knowing it tried. A wallet with a written attempt that
//      the chain has not shown to be finished is never moved automatically
//      again — it is OFFERED, with a button, and the customer decides. That is
//      what "nothing is retried twice" has to mean when the thing being retried
//      can move money. An attempt is finished only by the chain: the balance
//      read at 0 or below what the attempt moved, or the transfer's own receipt
//      saying it was mined and did what it said (perpFunding's settleRecord).
//   2. MONEY THAT IS THERE MOVES BY ITSELF, on every deposit chain, whether or
//      not anybody watched it land. Owner, 2026-10-15: "ทำไมเงิน ไม่ Move To
//      Account แบบ Auto วะ ทุกเชนเลย ทำไมคนต้องมากดเองวะ" / "มันมีเส้นทางที่ไม่ต้อง
//      เสีย 1.22". The money in this wallet on this chain is the customer's own
//      deposit one hop short of their Perp account: the app holds no key export,
//      so the only place it can ever go is that account, and making the customer
//      press for it was the app asking permission to finish their own deposit.
//      Any balance at or above the floor, with no unresolved attempt, is "auto".
//      This REPLACES the old rule ("automatic only for an arrival we watched").
//      What did not change: it is the customer's own embedded wallet, signed in
//      with Privy, with the no-window sender present — nothing else moves by
//      itself — and the one transfer it may sign is built and checked in
//      lib/relay/arbitrumBridge.js and again in the Privy bridge.
//   3. AN UNREAD BALANCE IS NOT AN EMPTY ONE. A balance that could not be read
//      shows nothing at all, never a zero and never a figure (MONEY_RULES
//      section 0), and nothing moves on it. The only figures here come from the
//      chain.
//   4. BELOW THE FLOOR, THE MONEY IS NOT TOUCHED and the screen says where it
//      is and what to do. Money sent into the deposit contract below the floor
//      is not credited and not refunded, so this state is a stop, not a warning.
//
// No React, no network, no signer: a storage object and plain values in, a step
// and a sentence out. Tested in Node.

import { DASH } from "../../lib/format.js";
import { BRIDGE_MIN_USDC, BRIDGE_MIN_RAW } from "../../lib/relay/arbitrumBridge.js";

/** One record per wallet: the attempt it has already made, if any. */
export const MOVE_RECORD_PREFIX = "flowflow.perpFirstMove.v1:";

export function moveRecordKey(user) {
  return `${MOVE_RECORD_PREFIX}${String(user).toLowerCase()}`;
}

/** localStorage when the browser allows it; null in private mode and in Node. */
export function moveStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a, b) => isAddr(a) && isAddr(b) && a.toLowerCase() === b.toLowerCase();

/** The attempt written down for this wallet, or null. A foreign record is ignored. */
export function readMoveRecord(storage, user) {
  if (!storage || !isAddr(user)) return null;
  let raw = null;
  try { raw = storage.getItem(moveRecordKey(user)); } catch { return null; }
  if (!raw) return null;
  let r = null;
  try { r = JSON.parse(raw); } catch { return null; }
  if (!r || typeof r !== "object" || r.v !== 1 || !same(r.user, user)) return null;
  return r;
}

/** Write the attempt down. Returns the record as it was stored. */
export function writeMoveRecord(storage, { user, address, raw = null, txHash = null, at = null } = {}) {
  const rec = {
    v: 1,
    user: String(user).toLowerCase(),
    address: isAddr(address) ? address.toLowerCase() : null,
    raw: typeof raw === "string" ? raw : null,
    txHash: typeof txHash === "string" ? txHash : null,
    at: Number.isFinite(at) ? at : null,
  };
  if (!storage) return rec;
  /* Storage may refuse (full, blocked, private mode). The runner keeps its own
     copy of every record it writes (perpFunding's recWrite), so a refused write
     here never makes an attempt disappear from the tab that made it. */
  try { storage.setItem(moveRecordKey(user), JSON.stringify(rec)); } catch { /* the runner's own copy holds it */ }
  return rec;
}

export function clearMoveRecord(storage, user) {
  if (!storage || !isAddr(user)) return;
  try { storage.removeItem(moveRecordKey(user)); } catch { /* nothing to clear */ }
}

/**
 * Where the move stands.
 *
 *   raw         the wallet's own balance on the landing chain, in base units,
 *               read from the chain; null when it could not be read
 *   record      an attempt written down for this wallet that the chain has not
 *               shown to be finished, or null
 *   sending     an attempt is in flight right now
 *   sentUsdc    an attempt succeeded in this session (the figure it moved)
 *   failed      the last attempt in this session came back refused
 *   canAuto     can this wallet make the move by itself right now (its
 *               no-window sender is there)? Without it the money is OFFERED
 *
 * One of: idle (nothing to show), short (there, under the floor), auto (moves by
 * itself), offer (there, but this wallet cannot move it by itself just now),
 * again (an unresolved attempt: waiting for a press), sending, sent, failed.
 *
 * 🔴 NO "WATCHED" ANY MORE (rule 2). Whether this session saw the money land
 * used to decide whether it moved by itself; it does not. Only an attempt
 * already written down, a refusal, or a wallet that cannot sign by itself puts
 * a button between the customer's money and their Perp account.
 */
export function moveStep({ raw = null, record = null, sending = false, sentUsdc = null, failed = false, canAuto = true } = {}) {
  if (sending) return "sending";
  if (typeof sentUsdc === "number" && Number.isFinite(sentUsdc)) return "sent";
  if (typeof raw !== "bigint" || raw <= 0n) return "idle";
  if (raw < BRIDGE_MIN_RAW) return "short";
  if (failed) return "failed";
  if (record) return "again";
  return canAuto ? "auto" : "offer";
}

/** Only one step ever starts a transfer without being asked. */
export function moveRunsItself(step) {
  return step === "auto";
}

/** Is this step one the customer can press? */
export function moveCanPress(step) {
  return step === "offer" || step === "again" || step === "failed";
}

/** "24.897110 USDC", or the dash when the figure is not in hand. */
export function moveAmountText(usdc) {
  if (typeof usdc !== "number" || !Number.isFinite(usdc) || usdc < 0) return DASH;
  return `${usdc.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;
}

/**
 * The line the customer reads, and the button if the step has one:
 * { text, action } — both null on a step with nothing to say.
 *
 *   code             why the last attempt came back refused, when it said
 *   sameAddressJoins would a deposit to the address on screen land in this same
 *                    wallet and join this money? True only on the plan whose
 *                    address does (perp/deposit's planIsFirstHop).
 *
 * NO PROVIDER, NO VENUE, NO PLUMBING (owner, 2026-09-23 / 2026-09-27). These
 * sentences are about the customer's money and where it is. The landing network
 * is named in exactly the states where their money is sitting there and they
 * may need to act on it — that is not jargon, it is the address they can look at.
 */
export function moveLines(step, { usdc = null, minInputUsdc = null, landing = "", code = null, sameAddressJoins = false } = {}) {
  const amount = moveAmountText(usdc);
  const none = { text: null, action: null };
  const here = `${amount} is in your own wallet on ${landing}.`;
  if (step === "sending" || step === "auto") return { text: `Moving ${amount} into your Perp account…`, action: null };
  if (step === "sent") return { text: `${amount} is on its way to your Perp account.`, action: null };
  if (step === "offer") return { text: here, action: "Move it into your Perp account" };
  if (step === "again") return { text: here, action: "Move it into your Perp account" };
  if (step === "failed") {
    /* 🔴 AN EMPTY GAS TANK IS NOT A REFUSED SIGNATURE, and the button that would
       fix one cannot fix the other. The hop is paid for out of the native gas
       the route delivers beside the money; with none of it at that address the
       screen says so, because "it didn't go through" sends a customer round a
       loop that can never close (lib/relay/arbitrumBridge's no-gas). */
    const why = code === "no-gas"
      ? ` Moving it needs a little ${landing} gas there, and there is none yet.`
      : " The move didn't go through.";
    return { text: `${here}${why}`, action: "Try the move again" };
  }
  if (step === "short") {
    /* 🔴 ONE SENTENCE PER PLAN, BECAUSE ONE OF THEM POINTS AT AN ADDRESS. Money
       under the floor is found and reported on EVERY plan, but a deposit to the
       address on screen joins it only on the plan whose address lands in this
       very wallet. On the other one the same words would send the customer's
       next deposit straight into their Perp account, leave this money where it
       is, and never let it out — so that plan is told what is true instead: what
       it takes, and that the money waits until it is there. */
    if (sameAddressJoins) {
      const more = Number.isFinite(minInputUsdc) && minInputUsdc > 0 ? ` — at least ${minInputUsdc} USDC —` : "";
      return {
        text: `${here} It takes ${BRIDGE_MIN_USDC} USDC to move into your Perp account. Send another deposit to the same address${more} and it all moves together.`,
        action: null,
      };
    }
    return {
      text: `${here} It takes ${BRIDGE_MIN_USDC} USDC to move into your Perp account, so it waits until that wallet holds ${BRIDGE_MIN_USDC} USDC.`,
      action: null,
    };
  }
  return none;
}
