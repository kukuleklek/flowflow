// Turns a plain sentence into an intent WITHOUT the LLM (SPEC §2.4): if the free model is rate limited during the
// demo, "long ETH 20 5x tp 10% sl 5%" still produces a trade card. Thai and English. Pure, unit-testable.
//
// Returns one of:
//   { kind: "open", coin, side: "buy"|"sell", marginUsdc|null, leverage|null, tpPct|null, slPct|null, tpPx?, slPx?, noTpSl? }
//   { kind: "tpsl", coin, tpPct|null, slPct|null, tpPx?, slPx? }
//   { kind: "close", coin|null, fraction }
//   { kind: "movers" } | { kind: "account" } | null
// A TP / SL the user typed is read in its common phrasings ("sl 8", "stop loss to 8%", "a stop loss of 8%",
// "take profit at 30%", "sl $2300", "ตั้ง SL ETH 2300"), so it is never replaced by the app's recommended one. "no tp sl" /
// "without stop loss" sets noTpSl: then nothing is recommended onto the card.
// The leverage reads "5x", "x5", "lev 5", "เลเวอเรจ 5" and the Thai "5 เท่า" (voice input in Thai says it this way).
// A sentence about setups ("Long setups for ETH") is not a shortcut: intents.js answers it.

const SIDE_BUY = /(^|\s)(long|buy|ลอง|ลองก์|ซื้อ|เปิดลอง)(?=\s|$)/i;
const SIDE_SELL = /(^|\s)(short|sell|ชอร์ต|ช็อต|ชอต|ขาย|เปิดชอร์ต)(?=\s|$)/i;
/* Thai runs words together ("ปิดครึ่งนึง"), so ปิด needs no space after it; but เปิด (OPEN) contains ปิด, so a
   ปิด right after เ is not a close. */
const CLOSE = /(^|\s)close(?=\s|$)|(^|[^เ])ปิด/i;
/* 🔴 ปิด that is about the MARKET's hours, not a position: "เทรดตอนตลาดปิดได้ไหม" is a question, never a close card
   (eval B-Q2 got "No open US 100 position to close."). Taken out before CLOSE is read (no lookbehind: Safari < 16.4). */
const MARKET_SHUT = /ตลาด\s*(?:หุ้น\s*)?(?:us\s*|อเมริกา\s*)?ปิด|ปิด\s*ตลาด|(?:ตอน|เวลา|วัน|ช่วง)\s*(?:ที่\s*)?ปิด/gi;
/** The sentence without its market-hours ปิด (a question about when a market is shut is not a close). */
export const withoutMarketShut = (text) => String(text == null ? "" : text).replace(MARKET_SHUT, " ");

/* "tp 25", "take profit at 30%", "stop loss to 8%", "a stop loss of 8%", "sl: 5", "sl $2300", "คัท 5". The words between
   the leg and its number are the few English / Thai fillers people type; the sign is optional. Groups: 1 "$", 2 the
   number, 3 "%". */
const FILL = String.raw`(?:\s*(?:to|at|of|is|for|@|=|:|เป็น|ที่))*`;
const NUM = String.raw`(\$\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(%)?`;
const TP_WORD = String.raw`(?:tp|take[\s-]*profit|ทีพี)`;
const SL_WORD = String.raw`(?:sl|stop(?:[\s-]*loss)?|สต็อป|คัท)`;
const TP_RE = new RegExp(String.raw`${TP_WORD}${FILL}\s*\+?\s*${NUM}`, "i");
const SL_RE = new RegExp(String.raw`${SL_WORD}${FILL}\s*-?\s*${NUM}`, "i");
/** "no tp sl", "without stop loss", "no tp", "ไม่ต้องตั้ง sl": the user wants no TP / SL on the card. */
export const NO_TPSL_RE = /(?:\b(?:no|without|w\/o|skip|minus)\s+(?:a\s+|any\s+)?(?:tp\s*\/?\s*sl|tpsl|tp|sl|stops?(?:[\s-]*loss(?:es)?)?|take[\s-]*profits?|targets?)\b)|ไม่(?:ต้อง|เอา|ใส่|ตั้ง)+\s*(?:tp|sl|สต็อป|stop)/i;

