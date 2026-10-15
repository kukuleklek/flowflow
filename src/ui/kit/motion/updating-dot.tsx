"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";
import { lingerMs } from "./motion-logic";
import { readMotionMs } from "./use-motion";

/**
 * "Loading everywhere": a small pulsing dot next to a section title while a background refetch runs over data
 * already shown (never a skeleton again). Wire `active` to the query's "refetching" flag (TanStack: isFetching
 * without isPending).
 *
 * - The slot is always rendered at a fixed size, so the title row never shifts; the dot only fades.
 * - It stays for at least one pulse cycle (`--skeleton-shimmer-dur`), so a 100 ms poll reads as one calm pulse.
 * - Decorative (aria-hidden): a poll every few seconds must not be announced. The `title` explains it on hover.
 * - Reduced motion: no pulse (css/motion.css), and no minimum visibility.
 */
export function UpdatingDot({ active, className }: { active: boolean; className?: string }) {
  // Visible while active, then "lingering" until one full pulse has played.
  const [lingering, setLingering] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    const shownAt = Date.now();
    window.clearTimeout(timer.current);
    return () => {
      // `active` just turned off (or the dot unmounts): finish the pulse.
      const wait = lingerMs(shownAt, Date.now(), readMotionMs("--skeleton-shimmer-dur", 1300));
      if (wait === 0) return;
      setLingering(true);
      timer.current = window.setTimeout(() => setLingering(false), wait);
    };
  }, [active]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const shown = active || lingering;
  return (
    <span
      aria-hidden="true"
      title={shown ? "Updating" : undefined}
      data-updating={shown ? "true" : "false"}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full bg-brand transition-opacity duration-(--duration-quick) ease-(--ease-in-out)",
        shown ? "t-updating" : "opacity-0",
        className,
      )}
    />
  );
}
