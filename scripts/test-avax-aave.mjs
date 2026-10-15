/**
 * test-avax-aave — AAVE V3 USDC ON AVALANCHE: the reserve read and rate maths,
 * the plain reasons a supply or withdrawal cannot go ahead, the CLOSED builders
 * (approve exact / supply for own / withdraw to own) with the allow-list decoder
 * that refuses everything else, and the gas layer (exit reserve, up-front check,
 * top-up sizing, the printed "Gas for later" row).
 * ════════════════════════════════════════════════════════════════════════════
 * Owner: "ใช้ Aave V3 USDC บน Avalanche (5.70%)" · AD-8 "ตอน Swap แอบเอาเงินลูกค้า
 * กลายเป็น Avax ไปใส่ไว้ใน Wallet" — shown, never silent.
 *
 * 🔴 NO NETWORK, NOTHING SIGNS. Fixtures are READ-ONLY live answers:
 *   fixtures/avax/aave-reserve-97586280.json     Pool.getReserveData(USDC), 5.70% APY
 *   fixtures/avax/rpc-live-2026-10-15.json        eth_call reverts from the live Pool
 *   fixtures/avax/relay-q-gasleg-usdc-avax-300000.json   the same-chain USDC → AVAX gas leg quote
 *   fixtures/avax/relay-q-movein-topup-10c.json   a 1337 → 43114 move with topupGas
 *
 * Run: node --test scripts/test-avax-aave.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFunctionData, parseAbi, keccak256, toBytes } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/avax", n), "utf8"));

const C = await load("src/lib/avax/config.js");
const V3 = await load("src/lib/avax/aave/v3.js");
const T = await load("src/lib/avax/aaveTx.js");
const G = await load("src/lib/avax/gas.js");
const ABI = await load("src/lib/avax/abi.js");

const OWN = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PLACEHOLDER = "0x1111111111111111111111111111111111111117";
const USDC_E = "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664";
const MAX = (1n << 256n) - 1n;
const timers = { setTimeout: () => 0, clearTimeout: () => {} };
const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);

const RESERVE = fixture("aave-reserve-97586280.json").answer.result;
const FEES = Object.freeze({ maxFeePerGas: 11000000000n, maxPriorityFeePerGas: 1000000000n }); // base 5 gwei
const HIGH = Object.freeze({ maxFeePerGas: 31000000000n, maxPriorityFeePerGas: 1000000000n }); // base 15 gwei

/* ── selectors ────────────────────────────────────────────────────────────── */

test("A1 every selector and custom-error id is the keccak of its signature", () => {
  const sigs = {
    getReserveData: "getReserveData(address)", getVirtualUnderlyingBalance: "getVirtualUnderlyingBalance(address)",
    balanceOf: "balanceOf(address)", totalSupply: "totalSupply()", allowance: "allowance(address,address)",
    approve: "approve(address,uint256)", supply: "supply(address,uint256,address,uint16)", withdraw: "withdraw(address,uint256,address)",
  };
  for (const [k, s] of Object.entries(sigs)) assert.equal(V3.SEL[k], sel(s), k);
  for (const [id, name] of Object.entries(V3.AAVE_ERRORS)) assert.equal(id, sel(`${name}()`), name);
});

/* ── the reserve ──────────────────────────────────────────────────────────── */

test("A2 getReserveData at block 97,586,280: APR 5.5436%, APY 5.7002%, open, cap 150M (R-aave §3)", () => {
  const r = V3.decodeReserveData(RESERVE);
  assert.equal(r.aTokenAddress, C.AAVE_V3.aUsdc);
  assert.equal(r.variableDebtTokenAddress, C.AAVE_V3.variableDebtUsdc);
  assert.equal(r.id, 2n);
  assert.equal(V3.aprFromRay(r.currentLiquidityRate).toFixed(6), "0.055436");
  assert.equal(V3.supplyApyPct(r.currentLiquidityRate).toFixed(4), "5.7002");
  const cfg = V3.decodeReserveConfig(r.configuration);
  assert.deepEqual([cfg.active, cfg.frozen, cfg.paused, cfg.decimals, cfg.reserveFactorBps], [true, false, false, 6, 1000]);
  assert.equal(cfg.supplyCap, 150000000n);
  /* APY maths: 0 → 0; unknown → null. */
  assert.equal(V3.supplyApyPct(0n), 0);
  assert.equal(V3.supplyApyPct(null), null);
  assert.equal(V3.apyFromApr(-1), null);
});

test("A2b a reserve that is not exactly 15 words, or whose aToken is not aAvaUSDC, is refused", () => {
  assert.throws(() => V3.decodeReserveData(RESERVE.slice(0, -64)), /Not Aave reserve data/);
  assert.throws(() => V3.decodeReserveData(RESERVE + "00".repeat(32)), /Not Aave reserve data/);
  const body = RESERVE.slice(2);
  const swapped = `0x${body.slice(0, 8 * 64)}${"0".repeat(24)}${OTHER.slice(2)}${body.slice(9 * 64)}`;
  assert.throws(() => V3.decodeReserveData(swapped), /not aAvaUSDC/);
  const dirty = `0x${body.slice(0, 8 * 64)}ff${body.slice(8 * 64 + 2)}`;
  assert.throws(() => V3.decodeReserveData(dirty), /address word/);
  assert.throws(() => V3.decodeReserveData("0x"), /Not Aave reserve data/);
});

