// ─────────────────────────────────────────────────────────────────────────────
// usePerpMock — the MOCK perp account for a component, fed by live marks.
// ─────────────────────────────────────────────────────────────────────────────
//
// One engine per tab (created on first use, not on import), saved to this
// browser's storage under the key in perpMockMath.js and kept in step with the
// other tabs through the storage event. One feeder per tab, refcounted: while
// any component uses this hook, the marks of the coins with an open mock
// position stream in through the app's one market store (no socket of its own)
// and TP / SL / liquidation fire on them.
//
// EVERYTHING THIS RETURNS IS MOCK MONEY (snapshot.mock is true). It must never
// be added to, shown beside as if part of, or fed into usePortfolio, Cash,
// Portfolio, the header wallet pills, the leaderboard or copy; every figure
// from it sits under a visible MOCK label.
//
// MOCK LIMITATION: the triggers run only while FlowFlow is open in a tab and
// its mark stream is fresh. Hyperliquid runs them on its servers; this does
// not. A level crossed while the app was closed fires on the first fresh mark
// after it reopens, at the level's own price.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { perpMarketsStore } from "../../lib/hyperliquid/markets.js";
import { PERP_MOCK_FEE_RATE } from "./config.js";
import { createPerpMockEngine } from "./perpMockEngine.js";
import { createPerpMockFeeder } from "./perpMockFeeder.js";

/* The page's storage, or null when the browser refuses it (private mode, a
   sandboxed frame, blocked site data). Reaching for it can itself throw. */
function pageStorage() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === "function" && typeof s.setItem === "function" ? s : null;
  } catch {
    return null;
  }
}

/* Storage events from the other tabs. */
function onOtherTabs(fn) {
  const w = typeof window !== "undefined" ? window : null;
  if (!w || typeof w.addEventListener !== "function") return () => {};
  w.addEventListener("storage", fn);
  return () => w.removeEventListener("storage", fn);
}

let engine = null;
let feeder = null;

/** The tab's one mock engine. */
export function perpMockEngine() {
  if (!engine) engine = createPerpMockEngine({ storage: pageStorage(), listen: onOtherTabs, feeRate: PERP_MOCK_FEE_RATE });
  return engine;
}

/** The tab's one mark feeder (for the engine above, through the one market store). */
export function perpMockFeeder() {
  if (!feeder) feeder = createPerpMockFeeder({ engine: perpMockEngine(), markets: perpMarketsStore() });
  return feeder;
}

/**
 * The mock account and its actions.
 * @returns the engine snapshot ({ mock, availableUsd, positions, list, account,
 *   history, marks, feeRate, persisted, saveError, loadNote, ... }) plus
 *   open, add, close, setTpSl, reset, quoteOpen, quoteAdd, quoteClose, onEvents.
 */
export function usePerpMock() {
  const e = perpMockEngine();
  const snap = useSyncExternalStore(e.subscribe, e.getSnapshot, e.getSnapshot);
  useEffect(() => perpMockFeeder().retain(), []);
  return useMemo(() => Object.freeze({
    ...snap,
    open: e.open,
    add: e.add,
    close: e.close,
    setTpSl: e.setTpSl,
    reset: e.reset,
    quoteOpen: e.quoteOpen,
    quoteAdd: e.quoteAdd,
    quoteClose: e.quoteClose,
    onEvents: e.onEvents,
  }), [snap, e]);
}
