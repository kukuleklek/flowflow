// ─────────────────────────────────────────────────────────────────────────────
// THE AVAX MONEY ACTIONS, for the Spot Account's pills: Move in, Move out, Stake,
// Unstake, Swap. Each is REVIEW → CONFIRM → RUN, over the money layer that already
// exists (moveIn / ownMove / moveOut / swap / aaveTx / gas / flows) and the
// VISIBLE signers of src/avax/signers.js. PURE: no React, no env read at import;
// every read, every signer and the registry are injected (createAvaxMoney deps).
// ─────────────────────────────────────────────────────────────────────────────
//
// Plan v2 §2.9 (guardrails), §3.1–§3.8, §3.11, owner AD-5 / AD-8 / AD-9.
// Owner naming (2026-10-15): "Main Account" = the Hyperliquid Perp account,
// "Spot Account" = the Avax wallet. Windows and rows use those names.
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. NO RECIPIENT ANYWHERE. Every builder is handed `own` (the Privy embedded
//      address the signers report) and nothing else; there is no parameter a
//      caller could put another address in. The executors re-read own (ownNow)
//      before every window.
//   2. CAPS: ≤ 20 USDC per move / stake, ≤ $20 per swap (HARD_CAPS). Env may only
//      LOWER them (resolveCaps). Entries (move in, stake, a swap that is not an exit)
//      also need VITE_EARN=on; exits (move out, unstake, swap X → USDC) never do.
//   3. EVERY FIGURE THE CUSTOMER PAYS IS ON THE REVIEW before Confirm: what leaves,
//      every fee, the gas top-up row ("includes ≈0.03 AVAX for gas (≈$0.30)"), the
//      network fee cap, what arrives / the guaranteed minimum. Unknown is "—" and
//      then the review is NOT confirmable ("Still loading"), never a guessed 0.
//   4. THE CONFIRM GATE IS SYNCHRONOUS. confirm() calls registry.confirm(id) before
//      its first await, so a double tap, a React double effect or two panels can
//      never start two runs: the second gets "already" and is told so — that is not
//      a failure. Executors then CLAIM their stage (one run per stage, ever).
//   5. A WORSE RE-QUOTE IS NEVER SIGNED (AD-9 rule 3, here for every kind): when the
//      price shown has expired at Confirm, the action is priced again; anything that
//      costs more, guarantees less or needs another window ends the run with
//      needsConfirm and the NEW review — nothing was signed.
//   6. NO "TRY AGAIN" AFTER MONEY MAY HAVE LEFT. An unclear outcome is state
//      "unknown" with words that say where to look; the flow watcher
//      (src/avax/watchFlows.js) settles it only with evidence.
//   7. NOTHING HERE SIGNS SILENTLY. Every Avalanche tx goes to signers.sendAvaxTx and
//      every typed signature to signers.signAvaxTypedData — both open Privy's window
//      and re-check the request against `check` before Privy is asked.

import { MIN_MOVE_IN_USDC, moveInConfirmable, quoteMoveIn } from "../lib/relay/moveIn.js";
import { OwnMoveError, executeOwnMove, ownMoveFresh, postRelayQuote } from "../lib/relay/ownMove.js";
import {
  MIN_MOVE_OUT_USDC, MOVE_OUT_QUOTE_TTL_MS, MoveOutError, buildPaidExitQuoteBody, executeMoveOut, parsePaidExitQuote, quoteMoveOut,
} from "../lib/relay/moveOut.js";
import {
  SWAP_LIMITS, buildGasLegQuoteBody, compareRequote, executeSwap, parseGasLegQuote, quoteSwap, swapEnvelope, swapFresh,
  swapLossCheck, swapOutsideConfirmed, swapTxRequests, swapUpfrontWei,
} from "../lib/relay/swap.js";
import { SwapQuoteError, settlerRegistryCalls, swapGasUnits, swapWindowWords, trustedSettlersFrom } from "../lib/avax/swapDecode.js";
import { AaveTxError, aaveTxSummary, buildSupplySteps, buildWithdrawTx, decodeAaveTx } from "../lib/avax/aaveTx.js";
import { supplyProblem, withdrawProblem } from "../lib/avax/aave/v3.js";
import {
  GAS_LIMITS, GasError, GAS_WHY, PRIORITY_FEE_WEI, avaxText, exitReserveWei, feeFields, gasCheck, maxFeeFor, swapBackCount, topupPlan,
} from "../lib/avax/gas.js";
import { displayPrice, independentPrice, fetchRelayPrices } from "../lib/avax/prices.js";
import { readAvaxAccount, readFeeState } from "../lib/avax/read.js";
import { ethCall } from "../lib/avax/rpc.js";
import { formatRaw, rawToNumber, toRaw } from "../lib/avax/units.js";
import { AVAX_CHAIN_ID, WEI_PER_AVAX, snowtraceTx } from "../lib/avax/config.js";
import { swapTokenBySymbol } from "../lib/avax/relayPins.js";
import { claimRun } from "../lib/avax/run.js";
import {
  preflightTx, waitReceipt as waitReceiptDefault, readPendingNonce as readPendingNonceDefault,
  readLatestNonce as readLatestNonceDefault, readTxNonce as readTxNonceDefault, nonceBinding,
} from "../lib/avax/txHelpers.js";
import { ownMoveSignWords } from "../lib/signCopy.js";
import { browserNow, browserTimers } from "../lib/hyperliquid/browser.js";
import { HARD as LIMITS_HARD, resolveLimits } from "./limits.js";

/* ── limits ───────────────────────────────────────────────────────────────── */

/** Hard caps (plan §2.9 HARD.moveUsdc / stakeUsdc / swapUsd) — src/avax/limits.js's, the one table. Env may lower, never raise. */
export const HARD_CAPS = Object.freeze({ moveUsdc: LIMITS_HARD.moveUsdc, stakeUsdc: LIMITS_HARD.stakeUsdc, swapUsd: LIMITS_HARD.swapUsd });
/** Plan §3.5: a move out of the Main Account must leave every cross position at least this far from liquidation. */
export const LIQ_MIN_AFTER_MOVE_PCT = 15;
/** Smallest stake from the Spot Account (Aave takes any; FlowFlow keeps it to a whole dollar). */
export const MIN_STAKE_USDC = 1;
/** A review whose figures came from no quote (Aave) is re-checked at Confirm; it shows for this long. */
export const AAVE_REVIEW_TTL_MS = 60_000;
/** The first window of a run must open within this of Confirm; past it nothing is sent. */
export const RUN_START_DEADLINE_MS = 120_000;
/** A fee cap shown on a review still stands at Confirm while the base fee leaves this much headroom under it (×1.5). */
const FEE_HEADROOM_NUM = 3n;
const FEE_HEADROOM_DEN = 2n;
/** The trusted 0x Settlers are read once per session (swapDecode.settlerRegistryCalls), at most this often. */
export const SETTLERS_TTL_MS = 30 * 60_000;

/**
 * The caps in force under `env` (VITE_MAX_MOVE_USDC / VITE_MAX_STAKE_USDC / VITE_MAX_SWAP_USD,
 * VITE_SWAP_MAX_LOSS_PCT, VITE_SWAP_SLIPPAGE_BPS), through limits.js resolveLimits — the ONE
 * place an env value may lower a limit (unset / unreadable = the hard value, ≤ 0 = off).
 */
export function resolveCaps(env = {}) {
  const l = resolveLimits(env && typeof env === "object" ? env : {});
  return Object.freeze({
    moveUsdc: l.moveUsdc,
    stakeUsdc: l.stakeUsdc,
    swapUsd: l.swapUsd,
    swapMaxLossPct: l.swapMaxLossPct,
    swapSlippageBps: l.swapSlippageBps,
  });
}

/** The Hyperliquid mids an Avax review prices with (AVAX: gas and top-ups; BTC: BTC.b; PAXG: XAUt0). */
export const MID_COINS = Object.freeze(["AVAX", "BTC", "PAXG"]);

/**
 * The INDEPENDENT prices a review may use, from the market store's snapshot (usePerpMarkets /
 * perpMarketsStore().getSnapshot()): { AVAX, BTC, PAXG } — only coins whose row is FRESH.
 * 🔴 The store keeps the last px when its stream stops (a hidden tab, a reconnect, an outage)
 * and only marks the snapshot stale (staleSince; lib/hyperliquid/markets.js
 * isPerpMarketStale's rule, repeated here so this file stays pure). A frozen mid would value
 * the swap loss bound, the $20 swap cap and the gas top-up at an old price, so a stale coin is
 * LEFT OUT: unknown → "No independent price", no Confirm (never a guess).
 */
export function liveMids(snapshot) {
  const out = {};
  if (!snapshot || typeof snapshot !== "object") return out;
  const by = snapshot.byCoin && typeof snapshot.byCoin === "object" ? snapshot.byCoin : {};
  const since = fin(snapshot.staleSince) ? snapshot.staleSince : snapshot.stale === true ? Infinity : null;
  for (const c of MID_COINS) {
    const px = by[c] ? by[c].px : null;
    if (!fin(px) || px <= 0) continue;
    if (since != null) {
      const fresh = snapshot.coinFreshAt ? snapshot.coinFreshAt[c] : undefined;
      if (!(fin(fresh) && fresh > since)) continue;
    }
    out[c] = px;
  }
  return out;
}

/** Are the ways IN open (plan §2.9: VITE_EARN, the same flag the Spot Account pills read)? Exits never ask. */
export const entriesOn = (env = {}) => !!env && String(env.VITE_EARN || "").trim().toLowerCase() === "on";

/* ── words ────────────────────────────────────────────────────────────────── */

const DASH = "—";
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export const MONEY_WHY = Object.freeze({
  loading: GAS_WHY.loading,
  notOn: "Not on yet",
  signIn: "Sign in first",
  walletLoading: "Your wallet is still loading",
  storage: "This browser can't keep track of a money move, so none can start here.",
  amount: "Enter an amount",
  noPrice: "No independent price for this right now",
  perpLoading: "Your Main Account is still loading",
  perpPartial: "Some of your positions couldn't be read, so nothing moves from your Main Account right now",
  perpShort: "More than you can move from your Main Account right now",
  liqUnknown: "A position's liquidation price after the move is unknown",
});

const usdcAmt = (n) => {
  const v = typeof n === "string" ? Number(n) : n;
  if (!fin(v) || v < 0) return DASH;
  return `${v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} USDC`;
};
const usd2 = (n) => (fin(n) && n >= 0 ? `$${n.toFixed(2)}` : DASH);
const rawText = (raw, decimals, symbol) => {
  let b;
  try { b = BigInt(raw); } catch { return DASH; }
  const t = formatRaw(b, decimals, Math.min(decimals, 8));
  return t === DASH ? DASH : `${t} ${symbol}`;
};
const secsText = (s) => (fin(s) && s >= 0 ? (s < 90 ? `≈${Math.max(1, Math.round(s))} s` : `≈${Math.round(s / 60)} min`) : DASH);
/* A move between the Main Account and the Spot Account: Relay's estimate (≈1 s on every live
   quote) is the solver's fill only — the windows, the sendAsset or permit and the watcher's
   poll come on top. Never promise less than "≈1–2 min". */
const moveTimeText = (s) => (fin(s) && s >= 0 ? (s < 120 ? "≈1–2 min" : secsText(s)) : DASH);
const windowsText = (n) => (fin(n) && n > 0 ? `${n} ${n === 1 ? "signature" : "signatures"} in your wallet` : DASH);
/** "up to ≈0.0041 AVAX ($0.04)" — the most the network fee can take (gasLimit × maxFeePerGas). */
function networkFeeText(wei, avaxUsd) {
  if (typeof wei !== "bigint") return DASH;
  const usd = fin(avaxUsd) && avaxUsd > 0 ? (Number(wei) / Number(WEI_PER_AVAX)) * avaxUsd : null;
  return `up to ${avaxText(wei)}${usd != null ? ` (${usd2(usd)})` : ""}`;
}
/** The AD-8 phrase: "includes ≈0.0313 AVAX for gas (≈$0.30)". */
function gasIncludesText(row) {
  if (!row || typeof row.avaxWei !== "bigint") return null;
  return `includes ${avaxText(row.avaxWei)} for gas (≈${usd2(row.usd)})`;
}
/** The printed gas row in the owner's naming (gas.js's row says "Avax Wallet"). */
function gasRowText(row) {
  if (!row || typeof row.avaxWei !== "bigint") return null;
  const where = row.source === "usdc" ? "from your USDC, stays in your Spot Account" : "stays in your Spot Account";
  return `${avaxText(row.avaxWei)} (${usd2(row.usd)}) · ${where}`;
}
const row = (key, label, value, note = null) => Object.freeze({ key, label, value: value == null || value === "" ? DASH : String(value), note });

/** One line for each move-out signature (signers.signAvaxTypedData `words`). */
export function moveOutWindowWords(q, sig) {
  const x = q && q.amountUsdc ? `${q.amountUsdc} USDC` : "this USDC";
  if (sig && sig.kind === "multicall-authorization") return `Allow the move of ${x} to your Main Account`;
  return `Move ${x} to your Main Account`;
}

/** Where to look when nobody can say what happened. Never "try again". */
function whereToLook(kind, { txHash = null } = {}) {
  const hash = typeof txHash === "string" && HASH_RE.test(txHash) ? txHash : null;
  if (kind === "move-in") return Object.freeze({ text: "Check your Main Account and your Spot Account before moving again. Don't send it again.", href: null });
  if (kind === "move-out") return Object.freeze({ text: "Check your Spot Account and your Main Account before moving again. Don't send it again.", href: hash ? snowtraceTx(hash) : null });
  return Object.freeze({ text: "Check this transaction and your Spot Account before trying anything else.", href: hash ? snowtraceTx(hash) : null });
}

const ARRIVING_WORDS = Object.freeze({
  "move-in": "On its way to your Spot Account.",
  "move-out": "On its way to your Main Account.",
});

/* ── the Main Account check (plan §3.5) ──────────────────────────────────── */

/**
 * May `debitUsdc` leave the Main Account? The existing Withdraw's own rule (what
 * Hyperliquid says is withdrawable, perpLiveView.balanceView's `availableUsdc`), plus
 * plan §3.5: every CROSS position keeps ≥ 15 % between its mark and its liquidation
 * price after the debit; isolated ones are not touched by it. The shift is the debit
 * over the position's size (liqPx moves by Δequity / |szi| with the others held).
 * Unknown anything → not ok ("—"), never a yes.
 * @param {{ balance: object|null, positions: object|null, debitUsdc: number }} p
 *   balance: the account layer's perpBalanceUsdc; positions: its { answered, list, complete }
 * @returns {{ ok: boolean, why: string|null, withdrawableUsdc: number|null, liq: object[] }}
 */
export function perpMoveCheck({ balance = null, positions = null, debitUsdc = null } = {}) {
  const d = Number(debitUsdc);
  const out = (ok, why, w = null, liq = []) => Object.freeze({ ok, why, withdrawableUsdc: w, liq: Object.freeze(liq) });
  if (!(d > 0)) return out(false, MONEY_WHY.amount);
  const b = balance && typeof balance === "object" ? balance : null;
  if (!b || b.answered !== true || !fin(b.availableUsdc)) return out(false, MONEY_WHY.perpLoading);
  if (d > b.availableUsdc + 1e-9) return out(false, MONEY_WHY.perpShort, b.availableUsdc);
  const p = positions && typeof positions === "object" ? positions : null;
  if (!p || p.answered !== true || !Array.isArray(p.list)) return out(false, MONEY_WHY.perpLoading, b.availableUsdc);
  /* 🔴 Only a list the account layer calls COMPLETE is checked against: the store answers
     complete: null while any HIP-3 venue is unread (store.js venueRowsOf), and then the list
     holds the main dex only — a venue cross position, backed by the same spot USDC in a unified
     account, would be missed. Not read yet = still loading; read and partial = say so. */
  if (p.complete === false) return out(false, MONEY_WHY.perpPartial, b.availableUsdc);
  if (p.complete !== true) return out(false, MONEY_WHY.perpLoading, b.availableUsdc);
  const liq = [];
  let why = null;
  for (const pos of p.list) {
    if (!pos || !pos.leverage || pos.leverage.type !== "cross") continue;
    const szi = Number(pos.szi);
    if (!fin(szi) || szi === 0) continue;
    const size = Math.abs(szi);
    const mark = fin(pos.positionValue) && pos.positionValue > 0 ? pos.positionValue / size : null;
    const px = fin(pos.liquidationPx) ? pos.liquidationPx : null;
    if (mark == null || px == null) {
      liq.push(Object.freeze({ coin: String(pos.coin || "?"), nowText: px == null ? DASH : String(px), afterText: DASH, pctAfter: null }));
      why = why || MONEY_WHY.liqUnknown;
      continue;
    }
    const after = szi > 0 ? px + d / size : px - d / size;
    const pctAfter = szi > 0 ? ((mark - after) / mark) * 100 : ((after - mark) / mark) * 100;
    liq.push(Object.freeze({ coin: String(pos.coin || "?"), nowText: String(Number(px.toPrecision(6))), afterText: String(Number(after.toPrecision(6))), pctAfter }));
    if (!(pctAfter >= LIQ_MIN_AFTER_MOVE_PCT)) why = why || `This would bring ${pos.coin} within ${LIQ_MIN_AFTER_MOVE_PCT}% of liquidation`;
  }
  return out(!why, why, b.availableUsdc, liq);
}

/* ── amounts ──────────────────────────────────────────────────────────────── */

/** A typed amount → { text, raw } (exact, at most `decimals` places), or null. "all" is the caller's. */
export function readAmount(v, decimals) {
  const s = typeof v === "number" ? (fin(v) && v >= 0 ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const frac = s.includes(".") ? s.split(".")[1] : "";
  if (frac.length > decimals) return null;
  const raw = toRaw(s, decimals);
  if (raw == null || raw <= 0n) return null;
  const text = formatRaw(raw, decimals, decimals);
  return { text, raw };
}

/* ── reviews: what the UI may read, and what only this file may ─────────── */

const INTERNAL = new WeakMap();

/** Freeze the UI's half of a review and keep the rest where only this file can reach it. */
function makeReview(pub, int) {
  const r = Object.freeze({
    kind: pub.kind,
    id: int.flowId || null,
    title: pub.title,
    exit: !!pub.exit,
    route: pub.route || null,
    confirmable: !!int.flowId && !int.why,
    whyNot: int.why || (int.flowId ? null : int.attachWhy || null),
    amount: pub.amount || null,
    symbol: pub.symbol || null,
    amountText: pub.amountText || DASH,
    receiveText: pub.receiveText || DASH,
    minimumText: pub.minimumText || null,
    feeText: pub.feeText || DASH,
    gasText: pub.gasText || null,
    gasRowText: pub.gasRowText || null,
    networkFeeText: pub.networkFeeText || null,
    timeText: pub.timeText || DASH,
    windows: fin(pub.windows) ? pub.windows : null,
    windowsText: windowsText(pub.windows),
    quotedAt: fin(pub.quotedAt) ? pub.quotedAt : null,
    expiresAt: fin(pub.expiresAt) ? pub.expiresAt : null,
    liq: Object.freeze(pub.liq || []),
    warnings: Object.freeze((pub.warnings || []).filter(Boolean)),
    rows: Object.freeze((pub.rows || []).filter(Boolean)),
    stages: Object.freeze((pub.stages || []).map((s) => Object.freeze({ key: s.key, label: s.label, state: "todo" }))),
  });
  INTERNAL.set(r, int);
  return r;
}

/** Is this a review this file made (and still knows)? */
export const isAvaxReview = (r) => !!r && INTERNAL.has(r);

/* ── the controller ──────────────────────────────────────────────────────── */

let settlersMemo = null; // { at, list } — once per session (page)

/**
 * @param {object} deps
 * @param {string} deps.own                         the user's own address (lowercase), from the signers
 * @param {object} deps.registry                    createFlowRegistry({ storage, own }) — ONE per account per page
 * @param {() => object|null} deps.signers          getAvaxSigners (re-read at every window)
 * @param {object} [deps.env]                       Vite env (VITE_EARN, VITE_MAX_*)
 * @param {() => object|null} [deps.getPerp]        { balance: perpBalanceUsdc, positions } from the backend
 * @param {() => object|null} [deps.getMids]        Hyperliquid mids { AVAX, BTC, PAXG }
 * @param {Function} [deps.readAccount]             (own) => readAvaxAccount
 * @param {Function} [deps.readFee]                 () => readFeeState
 * @param {Function} [deps.readPrices]              (symbols) => { SYMBOL: usd|null } (Relay display prices)
 * @param {Function} [deps.readSettlers]            () => trusted Settler addresses
 * @param {Function} [deps.preflight]               (tx, own) => preflightTx
 * @param {Function} [deps.waitReceipt]             (hash) => { status } | null
 * @param {Function} [deps.readPendingNonce]        (own) => bigint | null
 * @param {Function} [deps.readLatestNonce]         (own) => bigint | null (mined)
 * @param {Function} [deps.readTxNonce]             (hash) => bigint | null — with readLatestNonce, binds a hash to its window
 * @param {Function} [deps.fetchImpl]               fetch for Relay quotes / permit POSTs (the key proxy in a page)
 * @param {Function} [deps.onFlow]                  (id) => void — a flow changed (the watcher pokes it)
 */
export function createAvaxMoney(deps = {}) {
  const {
    registry, env = {}, getPerp = () => null, getMids = () => null,
    fetchImpl = globalThis.fetch, timers = browserTimers, now = browserNow, onFlow = () => {},
  } = deps;
  const own = lower(deps.own);
  if (!/^0x[0-9a-f]{40}$/.test(own) || !registry || lower(registry.own) !== own) throw new Error("createAvaxMoney needs the user's own address and its registry");
  const signersNow = () => { try { return typeof deps.signers === "function" ? deps.signers() : null; } catch { return null; } };
  const ownNow = () => { const s = signersNow(); return s && typeof s.own === "string" ? lower(s.own) : null; };
  const readAccount = deps.readAccount || ((o) => readAvaxAccount(o, { fetchImpl, timers, now }));
  const readFee = deps.readFee || (() => readFeeState({ fetchImpl, timers, now }));
  const readPrices = deps.readPrices || ((symbols) => fetchRelayPrices(symbols, { fetchImpl, timers, now }));
  const preflight = deps.preflight || ((tx, o) => preflightTx(tx, o, { fetchImpl, timers }));
  const waitReceipt = deps.waitReceipt || ((hash) => waitReceiptDefault(hash, { fetchImpl, timers, now }));
  const readNonce = deps.readPendingNonce || ((o) => readPendingNonceDefault(o, { fetchImpl, timers }));
  const readLatest = deps.readLatestNonce || ((o) => readLatestNonceDefault(o, { fetchImpl, timers }));
  const readHashNonce = deps.readTxNonce || ((h) => readTxNonceDefault(h, { fetchImpl, timers }));
  const readSettlers = deps.readSettlers || (async () => {
    const res = await Promise.all(settlerRegistryCalls().map((c) => ethCall(c, { fetchImpl, timers }).catch(() => null)));
    return trustedSettlersFrom(res);
  });
  const caps = resolveCaps(env);
  const on = entriesOn(env);
  /* Plan §3.8.6: every card prints where the money lands — the user's OWN address, from the
     signers (never a quote), shortened: "0x7a3f…c1e9 ✓ your wallet". Display only, no input. */
  const ownTag = `${own.slice(0, 6)}…${own.slice(-4)} ✓ your wallet`;
  const toRow = (note = null) => row("to", "Goes to", ownTag, note);

  /* Reads that may fail: a failure is null (unknown), never an empty wallet. */
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };
  const mids = () => { const m = safe2(getMids); return m && typeof m === "object" ? m : {}; };
  function safe2(fn) { try { return fn(); } catch { return null; } }
  const avaxUsdOf = (m) => (fin(Number(m.AVAX)) && Number(m.AVAX) > 0 ? Number(m.AVAX) : null);
  async function settlers() {
    if (settlersMemo && now() - settlersMemo.at < SETTLERS_TTL_MS) return settlersMemo.list;
    const list = await safe(readSettlers);
    if (Array.isArray(list) && list.length) settlersMemo = { at: now(), list };
    return Array.isArray(list) && list.length ? list : undefined;
  }
  async function pricesFor(account, extra = []) {
    const held = account && Array.isArray(account.assets) ? account.assets.filter((a) => typeof a.raw === "bigint" && a.raw > 0n).map((a) => a.symbol) : [];
    const symbols = [...new Set(["USDC", ...held, ...extra])];
    const relay = (await safe(() => readPrices(symbols))) || {};
    const m = mids();
    const display = {};
    for (const s of symbols) display[s] = displayPrice(s, { relay, mids: m }).usd;
    return { relay, mids: m, display };
  }
  const reserveAfter = (account, display, planned = []) => {
    const n = swapBackCount(account, { prices: display, planned });
    return n == null ? null : exitReserveWei(n);
  };

  /* Attach a priced review to the registry: reuse the previous card's record when it
     still binds the same move, else begin a new one (and close the old). Only a review
     with no reason against it gets a record — the record is what makes Confirm live. */
  function attach(pub, int, prev) {
    const prevInt = prev ? INTERNAL.get(prev) : null;
    const closeOld = (keep) => {
      for (const id of [prevInt && prevInt.flowId, prevInt && prevInt.legFlowId]) {
        if (id && !keep.includes(id)) { try { const r = registry.get(id); if (r && r.state === "review") registry.cancel(id, "requoted"); } catch { /* another tab's, or settled */ } }
      }
    };
    if (int.why) { closeOld([]); return makeReview(pub, int); }
    if (!registry.available()) { int.why = MONEY_WHY.storage; closeOld([]); return makeReview(pub, int); }
    const cs = registry.canStart({ exit: !!pub.exit });
    if (!cs.ok) { int.why = cs.message; closeOld([]); return makeReview(pub, int); }
    const reuse = (id, still) => {
      if (!id) return null;
      const rec = registry.get(id);
      return rec && rec.kind === (int.begin && int.begin.kind) && registry.view(rec).confirmable && still(rec) ? id : null;
    };
    try {
      int.flowId = (prevInt && prevInt.kind === int.kind && reuse(prevInt.flowId, int.keeps)) || registry.begin(int.begin).id;
      if (int.legBegin) {
        int.legFlowId = (prevInt && reuse(prevInt.legFlowId, int.legKeeps)) || registry.begin(int.legBegin).id;
      }
    } catch {
      int.flowId = null;
      int.legFlowId = null;
      int.why = MONEY_WHY.storage;
    }
    closeOld([int.flowId, int.legFlowId].filter(Boolean));
    return makeReview(pub, int);
  }

  /* ── MOVE IN: Main Account → Spot Account ────────────────────────────── */

  async function priceMoveIn(args = {}) {
    const a = readAmount(args.amountUsdc, 6);
    const pub = { kind: "move-in", title: "Move to your Spot Account", amount: a ? a.text : null, symbol: "USDC", amountText: a ? usdcAmt(a.text) : DASH, windows: 2,
      stages: [{ key: "authorize", label: "Approve the move" }, { key: "send", label: "Leave your Main Account" }, { key: "arrive", label: "Arrive in your Spot Account" }] };
    const int = { kind: "move-in", args: { amountUsdc: a ? a.text : null }, why: null };
    if (!on) return { pub, int: { ...int, why: MONEY_WHY.notOn } };
    if (!a) return { pub, int: { ...int, why: MONEY_WHY.amount } };
    const x = Number(a.text);
    if (caps.moveUsdc <= 0) return { pub, int: { ...int, why: "Moves are off in FlowFlow for now." } };
    if (x < MIN_MOVE_IN_USDC) return { pub, int: { ...int, why: `A move needs at least ${MIN_MOVE_IN_USDC} USDC.` } };
    if (x > caps.moveUsdc) return { pub, int: { ...int, why: `Max ${caps.moveUsdc} USDC per move in FlowFlow for now.` } };

    const account = await safe(() => readAccount(own));
    const px = await pricesFor(account);
    const avaxUsd = avaxUsdOf(px.mids);
    /* AD-8: a top-up only when the Spot Account's AVAX is under the exit reserve. */
    const need = account ? reserveAfter(account, px.display) : null;
    const plan = topupPlan({ avaxWei: account ? account.avaxWei : null, needWei: need, avaxUsd });
    if (plan.needed && !plan.ok) return { pub, int: { ...int, why: plan.why } };
    const topupUsd = plan.needed ? plan.usd : null;

    let r;
    try {
      r = await quoteMoveIn({ own, amountUsdc: a.text, topupUsd, maxMoveUsdc: caps.moveUsdc, avaxUsd, fetchImpl, timers, now });
    } catch (e) {
      /* The per-move cap bounds what LEAVES the Main Account (ATK-13a), and the fee and any gas
         come on top of what arrives: a move near the cap is a LIMIT, said as one — with the most
         that fits this price — not a refused quote. */
      const d = e instanceof OwnMoveError && e.detail && e.detail.overCeiling ? e.detail : null;
      if (d && fin(d.amountIn) && fin(d.ceiling) && d.ceiling >= caps.moveUsdc - 1e-9) {
        const room = Math.floor((caps.moveUsdc - (d.amountIn - x)) * 100) / 100;
        return { pub, int: { ...int, why: room >= MIN_MOVE_IN_USDC
          ? `Max ≈${room} USDC this time: the fee${topupUsd ? " and gas" : ""} come on top, and at most ${caps.moveUsdc} USDC leaves your Main Account per move.`
          : `Max ${caps.moveUsdc} USDC leaves your Main Account per move, fee${topupUsd ? " and gas" : ""} included.` } };
      }
      return { pub, int: { ...int, why: e instanceof OwnMoveError ? e.message : "Couldn't price this move right now. Nothing moved." } };
    }
    const q = r.review;
    const conf = moveInConfirmable({ body: r.body, review: q });
    const perp = safe2(getPerp) || {};
    const pc = perpMoveCheck({ balance: perp.balance, positions: perp.positions, debitUsdc: q.maxDebitUsdc });
    const usdcBefore = account && account.balances ? account.balances.USDC : null;
    Object.assign(pub, {
      receiveText: usdcAmt(q.amountOut),
      feeText: usdcAmt(q.feeUsdc),
      gasText: gasIncludesText(q.gasRow),
      gasRowText: gasRowText(q.gasRow),
      timeText: moveTimeText(q.timeEstimateSec),
      quotedAt: q.quotedAt,
      expiresAt: q.quotedAt + 60_000,
      liq: pc.liq,
      rows: [
        row("amount", "You move", usdcAmt(q.amountOut)),
        row("debit", "Leaves your Main Account", usdcAmt(q.amountIn), `at most ${usdcAmt(q.maxDebitUsdc)}`),
        row("fee", "Fee", usdcAmt(q.feeUsdc)),
        q.gasRow ? row("gas", "Gas for later", gasRowText(q.gasRow)) : null,
        row("receive", "Arrives in your Spot Account", usdcAmt(q.amountOut), "exactly"),
        toRow("your Spot Account"),
        row("time", "Time", moveTimeText(q.timeEstimateSec)),
        ...pc.liq.map((l) => row(`liq-${l.coin}`, `Liq after move · ${l.coin}`, `${l.nowText} → ${l.afterText}`)),
        row("windows", "Signatures", windowsText(2)),
      ],
    });
    const why = !conf.ok ? `The gas row doesn't match the move (${conf.why})` : !pc.ok ? pc.why : null;
    return {
      pub,
      int: {
        ...int, why, q, body: r.body, topupUsd,
        /* usdc: the amount the Wallet page's "On its way" row prints (portfolio.js flowAmount).
           topupRaw / avaxBeforeRaw: the gas the card printed and the AVAX held when it was made —
           the watcher checks the top-up really arrived (it is not part of the order). */
        begin: { kind: "move-in", maxDebit: q.maxDebitUsdc, amounts: {
          out: a.text, usdc: a.text, topupUsd, beforeRaw: typeof usdcBefore === "bigint" ? usdcBefore.toString() : null,
          topupRaw: q.topup ? q.topup.raw : null, avaxBeforeRaw: q.topup && account && typeof account.avaxWei === "bigint" ? account.avaxWei.toString() : null,
        } },
        keeps: (rec) => rec.maxDebit === q.maxDebitUsdc && rec.amounts && rec.amounts.out === a.text && (rec.amounts.topupUsd ?? null) === topupUsd
          && (rec.amounts.topupRaw ?? null) === (q.topup ? q.topup.raw : null),
      },
    };
  }

  /* ── MOVE OUT: Spot Account → Main Account (THE EXIT: never behind a flag) ── */

  async function priceMoveOut(args = {}) {
    const a = readAmount(args.amountUsdc, 6);
    const pub = { kind: "move-out", title: "Move to your Main Account", exit: true, amount: a ? a.text : null, symbol: "USDC", amountText: a ? usdcAmt(a.text) : DASH };
    const int = { kind: "move-out", args: { amountUsdc: a ? a.text : null }, why: null };
    if (!a) return { pub, int: { ...int, why: MONEY_WHY.amount } };
    const x = Number(a.text);
    if (caps.moveUsdc <= 0) return { pub, int: { ...int, why: "Moves are off in FlowFlow for now." } };
    if (x < MIN_MOVE_OUT_USDC) return { pub, int: { ...int, why: `A move needs at least ${MIN_MOVE_OUT_USDC} USDC.` } };
    if (x > caps.moveUsdc) return { pub, int: { ...int, why: `Max ${caps.moveUsdc} USDC per move in FlowFlow for now.` } };
    const account = await safe(() => readAccount(own));
    const usdc = account && account.balances ? account.balances.USDC : null;
    if (typeof usdc !== "bigint") return { pub, int: { ...int, why: MONEY_WHY.loading } };
    if (usdc < a.raw) return { pub, int: { ...int, why: "Not enough USDC in your Spot Account" } };
    const begin = { kind: "move-out", maxDebit: x, amounts: { in: a.text, usdc: a.text, beforeRaw: usdc.toString() } };
    const keeps = (rec) => !!rec.amounts && rec.amounts.in === a.text;

    /* 1. The permit route: the user signs, the solver pays the gas. 0 AVAX. */
    let permitWhy = null;
    try {
      const { review: q } = await quoteMoveOut({ own, amountUsdc: a.text, fetchImpl, timers, now });
      Object.assign(pub, {
        route: "permit",
        receiveText: usdcAmt(q.receiveUsdc),
        minimumText: usdcAmt(q.minimumUsdc),
        feeText: q.feeUsdc == null ? DASH : usdcAmt(q.feeUsdc),
        networkFeeText: "None (paid by the route)",
        timeText: moveTimeText(q.timeEstimateSec),
        windows: q.signatureCount,
        quotedAt: q.quotedAt,
        expiresAt: q.quotedAt + MOVE_OUT_QUOTE_TTL_MS,
        stages: [...q.signatures.map((s, i) => ({ key: `sign${i}`, label: s.kind === "eip3009" ? "Sign the move" : "Allow the move's calls" })),
          { key: "send", label: "Leave your Spot Account" }, { key: "arrive", label: "Arrive in your Main Account" }],
        rows: [
          row("amount", "You move", usdcAmt(q.amountUsdc)),
          row("fee", "Fee", q.feeUsdc == null ? DASH : usdcAmt(q.feeUsdc)),
          row("network", "Network fee", "None, no AVAX needed"),
          row("receive", "Arrives in your Main Account", usdcAmt(q.receiveUsdc), `at least ${usdcAmt(q.minimumUsdc)}`),
          toRow("your Main Account, the same address"),
          row("time", "Time", moveTimeText(q.timeEstimateSec)),
          row("windows", "Signatures", windowsText(q.signatureCount)),
        ],
      });
      return { pub, int: { ...int, route: "permit", q, begin, keeps } };
    } catch (e) {
      permitWhy = e && e.message ? e.message : "The free route isn't available right now";
    }

    /* 2. The paid exit — only when the Spot Account's AVAX pays for it. */
    let q;
    try {
      const json = await postRelayQuote(buildPaidExitQuoteBody({ own, amountUsdc: a.text }), { fetchImpl, timers });
      q = parsePaidExitQuote(json, { own, amountRaw: a.raw.toString(), now: now() });
    } catch (e) {
      const msg = e instanceof MoveOutError || e instanceof OwnMoveError ? e.message : "Couldn't price this move right now. Nothing moved.";
      return { pub, int: { ...int, why: msg, permitWhy } };
    }
    const fee = await safe(readFee);
    let fees = null;
    try { fees = feeFields(fee, { exit: true }); } catch (e) { return { pub, int: { ...int, why: e instanceof GasError ? e.message : MONEY_WHY.loading } }; }
    const limits = q.txs.map((t) => (t.purpose === "approve" ? GAS_LIMITS.exitApprove : GAS_LIMITS.exitDeposit));
    if (q.txs.some((t, i) => t.gas != null && BigInt(t.gas) > limits[i])) return { pub, int: { ...int, why: "This exit needs more gas than FlowFlow allows. Nothing moved." } };
    const gc = gasCheck({ avaxWei: account.avaxWei, gasLimits: limits, maxFeePerGas: fees.maxFeePerGas, kind: "exit" });
    const avaxUsd = avaxUsdOf(mids());
    Object.assign(pub, {
      route: "paid",
      receiveText: usdcAmt(q.receiveUsdc),
      minimumText: usdcAmt(q.minimumUsdc),
      feeText: q.feeUsdc == null ? DASH : usdcAmt(q.feeUsdc),
      networkFeeText: networkFeeText(gc.upfrontWei, avaxUsd),
      timeText: moveTimeText(q.timeEstimateSec),
      windows: q.txs.length,
      quotedAt: q.quotedAt,
      expiresAt: q.quotedAt + MOVE_OUT_QUOTE_TTL_MS,
      warnings: ["The free route isn't available for this move right now, so it is sent from your Spot Account and its network fee is paid in AVAX."],
      stages: [...q.txs.map((t) => ({ key: t.purpose, label: t.purpose === "approve" ? `Allow exactly ${q.amountUsdc} USDC` : "Leave your Spot Account" })),
        { key: "arrive", label: "Arrive in your Main Account" }],
      rows: [
        row("amount", "You move", usdcAmt(q.amountUsdc)),
        row("fee", "Fee", q.feeUsdc == null ? DASH : usdcAmt(q.feeUsdc)),
        row("network", "Network fee", networkFeeText(gc.upfrontWei, avaxUsd), "paid in AVAX from your Spot Account"),
        row("receive", "Arrives in your Main Account", usdcAmt(q.receiveUsdc), `at least ${usdcAmt(q.minimumUsdc)}`),
        toRow("your Main Account, the same address"),
        row("time", "Time", moveTimeText(q.timeEstimateSec)),
        row("windows", "Signatures", windowsText(q.txs.length)),
      ],
    });
    return { pub, int: { ...int, route: "paid", q, fees, limits, permitWhy, why: gc.ok ? null : gc.why, begin, keeps } };
  }

  /* ── STAKE: Spot Account USDC → Aave V3 ─────────────────────────────── */

  async function priceStake(args = {}) {
    const a = readAmount(args.amountUsdc, 6);
    const pub = { kind: "stake", title: "Stake USDC in Aave", amount: a ? a.text : null, symbol: "USDC", amountText: a ? usdcAmt(a.text) : DASH };
    const int = { kind: "stake", args: { amountUsdc: a ? a.text : null }, why: null };
    if (!on) return { pub, int: { ...int, why: MONEY_WHY.notOn } };
    if (!a) return { pub, int: { ...int, why: MONEY_WHY.amount } };
    const x = Number(a.text);
    if (caps.stakeUsdc <= 0) return { pub, int: { ...int, why: "Staking is off in FlowFlow for now." } };
    if (x < MIN_STAKE_USDC) return { pub, int: { ...int, why: `Stake at least ${MIN_STAKE_USDC} USDC.` } };
    if (x > caps.stakeUsdc) return { pub, int: { ...int, why: `Max ${caps.stakeUsdc} USDC per stake in FlowFlow for now.` } };
    return priceAave({ pub, int, a, all: false, stake: true });
  }

  /* ── UNSTAKE: Aave V3 → Spot Account (an exit: any fee level, no cap) ── */

  async function priceUnstake(args = {}) {
    const all = args.amountUsdc === "all";
    const a = all ? null : readAmount(args.amountUsdc, 6);
    const pub = { kind: "unstake", title: "Unstake USDC from Aave", exit: true, amount: all ? "all" : a ? a.text : null, symbol: "USDC", amountText: all ? "All your USDC in Aave" : a ? usdcAmt(a.text) : DASH };
    const int = { kind: "unstake", args: { amountUsdc: all ? "all" : a ? a.text : null }, why: null };
    if (!all && !a) return { pub, int: { ...int, why: MONEY_WHY.amount } };
    return priceAave({ pub, int, a, all, stake: false });
  }

  async function priceAave({ pub, int, a, all, stake }) {
    const account = await safe(() => readAccount(own));
    if (!account) return { pub, int: { ...int, why: MONEY_WHY.loading } };
    const status = account.aave ? account.aave.status : null;
    const p = stake
      ? supplyProblem({ status, amountRaw: a.raw, walletUsdcRaw: account.balances ? account.balances.USDC : null })
      : withdrawProblem({ status, amountRaw: all ? "max" : a.raw, suppliedRaw: account.aave ? account.aave.suppliedRaw : null });
    if (p) return { pub, int: { ...int, why: p.text } };
    const fee = await safe(readFee);
    let fees;
    try { fees = feeFields(fee, { exit: !stake }); } catch (e) { return { pub, int: { ...int, why: e instanceof GasError ? e.message : MONEY_WHY.loading } }; }
    let steps;
    try {
      steps = stake
        ? buildSupplySteps({ own, amountRaw: a.raw, allowanceRaw: account.aave.poolAllowanceRaw, fees })
        : [{ kind: "withdraw", tx: buildWithdrawTx({ own, amountRaw: all ? "max" : a.raw, fees }) }];
    } catch (e) {
      return { pub, int: { ...int, why: e instanceof AaveTxError ? e.message : MONEY_WHY.loading } };
    }
    const px = await pricesFor(account);
    const gasLimits = steps.map((s) => BigInt(s.tx.gasLimit));
    const gc = gasCheck({
      avaxWei: account.avaxWei, gasLimits, maxFeePerGas: fees.maxFeePerGas, kind: stake ? "normal" : "exit",
      reserveAfterWei: stake ? reserveAfter(account, px.display) : undefined,
    });
    const supplied = account.aave ? account.aave.suppliedRaw : null;
    const amtText = all ? (typeof supplied === "bigint" ? `${rawText(supplied, 6, "USDC")} (all, with interest to the second)` : "All your USDC in Aave") : usdcAmt(a.text);
    const apy = status && fin(status.apyPct) ? `${status.apyPct.toFixed(2)}%` : DASH;
    const avaxUsd = avaxUsdOf(px.mids);
    Object.assign(pub, {
      amountText: amtText,
      receiveText: stake ? `${usdcAmt(a.text)} in Aave` : `${amtText} in your Spot Account`,
      feeText: "No fee",
      networkFeeText: networkFeeText(gc.upfrontWei, avaxUsd),
      timeText: "≈ 2 s per signature",
      windows: steps.length,
      quotedAt: now(),
      expiresAt: now() + AAVE_REVIEW_TTL_MS,
      stages: steps.map((s) => ({ key: s.kind, label: aaveTxSummary(decodeAaveTx(s.tx, own)) })),
      rows: [
        row("amount", stake ? "You stake" : "You unstake", amtText),
        stake ? row("apy", "APY now", apy, "Aave V3 on Avalanche, it changes") : null,
        row("fee", "Fee", "No fee"),
        row("network", "Network fee", networkFeeText(gc.upfrontWei, avaxUsd), "paid in AVAX from your Spot Account"),
        row("receive", stake ? "Goes into" : "Arrives in", stake ? "Aave on Avalanche" : "Your Spot Account"),
        toRow(stake ? "Aave holds it for this wallet" : "your Spot Account"),
        row("windows", "Signatures", windowsText(steps.length)),
      ],
    });
    let why = gc.ok ? null : gc.why;
    /* A first look before Confirm: the first tx simulated from own. (The run checks every tx again.) */
    if (!why) {
      const pf = await safe(() => preflight({ ...steps[0].tx }, own));
      if (!pf || pf.ok !== true) why = (pf && pf.text) || "Couldn't check this with Avalanche";
    }
    const approve = steps.some((s) => s.kind === "approve");
    const begin = stake
      ? { kind: "stake", maxDebit: Number(a.text), amounts: { in: a.text, usdc: a.text, approve, beforeRaw: typeof supplied === "bigint" ? supplied.toString() : null } }
      : { kind: "unstake", amounts: { in: all ? "all" : a.text, ...(all ? {} : { usdc: a.text }), beforeRaw: account.balances && typeof account.balances.USDC === "bigint" ? account.balances.USDC.toString() : null } };
    const keeps = (rec) => !!rec.amounts && rec.amounts.in === begin.amounts.in && (!stake || rec.amounts.approve === approve);
    return { pub, int: { ...int, why, steps, fees, all, begin, keeps } };
  }

  /* ── SWAP: same chain, whitelist only, the 0x route only ─────────────── */

  async function priceSwap(args = {}) {
    const from = swapTokenBySymbol(args.from);
    const to = swapTokenBySymbol(args.to);
    const exit = !!from && !!to && to.symbol === "USDC" && from.symbol !== "USDC";
    const a = from ? readAmount(args.amount, from.decimals) : null;
    const pub = { kind: "swap", exit, title: from && to ? `Swap ${from.symbol} to ${to.symbol}` : "Swap", amount: a ? a.text : null, symbol: from ? from.symbol : null, amountText: a && from ? `${a.text} ${from.symbol}` : DASH };
    const int = { kind: "swap", args: { from: from ? from.symbol : null, to: to ? to.symbol : null, amount: a ? a.text : null }, why: null };
    if (!from || !to) return { pub, int: { ...int, why: "Only the assets listed in your Spot Account can be swapped." } };
    if (from === to) return { pub, int: { ...int, why: "Pick two different assets." } };
    if (from.native) return { pub, int: { ...int, why: "Swaps from AVAX open later. AVAX pays the network fee." } };
    // AVAX can't be swapped back yet, so a swap into it would strand the money; gas AVAX comes with Move in.
    if (to.native) return { pub, int: { ...int, why: "Swaps into AVAX open later. Pick WAVAX instead; Move in brings the AVAX for gas." } };
    if (!exit && !on) return { pub, int: { ...int, why: MONEY_WHY.notOn } };
    if (!a) return { pub, int: { ...int, why: MONEY_WHY.amount } };

    const account = await safe(() => readAccount(own));
    if (!account) return { pub, int: { ...int, why: MONEY_WHY.loading } };
    const px = await pricesFor(account, [from.symbol, to.symbol, "AVAX"]);
    const priceIn = independentPrice(from.symbol, { relay: px.relay, mids: px.mids, side: "in" });
    const priceOut = independentPrice(to.symbol, { relay: px.relay, mids: px.mids, side: "out" });
    const usdIn = priceIn == null ? null : rawToNumber(a.raw, from.decimals) * priceIn;
    if (usdIn == null) return { pub, int: { ...int, why: `${MONEY_WHY.noPrice} (${from.symbol})` } };
    if (caps.swapUsd <= 0) return { pub, int: { ...int, why: "Swaps are off in FlowFlow for now." } };
    if (usdIn > caps.swapUsd + 1e-9) return { pub, int: { ...int, why: `Max $${caps.swapUsd} per swap in FlowFlow for now.` } };
    if (usdIn < SWAP_LIMITS.minUsd) return { pub, int: { ...int, why: `A swap needs at least $${SWAP_LIMITS.minUsd}.` } };
    const bal = account.balances ? account.balances[from.symbol] : null;
    if (typeof bal !== "bigint") return { pub, int: { ...int, why: MONEY_WHY.loading } };
    if (bal < a.raw) return { pub, int: { ...int, why: `Not enough ${from.symbol} in your Spot Account` } };

    const trusted = await settlers();
    let q;
    try {
      ({ review: q } = await quoteSwap({ own, from: from.symbol, to: to.symbol, amountRaw: a.raw, slippageBps: caps.swapSlippageBps, settlers: trusted, fetchImpl, timers, now }));
    } catch (e) {
      return { pub, int: { ...int, why: e instanceof SwapQuoteError || e instanceof OwnMoveError ? e.message : "Swap unavailable for this pair right now. Nothing is signed." } };
    }
    const loss = swapLossCheck({ review: q, priceInUsd: priceIn, priceOutUsd: priceOut, maxLossPct: caps.swapMaxLossPct });
    const fee = await safe(readFee);
    const maxFee = fee ? maxFeeFor(fee.baseFeeWei) : null;
    const g = swapGasUnits(q);
    const gasLimits = [...(q.needsApprove ? [BigInt(g.approve)] : []), BigInt(g.swap)];
    const avaxUsd = avaxUsdOf(px.mids);
    const resAfter = exit ? undefined : reserveAfter(account, px.display, [to.symbol]);
    const gc = maxFee == null ? { ok: false, why: MONEY_WHY.loading, upfrontWei: null }
      : gasCheck({ avaxWei: account.avaxWei, gasLimits, maxFeePerGas: maxFee, kind: exit ? "exit" : "normal", reserveAfterWei: resAfter === undefined ? undefined : resAfter });
    let why = !loss.ok ? (loss.code === "loss" ? `This swap could lose ${loss.lossPct.toFixed(2)}%, over the ${caps.swapMaxLossPct}% FlowFlow allows` : `${MONEY_WHY.noPrice} (${loss.code === "no-price" && priceOut == null ? to.symbol : from.symbol})`) : null;
    if (!why && maxFee != null && !swapTxRequests(q, { maxFeePerGasWei: maxFee })) why = GAS_WHY.feeHigh;

    /* AD-8 same chain: AVAX short → a small USDC → AVAX leg first, PRINTED; never for an exit. */
    let leg = null;
    let legWhy = null;
    if (!why && !gc.ok && gc.shortWei != null && !exit) {
      const legEst = (GAS_LIMITS.swapApprove + GAS_LIMITS.swapFallback) * maxFee;
      const plan = topupPlan({ avaxWei: account.avaxWei, needWei: gc.needWei + legEst, avaxUsd });
      if (!plan.needed || !plan.ok) legWhy = plan.why || gc.why;
      else {
        try {
          const json = await postRelayQuote(buildGasLegQuoteBody({ own, topupUsd: plan.usd }), { fetchImpl, timers });
          leg = parseGasLegQuote(json, { own, topupUsd: plan.usd, now: now(), settlers: trusted });
        } catch (e) {
          legWhy = e && e.message ? e.message : GAS_WHY.loading;
        }
      }
      if (leg) {
        const lg = swapGasUnits(leg);
        const legLimits = [...(leg.needsApprove ? [BigInt(lg.approve)] : []), BigInt(lg.swap)];
        const legGc = gasCheck({ avaxWei: account.avaxWei, gasLimits: legLimits, maxFeePerGas: maxFee, kind: "gas-leg" });
        const legLoss = swapLossCheck({ review: leg, priceInUsd: independentPrice("USDC", { relay: px.relay, mids: px.mids, side: "in" }), priceOutUsd: independentPrice("AVAX", { relay: px.relay, mids: px.mids, side: "out" }) });
        const after = legGc.upfrontWei == null ? null : account.avaxWei - legGc.upfrontWei + BigInt(leg.minOutRaw);
        const post = after == null ? { ok: false, why: MONEY_WHY.loading } : gasCheck({ avaxWei: after, gasLimits, maxFeePerGas: maxFee, kind: "normal", reserveAfterWei: resAfter });
        const usdcNeed = BigInt(leg.amountRaw) + (from.symbol === "USDC" ? a.raw : 0n);
        const usdcHave = account.balances ? account.balances.USDC : null;
        if (!legGc.ok) legWhy = `${legGc.why}. Move USDC in from your Main Account first; it brings gas with it.`;
        else if (!legLoss.ok) legWhy = "The gas for this swap couldn't be priced safely right now";
        else if (!post.ok) legWhy = post.why;
        else if (typeof usdcHave !== "bigint" || usdcHave < usdcNeed) legWhy = "Not enough USDC for the swap and its gas";
        if (legWhy) leg = null;
      }
      if (!leg) why = legWhy || gc.why;
    } else if (!why && !gc.ok) {
      why = gc.why;
    }

    const words = swapWindowWords(q);
    const upAll = gc.upfrontWei != null && leg ? gc.upfrontWei + swapUpfrontWei(leg, maxFee) : gc.upfrontWei;
    const windows = (leg ? leg.txs.length : 0) + q.txs.length;
    const legRow = leg ? leg.gasRow : null;
    Object.assign(pub, {
      receiveText: rawText(q.expectedOutRaw, to.decimals, to.symbol),
      minimumText: rawText(q.minOutRaw, to.decimals, to.symbol),
      feeText: q.fee ? `${q.fee.amount} ${q.fee.symbol}` : "No fee",
      gasText: gasIncludesText(legRow),
      gasRowText: gasRowText(legRow),
      networkFeeText: networkFeeText(upAll, avaxUsd),
      timeText: secsText(q.timeEstimateSec),
      windows,
      quotedAt: q.quotedAt,
      expiresAt: q.quotedAt + SWAP_LIMITS.quoteTtlMs,
      warnings: [
        from.symbol === "XAUt0" || to.symbol === "XAUt0" ? "Thin market on Avalanche. The price impact is checked on every swap." : null,
        to.symbol === "WAVAX" ? "Wrapped AVAX is a token, not the AVAX that pays gas." : null,
      ],
      stages: [
        ...(leg ? [{ key: "leg", label: "Get gas for later from your USDC" }] : []),
        ...(q.needsApprove ? [{ key: "approve", label: words.approve }] : []),
        { key: "swap", label: words.swap },
      ],
      rows: [
        row("amount", "You swap", `${q.amount} ${from.symbol}`),
        row("fee", "Fee", q.fee ? `${q.fee.amount} ${q.fee.symbol}` : "No fee"),
        legRow ? row("gas", "Gas for later", gasRowText(legRow)) : null,
        row("network", "Network fee", networkFeeText(upAll, avaxUsd), "paid in AVAX from your Spot Account"),
        row("receive", "You get about", rawText(q.expectedOutRaw, to.decimals, to.symbol)),
        row("minimum", "Minimum received", rawText(q.minOutRaw, to.decimals, to.symbol), "if the price moves more, nothing is swapped"),
        toRow("your Spot Account"),
        loss.ok && fin(loss.lossPct) ? row("loss", "Worst case vs market", `${Math.max(0, loss.lossPct).toFixed(2)}%`) : null,
        row("time", "Time", secsText(q.timeEstimateSec)),
        row("windows", "Signatures", windowsText(windows)),
      ],
    });
    const toBefore = account.balances ? account.balances[to.symbol] : null;
    const env1 = swapEnvelope(q);
    /* fromAmount (+ from): the amount the Wallet page's "On its way" row prints (portfolio.js flowAmount). */
    const begin = { kind: "swap", amounts: { ...env1, fromAmount: q.amount, toBeforeRaw: typeof toBefore === "bigint" ? toBefore.toString() : null } };
    const legEnv = leg ? swapEnvelope(leg) : null;
    return {
      pub,
      int: {
        ...int, why, q, leg, exit, maxFee, priceIn, priceOut,
        begin, keeps: (rec) => swapOutsideConfirmed(rec.amounts, q) === null,
        legBegin: leg ? { kind: "swap", amounts: { ...legEnv, fromAmount: leg.amount, toBeforeRaw: typeof account.avaxWei === "bigint" ? account.avaxWei.toString() : null } } : null,
        legKeeps: leg ? (rec) => swapOutsideConfirmed(rec.amounts, leg) === null : null,
      },
    };
  }

  const PRICERS = { "move-in": priceMoveIn, "move-out": priceMoveOut, stake: priceStake, unstake: priceUnstake, swap: priceSwap };

  /**
   * AD-9 RULE 3, ONE TABLE FOR EVERY KIND: why the priced-again `fresh` is WORSE than the
   * `shown` card (both reviews' internal halves), or null when it is the same or better.
   * Worse = costs more, guarantees less, pays a higher network fee cap, or needs another
   * window. The runners stop on it at Confirm (requoteOrStop); the card's own background
   * re-quote (useAvaxMoney refresh) says so on screen before Confirm can act on it.
   */
  function worseOf(shown, fresh) {
    if (!shown || !fresh) return "not-decodable";
    if (shown.kind !== fresh.kind) return "different-move";
    const more = (x, y) => Number(x) > Number(y) + 1e-9;
    if (shown.kind === "move-in") {
      const a = shown.q;
      const b = fresh.q;
      if (!a || !b) return "not-decodable";
      if (b.amountRaw !== a.amountRaw) return "different-move";
      if (more(b.amountIn, a.amountIn)) return "costs-more";
      if (b.feeUsdc != null && a.feeUsdc != null && more(b.feeUsdc, a.feeUsdc)) return "fee-higher";
      if (!!b.topup !== !!a.topup) return "different-gas";
      if (b.topup && BigInt(b.topup.raw) < BigInt(a.topup.raw)) return "less-gas";
      return null;
    }
    if (shown.kind === "move-out") {
      const a = shown.q;
      const b = fresh.q;
      if (!a || !b) return "not-decodable";
      if (fresh.route !== shown.route) return "different-route";
      if (Number(b.receiveUsdc) < Number(a.receiveUsdc) - 1e-9 || Number(b.minimumUsdc) < Number(a.minimumUsdc) - 1e-9) return "less-arrives";
      if (b.feeUsdc != null && a.feeUsdc != null && more(b.feeUsdc, a.feeUsdc)) return "fee-higher";
      /* The paid exit's network fee: the card printed "up to ≈… AVAX" at ITS cap (F5). */
      if (shown.route === "paid" && (!shown.fees || !fresh.fees || fresh.fees.maxFeePerGas > shown.fees.maxFeePerGas)) return "fee-higher";
      const n0 = shown.route === "permit" ? a.signatureCount : a.txs.length;
      const n1 = fresh.route === "permit" ? b.signatureCount : b.txs.length;
      if (n1 > n0) return "extra-window";
      return null;
    }
    if (shown.kind === "stake" || shown.kind === "unstake") {
      if (!Array.isArray(shown.steps) || !Array.isArray(fresh.steps)) return "not-decodable";
      if (fresh.steps.map((x) => x.kind).join(",") !== shown.steps.map((x) => x.kind).join(",")) return "different-steps";
      if (!shown.fees || !fresh.fees || fresh.fees.maxFeePerGas > shown.fees.maxFeePerGas) return "fee-higher";
      return null;
    }
    if (shown.kind === "swap") {
      if (!shown.q || !fresh.q) return "not-decodable";
      const c = compareRequote(shown.q, fresh.q);
      if (!c.sign) return c.why;
      if (!!fresh.leg !== !!shown.leg) return "different-gas";
      if (shown.leg) { const cl = compareRequote(shown.leg, fresh.leg); if (!cl.sign) return cl.why; }
      if (typeof shown.maxFee === "bigint" && (typeof fresh.maxFee !== "bigint" || fresh.maxFee > shown.maxFee)) return "fee-higher";
      return null;
    }
    return "not-decodable";
  }

  /**
   * Is `next` (a priced-again card of the same action) WORSE than `prev`, the one on screen?
   * The reason, or null. A card with a reason against it is not compared (it has no Confirm).
   */
  function worse(prev, next) {
    const a = INTERNAL.get(prev);
    const b = INTERNAL.get(next);
    if (!a || !b || a.why || b.why) return null;
    try { return worseOf(a, b); } catch { return "not-decodable"; }
  }

  /** Price an action and make its review (a registry record when it may be confirmed). */
  async function review(kind, args = {}, prev = null) {
    const fn = PRICERS[kind];
    if (!fn) throw new Error(`Not an Avax action: ${kind}`);
    let priced;
    try { priced = await fn(args); } catch { priced = { pub: { kind, title: "Move", amountText: DASH }, int: { kind, args, why: "Couldn't price this right now. Nothing moved." } }; }
    if (ownNow() !== own) priced.int.why = priced.int.why || MONEY_WHY.walletLoading;
    return attach(priced.pub, priced.int, prev);
  }

  /** The same action priced again (the UI's ~60 s refresh, or a changed fee). Keeps the record when it binds the same move. */
  function refresh(prev) {
    const int = INTERNAL.get(prev);
    if (!int) throw new Error("Not an Avax review");
    return review(int.kind, int.args, prev);
  }

  /** The user closed the card: its record (if still a review) is cancelled. Never touches a running flow. */
  function close(prev) {
    const int = INTERNAL.get(prev);
    if (!int) return;
    for (const id of [int.flowId, int.legFlowId]) {
      if (!id) continue;
      try { const r = registry.get(id); if (r && r.state === "review") registry.cancel(id, "closed"); } catch { /* not ours to close */ }
    }
  }

  /* ── CONFIRM ─────────────────────────────────────────────────────────── */

  /**
   * THE CONFIRM. registry.confirm(id) runs SYNCHRONOUSLY, before the first await, so
   * a second call for the same review is refused there ("already-run", not a failure).
   * Resolves an outcome (never throws):
   *   { ok: true, state: "done" | "arriving", message, txHashes?, requestId?, receiptText? }
   *   { ok: false, state, code, message, unknown?, whereToLook?, needsConfirm?, review?, alreadyRun?, allowanceLeft? }
   * @param {object} rv a review from review()/refresh()
   * @param {{ onProgress?: (stages) => void }} [o]
   */
  function confirm(rv, { onProgress = () => {} } = {}) {
    const int = INTERNAL.get(rv);
    if (!int) return Promise.resolve(Object.freeze({ ok: false, state: null, code: "bad-review", message: "This card can't be confirmed. Ask again." }));
    if (!rv.confirmable || !int.flowId) return Promise.resolve(Object.freeze({ ok: false, state: null, code: "not-confirmable", message: rv.whyNot || "This can't be confirmed right now." }));
    /* 🔴 THE GATE — synchronous, the first thing a tap does. */
    const firstId = int.legFlowId || int.flowId;
    const c = registry.confirm(firstId);
    if (!c.ok) {
      if (c.code === "already") {
        const rec = registry.get(firstId);
        /* A card the user closed (or that expired) is not a run: it asks again. */
        if (rec && (rec.state === "cancelled" || rec.state === "expired") && !rec.stages) {
          return Promise.resolve(Object.freeze({ ok: false, state: rec.state, code: "closed", message: "This card was closed. Ask again." }));
        }
        return Promise.resolve(Object.freeze({ ok: false, alreadyRun: true, state: rec ? rec.state : null, code: "already-run", message: "This move already started. It is never sent twice." }));
      }
      return Promise.resolve(Object.freeze({ ok: false, state: null, code: c.code, message: c.message }));
    }
    const confirmedAt = now();
    const stages = rv.stages.map((s) => ({ ...s }));
    const progress = (key, state) => {
      const i = stages.findIndex((s) => s.key === key);
      if (i < 0) return;
      for (let k = 0; k < i; k += 1) if (stages[k].state === "todo" || stages[k].state === "active") stages[k].state = "done";
      stages[i].state = state;
      try { onProgress(Object.freeze(stages.map((s) => Object.freeze({ ...s })))); } catch { /* the run goes on */ }
    };
    const allDone = () => { for (const s of stages) if (s.state !== "failed") s.state = "done"; try { onProgress(Object.freeze(stages.map((s) => Object.freeze({ ...s })))); } catch { /* ignore */ } };
    const failAt = (state) => {
      const s = stages.find((x) => x.state === "active") || stages.find((x) => x.state === "todo");
      if (s) s.state = state === "unknown" ? "unknown" : "failed";
      try { onProgress(Object.freeze(stages.map((x) => Object.freeze({ ...x })))); } catch { /* ignore */ }
    };
    const ctx = { int, rv, confirmedAt, progress, allDone, failAt };
    const RUN = { "move-in": runMoveIn, "move-out": runMoveOut, stake: runAave, unstake: runAave, swap: runSwap }[int.kind];
    return (async () => {
      let out;
      try {
        out = await RUN(ctx);
      } catch {
        /* A runner never throws past its windows; if one ever did, what the registry says stands. */
        const rec = registry.get(int.flowId);
        const state = rec ? rec.state : null;
        out = state === "unknown" || state === "arriving" || state === "sending"
          ? { ok: false, state: "unknown", unknown: true, code: "unexpected", message: "Not confirmed yet. Don't send it again.", whereToLook: whereToLook(int.kind) }
          : { ok: false, state: state || "error-before-money", code: "unexpected", message: "Something went wrong before anything was sent. Nothing moved." };
      }
      if (out && !out.ok) failAt(out.state);
      try { onFlow(int.flowId); } catch { /* the watcher reads it on its own tick too */ }
      return Object.freeze(out);
    })();
  }

  /* An executor's answer → the outcome the card prints. Unknown is never success. */
  function outcomeOf(kind, r, extra = {}) {
    if (r && r.ok === true) return { ok: true, state: r.state || "arriving", message: ARRIVING_WORDS[kind] || "Sent.", ...extra };
    if (r && r.untouched) return { ok: false, alreadyRun: r.code === "already-run", state: null, code: r.code, message: r.message };
    if (r && (r.unknown || r.state === "unknown")) return { ok: false, state: "unknown", unknown: true, code: r.code, message: r.message, whereToLook: whereToLook(kind, { txHash: r.txHash }), ...extra };
    if (r && (r.needsConfirm || r.needsRequote)) return { ok: false, state: r.state || "cancelled", needsConfirm: true, code: r.code, why: r.why || null, message: r.message };
    return { ok: false, state: (r && r.state) || "error-before-money", code: (r && r.code) || "failed", message: (r && r.message) || "Not sent. Nothing moved.", allowanceLeft: !!(r && r.allowanceLeft) };
  }

  /* The record is confirmed but the price must be checked again: a priced-again review
     that is worse ends here, with the new card, and nothing is signed (AD-9 rule 3). */
  async function requoteOrStop(ctx, worseFn) {
    /* Priced WITHOUT a record: the confirmed one is in flight and would block a new card. */
    let priced = null;
    try { priced = await PRICERS[ctx.int.kind](ctx.int.args); } catch { priced = null; }
    if (priced && ownNow() !== own) priced.int.why = priced.int.why || MONEY_WHY.walletLoading;
    const fi = priced ? priced.int : null;
    let worse;
    try { worse = !fi ? "not-decodable" : fi.why ? fi.why : worseFn(fi); } catch { worse = "not-decodable"; }
    if (!worse) return { ok: true, int: fi };
    /* Worse (or no longer possible): nothing is signed; the confirmed record is closed and
       the NEW card is made (it can only get a record once the old one is out of the way). */
    try { registry.cancel(ctx.int.flowId, "requote-worse"); } catch { /* settled */ }
    if (ctx.int.legFlowId && ctx.int.legFlowId !== ctx.int.flowId) { try { registry.cancel(ctx.int.legFlowId, "requote-worse"); } catch { /* settled */ } }
    const fresh = priced ? attach(priced.pub, priced.int, null) : null;
    return {
      ok: false,
      out: { ok: false, state: "cancelled", needsConfirm: true, code: "requote-worse", why: String(worse), message: "The price changed from the one you confirmed. Check the new one. Nothing moved.", review: fresh },
    };
  }

  /* ── runners ─────────────────────────────────────────────────────────── */

  async function runMoveIn(ctx) {
    let { int } = ctx;
    const h = registry.handle(int.flowId);
    const signers = signersNow();
    if (!signers || lower(signers.own) !== own || typeof signers.signAuthorize !== "function" || typeof signers.sendDeposit !== "function") {
      registry.cancel(int.flowId, "no-signer", "error-before-money");
      return { ok: false, state: "error-before-money", code: "no-signer", message: "Your wallet isn't ready. Nothing moved." };
    }
    let q = int.q;
    if (!ownMoveFresh(q, now())) {
      const shown = int;
      const rq = await requoteOrStop(ctx, (f) => worseOf(shown, f));
      if (!rq.ok) return rq.out;
      q = rq.int.q;
    }
    /* The Main Account may have changed since the card: the same §3.5 check, now. */
    const perp = safe2(getPerp) || {};
    const pc = perpMoveCheck({ balance: perp.balance, positions: perp.positions, debitUsdc: q.maxDebitUsdc });
    if (!pc.ok) {
      registry.cancel(int.flowId, "perp-check");
      return { ok: false, state: "cancelled", code: "perp-check", message: `${pc.why}. Nothing moved.` };
    }
    const phase = { authorize: "authorize", authorizing: "authorize", sending: "send", sent: "arrive" };
    const r = await executeOwnMove({
      review: q, ownNow, flow: h, signWords: ownMoveSignWords(q),
      signAuthorize: (step) => signers.signAuthorize(step),
      /* The signer pins the depository; this pins the debit to the card's own ceiling. */
      sendDeposit: (o) => signers.sendDeposit({ ...o, maxDebitUsdc: q.maxDebitUsdc }),
      fetchImpl, now, timers,
      onPhase: (p) => { if (phase[p]) ctx.progress(phase[p], "active"); },
    });
    return outcomeOf("move-in", r, r && r.ok ? { requestId: r.requestId } : {});
  }

  async function runMoveOut(ctx) {
    const { int } = ctx;
    const h = registry.handle(int.flowId);
    const signers = signersNow();
    if (!signers || lower(signers.own) !== own) {
      registry.cancel(int.flowId, "no-signer", "error-before-money");
      return { ok: false, state: "error-before-money", code: "no-signer", message: "Your wallet isn't ready. Nothing moved." };
    }
    let cur = int;
    if (!(fin(cur.q.quotedAt) && now() - cur.q.quotedAt < MOVE_OUT_QUOTE_TTL_MS)) {
      const shown = cur;
      /* worseOf holds the paid exit to the network fee cap the card PRINTED too (F5): a
         re-quote at a higher cap is a new card, never signed under this tap. */
      const rq = await requoteOrStop(ctx, (f) => worseOf(shown, f));
      if (!rq.ok) return rq.out;
      cur = rq.int;
    }
    if (cur.route === "permit") {
      if (typeof signers.signAvaxTypedData !== "function") {
        registry.cancel(int.flowId, "no-signer", "error-before-money");
        return { ok: false, state: "error-before-money", code: "no-signer", message: "This wallet can't sign this move here. Nothing moved." };
      }
      const q = cur.q;
      let at = 0;
      const r = await executeMoveOut({
        review: q, ownNow, flow: h, fetchImpl, now, timers,
        signTypedData: (td) => {
          const sig = q.signatures[at] || q.signatures[q.signatures.length - 1];
          at += 1;
          return signers.signAvaxTypedData(td, { words: moveOutWindowWords(q, sig), review: q });
        },
        onWindow: (_kind, i) => ctx.progress(`sign${i}`, "active"),
      });
      if (r && r.ok) ctx.progress("arrive", "active");
      return outcomeOf("move-out", r, r && r.ok ? { requestId: r.requestId } : {});
    }
    /* The paid exit: two txs from the Spot Account, each rebuilt by the closed builder. */
    const q = cur.q;
    const fees = await keepFees(cur.fees);
    if (!fees.ok) { registry.cancel(int.flowId, "fee-moved"); return { ok: false, state: "cancelled", needsConfirm: true, code: "fee-moved", message: "Avalanche's network fee went up. Check the new price. Nothing moved." }; }
    const items = q.txs.map((t, i) => ({
      label: t.purpose,
      tx: txOf(t, cur.limits[i], fees.fees),
      check: { kind: "paid-exit", review: q, index: t.purpose === "approve" ? 0 : 1 },
      words: t.purpose === "approve" ? `Allow exactly ${q.amountUsdc} USDC for the move to your Main Account` : `Move ${q.amountUsdc} USDC to your Main Account`,
      patch: t.purpose === "deposit" ? { requestId: q.requestId, orderDeadline: q.orderDeadline } : {},
      fresh: () => (q.orderDeadline != null ? q.orderDeadline > Math.floor(now() / 1000) + 30 : now() - q.quotedAt < MOVE_OUT_QUOTE_TTL_MS),
    }));
    const r = await runTxs(ctx, { stage: "paid-exit", items, signers });
    if (r.ok) {
      ctx.progress("arrive", "active");
      return { ok: true, state: "arriving", message: ARRIVING_WORDS["move-out"], requestId: q.requestId, txHashes: r.txHashes };
    }
    return outcomeOf("move-out", r);
  }

  async function runAave(ctx) {
    let { int } = ctx;
    const signers = signersNow();
    if (!signers || lower(signers.own) !== own || typeof signers.sendAvaxTx !== "function") {
      registry.cancel(int.flowId, "no-signer", "error-before-money");
      return { ok: false, state: "error-before-money", code: "no-signer", message: "Your wallet isn't ready. Nothing moved." };
    }
    /* No quote here, so the figures are re-read now: a review that would now cost more
       network fee, need another window, or fail its check is a new card. */
    if (now() - ctx.rv.quotedAt >= AAVE_REVIEW_TTL_MS) {
      const shown = int;
      const rq = await requoteOrStop(ctx, (f) => worseOf(shown, f));
      if (!rq.ok) return rq.out;
      int = { ...rq.int, flowId: int.flowId };
    }
    const fees = await keepFees(int.fees);
    if (!fees.ok) { registry.cancel(int.flowId, "fee-moved"); return { ok: false, state: "cancelled", needsConfirm: true, code: "fee-moved", message: "Avalanche's network fee went up. Check the new price. Nothing moved." }; }
    const items = int.steps.map((s) => {
      const tx = { chainId: AVAX_CHAIN_ID, to: s.tx.to, data: s.tx.data, value: "0x0", gasLimit: s.tx.gasLimit, maxFeePerGas: s.tx.maxFeePerGas, maxPriorityFeePerGas: s.tx.maxPriorityFeePerGas };
      let words = null;
      try { words = aaveTxSummary(decodeAaveTx(tx, own)); } catch { words = null; }
      return { label: s.kind, tx, check: { kind: "aave" }, words, patch: {}, fresh: () => true };
    });
    const stage = ctx.int.kind === "stake" ? "stake" : "unstake";
    const r = await runTxs(ctx, { stage, items, signers });
    if (!r.ok) return outcomeOf(stage, r);
    /* The receipt is the evidence; the balance read is the receipt LINE (plan §3.2 step 8). */
    const acc = await safe(() => readAccount(own));
    const last = r.txHashes[r.txHashes.length - 1];
    let line = null;
    const before = registry.get(int.flowId);
    const b0 = before && before.amounts ? before.amounts.beforeRaw : null;
    if (acc && b0 != null) {
      const now1 = stage === "stake" ? (acc.aave ? acc.aave.suppliedRaw : null) : (acc.balances ? acc.balances.USDC : null);
      if (typeof now1 === "bigint" && now1 >= BigInt(b0)) line = `${stage === "stake" ? "Aave" : "Spot Account"} USDC +${formatRaw(now1 - BigInt(b0), 6, 6)}`;
    }
    try { registry.finish(int.flowId, "done", `receipt status 1 ${last}${line ? `; ${line}` : ""}`); } catch { /* the watcher settles it */ }
    ctx.allDone();
    const amt = int.all ? "All your USDC" : `${int.args.amountUsdc} USDC`;
    return { ok: true, state: "done", message: stage === "stake" ? `${amt} is in Aave.` : `${amt} is back in your Spot Account.`, receiptText: line, txHashes: r.txHashes };
  }

  async function runSwap(ctx) {
    let { int } = ctx;
    const signers = signersNow();
    if (!signers || lower(signers.own) !== own || typeof signers.sendAvaxTx !== "function") {
      for (const id of [int.legFlowId, int.flowId]) { if (id) { try { registry.cancel(id, "no-signer", "error-before-money"); } catch { /* settled */ } } }
      return { ok: false, state: "error-before-money", code: "no-signer", message: "Your wallet isn't ready. Nothing moved." };
    }
    /* The fee cap the card printed (re-read before each executor: the gas leg can take a minute). */
    const capFor = async () => {
      const live = await liveMaxFee();
      return live != null && typeof int.maxFee === "bigint" && live * FEE_HEADROOM_DEN <= int.maxFee * FEE_HEADROOM_NUM ? int.maxFee : null;
    };
    const sendFor = (rq) => (tx, o = {}) => {
      const index = rq.txs.findIndex((t) => t.purpose === tx.purpose);
      ctx.progress(rq.purpose === "gas-leg" ? "leg" : tx.purpose, "active");
      return signers.sendAvaxTx(tx, { words: o.words || null, check: { kind: "swap", review: rq, index } });
    };
    const common = {
      ownNow, now,
      waitReceipt: (hash) => waitReceipt(hash),
      preflight: (tx) => preflight(tx, own),
      readPendingNonce: () => readNonce(own),
      /* One hash, one window (swap.js): Privy's in-window Retry can send the swap twice. */
      readTxNonce: (hash) => readHashNonce(hash),
      readLatestNonce: () => readLatest(own),
    };
    const settleDone = async (id, rq, hash) => {
      const acc = await safe(() => readAccount(own));
      const rec = registry.get(id);
      const b0 = rec && rec.amounts ? rec.amounts.toBeforeRaw : null;
      const now1 = acc ? (rq.to.native ? acc.avaxWei : acc.balances ? acc.balances[rq.to.symbol] : null) : null;
      const delta = typeof now1 === "bigint" && b0 != null && now1 >= BigInt(b0) ? now1 - BigInt(b0) : null;
      const line = delta != null ? `${rq.to.symbol} +${formatRaw(delta, rq.to.decimals, Math.min(rq.to.decimals, 8))}` : null;
      try { registry.finish(id, "done", `receipt status 1 ${hash}${line ? `; ${line}` : ""}`); } catch { /* the watcher settles it */ }
      return line;
    };

    /* 🔴 ONCE THE GAS LEG HAS RUN, MONEY HAS MOVED (USDC → AVAX, its fee and gas): no later
       outcome may say "Nothing moved" / "Nothing was swapped". Every one that follows says the
       gas is in the Spot Account (with the AVAX that arrived and its link), and that the swap
       itself did not run — or, when nobody can say, that it is not confirmed. */
    let legDone = null;
    const afterLeg = (out) => {
      if (!legDone || !out || out.ok) return out;
      const gas = `Gas for later is in your Spot Account${legDone.line ? ` (${legDone.line})` : ""}.`;
      const txHashes = [legDone.hash, ...(Array.isArray(out.txHashes) ? out.txHashes : [])].filter(Boolean);
      if (out.unknown || out.state === "unknown") return { ...out, legDone: true, message: `${gas} ${out.message || "The swap is not confirmed yet. Don't send it again."}`, txHashes };
      const reason = String(out.message || "").replace(/\s*Nothing (moved|was swapped)\.?/g, "").trim();
      return { ...out, legDone: true, message: `${gas} The swap itself didn't run.${reason ? ` ${reason}` : ""}`, txHashes };
    };

    /* 1. The gas leg (when the card printed one), under its own record. */
    if (int.leg && int.legFlowId) {
      let leg = int.leg;
      if (!swapFresh(leg, now())) {
        const shown = int;
        const rq = await requoteOrStop(ctx, (f) => (!f.leg ? "no-gas-leg" : !compareRequote(shown.leg, f.leg).sign ? compareRequote(shown.leg, f.leg).why : !compareRequote(shown.q, f.q).sign ? compareRequote(shown.q, f.q).why : null));
        if (!rq.ok) return rq.out;
        int = { ...rq.int, flowId: int.flowId, legFlowId: int.legFlowId };
        leg = int.leg;
      }
      const cap = await capFor();
      if (cap == null) { registry.cancel(int.legFlowId, "fee-moved"); try { registry.cancel(int.flowId, "fee-moved"); } catch { /* settled */ } return { ok: false, state: "cancelled", needsConfirm: true, code: "fee-moved", message: "Avalanche's network fee went up. Check the new price. Nothing was swapped." }; }
      const lw = swapWindowWords(leg);
      const lr = await executeSwap({ ...common, review: leg, maxFeePerGasWei: cap, sendTx: sendFor(leg), flow: registry.handle(int.legFlowId), words: { approve: lw.approve, swap: `Get gas for later: ${lw.swap}` } });
      if (!lr.ok) {
        try { registry.cancel(int.flowId, "gas-leg-failed"); } catch { /* settled */ }
        return outcomeOf("swap", lr);
      }
      legDone = { line: await settleDone(int.legFlowId, leg, lr.swapTx), hash: lr.swapTx };
      ctx.progress("leg", "done");
      /* 2. Then the swap's own record, under the same tap. */
      const c2 = registry.confirm(int.flowId);
      if (!c2.ok) return afterLeg({ ok: false, state: "cancelled", needsConfirm: true, code: c2.code, message: "The swap needs a new price before it runs." });
    }

    let q = int.q;
    if (!swapFresh(q, now())) {
      const shown = int;
      const rq = await requoteOrStop({ ...ctx, int: { ...int, legFlowId: null } }, (f) => {
        const c = compareRequote(shown.q, f.q);
        return c.sign ? null : c.why;
      });
      if (!rq.ok) return afterLeg(rq.out);
      q = rq.int.q;
    }
    const cap = await capFor();
    if (cap == null) { registry.cancel(int.flowId, "fee-moved"); return afterLeg({ ok: false, state: "cancelled", needsConfirm: true, code: "fee-moved", message: "Avalanche's network fee went up. Check the new price. Nothing was swapped." }); }
    const r = await executeSwap({ ...common, review: q, maxFeePerGasWei: cap, sendTx: sendFor(q), flow: registry.handle(int.flowId), words: swapWindowWords(q) });
    if (!r.ok) return afterLeg(outcomeOf("swap", r));
    const line = await settleDone(int.flowId, q, r.swapTx);
    ctx.allDone();
    return { ok: true, state: "done", message: line ? `Swapped ${q.amount} ${q.from.symbol}: ${line}` : `Swapped ${q.amount} ${q.from.symbol}. At least ${q.minOut} ${q.to.symbol} received.`, receiptText: line, txHashes: [...(legDone ? [legDone.hash] : []), r.swapTx] };
  }

  /* The fee cap the card PRINTED stands at Confirm while the live 2 × base + 1 gwei is at
     most 1.5 × it (the tx is still included with room to spare). Past that the card comes
     back with the new fee — an exit too: it is never refused for the fee level, but the
     figure it pays is always the one printed. */
  async function liveMaxFee() {
    const fee = await safe(readFee);
    return fee ? maxFeeFor(fee.baseFeeWei) : null;
  }
  async function keepFees(shown) {
    const live = await liveMaxFee();
    if (live == null || !shown || typeof shown.maxFeePerGas !== "bigint") return { ok: false };
    return live * FEE_HEADROOM_DEN <= shown.maxFeePerGas * FEE_HEADROOM_NUM ? { ok: true, fees: shown } : { ok: false };
  }

  const txOf = (t, gasLimit, fees) => Object.freeze({
    chainId: AVAX_CHAIN_ID, to: t.to, data: t.data, value: "0x0",
    gasLimit: `0x${BigInt(gasLimit).toString(16)}`,
    maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${(fees.maxPriorityFeePerGas ?? PRIORITY_FEE_WEI).toString(16)}`,
  });

  /**
   * Run Avalanche txs one window at a time, the executors' way (swap.js swapWindows):
   * claim the stage (sync) → own → the cross-tab lock → for each tx: eth_call preflight
   * from own → registry write (+ pending nonce) → the VISIBLE window → receipt. A throw
   * with no hash that is not the user saying no is UNKNOWN; so is a missing receipt.
   * 🔴 ONE HASH, ONE WINDOW: Privy's window offers "Retry transaction" when its own receipt
   * wait fails after a broadcast, sends AGAIN at a new nonce, and hands back only the last
   * hash. So every money tx's hash must be the one tx at the nonce written before its window,
   * with nothing mined past it (txHelpers.nonceBinding) — else the outcome is UNKNOWN: never
   * "Only the network fee was spent" over a first tx that went through, never "done" once
   * for a move that ran twice. No nonce before a window → no window.
   * Never throws.
   */
  async function runTxs(ctx, { stage, items, signers }) {
    const h = registry.handle(ctx.int.flowId);
    const run = claimRun(h, stage);
    if (!run.ok && run.untouched) return { ok: false, code: run.code, message: run.message, state: null, untouched: true };
    let release = () => {};
    let approved = false;
    const end = (state, code, message, extra = {}) => {
      try { release(); } catch { /* released */ }
      try {
        if (approved && state !== "unknown") h.update({ allowanceLeft: true });
        if (state === "unknown") h.unknown(code);
        else h.cancel(code, state);
      } catch { /* the outcome stands */ }
      return { ok: false, code, message, state, ...extra };
    };
    if (!run.ok) return end("error-before-money", "registry", "This browser couldn't record the move, so nothing was sent.");
    const ownIs = () => ownNow() === own;
    if (!ownIs()) return end("error-before-money", "wallet", "Your wallet changed. Nothing moved.");
    if (now() - ctx.confirmedAt > RUN_START_DEADLINE_MS) return end("cancelled", "expired", "This took too long to start. Nothing moved.");
    let lock = null;
    try { lock = await h.acquire(); } catch { lock = null; }
    if (!lock || lock.ok !== true) {
      const storage = !!lock && lock.code === "storage";
      return end(storage ? "error-before-money" : "cancelled", storage ? "registry" : (lock && lock.code) || "busy", storage ? "This browser couldn't record the move, so nothing was sent." : "Another move is still running. Nothing moved.");
    }
    release = typeof lock.release === "function" ? lock.release : () => {};
    const txHashes = [];
    const left = (msg) => (approved ? `Allowed but not sent. ${msg}` : msg);
    try {
      for (const it of items) {
        if (!it.fresh()) return end(approved ? "error-before-money" : "cancelled", "price_expired", left("Price expired. Nothing moved."), { allowanceLeft: approved });
        ctx.progress(it.label, "active");
        let pf = null;
        try { pf = await preflight(it.tx, own); } catch { pf = null; }
        if (!pf || pf.ok !== true) return end("error-before-money", "preflight", left(`${(pf && pf.text) || "Couldn't check this with Avalanche"}. Nothing moved.`), { allowanceLeft: approved });
        if (!ownIs()) return end("error-before-money", "wallet", left("Your wallet changed. Nothing moved."), { allowanceLeft: approved });
        let txNonce = null;
        try { const n = await readNonce(own); txNonce = typeof n === "bigint" && n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null; } catch { txNonce = null; }
        /* The hash is bound to this nonce after the window: without it, no window. */
        if (txNonce == null) return end("error-before-money", "no_nonce", left("Couldn't check this with Avalanche. Nothing moved."), { allowanceLeft: approved });
        try {
          h.beforeWindow({ state: "sending", step: it.label, txNonce, ...it.patch });
        } catch {
          return end("error-before-money", "registry", left("This browser couldn't record the move, so nothing was sent."), { allowanceLeft: approved });
        }
        let hash;
        try {
          hash = await signers.sendAvaxTx(it.tx, { words: it.words, check: it.check });
        } catch (e) {
          const rejected = !!e && (e.code === 4001 || e.code === "ACTION_REJECTED" || /reject|denied|cancel|closed/i.test(String((e && e.message) || e)));
          const refused = !!e && e.code === "refused";
          if (rejected || refused) return end(approved ? "error-before-money" : "cancelled", rejected ? "cancelled" : "refused", left(rejected ? "Cancelled. Nothing moved." : "This wasn't the transaction FlowFlow builds, so it wasn't sent. Nothing moved."), { allowanceLeft: approved });
          return end("unknown", "not_confirmed", "Not confirmed yet. Don't send it again.", { unknown: true, txHash: null });
        }
        if (typeof hash !== "string" || !HASH_RE.test(hash)) return end("unknown", "not_confirmed", "Not confirmed yet. Don't send it again.", { unknown: true, txHash: null });
        try { h.update({ txHash: hash, txNonce, ...(it.label === "approve" ? { approveTx: hash } : {}) }); } catch { /* the hash is returned too */ }
        let rc = null;
        try { rc = await waitReceipt(hash); } catch { rc = null; }
        if (!rc) return end("unknown", "not_confirmed", "Not confirmed yet. Don't send it again.", { unknown: true, txHash: hash });
        if (it.label !== "approve") {
          /* An allowance sent twice moves nothing; a money tx sent twice may have moved twice. */
          const hashNonce = await safe(() => readHashNonce(hash));
          const latestNonce = await safe(() => readLatest(own));
          if (nonceBinding({ txNonce, hashNonce, latestNonce }) !== "ok") {
            return end("unknown", "not_confirmed", "Not confirmed yet. Don't send it again.", { unknown: true, txHash: hash });
          }
        }
        if (Number(rc.status) !== 1) return end("error-before-money", "reverted", left("It didn't go through on Avalanche. Only the network fee was spent."), { txHash: hash, allowanceLeft: approved });
        if (it.label === "approve") approved = true;
        txHashes.push(hash);
        ctx.progress(it.label, "done");
      }
      approved = false;
      try { h.update({ state: "arriving" }); } catch { /* receipts are in hand */ }
      return { ok: true, state: "arriving", txHashes };
    } finally {
      try { release(); } catch { /* released */ }
    }
  }

  return Object.freeze({
    own,
    registry,
    caps,
    entriesOn: on,
    review,
    refresh,
    worse,
    close,
    confirm,
    reviewMoveIn: (args) => review("move-in", args),
    reviewMoveOut: (args) => review("move-out", args),
    reviewStake: (args) => review("stake", args),
    reviewUnstake: (args) => review("unstake", args),
    reviewSwap: (args) => review("swap", args),
  });
}

/** For tests: forget the once-per-session Settler read. */
export function resetSettlersMemo() {
  settlersMemo = null;
}