test("A3 reserveStatus: cap room counts the treasury's share; liquidity is the virtual balance; unknowns stay null", () => {
  const r = V3.decodeReserveData(RESERVE);
  const s = V3.reserveStatus({ reserve: r, aTokenTotalSupplyRaw: 72180966000000n, virtualBalanceRaw: 5642149000000n });
  const owed = (r.accruedToTreasury * r.liquidityIndex) / V3.RAY;
  assert.equal(s.suppliedRaw, 72180966000000n + owed);
  assert.equal(s.capRoomRaw, 150000000000000n - s.suppliedRaw);
  assert.equal(s.liquidityRaw, 5642149000000n);
  assert.equal(s.apyPct.toFixed(4), "5.7002");
  const u = V3.reserveStatus({ reserve: r });
  assert.equal(u.capRoomRaw, null);
  assert.equal(u.liquidityRaw, null);
  assert.equal(V3.reserveStatus({ reserve: null }), null);
});

const statusWith = (over = {}) => ({ active: true, frozen: false, paused: false, uncapped: false, capRoomRaw: 1000n * 1000000n, liquidityRaw: 1000n * 1000000n, apyPct: 5.7, ...over });

test("A3b supplyProblem: a plain reason for every no — and unknown is 'Still loading', never a yes", () => {
  const ok = { status: statusWith(), amountRaw: 10000000n, walletUsdcRaw: 10000000n };
  assert.equal(V3.supplyProblem(ok), null);
  const code = (o) => V3.supplyProblem({ ...ok, ...o })?.code;
  assert.equal(code({ amountRaw: 0n }), "badAmount");
  assert.equal(code({ amountRaw: 10 }), "badAmount");
  assert.equal(code({ status: null }), "loading");
  assert.equal(code({ walletUsdcRaw: null }), "loading");
  assert.equal(code({ walletUsdcRaw: 9999999n }), "noUsdc");
  assert.equal(code({ status: statusWith({ active: false }) }), "inactive");
  assert.equal(code({ status: statusWith({ paused: true }) }), "paused");
  assert.equal(code({ status: statusWith({ frozen: true }) }), "frozen");
  assert.equal(code({ status: statusWith({ capRoomRaw: null }) }), "loading");
  assert.equal(code({ status: statusWith({ capRoomRaw: 10000000n }) }), "full", "0.1% slack kept for accrual");
  assert.equal(code({ status: statusWith({ capRoomRaw: 0n }) }), "full");
  assert.equal(code({ status: statusWith({ uncapped: true, capRoomRaw: null }) }), undefined);
  assert.equal(V3.supplyProblem({ ...ok, status: statusWith({ frozen: true }) }).text, "Aave USDC takes no new deposits right now");
});

test("A3c withdrawProblem: frozen still pays out; paused does not; no free liquidity says so", () => {
  const ok = { status: statusWith(), amountRaw: 5000000n, suppliedRaw: 10000000n };
  assert.equal(V3.withdrawProblem(ok), null);
  assert.equal(V3.withdrawProblem({ ...ok, amountRaw: "max" }), null);
  assert.equal(V3.withdrawProblem({ ...ok, status: statusWith({ frozen: true }) }), null);
  const code = (o) => V3.withdrawProblem({ ...ok, ...o })?.code;
  assert.equal(code({ status: statusWith({ paused: true }) }), "paused");
  assert.equal(code({ status: statusWith({ active: false }) }), "inactive");
  assert.equal(code({ status: null }), "loading");
  assert.equal(code({ suppliedRaw: null }), "loading");
  assert.equal(code({ suppliedRaw: 0n }), "nothing");
  assert.equal(code({ amountRaw: 10000001n }), "overPosition");
  assert.equal(code({ status: statusWith({ liquidityRaw: 4999999n }) }), "noLiquidity");
  assert.equal(code({ amountRaw: "max", status: statusWith({ liquidityRaw: 9999999n }) }), "noLiquidity");
  assert.equal(code({ status: statusWith({ liquidityRaw: null }) }), "loading");
  assert.equal(code({ amountRaw: -1n }), "badAmount");
  assert.equal(V3.withdrawProblem({ ...ok, status: statusWith({ liquidityRaw: 1n }) }).text, "Aave has no free liquidity right now");
});

/* ── the closed builders ──────────────────────────────────────────────────── */

const POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

test("A4 builders: exact calldata (== viem, == R-aave's V3 hex), chain 43114, value 0, gasLimit and fees always stated", () => {
  /* R-aave §6 "V3 equivalents", 10 USDC for the placeholder user. */
  assert.equal(T.buildSupplyTx({ own: PLACEHOLDER, amountRaw: 10000000n, fees: FEES }).data,
    "0x617ba037000000000000000000000000b97ef9ef8734c71904d8002f8b6bc66dd9c48a6e000000000000000000000000000000000000000000000000000000000098968000000000000000000000000011111111111111111111111111111111111111170000000000000000000000000000000000000000000000000000000000000000");

  const a = T.buildApproveTx({ own: OWN, amountRaw: 10000000n, fees: FEES });
  const s = T.buildSupplyTx({ own: OWN, amountRaw: 10000000n, fees: FEES });
  const w = T.buildWithdrawTx({ own: OWN, amountRaw: 4000000n, fees: FEES });
  const wm = T.buildWithdrawTx({ own: OWN, amountRaw: "max", fees: HIGH });
  const r0 = T.buildRemoveAllowanceTx({ own: OWN, fees: HIGH });
  assert.equal(a.data, encodeFunctionData({ abi: POOL_ABI, functionName: "approve", args: [C.AAVE_V3.pool, 10000000n] }));
  assert.equal(s.data, encodeFunctionData({ abi: POOL_ABI, functionName: "supply", args: [C.USDC, 10000000n, OWN, 0] }));
  assert.equal(w.data, encodeFunctionData({ abi: POOL_ABI, functionName: "withdraw", args: [C.USDC, 4000000n, OWN] }));
  assert.equal(wm.data, encodeFunctionData({ abi: POOL_ABI, functionName: "withdraw", args: [C.USDC, MAX, OWN] }));
  assert.equal(r0.data, encodeFunctionData({ abi: POOL_ABI, functionName: "approve", args: [C.AAVE_V3.pool, 0n] }));
  assert.equal(a.to, C.USDC);
  assert.equal(s.to, C.AAVE_V3.pool);
  for (const [t, gas] of [[a, G.GAS_LIMITS.approve], [s, G.GAS_LIMITS.supply], [w, G.GAS_LIMITS.withdraw], [r0, G.GAS_LIMITS.approve]]) {
    assert.equal(t.chainId, 43114);
    assert.equal(t.from, OWN);
    assert.equal(t.value, "0x0");
    assert.equal(BigInt(t.gasLimit), gas);
    assert.ok(BigInt(t.maxFeePerGas) > 0n && BigInt(t.maxPriorityFeePerGas) <= BigInt(t.maxFeePerGas));
    assert.ok(Object.isFrozen(t));
    assert.deepEqual(Object.keys(t).sort(), ["chainId", "data", "from", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "to", "value"]);
  }
});

