// ─────────────────────────────────────────────────────────────────────────────
// A MONEY CARD'S STATE CHANGES, as plain functions: what useAvaxAction (src/avax/
// useAvaxMoney.js) does when the card's price is refreshed in the background, when
// Confirm is tapped, and when the flow watcher settles the run with evidence.
// PURE: no React, no env, no network. scripts/test-avax-fixes.mjs drives them.
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 THE RULES THESE HOLD
//   1. A WORSE BACKGROUND RE-QUOTE IS SAID ON SCREEN (owner AD-9.3: a worse price is
//      never signed without the card shown again for a new Confirm). The card's ~52 s
//      refresh may change its figures under a reader's eyes; when the new price costs
//      more, guarantees less, pays a higher network fee or needs another window
//      (money.js worse()), the card prints "The price changed…" above the new figures.
//   2. CONFIRM ACTS ONLY ON THE CARD ON SCREEN. The tap names the review it was drawn
//      with; a review that is not the current one (a refresh landed between the paint
//      and the tap) is refused — and for CONFIRM_SETTLE_MS after any figure changed,
//      Confirm waits, so a tap aimed at the old numbers cannot land on the new ones.
//   3. A SETTLED RUN'S STAGES SETTLE TOO: refunded leaves no spinner on "Arrive", and a
//      move in's gas top-up (not part of its order) is printed as it really came — or
//      said not to have come (src/avax/watchFlows.js rule 8).

import { gasNoteOf, settledProgress } from "./watchFlows.js";

/** After a refresh changed any figure, Confirm waits this long. */
export const CONFIRM_SETTLE_MS = 1_000;

export const PRICE_CHANGED_WORDS = "The price changed. Check the new figures before you confirm.";

const SETTLED_WORDS = Object.freeze({
  "move-in": "Arrived in your Spot Account.",
  "move-out": "Arrived in your Main Account.",
  stake: "In Aave.",
  unstake: "Back in your Spot Account.",
  swap: "Swapped.",
});

/** Did any printed figure (a row's value or note, the windows) change between two cards? */
export function figuresChanged(a, b) {
  if (!a || !b) return a !== b;
  const flat = (r) => JSON.stringify([(Array.isArray(r.rows) ? r.rows : []).map((x) => [x.key, x.value, x.note]), r.windows, r.gasText, r.whyNot]);
  return flat(a) !== flat(b);
}

/**
 * The card's state after its background refresh returned `next` (rule 1).
 * @param {object} s  the card state { phase, review, progress, outcome, changedAt }
 * @param {{ next: object, worse: string|null, at: number }} o  worse: money.worse(prev, next)
 */
export function refreshedState(s, { next, worse = null, at = Date.now() } = {}) {
  if (!s || s.phase !== "review" || !next) return s;
  const changed = figuresChanged(s.review, next);
  const outcome = worse
    ? Object.freeze({ ok: false, state: "review", needsConfirm: true, code: "price-changed", why: String(worse), message: PRICE_CHANGED_WORDS })
    : s.outcome && s.outcome.code === "price-changed" && !changed ? s.outcome : changed ? null : s.outcome;
  return { ...s, review: next, progress: next.stages, outcome, changedAt: changed ? at : s.changedAt || null };
}

/**
 * May a tap on Confirm act now (rule 2)? Only on the review drawn (`rendered`) when it is the
 * current one, and not within CONFIRM_SETTLE_MS of its figures changing.
 */
export function mayConfirm({ rendered, current, changedAt = null, at = Date.now() } = {}) {
  if (!current || rendered !== current) return false;
  return !(typeof changedAt === "number" && at - changedAt < CONFIRM_SETTLE_MS);
}

/**
 * The card's state once the flow watcher settled its record (rule 3).
 * @param {object} s     the card state
 * @param {{ kind: string, rec: object }} o  rec: the registry record (state, evidence, requestId)
 */
export function settledState(s, { kind, rec } = {}) {
  if (!s || !rec) return s;
  const evidence = rec.evidence || null;
  if (rec.state === "done") {
    const gas = kind === "move-in" ? gasNoteOf(evidence) : null;
    const base = SETTLED_WORDS[kind] || "Done.";
    const message = gas && gas.missing
      ? `${base} ${gas.got ? `The gas for later didn't arrive (${gas.got}).` : "The gas for later couldn't be checked."} Check the move's status before moving again.`
      : base;
    return {
      ...s,
      phase: "done",
      progress: settledProgress(s.progress, "done"),
      outcome: { ok: true, state: "done", message, receiptText: gas && gas.seen ? `AVAX +${gas.seen} for gas` : null, requestId: rec.requestId || null, evidence },
    };
  }
  if (rec.state === "refunded") {
    return {
      ...s,
      phase: "refunded",
      progress: settledProgress(s.progress, "refunded"),
      outcome: { ok: false, state: "refunded", message: kind === "move-in" ? "Refunded to your Main Account." : "Refunded to your Spot Account.", requestId: rec.requestId || null, evidence },
    };
  }
  if (rec.state === "error-before-money") {
    return { ...s, phase: "failed", progress: settledProgress(s.progress, "error-before-money"), outcome: { ok: false, state: "error-before-money", message: "Nothing moved.", evidence } };
  }
  return s;
}
