/**
 * HIP-3 stock perps — dexes, asset ids, stock rows and the whitelist
 * (src/lib/hyperliquid/hip3/{dexes,assetId,stocks,whitelist}.js).
 *
 * Every fixture is a live, read-only mainnet answer captured 2026-10-15
 * (scripts/fixtures/hip3/, addresses of public traders redacted). No network:
 * fetch and WebSocket are counted and must stay at zero.
 *
 * Run: node --test scripts/test-hip3-data.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3", `${name}.json`), "utf8")).response;

const touched = { fetch: 0, ws: 0 };
globalThis.fetch = () => { touched.fetch++; throw new Error("no network in tests"); };
globalThis.WebSocket = class { constructor() { touched.ws++; throw new Error("no socket in tests"); } };

const H = await import("../src/lib/hyperliquid/hip3/index.js");
const V = await import("../src/lib/hyperliquid/venues.js");
const M = await import("../src/lib/hyperliquid/markets.js");
const { HL_LOGO_FILES } = await import("../src/lib/hyperliquid/logoManifest.js");
const FEES = await import("../src/perp/mock/fees.js");

const DEXS = fx("perp-dexs");
const XYZ = fx("xyz-meta-and-asset-ctxs");
const LIMITS = fx("xyz-perp-dex-limits");
const dexes = H.parseDexes(DEXS);
const xyz = dexes.byName.get("xyz");
const parsed = H.parseStockRows(XYZ, { dex: "xyz", dexIndex: xyz.index, dexInfo: xyz, limits: LIMITS, now: 1 });
const row = (c) => parsed.byCoin.get(c);

/* ── the capture ───────────────────────────────────────────────────────────── */

test("the capture still says what this suite reads it for", () => {
  assert.equal(DEXS.length, 11);
  assert.equal(DEXS[0], null, "entry 0 is the main dex");
  assert.equal(XYZ[0].universe.length, 135);
  assert.equal(XYZ[1].length, 135, "one context per asset");
  assert.equal(XYZ[0].collateralToken, 0);
  const summary = fx("all-perp-metas-summary");
  assert.equal(summary.length, DEXS.length, "allPerpMetas is aligned with perpDexs, entry for entry");
  summary.forEach((m, i) => {
    if (i === 0) return assert.equal(m.first, "BTC");
    assert.ok(m.first.startsWith(`${DEXS[i].name}:`), `allPerpMetas[${i}] is ${DEXS[i].name}`);
  });
});

/* ── dexes ─────────────────────────────────────────────────────────────────── */

test("parseDexes keeps the live index and what the answer says about each dex", () => {
  assert.equal(dexes.list.length, 10);
  assert.deepEqual(dexes.list.map((d) => [d.name, d.index]), [
    ["xyz", 1], ["flx", 2], ["vntl", 3], ["hyna", 4], ["km", 5], ["abcd", 6], ["cash", 7], ["para", 8], ["mkts", 9], ["io", 10],
  ]);
  assert.equal(xyz.fullName, "XYZ");
  assert.equal(xyz.deployer, "0x88806a71d74ad0a510b350545c9ae490912f0888");
  assert.equal(xyz.oracleUpdater, null, "xyz pushes its oracle through a setOracle sub-deployer");
  assert.equal(xyz.subDeployers.setOracle.length, 1);
  assert.ok(xyz.subDeployers.haltTrading.length >= 1, "somebody may halt xyz trading");
  assert.equal(xyz.oiCapUsd.get("xyz:AAPL"), 200_000_000);
  assert.equal(xyz.fundingMultiplier.get("xyz:TSLA"), 0.5);
  assert.equal(dexes.byName.get("para").oracleUpdater, "0x8888888c43cbb7e1c4132542e46831bffd866ed3");
});

