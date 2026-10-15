// Pure helpers behind the motion components (no DOM, no React), so they can be unit-tested with node:test.
// Presentation only: nothing here touches amounts, hashes or anything that is signed or sent.

/**
 * Parses a CSS <time> as returned by getComputedStyle(…).getPropertyValue("--token") ("150ms", " 0.25s").
 * Custom properties come back with var() already substituted. Anything unparsable returns the fallback.
 */
export function parseCssTime(value: string | null | undefined, fallbackMs: number): number {
  if (typeof value !== "string") return fallbackMs;
  const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/i.exec(value);
  if (!m || m[1] === undefined || m[2] === undefined) return fallbackMs;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return fallbackMs;
  return m[2].toLowerCase() === "s" ? n * 1000 : n;
}

export interface DigitCell {
  ch: string;
  /** 02 Number pop-in: the last two characters ride in 1× / 2× --digit-stagger behind the rest. */
  stagger: 0 | 1 | 2;
  space: boolean;
}

/** Splits a formatted number into per-character cells for the number pop-in (stagger on the last two). */
export function splitDigits(value: string): DigitCell[] {
  const chars = Array.from(value);
  return chars.map((ch, i) => ({
    ch,
    stagger: i === chars.length - 1 ? 2 : i === chars.length - 2 ? 1 : 0,
    space: /\s/.test(ch),
  }));
}

/** First-load stagger index for list rows, capped so long lists never wait (Motion v2: max ~6 blocks). */
export function staggerIndex(i: number, max = 6): number {
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(Math.floor(i), max);
}

export type RevealPhase = "loading" | "revealing" | "done";

/**
 * 14 Skeleton reveal state machine. `loading` = "no data yet" (first load). Data that was already there on mount
 * renders without any reveal; data that arrives later cross-fades in once; a later first-load (e.g. after a
 * rescan cleared the list) snaps back to the skeleton. Background refetches keep loading=false and never return here.
 */
export function nextRevealPhase(phase: RevealPhase, loading: boolean): RevealPhase {
  if (loading) return "loading";
  return phase === "loading" ? "revealing" : phase;
}

/**
 * 12 Error shake trigger. Shake only when an error becomes visible while the user is not typing in the field
 * (error appeared after blur / paste / submit), or when the field is left while still invalid. Never on every
 * keystroke, and never while the same error simply persists.
 */
export function shouldShake(input: {
  prevError: string | null;
  error: string | null;
  focused: boolean;
  /** The change came from a paste (an instant, complete value) rather than typing. */
  pasted?: boolean;
  /** The form was just submitted from inside the field (Enter): a deliberate "check this" moment. */
  submitted?: boolean;
  /** The field just lost focus. */
  blurred?: boolean;
}): boolean {
  const { prevError, error, focused, pasted = false, submitted = false, blurred = false } = input;
  if (!error) return false;
  if (blurred || submitted) return true;
  if (error === prevError) return false;
  return !focused || pasted;
}

/** Which slot of a 2–4 state icon swap is active. */
export type IconSlot = "a" | "b" | "c" | "d";

export interface PresenceEntry<T> {
  key: string;
  item: T;
  /** Removed from the source list: rendered once more while it fades out, then dropped. */
  leaving: boolean;
}

/**
 * List presence for the "removed item fades out" pattern (Motion v2 lists). Current items keep their order and
 * their latest value; an item that disappeared stays at its previous position, marked leaving, until the caller
 * drops it (dropLeaving) after the exit animation. An item that comes back while leaving is simply current again.
 */
export function mergePresence<T>(
  prev: readonly PresenceEntry<T>[],
  next: readonly T[],
  keyOf: (item: T) => string,
): PresenceEntry<T>[] {
  const nextKeys = new Set<string>();
  const out: PresenceEntry<T>[] = [];
  for (const item of next) {
    const key = keyOf(item);
    if (nextKeys.has(key)) continue; // duplicate keys: first one wins (React needs unique keys)
    nextKeys.add(key);
    out.push({ key, item, leaving: false });
  }
  // Re-insert removed entries after the entry that preceded them before (or at the top).
  let anchor: string | null = null;
  for (const e of prev) {
    if (nextKeys.has(e.key)) {
      anchor = e.key;
      continue;
    }
    const at = anchor === null ? 0 : out.findIndex((o) => o.key === anchor) + 1;
    out.splice(at, 0, { key: e.key, item: e.item, leaving: true });
    anchor = e.key;
  }
  return out;
}

/** Drops the entries that finished leaving. */
export function dropLeaving<T>(entries: readonly PresenceEntry<T>[]): PresenceEntry<T>[] {
  return entries.filter((e) => !e.leaving);
}

/**
 * How much longer a briefly-shown indicator (the refetch "updating" dot) must stay visible after its trigger ended,
 * so a 100 ms poll still reads as one calm pulse instead of a flicker. `shownAt` is when it appeared (ms).
 */
export function lingerMs(shownAt: number, now: number, minVisibleMs: number): number {
  if (!Number.isFinite(shownAt) || !Number.isFinite(now) || !(minVisibleMs > 0)) return 0;
  return Math.max(0, shownAt + minVisibleMs - now);
}
