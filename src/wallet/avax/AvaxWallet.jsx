/* The Spot Account (the owner's name for the Avax wallet: the customer's own wallet on Avalanche, the same address as
   the Main Account): every whitelisted coin it holds with its USD value and, inside it, "USDC Staked AAVE" (the Aave V3
   USDC position on AVAX, with its live APY). Owner: "USDC Staked AAVE บน AVAX อยู่ใน Spot อีกที".

   🔴 NOTHING IN THIS FILE MOVES MONEY. The Move in / Stake pills (and a swap INTO anything) stay disabled ("Opens
   after the live test") unless the build says VITE_EARN=on. THE EXITS NEVER WAIT FOR THE FLAG (plan §3.3): Move out,
   Unstake and a swap back to USDC open whenever the Spot Account holds something to take out (panelView exitsOpen),
   so a build with the entries off can never strand money here. An open pill opens its panel IN PLACE of the card's
   body (the Main Account card's Deposit / Withdraw pattern, `?panel=` in the URL): avax/AvaxPanels.jsx, where the
   customer reviews every figure and confirms with one tap, and every signature is a visible Privy window
   (src/avax/money.js → src/avax/signers.js). A panel never takes a recipient: money only ever moves between the
   customer's own Main Account, Spot Account and Aave. Unknown is "—", never 0; an asset with no price says "No price"
   and the part is partial. */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { AutoHeight } from "../../ui/kit/index.ts";
import Icon from "../../ui/Icon.jsx";
import Tip from "../../ui/Tip.jsx";
import { MoneyHero } from "../../ui/Money.jsx";
import TickNumber from "../../ui/TickNumber.jsx";
import { MarkDisc, ImgDisc, TokenDisc } from "../TotalBalance.jsx";
import { usdText, pctText, STAKED_LABEL, STAKED_WHERE } from "../portfolio.js";
import { whitelistAssets } from "../../lib/avax/whitelist.js";
import { useBackend } from "../../perp/BackendContext.jsx";
import SpotPanel from "./AvaxPanels.jsx";
import SpotMoves from "./SpotMoves.jsx";
import { panelKind, exitsOpen, EXIT_PANELS } from "./panelView.js";

/* The whitelist's logos that ship with the app (the rest draw their initial). */
const LOGOS = new Set(["/tokens/usdc.svg", "/tokens/usdt.svg", "/hl-coins/AVAX.svg", "/hl-coins/BTC.svg"]);

export const EARN_ON = import.meta.env.VITE_EARN === "on";
const CLOSED = "Opens after the live test";

/** `?panel=` → the panel it may open: any of them with the flag on; with it off only an EXIT panel (a swap panel then
 *  only sells back into USDC — AvaxPanels' exit-only swap). */
export function openPanelKind(raw) {
  const k = panelKind(raw);
  return EARN_ON ? k : k && EXIT_PANELS.includes(k) ? k : null;
}

/* Small pill action (USER-REQUESTS E): 32px tall with a 44px hit area, glyph + 1–3 words. */
const PILL = "ff-press ff-hit inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-card px-3 text-xs font-medium text-foreground ring-1 ring-inset ring-border transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-45";
const PILL_ON = "ff-press ff-hit inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-foreground px-3 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:pointer-events-none disabled:opacity-45";

