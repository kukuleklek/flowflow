// FlowFlow's Tailwind 3.4 theme: the FlowFlow design tokens (src/styles/theme-tokens.css, RGB triplets so the
// `/alpha` modifiers work) mapped to shadcn-style names, Geist type, the kit's radius and motion scale, and the
// revamp's type roles (text-display … text-label). Light only: there is no dark token block and no `dark:` variant.

const ch = (v) => `rgb(var(--${v}-rgb) / <alpha-value>)`;
// The contrast floor: faded text never drops below the token's floor opacity.
const floored = (v, floor) => ({ opacityValue }) =>
  opacityValue === undefined ? `rgb(var(--${v}-rgb))` : `rgb(var(--${v}-rgb) / max(${opacityValue}, var(--${floor}, 0)))`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: ch("background"),
        foreground: ch("foreground"),
        card: ch("card"),
        "card-foreground": ch("foreground"),
        popover: ch("popover"),
        "popover-foreground": ch("foreground"),
        primary: ch("foreground"),
        "primary-foreground": ch("background"),
        secondary: ch("secondary"),
        "secondary-foreground": ch("foreground"),
        muted: ch("muted"),
        "muted-foreground": ch("muted-foreground"),
        accent: ch("accent"),
        "accent-foreground": ch("foreground"),
        border: ch("border"),
        input: ch("input"),
        ring: ch("ring"),
        brand: ch("brand"),
        "brand-foreground": ch("brand-foreground"),
        "brand-solid": ch("brand-solid"),
        "brand-solid-foreground": ch("brand-solid-foreground"),
        "brand-hover": ch("brand-hover"),
        success: ch("success"),
        warning: ch("warning"),
        destructive: ch("destructive"),
        info: ch("info"),
        "status-foreground": ch("status-foreground"),
        "success-container": ch("success-container"),
        "warning-container": ch("warning-container"),
        "destructive-container": ch("destructive-container"),
        "ink-dim": ch("ink-dim"),
        hairline: "var(--hairline)",
      },
      textColor: {
        foreground: floored("foreground", "text-floor"),
        "muted-foreground": floored("muted-foreground", "muted-text-floor"),
      },
      borderColor: { DEFAULT: ch("border") },
      fontFamily: {
        sans: ["var(--font-geist-sans)"],
        mono: ["var(--font-geist-mono)"],
      },
      fontSize: {
        display: ["64px", { lineHeight: "1", letterSpacing: "-0.045em", fontWeight: "400" }],
        "display-sm": ["44px", { lineHeight: "1", letterSpacing: "-0.04em", fontWeight: "400" }],
        price: ["36px", { lineHeight: "1", letterSpacing: "-0.035em", fontWeight: "500" }],
        "price-sm": ["32px", { lineHeight: "1", letterSpacing: "-0.035em", fontWeight: "500" }],
        figure: ["30px", { lineHeight: "1", letterSpacing: "-0.03em", fontWeight: "500" }],
        h1: ["20px", { lineHeight: "1.2", letterSpacing: "-0.02em", fontWeight: "600" }],
        h2: ["15px", { lineHeight: "1.3", letterSpacing: "-0.01em", fontWeight: "600" }],
        body: ["14px", { lineHeight: "1.5" }],
        small: ["12px", { lineHeight: "1.4" }],
        label: ["11px", { lineHeight: "1", letterSpacing: "0.01em", fontWeight: "500" }],
        cta: ["15px", { lineHeight: "1", fontWeight: "500" }],
      },
      fontWeight: { bold: "600", extrabold: "600", black: "600" },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        "3xl": "var(--radius-3xl)",
        "4xl": "var(--radius-4xl)",
      },
      boxShadow: {
        edge: "var(--shadow-edge)",
        float: "var(--shadow-float)",
        halo: "var(--focus-halo)",
      },
      spacing: { gutter: "var(--gutter)" },
      maxWidth: { content: "var(--content-max)" },
      transitionDuration: { DEFAULT: "var(--duration-quick)", pill: "var(--duration-pill)", slow: "var(--duration-slow)" },
      transitionTimingFunction: { DEFAULT: "var(--ease-out)", sheet: "var(--ease-sheet)", smooth: "var(--ease-smooth-out)" },
      scale: { press: "var(--scale-medium)", "press-card": "var(--scale-tiny)" },
    },
  },
  plugins: [],
};
