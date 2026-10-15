/* One market, analyzed (owner, polish 1: "กดเข้าไป ช่วยคิด Downtrend หรือ มันจะ Uptrend วันไหน Emission เป็นไง เสี่ยงอะไรไหม
   RR ควรเปลี่ยนเท่าไหร่"). The answer to the "Analyze" pill, as ONE compact card where the numbers do the talking:
     trend      up / down / range on 1h, 4h and 1d, and the levels that would flip it (never a date)
     emission   the next unlock, its share of circulating, its value and the monthly pace (Tokenomist), or the dash
     risks      small chips, coloured by level
     RR         the setup's (or the position's) RR / TP / SL now, what it could be, and one tap to use it
   The explanations sit in Tips. Built by src/agent/analyze.js from real data only: an unknown figure is null, drawn as
   the dash, never 0. Tokenomist's wordmark shows only when its key is on AND it covers the coin.

   "Use adjusted setup" puts a normal trade card in the chat (setups.js setupToOpenCard re-applies the setup caps in
   code: ≤ 3x, ≤ 20 USDC margin; the trade card caps leverage again). For a held position it is the position's TP / SL
   card, never a new opposite position. Nothing here sends anything: every card still waits for Confirm.

   Compact at every width (review, polish 1: 529px on a 390 phone): the labels stay left of their rows, a trend note
   is one line on a phone, at most three risk chips there (the worst first, "+N" for the rest). In the RR table only
   a figure that really changes is drawn in ink (a cent of re-rounding is not a change), and each suggested TP / SL
   says how far it is from the price.

   Card kind "analysis": { coin, at, price, change24hPct, fundingPctPerHour, volume24hUsd,
     trend: { h1, h4, d1 } each { dir: "up"|"down"|"range", emaSlopePct, note },
     flip: { upAbove, downBelow, basis }, emission: { configured, covered, nextUnlock: { date, inDays, pctCirculating, usd }
     | null, monthlyPct, url }, risks: [{ id, level: "low"|"medium"|"high", text }],
     rr: { current: { side, lev, entry, tp, sl, rr } | null, suggested: { side, lev, entry, tp, sl, rr, why } | null },
     adjustedSetup, tpsl, basis, chosen? } */
import { SuccessCheck } from "../../ui/kit/index.ts";
import Icon from "../../ui/Icon.jsx";
import Tip from "../../ui/Tip.jsx";
import CoinLogo from "../../ui/CoinLogo.jsx";
import SponsorLogo, { TOKENOMIST_URL } from "../../ui/SponsorLogo.jsx";
import { sidePill } from "../../ui/badge.js";
import { minus } from "../../ui/num.js";
import { usePerpMarket, formatHlPrice, formatHlPct } from "../../lib/hyperliquid/index.js";
import { perpCoinLabel } from "../../perp/live/perpLiveView.js";
import { chat } from "../store.js";
import { setupToOpenCard } from "../setups.js";
import { rrText } from "./SetupsCard.jsx";
import { tokenomistFor, Glyph } from "./ChatActions.jsx";
import { coinLabel, pairLabel } from "./viewWords.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const DAY = 86_400_000;
const hhmm = (t) => (fin(t) ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null);
const clean = (s, n) => (typeof s === "string" ? s.replace(/[^\p{L}\p{N} &()./%+,;$:·×<>~≈-]/gu, "").trim().slice(0, n) : "");
const compactUsd = (v) => (fin(v) ? `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v)}` : "—");
const pctOf = (v) => (fin(v) ? `${Math.abs(v) < 0.1 ? v.toFixed(2) : v.toFixed(1)}%` : "—");

/* The three timeframes, each drawn as one cell. */
const TF = [["h1", "1h"], ["h4", "4h"], ["d1", "1d"]];
const DIR = {
  up: { word: "Up", glyph: "up", tone: "text-success" },
  down: { word: "Down", glyph: "down", tone: "text-destructive" },
  range: { word: "Range", glyph: "flat", tone: "text-muted-foreground" },
};

