// ─────────────────────────────────────────────────────────────────────────────
// THE BACKEND SEAM: the one interface every perp screen talks to.
// ─────────────────────────────────────────────────────────────────────────────
//
//   account         the account layer's snapshot shape (usePerpAccount)
//   enableTrading   openMarket   addMarket   closeFraction   setTpSl   withdraw
//   signRelayAuthorize   sendRelayDeposit   the two steps of a Relay
//                   withdrawal, each one a wallet prompt (the exchange layer
//                   checks the quote step before either is signed)
//   sendIntentsDeposit   a Private withdrawal's one step: a wallet prompt for
//                   the sendAsset to the verified quote's one-time address
//                   (exchange/intentsOut.js is its gate)
//
// LIVE (the default): the exchange layer's trader (lib/hyperliquid/exchange,
// createHlTrader) and the account layer (lib/hyperliquid/account). Real orders,
// real USDC, signed by the user's own wallet and the trading key it approved.
//
// MOCK (VITE_PERP_BACKEND=mock only; dev verification, maybe a demo later): the
// slice-2 engine (perp/mock) adapted to the SAME shapes, so a screen cannot tell
// them apart except by the mock flag every answer carries, and every mock
// surface prints a MOCK label. A live surface never says MOCK.
//
// PURE: no React, no env, no network of its own. The hook that picks and wires
// a backend is usePerpBackend.js; the env is read in config.js.
//
// SAFETY KEPT HERE, on top of the exchange layer's own:
//   - ONE ACTION PER MARKET at a time in this tab, across trader rebuilds. The
//     trader refuses a double tap itself, but a wallet chain change rebuilds the
//     signer and so the trader; the lock below outlives that.
//   - Never throws: a surprise becomes { ok: false, code: "unexpected" }.
//   - After every action the account is read again (REST), so the card follows
//     the fill without waiting for the stream.

import { resolveBuilder, planOpenMarket, planAddMarket } from "../../lib/hyperliquid/exchange/orders.js";
import { venueOfCoin } from "../../lib/hyperliquid/exchange/venueCollateral.js";
import { isPerpMarketStale } from "../../lib/hyperliquid/markets.js";
import { maxPerpMockMarginUsd, PERP_MOCK_EVENT_LABEL } from "../mock/perpMockMath.js";

/** The actions every backend answers, in this order. */
export const PERP_BACKEND_ACTIONS = Object.freeze([
  "enableTrading", "openMarket", "addMarket", "closeFraction", "setTpSl", "withdraw",
  "signRelayAuthorize", "sendRelayDeposit", "sendIntentsDeposit",
]);

/** VITE_PERP_BACKEND: exactly "mock" selects the mock; anything else is live. */
export function perpBackendKind(raw) {
  return raw === "mock" ? "mock" : "live";
}

/** The builder config as the exchange layer reads it ({ address, feeTenthsBp }). */
export function resolvePerpBuilder(cfg) {
  return resolveBuilder(cfg || {});
}

/** This tab's in-flight actions, by market (shared by every live action set). */
export const PERP_ACTION_LOCKS = new Set();

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const errText = (e) => String((e && e.message) || e || "unknown error");

/* ── live ─────────────────────────────────────────────────────────────────── */

/**
 * The live actions over one trader.
 * @param {{ trader: object|null, refresh?: (coin?: string) => void, locks?: Set<string> }} o
 *   refresh(coin) re-reads the account (and coin's asset data) after an action
 */
