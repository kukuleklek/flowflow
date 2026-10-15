// ─────────────────────────────────────────────────────────────────────────────
// READ-BACK: after a trade, does Hyperliquid hold what the card said? PURE.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "อยากให้ Ensure ว่า Agent เรา Excute Positon ถูกต้องทุกรูปแบบเลยไหม
// ทั้งหุ้น เทรด" (EXECUTION-ASSURANCE.md item 3). The exchange layer already
// trusts nothing it cannot read back (client.js verifies TP/SL legs after an
// open); this file is the same idea for the WHOLE card, in one place a screen
// can call after any fill: Hyperliquid's own clearinghouseState and
// frontendOpenOrders, compared field by field with what the user confirmed.
//
// WHAT IS COMPARED
//   position     there (open / add / tpsl) or gone (a full close); its SIDE; its
//                SIZE within one lot of what filled (szDecimals); its LEVERAGE
//                and MARGIN MODE (FlowFlow opens isolated, stocks always)
//   TP / SL      each leg asked for is on the book: a reduce-only market
//                trigger on the closing side, at the card's trigger price,
//                covering the whole position; a leg asked to be REMOVED is gone;
//                a position that closed leaves no trigger behind
//   liquidation  a stop that liquidation reaches first never fires: flagged
//
// 🔴 NEVER SILENT. A figure that cannot be read is a mismatch row of its own
// ("couldn't check"), never a pass: the same rule as client.js's state_unknown —
// unknown is unknown, not "flat" and not "fine".
//
// 🔴 THE CALLER PASSES THE RIGHT ACCOUNT. A stock ("xyz:TSLA") lives in its own
// margin account on Hyperliquid, and a read without its dex answers about the
// main one (measured 2026-09-23 in client.js: frontendOpenOrders without a dex
// returned 0 of an address's 380 venue orders). readBackRequests() builds the
// bodies with the dex already on them, so the read path cannot forget it.
//
// THE WORDS a mismatch carries reach a customer: none of them names a dex, a
// venue, a pot or an API action (AGENT-STOCKS-AND-MAP.md item 3). They say what
// is wrong in the customer's terms: side, size, leverage, take profit, stop loss.
//
// No network, no clock, no storage. readBackFill() takes the /info reader as an
// argument (the app passes lib/hyperliquid/info.js), so it too runs under Node
// with a fake (scripts/test-exec-readback.mjs).

import { splitHlMarket } from "./coins.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The card kinds this compares. */
export const READBACK_KINDS = Object.freeze(["open", "add", "close", "tpsl"]);

/* Prices are wire strings ("2900.5"); a read-back compares their VALUES, with a
   relative slack far below any tick (5 significant figures is 1e-5). */
const PX_REL_EPS = 1e-9;
const samePx = (a, b) => fin(a) && fin(b) && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * PX_REL_EPS;

/* One lot of this market (the smallest size step), or null when unknown. */
const lotOf = (szDecimals) => (Number.isInteger(szDecimals) && szDecimals >= 0 && szDecimals <= 8 ? 10 ** -szDecimals : null);

/* Sizes agree within one lot (the IOC fills whole lots; a reported size may be
   one lot off what was asked when a rounding met a partial fill). Unknown lot:
   they must agree to 1e-9 of the bigger one. */
function sameSize(a, b, lot) {
  if (!fin(a) || !fin(b)) return false;
  const slack = lot != null ? lot * (1 + 1e-6) : Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
  return Math.abs(a - b) <= slack;
}

const sideOfCard = (s) => (s === "buy" || s === "long" ? "long" : s === "sell" || s === "short" ? "short" : null);
const sideOfSzi = (szi) => (szi > 0 ? "long" : szi < 0 ? "short" : null);

/* A price for a sentence: plain, no currency symbol (a stock and a coin alike). */
function pxText(v) {
  const n = num(v);
  if (n == null) return "—";
  return String(Number(n.toPrecision(10)));
}
function szText(v) {
  const n = num(v);
  if (n == null) return "—";
  return String(Number(Math.abs(n).toPrecision(10)));
}

