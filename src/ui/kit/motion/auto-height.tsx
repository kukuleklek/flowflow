"use client";

import { type ReactNode, useRef } from "react";
import { cn } from "./cn";
import { useIsoLayoutEffect } from "./iso-layout-effect";
import { readMotionMs } from "./use-motion";

/**
 * 01 Card resize for content whose height changes (rows added / removed, a panel swapping its body): the outer box
 * tweens its height to the measured inner height. It clips only while tweening (data-resizing), so focus rings are
 * never cut at rest.
 */
export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useIsoLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    let first = true;
    let fallback: number | undefined;
    const done = () => {
      o.removeAttribute("data-resizing");
      if (fallback !== undefined) window.clearTimeout(fallback);
      fallback = undefined;
    };
    const apply = () => {
      const h = `${i.offsetHeight}px`;
      if (first) {
        first = false;
        o.style.transition = "none";
        o.style.height = h;
        void o.offsetHeight;
        o.style.transition = "";
        return;
      }
      if (o.style.height === h) return;
      const dur = readMotionMs("--resize-dur", 300);
      if (dur > 0) {
        o.setAttribute("data-resizing", "");
        if (fallback !== undefined) window.clearTimeout(fallback);
        fallback = window.setTimeout(done, dur + 100);
      }
      o.style.height = h;
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === o && e.propertyName === "height") done();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(i);
    o.addEventListener("transitionend", onEnd);
    return () => {
      ro.disconnect();
      o.removeEventListener("transitionend", onEnd);
      done();
      o.style.height = "";
    };
  }, []);

  return (
    <div ref={outer} className={cn("t-resize", className)}>
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}
