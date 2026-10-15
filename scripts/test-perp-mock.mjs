/**
 * test-perp-mock — THE MOCK PERP TRADING ENGINE (src/perp/mock/).
 * ════════════════════════════════════════════════════════════════════════════
 * Owner: "เราทำขึ้นมาก่อน เป็น Mock เดะ Builder Fee อาจจะยังไม่ตั้ง" — build it
 * first as a MOCK; the builder fee may not be set yet.
 *
 * The engine models Hyperliquid ISOLATED perps (FOMO puts every position on
 * isolated margin) on live marks, with MOCK money: 1000 USD that is not money.
 * What this suite pins, every figure worked by hand in the comments:
 *
 *   A. fees: HL taker 0.045% (main dex, tier 0) + the builder fee read ONCE
 *      from VITE_PERP_BUILDER_FEE in tenths of a basis point (empty = 0);
 *   B. open: size = margin x leverage / entry rounded to szDecimals, the $10
 *      venue minimum on the ROUNDED order, the leverage cap, the margin tier,
 *      and the liquidation price from slice 1's estimate — so the ticket
 *      preview and the open position print the same number (MONEY_RULES 1);
 *   C. add ("Long more" / "Short more"): same side only, size-weighted entry;
 *   D. close: fractions, the fee on the closed notional, 100% removes;
 *   E. TP / SL validation against the mark and the liquidation price;
 *   F. onMark: TP / SL on the MARK, filled at the trigger; liquidation loses
 *      the whole margin and says "Liquidated";
 *   G. the derived position card and the account (unknown = null, never 0);
 *   H. persistence: the key, private mode, a corrupt or foreign blob;
 *   I. two tabs: the storage event, and no lost update;
 *   J. the mark feeder: only coins with open positions, through the one store;
 *   K. usePerpMock and the config module, bundled by esbuild;
 *   L. source guards (comments stripped).
 *
 * Run: node --test scripts/test-perp-mock.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "./lib/stripComments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(P(rel), "utf8");
const code = (rel) => stripComments(read(rel));

const MOCK_DIR = "src/perp/mock";
const FILES = {
  fees: `${MOCK_DIR}/fees.js`,
  config: `${MOCK_DIR}/config.js`,
  math: `${MOCK_DIR}/perpMockMath.js`,
  engine: `${MOCK_DIR}/perpMockEngine.js`,
  feeder: `${MOCK_DIR}/perpMockFeeder.js`,
  hook: `${MOCK_DIR}/usePerpMock.js`,
};

let F, M, E, FD, T, MK;
before(async () => {
  const imp = (rel) => import(pathToFileURL(P(rel)).href);
  F = await imp(FILES.fees);
  M = await imp(FILES.math);
  E = await imp(FILES.engine);
  FD = await imp(FILES.feeder);
  T = await imp("src/perp/perpTicket.js");
  MK = await imp("src/lib/hyperliquid/markets.js");
});

/* ── helpers ────────────────────────────────────────────────────────────────── */
const near = (a, b, eps = 1e-9, msg = "") => {
  assert.equal(typeof a, "number", `${msg} expected a number, got ${a}`);
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg} ${a} is not ${b}`);
};

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  const s = {
    writes: 0,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { s.writes++; m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    raw: (k) => (m.has(k) ? m.get(k) : null),
  };
  return s;
}

/* Two tabs over one storage area. A write from one tab is queued as a storage
   event for the OTHER tab only (as browsers do) and delivered by deliver(). */
function twoTabs() {
  const area = new Map();
  const queue = [];
  const tabs = [0, 1].map((me) => {
    const listeners = new Set();
    return {
      listeners,
      storage: {
        getItem: (k) => (area.has(k) ? area.get(k) : null),
        setItem: (k, v) => {
          const oldValue = area.has(k) ? area.get(k) : null;
          area.set(k, String(v));
          queue.push({ to: 1 - me, e: { key: k, oldValue, newValue: String(v) } });
        },
        removeItem: (k) => { area.delete(k); },
      },
      listen: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  });
  return {
    tabs,
    area,
    deliver() {
      while (queue.length) {
        const { to, e } = queue.shift();
        for (const fn of [...tabs[to].listeners]) fn(e);
      }
    },
    drop() { queue.length = 0; },
  };
}

let clockT = 1_760_000_000_000;
const clock = () => () => (clockT += 1000);

/* Market rows, shaped like lib/hyperliquid/markets.js rows. */
const BTC = Object.freeze({ coin: "BTC", szDecimals: 5, maxLeverage: 40, marginTiers: [{ lowerBound: 0, maxLeverage: 40 }, { lowerBound: 150e6, maxLeverage: 20 }] });
const ETH = Object.freeze({ coin: "ETH", szDecimals: 4, maxLeverage: 25, marginTiers: [{ lowerBound: 0, maxLeverage: 25 }, { lowerBound: 100e6, maxLeverage: 15 }] });
const HYPE = Object.freeze({ coin: "HYPE", szDecimals: 2, maxLeverage: 10, marginTiers: [{ lowerBound: 0, maxLeverage: 10 }, { lowerBound: 20e6, maxLeverage: 5 }] });
const TRI = Object.freeze({ coin: "TRI", szDecimals: 0, maxLeverage: 3, marginTiers: [{ lowerBound: 0, maxLeverage: 3 }] });
/* A table whose SECOND tier starts at $3,000 — a size a mock account can reach. */
const LOWTIER = Object.freeze({ coin: "LOW", szDecimals: 2, maxLeverage: 10, marginTiers: [{ lowerBound: 0, maxLeverage: 10 }, { lowerBound: 3000, maxLeverage: 5 }] });

const TAKER_ONLY = 0.00045;          // builder fee unset
const WITH_BUILDER_50 = 0.00095;     // 0.045% + 0.05% (f = 50)

function engine(o = {}) {
  return E.createPerpMockEngine({ storage: memStorage(), now: clock(), feeRate: TAKER_ONLY, ...o });
}

/* ════════════════════════════════════════════════════════════════════════════
   A. FEES
   ════════════════════════════════════════════════════════════════════════════ */

test("A1) the builder fee is read in tenths of a basis point; empty is 0, anything unreadable is unknown (null)", () => {
  for (const raw of [undefined, null, "", "   "]) assert.equal(F.parseBuilderFeeTenthsBp(raw), 0, `${JSON.stringify(raw)} is unset`);
  assert.equal(F.parseBuilderFeeTenthsBp("0"), 0);
  assert.equal(F.parseBuilderFeeTenthsBp("10"), 10);
  assert.equal(F.parseBuilderFeeTenthsBp(" 50 "), 50);
  assert.equal(F.parseBuilderFeeTenthsBp("100"), 100, "0.1% is Hyperliquid's perp cap and still allowed");
  assert.equal(F.parseBuilderFeeTenthsBp(50), 50);
  for (const bad of ["101", "-1", "abc", "5.5", "0x10", "1e2", "50bp", NaN, 5.5, {}]) {
    assert.equal(F.parseBuilderFeeTenthsBp(bad), null, `${String(bad)} must not become a fee`);
  }
  assert.equal(F.HL_BUILDER_FEE_MAX_TENTHS_BP, 100);
});

test("A2) taker rate = 0.045% + f / 100,000; worked: f=0 -> 0.045%, f=10 -> 0.055%, f=50 -> 0.095%, f=100 -> 0.145%", () => {
  assert.equal(F.HL_TAKER_FEE_RATE, 0.00045);
  near(F.perpTakerFeeRate(0), 0.00045);
  near(F.perpTakerFeeRate(10), 0.00055);   // 10 tenths of a bp = 1 bp = 0.01%
  near(F.perpTakerFeeRate(50), 0.00095);   // FOMO's 0.05% on top of HL's 0.045%
  near(F.perpTakerFeeRate(100), 0.00145);
  assert.equal(F.perpTakerFeeRate(null), null, "an unreadable setting is unknown, never 0");
  assert.equal(F.builderFeeRate(null), null);
  near(F.builderFeeRate(50), 0.0005);
});

test("A3) the fee on $1,000 of notional: $0.45 unset, $0.55 at f=10, $0.95 at f=50; unknown in, null out", () => {
  near(F.perpFeeUsd(1000, F.perpTakerFeeRate(0)), 0.45);
  near(F.perpFeeUsd(1000, F.perpTakerFeeRate(10)), 0.55);
  near(F.perpFeeUsd(1000, F.perpTakerFeeRate(50)), 0.95);
  assert.equal(F.perpFeeUsd(1000, null), null);
  assert.equal(F.perpFeeUsd(null, 0.00045), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   B. OPEN
   ════════════════════════════════════════════════════════════════════════════ */

test("B1) LONG, worked: $100 at 10x on BTC at 100,000 -> 0.01 BTC, $1,000 notional, fee $0.45, $899.55 left, liq 91,139.24", () => {
  const e = engine();
  assert.equal(e.getSnapshot().availableUsd, 1000, "a new mock account starts at 1000 USD");
  assert.equal(e.getSnapshot().mock, true);
  const r = e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  assert.equal(r.ok, true, r.message);
  /* notional = 100 x 10 = 1,000; size = 1,000 / 100,000 = 0.01 (5 decimals: exact)
     margin = 0.01 x 100,000 / 10 = 100; fee = 1,000 x 0.00045 = 0.45
     available = 1,000 - 100 - 0.45 = 899.55
     mmr = 1 / (2 x 40) = 0.0125; liq = 100,000 x (1 - 1/10) / (1 - 0.0125)
         = 90,000 / 0.9875 = 91,139.2405... */
  const p = e.getSnapshot().positions.BTC;
  assert.equal(p.side, "long");
  assert.equal(p.size, 0.01);
  assert.equal(p.entryPx, 100_000);
  near(p.marginUsd, 100);
  assert.equal(p.leverage, 10);
  near(p.liqPx, 91139.24050632911);
  near(r.event.feeUsd, 0.45);
  near(r.event.notionalUsd, 1000);
  near(e.getSnapshot().availableUsd, 899.55);
  assert.equal(r.event.type, "open");
  assert.equal(e.getSnapshot().history.at(-1).type, "open");
});

test("B2) SHORT with a builder fee, worked: $200 at 5x on ETH at 2,500 (f=50) -> 0.4 ETH, fee $0.95, $799.05 left, liq 2,941.18", () => {
  const e = engine({ feeRate: WITH_BUILDER_50 });
  const r = e.open("ETH", "short", 200, 5, 2500, {}, ETH);
  assert.equal(r.ok, true, r.message);
  /* notional = 1,000; size = 1,000 / 2,500 = 0.4; margin = 200
     fee = 1,000 x (0.00045 + 0.0005) = 0.95; available = 1,000 - 200.95 = 799.05
     mmr = 1 / 50 = 0.02; liq = 2,500 x (1 + 1/5) / (1 + 0.02) = 3,000 / 1.02 = 2,941.176... */
  const p = e.getSnapshot().positions.ETH;
  assert.equal(p.side, "short");
  assert.equal(p.size, 0.4);
  near(r.event.feeUsd, 0.95);
  near(e.getSnapshot().availableUsd, 799.05);
  near(p.liqPx, 2941.176470588235);
});

test("B3) the $10 minimum is checked on the ROUNDED order", () => {
  const e = engine();
  /* $5 at 1x = $5 of notional: under Hyperliquid's $10. */
  assert.equal(e.open("BTC", "long", 5, 1, 100_000, {}, BTC).error, "belowMin");
  /* A $3 coin with whole-coin steps: $10 at 1x = 3.33 coins, rounds to 3 = $9. */
  const tri = e.quoteOpen("TRI", "long", 10, 1, 3, {}, TRI);
  assert.equal(tri.ok, false);
  assert.equal(tri.error, "belowMin", "the typed $10 becomes a $9 order, which the venue refuses");
  /* kPEPE-like, 0 decimals at 0.005281: 10 / 0.005281 = 1,893.58 -> 1,894 coins
     = 1,894 x 0.005281 = $10.002214 of notional, so margin 10.002214 at 1x. */
  const k = e.open("kPEPE", "long", 10, 1, 0.005281, {}, { szDecimals: 0, maxLeverage: 10, marginTiers: [{ lowerBound: 0, maxLeverage: 10 }] });
  assert.equal(k.ok, true, k.message);
  assert.equal(e.getSnapshot().positions.kPEPE.size, 1894);
  near(e.getSnapshot().positions.kPEPE.marginUsd, 10.002214);
  assert.equal(M.PERP_MOCK_ERROR_TEXT.belowMin.includes("$10"), true);
});

test("B4) leverage: a whole number from 1 to the market's max; one position per coin", () => {
  const e = engine();
  assert.equal(e.open("BTC", "long", 100, 41, 100_000, {}, BTC).error, "leverageAboveMax", "BTC's max is 40x");
  assert.equal(e.open("BTC", "long", 100, 0, 100_000, {}, BTC).error, "badLeverage");
  assert.equal(e.open("BTC", "long", 100, 2.5, 100_000, {}, BTC).error, "badLeverage");
  assert.equal(e.open("BTC", "sideways", 100, 2, 100_000, {}, BTC).error, "badSide");
  assert.equal(e.open("BTC", "long", -1, 2, 100_000, {}, BTC).error, "badAmount");
  assert.equal(e.open("BTC", "long", 100, 2, null, {}, BTC).error, "priceUnknown");
  assert.equal(e.open("BTC", "long", 100, 2, 100_000, {}, null).error, "marketUnknown");
  assert.equal(e.open("BTC", "long", 100, 40, 100_000, {}, BTC).ok, true, "exactly the max is allowed");
  assert.equal(e.open("BTC", "long", 100, 2, 100_000, {}, BTC).error, "positionOpen", "one position per coin, like Hyperliquid");
  assert.equal(e.open("BTC", "short", 100, 2, 100_000, {}, BTC).error, "positionOpen");
  /* Nothing a rejected call did touched the money — or the saved blob. */
  near(e.getSnapshot().availableUsd, 1000 - 100 - 4000 * 0.00045);
  const storage = memStorage();
  const q = engine({ storage });
  q.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  const writes = storage.writes;
  const rev = q.getSnapshot().rev;
  q.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  q.add("BTC", "short", 100, 100_000);
  q.close("BTC", 0, 100_000);
  q.setTpSl("BTC", { tp: 1 }, 100_000);
  assert.equal(storage.writes, writes, "a refusal writes nothing");
  assert.equal(q.getSnapshot().rev, rev);
});

test("B5) past the first margin tier there is no liquidation estimate, so the mock refuses — and the ticket preview agrees", () => {
  const e = engine();
  /* $400 at 10x = $4,000 of notional, past LOWTIER's $3,000 second tier. */
  const r = e.quoteOpen("LOW", "long", 400, 10, 20, {}, LOWTIER);
  assert.equal(r.error, "pastTier");
  const pv = T.perpTicketPreview({ side: "buy", amountUsd: 400, leverage: 10, market: { ...LOWTIER, px: 20 } });
  assert.equal(pv.liqPx, null);
  assert.ok(pv.pastTier, "the ticket shows the dash for the same order");
  /* $200 at 10x = $2,000: inside the first tier, both give the same liquidation. */
  const ok = e.open("LOW", "long", 200, 10, 20, {}, LOWTIER);
  assert.equal(ok.ok, true, ok.message);
  const pv2 = T.perpTicketPreview({ side: "buy", amountUsd: 200, leverage: 10, market: { ...LOWTIER, px: 20 } });
  assert.equal(e.getSnapshot().positions.LOW.liqPx, pv2.liqPx);
  /* An unknown table is not assumed to be one tier. */
  assert.equal(e.quoteOpen("X", "long", 100, 2, 10, {}, { szDecimals: 1, maxLeverage: 5, marginTiers: null }).error, "tiersUnknown");
});

test("B6) the cost (margin + fee) must fit the mock balance; the max helper returns an amount that fits exactly", () => {
  const e = engine();
  /* $1,000 at 10x: margin 1,000 + fee 10,000 x 0.00045 = 4.50 -> 1,004.50 > 1,000. */
  assert.equal(e.quoteOpen("BTC", "long", 1000, 10, 100_000, {}, BTC).error, "insufficientFunds");
  const max = M.maxPerpMockMarginUsd({ availableUsd: 1000, leverage: 10, feeRate: TAKER_ONLY, markPx: 100_000, szDecimals: 5 });
  /* Budget per coin = 100,000 x (1/10 + 0.00045) = 10,045; 1,000 / 10,045 =
     0.0995520... coins, floored to the 5-decimal step = 0.09955 BTC;
     margin = 0.09955 x 100,000 / 10 = 995.50; fee = 9,955 x 0.00045 = 4.47975;
     cost = 999.97975 <= 1,000. */
  near(max, 995.5);
  const r = e.open("BTC", "long", max, 10, 100_000, {}, BTC);
  assert.equal(r.ok, true, r.message);
  near(e.getSnapshot().availableUsd, 1000 - 995.5 - 4.47975);
  assert.ok(e.getSnapshot().availableUsd >= 0);
});

test("B7) MONEY_RULES 1: the ticket preview's liquidation price IS the open position's, to the last bit", () => {
  const fixture = JSON.parse(read("scripts/fixtures/hl-meta-and-asset-ctxs.json")).response;
  const { byCoin } = MK.parsePerpMarkets(fixture, { now: 1 });
  for (const [coin, amount, lev, side] of [["BTC", 100, 10, "long"], ["ETH", 100, 5, "short"], ["HYPE", 37.5, 3, "long"], ["kPEPE", 25, 7, "short"]]) {
    const row = byCoin[coin];
    assert.ok(row && row.markPx > 0, `${coin} is in the saved market table`);
    const e = engine();
    const r = e.open(coin, side, amount, lev, row.markPx, {}, row);
    assert.equal(r.ok, true, `${coin}: ${r.message}`);
    const pv = T.perpTicketPreview({ side: side === "long" ? "buy" : "sell", amountUsd: amount, leverage: lev, market: { ...row, px: row.markPx } });
    assert.equal(e.getSnapshot().positions[coin].liqPx, pv.liqPx, `${coin}: preview and position disagree`);
    assert.equal(r.liqPx, pv.liqPx);
  }
  /* ETH at 2,741.4, $100 at 5x: 500 / 2,741.4 = 0.182388... -> 0.1824 ETH (4 decimals),
     so the margin is 0.1824 x 2,741.4 / 5 = 100.006272, not the typed 100 — the
     leverage stays exactly 5x, which is why the liquidation price cannot drift. */
  const e = engine();
  e.open("ETH", "long", 100, 5, 2741.4, {}, ETH);
  near(e.getSnapshot().positions.ETH.marginUsd, 100.006272);
  assert.equal(e.getSnapshot().positions.ETH.size, 0.1824);
});

/* ════════════════════════════════════════════════════════════════════════════
   C. ADD ("Long more" / "Short more")
   ════════════════════════════════════════════════════════════════════════════ */

test("C1) ADD, worked: +$100 at 10x on BTC at 110,000 onto 0.01 @ 100,000 -> 0.01909 BTC @ 104,761.66, margin 199.99, liq 95,478.98", () => {
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  const r = e.add("BTC", "long", 100, 110_000);
  assert.equal(r.ok, true, r.message);
  /* size2 = 1,000 / 110,000 = 0.0090909 -> 0.00909 (5 decimals)
     notional2 = 0.00909 x 110,000 = 999.90; margin2 = 99.99; fee2 = 999.9 x 0.00045 = 0.449955
     size = 0.01 + 0.00909 = 0.01909
     entry = (0.01 x 100,000 + 0.00909 x 110,000) / 0.01909 = 1,999.9 / 0.01909 = 104,761.655...
     margin = 100 + 99.99 = 199.99  (= 0.01909 x 104,761.655 / 10: still exactly 10x)
     liq = 104,761.655 x 0.9 / 0.9875 = 95,478.977
     available = 899.55 - 99.99 - 0.449955 = 799.110045 */
  const p = e.getSnapshot().positions.BTC;
  assert.equal(p.size, 0.01909);
  near(p.entryPx, 104761.65531691985);
  near(p.marginUsd, 199.99);
  near(p.liqPx, 95478.9769976991);
  near(e.getSnapshot().availableUsd, 799.110045);
  near(r.event.feeUsd, 0.449955);
  assert.equal(r.event.type, "add");
  /* The preview for the averaged position is the same function, same inputs. */
  assert.equal(p.liqPx, T.estIsolatedLiqPx({ side: "buy", entryPx: p.entryPx, leverage: 10, maxLeverage: 40 }));
});

test("C2) the opposite side is not a flip here (the UI routes it to Close); add needs an open position and keeps its leverage", () => {
  const e = engine();
  assert.equal(e.add("BTC", "long", 100, 100_000).error, "noPosition");
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  assert.equal(e.add("BTC", "short", 100, 100_000).error, "oppositeSide");
  assert.equal(e.add("BTC", "long", 100, 100_000, { leverage: 20 }).error, "leverageMismatch");
  assert.equal(e.add("BTC", "long", 100, 100_000, { leverage: 10 }).ok, true);
  assert.equal(e.add("BTC", "long", 0.5, 100_000).error, "belowMin", "$0.50 x 10 = $5 of notional");
});

test("C4) an add that would carry the position past the first margin tier is refused, like an open", () => {
  const e = engine();
  /* LOWTIER: second tier from $3,000. $200 at 10x at 20 = $2,000 (100 LOW);
     +$150 at 10x = +$1,500 -> $3,500 in total, past the tier. */
  assert.equal(e.open("LOW", "long", 200, 10, 20, {}, LOWTIER).ok, true);
  assert.equal(e.quoteAdd("LOW", "long", 150, 20).error, "pastTier");
  assert.equal(e.add("LOW", "long", 150, 20).error, "pastTier");
  assert.equal(e.add("LOW", "long", 50, 20).ok, true, "$2,500 in total stays inside it");
});

test("C3) an add that pulls the liquidation price past the stop loss flags it, and the liquidation then fires first", () => {
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, { sl: 92_000 }, BTC);
  assert.equal(e.getSnapshot().list[0].slPastLiq, false, "92,000 sits above the 91,139 liquidation");
  e.add("BTC", "long", 100, 110_000);
  const card = e.getSnapshot().list[0];
  assert.equal(card.slPastLiq, true, "the new liquidation (95,479) is above the 92,000 stop");
  /* Falling from 110,000 the mark meets 95,479 before 92,000. */
  const ev = e.onMark("BTC", 95_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "liquidated");
});

/* ════════════════════════════════════════════════════════════════════════════
   D. CLOSE
   ════════════════════════════════════════════════════════════════════════════ */

test("D1) CLOSE, worked: 50% at 105,000 then the rest at 95,000 -> +25 then -25, fees 0.23625 + 0.21375, ends at 999.10", () => {
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  const q = e.quoteClose("BTC", 0.5, 105_000);
  /* closed = 0.01 x 0.5 = 0.005 BTC; pnl = 0.005 x (105,000 - 100,000) = +25
     fee = 0.005 x 105,000 x 0.00045 = 0.23625; margin back = 50
     available = 899.55 + 50 + 25 - 0.23625 = 974.31375 */
  assert.equal(q.ok, true);
  near(q.pnlUsd, 25);
  near(q.feeUsd, 0.23625);
  near(q.receiveUsd, 50 + 25 - 0.23625);
  const r = e.close("BTC", 0.5, 105_000);
  assert.equal(r.ok, true, r.message);
  near(r.event.pnlUsd, q.pnlUsd, 1e-12, "the close sheet's estimate is the booked figure");
  near(e.getSnapshot().availableUsd, 974.31375);
  const p = e.getSnapshot().positions.BTC;
  assert.equal(p.size, 0.005);
  near(p.marginUsd, 50);
  near(p.liqPx, 91139.24050632911, 1e-9, "a partial close does not move an isolated liquidation price");
  /* rest: pnl = 0.005 x (95,000 - 100,000) = -25; fee = 475 x 0.00045 = 0.21375
     available = 974.31375 + 50 - 25 - 0.21375 = 999.10  (= 1,000 - total fees 0.90) */
  const r2 = e.close("BTC", 1, 95_000);
  assert.equal(r2.ok, true, r2.message);
  near(r2.event.pnlUsd, -25);
  near(r2.event.feeUsd, 0.21375);
  assert.equal(e.getSnapshot().positions.BTC, undefined, "closing 100% removes the position");
  near(e.getSnapshot().availableUsd, 999.1);
  assert.deepEqual(e.getSnapshot().history.map((h) => h.type), ["reset", "open", "close", "close"]);
});

test("D3) a 75% close, worked: 0.0075 of 0.01 BTC at 104,000 -> +30, fee 0.351, margin back 75, 1,004.199", () => {
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  /* closed = 0.01 x 0.75 = 0.0075 BTC; notional = 0.0075 x 104,000 = 780
     pnl = 0.0075 x 4,000 = +30; fee = 780 x 0.00045 = 0.351; margin back = 100 x 0.75 = 75
     available = 899.55 + 75 + 30 - 0.351 = 1,004.199; left: 0.0025 BTC on 25 of margin */
  const r = e.close("BTC", 0.75, 104_000);
  assert.equal(r.ok, true, r.message);
  near(r.event.marginUsd, 75);
  near(r.event.pnlUsd, 30);
  near(r.event.feeUsd, 0.351);
  near(e.getSnapshot().availableUsd, 1004.199);
  assert.equal(e.getSnapshot().positions.BTC.size, 0.0025);
  near(e.getSnapshot().positions.BTC.marginUsd, 25);
  assert.equal(r.event.remainingSize, 0.0025);
});

test("D2) close guards: the fraction, a partial under $10, a mark already through the liquidation price", () => {
  const e = engine();
  assert.equal(e.close("BTC", 1, 100_000).error, "noPosition");
  /* $15 at 1x at 40: 15 / 40 = 0.375 -> 0.38 HYPE (2 decimals) = $15.20 of notional.
     25% of 0.38 = 0.095 -> 0.10 HYPE = $4 of notional: under the $10 minimum. */
  e.open("HYPE", "long", 15, 1, 40, {}, HYPE);
  assert.equal(e.close("HYPE", 0, 40).error, "badFraction");
  assert.equal(e.close("HYPE", 1.5, 40).error, "badFraction");
  assert.equal(e.close("HYPE", 0.25, 40).error, "belowMin", "25% of $15 is under the venue's $10");
  assert.equal(e.close("HYPE", 1, 40).ok, true, "a full close is always allowed");

  const s = engine();
  s.open("ETH", "long", 100, 20, 2000, {}, ETH);
  /* liq = 2,000 x 0.95 / 0.98 = 1,938.78. A close at 1,900 is too late: the
     position was liquidated, and the close says so instead of booking a fill. */
  const r = s.close("ETH", 1, 1900);
  assert.equal(r.ok, false);
  assert.equal(r.error, "triggered");
  assert.equal(r.events[0].type, "liquidated");
  assert.equal(s.getSnapshot().positions.ETH, undefined);
});

/* ════════════════════════════════════════════════════════════════════════════
   E. TP / SL VALIDATION
   ════════════════════════════════════════════════════════════════════════════ */

test("E1) LONG: TP above the mark, SL below the mark AND above the liquidation price; null clears, absent keeps", () => {
  const e = engine();
  /* ETH long $100 at 20x at 2,000: liq = 1,938.78 */
  assert.equal(e.quoteOpen("ETH", "long", 100, 20, 2000, { tp: 1999 }, ETH).error, "tpWrongSide");
  assert.equal(e.quoteOpen("ETH", "long", 100, 20, 2000, { sl: 2000 }, ETH).error, "slWrongSide");
  assert.equal(e.quoteOpen("ETH", "long", 100, 20, 2000, { sl: 1930 }, ETH).error, "slPastLiq", "a stop beyond liquidation never fires");
  assert.equal(e.quoteOpen("ETH", "long", 100, 20, 2000, { tp: -5 }, ETH).error, "badTp");
  const r = e.open("ETH", "long", 100, 20, 2000, { tp: 2200, sl: 1950 }, ETH);
  assert.equal(r.ok, true, r.message);
  assert.equal(e.getSnapshot().positions.ETH.tp, 2200);
  assert.equal(e.getSnapshot().positions.ETH.sl, 1950);
  e.onMark("ETH", 2100);
  assert.equal(e.setTpSl("ETH", { tp: 2050 }).error, "tpWrongSide", "validated against the CURRENT mark (2,100), not the entry");
  assert.equal(e.setTpSl("ETH", { sl: 2150 }).error, "slWrongSide");
  assert.equal(e.setTpSl("ETH", { tp: 2300 }).ok, true);
  assert.equal(e.getSnapshot().positions.ETH.sl, 1950, "an absent key keeps its level");
  assert.equal(e.setTpSl("ETH", { sl: null }).ok, true);
  assert.equal(e.getSnapshot().positions.ETH.sl, null, "null clears");
  assert.equal(e.getSnapshot().positions.ETH.tp, 2300);
  assert.equal(e.getSnapshot().history.at(-1).type, "tpsl");
  assert.equal(e.setTpSl("BTC", { tp: 1 }).error, "noPosition");
});

test("E2) SHORT mirrored: TP below the mark, SL above the mark AND below the liquidation price", () => {
  const e = engine();
  /* HYPE short $50 at 10x at 40: liq = 40 x 1.1 / 1.05 = 41.90 */
  assert.equal(e.quoteOpen("HYPE", "short", 50, 10, 40, { tp: 41 }, HYPE).error, "tpWrongSide");
  assert.equal(e.quoteOpen("HYPE", "short", 50, 10, 40, { sl: 39 }, HYPE).error, "slWrongSide");
  assert.equal(e.quoteOpen("HYPE", "short", 50, 10, 40, { sl: 42 }, HYPE).error, "slPastLiq");
  assert.equal(e.open("HYPE", "short", 50, 10, 40, { tp: 36, sl: 41.5 }, HYPE).ok, true);
  /* No mark has arrived since the open: setTpSl needs one to validate against. */
  assert.equal(e.setTpSl("HYPE", { tp: 35 }).error, "priceUnknown");
  assert.equal(e.setTpSl("HYPE", { tp: 35 }, 39.5).ok, true, "an explicit mark works");
});

/* ════════════════════════════════════════════════════════════════════════════
   F. onMark — triggers on the MARK
   ════════════════════════════════════════════════════════════════════════════ */

test("F1) TAKE PROFIT, worked (short, f=50): TP 2,300 fires on a 2,299 mark, filled AT 2,300 -> +80, fee 0.874, 1,078.176", () => {
  const e = engine({ feeRate: WITH_BUILDER_50 });
  e.open("ETH", "short", 200, 5, 2500, { tp: 2300, sl: 2700 }, ETH);
  assert.deepEqual(e.onMark("ETH", 2400), [], "between the levels nothing fires");
  const ev = e.onMark("ETH", 2299);
  /* pnl = 0.4 x (2,500 - 2,300) = 80 (the trigger price, not the 2,299 mark)
     fee = 0.4 x 2,300 x 0.00095 = 0.874
     available = 799.05 + 200 + 80 - 0.874 = 1,078.176 */
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "tp");
  assert.equal(ev[0].label, "Take profit");
  assert.equal(ev[0].px, 2300);
  assert.equal(ev[0].markPx, 2299);
  near(ev[0].pnlUsd, 80);
  near(ev[0].feeUsd, 0.874);
  near(e.getSnapshot().availableUsd, 1078.176);
  assert.equal(e.getSnapshot().positions.ETH, undefined);
});

test("F2) STOP LOSS, worked (long): SL 1,950 fires on a 1,940 mark, filled AT 1,950 -> -50, fee 0.8775, 948.2225", () => {
  const e = engine();
  e.open("ETH", "long", 100, 20, 2000, { sl: 1950 }, ETH);
  /* size = 2,000 / 2,000 = 1 ETH; margin 100; fee 0.90; available 899.10 */
  const ev = e.onMark("ETH", 1940);
  /* pnl = 1 x (1,950 - 2,000) = -50; fee = 1,950 x 0.00045 = 0.8775
     available = 899.10 + 100 - 50 - 0.8775 = 948.2225 */
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "sl");
  assert.equal(ev[0].label, "Stop loss");
  near(ev[0].pnlUsd, -50);
  near(ev[0].feeUsd, 0.8775);
  near(e.getSnapshot().availableUsd, 948.2225);
});

test("F3) LIQUIDATION, worked (short): HYPE $50 at 10x at 40, liq 41.905; a 41.90 mark is safe, 41.91 loses the whole $50", () => {
  const e = engine();
  e.open("HYPE", "short", 50, 10, 40, {}, HYPE);
  /* size = 500 / 40 = 12.5; fee = 500 x 0.00045 = 0.225; available = 949.775
     liq = 40 x (1 + 1/10) / (1 + 1/20) = 44 / 1.05 = 41.9047...
     check: equity at liq = 50 - 12.5 x 1.9047 = 26.19 = 5% x 12.5 x 41.9047 (maintenance) */
  near(e.getSnapshot().positions.HYPE.liqPx, 41.904761904761905);
  assert.deepEqual(e.onMark("HYPE", 41.9), []);
  const ev = e.onMark("HYPE", 41.91);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "liquidated");
  assert.equal(ev[0].label, "Liquidated");
  near(ev[0].pnlUsd, -50, 1e-12, "the whole isolated margin");
  assert.equal(ev[0].feeUsd, 0);
  near(ev[0].px, 41.904761904761905);
  near(ev[0].availableUsd, 949.775, 1e-12, "the history line agrees with the account");
  near(e.getSnapshot().availableUsd, 949.775, 1e-12, "the margin paid at open is the whole loss, nothing more");
  assert.equal(e.getSnapshot().history.at(-1).type, "liquidated");
});

test("F4) a gap: the first level on the price path wins — the stop (inside liquidation) before liquidation; no stop, liquidation", () => {
  const withSl = engine();
  withSl.open("ETH", "long", 100, 20, 2000, { sl: 1950 }, ETH);
  const a = withSl.onMark("ETH", 1800);   // jumps past both 1,950 and the 1,938.78 liquidation
  assert.equal(a[0].type, "sl");
  assert.equal(a[0].px, 1950);
  const noSl = engine();
  noSl.open("ETH", "long", 100, 20, 2000, {}, ETH);
  const held = noSl.getSnapshot().positions.ETH;
  assert.deepEqual(M.perpMockTrigger(held, 1800), { type: "liquidated", px: held.liqPx }, "the pure trigger rule, on its own");
  assert.equal(M.perpMockTrigger(held, 1990), null);
  assert.equal(M.perpMockTrigger(null, 1800), null);
  const b = noSl.onMark("ETH", 1800);
  assert.equal(b[0].type, "liquidated");
  near(b[0].pnlUsd, -100);
});

test("F5) marks between the levels touch nothing: no storage write, no history; a coin with no position is just remembered", () => {
  const storage = memStorage();
  const e = engine({ storage });
  e.open("BTC", "long", 100, 10, 100_000, { tp: 120_000, sl: 95_000 }, BTC);
  const writes = storage.writes;
  const n = e.getSnapshot().history.length;
  for (const px of [100_500, 101_000, 99_000, 110_000]) assert.deepEqual(e.onMark("BTC", px), []);
  assert.equal(storage.writes, writes, "a mark tick must not rewrite localStorage");
  assert.equal(e.getSnapshot().history.length, n);
  assert.deepEqual(e.onMark("SOL", 150), []);
  assert.equal(e.getSnapshot().marks.SOL.px, 150);
  assert.deepEqual(e.onMark("BTC", NaN), [], "an unreadable mark is ignored");
  assert.equal(e.getSnapshot().marks.BTC.px, 110_000);
});

/* ════════════════════════════════════════════════════════════════════════════
   G. THE DERIVED CARD AND THE ACCOUNT
   ════════════════════════════════════════════════════════════════════════════ */

test("G1) the position card: value = margin + uPnL, uPnL % of margin, leveraged size in $ and coin, entry, liq", () => {
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, { tp: 110_000, sl: 95_000 }, BTC);
  e.onMark("BTC", 105_000);
  const c = e.getSnapshot().list[0];
  /* uPnL = 0.01 x (105,000 - 100,000) = +50 = 50% of the $100 margin
     value = 100 + 50 = 150; leveraged size = 0.01 x 105,000 = $1,050 (0.01 BTC)
     at TP: 0.01 x 10,000 = +100; at SL: 0.01 x -5,000 = -50 (before fees) */
  assert.equal(c.mock, true);
  assert.equal(c.coin, "BTC");
  near(c.uPnlUsd, 50);
  near(c.uPnlPct, 50);
  near(c.valueUsd, 150);
  near(c.notionalUsd, 1050);
  assert.equal(c.size, 0.01);
  assert.equal(c.entryPx, 100_000);
  near(c.liqPx, 91139.24050632911);
  near(c.tpPnlUsd, 100);
  near(c.slPnlUsd, -50);
  assert.equal(c.markStale, false);

  /* A short gains when the mark falls: 0.4 ETH short from 2,500, mark 2,400 -> +40 = 20% of 200. */
  const s = engine();
  s.open("ETH", "short", 200, 5, 2500, {}, ETH);
  s.onMark("ETH", 2400);
  near(s.getSnapshot().list[0].uPnlUsd, 40);
  near(s.getSnapshot().list[0].uPnlPct, 20);
  near(s.getSnapshot().list[0].valueUsd, 240);
});

test("G2) unknown mark -> null figures (the dash), never 0; a stale mark is flagged", () => {
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  const c = e.getSnapshot().list[0];
  assert.equal(c.markPx, null);
  assert.equal(c.uPnlUsd, null);
  assert.equal(c.uPnlPct, null);
  assert.equal(c.valueUsd, null);
  assert.equal(c.notionalUsd, null);
  near(c.entryNotionalUsd, 1000, 1e-12, "what is known is still shown");
  assert.equal(e.getSnapshot().account.equityUsd, null, "one unpriced position makes the total unknown, not short");
  assert.equal(e.getSnapshot().account.uPnlUsd, null);
  near(e.getSnapshot().account.availableUsd, 899.55);
  e.onMark("BTC", 101_000);
  e.markStale("BTC");
  const st = e.getSnapshot().list[0];
  assert.equal(st.markStale, true);
  near(st.uPnlUsd, 10, 1e-12, "the last mark still prices it, flagged");
  assert.equal(M.derivePerpMockPosition(e.getSnapshot().positions.BTC, null).valueUsd, null);
});

test("G2b) a stale mark is never a default price: close and TP / SL without a mark refuse until a fresh one lands", () => {
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  e.onMark("BTC", 101_000);
  e.markStale("BTC");
  assert.equal(e.close("BTC", 1).error, "priceUnknown");
  assert.equal(e.quoteClose("BTC", 1).error, "priceUnknown");
  assert.equal(e.setTpSl("BTC", { tp: 130_000 }).error, "priceUnknown");
  e.onMark("BTC", 101_000);
  assert.equal(e.quoteClose("BTC", 1).ok, true, "the same price, fresh again, is usable");
  near(e.quoteClose("BTC", 1).pnlUsd, 10);
});

test("G3) the account: available + margins + uPnL = equity; realised and fees reconcile to the start after any sequence", () => {
  const e = engine({ feeRate: WITH_BUILDER_50 });
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  e.open("ETH", "short", 200, 5, 2500, { tp: 2300 }, ETH);
  e.open("HYPE", "short", 50, 10, 40, {}, HYPE);
  e.add("BTC", "long", 100, 110_000);
  e.close("BTC", 0.5, 108_000);
  e.onMark("ETH", 2299);      // TP
  e.onMark("HYPE", 42);       // liquidated
  e.onMark("BTC", 107_000);
  const snap = e.getSnapshot();
  const a = snap.account;
  assert.equal(a.mock, true);
  assert.equal(a.startUsd, 1000);
  const p = snap.positions.BTC;
  const upnl = p.size * (107_000 - p.entryPx);
  near(a.uPnlUsd, upnl);
  near(a.marginUsd, p.marginUsd);
  near(a.equityUsd, a.availableUsd + p.marginUsd + upnl);
  /* start - fees + realised - open margin = available, whatever happened. */
  const fees = snap.history.reduce((s, h) => s + (h.feeUsd || 0), 0);
  const realised = snap.history.reduce((s, h) => s + (h.pnlUsd == null ? 0 : h.pnlUsd), 0);
  near(a.feesUsd, fees);
  near(a.realizedPnlUsd, realised);
  near(a.availableUsd, 1000 - fees + realised - p.marginUsd, 1e-9);
  near(a.totalPnlUsd, a.equityUsd - 1000);
  assert.equal(a.openCount, 1);
});

/* ════════════════════════════════════════════════════════════════════════════
   H. PERSISTENCE
   ════════════════════════════════════════════════════════════════════════════ */

test("H1) the blob lives under flowflow.perpMock.v1 with a version field, and a new engine reads the same account back", () => {
  assert.equal(M.PERP_MOCK_STORAGE_KEY, "flowflow.perpMock.v1");
  const storage = memStorage();
  const a = engine({ storage });
  a.open("BTC", "long", 100, 10, 100_000, { tp: 120_000 }, BTC);
  const blob = JSON.parse(storage.raw("flowflow.perpMock.v1"));
  assert.equal(blob.v, 1);
  assert.equal(blob.mock, true);
  const b = engine({ storage });
  assert.deepEqual(b.getSnapshot().positions, a.getSnapshot().positions);
  near(b.getSnapshot().availableUsd, 899.55);
  assert.equal(b.getSnapshot().loadNote, null);
  assert.equal(b.getSnapshot().persisted, true);
});

test("H2) a corrupt blob, a foreign version or a malformed position resets safely and SAYS it did", () => {
  /* Each bad blob is a GOOD one with exactly one field broken, so every check is pinned on its own. */
  const good = memStorage();
  engine({ storage: good }).open("BTC", "long", 100, 10, 100_000, { tp: 120_000 }, BTC);
  const valid = JSON.parse(good.raw("flowflow.perpMock.v1"));
  assert.ok(engine({ storage: memStorage({ "flowflow.perpMock.v1": JSON.stringify(valid) }) }).getSnapshot().positions.BTC, "the unbroken blob loads");
  const broken = (edit) => { const j = structuredClone(valid); edit(j); return JSON.stringify(j); };
  for (const [raw, why] of [
    ["{not json", "corrupt"],
    ["null", "corrupt"],
    ["[]", "corrupt"],
    [broken((j) => { j.v = 2; }), "version"],
    [broken((j) => { delete j.v; }), "corrupt"],
    [broken((j) => { j.mock = false; }), "corrupt"],
    [broken((j) => { j.availableUsd = "lots"; }), "corrupt"],
    [broken((j) => { j.startUsd = 0; }), "corrupt"],
    [broken((j) => { j.seq = 1.5; }), "corrupt"],
    [broken((j) => { j.history = {}; }), "corrupt"],
    [broken((j) => { j.history.push({ type: "open" }); }), "corrupt"],
    [broken((j) => { j.positions = []; }), "corrupt"],
    [broken((j) => { j.positions.BTC.size = "x"; }), "corrupt"],
    [broken((j) => { j.positions.BTC.side = "up"; }), "corrupt"],
    [broken((j) => { j.positions.BTC.coin = "ETH"; }), "corrupt"],
    [broken((j) => { j.positions.BTC.leverage = 41; }), "corrupt"],
    [broken((j) => { j.positions.BTC.tp = -1; }), "corrupt"],
    [broken((j) => { j.positions.BTC.tiers = [{ lowerBound: "0" }]; }), "corrupt"],
    [broken((j) => { j.positions.BTC.feesUsd = null; }), "corrupt"],
  ]) {
    const storage = memStorage({ "flowflow.perpMock.v1": raw });
    const e = engine({ storage });
    const s = e.getSnapshot();
    assert.equal(s.availableUsd, 1000, `${raw}: a fresh 1000`);
    assert.deepEqual(s.positions, {});
    assert.equal(s.loadNote, why, raw);
    assert.equal(s.history[0].type, "reset");
    assert.equal(s.history[0].reason, why);
    assert.equal(JSON.parse(storage.raw("flowflow.perpMock.v1")).v, 1, "the bad blob is replaced, so the next load is clean");
  }
});

test("H3) private mode: a storage that throws on read or write never crashes the engine", () => {
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); }, removeItem() { throw new Error("x"); } };
  const e = engine({ storage: throwing });
  assert.equal(e.getSnapshot().availableUsd, 1000);
  const r = e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  assert.equal(r.ok, true, "trading still works, in memory");
  assert.equal(e.getSnapshot().persisted, false);
  assert.match(String(e.getSnapshot().saveError), /Quota/);
  assert.equal(e.close("BTC", 1, 100_000).ok, true);

  const none = engine({ storage: null });
  assert.equal(none.open("BTC", "long", 100, 10, 100_000, {}, BTC).ok, true);
  assert.equal(none.getSnapshot().persisted, false);
});

test("H4) reset() starts a fresh 1000 USD account and records why", () => {
  const storage = memStorage();
  const e = engine({ storage });
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  const acct = e.getSnapshot().acct;
  assert.equal(e.reset().ok, true);
  const s = e.getSnapshot();
  assert.equal(s.availableUsd, 1000);
  assert.deepEqual(s.positions, {});
  assert.deepEqual(s.history.map((h) => [h.type, h.reason]), [["reset", "user"]]);
  assert.equal(s.acct, acct + 1);
  assert.equal(JSON.parse(storage.raw("flowflow.perpMock.v1")).availableUsd, 1000);
});

/* ════════════════════════════════════════════════════════════════════════════
   I. TWO TABS
   ════════════════════════════════════════════════════════════════════════════ */

test("I1) a write in one tab reaches the other through the storage event", () => {
  const w = twoTabs();
  const a = engine({ storage: w.tabs[0].storage, listen: w.tabs[0].listen });
  const b = engine({ storage: w.tabs[1].storage, listen: w.tabs[1].listen });
  let heard = 0;
  b.subscribe(() => { heard++; });
  a.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  assert.equal(b.getSnapshot().positions.BTC, undefined, "not yet delivered");
  w.deliver();
  assert.ok(b.getSnapshot().positions.BTC, "tab B sees tab A's position");
  near(b.getSnapshot().availableUsd, 899.55);
  assert.ok(heard > 0, "and tells its readers");
  /* Another key's write — even one holding a readable mock blob — is not ours. */
  const foreign = JSON.parse(w.area.get("flowflow.perpMock.v1"));
  foreign.availableUsd = 5;
  w.tabs[1].listeners.forEach((fn) => fn({ key: "flowflow.perpMock.v2", oldValue: null, newValue: JSON.stringify(foreign) }));
  w.tabs[1].listeners.forEach((fn) => fn({ key: "flowflow.follow", oldValue: null, newValue: "[]" }));
  w.tabs[1].listeners.forEach((fn) => fn({ key: "flowflow.perpMock.v1", oldValue: null, newValue: "{broken" }));
  near(b.getSnapshot().availableUsd, 899.55, 1e-12, "only our key, and only a readable blob, is adopted");
  b.destroy();
  a.close("BTC", 1, 100_000);
  w.deliver();
  assert.ok(b.getSnapshot().positions.BTC, "a destroyed engine stops listening");
});

test("I2) no lost update: every action re-reads storage first, even before the event arrives", () => {
  const w = twoTabs();
  const a = engine({ storage: w.tabs[0].storage, listen: w.tabs[0].listen });
  const b = engine({ storage: w.tabs[1].storage, listen: w.tabs[1].listen });
  a.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  w.drop();                                     // the event never arrives
  b.open("ETH", "short", 200, 5, 2500, {}, ETH);
  const blob = JSON.parse(w.area.get("flowflow.perpMock.v1"));
  assert.deepEqual(Object.keys(blob.positions).sort(), ["BTC", "ETH"], "tab B built on tab A's write");
  near(blob.availableUsd, 1000 - 100.45 - 200.45);
});

test("I3) both tabs feeding the same mark close a TP once, not twice", () => {
  const w = twoTabs();
  const a = engine({ storage: w.tabs[0].storage, listen: w.tabs[0].listen });
  const b = engine({ storage: w.tabs[1].storage, listen: w.tabs[1].listen });
  a.open("ETH", "short", 200, 5, 2500, { tp: 2300 }, ETH);
  w.deliver();
  const ea = a.onMark("ETH", 2299);
  const eb = b.onMark("ETH", 2299);             // B had not heard about A's close yet
  assert.equal(ea.length + eb.length, 1);
  const blob = JSON.parse(w.area.get("flowflow.perpMock.v1"));
  assert.equal(blob.history.filter((h) => h.type === "tp").length, 1);
  near(blob.availableUsd, 1000 - 200.45 + 200 + 80 - 920 * 0.00045);
});

/* ════════════════════════════════════════════════════════════════════════════
   J. THE MARK FEEDER
   ════════════════════════════════════════════════════════════════════════════ */

function fakeMarkets() {
  let snap = { byCoin: {}, staleSince: null, coinFreshAt: {} };
  const listeners = new Set();
  const retained = new Map();
  const emit = () => { for (const fn of [...listeners]) fn(); };
  return {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => snap,
    retainCoin: (coin) => {
      retained.set(coin, (retained.get(coin) || 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const n = retained.get(coin) - 1;
        if (n) retained.set(coin, n); else retained.delete(coin);
      };
    },
    set(coin, fields, at = Date.now()) {
      const row = { coin, ...(snap.byCoin[coin] || {}), ...fields };
      snap = { ...snap, byCoin: { ...snap.byCoin, [coin]: row }, coinFreshAt: { ...snap.coinFreshAt, [coin]: at } };
      emit();
    },
    goStale(at) { snap = { ...snap, staleSince: at, coinFreshAt: {} }; emit(); },
    retained,
    listeners,
  };
}

test("J1) the feeder retains ONLY coins with open positions and feeds their MARK (not the mid) to onMark", () => {
  const mk = fakeMarkets();
  const e = engine();
  const fd = FD.createPerpMockFeeder({ engine: e, markets: mk });
  mk.set("ETH", { markPx: 2400, midPx: 2401, px: 2401 });
  const stop = fd.retain();
  assert.deepEqual([...mk.retained.keys()], [], "no position, no subscription");
  e.open("ETH", "short", 200, 5, 2500, { tp: 2300 }, ETH);
  assert.deepEqual([...mk.retained.keys()], ["ETH"]);
  assert.equal(e.getSnapshot().marks.ETH.px, 2400, "the mark already in the store is fed at once");
  mk.set("BTC", { markPx: 1, px: 1 });
  assert.equal(e.getSnapshot().marks.BTC, undefined, "a coin nobody holds is not fed");
  mk.set("ETH", { midPx: 2250, px: 2250 });
  assert.equal(e.getSnapshot().positions.ETH.tp, 2300, "a mid through the TP is not the mark: nothing fires");
  mk.set("ETH", { markPx: 2299 });
  assert.equal(e.getSnapshot().positions.ETH, undefined, "the mark through the TP closes it");
  assert.deepEqual([...mk.retained.keys()], [], "and the subscription is released");
  stop();
  assert.equal(mk.listeners.size, 0);
});

test("J2) a stale store feeds nothing: no trigger fires on a frozen mark; the card is flagged until a fresh mark lands", () => {
  const mk = fakeMarkets();
  const e = engine();
  const fd = FD.createPerpMockFeeder({ engine: e, markets: mk });
  const stop = fd.retain();
  mk.set("ETH", { markPx: 2400 }, 10);
  e.open("ETH", "short", 200, 5, 2500, { tp: 2300 }, ETH);
  mk.goStale(20);
  assert.equal(e.getSnapshot().list[0].markStale, true);
  /* A row edited while stale (the table refresh) is not a fresh stream push. */
  const snap = mk.getSnapshot();
  mk.getSnapshot = () => ({ ...snap, byCoin: { ETH: { coin: "ETH", markPx: 2000 } }, coinFreshAt: {} });
  for (const fn of [...mk.listeners]) fn();
  assert.ok(e.getSnapshot().positions.ETH, "no TP on a stale mark");
  mk.getSnapshot = () => ({ ...snap, byCoin: { ETH: { coin: "ETH", markPx: 2400 } }, coinFreshAt: { ETH: 30 } });
  for (const fn of [...mk.listeners]) fn();
  assert.equal(e.getSnapshot().list[0].markStale, false, "the same price, fresh again, clears the flag");
  stop();
});

test("J3) the feeder is refcounted: two readers share one set of subscriptions; the last one out releases them", () => {
  const mk = fakeMarkets();
  const e = engine();
  e.open("BTC", "long", 100, 10, 100_000, {}, BTC);
  const fd = FD.createPerpMockFeeder({ engine: e, markets: mk });
  const s1 = fd.retain();
  const s2 = fd.retain();
  assert.equal(mk.retained.get("BTC"), 1, "one retain per coin however many readers");
  s1();
  s1();
  assert.equal(mk.retained.get("BTC"), 1);
  s2();
  assert.equal(mk.retained.size, 0);
  assert.equal(mk.listeners.size, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   K. usePerpMock AND THE CONFIG MODULE (bundled by esbuild)
   ════════════════════════════════════════════════════════════════════════════ */

const FAKE_REACT = `
const H = () => (globalThis.__mockHooks ||= { effects: [] });
export function useSyncExternalStore(sub, get) { H().sub = sub; return get(); }
export function useEffect(fn, deps) { H().effects.push({ fn, deps }); }
export function useMemo(f) { return f(); }
export function useCallback(f) { return f; }
export default { useSyncExternalStore, useEffect, useMemo, useCallback };
`;
const FAKE_MARKETS = `
export function perpMarketsStore() { return globalThis.__fakeMarkets; }
export function isPerpMarketStale(s, coin) {
  if (!s || s.staleSince == null) return false;
  const t = s.coinFreshAt ? s.coinFreshAt[coin] : undefined;
  return !(t > s.staleSince);
}
`;
let bseq = 0;
async function bundle(entry, env) {
  const mod = await import("esbuild");
  const esbuild = mod.build ? mod : mod.default;
  const out = path.join(os.tmpdir(), `ff-perp-mock-${process.pid}-${Date.now()}-${bseq++}.mjs`);
  const marketsAbs = P("src/lib/hyperliquid/markets.js");
  await esbuild.build({
    entryPoints: [P(entry)],
    bundle: true, format: "esm", platform: "node", logLevel: "silent", outfile: out,
    define: { "import.meta.env": JSON.stringify(env) },
    plugins: [{
      name: "perp-mock-stubs",
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "fake" }));
        b.onResolve({ filter: /markets\.js$/ }, (a) => (path.resolve(a.resolveDir, a.path) === marketsAbs ? { path: "markets", namespace: "fake" } : undefined));
        b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: a.path === "react" ? FAKE_REACT : FAKE_MARKETS, loader: "js" }));
      },
    }],
  });
  return import(pathToFileURL(out).href);
}

test("K1) config.js is the one reader of VITE_PERP_BUILDER_FEE: empty -> 0 (0.045%), 50 -> 0.095%, garbage -> unknown", async () => {
  const unset = await bundle(FILES.config, {});
  assert.equal(unset.PERP_BUILDER_FEE_TENTHS_BP, 0);
  near(unset.PERP_MOCK_FEE_RATE, 0.00045);
  const empty = await bundle(FILES.config, { VITE_PERP_BUILDER_FEE: "" });
  assert.equal(empty.PERP_BUILDER_FEE_TENTHS_BP, 0);
  const fifty = await bundle(FILES.config, { VITE_PERP_BUILDER_FEE: "50" });
  assert.equal(fifty.PERP_BUILDER_FEE_TENTHS_BP, 50);
  near(fifty.PERP_MOCK_FEE_RATE, 0.00095);
  const bad = await bundle(FILES.config, { VITE_PERP_BUILDER_FEE: "0.05%" });
  assert.equal(bad.PERP_BUILDER_FEE_TENTHS_BP, null);
  assert.equal(bad.PERP_MOCK_FEE_RATE, null);
  /* An unknown fee blocks every fee-bearing action instead of charging 0. */
  const e = engine({ feeRate: bad.PERP_MOCK_FEE_RATE });
  assert.equal(e.open("BTC", "long", 100, 10, 100_000, {}, BTC).error, "feeUnknown");
});

test("K2) usePerpMock: the snapshot through useSyncExternalStore, the feeder started by its effect and stopped by the cleanup", async () => {
  const H = await bundle(FILES.hook, { VITE_PERP_BUILDER_FEE: "50" });
  const storageEvents = [];
  globalThis.localStorage = memStorage();
  globalThis.window = {
    addEventListener: (t, fn) => storageEvents.push([t, fn]),
    removeEventListener: () => {},
  };
  globalThis.__fakeMarkets = fakeMarkets();
  globalThis.__mockHooks = { effects: [] };
  try {
    const v = H.usePerpMock();
    assert.equal(v.mock, true);
    assert.equal(v.availableUsd, 1000);
    assert.equal(typeof v.open, "function");
    assert.equal(typeof globalThis.__mockHooks.sub, "function", "subscribed through useSyncExternalStore");
    assert.ok(storageEvents.some(([t]) => t === "storage"), "the app engine listens for other tabs");
    const fx = globalThis.__mockHooks.effects;
    assert.equal(fx.length, 1);
    const cleanup = fx[0].fn();
    assert.equal(typeof cleanup, "function");
    const r = v.open("ETH", "short", 200, 5, 2500, { tp: 2300 }, ETH);
    assert.equal(r.ok, true, r.message);
    near(r.event.feeUsd, 0.95, 1e-12, "the app engine charges the configured builder fee");
    assert.deepEqual([...globalThis.__fakeMarkets.retained.keys()], ["ETH"], "the hook's feeder subscribed the held coin");
    assert.ok(JSON.parse(globalThis.localStorage.raw("flowflow.perpMock.v1")).positions.ETH, "saved to localStorage");
    globalThis.__fakeMarkets.set("ETH", { markPx: 2299 });
    assert.equal(H.perpMockEngine().getSnapshot().positions.ETH, undefined, "the TP fired while the app was open");
    cleanup();
    assert.equal(globalThis.__fakeMarkets.listeners.size, 0, "unmounting stops the feeder");
    assert.equal(H.perpMockEngine(), H.perpMockEngine(), "one engine per tab");
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.__fakeMarkets;
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   L. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

function walk(dir, out = []) {
  for (const e of fs.readdirSync(P(dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(jsx?|mjs|tsx?)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test("L1) the builder fee is read in ONE place: perp/mock/config.js", () => {
  const readers = walk("src").filter((f) => /VITE_PERP_BUILDER_FEE/.test(code(f)));
  assert.deepEqual(readers, [FILES.config]);
  for (const f of Object.values(FILES)) {
    if (f === FILES.config) continue;
    assert.doesNotMatch(code(f), /import\.meta\.env/, `${f} reads the env itself`);
  }
});

test("L2) the mock opens no connection of its own — marks come from the one market store", () => {
  for (const f of walk(MOCK_DIR)) {
    assert.doesNotMatch(code(f), /new WebSocket|fetch\(|XMLHttpRequest|api\.hyperliquid\.xyz|hlSubscribe|hlWs\(/, `${f} opens its own connection`);
  }
  assert.match(code(FILES.hook), /perpMarketsStore\(\)/);
  assert.match(code(FILES.feeder), /retainCoin\(/);
});

test("L3) MOCK money stays out of real money: the mock imports no wallet figure, and only the perp surfaces import the mock", () => {
  for (const f of walk(MOCK_DIR)) {
    assert.doesNotMatch(code(f), /usePortfolio|portfolioScan|leaderboard|useWallet|getBalance|balanceOf/i, `${f} touches a real figure`);
  }
  const importers = walk("src").filter((f) => !f.startsWith(`${MOCK_DIR}/`) && /from\s+["'][^"']*perp\/mock\/|import\(\s*["'][^"']*perp\/mock\/|from\s+["']\.\/mock\//.test(code(f)));
  const allowed = (f) => f.startsWith("src/perp/");
  assert.deepEqual(importers.filter((f) => !allowed(f)), [], "a mock figure must never reach usePortfolio, Cash, the header pills or the leaderboard");
});

test("L4) the liquidation price is slice 1's estimate, imported — not a second formula", () => {
  const m = code(FILES.math);
  assert.match(m, /import\s*\{[^}]*estIsolatedLiqPx[^}]*\}\s*from\s*"\.\.\/perpTicket\.js"/);
  assert.match(m, /import\s*\{[^}]*marginTierFor[^}]*\}\s*from\s*"\.\.\/perpTicket\.js"/);
  for (const f of walk(MOCK_DIR)) assert.doesNotMatch(code(f), /2\s*\*\s*maxLev|mmr\s*=/, `${f} re-derives the maintenance rate`);
});

test("L5) localStorage is touched only by the hook module, inside try; the key is written once", () => {
  for (const f of walk(MOCK_DIR)) {
    const c = code(f);
    if (f === FILES.hook) continue;
    assert.doesNotMatch(c, /localStorage|window\./, `${f} reaches for the browser itself`);
  }
  const h = code(FILES.hook);
  assert.match(h, /try\s*\{[^}]*localStorage/);
  const keyHits = walk("src").filter((f) => /flowflow\.perpMock\.v1/.test(code(f)));
  assert.deepEqual(keyHits, [FILES.math]);
});

test("L7) every new file is LF-only", () => {
  for (const f of [...walk(MOCK_DIR), "scripts/test-perp-mock.mjs"]) {
    assert.equal(fs.readFileSync(P(f)).includes(Buffer.from("\r\n")), false, `${f} has CRLF`);
  }
});
