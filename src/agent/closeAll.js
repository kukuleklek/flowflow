// CLOSE ALL, WITHOUT THE LLM (item 7; seen live: "ปิดทุก Position ของกู" got "Which market should I close? Say 'close half
// ETH'", then "เอาหมดเลยไอสัส" closed only BTC while CHIP 3x Long stayed open). PURE: which sentences mean "close every
// open position", and which name several markets to close at once.
//
//   "close all", "close all positions", "close everything", "ปิดทุก position", "ปิดหมด", "ปิดทั้งหมด"   → every position
//   "เอาหมดเลย", "all", "ทั้งหมด"  ONLY as the answer to FlowFlow's own "Which market should I close?"  → every position
//   "close BTC and CHIP", "ปิด BTC กับ CHIP"                                                       → exactly those
//   "close all my ETH", "close all ETH and BTC", "ขายหมด ETH"  (a market NAMED beside "all")         → exactly those
//   "close half ETH and SOL", "ปิดครึ่ง ETH กับ SOL", "close 25% of BTC and ETH"                   → those, that share each
//
// 🔴 A NAMED MARKET WINS OVER "ALL" (pass-2 review): "close all my ETH" used to match "close all" first and offer to close
// every position, stocks included. And a share ("half", "25%") is never dropped: it rides on the card (`fraction`), the
// share rounded DOWN to the close card's steps (25 / 50 / 75 / 100%), never more than asked.
//
// The answer is ONE close-all card (cards/CloseAllCard.jsx): every open position listed, one Confirm that closes them
// one by one through the same reduce-only close a single card sends. 🔴 It never opens anything, and nothing here
// sends: a sentence only becomes a card that waits for the tap.
import { findStockInText } from "../lib/hyperliquid/hip3/names.js";
import { withoutMarketShut } from "./shortcuts.js";

/* "close" words: English whole words; Thai ปิด not right after เ (เปิด is OPEN), as shortcuts.js reads it. */
const CLOSE = /(^|\s)(close|exit|flatten)(?=\s|$)|(^|[^เ])ปิด/i;
const ALL_EN = /\b(?:close|exit|flatten)\s+(?:out\s+)?(?:all|everything|every(?:\s+single)?\s+(?:position|trade)s?|them\s+all|it\s+all|all\s+(?:of\s+)?(?:my\s+|the\s+)?(?:positions?|trades?))\b|\bflatten\s+(?:me|my\s+account|the\s+account)\b/i;
const ALL_TH = /(?:^|[^เ])ปิด\s*(?:ทุก|หมด|ทั้งหมด|ให้หมด|ทิ้งหมด|มันให้หมด)|ขายหมด|เคลียร์\s*(?:ทุก|หมด|พอร์ต)|ปิดพอร์ต/;
/* An answer to "Which market should I close?": everything. Thai matches anywhere in a short reply ("เอาหมดเลยไอสัส"). */
const ANSWER_EN = /^\s*(?:all|all of (?:them|it)|everything|every one|both|the whole (?:thing|lot)|close (?:all|everything))\b/i;
const ANSWER_TH = /เอาหมด|หมดเลย|ทั้งหมด|ทุกตัว|ทุกอัน|ทุก\s*position|ทุกโพ|ปิดหมด/;

/** The share of each position a sentence asks to close, rounded DOWN to a close step (0.25 / 0.5 / 0.75 / 1): "half",
 *  "ครึ่ง", "quarter", "N%". 1 when none is said. Never more than asked: 60% is 0.5, and anything under 25% is 0.25. */
export function closeFractionOf(text) {
  const low = String(text || "").toLowerCase();
  if (/\bhalf\b|ครึ่ง/.test(low)) return 0.5;
  if (/\bquarter\b|หนึ่งในสี่/.test(low)) return 0.25;
  const p = /(\d{1,3}(?:\.\d+)?)\s*(?:%|เปอร์เซ็นต์|เปอร์)/.exec(low);
  if (!p) return 1;
  const v = Number(p[1]) / 100;
  if (!(v > 0)) return 1;
  return [0.25, 0.5, 0.75, 1].filter((d) => d <= v + 1e-9).pop() || 0.25;
}

/** The marker the "Which market should I close?" line carries (respond.js), so its answer is read as one. */
export const ASK_CLOSE = "close";

/** Every market a sentence names, from the live list (case-insensitive, k-prefixed names), in the order written. */
export function findCoins(text, coins = []) {
  const words = String(text || "").toUpperCase().replace(/[^A-Z0-9\s:-]/g, " ").split(/\s+/).filter(Boolean);
  const byUpper = new Map((Array.isArray(coins) ? coins : []).map((c) => [String(c).toUpperCase(), c]));
  const out = [];
  for (const w of words) {
    const c = byUpper.get(w) || byUpper.get(`K${w}`);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Is this a close-all (or a close of several named markets)?
 * @param {string} text
 * @param {{ coins?: string[], held?: string[], askedWhich?: boolean }} o coins: the live main-market names; held: the
 *   coins with an open position (a stock name counts only when held); askedWhich: the newest FlowFlow line was
 *   "Which market should I close?" (then "เอาหมดเลย" / "all" is its answer)
 * @returns {{ kind: "closeAll", coins: string[]|null, lang: "en"|"th" } | null} coins null: every open position
 */
export function detectCloseAll(text, { coins = [], held = [], askedWhich = false } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lang = /[฀-๿]/.test(raw) ? "th" : "en";
  /* A question about the market's hours ("เทรดตอนตลาดปิดได้ไหม") is not a close. */
  const t = withoutMarketShut(raw).trim();
  if (!t) return null;
  const short = lang === "th" ? t.length <= 40 : t.split(/\s+/).length <= 8;
  const closing = CLOSE.test(` ${t} `) || ALL_EN.test(t) || ALL_TH.test(t);
  /* The markets the sentence names: crypto by its name, a stock by its name when it is held. */
  const named = closing ? findCoins(t, coins) : [];
  const stock = closing ? findStockInText(t) : null;
  if (stock && Array.isArray(held) && held.includes(stock) && !named.includes(stock)) named.push(stock);
  const fraction = closeFractionOf(t);
  const share = fraction < 1 ? { fraction } : {};
  if (named.length) {
    /* One market named ("close all my ETH", "ขายหมด ETH"): the single close card answers it (respond.js), except where
       only "all" made it a close at all: then the one-market close-all card. */
    if (named.length === 1) return ALL_EN.test(t) || ALL_TH.test(t) ? { kind: "closeAll", coins: named, lang, ...share } : null;
    return { kind: "closeAll", coins: named, lang, ...share };
  }
  if (ALL_EN.test(t) || ALL_TH.test(t)) return { kind: "closeAll", coins: null, lang, ...share };
  if (askedWhich && short && (ANSWER_EN.test(t) || ANSWER_TH.test(t))) return { kind: "closeAll", coins: null, lang, ...share };
  return null;
}

/** The rows a close-all card lists: every open position, or only the named ones that are open. */
export function closeAllPositions(positions, coins = null) {
  const open = (Array.isArray(positions) ? positions : []).filter((p) => p && typeof p.coin === "string" && Number.isFinite(p.szi) && p.szi !== 0);
  return Array.isArray(coins) && coins.length ? open.filter((p) => coins.includes(p.coin)) : open;
}
