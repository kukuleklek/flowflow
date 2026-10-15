/**
 * HIP-3 stock perps — the "Stock" filter on the market list (src/trade/marketLists.js, patch P3).
 * Owner, 2026-10-15: "เพิ่มเข้าไปใน นี้เลย ชื่อ Stock". Rows are the shared store's own parse of the
 * 2026-10-15 xyz capture, so the filter reads exactly what the app reads. No network.
 *
 * Run: node --test scripts/test-hip3-stock-filter.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3", `${name}.json`), "utf8")).response;
globalThis.fetch = () => { throw new Error("no network in tests"); };

const { parsePerpMarkets } = await import("../src/lib/hyperliquid/markets.js");
const L = await import("../src/trade/marketLists.js");
const { STOCK_WHITELIST } = await import("../src/lib/hyperliquid/hip3/whitelist.js");

const xyz = parsePerpMarkets(fx("xyz-meta-and-asset-ctxs"), { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" }).markets;
const main = [{ coin: "BTC", label: "BTC", isHip3: false, px: 80000, dayNtlVlm: 4e9, openInterestUsd: 2e9, change24hPct: -3, funding: 0.00001 }];
const all = [...main, ...xyz];

test("the Stock pill sits after Meme, and the Perps list still has no stock in it", () => {
  assert.deepEqual(L.FILTERS.map((f) => f.label), ["Trending", "Gainers", "Losers", "Funding", "Meme", "Stock"]);
  assert.equal(L.mainMarkets(all).some((m) => m.isHip3), false);
  assert.equal(L.filterMarkets(all, { filter: "trending" }).some((m) => m.isHip3), false);
  assert.equal(L.topMovers(all).some((m) => m.isHip3), false, "Top movers stay crypto");
});

test("Stock = whitelisted stock perps over the volume and OI gate, by 24h volume", () => {
  const rows = L.filterMarkets(all, { filter: "stock" });
  const wl = new Set(STOCK_WHITELIST.map((w) => w.coin));
  assert.ok(rows.length >= 15 && rows.length <= STOCK_WHITELIST.length, String(rows.length));
  for (const r of rows) assert.ok(wl.has(r.coin) && r.isHip3, r.coin);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].dayNtlVlm >= rows[i].dayNtlVlm);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.coin), ["xyz:XYZ100", "xyz:SP500", "xyz:NVDA"]);
  assert.equal(rows.some((r) => r.coin === "xyz:NFLX"), false, "NFLX: $1.5M volume, under the gate");
  assert.equal(rows.some((r) => r.coin === "xyz:GOLD"), false, "not on the whitelist");
  assert.equal(rows.find((r) => r.coin === "xyz:TSLA").assetIndex, 110001, "the row is the store's own, asset id and all");
});

test("search finds a stock by ticker or by name; unknown figures never pass the gate", () => {
  assert.deepEqual(L.filterMarkets(all, { filter: "stock", query: "tesla" }).map((r) => r.coin), ["xyz:TSLA"]);
  assert.deepEqual(L.filterMarkets(all, { filter: "stock", query: "nvda" }).map((r) => r.coin), ["xyz:NVDA"]);
  assert.equal(L.stockName("xyz:AAPL"), "Apple");
  assert.equal(L.stockName("BTC"), null);
  const tsla = xyz.find((m) => m.coin === "xyz:TSLA");
  assert.deepEqual(L.stockMarkets([{ ...tsla, dayNtlVlm: null }]), []);
  assert.deepEqual(L.stockMarkets([{ ...tsla, px: null }]), []);
  assert.deepEqual(L.stockMarkets([{ ...tsla, isHip3: false }]), []);
});
