// The Pending popup: where the customer's deposit is, on every page.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ตอน Deposit Asset Pending อยู่ ต้องมีขึ้นบนจอด้วยดิ เป็นกล่อง
// popup ว่า Pending". ONE floating box (FlowFlow's own take on a status
// strip, perp/deposit/DepositStatus.jsx there): a deposit on its way, its last
// hop moving it, and its arrival — in the words perp/deposit/depositPopupView.js
// works out from the deposit watch and the tab's one move. Nothing is decided
// here; this file draws the box and wires its presses.
//
// WHERE. A floating card at the top, centred, just under the header, on every
// screen size. Never at the bottom: that is where every page keeps its main
// action (the order button at the foot of the trade column, the Agent's
// composer, the phone's trade bar and nav) and where the toasts stack — a box
// that cannot be closed while a deposit is pending must not sit on any of them.
// Its layer is UNDER the header (z-40), so the header's own menus (the account
// menu, Sign in) open over it, and under every sheet, the full-screen chart and
// the toasts; it is over the page itself.
//
// EVERY STATE HAS ITS ×. One that stays (refunded, failed, short, a refused
// move) is acknowledged by it. One that is live (pending, moving) is only
// hidden: it comes back when the deposit's state changes (moving → sent), never
// for the same state again.
//
// WHEN IT DRAWS NOTHING. No wallet, nothing to say, or a Deposit panel open
// (the panel is saying it all, and two surfaces must not narrate one deposit).
//
// MOTION. The kit's: the card materializes, the words swap in when the state
// changes, the figure pops (AnimatedNumber), an arrival draws its check
// (SuccessCheck), and the card fades out on leaving. Every one of those has its
// reduced-motion form in the kit's own CSS.
//
// DEV ONLY: ?ffDepositPreview=arriving|moving|sent|credited|landed|short|failed|refunded|move-failed
// (and a Private deposit's: near-arriving|near-credited|near-landed|near-refunded|near-incomplete)
// draws a sample state through the same view function, for screenshots. The
// branch is `import.meta.env.DEV`, so a production build carries none of it.
//
// PRIVATE DEPOSITS (provider "near", 2026-10-15) come through the same watch and the
// same view: pickDepositStatus picks their rows like Relay's, and the box words
// them the same way ("Deposit pending" → "in your balance"; a private-arb deposit
// "arrived" and the auto-mover makes the hop, exactly like the first-deposit
// plan; less than quoted has its own box until it is closed). Nothing here tells
// the two services apart.
//
// THE CUSTOMER'S WORDS (owner, 2026-10-15: "อย่าเรียก Perp Account"). The box's
// sentences go through the Wallet's shim (wallet/words.js customerWords) as they
// are drawn, so the box and the Deposit panel name one place one way ("your
// balance"). A sentence naming the Spot Account keeps it (privateDepositView
// keepsOwnWords): that is where an Avalanche refund really is.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatedNumber, ShimmerText, SuccessCheck, readMotionMs } from "../../ui/kit/index.ts";
import Icon, { Spinner } from "../../ui/Icon.jsx";
import Button from "../../ui/Button.jsx";
import { useWallet } from "../../hooks/useWallet.js";
import { depositWatch, pickDepositStatus } from "./depositWatch.js";
import { perpFunding, fundingStep } from "./perpFunding.js";
import { depositPopupView, depositPanelOpen, DEPOSIT_POPUP_GO, DEPOSIT_POPUP_LEAVE_MS } from "./depositPopupView.js";
import { keepsOwnWords } from "./privateDepositView.js";
import { customerWords } from "../../wallet/words.js";

const said = (s) => (keepsOwnWords(s) ? s : customerWords(s));
/* The box as the customer reads it: the same view, its sentences in their words (the figure inside is untouched). */
const inWords = (v) => (v ? { ...v, title: said(v.title), sub: said(v.sub), text: said(v.text) } : v);

/* The ringed avatar (ui/CoinLogo's): a white disc with a hairline inner ring. */
const RING = "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:ring-1 after:ring-inset after:ring-foreground/[.08]";

function TokenMark({ view }) {
  return (
    <span className="relative inline-grid size-9 shrink-0 place-items-center" aria-hidden="true">
      <span className={`relative inline-grid size-9 place-items-center overflow-hidden rounded-full bg-card ${RING}`}>
        {view.tokenLogo ? <img src={view.tokenLogo} alt="" width={36} height={36} className="size-full object-cover" /> : null}
      </span>
      {view.chainLogo ? (
        <img src={view.chainLogo} alt="" width={16} height={16} className="absolute -bottom-0.5 -right-0.5 size-4 rounded-full bg-card ring-2 ring-card" />
      ) : null}
    </span>
  );
}

