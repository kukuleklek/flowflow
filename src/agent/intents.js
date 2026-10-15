// WHAT THE USER WANTS, WITHOUT THE LLM (plan v2 §2.5, AD-6): the Agent's framework answers these deterministically,
// with real data and rich cards, even when the model is down or busy:
//
//   plan / greet   "hey any plan", "hi", "แนะนำหน่อย", "what should I trade" → the plan FIRST: one featured market's
//                  setups (Safer / Balanced / Bolder) named in one line ("CHIP 1h trend is down: 3 setups. Tap one."),
//                  then two boxes (a position that needs the user, and Earn). A greeting opens with the onboarding line.
//   setups         "setups for ETH", "long setups HYPE", "จุดเข้า SOL" → the setups card (3 profiles of one market;
//                  "top movers setups" → the Balanced setup of several markets)
//   stake          "I want to staking", "earn on my USDC", "ฝากกินดอกเบี้ย 20 ดอล" → the Earn card with the live USDC
//                  Staked AAVE APY (owner: never "I can only help with perps"). "aave" alone is not staking when the
//                  sentence is about the AAVE market ("Long setups for AAVE", "Set TP SL for AAVE").
//   analyze        "Analyze HYPE with Tokenomist", "Analyze ETH", "วิเคราะห์ ETH", "HYPE unlocks", "Analyze ZEC 3x
//                  short" → ONE analysis card (analyze.js: trend on 1h / 4h / 1d and the levels that turn it,
//                  emission, risks, the RR now and suggested) and one short line. Held: its suggested TP / SL; else the
//                  setup or trade card the pill sat on (handed over with the words), else the one the words name
//                  (side, leverage, Safer / Balanced / Bolder; by default the Balanced one, and the card says so). A
//                  HIP-3 venue market ("xyz:TSLA") is not analyzed, and never swapped for the page's market.
//   tpsl           "Set TP SL for ETH" → a recommended TP / SL card for the open position, priced from the MARK; a
//                  level the user typed ("stop loss 8% on ETH") is the card as typed, nothing added
//   swap           "swap USDC to BTC.b" → coming to the Spot Account; what the user can do now
//   picks          "วันนี้เทรดอะไรดี", "เลือกหุ้นให้หน่อย", "มีข่าวอะไรบ้าง", "meme ตัวไหนดี", "Short a stock" → ONE pick card:
//                  four markets of one group with faint 24h charts and up to two headlines (picks.js); a tap asks for
//                  that market's setups (the side asked), which still end in a card that waits for Confirm
//   news           "News and trend for HYPE", "ข่าว TSLA" → the newest headlines, linked (never article text), then the
//                  analysis card (trend 1h / 4h / 1d; a stock's row is the US market's state)
//   stocks         a listed stock by name ("Tesla", "หุ้น NVDA") → its setups (US-hours candles, ≤ 3x); a paused or
//                  unlisted one (NFLX, GOLD, AVGO) → why, and listed ones to pick from instead: never a card for it
//   riskPlan       "มี 300 ยอมเสียได้ 15 ดอล short SOL RR 2", "risk $1 long HYPE" (riskParse.js, run by agent.js before
//                  the trade shortcuts) → the sized plan (tradePlan.js: all the maths in code) as a trade card, or ONE
//                  short question when the plan cannot do without the answer
//   closeAll       "close all", "ปิดทุก position", "เอาหมดเลย" as the answer to "which market?" → ONE close-all card
//   stockAbout     "ซื้อหุ้น Apple ได้ปันผลไหม", "US 100 คืออะไร เทรดตอนตลาดปิดได้ไหม" → what the stock perp is (no dividends,
//                  not the share), and how it trades while the US market is shut; never a setups card for a question
//   stockAccount   "ย้ายเงินไปบัญชีหุ้น 50" → there is no stock account: stocks trade from the Main Account by themselves
//   deposit        "ฝากเงิน", "deposit 50 USDC" → one line and the Deposit button (never "tap Deposit" with nothing to tap)
//   move           "move 10 USDC from Main to Spot" → the Wallet's Move in / Move out (moves run there, never from chat)
//   counts         "how many assets do you have", "how many stocks can I trade?" → the real counts, and picks to tap
//   trade          "long TSLA 10 3x", "ซื้อ Tesla 10 ดอล" (a stock in a trade sentence) → the stock's trade card after
//                  FlowFlow's stock limits (stocks.js checkAgentStockOrder: ≤ 20 USDC, ≤ min(its max, 10x, 5x while the
//                  US market is closed), isolated), or the one thing to ask
//
// Trade sentences with numbers ("long ETH 20 5x") stay with shortcuts.js / respond.js, which run first.
// Detection is pure; runIntent reads through runTool.js (the same code the model's tools run) and shows its work
// through an injected `io` (agent.js binds it to the chat). Nothing here sends, signs or moves money.
import { findCoin, parseTpSl } from "./shortcuts.js";
import { mainMarkets } from "../trade/marketLists.js";
import {
  setupsCardFor, stakeCardFor, analysisFor, chartFor, TOOL_FLAGS, resolveCoin, newsFor, picksCardFor, proposeCloseAll,
  runToolCall, tickerOf,
} from "./runTool.js";
import { detectPick, pickForModel } from "./picks.js";
import { resolveMarket, isStockCoin, usSessionView, statusText, stockKind, agentTicker } from "./stocks.js";
import { askLine, planInput } from "./riskParse.js";
import { planTradeFor, planToOpenCard, planForModel, warningTexts } from "./tradePlan.js";
import { perpNotShareText, stockDisplayName } from "./stockWords.js";
import { marketCounts } from "./runTool.js";
import { analyzable } from "./analyze.js";
import { coinLabel } from "./cards/viewWords.js";
import { recommendHeldTpSl, setupsForModel } from "./setups.js";
import { formatHlPrice, formatHlPct, formatHlFunding } from "../lib/hyperliquid/format.js";
import { perpCoinLabel } from "../perp/live/perpLiveView.js";
import { parseStakeAmount, stakeLine, peekEarnApy } from "./earn.js";
import { analysisLine, analysisNote } from "./analyze.js";
import { assetState, suggestAssets, assetsCard, onboardingLine, assetsForModel } from "./suggest.js";

const TH = /[\u0E00-\u0E7F]/;
/** Longer than this, a sentence goes to the model (Thai has no spaces: characters instead). */
export const MAX_WORDS = 12;
/* Opening words only: "position", "TP / SL" alone are a held position's (account, TP / SL), never new setups. */
const LONG_TRADE = /\b(open|long|short|buy|sell|trade|setups?|entry)\b|เปิด|ซื้อ|ขาย|เทรด|ลอง|ชอร์ต|เท่าไหร่ดี/i;
/** Closing, staking, analysis, money moves: the model's (or their own intents), never setups. เปิด holds ปิด: guarded. */
const NOT_SETUPS = /\b(close|closing|cancel|stake|staking|analy[sz]\w*|unlocks?|withdraw|deposit)\b|(?<!เ)ปิด|ถอน|ฝาก|วิเคราะห์|สเตค/i;
/** A long sentence that already says its size or leverage ("10 usdc on eth at 3x … no tp sl") is an order: the model's. */
const LONG_SIZED = /\$\s*\d|\d+(\.\d+)?\s*(usdc|usd|dollars?|bucks|ดอล|x\b|เท่า)/i;
export const MAX_THAI_CHARS = 48;
/** "th" when the message has Thai letters, else "en". */
export const langOf = (text) => (TH.test(String(text || "")) ? "th" : "en");

