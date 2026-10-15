/**
 * test-exec-readback — AFTER A TRADE, DOES HYPERLIQUID HOLD WHAT THE CARD SAID?
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "อยากให้ Ensure ว่า Agent เรา Excute Positon ถูกต้องทุกรูปแบบเลยไหม
 * ทั้งหุ้น เทรด" (EXECUTION-ASSURANCE.md item 3: the post-trade read-back).
 *
 * src/lib/hyperliquid/readBack.js compareFill(card, clearinghouseState,
 * openOrders) is run against Hyperliquid's own answer shapes (the open-order
 * rows are copied from test-hl-account-fixtures.mjs's real frontendOpenOrders,
 * and one clearinghouseState is the real, unedited xyz answer in
 * scripts/fixtures/hip3/user-std-xyz-clearinghouse.json):
 *
 *   M. a matching fill is ok (crypto, stock, with and without TP / SL, add, half
 *      close, full close, TP / SL move and removal);
 *   X. every mismatch is a row with plain words: side, size beyond one lot,
 *      leverage, margin mode, TP / SL missing / wrong price / partial size /
 *      not reduce-only / wrong side / limit instead of market / duplicated /
 *      left behind, liquidation before the stop;
 *   U. unknown is never a pass: an unreadable state or order list is a row;
 *   R. readBackRequests carries the dex for a stock and never for a coin;
 *      readBackFill reads through an injected reader and never throws;
 *   W. no mismatch sentence names a dex, a venue or a pot (AGENT-STOCKS-AND-MAP item 3).
 *
 * Pure: no network (fetch is replaced by a thrower for the whole file).
 * Run: node --test scripts/test-exec-readback.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.fetch = () => { throw new Error("test-exec-readback: a real network call was attempted"); };

let R;
before(async () => {
  R = await import(pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/readBack.js")).href);
});

const USER = "0x14791697260E4c9A71f18484C9f997B308e59325";

/* A clearinghouseState answer in Hyperliquid's own shape. */
function state(positions = [], { withdrawable = "100" } = {}) {
  return {
    assetPositions: positions.map((p) => ({
      type: "oneWay",
      position: {
        coin: p.coin, szi: String(p.szi), leverage: { type: p.type || "isolated", value: p.lev ?? 5, ...(p.type === "cross" ? {} : { rawUsd: "-100.0" }) },
        entryPx: String(p.entryPx ?? 100), positionValue: "0", unrealizedPnl: "0", returnOnEquity: "0",
        liquidationPx: p.liq == null ? null : String(p.liq), marginUsed: "0", maxLeverage: 40,
        cumFunding: { allTime: "0.0", sinceOpen: "0.0", sinceChange: "0.0" },
      },
    })),
    marginSummary: { accountValue: "100", totalNtlPos: "0", totalRawUsd: "100", totalMarginUsed: "0" },
    crossMarginSummary: { accountValue: "100", totalNtlPos: "0", totalRawUsd: "100", totalMarginUsed: "0" },
    crossMaintenanceMarginUsed: "0", withdrawable, time: 1_790_000_000_000,
  };
}

/* A frontendOpenOrders row, in the exact key set Hyperliquid answers
   (test-hl-account-fixtures.mjs, real rows of 2026-09-22). */
let oid = 552_000_000_000;
function trig({ coin, leg, px, sz, side, reduceOnly = true, positionTpsl = false, market = true }) {
  const type = `${leg === "tp" ? "Take Profit" : "Stop"} ${market ? "Market" : "Limit"}`;
  return {
    coin, side, limitPx: String(px), sz: positionTpsl ? "0.0" : String(sz), oid: oid++, timestamp: 1_790_069_152_237,
    triggerCondition: `Price ${leg === "tp" ? "above" : "below"} ${px}`, isTrigger: true, triggerPx: String(px), children: [],
    isPositionTpsl: positionTpsl, reduceOnly, orderType: type, origSz: positionTpsl ? "0.0" : String(sz), tif: null, cloid: null,
  };
}

