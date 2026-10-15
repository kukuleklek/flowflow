// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid ACCOUNT answers -> plain figures. Pure: no network, no clock.
// ─────────────────────────────────────────────────────────────────────────────
//
// What the connected user OWNS on Hyperliquid, read from the venue's own
// answers (POST /info and the matching WebSocket frames). Every parser accepts
// both the REST body and the WS frame's data, which wrap the same object.
//
// MONEY_RULES section 0. Hyperliquid sends numbers as STRINGS. A string that
// reads as a number becomes that number (a sent "0.0" is a measured zero and
// stays 0); anything else becomes null, the dash on screen. A parser that
// cannot read an answer at all returns null, never an empty account: "nothing
// there" and "could not read it" must not look the same.
//
// DISPLAY, NEVER RE-DERIVE. A position carries Hyperliquid's own entryPx,
// positionValue, unrealizedPnl, returnOnEquity (a FRACTION: 2.57 is +257%),
// liquidationPx and marginUsed. Nothing here recomputes them from a mark. A
// liquidationPx Hyperliquid sends as null (a position it cannot liquidate at
// any price) stays null.
//
// Live shapes pinned in scripts/test-hl-account-fixtures.mjs (2026-09-22).

/** Hyperliquid's userFills answers at most this many (info-endpoint page). */
export const HL_FILLS_CAP = 2000;

/** The spot token index of USDC. */
export const HL_USDC_TOKEN = 0;

/** A finite number, or null. Null, undefined, "" and non-numeric strings are unknown. */
export const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => (typeof v === "string" && v !== "" ? v : null);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** 0x + 40 hex, lowercased; anything else (including padded strings) is null. */
export function normAddress(a) {
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase();
}

const sameAddr = (a, b) => {
  const x = normAddress(a);
  return x != null && x === normAddress(b);
};

/* ── role and mode ─────────────────────────────────────────────────────── */

/**
 * userRole -> { role, master }. role is the venue's word: "missing" (never
 * used: a KNOWN empty account), "user", "agent" (someone's API wallet; master
 * names the account it trades for), "vault", "subAccount". Unreadable: null.
 */
export function parseUserRole(json) {
  const role = isObj(json) ? str(json.role) : null;
  if (!role) return { role: null, master: null };
  const master = role === "agent" && isObj(json.data) ? normAddress(json.data.user) : null;
  return { role, master };
}

/**
 * userAbstraction -> the raw mode string ("unifiedAccount", "portfolioMargin",
 * "disabled", "default", "dexAbstraction", or a future one), or null.
 */
export function parseUserAbstraction(json) {
  return str(json);
}

/**
 * Which clearinghouse holds the account's USDC.
 *   spot: unifiedAccount, portfolioMargin. Documented: "unified account and
 *         portfolio margin show all balances and holds in the spot
 *         clearinghouse state. Individual perp dex user states are not
 *         meaningful" (account-abstraction-modes page, 2026-09-22).
 *   perp: disabled (standard) and dexAbstraction (documented: USDC defaults
 *         to the perps balance), and default. "default" is NOT documented.
 *         It is read as perp because 6 of 6 live default-mode traders
 *         measured on 2026-09-22 held their USDC in the perp clearinghouse
 *         with none in spot (accountValue 43k to 3.1M each, spot USDC absent
 *         or 0.0), and because the capture session read app.hyperliquid.xyz's
 *         bundle as counting only unified and portfolio margin as
 *         spot-balanced. Where Relay's "USDC (Perps)" credit shows for a
 *         default-mode account is not yet measured: the owner's first deposit
 *         answers it. perpBalanceUsdc.source names the clearinghouse read, and
 *         USDC that lands in spot instead shows as idleSpotUsdc, not hidden.
 *   null: any other string. A mode we do not know picks no source: dash.
 */
export function balanceSourceFor(mode) {
  switch (mode) {
    case "unifiedAccount":
    case "portfolioMargin":
      return "spot";
    case "disabled":
    case "dexAbstraction":
    case "default":
      return "perp";
    default:
      return null;
  }
}

