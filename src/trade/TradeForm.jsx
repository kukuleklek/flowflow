import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AutoHeight, AnimatedNumber, IconSwap, ShimmerText, SuccessCheck, TextSwap } from "../ui/kit/index.ts";
import Button from "../ui/Button.jsx";
import Icon, { Spinner } from "../ui/Icon.jsx";
import Seg from "../ui/Seg.jsx";
import Switch from "../ui/Switch.jsx";
import TickNumber from "../ui/TickNumber.jsx";
import Tip from "../ui/Tip.jsx";
import { minus } from "../ui/num.js";
import ConnectCard from "../auth/ConnectCard.jsx";
import { useWallet } from "../context/WalletContext.jsx";
import { toast } from "../ui/toast.jsx";
import { useBackend } from "../perp/BackendContext.jsx";
import { perpStorage } from "../perp/live/storage.js";
import { sanitizeAmountInput, parseUsdAmount } from "../perp/perpTicket.js";
import {
  balanceView, amountPresetView, fillView, tradeErrorView, usdcNumber, perpCoinLabel,
  readLeverageMemory, writeLeverageMemory, leverageMarks, TP_ROE_CHIPS, SL_ROE_CHIPS,
} from "../perp/live/perpLiveView.js";
import { useOrderQuote } from "./useOrderQuote.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const FILLED_BEAT_MS = 700; // the kit's success beat: hold the check, then move on
const TICKS = [25, 50, 75];

/** One TP or SL leg, typed as % ROE with quick chips. Three short lines: the label with its
 *  trigger price, the input with the chips, then what it pays if hit (or what is wrong). */
export function Leg({ leg, value, onChange, view }) {
  const tp = leg === "tp";
  const chips = tp ? TP_ROE_CHIPS : SL_ROE_CHIPS;
  const sign = tp ? "+" : "-";
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className={`font-medium ${tp ? "text-success" : "text-destructive"}`}>{tp ? "Take profit" : "Stop loss"}</span>
        <span className={`num font-medium ${view.error ? "text-destructive" : view.empty ? "text-muted-foreground" : "text-foreground"}`}>
          {view.error ? "Check" : view.empty ? "—" : view.triggerText}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <label className="relative shrink-0">
          <input
            inputMode="decimal"
            placeholder={tp ? "+25" : "-10"}
            aria-label={tp ? "Take profit in % ROE" : "Stop loss in % ROE"}
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/[^\d.+-]/g, ""))}
            className="num h-11 w-[104px] rounded-lg bg-input/30 pl-3 pr-12 text-sm outline-none ring-1 ring-inset ring-input transition-[background-color,box-shadow] placeholder:text-muted-foreground/60 focus:bg-card focus:ring-ring focus-visible:outline-none lg:h-8"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">% ROE</span>
        </label>
        <div className="flex min-w-0 gap-1.5">
          {chips.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={value === `${sign}${p}`}
              onClick={() => onChange(`${sign}${p}`)}
              className="ff-press ff-hit num h-7 shrink-0 rounded-md bg-card px-2 text-[11px] font-medium text-muted-foreground ring-1 ring-inset ring-border hover:text-foreground aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:ring-foreground"
            >
              {minus(`${sign}${p}%`)}
            </button>
          ))}
        </div>
      </div>
      {!view.empty ? (
        view.error
          ? <p className="num t-swap-in text-xs text-destructive">{view.error}</p>
          : view.ifHitText ? <p className="font-mono text-[11px] text-muted-foreground">{minus(view.ifHitText)}</p> : null
      ) : null}
    </div>
  );
}

function SummaryRow({ label, children, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`num text-right font-medium ${tone || ""}`}>{children}</dd>
    </div>
  );
}

function FieldHead({ label, aside = null, children }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
      <span className="flex items-center gap-2.5">
        <span className="font-medium text-muted-foreground">{label}</span>
        {aside}
      </span>
      {children}
    </div>
  );
}

