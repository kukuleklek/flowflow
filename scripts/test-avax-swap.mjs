/**
 * test-avax-swap — SWAPS IN THE USER'S OWN AVAX WALLET, decoded down to the
 * calldata, and the three rules the owner approved (AD-9: "1.) ได้ 2.) เค 3.) ได้"):
 *   1. the minimum on the card is the one IN THE CALLDATA, and no call rides along;
 *   2. AVAX-in: recipient and refundTo are the user's own wallet;
 *   3. a worse re-quote is never signed without a new Confirm.
 * Plus the whitelist, the 0x-only route, exact approvals, the gas leg (AD-8), the
 * loss bound, the closed transactions and the run order. Plan v2 §3.11, §3.4, §3.6.
 *
 * 🔴 MONEY SAFETY. Nothing signs or sends; every sender, receipt and preflight is a
 * recorder. Fixtures: read-only Relay quotes (scripts/fixtures/avax/swap-*.json,
 * live-swap-usdc-btcb-2.json captured 2026-10-15) and GET /chains.
 *
 * Run: node --test scripts/test-avax-swap.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeFunctionData, encodeFunctionData, maxUint256 } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const SD = await imp("src/lib/avax/swapDecode.js");
const SW = await imp("src/lib/relay/swap.js");
const PINS = await imp("src/lib/avax/relayPins.js");
const FL = await imp("src/avax/flows.js");
const GAS = await imp("src/lib/avax/gas.js");

const FIX = path.join(ROOT, "scripts/fixtures/avax");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const DEAD = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ABI = SD.SWAP_ABI;

/* Who asked, for what, from each fixture's own request body (or its answer). */
function ask(fx) {
  const j = fx.response;
  const b = fx.body || {};
  return {
    json: j,
    own: b.user || j.details.sender,
    from: b.originCurrency || j.details.currencyIn.currency.address,
    to: b.destinationCurrency || j.details.currencyOut.currency.address,
    amountRaw: b.amount || j.details.currencyIn.amount,
  };
}
const parse = (fx, extra = {}) => { const a = ask(fx); return SD.parseSwapQuote(a.json, { own: a.own, from: a.from, to: a.to, amountRaw: a.amountRaw, ...extra }); };

/* Rebuild a swap's calldata after mutating its decoded calls (and keep Relay's requestId suffix). */
function rebuild(json, mutate) {
  const j = clone(json);
  const it = j.steps.find((s) => s.id === "swap").items[0].data;
  const d = decodeFunctionData({ abi: ABI, data: it.data });
  const args = [...d.args];
  const callsAt = d.functionName === "multicall" ? 0 : 2;
  const calls = args[callsAt].map((c) => ({ ...c }));
  const out = mutate({ calls, args, fn: d.functionName }) || {};
  args[callsAt] = out.calls || calls;
  it.data = encodeFunctionData({ abi: ABI, functionName: d.functionName, args }) + (out.noSuffix ? "" : j.requestId.slice(2));
  return j;
}
const call = (target, functionName, args, value = 0n) => ({ target, allowFailure: false, value, callData: encodeFunctionData({ abi: ABI, functionName, args }) });
/* Change the Settler's minAmountOut inside exec. */
function withSettlerMin(callData, min) {
  const e = decodeFunctionData({ abi: ABI, data: callData });
  const inner = decodeFunctionData({ abi: ABI, data: e.args[4] });
  const slip = { ...inner.args[0], minAmountOut: min };
  const data = encodeFunctionData({ abi: ABI, functionName: "execute", args: [slip, inner.args[1], inner.args[2]] });
  return encodeFunctionData({ abi: ABI, functionName: "exec", args: [e.args[0], e.args[1], e.args[2], e.args[3], data] });
}
const refusal = (fn, code, re) => assert.throws(fn, (e) => e.code === code && (!re || re.test(JSON.stringify(e.detail || {}) + e.message)), `${code} ${re || ""}`);

