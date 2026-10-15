import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { AutoHeight, ShimmerText } from "../ui/kit/index.ts";
import Button, { IconButton } from "../ui/Button.jsx";
import EmptyState from "../ui/EmptyState.jsx";
import Icon, { GoogleMark, Spinner } from "../ui/Icon.jsx";
import { MoneyHero } from "../ui/Money.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import { Stat, StatStrip } from "../ui/Stat.jsx";
import LiveDot from "../ui/LiveDot.jsx";
import Tip from "../ui/Tip.jsx";
import ConnectCard from "../auth/ConnectCard.jsx";
import { shortAddress } from "../auth/AccountButton.jsx";
import { useWallet } from "../hooks/useWallet.js";
import { usePortfolio } from "../hooks/usePortfolio.js";
import { useBackend } from "../perp/BackendContext.jsx";
import { balanceView } from "../perp/live/perpLiveView.js";
import PositionsPanel from "../trade/PositionsPanel.jsx";
import DepositPanel from "./DepositPanel.jsx";
import WithdrawPanel from "./WithdrawPanel.jsx";
import { TotalState, InFlightList, InFlightLine, ImgDisc, TokenDisc } from "./TotalBalance.jsx";
import { holdingsRows } from "./portfolio.js";
import { SpotActions, SpotPanelHost, spotPanelKind } from "./avax/SpotActions.jsx";
import { customerWords } from "./words.js";

/* The Wallet, lean (owner, 2026-10-15, on the prod wallet: "ต้องการหน้าแบบ ลีนๆแบบนี้" — "ลีนแบบรวมกันไปเลย"): the home's
   360 | 1px | 1fr split at xl, one centred 760 column below it.

     index column (sticky at xl)   the account row; ONE balance, the whole of it (the Main Account and the Spot Account
                                   added up; wallet/portfolio.js); Available | In positions; Deposit and Withdraw →
                                   (Assets is ONE list of what the customer holds, owner: "BTCb ถ้ากดซื้อเข้า ไปบน
                                   Balance เลย … อยู่ด้วยกันไปเลย": USDC as one row, the staked USDC, every coin held,
                                   never by account or chain)
     fluid column                  an open panel (at xl), then ONE tab row: Positions | Orders | History | Spot
                                   (owner: "Position | Order | History | Spot … เอา On its way ไปอยู่ใน History … Swap
                                   Move IN, Move Out, Stake, Unstake ย้ายไปใน Spot", "เน้นคลีนๆโล่งๆ"): History opens
                                   with what is on its way, Spot holds the Spot moves and the assets

   Below xl the balance band swaps for the open panel in place (the motion kit's morph), exactly as before. Nothing at the
   bottom (owner: "ข้างล่างไม่ต้องมี Power by อะไรเลย เอาแบบโล่งๆ"). Unknown is "—" and the figure says Partial. */

const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

const XL = "(min-width: 1280px)";

/* The page root (USER-REQUESTS B2: t-enter, the sections are its direct children). Below xl one centred 760 column;
   at xl the home's 360 | 1px | 1fr grid, at least one screen tall, so the vertical rule runs from the header rule to
   the bottom of the page even when the page is short. */
const ROOT = "t-enter mx-auto w-full max-w-[760px] px-gutter md:pt-4 xl:-mb-16 xl:grid xl:min-h-[calc(100dvh-var(--header-h)-1px)] xl:max-w-content xl:grid-cols-[360px_1px_minmax(0,1fr)] xl:grid-rows-[auto_1fr] xl:gap-x-10 xl:pt-0";

function useMediaQuery(q) {
  const [on, setOn] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(q);
    const f = () => setOn(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [q]);
  return on;
}

/** `?panel=` drives which panel is open. Unchanged: replace, never push. */
function usePanel() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("panel");
  /* Deposit / Withdraw, or a Spot panel (Move in, Move out, Stake, Unstake, Swap: avax/SpotActions.jsx; null unless
     the build says VITE_EARN=on). */
  const panel = raw === "deposit" || raw === "withdraw" ? raw : spotPanelKind(typeof raw === "string" ? raw.replace(/^move(in|out)$/, "move-$1") : raw);
  const go = (p) => {
    const next = new URLSearchParams(params);
    next.delete("amount");
    if (p) next.set("panel", p); else next.delete("panel");
    setParams(next, { replace: true });
  };
  return [panel, go];
}

/* The account's identity row: 64px, the same height as an open panel's header beside it at xl, so the two rules run
   as one line across the vertical rule. */
