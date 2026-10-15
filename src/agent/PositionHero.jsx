import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AutoHeight, SuccessCheck } from "../ui/kit/index.ts";
import Icon from "../ui/Icon.jsx";
import Button from "../ui/Button.jsx";
import CoinLogo from "../ui/CoinLogo.jsx";
import LiveDot from "../ui/LiveDot.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import { StatStrip, Stat } from "../ui/Stat.jsx";
import { sidePill } from "../ui/badge.js";
import { minus } from "../ui/num.js";
import { useBackend } from "../perp/BackendContext.jsx";
import { usePerpMarket, formatHlPrice } from "../lib/hyperliquid/index.js";
import { positionView, perpCoinLabel, liqGap, LIQ_WARN_WITHIN, tpslView } from "../perp/live/perpLiveView.js";
import { heldPosition } from "../trade/useOrderQuote.js";
import { TpSlEditor } from "../trade/PositionsPanel.jsx";
import { chat } from "./store.js";
import AnalyzeChip from "./cards/AnalyzeChip.jsx";
import { coinLabel, pairLabel, customerWords } from "./cards/viewWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const toneText = (t) => (t === "pos" ? "text-success" : t === "neg" ? "text-destructive" : "text-foreground");

/* The read-back after the fill (TradeCard.jsx verifyFill → lib/hyperliquid/readBack.js): what Hyperliquid holds,
   compared with what was confirmed. 🔴 Never silent: a mismatch (or a read that failed) is a row in the customer's
   words; a match is one quiet line. Nothing until the read has answered. */
function ReadBack({ rb }) {
  if (!rb || typeof rb !== "object") return null;
  const rows = Array.isArray(rb.rows) ? rb.rows.filter((r) => r && typeof r.text === "string").slice(0, 4) : [];
  if (rb.ok && !rows.length) {
    return (
      <p className="flex items-center gap-1.5 px-4 pb-2 text-[11px] text-muted-foreground">
        <SuccessCheck size={12} className="text-success" />Checked on your account: matches what you confirmed.
      </p>
    );
  }
  return (
    <div role="status" className="mx-4 mb-2.5 space-y-1 rounded-lg bg-warning/[.08] px-3 py-2 text-xs ring-1 ring-inset ring-warning/25">
      {rows.map((r) => (
        <p key={r.text} className={`flex items-start gap-1.5 ${r.severity === "error" ? "text-foreground" : "text-muted-foreground"}`}>
          <Icon name="alert" size={13} className="mt-px shrink-0 text-warning" />
          <span>{r.text}</span>
        </p>
      ))}
    </div>
  );
}

/* What a confirmed FlowFlow order becomes: the position itself — Avg. entry and the live P&L, the two figures a trader
   looks at first, at the compact 24px figure (polish 1) — streaming from the account (positionView, one source per figure). Until the
   account has the position, the entry is the fill's own price and the P&L pulses; once it has been seen and is
   gone, the card says so instead of showing a stale figure. */
