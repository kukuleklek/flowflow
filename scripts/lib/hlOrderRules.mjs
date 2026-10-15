/**
 * hlOrderRules — Hyperliquid's order rules, written out a SECOND time.
 * ════════════════════════════════════════════════════════════════════════════
 * The execution-assurance suites (scripts/test-exec-golden.mjs and
 * scripts/exec-live-sweep.mjs) check every action the app builds against these.
 * They are deliberately NOT imported from src/lib/hyperliquid/exchange/orders.js:
 * a rule checked by the code that applies it proves nothing. Every rule below is
 * restated from Hyperliquid's own docs and kept on plain strings:
 *
 *   asset ids        docs, for-developers/api/asset-ids: main perp = its index in
 *                    meta.universe (0..9999); HIP-3 perp = 100000 + perpDexIndex x
 *                    10000 + its index in THAT dex's universe
 *   tick and lot     docs, tick-and-lot-size: a size has at most szDecimals
 *                    decimals; a perp price has at most 5 significant figures and
 *                    at most 6 - szDecimals decimals, and an integer price is
 *                    always allowed
 *   wire form        the SDKs' float_to_wire: a normalised decimal string, no
 *                    exponent, no trailing zeros, no trailing dot (the signed hash
 *                    is over the exact string)
 *   minimum          "Order must have minimum value of $10." (error-responses)
 *   market order     an IOC limit moved off the mid by the slippage, on the side
 *                    that crosses the book (a buy above, a sell below)
 *   TP / SL          market trigger orders, reduce-only, on the closing side; the
 *                    TP on the winning side of the mark, the SL on the losing side
 *
 * Pure: strings and numbers in, a list of problems out ([] when the order is fine).
 */

export const HIP3_BASE = 100_000;
export const HIP3_STRIDE = 10_000;
export const MAIN_MAX = 10_000;
export const MIN_ORDER_USD = 10;
export const PERP_MAX_DECIMALS = 6;
export const PRICE_SIG_FIGS = 5;
/** Hyperliquid's own slippage tolerance on a market trigger; an IOC further than this is not a "market" order. */
export const MAX_SLIPPAGE = 0.1;

const CANON = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;

/** A canonical wire decimal ("2879", "0.0365"): no sign, no exponent, no trailing zero. */
export const isWireDecimal = (s) => typeof s === "string" && CANON.test(s);

/** Decimals of a wire decimal string. */
export const decimalsOf = (s) => (s.includes(".") ? s.length - s.indexOf(".") - 1 : 0);

/** Significant figures of a wire decimal string (leading zeros never count; an integer's trailing zeros do not either). */
export function sigFigsOf(s) {
  const digits = s.replace(".", "").replace(/^0+/, "");
  if (!s.includes(".")) return digits.replace(/0+$/, "").length || 1;
  return digits.length || 1;
}

/** The expected asset id of a market, from the dex order and its universe position. */
export function expectedAssetId({ dexIndex = 0, index }) {
  if (!Number.isInteger(index) || index < 0) return null;
  return dexIndex ? HIP3_BASE + dexIndex * HIP3_STRIDE + index : index;
}

/** Problems with a price string on a perp of this szDecimals ([] when valid). */
export function priceProblems(px, szDecimals, what = "price") {
  if (!isWireDecimal(px)) return [`${what} ${JSON.stringify(px)} is not a canonical decimal string`];
  if (!(Number(px) > 0)) return [`${what} ${px} is not positive`];
  if (!px.includes(".")) return [];
  const out = [];
  if (sigFigsOf(px) > PRICE_SIG_FIGS) out.push(`${what} ${px} has ${sigFigsOf(px)} significant figures (max ${PRICE_SIG_FIGS})`);
  const maxDec = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  if (decimalsOf(px) > maxDec) out.push(`${what} ${px} has ${decimalsOf(px)} decimals (max ${maxDec} at szDecimals ${szDecimals})`);
  return out;
}

/** Problems with a size string ([] when valid). */
export function sizeProblems(sz, szDecimals) {
  if (!isWireDecimal(sz)) return [`size ${JSON.stringify(sz)} is not a canonical decimal string`];
  if (!(Number(sz) > 0)) return [`size ${sz} is not positive`];
  if (decimalsOf(sz) > szDecimals) return [`size ${sz} has ${decimalsOf(sz)} decimals (lot is ${szDecimals})`];
  return [];
}

/**
 * Problems with one order wire {a, b, p, s, r, t, c?}.
 * @param {object} w the wire
 * @param {{ assetId: number, szDecimals: number, mid: number, mark?: number,
 *   kind: "open"|"close"|"tp"|"sl", isLong?: boolean, maxSlippage?: number }} m
 *   kind "open": an IOC that opens or adds (isBuy = the position side);
 *   "close": a reduce-only IOC; "tp" / "sl": a trigger of a position whose side is isLong
 */