test("parseDexes refuses junk and never invents an index", () => {
  assert.equal(H.parseDexes(null).list.length, 0);
  assert.equal(H.parseDexes({}).list.length, 0);
  const d = H.parseDexes([null, { name: "BAD NAME" }, { name: "ok1" }, { name: "ok1" }, 7]);
  assert.deepEqual(d.list.map((x) => [x.name, x.index]), [["ok1", 2]], "a repeated name keeps its first position");
  assert.equal(d.count, 5);
});

test("collateral: USDC dexes can be funded from the Main Account, the others cannot", () => {
  const tokens = fx("spot-meta-collateral-tokens").tokens;
  assert.deepEqual(H.dexCollateral(XYZ[0], tokens), { index: 0, name: "USDC", isUsdc: true });
  for (const d of ["mkts", "para", "io"]) assert.equal(H.dexCollateral(fx(`${d}-meta-and-asset-ctxs`)[0], tokens).isUsdc, true, d);
  assert.deepEqual(H.dexCollateral(fx("flx-meta-and-asset-ctxs")[0], tokens), { index: 360, name: "USDH", isUsdc: false });
  assert.deepEqual(H.dexCollateral({}, tokens), { index: null, name: null, isUsdc: null }, "unknown is not USDC");
});

test("oiCapUse is null whenever a figure is unknown", () => {
  assert.equal(H.oiCapUse(50, 100), 0.5);
  assert.equal(H.oiCapUse(null, 100), null);
  assert.equal(H.oiCapUse(50, 0), null);
  assert.equal(H.oiCapUse("x", 100), null);
});

/* ── asset ids ─────────────────────────────────────────────────────────────── */

test("stockAssetId: 100000 + live dex index * 10000 + position in the FULL universe", () => {
  assert.deepEqual(H.stockAssetId("xyz:TSLA", { dexes, universe: XYZ[0].universe }), { ok: true, id: 110001, dexIndex: 1, index: 1 });
  assert.equal(H.stockAssetId("xyz:XYZ100", { dexes, universe: XYZ[0].universe }).id, 110000);
  assert.equal(H.stockAssetId("xyz:SP500", { dexes, universe: XYZ[0].universe }).id, 110052);
  assert.equal(H.stockAssetId("mkts:US500", { dexes, universe: fx("mkts-meta-and-asset-ctxs")[0].universe }).id, 190000);
  assert.equal(H.stockAssetId("io:OAI", { dexes, universe: fx("io-meta-and-asset-ctxs")[0].universe }).id, 200000);
});

test("stockAssetId refuses rather than guesses", () => {
  const u = XYZ[0].universe;
  const delisted = u.find((x) => x.isDelisted).name;
  assert.equal(H.stockAssetId(delisted, { dexes, universe: u }).code, "delisted");
  assert.equal(H.stockAssetId("TSLA", { dexes, universe: u }).code, "not_hip3");
  assert.equal(H.stockAssetId("nope:TSLA", { dexes, universe: u }).code, "dex_unknown");
  assert.equal(H.stockAssetId("xyz:NOPE", { dexes, universe: u }).code, "coin_unknown");
  assert.equal(H.stockAssetId("xyz:TSLA", { dexes, universe: null }).code, "universe_unknown");
  assert.equal(H.stockAssetId("xyz:TSLA", { dexes, universe: [...u, { name: "xyz:TSLA" }] }).code, "coin_ambiguous");
  assert.equal(H.stockAssetId("xyz:TSLA", { dexes: H.parseDexes([null, ...Array(9999).fill({ name: "zz" }), { name: "xyz" }]), universe: u }).code, "id_out_of_range");
});

test("decodeHlAssetId reads every range back", () => {
  assert.deepEqual(H.decodeHlAssetId(0), { kind: "main", dexIndex: 0, index: 0 });
  assert.deepEqual(H.decodeHlAssetId(10_107), { kind: "spot", dexIndex: null, index: 107 });
  assert.deepEqual(H.decodeHlAssetId(110_001), { kind: "hip3", dexIndex: 1, index: 1 });
  assert.deepEqual(H.decodeHlAssetId(209_999), { kind: "hip3", dexIndex: 10, index: 9999 });
  assert.equal(H.decodeHlAssetId(100_000_000).kind, "outcome");
  assert.equal(H.decodeHlAssetId(-1).kind, null);
  assert.equal(H.decodeHlAssetId(1.5).kind, null);
});

