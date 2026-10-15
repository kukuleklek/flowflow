"use client";

import { type ReactNode, useRef } from "react";
import { cn } from "./cn";
import { useIsoLayoutEffect } from "./iso-layout-effect";

// Played once per page load: returning to the page later shows the text at rest.
let playedThisLoad = false;

/**
 * 18 Texts reveal for a sign-in / hero heading + subline: a staggered blurred rise on first paint, once.
 */
export function StaggerText({
  lines,
  className,
}: {
  /** Up to two lines, rendered as given (headline first). */
  lines: [ReactNode, ReactNode?];
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (playedThisLoad) {
      el.classList.add("is-shown");
      return;
    }
    playedThisLoad = true;
    void el.offsetHeight;
    el.classList.add("is-shown");
  }, []);
  const [first, second] = lines;
  return (
    <div ref={ref} className={cn("t-stagger", className)}>
      <div className="t-stagger-line t-stagger-line--1">{first}</div>
      {second !== undefined ? (
        <div className="t-stagger-line t-stagger-line--2">{second}</div>
      ) : null}
    </div>
  );
}
