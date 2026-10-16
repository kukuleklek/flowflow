// Spot Account asks by chat or voice: "swap 10 USDC to BTC", "buy gold on avax", "unstake all", "move 5 to spot".
// The chat never moves money itself: it opens the Spot Account panel with the coins and amount filled in, and the
// panel's own review, Confirm and Privy window do the rest (the same rule as the stake card). No imports from the app:
// the server bundle (tools.js, voice) and the Node suite use this too.

/** Words → the Spot Account's swap symbols. Native AVAX is never a swap target (it can't be swapped back yet): "avax"
 *  means WAVAX here. */
const COINS = [
  ["USDC", /\busdc\b/i],
  ["USDT", /\b(usdt|tether(?!\s*gold))\b/i],
  ["BTC.b", /\b(btc(\.b)?|bitcoin)\b|บิทคอยน์|บิตคอยน์/i],
  ["XAUt0", /\b(xaut0?|gold|tether\s*gold)\b|ทอง/i],
  ["WAVAX", /\b(w?avax)\b(?!\s*(chain|network|c-chain))/i],
  ["XSGD", /\bxsgd\b/i],
];

export const SPOT_SYMBOLS = Object.freeze(COINS.map(([s]) => s));
export const SPOT_ACTIONS = Object.freeze(["swap", "stake", "unstake", "move-in", "move-out"]);

/** The symbol a word names, or null. */
export function spotSymbol(word) {
  if (typeof word !== "string" || !word.trim()) return null;
  const w = word.trim();
  const exact = SPOT_SYMBOLS.find((s) => s.toLowerCase() === w.toLowerCase());
  if (exact) return exact;
  if (/^avax$/i.test(w)) return "WAVAX";
  const hit = COINS.find(([, re]) => re.test(w));
  return hit ? hit[0] : null;
}

/** Coins named in a sentence, in the order they appear ("swap BTC to USDC" → ["BTC.b", "USDC"]). Chain words like
 *  "on avax" are not coins. */
function coinsIn(text) {
  const t = String(text).replace(/\b(on|บน)\s+avax(alanche)?\b/gi, " ").replace(/\bavalanche\b/gi, " ");
  const found = [];
  for (const [sym, re] of COINS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m;
    while ((m = g.exec(t))) found.push({ sym, at: m.index });
  }
  found.sort((a, b) => a.at - b.at);
  const out = [];
  for (const f of found) if (!out.includes(f.sym)) out.push(f.sym);
  return out;
}

const amountIn = (text) => {
  const m = String(text).replace(/,/g, "").match(/(?:\$\s*)?(\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1e7 ? String(n) : null;
};

const SELL = /\b(sell|dump)\b|ขาย/i;
const BUY = /\b(buy|get)\b|ซื้อ/i;
const TO = /\b(to|into|for)\b|->|→|เป็น|ไป/i;

/**
 * A swap ask → { action: "swap", from, to, amount } (amount is in the FROM coin, or null).
 * "buy BTC on avax" → USDC → BTC.b; "sell gold" → XAUt0 → USDC; "swap 10 usdc to btc" → USDC → BTC.b, 10.
 */
export function parseSwapAsk(text) {
  const t = String(text || "");
  const coins = coinsIn(t);
  let from = null;
  let to = null;
  if (coins.length >= 2 && TO.test(t)) [from, to] = coins;
  else if (coins.length === 1) {
    if (SELL.test(t)) [from, to] = [coins[0], "USDC"];
    else if (coins[0] === "USDC") [from, to] = ["USDC", null];
    else [from, to] = ["USDC", coins[0]];
  } else if (coins.length >= 2) [from, to] = BUY.test(t) ? [coins[1], coins[0]] : [coins[0], coins[1]];
  if (from && from === to) to = from === "USDC" ? null : "USDC";
  return { action: "swap", from: from || "USDC", to: to || null, amount: amountIn(t) };
}

const ALL = /\b(all|everything|max)\b|ทั้งหมด|หมด/i;

/** "unstake 5" / "unstake all" → { action: "unstake", amount } (null = the user picks; "all" stays null too). */
export function parseUnstakeAsk(text) {
  const t = String(text || "");
  return { action: "unstake", amount: ALL.test(t) ? null : amountIn(t) };
}

/** The Wallet link that opens a Spot panel pre-filled. Only known actions, coins and plain amounts get through. */
export function spotHref({ action, from = null, to = null, amount = null } = {}) {
  const kind = SPOT_ACTIONS.includes(action) ? action : null;
  if (!kind) return "/wallet";
  const q = new URLSearchParams({ panel: kind });
  const a = typeof amount === "number" ? String(amount) : amount;
  if (typeof a === "string" && /^\d{1,6}(\.\d{1,6})?$/.test(a)) q.set("amount", a);
  if (kind === "swap") {
    const f = spotSymbol(from);
    const t2 = spotSymbol(to);
    if (f) q.set("from", f);
    if (t2 && t2 !== f) q.set("to", t2);
  }
  return `/wallet?${q.toString()}`;
}

/** The button's words for a Spot panel. */
export function spotLabel({ action, from = null, to = null, amount = null } = {}, th = false) {
  const amt = amount ? `${amount} ` : "";
  if (action === "swap") {
    const f = spotSymbol(from) || "USDC";
    const t2 = spotSymbol(to);
    return th ? `รีวิว Swap ${amt}${f}${t2 ? ` เป็น ${t2}` : ""}` : `Review swap ${amt}${f}${t2 ? ` to ${t2}` : ""}`;
  }
  if (action === "unstake") return th ? `รีวิว Unstake ${amount ? `${amount} USDC` : ""}`.trim() : `Review unstake${amount ? ` ${amount} USDC` : ""}`;
  if (action === "stake") return th ? `รีวิว Stake ${amt}USDC` : `Review stake ${amt}USDC`;
  if (action === "move-in") return th ? `ย้าย ${amt}USDC เข้า Spot` : `Move ${amt}USDC in to Spot`;
  if (action === "move-out") return th ? `ย้าย ${amt}USDC กลับ Main` : `Move ${amt}USDC out to Main`;
  return th ? "เปิด Wallet" : "Open Wallet";
}
