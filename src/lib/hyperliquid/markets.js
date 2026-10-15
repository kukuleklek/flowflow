// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid perp markets: the table, the one store, and its two hooks.
// ─────────────────────────────────────────────────────────────────────────────
//
// SOURCE. POST /info {type:"metaAndAssetCtxs"} answers [meta, assetCtxs]:
// meta.universe[i] describes asset i (name, szDecimals, maxLeverage, isDelisted,
// onlyIsolated, marginMode) and assetCtxs[i] is its market (markPx, midPx,
// oraclePx, prevDayPx, funding, openInterest, dayNtlVlm, premium ...). Measured
// live 2026-09-22: every number is a STRING; 56 of the 234 main-dex assets carry
// isDelisted:true and are dropped here; a delisted asset's midPx is null.
//
// The symbol table is built at RUNTIME, never hardcoded: assetIndex is the
// position in the FULL universe (delisted rows included), which is the asset id
// an order will need, and it differs between mainnet and testnet.
//
// HIP-3 VENUES. Beside Hyperliquid's own markets are dexes deployed by third
// parties, and they are where the TradFi markets live — shares, indices, metals,
// currencies (the owner's Stock chip). Each listed venue (venues.js HIP3_VENUES)
// costs ONE more metaAndAssetCtxs per refresh, plus one shared perpDexs, and its
// rows join the same store. Three things a venue row must carry and a main-dex
// row need not:
//
//   • its ASSET ID is not its position in its own universe. It is
//     100000 + the venue's index in the LIVE perpDexs answer * 10000 + that
//     position, computed every refresh by venues.js hlAssetId() and never
//     written down — a stale index is an order for the wrong market. A row
//     whose id cannot be computed is DROPPED, not listed;
//   • its NAME is qualified, "xyz:TSLA", which is what candles, activeAssetCtx,
//     fills and positions all answer to (measured 2026-09-23). That whole name
//     is row.coin, so the chart, the ticket and the position page speak one
//     name; row.label is the bare ticker a row shows;
//   • it is run by SOMEBODY, who sets its price feed, can halt it, can settle
//     it, and charges their own fee. row.isHip3, row.venueName and the fee
//     multiplier carry that; the fee's dash is the only thing the UI says of it.
//
// A venue that fails to answer keeps the rows it had (its prices still stream)
// and is reported in venueErrors; a venue that has never answered contributes
// no rows at all. The main dex is unaffected either way.
//
// ONE STORE. MONEY_RULES section 1: two surfaces showing the same figure must be
// incapable of disagreeing. The market list (usePerpMarkets) and the single
// market page (usePerpMarket) therefore read the same rows from the same store;
// there is no second copy of a price anywhere to drift.
//
// THE PRICE ON SCREEN is `px`: the latest mid (the allMids stream for the list,
// activeAssetCtx for one market), falling back to the mark. The 24h change is
// computed from that same px, so a price and its change cannot contradict each
// other. markPx stays the exchange's MARK — the price liquidations use — and is
// never overwritten with a mid: a field called mark that held a mid would lie.
//
// UNKNOWN IS NULL (MONEY_RULES section 0). An unreadable or missing field is
// null, never 0; a measured zero (prevDayPx "0.0") stays 0. Derived figures are
// null when an input is.
//
// NOT HAMMERING (owner rule 4). The table is fetched once per mount burst, then
// refreshed every PERP_MARKETS_REFRESH_MS only while a list is shown AND the tab
// is visible; live prices come over the tab's one WebSocket (ws.js). A mount in
// a hidden tab still makes its ONE first fetch (useTokenFeed's rule); after that
// a hidden tab fetches nothing, and coming back refreshes at once if one is due.
// With one venue listed a refresh is three requests — the main table, perpDexs,
// the venue's table — about 60 of the 1200 weight a minute an IP is allowed
// (info.js has the table), and one more pair for each venue added later.
//
// STALE. When the stream stops (reconnecting, paused while hidden, released),
// the snapshot says so (stale / isPerpMarketStale) until something fresh lands.
// What to draw for a stale figure is the page's call — the data layer only
// refuses to pretend.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { hlInfo } from "./info.js";
import { hlWs } from "./ws.js";
import { browserTimers, browserNow, docHidden, onDocVisibility } from "./browser.js";
import { splitHlMarket } from "./coins.js";
import { perpCategoryOf } from "./perpCategories.js";
import {
  HIP3_VENUES, HL_MAIN_DEX, hlAssetId, isHlHip3AssetId, isHlMainAssetId, resolveVenues,
  venueTakerFeeMultiplier,
} from "./venues.js";

