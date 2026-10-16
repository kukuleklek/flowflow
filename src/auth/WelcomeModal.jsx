import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import ConnectCard from "./ConnectCard.jsx";
import Icon from "../ui/Icon.jsx";
import { IconButton } from "../ui/Button.jsx";
import { LogoMark } from "../ui/Logo.jsx";
import SponsorLogo from "../ui/SponsorLogo.jsx";
import { useReducedMotion } from "../ui/kit/index.ts";
import { useWallet } from "../hooks/useWallet.js";
import { useBackend } from "../perp/BackendContext.jsx";
import { isPrivyConfigured, restoringAtLoad } from "../services/privy.js";
import {
  WELCOME_ASKS, WELCOME_CHIPS, WELCOME_COPY, WELCOME_FLIP_MS,
  beginHandoff, coinOfPath, devWelcome, markWelcomeSeen, placeChips, shouldShowWelcome, takeHandoff, welcomeSeen,
} from "./welcomeView.js";

const OPEN_AFTER_MS = 450; // the terminal paints first, then the welcome rises over it
const CLOSE_MS = 200;
const session = () => { try { return window.sessionStorage; } catch { return null; } };
const sheetOpen = () => !!document.querySelector(".ff-sheet.is-open");

/** The word that slides between its two states (Deposit ↔ Withdraw); the width follows the word on show. */
function Flip({ words }) {
  const [{ i, out }, setFlip] = useState({ i: 0, out: null });
  const box = useRef(null);
  const refs = useRef([]);
  useEffect(() => {
    const t = setInterval(() => setFlip((f) => ({ i: (f.i + 1) % words.length, out: f.i })), WELCOME_FLIP_MS);
    return () => clearInterval(t);
  }, [words.length]);
  useLayoutEffect(() => {
    const el = refs.current[i];
    if (box.current && el) box.current.style.width = `${el.offsetWidth}px`;
  }, [i]);
  return (
    <span ref={box} className="ff-flip" aria-live="off">
      {words.map((w, k) => (
        <span key={w} ref={(el) => { refs.current[k] = el; }} className={k === i ? "is-on" : k === out ? "is-out" : ""} aria-hidden={k === i ? undefined : "true"}>{w}</span>
      ))}
    </span>
  );
}

function ChipPart({ p }) {
  if (typeof p === "string") return <span>{p}</span>;
  if (p.flip) return <Flip words={p.flip} />;
  if (p.icon) {
    return <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted"><Icon name={p.icon} size={12} strokeWidth={2.2} /></span>;
  }
  const h = p.h || (p.round ? 18 : 16);
  const wd = p.round ? h : Math.round(h * (p.aspect || 1));
  return (
    <img src={p.logo} alt={p.alt || ""} height={h} width={wd} draggable="false"
      className={`block shrink-0 select-none object-contain ${p.round ? "rounded-full" : ""}`} style={{ height: h, width: wd }} />
  );
}

/** The prompt bar types what you can say, one line after another (reduced motion: the first line, still). */
function Typing() {
  const reduce = useReducedMotion();
  const [text, setText] = useState(reduce ? WELCOME_ASKS[0] : "");
  useEffect(() => {
    if (reduce) { setText(WELCOME_ASKS[0]); return undefined; }
    let si = 0;
    let ci = 0;
    let del = false;
    let t;
    const tick = () => {
      const s = WELCOME_ASKS[si];
      if (!del) {
        ci += 1;
        setText(s.slice(0, ci));
        if (ci === s.length) { del = true; t = setTimeout(tick, 1600); return; }
      } else {
        ci -= 1;
        setText(s.slice(0, ci));
        if (ci === 0) { del = false; si = (si + 1) % WELCOME_ASKS.length; }
      }
      t = setTimeout(tick, del ? 28 : 55);
    };
    t = setTimeout(tick, 600);
    return () => clearTimeout(t);
  }, [reduce]);
  return <span className="min-w-0 flex-1 truncate text-sm">{text}<span className="ff-caret" aria-hidden="true" /></span>;
}

