/**
 * HIP-3 stock perps — what customers call a stock (src/lib/hyperliquid/hip3/names.js).
 * For the Agent: "long TSLA", "ซื้อ Tesla 10 ดอล", "เทสล่า" must land on xyz:TSLA, and nothing else may.
 *
 * Run: node --test scripts/test-hip3-names.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3", `${name}.json`), "utf8")).response;
globalThis.fetch = () => { throw new Error("no network in tests"); };

const { resolveStock, findStockInText, STOCK_ALIASES } = await import("../src/lib/hyperliquid/hip3/names.js");
const { STOCK_WHITELIST } = await import("../src/lib/hyperliquid/hip3/whitelist.js");

test("one name -> one stock: tickers, company names, Thai names, any case", () => {
  const cases = {
    TSLA: "xyz:TSLA", tsla: "xyz:TSLA", "$TSLA": "xyz:TSLA", "xyz:TSLA": "xyz:TSLA", Tesla: "xyz:TSLA", "เทสล่า": "xyz:TSLA",
    "หุ้น Apple": "xyz:AAPL", "แอปเปิ้ล": "xyz:AAPL", nvidia: "xyz:NVDA", "เอ็นวิเดีย": "xyz:NVDA", Google: "xyz:GOOGL",
    facebook: "xyz:META", meta: "xyz:META", coin: "xyz:COIN", Coinbase: "xyz:COIN", oracle: "xyz:ORCL",
    "S&P 500": "xyz:SP500", sp500: "xyz:SP500", nasdaq: "xyz:XYZ100", "US 100 index": "xyz:XYZ100", "TSLA-PERP": "xyz:TSLA",
  };
  for (const [name, coin] of Object.entries(cases)) assert.equal(resolveStock(name), coin, name);
  for (const bad of ["", null, "BTC", "ETH", "SPX", "GOLD", "xyz:GOLD", "xyz:AVGO", "tes", "apple pie"]) assert.equal(resolveStock(bad), null, String(bad));
});

test("a sentence -> the stock it names; ambiguous words count only as the capital ticker", () => {
  const cases = {
    "long TSLA 10 3x": "xyz:TSLA",
    "ซื้อ Tesla 10 ดอล": "xyz:TSLA",
    "เทสล่า": "xyz:TSLA",
    "short nvidia 20 usdc 5x": "xyz:NVDA",
    "ซื้อหุ้นแอปเปิ้ล 15 ดอลลาร์": "xyz:AAPL",
    "long COIN 10 3x": "xyz:COIN",
    "long S&P 500 10": "xyz:SP500",
    "nasdaq ขึ้นไหม": "xyz:XYZ100",
    "short $MSFT": "xyz:MSFT",
  };
  for (const [text, coin] of Object.entries(cases)) assert.equal(findStockInText(text), coin, text);
  for (const text of ["which coin should I buy", "what is the oracle price", "meta strategy for today", "mu", "long BTC 10 3x", "long SPX 10", "hey any plan", "", null]) {
    assert.equal(findStockInText(text), null, String(text));
  }
  assert.equal(findStockInText("TSLA or NVDA?"), "xyz:TSLA", "the first one named");
});

test("every whitelisted stock has names, every alias points into the whitelist, and nothing clashes with a main-dex coin", () => {
  const wl = new Set(STOCK_WHITELIST.map((w) => w.coin));
  for (const c of Object.keys(STOCK_ALIASES)) assert.ok(wl.has(c), c);
  for (const w of STOCK_WHITELIST) assert.equal(resolveStock(w.name), w.coin, w.name);
  /* The main dex's live names (2026-10-15 allPerpMetas summary has only counts, so use the xyz fixture's
     own check: no whitelisted ticker or alias is a main-dex coin name). */
  const MAIN = ["BTC", "ETH", "SOL", "HYPE", "SPX", "kPEPE", "PUMP", "ZEC", "XRP", "ENA", "NEAR", "LIT", "CHIP", "NIL", "GRASS"];
  for (const m of MAIN) assert.equal(resolveStock(m), null, m);
  assert.ok(fx("xyz-meta-and-asset-ctxs")[0].universe.some((u) => u.name === "xyz:TSLA"));
});