export const PERP_MARKETS_REFRESH_MS = 60_000;

/** The store's key for the main dex: Hyperliquid's own empty dex name. */
const MAIN = HL_MAIN_DEX;

const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const CTX_KEYS = ["markPx", "midPx", "oraclePx", "prevDayPx", "funding", "premium", "openInterest", "dayNtlVlm"];

function ctxFields(ctx) {
  const out = {};
  for (const k of CTX_KEYS) out[k] = ctx && typeof ctx === "object" ? num(ctx[k]) : null;
  return out;
}

/* Everything computed from the raw fields, in one place. */
function derive(row) {
  const px = row.midPx ?? row.markPx ?? null;
  const base = row.prevDayPx;
  const hasBase = px != null && base != null && base > 0;
  return {
    ...row,
    px,
    change24hUsd: hasBase ? px - base : null,
    change24hPct: hasBase ? ((px - base) / base) * 100 : null,
    openInterestUsd: row.openInterest != null && row.markPx != null ? row.openInterest * row.markPx : null,
  };
}

const EMPTY = Object.freeze({ markets: [], byCoin: Object.freeze(Object.create(null)), universeSize: 0, delistedCount: 0, refusedCount: 0 });

/* GROWTH MODE is a per-asset discount of "at least 90%" (docs): a range, not a
   number. Any value but an explicit "disabled" counts as on, so an unrecognised
   one leaves the fee unknown rather than confidently wrong. */
function growthOn(u) {
  if (typeof u.growthMode === "string") return u.growthMode !== "" && u.growthMode !== "disabled";
  return u.growthMode === true;
}

/* MARGIN TIERS. meta.marginTables is [[id, { marginTiers: [{ lowerBound,
   maxLeverage }] }], ...], bounds as STRINGS of USD notional. Past a tier's
   lowerBound Hyperliquid allows less leverage (table 51: 10x, then 5x from $3M),
   which the ticket's one-tier liquidation estimate cannot express. A table id
   under 50 is not listed: it is ONE tier at that leverage (checked live
   2026-09-22, all 198 such rows have maxLeverage equal to their id). A table
   that cannot be read leaves the row's tiers unknown (null), never guessed. */
function readMarginTables(meta) {
  const out = new Map();
  const list = meta && Array.isArray(meta.marginTables) ? meta.marginTables : [];
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const id = num(entry[0]);
    const raw = entry[1] && Array.isArray(entry[1].marginTiers) ? entry[1].marginTiers : null;
    if (id == null || !raw || !raw.length) continue;
    const tiers = raw.map((t) => ({ lowerBound: num(t && t.lowerBound), maxLeverage: num(t && t.maxLeverage) }));
    if (tiers.some((t) => t.lowerBound == null || t.lowerBound < 0 || t.maxLeverage == null || t.maxLeverage < 1)) continue;
    tiers.sort((a, b) => a.lowerBound - b.lowerBound);
    out.set(id, Object.freeze(tiers.map((t) => Object.freeze(t))));
  }
  return out;
}

function marginTiersFor(tables, u) {
  const id = num(u.marginTableId);
  if (id == null) return null;
  if (tables.has(id)) return tables.get(id);
  if (Number.isInteger(id) && id >= 1 && id < 50) return Object.freeze([Object.freeze({ lowerBound: 0, maxLeverage: id })]);
  return null;
}