/** The right panel's middle: the prompt bar, and the chips at random spots that never overlap (welcomeView.placeChips). */
function Scene() {
  const scene = useRef(null);
  const prompt = useRef(null);
  const chips = useRef([]);
  const [spots, setSpots] = useState(null);
  const [on, setOn] = useState(0);
  const [drift] = useState(() => WELCOME_CHIPS.map(() => ({ d: `${(7 + Math.random() * 3).toFixed(1)}s`, dd: `${(Math.random() * -6).toFixed(1)}s` })));

  const place = useCallback(() => {
    const box = scene.current;
    const pr = prompt.current;
    if (!box || !pr) return;
    const sizes = WELCOME_CHIPS.map((_, k) => ({ w: chips.current[k]?.offsetWidth || 0, h: chips.current[k]?.offsetHeight || 0 }));
    /* The bar sits at 50% / 50% pulled back by half its size (a translate offsetLeft/Top do not see); layout sizes,
       not rects, so the card's opening scale cannot skew them. */
    const bar = { x: pr.offsetLeft - pr.offsetWidth / 2, y: pr.offsetTop - pr.offsetHeight / 2, w: pr.offsetWidth, h: pr.offsetHeight };
    setSpots(placeChips(sizes, { w: box.clientWidth, h: box.clientHeight }, bar));
  }, []);

  useLayoutEffect(() => { place(); }, [place]);
  /* Geist may land after the first measure: place again before the first chip shows. */
  useEffect(() => {
    let alive = true;
    document.fonts?.ready?.then(() => { if (alive) place(); });
    return () => { alive = false; };
  }, [place]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !scene.current) return undefined;
    /* The bar is centred, so a taller or wider panel (the title re-wrapping once Geist lands, a resize) moves it:
       place again. */
    let last = { w: scene.current.clientWidth, h: scene.current.clientHeight };
    const ro = new ResizeObserver(() => {
      const el = scene.current;
      if (!el) return;
      if (Math.abs(el.clientWidth - last.w) > 4 || Math.abs(el.clientHeight - last.h) > 4) { last = { w: el.clientWidth, h: el.clientHeight }; place(); }
    });
    ro.observe(scene.current);
    return () => ro.disconnect();
  }, [place]);
  useEffect(() => {
    if (!spots || on >= WELCOME_CHIPS.length) return undefined;
    const t = setTimeout(() => setOn((n) => n + 1), on === 0 ? 300 : 300 + Math.random() * 160);
    return () => clearTimeout(t);
  }, [spots, on]);

  return (
    <div ref={scene} className="relative mt-5 min-h-[260px] flex-1">
      <div ref={prompt} className="absolute left-1/2 top-1/2 flex w-[min(340px,90%)] -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-[18px] bg-card py-2.5 pl-4 pr-2.5 shadow-[0_10px_30px_rgb(9_9_11/.08)] ring-1 ring-inset ring-border">
        <Typing />
        <span className="ff-mic-ping relative grid size-9 shrink-0 place-items-center rounded-xl bg-foreground text-background" aria-hidden="true">
          <Icon name="mic" size={16} strokeWidth={2} />
        </span>
      </div>
      {WELCOME_CHIPS.map((c, k) => {
        const spot = spots ? spots[k] : null;
        if (spots && !spot) return null; // no room at this size: left out rather than overlapping
        return (
          <span
            key={c.id}
            ref={(el) => { chips.current[k] = el; }}
            className={`ff-chip absolute inline-flex items-center gap-[7px] whitespace-nowrap rounded-full bg-card py-1.5 pr-3 text-[12.5px] font-medium shadow-[0_4px_14px_rgb(9_9_11/.06)] ring-1 ring-inset ring-border ${typeof c.parts[0] === "string" ? "pl-3" : "pl-2"} ${k < on ? "is-on" : ""}`}
            style={{ left: spot ? spot.x : 0, top: spot ? spot.y : 0, visibility: spot ? undefined : "hidden", "--d": drift[k].d, "--dd": drift[k].dd }}
          >
            {c.parts.map((p, j) => <ChipPart key={j} p={p} />)}
          </span>
        );
      })}
    </div>
  );
}

