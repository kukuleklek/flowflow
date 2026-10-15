/* The Agent's asset boxes (owner, on the empty Agent page: "ทำสวยๆหน่อย เป็นกล่องกลมๆ มีรูป Asset หรือปุ่มแนะนำ
   วิเคราะห์ Asset ด้วย Tokenomist"). Each box is one asset: its logo, its name, ONE big figure (P&L, 24h move, APY,
   price), one short line, and small pill actions. A pill only says words to the Agent (or opens the market): nothing
   here moves money.

   Where the boxes come from: the suggest engine (src/agent/suggest.js) when the build has it, else a data-driven
   fallback from the live markets, the account and the USDC Staked AAVE rate. Unknown figures are the dash, never 0.

   One anatomy at every width (design review 3–5, owner "กล่องต่างๆใหญ่ไปหน่อย"): the logo beside the title, a quiet
   11px tag (no pill; none on a position, its P&L says it), the figure under them (20px), then the 28px pills.
   The first safe action is the ink pill; Close never is. Every market box carries "Analyze". Logos: the coin, and
   the Avalanche badge on the Spot Account's USDC (no Aave mark: the words say "USDC Staked AAVE").
   A narrow row (a phone) scrolls sideways, 280px boxes with the next one peeking, like the setups row; the full
   Agent page draws open positions as a list instead of boxes (cards/PositionList: the rail from xl, one box below).

   Shared contract, chat card kind "assets":
     { items: [{ coin | "USDC", kind: "mover"|"position"|"earn"|"held"|"setup", title, figure, sub,
                 tone: "pos"|"neg"|"neutral", actions: [{ id: "analyze"|"long"|"short"|"setups"|"stake"|"tpsl"|"close"|"chart", label }] }] } */
import { useEffect, useMemo, useRef, useState } from "react";
import { rise, useIsoLayoutEffect } from "../../ui/kit/index.ts";
import Icon from "../../ui/Icon.jsx";
import SponsorLogo from "../../ui/SponsorLogo.jsx";
import { minus } from "../../ui/num.js";
import { useBackend } from "../../perp/BackendContext.jsx";
import { usePerpMarkets, formatHlPrice, formatHlPct } from "../../lib/hyperliquid/index.js";
import { positionView, perpCoinLabel, tpslView } from "../../perp/live/perpLiveView.js";
import { topMovers, mainMarkets } from "../../trade/marketLists.js";
import { assetState, suggestAssets } from "../suggest.js";
import AssetLogo, { useAaveApy, apyText } from "./AssetLogo.jsx";
import AnalyzeChip from "./AnalyzeChip.jsx";
import { useChatActions, runAction, PILL, Glyph, TOKENOMIST_ON, EARN_ON } from "./ChatActions.jsx";
import { coinLabel } from "./viewWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const KINDS = new Set(["mover", "position", "earn", "held", "setup"]);
const ACTIONS = new Set(["analyze", "long", "short", "setups", "stake", "tpsl", "close", "chart", "deposit"]);
const TONES = new Set(["pos", "neg", "neutral"]);
const LABEL = { analyze: "Analyze", long: "Long setup", short: "Short setup", setups: "Setups", stake: "Stake", tpsl: "TP / SL", close: "Close", chart: "Chart", deposit: "Deposit" };
/* An action may carry its own words (`prompt`) or page (`to`, an in-app path only). */
const promptOf = (a) => (typeof a.prompt === "string" && a.prompt.trim() ? a.prompt.trim().slice(0, 120) : null);
const pathOf = (a) => (typeof a.to === "string" && /^\/[a-z]/i.test(a.to) && !a.to.startsWith("//") ? a.to.slice(0, 120) : null);
/* The quiet tag beside a box's title. A position has none: its P&L already says it. */
const TAG = { position: null, mover: "Top mover", earn: "Earn", held: "Main Account", setup: "Market" };
const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** One item made safe to draw (anything else is dropped). */
export function normalizeItem(x) {
  if (!x || typeof x !== "object") return null;
  const coin = str(x.coin, 24);
  if (!coin) return null;
  const actions = (Array.isArray(x.actions) ? x.actions : [])
    .filter((a) => a && ACTIONS.has(a.id))
    .map((a) => ({ id: a.id, label: str(a.label, 24) || LABEL[a.id], prompt: promptOf(a), to: pathOf(a) }))
    .slice(0, 3);
  return {
    coin,
    kind: KINDS.has(x.kind) ? x.kind : "mover",
    title: str(x.title, 36) || coin,
    figure: str(x.figure, 18) || "—",
    sub: str(x.sub, 56) || "",
    tone: TONES.has(x.tone) ? x.tone : "neutral",
    warn: x.warn === "near-liquidation" ? x.warn : null,
    actions,
  };
}

