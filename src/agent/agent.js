// The Agent's loop (SPEC §2.1, plan v2 §2.5 "intent → plan → execute"), run in the browser:
//   user text → shortcuts (respond.js: "long ETH 20 5x", "top movers") → intents (intents.js: greetings, "any plan",
//   setups, staking, "analyze X") → POST /api/chat → the model answers text, or tool calls
//     read tool   → run here against Hyperliquid's public data and the user's account → result back → loop
//     info tool   → get_unlocks, get_analysis: a read that also shows an info card (no Confirm) → loop
//     action tool → a card in the chat (or a panel opened); the loop STOPS, and only the user's Confirm sends
// Every tool runs through ONE function, runToolCall (runTool.js, re-exported here), which voice mode uses too.
// At most MAX_STEPS model calls per message. The server holds the key and the prompt; this file holds no secret.
//
// BEFORE THE TRADE SHORTCUTS (pass 2): the answer to the plan's one question ("ยอมเสียได้กี่ดอล?" → "15"), a close-all
// ("ปิดทุก position", or "เอาหมดเลย" answering "Which market should I close?"), and a risk or a budget ("มี 300 ยอมเสียได้
// 15 ดอล short SOL RR 2", "risk $1 long HYPE": riskParse.js → tradePlan.js). Otherwise "risk $1 long ETH" would become a
// $1-margin trade card. After the crypto shortcuts: a stock in a trade sentence ("long TSLA 10 3x").
//
// THE WORDS SHOWN (owner, items 3 and 8): every line the model writes is scrubbed of the venue's words before it is
// shown (stocks.js scrubVenueWords), and after an action card the model's own prose is not shown at all: the card
// says what it is, and its state changes when the user taps ("BTC is still open…" above "BTC position closed" was a
// live bug). The line above a trade card is the card's own `reason` (why to trade, from the data), nothing else.
//
// NEVER A DEAD END (owner: "พิมห่าไรก็ควรแนะนำ Asset ขึ้นมาเลยดิ เป็นกล่องๆ พร้อมปุ่มเล็กๆเสมอ"): a turn that ends in
// words with no card gets the asset boxes (suggest.js) under it, and so does a model that is down, busy or slow.
//
// IT MUST NOT DIE AFTER USE. Every wait has an end: the call to /api/chat (FETCH_TIMEOUT_MS) and every tool
// (READ_TIMEOUT_MS). Every tool call the model makes gets a tool result in its history, even when the tool threw,
// timed out, or the account changed under it, because a call with no result makes the provider refuse every later
// turn. The loop always ends, and always gives `busy` back.
//
// ONE ACCOUNT, ONE AGENT (store.js). A loop belongs to the conversation that asked (its account, and that account's
// current chat). If the screen switches account while it runs, it stops at once: nothing more is shown or sent for
// the old account on the new one's screen, and the old account's history is closed with results for the calls it
// was making. If the user starts a New chat while it runs, it stops too, and nothing of it lands in the new chat
// (its results go nowhere: the history they belonged to is gone).
import { perpMarketsStore, fetchHlCandles } from "../lib/hyperliquid/index.js";
import { chat } from "./store.js";
import { isActionTool, isReadTool } from "./tools.js";
import { runToolCall, resolveCoin, chartFor, setupsCardFor, TOOL_FLAGS } from "./runTool.js";
import { HELP, respondLocally } from "./respond.js";
import { parseShortcut, findCoin, parseTpSl } from "./shortcuts.js";
import { detectIntent, runIntent, describeForModel, isCountsQuestion, longTradeIntent } from "./intents.js";
import { assetState, suggestAssets, assetsCard, onboardingLine, boxesWanted } from "./suggest.js";
import { peekEarnApy, readEarnApy } from "./earn.js";
import { mainMarkets } from "../trade/marketLists.js";
import { parseRisk, answerAsk, findPlanCoin } from "./riskParse.js";
import { detectCloseAll, ASK_CLOSE } from "./closeAll.js";
import { detectPick } from "./picks.js";
import { resolveMarket, stripStockNames, scrubVenueWords } from "./stocks.js";
import { analyzable } from "./analyze.js";

export { runToolCall };

const MAX_STEPS = 5;
/** The longest a model answer may take (the server may try several models within one call). */
export const FETCH_TIMEOUT_MS = 70_000;
/** The longest one tool may take. */
export const READ_TIMEOUT_MS = 15_000;
/** The longest a shortcut's trade card waits for the chart its recommended TP / SL comes from. */
export const SHORTCUT_CHART_MS = 3000;
/** The result a tool call gets when its answer never came. Same words as api/chat.js's repair. */
export const INTERRUPTED = "No result: the app was interrupted.";

/** The words a status step shows (ChatThread's work block reads `tool` + `coin` first, then these). */
export const STATUS = {
  get_markets: "Read markets",
  get_market: "Read market",
  get_candles: "Read chart",
  get_account: "Checked account",
  get_funds: "Checked your money",
  get_fills: "Read your trades",
  quote_trade: "Quoted trade",
  get_news: "Read news",
  get_unlocks: "Read unlocks",
  get_analysis: "Read charts",
  read_apy: "Read USDC Staked AAVE rate",
};

