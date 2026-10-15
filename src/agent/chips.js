// THE FOLLOW-UP CHIPS under the Agent's thread (review, polish 1: a static "Long ETH 20 5x tp 25% sl 10%" right after
// an analysis that called ETH down read like a command line and contradicted the card). They follow the newest card on
// screen: what the reader is most likely to say next about it.
//
//   analysis   held: TP / SL on it, Analyze another held coin; not held: its setups (they follow the trend's side)
//   trade card held: TP / SL on it; else its setups. Then My PnL, Top movers
//   setups     Analyze that market
//   stake      setups, Top movers, My PnL
//   pick       the other groups (a stock, a meme), then Top movers
//   nothing    the page's market: TP / SL when held, else one trade chip in words at 3x or less ("Long ETH · 20 USDC
//              · 3x"), never on a side the newest analysis of that market called down; and its setups
//
// Pure. A chip is { label, text, coin?, glyph?, icon? }: label is what it reads, text what it says to the Agent (the
// same path as typing: a trade chip only fills a card that waits for Confirm). Never a fixed 5x trade, never a HIP-3
// venue market (the analysis and setups read main markets only), at most four.
import { analyzable } from "./analyze.js";
import { agentTicker } from "./stockWords.js";

export const CHIP_TRADE_USDC = 20;
export const CHIP_TRADE_LEVERAGE = 3;
export const MAX_CHIPS = 4;

const MOVERS = Object.freeze({ label: "Top movers", text: "Top movers", glyph: "trendUp" });
const PNL = Object.freeze({ label: "My PnL", text: "My PnL", icon: "wallet" });
/* The name a chip says: the ticker for a stock ("TSLA", "US100"), never a venue-qualified id (owner: no venue words);
   intents.js reads the ticker back. The chip keeps the coin itself for its logo. */
const T = (c) => agentTicker(c);
const tpsl = (c) => ({ label: `TP / SL on ${T(c)}`, text: `Set TP SL for ${T(c)}`, coin: c });
const analyze = (c) => ({ label: `Analyze ${T(c)}`, text: `Analyze ${T(c)}`, coin: c });
const setups = (c) => ({ label: `${T(c)} setups`, text: `Setups for ${T(c)}`, coin: c });
const news = (c) => ({ label: `${T(c)} news`, text: `News and trend for ${T(c)}`, coin: c });
const trade = (c, side) => {
  const t = `${side === "sell" ? "Short" : "Long"} ${T(c)} · ${CHIP_TRADE_USDC} USDC · ${CHIP_TRADE_LEVERAGE}x`;
  return { label: t, text: t, coin: c };
};

/* The side an analysis card leans against: "buy" when its 4h / 1d trend is down (no more longs), "sell" when up. */
function calledDown(card) {
  const tr = (card && card.trend) || {};
  const dirs = [tr.h4, tr.d1].filter(Boolean).map((t) => t.dir);
  if (dirs.includes("down")) return "buy";
  if (dirs.includes("up")) return "sell";
  return null;
}

/**
 * @param {{ cards?: object[], coin?: string|null, held?: string[] }} o
 *   cards: the thread's cards, newest first; coin: the page's market; held: the coins with an open position
 * @returns {{ label: string, text: string, coin?: string, glyph?: string, icon?: string }[]}
 */
export function chipsFor({ cards = [], coin = null, held = [], compact = false } = {}) {
  /* A market's own Chat tab (owner item 18: "Chips under the composer become coin-specific too, no Top movers there"):
     only this market's next steps, whatever the newest card. */
  if (compact && analyzable(coin)) {
    const mine = (Array.isArray(held) ? held : []).includes(coin);
    const list = [mine ? tpsl(coin) : setups(coin), analyze(coin), news(coin)];
    return list.slice(0, MAX_CHIPS);
  }
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && typeof c === "object");
  const own = (Array.isArray(held) ? held : []).filter(analyzable);
  const isHeld = (c) => own.includes(c);
  const other = (c) => own.find((x) => x !== c) || null;
  const out = [];
  const add = (chip) => {
    if (!chip || out.length >= MAX_CHIPS || out.some((x) => x.text === chip.text)) return;
    if (chip.coin && !analyzable(chip.coin)) return;
    out.push(chip);
  };
  const last = list[0] || null;
  const k = last ? last.kind || "open" : null;
  const c = last && analyzable(last.coin) ? last.coin : null;

  if (k === "analysis" && c) {
    if (last.held || isHeld(c)) add(tpsl(c));
    else add(setups(c));
    if (other(c)) add(analyze(other(c)));
  } else if ((k === "open" || k === "tpsl" || k === "close") && c) {
    add(isHeld(c) ? tpsl(c) : setups(c));
    if (other(c)) add(analyze(other(c)));
    add(PNL);
  } else if (k === "setups") {
    const one = c || (Array.isArray(last.setups) && last.setups[0] && analyzable(last.setups[0].coin) ? last.setups[0].coin : null);
    if (one) add(analyze(one));
  } else if (k === "pick") {
    /* A pick card's chips follow it (pass-2 review: they stayed on the page's market): the other groups to pick from. */
    const g = last.group || null;
    if (g !== "stocks") add({ label: "Pick a stock", text: "Pick a stock", glyph: "layers" });
    if (g !== "meme") add({ label: "Pick a meme", text: "Pick a meme", glyph: "trendUp" });
    if (g === "stocks") add({ label: last.side === "sell" ? "Long a stock" : "Short a stock", text: last.side === "sell" ? "Long a stock" : "Short a stock", glyph: last.side === "sell" ? "trendUp" : "trendDown" });
  } else if (k === "stake") {
    add(setups(analyzable(coin) ? coin : "ETH"));
  } else {
    const c0 = analyzable(coin) ? coin : "ETH";
    if (isHeld(c0)) {
      add(tpsl(c0));
      add(analyze(c0));
    } else {
      /* Never more of a side the newest analysis of this market called down: its trend's side, else a long. */
      const seen = list.find((x) => x.kind === "analysis" && x.coin === c0) || null;
      add(trade(c0, calledDown(seen) === "buy" ? "sell" : "buy"));
      add(setups(c0));
    }
  }
  add(MOVERS);
  add(PNL);
  return out;
}