/* ── The fallback: picks first (which assets), figures every render (so a box never jumps place while prices
   stream). ─────────────────────────────────────────────────────────────────────────────────────────────────── */

function openPositions(backend) {
  const acc = backend && backend.connected ? backend.account || {} : null;
  if (!acc || !acc.positions || !acc.positions.answered) return [];
  return (acc.positions.list || []).filter((p) => p && p.coin && fin(p.szi) && p.szi !== 0);
}

function pickAssets({ markets, backend, coin, compact, positions = true }) {
  const picks = [];
  const seen = new Set();
  const add = (c, kind) => { if (c && !seen.has(c)) { seen.add(c); picks.push({ coin: c, kind }); } };
  const pos = openPositions(backend).sort((a, b) => Math.abs(b.unrealizedPnl || 0) - Math.abs(a.unrealizedPnl || 0));
  const main = mainMarkets(markets);
  const has = (c) => main.some((m) => m.coin === c);
  if (compact) {
    /* The trade page's Chat tab: this market first (your position on it, else the market), then earning on USDC. */
    if (coin && pos.some((p) => p.coin === coin)) add(coin, "position");
    else if (coin && has(coin)) add(coin, "setup");
    else { const m = topMovers(markets, 1)[0]; if (m) add(m.coin, "mover"); }
    add("USDC", "earn");
    return picks.slice(0, 2);
  }
  if (positions) for (const p of pos.slice(0, 2)) add(p.coin, "position");
  for (const m of topMovers(markets, 4)) { if (picks.filter((x) => x.kind === "mover").length >= 1) break; add(m.coin, "mover"); }
  add("USDC", "earn");
  for (const c of [coin, "BTC", "ETH", "HYPE", "SOL"]) { if (picks.length >= 4) break; if (c && has(c)) add(c, "setup"); }
  for (const m of topMovers(markets, 6)) { if (picks.length >= 4) break; add(m.coin, "mover"); }
  /* Earn always makes the cut (the owner wants staking one tap away). */
  const out = picks.slice(0, 4);
  if (!out.some((p) => p.kind === "earn")) out[out.length - 1] = { coin: "USDC", kind: "earn" };
  return out;
}

