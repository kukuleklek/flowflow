/* Close all (item 7; seen live: "ปิดทุก Position ของกู" got "Which market should I close?", then "เอาหมดเลยไอสัส" closed only
   BTC while CHIP 3x Long stayed open). ONE card for every open position, crypto and stocks alike: each row its logo,
   ticker, side pill, size and live P&L; one Confirm that closes them ONE BY ONE through the caller's closeOne(coin) —
   the same reduce-only market close a single close card sends — with a spinner on the row being closed, then a check
   or the reason it didn't. Partial failures are said plainly ("Closed 2 of 3. CHIP didn't close.") and only the ones
   that were refused may be tried again, on a new tap.

   🔴 IT NEVER OPENS ANYTHING: the only call it can make is closeOne, once per row per tap, for a coin that was on the
   list when the person tapped (the list is frozen at that tap, so a position opened meanwhile is never touched). A
   close whose reply was lost is "not confirmed": never re-sent from here, the person checks it first.

   Frameless content (like the single close card): the thread's TradeCard frame wraps it.
   Props:
     positions   the account's open positions (account.positions.list)
     closeOne    async (coin) => { ok: true } | { ok: false, code?, message? } — the caller's closeFraction(coin, fraction)
     fraction    the share of each position the card closes (1, or 0.25 / 0.5 / 0.75 as the sentence asked)
     byCoin      the live market rows (defaults to the markets store)
     onCancel    () => void — Cancel before anything ran
     onSettled   ({ total, done, failed, unknown, text }) => void — every row has an answer (also after a retry) */
import { useEffect, useRef, useState } from "react";
import { SuccessCheck, TextSwap, IconSwap } from "../../ui/kit/index.ts";
import Button from "../../ui/Button.jsx";
import Icon, { Spinner } from "../../ui/Icon.jsx";
import CoinLogo from "../../ui/CoinLogo.jsx";
import TickNumber from "../../ui/TickNumber.jsx";
import { sidePill } from "../../ui/badge.js";
import { usePerpMarkets } from "../../lib/hyperliquid/index.js";
import { closeAllRows, closeAllSummary, closeAllLabel, totalPnl, usdSigned, runCloseAll, realizedOf } from "./closeAllView.js";

const TONE = { pos: "text-success", neg: "text-destructive" };

function RowState({ s }) {
  const state = s ? s.state : "idle";
  if (state === "closing") return <Spinner size={16} />;
  if (state === "done" || state === "gone") return <SuccessCheck size={18} className="text-success" />;
  if (state === "failed") return <Icon name="x" size={16} className="text-destructive" />;
  if (state === "partial") return <Icon name="alert" size={16} className="text-warning" />;
  if (state === "unknown") return <Icon name="alert" size={16} className="text-warning" />;
  return null;
}

