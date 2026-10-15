import { useEffect, useReducer, useRef, useState } from "react";
import { keccak256, toUtf8Bytes } from "ethers";
import { IconSwap, ShimmerText, SuccessCheck, TextSwap, rise } from "../ui/kit/index.ts";
import Seg from "../ui/Seg.jsx";
import Button, { IconButton } from "../ui/Button.jsx";
import Icon, { Spinner } from "../ui/Icon.jsx";
import Tip from "../ui/Tip.jsx";
import { ago, usdcExact } from "../lib/format.js";
import { balanceView, withdrawView, usdcNumber } from "../perp/live/perpLiveView.js";
import { perpStorage } from "../perp/live/storage.js";
import { useRelayWithdrawQuote, useWithdrawStatus } from "../perp/live/useRelayWithdraw.js";
import { withdrawSignWords } from "../lib/signCopy.js";
import { customerWords } from "./words.js";
import { countWithdrawOnAvalanche } from "../lib/onchain/countWithdraw.js";
import {
  SHOWN_WITHDRAW_ROUTES, DEFAULT_WITHDRAW_ROUTE_ID, RELAY_MIN_WITHDRAW_USDC, withdrawRouteById, validateWithdrawDestination,
  destinationEnds, recentDestinations, rememberDestination, executeRelayWithdraw, quoteRelayWithdraw, withdrawQuoteFresh,
  inAppWithdrawCaution, sameAddress, quoteActivationUsdc, withdrawMaxUsdc, activationAdjustedUsdc, activationAdjustedText,
} from "../lib/relay/withdraw.js";
import { usePrivateProbe } from "../perp/deposit/usePrivateDeposit.js";
import { usePrivateWithdraw, usePrivateWithdrawLedger, PRIVATE_WITHDRAW_DEPS } from "../perp/withdraw/usePrivateWithdraw.js";
import {
  MODE_NORMAL, MODE_PRIVATE, PRIVATE_SHEET_START, privateSheetReducer, privateToggleShown, privateToggleLabel,
  privateWithdrawPrivacy, privateWithdrawChains, privateWithdrawAmountNote, privateWithdrawAmountFix, privateWithdrawMaxUsdc,
  privateWithdrawAutoAmount, privateWithdrawAdjustedText,
  privateWithdrawableShown, privateWithdrawRows, privateWithdrawDryRows, privateWithdrawActivation, privateWithdrawErrorText,
  privateWithdrawErrorActions, privateWithdrawErrorPlace, privateWithdrawResultView, privateAmountText, journalStateText,
  journalAmountText, journalLeavesUsdc, unsettledBlockText,
  PRIVATE_WITHDRAW_TIP, PRIVATE_WITHDRAW_PREVIEW_NOTE, PRIVATE_FOOTER, PRIVATE_ATTEST, HOW_IT_WORKS,
} from "../perp/withdraw/privateWithdrawView.js";

/* The withdraw (Relay: an authorization, then a sendAsset to the depository the QUOTE names), unchanged in
   its rules: the destination is only ever what the user typed, checked against its EIP-55 checksum; the figures the
   user approved stay on screen through both signatures; an expired quote is re-priced and SHOWN before anything is
   signed; a lost reply is "not confirmed", never "failed". FlowFlow draws it inside the balance band, as three
   numbered steps on hairlines (DESIGN-SPEC §6.5).

   NORMAL | PRIVATE (owner, 2026-10-15), the Deposit's toggle and rules: shown beside the title only when the server's
   probe says Private is on; the sheet opens on Normal; only the customer's tap changes it, and an error never does.
   Normal is the withdrawal above, unchanged (NormalWithdraw is that code, moved; without the toggle its header is the
   same element). Private is perp/withdraw: the address the customer TYPES on Base, Avalanche, Arbitrum or Polygon,
   priced dry while typing, a real one-time address only on their press of "Review withdrawal", ONE visible signature
   on "Confirm and sign", then the follow-up. A private withdrawal that isn't confirmed blocks the next one, in words.

   🔴 ONE TREE. Whatever the private ledger says, the panel returns the SAME NormalWithdraw element on Normal (the
   unsettled note is its `notice` prop, never a wrapper that comes and goes): a wrapper appearing mid-withdrawal would
   remount Normal and drop a Relay withdrawal being signed or followed. */

