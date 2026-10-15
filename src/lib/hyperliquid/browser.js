// The browser half of the Hyperliquid data layer's dependencies: timers, the
// clock and page visibility. The logic modules take these as arguments so the
// node suites can drive them with a fake clock and a fake page; the default
// instances pass these.
//
// Visibility follows the pattern the token feed already uses (lib/tokenFeed.js,
// useTokenFeed): a hidden tab does no work, and coming back acts at once.

export const browserTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export const browserNow = () => Date.now();

export function docHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Listen for visibility changes. Returns the remover. */
export function onDocVisibility(fn) {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}
