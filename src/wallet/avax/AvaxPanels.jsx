/* The Spot Account's money panels — Move in, Move out, Stake, Unstake, Swap — opened in place inside the Spot Account
   card, the way the Main Account card opens Deposit / Withdraw (same header, numbered steps on hairlines, amount box,
   review rows, one CTA). Each one is REVIEW → CONFIRM → RUN over useAvaxAction(kind) (src/avax/useAvaxMoney.js), which
   prices with src/avax/money.js and signs ONLY through the visible Privy windows of src/avax/signers.js.

   🔴 MONEY RULES THIS FILE KEEPS
   1. NOTHING HERE BUILDS, SIGNS OR SENDS. The panel holds an amount (and, for a swap, two whitelist symbols) and asks
      the hook to price them. There is no recipient field and no address anywhere: every move goes to the customer's
      own embedded address, which money.js takes from the signers and nothing else.
   2. EVERY FIGURE IS ON SCREEN BEFORE CONFIRM. The review's rows are drawn as money.js wrote them (what leaves, each
      fee, the gas row in the owner's words "includes ≈0.0208 AVAX for gas (≈$0.20)", what arrives, the minimum, the
      windows). Unknown is "—" and then there is NO Confirm (panelView.confirmGate). Figures are drawn plainly, never
      through an animation that would show the old number for a moment after a re-quote.
   3. CONFIRM IS ONE TAP ON WHAT IS SHOWN. The tap calls the hook's confirm(), whose first act is the synchronous
      registry.confirm — a second tap, a re-render or a second panel can never start a second run. A worse price at
      Confirm comes back as a new review to confirm again; nothing was signed.
   4. NO "TRY AGAIN" AFTER MONEY MAY HAVE LEFT. Only an outcome that says nothing moved offers "Review again"; an
      unknown one says "Not sure yet — we're checking. Don't send again." and where to look, and offers nothing else.
      An expired price (nothing signed) is priced again by itself and shown before anything can be confirmed.
   5. BEHIND THE BUILD FLAG — EXCEPT THE EXITS. Move in, Stake and a swap into anything open only when VITE_EARN=on;
      Move out, Unstake and a swap back to USDC are never behind it (plan §3.3, panelView rule 5). A mock account gets
      the panel's shape with everything disabled and a "Live only" Tip. */
import { useEffect, useRef, useState } from "react";
import { IconSwap, ShimmerText, SuccessCheck, TextSwap, rise } from "../../ui/kit/index.ts";
import Button, { IconButton } from "../../ui/Button.jsx";
import Icon, { Spinner } from "../../ui/Icon.jsx";
import Tip from "../../ui/Tip.jsx";
import { MarkDisc, ImgDisc, TokenDisc } from "../TotalBalance.jsx";
import { usdText, pctText } from "../portfolio.js";
import { useAvaxAction } from "../../avax/useAvaxMoney.js";
import { resolveCaps } from "../../avax/money.js";
import { whitelistAssets, assetBySymbol } from "../../lib/avax/whitelist.js";
import {
  PANEL_COPY, howItWorks, typedAmount, maxFor, priceArgs, reviewLines, windowsLine, whyTone, confirmGate,
  stageMark, stageIsWindow, outcomeView,
} from "./panelView.js";
import { panelPreview } from "./panelPreview.js";

/* The caps in force for this build (env may only lower them): the same rule money.js prices with. */
const CAPS = resolveCaps(import.meta.env);
const fin = (v) => typeof v === "number" && Number.isFinite(v);

const CHIP = "ff-press ff-hit inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-card px-3 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border hover:text-foreground disabled:opacity-45 aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:ring-foreground";
const RISK = "flex w-fit max-w-full items-start gap-2 rounded-lg bg-warning/[.06] px-3 py-2.5 text-xs text-warning ring-1 ring-inset ring-warning/[.22]";
const AMOUNT = "flex h-14 items-center gap-2 rounded-xl bg-input/30 px-3.5 ring-1 ring-inset ring-input transition-[background-color,box-shadow] focus-within:bg-card focus-within:shadow-halo focus-within:ring-ring";
const AMOUNT_INPUT = "num h-full min-w-0 flex-1 bg-transparent text-2xl font-semibold tracking-[-0.02em] outline-none placeholder:text-muted-foreground/60 focus-visible:outline-none disabled:opacity-60";
const HINT_BTN = "ff-hit text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none";