export function orderProblems(w, { assetId, szDecimals, mid, mark = mid, kind, isLong = null, maxSlippage = MAX_SLIPPAGE }) {
  const out = [];
  if (!w || typeof w !== "object") return ["no order"];
  const keys = Object.keys(w);
  const want = w.c === undefined ? ["a", "b", "p", "s", "r", "t"] : ["a", "b", "p", "s", "r", "t", "c"];
  if (keys.join() !== want.join()) out.push(`wire keys ${keys.join(",")} (signed hash wants ${want.join(",")})`);
  if (w.a !== assetId) out.push(`asset id ${w.a}, expected ${assetId}`);
  out.push(...sizeProblems(w.s, szDecimals));
  out.push(...priceProblems(w.p, szDecimals, "limit price"));
  if (w.c !== undefined && !/^0x[0-9a-f]{32}$/.test(w.c)) out.push(`cloid ${w.c} is not 0x + 32 lowercase hex`);
  const px = Number(w.p);
  if (kind === "open" || kind === "close") {
    if (!w.t || !w.t.limit || w.t.limit.tif !== "Ioc") out.push(`not an IOC limit: ${JSON.stringify(w.t)}`);
    if (kind === "open" && w.r !== false) out.push("an opening order is reduce-only");
    if (kind === "close" && w.r !== true) out.push("a close is not reduce-only");
    /* Crossing the book: a buy above the mid, a sell below, by at most the tolerance. */
    if (w.b === true && !(px > mid)) out.push(`buy IOC at ${w.p} does not cross the mid ${mid}`);
    if (w.b === false && !(px < mid)) out.push(`sell IOC at ${w.p} does not cross the mid ${mid}`);
    const slip = Math.abs(px - mid) / mid;
    if (slip > maxSlippage + 1e-9) out.push(`IOC ${w.p} is ${(slip * 100).toFixed(2)}% off the mid (max ${maxSlippage * 100}%)`);
    if (kind === "close" && isLong != null && w.b !== !isLong) out.push(`a close of a ${isLong ? "long" : "short"} must ${isLong ? "sell" : "buy"}`);
    if (kind === "open" && isLong != null && w.b !== isLong) out.push(`an open of a ${isLong ? "long" : "short"} must ${isLong ? "buy" : "sell"}`);
    if (kind === "open") {
      const value = Number(w.s) * Math.min(mid, px);
      if (value < MIN_ORDER_USD) out.push(`order value $${value.toFixed(4)} under the $${MIN_ORDER_USD} minimum`);
    }
  } else if (kind === "tp" || kind === "sl") {
    const tr = w.t && w.t.trigger;
    if (!tr) out.push(`not a trigger: ${JSON.stringify(w.t)}`);
    else {
      if (Object.keys(tr).join() !== "isMarket,triggerPx,tpsl") out.push(`trigger keys ${Object.keys(tr).join(",")}`);
      if (tr.isMarket !== true) out.push("TP / SL is not a market trigger");
      if (tr.tpsl !== kind) out.push(`trigger tpsl ${tr.tpsl}, expected ${kind}`);
      out.push(...priceProblems(tr.triggerPx, szDecimals, "trigger price"));
      if (tr.triggerPx !== w.p) out.push(`trigger price ${tr.triggerPx} differs from the order price ${w.p}`);
      const t = Number(tr.triggerPx);
      if (isLong != null) {
        const winning = isLong ? t > mark : t < mark;
        const losing = isLong ? t < mark : t > mark;
        if (kind === "tp" && !winning) out.push(`TP ${tr.triggerPx} is not on the winning side of the mark ${mark}`);
        if (kind === "sl" && !losing) out.push(`SL ${tr.triggerPx} is not on the losing side of the mark ${mark}`);
      }
    }
    if (w.r !== true) out.push(`${kind.toUpperCase()} is not reduce-only`);
    if (isLong != null && w.b !== !isLong) out.push(`${kind.toUpperCase()} is on the opening side`);
  }
  return out;
}

/** Problems with an updateLeverage action. */
export function leverageProblems(action, { assetId, maxLeverage, cap = Infinity, isolated = true }) {
  const out = [];
  if (!action || action.type !== "updateLeverage") return [`not an updateLeverage: ${JSON.stringify(action)}`];
  if (Object.keys(action).join() !== "type,asset,isCross,leverage") out.push(`updateLeverage keys ${Object.keys(action).join(",")}`);
  if (action.asset !== assetId) out.push(`updateLeverage asset ${action.asset}, expected ${assetId}`);
  if (isolated && action.isCross !== false) out.push("updateLeverage is cross; FlowFlow opens isolated");
  if (!Number.isInteger(action.leverage) || action.leverage < 1) out.push(`leverage ${action.leverage} is not a whole number from 1`);
  if (action.leverage > maxLeverage) out.push(`leverage ${action.leverage}x over the market max ${maxLeverage}x`);
  if (action.leverage > cap) out.push(`leverage ${action.leverage}x over FlowFlow's cap ${cap}x`);
  return out;
}
