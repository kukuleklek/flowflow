/**
 * test-avax-read — THE AVAX WALLET'S READ LAYER: config pins, the read-only RPC
 * client, the one-call Multicall3 read, the whitelist, ownAvaxAddress(), prices
 * and exact units.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner (USER-ADDENDUM): "ใช้ Aave V3 USDC บน Avalanche (5.70%)" · "เรา Whitelist
 * Asset เข้าไปด้วย ในหน้า AVAX WALLET".
 *
 * 🔴 NO NETWORK. Every fetch is a replay of a READ-ONLY live capture
 * (scripts/fixtures/avax/rpc-live-2026-10-15.json: eth_call / eth_getBlockByNumber
 * / eth_gasPrice on the public Avalanche RPC and Relay's token price endpoint),
 * matched on the exact request. A request the capture does not hold fails the
 * test instead of reaching the network. Nothing signs or sends.
 *
 * Run: node --test scripts/test-avax-read.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFunctionData, encodeFunctionResult, parseAbi } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/avax", n), "utf8"));

const C = await load("src/lib/avax/config.js");
const RPC = await load("src/lib/avax/rpc.js");
const R = await load("src/lib/avax/read.js");
const W = await load("src/lib/avax/whitelist.js");
const O = await load("src/lib/avax/own.js");
const P = await load("src/lib/avax/prices.js");
const U = await load("src/lib/avax/units.js");
const V3 = await load("src/lib/avax/aave/v3.js");
const WD = await load("src/lib/relay/withdraw.js");

const LIVE = fixture("rpc-live-2026-10-15.json");
const DEAD = "0x000000000000000000000000000000000000dead";
const SUPPLIER = "0xf5ccd855b7d196c3f3d54ae65e90531f1849bbe2";
const USER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

/** Fake timers: nothing fires on its own (no test waits on a real clock). */
const timers = { setTimeout: () => 0, clearTimeout: () => {} };

/**
 * A fetch that answers only from the capture. `mutate(answer, body)` may edit a
 * deep copy before it is returned. Records every call.
 */
function replay({ mutate = null, status = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const hit = LIVE.log.find((l) => l.url === url && JSON.stringify(l.body) === JSON.stringify(body));
    if (!hit) throw new Error(`not in the capture: ${url} ${init.body || ""}`);
    let answer = JSON.parse(JSON.stringify(hit.answer));
    if (mutate) answer = mutate(answer, body) ?? answer;
    const code = status ?? hit.status;
    return { ok: code >= 200 && code < 300, status: code, json: async () => answer };
  };
  return { fetchImpl, calls };
}

const fixedNow = () => 1792044280000;

/* ── config ───────────────────────────────────────────────────────────────── */

