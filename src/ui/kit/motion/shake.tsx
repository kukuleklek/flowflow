"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "./cn";
import { shouldShake } from "./motion-logic";

/**
 * 12 Error state shake around an input that can be invalid (address, amount, name). It shakes when the error shows
 * up outside typing (after blur / paste) or when the field is left while still invalid; never per keystroke. The
 * error text itself stays the caller's (it must persist while the value is wrong).
 */
export function ShakeOnError({
  error,
  children,
  className,
}: {
  error: string | null;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<string | null>(error);
  const pasted = useRef(false);
  const submitted = useRef(false);

  const shake = () => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("is-shaking");
    void el.offsetWidth; // replay from a clean baseline
    el.classList.add("is-shaking");
  };

  useEffect(() => {
    const el = ref.current;
    const focused = !!el && el.contains(document.activeElement);
    if (
      shouldShake({
        prevError: prev.current,
        error,
        focused,
        pasted: pasted.current,
        submitted: submitted.current,
      })
    )
      shake();
    prev.current = error;
    pasted.current = false;
    submitted.current = false;
  }, [error]);

  return (
    <div
      ref={ref}
      className={cn("t-input", className)}
      onPaste={() => {
        pasted.current = true;
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        submitted.current = true;
        // A submit that leaves the same error in place does not re-render this wrapper: check after it settles.
        window.setTimeout(() => {
          if (!submitted.current) return;
          submitted.current = false;
          if (prev.current) shake();
        }, 0);
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to instanceof Node && e.currentTarget.contains(to)) return;
        if (shouldShake({ prevError: error, error, focused: false, blurred: true })) shake();
      }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove("is-shaking");
      }}
    >
      {children}
    </div>
  );
}
