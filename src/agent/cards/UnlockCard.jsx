/* A coin's token unlocks, from Tokenomist (owner AD-11: the answer to "Analyze with Tokenomist"). The next unlock big
   (its date and how far away), what unlocks (amount, value, share of the circulating supply), and a tiny schedule bar
   of what comes after. Tokenomist's logo and attribution are on it whenever it shows Tokenomist's data, and only then
   (no key, a coin it doesn't cover, a failed read: no logo, never a claim). Its strings are data, shown as text.
   Unknown is the dash, never 0.

   Card kind "unlocks": { coin, configured, next: { date, amount, pctCirculating, usd } | null, events: [...] | [],
   source: "Tokenomist", updatedAt } */
import CoinLogo from "../../ui/CoinLogo.jsx";
import Tip from "../../ui/Tip.jsx";
import SponsorLogo, { TOKENOMIST_URL } from "../../ui/SponsorLogo.jsx";
import { TOKENOMIST_ON } from "./ChatActions.jsx";
import { usePerpMarket } from "../../lib/hyperliquid/index.js";
import { perpCoinLabel } from "../../perp/live/perpLiveView.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const DAY = 86_400_000;
const clean = (s, n = 32) => String(s).replace(/[^\p{L}\p{N} &()./%+,$:-]/gu, "").trim().slice(0, n);

function toTime(d) {
  if (fin(d)) return d < 1e12 ? d * 1000 : d;
  if (typeof d === "string" && d) { const t = Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d); return Number.isFinite(t) ? t : null; }
  return null;
}
const dateText = (t, now = Date.now()) => (t == null ? "—" : new Date(t).toLocaleDateString("en-US", {
  month: "short", day: "numeric", ...(new Date(t).getUTCFullYear() !== new Date(now).getUTCFullYear() ? { year: "numeric" } : {}), timeZone: "UTC",
}));
function awayText(t, now = Date.now()) {
  if (t == null) return null;
  const d = Math.round((t - now) / DAY);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d > 1) return `in ${d} days`;
  return d === -1 ? "yesterday" : `${-d} days ago`;
}
const compact = (v) => (fin(v) ? Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v) : null);
function amountText(v, coin) {
  if (typeof v === "string" && v.trim()) return clean(v, 24);
  return fin(v) ? `${compact(v)} ${coin}` : "—";
}
function usdText(v) {
  if (typeof v === "string" && v.trim()) return clean(v, 16);
  return fin(v) ? `$${compact(v)}` : "—";
}
function pctText(v) {
  if (typeof v === "string" && v.trim()) return clean(v, 10);
  return fin(v) ? `${v < 0.1 ? v.toFixed(2) : v.toFixed(1)}%` : "—";
}
const pctNum = (v) => (fin(v) ? v : typeof v === "string" ? Number.parseFloat(v) : NaN);