function TrendCell({ t, name, first }) {
  const d = t && DIR[t.dir] ? DIR[t.dir] : null;
  const note = t ? clean(t.note, 48) : "";
  return (
    <div className={`min-w-0 px-4 py-1.5 [@container(min-width:520px)]:py-2 ${first ? "" : "border-l border-hairline"}`}>
      <div className="font-mono text-[11px] leading-4 text-muted-foreground">{name}</div>
      <div className={`mt-0.5 flex items-center gap-1 text-sm font-medium ${d ? d.tone : "text-muted-foreground"}`}>
        {d ? <Glyph name={d.glyph} size={14} /> : null}
        {d ? d.word : "—"}
      </div>
      {/* The note on a wider card (two lines at most); a phone keeps the direction, its arrow and colour. */}
      {note ? <div className="mt-0.5 hidden text-[11px] leading-snug text-muted-foreground [@container(min-width:520px)]:line-clamp-2">{note}</div> : null}
    </div>
  );
}

/* Left label, right content: the card's quiet rows (emission, risks), the label left at every width so a row is one
   line where it can be. */
function Row({ label, children, aside = null }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-hairline px-4 py-1.5 [@container(min-width:520px)]:py-2">
      <span className="pt-[3px] text-label text-muted-foreground">{label}</span>
      <div className="min-w-0 text-xs">{children}</div>
      {aside ? <span>{aside}</span> : null}
    </div>
  );
}