function buildItem(pick, { byCoin, backend, apyPct }) {
  const { coin, kind } = pick;
  if (kind === "earn") {
    return {
      coin: "USDC", kind, title: "USDC Staked AAVE", figure: apyText(apyPct), sub: "APY · variable · on AVAX", tone: fin(apyPct) ? "pos" : "neutral",
      actions: [{ id: "stake", label: fin(apyPct) ? `Stake ${apyPct.toFixed(2)}%` : "Stake" }],
    };
  }
  const m = byCoin[coin] || null;
  const label = coinLabel(coin, m) || perpCoinLabel(coin, m);
  const sz = m ? m.szDecimals : null;
  if (kind === "position") {
    const p = openPositions(backend).find((x) => x.coin === coin);
    const v = p ? positionView(p, { szDecimals: sz }) : null;
    if (v) {
      const acc = backend.account || {};
      const legs = tpslView(acc.orders, coin, { szDecimals: sz, position: p });
      const noSl = legs.answered && legs.sl == null;
      return {
        coin, kind, title: `${label} · ${v.pill}`, figure: minus(v.pnlText), sub: `${minus(v.roeText)} ROE${noSl ? " · no SL" : ""}`, tone: v.pnlTone === "pos" ? "pos" : v.pnlTone === "neg" ? "neg" : "neutral",
        actions: [{ id: "tpsl", label: noSl ? "Add SL" : "TP / SL" }, { id: "analyze" }, { id: "chart", label: "Chart" }],
      };
    }
  }
  const ch = m && fin(m.change24hPct) ? m.change24hPct : null;
  const px = m ? formatHlPrice(m.px, sz) : "—";
  if (kind === "mover") {
    return {
      coin, kind, title: label, figure: ch == null ? "—" : minus(formatHlPct(ch)), sub: `${px} · 24h`, tone: ch == null ? "neutral" : ch >= 0 ? "pos" : "neg",
      actions: [ch != null && ch < 0 ? { id: "short", label: "Short setup" } : { id: "long", label: "Long setup" }, { id: "analyze" }],
    };
  }
  return {
    coin, kind: "setup", title: `${label}-USD`, figure: px, sub: ch == null ? "24h —" : `${minus(formatHlPct(ch))} · 24h`, tone: "neutral",
    actions: [{ id: "setups", label: "Setups" }, { id: "analyze" }],
  };
}

/* The suggest engine (src/agent/suggest.js, the Agent's logic lane): the same boxes the Agent answers with. Used when
   it gives at least two drawable boxes; anything else (or a throw) falls back to the picks above. */
function fromSuggest({ backend, snap, apyPct, coin, compact, positions = true }) {
  try {
    const state = assetState({ backend, snapshot: snap, apyPct, earnEnabled: EARN_ON, tokenomist: TOKENOMIST_ON });
    /* The trade page's Chat tab leads with its own market ("after": the focus first, then earn and movers). Without
       position boxes, one more is asked for, so the row stays full. */
    const list = suggestAssets(state, { surface: compact && coin ? "after" : "empty", focus: coin ? [coin] : [], limit: compact ? 2 : positions ? 4 : 5 });
    const items = (Array.isArray(list) ? list : []).map(normalizeItem).filter(Boolean).filter((it) => positions || it.kind !== "position");
    return items.length >= 2 ? items.slice(0, compact ? 2 : 4) : null;
  } catch {
    return null;
  }
}

/** The boxes for the empty thread: { items, ready }. positions: false leaves open positions out (the full Agent page
 *  lists them in its rail or positions box instead). */