export function createLiveActions({ trader, refresh = () => {}, locks = PERP_ACTION_LOCKS, diag = null } = {}) {
  if (!trader) {
    const noWallet = () => Promise.resolve(fail("no_wallet", "Connect a wallet first."));
    return Object.freeze(Object.fromEntries(PERP_BACKEND_ACTIONS.map((n) => [n, noWallet])));
  }
  const note = typeof diag === "function" ? (step, fields) => { try { diag(step, fields); } catch { /* a note may not break an action */ } } : () => {};
  async function run(key, coin, fn) {
    if (locks.has(key)) return fail("busy", "Still working on your last action here. Wait for it to finish.");
    locks.add(key);
    const at = Date.now();
    note("action.start", { action: key });
    try {
      const r = await fn();
      const out = r && typeof r === "object" ? r : fail("unexpected", "The trading layer gave no answer. Check your positions before trying again.");
      note("action.end", { action: key, ok: out.ok === true, code: out.code, ms: Date.now() - at });
      return out;
    } catch (e) {
      note("action.threw", { action: key, name: e && e.name, message: errText(e), ms: Date.now() - at });
      return fail("unexpected", `Something went wrong and nothing was confirmed: ${errText(e)}. Check your positions before trying again.`);
    } finally {
      locks.delete(key);
      try { refresh(coin); } catch { /* a refresh is a courtesy */ }
    }
  }
  const coinKey = (coin) => `coin:${coin}`;
  return Object.freeze({
    enableTrading: () => run("enable", undefined, () => trader.enableTrading()),
    openMarket: (args) => run(coinKey(args && args.coin), args && args.coin, () => trader.openMarket(args)),
    addMarket: (args) => run(coinKey(args && args.coin), args && args.coin, () => trader.addMarket(args)),
    closeFraction: (coin, fraction, opts) => run(coinKey(coin), coin, () => (opts === undefined ? trader.closeFraction(coin, fraction) : trader.closeFraction(coin, fraction, opts))),
    setTpSl: (coin, legs) => run(coinKey(coin), coin, () => trader.setTpSl(coin, legs)),
    /* THE DESTINATION IS THE SCREEN'S, not this layer's. The exchange layer
       refuses a withdrawal with no destination; the one default there is —
       "my own wallet", which is what this has always done — is filled in here,
       where the connected account is known, so a screen that has not asked yet
       keeps working and a screen that asks passes what the user confirmed. */
    withdraw: (amountUsdc, opts) => run("withdraw", undefined, () => trader.withdraw(amountUsdc, {
      destination: opts && opts.destination ? opts.destination : trader.master,
    })),
    signRelayAuthorize: (step) => run("relay-authorize", undefined, () => trader.signRelayAuthorize(step)),
    sendRelayDeposit: (args) => run("withdraw", undefined, () => trader.sendRelayDeposit(args)),
    /* The same "withdraw" lock as a Relay withdrawal's money step: one money step out of the account at a time. */
    sendIntentsDeposit: (args) => run("withdraw", undefined, () => trader.sendIntentsDeposit(args)),
  });
}

/** What the surfaces show while a localhost view-as is on (account/viewAs.js). */
export function perpViewOnlyMessage(view) {
  const label = view && typeof view.label === "string" ? view.label : "Read-only view";
  return `${label}: trading, deposits and withdrawals are off here.`;
}

/**
 * Every action while a localhost view-as is on: refused as view_only, with
 * nothing built that could sign. The account shown is not the wallet's.
 */
export function createViewOnlyActions(view) {
  const refuse = () => Promise.resolve(fail("view_only", perpViewOnlyMessage(view)));
  return Object.freeze(Object.fromEntries(PERP_BACKEND_ACTIONS.map((n) => [n, refuse])));
}

/**
 * The market row the trader prices from, with the market store's stale verdict
 * on it: the exchange planner refuses to OPEN on a frozen price.
 */
export function marketForTrade(snapshot, coin) {
  if (!snapshot || !snapshot.byCoin || typeof coin !== "string" || !coin) return null;
  const row = Object.prototype.hasOwnProperty.call(snapshot.byCoin, coin) ? snapshot.byCoin[coin] : null;
  if (!row) return null;
  return { ...row, stale: isPerpMarketStale(snapshot, coin) };
}

/**
 * The ticket's preview of a new position: the exchange layer's OWN plan (the
 * size it would send, rounded; the $10 minimum after rounding; the TP/SL
 * checks), plus the notional at the mid and the fee at feeRate.
 */
export function quoteOpenLive({ market, side, marginUsdc, leverage, tp = null, sl = null, builder = null, feeRate = null } = {}) {
  const plan = planOpenMarket({ market, side, marginUsdc, leverage, tp, sl, builder });
  if (!plan.ok) return { ok: false, code: plan.code, message: plan.message, errors: plan.errors || null, valueUsdc: plan.valueUsdc ?? null };
  const size = Number(plan.size);
  const notionalUsd = size * plan.refPx;
  return {
    ok: true, size, sizeStr: plan.size, notionalUsd, valueUsdc: plan.valueUsdc, refPx: plan.refPx,
    limitPx: Number(plan.limitPx), tpPx: plan.tpPx == null ? null : Number(plan.tpPx), slPx: plan.slPx == null ? null : Number(plan.slPx),
    feeUsdc: fin(feeRate) ? notionalUsd * feeRate : null,
  };
}