const codes = (r) => r.mismatches.map((m) => m.code).sort();

/* ════════════════════════════════════════════════════════════════════════════
   M. MATCHES
   ════════════════════════════════════════════════════════════════════════════ */

test("M1) crypto long, 5x isolated, TP + SL from the entry's normalTpsl group: ok, no rows", () => {
  const r = R.compareFill(
    { kind: "open", coin: "ETH", side: "buy", size: "0.0345", filledSz: "0.0345", szDecimals: 4, leverage: 5, tpPx: 3045, slPx: 2813 },
    state([{ coin: "ETH", szi: 0.0345, lev: 5, entryPx: 2900, liq: 2378.2 }]),
    [trig({ coin: "ETH", leg: "tp", px: "3045.0", sz: "0.0345", side: "A" }), trig({ coin: "ETH", leg: "sl", px: "2813.0", sz: "0.0345", side: "A" })],
  );
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.ok, true);
  assert.equal(r.unknown, false);
  assert.deepEqual({ ...r.position }, { side: "long", size: 0.0345, leverage: 5, marginMode: "isolated", liqPx: 2378.2 });
});

test("M2) stock short (xyz:TSLA, 3x isolated), positionTpsl legs (sz 0.0) cover the whole position: ok", () => {
  const r = R.compareFill(
    { kind: "open", coin: "xyz:TSLA", side: "sell", size: "0.079", filledSz: "0.079", szDecimals: 3, leverage: 3, tpPx: 361, slPx: 399 },
    state([{ coin: "xyz:TSLA", szi: -0.079, lev: 3, entryPx: 380, liq: 500 }]),
    [trig({ coin: "xyz:TSLA", leg: "tp", px: "361.0", side: "B", positionTpsl: true }), trig({ coin: "xyz:TSLA", leg: "sl", px: "399.0", side: "B", positionTpsl: true })],
  );
  assert.deepEqual(r.mismatches, [], JSON.stringify(r.mismatches));
  assert.equal(r.ok, true);
});

test("M3) an open with NO TP / SL and nothing on the book: ok; a partial IOC fill is judged on what FILLED, within one lot", () => {
  const none = R.compareFill({ kind: "open", coin: "BTC", side: "buy", size: "0.00117", filledSz: "0.00117", szDecimals: 5, leverage: 5 }, state([{ coin: "BTC", szi: 0.00117, lev: 5 }]), []);
  assert.equal(none.ok, true, JSON.stringify(none.mismatches));
  const partial = R.compareFill({ kind: "open", coin: "BTC", side: "buy", size: "0.00117", filledSz: "0.0009", szDecimals: 5, leverage: 5 }, state([{ coin: "BTC", szi: 0.0009, lev: 5 }]), []);
  assert.equal(partial.ok, true, "0.0009 filled and 0.0009 held");
  const lot = R.compareFill({ kind: "open", coin: "BTC", side: "buy", filledSz: "0.00117", szDecimals: 5, leverage: 5 }, state([{ coin: "BTC", szi: 0.00118, lev: 5 }]), []);
  assert.equal(lot.ok, true, "one lot (0.00001) apart is within the lot rounding");
});

test("M4) add to a long: the size is prior + filled, at the position's own leverage, and the old TP / SL still covers it", () => {
  const r = R.compareFill(
    { kind: "add", coin: "SOL", side: "buy", priorSzi: 0.5, filledSz: "0.43", szDecimals: 2, leverage: 10 },
    state([{ coin: "SOL", szi: 0.93, lev: 10 }]),
    [trig({ coin: "SOL", leg: "sl", px: "110.0", side: "A", positionTpsl: true })],
  );
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
});

test("M5) close half of a short: what is left is prior - filled, same side; close all: flat with no trigger left", () => {
  const half = R.compareFill({ kind: "close", coin: "ETH", priorSzi: -0.1, filledSz: "0.05", szDecimals: 4 }, state([{ coin: "ETH", szi: -0.05 }]), []);
  assert.equal(half.ok, true, JSON.stringify(half.mismatches));
  const all = R.compareFill({ kind: "close", coin: "xyz:TSLA", priorSzi: 0.079, filledSz: "0.079", closesAll: true, szDecimals: 3 }, state([]), []);
  assert.equal(all.ok, true, JSON.stringify(all.mismatches));
  assert.equal(all.position, null);
});