test("A4b builders refuse: no own address, no fees, non-exit above 12 gwei, zero / over-cap / unlimited amounts", () => {
  const code = (fn) => { try { fn(); return "built"; } catch (e) { return e.code; } };
  assert.equal(code(() => T.buildSupplyTx({ own: null, amountRaw: 1n, fees: FEES })), "no-own");
  assert.equal(code(() => T.buildSupplyTx({ own: C.NATIVE_TOKEN, amountRaw: 1n, fees: FEES })), "no-own");
  assert.equal(code(() => T.buildSupplyTx({ own: OWN, amountRaw: 1n })), "no-fees");
  assert.equal(code(() => T.buildSupplyTx({ own: OWN, amountRaw: 1n, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 2n } })), "bad-fees");
  assert.equal(code(() => T.buildSupplyTx({ own: OWN, amountRaw: 1n, fees: HIGH })), "fee-high");
  assert.equal(code(() => T.buildApproveTx({ own: OWN, amountRaw: 1n, fees: HIGH })), "fee-high");
  assert.equal(code(() => T.buildWithdrawTx({ own: OWN, amountRaw: 1n, fees: HIGH })), "built", "the exit is never refused for the fee level");
  assert.equal(code(() => T.buildSupplyTx({ own: OWN, amountRaw: 0n, fees: FEES })), "bad-amount");
  assert.equal(code(() => T.buildSupplyTx({ own: OWN, amountRaw: 10, fees: FEES })), "bad-amount");
  assert.equal(code(() => T.buildSupplyTx({ own: OWN, amountRaw: T.AAVE_SUPPLY_HARD_CAP_RAW + 1n, fees: FEES })), "over-cap");
  assert.equal(code(() => T.buildApproveTx({ own: OWN, amountRaw: MAX, fees: FEES })), "over-cap");
  assert.equal(code(() => T.buildSupplyTx({ own: OWN, amountRaw: T.AAVE_SUPPLY_HARD_CAP_RAW, fees: FEES })), "built");
  assert.equal(code(() => T.buildWithdrawTx({ own: OWN, amountRaw: 0n, fees: FEES })), "bad-amount");
  assert.equal(code(() => T.buildWithdrawTx({ own: OWN, amountRaw: MAX, fees: FEES })), "bad-amount", "MAX only through 'max'");
  assert.equal(T.AAVE_SUPPLY_HARD_CAP_RAW, 20000000n, "20 USDC, plan §2.9 HARD.stakeUsdc");
});

test("A4c buildSupplySteps: approve exact only when the allowance is short; unknown allowance refuses", () => {
  assert.deepEqual(T.buildSupplySteps({ own: OWN, amountRaw: 5000000n, allowanceRaw: 0n, fees: FEES }).map((s) => s.kind), ["approve", "supply"]);
  assert.deepEqual(T.buildSupplySteps({ own: OWN, amountRaw: 5000000n, allowanceRaw: 5000000n, fees: FEES }).map((s) => s.kind), ["supply"]);
  const steps = T.buildSupplySteps({ own: OWN, amountRaw: 5000000n, allowanceRaw: 4999999n, fees: FEES });
  assert.equal(T.decodeAaveTx(steps[0].tx, OWN).amountRaw, 5000000n, "approve is the amount, not the difference");
  assert.throws(() => T.buildSupplySteps({ own: OWN, amountRaw: 5000000n, allowanceRaw: null, fees: FEES }), (e) => e.code === "loading");
  assert.equal(T.needsApprove(null, 1n), null);
});

/* ── the allow-list decoder ───────────────────────────────────────────────── */

