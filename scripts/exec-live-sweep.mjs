#!/usr/bin/env node
/**
 * exec-live-sweep — EVERY LISTED MARKET, LIVE, THROUGH THE ORDER BUILDERS. READ-ONLY.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "อยากให้ Ensure ว่า Agent เรา Excute Positon ถูกต้องทุกรูปแบบเลยไหม
 * ทั้งหุ้น เทรด" (EXECUTION-ASSURANCE.md item 2).
 *
 * Reads Hyperliquid's PUBLIC /info only (perpDexs, metaAndAssetCtxs for the main
 * dex and xyz, perpsAtOpenInterestCap), then for EVERY listed market — each
 * main-dex perp the Perps list shows, and each whitelisted stock — builds what a
 * tap would build, on both sides, at the live mid:
 *
 *   the $11 order        orders.js planOpenMarket at the Agent's leverage (min(10, max))
 *                        with a TP / SL given as PRICES (3% / 1.5% off the mid)
 *   the card's TP / SL   the ROE path the trade card takes (quoteOpenLive →
 *                        tpslBasisFromQuote → tpslLegView), 3% / 1.5% of price as ROE
 *   a half close         planCloseFraction on that position
 *   the cap order        20 USDC at that leverage: how much margin the ROUNDED size really uses
 *   a stock's top-up     venueOrderCollateral vs the margin the rounded order needs
 *
 * and checks each against scripts/lib/hlOrderRules.mjs (Hyperliquid's rules
 * restated, not imported): asset id from the LIVE dex order, tick / lot /
 * decimals, the $10 minimum, IOC side and slippage, trigger shape and side,
 * leverage within the market's max, isolated. A market that would be REJECTED
 * is listed with why.
 *
 * 🔴 NOTHING SIGNS, NOTHING SENDS. No trader is created, no key is loaded, and
 * global fetch is wrapped so that ONLY a POST to Hyperliquid's /info with a
 * read type on the list below can leave this process (anything else throws).
 *
 * Writes <scratchpad>/pass2/exec-sweep.json (or the path given as --out).
 * Run: node scripts/exec-live-sweep.mjs [--out path]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  orderProblems, leverageProblems, expectedAssetId, MIN_ORDER_USD,
} from "./lib/hlOrderRules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = (f) => pathToFileURL(path.join(ROOT, "src", f)).href;
const INFO_URL = "https://api.hyperliquid.xyz/info";
const READ_TYPES = new Set(["perpDexs", "metaAndAssetCtxs", "perpsAtOpenInterestCap"]);

const argOut = process.argv.indexOf("--out");
const OUT = argOut > 0 ? process.argv[argOut + 1]
  : path.join(os.tmpdir(), "exec-sweep.json");

/* ── the read-only fence ── */
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  let body = null;
  try { body = JSON.parse(init.body); } catch { /* not ours */ }
  if (u !== INFO_URL || (init.method || "GET").toUpperCase() !== "POST" || !body || !READ_TYPES.has(body.type)) {
    throw new Error(`exec-live-sweep is read-only: refused ${init.method || "GET"} ${u} ${init.body || ""}`);
  }
  asked.push(body);
  return realFetch(url, init);
};

const { createHlInfo } = await import(SRC("lib/hyperliquid/info.js"));
const { parsePerpMarkets } = await import(SRC("lib/hyperliquid/markets.js"));
const { parsePerpDexs } = await import(SRC("lib/hyperliquid/venues.js"));
const O = await import(SRC("lib/hyperliquid/exchange/orders.js"));
const VC = await import(SRC("lib/hyperliquid/exchange/venueCollateral.js"));
const PB = await import(SRC("perp/live/perpBackend.js"));
const LV = await import(SRC("perp/live/perpLiveView.js"));
const GR = await import(SRC("perp/guardrails.js"));
const { mainMarkets, stockMarkets } = await import(SRC("trade/marketLists.js"));
const { STOCK_WHITELIST } = await import(SRC("lib/hyperliquid/hip3/whitelist.js"));
const { checkStockOrder } = await import(SRC("lib/hyperliquid/hip3/guard.js"));
const { usEquitySession } = await import(SRC("lib/hyperliquid/hip3/hours.js"));

const info = createHlInfo({ url: INFO_URL, timeoutMs: 15_000 });
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const FEE = 0.00045; // perp/mock/fees.js HL_TAKER_FEE_RATE, builder off
const NOTIONAL = 11;
const now = Date.now();