export function useAssetItems({ coin = null, compact = false, positions = true } = {}) {
  const snap = usePerpMarkets();
  const backend = useBackend();
  const { apyPct } = useAaveApy();
  const ready = !!(snap.ready && snap.markets && snap.markets.length);
  const posCoins = openPositions(backend).map((p) => p.coin).sort().join(",");
  const sig = `${ready ? 1 : 0}|${backend.connected ? 1 : 0}|${posCoins}|${coin || ""}|${compact ? 1 : 0}|${positions ? 1 : 0}`;
  /* A slow clock, so the suggest engine's choice can follow the market without boxes jumping on every tick. */
  const [minute, setMinute] = useState(0);
  useEffect(() => { const t = setInterval(() => setMinute((n) => n + 1), 60_000); return () => clearInterval(t); }, []);
  const picks = useMemo(
    () => (ready ? pickAssets({ markets: snap.markets, backend, coin, compact, positions }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );
  /* Which boxes: re-chosen when the account or the focus changes, the APY lands, or a minute passes, never on a tick.
     Their figures stay live: a box is rebuilt from the latest snapshot when its coin's figure changes. */
  const chosen = useMemo(
    () => (ready ? fromSuggest({ backend, snap, apyPct, coin, compact, positions }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig, minute, apyPct],
  );
  const live = useMemo(
    () => (chosen && ready ? fromSuggest({ backend, snap, apyPct, coin, compact, positions }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosen, snap.updatedAt, backend.account],
  );
  const suggested = chosen ? chosen.map((c) => (live && live.find((x) => x.kind === c.kind && x.coin === c.coin)) || c) : null;
  const items = suggested || picks.map((p) => normalizeItem(buildItem(p, { byCoin: snap.byCoin, backend, apyPct }))).filter(Boolean);
  return { items, ready };
}

/* ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────────── */

const toneText = (t) => (t === "pos" ? "text-success" : t === "neg" ? "text-destructive" : "text-foreground");

function ActionGlyph({ id, onInk = false }) {
  if (id === "long") return <Glyph name="trendUp" size={13} />;
  if (id === "short") return <Glyph name="trendDown" size={13} />;
  if (id === "setups") return <Glyph name="layers" size={13} />;
  if (id === "tpsl") return <Glyph name="target" size={13} />;
  if (id === "close") return <Icon name="x" size={13} />;
  if (id === "chart") return <Icon name="chart" size={13} />;
  if (id === "deposit") return <Icon name="plus" size={13} />;
  /* Staking happens in the Spot Account, on Avalanche: its mark (the kit's white one on an ink pill); locked while
     the build has earn off. */
  if (id === "stake") return EARN_ON ? <SponsorLogo name="avalanche" variant={onInk ? "markOnDark" : "mark"} size={10} alt="" /> : <Glyph name="lock" size={12} />;
  return null;
}

/* The pills inside a box: a size smaller than the thread's (28px, 44px hit area). */
const BOX_PILL = "!h-7 !gap-1 !px-2.5 !text-[11px]";
const MAIN = "!bg-foreground !text-background !ring-foreground hover:!bg-foreground/90";

/* One pill. The box's main action is ink; the rest are quiet (white, hairline ring). */
function ActionPill({ action, coin, main, ctx, label }) {
  if (action.id === "analyze") return <AnalyzeChip coin={coin} compact className={BOX_PILL} />;
  return (
    <button
      type="button"
      disabled={!ctx || ctx.busy}
      onClick={() => {
        if (!ctx) return;
        if (action.to) ctx.navigate(action.to);
        else if (action.prompt) ctx.send(action.prompt);
        else runAction(ctx, action.id, coin);
      }}
      className={`${PILL} ${BOX_PILL} ${main ? MAIN : ""}`}
    >
      <ActionGlyph id={action.id} onInk={main} />
      {label || action.label}
    </button>
  );
}

/* A box's pills, in order: the main (safe) action first, then the rest, then Analyze, Close last. Close is never the
   ink pill (design review 1). A market box always offers Analyze: in the third place a Chart pill would take, or
   added when there is room. A stake pill shows the rate the box shows (two decimals), and outline with a lock while
   earn is off, as on the Wallet. */
function boxActions(item) {
  const market = item.coin !== "USDC" && (item.kind === "position" || item.kind === "mover" || item.kind === "setup");
  let list = item.actions.slice();
  if (market && !list.some((a) => a.id === "analyze")) {
    const chart = list.findIndex((a) => a.id === "chart");
    if (list.length >= 3 && chart >= 0) list[chart] = { id: "analyze", label: "Analyze" };
    else if (list.length < 3) list.push({ id: "analyze", label: "Analyze" });
  }
  const mainIdx = list.findIndex((a) => a.id !== "close" && a.id !== "analyze" && !(a.id === "stake" && !EARN_ON));
  const main = mainIdx >= 0 ? list[mainIdx] : null;
  const rest = list.filter((a, i) => i !== mainIdx);
  const rank = (a) => (a.id === "close" ? 2 : a.id === "analyze" ? 1 : 0);
  list = [...(main ? [main] : []), ...rest.sort((a, b) => rank(a) - rank(b))];
  const apy = /^(\d+(?:\.\d+)?)%/.exec(String(item.figure || ""));
  return list.map((a) => ({
    a,
    main: a === main,
    label: a.id === "stake" && apy && /^Stake\b/.test(a.label || "") && /%/.test(a.label || "") ? `Stake ${Number(apy[1]).toFixed(2)}%` : null,
  }));
}

function Tag({ item }) {
  const t = TAG[item.kind];
  return t ? <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">{t}</span> : null;
}

/* One box: the logo beside the title (and its quiet tag), the figure, one line, the pills at the foot. Boxes in a row
   are as tall as the tallest, their pills on one baseline. */
export function AssetBox({ item, ctx, index = 0, wide = false, className = "" }) {
  const r = rise(index);
  const actions = boxActions(item);
  /* "5.70% APY" / "971.03 USDC": the number big, the unit small; an earn box with a bare rate gets "APY". */
  const um = /^(.*\S)\s+(APY|APR|USDC)$/.exec(item.figure);
  const fig = um ? { big: um[1], unit: um[2] } : { big: item.figure, unit: item.kind === "earn" && item.figure !== "—" && /%$/.test(item.figure) ? "APY" : null };
  const locked = item.kind === "earn" && !EARN_ON && actions.some((x) => x.a.id === "stake");
  return (
    <article
      className={`${r.className} flex h-full min-w-0 flex-col rounded-xl bg-card p-3 ring-1 ring-inset ${item.warn ? "ring-warning/40" : "ring-border"} transition-shadow duration-[var(--duration-quick)] hover:shadow-[0_8px_22px_-16px_rgb(9_9_11/0.28)] ${wide ? "col-span-full" : ""} ${className}`}
      style={r.style}
    >
      <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-2.5">
        <AssetLogo coin={item.coin} size={32} chain={item.kind === "earn" ? "avalanche" : null} />
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="truncate text-sm font-medium">{item.title}</h3>
            <Tag item={item} />
          </div>
          <div className={`num mt-1 truncate text-[20px] font-medium leading-none tracking-[-0.03em] ${toneText(item.tone)}`}>
            {minus(fig.big)}
            {fig.unit ? <span className="ml-1 text-[11px] font-medium tracking-normal text-muted-foreground">{fig.unit}</span> : null}
          </div>
          {item.sub ? <p className={`mt-1 truncate text-xs ${item.warn ? "font-medium text-warning" : "text-muted-foreground"}`}>{minus(item.sub)}</p> : null}
        </div>
      </div>
      {actions.length ? (
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2.5">
          {actions.map((x, i) => <ActionPill key={`${x.a.id}${i}`} action={x.a} coin={item.coin} main={x.main} ctx={ctx} label={x.label} />)}
          {locked ? <span className="text-[11px] text-muted-foreground">Opens soon</span> : null}
        </div>
      ) : null}
    </article>
  );
}

function BoxSkeleton({ className = "" }) {
  return (
    <div className={`flex h-[112px] flex-col rounded-xl bg-card p-3 ring-1 ring-inset ring-border ${className}`} aria-hidden="true">
      <span className="grid grid-cols-[32px_1fr] gap-x-2.5">
        <span className="skeleton-shimmer size-8 rounded-full" />
        <span className="block">
          <span className="skeleton-shimmer block h-3.5 w-20 rounded" />
          <span className="skeleton-shimmer mt-2 block h-5 w-24 rounded" />
          <span className="skeleton-shimmer mt-2 block h-3 w-28 rounded" />
        </span>
      </span>
      <span className="skeleton-shimmer mt-auto block h-7 w-36 rounded-full" />
    </div>
  );
}

/* Columns from the room the grid has (the thread, or the trade aside's Chat tab): one on phones (a sideways row),
   two from 520px, three from 800px (the wide Agent page). */
function useColumns() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver((es) => { const e = es[es.length - 1]; if (e) setW(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w >= 800 ? 3 : w >= 520 ? 2 : 1];
}

/* Three of four (or five) boxes for a three-column row, so no box is left alone on a line (design review 7): a box
   that warns first, then one position, the earn (or held) box, and a market, in their own order. */
export function pickThree(list) {
  if (list.length <= 3) return list;
  const take = new Set();
  const first = (f) => list.findIndex((it, i) => !take.has(i) && f(it));
  for (const f of [(it) => !!it.warn, (it) => it.kind === "position", (it) => it.kind === "earn" || it.kind === "held", (it) => it.kind === "mover" || it.kind === "setup"]) {
    if (take.size >= 3) break;
    const i = first(f);
    if (i >= 0) take.add(i);
  }
  for (let i = 0; i < list.length && take.size < 3; i++) take.add(i);
  return list.filter((_, i) => take.has(i));
}

/** The grid of boxes. strip: a narrow row scrolls sideways (the Agent page and its answers); off, it stacks (the trade
 *  aside's Chat tab, tall enough for two boxes). */
export default function AssetBoxes({ items, loading = false, count = 4, strip: canStrip = true, className = "" }) {
  const ctx = useChatActions();
  const [ref, cols] = useColumns();
  const raw = (items || []).map(normalizeItem).filter(Boolean);
  const list = cols === 3 && raw.length > 3 && raw.length < 6 ? pickThree(raw) : raw.slice(0, 6);
  const n = loading && !raw.length ? (cols === 3 ? 3 : count) : list.length;
  const c = Math.max(1, Math.min(cols, n));
  const grid = { display: "grid", gap: 10, gridTemplateColumns: `repeat(${c}, minmax(0, 1fr))` };
  /* A phone: one sideways row of 280px boxes, the next one peeking (owner: "กล่องต่างๆใหญ่ไปหน่อย"; review, polish 1:
     four stacked boxes pushed the setups under the fold), running to the screen's edge so a cut box reads as "scroll". */
  const strip = canStrip && cols === 1 && n > 1;
  const STRIP = "no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1";
  const CELL = strip ? "w-[280px] shrink-0 snap-start" : "";
  if (loading && !raw.length) {
    return (
      <div ref={ref} className={className}>
        <div style={strip ? undefined : grid} className={strip ? STRIP : ""} role="status" aria-label="Loading">
          {Array.from({ length: n }, (_, i) => <BoxSkeleton key={i} className={CELL} />)}
        </div>
      </div>
    );
  }
  if (!list.length) return <div ref={ref} className={className} />;
  return (
    <div ref={ref} className={className}>
      <div style={strip ? undefined : grid} className={strip ? STRIP : ""}>
        {/* Two columns and an odd count: the last box takes the whole row instead of standing alone. */}
        {list.map((it, i) => <AssetBox key={`${it.kind}:${it.coin}`} item={it} ctx={ctx} index={i} className={CELL} wide={!strip && c === 2 && list.length % 2 === 1 && i === list.length - 1} />)}
      </div>
    </div>
  );
}

/* An earn box written before the USDC Staked AAVE rate was read (its figure the dash) shows the live rate once this
   page has it: the same reading the Stake card uses. A rate the box already carries is left as written. */
function withLiveApy(item, apyPct) {
  if (!item || item.kind !== "earn" || !fin(apyPct)) return item;
  const fig = typeof item.figure === "string" ? item.figure.trim() : "";
  if (fig && !/^—/.test(fig)) return item;
  return {
    ...item,
    figure: `${apyPct.toFixed(2)}% APY`,
    tone: "pos",
    actions: (Array.isArray(item.actions) ? item.actions : []).map((a) => (a && a.id === "stake" && (!a.label || a.label === "Stake") ? { ...a, label: `Stake ${apyPct.toFixed(2)}%` } : a)),
  };
}

/** The chat card kind "assets": the same boxes, as an Agent answer. */
export function AssetsCard({ card }) {
  const { apyPct } = useAaveApy();
  const items = card && Array.isArray(card.items) ? card.items : [];
  return <AssetBoxes items={items.map((it) => withLiveApy(it, apyPct))} />;
}
