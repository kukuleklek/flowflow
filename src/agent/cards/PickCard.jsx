/* The pick-4 card (item 12; owner: "มีเหรียญเด้งมาให้เลือก 4 อัน กลุ่มนั้นๆ (โชว์แต่กราฟ) แล้วพอเลือกเสร็จแม่ง ออก Propose Order ให้ต่อ").
   One line, up to two headlines (title · source · age, linked out; never article text), then exactly four tiles of
   ONE group: each tile is the ticker with a tiny mark, its 24h %, and a FAINT mini chart of the last 24 one-hour
   candles (a 1.4px line at 55% opacity over a 7% fill, green or red with the printed %). No big numbers. The chosen
   tile gets a green ring.

   A tap only CHOOSES: it calls onPick(coin) (the caller proposes the order: the setups card or a trade card with its
   recommended TP / SL, which still waits for Confirm). Without an onPick, the tile says "Setups for TSLA" to the Agent
   through the thread's own send, exactly as if typed. Nothing here sends, signs or moves money.

   Card kind "pick" — see pickView.js for the contract and the rules this card holds whatever it is given (one group,
   at most four tiles, no venue words in the line, http(s) links only). */
import { useEffect, useState } from "react";
import { rise } from "../../ui/kit/index.ts";
import CoinLogo from "../../ui/CoinLogo.jsx";
import Icon from "../../ui/Icon.jsx";
import Tip from "../../ui/Tip.jsx";
import { usePerpMarkets, fetchHlCandles, peekHlCandles } from "../../lib/hyperliquid/index.js";
import { useChatActions } from "./ChatActions.jsx";
import { pickView, sparkPaths, pickWords, PICK_BARS } from "./pickView.js";

const W = 120;
const H = 36;
const TONE = { pos: "text-success", neg: "text-destructive" };

/* The tile's candles: the card's own, else the last 24 hourly bars (the candle layer caches them a minute). Read only.
   Four tiles ask at once, often while the market list is still loading, and /info refuses a burst now and then
   (hlInfo never retries by itself: "the caller's next ask is the retry"), so a refused read is asked again twice,
   1.5 s then 4 s later. Unknown stays unknown: the tile shimmers, then draws no line rather than a made-up one. */
const RETRY_MS = [1500, 4000];
function useSparkCandles(coin, given) {
  const [list, setList] = useState(() => given || (coin ? peekHlCandles(coin, "1h", { bars: PICK_BARS }) : null) || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (given || !coin) return undefined;
    let alive = true;
    let timer = 0;
    setFailed(false);
    const read = (attempt) => {
      fetchHlCandles(coin, "1h", { bars: PICK_BARS })
        .then((c) => { if (alive) setList(Array.isArray(c) ? c : []); })
        .catch(() => {
          if (!alive) return;
          if (attempt < RETRY_MS.length) timer = setTimeout(() => read(attempt + 1), RETRY_MS[attempt]);
          else setFailed(true);
        });
    };
    read(0);
    return () => { alive = false; clearTimeout(timer); };
  }, [coin, given]);
  return { candles: given || list, loading: !given && list == null && !failed };
}

function Spark({ coin, candles: given, tone }) {
  const { candles, loading } = useSparkCandles(coin, given);
  const s = candles ? sparkPaths(candles, { w: W, h: H }) : null;
  if (loading) return <div className="skeleton-shimmer h-9 w-full rounded-md opacity-50" aria-hidden="true" />;
  if (!s) return <div className="h-9 w-full" aria-hidden="true" />;
  const color = TONE[tone || (s.dir === "up" ? "pos" : "neg")] || "text-muted-foreground";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`block h-9 w-full ${color}`} aria-hidden="true">
      <path d={s.area} fill="currentColor" fillOpacity="0.07" stroke="none" />
      {/* non-scaling: the line stays 1.4px however wide the tile stretches */}
      <path d={s.line} fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile({ t, chosen, onChoose, disabled, index }) {
  const r = rise(index);
  return (
    <button
      type="button"
      onClick={() => onChoose(t.coin)}
      disabled={disabled}
      aria-pressed={chosen}
      aria-label={`${t.label}, ${t.changeText} in 24 hours${chosen ? ", chosen" : ""}`}
      className={`${r.className} ff-press group flex min-w-0 flex-col rounded-xl p-2.5 text-left ring-inset transition-[background-color,box-shadow] duration-[var(--duration-quick)] disabled:cursor-default ${
        chosen ? "bg-success/[.05] ring-2 ring-success" : "bg-card ring-1 ring-border hover:bg-muted/50"}`}
      style={r.style}
    >
      <span className="flex w-full items-center justify-between gap-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <CoinLogo coin={t.coin} size={16} />
          <span className="truncate text-sm font-semibold">{t.label}</span>
        </span>
        <span className={`num shrink-0 text-xs font-medium ${TONE[t.tone] || "text-muted-foreground"}`}>{t.changeText}</span>
      </span>
      <span className="mt-2 block w-full">
        <Spark coin={t.coin} candles={t.candles} tone={t.tone} />
      </span>
    </button>
  );
}

/**
 * @param card      kind "pick" (pickView.js)
 * @param onPick    (coin) => void — the caller proposes the order; omitted: the thread's send says pickWords(coin)
 * @param selected  the chosen coin, when the caller keeps it (else the card's own `chosen`, then local state)
 * @param disabled  e.g. while the Agent is busy
 * @param now       the clock for the headlines' age (ms); defaults to now
 */
export default function PickCard({ card, onPick = null, selected = undefined, disabled = false, now = null, className = "" }) {
  const snap = usePerpMarkets();
  const ctx = useChatActions();
  const v = pickView(card, { byCoin: snap.byCoin || {}, now: now ?? Date.now() });
  const [local, setLocal] = useState(v.chosen);
  const chosen = selected !== undefined ? selected : local;
  const busy = disabled || (!onPick && !!ctx && ctx.busy);

  const choose = (coin) => {
    if (busy) return;
    setLocal(coin);
    if (typeof onPick === "function") onPick(coin);
    else if (ctx) ctx.send(pickWords(coin, snap.byCoin ? snap.byCoin[coin] : null));
  };

  return (
    <div className={`t-rise ${className}`}>
      <p className="text-sm leading-[1.55] text-foreground">{v.line}</p>
      {v.headlines.length ? (
        <ul className="mt-2 space-y-1.5" aria-label="Headlines">
          {v.headlines.map((h) => (
            <li key={h.key}>
              <a
                href={h.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="group -mx-1 flex items-start gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/60"
              >
                <span className="mt-[3px] grid size-4 shrink-0 place-items-center text-muted-foreground"><Icon name="arrowUpRight" size={13} /></span>
                <span className="min-w-0">
                  <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground group-hover:underline group-hover:underline-offset-2">{h.title}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{[h.source, h.age].filter(Boolean).join(" · ")}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {v.tiles.length ? (
        <div className="mt-3 [container-type:inline-size]">
          <div className="grid grid-cols-2 gap-2 [@container(min-width:520px)]:grid-cols-4">
            {v.tiles.map((t, i) => (
              <Tile key={t.coin} t={t} index={i} chosen={chosen === t.coin} onChoose={choose} disabled={busy} />
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Nothing to pick from right now: the market list hasn't loaded.</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] text-muted-foreground">24h · 1h candles</span>
        <Tip label="Not advice" align="start">
          Four markets from one group, by their live 24h move. Picking one shows setups with TP / SL from its chart;
          nothing is sent until you confirm.
        </Tip>
      </div>
    </div>
  );
}