/* The title, with the figure in it popping when it changes. */
function Title({ view }) {
  if (view.kind === "arriving") return <ShimmerText text={view.title} />;
  const at = view.amount ? view.title.indexOf(view.amount) : -1;
  if (at < 0) return <>{view.title}</>;
  return (
    <>
      {view.title.slice(0, at)}
      <AnimatedNumber value={view.amount} className="num" />
      {view.title.slice(at + view.amount.length)}
    </>
  );
}

/* The right-hand mark, beside the ×: a moving one while money moves, the check
   when it is there. A state that stays has no mark; its alert sits in front of
   the title. */
function Mark({ view }) {
  if (view.check) return <SuccessCheck size={22} className="text-success" />;
  if (view.live) return <span className="text-muted-foreground"><Spinner size={18} /></span>;
  return null;
}

const alertTone = (view) => (view.kind === "short" || view.kind === "refunded" || view.kind === "incomplete" ? "text-warning" : "text-destructive");

/* A box that leaves by itself counts its time on a VISIBLE tab only: a
   customer coming back to the tab still reads it. */
function useDwell(key, onDone) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!key || typeof document === "undefined") return undefined;
    let t = null;
    const clear = () => { if (t != null) { clearTimeout(t); t = null; } };
    const arm = () => { clear(); if (document.visibilityState !== "hidden") t = setTimeout(() => done.current(), DEPOSIT_POPUP_LEAVE_MS); };
    const onVis = () => (document.visibilityState === "hidden" ? clear() : arm());
    arm();
    document.addEventListener("visibilitychange", onVis);
    return () => { clear(); document.removeEventListener("visibilitychange", onVis); };
  }, [key]);
}

/* A live box (pending, moving) the customer hid stays hidden for that state:
   the same box, or another "moving" box for the same move (its key changes when
   the move actually starts). Anything else is news, and shows. */
function hides(hidden, v) {
  if (!hidden || !v) return false;
  return v.key === hidden.key || (v.kind === "moving" && hidden.kind === "moving");
}

/* DEV ONLY: a sample state, drawn by the real view function. */
function previewView(kind) {
  const user = "0x1111111111111111111111111111111111111111";
  const dep = "0x2222222222222222222222222222222222222222";
  const t = Date.now();
  const row = (status, extra) => ({ id: `preview-${status}`, status, inChainId: 8453, createdAt: t - 60000, updatedAt: t, ...extra });
  const pick = (planId, r, routeId = "base-usdc") => ({ address: dep, routeId, planId, ...(r.provider ? { provider: r.provider } : {}), row: r });
  /* A Private row as lib/intents/status.js makes it (id "near:<address>", provider "near"). */
  const near = (status, chainId, extra) => ({ ...row(status, extra), id: `near:${dep}`, provider: "near", inChainId: chainId });
  const mv = (step, usdc, extra = {}) => ({ step, usdc, code: null, seq: 1, acked: false, balanceRead: true, balanceRaw: null, checking: false, ...extra });
  const landed = (n) => row("credited", { amountOut: n, symbolOut: "USDC", amountIn: 10, symbolIn: "USDC" });
  const S = {
    arriving: { pick: pick("arb-first", row("arriving", { amountIn: 20, symbolIn: "USDC" })) },
    moving: { pick: pick("arb-first", landed(9.92)), move: mv("sending", 9.92) },
    sent: { pick: pick("arb-first", landed(9.92)), move: mv("sent", 9.92) },
    credited: { pick: pick("direct", landed(9.92)) },
    landed: { pick: pick("arb-first", landed(9.92)), move: mv("offer", 9.92) },
    short: { pick: pick("arb-first", landed(4.2)), move: mv("short", 4.2) },
    failed: { pick: pick("arb-first", row("failed", { amountIn: 20, symbolIn: "USDC" })) },
    refunded: { pick: pick("arb-first", row("refunded", { amountIn: 20, symbolIn: "USDC" })) },
    "move-failed": { move: mv("failed", 9.92, { code: "send-failed" }) },
    "near-arriving": { pick: pick("private-core", near("arriving", 43114, { amountIn: 25, symbolIn: "USDC" }), "avalanche-usdc") },
    "near-credited": { pick: pick("private-core", near("credited", 42161, { amountIn: 25, symbolIn: "USDC", amountOut: 24.6847, symbolOut: "USDC" }), "arbitrum-usdc") },
    "near-landed": { pick: pick("private-arb", near("credited", 42161, { amountIn: 25, symbolIn: "USDC", amountOut: 24.9947, symbolOut: "USDC" }), "arbitrum-usdc"), move: mv("offer", 24.9947) },
    "near-refunded": { pick: pick("private-core", near("refunded", 43114, { amountIn: 25, symbolIn: "USDC" }), "avalanche-usdc") },
    "near-incomplete": { pick: pick("private-core", near("incomplete", 42161, { amountIn: 24, symbolIn: "USDC", refundAfter: t + 71 * 3600e3 }), "arbitrum-usdc") },
  };
  const s = S[kind];
  return s ? depositPopupView({ user, pick: s.pick || null, held: false, move: s.move || null }) : null;
}

