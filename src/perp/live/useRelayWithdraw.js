// The Relay withdraw sheet's two hooks, over lib/relay/withdraw.js.
//
// useRelayWithdrawQuote: the live quote for (wallet, destination, route,
// amount). It is asked once the amount settles (a short debounce, so typing an
// amount is not a quote per keystroke), keyed by everything it was asked for,
// and an answer for another key is never handed back. A quote goes out of date
// (RELAY_WITHDRAW_QUOTE_TTL_MS): the sheet re-asks before it signs anything,
// and `stale` says when what is on screen is older than that.
//
// useWithdrawStatus: where a sent withdrawal got to (/intents/status/v3),
// polled GENTLY and only while the tab is visible — a hidden tab reads nothing
// (the deposit tracker's rule). It stops on its own once the money has arrived,
// been refunded or failed, and after WATCH_MAX_MS whatever happened.
//
// Neither hook signs, sends or holds a key: the lib only reads Relay's API, and
// the sheet does the signing through the backend seam.

import { useCallback, useEffect, useRef, useState } from "react";
import { quoteRelayWithdraw, readWithdrawStatus, withdrawQuoteFresh, RELAY_WITHDRAW_QUOTE_TTL_MS } from "../../lib/relay/withdraw.js";
import { browserNow, docHidden, onDocVisibility } from "../../lib/hyperliquid/browser.js";

export const QUOTE_DEBOUNCE_MS = 450;
/** While a quote is on screen it is refreshed this often, so it is rarely stale at the tap. */
export const QUOTE_REFRESH_MS = 45000;
export const STATUS_POLL_MS = 4000;
export const STATUS_SLOW_MS = 15000;
export const STATUS_FAST_FOR_MS = 120000;
export const WATCH_MAX_MS = 15 * 60000;

const IDLE = Object.freeze({ key: null, status: "idle", quote: null, error: null, askedAt: null });

const keyOf = ({ user, recipient, routeId, amountUsdc }) => `${String(user).toLowerCase()}|${String(recipient).toLowerCase()}|${routeId}|${amountUsdc}`;

export function useRelayWithdrawQuote({ user, recipient, route, amountUsdc, enabled = true, now = browserNow } = {}) {
  const on = !!(enabled && user && recipient && route && Number.isFinite(amountUsdc) && amountUsdc > 0);
  const key = on ? keyOf({ user, recipient, routeId: route.id, amountUsdc }) : null;
  const [snap, setSnap] = useState(IDLE);
  const [round, setRound] = useState(0);
  const live = useRef(null);

  useEffect(() => {
    if (!key) { setSnap(IDLE); return undefined; }
    let cancelled = false;
    live.current = key;
    setSnap((s) => (s.key === key && s.status === "ready" ? { ...s, status: "refreshing" } : { key, status: "loading", quote: null, error: null, askedAt: null }));
    const t = setTimeout(() => {
      quoteRelayWithdraw({ user, recipient, route, amountUsdc }).then(
        (quote) => { if (!cancelled && live.current === key) setSnap({ key, status: "ready", quote, error: null, askedAt: now() }); },
        (e) => { if (!cancelled && live.current === key) setSnap({ key, status: "error", quote: null, error: String((e && e.message) || e), askedAt: now() }); },
      );
    }, QUOTE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
    // route is the table's own frozen object; amountUsdc and the addresses are in the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, round]);

  /* Keep it fresh while it sits on screen, so the tap rarely waits for a re-quote. */
  useEffect(() => {
    if (!key || snap.key !== key || snap.status !== "ready") return undefined;
    const t = setTimeout(() => setRound((n) => n + 1), QUOTE_REFRESH_MS);
    return () => clearTimeout(t);
  }, [key, snap.key, snap.status, snap.askedAt]);

  const refresh = useCallback(() => setRound((n) => n + 1), []);
  const mine = snap.key === key ? snap : IDLE;
  const quote = mine.quote;
  return {
    status: key ? mine.status : "idle",
    quote,
    error: mine.error,
    stale: !!quote && !withdrawQuoteFresh(quote, now(), RELAY_WITHDRAW_QUOTE_TTL_MS),
    refresh,
  };
}

/**
 * Where a sent withdrawal got to. Read-only, visible tab only.
 * @returns {{ status: "sending"|"arrived"|"refunded"|"failed"|"unknown", relayStatus, txHashes, checkedAt }}
 */
export function useWithdrawStatus({ requestId, enabled = true, now = browserNow, isHidden = docHidden, onVisibility = onDocVisibility } = {}) {
  const [snap, setSnap] = useState({ status: "sending", relayStatus: null, txHashes: [], checkedAt: null });
  const startedAt = useRef(null);
  /* The last status a READ gave, for the visibility wake-up: the state of the
     closure that registered it is a render old. */
  const lastStatus = useRef("sending");

  useEffect(() => {
    if (!requestId || !enabled) return undefined;
    let stopped = false;
    let timer = null;
    startedAt.current = now();
    const done = (s) => s === "arrived" || s === "refunded" || s === "failed";
    const clear = () => { if (timer != null) { clearTimeout(timer); timer = null; } };
    const schedule = (status) => {
      clear();
      if (stopped || done(status)) return;
      if (now() - startedAt.current > WATCH_MAX_MS) return;
      if (isHidden()) return;
      timer = setTimeout(poll, now() - startedAt.current < STATUS_FAST_FOR_MS ? STATUS_POLL_MS : STATUS_SLOW_MS);
    };
    async function poll() {
      timer = null;
      if (stopped || isHidden()) return;
      const r = await readWithdrawStatus({ requestId });
      if (stopped) return;
      if (r.status !== "unknown") lastStatus.current = r.status;
      /* AN UNREADABLE ANSWER KEEPS WHAT WAS KNOWN, and "sending" is something
         known: it is where every withdrawal starts. The very first read after
         a send is the one most likely to come back unknown — the intent is not
         indexed yet, or the network blipped — and letting that replace
         "sending" took the "Relay is paying it out" line off the success
         screen, leaving "On its way" with no explanation at all. */
      setSnap((prev) => (r.status === "unknown" ? { ...prev, checkedAt: now() } : { status: r.status, relayStatus: r.relayStatus, txHashes: r.txHashes || [], checkedAt: now() }));
      schedule(r.status);
    }
    poll();
    const offVis = onVisibility(() => { if (!isHidden()) schedule(lastStatus.current); });
    return () => { stopped = true; clear(); if (typeof offVis === "function") offVis(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, enabled]);

  return snap;
}

export default useRelayWithdrawQuote;
