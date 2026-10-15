// SLIDE TO CONFIRM — the only way a perp order, close or TP/SL change is sent.
//
// A tap can land by accident (a scroll that ends on the button, a thumb on the
// dock); a slide cannot. FOMO sends every order this way. The rule, pure so the
// node suite runs it:
//
//   drag      the thumb follows the finger (0..1 of the track)
//   release   past SLIDE_THRESHOLD the slide completes; before it, the thumb
//             springs back to the start and NOTHING is sent
//   keys      ArrowRight / ArrowLeft step a tenth; Home jumps to the start and
//             End to ONE STEP SHORT of the end, so no single key press ever
//             completes: the last step is always its own ArrowRight. Enter and
//             Space do nothing: a key press that sends money is a tap by
//             another name, and so is a lone End.
//   done      sticky: once complete, nothing moves it back (the screen swaps
//             the control for the order's progress, and a new attempt mounts a
//             new slide)

export const SLIDE_THRESHOLD = 0.9;
export const SLIDE_START = Object.freeze({ progress: 0, done: false });

const clamp01 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const STEP = 0.1;

/**
 * THE RESISTANCE (owner, 2026-09-23: the ticket must feel like something, not
 * like a web form). The thumb does not ride the finger one to one: it LAGS it
 * through the track and catches up only at the very end, so starting the
 * gesture by accident gets nowhere and finishing it is a deliberate push.
 *
 * A power curve, applied by the control to the raw finger ratio BEFORE the
 * reducer sees it, so the rule above stays untouched and pure: a release still
 * springs back under SLIDE_THRESHOLD, and no key press is affected at all.
 *
 * SLIDE_RESIST may not grow past the point where a nearly-full drag stops
 * completing: resist(0.95) must stay at or above SLIDE_THRESHOLD, which the
 * suite pins, or a finger that ends a hair short of the edge would silently
 * spring back on a control the user thought they had finished.
 */
export const SLIDE_RESIST = 1.6;
export const slideResist = (raw) => {
  const r = clamp01(raw);
  return r <= 0 ? 0 : r >= 1 ? 1 : r ** SLIDE_RESIST;
};

/** Where the finger must be for the thumb to sit at `progress` — the grab offset. */
export const slideResistInverse = (progress) => {
  const p = clamp01(progress);
  return p <= 0 ? 0 : p >= 1 ? 1 : p ** (1 / SLIDE_RESIST);
};

/**
 * @param {{ progress: number, done: boolean }} state
 * @param {{ type: "drag", ratio: number } | { type: "release" } | { type: "key", key: string } | { type: "reset" }} action
 * @returns {{ progress: number, done: boolean }}
 */
export function slideReduce(state, action) {
  const s = state && typeof state === "object" ? state : SLIDE_START;
  if (!action || typeof action !== "object") return s;
  if (action.type === "reset") return SLIDE_START;
  if (s.done) return s;
  switch (action.type) {
    case "drag":
      return { progress: clamp01(action.ratio), done: false };
    case "release":
      return s.progress >= SLIDE_THRESHOLD ? { progress: 1, done: true } : { progress: 0, done: false };
    case "key": {
      let p = s.progress;
      if (action.key === "ArrowRight" || action.key === "ArrowUp") p = Math.round((p + STEP) * 10) / 10;
      else if (action.key === "ArrowLeft" || action.key === "ArrowDown") p = Math.round((p - STEP) * 10) / 10;
      else if (action.key === "Home") p = 0;
      else if (action.key === "End") p = Math.max(p, 1 - STEP);
      else return s;
      p = clamp01(p);
      return { progress: p, done: p >= 1 };
    }
    default:
      return s;
  }
}