const keccak = (hex) => keccak256(toUtf8Bytes(hex)).slice(2);
const RELAY_FLOOR = Object.freeze({ usdc: RELAY_MIN_WITHDRAW_USDC, exclusive: false, error: `This route needs at least ${RELAY_MIN_WITHDRAW_USDC} USDC.` });
const NO_QUOTE = Object.freeze({ status: "idle", quote: null, error: null, stale: false, refresh() {} });
const NO_STATUS = Object.freeze({ status: "sending", relayStatus: null, txHashes: [], checkedAt: null });
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* `strong` draws the label as the Deposit draws its "You receive": in the ink, medium. */
function Row({ label, children, tone = "", className = "", strong = false }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 text-sm ${className}`}>
      <dt className={strong ? "font-medium text-foreground" : "text-muted-foreground"}>{label}</dt>
      <dd className={`num text-right ${tone}`}>{children}</dd>
    </div>
  );
}

/** A numbered step: hairline, mono index, 14/500 title, optional right-hand control. */
function StepHead({ n, children, right = null }) {
  /* Step 01's rule continues the account row's rule across the vertical rule at xl: same line (it sits 1px up, on the
     64px header's last pixel row) and the same colour. */
  const first = n === "01";
  return (
    <div className={`flex items-baseline justify-between gap-3 border-t pt-4 ${first ? "-mt-px border-border" : "border-hairline"}`}>
      <span className="flex items-baseline gap-2.5"><span className="font-mono text-[11px] text-ink-dim">{n}</span><span className="text-sm font-medium">{children}</span></span>
      {right}
    </div>
  );
}

/* destinationEnds() hands back { head, middle, tail } (lib/relay/withdraw.js): the ends a reader compares, drawn
   "0x8ba1f1…4dba72". It is an object, so it is never rendered bare. */
function Ends({ address }) {
  const e = destinationEnds(address);
  return <span className="font-mono">{e.head}{e.middle ? "…" : ""}{e.tail}</span>;
}

const CHIP = "ff-press ff-hit inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-card px-3 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border hover:text-foreground disabled:opacity-45 aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:ring-foreground";
const RISK = "flex w-fit max-w-full items-start gap-2 rounded-lg bg-warning/[.06] px-3 py-2.5 text-xs text-warning ring-1 ring-inset ring-warning/[.22]";

/* Today's withdrawal, exactly as it was: the same hooks, the same JSX, the same words. `toggle(locked)` draws the
   Normal | Private switch beside the title (locked while a Relay withdrawal is being signed or followed). `notice` is
   an additive slot under the header (an unsettled private withdrawal's warning); without it nothing moves. */
function NormalWithdraw({ backend: b, onBack, toggle = null, notice = null }) {
  const [routeId, setRouteId] = useState(SHOWN_WITHDRAW_ROUTES[0].id);
  const [amountStr, setAmountStr] = useState("");
  const [toStr, setToStr] = useState("");
  const [stage, setStage] = useState("form"); // form | confirm
  const [phase, setPhase] = useState("idle"); // idle | quoting | sending | done | unknown | error
  const [pending, setPending] = useState(null);
  const [requoted, setRequoted] = useState(false);
  const [result, setResult] = useState(null);
  const [relaySent, setRelaySent] = useState(null);
  const [signing, setSigning] = useState("");
  const [recent, setRecent] = useState([]);
  const sending = useRef(false);

  const account = (b && b.account) || {};
  const bal = balanceView(account.perpBalanceUsdc);
  const mock = !!(b && b.mock);
  const wallet = b && b.address ? b.address : null;
  const route = withdrawRouteById(routeId) || withdrawRouteById(DEFAULT_WITHDRAW_ROUTE_ID);
  const w = withdrawView({ amountStr, withdrawableUsdc: bal.withdrawableUsdc, floor: RELAY_FLOOR });
  const dest = validateWithdrawDestination(toStr, { own: wallet, keccak });
  const recipient = dest.ok ? dest.address : null;
  const selfCaution = inAppWithdrawCaution({ address: recipient, wallet, walletType: b ? b.walletType : null });
  const amountUsdc = num(w.amount != null ? Number(w.amount) : null);
  const signAuthorize = b && typeof b.signRelayAuthorize === "function" ? b.signRelayAuthorize : null;
  const sendDeposit = b && typeof b.sendRelayDeposit === "function" ? b.sendRelayDeposit : null;

  useEffect(() => {
    if (!wallet) return;
    setRecent(recentDestinations(perpStorage(), wallet).filter((a) => !sameAddress(a, wallet)));
  }, [wallet]);

  const quoteAble = !!(!mock && wallet && recipient && amountUsdc && amountUsdc >= RELAY_MIN_WITHDRAW_USDC && stage === "form" && phase === "idle");
  const q = useRelayWithdrawQuote({ user: wallet, recipient, route, amountUsdc, enabled: quoteAble }) || NO_QUOTE;
  const status = useWithdrawStatus({ requestId: relaySent ? relaySent.requestId : null, enabled: !!relaySent }) || NO_STATUS;
  const quoteShown = q.quote && (q.status === "ready" || q.status === "refreshing") ? q.quote : null;
  const sendAble = !mock && !!b && b.connected && (!b.support || b.support.ok !== false) && !!recipient && !!amountUsdc && !!signAuthorize && !!sendDeposit;
  /* The quote on screen is for the amount on screen (a lowered or retyped amount waits for its own quote). */
  const quoteForAmount = !!quoteShown && amountUsdc != null && Math.abs(quoteShown.amountUsdc - amountUsdc) < 0.005;
  const canReview = sendAble && quoteForAmount && !w.error;
  /* Hyperliquid's one-time ACTIVATION fee (1 USDC). An account funded through the Arbitrum bridge never paid it on the
     way in, so Hyperliquid takes it on the account's FIRST outbound transfer — this withdrawal — and the account must
     still hold it after the amount leaves ("Insufficient USDC balance for token transfer gas" otherwise). Relay's quote
     already prices it in: what you send minus what arrives minus Relay's fee. Shown as its own printed row (every figure
     the customer pays is shown), and Confirm waits until 1 USDC stays behind. */
  const activation = quoteActivationUsdc(pending);
  const maxWithActivation = activation ? withdrawMaxUsdc(bal.withdrawableUsdc, activation) : null;
  const activationShort = !!activation && pending && bal.withdrawableUsdc != null && bal.withdrawableUsdc - pending.amountUsdc < activation + 0.005;
  const canConfirm = sendAble && !!pending && !activationShort && (phase === "idle" || phase === "error");
  /* The customer needs to know nothing about it (owner, 2026-10-15): once a live quote shows the activation, the amount
     lowers itself so 1 USDC stays behind, with one quiet line; Max leaves it too. Never raised; the fee is still a row. */
  const liveActivation = quoteActivationUsdc(quoteShown);
  const [heldBack, setHeldBack] = useState(0);
  const [adjusted, setAdjusted] = useState(null);
  useEffect(() => {
    if (quoteShown) setHeldBack(liveActivation);
  }, [quoteShown, liveActivation]);
  useEffect(() => {
    if (stage !== "form" || !heldBack) return;
    const to = activationAdjustedUsdc({ amountUsdc, withdrawableUsdc: bal.withdrawableUsdc, activationUsdc: heldBack });
    if (to == null) return;
    setAmountStr(to.toFixed(2));
    setAdjusted({ usdc: to, activation: heldBack });
  }, [stage, heldBack, amountUsdc, bal.withdrawableUsdc]);
  const adjustedLine = adjusted && amountStr === adjusted.usdc.toFixed(2) ? activationAdjustedText(adjusted.usdc, adjusted.activation) : null;

  /* Signed and sent: counted on Avalanche (the server reads it on Hyperliquid first). */
  useEffect(() => {
    if (relaySent && wallet) countWithdrawOnAvalanche(wallet, { chainId: relaySent.route && relaySent.route.chainId });
  }, [relaySent, wallet]);

  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (typeof t === "string" && t.trim()) setToStr(t.trim()); } catch { /* no permission: type it */ }
  };

  const review = () => {
    if (!canReview) return;
    setPending(quoteShown);
    setRequoted(false);
    setResult(null);
    setPhase("idle");
    setStage("confirm");
  };

  const confirm = async () => {
    if (sending.current || !canConfirm) return;
    const quote = pending;
    if (!withdrawQuoteFresh(quote, Date.now())) {
      sending.current = true;
      setPhase("quoting");
      try {
        const fresh = await quoteRelayWithdraw({ user: wallet, recipient: quote.recipient, route, amountUsdc });
        setPending(fresh);
        setRequoted(true);
        setPhase("idle");
      } catch (e) {
        setResult({ ok: false, message: `Couldn't price this withdrawal: ${String((e && e.message) || e)}` });
        setPhase("error");
      } finally {
        sending.current = false;
      }
      return;
    }
    sending.current = true;
    setPhase("sending");
    setSigning("authorize");
    const r = await executeRelayWithdraw({
      quote, amountUsdc: w.amount, signAuthorize, sendDeposit, signWords: withdrawSignWords({ quote }), onPhase: (p) => setSigning(p),
    });
    sending.current = false;
    setSigning("");
    setResult(r);
    if (r.ok) {
      rememberDestination(perpStorage(), wallet, quote.recipient);
      setRelaySent({ requestId: r.requestId, receiveAmount: quote.receiveAmount, route: quote.route, recipient: quote.recipient });
      setPhase("done");
    } else if (r.notConfirmed) {
      setRelaySent({ requestId: r.requestId || quote.requestId || null, receiveAmount: quote.receiveAmount, route: quote.route, recipient: quote.recipient });
      setPhase("unknown");
    } else {
      setPhase("error");
    }
  };

  /* 64px, like the account row beside it at xl, so the first rule continues that row's rule. */
  const modeToggle = toggle ? toggle(phase === "sending" || phase === "quoting" || !!relaySent) : null;
  const header = (
    <div className="t-swap-in flex h-16 items-center justify-between">
      {modeToggle ? <div className="flex min-w-0 items-center gap-3"><h2 className="text-h2">Withdraw</h2>{modeToggle}</div> : <h2 className="text-h2">Withdraw</h2>}
      <IconButton className="-mr-2.5" label="Close withdraw" onClick={onBack} disabled={phase === "sending"}><Icon name="x" size={18} /></IconButton>
    </div>
  );

  /* Above step 01, on the header's rule: read before anything is typed or signed. */
  const noticeBlock = notice ? <div className="-mt-px border-t border-border pt-4">{notice}</div> : null;

  if (mock || !wallet) {
    return <div>{header}{noticeBlock ? <div className="mb-4">{noticeBlock}</div> : null}<p className="border-t border-hairline pt-4 text-sm text-muted-foreground">Withdrawals move real USDC from your balance. Sign in with a live account first.</p></div>;
  }

  if ((phase === "done" || phase === "unknown") && relaySent) {
    const arrived = status.status === "arrived";
    return (
      <div aria-live="polite">
        {header}
        <div className="space-y-4 border-t border-hairline pt-4">
          <div className="t-swap-in flex items-center gap-3">
            <span className="grid size-6 shrink-0 place-items-center">
              {arrived ? <SuccessCheck size={24} className="text-success" /> : phase === "unknown" ? <Icon name="alert" size={20} className="text-warning" /> : <Spinner size={20} />}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium"><TextSwap text={arrived ? `Arrived on ${relaySent.route.chainName}` : phase === "unknown" ? "Not confirmed" : "On its way"} /></div>
              <div className="num mt-0.5 text-xs text-muted-foreground">{usdcExact(relaySent.receiveAmount)} {relaySent.route.token} to <Ends address={relaySent.recipient} /> on {relaySent.route.chainName}</div>
            </div>
          </div>
          {phase === "unknown" && !arrived ? (
            <p className={RISK}>
              <Icon name="alert" size={14} className="mt-px shrink-0" />
              <span>{result && customerWords(result.message)} It may have gone through. Don't withdraw again yet: if your balance drops by this amount, it did. This panel keeps watching.</span>
            </p>
          ) : null}
          {status.status === "refunded" ? <p className="text-xs text-foreground">It was sent back to your balance.</p> : null}
          {status.status === "failed" ? <p className="text-xs text-destructive">It couldn't be completed. Your USDC is being returned to your balance.</p> : null}
          <Button variant="primary" size="lg" className="w-full" onClick={onBack}>{arrived ? "Done" : "Close"}</Button>
        </div>
      </div>
    );
  }

  if (stage === "confirm" && pending) {
    return (
      <div>
        {header}
        <div className="space-y-4">
          {noticeBlock}
          <div className="t-swap-in">
            <dl className="border-t border-hairline">
              <Row label="You send" className="border-b border-hairline py-2.5">{usdcExact(pending.amountUsdc)} USDC</Row>
              <Row label="You receive" tone="font-medium" className="border-b border-hairline py-2.5">{usdcExact(pending.receiveAmount)} {pending.route.token}</Row>
              <Row label="Fee" className="border-b border-hairline py-2.5">{pending.feeUsdc != null ? `${usdcExact(pending.feeUsdc)} USDC` : "—"}</Row>
              {activation ? <Row label="One-time activation (Hyperliquid)" className="border-b border-hairline py-2.5">{usdcExact(activation)} USDC</Row> : null}
              <Row label="Arrives in" className="border-b border-hairline py-2.5">{pending.timeEstimateSec != null ? `~${Math.max(1, Math.round(pending.timeEstimateSec))}s` : "—"}</Row>
            </dl>
            <div className="pt-3">
              <div className="text-xs text-muted-foreground">To, on {pending.route.chainName}</div>
              <div className="mt-1 break-all font-mono text-sm">{pending.recipient}</div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">Make sure this address accepts {pending.route.token} on {pending.route.chainName}.</p>
            </div>
          </div>
          {adjustedLine && !activationShort ? <p className="t-swap-in text-xs text-muted-foreground">{adjustedLine}</p> : null}
          {requoted ? <p className="t-swap-in text-xs text-warning">The price moved, so it was quoted again. Check the figures, then confirm.</p> : null}
          {activationShort ? (
            <div className="t-swap-in space-y-2">
              <p role="alert" className="text-xs text-warning">
                Your first withdrawal pays Hyperliquid&apos;s one-time {usdcExact(activation)} USDC activation, and it has to stay in your balance.
                {maxWithActivation != null && maxWithActivation >= RELAY_MIN_WITHDRAW_USDC ? ` Withdraw up to ${maxWithActivation.toFixed(2)} USDC.` : ""}
              </p>
              {maxWithActivation != null && maxWithActivation >= RELAY_MIN_WITHDRAW_USDC ? (
                <Button variant="secondary" size="sm" onClick={() => { setAmountStr(maxWithActivation.toFixed(2)); setStage("form"); setPending(null); setPhase("idle"); }}>
                  Withdraw {maxWithActivation.toFixed(2)} USDC instead
                </Button>
              ) : null}
            </div>
          ) : null}
          {phase === "error" && result ? <p role="alert" className="text-xs text-destructive">{customerWords(result.message) || "Didn't go through. Nothing was sent."}</p> : null}
          <Button variant="primary" size="xl" className="w-full" onClick={confirm} disabled={!canConfirm} aria-busy={phase === "sending" || phase === "quoting"}>
            <IconSwap state={phase === "sending" || phase === "quoting" ? "b" : "a"} a={<Icon name="arrowUp" size={16} />} b={<Spinner size={16} />} />
            <TextSwap text={phase === "quoting" ? "Pricing again…" : phase === "sending" ? (signing === "deposit" ? "Sign 2 of 2…" : "Sign 1 of 2…") : "Confirm and sign"} />
          </Button>
          {/* How the two signatures go is an explanation, so it is a Tip (USER-REQUESTS D1); what can lose money (the
              address check above, the re-price notice) stays printed. */}
          <div className="!mt-2 flex justify-center"><Tip label="How it works">Two signatures in your wallet: an authorization, then the transfer.</Tip></div>
          <Button variant="ghost" size="sm" className="!mt-2 w-full" onClick={() => { setStage("form"); setPending(null); setPhase("idle"); }} disabled={phase === "sending"}>Edit</Button>
        </div>
      </div>
    );
  }

  const maxBtn = (
    <button type="button" className="ff-hit text-xs text-muted-foreground transition-colors hover:text-foreground" onClick={() => { const m = withdrawMaxUsdc(bal.withdrawableUsdc, heldBack); if (m != null) setAmountStr(m.toFixed(2)); }}>
      Withdrawable <span className="num text-foreground">{bal.withdrawableText}</span> · Max
    </button>
  );
  const pasteBtn = <button type="button" onClick={paste} className="ff-hit text-xs text-muted-foreground transition-colors hover:text-foreground">Paste</button>;

  return (
    <div>
      {header}
      <div className="space-y-4">
        {noticeBlock}
        <StepHead n="01" right={maxBtn}>Amount</StepHead>
        <div>
          <label className="flex h-14 items-center gap-2 rounded-xl bg-input/30 px-3.5 ring-1 ring-inset ring-input transition-[background-color,box-shadow] focus-within:bg-card focus-within:shadow-halo focus-within:ring-ring">
            <input inputMode="decimal" placeholder="0.00" aria-label="Amount in USDC" value={amountStr}
              onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ""))}
              className="num h-full min-w-0 flex-1 bg-transparent text-2xl font-semibold tracking-[-0.02em] outline-none placeholder:text-muted-foreground/60 focus-visible:outline-none" />
            <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 text-sm font-medium">
              <img src="/tokens/usdc.svg" alt="" className="size-6 rounded-full" />USDC
            </span>
          </label>
          {w.error && amountStr ? <p className="mt-1.5 text-xs text-destructive">{customerWords(w.error)}</p> : null}
          {!w.error && adjustedLine ? <p className="t-swap-in mt-1.5 text-xs text-muted-foreground">{adjustedLine}</p> : null}
        </div>

        <StepHead n="02">Network</StepHead>
        <div className="no-scrollbar -mx-gutter !mt-2.5 flex gap-1.5 overflow-x-auto px-gutter py-1.5 md:-mx-1 md:px-1">
          {SHOWN_WITHDRAW_ROUTES.map((r, i) => {
            const ri = rise(i);
            const on = r.id === route.id;
            return (
              <button key={r.id} type="button" aria-pressed={on} onClick={() => setRouteId(r.id)} className={`${ri.className} ${CHIP}`} style={ri.style}>
                {r.chainLogo ? <img src={r.chainLogo} alt="" className="size-4 rounded-full" /> : null}{r.chainName}
                {/* Two routes can share a chain (BNB USDC / BNB USDT): the token tells them apart. */}
                {r.token !== "USDC" ? <span className="font-mono text-[11px] opacity-70">{r.token}</span> : null}
              </button>
            );
          })}
        </div>

        <StepHead n="03" right={pasteBtn}>Destination</StepHead>
        <div>
          <input value={toStr} onChange={(e) => setToStr(e.target.value.trim())} placeholder="0x… the address you control on that network" aria-label="Destination address"
            spellCheck={false} autoComplete="off"
            className="h-11 w-full rounded-lg bg-input/30 px-3 font-mono text-sm ring-1 ring-inset ring-input outline-none transition-[background-color,box-shadow] placeholder:font-sans placeholder:text-muted-foreground/70 focus:bg-card focus:shadow-halo focus:ring-ring focus-visible:outline-none" />
          {toStr && !dest.ok && dest.error ? <p className="mt-1.5 text-xs text-destructive">{customerWords(dest.error)}</p> : null}
          {selfCaution ? <p className="mt-1.5 text-xs text-warning">{customerWords(selfCaution)}</p> : null}
          {recent.length ? (
            <div className="no-scrollbar -mx-gutter mt-1 flex gap-1.5 overflow-x-auto px-gutter py-1.5 md:-mx-1 md:px-1">
              {recent.slice(0, 3).map((a) => <button key={a} type="button" onClick={() => setToStr(a)} className={CHIP}><Ends address={a} /></button>)}
            </div>
          ) : null}
        </div>

        {/* The quote box keeps the two-row height in every state, so the CTA never jumps when a quote lands. Before
            there is anything to price it shows the same rows with dashes instead of a sentence (USER-REQUESTS D1). */}
        <div className="flex min-h-[66px] flex-col justify-center border-y border-hairline py-2.5 text-sm" aria-live="polite">
          {quoteShown ? (
            <dl className="t-swap-in space-y-1">
              <Row label="You receive" tone="font-medium">{usdcExact(quoteShown.receiveAmount)} {route.token}</Row>
              <Row label="Fee">{quoteShown.feeUsdc != null ? `${usdcExact(quoteShown.feeUsdc)} USDC` : "—"}</Row>
              {liveActivation ? <Row label="One-time activation (Hyperliquid)">{usdcExact(liveActivation)} USDC</Row> : null}
            </dl>
          ) : q.status === "loading" || q.status === "refreshing" ? (
            <ShimmerText text="Getting a quote…" className="text-xs" />
          ) : q.error ? (
            <span className="text-xs text-destructive">{String(q.error.message || q.error)}</span>
          ) : (
            <dl className="space-y-1 text-muted-foreground">
              <Row label="You receive">—</Row>
              <Row label="Fee">—</Row>
            </dl>
          )}
        </div>

        <Button variant="primary" size="xl" className="w-full" onClick={review} disabled={!canReview}>Review withdrawal</Button>
      </div>
    </div>
  );
}

