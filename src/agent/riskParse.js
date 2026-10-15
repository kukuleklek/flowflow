// WHAT THE USER SAID ABOUT RISK, WITHOUT THE LLM (owner items 13, 14, 16): one normal chat, any phrasing, typed or by
// voice, Thai or English, and ANY amount ("ดอลเดียวก็ควรได้ปะ จะอะไรก็ได้อะ"). This file turns the words into the inputs
// tradePlan.js plans from; it reads no market data and does no money maths.
//
//   "มี 300 ยอมเสียได้ 15 ดอล เล่น RR ตั้ง TP SL เท่าไหร่ดี Short กับเหรียญ SOL"
//       → { mode: "plan", coin: "SOL", side: "sell", balanceUsd: 300, riskUsd: 15, rrAsked: true }
//   "risk $1 long ETH", "ยอมเสีย 1 ดอล", "ยอมเสียดอลเดียว"   → riskUsd 1
//   "เสียได้ 3%", "risk 1% of my 300"                         → riskPct (and the balance it is of)
//   "มี 50 เสียได้ 2"                                         → balance 50, risk $2 (a bare number is dollars)
//   "short SOL RR 3", "1:2", "2R"                            → rr
//   "tp sl เท่าไหร่ดี ETH"                                     → mode "setups" (no budget: the recommended setups answer)
//   "เซฟๆ"                                                    → style "safer" (wider stop, ≤ 3x, 1% when only a balance is given)
//
// MODES. "plan": a risk or a budget was stated, so the order is sized from it (tradePlan.planTrade). "setups": the user
// asks for levels but states no budget, so the Safer / Balanced / Bolder setups answer (setups.js). null: not a planning
// sentence; the other parsers (shortcuts.js, intents.js) or the model take it.
//
// ONE QUESTION, NEVER A REFUSAL (owner item 14). When something the plan cannot do without is missing, `ask` names the
// ONE thing to ask ("ยอมเสียได้กี่ดอล?"), and answerAsk() folds the reply into the pending parse. A missing side is
// not asked here: the plan leans with the 1h trend and says so; it asks only when the chart has no direction.
//
// 🔴 A NUMBER IS NEVER GUESSED INTO A DIFFERENT MEANING. A stop or TP number with no % and no $ is ambiguous (a price,
// or a percent?); it stays raw (stopNum / tpNum) until planInput() reads it against the live price. A stop in a plan
// sentence is a PRICE distance, not ROE: the leverage is what the plan computes, so an ROE stop would mean nothing.
// "sl 5" in a plain trade sentence ("long ETH 20 5x sl 5") stays ROE: that sentence is not a plan (no risk words) and
// shortcuts.js keeps it.
import { resolveStock, findStockInText } from "../lib/hyperliquid/hip3/names.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const TH = /[฀-๿]/;
export const langOf = (text) => (TH.test(String(text || "")) ? "th" : "en");

/** The share of the balance a plan risks when only a balance was given (style safe or not). */
export const DEFAULT_RISK_PCT = 1;

/* ── normalising numbers ─────────────────────────────────────────────────────────────────────────────────────── */

const UNIT_WORDS = String.raw`ดอลลาร์|ดอลล่าร์|ดอลล่า|ดอลล์|ดอล|เหรียญ|เปอร์เซ็นต์|เปอร์เซนต์|เปอร์|เท่า|usdc|usd|dollars?|bucks?|percent|%|\$`;
const TH_DIGIT = { ศูนย์: 0, หนึ่ง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };
const TH_MUL = { สิบ: 10, ร้อย: 100, พัน: 1000, หมื่น: 10_000, แสน: 100_000 };
const TH_TOKEN = new RegExp(Object.keys({ ...TH_DIGIT, ...TH_MUL }).sort((a, b) => b.length - a.length).join("|"), "g");
/* Thai number words count ONLY right before a unit ("สิบห้าดอล", "สามเท่า"): "ห้า" alone is also the start of "ห้าม". */
const TH_NUM_UNIT = new RegExp(String.raw`((?:${Object.keys({ ...TH_DIGIT, ...TH_MUL }).join("|")})+)\s*(${UNIT_WORDS})`, "g");