test("R1 config: every pin is a lowercase address, and USDC/RPC/Relay agree with the rest of the app", () => {
  const addrs = [C.USDC, C.NATIVE_TOKEN, C.MULTICALL3, C.RELAY_HL_DEPOSITORY, C.CHAINLINK_AVAX_USD,
    ...Object.values(C.AAVE_V3).filter((v) => typeof v === "string" && v.startsWith("0x")),
    C.RELAY_AVAX.v3.erc20Router, C.RELAY_AVAX.v3.approvalProxy, C.RELAY_AVAX["v3.2"].erc20Router, C.RELAY_AVAX["v3.2"].approvalProxy,
    C.RELAY_AVAX.depository, C.RELAY_AVAX.relayReceiver, C.RELAY_AVAX.allowanceHolder, ...C.RELAY_AVAX.solvers];
  for (const a of addrs) assert.match(a, /^0x[0-9a-f]{40}$/, a);

  assert.equal(C.AVAX_CHAIN_ID, 43114);
  assert.equal(C.AVAX_CHAIN_ID_HEX, "0xa86a");
  assert.equal(C.AVAX_RPC, "https://api.avax.network/ext/bc/C/rpc");
  /* The owner's decision, verbatim addresses (USER-ADDENDUM "Aave V3 USDC on Avalanche"). */
  assert.equal(C.AAVE_V3.pool, "0x794a61358D6845594F94dc1DB02A252b5b4814aD".toLowerCase());
  assert.equal(C.AAVE_V3.aUsdc, "0x625E7708f30cA75bfd92586e17077590C60eb4cD".toLowerCase());
  assert.equal(C.USDC, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E".toLowerCase());
  /* The same USDC the Withdraw panel's Avalanche route already pays out. */
  const route = WD.withdrawRouteById("avalanche-usdc");
  assert.equal(route.chainId, C.AVAX_CHAIN_ID);
  assert.equal(route.address.toLowerCase(), C.USDC);
  assert.equal(route.decimals, C.USDC_DECIMALS);
  assert.ok(Object.isFrozen(C.AAVE_V3) && Object.isFrozen(C.RELAY_AVAX) && Object.isFrozen(C.RELAY_AVAX.v3));
});

test("R1b config: Relay contracts equal the live GET /chains entry for 43114", () => {
  const ch = fixture("relay-chains-43114.json").answer;
  assert.equal(ch.id, 43114);
  assert.equal(ch.contracts.multicall3, C.MULTICALL3);
  assert.equal(ch.contracts.v3.erc20Router, C.RELAY_AVAX.v3.erc20Router);
  assert.equal(ch.contracts.v3.approvalProxy, C.RELAY_AVAX.v3.approvalProxy);
  assert.equal(ch.contracts["v3.2"].erc20Router, C.RELAY_AVAX["v3.2"].erc20Router);
  assert.equal(ch.contracts["v3.2"].approvalProxy, C.RELAY_AVAX["v3.2"].approvalProxy);
  assert.equal(ch.contracts.relayReceiver, C.RELAY_AVAX.relayReceiver);
  assert.equal(ch.protocol.v2.depository, C.RELAY_AVAX.depository);
  assert.deepEqual(ch.solverAddresses.map((s) => s.toLowerCase()), [...C.RELAY_AVAX.solvers]);
  assert.equal(ch.httpRpcUrl, C.AVAX_RPC);
  assert.deepEqual([...C.RELAY_APPROVAL_PROXIES], [C.RELAY_AVAX.v3.approvalProxy, C.RELAY_AVAX["v3.2"].approvalProxy]);
});

/* ── rpc ──────────────────────────────────────────────────────────────────── */

test("R2 rpc: it cannot send — a send/sign method throws before any request is made", async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, json: async () => ({ result: "0x1" }) }; };
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4", "wallet_switchEthereumChain"]) {
    await assert.rejects(RPC.avaxRpc(m, [], { fetchImpl, timers }), (e) => e.code === "method-not-allowed");
  }
  await assert.rejects(RPC.avaxRpcBatch([{ method: "eth_chainId" }, { method: "eth_sendRawTransaction", params: ["0x00"] }], { fetchImpl, timers }),
    (e) => e.code === "method-not-allowed");
  assert.equal(called, 0);
  assert.ok(!RPC.READ_METHODS.some((m) => /send|sign/i.test(m)));
});

test("R2b rpc: an unreadable answer throws with a code — never a 0", async () => {
  const answer = (json, { ok = true, status = 200 } = {}) => async () => ({ ok, status, json: async () => json });
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: answer({}, { ok: false, status: 503 }), timers }), (e) => e.code === "http");
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: answer({ jsonrpc: "2.0", id: 1 }), timers }), (e) => e.code === "bad-response");
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: answer({ result: "" }), timers }), (e) => e.code === "bad-response");
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: answer({ result: "0x" }), timers }), (e) => e.code === "bad-response");
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: answer({ result: 0 }), timers }), (e) => e.code === "bad-response");
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: answer(null), timers }), (e) => e.code === "bad-response");
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: answer({ error: { code: -32000, message: "header not found" } }), timers }), (e) => e.code === "rpc-error");
  await assert.rejects(RPC.ethCall({ to: C.USDC, data: "0x18160ddd" }, { fetchImpl: answer({ error: { code: 3, message: "execution reverted", data: "0x2c5211c6" } }), timers }),
    (e) => e.code === "reverted" && e.detail.data === "0x2c5211c6");
  await assert.rejects(RPC.getBalanceWei(DEAD, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); }, timers }), (e) => e.code === "network");
  assert.equal(RPC.hexToBigInt("0x0"), 0n);
  assert.equal(RPC.hexToBigInt("0x12a05f296"), 5000000150n);
  for (const bad of ["0x01", "12", "", null, 7, "0xzz"]) assert.throws(() => RPC.hexToBigInt(bad));
});

test("R2c rpc: the timeout aborts the request and says so", async () => {
  let fire = null;
  const t = { setTimeout: (fn) => { fire = fn; return 1; }, clearTimeout: () => {} };
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    fire();
  });
  await assert.rejects(RPC.avaxRpc("eth_chainId", [], { fetchImpl, timers: t }), (e) => e.code === "timeout");
});