/** The ticket's preview of adding to a position, at the position's own leverage. */
export function quoteAddLive({ market, position, marginUsdc, builder = null, feeRate = null } = {}) {
  const plan = planAddMarket({ market, position, marginUsdc, builder });
  if (!plan.ok) return { ok: false, code: plan.code, message: plan.message, errors: null, valueUsdc: plan.valueUsdc ?? null };
  const size = Number(plan.size);
  const notionalUsd = size * plan.refPx;
  return {
    ok: true, size, sizeStr: plan.size, notionalUsd, valueUsdc: plan.valueUsdc, refPx: plan.refPx,
    limitPx: Number(plan.limitPx), leverage: plan.leverage, feeUsdc: fin(feeRate) ? notionalUsd * feeRate : null,
  };
}

const floorCents = (v) => Math.floor(v * 100 + 1e-9) / 100;

/**
 * 🔴 WHAT A VENUE MARKET CAN BE TRADED WITH, AND WHY IT IS NOT activeAssetData's
 * OWN FIGURE. Hyperliquid answers that question about the POT the market is
 * margined from, and a HIP-3 venue's pot starts empty in standard mode. Measured
 * 2026-09-23: an address holding 5,224,203.98 USDC on the main dex answered
 * availableToTrade ["0.0","0.0"] for xyz:TSLA. Printed straight, that is
 * "Available 0.00" to a customer who just deposited — the owner's
 * "ซื้อขายไม่ได้เฉยเลย".
 *
 * The customer has ONE Perp balance, and opening a position on a venue market
 * moves what it needs there automatically before the order (exchange/client.js
 * fundVenueOrder). So the honest figure is the pot's own available PLUS what the
 * main account can send it — topUpUsdc, which the caller passes as the main dex's
 * withdrawable and only for a standard-mode account on a venue market. A main-dex
 * market passes 0 and this is exactly what it was.
 *
 * @param {{ leverage?: number|null, feeRate?: number|null, topUpUsdc?: number|null }} o
 *   topUpUsdc: what can be moved into this market's pot, 0 when nothing can or
 *   nothing has to be (usePerpBackend.js venueTopUpUsdc)
 */
export function liveLimits(assetSnap, { leverage = null, feeRate = null, topUpUsdc = null, topUpKnown = true } = {}) {
  const pair = assetSnap && assetSnap.answered === true && Array.isArray(assetSnap.availableToTrade) ? assetSnap.availableToTrade : null;
  /* The pair's order is undocumented, so the smaller entry is used. */
  const here = pair && pair.length === 2 && fin(pair[0]) && fin(pair[1]) ? Math.max(0, Math.min(pair[0], pair[1])) : null;
  const top = fin(topUpUsdc) && topUpUsdc > 0 ? topUpUsdc : 0;
  const available = here == null ? null : here + top;
  const lev = Number.isInteger(leverage) && leverage >= 1 ? leverage : null;
  /* 🔴 MAX EXISTS EVEN WHEN THE FEE DOES NOT. This used to answer null whenever
     feeRate was null, and a growth-mode asset's rate IS null on purpose (the docs
     give "at least 90% off", a range, so venues.js refuses to invent a number).
     Measured 2026-09-23: 103 of the 108 non-delisted xyz markets carry
     growthMode "enabled" — xyz:TSLA and xyz:SP500 among them. So on almost every
     venue market the Max chip was dead AND the ticket's "More than you can use
     right now" guard could never fire, because it tests this figure: the slide
     was armed with no affordability check at all and Hyperliquid refused the
     order. The cap is now availableUsdc itself, at worst too generous by the fee
     — a refusal instead of a silent overshoot — while riskView's fee line keeps
     the dash it is owed. Nothing here invents a rate. */
  const maxMarginUsdc = available == null || lev == null ? null
    : fin(feeRate) ? floorCents(available / (1 + lev * feeRate))
      : floorCents(available);
  /* 🔴 KNOWN, BUT NOT YET WHOLE. On a venue market the figure is this pot PLUS
     what the account can send it, so while that second half is unread the
     number is true and too small. It is not dashed — the pot's own money is
     known and spendable — it is marked unsettled, the same pulse the Portfolio
     uses, so a customer is never shown a final figure that is about to grow. */
  return { answered: available != null, availableUsdc: available, maxMarginUsdc, settling: available != null && topUpKnown === false };
}

