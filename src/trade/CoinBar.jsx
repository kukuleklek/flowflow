import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { IconSwap, UpdatingDot } from "../ui/kit/index.ts";
import Popover from "../ui/Popover.jsx";
import Icon from "../ui/Icon.jsx";
import { IconButton } from "../ui/Button.jsx";
import CoinLogo from "../ui/CoinLogo.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import { StatStrip, Stat } from "../ui/Stat.jsx";
import { ringBadge, perpPill } from "../ui/badge.js";
import { minus } from "../ui/num.js";
import { usePerpMarkets, formatHlPrice, formatHlPct, formatHlUsdCompact, formatHlFunding } from "../lib/hyperliquid/index.js";
import { filterMarkets, marketLabel } from "./marketLists.js";
import { useWatchlist } from "./useWatchlist.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/* The badge and text tones for a change. */
export const pctBadgeTone = (v) => (!fin(v) || v === 0 ? "bg-muted text-muted-foreground"
  : v > 0 ? "bg-success/[.08] text-success ring-1 ring-inset ring-success/[.28]"
  : "bg-destructive/[.08] text-destructive ring-1 ring-inset ring-destructive/[.28]");
export const pctTextTone = (v) => (!fin(v) || v === 0 ? "text-muted-foreground" : v > 0 ? "text-success" : "text-destructive");

