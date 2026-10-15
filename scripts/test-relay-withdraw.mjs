/**
 * test-relay-withdraw — WITHDRAWING USDC OUT OF THE PERP ACCOUNT THROUGH RELAY,
 * to many chains, to the user's own address or to one they pasted.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-22 (test deploy): "ขา Withdraw ... ทำไมขาออกมัน Relay ไม่ได้
 * อะ ขาออกแพงชิบหาย" / "มันถูกสัสๆเลย Relay อะ Hypercore > ออกมา" / "แล้วมันควรต้อง
 * ออกได้หลายเชนด้วยนะ" / "withdraw คือให้ใส่ เลข Wallet ได้ด้วยดิวะ".
 *
 * 🔴 MONEY SAFETY. Nothing here signs anything, holds a key, or posts to
 * Hyperliquid: every fetch goes through a mock that records it, and the signer
 * and the sendAsset are recorders. The fixtures are LIVE Relay answers:
 *   scripts/fixtures/relay-withdraw-arb-5.json   POST /quote/v2, 2026-09-22,
 *      5 USDC out of 1337 (USDC Perps, 8 decimals) to Arbitrum USDC, and the
 *      TWO steps it answers: "authorize" (eip712 + where to POST it) and
 *      "deposit" (a Hyperliquid sendAsset to Relay's depository on HyperCore).
 *   the /chains subset below   live GET https://api.relay.link/chains, same day.
 *
 * Run: node --test scripts/test-relay-withdraw.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256, toUtf8Bytes, getAddress } from "ethers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = await import(pathToFileURL(path.join(ROOT, "src/lib/relay/withdraw.js")).href);

/* Public, well-known development addresses (no key is used anywhere here). */
const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEAD = "0x000000000000000000000000000000000000dEaD";

const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/relay-withdraw-arb-5.json"), "utf8"));
const QUOTED_AT = FIX.capturedAt;
/** The live answer as Relay would give it to `user`: every dEaD becomes that address. */
const quoteFor = (user = USER, recipient = user, mutate = null) => {
  const j = JSON.parse(JSON.stringify(FIX.response).replace(/0x000000000000000000000000000000000000dEaD/gi, (m) => m));
  const swap = (v) => (typeof v === "string" && /^0x0{36}dead$/i.test(v) ? v : v);
  void swap;
  const text = JSON.stringify(j)
    .replace(/"0x000000000000000000000000000000000000dEaD"/gi, `"${user}"`);
  const out = JSON.parse(text);
  /* The recipient side of the answer, where it differs from the user.

     THE REFUNDS ARE SHAPED THE WAY THE LIVE ANSWER SHAPES THEM, which is the whole
     point of this pair. Measured 2026-09-23 (read-only quotes to Optimism and to
     Avalanche) and in the captured fixture: the order input declares TWO refunds —
     one on the ORIGIN chain in the origin currency, which mirrors the input and is
     refundTo, i.e. this wallet; and one on the DESTINATION chain in the destination
     currency, carrying the output's own deadline and extraData, which mirrors the
     output, i.e. the RECIPIENT. This file used to rewrite that second one to the
     user, and that assumption is why a withdrawal to a pasted address — the only
     case where the two differ — was refused on the owner's screen while every test
     passed (IMG_3248, 2026-09-23: "ถอนไม่ได้อะ"). */
  if (recipient !== user) {
    out.details.recipient = recipient;
    out.protocol.v2.orderData.output.payments = out.protocol.v2.orderData.output.payments.map((p) => ({ ...p, recipient }));
    out.protocol.v2.orderData.inputs[0].refunds = out.protocol.v2.orderData.inputs[0].refunds
      .map((r) => (String(r.chainId) === "hyperliquid" ? r : { ...r, recipient }));
  }
  if (mutate) mutate(out);
  return out;
};

