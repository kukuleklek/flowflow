import type { CSSProperties } from "react";
import { cn } from "./cn";

/**
 * 10 Success check for "created", "executed", "verified" moments: fade + rotate + blur + Y-bob, then the tick draws
 * (stroke-dasharray calibrated in css/motion.css for this exact path). Plays when it mounts; decorative.
 */
export function SuccessCheck({ size = 20, className }: { size?: number; className?: string }) {
  // The snippet's 40px bob suits a hero icon; inline icons travel proportionally less.
  const style = { "--check-y-amount": `${Math.round(size * 0.6)}px` } as CSSProperties;
  return (
    <span
      className={cn("t-success-check shrink-0 text-success", className)}
      data-state="in"
      aria-hidden="true"
      style={style}
    >
      <svg viewBox="0 0 48 48" width={size} height={size} fill="none">
        <circle
          cx="24"
          cy="24"
          r="21"
          fill="currentColor"
          fillOpacity="0.14"
          stroke="currentColor"
          strokeOpacity="0.55"
          strokeWidth="3"
        />
        <path
          d="M14 24.5l6.5 6.5L34 17.5"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