/* The customer-facing words of each mismatch. A function of (want, got, label). */
const TEXT = Object.freeze({
  state_unknown: () => "Couldn't read your position back just now, so this trade isn't verified yet. Check your positions.",
  orders_unknown: () => "Couldn't read your open orders back just now, so the take profit and stop loss aren't verified yet.",
  card_unknown: () => "This card can't be checked: it doesn't say what was sent.",
  position_missing: (w, g, label) => `No open ${label} position was found after the trade.`,
  still_open: (w, g, label) => `The ${label} position is still open (size ${szText(g)}), but the card closed all of it.`,
  side: (w, g, label) => `The ${label} position is a ${g}, but the card was a ${w}.`,
  size: (w, g, label) => `The ${label} position size is ${szText(g)}; the card filled ${szText(w)}.`,
  leverage: (w, g, label) => `The ${label} position is at ${g}x; the card said ${w}x.`,
  margin_mode: (w, g, label) => `The ${label} position is on ${g} margin; the card opened it ${w}.`,
  liq_before_sl: (w, g, label) => `Liquidation (${pxText(g)}) comes before the stop loss (${pxText(w)}) on ${label}: the stop would never fire.`,
  tp_missing: (w) => `Take profit at ${pxText(w)} isn't on the book.`,
  sl_missing: (w) => `Stop loss at ${pxText(w)} isn't on the book.`,
  tp_price: (w, g) => `Take profit is at ${pxText(g)}; the card said ${pxText(w)}.`,
  sl_price: (w, g) => `Stop loss is at ${pxText(g)}; the card said ${pxText(w)}.`,
  tp_size: (w, g) => `Take profit covers ${szText(g)}, not the whole position (${szText(w)}).`,
  sl_size: (w, g) => `Stop loss covers ${szText(g)}, not the whole position (${szText(w)}).`,
  tp_not_reduce_only: () => "Take profit isn't reduce-only: it could open a new position instead of closing this one.",
  sl_not_reduce_only: () => "Stop loss isn't reduce-only: it could open a new position instead of closing this one.",
  tp_side: () => "Take profit is on the wrong side: it would add to the position instead of closing it.",
  sl_side: () => "Stop loss is on the wrong side: it would add to the position instead of closing it.",
  tp_not_market: (w, g) => `Take profit is a ${g} order, not a market trigger: it may not fill in a fast move.`,
  sl_not_market: (w, g) => `Stop loss is a ${g} order, not a market trigger: it may not fill in a fast move.`,
  tp_extra: (w, g) => `${g} take profits are open on this position, not one.`,
  sl_extra: (w, g) => `${g} stop losses are open on this position, not one.`,
  tp_unexpected: (w, g) => `A take profit at ${pxText(g)} is still open, but the card had none.`,
  sl_unexpected: (w, g) => `A stop loss at ${pxText(g)} is still open, but the card had none.`,
  orphan_triggers: (w, g, label) => `${g} take profit / stop loss order${g === 1 ? " is" : "s are"} still open on ${label} after the position closed.`,
});

/* Severity, for the row's tone. "error": the position or a protection is not
   what the user confirmed. "warn": it is, but something extra is there. */
const WARN = new Set(["tp_extra", "sl_extra", "orphan_triggers", "tp_not_market", "sl_not_market"]);

/** The plain-English text of a mismatch code (exported for the screen and the tests). */
export function readBackText(code, { want = null, got = null, label = "" } = {}) {
  const f = TEXT[code];
  return f ? f(want, got, label) : "Something doesn't match what the card said.";
}

function mismatch(code, { field = null, want = null, got = null, label = "" } = {}) {
  return Object.freeze({
    code,
    field,
    want,
    got,
    severity: WARN.has(code) ? "warn" : "error",
    text: readBackText(code, { want, got, label }),
  });
}

/**
 * The /info bodies a read-back needs, WITH the dex for a stock market.
 * @param {string} user the account address
 * @param {string} coin "BTC" or "xyz:TSLA"
 * @returns {Array<object>|null} [clearinghouseState, frontendOpenOrders], or null for an unusable input
 */