const LIVE = load("live-swap-usdc-btcb-2.json");
const OK_FIXTURES = [
  ["live-swap-usdc-btcb-2.json", "A", "BTC.b"], ["swap-q1-usdc-btcb.json", "A", "BTC.b"], ["swap-q2-usdc-wavax.json", "A", "WAVAX"],
  ["swap-q3-usdc-avax.json", "A", "AVAX"], ["swap-q4-usdc-usdt.json", "A", "USDT"], ["swap-q7-usdc-btcb-slip50.json", "A", "BTC.b"],
  ["swap-q9-usdc-btcb-topup.json", "A", "BTC.b"], ["swap-q11-btcb-usdc.json", "B", "USDC"], ["swap-q14-usdc-wavax-1000.json", "A", "WAVAX"],
  ["swap-my-q-allowance-500000.json", "A", "USDT"], ["swap-my-q-xaut0-only0x.json", "A", "XAUt0"],
  ["swap-gasleg-q-usdc-avax-300000.json", "A", "AVAX"], ["swap-gasleg-q-usdc-avax-500000.json", "A", "AVAX"],
];

test("S1) every captured 0x-route swap decodes: minimum in calldata == minimum shown, fee ≤ 0.5 %, own paid last", () => {
  for (const [f, layout, sym] of OK_FIXTURES) {
    const fx = load(f);
    const r = parse(fx);
    assert.equal(r.layout, layout, f);
    assert.equal(r.to.symbol, sym, f);
    assert.equal(r.minOutRaw, fx.response.details.currencyOut.minimumAmount, `${f}: rule 1`);
    assert.equal(r.relay, "v3");
    assert.ok(PINS.KNOWN_SETTLERS.includes(r.settler), f);
    if (r.fee) assert.ok(BigInt(r.fee.raw) * 10000n <= BigInt(r.fee.side === "in" ? r.amountRaw : BigInt(r.minOutRaw) + BigInt(r.fee.raw)) * 50n, f);
  }
  const live = parse(LIVE);
  assert.equal(live.amount, "2");
  assert.equal(live.minOut, "0.00002456");
  assert.equal(live.fee.amount, "0.003");
  assert.equal(live.fee.symbol, "USDC");
  assert.deepEqual(SD.swapWindowWords(live), { approve: "Allow exactly 2 USDC for this swap", swap: "Swap 2 USDC for at least 0.00002456 BTC.b" });
  /* The exit swap (BTC.b → USDC) pays its fee in USDC AFTER the swap: the user's minimum is net of it. */
  const exit = parse(load("swap-q11-btcb-usdc.json"));
  assert.equal(exit.fee.side, "out");
  assert.equal(exit.minOut, "9.656867");
  assert.equal(SD.swapWindowWords(parse(load("swap-q2-usdc-wavax.json"))).swap.includes("Wrapped AVAX"), true);
});

test("S2) RULE 1 — a minimum in the calldata that is not the one shown is refused, either way round", () => {
  const lower = rebuild(LIVE.response, ({ calls }) => { calls[2] = { ...calls[2], callData: withSettlerMin(calls[2].callData, 1n) }; });
  refusal(() => parse({ ...LIVE, response: lower }), "unsafe-quote", /minimum in the transaction is not the minimum shown/);
  const higherShown = clone(LIVE.response);
  higherShown.details.currencyOut.minimumAmount = "2500";
  refusal(() => parse({ ...LIVE, response: higherShown }), "unsafe-quote", /minimum/);
  const none = rebuild(LIVE.response, ({ calls }) => { calls[2] = { ...calls[2], callData: withSettlerMin(calls[2].callData, 0n) }; });
  refusal(() => parse({ ...LIVE, response: none }), "unsafe-quote", /no minimum/);
});

