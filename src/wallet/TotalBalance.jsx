/* The whole balance, drawn: ONE figure (owner: "Balance ไม่ต้องแยกกันละ รวมกันแม่งไปเลย"), the marks the Wallet's
   cards and rows use, and what is on its way. Shared by the Home hero and the Wallet page. The figures come
   from src/wallet/portfolio.js through usePortfolio(); nothing here reads or moves anything.

   🔴 Unknown is "—" and the total then says "Partial" (the Tip names what is missing); a part still loading shimmers.
   In-flight money is listed apart and is never in the total. Money warnings stay printed (a move that may have gone:
   "Not confirmed. Don't send it again."); only explanations fold into Tips (USER-REQUESTS D). */
import { Link } from "react-router-dom";
import { UpdatingDot } from "../ui/kit/index.ts";
import Icon from "../ui/Icon.jsx";
import Tip from "../ui/Tip.jsx";
import { MoneyHero } from "../ui/Money.jsx";
import SponsorLogo from "../ui/SponsorLogo.jsx";

/* A ringed avatar: a white disc with a hairline inner ring drawn over what sits in it. */
export const RING = "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:ring-1 after:ring-inset after:ring-foreground/[.08]";

const CHAIN_LOGO = { Arbitrum: "/chain-logos/42161.png", Avalanche: "/chain-logos/43114.png", Base: "/chain-logos/8453.png", Ethereum: "/chain-logos/1.png", Optimism: "/chain-logos/10.png", Polygon: "/chain-logos/137.png", BNB: "/chain-logos/56.png", "BNB Chain": "/chain-logos/56.png" };
const TOKEN_LOGO = { USDC: "/tokens/usdc.svg", USDT: "/tokens/usdt.svg", AVAX: "/hl-coins/AVAX.svg", WAVAX: "/hl-coins/AVAX.svg", "BTC.b": "/hl-coins/BTC.svg" };

/** A sponsor's mark centred in a white disc, at its own aspect (never stretched or recoloured). Owner, 2026-10-15:
 *  "ไม่ต้องมี โลโก้ Hyperliquid คนห้ามรู้ว่าเราใช้อะไรทำ — เห็นโลโก้แค่ Tokenomist กับ Avax พอ": on these pages that is the
 *  Avalanche mark only. */
export function MarkDisc({ name, size = 28, className = "" }) {
  /* The mark's height inside the disc (the Avalanche mark is near square, 1.13 : 1). */
  const h = Math.round(size * 0.46);
  return (
    <span className={`relative inline-grid shrink-0 place-items-center rounded-full bg-card ${RING} ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <SponsorLogo name={name} size={h} alt="" />
    </span>
  );
}

/** A round image logo (a chain or a token), with an initial when there is no file. */
export function ImgDisc({ src, label = "?", size = 28, className = "" }) {
  return (
    <span className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-card ${RING} ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      {src
        ? <img src={src} alt="" width={size} height={size} className="size-full object-cover" />
        : <span className="font-medium text-muted-foreground" style={{ fontSize: Math.round(size * 0.4) }}>{String(label).slice(0, 1)}</span>}
    </span>
  );
}

/** A token's logo with an optional chain badge in its corner. */
export function TokenDisc({ token, chain = null, src = undefined, size = 32 }) {
  const badge = Math.max(12, Math.round(size * 0.44));
  const file = src !== undefined ? src : TOKEN_LOGO[token] || null;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <ImgDisc src={file} label={token} size={size} />
      {chain && CHAIN_LOGO[chain] ? (
        <img src={CHAIN_LOGO[chain]} alt="" width={badge} height={badge} className="absolute -bottom-0.5 -right-0.5 rounded-full bg-card ring-2 ring-card" style={{ width: badge, height: badge }} />
      ) : null}
    </span>
  );
}

/** "Partial" beside the total's label, with what is missing in a Tip. */
export function TotalState({ total }) {
  if (!total) return null;
  if (total.missing && total.missing.length) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">Partial</span>
        <Tip align="start" title="What the total leaves out">
          Not counted: {total.missing.join(", ")}. It couldn't be read just now; it is not 0.
        </Tip>
      </span>
    );
  }
  return null;
}

/** The total's figure: the dollars, the cents one step quieter. */
export function TotalFigure({ total, className = "" }) {
  return (
    <div className={className}>
      {total && !total.loading && total.usd != null
        ? <MoneyHero text={total.text} />
        : total && !total.loading
          ? <span className="num text-muted-foreground">—</span>
          : <span className="skeleton-shimmer block h-[1em] w-[5.5em] rounded-lg" />}
    </div>
  );
}

const stageTone = (r) => (r.tone === "warn" ? "text-warning" : "text-muted-foreground");

/** What is on its way, apart from the total. */
export function InFlightList({ rows, unread = null, compact = false }) {
  if (!rows.length && !unread) return null;
  return (
    <ul className="space-y-0.5">
      {rows.map((r) => (
        <li key={r.key} className={`flex items-center gap-3 ${compact ? "min-h-11" : "min-h-12"} py-1`}>
          {r.kind === "flow" ? <MarkDisc name="avalanche" size={compact ? 28 : 32} /> : <TokenDisc token={r.token} chain={r.from} size={compact ? 28 : 32} />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{r.title}</span>
            <span className={`block text-xs ${stageTone(r)}`}>
              {r.tone === "warn" ? null : <UpdatingDot active className="mr-1.5 align-middle" />}
              {r.stage}{r.to && r.tone !== "warn" ? ` · to ${r.to}` : ""}
            </span>
          </span>
          {r.amountText ? <span className="num shrink-0 text-sm font-medium">{r.amountText}</span> : null}
        </li>
      ))}
      {unread ? (
        <li className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
          <UpdatingDot active={unread === "loading"} />
          {unread === "loading" ? "Checking deposits…" : "Couldn't check deposits just now"}
        </li>
      ) : null}
    </ul>
  );
}

/** Home: one line for everything on its way ("2 on their way · 29.92 USDC", "· 1 needs a look"), a link to the
 *  Wallet, which prints each one (and every money warning) in full. The USDC figure is money coming in only
 *  (deposits, the hop): a stake or a swap inside the Spot Account is not money arriving. */
export function InFlightLine({ rows, to = "/wallet#on-its-way", className = "" }) {
  if (!rows.length) return null;
  const warn = rows.filter((r) => r.tone === "warn");
  const alarm = warn.length > 0;
  const moving = rows.filter((r) => r.tone !== "warn");
  const usdc = moving.filter((r) => r.kind === "deposit" || r.kind === "hop").reduce((s, r) => {
    const m = r.amountText && /^([\d,.]+) USDC$/.exec(r.amountText);
    return m ? s + Number(m[1].replace(/,/g, "")) : s;
  }, 0);
  /* The warning first, so a narrow screen never cuts it. */
  const parts = [];
  if (warn.length) parts.push(`${warn.length} need${warn.length === 1 ? "s" : ""} a look`);
  if (moving.length) parts.push(`${moving.length} on ${moving.length === 1 ? "its" : "their"} way${usdc > 0 ? ` · ${usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC` : ""}`);
  const words = parts.join(" · ");
  return (
    <div className={className}>
      <Link to={to} className={`ff-press -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-xl px-2 text-xs ${alarm ? "text-warning" : "text-muted-foreground"} hover:bg-foreground/[.03] hover:text-foreground`}>
        {alarm ? <Icon name="alert" size={14} /> : <UpdatingDot active />}
        <span className="min-w-0 flex-1 truncate">{words}</span>
        <Icon name="chevronRight" size={14} />
      </Link>
    </div>
  );
}