/* ── read ── */
const dexsJson = await info({ type: "perpDexs" });
const dexs = parsePerpDexs(dexsJson);
const xyz = dexs.byName.get("xyz");
if (!xyz) throw new Error("xyz is not in the live perpDexs answer");
const [mainJson, xyzJson, capMain, capXyz] = await Promise.all([
  info({ type: "metaAndAssetCtxs" }),
  info({ type: "metaAndAssetCtxs", dex: "xyz" }),
  info({ type: "perpsAtOpenInterestCap" }).catch(() => null),
  info({ type: "perpsAtOpenInterestCap", dex: "xyz" }).catch(() => null),
]);
const main = parsePerpMarkets(mainJson, { now });
const stocks = parsePerpMarkets(xyzJson, { now, dex: "xyz", dexIndex: xyz.index, venueName: "xyz", venueCategory: "stock" });
const atCap = new Set([...(Array.isArray(capMain) ? capMain : []), ...(Array.isArray(capXyz) ? capXyz : [])]);
const all = [...main.markets, ...stocks.markets];
const listedStocks = new Set(stockMarkets(all).map((m) => m.coin));
const whitelist = new Set(STOCK_WHITELIST.map((w) => w.coin));
const session = usEquitySession(now);

/* The universe index each row came from, read straight off the live answers (not from the row). */
const uniIndex = (json, coin) => (Array.isArray(json) && json[0] && Array.isArray(json[0].universe) ? json[0].universe.findIndex((u) => u && u.name === coin) : -1);

