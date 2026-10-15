// THE AGENT KNOWS STOCKS: which market a name means, whether it may be traded, the facts a card and the model need,
// and the order limits, all on top of the HIP-3 read-only layer (src/lib/hyperliquid/hip3/). Pure: the live market
// list, the clock and the candles come in; nothing is fetched, signed or sent here.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Agent เราตอนนี้คุณภาพโอเคยัง รู้ยังว่าเทรดหุ้นได้". Stocks are NOT a separate account: they are
// markets inside the Main Account, with their own "Stock" pill, and the margin moves to and from the stock market by
// itself inside the order the user confirms (exchange/client.js). The Agent never moves money for a stock.
//
//   resolveMarket(input, markets)   crypto on the main dex FIRST, then a stock ONLY if the Stock pill lists it
//                                   (trade/marketLists.js stockMarkets: one gate for the list and the Agent). A
//                                   whitelisted stock under the gate (NFLX on 2026-10-15) and a name FlowFlow knows it
//                                   does not list (GOLD, ทองคำ, AVGO) come back as a refusal with the reason and the
//                                   stocks to offer instead: no card.
//   checkAgentStockOrder(o)         hip3/guard.js checkStockOrder({ by: "agent", listed }) with the clamps the
//                                   Agent applies before a card: margin to the cap, leverage to min(market, 10x, 5x
//                                   while the US market is closed), each clamp one plain line. What is still refused
//                                   after that (min order, paused, a missing amount) is said, never carded.
//   stockFacts(coin, o)             market state (open / extended / closed) with Thai hours, the model-price band,
//                                   max leverage now, isolated, fee, "a perp, not the share"; stockFactsForModel()
//                                   is the small version get_market returns.
//   stockSetupsInput(o)             core-session 1h candles + leverage-capped profiles for setups.js buildSetups
//                                   (a weekend's 14-bar range is a third of a trading day's: a stop sized on it sits
//                                   inside Monday's gap).
//   scrubVenueWords(text)           re-exported from ./stockWords.js with the rest of the stock vocabulary.
//
// 🔴 CAPS ARE CODE. margin ≤ MAX_MARGIN_USDC, leverage ≤ min(market max, AGENT_MAX_LEVERAGE), ≤ CLOSED_AGENT_MAX_LEVERAGE
// while no US session is on, setups ≤ SETUP_MAX_LEVERAGE, notional ≥ HL_MIN_ORDER_USD, isolated always. Every one is
// read from its own file (guardrails.js, guard.js, setups.js, perpTicket.js), never copied here.
// 🔴 THE MODEL READS TICKERS, NOT VENUE NAMES. Every *ForModel answer carries agentTicker() ("TSLA", "US100"): a coin
// id like "xyz:TSLA" in a tool result is a word the model would repeat to the user. resolveMarket() takes the ticker
// back.
import { resolveStock, findStockInText, STOCK_ALIASES } from "../lib/hyperliquid/hip3/names.js";
import { STOCK_WHITELIST } from "../lib/hyperliquid/hip3/whitelist.js";
import { checkStockOrder, STOCK_GUARD_TEXT, CLOSED_AGENT_MAX_LEVERAGE } from "../lib/hyperliquid/hip3/guard.js";
import { coreSessionCandles } from "../lib/hyperliquid/hip3/hours.js";
import { mainMarkets, stockMarkets } from "../trade/marketLists.js";
import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { HL_MIN_ORDER_USD } from "../perp/perpTicket.js";
import { perpMarketFeeRate, perpFeeRateFor } from "../perp/live/perpLiveView.js";
import { formatHlPrice, formatHlPct, formatHlUsdCompact, formatHlFunding } from "../lib/hyperliquid/format.js";
import { findCoin } from "./shortcuts.js";
import { SETUP_MAX_LEVERAGE, RANGE_BARS, PROFILES, cleanCandles } from "./setups.js";
import {
  agentTicker, stockDisplayName, stockKind, isStockCoin, langOf, usSessionView, statusText, analysisRow, modelBand,
  perpNotShareText, durationText,
} from "./stockWords.js";

export * from "./stockWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const L = (lang) => (lang === "th" ? "th" : "en");