/**
 * metaAndAssetCtxs -> market rows (delisted dropped, unsafe asset ids dropped).
 * Row: { coin, label, dex, venueName, isHip3, category, assetIndex,
 *        dexAssetIndex, szDecimals, maxLeverage, onlyIsolated, marginMode,
 *        strictIsolated, marginTiers ([{ lowerBound, maxLeverage }] ascending,
 *        or null), feeScale, growthMode, takerFeeMultiplier,
 *        markPx, midPx, oraclePx, prevDayPx, funding, premium, openInterest,
 *        dayNtlVlm, px, change24hUsd, change24hPct, openInterestUsd, at }
 *
 * assetIndex IS THE ASSET ID an order carries: the universe position on the main
 * dex, and 100000 + venue index * 10000 + universe position on a HIP-3 venue.
 * dexAssetIndex is the position within that venue's own universe.
 *
 * @param {any} json the [meta, assetCtxs] answer
 * @param {{ now?: number, dex?: string|null, dexIndex?: number,
 *   venueName?: string|null, venueCategory?: string|null }} [opts]
 *   dex names the HIP-3 venue this answer is for; dexIndex is its position in
 *   the LIVE perpDexs answer. A HIP-3 answer with no usable index parses to
 *   nothing: an id is never guessed.
 * @returns {{ markets: object[], byCoin: Record<string, object>, universeSize: number,
 *   delistedCount: number, refusedCount: number }}
 */
export function parsePerpMarkets(json, { now = 0, dex = null, dexIndex = 0, venueName = null, venueCategory = null } = {}) {
  if (!Array.isArray(json) || json.length < 2) return EMPTY;
  const [meta, ctxs] = json;
  const uni = meta && Array.isArray(meta.universe) ? meta.universe : null;
  if (!uni) return EMPTY;
  const venue = typeof dex === "string" && dex !== MAIN ? dex : null;
  if (venue && !(Number.isSafeInteger(dexIndex) && dexIndex > 0)) return EMPTY;
  const list = Array.isArray(ctxs) ? ctxs : [];
  const tables = readMarginTables(meta);
  const markets = [];
  const byCoin = Object.create(null);
  let delistedCount = 0;
  let refusedCount = 0;
  uni.forEach((u, i) => {
    if (!u || typeof u.name !== "string" || !u.name) return;
    if (u.isDelisted === true) { delistedCount++; return; }
    /* THE ID, or nothing at all. */
    const assetIndex = hlAssetId({ dexIndex: venue ? dexIndex : 0, assetIndex: i });
    if (assetIndex == null || (venue ? !isHlHip3AssetId(assetIndex) : !isHlMainAssetId(assetIndex))) { refusedCount++; return; }
    /* THE NAME must belong to the answer it came in: a qualified name on the
       main dex, or another venue's name inside this venue, is a mix-up we
       refuse rather than route. */
    const parts = splitHlMarket(u.name);
    const qualified = u.name.includes(":");
    if (venue ? parts.dex !== venue || !parts.base : qualified) { refusedCount++; return; }
    const label = parts.base || u.name;
    const sz = num(u.szDecimals);
    const marginMode = typeof u.marginMode === "string" ? u.marginMode : null;
    const growthMode = growthOn(u);
    const feeScale = num(u.deployerFeeScale);
    const fee = venueTakerFeeMultiplier({ isHip3: !!venue, feeScale, growthMode });
    const row = derive({
      coin: u.name,
      label,
      dex: venue,
      venueName: venue ? venueName || venue : null,
      isHip3: !!venue,
      category: perpCategoryOf(u.name, { dex: venue, base: label, venueCategory }),
      assetIndex,
      dexAssetIndex: i,
      szDecimals: sz != null && Number.isInteger(sz) && sz >= 0 ? sz : null,
      maxLeverage: num(u.maxLeverage),
      onlyIsolated: u.onlyIsolated === true,
      marginMode,
      /* Hyperliquid spells isolated-only two ways (strictIsolated on the main
         dex, noCross on a venue); onlyIsolated is the flag both set. */
      strictIsolated: marginMode === "strictIsolated" || marginMode === "noCross",
      marginTiers: marginTiersFor(tables, u),
      /* feeScale and growthMode are Hyperliquid's own facts, kept as the
         multiplier's audit trail. Of the helper's answer only the MULTIPLIER
         lands on the row: perpTakerFeeRate reads it, and its null IS the
         ticket's dash (MONEY_RULES section 0). The reason string beside it had
         exactly one reader, the notice this screen no longer shows, so it is
         not stored - a field with a writer and no reader is how dead config
         starts here. */
      feeScale,
      growthMode,
      takerFeeMultiplier: fee.multiplier,
      ...ctxFields(list[i]),
      at: now,
    });
    markets.push(row);
    byCoin[row.coin] = row;
  });
  return { markets, byCoin, universeSize: uni.length, delistedCount, refusedCount };
}