let runSeq = 0;

/* The last hop's runner (perp/deposit/perpFunding.js), loaded on first use: it reaches the wallet layer, which the
   Node suite does not load. Read only: its state for this wallet, never a move. */
let funding = null;
async function readMoveDefault(owner) {
  try {
    funding = funding || (await import("../perp/deposit/perpFunding.js"));
    const r = funding.perpFunding;
    const st = r && typeof r.getState === "function" ? r.getState() : null;
    if (!st || !st.user || st.user !== String(owner).toLowerCase() || typeof funding.fundingStep !== "function") return null;
    const canAuto = typeof r.canRun === "function" ? r.canRun(owner) : true;
    const s = funding.fundingStep(st, owner, { canAuto });
    return s ? { step: s.step, code: s.code, usdc: s.usdc, at: Number.isFinite(st.at) ? st.at : null } : null;
  } catch {
    return null;
  }
}

/**
 * The market a screen says the user is looking at, as the app names it, or null. 🔴 It comes from a URL
 * (/agent?coin=…), which anyone can write into a link: only a live market's own name ever reaches the model as app
 * context, never the text as typed.
 */
export function contextCoinOf(coin, snapshot) {
  if (typeof coin !== "string" || !coin.trim() || coin.length > 32) return null;
  try {
    const m = resolveCoin(coin, snapshot);
    if (m) return m.coin;
    const byCoin = snapshot && snapshot.byCoin ? snapshot.byCoin : {};
    return Object.prototype.hasOwnProperty.call(byCoin, coin) && /^[A-Za-z0-9:._-]{1,24}$/.test(coin) ? coin : null;
  } catch {
    return null;
  }
}

/**
 * The context every tool runs with (runToolCall's ctx), for the text loop and for voice mode.
 * @param {{ backend: object, getSnapshot?: Function, fetchCandles?: Function, funds?: object, toolFetch?: typeof fetch,
 *   readApy?: Function, readUnlocks?: Function, readEmission?: Function, tokenomist?: boolean, earnEnabled?: boolean,
 *   readTimeoutMs?: number, step?: Function|null, noTpSl?: boolean }} o
 *   toolFetch: what reaches our /api/tokenomist and the Avalanche RPC (never the chat endpoint's fetch)
 *   noTpSl: the user said "no tp sl": a trade card gets no recommended TP / SL
 */
/* The Spot Account's reading for get_funds (lib/avax/read.js: one eth_call to Avalanche), loaded on first use and only
   in a browser: the Node suite never reaches the chain. Read only. */
const readSpotDefault = typeof window === "undefined" ? null : async (owner) => {
  try {
    const { readAvaxAccount } = await import("../lib/avax/read.js");
    return await readAvaxAccount(owner);
  } catch {
    return null;
  }
};

export function toolCtxFrom({
  backend, getSnapshot = () => perpMarketsStore().getSnapshot(), fetchCandles = fetchHlCandles, funds = null,
  toolFetch = undefined, readApy = null, readUnlocks = null, readEmission = null, readNews = null, tokenomist = TOOL_FLAGS.tokenomist,
  earnEnabled = TOOL_FLAGS.earnEnabled, readTimeoutMs = READ_TIMEOUT_MS, step = null, noTpSl = false,
} = {}) {
  return {
    get snapshot() { return getSnapshot(); },
    backend,
    fetchCandles: (c, interval, opts) => fetchCandles(c, interval, { bars: opts && opts.bars ? opts.bars : 24 }),
    funds: { readMove: readMoveDefault, ...(readSpotDefault ? { readSpot: readSpotDefault } : {}), ...(funds || {}) },
    ...(toolFetch ? { fetchImpl: toolFetch } : {}),
    ...(readApy ? { readApy } : {}),
    ...(readUnlocks ? { readUnlocks } : {}),
    ...(readEmission ? { readEmission } : {}),
    ...(readNews ? { readNews } : {}),
    tokenomist: !!tokenomist,
    earnEnabled: !!earnEnabled,
    readTimeoutMs,
    step,
    ...(noTpSl ? { noTpSl: true } : {}),
  };
}

/* The market a step looked at, as the app names it (so the thread can draw its logo); null when none or unknown. */
function stepCoin(args, snapshotOf) {
  try {
    if (!args || typeof args.coin !== "string") return null;
    const m = resolveCoin(args.coin, snapshotOf());
    return m ? m.coin : null;
  } catch {
    return null;
  }
}

/** A tool result as the model reads it. Never throws (a BigInt or a cycle becomes words). */
export function toolContent(result) {
  try {
    return JSON.stringify(result === undefined ? { error: "No result." } : result, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return JSON.stringify({ error: "The result could not be read." });
  }
}

/** fn's answer, or { error } when it throws, takes longer than ms, or the run stops. Never rejects. */
export function settleWithin(fn, ms, signal = null) {
  return new Promise((resolve) => {
    let done = false;
    let t = null;
    const onStop = () => finish({ error: INTERRUPTED });
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onStop);
      resolve(v);
    }
    if (signal && signal.aborted) { finish({ error: INTERRUPTED }); return; }
    t = setTimeout(() => finish({ error: "That took too long. Try again in a moment." }), ms);
    if (signal) signal.addEventListener("abort", onStop, { once: true });
    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    p.then(
      (v) => finish(v && typeof v === "object" ? v : { error: "No result." }),
      (e) => finish({ error: String((e && e.message) || e || "Failed.") }),
    );
  });
}

