// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE MODE (Normal | Private): the constants every intents file shares.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน". The toggle is "Normal | Private";
// real ZK is a later phase. Private deposits and withdrawals go through a
// one-time deposit address quoted by the 1Click API (base below). What that
// buys, measured (scratchpad plan-private/R-near.md, R-fit.md):
//
//   • keyless ("public") quotes hide NOTHING: the public explorer and GET
//     /v0/status show sender → deposit address → recipient. The screen must say
//     "Preview · not private yet" in that mode, never "Private".
//   • confidential quotes ("basic" | "advanced") need an invite-only partner key
//     (NEAR_INTENTS_JWT, server env, never VITE_). Without it the API answers 401.
//
// 🔴 THE RULES EVERY FILE IN THIS FOLDER KEEPS
//
//   1. Nothing here signs or sends. Builders return unsigned bodies; verifiers
//      check answers. The silent-signing allow-list (PrivyBridge.jsx, master.js)
//      is not touched and nothing here is imported by it.
//   2. A DEPOSIT is quoted with recipient = refundTo = the connected wallet, and
//      that is re-verified from the quote's ECHO, not from the body we sent.
//   3. A WITHDRAWAL's recipient is only what the customer typed; refundTo is
//      their own account.
//   4. Unknown is null, never 0. An address that cannot be shown to pay the
//      customer is never shown.
//   5. The partner key lives on the server (api/intents-*.js) and nowhere else.
//   6. The server's kill switch (PRIVATE_MODE !== "on") stops every new quote.
//
// Nothing here runs at import time and nothing reads the env: the server reads
// its own env in lib/intents/guard.js.

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The 1Click API (verified live 2026-10-15: GET /tokens, POST /quote, GET /status). */
export const INTENTS_API = "https://1click.chaindefuser.com/v0";
export const INTENTS_QUOTE_UPSTREAM = `${INTENTS_API}/quote`;
export const INTENTS_STATUS_UPSTREAM = `${INTENTS_API}/status`;
export const INTENTS_TOKENS_URL = `${INTENTS_API}/tokens`;

/* A page asks our own proxies (the key, the kill switch, the caps and the
   sanctions screen live there); Node — the tests and scripts, where there is no
   page and no key — asks the API directly, exactly like RELAY_QUOTE_URL. */
const IN_BROWSER = typeof window !== "undefined";
export const INTENTS_QUOTE_PROXY = "/api/intents-quote";
export const INTENTS_STATUS_PROXY = "/api/intents-status";
export const INTENTS_QUOTE_URL = IN_BROWSER ? INTENTS_QUOTE_PROXY : INTENTS_QUOTE_UPSTREAM;
export const INTENTS_STATUS_URL = IN_BROWSER ? INTENTS_STATUS_PROXY : INTENTS_STATUS_UPSTREAM;
/** GET → { enabled, confidential, confidentiality, limits } (503 private_mode_off when the switch is off). */
export const INTENTS_PROBE_URL = `${INTENTS_QUOTE_PROXY}?probe=1`;

/** The deposit watch's provider names (perp/deposit/depositWatch.js). A missing one is "relay". */
export const PROVIDER_RELAY = "relay";
export const PROVIDER_NEAR = "near";

/** The two private deposit plans (lib/intents/deposit.js owns them; the ids live here so the watch can read them light). */
export const PRIVATE_CORE_PLAN_ID = "private-core";
export const PRIVATE_ARB_PLAN_ID = "private-arb";

/** The server's switch: anything but exactly "on" is off. */
export const PRIVATE_MODE_ON = "on";

/** The API's own confidentiality values. "public" is NOT private (see the top of this file). */
export const CONFIDENTIALITY = Object.freeze(["public", "basic", "advanced"]);
export const CONFIDENTIAL_LEVELS = Object.freeze(["basic", "advanced"]);
export const DEFAULT_CONFIDENTIAL_LEVEL = "basic";

/* ── amounts the owner set (plan §6.8, §7.3, Q6) ─────────────────────────────
   Hackathon, mainnet, real money. The proxy enforces these and the screens
   should too; server env may LOWER the caps, never raise them (guard.js). */
export const PRIVATE_LIMITS = Object.freeze({
  /** Smallest private deposit (so private-arb still lands ≥ 5 USDC after fees). */
  depositMinUsdc: 10,
  /** Smallest private withdrawal (its fees are ~1.2 USDC). */
  withdrawMinUsdc: 5,
  /** Largest single private move. */
  maxTxUsdc: 500,
  /** Most a wallet may move privately per UTC day (deposits and withdrawals together). */
  maxDayUsdc: 1000,
});

/**
 * The limits a caller (a probe answer, a screen) hands in, held to the owner's:
 * a cap can only be LOWERED and a minimum only RAISED. Anything unreadable is
 * the owner's own figure. Never throws.
 */