/** Without a live price to compare with, a TP / SL number this big with no "%" is a PRICE ("tp 90000 sl 80000" on
 *  BTC), never a 90000% ROE (EXECUTION-ASSURANCE K5). */
export const LEG_PRICE_MIN = 1000;
/** With the live price: a bare number within this band of it is a price (riskParse.planInput's own rule). */
export const LEG_PRICE_BAND = Object.freeze([0.5, 1.5]);

/* One typed leg: a percent ("8%"), a price ("$2300"), or a bare number decided against the live price.
   🔴 "sl 85" on HYPE at $92.86 is the PRICE $85 (a fixed 1000 cut-off read it as −85% ROE: a stop at $53, −$17 at the
   stop instead of −$3.4). In the band but on the losing side ("short LINK tp 20" with LINK at 15) a number of 100 or
   less stays a percent: a price there could never be that leg. */
function legOf(m, which, refPx, side) {
  if (!m) return { pct: null, px: null, read: null };
  const n = num(m[2]);
  if (n == null) return { pct: null, px: null, read: null };
  if (m[3]) return { pct: n, px: null, read: "pct" };
  if (m[1]) return { pct: null, px: n, read: "px" };
  if (typeof refPx === "number" && Number.isFinite(refPx) && refPx > 0) {
    const inBand = n >= LEG_PRICE_BAND[0] * refPx && n <= LEG_PRICE_BAND[1] * refPx;
    if (!inBand) return { pct: n, px: null, read: "pct" };
    const right = side !== "buy" && side !== "sell" ? true : (which === "tp") === (side === "buy") ? n > refPx : n < refPx;
    if (!right && n <= 100) return { pct: n, px: null, read: "pct" };
    return { pct: null, px: n, read: "px-bare" };
  }
  return n >= LEG_PRICE_MIN ? { pct: null, px: n, read: "px" } : { pct: n, px: null, read: "pct" };
}

/** The TP / SL a sentence states (either may be null), and whether it says "no TP / SL" (then nothing is recommended;
 *  a leg typed beside it, "sl 5 no tp", is still the user's). `rest`: the text without the "no …".
 *  A leg written as a price comes back as tpPx / slPx instead of a percent: a "$" before it, or a bare number in
 *  LEG_PRICE_BAND of `refPx` (the live price, when the caller has it), else one of at least LEG_PRICE_MIN.
 *  tpRead / slRead: "pct" | "px" | "px-bare" (a bare number read as a price: the caller says so in its line).
 * @param {string} text
 * @param {{ refPx?: number|null, side?: "buy"|"sell"|null }} [o] side: the trade's (or the held position's) side */
export function parseTpSl(text, { refPx = null, side = null } = {}) {
  const low = ` ${String(text || "").toLowerCase()} `;
  const no = NO_TPSL_RE.test(low);
  const rest = no ? low.replace(new RegExp(NO_TPSL_RE.source, "gi"), " ") : low;
  const tp = TP_RE.exec(rest);
  const sl = SL_RE.exec(rest);
  const t = legOf(tp, "tp", refPx, side);
  const s = legOf(sl, "sl", refPx, side);
  return {
    tpPct: t.pct, slPct: s.pct, tpPx: t.px, slPx: s.px, tpRead: t.read, slRead: s.read,
    noTpSl: no, tpMatch: tp, slMatch: sl, rest,
  };
}