/** A numbered step: hairline, mono index, 14/500 title, optional right-hand control (WithdrawPanel's own). */
function StepHead({ n, children, right = null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-hairline pt-4">
      <span className="flex items-baseline gap-2.5"><span className="font-mono text-[11px] text-ink-dim">{n}</span><span className="text-sm font-medium">{children}</span></span>
      {right}
    </div>
  );
}

/** The panel's head: the mark (Avalanche, or USDC on Avalanche for the staked USDC — the owner's only-Avax-logo rule),
 *  the title, the two places it joins, close. */
function PanelHead({ kind, onClose, closeDisabled, mock, sub = null }) {
  const c = PANEL_COPY[kind];
  return (
    <div className="t-swap-in flex h-16 items-center gap-3">
      {c.mark === "usdc" ? <TokenDisc token="USDC" chain="Avalanche" size={32} /> : <MarkDisc name="avalanche" size={32} />}
      <div className="min-w-0 flex-1">
        <h2 className="text-h2 leading-tight">{c.title}</h2>
        <div className="truncate text-xs text-muted-foreground">{sub || (c.from ? `${c.from} → ${c.to}` : "In your Spot Account")}</div>
      </div>
      {mock ? <Tip label="Live only" align="end" title="Why this is off">The mock account has no wallet on any chain. Moves, swaps and staking run on a live account.</Tip> : null}
      <IconButton className="-mr-2.5" label={`Close ${c.title.toLowerCase()}`} onClick={onClose} disabled={closeDisabled}><Icon name="x" size={18} /></IconButton>
    </div>
  );
}

/** The panel's one quiet line: the stake's live rate, else the cap in force (env may only lower it). No vendor names
 *  or marks (owner: only the Tokenomist and Avax logos show). */
function InfoLine({ kind, apyPct = null }) {
  if (kind === "stake" || kind === "unstake") {
    return (
      <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {fin(apyPct) ? <span className="num text-success">{pctText(apyPct)} APY</span> : null}
        {fin(apyPct) ? <span aria-hidden="true">·</span> : null}
        <span>{kind === "stake" ? `Up to ${CAPS.stakeUsdc} USDC per stake` : "Variable rate"}</span>
      </span>
    );
  }
  /* A move in's cap bounds what LEAVES the Main Account: its fee and any gas come out of the same 20 USDC. */
  return (
    <span className="num text-xs text-muted-foreground">
      {kind === "swap" ? `Up to $${CAPS.swapUsd} per swap` : kind === "move-in" ? `Up to ${CAPS.moveUsdc} USDC per move, fee and gas included` : `Up to ${CAPS.moveUsdc} USDC per move`}
    </span>
  );
}

/** One review figure: label left, value right, its small note under it. The value is drawn as it is — no swap
 *  animation, so the number on screen is always the one Confirm will act on (rule 2). */
function FigureRow({ line }) {
  const tone = line.tone === "warning" ? "text-warning" : line.tone === "strong" ? "font-medium" : "";
  return (
    <div className="flex items-start justify-between gap-4 border-b border-hairline py-2.5 text-sm">
      <dt className="min-w-0 text-muted-foreground">{line.label}</dt>
      <dd className={`min-w-0 max-w-[62%] text-right ${tone}`}>
        <span key={line.value} className={`t-swap-in block ${line.unknown ? "text-muted-foreground" : ""} ${/\d/.test(line.value) ? "num" : ""}`}>{line.value}</span>
        {line.note ? <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{line.note}</span> : null}
      </dd>
    </div>
  );
}

