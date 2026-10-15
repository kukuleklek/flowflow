/* An asset's round logo for the Agent's boxes: a perp market's CoinLogo, or USDC from the local token set, with an
   optional chain badge in the corner (Avalanche for the Spot Account and USDC Staked AAVE). Local files only. */
import { useEffect, useState } from "react";
import CoinLogo from "../../ui/CoinLogo.jsx";
import SponsorLogo from "../../ui/SponsorLogo.jsx";
import { readAaveUsdcMarket } from "../../lib/avax/read.js";

const RING = "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:ring-1 after:ring-inset after:ring-foreground/[.08]";
const TOKENS = { USDC: "/tokens/usdc.svg", USDT: "/tokens/usdt.svg" };

export default function AssetLogo({ coin, size = 40, chain = null, className = "" }) {
  const token = TOKENS[String(coin || "").toUpperCase()];
  const badge = Math.round(size * 0.42);
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      {token ? (
        <span className={`relative inline-grid size-full place-items-center overflow-hidden rounded-full bg-card ${RING}`}>
          <img src={token} alt="" width={size} height={size} className="size-full object-cover" />
        </span>
      ) : (
        <CoinLogo coin={coin} size={size} />
      )}
      {chain === "avalanche" ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-card ring-2 ring-card"
          style={{ width: badge, height: badge }}
        >
          <SponsorLogo name="avalanche" size={Math.round(badge * 0.62)} alt="" />
        </span>
      ) : null}
    </span>
  );
}

/* ── Aave V3 USDC on Avalanche: the live supply APY (read only, public RPC) ────────────────────────────────────
   One read shared by every box and card on screen, refreshed at most every 5 minutes. Unknown is null, never 0. */
const APY_TTL_MS = 5 * 60 * 1000;
const apy = { value: null, at: 0, inflight: null, failed: false, subs: new Set() };

function loadApy() {
  if (apy.inflight || (apy.at && Date.now() - apy.at < APY_TTL_MS)) return;
  apy.inflight = readAaveUsdcMarket()
    .then((s) => {
      const v = s && typeof s.apyPct === "number" && Number.isFinite(s.apyPct) ? s.apyPct : null;
      apy.value = v;
      apy.failed = v == null;
    })
    .catch(() => { apy.failed = true; })
    .finally(() => {
      apy.at = Date.now();
      apy.inflight = null;
      for (const f of apy.subs) f();
    });
}

/** { apyPct: number|null, loading: boolean } — the Aave V3 USDC supply APY on Avalanche, live. */
export function useAaveApy() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    apy.subs.add(f);
    loadApy();
    const t = setInterval(loadApy, APY_TTL_MS);
    return () => { apy.subs.delete(f); clearInterval(t); };
  }, []);
  return { apyPct: apy.value, loading: !apy.at && !apy.failed };
}

/** "5.70%" or the dash. */
export const apyText = (v, dp = 2) => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(dp)}%` : "—");