test("M6) TP / SL card: a moved stop is on the book at the new price; a REMOVED TP is gone; an untouched leg is not checked", () => {
  const moved = R.compareFill(
    { kind: "tpsl", coin: "ETH", slPx: 2850, tpPx: undefined, szDecimals: 4 },
    state([{ coin: "ETH", szi: 0.0345, lev: 5 }]),
    [trig({ coin: "ETH", leg: "sl", px: "2850.0", side: "A", positionTpsl: true }), trig({ coin: "ETH", leg: "tp", px: "9999.0", side: "A", positionTpsl: true })],
  );
  assert.equal(moved.ok, true, JSON.stringify(moved.mismatches));
  const removed = R.compareFill({ kind: "tpsl", coin: "ETH", tpPx: null, szDecimals: 4 }, state([{ coin: "ETH", szi: 0.0345 }]), []);
  assert.equal(removed.ok, true);
});

/* ════════════════════════════════════════════════════════════════════════════
   X. MISMATCHES — each a row, with words
   ════════════════════════════════════════════════════════════════════════════ */

test("X1) side flipped, size off by more than a lot, leverage and margin mode wrong: four rows", () => {
  const r = R.compareFill(
    { kind: "open", coin: "ETH", side: "buy", filledSz: "0.0345", szDecimals: 4, leverage: 5 },
    state([{ coin: "ETH", szi: -0.0400, lev: 20, type: "cross" }]),
    [],
  );
  assert.deepEqual(codes(r), ["leverage", "margin_mode", "side", "size"]);
  assert.equal(r.ok, false);
  const byCode = Object.fromEntries(r.mismatches.map((m) => [m.code, m]));
  assert.equal(byCode.side.text, "The ETH position is a short, but the card was a long.");
  assert.equal(byCode.size.text, "The ETH position size is 0.04; the card filled 0.0345.");
  assert.equal(byCode.leverage.text, "The ETH position is at 20x; the card said 5x.");
  assert.equal(byCode.margin_mode.text, "The ETH position is on cross margin; the card opened it isolated.");
  for (const m of r.mismatches) assert.equal(m.severity, "error");
});

test("X2) 🔴 the REAL xyz answer (fixtures/hip3, a cross xyz:TSLA position): a card that opened it isolated is flagged, never passed", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3/user-std-xyz-clearinghouse.json"), "utf8"));
  const tsla = fx.response.assetPositions.find((a) => a.position.coin === "xyz:TSLA").position;
  const r = R.compareFill({ kind: "open", coin: "xyz:TSLA", side: "buy", filledSz: tsla.szi, szDecimals: 3, leverage: tsla.leverage.value, label: "TSLA" }, fx.response, []);
  assert.deepEqual(codes(r), ["margin_mode"]);
  assert.match(r.mismatches[0].text, /^The TSLA position is on cross margin/);
});

