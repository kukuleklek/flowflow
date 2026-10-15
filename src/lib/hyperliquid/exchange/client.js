// ─────────────────────────────────────────────────────────────────────────────
// createHlTrader — the ONE facade the perp trade page and position page call.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner: "ใช้ Privy นั้นแหละ คุม ทำเลยพวก ให้แม่งเทรดได้จริงเลย" / "ในหน้าซื้อขาย
// หน้า Position อะ ทำ Full Wire". Self-custody: the user's OWN wallet (Privy's
// embedded wallet or an injected one, through WalletContext's shared ethers
// signer) approves a short-lived trading key once; the key then trades with no
// popup. Every call answers { ok: true, ...details } or { ok: false, code,
// message } in plain English, with Hyperliquid's own text kept as hlText.
//
// WHO SIGNS WHAT
//   the user's wallet   enableTrading (approveAgent, and approveBuilderFee only
//                       when the builder fee is configured and not yet
//                       approved), withdraw, and a Relay withdrawal's two steps
//                       (signRelayAuthorize, sendRelayDeposit). One prompt each.
//   the trading key     openMarket, addMarket, closeFraction, setTpSl,
//                       cancelOrders. No prompt.
//
// NO WALLET CALL HANGS. Every signature is raced against master.js's 60-second
// timeout: the request is dropped, nothing is posted, and the answer is
// wallet_timeout with a Retry. A screen can therefore always finish, which is
// what the owner's black screen was missing.
//
// WHAT HAPPENED, ON THE DEVICE. An optional `diag` function (perp/live/diag.js)
// is called with the steps this file takes — action names, wallet type, chain
// ids, timings, Hyperliquid's own reply text, error names. Never a signature,
// never a key, never typed data.
//
// PRIVY: NO ENABLE STEP (owner, 2026-09-22: "ต้องเซ็น Enable Trading ด้วยหรอวะ").
// Handed silentSigner (services/privy privySilentTypedSigner) and a Privy
// wallet, the trader signs Enable trading's approvals with no window
// (master.js) and runs Enable trading BY ITSELF before a trade whose key is
// missing, expired or rejected: one call, shared with any Enable already
// running, then the trade proceeds. When Hyperliquid refuses a trade because
// the key is gone (pruned, replaced, builder approval missing), a fresh key is
// approved once and the refused trade is run again: a REFUSED request did
// nothing, so that is a first send, never a second one. A LOST reply never
// asks for Enable trading and is never run again. An Enable that fails comes
// back as the trade's answer (must_deposit: the page's Deposit step). An
// injected wallet keeps the visible Enable trading step, and withdraw keeps
// its prompt for every wallet.
//
// SAFETY RULES THIS FILE KEEPS
//   - A signed request is sent ONCE. A lost reply is looked up by the order's
//     cloid (orderStatus); it is never re-sent, because a re-sent order can
//     fill twice.
//   - Unknown is unknown: a position or open-orders read that fails stops the
//     action (state_unknown) instead of being read as "flat" or "no orders".
//   - A new position never opens next to a leftover reduce-only trigger of a
//     position that was closed elsewhere: those are cancelled first.
//   - TP/SL typed on the entry ride one normalTpsl group, and are VERIFIED
//     after the fill; a partial IOC fill drops them (TP/SL docs), so missing
//     legs are placed as positionTpsl for the real size.
//   - Moving a TP/SL places the new trigger FIRST and cancels the old one
//     AFTER; a failed placement cancels nothing. Two stops beat none.
//   - One action per market at a time (a double tap is refused, not doubled).
//   - The agent key never leaves this module in a result or an error.
//
// Nothing here opens a socket or reads the environment. The builder config is
// passed in by the perp page (perp/mock/config.js is the fee's one reader).

import { HL_TRADE_NETWORK, signatureChainIdFor } from "./network.js";
import { createHlInfo } from "../info.js";
import { createHlExchange } from "./transport.js";
import { signL1 } from "./signing.js";
import {
  masterSupport, buildApproveAgentAction, buildApproveBuilderFeeAction, buildWithdrawAction, buildSendAssetAction,
  formatUsdcAmount, withdrawQuote, resolveWalletChainId, signMasterAction, signTypedDataVisibly,
  readDestinationAddress, isWalletTimeout, HL_WITHDRAW_FEE_USDC, HL_WALLET_PROMPT_TIMEOUT_MS,
} from "./master.js";
import { readRelayAuthorizeStep, readRelayDepositStep } from "./relayOut.js";
import { buildIntentsSendAsset } from "./intentsOut.js";
import {
  HL_MAIN_DEX, VENUE_COLLATERAL_MESSAGE, buildAgentSendAssetAction, planVenueSweep, planVenueTopUp, venueMoveAllowed,
  venueCollateralToken, venueOfCoin, venueOrderCollateral,
} from "./venueCollateral.js";
import { browserTimers } from "../browser.js";
import {
  resolveBuilder, planOpenMarket, planAddMarket, planCloseFraction, planPositionTpsl, planTpSlMove,
  classifyTpSlOrders, buildUpdateLeverageAction, buildCancelAction, parseExchangeResponse, HL_DEFAULT_SLIPPAGE,
} from "./orders.js";
import { createAgentStore } from "./agentStore.js";
import { createNonceAllocator } from "./nonce.js";

/** Enable trading renews a key that has less than this left; a longer-lived one is kept. */
export const HL_RENEW_BEFORE_MS = 60 * 60_000;

/**
 * The signatureChainId of every user-signed action a PRIVY wallet makes:
 * Arbitrum One (42161), where the embedded wallet is parked. Written out, not
 * imported from services/privy (this layer reads no service); a test holds it
 * equal to PRIVY_CHAIN_ID.
 */
export const HL_PRIVY_SIGNATURE_CHAIN_ID = "0xa4b1";

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a) => String(a).toLowerCase();
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

const MSG = {
  noWallet: "Connect a wallet first.",
  mismatch: "The wallet that would sign is not the account shown. Reconnect your wallet and try again.",
  chain: "Couldn't read which network your wallet is on. Reconnect it and try again.",
  needsEnable: "Enable trading first: one signature in your wallet, then trades need no popup.",
  stateUnknown: "Couldn't read your Perp account from Hyperliquid just now, so nothing was sent. Try again in a moment.",
  busy: "Still working on your last action in this market.",
  market: "This market isn't loaded yet. Try again in a moment.",
  lost: "Hyperliquid didn't confirm this order, and it can't be found yet. Check your positions before trying again: it was NOT sent twice.",
  declined: "You declined the signature in your wallet. Nothing was sent.",
  noDestination: "Nothing was sent: this withdrawal has no destination address. Confirm where the money should go first.",
};

/* ── shared per-network state (the page's one key store and one nonce counter) ── */

const SHARED = new Map();

/**
 * The browser's trading state for a network: the agent store (localStorage)
 * and the nonce allocator (localStorage + Web Locks). The store's clock is the
 * allocator's server-corrected clock, so expiry is judged on Hyperliquid's time.
 */
export function sharedTradingState(profile = HL_TRADE_NETWORK) {
  let s = SHARED.get(profile.network);
  if (!s) {
    const nonces = createNonceAllocator({ profile });
    const agents = createAgentStore({ profile, now: () => nonces.serverNow() });
    s = Object.freeze({ agents, nonces });
    SHARED.set(profile.network, s);
  }
  return s;
}

function browserCloid() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/* ── wallet errors ─────────────────────────────────────────────────────────── */

function errorText(e) {
  const parts = [];
  const add = (v) => { if (typeof v === "string" && v && !parts.includes(v)) parts.push(v); };
  if (e && typeof e === "object") {
    add(e.shortMessage);
    add(e.message);
    if (e.info && e.info.error) add(e.info.error.message);
    if (e.error) add(e.error.message);
  } else {
    add(String(e));
  }
  return parts.join(" | ") || "unknown error";
}

function isUserRejection(e) {
  if (!e || typeof e !== "object") return false;
  const codes = [e.code, e.info && e.info.error && e.info.error.code, e.error && e.error.code];
  if (codes.includes(4001) || codes.includes("ACTION_REJECTED")) return true;
  return /user (rejected|denied|cancel)|rejected the request|request rejected|denied transaction signature/i.test(errorText(e));
}

