/**
 * test-agent-shortcuts — the Agent's no-LLM parser (src/agent/shortcuts.js). If the free model is rate limited
 * during the demo, these sentences must still become the right trade card. Thai and English.
 *
 * Run: node --test scripts/test-agent-shortcuts.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShortcut, findCoin } from "../src/agent/shortcuts.js";

const COINS = ["BTC", "ETH", "SOL", "HYPE", "kPEPE", "DOGE"];

test("S1) the owner's demo sentence: long ETH 20 ดอล 5x TP 10% SL 5%", () => {
  assert.deepEqual(parseShortcut("long ETH 20 ดอล 5x TP 10% SL 5%", COINS), {
    kind: "open", coin: "ETH", side: "buy", marginUsdc: 20, leverage: 5, tpPct: 10, slPct: 5,
  });
});

test("S2) English, lower case, no TP/SL: short btc 15 3x", () => {
  assert.deepEqual(parseShortcut("short btc 15 3x", COINS), {
    kind: "open", coin: "BTC", side: "sell", marginUsdc: 15, leverage: 3, tpPct: null, slPct: null,
  });
});

test("S3) $ and usdc units, leverage written as 'x10' or 'lev 10'", () => {
  assert.equal(parseShortcut("buy SOL $12.5 x10", COINS).marginUsdc, 12.5);
  assert.equal(parseShortcut("buy SOL $12.5 x10", COINS).leverage, 10);
  assert.equal(parseShortcut("long hype 18 usdc lev 4", COINS).leverage, 4);
  assert.equal(parseShortcut("long hype 18 usdc lev 4", COINS).marginUsdc, 18);
});

test("S4) Thai sides: ลอง / ชอร์ต / ซื้อ / ขาย", () => {
  assert.equal(parseShortcut("ลอง ETH 20 5x", COINS).side, "buy");
  assert.equal(parseShortcut("ชอร์ต ETH 20 5x", COINS).side, "sell");
  assert.equal(parseShortcut("ขาย BTC 10 2x", COINS).side, "sell");
});

test("S5) a trade with no margin still parses, with margin null (the Agent then asks how much)", () => {
  const r = parseShortcut("long ETH 5x", COINS);
  assert.equal(r.kind, "open");
  assert.equal(r.marginUsdc, null);
  assert.equal(r.leverage, 5);
});

test("S6) the leverage is never read as the margin, nor the TP as the leverage", () => {
  const r = parseShortcut("long ETH 5x 20 tp 25 sl 10", COINS);
  assert.equal(r.leverage, 5);
  assert.equal(r.marginUsdc, 20);
  assert.equal(r.tpPct, 25);
  assert.equal(r.slPct, 10);
});

test("S7) close: half, all, a percent, Thai", () => {
  assert.deepEqual(parseShortcut("close half ETH", COINS), { kind: "close", coin: "ETH", fraction: 0.5 });
  assert.deepEqual(parseShortcut("close BTC", COINS), { kind: "close", coin: "BTC", fraction: 1 });
  assert.deepEqual(parseShortcut("close 25% sol", COINS), { kind: "close", coin: "SOL", fraction: 0.25 });
  assert.deepEqual(parseShortcut("ปิดครึ่งนึง ETH", COINS).fraction, 0.5);
  assert.deepEqual(parseShortcut("ปิด ETH", COINS), { kind: "close", coin: "ETH", fraction: 1 });
});

test("S7b) 🔴 เปิด (open) contains ปิด (close): 'เปิดลอง ETH' is an OPEN, never a close", () => {
  const r = parseShortcut("เปิดลอง ETH 20 5x", COINS);
  assert.equal(r.kind, "open");
  assert.equal(r.side, "buy");
  assert.equal(r.marginUsdc, 20);
});

test("S8) movers and account questions, in both languages", () => {
  assert.deepEqual(parseShortcut("Top movers", COINS), { kind: "movers" });
  assert.deepEqual(parseShortcut("วันนี้ตัวไหนวิ่งแรงสุด", COINS), { kind: "movers" });
  assert.deepEqual(parseShortcut("My PnL", COINS), { kind: "account" });
  assert.deepEqual(parseShortcut("position เป็นไงบ้าง", COINS), { kind: "account" });
});

test("S8b) a TP / SL with no side is for the open position: 'tp 25 sl 10 ETH', 'sl 15% btc'", () => {
  assert.deepEqual(parseShortcut("tp 25 sl 10 ETH", COINS), { kind: "tpsl", coin: "ETH", tpPct: 25, slPct: 10 });
  assert.deepEqual(parseShortcut("sl 15% btc", COINS), { kind: "tpsl", coin: "BTC", tpPct: null, slPct: 15 });
  assert.equal(parseShortcut("long ETH 20 5x tp 25", COINS).kind, "open", "a side still means a new order");
});

test("S9) Hyperliquid's k-prefixed names: 'PEPE' finds kPEPE", () => {
  assert.equal(findCoin("long pepe 10 3x", COINS), "kPEPE");
});

test("S10) anything else is not a shortcut (it goes to the LLM)", () => {
  assert.equal(parseShortcut("what is funding?", COINS), null);
  assert.equal(parseShortcut("long the market", COINS), null);
  assert.equal(parseShortcut("", COINS), null);
});

test("S11) an Analyze pill's words are never an order, even when they name a side: 'Analyze HYPE long Bolder'", () => {
  assert.equal(parseShortcut("Analyze HYPE long Bolder", COINS), null);
  assert.equal(parseShortcut("Analyze ZEC 3x short", COINS), null, "the pill's words now: leverage and side, as a person says it");
  assert.equal(parseShortcut("Analyze ETH 10x long with Tokenomist", COINS), null);
  assert.equal(parseShortcut("Analyze ETH short Balanced with Tokenomist", COINS), null);
  assert.equal(parseShortcut("วิเคราะห์ ETH ลอง", COINS), null);
  assert.equal(parseShortcut("long ETH 20 5x", COINS).kind, "open", "a plain order is still a shortcut");
});
