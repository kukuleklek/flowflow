/* The final pre-trade popup (item 17; owner: "อยากให้มี Popup ก่อนเปิด เป็นหน้าตากราฟ TP SL เส้นอยู่บนกราฟเลย ในหน้า A.I อะ
   ฟีล Final ก่อนเปิดจริง แล้วพอเปิดเสด มีเลขกำไร Live ตัวโตๆ เหมือนเดิม"). A desktop modal (kit .t-modal) and a phone
   bottom sheet (.ff-sheet), both over a fading scrim: the market's own chart (PriceChart, 1h) with the ENTRY, TP
   (green), SL (red) and LIQ (amber) lines drawn on it, a legend with each level's price, % and $ at TP / $ at SL,
   a header with side · leverage · margin · RR · fee, the US market's state for a stock, Edit (type TP / SL), Cancel,
   and ONE "Open Long / Open Short" button.

   🔴 THIS IS THE ONLY PLACE AN AGENT ORDER IS SENT FROM, AND IT SENDS AT MOST ONCE PER TAP:
     - the button calls the injected onOpen() — the caller's own send (useOrderQuote's quote, re-checked fresh by the
       caller at that moment); this file holds no backend and builds no order
     - a ref latches on the first call, so a double tap, Enter held down or a re-render can never call it twice
     - while it runs, the button, Edit, Cancel, Escape and the scrim are all inert
     - an answer whose outcome is not known (a lost reply, a throw) LOCKS the button: the person checks their positions
       first; only a clean refusal ("nothing was sent") lets them tap again
     - it never sends by itself: no auto-confirm, no timer, no focus on the button (Enter on open cannot send)
   After a fill the caller closes the sheet and the existing PositionHero (the big live P&L) shows, as before.

   Props:
     open, onClose          shown / asked to close (Escape, scrim, ×, Cancel); ignored while sending
     plan                   { coin, side "buy"|"sell", leverage, marginUsdc, entryPx, tpPx?, slPx?, liqPx?, notionalUsd?,
                              feeUsdc?, feeRate?, szDecimals?, rr?, notes?: string[], mathLines?: string[] }
     market                 the live market row (size decimals, the ticker, the reference price), optional
     onOpen                 async () => { ok: true } | { ok: false, message?, next?, unknown? } — the caller's send
     onEdit                 ({ tpPx, slPx }) => void — the caller re-prices and re-checks the caps, then hands a new plan
                            (omitted: no Edit)
     stale                  the caller's quote is not fresh: the button waits ("Waiting for a fresh price")
     now                    the clock for the US market's state (defaults to now, ticking each minute) */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconSwap, TextSwap, SuccessCheck } from "../../ui/kit/index.ts";
import Button, { IconButton } from "../../ui/Button.jsx";
import Icon, { Spinner } from "../../ui/Icon.jsx";
import CoinLogo from "../../ui/CoinLogo.jsx";
import Tip from "../../ui/Tip.jsx";
import { sidePill } from "../../ui/badge.js";
import PriceChart from "../../trade/PriceChart.jsx";
import { finalTradeView, checkTpSlEdit, createOpenLatch } from "./finalTradeView.js";

const CLOSE_MS = 250;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const TONE = { pos: "text-success", neg: "text-destructive", warn: "text-warning", ink: "text-foreground" };
const SWATCH = { tp: "border-success", sl: "border-destructive", liq: "border-warning", entry: "border-foreground" };
const DOT = { pos: "bg-success", warn: "bg-warning", muted: "bg-muted-foreground" };
/* The ONE button that sends, on a short: solid red like a long's solid lime (pass-2 review: the 12% tint read as the
   disabled "Filled" state). */
const SHORT_SOLID = "!bg-destructive !text-white hover:!bg-destructive/90";

/* Desktop (a modal) from md up; below it a phone sheet. Follows the window as it resizes. */
function useWide(query = "(min-width: 768px)") {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

/* The clock, a minute at a time: enough for "opens in 5h 20m". */
function useMinuteClock(given) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (given != null) return undefined;
    const id = setInterval(() => setT(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [given]);
  return given ?? t;
}

function Stat({ label, children, tone = "" }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`num mt-0.5 truncate text-sm font-medium ${tone}`}>{children}</div>
    </div>
  );
}