/** "สิบห้า" → 15, "ยี่สิบ" → 20, "สามร้อย" → 300; null when it is not a number. */
export function thaiNumber(words) {
  const parts = String(words || "").match(TH_TOKEN);
  if (!parts || parts.join("") !== words) return null;
  let total = 0;
  let cur = null;
  for (const p of parts) {
    if (p in TH_DIGIT) {
      if (cur != null) return null;
      cur = TH_DIGIT[p];
    } else {
      total += (cur == null ? 1 : cur) * TH_MUL[p];
      cur = null;
    }
  }
  return total + (cur == null ? 0 : cur);
}

const EN_NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};
const EN_NUM_UNIT = new RegExp(String.raw`(^|[^a-z])(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|(?:a|one)\s+hundred|hundred)\s+(dollars?|bucks?|percent|usdc|usd)(?![a-z])`, "gi");

/**
 * The sentence with every amount as digits: Thai digits, "1,000", "1k", "ดอลเดียว", "สิบห้าดอล", "five bucks".
 * Lower-cased. Exported for the tests.
 */
export function normalizeAmounts(text) {
  let s = String(text == null ? "" : text).normalize("NFC");
  s = s.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0E50));
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  s = s.replace(/(ดอลลาร์|ดอลล่าร์|ดอลล่า|ดอล|เหรียญ)\s*เดียว/g, "1 $1");
  s = s.replace(TH_NUM_UNIT, (m, words, unit) => {
    const n = thaiNumber(words);
    return n == null ? m : `${n} ${unit}`;
  });
  s = s.replace(EN_NUM_UNIT, (m, pre, word, unit) => {
    const w = word.toLowerCase().replace(/\s+/g, " ");
    const n = w.endsWith("hundred") ? 100 : EN_NUM[w];
    return n == null ? m : `${pre}${n} ${unit}`;
  });
  /* "1k", "1.5k" (money); never the k of kPEPE. */
  s = s.replace(/(\d+(?:\.\d+)?)\s*k(?![a-z])/gi, (m, n) => String(Math.round(Number(n) * 1000)));
  return s.toLowerCase();
}

/* ── the words ───────────────────────────────────────────────────────────────────────────────────────────────── */

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const CUR = String.raw`(?:\s*(?:usdc|usd|\$|dollars?|bucks?|ดอลลาร์|ดอลล่าร์|ดอลล่า|ดอลล์|ดอล|เหรียญ(?!\s*[a-z])))`;
const PCT = String.raw`(?:\s*(?:%|เปอร์เซ็นต์|เปอร์เซนต์|เปอร์|percent|pct))`;
/* Not a ratio ("risk 1:3"), not a leverage ("10x", "สามเท่า"), not a count ("2 ตัว"). */
const NOT_AFTER = String.raw`(?!\s*(?::|\/|ต่อ)\s*\d)(?!\s*(?:x(?![a-z])|เท่า|ตัว|อัน|ไม้|ครั้ง|วัน|ชั่วโมง|นาที|positions?|โพ))`;
const FILL = String.raw`(?:\s*(?:ได้|ไม่เกิน|สูงสุด|มากสุด|แค่|ประมาณ|ราวๆ|ราว|อยู่|ที่|เป็น|max|at\s+most|up\s+to|about|around|of|is|=|:|~|per\s+trade|ต่อไม้))*\s*`;

/* A bare "เสีย" / "ขาดทุน" / "losing" is news ("ETH เสีย 5% วันนี้", "ETH is losing 5%"), not a budget: those count only
   with a word that makes them one (ยอม…, …ได้, …ไม่เกิน, can / willing to lose, lose at most). */
