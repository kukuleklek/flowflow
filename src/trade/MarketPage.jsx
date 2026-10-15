import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePerpMarket, formatHlPrice } from "../lib/hyperliquid/index.js";
import Sheet from "../ui/Sheet.jsx";
import Seg from "../ui/Seg.jsx";
import Button, { IconButton } from "../ui/Button.jsx";
import Icon from "../ui/Icon.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import { useBackend } from "../perp/BackendContext.jsx";
import { chartLinesFor, tpslView } from "../perp/live/perpLiveView.js";
import CoinBar from "./CoinBar.jsx";
import PriceChart from "./PriceChart.jsx";
import TradePanel from "./TradePanel.jsx";
import TradeForm from "./TradeForm.jsx";
import CoinLogo from "../ui/CoinLogo.jsx";
import PositionsPanel from "./PositionsPanel.jsx";

function useIsDesktop() {
  const q = "(min-width: 1024px)";
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setOn(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return on;
}

/** The position's entry / liq / TP / SL lines for the chart. */
function usePositionLines(coin) {
  const b = useBackend();
  const acc = b.account || {};
  const pos = acc.positions && acc.positions.byCoin ? acc.positions.byCoin[coin] || null : null;
  const orders = acc.orders || null;
  return useMemo(() => {
    if (!pos) return [];
    let tpsl = null;
    try {
      const t = tpslView(orders, coin, { position: pos });
      tpsl = t ? { tp: t.tp, sl: t.sl } : null;
    } catch { tpsl = null; }
    return chartLinesFor(pos, tpsl, { mock: b.mock });
  }, [pos, orders, coin, b.mock]);
}

const SIDES = [{ value: "long", label: "Long", tone: "long" }, { value: "short", label: "Short", tone: "short" }];

/* Phone: the trade bar — a solid floating card on the safe area with the market, the lime Long and the
   12% red Short. It slides up 120ms after the page opens; a press opens the trade sheet. It is rendered as a
   SIBLING of the animated page root (a fixed bar inside a t-enter block would be re-parented while it rises). */
function MobileTradeBar({ coin, market, stale }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("long");
  const [shown, setShown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShown(true), 120); return () => clearTimeout(t); }, []);
  const label = market ? (market.label || market.coin) : coin;
  const press = (side) => {
    try { navigator.vibrate?.(8); } catch { /* no haptics */ }
    setTab(side);
    setOpen(true);
  };
  return (
    <>
      <div
        className="fixed inset-x-0 bottom-0 z-30 pb-[env(safe-area-inset-bottom)] transition-[transform,opacity] duration-slow ease-smooth motion-reduce:![transform:none] lg:hidden"
        style={{ transform: shown ? "translateY(0)" : "translateY(110%)", opacity: shown ? 1 : 0 }}
      >
        <div className="mx-4 mb-3 flex items-center gap-2 rounded-2xl bg-card p-2 shadow-float">
          <Link to={`/agent?coin=${encodeURIComponent(coin)}`} aria-label={`Ask FlowFlow about ${label}`} className="flex h-12 min-w-0 max-w-[34%] items-center gap-2 rounded-lg pl-1">
            <CoinLogo coin={coin} size={32} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight">{label}</span>
              <TickNumber value={formatHlPrice(market?.px, market?.szDecimals, { prefix: "" })} className="block truncate font-mono text-xs text-muted-foreground" />
            </span>
          </Link>
          <Button variant="long" size="xl" className="flex-1" onClick={() => press("long")}>Long</Button>
          <Button variant="short" size="xl" className="flex-1" onClick={() => press("short")}>Short</Button>
        </div>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} label={`Trade ${label}`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <CoinLogo coin={coin} size={24} />
            <span className="truncate text-h2">{label}-USD</span>
            <TickNumber value={formatHlPrice(market?.px, market?.szDecimals)} className="num text-xs text-muted-foreground" />
          </div>
          <IconButton label="Close" className="-mr-2.5" onClick={() => setOpen(false)}><Icon name="x" size={18} /></IconButton>
        </div>
        <Seg label="Side" full size="lg" value={tab} onChange={setTab} items={SIDES} className="mb-5" />
        <TradeForm key={coin} coin={coin} market={market} stale={stale} side={tab === "short" ? "sell" : "buy"} />
      </Sheet>
    </>
  );
}

/**
 * The market terminal. Desktop (≥1024): no page scroll — a coin band over a chart that takes what is left, a 232px
 * positions strip under it, and the 384px white trade aside on the right, all on 1px rules. Phone: coin band,
 * 320px chart, positions, and the floating trade bar.
 *
 * The page root carries t-enter and its DIRECT children are the sections (coin band → chart → positions → aside), so
 * they rise in one after another. A CSS grid places them at lg, which keeps them siblings.
 */
export default function MarketPage() {
  const { coin: raw } = useParams();
  const coin = decodeURIComponent(raw || "BTC");
  const { market, ready, stale } = usePerpMarket(coin);
  const desktop = useIsDesktop();
  const [tab, setTab] = useState("long");
  const lines = usePositionLines(coin);
  const label = market ? (market.label || market.coin) : coin;

  if (ready && !market) {
    return (
      <div className="t-enter mx-auto max-w-md px-gutter pt-16">
        <h1 className="text-h2">No market called {coin}</h1>
        <p className="mt-1 text-sm text-muted-foreground">It may have been delisted.</p>
        <Link to="/trade" className="mt-4 inline-block"><Button variant="primary" size="md" tabIndex={-1}>Browse markets</Button></Link>
      </div>
    );
  }

  return (
    <>
      <div className="t-enter pb-[calc(88px+env(safe-area-inset-bottom))] lg:grid lg:h-[calc(100dvh-57px)] lg:grid-cols-[minmax(0,1fr)_384px] lg:grid-rows-[auto_minmax(0,1fr)_232px] lg:overflow-hidden lg:pb-0">
        <CoinBar coin={coin} market={market} stale={stale} />
        <div className="min-w-0 lg:col-start-1 lg:row-start-2 lg:flex lg:min-h-0 lg:flex-col lg:border-r lg:border-border">
          <PriceChart
            coin={coin}
            szDecimals={market ? market.szDecimals : null}
            refPx={market ? market.px : null}
            lines={lines}
            height={320}
            compact={desktop}
          />
        </div>
        <div className="min-w-0 border-t border-border lg:col-start-1 lg:row-start-3 lg:min-h-0 lg:overflow-y-auto lg:border-r">
          <PositionsPanel coin={coin} />
        </div>
        {/* The aside is a size container so the Chat tab can fill its height (ChatThread compact). */}
        {desktop ? (
          <aside aria-label={`Trade ${label}`} className="min-h-0 overflow-y-auto bg-card [container-type:size] lg:col-start-2 lg:row-span-2 lg:row-start-2">
            <TradePanel coin={coin} market={market} stale={stale} tab={tab} onTab={setTab} />
          </aside>
        ) : null}
      </div>
      {!desktop ? <MobileTradeBar coin={coin} market={market} stale={stale} /> : null}
    </>
  );
}
