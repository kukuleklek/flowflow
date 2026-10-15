/**
 * test-perp-leverage — THE LEVERAGE CONTROL: the drag track with detents, the
 * big value that takes its colour from risk, the live "Liq $X · Y% away" line
 * with its distance bar, and the plain-words warning past 20x.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-23: "ในหน้า Buy Sell มันยังไม่ดีเท่าไหร่เลย ตอนเลือก Leverage ด้วย
 * ... ฝากพัฒนาหน่อย ให้โหดกว่านี้ หรูกว่านี้".
 *
 * THE MONEY RULES ON A LEVERAGE SCREEN (docs/MONEY_RULES.md 0 and 1):
 *   • the liquidation distance is ONE function (liqGap), the same one the open
 *     position's own warning uses — the ticket may not estimate it its own way;
 *   • before the fill it is an ESTIMATE and says so;
 *   • when it cannot be computed it is a dash with one short line saying why,
 *     never a made-up number;
 *   • the warning past 20x states the REAL distance and the REAL max loss.
 *
 * Pure rules first, then the control rendered through esbuild with the hook
 * runner (scripts/lib/perpLiveHarness.mjs). No DOM, no network, no wallet.
 *
 * Run: node --test scripts/test-perp-leverage.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  P, code, autoStubs, bundle, all, stubsNamed, textOf, squash, wait, byTest, fakeBrowser,
} from "./lib/perpLiveHarness.mjs";

globalThis.fetch = () => { throw new Error("test-perp-leverage: a real network call was attempted"); };

const DIR = "src/perp/live/";
const VIEW = `${DIR}perpLiveView.js`;
const LEVERAGE = `${DIR}PerpLeverage.jsx`;
const PURE_KEEP = [
  VIEW, `${DIR}perpBackend.js`, `${DIR}slide.js`, `${DIR}storage.js`, "src/lib/format.js",
  "src/lib/hyperliquid/format.js", "src/lib/hyperliquid/exchange/orders.js",
  "src/lib/hyperliquid/exchange/master.js", "src/lib/hyperliquid/exchange/signing.js",
  "src/perp/mock/fees.js", "src/perp/perpTicket.js", "src/lib/hyperliquid/markets.js",
  "src/perp/mock/perpMockMath.js",
];

let V = null;
let markets = null;
let loadError = null;
before(async () => {
  try {
    V = await import(pathToFileURL(P(VIEW)).href);
    const MK = await import(pathToFileURL(P("src/lib/hyperliquid/markets.js")).href);
    const FIX = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(P("scripts/fixtures/hl-meta-and-asset-ctxs.json"), "utf8")));
    markets = MK.parsePerpMarkets(FIX.response, { now: 1 });
  } catch (e) { loadError = e; }
});
const need = () => { if (loadError) throw loadError; };

const riskAt = (leverage, { marginUsdc = 50, side = "buy", balanceSource = "perp" } = {}) => V.riskView({
  side, marginUsdc, leverage, market: markets.byCoin.BTC, feeRate: 0.00045, balanceSource,
  notionalUsd: marginUsdc * leverage,
});
const levAt = (leverage, over = {}) => V.leverageView({
  leverage, maxLeverage: 40, marginUsdc: 50, market: markets.byCoin.BTC, side: "buy",
  risk: riskAt(leverage), ...over,
});

/* ════════════════════════════════════════════════════════════════════════════
   G. one liquidation distance, shared with the position
   ════════════════════════════════════════════════════════════════════════════ */

