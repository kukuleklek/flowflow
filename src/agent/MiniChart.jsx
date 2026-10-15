import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineStyle } from "lightweight-charts";
import { fetchHlCandles, subscribeHlCandles, mergeHlCandle } from "../lib/hyperliquid/index.js";
import { CHART_LIGHT } from "../trade/PriceChart.jsx";

const FONT = CHART_LIGHT.font || "Geist, ui-sans-serif, system-ui";
const fin = (v) => typeof v === "number" && Number.isFinite(v);
/** Bars of empty space after the newest candle, where the TP / SL tags sit. */
const GUTTER_BARS = 4;
const sameTags = (a, b) => a.length === b.length && a.every((t, i) => t.id === b[i].id && Math.round(t.y) === Math.round(b[i].y));

/* The small chart inside a trade card: 48 hourly candles, no axes. Only the newest card streams (live); an older
   card keeps the bars it drew, so a long conversation never holds a socket subscription per card.
   `lines` (optional) are the order's own TP / SL: dashed, in their leg colour, and always inside the scale. The
   dotted ink line is "Now", the latest price. Drawing only: nothing here reads or changes the order. */
export default function MiniChart({ coin, live = false, height = 112, lines = [] }) {
  const box = useRef(null);
  const series = useRef(null);
  const drawn = useRef([]);
  const plan = useRef([]);
  const place = useRef(() => {});
  const [tags, setTags] = useState([]);
  const [drawnCoin, setDrawnCoin] = useState(null);
  const linesKey = JSON.stringify((lines || []).map((l) => [l.id, l.price]));
  plan.current = (lines || []).filter((l) => l && fin(l.price));

  useEffect(() => {
    const el = box.current;
    if (!el || !coin) return undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: CHART_LIGHT.text, fontFamily: FONT, fontSize: 10, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false, rightOffset: GUTTER_BARS },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });
    const s = chart.addSeries(CandlestickSeries, {
      upColor: CHART_LIGHT.up, downColor: CHART_LIGHT.down, borderVisible: false,
      wickUpColor: CHART_LIGHT.up, wickDownColor: CHART_LIGHT.down, lastValueVisible: false,
      priceLineVisible: true, priceLineStyle: LineStyle.Dotted, priceLineColor: "#09090b", priceLineWidth: 1,
    });
    series.current = s;
    drawn.current = [];
    let alive = true;
    let list = [];
    let unsub = null;
    let frame = 0;
    /* The TP / SL tags sit under their lines at the right edge. The pane draws a price line's title only beside a
       visible price scale, and this chart has none, so the tags are placed here after each redraw. */
    place.current = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!alive) return;
          const out = [];
          for (const l of plan.current) {
            const y = s.priceToCoordinate(l.price);
            if (fin(y)) out.push({ id: l.id, y });
          }
          setTags((prev) => (sameTags(prev, out) ? prev : out));
        });
      });
    };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => place.current()) : null;
    if (ro) ro.observe(el);
    fetchHlCandles(coin, "1h", { bars: 48 }).then((c) => {
      if (!alive) return;
      list = c;
      s.setData(c);
      /* An empty gutter on the right for the TP / SL tags (pass-2 review: "SL" sat on the newest candles): the bars end
         a few bar-widths before the edge, and new bars keep that gutter as they stream in. */
      if (c.length) chart.timeScale().setVisibleLogicalRange({ from: 0, to: c.length - 1 + GUTTER_BARS });
      else chart.timeScale().fitContent();
      setDrawnCoin(coin);
      place.current();
      if (live) {
        try {
          unsub = subscribeHlCandles(coin, "1h", (k) => {
            const next = mergeHlCandle(list, k);
            if (next !== list) { list = next; s.update(k); place.current(); }
          });
        } catch { /* no stream */ }
      }
    }).catch(() => { if (alive) setDrawnCoin(coin); });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      if (ro) ro.disconnect();
      if (typeof unsub === "function") unsub();
      series.current = null;
      drawn.current = [];
      place.current = () => {};
      chart.remove();
    };
  }, [coin, live]);

  /* The plan's TP / SL lines. Re-applied whenever the chart is recreated (coin, live) or a price changes. */
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const pl of drawn.current) { try { s.removePriceLine(pl); } catch { /* chart gone */ } }
    drawn.current = [];
    const ps = [];
    for (const l of lines || []) {
      if (!l || !fin(l.price)) continue;
      ps.push(l.price);
      drawn.current.push(s.createPriceLine({
        price: l.price,
        color: l.id === "tp" ? CHART_LIGHT.up : CHART_LIGHT.down,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: l.id === "tp" ? "TP" : "SL",
      }));
    }
    s.applyOptions({
      autoscaleInfoProvider: (orig) => {
        const r = orig();
        if (!r || !r.priceRange || !ps.length) return r;
        return { priceRange: { minValue: Math.min(r.priceRange.minValue, ...ps), maxValue: Math.max(r.priceRange.maxValue, ...ps) }, margins: r.margins };
      },
    });
    place.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, coin, live]);

  return (
    <div className="relative w-full" style={{ height }} aria-hidden="true">
      {/* Until the candles land, the chart's place shimmers (PriceChart's inset loading block), never a blank. */}
      {drawnCoin !== coin ? <div className="skeleton-shimmer pointer-events-none absolute inset-0 rounded-md opacity-60" /> : null}
      <div ref={box} className="absolute inset-0" />
      {tags.map((t) => (
        <span
          key={t.id}
          className={`pointer-events-none absolute right-0 text-[10px] font-medium leading-none ${t.id === "tp" ? "text-success" : "text-destructive"}`}
          style={{ top: Math.min(Math.max(0, t.y > height / 2 ? t.y - 13 : t.y + 3), height - 10) }}
        >
          {t.id === "tp" ? "TP" : "SL"}
        </span>
      ))}
    </div>
  );
}
