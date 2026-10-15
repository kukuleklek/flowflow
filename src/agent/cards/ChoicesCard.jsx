/* A row of small buttons under an answer (pass-2 fixes: "ฝากเงิน" got "Tap Deposit" with nothing to tap; "how many assets"
   and the stock questions had no next step). Each button either SAYS its words to FlowFlow (the same send as typing:
   anything it leads to is a card that waits for Confirm) or OPENS one of the app's own pages (`to`, an in-app path:
   the Wallet's Deposit or Move panel). Nothing here moves money or sends an order.

   Card kind "choices": { items: [{ label, text?, to?, coin?, icon?, glyph?, main? }] } — at most four. A `to` must be
   an in-app path ("/wallet?panel=deposit"); anything else is not drawn. Frameless, the pill grammar of the chips. */
import Icon from "../../ui/Icon.jsx";
import CoinLogo from "../../ui/CoinLogo.jsx";
import { useChatActions, Glyph, PILL } from "./ChatActions.jsx";

const MAIN = "!bg-foreground !text-background !ring-foreground hover:!bg-foreground/90";
/* 🔴 Only the app's own pages: a card can never send the reader to an address it was handed. */
const inApp = (to) => typeof to === "string" && /^\/[a-z0-9/?=&._-]*$/i.test(to) && !to.startsWith("//");

export default function ChoicesCard({ card }) {
  const ctx = useChatActions();
  const items = (Array.isArray(card.items) ? card.items : [])
    .filter((x) => x && typeof x.label === "string" && x.label && (typeof x.text === "string" ? x.text.trim() : inApp(x.to)))
    .slice(0, 4);
  if (!items.length) return null;
  return (
    <div className="t-rise flex flex-wrap items-center gap-1.5" role="group" aria-label="Next steps">
      {items.map((x) => (
        <button
          key={`${x.label}${x.to || x.text}`}
          type="button"
          disabled={!ctx || ctx.busy}
          onClick={() => {
            if (!ctx) return;
            if (x.to && inApp(x.to)) ctx.navigate(x.to);
            else if (x.text) ctx.send(x.text);
          }}
          className={`${PILL} ${x.main ? MAIN : ""}`}
        >
          {x.coin ? <CoinLogo coin={x.coin} size={16} />
            : x.glyph ? <Glyph name={x.glyph} size={13} />
              : x.icon ? <Icon name={x.icon} size={14} /> : null}
          {x.label}
        </button>
      ))}
    </div>
  );
}
