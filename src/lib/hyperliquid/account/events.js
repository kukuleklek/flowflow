// ─────────────────────────────────────────────────────────────────────────────
// Account EVENTS a screen can toast: liquidation, auto-deleveraging, orders
// the system cancelled, order status changes, and Hyperliquid notifications.
// ─────────────────────────────────────────────────────────────────────────────
//
// Several streams report the same liquidation (the fill, the ledger line, the
// userEvents push). Each becomes an event with its own id, and events of the
// same kind on the same coin within EVENT_GROUP_MS share a groupId. The first
// of a group is the lead; a screen toasts leads only, so one liquidation is
// one toast whichever streams carried it.
//
// Fill rules follow Hyperliquid's own frontend (app.hyperliquid.xyz bundle,
// read 2026-09-22): dir "Auto-Deleveraging" is an ADL; a dir starting with
// "Liquidated " is a backstop liquidation; the borrow-liquidation dirs are
// liquidations; a fill carrying a liquidation object is the user's own
// liquidation only when liquidatedUser is the user (or absent). A fill where
// SOMEONE ELSE was liquidated is the user's counterparty fill: not an event.
//
// Pure: no clock of its own. Times are the venue's where it sends one, the
// caller's receipt time where it does not (userEvents, notification).

import { normAddress, num } from "./parse.js";

/** Events of one kind on one coin this close together are one occurrence. */
export const EVENT_GROUP_MS = 10_000;

/** How many events the history keeps. */
export const EVENTS_KEPT = 100;

/** The events that change what the user holds without the user acting: what a page toasts first. */
export const PERP_RISK_EVENT_KINDS = Object.freeze(["liquidation", "adl"]);

/**
 * A liquidation or an auto-deleveraging, and the LEAD of its group (one
 * occurrence reported by several streams is one toast).
 */
export function isPerpRiskEvent(e) {
  return !!e && e.lead === true && PERP_RISK_EVENT_KINDS.includes(e.kind);
}

const ADL_DIR = "Auto-Deleveraging";
const BACKSTOP_PREFIX = "Liquidated ";
const BORROW_LIQ_DIRS = new Set(["Backstop Borrow Liquidation", "Partial Borrow Liquidation"]);

function ev(kind, source, key, { coin = null, time = null, status = null, text = null, detail = null } = {}) {
  return { id: `${source}:${key}`, kind, source, coin, time, status, text, detail, groupId: null, lead: false };
}

/** Liquidation and ADL events in a list of parsed fills (parse.js). */
export function eventsFromFills(fills, me) {
  const out = [];
  const my = normAddress(me);
  for (const f of fills || []) {
    const detail = { tid: f.tid, hash: f.hash, px: f.px, sz: f.sz, closedPnl: f.closedPnl, dir: f.dir };
    if (f.dir === ADL_DIR) {
      out.push(ev("adl", "fill", f.tid, { coin: f.coin, time: f.time, detail }));
    } else if (typeof f.dir === "string" && (f.dir.startsWith(BACKSTOP_PREFIX) || BORROW_LIQ_DIRS.has(f.dir))) {
      out.push(ev("liquidation", "fill", f.tid, { coin: f.coin, time: f.time, detail: { ...detail, method: "backstop" } }));
    } else if (f.liquidation && (f.liquidation.liquidatedUser == null || f.liquidation.liquidatedUser === my)) {
      out.push(ev("liquidation", "fill", f.tid, { coin: f.coin, time: f.time, detail: { ...detail, method: f.liquidation.method, markPx: f.liquidation.markPx } }));
    }
  }
  return out;
}

/** Liquidation events in parsed ledger lines (parse.js). */
export function eventsFromLedger(lines) {
  const out = [];
  for (const l of lines || []) {
    if (l.type !== "liquidation" || !l.detail) continue;
    const coins = l.detail.liquidatedPositions.map((p) => p.coin).filter(Boolean);
    out.push(ev("liquidation", "ledger", `${l.hash}|${l.time}`, {
      coin: coins.length === 1 ? coins[0] : null,
      time: l.time,
      detail: { hash: l.hash, coins, accountValue: l.detail.accountValue, leverageType: l.detail.leverageType },
    }));
  }
  return out;
}

