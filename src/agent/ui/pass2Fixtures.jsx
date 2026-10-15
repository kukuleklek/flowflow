/* DEV ONLY: the Agent pass-2 cards on one page, for screenshots at 1440 and 390 (src/agent/ui/pass2-fixtures.html).
   Rendered only when import.meta.env.DEV; the page is not a build entry, so none of this ships.

     ?c=pick       PickCard: a stocks group (live 1h candles) with sample headlines, and a meme group with one chosen
     ?c=sheet      FinalTradeSheet over the thread: &s=eth (long) | short | tsla (stock), &fail=retry | lost
     ?c=closeall   CloseAllCard: BTC, CHIP, TSLA, HYPE; CHIP's close is refused (partial failure shown honestly)
     ?c=ask        AskAboutCoin in the trade page's Chat tab: HYPE (Tokenomist on), BTC held (off), TSLA (stock)
     (none)        pick + closeall + ask

   🔴 NOTHING HERE SIGNS OR SENDS. Market data is read live (read-only Hyperliquid /info and candles); every action is a
   local stand-in: onOpen and closeOne resolve after a delay, and the words a box says land in the log at the bottom. */
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import Button from "../../ui/Button.jsx";
import { usePerpMarkets } from "../../lib/hyperliquid/index.js";
import { estIsolatedLiqPx } from "../../perp/perpTicket.js";
import { usEquitySession } from "../../lib/hyperliquid/hip3/hours.js";
import { ChatActionsContext } from "../cards/ChatActions.jsx";
import PickCard from "../cards/PickCard.jsx";
import FinalTradeSheet from "../cards/FinalTradeSheet.jsx";
import CloseAllCard from "../cards/CloseAllCard.jsx";
import AskAboutCoin from "../cards/AskAboutCoin.jsx";

const Q = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
const C = Q.get("c") || "all";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();

/* Sample headlines: clearly samples, linked to example.com (the real ones come from the news lane). */
const HEADLINES = [
  { title: "Sample headline: chipmakers lead the US open as AI orders stay strong", source: "example.com", url: "https://example.com/sample-1", at: NOW - 38 * 60_000 },
  { title: "Sample headline: EV makers mixed ahead of delivery numbers", source: "example.com", url: "https://example.com/sample-2", at: NOW - 3 * 3_600_000 },
];

/* Hyperliquid-shaped positions (account layer rows), for the close-all card and the held box. */
const position = (coin, szi, entryPx, upnl, lev, value) => ({
  coin, szi, side: szi > 0 ? "long" : "short", entryPx, unrealizedPnl: upnl, returnOnEquity: upnl / (value / lev),
  positionValue: value, liquidationPx: szi > 0 ? entryPx * 0.7 : entryPx * 1.3, leverage: { type: "isolated", value: lev },
  marginUsed: value / lev + upnl, cumFunding: { sinceOpen: 0 },
});
const POSITIONS = [
  position("BTC", 0.0006, 108_200, 0.42, 3, 64.9),
  position("CHIP", 420, 0.1421, -2.1, 3, 59.7),
  position("xyz:TSLA", 0.12, 431.5, 1.1, 5, 51.8),
  position("HYPE", -1.4, 41.2, 0.05, 2, 57.6),
];

function Frame({ children, className = "" }) {
  return <div className={`overflow-hidden rounded-2xl bg-card ring-1 ring-border [container-type:inline-size] ${className}`}>{children}</div>;
}

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h2 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/* A plan priced from the live mark the way the caller would (fixture maths only: the real plan comes from the quote). */
function usePlan(kind) {
  const snap = usePerpMarkets();
  const coin = kind === "tsla" ? "xyz:TSLA" : "ETH";
  const m = snap.byCoin ? snap.byCoin[coin] : null;
  const [legs, setLegs] = useState(null);
  const plan = useMemo(() => {
    const px = m && Number.isFinite(m.px) ? m.px : kind === "tsla" ? 430 : 2400;
    const side = kind === "short" ? "sell" : "buy";
    const lev = kind === "tsla" ? 5 : 3;
    const margin = kind === "tsla" ? 10 : 20;
    const dir = side === "buy" ? 1 : -1;
    const notional = margin * lev;
    const liq = estIsolatedLiqPx({ side, entryPx: px, leverage: lev, maxLeverage: m && m.maxLeverage ? m.maxLeverage : 25 });
    return {
      coin, side, leverage: lev, marginUsdc: margin, entryPx: px, notionalUsd: notional, feeUsdc: notional * 0.00045,
      tpPx: legs ? legs.tpPx : px * (1 + dir * 0.035), slPx: legs ? legs.slPx : px * (1 - dir * 0.0175), liqPx: liq,
      szDecimals: m ? m.szDecimals : 4,
      /* The caller's own cap line: only when the guard's closed hours apply (night, weekend, holiday). */
      notes: kind === "tsla" && usEquitySession(Date.now()).closed ? ["Leverage 5x while the US market is closed."] : [],
      mathLines: kind === "short" ? ["Risk $1.00 · stop 1.75% away · fees in", "Size $60 · 3x · margin 20.00 USDC"] : [],
    };
  }, [m && m.px, m && m.szDecimals, kind, legs]); // eslint-disable-line react-hooks/exhaustive-deps
  return { plan, market: m, setLegs };
}