/* One call to /api/chat, with an end: the timeout, or the run stopping. A fetch that ignores the abort signal still
   loses the race. Resolves { status, body } or { failed: "timeout" | "network" | "stopped" }. */
async function post(messages, fetchImpl, { signal, timeoutMs }) {
  const ctrl = new AbortController();
  let why = null;
  const quit = (w) => { if (!why) { why = w; ctrl.abort(); } };
  const t = setTimeout(() => quit("timeout"), timeoutMs);
  const onStop = () => quit("stopped");
  if (signal.aborted) quit("stopped"); else signal.addEventListener("abort", onStop, { once: true });
  const aborted = new Promise((_, reject) => {
    if (ctrl.signal.aborted) reject(new Error("aborted"));
    else ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => {});
  try {
    const r = await Promise.race([
      fetchImpl("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: ctrl.signal,
      }),
      aborted,
    ]);
    let body = null;
    try { body = await Promise.race([r.json(), aborted]); } catch { body = null; }
    if (why) return { failed: why };
    return { status: r.status, body };
  } catch {
    return { failed: why || "network" };
  } finally {
    clearTimeout(t);
    signal.removeEventListener("abort", onStop);
  }
}

/* A status step in the chat, bound to one run: running, then done (or error). Words for tools the thread does not
   name itself ride in `text`. Returns finish(ok). */
function stepper(run, alive) {
  const open = new Set();
  const step = (tool, coin = null, words = null) => {
    if (!alive()) return () => {};
    const w = words || {};
    const sid = chat.push({ role: "status", text: w.run || STATUS[tool] || "Read data", tool, coin: coin || null, run, state: "running" });
    let ended = false;
    const finish = (ok = true) => {
      if (ended) return;
      ended = true;
      open.delete(finish);
      chat.patch(sid, { state: ok ? "done" : "error", ...(ok ? (w.done ? { text: w.done } : STATUS[tool] ? { text: STATUS[tool] } : {}) : w.fail ? { text: w.fail } : {}) });
    };
    open.add(finish);
    return finish;
  };
  /* A tool that ran out of time leaves no step spinning. */
  step.closeAll = () => { for (const f of [...open]) f(false); };
  return step;
}

/* The asset boxes under an answer, from the live state. Never throws. */
function boxesCard(ctx, { surface = "after", focus = [] } = {}) {
  try {
    const items = suggestAssets(assetState({
      backend: ctx.backend, snapshot: ctx.snapshot, apyPct: peekEarnApy(), earnEnabled: ctx.earnEnabled, tokenomist: ctx.tokenomist,
    }), { surface, focus });
    return items.length ? assetsCard(items) : null;
  } catch {
    return null;
  }
}

/**
 * The Agent page's empty state, from real state (owner: "เป็นกล่องกลมๆ มีรูป Asset หรือปุ่มแนะนำ"): the onboarding line,
 * the asset boxes and the setups for the best candidates. Reads only; never rejects (a part that could not be read
 * is left out: setups null when no chart could be read, apyPct null when Aave could not be read).
 * @returns {Promise<{ line: string, assets: object, setups: object|null, apyPct: number|null }>}
 */
export async function homeCards({
  backend, getSnapshot = () => perpMarketsStore().getSnapshot(), fetchCandles = fetchHlCandles, readApy = null, toolFetch,
  tokenomist = TOOL_FLAGS.tokenomist, earnEnabled = TOOL_FLAGS.earnEnabled, lang = "en", focus = [], readTimeoutMs = 8000,
} = {}) {
  const ctx = toolCtxFrom({ backend, getSnapshot, fetchCandles, readApy, toolFetch, tokenomist, earnEnabled, readTimeoutMs });
  const [apy, setups] = await Promise.all([
    (readApy ? Promise.resolve().then(readApy) : readEarnApy({ fetchImpl: toolFetch })).catch(() => null),
    /* One featured market's three profiles (Safer / Balanced / Bolder), not three markets' "Balanced" alike. */
    setupsCardFor(ctx, { focus, featured: true }).catch(() => null),
  ]);
  const apyPct = apy && Number.isFinite(apy.apyPct) ? apy.apyPct : null;
  let state = null;
  try {
    state = assetState({ backend, snapshot: ctx.snapshot, apyPct, earnEnabled, tokenomist });
  } catch {
    state = assetState({ backend, snapshot: { markets: [], byCoin: {} }, apyPct, earnEnabled, tokenomist });
  }
  return {
    line: onboardingLine(state, lang),
    assets: assetsCard(suggestAssets(state, { surface: "empty", focus })),
    setups: setups && setups.ok ? setups.card : null,
    apyPct,
  };
}