test("A5 decodeAaveTx accepts exactly what the builders build, and returns the REBUILT tx", () => {
  const cases = [
    [T.buildApproveTx({ own: OWN, amountRaw: 7000000n, fees: FEES }), "approve", 7000000n, false],
    [T.buildRemoveAllowanceTx({ own: OWN, fees: FEES }), "remove-allowance", 0n, false],
    [T.buildSupplyTx({ own: OWN, amountRaw: 7000000n, fees: FEES }), "supply", 7000000n, false],
    [T.buildWithdrawTx({ own: OWN, amountRaw: 7000000n, fees: FEES }), "withdraw", 7000000n, false],
    [T.buildWithdrawTx({ own: OWN, amountRaw: "max", fees: FEES }), "withdraw", null, true],
  ];
  for (const [tx, kind, amountRaw, all] of cases) {
    const d = T.decodeAaveTx(tx, OWN);
    assert.equal(d.kind, kind);
    assert.equal(d.amountRaw, amountRaw);
    assert.equal(d.all, all);
    assert.deepEqual(d.tx, tx);
    /* Checksummed own, number value, `gas` instead of gasLimit, chainId as hex: same answer. */
    const loose = { ...tx, from: tx.from.toUpperCase().replace("0X", "0x"), value: 0, chainId: "0xa86a", gas: tx.gasLimit };
    delete loose.gasLimit;
    assert.deepEqual(T.decodeAaveTx(loose, OWN.toUpperCase().replace("0X", "0x")).tx, tx);
  }
  assert.equal(T.aaveTxSummary(T.decodeAaveTx(cases[0][0], OWN)), "Allow exactly 7 USDC for Aave");
  assert.equal(T.aaveTxSummary(T.decodeAaveTx(cases[2][0], OWN)), "Supply 7 USDC to Aave on Avalanche");
  assert.equal(T.aaveTxSummary(T.decodeAaveTx(cases[4][0], OWN)), "Withdraw all your USDC from Aave");
});

/** The builder's supply tx with its calldata rewritten. */
const word = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const supplyWith = ({ asset = C.USDC, amount = 7000000n, onBehalfOf = OWN, referral = 0n, tail = "" } = {}) =>
  ({ ...T.buildSupplyTx({ own: OWN, amountRaw: 7000000n, fees: FEES }), data: `0x617ba037${word(asset)}${word(amount.toString(16))}${word(onBehalfOf)}${word(referral.toString(16))}${tail}` });
const withdrawWith = ({ asset = C.USDC, amount = 7000000n, to = OWN } = {}) =>
  ({ ...T.buildWithdrawTx({ own: OWN, amountRaw: 7000000n, fees: FEES }), data: `0x69328dec${word(asset)}${word(amount.toString(16))}${word(to)}` });
const approveWith = ({ spender = C.AAVE_V3.pool, amount = 7000000n, to = C.USDC } = {}) =>
  ({ ...T.buildApproveTx({ own: OWN, amountRaw: 7000000n, fees: FEES }), to, data: `0x095ea7b3${word(spender)}${word(amount.toString(16))}` });

test("A5b decodeAaveTx REFUSES: foreign spender / onBehalfOf / to, other selectors and targets, other chain, value, unlimited", () => {
  const code = (tx, own = OWN) => { try { T.decodeAaveTx(tx, own); return "accepted"; } catch (e) { return e.code; } };
  /* address arguments */
  assert.equal(code(approveWith({ spender: OTHER })), "bad-spender");
  assert.equal(code(approveWith({ spender: C.RELAY_AVAX.v3.approvalProxy })), "bad-spender", "a swap spender is not an Aave approve");
  assert.equal(code(supplyWith({ onBehalfOf: OTHER })), "not-own");
  assert.equal(code(withdrawWith({ to: OTHER })), "not-own");
  assert.equal(code(supplyWith({ asset: USDC_E })), "bad-asset");
  assert.equal(code(withdrawWith({ asset: USDC_E })), "bad-asset");
  assert.equal(code(T.buildSupplyTx({ own: OTHER, amountRaw: 1n, fees: FEES })), "not-own", "a tx built for someone else");
  assert.equal(code(T.buildSupplyTx({ own: OWN, amountRaw: 1n, fees: FEES }), OTHER), "not-own");
  assert.equal(code({ ...T.buildSupplyTx({ own: OWN, amountRaw: 1n, fees: FEES }), from: OTHER }), "not-own");
  assert.equal(code(T.buildSupplyTx({ own: OWN, amountRaw: 1n, fees: FEES }), null), "no-own");
  /* amounts */
  assert.equal(code(approveWith({ amount: MAX })), "unlimited");
  assert.equal(code(approveWith({ amount: 1n << 128n })), "unlimited");
  assert.equal(code(approveWith({ amount: T.AAVE_SUPPLY_HARD_CAP_RAW + 1n })), "over-cap");
  assert.equal(code(supplyWith({ amount: T.AAVE_SUPPLY_HARD_CAP_RAW + 1n })), "over-cap");
  assert.equal(code(supplyWith({ amount: 0n })), "bad-amount");
  assert.equal(code(withdrawWith({ amount: 0n })), "bad-amount");
  /* targets and selectors */
  assert.equal(code(approveWith({ to: USDC_E })), "not-allowed");
  assert.equal(code(approveWith({ to: C.AAVE_V3.pool })), "not-allowed");
  assert.equal(code({ ...supplyWith(), to: C.USDC }), "not-allowed");
  assert.equal(code({ ...supplyWith(), to: OTHER }), "not-allowed");
  const base = T.buildSupplyTx({ own: OWN, amountRaw: 1n, fees: FEES });
  for (const sig of ["transfer(address,uint256)", "transferFrom(address,address,uint256)", "borrow(address,uint256,uint256,uint16,address)",
    "supplyWithPermit(address,uint256,address,uint16,uint256,uint8,bytes32,bytes32)", "setUserUseReserveAsCollateral(address,bool)", "increaseAllowance(address,uint256)"]) {
    assert.equal(code({ ...base, to: C.AAVE_V3.pool, data: `${sel(sig)}${word(C.USDC)}${word("1")}${word(OWN)}${word("0")}` }), "not-allowed", sig);
    assert.equal(code({ ...base, to: C.USDC, data: `${sel(sig)}${word(OWN)}${word("1")}` }), "not-allowed", sig);
  }
  /* envelope */
  assert.equal(code({ ...base, chainId: 42161 }), "wrong-chain");
  assert.equal(code({ ...base, chainId: "43114x" }), "wrong-chain");
  const noChain = { ...base }; delete noChain.chainId;
  assert.equal(code(noChain), "wrong-chain");
  assert.equal(code({ ...base, value: "0x1" }), "value");
  assert.equal(code({ ...base, value: 1n }), "value");
  assert.equal(code({ ...base, type: 4 }), "bad-type");
  assert.equal(code({ ...base, accessList: [] }), "bad-key");
  assert.equal(code({ ...base, authorizationList: [] }), "bad-key");
  assert.equal(code({ ...base, nonce: 3 }), "bad-key");
  assert.equal(code(null), "bad-tx");
  assert.equal(code([]), "bad-tx");
});

