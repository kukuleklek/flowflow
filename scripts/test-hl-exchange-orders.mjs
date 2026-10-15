/**
 * test-hl-exchange-orders — WHAT A FLOWFLOW ORDER SAYS ON THE WIRE, AND WHAT A REPLY MEANS.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner: "amount ขอเป็น USDC ได้ปะ" / "ในหน้าซื้อขาย หน้า Position อะ ทำ Full Wire".
 * The amount a reader types is USDC of margin; the order Hyperliquid receives is
 * a coin SIZE at a PRICE, both strings under the venue's tick and lot rules
 * (tick-and-lot-size docs, 2026-09-22). This suite pins the pure half of
 * src/lib/hyperliquid/exchange/orders.js:
 *
 *   R. rounding tables: 5 significant figures, at most 6 - szDecimals decimals,
 *      and the INTEGER RULE (an integer price is always valid, so BTC over
 *      100,000 snaps to 1, not 10 — critic_A); sizes to szDecimals; decimal
 *      rounding, never binary (1.005 -> 1.01);
 *   M. the $10 minimum is checked AFTER rounding, at the lower of the mid and the
 *      order's own price — whichever price Hyperliquid measures, it passes;
 *   S. market = IOC at mid +/- slippage from the CURRENT mid;
 *   B. the builder field rides only when an address AND a fee are both set, is
 *      absent (not undefined) otherwise, and a half-set config is refused;
 *   O. open with TP/SL = one normalTpsl group; later edits = positionTpsl;
 *      close = reduce-only IOC by fraction; leverage = isolated integer;
 *      cancel by oid; the TP/SL MOVE plan places before it cancels;
 *   P. every reply shape (filled / resting / error / waiting, default, cancel
 *      success) parses, and the known error strings map to plain English while
 *      an unknown one passes through VERBATIM;
 *   G. source guards for this folder (comments stripped).
 *
 * Pure: no network, no clock, no storage. Run: node --test scripts/test-hl-exchange-orders.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "./lib/stripComments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (rel) => path.join(ROOT, rel);
const DIR = "src/lib/hyperliquid/exchange";
const EX = (f) => pathToFileURL(P(`${DIR}/${f}`)).href;

globalThis.fetch = () => { throw new Error("test-hl-exchange-orders: a real network call was attempted"); };

let O;
before(async () => { O = await import(EX("orders.js")); });

/* Market rows shaped like lib/hyperliquid/markets.js rows (live meta 2026-09-22). */
const BTC = { coin: "BTC", assetIndex: 0, szDecimals: 5, maxLeverage: 40, midPx: 85721.5, markPx: 85720, px: 85721.5, onlyIsolated: false, marginMode: null };
const ETH = { coin: "ETH", assetIndex: 1, szDecimals: 4, maxLeverage: 25, midPx: 2900, markPx: 2900, px: 2900, onlyIsolated: false, marginMode: null };
const SOL = { coin: "SOL", assetIndex: 5, szDecimals: 2, maxLeverage: 20, midPx: 116.6953, markPx: 116.7, px: 116.6953, onlyIsolated: false, marginMode: null };
const KPEPE = { coin: "kPEPE", assetIndex: 98, szDecimals: 0, maxLeverage: 10, midPx: 0.005116, markPx: 0.005116, px: 0.005116, onlyIsolated: false, marginMode: null };
const BUILDER = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
const CLOIDS = { entry: "0x000000000000000000000000000000a1", tp: "0x000000000000000000000000000000a2", sl: "0x000000000000000000000000000000a3" };

/* ════════════════════════════════════════════════════════════════════════════
   R. ROUNDING
   ════════════════════════════════════════════════════════════════════════════ */

test("R1) order prices: 5 significant figures, at most 6 - szDecimals decimals, one rounding, nearest", () => {
  const rows = [
    // [px, szDecimals, expected]
    [85721.5, 5, "85722"],          // BTC: 5 sig figs on a 5-digit integer part is a tick of 1
    [85721.49, 5, "85721"],
    [2733.64, 4, "2733.6"],         // ETH
    [1670.1, 4, "1670.1"],
    [3.14159, 4, "3.14"],           // capped at 6 - 4 = 2 decimals
    [116.6953, 2, "116.7"],         // SOL (trailing zero trimmed: 116.70)
    [0.123456, 2, "0.1235"],        // 5 sig figs would be 0.12346; the 4-decimal cap wins
    [0.005116, 0, "0.005116"],      // kPEPE
    [0.00511649, 0, "0.005116"],    // ONE rounding to 6 decimals, not 5 sig figs then 6 (which would give 0.005117)
    [0.000012345, 0, "0.000012"],
    [99999.7, 5, "100000"],         // the carry lands on an integer, which is always valid
    [9.99996, 2, "10"],
    [40, 1, "40"],
    [0.5, 4, "0.5"],
  ];
  for (const [px, sz, want] of rows) assert.equal(O.roundHlOrderPx(px, sz), want, `${px} @ szDecimals ${sz}`);
});

