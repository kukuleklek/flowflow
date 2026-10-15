/**
 * test-hl-markets-venues — THE HIP-3 VENUES: the asset id, the name, the venue
 * facts, and the one store that now holds more than one dex.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-23: "ขอเป็นหมวดด้วยดิ Perp: Crypto l Stock I Meme ... ใน Stock
 * มีแบบ S&p500, Trad fi ต่างๆ" — the Stock chip holds the TradFi markets, and
 * those live on HIP-3 venues, not on Hyperliquid's own dex.
 *
 * THE ASSET ID IS THE DANGEROUS PART, so it is what most of this suite is about.
 * xyz:TSLA is asset 110001; the bare number 1 is main-dex ETH. An order carries
 * the number, not the name. Every test below that looks pedantic is standing
 * between a Tesla long and somebody's ether.
 *
 * FIXTURES, captured READ-ONLY on 2026-09-23 (POST /info, two bodies, and two
 * short wss subscriptions whose findings are noted where they are used). No
 * order, transfer, approval or signature was sent, and no key exists here:
 *
 *   scripts/fixtures/hl-perp-dexs.json              {type:"perpDexs"} — 11
 *       entries, entry 0 null (the main dex), xyz at index 1
 *   scripts/fixtures/hl-xyz-meta-and-asset-ctxs.json
 *       {type:"metaAndAssetCtxs",dex:"xyz"} — 123 assets, 15 delisted, names
 *       arriving qualified, deployerFeeScale and growthMode on every row
 *   scripts/fixtures/hl-meta-and-asset-ctxs.json    the main dex (2026-09-22)
 *
 * MONEY_RULES section 0: an unknown fee is null here and a dash on screen, never
 * a number we cannot stand behind. Section 1: the list, the market page and the
 * ticket read ONE store, so a venue market cannot be spelled two ways.
 *
 * Run: node --test scripts/test-hl-markets-venues.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readFixture = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

/* Count any network or socket use from merely IMPORTING the modules. */
const touched = { fetch: 0, ws: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { touched.fetch++; return realFetch(...a); };
globalThis.WebSocket = class { constructor() { touched.ws++; throw new Error("no socket in tests"); } };

const M = await import("../src/lib/hyperliquid/markets.js");
const V = await import("../src/lib/hyperliquid/venues.js");
const C = await import("../src/lib/hyperliquid/coins.js");
const LOGOS = await import("../src/lib/hyperliquid/logos.js");
const { HL_TAKER_FEE_RATE } = await import("../src/perp/mock/fees.js");

const { parsePerpMarkets, createPerpMarketsStore, PERP_MARKETS_REFRESH_MS } = M;
const {
  hlAssetId, isHlMainAssetId, isHlSpotAssetId, isHlHip3AssetId, isHlOutcomeAssetId,
  parsePerpDexs, resolveVenues, venueTakerFeeMultiplier, perpTakerFeeRate,
  HIP3_VENUES, HL_OUTCOME_ID_BASE, HL_HIP3_ID_BASE,
} = V;

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/* Comments are prose, not behaviour, and prose here says what was REMOVED.
   Stripped so a guard below reads the code only (a "//" inside a URL stays). */
const codeOf = (rel) => readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DEXS = readFixture("scripts/fixtures/hl-perp-dexs.json").response;
const XYZ = readFixture("scripts/fixtures/hl-xyz-meta-and-asset-ctxs.json").response;
const MAIN = readFixture("scripts/fixtures/hl-meta-and-asset-ctxs.json").response;

const XYZ_VENUE = { dex: "xyz", category: "stock" };
const rowOf = (parsed, coin) => parsed.byCoin[coin];

/* ── the fixtures are the live capture ─────────────────────────────────────── */

test("the capture still says what this suite reads it for", () => {
  assert.equal(DEXS[0], null, "entry 0 is the main dex");
  assert.equal(DEXS[1].name, "xyz");
  assert.equal(DEXS[1].fullName, "XYZ");
  assert.equal(DEXS.length, 11);
  const uni = XYZ[0].universe;
  assert.equal(uni.length, 123);
  assert.equal(XYZ[1].length, 123, "one market context per asset");
  assert.equal(uni.filter((u) => u.isDelisted).length, 15);
  assert.equal(uni[1].name, "xyz:TSLA", "names arrive qualified, and TSLA sits at index 1");
  assert.equal(uni[1].deployerFeeScale, "1.0");
  assert.equal(uni[1].growthMode, "enabled");
  assert.equal(XYZ[0].universe[3].name, "xyz:GOLD");
  assert.equal(XYZ[0].universe[3].growthMode, undefined, "GOLD carries no growth mode");
  assert.equal(MAIN[0].universe[1].name, "ETH", "main-dex asset 1 is ETH, which is the whole point");
});

/* ── the asset id ──────────────────────────────────────────────────────────── */

test("the id ranges are the documented ones, and an outcome id is refused on sight", () => {
  assert.equal(isHlMainAssetId(0), true);
  assert.equal(isHlMainAssetId(9_999), true);
  assert.equal(isHlMainAssetId(10_000), false);
  assert.equal(isHlSpotAssetId(10_000), true, "10000 + the spot index is spot, never a perp");
  assert.equal(isHlHip3AssetId(110_001), true);
  assert.equal(isHlHip3AssetId(10_000), false);
  assert.equal(isHlOutcomeAssetId(HL_OUTCOME_ID_BASE), true, "HIP-4 outcomes start here");
  assert.equal(isHlHip3AssetId(HL_OUTCOME_ID_BASE), false);
  assert.equal(HL_OUTCOME_ID_BASE, 100_000_000);
  assert.equal(HL_HIP3_ID_BASE, 100_000);
});

test("hlAssetId: 100000 + the venue's LIVE index * 10000 + the coin's index", () => {
  assert.equal(hlAssetId({ dexIndex: 0, assetIndex: 0 }), 0, "the main dex is its universe index");
  assert.equal(hlAssetId({ dexIndex: 0, assetIndex: 98 }), 98);
  assert.equal(hlAssetId({ assetIndex: 5 }), 5, "no dex means the main dex");
  assert.equal(hlAssetId({ dexIndex: 1, assetIndex: 0 }), 110_000);
  assert.equal(hlAssetId({ dexIndex: 1, assetIndex: 1 }), 110_001);
  assert.equal(hlAssetId({ dexIndex: 3, assetIndex: 1 }), 130_001, "a different position is a different id");
});

test("hlAssetId refuses anything it cannot compute, instead of answering a number", () => {
  assert.equal(hlAssetId({ dexIndex: 1, assetIndex: 10_000 }), null, "an index that would spill into the next venue");
  assert.equal(hlAssetId({ dexIndex: 1, assetIndex: -1 }), null);
  assert.equal(hlAssetId({ dexIndex: 1, assetIndex: 1.5 }), null);
  assert.equal(hlAssetId({ dexIndex: -2, assetIndex: 1 }), null);
  assert.equal(hlAssetId({ dexIndex: 1.5, assetIndex: 1 }), null);
  assert.equal(hlAssetId({ dexIndex: 9_990, assetIndex: 0 }), null, "a venue that far down would reach the outcome ids");
  assert.equal(hlAssetId({}), null);
  assert.equal(hlAssetId(), null);
});

/* ── parsing a venue's table ───────────────────────────────────────────────── */

test("a HIP-3 table parses with the venue's facts, and 108 of 123 are live", () => {
  const p = parsePerpMarkets(XYZ, { now: 7, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" });
  assert.equal(p.universeSize, 123);
  assert.equal(p.delistedCount, 15);
  assert.equal(p.refusedCount, 0);
  assert.equal(p.markets.length, 108);
  const tsla = rowOf(p, "xyz:TSLA");
  assert.equal(tsla.coin, "xyz:TSLA", "the row speaks the name candles and activeAssetCtx answer to");
  assert.equal(tsla.label, "TSLA", "the bare ticker is what a row shows");
  assert.equal(tsla.dex, "xyz");
  assert.equal(tsla.isHip3, true);
  assert.equal(tsla.venueName, "XYZ");
  assert.equal(tsla.category, "stock");
  assert.equal(tsla.assetIndex, 110_001, "THE ORDER'S ASSET ID");
  assert.equal(tsla.dexAssetIndex, 1, "its position inside the venue's own universe");
  assert.equal(tsla.maxLeverage, 20);
  assert.equal(tsla.szDecimals, 3);
  assert.equal(tsla.onlyIsolated, false);
  assert.equal(tsla.strictIsolated, false);
  assert.ok(tsla.px > 0 && tsla.markPx > 0);
  assert.equal(rowOf(p, "xyz:GOLD").maxLeverage, 25);
  assert.equal(rowOf(p, "xyz:XYZ100").maxLeverage, 30);
  const eur = rowOf(p, "xyz:EUR");
  assert.equal(eur.maxLeverage, 50);
  assert.equal(eur.onlyIsolated, true);
  assert.equal(eur.marginMode, "noCross");
  assert.equal(eur.strictIsolated, true, "noCross is isolated-only, spelled the venue's way");
});

test("THE PIN: a HIP-3 coin can never resolve to a main-dex id", () => {
  const venue = parsePerpMarkets(XYZ, { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" });
  const main = parsePerpMarkets(MAIN, { now: 1 });
  const mainIds = new Set(main.markets.map((m) => m.assetIndex));
  assert.ok(main.markets.length > 100 && venue.markets.length > 100, "both tables are real");
  for (const m of venue.markets) {
    assert.equal(isHlHip3AssetId(m.assetIndex), true, `${m.coin} is outside the HIP-3 id range`);
    assert.equal(isHlMainAssetId(m.assetIndex), false, `${m.coin} would trade a main-dex market`);
    assert.equal(isHlOutcomeAssetId(m.assetIndex), false);
    assert.equal(mainIds.has(m.assetIndex), false, `${m.coin} collides with a main-dex id`);
    assert.equal(m.dex, "xyz");
    assert.equal(m.isHip3, true);
  }
  for (const m of main.markets) {
    assert.equal(isHlMainAssetId(m.assetIndex), true);
    assert.equal(m.isHip3, false);
    assert.equal(m.dex, null);
    assert.equal(m.label, m.coin, "a main-dex row shows its own name");
  }
  /* The one that would hurt: index 1 of the venue is TSLA, index 1 of the main
     dex is ETH, and they are different ids. */
  assert.equal(rowOf(venue, "xyz:TSLA").assetIndex, 110_001);
  assert.equal(rowOf(main, "ETH").assetIndex, 1);
});

test("the id follows the LIVE order: a reordered venue list gives different ids, and a missing venue gives none", () => {
  const moved = [null, { name: "flx" }, { name: "vntl" }, { name: "xyz", fullName: "XYZ" }];
  const [v] = resolveVenues(moved, [XYZ_VENUE]);
  assert.equal(v.index, 3, "the index is read, not remembered");
  const p = parsePerpMarkets(XYZ, { now: 1, dex: "xyz", dexIndex: v.index, venueName: v.fullName, venueCategory: v.category });
  assert.equal(rowOf(p, "xyz:TSLA").assetIndex, 130_001);
  assert.deepEqual(resolveVenues([null, { name: "flx" }], [XYZ_VENUE]), [], "a venue that is not listed is not guessed at");
  assert.deepEqual(resolveVenues(null, [XYZ_VENUE]), []);
  assert.deepEqual(resolveVenues([], [XYZ_VENUE]), []);
});

test("a venue table with no index parses to NOTHING rather than to main-dex ids", () => {
  for (const bad of [undefined, 0, -1, 1.5, null]) {
    const p = parsePerpMarkets(XYZ, { now: 1, dex: "xyz", dexIndex: bad });
    assert.equal(p.markets.length, 0, `dexIndex ${String(bad)} must not produce rows`);
  }
});

test("a venue far enough down the list to reach the outcome ids lists nothing", () => {
  const p = parsePerpMarkets(XYZ, { now: 1, dex: "xyz", dexIndex: 9_990, venueName: "XYZ", venueCategory: "stock" });
  assert.equal(p.markets.length, 0);
  assert.equal(p.refusedCount, 108, "every live row refused, none renamed into an outcome");
});

test("a name that does not belong to its answer is refused", () => {
  const meta = (names) => [{ universe: names.map((name) => ({ name, szDecimals: 2, maxLeverage: 5, marginTableId: 5 })), marginTables: [] },
    names.map(() => ({ markPx: "1.0", midPx: "1.0", prevDayPx: "1.0", dayNtlVlm: "1.0", openInterest: "1.0", oraclePx: "1.0", funding: "0.0", premium: "0.0" }))];
  const onMain = parsePerpMarkets(meta(["BTC", "xyz:TSLA"]), { now: 1 });
  assert.deepEqual(onMain.markets.map((m) => m.coin), ["BTC"], "the main dex may not carry a venue's name");
  assert.equal(onMain.refusedCount, 1);
  const onVenue = parsePerpMarkets(meta(["xyz:TSLA", "flx:HYPE", "TSLA"]), { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ" });
  assert.deepEqual(onVenue.markets.map((m) => m.coin), ["xyz:TSLA"], "another venue's name, and a bare one, are refused");
  assert.equal(onVenue.refusedCount, 2);
});

/* ── the fee ───────────────────────────────────────────────────────────────── */

test("the taker fee: twice Hyperliquid's own on xyz, and a tenth of that in growth mode (docs developer formula)", () => {
  assert.deepEqual(venueTakerFeeMultiplier({ isHip3: false }), { multiplier: 1, unknownReason: null });
  assert.deepEqual(venueTakerFeeMultiplier({ isHip3: true, feeScale: 1 }), { multiplier: 2, unknownReason: null });
  assert.deepEqual(venueTakerFeeMultiplier({ isHip3: true, feeScale: 0.5 }), { multiplier: 1.5, unknownReason: null });
  assert.deepEqual(venueTakerFeeMultiplier({ isHip3: true, feeScale: 3 }), { multiplier: 6, unknownReason: null });
  assert.deepEqual(venueTakerFeeMultiplier({ isHip3: true, feeScale: 1, growthMode: true }), { multiplier: 0.2, unknownReason: null });
  assert.ok(Math.abs(venueTakerFeeMultiplier({ isHip3: true, feeScale: 0, growthMode: true }).multiplier - 0.1) < 1e-12, "scale 0: the docs' 0.0045% floor");
  assert.deepEqual(venueTakerFeeMultiplier({ isHip3: true, feeScale: null }), { multiplier: null, unknownReason: "unreadable" });

  const p = parsePerpMarkets(XYZ, { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" });
  const gold = rowOf(p, "xyz:GOLD");
  assert.equal(gold.feeScale, 1);
  assert.equal(gold.growthMode, false);
  assert.equal(gold.takerFeeMultiplier, 2);
  assert.equal(perpTakerFeeRate(gold, HL_TAKER_FEE_RATE), HL_TAKER_FEE_RATE * 2);
  assert.ok(Math.abs(perpTakerFeeRate(gold, HL_TAKER_FEE_RATE) - 0.0009) < 1e-12, "about 0.090%, the figure the owner was given");
  const tsla = rowOf(p, "xyz:TSLA");
  assert.equal(tsla.growthMode, true);
  assert.equal(tsla.takerFeeMultiplier, 0.2);
  /* The ROW carries the figure, not a reason for it: feeUnknownReason had one
     reader, the notice that is gone, so it is no longer written either. */
  assert.equal("feeUnknownReason" in tsla, false, "no written-never-read field rides on a market row");
  assert.ok(Math.abs(perpTakerFeeRate(tsla, HL_TAKER_FEE_RATE) - 0.00009) < 1e-12, "0.009%: the docs' growth-mode top, trade[XYZ]'s own 0.0090%");
  assert.equal(perpTakerFeeRate({ takerFeeMultiplier: null }, HL_TAKER_FEE_RATE), null, "an unreadable scale is still a dash, never a wrong number");

  const main = parsePerpMarkets(MAIN, { now: 1 });
  const btc = rowOf(main, "BTC");
  assert.equal(btc.takerFeeMultiplier, 1);
  assert.equal("feeUnknownReason" in btc, false);
  assert.equal(perpTakerFeeRate(btc, HL_TAKER_FEE_RATE), HL_TAKER_FEE_RATE);
  assert.equal(perpTakerFeeRate(btc, null), null);
  assert.equal(perpTakerFeeRate(null, HL_TAKER_FEE_RATE), null);
});

/* ── no chip, no notice (owner, 2026-09-23) ────────────────────────────────── */

test("\ud83d\udd34 nothing here builds a chip label or a notice about the venue: the code is gone, not unused", () => {
  assert.equal(V.perpVenueDisclosure, undefined, "the notice builder is removed");
  assert.equal(V.HIP3_BADGE_TEXT, undefined, "the chip label is removed");
  const src = codeOf("src/lib/hyperliquid/venues.js");
  assert.doesNotMatch(src, /3rd|3th|third[ -]?part/i, "no party label in the code");
  assert.doesNotMatch(src, /runs this market|not Hyperliquid|close every position|stand behind/i, "no notice sentence");
  assert.doesNotMatch(src, /trimMult/, "the helper that existed only for the notice is gone too");
  const index = codeOf("src/lib/hyperliquid/index.js");
  assert.doesNotMatch(index, /perpVenueDisclosure|HIP3_BADGE_TEXT/, "and the barrel re-exports neither");
});

test("what stays is the FIGURE: a venue fee is a number from the docs' formula, never a sentence", () => {
  const p = parsePerpMarkets(XYZ, { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" });
  /* MONEY_RULES section 0. xyz:TSLA carries growthMode: 0.2 times the base by the
     docs' developer formula; xyz:GOLD has none: 2 times. Both are numbers. */
  assert.ok(Math.abs(perpTakerFeeRate(rowOf(p, "xyz:TSLA"), HL_TAKER_FEE_RATE) - HL_TAKER_FEE_RATE * 0.2) < 1e-12);
  assert.equal(perpTakerFeeRate(rowOf(p, "xyz:GOLD"), HL_TAKER_FEE_RATE), HL_TAKER_FEE_RATE * 2);
  /* The venue's NAME is still on the row: the market page's subtitle reads it as
     a plain label ("XYZ perp"), which is not a notice. */
  assert.equal(rowOf(p, "xyz:GOLD").venueName, "XYZ");
  assert.equal(rowOf(parsePerpMarkets(MAIN, { now: 1 }), "BTC").venueName, null);
});

/* ── names, routes and logos ───────────────────────────────────────────────── */

test("a qualified name splits, routes and never becomes a path", () => {
  assert.deepEqual(C.splitHlMarket("xyz:TSLA"), { dex: "xyz", base: "TSLA" });
  assert.deepEqual(C.splitHlMarket("BTC"), { dex: null, base: "BTC" });
  assert.equal(C.hlMarketBase("xyz:TSLA"), "TSLA");
  assert.equal(C.hlMarketBase("kPEPE"), "kPEPE");
  assert.equal(C.isHlMarketName("xyz:TSLA"), true);
  assert.equal(C.isHlMarketName("BTC"), true);
  for (const bad of ["../x", "xyz:../x", "xyz:", ":TSLA", "a/b:TSLA", "xyz:TSLA:1", "XYZ:TSLA", "", null]) {
    assert.equal(C.isHlMarketName(bad), false, `${String(bad)} must not route`);
  }
  assert.equal(C.isHlCoinName("xyz:TSLA"), false, "the plain-ticker guard stays strict");
  /* A COLON IS NOT A FILE NAME, so the snapshot files a qualified market under
     one hyphen — the mapping every side shares (coins.js hlLogoFileName). */
  assert.equal(C.hlLogoFileName("xyz:TSLA"), "xyz-TSLA.svg");
  assert.equal(C.hlLogoFileName("BTC"), "BTC.svg");
  assert.equal(C.hlLogoFileName("kPEPE"), "PEPE.svg", "the k rule is the main dex's");
  for (const bad of ["xyz:../x", "../../etc", "", null]) assert.equal(C.hlLogoFileName(bad), null, String(bad));
  /* Measured read-only 2026-09-23: the logo lives under the QUALIFIED name —
     /coins/xyz%3ATSLA.svg is an 880-byte image/svg+xml, while /coins/TSLA.svg is
     the app shell (200 text/html). So that is the name asked for, and the row
     paints OUR snapshot of it. */
  assert.equal(C.hlRemoteLogoName("xyz:TSLA"), "xyz:TSLA");
  assert.equal(C.hlRemoteLogoName("kPEPE"), "PEPE");
  assert.match(LOGOS.hlLogoUrl("xyz:TSLA"), /^\/hl-coins\/xyz-TSLA\.svg\?v=[0-9a-f]{10}$/);
  assert.match(LOGOS.hlLogoUrl("xyz:SP500"), /^\/hl-coins\/xyz-SP500\.svg\?v=[0-9a-f]{10}$/);
  /* A name that cannot route never becomes a request or a path. */
  assert.equal(LOGOS.hlLogoUrl("xyz:../x"), null);
  assert.equal(LOGOS.hlLogoUrl("XYZ:TSLA"), null);
});

/* ── the store ─────────────────────────────────────────────────────────────── */

function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    pending: () => timers.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best[1].at)) best = [id, x];
        if (!best) break;
        timers.delete(best[0]);
        t = best[1].at;
        best[1].fn();
      }
      t = end;
    },
  };
}

function fakeWs() {
  const subs = [];
  const statusFns = new Set();
  return {
    subs,
    subscribe(sub, onData) {
      const rec = { sub, onData, live: true };
      subs.push(rec);
      return () => { rec.live = false; };
    },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    emitStatus(s) { for (const fn of [...statusFns]) fn(s); },
    live: (type) => subs.filter((r) => r.live && r.sub.type === type),
    mids: (dex) => subs.filter((r) => r.live && r.sub.type === "allMids" && (r.sub.dex || "") === dex),
  };
}

/* The fake answers BY BODY, the way Hyperliquid does. fail: which bodies reject. */
function rig({ fail = {}, venues = [XYZ_VENUE] } = {}) {
  const clock = fakeClock();
  const ws = fakeWs();
  const calls = [];
  const info = (body) => {
    calls.push(body);
    const key = body.type === "metaAndAssetCtxs" && body.dex ? `dex:${body.dex}` : body.type;
    if (fail[key]) return Promise.reject(new Error(fail[key]));
    if (body.type === "perpDexs") return Promise.resolve(structuredClone(DEXS));
    if (body.type === "metaAndAssetCtxs") {
      return Promise.resolve(structuredClone(body.dex === "xyz" ? XYZ : MAIN));
    }
    return Promise.reject(new Error(`unexpected body ${JSON.stringify(body)}`));
  };
  const store = createPerpMarketsStore({
    info, ws, venues, timers: clock.timers, now: clock.now,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  });
  return { clock, ws, store, calls, types: () => calls.map((c) => (c.dex ? `${c.type}:${c.dex}` : c.type)) };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

test("one refresh: the main table, the live dex order, then ONE table per listed venue", async () => {
  const r = rig();
  const rel1 = r.store.retainList();
  const rel2 = r.store.retainList();
  await flush();
  assert.deepEqual(r.types(), ["metaAndAssetCtxs", "perpDexs", "metaAndAssetCtxs:xyz"], "two surfaces, one set of calls");
  assert.ok(r.calls.indexOf(r.calls.find((c) => c.dex === "xyz")) > r.calls.indexOf(r.calls.find((c) => c.type === "perpDexs")),
    "the venue table is asked for only after its index is known");
  const s = r.store.getSnapshot();
  assert.equal(s.ready, true);
  assert.equal(s.error, null);
  assert.deepEqual(s.venues.map((v) => [v.dex, v.index, v.fullName, v.category]), [["xyz", 1, "XYZ", "stock"]]);
  assert.deepEqual(Object.keys(s.venueErrors), []);
  assert.equal(s.byCoin.BTC.assetIndex, 0);
  assert.equal(s.byCoin["xyz:TSLA"].assetIndex, 110_001);
  assert.equal(s.byCoin["xyz:TSLA"].category, "stock");
  assert.equal(s.byCoin.BTC.category, "crypto");
  assert.equal(s.byCoin.kPEPE.category, "meme");
  assert.equal(s.markets[0].dex, null, "the main dex comes first");
  assert.equal(s.markets.length, parsePerpMarkets(MAIN).markets.length + 108);
  /* One socket, two streams on it. */
  assert.equal(r.ws.mids("").length, 1);
  assert.equal(r.ws.mids("xyz").length, 1);
  assert.equal(r.ws.live("allMids").length, 2);
  rel1();
  assert.equal(r.ws.live("allMids").length, 2, "one surface still open");
  rel2();
  assert.equal(r.ws.live("allMids").length, 0);

  /* The next refresh is the same three calls, on the same modest interval. */
  const rel3 = r.store.retainList();
  await flush();
  const before = r.calls.length;
  r.clock.advance(PERP_MARKETS_REFRESH_MS);
  await flush();
  assert.equal(r.calls.length - before, 3);
  rel3();
});

test("a venue's own allMids stream moves only its own rows", async () => {
  const r = rig();
  const rel = r.store.retainList();
  await flush();
  r.ws.mids("xyz")[0].onData({ dex: "xyz", mids: { "xyz:TSLA": "500.0", BTC: "1.0" } });
  let s = r.store.getSnapshot();
  assert.equal(s.byCoin["xyz:TSLA"].px, 500);
  assert.notEqual(s.byCoin.BTC.px, 1, "a venue push cannot name a main-dex coin's price");
  r.ws.mids("")[0].onData({ mids: { BTC: "90000.0", "xyz:TSLA": "1.0" } });
  s = r.store.getSnapshot();
  assert.equal(s.byCoin.BTC.px, 90_000);
  assert.equal(s.byCoin["xyz:TSLA"].px, 500, "and the main push cannot name a venue's");
  /* A push addressed to another dex is ignored outright. */
  r.ws.mids("xyz")[0].onData({ dex: "flx", mids: { "xyz:TSLA": "9.0" } });
  assert.equal(r.store.getSnapshot().byCoin["xyz:TSLA"].px, 500);
  rel();
});

test("after the stream drops, the list stays flagged until EVERY dex it shows has spoken again", async () => {
  const r = rig();
  const rel = r.store.retainList();
  await flush();
  assert.equal(r.store.getSnapshot().stale, false);
  r.ws.emitStatus("reconnecting");
  assert.equal(r.store.getSnapshot().stale, true);
  r.ws.mids("")[0].onData({ mids: { BTC: "90000.0" } });
  assert.equal(r.store.getSnapshot().stale, true, "the venue rows have not been refreshed by a main-dex push");
  r.ws.mids("xyz")[0].onData({ dex: "xyz", mids: { "xyz:TSLA": "400.0" } });
  assert.equal(r.store.getSnapshot().stale, false);
  rel();
});

test("a venue that fails keeps the main dex whole, and says which venue is old", async () => {
  const r = rig({ fail: { "dex:xyz": "venue blip" } });
  const rel = r.store.retainList();
  await flush();
  const s = r.store.getSnapshot();
  assert.equal(s.ready, true);
  assert.equal(s.error, null, "the main dex answered, so the list is not in error");
  assert.ok(s.markets.length > 100);
  assert.equal(s.markets.every((m) => !m.isHip3), true, "a venue that has never answered contributes no rows");
  assert.match(s.venueErrors.xyz, /venue blip/);
  rel();
});

test("no dex order, no venue rows: an id is never built on a remembered index", async () => {
  const r = rig({ fail: { perpDexs: "dex list blip" } });
  const rel = r.store.retainList();
  await flush();
  const s = r.store.getSnapshot();
  assert.equal(s.ready, true);
  assert.ok(s.markets.length > 100);
  assert.equal(s.markets.some((m) => m.isHip3), false);
  assert.deepEqual(s.venues, []);
  assert.match(s.venueErrors["*"], /dex list blip/);
  assert.equal(r.ws.mids("xyz").length, 0, "nothing is streamed for a venue we cannot place");
  rel();
});

test("the main table failing is still an error, with the rows it had", async () => {
  const r = rig({ fail: { metaAndAssetCtxs: "main blip" } });
  const rel = r.store.retainList();
  await flush();
  const s = r.store.getSnapshot();
  assert.match(s.error, /main blip/);
  assert.equal(s.markets.length, 108, "the venue answered, and its rows stand on their own");
  assert.equal(s.markets.every((m) => m.isHip3), true);
  rel();
});

test("the build lists its venues in one editable constant", () => {
  assert.ok(Array.isArray(HIP3_VENUES) && HIP3_VENUES.length >= 1);
  assert.deepEqual(HIP3_VENUES.map((v) => v.dex), ["xyz"]);
  assert.equal(HIP3_VENUES[0].category, "stock");
  assert.equal(Object.isFrozen(HIP3_VENUES), true);
  const { list, byName } = parsePerpDexs(DEXS);
  assert.equal(list.length, 10, "ten named venues, the main dex is not one of them");
  assert.equal(byName.get("xyz").index, 1);
  assert.equal(byName.get("io").index, 10);
  assert.equal(byName.has(""), false);
});

test("importing the modules opened no socket and sent no request", () => {
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
});