const GREET = /^(hi+|hey+|hello+|hello there|yo|sup|gm|good (morning|afternoon|evening)|hola|สวัสดี\S*|หวัดดี\S*|ดีครับ|ดีค่ะ|ดีคับ|ดีจ้า|เฮ้|ฮัลโหล)[\s!.?,~]*(there|agent|bro|ครับ|ค่ะ|คับ|จ้า|นะ)?[\s!.?,~]*$/i;
const PLAN = /\b(any\s*plans?|a\s+plan|the\s+plan|plans?\s*\?|ideas?|suggest(ion)?s?|recommend(ation)?s?|what\s+(should|can|do)\s+i\s+(do|trade|buy|long|short)|what\s+to\s+(do|trade|buy)|where\s+(do\s+i\s+|to\s+)start|what\s+can\s+you\s+do|how\s+does\s+this\s+work|get\s+started|opportunit(y|ies)|anything\s+good)\b|แนะนำ|ทำอะไรได้|ทำไรได้|เริ่มยังไง|เริ่มตรงไหน|ช่วยหน่อย|มีแผน|ไอเดีย|เล่นตัวไหน|เทรดตัวไหน|ตัวไหนดี|ซื้อตัวไหน|มีอะไรน่า|น่าเล่น|น่าเทรด/i;
/* "News and trend for HYPE" (the trade page's box), "ข่าว TSLA", "TSLA earnings": that market's headlines and trend. */
const NEWS_FOR = /\bnews\b|\bheadlines?\b|\bearnings\b|ข่าว/i;
const SETUPS = /\b(setups?|set-ups?|entr(y|ies)|trade\s+ideas?|where\s+to\s+(enter|buy|long|short))\b|แผนเทรด|จุดเข้า|เซ็ตอัพ|เซตอัพ/i;
const STAKE = /\b(stak(e|es|ed|ing)|earn(ing)?|yields?|apy|apr|interest|savings?|passive\s+income|lend(ing)?)\b|ดอกเบี้ย|กินดอก|ฝาก.{0,24}กิน|สเตค|สเตก|สเต็ก|ปล่อยกู้|ออมเงิน/i;
/* "aave" names both the lending protocol and a Hyperliquid market (AAVE): it means staking only when nothing in the
   sentence is about trading it (a side, setups, TP / SL, analysis, a plan). */
const AAVE = /\baave\b/i;
const MOVERS = /\b(top\s*)?movers?\b|\bgainers?\b|\blosers?\b|วิ่งแรง|ตัวไหนวิ่ง|ขึ้นแรง|ลงแรง/i;
const NOT_STAKE = /open\s+interest|unstak|withdraw|did\s+i\s+earn|i\s+earned|have\s+i\s+earned|ถอน/i;
const ANALYZE = /\b(analy[sz](e|is|es|ing)|tokenomics?|unlocks?|vesting|emissions?|supply\s+schedule)\b|วิเคราะห์|ปลดล็อก|อันล็อก|โทเคโนมิกส์/i;
const TPSL = /\b(tp\s*\/?\s*sl|take\s*profit|stop\s*loss|set\s+(a\s+)?stop)\b|ตั้ง\s*(tp|sl|สต็อป|stop)|ตั้งจุด(ตัด|ขาย)/i;
const SWAP = /\b(swap|convert)\b|แปลง|แลก|เปลี่ยน.{0,20}เป็น/i;
/* "ย้ายเงินไปบัญชีหุ้น 50", "move money to my stock account": there is none (owner: the money moves by itself). */
const STOCK_ACCOUNT = /บัญชีหุ้น|\bstocks?\s+(?:account|wallet|balance)\b|\b(?:move|transfer|send|put)\s+(?:my\s+)?(?:money|usdc|funds?|cash|\$?\d[\d.,]*\s*(?:usdc|usd|dollars?)?)\s+(?:in)?to\s+(?:my\s+|the\s+)?stocks?\b|(?:ย้าย|โอน)(?:เงิน)?[^?]{0,12}(?:ไป|เข้า)\s*หุ้น/i;
/* Main ↔ Spot ("move 10 USDC from Main to Spot", "ย้ายเงินไป spot"). */
const MOVE = /\b(?:move|transfer|send|shift)\b[^.?!]{0,40}\b(?:main|spot)\b|(?:ย้าย|โอน)[^.?!]{0,30}(?:spot|main|สปอต|เมน)/i;
const TO_SPOT = /(?:\bto|\binto|->|→|ไป|เข้า)\s*(?:the\s+|my\s+)?(?:spot|สปอต)/i;
const TO_MAIN = /(?:\bto|\binto|->|→|ไป|เข้า)\s*(?:the\s+|my\s+)?(?:main|เมน)/i;
/* "ฝากเงิน", "deposit 50 USDC", "top up": the Deposit panel. A deposit that went missing is a funds question (the
   model reads get_funds), never this button. */
