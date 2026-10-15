// HOW THE AGENT TALKS ABOUT STOCKS: names, US market hours in Thai time, the words it never says, and the prompt text.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Agent เราตอนนี้คุณภาพโอเคยัง รู้ยังว่าเทรดหุ้นได้" and, on the venue the stocks live on,
// "คนไม่ต้องรู้ห่าอะไรเลย". So the Agent says "stock", the ticker or the company, and never the place the stock margin
// sits. This file is the light half of the Agent's stock layer: PURE, no market rows, no network, nothing React, so
// the server-side prompt (api/chat.js → prompt.js → moneyMap.js) can import it. The half that reads the live market
// list and the guard is ./stocks.js, which re-exports everything here.
//
//   agentTicker(coin)        "xyz:TSLA" -> "TSLA"; the US 100 index -> "US100" (its own ticker carries the venue's
//                            name, which the user never sees). What the model reads and writes back as `coin`.
//   stockDisplayName(coin)   "Tesla", "US 100 index" (Thai "ดัชนี US 100"), "S&P 500"
//   usSessionView(now, kind) open | extended | closed, the US hours in Thai time, when it opens or closes
//   statusText / analysisRow the one line a card prints, the row that replaces Tokenomist on a stock's analysis
//   scrubVenueWords(text)    rewrites what has a plain name, drops a sentence that has none (see THE WORDS)
//   asksAboutStocks / mayOfferStocks   when stocks may be offered at all (owner rule, AGENT-STOCKS-AND-MAP item 15)
//   stocksPrompt(o)          the stock rules for the system prompt
//
// THREE MARKET STATES, NOT TWO (hip3/hours.js, from the HIP-3 session's brief):
//   open      the US core session (9:30–16:00 New York): the share trades, the price follows it
//   extended  pre / post / overnight: a real outside price still arrives, but trading is thin
//   closed    the price is the market's OWN MODEL (weekends, US holidays; an index also in its daily futures break):
//             held inside a band and liable to jump when the outside price returns
// The LEVERAGE rule reads a different flag: whenever no US session is on (nights, weekends, holidays) the Agent's
// stock leverage drops to CLOSED_AGENT_MAX_LEVERAGE (guard.js decides; leverageClosed here mirrors it for the words).
import { STOCK_WHITELIST } from "../lib/hyperliquid/hip3/whitelist.js";
import { findStockInText } from "../lib/hyperliquid/hip3/names.js";
import {
  usEquitySession, xyzPriceSource, nextRegularOpen, nyParts, NYSE_EARLY_CLOSES,
} from "../lib/hyperliquid/hip3/hours.js";
import { CLOSED_AGENT_MAX_LEVERAGE } from "../lib/hyperliquid/hip3/guard.js";
import { AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { HL_MIN_ORDER_USD } from "../perp/perpTicket.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const WL = new Map(STOCK_WHITELIST.map((w) => [w.coin, w]));

/** Thailand's clock: the owner and the users read US hours in it. */
export const TH_TZ = "Asia/Bangkok";

/** The US 100 index in each language. Never "Nasdaq-100": the market's deployer never calls it that. */
export const US100_NAME = Object.freeze({ en: "US 100 index", th: "ดัชนี US 100" });
const US100 = "xyz:XYZ100";

const THAI = /[฀-๿]/;
/** "th" when the text has Thai in it, else "en". */
export const langOf = (text) => (THAI.test(String(text == null ? "" : text)) ? "th" : "en");
const L = (lang) => (lang === "th" ? "th" : "en");

/** Is this one of the stock markets FlowFlow lists (whatever the live gate says today)? */
export const isStockCoin = (coin) => typeof coin === "string" && WL.has(coin);

/** "index" for SP500 and the US 100 index, "stock" for the rest, null for a coin that is not a listed stock. */
export const stockKind = (coin) => (WL.has(coin) ? WL.get(coin).kind : null);

/**
 * The ticker the model reads and writes back: "TSLA" for "xyz:TSLA", "US100" for the US 100 index (an alias
 * names.js resolves). A qualified name off the list loses its prefix ("xyz:GOLD" -> "GOLD"); a plain coin is itself.
 */
export function agentTicker(coin) {
  if (typeof coin !== "string" || !coin) return "";
  if (coin === US100) return "US100";
  const i = coin.indexOf(":");
  return i >= 0 ? coin.slice(i + 1) : coin;
}

/** "Tesla", "S&P 500", "US 100 index" / "ดัชนี US 100"; a coin off the list: its bare ticker. */
export function stockDisplayName(coin, lang = "en") {
  if (coin === US100) return US100_NAME[L(lang)];
  return WL.has(coin) ? WL.get(coin).name : agentTicker(coin);
}

/* ── US market hours ────────────────────────────────────────────────────────────────────────────────────────── */

const OPEN_MIN = 9 * 60 + 30;
const FULL_DAY_MIN = 390;   // 9:30 – 16:00
const EARLY_DAY_MIN = 210;  // 9:30 – 13:00 on NYSE early closes

let thFmt = null;
/** "20:30", Thai time. */
export function thaiClock(ms) {
  if (!fin(ms)) return null;
  if (!thFmt) thFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TH_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return thFmt.format(new Date(ms));
}

const msOf = (now) => (now instanceof Date ? now.getTime() : fin(now) ? now : NaN);

/**
 * The US market as a stock card says it, at an instant.
 * @param {number|Date} now
 * @param {"stock"|"index"} [kind] an index follows the futures clock for its price (hours.js xyzPriceSource)
 * @returns {{ session: string|null, state: "open"|"extended"|"closed"|null, priceSource: "live"|"model"|null,
 *   leverageClosed: boolean, holiday: string|null, calendarKnown: boolean, openAt: number|null, closeAt: number|null,
 *   opensInMin: number|null, closesInMin: number|null, hoursThai: string|null }}
 *   openAt / closeAt: this session's core hours while it is on, else the next one's. hoursThai: "20:30–03:00".
 *   null figures: the calendar does not reach that far (hours.js knows 2026–2027), never a guess.
 */
export function usSessionView(now = Date.now(), kind = "stock") {
  const ms = msOf(now);
  const s = usEquitySession(ms);
  if (s.session == null) {
    return { session: null, state: null, priceSource: null, leverageClosed: false, holiday: null, calendarKnown: false, openAt: null, closeAt: null, opensInMin: null, closesInMin: null, hoursThai: null };
  }
  const src = xyzPriceSource(ms, kind === "index" ? "index" : "stock");
  const state = src === "internal" ? "closed" : s.session === "regular" ? "open" : "extended";
  let openAt = null;
  let closeAt = null;
  if (s.session === "regular") {
    /* Today's open: New York's offset is whole hours, so its minutes line up with UTC's. */
    openAt = ms - (ms % 60_000) - (nyParts(ms).minutes - OPEN_MIN) * 60_000;
    closeAt = openAt + (s.earlyClose ? EARLY_DAY_MIN : FULL_DAY_MIN) * 60_000;
  } else {
    openAt = nextRegularOpen(ms);
    if (openAt != null) closeAt = openAt + (NYSE_EARLY_CLOSES.includes(nyParts(openAt).date) ? EARLY_DAY_MIN : FULL_DAY_MIN) * 60_000;
  }
  const mins = (t) => (t == null ? null : Math.max(0, Math.ceil((t - ms) / 60_000)));
  return {
    session: s.session,
    state,
    priceSource: src === "internal" ? "model" : src === "external" ? "live" : null,
    leverageClosed: s.closed,
    holiday: s.holiday,
    calendarKnown: s.calendarKnown,
    openAt,
    closeAt,
    opensInMin: s.session === "regular" ? null : mins(openAt),
    closesInMin: s.session === "regular" ? mins(closeAt) : null,
    hoursThai: openAt != null && closeAt != null ? `${thaiClock(openAt)}–${thaiClock(closeAt)}` : null,
  };
}

/** "5h 53m", "1d 5h", "45m"; Thai "5 ชม. 53 นาที", "1 วัน 5 ชม.", "45 นาที". */
export function durationText(min, lang = "en") {
  if (!fin(min) || min < 0) return null;
  const m = Math.max(1, Math.round(min));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (L(lang) === "th") return d ? `${d} วัน${h ? ` ${h} ชม.` : ""}` : h ? `${h} ชม.${mm ? ` ${mm} นาที` : ""}` : `${mm} นาที`;
  return d ? `${d}d${h ? ` ${h}h` : ""}` : h ? `${h}h${mm ? ` ${mm}m` : ""}` : `${mm}m`;
}

/* How far the model price may walk while the outside price is away (docs.trade.xyz discovery bounds, as the HIP-3
   session read them on 2026-10-15, AGENT-STOCKS-BRIEF §2): ±pct per range, and how many ranges before the hard cap.
   Any other market: ±(1 / max leverage), the docs' own rule, with the count unknown (null, never guessed). */
const MODEL_BANDS = Object.freeze({ "xyz:TSLA": [5, 3], "xyz:NVDA": [5, 3], "xyz:XYZ100": [3.5, 2], "xyz:SP500": [2, 2] });

/** @returns {{ pct: number, ranges: number|null, from: "docs"|"max-leverage" } | null} */
export function modelBand(coin, maxLeverage = null) {
  const k = MODEL_BANDS[coin];
  if (k) return { pct: k[0], ranges: k[1], from: "docs" };
  if (fin(maxLeverage) && maxLeverage >= 1) return { pct: Math.round(1000 / maxLeverage) / 10, ranges: null, from: "max-leverage" };
  return null;
}

/* ONE NAME PER STATE, everywhere a stock's market state is printed (pass-2 review: the message said "Outside US market
   hours", the card "Outside US market hours: thinner trading, bigger moves.", the popup "US pre-market · opens in 2h
   49m" and the analysis "Outside hours" — three names for one state). The popup's names (cards/usMarketView.js) are
   the ones: pre-market, after hours, closed (overnight, weekend, holiday). */
const SESSION_NAME = Object.freeze({
  regular: { en: "US market open", th: "ตลาดหุ้น US เปิด", short: { en: "Open", th: "เปิด" } },
  pre: { en: "US pre-market", th: "ก่อนตลาดหุ้น US เปิด", short: { en: "Pre-market", th: "ก่อนเปิด" } },
  post: { en: "US after hours", th: "หลังตลาดหุ้น US ปิด", short: { en: "After hours", th: "หลังปิด" } },
  overnight: { en: "US market closed", th: "ตลาดหุ้น US ปิด", short: { en: "Closed", th: "ปิด" } },
  weekend: { en: "US market closed", th: "ตลาดหุ้น US ปิด", short: { en: "Closed", th: "ปิด" } },
  holiday: { en: "US market closed (holiday)", th: "ตลาดหุ้น US ปิด (วันหยุด)", short: { en: "Closed", th: "ปิด" } },
});

/** "US pre-market" / "ก่อนตลาดหุ้น US เปิด" (short: "Pre-market"), the one name of a session; null when unknown. */
export function sessionName(view, lang = "en", { short = false } = {}) {
  const n = view && view.session ? SESSION_NAME[view.session] : null;
  if (!n) return null;
  return short ? n.short[L(lang)] : n[L(lang)];
}

/**
 * The market-state line a stock card prints (money warning: always printed while the market is not open):
 * "US pre-market · opens in 2h 46m: thinner trading, bigger moves."
 * @param {object} view usSessionView()
 * @param {{ lang?: string, band?: object|null }} [o] band: modelBand(), printed while the price is the model's
 */
export function statusText(view, { lang = "en", band = null } = {}) {
  if (!view || !view.state) return L(lang) === "th" ? "เช็คเวลาตลาด US ไม่ได้ตอนนี้" : "US market hours couldn't be checked";
  const th = L(lang) === "th";
  const opens = durationText(view.opensInMin, lang);
  const at = thaiClock(view.openAt);
  const name = sessionName(view, lang) || (th ? "นอกเวลาตลาดหุ้น US" : "Outside US market hours");
  if (view.state === "open") {
    const closes = durationText(view.closesInMin, lang);
    return th ? `${name}${closes ? ` · ปิดในอีก ${closes}` : ""}` : `${name}${closes ? ` · closes in ${closes}` : ""}`;
  }
  if (view.state === "extended") {
    if (th) return `${name}${at && opens ? ` · เปิด ${at} เวลาไทย (อีก ${opens})` : ""}: ซื้อขายบาง ราคาเหวี่ยงแรง`;
    return `${name}${opens ? ` · opens in ${opens}` : ""}: thinner trading, bigger moves`;
  }
  const b = band && fin(band.pct) ? band.pct : null;
  if (th) {
    return `${name}${opens ? ` · เปิดอีก ${opens}` : ""}: ราคามาจาก model ของตลาดเอง${b ? ` (ขยับได้ทีละ ±${b}%)` : ""} เปิดตลาดอาจกระโดด`;
  }
  return `${name}${opens ? ` · opens in ${opens}` : ""}: the price comes from the market's own model${b ? ` (±${b}% at a time)` : ""} and can jump at the open`;
}

/** The analysis card's row for a stock, in place of the emission (Tokenomist) row: "US market · Pre-market · opens in 2h". */
export function analysisRow(view, lang = "en") {
  const th = L(lang) === "th";
  const label = th ? "ตลาด US" : "US market";
  if (!view || !view.state) return { label, value: "—", tone: "muted" };
  const opens = durationText(view.opensInMin, lang);
  const name = sessionName(view, lang, { short: true }) || (view.state === "open" ? (th ? "เปิด" : "Open") : th ? "ปิด" : "Closed");
  if (view.state === "open") return { label, value: name, tone: "ok" };
  return { label, value: th ? `${name}${opens ? ` · เปิดอีก ${opens}` : ""}` : `${name}${opens ? ` · opens in ${opens}` : ""}`, tone: "warn" };
}

/** What a stock perp is, in one line (S9: "ซื้อหุ้น Apple ได้ปันผลไหม" → no). */
export function perpNotShareText(coin, lang = "en") {
  const name = stockDisplayName(coin, lang);
  const index = stockKind(coin) === "index";
  if (L(lang) === "th") {
    return index
      ? `เป็น perp ที่ตามราคา${name.startsWith("ดัชนี") ? name : `ดัชนี ${name}`} ไม่ใช่การถือหุ้นจริง ไม่มีปันผล`
      : `เป็น perp ที่ตามราคาหุ้น ${name} ไม่ใช่หุ้นจริง ไม่มีปันผล ไม่มีสิทธิ์โหวต`;
  }
  return index
    ? `A perp that tracks the ${name}. You don't own any shares: no dividends.`
    : `A perp that tracks ${name}'s share price, not the share: no dividends, no votes.`;
}

/* ── THE WORDS the user never sees ──────────────────────────────────────────────────────────────────────────────
   🔴 Owner: "คนไม่ต้องรู้ห่าอะไรเลย" — the venue a stock trades on, its name, the protocol, the separate pot its margin
   sits in, and "moving money to a stock account" are plumbing. XYZ100 is the US 100 index, never Nasdaq-100 (the
   deployer never calls it that). What has a plain name is rewritten (xyz:TSLA → TSLA, XYZ100 → US 100 index,
   trade[XYZ] → the market, "HIP-3 stock perps" → "stock perps"); a sentence that still holds one of them after that
   says something about the plumbing itself, so it is DROPPED rather than reworded into something untrue.
   Whole words only where an ordinary word contains one: "Spot" is not "pot", "index" is not "dex", "กองทุน" (a fund)
   and "กองทัพ" are not "กอง". */

const BLOCK = Object.freeze([
  Object.freeze({ word: "trade[XYZ]", re: /trade\s*\[\s*xyz\s*\]|trade\.xyz|\btradexyz\b/i }),
  Object.freeze({ word: "xyz", re: /xyz/i }),
  Object.freeze({ word: "HIP-3", re: /\bhip[\s-]?3\b/i }),
  Object.freeze({ word: "dex", re: /\bdex(?:es)?\b/i }),
  Object.freeze({ word: "venue", re: /\bvenues?\b/i }),
  Object.freeze({ word: "pot", re: /\bpots?\b/i }),
  Object.freeze({ word: "กอง", re: /กอง(?!ทุน|ทัพ)/ }),
  Object.freeze({ word: "stock account", re: /\bstocks?\s+account\b|บัญชีหุ้น/i }),
  Object.freeze({ word: "Nasdaq-100", re: /\bnasdaq[\s-]*100\b|\bndx\b|(?:แนสแด็?[กค]|นาสแด็?[กค])\s*100/i }),
]);

/** The words the eval and the tests look for. */
export const BANNED_VENUE_WORDS = Object.freeze(BLOCK.map((b) => b.word));

/** Which banned words a text holds ([] when none). */
export function venueWordHits(text) {
  const t = String(text == null ? "" : text);
  return BLOCK.filter((b) => b.re.test(t)).map((b) => b.word);
}

const REWRITES = Object.freeze([
  /* "FlowFlow ไม่มีบัญชีหุ้นแยก", "there's no separate stock account": the RIGHT answer to "move money to my stock
     account" (eval B-K1), said in words that do not name a stock account (the sentence was dropped, leaving only "ผม
     เปิดการ์ดให้ได้เลย." with no card). */
  { re: /(ไม่มี|ไม่ใช่|ไม่ต้อง(?:มี|ใช้|เปิด)?)\s*บัญชีหุ้น(?:\s*แยก)?/g, to: (lang, m, neg) => `${neg}บัญชีแยกสำหรับหุ้น` },
  { re: /\b(no|not\s+a|isn't\s+a|is\s+not\s+a|there's\s+no|there\s+is\s+no|without\s+a)\s+(separate\s+)?stocks?\s+account\b/gi, to: (lang, m, neg) => `${neg} separate account for stocks` },
  /* The US 100 index, by its ticker or as Nasdaq-100; an "index" / "ดัชนี" beside it is folded in. */
  { re: /(?:ดัชนี\s*)?\bxyz[\s:-]*(?:xyz)?100\b(?:\s+index\b)?/gi, to: (lang) => US100_NAME[lang] },
  { re: /(?:ดัชนี\s*)?(?:\bnasdaq[\s-]*100\b|\bndx\b|(?:แนสแด็?[กค]|นาสแด็?[กค])\s*100)(?:\s+index\b)?/gi, to: (lang) => US100_NAME[lang] },
  /* A qualified market name: the bare ticker. */
  { re: /\bxyz:([A-Za-z0-9]+)\b/gi, to: (lang, m, t) => t },
  /* The deployer: "the market". */
  { re: /(?:\bthe\s+)?(?:\btrade\s*\[\s*xyz\s*\]|\btrade\.xyz|\btradexyz\b)('s)?/gi, to: (lang, m, s) => (lang === "th" ? "ตลาด" : `the market${s || ""}`) },
  /* "HIP-3 stock perps" → "stock perps"; "หุ้น HIP-3" → "หุ้น". Any other HIP-3 stays and drops its sentence. */
  { re: /\bhip[\s-]?3\s+(?=stock|perp|market|equit|หุ้น)/gi, to: () => "" },
  { re: /(หุ้น)\s*\bhip[\s-]?3\b/gi, to: (lang, m, h) => h },
]);

/* Sentences: after . ! ? (and their Thai space), on a line break, and on the space Thai puts between clauses.
   🔴 No lookbehind: it throws when the module loads on Safari before 16.4, inside Vite's default target. The mark that
   ends a sentence (or the Thai letter before a clause's space) is captured INTO the separator instead, so a kept
   sentence is its text plus its separator, and a sentence is judged on both together (a banned word may end on the
   letter the separator holds). */
const SPLIT = /([.!?。]\s+|\n+|[฀-๿]\s+(?=[฀-๿]))/;

/**
 * The text with the banned words rewritten or their sentences dropped, and what happened.
 * @param {string} text what the user is about to read (model prose, a card line)
 * @param {{ lang?: "th"|"en"|null, fallback?: string }} [o] fallback: what to show when nothing is left
 * @returns {{ text: string, changed: boolean, dropped: number, hits: string[] }} hits: the banned words the INPUT held
 */
export function scrubVenueWordsDetailed(text, { lang = null, fallback = "" } = {}) {
  const input = String(text == null ? "" : text);
  const hits = venueWordHits(input);
  if (!hits.length) return { text: input, changed: false, dropped: 0, hits };
  const lg = L(lang || langOf(input));
  let t = input;
  for (const r of REWRITES) t = t.replace(r.re, (m, ...g) => r.to(lg, m, ...g.slice(0, -2)));
  const parts = t.split(SPLIT);
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const s = parts[i] || "";
    const sep = parts[i + 1] || "";
    /* The separator may hold the sentence's own last letter or mark (SPLIT): it goes with its sentence. A dropped
       Thai clause keeps the space before the next one. */
    if (s && venueWordHits(s + sep).length) { dropped++; if (/\s$/.test(sep) && /[฀-๿]/.test(sep)) kept.push(" "); continue; }
    kept.push(s + sep);
  }
  const out = kept.join("")
    .replace(/\bthe the\b/gi, "the")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
  return { text: out || String(fallback || ""), changed: true, dropped, hits };
}

/** scrubVenueWordsDetailed(...).text: run on every user-facing line the model wrote before it is shown. */
export function scrubVenueWords(text, opts = {}) {
  return scrubVenueWordsDetailed(text, opts).text;
}

/* ── When stocks may be offered (owner, item 15: Top movers, home boxes, Gainers / Losers stay crypto) ─────────── */

const STOCK_TALK = /\b(?:stocks?|shares?|equit(?:y|ies)|s&p|nasdaq|dow\s*jones|wall\s*street|us\s*market|indices|stock\s*index|dividends?)\b|หุ้น|ดัชนี|ตลาด\s*(?:us|อเมริกา|เมกา)|แนสแด|นาสแด|เอสแอนด์พี|ปันผล/i;
const TRADE_TODAY = /what\s+(?:should|can|do)\s+i\s+trade|what\s+to\s+trade|what(?:'s|\s+is)\s+good\s+to\s+trade|trade\s+today|วันนี้\s*(?:เทรด|เล่น|ซื้อ)\s*อะไร|(?:เทรด|เล่น)\s*อะไร\s*ดี|มีอะไรน่า\s*(?:เทรด|เล่น)/i;

/** The user asks about stocks, an index or a listed company ("หุ้นตัวไหนดี", "Tesla", "nasdaq จะขึ้นไหม"). */
export function asksAboutStocks(text) {
  const t = String(text == null ? "" : text);
  return !!t.trim() && (STOCK_TALK.test(t) || findStockInText(t) != null);
}

/** Stocks may be one of the picks: the user asked about stocks, or asked what to trade today. */
export function mayOfferStocks(text) {
  const t = String(text == null ? "" : text);
  return asksAboutStocks(t) || TRADE_TODAY.test(t);
}

/* ── The system prompt's stock rules (patch P9 of docs/PLAN-HIP3-STOCKS.md, with the owner's later rules) ──────── */

/**
 * @param {{ maxLeverage?: number, closedMaxLeverage?: number, now?: number|Date }} [o] caps as the server resolved them
 */
export function stocksPrompt({ maxLeverage = AGENT_MAX_LEVERAGE, closedMaxLeverage = CLOSED_AGENT_MAX_LEVERAGE, now = Date.now() } = {}) {
  const v = usSessionView(now, "stock");
  const hours = v.hoursThai ? `${v.hoursThai} Thai time` : "9:30–16:00 New York time";
  return `Stocks (US stock and index perps, inside the Main Account):
- Offer stocks only when the user asks about stocks, a company, an index, or what to trade today. Never mix them into
  crypto picks, top movers, gainers or losers.
- A stock here is a perpetual contract that tracks the price, not the share: no dividends, no votes. It trades 24/7;
  US market hours are ${hours}. Outside them trading is thin; on weekends and US holidays the price comes from the
  market's own model and can jump at the open. Right now: ${statusText(v)}.
- Before you propose a stock, call get_market for it and say its market status in a few words. Never say the US market
  is open unless get_market says open.
- Stock limits: leverage at most the market's own max and ${maxLeverage}x, and at most ${closedMaxLeverage}x while the US market is closed
  (nights, weekends, US holidays); always isolated margin; orders at least $${HL_MIN_ORDER_USD} in size. A paused or unlisted stock gets
  no card: say why in one line and offer a listed one.
- Words: say "stock", the ticker or the company name. Never say xyz, HIP-3, trade[XYZ], dex, venue, pot or กอง, and never
  talk about moving money for a stock: it happens by itself. Call the US 100 index "US 100 index" (Thai "ดัชนี US 100"),
  never Nasdaq-100.`;
}