/* ── Normal | Private ─────────────────────────────────────────────────────── */

/* DEV ONLY: ?ffPrivateWithdrawPreview=<kind> draws a sample Private state from a fixture (perp/withdraw/
   privateWithdrawPreview.js), imported here only inside the `import.meta.env.DEV` branch, so a production build
   carries neither. */
function usePrivateWithdrawPreview() {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    let kind = null;
    try { kind = new URLSearchParams(window.location.search).get("ffPrivateWithdrawPreview"); } catch { kind = null; }
    if (!kind) return undefined;
    let live = true;
    import("../perp/withdraw/privateWithdrawPreview.js").then((m) => { if (live) setPreview(m.privateWithdrawPreview(kind)); }, () => {});
    return () => { live = false; };
  }, []);
  return preview;
}

/* The switch beside the title (the Deposit's: a header-sized pill). Locked — drawn, not pressable — while a
   withdrawal is being priced, signed or followed on the side that is showing. Locked means its change does nothing
   (a keyboard's Enter or Space reaches Seg's buttons whatever the pointer rule says), not only that it looks off. */
const KEEP_MODE = () => {};
function ModeToggle({ value, onChange, label, locked = false }) {
  const seg = (
    <Seg
      label="Withdraw mode"
      size="xs"
      value={value}
      onChange={locked ? KEEP_MODE : onChange}
      items={[{ value: MODE_NORMAL, label: "Normal" }, { value: MODE_PRIVATE, label }]}
    />
  );
  return locked ? <span aria-disabled="true" className="pointer-events-none opacity-60">{seg}</span> : seg;
}

