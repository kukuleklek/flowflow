"use client";

import { useState } from "react";
import { cn } from "./cn";
import { splitDigits } from "./motion-logic";

/**
 * 02 Number pop-in for polled values (balances, counters, approvals, confirmations). The first render is plain text
 * (no animation); each later change re-enters the characters with the snippet's blurred rise, the last two
 * staggered. tabular-nums keeps the width steady. The text content is always exactly `value`.
 */
export function AnimatedNumber({ value, className }: { value: string; className?: string }) {
  const [track, setTrack] = useState({ value, gen: 0 });
  if (track.value !== value) setTrack({ value, gen: track.gen + 1 });
  const gen = track.value === value ? track.gen : track.gen + 1;

  if (gen === 0) return <span className={cn("tabular-nums", className)}>{value}</span>;
  // A new key per change remounts the group, which replays the keyframes (the snippet's remove/reflow/re-add).
  return (
    <span key={gen} className={cn("t-digit-group is-animating tabular-nums", className)}>
      {splitDigits(value).map((c, i) => (
        <span
          key={i}
          className="t-digit"
          {...(c.stagger ? { "data-stagger": String(c.stagger) } : {})}
          {...(c.space ? { "data-space": "" } : {})}
        >
          {c.ch}
        </span>
      ))}
    </span>
  );
}
