import { useState } from "react";
import { hlLogoUrl } from "../lib/hyperliquid/index.js";
import { stockLogoUrl } from "../lib/hyperliquid/hip3/logos.js";

/* Marks drawn on a transparent field (no disc of their own) sit at 64% inside the white avatar. */
const PAD = new Set(["ETH", "HYPE", "NEAR", "PUMP", "XRP", "NIL"]);
/* A ringed avatar: a white disc with a 1px 8%-ink inner ring drawn over the image, so light marks keep an edge. */
const RING = "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:ring-1 after:ring-inset after:ring-foreground/[.08]";

/** A market's logo from the local set (public/hl-coins), else Hyperliquid's, else its initial. Callers size it with
 *  `size` and never wrap it in their own ring. */
export default function CoinLogo({ coin, size = 28, className = "" }) {
  /* A stock perp ("xyz:TSLA") reads the HIP-3 set first (public/hip3-logos, 26 more than /hl-coins). */
  const url = (typeof coin === "string" && coin.includes(":") ? stockLogoUrl(coin) : null) || hlLogoUrl(coin);
  const [broken, setBroken] = useState(false);
  const label = String(coin || "?").replace(/^[a-z]+:/, "");
  if (!url || broken) {
    return (
      <span
        className={`relative inline-grid shrink-0 place-items-center rounded-full bg-muted font-medium text-muted-foreground ${RING} ${className}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
        aria-hidden="true"
      >
        {label.slice(0, 1)}
      </span>
    );
  }
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-card ${RING} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={PAD.has(label.toUpperCase()) ? "size-[64%] object-contain" : "size-full object-cover"}
      />
    </span>
  );
}