test("roundTrip: an id that no longer names the customer's market fails the signer's last check", () => {
  const u = XYZ[0].universe;
  assert.equal(H.roundTrip(110001, "xyz:TSLA", { dexes, universe: u }), true);
  assert.equal(H.roundTrip(1, "xyz:TSLA", { dexes, universe: u }), false, "bare 1 is main-dex ETH");
  assert.equal(H.roundTrip(110002, "xyz:TSLA", { dexes, universe: u }), false, "110002 is NVDA");
  /* A new dex listed before xyz moves xyz to index 2: yesterday's id is someone else's market. */
  const shifted = H.parseDexes([null, { name: "new" }, ...DEXS.slice(1)]);
  assert.equal(H.roundTrip(110001, "xyz:TSLA", { dexes: shifted, universe: u }), false);
  assert.equal(H.stockAssetId("xyz:TSLA", { dexes: shifted, universe: u }).id, 120001);
});

test("every id here equals the id the shared market store computes (markets.js)", () => {
  const shared = M.parsePerpMarkets(XYZ, { dex: "xyz", dexIndex: xyz.index, venueName: "XYZ", venueCategory: "stock" });
  assert.equal(shared.markets.length, parsed.rows.length);
  for (const r of parsed.rows) assert.equal(shared.byCoin[r.coin].assetIndex, r.assetId, r.coin);
  assert.equal(H.hlAssetId, V.hlAssetId, "one rule, re-exported, not copied");
});

/* ── stock rows ────────────────────────────────────────────────────────────── */

test("parseStockRows: live rows only, delisted rows keep their place", () => {
  assert.equal(parsed.rows.length, 115);
  assert.equal(parsed.delisted, 20);
  assert.equal(parsed.refused, 0);
  assert.equal(parsed.collateralToken, 0);
  const t = row("xyz:TSLA");
  assert.equal(t.ticker, "TSLA");
  assert.equal(t.localIndex, 1);
  assert.equal(t.assetId, 110001);
  assert.equal(t.szDecimals, 3);
  assert.equal(t.maxLeverage, 20);
  assert.equal(t.markPx, 362.52);
  assert.equal(t.oraclePx, 362.46);
  assert.equal(t.px, t.midPx, "the price shown is the mid");
  assert.equal(t.oiCapUsd, 100_000_000);
  assert.ok(t.oiCapUse > 0.4 && t.oiCapUse < 0.42);
  assert.ok(Math.abs(t.impactSpreadBps - 1.2) < 0.05);
  assert.ok(Math.abs(t.markOracleGapBps - 1.655) < 0.01);
});

test("margin modes as measured: majors allow cross, most others isolated-only, io strict", () => {
  for (const c of ["xyz:TSLA", "xyz:NVDA", "xyz:AAPL", "xyz:MSFT", "xyz:GOOGL", "xyz:AMZN", "xyz:META", "xyz:SP500", "xyz:XYZ100"]) {
    assert.equal(row(c).margin, "cross", c);
    assert.equal(row(c).crossAllowed, true, c);
  }
  for (const c of ["xyz:AMD", "xyz:PLTR", "xyz:COIN", "xyz:HOOD", "xyz:MSTR", "xyz:ORCL"]) assert.equal(row(c).margin, "isolated", c);
  const io = fx("io-meta-and-asset-ctxs");
  const ioRows = H.parseStockRows(io, { dex: "io", dexIndex: 10 });
  assert.equal(ioRows.byCoin.get("io:SNDK").margin, "strictIsolated");
  assert.equal(ioRows.byCoin.get("io:SNDK").canRemoveMargin, false);
  assert.equal(ioRows.byCoin.get("io:OAI").margin, "isolated");
  assert.equal(H.marginKind({ marginMode: "somethingNew" }), "isolated", "an unknown mode reads as the stricter one");
});