test("X3) TP / SL legs: missing, wrong price, partial size, not reduce-only, wrong side, limit trigger, duplicated", () => {
  const pos = state([{ coin: "ETH", szi: 0.0345, lev: 5 }]);
  const card = { kind: "open", coin: "ETH", side: "buy", filledSz: "0.0345", szDecimals: 4, leverage: 5, tpPx: 3045, slPx: 2813 };
  assert.deepEqual(codes(R.compareFill(card, pos, [])), ["sl_missing", "tp_missing"]);
  assert.deepEqual(codes(R.compareFill(card, pos, [trig({ coin: "ETH", leg: "tp", px: "3100.0", sz: "0.0345", side: "A" }), trig({ coin: "ETH", leg: "sl", px: "2813.0", sz: "0.0345", side: "A" })])), ["tp_price"]);
  assert.deepEqual(codes(R.compareFill(card, pos, [trig({ coin: "ETH", leg: "tp", px: "3045.0", sz: "0.02", side: "A" }), trig({ coin: "ETH", leg: "sl", px: "2813.0", sz: "0.0345", side: "A" })])), ["tp_size"]);
  assert.deepEqual(codes(R.compareFill(card, pos, [trig({ coin: "ETH", leg: "tp", px: "3045.0", sz: "0.0345", side: "A" }), trig({ coin: "ETH", leg: "sl", px: "2813.0", sz: "0.0345", side: "A", reduceOnly: false })])), ["sl_not_reduce_only"]);
  assert.deepEqual(codes(R.compareFill(card, pos, [trig({ coin: "ETH", leg: "tp", px: "3045.0", sz: "0.0345", side: "B" }), trig({ coin: "ETH", leg: "sl", px: "2813.0", sz: "0.0345", side: "A" })])), ["tp_side"]);
  const lim = R.compareFill(card, pos, [trig({ coin: "ETH", leg: "tp", px: "3045.0", sz: "0.0345", side: "A", market: false }), trig({ coin: "ETH", leg: "sl", px: "2813.0", sz: "0.0345", side: "A" })]);
  assert.deepEqual(codes(lim), ["tp_not_market"]);
  assert.equal(lim.mismatches[0].severity, "warn");
  const two = R.compareFill(card, pos, [
    trig({ coin: "ETH", leg: "tp", px: "3045.0", sz: "0.0345", side: "A" }),
    trig({ coin: "ETH", leg: "sl", px: "2813.0", sz: "0.0345", side: "A" }),
    trig({ coin: "ETH", leg: "sl", px: "2700.0", sz: "0.0345", side: "A" }),
  ]);
  assert.deepEqual(codes(two), ["sl_extra"]);
  assert.equal(two.mismatches[0].text, "2 stop losses are open on this position, not one.");
});

test("X4) an open with no TP / SL but a leftover trigger on the book: flagged (client.js clears orphans first; this proves it did)", () => {
  const r = R.compareFill(
    { kind: "open", coin: "BTC", side: "buy", filledSz: "0.00117", szDecimals: 5, leverage: 5, tpPx: null, slPx: null },
    state([{ coin: "BTC", szi: 0.00117, lev: 5 }]),
    [trig({ coin: "BTC", leg: "sl", px: "80000.0", sz: "0.002", side: "A" })],
  );
  assert.deepEqual(codes(r), ["sl_unexpected"]);
  assert.equal(r.mismatches[0].text, "A stop loss at 80000 is still open, but the card had none.");
});

test("X5) a TP / SL card asked to REMOVE the stop, and it is still there: an error row", () => {
  const r = R.compareFill({ kind: "tpsl", coin: "ETH", slPx: null, szDecimals: 4 }, state([{ coin: "ETH", szi: 0.0345 }]), [trig({ coin: "ETH", leg: "sl", px: "2813.0", side: "A", positionTpsl: true })]);
  assert.deepEqual(codes(r), ["sl_unexpected"]);
  assert.equal(r.mismatches[0].severity, "error");
});

test("X6) close all, but the position is still open; or flat with its triggers left behind", () => {
  const open = R.compareFill({ kind: "close", coin: "BTC", priorSzi: 0.002, filledSz: "0.002", closesAll: true, szDecimals: 5 }, state([{ coin: "BTC", szi: 0.002 }]), []);
  assert.deepEqual(codes(open), ["still_open"]);
  const orphans = R.compareFill({ kind: "close", coin: "BTC", priorSzi: 0.002, filledSz: "0.002", closesAll: true, szDecimals: 5 }, state([]), [trig({ coin: "BTC", leg: "tp", px: "99000.0", sz: "0.002", side: "A" })]);
  assert.deepEqual(codes(orphans), ["orphan_triggers"]);
  assert.equal(orphans.mismatches[0].text, "1 take profit / stop loss order is still open on BTC after the position closed.");
});