export function readBackRequests(user, coin) {
  if (!isAddress(user) || typeof coin !== "string" || !coin) return null;
  const { dex, base } = splitHlMarket(coin);
  if (!base) return null;
  const extra = dex ? { dex } : {};
  const u = user.toLowerCase();
  return [
    { type: "clearinghouseState", user: u, ...extra },
    { type: "frontendOpenOrders", user: u, ...extra },
  ];
}

/* The coin's position in one or more clearinghouseState answers.
   { ok: false } when NO answer is readable; { ok: true, position: null } when the
   answers are readable and the coin is flat. A row with an unreadable size is
   unreadable as a whole: a size nobody can read is not "flat". */
function findPosition(states, coin) {
  const list = Array.isArray(states) ? states : [states];
  let readable = false;
  for (const s of list) {
    if (!s || typeof s !== "object" || !Array.isArray(s.assetPositions)) continue;
    readable = true;
    for (const ap of s.assetPositions) {
      const p = ap && ap.position;
      if (!p || p.coin !== coin) continue;
      const szi = num(p.szi);
      if (szi == null) return { ok: false };
      return { ok: true, position: szi === 0 ? null : p, szi };
    }
  }
  return readable ? { ok: true, position: null, szi: 0 } : { ok: false };
}

/* The coin's trigger orders, split by leg. orderType names the leg
   ("Take Profit Market", "Stop Market", "Take Profit Limit", "Stop Limit"); a
   trigger whose type names neither is kept apart (other), never guessed. */
function triggersOf(openOrders, coin) {
  const out = { tp: [], sl: [], other: [] };
  for (const o of openOrders) {
    if (!o || o.coin !== coin || o.isTrigger !== true) continue;
    const kind = String(o.orderType || "");
    const row = {
      oid: num(o.oid),
      triggerPx: num(o.triggerPx),
      sz: num(o.sz),
      side: o.side === "A" || o.side === "B" ? o.side : null,
      reduceOnly: o.reduceOnly === true,
      isPositionTpsl: o.isPositionTpsl === true,
      orderType: kind,
      market: /market/i.test(kind),
    };
    if (/take profit/i.test(kind)) out.tp.push(row);
    else if (/stop/i.test(kind)) out.sl.push(row);
    else out.other.push(row);
  }
  return out;
}

/* Does a trigger cover the whole position? A positionTpsl leg always does
   (Hyperliquid sizes it to the position, and reports sz "0.0" for it); a
   normalTpsl child carries its own size. */
const covers = (o, absSzi, lot) => o.isPositionTpsl || (fin(o.sz) && sameSize(o.sz, absSzi, lot));

/* The closing side of a position, in frontendOpenOrders' letters: a long closes
   by selling (A, ask), a short by buying (B, bid). */
const closingLetter = (side) => (side === "long" ? "A" : side === "short" ? "B" : null);

/* One leg (tp / sl) against what the card wants on the book.
   want === undefined   not checked
   want === null        none expected (not asked, or asked to be removed)
   want a price         exactly one market trigger at that price */
function checkLeg(leg, want, have, { side, absSzi, lot, label, out }) {
  if (want === undefined) return;
  const list = have[leg];
  if (want === null) {
    for (const o of list) out.push(mismatch(`${leg}_unexpected`, { field: leg, want: null, got: o.triggerPx, label }));
    return;
  }
  const px = num(want);
  if (px == null) return;
  const at = list.filter((o) => samePx(o.triggerPx, px));
  if (!at.length) {
    if (list.length) out.push(mismatch(`${leg}_price`, { field: leg, want: px, got: list[0].triggerPx, label }));
    else out.push(mismatch(`${leg}_missing`, { field: leg, want: px, got: null, label }));
    return;
  }
  const o = at[0];
  if (!o.reduceOnly) out.push(mismatch(`${leg}_not_reduce_only`, { field: leg, want: true, got: false, label }));
  const close = closingLetter(side);
  if (close && o.side && o.side !== close) out.push(mismatch(`${leg}_side`, { field: leg, want: close, got: o.side, label }));
  if (fin(absSzi) && absSzi > 0 && !covers(o, absSzi, lot)) out.push(mismatch(`${leg}_size`, { field: leg, want: absSzi, got: o.sz, label }));
  if (!o.market) out.push(mismatch(`${leg}_not_market`, { field: leg, want: "market", got: o.orderType || "limit", label }));
  if (list.length > 1) out.push(mismatch(`${leg}_extra`, { field: leg, want: 1, got: list.length, label }));
}

