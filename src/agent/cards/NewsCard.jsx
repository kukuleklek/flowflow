/* Headlines under an answer (item 12 / 18: "News & trend", get_news). Card kind "news":
     { kind: "news", coin?: string|null, topic?: string|null, items: [{ title, source, url, publishedAt }] }
   At most two rows: the title as published (clamped to two lines with CSS, never cut or reworded), "source · age" under
   it, the whole row a link that opens in a new tab. 🔴 Third-party text: no article body, no summary in our words, and
   only http(s) links (pickView.js safeHref). Frameless, like the pick card. */
import Icon from "../../ui/Icon.jsx";
import CoinLogo from "../../ui/CoinLogo.jsx";
import { newsView } from "../../lib/news/client.js";
import { safeHref } from "./pickView.js";
import { coinLabel } from "./viewWords.js";

export default function NewsCard({ card, now = null }) {
  const rows = newsView(Array.isArray(card && card.items) ? card.items : [], { max: 2, now: now ?? Date.now() })
    .map((it) => ({ ...it, href: safeHref(it.url) }))
    .filter((it) => it.href);
  if (!rows.length) return null;
  const label = card.coin ? coinLabel(card.coin) : null;
  return (
    <div className="t-rise">
      <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        {card.coin ? <CoinLogo coin={card.coin} size={14} /> : <Icon name="chat" size={12} />}
        <span>{label ? `${label} · headlines` : "Headlines"}</span>
      </div>
      <ul className="space-y-1" aria-label={label ? `${label} headlines` : "Headlines"}>
        {rows.map((h) => (
          <li key={h.href}>
            <a
              href={h.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="group -mx-1 flex items-start gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/60"
            >
              <span className="mt-[3px] grid size-4 shrink-0 place-items-center text-muted-foreground"><Icon name="arrowUpRight" size={13} /></span>
              <span className="min-w-0">
                <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground group-hover:underline group-hover:underline-offset-2">{h.title}</span>
                <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{h.meta}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
