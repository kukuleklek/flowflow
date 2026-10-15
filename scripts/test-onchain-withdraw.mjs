/**
 * test-onchain-withdraw — api/onchain-withdraw.js: Avalanche counts ONLY the user's own outbound USDC transfers that
 * the server read on Hyperliquid itself, each once by its tx hash; the browser can only say who.
 */
import test from "node:test";
import assert from "node:assert/strict";

const A = await import("../api/onchain-withdraw.js");
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const NOW = 1_760_000_000_000;
const h = (n) => `0x${String(n).padStart(64, "0")}`;
const ledger = [
  { time: NOW - 60_000, hash: h(1), delta: { type: "send", user: ME, destination: OTHER, token: "USDC", amount: "5.09", usdcValue: "5.09" } },
  { time: NOW - 30_000, hash: h(2), delta: { type: "withdraw", usdc: "3", nonce: 1, fee: "1" } },
  { time: NOW - 20_000, hash: h(3), delta: { type: "deposit", usdc: "50" } },
  { time: NOW - 10_000, hash: h(4), delta: { type: "send", user: OTHER, destination: ME, token: "USDC", amount: "9", usdcValue: "9" } },
  { time: NOW - 5_000, hash: h(5), delta: { type: "accountClassTransfer", usdc: "4", toPerp: false } },
  { time: NOW - 2 * 86_400_000, hash: h(6), delta: { type: "withdraw", usdc: "7", nonce: 2, fee: "1" } },
];

function fakeContract(already = []) {
  const done = new Set(already);
  const calls = [];
  return {
    calls,
    recorded: async (hash) => done.has(hash),
    recordWithdraw: async (...args) => { calls.push(args); done.add(args[3]); return { hash: `0xtx${calls.length}`, wait: async () => ({}) }; },
    accountOf: async () => "0x3333333333333333333333333333333333333333",
    predictAccount: async () => "0x3333333333333333333333333333333333333333",
    withdrawCount: async () => BigInt(done.size),
    withdrawnUsdc: async () => 8_090_000n,
  };
}
const fetchLedger = async () => ({ json: async () => ledger });

test("only the user's own outbound USDC of the last day: a send away and a withdraw; never a deposit, an incoming send, an own move, or older", () => {
  assert.deepEqual(A.withdrawalsOf(ledger, ME, NOW).map((l) => [l.hash, l.usdc]), [[h(1), 5.09], [h(2), 3]]);
});

test("each counted once, in micro-USDC, the label on the newest only; a repeat call counts nothing", async () => {
  const c = fakeContract();
  const out = JSON.parse((await A.recordOnce({ user: ME, chainId: 42161, isPrivate: true, contract: c, fetchImpl: fetchLedger, now: NOW })).body);
  assert.deepEqual(c.calls.map((a) => [a[1], a[2], a[3], a[4]]), [[5_090_000n, 0n, h(1), false], [3_000_000n, 42161n, h(2), true]]);
  assert.equal(out.counted.length, 2);
  assert.equal(out.withdrawals, 2);
  const again = JSON.parse((await A.recordOnce({ user: ME, contract: c, fetchImpl: fetchLedger, now: NOW })).body);
  assert.equal(again.counted.length, 0);
  assert.equal(c.calls.length, 2);
});

test("a bad address is refused; without the server's key and contract it is 'not configured' and counts nothing", async () => {
  assert.equal((await A.recordOnce({ user: "nope", contract: fakeContract(), fetchImpl: fetchLedger })).status, 400);
  assert.equal((await A.recordOnce({ user: ME, env: {}, fetchImpl: fetchLedger })).status, 503);
  assert.equal(A.configOf({ AVAX_RECORDER_KEY: "0x12", AVAX_FACTORY: OTHER }), null);
});
