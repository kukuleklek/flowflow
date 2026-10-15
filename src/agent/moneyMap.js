// FLOWFLOW'S MONEY MAP: where every product keeps the customer's money and how it moves, as the text the Agent's
// system prompt carries and as the figures get_funds returns. Pure: the account, the Spot Account reading and the
// prices come in; nothing is read, signed or moved here.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ทำความเข้าใจทั้งหมดหน่อย … ทำความเข้าใจทุกอย่างหรือยังวะ", and the decisions it rests on
// (USER-ADDENDUM, AGENT-STOCKS-AND-MAP item 1):
//   Main Account   Hyperliquid, all of it, in the customer's words: crypto perps AND stock perps (a stock position's
//                  margin is Main Account money: no separate stock balance, account or pot the customer sees), USDC
//                  kept apart inside it, and USDC on its way in from a deposit.
//   Spot Account   the coins on AVAX, with "USDC Staked · AAVE (AVAX)" as a holding inside it.
//   Balance        ONE total, Main + Spot; no split in the header.
//   Moves          Main ↔ Spot is a card the user confirms (internal: never Private); a stock order's margin moves by
//                  itself inside the order and comes back by itself on the close (no cap on that step, nothing to
//                  offer); Deposit / Withdraw carry the Normal | Private choice, for money from or to the OUTSIDE only.
// 🔴 NO PROVIDER, NO VENUE: the bridge, the swap route, the exchange and the stock market's deployer are never named
// (the only logos the owner allows are Tokenomist's and Avalanche's, and they are not words here). Checked by
// stockWords.js venueWordHits in scripts/test-agent-stocks.mjs.
// 🔴 UNKNOWN IS NULL, NEVER 0 (docs/MONEY_RULES.md section 0): a Spot Account that was not read is "not read", a coin
// with no price has no USD value, and a total with an unread part is null with a note — never a smaller number.
//
// SERVER-SAFE: api/chat.js builds the prompt from this file (through prompt.js), so it imports only pure leaves
// (guardrails.js, hip3/guard.js, perpTicket.js, lib/perpEquity.js, ./stockWords.js) — never the market store or the
// Avax money layer.
import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { CLOSED_AGENT_MAX_LEVERAGE } from "../lib/hyperliquid/hip3/guard.js";
import { HL_MIN_ORDER_USD } from "../perp/perpTicket.js";
import { perpLegOf } from "../lib/perpEquity.js";
import { stocksPrompt, isStockCoin, stockDisplayName, agentTicker } from "./stockWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);
const r6 = (v) => (fin(v) ? Math.round(v * 1e6) / 1e6 : null);
const num = (v, digits = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: digits });

export const MAIN_ACCOUNT = "Main Account";
export const SPOT_ACCOUNT = "Spot Account";
export const STAKED_NAME = "USDC Staked";
export const STAKED_WHERE = "AAVE (AVAX)";
export const STAKED_LABEL = `${STAKED_NAME} · ${STAKED_WHERE}`;