/** The run's stages: ○ to do · spinner · ✓ · ✗ · ! (not confirmed). */
function Stages({ stages }) {
  if (!Array.isArray(stages) || !stages.length) return null;
  return (
    <ol aria-live="polite">
      {stages.map((s) => {
        const m = stageMark(s.state);
        return (
          <li key={s.key} className="flex min-h-11 items-center gap-3 border-b border-hairline py-2 text-sm">
            <span className="grid size-5 shrink-0 place-items-center">
              {m === "spin" ? <Spinner size={16} />
                : m === "check" ? <SuccessCheck size={18} />
                : m === "fail" ? <Icon name="x" size={16} className="text-destructive" />
                : m === "unknown" ? <Icon name="alert" size={16} className="text-warning" />
                : <span className="size-2.5 rounded-full ring-1 ring-inset ring-border" />}
            </span>
            <span className={`min-w-0 flex-1 ${m === "todo" ? "text-muted-foreground" : ""}`}>{s.label}</span>
            {stageIsWindow(s) ? <span className="shrink-0 text-xs text-muted-foreground">Check your wallet</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Explorer links (Snowtrace for Avalanche txs, Relay for a move). */
function Links({ links }) {
  if (!links || !links.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {links.map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="ff-hit inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline">
          {l.label}
          <Icon name="arrowUpRight" size={12} />
        </a>
      ))}
    </div>
  );
}

/** A printed reason (USER-REQUESTS D2: a blocked card's reason is never folded into a Tip). */
function Why({ why, className = "" }) {
  if (!why) return null;
  const quiet = whyTone(why) === "muted";
  return (
    <p role={quiet ? undefined : "alert"} className={`flex items-start gap-1.5 text-xs ${quiet ? "text-muted-foreground" : "text-destructive"} ${className}`}>
      <Icon name={quiet ? "info" : "alert"} size={14} className="mt-px shrink-0" />
      <span>{why}</span>
    </p>
  );
}

/* ── the panel ────────────────────────────────────────────────────────────── */

/**
 * One Spot Account panel.
 *   kind      "move-in" | "move-out" | "stake" | "unstake" | "swap"
 *   v         usePortfolio()'s view (balances for the hints and Max; never a figure the review uses)
 *   earnOn    the build flag (VITE_EARN === "on")
 *   mock      the mock backend: the panel's shape, everything disabled
 *   initialAmount  a typed amount handed over (the Agent's StakeCard: ?panel=earn&amount=…); never priced by itself
 */
export default function SpotPanel({ kind, v, earnOn, mock, onClose, initialAmount = null }) {
  const live = useAvaxAction(kind);
  /* DEV ONLY: ?ffAvaxPanelPreview= swaps in a sample state whose actions do nothing (panelPreview.js). */
  const sample = import.meta.env.DEV ? panelPreview(kind) : null;
  const a = sample || live;
  const isSwap = kind === "swap";

  const [amountStr, setAmountStr] = useState(() => (typeof initialAmount === "string" ? typedAmount(initialAmount, 6) : ""));
  /* With the flag off a swap is only ever the exit: something you hold, back to USDC (rule 5). */
  const exitOnlySwap = isSwap && !earnOn;
  const [from, setFrom] = useState(exitOnlySwap ? "BTC.b" : "USDC");
  const [to, setTo] = useState(exitOnlySwap ? "USDC" : "BTC.b");
  const [notice, setNotice] = useState(null);
  const lastArgs = useRef(null);
  const handled = useRef(null);

  /* Closing the panel (or leaving the page) closes a card that was only being read; a run is never touched. */
  const closeRef = useRef(a.close);
  closeRef.current = a.close;
  useEffect(() => () => { try { closeRef.current(); } catch { /* nothing to close */ } }, []);

  /* What the panel shows next to the amount (never a figure the review uses: those come from money.js). */
  const assets = Array.isArray(v && v.assets) ? v.assets : [];
  const row = (sym) => assets.find((x) => x.symbol === sym) || null;
  const usdc = row("USDC");
  const spotUsdc = usdc && usdc.status !== "unknown" && fin(usdc.amount) ? usdc.amount : null;
  const stakedUsdc = v && v.aave && v.aave.status === "ok" && fin(v.aave.suppliedUsdc) ? v.aave.suppliedUsdc : null;
  const mainFree = v && v.perp && fin(v.perp.freeUsd) ? v.perp.freeUsd : null;
  const apyPct = v && v.aave ? v.aave.apyPct : null;
  const fromAsset = isSwap ? assetBySymbol(from) : assetBySymbol("USDC");
  const fromRow = row(isSwap ? from : "USDC");
  const decimals = fromAsset ? fromAsset.decimals : 6;
  const max = maxFor(kind, {
    spotUsdc, stakedUsdc, caps: CAPS,
    from: fromRow && fromAsset ? { amount: fromRow.status === "unknown" ? null : fromRow.amount, price: fromRow.price, peg: fromAsset.peg, decimals } : null,
  });

  const args = priceArgs(kind, { amount: amountStr, from, to });
  const ph = a.phase;
  /* A second confirm of the same card comes back as "already started" with phase "running": that is not this panel's
     run, so it may be closed (the first run goes on, watched). */
  const already = !!(a.outcome && a.outcome.alreadyRun);
  const running = ph === "running" && !already;
  /* An exit panel (Move out, Unstake, a swap to USDC) never waits for the build flag (rule 5). */
  const exitPanel = kind === "move-out" || kind === "unstake" || exitOnlySwap;
  const off = mock || (!earnOn && !exitPanel);
  const notReady = !off && !a.ready ? a.why || "Your wallet is still loading" : null;
  const canReview = !off && a.ready && !!args && ph !== "pricing" && !running;
  const gate = confirmGate({ earnOn, mock, action: a, kind });
  const view = outcomeView({ kind, phase: ph, outcome: a.outcome, note: a.note });

  /* "Price expired. Nothing moved." (or the network fee moved) before anything was signed: price it again by itself,
     and say so above the new figures. Once per outcome. */
  useEffect(() => {
    if (ph !== "failed" || !a.outcome || handled.current === a.outcome) return;
    handled.current = a.outcome;
    if (!view.requote || !lastArgs.current) return;
    setNotice(a.outcome.message || "Price expired. Nothing moved.");
    a.price(lastArgs.current);
  }, [ph, a.outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  const askPrice = (x) => {
    if (!x) return;
    lastArgs.current = x;
    a.price(x);
  };
  const doReview = () => { if (canReview) { setNotice(null); askPrice(args); } };
  /* The tap names the review it was drawn with: a refresh that landed after the paint is never what it confirms. */
  const doConfirm = () => { if (gate.enabled) { setNotice(null); a.confirm(a.review); } };
  const doEdit = () => { if (!running) { setNotice(null); a.close(); } };
  const doClose = () => { if (!running) { a.close(); onClose(); } };

  const header = <PanelHead kind={kind} onClose={doClose} closeDisabled={running} mock={mock} sub={isSwap ? `${from} → ${to} · in your Spot Account` : null} />;

  /* ── run, and what happened ─────────────────────────────────────────────── */
  const lines = reviewLines(a.review);
  const summary = lines.filter((l) => l.key === "amount" || l.key === "receive" || l.key === "debit");

  /* An expired price is being priced again (the effect above): the review's place shows that, never the form. */
  const repricing = (ph === "pricing" && !!notice) || (ph === "failed" && view.requote && !!lastArgs.current);
  if (a.review && !repricing && (ph === "running" || ph === "arriving" || ph === "done" || ph === "refunded" || ph === "unknown" || (ph === "failed" && view.tone !== null))) {
    const done = ph === "done";
    return (
      <div aria-live="polite">
        {header}
        <div className="space-y-4">
          <dl className="t-swap-in border-t border-hairline">{summary.map((l) => <FigureRow key={l.key} line={l} />)}</dl>

          {view.tone === "done" || view.tone === "refunded" ? (
            <div className="t-swap-in flex items-start gap-3">
              <span className="grid size-6 shrink-0 place-items-center">{done ? <SuccessCheck size={24} /> : <Icon name="info" size={20} />}</span>
              <div className="min-w-0">
                <div className="text-sm font-medium">{view.title}</div>
                {view.receipt ? <div className="num mt-0.5 text-xs text-muted-foreground">{view.receipt}</div> : null}
              </div>
            </div>
          ) : null}

          {view.tone === "unknown" ? (
            <div className="t-swap-in space-y-2">
              <p className={RISK} role="alert">
                <Icon name="alert" size={14} className="mt-px shrink-0" />
                <span><span className="font-medium">{view.title}</span> {view.where}</span>
              </p>
              {view.message ? <p className="text-xs text-muted-foreground">{view.message}</p> : null}
            </div>
          ) : null}

          {view.tone === "failed" ? <Why why={view.title} /> : null}
          {already ? <p className="text-xs text-muted-foreground">{a.outcome.message || "This move already started. It is never sent twice."}</p> : null}

          {done ? null : <Stages stages={a.progress} />}
          {view.tone === "arriving" && view.message ? <p className="text-xs text-muted-foreground">{view.message}</p> : null}
          <Links links={view.links} />

          {running ? null : view.tone === "failed" ? (
            <div className="flex items-center gap-2">
              <Button variant="primary" size="lg" className="flex-1" onClick={() => askPrice(lastArgs.current)} disabled={!lastArgs.current || !a.ready}>Review again</Button>
              <Button variant="ghost" size="lg" onClick={doEdit}>Edit</Button>
            </div>
          ) : (
            <Button variant={done ? "primary" : "outline"} size="lg" className="w-full" onClick={doClose}>{done ? "Done" : "Close"}</Button>
          )}
          {view.tone === "arriving" || view.tone === "unknown" ? (
            <div className="!mt-2 flex justify-center"><Tip label="Closing is safe" align="center">It keeps being watched after you close this, and it is never sent twice.</Tip></div>
          ) : null}
        </div>
      </div>
    );
  }

  /* ── the review ─────────────────────────────────────────────────────────── */
  const requoted = ph === "review" && a.outcome && a.outcome.needsConfirm ? a.outcome.message : null;
  if ((ph === "review" && a.review) || repricing) {
    const r = ph === "review" ? a.review : null;
    const windows = r ? windowsLine(r.windows) : null;
    return (
      <div>
        {header}
        <div className="space-y-4">
          <StepHead n={isSwap ? "03" : "02"}>Review</StepHead>
          {notice || requoted ? <p className="t-swap-in text-xs text-warning">{notice || requoted}</p> : null}
          {r ? (
            <dl className="t-swap-in border-t border-hairline">{lines.map((l) => <FigureRow key={l.key} line={l} />)}</dl>
          ) : (
            <div className="space-y-3 border-y border-hairline py-3"><ShimmerText text="Getting a new price…" className="text-xs" /></div>
          )}
          {r && r.warnings.length ? (
            <div className="space-y-2">
              {r.warnings.map((w) => <p key={w} className={RISK}><Icon name="alert" size={14} className="mt-px shrink-0" /><span>{w}</span></p>)}
            </div>
          ) : null}
          <Why why={gate.why} />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{windows || "—"}</span>
            <Tip label="How it works" align="end">{howItWorks(kind, r)}</Tip>
          </div>
          <Button variant="brand" size="xl" className="w-full" onClick={doConfirm} disabled={!gate.enabled} aria-busy={repricing}>
            <IconSwap state={repricing ? "b" : "a"} a={<Icon name="check" size={16} />} b={<Spinner size={16} />} />
            <TextSwap text={repricing ? "Getting a new price…" : "Confirm"} />
          </Button>
          <Button variant="ghost" size="sm" className="!mt-2 w-full" onClick={doEdit}>Edit</Button>
        </div>
      </div>
    );
  }

  /* ── the form ───────────────────────────────────────────────────────────── */
  const disabled = off;
  const priceErr = ph === "failed" && !a.review && a.outcome ? a.outcome.message : null;

  let hint = null;
  if (kind === "move-in") {
    hint = <span className="text-xs text-muted-foreground">Available <span className="num text-foreground">{usdText(mainFree)}</span></span>;
  } else {
    const held = kind === "unstake" ? (stakedUsdc == null ? "—" : stakedUsdc.toLocaleString("en-US", { maximumFractionDigits: 6 }))
      : fromRow ? fromRow.amountText : "—";
    const word = kind === "unstake" ? "Staked" : isSwap ? "Held" : "In Spot Account";
    const sym = isSwap ? from : "USDC";
    hint = (
      <button type="button" className={HINT_BTN} disabled={disabled || !max} onClick={() => max && setAmountStr(max)}>
        {word} <span className="num text-foreground">{held === "—" ? "—" : `${held} ${sym}`}</span>{max ? (kind === "unstake" ? " · All" : " · Max") : null}
      </button>
    );
  }

  const tokenPill = (sym) => {
    const r = row(sym);
    return (
      <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 text-sm font-medium">
        <ImgDisc src={r ? r.logo : null} label={sym} size={24} />{sym}
      </span>
    );
  };

  const amountBox = (
    <div>
      <label className={AMOUNT}>
        <input
          inputMode="decimal" placeholder="0.00" aria-label={`Amount in ${isSwap ? from : "USDC"}`} disabled={disabled}
          value={amountStr === "all" ? "All" : amountStr}
          onChange={(e) => { setAmountStr(typedAmount(e.target.value, decimals)); if (ph === "failed") a.close(); }}
          className={AMOUNT_INPUT}
        />
        {tokenPill(isSwap ? from : "USDC")}
      </label>
      {kind === "unstake" && amountStr === "all" ? <p className="mt-1.5 text-xs text-muted-foreground">Everything in Aave, with interest to the second.</p> : null}
    </div>
  );

  /* The swap's coins: the whitelist only (from: every ERC-20 — swaps from AVAX open later, AVAX pays the gas). */
  const list = whitelistAssets();
  const pick = (sym, side) => {
    if (exitOnlySwap && (side === "to" || sym === "USDC")) return;
    if (side === "from") { setFrom(sym); if (sym === to) setTo(from === sym ? "USDC" : from); setAmountStr(""); }
    else setTo(sym);
    if (ph === "failed") a.close();
  };
  const coinChips = (side) => (
    <div className="no-scrollbar -mx-gutter !mt-2.5 flex gap-1.5 overflow-x-auto px-gutter py-1.5 md:-mx-1 md:px-1">
      {list.filter((x) => (exitOnlySwap ? (side === "from" ? !x.native && x.symbol !== "USDC" : x.symbol === "USDC") : side === "from" ? !x.native : x.symbol !== from)).map((x, i) => {
        const ri = rise(i);
        const on = side === "from" ? x.symbol === from : x.symbol === to;
        const r = row(x.symbol);
        return (
          <button key={x.symbol} type="button" aria-pressed={on} disabled={disabled} onClick={() => pick(x.symbol, side)} className={`${ri.className} ${CHIP}`} style={ri.style}>
            <ImgDisc src={r ? r.logo : null} label={x.symbol} size={16} />{x.symbol}
          </button>
        );
      })}
    </div>
  );
  const toAsset = isSwap ? assetBySymbol(to) : null;
  const flip = isSwap && !exitOnlySwap && toAsset && !toAsset.native ? (
    <button type="button" className={HINT_BTN} disabled={disabled} onClick={() => { const f = from; setFrom(to); setTo(f); setAmountStr(""); }}>
      <span className="inline-flex items-center gap-1"><Icon name="arrowDown" size={12} />Flip</span>
    </button>
  ) : null;

  return (
    <div>
      {header}
      <div className="space-y-4">
        {isSwap ? (
          <>
            <StepHead n="01" right={hint}>From</StepHead>
            {coinChips("from")}
            {amountBox}
            <StepHead n="02" right={flip}>To</StepHead>
            {coinChips("to")}
            {toAsset && toAsset.tip ? <p className={RISK}><Icon name="alert" size={14} className="mt-px shrink-0" /><span>{toAsset.tip}</span></p> : null}
          </>
        ) : (
          <>
            <StepHead n="01" right={hint}>Amount</StepHead>
            {amountBox}
          </>
        )}
        <div className="flex min-h-[44px] items-center border-y border-hairline py-2.5">
          <InfoLine kind={kind} apyPct={apyPct} />
        </div>
        <Why why={mock ? null : off ? "Opens after the live test" : notReady} />
        {priceErr ? <Why why={priceErr} /> : null}
        <Button variant="primary" size="xl" className="w-full" onClick={doReview} disabled={!canReview} aria-busy={ph === "pricing"}>
          <IconSwap state={ph === "pricing" ? "b" : "a"} a={<Icon name="chevronRight" size={16} />} b={<Spinner size={16} />} />
          <TextSwap text={ph === "pricing" ? "Getting a price…" : "Review"} />
        </Button>
        {mock ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="info" size={14} />Live accounts only</p> : null}
      </div>
    </div>
  );
}
