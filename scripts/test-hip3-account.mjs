/**
 * HIP-3 stock perps — the customer's dex pots, what they add to the Main Account
 * total, and the stock order guard (src/lib/hyperliquid/hip3/{pots,guard}.js).
 *
 * User fixtures are public traders' live answers (2026-10-15) with the address
 * redacted; one never-used address. No network.
 *
 * Run: node --test scripts/test-hip3-account.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3", `${name}.json`), "utf8")).response;

globalThis.fetch = () => { throw new Error("no network in tests"); };

const H = await import("../src/lib/hyperliquid/hip3/index.js");
const { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } = await import("../src/perp/guardrails.js");
const { balanceSourceFor } = await import("../src/lib/hyperliquid/account/parse.js");

const std = H.parseDexUserState(fx("user-std-xyz-clearinghouse"), { dex: "xyz" });
const stdMain = H.parseDexUserState(fx("user-std-main-clearinghouse"), { dex: "xyz" });
const uni = H.parseDexUserState(fx("user-uni-xyz-clearinghouse"), { dex: "xyz" });
const fresh = H.parseDexUserState(fx("user-fresh-xyz-clearinghouse"), { dex: "xyz" });

/* ── the pots ──────────────────────────────────────────────────────────────── */

test("the pot rule's mode map is account/parse.js's, mode for mode (kept apart for the main chunk)", () => {
  for (const m of ["unifiedAccount", "portfolioMargin", "disabled", "dexAbstraction", "default", "somethingNew", "", null, undefined, 7]) {
    assert.equal(H.potSourceFor(m), balanceSourceFor(m), String(m));
  }
  const src = fs.readFileSync(path.join(ROOT, "src/lib/hyperliquid/hip3/pots.js"), "utf8");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /from\s+"[^"]*account\//, "pots.js imports nothing from the account layer");
});

test("a standard account's xyz pot is separate from its main dex", () => {
  assert.equal(fx("user-std-mode"), "disabled");
  assert.equal(std.accountValue, 151858.800726);
  assert.equal(std.withdrawable, 137492.778267);
  assert.equal(std.positions.length, 8);
  assert.equal(stdMain.accountValue, 0, "the main dex holds nothing: the money is all on xyz");
  const t = std.positions.find((p) => p.coin === "xyz:TSLA");
  assert.equal(t.side, "long");
  assert.equal(t.leverageType, "cross");
  assert.equal(t.leverage, 5);
  assert.equal(t.liquidationPx, null, "no reachable liquidation price stays null, never 0");
  assert.equal(t.maxLeverage, 20);
  assert.ok(std.positions.some((p) => p.side === "short"));
});

test("a never-used address answers zeros, which are KNOWN zeros", () => {
  assert.equal(fx("user-fresh-mode"), "default");
  assert.equal(fresh.accountValue, 0);
  assert.equal(fresh.positions.length, 0);
  assert.equal(H.idleDexUsdc(fresh), 0);
  const aad = fx("user-fresh-active-asset-TSLA");
  assert.deepEqual(aad.leverage, { type: "cross", value: 20 }, "a new account starts xyz:TSLA at cross 20x: FlowFlow must set isolated first");
  assert.deepEqual(aad.availableToTrade, ["0.0", "0.0"]);
});

test("parseDexUserState refuses junk and another dex's positions", () => {
  assert.equal(H.parseDexUserState(null, { dex: "xyz" }), null);
  assert.equal(H.parseDexUserState({ assetPositions: [] }, { dex: "xyz" }), null, "no margin summary, no state");
  assert.equal(H.parseDexUserState(fx("user-std-xyz-clearinghouse"), {}), null, "a pot needs its dex name");
  const mixed = H.parseDexUserState(fx("user-std-xyz-clearinghouse"), { dex: "mkts" });
  assert.equal(mixed.positions.length, 0, "xyz positions in a mkts read are dropped");
});

test("hip3Equity: standard mode adds every pot; unified adds nothing (spot already backs it)", () => {
  assert.deepEqual(H.hip3Equity({ mode: "disabled", states: [{ dex: "xyz", state: std }] }), { addUsdc: 151858.800726, knownUsdc: 151858.800726, missing: [], reason: "pots" });
  assert.deepEqual(H.hip3Equity({ mode: "default", states: [{ dex: "xyz", state: fresh }] }).addUsdc, 0);
  assert.equal(H.hip3Equity({ mode: "dexAbstraction", states: [{ dex: "xyz", state: std }, { dex: "mkts", state: fresh }] }).addUsdc, 151858.800726);
  const u = H.hip3Equity({ mode: "unifiedAccount", states: [{ dex: "xyz", state: uni }] });
  assert.deepEqual(u, { addUsdc: 0, knownUsdc: 0, missing: [], reason: "spot-backs" });
  /* The fixture's own proof: the spot hold IS the xyz margin. */
  const usdc = fx("user-uni-spot").balances.find((b) => b.coin === "USDC");
  assert.equal(Number(usdc.hold), uni.marginUsed);
  assert.equal(uni.withdrawable, 0);
});