/* What the card SAYS filled: the trade's own answer first (filled.totalSz), the
   size it sent after that. */
function filledOf(card) {
  const f = num(card.filledSz);
  if (f != null && f > 0) return f;
  const s = num(card.size);
  return s != null && s > 0 ? s : null;
}

/**
 * Compare one card with Hyperliquid's answers after it ran.
 *
 * @param {{ kind: "open"|"add"|"close"|"tpsl", coin: string, side?: string, size?: number|string,
 *   filledSz?: number|string, szDecimals?: number, leverage?: number, marginMode?: "isolated"|"cross",
 *   tpPx?: number|string|null, slPx?: number|string|null, priorSzi?: number, closesAll?: boolean,
 *   label?: string }} card
 *   what the user confirmed, merged with what the trade answered:
 *     open   side, size (sent) / filledSz (filled), leverage, marginMode (default isolated),
 *            tpPx / slPx (null = none on the card: a leftover trigger is flagged)
 *     add    side, filledSz, priorSzi (signed size before), leverage (the position's own)
 *     close  priorSzi, filledSz, closesAll
 *     tpsl   tpPx / slPx: a price = must be on the book, null = removed, undefined = left alone
 *   label: the market's name as the customer reads it ("TSLA"); defaults to the bare ticker
 * @param {object|object[]|null} clearinghouseState the answer for the coin's own account (or several answers)
 * @param {object[]|null} openOrders frontendOpenOrders for the same account
 * @returns {{ ok: boolean, unknown: boolean, coin: string|null, mismatches: object[],
 *   position: { side: string|null, size: number, leverage: number|null, marginMode: string|null, liqPx: number|null }|null }}
 */
