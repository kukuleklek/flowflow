// ─────────────────────────────────────────────────────────────────────────────
// THE AVAX WALLET'S LIMITS (plan v2 §2.9): one table, read from where they live.
// PURE: the env is a parameter (the browser's import.meta.env by default).
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
// Privy เลย". The money layer already holds every one of these as a constant
// beside the code that enforces it (lib/avax/gas.js, lib/relay/moveIn.js,
// moveOut.js, swap.js, avax/flows.js, lib/avax/aaveTx.js). This file does NOT
// keep a second copy: it re-exports them, and resolveLimits() is the one place
// an env value may LOWER one.
//
// WHY NOT perp/guardrails.js. That file is the trade's and the Agent's caps, and
// it has NO IMPORTS on purpose (the Agent's attack suite evaluates a copy of it
// with an injected env), so the Avax table — which reads five money modules —
// lives here, beside the signers that enforce it.
//
// 🔴 ENV MAY LOWER, NEVER RAISE. Every cap below is min(env, HARD); an unset,
// empty or unreadable env value is the HARD value itself — never 0, never "no
// limit" (ATK-02 / ATK-13b: Math.min(NaN, 20) is NaN, and `x > NaN` is false for
// every x). 0 (or less) turns that action off. The EXITS (unstake, the move back
// to the Main Account, a swap back to USDC) have no cap here and no flag: a cap
// on the way out would trap money (src/avax/closedTx.js rule 5).

import { GAS_LIMITS, EXIT_RESERVE_WEI, SWAP_BACK_RESERVE_WEI, MAX_FEE_GWEI_NON_EXIT, TOPUP_USD } from "../lib/avax/gas.js";
import { HARD_MAX_MOVE_USDC, MIN_MOVE_IN_USDC, resolveMoveCapUsdc, stakeFeeCeiling, maxDebitUsdc } from "../lib/relay/moveIn.js";
import { MIN_MOVE_OUT_USDC, PERMIT_MAX_VALID_S } from "../lib/relay/moveOut.js";
import { SWAP_LIMITS, swapLossCapPct } from "../lib/relay/swap.js";
import { MONEY_CARD_TTL_MS } from "./flows.js";

export {
  GAS_LIMITS, EXIT_RESERVE_WEI, SWAP_BACK_RESERVE_WEI, MAX_FEE_GWEI_NON_EXIT, TOPUP_USD,
  HARD_MAX_MOVE_USDC, MIN_MOVE_IN_USDC, MIN_MOVE_OUT_USDC, PERMIT_MAX_VALID_S, SWAP_LIMITS, MONEY_CARD_TTL_MS,
  stakeFeeCeiling, maxDebitUsdc,
};

/* Vite's env in the browser; nothing (the hard caps) under Node. */
const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};

/** A stake from the Main Account starts at 5 USDC (plan §2.9 MIN_STAKE_FROM_PERP_USDC). */
export const MIN_STAKE_FROM_PERP_USDC = 5;

/**
 * The Avax Wallet's hard ceilings (plan §2.9 HARD). stakeUsdc is aaveTx's
 * AAVE_SUPPLY_HARD_CAP_RAW in whole USDC — if one changes, both change
 * (scripts/test-avax-signers.mjs holds them equal). moveUsdc bounds what LEAVES
 * the Main Account per move (the debit, fees and gas included), swapUsd one
 * swap's size. Margin and leverage are perp/guardrails.js's.
 */
export const HARD = Object.freeze({
  stakeUsdc: 20,
  moveUsdc: HARD_MAX_MOVE_USDC,
  swapUsd: SWAP_LIMITS.maxUsd,
});

/*
 * One env value, clamped DOWN to `hard`: unset / blank / unreadable → hard;
 * ≤ 0 → 0 (off); otherwise min(n, hard). moveIn.js resolveMoveCapUsdc's rule,
 * for every other cap.
 */
function lowerOnly(raw, hard) {
  if (raw == null || (typeof raw === "string" && !raw.trim())) return hard;
  const n = typeof raw === "number" ? raw
    : typeof raw === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return hard;
  return n <= 0 ? 0 : Math.min(n, hard);
}

/* A slippage in basis points, lowered only: a positive whole number under the hard one, else the hard one. */
function lowerBps(raw, hard) {
  const n = lowerOnly(raw, hard);
  return Number.isInteger(n) && n > 0 ? n : hard;
}

/**
 * Every Avax Wallet limit, from an env object (the browser's import.meta.env,
 * or process.env on the server — the names are the same). Frozen; numbers only;
 * nothing here is ever above HARD.
 *   VITE_MAX_STAKE_USDC · VITE_MAX_MOVE_USDC · VITE_MAX_SWAP_USD · VITE_SWAP_MAX_LOSS_PCT · VITE_SWAP_SLIPPAGE_BPS
 */
export function resolveLimits(env = ENV) {
  const e = env && typeof env === "object" ? env : {};
  const slippage = lowerBps(e.VITE_SWAP_SLIPPAGE_BPS, SWAP_LIMITS.slippageBps);
  return Object.freeze({
    stakeUsdc: lowerOnly(e.VITE_MAX_STAKE_USDC, HARD.stakeUsdc),
    moveUsdc: resolveMoveCapUsdc(e.VITE_MAX_MOVE_USDC),
    swapUsd: lowerOnly(e.VITE_MAX_SWAP_USD, HARD.swapUsd),
    swapMaxLossPct: swapLossCapPct(e.VITE_SWAP_MAX_LOSS_PCT),
    swapSlippageBps: slippage,
    swapStableSlippageBps: Math.min(slippage, SWAP_LIMITS.stableSlippageBps),
    minMoveInUsdc: MIN_MOVE_IN_USDC,
    minMoveOutUsdc: MIN_MOVE_OUT_USDC,
    minSwapUsd: SWAP_LIMITS.minUsd,
    minStakeFromPerpUsdc: MIN_STAKE_FROM_PERP_USDC,
    quoteTtlMs: SWAP_LIMITS.quoteTtlMs,
    permitMaxValidS: PERMIT_MAX_VALID_S,
    moneyCardTtlMs: MONEY_CARD_TTL_MS,
    maxFeeGweiNonExit: Number(MAX_FEE_GWEI_NON_EXIT),
  });
}