test("S3) RULE 1 — no call may ride along: transfers, extra payouts, a fee to a stranger or over 0.5 % are refused", () => {
  const usdc = PINS.AVAX_USDC;
  const router = PINS.RELAY_V3.router;
  const cases = [
    ["a USDC.transfer slipped in", ({ calls }) => ({ calls: [calls[0], calls[1], call(usdc, "approve", [OTHER, 1n]), calls[2], calls[3]] })],
    ["the payout to someone else", ({ calls }) => { calls[3] = call(router, "cleanupErc20s", [[PINS.SWAP_TOKENS[3].address], [OTHER], [0n], "0x"]); }],
    ["a second fee", ({ calls }) => ({ calls: [calls[0], calls[1], calls[1], calls[2], calls[3]] })],
    ["a fee to a stranger", ({ calls }) => { calls[1] = call(router, "cleanupErc20s", [[usdc], [OTHER], [3000n], "0x"]); }],
    ["a fee over 0.5 %", ({ calls }) => { calls[1] = call(router, "cleanupErc20s", [[usdc], [PINS.RELAY_SOLVERS[0]], [20000n], "0x"]); }],
    ["the payout not the whole balance", ({ calls }) => { calls[3] = call(router, "cleanupErc20s", [[PINS.SWAP_TOKENS[3].address], [DEAD], [1n], "0x"]); }],
    ["the router approves a stranger", ({ calls }) => { calls[0] = call(usdc, "approve", [OTHER, 2000000n]); }],
    ["the router approves more than the swap", ({ calls }) => { calls[0] = call(usdc, "approve", [PINS.ALLOWANCE_HOLDER, maxUint256]); }],
    ["a call allowed to fail", ({ calls }) => { calls[3] = { ...calls[3], allowFailure: true }; }],
    ["refundTo someone else", ({ args }) => { args[3] = OTHER; }],
    ["nftRecipient someone else", ({ args }) => { args[4] = OTHER; }],
    ["another amount pulled", ({ args }) => { args[1] = [2000001n]; }],
  ];
  for (const [what, m] of cases) {
    const j = rebuild(LIVE.response, m);
    assert.throws(() => parse({ ...LIVE, response: j }), (e) => e.code === "unsafe-quote" || e.code === "swap-unavailable", what);
  }
  /* The trailing bytes may be the requestId and nothing else (none at all is canonical too). */
  assert.equal(parse({ ...LIVE, response: rebuild(LIVE.response, () => ({ noSuffix: true })) }).minOut, "0.00002456");
  const j = clone(LIVE.response);
  const it = j.steps[1].items[0].data;
  it.data = it.data.slice(0, -64) + "ff".repeat(32);
  refusal(() => parse({ ...LIVE, response: j }), "unsafe-quote", /bytes it should not/);
});

test("S4) the approval is EXACT, to the proxy the swap goes to — never unlimited, never Permit2", () => {
  const mut = (fn) => { const j = clone(LIVE.response); fn(j.steps[0].items[0].data, j); return j; };
  const enc = (spender, amt) => encodeFunctionData({ abi: ABI, functionName: "approve", args: [spender, amt] });
  const cases = [
    [mut((d) => { d.data = enc(PINS.RELAY_V3.approvalProxy, maxUint256); }), /exactly/],
    [mut((d) => { d.data = enc(PINS.RELAY_V3.approvalProxy, 2000001n); }), /exactly/],
    [mut((d) => { d.data = enc(PINS.RELAY_V32.approvalProxy, 2000000n); }), /someone other than the swap/],
    [mut((d) => { d.data = enc(OTHER, 2000000n); }), /someone other/],
    [mut((d) => { d.to = PINS.SWAP_TOKENS[3].address; }), /another token/],
    [mut((d) => { d.value = "1"; }), /value/],
    [mut((d) => { d.data += "00"; }), /plain approve|bytes/],
    [mut((d) => { d.chainId = 1; }), /another network/],
    [mut((d) => { d.from = OTHER; }), /another wallet/],
  ];
  for (const [j, re] of cases) refusal(() => parse({ ...LIVE, response: j }), "unsafe-quote", re);
  /* usePermit answers (unlimited Permit2 approve + a signature step) are refused outright. */
  refusal(() => parse(load("swap-q5-usdc-avax-permit.json")), "unsafe-quote", /not a plain swap/);
  /* The approve absent because an allowance already exists is fine (proven live, R-swap Verification). */
  assert.equal(parse(load("swap-my-q-allowance-500000.json")).needsApprove, false);
});

test("S5) only the 0x route: a Magpie route (undecodable) is 'Swap unavailable', never signed", () => {
  for (const f of ["swap-q8-usdc-xaut0.json", "swap-q6-usdc-btcb-permit.json", "swap-my-q-usdc-btcb.json"]) {
    refusal(() => parse(load(f)), "swap-unavailable");
  }
  const body = SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "XAUt0", amountRaw: "2000000" });
  assert.deepEqual(body.includedSwapSources, ["0x"]);
  /* A route label that says 0x but calldata that does not go through the allowance holder is refused too. */
  const j = rebuild(LIVE.response, ({ calls }) => { calls[2] = { ...calls[2], target: OTHER }; });
  refusal(() => parse({ ...LIVE, response: j }), "unsafe-quote", /allowance holder/);
});

