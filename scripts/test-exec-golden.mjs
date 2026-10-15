/**
 * test-exec-golden — EVERY WAY THE AGENT TRADES, DOWN TO THE EXACT HYPERLIQUID ACTION.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "อยากให้ Ensure ว่า Agent เรา Excute Positon ถูกต้องทุกรูปแบบเลยไหม
 * ทั้งหุ้น เทรด" (EXECUTION-ASSURANCE.md item 1).
 *
 * The path under test is the one a real tap takes, end to end, with nothing
 * stubbed but Hyperliquid itself:
 *
 *   words (TH / EN)  ── shortcuts.js parseShortcut + respond.js respondLocally
 *   model tool call  ── runTool.js proposeAction                  ─┐
 *   a setup tapped   ── setups.js setupToOpenCard                 ─┤→ the CARD
 *   the card         ── TradeCard.jsx + trade/useOrderQuote.js (their pure glue, replayed
 *                       below and pinned to their source by test P1)  → the CALL
 *   the call         ── exchange/client.js createHlTrader (orders.js, venueCollateral.js)
 *                                                                    → the SIGNED BODIES
 *   a fake Hyperliquid ── takes the bodies, moves positions, pots and orders as the
 *                       real one does, and refuses what the real one refuses
 *   readBack.js      ── reads the fake back and agrees with the card
 *
 * Every action is checked TWICE: against a golden literal (asset id, isBuy, size,
 * price strings, reduce-only, trigger shape, grouping, leverage update, builder
 * field, top-up / sweep moves), and against scripts/lib/hlOrderRules.mjs, which
 * restates Hyperliquid's rules without importing the code that applies them.
 *
 *   A. asset ids from the fixtures (dexIndex read from fixtures/hip3/perp-dexs.json)
 *   O. open long / short by margin, TH and EN, with and without TP / SL (% ROE),
 *      model path and setups, caps, builder fee, the $10 minimum, freshness,
 *      never sent twice
 *   D. add to a position (its own leverage; fixed-size TP / SL resized)
 *   C. close half / % / all (reduce-only, size rounded DOWN, triggers cleared)
 *   T. set / move / remove TP and SL (new first, old cancelled after)
 *   F. flip refused at every layer
 *   S. stocks: venue top-up before the order, isolated, 110001, sweep after the sell,
 *      the stock caps (≤ min(10, market max), ≤ 5x while the US market is closed)
 *   K. the risk-based plan (agent/tradePlan.js, when present): the stop / TP / size
 *      its card's maths shows are the ones sent; and what is not built yet or is
 *      known wrong, each a TODO with its concrete failing case (close-all card,
 *      Agent stock routing, a model close of 30%, size / notional / price-TP
 *      phrasing, size rounded up past the cap, the exact stock top-up, no cap at
 *      the send layer)
 *
 * No network: fetch is replaced by a thrower for the whole file. Signatures are
 * made with the Python SDK's PUBLIC test key into the fake; nothing reaches
 * Hyperliquid. Run: node --test scripts/test-exec-golden.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  orderProblems, leverageProblems, expectedAssetId, priceProblems, sizeProblems,
} from "./lib/hlOrderRules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = (f) => pathToFileURL(path.join(ROOT, "src", f)).href;
const FX = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures", f), "utf8"));

let realNetworkAttempts = 0;
globalThis.fetch = () => { realNetworkAttempts++; throw new Error("test-exec-golden: a real network call was attempted"); };

const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x14791697260E4c9A71f18484C9f997B308e59325";
const BUILDER = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
const T0 = 1_700_000_000_000;
/* Measured 2026-09-23, /info {type:"spotMeta"}: USDC is spot token 0. */
const USDC_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
/* Thursday 2026-10-15 11:00 ET (core session) and Saturday 2026-10-17 noon ET (closed). */
const US_OPEN = Date.UTC(2026, 9, 15, 15, 0);
const US_CLOSED = Date.UTC(2026, 9, 17, 16, 0);

let C, N, A, NC, O, S, V, ROWS, DEXS, XYZ_INDEX, viem, viemAccounts, ethers;
let PB, LV, TK, GR, SC, RS, RT, ST, GD, RB, TL, MK, WL, CP, CA;
before(async () => {
  C = await import(SRC("lib/hyperliquid/exchange/client.js"));
  N = await import(SRC("lib/hyperliquid/exchange/network.js"));
  A = await import(SRC("lib/hyperliquid/exchange/agentStore.js"));
  NC = await import(SRC("lib/hyperliquid/exchange/nonce.js"));
  O = await import(SRC("lib/hyperliquid/exchange/orders.js"));
  S = await import(SRC("lib/hyperliquid/exchange/signing.js"));
  V = await import(SRC("lib/hyperliquid/venues.js"));
  MK = await import(SRC("lib/hyperliquid/markets.js"));
  PB = await import(SRC("perp/live/perpBackend.js"));
  LV = await import(SRC("perp/live/perpLiveView.js"));
  TK = await import(SRC("perp/perpTicket.js"));
  GR = await import(SRC("perp/guardrails.js"));
  SC = await import(SRC("agent/shortcuts.js"));
  RS = await import(SRC("agent/respond.js"));
  RT = await import(SRC("agent/runTool.js"));
  ST = await import(SRC("agent/setups.js"));
  TL = await import(SRC("agent/tools.js"));
  GD = await import(SRC("lib/hyperliquid/hip3/guard.js"));
  WL = await import(SRC("lib/hyperliquid/hip3/whitelist.js"));
  RB = await import(SRC("lib/hyperliquid/readBack.js"));
  CP = await import(SRC("agent/caps.js"));
  CA = await import(SRC("agent/closeAll.js"));
  viem = await import("viem");
  viemAccounts = await import("viem/accounts");
  ethers = await import("ethers");

  /* THE MARKET ROWS, as the app's store builds them, from real answers: the main
     dex (2026-09-22) and xyz (2026-10-15). xyz's index is READ from the real
     perpDexs answer, never written down here. */
  DEXS = V.parsePerpDexs(FX("hip3/perp-dexs.json").response);
  XYZ_INDEX = DEXS.byName.get("xyz").index;
  const main = MK.parsePerpMarkets(FX("hl-meta-and-asset-ctxs.json").response, { now: 1 });
  const xyz = MK.parsePerpMarkets(FX("hip3/xyz-meta-and-asset-ctxs.json").response, { now: 1, dex: "xyz", dexIndex: XYZ_INDEX, venueName: "xyz", venueCategory: "stock" });
  ROWS = { ...main.byCoin, ...xyz.byCoin };
});

const MAIN = () => N.hlNetworkProfile("mainnet");
const fin = (v) => typeof v === "number" && Number.isFinite(v);
/* The app's all-in rate with the builder off (perp/mock/fees.js HL_TAKER_FEE_RATE). */
const FEE = 0.00045;
const MOVES_OPEN = Object.freeze({ auto: true, dexes: ["xyz"] });

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

/* The user's wallet behind ethers' BrowserProvider, parked on Arbitrum (0xa4b1) as FlowFlow's Privy wallet is. */
function wallet(key = PY_KEY) {
  const account = viemAccounts.privateKeyToAccount(key);
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0xa4b1";
      if (method === "net_version") return "42161";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const data = JSON.parse(params[1]);
        return account.signTypedData({ domain: data.domain, types: data.types, primaryType: data.primaryType, message: data.message });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider };
}

/* ── a fake Hyperliquid with pots, positions, trigger orders and its own refusals ── */

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r10 = (x) => Math.round(x * 1e10) / 1e10;

