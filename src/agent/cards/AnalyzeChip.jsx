/* The "Analyze" pill (owner AD-11, then polish 1: "Position ที่แนะนำ ไม่เห็นมีปุ่ม Try to analytic"): always there for a
   market, on setup boxes, trade cards, the position card, the rail's rows and the asset boxes. A press says
   "Analyze {COIN}" to the Agent, exactly as if typed, and the answer is ONE analysis card (trend 1h / 4h / 1d, the
   levels that flip it, emission, risks, and whether the RR should change).

   On a setup box or under a pending trade card, the words name the leverage and side it shows ("Analyze ZEC 3x
   short", as a person would say it), and the pill hands that setup or card over with them, so the analysis weighs
   THAT one (its TP / SL, its leverage, its liquidation), never a setup of the app's own on the other side.

   It names Tokenomist ("Analyze with [wordmark]", the words "... with Tokenomist") only when the build has the key on
   (VITE_TOKENOMIST, set only when the server holds TOKENOMIST_API_KEY) AND Tokenomist covers the coin. Otherwise it
   is a plain "Analyze": no Tokenomist logo, never a claim of Tokenomist data. No pill for USDC or a HIP-3 venue
   market ("xyz:TSLA"): the analysis reads main markets only, and its words would land on another market. */
import SponsorLogo from "../../ui/SponsorLogo.jsx";
import { analyzable } from "../analyze.js";
import { useChatActions, tokenomistFor, tokenomistCovers, analyzeText, PILL, Glyph } from "./ChatActions.jsx";

export { tokenomistCovers, tokenomistFor };

/** Is there a pill for this market? Any main market the analysis reads (never USDC, never a venue market). */
export const analyzeOn = analyzable;

/* Sizes: md 32px (the thread), sm 28px (inside a box), xs 24px (the rail's rows: "a small Analytics button"). */
const SIZE = {
  md: { cls: "", glyph: 14, mark: 16 },
  sm: { cls: "!h-7 !gap-1 !px-2.5 !text-[11px]", glyph: 13, mark: 14 },
  xs: { cls: "!h-6 !gap-1 !px-2 !text-[11px]", glyph: 12, mark: 12 },
};

/**
 * @param coin     the app's market name
 * @param compact  "[mark] Analyze" (inside a box or a row) instead of "Analyze with [wordmark]"
 * @param setup    the setup box's setup ({ side, leverage, … }): its words and its own numbers go to the analysis
 * @param card     the pending trade card it sits under ({ side, leverage, marginUsdc, tpPct, slPct, … }): the same
 * @param size     "md" | "sm" | "xs"
 */
export default function AnalyzeChip({ coin, compact = false, setup = null, card = null, size = "md", className = "" }) {
  const ctx = useChatActions();
  if (!ctx || !analyzeOn(coin)) return null;
  const tk = tokenomistFor(coin);
  const own = (x) => (x && typeof x === "object" && x.coin === coin && (x.side === "buy" || x.side === "sell") ? x : null);
  const subject = own(setup) ? { setup: own(setup) } : own(card) ? { card: own(card) } : null;
  const words = analyzeText(coin, { tokenomist: tk, setup: subject ? subject.setup || subject.card : null });
  const sz = SIZE[size] || SIZE.md;
  return (
    <button
      type="button"
      onClick={() => ctx.send(words, subject)}
      disabled={ctx.busy}
      aria-label={words}
      title={words}
      className={`${PILL} ${tk && !compact ? "pl-2.5" : ""} ${sz.cls} ${className}`}
    >
      {tk && !compact ? (
        <>
          <span className="text-muted-foreground">Analyze with</span>
          <SponsorLogo name="tokenomist" variant="wordmark" size={13} alt="Tokenomist" className="translate-y-px" />
        </>
      ) : (
        <>
          {tk
            ? <SponsorLogo name="tokenomist" size={sz.mark} alt="" />
            : <Glyph name="analyze" size={sz.glyph} className="text-muted-foreground" />}
          Analyze
        </>
      )}
    </button>
  );
}
