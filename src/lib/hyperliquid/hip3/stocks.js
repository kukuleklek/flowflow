// ─────────────────────────────────────────────────────────────────────────────
// Stock perp rows: one HIP-3 dex's metaAndAssetCtxs, read for a Stocks list.
// ─────────────────────────────────────────────────────────────────────────────
//
// ../markets.js already turns a venue's table into the shared market rows that
// the chart, the ticket and the positions read (one store, MONEY_RULES 1). This
// file does NOT replace that. It reads the same answer for what only a stock
// list and its guard need, and the shared rows never carry:
//
//   margin     meta.universe marginMode, measured 2026-10-15 on xyz: ABSENT on
//              the majors (TSLA, NVDA, AAPL, MSFT, GOOGL, AMZN, META, SP500,
//              XYZ100, GOLD: cross allowed — public traders hold xyz:TSLA
//              "cross" 20x), "noCross" with onlyIsolated true on the rest, and
//              "strictIsolated" on every live io market and mkts:USBOND.
//              FlowFlow opens every position isolated anyway (orders.js
//              isCross:false); strictIsolated also means margin cannot be taken
//              back out of the position, which the plan's Add/Remove margin must
//              respect.
//   spread     assetCtxs impactPxs [bid, ask]: the prices a market order of the
//              impact notional would fill at. (ask - bid) / mark in basis points
//              is the honest "how much does crossing cost here" figure the
//              whitelist gate reads. Not top of book: l2Book has that, one call
//              per coin, and the gate does not need it.
//   oi cap     perpDexLimits coinToOiCap (USD notional), or perpDexs
//              assetToStreamingOiCap when limits were not read. Same numbers on
//              2026-10-15 for every xyz market.
//   oracle gap (mark - oracle) / oracle in basis points. The deployer pushes
//              the oracle; when the stock market is shut the mark can walk away
//              from it, and that is a risk the market page shows.
//   fee        the docs' own developer formula (trading/fees, "Fee formula for
//              developers", read 2026-10-15): scaleIfHip3 = scale < 1 ?
//              scale + 1 : scale * 2, and growthModeScale = growthMode ? 0.1 : 1.
//              xyz stocks ship scale "1.0" with growth mode on, so 2 * 0.1 =
//              0.2 times the base taker rate: 0.009% at tier 0, inside the docs'
//              "between 0.0045%-0.009%". venues.js still reads growth mode as
//              unknown (it predates that formula); the plan's patch P1 brings
//              it to this one so the ticket and the list cannot disagree.
//
// UNKNOWN IS NULL, never 0 (MONEY_RULES 0). Every number in the answer is a
// string; an unreadable one is null and so is anything derived from it.

import { hlAssetId } from "../venues.js";
import { splitHlMarket } from "../coins.js";
import { oiCapUse } from "./dexes.js";

const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const bps = (a, b) => (a != null && b != null && b > 0 ? ((a - b) / b) * 10_000 : null);

/** "cross" (cross allowed), "isolated" (noCross / onlyIsolated) or "strictIsolated". Unknown string -> "isolated". */
export function marginKind(u) {
  const m = u && typeof u.marginMode === "string" ? u.marginMode : null;
  if (m === "strictIsolated") return "strictIsolated";
  if (m === "noCross" || (u && u.onlyIsolated === true)) return "isolated";
  if (m == null) return "cross";
  /* A mode this code has not met: the strictest reading that still trades. */
  return "isolated";
}

/* growthMode: "enabled" on most xyz markets, absent on xyz:GOLD and xyz:MSTR. */
function growthOf(u) {
  if (!u || !("growthMode" in u)) return false;
  if (typeof u.growthMode === "string") return u.growthMode !== "" && u.growthMode !== "disabled";
  return u.growthMode === true;
}

/** Growth mode's fee factor (docs, trading/fees developer formula). */
export const GROWTH_MODE_FEE_SCALE = 0.1;

/**
 * How many times the account's own taker rate a HIP-3 market charges, by the
 * docs' formula, or null when the fee scale cannot be read.
 */
export function hip3TakerFeeMultiplier({ feeScale = null, growthMode = false } = {}) {
  const s = typeof feeScale === "number" && Number.isFinite(feeScale) && feeScale >= 0 ? feeScale : null;
  if (s == null) return null;
  const scaleIfHip3 = s < 1 ? s + 1 : s * 2;
  const m = scaleIfHip3 * (growthMode ? GROWTH_MODE_FEE_SCALE : 1);
  return Number.isFinite(m) && m > 0 ? m : null;
}

/* coinToOiCap: [["xyz:AAPL", "200000000.0"], ...] */
function limitCaps(limits) {
  const out = new Map();
  const list = limits && Array.isArray(limits.coinToOiCap) ? limits.coinToOiCap : [];
  for (const e of list) if (Array.isArray(e) && typeof e[0] === "string" && num(e[1]) != null) out.set(e[0], num(e[1]));
  return out;
}

/**
 * One dex's [meta, assetCtxs] -> stock rows (delisted rows dropped, but they
 * keep their place: the asset id counts them).
 *
 * @param {any} json metaAndAssetCtxs answered with { dex }
 * @param {{ dex: string, dexIndex: number, dexInfo?: object|null, limits?: object|null, now?: number }} o
 *   dexIndex  the position in THIS session's perpDexs answer (dexes.js)
 *   dexInfo   parseDexes() row, for the streaming OI caps and the funding multiplier
 *   limits    perpDexLimits answer for the dex, preferred for the caps
 * @returns {{ rows: object[], byCoin: Map<string, object>, universe: object[], delisted: number, refused: number, collateralToken: number|null }}
 */
