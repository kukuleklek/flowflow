import { useEffect, useReducer, useRef, useState } from "react";
import { IconSwap, ShimmerText, TextSwap, rise } from "../ui/kit/index.ts";
import Seg from "../ui/Seg.jsx";
import Button, { IconButton } from "../ui/Button.jsx";
import Icon, { Spinner } from "../ui/Icon.jsx";
import { Stat, StatStrip } from "../ui/Stat.jsx";
import LiveDot from "../ui/LiveDot.jsx";
import Tip from "../ui/Tip.jsx";
import { useWallet } from "../hooks/useWallet.js";
import { ago } from "../lib/format.js";
import { DEFAULT_ROUTE_ID, SHOWN_DEPOSIT_ROUTES, routeById } from "../lib/relay/routes.js";
import { usePerpDepositAddress, useDepositTracker, useDepositPlan, useDepositFee } from "../perp/deposit/usePerpDeposit.js";
import { customerWords } from "./words.js";
import { useFirstDepositMove } from "../perp/deposit/useFirstDeposit.js";
import {
  depositRules, feeText, feeBasisText, timeText, validUntilText, addressGroups, depositRowView, depositErrorText,
  activationCaption, walletCanFinishFirstHop,
} from "../perp/deposit/perpDepositView.js";
import { usePrivateProbe, usePrivateDeposit, useStrandedRecover, useRecoverSigner, PRIVATE_DEPS } from "../perp/deposit/usePrivateDeposit.js";
import {
  MODE_NORMAL, MODE_PRIVATE, PRIVATE_SHEET_START, privateSheetReducer, privateToggleShown, privateToggleLabel, privacyLabel,
  privateChainOptions, privateLimitsText, privateRefundText, privateSendOnlyText, privateQuoteRows,
  privateFiguresOf, privateSummaryText, privateUsdcText, addressStepOf, privateErrorPlace, privateErrorActions, keepsOwnWords,
  oneTimeAddressTitle, oneTimeAddressWarning, countdownText, ADDRESS_USED_TEXT, ADDRESS_DROPPED_TEXT, LESS_ARRIVES_TIP,
  PRIVATE_TIP, PREVIEW_NOTE, PRIVATE_FOOTER, PRIVATE_ATTEST, recoverReadyFor,
} from "../perp/deposit/privateDepositView.js";
import { RECOVER_WORDS } from "../lib/relay/recoverStranded.js";

/* The deposit (Relay deposit address, verified field by field before it is shown, cached per user and route,
   first deposit routed through Arbitrum for a Privy wallet so a new account skips the activation charge), drawn as
   the motion kit's morph: it grows inside the balance band, chips rise one by one, the QR materializes, and the panel
   shimmers while it waits for the money. Laid out as three numbered steps on hairlines (DESIGN-SPEC §6.5).

   NORMAL | PRIVATE (owner, 2026-10-15: "เริ่มทำหน้าจอ Private mode เลย ฝั่ง Deposit ก่อน"). A small toggle beside the
   title, shown only when the server's probe says Private is on. Normal is the deposit above, unchanged (NormalDeposit
   is that code, moved, not edited; without the toggle the header is the same element). Private is a one-time address
   for one exact amount from Arbitrum or Avalanche (Base and Polygon once Recover can sign: PRIVATE_RECOVER_READY),
   priced dry while typing and reserved only on the customer's own press of "Get address". The sheet always opens on
   Normal, and an error never moves it off Private (privateDepositView's reducer). Once the address is up, step 01
   folds to one line and every figure on screen is the one that address is bound to; once the watch sees money sent to
   it, it is spent: no QR, no copy, no clock, only its rows and "New deposit". */

let qrModule = null;
const loadQr = () => (qrModule ||= import("qrcode").catch((e) => { qrModule = null; throw e; }));

function useQr(text) {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    if (!text) { setQr(null); return undefined; }
    let stale = false;
    loadQr()
      .then((QRCode) => QRCode.toDataURL(text, { width: 360, margin: 1, color: { dark: "#09090b", light: "#ffffff" } }))
      .then((url) => { if (!stale) setQr({ text, url }); })
      .catch(() => { if (!stale) setQr(null); });
    return () => { stale = true; };
  }, [text]);
  return qr && qr.text === text ? qr.url : null;
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

/* A caption from perpDepositView ("on a 20 USDC deposit") read as a sentence inside a Tip: capitalised, full stop. */
const sentence = (t) => (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "");

const CHIP = "ff-press ff-hit inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-card px-3 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border hover:text-foreground disabled:opacity-45 aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:ring-foreground";