test("S6) RULE 2 — AVAX in: refundTo / nftRecipient 0x0 (every live answer) → Swap unavailable; the user's own → decoded", () => {
  const fx = load("swap-q12-avax-usdc.json");
  refusal(() => parse(fx), "swap-unavailable", /refund to your own wallet/);
  const fixed = rebuild(fx.response, ({ args }) => { args[1] = DEAD; args[2] = DEAD; });
  const r = parse({ ...fx, response: fixed });
  assert.equal(r.from.symbol, "AVAX");
  assert.equal(r.minOutRaw, "9584266");
  assert.equal(r.fee.side, "in");
  assert.equal(r.txs[0].value, "0xde0b6b3a7640000");
  /* …and the rest of the rules still bind: the AVAX sent must add up, the payout must be the user's. */
  const evil = rebuild(fx.response, ({ args, calls }) => { args[1] = DEAD; args[2] = DEAD; calls[2] = call(PINS.RELAY_V3.router, "cleanupErc20s", [[PINS.AVAX_USDC], [OTHER], [0n], "0x"]); });
  refusal(() => parse({ ...fx, response: evil }), "unsafe-quote", /your wallet/);
  const leak = rebuild(fx.response, ({ args, calls }) => { args[1] = DEAD; args[2] = DEAD; calls[0] = call(PINS.RELAY_V3.router, "cleanupNative", [1600000000000000n, PINS.RELAY_SOLVERS[0], "0x"]); });
  refusal(() => parse({ ...fx, response: leak }), "unsafe-quote");
});

test("S7) RULE 3 — a re-quote that is worse in ANY way the card printed needs a new Confirm; never signed", () => {
  const shown = parse(LIVE);
  assert.deepEqual(SW.compareRequote(shown, parse(LIVE)), { sign: true, needsConfirm: false, why: null });
  const lowerMin = clone(LIVE.response);
  const lowered = rebuild(lowerMin, ({ calls }) => { calls[2] = { ...calls[2], callData: withSettlerMin(calls[2].callData, 2455n) }; });
  lowered.details.currencyOut.minimumAmount = "2455";
  assert.equal(SW.compareRequote(shown, parse({ ...LIVE, response: lowered })).why, "min-lower");
  const gasier = clone(LIVE.response);
  gasier.steps[1].items[0].data.gas = "900000";
  assert.equal(SW.compareRequote(shown, parse({ ...LIVE, response: gasier })).why, "gas-higher");
  const noGas = clone(LIVE.response);
  delete noGas.steps[1].items[0].data.gas;
  assert.equal(SW.compareRequote(shown, parse({ ...LIVE, response: noGas })).why, "gas-higher", "a missing gas reads as the 1,000,000 fallback");
  assert.equal(SW.compareRequote(shown, null).why, "not-decodable");
  const noApprove = parse(load("swap-my-q-allowance-500000.json"));
  assert.equal(SW.compareRequote(noApprove, noApprove).sign, true);
  const withApprove = { ...noApprove, needsApprove: true };
  assert.equal(SW.compareRequote(noApprove, withApprove).why, "extra-window");
  assert.equal(SW.compareRequote(shown, parse(load("swap-q1-usdc-btcb.json"))).why, "different-swap");
  const better = clone(LIVE.response);
  const b2 = rebuild(better, ({ calls }) => { calls[2] = { ...calls[2], callData: withSettlerMin(calls[2].callData, 2460n) }; });
  b2.details.currencyOut.minimumAmount = "2460";
  assert.equal(SW.compareRequote(shown, parse({ ...LIVE, response: b2 })).sign, true, "a better minimum may be signed");
  /* The card's freshness: older than 60 s → re-quote first. */
  assert.equal(SW.swapFresh(shown, shown.quotedAt + 59_000), true);
  assert.equal(SW.swapFresh(shown, shown.quotedAt + 61_000), false);
});