test("G1) 🔴 ONE distance function: the ticket's estimate and the open position's warning read liqGap, and agree", () => {
  need();
  assert.equal(V.liqGap({ side: "long", px: 100, liqPx: 95 }), 0.05);
  assert.equal(V.liqGap({ side: "buy", px: 100, liqPx: 95 }), 0.05, "the ticket's side words are the same distance");
  assert.ok(Math.abs(V.liqGap({ side: "short", px: 100, liqPx: 103 }) - 0.03) < 1e-12);
  assert.ok(Math.abs(V.liqGap({ side: "sell", px: 100, liqPx: 103 }) - 0.03) < 1e-12);
  /* Past it: zero, never a negative distance dressed up as room. */
  assert.equal(V.liqGap({ side: "long", px: 94, liqPx: 95 }), 0);
  for (const bad of [{ side: "long", px: 100, liqPx: null }, { side: "long", px: null, liqPx: 95 }, { side: null, px: 100, liqPx: 95 }, {}]) {
    assert.equal(V.liqGap(bad), null, "unknown in, null out");
  }
  /* The position card's own warning is that function times 100. */
  const w = V.liqWarningView({ side: "long", liquidationPx: 95 }, 100);
  assert.equal(w.pct, V.liqGap({ side: "long", px: 100, liqPx: 95 }) * 100);
  assert.equal(w.text, "Mark price is 5.0% from liquidation");
  const lev = levAt(5);
  const risk = riskAt(5);
  assert.equal(lev.distPct, V.liqGap({ side: "buy", px: markets.byCoin.BTC.px, liqPx: risk.liqPx }) * 100,
    "the leverage screen's percentage IS the same estimate the position later shows");
});

/* ════════════════════════════════════════════════════════════════════════════
   V. the track
   ════════════════════════════════════════════════════════════════════════════ */

test("V1) detents 1 / 5 / 10 / 20 / max, never past the market's own maximum", () => {
  need();
  assert.deepEqual(V.leverageMarks(40), [1, 5, 10, 20, 40]);
  assert.deepEqual(V.leverageMarks(20), [1, 5, 10, 20], "the max is not repeated");
  assert.deepEqual(V.leverageMarks(10), [1, 5, 10]);
  assert.deepEqual(V.leverageMarks(3), [1, 3]);
  assert.deepEqual(V.leverageMarks(1), [1]);
  assert.deepEqual(V.leverageMarks(null), [], "no market, no track");
});

test("V2) the track's geometry: every detent has its own place, the ends are the ends, and a drag snaps to a detent it is near", () => {
  need();
  assert.equal(V.leverageRatio(1, 40), 0);
  assert.equal(V.leverageRatio(40, 40), 1);
  const marks = V.leverageMarks(40).map((m) => V.leverageRatio(m, 40));
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i] > marks[i - 1], "the marks climb");
  assert.ok(marks[1] > 0.3, "1x .. 5x is not crushed into the left edge");
  /* A drag lands on an integer, clamped, and magnetises to a nearby detent. */
  assert.equal(V.leverageFromRatio(0, 40), 1);
  assert.equal(V.leverageFromRatio(1, 40), 40);
  assert.equal(V.leverageFromRatio(-3, 40), 1);
  assert.equal(V.leverageFromRatio(9, 40), 40);
  assert.equal(V.leverageFromRatio(V.leverageRatio(10, 40) + 0.01, 40), 10, "a hair off 10x snaps to 10x");
  assert.equal(V.leverageFromRatio(V.leverageRatio(13, 40), 40), 13, "away from a detent it is free");
  assert.equal(V.leverageFromRatio(0.5, null), 1, "no maximum: the only leverage is 1x");
});

