// ─────────────────────────────────────────────────────────────────────────────
// Aave V3 on Avalanche, USDC reserve: the reads, the rate maths and the plain
// reasons a supply or a withdrawal cannot go ahead. Pure — no network here
// (lib/avax/read.js does the reading, lib/avax/aaveTx.js builds the calls).
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ใช้ Aave V3 USDC บน Avalanche (5.70%)".
//
// FACTS (R-aave.md §4–§6, re-read live 2026-10-15):
//   • Pool.getReserveData(USDC) returns the 15-word ReserveDataLegacy struct.
//     currentLiquidityRate (word 2) is an ANNUAL rate in ray (1e27), not a
//     per-second one. APR = rate / 1e27; APY = (1 + APR / 31,536,000)^31,536,000 − 1
//     (Aave's own UI formula). 55,436,384,346,105,595,948,372,485 → 5.5436% APR
//     → 5.7002% APY.
//   • configuration (word 0) bits: 56 active, 57 frozen, 60 paused,
//     116–151 supply cap in WHOLE tokens (0 = no cap).
//   • POOL_REVISION 11: reverts are CUSTOM errors (InvalidAmount() 0x2c5211c6,
//     NotEnoughAvailableUserBalance() 0x47bc4b2c … read live from eth_call),
//     and free liquidity is Pool.getVirtualUnderlyingBalance(USDC) (virtual
//     accounting), not the aToken's USDC balance.
//   • A frozen reserve takes no new supply but still pays withdrawals; a paused
//     one does neither.
//
// 🔴 Unknown is null, never 0. Every function here answers null (or a "still
// loading" problem) when an input it needs is unknown.

import { AAVE_V3, USDC, USDC_DECIMALS } from "../config.js";
import { addressWord, strip0x, wordAt, wordToUint, wordToAddress, decodeRevert, AbiError } from "../abi.js";
import { sameAddress } from "../../relay/depositAddress.js";

export const RAY = 10n ** 27n;
export const SECONDS_PER_YEAR = 31536000;

/* Selectors (keccak of the signature, recomputed in the tests). */
export const SEL = Object.freeze({
  getReserveData: "0x35ea6a75",               // getReserveData(address)
  getVirtualUnderlyingBalance: "0x6fb07f96",  // getVirtualUnderlyingBalance(address)
  balanceOf: "0x70a08231",                    // balanceOf(address)
  totalSupply: "0x18160ddd",                  // totalSupply()
  allowance: "0xdd62ed3e",                    // allowance(address,address)
  approve: "0x095ea7b3",                      // approve(address,uint256)
  supply: "0x617ba037",                       // supply(address,uint256,address,uint16)
  withdraw: "0x69328dec",                     // withdraw(address,uint256,address)
});

/* ── read calls ({to, data}) ──────────────────────────────────────────────── */

export const reserveDataCall = () => ({ to: AAVE_V3.pool, data: `${SEL.getReserveData}${addressWord(USDC)}` });
export const virtualBalanceCall = () => ({ to: AAVE_V3.pool, data: `${SEL.getVirtualUnderlyingBalance}${addressWord(USDC)}` });
export const aTokenTotalSupplyCall = () => ({ to: AAVE_V3.aUsdc, data: SEL.totalSupply });
export const aTokenBalanceCall = (owner) => ({ to: AAVE_V3.aUsdc, data: `${SEL.balanceOf}${addressWord(owner)}` });
export const usdcPoolAllowanceCall = (owner) => ({ to: USDC, data: `${SEL.allowance}${addressWord(owner)}${addressWord(AAVE_V3.pool)}` });

/* ── decoding ─────────────────────────────────────────────────────────────── */

const RESERVE_WORDS = 15;

/**
 * Pool.getReserveData(USDC) return data → the struct. Throws AbiError unless it
 * is exactly 15 words AND its aToken is the pinned aAvaUSDC (a reserve that
 * points anywhere else is not the one this app may touch).
 */
export function decodeReserveData(hex) {
  const body = strip0x(hex);
  if (body.length !== RESERVE_WORDS * 64) throw new AbiError("Not Aave reserve data", { bytes: body.length / 2 });
  const u = (i) => wordToUint(wordAt(body, i));
  const a = (i) => wordToAddress(wordAt(body, i));
  const r = {
    configuration: u(0),
    liquidityIndex: u(1),
    currentLiquidityRate: u(2),
    variableBorrowIndex: u(3),
    currentVariableBorrowRate: u(4),
    currentStableBorrowRate: u(5),
    lastUpdateTimestamp: u(6),
    id: u(7),
    aTokenAddress: a(8),
    stableDebtTokenAddress: a(9),
    variableDebtTokenAddress: a(10),
    interestRateStrategyAddress: a(11),
    accruedToTreasury: u(12),
    unbacked: u(13),
    isolationModeTotalDebt: u(14),
  };
  if (!sameAddress(r.aTokenAddress, AAVE_V3.aUsdc)) {
    throw new AbiError("The reserve's aToken is not aAvaUSDC", { aToken: r.aTokenAddress });
  }
  return Object.freeze(r);
}