/** The map as data (the Agent's prompt says the same in words; a screen may list it). */
export const MONEY_MAP = Object.freeze({
  accounts: Object.freeze([
    Object.freeze({
      id: "main",
      name: MAIN_ACCOUNT,
      holds: Object.freeze([
        "USDC margin for crypto perps",
        "USDC margin for stock perps (part of the Main Account: no separate stock balance)",
        "USDC kept apart inside it (not trading margin)",
        "USDC on its way in from a deposit",
      ]),
      products: Object.freeze(["trade crypto", "trade stocks", "deposit", "withdraw"]),
    }),
    Object.freeze({
      id: "spot",
      name: SPOT_ACCOUNT,
      holds: Object.freeze(["coins on AVAX", `${STAKED_LABEL}, at a live variable APY`]),
      products: Object.freeze(["swap", "stake", "unstake"]),
    }),
  ]),
  balance: `Balance = ${MAIN_ACCOUNT} + ${SPOT_ACCOUNT}, one total`,
  moves: Object.freeze([
    Object.freeze({ id: "deposit", from: "outside", to: "main", how: "Deposit panel", modes: Object.freeze(["Normal", "Private"]) }),
    Object.freeze({ id: "withdraw", from: "main", to: "outside", how: "Withdraw panel; the user types the address", modes: Object.freeze(["Normal", "Private"]) }),
    Object.freeze({ id: "main_to_spot", from: "main", to: "spot", how: "a move card the user confirms; a little AVAX for gas is kept from the amount when the Spot Account has too little, and shown", modes: Object.freeze(["Normal"]) }),
    Object.freeze({ id: "spot_to_main", from: "spot", to: "main", how: "a move card the user confirms", modes: Object.freeze(["Normal"]) }),
    Object.freeze({ id: "stake", from: "spot", to: "staked", how: "a stake card", modes: Object.freeze(["Normal"]) }),
    Object.freeze({ id: "unstake", from: "staked", to: "spot", how: "an unstake card", modes: Object.freeze(["Normal"]) }),
    Object.freeze({ id: "swap", from: "spot", to: "spot", how: "a swap card, between the Spot Account's coins", modes: Object.freeze(["Normal"]) }),
    Object.freeze({ id: "stock_margin", from: "main", to: "main", automatic: true, how: "nothing to do: a confirmed stock order takes its margin from the Main Account by itself, and it comes back by itself when the position closes", modes: Object.freeze([]) }),
    Object.freeze({ id: "incoming", from: "outside", to: "main", automatic: true, how: "USDC arriving from a deposit joins the Main Account by itself", modes: Object.freeze([]) }),
  ]),
  /* Owner, 2026-10-15 ~14:30: Private never applies to a move between the user's own accounts (one Privy address on
     every chain: nothing to hide). */
  privateOnlyFor: Object.freeze(["deposit", "withdraw"]),
});

/**
 * The money map for the system prompt. Caps come in as the server resolved them (env may only LOWER them); the
 * defaults are the code's own.
 * @param {{ maxMarginUsdc?: number, maxLeverage?: number, closedStockMaxLeverage?: number, setupMaxLeverage?: number,
 *   maxMoveUsdc?: number, maxStakeUsdc?: number, now?: number|Date, stocks?: boolean }} [o]
 *   setupMaxLeverage: setups.js SETUP_MAX_LEVERAGE (min(3, the Agent cap); the suite holds them equal)
 *   maxMoveUsdc / maxStakeUsdc: src/avax/limits.js HARD (the server passes resolveLimits()'s, as prompt.js does)
 */
export function moneyMapPrompt({
  maxMarginUsdc = MAX_MARGIN_USDC, maxLeverage = AGENT_MAX_LEVERAGE, closedStockMaxLeverage = CLOSED_AGENT_MAX_LEVERAGE,
  setupMaxLeverage = Math.min(3, maxLeverage), maxMoveUsdc = 20, maxStakeUsdc = 20, now = Date.now(), stocks = true,
} = {}) {
  const map = `FlowFlow's money map. Say only "${MAIN_ACCOUNT}" and "${SPOT_ACCOUNT}"; the Balance is both together.
- ${MAIN_ACCOUNT}: all trading money, in USDC. It backs crypto perps AND stock perps: a stock position's margin is part of
  the ${MAIN_ACCOUNT}, never a separate balance or account. USDC on its way in from a deposit joins it by itself.
- ${SPOT_ACCOUNT}: coins on AVAX and, inside it, "${STAKED_LABEL}" at a live variable APY.
How money moves (each move is a card the user confirms; you never move money yourself):
- Deposit (from outside into the ${MAIN_ACCOUNT}) and Withdraw (from the ${MAIN_ACCOUNT} to an address the user types): the
  Deposit and Withdraw panels, with a Normal | Private choice. Private is only for money from or to the outside.
- ${MAIN_ACCOUNT} <-> ${SPOT_ACCOUNT}: a move card, at most ${maxMoveUsdc} USDC per move, never Private. When the ${SPOT_ACCOUNT} has too
  little AVAX for gas, the card keeps a little of the amount as AVAX in the user's own ${SPOT_ACCOUNT} and shows it.
- Stake / Unstake: ${SPOT_ACCOUNT} USDC <-> ${STAKED_NAME}, at most ${maxStakeUsdc} USDC per stake. Swap: between the ${SPOT_ACCOUNT}'s coins.
- Stocks: nothing to move. A confirmed stock order takes its margin from the ${MAIN_ACCOUNT} by itself and it comes back by
  itself when the position closes. Never offer a move for a stock.
Limits the app enforces: margin at most ${maxMarginUsdc} USDC per order; leverage at most ${maxLeverage}x (stocks: also the market's own
max, and ${closedStockMaxLeverage}x while the US market is closed); suggested setups at most ${setupMaxLeverage}x; orders at least $${HL_MIN_ORDER_USD} in size.
Sizes, stops and RR come from the app's tools, never from your own arithmetic.`;
  return stocks ? `${map}\n${stocksPrompt({ maxLeverage, closedMaxLeverage: closedStockMaxLeverage, now })}` : map;
}