/* ── live GET https://api.relay.link/chains, 2026-09-22 (the destinations) ── */
const LIVE_CHAINS = [
  { id: 42161, name: "arbitrum", vmType: "evm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 }, { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 }] },
  { id: 8453, name: "base", vmType: "evm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 }] },
  { id: 10, name: "optimism", vmType: "evm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 }] },
  { id: 137, name: "polygon", vmType: "evm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 }] },
  /* Avalanche, read live on 2026-09-23 (owner: "ขอเอา Avax เข้ามาด้วยดิ"). Its solver
     currencies that day were USDC and USDe — no USDT — which is why the table offers
     only USDC here. */
  { id: 43114, name: "avalanche", vmType: "evm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDC", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
      { symbol: "USDe", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 }] },
  { id: 1, name: "ethereum", vmType: "evm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 }] },
  { id: 56, name: "bsc", vmType: "evm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 }, { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 }] },
  { id: 1337, name: "hyperliquid", vmType: "hypevm", depositEnabled: true, disabled: false,
    solverCurrencies: [{ symbol: "USDC", address: "0x00000000000000000000000000000000", decimals: 8 }] },
];

const routeOf = (id) => W.withdrawRouteById(id);
const ARB = routeOf("arbitrum-usdc");
const keccak = (hex) => keccak256(toUtf8Bytes(hex)).slice(2);

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method || "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : null });
    return handler(String(url), init, calls.length);
  };
  f.calls = calls;
  return f;
}
const noTimers = { setTimeout: () => null, clearTimeout: () => {} };
const quoteArgs = (over = {}) => ({
  user: USER, recipient: USER, route: ARB, amountUsdc: 5,
  now: () => QUOTED_AT, timers: noTimers, network: "mainnet", ...over,
});

/* ════════════════════════════════════════════════════════════════════════════
   W. the table and the quote
   ════════════════════════════════════════════════════════════════════════════ */

test("W1) the destinations are live Relay solver currencies, in the owner's order with Base first", () => {
  assert.deepEqual(W.withdrawRouteProblems(LIVE_CHAINS), [], "the withdraw table disagrees with the live chains list");
  /* Owner, 2026-09-23: "เรียงเชนใหม่ BASE , AVAX อื่นๆตามมา", for both money screens.
     The first row is the default, so a withdrawal now starts on Base. He was told
     what that costs: live quotes on 5 USDC out were about $0.005 to Arbitrum and
     about $0.027 to Base, and the picker shows the fee per destination. */
  assert.equal(W.DEFAULT_WITHDRAW_ROUTE_ID, "base-usdc");
  assert.equal(W.withdrawRouteById(W.DEFAULT_WITHDRAW_ROUTE_ID), W.PERP_WITHDRAW_ROUTES[0]);
  assert.equal(ARB.chainName, "Arbitrum");
  assert.deepEqual(W.PERP_WITHDRAW_ROUTES.map((r) => r.id), [
    "base-usdc", "avalanche-usdc", "arbitrum-usdc", "optimism-usdc", "polygon-usdc", "ethereum-usdc", "bnb-usdc", "bnb-usdt",
  ]);
  for (const r of W.PERP_WITHDRAW_ROUTES) assert.ok(r.chainLogo && r.chainLogo.startsWith("/chain-logos/"), `${r.id} wears its chain's logo`);
  /* A chain that goes down takes its own route out, and says so. */
  const off = JSON.parse(JSON.stringify(LIVE_CHAINS));
  off.find((c) => c.id === 8453).disabled = true;
  assert.deepEqual(W.withdrawRouteProblems(off, routeOf("base-usdc")), ["base-usdc: chain 8453 is missing or off"]);
  assert.deepEqual(W.withdrawRouteProblems(off, ARB), [], "Arbitrum is untouched by Base being off");
  assert.ok(W.withdrawRouteProblems(null).length > 0, "no chains list is not a pass");
});

test("W2) the quote body: out of 1337 USDC (Perps) at 8 decimals, EXACT_INPUT, user = the wallet, recipient = the destination, refundTo = the wallet", () => {
  const body = W.buildWithdrawQuoteBody({ user: USER, recipient: OTHER, route: ARB, amountUsdc: "5" });
  assert.deepEqual(body, {
    user: USER,
    recipient: OTHER,
    refundTo: USER,
    originChainId: 1337,
    originCurrency: "0x00000000000000000000000000000000",
    destinationChainId: 42161,
    destinationCurrency: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    amount: "500000000",
    tradeType: "EXACT_INPUT",
  });
  assert.deepEqual(body.amount, FIX.body.amount, "the live body asked for exactly this");
  assert.equal(W.usdcToRelayUnits("20"), "2000000000");
  assert.equal(W.usdcToRelayUnits("0.12345678"), "12345678");
  assert.equal(W.usdcToRelayUnits("1.123456789"), null, "more decimals than the origin has");
  assert.equal(W.usdcToRelayUnits("0"), null);
  assert.equal(W.usdcToRelayUnits("abc"), null);
});

test("W3) 🔴 the live answer parses: two steps, the depository read FROM THE QUOTE, the fee, what arrives, and the time", async () => {
  const q = W.parseWithdrawQuote(quoteFor(), { user: USER, recipient: USER, route: ARB, amountUsdc: 5, now: QUOTED_AT, network: "mainnet" });
  assert.equal(q.amountUsdc, 5);
  assert.equal(q.receiveAmount, 4.995497);
  assert.equal(q.feeUsdc, 0.004503);
  assert.equal(q.timeEstimateSec, 1);
  assert.equal(q.recipient, USER);
  assert.equal(q.depository, "0x66cf0aace1b4e562593bec10ec7868fba9932224");
  assert.equal(q.sendAsset.destination, "0x66cf0aace1b4e562593bec10ec7868fba9932224", "the sendAsset pays the order's own depository");
  assert.equal(q.sendAsset.amount, "5.000000");
  assert.equal(q.sendAsset.token, "USDC:0x6d1e7cde53ba9467b783cb7c530ce054");
  assert.equal(q.sendAsset.hyperliquidChain, "Mainnet");
  assert.equal(q.sendAsset.nonce, q.authorize.message.nonce);
  assert.equal(q.authorize.primaryType, "NonceMapping");
  assert.equal(q.authorize.domain.name, "RelayNonceMapping");
  assert.equal(q.authorize.endpoint, "/authorize");
  assert.equal(q.authorize.method, "POST");
  assert.equal(q.authorize.body.type, "nonce-mapping");
  assert.equal(q.statusEndpoint, `/intents/status/v3?requestId=${q.requestId}`);
  /* Not one address in this file is hard-coded: the depository comes from the answer. */
  const src = fs.readFileSync(path.join(ROOT, "src/lib/relay/withdraw.js"), "utf8");
  assert.doesNotMatch(src, /0x66cf0aace1b4e562593bec10ec7868fba9932224/i, "the depository must never be hard-coded");
});

test("W4) 🔴 an answer that would pay someone else, move something else, or authorize something else is refused and nothing is signed", () => {
  const bad = (mutate, why) => {
    assert.throws(
      () => W.parseWithdrawQuote(quoteFor(USER, USER, mutate), { user: USER, recipient: USER, route: ARB, amountUsdc: 5, now: QUOTED_AT, network: "mainnet" }),
      (e) => e.name === "RelayWithdrawError" && /unsafe|bad-/.test(e.code),
      why,
    );
  };
  bad((j) => { j.details.recipient = OTHER; }, "the recipient is someone else");
  bad((j) => { j.details.sender = OTHER; }, "the sender is not this wallet");
  bad((j) => { j.protocol.v2.orderData.output.payments[0].recipient = OTHER; }, "an order payment goes elsewhere");
  bad((j) => { j.protocol.v2.orderData.inputs[0].refunds[0].recipient = OTHER; }, "a refund goes elsewhere");
  bad((j) => { j.details.currencyOut.currency.chainId = 1; }, "another chain pays out");
  bad((j) => { j.details.currencyOut.currency.address = "0xdac17f958d2ee523a2206206994597c13d831ec7"; }, "another token pays out");
  bad((j) => { j.details.currencyIn.currency.chainId = 8453; }, "the money does not leave Hyperliquid");
  bad((j) => { j.steps[1].items[0].data.action.parameters.destination = OTHER; }, "the sendAsset pays a wallet, not the depository");
  bad((j) => { j.protocol.v2.paymentDetails.depository = OTHER; }, "the depository and the sendAsset disagree");
  bad((j) => { j.steps[1].items[0].data.action.parameters.amount = "50.000000"; }, "the sendAsset moves another amount");
  bad((j) => { j.steps[1].items[0].data.action.parameters.nonce = 1; }, "the sendAsset is not the authorized one");
  bad((j) => { j.steps[1].items[0].data.action.type = "usdSend"; }, "the deposit step is not a sendAsset");
  bad((j) => { j.steps[1].items[0].data.action.parameters.token = "HYPE:0x00"; }, "it moves another token");
  bad((j) => { j.steps[1].items[0].data.action.parameters.fromSubAccount = OTHER; }, "it comes from a sub-account");
  bad((j) => { j.steps[0].items[0].data.sign.value.wallet = OTHER; }, "the authorization is for another wallet");
  bad((j) => { j.steps[0].items[0].data.post.body.nonce = 1; }, "the authorize body and the signature disagree");
  bad((j) => { j.steps[0].items[0].data.post.endpoint = "https://evil.example/authorize"; }, "the POST is off Relay");
  bad((j) => { j.steps.reverse(); }, "the deposit step comes before the authorization");
  bad((j) => { j.steps = [j.steps[1]]; }, "there is no authorize step");
  bad((j) => { j.protocol.v2.orderData.output.calls = [{ to: OTHER, data: "0x" }]; }, "the order runs calls on the destination");
  bad((j) => { j.details.currencyIn.amountFormatted = "50.0"; }, "another amount leaves the account");
  /* A testnet build must never send a Mainnet action. */
  assert.throws(() => W.parseWithdrawQuote(quoteFor(), { user: USER, recipient: USER, route: ARB, amountUsdc: 5, now: QUOTED_AT, network: "testnet" }), /Testnet/);
});

test("W5) quoteRelayWithdraw: exactly one POST /quote/v2 with that body, and nothing else; a refused route or a testnet build asks nothing", async () => {
  const f = mockFetch((url) => (url === "https://api.relay.link/quote/v2" ? jsonRes(200, quoteFor()) : jsonRes(404, {})));
  const q = await W.quoteRelayWithdraw(quoteArgs({ fetchImpl: f }));
  assert.equal(q.receiveAmount, 4.995497);
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]), [["POST", "https://api.relay.link/quote/v2"]]);
  assert.equal(f.calls[0].body.amount, "500000000");
  assert.equal(f.calls[0].body.originChainId, 1337);
  const g = mockFetch(() => jsonRes(200, quoteFor()));
  await assert.rejects(W.quoteRelayWithdraw(quoteArgs({ fetchImpl: g, network: "testnet" })), /mainnet only/);
  await assert.rejects(W.quoteRelayWithdraw(quoteArgs({ fetchImpl: g, amountUsdc: 0.5 })), /at least 1 USDC/);
  await assert.rejects(W.quoteRelayWithdraw(quoteArgs({ fetchImpl: g, recipient: "0xnope" })), /destination address/);
  assert.equal(g.calls.length, 0, "nothing left the browser");
  const err = mockFetch(() => jsonRes(400, { message: "Insufficient balance" }));
  await assert.rejects(W.quoteRelayWithdraw(quoteArgs({ fetchImpl: err })), /Insufficient balance/);
});