/* ── the perp clearinghouse: margin summary and positions ─────────────── */

function parseLeverage(l) {
  if (!isObj(l)) return { type: null, value: null, rawUsd: null };
  return { type: str(l.type), value: num(l.value), rawUsd: num(l.rawUsd) };
}

function parseCumFunding(c) {
  if (!isObj(c)) return { allTime: null, sinceOpen: null, sinceChange: null };
  return { allTime: num(c.allTime), sinceOpen: num(c.sinceOpen), sinceChange: num(c.sinceChange) };
}

/** One assetPositions[] row -> a position, or null when it names no coin. */
export function parsePosition(row, dex = "") {
  const p = isObj(row) && isObj(row.position) ? row.position : null;
  const coin = p ? str(p.coin) : null;
  if (!coin) return null;
  const szi = num(p.szi);
  return {
    coin,
    dex,
    szi,
    side: szi == null || szi === 0 ? null : szi > 0 ? "long" : "short",
    entryPx: num(p.entryPx),
    positionValue: num(p.positionValue),
    unrealizedPnl: num(p.unrealizedPnl),
    returnOnEquity: num(p.returnOnEquity),
    liquidationPx: num(p.liquidationPx),
    leverage: parseLeverage(p.leverage),
    marginUsed: num(p.marginUsed),
    maxLeverage: num(p.maxLeverage),
    cumFunding: parseCumFunding(p.cumFunding),
  };
}

/**
 * clearinghouseState (REST body, or the WS frame's data {dex, user,
 * clearinghouseState}) -> the main figures and the positions, or null when the
 * answer cannot be read.
 * @param {{ dex?: string }} [opts] the dex this answer is for, when the answer
 *   does not say (REST); a WS frame's own dex wins
 */
export function parseClearinghouse(json, { dex = "" } = {}) {
  if (!isObj(json)) return null;
  let body = json;
  let d = dex;
  if (isObj(json.clearinghouseState)) {
    body = json.clearinghouseState;
    if (typeof json.dex === "string") d = json.dex;
  }
  const ms = isObj(body.marginSummary) ? body.marginSummary : null;
  const cms = isObj(body.crossMarginSummary) ? body.crossMarginSummary : null;
  if (!ms || !Array.isArray(body.assetPositions)) return null;
  const positions = [];
  for (const row of body.assetPositions) {
    const p = parsePosition(row, d);
    if (p) positions.push(p);
  }
  return {
    dex: d,
    time: num(body.time),
    accountValue: num(ms.accountValue),
    totalNtlPos: num(ms.totalNtlPos),
    totalRawUsd: num(ms.totalRawUsd),
    totalMarginUsed: num(ms.totalMarginUsed),
    crossAccountValue: cms ? num(cms.accountValue) : null,
    crossTotalMarginUsed: cms ? num(cms.totalMarginUsed) : null,
    crossMaintenanceMarginUsed: num(body.crossMaintenanceMarginUsed),
    withdrawable: num(body.withdrawable),
    positions,
  };
}

/** Positions keyed by coin. */
export function positionsByCoin(positions) {
  const out = Object.create(null);
  for (const p of positions || []) out[p.coin] = p;
  return out;
}

/* ── what the user may trade on one coin ───────────────────────────────── */

/* A two-entry array read entry by entry; anything else is not read. */
function pair(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  return [num(v[0]), num(v[1])];
}

/**
 * activeAssetData (REST body, or the WS frame's data: the same object) ->
 * { user, coin, leverage, maxTradeSzs, availableToTrade }, or null.
 *   leverage          the user's setting on this coin, with or without a position
 *   availableToTrade  USDC a new order may use, as Hyperliquid computes it
 *   maxTradeSzs       the largest order size, in coin units
 * Both are Hyperliquid's two-entry pairs, kept in its order. Which entry is
 * which is not documented (the docs show a bare pair; the nktkas TS SDK calls
 * it [min, max]; every live answer read on 2026-09-22 had equal entries), so
 * nothing here labels them by side. markPx is deliberately not read: the
 * market layer owns the mark (one source per figure).
 */
