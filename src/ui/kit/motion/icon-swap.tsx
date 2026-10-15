import type { ReactNode } from "react";
import { cn } from "./cn";
import type { IconSlot } from "./motion-logic";

/**
 * 09 Icon swap: every icon stays mounted in one grid cell; the active slot fades / un-blurs / scales in, the others
 * out. Pure CSS (copy → check, sun ↔ moon, idle → spinner → check). Decorative: give the control its own label.
 */
export function IconSwap({
  state,
  a,
  b,
  c,
  d,
  className,
}: {
  state: IconSlot;
  a: ReactNode;
  b: ReactNode;
  c?: ReactNode;
  d?: ReactNode;
  className?: string;
}) {
  const slots: [IconSlot, ReactNode][] = [
    ["a", a],
    ["b", b],
  ];
  if (c !== undefined) slots.push(["c", c]);
  if (d !== undefined) slots.push(["d", d]);
  return (
    <span className={cn("t-icon-swap", className)} data-state={state} aria-hidden="true">
      {slots.map(([slot, icon]) => (
        <span key={slot} className="t-icon" data-icon={slot}>
          {icon}
        </span>
      ))}
    </span>
  );
}