function Legend({ rows, feesIn }) {
  return (
    <ul className="divide-y divide-hairline text-[13px]" aria-label="Levels">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-2.5 py-1.5">
          {/* The line's own colour and dash, as drawn on the chart. */}
          <span aria-hidden="true" className={`w-3.5 shrink-0 border-t-2 ${r.id === "liq" ? "border-dotted" : "border-dashed"} ${SWATCH[r.id] || "border-muted-foreground"}`} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.label}</span>
          <span className={`num shrink-0 font-medium ${TONE[r.tone] || ""}`}>{r.priceText}</span>
          <span className="num w-[58px] shrink-0 text-right text-xs text-muted-foreground">{r.pctText}</span>
          <span className={`num w-[64px] shrink-0 text-right text-xs font-medium ${r.usdText && r.usdText !== "—" ? TONE[r.tone] || "" : "text-muted-foreground"}`}>{r.usdText}</span>
        </li>
      ))}
      <li className="flex items-center justify-end gap-1 pt-1.5 text-[11px] text-muted-foreground">
        <Tip label={feesIn ? "$ after fees" : "$ before fees"} align="end">
          What the position would show closed at that level: its size times the move from the entry
          {feesIn ? ", less the fee to open and the fee to close" : ""}. An estimate: the fill price can differ a little.
        </Tip>
      </li>
    </ul>
  );
}

function EditLegs({ v, plan, onApply, onCancel }) {
  const [tp, setTp] = useState(v.tpInput);
  const [sl, setSl] = useState(v.slInput);
  const [errors, setErrors] = useState({});
  const tpId = useId();
  const slId = useId();
  const apply = (e) => {
    e.preventDefault();
    const c = checkTpSlEdit({ side: plan.side, entryPx: plan.entryPx, liqPx: plan.liqPx, tpStr: tp, slStr: sl });
    setErrors(c.errors);
    if (c.ok) onApply({ tpPx: c.tpPx, slPx: c.slPx });
  };
  const field = "num h-10 w-full rounded-lg bg-card px-3 text-sm outline-none ring-1 ring-inset ring-input transition-shadow focus:shadow-halo focus:ring-ring";
  return (
    <form onSubmit={apply} className="t-swap-in mt-2 rounded-xl bg-muted/50 p-3" noValidate>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label htmlFor={tpId} className="text-[11px] font-medium text-success">Take profit</label>
          <input id={tpId} inputMode="decimal" autoComplete="off" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="None" className={`${field} mt-1`} aria-invalid={!!errors.tp} />
          {errors.tp ? <p className="mt-1 text-[11px] text-destructive">{errors.tp}</p> : null}
        </div>
        <div>
          <label htmlFor={slId} className="text-[11px] font-medium text-destructive">Stop loss</label>
          <input id={slId} inputMode="decimal" autoComplete="off" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="None" className={`${field} mt-1`} aria-invalid={!!errors.sl} />
          {errors.sl ? <p className="mt-1 text-[11px] text-destructive">{errors.sl}</p> : null}
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">Prices. Empty = none. Limits are checked again.</span>
        <span className="flex shrink-0 gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel}>Back</Button>
          <Button variant="outline" size="sm" type="submit">Apply</Button>
        </span>
      </div>
    </form>
  );
}