function fakeHl({ pots = null, checkMargin = true, maxBuilderFee = 0 } = {}) {
  const profile = MAIN();
  const byAsset = new Map(Object.values(ROWS).map((m) => [m.assetIndex, m]));
  const st = {
    pots: pots || { "": { free: 1000, positions: {} }, xyz: { free: 0, positions: {} } },
    lev: new Map(), orders: { "": [], xyz: [] }, mids: {}, time: T0, nextOid: 9000, maxBuilderFee,
  };
  const posts = [];
  const infos = [];
  const dexOf = (coin) => (coin.includes(":") ? coin.split(":")[0] : "");
  const pot = (dex) => st.pots[dex] || (st.pots[dex] = { free: 0, positions: {} });
  const book = (dex) => st.orders[dex] || (st.orders[dex] = []);
  const midOf = (m) => (fin(st.mids[m.coin]) ? st.mids[m.coin] : m.midPx);
  const res = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const clearing = (dex) => {
    const p = pot(dex);
    return {
      assetPositions: Object.entries(p.positions).map(([coin, q]) => ({
        type: "oneWay",
        position: {
          coin, szi: String(q.szi), leverage: q.cross ? { type: "cross", value: q.lev } : { type: "isolated", value: q.lev, rawUsd: String(-q.margin) },
          entryPx: String(q.entryPx), positionValue: String(r6(Math.abs(q.szi) * q.entryPx)), unrealizedPnl: "0.0", returnOnEquity: "0.0",
          liquidationPx: null, marginUsed: String(r6(q.margin)), maxLeverage: ROWS[coin] ? ROWS[coin].maxLeverage : 20,
          cumFunding: { allTime: "0.0", sinceOpen: "0.0", sinceChange: "0.0" },
        },
      })),
      marginSummary: { accountValue: String(p.free), totalNtlPos: "0.0", totalRawUsd: String(p.free), totalMarginUsed: "0.0" },
      crossMarginSummary: { accountValue: String(p.free), totalNtlPos: "0.0", totalRawUsd: String(p.free), totalMarginUsed: "0.0" },
      crossMaintenanceMarginUsed: "0.0", withdrawable: String(r6(p.free)), time: st.time,
    };
  };
  const trigRow = (o, coin, { sz, positionTpsl }) => ({
    coin, side: o.b ? "B" : "A", limitPx: o.p, sz: positionTpsl ? "0.0" : sz, oid: st.nextOid++, timestamp: st.time,
    triggerCondition: `Price ${o.t.trigger.tpsl === "tp" ? "above" : "below"} ${o.t.trigger.triggerPx}`, isTrigger: true,
    triggerPx: o.t.trigger.triggerPx, children: [], isPositionTpsl: positionTpsl, reduceOnly: o.r === true,
    orderType: o.t.trigger.tpsl === "tp" ? "Take Profit Market" : "Stop Market", origSz: positionTpsl ? "0.0" : sz, tif: null, cloid: o.c ?? null,
  });
  const err = (e) => ({ error: e });

  function runOrder(action) {
    const statuses = [];
    let parentFilled = null;
    action.orders.forEach((o, i) => {
      const m = byAsset.get(o.a);
      if (!m) { statuses.push(err(`Invalid asset ${o.a}.`)); return; }
      const coin = m.coin;
      const dex = dexOf(coin);
      const P = pot(dex);
      if (priceProblems(o.p, m.szDecimals).length) { statuses.push(err("Order has invalid price.")); return; }
      if (sizeProblems(o.s, m.szDecimals).length) { statuses.push(err("Order has invalid size.")); return; }
      if (o.t.trigger) {
        if (priceProblems(o.t.trigger.triggerPx, m.szDecimals).length) { statuses.push(err("Invalid TP/SL price.")); return; }
        if (action.grouping === "normalTpsl" && i > 0) {
          if (parentFilled == null) { statuses.push(err("Main order failed, so the TP/SL was not placed.")); return; }
          book(dex).push(trigRow(o, coin, { sz: parentFilled, positionTpsl: false }));
          statuses.push("waitingForTrigger");
          return;
        }
        const row = trigRow(o, coin, { sz: o.s, positionTpsl: action.grouping === "positionTpsl" });
        book(dex).push(row);
        statuses.push({ resting: { oid: row.oid } });
        return;
      }
      const mid = midOf(m);
      const sz = Number(o.s);
      const dir = o.b ? 1 : -1;
      const held = P.positions[coin];
      if (o.b ? Number(o.p) < mid : Number(o.p) > mid) { statuses.push(err("Order could not immediately match against any resting orders. asset=" + o.a)); return; }
      if (o.r) {
        if (!held || Math.sign(held.szi) === dir) { statuses.push(err("Reduce only order would increase position. asset=" + o.a)); return; }
        const closeSz = Math.min(sz, Math.abs(held.szi));
        const released = held.margin * (closeSz / Math.abs(held.szi));
        P.free = r6(P.free + released + (mid - held.entryPx) * closeSz * Math.sign(held.szi));
        held.szi = r10(held.szi + dir * closeSz);
        held.margin -= released;
        if (Math.abs(held.szi) < 1e-12) delete P.positions[coin];
        statuses.push({ filled: { totalSz: String(closeSz), avgPx: String(mid), oid: st.nextOid++ } });
        return;
      }
      if (sz * Math.min(mid, Number(o.p)) < 10) { statuses.push(err("Order must have minimum value of $10.")); return; }
      if (held && Math.sign(held.szi) !== dir) { statuses.push(err("FAKE: an opening order against a held position (a flip)")); return; }
      const set = st.lev.get(o.a);
      const lev = held ? held.lev : set ? set.leverage : Math.min(20, m.maxLeverage);
      const need = (sz * mid) / lev;
      if (checkMargin && P.free + 1e-9 < need) { statuses.push(err(`Insufficient margin to place order. asset=${o.a}`)); return; }
      P.free = r6(P.free - need);
      if (held) {
        held.entryPx = (Math.abs(held.szi) * held.entryPx + sz * mid) / (Math.abs(held.szi) + sz);
        held.szi = r10(held.szi + dir * sz);
        held.margin += need;
      } else {
        P.positions[coin] = { szi: dir * sz, entryPx: mid, lev, cross: !!(set && set.isCross), margin: need };
      }
      parentFilled = o.s;
      statuses.push({ filled: { totalSz: o.s, avgPx: String(mid), oid: st.nextOid++ } });
    });
    return { status: "ok", response: { type: "order", data: { statuses } } };
  }

  async function fetchImpl(url, reqInit) {
    const body = JSON.parse(reqInit.body);
    if (url === profile.infoUrl) {
      infos.push(body);
      switch (body.type) {
        case "clearinghouseState": return res(clearing(body.dex || ""));
        case "frontendOpenOrders": return res(book(body.dex || ""));
        case "activeAssetData": {
          const free = pot(dexOf(body.coin)).free;
          return res({ user: body.user, coin: body.coin, leverage: { type: "isolated", value: 5 }, maxTradeSzs: ["0.0", "0.0"], availableToTrade: [String(free), String(free)], markPx: "1.0" });
        }
        case "meta": return res({ universe: [], marginTables: [], collateralToken: 0 });
        case "spotMeta": return res({ tokens: [{ index: 0, name: "USDC", tokenId: USDC_TOKEN.split(":")[1], szDecimals: 8, weiDecimals: 8 }] });
        case "maxBuilderFee": return res(st.maxBuilderFee);
        case "orderStatus": return res({ status: "unknownOid" });
        default: return res(null);
      }
    }
    if (url === profile.exchangeUrl) {
      posts.push(body);
      const a = body.action;
      if (a.type === "order") return res(runOrder(a));
      if (a.type === "cancel") {
        const statuses = a.cancels.map(({ a: asset, o: oid }) => {
          const m = byAsset.get(asset);
          const list = m ? book(dexOf(m.coin)) : [];
          const i = list.findIndex((x) => x.oid === oid);
          if (i < 0) return { error: "Order was never placed, already canceled, or filled." };
          list.splice(i, 1);
          return "success";
        });
        return res({ status: "ok", response: { type: "cancel", data: { statuses } } });
      }
      if (a.type === "updateLeverage") { st.lev.set(a.asset, { leverage: a.leverage, isCross: a.isCross }); return res({ status: "ok", response: { type: "default" } }); }
      if (a.type === "agentSendAsset") {
        const from = pot(a.sourceDex);
        const to = pot(a.destinationDex);
        const amt = Number(a.amount);
        if (amt > from.free + 1e-9) return res({ status: "err", response: "Insufficient balance for this transfer." });
        from.free = r6(from.free - amt);
        to.free = r6(to.free + amt);
        return res({ status: "ok", response: { type: "default" } });
      }
      return res({ status: "ok", response: { type: "default" } });
    }
    throw new Error(`unexpected url ${url}`);
  }
  return { fetchImpl, posts, infos, st, profile };
}

let cloidSeq = 0;
const nextCloid = () => `0x${(++cloidSeq).toString(16).padStart(32, "0")}`;

/* The trader exactly as usePerpBackend.js builds it (feeRateOf, venueMoves), around the fake. */
async function trader({ hl = fakeHl(), builder = { address: "", feeTenthsBp: 0 }, marketHook = null } = {}) {
  const signer = await new ethers.BrowserProvider(wallet().provider).getSigner();
  const storage = memStorage();
  const now = () => T0;
  const agents = A.createAgentStore({ profile: MAIN(), storage, now });
  const nonces = NC.createNonceAllocator({ profile: MAIN(), storage, locks: null, now });
  const allIn = LV.perpFeeRateFor(O.resolveBuilder(builder));
  const market = (coin) => {
    const row = ROWS[coin];
    if (!row) return null;
    const mid = fin(hl.st.mids[coin]) ? hl.st.mids[coin] : row.midPx;
    const out = { ...row, midPx: mid, px: mid, stale: false };
    return marketHook ? marketHook(out) : out;
  };
  const t = C.createHlTrader({
    master: MASTER, signer, walletType: "privy", chainId: 42161, market, builder, profile: MAIN(),
    feeRateOf: (m) => LV.perpMarketFeeRate(m, allIn), venueMoves: MOVES_OPEN,
    deps: { fetchImpl: hl.fetchImpl, agents, nonces, randomCloid: nextCloid, now, venueCreditTries: 2, venueCreditWaitMs: 0 },
  });
  const en = await t.enableTrading();
  assert.equal(en.ok, true, JSON.stringify(en));
  hl.posts.length = 0;
  hl.infos.length = 0;
  return { t, hl, agent: en.agentAddress.toLowerCase(), market, allIn };
}

/* ── the Agent side: the backend the cards read, from the fake's own state ── */

function backendOf(hl, { feeRate = FEE } = {}) {
  const list = [];
  for (const P of Object.values(hl.st.pots)) {
    for (const [coin, q] of Object.entries(P.positions)) {
      list.push({
        coin, side: q.szi > 0 ? "long" : "short", szi: q.szi, entryPx: q.entryPx, leverage: { type: q.cross ? "cross" : "isolated", value: q.lev },
        liquidationPx: null, marginUsed: q.margin, positionValue: Math.abs(q.szi) * q.entryPx, unrealizedPnl: 0, returnOnEquity: 0, cumFunding: { sinceOpen: 0 },
      });
    }
  }
  const orders = Object.values(hl.st.orders).flat().map((o) => ({ ...o, triggerPx: Number(o.triggerPx), sz: Number(o.sz), tpsl: /take/i.test(o.orderType) ? "tp" : "sl" }));
  return {
    connected: true, mock: false, feeRate,
    account: {
      mode: { source: "perp" },
      perpBalanceUsdc: { answered: true, complete: true, source: "perp", equityUsdc: hl.st.pots[""].free, availableUsdc: hl.st.pots[""].free, holdUsdc: 0, reason: null },
      positions: { answered: true, list, byCoin: Object.fromEntries(list.map((p) => [p.coin, p])) },
      orders: { answered: true, list: orders },
      fills: { answered: true, list: [] },
    },
    quoteOpen: (a) => PB.quoteOpenLive({ ...a, feeRate: LV.perpMarketFeeRate(a.market, feeRate) }),
    quoteAdd: (a) => PB.quoteAddLive({ ...a, feeRate: LV.perpMarketFeeRate(a.market, feeRate) }),
  };
}

const snapshotOf = () => ({ markets: Object.values(ROWS), byCoin: ROWS });

/**
 * THE CARD → THE CALL: TradeCard.jsx OpenCard + trade/useOrderQuote.js, their pure
 * glue replayed line for line (P1 pins it to their source). Answers what Confirm
 * would call, or the blocker that keeps Confirm disabled.
 */
