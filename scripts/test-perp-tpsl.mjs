/**
 * test-perp-tpsl — TP / SL BY PRICE, BY PROFIT OR LOSS IN USDC, OR BY ROE %,
 * in the trade ticket and the position's TP / SL sheet, and the percentages on
 * the position card's SL / TP row and the ticket's risk line.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-22 (iPhone): "ใน SL/TP แม่งยังแปลกๆอยู่อะ
 * อยากให้ใส่กำไรไปได้เลย หรือ จะ SL รับได้เท่าไร / แล้วบอกด้วย ว่าขาดทุนกี่ %".
 *
 *   a mode switch  Price | P/L (USDC) | % (ROE)
 *   "+50" USDC or "+25" % for a TP, "-20" USDC or "-10" % for a SL computes
 *   the trigger from the entry (Hyperliquid's entryPx for an open position, the
 *   expected fill for a new order), the size and the side, on Hyperliquid's
 *   price tick (the exchange layer's roundHlOrderPx)
 *   chips  TP +10 +25 +50 +100 %, SL -10 -25 -50 % (ROE)
 *   every leg shows its trigger AND "if hit: +X USDC (+Y%)"
 *   TP on the profit side, SL on the loss side and never past liquidation
 *
 * ROE is Hyperliquid's own: pnl / (size x entry / leverage). V1 pins it to the
 * returnOnEquity Hyperliquid reported for trader C's position.
 *
 * Fixture C (scripts/test-hl-account-fixtures.mjs): an isolated 36x BTC short,
 * 0.17811 BTC at 86,118.9, liquidation 87,382.89, a position stop at 86,423.
 * BTC's size decimals are 5, so its tick is $1 at these prices.
 *
 * Harness: scripts/lib/perpLiveHarness.mjs (esbuild + a hook runner, no DOM).
 * Nothing here can reach Hyperliquid or a wallet: fetch throws.
 *
 * Run: node --test scripts/test-perp-tpsl.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  P, read, autoStubs, bundle, all, textOf, squash, wait, byTest, fakeBrowser,
} from "./lib/perpLiveHarness.mjs";

globalThis.fetch = () => { throw new Error("test-perp-tpsl: a real network call was attempted"); };

const DIR = "src/perp/live/";
const VIEW = `${DIR}perpLiveView.js`;
const BITS = `${DIR}PerpBits.jsx`;
const SLIDE = `${DIR}SlideToConfirm.jsx`;
const SLIDE_JS = `${DIR}slide.js`;
const TICKET = `${DIR}PerpTradeTicket.jsx`;
const TPSL = `${DIR}PerpTpSlSheet.jsx`;
const CARD = `${DIR}PerpPositionCard.jsx`;
const PURE_KEEP = [
  VIEW, `${DIR}perpBackend.js`, SLIDE_JS, `${DIR}storage.js`, "src/lib/format.js", "src/lib/hyperliquid/format.js",
  "src/lib/hyperliquid/exchange/orders.js", "src/lib/hyperliquid/exchange/master.js",
  "src/lib/hyperliquid/exchange/signing.js", "src/perp/mock/fees.js", "src/perp/perpTicket.js",
  "src/lib/hyperliquid/markets.js", "src/perp/mock/perpMockMath.js",
  "src/perp/pnl/pnlView.js",
];

let V = null;
let AP = null;
let F = null;
let BAL = null;
let markets = null;
let loadError = null;
before(async () => {
  try {
    V = await import(pathToFileURL(P(VIEW)).href);
    AP = await import(pathToFileURL(P("src/lib/hyperliquid/account/parse.js")).href);
    F = await import(pathToFileURL(P("scripts/test-hl-account-fixtures.mjs")).href);
    BAL = await import(pathToFileURL(P("src/lib/hyperliquid/account/balance.js")).href);
    const MK = await import(pathToFileURL(P("src/lib/hyperliquid/markets.js")).href);
    markets = MK.parsePerpMarkets(JSON.parse(read("scripts/fixtures/hl-meta-and-asset-ctxs.json")).response, { now: 1 });
  } catch (e) { loadError = e; }
});
const need = () => { if (loadError) throw loadError; };

const USER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const C_ENTRY = 86118.9;
const C_SIZE = 0.17811;
const C_LEV = 36;
const C_MARGIN = (C_SIZE * C_ENTRY) / C_LEV;

function cPosition() { return AP.parseClearinghouse(F.C.clearinghouseState).positions[0]; }
function cBasis({ markPx = 86000 } = {}) { return V.tpslBasisFromPosition(cPosition(), { szDecimals: 5, markPx }); }
const leg = (l, mode, str, basis = cBasis(), extra = {}) => V.tpslLegView({ leg: l, mode, str, basis, ...extra });

/* ════════════════════════════════════════════════════════════════════════════
   V. the arithmetic (pure)
   ════════════════════════════════════════════════════════════════════════════ */