function AccountRow() {
  const w = useWallet();
  const b = useBackend();
  if (b.mock) {
    return (
      <div className="flex h-16 items-center gap-3 border-b border-border">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted"><Icon name="wallet" size={16} /></span>
        <span className="text-sm font-medium">Mock account</span>
        <Tip align="start" title="About the mock account">Mock account on live prices. No real order is sent.</Tip>
      </div>
    );
  }
  const key = b.trading || {};
  const hrs = key.keyActive && Number.isFinite(key.validUntil) ? Math.max(0, Math.round((key.validUntil - Date.now()) / 3_600_000)) : null;
  const status = key.keyActive ? `Trading on${hrs != null ? ` · ${hrs}h` : ""}` : "Trading off";
  return (
    <div className="flex h-16 items-center justify-between gap-3 border-b border-border">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
          {w.user?.method === "google" ? <GoogleMark size={16} /> : <Icon name={w.user?.method === "email" ? "mail" : "wallet"} size={16} />}
        </span>
        <div className="min-w-0">
          <div className="font-mono text-sm">{shortAddress(w.address)}</div>
          <div className="truncate text-xs text-muted-foreground">{w.user?.label || "Embedded wallet"}</div>
        </div>
      </div>
      <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-[11px] font-medium ${key.keyActive ? "text-foreground" : "text-muted-foreground"}`}>
        {key.keyActive ? <LiveDot /> : null}
        {status}
        {!key.keyActive && key.auto ? <Tip align="end" title="When trading turns on" className="-mr-1 font-normal">Trading turns on with your first order.</Tip> : null}
      </span>
    </div>
  );
}

/* Available | In positions, as the owner's prod wallet has it. */
function Where({ v, pb }) {
  const m = v.perp || {};
  return (
    <StatStrip className="mt-5">
      <Stat label="Available"><TickNumber value={fmt(pb ? pb.availableUsdc : null)} /></Stat>
      <Stat label="In positions"><TickNumber value={fmt(m.inPositionsUsd)} /></Stat>
    </StatStrip>
  );
}

/* What the customer holds, one row per asset (wallet/portfolio.js holdingsRows): the rows add up to the balance. In
   the wide column a row is a table row (asset · amount · value, the positions table's grammar); on phones the value
   and the amount stack on the right. */
const ASSET_COLS = "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]";

function AssetValue({ r }) {
  if (r.status === "loading") return <span className="skeleton-shimmer inline-block h-3.5 w-16 rounded" />;
  if (r.usd == null && r.usdText !== "No price") return <span className="num text-sm text-muted-foreground">—</span>;
  return <TickNumber value={r.usdText} className="num text-sm font-medium" />;
}

function AssetRow({ r }) {
  return (
    <li className={`grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-hairline py-2 lg:h-14 lg:py-0 ${ASSET_COLS}`}>
      <span className="flex min-w-0 items-center gap-3">
        {r.chain ? <TokenDisc token="USDC" chain={r.chain} size={30} /> : <ImgDisc src={r.logo} label={r.symbol} size={30} />}
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{r.symbol}</span>
            {r.gas ? <span className="inline-flex h-[18px] items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">Gas</span> : null}
            {r.tip ? <Tip align="start" title={`About ${r.symbol}`}>{r.tip}</Tip> : null}
          </span>
          <span className={`block truncate text-xs ${r.earning ? "text-success" : "text-muted-foreground"}`}>{r.sub || r.name}</span>
        </span>
      </span>
      {/* Phones: value over amount on the right. */}
      <span className="text-right lg:hidden">
        <span className="block"><AssetValue r={r} /></span>
        {r.amountText ? <span className="num block text-xs text-muted-foreground">{r.amountText}</span> : null}
        {r.status === "partial" && !r.amountText ? <span className="block text-[11px] text-muted-foreground">Partial</span> : null}
      </span>
      {/* lg: amount and value in their own columns. */}
      <span className="num hidden text-right text-sm text-muted-foreground lg:block">{r.amountText || ""}</span>
      <span className="hidden text-right lg:block">
        <AssetValue r={r} />
        {r.status === "partial" ? <span className="block text-[11px] text-muted-foreground">Partial</span> : null}
      </span>
    </li>
  );
}

/* ── The wide column as tabs (owner, 2026-10-15: "Position | Order | History | Spot", "เอา On its way ไปอยู่ใน History",
   "Swap Move IN, Move Out, Stake, Unstake ย้ายไปใน Spot ด้วย", "ย้าย Asset ไปอยู่ในแถบ … มันจะได้คลีน"). PositionsPanel
   draws the tab row; these are the Wallet's own bodies for it. ─────────────────────────────────────────────────── */

/** The Asset · Amount · Value table, no title of its own (the tab is its title). */
function AssetsTable({ v, className = "" }) {
  const rows = holdingsRows(v);
  if (!rows.length) return null;
  return (
    <section className={className} aria-label="Assets">
      <div className={`hidden h-10 items-center gap-x-4 border-b border-hairline text-label text-muted-foreground lg:grid ${ASSET_COLS}`}>
        <span>Asset</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Value</span>
      </div>
      <ul>{rows.map((r) => <AssetRow key={r.key} r={r} />)}</ul>
    </section>
  );
}

/** The Spot tab: the Spot moves (Swap · Move in · Move out · Stake · Unstake; locked until the live test), then what
 *  the customer holds. */
function SpotTab({ v, panel, go, toggles }) {
  return (
    <div className="pt-4">
      <SpotActions v={v} panel={panel} go={go} toggles={toggles} />
      <AssetsTable v={v} className="mt-4 border-t border-hairline lg:border-t-0" />
    </div>
  );
}

/** On top of History: what is on its way (money warnings printed in full), then the trades. */
function HistoryLead({ v }) {
  if (!v.inFlight.length && !v.inFlightUnread) return null;
  return (
    <section id="on-its-way" className="scroll-mt-28 border-b border-hairline pb-2 pt-3" aria-label="On its way">
      <div className="flex h-6 items-center gap-2 text-label text-muted-foreground">
        On its way
        <Tip align="start" title="Why this is not in the balance">Money that has left one place and not reached the next. It joins the balance when it lands, so it is never counted twice.</Tip>
      </div>
      <InFlightList rows={v.inFlight} unread={v.inFlightUnread} />
    </section>
  );
}

/** The balance: label, ONE figure, Available | In positions, and the unequal pair of actions (a lime Deposit and a
 *  plain "Withdraw →"). `toggles` (xl) makes each action a disclosure for the panel beside it. */
function BalanceHome({ v, pb, note, canWithdraw, panel, go, toggles = false, className = "" }) {
  const open = (p) => go(toggles && panel === p ? null : p);
  const t = v.total;
  return (
    /* Below xl it re-enters each time a panel closes; at xl it never leaves, so the page entrance is enough. */
    <div className={`${toggles ? "" : "t-swap-in"} ${className}`}>
      <div className="flex h-4 items-center gap-2 text-label text-muted-foreground">
        Balance
        <TotalState total={t} />
      </div>
      <div className="mt-3 text-display-sm md:text-display">
        {!t || t.loading
          ? <span className="skeleton-shimmer block h-11 w-56 rounded-md md:h-16 md:w-72" />
          : t.usd == null
            ? <span className="num text-muted-foreground">—</span>
            : <MoneyHero text={t.text} />}
      </div>
      <Where v={v} pb={pb} />
      {note ? <p className="mt-3 text-xs text-muted-foreground">{customerWords(note)}</p> : null}
      <div className="mt-6 flex items-center gap-4">
        <Button variant="brand" size="lg" className="min-w-[148px]" onClick={() => open("deposit")} aria-expanded={toggles ? panel === "deposit" : undefined}>
          Deposit
        </Button>
        <Button variant="link" size="lg" onClick={() => open("withdraw")} disabled={!canWithdraw} aria-expanded={toggles ? panel === "withdraw" : undefined}>
          Withdraw <span aria-hidden="true">→</span>
        </Button>
      </div>
      {/* What is on its way, in one line next to the actions (a warning first), so a money warning is never only at
          the bottom of the page; the full list is at the top of the History tab. */}
      {v.inFlight.length ? <InFlightLine rows={v.inFlight} to="#on-its-way" className="mt-4 border-t border-hairline pt-1.5" /> : null}
    </div>
  );
}

/** The band the panels open in. Below xl it holds the balance and swaps it for a panel in place (AutoHeight 300ms +
 *  a keyed t-swap-in body); at xl the balance lives in the index column, so the band is empty until a panel opens. */
function BalanceBand({ panelKey = null, panel = null, home = null }) {
  const ref = useRef(null);
  /* Below xl a panel opens here, at the top; a pill pressed further down (the Spot tab) brings it into view. */
  useEffect(() => {
    if (!panelKey || !ref.current) return undefined;
    const r = ref.current.getBoundingClientRect();
    if (r.top >= 0 && r.top < window.innerHeight * 0.5) return undefined;
    const t = setTimeout(() => ref.current && ref.current.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(t);
  }, [panelKey]);
  let body = null;
  if (panel) body = <div key={panelKey || "panel"} className="t-swap-in pb-7">{panel}</div>;
  else if (home) body = <div key="home" className="py-7">{home}</div>;
  return (
    <section ref={ref} className={`scroll-mt-16 ${body ? "border-b border-border" : ""}`}>
      <AutoHeight>{body}</AutoHeight>
    </section>
  );
}

/* ── Signed out: the real Wallet, at zero (owner, 2026-10-15: "หน้า Wallet ตอนยังไม่ได้ Login ควรจะหน้าตาแบบ สวยกว่า
   นี้นะ เช่น โชว์หน้าข้างใน ว่า Balance 0 เปนไงอะ"). The same columns and tabs, $0.00 where the figures go, and one
   clear Sign in now. Sign in now, Deposit and Withdraw all open the Log in / Sign up list in place (ConnectCard
   start="list", the Agent's and the trade form's pattern). No fake figure other than the zeros. ──────────────── */

function GuestAccountRow({ signing, start }) {
  return (
    <div className="flex h-16 items-center justify-between gap-3 border-b border-border">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Icon name="wallet" size={16} /></span>
        <span className="truncate text-sm font-medium text-muted-foreground">Not signed in</span>
      </div>
      {signing ? null : (
        <Button variant="primary" size="sm" className="shrink-0" onClick={start}>
          <Icon name="wallet" size={14} /> Sign in now
        </Button>
      )}
    </div>
  );
}

function GuestBalance({ signing, start, stop, className = "" }) {
  return (
    <div className={`t-swap-in ${className}`}>
      <div className="flex h-4 items-center text-label text-muted-foreground">Balance</div>
      <div className="mt-3 text-display-sm md:text-display"><MoneyHero text="$0.00" /></div>
      <StatStrip className="mt-5">
        <Stat label="Available">$0.00</Stat>
        <Stat label="In positions">$0.00</Stat>
      </StatStrip>
      <AutoHeight>
        {signing ? (
          <div key="in" className="t-swap-in mt-6 rounded-xl bg-card px-4 pb-4 pt-1 ring-1 ring-inset ring-border">
            <div className="flex h-11 items-center justify-between">
              <span className="text-sm font-medium">Sign in</span>
              <IconButton className="-mr-2.5" label="Close sign in" onClick={stop}><Icon name="x" size={16} /></IconButton>
            </div>
            <ConnectCard start="list" bare />
          </div>
        ) : (
          <div key="act" className="t-swap-in mt-6 flex items-center gap-4">
            <Button variant="brand" size="lg" className="min-w-[148px]" onClick={start}>Deposit</Button>
            <Button variant="link" size="lg" onClick={start}>Withdraw <span aria-hidden="true">→</span></Button>
          </div>
        )}
      </AutoHeight>
    </div>
  );
}

/* The Spot tab, signed out: the moves it will hold (locked) and a quiet empty line. A pill opens sign-in. */
function GuestSpot({ start }) {
  return (
    <div className="pt-4">
      <SpotActions v={null} go={(k) => { if (k) start(); }} />
      <EmptyState title="Sign in to see your assets." />
    </div>
  );
}

function GuestWallet({ xl }) {
  const [signing, setSigning] = useState(false);
  const [activity, setActivity] = useState("positions");
  const start = () => setSigning(true);
  const stop = () => setSigning(false);
  const balance = { signing, start, stop };
  return (
    <div className={ROOT}>
      <aside className="xl:sticky xl:top-14 xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:self-start">
        <GuestAccountRow signing={signing} start={start} />
        {xl ? <GuestBalance {...balance} className="pb-8 pt-7" /> : null}
      </aside>
      <div className="min-w-0 xl:col-start-3 xl:row-start-1">
        {xl ? null : <section className="border-b border-border py-7"><GuestBalance {...balance} /></section>}
      </div>
      <div className="mt-2 min-w-0 xl:col-start-3 xl:row-start-2 xl:pb-16 xl:pt-[11px]">
        <PositionsPanel
          tab={activity}
          onTab={setActivity}
          extraTabs={[{ value: "spot", label: "Spot", render: () => <GuestSpot start={start} /> }]}
        />
      </div>
      <div className="hidden bg-border xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:block" aria-hidden="true" />
    </div>
  );
}

/** Signing in (useWallet().pending): the wallet's own shape, shimmering, instead of the signed-out card. */
function WalletPending({ pending, xl }) {
  const balance = (
    <div className="t-swap-in">
      <div className="text-label text-muted-foreground">Balance</div>
      <span className="skeleton-shimmer mt-3 block h-11 w-56 rounded-md md:h-16 md:w-72" />
      <StatStrip className="mt-5">
        <Stat label="Available"><span className="skeleton-shimmer inline-block h-3.5 w-20 rounded align-top" /></Stat>
        <Stat label="In positions"><span className="skeleton-shimmer inline-block h-3.5 w-14 rounded align-top" /></Stat>
      </StatStrip>
      <span className="skeleton-shimmer mt-6 block h-11 w-[148px] rounded-xl" />
    </div>
  );
  return (
    <div className={ROOT}>
      <aside className="xl:col-start-1 xl:row-start-1">
        <div role="status" className="flex h-16 items-center gap-3 border-b border-border text-sm">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted"><Spinner /></span>
          <ShimmerText text={pending === "wallet" ? "Setting up your wallet…" : "Signing you in…"} />
        </div>
        {xl ? <div className="pb-8 pt-7">{balance}</div> : null}
      </aside>
      {xl ? null : <section className="border-b border-border py-7">{balance}</section>}
      <div className="hidden bg-border xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:block" aria-hidden="true" />
    </div>
  );
}

/** `#on-its-way` (the Home's and the balance's "on its way" line) opens History and scrolls to that list. */
function useHashScroll(ready, openHistory) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || hash !== "#on-its-way") return undefined;
    openHistory();
    const t = setTimeout(() => {
      const el = document.getElementById("on-its-way");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => clearTimeout(t);
  }, [hash, ready]);
}