const DEPOSIT = /^\s*(?:i\s+(?:want|need)\s+to\s+|i'd\s+like\s+to\s+|please\s+|pls\s+|let\s+me\s+)?(?:deposit|add\s+(?:funds|money|usdc)|top\s*up|fund\s+(?:my\s+)?account)\b|ฝากเงิน|เติมเงิน|ฝาก\s*usdc|ฝากเข้า|^\s*ฝาก\s*\d/i;
const NOT_DEPOSIT = /where|status|arriv|stuck|pending|missing|didn'?t|not\s+(?:in|there|showing)|ยังไม่|ไม่เข้า|ไปไหน|หาย|ติด|เข้ายัง/i;
/* "how many assets do you have", "how many stocks can I trade", "มีกี่เหรียญ": FlowFlow's own counts (item 22). The
   user's own holdings ("how many coins do I hold") are not this. */
const COUNTS = /\bhow\s+many\s+(?:assets?|markets?|coins?|tokens?|stocks?|cryptos?|perps?|pairs?)\b|\bnumber\s+of\s+(?:assets|markets|coins|stocks)\b|มี(?:ทั้งหมด)?\s*กี่\s*(?:ตัว|เหรียญ|หุ้น|ตลาด|asset|คู่)|กี่\s*(?:เหรียญ|หุ้น|ตลาด)/i;
/** "how many assets / stocks / markets" about FlowFlow (not the user's own holdings). */
export const isCountsQuestion = (text) => COUNTS.test(String(text || "")) && !OWN_HOLDINGS.test(String(text || ""));
const OWN_HOLDINGS = /\b(?:i|me|my)\b[^?]*\b(?:have|hold|own|holding)\b|ถืออยู่|ของฉัน|ของผม|ของกู|ของเรา/i;
/* A question about a stock, not a trade (S8, S9, B-Q1, B-Q2): what it is, dividends, trading while the US market is
   shut, will it go up. */
const DIVIDEND = /\bdividends?\b|ปันผล|\breal\s+shares?\b|\bown\s+(?:the\s+)?shares?\b|หุ้นจริง|สิทธิ์\s*โหวต|\bvot(?:e|ing)\s+rights?\b/i;
const WHAT_IS = /คืออะไร|อะไรคือ|\bwhat\s+(?:is|are)\b|\bwhat's\b/i;
const SHUT_Q = /ตลาด\s*(?:หุ้น\s*)?(?:us\s*)?ปิด|\b(?:market|us)\s+(?:is\s+)?(?:closed|shut)\b|\bweekends?\b|เสาร์|อาทิตย์|วันหยุด|\bafter\s+hours\b|นอกเวลา/i;
const OUTLOOK = /จะ\s*(?:ขึ้น|ลง)|ขึ้น\s*(?:ไหม|มั้ย)|ลง\s*(?:ไหม|มั้ย)|\bwill\s+\S+\s+(?:go\s+)?(?:up|down|rise|fall|pump|dump|drop)\b|\boutlook\b|\btrend\b|เทรนด์|แนวโน้ม/i;
const QUESTION = /\?|ไหม|มั้ย|หรือเปล่า|รึเปล่า|ยังไง|อย่างไร/;
const SIDE_BUY = /(^|\s)(long|buy|ลอง|ซื้อ)(?=\s|$)/i;
const SIDE_SELL = /(^|\s)(short|sell|ชอร์ต|ชอต|ขาย)(?=\s|$)/i;
/* The setup profile ("Analyze ETH long Bolder") and the leverage ("Analyze ZEC 3x short") an analysis is asked for. */
const PROFILE = /\b(safer|balanced|bolder)\b/i;
const LEVERAGE = /(\d+(?:\.\d+)?)\s*x(?![a-z0-9])/i;
/* A HIP-3 venue market's name ("xyz:TSLA"): the analysis reads main markets only. */
const VENUE = /(^|\s)[a-z0-9]+:[a-z0-9]+(?=\s|$|[?.!,])/i;

/** True for a sentence too long for the app's own short answers (it is the model's, bar longTradeIntent). */
export const isLongAsk = (t) => (langOf(t) === "th" ? t.length > MAX_THAI_CHARS : t.split(/\s+/).length > MAX_WORDS);

/**
 * The one long sentence the app still answers itself: it names ONE market and asks to trade it ("อยากเปิดลอง Nvidia
 * อยากตั้ง position TPSL ให้เหมาะสม … เปิดเท่าไหร่ดี", by voice too) → that market's setups with recommended TP / SL. The
 * model answered it with an account summary, and the trade parser read "position" as the account. A long order that
 * already gives its size stays the model's. Null for anything else, and for a short sentence unless anyLength (voice:
 * a spoken sentence is answered the same whatever its length).
 */
export function longTradeIntent(text, { coins = [], markets = null, anyLength = false } = {}) {
  const t = String(text || "").trim();
  if (!t || (!anyLength && !isLongAsk(t)) || !LONG_TRADE.test(t) || NOT_SETUPS.test(t) || LONG_SIZED.test(t)) return null;
  const lang = langOf(t);
  let coin = findCoin(t, coins);
  if (!coin && Array.isArray(markets) && markets.length) {
    let r = null;
    try { r = resolveMarket(t, markets, { text: true, lang }); } catch { r = null; }
    coin = r && r.kind !== "crypto" && r.ok ? r.coin : null;
  }
  if (!coin) return null;
  const padded = ` ${t} `;
  const side = SIDE_BUY.test(padded) ? "buy" : SIDE_SELL.test(padded) ? "sell" : null;
  return { kind: "setups", coin, side, movers: false, lang };
}

/**
 * The intent of a sentence, or null (the LLM answers it).
 * @param {string} text
 * @param {{ coins?: string[], contextCoin?: string|null }} o coins: the live market names (shortcuts.findCoin)
 * @returns {{ kind: "plan"|"greet"|"setups"|"stake"|"analyze"|"tpsl"|"swap", coin?: string|null, side?: "buy"|"sell"|null,
 *   amountUsdc?: number|null, profile?: "Safer"|"Balanced"|"Bolder"|null, leverage?: number|null, venue?: boolean,
 *   lang: "en"|"th" } | null}
 */
export function detectIntent(text, { coins = [], contextCoin = null, markets = null } = {}) {
  const t = String(text || "").trim();
  if (!t) return null;
  const lang = langOf(t);
  /* A long question ("I want to stake, but how does Aave work and what are the risks?") is the model's to answer: it
     has the same cards as tools. These are the short asks the app answers best by itself. */
  if (isLongAsk(t)) return longTradeIntent(t, { coins, markets });
  const padded = ` ${t} `;
  const coin = findCoin(t, coins);
  const side = SIDE_BUY.test(padded) ? "buy" : SIDE_SELL.test(padded) ? "sell" : null;
  /* A US stock or index by name ("Tesla", "หุ้น NVDA", "US100"), only when no crypto is named (crypto always wins), and
     only with the live list in hand: a listed one resolves, a paused or unlisted one is a refusal (stocks.js). */
  let stockR = null;
  if (!coin && Array.isArray(markets) && markets.length) {
    try { stockR = resolveMarket(t, markets, { text: true, lang }); } catch { stockR = null; }
    if (stockR && stockR.kind === "crypto") stockR = null;
  }
  const stockCoin = stockR && stockR.ok ? stockR.coin : null;
  if (ANALYZE.test(t)) {
    const p = PROFILE.exec(t);
    const profile = p ? `${p[1].charAt(0).toUpperCase()}${p[1].slice(1).toLowerCase()}` : null;
    const l = LEVERAGE.exec(t);
    const leverage = l && Number(l[1]) >= 1 ? Number(l[1]) : null;
    if (stockR && !stockR.ok) return { kind: "stockRefused", refusal: stockR, side, lang };
    /* "Analyze xyz:GOLD" names a market, just not one FlowFlow lists: never the page's market instead. */
    const venue = !coin && !stockCoin && VENUE.test(padded);
    return { kind: "analyze", coin: coin || stockCoin || (venue ? null : contextCoin) || null, side, profile, leverage, ...(venue ? { venue: true } : {}), lang };
  }
  /* There is no stock account to move money into (the money moves by itself on a stock order), and Main ↔ Spot moves
     live in the Wallet: both before the trade / stake readings of "ย้ายเงิน …". */
  if (STOCK_ACCOUNT.test(t)) return { kind: "stockAccount", lang };
  if (MOVE.test(t)) return { kind: "move", to: TO_SPOT.test(t) ? "spot" : TO_MAIN.test(t) ? "main" : null, lang };
  if (SWAP.test(t) || (side === "buy" && /\bon\s+avax(alanche)?\b|บน\s*avax/i.test(t))) return { kind: "swap", lang };
  const tradeWords = !!side || TPSL.test(t) || SETUPS.test(t) || PLAN.test(t);
  if ((STAKE.test(t) || (AAVE.test(t) && !tradeWords)) && !NOT_STAKE.test(t)) return { kind: "stake", amountUsdc: parseStakeAmount(t), lang };
  if (DEPOSIT.test(t) && !NOT_DEPOSIT.test(t)) return { kind: "deposit", lang };
  if (COUNTS.test(t) && !OWN_HOLDINGS.test(t)) return { kind: "counts", focus: /\bstocks?\b|หุ้น/i.test(t) ? "stocks" : null, lang };
  /* A question about a stock is answered, never turned into a setups card (S9: "ซื้อหุ้น Apple ได้ปันผลไหม" got three
     AAPL Long setups, which read like a yes): what it is / dividends / trading while the US market is shut → the
     facts; "จะขึ้นไหม" → its analysis (the index called "ดัชนี US 100"). */
  if (stockR && (DIVIDEND.test(t) || WHAT_IS.test(t) || (SHUT_Q.test(t) && QUESTION.test(t)))) {
    return {
      kind: "stockAbout", coin: stockR.coin || null, refusal: stockR.ok ? null : stockR,
      asks: { dividend: DIVIDEND.test(t), what: WHAT_IS.test(t), shut: SHUT_Q.test(t) }, lang,
    };
  }
  if (stockCoin && !side && OUTLOOK.test(t)) return { kind: "analyze", coin: stockCoin, side: null, profile: null, leverage: null, lang };
  if (TPSL.test(t)) {
    /* A level the user typed is the card as typed (the shortcut parser reads most of these first). */
    const legs = parseTpSl(t);
    return { kind: "tpsl", coin: coin || stockCoin || contextCoin || null, tpPct: legs.tpPct, slPct: legs.slPct, lang };
  }
  /* News about one market ("News and trend for HYPE", "ข่าว TSLA"): its headlines, then its trend. */
  if (NEWS_FOR.test(t) && (coin || stockCoin)) return { kind: "news", coin: coin || stockCoin, lang };
  /* "วันนี้เทรดอะไรดี", "เลือกหุ้นให้หน่อย", "Short a stock", "meme ตัวไหนดี", "มีข่าวอะไรบ้าง": the pick-4 card (owner, item 12;
     the lead's stopgap stock list became this). A sentence that names one market is that market's question. */
  const pick = !stockR ? detectPick(t, { coins }) : null;
  if (pick) return pick;
  if (NEWS_FOR.test(t) && contextCoin && !stockR) return { kind: "news", coin: contextCoin, lang };
  /* A stock by name: a paused or unlisted one is refused (with listed ones to pick from); a listed one gets its
     setups (US-hours candles, ≤ 3x), the side as asked. */
  if (stockR && !stockR.ok) return { kind: "stockRefused", refusal: stockR, side, lang };
  /* A stock named with a trade word (or alone: "เทสล่า") gets its setups; a bare question about it, its analysis. */
  if (stockCoin) {
    if (!side && QUESTION.test(t) && !SETUPS.test(t) && !PLAN.test(t)) return { kind: "analyze", coin: stockCoin, side: null, profile: null, leverage: null, lang };
    return { kind: "setups", coin: stockCoin, side, movers: false, lang };
  }
  if (SETUPS.test(t)) return { kind: "setups", coin: coin || null, side, movers: MOVERS.test(t), lang };
  /* "Long HYPE for me": a side and a market with no number at all: its setups on that side (never a guessed margin). */
  if (side && coin && !/\d/.test(t)) return { kind: "setups", coin, side, movers: false, lang };
  if (PLAN.test(t)) return { kind: "plan", coin: coin || null, side, lang };
  if (GREET.test(t)) return { kind: "greet", coin: null, lang };
  return null;
}

/* ── running an intent ───────────────────────────────────────────────────────────────────────────────────────── */

const flag = (ctx, name) => (typeof ctx[name] === "boolean" ? ctx[name] : TOOL_FLAGS[name]);

function stateOf(ctx, apyPct = null) {
  return assetState({
    backend: ctx.backend,
    snapshot: ctx.snapshot,
    apyPct: apyPct != null ? apyPct : peekEarnApy(),
    earnEnabled: flag(ctx, "earnEnabled"),
    tokenomist: flag(ctx, "tokenomist"),
  });
}

const trendWord = (trend, th) => (trend === "up" ? (th ? "ขาขึ้น" : "up") : trend === "down" ? (th ? "ขาลง" : "down") : trend === "flat" ? (th ? "ทรงตัว" : "flat") : null);

const W = {
  setupsOne: (c, th) => (th ? `Setup ${c} จากกราฟ 1h แตะเพื่อสร้างการ์ดเทรด` : `${c} setups from the 1h chart. Tap one to fill a trade card.`),
  setupsMany: (th) => (th ? "Setup จากข้อมูลจริง แตะเพื่อสร้างการ์ดเทรด" : "Setups from live data. Tap one to fill a trade card."),
  /* The plan's line names its pick: "CHIP 1h trend is down: 3 setups. Tap one." */
  planPick: (c, trend, n, th) => {
    const w = trendWord(trend, th);
    return th
      ? `${c}${w ? ` เทรนด์ 1h ${w}` : ""}: ${n} setup แตะเพื่อสร้างการ์ดเทรด`
      : `${c}${w ? ` 1h trend is ${w}` : ""}: ${n} setup${n === 1 ? "" : "s"}. Tap one to fill a trade card.`;
  },
  noSetup: (c, th) => (th ? `ตอนนี้ยังทำ setup ${c || ""} ไม่ได้ (อ่านกราฟไม่ได้)` : `No setup${c ? ` for ${c}` : ""} right now: the chart couldn't be read.`),
  whichCoin: (th) => (th ? "วิเคราะห์ตัวไหนดี? แตะ Analyze บนกล่อง" : "Which coin? Tap Analyze on a box."),
  venue: (th) => (th ? "ตลาดนี้ยังไม่มีใน FlowFlow" : "That market isn't listed in FlowFlow."),
  swap: (th) => (th ? "Swap จะเปิดใน Spot Account เร็วๆนี้ ตอนนี้เทรดหรือฝาก USDC กิน APY ได้" : "Swaps open in your Spot Account soon. Today you can trade, or stake USDC."),
  noAnalysis: (c, th) => (th ? `วิเคราะห์ ${c} ไม่ได้ตอนนี้` : `${c} couldn't be analyzed right now.`),
  tpsl: (c, th) => (th ? `TP / SL แนะนำสำหรับ ${c} จากกราฟ 1h แก้ได้ก่อนกดยืนยัน` : `Recommended TP / SL for ${c} from the 1h chart. Edit before you confirm.`),
  heldTpsl: (c, side, th) => (th
    ? `คุณถือ ${c} ${side === "sell" ? "short" : "long"} อยู่แล้ว (1 position ต่อตลาด) นี่คือ TP / SL แนะนำจากกราฟ 1h แก้ได้ก่อนกดยืนยัน`
    : `You already hold a ${side === "sell" ? "short" : "long"} on ${c} (one position per market). Here is a recommended TP / SL for it from the 1h chart.`),
};

/** The market read in one line: "ETH $2,362.0 · −5.8% 24h · funding 0.0013%/h · 1h trend down." Unknown parts are
 *  left out, never guessed. */
export function marketLine(m, trend = null, th = false) {
  if (!m) return th ? "อ่านตลาดนี้ไม่ได้ตอนนี้" : "That market couldn't be read right now.";
  const parts = [`${coinLabel(m.coin, m) || perpCoinLabel(m.coin, m) || m.coin} ${formatHlPrice(m.px, m.szDecimals)}`];
  if (Number.isFinite(m.change24hPct)) parts.push(`${formatHlPct(m.change24hPct, 1)} 24h`);
  if (Number.isFinite(m.funding)) parts.push(`funding ${formatHlFunding(m.funding)}/h`);
  const w = trendWord(trend, th);
  if (w) parts.push(th ? `เทรนด์ 1h ${w}` : `1h trend ${w}`);
  return `${parts.join(" · ")}${th ? "" : "."}`;
}

/**
 * Run one intent: show the work (io.step), the words (io.say) and the cards (io.card). Never rejects.
 * @param {object} intent detectIntent()
 * @param {{ ctx: object, io: { step: Function, say: Function, card: Function, alive?: Function }, contextCoin?: string|null,
 *   subject?: { setup?: object, card?: object }|null }} o
 *   ctx: runToolCall's context (snapshot, backend, fetchCandles, readApy?, readUnlocks?, flags, step)
 *   subject: what an Analyze pill sat on (a setup box's setup, a pending trade card), handed over with its words
 * @returns {Promise<{ summary: string, focus: string[] }>} the summary the model's history keeps
 */
export async function runIntent(intent, { ctx, io, contextCoin = null, subject = null }) {
  const th = intent.lang === "th";
  const said = [];
  const cards = [];
  const alive = () => (typeof io.alive === "function" ? io.alive() : true);
  const say = (text, extra) => { if (alive() && text) { said.push(text); io.say(text, extra); } };
  const card = (c) => { if (alive() && c) { cards.push(c); io.card(c); } };
  const tctx = { ...ctx, step: io.step };
  const focus = [];
  const snap = ctx.snapshot;
  const named = (c) => { const m = c ? resolveCoin(c, snap) : null; return m ? m.coin : null; };
  /* The Analyze pill rides on a line about one market (always: owner, 2026-10-15; the pill itself says "with
     Tokenomist" only when the key is on and Tokenomist covers the coin). */
  const pill = (c) => (analyzable(c) ? { analyze: { coin: c } } : undefined);
  /* The name the user reads: the ticker for a stock ("TSLA", "US 100"), the market's label for crypto. */
  const labelOf = (c) => (isStockCoin(c) ? coinLabel(c, snap.byCoin && snap.byCoin[c]) : perpCoinLabel(c, snap.byCoin && snap.byCoin[c]) || c);
  /* A plan that asked its one question (riskParse ASK): agent.js keeps it for the next message. */
  let pending = null;
  let planNote = null;

  /* The open position on a market, or null. */
  const posOf = (c) => {
    const b = ctx.backend || {};
    const p = c && b.connected && b.account && b.account.positions && b.account.positions.byCoin ? b.account.positions.byCoin[c] : null;
    return p && Number.isFinite(p.szi) && p.szi !== 0 ? p : null;
  };
  /* A recommended TP / SL card for a held position, from the 1h chart (the setups' Balanced profile), priced from where
     the market is NOW (setups.js recommendHeldTpSl): a losing position's stop still sits under the mark for a long,
     before liquidation, so the card can be saved. */
  const protect = async (coin, pos, held = false, { quiet = false, candles: given = null } = {}) => {
    const m = resolveCoin(coin, snap);
    const candles = Array.isArray(given) && given.length ? given : await chartFor(tctx, coin);
    const side = pos.side === "short" || (pos.side !== "long" && pos.szi < 0) ? "sell" : "buy";
    const mark = m && Number.isFinite(m.markPx) ? m.markPx : m ? m.px : null;
    const rec = candles && m ? recommendHeldTpSl({
      market: m, candles, side, leverage: pos.leverage && pos.leverage.value, entryPx: pos.entryPx, markPx: mark,
      liqPx: Number.isFinite(pos.liquidationPx) ? pos.liquidationPx : null,
    }) : null;
    if (!rec) { say(W.noSetup(coin, th)); return; }
    if (!quiet) say(held ? W.heldTpsl(coin, side, th) : W.tpsl(coin, th), pill(coin));
    card({ kind: "tpsl", coin, tpPct: rec.tpPct, slPct: rec.slPct, status: "review", recommended: true, rr: rec.rr });
  };

  try {
    switch (intent.kind) {
      case "greet":
      case "plan": {
        const coin = named(intent.coin) || null;
        if (coin) focus.push(coin);
        else if (contextCoin && named(contextCoin)) focus.push(named(contextCoin));
        if (ctx.backend && ctx.backend.connected) io.step("get_account", null)(true);
        const doneMk = io.step("get_markets", null);
        doneMk(mainMarkets(snap.markets || []).length > 0);
        /* The plan first: one market's three profiles (the one named, else the featured pick), then two boxes. A
           market the user holds gets its recommended TP / SL instead (one position per market). */
        const heldPos = coin ? posOf(coin) : null;
        const [stake, setups] = await Promise.all([
          stakeCardFor(tctx, {}).catch(() => null),
          heldPos ? Promise.resolve(null) : setupsCardFor(tctx, { coin, side: intent.side || null, focus, featured: !coin }).catch(() => null),
        ]);
        const state = stateOf(ctx, stake ? stake.apyPct : null);
        const pick = setups && setups.ok ? setups.card.coin : null;
        if (heldPos) {
          await protect(coin, heldPos, true);
        } else if (setups && setups.ok) {
          const n = setups.card.setups.length;
          say(intent.kind === "greet" ? onboardingLine(state, intent.lang) : W.planPick(perpCoinLabel(pick, snap.byCoin && snap.byCoin[pick]) || pick, setups.trend, n, th), pill(pick));
          card(setups.card);
        } else {
          say(onboardingLine(state, intent.lang));
        }
        if (pick) focus.push(pick);
        card(assetsCard(suggestAssets(state, { surface: "plan", focus, exclude: [pick, coin].filter(Boolean) })));
        break;
      }
      case "picks": {
        /* ONE group, four tiles, faint 24h charts, up to two headlines (picks.js). The tap asks for its setups. */
        io.step("get_markets", null)(mainMarkets(snap.markets || []).length > 0);
        const r = await picksCardFor(tctx, { group: intent.group, side: intent.side || null, lang: intent.lang });
        if (!r.ok) { say(r.why === "no-stocks" ? (th ? "ตอนนี้อ่านตลาดหุ้นไม่ได้" : "Stocks couldn't be read right now.") : (th ? "ตลาดยังโหลดไม่เสร็จ ลองอีกครั้ง" : "The markets are still loading. Ask again in a moment.")); break; }
        card(r.card);
        break;
      }
      case "news": {
        const coin = named(intent.coin);
        if (!coin) { say(W.whichCoin(th)); break; }
        focus.push(coin);
        const label = labelOf(coin);
        const n = await newsFor(tctx, { coin });
        if (n.card) card(n.card);
        else say(th ? `ยังไม่มีข่าว ${label} ตอนนี้` : `No headlines for ${label} right now.`, { tone: "muted" });
        const r = await analysisFor(tctx, coin);
        if (r && r.card) { say(analysisLine(r.card, intent.lang)); card(r.card); }
        break;
      }
      case "stockRefused": {
        /* NFLX paused, GOLD / AVGO not listed: why, and listed stocks to pick from. Never a card for it, never a crypto. */
        const ref = intent.refusal || {};
        say((ref.texts && ref.texts[th ? "th" : "en"]) || ref.text || (th ? "หุ้นตัวนี้ยังเทรดไม่ได้" : "That stock can't be traded right now."));
        const alts = Array.isArray(ref.alternatives) ? ref.alternatives : [];
        if (alts.length) {
          card({
            kind: "pick", group: "stocks", side: intent.side || null, status: "review", headlines: [],
            line: th ? "เลือกหุ้นตัวอื่นแทน" : "Pick another stock.",
            tiles: alts.slice(0, 4).map((a) => ({ coin: a.coin, changePct: snap.byCoin && snap.byCoin[a.coin] && Number.isFinite(snap.byCoin[a.coin].change24hPct) ? snap.byCoin[a.coin].change24hPct : null })),
          });
        }
        break;
      }
      case "closeAll": {
        const r = proposeCloseAll({ coins: intent.coins || null, fraction: intent.fraction }, ctx);
        if (!r.ok) {
          const b = ctx.backend || {};
          say(!b.connected ? (th ? "ล็อกอินก่อน แล้วค่อยปิด position" : "Sign in to close your positions.")
            : r.loading ? (th ? "position หุ้นยังโหลดไม่เสร็จ รอสักครู่แล้วสั่งอีกครั้ง" : "Your stock positions are still loading. Ask again in a moment.")
              : /loaded/.test(r.error) ? (th ? "position ยังโหลดไม่เสร็จ ลองอีกครั้ง" : "Your positions are still loading. Ask again in a moment.")
                : th ? "ไม่มี position ที่เปิดอยู่" : "You have no open positions to close.");
          break;
        }
        io.step("get_account", null)(true);
        /* One market named ("close all my ETH"): its own close card, at the share asked. */
        if (Array.isArray(r.card.coins) && r.card.coins.length === 1) {
          card({ kind: "close", coin: r.card.coins[0], fraction: r.card.fraction || 1, status: "review" });
          break;
        }
        card(r.card);
        break;
      }
      case "stockAbout": {
        /* A stock question answered in a few words: what it is (a perp that tracks the price, no dividends), how it
           trades while the US market is shut, and its market now. Never a setups card for a question. */
        const coin = intent.coin;
        const lg = th ? "th" : "en";
        if (!coin) { say(th ? "หุ้นตัวไหน?" : "Which stock?"); break; }
        if (intent.refusal) { say((intent.refusal.texts && intent.refusal.texts[lg]) || intent.refusal.text); break; }
        focus.push(coin);
        const name = stockDisplayName(coin, lg);
        const a = intent.asks || {};
        const lines = [];
        if (a.dividend) lines.push(th ? `ไม่ได้ปันผล: ${perpNotShareText(coin, lg)}` : `No dividends: ${perpNotShareText(coin, lg)}`);
        else if (a.what || !a.shut) lines.push(th ? `${name}: ${perpNotShareText(coin, lg)}` : `${name}: ${perpNotShareText(coin, lg)}`);
        if (a.shut) {
          lines.push(th
            ? "เทรดได้ตลอด 24 ชม. แต่นอกเวลาตลาด US ซื้อขายบาง วันหยุดราคามาจาก model ของตลาดเอง เปิดตลาดอาจกระโดด ตอนตลาดปิด FlowFlow ให้หุ้นได้สูงสุด 5x"
            : "It trades 24/7, but outside US hours trading is thin, and on weekends and holidays the price comes from the market's own model and can jump at the open. While the US market is closed FlowFlow uses at most 5x on stocks.");
        }
        lines.push(statusText(usSessionView(Date.now(), stockKind(coin)), { lang: lg }));
        say(lines.join(th ? " · " : " "), pill(coin));
        const t2 = tickerOf(coin);
        card({ kind: "choices", items: [
          { label: th ? `วิเคราะห์ ${t2}` : `Analyze ${t2}`, text: `Analyze ${t2}`, coin },
          { label: th ? `Setup ${t2}` : `${t2} setups`, text: `Setups for ${t2}`, coin },
        ] });
        break;
      }
      case "stockAccount": {
        /* 🔴 There is no stock account to move money into (owner: the move is automatic, inside the order, and invisible):
           said plainly, never a card that moves anything. */
        say(th
          ? "FlowFlow ไม่มีบัญชีแยกสำหรับหุ้น หุ้นเทรดจาก Main Account เลย เงินจะย้ายไปกลับเองตอนเปิดและปิด position หุ้น ไม่ต้องย้ายอะไร"
          : "There's no separate account for stocks: they trade from your Main Account, and the money for a stock position moves by itself when you open or close it. Nothing to move.");
        card({ kind: "choices", items: [
          { label: th ? "เลือกหุ้นให้หน่อย" : "Pick a stock", text: th ? "เลือกหุ้นให้หน่อย" : "Pick a stock", coin: "xyz:NVDA" },
          { label: th ? "เงินฉันอยู่ไหน" : "Where is my money", text: th ? "เงินฉันอยู่ไหน" : "Where is my money?", icon: "wallet" },
        ] });
        break;
      }
      case "deposit": {
        /* The Deposit button itself, under one line (eval F4: "Tap Deposit" with no button in the turn). It opens the
           Wallet's Deposit panel: the address and the chains are there, never typed here. */
        say(th ? "ฝาก USDC เข้า Main Account: แตะ Deposit" : "Add USDC to your Main Account: tap Deposit.");
        card({ kind: "choices", items: [
          { label: "Deposit", to: "/wallet?panel=deposit", icon: "plus", main: true },
          { label: th ? "เงินฉันอยู่ไหน" : "Where is my money", text: th ? "เงินฉันอยู่ไหน" : "Where is my money?", icon: "wallet" },
        ] });
        break;
      }
      case "move": {
        /* Main ↔ Spot moves run in the Wallet (Relay, with their own confirm and signatures): the chat opens the panel,
           never moves money itself. Into Spot opens only when the build has it on. */
        const earn = flag(ctx, "earnEnabled");
        const items = [];
        if (intent.to !== "main") {
          if (earn) items.push({ label: th ? "ย้ายเข้า Spot" : "Move in to Spot", to: "/wallet?panel=move-in", icon: "arrowDown", main: true });
        }
        if (intent.to !== "spot") items.push({ label: th ? "ย้ายกลับ Main" : "Move out to Main", to: "/wallet?panel=move-out", icon: "arrowUp", main: intent.to === "main" });
        if (!items.length) items.push({ label: th ? "เปิด Wallet" : "Open Wallet", to: "/wallet", icon: "wallet" });
        say(intent.to === "spot" && !earn
          ? (th ? "การย้ายเงินจาก Main เข้า Spot Account เปิดเร็วๆนี้ ตอนนี้ย้ายจาก Spot กลับ Main ได้แล้ว" : "Moving USDC from Main into the Spot Account opens soon. Moving from Spot back to Main works now.")
          : intent.to === "main"
            ? (th ? "ย้าย USDC จาก Spot กลับ Main Account: แตะ Move out" : "Move USDC from Spot back to your Main Account: tap Move out.")
            : (th ? "ย้ายเงินระหว่าง Main กับ Spot ทำใน Wallet: แตะปุ่มด้านล่าง" : "Moves between Main and Spot run in your Wallet: tap below."));
        card({ kind: "choices", items });
        break;
      }
      case "counts": {
        /* The real counts from the live lists (item 22), never the length of a truncated list; then picks to tap. */
        const n = marketCounts(snap);
        if (intent.focus === "stocks") {
          say(th ? `เทรดหุ้นและดัชนี US ได้ ${n.stocks} ตัว ใช้เงินจาก Main Account` : `You can trade ${n.stocks} US stocks and indices here, from your Main Account.`);
        } else {
          say(th
            ? `FlowFlow มีเหรียญ perp ${n.crypto_perps} ตัว หุ้นและดัชนี US ${n.stocks} ตัว${n.spot_coins != null ? ` และเหรียญใน Spot Account ${n.spot_coins} ตัว` : ""}`
            : `FlowFlow has ${n.crypto_perps} crypto perps, ${n.stocks} US stocks and indices${n.spot_coins != null ? `, and ${n.spot_coins} coins in the Spot Account` : ""}.`);
        }
        card({ kind: "choices", items: [
          { label: th ? "เลือกหุ้นให้หน่อย" : "Pick a stock", text: th ? "เลือกหุ้นให้หน่อย" : "Pick a stock", coin: "xyz:NVDA" },
          ...(intent.focus === "stocks" ? [{ label: "Short a stock", text: "Short a stock", coin: "xyz:TSLA" }] : [{ label: th ? "meme ตัวไหนดี" : "Pick a meme", text: th ? "meme ตัวไหนดี" : "Pick a meme", glyph: "trendUp" }]),
          { label: th ? "วันนี้เทรดอะไรดี" : "What to trade today", text: th ? "วันนี้เทรดอะไรดี" : "What should I trade today?", glyph: "trendUp" },
        ] });
        break;
      }
      case "riskPlan": {
        /* The sized plan (tradePlan.js): every number from code, the caps in code; a plan over a cap is the capped one
           with its real risk said plainly ("Max 20 USDC margin per order: this risks $3.01, not $15"). */
        const p = intent.parse || {};
        if (p.ask) { say(askLine(p.ask.field, intent.lang)); pending = p; break; }
        const coin = named(p.coin);
        if (!coin) {
          let ref = null;
          try { ref = p.coin ? resolveMarket(String(p.coin), snap.markets || [], { text: false, lang: intent.lang }) : null; } catch { ref = null; }
          say(ref && !ref.ok ? (ref.texts && ref.texts[th ? "th" : "en"]) || ref.text : askLine("coin", intent.lang));
          if (!ref || ref.ok) pending = { ...p, coin: null, ask: { field: "coin" } };
          break;
        }
        focus.push(coin);
        const m = resolveCoin(coin, snap);
        const done = io.step("get_candles", coin);
        const plan = await planTradeFor(tctx, { ...planInput({ ...p, coin }, { midPx: m ? m.px : null }), coin });
        done(!!plan.ok);
        if (!plan.ok) {
          /* Held already (one position per market): never a dead end — its recommended TP / SL instead (eval C7). */
          if (plan.why === "held" && posOf(coin)) {
            say(th ? `มี ${labelOf(coin)} อยู่แล้ว (ได้ตัวละ 1 position) นี่คือ TP / SL แนะนำสำหรับ position นี้` : `You already hold ${labelOf(coin)} (one position per market). Here is a recommended TP / SL for it.`, pill(coin));
            await protect(coin, posOf(coin), true, { quiet: true });
            break;
          }
          say((plan.text && plan.text[th ? "th" : "en"]) || (th ? "ทำแผนนี้ไม่ได้ตอนนี้" : "That plan can't be made right now."));
          if (plan.ask) pending = { ...p, coin, ask: { field: plan.ask.field || "risk" } };
          break;
        }
        const c = planToOpenCard(plan);
        if (!c) { say(th ? "แผนนี้เกินลิมิตของ FlowFlow จึงไม่ออกการ์ด" : "That plan is over FlowFlow's limits, so there is no card."); break; }
        const label = labelOf(coin);
        /* One short line. 🔴 A side FlowFlow picked is said first (the card says it too); the capped line lives on the
           card only (it was printed twice). */
        const sideWord = plan.side === "sell" ? "short" : "long";
        const picked = plan.sideFrom === "chart" ? warningTexts({ ...plan, warnings: plan.warnings.filter((w) => w === "side_from_trend" || w === "side_from_data") }, th ? "th" : "en")[0] : null;
        const risk = Number.isFinite(plan.riskUsd) ? `$${Number(plan.riskUsd.toFixed(2))}` : null;
        say(picked ? (th ? picked : `${picked}.`)
          : th ? `แผน ${sideWord} ${label}${risk ? ` จากความเสี่ยง ${risk}` : ""}` : `${label} ${sideWord} plan${risk ? ` for ${risk} risk` : ""}.`);
        card(c);
        planNote = planForModel(plan, intent.lang);
        break;
      }
      case "trade": {
        /* A stock in a trade sentence ("long TSLA 10 3x"): the same propose_open the model calls, so the stock limits,
           the isolated margin and the recommended TP / SL (US-hours candles) are one code path. */
        const coin = named(intent.coin);
        if (!coin) { say(W.whichCoin(th)); break; }
        focus.push(coin);
        const label = labelOf(coin);
        const sideWord = intent.side === "sell" ? "short" : "long";
        if (!Number.isFinite(intent.marginUsdc)) {
          say(th ? `ใช้เงินกี่ USDC สำหรับ ${sideWord} ${label}? (สูงสุด 20)` : `How much USDC margin for the ${sideWord} on ${label}? (max 20)`);
          break;
        }
        /* A TP / SL typed as a PRICE ("sl $400") rides on the card as that price (never replaced by the recommended
           legs); its ROE here is only so nothing is recommended in its place. A level on the wrong side is said. */
        const m0 = resolveCoin(coin, snap);
        const ref = m0 && Number.isFinite(m0.px) && m0.px > 0 ? m0.px : null;
        const buy = intent.side !== "sell";
        const okTp = Number.isFinite(intent.tpPx) && ref != null && (buy ? intent.tpPx > ref : intent.tpPx < ref);
        const okSl = Number.isFinite(intent.slPx) && ref != null && (buy ? intent.slPx < ref : intent.slPx > ref);
        const roeAt = (px, lev) => (ref != null && Number.isFinite(lev) && lev >= 1 ? Math.round((Math.abs(px - ref) / ref) * lev * 1000) / 10 : 1);
        const notes0 = [];
        if (Number.isFinite(intent.tpPx) && !okTp) notes0.push(th ? `TP ${intent.tpPx} อยู่ผิดฝั่งของราคา จึงไม่ใส่` : `TP ${intent.tpPx} is on the wrong side of the price, so it is left off.`);
        if (Number.isFinite(intent.slPx) && !okSl) notes0.push(th ? `SL ${intent.slPx} อยู่ผิดฝั่งของราคา จึงไม่ใส่` : `SL ${intent.slPx} is on the wrong side of the price, so it is left off.`);
        const tpArg = okTp ? roeAt(intent.tpPx, intent.leverage) : intent.tpPct;
        const slArg = okSl ? roeAt(intent.slPx, intent.leverage) : intent.slPct;
        const r = await runToolCall("propose_open", {
          coin, side: sideWord, margin_usdc: intent.marginUsdc, leverage: intent.leverage, lang: intent.lang,
          ...(Number.isFinite(tpArg) ? { tp_roe_pct: tpArg } : {}), ...(Number.isFinite(slArg) ? { sl_roe_pct: slArg } : {}),
        }, { ...tctx, ...(intent.noTpSl || notes0.length ? { noTpSl: true } : {}) });
        if (!r.card) {
          /* The one thing to ask (with any limit already applied said first), or why there is no card. */
          const why = r.ask || String((r.result && r.result.error) || "").replace(/^Ask the user:\s*/, "").replace(/\s*No card:.*$/, "");
          say(why || (th ? "ทำการ์ดนี้ไม่ได้ตอนนี้" : "That card couldn't be made right now."));
          /* No leverage given (and nothing held): the setups for it (never a guessed leverage). */
          if (r.ask && !Number.isFinite(intent.leverage) && !posOf(coin)) {
            const s2 = await setupsCardFor(tctx, { coin, side: intent.side || null });
            if (s2.ok) card(s2.card);
          }
          break;
        }
        const out = { ...r.card };
        if (okTp) { out.tpPx = intent.tpPx; out.tpPct = roeAt(intent.tpPx, out.leverage); }
        if (okSl) { out.slPx = intent.slPx; out.slPct = roeAt(intent.slPx, out.leverage); }
        if (okTp || okSl) { delete out.recommended; delete out.rr; }
        /* A stock card prints the US market's state once, on the card (statusNote); the line above only says what it is. */
        if (isStockCoin(coin)) {
          out.statusNote = statusText(usSessionView(Date.now(), stockKind(coin)), { lang: intent.lang });
          if (Array.isArray(out.notes)) out.notes = out.notes.filter((n) => !/US market hours|ตลาด US|US market closed|ตลาดหุ้น US/.test(n));
        }
        const held = posOf(coin);
        const readLine = intent.pxRead && (okTp || okSl) ? (th ? "อ่านตัวเลขเป็นราคา" : "Read the numbers as prices.") : "";
        say([
          ...notes0,
          th
            ? `${sideWord === "short" ? "Short" : "Long"} ${label}${m0 ? ` ราคาประมาณ ${formatHlPrice(m0.px, m0.szDecimals)}` : ""}${held ? ` · เพิ่มเข้า position เดิมที่ ${out.leverage}x` : ""}`
            : `${sideWord === "short" ? "Short" : "Long"} ${label}${m0 ? ` at about ${formatHlPrice(m0.px, m0.szDecimals)}` : ""}.${held ? ` Adds to your ${label} position at its ${out.leverage}x.` : ""}`,
          readLine,
        ].filter(Boolean).join(" "));
        card(out);
        break;
      }
      case "setups": {
        const coin = named(intent.coin) || null;
        if (coin) focus.push(coin);
        /* No market named: one featured market's three profiles; "top movers setups": several markets. */
        const r = await setupsCardFor(tctx, {
          coin, side: intent.side || null, focus: coin ? [coin] : contextCoin ? [contextCoin] : [], featured: !coin && !intent.movers,
        });
        if (r.ok) {
          const one = r.card.coin || null;
          if (one && !coin) focus.push(one);
          /* A stock's line carries the US market's state (S1: "the market status line"). */
          const us = coin && isStockCoin(coin) ? statusText(usSessionView(Date.now(), stockKind(coin)), { lang: intent.lang }) : null;
          const line = coin ? W.setupsOne(labelOf(coin), th) : one ? W.planPick(labelOf(one), r.trend, r.card.setups.length, th) : W.setupsMany(th);
          say(us ? `${line} ${us}${th ? "" : "."}` : line, pill(one));
          card(r.card);
        } else if (r.held && coin && posOf(coin)) {
          /* One position per market: the held market gets its recommended TP / SL instead of a new setup. */
          await protect(coin, posOf(coin), true);
        } else {
          say(W.noSetup(coin, th));
          card(assetsCard(suggestAssets(stateOf(ctx), { surface: "after", focus })));
        }
        break;
      }
      case "stake": {
        const c = await stakeCardFor(tctx, { amountUsdc: intent.amountUsdc });
        say(stakeLine(c, intent.lang));
        card(c);
        break;
      }
      case "analyze": {
        const coin = named(intent.coin);
        if (!coin) {
          say(intent.venue ? W.venue(th) : W.whichCoin(th));
          card(assetsCard(suggestAssets(stateOf(ctx), { surface: "movers" })));
          break;
        }
        focus.push(coin);
        /* ONE analysis card (trend and the levels that turn it, emission, risks, the RR now and suggested) and one
           short line: the card's numbers do the talking. A held market's card suggests a TP / SL for it, never a new
           position. The emission row is a dash, with a short note, while Tokenomist is off or does not cover it. The
           setup or trade card the pill sat on is the one weighed (only when it is this market's). */
        const sub = subject && typeof subject === "object" ? subject : {};
        const own = (x) => (x && typeof x === "object" && x.coin === coin ? x : null);
        const r = await analysisFor(tctx, coin, {
          side: intent.side || null, profile: intent.profile || null, leverage: intent.leverage || null,
          setup: own(sub.setup), card: own(sub.card),
        });
        if (!r || !r.card) { say(W.noAnalysis(labelOf(coin), th)); break; }
        say(analysisLine(r.card, intent.lang));
        card(r.card);
        break;
      }
      case "tpsl": {
        const coin = named(intent.coin);
        const b = ctx.backend || {};
        const pos = coin && b.connected && b.account && b.account.positions && b.account.positions.byCoin ? b.account.positions.byCoin[coin] : null;
        /* A level the user typed: the card as typed, nothing recommended, nothing added (the editor keeps the other
           leg as it is on the position). */
        if (coin && (Number.isFinite(intent.tpPct) || Number.isFinite(intent.slPct))) {
          focus.push(coin);
          card({ kind: "tpsl", coin, tpPct: Number.isFinite(intent.tpPct) ? Math.abs(intent.tpPct) : null, slPct: Number.isFinite(intent.slPct) ? Math.abs(intent.slPct) : null, status: "review" });
          break;
        }
        if (!coin || !pos) {
          /* No open position to protect: the setups for it carry their own TP / SL. */
          const r = await setupsCardFor(tctx, { coin, focus: coin ? [coin] : [] });
          if (coin) focus.push(coin);
          if (r.ok) { say(coin ? W.setupsOne(coin, th) : W.setupsMany(th)); card(r.card); } else say(W.noSetup(coin, th));
          break;
        }
        focus.push(coin);
        await protect(coin, pos);
        break;
      }
      case "swap": {
        const stake = await stakeCardFor(tctx, {}).catch(() => null);
        say(W.swap(th));
        card(assetsCard(suggestAssets(stateOf(ctx, stake ? stake.apyPct : null), { surface: "empty" })));
        break;
      }
      default:
        break;
    }
  } catch (e) {
    say(th ? "มีบางอย่างผิดพลาด ลองอีกครั้ง" : `Something went wrong: ${String((e && e.message) || e)}.`, { tone: "error" });
  }
  const summary = summaryOf(said, cards);
  return { summary: planNote ? `${summary} Plan (code, not the model): ${JSON.stringify(planNote).slice(0, 900)}` : summary, focus, ...(pending ? { pending } : {}) };
}

/** What the model's history keeps of a turn the app answered itself (so a later question can refer to it). */
export function summaryOf(said, cards) {
  const parts = [...said];
  for (const c of cards) {
    const line = describeCard(c);
    if (line) parts.push(line);
  }
  return parts.join(" ").slice(0, 1500) || "Done.";
}

/** One card in words, for the model's history. */
export function describeCard(c) {
  if (!c || typeof c !== "object") return "";
  switch (c.kind) {
    case "open": return `Showed a trade card: ${c.side === "sell" ? "short" : "long"} ${tickerOf(c.coin)} ${c.marginUsdc} USDC ${c.leverage ?? ""}x${c.tpPx != null ? ` TP at ${c.tpPx}` : c.tpPct != null ? ` TP +${c.tpPct}%` : ""}${c.slPx != null ? ` SL at ${c.slPx}` : c.slPct != null ? ` SL -${c.slPct}%` : ""}${c.planned ? " (sized by plan_trade)" : c.recommended ? " (recommended TP/SL)" : ""}${Array.isArray(c.notes) && c.notes.length ? ` Notes on the card: ${c.notes.join(" / ")}` : ""}.`;
    case "close": return `Showed a close card for ${tickerOf(c.coin)} (${Math.round((c.fraction || 1) * 100)}%).`;
    case "tpsl": return `Showed a TP / SL card for ${tickerOf(c.coin)}${c.tpPx != null ? ` TP at ${c.tpPx}` : c.tpPct != null ? ` TP +${c.tpPct}%` : ""}${c.slPx != null ? ` SL at ${c.slPx}` : c.slPct != null ? ` SL -${c.slPct}%` : ""}.`;
    case "choices": return `Offered buttons: ${(Array.isArray(c.items) ? c.items : []).map((x) => x.label).join(", ")}.`;
    case "closeAll": return `Showed a close-all card${Array.isArray(c.coins) && c.coins.length ? ` for ${c.coins.map(tickerOf).join(", ")}` : " for every open position"}${Number.isFinite(c.fraction) && c.fraction < 1 ? `, ${Math.round(c.fraction * 100)}% of each` : ""}. Nothing closes until the user confirms.`;
    case "pick": return pickForModel(c);
    case "news": return `Showed ${Array.isArray(c.items) ? c.items.length : 0} headline(s)${c.coin ? ` for ${tickerOf(c.coin)}` : ""} (third-party titles, linked).`;
    case "setups": return `Showed setups: ${setupsForModel(c).map((s) => `${s.coin} ${s.label} ${s.side} ${s.leverage}x TP +${s.tp_roe_pct}% SL -${s.sl_roe_pct}% RR ${s.rr}`).join("; ")}.`;
    case "stake": return `Showed the Earn card: USDC Staked AAVE on AVAX, APY ${c.apyPct != null ? `${c.apyPct}%` : "unknown"}${c.amountUsdc != null ? `, ${c.amountUsdc} USDC` : ""}${c.enabled ? "" : " (opens with the Spot Account)"}.`;
    case "analysis": return analysisNote(c);
    case "unlocks": return c.configured === false ? "Unlock data is not connected." : c.covered === false ? `Tokenomist has no unlock schedule for ${c.coin}.` : c.next ? `Showed ${c.coin} unlocks (Tokenomist, updated ${c.updatedAt || "unknown"}): next ${c.next.date}.` : `Showed ${c.coin} unlocks: none scheduled.`;
    case "assets": return `Showed asset boxes: ${assetsForModel(c)}.`;
    default: return "";
  }
}

/** The same words for a list of chat messages (a shortcut's answer), for ChatThread's history note. */
export function describeForModel(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && m.role === "assistant" ? m.text : m && m.role === "card" ? describeCard(m.card) : null))
    .filter(Boolean).join(" ") || "Done.";
}