test("S8) the DEX contract must be a 0x Settler this app trusts (pinned pair, or the pair read from 0x's registry)", () => {
  refusal(() => parse(LIVE, { settlers: ["0x5fd781c190aa767f97298cf3f53f9aa9823d9599"] }), "swap-unavailable", /trusts/);
  assert.equal(parse(LIVE, { settlers: SD.trustedSettlersFrom([`0x${"0".repeat(24)}d377ac1acb5d89683257347827dc9ba9ef166f01`]) }).settler, "0xd377ac1acb5d89683257347827dc9ba9ef166f01");
  const calls = SD.settlerRegistryCalls();
  assert.deepEqual(calls.map((c) => [c.to, c.data.slice(0, 10)]), [[PINS.SETTLER_DEPLOYER, "0x6352211e"], [PINS.SETTLER_DEPLOYER, "0xe2603dc2"]]);
  assert.deepEqual(SD.trustedSettlersFrom(["0x", null, "garbage"]), [...PINS.KNOWN_SETTLERS], "an unreadable registry falls back to the pinned pair, never to 'anything'");
  /* The live read of 2026-10-15 (ownerOf(2), prev(2)) is exactly the pinned pair. */
  assert.deepEqual(SD.trustedSettlersFrom([
    "0x0000000000000000000000005fd781c190aa767f97298cf3f53f9aa9823d9599",
    "0x000000000000000000000000d377ac1acb5d89683257347827dc9ba9ef166f01",
  ]).sort(), [...PINS.KNOWN_SETTLERS].sort());
});

test("S9) the whitelist: six on, XSGD off, bUSDC / PHAR impossible; pins equal Relay's /chains and the read track's tables", async () => {
  assert.deepEqual(PINS.SWAP_TOKENS.filter((t) => t.on).map((t) => t.symbol), ["USDC", "AVAX", "WAVAX", "BTC.b", "USDT", "XAUt0"]);
  refusal(() => parse(load("swap-q13-usdc-xsgd.json")), "not-whitelisted");
  for (const bad of ["PHAR", "bUSDC", PINS.SWAP_EXCLUDED.PHAR, PINS.SWAP_EXCLUDED.bUSDC, "XSGD", "ETH"]) {
    assert.throws(() => SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: bad, amountRaw: "1000000" }), (e) => e.code === "not-whitelisted", bad);
  }
  assert.throws(() => SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "USDC", amountRaw: "1000000" }), (e) => e.code === "same-asset");
  assert.deepEqual(PINS.relayPinProblems(load("relay-chains.json").response), []);
  const tampered = clone(load("relay-chains.json").response);
  tampered.chains.find((c) => c.id === 43114).contracts["v3.2"].approvalProxy = OTHER;
  tampered.chains.find((c) => c.id === 1337).protocol.v2.depository = OTHER;
  assert.deepEqual(PINS.relayPinProblems(tampered), ["v3.2 approval proxy differs", "hyperliquid depository differs"]);
  /* The read track's own tables (lib/avax/config.js, whitelist.js) must say the same thing. */
  const cfgPath = path.join(ROOT, "src/lib/avax/config.js");
  const wlPath = path.join(ROOT, "src/lib/avax/whitelist.js");
  if (fs.existsSync(cfgPath)) {
    const C = await import(pathToFileURL(cfgPath).href);
    if (C.RELAY_AVAX) {
      assert.equal(C.RELAY_AVAX.v3.erc20Router, PINS.RELAY_V3.router);
      assert.equal(C.RELAY_AVAX.v3.approvalProxy, PINS.RELAY_V3.approvalProxy);
      assert.equal(C.RELAY_AVAX["v3.2"].erc20Router, PINS.RELAY_V32.router);
      assert.equal(C.RELAY_AVAX["v3.2"].approvalProxy, PINS.RELAY_V32.approvalProxy);
      assert.equal(C.RELAY_AVAX.depository, PINS.AVAX_DEPOSITORY);
      assert.deepEqual([...C.RELAY_AVAX.solvers], [...PINS.RELAY_SOLVERS]);
      assert.equal(C.RELAY_AVAX.allowanceHolder, PINS.ALLOWANCE_HOLDER);
    }
    if (C.RELAY_HL_DEPOSITORY) assert.equal(C.RELAY_HL_DEPOSITORY, PINS.HL_DEPOSITORY);
    if (C.USDC) assert.equal(C.USDC, PINS.AVAX_USDC);
    if (C.MULTICALL3) assert.equal(C.MULTICALL3, PINS.MULTICALL3);
  }
  if (fs.existsSync(wlPath)) {
    const W = await import(pathToFileURL(wlPath).href);
    if (Array.isArray(W.AVAX_ASSETS)) {
      for (const t of PINS.SWAP_TOKENS) {
        const a = W.AVAX_ASSETS.find((x) => x.symbol === t.symbol);
        assert.ok(a, `${t.symbol} is in the read track's whitelist`);
        assert.equal(a.address, t.address, t.symbol);
        assert.equal(a.decimals, t.decimals, t.symbol);
      }
      assert.equal(W.AVAX_ASSETS.length, PINS.SWAP_TOKENS.length, "no asset the swap parser does not know");
    }
  }
});

