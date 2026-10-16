import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AutoHeight, CountBadge, ShimmerText, exitProps, prefersReducedMotion, readMotionMs, rise, usePresenceList } from "../ui/kit/index.ts";
import Button from "../ui/Button.jsx";
import Seg from "../ui/Seg.jsx";
import { Spinner } from "../ui/Icon.jsx";
import CoinLogo from "../ui/CoinLogo.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import EmptyState from "../ui/EmptyState.jsx";
import Tip from "../ui/Tip.jsx";
import { StatStrip, Stat } from "../ui/Stat.jsx";
import { sidePill } from "../ui/badge.js";
import { minus } from "../ui/num.js";
import { toast } from "../ui/toast.jsx";
import { useBackend } from "../perp/BackendContext.jsx";
import { useWallet } from "../context/WalletContext.jsx";
import { usePerpMarkets, formatHlPrice, formatHlSize } from "../lib/hyperliquid/index.js";
import {
  positionView, closeView, closeResultView, tradeErrorView, perpCoinLabel, CLOSE_DETENTS,
  tpslView, tpslBasisFromPosition, tpslLegView, tpslInputFor, tpslResultView,
} from "../perp/live/perpLiveView.js";
import { Leg } from "./TradeForm.jsx";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const toneClass = (t) => (t === "pos" ? "text-success" : t === "neg" ? "text-destructive" : "text-muted-foreground");
/* One grid for the desktop head and rows: Market · Size · Entry · Mark · Liq. price · Margin · P&L · actions. It needs
   ~900px, so it starts at xl: between lg and xl the market page's left column is only ~600px wide (the 8 columns
   overlapped there), and the two-line block reads better. The Market cell is the widest: it carries the name, the
   side pill and, under them, the position's TP / SL legs. On the market page from 1400px the left column is wide
   enough to give the legs their full line ("TP $2,546.4 · SL $2,250.0" is 165px of mono); narrower (and in the
   wallet's column) the figures keep their room and the legs truncate, with the full text as the title. */
const COLS = "xl:grid-cols-[minmax(0,1.7fr)_repeat(6,minmax(0,1fr))_128px]";
const COLS_WIDE = "xl:grid-cols-[minmax(0,1.7fr)_repeat(6,minmax(0,1fr))_128px] min-[1400px]:grid-cols-[minmax(0,2.2fr)_repeat(6,minmax(0,1fr))_128px]";