/** The sheet's body: header, figures, chart, legend, edit, notes and the one Open button. */
function Body({ v, plan, market, titleId, onClose, onOpen, onEdit, stale, phase, error, wide }) {
  const [editing, setEditing] = useState(false);
  const busy = phase !== "review";
  /* PriceChart redraws its lines whenever the array changes: one array per set of levels. */
  const linesKey = JSON.stringify(v.lines.map((l) => [l.id, l.price, l.title]));
  const lines = useMemo(() => v.lines, [linesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const refPx = market && Number.isFinite(market.px) ? market.px : plan.entryPx;
  /* While TP / SL are being edited the button waits: what it would send must be what the sheet shows. */
  const canOpen = v.ok && !stale && !editing && phase === "review" && typeof onOpen === "function";
  const label = phase === "sending" ? "Placing…" : phase === "done" ? "Filled" : phase === "locked" ? "Check your positions" : stale ? "Waiting for a fresh price" : v.openLabel;
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <CoinLogo coin={v.coin} size={28} />
            <h2 id={titleId} className="truncate text-h2">{v.pair}</h2>
            <span className={sidePill(v.buy ? "long" : "short")}>{v.pill}</span>
          </div>
          {v.isStock ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {v.name ? <span>{v.name}</span> : null}
              {v.market ? (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[v.market.tone] || DOT.muted}`} />
                  <span className="text-foreground">{v.market.label}</span>
                  {v.market.sub ? <span>· {v.market.sub}</span> : null}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <IconButton label="Close" onClick={onClose} disabled={phase === "sending"} className="-mr-2 -mt-1">
          <Icon name="x" size={18} />
        </IconButton>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl bg-muted/50 px-3.5 py-2.5 sm:grid-cols-4">
        <Stat label="Margin">{v.marginText}</Stat>
        <Stat label="Size">{v.sizeText}</Stat>
        <Stat label="Reward to risk">{v.rrText}</Stat>
        <Stat label="Fee">{v.feeText}</Stat>
      </div>
      {v.mathLines.length ? (
        <div className="mt-2 space-y-0.5 text-[12px] leading-[1.5] tabular-nums text-muted-foreground">
          {v.mathLines.map((l) => <p key={l}>{l}</p>)}
        </div>
      ) : null}

      {/* The market page's own chart and price-line code. Its fullscreen control is hidden here: a fixed layer inside a
          transformed modal would fill the modal, and its Escape would close both. */}
      <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-inset ring-border [&_button[aria-label=Fullscreen]]:hidden">
        <PriceChart coin={v.coin} szDecimals={market ? market.szDecimals : plan.szDecimals ?? null} refPx={refPx} lines={lines} height={wide ? 280 : 220} fitLines />
      </div>

      <div className="mt-2">
        <Legend rows={v.legend} feesIn={v.feesIn} />
      </div>

      {typeof onEdit === "function" ? (
        editing ? (
          <EditLegs v={v} plan={plan} onCancel={() => setEditing(false)} onApply={(legs) => { setEditing(false); onEdit(legs); }} />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className="ff-press ff-hit -ml-1 mt-1 inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45"
          >
            <Icon name="chart" size={14} />Edit TP / SL
          </button>
        )
      ) : null}

      {v.notes.length || (v.market && v.market.note) || error ? (
        <div className="mt-2.5 space-y-1 text-xs">
          {/* 🔴 Money warnings stay printed (Tip.jsx): the stock's closed-market gap risk is one. */}
          {v.market && v.market.note ? <p className={v.market.state === "closed" ? "text-warning" : "text-muted-foreground"}>{v.market.note}</p> : null}
          {/* A caller's note that repeats the market line above (the same guard words) is said once. */}
          {v.notes.filter((n) => !(v.market && n === v.market.note)).map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>
      ) : null}

      <div className="mt-3.5 grid grid-cols-[2fr_1fr] gap-2">
        <Button
          variant={v.buy ? "brand" : "short"}
          size="lg"
          className={v.buy ? "" : SHORT_SOLID}
          onClick={onOpen}
          disabled={!canOpen}
          aria-busy={phase === "sending"}
          aria-label={phase === "review" && !stale ? `${v.openLabel} ${v.label} ${v.pill.replace(/ .*/, "")}, margin ${v.marginText}` : undefined}
        >
          <IconSwap
            state={phase === "sending" ? "b" : phase === "done" ? "c" : "a"}
            a={<Icon name={phase === "locked" ? "alert" : v.buy ? "arrowUp" : "arrowDown"} size={16} />}
            b={<Spinner size={16} />}
            c={<SuccessCheck size={16} />}
          />
          <TextSwap text={label} />
        </Button>
        <Button variant="outline" size="lg" onClick={onClose} disabled={phase === "sending"}>{phase === "done" ? "Close" : "Cancel"}</Button>
      </div>
    </>
  );
}

export default function FinalTradeSheet({ open, onClose, plan, market = null, onOpen, onEdit = null, stale = false, now = null }) {
  const wide = useWide();
  const clock = useMinuteClock(now);
  const v = finalTradeView(plan, { now: clock, market });
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState("review"); // review | sending | done | locked
  const [error, setError] = useState(null);
  /* The send latch (finalTradeView.js createOpenLatch): it calls the NEWEST onOpen, once per tap at most. */
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const latch = useRef(null);
  if (!latch.current) latch.current = createOpenLatch(() => onOpenRef.current());
  const panel = useRef(null);
  const back = useRef(null);
  const titleId = useId();
  /* Only an order on its way holds the sheet open; after a fill or a lock the person may close it. */
  const busy = phase === "sending";

  /* A new plan (Edit applied, a re-price) after a clean refusal starts fresh; a lock and a fill are kept. */
  const planKey = JSON.stringify(plan ? [plan.coin, plan.side, plan.leverage, plan.marginUsdc, plan.tpPx, plan.slPx] : null);
  useEffect(() => {
    if (phase === "review") setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  /* Each opening is a new review: the latch, the phase and the words reset. */
  useEffect(() => {
    if (open) {
      latch.current.reset();
      /* 🔴 A locked latch (outcome unknown) stays locked across a re-open of this same sheet. */
      const locked = latch.current.state === "locked";
      setPhase(locked ? "locked" : "review");
      setError(locked ? "Not confirmed. Check your positions before trying again." : null);
      setRender(true);
      return undefined;
    }
    setShown(false);
    const t = setTimeout(() => setRender(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  /* Enter after a forced reflow (a background tab delivers no animation frame: Sheet.jsx's rule). */
  useEffect(() => {
    if (!render || !open) return;
    if (panel.current) void panel.current.offsetWidth;
    setShown(true);
  }, [render, open]);

  const close = () => { if (!busy) onClose?.(); };

  /* Focus: into the panel itself on open (never onto the Open button: Enter must not send), held inside while open
     (Tab wraps), back to where it was on close. Escape closes unless an order is on its way. The page under it
     does not scroll. */
  useEffect(() => {
    if (!open || !render) return undefined;
    back.current = typeof document !== "undefined" ? document.activeElement : null;
    const el = panel.current;
    if (el) el.focus({ preventScroll: true });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      const b = back.current;
      if (b && typeof b.focus === "function" && document.contains(b)) b.focus({ preventScroll: true });
    };
  }, [open, render]);

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab" || !panel.current) return;
    const els = [...panel.current.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!els.length) { e.preventDefault(); return; }
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const openNow = async () => {
    /* 🔴 One call per review, whatever the clicks: the latch ignores every fire() but the first until it answers. */
    if (latch.current.state !== "idle" || phase !== "review" || stale || !v.ok || typeof onOpen !== "function") return;
    setPhase("sending");
    setError(null);
    const o = await latch.current.fire();
    if (o.state === "ignored") return;
    if (o.state === "ok") { setPhase("done"); return; }
    setError(o.text);
    /* locked: the outcome is unknown, never a second send from here. retry: nothing was sent, a new tap may try. */
    setPhase(o.state === "locked" ? "locked" : "review");
  };

  if (!render || !plan) return null;
  const body = (
    <Body v={v} plan={plan} market={market} titleId={titleId} onClose={close} onOpen={openNow} onEdit={onEdit} stale={stale} phase={phase} error={error} wide={wide} />
  );
  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className={`ff-scrim absolute inset-0 bg-foreground/25 ${shown ? "is-open" : ""}`} onClick={close} aria-hidden="true" />
      {wide ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
          <div
            ref={panel}
            tabIndex={-1}
            className={`t-modal pointer-events-auto relative max-h-[calc(100dvh-48px)] w-full max-w-[640px] overflow-y-auto rounded-2xl bg-card p-5 shadow-float ring-1 ring-border outline-none focus-visible:outline-none ${shown ? "is-open" : open ? "" : "is-closing"}`}
          >
            {body}
          </div>
        </div>
      ) : (
        <div
          ref={panel}
          tabIndex={-1}
          className={`ff-sheet absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-2xl bg-card px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2 shadow-float outline-none focus-visible:outline-none ${shown ? "is-open" : ""}`}
        >
          <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-input" aria-hidden="true" />
          {body}
        </div>
      )}
    </div>
  );
}
