import { useState } from "react";
import Popover from "../ui/Popover.jsx";
import Button from "../ui/Button.jsx";
import Icon, { GoogleMark, Spinner } from "../ui/Icon.jsx";
import { TextSwap, IconSwap, ShimmerText } from "../ui/kit/index.ts";
import LiveDot from "../ui/LiveDot.jsx";
import Tip from "../ui/Tip.jsx";
import ConnectCard from "./ConnectCard.jsx";
import { useWallet } from "../hooks/useWallet.js";
import { useBackend } from "../perp/BackendContext.jsx";

export const shortAddress = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function hoursLeft(validUntil) {
  if (!Number.isFinite(validUntil)) return null;
  const h = Math.max(0, Math.round((validUntil - Date.now()) / 3_600_000));
  return h;
}

function MethodIcon({ method }) {
  if (method === "google") return <GoogleMark size={14} />;
  if (method === "email") return <Icon name="mail" size={14} />;
  if (method === "passkey") return <Icon name="key" size={14} />;
  return <Icon name="wallet" size={14} />;
}

/** The header's account control: "Sign in" grows the sign-in list from the pill; signed in, the chip opens the
 *  account panel (address, how you signed in, the trading key, sign out). */
export default function AccountButton() {
  const w = useWallet();
  const b = useBackend();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (b.mock) {
    return (
      <span className="inline-flex h-9 items-center rounded-full border border-dashed border-input px-3 text-xs text-muted-foreground" title="VITE_PERP_BACKEND=mock">
        Mock account
      </span>
    );
  }

  if (!w.address && w.pending) {
    return (
      <span role="status" className="t-swap-in inline-flex h-9 items-center gap-2 rounded-full bg-card px-3 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border">
        <Spinner /> <ShimmerText text={w.pending === "wallet" ? "Wallet…" : "Signing in…"} />
      </span>
    );
  }

  if (!w.address) {
    return (
      <div className="relative">
        {/* 36px like every other header chip (mock, pending, account), with a 44px hit area on phones. */}
        <Button variant="primary" size="sm" className="ff-hit !h-9 !rounded-full px-4" data-popover-trigger onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}>
          Sign in
        </Button>
        <Popover open={open} onClose={() => setOpen(false)} label="Sign in" className="w-[min(22rem,calc(100vw-2rem))]">
          <p className="mb-3 px-1 text-h2">Sign in</p>
          <ConnectCard start="list" bare onDone={() => setOpen(false)} />
        </Popover>
      </div>
    );
  }

  const key = b.trading || {};
  const hrs = key.keyActive ? hoursLeft(key.validUntil) : null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(w.address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard refused */ }
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-popover-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Account ${shortAddress(w.address)}`}
        className="ff-press ff-hit t-swap-in inline-flex h-9 items-center gap-2 rounded-full bg-card pl-1 pr-2.5 ring-1 ring-inset ring-border transition-colors hover:bg-muted"
      >
        <span className="grid size-[26px] place-items-center rounded-full bg-muted"><MethodIcon method={w.user?.method} /></span>
        <span className="font-mono text-xs">{shortAddress(w.address)}</span>
        <Icon name="chevronDown" size={14} className="text-muted-foreground" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Account" className="w-[min(20rem,calc(100vw-2rem))] space-y-3">
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><MethodIcon method={w.user?.method} /> <span className="truncate">{w.user?.label || "Signed in"}</span></div>
            <div className="mt-0.5 font-mono text-sm">{shortAddress(w.address)}</div>
          </div>
          <Button variant="outline" size="sm" onClick={copy} aria-label="Copy address">
            <IconSwap state={copied ? "b" : "a"} a={<Icon name="copy" size={14} />} b={<Icon name="check" size={14} />} />
            <TextSwap text={copied ? "Copied" : "Copy"} />
          </Button>
        </div>
        <div className="flex items-center gap-2 border-y border-hairline px-1 py-2.5 text-xs">
          {key.keyActive ? (
            <><LiveDot /><span className="text-foreground">Trading on{hrs != null ? ` · ${hrs}h left` : ""}</span></>
          ) : key.auto ? (
            <>
              <span className="text-muted-foreground">Trading not on yet</span>
              <Tip title="About trading">Trading turns on with your first order. No popup.</Tip>
            </>
          ) : (
            <span className="text-muted-foreground">Trading off</span>
          )}
        </div>
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { setOpen(false); w.disconnect(); }}>
          <Icon name="logout" size={14} /> Sign out
        </Button>
      </Popover>
    </div>
  );
}
