/* "All your positions" (owner, polish 1: "ขวาสุดเน้นเป็น All Your Position ดีกว่า แล้วมีปุ่ม Analytics เล็กๆ"): every open
   position, biggest P&L first, one compact row each — its logo, the "3x Long" chip and the live P&L on one line, the
   entry and ROE under them with a small (24px) Analyze pill at the end. About 52px a row. The name opens its market.

   The same rows in two places: the Agent page's rail from xl, and below xl ONE box in the empty thread (review,
   polish 1: four separate 136px position boxes pushed the setups under the fold on a phone). Reads only: the pill
   says words to the Agent, the name opens a page. */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import CoinLogo from "../../ui/CoinLogo.jsx";
import TickNumber from "../../ui/TickNumber.jsx";
import { sidePill } from "../../ui/badge.js";
import { minus } from "../../ui/num.js";
import { useBackend } from "../../perp/BackendContext.jsx";
import { usePerpMarkets } from "../../lib/hyperliquid/index.js";
import { positionView, perpCoinLabel } from "../../perp/live/perpLiveView.js";
import AnalyzeChip from "./AnalyzeChip.jsx";
import { coinLabel } from "./viewWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const toneText = (t) => (t === "pos" ? "text-success" : t === "neg" ? "text-destructive" : "text-foreground");

/**
 * The account's open positions, biggest P&L first.
 * @returns {{ state: "out"|"loading"|"empty"|"rows", rows: object[] }}
 */
export function usePositionRows() {
  const b = useBackend();
  const account = b.account || {};
  const answered = !!(b.connected && account.positions && account.positions.answered);
  const all = answered ? account.positions.list || [] : null;
  const rows = useMemo(
    () => (all || []).filter((p) => p && p.coin && fin(p.szi) && p.szi !== 0)
      .sort((x, y) => Math.abs(y.unrealizedPnl || 0) - Math.abs(x.unrealizedPnl || 0)),
    [all],
  );
  const state = !b.connected ? "out" : !answered ? "loading" : rows.length ? "rows" : "empty";
  return { state, rows };
}

/** The rows themselves (no frame): each position on two short lines. */
export function PositionRows({ rows, className = "" }) {
  const snap = usePerpMarkets();
  return (
    <ul className={className}>
      {rows.map((p) => {
        const m = snap.byCoin[p.coin];
        const v = positionView(p, { szDecimals: m ? m.szDecimals : null });
        if (!v) return null;
        return (
          <li key={p.coin} className="border-b border-hairline py-1.5 last:border-b-0">
            <div className="flex items-center justify-between gap-2">
              <Link to={`/trade/${p.coin}`} className="ff-press flex min-w-0 items-center gap-2 rounded-md hover:underline hover:underline-offset-4">
                <CoinLogo coin={p.coin} size={20} />
                <span className="truncate text-sm font-semibold">{coinLabel(p.coin, m) || perpCoinLabel(p.coin, m)}</span>
                <span className={sidePill(v.side)}>{v.pill}</span>
              </Link>
              <TickNumber value={minus(v.pnlText)} className={`num shrink-0 text-sm font-medium ${toneText(v.pnlTone)}`} />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">Entry {v.entryText} · {minus(v.roeText)}</span>
              <AnalyzeChip coin={p.coin} compact size="xs" className="-my-1" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Below xl, in the empty thread: the positions as ONE box. Signed out, loading or nothing open: nothing at all (the
 *  heading's line says it; no filler). */
export function PositionsBox({ className = "" }) {
  const { state, rows } = usePositionRows();
  if (state !== "rows") return null;
  return (
    <section aria-label="All your positions" className={`t-swap-in rounded-xl bg-card px-3.5 pb-0.5 pt-2.5 ring-1 ring-inset ring-border ${className}`}>
      <div className="flex items-baseline justify-between gap-2 border-b border-hairline pb-1.5">
        <h3 className="text-sm font-medium">All your positions</h3>
        <span className="num text-[11px] text-muted-foreground">{rows.length}</span>
      </div>
      <PositionRows rows={rows} />
    </section>
  );
}
