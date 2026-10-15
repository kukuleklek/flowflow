import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AutoHeight, ShimmerText } from "../ui/kit/index.ts";
import Icon, { Spinner } from "../ui/Icon.jsx";
import { LogoMark } from "../ui/Logo.jsx";
import CoinLogo from "../ui/CoinLogo.jsx";
import { usePerpMarkets } from "../lib/hyperliquid/index.js";
import { perpCoinLabel } from "../perp/live/perpLiveView.js";
import { useBackend } from "../perp/BackendContext.jsx";
import { chat, useChat } from "./store.js";
import { HELP } from "./respond.js";
import { handleMessage, toolCtxFrom } from "./agent.js";
import TradeCard from "./TradeCard.jsx";
import AssetBoxes, { useAssetItems } from "./cards/AssetBoxes.jsx";
import AnalyzeChip from "./cards/AnalyzeChip.jsx";
import { chipsFor } from "./chips.js";
import { ChatActionsContext, Glyph, TOKENOMIST_ON } from "./cards/ChatActions.jsx";
import SponsorLogo from "../ui/SponsorLogo.jsx";
import Button from "../ui/Button.jsx";
import ConnectCard from "../auth/ConnectCard.jsx";
import { scrubVenueWords, agentTicker, isStockCoin, stockKind } from "./stockWords.js";
import { coinLabel } from "./cards/viewWords.js";
import { usMarketView } from "./cards/usMarketView.js";
import { tokenomistFor } from "./cards/ChatActions.jsx";

/* The voice lane's button (src/agent/voice/VoiceButton.jsx, props { coin, disabled }), loaded on first paint of the
   composer, and its call popup (VoiceStatus: state, time left, End) floating above the composer while a call is on.
   A build without them draws nothing there; one that throws takes only itself down. */
const VOICE = Object.values(import.meta.glob("./voice/VoiceButton.jsx"))[0] || null;
const VoiceButton = VOICE ? lazy(VOICE) : null;
const VoiceStatus = VOICE ? lazy(() => VOICE().then((m) => ({ default: m.VoiceStatus || (() => null) }))) : null;

/* DEV ONLY: `?fixture=analysis&coin=ETH[&profile=Bolder]` puts a real analysis card in the thread for screenshots
   (src/agent/cards/devFixtures.js). import.meta.env.DEV is false in a build, so the module never ships. */
const DEV_FIXTURES = import.meta.env.DEV ? () => import("./cards/devFixtures.js") : null;
let devFixtureRan = false;

class Quiet extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* the composer keeps working without it */ }
  render() { return this.state.failed ? null : this.props.children; }
}

/* Words that resolve into place (transitions.dev 30 streaming text): each word rises out of a 2px blur, one
   every --stream-gap. Only the newest assistant line plays it; older lines render still. */
function StreamText({ text, play }) {
  const words = String(text).split(/(\s+)/);
  if (!play) return <span>{text}</span>;
  let n = 0;
  return (
    <span>
      {words.map((w, i) => (/^\s+$/.test(w) ? w : <span key={i} className="ff-word" style={{ "--w": n++ }}>{w}</span>))}
    </span>
  );
}