export function parseActiveAssetData(json) {
  if (!isObj(json)) return null;
  const user = normAddress(json.user);
  const coin = str(json.coin);
  if (!user || !coin) return null;
  return {
    user,
    coin,
    leverage: parseLeverage(json.leverage),
    maxTradeSzs: pair(json.maxTradeSzs),
    availableToTrade: pair(json.availableToTrade),
  };
}

/* ── the spot clearinghouse ────────────────────────────────────────────── */

/**
 * spotClearinghouseState (REST) or the WS spotState frame's data {user,
 * spotState} -> { balances, usdc: { total, hold }, availableAfterMaintenance }.
 * An ANSWERED state with no USDC row holds no USDC: Hyperliquid omits empty
 * rows (a never-used address answers { balances: [] }), so that is a measured
 * zero. Unreadable: null.
 */
export function parseSpotState(json) {
  if (!isObj(json)) return null;
  const body = isObj(json.spotState) ? json.spotState : json;
  if (!Array.isArray(body.balances)) return null;
  const balances = [];
  for (const b of body.balances) {
    if (!isObj(b)) continue;
    balances.push({ coin: str(b.coin), token: num(b.token), total: num(b.total), hold: num(b.hold), entryNtl: num(b.entryNtl) });
  }
  const row = balances.find((b) => b.token === HL_USDC_TOKEN || (b.token == null && b.coin === "USDC"));
  const usdc = row ? { total: row.total, hold: row.hold } : { total: 0, hold: 0 };
  const availableAfterMaintenance = Object.create(null);
  if (Array.isArray(body.tokenToAvailableAfterMaintenance)) {
    for (const pair of body.tokenToAvailableAfterMaintenance) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const t = num(pair[0]);
      if (t != null) availableAfterMaintenance[t] = num(pair[1]);
    }
  }
  return { balances, usdc, availableAfterMaintenance };
}

/* ── open orders and TP/SL ─────────────────────────────────────────────── */

const sideOf = (s) => (s === "B" ? "buy" : s === "A" ? "sell" : null);

/* TP or SL, read from Hyperliquid's own order type: "Take Profit Market",
   "Take Profit Limit", "Stop Market", "Stop Limit". */
function tpslKind(orderType, isTrigger) {
  if (!isTrigger || typeof orderType !== "string") return null;
  if (/^take profit/i.test(orderType)) return "tp";
  if (/^stop/i.test(orderType)) return "sl";
  return null;
}

function parseOrder(o) {
  if (!isObj(o)) return null;
  const coin = str(o.coin);
  const oid = num(o.oid);
  if (!coin || oid == null) return null;
  const isTrigger = o.isTrigger === true;
  const orderType = str(o.orderType);
  const children = [];
  if (Array.isArray(o.children)) for (const c of o.children) { const k = parseOrder(c); if (k) children.push(k); }
  return {
    coin,
    oid,
    cloid: str(o.cloid),
    side: sideOf(o.side),
    limitPx: num(o.limitPx),
    sz: num(o.sz),
    origSz: num(o.origSz),
    timestamp: num(o.timestamp),
    isTrigger,
    triggerPx: isTrigger ? num(o.triggerPx) : null,
    triggerCondition: str(o.triggerCondition),
    orderType,
    reduceOnly: o.reduceOnly === true,
    isPositionTpsl: o.isPositionTpsl === true,
    tif: str(o.tif),
    tpsl: tpslKind(orderType, isTrigger),
    children,
  };
}

/**
 * frontendOpenOrders (REST array) or the WS openOrders frame's data {dex,
 * user, orders} -> orders, in Hyperliquid's order. Unreadable: null.
 */
export function parseOpenOrders(json) {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.orders) ? json.orders : null;
  if (!list) return null;
  const out = [];
  for (const o of list) { const p = parseOrder(o); if (p) out.push(p); }
  return out;
}

