/* What a box or a pill inside the Agent's thread can do: say something to the Agent (exactly as if it were typed),
   or open a page. ChatThread provides it; cards read it. Nothing here signs or sends money: a pill only turns into
   words, and the words go through the same path as typing (shortcuts, then the model, whose action tools only make
   cards that wait for a tap on Confirm). */
import { createContext, useContext } from "react";
import { isCovered } from "../../lib/tokenomist/slugs.js";
import { analyzePrompt } from "../analyze.js";

export const ChatActionsContext = createContext(null);

/** { send(text, subject?), busy, navigate(to), coin } or null outside a thread. subject: what an Analyze pill sat on
 *  ({ setup } or { card }), handed to the analysis with its words; read only. */
export const useChatActions = () => useContext(ChatActionsContext);

/** Build flags (set at build time; the keys themselves stay on the server). */
export const TOKENOMIST_ON = import.meta.env.VITE_TOKENOMIST === "on";
export const EARN_ON = import.meta.env.VITE_EARN === "on";

/** Does Tokenomist cover this market (a token it has a page for)? Never a USDC or a venue (HIP-3) market. */
export function tokenomistCovers(coin) {
  if (!coin || typeof coin !== "string" || coin === "USDC" || coin.includes(":")) return false;
  try { return isCovered(coin); } catch { return false; }
}

/** Is the Tokenomist key on in this build AND the coin covered? Only then may a pill or row name Tokenomist. */
export const tokenomistFor = (coin) => TOKENOMIST_ON && tokenomistCovers(coin);

/**
 * The words the "Analyze" pill says (analyze.js analyzePrompt, which intents.js reads back): "Analyze ETH", "Analyze
 * ZEC 3x short" (a setup box or a trade card: the leverage and side it shows), and " with Tokenomist" only when
 * tokenomistFor(coin).
 * @param setup the setup box's setup or the trade card ({ side, leverage }), or null
 */
export const analyzeText = (coin, { tokenomist = tokenomistFor(coin), setup = null } = {}) =>
  analyzePrompt(String(coin || ""), { tokenomistOn: !!tokenomist, setup: setup && typeof setup === "object" ? setup : null });

/** What each box action says to the Agent. `chart` opens a page instead (null here). */
export function actionText(id, coin) {
  const c = coin || "ETH";
  switch (id) {
    case "analyze": return analyzeText(c);
    case "long": return `Long setups for ${c}`;
    case "short": return `Short setups for ${c}`;
    case "setups": return `Setups for ${c}`;
    case "stake": return "Stake USDC";
    case "tpsl": return `Set TP SL for ${c}`;
    case "close": return `Close ${c}`;
    default: return null;
  }
}

/** Run one box action: words to the Agent, or a page. */
export function runAction(ctx, id, coin) {
  if (!ctx) return;
  if (id === "chart") { if (coin && coin !== "USDC") ctx.navigate(`/trade/${coin}`); return; }
  if (id === "deposit") { ctx.navigate("/wallet?panel=deposit"); return; }
  const text = actionText(id, coin);
  if (text) ctx.send(text);
}

/* Small pill action (USER-REQUESTS E): 32px tall (44px hit area), glyph + 1–3 words, white with a hairline ring. */
export const PILL = "ff-press ff-hit inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-card px-3 text-xs font-medium text-foreground ring-1 ring-inset ring-border transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-45";

/** Inline glyphs the shared Icon set does not carry (same stroke language: 24 grid, round caps). */
export function Glyph({ name, size = 14, className = "" }) {
  const d = {
    target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-3.5h.01",
    trendUp: "M4 16l5-5 4 4 7-7M15 8h5v5",
    trendDown: "M4 8l5 5 4-4 7 7M15 16h5v-5",
    mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm-6-3a6 6 0 0 0 12 0M12 18v3",
    lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
    layers: "M12 4 3 9l9 5 9-5-9-5ZM3 14l9 5 9-5",
    /* Analyze: a lens over a small zigzag of price. */
    analyze: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 3-4-4M7.5 12.5l2-2.5 2 2 2.5-3",
    /* Trend arrows: up, down, sideways. */
    up: "M7 17 17 7M9 7h8v8",
    down: "M7 7l10 10M17 9v8H9",
    flat: "M5 12h14M15 8l4 4-4 4",
  }[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