test("R2d rpc: a batch keeps one failed entry from failing the others", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(Array.isArray(body) && body.length === 3);
    return { ok: true, status: 200, json: async () => [
      { jsonrpc: "2.0", id: 3, result: "0x56a0bd0d2c27a4054" },
      { jsonrpc: "2.0", id: 1, result: "0xa86a" },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "boom" } },
    ] };
  };
  const out = await RPC.avaxRpcBatch([{ method: "eth_chainId" }, { method: "eth_gasPrice" }, { method: "eth_getBalance", params: [DEAD, "latest"] }], { fetchImpl, timers });
  assert.deepEqual(out.map((o) => o.ok), [true, false, true]);
  assert.equal(out[0].result, "0xa86a");
  assert.equal(out[1].error.code, "rpc-error");
  await assert.rejects(RPC.assertAvalanche({ fetchImpl: async () => ({ ok: true, json: async () => ({ result: "0xa4b1" }) }), timers }), (e) => e.code === "wrong-chain");
});

/* ── multicall ────────────────────────────────────────────────────────────── */

const MC_ABI = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);

test("R3 multicall: our aggregate3 encoder matches viem byte for byte; our decoder reads viem's encoding", () => {
  const calls = [
    { target: C.MULTICALL3, data: `${R.GET_ETH_BALANCE}${"0".repeat(24)}${DEAD.slice(2)}`, allowFailure: true },
    { target: C.AAVE_V3.aUsdc, data: "0x18160ddd", allowFailure: true },
    { target: C.USDC, data: `0xdd62ed3e${"0".repeat(24)}${USER.slice(2)}${"0".repeat(24)}${C.AAVE_V3.pool.slice(2)}`, allowFailure: false },
    { target: C.USDC, data: "0x", allowFailure: true },
  ];
  const ours = R.encodeAggregate3(calls);
  const theirs = encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3", args: [calls.map((c) => ({ target: c.target, allowFailure: c.allowFailure, callData: c.data }))] });
  assert.equal(ours, theirs);

  const ret = [
    { success: true, returnData: "0x" + "0".repeat(63) + "5" },
    { success: false, returnData: "0x" },
    { success: true, returnData: "0x" + "ab".repeat(70) },
  ];
  const enc = encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: ret });
  assert.deepEqual(R.decodeAggregate3(enc, 3), ret);
  assert.throws(() => R.decodeAggregate3(enc, 2), /Wrong number/);
  assert.throws(() => R.decodeAggregate3(enc.slice(0, enc.length - 64), 3));
  assert.throws(() => R.decodeAggregate3("0x", 1));
});

/* ── the Avax Wallet read (live capture, replayed) ────────────────────────── */

test("R4 readAvaxAccount: one eth_call reads every whitelisted balance, AVAX, aUSDC, allowances and the reserve", async () => {
  const { fetchImpl, calls } = replay();
  const acc = await R.readAvaxAccount(DEAD, { fetchImpl, timers, now: fixedNow, env: {} });
  assert.equal(calls.length, 1, "one request");
  assert.equal(calls[0].body.method, "eth_call");
  assert.equal(calls[0].body.params[0].to, C.MULTICALL3);
  assert.deepEqual(acc.assets.map((a) => a.symbol), ["USDC", "AVAX", "WAVAX", "BTC.b", "USDT", "XAUt0"]);
  /* The public burn address, read live 2026-10-15 (R-swap §4 read the same figures). */
  assert.equal(acc.balances.USDC, 763172690n);
  assert.equal(acc.balances.AVAX, 99875151164936437844n);
  assert.equal(acc.avaxWei, 99875151164936437844n);
  assert.equal(acc.balances.WAVAX, 618603348224332188n);
  assert.equal(acc.balances["BTC.b"], 30650n);
  assert.equal(acc.balances.USDT, 218564248n);
  assert.equal(acc.balances.XAUt0, 0n, "a MEASURED zero is 0n");
  assert.equal(acc.assets.find((a) => a.symbol === "USDC").amount, 763.17269);
  assert.equal(acc.aave.suppliedRaw, 57317n);
  assert.equal(acc.aave.poolAllowanceRaw, 0n);
  assert.deepEqual({ ...acc.relayAllowances }, { v3: 0n, "v3.2": 0n });
  assert.deepEqual([...acc.problems], []);
  const s = acc.aave.status;
  assert.equal(s.active, true);
  assert.equal(s.frozen, false);
  assert.equal(s.paused, false);
  assert.equal(s.supplyCapRaw, 150000000n * 1000000n);
  assert.ok(s.capRoomRaw > 70000000n * 1000000n);
  assert.ok(s.liquidityRaw > 1000000n * 1000000n);
  assert.equal(s.apyPct.toFixed(2), "5.75", "APY at capture time");
  assert.equal(acc.owner, DEAD);
  assert.equal(acc.readAt, fixedNow());
  assert.ok(Object.isFrozen(acc) && Object.isFrozen(acc.assets) && Object.isFrozen(acc.aave));
});

