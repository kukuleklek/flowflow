// A TP / SL the user typed as a PRICE, in the words the trade card and the TP / SL editor take (ROE %), so the leg they
// price lands on EXACTLY that tick. PURE.
//
// 🔴 WHY: the card and the position's TP / SL editor price a leg from an ROE string (useOrderQuote / TpSlEditor, mode
// "roe": entry × (1 ± ROE ÷ (100 × leverage)), then the tick, a stop rounded toward the entry). "ตั้ง SL ETH 2300" turned
// into a 1-decimal ROE came back as a stop at $2,300.1 or $2,299.9; "sl $85" on HYPE moved with the entry. Here the
// shortest ROE string (2 decimals first) whose priced leg rounds to the typed price's own tick is chosen; the editor
// shows that string and sends that tick. A price that no string reaches (never seen: the search goes to 6 decimals)
// gives null, and the caller falls back to its rounded ROE.
import { planOrderPx } from "./planTicks.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/* The tick rounding the editor applies: a stop rounds TOWARD the entry (never a bigger loss than accepted). */
const modeOf = (leg, long) => (leg !== "sl" ? "nearest" : long ? "up" : "down");

/**
 * @param {{ leg: "tp"|"sl", px: number, side: "buy"|"sell"|"long"|"short", entryPx: number, leverage: number,
 *   szDecimals: number }} o entryPx: the price the leg is priced from (the card's quote, the position's entry)
 * @returns {{ str: string, roePct: number, px: number } | null} str: "+12.34" for a TP, "-4.21" for an SL
 */
export function legStrForPx({ leg, px, side, entryPx, leverage, szDecimals } = {}) {
  if ((leg !== "tp" && leg !== "sl") || !fin(px) || px <= 0 || !fin(entryPx) || entryPx <= 0 || !fin(leverage) || leverage <= 0) return null;
  if (!Number.isInteger(szDecimals)) return null;
  const long = side === "buy" || side === "long";
  const dir = long ? 1 : -1;
  const want = leg === "tp" ? 1 : -1;
  const mode = modeOf(leg, long);
  const target = Number(planOrderPx(px, szDecimals, mode));
  if (!(target > 0)) return null;
  /* The leg must be a gain (TP) or a loss (SL) from this entry: the wrong side has no ROE string. */
  const v = (target / entryPx - 1) * 100 * dir * leverage * want;
  if (!(v > 0)) return null;
  const priced = (roe) => Number(planOrderPx(entryPx * (1 + (want * roe) / (100 * dir * leverage)), szDecimals, mode));
  for (let d = 2; d <= 6; d += 1) {
    const step = 10 ** -d;
    const base = Math.round(v / step);
    for (const k of [base, base - 1, base + 1, base - 2, base + 2]) {
      const roe = Number((k * step).toFixed(d));
      if (!(roe > 0)) continue;
      if (priced(roe) === target) return { str: `${leg === "tp" ? "+" : "-"}${roe.toFixed(d).replace(/0+$/, "").replace(/\.$/, "")}`, roePct: roe, px: target };
    }
  }
  return null;
}