test("hip3Equity: a dex not yet answered, or a mode not known, is null — never a smaller total", () => {
  const r = H.hip3Equity({ mode: "disabled", states: [{ dex: "xyz", state: std }, { dex: "mkts", state: null }] });
  assert.equal(r.addUsdc, null);
  assert.equal(r.knownUsdc, 151858.800726);
  assert.deepEqual(r.missing, ["mkts"]);
  assert.equal(r.reason, "dex-unanswered");
  assert.equal(H.hip3Equity({ mode: null, states: [{ dex: "xyz", state: std }] }).addUsdc, null);
  assert.equal(H.hip3Equity({ mode: "somethingNew", states: [] }).reason, "mode-unknown");
  assert.deepEqual(H.hip3Equity({ mode: "disabled", states: [] }), { addUsdc: 0, knownUsdc: 0, missing: [], reason: "none" });
});

test("idleDexUsdc: only a pot with no position is idle", () => {
  assert.equal(H.idleDexUsdc(std), 0, "8 positions: that money is margin");
  assert.equal(H.idleDexUsdc({ positions: [], withdrawable: 12.5 }), 12.5);
  assert.equal(H.idleDexUsdc({ positions: [], withdrawable: null }), null);
  assert.equal(H.idleDexUsdc(null), null);
});

/* ── the guard ─────────────────────────────────────────────────────────────── */

const DEXS = H.parseDexes(fx("perp-dexs"));
const xyz = DEXS.byName.get("xyz");
const rows = H.parseStockRows(fx("xyz-meta-and-asset-ctxs"), { dex: "xyz", dexIndex: xyz.index, dexInfo: xyz, limits: fx("xyz-perp-dex-limits") }).byCoin;
const TSLA = rows.get("xyz:TSLA");
const OPEN = Date.parse("2026-10-15T15:00:00Z");     // Thu 11:00 ET, core session
const NIGHT = Date.parse("2026-10-15T07:37:00Z");    // Thu 03:37 ET
const SAT = Date.parse("2026-10-17T15:00:00Z");

test("the guard reads FlowFlow's own caps, it does not copy them", () => {
  assert.equal(MAX_MARGIN_USDC, 20);
  assert.equal(AGENT_MAX_LEVERAGE, 10);
  const src = fs.readFileSync(path.join(ROOT, "src/lib/hyperliquid/hip3/guard.js"), "utf8");
  assert.match(src, /from "\.\.\/\.\.\/\.\.\/perp\/guardrails\.js"/);
});

test("a normal Agent card in the core session passes, isolated", () => {
  const r = H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 20, leverage: 10, by: "agent", now: OPEN });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.marginMode, "isolated");
  assert.equal(r.maxLeverage, 10);
  assert.equal(r.notionalUsd, 200);
  assert.deepEqual(r.warnings, [], "the core session, a liquid stock: nothing to warn about");
});

test("caps: 20 USDC margin, the lower of the Agent's 10x and the market's own", () => {
  assert.deepEqual(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 21, leverage: 5, by: "agent", now: OPEN }).refusals, ["margin_cap"]);
  assert.deepEqual(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 10, leverage: 11, by: "agent", now: OPEN }).refusals, ["leverage_cap"]);
  /* The form may go to the market's own 20x; the Agent may not. */
  assert.equal(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 10, leverage: 20, by: "form", now: OPEN }).ok, true);
  assert.deepEqual(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 10, leverage: 21, by: "form", now: OPEN }).refusals, ["leverage_cap"]);
  const amd = rows.get("xyz:AMD");
  assert.equal(H.checkStockOrder({ row: amd, side: "short", marginUsdc: 10, leverage: 10, by: "form", now: OPEN }).maxLeverage, 10);
  assert.deepEqual(H.checkStockOrder({ row: { ...TSLA, maxLeverage: null }, side: "long", marginUsdc: 10, leverage: 2, now: OPEN }).refusals, ["leverage_unknown"]);
  assert.deepEqual(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 4, leverage: 2, now: OPEN }).refusals, ["min_value"]);
});