export function parseStockRows(json, { dex, dexIndex, dexInfo = null, limits = null, now = 0 } = {}) {
  const empty = { rows: [], byCoin: new Map(), universe: [], delisted: 0, refused: 0, collateralToken: null };
  if (!Array.isArray(json) || json.length < 2 || typeof dex !== "string" || !dex) return empty;
  if (!Number.isSafeInteger(dexIndex) || dexIndex < 1) return empty;
  const [meta, ctxs] = json;
  const uni = meta && Array.isArray(meta.universe) ? meta.universe : null;
  if (!uni) return empty;
  const caps = limitCaps(limits);
  const streamCaps = dexInfo && dexInfo.oiCapUsd instanceof Map ? dexInfo.oiCapUsd : new Map();
  const fundMult = dexInfo && dexInfo.fundingMultiplier instanceof Map ? dexInfo.fundingMultiplier : new Map();
  const rows = [];
  const byCoin = new Map();
  let delisted = 0;
  let refused = 0;
  uni.forEach((u, i) => {
    if (!u || typeof u.name !== "string") { refused++; return; }
    if (u.isDelisted === true) { delisted++; return; }
    const { dex: d, base } = splitHlMarket(u.name);
    /* A name from another dex inside this answer is a mix-up we refuse to route. */
    if (d !== dex || !base) { refused++; return; }
    const assetId = hlAssetId({ dexIndex, assetIndex: i });
    if (assetId == null) { refused++; return; }
    const c = Array.isArray(ctxs) ? ctxs[i] : null;
    const markPx = num(c && c.markPx);
    const oraclePx = num(c && c.oraclePx);
    const midPx = num(c && c.midPx);
    const prevDayPx = num(c && c.prevDayPx);
    const openInterest = num(c && c.openInterest);
    const ip = c && Array.isArray(c.impactPxs) && c.impactPxs.length === 2 ? c.impactPxs.map(num) : [null, null];
    const px = midPx ?? markPx;
    const oiUsd = openInterest != null && markPx != null ? openInterest * markPx : null;
    const capUsd = caps.has(u.name) ? caps.get(u.name) : streamCaps.has(u.name) ? streamCaps.get(u.name) : null;
    const feeScale = num(u.deployerFeeScale);
    const growthMode = growthOf(u);
    const margin = marginKind(u);
    const row = Object.freeze({
      coin: u.name,
      ticker: base,
      dex,
      dexIndex,
      localIndex: i,
      assetId,
      szDecimals: Number.isSafeInteger(u.szDecimals) ? u.szDecimals : null,
      maxLeverage: num(u.maxLeverage),
      margin,
      crossAllowed: margin === "cross",
      canRemoveMargin: margin !== "strictIsolated",
      marginTableId: num(u.marginTableId),
      feeScale,
      growthMode,
      takerFeeMultiplier: hip3TakerFeeMultiplier({ feeScale, growthMode }),
      fundingMultiplier: fundMult.has(u.name) ? fundMult.get(u.name) : null,
      markPx,
      oraclePx,
      midPx,
      px,
      prevDayPx,
      change24hPct: px != null && prevDayPx != null && prevDayPx > 0 ? ((px - prevDayPx) / prevDayPx) * 100 : null,
      funding: num(c && c.funding),
      premium: num(c && c.premium),
      openInterest,
      openInterestUsd: oiUsd,
      dayNtlVlm: num(c && c.dayNtlVlm),
      impactBidPx: ip[0],
      impactAskPx: ip[1],
      impactSpreadBps: ip[0] != null && ip[1] != null && markPx != null && markPx > 0 && ip[1] >= ip[0] ? ((ip[1] - ip[0]) / markPx) * 10_000 : null,
      markOracleGapBps: bps(markPx, oraclePx),
      oiCapUsd: capUsd,
      oiCapUse: oiCapUse(oiUsd, capUsd),
      at: now,
    });
    rows.push(row);
    byCoin.set(row.coin, row);
  });
  return {
    rows,
    byCoin,
    universe: uni,
    delisted,
    refused,
    collateralToken: meta && Number.isSafeInteger(meta.collateralToken) ? meta.collateralToken : null,
  };
}

/**
 * allMids { dex } -> Map(coin -> mid). Keys arrive qualified ("xyz:TSLA"); a key
 * of another dex, or an unreadable price, is skipped.
 */
export function parseDexMids(json, dex) {
  const out = new Map();
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [k, v] of Object.entries(json)) {
    const { dex: d, base } = splitHlMarket(k);
    if (d !== dex || !base) continue;
    const p = num(v);
    if (p != null && p > 0) out.set(k, p);
  }
  return out;
}

/** A row with a newer mid: px and the 24h change follow it; the mark stays the exchange's mark. */
export function withMid(row, mid, at = null) {
  const p = num(mid);
  if (!row || p == null || p <= 0) return row;
  const base = row.prevDayPx;
  return Object.freeze({
    ...row,
    midPx: p,
    px: p,
    change24hPct: base != null && base > 0 ? ((p - base) / base) * 100 : null,
    at: at == null ? row.at : at,
  });
}

/**
 * perpsAtOpenInterestCap -> Set of coins that take no new opening orders now.
 * Measured 2026-10-15: [] for xyz; seven bare names (CANTO, FTM, ... ZEREBRO)
 * for the main dex.
 */
export function parseAtCap(json) {
  return new Set(Array.isArray(json) ? json.filter((c) => typeof c === "string" && c) : []);
}