test("V1) 🔴 the ROE is Hyperliquid's own: pnl / (size x entry / leverage) reproduces the returnOnEquity it reported for C", () => {
  need();
  const p = cPosition();
  const b = cBasis();
  assert.equal(b.side, "short");
  assert.equal(b.entryPx, C_ENTRY, "Hyperliquid's entryPx, never a price we derived");
  assert.equal(b.size, C_SIZE);
  assert.equal(b.leverage, C_LEV);
  assert.ok(Math.abs(b.marginUsdc - C_MARGIN) < 1e-9);
  assert.equal(b.liqPx, p.liquidationPx);
  /* The price at which the uPnL is what Hyperliquid said: entry - pnl / size for a short. */
  const px = C_ENTRY - p.unrealizedPnl / C_SIZE;
  const out = V.tpslOutcome(px, b);
  assert.ok(Math.abs(out.pnlUsdc - p.unrealizedPnl) < 1e-9);
  assert.ok(Math.abs(out.roePct - p.returnOnEquity * 100) < 1e-6, `${out.roePct} vs ${p.returnOnEquity * 100}`);
});

test("V2) TP +25% ROE on the short: the trigger is the entry moved 25/36 of a percent down, on BTC's $1 tick, and it says what it makes", () => {
  need();
  const v = leg("tp", "roe", "+25");
  assert.equal(v.error, null);
  assert.equal(v.px, 85521, "86,118.9 x (1 - 0.25/36) = 85,520.84, nearest tick");
  assert.equal(v.triggerText, "$85,521");
  assert.equal(v.ifHitText, "if hit: +106.49 USDC (+25.0%)");
  assert.equal(v.tone, "pos");
  assert.equal(leg("tp", "roe", "25").px, 85521, "no sign on a TP means a gain");
  assert.equal(leg("tp", "roe", "+25%").px, 85521, "the % sign is allowed");
});

test("V3) TP +50 USDC on the short: entry - 50 / size, on the tick; the if-hit line is the rounded trigger's own figure", () => {
  need();
  const v = leg("tp", "usdc", "+50");
  assert.equal(v.px, 85838, "86,118.9 - 50 / 0.17811 = 85,838.17");
  assert.equal(v.ifHitText, "if hit: +50.03 USDC (+11.7%)");
  assert.equal(leg("tp", "usdc", "50 USDC").px, 85838);
  assert.equal(leg("tp", "usdc", "1,000").px, V.tpslLegView({ leg: "tp", mode: "usdc", str: "1000", basis: cBasis() }).px, "a thousands comma is read");
});

test("V4) 🔴 SL -20 USDC: the stop is rounded TOWARD the entry, so the loss never exceeds what was accepted", () => {
  need();
  const v = leg("sl", "usdc", "-20");
  assert.equal(v.error, null);
  assert.equal(v.px, 86231, "86,118.9 + 20 / 0.17811 = 86,231.19, rounded down (toward the entry) for a short");
  assert.equal(v.ifHitText, "if hit: -19.97 USDC (-4.7%)");
  assert.equal(v.tone, "neg");
  assert.ok(-V.tpslOutcome(v.px, cBasis()).pnlUsdc <= 20);
  assert.equal(leg("sl", "usdc", "20").px, 86231, "a SL amount without a sign is the loss accepted");
  assert.equal(leg("sl", "usdc", "−20").px, 86231, "the typographic minus is read");
  /* A long: toward the entry is UP. */
  const long = V.tpslBasisFromQuote({ ok: true, size: 0.01, refPx: 85731 }, { side: "buy", leverage: 5, szDecimals: 5, markPx: 85711 });
  const s = V.tpslLegView({ leg: "sl", mode: "usdc", str: "-20", basis: long });
  assert.equal(s.px, 83731, "85,731 - 20 / 0.01 = 83,731 exactly");
  const s2 = V.tpslLegView({ leg: "sl", mode: "usdc", str: "-20.5", basis: long });
  assert.equal(s2.px, 83681, "85,731 - 2,050 = 83,681");
  const s3 = V.tpslLegView({ leg: "sl", mode: "usdc", str: "-20.555", basis: long });
  assert.equal(s3.px, 83676, "83,675.5 rounds UP (toward the entry) on a long");
});