function signFailure(e) {
  if (isUserRejection(e)) return fail("signature_rejected", MSG.declined);
  /* The wallet never answered (master.js withWalletTimeout): the request was
     dropped and NOTHING was sent, so this is safe to offer a Retry on. */
  if (isWalletTimeout(e)) return fail("wallet_timeout", `${errorText(e)} Try again.`, { retry: true });
  const text = errorText(e);
  if (/must match the active chain/i.test(text)) {
    return fail("wallet_chain_mismatch", "Your wallet refused to sign for the network it is on. Reconnect it and try again.", { walletText: text });
  }
  return fail("signature_failed", `Your wallet could not sign this: ${text}`, { walletText: text });
}

/* ── replies ───────────────────────────────────────────────────────────────── */

const PLACED_KINDS = new Set(["resting", "waitingForTrigger", "success", "filled"]);

function readPosition(json, coin) {
  if (!json || typeof json !== "object" || !Array.isArray(json.assetPositions)) return { ok: false };
  for (const ap of json.assetPositions) {
    const p = ap && ap.position;
    if (!p || p.coin !== coin) continue;
    const szi = Number(p.szi);
    if (!Number.isFinite(szi)) return { ok: false };
    return { ok: true, position: szi === 0 ? null : p };
  }
  return { ok: true, position: null };
}

/* orderStatus by cloid: what happened to an order whose reply was lost. */
function readLookup(json) {
  if (!json || typeof json !== "object" || json.status !== "order" || !json.order || !json.order.order) return { found: false };
  const o = json.order.order;
  const status = String(json.order.status || "");
  const orig = Number(o.origSz);
  const left = Number(o.sz);
  const filledSz = Number.isFinite(orig) && Number.isFinite(left) ? orig - left : null;
  return { found: true, status, oid: o.oid ?? null, origSz: o.origSz ?? null, filledSz };
}

/**
 * @param {{ master: string, signer: object, walletType: string, chainId?: number|null,
 *   market: (coin: string) => object|null, builder?: { address?: string, feeTenthsBp?: number|null },
 *   profile?: object, slippage?: number,
 *   silentSigner?: (() => ({ address: string, signTypedData: Function }|null))|null,
 *   deps?: { fetchImpl?: Function, agents?: object, nonces?: object, randomCloid?: () => string, now?: () => number } }} o
 *   silentSigner: Privy only, the embedded wallet's no-window signer, read when
 *   Enable trading signs (see PRIVY: NO ENABLE STEP)
 *   feeRateOf: (market) => number|null — the taker rate of THAT market, which a
 *   HIP-3 venue charges a multiple of (perp/live/perpLiveView.js
 *   perpMarketFeeRate). Only the venue collateral move reads it, to size the
 *   move by the same figure the ticket sized its Max by; null (a growth-mode
 *   asset, whose rate the docs give only as a range) is the dash the ticket
 *   shows and adds nothing to the move.
 */