function SheetFixture() {
  const kind = Q.get("s") || "eth";
  const fail = Q.get("fail");
  const { plan, market, setLegs } = usePlan(kind);
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState([]);
  /* 🔴 A stand-in for the caller's send: no backend, nothing leaves the page. */
  const onOpen = async () => {
    setLog((l) => [...l, "onOpen() called"]);
    await sleep(900);
    if (fail === "retry") return { ok: false, code: "price_stale", message: "The price moved. Nothing was sent." };
    if (fail === "lost") throw new Error("socket closed");
    return { ok: true };
  };
  return (
    <div className="mx-auto max-w-[760px] space-y-4 px-4 py-6">
      <p className="text-sm text-muted-foreground">The thread sits behind the sheet. onOpen calls: {log.length}</p>
      <PickCard card={{ kind: "pick", group: "movers", tiles: [{ coin: "BTC" }, { coin: "ETH" }, { coin: "SOL" }, { coin: "HYPE" }] }} onPick={() => {}} />
      <Button variant="outline" onClick={() => setOpen(true)}>Open the sheet again</Button>
      <FinalTradeSheet open={open} onClose={() => setOpen(false)} plan={plan} market={market} onOpen={onOpen}
        onEdit={({ tpPx, slPx }) => setLegs({ tpPx, slPx })} />
    </div>
  );
}

function PickFixtures() {
  return (
    <Section title="PickCard · item 12">
      <PickCard card={{ kind: "pick", group: "stocks", line: "AI stocks moving most today. Pick one.", headlines: HEADLINES,
        tiles: [{ coin: "xyz:NVDA" }, { coin: "xyz:TSLA" }, { coin: "xyz:AMD" }, { coin: "xyz:PLTR" }] }} />
      <PickCard card={{ kind: "pick", group: "meme", line: "Meme coins moving today. Pick one.", chosen: "kPEPE",
        tiles: [{ coin: "DOGE" }, { coin: "kPEPE" }, { coin: "WIF" }, { coin: "FARTCOIN" }] }} />
    </Section>
  );
}

function CloseAllFixture() {
  const [key, setKey] = useState(0);
  /* 🔴 A stand-in for closeFraction(coin, 1): CHIP is refused, the rest "close". Nothing is sent anywhere. */
  const closeOne = async (coin) => {
    await sleep(700);
    if (coin === "CHIP") return { ok: false, code: "rate_limited", message: "Too many requests. Try again in a moment." };
    return { ok: true };
  };
  return (
    <Section title="CloseAllCard · item 7">
      <Frame key={key}>
        <CloseAllCard positions={POSITIONS} closeOne={closeOne} />
      </Frame>
      <Button variant="ghost" size="sm" onClick={() => setKey((k) => k + 1)}>Reset</Button>
    </Section>
  );
}

function AskFixtures() {
  const btc = POSITIONS[0];
  return (
    <Section title="AskAboutCoin · item 18 (the trade page's Chat tab)">
      <div className="grid gap-4 lg:grid-cols-3">
        {[
          { coin: "HYPE", tokenomist: true },
          { coin: "BTC", tokenomist: false, position: btc },
          { coin: "xyz:TSLA" },
        ].map((f) => (
          <div key={f.coin} className="w-full max-w-[380px] rounded-2xl bg-card p-5 ring-1 ring-border">
            <AskAboutCoin coin={f.coin} position={f.position || null} tokenomist={f.tokenomist} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function Fixtures() {
  const [said, setSaid] = useState([]);
  const actions = useMemo(() => ({ send: (t) => setSaid((s) => [...s.slice(-4), t]), busy: false, navigate: () => {}, coin: null }), []);
  useEffect(() => { document.body.dataset.fixture = C; }, []);
  if (C === "sheet") return <ChatActionsContext.Provider value={actions}><SheetFixture /></ChatActionsContext.Provider>;
  return (
    <ChatActionsContext.Provider value={actions}>
      <main className="mx-auto max-w-[1200px] space-y-8 px-4 pb-24 pt-6">
        <h1 className="text-h1">Agent pass 2 · dev fixtures</h1>
        {C === "all" || C === "pick" ? <div className="max-w-[760px]"><PickFixtures /></div> : null}
        {C === "all" || C === "closeall" ? <div className="max-w-[760px]"><CloseAllFixture /></div> : null}
        {C === "all" || C === "ask" ? <AskFixtures /> : null}
        <div className="font-mono text-[11px] text-muted-foreground" aria-live="polite">
          Said to FlowFlow: {said.length ? said.map((s) => `"${s}"`).join(" · ") : "nothing yet"}
        </div>
      </main>
    </ChatActionsContext.Provider>
  );
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")).render(<StrictMode><Fixtures /></StrictMode>);
}