const TH_CAP = String.raw`(?=\s*(?:ได้|ไม่เกิน|สูงสุด|มากสุด|แค่))`;
const RISK_WORD = String.raw`(?:^|[^a-z])risk(?:ing)?(?![a-z])|max(?:imum)?[\s-]*loss|(?:^|[^a-z])(?:can|could|willing\s+to|ok(?:ay)?\s+(?:to\s+)?|afford\s+to|happy\s+to|fine\s+(?:to\s+)?)\s*los(?:e|ing)(?![a-z])|(?:^|[^a-z])lose(?=\s+(?:at\s+most|up\s+to|max))|ยอม(?:ตัด)?(?:เสีย|ขาดทุน|ลบ|เจ็บ)|ตัดขาดทุนได้|คัท(?:ลอส)?ได้|cut\s*(?:loss)?\s*ได้|ขาดทุน${TH_CAP}|เสีย${TH_CAP}|เจ็บได้|ลบได้|เสี่ยงได้`;
const RISK_RE = new RegExp(String.raw`(?:${RISK_WORD})${FILL}\$?\s*${NUM}(${PCT})?${CUR}?${NOT_AFTER}`, "i");
/* "$5 risk", "2% risk", "1% max loss". */
const RISK_AFTER_RE = new RegExp(String.raw`(?:^|[^\d.])\$?\s*${NUM}(${PCT})?${CUR}?\s*(?:risk|max(?:imum)?[\s-]*loss)(?![a-z])`, "i");
/* A risk asked for with no number: "ยอมเสียได้กี่ดอล", "how much should I risk". */
const RISK_NO_NUM_RE = /ยอม(?:ตัด)?(?:เสีย|ขาดทุน)|เสียได้|ขาดทุนได้|how\s+much\s+(?:should|can|do)\s+i\s+risk|max(?:imum)?[\s-]*loss|risk\s+per\s+trade|(?:can|willing\s+to)\s+lose/i;

/* "3% ของ 300", "1% of my 300". */
const PCT_OF_RE = new RegExp(String.raw`${NUM}${PCT}\s*(?:of\s+(?:my\s+)?(?:account\s+|balance\s+|portfolio\s+|capital\s+)?|ของ\s*(?:เงิน|พอร์ต|ทุน|บัญชี)?\s*(?:ทั้งหมด)?\s*)\$?\s*${NUM}${CUR}?`, "i");

const BAL_WORD = String.raw`(?:^|[^a-z])(?:i\s+have|i'?ve\s+got|i\s+got|have\s+got|balance(?:\s+(?:is|of))?|account(?:\s+(?:is|of|size|balance))?|portfolio(?:\s+(?:is|of))?|capital(?:\s+(?:is|of))?|bankroll|equity)(?![a-z])|มีเงิน|มีทุน|มีพอร์ต|มีตังค์|มีตัง|เงินทุน|เงินในบัญชี|ในบัญชี(?:มี)?|บัญชีมี|เงินมี|พอร์ต(?:มี)?|ทุน|มี`;
const BAL_RE = new RegExp(String.raw`(?:${BAL_WORD})${FILL}\$?\s*${NUM}${CUR}?(?!${PCT})${NOT_AFTER}`, "i");

const MARGIN_WORD = String.raw`(?:^|[^a-z])(?:margin(?:\s+of)?|put\s+in|putting\s+in|use|using)(?![a-z])|มาร์จิ้น|มาร์จิน|ใช้เงิน|ใช้|ลงเงิน|ลงทุน|วางเงิน|วาง|ลง`;
const MARGIN_RE = new RegExp(String.raw`(?:${MARGIN_WORD})${FILL}\$?\s*${NUM}${CUR}?(?!${PCT})${NOT_AFTER}`, "i");

const RR_WORD = String.raw`(?:^|[^a-z])(?:rr|r:r|r\/r|risk[\s-]*(?:to[\s-]*)?reward(?:\s*ratio)?|reward[\s-]*(?:to[\s-]*)?risk)(?![a-z])|อาร์อาร์`;
const RR_RE = new RegExp(String.raw`(?:${RR_WORD})\s*(?:ratio)?\s*(?:of|=|:|is|เป็น|ที่|ประมาณ|สัก|ซัก)?\s*${NUM}(?:\s*(?::|\/|ต่อ|to)\s*${NUM})?`, "i");
const RR_WORD_RE = new RegExp(RR_WORD, "i");
/* A bare ratio ("1:2", "3:1", "1 ต่อ 3"); one side is 1 and the other at most 10, so a time (14:43, 1:30) is not one. */
const RATIO_RE = /(?:^|[^\d.:])(\d+(?:\.\d+)?)\s*(?::|ต่อ)\s*(\d+(?:\.\d+)?)(?![\d.:])/;
/* "2R", "tp 3r". */
const R_MULT_RE = /(?:^|[^\w.])(\d+(?:\.\d+)?)r(?![a-z0-9])/i;

