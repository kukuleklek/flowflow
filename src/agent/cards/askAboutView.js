// The trade page's Chat tab, empty (item 18; owner on /trade/HYPE: "ควรจะแบบ "Ask Me About (Logo) HYPE" แล้วมีกล่องแบบ
// Checking Emission Analytic with Tokenomist, Check News and trend, check tokenomic unlock to do position ไรงี้อะ"):
// the three compact boxes AskAboutCoin draws for THIS market, and the words each one says to the Agent. PURE.
//
//   crypto   Emission & unlocks (Analyze with [Tokenomist] when the key is on and Tokenomist covers the coin; else
//            "Unlocks" with a muted "Tokenomist not connected") · News & trend · Plan a position (held: Your position)
//   stock    US market · open / closed (hours.js; it runs the analysis, whose emission row is the market's state) ·
//            Earnings & news · Plan a position (held: Your position). Never Tokenomist on a stock.
//
// A box only says words, through the same path as typing (shortcuts, intents, then the model): nothing here signs,
// sends or moves money. The words name the ticker ("TSLA", "US 100"), never "xyz:TSLA".
import { coinLabel, isStockCoin, stockNameOf } from "./viewWords.js";

/** The words each box says (the integration lane's intents answer them; see the lane report). */
export const ASK_WORDS = Object.freeze({
  emissionTk: (l) => `Analyze ${l} with Tokenomist`,
  emission: (l) => `${l} unlocks`,
  market: (l) => `Analyze ${l}`,
  news: (l) => `News and trend for ${l}`,
  plan: (l) => `Setups for ${l}`,
  position: (l) => `Set TP SL for ${l}`,
});

/**
 * @param {{ coin: string, market?: object|null, held?: { pill: string, pnlText: string, pnlTone: string|null }|null,
 *   tokenomist?: boolean, us?: object|null }} o
 *   held        the position on this market (positionView), or null
 *   tokenomist  the build has the key on AND Tokenomist covers the coin (ChatActions tokenomistFor)
 *   us          usMarketView(now) for a stock; ignored for crypto
 * @returns {{ label: string, name: string|null, isStock: boolean,
 *   boxes: Array<{ id: string, title: string, sub: string, words: string, icon: string, mark: "tokenomist"|null,
 *   muted: boolean, tone: string|null }> }}
 */
export function askAboutView({ coin, market = null, held = null, tokenomist = false, us = null } = {}) {
  const c = typeof coin === "string" ? coin : "";
  const isStock = isStockCoin(c);
  const label = coinLabel(c, market) || c;
  const boxes = [];
  if (isStock) {
    boxes.push({
      id: "market",
      title: us ? us.label : "US market",
      sub: us && us.sub ? us.sub : "hours and trend",
      words: ASK_WORDS.market(label),
      icon: "clock",
      mark: null,
      muted: false,
      tone: us ? us.tone : null,
    });
    boxes.push({ id: "news", title: "Earnings & news", sub: "headlines · 1h / 4h / 1d", words: ASK_WORDS.news(label), icon: "news", mark: null, muted: false, tone: null });
  } else {
    /* 🔴 Tokenomist is named only when the key is on and it covers the coin: never a claim of data we cannot read. */
    boxes.push(tokenomist
      ? { id: "emission", title: "Emission & unlocks", sub: "Analyze with", words: ASK_WORDS.emissionTk(label), icon: "lock", mark: "tokenomist", muted: false, tone: null }
      : { id: "emission", title: "Unlocks", sub: "Tokenomist not connected", words: ASK_WORDS.emission(label), icon: "lock", mark: null, muted: true, tone: null });
    boxes.push({ id: "news", title: "News & trend", sub: "headlines · 1h / 4h / 1d", words: ASK_WORDS.news(label), icon: "news", mark: null, muted: false, tone: null });
  }
  if (held && typeof held === "object") {
    boxes.push({
      id: "position",
      title: "Your position",
      sub: [held.pill, held.pnlText].filter((s) => typeof s === "string" && s && s !== "—").join(" · ") || "TP / SL check",
      words: ASK_WORDS.position(label),
      icon: "target",
      mark: null,
      muted: false,
      tone: held.pnlTone === "pos" || held.pnlTone === "neg" ? held.pnlTone : null,
    });
  } else {
    boxes.push({ id: "plan", title: "Plan a position", sub: "TP / SL and RR set", words: ASK_WORDS.plan(label), icon: "target", mark: null, muted: false, tone: null });
  }
  return { label, name: isStock ? stockNameOf(c) : null, isStock, boxes };
}

/**
 * The composer chips for this market (the "Top movers" chip has no place here): handed to the Chat tab, which today
 * builds its chips in chips.js (not this lane's file; see the lane report). Pure, at most three.
 */
export function askAboutChips({ coin, market = null, held = false } = {}) {
  const label = coinLabel(coin, market) || coin;
  if (!label) return [];
  return [
    held ? { label: `TP / SL on ${label}`, text: ASK_WORDS.position(label), coin } : { label: `${label} setups`, text: ASK_WORDS.plan(label), coin },
    { label: `Analyze ${label}`, text: `Analyze ${label}`, coin },
    { label: "News", text: ASK_WORDS.news(label), glyph: "trendUp" },
  ];
}