function cardCall(card, { backend, market }) {
  /* TradeCard: the Agent's leverage cap, the recommended legs, the removed flag. */
  const lev = fin(card.leverage) ? Math.min(card.leverage, GR.AGENT_MAX_LEVERAGE) : null;
  const removed = card.tpslRemoved === true;
  const tpPct = removed ? null : fin(card.tpPct) ? Math.abs(card.tpPct) : null;
  const slPct = removed ? null : fin(card.slPct) ? Math.abs(card.slPct) : null;
  /* useOrderQuote. */
  const pos = backend.account.positions.byCoin[card.coin];
  const held = pos && fin(pos.szi) && pos.szi !== 0 ? pos : null;
  const heldSide = held ? (held.side === "short" ? "sell" : "buy") : null;
  const adding = !!held && heldSide === card.side;
  const opposite = !!held && heldSide !== card.side;
  const maxLev = market ? market.maxLeverage : null;
  const leverage = adding ? held.leverage.value : TK.clampLeverage(lev == null ? TK.defaultLeverage(maxLev) : lev, maxLev);
  const amount = fin(card.marginUsdc) ? card.marginUsdc : null;
  const baseQuote = amount == null || !market || opposite ? null
    : adding ? backend.quoteAdd({ market, position: held, marginUsdc: amount })
    : backend.quoteOpen({ market, side: card.side, marginUsdc: amount, leverage });
  const feeRate = LV.perpMarketFeeRate(market, backend.feeRate);
  const risk = LV.riskView({
    side: card.side, marginUsdc: amount, leverage, market, feeRate, balanceSource: "perp",
    notionalUsd: baseQuote && baseQuote.ok ? baseQuote.notionalUsd : null, liqPx: adding ? null : undefined, marginMode: "isolated",
  });
  const basis = adding ? null : LV.tpslBasisFromQuote(baseQuote, {
    side: card.side, leverage, szDecimals: market ? market.szDecimals : null,
    markPx: market && fin(market.markPx) ? market.markPx : baseQuote && baseQuote.ok ? baseQuote.refPx : null, liqPx: risk.liqPx,
  });
  const legs = !adding;
  const tpView = LV.tpslLegView({ leg: "tp", mode: "roe", str: legs && fin(tpPct) ? `+${tpPct}` : "", basis });
  const slView = LV.tpslLegView({ leg: "sl", mode: "roe", str: legs && fin(slPct) ? `-${slPct}` : "", basis });
  const tp = legs && tpView.ok ? tpView.px : null;
  const sl = legs && slView.ok ? slView.px : null;
  const quote = baseQuote == null || adding || (tp == null && sl == null) ? baseQuote
    : backend.quoteOpen({ market, side: card.side, marginUsdc: amount, leverage, tp, sl });
  const overCap = amount != null && amount > GR.MAX_MARGIN_USDC;
  const legsBad = legs && (!!tpView.error || !!slView.error);
  let blocker = null;
  if (!market) blocker = "Loading the market";
  else if (opposite) blocker = "opposite";
  else if (amount == null) blocker = "Enter an amount in USDC";
  else if (overCap) blocker = GR.marginCapText();
  else if (quote && !quote.ok && !quote.errors) blocker = quote.message;
  else if (legsBad || (quote && !quote.ok)) blocker = "Check your TP / SL";
  const ready = !!quote && quote.ok && !blocker;
  /* TradeCard openNow: the margin sent buys the lot BELOW when the nearest lot was above it (caps.js sendMarginFor). */
  const sendLev = adding ? held.leverage.value : leverage;
  const sendMargin = ready ? CP.sendMarginFor({ marginUsdc: card.marginUsdc, leverage: sendLev, szDecimals: market.szDecimals, quote }) : card.marginUsdc;
  const call = adding
    ? { fn: "addMarket", args: { coin: card.coin, marginUsdc: sendMargin } }
    : { fn: "openMarket", args: { coin: card.coin, side: card.side, marginUsdc: sendMargin, leverage, tp, sl } };
  return { ready, blocker, call, quote, tpView, slView, tp, sl, leverage, adding, opposite, code: quote && !quote.ok ? quote.code : null };
}

/* Confirm, as TradeCard does it: only a ready card calls the backend. */
async function confirmCard(card, ctx) {
  const backend = backendOf(ctx.hl);
  const q = cardCall(card, { backend, market: ctx.market(card.coin) });
  if (!q.ready) return { sent: false, q };
  const r = await ctx.t[q.call.fn](q.call.args);
  return { sent: true, q, r };
}

/* The card a sentence makes (respond.js, the no-LLM path every shortcut takes). */
function cardFromWords(text, hl, { candles = null } = {}) {
  const snap = snapshotOf();
  const out = RS.respondLocally(text, {
    markets: snap.markets, byCoin: snap.byCoin, backend: backendOf(hl), candlesOf: () => candles, apyPct: null, tokenomist: false, earnEnabled: false,
  });
  assert.equal(out.handled, true, `"${text}" is a shortcut`);
  const msg = out.messages.find((m) => m.role === "card");
  return msg ? msg.card : null;
}

const types = (hl) => hl.posts.map((b) => b.action.type);
const orderPosts = (hl) => hl.posts.filter((b) => b.action.type === "order").map((b) => b.action);
const wireOf = (o) => ({ a: o.a, b: o.b, p: o.p, s: o.s, r: o.r, t: o.t });

/* Every order in an action, against the restated rules. */
function assertRules(action, { coin, kind, isLong, legsAfter = true, mid = null }) {
  const m = ROWS[coin];
  const assetId = expectedAssetId({ dexIndex: m.isHip3 ? XYZ_INDEX : 0, index: m.isHip3 ? m.dexAssetIndex : m.assetIndex });
  const problems = [];
  action.orders.forEach((w, i) => {
    const k = w.t.trigger ? w.t.trigger.tpsl : kind;
    problems.push(...orderProblems(w, { assetId, szDecimals: m.szDecimals, mid: mid ?? m.midPx, mark: m.markPx, kind: k, isLong }).map((p) => `#${i} ${p}`));
  });
  assert.deepEqual(problems, [], `${coin}: ${problems.join("; ")}`);
  if (legsAfter && action.orders.length > 1) assert.equal(action.grouping, kind === "open" ? "normalTpsl" : "positionTpsl");
}

/* ════════════════════════════════════════════════════════════════════════════
   A. ASSET IDS — from the fixtures, never from a table
   ════════════════════════════════════════════════════════════════════════════ */

test("A1) xyz's dex index is READ from the real perpDexs answer (1); xyz:TSLA = 100000 + 1×10000 + 1 = 110001; main ids < 10000", () => {
  assert.equal(XYZ_INDEX, 1);
  const tsla = ROWS["xyz:TSLA"];
  assert.equal(tsla.assetIndex, 110001);
  assert.equal(tsla.assetIndex, expectedAssetId({ dexIndex: XYZ_INDEX, index: tsla.dexAssetIndex }));
  assert.equal(ROWS["xyz:XYZ100"].assetIndex, 110000);
  assert.equal(ROWS["xyz:SP500"].assetIndex, 110052);
  assert.equal(ROWS.BTC.assetIndex, 0);
  assert.equal(ROWS.ETH.assetIndex, 1);
  for (const m of Object.values(ROWS)) {
    if (m.isHip3) assert.equal(m.assetIndex, expectedAssetId({ dexIndex: XYZ_INDEX, index: m.dexAssetIndex }), m.coin);
    else assert.ok(m.assetIndex >= 0 && m.assetIndex < 10_000, m.coin);
  }
  /* A stock id is never a main-dex id: 110001 is not ETH's 1. */
  assert.notEqual(ROWS["xyz:TSLA"].assetIndex % 10_000, ROWS["xyz:TSLA"].assetIndex);
});

/* ════════════════════════════════════════════════════════════════════════════
   O. OPEN
   ════════════════════════════════════════════════════════════════════════════ */

