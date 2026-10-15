// ─────────────────────────────────────────────────────────────────────────────
// The HIP-3 reads: every /info ask the Stocks plan needs, READ-ONLY.
// ─────────────────────────────────────────────────────────────────────────────
//
// One injectable info client (default: ../info.js hlInfo — one POST, a hard
// timeout, no retries, identical asks in flight shared). Each read answers
// { ok: true, value } or { ok: false, error }: never a throw, never a guess.
// Nothing here signs or sends an action; /exchange is not reachable from here.
//
// Bodies, as measured live 2026-10-15 (fixtures in scripts/fixtures/hip3/):
//   perpDexs                      {type}                         index = position
//   metaAndAssetCtxs              {type, dex}                    [meta, ctxs]
//   allMids                       {type, dex}                    qualified keys
//   perpDexLimits                 {type, dex}                    OI caps (USD)
//   perpsAtOpenInterestCap        {type, dex}                    coins at cap
//   candleSnapshot                {type, req:{coin,...}}         qualified coin, no dex
//   clearinghouseState            {type, user, dex}              this dex's pot only
//   frontendOpenOrders            {type, user, dex}              this dex's orders only
//   activeAssetData               {type, user, coin}             qualified coin, no dex
//   userAbstraction               {type, user}                   the account mode
// An unknown dex name answers HTTP 500 (measured), which is why reads take dex
// names only from a live perpDexs answer.
//
// Weights (info.js has the table): metaAndAssetCtxs and candleSnapshot 20,
// allMids 2, the user reads 2–20. The Stocks tab adds ONE metaAndAssetCtxs a
// minute for xyz, which the market store already makes today.

import { hlInfo } from "../info.js";
import { parseHlCandles } from "../candles.js";
import { parseDexes } from "./dexes.js";
import { parseAtCap, parseDexMids, parseStockRows } from "./stocks.js";
import { parseDexUserState } from "./pots.js";
import { screenStocks, STOCK_DEX } from "./whitelist.js";

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const errText = (e) => String((e && e.message) || e || "unknown error");
const INTERVALS = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);

/**
 * @param {{ info?: (body: object) => Promise<any>, now?: () => number }} [deps]
 */
