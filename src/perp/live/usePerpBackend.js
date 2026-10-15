// ─────────────────────────────────────────────────────────────────────────────
// usePerpBackend — the one object every perp screen is handed (perpBackend.js).
// ─────────────────────────────────────────────────────────────────────────────
//
// LIVE (default): the connected wallet is the MASTER of a Hyperliquid account at
// the same address (self-custody: Privy's embedded wallet, or an injected one,
// through WalletContext's shared ethers signer). It approves a short-lived
// trading key once (enableTrading); orders are then signed by that key with no
// popup. The account figures come from the account layer (one socket, one
// store per tab). Nothing here signs or sends anything by itself: every action
// is a call a screen makes after the user slid to confirm.
//
// PRIVY: NO ENABLE STEP. A Privy wallet's trader is handed services/privy's
// no-window signer (privySilentTypedSigner): Enable trading then happens by
// itself on the first trade (exchange/client.js), so trading.enabled is true
// before any key exists (trading.auto) and the ticket shows the slide, not an
// Enable trading button. trading.keyActive says whether the key itself is live.
// An injected wallet keeps the Enable trading step.
//
// VIEW AS (localhost only, account/viewAs.js): with ?perpViewAs=0x... the seam
// shows THAT account and builds no trader. Every action answers view_only,
// support is { ok: false, code: "view_only" } with the banner's words (the
// ticket and the wallet strip show it instead of their actions), and readOnly /
// viewAs say so to any surface that asks.
//
// ON-DEVICE DIAGNOSTICS (diag.js): the steps this seam and the trading layer
// take are recorded into a bounded ring buffer — names, codes, timings, chain
// ids, Hyperliquid's own words, never anything that could sign. With
// ?perpdebug=1 on the URL a sheet shows them with a Copy button, so a failure
// on a phone can be read instead of guessed at.
//
// MOCK (VITE_PERP_BACKEND=mock): the slice-2 engine, in the same shapes, marked
// mock everywhere. It never builds a trader and never asks the wallet anything.
//
// The choice is a BUILD constant, so the hook below is picked once at module
// load and the hook order never changes between renders.
//
// Returned (frozen per render):
//   kind, mock, address, connected, walletType, support { ok, code?, message? }
//   readOnly, viewAs   a localhost view-as is on (viewAs { address, label })
//   account        the account layer's snapshot (or the mock's, same shape)
//   trading        { enabled, keyActive, auto, state, validUntil, reason }
//                  enabled: the user can trade now with no Enable step
//   builder, feeRate
//   enableTrading, openMarket, addMarket, closeFraction, setTpSl, withdraw
//   signRelayAuthorize(step), sendRelayDeposit({ step, amountUsdc })
//                  the Relay withdrawal's two signed steps
//   sendIntentsDeposit({ quote, preflight, amountUsdc })
//                  a Private withdrawal's one signed step (visible)
//   quoteOpen(args), quoteAdd(args)   the ticket's previews (no network)
//   resetMock, onMockEvents            mock only
//
// NO canExportKey AND NO exportKey (owner, 2026-09-23: "อี Export Private Key
// ไม่ต้องมีหรอกก"). They existed only to open Privy's key-export modal and
// nothing else ever read them, so the fields went with the button.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useWallet } from "../../hooks/useWallet.js";
import { privySilentTypedSigner } from "../../services/privy.js";
import { createHlTrader } from "../../lib/hyperliquid/exchange/index.js";
import { masterSupport } from "../../lib/hyperliquid/exchange/master.js";
import { usePerpAccount, usePerpAssetData, usePerpViewAs, perpAccountStore, perpAssetDataStore } from "../../lib/hyperliquid/account/index.js";
import { perpMarketsStore } from "../../lib/hyperliquid/markets.js";
import { usePerpMock, perpMockEngine } from "../mock/usePerpMock.js";
import { perpDiagRecorder, startPerpDiag } from "./diag.js";
import { PERP_BACKEND, PERP_BUILDER, PERP_BUILDER_RESOLVED, PERP_FEE_RATE } from "./config.js";
import {
  createLiveActions, createMockActions, createViewOnlyActions, perpViewOnlyMessage, marketForTrade, quoteOpenLive,
  quoteAddLive, quoteOpenMock, quoteAddMock, liveLimits, mockLimits, mockAccountSnapshot, venueTopUpUsdc, venueTopUpKnown,
} from "./perpBackend.js";
/* The fee of the MARKET being traded, not of the main dex: a HIP-3 venue charges
   a multiple of it, and Max has to be affordable at the rate the fill will
   actually cost (perpLiveView.js perpMarketFeeRate). */
