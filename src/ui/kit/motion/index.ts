// ui kit · React motion components. Needs css/tokens.css + css/motion.css (and, without Tailwind v4,
// ./without-tailwind.css). For the owner's own apps only: see ../README.md "Licence".

// Components
export { Accordion } from "./accordion";
export { AnimatedNumber } from "./animated-number";
export { AutoHeight } from "./auto-height";
export { CountBadge } from "./count-badge";
export { IconSwap } from "./icon-swap";
export { Reveal } from "./reveal";
export { ShakeOnError } from "./shake";
export { IndeterminateBar, ShimmerText } from "./shimmer-text";
export { StaggerText } from "./stagger-text";
export { SuccessCheck } from "./success-check";
export { TextSwap } from "./text-swap";
export { UpdatingDot } from "./updating-dot";

// Hooks and prop helpers
export { exitProps, usePresenceList } from "./presence";
export { rise } from "./rise";
export { useSlidingPill } from "./sliding-pill";
export { prefersReducedMotion, readMotionMs, useReducedMotion } from "./use-motion";
export { INERT, inertProps } from "./inert";
export { useIsoLayoutEffect } from "./iso-layout-effect";
export { cn, type ClassValue } from "./cn";

// Pure logic (no DOM, no React; unit-tested in motion-logic.test.ts)
export {
  dropLeaving,
  lingerMs,
  mergePresence,
  nextRevealPhase,
  parseCssTime,
  shouldShake,
  splitDigits,
  staggerIndex,
  type DigitCell,
  type IconSlot,
  type PresenceEntry,
  type RevealPhase,
} from "./motion-logic";