const LEV_RE = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:x(?![a-z0-9])|เท่า)|(?:^|[^a-z])(?:x|lev(?:erage)?|เลเวอเรจ|เลเวอเรท|เลเวอร์เรจ|เลฟ)\s*(\d+(?:\.\d+)?)/i;

const STOP_WORD = String.raw`(?:^|[^a-z])(?:sl|s\/l|stop(?:[\s-]*loss)?)(?![a-z])|สต็อป(?:ลอส)?|สตอป(?:ลอส)?|คัท(?:ลอส)?(?!ได้)|ตัดขาดทุน(?!ได้)|จุดตัด(?:ขาดทุน)?`;
const STOP_RE = new RegExp(String.raw`(?:${STOP_WORD})(?:\s*(?:to|at|of|is|@|=|:|เป็น|ที่|ประมาณ|around|below|above|ใต้|เหนือ))*\s*(\$)?\s*${NUM}(${PCT})?(?!\s*x(?![a-z]))`, "i");
const TP_WORD = String.raw`(?:^|[^a-z])(?:tp|take[\s-]*profit|target)(?![a-z])|ทีพี|เป้า(?:หมาย)?(?:ราคา)?|ขายทำกำไร|จุดทำกำไร|ทำกำไร`;
const TP_RE = new RegExp(String.raw`(?:${TP_WORD})(?:\s*(?:to|at|of|is|@|=|:|เป็น|ที่|ประมาณ|around))*\s*(\$)?\s*${NUM}(${PCT})?(?!\s*x(?![a-z]))`, "i");

/* "TP SL เท่าไหร่ดี", "where should I put my stop", "ตั้ง SL ตรงไหน". */
const LEVELS_Q = /(?:(?:^|[^a-z])(?:tp|sl)(?![a-z])|take[\s-]*profit|stop(?:[\s-]*loss)?|ทีพี|สต็อป|สตอป|จุดตัด|จุดทำกำไร|เป้า)[\s\S]{0,24}?(?:เท่าไหร่|เท่าไร|เท่าไง|ตรงไหน|ที่ไหน|ยังไง|ไหนดี|ดีไหม|ดีมั้ย|(?:^|[^a-z])(?:where|how\s+much|what|which)(?![a-z])|\?)|(?:where|how)\s+(?:should|do|to)\s+(?:i\s+)?(?:put|set|place)\s+(?:my\s+|the\s+|a\s+)?(?:tp|sl|stop|take)|ตั้ง\s*(?:tp|sl|ทีพี|สต็อป)/i;
const PLAN_Q = /คำนวณ|คิดให้|คิดออกมา|ไม้ละ|ขนาดไม้|ขนาดออเดอร์|วางแผน|(?:^|[^a-z])(?:calculate|calc|position\s*siz(?:e|ing))(?![a-z])|how\s+(?:big|much)\s+(?:should|can|do)\s+i\s+(?:buy|long|short|trade|put|go)|plan\s+(?:a|my|the|this)\s+(?:trade|position|entry)/i;
const SAFE_RE = /เซฟ\s*ๆ?|ปลอดภัย|ชัวร์\s*ๆ|เสี่ยงน้อย|ไม่เสี่ยง|(?:^|[^a-z])(?:safe(?:r|ly)?|conservative(?:ly)?|low[\s-]*risk|careful(?:ly)?)(?![a-z])/i;

const SIDE_BUY = /(?:^|[^a-z])(?:long|buy|bull(?:ish)?)(?![a-z])|(?:^|\s)(?:ลอง|ลองก์)(?=\s|$)|เปิดลอง|เล่นขึ้น|ฝั่งขึ้น|ซื้อ/i;
const SIDE_SELL = /(?:^|[^a-z])(?:short|sell|bear(?:ish)?)(?![a-z])|ชอร์ต|ช็อต|ชอต|เปิดชอร์ต|เล่นลง|ฝั่งลง|ขาย(?!ทำกำไร|หมด|ทิ้ง)/i;