function Glyph({ name, size = 14 }) {
  const d = {
    swap: "M7 7h11l-3-3M17 17H6l3 3",
    in: "M12 4v12m0 0-5-5m5 5 5-5M5 20h14",
    out: "M12 20V8m0 0-5 5m5-5 5 5M5 4h14",
    stake: "M12 3v12m0 0-4-4m4 4 4-4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
    lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** One action pill: disabled until the live test (VITE_EARN=on), else it opens its panel in place. An `exit` pill
 *  (Move out, Unstake, a swap back to USDC — only when there is something to take out) is open whatever the flag says. */
export function ActionPill({ glyph, children, primary = false, onClick = null, exit = false }) {
  const open = EARN_ON || exit;
  return (
    <button
      type="button"
      className={primary && open ? PILL_ON : PILL}
      disabled={!open || !onClick}
      title={open ? undefined : CLOSED}
      onClick={() => { if (open && onClick) onClick(); }}
    >
      <Glyph name={glyph} />
      {children}
    </button>
  );
}

/** The quiet reason beside disabled pills (a blocked action's reason stays printed, USER-REQUESTS D2). */
export function ClosedNote({ className = "" }) {
  if (EARN_ON) return null;
  return <span className={`inline-flex items-center gap-1.5 text-[11px] text-muted-foreground ${className}`}><Glyph name="lock" size={12} />{CLOSED}</span>;
}

/* An asset's row: logo, symbol and name, its USD value and the amount held. */
function AssetRow({ a }) {
  return (
    <li className="flex min-h-14 items-center gap-3 border-t border-hairline py-2 first:border-t-0">
      <ImgDisc src={a.logo} label={a.symbol} size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{a.symbol}</span>
          {a.role === "gas" ? <span className="inline-flex h-[18px] items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">Gas</span> : null}
          {a.tip ? <Tip align="start" title={`About ${a.symbol}`}>{a.tip}</Tip> : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{a.name}</span>
      </span>
      <span className="shrink-0 text-right">
        {a.status === "unknown"
          ? <span className="num block text-sm text-muted-foreground">—</span>
          : a.status === "unpriced"
            ? <span className="block text-xs text-muted-foreground">No price</span>
            : <TickNumber value={a.usdText} className="num block text-sm font-medium" />}
        <span className="num block text-xs text-muted-foreground">{a.amountText === "—" ? "—" : `${a.amountText} ${a.symbol}`}</span>
      </span>
    </li>
  );
}

const CARD = "rounded-2xl border bg-card p-5";

/** The card's head: mark, name, one short line, and the one figure. */
function Head({ mark, title, sub, right = null }) {
  return (
    <div className="flex items-start gap-3">
      <MarkDisc name={mark} size={40} />
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold leading-tight tracking-[-0.01em]">{title}</h2>
        {sub ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}

function Figure({ part }) {
  if (part && part.status === "off") return <span className="num text-muted-foreground">—</span>;
  if (!part || part.status === "loading") return <span className="skeleton-shimmer block h-8 w-36 rounded-lg" />;
  if (part.usd == null) return <span className="num text-muted-foreground">—</span>;
  return <MoneyHero text={usdText(part.usd)} />;
}

/* USDC Staked AAVE: a holding of the Spot Account, drawn as one more row of its list (USDC on Avalanche, the live APY). */
function StakedRow({ a, mock }) {
  const apy = a && a.apyPct != null ? `${pctText(a.apyPct)} APY` : null;
  const sub = [apy, STAKED_WHERE].filter(Boolean).join(" · ");
  const note = a && a.paused ? "Paused right now" : a && a.frozen ? "Takes no new USDC right now" : null;
  let right;
  if (!a || a.status === "loading") right = <span className="skeleton-shimmer inline-block h-3.5 w-16 rounded" />;
  else if (mock || a.status === "off") right = <span className="block text-xs text-muted-foreground">Live only</span>;
  else if (a.status === "unknown" || a.usd == null) right = <span className="num block text-sm text-muted-foreground">—</span>;
  else {
    right = (
      <>
        <TickNumber value={a.usdText} className="num block text-sm font-medium" />
        <span className="num block text-xs text-muted-foreground">
          {a.suppliedUsdc > 0 ? `${a.suppliedUsdc.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC` : "Not staked"}
        </span>
      </>
    );
  }
  return (
    <li className="flex min-h-14 items-center gap-3 border-t border-hairline py-2 first:border-t-0">
      {/* USDC on Avalanche, not the provider mark (owner: only the Tokenomist and Avax logos show). */}
      <TokenDisc token="USDC" chain="Avalanche" size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{STAKED_LABEL}</span>
          <Tip align="start" title="How staking works">The rate is variable and set by Aave. Staked USDC stays yours and can be taken out while Aave has free liquidity.</Tip>
        </span>
        <span className={`block truncate text-xs ${apy ? "text-success" : "text-muted-foreground"}`}>{sub}</span>
        {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
      </span>
      <span className="shrink-0 text-right">{right}</span>
    </li>
  );
}

/** `?panel=` for the Spot Account's panels (swap | move-in | move-out | stake | unstake, + the Agent's "earn" and an
 *  `amount` it hands over). The Main Account card reads the same key for deposit / withdraw, so one panel is open on
 *  the page at a time. Replace, never push (WalletPage's own rule). */
function useSpotPanel() {
  const [params, setParams] = useSearchParams();
  const kind = openPanelKind(params.get("panel"));
  const amount = params.get("amount");
  const go = (k) => {
    const next = new URLSearchParams(params);
    next.delete("amount"); next.delete("from"); next.delete("to");
    if (k) next.set("panel", k); else next.delete("panel");
    setParams(next, { replace: true });
  };
  const pair = kind === "swap" ? { from: params.get("from"), to: params.get("to") } : null;
  return [kind, go, typeof amount === "string" && /^\d{1,6}(\.\d{1,6})?$/.test(amount) ? amount : null, pair];
}

/** The Spot Account card: its one figure (coins + staked USDC), every coin held, the staked row, the actions; or,
 *  with a panel open, that panel in its place (the motion kit's morph: AutoHeight + a keyed body, as the Main Account's).
 *  `v` is usePortfolio()'s view. */
export function AvaxWalletCard({ v, id = "spot" }) {
  const b = useBackend();
  const [panel, go, handed, pair] = useSpotPanel();
  const ref = useRef(null);

  /* A panel opened on a phone: bring the card to the top of the screen (MainCard's own rule). */
  useEffect(() => {
    if (!panel || !ref.current || typeof window.matchMedia !== "function") return undefined;
    if (window.matchMedia("(min-width: 1024px)").matches) return undefined;
    const t = setTimeout(() => ref.current && ref.current.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(t);
  }, [panel]);

  if (panel) {
    return (
      <section id={id} ref={ref} className={`${CARD} scroll-mt-20 pt-1`}>
        <AutoHeight>
          <div key={panel} className="t-swap-in">
            <SpotPanel kind={panel} v={v} earnOn={EARN_ON} mock={!!b.mock} onClose={() => go(null)} initialAmount={handed} initialPair={pair} />
          </div>
        </AutoHeight>
      </section>
    );
  }
  return (
    <section id={id} ref={ref} className={`${CARD} scroll-mt-20`}>
      <AutoHeight>
        <div key="home"><SpotHome v={v} go={go} /></div>
      </AutoHeight>
    </section>
  );
}

/** The card's home body. */
function SpotHome({ v, go }) {
  const part = v.avax;
  const off = !!(part && part.status === "off");
  const held = v.assets.filter((a) => a.held);
  const unread = v.assets.filter((a) => a.status === "unknown");
  const idle = v.assets.filter((a) => !a.held && a.status !== "unknown");
  const staked = v.aave && v.aave.status === "ok" && v.aave.suppliedUsdc > 0;
  const exits = exitsOpen(v);
  const coins = part && part.held != null ? `${part.held} coin${part.held === 1 ? "" : "s"}` : null;
  let sub = [coins, staked ? `${usdText(v.aave.usd)} staked` : null].filter(Boolean).join(" · ") || null;
  if (off) sub = null;
  else if (part && part.status === "unknown") sub = "Couldn't read";
  else if (part && part.status === "loading") sub = null;
  return (
    <>
      <Head mark="avalanche" title="Spot Account" sub={sub} />
      {off ? null : (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <div className="text-[1.9rem] font-semibold leading-none tracking-[-0.03em]"><Figure part={part} /></div>
          {part && part.status === "partial" ? <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">Partial</span> : null}
        </div>
      )}

      {off ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex -space-x-1.5">{whitelistAssets().map((x) => <ImgDisc key={x.symbol} src={LOGOS.has(x.logo) ? x.logo : null} label={x.symbol} size={20} />)}</span>
          <span>Shows on a live account</span>
        </div>
      ) : null}

      <ul className="mt-3">
        {off ? null : part && part.status === "loading" ? (
          [0, 1, 2].map((i) => (
            <li key={i} className="flex min-h-14 items-center gap-3 border-t border-hairline first:border-t-0">
              <span className="skeleton-shimmer size-8 rounded-full" />
              <span className="skeleton-shimmer h-3.5 w-20 rounded" />
              <span className="skeleton-shimmer ml-auto h-3.5 w-16 rounded" />
            </li>
          ))
        ) : (
          [...held, ...unread].map((a) => <AssetRow key={a.symbol} a={a} />)
        )}
        {part && part.status === "loading" ? null : <StakedRow a={v.aave} mock={off} />}
      </ul>
      {!off && part && part.status === "unknown" ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="info" size={14} />Couldn't read the Spot Account just now. Not counted in the total.</p>
      ) : null}
      {!off && part && part.status !== "loading" && part.status !== "unknown" && !held.length && !unread.length ? (
        <p className="mt-2 text-xs text-muted-foreground">No coins here yet.</p>
      ) : null}

      {idle.length && !off && part && part.status !== "loading" ? (
        <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3 text-xs text-muted-foreground">
          <span className="flex -space-x-1.5">{idle.map((a) => <ImgDisc key={a.symbol} src={a.logo} label={a.symbol} size={20} />)}</span>
          <span className="min-w-0 truncate">{idle.map((a) => a.symbol).join(" · ")} at 0</span>
          <Tip align="end" title="Which coins show here">Your Spot Account holds these coins: USDC, AVAX, WAVAX, BTC.b, USDT and XAUt0.</Tip>
        </div>
      ) : null}

      {EARN_ON || exits.any ? <SpotMoves /> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ActionPill glyph="swap" exit={exits.swap} onClick={() => go("swap")}>Swap</ActionPill>
        <ActionPill glyph="in" onClick={() => go("move-in")}>Move in</ActionPill>
        <ActionPill glyph="out" exit={exits.moveOut} onClick={() => go("move-out")}>Move out</ActionPill>
        <ActionPill glyph="stake" primary onClick={() => go("stake")}>{v.aave && v.aave.apyPct != null ? `Stake ${pctText(v.aave.apyPct)}` : "Stake"}</ActionPill>
        {staked ? <ActionPill glyph="out" exit={exits.unstake} onClick={() => go("unstake")}>Unstake</ActionPill> : null}
        <ClosedNote className="ml-1" />
      </div>
    </>
  );
}