test("S10) the swap body: own in every role, EXACT_INPUT, explicit slippage, 0x only — nothing else", () => {
  const b = SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "BTC.b", amountRaw: 2000000n });
  assert.deepEqual(b, {
    user: DEAD, recipient: DEAD, refundTo: DEAD, originChainId: 43114, destinationChainId: 43114,
    originCurrency: PINS.AVAX_USDC, destinationCurrency: "0x152b9d0fdc40c096757f570a51e494bd4b943e50",
    amount: "2000000", tradeType: "EXACT_INPUT", slippageTolerance: "100", includedSwapSources: ["0x"],
  });
  assert.equal(SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "USDT", amountRaw: "1000000" }).slippageTolerance, "30");
  assert.equal(SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "BTC.b", amountRaw: "1000000", slippageBps: 500 }).slippageTolerance, "100", "a caller may tighten, never widen");
  assert.equal(SW.buildSwapQuoteBody({ own: DEAD, from: "USDC", to: "BTC.b", amountRaw: "1000000", slippageBps: 50 }).slippageTolerance, "50");
  /* The answer's slippage may not be wider than asked. */
  refusal(() => parse(LIVE, { slippageBps: 50 }), "unsafe-quote", /slippage/);
  /* The live capture was made with exactly this body. */
  assert.deepEqual(LIVE.body, b);
});

test("S11) AD-8 gas leg: $0.20–0.50 of the user's own USDC → AVAX, same parser, row 'from your USDC' sized from the decoded minimum", () => {
  const body = SW.buildGasLegQuoteBody({ own: DEAD, topupUsd: 0.3 });
  assert.equal(body.amount, "300000");
  assert.equal(body.destinationCurrency, PINS.NATIVE);
  assert.equal(body.topupGas, undefined, "topupGas is ignored on a same-chain swap, so it is never sent");
  assert.equal(body.usePermit, undefined, "permit = unlimited Permit2 approve");
  assert.throws(() => SW.buildGasLegQuoteBody({ own: DEAD, topupUsd: 0.6 }), (e) => e.code === "bad-topup");
  const fx = load("swap-gasleg-q-usdc-avax-300000.json");
  const r = SW.parseGasLegQuote(fx.response, { own: DEAD, topupUsd: 0.3 });
  assert.equal(r.purpose, "gas-leg");
  assert.equal(r.gasRow.avaxWei, BigInt(r.minOutRaw));
  assert.equal(r.gasRow.source, "usdc");
  assert.match(r.gasRow.text, /^Gas for later ≈0\.031\d* AVAX \(\$0\.30\) · from your USDC/);
  assert.equal(GAS.gasRowProblem({ gasLeg: true, gasRow: r.gasRow }), null);
  assert.equal(GAS.gasRowProblem({ gasLeg: true, gasRow: null }), "Gas for later is missing from the card");
  assert.throws(() => SW.parseGasLegQuote(fx.response, { own: DEAD, topupUsd: 0.5 }), (e) => e.code === "unsafe-quote", "the leg is exactly the size asked");
});

test("S12) the loss bound uses an INDEPENDENT price; unknown price refuses, over 2 % refuses", () => {
  const r = parse(LIVE);
  assert.deepEqual(SW.swapLossCheck({ review: r, priceInUsd: 1, priceOutUsd: null }).code, "no-price");
  assert.equal(SW.swapLossCheck({ review: r, priceInUsd: undefined, priceOutUsd: 81000 }).code, "no-price");
  const ok = SW.swapLossCheck({ review: r, priceInUsd: 1, priceOutUsd: 81000 });
  assert.equal(ok.ok, true);
  assert.ok(ok.lossPct > 0 && ok.lossPct < 2);
  const bad = SW.swapLossCheck({ review: r, priceInUsd: 1, priceOutUsd: 78000 });
  assert.equal(bad.code, "loss");
  assert.equal(SW.swapLossCheck({ review: r, priceInUsd: 1, priceOutUsd: 81000, maxLossPct: 9 }).lossPct, ok.lossPct, "env may not widen it");
  assert.equal(SW.swapLossCheck({ review: r, priceInUsd: 1, priceOutUsd: 79600, maxLossPct: 9 }).ok, false);
  assert.equal(SW.pricesAgree(4141.7, 4100), true);
  assert.equal(SW.pricesAgree(4141.7, 3900), false);
  assert.equal(SW.pricesAgree(4141.7, null), false);
});

