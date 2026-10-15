import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  usePerpMarkets, formatHlPrice, formatHlPct, formatHlUsdCompact, formatHlFunding, fetchHlCandles, peekHlCandles,
} from "../lib/hyperliquid/index.js";
import { IconSwap, UpdatingDot, exitProps, rise, usePresenceList } from "../ui/kit/index.ts";
import Seg from "../ui/Seg.jsx";
import Button from "../ui/Button.jsx";
import Icon from "../ui/Icon.jsx";
import CoinLogo from "../ui/CoinLogo.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import EmptyState from "../ui/EmptyState.jsx";
import { minus } from "../ui/num.js";
import ConnectCard from "../auth/ConnectCard.jsx";
import { useBackend } from "../perp/BackendContext.jsx";
import { useWallet } from "../hooks/useWallet.js";
import { usePortfolio } from "../hooks/usePortfolio.js";
import HomeHero from "../wallet/HomeHero.jsx";
import { FILTERS, filterMarkets, topMovers, marketLabel } from "./marketLists.js";
import { useWatchlist } from "./useWatchlist.js";

/* The Home, in the prod home's proportions (owner, 2026-10-15: "มันสวยหมดละ แต่ทีนี้อยากได้การวางสัดส่วนแบบนี้"). The
   owner's screenshot is 2000px wide at ~1.39 device scale (logo at 89 = 64 × 1.39): a 1440px screen. In CSS px the
   prod home is a 1200px box (16px padding), a 380px left column, a 20px gap and ~60px rows with 34px logos: exactly
   these values, from the prod code (3eab8f8).
     left (sticky)  the balance card (wallet/HomeHero.jsx: ONE balance, Deposit), then Top movers as a 2 × 3 grid
     right          Watchlist | Perps and the search, the filter pills, then the market list
   The coin areas stay flat on hairlines (owner: "โซนเหรียญ มันไม่ควร ขอบกลม"): the movers grid is ruled, the list is
   rows on rules on PHONES (the owner's complaint was the rounded list on a phone). DESKTOP is the prod desktop as it
   is (owner: "เอาตรงๆนะ แบบ Desktop ตัว Prod เรา สวยกว่า"): from lg the movers are small rounded cards in a 2-column grid
   and the list sits in one rounded box, with prod's sizes (32px pills, 14px tile text, 20px between the blocks).
   Lean (owner: "ต้องการหน้าแบบ ลีนๆ"): no sparklines, no shortcut hint, nothing that is not a figure or an action. */

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const coinPath = (m) => `/trade/${encodeURIComponent(m.coin)}`;

/* One grid for the table head and every desktop row (prod's): star · market · price · 24h · volume (· funding from xl:
   at lg the right column is ~590px and six columns would cut the coin names). */
const ROW_COLS = "lg:grid-cols-[28px_minmax(0,1.9fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.9fr)] xl:grid-cols-[28px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

export function Change({ pct, className = "" }) {
  const tone = !fin(pct) ? "text-muted-foreground" : pct >= 0 ? "text-success" : "text-destructive";
  return <span className={`num ${tone} ${className}`}>{minus(formatHlPct(pct))}</span>;
}

/* ── Left: the balance card ───────────────────────────────────────────────────────────────────────────────────────
   Signed out: the "Trade perps by chat" card (the owner likes it). While a sign-in is arriving (useWallet().pending)
   the balance card already takes its signed-in shape, shimmering, so the signed-out card never flashes up. */
function Balance() {
  const b = useBackend();
  const w = useWallet();
  const v = usePortfolio();
  const signedOut = !b.mock && !b.connected;
  if (signedOut && !w.pending) {
    return <ConnectCard title="Trade perps by chat" sub="Long, short, or ask the Agent. Every order waits for your OK." />;
  }
  return <HomeHero v={v} mock={!!b.mock} pending={signedOut ? w.pending : null} />;
}

/* ── Left: top movers, a ruled 2 × 3 grid (a ruled strip on phones) ───────────────────────────────────────────────── */
/* The last 24 hours as one thin line (owner: "ตรง Top Mover มีกราฟเส้นบางๆได้ไหม แบบโชว์"), from the hourly candles
   (cached and shared by lib/hyperliquid). Decoration only: nothing while they load or if they fail, never a figure. */
const closes = (c) => (Array.isArray(c) && c.length > 1 ? c.slice(-25).map((x) => x.close).filter(fin) : null);