export default function WithdrawPanel({ backend: b, onBack }) {
  const preview = usePrivateWithdrawPreview();
  /* Private is the connected wallet's own (never a localhost view-as, never the mock). The preview's placeholder wallet
     drives the Private side only: Normal always gets the real backend. */
  const wallet = b && !b.mock && !b.readOnly && b.address ? b.address : null;
  const privateUser = preview ? preview.user : wallet;
  const deps = preview ? preview.deps : PRIVATE_WITHDRAW_DEPS;
  const probe = usePrivateProbe({ enabled: !!privateUser, deps });
  const ledger = usePrivateWithdrawLedger({ user: privateUser, deps, limits: probe.limits });
  const [sheet, dispatch] = useReducer(privateSheetReducer, PRIVATE_SHEET_START);
  useEffect(() => { if (preview) dispatch({ type: "choose", mode: preview.mode }); }, [preview]);
  const mode = sheet.mode;
  const toggle = privateUser && privateToggleShown(probe, mode)
    ? (locked) => <ModeToggle locked={locked} value={mode} onChange={(m) => dispatch({ type: "choose", mode: m })} label={privateToggleLabel(probe)} />
    : null;

  if (mode === MODE_PRIVATE && privateUser) {
    const canSign = !!(b && b.connected && (!b.support || b.support.ok !== false) && typeof b.sendIntentsDeposit === "function");
    return (
      <PrivateWithdraw
        toggle={toggle}
        onBack={onBack}
        user={privateUser}
        walletType={preview ? preview.walletType : b ? b.walletType : null}
        probe={probe}
        deps={deps}
        ledger={ledger}
        withdrawableUsdc={preview ? preview.withdrawableUsdc : balanceView(b && b.account ? b.account.perpBalanceUsdc : null).withdrawableUsdc}
        sendIntentsDeposit={preview ? preview.sendIntentsDeposit : canSign ? b.sendIntentsDeposit : null}
        initial={preview ? preview.initial : null}
        onNormal={() => dispatch({ type: "choose", mode: MODE_NORMAL })}
      />
    );
  }
  /* A private withdrawal that isn't confirmed is said on Normal too, above its form: the customer must not send it
     again another way. Always this one element, so Normal is never remounted when the note comes or goes. */
  return (
    <NormalWithdraw
      backend={b}
      onBack={onBack}
      toggle={toggle}
      notice={privateUser && ledger.unsettled.length ? <UnsettledNote ledger={ledger} normal /> : null}
    />
  );
}