/**
 * What can be moved into a market's own pot before its order: the MAIN dex's
 * withdrawable, and only when it would be moved.
 *
 *   a main-dex market            0 — nothing moves, nothing is added
 *   unified / portfolio margin   0 — the one balance already backs every venue
 *                                (measured 2026-09-23: a unifiedAccount address
 *                                with xyz accountValue 0.0 answered
 *                                availableToTrade 142,094.80 on xyz:TSLA), so
 *                                adding it would count the same money twice
 *   not read yet, or unknown     0 — an "Available" bigger than the money that
 *                                exists is a promise the order cannot keep
 *
 * @param {object|null} balance the account layer's perpBalanceUsdc
 * @param {string|null} coin
 * @returns {number} never null: 0 is "nothing is added", not "nothing is known"
 */
export function venueTopUpUsdc(balance, coin) {
  if (!venueOfCoin(coin)) return 0;
  const b = balance && typeof balance === "object" ? balance : null;
  if (!b || b.answered !== true || b.source !== "perp") return 0;
  return fin(b.availableUsdc) && b.availableUsdc > 0 ? b.availableUsdc : 0;
}

/**
 * Is that headroom KNOWN? The figure above is 0 both when nothing would move
 * and when nothing has been read yet, and those are not the same thing to a
 * customer: the first is final, the second is a number still arriving.
 *
 *   a main-dex market            true  — nothing moves, so nothing is missing
 *   unified / portfolio margin   true  — the one balance already backs it
 *   the account has not answered false — the venue's own pot is all we can see
 *
 * @param {object|null} balance the account layer's perpBalanceUsdc
 * @param {string|null} coin
 * @returns {boolean}
 */
export function venueTopUpKnown(balance, coin) {
  if (!venueOfCoin(coin)) return true;
  const b = balance && typeof balance === "object" ? balance : null;
  if (!b || b.answered !== true) return false;
  if (b.source !== "perp") return true;
  return fin(b.availableUsdc);
}

/* ── mock ─────────────────────────────────────────────────────────────────── */

const MOCK_CODES = Object.freeze({
  badCoin: "market_unknown", badSide: "bad_input", badAmount: "bad_input", badLeverage: "bad_input",
  leverageAboveMax: "bad_input", leverageMismatch: "bad_input", marketUnknown: "market_unknown",
  priceUnknown: "price_unknown", feeUnknown: "builder_config_invalid", belowMin: "min_value",
  pastTier: "margin_tier", tiersUnknown: "market_unknown", insufficientFunds: "insufficient_margin",
  liqUnknown: "price_unknown", positionOpen: "position_exists", noPosition: "no_position",
  oppositeSide: "bad_input", badFraction: "bad_input", closeTooSmall: "too_small", badTp: "invalid_tpsl",
  badSl: "invalid_tpsl", tpWrongSide: "invalid_tpsl", slWrongSide: "invalid_tpsl", slPastLiq: "invalid_tpsl",
  triggered: "triggered",
});

function mockFail(r) {
  return { ok: false, mock: true, code: MOCK_CODES[r && r.error] || "mock_error", message: `MOCK: ${(r && r.message) || "refused"}`, mockError: r ? r.error : null };
}

/**
 * The mock engine behind the live action shapes. Fills happen at the market's
 * MARK, and never on a stale one.
 * @param {{ engine: object, marketOf: (coin: string) => object|null }} o
 *   marketOf answers marketForTrade()'s shape (a row with its stale flag)
 */
