import { useContext, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { NavLink, UNSAFE_LocationContext as LocationContext, useLocation, useOutlet } from "react-router-dom";
import { useSlidingPill, prefersReducedMotion, parseCssTime, INERT, ShimmerText } from "../ui/kit/index.ts";
import Logo from "../ui/Logo.jsx";
import Icon from "../ui/Icon.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import AccountButton from "../auth/AccountButton.jsx";
import { useBackend } from "../perp/BackendContext.jsx";
import { balanceView } from "../perp/live/perpLiveView.js";
import { useWallet } from "../context/WalletContext.jsx";

const NAV = [
  { to: "/trade", label: "Trade", icon: "trade" },
  { to: "/agent", label: "FlowFlow", icon: "agent" },
  { to: "/wallet", label: "Wallet", icon: "wallet" },
];

/* A nav tab fills the bar's full height, so its focus ring is drawn inside the tab (a rounded box around the label)
   instead of outside it, where the viewport top or the screen bottom would clip it. */
const FOCUS_IN = "!rounded-lg focus-visible:[outline-offset:-6px]";

/** Desktop nav: text tabs, one 2px ink bar that sits ON the header rule and slides between them. Links
 *  (aria-current="page"), not a tablist. */
function TopNav() {
  const list = useRef(null);
  const pill = useRef(null);
  useSlidingPill(list, pill, '[aria-current="page"]');
  return (
    <nav ref={list} aria-label="Main" className="t-tabs ff-line hidden h-14 items-stretch md:flex [--line-bottom:-1px] [--line-inset:12px]">
      <span ref={pill} className="t-tabs-pill" aria-hidden="true" />
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} className={`t-tab inline-flex h-14 items-center px-3 text-sm font-medium ${FOCUS_IN}`}>
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Phone nav: three icon tabs, a 28px ink bar on the nav's top rule over the active one. Solid, no blur. */
function BottomNav() {
  const list = useRef(null);
  const pill = useRef(null);
  useSlidingPill(list, pill, '[aria-current="page"]');
  return (
    <nav ref={list} aria-label="Main" className="t-tabs ff-line ff-bar-top grid h-16 w-full grid-cols-3">
      <span ref={pill} className="t-tabs-pill" aria-hidden="true" />
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} className={`t-tab flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${FOCUS_IN}`}>
          <Icon name={n.icon} size={20} />
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

function HeaderBalance() {
  const b = useBackend();
  if (!b.connected) return null;
  const bal = balanceView(b.account && b.account.perpBalanceUsdc);
  return (
    <span className="hidden items-baseline gap-1.5 text-xs text-muted-foreground sm:inline-flex">
      Balance
      <TickNumber value={bal.known ? `$${bal.text}` : "—"} className="num text-sm font-medium text-foreground" />
    </span>
  );
}

/* ── Signing in (owner: "Login เสร็จ มันค้างอยู่หน้าแรกไปนิดนึงเกินไป") ─────────────────────────────────────────────
   While the session and the wallet arrive (useWallet().pending: "restoring" after a reload or a Google return,
   "wallet" right after Log in / Sign up), a short full-screen view: the FlowFlow mark with its waves flowing and one
   line. It waits a beat before showing (a fast restore never flashes it), fades out when the wallet is there, and
   gives the screen back after VEIL_MAX_MS whatever happens (Privy blocked, offline). It never covers an open sheet
   (app.css: body:has(.ff-sheet.is-open) .ff-veil). In dev, ?ffveil=wallet|restoring shows it for a screenshot. */
const VEIL_DELAY_MS = 120;
const VEIL_MAX_MS = 9000;
const VEIL_FADE_MS = 200;

function devVeil() {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("ffveil");
  return v === "wallet" || v === "restoring" ? v : null;
}

function SignInVeil() {
  const w = useWallet();
  const [forced] = useState(devVeil);
  const pending = forced || w.pending || null;
  const [view, setView] = useState({ on: false, closing: false, kind: null });
  const timedOut = useRef(false);

  useEffect(() => {
    if (!pending) {
      timedOut.current = false;
      if (!view.on) return undefined;
      setView((v) => ({ ...v, closing: true }));
      const t = setTimeout(() => setView({ on: false, closing: false, kind: null }), VEIL_FADE_MS);
      return () => clearTimeout(t);
    }
    if (timedOut.current) return undefined;
    if (view.on && !view.closing) { setView((v) => (v.kind === pending ? v : { ...v, kind: pending })); return undefined; }
    const t = setTimeout(() => setView({ on: true, closing: false, kind: pending }), view.closing ? 0 : VEIL_DELAY_MS);
    return () => clearTimeout(t);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!view.on || view.closing || forced) return undefined;
    const t = setTimeout(() => {
      timedOut.current = true;
      setView((v) => ({ ...v, closing: true }));
      setTimeout(() => setView({ on: false, closing: false, kind: null }), VEIL_FADE_MS);
    }, VEIL_MAX_MS);
    return () => clearTimeout(t);
  }, [view.on, view.closing, forced]);

  if (!view.on) return null;
  const words = view.kind === "wallet" ? "Setting up your wallet…" : "Signing you in…";
  return (
    <div className={`ff-veil fixed inset-0 z-[70] grid place-items-center bg-background ${view.closing ? "is-closing" : ""}`} role="status" aria-live="polite">
      <div className="flex flex-col items-center">
        <span className="ff-send block size-14" data-state="busy" aria-hidden="true">
          <svg viewBox="0 0 64 64">
            <rect className="tile" width="64" height="64" rx="16" />
            <path className="w1" d="M14 26c6-6 12-6 18 0s12 6 18 0" />
            <path className="w2" d="M14 40c6-6 12-6 18 0s12 6 18 0" />
          </svg>
        </span>
        <span className="mt-5 text-base font-semibold tracking-[-0.03em]">FlowFlow</span>
        <span key={view.kind} className="t-swap-in mt-1.5 text-sm text-muted-foreground"><ShimmerText text={words} /></span>
      </div>
    </div>
  );
}

/* ── Page transition (USER-REQUESTS B1–B3, B6) ─────────────────────────────────────────────────────────────────
   Every pathname is its own page (query-only changes like ?panel=deposit are not). On a new pathname the page that
   was showing stays mounted for --page-exit-dur as a .ff-page-exit layer: absolute inside the <main> stage, inert,
   no layout space, frozen on its own location, playing the exit (fade, a hair of scale and blur; reduced motion: a
   short fade only). The new page renders in flow and its own .t-enter root rises in. The window jumps to the top,
   and --exit-top keeps the old page exactly where the eye left it. Both kinds of layer share one element shape, so
   React keeps a page's instance when it turns into an exit layer (or back, on a quick return). */
let layerSeq = 0;

function exitMs() {
  const root = getComputedStyle(document.documentElement);
  return prefersReducedMotion()
    ? parseCssTime(root.getPropertyValue("--rm-fade-dur"), 150)
    : parseCssTime(root.getPropertyValue("--page-exit-dur"), 150);
}

function usePageLayers(stageRef) {
  const loc = useLocation();
  const outlet = useOutlet();
  const locCtx = useContext(LocationContext);
  const key = loc.pathname;
  const [, rerender] = useReducer((n) => n + 1, 0);
  const current = useRef(null);
  const leaving = useRef([]);
  const shownKey = useRef(key);

  if (current.current && current.current.key !== key) {
    const was = current.current;
    const stage = stageRef.current;
    leaving.current = [
      ...leaving.current.filter((l) => l.key !== key && l.key !== was.key),
      { ...was, id: ++layerSeq, from: stage ? stage.getBoundingClientRect().top : 0, top: 0 },
    ];
  }
  current.current = { key, el: outlet, ctx: locCtx };

  /* New pathname: back to the top, then pin the exit layer to where its page was on screen (before paint). */
  useLayoutEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const stage = stageRef.current;
    const last = leaving.current[leaving.current.length - 1];
    if (!stage || !last) return;
    last.top = Math.round(last.from - stage.getBoundingClientRect().top);
    const el = stage.querySelector(`[data-page-layer="${last.id}"]`);
    if (el) el.style.setProperty("--exit-top", `${last.top}px`);
  }, [key, stageRef]);

  const pending = leaving.current.map((l) => l.id).join(",");
  useEffect(() => {
    if (!pending) return undefined;
    const ids = new Set(pending.split(",").map(Number));
    const t = window.setTimeout(() => {
      leaving.current = leaving.current.filter((l) => !ids.has(l.id));
      rerender();
    }, exitMs() + 40);
    return () => window.clearTimeout(t);
  }, [pending]);

  return [
    ...leaving.current.map((l) => ({ ...l, exiting: true })),
    { ...current.current, id: "page", exiting: false, top: 0 },
  ];
}