function ChainChip({ r, on, i, onClick }) {
  const ri = rise(i);
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`${ri.className} ${CHIP}`} style={ri.style}>
      <img src={r.chainLogo} alt="" className="size-4 rounded-full" />
      {r.chainName}
    </button>
  );
}

/* DEV ONLY: ?ffPrivatePreview=<kind> draws a sample Private state from a fixture (perp/deposit/privateDepositPreview.js),
   imported here only inside the `import.meta.env.DEV` branch, so a production build carries neither. */
function usePrivatePreview() {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    let kind = null;
    try { kind = new URLSearchParams(window.location.search).get("ffPrivatePreview"); } catch { kind = null; }
    if (!kind) return undefined;
    let live = true;
    import("../perp/deposit/privateDepositPreview.js").then((m) => { if (live) setPreview(m.privatePreview(kind)); }, () => {});
    return () => { live = false; };
  }, []);
  return preview;
}

export default function DepositPanel({ onBack }) {
  const { address, walletType } = useWallet();
  const preview = usePrivatePreview();
  const wallet = address || null;
  /* The preview's placeholder wallet drives the Private side only: Normal always gets the real one. */
  const privateUser = preview ? preview.user : wallet;
  const deps = preview ? preview.deps : PRIVATE_DEPS;
  /* 🔴 Base and Polygon, and the Recover rows, only for a wallet Recover can SIGN for (the embedded wallet whose
     signer PrivyBridge provides): for any other wallet a refund there would strand with no way back in the app. */
  const injectedSigner = useRecoverSigner();
  const recoverReady = recoverReadyFor(privateUser, preview ? preview.recoverSigner || null : injectedSigner);
  const probe = usePrivateProbe({ enabled: !!privateUser, deps });
  const [sheet, dispatch] = useReducer(privateSheetReducer, PRIVATE_SHEET_START);
  useEffect(() => { if (preview) dispatch({ type: "choose", mode: preview.mode }); }, [preview]);
  const mode = sheet.mode;
  const toggle = privateUser && privateToggleShown(probe, mode) ? (
    <Seg
      label="Deposit mode"
      size="xs"
      value={mode}
      onChange={(m) => dispatch({ type: "choose", mode: m })}
      items={[{ value: MODE_NORMAL, label: "Normal" }, { value: MODE_PRIVATE, label: privateToggleLabel(probe) }]}
    />
  ) : null;

  /* 64px, like the account row beside it at xl, so step 01's rule continues that row's rule. */
  const header = (
    <div className="t-swap-in flex h-16 items-center justify-between">
      {toggle ? <div className="flex min-w-0 items-center gap-3"><h2 className="text-h2">Deposit</h2>{toggle}</div> : <h2 className="text-h2">Deposit</h2>}
      <IconButton className="-mr-2.5" label="Close deposit" onClick={onBack}><Icon name="x" size={18} /></IconButton>
    </div>
  );

  if (mode === MODE_PRIVATE && privateUser) {
    return (
      <PrivateDeposit
        header={header}
        user={privateUser}
        walletType={preview ? preview.walletType : walletType}
        probe={probe}
        deps={deps}
        initial={preview ? preview.initial : null}
        recover={preview ? preview.recover : null}
        recoverReady={recoverReady}
        onNormal={() => dispatch({ type: "choose", mode: MODE_NORMAL })}
      />
    );
  }
  const normal = <NormalDeposit header={header} wallet={wallet} walletType={walletType} />;
  /* Recover on Normal too, for a wallet it can sign for: a refund on Base or Polygon must have a way back whatever the
     switch says. (DEV: a preview's Recover fixture draws here instead; `preview` is always null in a production build.)
     Always one tree — Normal first, the rows after it or nothing — so Normal is never remounted when a signer comes or
     goes. */
  const normalRecover = !recoverReady ? null
    : preview && preview.recover ? <RecoverRows user={preview.user} ready={preview.recover.ready} deps={preview.recover.deps} />
      : wallet ? <RecoverRows user={wallet} ready /> : null;
  return <>{normal}{normalRecover ? <div className="mt-4">{normalRecover}</div> : null}</>;
}