const bits = (n, from, len) => (n >> BigInt(from)) & ((1n << BigInt(len)) - 1n);

/** The configuration bitmap → the flags and caps the app reads. */
export function decodeReserveConfig(configuration) {
  if (typeof configuration !== "bigint") throw new AbiError("No configuration");
  return Object.freeze({
    ltvBps: Number(bits(configuration, 0, 16)),
    liquidationThresholdBps: Number(bits(configuration, 16, 16)),
    decimals: Number(bits(configuration, 48, 8)),
    active: bits(configuration, 56, 1) === 1n,
    frozen: bits(configuration, 57, 1) === 1n,
    borrowingEnabled: bits(configuration, 58, 1) === 1n,
    paused: bits(configuration, 60, 1) === 1n,
    reserveFactorBps: Number(bits(configuration, 64, 16)),
    borrowCap: bits(configuration, 80, 36),
    /** Whole tokens; 0n = no cap. */
    supplyCap: bits(configuration, 116, 36),
  });
}

/* ── rates ────────────────────────────────────────────────────────────────── */

/** Annual rate in ray → APR as a fraction (0.055436…). null for unknown. */
export function aprFromRay(rateRay) {
  if (typeof rateRay !== "bigint" || rateRay < 0n) return null;
  /* Split so the float sees at most ~1e9 × precision: exact to ~1e-18. */
  const whole = rateRay / 10n ** 9n;
  return Number(whole) / 1e18;
}

/** APR fraction → APY fraction with per-second compounding (Aave's UI formula). */
export function apyFromApr(apr) {
  if (typeof apr !== "number" || !Number.isFinite(apr) || apr < 0) return null;
  return Math.expm1(SECONDS_PER_YEAR * Math.log1p(apr / SECONDS_PER_YEAR));
}

/** currentLiquidityRate (ray) → supply APY in percent (5.7002…). null for unknown. */
export function supplyApyPct(rateRay) {
  const apr = aprFromRay(rateRay);
  const apy = apr == null ? null : apyFromApr(apr);
  return apy == null ? null : apy * 100;
}

/* ── the reserve as the card needs it ─────────────────────────────────────── */

/**
 * @param {object} p
 * @param {object|null} p.reserve            decodeReserveData() or null
 * @param {bigint|null} p.aTokenTotalSupplyRaw  aAvaUSDC.totalSupply() or null
 * @param {bigint|null} p.virtualBalanceRaw     Pool.getVirtualUnderlyingBalance(USDC) or null
 * @returns {object|null}  null when the reserve itself is unknown
 */
export function reserveStatus({ reserve = null, aTokenTotalSupplyRaw = null, virtualBalanceRaw = null } = {}) {
  if (!reserve) return null;
  const cfg = decodeReserveConfig(reserve.configuration);
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const capRaw = cfg.supplyCap > 0n ? cfg.supplyCap * unit : null;
  /* What Aave's own cap check counts: supplied + interest owed to the treasury. */
  const suppliedRaw = typeof aTokenTotalSupplyRaw === "bigint"
    ? aTokenTotalSupplyRaw + (reserve.accruedToTreasury * reserve.liquidityIndex) / RAY
    : null;
  let capRoomRaw = null;
  if (cfg.supplyCap === 0n) capRoomRaw = null; // no cap: room is not a number
  else if (suppliedRaw != null) capRoomRaw = capRaw > suppliedRaw ? capRaw - suppliedRaw : 0n;
  const apr = aprFromRay(reserve.currentLiquidityRate);
  const apy = apr == null ? null : apyFromApr(apr);
  return Object.freeze({
    aprPct: apr == null ? null : apr * 100,
    apyPct: apy == null ? null : apy * 100,
    active: cfg.active,
    frozen: cfg.frozen,
    paused: cfg.paused,
    uncapped: cfg.supplyCap === 0n,
    supplyCapRaw: capRaw,
    suppliedRaw,
    capRoomRaw,
    liquidityRaw: typeof virtualBalanceRaw === "bigint" ? virtualBalanceRaw : null,
    reserveFactorBps: cfg.reserveFactorBps,
    lastUpdateTimestamp: Number(reserve.lastUpdateTimestamp),
  });
}

/* ── why not (D2: a plain reason, never a dead button) ────────────────────── */