const hhmm = (t) => (Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");

/* ── The Agent's work (USER-REQUESTS A2) ─────────────────────────────────────────────────────────────────────────
   Each read tool the Agent runs is a `status` message { text, tool, coin, run, state }. One run's steps render as one
   block: a live row while a step runs, then "Checked n things", which opens to the steps in the past tense. */
const STEP_WORDS = {
  get_market: { run: (c) => `Reading ${c || "the"} market…`, done: (c) => `Read ${c ? `${c} ` : ""}market`, fail: (c) => `Couldn't read ${c ? `${c} ` : ""}market` },
  get_markets: { run: () => "Scanning markets…", done: () => "Scanned markets", fail: () => "Couldn't scan markets" },
  get_candles: { run: (c) => `Reading ${c || "the"} chart…`, done: (c) => `Read ${c ? `${c} ` : ""}chart`, fail: (c) => `Couldn't read ${c ? `${c} ` : ""}chart` },
  get_account: { run: () => "Checking your account…", done: () => "Checked your account", fail: () => "Couldn't check your account" },
  get_funds: { run: () => "Checking your money…", done: () => "Checked your money", fail: () => "Couldn't check your money" },
  get_fills: { run: () => "Reading your trades…", done: () => "Read your trades", fail: () => "Couldn't read your trades" },
  quote_trade: { run: (c) => `Pricing ${c ? `${c} ` : ""}order…`, done: (c) => `Priced ${c ? `${c} ` : ""}order`, fail: (c) => `Couldn't price ${c ? `${c} ` : ""}order` },
  get_unlocks: { run: (c) => `Reading ${c ? `${c} ` : ""}unlocks…`, done: (c) => `Read ${c ? `${c} ` : ""}unlocks`, fail: (c) => `Couldn't read ${c ? `${c} ` : ""}unlocks` },
  get_news: { run: (c) => `Reading ${c ? `${c} ` : ""}news…`, done: (c) => `Read ${c ? `${c} ` : ""}news`, fail: (c) => `Couldn't read ${c ? `${c} ` : ""}news` },
};
/* A step names its market as the user reads it: "TSLA", "US 100", never a venue-qualified id. */
const coinName = (c) => (c ? coinLabel(c) || perpCoinLabel(c) : null);
/* A shortcut's status line names its step in words only ("Checked account", "Quoted trade"). Read them as the tool
   they stand for, so a shortcut's work block says the same words as the model's ("Priced ETH order"). Display only. */
const SHORTCUT_TOOL = [[/^checked account$/i, "get_account"], [/^quoted trade$/i, "quote_trade"]];
const toolOf = (s) => (s && s.tool) || ((SHORTCUT_TOOL.find(([re]) => re.test(String((s && s.text) || ""))) || [])[1]) || null;
function stepWords(s, mode) {
  const t = toolOf(s);
  const w = t ? STEP_WORDS[t] : null;
  return w ? w[mode](coinName(s.coin)) : String((s && s.text) || "");
}

function StepGlyph({ s }) {
  if (s.coin) return <CoinLogo coin={s.coin} size={16} />;
  if (toolOf(s) === "get_unlocks" && TOKENOMIST_ON) return <SponsorLogo name="tokenomist" size={13} alt="" />;
  /* Shortcut steps (and steps restored from an older session) carry only their words. */
  const t = toolOf(s) || "";
  const words = String(s.text || "");
  if (t === "get_account" || t === "get_funds" || t === "get_fills" || (!t && /account|money|trades/i.test(words))) return <Icon name="wallet" size={14} className="text-foreground" />;
  if (t === "get_markets" || (!t && /markets/i.test(words))) return <Icon name="search" size={14} className="text-foreground" />;
  return <Icon name="chart" size={14} className="text-foreground" />;
}

/* One block's steps. A shortcut's status line can name two steps at once ("Checked account · Quoted trade"): each
   becomes its own row. */
function expandSteps(steps, hintCoin = null) {
  const out = [];
  for (const s of steps) {
    if (s.tool || !s.text) { out.push(s); continue; }
    /* A shortcut's quote step priced the market its card shows: draw that market's logo on it. */
    const parts = String(s.text).split(" · ");
    parts.forEach((text, i) => out.push({ ...s, id: parts.length > 1 ? `${s.id}.${i}` : s.id, text, coin: s.coin || (hintCoin && /quot/i.test(text) ? hintCoin : null) }));
  }
  return out;
}

function WorkBlock({ steps: raw, hintCoin = null, className = "" }) {
  const [open, setOpen] = useState(false);
  const steps = expandSteps(raw, hintCoin);
  const running = [...steps].reverse().find((s) => s.state === "running");
  if (running) {
    return (
      <div key="run" className={`t-swap-in flex h-7 items-center gap-2 text-xs text-muted-foreground ${className}`} role="status">
        <Spinner size={12} />
        {running.coin ? <CoinLogo coin={running.coin} size={16} /> : null}
        <ShimmerText text={stepWords(running, "run")} />
      </div>
    );
  }
  const coins = [...new Set(steps.map((s) => s.coin).filter(Boolean))];
  const n = steps.length;
  return (
    <div key="done" className={`t-swap-in ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="ff-press ff-hit relative -ml-1.5 inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
      >
        <Icon name="check" size={14} className="text-foreground" />
        {n === 1 ? "Checked 1 thing" : `Checked ${n} things`}
        {coins.length ? (
          <span className="inline-flex [&>*+*]:-ml-1">
            {coins.map((c) => <CoinLogo key={c} coin={c} size={16} />)}
          </span>
        ) : null}
        <Icon name="chevronDown" size={14} className={`transition-transform duration-[var(--duration-fast)] ${open ? "rotate-180" : ""}`} />
      </button>
      <AutoHeight>
        {open ? (
          <ol className="t-swap-in mb-1.5 ml-[7px] mt-1 border-l border-border pl-[13px]">
            {steps.map((s, i) => {
              const failed = s.state === "error";
              const last = i === steps.length - 1;
              return (
                <li key={s.id} className="flex h-[26px] items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <span className="grid size-4 shrink-0 place-items-center"><StepGlyph s={s} /></span>
                  <span className={failed ? "text-destructive/80" : ""}>{stepWords(s, failed ? "fail" : "done")}</span>
                  {failed
                    ? <Icon name="x" size={12} className="ml-0.5 text-destructive/80" />
                    : <Icon name="check" size={12} className={`ml-0.5 ${last ? "text-success" : "text-foreground"}`} />}
                </li>
              );
            })}
          </ol>
        ) : <div />}
      </AutoHeight>
    </div>
  );
}

/* The thread as turns: each user message, then everything the Agent said back (under ONE byline), with one run's
   status steps folded into a work block. */
function buildTurns(messages) {
  const turns = [];
  let cur = null;
  /* One run's steps are ONE block, at its first place in the turn, even when a card or a line came between them
     (pass-2 review: "News and trend for TSLA" showed "Checked 1 thing" twice in one reply). */
  let runs = new Map();
  for (const m of messages) {
    if (m.role === "user") { turns.push({ kind: "user", id: m.id, m }); cur = null; runs = new Map(); continue; }
    if (!cur) { cur = { kind: "agent", id: m.id, at: m.at, items: [] }; turns.push(cur); }
    /* The card a turn's steps led to names their market. */
    if (m.role === "card" && m.card && m.card.coin) for (const it of cur.items) if (it.kind === "work" && !it.hintCoin) it.hintCoin = m.card.coin;
    const last = cur.items[cur.items.length - 1];
    if (m.role === "status") {
      const run = m.run || null;
      const same = run ? runs.get(run) : null;
      if (same) same.steps.push(m);
      else if (last && last.kind === "work" && last.run === run) last.steps.push(m);
      else {
        const w = { kind: "work", id: m.id, run, steps: [m] };
        cur.items.push(w);
        if (run) runs.set(run, w);
      }
    } else {
      cur.items.push({ kind: m.role === "card" ? "card" : "text", id: m.id, m });
    }
  }
  return turns;
}

/* Rhythm inside an Agent turn: the work block hugs the byline, prose follows it closely, a card gets air. */
function gapFor(prev, kind) {
  if (!prev) return kind === "work" ? "mt-0.5" : kind === "card" ? "mt-2" : "";
  if (prev === "card") return "mt-4";
  if (kind === "card") return prev === "work" ? "mt-3" : "mt-4";
  if (kind === "work") return prev === "work" ? "mt-1" : "mt-3";
  return "mt-2.5";
}

function Byline({ at }) {
  return (
    <div className="t-swap-in mb-1.5 flex items-center gap-2">
      <LogoMark size={18} className="shrink-0" />
      <span className="text-xs font-medium">FlowFlow</span>
      {at ? <span className="font-mono text-[11px] text-muted-foreground">{hhmm(at)}</span> : null}
    </div>
  );
}

function AgentTurn({ turn, latestCardId, latestTextId, thinking }) {
  let prev = null;
  /* One Analyze pill per market per turn: a card that carries its own (a one-market setups card, the newest trade
     card) or IS the analysis (unlocks) makes the one under the words redundant. A setups card of several markets
     carries a pill in each box, so the trade card a box becomes keeps its own. */
  const carded = new Set();
  let latestOpenCoin = null;
  for (const it of turn.items) {
    const c = it.kind === "card" && it.m.card ? it.m.card : null;
    if (!c) continue;
    const k = c.kind || "open";
    if (k === "setups") {
      const coins = [...new Set((Array.isArray(c.setups) ? c.setups : []).map((x) => x && x.coin).filter(Boolean))];
      if (c.coin) carded.add(c.coin);
      else if (coins.length === 1) carded.add(coins[0]);
    }
    if ((k === "unlocks" || k === "analysis") && c.coin) carded.add(c.coin);
    if (k === "open" && it.id === latestCardId) latestOpenCoin = c.coin || null;
  }
  return (
    <div className="pt-3">
      <Byline at={turn.at} />
      {turn.items.map((it) => {
        const gap = gapFor(prev, it.kind);
        prev = it.kind;
        if (it.kind === "work") return <WorkBlock key={it.id} steps={it.steps} hintCoin={it.hintCoin} className={gap} />;
        if (it.kind === "card") {
          const c = it.m.card || {};
          /* The Analyze pill under the newest trade card still up for review (a filled one shows it in its position).
             It hands the card over, so the analysis weighs THIS trade (its side, leverage and TP / SL). */
          const pill = it.id === latestCardId && (c.kind || "open") === "open" && c.status !== "filled" && c.status !== "cancelled" && !carded.has(c.coin) ? c.coin : null;
          return (
            <div key={it.id} className={gap} data-card-id={it.id}>
              <TradeCard message={it.m} latest={it.id === latestCardId} />
              {pill ? <AnalyzeChip coin={pill} card={c} className="mt-2" /> : null}
            </div>
          );
        }
        const an = it.m.analyze && typeof it.m.analyze.coin === "string" && !carded.has(it.m.analyze.coin) && it.m.analyze.coin !== latestOpenCoin ? it.m.analyze.coin : null;
        /* A quiet row inside the answer (e.g. "Unlocks · Tokenomist not connected"): small, muted, never a card. */
        if (it.m.tone === "muted") {
          return (
            <div key={it.id} className={`${gap} flex min-h-7 items-center gap-2 text-xs text-muted-foreground`}>
              {it.m.source === "tokenomist" && TOKENOMIST_ON ? <SponsorLogo name="tokenomist" size={13} alt="" /> : <Icon name="info" size={13} />}
              <span>{it.m.text}</span>
            </div>
          );
        }
        return (
          <div key={it.id} className={gap}>
            <p className={`max-w-[60ch] text-sm leading-[1.55] ${it.m.tone === "error" ? "text-destructive" : "text-foreground"}`}>
              {it.m.via === "voice" ? <Glyph name="mic" size={13} className="mr-1.5 inline-block -translate-y-px text-muted-foreground" /> : null}
              {/* 🔴 The last guard on the words shown (owner item 3): whatever wrote this line, the venue a stock
                  trades on is never named. */}
              <StreamText text={scrubVenueWords(it.m.text, { fallback: "" })} play={it.id === latestTextId} />
            </p>
            {an ? <AnalyzeChip coin={an} className="mt-2" /> : null}
          </div>
        );
      })}
      {thinking ? (
        <div className={`flex h-7 items-center ${gapFor(prev, "work")}`}>
          <ShimmerText text="Thinking…" className="font-mono text-[11px]" />
        </div>
      ) : null}
    </div>
  );
}

/* Context chips under the thread (chips.js chipsFor): what the reader is most likely to say next, following the
   newest card on screen. Each carries its market's logo or a glyph, so the strip reads as things to do, not a row of
   sentences (USER-REQUESTS E). */
const CHIP = "ff-press ff-hit inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-card pl-1.5 pr-3 text-xs font-medium text-foreground ring-1 ring-inset ring-border transition-colors hover:bg-muted disabled:opacity-45";

function ChipGlyph({ chip }) {
  if (chip.coin) return <CoinLogo coin={chip.coin} size={20} />;
  return (
    <span className="grid size-5 place-items-center rounded-full bg-muted text-muted-foreground">
      {chip.glyph ? <Glyph name={chip.glyph} size={12} /> : <Icon name={chip.icon || "chat"} size={12} />}
    </span>
  );
}

/** The Chat tab's empty thread (the market page, owner: "แชท รายเหรียญ … มีคำนี้ขึ้นมา Trade (logo BTC) with Voice or chat"):
 *  one line with the market's logo, then this market's own idea bubbles. Item 18's boxes (cards/askAboutView.js, owner:
 *  "Ask Me About (Logo) HYPE … Emission Analytic with Tokenomist, News and trend, … to do position") ride here as small
 *  bubbles, as the lead's later rule says (item 21b: small bubbles, never big boxes): Emission & unlocks with the
 *  Tokenomist wordmark (only when the key is on and it covers the coin), News & trend, Plan a position (held: Your
 *  position · TP / SL); a stock's first is the US market's state, then Earnings & news. Words name the ticker, never
 *  the venue ("US100", not its venue id). */
function coinIdeas(coin, held, { tokenomist = false, us = null } = {}) {
  const tick = agentTicker(coin);
  const name = coinLabel(coin) || tick;
  if (isStockCoin(coin)) {
    return [
      { text: `Analyze ${tick}`, parts: [{ coin }, { t: us ? `${us.label}${us.sub ? ` · ${us.sub}` : ""}` : "US market" }] },
      { text: `News and trend for ${tick}`, parts: [{ t: "Earnings & news" }, { coin }, { t: name }] },
      held ? { text: `Set TP SL for ${tick}`, parts: [{ t: "Your" }, { coin }, { t: `${name} · TP / SL` }] } : { text: `Setups for ${tick}`, parts: [{ t: "Plan a position" }, { coin }, { t: name }] },
      { text: `${tick} best R:R`, parts: [{ coin }, { t: `${name} best R:R` }] },
      { text: `Short ${tick} stock with max loss 5 USD`, parts: [{ t: "Short" }, { coin }, { t: `${name}, max loss $5` }] },
      { text: `Long ${tick} stock, risk 3 USD`, parts: [{ t: "Long" }, { coin }, { t: `${name}, risk $3` }] },
    ];
  }
  return [
    held ? { text: `Set TP SL for ${tick}`, parts: [{ t: "Your" }, { coin }, { t: `${name} · TP / SL` }] } : { text: `Setups for ${tick}`, parts: [{ t: "Plan a position" }, { coin }, { t: name }] },
    tokenomist
      ? { text: `Analyze ${tick} with Tokenomist`, parts: [{ t: "Emission & unlocks" }, { logo: "tokenomist" }] }
      : { text: `Analyze ${tick}`, parts: [{ t: "Analyze" }, { coin }, { t: name }] },
    { text: `News and trend for ${tick}`, parts: [{ t: "News & trend" }, { coin }, { t: name }] },
    { text: `Long ${tick} 10 USDC 3x`, parts: [{ t: "Long" }, { coin }, { t: `${name} 10 USDC 3x` }] },
    { text: `Short ${tick} 10 USDC 2x tp 6% sl 3%`, parts: [{ t: "Short" }, { coin }, { t: `${name}, TP 6% SL 3%` }] },
    { text: `Best R:R for ${tick}`, parts: [{ t: "Best R:R for" }, { coin }, { t: name }] },
  ];
}

function Welcome({ coin, send, busy }) {
  const b = useBackend();
  const held = !!(coin && b.account && b.account.positions && b.account.positions.byCoin && b.account.positions.byCoin[coin]);
  /* A stock's first bubble reads the US market's state now (a minute is fine: the pool is rebuilt per render hour). */
  const usKey = isStockCoin(coin) ? Math.floor(Date.now() / 60_000) : 0;
  const pool = useMemo(() => coinIdeas(coin, held, {
    tokenomist: !!(coin && !isStockCoin(coin) && tokenomistFor(coin)),
    us: isStockCoin(coin) ? usMarketView(Date.now(), stockKind(coin) === "index" ? "index" : "stock") : null,
  }), [coin, held, usKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const tick = coin ? coinLabel(coin) || agentTicker(coin) : "";
  return (
    <div className="t-swap-in flex flex-col items-center pt-6 text-center">
      <h2 className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[17px] font-semibold leading-tight tracking-[-0.015em]">
        <span>Trade</span>
        {coin ? <CoinLogo coin={coin} size={22} /> : null}
        <span>{tick || "it"} with voice or chat</span>
      </h2>
      {/* A market's Chat tab (344px wide): a still, even wrap of four, not floating bubbles (pass-2 review: almost every
          idea took a whole row there, so they stacked in one ragged column 6–77px apart). */}
      <IdeaBubbles pool={pool} send={send} busy={busy} still max={4} />
    </div>
  );
}

/* The full Agent page's first screen (owner, 2026-10-15: "กล่อง … มันตัวใหญ่เกิน มันควรจะ เล็กๆๆๆ น้อยๆๆ … ไม่ใช่เปิดมาครั้งแรก
   ห่าแตดไรเต็มไปหมดเลย … ถ้ายังไม่ Signin ต้องบังคับให้ Signin ก่อน … Trade or Staking With Voice Or Chat Here, Sign in now …
   Recommended ลอยๆ กล่องเล็กมากๆ" · "Short Stock, Long Meme, Stake, Buy BTC on Avax Chain, คำพวกนี้ เด้งไปมาหายไปมาได้ด้วย" ·
   "เลือกเหรียญแล้ว ปุ่มโตๆเช่น Analyze ค่อยขึ้นมา"). One line, and either Sign in or a few tiny floating ideas that come and go.
   Nothing big (boxes, setups, analysis) until the reader asks or picks a coin. */
const HEADLINE = "Trade or stake with voice or chat";
const PENDING_KEY = "flowflow.agent.pendingPrompt.v1";
const keepPending = (t) => { try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ t, at: Date.now() })); } catch { /* private mode */ } };
/* A prompt older than 10 minutes is dropped: it was asked of a page the reader has long left. */
function takePending() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.t === "string" && Date.now() - v.at < 600_000 ? v.t.slice(0, 280) : null;
  } catch { return null; }
}
const IDEA = "ff-press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 text-[12px] font-medium text-foreground ring-1 ring-inset ring-border transition-colors hover:bg-muted disabled:opacity-45";
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* The ideas, in the owner's own words; a tap says them to the Agent like a typed message. A label may carry a logo
   in the middle ("Long [HYPE] HYPE for me", "Analyze HYPE with [Tokenomist]"): `parts` draws it, `text` is what is
   sent. Owner: "Token Analytic with Tokenomist (logo), Long (Logo Hype) HYPE For me, need s&p500 short with maximum lost
   5 USD … ลอยไปลอยมา พร้อมกดได้จริงด้วย … แม้ยังไม่ได้ Login". */
function ideaPool({ held, topCoin, tokenomist = TOKENOMIST_ON }) {
  const out = [
    /* Tokenomist is offered only when it is connected (its tap would otherwise end on "Emission data not connected"). */
    tokenomist
      ? { text: "Analyze HYPE with Tokenomist", parts: [{ t: "Token analytics with" }, { logo: "tokenomist" }] }
      : { text: "Analyze HYPE", parts: [{ t: "Analyze" }, { coin: "HYPE" }, { t: "HYPE" }] },
    { text: "Long HYPE for me", parts: [{ t: "Long" }, { coin: "HYPE" }, { t: "HYPE for me" }] },
    { text: "Short S&P 500 with max loss 5 USD", parts: [{ t: "Short" }, { coin: "xyz:SP500" }, { t: "S&P 500, max loss $5" }] },
    { text: "Best R:R for NVDA stock", parts: [{ t: "Best R:R for" }, { coin: "xyz:NVDA" }, { t: "NVDA" }] },
    { text: "Long Tesla stock, risk 3 USD", parts: [{ t: "Long" }, { coin: "xyz:TSLA" }, { t: "Tesla, risk $3" }] },
    { text: "Long BTC 10 USDC 3x", parts: [{ t: "Long" }, { coin: "BTC" }, { t: "BTC 10 USDC 3x" }] },
    { text: "Short ETH 10 USDC 2x tp 6% sl 3%", parts: [{ t: "Short" }, { coin: "ETH" }, { t: "ETH, TP 6% SL 3%" }] },
    ...(tokenomist ? [{ text: "Analyze SOL unlocks with Tokenomist", parts: [{ t: "SOL unlocks" }, { coin: "SOL" }, { logo: "tokenomist" }] }] : []),
    { text: "Stake 20 USDC", parts: [{ t: "Stake 20 USDC on" }, { logo: "avalanche" }] },
    { text: "Short a stock" },
    { text: "Long a meme" },
    { text: "Buy BTC on Avax", coin: "BTC" },
    { text: "What to trade today?" },
    { text: "Top movers" },
  ];
  if (topCoin && !["HYPE", "BTC", "ETH", "SOL"].includes(topCoin)) out.splice(4, 0, { text: `Analyze ${topCoin}`, parts: [{ t: "Analyze" }, { coin: topCoin }, { t: topCoin }] });
  if (held.length) out.splice(1, 0, { text: held.length > 1 ? "Close all positions" : `TP / SL for ${held[0]}`, coin: held.length > 1 ? null : held[0] });
  return out;
}

/* The ideas pop up as small round bubbles in random spots under the heading (owner: "ตุ่มกลมๆ เล็กๆ Random ขึ้นมา … ใต้
   Section พวกนี้ นี่แหละ สวยเลย"): a few at a time, each in a free cell of a loose grid with a little jitter, pops in, floats,
   lingers 3.5–6 s, fades, and another pops up elsewhere. Every bubble stays a real button. Reduced motion: a still row. */
const BUBBLE_KEYFRAMES = "@keyframes ff-idea-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}@keyframes ff-bubble-in{0%{opacity:0;transform:translate(-50%,-50%) scale(.55)}100%{opacity:1;transform:translate(-50%,-50%) scale(1)}}@keyframes ff-bubble-out{0%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(.8)}}";
const BUBBLE_MAX = 8;
const BUBBLE_TICK_MS = 600;
const BUBBLE_OUT_MS = 260;

/* The loose grid: 3 rows × `cols` cells, plus one "whole row" cell per row for a long idea (a long bubble takes its row
   alone, so it never runs into a neighbour on a phone). Columns sit a little inside the edges. */
const LONG_IDEA = 22;
function bubbleCells(cols) {
  const rows = cols === 2 ? 5 : 4;
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const y = ((r + 0.5) / rows) * 100;
    for (let c = 0; c < cols; c += 1) out.push({ row: r, wide: false, x: cols === 2 ? (c === 0 ? 30 : 70) : ((c + 0.5) / cols) * 100, y });
    out.push({ row: r, wide: true, x: 50, y });
  }
  return out;
}
const ideaLen = (it) => (Array.isArray(it.parts) ? it.parts.reduce((n, p) => n + (p.t ? p.t.length + 1 : p.logo ? 11 : 3), 0) : it.text.length);
/* A cell is free when nothing sits in it, and its row has no wide bubble (a wide one needs its whole row empty). */
function cellFree(cells, i, taken) {
  const c = cells[i];
  const inRow = taken.filter((j) => cells[j] && cells[j].row === c.row);
  if (c.wide) return inRow.length === 0;
  return !inRow.some((j) => j === i || cells[j].wide);
}

function IdeaBubbles({ pool, send, busy, cols: fixedCols = null, max = null, height = null, still: stillAsked = false }) {
  const [winCols, setCols] = useState(() => (typeof window !== "undefined" && window.innerWidth < 640 ? 2 : 3));
  const cols = fixedCols || winCols;
  const [list, setList] = useState([]);
  const seq = useRef(0);
  const still = stillAsked || reducedMotion();
  useEffect(() => {
    const onResize = () => setCols(window.innerWidth < 640 ? 2 : 3);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (still || !pool.length) return undefined;
    const cells = bubbleCells(cols);
    const tick = () => {
      const now = Date.now();
      setList((cur) => {
        let next = cur
          .filter((x) => !(x.dying && now - x.dying > BUBBLE_OUT_MS))
          .map((x) => (!x.dying && now > x.until ? { ...x, dying: now } : x));
        const live = next.filter((x) => !x.dying);
        if (live.length < Math.min(max || (cols === 2 ? 6 : BUBBLE_MAX), pool.length)) {
          const taken = next.map((x) => x.cell);
          const freeIdeas = pool.filter((it) => !next.some((x) => x.idea.text === it.text));
          const idea = freeIdeas.length ? freeIdeas[Math.floor(Math.random() * freeIdeas.length)] : null;
          /* A long idea takes a whole free row on a phone (or anywhere it would not fit a cell); a short one a free cell. */
          const wide = !!idea && ideaLen(idea) > (cols === 2 ? 19 : LONG_IDEA);
          const freeCells = idea ? cells.map((_, i) => i).filter((i) => cells[i].wide === wide && cellFree(cells, i, taken)) : [];
          if (idea && freeCells.length) {
            const cell = freeCells[Math.floor(Math.random() * freeCells.length)];
            seq.current += 1;
            next = [...next, {
              id: seq.current, idea, cell,
              /* Two columns stack five rows close together (the Chat tab's 190px): a smaller vertical jitter there, so
                 two bubbles in neighbouring rows never overlap. */
              dx: cells[cell].wide ? 0 : (Math.random() - 0.5) * (cols === 2 ? 4 : 8), dy: (Math.random() - 0.5) * (cols === 2 ? 4 : 12),
              until: now + 3500 + Math.random() * 2500, float: 3.6 + Math.random() * 1.6,
            }];
          }
        }
        return next;
      });
    };
    /* Fill fast at first (never a half-empty field), then the slow come-and-go. */
    let t = null;
    let n = 0;
    const loop = () => { tick(); n += 1; t = setTimeout(loop, n < 10 ? 160 : BUBBLE_TICK_MS); };
    loop();
    return () => clearTimeout(t);
  }, [pool, cols, still, max]);

  if (still) {
    return (
      <div className={`${stillAsked ? "mt-4" : "mt-5"} flex max-w-[560px] flex-wrap justify-center gap-1.5`} aria-label="Recommended">
        {pool.slice(0, max || BUBBLE_MAX).map((it) => <IdeaButton key={it.text} it={it} send={send} busy={busy} />)}
      </div>
    );
  }
  const cells = bubbleCells(cols);
  return (
    <div className={`relative mt-3 w-full max-w-[640px] ${height || "h-[250px] md:h-[210px]"}`} aria-label="Recommended">
      {/* The bubbles' own keyframes, with them wherever they show (the Agent page and a market's Chat tab alike): the
          pop-in holds each bubble's centring transform, so without it a bubble hangs off its cell's right edge. */}
      <style>{BUBBLE_KEYFRAMES}</style>
      {list.map((x) => {
        const c = cells[x.cell] || { x: 50, y: 50 };
        return (
          <span
            key={x.id}
            className="absolute"
            style={{
              left: `${c.x + x.dx}%`, top: `${c.y + x.dy}%`,
              animation: x.dying ? `ff-bubble-out ${BUBBLE_OUT_MS}ms ease-in forwards` : "ff-bubble-in 420ms cubic-bezier(.2,.9,.3,1.25) both",
            }}
          >
            <span className="inline-flex" style={{ animation: `ff-idea-float ${x.float}s ease-in-out infinite` }}>
              <IdeaButton it={x.idea} send={send} busy={busy || !!x.dying} />
            </span>
          </span>
        );
      })}
    </div>
  );
}

function IdeaButton({ it, send, busy }) {
  return (
    <button type="button" disabled={busy} onClick={() => send(it.text)} className={IDEA}>
      {Array.isArray(it.parts) ? it.parts.map((p, i) => (p.coin
        ? <CoinLogo key={i} coin={p.coin} size={14} />
        : p.logo ? <SponsorLogo key={i} name={p.logo} variant="wordmark" size={11} alt={p.logo} className="translate-y-px" />
          : <span key={i}>{p.t}</span>))
        : (
          <>
            {it.coin ? <CoinLogo coin={it.coin} size={14} /> : it.mark ? <SponsorLogo name={it.mark} variant="mark" size={10} alt="" /> : null}
            {it.text}
          </>
        )}
    </button>
  );
}

function PageWelcome({ signedIn, askSignIn, send, busy }) {
  const b = useBackend();
  const snap = usePerpMarkets();
  const held = b.account && b.account.positions && b.account.positions.answered
    ? (b.account.positions.list || []).filter((p) => p && Number.isFinite(p.szi) && p.szi !== 0).map((p) => p.coin).slice(0, 3) : [];
  const topCoin = useMemo(() => {
    const list = (snap.markets || []).filter((m) => m && !m.isHip3 && Number.isFinite(m.dayNtlVlm) && m.dayNtlVlm > 5e6 && Number.isFinite(m.change24h));
    list.sort((x, y) => Math.abs(y.change24h) - Math.abs(x.change24h));
    return list[0] ? list[0].coin : null;
  }, [snap.markets]);
  const pool = useMemo(() => ideaPool({ held, topCoin }), [held.join(","), topCoin]); // eslint-disable-line react-hooks/exhaustive-deps
  const [signing, setSigning] = useState(false);
  useEffect(() => { if (askSignIn) setSigning(true); }, [askSignIn]);

  return (
    <div className="t-swap-in flex min-h-[44vh] flex-col items-center justify-center px-2 pt-6 text-center md:min-h-[52vh]">
      <LogoMark size={36} />
      <h2 className="mt-4 text-[20px] font-semibold leading-tight tracking-[-0.02em] md:text-[24px]">{HEADLINE}</h2>
      {signedIn ? null : (
        <div className="mt-4 w-full max-w-[320px]">
          {signing ? (
            <ConnectCard start="list" bare />
          ) : (
            <Button variant="primary" size="lg" className="w-full" onClick={() => setSigning(true)}>
              <Icon name="wallet" size={18} /> Sign in now
            </Button>
          )}
        </div>
      )}
      <IdeaBubbles pool={pool} send={send} busy={busy} />
    </div>
  );
}

export default function ChatThread({ coin = null, compact = false, onActions = null }) {
  const { messages: all, busy } = useChat();
  /* A market's Chat tab is that market's own conversation; the Agent page shows them all. */
  const messages = useMemo(() => (compact && coin ? all.filter((m) => m.scope === coin) : all), [all, compact, coin]);
  const b = useBackend();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const scroller = useRef(null);
  const firstScroll = useRef(true);
  const latestCardId = useMemo(() => [...messages].reverse().find((m) => m.role === "card")?.id, [messages]);
  const latestTextId = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant")?.id, [messages]);
  const turns = useMemo(() => buildTurns(messages), [messages]);
  /* The chips follow the newest card on screen (chips.js), and the page's market (else ETH) when there is none. */
  const heldKey = b.connected && b.account && b.account.positions && b.account.positions.answered
    ? (b.account.positions.list || []).filter((p) => p && Number.isFinite(p.szi) && p.szi !== 0).map((p) => p.coin).join(",") : "";
  const chips = useMemo(() => {
    const cards = [...messages].reverse().filter((m) => m.role === "card" && m.card).map((m) => m.card);
    return chipsFor({ cards, coin, held: heldKey ? heldKey.split(",") : [], compact });
  }, [messages, coin, heldKey, compact]);

  /* The thread sticks to its bottom while the reader is there: a new message glides in, and a card that grows after it
     mounts (a chart, a quote, an analysis filling in) never leaves its button under the composer. Scrolled up to
     read, it stays put. */
  const content = useRef(null);
  const pinned = useRef(true);
  const glideUntil = useRef(0);
  const count = useRef(0);
  count.current = messages.length;
  useEffect(() => {
    const el = scroller.current;
    /* The empty thread reads from the top (its boxes); a conversation lands at its bottom. */
    if (!el || !messages.length) return;
    pinned.current = true;
    glideUntil.current = Date.now() + 2000;
    /* The first paint lands at the bottom at once; later messages glide in. */
    el.scrollTo({ top: el.scrollHeight, behavior: firstScroll.current ? "auto" : "smooth" });
    firstScroll.current = false;
  }, [messages.length, busy]);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver !== "function") return undefined;
    let h = inner.offsetHeight;
    let room = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h2 = inner.offsetHeight;
      const room2 = el.clientHeight;
      const moved = h2 > h + 1 || room2 < room - 1;
      h = h2;
      room = room2;
      if (moved && count.current && (pinned.current || Date.now() < glideUntil.current)) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  /* The full page asks for sign-in before anything (owner: "ถ้ายังไม่ Signin ต้องบังคับให้ Signin ก่อน"); a mock build counts as in. */
  const signedIn = !!(b.connected || b.mock);
  const [askSignIn, setAskSignIn] = useState(0);
  const send = async (raw, subject = null) => {
    const t = String(raw || "").trim();
    if (!t || busy) return;
    /* Signed out: the words wait in the composer (and across the sign-in's redirect) and go out once signed in. */
    if (!compact && !signedIn) { setText(t); keepPending(t); setAskSignIn((n) => n + 1); return; }
    /* A box or pill speaks for itself: what the reader was typing stays in the composer. */
    if (t === text.trim()) setText("");
    chat.setScope(compact ? coin : null);
    chat.push({ role: "user", text: t });
    /* The whole answer (agent.js handleMessage): shortcuts first (a trade card gets its recommended TP / SL from the
       1h chart), then the app's own intents (plans, setups, staking, analyze), then the model. Each tells the model's
       history what it showed. Nothing here sends money: every move is a card that waits for Confirm. */
    chat.setBusy(true);
    try {
      await handleMessage(t, { coin, backend: b, navigate, ...(compact && coin ? { scope: coin } : {}), ...(subject && typeof subject === "object" ? { subject } : {}) });
    } catch (e) {
      chat.push({ role: "assistant", text: `${String(e?.message || e)} ${HELP}`, tone: "error" });
    } finally {
      chat.setBusy(false);
      chat.setScope(null);
    }
  };

  const sentPending = useRef(false);
  useEffect(() => {
    if (compact || !signedIn || busy || sentPending.current) return;
    const t = takePending();
    if (!t) return;
    sentPending.current = true;
    setText("");
    send(t);
  }, [signedIn, busy, compact]); // eslint-disable-line react-hooks/exhaustive-deps

  /* "Thinking…" shows only while nothing else says the Agent is at work: inside the open turn when its steps are
     done, or as its own byline when the Agent has not answered yet. */
  const lastTurn = turns[turns.length - 1];
  const lastItem = lastTurn && lastTurn.kind === "agent" ? lastTurn.items[lastTurn.items.length - 1] : null;
  const stepRunning = !!(lastItem && lastItem.kind === "work" && lastItem.steps.some((s) => s.state === "running"));
  const thinkInTurn = busy && !!lastTurn && lastTurn.kind === "agent" && !stepRunning;
  const thinkAlone = busy && (!lastTurn || lastTurn.kind === "user");

  const ready = !!text.trim();
  /* Boxes and pills say their words through the same send as the composer (always this render's, via the ref). */
  const sendRef = useRef(send);
  sendRef.current = send;
  const actions = useMemo(() => ({ send: (t, subject) => sendRef.current(t, subject), busy, navigate, coin }), [busy, navigate, coin]);
  const liveBackend = useRef(b);
  liveBackend.current = b;
  /* The page's rail (its positions' Analyze pills) speaks through the same send. */
  useEffect(() => { if (typeof onActions === "function") onActions(actions); }, [actions, onActions]);
  useEffect(() => () => { if (typeof onActions === "function") onActions(null); }, [onActions]);

  useEffect(() => {
    if (!DEV_FIXTURES || compact || devFixtureRan || typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    if (!q.get("fixture")) return;
    devFixtureRan = true;
    DEV_FIXTURES().then((m) => m.runDevFixture(q.get("fixture"), { getBackend: () => liveBackend.current, coin: q.get("coin"), profile: q.get("profile") })).catch(() => {});
  }, [compact]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Compact (the market page's Chat tab): fills the trade aside, a size container, less the panel's padding and tab
     track (92px); without that container it keeps the fixed fallback height. */
  return (
    <ChatActionsContext.Provider value={actions}>
    <div className={`flex min-h-0 flex-col ${compact ? "h-[min(560px,calc(100dvh-260px))] [@container(min-height:240px)]:h-[calc(100cqh-92px)]" : "h-full"}`}>
      <div ref={scroller} onScroll={onScroll} className={`min-h-0 flex-1 overflow-y-auto ${compact ? "-mx-1 px-1" : ""}`}>
        <div ref={content} className={compact ? "space-y-4 pb-3" : "mx-auto w-full max-w-[760px] space-y-4 px-gutter pb-6 pt-4 md:pt-6 xl:max-w-[880px]"}>
          {messages.length === 0 ? (
            compact ? <Welcome coin={coin} send={send} busy={busy} /> : <PageWelcome signedIn={signedIn} askSignIn={askSignIn} send={send} busy={busy} />
          ) : (
            turns.map((t) => (t.kind === "user"
              ? (
                <div key={t.id} className="t-rise ml-auto w-fit max-w-[82%] whitespace-pre-wrap break-words rounded-xl rounded-br-md bg-muted px-3.5 py-2.5 text-sm text-foreground">
                  {t.m.via === "voice" ? <Glyph name="mic" size={13} className="mr-1.5 inline-block -translate-y-px text-muted-foreground" /> : null}
                  {t.m.pending ? <ShimmerText text={t.m.text && t.m.text !== "…" ? t.m.text : "Listening…"} /> : t.m.text}
                </div>
              )
              : <AgentTurn key={t.id} turn={t} latestCardId={latestCardId} latestTextId={latestTextId} thinking={thinkInTurn && t === lastTurn} />))
          )}
          {thinkAlone ? (
            <div className="flex items-center gap-2 pt-3">
              <LogoMark size={18} className="shrink-0" />
              <ShimmerText text="Thinking…" className="font-mono text-[11px]" />
            </div>
          ) : null}
        </div>
      </div>
      {/* The composer. On the full page, what scrolls under it fades into the paper over 14px instead of a hard cut
          (design review 6); the call popup floats above it while a voice call is on. */}
      <div className={compact ? "relative border-t border-hairline pt-2" : "relative bg-background"}>
        {compact ? null : <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-full h-3.5 bg-gradient-to-t from-background to-background/0" />}
        {VoiceStatus ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-3 flex justify-center px-4">
            <Quiet>
              <Suspense fallback={null}>
                <VoiceStatus className="pointer-events-auto w-full max-w-[420px]" />
              </Suspense>
            </Quiet>
          </div>
        ) : null}
        <div className={compact ? "space-y-2" : "mx-auto w-full max-w-[760px] space-y-2 px-gutter pb-3 pt-2 xl:max-w-[880px]"}>
          {/* The strip runs to the edge of what holds it (the screen on phones, the trade aside's 20px padding in the
              Chat tab), so a cut chip reads as "scroll", not as clipping. */}
          {messages.length ? (
            <div className={`no-scrollbar flex gap-1.5 overflow-x-auto py-1.5 ${compact ? "-mx-5 px-5" : "-mx-gutter px-gutter md:-mx-1 md:px-1"}`}>
              {chips.map((c) => (
                <button key={c.text} type="button" onClick={() => send(c.text)} disabled={busy} className={CHIP}>
                  <ChipGlyph chip={c} />
                  {c.label || c.text}
                </button>
              ))}
            </div>
          ) : null}
          <form
            onSubmit={(e) => { e.preventDefault(); send(text); }}
            className="flex h-[52px] items-center gap-2 rounded-xl bg-card pl-4 pr-1.5 ring-1 ring-inset ring-input transition-shadow focus-within:shadow-halo focus-within:ring-ring"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask or trade…"
              aria-label="Message FlowFlow"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:outline-none"
            />
            {VoiceButton ? (
              <Quiet>
                <Suspense fallback={null}>
                  <VoiceButton coin={coin} disabled={busy || (!compact && !signedIn)} />
                </Suspense>
              </Quiet>
            ) : null}
            <button
              type="submit"
              aria-label="Send"
              disabled={!ready || busy}
              data-state={busy ? "busy" : ready ? "ready" : "quiet"}
              className="ff-press ff-send ff-hit relative size-10 shrink-0 rounded-lg disabled:cursor-default lg:size-9"
            >
              <svg viewBox="0 0 64 64" className="block size-full" aria-hidden="true">
                <rect className="tile" width="64" height="64" rx="16" />
                <path className="w1" d="M14 26c6-6 12-6 18 0s12 6 18 0" />
                <path className="w2" d="M14 40c6-6 12-6 18 0s12 6 18 0" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
    </ChatActionsContext.Provider>
  );
}