test("V5) 🔴 SL -50% ROE sits inside the liquidation price; -100% is past it and is refused in plain words", () => {
  need();
  const half = leg("sl", "roe", "-50");
  assert.equal(half.error, null);
  assert.equal(half.px, 87314, "86,118.9 x (1 + 0.5/36) = 87,314.996, rounded down (toward the entry)");
  assert.equal(half.ifHitText, "if hit: -212.86 USDC (-50.0%)", "a hair under the 50% asked for, never over");
  const all = leg("sl", "roe", "-100");
  assert.ok(all.error, "refused");
  assert.match(all.error, /liquidat/i);
  assert.match(all.error, /\$87,383/, "names the liquidation price");
  const past = leg("sl", "price", "88000");
  assert.match(past.error, /liquidat/i, "a typed price past liquidation too");
  const usdc = leg("sl", "usdc", "-500");
  assert.match(usdc.error, /liquidat/i, "500 USDC is past the 426 USDC margin");
});

test("V6) the wrong sign is refused with what to type instead: a TP is a gain, a SL in USDC or % is a loss", () => {
  need();
  assert.match(leg("tp", "usdc", "-50").error, /take profit is a gain/i);
  assert.match(leg("tp", "roe", "-10").error, /take profit is a gain/i);
  assert.match(leg("sl", "usdc", "+20").error, /stop loss is a loss/i);
  assert.match(leg("sl", "roe", "+10").error, /stop loss is a loss/i);
  assert.match(leg("tp", "usdc", "0").error, /more than 0/i);
  assert.match(leg("tp", "usdc", "abc").error, /enter/i);
  assert.equal(leg("tp", "usdc", "").empty, true);
  assert.equal(leg("tp", "usdc", "").error, null, "empty is not an error");
});

test("V7) price mode: Hyperliquid's mark rule first (would trigger at once), then a TP must be a profit against the entry", () => {
  need();
  const b = cBasis({ markPx: 86000 });
  assert.match(leg("tp", "price", "90000", b).error, /Take-profit must be below the current price/, "the exchange layer's own words");
  /* Mark far below the entry: a TP above the entry but below the mark would be a LOSS. */
  const low = cBasis({ markPx: 90000 });
  const loss = leg("tp", "price", "88000", low);
  assert.match(loss.error, /profit/i);
  assert.match(loss.error, /below your entry/i);
  const ok = leg("tp", "price", "80000", b);
  assert.equal(ok.error, null);
  assert.equal(ok.ifHitText, "if hit: +1,089.84 USDC (+255.8%)");
  assert.match(leg("sl", "price", "85000", b).error, /Stop-loss must be above the current price/);
});

test("V8) the tick is Hyperliquid's (roundHlOrderPx): 5 significant figures, at most 6 - szDecimals decimals", () => {
  need();
  const d = markets.byCoin.DYDX;
  const b = V.tpslBasisFromQuote({ ok: true, size: 1000, refPx: 0.13803 }, { side: "buy", leverage: 10, szDecimals: d.szDecimals, markPx: 0.13803 });
  const v = V.tpslLegView({ leg: "tp", mode: "roe", str: "+25", basis: b });
  assert.equal(v.px, 0.14148, "0.13803 x 1.025 = 0.14148075 -> 5 decimals");
  assert.equal(v.triggerText, "$0.14148");
});