/* ── The figures get_funds adds ─────────────────────────────────────────────────────────────────────────────── */

const isStockPosition = (coin) => typeof coin === "string" && (isStockCoin(coin) || coin.includes(":"));

/** A stock position in the customer's words: "Tesla", never a venue-qualified id. */
const stockWord = (coin) => stockDisplayName(coin, "en");

/**
 * The Main Account from the account layer (and readFunds' perp figures when given): one total that already counts
 * the stock positions, what is free, what backs open positions, and the stock positions by name.
 * @param {object|null} backend the perp backend ({ connected, account })
 * @param {object|null} [funds] readFunds() (its perp figures and the money on its way in)
 */
export function mainAccountView(backend, funds = null) {
  const acc = backend && backend.account ? backend.account : {};
  const bal = acc.perpBalanceUsdc || null;
  const known = !!(bal && bal.answered === true && fin(bal.equityUsdc));
  /* THE total is the home Balance's own Main leg (lib/perpEquity.js perpLegOf: equity, plus the USDC kept apart in
     standard mode), so the Agent and the header can never print two figures for one account. */
  const leg = perpLegOf(acc);
  const list = acc.positions && acc.positions.answered ? (acc.positions.list || []).filter((p) => p && fin(p.szi) && p.szi !== 0) : null;
  const sumMargin = (ps) => {
    let s = 0;
    for (const p of ps) {
      if (!fin(p.marginUsed)) return null;
      s += p.marginUsed;
    }
    return r2(s);
  };
  const stocks = list ? list.filter((p) => isStockPosition(p.coin)) : null;
  const crypto = list ? list.filter((p) => !isStockPosition(p.coin)) : null;
  const perp = funds && funds.perp ? funds.perp : null;
  const w = funds && funds.arbitrumWallet ? funds.arbitrumWallet : null;
  /* On its way in: the first deposit's hop waiting or moving, and deposits the watch follows. Unread parts: null. */
  let incoming = 0;
  let incomingKnown = !!funds;
  if (w) {
    if (w.usdc == null) incomingKnown = false;
    else if (w.waitingToMove || w.belowMinimum) incoming += w.usdc;
    if (w.movingUsdc != null && !w.waitingToMove) incoming += w.movingUsdc;
  }
  for (const d of (funds && funds.depositsOnTheWay) || []) {
    if (d && fin(d.amount) && (d.token == null || /usdc/i.test(d.token))) incoming += d.amount;
    else incomingKnown = false;
  }
  if (funds && funds.depositsUnread) incomingKnown = false;
  const read = fin(leg.usdc);
  return {
    name: MAIN_ACCOUNT,
    read,
    /* settling, partial or unknown: the figure is what was read, never "all there is". */
    partial: read && leg.state !== "known",
    totalUsdc: read ? r2(leg.usdc) : null,
    tradingUsdc: known ? r2(bal.equityUsdc) : null,
    freeUsdc: known && fin(bal.availableUsdc) ? r2(bal.availableUsdc) : null,
    inPositionsUsdc: list ? sumMargin(list) : null,
    inStockPositionsUsdc: stocks ? sumMargin(stocks) : null,
    keptApartUsdc: perp && fin(perp.inSpotUsdc) ? perp.inSpotUsdc : known && bal.source === "perp" && fin(bal.idleSpotUsdc) ? r2(bal.idleSpotUsdc) : null,
    incomingUsdc: incomingKnown ? r6(incoming) : null,
    cryptoPositions: crypto ? crypto.length : null,
    stockPositions: stocks ? stocks.map((p) => ({
      coin: p.coin,
      ticker: /xyz/i.test(agentTicker(p.coin)) ? null : agentTicker(p.coin),
      name: stockWord(p.coin),
      side: p.side || (p.szi > 0 ? "long" : "short"),
      marginUsdc: fin(p.marginUsed) ? r2(p.marginUsed) : null,
    })) : null,
  };
}

