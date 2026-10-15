/* The Home's balance card (the left third of the Home, owner, 2026-10-15: "อยากได้การวางสัดส่วนแบบนี้" — the prod home's
   proportions): ONE balance, the whole of it (the Main Account and the Spot Account added up, the staked USDC inside
   the Spot Account; wallet/portfolio.js; owner: "Balance ไม่ต้องแยกกันละ รวมกันแม่งไปเลย"), what can be traded with
   now, and the one lime Deposit at the card's top right. What is on its way shows as one line under it and is never
   added in.

   Unknown is "—" and the figure says Partial (with what is missing in a Tip). Drawing only. */
import { useNavigate } from "react-router-dom";
import { ShimmerText } from "../ui/kit/index.ts";
import Button from "../ui/Button.jsx";
import { Spinner } from "../ui/Icon.jsx";
import Tip from "../ui/Tip.jsx";
import { MoneyHero } from "../ui/Money.jsx";
import { TotalState, InFlightLine } from "./TotalBalance.jsx";
import { usdText } from "./portfolio.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/* The figure shares its row with Deposit in a 380px card: a long figure steps down a size instead of running under the
   button ("$10,000.00" and up), so a money figure is never covered. */
const figureSize = (text) => {
  const n = String(text || "").length;
  return n <= 9 ? "text-[2.4rem]" : n <= 11 ? "text-[2rem]" : "text-[1.7rem]";
};

export default function HomeHero({ v, mock = false, pending = null }) {
  const nav = useNavigate();
  const t = v.total;
  const free = v.perp && fin(v.perp.freeUsd) ? `${usdText(v.perp.freeUsd)} available` : null;
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-sm" aria-label="Balance">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex h-5 items-center gap-2 text-sm text-muted-foreground">
            <span>Balance</span>
            {pending ? (
              <span role="status" className="inline-flex items-center gap-1.5 text-xs text-foreground">
                <Spinner size={12} />
                <ShimmerText text={pending === "wallet" ? "Setting up your wallet…" : "Signing you in…"} />
              </span>
            ) : <TotalState total={t} />}
            {mock ? <Tip label="Mock" align="start">Mock account on live prices. No real order is sent.</Tip> : null}
          </div>
          <div className={`mt-2 flex h-[2.4rem] min-w-0 items-end font-semibold leading-none tracking-[-0.035em] ${figureSize(t && t.text)}`}>
            {pending || !t || t.loading
              ? <span className="skeleton-shimmer block h-[1em] w-[4.6em] rounded-lg" aria-hidden="true" />
              : t.usd == null
                ? <span className="num text-muted-foreground">—</span>
                : <MoneyHero text={t.text} className="t-swap-in inline-block whitespace-nowrap" />}
          </div>
          <div className="num mt-2.5 h-5 text-sm text-muted-foreground">{pending ? "" : free || ""}</div>
        </div>
        {pending
          ? <span className="skeleton-shimmer block h-11 w-[104px] shrink-0 rounded-xl" aria-hidden="true" />
          : <Button variant="brand" size="lg" className="shrink-0" onClick={() => nav("/wallet?panel=deposit")}>Deposit</Button>}
      </div>
      {v.inFlight.length ? <InFlightLine rows={v.inFlight} className="mt-4 border-t border-hairline pt-1.5" /> : null}
    </section>
  );
}