import { perpMarketFeeRate } from "./perpLiveView.js";
import { STOCK_AUTO_MOVE, STOCK_DEXES } from "../guardrails.js";

const NOT_ENABLED = Object.freeze({ enabled: false, auto: false, state: "none", validUntil: null, reason: "no_wallet" });
const MOCK_TRADING = Object.freeze({ enabled: true, keyActive: true, auto: false, state: "active", validUntil: null, reason: null });
const noSubscribe = () => () => {};
const zero = () => 0;

/** The market row the trader prices from, fresh from the store at call time, with its stale flag. */
function tradeMarket(coin) {
  try {
    return marketForTrade(perpMarketsStore().getSnapshot(), coin);
  } catch {
    return null;
  }
}

/* The on-device diagnostics (diag.js): recording is always on inside a Perp
   build and costs a bounded ring buffer; the sheet that shows it opens only
   with ?perpdebug=1, which this starts. Doing it here rather than on a page
   means every perp surface has it and none of them carries it. */
const diag = perpDiagRecorder();

function useLiveBackend() {
  const { address, signer, walletType, chainId, isConnected } = useWallet();
  useEffect(() => { startPerpDiag(); }, []);
  /* A localhost view-as shows another account: nothing may sign while it is on. */
  const view = usePerpViewAs() || null;
  const master = view ? view.address : isConnected && address ? address : null;
  const account = usePerpAccount(master);
  const support = view ? { ok: false, code: "view_only", message: perpViewOnlyMessage(view) } : masterSupport(walletType);
  const trader = useMemo(
    () => (!view && master && signer && support.ok
      ? createHlTrader({
        master, signer, walletType, chainId: chainId ?? null, market: tradeMarket, builder: PERP_BUILDER,
        silentSigner: walletType === "privy" ? privySilentTypedSigner : null,
        /* The rate the venue collateral move sizes itself by is the rate the
           ticket sized its Max by: one figure, one source (perpMarketFeeRate). */
        feeRateOf: (m) => perpMarketFeeRate(m, PERP_FEE_RATE),
        /* Stock pots: money moves in and out by itself (owner, 2026-10-15; guardrails.js). */
        venueMoves: { auto: STOCK_AUTO_MOVE, dexes: STOCK_DEXES },
        diag,
      })
      : null),
    [view, master, signer, walletType, chainId, support.ok],
  );
  /* The trading key's state: re-read whenever the key store changes (this tab
     or another), and on every render, because expiry is a matter of time. */
  useSyncExternalStore(trader ? trader.subscribe : noSubscribe, trader ? trader.version : zero, trader ? trader.version : zero);
  const raw = trader ? trader.isTradingEnabled() : NOT_ENABLED;
  const keyActive = raw.enabled === true;
  const auto = raw.auto === true;
  const trading = { enabled: keyActive || auto, keyActive, auto, state: raw.state, validUntil: raw.validUntil ?? null, reason: raw.reason ?? null };
  const refresh = useCallback((coin) => {
    if (!master) return;
    try { perpAccountStore().refresh(master); } catch { /* the stream catches up anyway */ }
    if (coin) { try { perpAssetDataStore().refresh(master, coin); } catch { /* likewise */ } }
  }, [master]);
  const actions = useMemo(
    () => (view ? createViewOnlyActions(view) : createLiveActions({ trader, refresh, diag })),
    [view, trader, refresh],
  );
  return Object.freeze({
    kind: "live",
    mock: false,
    address: master,
    connected: !!master,
    walletType: walletType || null,
    support: support.ok ? { ok: true } : { ok: false, code: support.code, message: support.message },
    readOnly: !!view,
    viewAs: view,
    /* NO promptWindow FIELD. One lived here, computed from the wallet type and
       documented as the thing that kept a sheet out from under Privy's window
       — and nothing anywhere read it, so it protected nothing while claiming
       to (the repo's own execRouter trap: written every render, read zero
       times). The owner's black screen was then MEASURED and it was not a
       stacking problem at all: it was ToastHost's container inheriting
       the old stylesheet's page-level declarations through the page root and becoming
       a full-viewport opaque panel (ToastHost.jsx, test-perp-diag.mjs S1-S4).
       A sheet that asks for a signature therefore STAYS on screen and says
       what it is waiting for — see PerpWithdrawSheet's confirm screen, which
       holds its figures for the whole of both prompts. If a wallet window ever
       does need a sheet to step aside, it comes back as a field with a reader. */
    account,
    trading,
    builder: PERP_BUILDER_RESOLVED,
    feeRate: PERP_FEE_RATE,
    ...actions,
    quoteOpen: (a) => quoteOpenLive({ ...a, builder: PERP_BUILDER_RESOLVED, feeRate: PERP_FEE_RATE }),
    quoteAdd: (a) => quoteAddLive({ ...a, builder: PERP_BUILDER_RESOLVED, feeRate: PERP_FEE_RATE }),
    resetMock: null,
    onMockEvents: null,
  });
}

