/* Recommended setups (owner: "ควรจะแบบมี กล่อง Recommended สีเขียวๆขึ้นมาเลย ว่า เห้ย ลอง Setup นี้ไหม RR เท่าไหร่ TP SL
   ตั้งให้เลย แล้วให้คนกดเลือก"). Green boxes, one per setup: the coin, Safer / Balanced / Bolder, the reward-to-risk as
   the headline figure, entry / TP / SL prices, and one footer line with what the stop costs and the liquidation price
   (always printed). The why (trend, funding, how the stop is set) and the basis (1h candles, 14-bar range) are folded
   into Tips under the boxes (USER-REQUESTS D). The box's own button CHOOSES: it puts the normal trade card in the chat
   (re-quoted live, TP / SL marked Recommended), which still waits for Confirm. Nothing here sends anything.

   One market (card.coin): its three profiles, each box named by its profile. Several markets ("top movers setups"):
   one Balanced box per market, each named by its market. Every box carries its own small "Analyze" pill beside "Use
   this setup" (polish 1: the analysis weighs that box's RR / TP / SL). Compact (owner: "กล่องต่างๆใหญ่ไปหน่อย"): a
   28px RR, tight padding, pill actions, so three sit in one row at 1440 and scroll sideways on a phone.

   Card kind "setups": { coin|null, setups: [{ id, coin, side: "buy"|"sell", label, leverage, marginUsdc, entryPx,
   tpPx, slPx, tpPct, slPct (ROE %), rr, maxLossUsdc, liqPx, reason }], basis, at, noAnalyze? } — noAnalyze: the card
   answers "Analyze X", so it offers no second Analyze. */
import { SuccessCheck, rise } from "../../ui/kit/index.ts";
import Icon from "../../ui/Icon.jsx";
import Tip from "../../ui/Tip.jsx";
import CoinLogo from "../../ui/CoinLogo.jsx";
import { sidePill } from "../../ui/badge.js";
import { minus } from "../../ui/num.js";
import { usePerpMarkets, formatHlPrice } from "../../lib/hyperliquid/index.js";
import { perpCoinLabel } from "../../perp/live/perpLiveView.js";
import { chat } from "../store.js";
import { setupToOpenCard, SETUP_MAX_LEVERAGE } from "../setups.js";
import AnalyzeChip from "./AnalyzeChip.jsx";
import { coinLabel, pairLabel, pctText } from "./viewWords.js";
import { agentTicker } from "../stockWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
/* The PRICE move from the entry, the one meaning of % on every card and in the final popup (pass-2 review: these boxes
   printed the gain on margin, so one TP read +8.1%, +16.2% and +24.3% across the three boxes). One decimal. */
const move = (entry, px) => (fin(entry) && entry > 0 && fin(px) ? pctText(((px - entry) / entry) * 100, 1) : null);
const hhmm = (t) => (fin(t) ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null);

/** Reward to risk: the setup's own figure, else TP ROE over SL ROE (both scale with leverage alike). */
export function rrOf(s) {
  if (s && fin(s.rr) && s.rr > 0) return s.rr;
  if (s && fin(s.tpPct) && fin(s.slPct) && s.slPct !== 0) return Math.abs(s.tpPct) / Math.abs(s.slPct);
  return null;
}
export const rrText = (rr) => (fin(rr) ? `1 : ${rr.toFixed(1)}` : "—");

/* A tap CHOOSES: the setup becomes the normal trade card (setups.js setupToOpenCard applies the setups' own caps and
   FlowFlow's again, in code), the model is told, and the box is marked. Nothing is sent: the card waits for Confirm. */
function choose(mid, s, market, card) {
  const c = setupToOpenCard(s, { market });
  if (!c) return;
  const Side = c.side === "sell" ? "short" : "long";
  /* From the empty Agent page (no message yet): the setups land in the thread first, marked, so the choice keeps its
     context. */
  if (mid == null) {
    if (card) chat.push({ role: "card", card: { ...card, chosen: s.id } });
  } else {
    try { chat.patchCard(mid, { chosen: s.id }); } catch { /* the setups card is gone: still show the trade card */ }
  }
  chat.noteLlm(`The user chose the ${c.setupLabel || "recommended"} setup: ${Side} ${agentTicker(c.coin)} ${c.marginUsdc} USDC ${c.leverage}x, TP +${c.tpPct ?? "-"}% SL -${c.slPct ?? "-"}% (ROE). A trade card is on screen; nothing is sent until they confirm it.`);
  chat.push({ role: "card", card: c });
}

