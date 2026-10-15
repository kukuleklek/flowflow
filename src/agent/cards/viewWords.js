// The few words and figures every pass-2 Agent card shares (PickCard, FinalTradeSheet, CloseAllCard, AskAboutCoin):
// what a market is called on screen, a signed percent, the reward-to-risk, and the words the Agent never says.
// PURE: no React, no network, no env.
import { perpCoinLabel, usdcText } from "../../perp/live/perpLiveView.js";
import { STOCK_WHITELIST } from "../../lib/hyperliquid/hip3/whitelist.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const STOCKS = new Map(STOCK_WHITELIST.map((w) => [w.coin, w]));

/** Is this a stock (or index) market? Only a whitelisted one counts; any other "dex:NAME" is not drawn as a stock. */
export const isStockCoin = (coin) => typeof coin === "string" && STOCKS.has(coin);

/** "Tesla", "US 100 index" — the company or index name of a stock market, else null. */
export const stockNameOf = (coin) => (STOCKS.get(coin) || {}).name || null;

/** "index" | "stock" | null. */
export const stockKindOf = (coin) => (STOCKS.get(coin) || {}).kind || null;

/**
 * What a market is called on a card: the bare ticker ("BTC", "TSLA").
 * 🔴 The index the deployer names "XYZ100" is "US 100" here: its ticker carries the venue's name, which the owner bans
 * from anything the customer reads ("คนไม่ต้องรู้ห่าอะไรเลย"), and it is never "Nasdaq-100" (the deployer never calls it
 * that). Display only: the coin itself ("xyz:XYZ100") is what every action carries.
 */
export function coinLabel(coin, market = null) {
  if (coin === "xyz:XYZ100") return "US 100";
  const l = perpCoinLabel(coin, market);
  return l || "";
}

/**
 * A line from the order layer in the customer's words (pass-2 review): the index's venue ticker is "US 100" ("Longed
 * XYZ100 · 2x" in the toast and on the big P&L card), and the money is in the Main Account, never "your Perp balance /
 * Perp account" or "from Hyperliquid" (USER-ADDENDUM: two accounts, Main and Spot). Display only.
 */
export function customerWords(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(/\bxyz:XYZ100\b|\bXYZ100\b/g, "US 100")
    .replace(/\b([Yy]our) Perp balance\b/g, "$1 Main Account balance")
    .replace(/\bPerp balance\b/g, "Main Account balance")
    .replace(/\b([Yy]our) Perp account\b/g, "$1 Main Account")
    .replace(/\bPerp account\b/gi, "Main Account")
    .replace(/\s+from Hyperliquid\b/g, "")
    .replace(/\bon Hyperliquid\b/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** The pair a card's head prints: "ETH-USD" for crypto, the bare ticker for a stock ("TSLA", "US 100"). */
export const pairLabel = (coin, market = null) => (isStockCoin(coin) ? coinLabel(coin, market) : `${coinLabel(coin, market)}-USD`);

/** A fee as the card and the popup both print it: "≈ 0.02 USDC", and under a cent "< 0.01 USDC" (never "≈ <0.01"). */
export function feeWords(fee) {
  if (!fin(fee) || fee < 0) return "—";
  if (fee < 0.005) return "< 0.01 USDC";
  return `≈ ${usdcText(fee)}`;
}

/** "+3.21%" / "−1.40%" (typographic minus) / "0.00%"; the dash for unknown. */
export function pctText(v, dp = 2) {
  if (!fin(v)) return "—";
  const r = Number(Math.abs(v).toFixed(dp));
  if (r === 0) return `${(0).toFixed(dp)}%`;
  return `${v > 0 ? "+" : "−"}${r.toFixed(dp)}%`;
}

/** "pos" | "neg" | null (flat under half of the last printed digit). */
export function toneOfPct(v, dp = 2) {
  if (!fin(v) || Math.abs(v) < 0.5 * 10 ** -dp) return null;
  return v > 0 ? "pos" : "neg";
}

/** "1 : 2.0" — the same spelling as the setups boxes and the trade card. */
export const rrText = (rr) => (fin(rr) && rr > 0 ? `1 : ${rr.toFixed(1)}` : "—");

/* 🔴 WORDS THE AGENT NEVER SAYS (owner via the HIP-3 session, brief §1.3): the venue, the dex, the pot behind a stock,
   and the index's wrong name. A line the app shows in its own voice that carries one is not shown (the caller falls
   back to a plain line). Third-party headlines are NOT filtered: they are someone else's words, shown as titles. */
export const BANNED_WORDS = Object.freeze([
  /\bhip-?3\b/i, /\bxyz\b/i, /trade\s*\[\s*xyz\s*\]/i, /\bdex(es)?\b/i, /\bvenues?\b/i, /\bpots?\b/i, /กอง/, /nasdaq[\s-]?100/i,
  /builder[\s-]?deployed/i,
]);

/** Does this text carry a banned word? */
export function hasBannedWord(text) {
  const t = String(text == null ? "" : text);
  return BANNED_WORDS.some((re) => re.test(t));
}