test("R2) the INTEGER RULE: at or above 100,000 a price rounds to a whole number, not to 5 significant figures (critic_A)", () => {
  assert.equal(O.roundHlOrderPx(123456.7, 5), "123457", "5 sig figs would coarsen this to 123460");
  assert.equal(O.roundHlOrderPx(100000.4, 5), "100000");
  assert.equal(O.roundHlOrderPx(1234567.89, 0), "1234568");
  assert.equal(O.roundHlOrderPx(123456.7, 5, "down"), "123456");
  assert.equal(O.roundHlOrderPx(123456.2, 5, "up"), "123457");
});

test("R3) directional rounding is decimal-exact (0.29 stays 0.29 going down), and bad input is unknown, never 0", () => {
  assert.equal(O.roundHlOrderPx(0.29, 2, "down"), "0.29");
  assert.equal(O.roundHlOrderPx(85721.5, 5, "down"), "85721");
  assert.equal(O.roundHlOrderPx(85721.1, 5, "up"), "85722");
  assert.equal(O.roundHlOrderPx(1.2345, 2, "up"), "1.2345");
  for (const bad of [null, undefined, NaN, -1, 0, "abc", Infinity]) assert.equal(O.roundHlOrderPx(bad, 2), null, String(bad));
  assert.equal(O.roundHlOrderPx(100, -1), null, "an unknown szDecimals is unknown");
  assert.equal(O.roundHlOrderPx(100, 1.5), null);
});

test("R4) sizes round to szDecimals, decimally (1.005 -> 1.01, not the binary 1.00), and can round to zero", () => {
  const rows = [
    [0.0147, 4, "nearest", "0.0147"],
    [0.00011699, 5, "nearest", "0.00012"],
    [0.00011699, 5, "down", "0.00011"],
    [1.005, 2, "nearest", "1.01"],
    [0.004, 2, "nearest", "0"],
    [123.456, 0, "nearest", "123"],
    [0.5, 2, "nearest", "0.5"],
    [2.675, 2, "nearest", "2.68"],
  ];
  for (const [sz, d, mode, want] of rows) assert.equal(O.roundHlSize(sz, d, mode), want, `${sz} @ ${d} ${mode}`);
  assert.equal(O.roundHlSize(-1, 2), null);
  assert.equal(O.roundHlSize(1, -2), null);
});