const num = (s) => {
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** The market a sentence names, from the live list (case-insensitive, k-prefixed names included). */
export function findCoin(text, coins) {
  const words = String(text).toUpperCase().replace(/[^A-Z0-9\s:-]/g, " ").split(/\s+/).filter(Boolean);
  const byUpper = new Map(coins.map((c) => [String(c).toUpperCase(), c]));
  for (const w of words) {
    if (byUpper.has(w)) return byUpper.get(w);
    if (byUpper.has(`K${w}`)) return byUpper.get(`K${w}`);
  }
  return null;
}

/**
 * @param {string} text
 * @param {string[]} coins the live market names (findCoin)
 * @param {{ refPxOf?: (coin: string) => number|null, sideOf?: (coin: string) => "buy"|"sell"|null }} [o]
 *   refPxOf: the market's live price, so a bare TP / SL number is read as a price or a percent against it (parseTpSl);
 *   sideOf: the held position's side, for a TP / SL with no side in the sentence ("sl 85 HYPE")
 */
export function parseShortcut(text, coins = [], { refPxOf = null, sideOf = null } = {}) {
  const t = ` ${String(text || "").trim()} `;
  if (!t.trim()) return null;
  const low = t.toLowerCase();
  const closing = CLOSE.test(withoutMarketShut(t));

  /* "Long setups for ETH", "any setups?", "แผนเทรด": the Agent's setups (intents.js), not an order with no margin. */
  if (/\bsetups?\b|\bset-ups?\b|แผนเทรด|จุดเข้า|เซ็ตอัพ|เซตอัพ/i.test(low)) return null;
  /* "Analyze ZEC 3x short" (a setup box's or trade card's Analyze pill, analyze.js analyzePrompt): the analysis
     (intents.js), not a short with no margin. */
  if (/\banaly[sz]/i.test(low) || /วิเคราะห์/.test(low)) return null;
  if (/(top\s*movers?|movers|วิ่งแรง|ตัวไหนวิ่ง|ขึ้นแรง|ลงแรง|แรงสุด)/i.test(low)) return { kind: "movers" };
  if (/(my\s*pnl|pnl|p&l|my\s*positions?|positions?|พอร์ต|กำไร|ขาดทุน|โพสิชั่น|โพซิชั่น)/i.test(low) && !SIDE_BUY.test(t) && !SIDE_SELL.test(t) && !closing) {
    return { kind: "account" };
  }

  const coin = findCoin(t, coins);

  if (closing) {
    let fraction = 1;
    if (/(half|ครึ่ง)/i.test(low)) fraction = 0.5;
    else if (/(quarter|หนึ่งในสี่)/i.test(low)) fraction = 0.25;
    else {
      const p = /(\d{1,3})\s*%/.exec(low);
      if (p) {
        const v = num(p[1]) / 100;
        fraction = v >= 0.75 ? (v >= 1 ? 1 : 0.75) : v >= 0.5 ? 0.5 : 0.25;
      }
    }
    return { kind: "close", coin, fraction };
  }

  const side = SIDE_BUY.test(t) ? "buy" : SIDE_SELL.test(t) ? "sell" : null;
  /* "ตั้ง SL ETH 2300", "set sl for ETH at 2300": the market's name between the leg and its number is taken out first. */
  const esc = (w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = coin ? [...new Set([coin, String(coin).replace(/^k(?=[A-Z])/, "")])].map(esc).join("|") : null;
  const legText = names
    ? low.replace(new RegExp(String.raw`(${TP_WORD}|${SL_WORD})(\s+(?:for|on|of|ของ)?\s*)(?:${names})(?=\s)`, "gi"), "$1 ")
    : low;
  let refPx = null;
  let legSide = side;
  if (coin) {
    try { refPx = typeof refPxOf === "function" ? refPxOf(coin) : null; } catch { refPx = null; }
    if (!legSide) { try { legSide = typeof sideOf === "function" ? sideOf(coin) : null; } catch { legSide = null; } }
  }
  const legs = parseTpSl(legText, { refPx, side: legSide });
  const tp = legs.tpMatch;
  const sl = legs.slMatch;
  /* A leg typed as a price rides as tpPx / slPx (only when there is one: the usual shape is unchanged), and a bare
     number that was READ as a price says so (respond.js prints it, so the reading is never silent). */
  const pxLegs = {
    ...(legs.tpPx != null ? { tpPx: legs.tpPx } : {}), ...(legs.slPx != null ? { slPx: legs.slPx } : {}),
    ...(legs.tpRead === "px-bare" || legs.slRead === "px-bare" ? { pxRead: true } : {}),
  };

  /* "tp 25 sl 10 ETH" with no side: a TP / SL on the open position. */
  if (!side && coin && (tp || sl)) return { kind: "tpsl", coin, tpPct: legs.tpPct, slPct: legs.slPct, ...pxLegs };
  if (!side || !coin) return null;
  /* "5x" (a number, then x, then not a digit: "12.5 x10" is a margin and an x10), "x10" / "lev 10", or the Thai
     "3 เท่า" (🔴 left unread it went out at the default 5x, and "ลอง ETH 10 เท่า 20 ดอล" read 10 as the margin). */
  const lev = /(\d+(?:\.\d+)?)\s*x(?![a-z0-9])/i.exec(low) || /(\d+(?:\.\d+)?)\s*เท่า(?!ไห|ไร|กับ|นั้น|ตัว)/.exec(low) || /(?:\bx|lev(?:erage)?|เลเวอเรจ)\s*(\d+(?:\.\d+)?)/i.exec(low);

  /* The margin: the first number that is not the leverage, a TP or an SL. */
  let rest = legs.rest;
  for (const m of [tp, sl, lev]) if (m) rest = rest.replace(m[0], " ");
  const leverage = lev ? num(lev[1]) : null;
  /* 🔴 THE NUMBER'S MEANING IS NEVER GUESSED INTO MARGIN (EXECUTION-ASSURANCE K5):
       "long ETH 100 dollar position 10x"  a $100 POSITION: margin = 100 ÷ 10 (never 100 USDC × 10x = $1,000)
       "long 0.5 ETH 5x"                   a SIZE in the coin: sizeCoin 0.5, priced by the caller (respond.js) */
  const notional = /\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:usdc|usd|\$|dollars?|bucks?|ดอล(?:ล่า)?)?\s*(?:worth\s+(?:of\s+)?)?(?:position|notional|exposure|size)\b|\b(?:position|notional|size)\s+(?:of\s+)?\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i.exec(rest);
  const coinWord = String(coin).replace(/^k(?=[A-Z])/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /* A thousand-unit market (kPEPE) is left out: "1000 PEPE" and "1 kPEPE" are one size, and the words cannot say which. */
  const sized = /^k[A-Z]/.test(String(coin)) ? null : new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d+)?)\s*${coinWord}(?=\s|$)`, "i").exec(rest);
  if (notional) {
    const n = num(notional[1] || notional[2]);
    return {
      kind: "open", coin, side, notionalUsd: n,
      marginUsdc: n != null && leverage != null && leverage >= 1 ? Math.round((n / leverage) * 100) / 100 : null,
      leverage, tpPct: legs.tpPct, slPct: legs.slPct, ...pxLegs, ...(legs.noTpSl ? { noTpSl: true } : {}),
    };
  }
  if (sized) {
    return {
      kind: "open", coin, side, sizeCoin: num(sized[1]), marginUsdc: null,
      leverage, tpPct: legs.tpPct, slPct: legs.slPct, ...pxLegs, ...(legs.noTpSl ? { noTpSl: true } : {}),
    };
  }
  const amt = /\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:usdc|usd|\$|ดอล(?:ล่า)?|เหรียญ)?/i.exec(rest.replace(/[a-z]+\d+|\d+[a-z]{2,}/gi, " "));

  return {
    kind: "open",
    coin,
    side,
    marginUsdc: amt ? num(amt[1]) : null,
    leverage,
    tpPct: legs.tpPct,
    slPct: legs.slPct,
    ...pxLegs,
    ...(legs.noTpSl ? { noTpSl: true } : {}),
  };
}