/**
 * The Spot Account from a reading shaped like lib/avax/read.js readAvaxAccount (assets[{symbol, amount}],
 * aave.suppliedUsdc). Not given (no reader) or null (the read failed): read:false, every figure null.
 * @param {object|null|undefined} spot
 * @param {{ apyPct?: number|null, priceOf?: (symbol: string) => number|null }} [o] priceOf: a coin's USD price from
 *   an independent source (the caller wires the Avax whitelist's peg / market mid); none → no USD value
 */
export function spotAccountView(spot, { apyPct = null, priceOf = null } = {}) {
  if (!spot || !Array.isArray(spot.assets)) {
    return { name: SPOT_ACCOUNT, read: false, coins: null, stakedUsdc: null, stakedLabel: STAKED_LABEL, apyPct: fin(apyPct) ? r2(apyPct) : null, totalUsdc: null, partial: false };
  }
  let total = 0;
  let partial = false;
  const coins = [];
  for (const a of spot.assets) {
    if (!a || typeof a.symbol !== "string") continue;
    if (!fin(a.amount)) { partial = true; continue; }
    if (a.amount <= 0) continue;
    /* USDC is counted as itself; any other coin only at a price the caller stands behind. */
    const px = a.symbol === "USDC" ? 1 : typeof priceOf === "function" ? priceOf(a.symbol) : null;
    const usd = fin(px) && px > 0 ? r2(a.amount * px) : null;
    if (usd == null) partial = true;
    else total += usd;
    coins.push({ symbol: a.symbol, amount: r6(a.amount), usdValue: usd });
  }
  const staked = spot.aave && fin(spot.aave.suppliedUsdc) ? r6(spot.aave.suppliedUsdc) : null;
  if (staked == null) partial = true;
  else total += staked;
  return {
    name: SPOT_ACCOUNT,
    read: true,
    coins,
    stakedUsdc: staked,
    stakedLabel: STAKED_LABEL,
    apyPct: fin(apyPct) ? r2(apyPct) : null,
    /* A coin with no price or an unread figure makes the total PARTIAL: the counted part, flagged, never "all". */
    totalUsdc: r2(total),
    partial,
  };
}