export default function AppShell() {
  const loc = useLocation();
  const stage = useRef(null);
  const layers = usePageLayers(stage);
  const onCoin = /^\/trade\/[^/]+/.test(loc.pathname);
  const onAgent = loc.pathname.startsWith("/agent");
  const pad = onCoin || onAgent ? "" : "pb-[calc(88px+env(safe-area-inset-bottom))] md:pb-16";
  const exiting = layers.length > 1;
  /* The header materializes once, on the app's first paint (B3). Phones hide it on a coin page (display: none), and a
     CSS animation replays whenever its element is shown again, so the class goes once it has played. */
  const [intro, setIntro] = useState(true);

  return (
    <div className="min-h-dvh bg-background">
      <header className={`sticky top-0 z-40 border-b border-border bg-background ${onCoin ? "hidden md:block" : ""}`}>
        <div
          className={`${intro ? "t-materialize" : ""} mx-auto flex h-14 w-full items-center justify-between gap-4 px-gutter ${onCoin ? "" : "max-w-content"}`}
          onAnimationEnd={intro ? (e) => { if (e.target === e.currentTarget) setIntro(false); } : undefined}
        >
          <div className="flex items-center gap-8">
            <NavLink to="/trade" aria-label="FlowFlow home" className="rounded-lg"><Logo size={26} /></NavLink>
            <TopNav />
          </div>
          <div className="flex items-center gap-4">
            <HeaderBalance />
            <AccountButton />
          </div>
        </div>
      </header>
      {/* While a page is leaving, the stage is at least a screen tall, so a short new page never cuts the old one off. */}
      <main ref={stage} className={`ff-stage ${pad}`} style={exiting ? { minHeight: "calc(100dvh - var(--header-h))" } : undefined}>
        {layers.map((l) => (
          <div
            key={l.key}
            data-page-layer={l.id}
            className={l.exiting ? "ff-page-exit" : undefined}
            style={l.exiting ? { "--exit-top": `${l.top}px` } : undefined}
            inert={l.exiting ? INERT : undefined}
            aria-hidden={l.exiting ? "true" : undefined}
          >
            <LocationContext.Provider value={l.ctx}>{l.el}</LocationContext.Provider>
          </div>
        ))}
      </main>
      {onCoin ? null : (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
          <BottomNav />
        </div>
      )}
      <SignInVeil />
    </div>
  );
}
