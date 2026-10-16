import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AutoHeight, ShimmerText, SuccessCheck, TextSwap, rise } from "../ui/kit/index.ts";
import Icon, { GoogleMark, Spinner } from "../ui/Icon.jsx";
import Button from "../ui/Button.jsx";
import { LogoMark } from "../ui/Logo.jsx";
import { useWallet } from "../hooks/useWallet.js";
import {
  getPrivyMethods, isPrivyConfigured, loadPrivyMethods, loginWithEmailCode, loginWithGoogle, loginWithPasskey,
  requestPrivyMount, sendEmailCode, signupWithPasskey, subscribePrivyMethods,
} from "../services/privy.js";
import { methodOn } from "../services/privyMethods.js";

/* The motion kit's connect card, with Privy's headless sign-in in the rows instead of
   wallet extensions. The button opens into Log in / Sign up, each opens into its list inside the same card
   (AutoHeight + t-swap-in), rows rise in one after another, the chosen row shimmers "Connecting…", then a check,
   and Back plays the morph in reverse. Its only modal host is the first-visit welcome (WelcomeModal), which draws
   this same card, so there is still one sign-in path.
   Google and email are one flow for both (Privy makes the account on first use); a passkey is not: logging in
   needs one already, so Sign up offers "Create a passkey" (signupWithPasskey) and Log in "Use your passkey". */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Row({ i, icon, title, sub, onClick, disabled, pending, done }) {
  const r = rise(i);
  return (
    <li className={`${r.className} border-b border-hairline`} style={r.style}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex min-h-14 w-full items-center justify-between gap-3 px-1 py-2 text-left transition-colors hover:bg-foreground/[.022] disabled:cursor-not-allowed"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card ring-1 ring-inset ring-border">{icon}</span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{title}</span>
            <span className="block text-xs text-muted-foreground">
              {done ? <span className="text-foreground">Connected</span> : pending ? <ShimmerText text="Connecting…" /> : sub}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-muted-foreground">
          {done ? <SuccessCheck size={20} className="text-success" /> : pending ? <Spinner /> : <Icon name="chevronRight" size={16} />}
        </span>
      </button>
    </li>
  );
}

/* The Back header of the list, email and code views: ghost Back, the view's name truly centred (equal side
   columns, so a long title like "Sign up with email" never drifts off the card's axis). */
function BackHead({ onBack, title }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      <Button variant="ghost" size="sm" className="-ml-2 justify-self-start" onClick={onBack}><Icon name="arrowLeft" size={14} /> Back</Button>
      <span className="whitespace-nowrap text-sm font-medium">{title}</span>
      <span aria-hidden="true" />
    </div>
  );
}

const TEXT_INPUT = "h-11 w-full rounded-lg bg-input/30 px-3 text-sm ring-1 ring-inset ring-input outline-none transition-[background-color,box-shadow] focus:bg-card focus:shadow-halo focus:ring-ring focus-visible:outline-none";
const CODE_INPUT = "num h-12 w-full rounded-lg bg-input/30 px-3 text-center text-xl tracking-[0.4em] ring-1 ring-inset ring-input outline-none transition-[background-color,box-shadow] focus:bg-card focus:shadow-halo focus:ring-ring focus-visible:outline-none";

/**
 * @param {{ start?: "button"|"list"|"pair", onDone?: () => void, onBegin?: (kind: string) => void, title?: string, sub?: string, bare?: boolean }} props
 *   start "list" skips the Connect button (the header popover); "pair" opens on two buttons, Sign in and Sign up,
 *   each going straight to its list (the welcome modal). bare drops the card's own frame. onBegin is told a sign-in
 *   is starting (before Google's redirect), so a host can remember where it began.
 */