export default function CloseAllCard({ positions, closeOne, byCoin = null, onCancel = null, onSettled = null, fraction = 1 }) {
  const snap = usePerpMarkets();
  const markets = byCoin || snap.byCoin || {};
  const live = closeAllRows(positions, { byCoin: markets });
  const [frozen, setFrozen] = useState(null);
  const [states, setStates] = useState({});
  const [phase, setPhase] = useState("review"); // review | running | settled | cancelled
  const running = useRef(false);
  const statesRef = useRef(states);
  statesRef.current = states;

  /* Before the tap the rows follow the account; after it, the list is the one tapped (a row that closed keeps its
     last figures, one still open keeps streaming). */
  const liveBy = new Map(live.map((r) => [r.coin, r]));
  const rows = frozen ? frozen.map((r) => liveBy.get(r.coin) || r) : live;
  const sum = closeAllSummary(rows, states);
  const total = totalPnl(rows);

  const run = async (coins) => {
    /* 🔴 One run at a time; only coins from the frozen list; each at most once per run. */
    if (running.current || typeof closeOne !== "function") return;
    running.current = true;
    setPhase("running");
    await runCloseAll({ coins, closeOne, onState: (coin, o) => setStates((s) => ({ ...s, [coin]: o })) });
    running.current = false;
    setPhase("settled");
  };

  const confirm = () => {
    if (phase !== "review" || !live.length) return;
    setFrozen(live);
    run(live.map((r) => r.coin));
  };
  const retry = () => {
    if (phase !== "settled" || !sum.retry.length) return;
    run(sum.retry);
  };

  /* Every row answered: tell the caller once per settle (the chat line under the card comes from this, never prose). */
  useEffect(() => {
    if (phase !== "settled" || typeof onSettled !== "function") return;
    const s = closeAllSummary(frozen || [], statesRef.current);
    const realized = realizedOf(frozen || [], statesRef.current, fraction);
    const st = statesRef.current;
    onSettled({
      total: s.total, done: s.done, failed: s.failed, unknown: s.unknown, realized,
      text: s.text ? `${s.text}${realized != null ? ` Realized ≈ ${usdSigned(realized)}.` : ""}` : s.text,
      /* Each row as it ended, for the settled card's Details (the rows are gone once it collapses to one line). */
      rows: (frozen || []).map((r) => ({ coin: r.coin, label: r.label, pnlText: r.pnlText, pnlTone: r.pnlTone, state: (st[r.coin] && st[r.coin].state) || "idle", text: (st[r.coin] && st[r.coin].text) || null })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase === "cancelled") {
    return (
      <div className="t-swap-in flex items-center gap-2.5 px-4 py-3">
        <Icon name="x" size={16} className="text-muted-foreground" />
        <div className="text-sm font-medium">Close all cancelled. Nothing was sent.</div>
      </div>
    );
  }
  if (!rows.length) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">No open positions to close.</p>;
  }

  const busy = phase === "running";
  return (
    <div className="ff-shake px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-h2">{fraction < 1 ? `Close ${fraction === 0.5 ? "half" : `${Math.round(fraction * 100)}%`} of ${rows.length === 1 ? "your position" : "each"}` : rows.length === 1 ? "Close your position" : "Close all positions"}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{rows.length === 1 ? "1 open" : `${rows.length} open`} · market close, one by one</p>
        </div>
        {/* The open P&L before the tap; after it each row speaks for itself (a closed row's figure is its last). Its
            figure ends on the rows' own right edge: in review the rows hold no status slot (pass-2 review: 30px off). */}
        {phase === "review" ? (
          <div className="shrink-0 text-right">
            <div className="text-[11px] text-muted-foreground">Unrealized P&L</div>
            <TickNumber value={usdSigned(total)} className={`num text-sm font-medium ${TONE[total == null || Math.abs(total) < 0.005 ? "" : total > 0 ? "pos" : "neg"] || ""}`} />
          </div>
        ) : null}
      </div>

      <ul className="mt-2 border-t border-hairline" aria-label="Positions to close">
        {rows.map((r) => {
          const s = states[r.coin] || null;
          const settledRow = s && s.state !== "closing";
          return (
            <li key={r.coin} className="flex items-center gap-2.5 border-b border-hairline py-2 last:border-b-0" aria-busy={s && s.state === "closing"}>
              <CoinLogo coin={r.coin} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{r.label}</span>
                  {r.pill ? <span className={sidePill(r.side)}>{r.pill}</span> : null}
                </div>
                <div className="num mt-0.5 truncate text-[11px] text-muted-foreground">
                  {settledRow ? <span className={s.state === "failed" ? "text-destructive" : s.state === "unknown" ? "text-warning" : ""}>{s.text}</span>
                    : <>Size {r.sizeText}{r.name ? ` · ${r.name}` : ""}</>}
                </div>
              </div>
              <TickNumber value={r.pnlText} className={`num shrink-0 text-sm font-medium ${TONE[r.pnlTone] || "text-foreground"}`} />
              {phase !== "review" ? <span className="grid w-5 shrink-0 place-items-center" aria-hidden="true"><RowState s={s} /></span> : null}
            </li>
          );
        })}
      </ul>

      {sum.text ? (
        <p role="status" className={`mt-2 text-xs ${sum.failed || sum.unknown ? "text-foreground" : "text-success"}`}>
          {sum.text}
          {(() => { const v = realizedOf(rows, states, fraction); return v != null ? <span className={`num ml-1 font-medium ${v > 0.004 ? "text-success" : v < -0.004 ? "text-destructive" : "text-foreground"}`}>Realized ≈ {usdSigned(v)}</span> : null; })()}
        </p>
      ) : null}

      {phase === "review" ? (
        <div className="mt-3 grid grid-cols-[2fr_1fr] gap-2">
          <Button variant="primary" size="md" onClick={confirm} disabled={busy || typeof closeOne !== "function"}>
            <Icon name="check" size={16} />
            {closeAllLabel(rows.length, fraction)}
          </Button>
          <Button variant="outline" size="md" onClick={() => { setPhase("cancelled"); if (typeof onCancel === "function") onCancel(); }}>Cancel</Button>
        </div>
      ) : phase === "running" ? (
        <div className="mt-3">
          <Button variant="primary" size="md" className="w-full" disabled aria-busy="true">
            <IconSwap state="b" a={<Icon name="check" size={16} />} b={<Spinner size={16} />} />
            <TextSwap text={`Closing ${Math.min(sum.done + sum.failed + sum.unknown + 1, rows.length)} of ${rows.length}…`} />
          </Button>
        </div>
      ) : sum.retry.length ? (
        <div className="mt-3">
          <Button variant="outline" size="md" className="w-full" onClick={retry}>
            Try again: {rows.filter((r) => sum.retry.includes(r.coin)).map((r) => r.label).join(", ")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
