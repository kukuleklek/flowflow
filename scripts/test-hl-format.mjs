/**
 * test-hl-format — Hyperliquid price and figure formatting (display only).
 *
 *   node --test scripts/test-hl-format.mjs
 *
 * Hyperliquid's tick rule for perps: at most 5 significant figures and at most
 * (6 - szDecimals) decimals; an integer price is always allowed. We use the same
 * rule to DISPLAY prices so a ticker never shows digits the venue cannot quote.
 * MONEY_RULES section 0: an unknown renders as the dash, never "$0".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HL_PRICE_SIG_FIGS, HL_PERP_MAX_DECIMALS,
  hlPriceDecimals, roundHlPrice, formatHlPrice, formatHlUsdCompact, formatHlPct,
  formatHlFunding, hlFundingAprPct, formatHlSize,
} from "../src/lib/hyperliquid/format.js";
import { DASH } from "../src/lib/format.js";

test("constants are the venue's", () => {
  assert.equal(HL_PRICE_SIG_FIGS, 5);
  assert.equal(HL_PERP_MAX_DECIMALS, 6);
});

test("decimals: 5 significant figures, capped at 6 - szDecimals", () => {
  // Live mainnet values seen 2026-09-22.
  assert.equal(hlPriceDecimals(85572.5, 5), 0);   // BTC: 5 integer digits leave none
  assert.equal(hlPriceDecimals(2733.55, 4), 1);   // ETH
  assert.equal(hlPriceDecimals(116.725, 2), 2);   // SOL
  assert.equal(hlPriceDecimals(1.51875, 0), 4);   // XRP
  assert.equal(hlPriceDecimals(0.006512, 0), 6);  // kPEPE-like: 5 s.f. wants 7, the cap says 6
  assert.equal(hlPriceDecimals(0.37621, 1), 5);   // 5 s.f. wants 5, cap is 5
  assert.equal(hlPriceDecimals(0.037621, 1), 5);  // 5 s.f. wants 6, cap is 5
  assert.equal(hlPriceDecimals(123456.7, 0), 0);  // an integer price is always allowed
  assert.equal(hlPriceDecimals(4.6444, 1), 4);    // FOMO's LIT header price
});

test("decimals: unknown szDecimals falls back to the perp cap, unknown price is null", () => {
  assert.equal(hlPriceDecimals(0.0012345, null), 6);
  assert.equal(hlPriceDecimals(null, 2), null);
  assert.equal(hlPriceDecimals(undefined, 2), null);
  assert.equal(hlPriceDecimals("", 2), null);
  assert.equal(hlPriceDecimals(NaN, 2), null);
});

test("rounding is half-up on the decimal value, not on binary float noise", () => {
  assert.equal(roundHlPrice(116.725, 2), 116.73);
  // 1.005 is 1.00499999... in binary; naive toFixed(2) says 1.00. The cap for
  // szDecimals 4 is 2 decimals, and half-up on the decimal value says 1.01.
  assert.equal(roundHlPrice(1.005, 4), 1.01);
  assert.equal(roundHlPrice(85572.5, 5), 85573);
  assert.equal(roundHlPrice("2733.55", 4), 2733.6);
  assert.equal(roundHlPrice(null, 4), null);
});

test("formatHlPrice: fixed decimals per magnitude, grouped, dollar-prefixed", () => {
  assert.equal(formatHlPrice(85572.5, 5), "$85,573");
  assert.equal(formatHlPrice("2733.55", 4), "$2,733.6");
  assert.equal(formatHlPrice(2733, 4), "$2,733.0");
  assert.equal(formatHlPrice(116.725, 2), "$116.73");
  assert.equal(formatHlPrice(0.006512, 0), "$0.006512");
  assert.equal(formatHlPrice(4.6444, 1), "$4.6444");
  assert.equal(formatHlPrice(4.6444, 1, { prefix: "" }), "4.6444");
});

test("formatHlPrice: unknown is the dash, a measured zero is a number", () => {
  for (const v of [null, undefined, "", NaN, "abc", Infinity]) assert.equal(formatHlPrice(v, 2), DASH, String(v));
  assert.equal(formatHlPrice(0, 2), "$0");
});

test("formatHlPrice: a positive price never rounds to a confident zero", () => {
  assert.equal(formatHlPrice(0.0000001, 0), "<$0.000001");
});

test("formatHlPrice signed: deltas carry their sign", () => {
  assert.equal(formatHlPrice(-0.153, 1, { signed: true }), "-$0.153");
  assert.equal(formatHlPrice(0.153, 1, { signed: true }), "+$0.153");
});

test("compact USD for open interest and volume uses the app's one compact rule", () => {
  assert.equal(formatHlUsdCompact(200_000_000), "$200M");
  assert.equal(formatHlUsdCompact(4_978_314_588.72), "$5B");
  assert.equal(formatHlUsdCompact(1_234_567), "$1.2M");
  assert.equal(formatHlUsdCompact(null), DASH);
  assert.equal(formatHlUsdCompact(0), "$0");
});

test("percent and funding", () => {
  assert.equal(formatHlPct(-3.19), "-3.19%");
  assert.equal(formatHlPct(null), DASH);
  assert.equal(formatHlFunding(0.0000125), "+0.0013%");
  assert.equal(formatHlFunding(-0.00005), "-0.0050%");
  assert.equal(formatHlFunding(null), DASH);
  assert.equal(hlFundingAprPct(0.0000125), 10.95);
  assert.equal(hlFundingAprPct(null), null);
});

test("sizes are shown at the market's szDecimals", () => {
  assert.equal(formatHlSize(1.23456, 2), "1.23");
  assert.equal(formatHlSize(4800, 0), "4,800");
  assert.equal(formatHlSize(null, 2), DASH);
});