export function createMockActions({ engine, marketOf }) {
  const markOf = (coin) => {
    const m = typeof marketOf === "function" ? marketOf(coin) : null;
    if (!m) return { err: fail("market_unknown", "MOCK: this market isn't loaded yet.", { mock: true }) };
    if (m.stale === true) return { err: fail("price_stale", "MOCK: the price feed paused, so nothing fills on an old price. Try again when it updates.", { mock: true }) };
    const px = fin(m.markPx) ? m.markPx : fin(m.px) ? m.px : null;
    if (px == null || px <= 0) return { err: fail("price_unknown", "MOCK: no live mark price yet.", { mock: true }) };
    return { m, px };
  };
  const sideOf = (s) => (s === "long" ? "buy" : s === "short" ? "sell" : null);
  const ok = (x) => Promise.resolve({ ok: true, mock: true, ...x });
  return Object.freeze({
    enableTrading: () => ok({ already: true, signatures: 0, agentAddress: null, validUntil: null, builderApproved: null, persisted: true }),

    openMarket({ coin, side, marginUsdc, leverage, tp = null, sl = null } = {}) {
      const k = markOf(coin);
      if (k.err) return Promise.resolve(k.err);
      const r = engine.open(coin, side, marginUsdc, leverage, k.px, { tp: tp == null ? null : tp, sl: sl == null ? null : sl }, k.m);
      if (!r.ok) return Promise.resolve(mockFail(r));
      return ok({
        coin, side: sideOf(r.side), status: "filled", filled: { totalSz: String(r.size), avgPx: String(r.entryPx), oid: null },
        partial: false, size: String(r.size), leverage: r.leverage, marginUsdc: r.marginUsd, limitPx: null, cloid: null,
        recovered: false, clearedOrphans: [], tpsl: { tp: r.tp != null ? "placed" : "not_requested", sl: r.sl != null ? "placed" : "not_requested" },
      });
    },

    addMarket({ coin, marginUsdc } = {}) {
      const k = markOf(coin);
      if (k.err) return Promise.resolve(k.err);
      const held = engine.getSnapshot().positions;
      const p = held && Object.prototype.hasOwnProperty.call(held, coin) ? held[coin] : null;
      if (!p) return Promise.resolve(fail("no_position", "MOCK: no open position in this market.", { mock: true }));
      const r = engine.add(coin, p.side, marginUsdc, k.px);
      if (!r.ok) return Promise.resolve(mockFail(r));
      return ok({
        coin, side: sideOf(r.side), status: "filled", filled: { totalSz: String(r.addSize), avgPx: String(r.addPx), oid: null },
        partial: false, size: String(r.addSize), leverage: r.leverage, marginUsdc: r.addMarginUsd, limitPx: null, cloid: null,
        recovered: false, tpslResized: null,
      });
    },

    closeFraction(coin, fraction) {
      const k = markOf(coin);
      if (k.err) return Promise.resolve(k.err);
      const r = engine.close(coin, fraction, k.px);
      if (!r.ok) return Promise.resolve(mockFail(r));
      return ok({
        coin, status: "filled", filled: { totalSz: String(r.size), avgPx: String(r.px), oid: null }, size: String(r.size),
        closesAll: r.full, partial: false, limitPx: null, cloid: null, recovered: false,
        cleanup: r.full ? { cancelled: [], failed: [] } : undefined,
      });
    },

    setTpSl(coin, { tp, sl } = {}) {
      const k = markOf(coin);
      if (k.err) return Promise.resolve(k.err);
      const r = engine.setTpSl(coin, { tp, sl }, k.px);
      if (!r.ok) return Promise.resolve(mockFail(r));
      const placed = {};
      if (fin(tp)) placed.tp = { triggerPx: String(tp), size: null, oid: null, cloid: null };
      if (fin(sl)) placed.sl = { triggerPx: String(sl), size: null, oid: null, cloid: null };
      return ok({ coin, placed, cancelled: [], cancelFailed: [], failedLegs: {} });
    },

    withdraw: () => Promise.resolve(fail("mock_withdraw", "This is the MOCK account: there is no real USDC to withdraw.", { mock: true })),
    signRelayAuthorize: () => Promise.resolve(fail("mock_withdraw", "This is the MOCK account: there is no real USDC to withdraw.", { mock: true })),
    sendRelayDeposit: () => Promise.resolve(fail("mock_withdraw", "This is the MOCK account: there is no real USDC to withdraw.", { mock: true })),
    sendIntentsDeposit: () => Promise.resolve(fail("mock_withdraw", "This is the MOCK account: there is no real USDC to withdraw.", { mock: true })),
  });
}