test("R4b readAvaxAccount: a supplier's position, and a standing unlimited allowance reads as what it is", async () => {
  const { fetchImpl } = replay();
  const acc = await R.readAvaxAccount(SUPPLIER, { fetchImpl, timers, now: fixedNow, env: {} });
  assert.equal(acc.aave.suppliedRaw, 3299401718n);
  assert.equal(acc.aave.suppliedUsdc, 3299.401718);
  assert.equal(acc.balances.USDC, 0n);
  assert.ok(acc.aave.poolAllowanceRaw > 1n << 255n);
});

/** Rewrite the aggregate3 answer: `edit(list)` gets [{success, returnData}] and returns the new list. */
function editMulticall(edit) {
  return (answer, body) => {
    if (!body || body.method !== "eth_call" || body.params[0].to !== C.MULTICALL3) return answer;
    const list = edit(R.decodeAggregate3(answer.result, countOf(answer.result)));
    answer.result = encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: list });
    return answer;
  };
}
function countOf(hex) {
  const body = hex.slice(2);
  const off = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  return Number(BigInt(`0x${body.slice(off, off + 64)}`));
}

test("R5 one failed item nulls ONE field (never 0); the rest still read", async () => {
  /* Order: USDC AVAX WAVAX BTC.b USDT XAUt0 | aUsdc | poolAllowance | relay v3 | relay v3.2 | reserve | aTotal | virtual */
  const { fetchImpl } = replay({ mutate: editMulticall((l) => l.map((x, i) => {
    if (i === 0) return { success: false, returnData: "0x" };           // USDC balanceOf reverted
    if (i === 3) return { success: true, returnData: "0x" };            // BTC.b: "success" with no data (no code)
    if (i === 6) return { success: true, returnData: "0x" + "00".repeat(31) }; // aUSDC: 31 bytes
    return x;
  })) });
  const acc = await R.readAvaxAccount(DEAD, { fetchImpl, timers, now: fixedNow, env: {} });
  assert.equal(acc.balances.USDC, null);
  assert.equal(acc.assets[0].amount, null);
  assert.equal(acc.balances["BTC.b"], null);
  assert.equal(acc.aave.suppliedRaw, null);
  assert.equal(acc.aave.suppliedUsdc, null);
  assert.equal(acc.balances.AVAX, 99875151164936437844n);
  assert.equal(acc.balances.USDT, 218564248n);
  assert.equal(acc.problems.length, 3);
  assert.ok(acc.aave.status && acc.aave.status.apyPct > 5);
});

test("R5b the reserve unreadable → status null (no APY, no flags); the cap or liquidity unreadable → that field null", async () => {
  const a = await R.readAvaxAccount(DEAD, { fetchImpl: replay({ mutate: editMulticall((l) => l.map((x, i) => (i === 10 ? { success: false, returnData: "0x" } : x))) }).fetchImpl, timers, env: {} });
  assert.equal(a.aave.status, null);
  const b = await R.readAvaxAccount(DEAD, { fetchImpl: replay({ mutate: editMulticall((l) => l.map((x, i) => (i === 11 || i === 12 ? { success: false, returnData: "0x" } : x))) }).fetchImpl, timers, env: {} });
  assert.equal(b.aave.status.capRoomRaw, null);
  assert.equal(b.aave.status.liquidityRaw, null);
  assert.ok(b.aave.status.apyPct > 5);
  /* A reserve whose aToken is not aAvaUSDC is unreadable, not "some other reserve". */
  const c = await R.readAvaxAccount(DEAD, { fetchImpl: replay({ mutate: editMulticall((l) => l.map((x, i) => {
    if (i !== 10) return x;
    const body = x.returnData.slice(2);
    return { success: true, returnData: `0x${body.slice(0, 8 * 64)}${"0".repeat(24)}${OTHER.slice(2)}${body.slice(9 * 64)}` };
  })) }).fetchImpl, timers, env: {} });
  assert.equal(c.aave.status, null);
});

test("R5c the whole read unreadable THROWS — an empty wallet is never invented", async () => {
  await assert.rejects(R.readAvaxAccount(DEAD, { fetchImpl: replay({ status: 502 }).fetchImpl, timers, env: {} }), (e) => e.code === "http");
  await assert.rejects(R.readAvaxAccount(DEAD, { fetchImpl: replay({ mutate: (a) => ({ ...a, result: "0x1234" }) }).fetchImpl, timers, env: {} }));
  await assert.rejects(R.readAvaxAccount(DEAD, { fetchImpl: replay({ mutate: (a) => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "busy" } }) }).fetchImpl, timers, env: {} }), (e) => e.code === "rpc-error");
  await assert.rejects(R.readAvaxAccount("0xnot", { fetchImpl: replay().fetchImpl, timers, env: {} }));
  await assert.rejects(R.readAvaxAccount(C.NATIVE_TOKEN, { fetchImpl: replay().fetchImpl, timers, env: {} }));
});