function timeAgo(ms) {
  if (!fin(ms)) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/* TP / SL on an open position (setTpSl). The current levels are pre-filled as ROE and PINNED, so a leg
   the user does not touch is not re-sent; a leg emptied is removed; a typed one is set. */
export function TpSlEditor({ p, market, orders, onDone, initTp = null, initSl = null, compact = false }) {
  const b = useBackend();
  const sz = market ? market.szDecimals : null;
  const basis = tpslBasisFromPosition(p, { szDecimals: sz, markPx: market ? market.markPx : null });
  const cur = tpslView(orders, p.coin, { szDecimals: sz, position: p });
  const init = (leg, px) => (fin(px) ? { str: tpslInputFor({ leg, mode: "roe", px, basis }), pin: px } : { str: "", pin: null });
  /* From the Agent: a typed level ("+25"), unpinned, so it is sent. Otherwise the position's own. */
  const [tp, setTp] = useState(() => (initTp != null ? { str: initTp, pin: null } : init("tp", cur.tp)));
  const [sl, setSl] = useState(() => (initSl != null ? { str: initSl, pin: null } : init("sl", cur.sl)));
  const [busy, setBusy] = useState(false);
  const tpView = tpslLegView({ leg: "tp", mode: "roe", str: tp.str, basis, pinPx: tp.pin });
  const slView = tpslLegView({ leg: "sl", mode: "roe", str: sl.str, basis, pinPx: sl.pin });
  const legValue = (state, view, had) => {
    if (state.pin != null) return undefined;
    if (!state.str.trim()) return fin(had) ? null : undefined;
    return view.ok ? view.px : undefined;
  };
  const tpVal = legValue(tp, tpView, cur.tp);
  const slVal = legValue(sl, slView, cur.sl);
  const bad = (!tpView.empty && !!tpView.error && tp.pin == null) || (!slView.empty && !!slView.error && sl.pin == null);
  const nothing = tpVal === undefined && slVal === undefined;

  const save = async () => {
    if (busy || bad || nothing) return;
    setBusy(true);
    let r;
    try { r = await b.setTpSl(p.coin, { tp: tpVal, sl: slVal }); } catch (e) { r = { ok: false, code: "unexpected", message: String(e?.message || e) }; }
    setBusy(false);
    if (r && r.ok) {
      const v = tpslResultView(r, { szDecimals: sz });
      toast({ title: v ? v.title : "TP / SL updated", text: v ? v.lines.join(" · ") : null, tone: v && v.warn ? "info" : "success" });
      onDone(true, v);
    } else {
      const err = tradeErrorView(r || {});
      toast({ title: err.title, text: err.text, tone: "error" });
    }
  };

  const body = (
    <>
      <Leg leg="tp" value={tp.str} onChange={(x) => setTp({ str: x, pin: null })} view={tpView} />
      <Leg leg="sl" value={sl.str} onChange={(x) => setSl({ str: x, pin: null })} view={slView} />
      <Button variant="primary" size="md" className="w-full xl:col-start-3 xl:row-start-1 xl:w-auto xl:min-w-[132px] xl:self-center" onClick={save} disabled={busy || bad || nothing}>
        {busy ? <><Spinner /> Saving…</> : nothing ? "No change" : "Save TP / SL"}
      </Button>
    </>
  );
  if (compact) return <div className="t-swap-in space-y-3">{body}</div>;
  /* In a positions row: on the row's hairline. At xl it is one line (take profit · stop loss · Save), so the row and
     its editor fit the market page's 232px positions strip together. */
  return (
    <div className="t-swap-in border-t border-hairline pb-4 pt-3">
      <div className="space-y-3 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] xl:gap-x-6 xl:space-y-0">{body}</div>
    </div>
  );
}

/** The TP / SL legs of a position, one mono line (TP in green, SL in red). */
function LegsLine({ legs, className = "" }) {
  if (!fin(legs.tp) && !fin(legs.sl)) return null;
  const all = [fin(legs.tp) ? `TP ${legs.tpText}` : null, fin(legs.sl) ? `SL ${legs.slText}` : null].filter(Boolean).join(" · ");
  return (
    <span title={all} className={`num block truncate font-mono text-[11px] text-muted-foreground ${className}`}>
      {fin(legs.tp) ? <span className="text-success">TP {legs.tpText}</span> : null}
      {fin(legs.tp) && fin(legs.sl) ? " · " : null}
      {fin(legs.sl) ? <span className="text-destructive">SL {legs.slText}</span> : null}
    </span>
  );
}

/* One position: the position card's figures (positionView) on hairline rows — an 8-column row on desktop, a two-line
   block with a stat strip on phones. Close grows a fraction picker under the row (AutoHeight); a full close lets the
   row fade out (t-exit) when the account drops it. */
function PositionRow({ p, i, market, leaving, orders, cols = COLS }) {
  const b = useBackend();
  const sz = market ? market.szDecimals : null;
  const v = positionView(p, { szDecimals: sz });
  const [open, setOpen] = useState(null); // null | "close" | "tpsl"
  const closing = open === "close";
  const setClosing = (v) => setOpen(typeof v === "function" ? (v(open === "close") ? "close" : null) : v ? "close" : null);
  const legs = tpslView(orders, p.coin, { szDecimals: sz, position: p });
  const [fraction, setFraction] = useState(1);
  const [busy, setBusy] = useState(false);
  const cv = closeView(p, fraction, { feeRate: b.feeRate, szDecimals: sz });
  const label = perpCoinLabel(p.coin, market);
  const r = rise(i);
  const tone = toneClass(v.pnlTone);
  const to = `/trade/${encodeURIComponent(p.coin)}`;
  const margin = `${v.marginText}${v.marginUnit === "usdc" ? " USDC" : ""}`;

  /* An opened Close / TP-SL panel grows under the row; once it has grown, bring it into view: in the desktop
     terminal the positions strip is 232px tall, and on phones the floating trade bar covers the bottom 88px. */
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      const el = panel.current;
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }, readMotionMs("--resize-dur", 300) + 40);
    return () => clearTimeout(t);
  }, [open]);

  const close = async () => {
    if (busy) return;
    setBusy(true);
    let res;
    try { res = await b.closeFraction(p.coin, fraction); } catch (e) { res = { ok: false, code: "unexpected", message: String(e?.message || e) }; }
    setBusy(false);
    if (res && res.ok) {
      const view = closeResultView(res, { szDecimals: sz });
      toast({ title: view ? view.title : `Closed ${label}`, text: view ? view.lines.join(" · ") : null, tone: view && view.warn ? "info" : "success" });
      setClosing(false);
    } else {
      const err = tradeErrorView(res || {});
      toast({ title: err.title, text: err.text, tone: "error" });
    }
  };

  const tpslBtn = (cls = "") => (
    <Button size="sm" variant={open === "tpsl" ? "soft" : "outline"} className={cls} onClick={() => setOpen(open === "tpsl" ? null : "tpsl")} aria-expanded={open === "tpsl"} disabled={leaving}>
      TP / SL
    </Button>
  );
  const closeBtn = (cls = "") => (
    <Button size="sm" variant={closing ? "soft" : "outline"} className={cls} onClick={() => setOpen(closing ? null : "close")} aria-expanded={closing} disabled={leaving}>
      {closing ? "Cancel" : "Close"}
    </Button>
  );

  return (
    <li className={leaving ? "" : r.className} style={leaving ? undefined : r.style} {...exitProps(leaving)}>
      <AutoHeight>
        <div className="border-b border-hairline">
          {/* desktop: one 56px row */}
          <div className={`hidden h-14 items-center gap-x-2 text-sm xl:grid ${cols}`}>
            <Link to={to} className="ff-hit flex min-w-0 items-center gap-2.5">
              <CoinLogo coin={p.coin} size={28} />
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold" title={label}>{label}</span>
                  <span className={`${sidePill(v.side)} shrink-0`}>{v.pill}</span>
                </span>
                <LegsLine legs={legs} className="mt-0.5" />
              </span>
            </Link>
            <span className="num truncate text-right">{v.qtyText}</span>
            <span className="num text-right">{v.entryText}</span>
            <TickNumber value={market ? formatHlPrice(market.px, sz) : "—"} className="num text-right" />
            <span className="num text-right text-warning">{v.liqText}</span>
            <span className="num truncate text-right">{margin}</span>
            <span className="text-right leading-tight">
              <TickNumber value={minus(v.pnlText)} className={`num block text-sm font-medium ${tone}`} />
              <span className={`num text-xs ${tone}`}>{minus(v.roeText)}</span>
            </span>
            <span className="flex justify-end gap-1.5">{tpslBtn()}{closeBtn()}</span>
          </div>

          {/* phone: name + P&L, a stat strip, then two 44px actions */}
          <div className="py-4 xl:hidden">
            <div className="flex items-start justify-between gap-3">
              <Link to={to} className="ff-hit flex min-w-0 items-center gap-2.5">
                <CoinLogo coin={p.coin} size={32} />
                <span className="truncate text-[15px] font-semibold">{label}</span>
                <span className={sidePill(v.side)}>{v.pill}</span>
              </Link>
              <span className="shrink-0 text-right">
                <TickNumber value={minus(v.pnlText)} className={`num block text-[15px] font-medium leading-tight ${tone}`} />
                <span className={`num mt-1 block text-xs ${tone}`}>{minus(v.roeText)}</span>
              </span>
            </div>
            <StatStrip className="mt-3">
              <Stat label="Size">{v.qtyText}</Stat>
              <Stat label="Entry">{v.entryText}</Stat>
              <Stat label="Liq. price" valueClassName="!text-warning">{v.liqText}</Stat>
            </StatStrip>
            <LegsLine legs={legs} className="mt-2" />
            <div className="mt-3 grid grid-cols-2 gap-2">{tpslBtn()}{closeBtn()}</div>
          </div>

          <div ref={panel} className="scroll-mb-[calc(96px+env(safe-area-inset-bottom))] scroll-mt-12 lg:scroll-mb-2">
          {closing ? (
            <div className="t-swap-in border-t border-hairline pb-4 pt-3">
              <div className="space-y-3 xl:ml-auto xl:grid xl:max-w-[600px] xl:grid-cols-2 xl:gap-x-6 xl:gap-y-3 xl:space-y-0">
                <Seg
                  label="How much to close"
                  full
                  size="sm"
                  value={fraction}
                  onChange={setFraction}
                  className="xl:col-start-1 xl:row-start-1"
                  items={CLOSE_DETENTS.map((f) => ({ value: f, label: f === 1 ? "All" : `${Math.round(f * 100)}%` }))}
                />
                <div className="num grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-center">
                  <span className="text-muted-foreground">Closing</span><span className="text-right font-medium">{cv.qtyText}</span>
                  <span className="text-muted-foreground">You get back</span><span className="text-right font-medium">{cv.valueText} USDC</span>
                  <span className="text-muted-foreground">P&amp;L</span><span className={`text-right font-medium ${toneClass(cv.pnlTone)}`}>{minus(cv.pnlText)}</span>
                  <span className="text-muted-foreground">Fee</span><span className="text-right font-medium">{cv.feeText}</span>
                </div>
                <Button variant="primary" size="md" className="w-full xl:col-start-1 xl:row-start-2" onClick={close} disabled={busy}>
                  {busy ? <><Spinner /> <ShimmerText text="Closing…" className="!text-background" /></> : `Close ${fraction === 1 ? "all" : cv.pctText} of ${label}`}
                </Button>
              </div>
            </div>
          ) : null}
          {open === "tpsl" ? <TpSlEditor p={p} market={market} orders={orders} onDone={() => setOpen(null)} /> : null}
          </div>
        </div>
      </AutoHeight>
    </li>
  );
}

