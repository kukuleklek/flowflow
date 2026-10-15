// ─────────────────────────────────────────────────────────────────────────────
// ONE RUN OF ONE MONEY STEP: how an executor (ownMove / moveOut / swap) takes its
// flow from the registry before it may open any window. PURE: no env, no network,
// nothing runs at import time.
// ─────────────────────────────────────────────────────────────────────────────
//
// The flow handle (src/avax/flows.js registry.handle(id)) is the only thing an
// executor may run under. This file is the executor's side of the contract:
//
//   1. claimRun(flow, stage) — SYNCHRONOUS, called before the executor's first
//      await. A stage runs once per flow, ever: a second run of the same confirmed
//      move (a React double effect, a retry, Autopilot plus a tap, two concurrent
//      calls) is refused here and touches nothing (ATK-03).
//   2. the record it returns is what the user CONFIRMED (amounts, maxDebit); the
//      executor compares the price it is about to sign with it (ATK-04).
//   3. flow.acquire() before the first window: the cross-tab lock (ATK-11).
//
// A handle that is not a registry handle (no claim / get / acquire) is refused:
// nothing opens a money window without the registry.

/** Plain words for a run that was refused before it started. None names a provider. */
export const RUN_REFUSED_WORDS = Object.freeze({
  "already-run": "This move already ran. Nothing new was sent.",
  "not-owner": "This move is running in another tab. Nothing new was sent.",
  "bad-state": "This move can't run now. Nothing moved.",
  "bad-stage": "This move can't run here. Nothing moved.",
  "not-claimed": "This move can't run here. Nothing moved.",
});

const isHandle = (flow) => !!flow && typeof flow.claim === "function" && typeof flow.get === "function"
  && typeof flow.acquire === "function" && typeof flow.beforeWindow === "function";

/**
 * Claim `stage` of the flow. Never throws.
 * @returns {{ ok: true, record: object } |
 *   { ok: false, code: "registry" } |                     // can't record: the executor's own "couldn't record" words
 *   { ok: false, code: string, message: string, untouched: true }}  // refused: return at once, touch nothing
 */
export function claimRun(flow, stage) {
  if (!isHandle(flow)) return { ok: false, code: "registry" };
  try {
    flow.claim(stage);
  } catch (e) {
    const code = e && typeof e.code === "string" ? e.code : "storage";
    if (code === "storage" || code === "not-found") return { ok: false, code: "registry" };
    return { ok: false, code, message: RUN_REFUSED_WORDS[code] || RUN_REFUSED_WORDS["bad-state"], untouched: true };
  }
  let record = null;
  try { record = flow.get(); } catch { record = null; }
  if (!record || typeof record !== "object") return { ok: false, code: "registry" };
  return { ok: true, record };
}

/** A confirmed number from the record, or null when it is not one (unknown is null, never 0). */
export function confirmedNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