test("V9) the chips: TP +10 +25 +50 +100 and SL -10 -25 -50, all ROE", () => {
  need();
  assert.deepEqual([...V.TP_ROE_CHIPS], [10, 25, 50, 100]);
  assert.deepEqual([...V.SL_ROE_CHIPS], [10, 25, 50]);
  assert.deepEqual(V.TPSL_MODES.map((m) => m.key), ["price", "usdc", "roe"]);
  assert.deepEqual(V.TPSL_MODES.map((m) => m.label), ["Price", "P/L (USDC)", "% (ROE)"]);
  assert.equal(V.tpslChipText("tp", 25), "+25%");
  assert.equal(V.tpslChipText("sl", 25), "-25%");
});

test("V10) 🔴 switching modes keeps the level: a converted value is pinned to the exact trigger it came from", () => {
  need();
  const b = cBasis();
  const asRoe = V.tpslInputFor({ leg: "sl", mode: "roe", px: 86423, basis: b });
  assert.equal(asRoe, "-12.71");
  const asUsdc = V.tpslInputFor({ leg: "sl", mode: "usdc", px: 86423, basis: b });
  assert.equal(asUsdc, "-54.16");
  assert.equal(V.tpslInputFor({ leg: "sl", mode: "price", px: 86423, basis: b }), "86423");
  /* Re-read without the pin, the rounding toward the entry would move the stop a tick. */
  const pinned = V.tpslLegView({ leg: "sl", mode: "roe", str: asRoe, basis: b, pinPx: 86423 });
  assert.equal(pinned.px, 86423, "the pin is the level");
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.ifHitText, "if hit: -54.16 USDC (-12.7%)");
});

test("V10a) 🔴 A PIN IS CHECKED LIKE A TYPED LEVEL: a stop pinned before the leverage moved is refused once liquidation reaches it first", () => {
  need();
  /* A long at $100, 50 USDC of margin at 2x: liquidation near $50, so a stop
     at $75 is fine. The user switches modes (the leg is now PINNED at 75) and
     then drags the leverage to 20x, which brings liquidation up to about $95.
     The pin is now past it — and it was still being offered, and sent. */
  const at = (lev) => V.tpslBasisFromQuote(
    { ok: true, size: (50 * lev) / 100, refPx: 100, liqPx: 100 * (1 - 1 / lev) },
    { side: "buy", leverage: lev, szDecimals: 2, markPx: 100, liqPx: 100 * (1 - 1 / lev) },
  );
  const low = V.tpslLegView({ leg: "sl", mode: "price", str: "75", basis: at(2), pinPx: 75 });
  assert.equal(low.error, null, "at 2x the stop is inside the liquidation price");
  assert.equal(low.ok, true);
  const high = V.tpslLegView({ leg: "sl", mode: "price", str: "75", basis: at(20), pinPx: 75 });
  assert.match(high.error || "", /liquidat/i, "a pinned stop past liquidation must say so");
  assert.equal(high.ok, false, "and must not be offered or sent");
  /* The same for the mark rule and for a TP that is no longer a profit. */
  const wrongSide = V.tpslLegView({ leg: "tp", mode: "price", str: "90", basis: at(2), pinPx: 90 });
  assert.ok(wrongSide.error, "a pinned TP below the mark on a long fires the moment it is placed");
  assert.equal(wrongSide.ok, false);
});

test("V10b) 🔴 a pinned level with a blank field is still the level, never 'the user cleared it'", () => {
  need();
  /* tpslInputFor answers "" whenever the mode cannot word the level — ROE with
     no leverage on the basis, say. The leg is then { str: "", pin: 86423 },
     and reading that as empty is how the TP/SL sheet would CANCEL a trigger
     the user never touched. */
  const noLev = { ...cBasis(), leverage: null, marginUsdc: null };
  assert.equal(V.tpslInputFor({ leg: "sl", mode: "roe", px: 86423, basis: noLev }), "", "the mode cannot word it");
  const v = V.tpslLegView({ leg: "sl", mode: "roe", str: "", basis: noLev, pinPx: 86423 });
  assert.equal(v.empty, false, "a pinned leg is not an empty one");
  assert.equal(v.px, 86423);
  assert.equal(v.pinned, true);
  /* No pin and no text really is empty. */
  assert.equal(V.tpslLegView({ leg: "sl", mode: "roe", str: "", basis: noLev, pinPx: null }).empty, true);
});