test("O1) EN \"long ETH 20 5x\": isolated 5x on asset 1 FIRST, then ONE IOC buy 0.0364 (20 × 5 / 2741.95 = 0.03647: the Agent takes the lot BELOW) @ 2879 (mid 2741.95 + 5%), signed by the agent", async () => {
  const ctx = await trader();
  const card = cardFromWords("long ETH 20 5x", ctx.hl);
  assert.deepEqual({ ...card }, { kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" });
  const { sent, r } = await confirmCard(card, ctx);
  assert.equal(sent, true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(types(ctx.hl), ["updateLeverage", "order"]);
  assert.deepEqual(ctx.hl.posts[0].action, { type: "updateLeverage", asset: 1, isCross: false, leverage: 5 });
  const order = ctx.hl.posts[1].action;
  assert.equal(order.grouping, "na");
  assert.equal("builder" in order, false, "builder off: no builder key at all");
  assert.deepEqual(order.orders.map(wireOf), [{ a: 1, b: true, p: "2879", s: "0.0364", r: false, t: { limit: { tif: "Ioc" } } }]);
  assert.match(order.orders[0].c, /^0x[0-9a-f]{32}$/, "the entry carries a cloid, so a lost reply is looked up, never re-sent");
  assertRules(order, { coin: "ETH", kind: "open", isLong: true });
  assert.deepEqual(leverageProblems(ctx.hl.posts[0].action, { assetId: 1, maxLeverage: 25, cap: 10 }), []);
  for (const b of ctx.hl.posts) assert.equal(await recoverL1(b), ctx.agent, `${b.action.type} is signed by the trading key, no wallet prompt`);
  const rb = RB.compareFill({ kind: "open", coin: "ETH", side: "buy", size: r.size, filledSz: r.filled.totalSz, szDecimals: 4, leverage: 5, tpPx: null, slPx: null }, fakeState(ctx.hl, ""), ctx.hl.st.orders[""]);
  assert.deepEqual(rb.mismatches, [], "read back: the position is what the card said");
});

test("O2) TH \"ลอง ETH 20 5x\" and \"ซื้อ ETH 20 ดอล 5x\" make the SAME card and the SAME bytes as the English", async () => {
  const bodies = [];
  for (const text of ["long ETH 20 5x", "ลอง ETH 20 5x", "ซื้อ ETH 20 ดอล 5x"]) {
    const ctx = await trader();
    const { r } = await confirmCard(cardFromWords(text, ctx.hl), ctx);
    assert.equal(r.ok, true, text);
    bodies.push(JSON.stringify(ctx.hl.posts.map((b) => ({ ...b.action, orders: b.action.orders && b.action.orders.map(wireOf) }))));
  }
  assert.equal(bodies[1], bodies[0]);
  assert.equal(bodies[2], bodies[0]);
});

test("O3) TH \"ชอร์ต SOL 15 3x tp 30 sl 10\" (ROE %): ONE normalTpsl action — IOC sell 0.38 @ 111.11, TP buy-trigger 105.26, SL buy-trigger 120.85 (rounded TOWARD the entry), both reduce-only", async () => {
  const ctx = await trader();
  const card = cardFromWords("ชอร์ต SOL 15 3x tp 30 sl 10", ctx.hl);
  assert.equal(card.side, "sell");
  assert.equal(card.tpPct, 30);
  assert.equal(card.slPct, 10);
  const { r, q } = await confirmCard(card, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  /* ROE → price on the quote's own entry (116.955) at 3x: TP 116.955 × (1 − 0.30/3) = 105.2595 → 105.26;
     SL 116.955 × (1 + 0.10/3) = 120.8535 → 120.85 (a short's stop rounds DOWN, toward the entry: never a bigger loss). */
  assert.equal(q.tp, 105.26);
  assert.equal(q.sl, 120.85);
  assert.deepEqual(types(ctx.hl), ["updateLeverage", "order"]);
  assert.deepEqual(ctx.hl.posts[0].action, { type: "updateLeverage", asset: 5, isCross: false, leverage: 3 });
  const order = ctx.hl.posts[1].action;
  assert.equal(order.grouping, "normalTpsl");
  assert.deepEqual(order.orders.map(wireOf), [
    { a: 5, b: false, p: "111.11", s: "0.38", r: false, t: { limit: { tif: "Ioc" } } },
    { a: 5, b: true, p: "105.26", s: "0.38", r: true, t: { trigger: { isMarket: true, triggerPx: "105.26", tpsl: "tp" } } },
    { a: 5, b: true, p: "120.85", s: "0.38", r: true, t: { trigger: { isMarket: true, triggerPx: "120.85", tpsl: "sl" } } },
  ]);
  assertRules(order, { coin: "SOL", kind: "open", isLong: false });
  assert.deepEqual({ ...r.tpsl }, { tp: "placed", sl: "placed" }, "the legs were read back after the fill");
  const rb = RB.compareFill({ kind: "open", coin: "SOL", side: "sell", filledSz: r.filled.totalSz, szDecimals: 2, leverage: 3, tpPx: 105.26, slPx: 120.85 }, fakeState(ctx.hl, ""), ctx.hl.st.orders[""]);
  assert.deepEqual(rb.mismatches, []);
});

test("O4) \"ขาย SOL 15 x3 คัท 10\" (Thai stop word, x3): SL only — the user's own leg, nothing recommended beside it", async () => {
  const ctx = await trader();
  const card = cardFromWords("ขาย SOL 15 x3 คัท 10", ctx.hl, { candles: candles1h(ROWS.SOL.midPx) });
  assert.equal(card.recommended, undefined, "a typed leg is the user's: no recommended TP is added");
  const { r } = await confirmCard(card, ctx);
  assert.equal(r.ok, true);
  const order = orderPosts(ctx.hl)[0];
  assert.deepEqual(order.orders.map((o) => (o.t.trigger ? o.t.trigger.tpsl : "entry")), ["entry", "sl"]);
  assert.equal(order.orders[1].t.trigger.triggerPx, "120.85");
  assertRules(order, { coin: "SOL", kind: "open", isLong: false });
});

test("O5) no TP / SL typed + the 1h chart in the tab: the RECOMMENDED legs ride the same normalTpsl action; \"no tp sl\" sends the entry alone", async () => {
  const ctx = await trader();
  const card = cardFromWords("long ETH 20 5x", ctx.hl, { candles: candles1h(ROWS.ETH.midPx) });
  assert.equal(card.recommended, true);
  assert.ok(card.tpPct > 0 && card.slPct > 0 && card.rr >= 1.9, JSON.stringify(card));
  const { r, q } = await confirmCard(card, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  const order = orderPosts(ctx.hl)[0];
  assert.equal(order.grouping, "normalTpsl");
  assert.equal(order.orders[1].t.trigger.triggerPx, String(q.tp));
  assert.equal(order.orders[2].t.trigger.triggerPx, String(q.sl));
  assertRules(order, { coin: "ETH", kind: "open", isLong: true });
  const bare = await trader();
  const none = cardFromWords("long ETH 20 5x no tp sl", bare.hl, { candles: candles1h(ROWS.ETH.midPx) });
  assert.equal(none.tpPct, null);
  await confirmCard(none, bare);
  assert.equal(orderPosts(bare.hl)[0].orders.length, 1);
});

test("O6) the model's propose_open {btc, long, 50 USDC, 25x} → a card capped to 20 USDC and 10x → isolated 10x, IOC 0.00233 @ 90017", async () => {
  const ctx = await trader();
  const p = RT.proposeAction("propose_open", { coin: "btc", side: "long", margin_usdc: 50, leverage: 25, reason: "test" }, { snapshot: snapshotOf(), backend: backendOf(ctx.hl) });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.card.marginUsdc, 20);
  assert.equal(p.card.leverage, 10);
  assert.match(p.note, /margin capped at 20 USDC, leverage capped at 10x/);
  const { r } = await confirmCard(p.card, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.hl.posts[0].action, { type: "updateLeverage", asset: 0, isCross: false, leverage: 10 });
  assert.deepEqual(orderPosts(ctx.hl)[0].orders.map(wireOf), [{ a: 0, b: true, p: "90017", s: "0.00233", r: false, t: { limit: { tif: "Ioc" } } }]);
  assertRules(orderPosts(ctx.hl)[0], { coin: "BTC", kind: "open", isLong: true });
});

test("O7) caps at the card itself: a 25x card is sent at 10x; a 50 USDC card never reaches Confirm; a setup at 7x becomes a 3x card", async () => {
  const ctx = await trader();
  const hot = { kind: "open", coin: "ETH", side: "buy", marginUsdc: 10, leverage: 25, tpPct: null, slPct: null, status: "review" };
  const { r } = await confirmCard(hot, ctx);
  assert.equal(r.ok, true);
  assert.equal(ctx.hl.posts[0].action.leverage, 10, "TradeCard clamps to AGENT_MAX_LEVERAGE before anything is quoted");
  const big = await trader();
  const over = await confirmCard({ ...hot, marginUsdc: 50, leverage: 5 }, big);
  assert.equal(over.sent, false);
  assert.match(over.q.blocker, /Max 20 USDC per order/);
  assert.equal(big.hl.posts.length, 0);
  const setup = ST.setupToOpenCard({ coin: "ETH", side: "buy", leverage: 7, marginUsdc: 50, tpPct: 12, slPct: 6, rr: 2, label: "Bolder" }, { market: ROWS.ETH });
  assert.equal(setup.leverage, 3);
  assert.equal(setup.marginUsdc, 20);
  const s = await trader();
  const done = await confirmCard(setup, s);
  assert.equal(done.r.ok, true);
  assert.equal(s.hl.posts[0].action.leverage, 3);
  assertRules(orderPosts(s.hl)[0], { coin: "ETH", kind: "open", isLong: true });
});

test("O8) the $10 minimum on the ROUNDED size: \"long ETH 1.5 5x\" ($7.50) and \"long ETH 2 5x\" (0.0036 ETH = $9.87) never reach Confirm", async () => {
  for (const text of ["long ETH 1.5 5x", "long ETH 2 5x"]) {
    const ctx = await trader();
    const { sent, q } = await confirmCard(cardFromWords(text, ctx.hl), ctx);
    assert.equal(sent, false, text);
    assert.equal(q.code, "min_value", text);
    assert.equal(ctx.hl.posts.length, 0, text);
  }
});

test("O9) builder fee ON (0.05%, already approved): {b, f:50} rides EVERY order action (entry, TP/SL group, close) and nothing else", async () => {
  const ctx = await trader({ hl: fakeHl({ maxBuilderFee: 50 }), builder: { address: BUILDER, feeTenthsBp: 50 } });
  const { r } = await confirmCard({ kind: "open", coin: "SOL", side: "sell", marginUsdc: 15, leverage: 3, tpPct: 30, slPct: 10, status: "review" }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  await ctx.t.closeFraction("SOL", 1);
  for (const b of ctx.hl.posts) {
    if (b.action.type === "order") assert.deepEqual(b.action.builder, { b: BUILDER, f: 50 }, "order");
    else assert.equal("builder" in b.action, false, b.action.type);
  }
  assert.ok(orderPosts(ctx.hl).length >= 2);
});

test("O10) the price is re-read right before signing: the mid moves 1% after the leverage update → the IOC is priced on the NEW mid", async () => {
  let calls = 0;
  const hl = fakeHl();
  const ctx = await trader({ hl, marketHook: (m) => (m.coin === "ETH" && ++calls > 1 ? { ...m, midPx: 2769.4, px: 2769.4 } : m) });
  const r = await ctx.t.openMarket({ coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  /* 100 / 2769.4 = 0.036109 → 0.0361; 2769.4 × 1.05 = 2907.87 → 2907.9. */
  assert.deepEqual(orderPosts(hl)[0].orders.map(wireOf), [{ a: 1, b: true, p: "2907.9", s: "0.0361", r: false, t: { limit: { tif: "Ioc" } } }]);
});

test("O12) TP / SL as PRICES (the trade form; a typed edit in the final view): exact ticks, an off-tick price rounded once to 5 significant figures", async () => {
  const ctx = await trader();
  const r = await ctx.t.openMarket({ coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tp: 3000, sl: 2612.345 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const order = orderPosts(ctx.hl)[0];
  assert.deepEqual(order.orders.slice(1).map((o) => [o.t.trigger.tpsl, o.t.trigger.triggerPx, o.p, o.s, o.r, o.b]), [
    ["tp", "3000", "3000", "0.0365", true, false],
    ["sl", "2612.3", "2612.3", "0.0365", true, false],
  ]);
  assertRules(order, { coin: "ETH", kind: "open", isLong: true });
});

test("O11) never sent twice: a double tap on Confirm sends ONE order; the second answers busy", async () => {
  const ctx = await trader();
  const card = { kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" };
  const q = cardCall(card, { backend: backendOf(ctx.hl), market: ctx.market("ETH") });
  const [a, b] = await Promise.all([ctx.t.openMarket(q.call.args), ctx.t.openMarket(q.call.args)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal((a.ok ? b : a).code, "busy");
  assert.equal(orderPosts(ctx.hl).length, 1);
  assert.equal(realNetworkAttempts, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   D. ADD
   ════════════════════════════════════════════════════════════════════════════ */

test("D1) the same side on a held coin is an ADD: no leverage update, IOC at the position's own 5x; fixed-size TP / SL re-placed (new first, old cancelled after)", async () => {
  const ctx = await trader();
  const open = await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: 25, slPct: 10, status: "review" }, ctx);
  assert.equal(open.r.ok, true);
  const oldOids = ctx.hl.st.orders[""].map((o) => o.oid);
  assert.equal(oldOids.length, 2, "the entry's TP and SL are on the book, sized to the entry");
  ctx.hl.posts.length = 0;
  const add = await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 10, leverage: 9, tpPct: null, slPct: null, status: "review" }, ctx);
  assert.equal(add.q.adding, true);
  assert.equal(add.r.ok, true, JSON.stringify(add.r));
  assert.deepEqual(types(ctx.hl), ["order", "order", "cancel"]);
  /* 10 USDC × the position's 5x / 2741.95 = 0.018235 → 0.0182 (not the card's 9x). */
  assert.deepEqual(ctx.hl.posts[0].action.orders.map(wireOf), [{ a: 1, b: true, p: "2879", s: "0.0182", r: false, t: { limit: { tif: "Ioc" } } }]);
  assert.equal(ctx.hl.posts[0].action.grouping, "na");
  const resize = ctx.hl.posts[1].action;
  assert.equal(resize.grouping, "positionTpsl");
  assert.deepEqual(resize.orders.map((o) => [o.t.trigger.tpsl, o.s, o.r, o.b]), [["tp", "0.0546", true, false], ["sl", "0.0546", true, false]]);
  assert.deepEqual(ctx.hl.posts[2].action.cancels.map((c) => c.o).sort(), oldOids.sort());
  assert.deepEqual(add.r.tpslResized.sort(), ["sl", "tp"]);
  const rb = RB.compareFill({ kind: "add", coin: "ETH", side: "buy", priorSzi: 0.0364, filledSz: add.r.filled.totalSz, szDecimals: 4, leverage: 5 }, fakeState(ctx.hl, ""), ctx.hl.st.orders[""]);
  assert.deepEqual(rb.mismatches, []);
});

/* ════════════════════════════════════════════════════════════════════════════
   C. CLOSE
   ════════════════════════════════════════════════════════════════════════════ */

test("C1) \"ปิดครึ่ง ETH\" → close card 50% → reduce-only IOC SELL 0.0182 (0.01825 rounded DOWN) @ 2604.9; nothing else touched", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" }, ctx);
  ctx.hl.posts.length = 0;
  const card = cardFromWords("ปิดครึ่ง ETH", ctx.hl);
  assert.deepEqual({ ...card }, { kind: "close", coin: "ETH", fraction: 0.5, status: "review" });
  const r = await ctx.t.closeFraction(card.coin, card.fraction);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(types(ctx.hl), ["order"]);
  assert.deepEqual(ctx.hl.posts[0].action.orders.map(wireOf), [{ a: 1, b: false, p: "2604.9", s: "0.0182", r: true, t: { limit: { tif: "Ioc" } } }]);
  assertRules(ctx.hl.posts[0].action, { coin: "ETH", kind: "close", isLong: true });
  const rb = RB.compareFill({ kind: "close", coin: "ETH", priorSzi: 0.0364, filledSz: r.filled.totalSz, szDecimals: 4 }, fakeState(ctx.hl, ""), ctx.hl.st.orders[""]);
  assert.deepEqual(rb.mismatches, []);
});

test("C2) \"close 30% ETH\" / \"close 99% BTC\" round the share DOWN to a detent (25% / 75%): never more than asked", () => {
  const coins = Object.keys(ROWS);
  assert.equal(SC.parseShortcut("close 30% ETH", coins).fraction, 0.25);
  assert.equal(SC.parseShortcut("ปิด ETH 30%", coins).fraction, 0.25);
  assert.equal(SC.parseShortcut("close 99% BTC", coins).fraction, 0.75);
  assert.equal(SC.parseShortcut("close 100% BTC", coins).fraction, 1);
});

test("C3) close ALL of a short with TP / SL: reduce-only IOC BUY of the EXACT size, then its triggers are cancelled; read back flat and clean", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "SOL", side: "sell", marginUsdc: 15, leverage: 3, tpPct: 30, slPct: 10, status: "review" }, ctx);
  const trig = ctx.hl.st.orders[""].map((o) => o.oid);
  ctx.hl.posts.length = 0;
  const r = await ctx.t.closeFraction("SOL", 1);
  assert.equal(r.ok, true);
  assert.equal(r.closesAll, true);
  assert.deepEqual(types(ctx.hl), ["order", "cancel"]);
  /* 116.955 × 1.05 = 122.80275 → 122.8. */
  assert.deepEqual(ctx.hl.posts[0].action.orders.map(wireOf), [{ a: 5, b: true, p: "122.8", s: "0.38", r: true, t: { limit: { tif: "Ioc" } } }]);
  assert.deepEqual(ctx.hl.posts[1].action.cancels.map((c) => c.o).sort(), trig.sort());
  const rb = RB.compareFill({ kind: "close", coin: "SOL", priorSzi: -0.38, filledSz: r.filled.totalSz, closesAll: true, szDecimals: 2 }, fakeState(ctx.hl, ""), ctx.hl.st.orders[""]);
  assert.deepEqual(rb.mismatches, []);
});

test("C4) close everything held, one by one through the SAME close path (crypto + stock): reduce-only each, the stock's money swept home last", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" }, ctx);
  await confirmCard({ kind: "open", coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2, tpPct: null, slPct: null, status: "review" }, ctx);
  ctx.hl.posts.length = 0;
  const held = backendOf(ctx.hl).account.positions.list.map((p) => p.coin);
  assert.deepEqual(held.sort(), ["ETH", "xyz:TSLA"]);
  for (const coin of held) assert.equal((await ctx.t.closeFraction(coin, 1)).ok, true, coin);
  assert.deepEqual(types(ctx.hl), ["order", "order", "agentSendAsset"]);
  for (const b of orderPosts(ctx.hl)) for (const o of b.orders) assert.equal(o.r, true, "every close is reduce-only");
  const sweep = ctx.hl.posts[2].action;
  assert.equal(sweep.sourceDex, "xyz");
  assert.equal(sweep.destinationDex, "");
  assert.equal(ctx.hl.st.pots.xyz.free, 0, "nothing left behind where the Withdraw sheet can't reach");
  assert.deepEqual(backendOf(ctx.hl).account.positions.list, []);
});

/* ════════════════════════════════════════════════════════════════════════════
   T. TP / SL ON AN OPEN POSITION
   ════════════════════════════════════════════════════════════════════════════ */

test("T1) \"tp 25 sl 10 ETH\" on a 5x long → positionTpsl [TP sell-trigger 2879, SL sell-trigger 2687.2 (rounded UP, toward the entry)], whole size, reduce-only; no cancel", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" }, ctx);
  ctx.hl.posts.length = 0;
  const card = cardFromWords("tp 25 sl 10 ETH", ctx.hl);
  assert.deepEqual({ ...card }, { kind: "tpsl", coin: "ETH", tpPct: 25, slPct: 10, status: "review" });
  const legs = tpslFromCard(card, ctx);
  assert.deepEqual(legs, { tp: 2879, sl: 2687.2 });
  const r = await ctx.t.setTpSl("ETH", legs);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(types(ctx.hl), ["order"]);
  const a = ctx.hl.posts[0].action;
  assert.equal(a.grouping, "positionTpsl");
  assert.deepEqual(a.orders.map(wireOf), [
    { a: 1, b: false, p: "2879", s: "0.0364", r: true, t: { trigger: { isMarket: true, triggerPx: "2879", tpsl: "tp" } } },
    { a: 1, b: false, p: "2687.2", s: "0.0364", r: true, t: { trigger: { isMarket: true, triggerPx: "2687.2", tpsl: "sl" } } },
  ]);
  assertRules(a, { coin: "ETH", kind: "position", isLong: true });
  const rb = RB.compareFill({ kind: "tpsl", coin: "ETH", tpPx: 2879, slPx: 2687.2, szDecimals: 4 }, fakeState(ctx.hl, ""), ctx.hl.st.orders[""]);
  assert.deepEqual(rb.mismatches, []);
});

test("T2) MOVE the stop: the new SL is placed FIRST, the old one cancelled AFTER; REMOVE the TP: a cancel and nothing else", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" }, ctx);
  await ctx.t.setTpSl("ETH", { tp: 2879, sl: 2687.2 });
  const [tpOid, slOid] = ctx.hl.st.orders[""].map((o) => o.oid);
  ctx.hl.posts.length = 0;
  const moved = await ctx.t.setTpSl("ETH", { sl: 2700 });
  assert.equal(moved.ok, true);
  assert.deepEqual(types(ctx.hl), ["order", "cancel"]);
  assert.deepEqual(ctx.hl.posts[0].action.orders.map(wireOf), [{ a: 1, b: false, p: "2700", s: "0.0364", r: true, t: { trigger: { isMarket: true, triggerPx: "2700", tpsl: "sl" } } }]);
  assert.deepEqual(ctx.hl.posts[1].action.cancels, [{ a: 1, o: slOid }]);
  ctx.hl.posts.length = 0;
  const removed = await ctx.t.setTpSl("ETH", { tp: null });
  assert.equal(removed.ok, true);
  assert.deepEqual(types(ctx.hl), ["cancel"]);
  assert.deepEqual(ctx.hl.posts[0].action.cancels, [{ a: 1, o: tpOid }]);
  const rb = RB.compareFill({ kind: "tpsl", coin: "ETH", tpPx: null, slPx: 2700, szDecimals: 4 }, fakeState(ctx.hl, ""), ctx.hl.st.orders[""]);
  assert.deepEqual(rb.mismatches, []);
});

test("T3) a TP / SL on the wrong side of the mark is refused before signing (nothing sent)", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" }, ctx);
  ctx.hl.posts.length = 0;
  const r = await ctx.t.setTpSl("ETH", { sl: 2800 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_tpsl");
  assert.equal(ctx.hl.posts.length, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   F. FLIP REFUSED — at every layer
   ════════════════════════════════════════════════════════════════════════════ */

test("F1) holding a long, \"short ETH 10 3x\": no card from the model, a blocked card from the words, and the trader itself refuses a second position", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" }, ctx);
  ctx.hl.posts.length = 0;
  const p = RT.proposeAction("propose_open", { coin: "ETH", side: "short", margin_usdc: 10, leverage: 3, reason: "x" }, { snapshot: snapshotOf(), backend: backendOf(ctx.hl) });
  assert.equal(p.ok, false);
  assert.match(p.error, /holds a ETH long/);
  const blocked = await confirmCard(cardFromWords("short ETH 10 3x", ctx.hl), ctx);
  assert.equal(blocked.sent, false);
  assert.equal(blocked.q.opposite, true);
  const direct = await ctx.t.openMarket({ coin: "ETH", side: "sell", marginUsdc: 10, leverage: 3 });
  assert.equal(direct.code, "position_exists");
  assert.equal(ctx.hl.posts.length, 0, "nothing was signed or sent");
});

/* ════════════════════════════════════════════════════════════════════════════
   S. STOCKS
   ════════════════════════════════════════════════════════════════════════════ */

test("S1) stock long xyz:TSLA 10 USDC 2x: the top-up (10.0018 = margin + fee at 0.009%) moves FIRST, then isolated 2x on 110001, then IOC buy 0.055 @ 380.67", async () => {
  const ctx = await trader();
  const { r } = await confirmCard({ kind: "open", coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2, tpPct: null, slPct: null, status: "review" }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(types(ctx.hl), ["agentSendAsset", "updateLeverage", "order"]);
  const move = ctx.hl.posts[0].action;
  assert.deepEqual({ ...move, nonce: "n" }, {
    type: "agentSendAsset", destination: MASTER.toLowerCase(), sourceDex: "", destinationDex: "xyz",
    token: USDC_TOKEN, amount: "10.0018", fromSubAccount: "", nonce: "n",
  });
  assert.equal(move.nonce, ctx.hl.posts[0].nonce, "the action's nonce IS the envelope's (docs, Agent Send Asset)");
  assert.deepEqual(ctx.hl.posts[1].action, { type: "updateLeverage", asset: 110001, isCross: false, leverage: 2 });
  assert.deepEqual(ctx.hl.posts[2].action.orders.map(wireOf), [{ a: 110001, b: true, p: "380.67", s: "0.055", r: false, t: { limit: { tif: "Ioc" } } }]);
  assertRules(ctx.hl.posts[2].action, { coin: "xyz:TSLA", kind: "open", isLong: true });
  for (const b of ctx.hl.posts) assert.equal(await recoverL1(b), ctx.agent, `${b.action.type}: the trading key, never a wallet prompt`);
  /* Every read about the stock named its dex. */
  for (const b of ctx.hl.infos.filter((x) => x.type === "clearinghouseState" || x.type === "frontendOpenOrders")) {
    assert.ok(b.dex === "xyz" || b.dex === "", JSON.stringify(b));
  }
  const rb = RB.compareFill({ kind: "open", coin: "xyz:TSLA", side: "buy", filledSz: r.filled.totalSz, szDecimals: 3, leverage: 2, tpPx: null, slPx: null }, fakeState(ctx.hl, "xyz"), ctx.hl.st.orders.xyz);
  assert.deepEqual(rb.mismatches, []);
});

test("S2) stock with TP / SL (+20% / −10% ROE at 2x): normalTpsl on 110001 — TP 398.8, SL 344.42 (a long's stop rounds UP)", async () => {
  const ctx = await trader();
  const { r, q } = await confirmCard({ kind: "open", coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2, tpPct: 20, slPct: 10, status: "review" }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([q.tp, q.sl], [398.8, 344.42]);
  const order = orderPosts(ctx.hl)[0];
  assert.equal(order.grouping, "normalTpsl");
  assert.deepEqual(order.orders.map(wireOf), [
    { a: 110001, b: true, p: "380.67", s: "0.055", r: false, t: { limit: { tif: "Ioc" } } },
    { a: 110001, b: false, p: "398.8", s: "0.055", r: true, t: { trigger: { isMarket: true, triggerPx: "398.8", tpsl: "tp" } } },
    { a: 110001, b: false, p: "344.42", s: "0.055", r: true, t: { trigger: { isMarket: true, triggerPx: "344.42", tpsl: "sl" } } },
  ]);
  assertRules(order, { coin: "xyz:TSLA", kind: "open", isLong: true });
  assert.deepEqual({ ...r.tpsl }, { tp: "placed", sl: "placed" });
});

test("S3) stock sell, all of it: reduce-only IOC sell 0.055 @ 344.42, its triggers cancelled, THEN the stock account's withdrawable swept home", async () => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2, tpPct: 20, slPct: 10, status: "review" }, ctx);
  const free = ctx.hl.st.pots.xyz.free;
  ctx.hl.posts.length = 0;
  const r = await ctx.t.closeFraction("xyz:TSLA", 1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(types(ctx.hl), ["order", "cancel", "agentSendAsset"]);
  assert.deepEqual(ctx.hl.posts[0].action.orders.map(wireOf), [{ a: 110001, b: false, p: "344.42", s: "0.055", r: true, t: { limit: { tif: "Ioc" } } }]);
  assert.equal(ctx.hl.posts[1].action.cancels.length, 2);
  const sweep = ctx.hl.posts[2].action;
  assert.deepEqual({ sourceDex: sweep.sourceDex, destinationDex: sweep.destinationDex, token: sweep.token }, { sourceDex: "xyz", destinationDex: "", token: USDC_TOKEN });
  assert.ok(Number(sweep.amount) > free, "the released margin comes home, not only the idle rest");
  assert.equal(r.collateralSwept.swept, true);
  assert.equal(ctx.hl.st.pots.xyz.free, 0);
  assert.ok(Math.abs(ctx.hl.st.pots[""].free - 1000) < 1e-6, "flat price: the Main Account is whole again");
});

test("S4) stock sell HALF: the freed margin comes home too (every position there is isolated); the rest stays open", async () => {
  const ctx = await trader();
  /* 4x: 40 / 218.05 = 0.18344 → 0.183, a size that rounds DOWN, so the exact top-up covers it (K7 is the other case). */
  const open = await confirmCard({ kind: "open", coin: "xyz:NVDA", side: "buy", marginUsdc: 10, leverage: 4, tpPct: null, slPct: null, status: "review" }, ctx);
  assert.equal(open.r.ok, true, JSON.stringify(open.r));
  assert.deepEqual(orderPosts(ctx.hl)[0].orders.map(wireOf), [{ a: 110002, b: true, p: "228.95", s: "0.183", r: false, t: { limit: { tif: "Ioc" } } }]);
  ctx.hl.posts.length = 0;
  const r = await ctx.t.closeFraction("xyz:NVDA", 0.5);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(types(ctx.hl), ["order", "agentSendAsset"]);
  const close = ctx.hl.posts[0].action.orders[0];
  assert.equal(close.a, ROWS["xyz:NVDA"].assetIndex);
  assert.equal(close.r, true);
  assert.ok(ctx.hl.st.pots.xyz.positions["xyz:NVDA"], "the other half is still open");
});

test("S5) stock caps (hip3/guard.js, by the Agent): ≤ min(10, market max) in the core session, ≤ 5x when the US market is closed, ≤ 20 USDC, ≥ $10, isolated", () => {
  const tsla = { ...ROWS["xyz:TSLA"] };
  const open = GD.checkStockOrder({ row: tsla, side: "long", marginUsdc: 10, leverage: 10, by: "agent", now: US_OPEN, listed: true });
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.equal(open.maxLeverage, 10);
  assert.equal(open.marginMode, "isolated");
  const closed = GD.checkStockOrder({ row: tsla, side: "long", marginUsdc: 10, leverage: 10, by: "agent", now: US_CLOSED, listed: true });
  assert.equal(closed.maxLeverage, 5);
  assert.deepEqual(closed.refusals, ["leverage_cap"]);
  assert.ok(closed.warnings.includes("us_market_closed"));
  const amd = GD.checkStockOrder({ row: { ...ROWS["xyz:AMD"] }, side: "long", marginUsdc: 15, leverage: 10, by: "agent", now: US_OPEN, listed: true });
  assert.equal(amd.maxLeverage, 10, "AMD's own max is 10x");
  const big = GD.checkStockOrder({ row: tsla, side: "long", marginUsdc: 50, leverage: 3, by: "agent", now: US_OPEN, listed: true });
  assert.ok(big.refusals.includes("margin_cap"));
  const tiny = GD.checkStockOrder({ row: tsla, side: "long", marginUsdc: 1, leverage: 5, by: "agent", now: US_OPEN, listed: true });
  assert.ok(tiny.refusals.includes("min_value"));
  /* And the order a 5x-capped card makes is isolated 5x on 110001. */
  const plan = O.planOpenMarket({ market: { ...tsla, stale: false }, side: "buy", marginUsdc: 10, leverage: closed.maxLeverage });
  assert.deepEqual(plan.leverageAction, { type: "updateLeverage", asset: 110001, isCross: false, leverage: 5 });
});

test("S6) every whitelisted stock in the fixture: asset id from the live dex order, isolated leverage update, a valid $11 IOC both ways and valid TP / SL ticks", (t) => {
  const names = WL.STOCK_WHITELIST.map((w) => w.coin);
  const list = Object.values(ROWS).filter((m) => m.isHip3 && names.includes(m.coin));
  assert.equal(list.length, names.length, `every whitelisted name is a live row in the fixture: ${names.filter((n) => !ROWS[n]).join(", ")}`);
  const coarse = [];
  for (const m of list) {
    const lev = Math.min(GR.AGENT_MAX_LEVERAGE, Math.floor(m.maxLeverage));
    for (const side of ["buy", "sell"]) {
      const isLong = side === "buy";
      const mid = m.midPx;
      const tp = isLong ? mid * 1.03 : mid * 0.97;
      const sl = isLong ? mid * 0.985 : mid * 1.015;
      let plan = O.planOpenMarket({ market: { ...m, stale: false }, side, marginUsdc: 11 / lev, leverage: lev, tp, sl });
      if (!plan.ok && plan.code === "min_value") {
        /* A lot worth most of $10 (SP500: 0.001 × $7,694): $11 rounds to ONE lot, under the minimum. The smallest
           order is then two lots — and it must still fit FlowFlow's caps (20 USDC × the leverage). */
        const lot = 10 ** -m.szDecimals;
        const worst = Math.min(mid, isLong ? mid * 1.05 : mid * 0.95);
        const lots = Math.ceil(10 / (lot * worst) + 1e-9);
        const notional = lots * lot * mid;
        coarse.push(`${m.coin} ${side}: $11 → 1 lot ($${(lot * mid).toFixed(2)}); smallest order ${lots} lots ≈ $${notional.toFixed(2)}`);
        assert.ok(notional <= GR.MAX_MARGIN_USDC * lev, `${m.coin}: the smallest order fits the caps`);
        plan = O.planOpenMarket({ market: { ...m, stale: false }, side, marginUsdc: (notional * 1.0001) / lev, leverage: lev, tp, sl });
      }
      assert.equal(plan.ok, true, `${m.coin} ${side}: ${plan.message}`);
      assert.deepEqual(leverageProblems(plan.leverageAction, { assetId: m.assetIndex, maxLeverage: m.maxLeverage, cap: 10 }), [], m.coin);
      assertRules(plan.action, { coin: m.coin, kind: "open", isLong });
    }
  }
  t.diagnostic(coarse.length ? `coarse lots: ${coarse.join("; ")}` : "every whitelisted stock takes an $11 order");
});

/* ════════════════════════════════════════════════════════════════════════════
   P. THE REPLAYED GLUE STILL IS THE APP'S
   ════════════════════════════════════════════════════════════════════════════ */

test("P1) the card glue replayed above matches TradeCard.jsx and useOrderQuote.js line for line (re-point this suite if the send path moves)", (t) => {
  const card = fs.readFileSync(path.join(ROOT, "src/agent/TradeCard.jsx"), "utf8");
  const quote = fs.readFileSync(path.join(ROOT, "src/trade/useOrderQuote.js"), "utf8");
  const pins = [
    [quote, /clampLeverage\(levPick == null \? defaultLeverage\(maxLev\) : levPick, maxLev\)/, "useOrderQuote: the leverage clamp"],
    [quote, /tpslLegView\(\{ leg: "tp", mode: "roe"/, "useOrderQuote: TP is ROE %"],
    [quote, /tpslLegView\(\{ leg: "sl", mode: "roe"/, "useOrderQuote: SL is ROE %"],
    [quote, /amount != null && amount > MAX_MARGIN_USDC/, "useOrderQuote: the margin cap blocks Confirm"],
    [quote, /b\.quoteOpen\(\{ market: tradeMarket, side, marginUsdc: amount, leverage, tp, sl \}\)/, "useOrderQuote: the legs are re-quoted"],
  ];
  const sendPins = [
    [card, /Math\.min\(card\.leverage, AGENT_MAX_LEVERAGE\)/, "TradeCard: the Agent's leverage cap"],
    [card, /b\.openMarket\(\{ coin: card\.coin, side: card\.side, marginUsdc: sendMargin, leverage: q\.leverage, tp: q\.tp, sl: q\.sl \}\)/, "TradeCard: the open call"],
    [card, /b\.addMarket\(\{ coin: card\.coin, marginUsdc: sendMargin \}\)/, "TradeCard: the add call"],
    [card, /sendMarginFor\(\{ marginUsdc: sendMargin, leverage: sendLev, szDecimals: q\.sz, quote: fresh \}\)/, "TradeCard: the margin rounds the size down"],
    [card, /addCapCheck\(\{ coin: card\.coin, position: q\.held, market: live, now: Date\.now\(\) \}\)/, "TradeCard: an add is capped at the send"],
    [card, /b\.closeFraction\(card\.coin, fraction\)/, "TradeCard: the close call"],
  ];
  for (const [src, re, what] of pins) assert.match(src, re, what);
  const moved = sendPins.filter(([src, re]) => !re.test(src)).map(([, , what]) => what);
  if (moved.length) {
    /* Item 17 (the final chart popup) moves the send out of the card. The bytes are still checked through the
       trader above; only this replay's last step needs re-pointing at the new file. */
    const agentDir = path.join(ROOT, "src/agent");
    const files = fs.readdirSync(agentDir, { recursive: true }).filter((f) => /\.(jsx?|mjs)$/.test(f));
    const sends = files.filter((f) => /\.openMarket\(/.test(fs.readFileSync(path.join(agentDir, f), "utf8")));
    assert.ok(sends.length > 0, "no file in src/agent sends an open any more");
    t.todo(`the send moved (${moved.join("; ")}): now in ${sends.join(", ")} — re-point cardCall() at it`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   K. NOT BUILT YET, OR KNOWN WRONG — each a TODO with its concrete failing case
   (node --test prints them; they do not fail the run; each is a "needs" item)
   ════════════════════════════════════════════════════════════════════════════ */

test("K1) risk-based plan_trade → card → the EXACT action: the stop / TP / size the card's maths shows are the ones sent (items 13/14/16)", async (t) => {
  let TP = null;
  try { TP = await import(SRC("agent/tradePlan.js")); } catch (e) { TP = null; }
  if (!TP || typeof TP.planTradeToolCall !== "function") { t.todo("src/agent/tradePlan.js planTradeToolCall is not there yet: nothing to drive"); return; }
  const issues = [];
  const cases = [
    { args: { coin: "ETH", side: "short", risk_usd: 15, balance_usd: 300, rr: 2 }, coin: "ETH", why: "\"มี 300 ยอมเสียได้ 15 ดอล short ETH RR 2\" — over the 20 USDC cap: a capped card" },
    { args: { coin: "SOL", side: "long", risk_usd: 1 }, coin: "SOL", why: "\"risk $1\" — fits the caps" },
    { args: { coin: "TSLA", side: "long", risk_usd: 3 }, coin: "xyz:TSLA", why: "a stock, US market open" },
  ];
  for (const k of cases) {
    const ctx = await trader();
    const out = await TP.planTradeToolCall({
      snapshot: snapshotOf(), backend: backendOf(ctx.hl), now: () => US_OPEN,
      fetchCandles: async (coin, interval, { bars } = {}) => candles1h(ROWS[coin].midPx, { n: bars || 48, end: US_OPEN }),
    }, k.args);
    const card = out.card;
    if (!card) { issues.push(`${k.why}: no card (${JSON.stringify(out.result).slice(0, 200)})`); continue; }
    /* 🔴 the caps, strictly */
    assert.equal(card.kind, "open");
    assert.equal(card.coin, k.coin, k.why);
    assert.ok(card.marginUsdc > 0 && card.marginUsdc <= GR.MAX_MARGIN_USDC, `${k.why}: margin ${card.marginUsdc}`);
    assert.ok(Number.isInteger(card.leverage) && card.leverage >= 1 && card.leverage <= GR.AGENT_MAX_LEVERAGE, `${k.why}: leverage ${card.leverage}`);
    const { sent, r, q } = await confirmCard(card, ctx);
    if (!sent) { issues.push(`${k.why}: the plan's card never reaches Confirm (${q.blocker})`); continue; }
    if (!r.ok) { issues.push(`${k.why}: the plan's card was refused at send: ${r.code} ${r.message}`); continue; }
    const order = orderPosts(ctx.hl)[0];
    assertRules(order, { coin: k.coin, kind: "open", isLong: card.side === "buy" });
    const lev = ctx.hl.posts.find((b) => b.action.type === "updateLeverage").action;
    assert.deepEqual(lev, { type: "updateLeverage", asset: ROWS[k.coin].assetIndex, isCross: false, leverage: card.leverage });
    /* the maths shown = the order sent */
    const plan = card.plan || {};
    const long = card.side === "buy";
    const sentSz = order.orders[0].s;
    const sl = order.orders.find((o) => o.t.trigger && o.t.trigger.tpsl === "sl");
    const tp = order.orders.find((o) => o.t.trigger && o.t.trigger.tpsl === "tp");
    if (fin(plan.size) && Number(sentSz) !== plan.size) issues.push(`${k.why}: the card says size ${plan.size}, the order sends ${sentSz}`);
    if (!sl) issues.push(`${k.why}: no stop loss was sent`);
    else if (fin(plan.slPx) && (long ? Number(sl.t.trigger.triggerPx) < plan.slPx - 1e-9 : Number(sl.t.trigger.triggerPx) > plan.slPx + 1e-9)) {
      issues.push(`${k.why}: the stop sent (${sl.t.trigger.triggerPx}) is WIDER than the card's maths (${plan.slPx})`);
    }
    if (tp && fin(plan.tpPx)) {
      const tick = 10 ** -Math.max(0, 6 - ROWS[k.coin].szDecimals);
      const rel = Math.abs(Number(tp.t.trigger.triggerPx) - plan.tpPx) / plan.tpPx;
      if (rel > 2e-4 && Math.abs(Number(tp.t.trigger.triggerPx) - plan.tpPx) > tick * 1.5) issues.push(`${k.why}: TP sent ${tp.t.trigger.triggerPx}, the card's maths ${plan.tpPx}`);
    }
    if (sl && fin(plan.lossAtStopUsd) && fin(plan.entryPx)) {
      const lossSent = Number(sentSz) * Math.abs(plan.entryPx - Number(sl.t.trigger.triggerPx));
      if (lossSent > plan.lossAtStopUsd + 0.01) issues.push(`${k.why}: the loss at the stop sent is $${lossSent.toFixed(2)}, the card says $${plan.lossAtStopUsd}`);
    }
    if (k.coin.includes(":")) assert.equal(ctx.hl.posts[0].action.type, "agentSendAsset", "a stock's money moves first");
    t.diagnostic(`${k.coin} ${card.side} ${card.leverage}x margin ${card.marginUsdc} → sent ${sentSz} @ ${order.orders[0].p}, SL ${sl ? sl.t.trigger.triggerPx : "—"} (card ${plan.slPx}), TP ${tp ? tp.t.trigger.triggerPx : "—"} (card ${plan.tpPx}), loss at stop $${plan.lossAtStopUsd}${plan.capped ? ` (capped: ${plan.capped.why}, real risk $${plan.capped.realRiskUsd} of $${plan.capped.wantedRiskUsd})` : ""}`);
  }
  if (issues.length) t.todo(issues.join(" | "));
});

test("K2) \"ปิดทุก position\" / \"close all\" → ONE close-all card for every position (item 7)", async (t) => {
  const ctx = await trader();
  await confirmCard({ kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: null, slPct: null, status: "review" }, ctx);
  const snap = snapshotOf();
  /* The close-all is read BEFORE the shortcuts (agent.js preIntent → closeAll.js), then made by the same code the
     model's close_all runs (runTool proposeCloseAll). */
  const intent = CA.detectCloseAll("ปิดทุก position", { coins: snap.markets.filter((m) => !m.coin.includes(":")).map((m) => m.coin) });
  assert.deepEqual([intent.kind, intent.coins], ["closeAll", null]);
  const b = backendOf(ctx.hl);
  const acc = { ...b.account, positions: { ...b.account.positions, complete: true } };
  const p = RT.proposeCloseAll({ coins: intent.coins }, { snapshot: snap, backend: { ...b, connected: true, account: acc } });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.card.kind, "closeAll");
});

test("K3) the Agent routes stocks: \"long TSLA 10 10x\" while the US market is closed → an xyz:TSLA card at ≤ 5x (item 2 / S3)", (t) => {
  const backend = { connected: true, feeRate: FEE, account: { positions: { byCoin: {} }, perpBalanceUsdc: { answered: true, complete: true, source: "perp", availableUsdc: 100 } }, quoteOpen: (a) => PB.quoteOpenLive(a), quoteAdd: (a) => PB.quoteAddLive(a) };
  const realNow = Date.now;
  Date.now = () => US_CLOSED;
  let p;
  try {
    p = RT.proposeAction("propose_open", { coin: "TSLA", side: "long", margin_usdc: 10, leverage: 10, reason: "x" }, { snapshot: snapshotOf(), backend, now: () => US_CLOSED });
  } finally {
    Date.now = realNow;
  }
  if (!p.ok && /No market called/.test(p.error || "")) { t.todo(`stocks are not routed yet: propose_open TSLA → ${p.error}`); return; }
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.card.coin, "xyz:TSLA");
  assert.ok(p.card.leverage <= 5, `closed-market cap: card leverage ${p.card.leverage}x`);
});

test("K4) a model close of 30% (propose_close fraction 0.3) must not become a close of ALL", (t) => {
  const backend = { account: { positions: { byCoin: { ETH: { coin: "ETH", szi: 0.1, side: "long" } } } } };
  const p = RT.proposeAction("propose_close", { coin: "ETH", fraction: 0.3 }, { snapshot: snapshotOf(), backend });
  if (p.ok && p.card.fraction === 1) {
    t.todo("runTool.js proposeAction maps any fraction off [0.25,0.5,0.75,1] to 1: \"close 30%\" from the model shows an All card (the words path rounds DOWN to 25%)");
    return;
  }
  assert.ok(p.card.fraction <= 0.3);
});

test("K5) phrasing the card misreads: a PRICE TP / SL, a SIZE in coins, a $ NOTIONAL", (t) => {
  const coins = Object.keys(ROWS);
  const misreads = [];
  const price = SC.parseShortcut("long BTC 20 5x tp 90000 sl 80000", coins);
  if (price.tpPct === 90000) misreads.push("\"tp 90000 sl 80000\" read as ROE % (TP +90000%, SL −80000%): a price is not a percent");
  const size = SC.parseShortcut("long 0.5 ETH 5x", coins);
  if (size.marginUsdc === 0.5) misreads.push("\"long 0.5 ETH 5x\" (a size in ETH) read as 0.5 USDC margin");
  const notional = SC.parseShortcut("long ETH 100 dollar position 10x", coins);
  if (notional.marginUsdc === 100) misreads.push("\"long ETH 100 dollar position 10x\" (a $100 position) read as 100 USDC margin → capped 20 × 10x = $200: twice the exposure asked");
  if (misreads.length) { t.todo(misreads.join(" | ")); return; }
});

test("K6) size rounds DOWN to the lot, so 20 USDC of margin never buys more than 20 USDC × leverage", (t) => {
  const over = [];
  for (const [coin, lev] of [["ETH", 5], ["xyz:XYZ100", 10], ["xyz:SP500", 10]]) {
    const m = { ...ROWS[coin], stale: false };
    const plan = O.planOpenMarket({ market: m, side: "buy", marginUsdc: 20, leverage: lev });
    const used = (Number(plan.size) * m.midPx) / lev;
    if (used > 20 + 1e-9) over.push(`${coin} 20 USDC ${lev}x → size ${plan.size} = ${used.toFixed(4)} USDC of margin`);
  }
  /* The Agent's send (TradeCard openNow) takes the lot BELOW whenever the nearest was above (caps.js sendMarginFor):
     its orders never use more than the card's margin. */
  for (const [coin, lev] of [["ETH", 5], ["xyz:XYZ100", 10], ["xyz:SP500", 10]]) {
    const m = { ...ROWS[coin], stale: false };
    const plan = O.planOpenMarket({ market: m, side: "buy", marginUsdc: 20, leverage: lev });
    const send = CP.sendMarginFor({ marginUsdc: 20, leverage: lev, szDecimals: m.szDecimals, quote: { size: Number(plan.size), refPx: plan.refPx } });
    const plan2 = O.planOpenMarket({ market: m, side: "buy", marginUsdc: send, leverage: lev });
    assert.ok(send <= 20, `${coin}: ${send}`);
    assert.ok((Number(plan2.size) * m.midPx) / lev <= 20 + 1e-9, `${coin} ${lev}x: the Agent's send uses ${(Number(plan2.size) * m.midPx / lev).toFixed(4)} USDC`);
  }
  if (over.length) { t.todo(`orders.js planOpenMarket / planAddMarket still round to NEAREST for every other caller (the Agent's own send rounds down): ${over.join("; ")}`); return; }
});

test("K7) a stock's top-up covers the order Hyperliquid will margin (the rounded size), not only the typed margin", async (t) => {
  const ctx = await trader({ hl: fakeHl({ checkMargin: true }) });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 3 });
  if (!r.ok && r.code === "insufficient_margin") {
    const moved = ctx.hl.posts.find((b) => b.action.type === "agentSendAsset").action.amount;
    const sz = Number(orderPosts(ctx.hl)[0].orders[0].s);
    const back = ctx.hl.posts.filter((b) => b.action.type === "agentSendAsset").map((b) => `${b.action.sourceDex || "main"}→${b.action.destinationDex || "main"} ${b.action.amount}`);
    assert.equal(ctx.hl.st.pots.xyz.free, 0, "the refused order's top-up came home");
    t.todo(`client.js fundVenueOrder moves ${moved} for 10 USDC × 3x, but the IOC carries ${sz} TSLA = ${(sz * ROWS["xyz:TSLA"].midPx / 3).toFixed(4)} USDC of margin at the mid (${(sz * Number(orderPosts(ctx.hl)[0].orders[0].p) / 3).toFixed(4)} at the limit price): "Insufficient margin" (if Hyperliquid margins the fill as this fake does), moves ${back.join(", ")}`);
    return;
  }
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("K8) the send layer itself refuses a margin over 20 USDC (defense in depth for the final popup's Edit)", async (t) => {
  const ctx = await trader();
  const r = await ctx.t.openMarket({ coin: "ETH", side: "buy", marginUsdc: 100, leverage: 5 });
  if (r.ok) { t.todo("createHlTrader.openMarket / perpBackend createLiveActions send a 100 USDC order: the 20 USDC cap lives only in the card and the ticket"); return; }
  assert.equal(r.ok, false);
});

/* ── helpers that need the imports ── */

/* The fake's clearinghouseState for one dex, as Hyperliquid answers it. */
function fakeState(hl, dex) {
  const p = hl.st.pots[dex] || { free: 0, positions: {} };
  return {
    assetPositions: Object.entries(p.positions).map(([coin, q]) => ({ type: "oneWay", position: { coin, szi: String(q.szi), leverage: q.cross ? { type: "cross", value: q.lev } : { type: "isolated", value: q.lev, rawUsd: "0" }, entryPx: String(q.entryPx), liquidationPx: null } })),
    withdrawable: String(p.free),
  };
}

/* What the TP / SL card sends (TpSlEditor in PositionsPanel.jsx): ROE % on the position's own basis. */
function tpslFromCard(card, ctx) {
  const pos = backendOf(ctx.hl).account.positions.byCoin[card.coin];
  const m = ctx.market(card.coin);
  const basis = LV.tpslBasisFromPosition(pos, { szDecimals: m.szDecimals, markPx: m.markPx });
  const tp = card.tpPct != null ? LV.tpslLegView({ leg: "tp", mode: "roe", str: `+${card.tpPct}`, basis }) : null;
  const sl = card.slPct != null ? LV.tpslLegView({ leg: "sl", mode: "roe", str: `-${card.slPct}`, basis }) : null;
  const out = {};
  if (tp) { assert.equal(tp.ok, true, tp.error); out.tp = tp.px; }
  if (sl) { assert.equal(sl.ok, true, sl.error); out.sl = sl.px; }
  return out;
}

/* n hourly candles (48 by default) around a price with a ~1% range, ending at `end`: enough for setups.js's 14-bar
   range, and for a stock, a week of them puts real US core-session hours in the window. */
function candles1h(px, { n = 48, end = T0 } = {}) {
  const out = [];
  const last = Math.floor(end / 3_600_000) * 3_600_000;
  for (let i = 0; i < n; i++) {
    const o = px * (1 + Math.sin(i / 3) * 0.004);
    const c = px * (1 + Math.sin((i + 1) / 3) * 0.004);
    out.push({ time: last - (n - i) * 3_600_000, open: o, high: Math.max(o, c) * 1.003, low: Math.min(o, c) * 0.997, close: c, volume: 1000 });
  }
  return out;
}

const sigHex = (s) => viem.serializeSignature({ r: s.r, s: s.s, v: BigInt(s.v) });
async function recoverL1(body) {
  const hash = S.hlActionHash({ action: body.action, nonce: body.nonce });
  return (await viem.recoverTypedDataAddress({
    domain: { ...S.HL_L1_DOMAIN },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent", message: { source: "a", connectionId: hash }, signature: sigHex(body.signature),
  })).toLowerCase();
}