test("S13) the transactions handed to the closed builder carry OUR gas limit and fee cap, chain 43114", () => {
  const r = parse(LIVE);
  const txs = SW.swapTxRequests(r, { maxFeePerGasWei: 11_000_000_001n });
  assert.deepEqual(txs.map((t) => [t.purpose, t.chainId, t.to, t.value, t.gas, t.maxFeePerGas, t.maxPriorityFeePerGas]), [
    ["approve", 43114, PINS.AVAX_USDC, "0x0", `0x${(73112).toString(16)}`, `0x${(11_000_000_001).toString(16)}`, `0x${(1_000_000_000).toString(16)}`],
    ["swap", 43114, PINS.RELAY_V3.approvalProxy, "0x0", `0x${(561858).toString(16)}`, `0x${(11_000_000_001).toString(16)}`, `0x${(1_000_000_000).toString(16)}`],
  ]);
  assert.equal(SW.swapUpfrontWei(r, 12_000_000_000n), (73112n + 561858n) * 12_000_000_000n);
  /* The item with no gas gets the fallback, and is marked estimated. */
  const noGas = parse(load("swap-my-q-allowance-500000.json"));
  assert.deepEqual(SD.swapGasUnits(noGas), { approve: 0, swap: 1_000_000, estimated: true });
  assert.equal(SW.swapTxRequests(noGas, { maxFeePerGasWei: 10n ** 10n })[0].gas, "0xf4240");
  assert.equal(SW.swapTxRequests(r, { maxFeePerGasWei: null }), null, "unknown fee cap → no transaction");
});

test("S14) Remove allowance: approve(known spender, 0) on a whitelisted token, nothing else", () => {
  const tx = SW.buildRemoveAllowanceTx({ token: "USDC", spender: PINS.RELAY_V3.approvalProxy });
  assert.equal(tx.to, PINS.AVAX_USDC);
  assert.equal(tx.data, encodeFunctionData({ abi: ABI, functionName: "approve", args: [PINS.RELAY_V3.approvalProxy, 0n] }));
  assert.equal(SW.buildRemoveAllowanceTx({ token: "BTC.b", spender: PINS.RELAY_V32.approvalProxy }).to, "0x152b9d0fdc40c096757f570a51e494bd4b943e50");
  assert.throws(() => SW.buildRemoveAllowanceTx({ token: "USDC", spender: OTHER }), (e) => e.code === "bad-spender");
  assert.throws(() => SW.buildRemoveAllowanceTx({ token: "AVAX", spender: PINS.RELAY_V3.approvalProxy }), (e) => e.code === "not-whitelisted");
  assert.throws(() => SW.buildRemoveAllowanceTx({ token: PINS.SWAP_EXCLUDED.PHAR, spender: PINS.RELAY_V3.approvalProxy }), (e) => e.code === "not-whitelisted");
});

/* ── the run ──────────────────────────────────────────────────────────────── */