test("A5c decodeAaveTx REFUSES non-canonical bytes, missing fees, a foreign gas limit, a non-exit at a high fee", () => {
  const code = (tx) => { try { T.decodeAaveTx(tx, OWN); return "accepted"; } catch (e) { return e.code; } };
  assert.equal(code(supplyWith({ referral: 7n })), "bad-data");
  assert.equal(code(supplyWith({ tail: "00" })), "bad-data");
  assert.equal(code(supplyWith({ tail: "0".repeat(64) })), "bad-data");
  const dirtyOwn = `ff${"0".repeat(22)}${OWN.slice(2)}`;
  assert.equal(code(supplyWith({ onBehalfOf: dirtyOwn })), "bad-data");
  const s = T.buildSupplyTx({ own: OWN, amountRaw: 1n, fees: FEES });
  assert.equal(code({ ...s, data: s.data.slice(0, -2) }), "bad-data");
  assert.equal(code({ ...s, data: "0x617b" }), "bad-data");
  assert.equal(code({ ...s, data: "nothex" }), "bad-data");
  const noGas = { ...s }; delete noGas.gasLimit;
  assert.equal(code(noGas), "no-fees");
  const noFee = { ...s }; delete noFee.maxFeePerGas;
  assert.equal(code(noFee), "no-fees");
  assert.equal(code({ ...s, gasLimit: "0x" + (G.GAS_LIMITS.supply + 1n).toString(16) }), "bad-gas");
  assert.equal(code({ ...s, gasLimit: "0x" + (T.AAVE_MAX_GAS_LIMIT + 1n).toString(16) }), "bad-gas");
  assert.equal(code({ ...s, gasLimit: "0x0" }), "bad-gas");
  assert.equal(code({ ...s, maxFeePerGas: "0x" + HIGH.maxFeePerGas.toString(16) }), "fee-high");
  assert.equal(code({ ...s, maxFeePerGas: "lots" }), "bad-field");
  const w = T.buildWithdrawTx({ own: OWN, amountRaw: 1n, fees: FEES });
  assert.equal(code({ ...w, maxFeePerGas: "0x" + HIGH.maxFeePerGas.toString(16) }), "accepted", "the exit at a high fee");
});

/* ── preflight (eth_call, read-only) ──────────────────────────────────────── */

test("A6 preflight: Aave's custom errors and USDC's own messages come back as plain words; no window on any failure", async () => {
  const LIVE = fixture("rpc-live-2026-10-15.json");
  const reverts = LIVE.log.filter((l) => l.answer && l.answer.error).map((l) => l.answer.error.data);
  assert.ok(reverts.includes("0x6679996d"), "a live HealthFactor revert is in the capture");
  const answerWith = (json) => async () => ({ ok: true, status: 200, json: async () => json });
  const s = T.buildSupplyTx({ own: OWN, amountRaw: 5000000n, fees: FEES });
  const w = T.buildWithdrawTx({ own: OWN, amountRaw: "max", fees: FEES });
  assert.deepEqual(await T.preflightAaveTx(s, OWN, { fetchImpl: answerWith({ result: "0x" }), timers }), { ok: true });
  for (const [data, name] of [["0x2c5211c6", "InvalidAmount"], ["0x47bc4b2c", "NotEnoughAvailableUserBalance"], ["0xf58f733a", "SupplyCapExceeded"],
    ["0xd37f5f1c", "ReservePaused"], ["0x6d305815", "ReserveFrozen"], ["0x6679996d", "HealthFactorLowerThanLiquidationThreshold"]]) {
    const r = await T.preflightAaveTx(w, OWN, { fetchImpl: answerWith({ error: { code: 3, message: "execution reverted", data } }), timers });
    assert.equal(r.ok, false);
    assert.equal(r.reverted, true);
    assert.equal(r.name, name);
    assert.ok(r.text && !/0x|revert/i.test(r.text), r.text);
  }
  const allowanceData = reverts.find((d) => d.startsWith("0x08c379a0"));
  const r = await T.preflightAaveTx(s, OWN, { fetchImpl: answerWith({ error: { code: 3, message: "execution reverted: ERC20: transfer amount exceeds allowance", data: allowanceData } }), timers });
  assert.deepEqual(r, { ok: false, reverted: true, name: "allowance", text: "The allowance for Aave is too low" });
  const down = await T.preflightAaveTx(s, OWN, { fetchImpl: async () => { throw new Error("offline"); }, timers });
  assert.deepEqual(down, { ok: false, reverted: false, text: "Couldn't check this with Avalanche" });
  /* Only an allowed shape is ever simulated. */
  let called = 0;
  await assert.rejects(T.preflightAaveTx(supplyWith({ onBehalfOf: OTHER }), OWN, { fetchImpl: async () => { called++; }, timers }), (e) => e.code === "not-own");
  assert.equal(called, 0);
  /* The simulation is from own, to the rebuilt target, value 0. */
  let sent = null;
  await T.preflightAaveTx(s, OWN, { fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ result: "0x" }) }; }, timers });
  assert.equal(sent.method, "eth_call");
  assert.deepEqual(sent.params[0], { to: s.to, data: s.data, from: OWN, value: "0x0" });
  assert.equal(V3.aaveRevertText("0xdeadbeef").name, null);
  assert.equal(ABI.decodeRevert(allowanceData).message, "ERC20: transfer amount exceeds allowance");
});