/* ── build and check one market ── */
function sweepMarket(m) {
  const isStock = !!m.isHip3;
  const dexIndex = isStock ? xyz.index : 0;
  const index = uniIndex(isStock ? xyzJson : mainJson, m.coin);
  const assetId = expectedAssetId({ dexIndex, index });
  const mid = fin(m.midPx) ? m.midPx : null;
  const ref = mid ?? m.markPx;
  const mark = fin(m.markPx) ? m.markPx : ref;
  const out = { coin: m.coin, assetId: m.assetIndex, expectedAssetId: assetId, szDecimals: m.szDecimals, maxLeverage: m.maxLeverage, mid, mark, rejected: [], flags: [], sides: {} };
  if (m.assetIndex !== assetId) out.rejected.push(`asset id ${m.assetIndex} ≠ live ${assetId}`);
  if (!isStock && !(m.assetIndex >= 0 && m.assetIndex < 10_000)) out.rejected.push(`main asset id ${m.assetIndex} out of range`);
  if (mid == null) out.flags.push("no mid (empty book): priced on the mark");
  if (atCap.has(m.coin)) out.rejected.push("at its open-interest cap: Hyperliquid refuses opening orders");
  if (ref == null || ref <= 0) { out.rejected.push("no price"); return out; }

  /* The Agent's leverage on this market; a stock also answers to the closed-market cap. */
  let lev = Math.max(1, Math.min(GR.AGENT_MAX_LEVERAGE, Math.floor(m.maxLeverage)));
  if (isStock) {
    const g = checkStockOrder({ row: m, side: "long", marginUsdc: NOTIONAL / lev, leverage: lev, by: "agent", now, listed: listedStocks.has(m.coin) });
    if (fin(g.maxLeverage)) lev = Math.min(lev, g.maxLeverage);
    out.stockGuard = { maxLeverage: g.maxLeverage, refusals: g.refusals.filter((r) => r !== "leverage_cap"), warnings: g.warnings, session: g.session, priceSource: g.priceSource, listed: listedStocks.has(m.coin) };
  }
  out.agentLeverage = lev;
  const row = { ...m, stale: false };
  const feeRate = LV.perpMarketFeeRate(m, FEE);

  for (const side of ["buy", "sell"]) {
    const isLong = side === "buy";
    const s = { problems: [] };
    out.sides[isLong ? "long" : "short"] = s;
    /* 1. the $11 order with TP / SL as prices */
    const tp = ref * (isLong ? 1.03 : 0.97);
    const sl = ref * (isLong ? 0.985 : 1.015);
    const plan = O.planOpenMarket({ market: row, side, marginUsdc: NOTIONAL / lev, leverage: lev, tp, sl });
    if (!plan.ok) {
      s.planRefused = { code: plan.code, message: plan.message };
      if (plan.code === "min_value") {
        const lot = 10 ** -m.szDecimals;
        const worst = Math.min(ref, ref * (isLong ? 1.05 : 0.95));
        const lots = Math.ceil(MIN_ORDER_USD / (lot * worst) + 1e-9);
        s.smallestOrderUsd = +(lots * lot * ref).toFixed(2);
        s.fitsCaps = s.smallestOrderUsd <= GR.MAX_MARGIN_USDC * lev;
      }
      out.rejected.push(`${isLong ? "long" : "short"} $${NOTIONAL}: ${plan.code}${s.smallestOrderUsd ? ` (smallest order ≈ $${s.smallestOrderUsd}${s.fitsCaps ? "" : ", OVER the 20 USDC caps"})` : ""}`);
    } else {
      s.size = plan.size;
      s.limitPx = plan.limitPx;
      s.slippagePct = +((Math.abs(Number(plan.limitPx) - ref) / ref) * 100).toFixed(3);
      s.valueUsd = +(Number(plan.size) * ref).toFixed(4);
      s.tpPx = plan.tpPx;
      s.slPx = plan.slPx;
      s.problems.push(...leverageProblems(plan.leverageAction, { assetId, maxLeverage: m.maxLeverage, cap: GR.AGENT_MAX_LEVERAGE }));
      plan.action.orders.forEach((w, i) => {
        const kind = w.t.trigger ? w.t.trigger.tpsl : "open";
        s.problems.push(...orderProblems(w, { assetId, szDecimals: m.szDecimals, mid: ref, mark, kind, isLong }).map((p) => `#${i} ${p}`));
      });
      if (plan.action.grouping !== "normalTpsl") s.problems.push(`grouping ${plan.action.grouping}`);
      if (s.slippagePct < 1) out.flags.push(`${isLong ? "long" : "short"} IOC only ${s.slippagePct}% off the mid after rounding`);
    }

    /* 2. the card's ROE path: 3% / 1.5% of price as ROE at this leverage */
    const q = PB.quoteOpenLive({ market: row, side, marginUsdc: NOTIONAL / lev, leverage: lev, feeRate });
    if (q.ok) {
      const risk = LV.riskView({ side, marginUsdc: NOTIONAL / lev, leverage: lev, market: row, feeRate, balanceSource: "perp", notionalUsd: q.notionalUsd, marginMode: "isolated" });
      const basis = LV.tpslBasisFromQuote(q, { side, leverage: lev, szDecimals: m.szDecimals, markPx: mark, liqPx: risk.liqPx });
      const tpV = LV.tpslLegView({ leg: "tp", mode: "roe", str: `+${+(3 * lev).toFixed(2)}`, basis });
      const slV = LV.tpslLegView({ leg: "sl", mode: "roe", str: `-${+(1.5 * lev).toFixed(2)}`, basis });
      s.cardTp = tpV.ok ? tpV.px : `refused: ${tpV.error}`;
      s.cardSl = slV.ok ? slV.px : `refused: ${slV.error}`;
      if (!tpV.ok || !slV.ok) s.problems.push(`card TP / SL refused: ${tpV.error || ""} ${slV.error || ""}`.trim());
      else {
        const p2 = O.planOpenMarket({ market: row, side, marginUsdc: NOTIONAL / lev, leverage: lev, tp: tpV.px, sl: slV.px });
        if (!p2.ok) s.problems.push(`card legs refused by the planner: ${p2.code}`);
        else {
          for (const [i, w] of p2.action.orders.entries()) {
            if (!w.t.trigger) continue;
            s.problems.push(...orderProblems(w, { assetId, szDecimals: m.szDecimals, mid: ref, mark, kind: w.t.trigger.tpsl, isLong }).map((p) => `card #${i} ${p}`));
          }
          /* A stop rounds TOWARD the entry: never a bigger loss than the one asked. */
          const want = ref * (isLong ? 1 - 0.015 : 1 + 0.015);
          if (isLong ? slV.px < want - 1e-12 : slV.px > want + 1e-12) s.problems.push(`card SL ${slV.px} rounded AWAY from the entry (asked ${want})`);
        }
      }
    }

    /* 3. a half close of that position */
    if (plan.ok) {
      const pos = { szi: (isLong ? 1 : -1) * Number(plan.size), leverage: { type: "isolated", value: lev } };
      const half = O.planCloseFraction({ market: row, position: pos, fraction: 0.5 });
      if (!half.ok) out.flags.push(`${isLong ? "long" : "short"} $${NOTIONAL}: half close ${half.code} (one lot)`);
      else {
        s.halfClose = half.size;
        s.problems.push(...orderProblems(half.action.orders[0], { assetId, szDecimals: m.szDecimals, mid: ref, mark, kind: "close", isLong }).map((p) => `half close ${p}`));
        if (Number(half.size) > Number(plan.size) / 2 + 1e-12) s.problems.push(`half close ${half.size} is MORE than half of ${plan.size}`);
      }
      const all = O.planCloseFraction({ market: row, position: pos, fraction: 1 });
      if (!all.ok || all.size !== plan.size) s.problems.push(`full close size ${all.size} ≠ position ${plan.size}`);
    }

    /* 4. the cap order: 20 USDC at this leverage */
    const capPlan = O.planOpenMarket({ market: row, side, marginUsdc: GR.MAX_MARGIN_USDC, leverage: lev });
    if (capPlan.ok) {
      const used = (Number(capPlan.size) * ref) / lev;
      s.capMarginUsed = +used.toFixed(6);
      if (used > GR.MAX_MARGIN_USDC + 1e-9) out.flags.push(`${isLong ? "long" : "short"} 20 USDC ${lev}x → ${capPlan.size} uses ${used.toFixed(4)} USDC of margin (size rounded UP past the cap)`);
      /* 5. a stock's top-up vs what the rounded order margins */
      if (isStock) {
        const need = VC.venueOrderCollateral({ marginUsdc: GR.MAX_MARGIN_USDC, leverage: lev, feeRate });
        const moved = Number(VC.ceilCollateralAmount(need));
        const atMid = used + Number(capPlan.size) * ref * (feeRate || 0);
        const atLimit = (Number(capPlan.size) * Number(capPlan.limitPx)) / lev + Number(capPlan.size) * Number(capPlan.limitPx) * (feeRate || 0);
        s.topUp = { moved, needAtMid: +atMid.toFixed(6), needAtLimit: +atLimit.toFixed(6) };
        if (moved + 1e-9 < atMid) out.flags.push(`${isLong ? "long" : "short"} 20 USDC ${lev}x: top-up ${moved} < ${atMid.toFixed(4)} the rounded order margins at the mid (empty stock account → "Insufficient margin")`);
      }
    }
    if (s.problems.length) out.rejected.push(...s.problems.map((p) => `${isLong ? "long" : "short"}: ${p}`));
  }

  /* 6. A stock from an EMPTY stock account, over the cards the Agent makes (10–20 USDC, 1x to its leverage): how
     often is the exact top-up short of what the rounded order margins — at the mid, and at the IOC's own limit price
     (which one Hyperliquid checks is not documented; both are counted). */
  if (isStock) {
    let total = 0;
    let shortMid = 0;
    let shortLimit = 0;
    let example = null;
    for (const margin of [10, 12, 15, 20]) {
      for (let l = 1; l <= lev; l++) {
        const p = O.planOpenMarket({ market: row, side: "buy", marginUsdc: margin, leverage: l });
        if (!p.ok) continue;
        total++;
        const moved = Number(VC.ceilCollateralAmount(VC.venueOrderCollateral({ marginUsdc: margin, leverage: l, feeRate })));
        const fee = (px) => Number(p.size) * px * (feeRate || 0);
        const atMid = (Number(p.size) * ref) / l + fee(ref);
        const atLimit = (Number(p.size) * Number(p.limitPx)) / l + fee(Number(p.limitPx));
        if (moved + 1e-9 < atMid) { shortMid++; if (!example) example = `${margin} USDC ${l}x → ${p.size} needs ${atMid.toFixed(4)}, moves ${moved}`; }
        if (moved + 1e-9 < atLimit) shortLimit++;
      }
    }
    out.emptyAccountTopUp = { cards: total, shortAtMid: shortMid, shortAtLimit: shortLimit, example };
  }
  return out;
}