test("X7) a stop that liquidation reaches first never fires: flagged (long and short)", () => {
  const long = R.compareFill({ kind: "open", coin: "ETH", side: "buy", filledSz: "0.0345", szDecimals: 4, leverage: 20, slPx: 2700 }, state([{ coin: "ETH", szi: 0.0345, lev: 20, liq: 2780 }]), [trig({ coin: "ETH", leg: "sl", px: "2700.0", sz: "0.0345", side: "A" })]);
  assert.deepEqual(codes(long), ["liq_before_sl"]);
  const short = R.compareFill({ kind: "open", coin: "ETH", side: "sell", filledSz: "0.0345", szDecimals: 4, leverage: 20, slPx: 3100 }, state([{ coin: "ETH", szi: -0.0345, lev: 20, liq: 3020 }]), [trig({ coin: "ETH", leg: "sl", px: "3100.0", sz: "0.0345", side: "B" })]);
  assert.deepEqual(codes(short), ["liq_before_sl"]);
});

test("X8) add: a fixed-size stop that still covers only the OLD size is flagged; open / add with no position is position_missing", () => {
  const r = R.compareFill({ kind: "add", coin: "SOL", priorSzi: 0.5, filledSz: "0.43", szDecimals: 2, leverage: 10 }, state([{ coin: "SOL", szi: 0.93, lev: 10 }]), [trig({ coin: "SOL", leg: "sl", px: "110.0", sz: "0.5", side: "A" })]);
  assert.deepEqual(codes(r), ["sl_size"]);
  const gone = R.compareFill({ kind: "open", coin: "SOL", side: "buy", filledSz: "0.43", szDecimals: 2, leverage: 10 }, state([]), []);
  assert.deepEqual(codes(gone), ["position_missing"]);
  assert.equal(gone.mismatches[0].text, "No open SOL position was found after the trade.");
});

test("X9) a position in ANOTHER coin never satisfies the card (BTC held, ETH asked)", () => {
  const r = R.compareFill({ kind: "open", coin: "ETH", side: "buy", filledSz: "0.01", szDecimals: 4, leverage: 5 }, state([{ coin: "BTC", szi: 0.01 }]), []);
  assert.deepEqual(codes(r), ["position_missing"]);
});

/* ════════════════════════════════════════════════════════════════════════════
   U. UNKNOWN IS NEVER A PASS
   ════════════════════════════════════════════════════════════════════════════ */

test("U1) an unreadable state (null, an error string, no assetPositions, an unreadable szi) is state_unknown, ok:false", () => {
  const card = { kind: "open", coin: "ETH", side: "buy", filledSz: "0.01", szDecimals: 4, leverage: 5 };
  for (const s of [null, "error", {}, { assetPositions: "x" }, state([{ coin: "ETH", szi: "NaN" }])]) {
    const r = R.compareFill(card, s, []);
    assert.equal(r.ok, false);
    assert.equal(r.unknown, true);
    assert.deepEqual(codes(r), ["state_unknown"]);
  }
});

test("U2) orders unreadable while legs must be checked: an orders_unknown row (never 'no TP / SL')", () => {
  const r = R.compareFill({ kind: "open", coin: "ETH", side: "buy", filledSz: "0.01", szDecimals: 4, leverage: 5, tpPx: 3000 }, state([{ coin: "ETH", szi: 0.01, lev: 5 }]), null);
  assert.deepEqual(codes(r), ["orders_unknown"]);
  assert.equal(r.unknown, true);
});

test("U3) a card that says nothing checkable (no coin, unknown kind) is card_unknown", () => {
  for (const c of [null, {}, { kind: "open" }, { kind: "flip", coin: "ETH" }]) {
    const r = R.compareFill(c, state([]), []);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ["card_unknown"]);
  }
});

test("U4) a stock read in TWO answers (main + its own account) finds the position in either", () => {
  const r = R.compareFill({ kind: "open", coin: "xyz:NVDA", side: "buy", filledSz: "0.46", szDecimals: 3, leverage: 5 }, [state([{ coin: "BTC", szi: 0.01 }]), state([{ coin: "xyz:NVDA", szi: 0.46, lev: 5 }])], []);
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
});