export function createHlTrader({ master, signer, walletType, chainId = null, market, builder = {}, profile = HL_TRADE_NETWORK, slippage = HL_DEFAULT_SLIPPAGE, silentSigner = null, feeRateOf = null, diag = null, venueMoves = null, deps = {} } = {}) {
  const shared = deps.agents && deps.nonces ? null : sharedTradingState(profile);
  const agents = deps.agents || shared.agents;
  const nonces = deps.nonces || shared.nonces;
  const newCloid = deps.randomCloid || browserCloid;
  const now = deps.now || (() => Date.now());
  const timers = deps.timers || browserTimers;
  const walletTimeoutMs = Number.isFinite(deps.walletTimeoutMs) ? deps.walletTimeoutMs : HL_WALLET_PROMPT_TIMEOUT_MS;
  /* The on-device diagnostics recorder (perp/live/diag.js), or nothing. It is
     handed in as a plain function, so this layer cannot read what it holds and
     a page without it behaves identically. It never gets a signature, a key or
     typed data — only names, codes, timings and Hyperliquid's own words. */
  const note = typeof diag === "function" ? (step, fields) => { try { diag(step, fields); } catch { /* a note may not break a trade */ } } : () => {};
  const net = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const info = createHlInfo({ url: profile.infoUrl, ...net });
  const post = createHlExchange({ url: profile.exchangeUrl, ...net });
  const masterLc = isAddress(master) ? lower(master) : null;
  const builderCfg = resolveBuilder(builder || {});
  const support = masterSupport(walletType);
  const busy = new Set();
  let enabling = null;
  /* Privy with a silent signer: Enable trading has no window and runs by itself. */
  const autoEnable = support.ok && walletType === "privy" && silentSigner != null;

  /* The embedded wallet's no-window signer, read at signing time (the bridge
     registers it after mount), and only when it answers for THIS account:
     otherwise the visible prompt signs, never a foreign approval. */
  function silentFor() {
    if (!autoEnable) return null;
    let s;
    try { s = typeof silentSigner === "function" ? silentSigner() : silentSigner; } catch { return null; }
    if (!s || typeof s.signTypedData !== "function" || !isAddress(s.address)) return null;
    return lower(s.address) === masterLc ? s : null;
  }

  /* A qualified coin name ("xyz:TSLA") names the venue its market lives on, and
     every read about it has to carry that name or Hyperliquid answers about the
     main dex instead (measured 2026-09-23: frontendOpenOrders without a dex
     returned 0 of an address's 380 venue orders). venueCollateral.js owns the
     split, so the read path and the money path cannot disagree about it. */
  const withDex = (body, coin) => {
    const dex = venueOfCoin(coin);
    return dex ? { ...body, dex } : body;
  };

  function lookupMarket(coin) {
    try {
      const m = typeof market === "function" ? market(coin) : null;
      return m && typeof m === "object" ? m : null;
    } catch {
      return null;
    }
  }

  /* ── reads (never retried; a failure is reported, not guessed) ── */

  async function readInfo(body) {
    try {
      const json = await info(body);
      return { ok: true, json, at: now() };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  async function readPositions(coin) {
    const r = await readInfo(withDex({ type: "clearinghouseState", user: masterLc }, coin));
    if (!r.ok) return { ok: false };
    if (r.json && r.json.time != null) nonces.noteServerTime(Number(r.json.time), r.at);
    return readPosition(r.json, coin);
  }

  async function readOpenOrders(coin) {
    const r = await readInfo(withDex({ type: "frontendOpenOrders", user: masterLc }, coin));
    if (!r.ok || !Array.isArray(r.json)) return { ok: false };
    return { ok: true, list: r.json };
  }

  async function lookupByCloid(cloid) {
    if (!cloid) return { found: false };
    const r = await readInfo({ type: "orderStatus", user: masterLc, oid: cloid });
    return r.ok ? readLookup(r.json) : { found: false };
  }

  /* What a NEW order on one coin may use, as Hyperliquid computes it. On a venue
     market this is the VENUE's own collateral, not the account's (measured
     2026-09-23: a "default"-mode address holding 5,224,203.98 on the main dex
     answered availableToTrade ["0.0","0.0"] for xyz:TSLA). The pair's order is
     undocumented, so the smaller entry is used — the same rule the ticket's
     liveLimits follows, so the two figures cannot disagree. */
  async function readAvailableToTrade(coin) {
    const r = await readInfo({ type: "activeAssetData", user: masterLc, coin });
    const pair = r.ok && r.json && Array.isArray(r.json.availableToTrade) ? r.json.availableToTrade : null;
    if (!pair || pair.length !== 2) return { ok: false };
    const a = Number(pair[0]);
    const b = Number(pair[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false };
    return { ok: true, usdc: Math.max(0, Math.min(a, b)) };
  }

  /* One dex's own pot: what can leave it, and whether anything is still open on
     it. A size this code cannot read counts as OPEN, so an unreadable position
     never lets money be swept out from under one. */
  async function readDexMoney(dex) {
    const r = await readInfo({ type: "clearinghouseState", user: masterLc, dex });
    const j = r.ok ? r.json : null;
    if (!j || typeof j !== "object" || !Array.isArray(j.assetPositions)) return { ok: false };
    const w = Number(j.withdrawable);
    let positions = 0;
    let cross = 0;
    for (const ap of j.assetPositions) {
      const p = ap && ap.position;
      if (!p) continue;
      const szi = Number(p.szi);
      if (!Number.isFinite(szi) || szi !== 0) {
        positions++;
        /* Only a position that SAYS isolated is isolated; anything else leans on the pot. */
        if (!(p.leverage && p.leverage.type === "isolated")) cross++;
      }
    }
    if (j.time != null) nonces.noteServerTime(Number(j.time), r.at);
    return { ok: true, withdrawableUsdc: Number.isFinite(w) ? w : null, positions, cross };
  }

  /* ── ONE PERP BALANCE, WHATEVER THE MARKET ────────────────────────────────
     The customer has one Perp balance and sees one. Hyperliquid keeps a separate
     pot per HIP-3 venue, and in standard mode a venue market starts with none of
     the customer's money in it — which is why a venue market could not be traded
     at all. These helpers move exactly what an order needs into that pot with
     the TRADING KEY (agentSendAsset: no wallet prompt), confirm it with
     Hyperliquid's own answer before anything is signed against it, and bring it
     home when the order does not happen or the last position closes.

     NOTHING HERE REACHES A SCREEN by name. No dex, no venue, no transfer: the
     words a customer sees are Perp, Buy, Sell and their own balance. The only
     sentences this can produce are VENUE_COLLATERAL_MESSAGE's, and none of them
     names a party or claims a fee. */

  /** How many tries the credit is confirmed over, and how long between them. */
  const creditTries = Number.isSafeInteger(deps.venueCreditTries) && deps.venueCreditTries > 0 ? deps.venueCreditTries : 3;
  const creditWaitMs = Number.isFinite(deps.venueCreditWaitMs) && deps.venueCreditWaitMs >= 0 ? deps.venueCreditWaitMs : 400;
  const wait = (ms) => new Promise((res) => { timers.setTimeout(res, ms); });

  /* dex -> a SETTLED verdict on its collateral token. A failed read is not
     remembered (it is asked again); "not USDC" is, because that does not change
     while the page is open. */
  const venueTokens = new Map();

  const rateOf = (m) => {
    if (typeof feeRateOf !== "function" || !m) return null;
    let v;
    try { v = feeRateOf(m); } catch { return null; }
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  };

  /* The token string this venue's collateral is named by, derived from the
     venue's OWN meta.collateralToken and the spot token list — never hardcoded.
     Measured 2026-09-23: xyz answers 0 (USDC) while flx, vntl and km answer 360
     (USDH), so the wrong constant would have funded a venue with an asset it
     does not take. */
  async function venueCollateralFor(dex) {
    if (venueTokens.has(dex)) return venueTokens.get(dex);
    const [metaR, spotR] = await Promise.all([readInfo({ type: "meta", dex }), readInfo({ type: "spotMeta" })]);
    const meta = metaR.ok && metaR.json && typeof metaR.json === "object" ? metaR.json : null;
    const spot = spotR.ok && spotR.json && typeof spotR.json === "object" ? spotR.json : null;
    const r = venueCollateralToken({
      collateralToken: meta && Number.isSafeInteger(meta.collateralToken) ? meta.collateralToken : null,
      spotTokens: spot && Array.isArray(spot.tokens) ? spot.tokens : null,
    });
    if (r.ok || r.code === "collateral_unsupported") venueTokens.set(dex, r);
    return r;
  }

  /* ONE COLLATERAL DECISION AT A TIME, whatever market asked for it. The
     per-market lock (exclusive) does not cover this: two tickets on two markets of
     the SAME venue would each read the main pot, each decide the shortfall fits,
     and the second move would be refused by Hyperliquid for money the first had
     already taken — leaving a customer who has the money told that they do not.
     Serialised here rather than in exclusive, because a main-dex order must not
     wait behind a venue order's reads. */
  let collateralQueue = Promise.resolve();
  function serialCollateral(run) {
    const next = collateralQueue.then(run, run);
    collateralQueue = next.then(() => {}, () => {});
    return next;
  }

  /* One collateral move, signed by the trading key. */
  function moveCollateral({ sourceDex, destinationDex, token, amount }) {
    return sendL1With((nonce) => buildAgentSendAssetAction({
      destination: masterLc, sourceDex, destinationDex, token, amount, fromSubAccount: "", nonce,
    }));
  }

  /**
   * Make an order on a venue market possible. Answers { ok: true, moved } — moved
   * null when the money was already there — or the refusal that keeps the order
   * from being sent. A main-dex market answers { ok: true, moved: null } without
   * a single request.
   */
  function fundVenueOrder(args) {
    /* A main-dex market answers without a request and without taking the queue. */
    if (!venueOfCoin(args.coin)) return Promise.resolve({ ok: true, moved: null });
    return serialCollateral(() => fundVenueOrderNow(args));
  }

  async function fundVenueOrderNow({ coin, marginUsdc, leverage, market: m }) {
    const dex = venueOfCoin(coin);
    if (!dex) return { ok: true, moved: null };
    const tok = await venueCollateralFor(dex);
    if (!tok.ok) return fail(tok.code === "collateral_unsupported" ? "market_unsupported" : "state_unknown", tok.message);
    const need = venueOrderCollateral({ marginUsdc: Number(marginUsdc), leverage, feeRate: rateOf(m) });
    const here = await readAvailableToTrade(coin);
    if (!here.ok) return fail("state_unknown", MSG.stateUnknown);
    const main = await readDexMoney(HL_MAIN_DEX);
    if (!main.ok) return fail("state_unknown", MSG.stateUnknown);
    const move = planVenueTopUp({ needUsdc: need, venueAvailableUsdc: here.usdc, mainAvailableUsdc: main.withdrawableUsdc });
    if (!move.ok) return fail(move.code, move.message);
    if (move.amount == null) return { ok: true, moved: null };
    /* THE SILENT MOVE IS THE OWNER'S CALL (plan Q0): no policy, or auto off, and
       nothing is signed; a dex outside the list or an amount past the cap, same. */
    const allowed = venueMoveAllowed(venueMoves, { dex });
    if (!allowed.ok) { note("venue.fund.blocked", { code: allowed.code, amount: move.amount }); return allowed; }
    note("venue.fund.start", { amount: move.amount, need, have: here.usdc });
    const sent = await moveCollateral({ sourceDex: HL_MAIN_DEX, destinationDex: dex, token: tok.token, amount: move.amount });
    if (!sent.ok) {
      /* A LOST reply: the move may have gone through, so it is never re-sent and
         no order is placed against a balance nobody can vouch for. The money is
         the customer's wherever it sits, which is what they are told. */
      if (sent.lost === true) return fail("not_confirmed", VENUE_COLLATERAL_MESSAGE.timeout, { lost: true, retry: false });
      note("venue.fund.refused", { code: sent.code });
      return sent;
    }
    const moved = { dex, token: tok.token, amount: move.amount };
    /* CONFIRMED BY HYPERLIQUID, not by us: an order signed against a credit that
       has not landed is an order Hyperliquid refuses. */
    for (let i = 0; i < creditTries; i++) {
      const again = await readAvailableToTrade(coin);
      if (again.ok && again.usdc + 1e-9 >= need) {
        note("venue.fund.done", { amount: move.amount, tries: i + 1 });
        return { ok: true, moved };
      }
      if (i + 1 < creditTries && creditWaitMs > 0) await wait(creditWaitMs);
    }
    const back = await returnTopUp(moved, null);
    note("venue.fund.timeout", { amount: move.amount, returned: !!(back && back.returned) });
    return fail("not_confirmed", VENUE_COLLATERAL_MESSAGE.timeout, { retry: true, collateralReturned: back });
  }

  /**
   * Bring a top-up home after the order did not happen. It sweeps the venue's
   * OWN withdrawable (Hyperliquid's figure, one source per figure), never the
   * amount that was sent, so a leftover from an earlier attempt comes back too.
   *
   * IT NEVER PULLS MONEY OUT FROM UNDER A POSITION. An outcome nobody can read —
   * a lost reply, an order recovered by cloid — leaves the money exactly where
   * it is, because that money may already be margin.
   */
  async function returnTopUp(moved, refusal) {
    if (!moved) return null;
    if (refusal && (refusal.lost === true || refusal.recovered === true || refusal.code === "unknown_outcome")) {
      return { returned: false, reason: "outcome_unknown" };
    }
    const st = await readDexMoney(moved.dex);
    if (!st.ok) return { returned: false, reason: "state_unknown" };
    const s = planVenueSweep({ venueWithdrawableUsdc: st.withdrawableUsdc, venuePositions: st.positions, venueCrossPositions: st.cross });
    if (!s.ok) return { returned: false, reason: s.code };
    if (s.amount == null) return { returned: false, reason: st.positions > 0 ? "position_open" : "nothing_idle" };
    const r = await moveCollateral({ sourceDex: moved.dex, destinationDex: HL_MAIN_DEX, token: moved.token, amount: s.amount });
    return { returned: r.ok === true, amount: s.amount, code: r.ok ? null : r.code };
  }

  /**
   * The last position on a venue market closed: its collateral is idle, so it
   * goes back to where the customer's Perp balance is spent from (a withdrawal
   * leaves the main dex, so money left behind would be money the Withdraw sheet
   * could not reach).
   */
  async function sweepVenue(dex) {
    /* A sweep is a silent move too: off with the policy, the money stays in its
       pot (still in the balance) until the owner opens moves. */
    if (!venueMoveAllowed(venueMoves, { dex }).ok) return { swept: false, reason: "moves_off" };
    const tok = await venueCollateralFor(dex);
    if (!tok.ok) return { swept: false, reason: tok.code };
    const st = await readDexMoney(dex);
    if (!st.ok) return { swept: false, reason: "state_unknown" };
    const s = planVenueSweep({ venueWithdrawableUsdc: st.withdrawableUsdc, venuePositions: st.positions, venueCrossPositions: st.cross });
    if (!s.ok) return { swept: false, reason: s.code };
    if (s.amount == null) return { swept: false, reason: st.positions > 0 ? "position_open" : "nothing_idle" };
    note("venue.sweep.start", { amount: s.amount });
    const r = await moveCollateral({ sourceDex: dex, destinationDex: HL_MAIN_DEX, token: tok.token, amount: s.amount });
    note("venue.sweep.end", { amount: s.amount, ok: r.ok === true, code: r.code });
    return { swept: r.ok === true, amount: s.amount, code: r.ok ? null : r.code };
  }

  /* ── sending ── */

  async function postBody(body) {
    let res;
    try {
      res = await post(body);
    } catch (e) {
      const timeout = e && e.kind === "timeout";
      return fail("network", timeout ? "Hyperliquid did not answer in time." : "Couldn't reach Hyperliquid. Check your connection.", { lost: true });
    }
    /* A 5xx comes from the edge in front of Hyperliquid (an HTML page), and says
       nothing about whether the action went through: unknown, like a timeout. */
    if (res.httpStatus >= 500) {
      return fail("network", `Hyperliquid's server answered HTTP ${res.httpStatus}.`, { lost: true, httpStatus: res.httpStatus });
    }
    return parseExchangeResponse(res.json, res.httpStatus, res.text);
  }

  /* An L1 action signed by the trading key. A verdict that the key is gone
     (pruned, replaced, builder approval missing) retires it at once. */
  function sendL1(action) {
    return sendL1With(() => action);
  }

  /* The same, for an action whose OWN nonce field has to equal the envelope's.
     agentSendAsset is one (docs, Agent Send Asset: "Nonce (timestamp in ms).
     Equal to the envelope nonce"), and sendL1 could not build one: it takes the
     action already built and allocates the nonce afterwards. Here the nonce is
     allocated FIRST and handed to the factory, so the signed body and the
     envelope cannot drift apart. */
  async function sendL1With(makeAction) {
    const agent = agents.account(masterLc);
    if (!agent) return needsEnable();
    let signature;
    let nonce;
    let action;
    try {
      nonce = await nonces.next(agent.address);
      action = makeAction(nonce);
      signature = await signL1({ wallet: agent, action, nonce, profile });
    } catch (e) {
      return fail("signing_failed", `Couldn't sign with the trading key: ${errorText(e)}`);
    }
    const r = await postBody({ action, nonce, signature });
    const retire = (!r.ok && r.needsEnable) || (r.ok && r.statuses.some((s) => s.kind === "error" && s.needsEnable));
    if (retire) {
      const reason = r.ok ? r.statuses.find((s) => s.kind === "error" && s.needsEnable).code : r.code;
      agents.markRejected(masterLc, agent.address, reason);
    }
    return r;
  }

  /* A user-signed action: one prompt in the user's own wallet; none when
     quiet is asked for and the wallet is Privy's (master.js decides). */
  async function sendMaster(action, { quiet = false } = {}) {
    let signed;
    const silent = quiet ? silentFor() : null;
    const started = now();
    /* A trader BUILT WITH the no-window signer (a Privy login in the app)
       never opens a Privy window for Enable trading. If the embedded wallet's
       signer is not registered yet, or answers for another address, the answer
       is a plain "try again" — not a fallback to the window the owner reported
       as a black screen. An injected wallet is unaffected: it has no silent
       signer and never wanted one. */
    if (quiet && autoEnable && !silent) {
      note("sign.no-silent", { action: action && action.type });
      return fail("wallet_not_ready", "Your FlowFlow wallet isn't ready yet. Give it a moment and try again.", { retry: true });
    }
    note("sign.start", { action: action && action.type, wallet: walletType, window: silent ? "none" : "wallet", signatureChainId: action && action.signatureChainId });
    try {
      signed = await signMasterAction({ signer, action, walletType, silent, timeoutMs: walletTimeoutMs, timers });
    } catch (e) {
      const f = signFailure(e);
      note("sign.failed", { action: action && action.type, code: f.code, name: e && e.name, ms: now() - started });
      return f;
    }
    note("sign.done", { action: action && action.type, ms: now() - started, window: signed.silent ? "none" : "wallet" });
    if (signed.address !== masterLc) return fail("wallet_mismatch", MSG.mismatch);
    const r = await postBody({ action, nonce: action.nonce ?? action.time, signature: signed.signature });
    note("hl.reply", { action: action && action.type, ok: r.ok === true, code: r.code, hl: r.hlText, ms: now() - started });
    if (r.ok) return r;
    /* A wrong signature does not fail cleanly: Hyperliquid recovers SOME address
       and reports it (Signing docs). An address that is not the user's means the
       signature itself was not understood (for example the signatureChainId). */
    const recoveredText = typeof r.hlText === "string" && /Must deposit before performing actions|User or API Wallet/i.test(r.hlText);
    const named = recoveredText ? r.hlText.match(/0x[0-9a-fA-F]{40}/) : null;
    if (named && lower(named[0]) !== masterLc) {
      return fail("signature_not_recognized", `Hyperliquid didn't read this signature as coming from your wallet, so nothing changed. Hyperliquid said: ${r.hlText}`, { hlText: r.hlText });
    }
    return r;
  }

  function needsEnable() {
    const st = agents.status(masterLc);
    return fail("needs_enable", MSG.needsEnable, { needsEnable: true, state: st.state, reason: st.reason });
  }

  /* Wallet support, a master, and an active trading key. */
  function tradeGate() {
    if (!support.ok) return support;
    if (!masterLc) return fail("no_wallet", MSG.noWallet);
    if (!agents.account(masterLc)) return needsEnable();
    return null;
  }

  async function masterGate() {
    if (!support.ok) return { err: support };
    if (!masterLc || !signer) return { err: fail("no_wallet", MSG.noWallet) };
    let addr;
    try { addr = lower(await signer.getAddress()); } catch { return { err: fail("no_wallet", MSG.noWallet) }; }
    if (addr !== masterLc) return { err: fail("wallet_mismatch", MSG.mismatch) };
    /* 🔴 THE PRIVY WALLET SIGNS FOR ARBITRUM, WHATEVER IT LAST TOUCHED. The same
       embedded EOA is the Avax Wallet, and its Avalanche transactions and permits
       name chain 43114. They never switch the wallet (PrivyBridge), but the
       Main Account's signatures must not depend on that holding: a Privy
       wallet's user-signed actions are pinned to 0xa4b1, the chain it is parked
       on (services/privy PRIVY_CHAIN_ID) and the one the official docs use, so
       nothing on the Avalanche side can ever change what a sendAsset, a
       withdrawal or an approval is signed for. An injected wallet keeps its
       current chain (network.js). */
    if (walletType === "privy") return { sigChain: HL_PRIVY_SIGNATURE_CHAIN_ID };
    const id = await resolveWalletChainId(signer, chainId);
    const sigChain = signatureChainIdFor(id);
    if (!sigChain) return { err: fail("wallet_chain_unknown", MSG.chain) };
    return { sigChain };
  }

  /* One action per market at a time. */
  async function exclusive(coin, run) {
    const k = String(coin);
    if (busy.has(k)) return fail("busy", MSG.busy);
    busy.add(k);
    try {
      return await run();
    } finally {
      busy.delete(k);
    }
  }

  /* A trade that needs the trading key, one per market at a time. Without
     autoEnable: refused needs_enable before anything is signed, as ever. With
     it (Privy): Enable trading first when the key is not active, and once more
     if Hyperliquid refuses the trade because the key is gone, then the trade
     again. At most one Enable per call. */
  function withKey(coin, flow) {
    const gate = tradeGate();
    if (!autoEnable) return gate ? Promise.resolve(gate) : exclusive(coin, flow);
    if (gate && gate.needsEnable !== true) return Promise.resolve(gate);
    return exclusive(coin, async () => {
      let enabled = null;
      if (tradeGate()) {
        enabled = await trader.enableTrading();
        if (!enabled.ok) return { ...enabled, step: enabled.step || "enable" };
        const still = tradeGate();
        if (still) return still;
      }
      let r = await flow();
      if (!enabled && r && r.ok === false && r.needsEnable === true) {
        enabled = await trader.enableTrading();
        if (!enabled.ok) return { ...enabled, step: enabled.step || "enable" };
        r = await flow();
      }
      if (enabled && r && r.ok === true) {
        return { ...r, autoEnabled: { signatures: enabled.signatures, validUntil: enabled.validUntil ?? null, builderApproved: enabled.builderApproved ?? null } };
      }
      return r;
    });
  }

  /* ── building blocks of the flows ── */

  async function cancelOids(asset, oids) {
    if (!oids.length) return { cancelled: [], failed: [] };
    const r = await sendL1(buildCancelAction(oids.map((oid) => ({ asset, oid }))));
    if (!r.ok) return { cancelled: [], failed: [...oids], error: r };
    const cancelled = [];
    const failed = [];
    oids.forEach((oid, i) => {
      const s = r.statuses[i];
      if (s && (s.kind === "success" || (s.kind === "error" && s.code === "order_gone"))) cancelled.push(oid);
      else failed.push(oid);
    });
    return { cancelled, failed };
  }

  /* The entry of a market order: sent once; a lost reply is looked up. */
  async function sendEntry(action, cloid) {
    const r = await sendL1(action);
    if (r.ok) {
      const s = r.statuses[0];
      if (!s) return fail("bad_response", "Hyperliquid answered without an order status. Check your positions before trying again.");
      if (s.kind === "error") return fail(s.code, s.message, { hlText: s.hlText, needsEnable: s.needsEnable });
      if (s.kind === "filled") return { ok: true, status: "filled", filled: { totalSz: s.totalSz, avgPx: s.avgPx, oid: s.oid }, recovered: false };
      if (s.kind === "resting") return { ok: true, status: "resting", filled: null, oid: s.oid, recovered: false };
      return fail("bad_response", "Hyperliquid answered something unexpected. Check your positions before trying again.");
    }
    if (!r.lost) return r;
    const found = await lookupByCloid(cloid);
    if (!found.found) return fail("unknown_outcome", MSG.lost, { cloid });
    if (found.filledSz != null && found.filledSz > 0) {
      return { ok: true, status: "filled", filled: { totalSz: String(Number(found.filledSz.toPrecision(12))), avgPx: null, oid: found.oid }, recovered: true };
    }
    if (found.status === "open" || found.status === "triggered") return { ok: true, status: "resting", filled: null, oid: found.oid, recovered: true };
    return fail("not_filled", "The order did not fill, so nothing changed.", { hlText: found.status, recovered: true });
  }

  /* Run a planTpSlMove: placeNew first; cancelOld only for legs whose new
     trigger landed (and for legs asked to be removed). */
  async function runMove(move, { requested }) {
    const placed = {};
    const failedLegs = {};
    const landed = new Set();
    for (const step of move.steps) {
      if (step.kind !== "placeNew") continue;
      const r = await sendL1(step.action);
      if (!r.ok) {
        if (r.lost) return fail("unknown_outcome", "Hyperliquid didn't confirm the new TP/SL. Your old TP/SL was kept; check your orders.");
        return r;
      }
      step.legs.forEach((leg, i) => {
        const s = r.statuses[i];
        if (s && PLACED_KINDS.has(s.kind)) {
          placed[leg.leg] = { triggerPx: leg.triggerPx, size: leg.size, oid: s.oid ?? null, cloid: leg.cloid ?? null };
          landed.add(leg.leg);
        } else {
          failedLegs[leg.leg] = s && s.kind === "error" ? { code: s.code, message: s.message, hlText: s.hlText } : { code: "bad_response", message: "No status for this leg." };
        }
      });
      if (!landed.size) {
        const first = Object.values(failedLegs)[0] || { code: "bad_response", message: "Hyperliquid did not place the TP/SL." };
        return fail(first.code, first.message, { hlText: first.hlText, failedLegs });
      }
    }
    const toCancel = [];
    for (const leg of ["tp", "sl"]) {
      if (!requested[leg]) continue;
      if (requested[leg] === "remove" || landed.has(leg)) toCancel.push(...move.cancelOids[leg]);
    }
    const c = await cancelOids(move.asset, toCancel);
    const out = { ok: true, coin: move.coin, placed, cancelled: c.cancelled, cancelFailed: c.failed, failedLegs };
    if (c.failed.length) out.warning = "The new TP/SL is in place, but the old one couldn't be cancelled yet, so both are open. Try again to remove the old one.";
    return out;
  }

  /* After an open with TP/SL: are the legs really on the book? */
  async function verifyTpSl({ m, plan, requested }) {
    const result = { tp: requested.tp ? "unverified" : "not_requested", sl: requested.sl ? "unverified" : "not_requested" };
    const after = await readPositions(m.coin);
    const oo = await readOpenOrders(m.coin);
    if (!after.ok || !oo.ok) return result;
    const have = classifyTpSlOrders(oo.list, m.coin);
    const missing = [];
    for (const leg of ["tp", "sl"]) {
      if (!requested[leg]) continue;
      const want = Number(leg === "tp" ? plan.tpPx : plan.slPx);
      const cloid = plan.cloids[leg];
      const there = have[leg].some((o) => (cloid && o.cloid && lower(o.cloid) === lower(cloid)) || o.triggerPx === want);
      if (there) result[leg] = "placed";
      else missing.push(leg);
    }
    if (!missing.length || !after.position) return result;
    const fix = planPositionTpsl({
      market: m, position: after.position,
      tp: missing.includes("tp") ? plan.tpPx : undefined,
      sl: missing.includes("sl") ? plan.slPx : undefined,
      builder: builderCfg, cloids: { tp: newCloid(), sl: newCloid() },
    });
    if (!fix.ok) {
      for (const leg of missing) result[leg] = "failed";
      return { ...result, error: { code: fix.code, message: fix.message } };
    }
    const r = await sendL1(fix.action);
    fix.legs.forEach((leg, i) => {
      const s = r.ok ? r.statuses[i] : null;
      result[leg.leg] = s && PLACED_KINDS.has(s.kind) ? "placed_after_fill" : "failed";
    });
    if (!r.ok) return { ...result, error: { code: r.code, message: r.message, hlText: r.hlText } };
    return result;
  }

  /* ── the facade ── */

  const trader = {
    network: profile.network,
    master: masterLc,

    /**
     * { enabled, auto, state, agentAddress, validUntil, reason, persisted } —
     * never the key. enabled: the key is active now. auto: a trade enables
     * itself with no window (Privy), so there is no Enable trading step.
     */
    isTradingEnabled() {
      if (!support.ok) return { enabled: false, auto: false, state: "unsupported", agentAddress: null, validUntil: null, reason: support.code, persisted: null };
      if (!masterLc) return { enabled: false, auto: false, state: "none", agentAddress: null, validUntil: null, reason: "no_wallet", persisted: null };
      const st = agents.status(masterLc);
      return { enabled: st.state === "active", auto: autoEnable, state: st.state, agentAddress: st.address, validUntil: st.validUntil, reason: st.reason, persisted: st.persisted };
    },

    /** For useSyncExternalStore: the trading key's state changes. */
    subscribe: (fn) => agents.subscribe(fn),
    version: () => agents.version(),

    /**
     * Enable trading: approve a fresh 24-hour trading key (one wallet prompt),
     * plus FlowFlow's builder fee when it is configured and not yet approved
     * (a second prompt, once). Resolves { ok, agentAddress, validUntil, signatures }.
     */
    enableTrading() {
      if (!enabling) enabling = doEnable().finally(() => { enabling = null; });
      return enabling;
    },

    /** Wipe this account's trading key on this device (Hyperliquid expires it at valid_until). */
    disableTrading() {
      if (masterLc) agents.clear(masterLc);
    },

    /**
     * A new position at market. marginUsdc is USDC of margin; the size is
     * margin x leverage at the current mid. Isolated margin. tp / sl are prices.
     */
    openMarket({ coin, side, marginUsdc, leverage, tp = null, sl = null, slippage: slip = slippage } = {}) {
      return withKey(coin, async () => {
        const cloids = { entry: newCloid(), tp: tp != null ? newCloid() : undefined, sl: sl != null ? newCloid() : undefined };
        const args = { side, marginUsdc, leverage, tp, sl, slippage: slip, builder: builderCfg, cloids };
        let m = lookupMarket(coin);
        let plan = planOpenMarket({ market: m, ...args });
        if (!plan.ok) return plan;
        const pos = await readPositions(plan.coin);
        if (!pos.ok) return fail("state_unknown", MSG.stateUnknown);
        if (pos.position) return fail("position_exists", "You already have a position in this market. Add to it or close it instead.");
        const oo = await readOpenOrders(plan.coin);
        if (!oo.ok) return fail("state_unknown", MSG.stateUnknown);
        const orphans = classifyTpSlOrders(oo.list, plan.coin);
        const orphanOids = [...orphans.tp, ...orphans.sl].map((o) => o.oid);
        let clearedOrphans = [];
        if (orphanOids.length) {
          const c = await cancelOids(plan.asset, orphanOids);
          if (c.failed.length) {
            return fail("orphan_cancel_failed", "An old TP/SL order in this market is still open and couldn't be cancelled, so nothing was opened. Try again.", { oids: c.failed });
          }
          clearedOrphans = c.cancelled;
        }
        /* ONE PERP BALANCE. A HIP-3 venue market is margined from its own pot,
           which in standard mode starts empty however much the account holds; this
           moves exactly what THIS order needs into it with the trading key, and
           nothing is signed against the credit until Hyperliquid confirms it. A
           main-dex market sends no request at all. The customer is told nothing. */
        const funded = await fundVenueOrder({ coin: plan.coin, marginUsdc: plan.marginUsdc, leverage: plan.leverage, market: m });
        if (!funded.ok) return { ...funded, clearedOrphans };
        const back = (refusal) => returnTopUp(funded.moved, refusal);
        const lev = await sendL1(buildUpdateLeverageAction({ asset: plan.asset, leverage: plan.leverage, isCross: false }));
        if (!lev.ok) {
          const returned = await back(lev);
          const f = lev.lost ? fail("network", "Couldn't set the leverage (no answer from Hyperliquid). Nothing was opened.") : lev;
          return returned ? { ...f, collateralReturned: returned } : f;
        }
        /* Price the order on the freshest mid, right before it is signed. */
        m = lookupMarket(coin);
        plan = planOpenMarket({ market: m, ...args });
        if (!plan.ok) {
          const returned = await back(plan);
          return returned ? { ...plan, collateralReturned: returned } : plan;
        }
        const entry = await sendEntry(plan.action, plan.cloids.entry);
        if (!entry.ok) {
          const returned = await back(entry);
          return { ...entry, clearedOrphans, ...(returned ? { collateralReturned: returned } : {}) };
        }
        const filledSz = entry.filled ? Number(entry.filled.totalSz) : 0;
        const requested = { tp: plan.tpPx != null, sl: plan.slPx != null };
        const out = {
          ok: true, coin: plan.coin, side: plan.isBuy ? "buy" : "sell", status: entry.status, filled: entry.filled,
          partial: entry.status === "filled" && filledSz < Number(plan.size), size: plan.size, leverage: plan.leverage,
          marginUsdc: plan.marginUsdc, limitPx: plan.limitPx, cloid: plan.cloids.entry, recovered: entry.recovered,
          clearedOrphans, tpsl: { tp: requested.tp ? "unverified" : "not_requested", sl: requested.sl ? "unverified" : "not_requested" },
        };
        if (entry.status === "filled" && (requested.tp || requested.sl)) {
          const v = await verifyTpSl({ m, plan, requested });
          const { error, ...legs } = v;
          out.tpsl = legs;
          if (error) out.tpslError = error;
        }
        return out;
      });
    },

    /** More of an open position, same side, at the position's own leverage. */
    addMarket({ coin, marginUsdc, slippage: slip = slippage } = {}) {
      return withKey(coin, async () => {
        const m = lookupMarket(coin);
        if (!m) return fail("market_unknown", MSG.market);
        const pos = await readPositions(m.coin);
        if (!pos.ok) return fail("state_unknown", MSG.stateUnknown);
        if (!pos.position) return fail("no_position", "You have no open position in this market.");
        const oo = await readOpenOrders(m.coin);
        if (!oo.ok) return fail("state_unknown", MSG.stateUnknown);
        const plan = planAddMarket({ market: m, position: pos.position, marginUsdc, slippage: slip, builder: builderCfg, cloid: newCloid() });
        if (!plan.ok) return plan;
        /* The same one balance: more margin for a venue position comes from the
           account, automatically, before the order. */
        const funded = await fundVenueOrder({ coin: plan.coin, marginUsdc: plan.marginUsdc, leverage: plan.leverage, market: m });
        if (!funded.ok) return funded;
        const entry = await sendEntry(plan.action, plan.cloid);
        if (!entry.ok) {
          /* The position is still open: returnTopUp brings the top-up home only
             when every position on that pot is isolated (FlowFlow's always are), so a
             live position's margin is never thinned. Otherwise it stays in the pot,
             counted in the Perp balance, and the next sell sweeps it. */
          const returned = await returnTopUp(funded.moved, entry);
          return returned ? { ...entry, collateralReturned: returned } : entry;
        }
        const out = {
          ok: true, coin: plan.coin, side: plan.isBuy ? "buy" : "sell", status: entry.status, filled: entry.filled,
          partial: entry.status === "filled" && Number(entry.filled.totalSz) < Number(plan.size), size: plan.size,
          leverage: plan.leverage, marginUsdc: plan.marginUsdc, limitPx: plan.limitPx, cloid: plan.cloid,
          recovered: entry.recovered, tpslResized: [],
        };
        /* A fixed-size TP/SL no longer covers the bigger position: re-place it. */
        const have = classifyTpSlOrders(oo.list, plan.coin);
        if (entry.status !== "filled" || (!have.tp.length && !have.sl.length)) return out;
        const after = await readPositions(plan.coin);
        if (!after.ok || !after.position) {
          out.tpslResized = null;
          out.warning = "Couldn't re-read the position to resize your TP/SL. Check it on the position page.";
          return out;
        }
        const size = Math.abs(Number(after.position.szi));
        const short = (list) => list.some((o) => o.sz != null && o.sz > 0 && Math.abs(o.sz - size) > 1e-12);
        const tp = short(have.tp) ? have.tp[0].triggerPx : undefined;
        const sl = short(have.sl) ? have.sl[0].triggerPx : undefined;
        if (tp === undefined && sl === undefined) return out;
        const move = planTpSlMove({ market: m, position: after.position, openOrders: oo.list, tp, sl, builder: builderCfg, cloids: { tp: newCloid(), sl: newCloid() } });
        if (!move.ok) {
          out.warning = `Your TP/SL still covers the old size: ${move.message}`;
          return out;
        }
        const r = await runMove(move, { requested: { tp: tp !== undefined, sl: sl !== undefined } });
        if (!r.ok) {
          out.warning = `Your TP/SL still covers the old size: ${r.message}`;
          return out;
        }
        out.tpslResized = Object.keys(r.placed);
        if (r.warning) out.warning = r.warning;
        return out;
      });
    },

    /** Close a fraction (0 < f <= 1) of the position: a reduce-only IOC. */
    closeFraction(coin, fraction, { slippage: slip = slippage } = {}) {
      return withKey(coin, async () => {
        const m = lookupMarket(coin);
        if (!m) return fail("market_unknown", MSG.market);
        const pos = await readPositions(m.coin);
        if (!pos.ok) return fail("state_unknown", MSG.stateUnknown);
        if (!pos.position) return fail("no_position", "You have no open position in this market.");
        const plan = planCloseFraction({ market: m, position: pos.position, fraction, slippage: slip, builder: builderCfg, cloid: newCloid() });
        if (!plan.ok) return plan;
        const entry = await sendEntry(plan.action, plan.cloid);
        if (!entry.ok) return entry;
        const out = {
          ok: true, coin: plan.coin, status: entry.status, filled: entry.filled, size: plan.size, closesAll: plan.closesAll,
          partial: entry.status === "filled" && Number(entry.filled.totalSz) < Number(plan.size), limitPx: plan.limitPx,
          cloid: plan.cloid, recovered: entry.recovered,
        };
        if (entry.status !== "filled") return out;
        if (!plan.closesAll) {
          /* A PARTIAL SELL frees margin too, and it comes home the same way (owner,
             2026-10-15): the sweep reads Hyperliquid's withdrawable and moves only
             when every position left on that pot is isolated. */
          const pdex = venueOfCoin(plan.coin);
          if (pdex) out.collateralSwept = await sweepVenue(pdex);
          return out;
        }
        /* The position is gone: its reduce-only triggers must not outlive it. */
        const after = await readPositions(plan.coin);
        if (!after.ok) { out.cleanup = { cancelled: [], failed: [], skipped: "state_unknown" }; return out; }
        if (after.position) { out.cleanup = { cancelled: [], failed: [], skipped: "still_open" }; return out; }
        const oo = await readOpenOrders(plan.coin);
        if (!oo.ok) { out.cleanup = { cancelled: [], failed: [], skipped: "state_unknown" }; return out; }
        const left = classifyTpSlOrders(oo.list, plan.coin);
        const c = await cancelOids(plan.asset, [...left.tp, ...left.sl].map((o) => o.oid));
        out.cleanup = { cancelled: c.cancelled, failed: c.failed };
        /* THE MONEY COMES HOME. A venue's pot is now idle collateral, and the way
           out of the Perp account leaves the MAIN dex — so anything left behind
           would be money the Withdraw sheet could not reach. Swept LAST, after the
           triggers are cancelled, so the figure it reads is what is really free.
           Hyperliquid's own withdrawable is that figure. */
        const dex = venueOfCoin(plan.coin);
        if (dex) out.collateralSwept = await sweepVenue(dex);
        return out;
      });
    },

    /**
     * Set, move or remove the position's TP / SL. For each leg: undefined =
     * leave it, null = remove it, a price = place it (new first, old cancelled after).
     */
    setTpSl(coin, { tp, sl } = {}) {
      return withKey(coin, async () => {
        const m = lookupMarket(coin);
        if (!m) return fail("market_unknown", MSG.market);
        const pos = await readPositions(m.coin);
        if (!pos.ok) return fail("state_unknown", MSG.stateUnknown);
        if (!pos.position) return fail("no_position", "You have no open position in this market.");
        const oo = await readOpenOrders(m.coin);
        if (!oo.ok) return fail("state_unknown", MSG.stateUnknown);
        const move = planTpSlMove({ market: m, position: pos.position, openOrders: oo.list, tp, sl, builder: builderCfg, cloids: { tp: newCloid(), sl: newCloid() } });
        if (!move.ok) return move;
        const req = (v) => (v === undefined ? false : v === null ? "remove" : "set");
        return runMove(move, { requested: { tp: req(tp), sl: req(sl) } });
      });
    },

    /** Cancel open orders of a market by oid. */
    cancelOrders(coin, oids) {
      const gate = tradeGate();
      if (gate && !(autoEnable && gate.needsEnable === true)) return Promise.resolve(gate);
      const m = lookupMarket(coin);
      if (!m || !Number.isSafeInteger(m.assetIndex)) return Promise.resolve(fail("market_unknown", MSG.market));
      const list = Array.isArray(oids) ? oids : [oids];
      if (!list.length || !list.every((o) => Number.isSafeInteger(o) && o >= 0)) return Promise.resolve(fail("bad_input", "Pick an order to cancel."));
      return withKey(coin, async () => {
        const c = await cancelOids(m.assetIndex, list);
        if (c.error && !c.cancelled.length) return c.error.lost ? fail("network", "Couldn't reach Hyperliquid. Check your orders.") : c.error;
        return { ok: c.failed.length === 0, code: c.failed.length ? "cancel_failed" : undefined, message: c.failed.length ? "Some orders couldn't be cancelled. Try again." : undefined, cancelled: c.cancelled, failed: c.failed };
      });
    },

    /**
     * Withdraw USDC through Hyperliquid's own bridge: Arbitrum One, a $1 fee,
     * about 5 minutes. One wallet prompt, always visible.
     *
     * THE DESTINATION IS EXPLICIT (owner, 2026-09-22: "withdraw คือให้ใส่ เลข
     * Wallet ได้ด้วยดิวะ"). It is the address the user confirmed on the screen
     * before this was called, which the customer typed or pasted there. There
     * is no default here: a withdrawal with no destination is refused rather
     * than quietly sent to the connected wallet, because "quietly" is how money
     * ends up somewhere nobody chose.
     * @param {string|number} amountUsdc
     * @param {{ destination: string }} o the address the confirm screen showed
     */
    async withdraw(amountUsdc, { destination } = {}) {
      if (!support.ok) return support;
      const amount = formatUsdcAmount(amountUsdc);
      if (amount == null) return fail("bad_input", "Enter a USDC amount, with at most 6 decimals.");
      if (!(Number(amount) > HL_WITHDRAW_FEE_USDC)) {
        return fail("withdraw_too_small", `A withdrawal must be more than the $${HL_WITHDRAW_FEE_USDC} fee Hyperliquid charges.`);
      }
      if (destination === undefined || destination === null || destination === "") return fail("no_destination", MSG.noDestination);
      const to = readDestinationAddress(destination);
      if (!to.ok) return fail(to.code, to.message);
      const g = await masterGate();
      if (g.err) return g.err;
      await readPositions(null);
      const time = await nonces.next(masterLc);
      const action = buildWithdrawAction({ profile, signatureChainId: g.sigChain, destination: to.lower, amount, time });
      note("withdraw3.start", { amount, own: to.lower === masterLc, signatureChainId: g.sigChain });
      const r = await sendMaster(action);
      if (!r.ok) return r;
      return { ok: true, ...withdrawQuote(amount), destination: to.address };
    },

    /**
     * STEP 1 of a Relay withdrawal: sign Relay's own authorize message, which
     * ties the deposit below to this order. A VISIBLE prompt (money is moving),
     * with the typed data exactly as the quote gave it — relayOut.js has
     * already refused anything that names another wallet.
     *
     * Nothing is sent anywhere by this call: the caller posts the signature to
     * the endpoint the step names, which is Relay's, not Hyperliquid's.
     * @param {object} step the quote's authorize step
     * @returns {Promise<{ ok: true, signature: string, post: object }|object>}
     */
    async signRelayAuthorize(step) {
      if (!support.ok) return support;
      const read = readRelayAuthorizeStep(step, { master: masterLc });
      if (!read.ok) return read;
      const g = await masterGate();
      if (g.err) return g.err;
      const started = now();
      note("relay.authorize.start", { primaryType: read.typedData.primaryType, endpoint: read.post.endpoint });
      let signed;
      try {
        signed = await signTypedDataVisibly({ signer, typedData: read.typedData, timeoutMs: walletTimeoutMs, timers });
      } catch (e) {
        const f = signFailure(e);
        note("relay.authorize.failed", { code: f.code, name: e && e.name, ms: now() - started });
        return f;
      }
      if (lower(signed.address) !== masterLc) return fail("wallet_mismatch", MSG.mismatch);
      note("relay.authorize.done", { ms: now() - started });
      return { ok: true, signature: signed.signature, post: read.post };
    },

    /**
     * STEP 2 of a Relay withdrawal: the Hyperliquid sendAsset that moves the
     * user's Perp USDC to Relay's depository, signed VISIBLY by the user's own
     * wallet (never the trading key, never the no-window signer) and posted to
     * Hyperliquid once.
     *
     * Every field comes from the quote step, and relayOut.js has checked each
     * one against what the user asked for — including that the amount is the
     * amount they typed. A LOST reply is "Not confirmed": it is never re-sent,
     * because the money may already be on its way.
     *
     * OWN MOVES (the Main Account → the user's own Avax Wallet, src/avax/signers.js)
     * pass their pins, `ownMove: { depository, maxDebitUsdc }`: the transfer must
     * then go to that PINNED HyperCore depository and take no more than
     * maxDebitUsdc (relayOut.js). With no `ownMove` — today's Withdraw — nothing
     * about this call changes.
     * @param {{ step: object, amountUsdc: string|number, ownMove?: { depository: string, maxDebitUsdc: number }|null }} o
     */
    async sendRelayDeposit({ step, amountUsdc, ownMove = null } = {}) {
      if (!support.ok) return support;
      const read = readRelayDepositStep(step, { profile, amountUsdc, master: masterLc, now: nonces.serverNow(), ownMove });
      if (!read.ok) return read;
      const g = await masterGate();
      if (g.err) return g.err;
      const action = buildSendAssetAction({ profile, signatureChainId: g.sigChain, ...read.fields });
      note("relay.deposit.start", { amount: read.fields.amount, nonce: read.nonce, signatureChainId: g.sigChain });
      const r = await sendMaster(action);
      if (!r.ok) {
        if (r.lost === true) {
          return fail("not_confirmed", "Hyperliquid didn't confirm this withdrawal. Check your Perp balance before trying again: it was NOT sent twice.", { lost: true, retry: false });
        }
        return r;
      }
      return { ok: true, amountUsdc: read.fields.amount, nonce: read.nonce, check: read.check };
    },

    /**
     * A PRIVATE withdrawal's one money step: the Hyperliquid sendAsset that
     * moves exactly the quoted amount of the user's Perp USDC to the one-time
     * deposit address the VERIFIED quote names (lib/intents/withdraw.js).
     * intentsOut.js is the gate: it refuses anything but that quote's own
     * address, amount and token, with a fresh preflight, for this wallet. Signed
     * VISIBLY by the user's own wallet (never the trading key, never the
     * no-window signer: sendAsset is not on that list, and intentsOut refuses to
     * build if it ever were), posted to Hyperliquid ONCE.
     *
     * A LOST reply is "not confirmed", retry:false: the money may be on its way,
     * so it is never re-sent (executeIntentsWithdraw records it "unknown", and
     * the status follow-up settles it by reads). Every other refusal comes back
     * with this client's own code, unchanged.
     * @param {{ quote: object, preflight: object, amountUsdc?: string|number|null }} o
     *   amountUsdc: what the customer typed (the gate checks it against the quote again)
     */
    async sendIntentsDeposit({ quote, preflight, amountUsdc } = {}) {
      if (!support.ok) return support;
      const g = await masterGate();
      if (g.err) return g.err;
      const nonce = await nonces.next(masterLc);
      /* Two clocks: the quote and preflight were stamped by this browser's clock, the nonce lives on Hyperliquid's. */
      const built = buildIntentsSendAsset({
        quote, preflight, profile, signatureChainId: g.sigChain, nonce, master: masterLc, amountUsdc, now: now(), serverNow: nonces.serverNow(),
      });
      if (!built.ok) return built;
      note("intents.deposit.start", { amount: built.fields.amount, nonce, signatureChainId: g.sigChain });
      const r = await sendMaster(built.action);
      if (!r.ok) {
        if (r.lost === true) {
          return fail("not_confirmed", "Your withdrawal wasn't confirmed. Check your Perp balance before trying again: it was NOT sent twice.", { lost: true, retry: false });
        }
        return r;
      }
      return { ok: true, amountUsdc: built.fields.amount, nonce };
    },
  };

  async function doEnable() {
    const startedAt = now();
    note("enable.start", { wallet: walletType, auto: autoEnable, chainId, state: agents.status(masterLc).state });
    const done = (r) => {
      note("enable.end", { ok: r && r.ok === true, code: r && r.code, already: r && r.already === true, signatures: r && r.signatures, ms: now() - startedAt });
      return r;
    };
    if (!support.ok) return done(support);
    if (builderCfg.invalid) {
      return done(fail("builder_config_invalid", "The builder fee setting is incomplete: set both the builder address and the fee, or leave both empty."));
    }
    const g = await masterGate();
    if (g.err) return done(g.err);
    note("enable.gate", { signatureChainId: g.sigChain });
    /* Hyperliquid's clock, so valid_until and the nonce are right on a device
       whose clock is off. Best effort: the local clock is used if this fails. */
    await readPositions(null);
    /* A key that is live for a while yet (another tab enabled it, a double
       click) is kept: no prompt. In its last hour it is renewed instead. */
    const current = agents.status(masterLc);
    if (current.state === "active" && current.validUntil - nonces.serverNow() > HL_RENEW_BEFORE_MS) {
      return done({ ok: true, already: true, agentAddress: current.address, validUntil: current.validUntil, signatures: 0, builderApproved: null, persisted: current.persisted });
    }
    let needBuilder = false;
    if (builderCfg.enabled) {
      const r = await readInfo({ type: "maxBuilderFee", user: masterLc, builder: builderCfg.b });
      const approved = r.ok ? Number(r.json) : NaN;
      needBuilder = !(Number.isFinite(approved) && approved >= builderCfg.f);
    }
    let rec;
    try {
      rec = agents.prepare(masterLc, { at: nonces.serverNow() });
    } catch (e) {
      return done(fail("agent_key_failed", `Couldn't make a trading key on this device: ${errorText(e)}`));
    }
    let signatures = 0;
    const agentAction = buildApproveAgentAction({
      profile, signatureChainId: g.sigChain, agentAddress: rec.address, agentName: rec.agentName, nonce: await nonces.next(masterLc),
    });
    const a = await sendMaster(agentAction, { quiet: true });
    if (!a.ok) {
      agents.discardPending(masterLc, rec.address);
      return done(a);
    }
    signatures++;
    if (needBuilder) {
      const b = await sendMaster(buildApproveBuilderFeeAction({
        profile, signatureChainId: g.sigChain, builder: builderCfg.b, maxFeeRate: builderCfg.maxFeeRate, nonce: await nonces.next(masterLc),
      }), { quiet: true });
      if (!b.ok) {
        agents.discardPending(masterLc, rec.address);
        return done({ ...b, step: "builder_fee" });
      }
      signatures++;
    }
    /* Another tab may have started its own Enable trading meanwhile and replaced
       this pending key; the stored record is then that tab's, not ours. */
    if (!agents.markApproved(masterLc, rec.address)) {
      return done(fail("superseded", "Trading was enabled again from another tab or window at the same time. Try again here if trading is still off."));
    }
    return done({
      ok: true, agentAddress: rec.address, validUntil: rec.validUntil, signatures,
      builderApproved: builderCfg.enabled ? true : null, persisted: rec.persisted,
    });
  }

  return Object.freeze(trader);
}
