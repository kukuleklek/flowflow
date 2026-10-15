import { cn } from "./cn";

/**
 * 15 Shimmer text for in-progress status lines ("Scanning…", "Waiting for confirmations…"). Pure CSS: the ::before
 * copy reads `data-text` through attr(), which renders as plain text. Static labels only.
 */
export function ShimmerText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("t-shimmer", className)} data-text={text}>
      {text}
    </span>
  );
}

/** Slim indeterminate progress bar under long scans, paired with a ShimmerText label. */
export function IndeterminateBar({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="t-indeterminate h-full w-1/3 rounded-full bg-brand" />
    </div>
  );
}
