// usePortfolio(): the customer's whole balance, live, for the Home portfolio card and the Wallet page.
// ─────────────────────────────────────────────────────────────────────────────
//
// The figures come from the readers that already exist; this file only asks them, keeps one shared answer per
// account (so two screens never read twice), and hands everything to src/wallet/portfolio.js portfolioView():
//
//   Perp       the account layer, live (BackendContext) → funds.js perpFunds
//   Avalanche  lib/avax/read.js readAvaxAccount (ONE eth_call), every 30 s while a screen shows it
//   Prices     lib/avax/prices.js fetchRelayPrices (cached 60 s there), with the Hyperliquid mids as the fallback
//   Arbitrum   funds.js readFunds → arbitrumWallet (the first deposit's last hop), every 30 s and when the move moves
//   Deposits   the deposit watch, live (depositWatch); the tab's one move runner, live (perpFunding)
//   Avax moves the flow registry, READ ONLY (avax/flows.js readFlows: never loadFlows, which writes)
//   APY        the Aave USDC reserve, from the account read, or on its own when there is no wallet to read
//
// 🔴 READ ONLY. No signer is asked for anything, no move is started, nothing is written to storage. The address read
// on Avalanche is the one ownAvaxAddress() agrees on (the wallet, the Perp backend and Privy's embedded address); a
// localhost view-as reads the viewed address, read only, as the rest of the app does.
//
// DEV ONLY: ?ffPortfolioPreview=full|partial|empty|loading|flight draws sample Avalanche / Arbitrum / in-flight answers
// on top of the real Perp figures, for screenshots of states a mock build cannot reach. The branch is
// `import.meta.env.DEV`, so a production build carries none of it (DepositStatus.jsx does the same).

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useBackend } from "../perp/BackendContext.jsx";
import { useWallet } from "./useWallet.js";
import { usePerpMarkets } from "../lib/hyperliquid/index.js";
import { perpFunds, depositsFrom, readFunds } from "../agent/funds.js";
import { depositWatch } from "../perp/deposit/depositWatch.js";
import { perpFunding, fundingStep } from "../perp/deposit/perpFunding.js";
import { readAvaxAccount, readAaveUsdcMarket } from "../lib/avax/read.js";
import { fetchRelayPrices } from "../lib/avax/prices.js";
import { whitelistAssets } from "../lib/avax/whitelist.js";
import { ownAvaxAddressWhy } from "../lib/avax/own.js";
import { readFlows } from "../avax/flows.js";
import { getPrivySnapshot } from "../services/privy.js";
import { embeddedAddressOf } from "../services/privyUser.js";
import { isEvmAddress } from "../lib/relay/depositAddress.js";
import { portfolioView } from "../wallet/portfolio.js";
import { previewInputs } from "../wallet/portfolioPreview.js";

export const AVAX_REFRESH_MS = 30_000;
export const ARB_REFRESH_MS = 30_000;
export const APY_REFRESH_MS = 5 * 60_000;
/** How long the first answers may take before a part still loading is shown as unknown. */
export const SETTLE_MS = 7_000;

/* ── one shared answer per read ───────────────────────────────────────────── */

const reads = new Map(); // key → { status: "loading"|"ok"|"failed", value, at, inflight }
const subs = new Set();
let version = 0;
const emit = () => { version += 1; for (const f of [...subs]) { try { f(); } catch { /* next */ } } };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const getVersion = () => version;

/** Start `load` for `key` unless an answer younger than `ttl` (or one on its way) exists. A failed refresh keeps the
 *  last good answer (it is still the latest the chain gave), marked by `failedAt`; a first failure is "failed". */
function ensure(key, ttl, load) {
  const r = reads.get(key);
  if (r && (r.inflight || Date.now() - r.at < (r.status === "failed" ? Math.min(ttl, 10_000) : ttl))) return;
  const prev = r || { status: "loading", value: null, at: 0 };
  const inflight = Promise.resolve()
    .then(load)
    .then(
      (value) => ({ status: "ok", value, failedAt: null }),
      () => (prev.status === "ok" ? { status: "ok", value: prev.value, failedAt: Date.now() } : { status: "failed", value: null, failedAt: Date.now() }),
    )
    .then((next) => { reads.set(key, { ...next, at: Date.now(), inflight: null }); emit(); });
  reads.set(key, { ...prev, inflight });
}

