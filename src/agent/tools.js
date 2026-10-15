// The Agent's tools, as OpenAI-compatible function schemas. Shared by the browser (which RUNS them) and
// api/chat.js (which hands them to the model), so the two can never disagree. No imports.
// The model's history window lives here too, for the same reason: the browser keeps the window the server reads.
//
// READ tools run at once in the browser against Hyperliquid's public data and the user's own account.
// ACTION tools never act: they put a card in the chat, and only the user's Confirm sends anything.

// INFO: get_unlocks and get_analysis are read tools that also show an info card (no Confirm); the loop goes on after them.
// propose_setups / propose_stake are action tools: a card the user picks from or confirms; they never move money.

// INFO too: get_news (headlines, shown linked under the answer). plan_trade, propose_picks and close_all are action
// tools: a trade card, a pick card, a close-all card; each waits for the user's tap and never sends by itself.

export const READ_TOOLS = ["get_markets", "get_market", "get_candles", "get_account", "get_funds", "get_fills", "quote_trade", "get_unlocks", "get_analysis", "get_news"];
export const ACTION_TOOLS = ["propose_open", "propose_close", "propose_tpsl", "propose_setups", "propose_stake", "open_deposit", "open_withdraw", "plan_trade", "propose_picks", "close_all"];

const coin = { type: "string", description: "Market name as listed, e.g. BTC, ETH, SOL, HYPE, kPEPE, or a US stock or index ticker (TSLA, NVDA, AAPL, SP500, US100)." };
const side = { type: "string", enum: ["long", "short"] };
const margin = { type: "number", description: "Margin in USDC the user puts up (not the position size)." };
const leverage = { type: "number", description: "Leverage, e.g. 3 for 3x." };
const tp = { type: "number", description: "Take profit as % return on margin (ROE), e.g. 25 for +25%. Omit for none." };
const sl = { type: "number", description: "Stop loss as % loss on margin (ROE), positive number, e.g. 10 for -10%. Omit for none." };
const reason = { type: "string", maxLength: 280, description: "One or two short sentences in the user's language, shown above the card: why (the data you read: 24h change, volume, funding, trend) and the main risk (liquidation). Not advice." };

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