/**
 * @param {string} text the user's message (already shown in the chat)
 * @param {{ coin?: string|null, backend: object, navigate?: (to: string) => void, fetchImpl?: typeof fetch,
 *   funds?: object, fetchTimeoutMs?: number, readTimeoutMs?: number, intents?: boolean, suggest?: boolean,
 *   toolFetch?: typeof fetch, readApy?: Function, readUnlocks?: Function, tokenomist?: boolean, earnEnabled?: boolean }} ctx
 *   fetchImpl: the /api/chat call only. funds: readers handed to get_funds (funds.js readFunds), for tests.
 *   intents: answer greetings / plans / staking / analyze / setups without the model (default true).
 *   suggest: asset boxes under a text-only answer and when the model is down (default true).
 *   subject: what an Analyze pill sat on ({ setup } or { card }), handed over with its words (read only).
 */
export async function askAgent(text, {
  coin = null, backend, navigate = () => {}, fetchImpl = globalThis.fetch,
  getSnapshot = () => perpMarketsStore().getSnapshot(), fetchCandles = fetchHlCandles,
  funds = null, fetchTimeoutMs = FETCH_TIMEOUT_MS, readTimeoutMs = READ_TIMEOUT_MS,
  intents = true, suggest = true, toolFetch, readApy = null, readUnlocks = null, readEmission = null,
  tokenomist = TOOL_FLAGS.tokenomist, earnEnabled = TOOL_FLAGS.earnEnabled, subject = null, intent = null, readNews = null,
  scope = null,
} = {}) {
  /* Only a live market's name is context (A6): a link's ?coin= text never speaks for the app. */
  let snapNow = null;
  try { snapNow = getSnapshot(); } catch { snapNow = null; }
  coin = contextCoinOf(coin, snapNow);
  const account = chat.account();
  /* "account#cid": the conversation this loop answers in. */
  const owner = chat.conversation();
  const stop = new AbortController();
  const unsub = chat.subscribe(() => { if (chat.conversation() !== owner && !stop.signal.aborted) stop.abort(); });
  const alive = () => !stop.signal.aborted && chat.conversation() === owner;
  chat.setBusy(true);
  try {
    const base = { backend, getSnapshot, fetchCandles, funds, toolFetch, readApy, readUnlocks, readEmission, readNews, tokenomist, earnEnabled, readTimeoutMs };
    const handled = intent ? await tryIntent(text, { coin, base, owner, alive, given: intent }) : intents ? await tryIntent(text, { coin, base, owner, alive, subject }) : false;
    if (!handled) {
      await loop(text, {
        coin, navigate, fetchImpl, fetchTimeoutMs, readTimeoutMs, owner, stop, alive, base, suggest, scope: typeof scope === "string" && scope ? scope : null,
      });
    }
  } catch (e) {
    if (alive()) chat.push({ role: "assistant", text: scrubVenueWords(`Something went wrong: ${String((e && e.message) || e)}. ${HELP}`), tone: "error" });
  } finally {
    unsub();
    if (chat.account() === account) chat.setBusy(false);
  }
}

/* The app's own answer for a known intent (intents.js), with its work shown. The model's history learns what was
   shown, so a later question can refer to it. Returns false when the sentence is not one of them. */
async function tryIntent(text, { coin, base, owner, alive, subject = null, given = null }) {
  let snap = null;
  try { snap = base.getSnapshot(); } catch { snap = null; }
  const coins = snap ? mainMarkets(snap.markets || []).map((m) => m.coin) : [];
  const intent = given || detectIntent(text, { coins, contextCoin: coin, markets: snap ? snap.markets || [] : null });
  if (!intent) return false;
  const run = `run${++runSeq}`;
  const step = stepper(run, alive);
  const ctx = toolCtxFrom({ ...base, step });
  const io = {
    step,
    alive,
    say: (t, extra) => { if (alive()) chat.push({ role: "assistant", text: t, ...(extra || {}) }); },
    card: (c) => { if (alive()) chat.push({ role: "card", card: c }); },
  };
  const out = await runIntent(intent, { ctx, io, contextCoin: coin, subject: intent.kind === "analyze" ? subject : null });
  step.closeAll();
  /* The plan asked its one question: the next message in this conversation is read as its answer first. */
  pendingPlan = out.pending ? { conv: owner, parse: out.pending, at: Date.now() } : null;
  chat.pushLlmTo(owner, { role: "user", content: coin ? `${text}\n\n[context: the user is looking at the ${coin} market]` : text }, { role: "assistant", content: out.summary });
  return true;
}

/* ── before the shortcuts ───────────────────────────────────────────────────────────────────────────────────── */

/** How long the plan's one question waits for its answer. */
export const PENDING_PLAN_MS = 10 * 60_000;
let pendingPlan = null;

/* The newest FlowFlow line before the user's message, and the question it asked (respond.js marks "Which market should
   I close?" with ask "close"). */
function lastAsk() {
  const list = chat.get().messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role === "user") continue;
    return m.role === "assistant" && typeof m.ask === "string" ? m.ask : null;
  }
  return null;
}