/* ── gas ──────────────────────────────────────────────────────────────────── */

const AVAX = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n;

test("G1 reserves, rounded up to 0.001 AVAX: exit 0.011 (the exit's own fee rule at a 12 gwei base = 25 gwei), swap-back 0.013 each (12 gwei)", () => {
  assert.equal(G.EXIT_GAS, 440000n);
  assert.equal(G.EXIT_SIZING_FEE_WEI, 25n * C.GWEI, "2 × 12 + 1 gwei");
  assert.equal(G.EXIT_SIZING_FEE_WEI, G.maxFeeFor(G.EXIT_SIZING_BASE_WEI), "the same rule exits sign with");
  assert.equal(G.EXIT_GAS * 25n * C.GWEI, 11000000000000000n, "0.011 before rounding");
  assert.equal(G.EXIT_RESERVE_WEI, AVAX("0.011"));
  assert.equal(G.SWAP_BACK_GAS, 1075000n);
  assert.equal(G.SWAP_BACK_RESERVE_WEI, AVAX("0.013"));
  assert.equal(G.exitReserveWei(0), AVAX("0.011"));
  assert.equal(G.exitReserveWei(), AVAX("0.011"));
  assert.equal(G.exitReserveWei(2), AVAX("0.037"));
  /* unknown is null, never the bare exit part */
  for (const bad of [-1, null, 1.5, NaN, "2"]) assert.equal(G.exitReserveWei(bad), null, String(bad));
  assert.equal(G.reserveForGas(1n), AVAX("0.001"));
  /* the reserve pays the WHOLE way out (withdraw + paid exit) at every base fee up to 12 gwei */
  for (let base = 1n; base <= 12n; base += 1n) {
    const fee = G.feeFields(base * C.GWEI, { exit: true }).maxFeePerGas;
    const exit = G.gasCheck({ avaxWei: G.exitReserveWei(0), gasLimits: [G.GAS_LIMITS.withdraw, G.GAS_LIMITS.exitApprove, G.GAS_LIMITS.exitDeposit], maxFeePerGas: fee, kind: "exit" });
    assert.equal(exit.ok, true, `base ${base} gwei: ${exit.why}`);
  }
});

test("G2 fee fields: maxFee = 2 × base + 1 gwei; a non-exit above 12 gwei is refused, an exit never is; unknown base refuses", () => {
  assert.deepEqual({ ...G.feeFields({ baseFeeWei: 5000000000n }) }, { maxFeePerGas: 11000000000n, maxPriorityFeePerGas: 1000000000n });
  assert.equal(G.feeFields(5500000000n).maxFeePerGas, 12000000000n, "exactly 12 gwei passes");
  assert.throws(() => G.feeFields(5500000001n), (e) => e.code === "fee-high");
  assert.equal(G.feeFields(50000000000n, { exit: true }).maxFeePerGas, 101000000000n);
  assert.throws(() => G.feeFields(null), (e) => e.code === "loading");
  assert.throws(() => G.feeFields({ baseFeeWei: 0n }), (e) => e.code === "loading");
  assert.equal(G.maxFeeFor(5000000000n), 11000000000n);
});