function Spark({ coin, up, className = "" }) {
  const id = useId().replace(/:/g, "");
  const [pts, setPts] = useState(() => closes(peekHlCandles(coin, "1h", { bars: 25 })));
  useEffect(() => {
    let on = true;
    fetchHlCandles(coin, "1h", { bars: 25 }).then((c) => { if (on) setPts(closes(c)); }).catch(() => {});
    return () => { on = false; };
  }, [coin]);
  const W = 64;
  const H = 20;
  if (!pts || pts.length < 2) return <span className={`block ${className}`} aria-hidden="true" />;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * W).toFixed(2)} ${(H - 2 - ((p - lo) / span) * (H - 4)).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`t-swap-in block ${up ? "text-success" : "text-destructive"} ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#sp${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* A tile: logo + symbol (and the thin 24h line) on the first line, the price and the 24h move on the
   second. Phones: a strip cell 56% wide; lg: a cell of the 2-column grid, ruled on its left (second column) and top
   (rows after the first). */
const TILE = "w-[56%] shrink-0 snap-start border-l border-hairline first:border-l-0 sm:w-[30%] lg:w-auto lg:rounded-2xl lg:border lg:border-border lg:bg-card lg:first:border-l";

function MoverTile({ m, i }) {
  const r = rise(i);
  const up = fin(m.change24hPct) && m.change24hPct >= 0;
  return (
    <li className={`${r.className} ${TILE}`} style={r.style}>
      <Link to={coinPath(m)} className="block h-full px-4 py-3.5 transition-colors hover:bg-foreground/[.022] lg:rounded-2xl lg:p-3 lg:hover:bg-accent">
        <span className="flex items-center gap-2">
          <CoinLogo coin={m.coin} size={22} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold lg:font-medium">{marketLabel(m)}</span>
          <Spark coin={m.coin} up={up} className="h-5 w-14 shrink-0" />
        </span>
        <span className="mt-2.5 flex items-baseline justify-between gap-2 lg:mt-2">
          <TickNumber value={formatHlPrice(m.px, m.szDecimals)} className="num min-w-0 truncate text-[15px] font-medium lg:text-sm lg:font-normal" />
          <Change pct={m.change24hPct} className="shrink-0 text-sm font-semibold lg:text-xs lg:font-normal" />
        </span>
      </Link>
    </li>
  );
}

function Movers({ movers, ready }) {
  return (
    <section aria-label="Top movers">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-[-0.01em]">Top movers</h2>
        <span className="text-xs text-muted-foreground">24h</span>
      </div>
      <ul className="no-scrollbar -mx-gutter mt-3 flex snap-x snap-mandatory scroll-px-gutter overflow-x-auto border-y border-hairline px-gutter lg:mx-0 lg:mt-2.5 lg:grid lg:grid-cols-2 lg:gap-2.5 lg:overflow-visible lg:border-0 lg:px-0">
        {ready
          ? movers.map((m, i) => <MoverTile key={m.coin} m={m} i={i} />)
          : Array.from({ length: 6 }, (_, i) => (
            <li key={i} aria-hidden="true" className={`${TILE} px-4 py-3.5 lg:p-3`}>
              <span className="flex h-5 items-center gap-2"><span className="skeleton-shimmer size-[22px] rounded-full" /><span className="skeleton-shimmer h-3.5 w-12 rounded" /></span>
              <span className="mt-2.5 flex h-[22.5px] items-center justify-between lg:mt-2 lg:h-5"><span className="skeleton-shimmer h-3.5 w-16 rounded" /><span className="skeleton-shimmer h-3.5 w-12 rounded" /></span>
            </li>
          ))}
      </ul>
    </section>
  );
}

/* ── Right: the market list, flat rows on rules ─────────────────────────────────────────────────────────────────── */
const STAR = "M12 3.6l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.6l-5.1 2.7.97-5.68L3.75 9.6l5.7-.83Z";
function StarGlyph({ filled = false }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d={STAR} />
    </svg>
  );
}

function StarButton({ on, onClick, label }) {
  return (
    <button
      type="button"
      aria-label={on ? `Remove ${label} from watchlist` : `Add ${label} to watchlist`}
      aria-pressed={on}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className={`ff-press -ml-3 grid h-16 w-11 place-items-center lg:ml-0 lg:size-7 lg:rounded-lg ${on ? "text-warning" : "text-muted-foreground/60 hover:text-foreground"}`}
    >
      <IconSwap state={on ? "b" : "a"} a={<StarGlyph />} b={<StarGlyph filled />} />
    </button>
  );
}

/* Funding: green above zero, red below, muted at zero or when unknown ("—" is never a colour). */
const fundingTone = (f) => (!fin(f) || Math.abs(f) < 5e-7 ? "text-muted-foreground" : f < 0 ? "text-destructive" : "text-success");

function MarketRow({ m, starred, onStar }) {
  const price = formatHlPrice(m.px, m.szDecimals);
  return (
    <Link
      to={coinPath(m)}
      className={`grid h-16 grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-hairline transition-colors hover:bg-foreground/[.022] lg:h-auto lg:gap-x-3 lg:border-border lg:px-4 lg:py-3 lg:hover:bg-accent ${ROW_COLS}`}
    >
      <StarButton on={starred} onClick={onStar} label={marketLabel(m)} />
      <span className="flex min-w-0 items-center gap-3 lg:gap-3.5">
        <CoinLogo coin={m.coin} size={32} className="lg:!size-[34px]" />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold lg:font-medium">{marketLabel(m)}</span>
            <span className="num inline-flex h-[18px] items-center rounded-md bg-muted px-1.5 text-[11px] leading-none text-muted-foreground">{m.maxLeverage}x</span>
          </span>
          <span className="mt-1 block font-mono text-[11px] text-muted-foreground lg:hidden">Vol {formatHlUsdCompact(m.dayNtlVlm)}</span>
        </span>
      </span>
      <span className="text-right lg:hidden">
        <TickNumber value={price} className="num block text-[15px] font-medium" />
        <Change pct={m.change24hPct} className="mt-1 block text-xs font-medium" />
      </span>
      <TickNumber value={price} className="num hidden text-right text-[15px] lg:block" />
      <Change pct={m.change24hPct} className="hidden text-right text-sm font-medium lg:block" />
      <span className="num hidden text-right text-sm text-muted-foreground lg:block">{formatHlUsdCompact(m.dayNtlVlm)}</span>
      <span className={`num hidden text-right text-sm xl:block ${fundingTone(m.funding)}`}>{minus(formatHlFunding(m.funding))}</span>
    </Link>
  );
}

/** Keyed by tab + filter: a tab or filter change remounts it (rows rise again); polling never does. Unstarring in
 *  Watchlist or narrowing a search fades the rows that drop out. */
function MarketList({ rows, watch }) {
  const entries = usePresenceList(rows, (m) => m.coin);
  return (
    <ol aria-label="Markets" className="lg:[&>li:last-child>a]:border-b-0">
      {entries.map((e, i) => {
        const r = rise(i);
        return (
          <li key={e.key} className={e.leaving ? undefined : r.className} style={e.leaving ? undefined : r.style} {...exitProps(e.leaving)}>
            <MarketRow m={e.item} starred={watch.has(e.item.coin)} onStar={() => watch.toggle(e.item.coin)} />
          </li>
        );
      })}
    </ol>
  );
}

/* First load: the rows' own grid, so nothing moves when the markets land. */
function ListSkeleton() {
  const bar = "skeleton-shimmer h-3.5 rounded";
  const sub = "skeleton-shimmer block h-2.5 rounded lg:hidden";
  return (
    <div aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={`grid h-16 grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-hairline lg:h-[59px] lg:gap-x-3 lg:border-border lg:px-4 ${ROW_COLS}`}>
          <span />
          <span className="flex items-center gap-3">
            <span className="skeleton-shimmer size-8 shrink-0 rounded-full lg:size-[34px]" />
            <span className="flex flex-col gap-2">
              <span className={`${bar} block w-20`} />
              <span className={`${sub} w-16`} />
            </span>
          </span>
          <span className="flex flex-col items-end gap-2 lg:hidden">
            <span className={`${bar} block w-16`} />
            <span className={`${sub} w-12`} />
          </span>
          <span className={`${bar} ml-auto hidden w-16 lg:block`} />
          <span className={`${bar} ml-auto hidden w-12 lg:block`} />
          <span className={`${bar} ml-auto hidden w-14 lg:block`} />
          <span className={`${bar} ml-auto hidden w-16 xl:block`} />
        </div>
      ))}
    </div>
  );
}

/* Trending with the stocks in it (owner: "ใน หน้า Trending เอาหุ้นมาปนด้วยดิ"): Hyperliquid's perps and the listed
   stock perps (marketLists.js's Stock filter, with its liquidity gate), ranked together by 24h volume as Trending is.
   Search and the watchlist apply to both. A coin listed twice is kept once. */
function trendingWithStocks(markets, opts) {
  const main = filterMarkets(markets, { ...opts, filter: "trending" });
  const stocks = filterMarkets(markets, { ...opts, filter: "stock" }).filter((m) => m && m.isHip3);
  const seen = new Set();
  return [...main, ...stocks]
    .filter((m) => (seen.has(m.coin) ? false : (seen.add(m.coin), true)))
    .sort((a, b) => (fin(b.dayNtlVlm) ? b.dayNtlVlm : -1) - (fin(a.dayNtlVlm) ? a.dayNtlVlm : -1));
}

export default function MarketsPage() {
  const snap = usePerpMarkets();
  const watch = useWatchlist();
  const [tab, setTab] = useState("perps");
  const [filter, setFilter] = useState("trending");
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const movers = useMemo(() => topMovers(snap.markets, 6), [snap.markets]);
  const filtered = useMemo(() => {
    const opts = { filter, query, watch: tab === "watch" ? watch.set : null };
    return filter === "trending" ? trendingWithStocks(snap.markets, opts) : filterMarkets(snap.markets, opts);
  }, [snap.markets, filter, query, tab, watch.set]);
  const rows = useMemo(() => filtered.slice(0, 80), [filtered]);
  const listKey = `${tab}-${filter}`;

  /* "/" focuses the market search from anywhere that is not already a text field. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim();
  let empty;
  if (q) {
    empty = <EmptyState title={`No market matches “${q}”`} action={<Button variant="link" size="sm" className="-ml-1" onClick={() => setQuery("")}>Clear search</Button>} />;
  } else if (tab === "watch" && watch.set.size === 0) {
    empty = (
      <EmptyState
        title="No starred markets"
        reason="Tap the star on any market to keep it here."
        action={<Button variant="link" size="sm" className="-ml-1" onClick={() => setTab("perps")}>Browse perps <span aria-hidden="true">→</span></Button>}
      />
    );
  } else {
    empty = <EmptyState title="No markets in this list right now" reason="Try another filter." />;
  }

  return (
    <div className="t-enter mx-auto grid w-full max-w-[1200px] grid-cols-[minmax(0,1fr)] gap-x-5 gap-y-7 px-gutter pb-6 pt-4 lg:grid-cols-[380px_minmax(0,1fr)] lg:pt-8 xl:px-4">
      {/* Sticky at its resting place (the header's 57px + pt-8), so it does not jump when scrolling starts. */}
      <div className="min-w-0 space-y-7 lg:sticky lg:top-[89px] lg:space-y-5 lg:self-start">
        <Balance />
        <Movers movers={movers} ready={snap.ready} />
      </div>

      <section className="min-w-0" aria-label="Markets">
        <div className="flex items-center justify-between gap-3">
          <Seg
            label="Market list"
            value={tab}
            onChange={setTab}
            items={[{ value: "watch", label: "Watchlist" }, { value: "perps", label: "Perps" }]}
          />
          <label className="relative flex min-w-0 flex-1 items-center sm:max-w-[260px]">
            <Icon name="search" size={16} className="pointer-events-none absolute left-3 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search markets"
              aria-label="Search markets"
              aria-keyshortcuts="/"
              className="h-11 w-full rounded-xl border bg-card pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground/30 focus-visible:outline-none lg:h-9"
            />
          </label>
        </div>

        <div className="no-scrollbar -mx-gutter mt-4 flex items-center gap-2 overflow-x-auto px-gutter sm:mx-0 sm:px-0 lg:mt-3 lg:gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={`ff-press h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors lg:h-8 lg:px-3.5 lg:font-normal ${filter === f.value ? "border-foreground bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground"}`}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto hidden shrink-0 items-center gap-2 pl-4 text-xs text-muted-foreground sm:flex">
            <UpdatingDot active={snap.loading} />
            {snap.ready ? `${rows.length} markets` : ""}
          </span>
        </div>

        {/* From lg the list sits in one rounded box, as on prod; on phones it stays flat on rules. */}
        <div className="mt-2 border-t border-border lg:mt-3 lg:overflow-hidden lg:rounded-2xl lg:border lg:bg-card">
        <div className={`hidden items-center gap-x-3 border-b border-border px-4 py-2.5 text-xs text-muted-foreground lg:grid ${ROW_COLS}`}>
          <span><span className="sr-only">Watchlist</span></span>
          <span>Market</span>
          <span className="text-right">Price</span>
          <span className="text-right">24h</span>
          <span className="text-right">Volume</span>
          <span className="hidden text-right xl:block">Funding /h</span>
        </div>
          {!snap.ready ? <ListSkeleton /> : rows.length === 0 ? <div className="lg:px-4">{empty}</div> : <MarketList key={listKey} rows={rows} watch={watch} />}
        </div>
      </section>
    </div>
  );
}
