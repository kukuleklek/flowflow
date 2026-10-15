/**
 * test-perp-categories — THE CHIPS: All | Crypto | Meme | Stock, and the map behind
 * them.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-23: "ขอเป็นหมวดด้วยดิ Perp: Crypto l Stock I Meme ... ใน Stock
 * มีแบบ S&p500, Trad fi ต่างๆ" — categories on the Perp list, and TradFi (the
 * S&P-style index, the shares, the metals, the currencies) lives under Stock.
 *
 * The map: lib/hyperliquid/perpCategories.js, the small file the owner edits:
 * which chip a market belongs to, checked against the live tables.
 *
 * The rows come from the READ-ONLY fixtures captured on 2026-09-22/23 (the main
 * dex and the HIP-3 venue xyz). Nothing here reaches the network: fetch throws.
 *
 * Run: node --test scripts/test-perp-categories.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  P, read, code, autoStubs, bundle, all, stubsNamed, textOf, squash, fakeBrowser,
} from "./lib/perpLiveHarness.mjs";

/* Nothing here may reach Hyperliquid: no request, and no socket either. The
   market store is stubbed at its hook, and these two make a miss LOUD. */
const touched = { fetch: 0, ws: 0 };
globalThis.fetch = () => { touched.fetch++; throw new Error("test-perp-categories: a real network call was attempted"); };
globalThis.WebSocket = class { constructor() { touched.ws++; throw new Error("test-perp-categories: a real socket was attempted"); } };

const LIST = "src/perp/PerpList.jsx";
const CATS = "src/lib/hyperliquid/perpCategories.js";
const VENUES = "src/lib/hyperliquid/venues.js";
const COINS = "src/lib/hyperliquid/coins.js";
const VIEW = "src/perp/perpView.js";
const MARKETS = "src/lib/hyperliquid/markets.js";