/* 🔴 NO LOOKBEHIND IN THIS FILE: Vite's default build target includes Safari 14, and a lookbehind regex throws when
   the module loads on Safari before 16.4 (the whole chat would go with it). A non-letter prefix is matched instead,
   and the few Thai words a lookbehind would have told apart are swapped for one meaning first: "ตัดขาดทุน" (a stop
   level) is "คัทลอส", "ลงทุน" (money put in) is "ลงเงิน", "ไม่มี" (have none) is "ไร้", "ซื้อขาย" (trading) is "เทรด". */
const WORD_SWAPS = [[/ยอมตัดขาดทุน/g, "ยอมขาดทุน"], [/ตัดขาดทุน/g, "คัทลอส"], [/ลงทุน/g, "ลงเงิน"], [/ไม่มี/g, "ไร้"], [/ซื้อขาย/g, "เทรด"]];
const swapWords = (s) => WORD_SWAPS.reduce((acc, [re, to]) => acc.replace(re, to), s);

/* ── the market a sentence names ─────────────────────────────────────────────────────────────────────────────── */

/* Words of a planning sentence that are never a market ("RR", "TP", "risk"). */
const NOT_COIN = new Set(["RR", "R", "TP", "SL", "RISK", "MAX", "LOSS", "STOP", "USD", "USDC", "X", "K", "LONG", "SHORT", "BUY", "SELL", "LEV", "PCT"]);
/* Markets whose ticker is an ordinary word ("not more than $5", "me", "move"): only as written in capitals. */
const COMMON = new Set(["ME", "NOT", "IO", "W", "S", "GAS", "MOVE", "MEME", "ACE", "ALT", "INIT", "PUMP", "MET", "CC", "MON", "AR", "OP", "APE", "SKY", "BABY", "GOAT", "ZEN", "BIO", "NEAR", "ONE", "SAFE", "UP", "GO", "BE", "SO", "ALL", "NEW", "BIG", "HOLD", "REZ", "SAND", "LIT", "MEGA", "STBL"]);
/* Thai names of the most traded coins (voice input writes them out). */
const THAI_COINS = [
  [/บิทคอยน์|บิตคอยน์|บิทคอยน|บิตคอย|บิทคอย/, "BTC"],
  [/อีเธอเรียม|อีเทอเรียม|อีเธอ|อีที(?:เอช)?/, "ETH"],
  [/โซลาน่า|โซลานา|โซล(?!ด)/, "SOL"],
  [/ไฮป์|ไฮพ์/, "HYPE"],
  [/โดจคอยน์|ดอจคอยน์|โดจ|ดอจ/, "DOGE"],
  [/ริปเปิล|เอ็กซ์อาร์พี/, "XRP"],
];

/**
 * The market a planning sentence names: a live crypto market first (case-insensitive, k-prefixed names included;
 * an ordinary-word ticker only in capitals), then a Thai coin name, then a whitelisted stock (hip3/names.js: crypto
 * always wins). Null when it names none.
 * @param {string} text
 * @param {string[]} coins the live main-market names
 * @returns {{ coin: string, kind: "crypto"|"stock" } | null}
 */
export function findPlanCoin(text, coins = []) {
  const orig = String(text || "").normalize("NFC");
  const byUpper = new Map((Array.isArray(coins) ? coins : []).filter((c) => typeof c === "string" && !c.includes(":")).map((c) => [c.toUpperCase(), c]));
  for (const tok of orig.match(/[A-Za-z0-9]+/g) || []) {
    const up = tok.toUpperCase();
    if (NOT_COIN.has(up) || /^\d+(?:[xkr])?$/i.test(tok)) continue;
    if (COMMON.has(up) && tok !== up) continue;
    if (byUpper.has(up)) return { coin: byUpper.get(up), kind: "crypto" };
    if (byUpper.has(`K${up}`)) return { coin: byUpper.get(`K${up}`), kind: "crypto" };
  }
  for (const [re, c] of THAI_COINS) if (re.test(orig) && byUpper.has(c)) return { coin: byUpper.get(c), kind: "crypto" };
  const stock = findStockInText(orig);
  return stock ? { coin: stock, kind: "stock" } : null;
}

/* ── the one question ────────────────────────────────────────────────────────────────────────────────────────── */

