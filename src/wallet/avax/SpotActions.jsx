/* The Spot Account's actions as drop-in pieces for the lean Wallet page (owner, 2026-10-15: one balance, no account
   cards — WalletPage.jsx no longer mounts AvaxWalletCard). WalletPage owns `?panel=` and its band; these three let it
   host the Spot panels exactly where Deposit / Withdraw open:

     spotPanelKind(raw)     `?panel=` → "swap" | "move-in" | "move-out" | "stake" | "unstake" (+ the Agent's "earn"),
                            or null — with VITE_EARN off only the EXITS (move-out, unstake, a swap back to USDC)
     <SpotPanelHost />      the open panel (review → one Confirm → visible Privy windows), for the band
     <SpotActions />        the pill row under Deposit / Withdraw (disabled "Opens after the live test" with the flag off)

   🔴 NOTHING HERE MOVES MONEY BY ITSELF. A pill only opens a panel; a panel only prices what was typed and confirms on
   one tap (avax/AvaxPanels.jsx). No recipient anywhere: money only moves between the customer's own accounts. */
import { useSearchParams } from "react-router-dom";
import { useBackend } from "../../perp/BackendContext.jsx";
import { useAvaxMoney } from "../../avax/useAvaxMoney.js";
import { pctText } from "../portfolio.js";
import { EARN_ON, ActionPill, ClosedNote, openPanelKind } from "./AvaxWallet.jsx";
import SpotPanel from "./AvaxPanels.jsx";
import SpotMoves from "./SpotMoves.jsx";
import { exitsOpen } from "./panelView.js";

/** `?panel=` → a Spot panel kind, or null. With VITE_EARN off only an exit panel opens (plan §3.3: exits never wait). */
export function spotPanelKind(raw) {
  return openPanelKind(raw);
}

/** The open Spot panel, for WalletPage's band. A stake opened by the Agent (`?panel=earn&amount=5`) starts with that
 *  amount typed in — never priced or confirmed by itself. */
export function SpotPanelHost({ kind, v, onBack }) {
  const b = useBackend();
  const [params] = useSearchParams();
  const k = spotPanelKind(kind);
  if (!k) return null;
  const raw = params.get("amount");
  /* The chat hands over an amount (any panel) and, for a swap, the two coins: typed in, never priced or confirmed by
     themselves. */
  const handed = typeof raw === "string" && /^\d{1,6}(\.\d{1,6})?$/.test(raw) ? raw : null;
  const pair = k === "swap" ? { from: params.get("from"), to: params.get("to") } : null;
  return <SpotPanel key={k} kind={k} v={v} earnOn={EARN_ON} mock={!!b.mock} onClose={onBack} initialAmount={handed} initialPair={pair} />;
}

/* Keeps this account's flow watcher running while the Wallet shows (it settles a move whose outcome was unknown, with
   evidence). The page's own "On its way" list draws the moving ones; a move that is NOT CONFIRMED is drawn here too,
   with where to look and its "Check status" link (plan §3.6) — the page's row has neither, and the panel that ran it
   may have been closed. */
function WatchMoves() {
  useAvaxMoney();
  return <SpotMoves unknownOnly />;
}

/**
 * The pill row: Swap · Move in · Move out · Stake x% · Unstake (only when something is staked).
 *   v        usePortfolio()'s view
 *   panel    the open `?panel=` (for the toggle at xl)   go(kind|null) opens / closes it
 *   toggles  a second press closes the panel (WalletPage's xl disclosure rule)
 *   moves    draw "Moves in progress" here (true), or only keep the watcher running (false: the page lists them)
 */
export function SpotActions({ v, panel = null, go, toggles = false, moves = false, className = "" }) {
  const staked = !!(v && v.aave && v.aave.status === "ok" && v.aave.suppliedUsdc > 0);
  const exits = exitsOpen(v);
  const apy = v && v.aave && v.aave.apyPct != null ? pctText(v.aave.apyPct) : null;
  const open = (k) => () => go(toggles && panel === k ? null : k);
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <ActionPill glyph="swap" exit={exits.swap} onClick={open("swap")}>Swap</ActionPill>
        <ActionPill glyph="in" onClick={open("move-in")}>Move in</ActionPill>
        <ActionPill glyph="out" exit={exits.moveOut} onClick={open("move-out")}>Move out</ActionPill>
        <ActionPill glyph="stake" primary onClick={open("stake")}>{apy ? `Stake ${apy}` : "Stake"}</ActionPill>
        {staked ? <ActionPill glyph="out" exit={exits.unstake} onClick={open("unstake")}>Unstake</ActionPill> : null}
        <ClosedNote className="ml-1" />
      </div>
      {EARN_ON || exits.any ? (moves ? <SpotMoves /> : <WatchMoves />) : null}
    </div>
  );
}