/** Forget an answer so the next ensure() reads again (the move runner changed state). */
function invalidate(key) {
  const r = reads.get(key);
  if (r && !r.inflight) reads.set(key, { ...r, at: 0 });
}

const peek = (key) => reads.get(key) || null;

/* ── the move runner, read only (agent.js readMoveDefault's twin) ─────────── */

function readMove(owner) {
  try {
    const st = perpFunding.getState();
    if (!st || !st.user || st.user !== String(owner).toLowerCase()) return null;
    const canAuto = typeof perpFunding.canRun === "function" ? perpFunding.canRun(owner) : true;
    const s = fundingStep(st, owner, { canAuto });
    return s ? { step: s.step, code: s.code, usdc: s.usdc, at: Number.isFinite(st.at) ? st.at : null } : null;
  } catch {
    return null;
  }
}

/* ── the hook ─────────────────────────────────────────────────────────────── */

function previewKind() {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  try { return new URLSearchParams(window.location.search).get("ffPortfolioPreview"); } catch { return null; }
}

function storage() {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

export function usePortfolio() {
  const b = useBackend();
  const w = useWallet();
  const markets = usePerpMarkets();
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const watch = useSyncExternalStore(depositWatch.subscribe, depositWatch.getState, depositWatch.getState);
  const funding = useSyncExternalStore(perpFunding.subscribe, perpFunding.getState, perpFunding.getState);
  const preview = import.meta.env.DEV ? previewKind() : null;

  const signedIn = !!(b.mock || b.connected);
  const mock = !!b.mock;
  const embedded = getPrivySnapshot().address || embeddedAddressOf(w.user);
  const ownWhy = mock || !signedIn ? { own: null, why: null } : ownAvaxAddressWhy({ wallet: w, backend: b, embeddedAddress: embedded });
  /* The address read on Avalanche: the agreed own address, or the viewed one on a localhost view-as (read only). */
  const who = ownWhy.own || (b.viewAs && isEvmAddress(b.address) ? b.address.toLowerCase() : null);
  /* Arbitrum and the deposit watch follow the Perp account's address (funds.js's own rule). */
  const perpWho = !mock && b.connected && isEvmAddress(b.address) ? b.address.toLowerCase() : null;

  /* The first wait, per account: after it, a part still loading reads as unknown ("—", total partial). */
  const [settledFor, setSettledFor] = useState(null);
  const acct = mock ? "mock" : perpWho || "none";
  useEffect(() => {
    const t = setTimeout(() => setSettledFor(acct), SETTLE_MS);
    return () => clearTimeout(t);
  }, [acct]);
  const settled = settledFor === acct;

  /* Avax moves in flight, read only. Re-read when another tab writes, and on the shared tick. */
  const [flowsTick, setFlowsTick] = useState(0);
  useEffect(() => {
    if (!who) return undefined;
    const on = (e) => { if (!e || !e.key || String(e.key).startsWith("flowflow.flows.v1:")) setFlowsTick((n) => n + 1); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, [who]);

  /* The reads, while a screen shows the total. */
  useEffect(() => {
    if (preview) return undefined;
    const tick = () => {
      if (who) {
        ensure(`avax:${who}`, AVAX_REFRESH_MS, () => readAvaxAccount(who));
      }
      /* The rate on its own too (5 min cache): it still shows when the account read fails, or with no account. */
      ensure("aave-apy", APY_REFRESH_MS, () => readAaveUsdcMarket());
      if (perpWho) {
        ensure(`arb:${perpWho}`, ARB_REFRESH_MS, async () => {
          const f = await readFunds({ backend: b, address: perpWho, readMove });
          if (!f || !f.arbitrumWallet || f.arbitrumWallet.usdc == null) throw new Error("unread");
          return f.arbitrumWallet;
        });
      }
      setFlowsTick((n) => n + 1);
    };
    tick();
    const t = setInterval(tick, 10_000);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
    // b is read inside readFunds only for its address and mock flag, both keyed above.
  }, [who, perpWho, mock, preview]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Prices for what is held (and USDC), once the account answered. */
  const avaxRead = who ? peek(`avax:${who}`) : null;
  const heldKey = avaxRead && avaxRead.value
    ? avaxRead.value.assets.filter((a) => typeof a.raw === "bigint" && a.raw > 0n).map((a) => a.symbol).join(",")
    : "";
  useEffect(() => {
    if (preview || !heldKey) return;
    const symbols = [...new Set(["USDC", ...heldKey.split(",").filter(Boolean)])].filter((s) => whitelistAssets().some((a) => a.symbol === s));
    ensure(`prices:${symbols.join(",")}`, 60_000, () => fetchRelayPrices(symbols));
  }, [heldKey, preview, version]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The move runner moved: read Arbitrum again now, not in 30 s. */
  const moveSig = funding ? `${funding.user || ""}:${funding.status || ""}:${funding.seq || 0}` : "";
  useEffect(() => {
    if (!perpWho || preview) return;
    invalidate(`arb:${perpWho}`);
    ensure(`arb:${perpWho}`, ARB_REFRESH_MS, async () => {
      const f = await readFunds({ backend: b, address: perpWho, readMove });
      if (!f || !f.arbitrumWallet || f.arbitrumWallet.usdc == null) throw new Error("unread");
      return f.arbitrumWallet;
    });
  }, [moveSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const perp = signedIn ? perpFunds(b) : null;
  const mids = useMemo(() => {
    const by = markets && markets.byCoin ? markets.byCoin : {};
    const out = {};
    for (const c of ["AVAX", "BTC", "PAXG"]) if (by[c] && Number.isFinite(by[c].px)) out[c] = by[c].px;
    return out;
  }, [markets && markets.byCoin]); // eslint-disable-line react-hooks/exhaustive-deps

  const heldSymbols = heldKey ? [...new Set(["USDC", ...heldKey.split(",")])].filter((s) => whitelistAssets().some((a) => a.symbol === s)) : [];
  const priceRead = heldSymbols.length ? peek(`prices:${heldSymbols.join(",")}`) : null;
  const apyRead = peek("aave-apy");
  const arbRead = perpWho ? peek(`arb:${perpWho}`) : null;

  let avax;
  if (mock) avax = { status: "off", why: "Live only" };
  else if (!who) avax = { status: ownWhy.why === "Your wallet is still loading" || !ownWhy.why ? "loading" : "failed", why: ownWhy.why || null };
  else if (!avaxRead || avaxRead.status === "loading") avax = { status: "loading" };
  else if (avaxRead.status === "failed") avax = { status: "failed", why: "Couldn't read Avalanche" };
  else avax = { status: "ok", account: avaxRead.value };

  let arbitrum;
  if (mock) arbitrum = { status: "off", why: "Live only" };
  else if (!arbRead || arbRead.status === "loading") arbitrum = { status: "loading" };
  else if (arbRead.status === "failed") arbitrum = { status: "failed" };
  else arbitrum = { status: "ok", wallet: arbRead.value };

  const deposits = perpWho ? depositsFrom(watch, perpWho, Date.now()) : null;
  const flowsRead = who ? readFlows(storage(), who) : null;
  const flows = flowsRead && flowsRead.ok ? flowsRead.flows : null;

  let input = {
    signedIn,
    pending: !!w.pending,
    mock,
    perp,
    avax,
    prices: { relay: priceRead && priceRead.status === "ok" ? priceRead.value : {}, mids },
    apyPct: apyRead && apyRead.status === "ok" && apyRead.value ? apyRead.value.apyPct : null,
    arbitrum,
    deposits,
    flows,
    settled,
  };
  if (import.meta.env.DEV && preview) input = previewInputs(preview, input);

  void flowsTick;
  return portfolioView(input);
}

export default usePortfolio;
