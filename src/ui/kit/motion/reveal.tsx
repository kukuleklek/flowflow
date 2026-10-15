"use client";

import { type ReactNode, useRef, useState } from "react";
import { cn } from "./cn";
import { useIsoLayoutEffect } from "./iso-layout-effect";
import { type RevealPhase, nextRevealPhase } from "./motion-logic";
import { readMotionMs } from "./use-motion";

/**
 * 14 Skeleton loader and reveal. `loading` means "no data yet" (first load only: callers pass
 * `isLoading && items.length === 0`, so a background refetch never shows the skeleton again). Data present on mount
 * renders directly; data that arrives later cross-fades + cross-blurs over the skeleton in the same grid cell.
 */
export function Reveal({
  loading,
  skeleton,
  children,
  className,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [phase, setPhase] = useState<RevealPhase>(loading ? "loading" : "done");
  const next = nextRevealPhase(phase, loading);
  if (next !== phase) setPhase(next);
  const ref = useRef<HTMLDivElement>(null);

  useIsoLayoutEffect(() => {
    if (next !== "revealing") return;
    const el = ref.current;
    if (el) {
      void el.offsetWidth; // the content's hidden start state is computed before the reveal class lands
      el.classList.add("is-revealed");
    }
    const t = window.setTimeout(() => setPhase("done"), readMotionMs("--reveal-dur", 400));
    return () => window.clearTimeout(t);
  }, [next]);

  return (
    <div
      ref={ref}
      className={cn("t-skel", next === "done" && "is-revealed", className)}
      aria-busy={next === "loading" ? true : undefined}
    >
      {next !== "done" ? (
        <div
          key="skeleton"
          className="t-skel-skeleton"
          aria-hidden={next === "revealing" ? true : undefined}
        >
          {skeleton}
        </div>
      ) : null}
      {next !== "loading" ? (
        <div key="content" className="t-skel-content">
          {children}
        </div>
      ) : null}
    </div>
  );
}
