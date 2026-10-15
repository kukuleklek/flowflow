"use client";

import { useSyncExternalStore } from "react";
import { parseCssTime } from "./motion-logic";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Imperative check, for JS-timed motion (text swap delays, success hold). False on the server. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY).matches
    : false;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Live prefers-reduced-motion (server snapshot: false). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

/**
 * Reads a motion token / snippet variable from :root in milliseconds, so JS timings stay in sync with the CSS
 * (the transitions.dev orchestration pattern). Reduced motion → 0.
 */
export function readMotionMs(name: `--${string}`, fallbackMs: number): number {
  if (typeof window === "undefined") return fallbackMs;
  if (prefersReducedMotion()) return 0;
  return parseCssTime(
    getComputedStyle(document.documentElement).getPropertyValue(name),
    fallbackMs,
  );
}