/** 1h bars a stock's setups ask for: a week, so the core-session hours alone still pass RANGE_BARS after a weekend. */
export const STOCK_CANDLE_BARS = 168;
export const STOCK_SETUP_BASIS = "1h candles · US market hours only · 14-bar range";

const listOf = (markets) => (Array.isArray(markets) ? markets : markets && Array.isArray(markets.markets) ? markets.markets : []);

/* ── Which market a name means ──────────────────────────────────────────────────────────────────────────────── */

/* Main-dex tickers that are also everyday words. In a sentence that ALSO names a stock ("buy me some tesla", "is not
   tesla up"), such a word counts as the crypto only when it is written in capitals ("buy ME and tesla": ME). Alone
   ("close chip") it still counts as it always did (shortcuts.findCoin): this only breaks the tie in the stock's
   favour. */
const COMMON_WORDS = new Set([
  "me", "not", "s", "w", "io", "op", "ar", "cc", "ace", "alt", "ape", "super", "people", "move", "anime", "baby", "init",
  "pump", "prove", "sky", "met", "mega", "stable", "lit", "chip", "gas", "meme", "zen", "bio", "layer", "useless", "turbo",
  "goat", "grass", "mon", "sand", "near", "link", "dot", "comp", "uni", "cake", "gram", "hyper", "aero", "trump", "apex",
]);

/* The crypto a single name means: exact, or the k-prefixed thousand-unit market (runTool.resolveCoin's rule). */
function cryptoByName(name, main) {
  const want = String(name).trim().toUpperCase().replace(/-USD$|-PERP$|\/USDC?$/, "").replace(/^\$/, "");
  if (!want || want.includes(":")) return null;
  return main.find((m) => m.coin.toUpperCase() === want) || main.find((m) => m.coin.toUpperCase() === `K${want}`) || null;
}

