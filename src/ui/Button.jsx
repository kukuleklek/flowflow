import { forwardRef } from "react";

/* ONE lime CTA per view. The short side is a 12% red tint, never a filled red. Every size is ≥44px tall on phones
   (<1024px) and steps down on desktop. */
const VARIANTS = {
  brand: "bg-brand-solid text-brand-solid-foreground shadow-edge hover:bg-brand-hover",
  long: "bg-brand-solid text-brand-solid-foreground shadow-edge hover:bg-brand-hover",
  short: "bg-destructive/[.12] text-destructive hover:bg-destructive/[.18]",
  shortSoft: "bg-destructive/[.12] text-destructive hover:bg-destructive/[.18]",
  primary: "bg-foreground text-background hover:bg-foreground/90",
  ink: "bg-foreground text-background hover:bg-foreground/90",
  outline: "bg-card text-foreground ring-1 ring-inset ring-border hover:bg-muted",
  ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  soft: "bg-muted text-foreground hover:bg-secondary",
  link: "px-1 text-foreground underline-offset-4 hover:underline",
};

const SIZES = {
  sm: "h-11 rounded-lg px-4 text-sm gap-1.5 lg:h-8 lg:rounded-md lg:px-3 lg:text-xs",
  md: "h-11 rounded-lg px-4 text-sm gap-1.5 lg:h-10",
  lg: "h-11 rounded-xl px-5 text-cta gap-2",
  xl: "h-12 rounded-xl px-5 text-cta gap-2 lg:h-11",
};

const Button = forwardRef(function Button(
  { variant = "outline", size = "md", className = "", type = "button", children, ...rest },
  ref,
) {
  const v = VARIANTS[variant] || VARIANTS.outline;
  const s = variant === "link" ? `${SIZES[size] || SIZES.md} !px-1` : SIZES[size] || SIZES.md;
  return (
    <button
      ref={ref}
      type={type}
      className={`ff-press inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 ${v} ${s} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Round icon-only button: 44px on phones, 36px on desktop. `label` is required (aria-label + title). */
export const IconButton = forwardRef(function IconButton(
  { label, className = "", type = "button", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`ff-press grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45 lg:size-9 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

export default Button;