function toTime(d) {
  if (fin(d)) return d < 1e12 ? d * 1000 : d;
  if (typeof d === "string" && d) { const t = Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d); return Number.isFinite(t) ? t : null; }
  return null;
}
const dateText = (t) => (t == null ? "—" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
function inDaysText(n) {
  if (!fin(n)) return null;
  const d = Math.round(n);
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
}
/* Tokenomist's own page for the token when the card names one (tokenomist.ai only), else its home. */
const pageOf = (url) => (typeof url === "string" && /^https:\/\/(www\.)?tokenomist\.ai(\/[a-z0-9/-]*)?$/i.test(url) ? url : TOKENOMIST_URL);

/* A stock's row where a token's emission would be: the US market's state (open / outside hours / closed, when it
   opens), from hip3/hours.js. No Tokenomist: a share has no unlocks. */
function UsMarket({ e }) {
  const row = e.usMarket && e.usMarket.en && typeof e.usMarket.en === "object" ? e.usMarket.en : { label: "US market", value: "—", tone: "muted" };
  const dot = e.state === "open" ? "bg-success" : row.tone === "warn" ? "bg-warning" : "bg-muted-foreground";
  return (
    <Row label="Market">
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="text-muted-foreground">{row.label}</span>
        <span className="num font-medium">{row.value}</span>
      </span>
    </Row>
  );
}

function Emission({ e, coin, sym }) {
  if (e && e.stock) return <UsMarket e={e} />;
  const on = !!(e && e.configured === true && e.covered === true && !e.error && tokenomistFor(coin));
  if (!on) {
    const configured = !!(e && e.configured === true && tokenomistFor(coin));
    const [tip, why] = !configured
      ? ["Emission data not connected", "Unlocks and emission come from Tokenomist once it is connected here. Until then nothing is read, and nothing is claimed."]
      : e.covered === false
        ? ["No emission data", `Tokenomist has no unlock schedule for ${sym}.`]
        : ["Couldn't read unlocks", "Tokenomist didn't answer just now. Ask again in a moment."];
    return (
      <Row label="Emission">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="num font-medium text-muted-foreground">—</span>
          <Tip label={tip} align="start">{why}</Tip>
        </span>
      </Row>
    );
  }
  const n = e.nextUnlock && typeof e.nextUnlock === "object" ? e.nextUnlock : null;
  const t = n ? toTime(n.date) : null;
  const away = n ? inDaysText(fin(n.inDays) ? n.inDays : t != null ? (t - Date.now()) / DAY : null) : null;
  const logo = (
    <a href={pageOf(e.url)} target="_blank" rel="noopener noreferrer" aria-label="Data from Tokenomist" className="ff-press inline-flex shrink-0 items-center rounded-md pt-0.5">
      <SponsorLogo name="tokenomist" variant="wordmark" size={13} alt="Tokenomist" />
    </a>
  );
  return (
    <Row label="Emission" aside={logo}>
      {n ? (
        <>
          <div className="num font-medium">Next unlock {dateText(t)}{away ? <span className="font-normal text-muted-foreground"> · {away}</span> : null}</div>
          <div className="num mt-0.5 text-muted-foreground">
            {pctOf(n.pctCirculating)} of circulating · {compactUsd(n.usd)}
            {fin(e.monthlyPct) ? <> · pace {pctOf(e.monthlyPct)}/mo</> : null}
          </div>
        </>
      ) : (
        <div className="num">
          <span className="font-medium">No unlock soon</span>
          {fin(e.monthlyPct) ? <span className="text-muted-foreground"> · pace {pctOf(e.monthlyPct)}/mo</span> : null}
        </div>
      )}
    </Row>
  );
}

const LEVEL = { high: 0, medium: 1, low: 2 };
const LEVEL_TONE = {
  high: "bg-destructive/[.07] text-destructive ring-destructive/20",
  medium: "bg-warning/[.08] text-warning ring-warning/20",
  low: "bg-muted text-muted-foreground ring-transparent",
};

/* At most this many chips on a phone (the worst first; "+N" says how many more: two chips and the count fit two
   lines of a 390px screen), all of them (up to five) wider. */
const PHONE_RISKS = 2;
const WIDE_ONLY = "hidden [@container(min-width:520px)]:inline-flex";

/* A risk's words; on a phone, only what comes before its comma ("Liquidation 16.7% away", not ", ≈4.3 daily
   ranges"), so two chips and the count share two lines. */
function RiskText({ text }) {
  const i = text.indexOf(", ");
  if (i < 0) return <span className="truncate">{text}</span>;
  return (
    <span className="truncate">
      {text.slice(0, i)}
      <span className="hidden [@container(min-width:520px)]:inline">{text.slice(i)}</span>
    </span>
  );
}

function Risks({ list }) {
  const risks = (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r.text === "string" && r.text.trim() && LEVEL[r.level] != null)
    .sort((a, b) => LEVEL[a.level] - LEVEL[b.level])
    .slice(0, 5);
  const more = risks.length - PHONE_RISKS;
  return (
    <Row label="Risks">
      {risks.length ? (
        <ul className="flex flex-wrap gap-1">
          {risks.map((r, i) => (
            <li key={`${r.id || "r"}${i}`} className={`h-[22px] max-w-full items-center gap-1.5 rounded-full px-2 text-[11px] font-medium ring-1 ring-inset ${LEVEL_TONE[r.level]} ${i < PHONE_RISKS ? "inline-flex" : WIDE_ONLY}`}>
              <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
              <RiskText text={minus(clean(r.text, 72))} />
              <span className="sr-only">({r.level} risk)</span>
            </li>
          ))}
          {more > 0 ? (
            <li className="inline-flex h-[22px] items-center rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground [@container(min-width:520px)]:hidden" title={risks.slice(PHONE_RISKS).map((r) => clean(r.text, 72)).join(" · ")}>
              +{more}
            </li>
          ) : null}
        </ul>
      ) : <span className="text-muted-foreground">—</span>}
    </Row>
  );
}

/* Does a suggested figure really change? A price within 0.1% (re-rounding), the same leverage, an RR within 0.05:
   no. The analysis says which legs it moves (suggested.moved); the tolerance covers a card saved without it. */
function changedCols(cur, sug) {
  if (!cur || !sug) return { rr: false, tp: false, sl: false, lev: false };
  const ref = fin(sug.entry) && sug.entry > 0 ? sug.entry : fin(cur.entry) && cur.entry > 0 ? cur.entry : 1;
  const px = (a, b) => (fin(a) !== fin(b)) || (fin(a) && fin(b) && Math.abs(a - b) > ref * 0.001);
  const mv = sug.moved && typeof sug.moved === "object" ? sug.moved : null;
  return {
    rr: (fin(cur.rr) !== fin(sug.rr)) || (fin(cur.rr) && fin(sug.rr) && Math.abs(cur.rr - sug.rr) >= 0.05),
    tp: mv ? !!mv.tp && px(cur.tp, sug.tp) : px(cur.tp, sug.tp),
    sl: mv ? !!mv.sl && px(cur.sl, sug.sl) : px(cur.sl, sug.sl),
    lev: fin(cur.lev) && fin(sug.lev) ? cur.lev !== sug.lev : false,
  };
}

/* "+4.6%" / "−1.7%": how far a price is from where the market is now. */
const awayText = (v, ref) => (fin(v) && fin(ref) && ref > 0 ? minus(`${v >= ref ? "+" : "-"}${Math.abs((v / ref - 1) * 100).toFixed(1)}%`) : null);

/* Now vs. suggested, four columns across the card. Only a suggested figure that really changes is drawn in ink (TP
   green, SL red); one that stays is drawn quiet, with the same value. Each suggested TP / SL says how far it is from
   the price (the mark for a position). */
function RrTable({ current, suggested, px, refPx }) {
  const ch = changedCols(current, suggested);
  const cols = [
    ["RR", "rr", (x) => (x && fin(x.rr) ? rrText(x.rr) : "—")],
    ["TP", "tp", (x) => (x ? px(x.tp) : "—")],
    ["SL", "sl", (x) => (x ? px(x.sl) : "—")],
    ["Lev", "lev", (x) => (x && fin(x.lev) ? `${x.lev}x` : "—")],
  ];
  const rows = [["Now", current], ["Suggested", suggested]].filter(([, x]) => x);
  return (
    <div className="num mt-1.5 grid grid-cols-[70px_repeat(4,minmax(0,1fr))] gap-x-2 gap-y-0.5 text-xs [@container(min-width:520px)]:grid-cols-[88px_repeat(4,minmax(0,1fr))]" role="table" aria-label="Reward to risk now and suggested">
      <span role="columnheader" />
      {cols.map(([k]) => <span key={k} role="columnheader" className="text-right text-[11px] text-muted-foreground">{k}</span>)}
      {rows.map(([name, x]) => (
        <div key={name} role="row" className="contents">
          <span role="rowheader" className={name === "Suggested" ? "font-medium text-foreground" : "text-muted-foreground"}>{name}</span>
          {cols.map(([k, key, f]) => {
            const v = f(x);
            const sug = name === "Suggested";
            const changed = sug && current ? ch[key] : sug;
            const tone = key === "tp" && v !== "—" ? "text-success" : key === "sl" && v !== "—" ? "text-destructive" : "text-foreground";
            const away = sug && changed && (key === "tp" || key === "sl") ? awayText(x[key], refPx) : null;
            return (
              <span key={k} role="cell" className={`min-w-0 text-right ${!sug || !changed ? "text-muted-foreground" : `font-semibold ${tone}`}`}>
                <span className="block truncate">{v}</span>
                {away ? <span className="block text-[10px] font-normal leading-3 text-muted-foreground">{away}</span> : null}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* What the RR row is about, in the card's words: the position, the setup box or trade card the pill sat on, or the
   app's default setup when nobody picked one (it says so). */
function subjectText(cur, held) {
  if (held) return "Your position";
  const label = cur && typeof cur.label === "string" ? clean(cur.label, 16) : "";
  const src = cur && cur.source;
  if (src === "card") return "This trade card";
  if (src === "default") return `${label || "Balanced"} · default`;
  return label ? `${label} setup` : "Setup";
}

/* The analysis's one action: the adjusted setup as a normal trade card, or, held, the position's TP / SL card. */
function act(mid, card, market) {
  const held = card.held === true || !!card.tpsl;
  if (held) {
    if (!card.tpsl || typeof card.tpsl !== "object") return;
    const t = card.tpsl;
    const tpPct = fin(t.tpPct) ? Math.abs(t.tpPct) : null;
    const slPct = fin(t.slPct) ? Math.abs(t.slPct) : null;
    if (tpPct == null && slPct == null) return;
    try { if (mid != null) chat.patchCard(mid, { chosen: "tpsl" }); } catch { /* the analysis is gone: still show the card */ }
    chat.noteLlm(`The user took the suggested TP / SL for ${card.coin} from the analysis (TP +${tpPct ?? "-"}% SL -${slPct ?? "-"}%, ROE). A TP / SL card is on screen; nothing is sent until they confirm it.`);
    chat.push({ role: "card", card: { kind: "tpsl", coin: card.coin, tpPct, slPct, status: "review", recommended: true } });
    return;
  }
  const c = setupToOpenCard(card.adjustedSetup, { market });
  if (!c || c.coin !== card.coin) return;
  try { if (mid != null) chat.patchCard(mid, { chosen: "setup" }); } catch { /* the analysis is gone: still show the card */ }
  chat.noteLlm(`The user chose the adjusted setup from the analysis: ${c.side === "sell" ? "short" : "long"} ${c.coin} ${c.marginUsdc} USDC ${c.leverage}x, TP +${c.tpPct ?? "-"}% SL -${c.slPct ?? "-"}% (ROE). A trade card is on screen; nothing is sent until they confirm it.`);
  chat.push({ role: "card", card: { ...c, setupLabel: c.setupLabel || "Adjusted" } });
}

export default function AnalysisCard({ mid = null, card }) {
  const { market } = usePerpMarket(card.coin);
  const sz = market ? market.szDecimals : fin(card.szDecimals) ? card.szDecimals : null;
  /* A stock reads by its ticker ("TSLA", "US 100"), never a venue-qualified name. */
  const label = coinLabel(card.coin, market) || perpCoinLabel(card.coin, market);
  const sym = clean(card.symbol, 12) || label;
  const px = (v) => (fin(v) ? formatHlPrice(v, sz) : "—");
  const ch = fin(card.change24hPct) ? card.change24hPct : null;
  const trend = card.trend && typeof card.trend === "object" ? card.trend : {};
  const flip = card.flip && typeof card.flip === "object" ? card.flip : {};
  const rr = card.rr && typeof card.rr === "object" ? card.rr : {};
  const cur = rr.current && typeof rr.current === "object" ? rr.current : null;
  const sug0 = rr.suggested && typeof rr.suggested === "object" ? rr.suggested : null;
  /* A suggestion that changes nothing ("Keep it: …") is its why only: no second row, no button. */
  const same = !!(sug0 && cur && (sug0.keep === true || !Object.values(changedCols(cur, sug0)).some(Boolean)));
  const sug = same ? null : sug0;
  const held = card.held === true || !!card.tpsl;
  const usable = held ? !!(card.tpsl && (fin(card.tpsl.tpPct) || fin(card.tpsl.slPct))) : !!setupToOpenCard(card.adjustedSetup, { market });
  const chosen = typeof card.chosen === "string" && card.chosen;
  /* The pill names what was analyzed: the setup or position as it is now. */
  const side = (cur || sug || {}).side;
  const lev = (cur || sug || {}).lev;
  const Side = side === "sell" || side === "short" ? "Short" : side === "buy" || side === "long" ? "Long" : null;
  const why0 = sug0 ? clean(sug0.why, 140) : "";
  const why = why0 ? why0.charAt(0).toUpperCase() + why0.slice(1) : "";
  const at = hhmm(card.at);
  const flipBasis = clean(flip.basis, 24) || "4h swing";
  /* Where the market is now, for the suggested legs' distances: the mark for a position, the entry for a setup. */
  const refPx = held ? (sug && fin(sug.mark) ? sug.mark : fin(card.price) ? card.price : null) : sug && fin(sug.entry) ? sug.entry : fin(card.price) ? card.price : null;
  /* The Tip names Tokenomist only when the Emission row shows its data. */
  const e = card.emission && typeof card.emission === "object" ? card.emission : null;
  const unlocksOn = !!(e && e.configured === true && e.covered === true && !e.error && tokenomistFor(card.coin));

  return (
    <div className="t-swap-in">
      <div className="flex items-center justify-between gap-3 px-4 pb-1.5 pt-2 [@container(min-width:520px)]:pb-2 [@container(min-width:520px)]:pt-2.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="flex items-center gap-2 self-center">
            <CoinLogo coin={card.coin} size={24} />
            <span className="truncate text-h2">{pairLabel(card.coin, market)}</span>
          </span>
          <span className="num text-sm font-medium">{px(card.price)}</span>
          <span className={`num text-xs ${ch == null ? "text-muted-foreground" : ch >= 0 ? "text-success" : "text-destructive"}`}>
            {ch == null ? "24h —" : `${minus(formatHlPct(ch))} 24h`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 self-start pt-1 font-mono text-[11px] text-muted-foreground">
          <Glyph name="analyze" size={12} /><span className="hidden [@container(min-width:520px)]:inline">Analysis{at ? " ·" : ""}</span>{at || ""}
        </span>
      </div>

      <div className="grid grid-cols-3 border-t border-hairline">
        {TF.map(([k, name], i) => <TrendCell key={k} t={trend[k]} name={name} first={i === 0} />)}
      </div>
      {/* The levels that turn the 4h trend, and how far they are: levels, never a date. A downtrend has only an "up"
          level (and an uptrend only a "down" one); a range has both. */}
      <p className="num flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 border-t border-hairline px-4 py-1.5 text-xs">
        {fin(flip.upAbove) ? (
          <>
            <span className="text-muted-foreground">Turns up above</span>
            <span className="font-medium text-success">{px(flip.upAbove)}</span>
            {fin(flip.upPct) ? <span className="text-[11px] text-muted-foreground">+{flip.upPct}%</span> : null}
          </>
        ) : null}
        {fin(flip.upAbove) && fin(flip.downBelow) ? <span className="text-muted-foreground">·</span> : null}
        {fin(flip.downBelow) ? (
          <>
            <span className="text-muted-foreground">{fin(flip.upAbove) ? "down below" : "Turns down below"}</span>
            <span className="font-medium text-destructive">{px(flip.downBelow)}</span>
            {fin(flip.downPct) ? <span className="text-[11px] text-muted-foreground">{minus(`-${flip.downPct}`)}%</span> : null}
          </>
        ) : null}
        {!fin(flip.upAbove) && !fin(flip.downBelow) ? <span className="text-muted-foreground">No turn level on the 4h chart yet</span> : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{flipBasis}</span>
      </p>

      <Emission e={card.emission} coin={card.coin} sym={sym} />
      <Risks list={card.risks} />

      {cur || sug ? (
        <div className="border-t border-hairline px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-label text-muted-foreground">RR</span>
            {Side ? <span className={sidePill(Side === "Long" ? "long" : "short")}>{fin(lev) ? `${lev}x ` : ""}{Side}</span> : null}
            <span className="num text-muted-foreground">{subjectText(cur, held)} · entry {px((cur || sug).entry)}</span>
          </div>
          <RrTable current={cur} suggested={sug} px={px} refPx={refPx} />
          <p className="mt-1 text-xs text-muted-foreground">{why ? minus(why) : sug ? "" : "The RR holds as set."}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-hairline px-4 py-1.5 [@container(min-width:520px)]:py-2">
        {sug && usable ? (
          <button
            type="button"
            disabled={!!chosen}
            onClick={() => act(mid, card, market)}
            aria-pressed={!!chosen}
            className={`ff-press ff-hit inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors disabled:cursor-default ${
              chosen ? "bg-success/[.12] text-success" : "bg-foreground text-background hover:bg-foreground/90"}`}
          >
            {chosen ? <><SuccessCheck size={14} />{held ? "TP / SL card ready" : "Setup card ready"}</>
              : <>{held ? "Use suggested TP / SL" : "Use adjusted setup"}<Icon name="arrowUpRight" size={14} /></>}
          </button>
        ) : <span />}
        <Tip label="Not advice" align="end">
          Built from live 1h, 4h and 1d candles and funding{unlocksOn ? ", with unlocks from Tokenomist" : ""}.
          The flip levels are where the trend would turn, not a forecast or a date. It is data, not advice. A card
          only shows a trade; nothing is sent until you confirm it.
        </Tip>
      </div>
    </div>
  );
}