/**
 * Fold an allMids push ({coin: "midString"}) into the rows. Moves midPx, px and
 * the 24h change; never touches markPx. Spot ("@1", "PURR/USDC") and outcome
 * ("#12090") keys match no perp row and are ignored, as are unreadable values.
 *
 * The main dex's push and a venue's push carry different names ("BTC" against
 * "xyz:TSLA", measured), so a key cannot cross dexes on its own; `dex` says so
 * out loud as well, and leaving it out applies the push by name alone.
 * @returns {{ markets: object[], changed: boolean }} the same array when nothing changed
 */
export function applyMids(markets, mids, at = 0, { dex } = {}) {
  if (!Array.isArray(markets) || !mids || typeof mids !== "object") return { markets, changed: false };
  /* undefined: no filter. "" (the main dex) and null both mean the rows with no
     dex of their own. */
  const only = dex === undefined ? undefined : dex || null;
  let changed = false;
  const out = markets.map((m) => {
    if (only !== undefined && (m.dex || null) !== only) return m;
    if (!Object.prototype.hasOwnProperty.call(mids, m.coin)) return m;
    const v = num(mids[m.coin]);
    if (v == null || v === m.midPx) return m;
    changed = true;
    return derive({ ...m, midPx: v, at });
  });
  return changed ? { markets: out, changed } : { markets, changed: false };
}

/** Fold an activeAssetCtx ctx into one row. Keys absent from ctx keep their value. Same row back when nothing changed. */
export function applyAssetCtx(row, ctx, at = 0) {
  if (!row || !ctx || typeof ctx !== "object") return row;
  const next = { ...row };
  let changed = false;
  for (const k of CTX_KEYS) {
    if (!(k in ctx)) continue;
    const v = num(ctx[k]);
    if (v !== row[k]) { next[k] = v; changed = true; }
  }
  if (!changed) return row;
  next.at = at;
  return derive(next);
}

/** Highest 24h notional volume first; unknown volume last. A new array. */
export function rankPerpMarkets(markets) {
  return [...(markets || [])].sort((a, b) => (b.dayNtlVlm ?? -1) - (a.dayNtlVlm ?? -1));
}

/**
 * Is this coin's row possibly out of date? True when the stream stopped after
 * the row was last refreshed and nothing fresh has reached it since.
 */
export function isPerpMarketStale(snapshot, coin) {
  if (!snapshot || snapshot.staleSince == null) return false;
  const t = snapshot.coinFreshAt ? snapshot.coinFreshAt[coin] : undefined;
  return !(t > snapshot.staleSince);
}

const messageOf = (e) => String((e && e.message) || e || "unknown error");

/**
 * The market store. Dependencies are injectable for the node suite; the app
 * uses perpMarketsStore().
 */