/** The one short question per missing essential (owner item 14: ask, never refuse). */
export const ASK = Object.freeze({
  coin: Object.freeze({ field: "coin", en: "Which coin or stock?", th: "เหรียญหรือหุ้นตัวไหน?" }),
  risk: Object.freeze({ field: "risk", en: "How much can you lose on this trade, in $?", th: "ยอมเสียได้กี่ดอล?" }),
  balance: Object.freeze({ field: "balance", en: "How much is in your account, in $?", th: "มีเงินในบัญชีกี่ดอล?" }),
  side: Object.freeze({ field: "side", en: "Long or short?", th: "Long หรือ Short?" }),
});

/** The question for a field in the user's language. */
export const askLine = (field, lang = "en") => (ASK[field] ? ASK[field][lang === "th" ? "th" : "en"] : null);

/* ── parsing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

/* Blank a match out (same length), so one number is never read twice. */
const blank = (s, m) => (m ? s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice(m.index + m[0].length) : s);
const pos = (v) => (fin(v) && v > 0 ? v : null);

/* a:b as a reward multiple: 1:3 → 3, 3:1 → 3 (reward first), 2:5 → 2.5; null when it is not a sane ratio. */
function ratioOf(a, b, { loose = false } = {}) {
  const x = Number(a);
  const y = b == null ? null : Number(b);
  if (y == null) return pos(x) && x <= 20 ? x : null;
  if (!(x > 0) || !(y > 0)) return null;
  if (!loose && x !== 1 && y !== 1) return null;
  const r = x === 1 ? y : y === 1 ? x : y / x;
  return r > 0 && r <= (loose ? 20 : 10) ? Math.round(r * 100) / 100 : null;
}

/**
 * Read a sentence's planning inputs.
 * @param {string} text
 * @param {{ coins?: string[], contextCoin?: string|null }} o coins: the live main-market names; contextCoin: the
 *   market the page or the conversation is on (used when the sentence names none)
 * @returns {{ mode: "plan"|"setups"|null, coin: string|null, coinKind: "crypto"|"stock"|null,
 *   coinFrom: "text"|"context"|null, side: "buy"|"sell"|null, riskUsd: number|null, riskPct: number|null,
 *   balanceUsd: number|null, rr: number|null, rrAsked: boolean, stopPct: number|null, stopPx: number|null,
 *   stopNum: number|null, tpPct: number|null, tpPx: number|null, tpNum: number|null, leverage: number|null,
 *   marginUsd: number|null, style: "safer"|null, levelsAsked: boolean, assumed: string[],
 *   ask: { field: string, en: string, th: string } | null, lang: "en"|"th" }}
 */