test("fees by the docs' developer formula: growth mode is 0.1 of scale * 2", () => {
  const { HL_TAKER_FEE_RATE } = FEES;
  assert.equal(row("xyz:TSLA").growthMode, true);
  assert.equal(row("xyz:TSLA").feeScale, 1);
  assert.ok(Math.abs(row("xyz:TSLA").takerFeeMultiplier - 0.2) < 1e-12);
  const pct = HL_TAKER_FEE_RATE * row("xyz:TSLA").takerFeeMultiplier * 100;
  assert.ok(Math.abs(pct - 0.009) < 1e-12, "0.009%: the top of the docs' 0.0045%-0.009% growth-mode band");
  assert.equal(row("xyz:MSTR").growthMode, false, "no growthMode field: off");
  assert.equal(row("xyz:MSTR").takerFeeMultiplier, 2);
  assert.equal(row("xyz:GOLD").growthMode, false, "gold is not growth-mode eligible (docs: PAXG)");
  assert.ok(Math.abs(H.hip3TakerFeeMultiplier({ feeScale: 0.5, growthMode: true }) - 0.15) < 1e-12);
  assert.equal(H.hip3TakerFeeMultiplier({ feeScale: 0, growthMode: true }), 0.1, "scale 0: the 0.0045% floor");
  assert.equal(H.hip3TakerFeeMultiplier({ feeScale: null }), null);
  /* Patch P1 applied: the shared venues.js and this layer print one fee, growth mode or not. */
  for (const [feeScale, growthMode] of [[1, true], [1, false], [0.5, true], [0, true], [3, false]]) {
    assert.ok(Math.abs(V.venueTakerFeeMultiplier({ isHip3: true, feeScale, growthMode }).multiplier - H.hip3TakerFeeMultiplier({ feeScale, growthMode })) < 1e-12, `${feeScale} ${growthMode}`);
  }
});

test("parseStockRows refuses mix-ups and a missing index", () => {
  assert.equal(H.parseStockRows(XYZ, { dex: "xyz", dexIndex: 0 }).rows.length, 0, "no index, no rows");
  assert.equal(H.parseStockRows(XYZ, { dex: "mkts", dexIndex: 9 }).refused, 115, "xyz names in a mkts answer are refused");
  assert.equal(H.parseStockRows(null, { dex: "xyz", dexIndex: 1 }).rows.length, 0);
  const broken = [{ universe: [{ name: "xyz:A", szDecimals: 2, maxLeverage: 10 }] }, [{ markPx: "x", openInterest: null }]];
  const b = H.parseStockRows(broken, { dex: "xyz", dexIndex: 1 }).rows[0];
  assert.equal(b.markPx, null);
  assert.equal(b.openInterestUsd, null);
  assert.equal(b.impactSpreadBps, null);
  assert.equal(b.oiCapUse, null);
  assert.equal(b.change24hPct, null);
});

test("mids: qualified keys of this dex only, and a mid moves px but never the mark", () => {
  const mids = H.parseDexMids(fx("xyz-all-mids"), "xyz");
  assert.ok(mids.size >= 100);
  assert.ok(mids.has("xyz:TSLA"));
  assert.equal(H.parseDexMids({ "xyz:A": "1", "mkts:B": "2", BTC: "3", "xyz:C": "x" }, "xyz").size, 1);
  const t = H.withMid(row("xyz:TSLA"), 370, 5);
  assert.equal(t.px, 370);
  assert.equal(t.markPx, 362.52);
  assert.equal(t.at, 5);
  assert.equal(H.withMid(row("xyz:TSLA"), "junk"), row("xyz:TSLA"));
});

test("perpsAtOpenInterestCap reads as a set", () => {
  assert.equal(H.parseAtCap(fx("xyz-perps-at-oi-cap")).size, 0);
  assert.equal(H.parseAtCap(fx("main-perps-at-oi-cap")).size, 7);
  assert.equal(H.parseAtCap(null).size, 0);
});