test("V11) the position card's row: SL $a (-Y%) and TP $b (+Z%) from the open orders and Hyperliquid's entry and leverage", () => {
  need();
  const orders = AP.parseOpenOrders(F.C.frontendOpenOrders);
  const t = V.tpslView({ answered: true, list: orders, tpslByCoin: AP.tpslByCoin(orders) }, "BTC", { szDecimals: 5, position: cPosition() });
  assert.equal(t.slText, "$86,423");
  assert.equal(t.slPctText, "(-12.7%)");
  assert.equal(t.tpText, "None");
  assert.equal(t.tpPctText, "");
  const noPos = V.tpslView({ answered: true, list: orders, tpslByCoin: AP.tpslByCoin(orders) }, "BTC", { szDecimals: 5 });
  assert.equal(noPos.slPctText, "", "no basis, no percentage (never a guessed one)");
});

test("V12) the risk line carries the ROE of the max loss: all of an isolated margin is -100%; cross claims none", () => {
  need();
  const market = { ...markets.byCoin.BTC };
  const r = V.riskView({ side: "buy", marginUsdc: 50, leverage: 10, market, feeRate: 0.00045, balanceSource: "perp", notionalUsd: 500 });
  assert.equal(r.maxLossText, "50.00 USDC");
  assert.equal(r.maxLossPctText, "(-100%)");
  const cross = V.riskView({ side: "buy", marginUsdc: 50, leverage: 10, market, feeRate: 0.00045, balanceSource: "perp", notionalUsd: 500, marginMode: "cross" });
  assert.equal(cross.maxLossPctText, "");
  const none = V.riskView({ side: "buy", marginUsdc: null, leverage: 10, market, feeRate: 0.00045, balanceSource: "perp", notionalUsd: null });
  assert.equal(none.maxLossPctText, "");
});

test("V13) a new order's basis is the ticket's own quote: the expected fill, the size it would send, the chosen leverage", () => {
  need();
  const b = V.tpslBasisFromQuote({ ok: true, size: 125 / 85731, refPx: 85731 }, { side: "buy", leverage: 5, szDecimals: 5, markPx: 85711, liqPx: 69000 });
  assert.equal(b.side, "long");
  assert.equal(b.entryPx, 85731);
  assert.ok(Math.abs(b.marginUsdc - 25) < 1e-9);
  assert.equal(b.liqPx, 69000);
  assert.equal(b.liqEstimate, true);
  assert.equal(V.tpslBasisFromQuote({ ok: false }, { side: "buy", leverage: 5, szDecimals: 5 }), null);
  assert.equal(V.tpslBasisFromQuote(null, { side: "buy", leverage: 5, szDecimals: 5 }), null);
  const tp = V.tpslLegView({ leg: "tp", mode: "roe", str: "+100", basis: b });
  assert.equal(tp.px, 102877);
  assert.equal(tp.ifHitText, "if hit: +25.00 USDC (+100.0%)");
  const noBasis = V.tpslLegView({ leg: "tp", mode: "roe", str: "+100", basis: null });
  assert.match(noBasis.error, /amount first/i);
  const priceNoBasis = V.tpslLegView({ leg: "tp", mode: "price", str: "95000", basis: null });
  assert.equal(priceNoBasis.error, null, "a typed price needs no basis");
  assert.equal(priceNoBasis.px, 95000);
  assert.equal(priceNoBasis.ifHitText, "", "but no figure is claimed without one");
});

/* ════════════════════════════════════════════════════════════════════════════
   U. the screens
   ════════════════════════════════════════════════════════════════════════════ */

function account() {
  const ch = AP.parseClearinghouse(F.C.clearinghouseState);
  const orders = AP.parseOpenOrders(F.C.frontendOpenOrders);
  return {
    address: USER, ready: true,
    perpBalanceUsdc: BAL.resolvePerpBalance({ role: "user", mode: "disabled", perp: ch, spot: AP.parseSpotState({ balances: [] }) }),
    positions: { answered: true, list: ch.positions, byCoin: AP.positionsByCoin(ch.positions), complete: true },
    orders: { answered: true, list: orders, tpslByCoin: AP.tpslByCoin(orders) },
    fills: { answered: true, list: [], byCoin: { BTC: [] }, partial: false },
    mode: { value: "disabled", source: "perp", answered: true }, events: [], ledger: { answered: true, list: [], inbound: [] },
  };
}

