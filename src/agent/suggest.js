// THE ASSET BOXES the Agent shows on its empty page and under its answers (owner: "พิมห่าไรก็ควรแนะนำ Asset ขึ้นมาเลยดิ
// เป็นกล่องๆ พร้อมปุ่มเล็กๆเสมอ" — "ไอที่แนะนำ ควายมากเลย ทำสวยๆหน่อย เป็นกล่องกลมๆ มีรูป Asset หรือปุ่มแนะนำ").
//
// Pure: the account, the markets and the USDC Staked AAVE APY come in; 3–5 items come out, each from REAL state, never
// a generic sentence: open positions (P&L, near liquidation), the user's free USDC in the Main Account, earn (USDC
// Staked AAVE in the Spot Account), the market in focus and the top movers. Each item has 1–3 small actions.
// Every market box carries Analyze (owner, 2026-10-15: always visible; it says "with Tokenomist" only when the key is
// on and Tokenomist covers the coin). A position's first action is the safe next step (TP / SL), never Close.
//
// "assets" card (shared contract): { kind:"assets", items:[{ coin|"USDC", kind:"mover"|"position"|"earn"|"held"|"setup",
//   title, figure, sub, tone:"pos"|"neg"|"neutral", actions:[{ id, label, prompt?, to? }] }] }
// An action carries what a tap does: `prompt` (text the chat sends for the user, which the Agent answers) or `to`
// (a route the app opens). Nothing is sent or signed by a tap: every money action ends in a card with Confirm.
// Ids: analyze | long | short | setups | stake | tpsl | close | chart | deposit.
// 🔴 Unknown is "—", never 0.
import { formatHlPct, formatHlPrice, formatHlUsdCompact } from "../lib/hyperliquid/format.js";
import { perpCoinLabel, liqGap } from "../perp/live/perpLiveView.js";
import { topMovers, mainMarkets } from "../trade/marketLists.js";
import { isCovered } from "../lib/tokenomist/slugs.js";
import { coinLabel } from "./cards/viewWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const DASH = "—";
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);
const usd2 = (v) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdc = (v) => `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;

/** How near liquidation a position must be for its box to warn (percent of price). */
export const NEAR_LIQ_PCT = 5;
/** Free USDC at or above this is "idle" (worth a box). */
export const IDLE_MIN_USDC = 5;
export const SURFACE_LIMIT = Object.freeze({ empty: 4, after: 3, movers: 5, account: 4, plan: 2 });

/**
 * The state the boxes are built from, read off the backend and the market snapshot. Every figure null when unread.
 * 🔴 A balance read only in part (complete:false: a venue did not answer) is NOT known: its total is a floor, so it is
 * never "empty" / "0 USDC" (funds.js says "being checked" for the same case). Free USDC that was not read
 * (availableUsdc null) stays null: the whole balance is not "free to use".
 * @param {{ backend: object, snapshot: object, apyPct?: number|null, earnEnabled?: boolean, tokenomist?: boolean }} o
 */
export function assetState({ backend, snapshot, apyPct = null, earnEnabled = false, tokenomist = false } = {}) {
  const b = backend || {};
  const acc = (b.connected && b.account) || {};
  const bal = acc.perpBalanceUsdc;
  const partial = !!(bal && bal.answered === true && bal.complete === false);
  const known = !!(bal && bal.answered === true && fin(bal.equityUsdc) && !partial);
  const byCoin = (snapshot && snapshot.byCoin) || {};
  const orders = acc.orders && acc.orders.answered ? acc.orders.list || [] : null;
  const raw = acc.positions && acc.positions.answered ? (acc.positions.list || []).filter((p) => p && fin(p.szi) && p.szi !== 0) : null;
  const positions = raw == null ? null : raw.map((p) => {
    const m = byCoin[p.coin] || null;
    const side = p.side === "short" || (p.side !== "long" && p.szi < 0) ? "short" : "long";
    const mark = m && fin(m.markPx) ? m.markPx : m && fin(m.px) ? m.px : null;
    const gap = liqGap({ side, px: mark, liqPx: fin(p.liquidationPx) ? p.liquidationPx : null });
    return {
      coin: p.coin,
      side,
      leverage: p.leverage && fin(p.leverage.value) ? p.leverage.value : null,
      entryPx: fin(p.entryPx) ? p.entryPx : null,
      markPx: mark,
      pnlUsdc: fin(p.unrealizedPnl) ? r2(p.unrealizedPnl) : null,
      roePct: fin(p.returnOnEquity) ? r2(p.returnOnEquity * 100) : null,
      liqPx: fin(p.liquidationPx) ? p.liquidationPx : null,
      liqGapPct: gap == null ? null : r2(gap * 100),
      hasSl: orders == null ? null : orders.some((o) => o && o.coin === p.coin && o.tpsl === "sl"),
      szDecimals: m ? m.szDecimals : null,
    };
  });
  return {
    signedIn: !!b.connected,
    mock: !!b.mock,
    equityUsdc: known ? r2(bal.equityUsdc) : null,
    freeUsdc: known && fin(bal.availableUsdc) ? r2(bal.availableUsdc) : null,
    balanceChecking: partial,
    neverFunded: !!(bal && bal.reason === "new-account"),
    positions,
    markets: (snapshot && snapshot.markets) || [],
    byCoin,
    apyPct: fin(apyPct) ? apyPct : null,
    earnEnabled: !!earnEnabled,
    tokenomist: !!tokenomist,
  };
}

const label = (state, coin) => coinLabel(coin, state.byCoin[coin]) || perpCoinLabel(coin, state.byCoin[coin]) || coin;
/** The Analyze action: on every market box (not USDC, not a venue market the analysis cannot read). */
export function analyzeAction(state, coin) {
  if (typeof coin !== "string" || !coin || coin === "USDC" || coin.includes(":")) return null;
  const tk = !!(state && state.tokenomist) && isCovered(coin);
  return { id: "analyze", label: "Analyze", prompt: tk ? `Analyze ${coin} with Tokenomist` : `Analyze ${coin}` };
}

function positionItem(state, p) {
  const name = label(state, p.coin);
  const near = p.liqGapPct != null && p.liqGapPct <= NEAR_LIQ_PCT;
  /* The safe next step first (TP / SL; "Set stop" when it has none), Analyze, then Close: Close is never the box's
     primary action (design review, 2026-10-15). */
  const actions = [{ id: "tpsl", label: p.hasSl === false ? "Set stop" : "TP / SL", prompt: `Set TP SL for ${p.coin}` }];
  actions.push(analyzeAction(state, p.coin) || { id: "chart", label: "Chart", to: `/trade/${p.coin}` });
  actions.push({ id: "close", label: "Close", prompt: `Close ${p.coin}` });
  return {
    coin: p.coin,
    kind: "position",
    /* "BTC · 10x Long": the same words as the side chip on every card and the rail. */
    title: `${name} · ${p.leverage ? `${p.leverage}x ` : ""}${p.side === "long" ? "Long" : "Short"}`,
    figure: p.pnlUsdc == null ? DASH : usd2(p.pnlUsdc),
    /* A position with no stop says so: that is why its box is here, and why its first pill is "Set stop". */
    sub: `${near ? `Liq ${p.liqGapPct.toFixed(1)}% away` : p.roePct != null ? `${formatHlPct(p.roePct, 1)} ROE` : p.liqGapPct != null ? `Liq ${p.liqGapPct.toFixed(1)}% away` : "Open now"}${p.hasSl === false ? " · no SL" : ""}`,
    tone: near ? "neg" : p.pnlUsdc == null || p.pnlUsdc === 0 ? "neutral" : p.pnlUsdc > 0 ? "pos" : "neg",
    actions: actions.slice(0, 3),
    ...(near ? { warn: "near-liquidation" } : {}),
  };
}

function marketItem(state, m, { kind = "mover" } = {}) {
  const name = label(state, m.coin);
  const up = fin(m.change24hPct) ? m.change24hPct >= 0 : null;
  const actions = [{ id: "setups", label: "Setups", prompt: `Setups for ${m.coin}` }];
  if (up != null) actions.push(up ? { id: "long", label: "Long", prompt: `Long setups for ${m.coin}` } : { id: "short", label: "Short", prompt: `Short setups for ${m.coin}` });
  actions.push(analyzeAction(state, m.coin) || { id: "chart", label: "Chart", to: `/trade/${m.coin}` });
  return {
    coin: m.coin,
    kind,
    title: name,
    figure: fin(m.change24hPct) ? formatHlPct(m.change24hPct, 1) : DASH,
    sub: `${formatHlPrice(m.px, m.szDecimals)} · ${formatHlUsdCompact(m.dayNtlVlm)} vol`,
    tone: up == null ? "neutral" : up ? "pos" : "neg",
    actions: actions.slice(0, 3),
  };
}

function earnItem(state) {
  const idle = state.freeUsdc != null && state.freeUsdc >= IDLE_MIN_USDC;
  const amount = idle ? Math.min(20, Math.floor(state.freeUsdc)) : null;
  return {
    coin: "USDC",
    kind: "earn",
    title: "USDC Staked AAVE",
    figure: state.apyPct != null ? `${state.apyPct.toFixed(2)}% APY` : `${DASH} APY`,
    sub: idle ? `${usdc(state.freeUsdc)} idle in Main Account` : "on AVAX · variable",
    tone: state.apyPct != null ? "pos" : "neutral",
    /* Two decimals, as the figure and the Wallet print it (one decimal read like a different rate). */
    actions: [{ id: "stake", label: state.apyPct != null ? `Stake ${state.apyPct.toFixed(2)}%` : "Stake", prompt: amount ? `Stake ${amount} USDC` : "Stake USDC" }],
  };
}

/* The user's own USDC: free to trade, or nothing yet (then the way in is a deposit). Idle USDC (5 or more) is the
   earn box's line already, so it gets its own box only where the account itself is asked for (always). */
function heldItem(state, { always = false } = {}) {
  if (!state.signedIn || state.equityUsdc == null) return null;
  if (state.equityUsdc <= 0 && !(state.positions && state.positions.length)) {
    return {
      coin: "USDC", kind: "held", title: "Main Account", figure: "0 USDC", sub: "Add USDC to start", tone: "neutral",
      actions: [{ id: "deposit", label: "Deposit", to: "/wallet?panel=deposit" }],
    };
  }
  if (state.freeUsdc == null || state.freeUsdc < 1) return null;
  if (!always && state.freeUsdc >= IDLE_MIN_USDC) return null;
  return {
    coin: "USDC", kind: "held", title: "Free to trade", figure: usdc(state.freeUsdc), sub: state.equityUsdc > state.freeUsdc ? `${usdc(state.equityUsdc)} in Main Account` : "Main Account",
    tone: "neutral",
    actions: [{ id: "setups", label: "Setups", prompt: "Any setups?" }, { id: "stake", label: "Earn", prompt: `Stake ${Math.min(20, Math.floor(state.freeUsdc))} USDC` }],
  };
}

/* Talk about a trade or a position: leverage, margin, TP / SL, long / short, open / close. */
const TRADE_TALK = /\b(long|short|leverage|lev|margin|tp|sl|tpsl|take profit|stop loss|position|entry|setups?|open|close|rr)\b|ลอง|ชอร์ต|เลเวอ|มาร์จิ้น|เปิด|ปิด|โพสิชั่น|โพซิชั่น|กำไร|ขาดทุน|ยืนยัน/i;

/**
 * Whether the asset boxes go under an answer (owner, 2026-10-15: "เวลาคุยเรื่องอื่น เรื่อง Position นั้นๆ … สามกล่องนี้มากวน").
 * Once per conversation, and never while the talk is about a trade or a position, by text or by voice.
 * @param {Array<object>} messages the conversation on screen (chat.get().messages)
 * @param {string} userText what the user just said or typed
 */
export function boxesWanted(messages, userText = "") {
  const list = Array.isArray(messages) ? messages : [];
  if (list.some((m) => m && m.role === "card" && m.card && m.card.kind === "assets")) return false;
  return !TRADE_TALK.test(String(userText || ""));
}

/**
 * 3–5 boxes from real state (2 under a plan, whose setups card already carries the trade ideas).
 * @param {object} state assetState()
 * @param {{ surface?: "empty"|"after"|"movers"|"account"|"plan", focus?: string[], limit?: number, exclude?: string[],
 *   noAnalyze?: string[] }} o
 *   focus: the markets the conversation is about (first), from the user's words or the Agent's reads
 *   exclude: markets already on screen in another card (a plan's setups): no box for them
 *   noAnalyze: markets being analyzed in this very answer: their box gets Chart instead of Analyze (no loop)
 */
export function suggestAssets(state, { surface = "empty", focus = [], limit = null, exclude = [], noAnalyze = [] } = {}) {
  const s = state || assetState({});
  const max = Math.max(1, Math.min(5, limit || SURFACE_LIMIT[surface] || 4));
  const out = [];
  const used = new Set((Array.isArray(exclude) ? exclude : []).filter((c) => typeof c === "string"));
  const quiet = new Set((Array.isArray(noAnalyze) ? noAnalyze : []).filter((c) => typeof c === "string"));
  const add = (it) => {
    if (!it || out.length >= max) return;
    const key = it.kind === "earn" ? "earn" : it.kind === "held" ? "held" : it.coin;
    if (used.has(key)) return;
    used.add(key);
    out.push(quiet.has(it.coin) ? withoutAnalyze(it) : it);
  };
  const main = mainMarkets(s.markets);
  const byCoin = s.byCoin || {};
  const positions = Array.isArray(s.positions) ? [...s.positions] : [];
  positions.sort((a, b) => (a.liqGapPct ?? 1e9) - (b.liqGapPct ?? 1e9));
  const posOf = (c) => positions.find((p) => p.coin === c) || null;
  const focusCoins = (Array.isArray(focus) ? focus : []).filter((c) => typeof c === "string" && byCoin[c] && !byCoin[c].isHip3);
  const movers = topMovers(main, 8);

  if (surface === "movers") {
    for (const m of movers) add(marketItem(s, m));
    return out;
  }
  if (surface === "account") {
    for (const p of positions.slice(0, 3)) add(positionItem(s, p));
    add(heldItem(s, { always: true }));
    add(earnItem(s));
    for (const m of movers) add(marketItem(s, m));
    return out;
  }
  if (surface === "plan") {
    /* Under the plan's setups: what needs the user (a position near liquidation or with no stop), the way in when
       the account is empty, then earn; a mover only fills a gap. */
    const attention = positions.find((p) => (p.liqGapPct != null && p.liqGapPct <= NEAR_LIQ_PCT) || p.hasSl === false);
    if (attention) add(positionItem(s, attention));
    if (s.equityUsdc != null && s.equityUsdc <= 0) add(heldItem(s));
    add(earnItem(s));
    for (const m of movers) add(marketItem(s, m));
    return out;
  }
  if (surface === "after") {
    for (const c of focusCoins.slice(0, 2)) add(posOf(c) ? positionItem(s, posOf(c)) : marketItem(s, byCoin[c], { kind: "setup" }));
    const near = positions.find((p) => p.liqGapPct != null && p.liqGapPct <= NEAR_LIQ_PCT);
    if (near) add(positionItem(s, near));
    add(earnItem(s));
    for (const m of movers) add(marketItem(s, m));
    return out;
  }
  /* empty: positions (nearest liquidation first), the market in focus, the user's USDC, earn, then movers. */
  for (const p of positions.slice(0, 2)) add(positionItem(s, p));
  for (const c of focusCoins.slice(0, 1)) add(posOf(c) ? positionItem(s, posOf(c)) : marketItem(s, byCoin[c], { kind: "setup" }));
  add(heldItem(s));
  add(earnItem(s));
  for (const m of movers) add(marketItem(s, m));
  return out;
}

/* A box whose market is being analyzed in the same answer: Chart instead of a second "Analyze" (it would loop). */
function withoutAnalyze(it) {
  if (!it || !Array.isArray(it.actions) || !it.actions.some((a) => a.id === "analyze")) return it;
  const chart = { id: "chart", label: "Chart", to: `/trade/${it.coin}` };
  const has = it.actions.some((a) => a.id === "chart");
  return { ...it, actions: it.actions.flatMap((a) => (a.id !== "analyze" ? [a] : has ? [] : [chart])) };
}

/** The card. */
export const assetsCard = (items) => ({ kind: "assets", items: Array.isArray(items) ? items : [] });

/** A box's words are short and carry a figure (the lint the tests hold every box to). */
export function lintItem(it) {
  const problems = [];
  if (!it || typeof it !== "object") return ["not an item"];
  if (!it.title || it.title.length > 24) problems.push("title");
  if (typeof it.figure !== "string" || !it.figure) problems.push("figure");
  if (typeof it.sub !== "string" || it.sub.length > 44) problems.push("sub");
  if (!Array.isArray(it.actions) || it.actions.length < 1 || it.actions.length > 3) problems.push("actions");
  for (const a of it.actions || []) {
    if (!a || typeof a.id !== "string" || typeof a.label !== "string" || a.label.length > 16) problems.push("action");
    else if (!a.prompt && !a.to) problems.push("action-target");
  }
  if (!["pos", "neg", "neutral"].includes(it.tone)) problems.push("tone");
  return problems;
}

/** The onboarding line (plan v2 §2.5: never "How can I help?"): what to do, and one fact from the user's state. */
export function onboardingLine(state, lang = "en") {
  const s = state || {};
  const th = lang === "th";
  const head = th ? "บอกได้เลยว่าอยากทำอะไรบน FlowFlow" : "Tell me what you want to do on FlowFlow.";
  let tail = "";
  const n = Array.isArray(s.positions) ? s.positions.length : 0;
  const near = Array.isArray(s.positions) ? s.positions.find((p) => p.liqGapPct != null && p.liqGapPct <= NEAR_LIQ_PCT) : null;
  if (!s.signedIn) tail = th ? " ล็อกอินเพื่อเทรด หรือดูไอเดียด้านล่างก่อน" : " Sign in to trade, or start with an idea below.";
  else if (near) tail = th ? ` ${near.coin} ใกล้ liq แล้ว (${near.liqGapPct.toFixed(1)}%)` : ` ${near.coin} is ${near.liqGapPct.toFixed(1)}% from liquidation.`;
  else if (s.equityUsdc != null && s.equityUsdc <= 0 && !n) tail = th ? " Main Account ยังว่าง ฝาก USDC เพื่อเริ่ม" : " Your Main Account is empty: deposit USDC to start.";
  else if (n) tail = th ? ` ถืออยู่ ${n} position` : ` You hold ${n} position${n > 1 ? "s" : ""}.`;
  else if (s.freeUsdc != null && s.freeUsdc >= 1) tail = th ? ` มี ${usdc(s.freeUsdc)} พร้อมใช้` : ` ${usdc(s.freeUsdc)} is free to use.`;
  else if (s.equityUsdc != null && s.equityUsdc > 0) tail = th ? ` มี ${usdc(s.equityUsdc)} ใน Main Account` : ` ${usdc(s.equityUsdc)} in your Main Account.`;
  else if (s.balanceChecking) tail = th ? " กำลังเช็กยอดเงินของคุณอยู่" : " Your balance is still being checked.";
  return `${head}${tail}`;
}

/** The boxes as the model reads them (one short line each). */
export function assetsForModel(card) {
  return (card && Array.isArray(card.items) ? card.items : []).map((it) => `${it.title} ${it.figure} (${it.sub})`).join("; ");
}