export const AAVE_WHY = Object.freeze({
  loading: "Still loading",
  badAmount: "Enter an amount",
  inactive: "Aave USDC is not open right now",
  paused: "Aave USDC is paused right now",
  frozen: "Aave USDC takes no new deposits right now",
  full: "Aave USDC is full right now",
  noUsdc: "Not enough USDC in your Avax Wallet",
  nothing: "Nothing in Aave yet",
  overPosition: "More than you have in Aave",
  noLiquidity: "Aave has no free liquidity right now",
});

const problem = (code) => ({ code, text: AAVE_WHY[code] });

/** Cap headroom kept free for interest that accrues between the read and the block. */
const CAP_SLACK_BPS = 10n; // 0.1%

/**
 * Can `amountRaw` USDC be supplied now? null = yes; otherwise {code, text}.
 * `walletUsdcRaw` is the Avax Wallet's USDC (null = unknown → loading).
 */
export function supplyProblem({ status, amountRaw, walletUsdcRaw }) {
  if (typeof amountRaw !== "bigint" || amountRaw <= 0n) return problem("badAmount");
  if (!status) return problem("loading");
  if (!status.active) return problem("inactive");
  if (status.paused) return problem("paused");
  if (status.frozen) return problem("frozen");
  if (!status.uncapped) {
    if (status.capRoomRaw == null) return problem("loading");
    if (amountRaw > status.capRoomRaw - (status.capRoomRaw * CAP_SLACK_BPS) / 10000n) return problem("full");
  }
  if (typeof walletUsdcRaw !== "bigint") return problem("loading");
  if (walletUsdcRaw < amountRaw) return problem("noUsdc");
  return null;
}

/**
 * Can `amountRaw` (or "max") be withdrawn now? null = yes; otherwise {code, text}.
 * `suppliedRaw` is the customer's aAvaUSDC balance (null = unknown → loading).
 */
export function withdrawProblem({ status, amountRaw, suppliedRaw }) {
  const all = amountRaw === "max";
  if (!all && (typeof amountRaw !== "bigint" || amountRaw <= 0n)) return problem("badAmount");
  if (!status) return problem("loading");
  if (!status.active) return problem("inactive");
  if (status.paused) return problem("paused");
  if (typeof suppliedRaw !== "bigint") return problem("loading");
  if (suppliedRaw === 0n) return problem("nothing");
  const need = all ? suppliedRaw : amountRaw;
  if (!all && amountRaw > suppliedRaw) return problem("overPosition");
  if (status.liquidityRaw == null) return problem("loading");
  if (need > status.liquidityRaw) return problem("noLiquidity");
  return null;
}

/* ── reverts in plain words ───────────────────────────────────────────────── */

/** Aave V3.4+ custom errors seen on this Pool (selectors recomputed in the tests). */
export const AAVE_ERRORS = Object.freeze({
  "0x2c5211c6": "InvalidAmount",
  "0x90cd6f24": "ReserveInactive",
  "0x6d305815": "ReserveFrozen",
  "0xd37f5f1c": "ReservePaused",
  "0x47bc4b2c": "NotEnoughAvailableUserBalance",
  "0xf58f733a": "SupplyCapExceeded",
  "0xb77e1e0f": "AssetNotListed",
  "0x18d2badf": "SupplyToAToken",
  "0xdbc4273c": "WithdrawToAToken",
  "0x6679996d": "HealthFactorLowerThanLiquidationThreshold",
});

const ERROR_WORDS = Object.freeze({
  InvalidAmount: "That amount can't be used",
  ReserveInactive: AAVE_WHY.inactive,
  ReserveFrozen: AAVE_WHY.frozen,
  ReservePaused: AAVE_WHY.paused,
  NotEnoughAvailableUserBalance: AAVE_WHY.overPosition,
  SupplyCapExceeded: AAVE_WHY.full,
  AssetNotListed: AAVE_WHY.inactive,
  SupplyToAToken: "That call points at the wrong place",
  WithdrawToAToken: "That call points at the wrong place",
  /* Only a wallet with a loan against its deposit sees this; FlowFlow never builds a borrow. */
  HealthFactorLowerThanLiquidationThreshold: "Aave keeps this deposit as cover for a loan",
});

/**
 * A preflight revert (eth_call) → {name, text}. Known Aave errors and the USDC
 * token's own messages get plain words; anything else says so without guessing.
 */
export function aaveRevertText(data) {
  const { selector, message } = decodeRevert(data);
  const name = selector ? AAVE_ERRORS[selector] || null : null;
  if (name) return { name, text: ERROR_WORDS[name] };
  if (message && /exceeds allowance/i.test(message)) return { name: "allowance", text: "The allowance for Aave is too low" };
  if (message && /exceeds balance/i.test(message)) return { name: "balance", text: AAVE_WHY.noUsdc };
  return { name: null, text: "Aave would refuse this right now" };
}