const HL_SIDE = Object.freeze({ long: 1, short: -1 });

/* A mock position (the engine's derived row) in the account layer's position shape. */
function mockPosition(d, raw) {
  return Object.freeze({
    coin: d.coin,
    dex: "",
    szi: HL_SIDE[d.side] * d.size,
    side: d.side,
    entryPx: d.entryPx,
    positionValue: d.notionalUsd,
    unrealizedPnl: d.uPnlUsd,
    returnOnEquity: d.uPnlPct == null ? null : d.uPnlPct / 100,
    liquidationPx: d.liqPx,
    leverage: Object.freeze({ type: "isolated", value: d.leverage, rawUsd: null }),
    marginUsed: d.valueUsd,
    maxLeverage: raw ? raw.maxLeverage : null,
    /* The mock models no funding: unknown, never a zero. */
    cumFunding: Object.freeze({ allTime: null, sinceOpen: null, sinceChange: null }),
    markStale: d.markStale,
    mock: true,
  });
}

function mockTrigger(coin, leg, px) {
  return Object.freeze({
    coin, oid: null, cloid: null, side: null, limitPx: null, sz: 0, origSz: 0, timestamp: null, isTrigger: true,
    triggerPx: px, triggerCondition: null, orderType: leg === "tp" ? "Take Profit Market" : "Stop Market",
    reduceOnly: true, isPositionTpsl: true, tif: null, tpsl: leg, children: Object.freeze([]), mock: true,
  });
}

const FILL_TYPES = new Set(["open", "add", "close", "tp", "sl", "liquidated"]);

/* A mock history entry as a fill (newest-first lists; startPosition 0 marks the opening). */
function mockFill(h) {
  const long = h.side === "long";
  const opening = h.type === "open" || h.type === "add";
  const Side = long ? "Long" : "Short";
  return Object.freeze({
    coin: h.coin, px: h.px, sz: h.size,
    side: opening === long ? "buy" : "sell",
    time: h.t, dir: `${opening ? "Open" : "Close"} ${Side}`, label: PERP_MOCK_EVENT_LABEL[h.type] || h.type,
    closedPnl: fin(h.pnlUsd) ? h.pnlUsd : null, fee: fin(h.feeUsd) ? h.feeUsd : null, feeToken: "USDC", builderFee: null,
    hash: null, oid: null, tid: h.id, crossed: true,
    startPosition: h.type === "open" ? 0 : null,
    liquidation: h.type === "liquidated" ? Object.freeze({ liquidatedUser: null, markPx: h.markPx ?? null, method: "mock" }) : null,
    twapId: null, mock: true,
  });
}

/**
 * The mock engine's snapshot in the account layer's snapshot shape, marked mock.
 * @param {object} snap createPerpMockEngine().getSnapshot()
 */
