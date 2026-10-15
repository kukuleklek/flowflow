// ─────────────────────────────────────────────────────────────────────────────
// usePerpAccount(address): what the connected user owns on Hyperliquid.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pass the MASTER address: the user's own wallet (Privy or injected), never an
// agent key's address, which Hyperliquid answers empty for.
//
// Returns the store's frozen snapshot (store.js). Every figure is a number or
// null; null is a dash on screen. The first render is ALWAYS the unanswered
// one, so derive what you draw from the snapshot each render instead of
// latching a default on the first one.
//
//   perpBalanceUsdc  { answered, source, equityUsdc, availableUsdc, holdUsdc,
//                idleSpotUsdc, complete, incompleteReason, reason, master }
//              The Perp USDC figure. Its own named figure: never add it to
//              usePortfolio, Cash, Portfolio totals or the header pills.
//              availableUsdc is the FREE USDC (withdrawable-style). What a new
//              order may use on one coin is a different figure:
//              usePerpAssetData(address, coin), Hyperliquid's activeAssetData.
//   positions  { answered, list, byCoin, complete } Hyperliquid's own numbers
//              (returnOnEquity is a FRACTION; liquidationPx may be null)
//   orders     { answered, list, tpslByCoin }
//   fills      { answered, list, byCoin, partial, cap, oldestTime }
//   ledger     { answered, list, inbound }  (usePerpDepositArrival for the Deposit sheet)
//   events     history, newest first; usePerpAccountEvents for live ones
//   agent      { answered, address, validUntil } (webData3: the unnamed agent)
//   role, mode, server, elsewhere, streams, ready, loading, stale, error
//
// One store per tab, created on first use (not on import); streams ride the
// tab's one Hyperliquid socket.
//
// VIEW AS (localhost only, viewAs.js): with ?perpViewAs=0x... on localhost or
// 127.0.0.1, every hook here reads THAT address, whatever address it is given,
// and keeps the "Viewing 0x12…ab (read-only)" banner up while it is mounted.
// usePerpViewAs() says whether a view is on; the backend seam refuses every
// action while it is.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { hlInfo } from "../info.js";
import { hlWs } from "../ws.js";
import { createPerpAccountStore } from "./store.js";
import { perpDepositArrival } from "./arrival.js";
import { createPerpAssetDataStore } from "./assetData.js";
import { perpViewAs, retainPerpViewAsBanner } from "./viewAs.js";

let defaultStore = null;
let assetStore = null;

/** The tab's one account store. */
export function perpAccountStore() {
  if (!defaultStore) defaultStore = createPerpAccountStore({ info: hlInfo, getWs: hlWs });
  return defaultStore;
}

/** The tab's one per-coin store (activeAssetData). */
export function perpAssetDataStore() {
  if (!assetStore) assetStore = createPerpAssetDataStore({ info: hlInfo, getWs: hlWs });
  return assetStore;
}

/**
 * The localhost-only view (viewAs.js): { address, label, readOnly } while
 * ?perpViewAs=0x... is on, else null. Never on a deployed host.
 */
export function usePerpViewAs() {
  return perpViewAs();
}

/* The address the account layer reads: the view's while one is on (with its
   banner up for as long as this surface is mounted), else the one given. */
function useReadAddress(address) {
  const view = perpViewAs();
  useEffect(() => (view ? retainPerpViewAsBanner(view) : undefined), [view]);
  return view ? view.address : address;
}

/**
 * @param {string|null|undefined} address the master address (any letter case)
 * @returns {object} the frozen account snapshot; PERP_ACCOUNT_EMPTY-shaped with
 *   address null when there is no address
 */
export function usePerpAccount(address) {
  const read = useReadAddress(address);
  const store = perpAccountStore();
  const get = () => store.getSnapshot(read);
  const snap = useSyncExternalStore(store.subscribe, get, get);
  useEffect(() => store.retain(read), [store, read]);
  return snap;
}

/**
 * Live account events for a toast: liquidation, adl, systemCancel, order,
 * notification. History never fires; toast events whose lead is true (one
 * liquidation seen by several streams is one group with one lead).
 * While mounted it keeps the address streamed (shared with any page on the
 * same address), so a toast host works with no Perp page open.
 * @param {string|null|undefined} address the master address
 * @param {(event: object) => void} handler
 */
export function usePerpAccountEvents(address, handler) {
  const read = useReadAddress(address);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const store = perpAccountStore();
    return store.watchEvents(read, (e) => { if (ref.current) ref.current(e); });
  }, [read]);
}

/**
 * The events a page toasts first: a liquidation or an auto-deleveraging of
 * this account, once per occurrence (the group's lead), news only. Keeps the
 * address streamed while mounted, like usePerpAccountEvents.
 * @param {string|null|undefined} address the master address
 * @param {(event: object) => void} handler
 */
export function usePerpRiskEvents(address, handler) {
  const read = useReadAddress(address);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const store = perpAccountStore();
    return store.watchRiskEvents(read, (e) => { if (ref.current) ref.current(e); });
  }, [read]);
}

/**
 * The Deposit sheet's "Arrived": inbound USDC credits since the deposit
 * started (arrival.js). arrived is null until the ledger answers.
 * @param {string|null|undefined} address the master address
 * @param {{ sinceMs?: number|null, minUsdc?: number|null }} [opts]
 */
export function usePerpDepositArrival(address, { sinceMs = null, minUsdc = null } = {}) {
  const snap = usePerpAccount(address);
  const { ledger, server } = snap;
  return useMemo(
    () => perpDepositArrival({ ledger, server }, { sinceMs, minUsdc }),
    [ledger, server, sinceMs, minUsdc],
  );
}

/**
 * What the user may trade on one coin (assetData.js): { answered, leverage
 * {type, value, rawUsd}, availableToTrade [a, b] | null, maxTradeSzs [a, b] |
 * null, stale, error, rejected }. The trade ticket's "available" and size cap
 * come from here, never from perpBalanceUsdc.availableUsdc. The pairs keep
 * Hyperliquid's order; which entry is which side is undocumented.
 * @param {string|null|undefined} address the master address
 * @param {string|null|undefined} coin the Hyperliquid coin name, e.g. "BTC"
 */
export function usePerpAssetData(address, coin) {
  const read = useReadAddress(address);
  const store = perpAssetDataStore();
  const get = () => store.getSnapshot(read, coin);
  const snap = useSyncExternalStore(store.subscribe, get, get);
  useEffect(() => store.retain(read, coin), [store, read, coin]);
  return snap;
}