/* A short reply that can only be an answer: a number, a side, a market, a "%" or "$"; not a sentence of its own. */
function answers(t, coins) {
  const s = String(t || "").trim();
  if (!s || (/[฀-๿]/.test(s) ? s.length > 40 : s.split(/\s+/).length > 8)) return false;
  if (parseShortcut(s, coins)) return false;
  return /\d|ดอล|เปอร์|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย|long|short|ลอง|ชอร์ต|ซื้อ|ขาย|\$|%/i.test(s) || !!findPlanCoin(s, coins);
}

/**
 * The app's own answer that must run BEFORE the trade shortcuts, as an intent for runIntent, or null.
 *   1. the answer to the plan's one question (riskParse answerAsk)
 *   2. close all (closeAll.js), including "เอาหมดเลย" answering "Which market should I close?"
 *   3. a risk or a budget: the sized plan (riskParse → tradePlan), or the setups when only levels are asked
 */
export function preIntent(t, { coins = [], snapshot = null, coin = null, owner = null, backend = null } = {}) {
  const pend = pendingPlan && pendingPlan.conv === owner && Date.now() - pendingPlan.at < PENDING_PLAN_MS ? pendingPlan : null;
  pendingPlan = null;
  if (pend && answers(t, coins)) {
    const merged = answerAsk(pend.parse, t, { coins });
    /* "S&P 500" answering "Which coin or stock?" is the index, never the S coin (the first-message branch below does
       the same with the shared resolver). */
    if (snapshot) {
      let r = null;
      try { r = resolveMarket(t, snapshot.markets || [], { text: true }); } catch { r = null; }
      if (r && r.kind === "stock" && r.coin && r.coin !== merged.coin) Object.assign(merged, { coin: r.coin, coinKind: "stock", coinFrom: "text" });
    }
    if (!merged.coin && coin) Object.assign(merged, { coin, coinFrom: "context" });
    return { kind: "riskPlan", parse: { ...merged, ask: merged.ask }, lang: pend.parse.lang || "en" };
  }
  const b = backend || {};
  const held = b.account && b.account.positions && b.account.positions.answered
    ? (b.account.positions.list || []).filter((p) => p && Number.isFinite(p.szi) && p.szi !== 0).map((p) => p.coin) : [];
  const ca = detectCloseAll(t, { coins, held, askedWhich: lastAsk() === ASK_CLOSE });
  if (ca) return ca;
  /* "how many stocks can I trade?" is a count, not a pick (eval B-Q3 got the stock pick card and no number). */
  if (isCountsQuestion(t)) return null;
  /* "Long a meme", "Short a stock": a group to pick from, before the trade shortcut reads "meme" as the MEME market. */
  const pick = detectPick(t, { coins });
  if (pick) return pick;
  const p = parseRisk(t, { coins, contextCoin: coin });
  /* The market by the shared resolver (stocks.js: crypto first, but "S&P 500" is the index, never the S coin). */
  if (p.mode && p.coinFrom === "text" && snapshot) {
    let r = null;
    try { r = resolveMarket(t, snapshot.markets || [], { text: true }); } catch { r = null; }
    if (r && r.kind === "stock" && r.coin && r.coin !== p.coin) Object.assign(p, { coin: r.coin, coinKind: "stock" });
  }
  if (p.mode === "plan") return { kind: "riskPlan", parse: p, lang: p.lang };
  if (p.mode === "setups" && p.coin) {
    /* "ตั้ง SL ETH 2300" names a LEVEL: the user's own TP / SL card (shortcuts), never the recommended one in its place
       (eval X4: the 2300 was dropped for a recommended SL at $2,322). */
    let sc = null;
    try { sc = parseShortcut(t, coins); } catch { sc = null; }
    const typed = sc && (sc.tpPct != null || sc.slPct != null || sc.tpPx != null || sc.slPx != null);
    if (typed && (sc.kind === "tpsl" || sc.kind === "open")) return null;
    return { kind: "setups", coin: p.coin, side: p.side, movers: false, lang: p.lang };
  }
  return null;
}

/* The placeholder a stock's name becomes so the trade parser (shortcuts.js, crypto names only) reads the sentence. */
const STOCK_SLOT = "ZQSTOCKQZ";

/**
 * A stock in a trade sentence ("long TSLA 10 3x", "ซื้อ Tesla 10 ดอล", "short S&P 500 10 2x"), as an intent: the trade
 * card after the stock limits (intents.js "trade"), or the refusal for a paused / unlisted one. The stock's own
 * names are taken out first, so the index's "500" is never read as the margin. Null: no stock, or no trade.
 */