function fakeBackend() {
  const calls = [];
  const rec = (name, answer) => (...a) => { calls.push([name, ...a]); return Promise.resolve(typeof answer === "function" ? answer(...a) : answer); };
  return {
    kind: "live", mock: false, address: USER, connected: true, walletType: "metamask",
    support: { ok: true }, account: account(), trading: { enabled: true, state: "active", validUntil: 1, reason: null },
    builder: { enabled: false, invalid: false, reason: "unset" }, feeRate: 0.00045,
    openMarket: rec("openMarket", (a) => ({ ok: true, coin: a.coin, side: a.side, status: "filled", filled: { totalSz: "0.00145", avgPx: "85731.0", oid: 1 }, partial: false, size: "0.00145", leverage: a.leverage, tpsl: { tp: "placed", sl: "placed" } })),
    setTpSl: rec("setTpSl", (coin) => ({ ok: true, coin, placed: { tp: { triggerPx: "85521" } }, cancelled: [], cancelFailed: [], failedLegs: {} })),
    quoteOpen: (a) => {
      if (!(a.marginUsdc > 0)) return { ok: false, code: "bad_input", message: "Enter an amount in USDC." };
      const n = a.marginUsdc * a.leverage;
      return { ok: true, size: n / 85731, sizeStr: String(n / 85731), notionalUsd: n, valueUsdc: n, refPx: 85731, feeUsdc: n * 0.00045 };
    },
    quoteAdd: () => ({ ok: false, code: "bad_input", message: "x" }),
    calls,
  };
}

function impl() {
  globalThis.__impl = {
    useImagesReady: () => true,
    useIsMobile: () => true,
    usePerpTradeLimits: () => ({ answered: true, availableUsdc: 400, maxMarginUsdc: 399 }),
  };
}

async function load(entry, files) {
  const stubs = autoStubs(files, { keep: [...PURE_KEEP, BITS, SLIDE] });
  return bundle({ entry, env: { VITE_PERP_ENABLED: "1" }, stubs });
}
async function render(M, props) {
  const h = M.mount(() => M.default(props));
  h.render(); h.flush();
  await wait(0); h.flush();
  return h;
}
const T = (tree, M) => squash(textOf(tree, M.mount));
const input = (tree, M, label) => all(tree, M.mount).find((e) => e.type === "input" && e.props["aria-label"] === label);
const modeBtn = (tree, M, label) => all(tree, M.mount).find((e) => e.type === "button" && e.props["data-test"] === "tpsl-mode" && squash(textOf(e, M.mount)) === label);
const chip = (tree, M, l, text) => all(tree, M.mount).find((e) => e.type === "button" && e.props["data-test"] === `tpsl-chip-${l}` && squash(textOf(e, M.mount)) === text);
const slideOf = (tree, M) => all(tree, M.mount).find((e) => e.props && e.props.role === "slider" && e.props["data-test"] === "slide");
const pressEnd = (el) => {
  el.props.onKeyDown({ key: "End", preventDefault() {} });
  el.props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
};

async function sheet() {
  need();
  fakeBrowser();
  impl();
  const M = await load(TPSL, [TPSL, BITS, SLIDE]);
  const backend = fakeBackend();
  const h = await render(M, { open: true, onClose() {}, backend, position: backend.account.positions.byCoin.BTC, market: { ...markets.byCoin.BTC, markPx: 86000 }, coin: "BTC" });
  return { M, h, backend };
}

async function ticket() {
  need();
  fakeBrowser();
  impl();
  const M = await load(TICKET, [TICKET, BITS, SLIDE]);
  const backend = fakeBackend();
  const h = await render(M, { backend, market: { ...markets.byCoin.BTC, stale: false }, coin: "BTC", mode: "open", initialSide: "buy", stale: false, onDone() {}, onNeed() {} });
  return { M, h, backend };
}
const preset = (tree, M, label) => all(tree, M.mount).find((e) => e.type === "button" && e.props["data-test"] === "preset" && squash(textOf(e, M.mount)) === label);