function mainSentence(m) {
  if (!m.read) return `Your ${MAIN_ACCOUNT} balance hasn't loaded yet.`;
  const parts = [];
  if (m.freeUsdc != null) parts.push(`${num(m.freeUsdc)} USDC free`);
  if (m.inPositionsUsdc != null && m.inPositionsUsdc > 0) parts.push(`${num(m.inPositionsUsdc)} USDC in open positions`);
  const lead = m.partial ? `Part of your ${MAIN_ACCOUNT} couldn't be read just now; the part that was read holds` : `Your ${MAIN_ACCOUNT} holds`;
  return `${lead} ${num(m.totalUsdc)} USDC${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}

function stockSentence(m) {
  const ps = m.stockPositions;
  if (!ps || !ps.length) return "";
  const named = ps.slice(0, 3).map((p) => `${p.name} ${p.side}`).join(", ");
  const margin = m.inStockPositionsUsdc != null ? `: ${num(m.inStockPositionsUsdc)} USDC of it backs ${ps.length === 1 ? "that position" : "those positions"}` : "";
  return `That includes your stock position${ps.length === 1 ? "" : "s"} (${named})${margin}.`;
}

function spotSentence(s) {
  if (!s.read) return `Your ${SPOT_ACCOUNT} wasn't checked just now.`;
  const parts = s.coins.map((c) => `${num(c.amount, 6)} ${c.symbol}`);
  if (s.stakedUsdc != null && s.stakedUsdc > 0) parts.push(`${num(s.stakedUsdc)} ${STAKED_NAME}${s.apyPct != null ? ` at ${num(s.apyPct)}% APY` : ""}`);
  if (!parts.length) return s.partial ? `Part of your ${SPOT_ACCOUNT} couldn't be read just now.` : `Your ${SPOT_ACCOUNT} is empty.`;
  return `Your ${SPOT_ACCOUNT} holds ${parts.join(", ")}${s.partial ? " (part of it couldn't be priced or read)" : ""}.`;
}

/**
 * The map's figures for get_funds, small and JSON-able: both accounts, the one Balance, and one plain summary.
 *
 *   funds    readFunds() (optional): its own summary already says what is on its way in and what to do next; this
 *            adds the stock positions and the Spot Account to it
 *   backend  the perp backend (account layer)
 *   spot     a readAvaxAccount-shaped reading, or null / undefined when there is none (then: not read)
 *
 * @returns {{ main_account: object, spot_account: object, balance_usdc: number|null, balance_note: string|null,
 *   summary: string }}
 */
export function moneyMapFor({ funds = null, backend = null, spot = null, apyPct = null, priceOf = null } = {}) {
  const m = mainAccountView(backend, funds);
  const s = spotAccountView(spot, { apyPct, priceOf });
  const whole = m.read && !m.partial && s.read && !s.partial;
  const balance = whole ? r2(m.totalUsdc + s.totalUsdc) : null;
  const note = whole ? null
    : !m.read ? `${MAIN_ACCOUNT} not read yet`
      : !s.read ? `${SPOT_ACCOUNT} not read; the ${MAIN_ACCOUNT} alone holds ${num(m.totalUsdc)} USDC`
        : "part of a balance couldn't be read or priced; the figures above are what was read";
  const lead = funds && typeof funds.summary === "string" && funds.summary ? funds.summary : mainSentence(m);
  return {
    main_account: {
      total_usdc: m.totalUsdc,
      free_usdc: m.freeUsdc,
      in_positions_usdc: m.inPositionsUsdc,
      in_stock_positions_usdc: m.inStockPositionsUsdc,
      kept_apart_usdc: m.keptApartUsdc,
      incoming_usdc: m.incomingUsdc,
      crypto_positions: m.cryptoPositions,
      stock_positions: m.stockPositions ? m.stockPositions.map((p) => ({ stock: p.name, ...(p.ticker ? { ticker: p.ticker } : {}), side: p.side, margin_usdc: p.marginUsdc })) : null,
      partial: m.partial,
    },
    spot_account: {
      read: s.read,
      coins: s.coins ? s.coins.map((c) => ({ symbol: c.symbol, amount: c.amount, usd_value: c.usdValue })) : null,
      usdc_staked: { amount: s.stakedUsdc, label: STAKED_LABEL, apy_pct: s.apyPct },
      total_usdc: s.totalUsdc,
      partial: s.partial,
    },
    balance_usdc: balance,
    balance_note: note,
    summary: [lead, stockSentence(m), spotSentence(s)].filter(Boolean).join(" "),
  };
}