/**
 * TP/SL per coin, from the open orders:
 *   tp, sl       every live REDUCE-ONLY trigger of that kind (a coin can
 *                carry several)
 *   positionTp,  the POSITION TP/SL (isPositionTpsl), or null. Its size is 0,
 *   positionSl   which Hyperliquid uses for "the whole position" (seen live)
 *   pending      children of an unfilled entry order: not live until it fills
 *   entryTriggers  triggers that are NOT reduce-only: they open or add to a
 *                position, so they never guard one and are never drawn as its
 *                TP or SL
 * @returns {Record<string, { tp: object[], sl: object[], positionTp: object|null, positionSl: object|null, pending: object[], entryTriggers: object[] }>}
 */
export function tpslByCoin(orders) {
  const out = Object.create(null);
  const slot = (coin) => {
    if (!out[coin]) out[coin] = { tp: [], sl: [], positionTp: null, positionSl: null, pending: [], entryTriggers: [] };
    return out[coin];
  };
  for (const o of orders || []) {
    if (o.tpsl && !o.reduceOnly) {
      slot(o.coin).entryTriggers.push(o);
    } else if (o.tpsl) {
      const s = slot(o.coin);
      s[o.tpsl].push(o);
      if (o.isPositionTpsl) {
        if (o.tpsl === "tp" && !s.positionTp) s.positionTp = o;
        if (o.tpsl === "sl" && !s.positionSl) s.positionSl = o;
      }
    }
    for (const c of o.children || []) {
      if (c.tpsl) slot(c.coin).pending.push({ ...c, parentOid: o.oid });
    }
  }
  return out;
}

/* ── fills ─────────────────────────────────────────────────────────────── */

function parseFill(f) {
  if (!isObj(f)) return null;
  const coin = str(f.coin);
  const tid = num(f.tid);
  if (!coin || tid == null) return null;
  const liq = isObj(f.liquidation)
    ? { liquidatedUser: normAddress(f.liquidation.liquidatedUser), markPx: num(f.liquidation.markPx), method: str(f.liquidation.method) }
    : null;
  return {
    coin,
    px: num(f.px),
    sz: num(f.sz),
    side: sideOf(f.side),
    time: num(f.time),
    dir: str(f.dir),
    closedPnl: num(f.closedPnl),
    fee: num(f.fee),
    feeToken: str(f.feeToken),
    builderFee: num(f.builderFee),
    hash: str(f.hash),
    oid: num(f.oid),
    tid,
    crossed: f.crossed === true,
    startPosition: num(f.startPosition),
    liquidation: liq,
    twapId: num(f.twapId),
  };
}

/** userFills (REST array) or the WS frame's data {isSnapshot, user, fills} -> fills. Unreadable: null. */
export function parseFills(json) {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.fills) ? json.fills : null;
  if (!list) return null;
  const out = [];
  for (const f of list) { const p = parseFill(f); if (p) out.push(p); }
  return out;
}

const byTimeDesc = (a, b) => {
  const ta = a.time == null ? -Infinity : a.time;
  const tb = b.time == null ? -Infinity : b.time;
  return tb - ta;
};

/** Union by trade id, newest first, at most HL_FILLS_CAP kept. */
export function mergeFills(prev, next) {
  const seen = new Map();
  for (const f of prev || []) seen.set(f.tid, f);
  for (const f of next || []) seen.set(f.tid, f);
  return [...seen.values()].sort(byTimeDesc).slice(0, HL_FILLS_CAP);
}

/** Fills keyed by coin, each list newest first. */
export function fillsByCoin(fills) {
  const out = Object.create(null);
  for (const f of fills || []) (out[f.coin] || (out[f.coin] = [])).push(f);
  return out;
}

/**
 * Is a fill history of this size cut by the venue? userFills answers at most
 * HL_FILLS_CAP, so a full page means older fills exist that we cannot see.
 * Unknown count: null.
 */
export function fillsPartial(count) {
  const n = num(count);
  if (n == null) return null;
  return n >= HL_FILLS_CAP;
}

/* ── the non-funding ledger: deposits, withdrawals, transfers, liquidations ── */

