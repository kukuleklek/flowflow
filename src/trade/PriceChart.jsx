import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, HistogramSeries, LineStyle } from "lightweight-charts";
import { fetchHlCandles, subscribeHlCandles, mergeHlCandle, hlPriceDecimals } from "../lib/hyperliquid/index.js";
import { IconSwap } from "../ui/kit/index.ts";
import Seg from "../ui/Seg.jsx";
import Icon from "../ui/Icon.jsx";
import { IconButton } from "../ui/Button.jsx";
import LiveDot from "../ui/LiveDot.jsx";

/* The price chart, on Hyperliquid's candles: TradingView lightweight-charts v5. Candles stay green/red; the chart's
   quietness comes from a 5% grid and 16% volume. History from candleSnapshot, the forming bar from the WS `candle`
   stream on the tab's one socket. The TradingView attribution logo stays on (the library's licence asks for it). */
export const CHART_LIGHT = Object.freeze({
  up: "#05773b",
  down: "#ad000e",
  upVol: "rgba(5,119,59,0.16)",
  downVol: "rgba(173,0,14,0.16)",
  text: "#5a5a64",
  grid: "rgba(9,9,11,0.05)", // horizontal lines
  gridV: "rgba(9,9,11,0.035)", // vertical lines
  border: "#e2e2e5",
  crosshair: "rgba(9,9,11,0.3)",
  labelBg: "#09090b",
  bg: "transparent",
  font: "Geist, ui-sans-serif, system-ui",
  fontSize: 11,
});

/* The user's own plan is the only other colour on the chart (chartLinesFor ids). Titles stay as given. */
const LINE_BY_ID = {
  entry: { color: "#09090b", lineStyle: LineStyle.Dashed },
  liq: { color: "#8e5300", lineStyle: LineStyle.LargeDashed },
  tp: { color: "#05773b", lineStyle: LineStyle.Dashed },
  sl: { color: "#ad000e", lineStyle: LineStyle.Dashed },
};

/* Axis, last-price and plan-line labels group thousands like every other price in the app ("2,415.7", not
   "2415.7"), at the market's own tick precision. Display only: the candles and the precision are unchanged. */
const GROUPED = new Map();
const grouped = (d) => {
  let f = GROUPED.get(d);
  if (!f) { f = new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); GROUPED.set(d, f); }
  return f;
};

/* The opening view: candles at a readable ~6px pitch, the latest on the right (the mocks show ~60 bars on a phone and
   ~160 on desktop, not all 300 squeezed into hairlines). Fewer bars than fit → the whole history. Scrolling and
   zooming are unchanged, and a wider panel (fullscreen) simply shows more history. */
const BAR_SPACING = 6;

export const TIMEFRAMES = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1D", label: "1D" },
];