/* The sentence without the named stock's own names: "S&P 500" holds an "S" (a main-dex coin) that is no crypto. */
function withoutStockNames(text, coin) {
  const w = STOCK_WHITELIST.find((x) => x.coin === coin);
  const names = [agentTicker(coin), coin.slice(coin.indexOf(":") + 1), w ? w.name : "", ...(STOCK_ALIASES[coin] || [])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  let t = String(text).normalize("NFC");
  for (const n of names) {
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = /^[a-z0-9&\s.]+$/i.test(n)
      ? t.replace(new RegExp(`(^|[^a-z0-9&])${e}(?=$|[^a-z0-9&])`, "gi"), "$1 ")
      : t.replace(new RegExp(e, "g"), " ");
  }
  return t;
}

/** The sentence without the named stock's own names (its ticker, company name and aliases): what a number parser
 *  reads, so "long S&P 500 10 3x" never takes the index's 500 for a margin. */
export const stripStockNames = (text, coin) => (isStockCoin(coin) ? withoutStockNames(text, coin) : String(text == null ? "" : text));

function cryptoInText(text, main, stockCoin) {
  const coins = main.map((m) => m.coin);
  if (!stockCoin) {
    const coin = findCoin(text, coins);
    return coin ? main.find((m) => m.coin === coin) || null : null;
  }
  /* findCoin's own scan, word by word, over what is left once the stock's names are out, skipping an everyday word
     that was not written in capitals. */
  for (const w of withoutStockNames(text, stockCoin).replace(/[^A-Za-z0-9\s:-]/g, " ").split(/\s+/).filter(Boolean)) {
    const coin = findCoin(w, coins);
    if (!coin) continue;
    if (w !== w.toUpperCase() && COMMON_WORDS.has(w.toLowerCase())) continue;
    return main.find((m) => m.coin === coin) || null;
  }
  return null;
}

/* Names people use for markets FlowFlow does not list (S7: "long ทองคำ / GOLD" gets no card, and no crypto either).
   Thai matches anywhere (Thai has no spaces between words); Latin as a whole word. */
const UNLISTED = Object.freeze([
  Object.freeze({ name: "Gold", th: "ทองคำ", words: ["gold", "xauusd", "ทองคำ", "ทอง"] }),
  Object.freeze({ name: "Silver", th: "แร่เงิน", words: ["silver", "xagusd", "แร่เงิน"] }),
  Object.freeze({ name: "Oil", th: "น้ำมัน", words: ["oil", "crude", "brent", "wti", "น้ำมัน"] }),
  Object.freeze({ name: "Broadcom", th: "Broadcom", words: ["avgo", "broadcom", "บรอดคอม"] }),
]);
const latinWord = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i");

function unlistedIn(input, list, free) {
  const t = String(input).normalize("NFC");
  const low = t.trim().toLowerCase();
  for (const u of UNLISTED) {
    const hit = u.words.some((w) => (/^[a-z0-9]+$/.test(w) ? (free ? latinWord(w).test(t) : low === w || low === `xyz:${w}`) : t.includes(w)));
    if (hit) return { name: u.name, nameTh: u.th, coin: null };
  }
  /* A stock-style market that is live but not on the whitelist ("xyz:GOLD", "long CL"): its ticker as written in
     capitals, at least 3 letters, and never one whose own name carries the venue's. */
  const qualified = /^[a-z0-9]+:([A-Za-z0-9]+)$/i.exec(t.trim());
  for (const m of list) {
    if (!m || !m.isHip3 || isStockCoin(m.coin)) continue;
    const label = String(m.label || agentTicker(m.coin));
    if (label.length < 3 || /xyz/i.test(label)) continue;
    const named = qualified ? qualified[1].toUpperCase() === label.toUpperCase()
      : free ? new RegExp(`(^|[^A-Za-z0-9])${label}($|[^A-Za-z0-9])`).test(t) : t.trim() === label;
    if (named) return { name: label, nameTh: label, coin: m.coin };
  }
  if (qualified && !isStockCoin(t.trim())) return { name: qualified[1].toUpperCase(), nameTh: qualified[1].toUpperCase(), coin: null };
  return null;
}

const orList = (xs, lang) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")}${L(lang) === "th" ? " หรือ " : " or "}${xs[xs.length - 1]}`);

/** Up to n listed stocks to offer instead of `coin`, by 24h volume (agentTicker, coin, name). */
export function stockAlternatives(markets, { exclude = null, n = 3, held = null } = {}) {
  return stockMarkets(listOf(markets))
    .filter((m) => m.coin !== exclude && !(held instanceof Set && held.has(m.coin)))
    .slice(0, n)
    .map((m) => ({ coin: m.coin, ticker: agentTicker(m.coin), name: stockDisplayName(m.coin) }));
}

/* The refusal words. English and Thai; `text` is the one in the asker's language. */
function refusalTexts(reason, name, nameTh, alts) {
  /* Listed ones by the names the tiles use (Nvidia, S&P 500, "US 100 index" / "ดัชนี US 100"), as examples: they are a
     few of the list, never the whole of it (pass-2 review: "Stocks you can trade: US100, SP500 or NVDA"). */
  const a = (lang) => orList(alts.map((x) => stockDisplayName(x.coin, L(lang))), lang);
  const has = alts.length > 0;
  switch (reason) {
    case "held":
      return {
        en: `${name} is paused for now: trading in it is too thin.${has ? ` Try another, for example ${a("en")}.` : ""}`,
        th: `${nameTh} พักการเทรดไว้ก่อน (ซื้อขายบาง)${has ? ` ลองตัวอื่นแทนได้ เช่น ${a("th")}` : ""}`,
      };
    case "not_live":
      return {
        en: `${name} isn't available right now.${has ? ` Try another, for example ${a("en")}.` : ""}`,
        th: `${nameTh} ยังเทรดไม่ได้ตอนนี้${has ? ` ลองตัวอื่นแทนได้ เช่น ${a("th")}` : ""}`,
      };
    case "loading":
      return { en: "Stock prices are still loading. Try again in a moment.", th: "ราคาหุ้นยังโหลดไม่เสร็จ ลองใหม่อีกครั้งนะ" };
    default:
      return {
        en: `${name} isn't listed in FlowFlow yet.${has ? ` You can trade other stocks and indices, for example ${a("en")}.` : ""}`,
        th: `ยังไม่มี${nameTh}ใน FlowFlow${has ? ` เทรดหุ้นตัวอื่นได้ เช่น ${a("th")}` : ""}`,
      };
  }
}

/**
 * Which market a name or a sentence means.
 *
 * @param {string} input one name the model passed ("TSLA", "eth", "Tesla", "US100", "xyz:TSLA") or the user's own
 *   sentence ("ซื้อ Tesla 10 ดอล")
 * @param {object[]|{markets: object[]}} markets the store's live rows (snapshot or snapshot.markets)
 * @param {{ text?: boolean|null, lang?: "th"|"en"|null }} [o] text: a sentence (default: when the input has a space)
 * @returns {null
 *   | { ok: true, kind: "crypto"|"stock", coin: string, row: object, ticker: string, name: string }
 *   | { ok: false, kind: "stock"|"unlisted", coin: string|null, row: object|null, ticker: string|null, name: string,
 *       reason: "held"|"not_live"|"loading"|"not_listed", text: string, texts: {en, th}, alternatives: object[] }}
 *   null: nothing in it names a market (the caller asks which one).
 */
export function resolveMarket(input, markets, { text = null, lang = null } = {}) {
  if (typeof input !== "string" || !input.trim()) return null;
  const list = listOf(markets);
  const main = mainMarkets(list);
  const free = text == null ? /\s/.test(input.trim()) : !!text;
  const lg = L(lang || langOf(input));
  const stockCoin = free ? findStockInText(input) : resolveStock(input);

  /* 1. Crypto on the main dex always wins (no ticker clashes today: scripts/test-hip3-names.mjs pins that). */
  const crypto = free ? cryptoInText(input, main, stockCoin) : cryptoByName(input, main);
  if (crypto) return { ok: true, kind: "crypto", coin: crypto.coin, row: crypto, ticker: crypto.label || crypto.coin, name: crypto.label || crypto.coin };

  /* 2. A stock, only if the Stock pill lists it right now. */
  if (stockCoin) {
    const listed = stockMarkets(list);
    const row = listed.find((m) => m.coin === stockCoin) || null;
    if (row) return { ok: true, kind: "stock", coin: stockCoin, row, ticker: agentTicker(stockCoin), name: stockDisplayName(stockCoin, lg) };
    const raw = list.find((m) => m && m.coin === stockCoin) || null;
    const reason = raw ? "held" : list.some((m) => m && m.isHip3) ? "not_live" : "loading";
    const alternatives = stockAlternatives(list, { exclude: stockCoin });
    const texts = refusalTexts(reason, stockDisplayName(stockCoin, "en"), stockDisplayName(stockCoin, "th"), alternatives);
    return { ok: false, kind: "stock", coin: stockCoin, row: raw, ticker: agentTicker(stockCoin), name: stockDisplayName(stockCoin, lg), reason, text: texts[lg], texts, alternatives };
  }

  /* 3. A market FlowFlow knows it does not list. */
  const un = unlistedIn(input, list, free);
  if (un) {
    const alternatives = stockAlternatives(list);
    const texts = refusalTexts("not_listed", un.name, un.nameTh, alternatives);
    return { ok: false, kind: "unlisted", coin: un.coin, row: null, ticker: null, name: lg === "th" ? un.nameTh : un.name, reason: "not_listed", text: texts[lg], texts, alternatives };
  }
  return null;
}

/** Does the Stock pill list this coin right now (the gate the Agent shares with the list)? */
export function stockListed(coin, markets) {
  return isStockCoin(coin) && stockMarkets(listOf(markets)).some((m) => m.coin === coin);
}

/* ── Facts: what a card prints and the model reads ──────────────────────────────────────────────────────────── */

/* Hyperliquid's own taker rate with no builder fee: the rate a market's multiplier scales (perpLiveView's one
   constant, reached through its own helper: only src/perp may import the mock's fee table). */
const BASE_FEE_RATE = perpFeeRateFor({ enabled: false });

/**
 * The taker fee of this stock as a fraction of notional (0.00009 on xyz today: 0.045% × 0.2), or null when unknown.
 * @param {object|null} row
 * @param {number|null} [allInRate] the build's all-in rate (ctx.backend.feeRate: Hyperliquid's plus the builder fee);
 *   default: Hyperliquid's alone. The builder share rides on top unscaled (perpMarketFeeRate, the card's own rule).
 */
export function stockFeeRate(row, allInRate = BASE_FEE_RATE) {
  return row ? perpMarketFeeRate(row, allInRate) : null;
}
/** "0.009%" (no trailing zeros), or "—". */
export const feePctText = (rate) => (fin(rate) ? `${Number((rate * 100).toFixed(4))}%` : "—");

/* The leverage caps a stock order meets here and now, and which one binds. */
function leverageCaps(row, view) {
  const market = row && fin(row.maxLeverage) && row.maxLeverage >= 1 ? Math.floor(row.maxLeverage) : null;
  const closed = view && view.leverageClosed ? CLOSED_AGENT_MAX_LEVERAGE : null;
  if (market == null) return { max: null, market, closed, binds: null };
  const max = Math.min(market, AGENT_MAX_LEVERAGE, closed == null ? Infinity : closed);
  const binds = closed != null && max === closed && closed < Math.min(market, AGENT_MAX_LEVERAGE) ? "closed"
    : market <= AGENT_MAX_LEVERAGE && max === market ? "market" : "agent";
  return { max, market, closed, binds };
}

/**
 * Everything a stock card and the model need about one stock, now.
 * @param {string} coin "xyz:TSLA" (or any name resolveMarket takes)
 * @param {{ markets?: object[]|{markets: object[]}, now?: number, feeRate?: number|null }} [o] feeRate: the build's
 *   all-in rate (ctx.backend.feeRate), so the fee printed is the one the card charges
 * @returns {object|null} null when the name is no stock on the list
 */
export function stockFacts(coin, { markets = [], now = Date.now(), feeRate = BASE_FEE_RATE } = {}) {
  const c = isStockCoin(coin) ? coin : resolveStock(String(coin || ""));
  if (!c) return null;
  const list = listOf(markets);
  const row = list.find((m) => m && m.coin === c) || null;
  const listed = stockListed(c, list);
  const kind = stockKind(c);
  const view = usSessionView(now, kind);
  const caps = leverageCaps(row, view);
  const band = modelBand(c, row ? row.maxLeverage : null);
  const fee = stockFeeRate(row, fin(feeRate) ? feeRate : BASE_FEE_RATE);
  return {
    coin: c,
    ticker: agentTicker(c),
    name: stockDisplayName(c, "en"),
    nameTh: stockDisplayName(c, "th"),
    kind,
    listed,
    row,
    session: view.session,
    state: view.state,
    priceSource: view.priceSource,
    leverageClosed: view.leverageClosed,
    holiday: view.holiday,
    hoursThai: view.hoursThai,
    openAt: view.openAt,
    closeAt: view.closeAt,
    opensInMin: view.opensInMin,
    closesInMin: view.closesInMin,
    status: { en: statusText(view, { lang: "en", band }), th: statusText(view, { lang: "th", band }) },
    analysisRow: { en: analysisRow(view, "en"), th: analysisRow(view, "th") },
    modelBand: band,
    maxLeverageMarket: caps.market,
    /* The Agent's cap for a new order on it now: min(market, 10x, 5x while closed). null: the market's own is unread. */
    maxLeverage: caps.max,
    maxLeverageBinds: caps.binds,
    setupMaxLeverage: caps.max == null ? null : Math.min(caps.max, SETUP_MAX_LEVERAGE),
    marginMode: "isolated",
    feeRate: fee,
    feeText: feePctText(fee),
    minOrderUsd: HL_MIN_ORDER_USD,
    maxMarginUsdc: MAX_MARGIN_USDC,
    whatItIs: { en: perpNotShareText(c, "en"), th: perpNotShareText(c, "th") },
  };
}

const STATUS_WORD = Object.freeze({ open: "open", extended: "outside_us_hours", closed: "closed" });

/** The facts as the model reads them: snake_case, tickers only, no venue words. */
export function stockFactsForModel(f) {
  if (!f) return null;
  return {
    coin: f.ticker,
    name: f.name,
    kind: f.kind,
    listed: f.listed,
    market_status: f.state ? STATUS_WORD[f.state] : null,
    status_line: f.status.en,
    price_from: f.priceSource === "model" ? "the market's own model (can jump at the US open)" : f.priceSource === "live" ? "the live US price" : null,
    us_hours_thai: f.hoursThai,
    opens_in: f.opensInMin == null ? null : durationText(f.opensInMin),
    closes_in: f.closesInMin == null ? null : durationText(f.closesInMin),
    ...(f.state === "closed" && f.modelBand ? { model_moves_up_to_pct: f.modelBand.pct } : {}),
    max_leverage_now: f.maxLeverage,
    margin: "isolated",
    fee: f.feeText,
    min_order_usd: f.minOrderUsd,
    note: f.whatItIs.en,
  };
}

/** get_market for a stock: the price figures of the row plus its facts (null when no listed stock is named). */
export function stockMarketForModel(coin, { markets = [], now = Date.now(), feeRate = BASE_FEE_RATE } = {}) {
  const f = stockFacts(coin, { markets, now, feeRate });
  if (!f || !f.row) return null;
  const m = f.row;
  return {
    ...stockFactsForModel(f),
    price: formatHlPrice(m.px, m.szDecimals),
    change_24h: formatHlPct(m.change24hPct),
    volume_24h: formatHlUsdCompact(m.dayNtlVlm),
    open_interest: formatHlUsdCompact(m.openInterestUsd),
    funding_hourly: formatHlFunding(m.funding),
  };
}

/** get_markets kind "stocks": the Stock pill's rows (by 24h volume) and the US market's one line. */
export function stockRowsForModel(markets, { now = Date.now(), limit = 8 } = {}) {
  const rows = stockMarkets(listOf(markets)).slice(0, Math.max(1, Math.min(20, Math.floor(limit) || 8)));
  const view = usSessionView(now, "stock");
  return {
    us_market: statusText(view),
    stocks: rows.map((m) => {
      const caps = leverageCaps(m, usSessionView(now, stockKind(m.coin)));
      return {
        coin: agentTicker(m.coin),
        name: stockDisplayName(m.coin),
        price: formatHlPrice(m.px, m.szDecimals),
        change_24h: formatHlPct(m.change24hPct),
        volume_24h: formatHlUsdCompact(m.dayNtlVlm),
        max_leverage_now: caps.max,
      };
    }),
  };
}

/** The listed stocks worth showing when the user asked about stocks (PickCard's stock group, setups' candidates). */
export function stockCandidates(markets, { held = null, n = 4 } = {}) {
  return stockMarkets(listOf(markets))
    .filter((m) => !(held instanceof Set && held.has(m.coin)))
    .slice(0, Math.max(0, n))
    .map((m) => m.coin);
}

/* ── Order limits ───────────────────────────────────────────────────────────────────────────────────────────── */

const GUARD_TEXT_TH = Object.freeze({
  market_unknown: "ตลาดนี้ยังเทรดไม่ได้ตอนนี้",
  not_listed: "หุ้นตัวนี้ยังไม่มีใน FlowFlow",
  held: "หุ้นตัวนี้พักการเทรดไว้ก่อน ตลาดบางเกินไป",
  at_cap: "หุ้นตัวนี้เต็มลิมิต position ของตลาดแล้ว เปิดใหม่ไม่ได้ตอนนี้",
  bad_side: "เลือก Long หรือ Short",
  bad_margin: "ใส่จำนวนเงิน (USDC)",
  margin_cap: `สูงสุด ${MAX_MARGIN_USDC} USDC ต่อ order ใน FlowFlow ตอนนี้`,
  bad_leverage: "เลือก leverage",
  leverage_unknown: "อ่านลิมิต leverage ของตลาดนี้ไม่ได้ ลองใหม่อีกครั้ง",
  leverage_cap: "leverage เกินลิมิตของหุ้นตัวนี้ตอนนี้",
  min_value: `order ต้องมีขนาดอย่างน้อย $${HL_MIN_ORDER_USD}`,
  us_market_closed: "ตลาดหุ้น US ปิดอยู่ ราคาตอนนี้มาจาก model ของตลาดเอง เปิดตลาดอาจกระโดด",
  extended_hours: "นอกเวลาตลาด US ซื้อขายบาง ราคาเหวี่ยงแรงกว่าปกติ",
  calendar_old: "ปฏิทินเวลาตลาดต้องอัปเดต",
  price_off_oracle: "ราคาตอนนี้ห่างจากราคาอ้างอิง",
  fee_unknown: "อ่านค่าธรรมเนียมของตลาดนี้ไม่ได้ จึงแสดงเป็น —",
  margin_locked: "เปิดแล้วถอน margin ออกจาก position นี้ไม่ได้",
});
const guardText = (code, lang) => (L(lang) === "th" ? GUARD_TEXT_TH[code] : STOCK_GUARD_TEXT[code]) || code;

function leverageNote(caps, ticker, lang) {
  const th = L(lang) === "th";
  if (caps.binds === "closed") return th ? `ตลาดหุ้น US ปิดอยู่ หุ้นใช้ได้สูงสุด ${caps.max}x` : `Max ${caps.max}x on stocks while the US market is closed`;
  if (caps.binds === "market") return th ? `${ticker} ใช้ได้สูงสุด ${caps.max}x` : `${ticker} allows at most ${caps.max}x`;
  return th ? `FlowFlow เสนอได้สูงสุด ${caps.max}x` : `Max ${caps.max}x for trades FlowFlow proposes`;
}

/**
 * The Agent's stock order, after FlowFlow's limits: clamped where a clamp is honest (margin to the cap, leverage to
 * the cap that binds, each with one line), refused where it is not. Never sends; a card is made only when ok.
 *
 * @param {{ coin: string, side: "long"|"short"|"buy"|"sell", marginUsdc: number|null, leverage: number|null,
 *   markets: object[]|{markets: object[]}, now?: number, lang?: "th"|"en" }} o
 * @returns {{ ok: boolean, coin: string|null, ticker: string|null, name: string|null, side: string|null,
 *   marginUsdc: number|null, leverage: number|null, maxLeverage: number|null, notionalUsd: number|null,
 *   refusals: string[], warnings: string[], warningTexts: string[], notes: string[], ask: string|null,
 *   text: string|null, fix: object|null, alternatives: object[], marginMode: "isolated", session: string|null }}
 *   notes: the clamps, one line each, for the line under the card. ask: a missing figure to ask for (margin or
 *   leverage), no refusal. text: why there is no card.
 */
export function checkAgentStockOrder({ coin, side, marginUsdc = null, leverage = null, markets = [], now = Date.now(), lang = "en" } = {}) {
  const lg = L(lang);
  const base = { ok: false, coin: null, ticker: null, name: null, side: null, marginUsdc: null, leverage: null, maxLeverage: null, notionalUsd: null, refusals: [], warnings: [], warningTexts: [], notes: [], ask: null, text: null, fix: null, alternatives: [], marginMode: "isolated", session: null };
  const r = resolveMarket(String(coin || ""), markets, { text: false, lang: lg });
  if (!r || r.kind === "crypto") return { ...base, refusals: ["market_unknown"], text: guardText("market_unknown", lg) };
  if (!r.ok) return { ...base, coin: r.coin, ticker: r.ticker, name: r.name, refusals: [r.reason === "not_listed" ? "not_listed" : r.reason === "loading" ? "market_unknown" : "held"], text: r.text, alternatives: r.alternatives };

  const row = r.row;
  const s = side === "buy" ? "long" : side === "sell" ? "short" : side;
  const view = usSessionView(now, stockKind(r.coin));
  const caps = leverageCaps(row, view);
  const notes = [];
  let margin = fin(marginUsdc) && marginUsdc > 0 ? marginUsdc : null;
  if (margin != null && margin > MAX_MARGIN_USDC) {
    margin = MAX_MARGIN_USDC;
    notes.push(guardText("margin_cap", lg));
  }
  let lev = fin(leverage) && leverage >= 1 ? Math.floor(leverage) : null;
  if (lev != null && caps.max != null && lev > caps.max) {
    lev = caps.max;
    notes.push(leverageNote(caps, r.ticker, lg));
  }
  /* 🔴 The guard decides, on the clamped figures; `listed: true` is the Stock pill's own verdict (resolveMarket
     found the row in stockMarkets), because the store's rows carry no spread for the guard's own gate. */
  const g = checkStockOrder({ row, side: s, marginUsdc: margin ?? NaN, leverage: lev ?? NaN, by: "agent", now, listed: true });
  const missing = g.refusals.filter((x) => x === "bad_margin" || x === "bad_leverage");
  const hard = g.refusals.filter((x) => x !== "bad_margin" && x !== "bad_leverage");
  let ask = null;
  if (missing.includes("bad_margin")) ask = lg === "th" ? `ใช้เงินกี่ USDC? (สูงสุด ${MAX_MARGIN_USDC})` : `How much USDC margin? (max ${MAX_MARGIN_USDC})`;
  else if (missing.includes("bad_leverage")) {
    ask = lg === "th"
      ? `leverage เท่าไหร่? ${r.ticker} ตอนนี้ได้สูงสุด ${caps.max ?? "—"}x`
      : `What leverage? ${r.ticker} goes up to ${caps.max ?? "—"}x right now`;
  }
  let fix = null;
  let text = null;
  if (hard.includes("min_value") && lev != null) {
    const need = Math.ceil((HL_MIN_ORDER_USD / lev) * 100) / 100;
    fix = need <= MAX_MARGIN_USDC ? { marginUsdc: need } : null;
    text = lg === "th"
      ? `${guardText("min_value", lg)}${fix ? ` ที่ ${lev}x ต้องใช้อย่างน้อย ${need} USDC` : ""}`
      : `${guardText("min_value", lg)}${fix ? ` At ${lev}x that is at least ${need} USDC of margin.` : ""}`;
  } else if (hard.length) {
    text = hard.map((x) => guardText(x, lg)).join(" ");
  }
  const warnings = g.warnings;
  return {
    ...base,
    ok: g.ok,
    coin: r.coin,
    ticker: r.ticker,
    name: r.name,
    side: s === "long" || s === "short" ? s : null,
    marginUsdc: margin,
    leverage: lev,
    maxLeverage: caps.max,
    notionalUsd: g.notionalUsd,
    refusals: g.refusals,
    warnings,
    warningTexts: warnings.map((w) => guardText(w, lg)),
    notes,
    ask: hard.length ? null : ask,
    text,
    fix,
    alternatives: hard.includes("held") || hard.includes("not_listed") ? stockAlternatives(markets, { exclude: r.coin }) : [],
    session: g.session,
  };
}

/* ── Setups and recommended TP / SL ─────────────────────────────────────────────────────────────────────────── */

/**
 * Core-session candles only, or null with fewer than RANGE_BARS of them (no stop is sized on a weekend's range;
 * recommendTpSl then recommends nothing rather than guess).
 */
export function stockCandles(candles) {
  const core = cleanCandles(coreSessionCandles(candles));
  return core.length >= RANGE_BARS ? core : null;
}

/**
 * What setups.js buildSetups needs for a stock: the listed row, the core-session candles and profiles whose leverage
 * is capped at min(SETUP_MAX_LEVERAGE, the stock's cap now).
 * @param {{ coin: string, candles: object[], markets: object[]|{markets: object[]}, now?: number }} o candles: 1h,
 *   STOCK_CANDLE_BARS of them
 * @returns {{ ok: true, market: object, candles: object[], profiles: object[], maxLeverage: number, basis: string,
 *   status: {en, th} } | { ok: false, why: "not-listed"|"no-leverage"|"few-core-candles", bars?: number, text?: string }}
 */
export function stockSetupsInput({ coin, candles, markets = [], now = Date.now() } = {}) {
  const r = resolveMarket(String(coin || ""), markets, { text: false });
  if (!r || r.kind !== "stock") return { ok: false, why: "not-listed" };
  if (!r.ok) return { ok: false, why: "not-listed", text: r.text };
  const f = stockFacts(r.coin, { markets, now });
  if (!f || f.setupMaxLeverage == null) return { ok: false, why: "no-leverage" };
  const core = cleanCandles(coreSessionCandles(candles));
  if (core.length < RANGE_BARS) return { ok: false, why: "few-core-candles", bars: core.length };
  const cap = f.setupMaxLeverage;
  return {
    ok: true,
    market: r.row,
    candles: core,
    profiles: PROFILES.map((p) => Object.freeze({ ...p, lev: Math.max(1, Math.min(p.lev, cap)) })),
    maxLeverage: cap,
    basis: STOCK_SETUP_BASIS,
    status: f.status,
  };
}

/** The listed stock coins, for a caller that needs the set (e.g. a gate on isHip3 rows). */
export const listedStockCoins = (markets) => new Set(stockMarkets(listOf(markets)).map((m) => m.coin));

/** Every stock FlowFlow lists by name (the whitelist), for copy that names a few. */
export const STOCK_NAMES = Object.freeze(STOCK_WHITELIST.map((w) => Object.freeze({ coin: w.coin, ticker: agentTicker(w.coin), name: stockDisplayName(w.coin), kind: w.kind })));