const isUsdcToken = (t) => t === "USDC" || (typeof t === "string" && t.startsWith("USDC:"));

/* Direction relative to "me": credits from someone else are "in", debits to
   someone else "out", moves between the user's own balances "internal". */
function directionOf(from, to, me) {
  const f = from != null && sameAddr(from, me);
  const t = to != null && sameAddr(to, me);
  if (f && t) return "internal";
  if (t) return "in";
  if (f) return "out";
  return null;
}

function parseLedgerLine(row, me) {
  if (!isObj(row) || !isObj(row.delta)) return null;
  const d = row.delta;
  const type = str(d.type);
  if (!type) return null;
  const base = {
    time: num(row.time),
    hash: str(row.hash),
    type,
    usdc: null,
    usdValue: null,
    token: null,
    amount: null,
    from: normAddress(d.user),
    to: normAddress(d.destination),
    fromDex: typeof d.sourceDex === "string" ? d.sourceDex : null,
    toDex: typeof d.destinationDex === "string" ? d.destinationDex : null,
    fee: num(d.fee),
    direction: null,
    detail: null,
  };
  switch (type) {
    case "deposit":
      return { ...base, usdc: num(d.usdc), token: "USDC", direction: "in" };
    case "withdraw":
      return { ...base, usdc: num(d.usdc), token: "USDC", direction: "out" };
    case "accountClassTransfer":
      return { ...base, usdc: num(d.usdc), token: "USDC", direction: "internal", detail: { toPerp: d.toPerp === true } };
    case "internalTransfer":
    case "subAccountTransfer":
      return { ...base, usdc: num(d.usdc), token: "USDC", direction: directionOf(d.user, d.destination, me) };
    case "send":
    case "spotTransfer": {
      const token = str(d.token);
      const amount = num(d.amount);
      return {
        ...base,
        token,
        amount,
        usdc: isUsdcToken(token) ? amount : null,
        usdValue: num(d.usdcValue),
        direction: directionOf(d.user, d.destination, me),
      };
    }
    case "liquidation": {
      const positions = Array.isArray(d.liquidatedPositions)
        ? d.liquidatedPositions.filter(isObj).map((p) => ({ coin: str(p.coin), szi: num(p.szi) }))
        : [];
      return { ...base, detail: { accountValue: num(d.accountValue), leverageType: str(d.leverageType), liquidatedPositions: positions } };
    }
    default:
      return { ...base, usdc: num(d.usdc) };
  }
}

/**
 * userNonFundingLedgerUpdates (REST array, or the WS frame's data {isSnapshot,
 * user, nonFundingLedgerUpdates}) -> ledger lines, newest first. Unreadable: null.
 * @param {string} me the master address the lines belong to
 */
export function parseLedger(json, me) {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.nonFundingLedgerUpdates) ? json.nonFundingLedgerUpdates : null;
  if (!list) return null;
  const out = [];
  for (const r of list) { const l = parseLedgerLine(r, me); if (l) out.push(l); }
  return out.sort(byTimeDesc);
}

const ledgerKey = (l) => `${l.time}|${l.hash}|${l.type}|${l.usdc}|${l.amount}`;

/** Union of two ledger lists, newest first. */
export function mergeLedger(prev, next) {
  const seen = new Map();
  for (const l of prev || []) seen.set(ledgerKey(l), l);
  for (const l of next || []) seen.set(ledgerKey(l), l);
  return [...seen.values()].sort(byTimeDesc);
}

/**
 * Inbound USDC credits at or after a moment, newest first: what a Deposit
 * sheet waits for to say "Arrived". A credit in another token has no USDC
 * amount and is not counted.
 * @param {{ minUsdc?: number }} [opts] the smallest credit that counts
 */
export function arrivalsSince(lines, sinceMs, { minUsdc = null } = {}) {
  if (!Array.isArray(lines)) return [];
  const since = num(sinceMs);
  const floor = num(minUsdc);
  return lines.filter((l) => l.direction === "in" && l.usdc != null
    && (since == null || (l.time != null && l.time >= since))
    && (floor == null || l.usdc >= floor));
}