/* Hyperliquid pays funding every hour, on the hour. */
function useNextFunding() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = 3_600_000 - (now % 3_600_000);
  return `${String(Math.floor(left / 60_000)).padStart(2, "0")}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;
}

/** The watchlist star: outline → filled, ink (never amber). */
function Star({ on, size = 16 }) {
  const path = "m12 4 2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6l5.6-.6L12 4Z";
  const svg = (fill) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
  return <IconSwap state={on ? "b" : "a"} a={svg(false)} b={svg(true)} />;
}

/** The market switcher: grows from the name, search on top, the most traded below. */
function MarketSwitcher({ coin, open, setOpen }) {
  const [q, setQ] = useState("");
  const snap = usePerpMarkets();
  const nav = useNavigate();
  const input = useRef(null);
  const rows = useMemo(() => filterMarkets(snap.markets, { query: q }).slice(0, 40), [snap.markets, q]);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 60); else setQ(""); }, [open]);
  return (
    <Popover open={open} onClose={() => setOpen(false)} anchor="left" label="Switch market" className="w-[min(22rem,calc(100vw-2rem))] p-2">
      <label className="relative mb-2 flex items-center">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 text-muted-foreground" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markets" aria-label="Search markets"
          className="h-10 w-full rounded-lg bg-card pl-9 pr-3 text-sm outline-none ring-1 ring-inset ring-border placeholder:text-muted-foreground focus:ring-ring focus-visible:outline-none" />
      </label>
      <ul className="max-h-[50vh] overflow-y-auto">
        {rows.map((r) => (
          <li key={r.coin}>
            <button type="button" onClick={() => { setOpen(false); nav(`/trade/${encodeURIComponent(r.coin)}`); }}
              className={`flex h-11 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted lg:h-10 ${r.coin === coin ? "bg-muted" : ""}`}>
              <span className="flex min-w-0 items-center gap-2"><CoinLogo coin={r.coin} size={22} /><span className="truncate font-medium">{marketLabel(r)}</span></span>
              <span className="flex items-baseline gap-2">
                <span className="num">{formatHlPrice(r.px, r.szDecimals)}</span>
                <span className={`num w-14 text-right text-xs ${pctTextTone(r.change24hPct)}`}>{minus(formatHlPct(r.change24hPct))}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/**
 * The coin header, for a perp, as one full-bleed band: identity (back · logo · ticker + pair ·
 * Perp meta · actions), the price hero with its 24h ring badge, then ONE dl stat strip with hairline dividers that
 * scrolls (with a right-edge fade) on phones. No venue name on a money screen.
 * The switcher hangs from the whole identity row on phones (gutter to gutter: from the name it ran 70px past the
 * screen edge and scrolled the page sideways) and from the name itself at lg.
 */
export default function CoinBar({ coin, market, stale }) {
  const next = useNextFunding();
  const watch = useWatchlist();
  const [switcher, setSwitcher] = useState(false);
  const [copied, setCopied] = useState(false);
  const sz = market ? market.szDecimals : null;
  const label = market ? marketLabel(market) : coin;
  const starred = watch.has(coin);
  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* refused */ }
  };
  const chg = market && fin(market.change24hPct) ? market.change24hPct : null;
  const starLabel = starred ? "Remove from watchlist" : "Add to watchlist";

  return (
    <header className="border-b border-border bg-background lg:col-span-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-gutter pb-3 pt-[max(12px,env(safe-area-inset-top))] lg:py-3 xl:flex-nowrap">
        <div className="relative flex min-w-0 basis-full items-center gap-2.5 lg:static xl:basis-auto">
          <Link to="/home" aria-label="Back to markets" title="Back to markets"
            className="ff-press -ml-2.5 grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:-ml-1.5 lg:size-9">
            <Icon name="arrowLeft" size={20} />
          </Link>
          <CoinLogo coin={coin} size={40} className="max-lg:!size-9" />
          <div className="min-w-0 flex-1 lg:relative lg:flex-none">
            <button type="button" data-popover-trigger aria-haspopup="dialog" aria-expanded={switcher} onClick={() => setSwitcher((o) => !o)}
              className="ff-hit flex min-w-0 max-w-full items-center gap-2 rounded-md text-left">
              <h1 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.02em] lg:text-h1">{label}</h1>
              <span className="addr shrink-0 text-xs text-muted-foreground">{label}-USD</span>
              <Icon name="chevronDown" size={16} className={`shrink-0 text-muted-foreground transition-transform duration-[var(--duration-fast)] ${switcher ? "rotate-180" : ""}`} />
            </button>
            <div className="mt-1 flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
              <span className={`${perpPill} shrink-0`}>Perp</span>
              <span className="shrink-0">up to {market ? market.maxLeverage : "—"}x</span>
            </div>
            <MarketSwitcher coin={coin} open={switcher} setOpen={setSwitcher} />
          </div>
          <span className="hidden shrink-0 rounded-full bg-card ring-1 ring-inset ring-border lg:inline-flex">
            <button type="button" onClick={() => watch.toggle(coin)} aria-pressed={starred} aria-label={starLabel} title={starLabel}
              className={`ff-press grid size-9 place-items-center rounded-full transition-colors hover:bg-muted ${starred ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Star on={starred} />
            </button>
            <button type="button" onClick={share} aria-label="Copy link to this market" title="Copy link to this market"
              className="ff-press grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <IconSwap state={copied ? "b" : "a"} a={<Icon name="copy" size={16} />} b={<Icon name="check" size={16} />} />
            </button>
          </span>
          <IconButton label={starLabel} aria-pressed={starred} onClick={() => watch.toggle(coin)}
            className={`-mr-2.5 lg:hidden ${starred ? "!text-foreground" : ""}`}>
            <Star on={starred} size={18} />
          </IconButton>
        </div>

        <div className="flex shrink-0 items-center gap-2" title="Price">
          <span className="sr-only">Price</span>
          <TickNumber value={formatHlPrice(market ? market.px : null, sz)} className="num text-price lg:text-price-sm" />
          {chg != null ? (
            <span className={ringBadge(chg > 0 ? "up" : chg < 0 ? "down" : null)}>
              <span className="sr-only">24h change </span>
              <TickNumber value={minus(formatHlPct(chg))} />
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground" aria-hidden="true">24h</span>
          <UpdatingDot active={!!stale} />
        </div>

        <StatStrip className="-mx-gutter w-[calc(100%+2*var(--gutter))] px-gutter ff-fade-r xl:mx-0 xl:ml-auto xl:w-auto xl:px-0 xl:[-webkit-mask-image:none] xl:[mask-image:none]">
          <Stat label="Mark"><TickNumber value={market ? formatHlPrice(market.markPx, sz) : "—"} /></Stat>
          <Stat label="Oracle"><TickNumber value={market ? formatHlPrice(market.oraclePx, sz) : "—"} /></Stat>
          <Stat label={`Funding · ${next}`}>{market ? minus(formatHlFunding(market.funding)) : "—"}</Stat>
          <Stat label="Open interest">{market ? formatHlUsdCompact(market.openInterestUsd) : "—"}</Stat>
          <Stat label="24h volume">{market ? formatHlUsdCompact(market.dayNtlVlm) : "—"}</Stat>
        </StatStrip>
      </div>
    </header>
  );
}