test("V3) the big value takes its colour from risk: low at 2x, extreme past 20x, and an unknown distance falls back to the leverage itself", () => {
  need();
  assert.equal(levAt(2).tone, "low");
  assert.equal(levAt(10).tone, "mid");
  assert.equal(levAt(20).tone, "high");
  assert.equal(levAt(40).tone, "extreme");
  const blind = levAt(40, { risk: riskAt(40, { balanceSource: "spot" }) });
  assert.equal(blind.distPct, null, "unified account: no pre-trade estimate");
  assert.equal(blind.tone, "extreme", "the colour still answers");
  for (const t of ["low", "mid", "high", "extreme"]) assert.match(V.LEVERAGE_TONE_COLOR[t], /^var\(--p-/);
});

/* ════════════════════════════════════════════════════════════════════════════
   Q. the liquidation line
   ════════════════════════════════════════════════════════════════════════════ */

test("Q1) 🔴 'Liq ≈ $X · Y% away' with a distance bar, marked an ESTIMATE before the fill", () => {
  need();
  const l = levAt(5);
  assert.match(l.liqText, /^≈ \$[\d,]+$/);
  assert.match(l.distText, /^\d+\.\d% away$/);
  assert.match(l.line, /^Liq ≈ \$[\d,]+ · \d+\.\d% away$/);
  assert.ok(l.distPct > 15 && l.distPct < 21, `5x is about a fifth away, got ${l.distPct}`);
  assert.ok(l.barPct > 0 && l.barPct <= 1);
  assert.equal(l.estimate, true);
  assert.match(l.estimateText, /estimate/i);
  const far = levAt(2);
  assert.ok(far.barPct > l.barPct, "more room, more bar");
  const near = levAt(40);
  assert.ok(near.barPct < l.barPct && near.distPct < 4, "40x sits a breath from liquidation");
});

test("Q2) 🔴 it cannot be estimated: a DASH and one short line saying why — never a made-up number on a leverage screen", () => {
  need();
  const unified = levAt(5, { risk: riskAt(5, { balanceSource: "spot" }) });
  assert.equal(unified.liqText, V.DASH);
  assert.equal(unified.distPct, null);
  assert.equal(unified.distText, V.DASH);
  assert.equal(unified.barPct, null, "no bar drawn from a number nobody has");
  assert.match(unified.note, /after the fill/i);
  assert.ok(unified.note.length < 90, "one short line");
  assert.doesNotMatch(unified.line, /\d%/, "no percentage is claimed");
  /* Past the first margin tier Hyperliquid uses another maintenance rate: the
     one-tier formula would print a price it would not use. */
  const big = V.leverageView({
    leverage: 5, maxLeverage: 40, marginUsdc: 40_000_000, market: markets.byCoin.BTC, side: "buy",
    risk: V.riskView({ side: "buy", marginUsdc: 40_000_000, leverage: 5, market: markets.byCoin.BTC, feeRate: 0.00045, balanceSource: "perp", notionalUsd: 200_000_000 }),
  });
  assert.equal(big.liqText, V.DASH);
  assert.match(big.note, /size/i);
  assert.ok(big.note.length < 110, "still one short line");
  /* No amount typed yet: nothing is claimed either way, and no note nags. */
  const empty = levAt(5, { marginUsdc: null, risk: riskAt(5, { marginUsdc: null }) });
  assert.equal(empty.liqText, V.DASH);
});

/* ════════════════════════════════════════════════════════════════════════════
   R. the control, rendered
   ════════════════════════════════════════════════════════════════════════════ */

async function control(props = {}) {
  need();
  fakeBrowser();
  globalThis.__impl = { useIsMobile: () => true, useImagesReady: () => true };
  const stubs = autoStubs([LEVERAGE], { keep: PURE_KEEP });
  const M = await bundle({ entry: LEVERAGE, env: { VITE_PERP_ENABLED: "1" }, stubs });
  const picked = [];
  const h = M.mount(() => M.default({
    leverage: 5, maxLeverage: 40, marginUsdc: 50, market: markets.byCoin.BTC, side: "buy",
    risk: riskAt(5), onChange: (v) => picked.push(v), ...props,
  }));
  h.render(); h.flush();
  await wait(0); h.flush();
  return { M, h, picked };
}
const trackOf = (tree, M) => all(tree, M.mount).find((e) => e.props && e.props["data-test"] === "lev-track");

const marksOf = (tree, M) => all(tree, M.mount).filter((e) => e.props && e.props["data-test"] === "lev-mark");
const chipsOf = (tree, M) => all(tree, M.mount).filter((e) => e.props && e.props["data-test"] === "lev-chip");
/** The strip the labels are placed in: the one element whose children are all of them. */
const markRowOf = (tree, M) => all(tree, M.mount).find((e) => {
  const kids = e.props && e.props.children;
  return Array.isArray(kids) && kids.length > 1 && kids.every((k) => k && k.props && k.props["data-test"] === "lev-mark");
});
/** The 4px detent dots drawn ON the track. */
const dotsOf = (tree, M) => all(tree, M.mount).filter((e) => e.props && e.props.style && e.props.style.width === 4 && e.props.style.height === 4);
