"use client";

import { type ReactNode, useId, useState } from "react";
import { cn } from "./cn";
import { inertProps } from "./inert";

/**
 * 21 Accordion expand: the panel grows via grid-template-rows 0fr ↔ 1fr (no measuring) and the chevron flips.
 * A closed panel is `inert`, so its controls leave the tab order and the accessibility tree.
 */
export function Accordion({
  header,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
  headClassName,
  panelClassName,
}: {
  /** Content of the toggle button (title, status badge…). Keep it non-interactive. */
  header: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode: pass `open` and `onOpenChange` together. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  headClassName?: string;
  /** Padding goes here (on the inner element), never on the grid track. */
  panelClassName?: string;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  const id = useId();
  return (
    <div className={cn("t-acc", className)} data-open={String(open)}>
      <button
        type="button"
        id={`${id}-head`}
        className={cn(
          "t-acc-head flex w-full items-center justify-between gap-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          headClassName,
        )}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={toggle}
      >
        <span className="min-w-0 flex-1">{header}</span>
        <span className="t-acc-chevron shrink-0 text-muted-foreground" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
            <path
              d="M4 6L8 10L12 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div className="t-acc-panel" id={`${id}-panel`} role="region" aria-labelledby={`${id}-head`}>
        <div className={cn("t-acc-panel-inner", panelClassName)} {...inertProps(!open)}>
          {children}
        </div>
      </div>
    </div>
  );
}