class MemStorage {
  constructor() { this.m = new Map(); this.drop = false; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (!this.drop) this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const HASH = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;

function swapRig({ review = parse(LIVE), sendTx, waitReceipt, preflight, storage = new MemStorage() } = {}) {
  const t = { now: review.quotedAt + 1000 };
  const reg = FL.createFlowRegistry({ storage, own: DEAD, now: () => t.now });
  const rec = reg.begin({ kind: "swap", amounts: { in: review.amount, min: review.minOut } });
  assert.equal(reg.confirm(rec.id).ok, true);
  const log = [];
  let n = 0;
  const o = {
    review, ownNow: () => DEAD, maxFeePerGasWei: 11_000_000_000n, flow: reg.handle(rec.id), now: () => t.now,
    words: SD.swapWindowWords(review),
    readPendingNonce: async () => 7,
    sendTx: sendTx || (async (tx, { words }) => { const st = reg.get(rec.id); log.push(["send", tx.purpose, st.state, st.step, words]); n += 1; return HASH(n); }),
    waitReceipt: waitReceipt || (async (h) => { log.push(["receipt", h.slice(0, 4)]); return { status: 1 }; }),
    preflight: preflight || (async (tx) => { log.push(["preflight", tx.purpose]); return { ok: true }; }),
  };
  return { o, reg, rec, log, t, storage };
}

test("S15) executeSwap: registry → approve → receipt → eth_call preflight → registry → swap → receipt", async () => {
  const { o, reg, rec, log } = swapRig();
  const r = await SW.executeSwap(o);
  assert.equal(r.ok, true);
  assert.deepEqual(log.map((x) => x.slice(0, 2)), [["send", "approve"], ["receipt", "0x11"], ["preflight", "swap"], ["send", "swap"], ["receipt", "0x22"]]);
  assert.deepEqual(log[0].slice(2), ["sending", "approve", "Allow exactly 2 USDC for this swap"]);
  assert.deepEqual(log[3].slice(2), ["sending", "swap", "Swap 2 USDC for at least 0.00002456 BTC.b"]);
  const after = reg.get(rec.id);
  assert.equal(after.state, "arriving");
  assert.equal(after.approveTx, HASH(1));
  assert.equal(after.swapTx, HASH(2));
  assert.equal(after.txNonce, 7);
});

test("S15b) executeSwap failure words (plan §3.6): price moved, allowed-not-swapped, unknown — never a retry", async () => {
  /* Preflight reverts after the approve: the swap window never opens, the allowance is named. */
  let rig = swapRig({ preflight: async () => ({ ok: false }) });
  let r = await SW.executeSwap(rig.o);
  assert.equal(r.message, "Price moved. Nothing was swapped. Allowed but not swapped.");
  assert.equal(r.allowanceLeft, true);
  assert.equal(rig.log.filter((x) => x[0] === "send").length, 1);
  assert.equal(rig.reg.get(rig.rec.id).state, "error-before-money");
  /* The user closes the swap window. */
  let k = 0;
  rig = swapRig({ sendTx: async (tx) => { k += 1; if (tx.purpose === "swap") { const e = new Error("User rejected the request"); e.code = 4001; throw e; } return HASH(k); } });
  r = await SW.executeSwap(rig.o);
  assert.equal(r.message, "Allowed but not swapped.");
  /* A throw with no hash that is not a refusal: UNKNOWN. */
  rig = swapRig({ sendTx: async (tx) => { if (tx.purpose === "swap") throw new Error("network error"); return HASH(3); } });
  r = await SW.executeSwap(rig.o);
  assert.equal(r.unknown, true);
  assert.equal(r.message, "Not confirmed yet. Don't send it again.");
  assert.equal(rig.reg.get(rig.rec.id).state, "unknown");
  /* No receipt in time: UNKNOWN with the hash. */
  rig = swapRig({ waitReceipt: async (h) => (h === HASH(2) ? null : { status: 1 }) });
  r = await SW.executeSwap(rig.o);
  assert.equal(r.unknown, true);
  assert.equal(r.txHash, HASH(2));
  /* The swap reverts on chain (slippage): nothing swapped, gas only. */
  rig = swapRig({ waitReceipt: async (h) => ({ status: h === HASH(2) ? 0 : 1 }) });
  r = await SW.executeSwap(rig.o);
  assert.equal(r.message, "Price moved. Nothing was swapped.");
  /* The registry cannot be written: no window at all. */
  const storage = new MemStorage();
  rig = swapRig({ storage });
  storage.drop = true;
  r = await SW.executeSwap(rig.o);
  assert.equal(r.code, "registry");
  assert.equal(rig.log.length, 0);
  /* A stale price asks for a re-quote (rule 3 then decides), nothing sent. */
  rig = swapRig();
  rig.t.now += 61_000;
  r = await SW.executeSwap(rig.o);
  assert.equal(r.needsRequote, true);
  assert.equal(rig.log.length, 0);
});

test("S16) the parser is pure: Node imports it with no window, no env, no network", () => {
  assert.equal(typeof globalThis.window, "undefined");
  for (const [sel, name] of Object.entries(SD.SELECTORS)) assert.match(sel === "approve" ? name : name, /^0x[0-9a-f]{8}$/, sel);
  assert.equal(SD.formatRaw(12137n, 8), "0.00012137");
  assert.equal(SD.formatRaw("1000000000000000000", 18), "1");
  assert.equal(SD.toRaw("0.3", 6), 300000n);
  assert.equal(SD.toRaw("1.0000001", 6), null);
});