/* The schedule as a bar: today on the left, each unlock a dot along the window (bigger dot, bigger share). */
function ScheduleBar({ events, now }) {
  const pts = events.map((e) => ({ t: toTime(e.date), p: pctNum(e.pctCirculating) })).filter((e) => e.t != null && e.t >= now - DAY);
  if (!pts.length) return null;
  const last = Math.max(...pts.map((e) => e.t));
  const span = Math.min(365 * DAY, Math.max(90 * DAY, (last - now) * 1.08));
  const end = now + span;
  const shown = pts.filter((e) => e.t <= end).slice(0, 24);
  return (
    <div className="px-4 pb-3 pt-1" aria-hidden="true">
      <div className="relative h-4">
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
        <span className="absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground/60" />
        {shown.map((e, i) => {
          const x = Math.max(0, Math.min(1, (e.t - now) / span));
          const s = fin(e.p) ? Math.max(6, Math.min(14, 6 + e.p * 2.4)) : 7;
          return (
            <span
              key={`${e.t}${i}`}
              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${i === 0 ? "bg-foreground" : "bg-foreground/35"}`}
              style={{ left: `${x * 100}%`, width: s, height: s }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>Today</span>
        <span>{dateText(end, now)}</span>
      </div>
    </div>
  );
}

/* Tokenomist's own page for the token when the card names one (tokenomist.ai only), else its home. */
const pageOf = (url) => (typeof url === "string" && /^https:\/\/(www\.)?tokenomist\.ai(\/[a-z0-9/-]*)?$/i.test(url) ? url : TOKENOMIST_URL);

function Attribution({ url }) {
  return (
    <a href={pageOf(url)} target="_blank" rel="noopener noreferrer" className="ff-press inline-flex shrink-0 items-center rounded-md" aria-label="Data from Tokenomist">
      <SponsorLogo name="tokenomist" variant="wordmark" size={17} alt="Tokenomist" />
    </a>
  );
}

export default function UnlockCard({ card }) {
  const { market } = usePerpMarket(card.coin);
  const now = Date.now();
  const label = card.coin ? perpCoinLabel(card.coin, market) : "—";
  const data = TOKENOMIST_ON && card.configured !== false && card.covered !== false && !card.error;
  const head = (
    <div className="flex items-center justify-between gap-3 px-4 pb-2.5 pt-3">
      <span className="flex min-w-0 items-center gap-2">
        <CoinLogo coin={card.coin} size={24} />
        <span className="truncate text-h2">{label} unlocks</span>
      </span>
      {data ? <Attribution url={card.url} /> : null}
    </div>
  );

  const sym = typeof card.symbol === "string" && card.symbol ? clean(card.symbol, 12) : label;
  const quiet = (text, tip = null) => (
    <div className="t-swap-in">
      {head}
      <p className="flex items-center gap-2 border-t border-hairline px-4 py-2.5 text-xs text-muted-foreground">
        {text}
        {tip}
      </p>
    </div>
  );
  if (card.covered === false) return quiet(`Tokenomist has no unlock schedule for ${sym}.`);
  if (card.error) return quiet(card.error === "quota" ? "Unlock data is over its monthly limit right now." : "Unlock data couldn't be read right now.");

  if (card.configured === false) {
    return (
      <div className="t-swap-in">
        {head}
        <p className="flex items-center gap-2 border-t border-hairline px-4 py-2.5 text-xs text-muted-foreground">
          Unlock data isn't connected here yet.
          <Tip title="About unlock data" align="end">Token unlocks come from Tokenomist. This app has no Tokenomist key set, so nothing was read.</Tip>
        </p>
      </div>
    );
  }

  const next = card.next && typeof card.next === "object" ? card.next : null;
  const t = next ? toTime(next.date) : null;
  const events = Array.isArray(card.events) ? card.events.filter((e) => e && typeof e === "object") : [];
  const barEvents = events.length ? events : next ? [next] : [];
  const updated = toTime(card.updatedAt);
  const toName = (x) => (typeof x === "string" ? clean(x, 40) : x && typeof x.name === "string" ? `${clean(x.name, 32)}${fin(x.pct) ? ` ${Math.round(x.pct)}%` : ""}` : null);
  const to = next && Array.isArray(next.to) ? next.to.map(toName).filter(Boolean).slice(0, 2).join(", ") : "";
  const windowDays = fin(card.windowDays) && card.windowDays > 0 ? Math.round(card.windowDays) : 90;

  return (
    <div className="t-swap-in">
      {head}
      {next ? (
        <>
          <div className="border-t border-hairline px-4 py-3">
            <div className="text-label text-muted-foreground">Next unlock</div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="num text-[24px] font-medium leading-none tracking-[-0.03em]">{dateText(t, now)}</span>
              {awayText(t, now) ? <span className="text-sm font-medium text-muted-foreground">{awayText(t, now)}</span> : null}
            </div>
            {to ? <div className="mt-1.5 truncate text-xs text-muted-foreground">To {to}</div> : null}
          </div>
          <dl className="grid grid-cols-3 border-t border-hairline">
            {[["Amount", amountText(next.amount, sym)], ["Value", usdText(next.usd)], ["Of circulating", pctText(next.pctCirculating)]].map(([k, v], i) => (
              <div key={k} className={`min-w-0 px-4 py-2.5 ${i ? "border-l border-hairline" : ""}`}>
                <dt className="text-label text-muted-foreground">{k}</dt>
                <dd className="num mt-1 truncate text-sm font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="border-t border-hairline pt-2.5">
            <ScheduleBar events={barEvents} now={now} />
          </div>
        </>
      ) : (
        <p className="border-t border-hairline px-4 py-2.5 text-xs text-muted-foreground">No unlock scheduled in the next {windowDays} days.</p>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <SponsorLogo name="tokenomist" size={12} alt="" />
          <span className="truncate">Data: Tokenomist{updated != null ? ` · updated ${dateText(updated, now)}` : ""}</span>
        </span>
        <Tip label="Scheduled" align="end">Unlock dates and amounts are scheduled, not certain. "Of circulating" is the share of the coins in circulation now.</Tip>
      </div>
    </div>
  );
}