/** An empty state's one line, with the why folded into a Tip (USER-REQUESTS D1: no explanatory sentence printed). */
function EmptyLine({ text, tip }) {
  return (
    <span className="inline-flex items-center gap-2">
      {text}
      <span className="font-normal"><Tip align="start">{tip}</Tip></span>
    </span>
  );
}

/** Two skeleton rows in the final row geometry (56px, a hairline, a circle and two bars). */
function RowsSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1].map((k) => (
        <div key={k} className="flex h-14 items-center gap-3 border-b border-hairline">
          <span className="skeleton-shimmer size-7 shrink-0 rounded-full" />
          <span className="skeleton-shimmer h-3.5 w-24 rounded" />
          <span className="skeleton-shimmer ml-auto h-3.5 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}

function OrdersList({ orders, markets }) {
  const list = orders && orders.answered ? orders.list || [] : null;
  if (!list) return <RowsSkeleton />;
  if (!list.length) return <EmptyState title={<EmptyLine text="No open orders" tip="TP, SL and limit orders show up here." />} />;
  return (
    <ul>
      {list.map((o, i) => {
        const m = markets[o.coin];
        const r = rise(i);
        const kind = o.tpsl === "tp" ? "Take profit" : o.tpsl === "sl" ? "Stop loss" : o.orderType || "Limit";
        return (
          <li key={o.oid != null ? o.oid : `${o.coin}-${o.tpsl || o.orderType || "order"}-${i}`} className={`${r.className} grid h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline text-sm`} style={r.style}>
            <span className="flex min-w-0 items-center gap-2.5">
              <CoinLogo coin={o.coin} size={22} />
              <span className="truncate">
                <span className="font-medium">{perpCoinLabel(o.coin, m)}</span>
                <span className="text-muted-foreground"> · </span>
                <span className={o.tpsl === "tp" ? "text-success" : o.tpsl === "sl" ? "text-destructive" : ""}>{kind}</span>
              </span>
            </span>
            <span className="num text-right text-xs text-muted-foreground">
              {o.side === "buy" ? "Buy" : "Sell"} {fin(o.sz) && o.sz > 0 ? formatHlSize(o.sz, m ? m.szDecimals : null) : "all"} @ <span className="font-medium text-foreground">{formatHlPrice(o.isTrigger ? o.triggerPx : o.limitPx, m ? m.szDecimals : null)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function HistoryList({ fills, markets }) {
  const list = fills && fills.answered ? (fills.list || []).slice(0, 30) : null;
  if (!list) return <RowsSkeleton />;
  if (!list.length) return <EmptyState title={<EmptyLine text="No trades yet" tip="Your fills show up here." />} />;
  return (
    <ul>
      {list.map((f, i) => {
        const m = markets[f.coin];
        const r = rise(i);
        return (
          <li key={f.tid} className={`${r.className} grid h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline text-sm`} style={r.style}>
            <span className="flex min-w-0 items-center gap-2.5">
              <CoinLogo coin={f.coin} size={22} />
              <span className="truncate font-medium">{f.dir || (f.side === "buy" ? "Buy" : "Sell")} {perpCoinLabel(f.coin, m)}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{timeAgo(f.time)}</span>
            </span>
            <span className="num text-right text-xs">
              <span className="text-muted-foreground">{formatHlSize(f.sz, m ? m.szDecimals : null)} @ {formatHlPrice(f.px, m ? m.szDecimals : null)}</span>
              {fin(f.closedPnl) && f.closedPnl !== 0 ? <span className={`ml-2 font-medium ${f.closedPnl > 0 ? "text-success" : "text-destructive"}`}>{f.closedPnl > 0 ? "+" : "−"}${Math.abs(f.closedPnl).toFixed(2)}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The account's activity: Positions / Orders / History.
 *
 * Optional, for a page that hosts more than the trades (the Wallet, owner 2026-10-15: "Position | Order | History |
 * Spot", "เอา On its way ไปอยู่ใน History"). With none of them, the panel is exactly as before:
 *   extraTabs    [{ value, label, count?, render() }] appended after History; render() draws that tab's body
 *   historyLead  a node drawn above the fills in History (e.g. what is on its way)
 *   tab / onTab  control the open tab; without `tab` the panel keeps its own (uncontrolled)
 */
export default function PositionsPanel({ coin = null, extraTabs = null, historyLead = null, tab: tabProp = null, onTab = null }) {
  const b = useBackend();
  const w = useWallet();
  const snap = usePerpMarkets();
  const [tabOwn, setTabOwn] = useState("positions");
  const extra = Array.isArray(extraTabs) ? extraTabs.filter((t) => t && typeof t.value === "string" && typeof t.render === "function") : [];
  const tab = tabProp != null ? tabProp : tabOwn;
  const setTab = (t) => {
    if (tabProp == null) setTabOwn(t);
    if (typeof onTab === "function") onTab(t);
  };
  const extraTab = extra.find((t) => t.value === tab) || null;
  const account = b.account || {};
  const all = account.positions && account.positions.answered ? account.positions.list || [] : null;
  const positions = useMemo(() => (all || []).filter((p) => p && fin(p.szi) && p.szi !== 0), [all]);
  const entries = usePresenceList(positions, (p) => p.coin);
  const count = positions.length;
  const inset = coin ? "px-gutter lg:px-6" : "";
  const cols = coin ? COLS_WIDE : COLS;

  let body;
  if (extraTab) {
    /* A host's own tab draws its own body (it is not about the trades, so it needs no sign-in branch here). */
    body = extraTab.render();
  } else if (!b.connected) {
    /* While a session is arriving (useWallet().pending), the rows' shape, not a "Sign in" line. */
    body = w.pending ? <RowsSkeleton /> : <EmptyState title="Sign in to see your positions." />;
  } else if (tab === "positions") {
    if (all == null) body = <RowsSkeleton />;
    else if (!entries.length) {
      body = (
        <EmptyState
          title={<EmptyLine text="No open positions" tip="Positions show up here once an order fills." />}
          action={coin ? null : (
            <Link to="/home" className="ff-press -ml-1 inline-flex h-11 items-center px-1 text-sm font-medium text-foreground underline-offset-4 hover:underline lg:h-8 lg:text-xs">
              Browse markets <span aria-hidden="true">&nbsp;→</span>
            </Link>
          )}
        />
      );
    } else body = (
      <>
        <div className={`hidden h-10 items-center gap-x-2 border-b border-hairline text-label text-muted-foreground xl:grid ${cols}`}>
          <span>Market</span>
          <span className="text-right">Size</span>
          <span className="text-right">Entry</span>
          <span className="text-right">Mark</span>
          <span className="text-right">Liq. price</span>
          <span className="text-right">Margin</span>
          <span className="text-right">P&amp;L</span>
          <span />
        </div>
        <ul>
          {entries.map((e, i) => <PositionRow key={e.key} p={e.item} i={i} leaving={e.leaving} market={snap.byCoin[e.item.coin]} orders={account.orders} cols={cols} />)}
        </ul>
      </>
    );
  } else if (tab === "orders") {
    body = <OrdersList orders={account.orders} markets={snap.byCoin} />;
  } else {
    body = historyLead
      ? <>{historyLead}<HistoryList fills={account.fills} markets={snap.byCoin} /></>
      : <HistoryList fills={account.fills} markets={snap.byCoin} />;
  }

  return (
    <section className="bg-background">
      {/* The tab row sticks under the app header (56px + its 1px rule) wherever the window scrolls: the wallet, and the
          coin page from md to lg. Phones hide the header on a coin page, and from lg the strip scrolls on its own. */}
      <div className={`sticky z-10 flex items-center border-b border-border bg-background ${coin ? "top-0 md:top-[57px] lg:top-0" : "top-[57px]"} ${inset}`}>
        <Seg
          variant="line"
          label="Account"
          value={tab}
          onChange={setTab}
          className="-ml-2.5 [--line-bottom:-1px]"
          items={[
            {
              value: "positions",
              label: (
                <span className="inline-flex items-center gap-1.5 [&>.t-badge[data-open=false]]:absolute">
                  Positions
                  <CountBadge open={count > 0} inline label={`${count} open`} className="font-mono text-[11px] font-normal text-muted-foreground">{count}</CountBadge>
                </span>
              ),
            },
            { value: "orders", label: "Orders" },
            { value: "history", label: "History" },
            ...extra.map((t) => ({ value: t.value, label: t.label, ...(t.count != null ? { count: t.count } : {}) })),
          ]}
        />
      </div>
      <AutoHeight><div key={tab} className={`t-tab-panel ${inset}`}>{body}</div></AutoHeight>
    </section>
  );
}
