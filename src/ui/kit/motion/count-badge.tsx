import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * 03 Notification badge. Absolute (default): a dot on a trigger, e.g. a pending count on a nav item; it slides +
 * pops in when `open` turns true and pops out when false (the trigger never moves).
 * `inline`: the same slide-in for a count pill in a row's text flow (mount it only while there is a count).
 */
export function CountBadge({
  open,
  children,
  inline = false,
  className,
  label,
}: {
  open: boolean;
  children: ReactNode;
  inline?: boolean;
  className?: string;
  /** Accessible text when the visible content is just a number. */
  label?: string;
}) {
  return (
    <span
      className={cn("t-badge", inline && "t-badge--inline")}
      data-open={String(open)}
      aria-hidden={open ? undefined : true}
    >
      <span className={cn("t-badge-dot", className)}>
        {label ? <span aria-hidden="true">{children}</span> : children}
        {label ? <span className="sr-only">, {label}</span> : null}
      </span>
    </span>
  );
}