test("R6 readAaveUsdcMarket and readFeeState replay the capture", async () => {
  const m = await R.readAaveUsdcMarket({ fetchImpl: replay().fetchImpl, timers });
  assert.equal(m.active && !m.frozen && !m.paused, true);
  assert.ok(m.apyPct > 5 && m.apyPct < 7);
  const f = await R.readFeeState({ fetchImpl: replay().fetchImpl, timers, now: fixedNow });
  assert.equal(f.baseFeeWei, 5000000000n);
  assert.equal(f.baseFeeGwei, 5);
  assert.equal(f.gasPriceWei, 5000000150n);
  assert.equal(f.suggestedTipWei, 150n);
  assert.equal(f.blockNumber, 97592171n);
});

test("R6b APY 5.70%: the reserve read at block 97,586,280 (R-aave §3)", () => {
  const fx = fixture("aave-reserve-97586280.json");
  const r = V3.decodeReserveData(fx.answer.result);
  assert.equal(r.currentLiquidityRate, 55436384346105595948372485n);
  assert.equal(V3.supplyApyPct(r.currentLiquidityRate).toFixed(2), "5.70");
});

/* ── whitelist ────────────────────────────────────────────────────────────── */

test("R7 whitelist: on = USDC AVAX WAVAX BTC.b USDT XAUt0; XSGD only with its flag; bUSDC and PHAR never", () => {
  assert.deepEqual([...W.SWAP_SYMBOLS], ["USDC", "AVAX", "WAVAX", "BTC.b", "USDT", "XAUt0"]);
  assert.deepEqual(W.swapSymbols({}), ["USDC", "AVAX", "WAVAX", "BTC.b", "USDT", "XAUt0"]);
  assert.deepEqual(W.swapSymbols({ VITE_SWAP_XSGD: "off" }), W.swapSymbols({}));
  assert.deepEqual(W.swapSymbols({ VITE_SWAP_XSGD: "on" }), ["USDC", "AVAX", "WAVAX", "BTC.b", "USDT", "XAUt0", "XSGD"]);
  assert.equal(W.assetBySymbol("XSGD", {}), null);
  assert.equal(W.assetBySymbol("XSGD", { VITE_SWAP_XSGD: "true" }).decimals, 6);
  for (const env of [{}, { VITE_SWAP_XSGD: "on", VITE_SWAP_BUSDC: "on", VITE_SWAP_PHAR: "on" }]) {
    for (const x of W.EXCLUDED_ASSETS) {
      assert.equal(W.assetByAddress(x.address, env), null, x.symbol);
      assert.equal(W.assetByAddress(x.address.toUpperCase().replace("0X", "0x"), env), null, x.symbol);
      assert.equal(W.assetBySymbol(x.symbol, env), null, x.symbol);
      assert.ok(!W.whitelistAssets(env).some((a) => a.address === x.address));
    }
  }
  assert.equal(W.assetBySymbol("btc.b", {}), null, "symbols are exact");
  assert.equal(W.assetByAddress(C.NATIVE_TOKEN, {}).symbol, "AVAX");
  assert.equal(W.assetByAddress("0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664", {}), null, "USDC.e is not USDC");
  assert.equal(W.assetBySymbol("USDC", {}).address, C.USDC);
  assert.deepEqual(W.erc20Assets({}).map((a) => a.symbol), ["USDC", "WAVAX", "BTC.b", "USDT", "XAUt0"]);
  assert.deepEqual(W.AVAX_ASSETS.filter(W.needsSwapBack).map((a) => a.symbol), ["WAVAX", "BTC.b", "USDT", "XAUt0", "XSGD"]);
  for (const a of W.AVAX_ASSETS) {
    assert.match(a.address, /^0x[0-9a-f]{40}$/);
    assert.ok(a.logo === null || a.logo.startsWith("/"), "local logos only");
  }
});