function Line({ label, children, tone = "" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`num whitespace-nowrap text-right font-medium ${tone}`}>{children}</dd>
    </div>
  );
}

function SetupBox({ s, mid, card, chosen, market, index, multi = false, analyze = true }) {
  const r = rise(index);
  const sz = market ? market.szDecimals : null;
  const label = coinLabel(s.coin, market) || perpCoinLabel(s.coin, market);
  const buy = s.side !== "sell";
  const rr = rrOf(s);
  /* The leverage the box shows is the one its card will carry (the setups' own cap, in code). */
  const lev = fin(s.leverage) ? Math.max(1, Math.min(Math.floor(s.leverage), SETUP_MAX_LEVERAGE)) : null;
  const px = (v) => (fin(v) ? formatHlPrice(v, sz) : "—");
  const featured = /balanced/i.test(String(s.label || ""));
  const usable = !!setupToOpenCard(s, { market });
  const name = `${s.label || "recommended"} setup: ${buy ? "long" : "short"} ${label}${lev ? ` ${lev}x` : ""}`;
  return (
    <article
      aria-label={`${multi ? label : s.label || "Setup"}, reward to risk ${rrText(rr)}`}
      className={`${r.className} flex w-[78%] max-w-[300px] shrink-0 snap-start flex-col rounded-xl p-3.5 ring-1 ring-inset transition-[background-color,box-shadow] duration-[var(--duration-quick)] hover:shadow-[0_8px_22px_-16px_rgb(5_119_59/0.4)] [@container(min-width:600px)]:w-auto [@container(min-width:600px)]:max-w-none ${
        chosen ? "bg-success/[.08] ring-success/45" : featured && !multi ? "bg-success/[.05] ring-success/25" : "bg-success/[.035] ring-success/15"}`}
      style={r.style}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <CoinLogo coin={s.coin} size={20} />
          {/* One market: the profile names the box (Safer / Balanced / Bolder). Several markets: the market does. */}
          <span className="truncate text-sm font-semibold">{multi ? label : s.label || "Setup"}</span>
        </span>
        <span className={sidePill(buy ? "long" : "short")}>{lev ? `${lev}x ` : ""}{buy ? "Long" : "Short"}</span>
      </div>

      <div className="mt-2.5 flex items-baseline gap-2">
        <span className="num text-[28px] font-medium leading-none tracking-[-0.03em] text-foreground">{rrText(rr)}</span>
        <span className="text-[11px] text-muted-foreground">Reward to risk</span>
      </div>

      <dl className="mt-3 w-full space-y-1 border-t border-success/[.12] pt-2.5 text-xs">
        <Line label="Entry">{px(s.entryPx)}</Line>
        <Line label="Take profit" tone="text-success">{px(s.tpPx)}{move(s.entryPx, s.tpPx) ? <span className="ml-1 font-normal text-muted-foreground">{move(s.entryPx, s.tpPx)}</span> : null}</Line>
        <Line label="Stop loss" tone="text-destructive">{px(s.slPx)}{move(s.entryPx, s.slPx) ? <span className="ml-1 font-normal text-muted-foreground">{minus(move(s.entryPx, s.slPx))}</span> : null}</Line>
      </dl>
      {/* What the stop costs (fees in) and where liquidation sits: one line, never folded (USER-REQUESTS D2). The trade
          card's "Max loss" is the isolated worst case, the whole margin. */}
      <p className="num mt-2 text-[11px] text-muted-foreground">
        Risk {fin(s.maxLossUsdc) ? `${s.maxLossUsdc.toFixed(2)} USDC` : "—"}
        <span aria-hidden="true"> · </span>
        {/* A 1x long has no liquidation price to speak of (the estimate clamps to $0): "none", never a computed $0. */}
        <span className="text-warning">Liq {fin(s.liqPx) && s.liqPx > 0 && !(lev === 1 && buy) ? px(s.liqPx) : "none"}</span>
      </p>

      {/* The box's actions: a compact pill that CHOOSES (never a full-width bar), and the box's own Analyze. */}
      <div className="mt-auto flex w-full flex-wrap items-center gap-1.5 pt-3">
        <button
          type="button"
          disabled={!usable || chosen}
          onClick={() => choose(mid, s, market, card)}
          aria-pressed={chosen}
          aria-label={chosen ? `Chosen: ${name}` : `Use the ${name}`}
          className={`ff-press ff-hit inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors disabled:cursor-default ${
            chosen ? "bg-success/[.14] text-success" : usable ? "bg-foreground text-background hover:bg-foreground/90" : "bg-muted text-muted-foreground"}`}
        >
          {chosen ? <><SuccessCheck size={14} />Chosen</> : usable ? <>Use this setup<Icon name="arrowUpRight" size={13} /></> : "Not available"}
        </button>
        {/* Its own Analyze, the same size and text as "Use this setup" beside it; it hands this very setup over. */}
        {analyze ? <AnalyzeChip coin={s.coin} compact setup={s} className="!h-8 !gap-1 !px-2.5 !text-xs" /> : null}
      </div>
    </article>
  );
}