export function createPerpMarketsStore({
  info = hlInfo,
  ws = null,
  getWs = null,
  timers = browserTimers,
  now = browserNow,
  isHidden = docHidden,
  onVisibilityChange = onDocVisibility,
  refreshMs = PERP_MARKETS_REFRESH_MS,
  venues: wanted = HIP3_VENUES,
} = {}) {
  const sock = () => (ws || (getWs ? getWs() : hlWs()));
  const wantVenues = (Array.isArray(wanted) ? wanted : []).filter((v) => v && typeof v.dex === "string" && v.dex);

  let rows = [];
  let byCoin = Object.create(null);
  let ready = false;
  let loading = false;
  let error = null;
  let updatedAt = null;
  let staleSince = null;
  let coinFreshAt = Object.create(null);
  /* dex key ("" for the main dex) -> its parsed rows, so one venue's failure
     cannot take another venue's rows down with it. */
  const rowsByDex = new Map();
  let venues = [];              // the live, resolved venues of the last good perpDexs
  let venueErrors = Object.create(null);

  const listeners = new Set();
  let snap = null;
  const build = () => Object.freeze({
    markets: rows, byCoin, ready, loading, error, updatedAt,
    stale: staleSince != null, staleSince, coinFreshAt,
    venues, venueErrors,
  });
  snap = build();
  function emit() {
    snap = build();
    for (const fn of [...listeners]) { try { fn(); } catch { /* a listener's own */ } }
  }

  let listCount = 0;
  let commonCount = 0;
  let coinTotal = 0;
  const coinSubs = new Map();   // coin -> { n, off }
  const midSubs = new Map();    // dex key -> off
  let offStatus = null;
  let offVis = null;
  let pollT = null;
  let inflight = null;
  let lastFetchAt = null;       // when the last table request was SENT
  const lastMids = new Map();   // dex key -> { mids, at }
  const lastCtx = new Map();    // coin -> { ctx, at }
  let midsFreshDex = new Set(); // dex keys that have pushed since the stream stopped

  const clear = (id) => { if (id != null) timers.clearTimeout(id); return null; };
  const needPoll = () => listCount > 0 || (coinTotal > 0 && !ready);

  function setByCoinFromRows() {
    const m = Object.create(null);
    for (const r of rows) m[r.coin] = r;
    byCoin = m;
  }

  /* Main dex first, then the venues in the order this build lists them. */
  function rebuildRows() {
    const out = [];
    if (rowsByDex.has(MAIN)) out.push(...rowsByDex.get(MAIN));
    for (const v of wantVenues) if (rowsByDex.has(v.dex)) out.push(...rowsByDex.get(v.dex));
    rows = out;
    setByCoinFromRows();
  }

  function markStale() {
    if (!rows.length || staleSince != null) return false;
    staleSince = now();
    coinFreshAt = Object.create(null);
    midsFreshDex = new Set();
    return true;
  }

  function clearStale() {
    staleSince = null;
    coinFreshAt = Object.create(null);
    midsFreshDex = new Set();
  }

  /* Stream data newer than a table request must win over that table's answer,
     or a slow refresh rolls a live price back. Applied oldest first. */
  function replayLive(since) {
    const events = [];
    for (const [dexKey, e] of lastMids) {
      if (e.at < since) continue;
      events.push({ at: e.at, apply: () => { const r = applyMids(rows, e.mids, e.at, { dex: dexKey }); rows = r.markets; } });
    }
    for (const [coin, e] of lastCtx) {
      if (e.at < since) continue;
      events.push({ at: e.at, apply: () => { rows = rows.map((r) => (r.coin === coin ? applyAssetCtx(r, e.ctx, e.at) : r)); } });
    }
    events.sort((a, b) => a.at - b.at);
    for (const ev of events) ev.apply();
  }

  function schedulePoll() {
    pollT = clear(pollT);
    if (!needPoll() || isHidden()) return;
    const wait = lastFetchAt == null ? 0 : Math.max(0, lastFetchAt + refreshMs - now());
    pollT = timers.setTimeout(() => {
      pollT = null;
      if (!needPoll() || isHidden()) return;
      refresh();
    }, wait);
  }

  const ask = (body) => {
    try { return Promise.resolve(info(body)); } catch (e) { return Promise.reject(e); }
  };

  /**
   * One refresh: the main table, and — when this build lists venues — the live
   * perpDexs order followed by one table per listed venue. The venue tables wait
   * for perpDexs because their asset ids are computed from that order; nothing
   * here ever assumes an index.
   */
  async function loadAll(startedAt) {
    const [mainR, dexsR] = await Promise.all([
      ask({ type: "metaAndAssetCtxs" }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      wantVenues.length
        ? ask({ type: "perpDexs" }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
        : Promise.resolve({ ok: true, v: null }),
    ]);

    if (mainR.ok) {
      const parsed = parsePerpMarkets(mainR.v, { now: now() });
      if (!parsed.markets.length) throw new Error("Hyperliquid answered an unexpected market table");
      rowsByDex.set(MAIN, parsed.markets);
    }

    const errs = Object.create(null);
    if (dexsR.ok && dexsR.v != null) {
      const live = resolveVenues(dexsR.v, wantVenues);
      /* A venue that is no longer listed loses its rows: nothing of it is live. */
      const names = new Set(live.map((v) => v.dex));
      for (const key of [...rowsByDex.keys()]) if (key !== MAIN && !names.has(key)) rowsByDex.delete(key);
      venues = live;
      const answers = await Promise.all(live.map((v) => ask({ type: "metaAndAssetCtxs", dex: v.dex })
        .then((json) => ({ v, json }), (e) => ({ v, e }))));
      for (const a of answers) {
        if (a.e) { errs[a.v.dex] = messageOf(a.e); continue; }
        const parsed = parsePerpMarkets(a.json, {
          now: now(), dex: a.v.dex, dexIndex: a.v.index, venueName: a.v.fullName || a.v.dex, venueCategory: a.v.category,
        });
        if (!parsed.markets.length) { errs[a.v.dex] = `Hyperliquid answered no live markets for ${a.v.dex}`; continue; }
        rowsByDex.set(a.v.dex, parsed.markets);
      }
      syncMidSubs();
    } else if (!dexsR.ok) {
      /* No fresh order: the venues keep the rows and the ids they already had
         (their prices still stream), and this says the table is old. Rows are
         never built on a remembered order — only on one that answered. */
      errs["*"] = messageOf(dexsR.e);
    }
    venueErrors = Object.freeze(errs);

    /* Rows first, the failure after: a main table that did not answer must not
       cost a venue the rows it just sent, and whatever rows we hold stay up. */
    rebuildRows();
    replayLive(startedAt);
    setByCoinFromRows();   // replayLive rewrites rows; the index must follow them
    if (!mainR.ok) throw mainR.e;
    ready = true;
    error = null;
    updatedAt = now();
    if (staleSince != null && startedAt >= staleSince) clearStale();
  }

  function refresh() {
    if (inflight) return inflight;
    const startedAt = now();
    lastFetchAt = startedAt;
    loading = true;
    emit();
    inflight = loadAll(startedAt).catch((e) => {
      /* Keep whatever rows we had; the error is reported beside them. */
      error = messageOf(e);
    }).finally(() => {
      loading = false;
      inflight = null;
      emit();
      schedulePoll();
    });
    return inflight;
  }

  /* The dex keys a list surface streams: the main dex plus every resolved venue. */
  function streamedDexKeys() {
    return [MAIN, ...venues.map((v) => v.dex)];
  }

  /* ONE allMids stream per dex on show, all on the tab's one socket (owner rule:
     one WebSocket per tab — this adds subscriptions, never a second socket). A
     venue's stream starts as soon as perpDexs has confirmed the venue is live. */
  function syncMidSubs() {
    if (listCount <= 0) return;
    const want = streamedDexKeys();
    for (const key of want) {
      if (midSubs.has(key)) continue;
      const sub = key === MAIN ? { type: "allMids" } : { type: "allMids", dex: key };
      midSubs.set(key, sock().subscribe(sub, (d) => onMids(key, d)));
    }
    for (const [key, off] of [...midSubs]) {
      if (want.includes(key)) continue;
      if (off) off();
      midSubs.delete(key);
    }
  }

  function dropMidSubs() {
    for (const [key, off] of [...midSubs]) { if (off) off(); midSubs.delete(key); }
  }

  function onMids(dexKey, data) {
    const mids = data && data.mids;
    if (!mids || typeof mids !== "object") return;
    /* A venue's push names its dex; the main dex's push names none. */
    const pushed = typeof data.dex === "string" && data.dex ? data.dex : MAIN;
    if (pushed !== dexKey) return;
    const at = now();
    lastMids.set(dexKey, { mids, at });
    let changed = false;
    if (rows.length) {
      const r = applyMids(rows, mids, at, { dex: dexKey });
      if (r.changed) { rows = r.markets; setByCoinFromRows(); changed = true; }
    }
    /* allMids is every mid of ONE dex at once, so that dex is fresh again; the
       list stops being flagged only once every dex it streams has spoken. */
    if (staleSince != null) {
      midsFreshDex.add(dexKey);
      if (streamedDexKeys().every((k) => midsFreshDex.has(k))) clearStale();
      changed = true;
    }
    if (changed) emit();
  }

  function onCtx(coin, data) {
    if (!data || data.coin !== coin || !data.ctx || typeof data.ctx !== "object") return;
    const at = now();
    lastCtx.set(coin, { ctx: data.ctx, at });
    let changed = false;
    const row = byCoin[coin];
    if (row) {
      const next = applyAssetCtx(row, data.ctx, at);
      if (next !== row) {
        rows = rows.map((r) => (r === row ? next : r));
        setByCoinFromRows();
        changed = true;
      }
    }
    if (staleSince != null && !(coinFreshAt[coin] > staleSince)) {
      coinFreshAt = Object.assign(Object.create(null), coinFreshAt, { [coin]: at });
      changed = true;
    }
    if (changed) emit();
  }

  function onWsStatus(s) {
    if ((s === "reconnecting" || s === "paused" || s === "idle") && markStale()) emit();
  }

  function onVis() {
    if (isHidden()) { pollT = clear(pollT); return; }
    if (inflight || !needPoll()) return;
    if (!ready || lastFetchAt == null || now() - lastFetchAt >= refreshMs) refresh();
    else schedulePoll();
  }

  function attachCommon() {
    if (commonCount++ > 0) return;
    offStatus = sock().onStatus(onWsStatus);
    offVis = onVisibilityChange(onVis);
  }

  function detachCommon() {
    if (--commonCount > 0) return;
    if (offStatus) { offStatus(); offStatus = null; }
    if (offVis) { offVis(); offVis = null; }
    pollT = clear(pollT);
    /* Nobody maintains these rows any more; the next surface sees them flagged
       until fresh data lands. */
    if (markStale()) emit();
  }

  function retainList() {
    attachCommon();
    listCount++;
    if (listCount === 1) {
      syncMidSubs();
      /* The MOUNT fetch happens even in a hidden tab (useTokenFeed's rule): one
         request so the first paint has rows. Only the repeat waits for visible. */
      if (!inflight) {
        if (!ready || lastFetchAt == null || now() - lastFetchAt >= refreshMs) refresh();
        else schedulePoll();
      }
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      listCount--;
      if (listCount === 0) {
        dropMidSubs();
        if (!needPoll()) pollT = clear(pollT);
      }
      detachCommon();
    };
  }

  function retainCoin(coin) {
    if (!coin || typeof coin !== "string") return () => {};
    attachCommon();
    coinTotal++;
    let rec = coinSubs.get(coin);
    if (!rec) { rec = { n: 0, off: null }; coinSubs.set(coin, rec); }
    if (rec.n++ === 0) rec.off = sock().subscribe({ type: "activeAssetCtx", coin }, (d) => onCtx(coin, d));
    if (!ready && !inflight) refresh();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      coinTotal--;
      if (--rec.n === 0) {
        if (rec.off) rec.off();
        coinSubs.delete(coin);
        lastCtx.delete(coin);
      }
      if (!needPoll()) pollT = clear(pollT);
      detachCommon();
    };
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    getSnapshot: () => snap,
    retainList,
    retainCoin,
    refresh,
  };
}

let defaultStore = null;

/** The app's one market store (created on first use, not on import). */
export function perpMarketsStore() {
  if (!defaultStore) defaultStore = createPerpMarketsStore({ info: hlInfo, getWs: hlWs });
  return defaultStore;
}

/**
 * Every live perp market — Hyperliquid's own and the listed HIP-3 venues' —
 * streamed.
 * @returns {{ markets: object[], byCoin: Record<string, object>, ready: boolean,
 *   loading: boolean, error: string|null, updatedAt: number|null, stale: boolean,
 *   staleSince: number|null, coinFreshAt: Record<string, number>,
 *   venues: Array<{ dex: string, index: number, fullName: string|null, category: string }>,
 *   venueErrors: Record<string, string> }}
 *   markets are in listing order, main dex first; rankPerpMarkets() sorts by
 *   volume and filterPerpMarkets() cuts them to one category.
 */
export function usePerpMarkets() {
  const store = perpMarketsStore();
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.retainList(), [store]);
  return snap;
}

/**
 * One market, streamed (activeAssetCtx) into the same store the list reads.
 * @param {string} coin the market name, exactly as listed ("BTC", "kPEPE",
 *   "xyz:TSLA" — activeAssetCtx answers to the qualified name, verified
 *   read-only 2026-09-23)
 * @returns {{ market: object|null, ready: boolean, loading: boolean,
 *   error: string|null, stale: boolean, updatedAt: number|null }}
 *   ready && !market means the coin is not a live market of any listed dex.
 */
export function usePerpMarket(coin) {
  const store = perpMarketsStore();
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => (coin ? store.retainCoin(coin) : undefined), [store, coin]);
  const market = (coin && snap.byCoin[coin]) || null;
  const stale = !!market && isPerpMarketStale(snap, coin);
  return useMemo(
    () => ({ market, ready: snap.ready, loading: snap.loading, error: snap.error, stale, updatedAt: snap.updatedAt }),
    [market, snap.ready, snap.loading, snap.error, stale, snap.updatedAt],
  );
}