export default function PriceChart({ coin, szDecimals = null, refPx = null, lines = [], height = 420, compact = false, fitLines = false }) {
  const box = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volRef = useRef(null);
  const priceLinesRef = useRef([]);
  const [tf, setTf] = useState("1h");
  const [state, setState] = useState("loading"); // loading | ready | error
  const [live, setLive] = useState(false);
  const [fs, setFs] = useState(false);

  /* One chart per mount. */
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const crossLine = { color: CHART_LIGHT.crosshair, width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: CHART_LIGHT.labelBg };
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: CHART_LIGHT.bg },
        textColor: CHART_LIGHT.text,
        fontFamily: CHART_LIGHT.font,
        fontSize: CHART_LIGHT.fontSize,
        attributionLogo: true,
      },
      grid: { vertLines: { color: CHART_LIGHT.gridV }, horzLines: { color: CHART_LIGHT.grid } },
      rightPriceScale: { borderColor: CHART_LIGHT.border, autoScale: true, scaleMargins: { top: 0.12, bottom: 0.2 } },
      timeScale: { borderColor: CHART_LIGHT.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: 0, vertLine: crossLine, horzLine: crossLine },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: CHART_LIGHT.up, downColor: CHART_LIGHT.down, borderVisible: false,
      wickUpColor: CHART_LIGHT.up, wickDownColor: CHART_LIGHT.down,
      priceLineStyle: LineStyle.Dotted, priceLineWidth: 1,
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });
    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; volRef.current = null; priceLinesRef.current = []; };
  }, []);

  /* Price precision: Hyperliquid's own tick rule for this market. */
  useEffect(() => {
    const s = seriesRef.current;
    const d = hlPriceDecimals(refPx, szDecimals);
    if (!s || d == null) return;
    const f = grouped(d);
    s.applyOptions({ priceFormat: { type: "custom", minMove: 1 / 10 ** d, formatter: (p) => f.format(p) } });
  }, [refPx, szDecimals]);

  /* History, then the stream, per coin and timeframe. */
  useEffect(() => {
    const s = seriesRef.current;
    const v = volRef.current;
    if (!coin || !s || !v) return undefined;
    let alive = true;
    let list = [];
    let unsub = null;
    setState("loading");
    setLive(false);
    s.setData([]);
    v.setData([]);
    const volOf = (c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? CHART_LIGHT.upVol : CHART_LIGHT.downVol });
    fetchHlCandles(coin, tf, { bars: 300, fresh: true })
      .then((candles) => {
        if (!alive) return;
        list = candles;
        s.setData(candles);
        v.setData(candles.map(volOf));
        const ts = chartRef.current?.timeScale();
        if (ts) {
          const w = box.current ? box.current.clientWidth : 0;
          if (w && candles.length * BAR_SPACING > w) { ts.applyOptions({ barSpacing: BAR_SPACING }); ts.scrollToRealTime(); }
          else ts.fitContent();
        }
        setState(candles.length ? "ready" : "error");
        try {
          unsub = subscribeHlCandles(coin, tf, (c) => {
            if (!alive) return;
            const next = mergeHlCandle(list, c);
            if (next === list) return;
            list = next;
            s.update(c);
            v.update(volOf(c));
            setLive(true);
          });
        } catch { /* no stream: the history stands */ }
      })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; if (typeof unsub === "function") unsub(); };
  }, [coin, tf]);

  /* Entry / liquidation / TP / SL as price lines (chartLinesFor). */
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const pl of priceLinesRef.current) { try { s.removePriceLine(pl); } catch { /* chart gone */ } }
    priceLinesRef.current = (lines || []).map((l) => {
      const st = LINE_BY_ID[l.id] || { color: "#5a5a64", lineStyle: LineStyle.Dashed };
      return s.createPriceLine({ price: l.price, color: st.color, lineWidth: 1, lineStyle: st.lineStyle, axisLabelVisible: true, title: l.title });
    });
    /* fitLines (the Agent's final popup): every level the order carries stays inside the scale, liquidation included
       (pass-2: the liq line sat off a TSLA 3x chart). The market page keeps its own scale (a far liquidation line there
       would flatten the candles). */
    if (fitLines) {
      const ps = (lines || []).map((l) => l && l.price).filter((p) => typeof p === "number" && Number.isFinite(p) && p > 0);
      s.applyOptions({
        autoscaleInfoProvider: (orig) => {
          const r = orig();
          if (!r || !r.priceRange || !ps.length) return r;
          return { priceRange: { minValue: Math.min(r.priceRange.minValue, ...ps), maxValue: Math.max(r.priceRange.maxValue, ...ps) }, margins: r.margins };
        },
      });
    }
  }, [lines, state, fitLines]);

  /* Fullscreen lays the same panel over the page (Escape leaves). */
  useEffect(() => {
    if (!fs) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setFs(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [fs]);

  return (
    <div className={`flex flex-col bg-background ${fs ? "fixed inset-0 z-[60]" : compact ? "h-full min-h-0 flex-1" : ""}`}>
      <div className="flex h-12 shrink-0 items-stretch justify-between gap-2 border-b border-hairline px-2 lg:px-4">
        <Seg variant="line" size="bar" mono label="Interval" value={tf} onChange={setTf} items={TIMEFRAMES} className="[--line-bottom:-1px] [--line-inset:8px]" />
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {live
            ? <span className="inline-flex items-center gap-1.5"><LiveDot pulse />Live</span>
            : state === "error" ? <span className="t-swap-in">No candles for this interval</span> : null}
          <IconButton label={fs ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFs((v) => !v)}>
            <IconSwap state={fs ? "b" : "a"} a={<Icon name="expand" size={16} />} b={<Icon name="x" size={16} />} />
          </IconButton>
        </div>
      </div>
      <div className={`relative min-h-0 ${fs || compact ? "flex-1" : "shrink-0"}`} style={{ height: fs || compact ? undefined : height }}>
        <div ref={box} className="absolute inset-0" />
        {state === "loading" ? <div className="skeleton-shimmer pointer-events-none absolute inset-3 rounded-md opacity-60" /> : null}
      </div>
    </div>
  );
}