export default function PositionHero({ card }) {
  const b = useBackend();
  const navigate = useNavigate();
  const { market } = usePerpMarket(card.coin);
  const held = heldPosition(b, card.coin);
  const seen = useRef(false);
  const [tpsl, setTpsl] = useState(false);
  if (held) seen.current = true;
  const sz = market ? market.szDecimals : null;
  const v = held ? positionView(held, { szDecimals: sz }) : null;
  const label = coinLabel(card.coin, market) || perpCoinLabel(card.coin, market);
  const closed = !held && seen.current;
  const [waited, setWaited] = useState(false);
  useEffect(() => { const t = setTimeout(() => setWaited(true), 8000); return () => clearTimeout(t); }, []);

  const entryText = v ? v.entryText : fin(card.entryPx) ? formatHlPrice(card.entryPx, sz) : "—";
  const pending = !v && !closed;

  if (closed || (!held && waited && !fin(card.entryPx))) {
    return (
      <div className="t-swap-in flex items-center gap-2.5 px-4 py-2.5">
        <SuccessCheck size={20} className="text-success" />
        <CoinLogo coin={card.coin} size={20} />
        <div className="min-w-0">
          <div className="text-sm font-medium">{customerWords(card.title) || `${label} filled`}</div>
          <div className="text-xs text-muted-foreground">{closed ? "This position is closed now." : customerWords(card.fillText) || ""}</div>
        </div>
      </div>
    );
  }

  /* Until the account has the position, the side comes from the card itself. */
  const side = v && v.side ? v.side : card.side === "buy" ? "long" : card.side === "sell" ? "short" : null;
  const pill = v && v.side ? v.pill : side === "long" ? "Long" : side === "short" ? "Short" : null;
  const tone = toneText(v ? v.pnlTone : null);
  const margin = v ? `${v.marginText}${v.marginUnit === "usdc" ? " USDC" : ""}` : "—";

  /* "View on chart" (owner, after a fill: no forced jump; the market page draws entry / TP / SL) is there from the
     fill on; TP / SL and Close need the account's position. A narrow card puts the three in one even row with
     short words, so none of them is left alone on a line. */
  const closeCard = () => chat.push({ role: "card", card: { kind: "close", coin: card.coin, fraction: 1, status: "review" } });
  const narrow = (
    <div className={`grid gap-2 ${held ? "grid-cols-3" : "grid-cols-1"}`}>
      {held ? (
        <Button variant={tpsl ? "soft" : "outline"} size="sm" className="!px-2" onClick={() => setTpsl((o) => !o)} aria-expanded={tpsl}>
          {tpsl ? "Hide" : "TP / SL"}
        </Button>
      ) : null}
      <Button variant="outline" size="sm" className="!px-2" onClick={() => navigate(`/trade/${card.coin}`)} aria-label="View on chart">
        <Icon name="chart" size={14} />Chart
      </Button>
      {held ? <Button variant="outline" size="sm" className="!px-2" onClick={closeCard}>Close</Button> : null}
    </div>
  );
  const actions = (
    <>
      {held ? (
        <Button variant={tpsl ? "soft" : "outline"} size="sm" onClick={() => setTpsl((o) => !o)} aria-expanded={tpsl}>
          {tpsl ? "Hide TP / SL" : "Set TP / SL"}
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => navigate(`/trade/${card.coin}`)}>
        <Icon name="chart" size={14} />View on chart
      </Button>
      {held ? (
        <Button variant="link" size="sm" onClick={closeCard}>
          Close position
        </Button>
      ) : null}
    </>
  );

  /* The liquidation cushion (desk graft): how much room the mark has before liquidation, out of the room it had at
     entry. Drawn only when both distances are known. */
  const gap = v && held ? liqGap({ side: v.side, px: market ? market.markPx : null, liqPx: held.liquidationPx }) : null;
  const entryGap = v && held ? liqGap({ side: v.side, px: held.entryPx, liqPx: held.liquidationPx }) : null;
  const cushion = fin(gap) && fin(entryGap);
  const pos = cushion && entryGap > 0 ? Math.max(0, Math.min(1, gap / entryGap)) : 0;
  const warn = cushion && gap < LIQ_WARN_WITHIN;
  /* The position's live TP / SL (the legs the confirmed card sent, or set since): read from the account's orders. */
  const legs = held ? tpslView(b.account && b.account.orders, card.coin, { szDecimals: sz, position: held }) : null;

  return (
    <div className="t-swap-in">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-2.5 pt-3">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <CoinLogo coin={card.coin} size={24} />
          <span className="text-h2">{pairLabel(card.coin, market)}</span>
          {pill ? <span className={sidePill(side)}>{pill}</span> : null}
          {/* A phone keeps the check and the dot, not their words, so the Analyze pill stays on this line (pass-2 review:
              it dropped to a row of its own, 44px before Entry / P&L). */}
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-label="Filled"><SuccessCheck size={14} className="text-success" /><span className="hidden [@container(min-width:440px)]:inline">Filled</span></span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="Live"><LiveDot /><span className="hidden [@container(min-width:440px)]:inline">Live</span></span>
        </span>
        {/* The position's own Analyze (always there): its trend, risks and a suggested TP / SL for it. */}
        <AnalyzeChip coin={card.coin} compact className="!h-7 !px-2.5 !text-[11px]" />
      </div>

      <ReadBack rb={card.readBack} />

      <div className="border-y border-hairline [@container(min-width:520px)]:grid [@container(min-width:520px)]:grid-cols-[1fr_1fr_200px]">
        <div className="grid grid-cols-2 [@container(min-width:520px)]:contents">
          <div className="min-w-0 px-4 py-3">
            <div className="text-label text-muted-foreground">Entry</div>
            <TickNumber value={entryText} className="num mt-1.5 block text-[24px] font-medium leading-none tracking-[-0.03em]" />
            <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              Mark <TickNumber value={formatHlPrice(market ? market.markPx : null, sz, { prefix: "" })} />
            </div>
          </div>
          <div className="min-w-0 border-l border-hairline px-4 py-3">
            <div className="text-label text-muted-foreground">P&amp;L</div>
            {pending
              ? <span className="skeleton-shimmer mt-1.5 block h-6 w-24 rounded-md" />
              : <TickNumber value={minus(v.pnlText)} className={`num mt-1.5 block text-[24px] font-medium leading-none tracking-[-0.03em] ${tone}`} />}
            <div className={`num mt-1.5 text-xs ${v ? tone : "text-muted-foreground"}`}>{v ? `${minus(v.roeText)} ROE` : " "}</div>
          </div>
        </div>
        <StatStrip className="border-t border-hairline px-4 py-2.5 [@container(min-width:520px)]:hidden">
          <Stat label="Size">{v ? v.sizeText : "—"}</Stat>
          <Stat label="Liq. price" valueClassName="text-warning">{v ? v.liqText : "—"}</Stat>
          <Stat label="Margin">{margin}</Stat>
        </StatStrip>
        <dl className="hidden flex-col justify-center gap-1.5 border-l border-hairline px-4 py-3 text-xs [@container(min-width:520px)]:flex">
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Size</dt><dd className="num font-medium">{v ? v.sizeText : "—"}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Liq. price</dt><dd className="num font-medium text-warning">{v ? v.liqText : "—"}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Margin</dt><dd className="num font-medium">{margin}</dd></div>
        </dl>
      </div>

      {cushion ? (
        <div className="px-4 py-2.5">
          <div className="relative h-2" aria-hidden="true">
            <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border" />
            <span className={`absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full ${warn ? "bg-warning" : "bg-foreground/60"}`} style={{ width: `${pos * 100}%` }} />
            <span className="absolute left-0 top-1/2 h-2 w-0.5 -translate-y-1/2 rounded-full bg-warning" />
            <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card" style={{ left: `${pos * 100}%` }} />
          </div>
          <p className="mt-2 flex justify-between gap-3 text-xs">
            <span className="num text-warning">Liq. {v.liqText}</span>
            {/* How far the price must move to liquidation, measured from the mark: the analysis card's own words, for
                a long and a short alike. */}
            <span className={`num ${warn ? "text-warning" : "text-muted-foreground"}`}>Liquidation {(gap * 100).toFixed(1)}% away</span>
          </p>
        </div>
      ) : null}

      {legs && legs.answered && (legs.tp != null || legs.sl != null) ? (
        <dl className={`flex flex-wrap gap-x-5 gap-y-1 px-4 pb-3 text-xs ${cushion ? "" : "pt-3"}`}>
          <div className="flex items-baseline gap-1.5"><dt className="text-muted-foreground">Take profit</dt><dd className={`num font-medium ${legs.tp != null ? "text-success" : "text-muted-foreground"}`}>{legs.tpText}{legs.tpPctText ? <span className="ml-1 font-normal text-muted-foreground">{minus(legs.tpPctText)}</span> : null}</dd></div>
          <div className="flex items-baseline gap-1.5"><dt className="text-muted-foreground">Stop loss</dt><dd className={`num font-medium ${legs.sl != null ? "text-destructive" : "text-muted-foreground"}`}>{legs.slText}{legs.slPctText ? <span className="ml-1 font-normal text-muted-foreground">{minus(legs.slPctText)}</span> : null}</dd></div>
        </dl>
      ) : null}
      <div className={`px-4 pb-3 [@container(min-width:520px)]:hidden ${cushion || (legs && legs.answered && (legs.tp != null || legs.sl != null)) ? "" : "pt-3"}`}>{narrow}</div>
      <div className={`hidden items-center gap-1 px-4 pb-3 [@container(min-width:520px)]:flex ${cushion || (legs && legs.answered && (legs.tp != null || legs.sl != null)) ? "" : "pt-3"}`}>{actions}</div>
      <AutoHeight>
        {tpsl && held ? (
          <div className="border-t border-hairline px-4 py-3">
            <TpSlEditor compact p={held} market={market} orders={b.account && b.account.orders} onDone={() => setTpsl(false)} />
          </div>
        ) : <div />}
      </AutoHeight>
    </div>
  );
}
