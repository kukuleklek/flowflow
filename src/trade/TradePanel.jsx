import { AutoHeight } from "../ui/kit/index.ts";
import Seg from "../ui/Seg.jsx";
import { LogoMark } from "../ui/Logo.jsx";
import TradeForm from "./TradeForm.jsx";
import ChatThread from "../agent/ChatThread.jsx";

/* The Chat tab carries the Agent's identity, which is the FlowFlow mark itself (USER-REQUESTS A6). */
export const PANEL_TABS = [
  { value: "long", label: "Long", tone: "long" },
  { value: "short", label: "Short", tone: "short" },
  { value: "chat", label: "Chat", icon: <LogoMark size={16} className="shrink-0" /> },
];

/** The trade aside (a trade panel with a third tab): Long | Short | Chat on one segmented track. No card:
 *  the aside itself is the white surface. Switching slides the pill; the body swaps in place and tweens to its new
 *  height. Long ↔ Short keeps the typed amount. */
export default function TradePanel({ coin, market, stale, tab, onTab }) {
  return (
    <section className="p-5">
      <Seg label="Trade" full size="md" value={tab} onChange={onTab} items={PANEL_TABS} className="mb-4" />
      <AutoHeight>
        {tab === "chat" ? (
          <div key="chat" className="t-swap-in"><ChatThread coin={coin} compact /></div>
        ) : (
          <div key="form" className="t-swap-in">
            <TradeForm key={coin} coin={coin} market={market} stale={stale} side={tab === "short" ? "sell" : "buy"} />
          </div>
        )}
      </AutoHeight>
    </section>
  );
}