test("R7b whitelist pin == Relay's default Avalanche list (addresses, decimals, chain)", () => {
  const list = fixture("relay-currencies-43114.json").answer;
  assert.deepEqual(W.whitelistDrift(list), []);
  for (const a of W.AVAX_ASSETS.filter((x) => x.role !== "base")) {
    const t = list.find((x) => x.address.toLowerCase() === a.address);
    assert.ok(t, `${a.symbol} is on Relay's list`);
    assert.equal(t.decimals, a.decimals, a.symbol);
    assert.equal(t.chainId, 43114);
  }
  /* USDC, the base, is the chain's solver currency in GET /chains (not in the picker's default list). */
  const ch = fixture("relay-chains-43114.json").answer;
  const usdc = ch.erc20Currencies.find((x) => x.address === C.USDC);
  assert.ok(usdc && usdc.decimals === 6 && usdc.symbol === "USDC" && usdc.supportsPermit === true);
  assert.equal(ch.featuredTokens.find((x) => x.symbol === "WAVAX").address, W.assetBySymbol("WAVAX", {}).address);
  /* Every symbol in the default list that the pin does NOT carry stays out of every lookup. */
  for (const t of list) {
    if (!W.AVAX_ASSETS.some((a) => a.address === t.address.toLowerCase())) assert.equal(W.assetByAddress(t.address, { VITE_SWAP_XSGD: "on" }), null, t.symbol);
  }
  /* The ⚠ in the owner's screenshot is Relay's own "verified: false". */
  assert.equal(list.find((x) => x.symbol === "XAUt0").metadata.verified, false);
  assert.equal(W.assetBySymbol("XAUt0", {}).relayVerified, false);
  /* Drift is caught. */
  const drifted = list.map((x) => (x.symbol === "BTC.b" ? { ...x, decimals: 18 } : x));
  assert.deepEqual(W.whitelistDrift(drifted), ["BTC.b: decimals 18 != 8"]);
});

/* ── ownAvaxAddress ───────────────────────────────────────────────────────── */

test("R8 ownAvaxAddress: four sources must agree, Privy only; anything else is null with a reason", () => {
  const wallet = { address: USER.toUpperCase().replace("0X", "0x"), walletType: "privy" };
  const backend = { address: USER, mock: false, readOnly: false, viewAs: null };
  const ok = { wallet, backend, embeddedAddress: USER };
  assert.equal(O.ownAvaxAddress(ok), USER);
  const cases = [
    [{ ...ok, wallet: { ...wallet, walletType: "injected" } }, O.OWN_WHY.notPrivy],
    [{ ...ok, wallet: { ...wallet, walletType: undefined } }, O.OWN_WHY.notPrivy],
    [{ ...ok, wallet: { walletType: "privy" } }, O.OWN_WHY.signedOut],
    [{ ...ok, wallet: { address: C.NATIVE_TOKEN, walletType: "privy" } }, O.OWN_WHY.signedOut],
    [{ ...ok, wallet: { address: "0x123", walletType: "privy" } }, O.OWN_WHY.signedOut],
    [{ ...ok, backend: { ...backend, address: OTHER } }, O.OWN_WHY.mismatch],
    [{ ...ok, backend: { ...backend, address: null } }, O.OWN_WHY.mismatch],
    [{ ...ok, embeddedAddress: OTHER }, O.OWN_WHY.mismatch],
    [{ ...ok, embeddedAddress: null }, O.OWN_WHY.mismatch],
    [{ ...ok, backend: { ...backend, readOnly: true } }, O.OWN_WHY.viewOnly],
    [{ ...ok, backend: { ...backend, viewAs: { address: USER } } }, O.OWN_WHY.viewOnly],
    [{ ...ok, backend: { ...backend, mock: true } }, O.OWN_WHY.mock],
    [{}, O.OWN_WHY.signedOut],
    [undefined, O.OWN_WHY.signedOut],
  ];
  for (const [ctx, why] of cases) {
    const r = O.ownAvaxAddressWhy(ctx);
    assert.equal(r.own, null, JSON.stringify(ctx));
    assert.equal(r.why, why, JSON.stringify(ctx));
    assert.equal(O.ownAvaxAddress(ctx), null);
  }
  assert.equal(O.assertOwn(USER, USER.toUpperCase().replace("0X", "0x"), "recipient"), USER);
  assert.throws(() => O.assertOwn(USER, OTHER, "recipient"), (e) => e.code === "not-own" && e.field === "recipient");
  assert.throws(() => O.assertOwn(null, USER), (e) => e.code === "not-own");
  assert.throws(() => O.assertOwn(USER, undefined), (e) => e.code === "not-own");
});

/* ── prices ───────────────────────────────────────────────────────────────── */

