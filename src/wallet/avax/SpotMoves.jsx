/* Moves in progress (plan §3.7): every Spot Account move that may be on its way, from the ONE flow registry of this
   account (useAvaxMoney().flows), with the flow watcher's latest note and where to check it. Read only: no button here
   starts, repeats or cancels anything — a move that is not confirmed yet says so and is never offered again.
   Mounted only when the build has VITE_EARN=on (the card decides), so a build with the panels off never creates the
   registry or its watcher. */
import { Spinner } from "../../ui/Icon.jsx";
import Icon from "../../ui/Icon.jsx";
import Tip from "../../ui/Tip.jsx";
import { useAvaxMoney } from "../../avax/useAvaxMoney.js";
import { flowRowView } from "./panelView.js";

/* unknownOnly: only the moves that are NOT CONFIRMED (the Wallet page lists the moving ones itself), each with where to
   look and its "Check status" link. */
export default function SpotMoves({ unknownOnly = false }) {
  const m = useAvaxMoney();
  const rows = (m.inFlight || []).map(flowRowView).filter((r) => r && (!unknownOnly || r.tone === "unknown"));
  if (!rows.length) return null;
  return (
    <div className="mt-3 border-t border-hairline pt-3" aria-live="polite">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-medium">{unknownOnly ? "Not confirmed yet" : "Moves in progress"}</h3>
        <Tip align="start" title="About moves in progress">Each move is watched until it lands. A move that isn't confirmed yet is never sent twice.</Tip>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.id} className="flex min-h-12 items-start gap-2.5 border-t border-hairline py-2.5 first:border-t-0">
            <span className="grid size-5 shrink-0 place-items-center pt-0.5">
              {r.tone === "unknown" ? <Icon name="alert" size={15} className="text-warning" /> : <Spinner size={14} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm">{r.title}</span>
                {r.amountText ? <span className="num shrink-0 text-xs text-muted-foreground">{r.amountText}</span> : null}
              </span>
              <span className={`block text-xs ${r.tone === "unknown" ? "text-warning" : "text-muted-foreground"}`}>{r.note ? r.note.text : r.stateText}</span>
              {r.where ? <span className="block text-xs text-muted-foreground">{r.where}</span> : null}
              {r.note && r.note.href ? (
                <a href={r.note.href} target="_blank" rel="noopener noreferrer" className="ff-hit mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  Check status<Icon name="arrowUpRight" size={12} />
                </a>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
