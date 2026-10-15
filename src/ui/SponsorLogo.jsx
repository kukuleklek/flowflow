/* Sponsor and partner marks (owner AD-12: "โลโก้ Sponsor ต้องครบ"), from the official kits only: the files under
   public/sponsors/<key>/ are copied unchanged from the reviewed kit (scratchpad sponsor-logos/manifest.json, clean
   files only). Drawn with <img> at their own aspect ratio: never recoloured, cropped, stretched, masked or combined
   into one mark (each kit forbids it). The app is light only, so every mark is the kit's light-background file.

   🔴 AVALANCHE: wherever its logo shows in a "Powered by" row, AVALANCHE_NOTICE is printed with it (PoweredBy below
   does this). Tokenomist data always carries its attribution (UnlockCard). */

const BASE = "/sponsors";

/* [file, width / height] per variant. Aspects are the files' own viewBox / pixel sizes. */
export const SPONSORS = Object.freeze({
  avalanche: {
    name: "Avalanche",
    mark: ["avalanche/Avalanche_Logomark_Red.clean.svg", 639 / 564],
    markOnDark: ["avalanche/Avalanche_Logomark_White.clean.svg", 639 / 564],
    wordmark: ["avalanche/AvalancheLogo_Horizontal_4C.clean.svg", 1835 / 271],
    poweredBy: ["avalanche/PoweredbyAvalanche_4C.clean.svg", 3022 / 988],
  },
  tokenomist: {
    name: "Tokenomist",
    mark: ["tokenomist/tokenomist-mark-primary.png", 621 / 624],
    markOnDark: ["tokenomist/tokenomist-mark-white.png", 621 / 624],
    wordmark: ["tokenomist/tokenomist-wordmark-primary.clean.svg", 738 / 156],
  },
  aave: {
    name: "Aave",
    mark: ["aave/aave-logomark-dark.clean.svg", 266 / 139],
    markOnDark: ["aave/aave-logomark-light.clean.svg", 266 / 139],
    wordmark: ["aave/aave-logo-full-dark.clean.svg", 833 / 139],
    square: ["aave/aave-avatar-square.clean.svg", 1],
  },
  hyperliquid: {
    name: "Hyperliquid",
    mark: ["hyperliquid/hyperliquid-mark-light.clean.svg", 1],
    wordmark: ["hyperliquid/hyperliquid-type-light.clean.svg", 664 / 200],
  },
  privy: {
    name: "Privy",
    mark: ["privy/Privy_Symbol_Black.clean.svg", 120 / 156],
    wordmark: ["privy/Privy_Brandmark_Black.clean.svg", 346 / 78],
  },
  relay: {
    name: "Relay",
    mark: ["relay/symbol_violet.clean.svg", 147 / 101],
    wordmark: ["relay/lockup_violet.clean.svg", 447 / 101],
    square: ["relay/symbol_violet_bg.clean.svg", 1],
  },
});

/** Ava Labs' required ownership notice (manifest attribution), printed next to the Avalanche logo in a Powered by row. */
export const AVALANCHE_NOTICE = "The AVALANCHE® trademark is owned by Ava Labs, Inc. FlowFlow is not endorsed by, sponsored by, affiliated with or otherwise approved by Ava Labs, Inc.";

/** Where a reader checks Tokenomist's data. */
export const TOKENOMIST_URL = "https://tokenomist.ai";

/** The file and aspect for one sponsor's variant (falls back to the mark). */
export function sponsorAsset(name, variant = "mark") {
  const s = SPONSORS[name];
  if (!s) return null;
  const v = s[variant] || s.mark;
  return { src: `${BASE}/${v[0]}`, aspect: v[1], label: s.name };
}

/**
 * One sponsor mark. `size` is the HEIGHT in px; the width follows the file's own aspect, so nothing is stretched.
 *   name     "avalanche" | "tokenomist" | "aave" | "hyperliquid" | "privy" | "relay"
 *   variant  "mark" | "wordmark" | "markOnDark" (the kit's own white mark, for an ink surface; never a CSS recolour)
 *            (+ "square" for aave / relay, "poweredBy" for avalanche)
 *   alt      the accessible name; decorative (alt="") when the words beside it already say the name
 */
export default function SponsorLogo({ name, variant = "mark", size = 16, alt = null, className = "" }) {
  const a = sponsorAsset(name, variant);
  if (!a) return null;
  const h = Math.max(1, Math.round(size));
  const w = Math.max(1, Math.round(h * a.aspect));
  return (
    <img
      src={a.src}
      alt={alt == null ? a.label : alt}
      width={w}
      height={h}
      draggable="false"
      loading="lazy"
      decoding="async"
      className={`inline-block shrink-0 select-none object-contain ${className}`}
      style={{ width: w, height: h }}
    />
  );
}

const POWERED = ["hyperliquid", "avalanche", "aave", "tokenomist", "privy", "relay"];
/* Each wordmark's height in the row, matched by eye so the six read at one optical size (their letters fill their
   boxes differently; the files themselves are never altered). */
const ROW_H = { hyperliquid: 19, avalanche: 14, aave: 12, tokenomist: 18, privy: 16, relay: 13 };

/** The "Powered by" row (AD-12): every sponsor's wordmark, then Ava Labs' notice (always printed with its logo). */
export function PoweredBy({ className = "", names = POWERED, scale = 1 }) {
  return (
    <div className={className}>
      <div className="text-label text-muted-foreground">Powered by</div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
        {names.map((n) => (
          <li key={n} className="flex h-6 items-center">
            <SponsorLogo name={n} variant="wordmark" size={Math.round((ROW_H[n] || 14) * scale)} />
          </li>
        ))}
      </ul>
      {names.includes("avalanche") ? <p className="mt-3 text-[10px] leading-[1.45] text-muted-foreground">{AVALANCHE_NOTICE}</p> : null}
    </div>
  );
}