export function mockAccountSnapshot(snap) {
  const list = (snap.list || []).map((d) => mockPosition(d, snap.positions ? snap.positions[d.coin] : null));
  const byCoin = Object.create(null);
  for (const p of list) byCoin[p.coin] = p;
  const tpslByCoin = Object.create(null);
  const orderList = [];
  for (const d of snap.list || []) {
    const tp = fin(d.tp) ? mockTrigger(d.coin, "tp", d.tp) : null;
    const sl = fin(d.sl) ? mockTrigger(d.coin, "sl", d.sl) : null;
    if (tp) orderList.push(tp);
    if (sl) orderList.push(sl);
    tpslByCoin[d.coin] = { tp: tp ? [tp] : [], sl: sl ? [sl] : [], positionTp: tp, positionSl: sl, pending: [], entryTriggers: [] };
  }
  const fills = (snap.history || []).filter((h) => FILL_TYPES.has(h.type) && h.coin).map(mockFill).reverse();
  const fillsBy = Object.create(null);
  for (const f of fills) (fillsBy[f.coin] ||= []).push(f);
  const a = snap.account || {};
  return Object.freeze({
    address: null,
    mock: true,
    ready: true,
    loading: false,
    stale: a.stale === true,
    staleSince: null,
    error: snap.saveError || null,
    updatedAt: null,
    role: Object.freeze({ value: "user", master: null, answered: true }),
    mode: Object.freeze({ value: "mock", source: "mock", answered: true }),
    perpBalanceUsdc: Object.freeze({
      answered: true, source: "mock", equityUsdc: fin(a.equityUsd) ? a.equityUsd : null, availableUsdc: snap.availableUsd,
      holdUsdc: fin(a.marginUsd) ? a.marginUsd : null, idleSpotUsdc: null, complete: true, incompleteReason: null, reason: null, master: null,
    }),
    positions: Object.freeze({ answered: true, list: Object.freeze(list), byCoin, complete: true }),
    orders: Object.freeze({ answered: true, list: Object.freeze(orderList), tpslByCoin }),
    fills: Object.freeze({ answered: true, list: Object.freeze(fills), byCoin: fillsBy, partial: false, cap: null, oldestTime: null }),
    ledger: Object.freeze({ answered: true, list: Object.freeze([]), inbound: Object.freeze([]) }),
    events: Object.freeze([]),
    agent: Object.freeze({ answered: true, address: null, validUntil: null }),
    server: Object.freeze({ time: null, at: null }),
    elsewhere: Object.freeze({ answered: true, dexes: Object.freeze([]) }),
    streams: Object.freeze({ rejected: Object.freeze([]), attributable: true }),
  });
}

/** What a new mock order may use: the mock's own balance and its own max (fee included). */
export function mockLimits(snap, { leverage = null, feeRate = null, market = null } = {}) {
  const available = snap && fin(snap.availableUsd) ? snap.availableUsd : null;
  const max = available == null || !market ? null : maxPerpMockMarginUsd({
    availableUsd: available, leverage, feeRate, markPx: market.markPx, szDecimals: market.szDecimals,
  });
  return { answered: available != null, availableUsdc: available, maxMarginUsdc: fin(max) ? floorCents(max) : null };
}

/** The ticket's preview on the mock: the engine's own quote, in the live quote's shape. */
export function quoteOpenMock(engine, { market, side, marginUsdc, leverage, tp = null, sl = null } = {}) {
  if (!market) return { ok: false, code: "market_unknown", message: "MOCK: this market isn't loaded yet." };
  if (market.stale === true) return { ok: false, code: "price_stale", message: "MOCK: the price feed paused. Wait for it to update." };
  const q = engine.quoteOpen(market.coin, side, marginUsdc, leverage, market.markPx, { tp, sl }, market);
  if (!q.ok) {
    const f = mockFail(q);
    const errors = f.code === "invalid_tpsl" ? { [/sl/i.test(q.error) ? "sl" : "tp"]: q.message } : null;
    return { ok: false, code: f.code, message: f.message, errors };
  }
  return { ok: true, size: q.size, sizeStr: String(q.size), notionalUsd: q.notionalUsd, valueUsdc: q.notionalUsd, refPx: q.entryPx, feeUsdc: q.feeUsd, liqPx: q.liqPx };
}

/** The mock preview of adding to a position. */
export function quoteAddMock(engine, { market, marginUsdc } = {}) {
  if (!market) return { ok: false, code: "market_unknown", message: "MOCK: this market isn't loaded yet." };
  if (market.stale === true) return { ok: false, code: "price_stale", message: "MOCK: the price feed paused. Wait for it to update." };
  const held = engine.getSnapshot().positions;
  const p = held && Object.prototype.hasOwnProperty.call(held, market.coin) ? held[market.coin] : null;
  if (!p) return { ok: false, code: "no_position", message: "MOCK: no open position in this market." };
  const q = engine.quoteAdd(market.coin, p.side, marginUsdc, market.markPx);
  if (!q.ok) { const f = mockFail(q); return { ok: false, code: f.code, message: f.message, errors: null }; }
  return { ok: true, size: q.addSize, sizeStr: String(q.addSize), notionalUsd: q.notionalUsd, valueUsdc: q.notionalUsd, refPx: q.addPx, feeUsdc: q.feeUsd, liqPx: q.liqPx, leverage: q.leverage };
}