export function createHip3Reader({ info = hlInfo, now = () => Date.now() } = {}) {
  async function ask(body, parse) {
    let json;
    try {
      json = await info(body);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const value = parse(json);
    return value == null ? { ok: false, error: `unreadable answer to ${body.type}` } : { ok: true, value };
  }

  /* A dex name must look like one before it is sent anywhere. */
  const dexOk = (d) => typeof d === "string" && /^[a-z0-9]{1,16}$/.test(d);
  const bad = (what) => Promise.resolve({ ok: false, error: `bad ${what}` });

  return {
    /** Every HIP-3 dex with its live index. */
    dexes: () => ask({ type: "perpDexs" }, (j) => (Array.isArray(j) ? parseDexes(j) : null)),

    /** One dex's stock rows. dexIndex comes from dexes() in the same session. */
    markets(dex, { dexIndex, dexInfo = null, limits = null } = {}) {
      if (!dexOk(dex)) return bad("dex");
      return ask({ type: "metaAndAssetCtxs", dex }, (j) => {
        if (!Array.isArray(j) || j.length < 2) return null;
        const r = parseStockRows(j, { dex, dexIndex, dexInfo, limits, now: now() });
        return r.universe.length ? r : null;
      });
    },

    mids: (dex) => (dexOk(dex) ? ask({ type: "allMids", dex }, (j) => (j && typeof j === "object" ? parseDexMids(j, dex) : null)) : bad("dex")),

    limits: (dex) => (dexOk(dex) ? ask({ type: "perpDexLimits", dex }, (j) => (j && typeof j === "object" && !Array.isArray(j) ? j : null)) : bad("dex")),

    atCap: (dex) => (dexOk(dex) ? ask({ type: "perpsAtOpenInterestCap", dex }, (j) => (Array.isArray(j) ? parseAtCap(j) : null)) : bad("dex")),

    /** Candles for a qualified coin ("xyz:TSLA"); time in SECONDS, as the chart reads them. */
    candles(coin, interval, { startTime, endTime } = {}) {
      if (typeof coin !== "string" || !coin.includes(":")) return bad("coin");
      if (!INTERVALS.has(interval)) return bad("interval");
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return bad("time range");
      return ask({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, (j) => (Array.isArray(j) ? parseHlCandles(j) : null));
    },

    /** One dex's pot for a MASTER address (an API wallet's address answers empty). */
    userDex(user, dex) {
      if (!isAddr(user)) return bad("address");
      if (!dexOk(dex)) return bad("dex");
      return ask({ type: "clearinghouseState", user: user.toLowerCase(), dex }, (j) => parseDexUserState(j, { dex }));
    },

    /** Every listed dex's pot, answered in parallel; a dex that fails is { dex, state: null }. */
    async userDexes(user, dexNames) {
      const names = Array.isArray(dexNames) ? dexNames.filter(dexOk) : [];
      const out = await Promise.all(names.map(async (dex) => {
        const r = await this.userDex(user, dex);
        return { dex, state: r.ok ? r.value : null, error: r.ok ? null : r.error };
      }));
      return { ok: true, value: out };
    },

    userOrders(user, dex) {
      if (!isAddr(user)) return bad("address");
      if (!dexOk(dex)) return bad("dex");
      return ask({ type: "frontendOpenOrders", user: user.toLowerCase(), dex }, (j) => (Array.isArray(j) ? j : null));
    },

    /** What Hyperliquid says a NEW order on this coin may use: on a dex pot, the pot's money. */
    activeAsset(user, coin) {
      if (!isAddr(user)) return bad("address");
      if (typeof coin !== "string" || !coin.includes(":")) return bad("coin");
      return ask({ type: "activeAssetData", user: user.toLowerCase(), coin }, (j) => {
        if (!j || typeof j !== "object" || !Array.isArray(j.availableToTrade) || j.availableToTrade.length !== 2) return null;
        const a = j.availableToTrade.map(Number);
        const lev = j.leverage && typeof j.leverage === "object" ? j.leverage : {};
        return {
          coin: j.coin === coin ? coin : null,
          /* The pair's order is undocumented; the smaller is used, as client.js does. */
          availableUsdc: a.every(Number.isFinite) ? Math.max(0, Math.min(a[0], a[1])) : null,
          leverageType: lev.type === "cross" || lev.type === "isolated" ? lev.type : null,
          leverage: Number.isFinite(Number(lev.value)) ? Number(lev.value) : null,
        };
      });
    },

    mode: (user) => (isAddr(user) ? ask({ type: "userAbstraction", user: user.toLowerCase() }, (j) => (typeof j === "string" && j ? j : null)) : bad("address")),

    /**
     * The Stocks list in one go: perpDexs (for the index), then the dex's limits,
     * table and at-cap list in parallel, then the whitelist screen. Limits or the
     * at-cap list failing does not sink the list: their figures go unknown and
     * the gate holds what it cannot check (unknown never passes).
     * @returns {Promise<{ ok: true, value: { dex, dexIndex, listed, held, rows, universe, collateralToken, at } }|{ ok: false, error: string }>}
     */
    async stocks({ dex = STOCK_DEX, whitelist, gates } = {}) {
      const d = await this.dexes();
      if (!d.ok) return d;
      const live = d.value.byName.get(dex);
      if (!live) return { ok: false, error: `${dex} is not listed by Hyperliquid right now` };
      const [lim, cap] = await Promise.all([this.limits(dex), this.atCap(dex)]);
      const m = await this.markets(dex, { dexIndex: live.index, dexInfo: live, limits: lim.ok ? lim.value : null });
      if (!m.ok) return m;
      const s = screenStocks(m.value.byCoin, { whitelist, gates, atCap: cap.ok ? cap.value : null });
      return {
        ok: true,
        value: {
          dex, dexIndex: live.index, listed: s.listed, held: s.held, rows: m.value.rows,
          universe: m.value.universe, collateralToken: m.value.collateralToken, at: now(),
        },
      };
    },
  };
}