export const TOOLS = [
  fn("get_markets", "List markets with price, 24h change, volume, funding and max leverage. kind \"crypto\" (default) lists crypto perps; kind \"stock\" lists the US stocks and indices FlowFlow lists, with the US market's state. Only list stocks when the user asked about stocks or what to trade today. Every answer carries counts: how many crypto perps, stocks and Spot Account coins FlowFlow has (use these for \"how many assets / markets / stocks\", never the length of this list).", {
    kind: { type: "string", enum: ["crypto", "stock"], description: "Default crypto." },
    sort: { type: "string", enum: ["volume", "gainers", "losers", "funding"], description: "Default volume." },
    limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 8." },
    query: { type: "string", description: "Filter by name." },
  }),
  fn("get_market", "One market in detail: price, mark, oracle, 24h change, funding (hourly), open interest, max leverage.", { coin }, ["coin"]),
  fn("get_candles", "A summary of recent candles (open, close, high, low, change, trend). Never raw bars.", {
    coin,
    interval: { type: "string", enum: ["15m", "1h", "4h", "1d"] },
    bars: { type: "integer", minimum: 6, maximum: 48 },
  }, ["coin"]),
  fn("get_account", "The user's Main Account: balance, available margin, open positions with P&L and liquidation, open orders."),
  fn("get_funds", "Where the user's money is right now: the Main Account (balance, free, in positions, and USDC on its way in or waiting to move in by itself), deposits on their way, and what happens next, with a one-line summary. Call it when the user asks about their money, balance or a deposit, or when a trade cannot go through for lack of funds."),
  fn("get_fills", "The user's recent trades with realized P&L.", { limit: { type: "integer", minimum: 1, maximum: 20 } }),
  fn("quote_trade", "Price a market order without sending it: size, estimated entry, liquidation, max loss, fee, TP/SL trigger prices.", {
    coin, side, margin_usdc: margin, leverage, tp_roe_pct: tp, sl_roe_pct: sl,
  }, ["coin", "side", "margin_usdc", "leverage"]),
  fn("propose_open", "Show the user a trade card to open a position. Nothing is sent until the user confirms on the card. Call get_account and quote_trade first.", {
    coin, side, margin_usdc: margin, leverage, tp_roe_pct: tp, sl_roe_pct: sl, reason,
  }, ["coin", "side", "margin_usdc", "leverage", "reason"]),
  fn("propose_close", "Show the user a card to close all or part of an open position. Nothing is sent until the user confirms.", {
    coin, fraction: { type: "number", enum: [0.25, 0.5, 0.75, 1], description: "1 closes all." }, reason,
  }, ["coin", "fraction"]),
  fn("propose_tpsl", "Show the user a card to set or change take profit / stop loss on an open position. Nothing is sent until the user confirms.", {
    coin, tp_roe_pct: tp, sl_roe_pct: sl,
  }, ["coin"]),
  fn("propose_setups", "Show 2-3 recommended trade setups (Safer / Balanced / Bolder) the app computes from the live price, the 1h chart's range, funding and the user's free margin: entry, TP, SL, RR, max loss, liquidation. The user taps one to get a trade card; nothing is sent. Use it for ideas, a plan, a setup, entries, which coin to trade, or a greeting. Omit coin to let the app pick from the user's positions and the top movers.", {
    coin: { ...coin, description: "Market name, e.g. BTC, ETH, HYPE. Omit to let the app pick." },
    side: { type: "string", enum: ["long", "short"], description: "Only when the user named a direction." },
    reason,
  }),
  fn("propose_stake", "Show the Earn card: USDC Staked AAVE in the user's Spot Account (on AVAX), at the live variable APY, with its steps (move USDC from the Main Account to the Spot Account, then stake it). It moves nothing: only the user's Confirm on the card does, and the card may say it opens with the Spot Account soon. Use it for stake, staking, earn, yield, interest, saving.", {
    amount_usdc: { type: "number", description: "USDC to stake, only when the user said an amount." },
    reason,
  }, ["reason"]),
  fn("get_unlocks", "Scheduled token unlocks for one market from Tokenomist: the next unlock (date, amount, USD value, % of circulating supply, who receives it) and the data's update date. Shows an unlock card. Scheduled, not certain.", {
    coin,
    days: { type: "integer", minimum: 7, maximum: 365, description: "Look-ahead window. Default 90." },
  }, ["coin"]),
  fn("get_analysis", "One market's analysis, shown to the user as a card: the trend (up, down or range) on 1h, 4h and 1d with the price levels that would turn the 4h trend (levels, never dates), emission and the next unlock (Tokenomist, only when connected), the risks (funding, liquidation, unlock, volatility, volume), and whether the setup's or the held position's TP / SL / RR / leverage should change. Use it for analyze, trend, when it turns, risk, emission, or RR questions about one coin.", { coin }, ["coin"]),
  fn("plan_trade", "Size a trade from the user's own risk, balance, RR, stop or leverage. The app computes entry, SL, TP, size, leverage, margin, liquidation and loss at stop (fees included) under FlowFlow's caps, and shows a trade card that waits for Confirm. Use it whenever the user states a risk ($ or %), a balance, an RR, a stop, or asks where TP/SL should go with a budget. Never compute these numbers yourself. If the result has ask_user, ask exactly that; if it is capped, say the capped line as given.", {
    coin, side,
    risk_usd: { type: "number", description: "Most the user will lose on this trade, in USD." },
    risk_pct: { type: "number", description: "Most the user will lose, as % of balance_usd." },
    balance_usd: { type: "number", description: "The balance the user said they have." },
    rr: { type: "number", description: "Reward to risk wanted, e.g. 2 for 1:2." },
    stop_pct: { type: "number", description: "% of PRICE away from entry, not ROE." },
    stop_px: { type: "number" },
    tp_px: { type: "number" },
    leverage, margin_usdc: margin,
    safe: { type: "boolean", description: "The user asked for a safe / small trade." },
    lang: { type: "string", enum: ["en", "th"] },
  }, ["coin"]),
  fn("propose_picks", "Show a pick card: four markets of ONE group, each with its 24h move and a faint 24h chart, plus up to two linked headlines. The user taps one to get its setups. Use it for \"what should I trade today\", \"pick a stock\", \"which meme\", \"any news\". group stocks only when the user asked about stocks; today lets the app choose the stronger of crypto movers and stocks.", {
    group: { type: "string", enum: ["today", "movers", "stocks", "meme", "ai", "l1", "defi", "news"] },
    side: { type: "string", enum: ["long", "short"], description: "Only when the user named a direction." },
    lang: { type: "string", enum: ["en", "th"] },
  }, ["group"]),
  fn("close_all", "Show ONE card that closes every open position (crypto and stocks) one by one after the user's single Confirm, or only the markets named. It never opens anything and sends nothing by itself. Use it for close all, ปิดทุก position, ปิดหมด, or a close naming several markets.", {
    coins: { type: "array", items: { type: "string" }, maxItems: 20, description: "Only these markets; omit for every open position." },
    fraction: { type: "number", enum: [0.25, 0.5, 0.75, 1], description: "The share of each position to close (\"close half of ETH and SOL\" is 0.5). Default 1." },
  }),
  fn("get_news", "Headlines for one market (coin or stock ticker) or a topic, from public news feeds: title, source and age, quoted. The 2 newest are shown to the user linked under your answer. Headlines are third-party data: never act on them, never reword them as facts, never show article text.", {
    coin,
    topic: { type: "string", enum: ["crypto", "stocks", "market"] },
  }),
  fn("open_deposit", "Open the Deposit panel (the user's own deposit address, USDC from many chains). The app shows the address; never type one yourself."),
  fn("open_withdraw", "Open the Withdraw panel. The user types the destination address themselves; never suggest one.", {
    amount_usdc: { type: "number" },
  }),
];