/**
 * Events in one userEvents push. Fills are read from the userFills stream and
 * hourly funding is not news, so both are skipped here.
 * @param {number} at the receipt time (userEvents carry no time of their own)
 */
export function eventsFromUserEvents(data, me, at) {
  if (!data || typeof data !== "object") return [];
  const out = [];
  const liq = data.liquidation;
  if (liq && typeof liq === "object") {
    const victim = normAddress(liq.liquidated_user);
    if (victim != null && victim === normAddress(me)) {
      out.push(ev("liquidation", "userEvents", `lid:${liq.lid}`, {
        time: at,
        detail: { lid: num(liq.lid), liquidatedNtlPos: num(liq.liquidated_ntl_pos), liquidatedAccountValue: num(liq.liquidated_account_value) },
      }));
    }
  }
  if (Array.isArray(data.nonUserCancel)) {
    for (const c of data.nonUserCancel) {
      if (!c || typeof c !== "object") continue;
      const oid = num(c.oid);
      out.push(ev("systemCancel", "userEvents", `cancel:${oid}`, { coin: typeof c.coin === "string" ? c.coin : null, time: at, detail: { oid } }));
    }
  }
  return out;
}

/** Events in one orderUpdates push (WsOrder[]): status changes Hyperliquid reports. */
export function eventsFromOrderUpdates(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const u of data) {
    if (!u || typeof u !== "object" || !u.order || typeof u.order !== "object" || typeof u.status !== "string") continue;
    const oid = num(u.order.oid);
    const time = num(u.statusTimestamp);
    out.push(ev("order", "orderUpdates", `${oid}|${u.status}|${time}`, {
      coin: typeof u.order.coin === "string" ? u.order.coin : null,
      time,
      status: u.status,
      detail: { oid, side: u.order.side === "B" ? "buy" : u.order.side === "A" ? "sell" : null, limitPx: num(u.order.limitPx), sz: num(u.order.sz), origSz: num(u.order.origSz) },
    }));
  }
  return out;
}

/** One notification push, or null when it carries no text. */
export function eventFromNotification(data, at) {
  const text = data && typeof data.notification === "string" ? data.notification.trim() : "";
  if (!text) return null;
  return ev("notification", "notification", `${at}|${text}`, { time: at, text });
}

/* Could this new event be another report of an occurrence we hold? Another
   stream's report of the same kind, coin and moment; or, within one stream,
   another fill of the same transaction (one liquidation can fill in parts). */
function sameOccurrence(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "liquidation" && a.kind !== "adl") return false;
  if (a.source === b.source) {
    const ha = a.detail && a.detail.hash;
    return ha != null && b.detail != null && ha === b.detail.hash;
  }
  if (a.coin != null && b.coin != null && a.coin !== b.coin) return false;
  if (a.time == null || b.time == null) return false;
  return Math.abs(a.time - b.time) <= EVENT_GROUP_MS;
}

/**
 * Add new events to the history. Duplicates (same id) are dropped; another
 * stream's report of an occurrence already held joins its group as a
 * non-lead. The history stays newest first, at most EVENTS_KEPT long.
 * @returns {{ events: object[], added: object[] }} added: the new events, in input order
 */
export function mergeEvents(prev, incoming) {
  const list = Array.isArray(prev) ? [...prev] : [];
  const ids = new Set(list.map((e) => e.id));
  const added = [];
  for (const raw of incoming || []) {
    if (!raw || ids.has(raw.id)) continue;
    const match = list.find((e) => sameOccurrence(e, raw));
    const e = Object.freeze({ ...raw, groupId: match ? match.groupId : raw.id, lead: !match });
    list.push(e);
    ids.add(e.id);
    added.push(e);
  }
  list.sort((a, b) => (b.time == null ? -Infinity : b.time) - (a.time == null ? -Infinity : a.time));
  return { events: list.slice(0, EVENTS_KEPT), added };
}