export default function TradeForm({ coin, market, side = "buy", stale = false, onNeed = null }) {
  const b = useBackend();
  const w = useWallet();
  const nav = useNavigate();
  const storage = perpStorage();
  const [amountStr, setAmountStr] = useState("");
  const [levPick, setLevPick] = useState(() => readLeverageMemory(storage, coin));
  const [tpslOpen, setTpslOpen] = useState(false);
  const [tpStr, setTpStr] = useState("");
  const [slStr, setSlStr] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | sending | beat | result
  const [result, setResult] = useState(null);
  const [signIn, setSignIn] = useState(false);
  const sending = useRef(false);
  const card = useRef(null);
  const priorSz = useRef(0);
  const sentAdding = useRef(false);

  useEffect(() => { setLevPick(readLeverageMemory(storage, coin)); }, [coin]); // eslint-disable-line react-hooks/exhaustive-deps

  const buy = side === "buy";
  const Side = buy ? "Long" : "Short";
  const ticker = perpCoinLabel(coin, market);
  const amount = parseUsdAmount(amountStr);
  const account = b.account || {};
  const q = useOrderQuote(b, { coin, market, side, amount, leverage: levPick, tpStr, slStr, withLegs: tpslOpen, stale });
  const { leverage, maxLev, sz, isStale, limits, maxMargin, quote, risk, tpView, slView, tp, sl, overCap, overMax, blocker, ready, adding } = q;
  const presets = amountPresetView({ maxMarginUsdc: maxMargin, leverage });

  const pct = maxMargin && amount != null ? Math.max(0, Math.min(100, Math.round((amount / maxMargin) * 100))) : 0;

  const reset = () => {
    setResult(null);
    setPhase("idle");
    setAmountStr("");
  };

  const shake = () => {
    const el = card.current;
    if (!el) return;
    el.classList.remove("is-shaking");
    void el.offsetWidth;
    el.classList.add("is-shaking");
  };

  const confirm = async () => {
    if (sending.current || !ready) return;
    sending.current = true;
    setPhase("sending");
    const held = account.positions && account.positions.byCoin ? account.positions.byCoin[coin] : null;
    priorSz.current = held && fin(held.szi) ? Math.abs(held.szi) : 0;
    if (!adding) writeLeverageMemory(storage, coin, leverage);
    sentAdding.current = adding;
    let r;
    try {
      r = adding
        ? await b.addMarket({ coin, marginUsdc: amount })
        : await b.openMarket({ coin, side, marginUsdc: amount, leverage, tp, sl });
    } catch (e) {
      r = { ok: false, code: "unexpected", message: `Something went wrong and nothing was confirmed: ${String((e && e.message) || e)}` };
    }
    sending.current = false;
    r = r || { ok: false, code: "unexpected", message: "No answer. Check your position before trying again." };
    setResult(r);
    if (r.ok) {
      setPhase("beat");
      setTimeout(() => setPhase("result"), FILLED_BEAT_MS);
    } else {
      setPhase("result");
      shake();
      toast({ title: tradeErrorView(r).title, text: r.message || null, tone: "error" });
    }
  };

  /* A fill tells the toast once, from the account's own figures as they arrive. */
  const toldFill = useRef(null);
  const held = account.positions && account.positions.answered === true && account.positions.byCoin ? account.positions.byCoin[coin] || null : null;
  const filledView = phase === "result" && result && result.ok
    ? fillView(result, { position: held, fills: account.fills || null, priorSz: priorSz.current, szDecimals: sz, adding: sentAdding.current })
    : null;
  useEffect(() => {
    if (!filledView || toldFill.current === result) return;
    toldFill.current = result;
    toast({ title: filledView.title, text: filledView.fillText || null, tone: "success" });
  }, [filledView, result]);

  /* ── the action at the bottom ── */
  const bal = balanceView(account.perpBalanceUsdc);
  let action;
  if (!b.connected) {
    /* While a session is arriving (useWallet().pending) the CTA says so instead of offering Sign in again. */
    action = signIn
      ? <div key="signin" className="t-swap-in rounded-xl bg-background p-4 ring-1 ring-inset ring-border"><ConnectCard start="list" bare onDone={() => setSignIn(false)} /></div>
      : w.pending
        ? (
          <div key="signin-pending" role="status" className="t-swap-in flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-card text-sm font-medium text-muted-foreground ring-1 ring-inset ring-border lg:h-11">
            <Spinner size={16} /> <ShimmerText text={w.pending === "wallet" ? "Setting up your wallet…" : "Signing you in…"} />
          </div>
        )
        : <Button key="signin-btn" variant="primary" size="xl" className="t-swap-in w-full" onClick={() => setSignIn(true)}>Sign in to trade</Button>;
  } else if (b.support && b.support.ok === false) {
    action = (
      <p className="flex w-fit max-w-full items-start gap-2 rounded-lg bg-warning/[.06] px-3 py-2.5 text-xs text-warning ring-1 ring-inset ring-warning/[.22]">
        <Icon name="alert" size={14} className="mt-px shrink-0" />
        <span>{b.support.message}</span>
      </p>
    );
  } else if (!b.mock && bal.known && account.perpBalanceUsdc && account.perpBalanceUsdc.reason === "new-account") {
    action = (
      <Button variant="brand" size="xl" className="w-full" onClick={() => (onNeed ? onNeed("deposit") : nav("/wallet?panel=deposit"))}>
        Deposit USDC to trade
      </Button>
    );
  } else if (!b.trading || !b.trading.enabled) {
    action = (
      <div className="space-y-2">
        <Button variant="primary" size="xl" className="w-full" onClick={() => b.enableTrading()}>
          <Icon name="key" size={18} /> Enable trading
        </Button>
        <div className="flex justify-center">
          <Tip label="How it works">One signature in your wallet, then trades need no popup.</Tip>
        </div>
      </div>
    );
  } else if (phase === "result" && result && result.ok && filledView) {
    action = (
      <div key="filled" className="t-swap-in space-y-4">
        <div className="flex items-center gap-2.5">
          <SuccessCheck size={22} className="shrink-0 text-success" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{filledView.title}</div>
            {filledView.fillText ? <div className="num text-xs text-muted-foreground">{filledView.fillText}</div> : null}
          </div>
        </div>
        <dl className="space-y-2 border-y border-hairline py-3 text-xs">
          {filledView.rows.map((r) => (
            <SummaryRow key={r.key} label={r.label} tone={r.tone === "pos" ? "text-success" : r.tone === "neg" ? "text-destructive" : r.key === "liq" ? "text-warning" : ""}>
              {r.settling ? <span className="skeleton-shimmer inline-block h-3.5 w-16 rounded align-middle" /> : minus(`${r.text}${r.unit === "usdc" ? " USDC" : ""}`)}
            </SummaryRow>
          ))}
        </dl>
        {filledView.cardLines.length ? <p className="text-xs text-muted-foreground">{filledView.cardLines.join(" · ")}</p> : null}
        <Button variant="outline" size="lg" className="w-full" onClick={reset}>{filledView.moreLabel || "Trade again"}</Button>
      </div>
    );
  } else if (phase === "result" && result && !result.ok) {
    const err = tradeErrorView(result);
    action = (
      <div key="err" className="t-swap-in space-y-3" aria-live="polite">
        <div className="flex items-start gap-2 text-destructive">
          <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-medium">{err.title}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{err.text}</p>
          </div>
        </div>
        <Button variant="outline" size="lg" className="w-full" onClick={() => {
          if (err.next === "deposit") nav("/wallet?panel=deposit");
          else if (err.next === "enable") b.enableTrading();
          else { setResult(null); setPhase("idle"); }
        }}>
          {err.next === "deposit" ? "Deposit USDC" : err.next === "enable" ? "Enable trading" : err.next === "positions" ? "Check your position" : "Try again"}
        </Button>
      </div>
    );
  } else {
    const iconState = phase === "sending" ? "b" : phase === "beat" ? "c" : "a";
    const label = phase === "sending" ? "Placing…" : phase === "beat" ? "Filled" : adding ? `Add to ${Side.toLowerCase()} ${ticker}` : `${Side} ${ticker}`;
    action = (
      <div key="cta">
        <Button
          variant={buy ? "long" : "short"}
          size="xl"
          className="w-full"
          disabled={!ready && phase === "idle"}
          aria-busy={phase !== "idle"}
          onClick={confirm}
        >
          <IconSwap
            state={iconState}
            a={<Icon name={buy ? "arrowUpRight" : "arrowDown"} size={18} />}
            b={<Spinner size={18} />}
            c={<Icon name="check" size={18} strokeWidth={2.4} />}
          />
          <TextSwap text={label} />
        </Button>
        {blocker && amount != null && phase === "idle" ? (
          <p className={`t-swap-in mt-2 text-center text-xs ${overMax || overCap || isStale ? "text-destructive" : "text-muted-foreground"}`}>{blocker}</p>
        ) : null}
      </div>
    );
  }

  const filled = phase === "result" && result && result.ok;
  const liq = `${risk.liqText}${risk.liqPctText ? ` ${risk.liqPctText}` : ""}`;

  return (
    <div ref={card} className="ff-shake">
      <AutoHeight>
        <div className="space-y-4">
          {!filled ? (
            <>
              <div>
                <FieldHead
                  label="Margin"
                  aside={b.mock ? <Tip label="Mock" align="start">Mock account on live prices. No real order is sent.</Tip> : null}
                >
                  <span className="text-muted-foreground">
                    Available <TickNumber value={limits.answered ? usdcNumber(limits.availableUsdc) : "—"} className="num font-medium text-foreground" /> USDC
                  </span>
                </FieldHead>
                <label className="flex h-14 items-center gap-2 rounded-xl bg-input/30 pl-3.5 pr-2 ring-1 ring-inset ring-input transition-[background-color,box-shadow] focus-within:bg-card focus-within:shadow-halo focus-within:ring-ring">
                  <input
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    aria-label="Margin in USDC"
                    value={amountStr}
                    disabled={phase !== "idle"}
                    onChange={(e) => setAmountStr(sanitizeAmountInput(e.target.value))}
                    className="num h-full min-w-0 flex-1 bg-transparent text-2xl font-semibold tracking-[-0.02em] outline-none placeholder:text-muted-foreground/60 focus-visible:outline-none"
                  />
                  <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 text-sm font-medium">
                    <img src="/tokens/usdc.svg" alt="" className="size-6 rounded-full" />USDC
                  </span>
                </label>
                <div className="mt-4 flex items-center gap-3">
                  <div className="relative flex-1">
                    <div aria-hidden="true" className="pointer-events-none absolute inset-x-[7px] top-1/2 -translate-y-1/2">
                      {TICKS.map((t) => (
                        <span key={t} className="absolute h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-input" style={{ left: `${t}%` }} />
                      ))}
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={pct}
                      disabled={!maxMargin || phase !== "idle"}
                      aria-label="Margin as a share of what you can use"
                      onChange={(e) => {
                        const p = Number(e.target.value);
                        if (maxMargin) setAmountStr(p === 0 ? "" : String(Math.floor(maxMargin * p) / 100));
                      }}
                      className="ff-range relative block"
                      style={{ "--pct": `${pct}%` }}
                    />
                  </div>
                  <span className="w-10 text-right font-mono text-xs text-muted-foreground">{pct}%</span>
                </div>
                <div className="mt-3 grid grid-cols-5 gap-1.5">
                  {presets.map((p) => (
                    <button
                      key={p.kind === "max" ? "max" : p.value}
                      type="button"
                      disabled={p.disabled || phase !== "idle"}
                      aria-pressed={p.value != null && amount === p.value}
                      onClick={() => { if (p.value != null) setAmountStr(String(Math.floor(p.value * 100) / 100)); }}
                      className="ff-press ff-hit num h-8 rounded-md bg-card text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border hover:text-foreground disabled:opacity-45 aria-pressed:text-foreground aria-pressed:ring-brand"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {adding ? (
                <div className="t-swap-in flex items-center justify-between gap-3 border-t border-hairline pt-3 text-xs">
                  <span className={`font-medium ${buy ? "text-success" : "text-destructive"}`}>Adding to your {Side.toLowerCase()}</span>
                  <span className="num text-muted-foreground">{leverage ?? "—"}x · TP / SL stay as set</span>
                </div>
              ) : null}
              <div className={adding ? "hidden" : ""}>
                <FieldHead label="Leverage">
                  <span className="font-mono text-[11px] text-muted-foreground">Max {maxLev ?? "—"}x</span>
                </FieldHead>
                {market ? (
                  <Seg
                    label="Leverage"
                    full
                    size="md"
                    value={leverage}
                    onChange={(v) => setLevPick(v)}
                    items={leverageMarks(maxLev).map((n) => ({ value: n, label: `${n}x` }))}
                  />
                ) : <div className="skeleton-shimmer h-11 rounded-lg lg:h-9" />}
              </div>

              <div className={adding ? "hidden" : ""}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Take profit / Stop loss</span>
                  <Switch checked={tpslOpen} onChange={setTpslOpen} label="Take profit and stop loss" aria-expanded={tpslOpen} />
                </div>
                <AutoHeight>
                  {tpslOpen ? (
                    <div key="legs" className="t-swap-in mt-3 space-y-4">
                      <Leg leg="tp" value={tpStr} onChange={setTpStr} view={tpView} />
                      <Leg leg="sl" value={slStr} onChange={setSlStr} view={slView} />
                    </div>
                  ) : <div key="none" />}
                </AutoHeight>
              </div>

              <dl className="space-y-2 border-t border-hairline pt-4 text-xs">
                <SummaryRow label="Size"><AnimatedNumber value={risk.sizeText} /></SummaryRow>
                <SummaryRow label="Liq. price" tone="text-warning"><AnimatedNumber value={minus(liq)} /></SummaryRow>
                <SummaryRow label="Max loss">{risk.maxLossText}{risk.maxLossPctText ? ` ${minus(risk.maxLossPctText)}` : ""}</SummaryRow>
                <SummaryRow label="Fee">{risk.feeText}</SummaryRow>
              </dl>
            </>
          ) : null}

          <div className="lg:sticky lg:bottom-0 lg:z-[2] lg:-mb-5 lg:bg-card lg:pb-5">
            {action}
          </div>
        </div>
      </AutoHeight>
    </div>
  );
}
