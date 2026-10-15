/** Ring badge for direction: tone "pos"|"up" → green, "neg"|"down" → red, anything else → neutral. */
export const ringBadge = (tone) => `inline-flex h-5 items-center rounded-full px-2 text-xs font-medium tabular-nums ring-1 ring-inset ${
  tone === "pos" || tone === "up" ? "bg-success/[.08] text-success ring-success/[.28]"
  : tone === "neg" || tone === "down" ? "bg-destructive/[.08] text-destructive ring-destructive/[.28]"
  : "bg-muted text-muted-foreground ring-transparent"}`;
/** "40x" next to a ticker. */
export const levBadge = "inline-flex h-[18px] items-center rounded-full bg-muted px-1.5 font-mono text-[11px] leading-none text-muted-foreground";
/** "Perp" in the coin header. */
export const perpPill = "inline-flex h-5 items-center rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground";
/** Side pill "5x Long" / "5x Short" (USER-REQUESTS A1). Long = 32% lime tint + olive ink (5.3:1, the buy tone),
 *  Short = the red ring badge. Every position side in the app uses this, never ringBadge. */
export const sidePill = (side) => `inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-xs font-medium ring-1 ring-inset ${
  side === "long" || side === "buy" ? "bg-brand-solid/[.32] text-brand ring-brand/[.22]" : "bg-destructive/[.08] text-destructive ring-destructive/[.28]"}`;