/* ════════════════════════════════════════════════════════════════════════════
   R. THE READS
   ════════════════════════════════════════════════════════════════════════════ */

test("R1) readBackRequests: a stock carries its dex on BOTH reads, a main-dex coin carries none; bad input is null", () => {
  assert.deepEqual(R.readBackRequests(USER, "xyz:TSLA"), [
    { type: "clearinghouseState", user: USER.toLowerCase(), dex: "xyz" },
    { type: "frontendOpenOrders", user: USER.toLowerCase(), dex: "xyz" },
  ]);
  assert.deepEqual(R.readBackRequests(USER, "BTC"), [
    { type: "clearinghouseState", user: USER.toLowerCase() },
    { type: "frontendOpenOrders", user: USER.toLowerCase() },
  ]);
  for (const [u, c] of [["0x12", "BTC"], [USER, ""], [USER, "xyz:"], [USER, "../etc"], [null, "BTC"]]) assert.equal(R.readBackRequests(u, c), null);
});

test("R2) readBackFill: reads both bodies through the injected reader and compares; a throwing reader is state_unknown, never a throw", async () => {
  const asked = [];
  const info = async (body) => {
    asked.push(body);
    if (body.type === "clearinghouseState") return state([{ coin: "xyz:TSLA", szi: 0.05, lev: 5 }]);
    return [trig({ coin: "xyz:TSLA", leg: "sl", px: "370.0", side: "A", positionTpsl: true })];
  };
  const r = await R.readBackFill({ info, user: USER, card: { kind: "open", coin: "xyz:TSLA", side: "buy", filledSz: "0.05", szDecimals: 3, leverage: 5, slPx: 370, tpPx: null } });
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
  assert.deepEqual(asked.map((b) => b.dex), ["xyz", "xyz"]);
  const bad = await R.readBackFill({ info: async () => { throw new Error("down"); }, user: USER, card: { kind: "open", coin: "BTC", side: "buy", filledSz: "0.001", szDecimals: 5, leverage: 5 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.unknown, true);
  assert.deepEqual(codes(bad), ["state_unknown"]);
  const none = await R.readBackFill({});
  assert.deepEqual(codes(none), ["card_unknown"]);
});

/* ════════════════════════════════════════════════════════════════════════════
   W. WORDS
   ════════════════════════════════════════════════════════════════════════════ */

test("W1) no mismatch sentence names a dex, a venue, a pot, HIP-3, xyz or an API action, and each one ends with a full stop", () => {
  const BANNED = /\b(dex|venue|pot|hip-?3|xyz|trade\[xyz\]|clearinghouse|frontendOpenOrders|agentSendAsset|api)\b|กอง/i;
  const codesAll = [
    "state_unknown", "orders_unknown", "card_unknown", "position_missing", "still_open", "side", "size", "leverage", "margin_mode",
    "liq_before_sl", "tp_missing", "sl_missing", "tp_price", "sl_price", "tp_size", "sl_size", "tp_not_reduce_only", "sl_not_reduce_only",
    "tp_side", "sl_side", "tp_not_market", "sl_not_market", "tp_extra", "sl_extra", "tp_unexpected", "sl_unexpected", "orphan_triggers",
  ];
  for (const code of codesAll) {
    const t = R.readBackText(code, { want: 1, got: 2, label: "TSLA" });
    assert.doesNotMatch(t, BANNED, `${code}: ${t}`);
    assert.match(t, /[.:]$|\.$/, `${code} ends a sentence: ${t}`);
    assert.notEqual(t, "Something doesn't match what the card said.", `${code} has its own words`);
  }
  /* The label a stock row uses is its ticker, never the qualified name. */
  const r = R.compareFill({ kind: "open", coin: "xyz:TSLA", side: "buy", filledSz: "0.05", szDecimals: 3, leverage: 5 }, state([]), []);
  assert.doesNotMatch(r.mismatches[0].text, /xyz/);
  assert.match(r.mismatches[0].text, /TSLA/);
});