test("G3 gasCheck: non-exit keeps the reserve after; exit may spend it; the gas leg checks only its up-front cost", () => {
  const fee = 11000000000n;
  const supplyUp = (G.GAS_LIMITS.approve + G.GAS_LIMITS.supply) * fee; // 0.004565
  const reserve = G.exitReserveWei(0);
  /* non-exit: short by exactly 1 wei → refused, with the shortfall in words */
  let r = G.gasCheck({ avaxWei: supplyUp + reserve - 1n, gasLimits: [G.GAS_LIMITS.approve, G.GAS_LIMITS.supply], maxFeePerGas: fee, reserveAfterWei: reserve });
  assert.equal(r.ok, false);
  assert.equal(r.shortWei, 1n);
  assert.match(r.why, /^Needs <0\.0001 more AVAX for gas$/);
  r = G.gasCheck({ avaxWei: supplyUp + reserve, gasLimits: [G.GAS_LIMITS.approve, G.GAS_LIMITS.supply], maxFeePerGas: fee, reserveAfterWei: reserve });
  assert.equal(r.ok, true);
  assert.equal(r.needWei, supplyUp + reserve);
  /* exit: the reserve is what it spends */
  const exitUp = G.GAS_LIMITS.withdraw * fee;
  assert.equal(G.gasCheck({ avaxWei: exitUp, gasLimits: [G.GAS_LIMITS.withdraw], maxFeePerGas: fee, kind: "exit" }).ok, true);
  assert.equal(G.gasCheck({ avaxWei: exitUp - 1n, gasLimits: [G.GAS_LIMITS.withdraw], maxFeePerGas: fee, kind: "exit" }).ok, false);
  assert.ok(G.EXIT_RESERVE_WEI >= G.GAS_LIMITS.withdraw * 12n * C.GWEI + (G.GAS_LIMITS.exitApprove + G.GAS_LIMITS.exitDeposit) * 12n * C.GWEI,
    "the reserve pays a withdraw AND the paid exit at 12 gwei");
  /* exit at a fee above 12 gwei is still checked only against the balance */
  assert.equal(G.gasCheck({ avaxWei: G.GAS_LIMITS.withdraw * 31000000000n, gasLimits: [G.GAS_LIMITS.withdraw], maxFeePerGas: 31000000000n, kind: "exit" }).ok, true);
  assert.equal(G.gasCheck({ avaxWei: AVAX("1"), gasLimits: [G.GAS_LIMITS.supply], maxFeePerGas: 31000000000n }).why, G.GAS_WHY.feeHigh);
  /* the gas leg (audit quote: approve 73,112 + swap 454,191): up-front only, 0.0058003 AVAX at 11 gwei, ≈0.0063 at 12 */
  const q = fixture("relay-q-gasleg-usdc-avax-300000.json").response;
  const legGas = q.steps.map((s) => BigInt(s.items[0].data.gas));
  assert.deepEqual(legGas, [73112n, 454191n]);
  const leg = G.gasCheck({ avaxWei: AVAX("0.0059"), gasLimits: legGas, maxFeePerGas: fee, kind: "gas-leg" });
  assert.equal(leg.ok, true);
  assert.equal(leg.needWei, (73112n + 454191n) * fee);
  assert.equal(G.gasCheck({ avaxWei: AVAX("0.0059"), gasLimits: legGas, maxFeePerGas: fee }).ok, false, "as a normal tx it would also need the reserve");
  /* unknowns are never a yes */
  assert.equal(G.gasCheck({ avaxWei: null, gasLimits: [1n], maxFeePerGas: fee }).why, G.GAS_WHY.loading);
  assert.equal(G.gasCheck({ avaxWei: AVAX("1"), gasLimits: [undefined], maxFeePerGas: fee }).ok, false);
  assert.equal(G.gasCheck({ avaxWei: AVAX("1"), gasLimits: [1n], maxFeePerGas: null }).ok, false);
});

test("G4 swapBackCount: every held non-USDC ERC-20 worth ≥ $1 (or of unknown value), plus what a plan buys", () => {
  const acc = { assets: [
    { symbol: "USDC", native: false, raw: 763172690n, decimals: 6 },
    { symbol: "AVAX", native: true, raw: 99875151164936437844n, decimals: 18 },
    { symbol: "WAVAX", native: false, raw: 618603348224332188n, decimals: 18 },
    { symbol: "BTC.b", native: false, raw: 30650n, decimals: 8 },
    { symbol: "USDT", native: false, raw: 218564248n, decimals: 6 },
    { symbol: "XAUt0", native: false, raw: 0n, decimals: 6 },
  ] };
  const prices = { WAVAX: 9.5, "BTC.b": 80488, USDT: 1 };
  assert.equal(G.swapBackCount(acc, { prices }), 3);
  assert.equal(G.swapBackCount(acc, { prices, planned: ["XAUt0", "BTC.b", "USDC", "AVAX"] }), 4);
  const dust = { assets: [{ symbol: "BTC.b", native: false, raw: 1n, decimals: 8 }] };
  assert.equal(G.swapBackCount(dust, { prices }), 0, "below $1 it cannot be swapped back anyway");
  assert.equal(G.swapBackCount(dust, { prices: {} }), 1, "unknown value counts (safe side)");
  assert.equal(G.swapBackCount({ assets: [{ symbol: "USDT", native: false, raw: null, decimals: 6 }] }), 1, "unknown balance counts");
  /* an account nobody could read is UNKNOWN, never "holds nothing" (ATK-14) */
  assert.equal(G.swapBackCount(null), null);
  assert.equal(G.swapBackCount({}), null);
  assert.equal(G.swapBackCount({ assets: [null] }), null);
  assert.equal(G.swapBackCount({ assets: [] }), 0, "read, and empty");
  assert.equal(G.exitReserveWei(G.swapBackCount(null)), null);
  assert.equal(G.gasCheck({ avaxWei: AVAX("1"), gasLimits: [G.GAS_LIMITS.supply], maxFeePerGas: 11000000000n, reserveAfterWei: G.exitReserveWei(G.swapBackCount(null)) }).why, G.GAS_WHY.loading, "an unknown reserve is never a yes");
});