export default function WalletPage() {
  const b = useBackend();
  const w = useWallet();
  const v = usePortfolio();
  const xl = useMediaQuery(XL);
  const [panel, go] = usePanel();
  /* The wide column's tabs: Positions | Orders | History (what is on its way on top) | Spot (owner: "Position | Order |
     History | Spot"; clean, so nothing is stacked under the tabs). */
  const [activity, setActivity] = useState("positions");
  useHashScroll(v.inFlight.length > 0 || !!v.inFlightUnread, () => setActivity("history"));

  if (!b.mock && !b.connected) {
    if (w.pending) return <WalletPending pending={w.pending} xl={xl} />;
    return <GuestWallet xl={xl} />;
  }

  const bal = balanceView(b.account && b.account.perpBalanceUsdc);
  const pb = b.account && b.account.perpBalanceUsdc ? b.account.perpBalanceUsdc : null;
  const home = { v, pb, note: bal.note, canWithdraw: !!(bal.canWithdraw || b.mock), panel, go };
  const close = () => go(null);
  const openPanel = panel === "deposit" ? <DepositPanel onBack={close} />
    : panel === "withdraw" ? <WithdrawPanel backend={b} onBack={close} />
    : panel ? <SpotPanelHost kind={panel} v={v} onBack={close} />
    : null;

  /* Direct children are the page's sections, so t-enter staggers them: account (and the balance at xl), the balance
     band, positions. The rule is last in the DOM (placed into column 2 at xl) so a hidden rule never takes a stagger
     slot below xl. */
  return (
    <div className={ROOT}>
      <aside className="xl:sticky xl:top-14 xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:self-start">
        <AccountRow />
        {xl ? <BalanceHome {...home} toggles className="pb-8 pt-7" /> : null}
      </aside>
      <div className="min-w-0 xl:col-start-3 xl:row-start-1">
        <BalanceBand panelKey={panel} panel={openPanel} home={xl ? null : <BalanceHome {...home} />} />
      </div>
      <div className={`mt-2 min-w-0 xl:col-start-3 xl:row-start-2 xl:pb-16 ${xl && !panel ? "xl:pt-[11px]" : ""}`}>
        {/* The prod wallet's top: Positions / Orders / History first (owner, on both: "แบบขวา สวยกว่า"); Assets and
            On its way below it, still in the wide column (owner: "ให้ Asset อยู่ฝั่งขวาด้วยดิ รวมถึง On its way ด้วย"). */}
        <PositionsPanel
          tab={activity}
          onTab={setActivity}
          historyLead={<HistoryLead v={v} />}
          extraTabs={[{ value: "spot", label: "Spot", render: () => <SpotTab v={v} panel={panel} go={go} toggles={xl} /> }]}
        />
      </div>
      <div className="hidden bg-border xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:block" aria-hidden="true" />
    </div>
  );
}