/* ── run ── */
const crypto = mainMarkets(main.markets);
const stockRows = stocks.markets.filter((m) => whitelist.has(m.coin));
const missingStocks = [...whitelist].filter((c) => !stocks.byCoin[c]);
const results = [...crypto, ...stockRows].map(sweepMarket);
const rejected = results.filter((r) => r.rejected.length);
const flagged = results.filter((r) => r.flags.length);
const overCap = results.filter((r) => r.flags.some((f) => /past the cap/.test(f)));
const topUpShort = results.filter((r) => r.flags.some((f) => /top-up/.test(f)));
const minOnly = rejected.filter((r) => r.rejected.every((x) => /min_value/.test(x)));
const realRejects = rejected.filter((r) => !r.rejected.every((x) => /min_value/.test(x)));

const summary = {
  capturedAt: new Date(now).toISOString(),
  usSession: session.session,
  xyzDexIndex: xyz.index,
  perpDexCount: dexs.count,
  marketsChecked: results.length,
  crypto: crypto.length,
  stocks: stockRows.length,
  stocksListedNow: stockRows.filter((m) => listedStocks.has(m.coin)).length,
  whitelistedNotLive: missingStocks,
  atOpenInterestCap: [...atCap].filter((c) => results.some((r) => r.coin === c)),
  wouldBeRejected: realRejects.map((r) => ({ coin: r.coin, why: r.rejected })),
  elevenDollarsUnderMinimum: minOnly.map((r) => ({ coin: r.coin, why: r.rejected })),
  sizeRoundedPastCap: overCap.length,
  sizeRoundedPastCapWorst: overCap
    .map((r) => ({ coin: r.coin, marginUsed: Math.max(r.sides.long.capMarginUsed || 0, r.sides.short.capMarginUsed || 0), leverage: r.agentLeverage }))
    .sort((a, b) => b.marginUsed - a.marginUsed).slice(0, 10),
  stockTopUpShort: topUpShort.map((r) => ({ coin: r.coin, long: r.sides.long.topUp, leverage: r.agentLeverage })),
  stockEmptyAccountCards: results.filter((r) => r.emptyAccountTopUp).reduce((a, r) => ({
    cards: a.cards + r.emptyAccountTopUp.cards,
    shortAtMid: a.shortAtMid + r.emptyAccountTopUp.shortAtMid,
    shortAtLimit: a.shortAtLimit + r.emptyAccountTopUp.shortAtLimit,
    examples: r.emptyAccountTopUp.example && a.examples.length < 5 ? [...a.examples, `${r.coin} ${r.emptyAccountTopUp.example}`] : a.examples,
  }), { cards: 0, shortAtMid: 0, shortAtLimit: 0, examples: [] }),
  thinIocSlippage: flagged.filter((r) => r.flags.some((f) => /IOC only/.test(f))).map((r) => r.coin),
  readsMade: asked.map((b) => `${b.type}${b.dex ? `:${b.dex}` : ""}`),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ summary, markets: results }, null, 1));