test("R9 Relay prices replay the capture, and a bad or failed price is null — cached, never 0", async () => {
  const cache = new Map();
  const { fetchImpl, calls } = replay();
  const prices = await P.fetchRelayPrices(["AVAX", "USDC", "BTC.b", "XAUt0"], { fetchImpl, timers, now: fixedNow, cache });
  assert.equal(prices.AVAX, 9.51884);
  assert.equal(prices["BTC.b"], 80488.7534619);
  assert.equal(prices.XAUt0, 4128.12516359);
  assert.equal(calls.length, 4);
  await P.fetchRelayPrices(["AVAX"], { fetchImpl, timers, now: fixedNow, cache });
  assert.equal(calls.length, 4, "cached for 60 s");
  await P.fetchRelayPrices(["AVAX"], { fetchImpl, timers, now: () => fixedNow() + P.PRICE_TTL_MS + 1, cache });
  assert.equal(calls.length, 5, "re-read after 60 s");

  for (const bad of [{ price: 0 }, { price: -1 }, { price: "abc" }, { error: "x" }, {}, null]) {
    const v = await P.fetchRelayPrice(C.USDC, { fetchImpl: async () => ({ ok: true, json: async () => bad }), timers, cache: new Map() });
    assert.equal(v, null, JSON.stringify(bad));
  }
  assert.equal(await P.fetchRelayPrice(C.USDC, { fetchImpl: async () => { throw new Error("down"); }, timers, cache: new Map() }), null);
  assert.equal(await P.fetchRelayPrice(C.USDC, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ price: 1 }) }), timers, cache: new Map() }), null);
  assert.equal(await P.fetchRelayPrice("not-an-address", { fetchImpl: async () => { throw new Error("must not fetch"); }, timers }), null);
});

test("R9b display vs INDEPENDENT price: HL mids for AVAX/WAVAX/BTC.b, peg for stables only while pegged, PAXG band for XAUt0, none for XSGD", () => {
  const relay = { AVAX: 9.52, WAVAX: 9.51, "BTC.b": 80488, USDC: 0.9998, USDT: 0.9987, XAUt0: 4128, XSGD: 0.779 };
  const mids = { AVAX: "9.50", BTC: "80500.5", PAXG: "4135" };
  assert.deepEqual(P.displayPrice("AVAX", { relay, mids }), { usd: 9.52, source: "relay" });
  assert.deepEqual(P.displayPrice("BTC.b", { relay: {}, mids }), { usd: 80500.5, source: "hl" });
  assert.deepEqual(P.displayPrice("USDC", { relay: {}, mids: null }), { usd: 1, source: "peg" });
  assert.deepEqual(P.displayPrice("USDT", { relay: {}, mids: null }), { usd: null, source: null }, "USDT is not the base unit");
  assert.deepEqual(P.displayPrice("XAUt0", { relay: {}, mids }), { usd: null, source: null });
  assert.deepEqual(P.displayPrice("bUSDC", { relay, mids }), { usd: null, source: null });

  assert.equal(P.independentPrice("AVAX", { relay, mids }), 9.5);
  assert.equal(P.independentPrice("WAVAX", { relay, mids }), 9.5);
  assert.equal(P.independentPrice("BTC.b", { relay, mids }), 80500.5);
  assert.equal(P.independentPrice("BTC.b", { relay, mids: {} }), null, "Relay's own number is never the independent one");
  assert.equal(P.independentPrice("USDC", { relay, mids }), 1);
  assert.equal(P.independentPrice("USDT", { relay: { USDT: 0.985 }, mids }), null, "depeg > 1% refuses");
  assert.equal(P.independentPrice("USDT", { relay: {}, mids }), null);
  assert.equal(P.independentPrice("XAUt0", { relay, mids }), 4128, "inside ±3%: the lower");
  assert.equal(P.independentPrice("XAUt0", { relay: { XAUt0: 4500 }, mids }), null, "outside ±3%");
  assert.equal(P.independentPrice("XAUt0", { relay, mids: {} }), null);
  assert.equal(P.independentPrice("XSGD", { relay, mids }), null);

  assert.equal(P.usdValue(763172690n, 6, 1), 763.17269);
  assert.equal(P.usdValue(null, 6, 1), null);
  assert.equal(P.usdValue(1n, 6, null), null);
  assert.equal(P.usdValue(1n, 6, 0), null);

  /* 10 USDC → BTC.b, min out 12125 sats (R-swap q1 shape) priced independently. */
  const loss = P.swapLossPct({ from: "USDC", amountRaw: 10000000n, to: "BTC.b", minOutRaw: 12125n, relay, mids, env: {} });
  assert.ok(Math.abs(loss - (10 - 0.00012125 * 80500.5) / 10 * 100) < 1e-9);
  assert.equal(P.swapLossPct({ from: "USDC", amountRaw: 10000000n, to: "XSGD", minOutRaw: 12000000n, relay, mids, env: { VITE_SWAP_XSGD: "on" } }), null);
  assert.equal(P.swapLossPct({ from: "USDC", amountRaw: 10000000n, to: "BTC.b", minOutRaw: 12125n, relay, mids: null, env: {} }), null);
  assert.equal(P.pricesAgree(9.52, 9.5), true);
  assert.equal(P.pricesAgree(9.52, 8), false);
  assert.equal(P.pricesAgree(null, 8), false);
});