/* Today's deposit, exactly as it was: the same hooks, the same JSX, the same words. */
function NormalDeposit({ header, wallet, walletType }) {
  const [routeId, setRouteId] = useState(SHOWN_DEPOSIT_ROUTES[0].id);
  const [copied, setCopied] = useState(false);
  const route = routeById(routeId) || routeById(DEFAULT_ROUTE_ID);

  const { accountNew, planId } = useDepositPlan({ user: wallet, walletType, enabled: !!wallet });
  const dep = usePerpDepositAddress({ user: wallet, connected: wallet, route, planId, enabled: !!(wallet && planId) });
  const data = dep.status === "ready" && dep.data && dep.data.route && dep.data.route.id === route.id ? dep.data : null;
  const depositAddress = data ? data.depositAddress : null;
  const track = useDepositTracker({ depositAddress, user: wallet, enabled: !!depositAddress, routeId: route.id, planId: data ? data.plan : null });
  const fee = useDepositFee({ user: wallet, connected: wallet, route, data, accountNew, requests: track.requests, enabled: !!data });
  const move = useFirstDepositMove({
    user: wallet, connected: wallet, planId: data ? data.plan : null, canFinish: walletCanFinishFirstHop(walletType),
    depositAddress, minInputUsdc: fee.minInputUsdc, requests: track.requests, tracked: track.checkedAt != null, enabled: !!data,
  });
  const qr = useQr(depositAddress);
  const moved = move.step === "sent";
  const rows = track.requests || [];

  const copy = async () => {
    if (!depositAddress) return;
    try { await navigator.clipboard.writeText(depositAddress); } catch { /* the address is on screen */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!wallet) {
    return (
      <div>
        {header}
        <p className="border-t border-hairline pt-4 text-sm text-muted-foreground">Deposits go to your balance. Sign in with a live account first (the mock account can't receive one).</p>
      </div>
    );
  }

  let body;
  if (dep.status === "error") {
    body = (
      <div className="t-swap-in space-y-3 border-y border-hairline py-3 text-sm">
        <p>{customerWords(depositErrorText(dep.error))}</p>
        <Button variant="outline" size="sm" onClick={() => dep.retry()}>Try again</Button>
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex flex-wrap items-center gap-5">
        <div className="skeleton-shimmer size-[148px] shrink-0 rounded-xl" />
        <div className="min-w-[180px] flex-1 space-y-2.5">
          <div className="skeleton-shimmer h-3.5 w-40 rounded" />
          <div className="skeleton-shimmer h-3.5 w-56 max-w-full rounded" />
          <div className="skeleton-shimmer h-3.5 w-44 rounded" />
          <ShimmerText text="Getting your deposit address…" className="block pt-1 text-xs" />
        </div>
      </div>
    );
  } else {
    body = (
      <div key={depositAddress} className="flex flex-wrap items-center gap-5">
        <div className="t-materialize grid size-[148px] shrink-0 place-items-center rounded-xl bg-white p-2 ring-1 ring-border">
          {qr ? <img src={qr} alt={`QR code for your ${route.chainName} deposit address`} className="size-full" /> : <div className="skeleton-shimmer size-28 rounded-lg" />}
        </div>
        <div className="min-w-[180px] flex-1 space-y-2">
          <div className="t-swap-in text-xs text-muted-foreground" style={{ animationDelay: "60ms" }}>Your {route.token} address on {route.chainName}</div>
          <div className="t-swap-in flex max-w-[26ch] flex-wrap gap-x-1.5 font-mono text-sm leading-[1.45]" style={{ animationDelay: "100ms" }}>
            <span className="text-muted-foreground">0x</span>
            {addressGroups(depositAddress).map((g, i) => <span key={i}>{g}</span>)}
          </div>
          <div className="t-swap-in flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pt-1" style={{ animationDelay: "140ms" }}>
            <Button variant="outline" size="sm" onClick={copy}>
              <IconSwap state={copied ? "b" : "a"} a={<Icon name="copy" size={14} />} b={<Icon name="check" size={14} />} />
              <TextSwap text={copied ? "Copied" : "Copy address"} />
            </Button>
            {validUntilText(data.expiresAt) ? <span className="whitespace-nowrap text-[11px] text-muted-foreground">{validUntilText(data.expiresAt)}</span> : null}
          </div>
        </div>
      </div>
    );
  }

  const status = data ? (
    <>
      <StepHead n="03">Status</StepHead>
      <div className="t-swap-in" style={{ animationDelay: "180ms" }}>
        {/* What the fee was priced on folds into a Tip on the Fee label (USER-REQUESTS D1). The strip is two cells
            that never overflow, so it drops the scroller's clip and the Tip's bubble can open below it. */}
        <StatStrip className="!overflow-visible">
          <Stat label={<span className="inline-flex h-[11px] items-center gap-1">Fee<Tip align="start" title="How the fee is priced" className="whitespace-normal font-normal tracking-normal">{sentence(fee.activation && fee.fee != null ? activationCaption(fee.activationUsdc) : feeBasisText(route))}</Tip></span>}>
            {feeText(fee.fee)}
          </Stat>
          <Stat label="Arrives in">{timeText(data.timeEstimateSec)}</Stat>
        </StatStrip>
      </div>

      {move.text ? (
        <div className="t-swap-in flex items-start gap-2.5 border-y border-hairline py-3 text-sm">
          {move.step === "sending" || move.step === "auto" ? <Spinner /> : <Icon name={move.step === "sent" ? "check" : "wallet"} size={16} className={`mt-0.5 shrink-0 ${move.step === "sent" ? "text-success" : ""}`} />}
          <div className="min-w-0 flex-1">
            <p>{customerWords(move.text)}</p>
            {move.action ? <Button variant="primary" size="sm" className="mt-2" disabled={!move.canPress} onClick={move.run}>{customerWords(move.action)}</Button> : null}
          </div>
        </div>
      ) : null}

      <div className="t-swap-in" style={{ animationDelay: "220ms" }} aria-live="polite">
        {rows.length === 0 ? (
          <div className="flex items-center gap-2 text-sm"><LiveDot /><ShimmerText text={`Waiting for your ${route.token}…`} /></div>
        ) : (
          <div className={move.text ? "" : "border-t border-hairline"}>
            {rows.slice(0, 4).map((req, i) => {
              const v = depositRowView(req, route, data.plan, { moved });
              const r = rise(i);
              return (
                <div key={req.id || i} className={`${r.className} flex h-11 items-center justify-between gap-3 border-b border-hairline text-sm`} style={r.style}>
                  <span className="flex min-w-0 items-center gap-2">
                    {req.status === "arriving" ? <Spinner size={14} />
                      : req.status === "credited" ? <Icon name="check" size={14} className="shrink-0 text-success" />
                      : <Icon name="alert" size={14} className="shrink-0 text-muted-foreground" />}
                    <span className="num font-medium">{v.amount}</span>
                    <span className="truncate text-xs text-muted-foreground">{customerWords(v.label)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{req.createdAt ? ago(Math.floor(req.createdAt / 1000)) : ""}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  ) : null;

  const planNow = data ? data.plan : planId;
  return (
    <div>
      {header}
      <div className="space-y-4">
        <StepHead n="01">Token and network</StepHead>
        <div>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 text-sm font-medium">
            <img src="/tokens/usdc.svg" alt="" className="size-6 rounded-full" />USDC
          </span>
          <div className="no-scrollbar -mx-gutter mt-2.5 flex gap-1.5 overflow-x-auto px-gutter py-1.5 md:-mx-1 md:px-1">
            {SHOWN_DEPOSIT_ROUTES.map((r, i) => <ChainChip key={r.id} r={r} i={i} on={r.id === route.id} onClick={() => setRouteId(r.id)} />)}
          </div>
          <p className="t-swap-in mt-2.5 flex w-fit max-w-full items-start gap-2 rounded-lg bg-warning/[.06] px-3 py-2.5 text-xs text-warning ring-1 ring-inset ring-warning/[.22]">
            <Icon name="alert" size={14} className="mt-px shrink-0" />
            <span>Send only {route.token} on {route.chainName}. Other tokens or networks can be lost.</span>
          </p>
        </div>

        <StepHead n="02">Your deposit address</StepHead>
        {body}

        {status}

        <ul className="space-y-1 text-xs text-muted-foreground">
          {depositRules(route, { accountNew, activationUsdc: fee.activationUsdc, planId: planNow, minInputUsdc: fee.minInputUsdc })
            .filter((r) => r.key !== "only")
            .map((r, i) => (
            <li key={i} className="flex gap-1.5"><span aria-hidden="true">·</span><span>{customerWords(r.text)}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── Private ──────────────────────────────────────────────────────────────── */

const ATTEST_PREFIX = "flowflow.privateAttest.v1:";
const readAttest = (user) => { try { return localStorage.getItem(`${ATTEST_PREFIX}${String(user).toLowerCase()}`) === "1"; } catch { return false; } };
const saveAttest = (user, on) => { try { if (on) localStorage.setItem(`${ATTEST_PREFIX}${String(user).toLowerCase()}`, "1"); } catch { /* asked again next time */ } };

/* The Wallet's words (customerWords), except a sentence naming the Spot Account: that is where an Avalanche refund
   really is, in the owner's own words, and it must not read like the balance a deposit lands in. */
const said = (s) => (keepsOwnWords(s) ? s : customerWords(s));

/* The money warning, in Normal's own style (a warning, never a Tip), spanning the column so every box lines up. A Tip
   may carry the why behind it. */
function MoneyWarning({ children, tip = null, tipTitle = "More info" }) {
  return (
    <p className="t-swap-in flex w-full items-start gap-2 rounded-lg bg-warning/[.06] px-3 py-2.5 text-xs text-warning ring-1 ring-inset ring-warning/[.22]">
      <Icon name="alert" size={14} className="mt-px shrink-0" />
      <span className="min-w-0 flex-1">
        {children}
        {tip ? <>{" "}<Tip align="end" title={tipTitle} className="whitespace-normal font-normal tracking-normal">{tip}</Tip></> : null}
      </span>
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

/* The buttons under a refusal, the stronger first (privateDepositView privateErrorActions). Normal is only ever a tap. */
function ErrorActions({ error, onRetry, onNormal }) {
  const list = privateErrorActions(error);
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {list.map((k, i) => (
        <Button key={k} variant={i === 0 ? "outline" : "ghost"} size="sm" onClick={k === "normal" ? onNormal : onRetry}>
          {k === "normal" ? "Use Normal deposit" : "Try again"}
        </Button>
      ))}
    </div>
  );
}

function PrivacyChip({ probe }) {
  const v = privacyLabel(probe);
  const tip = v.private ? PRIVATE_TIP : `${PRIVATE_TIP} ${PREVIEW_NOTE}`;
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium ring-1 ring-inset ${v.private ? "bg-card text-foreground ring-border" : "bg-warning/[.06] text-warning ring-warning/[.22]"}`}>
      {v.label}
      <Tip align="start" title="About Private" className="whitespace-normal font-normal tracking-normal">{tip}</Tip>
    </span>
  );
}

/* The watch's rows for the address the sheet holds, in the panel's own row words. */
function PrivateRows({ rows, route, planId, token }) {
  return (
    <div className="t-swap-in" style={{ animationDelay: "220ms" }} aria-live="polite">
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 text-sm"><LiveDot /><ShimmerText text={`Waiting for your ${token}…`} /></div>
      ) : (
        <div className="border-t border-hairline">
          {rows.slice(0, 4).map((req, i) => {
            const v = depositRowView(req, route, planId);
            const r = rise(i);
            return (
              <div key={req.id || i} className={`${r.className} flex min-h-11 items-center justify-between gap-3 border-b border-hairline py-2 text-sm last:border-b-0`} style={r.style}>
                <span className="flex min-w-0 items-center gap-2">
                  {req.status === "arriving" ? <Spinner size={14} />
                    : req.status === "credited" ? <Icon name="check" size={14} className="shrink-0 text-success" />
                    : <Icon name="alert" size={14} className="shrink-0 text-muted-foreground" />}
                  <span className="num font-medium">{v.amount}</span>
                  <span className="min-w-0 text-xs text-muted-foreground">{said(v.label)}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{req.createdAt ? ago(Math.floor(req.createdAt / 1000)) : ""}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PrivateDeposit({ header, user, walletType, probe, deps, initial, recover, recoverReady = false, onNormal }) {
  const p = usePrivateDeposit({ user, walletType, probe, active: true, deps, initial, recoverReady });
  const [copied, setCopied] = useState(false);
  const [attested, setAttested] = useState(() => !!(initial && initial.attested) || readAttest(user));
  const amountInput = useRef(null);
  const route = p.route;
  const routes = privateChainOptions({ recoverReady });
  const q = p.quote;
  const a = p.address;
  /* loading | error | address | used | expired | null: a used address is never offered again (no QR, copy or clock). */
  const step = addressStepOf(a);
  const shownAddress = step === "address" ? a.data.depositAddress : null;
  const qr = useQr(shownAddress);
  const rows = p.track.requests || [];
  /* Once an address is bound to this amount and network, step 01 folds to one line and its inputs stay put. */
  const bound = a.status === "ready";
  const locked = a.status === "loading" || bound;
  const rowsPlan = bound ? a.data.plan || p.planId : p.planId;

  /* The server's own answer replaces the label on screen after these two refusals. */
  const errCode = (a.error && a.error.code) || (q.error && q.error.code) || null;
  useEffect(() => {
    if (errCode === "confidentiality-mismatch" || errCode === "private-mode-off") probe.reread();
  }, [errCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    if (!shownAddress) return;
    try { await navigator.clipboard.writeText(shownAddress); } catch { /* the address is on screen */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const changeAmount = () => {
    const el = amountInput.current;
    if (el) { el.focus(); el.select(); }
  };

  /* Recover does not depend on the switch: a refund on Base or Polygon can outlive it (also drawn on Normal). */
  const recoverRows = !recoverReady ? null : recover ? <RecoverRows user={user} ready={recover.ready} deps={recover.deps} /> : <RecoverRows user={user} ready />;

  if (probe.status === "ready" && probe.enabled !== true && !errCode) {
    /* Switched off on the server while the customer was here: said, and Normal is their own tap. */
    return (
      <div>
        {header}
        <div className="space-y-4">
          <div className="t-swap-in space-y-3 border-t border-hairline pt-4 text-sm">
            <p>{said(depositErrorText({ code: "private-mode-off" }))}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={onNormal}>Use Normal deposit</Button>
              <Button variant="ghost" size="sm" onClick={probe.reread}>Try again</Button>
            </div>
          </div>
          {recoverRows}
        </div>
      </div>
    );
  }

  const errText = (e) => said(depositErrorText(e, { chainName: route ? route.chainName : null }));
  /* An error about the amount is said under the amount (fixed by changing it); any other in its own box. */
  const serverAmountErr = (q.status === "error" && privateErrorPlace(q.error) === "amount" ? q.error : null)
    || (a.status === "error" && privateErrorPlace(a.error) === "amount" ? a.error : null);
  const amountErr = p.amount.error || serverAmountErr;
  const quoteErr = q.status === "error" && privateErrorPlace(q.error) === "box" ? q.error : null;
  const addressErr = a.status === "error" && privateErrorPlace(a.error) === "box" ? a.error : null;
  /* The figures the address is bound to once it is up; the dry quote's before; the dash beside any error. */
  const figures = privateFiguresOf({ quote: q, address: a });

  const quoteBox = (
    <div className="flex min-h-[88px] flex-col justify-center border-t border-hairline pt-2.5 text-sm" aria-live="polite">
      {!figures && !amountErr && !quoteErr && !addressErr && (q.status === "loading" || q.status === "waiting") ? (
        <ShimmerText text="Getting a price…" className="text-xs" />
      ) : (
        <dl className={`space-y-1 ${figures ? "t-swap-in" : ""}`}>
          {privateQuoteRows(figures).map((r) => (
            <div key={r.key} className={`flex items-baseline justify-between gap-3 ${r.strong ? "font-medium" : "text-muted-foreground"}`}>
              <dt className="inline-flex items-center gap-1">
                {r.label}
                {figures && r.tip ? <Tip align="start" title={r.label} className="whitespace-normal font-normal tracking-normal">{said(r.tip)}</Tip> : null}
              </dt>
              <dd className={`num ${figures ? "text-foreground" : "text-muted-foreground"}`}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );

  let step2 = null;
  if (step === "loading") {
    step2 = (
      <div className="flex flex-wrap items-center gap-5">
        <div className="skeleton-shimmer size-[148px] shrink-0 rounded-xl" />
        <div className="min-w-[180px] flex-1 space-y-2.5">
          <div className="skeleton-shimmer h-3.5 w-40 rounded" />
          <div className="skeleton-shimmer h-3.5 w-56 max-w-full rounded" />
          <ShimmerText text="Getting your one-time address…" className="block pt-1 text-xs" />
        </div>
      </div>
    );
  } else if (step === "error" && addressErr) {
    step2 = (
      <div className="space-y-3 pt-1">
        <ErrorNote>{errText(addressErr)}</ErrorNote>
        <ErrorActions error={addressErr} onRetry={p.getAddress} onNormal={onNormal} />
      </div>
    );
  } else if (step === "expired") {
    /* Nothing was seen at it (any row makes it "used", whose rows stay on screen past showUntil). */
    step2 = (
      <div className="t-swap-in space-y-3 pt-1 text-sm">
        <p>This one-time address has expired and is no longer shown. Don't send to it. Get a new one for your next deposit.</p>
        <Button variant="outline" size="sm" onClick={p.clearAddress}>New address</Button>
      </div>
    );
  } else if (step === "used") {
    step2 = (
      <>
        <MoneyWarning>{ADDRESS_USED_TEXT}</MoneyWarning>
        <PrivateRows rows={rows} route={route} planId={rowsPlan} token={route.token} />
        <Button variant="outline" size="sm" onClick={p.clearAddress}>New deposit</Button>
      </>
    );
  } else if (step === "address") {
    step2 = (
      <>
        <p className="t-swap-in text-sm font-medium text-foreground">{oneTimeAddressTitle(a.data, route, p.amountText)}</p>
        <div key={shownAddress} className="flex flex-wrap items-center gap-5">
          <div className="t-materialize grid size-[148px] shrink-0 place-items-center rounded-xl bg-white p-2 ring-1 ring-border">
            {qr ? <img src={qr} alt={`QR code for your one-time ${route.chainName} deposit address`} className="size-full" /> : <div className="skeleton-shimmer size-28 rounded-lg" />}
          </div>
          <div className="min-w-[180px] flex-1 space-y-2">
            <div className="t-swap-in text-xs text-muted-foreground" style={{ animationDelay: "60ms" }}>Your one-time {route.token} address on {route.chainName}</div>
            <div className="t-swap-in flex max-w-[26ch] flex-wrap gap-x-1.5 font-mono text-sm leading-[1.45]" style={{ animationDelay: "100ms" }}>
              <span className="text-muted-foreground">0x</span>
              {addressGroups(shownAddress).map((g, i) => <span key={i}>{g}</span>)}
            </div>
            <div className="t-swap-in flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pt-1" style={{ animationDelay: "140ms" }}>
              <Button variant="outline" size="sm" onClick={copy}>
                <IconSwap state={copied ? "b" : "a"} a={<Icon name="copy" size={14} />} b={<Icon name="check" size={14} />} />
                <TextSwap text={copied ? "Copied" : "Copy address"} />
              </Button>
              <span className="whitespace-nowrap text-[11px] text-muted-foreground" aria-live="off">{countdownText(a.data, a.now)}</span>
            </div>
          </div>
        </div>
        <MoneyWarning tip={LESS_ARRIVES_TIP} tipTitle="If less arrives">{oneTimeAddressWarning()}</MoneyWarning>
        {/* Where a refund goes stays printed beside the address (owner: "Refunds go to your Spot Account"). */}
        <p className="-mt-1 text-xs text-muted-foreground">{said(privateRefundText(route, p.refundPath))}</p>
        <PrivateRows rows={rows} route={route} planId={rowsPlan} token={route.token} />
        {quoteBox}
      </>
    );
  }

  const canPress = q.status === "ready" && attested && !locked && !amountErr;
  return (
    <div>
      {header}
      <div className="space-y-4">
        <StepHead n="01">Amount and network</StepHead>
        <div>
          <PrivacyChip probe={probe} />
          {bound ? (
            /* Folded: the address below is bound to exactly this. "Change" drops it (and says not to use it). */
            <div className="t-swap-in mt-2.5 flex min-h-11 items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <img src={route.chainLogo} alt="" className="size-4 shrink-0 rounded-full" />
                <span className="num truncate font-medium">{privateSummaryText(a.data, route, p.amountText)}</span>
              </span>
              {step === "address" ? <Button variant="link" size="sm" className="shrink-0" onClick={p.clearAddress}>Change</Button> : null}
            </div>
          ) : (
            <>
              {/* While an address is being made it is bound to this network and amount: both are locked. */}
              <div className={`no-scrollbar -mx-gutter mt-1 flex gap-1.5 overflow-x-auto px-gutter py-1.5 md:-mx-1 md:px-1 ${locked ? "pointer-events-none opacity-60" : ""}`} aria-disabled={locked || undefined}>
                {routes.map((r, i) => <ChainChip key={r.id} r={r} i={i} on={r.id === route.id} onClick={() => { if (!locked) p.setRouteId(r.id); }} />)}
              </div>
              <label className={`mt-2.5 flex h-14 items-center gap-2 rounded-xl bg-input/30 px-3.5 ring-1 ring-inset ring-input transition-[background-color,box-shadow] focus-within:bg-card focus-within:shadow-halo focus-within:ring-ring ${locked ? "opacity-60" : ""}`}>
                <input ref={amountInput} inputMode="decimal" placeholder="0.00" aria-label="Amount in USDC" value={p.amountText} readOnly={locked}
                  onChange={(e) => p.setAmountText(e.target.value.replace(/[^\d.]/g, ""))}
                  className="num h-full min-w-0 flex-1 bg-transparent text-2xl font-semibold tracking-[-0.02em] outline-none placeholder:text-muted-foreground/60 focus-visible:outline-none" />
                <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 text-sm font-medium">
                  <img src="/tokens/usdc.svg" alt="" className="size-6 rounded-full" />USDC
                </span>
              </label>
              {amountErr ? <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive"><Icon name="alert" size={13} className="mt-px shrink-0" /><span>{errText(amountErr)}</span></p>
                : <p className="mt-1.5 text-xs text-muted-foreground">{privateLimitsText(probe.limits)}</p>}
              <div className="mt-2.5"><MoneyWarning>{privateSendOnlyText(route)}</MoneyWarning></div>
            </>
          )}
        </div>

        {bound ? null : quoteBox}
        {/* Once the address is up, the refund words sit under its warning. */}
        {bound ? null : <p className="text-xs text-muted-foreground">{said(privateRefundText(route, p.refundPath))}</p>}

        {!locked && !addressErr ? (
          <div className="space-y-3">
            {quoteErr ? (
              <>
                <ErrorNote>{errText(quoteErr)}</ErrorNote>
                <ErrorActions error={quoteErr} onRetry={q.retry} onNormal={onNormal} />
              </>
            ) : serverAmountErr ? (
              /* The server refused the amount: the fix is the amount, so that is the button. */
              <Button variant="outline" size="md" className="w-full" onClick={changeAmount}>Change amount</Button>
            ) : (
              <>
                {attested ? null : (
                  <label className="flex cursor-pointer items-start gap-2.5 text-xs text-muted-foreground">
                    <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-foreground" checked={attested} onChange={(e) => { setAttested(e.target.checked); saveAttest(user, e.target.checked); }} />
                    <span>{PRIVATE_ATTEST}</span>
                  </label>
                )}
                <Button variant="primary" size="md" className="w-full" disabled={!canPress} onClick={p.getAddress}>Get address</Button>
              </>
            )}
            {p.dropped ? <MoneyWarning>{ADDRESS_DROPPED_TEXT}</MoneyWarning> : null}
          </div>
        ) : null}

        {step2 ? <StepHead n="02">One-time address</StepHead> : null}
        {step2}

        {recoverRows}

        <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-muted-foreground">{PRIVATE_FOOTER}</p>
      </div>
    </div>
  );
}

/* USDC sitting in the customer's own wallet on Base or Polygon (a refund), moved into the Main Account with no gas. Only
   when Recover can sign for this wallet (recoverReadyFor); each move is priced, verified, shown, then signed in the wallet's own
   window. Drawn on Private and on Normal, and when Private is switched off: a refund can outlive the switch. */
function RecoverRows({ user, ready = false, deps = null }) {
  const r = useStrandedRecover({ user, enabled: ready, deps });
  const j = r.job;
  /* A row just moved stays on screen with its answer, even once its balance reads 0. */
  const list = (r.rows || []).filter((x) => x.offered || (x.chainId === j.chainId && (j.status === "sent" || j.status === "failed")));
  if (!list.length) return null;
  return (
    <div className="t-swap-in space-y-2">
      <div className="flex items-baseline justify-between gap-3 border-t border-hairline pt-4">
        <span className="text-sm font-medium">Recover</span>
        <span className="text-xs text-muted-foreground">Refunds sitting on other networks</span>
      </div>
      {list.map((row) => {
        const mine = j.chainId === row.chainId;
        return (
          <div key={row.chainId} className="space-y-2 border-b border-hairline pb-3 text-sm last:border-b-0">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                {row.chainLogo ? <img src={row.chainLogo} alt="" className="size-4 rounded-full" /> : null}
                <span className="num font-medium">{privateUsdcText(row.usdc, { approx: false })}</span>
                <span className="truncate text-xs text-muted-foreground">in your wallet on {row.chainName}</span>
              </span>
              {/* No second "Move in" while one is being reviewed, signed or is on its way: the balance may still read the
                  same until it lands, and a second press would price and sign for the same funds again. */}
              {mine && (j.status === "review" || j.status === "signing" || j.status === "sent") ? null : (
                <Button variant="outline" size="sm" disabled={j.status === "pricing" || j.status === "signing"} onClick={() => r.price(row)}>
                  {mine && j.status === "pricing" ? <Spinner size={14} /> : null}Move in
                </Button>
              )}
            </div>
            {mine && (j.status === "review" || j.status === "signing") && j.review ? (
              <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                <p>
                  {customerWords(`You receive ${privateUsdcText(Number(j.review.receiveUsdc))} in your Main Account`)}{" "}
                  <span className="whitespace-nowrap text-xs text-muted-foreground">· fee {privateUsdcText(Number(j.review.costUsdc))}</span>{" "}
                  <span className="whitespace-nowrap text-xs text-muted-foreground">· no gas needed</span>
                </p>
                {r.canSign ? null : <p className="text-xs text-muted-foreground">{RECOVER_WORDS.noSigner}</p>}
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" disabled={!r.canSign || j.status === "signing"} onClick={r.confirm}>{j.status === "signing" ? <Spinner size={14} /> : null}Confirm and sign</Button>
                  <Button variant="ghost" size="sm" onClick={r.cancel}>Cancel</Button>
                </div>
              </div>
            ) : null}
            {mine && j.status === "error" ? <p className="text-xs text-destructive">{customerWords(String((j.error && j.error.message) || "Couldn't price this move. Nothing moved."))}</p> : null}
            {mine && j.status === "sent" ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner size={12} />{customerWords("On its way to your Main Account.")}</p> : null}
            {/* A refusal or a cancel is boxed like the panel's other refusals; a reply nobody saw is a warning, not an error. */}
            {mine && j.status === "failed" && j.result ? (j.result.unknown ? <MoneyWarning>{customerWords(j.result.message)}</MoneyWarning> : <ErrorNote>{customerWords(j.result.message)}</ErrorNote>) : null}
          </div>
        );
      })}
    </div>
  );
}
