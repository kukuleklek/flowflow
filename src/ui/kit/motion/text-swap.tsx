"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";
import { useIsoLayoutEffect } from "./iso-layout-effect";
import { readMotionMs } from "./use-motion";

/**
 * 04 Text states swap: when `text` changes, the old text exits up with a blur, then the new one rises in. The first
 * render is static. A change during the exit simply retargets (the pending swap is cancelled), so it never blocks.
 */
export function TextSwap({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  const entering = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (text === shown) {
      el?.classList.remove("is-exit");
      return;
    }
    el?.classList.add("is-exit");
    const t = window.setTimeout(
      () => {
        entering.current = true;
        setShown(text);
      },
      readMotionMs("--text-swap-dur", 150),
    );
    return () => window.clearTimeout(t);
  }, [text, shown]);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !entering.current) return;
    entering.current = false;
    el.classList.remove("is-exit");
    el.classList.add("is-enter-start");
    void el.offsetHeight; // reflow: the new text starts below, then transitions to rest
    el.classList.remove("is-enter-start");
  }, [shown]);

  return (
    <span ref={ref} className={cn("t-text-swap", className)}>
      {shown}
    </span>
  );
}
