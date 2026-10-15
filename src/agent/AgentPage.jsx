import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import Button from "../ui/Button.jsx";
import Icon from "../ui/Icon.jsx";
import { LogoMark } from "../ui/Logo.jsx";
import Tip from "../ui/Tip.jsx";
import SectionHead from "../ui/SectionHead.jsx";
import { usePerpMarkets } from "../lib/hyperliquid/index.js";
import { AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import ChatThread from "./ChatThread.jsx";
import { chat } from "./store.js";
import { contextCoinOf } from "./agent.js";
import { ChatActionsContext, TOKENOMIST_ON } from "./cards/ChatActions.jsx";
import { PositionRows, usePositionRows } from "./cards/PositionList.jsx";

const CAN_DO = [
  "Reads live markets, US stocks and your Main Account.",
  "Turns what you type or say into an order card, with a recommended TP / SL.",
  "Sizes a trade from your risk (“risk $5 short SOL”): the maths is code, shown on the card.",
  "Analyzes a market: trend, risks, and whether its RR should change.",
  ...(TOKENOMIST_ON ? ["Reads token unlocks with Tokenomist."] : []),
  "Sends nothing until you check the final chart and press Open.",
  `Caps leverage at ${AGENT_MAX_LEVERAGE}x. Quotes refresh every 30s.`,
];

/* What FlowFlow does, folded behind a small ⓘ (USER-REQUESTS D1): the lines open in a bubble on a press. */
function CanDo() {
  return (
    <Tip label="What it can do" align="start">
      <span className="block space-y-1.5">
        {CAN_DO.map((t, i) => (
          <span key={t} className="grid grid-cols-[22px_1fr]">
            <span className="font-mono text-[11px] leading-[1.6] text-ink-dim">0{i + 1}</span>
            <span>{t}</span>
          </span>
        ))}
      </span>
    </Tip>
  );
}

/* The rail is "All your positions" (owner, polish 1: "ขวาสุดเน้นเป็น All Your Position ดีกว่า แล้วมีปุ่ม Analytics เล็กๆ"):
   every open position, biggest P&L first, in the compact rows below xl's positions box uses too (cards/PositionList:
   logo, "3x Long" chip, live P&L, entry and ROE, a small 24px Analyze pill). The name opens its market. Signed out or
   nothing open: one quiet line, no filler. No sponsor block here (it stays on the Wallet page). */
function AllPositions() {
  const { state, rows } = usePositionRows();
  const quiet = state === "out" ? "Sign in to see your positions." : state === "empty" ? "No open positions." : null;
  return (
    <section className="mt-8" aria-label="All your positions">
      <SectionHead title="All your positions" meta={rows.length ? String(rows.length) : null} />
      {state === "loading" ? (
        <div className="mt-3 space-y-3 border-t border-hairline pt-3" aria-hidden="true">
          <span className="skeleton-shimmer block h-4 w-40 rounded" />
          <span className="skeleton-shimmer block h-3 w-28 rounded" />
        </div>
      ) : quiet ? (
        <p className="mt-3 border-t border-hairline pt-3 text-xs text-muted-foreground">{quiet}</p>
      ) : (
        <PositionRows rows={rows} className="mt-3 border-y border-hairline" />
      )}
    </section>
  );
}

/** The Agent, full screen: the same conversation as the trade page's Chat tab, with its identity and every open
 *  position in a rail at xl (a band on top below xl). The identity is the FlowFlow mark itself (USER-REQUESTS A6).
 *  There is no card around the thread. The rail's pills talk to the thread through its actions (the same send as
 *  the composer). */
export default function AgentPage() {
  const [params] = useSearchParams();
  const snap = usePerpMarkets();
  const [actions, setActions] = useState(null);
  /* ?coin= comes from a link anyone can write: only a live market's own name is the page's market (the chips, the
     model's context, voice). Anything else is no market at all. */
  const coin = contextCoinOf(params.get("coin"), snap);
  return (
    <div className="t-enter flex h-[calc(100dvh-57px-65px-env(safe-area-inset-bottom))] flex-col md:h-[calc(100dvh-57px)] xl:grid xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* z-10: the Tip's bubble opens over the thread below the band. */}
      {/* Phone: the app bar above already shows the FlowFlow mark and name, so this band is ONE short row (pass-2
          review: the brand twice cost 65px of an 844px screen before the first message). */}
      <header className="relative z-10 flex items-center gap-3 border-b border-border px-gutter py-1 md:py-2.5 xl:hidden">
        <LogoMark size={28} className="hidden shrink-0 md:block" />
        <div className="min-w-0 flex-1">
          <h1 className="sr-only text-h1 md:not-sr-only">FlowFlow</h1>
          <div className="flex md:mt-0.5"><CanDo /></div>
        </div>
        <Button variant="ghost" size="sm" className="-mr-2 !h-9 md:!h-11 lg:!h-8" onClick={() => chat.clear()}>New chat</Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col xl:h-[calc(100dvh-57px)]">
        <ChatThread coin={coin} onActions={setActions} />
      </div>
      <aside className="hidden overflow-y-auto border-l border-border px-6 py-8 xl:block xl:h-[calc(100dvh-57px)]">
        <LogoMark size={32} className="block" />
        <h1 className="mt-4 text-h1">FlowFlow</h1>
        <div className="relative z-10 mt-1.5 flex"><CanDo /></div>
        <Button variant="ghost" size="sm" className="-ml-3 mt-3" onClick={() => chat.clear()}>
          <Icon name="plus" size={14} /> New chat
        </Button>
        <ChatActionsContext.Provider value={actions}>
          <AllPositions />
        </ChatActionsContext.Provider>
      </aside>
    </div>
  );
}