test("closed US market: the Agent drops to 5x; overnight says thin, the weekend says the price can jump", () => {
  const night = H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 20, leverage: 5, by: "agent", now: NIGHT });
  assert.equal(night.ok, true);
  assert.equal(night.maxLeverage, H.CLOSED_AGENT_MAX_LEVERAGE);
  assert.equal(night.priceSource, "external", "overnight: Blue Ocean ATS still prices it");
  assert.deepEqual(night.warnings, ["extended_hours"]);
  const sat = H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 20, leverage: 5, by: "agent", now: SAT });
  assert.equal(sat.priceSource, "internal");
  assert.ok(sat.warnings.includes("us_market_closed"));
  /* An index on its futures session break is on the model even on a weekday. */
  const sp = H.checkStockOrder({ row: { ...rows.get("xyz:SP500"), kind: "index" }, side: "long", marginUsdc: 10, leverage: 2, now: Date.parse("2026-10-15T21:30:00Z") });
  assert.ok(sp.warnings.includes("us_market_closed"));
  assert.deepEqual(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 20, leverage: 6, by: "agent", now: SAT }).refusals, ["leverage_cap"]);
  const form = H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 20, leverage: 10, by: "form", now: SAT });
  assert.equal(form.ok, true, "the form keeps the user's choice");
  assert.ok(form.warnings.includes("us_market_closed"));
  assert.ok(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 20, leverage: 2, now: Date.parse("2026-10-15T12:00:00Z") }).warnings.includes("extended_hours"));
});

test("held, unlisted, capped and unknown markets take no new position", () => {
  assert.deepEqual(H.checkStockOrder({ row: rows.get("xyz:NFLX"), side: "long", marginUsdc: 10, leverage: 2, now: OPEN }).refusals, ["held"]);
  assert.deepEqual(H.checkStockOrder({ row: rows.get("xyz:GOLD"), side: "long", marginUsdc: 10, leverage: 2, now: OPEN }).refusals, ["not_listed"]);
  assert.deepEqual(H.checkStockOrder({ row: TSLA, side: "long", marginUsdc: 10, leverage: 2, now: OPEN, atCap: new Set(["xyz:TSLA"]) }).refusals, ["at_cap"]);
  assert.deepEqual(H.checkStockOrder({ row: null, side: "long", marginUsdc: 10, leverage: 2 }).refusals, ["market_unknown"]);
  assert.deepEqual(H.checkStockOrder({ row: TSLA, side: "up", marginUsdc: 10, leverage: 2.5, now: OPEN }).refusals, ["bad_side", "bad_leverage"]);
});

test("warnings: price away from the oracle, strict isolated margin, an unreadable fee", () => {
  assert.ok(H.checkStockOrder({ row: { ...TSLA, takerFeeMultiplier: null }, side: "long", marginUsdc: 10, leverage: 2, now: OPEN }).warnings.includes("fee_unknown"));
  const off = H.checkStockOrder({ row: { ...TSLA, markOracleGapBps: -80 }, side: "long", marginUsdc: 10, leverage: 2, now: OPEN });
  assert.ok(off.warnings.includes("price_off_oracle"));
  const strict = H.checkStockOrder({ row: { ...TSLA, canRemoveMargin: false }, side: "long", marginUsdc: 10, leverage: 2, now: OPEN });
  assert.ok(strict.warnings.includes("margin_locked"));
});

test("every code the guard can answer has its words", () => {
  const codes = ["market_unknown", "not_listed", "held", "at_cap", "bad_side", "bad_margin", "margin_cap", "bad_leverage",
    "leverage_unknown", "leverage_cap", "min_value", "us_market_closed", "extended_hours", "calendar_old", "price_off_oracle",
    "fee_unknown", "margin_locked"];
  for (const c of codes) assert.ok(H.STOCK_GUARD_TEXT[c], c);
  for (const t of Object.values(H.STOCK_GUARD_TEXT)) assert.doesNotMatch(t, /\bxyz\b|HIP-3|dex|venue|Hyperliquid/i, "no dex or venue names reach a customer");
});

test("the guard on the APP'S OWN market rows (markets.js): the caller's listed verdict and the whitelist's kind", async () => {
  const { parsePerpMarkets } = await import("../src/lib/hyperliquid/markets.js");
  const store = parsePerpMarkets(fx("xyz-meta-and-asset-ctxs"), { now: 1, dex: "xyz", dexIndex: 1, venueName: "XYZ", venueCategory: "stock" }).byCoin;
  const t = store["xyz:TSLA"];
  assert.equal(t.impactSpreadBps, undefined, "the shared row has no spread figure");
  assert.deepEqual(H.checkStockOrder({ row: t, side: "long", marginUsdc: 10, leverage: 2, now: OPEN }).refusals, ["held"], "without a verdict, unknown never passes");
  const ok = H.checkStockOrder({ row: t, side: "long", marginUsdc: 10, leverage: 3, by: "agent", now: OPEN, listed: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(H.checkStockOrder({ row: store["xyz:NFLX"], side: "long", marginUsdc: 10, leverage: 2, now: OPEN, listed: false }).refusals, ["held"]);
  /* SP500 on the store row has no kind: the whitelist says index, so the futures-break hour is the model's price. */
  const sp = H.checkStockOrder({ row: store["xyz:SP500"], side: "long", marginUsdc: 10, leverage: 2, now: Date.parse("2026-10-15T21:30:00Z"), listed: true });
  assert.ok(sp.warnings.includes("us_market_closed"));
});