export function clampPrivateLimits(limits) {
  const l = limits && typeof limits === "object" ? limits : {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const raise = (k) => (num(l[k]) != null && l[k] > PRIVATE_LIMITS[k] ? l[k] : PRIVATE_LIMITS[k]);
  const lower = (k) => (num(l[k]) != null && l[k] < PRIVATE_LIMITS[k] ? l[k] : PRIVATE_LIMITS[k]);
  return Object.freeze({
    depositMinUsdc: raise("depositMinUsdc"),
    withdrawMinUsdc: raise("withdrawMinUsdc"),
    maxTxUsdc: lower("maxTxUsdc"),
    maxDayUsdc: lower("maxDayUsdc"),
  });
}

/* ── the quote we ask for ────────────────────────────────────────────────────── */
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 300;
/** The deadline we ask for. A live non-dry answer came back with +72 h regardless (R-fit §2). */
export const QUOTE_DEADLINE_MS = HOUR;
/** The proxy refuses an asked deadline further out than this, or nearer than a minute. */
export const MAX_ASKED_DEADLINE_MS = DAY;
export const MIN_ASKED_DEADLINE_MS = MINUTE;
/** An answer whose deadline is further out than this is not one we understand. */
export const MAX_ANSWER_DEADLINE_MS = 31 * DAY;
/** An address is hidden this long before it goes inactive (plan §6.5) — or half its life, if that is shorter. */
export const HIDE_BEFORE_INACTIVE_MS = 6 * HOUR;
/** An address with less than this left to show is never shown at all. */
export const MIN_SHOW_MS = 10 * MINUTE;
export const QUOTE_TIMEOUT_MS = 20000;
/** The token list is re-read after this long. */
export const TOKENS_TTL_MS = 30 * MINUTE;

/* ── fees we did not ask for ─────────────────────────────────────────────────
   Our bodies NEVER carry appFees (the proxy refuses them). A keyless answer can
   still ECHO one: the API injects its own platform fee, measured 2026-10-15 on a
   Base USDC → perps dry quote as { recipient: "5880ad2b…47dd", fee: 1 } (1 bp),
   and the docs say up to 25 bps without a key. So an echoed fee is allowed only
   to this account and only up to that total; anything else refuses the quote. */
export const INTENTS_PLATFORM_FEE_ACCOUNTS = Object.freeze([
  "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd",
]);
export const MAX_PLATFORM_FEE_BPS = 25;

/* ── what a quote may lose ───────────────────────────────────────────────────
   Measured on 20 USDC: ~0.32 into perps (a flat 0.3153 withdraw fee), ~0.005
   into Arbitrum. A quote that loses more than this flat part plus 1 % of the
   amount is not one these routes produce, and is refused rather than shown. */
export const MAX_LOSS_FLAT_USDC = 0.5;
export const MAX_LOSS_SHARE = 0.01;

/* ── what a quote may GUARANTEE ──────────────────────────────────────────────
   minAmountOut is the only figure the service promises. It may sit below
   amountOut by the slippage we asked for (echoed, 100 bps) applied to the
   amount that goes in, plus this small tolerance, and no further. Every live
   answer (2026-10-15) sat at 99.0 % of amountOut, the worst at 98.968 %
   (10 USDC into perps: the flat withdraw fee is inside the slipped amount),
   i.e. within 1.0 % of the amount in. */
export const MIN_OUT_TOLERANCE_BPS = 10;

/** Addresses no one-time deposit address may ever be: money sent there cannot be refunded (EVM, lower case). */
export const NEVER_A_DEPOSIT_ADDRESS = Object.freeze([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

/** Where a one-time address is kept between opens of the sheet (own prefix: never the Relay cache's). */
export const PRIVATE_DEPOSIT_PREFIX = "flowflow.privateDeposit.v1:";

/* ── the four chains (owner, 2026-10-15: "เอา ARB, Avax, Base, Polygon พอแระ") ──
   A refund goes back to refundTo on the ORIGIN chain, the customer's own EOA:
     Arbitrum   the auto-mover hops it into the Main Account by itself
     Avalanche  it is the Spot Account (the same EOA), which the app shows
     Base, Polygon  it sits there with no gas: only the gasless Recover path
                (lib/relay/recoverStranded.js) brings it back
   🔴 ONE SWITCH. Until Recover can SIGN, Base and Polygon are not offered as
   private origins: no refund may strand where the app has no way back. It can
   now: PrivyBridge provides a VISIBLE typed-data signer on 8453 / 137 (its shown
   hook, behind the closed builder lib/relay/recoverClosed.js; tests
   test-perp-silent-enable B10–B11 / G1c and test-private-recover R11–R13), so
   this is on (assets.js privateDepositRoutesOffered reads it, and the Recover
   rows draw on Normal, Private and the switched-off screen). */
export const PRIVATE_RECOVER_READY = true;