export function stockTradeIntent(t, snapshot) {
  let r = null;
  try { r = resolveMarket(t, (snapshot && snapshot.markets) || [], { text: true }); } catch { r = null; }
  if (!r || (r.kind !== "stock" && r.kind !== "unlisted")) return null;
  const lang = /[฀-๿]/.test(t) ? "th" : "en";
  /* The slot goes FIRST: a number right before a market's name reads as a size in that market ("long 0.5 ETH"). */
  const refPx = r.row && Number.isFinite(r.row.px) && r.row.px > 0 ? r.row.px : null;
  const sc = parseShortcut(`${STOCK_SLOT} ${stripStockNames(t, r.coin)}`, [STOCK_SLOT], { refPxOf: () => refPx });
  if (!sc || sc.kind !== "open" || sc.coin !== STOCK_SLOT) return null;
  if (!r.ok) return { kind: "stockRefused", refusal: r, side: sc.side, lang };
  return {
    kind: "trade", coin: r.coin, side: sc.side, marginUsdc: sc.marginUsdc, leverage: sc.leverage,
    tpPct: sc.tpPct, slPct: sc.slPct,
    /* "sl $400": the typed PRICE rides on, so the recommended legs never replace it. */
    ...(Number.isFinite(sc.tpPx) ? { tpPx: sc.tpPx } : {}), ...(Number.isFinite(sc.slPx) ? { slPx: sc.slPx } : {}),
    ...(sc.pxRead ? { pxRead: true } : {}), ...(sc.noTpSl ? { noTpSl: true } : {}), lang,
  };
}

/**
 * The whole answer to one message, for the chat screen: the plan's answer, close-all and risk plans first, then the
 * trade shortcuts (a trade card gets its recommended TP / SL from the 1h chart, fetched for it), a stock trade, then
 * intents, then the model. The screen pushes the user's message and calls this; nothing else. Never rejects.
 * @param {string} text
 * @param {object} o askAgent's options (coin, backend, navigate, …)
 */
export async function handleMessage(text, o = {}) {
  const t = String(text || "").trim();
  if (!t) return;
  const owner = chat.conversation();
  const getSnapshot = o.getSnapshot || (() => perpMarketsStore().getSnapshot());
  let snap = null;
  try { snap = getSnapshot(); } catch { snap = null; }
  const coin = contextCoinOf(o.coin, snap);
  if (snap) {
    const coins = mainMarkets(snap.markets || []).map((m) => m.coin);
    let pre = null;
    try { pre = preIntent(t, { coins, snapshot: snap, coin, owner, backend: o.backend }); } catch { pre = null; }
    /* A long "open NVDA, what TP / SL, how much?" is that market's setups before the trade parser, which read its
       "position" as the account summary. */
    if (!pre) {
      try { pre = longTradeIntent(t, { coins, markets: snap.markets || [] }); } catch { pre = null; }
    }
    if (pre) {
      await askAgent(t, { ...o, coin, intent: pre });
      return;
    }
    /* 🔴 A STOCK NAMED IN THE SENTENCE BEFORE THE CRYPTO PARSER (pass-2 review): "long S&P 500 10 2x" was read by the
       crypto parser as the S coin (findCoin splits "S&P" into S and P), 500 as the margin, and became a 20 USDC long on
       Sonic. The shared resolver (stocks.js) names the market first; a crypto the parser found that is only a piece of
       the stock's name is dropped (an open then goes to the stock trade below, a close / TP / SL to the stock). */
    let named = null;
    try { named = resolveMarket(t, snap.markets || [], { text: true }); } catch { named = null; }
    const stockNamed = named && (named.kind === "stock" || named.kind === "unlisted") ? named : null;
    const pxOf = (c) => (snap.byCoin && snap.byCoin[c] && Number.isFinite(snap.byCoin[c].px) && snap.byCoin[c].px > 0 ? snap.byCoin[c].px : null);
    let sc = parseShortcut(t, coins, { refPxOf: pxOf });
    if (stockNamed && sc && sc.coin && (sc.kind === "open" || sc.kind === "close" || sc.kind === "tpsl")) {
      let again = null;
      try { again = stockNamed.coin ? findCoin(stripStockNames(t, stockNamed.coin), coins) : null; } catch { again = null; }
      if (!again) sc = sc.kind === "open" ? null : { ...sc, coin: null };
    }
    /* "close TSLA": the crypto parser found a close but no crypto; a held stock named in it is the market. */
    let stockCoin = null;
    if (sc && (sc.kind === "close" || sc.kind === "tpsl") && !sc.coin) stockCoin = stockNamed && stockNamed.ok ? stockNamed.coin : null;
    if (sc) {
      let candles = null;
      if (sc.kind === "open" && sc.tpPct == null && sc.slPct == null && sc.tpPx == null && sc.slPx == null && !sc.noTpSl && (Number.isFinite(sc.marginUsdc) || Number.isFinite(sc.sizeCoin))) {
        chat.setBusy(true);
        try {
          const ctx = toolCtxFrom({ backend: o.backend, getSnapshot, fetchCandles: o.fetchCandles || fetchHlCandles, readTimeoutMs: Math.min(o.readTimeoutMs || SHORTCUT_CHART_MS, SHORTCUT_CHART_MS) });
          candles = await chartFor(ctx, sc.coin, { quiet: true });
        } catch {
          candles = null;
        } finally {
          chat.setBusy(false);
        }
      }
      let local = { handled: false, messages: [] };
      try {
        local = respondLocally(t, {
          markets: snap.markets, byCoin: snap.byCoin, backend: o.backend, coin,
          ...(stockNamed && !sc.coin ? { stockOnly: true } : {}),
          ...(stockCoin ? { stockCoin } : {}),
          ...(candles ? { candlesOf: () => candles } : {}),
          ...(typeof o.tokenomist === "boolean" ? { tokenomist: o.tokenomist } : {}),
        });
      } catch {
        local = { handled: false, messages: [] };
      }
      if (local.handled) {
        if (chat.conversation() !== owner) return;
        for (const m of local.messages) chat.push(m);
        chat.pushLlm({ role: "user", content: t }, { role: "assistant", content: describeForModel(local.messages) });
        return;
      }
    }
    const st = stockTradeIntent(t, snap);
    if (st) {
      await askAgent(t, { ...o, coin, intent: st });
      return;
    }
  }
  await askAgent(t, { ...o, coin });
}