const ATTEST_PREFIX = "flowflow.privateAttest.v1:";
const readAttest = (user) => { try { return localStorage.getItem(`${ATTEST_PREFIX}${String(user).toLowerCase()}`) === "1"; } catch { return false; } };
const saveAttest = (user, on) => { try { if (on) localStorage.setItem(`${ATTEST_PREFIX}${String(user).toLowerCase()}`, "1"); } catch { /* asked again next time */ } };

/* A money warning (never a Tip), spanning the column so every box lines up. */
function MoneyWarning({ children, role = undefined }) {
  return (
    <p role={role} className="t-swap-in flex w-full items-start gap-2 rounded-lg bg-warning/[.06] px-3 py-2.5 text-xs text-warning ring-1 ring-inset ring-warning/[.22]">
      <Icon name="alert" size={14} className="mt-px shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/* A refusal: the alert in the destructive tone, so it never reads as body text or as a price. */
function ErrorNote({ children }) {
  return (
    <p role="alert" className="t-swap-in flex w-full items-start gap-2 rounded-lg bg-destructive/[.06] px-3 py-2.5 text-sm text-destructive ring-1 ring-inset ring-destructive/[.22]">
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

function ErrorActions({ error, onRetry, onNormal }) {
  const list = privateWithdrawErrorActions(error);
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {list.map((k, i) => (
        <Button key={k} variant={i === 0 ? "outline" : "ghost"} size="sm" onClick={k === "normal" ? onNormal : onRetry}>
          {k === "normal" ? "Use Normal withdraw" : "Try again"}
        </Button>
      ))}
    </div>
  );
}

function PrivacyChip({ privacy }) {
  const tip = privacy.private ? PRIVATE_WITHDRAW_TIP : `${PRIVATE_WITHDRAW_TIP} ${PRIVATE_WITHDRAW_PREVIEW_NOTE}`;
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium ring-1 ring-inset ${privacy.private ? "bg-card text-foreground ring-border" : "bg-warning/[.06] text-warning ring-warning/[.22]"}`}>
      {privacy.label}
      <Tip align="start" title="About Private" className="whitespace-normal font-normal tracking-normal">{tip}</Tip>
    </span>
  );
}

/* A row label with its Tip (the explanation folds into the label, the figure stays printed). */
function TipLabel({ label, tip }) {
  if (!tip) return label;
  return <span className="inline-flex items-center gap-1">{label}<Tip align="start" title={label} className="whitespace-normal font-normal tracking-normal">{customerWords(tip)}</Tip></span>;
}

/* The block an unsettled private withdrawal puts on the next one: plain words, and a look again (reads only).
   `normal`: the words for the Normal side (don't send it again another way). */
function UnsettledNote({ ledger, normal = false }) {
  const text = unsettledBlockText(ledger.unsettled, { normal });
  if (!text) return null;
  return (
    <div className="t-swap-in space-y-2" aria-live="polite">
      <MoneyWarning role="status">{customerWords(text)}</MoneyWarning>
      <Button variant="outline" size="sm" onClick={ledger.recheck} disabled={ledger.checking}>
        {ledger.checking ? <Spinner size={14} /> : null}{ledger.checking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}

/* Earlier private withdrawals still on their way (the journal: no recipient is kept, only its fingerprint). */
function LedgerRows({ ledger }) {
  const rows = (ledger.inFlight || []).filter((r) => r.state !== "claimed" && r.state !== "unknown");
  if (!rows.length) return null;
  return (
    <div className="t-swap-in" aria-live="polite">
      <div className="text-xs text-muted-foreground">Earlier private withdrawals</div>
      <div className="mt-1.5 border-t border-hairline">
        {rows.slice(0, 3).map((r, i) => {
          const ri = rise(i);
          return (
            <div key={r.id} className={`${ri.className} flex min-h-11 items-center justify-between gap-3 border-b border-hairline py-2 text-sm`} style={ri.style}>
              <span className="flex min-w-0 items-center gap-2">
                {r.state === "sent" || r.state === "arriving" ? <Spinner size={14} /> : <Icon name="alert" size={14} className="shrink-0 text-muted-foreground" />}
                <span className="num font-medium">{journalAmountText(r)}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{journalStateText(r.state)}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{r.createdAt ? ago(Math.floor(r.createdAt / 1000)) : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PrivateWithdraw({ toggle, onBack, user, walletType, probe, deps, ledger, withdrawableUsdc, sendIntentsDeposit, initial, onNormal }) {
  const p = usePrivateWithdraw({ user, walletType, probe, active: true, withdrawableUsdc, sendIntentsDeposit, ledger, deps, initial });
  const [attested, setAttested] = useState(() => !!(initial && initial.attested) || readAttest(user));
  const amountInput = useRef(null);
  const route = p.route;
  const q = p.quote;
  const rs = p.reviewState;
  const rv = p.reviewView;
  const send = p.send;
  const signing = send.phase === "signing";

  /* Signed: counted on Avalanche, labelled private (the server counts only what Hyperliquid shows went out). */
  const signedOut = p.stage === "result" && !!rs.quote;
  useEffect(() => {
    if (signedOut && user) countWithdrawOnAvalanche(user, { chainId: rs.quote.route && rs.quote.route.chainId, isPrivate: true });
  }, [signedOut, user]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The activation fee stays behind by itself (owner, 2026-10-15): an amount that would not leave it is lowered to the
     most that can go, with one quiet line. Never raised; the fee is still its own row on the review. */
  const [lowered, setLowered] = useState(null);
  const autoTo = p.stage === "form" && !p.blocked
    ? privateWithdrawAutoAmount(p.amount.error, { amountText: p.amountText, withdrawableUsdc, limits: p.limits }) : null;
  useEffect(() => {
    if (autoTo == null) return;
    p.setAmountText(autoTo.toFixed(2));
    setLowered(autoTo);
  }, [autoTo]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The server's own answer replaces the label on screen after these two refusals. */
  const errCode = (q.error && q.error.code) || (rs.error && rs.error.code) || (send.result && send.result.code) || null;
  useEffect(() => {
    if (errCode === "confidentiality-mismatch" || errCode === "private-mode-off") probe.reread();
  }, [errCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <div className="t-swap-in flex h-16 items-center justify-between">
      <div className="flex min-w-0 items-center gap-3"><h2 className="text-h2">Withdraw</h2>{toggle ? toggle(p.locked) : null}</div>
      <IconButton className="-mr-2.5" label="Close withdraw" onClick={onBack} disabled={signing}><Icon name="x" size={18} /></IconButton>
    </div>
  );
  const footer = <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-muted-foreground">{PRIVATE_FOOTER}</p>;
  /* The reader's clock, for "resets 16 Oct, 07:00" (the view itself has none). */
  const errText = (e) => customerWords(privateWithdrawErrorText(e, { chainName: route ? route.chainName : null, now: Date.now() }));

  /* ── after the signature ── */
  if (p.stage === "result" && rs.quote) {
    const qq = rs.quote;
    /* What leaves the balance if it went: the amount plus the activation fee the preflight read (taken on top). */
    const leavesUsdc = journalLeavesUsdc({ amountRaw: qq.amountRaw, accountFeeUsdc: rs.preflight ? rs.preflight.accountFeeUsdc : null });
    const v = privateWithdrawResultView({ phase: send.phase, snapshot: p.snapshot, journalState: p.journalState, chainName: qq.route.chainName, refundStartsAt: qq.refundStartsAt, leavesUsdc });
    const done = v.state === "arrived";
    /* Arrived: the status reading's delivered figure, exact; until then the quote's, approximate. */
    const got = done && p.snapshot && !p.snapshot.mismatch && p.snapshot.receive != null && Number.isFinite(Number(p.snapshot.receive)) ? Number(p.snapshot.receive) : null;
    return (
      <div aria-live="polite">
        {header}
        <div className="space-y-4 border-t border-hairline pt-4">
          <div className="t-swap-in flex items-center gap-3">
            <span className="grid size-6 shrink-0 place-items-center">
              {done ? <SuccessCheck size={24} className="text-success" />
                : v.tone === "wait" ? <Spinner size={20} />
                  : <Icon name="alert" size={20} className={v.tone === "bad" ? "text-destructive" : "text-warning"} />}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium"><TextSwap text={v.title} /></div>
              <div className="num mt-0.5 text-xs text-muted-foreground">{privateAmountText(got != null ? got : qq.receive, { approx: got == null })} to <Ends address={qq.recipient} /> on {qq.route.chainName}</div>
            </div>
          </div>
          {v.state === "unknown" ? (
            <p className={RISK}>
              <Icon name="alert" size={14} className="mt-px shrink-0" />
              <span>{customerWords(v.note)}</span>
            </p>
          ) : v.note ? <p className={`text-xs ${v.tone === "bad" ? "text-destructive" : "text-foreground"}`}>{customerWords(v.note)}</p> : null}
          <Button variant="primary" size="lg" className="w-full" onClick={onBack}>{done ? "Done" : "Close"}</Button>
          {footer}
        </div>
      </div>
    );
  }

  /* ── the review: the real quote and its checks ── */
  if (p.stage === "review") {
    const privacy = privateWithdrawPrivacy({ probe, quote: rs.quote });
    const act = privateWithdrawActivation({ preflight: rs.preflight, withdrawableUsdc, limits: p.limits });
    const pf = rs.preflight;
    const refused = pf && pf.ok !== true && !act.short ? pf : null;
    const sendErr = send.phase === "error" && send.result ? send.result : null;
    const busy = signing || send.phase === "refreshing";
    const canPress = !!rv && !busy && !act.short && !refused && (rv.confirmable || rv.why === "stale" || rv.why === "recheck" || !!sendErr);
    const label = send.phase === "refreshing" ? "Pricing again…" : signing ? "Sign in your wallet…" : sendErr ? "Get a new quote" : "Confirm and sign";
    return (
      <div>
        {header}
        <div className="space-y-4">
          <PrivacyChip privacy={privacy} />
          {rs.status !== "ready" ? (
            <div className="space-y-2.5 border-t border-hairline pt-4" aria-live="polite">
              <div className="skeleton-shimmer h-3.5 w-56 max-w-full rounded" />
              <div className="skeleton-shimmer h-3.5 w-44 rounded" />
              <div className="skeleton-shimmer h-3.5 w-48 rounded" />
              <ShimmerText text="Getting a one-time address and checking it…" className="block pt-1 text-xs" />
            </div>
          ) : (
            <div className="t-swap-in">
              <dl className="border-t border-hairline">
                {privateWithdrawRows({ quote: rs.quote, review: rv, preflight: pf }).map((r) => (
                  <Row key={r.key} strong={r.strong} label={<TipLabel label={r.label} tip={r.tip} />} tone={r.strong ? "font-medium" : r.key === "screen" && r.value === "Refused" ? "text-destructive" : ""} className="border-b border-hairline py-2.5">{r.value}</Row>
                ))}
              </dl>
              <div className="pt-3">
                <div className="text-xs text-muted-foreground">To, on {rs.quote.route.chainName}</div>
                <div className="mt-1 break-all font-mono text-sm">{rs.quote.recipient}</div>
                <div className="mt-2.5"><MoneyWarning>Send only to an address that accepts {rs.quote.route.token} on {rs.quote.route.chainName}. Other networks can be lost.</MoneyWarning></div>
              </div>
            </div>
          )}
          {rs.requoted ? <MoneyWarning>New price: the last one expired. Check the figures, then confirm.</MoneyWarning> : null}
          {act.short ? (
            <div className="t-swap-in space-y-2">
              <MoneyWarning role="alert">{act.text}</MoneyWarning>
              {act.maxUsdc != null ? (
                <Button variant="secondary" size="sm" onClick={() => p.edit(act.maxUsdc.toFixed(2))}>
                  Withdraw {act.maxUsdc.toFixed(2)} USDC instead
                </Button>
              ) : null}
            </div>
          ) : null}
          {refused ? (
            <div className="space-y-2">
              <ErrorNote>{errText(refused)}</ErrorNote>
              {refused.code !== "sanctioned" ? <Button variant="outline" size="sm" onClick={p.recheck} disabled={busy}>Check again</Button> : null}
            </div>
          ) : null}
          {sendErr ? <ErrorNote>{errText(sendErr)}</ErrorNote> : null}
          <Button variant="primary" size="xl" className="w-full" onClick={p.confirm} disabled={!canPress} aria-busy={busy}>
            <IconSwap state={busy ? "b" : "a"} a={<Icon name="arrowUp" size={16} />} b={<Spinner size={16} />} />
            <TextSwap text={label} />
          </Button>
          <div className="!mt-2 flex justify-center"><Tip label="How it works">{HOW_IT_WORKS}</Tip></div>
          <Button variant="ghost" size="sm" className="!mt-2 w-full" onClick={() => p.edit()} disabled={p.locked}>Edit</Button>
          {footer}
        </div>
      </div>
    );
  }

  /* ── switched off on the server while the customer was here: said, and Normal is their own tap ── */
  if (probe.status === "ready" && probe.enabled !== true && !errCode) {
    return (
      <div>
        {header}
        <div className="space-y-4">
          <div className="t-swap-in space-y-3 border-t border-hairline pt-4 text-sm">
            <p>{privateWithdrawErrorText({ code: "private-mode-off" })}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={onNormal}>Use Normal withdraw</Button>
              <Button variant="ghost" size="sm" onClick={probe.reread}>Try again</Button>
            </div>
          </div>
          <UnsettledNote ledger={ledger} />
          <LedgerRows ledger={ledger} />
          {footer}
        </div>
      </div>
    );
  }

  /* ── the form ── */
  const privacy = privateWithdrawPrivacy({ probe });
  const max = privateWithdrawMaxUsdc(withdrawableUsdc, p.limits);
  const shown = privateWithdrawableShown(withdrawableUsdc);
  /* An unsettled private withdrawal blocks the next one: said first, under the header, and the form holds still. */
  const blocked = p.blocked;
  /* A refusal of the last Review press, while the inputs are still the ones it was for. */
  const reviewErr = rs.status === "error" && rs.key === p.askKey ? rs.error : null;
  const serverAmountErr = (q.status === "error" && privateWithdrawErrorPlace(q.error) === "amount" ? q.error : null)
    || (reviewErr && privateWithdrawErrorPlace(reviewErr) === "amount" ? reviewErr : null);
  const amountErrText = p.amount.error ? p.amount.error.text : serverAmountErr ? errText(serverAmountErr) : null;
  /* The one-tap smaller amount under that refusal (the activation fee behind, or what today's limit still allows). */
  const amountFix = blocked ? null : privateWithdrawAmountFix(p.amount.error || serverAmountErr, { withdrawableUsdc, limits: p.limits });
  const boxErr = (reviewErr && privateWithdrawErrorPlace(reviewErr) === "box" ? reviewErr : null)
    || (q.status === "error" && privateWithdrawErrorPlace(q.error) === "box" ? q.error : null);
  const priced = !blocked && q.status === "ready";
  const dryRows = privateWithdrawDryRows(priced ? q.data : null);
  const maxBtn = (
    <button type="button" className="ff-hit text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45" disabled={max == null || blocked}
      onClick={() => { if (max != null) p.setAmountText(max.toFixed(2)); }}>
      Withdrawable <span className="num text-foreground">{shown != null ? usdcNumber(shown) : "—"}</span> · Max
    </button>
  );
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (typeof t === "string" && t.trim()) p.setToText(t.trim()); } catch { /* no permission: type it */ }
  };
  const pasteBtn = <button type="button" onClick={paste} disabled={blocked} className="ff-hit text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45">Paste</button>;
  const canPress = p.canReview && attested && !amountErrText;

  return (
    <div>
      {header}
      <div className="space-y-4">
        {blocked ? <div className="-mt-px border-t border-border pt-4"><UnsettledNote ledger={ledger} /></div> : null}
        <StepHead n="01" right={maxBtn}>Amount</StepHead>
        <div>
          <PrivacyChip privacy={privacy} />
          <label className="mt-2.5 flex h-14 items-center gap-2 rounded-xl bg-input/30 px-3.5 ring-1 ring-inset ring-input transition-[background-color,box-shadow] focus-within:bg-card focus-within:shadow-halo focus-within:ring-ring">
            <input ref={amountInput} inputMode="decimal" placeholder="0.00" aria-label="Amount in USDC" value={p.amountText} readOnly={blocked}
              onChange={(e) => p.setAmountText(e.target.value.replace(/[^\d.]/g, ""))}
              className="num h-full min-w-0 flex-1 bg-transparent text-2xl font-semibold tracking-[-0.02em] outline-none placeholder:text-muted-foreground/60 focus-visible:outline-none" />
            <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 text-sm font-medium">
              <img src="/tokens/usdc.svg" alt="" className="size-6 rounded-full" />USDC
            </span>
          </label>
          {amountErrText ? (
            <>
              <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive"><Icon name="alert" size={13} className="mt-px shrink-0" /><span>{customerWords(amountErrText)}</span></p>
              {amountFix ? <Button variant="secondary" size="sm" className="mt-2" onClick={() => p.setAmountText(amountFix.usdc.toFixed(2))}>{amountFix.text}</Button> : null}
            </>
          ) : <p className="mt-1.5 text-xs text-muted-foreground">{lowered != null && p.amountText === lowered.toFixed(2) ? privateWithdrawAdjustedText(lowered) : privateWithdrawAmountNote({ amountText: p.amountText, withdrawableUsdc, limits: p.limits })}</p>}
        </div>

        <StepHead n="02">Network</StepHead>
        <div className="no-scrollbar -mx-gutter !mt-2.5 flex gap-1.5 overflow-x-auto px-gutter py-1.5 md:-mx-1 md:px-1">
          {privateWithdrawChains().map((r, i) => {
            const ri = rise(i);
            const on = r.id === route.id;
            return (
              <button key={r.id} type="button" aria-pressed={on} disabled={blocked} onClick={() => p.setRouteId(r.id)} className={`${ri.className} ${CHIP}`} style={ri.style}>
                {r.chainLogo ? <img src={r.chainLogo} alt="" className="size-4 rounded-full" /> : null}{r.chainName}
              </button>
            );
          })}
        </div>

        <StepHead n="03" right={pasteBtn}>Destination</StepHead>
        <div>
          {/* 13px mono at phone width, so all 42 characters show: the ending is the part people compare. */}
          <input value={p.toText} onChange={(e) => p.setToText(e.target.value.trim())} placeholder="0x… the address you control on that network" aria-label="Destination address"
            spellCheck={false} autoComplete="off" readOnly={blocked}
            className="h-11 w-full rounded-lg bg-input/30 px-2.5 font-mono text-[13px] ring-1 ring-inset ring-input outline-none transition-[background-color,box-shadow] placeholder:font-sans placeholder:text-muted-foreground/70 focus:bg-card focus:shadow-halo focus:ring-ring focus-visible:outline-none sm:text-sm" />
          {p.toText && p.dest.error ? <p className="mt-1.5 text-xs text-destructive">{customerWords(p.dest.error)}</p> : null}
          {p.dest.caution ? (
            <div className="mt-2 space-y-2">
              <MoneyWarning>{customerWords(p.dest.caution)}</MoneyWarning>
              {p.dest.own ? <Button variant="outline" size="sm" onClick={onNormal}>Use Normal withdraw</Button> : null}
            </div>
          ) : null}
        </div>

        {/* The price box keeps its height in every state (four rows), so the CTA never jumps when a price lands. */}
        <div className="flex min-h-[114px] flex-col justify-center border-y border-hairline py-2.5 text-sm" aria-live="polite">
          {!blocked && (q.status === "loading" || (q.status === "waiting" && !boxErr && !amountErrText)) ? (
            <ShimmerText text="Getting a price…" className="text-xs" />
          ) : (
            <dl className={`space-y-1 ${priced ? "t-swap-in" : "text-muted-foreground"}`}>
              {dryRows.map((r) => (
                <Row key={r.key} strong={priced && r.strong} label={<TipLabel label={r.label} tip={priced ? r.tip : null} />} tone={priced ? (r.strong ? "font-medium" : "") : "text-muted-foreground"}>{r.value}</Row>
              ))}
            </dl>
          )}
        </div>

        <LedgerRows ledger={ledger} />

        <div className="space-y-3">
          {!blocked && boxErr ? (
            <>
              <ErrorNote>{errText(boxErr)}</ErrorNote>
              <ErrorActions error={boxErr} onRetry={reviewErr ? p.review : q.retry} onNormal={onNormal} />
            </>
          ) : null}
          {blocked || attested ? null : (
            <label className="flex cursor-pointer items-start gap-2.5 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-foreground" checked={attested} onChange={(e) => { setAttested(e.target.checked); saveAttest(user, e.target.checked); }} />
              <span>{PRIVATE_ATTEST}</span>
            </label>
          )}
          {blocked || p.canSign ? null : <p className="text-xs text-muted-foreground">This wallet can't sign a withdrawal here.</p>}
          <Button variant="primary" size="xl" className="w-full" onClick={p.review} disabled={!canPress}>Review withdrawal</Button>
        </div>
        {footer}
      </div>
    </div>
  );
}
