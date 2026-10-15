import { useRef } from "react";
import { useSlidingPill } from "./kit/index.ts";

/* variant "seg"   = value picker: muted track + one travelling white pill. 44px track on phones.
   variant "line"  = view switcher: text tabs + one sliding 2px ink bar.
   variant "title" = section-title tabs (Perps 80 · Watchlist 2): colour only, no bar.
   items: [{ value, label, tone?: "long"|"short", icon?, count? }] */
const SEG_H = {
  /* A header pill beside a title (Deposit's Normal | Private): 28px items on every width, the 44px touch area kept by ff-hit. */
  xs: "ff-hit h-7 px-2.5 text-xs font-medium",
  sm: "h-10 px-3 text-sm font-medium lg:h-7 lg:text-xs",
  md: "h-10 px-3 text-sm font-medium lg:h-8",
  lg: "h-10 px-3 text-sm font-medium",
};
const LINE_H = {
  sm: "h-11 px-2 text-xs font-medium lg:h-10",
  md: "h-11 px-2.5 text-sm font-medium",
  bar: "h-12 px-2 text-xs font-medium",
};
const TITLE_H = "h-12 mr-5 px-0 text-h2";

export default function Seg({ items, value, onChange, label, full = false, size = "md", variant = "seg", mono = false, className = "" }) {
  const list = useRef(null);
  const pill = useRef(null);
  useSlidingPill(list, pill, '[aria-selected="true"]');
  const box = variant === "seg" ? "ff-seg" : variant === "title" ? "ff-line ff-title" : "ff-line";
  const h = variant === "seg" ? SEG_H[size] || SEG_H.md : variant === "title" ? TITLE_H : LINE_H[size] || LINE_H.md;
  return (
    <div ref={list} role="tablist" aria-label={label} className={`t-tabs ${box} ${full ? "flex w-full" : "inline-flex"} ${className}`}>
      <span ref={pill} className="t-tabs-pill" aria-hidden="true" />
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={String(it.value)}
            type="button"
            role="tab"
            aria-selected={on ? "true" : "false"}
            data-tone={it.tone || undefined}
            onClick={() => { if (!on) onChange(it.value); }}
            className={`t-tab ${h} ${full ? "flex-1" : "shrink-0"} inline-flex items-center justify-center gap-1.5 whitespace-nowrap ${mono ? "font-mono" : ""}`}
          >
            {it.icon || null}
            {it.label}
            {it.count != null ? <span className="font-mono text-[11px] font-normal text-muted-foreground">{it.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