async function loop(text, o) {
  const { coin, navigate, fetchImpl, owner, stop, alive, base } = o;
  chat.pushLlmTo(owner, { role: "user", content: coin ? `${text}\n\n[context: the user is looking at the ${coin} market]` : text });
  /* One id for this message's steps: the thread groups them, and shows each one running, then done. */
  const run = `run${++runSeq}`;
  const step = stepper(run, alive);
  /* Plain tools run silent (the loop shows their one step); setups, stake and unlocks show their own reads. "no tp sl"
     in the user's words: the model's trade card gets no recommended TP / SL either. */
  const noTpSl = parseTpSl(text).noTpSl;
  const quietCtx = toolCtxFrom({ ...base, step: null, noTpSl });
  const stepCtx = toolCtxFrom({ ...base, step, noTpSl });
  const answer = (id, result) => chat.pushLlmTo(owner, { role: "tool", tool_call_id: id, content: toolContent(result) });
  /* After a trade card the user cannot confirm for lack of money, the model gets ONE more turn to say where the
     money is. If that turn never comes, the funds summary is said instead. */
  let explain = null;
  /* The markets this turn is about (the asset boxes under the answer put them first), and whether a card that asks
     for the user's move is on screen (then no boxes). */
  const focus = [];
  const addFocus = (c) => { if (typeof c === "string" && c && !focus.includes(c)) focus.push(c); };
  let acted = false;
  /* Markets whose analysis card is already in this answer: no Analyze pill asking for it again. */
  const analyzed = new Set();

  const readStep = async (name, args) => {
    /* The info tools show their own reads (the charts, the unlocks) as steps. */
    if (name === "get_unlocks" || name === "get_analysis") {
      const r = await settleWithin(() => runToolCall(name, args, stepCtx), o.readTimeoutMs, stop.signal);
      step.closeAll();
      return r && "result" in r ? r : { result: r };
    }
    const c = stepCoin(args, () => quietCtx.snapshot);
    addFocus(c);
    const sid = chat.push({ role: "status", text: STATUS[name] || "Read data", tool: name, coin: c, run, state: "running" });
    const r = await settleWithin(() => runToolCall(name, args, quietCtx), o.readTimeoutMs, stop.signal);
    const out = r && "result" in r ? r : { result: r };
    chat.patch(sid, { state: out.result && out.result.error ? "error" : "done" });
    return out;
  };

  const boxes = () => {
    if (!o.suggest || acted || !alive() || !boxesWanted(chat.get().messages, text)) return;
    const userCoin = (() => {
      try { return findCoin(text, mainMarkets(quietCtx.snapshot.markets || []).map((m) => m.coin)); } catch { return null; }
    })();
    const card = boxesCard(quietCtx, { surface: "after", focus: [...focus, userCoin, coin].filter(Boolean) });
    if (card && alive()) chat.push({ role: "card", card });
  };

  const sayInstead = (line, tone) => {
    if (!alive()) return;
    if (explain && explain.summary) chat.push({ role: "assistant", text: explain.summary });
    else chat.push({ role: "assistant", text: line, ...(tone ? { tone } : {}) });
    boxes();
  };

  /* The Analyze pill rides on an answer about exactly one market (always: owner, 2026-10-15; it says "with
     Tokenomist" only when the key is on and Tokenomist covers the coin). */
  const analyzeFor = () => {
    if (focus.length !== 1 || typeof focus[0] !== "string" || !analyzable(focus[0]) || analyzed.has(focus[0])) return null;
    return { coin: focus[0] };
  };

  for (let turn = 0; turn < MAX_STEPS; turn++) {
    if (!alive()) return;
    /* A market's Chat tab (scope): the model reads only that market's own history (item 21); the FlowFlow page, all. */
    const llm = chat.get().llm;
    const res = await post(o.scope ? llm.filter((m) => m && m.scope === o.scope) : llm, fetchImpl, { signal: stop.signal, timeoutMs: o.fetchTimeoutMs });
    if (!alive()) return;
    if (res.failed) {
      sayInstead(res.failed === "timeout" ? `FlowFlow took too long to answer. Try again. ${HELP}` : `I can't reach FlowFlow's model right now. ${HELP}`, "error");
      return;
    }
    if (res.status === 503 || res.status === 404) {
      sayInstead(`FlowFlow's model isn't set up on this server yet, so I only understand shortcuts. ${HELP}`);
      return;
    }
    const raw = res.body && res.body.message;
    if (res.status !== 200 || !raw || typeof raw !== "object") {
      sayInstead((res.body && typeof res.body.message === "string" && res.body.message) || "The model didn't answer. Try again.", "error");
      return;
    }

    const msg = { ...raw, role: "assistant", content: typeof raw.content === "string" ? raw.content : "" };
    chat.pushLlmTo(owner, msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c) => c && typeof c.id === "string") : [];
    /* 🔴 What the user reads never names the venue a stock trades on (owner: "คนไม่ต้องรู้ห่าอะไรเลย"): rewritten where a
       plain name exists, the sentence dropped where none does. The model's history keeps its own words. */
    const said = scrubVenueWords(msg.content.trim(), { fallback: "" });
    if (!calls.length) {
      const pill = said ? analyzeFor() : null;
      if (said) chat.push({ role: "assistant", text: said, ...(pill ? { analyze: pill } : {}) });
      if (!said && explain && explain.summary) chat.push({ role: "assistant", text: explain.summary });
      boxes();
      return;
    }
    /* 🔴 ITEM 8: a step that makes an action card shows no prose of the model's: the card says what it is, and its
       state (filled, closed, cancelled) is the truth once the user taps. Prose beside read-only steps still shows. */
    const carding = calls.some((c) => isActionTool(c.function && c.function.name));
    if (said && !carding) chat.push({ role: "assistant", text: said });

    let waitForUser = false;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (!alive()) {
        /* The account changed: close its history so its next turn is accepted, and show nothing here. */
        for (const c of calls.slice(i)) answer(c.id, { error: INTERRUPTED });
        return;
      }
      const name = call.function && call.function.name;
      let args = {};
      try { args = JSON.parse((call.function && call.function.arguments) || "{}") || {}; } catch { args = {}; }
      if (!args || typeof args !== "object") args = {};
      let result;
      try {
        if (isReadTool(name)) {
          const r = await readStep(name, args);
          result = r.result;
          /* An info card (unlocks) shows, and the loop goes on. */
          if (r.card && alive()) {
            chat.push({ role: "card", card: r.card });
            addFocus(r.card.coin);
            if (r.card.kind === "analysis") analyzed.add(r.card.coin);
          }
        } else if (isActionTool(name)) {
          if (explain) {
            result = { error: "A trade card the user cannot confirm yet is already on screen. Do not show another card or open a panel now: explain where their money is and what happens next, and offer the Deposit panel in words if they need it." };
          } else {
            const r0 = await settleWithin(() => runToolCall(name, args, stepCtx), o.readTimeoutMs, stop.signal);
            step.closeAll();
            const r = r0 && "result" in r0 ? r0 : { result: r0 };
            const ok = !!(r.result && !r.result.error);
            /* The card's `reason` (why to trade, from the data read) is the one line above a trade or a setups card.
               A close, a TP / SL or a close-all card gets none: a line about the position's state would go stale the
               moment the user taps (item 8). */
            const why = ["propose_open", "propose_setups", "propose_stake", "plan_trade", "propose_picks"].includes(name);
            /* 🔴 A card the caps changed (20 USDC, 10x) shows the card's own capped note instead: the model wrote its
               reason before the clamp ("Long ETH 50 USDC 15x, liquidation ~$2,280"), and that line would contradict
               the card under it (item 8). */
            const reason = why && !r.capped && typeof args.reason === "string" ? scrubVenueWords(args.reason.trim().slice(0, 280), { fallback: "" }) : "";
            if (ok && r.card && reason && alive()) chat.push({ role: "assistant", text: reason });
            if (ok && r.card && alive()) {
              chat.push({ role: "card", card: r.card });
              addFocus(r.card.coin);
              acted = true;
            }
            let opened = true;
            if (ok && r.navigate) {
              try { navigate(r.navigate); acted = true; } catch { opened = false; acted = false; }
            }
            result = !ok ? r.result
              : opened ? r.result
                : { error: "The panel could not be opened here. Tell the user to open it from the Wallet page." };
            if (ok && opened) waitForUser = true;
            if (ok && r.fundsShort && alive()) {
              const f = (await readStep("get_funds", {})).result;
              result = { ...result, funds: f };
              explain = { summary: f && typeof f.summary === "string" && !f.error ? f.summary : null };
            }
          }
        } else {
          result = { error: `Unknown tool ${name}` };
        }
      } catch (e) {
        result = { error: String((e && e.message) || e || "Failed.") };
      }
      answer(call.id, result);
    }
    /* A card is on screen: the next move is the user's (once the model has said where the money is, if it must). */
    if (waitForUser && !explain) return;
    if (waitForUser && explain && explain.asked) return;
    if (explain) explain.asked = true;
  }
  sayInstead("That took too many steps. Try a narrower question.");
}
