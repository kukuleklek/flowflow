"use client";

import { useEffect, useState } from "react";
import { INERT } from "./inert";
import { type PresenceEntry, dropLeaving, mergePresence, parseCssTime } from "./motion-logic";
import { prefersReducedMotion } from "./use-motion";

/** Exit duration from the CSS tokens (reduced motion: the short opacity cross-fade). */
function exitMs(): number {
  if (typeof window === "undefined") return 0;
  const name = prefersReducedMotion() ? "--rm-fade-dur" : "--exit-dur";
  return parseCssTime(getComputedStyle(document.documentElement).getPropertyValue(name), 350);
}

/**
 * Keeps a removed list item rendered (marked `leaving`) while its `.t-exit` fade plays, then drops it ("a removed
 * item fades out"). Render leaving entries with `exitProps(true)`: they are inert and hidden from assistive tech, so
 * nobody can click or read a row that is already gone from the data.
 */
export function usePresenceList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): PresenceEntry<T>[] {
  const [source, setSource] = useState(items);
  const [entries, setEntries] = useState<PresenceEntry<T>[]>(() => mergePresence([], items, keyOf));
  // Adjusting state during render (not in an effect) when the source list changes.
  if (items !== source) {
    setSource(items);
    setEntries(mergePresence(entries, items, keyOf));
  }
  const hasLeaving = entries.some((e) => e.leaving);
  useEffect(() => {
    if (!hasLeaving) return;
    const t = window.setTimeout(() => setEntries(dropLeaving), exitMs());
    return () => window.clearTimeout(t);
  }, [hasLeaving]);
  return entries;
}

/**
 * Props for a leaving row: fade out, no pointer, not focusable, not announced. `inert` is rendered on React 18 and
 * 19 alike (see inert.ts).
 */
export function exitProps(leaving: boolean): {
  className?: string;
  inert?: boolean;
  "aria-hidden"?: true;
} {
  return leaving ? { className: "t-exit", inert: INERT, "aria-hidden": true } : {};
}