/* ── units ────────────────────────────────────────────────────────────────── */

test("R10 units: exact, cut down, never a float decision; a non-zero never prints as 0", () => {
  assert.equal(U.toRaw(10, 6), 10000000n);
  assert.equal(U.toRaw("10.123456789", 6), 10123456n, "cut down, never rounded up");
  assert.equal(U.toRaw(0.1 + 0.2, 6), 300000n);
  assert.equal(U.toRaw(0.1, 18), 100000000000000000n);
  assert.equal(U.toRaw(1.5e-7, 18), 150000000000n);
  assert.equal(U.toRaw(1e21, 6), 1000000000000000000000000000n);
  assert.equal(U.toRaw("0", 6), 0n);
  for (const bad of [-1, NaN, Infinity, "", " ", "1,000", "1e3", "-2", null, undefined, {}]) assert.equal(U.toRaw(bad, 6), null, String(bad));
  assert.equal(U.fromRaw(10123456n, 6), "10.123456");
  assert.equal(U.fromRaw(10000000n, 6), "10");
  assert.equal(U.fromRaw(30650n, 8), "0.0003065");
  assert.equal(U.fromRaw(null, 6), null);
  assert.equal(U.rawToNumber(-1n, 6), null);
  assert.equal(U.formatRaw(31331308902706384n, 18, 4), "0.0313");
  assert.equal(U.formatRaw(1n, 18, 4), "<0.0001");
  assert.equal(U.formatRaw(0n, 18, 4), "0");
  assert.equal(U.formatRaw(null, 18), "—");
});

/* ── one set of pins ──────────────────────────────────────────────────────── */

const PINS_FILE = path.join(ROOT, "src/lib/avax/relayPins.js");
test("R11 the swap/move layer's own pin table (relayPins.js, when present) agrees with config + whitelist", { skip: !fs.existsSync(PINS_FILE) && "relayPins.js not present" }, async () => {
  const RP = await import(pathToFileURL(PINS_FILE).href);
  const eq = (a, b, what) => assert.equal(String(a).toLowerCase(), String(b).toLowerCase(), what);
  if ("AVAX_CHAIN_ID" in RP) assert.equal(RP.AVAX_CHAIN_ID, C.AVAX_CHAIN_ID);
  if ("AVAX_USDC" in RP) eq(RP.AVAX_USDC, C.USDC, "USDC");
  if ("HL_DEPOSITORY" in RP) eq(RP.HL_DEPOSITORY, C.RELAY_HL_DEPOSITORY, "HL depository");
  if ("AVAX_DEPOSITORY" in RP) eq(RP.AVAX_DEPOSITORY, C.RELAY_AVAX.depository, "Avax depository");
  if ("RELAY_V3" in RP) { eq(RP.RELAY_V3.router, C.RELAY_AVAX.v3.erc20Router, "v3 router"); eq(RP.RELAY_V3.approvalProxy, C.RELAY_AVAX.v3.approvalProxy, "v3 proxy"); }
  if ("RELAY_V32" in RP) { eq(RP.RELAY_V32.router, C.RELAY_AVAX["v3.2"].erc20Router, "v3.2 router"); eq(RP.RELAY_V32.approvalProxy, C.RELAY_AVAX["v3.2"].approvalProxy, "v3.2 proxy"); }
  if ("RELAY_SOLVERS" in RP) assert.deepEqual(RP.RELAY_SOLVERS.map((s) => s.toLowerCase()), [...C.RELAY_AVAX.solvers]);
  if ("ALLOWANCE_HOLDER" in RP) eq(RP.ALLOWANCE_HOLDER, C.RELAY_AVAX.allowanceHolder, "AllowanceHolder");
  if ("MULTICALL3" in RP) eq(RP.MULTICALL3, C.MULTICALL3, "Multicall3");
  if (Array.isArray(RP.SWAP_TOKENS)) {
    for (const t of RP.SWAP_TOKENS) {
      const a = W.AVAX_ASSETS.find((x) => x.symbol === t.symbol);
      assert.ok(a, `${t.symbol} is in the whitelist`);
      eq(t.address, a.address, t.symbol);
      assert.equal(t.decimals, a.decimals, t.symbol);
    }
  }
  if (RP.SWAP_EXCLUDED) for (const [sym, addr] of Object.entries(RP.SWAP_EXCLUDED)) eq(addr, W.EXCLUDED_ASSETS.find((x) => x.symbol === sym).address, sym);
});