export function compareFill(card, clearinghouseState, openOrders) {
  const c = card && typeof card === "object" ? card : null;
  const coin = c && typeof c.coin === "string" && c.coin ? c.coin : null;
  const label = c && typeof c.label === "string" && c.label ? c.label : coin ? (splitHlMarket(coin).base || coin) : "";
  const done = (mismatches, position = null, unknown = false) => Object.freeze({
    ok: mismatches.length === 0, unknown, coin, mismatches: Object.freeze(mismatches), position,
  });
  if (!coin || !READBACK_KINDS.includes(c.kind)) return done([mismatch("card_unknown", { label })], null, true);

  const found = findPosition(clearinghouseState, coin);
  if (!found.ok) return done([mismatch("state_unknown", { label })], null, true);
  const p = found.position;
  const szi = p ? num(p.szi) : 0;
  const absSzi = Math.abs(szi);
  const lot = lotOf(c.szDecimals);
  const lev = p && p.leverage && typeof p.leverage === "object" ? num(p.leverage.value) : null;
  const mode = p && p.leverage && typeof p.leverage === "object" && typeof p.leverage.type === "string" ? p.leverage.type : null;
  const liqPx = p ? num(p.liquidationPx) : null;
  const position = p ? Object.freeze({ side: sideOfSzi(szi), size: absSzi, leverage: lev, marginMode: mode, liqPx }) : null;
  const out = [];

  /* ── the position ── */
  let wantSize = null;
  let wantSide = sideOfCard(c.side);
  if (c.kind === "open") {
    wantSize = filledOf(c);
  } else if (c.kind === "add") {
    const prior = num(c.priorSzi);
    const add = filledOf(c);
    if (prior != null && add != null) wantSize = Math.abs(prior) + add;
    if (!wantSide && prior != null) wantSide = sideOfSzi(prior);
  } else if (c.kind === "close") {
    const prior = num(c.priorSzi);
    const fill = filledOf(c);
    if (c.closesAll === true) wantSize = 0;
    else if (prior != null && fill != null) wantSize = Math.max(0, Math.abs(prior) - fill);
    if (prior != null) wantSide = sideOfSzi(prior);
  }

  const wantsPosition = c.kind === "open" || c.kind === "add" || c.kind === "tpsl" || (c.kind === "close" && wantSize !== 0 && wantSize != null);
  if (c.kind === "close" && wantSize === 0) {
    if (p) out.push(mismatch("still_open", { field: "size", want: 0, got: absSzi, label }));
  } else if (wantsPosition && !p) {
    /* A close that left a remainder, or an open / add / TP-SL card: the position must be there. */
    out.push(mismatch("position_missing", { field: "position", want: wantSide, got: null, label }));
  }

  if (p) {
    const side = sideOfSzi(szi);
    if (wantSide && side !== wantSide) out.push(mismatch("side", { field: "side", want: wantSide, got: side, label }));
    if (wantSize != null && wantSize > 0 && !sameSize(absSzi, wantSize, lot)) {
      out.push(mismatch("size", { field: "size", want: wantSize, got: absSzi, label }));
    }
    if ((c.kind === "open" || c.kind === "add") && fin(c.leverage) && lev != null && lev !== c.leverage) {
      out.push(mismatch("leverage", { field: "leverage", want: c.leverage, got: lev, label }));
    }
    const wantMode = c.kind === "open" ? (c.marginMode === "cross" ? "cross" : "isolated") : (c.marginMode === "cross" || c.marginMode === "isolated" ? c.marginMode : null);
    if (wantMode && mode && mode !== wantMode) out.push(mismatch("margin_mode", { field: "marginMode", want: wantMode, got: mode, label }));
  }

  /* ── TP / SL ── */
  const legsAsked = c.kind === "open" || c.kind === "tpsl";
  const closedAll = c.kind === "close" && wantSize === 0 && !p;
  /* An add keeps the TP / SL already set, and client.js re-places a fixed-size
     one to cover the bigger position: checked too, a stop that covers half a
     position is half a stop. */
  const needOrders = legsAsked || closedAll || (c.kind === "add" && !!p);
  if (needOrders) {
    if (!Array.isArray(openOrders)) {
      out.push(mismatch("orders_unknown", { label }));
      return done(out, position, true);
    }
    const have = triggersOf(openOrders, coin);
    if (closedAll) {
      const left = have.tp.length + have.sl.length + have.other.length;
      if (left) out.push(mismatch("orphan_triggers", { field: "orders", want: 0, got: left, label }));
    } else if (p && c.kind === "add") {
      for (const leg of ["tp", "sl"]) {
        for (const o of have[leg]) if (!covers(o, absSzi, lot)) out.push(mismatch(`${leg}_size`, { field: leg, want: absSzi, got: o.sz, label }));
      }
    } else if (p) {
      const side = sideOfSzi(szi);
      /* An open's legs: what the card had, null when it had none (a leftover
         trigger from an earlier position would then be flagged). A TP/SL card:
         only the legs it touched. */
      const tpWant = c.kind === "open" ? (c.tpPx === undefined ? null : c.tpPx) : c.tpPx;
      const slWant = c.kind === "open" ? (c.slPx === undefined ? null : c.slPx) : c.slPx;
      checkLeg("tp", tpWant, have, { side, absSzi, lot, label, out });
      checkLeg("sl", slWant, have, { side, absSzi, lot, label, out });
      const sl = num(slWant);
      if (sl != null && liqPx != null && liqPx > 0 && (side === "long" ? liqPx >= sl : side === "short" ? liqPx <= sl : false)) {
        out.push(mismatch("liq_before_sl", { field: "sl", want: sl, got: liqPx, label }));
      }
    }
  }
  return done(out, position);
}

/**
 * Read back one card through an injected /info reader, then compare. Never
 * throws: a read that fails is the state_unknown / orders_unknown row.
 * @param {{ info: (body: object) => Promise<any>, user: string, card: object }} o
 *   info: lib/hyperliquid/info.js createHlInfo(), or a fake
 * @returns {Promise<ReturnType<typeof compareFill>>}
 */
export async function readBackFill({ info, user, card } = {}) {
  const bodies = card && typeof card === "object" ? readBackRequests(user, card.coin) : null;
  if (!bodies || typeof info !== "function") return compareFill(null, null, null);
  const read = async (body) => {
    try { return await info(body); } catch { return null; }
  };
  const [state, orders] = await Promise.all(bodies.map(read));
  return compareFill(card, state, Array.isArray(orders) ? orders : null);
}