/** The card: Sign in / Sign up on the left (ConnectCard, the header's own sign-in), the pitch on the right. */
function WelcomeCard({ open, onClose, coin }) {
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(false);
  const root = useRef(null);
  const card = useRef(null);
  const back = useRef(null);

  useEffect(() => {
    if (open) { setRender(true); return undefined; }
    setShown(false);
    const t = setTimeout(() => setRender(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!render || !open) return;
    if (root.current) void root.current.offsetWidth; // reflow, not a frame: frames pause in a background tab
    setShown(true);
  }, [render, open]);

  useEffect(() => {
    if (!open) return undefined;
    back.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !card.current) return;
      const f = [...card.current.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const a = f[0];
      const z = f[f.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === a || at === card.current)) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && at === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      try { back.current?.focus?.({ preventScroll: true }); } catch { /* the trigger is gone */ }
    };
  }, [open, onClose]);

  /* Focus the dialog once it is in the DOM (on the open render it is not yet): screen readers land in it, Tab goes
     to Sign in next, and no ring sits on a button before anyone has pressed a key. */
  useEffect(() => {
    if (open && render) card.current?.focus({ preventScroll: true });
  }, [open, render]);

  if (!render) return null;
  return createPortal(
    <div
      ref={root}
      className={`ff-welcome fixed inset-0 z-[60] grid place-items-center bg-foreground/40 p-6 ${shown ? "is-open" : ""}`}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ff-welcome-title"
        tabIndex={-1}
        className="ff-welcome-card grid outline-none max-h-[calc(100dvh-48px)] min-h-[min(640px,calc(100dvh-48px))] w-[min(1080px,100%)] grid-cols-[380px_minmax(0,1fr)] overflow-hidden rounded-[24px] bg-card shadow-[0_24px_64px_rgb(9_9_11/.22),0_2px_8px_rgb(9_9_11/.08)]"
      >
        <div className="flex flex-col justify-center overflow-y-auto px-10 py-10">
          <LogoMark size={40} />
          <h1 id="ff-welcome-title" className="mt-5 text-[28px] font-semibold leading-tight tracking-[-0.02em]">{WELCOME_COPY.heading}</h1>
          <p className="mb-7 mt-1.5 text-sm text-muted-foreground">{WELCOME_COPY.sub}</p>
          <ConnectCard start="pair" bare onBegin={() => beginHandoff(session(), coin)} onDone={onClose} />
          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>{WELCOME_COPY.privyLead}</span>
            <SponsorLogo name="privy" variant="wordmark" size={15} alt="Privy" />
            <span className="h-3 w-px bg-border" aria-hidden="true" />
            <span>{WELCOME_COPY.privyTail}</span>
          </div>
        </div>
        <div className="ff-welcome-art relative flex min-h-0 flex-col overflow-hidden border-l border-hairline px-10 pb-8 pt-10">
          <IconButton label="Close" onClick={onClose} className="!absolute right-4 top-4 z-10 bg-card text-foreground ring-1 ring-inset ring-border">
            <Icon name="x" size={16} />
          </IconButton>
          <h2 className="relative max-w-[22ch] pr-12 text-[26px] font-semibold leading-[1.2] tracking-[-0.02em]">
            {WELCOME_COPY.titleLead}{" "}
            <span className="inline-flex items-center gap-2 whitespace-nowrap align-[-3px]">
              <SponsorLogo name="avalanche" variant="wordmark" size={21} alt="Avalanche" />
              <span className="rounded-full bg-card px-[7px] py-[3px] text-[10px] font-semibold uppercase tracking-[.08em] text-muted-foreground ring-1 ring-inset ring-border">{WELCOME_COPY.network}</span>
            </span>
          </h2>
          <div className="relative mt-3">
            <span className="inline-flex h-7 items-center rounded-full bg-foreground/[.06] px-3 text-[13px] font-medium">{WELCOME_COPY.event}</span>
          </div>
          <p className="relative mt-2.5 text-[15px] text-muted-foreground">{WELCOME_COPY.tagline}</p>
          <Scene />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The first-visit welcome on a coin page (desktop; MarketPage mounts it only there). It opens once per visit for a
 * signed-out visitor (welcomeView.shouldShowWelcome), and when a sign-in that began in it lands, calls onChat() once
 * so the terminal opens its Chat tab (welcomeView.takeHandoff, which survives Google's redirect).
 */
export default function Welcome({ coin, onChat }) {
  const w = useWallet();
  const b = useBackend();
  const { pathname, search } = useLocation();
  const [dev] = useState(() => devWelcome(search, import.meta.env.DEV));
  const [open, setOpen] = useState(false);
  const decided = useRef(false);
  const chat = useRef(onChat);
  chat.current = onChat;
  const live = useRef(null);
  live.current = { w, mock: !!b.mock, pathname };

  useEffect(() => {
    if (decided.current) return undefined;
    let t;
    const check = () => {
      const st = session();
      const { w: lw, mock, pathname: path } = live.current;
      const s = {
        desktop: true,
        path,
        forced: dev === "open",
        mock,
        configured: isPrivyConfigured(),
        signedIn: !!lw.address,
        pending: lw.pending,
        restoring: restoringAtLoad(),
        seen: welcomeSeen(st),
        sheetOpen: sheetOpen(),
      };
      if (shouldShowWelcome(s)) {
        decided.current = true;
        markWelcomeSeen(st);
        setOpen(true);
        return;
      }
      /* Only an open sheet is worth waiting for; anything else means not this visit. */
      if (shouldShowWelcome({ ...s, sheetOpen: false })) { t = setTimeout(check, 600); return; }
      decided.current = true;
    };
    t = setTimeout(check, OPEN_AFTER_MS);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (dev === "done") { chat.current?.(); return; }
    const r = takeHandoff(session(), { desktop: true, signedIn: !!w.address, pending: w.pending, path: pathname });
    if (r && r.tab === "chat") chat.current?.();
  }, [w.address, w.pending, pathname, dev]);

  const close = useCallback(() => setOpen(false), []);
  return <WelcomeCard open={open} onClose={close} coin={coin || coinOfPath(pathname)} />;
}