/* ── whitelist ─────────────────────────────────────────────────────────────── */

test("every whitelisted name is a live xyz market with a snapshotted logo", () => {
  for (const w of H.STOCK_WHITELIST) {
    assert.ok(w.coin.startsWith(`${H.STOCK_DEX}:`), w.coin);
    assert.ok(row(w.coin), `${w.coin} is live on xyz`);
    assert.ok(Object.prototype.hasOwnProperty.call(HL_LOGO_FILES, w.coin), `${w.coin} has a local logo`);
    assert.ok(["stock", "index", "etf"].includes(w.kind));
    assert.ok(w.name);
  }
  assert.equal(new Set(H.STOCK_WHITELIST.map((w) => w.coin)).size, H.STOCK_WHITELIST.length, "no repeats");
});

test("screenStocks on the capture: 17 listed by volume, NFLX and TSM held", () => {
  const s = H.screenStocks(parsed.byCoin);
  assert.equal(s.listed.length, 17);
  assert.deepEqual(s.listed.slice(0, 3).map((r) => r.ticker), ["XYZ100", "SP500", "NVDA"]);
  for (let i = 1; i < s.listed.length; i++) assert.ok(s.listed[i - 1].dayNtlVlm >= s.listed[i].dayNtlVlm);
  assert.equal(s.listed.find((r) => r.ticker === "TSLA").name, "Tesla");
  assert.deepEqual(s.held, [
    { coin: "xyz:NFLX", name: "Netflix", reasons: ["volume_low", "spread_wide"] },
    { coin: "xyz:TSM", name: "TSMC", reasons: ["spread_wide"] },
  ]);
});

test("the gate: unknown never passes, a vanished market is held, a capped one too", () => {
  const t = row("xyz:TSLA");
  assert.deepEqual(H.gateReasons(t), []);
  assert.deepEqual(H.gateReasons({ ...t, dayNtlVlm: null, impactSpreadBps: null, oiCapUse: null }), ["volume_unknown", "spread_unknown", "cap_unknown"]);
  assert.deepEqual(H.gateReasons({ ...t, oiCapUse: 0.95 }), ["cap_near"]);
  assert.deepEqual(H.gateReasons(null), ["not_live"]);
  const gone = new Map(parsed.byCoin);
  gone.delete("xyz:TSLA");
  assert.deepEqual(H.screenStocks(gone).held.find((h) => h.coin === "xyz:TSLA").reasons, ["not_live"]);
  assert.deepEqual(H.screenStocks(parsed.byCoin, { atCap: new Set(["xyz:AAPL"]) }).held.find((h) => h.coin === "xyz:AAPL").reasons, ["at_cap"]);
  /* Caps unread: everything is held, nothing is listed on a guess. */
  const noCaps = H.parseStockRows(XYZ, { dex: "xyz", dexIndex: 1 });
  assert.equal(H.screenStocks(noCaps.byCoin).listed.length, 0);
});

test("importing the layer touched no network", () => {
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
});

test("dexCollateral agrees with the exchange layer's venueCollateralToken on every captured dex", async () => {
  const { venueCollateralToken } = await import("../src/lib/hyperliquid/exchange/venueCollateral.js");
  const tokens = fx("spot-meta-collateral-tokens").tokens;
  for (const d of ["xyz", "mkts", "para", "io", "flx", "abcd"]) {
    const meta = fx(`${d}-meta-and-asset-ctxs`)[0];
    const mine = H.dexCollateral(meta, tokens);
    const theirs = venueCollateralToken({ collateralToken: meta.collateralToken, spotTokens: tokens });
    assert.equal(mine.isUsdc, theirs.ok, d);
    if (theirs.ok) assert.equal(theirs.token, "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", d);
    else assert.equal(theirs.code, "collateral_unsupported", d);
  }
});