export default function ConnectCard({ start = "button", onDone, onBegin, title = "Sign in", sub = "Long, short or ask FlowFlow.", bare = false }) {
  const w = useWallet();
  const first = start === "list" ? "choose" : start;
  /* The welcome's buttons say "Sign in" (owner), so its lists do too; the header keeps "Log in". */
  const logIn = start === "pair" ? "Sign in" : "Log in";
  const [view, setView] = useState(first); // button | choose | list | email | code
  const [mode, setMode] = useState("login"); // login | signup
  const [pending, setPending] = useState(null); // google | email | code | passkey
  const [error, setError] = useState(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const attempt = useRef(0);
  const configured = isPrivyConfigured();
  const signedIn = !!w.address;
  /* Only the methods the Privy dashboard has on get a row (unknown: all of them). */
  const methods = useSyncExternalStore(subscribePrivyMethods, getPrivyMethods, getPrivyMethods);

  useEffect(() => { if (configured) loadPrivyMethods(); }, [configured]);
  useEffect(() => { if (view !== "button" && view !== "pair") requestPrivyMount(); }, [view]);

  /* Signed in: hold the check for the kit's success beat, then hand over. */
  useEffect(() => {
    if (!signedIn || !onDone) return undefined;
    const t = setTimeout(onDone, 700);
    return () => clearTimeout(t);
  }, [signedIn, onDone]);

  const run = async (kind, fn) => {
    const my = ++attempt.current;
    try { onBegin?.(kind); } catch { /* the host's bookkeeping never blocks a sign-in */ }
    setPending(kind);
    setError(null);
    try {
      await fn();
      if (attempt.current !== my) return false;
      return true;
    } catch (e) {
      if (attempt.current !== my) return false;
      const msg = String(e?.message || e || "");
      setError(/cancel|closed|abort/i.test(msg) ? null : msg || "That didn't work. Try again.");
      return false;
    } finally {
      if (attempt.current === my) setPending(null);
    }
  };

  const back = () => {
    attempt.current++;
    setPending(null);
    setError(null);
    setView(view === "code" ? "email" : view === "email" ? "list" : view === "list" ? (start === "pair" ? "pair" : "choose") : first);
  };

  const busy = !!pending;

  let body;
  if (!configured) {
    body = (
      <p key="off" className="t-swap-in text-sm text-muted-foreground">
        Sign-in needs <span className="num">VITE_PRIVY_APP_ID</span>. Add it to <span className="num">.env.local</span>.
      </p>
    );
  } else if (!signedIn && w.pending) {
    body = (
      <div key={`pending-${w.pending}`} className="t-swap-in flex items-center justify-center gap-2 py-2 text-sm font-medium" role="status">
        <Spinner />
        <ShimmerText text={w.pending === "wallet" ? "Setting up your wallet…" : "Signing you in…"} />
      </div>
    );
  } else if (signedIn) {
    body = (
      <div key="done" className="t-swap-in flex items-center justify-center gap-2 py-2 text-sm font-medium">
        <SuccessCheck size={22} className="text-success" />
        <TextSwap text="Signed in" />
      </div>
    );
  } else if (view === "button") {
    body = (
      <div key="button" className="t-swap-in w-full space-y-3">
        <Button variant="primary" size="lg" className="w-full" onClick={() => setView("choose")}>
          <Icon name="wallet" size={18} /> Sign in
        </Button>
      </div>
    );
  } else if (view === "pair") {
    const pick = (m) => { setMode(m); setError(null); setView("list"); };
    body = (
      <div key="pair" className="t-swap-in w-full space-y-2.5">
        <Button variant="primary" size="xl" className="w-full !h-[52px] !rounded-[14px]" onClick={() => pick("login")}>Sign in</Button>
        <Button variant="outline" size="xl" className="w-full !h-[52px] !rounded-[14px]" onClick={() => pick("signup")}>Sign up</Button>
      </div>
    );
  } else if (view === "choose") {
    const pick = (m) => { setMode(m); setError(null); setView("list"); };
    body = (
      <div key="choose" className="t-swap-in w-full space-y-3 text-left">
        {start === "button" ? <BackHead onBack={back} title="Sign in" /> : null}
        <ul className="border-t border-hairline" aria-label="Log in or sign up">
          <Row i={0} icon={<Icon name="wallet" size={16} />} title="Log in" sub="Have an account" onClick={() => pick("login")} />
          <Row i={1} icon={<Icon name="plus" size={16} />} title="Sign up" sub="New here" onClick={() => pick("signup")} />
        </ul>
      </div>
    );
  } else if (view === "list") {
    const signup = mode === "signup";
    const rows = [
      methodOn(methods, "google") && { key: "google", icon: <GoogleMark />, title: signup ? "Sign up with Google" : `${logIn} with Google`,
        sub: signup ? "Wallet made for you" : "Your Google account",
        pending: pending === "google", onClick: () => run("google", loginWithGoogle) },
      methodOn(methods, "email") && { key: "email", icon: <Icon name="mail" size={16} />, title: signup ? "Sign up with email" : `${logIn} with email`,
        sub: "One-time code", onClick: () => { setError(null); setView("email"); } },
      signup
        ? methodOn(methods, "passkeySignup") && { key: "passkey", icon: <Icon name="key" size={16} />, title: "Create a passkey",
          sub: "Face ID, Touch ID", pending: pending === "passkey", onClick: () => run("passkey", signupWithPasskey) }
        : methodOn(methods, "passkey") && { key: "passkey", icon: <Icon name="key" size={16} />, title: "Use your passkey",
          sub: "Face ID, Touch ID", pending: pending === "passkey", onClick: () => run("passkey", loginWithPasskey) },
    ].filter(Boolean);
    body = (
      <div key={`list-${mode}`} className="t-swap-in w-full space-y-3 text-left">
        <BackHead onBack={back} title={signup ? "Sign up" : logIn} />
        {rows.length ? (
          <ul className="border-t border-hairline" aria-label="Ways to sign in">
            {rows.map(({ key, ...r }, i) => <Row key={key} i={i} disabled={busy} {...r} />)}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Sign-in is switched off in this app's Privy dashboard.</p>
        )}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
    );
  } else if (view === "email") {
    const ok = EMAIL_RE.test(email.trim());
    body = (
      <form
        key="email"
        className="t-swap-in w-full space-y-3 text-left"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok || busy) return;
          if (await run("email", () => sendEmailCode(email.trim()))) setView("code");
        }}
      >
        <BackHead onBack={back} title={mode === "signup" ? "Sign up with email" : `${logIn} with email`} />
        <input
          autoFocus
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-label="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={TEXT_INPUT}
        />
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!ok || busy}>
          {pending === "email" ? <><Spinner /> <ShimmerText text="Sending code…" /></> : "Send code"}
        </Button>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </form>
    );
  } else {
    const ok = /^\d{6}$/.test(code);
    body = (
      <form
        key="code"
        className="t-swap-in w-full space-y-3 text-left"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok || busy) return;
          await run("code", () => loginWithEmailCode(code));
        }}
      >
        <BackHead onBack={back} title="Check your email" />
        <p className="text-xs text-muted-foreground">We sent a 6-digit code to <span className="font-medium text-foreground">{email.trim()}</span>.</p>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="6-digit code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className={CODE_INPUT}
        />
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!ok || busy}>
          {pending === "code" ? <><Spinner /> <ShimmerText text="Checking…" /></> : "Verify"}
        </Button>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </form>
    );
  }

  const inner = (
    <>
      {start === "button" ? (
        <div className="flex flex-col items-center gap-2 text-center">
          <LogoMark size={40} className="mb-1" />
          <span className="block text-h1">{title}</span>
          <span className="max-w-[34ch] text-sm text-muted-foreground">{sub}</span>
        </div>
      ) : null}
      <AutoHeight className="w-full"><div className="pt-0.5">{body}</div></AutoHeight>
    </>
  );

  if (bare) return <div className="flex w-full flex-col gap-4">{inner}</div>;
  return (
    <div className="flex w-full flex-col items-center gap-5 rounded-xl bg-card px-6 py-8 text-center ring-1 ring-border sm:px-8">
      {inner}
    </div>
  );
}