let C = null;
let M = null;
let main = null;
let venue = null;
let FEW = null;
let loadError = null;
before(async () => {
  try {
    C = await import(pathToFileURL(P(CATS)).href);
    M = await import(pathToFileURL(P(MARKETS)).href);
    const mainFix = JSON.parse(read("scripts/fixtures/hl-meta-and-asset-ctxs.json")).response;
    const venueFix = JSON.parse(read("scripts/fixtures/hl-xyz-meta-and-asset-ctxs.json")).response;
    main = M.parsePerpMarkets(mainFix, { now: 1 });
    venue = M.parsePerpMarkets(venueFix, { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" });
    /* A handful of real rows, one of each chip, small enough that the list's own
       paging (20 at a time) cannot hide the row a test is about: TSLA is the
       27th busiest xyz market, so the full table pages it away. */
    const pick = (t, names) => names.map((n) => t.byCoin[n]).filter(Boolean);
    FEW = [
      ...pick(main, ["BTC", "ETH", "kPEPE", "WIF"]),
      ...pick(venue, ["xyz:TSLA", "xyz:GOLD", "xyz:SP500"]),
    ];
  } catch (e) { loadError = e; }
});
const need = () => { if (loadError) throw loadError; };

/* ── the map ───────────────────────────────────────────────────────────────── */

test("three categories, and anything unmapped is crypto", () => {
  need();
  assert.deepEqual(C.PERP_CATEGORIES, ["crypto", "meme", "stock"]);
  assert.equal(C.perpCategoryOf("BTC"), "crypto");
  assert.equal(C.perpCategoryOf("HYPE"), "crypto");
  assert.equal(C.perpCategoryOf("A-COIN-LISTED-TOMORROW"), "crypto", "a new listing shows up, it does not vanish");
  assert.equal(C.perpCategoryOf(""), "crypto");
  assert.equal(C.perpCategoryOf(null), "crypto");
});

test("the memes are the owner's list, and Hyperliquid's k prefix does not hide one", () => {
  need();
  for (const c of ["WIF", "BONK", "FARTCOIN", "TRUMP", "PENGU", "POPCAT", "MOODENG", "GOAT", "PNUT", "BRETT", "MEW", "SPX"]) {
    assert.equal(C.perpCategoryOf(c), "meme", c);
  }
  assert.equal(C.perpCategoryOf("kPEPE"), "meme", "1000x units are the same coin");
  assert.equal(C.perpCategoryOf("kBONK"), "meme");
  assert.equal(C.perpCategoryOf("kSHIB"), "meme");
  assert.equal(C.perpCategoryOf("KAITO"), "crypto", "an uppercase K is part of the name, not the prefix");
});

test("a venue's own category wins, so TradFi lands under Stock however it is named", () => {
  need();
  assert.equal(C.perpCategoryOf("xyz:TSLA", { dex: "xyz", base: "TSLA", venueCategory: "stock" }), "stock");
  assert.equal(C.perpCategoryOf("xyz:GOLD", { dex: "xyz", base: "GOLD", venueCategory: "stock" }), "stock");
  assert.equal(C.perpCategoryOf("xyz:EUR", { dex: "xyz", base: "EUR", venueCategory: "stock" }), "stock");
  assert.equal(C.perpCategoryOf("xyz:XYZ100", { dex: "xyz", base: "XYZ100", venueCategory: "stock" }), "stock");
  assert.equal(C.perpCategoryOf("xyz:SPX", { dex: "xyz", base: "SPX", venueCategory: "stock" }), "stock",
    "on a TradFi venue SPX is the index, not the meme");
  assert.equal(C.perpCategoryOf("SPX"), "meme", "on the main dex it is still the meme");
  assert.equal(C.perpCategoryOf("hyna:ADA", { dex: "hyna", base: "ADA", venueCategory: "crypto" }), "crypto",
    "a crypto venue does not turn its coins into shares");
  assert.equal(C.perpCategoryOf("hyna:WIF", { dex: "hyna", base: "WIF", venueCategory: "crypto" }), "meme");
});

test("the live tables: every market gets exactly one chip, and the venue is all Stock", () => {
  need();
  const seen = new Set();
  for (const m of [...main.markets, ...venue.markets]) {
    assert.ok(C.PERP_CATEGORIES.includes(m.category), `${m.coin} has no category`);
    seen.add(m.category);
  }
  assert.deepEqual([...seen].sort(), ["crypto", "meme", "stock"], "all three chips have something in them");
  assert.equal(venue.markets.every((m) => m.category === "stock"), true);
  assert.equal(main.byCoin.BTC.category, "crypto");
  assert.equal(main.byCoin.kPEPE.category, "meme");
  assert.equal(main.byCoin.FARTCOIN.category, "meme");
  /* Counted, so a bad edit that empties a chip is visible here. */
  const counts = C.perpCategoryCounts([...main.markets, ...venue.markets]);
  assert.equal(counts.all, main.markets.length + venue.markets.length);
  assert.equal(counts.stock, venue.markets.length);
  assert.ok(counts.meme >= 15, `only ${counts.meme} memes`);
  assert.equal(counts.crypto + counts.meme, main.markets.length);
});

test("filtering keeps the order it was given and never invents a row", () => {
  need();
  const ranked = M.rankPerpMarkets([...main.markets, ...venue.markets]);
  const stock = C.filterPerpMarkets(ranked, "stock");
  assert.equal(stock.length, venue.markets.length);
  assert.equal(stock.every((m) => m.isHip3), true);
  const vols = stock.map((m) => m.dayNtlVlm ?? -1);
  assert.deepEqual(vols, [...vols].sort((a, b) => b - a), "24h volume order, inside the chip too");
  assert.equal(C.filterPerpMarkets(ranked, "all").length, ranked.length);
  assert.equal(C.filterPerpMarkets(ranked, null).length, ranked.length);
  assert.equal(C.filterPerpMarkets(ranked, "nonsense").length, ranked.length, "an unknown chip shows everything, never nothing");
  assert.deepEqual(C.filterPerpMarkets(null, "meme"), []);
});

test("nothing in this suite touched the network", () => {
  assert.deepEqual(touched, { fetch: 0, ws: 0 });
});