test("G5 top-up: only when AVAX < need; $0.20–0.50 in $0.05 steps with a 1.25 margin; too big or unknown price → no Confirm", () => {
  const usd = 9.5;
  assert.deepEqual(G.topupPlan({ avaxWei: AVAX("0.02"), needWei: AVAX("0.02"), avaxUsd: usd }), { needed: false });
  assert.deepEqual(G.topupPlan({ avaxWei: AVAX("0.03"), needWei: AVAX("0.02"), avaxUsd: usd }), { needed: false });
  /* short 0.0001 AVAX → $0.0012 → the $0.20 floor */
  let p = G.topupPlan({ avaxWei: AVAX("0.0059"), needWei: AVAX("0.006"), avaxUsd: usd });
  assert.equal(p.ok, true);
  assert.equal(p.usd, 0.2);
  assert.equal(p.topupGasAmount, "200000");
  /* short 0.0262 AVAX → 0.0262 × 9.5 × 1.25 = $0.311 → $0.35 */
  p = G.topupPlan({ avaxWei: 0n, needWei: AVAX("0.0262"), avaxUsd: usd });
  assert.equal(p.usd, 0.35);
  assert.equal(p.topupGasAmount, "350000");
  assert.ok(p.expectedAvaxWei > AVAX("0.0368") && p.expectedAvaxWei < AVAX("0.0369"));
  /* short 0.042 AVAX → $0.499 → $0.50 (still allowed) */
  p = G.topupPlan({ avaxWei: 0n, needWei: AVAX("0.042"), avaxUsd: usd });
  assert.equal(p.usd, 0.5);
  /* short 0.045 AVAX → $0.534 → over $0.50: refuse with the reason */
  p = G.topupPlan({ avaxWei: 0n, needWei: AVAX("0.045"), avaxUsd: usd });
  assert.deepEqual(p, { needed: true, ok: false, why: G.GAS_WHY.topupTooBig });
  for (const bad of [null, 0, -1, NaN]) {
    assert.deepEqual(G.topupPlan({ avaxWei: 0n, needWei: AVAX("0.01"), avaxUsd: bad }), { needed: true, ok: false, why: G.GAS_WHY.loading });
  }
  assert.deepEqual(G.topupPlan({ avaxWei: null, needWei: AVAX("0.01"), avaxUsd: usd }), { needed: true, ok: false, why: G.GAS_WHY.loading });
  /* every size it can produce is inside the band */
  for (let i = 1; i <= 60; i++) {
    const r = G.topupPlan({ avaxWei: 0n, needWei: AVAX(String(i / 1000)), avaxUsd: usd });
    if (r.ok) assert.ok(r.usd >= 0.2 && r.usd <= 0.5 && Math.abs(r.usd * 20 - Math.round(r.usd * 20)) < 1e-9, String(r.usd));
  }
  assert.equal(G.TOPUP_WHEN(1n, 2n), true);
  assert.equal(G.TOPUP_WHEN(null, 2n), false);
});

test("G6 'Gas for later' is printed, never silent: topupGas or a gas leg without a valid row has no Confirm", () => {
  /* the real 1337 → 43114 move with topupGas (fixture: $0.10 → 0.010385 AVAX) */
  const mv = fixture("relay-q-movein-topup-10c.json");
  const arrived = BigInt(mv.details.currencyGasTopup.amount);
  const row = G.gasRow({ avaxWei: arrived, usd: Number(mv.body.topupGasAmount) / 1e6, source: "move" });
  assert.equal(row.text, "Gas for later ≈0.0103 AVAX ($0.10) · stays in your Avax Wallet");
  assert.equal(G.gasRowProblem({ body: mv.body, gasRow: row }), null);
  assert.equal(G.gasRowProblem({ body: mv.body, gasRow: null }), "Gas for later is missing from the card");
  assert.equal(G.gasRowProblem({ body: mv.body, gasRow: { ...row, usd: 0.3 } }), "Gas for later does not match the move");
  assert.equal(G.gasRowProblem({ body: mv.body, gasRow: { ...row, label: "" } }), "Gas for later is missing from the card");
  assert.equal(G.gasRowProblem({ body: { ...mv.body, topupGas: false }, gasRow: row }), "Gas for later is shown but nothing buys gas");
  assert.equal(G.gasRowProblem({ body: { ...mv.body, topupGas: false, topupGasAmount: undefined } }), null);

  /* the same-chain gas leg (audit quote: 0.30 USDC → ≥0.031018 AVAX) */
  const q = fixture("relay-q-gasleg-usdc-avax-300000.json").response;
  const minOut = BigInt(q.details.currencyOut.minimumAmount);
  const legRow = G.gasRow({ avaxWei: minOut, usd: Number(q.details.currencyIn.amount) / 1e6, source: "usdc" });
  assert.equal(legRow.text, "Gas for later ≈0.031 AVAX ($0.30) · from your USDC, stays in your Avax Wallet");
  assert.equal(G.gasRowProblem({ gasLeg: true, gasRow: legRow }), null);
  assert.equal(G.gasRowProblem({ gasLeg: true, gasRow: null }), "Gas for later is missing from the card");
  assert.equal(G.gasRowProblem({ gasLeg: true, gasRow: row }), "Gas for later names the wrong source");

  /* a row needs real figures */
  assert.equal(G.gasRow({ avaxWei: null, usd: 0.3 }), null);
  assert.equal(G.gasRow({ avaxWei: 0n, usd: 0.3 }), null);
  assert.equal(G.gasRow({ avaxWei: 1n, usd: null }), null);
  /* the receipt prints what really arrived */
  assert.equal(G.gasArrivedWei(AVAX("0.001"), AVAX("0.0113")), AVAX("0.0103"));
  assert.equal(G.gasArrivedWei(null, AVAX("0.01")), null);
  assert.equal(G.gasArrivedWei(AVAX("0.02"), AVAX("0.01")), null);
  assert.equal(G.avaxText(1n), "<0.0001 AVAX");
  assert.equal(G.avaxText(0n), "≈0 AVAX");
  assert.equal(G.avaxText(null), "—");
});

test("G7 gasLow (chip R14): only with money on Avalanche, only when known", () => {
  const reserveWei = G.exitReserveWei(1);
  assert.equal(reserveWei, AVAX("0.024"));
  assert.equal(G.gasLow({ avaxWei: AVAX("0.01"), reserveWei, hasMoneyOnAvalanche: true }), true);
  assert.equal(G.gasLow({ avaxWei: AVAX("0.023"), reserveWei, hasMoneyOnAvalanche: true }), true);
  assert.equal(G.gasLow({ avaxWei: AVAX("0.024"), reserveWei, hasMoneyOnAvalanche: true }), false);
  assert.equal(G.gasLow({ avaxWei: 0n, reserveWei, hasMoneyOnAvalanche: false }), false);
  assert.equal(G.gasLow({ avaxWei: null, reserveWei, hasMoneyOnAvalanche: true }), false);
});