/* ════════════════════════════════════════════════════════════════════════════
   X. doing it
   ════════════════════════════════════════════════════════════════════════════ */

async function liveQuote(recipient = USER) {
  const f = mockFetch(() => jsonRes(200, quoteFor(USER, recipient)));
  return W.quoteRelayWithdraw(quoteArgs({ fetchImpl: f, recipient }));
}

test("X1) 🔴 the authorize signature is POSTed exactly as the step says, and only THEN is the sendAsset sent", async () => {
  const q = await liveQuote();
  const seen = [];
  const f = mockFetch(() => { seen.push("post"); return jsonRes(200, { status: "ok" }); });
  const signed = [];
  const sent = [];
  const r = await W.executeRelayWithdraw({
    quote: q,
    amountUsdc: 5,
    fetchImpl: f,
    now: () => QUOTED_AT + 1000,
    signAuthorize: async (step) => { signed.push(step); seen.push("sign"); return { ok: true, signature: `0x${"ab".repeat(32)}1b`, post: q.authorize }; },
    sendDeposit: async (o) => { sent.push(o); seen.push("send"); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ["sign", "post", "send"], "sign, then authorize, then move the money");
  assert.equal(signed[0].id, "authorize", "the exchange layer gets the step itself, and checks it again");
  assert.equal(signed[0].kind, "signature");
  const call = f.calls[0];
  assert.equal(call.method, "POST");
  assert.ok(call.url.startsWith("https://api.relay.link/authorize?signature=0x"), call.url);
  assert.deepEqual(call.body, q.authorize.body, "the body is the step's own, verbatim");
  assert.equal(sent[0].step.id, "deposit", "and the deposit step itself");
  assert.equal(sent[0].amountUsdc, 5, "with the amount the user typed");
  assert.equal(r.requestId, q.requestId);
});

test("X2) 🔴 nothing moves when the signature is refused, when Relay refuses the authorization, or when the quote is stale", async () => {
  const q = await liveQuote();
  const sent = [];
  const sendDeposit = async (o) => { sent.push(o); return { ok: true }; };
  const ok = async () => ({ ok: true, signature: `0x${"cd".repeat(32)}1c`, post: q.authorize });
  const rejected = await W.executeRelayWithdraw({
    quote: q, amountUsdc: 5, fetchImpl: mockFetch(() => jsonRes(200, {})), now: () => QUOTED_AT + 1000,
    signAuthorize: async () => ({ ok: false, code: "signature_rejected", message: "You cancelled the signature, so nothing was sent." }), sendDeposit,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "signature_rejected");
  assert.equal(rejected.notConfirmed, undefined, "a refusal is not an unknown outcome");
  const f = mockFetch(() => jsonRes(400, { message: "nonce already used" }));
  const refused = await W.executeRelayWithdraw({
    quote: q, amountUsdc: 5, fetchImpl: f, now: () => QUOTED_AT + 1000, signAuthorize: ok, sendDeposit,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /nonce already used/);
  assert.match(refused.message, /nothing was sent/);
  const stale = await W.executeRelayWithdraw({
    quote: q, amountUsdc: 5, fetchImpl: mockFetch(() => jsonRes(200, {})), now: () => QUOTED_AT + 10 * 60_000, signAuthorize: ok, sendDeposit,
  });
  assert.equal(stale.code, "stale-quote");
  assert.equal(sent.length, 0, "the money never moved");
  /* No signer at all (this build's seam carries none): nothing is signed, nothing
     is sent, and the message points at no other way out — there is only one now,
     and this string is rendered. */
  const none = await W.executeRelayWithdraw({ quote: q, amountUsdc: 5, fetchImpl: mockFetch(() => jsonRes(200, {})), now: () => QUOTED_AT + 1000 });
  assert.equal(none.code, "unsupported");
  assert.match(none.message, /nothing was sent/);
  assert.doesNotMatch(none.message, /hyperliquid|relay|bridge|route below/i);
  assert.equal(sent.length, 0);
});

test("X3) 🔴 a LOST REPLY after the sendAsset is 'not confirmed', keeps the request id, and is never a refusal to retry", async () => {
  const q = await liveQuote();
  const f = mockFetch(() => jsonRes(200, { status: "ok" }));
  const sign = async () => ({ ok: true, signature: `0x${"11".repeat(32)}1b`, post: q.authorize });
  const lost = await W.executeRelayWithdraw({
    quote: q, amountUsdc: 5, fetchImpl: f, now: () => QUOTED_AT + 1000, signAuthorize: sign,
    sendDeposit: async () => ({ ok: false, code: "not_confirmed", lost: true, retry: false, message: "Hyperliquid did not answer in time." }),
  });
  assert.equal(lost.ok, false);
  assert.equal(lost.notConfirmed, true);
  assert.equal(lost.requestId, q.requestId);
  assert.match(lost.message, /did not answer in time/);
  const threw = await W.executeRelayWithdraw({
    quote: q, amountUsdc: 5, fetchImpl: f, now: () => QUOTED_AT + 1000, signAuthorize: sign,
    sendDeposit: async () => { throw new Error("socket hung up"); },
  });
  assert.equal(threw.notConfirmed, true);
  /* A plain refusal by Hyperliquid IS confirmed: nothing moved. */
  const refused = await W.executeRelayWithdraw({
    quote: q, amountUsdc: 5, fetchImpl: f, now: () => QUOTED_AT + 1000, signAuthorize: sign,
    sendDeposit: async () => ({ ok: false, code: "insufficient_margin", message: "Insufficient balance for transfer" }),
  });
  assert.equal(refused.notConfirmed, undefined);
  assert.match(refused.message, /Insufficient balance/);
});

test("X4) the status read is a GET, and only Relay's own success is 'arrived'", async () => {
  const f = mockFetch(() => jsonRes(200, { status: "success", txHashes: ["0xabc"], inTxHashes: ["0xdef"] }));
  const s = await W.readWithdrawStatus({ requestId: "0x1234", fetchImpl: f });
  assert.equal(s.status, "arrived");
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]), [["GET", "https://api.relay.link/intents/status/v3?requestId=0x1234"]]);
  for (const [relay, ours] of [["pending", "sending"], ["waiting", "sending"], ["delayed", "sending"], ["refund", "refunded"], ["failure", "failed"], ["weird", "unknown"]]) {
    const r = await W.readWithdrawStatus({ requestId: "0x1", fetchImpl: mockFetch(() => jsonRes(200, { status: relay })) });
    assert.equal(r.status, ours, relay);
  }
  const down = await W.readWithdrawStatus({ requestId: "0x1", fetchImpl: mockFetch(() => { throw new Error("offline"); }) });
  assert.equal(down.status, "unknown", "unreachable is never 'arrived'");
});

test("X5) 🔴 NOTHING HANGS: the authorize POST and the status read are guarded, so an endpoint that never answers fails as a network refusal", async () => {
  const q = await liveQuote();
  const sent = [];
  /* A fetch that answers only when its signal aborts — a hung endpoint. */
  const hang = (url, init = {}) => new Promise((_resolve, reject) => {
    const s = init.signal;
    if (!s) return;
    if (s.aborted) reject(new Error("aborted"));
    else s.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const fired = [];
  const timers = { setTimeout: (fn) => { fired.push(fn); return fired.length; }, clearTimeout: () => {} };
  const run = W.executeRelayWithdraw({
    quote: q, amountUsdc: 5, fetchImpl: hang, now: () => QUOTED_AT + 1000, timers,
    signAuthorize: async () => ({ ok: true, signature: `0x${"ef".repeat(32)}1b`, post: q.authorize }),
    sendDeposit: async (o) => { sent.push(o); return { ok: true }; },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(fired.length, 1, "the POST took a guard with it");
  fired[0]();
  const r = await run;
  assert.equal(r.ok, false);
  assert.equal(r.code, "network", "a hung authorize is a network failure, not a send in limbo");
  assert.match(r.message, /nothing was sent/, "the sendAsset is step 3: a timeout here moved nothing");
  assert.equal(r.notConfirmed, undefined);
  assert.equal(sent.length, 0);
  /* The status GET is guarded the same way, and an aborted read is 'unknown'. */
  const sFired = [];
  const sTimers = { setTimeout: (fn) => { sFired.push(fn); return sFired.length; }, clearTimeout: () => {} };
  const read = W.readWithdrawStatus({ requestId: "0x1", fetchImpl: hang, timers: sTimers });
  await new Promise((r2) => setImmediate(r2));
  assert.equal(sFired.length, 1);
  sFired[0]();
  assert.equal((await read).status, "unknown");
});

/* ════════════════════════════════════════════════════════════════════════════
   Y. the address the user pastes
   ════════════════════════════════════════════════════════════════════════════ */

test("Y1) 🔴 a pasted address: EIP-55 checked, all-lowercase accepted, a typo refused, and never silently re-cased", () => {
  const good = W.validateWithdrawDestination(OTHER, { own: USER, keccak });
  assert.equal(good.ok, true);
  assert.equal(good.address, OTHER, "exactly as it was pasted");
  assert.equal(good.checksum, true);
  assert.equal(good.isOwn, false);
  const lower = W.validateWithdrawDestination(OTHER.toLowerCase(), { own: USER, keccak });
  assert.equal(lower.ok, true);
  assert.equal(lower.address, OTHER.toLowerCase(), "an all-lowercase address is not re-cased either");
  assert.equal(lower.checksum, false, "there was no checksum to check");
  const typo = `${OTHER.slice(0, 10)}${OTHER[10] === "c" ? "C" : "c"}${OTHER.slice(11)}`;
  assert.notEqual(typo, getAddress(OTHER));
  const bad = W.validateWithdrawDestination(typo, { own: USER, keccak });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /typo/i);
  assert.match(bad.error, /EIP-55/);
  assert.equal(W.validateWithdrawDestination("0x1234", { keccak }).error.includes("40"), true);
  assert.match(W.validateWithdrawDestination("nope", { keccak }).error, /starts with 0x/);
  assert.match(W.validateWithdrawDestination(`0x${"0".repeat(40)}`, { keccak }).error, /zero address/);
  /* 🔴 ONE VERDICT, WHICHEVER WAY OUT IS SELECTED. The bridge path refuses the
     burn address (exchange/master.js); this one used to quote and sign for it,
     so the same paste was safe or fatal depending on a picker above it. */
  const dead = W.validateWithdrawDestination(DEAD, { own: USER, keccak });
  assert.equal(dead.ok, false, "0x…dEaD is money gone, on either path");
  assert.match(dead.error, /never send the money back/i);
  assert.equal(W.validateWithdrawDestination(DEAD.toLowerCase(), { keccak }).ok, false, "whatever its casing");
  assert.equal(W.validateWithdrawDestination("  ", { keccak }).empty, true);
  assert.equal(W.validateWithdrawDestination(USER, { own: USER, keccak }).isOwn, true);
  /* With no way to check a mixed-case address, it is refused rather than trusted. */
  assert.match(W.validateWithdrawDestination(OTHER, { own: USER }).error, /capitalisation/i);
  const ends = W.destinationEnds(OTHER);
  assert.equal(ends.head, "0x709979");
  assert.equal(ends.tail, "dc79C8");
  assert.equal(ends.head + ends.middle + ends.tail, OTHER, "the whole address is always shown");
});

test("Y2) the recent destinations are per wallet, newest first, capped, and survive a broken storage", () => {
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  assert.deepEqual(W.recentDestinations(store, USER), []);
  W.rememberDestination(store, USER, OTHER);
  W.rememberDestination(store, USER, DEAD);
  assert.deepEqual(W.recentDestinations(store, USER), [DEAD, OTHER], "newest first");
  W.rememberDestination(store, USER, OTHER);
  assert.deepEqual(W.recentDestinations(store, USER), [OTHER, DEAD], "moved up, never doubled");
  assert.deepEqual(W.recentDestinations(store, OTHER), [], "another wallet's list is its own");
  for (let i = 0; i < 9; i++) W.rememberDestination(store, USER, `0x${String(i).repeat(40)}`);
  assert.equal(W.recentDestinations(store, USER).length <= W.WITHDRAW_TO_MAX, true);
  const broken = { getItem: () => { throw new Error("private mode"); }, setItem: () => { throw new Error("private mode"); } };
  assert.deepEqual(W.recentDestinations(broken, USER), []);
  assert.doesNotThrow(() => W.rememberDestination(broken, USER, OTHER));
});

test("Y3) 🔴 a quote for a PASTED destination pays that address and refunds this wallet", async () => {
  const q = await liveQuote(OTHER);
  assert.equal(q.recipient, OTHER);
  assert.equal(q.user, USER.toLowerCase());
  /* And the answer is refused if it quietly pays the user instead of the address asked for. */
  assert.throws(
    () => W.parseWithdrawQuote(quoteFor(USER, USER), { user: USER, recipient: OTHER, route: ARB, amountUsdc: 5, now: QUOTED_AT, network: "mainnet" }),
    /recipient is not the destination/,
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   S. the sheet
   ════════════════════════════════════════════════════════════════════════════ */

const H = await import(pathToFileURL(path.join(ROOT, "scripts/lib/perpLiveHarness.mjs")).href);

const DIR = "src/perp/live/";
const SHEET = `${DIR}PerpWithdrawSheet.jsx`;
const BITS = `${DIR}PerpBits.jsx`;
const KEEP = [
  BITS, `${DIR}perpLiveView.js`, `${DIR}storage.js`, "src/lib/format.js", "src/lib/hyperliquid/format.js",
  "src/lib/hyperliquid/exchange/orders.js", "src/lib/hyperliquid/exchange/master.js",
  "src/lib/hyperliquid/exchange/signing.js", "src/perp/mock/fees.js", "src/perp/perpTicket.js",
  "src/lib/relay/withdraw.js", "src/lib/relay/routes.js", "src/lib/relay/chainLogos.js",
  "src/lib/hyperliquid/config.js", "src/lib/hyperliquid/browser.js", "ethers",
];

const T = (tree, M) => H.squash(H.textOf(tree, M.mount));
const btn = (tree, M, id) => H.byTest(tree, id, M.mount)[0];

/** The sheet, with the quote hook answering a REAL parsed quote of the live fixture. */
async function sheet({ backend = {}, quote = undefined, statusRef = { current: { status: "sending", txHashes: [] } }, fetchImpl = null, seed = null, pick = "Arbitrum" } = {}) {
  const env = H.fakeBrowser();
  /* What this browser already holds when the sheet opens — an install that has
     withdrawn before, not an empty one. */
  if (seed) seed(env);
  const parsed = quote === undefined
    ? W.parseWithdrawQuote(quoteFor(), { user: USER, recipient: USER, route: ARB, amountUsdc: 5, now: Date.now(), network: "mainnet" })
    : quote;
  const asked = [];
  const signed = [];
  const sent = [];
  /* THE BRIDGE ACTION IS WATCHED, NEVER OFFERED. The seam still carries withdraw3
     for the exchange layer, so this records any call: no screen may reach it now
     that the method picker is gone (owner, 2026-09-23). */
  const bridged = [];
  globalThis.fetch = fetchImpl || mockFetch(() => jsonRes(200, { status: "ok" }));
  globalThis.__impl = {
    useImagesReady: () => true,
    useIsMobile: () => true,
    useRelayWithdrawQuote: (a) => {
      asked.push(a);
      if (!a.enabled) return { status: "idle", quote: null, error: null, stale: false, refresh() {} };
      return { status: "ready", quote: typeof parsed === "function" ? parsed(a) : parsed, error: null, stale: false, refresh() {} };
    },
    useWithdrawStatus: () => statusRef.current,
  };
  const b = {
    kind: "live", mock: false, address: USER, connected: true, walletType: "privy", support: { ok: true },
    account: {
      perpBalanceUsdc: { answered: true, equityUsdc: 50, availableUsdc: 40, withdrawableUsdc: 40, complete: true, reason: null },
      ledger: { answered: true, list: [], inbound: [] },
    },
    withdraw: async (x, o) => { bridged.push([x, o]); return { ok: true, amountUsdc: x, feeUsdc: 1, receiveUsdc: Number(x) - 1, chain: "Arbitrum One", etaMinutes: 5, destination: USER }; },
    signRelayAuthorize: async (step) => { signed.push(step); return { ok: true, signature: `0x${"ab".repeat(32)}1b`, post: { endpoint: "/authorize", method: "POST", body: { type: "nonce-mapping" } } }; },
    sendRelayDeposit: async (o) => { sent.push(o); return { ok: true }; },
    ...backend,
  };
  const stubs = H.autoStubs([SHEET, BITS], { keep: KEEP });
  const M = await H.bundle({ entry: SHEET, env: { VITE_PERP_ENABLED: "1" }, stubs });
  /* Mutable, so a test can close and reopen the sheet the way the wallet
     strip does — it never unmounts this component, it flips `open`. */
  const props = { open: true, onClose() {}, backend: b };
  const h = M.mount(() => M.default(props));
  h.render(); h.flush();
  await H.wait(0); h.flush();
  /* THE FIXTURE IS AN ARBITRUM ANSWER, AND THE SCREEN NOW STARTS ON BASE (owner,
     2026-09-23: "เรียงเชนใหม่ BASE , AVAX อื่นๆตามมา" — the first row is the
     default). A quote for one destination shown under another is exactly what
     parseWithdrawQuote refuses, so every test that drives the captured quote
     picks its chain first. `pick` is null for the tests that are ABOUT the
     default (S1), which see the screen as it opens. */
  if (pick) {
    const chip = H.byTest(h.value, "withdraw-network", M.mount)
      .find((e) => H.squash(H.textOf(e, M.mount)).startsWith(pick));
    if (!chip) throw new Error(`no destination chip starts with ${pick}`);
    chip.props.onClick(); h.flush();
    await H.wait(0); h.flush();
  }
  return { M, h, b, asked, signed, sent, bridged, env, quote: parsed, props };
}

/* Every provider and every venue, in every casing: none of them belongs on a
   money screen (owner, 2026-09-23: "ให้ใช้คำว่า Withdraw แทนคำว่า Relay" / "ไม่ต้องไปอ้าง Hyperliquid"). */
const NAMES = /relay|hyperliquid|hypercore|hyperevm/i;
const type = (h, M, label, value) => {
  H.all(h.value, M.mount).find((e) => e.type === "input" && e.props["aria-label"] === label).props.onChange({ target: { value } });
  h.flush();
};

/* 🔴 THE CHECK THAT REFUSED THE OWNER'S WITHDRAWAL (2026-09-23: "ถอนไม่ได้อะ").
   IMG_3248 is the refusal on screen — 4.674406 USDC to Optimism, with an address PASTED into the To
   field — and it reads "a refund is not to this wallet", thrown before anything was signed.

   WHAT THE ANSWER ACTUALLY LOOKS LIKE. Measured 2026-09-23 with two read-only quotes (Optimism USDC
   and Avalanche USDC, 5 USDC out of 1337 USDC (Perps), every role the burn address), and the same in
   the captured fixture: there is NO top-level "refunds" key, and orderData.inputs[0].refunds holds
   TWO entries — one on the ORIGIN chain in the origin currency, mirroring the input, and one on the
   DESTINATION chain in the destination currency with the output's own deadline and extraData,
   mirroring the output. UNVERIFIED and unmeasurable from those quotes, because all three roles were
   one address in them: which role each refund names. Read off the mirroring, the origin one is
   refundTo (this wallet) and the destination one is the ORDER'S RECIPIENT — the only reading under
   which the owner's withdrawal fails exactly where it did, since a withdrawal to his OWN wallet (what
   every test did) has the two addresses equal and passes either way.

   So the rule is: a refund may name this wallet or the destination the user confirmed on screen, and
   a THIRD address is still refused. An absent refund list is accepted too — it declares nothing that
   can go wrong. */
test("W4b) 🔴 a refund to the PASTED destination is accepted, an absent refund list is accepted, a third address is refused", () => {
  const args = (recipient) => ({ user: USER, recipient, route: ARB, amountUsdc: 5, now: QUOTED_AT, network: "mainnet" });

  /* THE OWNER'S CASE, as the live answer shapes it: the destination-chain refund names the address he
     pasted, the origin-chain one names his wallet. This is the quote that was refused. */
  const pasted = quoteFor(USER, OTHER);
  const refunds = pasted.protocol.v2.orderData.inputs[0].refunds;
  assert.equal(refunds.length, 2, "two refunds: one per side of the order");
  assert.equal(getAddress(refunds[0].recipient), getAddress(USER), "the origin-chain refund comes back to this wallet");
  assert.equal(getAddress(refunds[1].recipient), getAddress(OTHER), "the destination-chain one mirrors the output");
  const ok = W.parseWithdrawQuote(pasted, args(OTHER));
  assert.equal(ok.recipient, OTHER);
  assert.equal(ok.amountUsdc, 5);

  /* An answer that declares no refunds at all. */
  const none = W.parseWithdrawQuote(
    quoteFor(USER, USER, (j) => { j.refunds = null; delete j.protocol.v2.orderData.inputs[0].refunds; }),
    args(USER),
  );
  assert.equal(none.amountUsdc, 5);

  /* A THIRD address — neither the wallet nor the destination on the confirm screen — is refused, on
     either side of the order, and nothing is signed. */
  for (const i of [0, 1]) {
    assert.throws(
      () => W.parseWithdrawQuote(
        quoteFor(USER, OTHER, (j) => { j.protocol.v2.orderData.inputs[0].refunds[i].recipient = DEAD; }),
        args(OTHER),
      ),
      (e) => e.name === "RelayWithdrawError" && /unsafe/.test(e.code) && !NAMES.test(e.message),
      `refund ${i} to a third address`,
    );
  }
  /* And the order must still declare an input at all: with none, what leaves cannot be checked. */
  assert.throws(
    () => W.parseWithdrawQuote(quoteFor(USER, USER, (j) => { j.protocol.v2.orderData.inputs = []; }), args(USER)),
    (e) => e.name === "RelayWithdrawError" && /unsafe/.test(e.code),
  );
});

/* 🔴 THE OTHER HALF OF THE SAME CLASS OF BUG (owner, 2026-09-23: "ถอนไม่ได้อะ").
   The refund rule above refused a good answer outright. Its siblings did something
   quieter: the signing layer (exchange/relayOut.js readRelayDepositStep) enforces
   rules on the DEPOSIT step that the quote-time parse did not, and it runs at step 3
   of executeRelayWithdraw — after the authorize signature has been taken from the
   user's wallet and POSTed. So a quote that was never usable cost a wallet prompt
   before anyone found out. Those rules are now read at quote time too.

   The property this test pins is that the earlier check is a strict SUBSET of the
   signer's: for every answer the parse now refuses, the signer refuses it as well.
   That is what makes moving the refusal earlier safe — it cannot turn a withdrawal
   that would have gone through into one that does not. */
const R = await import(pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/exchange/relayOut.js")).href);
const N = await import(pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/exchange/network.js")).href);

test("W6) 🔴 the deposit step is held to the SIGNER'S OWN contract at quote time, before any wallet is asked", () => {
  /* The mirrored list is the signer's, field for field: it is copied rather than
     imported (the sheet's render tests pin this file's module graph), so a drift
     between the two is caught here and not in somebody's wallet. */
  assert.equal(W.SEND_ASSET_TYPE, R.RELAY_SEND_ASSET_TYPE);
  assert.deepEqual(
    W.SEND_ASSET_FIELDS.map((f) => [f[0], f[1]]),
    R.RELAY_SEND_ASSET_FIELDS.map((f) => [f[0], f[1]]),
  );

  const nonce = FIX.response.steps.find((s) => s.id === "deposit").items[0].data.nonce;
  const signerRefuses = (mutate) => {
    const j = quoteFor(USER, USER, mutate);
    const step = j.steps.find((s) => s.id === "deposit");
    return R.readRelayDepositStep(step, { profile: N.hlNetworkProfile("mainnet"), amountUsdc: "5", master: USER, now: nonce });
  };
  const params = (fn) => (j) => fn(j.steps.find((s) => s.id === "deposit").items[0].data.action.parameters);
  const data = (fn) => (j) => fn(j.steps.find((s) => s.id === "deposit").items[0].data);

  const cases = [
    ["the money leaves another account", params((p) => { p.sourceDex = "spot"; })],
    ["it pays an account it should not", params((p) => { p.destinationDex = "vault"; })],
    ["it comes from a sub-account", params((p) => { p.fromSubAccount = `0x${"5".repeat(40)}`; })],
    /* THE FIELD RELAY MIGHT NOT SEND. The parse used to accept an ABSENT
       fromSubAccount while the signer refused it, so that one answer would have
       been quoted, reviewed, signed once — and only then refused. */
    ["it does not say whether it comes from a sub-account", params((p) => { delete p.fromSubAccount; })],
    ["the message is not the one it should be", data((d) => { d.eip712PrimaryType = "HyperliquidTransaction:Withdraw"; })],
    ["the field list is reordered", data((d) => {
      const l = d.eip712Types["HyperliquidTransaction:SendAsset"];
      [l[1], l[4]] = [l[4], l[1]];
    })],
    ["a field is retyped", data((d) => { d.eip712Types["HyperliquidTransaction:SendAsset"][7].type = "uint256"; })],
    ["the field list is short", data((d) => { d.eip712Types["HyperliquidTransaction:SendAsset"].pop(); })],
    ["there is no field list for it", data((d) => { d.eip712Types = { "HyperliquidTransaction:Withdraw": [] }; })],
  ];

  for (const [why, mutate] of cases) {
    /* Refused at quote time, in words that name no provider and no venue. */
    assert.throws(
      () => W.parseWithdrawQuote(quoteFor(USER, USER, mutate), { user: USER, recipient: USER, route: ARB, amountUsdc: 5, now: QUOTED_AT, network: "mainnet" }),
      (e) => e.name === "RelayWithdrawError" && e.code === "unsafe-quote" && !NAMES.test(e.message),
      why,
    );
    /* And the signer refuses it too, which is why refusing it earlier is safe. */
    assert.equal(signerRefuses(mutate).ok, false, `the signer also refuses: ${why}`);
  }

  /* And the untouched live answer still passes BOTH gates. */
  assert.equal(signerRefuses(null).ok, true, "the live answer is signable");
  const good = W.parseWithdrawQuote(quoteFor(), { user: USER, recipient: USER, route: ARB, amountUsdc: 5, now: QUOTED_AT, network: "mainnet" });
  assert.equal(good.sendAsset.sourceDex, "");
  assert.equal(good.sendAsset.fromSubAccount, "");
});

/* 🔴 THE WORDS THAT COME FROM SOMEWHERE ELSE, on the money step.
   Owner, 2026-09-23: no provider and no venue on a money screen. The sheet's own
   strings obey that (S1b), but two sources of text pass straight through it: the
   trading layer's refusals (exchange/client.js: a refused signature, a request that
   timed out, a withdrawal it could not confirm) and the quote service's own error
   message. Those are written elsewhere and name themselves freely, so the flow
   scrubs the NAME and keeps the DIAGNOSIS - which is the half a user needs. */

/* 🔴 AN UNKNOWN OUTCOME IS AN UNKNOWN OUTCOME, WHOEVER SAYS IT.
   The money step reaches this flow through the backend seam, and that seam turns a
   THROW between the wallet signature and the reply into a returned refusal of its
   own (perp/live/perpBackend.js run's catch: code "unexpected", the words "nothing
   was confirmed"). Read as a plain refusal, the sheet lands on its error screen
   with Confirm live again - and the second tap is past the 60 s quote TTL, so it
   re-quotes, which is a fresh nonce and a genuinely SECOND withdrawal rather than
   one the venue would reject. */

/* 🔴 ONE WITHDRAWAL, WHATEVER THE TAPS. This guard used to live in
   test-perp-live-ui-render.mjs D1/D3, on the bridge path that has been removed from
   the sheet; it belongs here now, where every fetch is mocked and nothing signs. A
   second tap on a confirm button is the cheapest way to pay twice. */

/* ════════════════════════════════════════════════════════════════════════════
   Z. THE DESTINATION IS THE CUSTOMER'S TO ENTER
   ════════════════════════════════════════════════════════════════════════════
   Owner, 2026-09-23: "ตอนหน้า Withdraw ไม่ต้องให้มี Wallet ของ Privy เลยดิ ให้ลูกค้า ใส่เอง
   หรือวางได้เลย" — the Withdraw screen must carry NO in-app wallet address at all.
   There is no "Use my wallet" shortcut and no prefill: the field is empty on
   every open and the customer types or pastes where the money goes.

   The exchange layer has always refused a withdrawal with no destination. What
   is new is that the SCREEN makes that the normal path: Review stays disabled,
   and nothing is quoted, until a valid address is in the field. */

/** The destination input, by the label a screen reader reads. */
const destField = (h, M) => H.all(h.value, M.mount).find((e) => e.type === "input" && e.props["aria-label"] === "Destination address");

test("Z3) 🔴 the address the customer pastes reaches the quote BODY byte for byte, and no destination is a refusal", async () => {
  const d = W.validateWithdrawDestination(`  ${OTHER}  `, { own: USER, keccak });
  assert.equal(d.ok, true);
  assert.equal(d.address, OTHER, "exactly what was pasted, minus the spaces around it");
  assert.equal(d.isOwn, false);
  const f = mockFetch(() => jsonRes(200, quoteFor(USER, d.address)));
  const q = await W.quoteRelayWithdraw(quoteArgs({ recipient: d.address, fetchImpl: f }));
  assert.equal(f.calls[0].body.recipient, OTHER, "the POST carries the pasted casing, byte for byte");
  assert.equal(String(f.calls[0].body.refundTo).toLowerCase(), USER.toLowerCase(), "a refund still comes back to this wallet");
  assert.equal(q.recipient, OTHER, "and the quote gives it back the same way");
  /* NO DEFAULT ANYWHERE UNDER THE SCREEN: an empty destination is refused, never
     quietly re-aimed at the wallet that is paying. */
  const g = mockFetch(() => jsonRes(200, quoteFor()));
  for (const none of [undefined, null, "", "   "]) {
    await assert.rejects(
      W.quoteRelayWithdraw(quoteArgs({ recipient: none, fetchImpl: g })),
      (e) => e.name === "RelayWithdrawError" && e.code === "bad-recipient",
      `recipient ${JSON.stringify(none)}`,
    );
  }
  assert.equal(g.calls.length, 0, "nothing left the browser");
});

test("Z4) 🔴 the in-app wallet is a CAUTION, not a block, and only for the in-app wallet", () => {
  const say = (o) => W.inAppWithdrawCaution(o);
  const inApp = { address: USER, wallet: USER, walletType: W.IN_APP_WALLET_TYPE };
  const words = say(inApp);
  assert.equal(typeof words, "string", "there are words for it");
  assert.match(words, /can't be reached/i, "it says what cannot be done with money that lands there");
  assert.equal(words.split(/[.!?](?=\s|$)/).filter((s) => s.trim()).length, 1, `one plain sentence: ${words}`);
  assert.doesNotMatch(words, NAMES, "and it names no provider and no venue");
  assert.doesNotMatch(words, /privy/i, "nor the wallet's maker");
  /* The same wallet, whatever the checksum casing. */
  assert.equal(say({ ...inApp, address: USER.toLowerCase() }), words);
  /* A wallet the user holds the key to needs no caution. */
  assert.equal(say({ ...inApp, walletType: "injected" }), null);
  assert.equal(say({ ...inApp, walletType: null }), null);
  /* Another address is not this wallet. */
  assert.equal(say({ ...inApp, address: OTHER }), null);
  assert.equal(say({ address: "", wallet: USER, walletType: W.IN_APP_WALLET_TYPE }), null);
  assert.equal(say(), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   X. SCANNING THE DESTINATION
   ------------------------------------------------------------------------------
   Owner, 2026-09-22/23: the customer enters the destination themselves — typed,
   pasted, and now scanned off the screen of wherever the money is going.

   🔴 A SCAN FILLS THE FIELD. That is the whole of its power, and these tests are
   about the things it must NOT be able to do: submit, sign, price itself into a
   confirm screen, or leave a full-screen camera running over a sheet the user has
   already closed. The parsers themselves, the networks they accept and the
   sentences they answer with are pinned in test-withdraw-scan.mjs.
   ════════════════════════════════════════════════════════════════════════════ */

/** The scanner overlay element the sheet renders (stubbed here — no camera). */
const scanner = (h, M) => H.stubsNamed(h.value, "QrScanner", M.mount)[0];
/** Which network chip is selected, by its own text. */
const picked = (h, M) => {
  const chip = H.byTest(h.value, "withdraw-network", M.mount).find((e) => e.props["aria-pressed"] === true);
  return chip ? H.squash(H.textOf(chip, M.mount)) : null;
};

test("activation, no knowledge needed: a quote that prices in Hyperliquid's 1 USDC lowers the amount by itself (never raises); Max leaves it", () => {
  const q = { amountUsdc: 6.1, receiveAmount: 4.9, feeUsdc: 0.2 };
  assert.equal(W.quoteActivationUsdc(q), 1);
  assert.equal(W.quoteActivationUsdc({ amountUsdc: 6.1, receiveAmount: 5.9, feeUsdc: 0.2 }), 0, "an activated account: none");
  assert.equal(W.activationAdjustedUsdc({ amountUsdc: 6.1, withdrawableUsdc: 6.1, activationUsdc: 1 }), 5.09);
  assert.equal(W.activationAdjustedUsdc({ amountUsdc: 5.09, withdrawableUsdc: 6.1, activationUsdc: 1 }), null, "already fits");
  assert.equal(W.activationAdjustedUsdc({ amountUsdc: 3, withdrawableUsdc: 6.1, activationUsdc: 1 }), null, "never raised");
  assert.equal(W.activationAdjustedUsdc({ amountUsdc: 1.5, withdrawableUsdc: 1.5, activationUsdc: 1 }), null, "under the minimum: nothing offered");
  assert.equal(W.withdrawMaxUsdc(6.1, 1), 5.09);
  assert.equal(W.withdrawMaxUsdc(6.109, 0), 6.1);
  assert.equal(W.activationAdjustedText(5.09, 1), "Adjusted to 5.09: Hyperliquid keeps 1 USDC once on your first withdrawal.");
  const src = fs.readFileSync(path.join(ROOT, "src/wallet/WithdrawPanel.jsx"), "utf8");
  assert.match(src, /One-time activation \(Hyperliquid\)/, "the fee stays a printed row");
  assert.match(src, /quoteForAmount/, "Review waits for the lowered amount's own quote");
});
