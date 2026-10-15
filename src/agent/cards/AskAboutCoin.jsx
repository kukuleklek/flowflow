/* The trade page's Chat tab, empty (item 18; owner, on /trade/HYPE: "ในหน้าเทรด Agent ควรจะแบบ "Ask Me About (Logo) HYPE" แล้วมี
   กล่องแบบ Checking Emission Analytic with Tokenomist, Check News and trend, check tokenomic unlock to do position ไรงี้อะ").
   It replaces "Reads markets and your account. Every order waits for your confirm." and the generic 01 / 02 / 03
   prompts: the heading names THIS market with its logo, one quiet line of its live figures (data, no sentence), then
   three compact boxes — each an icon, 2–4 words and a tiny sub line — that run the real thing for this market:

     crypto   Emission & unlocks (Analyze with [Tokenomist] when the key is on; else "Unlocks", muted, not connected)
              · News & trend · Plan a position (held: Your position, with its live P&L)
     stock    US market · open / closed (hours.js) · Earnings & news · Plan a position / Your position. No Tokenomist.

   A box only says words (askAboutView.js ASK_WORDS) through the thread's own send, exactly as if typed — or through
   onAsk when the caller passes one. Nothing here signs, sends or moves money. */
import { useEffect, useState } from "react";
import { rise } from "../../ui/kit/index.ts";
import CoinLogo from "../../ui/CoinLogo.jsx";
import Icon from "../../ui/Icon.jsx";
import SponsorLogo from "../../ui/SponsorLogo.jsx";
import { minus } from "../../ui/num.js";
import { usePerpMarkets, formatHlPrice } from "../../lib/hyperliquid/index.js";
import { positionView } from "../../perp/live/perpLiveView.js";
import { useChatActions, tokenomistFor, Glyph } from "./ChatActions.jsx";
import { askAboutView } from "./askAboutView.js";
import { usMarketView } from "./usMarketView.js";
import { pctText, toneOfPct, stockKindOf } from "./viewWords.js";

const TONE = { pos: "text-success", neg: "text-destructive", warn: "text-warning" };
const DOT = { pos: "bg-success", warn: "bg-warning", muted: "bg-muted-foreground" };

/* The two glyphs the shared sets lack, in their stroke language (24 grid, round caps). */
function BoxGlyph({ name, size = 16 }) {
  if (name === "lock" || name === "target") return <Glyph name={name} size={size} />;
  const d = {
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2",
    news: "M5 5.5h11v13H7.5A2.5 2.5 0 0 1 5 16V5.5Zm11 4h2.5V16a2.5 2.5 0 0 1-2.5 2.5M8.5 9h4M8.5 12h4M8.5 15h2.5",
  }[name];
  if (!d) return <Icon name="chart" size={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function useMinuteClock(given) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (given != null) return undefined;
    const id = setInterval(() => setT(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [given]);
  return given ?? t;
}

/**
 * @param coin        the page's market ("HYPE", "xyz:TSLA")
 * @param position    the account's position on it (account.positions.byCoin[coin]), or null
 * @param tokenomist  override (tests, fixtures); default: the build's key is on AND Tokenomist covers the coin
 * @param onAsk       (words) => void; default: the thread's send (ChatActions)
 * @param now         the clock for the US market's state (stocks); defaults to now, a minute at a time
 */
export default function AskAboutCoin({ coin, position = null, tokenomist = undefined, onAsk = null, now = null, className = "" }) {
  const snap = usePerpMarkets();
  const ctx = useChatActions();
  const clock = useMinuteClock(now);
  const market = (snap.byCoin && snap.byCoin[coin]) || null;
  const sz = market ? market.szDecimals : null;
  const held = position ? positionView(position, { szDecimals: sz }) : null;
  const heldView = held && held.side ? { pill: held.pill, pnlText: minus(held.pnlText), pnlTone: held.pnlTone } : null;
  const isStockKind = stockKindOf(coin);
  const us = isStockKind ? usMarketView(clock, isStockKind === "index" ? "index" : "stock") : null;
  const v = askAboutView({ coin, market, held: heldView, tokenomist: tokenomist === undefined ? tokenomistFor(coin) : !!tokenomist, us });
  const busy = !onAsk && !!ctx && ctx.busy;
  const say = (words) => {
    if (busy) return;
    if (typeof onAsk === "function") onAsk(words);
    else if (ctx) ctx.send(words);
  };
  const ch = market && Number.isFinite(market.change24hPct) ? market.change24hPct : null;

  return (
    <div className={`t-swap-in pt-1 ${className}`}>
      <h2 className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-h2">
        <span>Ask me about</span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <CoinLogo coin={coin} size={22} />
          <span className="truncate">{v.label}</span>
        </span>
      </h2>
      {/* The market in figures, not a sentence: its name (stocks), its price and its 24h move. */}
      <p className="num mt-1 text-xs text-muted-foreground">
        {v.isStock ? (v.name || v.label) : `${v.label}-USD`}
        <span aria-hidden="true"> · </span>
        {market ? formatHlPrice(market.px, sz) : "—"}
        {ch != null ? <span className={`ml-1.5 ${TONE[toneOfPct(ch)] || ""}`}>{pctText(ch)}</span> : null}
        {ch != null ? <span> 24h</span> : null}
      </p>

      <ul className="mt-3.5 space-y-2" aria-label={`Ask about ${v.label}`}>
        {v.boxes.map((b, i) => {
          const r = rise(i);
          return (
            <li key={b.id} className={r.className} style={r.style}>
              <button
                type="button"
                onClick={() => say(b.words)}
                disabled={busy}
                aria-label={b.mark === "tokenomist" ? `${b.title}: analyze with Tokenomist` : `${b.title}: ${b.sub}`}
                className="ff-press group flex w-full items-center gap-3 rounded-xl bg-card px-3 py-2.5 text-left ring-1 ring-inset ring-border transition-colors hover:bg-muted/50 disabled:opacity-45"
              >
                <span className={`relative grid size-8 shrink-0 place-items-center rounded-lg ${b.muted ? "bg-muted text-muted-foreground" : "bg-muted text-foreground"}`}>
                  <BoxGlyph name={b.icon} />
                  {b.id === "market" && b.tone ? (
                    <span aria-hidden="true" className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card ${DOT[b.tone] || DOT.muted}`} />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm font-medium ${b.muted ? "text-muted-foreground" : "text-foreground"}`}>{b.title}</span>
                  <span className={`mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] ${b.id === "position" && TONE[b.tone] ? TONE[b.tone] : "text-muted-foreground"}`}>
                    {b.sub}
                    {b.mark === "tokenomist" ? <SponsorLogo name="tokenomist" variant="wordmark" size={12} alt="Tokenomist" className="translate-y-px" /> : null}
                  </span>
                </span>
                <Icon name="chevronRight" size={16} className="shrink-0 text-muted-foreground transition-transform duration-[var(--duration-quick)] group-hover:translate-x-0.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