export function parseRisk(text, { coins = [], contextCoin = null } = {}) {
  const raw = String(text || "").trim();
  const lang = langOf(raw);
  let s = ` ${swapWords(normalizeAmounts(raw))} `;
  const out = {
    mode: null, coin: null, coinKind: null, coinFrom: null, side: null,
    riskUsd: null, riskPct: null, balanceUsd: null, rr: null, rrAsked: false,
    stopPct: null, stopPx: null, stopNum: null, tpPct: null, tpPx: null, tpNum: null,
    leverage: null, marginUsd: null, style: null, levelsAsked: false, assumed: [], ask: null, lang,
  };
  if (!raw) return out;

  /* The side and the safe words read the whole sentence first ("short" is never a number). */
  out.side = SIDE_SELL.test(s) ? "sell" : SIDE_BUY.test(s) ? "buy" : null;
  if (SIDE_SELL.test(s) && SIDE_BUY.test(s)) {
    /* Both ("ซื้อ … หรือ short?"): the first one written wins. */
    const b = s.search(SIDE_BUY);
    const se = s.search(SIDE_SELL);
    out.side = b < se ? "buy" : "sell";
  }
  if (SAFE_RE.test(s)) out.style = "safer";
  const levelsQ = LEVELS_Q.test(s);
  const planAsked = PLAN_Q.test(s);

  /* 1. The reward multiple, before anything reads "1:3" or "2r" as money. */
  let m = RR_RE.exec(s);
  if (m) {
    out.rr = ratioOf(m[1], m[2], { loose: true });
    s = blank(s, m);
  }
  if (out.rr == null && (m = R_MULT_RE.exec(s))) {
    out.rr = ratioOf(m[1]);
    s = blank(s, m);
  }
  if (out.rr == null && (m = RATIO_RE.exec(s))) {
    const r = /^0\d/.test(m[2]) ? null : ratioOf(m[1], m[2]);
    if (r != null) {
      out.rr = r;
      s = blank(s, m);
    }
  }
  out.rrAsked = out.rr != null || RR_WORD_RE.test(s);

  /* 2. The leverage ("10x", "x5", "สามเท่า"). */
  if ((m = LEV_RE.exec(s))) {
    out.leverage = pos(Number(m[1] || m[2]));
    s = blank(s, m);
  }

  /* 3. "3% of 300": a risk share and the balance it is of. */
  if ((m = PCT_OF_RE.exec(s))) {
    out.riskPct = pos(Number(m[1]));
    out.balanceUsd = pos(Number(m[2]));
    s = blank(s, m);
  }

  /* 4. The stop and the TP, before the risk words (a stop's "คัท 140" is a level, "คัทได้ 15 ดอล" is a risk). */
  if ((m = STOP_RE.exec(s))) {
    const n = Number(m[2]);
    if (m[3]) out.stopPct = pos(n);
    else if (m[1]) out.stopPx = pos(n);
    else out.stopNum = pos(n);
    s = blank(s, m);
  }
  if ((m = TP_RE.exec(s))) {
    const n = Number(m[2]);
    if (m[3]) out.tpPct = pos(n);
    else if (m[1]) out.tpPx = pos(n);
    else out.tpNum = pos(n);
    s = blank(s, m);
  }
  /* A sentence that STATES its levels ("tp 10% sl 5%?") is not asking for them. */
  out.levelsAsked = levelsQ && out.stopPct == null && out.stopPx == null && out.stopNum == null && out.tpPct == null && out.tpPx == null && out.tpNum == null;

  /* 5. The risk: "ยอมเสียได้ 15 ดอล", "risk 2%", "$5 risk". A bare number is dollars (owner: "ดอลเดียวก็ควรได้"). */
  if (out.riskPct == null && ((m = RISK_RE.exec(s)) || (m = RISK_AFTER_RE.exec(s)))) {
    const n = pos(Number(m[1]));
    if (m[2]) out.riskPct = n;
    else out.riskUsd = n;
    s = blank(s, m);
  }

  /* 6. The balance ("มี 300", "I have $500"), then the margin ("ใช้ 10 ดอล", "margin 20"). */
  if (out.balanceUsd == null && (m = BAL_RE.exec(s))) {
    out.balanceUsd = pos(Number(m[1]));
    s = blank(s, m);
  }
  if ((m = MARGIN_RE.exec(s))) {
    out.marginUsd = pos(Number(m[1]));
    s = blank(s, m);
  }

  /* 7. The market: the sentence's own, else the one the page or conversation is on. */
  const found = findPlanCoin(raw, coins);
  if (found) {
    out.coin = found.coin;
    out.coinKind = found.kind;
    out.coinFrom = "text";
  } else if (typeof contextCoin === "string" && contextCoin.trim()) {
    out.coin = contextCoin.trim();
    out.coinKind = out.coin.includes(":") || resolveStock(out.coin) === out.coin ? "stock" : "crypto";
    out.coinFrom = "context";
  }

  const risky = out.riskUsd != null || out.riskPct != null;
  const riskNoNum = !risky && RISK_NO_NUM_RE.test(s);
  if (risky || riskNoNum) out.mode = "plan";
  else if (out.balanceUsd != null && (out.rrAsked || out.levelsAsked || planAsked || out.side || out.style || out.stopPct != null || out.stopPx != null || out.stopNum != null)) out.mode = "plan";
  else if (out.rr != null && out.coin) out.mode = "plan";
  else if ((out.stopPct != null || out.stopPx != null) && out.marginUsd != null && out.coin) out.mode = "plan";
  else if (out.levelsAsked || (planAsked && out.coin) || (out.style && out.coin)) out.mode = "setups";

  if (out.mode === "plan") {
    if (!risky && out.marginUsd == null && out.balanceUsd != null && !riskNoNum) {
      out.riskPct = DEFAULT_RISK_PCT;
      out.assumed.push("riskPct");
    }
    out.ask = !out.coin ? ASK.coin : riskNoNum && out.marginUsd == null ? ASK.risk : null;
  }
  return out;
}