console.log(`exec-live-sweep ${summary.capturedAt} (US session: ${summary.usSession}; xyz dex index ${summary.xyzDexIndex} of ${summary.perpDexCount})`);
console.log(`checked ${summary.marketsChecked} markets: ${summary.crypto} crypto, ${summary.stocks} whitelisted stocks (${summary.stocksListedNow} pass the Stock list's gate now)`);
if (missingStocks.length) console.log(`whitelisted but not live: ${missingStocks.join(", ")}`);
console.log(`would be REJECTED (rules / ids / cap): ${realRejects.length}`);
for (const r of realRejects) console.log(`  ${r.coin}: ${r.rejected.join(" | ")}`);
console.log(`$11 is under the minimum after lot rounding: ${minOnly.length}${minOnly.length ? ` (${minOnly.map((r) => r.coin).join(", ")})` : ""}`);
console.log(`20 USDC at the Agent's leverage rounds PAST the cap: ${overCap.length} markets; worst ${summary.sizeRoundedPastCapWorst.slice(0, 5).map((w) => `${w.coin} ${w.marginUsed.toFixed(4)}`).join(", ")}`);
console.log(`stock top-up short of the rounded order (empty stock account): ${topUpShort.length}${topUpShort.length ? ` (${topUpShort.map((r) => r.coin).join(", ")})` : ""}`);
const ea = summary.stockEmptyAccountCards;
console.log(`stock cards from an EMPTY stock account (10–20 USDC, 1x..cap): ${ea.cards}; top-up short at the mid ${ea.shortAtMid} (${ea.cards ? Math.round((ea.shortAtMid / ea.cards) * 100) : 0}%), at the IOC limit ${ea.shortAtLimit} (${ea.cards ? Math.round((ea.shortAtLimit / ea.cards) * 100) : 0}%)${ea.examples.length ? `; e.g. ${ea.examples.slice(0, 2).join("; ")}` : ""}`);
console.log(`reads: ${summary.readsMade.join(", ")} — nothing signed, nothing sent`);
console.log(`wrote ${OUT}`);