function useMockBackend() {
  const m = usePerpMock();
  const engine = perpMockEngine();
  const account = useMemo(() => mockAccountSnapshot(m || {}), [m]);
  const actions = useMemo(() => createMockActions({ engine, marketOf: tradeMarket }), [engine]);
  const feeRate = m && typeof m.feeRate === "number" ? m.feeRate : null;
  /* Stable, so a toast host subscribes once. */
  const onMockEvents = useCallback((fn) => (engine && typeof engine.onEvents === "function" ? engine.onEvents(fn) : () => {}), [engine]);
  return Object.freeze({
    kind: "mock",
    mock: true,
    address: null,
    connected: true,
    walletType: null,
    support: { ok: true },
    readOnly: false,
    viewAs: null,
    account,
    trading: MOCK_TRADING,
    builder: PERP_BUILDER_RESOLVED,
    feeRate,
    ...actions,
    quoteOpen: (a) => quoteOpenMock(engine, a),
    quoteAdd: (a) => quoteAddMock(engine, a),
    resetMock: () => (m && typeof m.reset === "function" ? m.reset() : undefined),
    onMockEvents,
  });
}

/** The backend for this build (LIVE unless VITE_PERP_BACKEND=mock). */
export const usePerpBackend = PERP_BACKEND === "mock" ? useMockBackend : useLiveBackend;

function useLiveLimits(backend, { coin, leverage, market = null }) {
  const snap = usePerpAssetData(backend && backend.connected ? backend.address : null, coin);
  const feeRate = perpMarketFeeRate(market, backend ? backend.feeRate : null);
  /* A venue market is margined from its own pot, and opening a position moves what
     the order needs into it before the order. What the ticket may use is therefore
     that pot plus what the account can send it (perpBackend.js liveLimits). */
  const bal = backend && backend.account ? backend.account.perpBalanceUsdc : null;
  const topUpUsdc = venueTopUpUsdc(bal, coin);
  const topUpKnown = venueTopUpKnown(bal, coin);
  return useMemo(() => liveLimits(snap, { leverage, feeRate, topUpUsdc, topUpKnown }), [snap, leverage, feeRate, topUpUsdc, topUpKnown]);
}

function useMockLimits(backend, { leverage, market }) {
  const m = usePerpMock();
  const feeRate = perpMarketFeeRate(market, backend ? backend.feeRate : null);
  return useMemo(() => mockLimits(m, { leverage, feeRate, market }), [m, leverage, feeRate, market]);
}

/**
 * What a new order may use on one coin: { answered, availableUsdc, maxMarginUsdc }.
 * Live: Hyperliquid's activeAssetData for (master, coin), never the free balance.
 * Mock: the mock's balance and its own max.
 */
export const usePerpTradeLimits = PERP_BACKEND === "mock" ? useMockLimits : useLiveLimits;