test("R5) the wire form is the Python SDK's float_to_wire: normalised, no exponent, and it refuses to round", () => {
  assert.equal(O.hlDecimalString(100), "100");
  assert.equal(O.hlDecimalString(0.0147), "0.0147");
  assert.equal(O.hlDecimalString(1670.1), "1670.1");
  assert.equal(O.hlDecimalString(1e-7), "0.0000001");
  assert.equal(O.hlDecimalString("2733.60"), "2733.6");
  assert.equal(O.hlDecimalString(-0), "0");
  assert.equal(O.hlDecimalString(1e-9), null, "more than 8 decimals would be rounded: refused");
  assert.equal(O.hlDecimalString("1e3"), null, "no exponent notation on the wire");
  assert.equal(O.hlDecimalString(NaN), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   S / M. SLIPPAGE PRICE AND THE $10 MINIMUM AFTER ROUNDING
   ════════════════════════════════════════════════════════════════════════════ */

test("S1) the market price is the CURRENT mid moved by the slippage, then rounded to a valid tick", () => {
  assert.equal(O.HL_DEFAULT_SLIPPAGE, 0.05, "the official Python SDK's DEFAULT_SLIPPAGE");
  assert.equal(O.hlSlippagePx({ refPx: 85721.5, isBuy: true, slippage: 0.05, szDecimals: 5 }), "90008");
  assert.equal(O.hlSlippagePx({ refPx: 85721.5, isBuy: false, slippage: 0.05, szDecimals: 5 }), "81435");
  assert.equal(O.hlSlippagePx({ refPx: 1891.4, isBuy: true, slippage: 0.01, szDecimals: 4 }), "1910.3");
  assert.equal(O.hlSlippagePx({ refPx: 0.005116, isBuy: false, slippage: 0.05, szDecimals: 0 }), "0.00486");
  assert.equal(O.hlSlippagePx({ refPx: null, isBuy: true, slippage: 0.05, szDecimals: 5 }), null, "no mid, no price");
  assert.equal(O.hlSlippagePx({ refPx: 100, isBuy: true, slippage: 0.5, szDecimals: 2 }), null, "slippage above the 10% cap is refused");
  assert.equal(O.hlSlippagePx({ refPx: 100, isBuy: true, slippage: 0, szDecimals: 2 }), null, "zero slippage is not a market order");
});

test("M1) $10 minimum: value = size x the LOWER of the mid and the limit price, after rounding", () => {
  assert.equal(O.HL_MIN_ORDER_USDC, 10);
  assert.deepEqual(O.checkOpenMinimum({ size: "0.00012", refPx: 85721.5, limitPx: "90008" }), { ok: true, valueUsdc: 0.00012 * 85721.5 });
  const sell = O.checkOpenMinimum({ size: "0.00012", refPx: 85721.5, limitPx: "81435" });
  assert.equal(sell.ok, false, "a sell's limit sits under the mid: measured there it is $9.77");
  assert.ok(Math.abs(sell.valueUsdc - 9.7722) < 1e-9);
  assert.equal(O.checkOpenMinimum({ size: "0", refPx: 100, limitPx: "105" }).ok, false);
  assert.deepEqual(O.checkOpenMinimum({ size: null, refPx: 100, limitPx: "105" }), { ok: false, valueUsdc: null });
});

test("M2) the $10 EDGE AFTER ROUNDING: $10 of margin at 1x on ETH at 2,900 is 0.0034 ETH = $9.86 — refused before it is signed", () => {
  const plan = O.planOpenMarket({ market: ETH, side: "buy", marginUsdc: 10, leverage: 1, cloids: CLOIDS });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "min_value");
  assert.equal(plan.size, "0.0034");
  assert.ok(Math.abs(plan.valueUsdc - 9.86) < 1e-9);
  assert.match(plan.message, /\$10/);
  const up = O.planOpenMarket({ market: { ...ETH, midPx: 2860, px: 2860 }, side: "buy", marginUsdc: 10, leverage: 1, cloids: CLOIDS });
  assert.equal(up.ok, true, "at 2,860 the same $10 rounds UP to 0.0035 ETH = $10.01");
  assert.equal(up.size, "0.0035");
  const lev = O.planOpenMarket({ market: ETH, side: "buy", marginUsdc: 10, leverage: 5, cloids: CLOIDS });
  assert.equal(lev.ok, true);
  assert.equal(lev.size, "0.0172", "$50 of notional / 2,900 = 0.017241 -> 0.0172");
});

/* ════════════════════════════════════════════════════════════════════════════
   B. THE BUILDER FIELD
   ════════════════════════════════════════════════════════════════════════════ */

test("B1) resolveBuilder: on only when a valid address AND a fee of 1..100 tenths of a bp are both set; half-set is refused, not guessed", () => {
  assert.deepEqual(O.resolveBuilder({ address: "", feeTenthsBp: 0 }), { enabled: false, invalid: false, reason: "unset" });
  assert.deepEqual(O.resolveBuilder({}), { enabled: false, invalid: false, reason: "unset" });
  assert.deepEqual(O.resolveBuilder({ address: BUILDER.toUpperCase().replace("0X", "0x"), feeTenthsBp: 50 }),
    { enabled: true, invalid: false, reason: null, b: BUILDER, f: 50, maxFeeRate: "0.05%" });
  assert.deepEqual(O.resolveBuilder({ address: BUILDER, feeTenthsBp: 0 }), { enabled: false, invalid: false, reason: "zero_fee" });
  for (const [cfg, reason] of [
    [{ address: "", feeTenthsBp: 50 }, "half_set"],
    [{ address: BUILDER, feeTenthsBp: undefined }, "half_set"],
    [{ address: "0x1234", feeTenthsBp: 50 }, "bad_address"],
    [{ address: BUILDER, feeTenthsBp: null }, "bad_fee"],
    [{ address: BUILDER, feeTenthsBp: 101 }, "bad_fee"],
    [{ address: BUILDER, feeTenthsBp: 1.5 }, "bad_fee"],
  ]) {
    const r = O.resolveBuilder(cfg);
    assert.equal(r.enabled, false, JSON.stringify(cfg));
    assert.equal(r.invalid, true, JSON.stringify(cfg));
    assert.equal(r.reason, reason, JSON.stringify(cfg));
  }
});

test("B2) maxFeeRate is a percent string: f tenths of a bp / 1000 %", () => {
  assert.equal(O.builderMaxFeeRate(1), "0.001%", "the official example: f 1 with 0.001%");
  assert.equal(O.builderMaxFeeRate(10), "0.01%");
  assert.equal(O.builderMaxFeeRate(50), "0.05%");
  assert.equal(O.builderMaxFeeRate(100), "0.1%");
  assert.equal(O.builderMaxFeeRate(0), null);
  assert.equal(O.builderMaxFeeRate(101), null);
});

test("B3) builder PRESENT: {b, f} rides last on every order action; ABSENT: the key does not exist at all", () => {
  const on = O.resolveBuilder({ address: BUILDER, feeTenthsBp: 50 });
  const off = O.resolveBuilder({ address: "", feeTenthsBp: 0 });
  const withB = O.planOpenMarket({ market: BTC, side: "buy", marginUsdc: 20, leverage: 5, builder: on, cloids: CLOIDS });
  assert.deepEqual(withB.action.builder, { b: BUILDER, f: 50 });
  assert.deepEqual(Object.keys(withB.action), ["type", "orders", "grouping", "builder"]);
  const without = O.planOpenMarket({ market: BTC, side: "buy", marginUsdc: 20, leverage: 5, builder: off, cloids: CLOIDS });
  assert.equal("builder" in without.action, false);
  assert.deepEqual(Object.keys(without.action), ["type", "orders", "grouping"]);
  const close = O.planCloseFraction({ market: BTC, position: { szi: "0.001" }, fraction: 1, builder: on, cloid: CLOIDS.entry });
  assert.deepEqual(close.action.builder, { b: BUILDER, f: 50 }, "closes pay the builder too (FOMO charges both sides)");
  const bad = O.planOpenMarket({ market: BTC, side: "buy", marginUsdc: 20, leverage: 5, builder: O.resolveBuilder({ address: "", feeTenthsBp: 50 }), cloids: CLOIDS });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "builder_config_invalid");
});

/* ════════════════════════════════════════════════════════════════════════════
   O. ORDER ACTIONS
   ════════════════════════════════════════════════════════════════════════════ */

test("O1) open market, no TP/SL: one IOC order at the slippage price, isolated leverage set first, grouping na", () => {
  const p = O.planOpenMarket({ market: BTC, side: "buy", marginUsdc: 20, leverage: 5, cloids: CLOIDS });
  assert.equal(p.ok, true);
  assert.equal(p.isBuy, true);
  assert.equal(p.size, "0.00117", "$100 / 85,721.5 = 0.0011666 -> 0.00117");
  assert.equal(p.limitPx, "90008");
  assert.deepEqual(p.leverageAction, { type: "updateLeverage", asset: 0, isCross: false, leverage: 5 });
  assert.deepEqual(p.action, {
    type: "order",
    orders: [{ a: 0, b: true, p: "90008", s: "0.00117", r: false, t: { limit: { tif: "Ioc" } }, c: CLOIDS.entry }],
    grouping: "na",
  });
  const short = O.planOpenMarket({ market: BTC, side: "sell", marginUsdc: 20, leverage: 5, cloids: CLOIDS });
  assert.equal(short.isBuy, false);
  assert.equal(short.action.orders[0].p, "81435");
});

test("O2) open with TP and SL rides ONE normalTpsl group: entry, then TP, then SL, children reduce-only market triggers on the closing side", () => {
  const p = O.planOpenMarket({ market: SOL, side: "buy", marginUsdc: 50, leverage: 4, tp: 130, sl: 110, cloids: CLOIDS });
  assert.equal(p.ok, true);
  assert.equal(p.action.grouping, "normalTpsl");
  assert.equal(p.size, "1.71", "$200 / 116.6953 = 1.7138 -> 1.71");
  assert.deepEqual(p.action.orders.slice(1), [
    { a: 5, b: false, p: "130", s: "1.71", r: true, t: { trigger: { isMarket: true, triggerPx: "130", tpsl: "tp" } }, c: CLOIDS.tp },
    { a: 5, b: false, p: "110", s: "1.71", r: true, t: { trigger: { isMarket: true, triggerPx: "110", tpsl: "sl" } }, c: CLOIDS.sl },
  ]);
  const onlySl = O.planOpenMarket({ market: SOL, side: "sell", marginUsdc: 50, leverage: 4, sl: 125, cloids: CLOIDS });
  assert.equal(onlySl.action.orders.length, 2);
  assert.deepEqual(onlySl.action.orders[1].t, { trigger: { isMarket: true, triggerPx: "125", tpsl: "sl" } });
  assert.equal(onlySl.action.orders[1].b, true, "a short's stop buys back");
});

test("O3) TP/SL on the wrong side of the mark would trigger at once ('Invalid TP/SL price') — refused before signing", () => {
  const bad = O.planOpenMarket({ market: SOL, side: "buy", marginUsdc: 50, leverage: 4, tp: 100, sl: 120, cloids: CLOIDS });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid_tpsl");
  assert.deepEqual(Object.keys(bad.errors).sort(), ["sl", "tp"]);
  assert.deepEqual(O.validateTpSl({ isLong: true, refPx: 100, tp: 110, sl: 90 }), { ok: true, errors: {} });
  assert.equal(O.validateTpSl({ isLong: true, refPx: 100, tp: 100 }).ok, false, "at the mark it fires immediately");
  assert.equal(O.validateTpSl({ isLong: false, refPx: 100, tp: 90, sl: 110 }).ok, true);
  assert.equal(O.validateTpSl({ isLong: false, refPx: null, tp: 90 }).ok, false, "no mark, no check: refused rather than guessed");
});

test("O4) inputs are refused, never silently changed: leverage must be a whole number within the market's max; margin a positive USDC figure", () => {
  const cases = [
    [{ leverage: 41 }, "bad_input"], [{ leverage: 2.5 }, "bad_input"], [{ leverage: 0 }, "bad_input"],
    [{ marginUsdc: 0 }, "bad_input"], [{ marginUsdc: -5 }, "bad_input"], [{ marginUsdc: NaN }, "bad_input"],
    [{ side: "up" }, "bad_input"], [{ slippage: 0.5 }, "bad_input"],
    [{ market: null }, "market_unknown"], [{ market: { ...BTC, midPx: null, px: null } }, "price_unknown"],
    [{ market: { ...BTC, szDecimals: null } }, "market_unknown"],
    [{ market: { ...BTC, stale: true } }, "price_stale"],
  ];
  for (const [over, code] of cases) {
    const p = O.planOpenMarket({ market: BTC, side: "buy", marginUsdc: 20, leverage: 5, cloids: CLOIDS, ...over });
    assert.equal(p.ok, false, JSON.stringify(over));
    assert.equal(p.code, code, JSON.stringify(over));
  }
  assert.equal(O.planOpenMarket({ market: BTC, side: "long", marginUsdc: 20, leverage: 5, cloids: CLOIDS }).isBuy, true);
  assert.equal(O.planOpenMarket({ market: BTC, side: "short", marginUsdc: 20, leverage: 5, cloids: CLOIDS }).isBuy, false);
});

test("O5) close by fraction: reduce-only IOC on the closing side; 100% sends the position's exact size; a share rounds DOWN, never past the pick; dust is refused", () => {
  const half = O.planCloseFraction({ market: SOL, position: { szi: "-3.5" }, fraction: 0.5, cloid: CLOIDS.entry });
  assert.equal(half.ok, true);
  assert.deepEqual(half.action.orders[0], { a: 5, b: true, p: O.hlSlippagePx({ refPx: SOL.midPx, isBuy: true, slippage: 0.05, szDecimals: 2 }), s: "1.75", r: true, t: { limit: { tif: "Ioc" } }, c: CLOIDS.entry });
  assert.equal(half.closesAll, false);
  const all = O.planCloseFraction({ market: SOL, position: { szi: 3.51 }, fraction: 1, cloid: CLOIDS.entry });
  assert.equal(all.action.orders[0].s, "3.51");
  assert.equal(all.action.orders[0].b, false);
  assert.equal(all.closesAll, true);
  const nearly = O.planCloseFraction({ market: SOL, position: { szi: "3.51" }, fraction: 0.999, cloid: CLOIDS.entry });
  assert.equal(nearly.action.orders[0].s, "3.5", "99.9% of 3.51 rounds DOWN to the lot: never more than the share picked");
  assert.equal(nearly.closesAll, false);
  /* A small position: 50% of 0.03 SOL is 0.015, between two lots. Rounding to
     the NEAREST lot would send 0.02 (67% of the position) under a 50% slide. */
  const half3 = O.planCloseFraction({ market: SOL, position: { szi: "0.03" }, fraction: 0.5, cloid: CLOIDS.entry });
  assert.equal(half3.action.orders[0].s, "0.01", "down to the lot, never up past the pick");
  const most = O.planCloseFraction({ market: SOL, position: { szi: "-0.35" }, fraction: 0.75, cloid: CLOIDS.entry });
  assert.equal(most.action.orders[0].s, "0.26", "75% of 0.35 is 0.2625: 0.26, not 0.27");
  for (const f of [0.01, 0.25, 0.33, 0.5, 0.75, 0.99]) {
    const pl = O.planCloseFraction({ market: SOL, position: { szi: "1.37" }, fraction: f, cloid: CLOIDS.entry });
    assert.ok(Number(pl.action.orders[0].s) <= 1.37 * f + 1e-12, `${f}: sent ${pl.action.orders[0].s}, more than the share`);
  }
  assert.equal(O.planCloseFraction({ market: SOL, position: { szi: "0.5" }, fraction: 0.001, cloid: CLOIDS.entry }).code, "too_small");
  assert.equal(O.planCloseFraction({ market: SOL, position: { szi: "0" }, fraction: 1, cloid: CLOIDS.entry }).code, "no_position");
  assert.equal(O.planCloseFraction({ market: SOL, position: null, fraction: 1, cloid: CLOIDS.entry }).code, "no_position");
  assert.equal(O.planCloseFraction({ market: SOL, position: { szi: "1" }, fraction: 1.5, cloid: CLOIDS.entry }).code, "bad_input");
  assert.equal(O.planCloseFraction({ market: SOL, position: { szi: "1" }, fraction: 0, cloid: CLOIDS.entry }).code, "bad_input");
});

test("O6) a close is never held to the client $10 guard: a $5 position can still be closed from FlowFlow (critic_A)", () => {
  const dust = O.planCloseFraction({ market: SOL, position: { szi: "0.04" }, fraction: 1, cloid: CLOIDS.entry });
  assert.equal(dust.ok, true);
  assert.equal(dust.action.orders[0].s, "0.04");
});

test("O7) add to a position: same side, the position's own leverage, $10 minimum after rounding, no leverage change", () => {
  const add = O.planAddMarket({ market: ETH, position: { szi: "-0.5", leverage: 10 }, marginUsdc: 20, cloid: CLOIDS.entry });
  assert.equal(add.ok, true);
  assert.equal(add.isBuy, false, "a short adds by selling");
  assert.equal(add.size, "0.069", "$200 / 2,900 = 0.068966 -> 0.069 at 4 decimals");
  assert.equal(add.leverage, 10);
  assert.equal("leverageAction" in add, false);
  assert.equal(add.action.orders[0].r, false);
  assert.equal(O.planAddMarket({ market: ETH, position: { szi: "0" }, marginUsdc: 20, cloid: CLOIDS.entry }).code, "no_position");
  assert.equal(O.planAddMarket({ market: ETH, position: { szi: "1", leverage: null }, marginUsdc: 20, cloid: CLOIDS.entry }).code, "state_unknown");
});

test("O8) position TP/SL: one positionTpsl action, sized to the whole position, reduce-only, TP before SL", () => {
  const on = O.resolveBuilder({ address: BUILDER, feeTenthsBp: 10 });
  const p = O.planPositionTpsl({ market: BTC, position: { szi: "0.002" }, tp: 90000.4, sl: 80000, builder: on, cloids: CLOIDS });
  assert.equal(p.ok, true);
  assert.deepEqual(p.action, {
    type: "order",
    orders: [
      { a: 0, b: false, p: "90000", s: "0.002", r: true, t: { trigger: { isMarket: true, triggerPx: "90000", tpsl: "tp" } }, c: CLOIDS.tp },
      { a: 0, b: false, p: "80000", s: "0.002", r: true, t: { trigger: { isMarket: true, triggerPx: "80000", tpsl: "sl" } }, c: CLOIDS.sl },
    ],
    grouping: "positionTpsl",
    builder: { b: BUILDER, f: 10 },
  });
});

test("O9) leverage is an isolated whole number; cancel is {a, o} per oid (oids past 2^32 stay integers)", () => {
  assert.deepEqual(O.buildUpdateLeverageAction({ asset: 3, leverage: 7 }), { type: "updateLeverage", asset: 3, isCross: false, leverage: 7 });
  assert.throws(() => O.buildUpdateLeverageAction({ asset: 3, leverage: 7.5 }), /whole number/);
  assert.deepEqual(O.buildCancelAction([{ asset: 0, oid: 77738308012 }, { asset: 5, oid: 12 }]), { type: "cancel", cancels: [{ a: 0, o: 77738308012 }, { a: 5, o: 12 }] });
  assert.throws(() => O.buildCancelAction([]), /nothing to cancel/);
});

const openOrder = (o) => ({ coin: "BTC", side: "A", limitPx: "80000", sz: "0.002", oid: 1, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: "80000", children: [], isPositionTpsl: true, reduceOnly: true, orderType: "Stop Market", origSz: "0.002", tif: null, cloid: null, ...o });

test("O10) classify the coin's reduce-only triggers into TP and SL from frontendOpenOrders; other coins and plain orders are ignored", () => {
  const list = [
    openOrder({ oid: 11, orderType: "Take Profit Market", triggerPx: "95000" }),
    openOrder({ oid: 12, orderType: "Stop Market", triggerPx: "80000" }),
    openOrder({ oid: 13, coin: "ETH", orderType: "Stop Market" }),
    openOrder({ oid: 14, isTrigger: false, orderType: "Limit" }),
    openOrder({ oid: 15, reduceOnly: false, orderType: "Stop Market" }),
  ];
  const c = O.classifyTpSlOrders(list, "BTC");
  assert.deepEqual(c.tp.map((x) => x.oid), [11]);
  assert.deepEqual(c.sl.map((x) => x.oid), [12]);
  assert.equal(c.tp[0].triggerPx, 95000);
  assert.deepEqual(O.classifyTpSlOrders(null, "BTC"), { tp: [], sl: [] });
});

test("O11) 🔴 the TP/SL MOVE places the new trigger FIRST and cancels the old one AFTER — a stop is never missing", () => {
  const existing = [openOrder({ oid: 21, orderType: "Stop Market", triggerPx: "80000" }), openOrder({ oid: 22, orderType: "Take Profit Market", triggerPx: "95000" })];
  const move = O.planTpSlMove({ market: BTC, position: { szi: "0.002" }, openOrders: existing, sl: 82000, cloids: CLOIDS });
  assert.equal(move.ok, true);
  assert.deepEqual(move.steps.map((s) => s.kind), ["placeNew", "cancelOld"], "place, then cancel");
  assert.equal(move.steps[0].action.grouping, "positionTpsl");
  assert.deepEqual(move.steps[0].action.orders.map((o) => o.t.trigger.tpsl), ["sl"], "only the leg that moves is placed");
  assert.deepEqual(move.steps[1].action, { type: "cancel", cancels: [{ a: 0, o: 21 }] }, "and only its old order is cancelled; the TP is untouched");
  const remove = O.planTpSlMove({ market: BTC, position: { szi: "0.002" }, openOrders: existing, tp: null, cloids: CLOIDS });
  assert.deepEqual(remove.steps.map((s) => s.kind), ["cancelOld"], "null removes: nothing to place");
  assert.deepEqual(remove.steps[0].action.cancels, [{ a: 0, o: 22 }]);
  const fresh = O.planTpSlMove({ market: BTC, position: { szi: "0.002" }, openOrders: [], tp: 95000, sl: 80000, cloids: CLOIDS });
  assert.deepEqual(fresh.steps.map((s) => s.kind), ["placeNew"], "nothing old: place only");
  const wrong = O.planTpSlMove({ market: BTC, position: { szi: "0.002" }, openOrders: existing, sl: 90000, cloids: CLOIDS });
  assert.equal(wrong.ok, false, "a long's stop above the mark would fire at once");
  assert.equal(wrong.code, "invalid_tpsl");
  assert.equal(O.planTpSlMove({ market: BTC, position: { szi: "0" }, openOrders: existing, sl: 82000, cloids: CLOIDS }).code, "no_position");
  assert.equal(O.planTpSlMove({ market: BTC, position: { szi: "0.002" }, openOrders: existing, cloids: CLOIDS }).code, "bad_input", "nothing asked");
});

/* ════════════════════════════════════════════════════════════════════════════
   P. REPLIES
   ════════════════════════════════════════════════════════════════════════════ */

test("P1) order statuses: filled {totalSz, avgPx, oid}, resting {oid}, error (mapped), and the grouped children's waiting states", () => {
  const r = O.parseExchangeResponse({
    status: "ok",
    response: { type: "order", data: { statuses: [
      { filled: { totalSz: "0.02", avgPx: "1891.4", oid: 77747314 } },
      { resting: { oid: 77738308, cloid: CLOIDS.tp } },
      { error: "Order must have minimum value of $10." },
      "waitingForFill",
      "waitingForTrigger",
    ] } },
  }, 200);
  assert.equal(r.ok, true);
  assert.equal(r.type, "order");
  assert.deepEqual(r.statuses[0], { kind: "filled", totalSz: "0.02", avgPx: "1891.4", oid: 77747314, cloid: null });
  assert.deepEqual(r.statuses[1], { kind: "resting", oid: 77738308, cloid: CLOIDS.tp });
  assert.equal(r.statuses[2].kind, "error");
  assert.equal(r.statuses[2].code, "min_value");
  assert.equal(r.statuses[2].hlText, "Order must have minimum value of $10.");
  assert.deepEqual(r.statuses[3], { kind: "waitingForFill" });
  assert.deepEqual(r.statuses[4], { kind: "waitingForTrigger" });
});

test("P2) a default ack, a cancel's success and missing-order, and a whole-request error", () => {
  assert.deepEqual(O.parseExchangeResponse({ status: "ok", response: { type: "default" } }, 200), { ok: true, type: "default", statuses: [] });
  const c = O.parseExchangeResponse({ status: "ok", response: { type: "cancel", data: { statuses: ["success", { error: "Order was never placed, already canceled, or filled." }] } } }, 200);
  assert.deepEqual(c.statuses[0], { kind: "success" });
  assert.equal(c.statuses[1].code, "order_gone");
  const e = O.parseExchangeResponse({ status: "err", response: "User or API Wallet 0x0123456789012345678901234567890123456789 does not exist." }, 200);
  assert.equal(e.ok, false);
  assert.equal(e.code, "agent_missing");
  assert.equal(e.needsEnable, true);
  assert.equal(e.hlText, "User or API Wallet 0x0123456789012345678901234567890123456789 does not exist.");
});

test("P3) transport-level replies: HTTP 429 is rate limiting, a 422 text passes through verbatim, garbage is a bad response", () => {
  assert.equal(O.parseExchangeResponse(null, 429, "Too Many Requests").code, "rate_limited");
  const u = O.parseExchangeResponse(null, 422, "Failed to deserialize the JSON body into the target type");
  assert.equal(u.ok, false);
  assert.equal(u.code, "hl_error");
  assert.equal(u.message, "Failed to deserialize the JSON body into the target type");
  assert.equal(O.parseExchangeResponse({ nonsense: true }, 200).code, "bad_response");
  assert.equal(O.parseExchangeResponse("<html>", 200).code, "bad_response");
});

test("P4) the error map: every known Hyperliquid string gets plain English; an unknown one passes through VERBATIM", () => {
  const table = [
    ["Order must have minimum value of $10.", "min_value", /\$10/],
    ["Insufficient margin to place order. asset=0", "insufficient_margin", /USDC/],
    ["Reduce only order would increase position. asset=5", "reduce_only", /closed/],
    ["Invalid TP/SL price. asset=0", "invalid_tpsl", /TP\/SL/],
    ["User or API Wallet 0xabc0000000000000000000000000000000000abc does not exist.", "agent_missing", /Enable trading/],
    ["Must deposit before performing actions. User: 0x0123456789012345678901234567890123456789", "must_deposit", /[Dd]eposit/],
    ["Too many cumulative requests sent (10050 > 10000) for cumulative volume traded $0.00.", "rate_limited", /wait|Wait/],
    ["Order price too far from oracle", "oracle_far", /slippage|price/],
    ["No liquidity available for market order.", "no_liquidity", /liquidity|trade/],
    ["Order could not immediately match against any resting orders. asset=5", "no_match", /match|price/],
    ["Order would cause position to exceed margin tier limit at current leverage", "margin_tier", /leverage/],
    ["Order would increase open interest while open interest is capped", "oi_cap", /cap/],
    ["Order would increase open interest too quickly", "oi_cap", /cap|later/],
    ["Order rejected due to price more aggressive than oracle while at open interest cap", "oi_cap", /cap/],
    ["Price must be divisible by tick size. asset=0", "tick_size", /price/i],
    ["Order was never placed, already canceled, or filled.", "order_gone", /already/],
    ["Builder fee has not been approved.", "builder_not_approved", /Enable trading/],
  ];
  for (const [text, code, re] of table) {
    const m = O.mapHlError(text);
    assert.equal(m.code, code, text);
    assert.match(m.message, re, text);
    assert.equal(m.hlText, text, "the exact Hyperliquid text is always kept");
  }
  assert.equal(O.mapHlError("User or API Wallet 0xabc0000000000000000000000000000000000abc does not exist.").needsEnable, true);
  assert.equal(O.mapHlError("Builder fee has not been approved.").needsEnable, true);
  assert.equal(O.mapHlError("Insufficient margin to place order.").needsEnable, false);
  const odd = O.mapHlError("Vault not registered: 0x12");
  assert.deepEqual(odd, { code: "hl_error", message: "Vault not registered: 0x12", hlText: "Vault not registered: 0x12", needsEnable: false });
  assert.equal(O.mapHlError("").code, "hl_error");
  assert.equal(O.mapHlError(null).message, "Hyperliquid refused the request without saying why.");
});

/* ════════════════════════════════════════════════════════════════════════════
   G. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

function walk(dir, out = []) {
  for (const e of fs.readdirSync(P(dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(jsx?|mjs|tsx?)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const code = (rel) => stripComments(fs.readFileSync(P(rel), "utf8"));

test("G1) the SDK is imported in ONE file (signing.js), only through its /signing subpath — never the valibot-heavy api/ modules", () => {
  const files = walk(DIR);
  const importers = files.filter((f) => /@nktkas\/hyperliquid/.test(code(f)));
  assert.deepEqual(importers, [`${DIR}/signing.js`]);
  const specs = [...code(`${DIR}/signing.js`).matchAll(/from\s+["'](@nktkas\/hyperliquid[^"']*)["']/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(specs)], ["@nktkas/hyperliquid/signing"]);
});

test("G2) ONE file POSTs to the exchange (transport.js); nothing here opens a socket or reads the env", () => {
  const files = walk(DIR);
  const posters = files.filter((f) => /fetchImpl\s*\(|fetch\s*\(/.test(code(f)));
  assert.deepEqual(posters, [`${DIR}/transport.js`]);
  for (const f of files) {
    const c = code(f);
    assert.doesNotMatch(c, /new WebSocket|XMLHttpRequest|hlWs\(|hlSubscribe\(/, `${f} opens its own connection (owner rule 4)`);
    assert.doesNotMatch(c, /import\.meta\.env/, `${f} reads the env: the builder config is passed in by the perp page`);
    assert.doesNotMatch(c, /VITE_PERP_BUILDER_FEE/, `${f}: the fee has ONE reader (perp/mock/config.js, test-perp-mock L1)`);
  }
});

test("G3) Perp money stays out of wallet money: nothing here touches usePortfolio, Cash, wallet prices or the header pills", () => {
  for (const f of walk(DIR)) {
    assert.doesNotMatch(code(f), /usePortfolio|useWalletMoney|portfolioScan|cashUsd|walletBook/, `${f} touches a wallet figure`);
  }
});

test("G4) the exchange layer is reachable ONLY from the lazy perp surfaces — the eager hyperliquid barrel never re-exports it", () => {
  assert.doesNotMatch(code("src/lib/hyperliquid/index.js"), /exchange/);
  const allowed = (f) => f.startsWith(`${DIR}/`) || f.startsWith("src/perp/")
    || f.startsWith("src/lib/hyperliquid/account/") || f.startsWith("src/lib/relay/");
  const importers = walk("src").filter((f) => /hyperliquid\/exchange|from\s+["']\.\/exchange|from\s+["']\.\.\/exchange/.test(code(f)));
  assert.deepEqual(importers.filter((f) => !allowed(f)), [], "a main-chunk import would ship signing code in the flag-off build");
});

test("G6) every new file is LF-only", () => {
  const mine = [...walk(DIR), ...fs.readdirSync(P("scripts")).filter((f) => /^test-hl-exchange.*\.mjs$/.test(f)).map((f) => `scripts/${f}`)];
  assert.ok(mine.length >= 8);
  for (const f of mine) assert.equal(fs.readFileSync(P(f)).includes(Buffer.from("\r\n")), false, `${f} has CRLF`);
});