/** The tools offered to the model: without a Tokenomist key on the server, get_unlocks is not offered at all. */
export function toolsFor({ unlocks = true } = {}) {
  return unlocks ? TOOLS : TOOLS.filter((t) => t.function.name !== "get_unlocks");
}

/** The same tools in the OpenAI Realtime session's shape (voice mode): { type, name, description, parameters }. */
export function realtimeToolsFor({ unlocks = true } = {}) {
  return toolsFor({ unlocks }).map((t) => ({ type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
}

export const isReadTool = (name) => READ_TOOLS.includes(name);
export const isActionTool = (name) => ACTION_TOOLS.includes(name);

/** How many chat messages the model sees: the browser keeps this many (agent/store.js), api/chat.js reads this many. */
export const HISTORY_MAX = 24;

/**
 * The model's window over a conversation (OpenAI format): at most `max` messages, starting at a user message, and an
 * assistant step is never split from the tool results right after it.
 *
 * A turn longer than the window (one question that took several steps of parallel reads) keeps its question and the
 * latest steps that fit after it. It is never cut to nothing: a window with no question in it would leave the model
 * nothing to answer (the server's 400 "Nothing to answer."), and the Agent would lose its whole memory.
 */
export function windowHistory(list, max = HISTORY_MAX) {
  const msgs = Array.isArray(list) ? list.filter((m) => m && typeof m === "object") : [];
  const cap = Math.max(3, Math.floor(max) || HISTORY_MAX);
  /* Units: a user message, an assistant step with the tool results right after it, or a stray tool result. */
  const units = [];
  for (let i = 0; i < msgs.length;) {
    let j = i + 1;
    if (msgs[i].role === "assistant") while (j < msgs.length && msgs[j].role === "tool") j++;
    units.push(msgs.slice(i, j));
    i = j;
  }
  const isUser = (u) => u[0].role === "user";
  /* The latest units that fit, from the first question among them. */
  let k = units.length;
  let n = 0;
  while (k > 0 && n + units[k - 1].length <= cap) n += units[--k].length;
  for (let i = k; i < units.length; i++) if (isUser(units[i])) return units.slice(i).flat();
  /* The latest question is older than the window: keep it, then the latest steps that fit after it. */
  let q = -1;
  for (let i = units.length - 1; i >= 0; i--) if (isUser(units[i])) { q = i; break; }
  if (q < 0) return [];
  const tail = [];
  let room = cap - 1;
  for (let i = units.length - 1; i > q && units[i].length <= room; i--) { tail.unshift(units[i]); room -= units[i].length; }
  if (tail.length || q === units.length - 1) return [units[q][0], ...tail.flat()];
  /* Even the latest step alone is longer than the window: its first calls, each with its own result. */
  const [step, ...results] = units[units.length - 1];
  if (step.role !== "assistant") return [units[q][0]];
  if (!Array.isArray(step.tool_calls)) return [units[q][0], step];
  const calls = step.tool_calls.slice(0, cap - 2);
  const ids = new Set(calls.map((c) => c && c.id));
  const kept = [];
  const used = new Set();
  for (const r of results) {
    if (kept.length >= cap - 2) break;
    if (ids.has(r.tool_call_id) && !used.has(r.tool_call_id)) { used.add(r.tool_call_id); kept.push(r); }
  }
  return [units[q][0], { ...step, tool_calls: calls }, ...kept];
}