function readPreview() {
  try {
    const k = new URLSearchParams(window.location.search).get("ffDepositPreview");
    return k ? previewView(k) : null;
  } catch { return null; }
}

export default function DepositStatus({ watch = depositWatch, funding = perpFunding }) {
  const { address } = useWallet();
  const wallet = address || null;
  const loc = useLocation();
  const navigate = useNavigate();
  const ws = useSyncExternalStore(watch.subscribe, watch.getState, watch.getState);
  const fs = useSyncExternalStore(funding.subscribe, funding.getState, funding.getState);
  const [preview, setPreview] = useState(() => (import.meta.env.DEV ? readPreview() : null));

  /* The Deposit panel is the whole story while it is open — even before its
     address has arrived and the watch knows it is held. */
  const onPanel = loc.pathname === "/wallet" && new URLSearchParams(loc.search).get("panel") === "deposit";
  const live = wallet && !onPanel
    ? depositPopupView({
      user: wallet,
      pick: pickDepositStatus(ws, wallet),
      held: depositPanelOpen(ws, wallet),
      move: fundingStep(fs, wallet, { canAuto: funding.canRun(wallet) }),
    })
    : null;
  const [hidden, setHidden] = useState(null);
  const drawn = preview || live;
  const view = hides(hidden, drawn) ? null : drawn;
  /* The hidden state has moved on: forget it, so the next one shows. */
  const drawnKey = drawn ? drawn.key : null;
  useEffect(() => {
    if (hidden && !hides(hidden, drawn)) setHidden(null);
  }, [drawnKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Kept on screen for its exit after there is nothing more to say. */
  const last = useRef(null);
  const [gone, setGone] = useState(true);
  if (view) last.current = view;
  const shownView = view || (gone ? null : last.current);
  const leaving = !view && !!shownView;
  useEffect(() => {
    if (view) { setGone(false); return undefined; }
    const t = setTimeout(() => { setGone(true); last.current = null; }, readMotionMs("--exit-dur", 350));
    return () => clearTimeout(t);
  }, [!!view]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (v) => {
    if (!v) return;
    if (preview) { setPreview(null); return; }
    if (v.ackRow) watch.dismiss(v.ackRow.address, v.ackRow.id);
    if (v.ackMove) funding.acknowledge(v.moveSeq);
    /* Nothing to acknowledge (a deposit on its way, a move in flight): hide it
       for this state only. */
    if (!v.ackRow && !v.ackMove) setHidden({ key: v.key, kind: v.kind });
  };
  const tap = (v) => {
    if (!v) return;
    if (v.kind !== "move-failed" && (v.ackRow || v.ackMove)) close(v);
    navigate(v.go);
  };
  const moveNow = () => {
    if (preview || !wallet) return;
    funding.run({ user: wallet, connected: wallet, auto: false });
  };

  useDwell(view && view.leaves && !preview ? view.key : null, () => close(view));

  const v = inWords(shownView);

  return (
    <div
      role="status"
      aria-live="polite"
      data-deposit-status=""
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)_+_var(--header-h)_+_8px)] z-[35] flex justify-center px-4"
    >
      {v ? (
        <div
          key="card"
          className={`${leaving ? "t-exit" : "t-materialize"} pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-2xl bg-card shadow-float md:w-[380px] md:max-w-none`}
          data-kind={v.kind}
        >
          <button
            type="button"
            className="absolute inset-0 z-0 rounded-2xl transition-colors hover:bg-[var(--hover-wash)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${v.text}. Open Deposit`}
            onClick={() => tap(v)}
            disabled={leaving}
          />
          <div className="pointer-events-none relative z-10 flex items-start gap-3 py-3 pl-3 pr-2">
            <TokenMark view={v} />
            <div key={v.kind} className="t-swap-in min-w-0 flex-1 pt-px">
              <div className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                {v.alert ? <Icon name="alert" size={14} className={`-mt-0.5 mr-1 inline-block ${alertTone(v)}`} /> : null}
                <Title view={v} />
              </div>
              {v.sub ? <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{v.sub}</div> : null}
              {v.action ? (
                <Button variant="primary" size="sm" className="pointer-events-auto mt-2" onClick={moveNow} disabled={leaving}>{v.action}</Button>
              ) : null}
            </div>
            {v.live || v.check ? <span className="grid h-9 w-6 shrink-0 place-items-center"><Mark view={v} /></span> : null}
            {/* Every state has its ×: a box that cannot be closed must never be the thing between a customer and a control. */}
            <button
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => close(v)}
              disabled={leaving}
              className="ff-press pointer-events-auto -my-1 grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:size-9"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