/* The why, for the "Why" Tip: one line per market (its trend and funding), then how each stop is set. */
function whyLines(list, multi) {
  const clean = (t) => (typeof t === "string" ? t.trim().slice(0, 160) : "");
  if (multi) {
    return list.map((s) => ({ k: s.id || s.coin, head: s.coin, text: clean(s.reason).replace(/;\s*stop .*$/, "") })).filter((x) => x.text);
  }
  const first = list.find((s) => clean(s.reason)) || null;
  const lead = first ? clean(first.reason).replace(/;\s*stop .*$/, "") : "";
  const stops = list.map((s) => {
    const m = /stop ([\d.]+)×/.exec(clean(s.reason));
    return m ? `${s.label} ${m[1]}×` : null;
  }).filter(Boolean);
  return [
    ...(lead ? [{ k: "lead", head: null, text: `${lead}.` }] : []),
    ...(stops.length ? [{ k: "stops", head: null, text: `Stop: ${stops.join(", ")} the 14-bar range. Target: RR × the stop.` }] : []),
  ];
}

export default function SetupsCard({ mid, card }) {
  const snap = usePerpMarkets();
  const list = (Array.isArray(card.setups) ? card.setups : []).filter((s) => s && typeof s.coin === "string" && s.coin).slice(0, 3);
  const coins = [...new Set(list.map((s) => s.coin))];
  const one = card.coin || (coins.length === 1 ? coins[0] : null);
  const market = one ? snap.byCoin[one] || null : null;
  const chosenId = card.chosen ?? null;
  const at = hhmm(card.at);
  const why = whyLines(list, !one);
  const basis = typeof card.basis === "string" && card.basis.trim() ? card.basis.trim().slice(0, 48) : null;
  return (
    <div className="t-rise">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2">
          {one ? <CoinLogo coin={one} size={24} /> : null}
          <span className="truncate text-h2">{one ? pairLabel(one, market) : "Setups"}</span>
          <span className="inline-flex h-5 items-center gap-1 rounded-full bg-success/[.08] px-1.5 text-[11px] font-medium text-success ring-1 ring-inset ring-success/15">
            <Icon name="check" size={11} strokeWidth={2.2} />Recommended
          </span>
        </span>
        {at ? <span className="font-mono text-[11px] text-muted-foreground">{at}</span> : null}
      </div>

      {list.length ? (
        <div className="mt-2.5 [container-type:inline-size]">
          <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1 [@container(min-width:600px)]:mx-0 [@container(min-width:600px)]:grid [@container(min-width:600px)]:grid-cols-3 [@container(min-width:600px)]:overflow-visible [@container(min-width:600px)]:px-0">
            {list.map((s, i) => (
              <SetupBox key={s.id || `${s.coin}${i}`} s={s} mid={mid} card={card} index={i} market={snap.byCoin[s.coin] || null}
                chosen={chosenId != null && chosenId === s.id} multi={!one} analyze={!card.noAnalyze} />
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No setup right now: not enough recent price data.</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {why.length ? (
          <Tip label="Why" align="start">
            <span className="block space-y-1">
              {why.map((w) => (
                <span key={w.k} className="block">
                  {w.head ? <span className="font-medium">{w.head}: </span> : null}{w.text}
                </span>
              ))}
            </span>
          </Tip>
        ) : null}
        <Tip label="Not advice" align="start">
          {basis ? `${basis}. ` : ""}Each setup is built from recent candles: the price range sets the stop, the target is a
          multiple of it. It is data, not advice. Choosing one shows the trade card; nothing is sent until you confirm.
        </Tip>
      </div>
    </div>
  );
}