/**
 * The reply to the one question, folded into the pending parse. A bare number answers a risk ("15", "ดอลเดียว",
 * "3%") or a balance; a side word answers the side; a market name answers the market. Anything the reply states
 * besides is read too ("15 ดอล RR 3"). Returns a new parse (the pending one is not changed).
 */
export function answerAsk(pending, text, { coins = [] } = {}) {
  const p = pending && typeof pending === "object" ? pending : parseRisk("", {});
  const field = p.ask ? p.ask.field : null;
  const now = parseRisk(text, { coins });
  const merged = { ...p, assumed: [...(p.assumed || [])], ask: null };
  for (const k of ["side", "riskUsd", "riskPct", "balanceUsd", "rr", "stopPct", "stopPx", "stopNum", "tpPct", "tpPx", "tpNum", "leverage", "marginUsd", "style"]) {
    if (now[k] != null) merged[k] = now[k];
  }
  if (now.coin && now.coinFrom === "text") Object.assign(merged, { coin: now.coin, coinKind: now.coinKind, coinFrom: "text" });
  const s = normalizeAmounts(text);
  const bare = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(%|เปอร์เซ็นต์|เปอร์เซนต์|เปอร์|percent)?/i.exec(s);
  if (field === "risk" && now.riskUsd == null && now.riskPct == null && bare && pos(Number(bare[1]))) {
    if (bare[2]) merged.riskPct = Number(bare[1]);
    else merged.riskUsd = Number(bare[1]);
  }
  if (field === "balance" && now.balanceUsd == null && bare && !bare[2] && pos(Number(bare[1]))) merged.balanceUsd = Number(bare[1]);
  if (now.riskUsd != null || now.riskPct != null || merged.riskUsd != null) {
    merged.assumed = merged.assumed.filter((a) => a !== "riskPct" || merged.riskPct === DEFAULT_RISK_PCT);
  }
  merged.mode = "plan";
  merged.ask = !merged.coin ? ASK.coin
    : merged.riskUsd == null && merged.riskPct == null && merged.marginUsd == null && field === "risk" ? ASK.risk
      : field === "balance" && merged.balanceUsd == null ? ASK.balance
        : field === "side" && !merged.side ? ASK.side : null;
  return merged;
}

/**
 * The parse as tradePlan.planTrade's input. An ambiguous stop / TP number (no % and no $) is read against the live
 * price: within half of it either way it is a price ("sl 140" on SOL at 150), else a percent ("sl 2" on SOL); an
 * unknown price leaves it a percent only when it is under 50 (a 50%+ stop is no stop), else drops it.
 */
export function planInput(parsed, { midPx = null } = {}) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  const mid = pos(midPx);
  const read = (n) => {
    if (!pos(n)) return {};
    if (mid != null && n > mid * 0.5 && n < mid * 1.5) return { px: n };
    if (n < 50) return { pct: n };
    return {};
  };
  const stop = p.stopPx != null ? { px: p.stopPx } : p.stopPct != null ? { pct: p.stopPct } : read(p.stopNum);
  const tp = p.tpPx != null ? { px: p.tpPx } : p.tpPct != null ? { pct: p.tpPct } : read(p.tpNum);
  return {
    coin: p.coin || null,
    side: p.side === "buy" || p.side === "sell" ? p.side : null,
    riskUsd: pos(p.riskUsd),
    riskPct: pos(p.riskPct),
    riskPctAssumed: Array.isArray(p.assumed) && p.assumed.includes("riskPct"),
    balanceUsd: pos(p.balanceUsd),
    rr: pos(p.rr),
    stopPct: stop.pct ?? null,
    stopPx: stop.px ?? null,
    tpPct: tp.pct ?? null,
    tpPx: tp.px ?? null,
    leverage: pos(p.leverage),
    marginUsd: pos(p.marginUsd),
    style: p.style === "safer" ? "safer" : null,
    lang: p.lang === "th" ? "th" : "en",
  };
}
