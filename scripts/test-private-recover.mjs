/**
 * test-private-recover — RECOVER: USDC stranded on Base / Polygon → the Main Account, gasless.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "เอา ARB, Avax, Base, Polygon พอแระ". A private deposit's refund lands
 * on its ORIGIN chain in the customer's own wallet; on Base and Polygon it would sit with no
 * gas. lib/relay/recoverStranded.js is the way back (Relay usePermit, EIP-3009). Its signer
 * is injected by PrivyBridge: a VISIBLE window on the shown hook, behind the closed builder
 * lib/relay/recoverClosed.js. With that wired, PRIVATE_RECOVER_READY is on: Base and Polygon
 * are on the private picker and the Recover rows can sign.
 *
 *   R1  the pins are the live ones (GET /chains, eth_getCode, USDC name/version/DOMAIN_SEPARATOR)
 *   R2  the body: user = recipient = refundTo = own; every key is one api/relay-quote.js allows
 *   R3  the live answers verify, with the figures exact
 *   R4  every tampered answer is refused before any window (own recipient, fee ceiling,
 *       minimum ≥ 95 % of expected, pinned contracts, permit window, post target)
 *   R5  the v3.2 shape (MulticallAuthorization + EIP-3009) verifies only for exactly this deposit
 *   R6  executeRecover: TTL, wallet, signer, the record before the money POST, unknown is unknown
 *   R7  a new permit only once the old one can never run (recoverAllowed)
 *   R8  reading balances: unknown is null, never 0; the offered floor
 *   R9  source guards: nothing here holds a signer; PrivyBridge provides the visible one; the switch is on
 *   R10 the wallet-switch guard reads the wallet connected NOW, through the whole signing window
 *   R11 the closed builder's written-out pins are recoverStranded's, and its window is executeRecover's
 *   R12 END TO END with fakes: quote → review → executeRecover → the REAL bridge signer (closed builder,
 *       shown hook) → a fake Privy signing offline → a fake Relay; the posted signature is the wallet's
 *       over Relay's own typed data; a forged review is refused before Privy, nothing posted
 *   R13 the Recover row (useStrandedRecover): press → review → confirm signs through the bridge signer and
 *       posts; a signer for another wallet reads "can't sign here" before any press
 *
 * MONEY SAFETY: global fetch throws; the fixtures are live read-only quotes with the
 * placeholder user 0x…dEaD (nothing was signed or posted). Every signer is a fake or signs
 * OFFLINE with Hardhat's public test key #0; every POST goes to a fake Relay.
 *
 * Run: node --test scripts/test-private-recover.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, hashDomain } from "viem";
import { stripComments } from "./lib/stripComments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const fixture = (name) => JSON.parse(read(`scripts/fixtures/recover/${name}.json`));

const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error("live network is forbidden in test-private-recover"); }; });
after(() => { globalThis.fetch = realFetch; });

let RS; let RQ; let C; let A;
before(async () => {
  RS = await import("../src/lib/relay/recoverStranded.js");
  RQ = await import("../api/relay-quote.js");
  C = await import("../src/lib/intents/config.js");
  A = await import("../src/lib/intents/assets.js");
});

const OWN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEAD = /0x000000000000000000000000000000000000dEaD/gi;
const FIX = { 8453: fixture("relay-recover-base-10"), 137: fixture("relay-recover-polygon-10") };
const clone = (o) => JSON.parse(JSON.stringify(o));
/** The live answer as it would be for OWN. */
const answer = (chainId, mutate = null) => {
  const j = JSON.parse(JSON.stringify(FIX[chainId].response).replace(DEAD, OWN));
  if (mutate) mutate(j);
  return j;
};
const at = (chainId) => FIX[chainId].capturedAt + 2000;
const parse = (chainId, json, over = {}) => RS.parseRecoverQuote(json, { own: OWN, chainId, amountRaw: "10000000", now: at(chainId), ...over });
const refusedWith = (fn, re, code = "unsafe-quote") => assert.throws(fn, (e) => e.code === code && (!re || re.test(e.message)), String(re));
const item = (j) => j.steps[0].items[0].data;

/* ── R1 pins ─────────────────────────────────────────────────────────────── */

test("R1) the pins are the live ones: Relay's contracts per chain, and each chain's USDC permit domain", () => {
  const chains = fixture("relay-chains-8453-137").answer;
  const dom = fixture("usdc-domains").chains;
  for (const id of [8453, 137]) {
    const c = RS.RECOVER_CHAINS[id];
    const live = chains.find((x) => x.id === id);
    assert.equal(live.depositEnabled, true);
    assert.equal(c.relayName, live.protocol.v2.chainId);
    assert.equal(RS.RECOVER_RELAY.depository, live.protocol.v2.depository.toLowerCase());
    assert.equal(RS.RECOVER_RELAY.v3.approvalProxy, live.contracts.v3.approvalProxy.toLowerCase());
    assert.equal(RS.RECOVER_RELAY["v3.2"].approvalProxy, live.contracts["v3.2"].approvalProxy.toLowerCase());
    assert.equal(RS.RECOVER_RELAY["v3.2"].erc20Router, live.contracts["v3.2"].erc20Router.toLowerCase());
    /* USDC: name "USD Coin", version "2", and the domain's hash IS the contract's DOMAIN_SEPARATOR (read on chain). */
    const d = dom[id];
    assert.equal(c.usdc, d.usdc);
    assert.equal(c.domain.name, d.name);
    assert.equal(c.domain.version, d.version);
    assert.equal(d.match, true);
    const h = hashDomain({ domain: c.domain, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } });
    assert.equal(h, d.domainSeparator);
    for (const [addr, bytes] of Object.entries(d.codeBytes)) assert.ok(bytes > 0, `${addr} has code on ${id}`);
    /* The same tokens the four-chain table names. */
    assert.equal(c.usdc, A.PRIVATE_DEPOSIT_ROUTES.find((r) => r.chainId === id).address);
  }
  assert.deepEqual(RS.RECOVER_CHAIN_IDS, [8453, 137]);
  assert.deepEqual(A.PRIVATE_DEPOSIT_ROUTES.filter((r) => r.refundLands === "recover").map((r) => r.chainId).sort(), [137, 8453], "Recover covers exactly the chains whose refunds strand");
});

/* ── R2 body ─────────────────────────────────────────────────────────────── */

test("R2) the body: user = recipient = refundTo = own, this chain's USDC into perps, permit; our proxy accepts every key", () => {
  for (const id of [8453, 137]) {
    const b = RS.buildRecoverQuoteBody({ own: OWN, chainId: id, amountRaw: "10000000" });
    assert.equal(b.user, OWN);
    assert.equal(b.recipient, OWN);
    assert.equal(b.refundTo, OWN);
    assert.equal(b.originChainId, id);
    assert.equal(b.destinationChainId, 1337);
    assert.equal(b.usePermit, true);
    assert.equal(RQ.relayQuoteBodyProblem(b), null, `api/relay-quote.js accepts the ${id} body`);
    /* The live capture asked exactly this shape (with the placeholder user). */
    const live = { ...FIX[id].body, user: OWN, recipient: OWN, refundTo: OWN };
    assert.deepEqual(Object.keys(b).sort(), Object.keys(live).sort());
  }
  assert.throws(() => RS.buildRecoverQuoteBody({ own: OWN, chainId: 42161, amountRaw: "10000000" }), (e) => e.code === "bad-chain");
  assert.throws(() => RS.buildRecoverQuoteBody({ own: OWN, chainId: 1, amountRaw: "10000000" }), (e) => e.code === "bad-chain");
  assert.throws(() => RS.buildRecoverQuoteBody({ own: "0x123", chainId: 8453, amountRaw: "10000000" }), (e) => e.code === "bad-user");
  assert.throws(() => RS.buildRecoverQuoteBody({ own: OWN, chainId: 8453, amountRaw: "999999" }), (e) => e.code === "too-small");
});

/* ── R3 the live answers ─────────────────────────────────────────────────── */

test("R3) the live answers verify: one EIP-3009 signature to the v3 proxy, the figures exact", () => {
  const b = parse(8453, answer(8453));
  assert.equal(b.receiveUsdc, "9.97678");
  assert.equal(b.minimumUsdc, "9.777244");
  assert.equal(b.costUsdc, "0.02322", "what leaves minus what is expected, exactly");
  assert.equal(b.signatureCount, 1);
  assert.equal(b.signatures[0].kind, "eip3009");
  assert.equal(b.signatures[0].typedData.domain.chainId, 8453);
  assert.equal(b.own, OWN.toLowerCase());
  assert.equal(b.chainName, "Base");
  const p = parse(137, answer(137));
  assert.equal(p.receiveUsdc, "9.974281");
  assert.equal(p.minimumUsdc, "9.774795");
  assert.equal(p.signatures[0].typedData.domain.verifyingContract, "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359");
  /* The minimum is ≥ 95 % of what is expected (live: 98.0 %). */
  assert.ok(Number(p.minimumUsdc) / Number(p.receiveUsdc) >= 0.95);
  /* An answer for one chain is not one for the other. */
  refusedWith(() => parse(137, answer(8453)), /Polygon/);
});

/* ── R4 tampering ────────────────────────────────────────────────────────── */

test("R4) 🔴 every tampered answer is refused before any window opens", () => {
  const cases = [
    ["the recipient is someone else", (j) => { j.details.recipient = OTHER; }, /another account/],
    ["the sender is someone else", (j) => { j.details.sender = OTHER; }, /sender/],
    ["an order payment to someone else", (j) => { j.protocol.v2.orderData.output.payments[0].recipient = OTHER; }, /order payment/],
    ["a refund to someone else", (j) => { j.protocol.v2.orderData.inputs[0].refunds[0].recipient = OTHER; }, /refund/],
    ["no refunds at all", (j) => { j.protocol.v2.orderData.inputs = []; }, /refund/],
    ["another amount leaving", (j) => { j.details.currencyIn.amount = "10000001"; }, /amount leaving/],
    ["another token leaving", (j) => { j.details.currencyIn.currency.address = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"; }, /not your USDC/],
    ["another destination", (j) => { j.details.currencyOut.currency.chainId = 42161; }, /Main Account/],
    ["over the fee ceiling (expected < X − 0.25)", (j) => { j.details.currencyOut.amount = "974999999"; j.details.currencyOut.minimumAmount = "960000000"; }, /too little would arrive/],
    ["the minimum under 95 % of expected", (j) => { j.details.currencyOut.minimumAmount = String(Math.floor(Number(j.details.currencyOut.amount) * 0.949)); }, /guaranteed/],
    ["more out than in (units)", (j) => { j.details.currencyOut.amount = "1000000001"; }, /units/],
    ["an app fee", (j) => { j.fees.app.amount = "1"; }, /app fee/],
    ["the order runs calls", (j) => { j.protocol.v2.orderData.output.calls = [{ to: OTHER }]; }, /calls/],
    ["the depository is not the pinned one", (j) => { j.protocol.v2.paymentDetails.depository = OTHER; }, /depository/],
    ["the deposit is on another chain", (j) => { j.protocol.v2.paymentDetails.chainId = "arbitrum"; }, /depository/],
    ["the permit pays an unknown contract", (j) => { item(j).sign.value.to = OTHER; }, /unknown contract/],
    ["the permit is from someone else", (j) => { item(j).sign.value.from = OTHER; }, /not from your wallet/],
    ["the permit is for another amount", (j) => { item(j).sign.value.value = "10000001"; }, /another amount/],
    ["the permit domain is another chain's USDC", (j) => { item(j).sign.domain.chainId = 1; }, /USDC on/],
    ["the permit domain has an extra field", (j) => { item(j).sign.domain.salt = "0x01"; }, /USDC on/],
    ["the permit has an extra type field", (j) => { item(j).sign.types.ReceiveWithAuthorization.push({ name: "x", type: "uint256" }); }, /fields/],
    ["the permit is another primary type", (j) => { item(j).sign.primaryType = "TransferWithAuthorization"; }, /USDC authorisation/],
    ["the permit lives too long", (j) => { item(j).sign.value.validBefore = Math.floor(at(8453) / 1000) + 3600; }, /too long/],
    ["the permit is about to expire", (j) => { item(j).sign.value.validBefore = Math.floor(at(8453) / 1000) + 30; }, /about to expire/],
    ["the permit is not usable yet", (j) => { item(j).sign.value.validAfter = Math.floor(at(8453) / 1000) + 3600; }, /not usable yet/],
    ["the permit has no usable nonce", (j) => { item(j).sign.value.nonce = "0x01"; }, /nonce/],
    ["it posts somewhere else", (j) => { item(j).post.endpoint = "/execute/swap"; }, /where to post/],
    ["it posts for another order", (j) => { item(j).post.body.requestId = `0x${"1".repeat(64)}`; }, /another order/],
    ["it posts to an unknown service", (j) => { item(j).post.body.api = "other"; }, /unknown service/],
    ["two steps", (j) => { j.steps.push(clone(j.steps[0])); }, /one signature step/],
    ["three signatures", (j) => { j.steps[0].items.push(clone(j.steps[0].items[0]), clone(j.steps[0].items[0])); }, /unexpected number/],
    ["a lone permit to the v3.2 proxy", (j) => { item(j).sign.value.to = RS.RECOVER_RELAY["v3.2"].approvalProxy; }, /without the calls/],
    ["no order id at all", (j) => { delete j.requestId; }, /names no order/],
  ];
  for (const [name, mutate, re] of cases) refusedWith(() => parse(8453, answer(8453, mutate)), re);
  /* A transaction step needs gas the customer does not have there: its own code, never a fallback. */
  assert.throws(() => parse(8453, answer(8453, (j) => { j.steps[0].kind = "transaction"; })), (e) => e.code === "needs-gas");
  /* Another wallet's answer, and another amount than asked. */
  assert.throws(() => RS.parseRecoverQuote(answer(8453), { own: OTHER, chainId: 8453, amountRaw: "10000000", now: at(8453) }), (e) => e.code === "unsafe-quote");
  refusedWith(() => parse(8453, answer(8453), { amountRaw: "10000001" }));
});

/* ── R5 the v3.2 shape ───────────────────────────────────────────────────── */

/* A SYNTHETIC v3.2 answer (none can exist before 2026-10-26), in the shape moveOut.js verifies on Avalanche. */
function v32(chainId, { calls = null, mutate = null } = {}) {
  const c = RS.RECOVER_CHAINS[chainId];
  const j = answer(chainId);
  const orderId = j.protocol.v2.orderId;
  const vb = Math.floor(at(chainId) / 1000) + 500;
  const rwa = item(j);
  rwa.sign.value.to = RS.RECOVER_RELAY["v3.2"].approvalProxy;
  const callList = calls || [
    { target: c.usdc, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: RS.RECOVER_ABI, functionName: "approve", args: [RS.RECOVER_RELAY.depository, 10000000n] }) },
    { target: RS.RECOVER_RELAY.depository, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: RS.RECOVER_ABI, functionName: "depositErc20", args: [OWN, c.usdc, 10000000n, orderId] }) },
  ];
  const mca = {
    status: "incomplete",
    data: {
      sign: {
        signatureKind: "eip712",
        domain: { ...c.mcaDomain },
        primaryType: "MulticallAuthorization",
        types: {
          MulticallAuthorization: [["from", "address"], ["relayer", "address"], ["msgValue", "uint256"], ["refundTo", "address"], ["nftRecipient", "address"], ["metadata", "bytes"], ["fundingIndex", "uint256"], ["calls", "Call3Value[]"], ["funding", "FundingAuthorization[]"]].map(([name, type]) => ({ name, type })),
          Call3Value: [["target", "address"], ["allowFailure", "bool"], ["value", "uint256"], ["callData", "bytes"]].map(([name, type]) => ({ name, type })),
          FundingAuthorization: [["token", "address"], ["from", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"]].map(([name, type]) => ({ name, type })),
        },
        value: { from: OWN, relayer: "0xf70da97812cb96acdf810712aa562db8dfa3dbef", msgValue: "0", refundTo: OWN, nftRecipient: OWN, metadata: "0x", fundingIndex: 0, calls: callList, funding: [{ token: c.usdc, from: OWN, value: "10000000", validAfter: 0, validBefore: vb }] },
      },
      post: { endpoint: "/execute/permits", method: "POST", body: { kind: "multicall-authorization", requestId: j.requestId, api: "swap" } },
    },
  };
  j.steps[0].items = [mca, j.steps[0].items[0]];
  if (mutate) mutate(j);
  return j;
}

test("R5) the v3.2 shape (from 2026-10-26) verifies only for exactly this deposit, in this order", () => {
  for (const id of [8453, 137]) {
    const r = parse(id, v32(id));
    assert.equal(r.signatureCount, 2);
    assert.deepEqual(r.signatures.map((s) => s.kind), ["multicall-authorization", "eip3009"]);
  }
  const c = RS.RECOVER_CHAINS[8453];
  const orderId = answer(8453).protocol.v2.orderId;
  const dep = (args) => ({ target: RS.RECOVER_RELAY.depository, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: RS.RECOVER_ABI, functionName: "depositErc20", args }) });
  refusedWith(() => parse(8453, v32(8453, { calls: [dep([OWN, c.usdc, 10000000n, `0x${"2".repeat(64)}`])] })), /another order/);
  refusedWith(() => parse(8453, v32(8453, { calls: [dep([OWN, c.usdc, 9000000n, orderId])] })), /another amount/);
  refusedWith(() => parse(8453, v32(8453, { calls: [dep([OTHER, c.usdc, 10000000n, orderId])] })), /not yours/);
  refusedWith(() => parse(8453, v32(8453, { calls: [{ target: c.usdc, allowFailure: false, value: "0", callData: encodeFunctionData({ abi: RS.RECOVER_ABI, functionName: "transfer", args: [OTHER, 10000000n] }) }] })), /not a deposit|outside|unknown/);
  refusedWith(() => parse(8453, v32(8453, { mutate: (j) => { j.steps[0].items[0].data.sign.domain.chainId = 137; } })), /known contract/);
  refusedWith(() => parse(8453, v32(8453, { mutate: (j) => { j.steps[0].items[0].data.sign.value.refundTo = OTHER; } })), /not yours/);
  refusedWith(() => parse(8453, v32(8453, { mutate: (j) => { j.steps[0].items[1].data.sign.value.to = RS.RECOVER_RELAY.v3.approvalProxy; } })), /different contracts/);
});

/* ── R6 executeRecover ───────────────────────────────────────────────────── */

const SIG = `0x${"ab".repeat(65)}`;
function memJournal() { return RS.createRecoverJournal({ storage: null }); }
function postNet({ ok = true, fail = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (fail === "throw") throw new Error("socket hang up");
    return { ok, status: ok ? 200 : 500 };
  };
  fn.calls = calls;
  return fn;
}
const review = (chainId = 8453, json = answer(chainId)) => parse(chainId, json);

test("R6) 🔴 executeRecover: the visible signer only, the record before the money POST, a lost POST is unknown", async () => {
  const now = () => at(8453) + 1000;
  /* No signer injected (no bridge mounted here): nothing happens. */
  assert.equal(RS.recoverSigner(), null, "only the mounted PrivyBridge provides one");
  const none = await RS.executeRecover({ review: review(), ownNow: () => OWN, journal: memJournal(), fetchImpl: postNet(), now });
  assert.equal(none.code, "no-signer");
  /* Happy path: one signature, one POST to /execute/permits with the signature, the record says sent. */
  const j = memJournal();
  const net = postNet();
  const signed = [];
  const ok = await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async (td) => { signed.push(td); return SIG; }, journal: j, fetchImpl: net, now });
  assert.equal(ok.ok, true);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].primaryType, "ReceiveWithAuthorization");
  assert.equal(net.calls.length, 1);
  assert.match(net.calls[0].url, /^https:\/\/api\.relay\.link\/execute\/permits\?signature=0x(ab){65}$/);
  assert.equal(j.get(OWN, 8453).state, "sent");
  /* A lost POST: UNKNOWN, the record stays, and nothing is offered again on that chain until the permit has run out. */
  const j2 = memJournal();
  const lost = await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async () => SIG, journal: j2, fetchImpl: postNet({ fail: "throw" }), now });
  assert.equal(lost.ok, false);
  assert.equal(lost.unknown, true);
  assert.equal(lost.message, "Not confirmed. Don't send it again.");
  assert.equal(j2.get(OWN, 8453).state, "sending", "written BEFORE the POST that moves money");
  const again = await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async () => SIG, journal: j2, fetchImpl: postNet(), now });
  assert.equal(again.code, "busy");
  /* The customer declines the window: nothing is posted. */
  const net3 = postNet();
  const no = await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async () => { throw new Error("User rejected"); }, journal: memJournal(), fetchImpl: net3, now });
  assert.equal(no.code, "cancelled");
  assert.equal(net3.calls.length, 0);
  /* A garbage signature is a decline. */
  assert.equal((await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async () => "0x12", journal: memJournal(), fetchImpl: postNet(), now })).code, "cancelled");
  /* Another wallet connected now: nothing opens. */
  let asked = 0;
  const w = await RS.executeRecover({ review: review(), ownNow: () => OTHER, signTypedData: async () => { asked += 1; return SIG; }, journal: memJournal(), fetchImpl: postNet(), now });
  assert.equal(w.code, "wallet");
  assert.equal(asked, 0);
  /* A switch made WHILE the window is open (the live wallet, read through a ref as the hook does): nothing is posted. */
  const live = { current: OWN };
  const netMid = postNet();
  const mid = await RS.executeRecover({ review: review(), ownNow: () => live.current, signTypedData: async () => { live.current = OTHER; return SIG; }, journal: memJournal(), fetchImpl: netMid, now });
  assert.equal(mid.code, "wallet");
  assert.equal(netMid.calls.length, 0, "a signature from a window the customer switched away from is never posted");
  /* TTL: a price older than a minute is never signed. */
  const stale = await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async () => { asked += 1; return SIG; }, journal: memJournal(), fetchImpl: postNet(), now: () => at(8453) + RS.RECOVER_QUOTE_TTL_MS + 1 });
  assert.equal(stale.code, "price_expired");
  assert.equal(asked, 0);
  /* …and a signing window that outlives the price posts nothing. */
  let t = at(8453) + 1000;
  const net4 = postNet();
  const slow = await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async () => { t += RS.RECOVER_QUOTE_TTL_MS; return SIG; }, journal: memJournal(), fetchImpl: net4, now: () => t });
  assert.equal(slow.code, "price_expired");
  assert.equal(net4.calls.length, 0);
  /* A storage that cannot record: nothing is sent. */
  const broken = { get: () => null, put: () => false, clear() {} };
  const net5 = postNet();
  assert.equal((await RS.executeRecover({ review: review(), ownNow: () => OWN, signTypedData: async () => SIG, journal: broken, fetchImpl: net5, now })).code, "record");
  assert.equal(net5.calls.length, 0);
  /* v3.2: the MulticallAuthorization is posted first, the EIP-3009 last; a refused first POST moves nothing. */
  const net6 = postNet();
  const two = await RS.executeRecover({ review: review(8453, v32(8453)), ownNow: () => OWN, signTypedData: async () => SIG, journal: memJournal(), fetchImpl: net6, now });
  assert.equal(two.ok, true);
  assert.deepEqual(net6.calls.map((c) => c.body.kind), ["multicall-authorization", "eip3009"]);
  const j7 = memJournal();
  const first = await RS.executeRecover({ review: review(8453, v32(8453)), ownNow: () => OWN, signTypedData: async () => SIG, journal: j7, fetchImpl: postNet({ ok: false }), now });
  assert.equal(first.code, "post_refused");
  assert.equal(j7.get(OWN, 8453), null, "nothing recorded: the money POST never went");
});

/* ── R7 a new permit only once the old one can never run ─────────────────── */

test("R7) a NEW permit on a chain only after the old one's validBefore AND a definite answer about its nonce", () => {
  const e = { nonce: `0x${"1".repeat(64)}`, validBefore: 1000 };
  assert.equal(RS.recoverAllowed(null), true);
  assert.equal(RS.recoverAllowed(e, { used: false, now: 999 * 1000 }), false, "still valid: it could still run");
  assert.equal(RS.recoverAllowed(e, { used: null, now: 2000 * 1000 }), false, "unreadable is never 'unused'");
  assert.equal(RS.recoverAllowed(e, { used: false, now: 2000 * 1000 }), true, "expired and never used");
  assert.equal(RS.recoverAllowed(e, { used: true, now: 2000 * 1000 }), true, "it ran: what is left is a new amount");
  assert.equal(RS.recoverAllowed({ nonce: e.nonce }, { used: false, now: 2000 * 1000 }), false);
});

/* ── R8 reads ────────────────────────────────────────────────────────────── */

test("R8) balances: one balanceOf per chain; an unreadable answer is null, never 0; under 1 USDC is listed, not offered", async () => {
  const timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
  const asked = [];
  const rpc = async (url, init) => {
    const b = JSON.parse(init.body);
    asked.push({ url, to: b.params[0].to, data: b.params[0].data });
    if (url.includes("polygon")) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: word(990000) }) };
    if (url === "https://mainnet.base.org") return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: word(9994700) }) };
  };
  const rows = await RS.readStrandedUsdc({ own: OWN, fetchImpl: rpc, timers });
  const base = rows.find((r) => r.chainId === 8453);
  const pol = rows.find((r) => r.chainId === 137);
  assert.equal(base.raw, 9994700n, "the first RPC failed; the second answered");
  assert.equal(base.usdc, 9.9947);
  assert.equal(base.offered, true);
  assert.equal(pol.usdc, 0.99);
  assert.equal(pol.offered, false);
  assert.ok(asked.every((a) => a.data.startsWith("0x70a08231") && a.data.toLowerCase().endsWith(OWN.slice(2).toLowerCase())), "balanceOf(own) only");
  assert.deepEqual([...new Set(asked.map((a) => a.to))].sort(), [RS.RECOVER_CHAINS[137].usdc, RS.RECOVER_CHAINS[8453].usdc].sort());
  const dead = await RS.readStrandedUsdc({ own: OWN, fetchImpl: async () => { throw new Error("down"); }, timers });
  assert.deepEqual(dead.map((r) => [r.raw, r.usdc, r.offered]), [[null, null, false], [null, null, false]]);
  assert.deepEqual(await RS.readStrandedUsdc({ own: "nope", fetchImpl: rpc, timers }), []);
  /* The nonce read: 1 used, 0 unused, anything else null. */
  const used = (v) => RS.readPermitUsed({ own: OWN, chainId: 137, nonce: `0x${"1".repeat(64)}`, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: v }) }), timers });
  assert.equal(await used(word(1)), true);
  assert.equal(await used(word(0)), false);
  assert.equal(await used("0x"), null);
});

/* ── R9 source guards ────────────────────────────────────────────────────── */

test("R9) source guards: nothing here holds a signer or sends a transaction; PrivyBridge provides the VISIBLE one; the switch is on; no silent path", () => {
  const src = stripComments(read("src/lib/relay/recoverStranded.js"));
  assert.doesNotMatch(src, /sendTransaction|eth_sendRawTransaction|personal_sign|privateKey|mnemonic|walletClient|getSigner/);
  assert.doesNotMatch(src, /import\.meta\.env|VITE_|process\.env/);
  /* The signer is only ever the injected one (a parameter, or what PrivyBridge provides), handed the review it signs for. */
  assert.equal((src.match(/signTypedData/g) || []).length, 3, "the parameter, its default, and its one call");
  assert.match(src, /signTypedData = SIGNER/);
  assert.match(src, /await signTypedData\(s\.typedData, review\)/);
  /* PrivyBridge provides it: its shown-hook signer behind the closed builder, once (test-perp-silent-enable B11 / G1c). */
  const bridge = stripComments(read("src/components/privy/PrivyBridge.jsx"));
  assert.match(bridge, /import \{ provideRecoverSigner \} from "\.\.\/\.\.\/lib\/relay\/recoverStranded\.js";/);
  assert.equal((bridge.match(/provideRecoverSigner\(/g) || []).length, 1);
  assert.match(bridge, /recoverTypedDataFromRequest\(typedData, review, embeddedAddress\)/);
  /* The switch is on, now that the signer and its tests are green: Base and Polygon are offered. */
  assert.equal(C.PRIVATE_RECOVER_READY, true);
  assert.deepEqual(A.privateDepositRoutesOffered().map((r) => r.chainId), [42161, 43114, 8453, 137]);
  /* The silent-signing allow-lists do not grow. */
  assert.doesNotMatch(read("src/lib/hyperliquid/exchange/master.js"), /recoverStranded|recoverClosed/);
  const silent = bridge.slice(bridge.indexOf("const SILENT_APPROVALS"), bridge.indexOf("export function silentApprovalTypedData"));
  assert.doesNotMatch(silent, /ReceiveWithAuthorization|MulticallAuthorization|recover/i);
});

/* ── R10 the live wallet ────────────────────────────────────────────────── */

test("R10) 🔴 the wallet-switch guard reads the wallet connected NOW (a ref updated every render), not the one the confirm began with", () => {
  const hook = stripComments(read("src/perp/deposit/usePrivateDeposit.js"));
  assert.match(hook, /const own = useRef\(user\);\s*own\.current = user;/);
  assert.match(hook, /ownNow: \(\) => own\.current/);
  assert.doesNotMatch(hook, /ownNow: \(\) => user\b/, "never the closed-over wallet");
});

/* ── R11 the closed builder's pins ──────────────────────────────────────── */

test("R11) the closed builder's written-out pins are recoverStranded's own, and its window is executeRecover's", async () => {
  const RC = await import("../src/lib/relay/recoverClosed.js");
  assert.deepEqual(Object.keys(RC.RECOVER_SIGN_CHAINS).map(Number).sort(), [...RS.RECOVER_CHAIN_IDS].sort());
  for (const id of RS.RECOVER_CHAIN_IDS) {
    const mine = RC.RECOVER_SIGN_CHAINS[id];
    const theirs = RS.RECOVER_CHAINS[id];
    assert.equal(mine.chainId, theirs.chainId);
    assert.equal(mine.chainName, theirs.chainName);
    assert.equal(mine.usdc, theirs.usdc);
    assert.equal(mine.usdc, theirs.domain.verifyingContract, "the permit domain IS that chain's native USDC");
    assert.equal(theirs.domain.name, "USD Coin");
    assert.equal(theirs.domain.version, "2");
    assert.equal(theirs.mcaDomain.name, "RelayApprovalProxy");
    assert.equal(theirs.mcaDomain.version, "3.1");
    assert.equal(theirs.mcaDomain.verifyingContract, RC.RECOVER_SIGN_RELAY.v32ApprovalProxy);
  }
  assert.equal(RC.RECOVER_SIGN_RELAY.v3ApprovalProxy, RS.RECOVER_RELAY.v3.approvalProxy);
  assert.equal(RC.RECOVER_SIGN_RELAY.v32ApprovalProxy, RS.RECOVER_RELAY["v3.2"].approvalProxy);
  assert.equal(RC.RECOVER_SIGN_RELAY.depository, RS.RECOVER_RELAY.depository);
  assert.equal(RC.RECOVER_SIGN_WINDOW.maxValidS, RS.PERMIT_MAX_VALID_S);
  assert.equal(RC.RECOVER_SIGN_WINDOW.clockSkewS, RS.PERMIT_CLOCK_SKEW_S);
  assert.match(stripComments(read("src/lib/relay/recoverStranded.js")), /review\.validBefore >= Math\.floor\(now\(\) \/ 1000\) \+ 30/, "executeRecover's own 30 s");
  assert.equal(RC.RECOVER_SIGN_WINDOW.minLeftS, 30);
});

/* ── R12 end to end, with fakes ─────────────────────────────────────────── */

/* Hardhat's public test key #0: its address is OWN. Offline signing only. */
const OWN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BRIDGE = "src/components/privy/PrivyBridge.jsx";

/* Typed data as viem signs it: every uint as a bigint, through nested structs and arrays (Privy's SDK does the same). */
function viemTyped(td) {
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== "EIP712Domain"));
  const conv = (type, v) => {
    if (type.endsWith("[]")) return v.map((x) => conv(type.slice(0, -2), x));
    if (types[type]) return Object.fromEntries(types[type].map((f) => [f.name, conv(f.type, v[f.name])]));
    if (/^u?int\d*$/.test(type)) return BigInt(v);
    return v;
  };
  return { domain: td.domain, types, primaryType: td.primaryType, message: conv(td.primaryType, td.message) };
}

/* The REAL PrivyBridge, bundled with Privy stubbed: its shown signTypedData hook is a fake Privy that signs offline
   with OWN's key; what it hands provideRecoverSigner is the bridge's own Recover signer (closed builder included). */
async function mountBridgeSigner({ address = OWN } = {}) {
  const H = await import("./lib/perpLiveHarness.mjs");
  const viemAccounts = await import("viem/accounts");
  const account = viemAccounts.privateKeyToAccount(OWN_KEY);
  H.fakeBrowser();
  const asked = [];
  const provided = [];
  globalThis.__impl = {
    usePrivy: () => ({ ready: true, authenticated: true }),
    useWallets: () => ({ wallets: [{ walletClientType: "privy", address }] }),
    useLogout: () => ({ logout: async () => {} }),
    useLogin: () => ({ login: () => {} }),
    useSignTypedData: () => ({ signTypedData: async (td, opts) => { asked.push([td, opts]); return { signature: await account.signTypedData(viemTyped(td)) }; } }),
    useSendTransaction: () => ({ sendTransaction: async () => { throw new Error("Recover sends no transaction"); } }),
    registerPrivyApi: () => {},
    privyChainId: () => 42161,
    provideRecoverSigner: (fn) => { provided.push(fn); return () => {}; },
  };
  const Mod = await H.bundle({ entry: BRIDGE, env: { VITE_PERP_ENABLED: "0" }, stubs: H.autoStubs([BRIDGE], { keep: ["src/lib/perpFlag.js", "src/services/signWords.js", "src/lib/relay/recoverClosed.js"] }) });
  const h = Mod.mount(() => Mod.default());
  h.render(); h.flush();
  assert.equal(provided.length, 1, "the bridge hands Recover its signer");
  return { signer: provided[0], asked, h };
}

/* Relay, faked: /quote/v2 answers the live capture for OWN, re-timed to now; /execute/permits records and answers ok. */
function fakeRelay(json) {
  const quotes = [];
  const posts = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/\/quote\/v2$/.test(String(url))) { quotes.push(body); return { ok: true, status: 200, json: async () => clone(json) }; }
    if (/^https:\/\/api\.relay\.link\/execute\/permits\?signature=0x[0-9a-f]{130}$/.test(String(url))) { posts.push({ url: String(url), body }); return { ok: true, status: 200 }; }
    throw new Error(`fake Relay: unexpected ${url}`);
  };
  return Object.assign(fn, { quotes, posts });
}
const sigOf = (url) => url.slice(url.indexOf("signature=") + 10);
function retimed(json, nowMs) {
  const s = Math.floor(nowMs / 1000) + 500;
  for (const it of json.steps[0].items) {
    const v = it.data.sign.value;
    if (it.data.sign.primaryType === "ReceiveWithAuthorization") v.validBefore = s;
    else v.funding[0].validBefore = s;
  }
  return json;
}

test("R12) 🔴 END TO END: quote → verified review → executeRecover → the bridge's VISIBLE signer → Relay; the posted signature is this wallet's over Relay's own typed data", async () => {
  const { recoverTypedDataFromRequest } = await import("../src/lib/relay/recoverClosed.js");
  const { recoverTypedDataAddress } = await import("viem");
  const b = await mountBridgeSigner();
  const takeBack = RS.provideRecoverSigner(b.signer);
  try {
    assert.equal(RS.recoverSigner(), b.signer, "Recover's default signer is now the bridge's");
    for (const id of [8453, 137]) {
      const json = retimed(answer(id), Date.now());
      const relay = fakeRelay(json);
      const review = await RS.quoteRecover({ own: OWN, chainId: id, amountRaw: "10000000", fetchImpl: relay });
      assert.deepEqual(relay.quotes, [RS.buildRecoverQuoteBody({ own: OWN, chainId: id, amountRaw: "10000000" })], "one quote, own → own");
      const journal = memJournal();
      const before = b.asked.length;
      const r = await RS.executeRecover({ review, ownNow: () => OWN, journal, fetchImpl: relay });
      assert.deepEqual(r, { ok: true, requestId: json.requestId, state: "arriving" });
      /* One window, shown, with the decoded words; on this chain's USDC; never a switch. */
      assert.equal(b.asked.length, before + 1);
      const [td, opts] = b.asked[b.asked.length - 1];
      assert.equal(opts.address, OWN);
      assert.equal(opts.uiOptions.showWalletUIs, true);
      assert.equal(opts.uiOptions.description, `Move 10 USDC from your wallet on ${RS.RECOVER_CHAINS[id].chainName} into your balance. At least 9.77 USDC arrives. No gas needed.`);
      assert.equal(td.domain.chainId, id);
      assert.equal(td.domain.verifyingContract, RS.RECOVER_CHAINS[id].usdc);
      /* One POST, the eip3009 one, and its signature recovers to OWN over the typed data RELAY gave. */
      assert.equal(relay.posts.length, 1);
      assert.equal(relay.posts[0].body.kind, "eip3009");
      assert.equal(relay.posts[0].body.requestId, json.requestId);
      const sign = json.steps[0].items[0].data.sign;
      const who = await recoverTypedDataAddress({ ...viemTyped({ domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message: sign.value }), signature: sigOf(relay.posts[0].url) });
      assert.equal(who.toLowerCase(), OWN.toLowerCase());
      assert.equal(journal.get(OWN, id).state, "sent");
    }

    /* v3.2 (from 2026-10-26): two windows in order, two POSTs in order, both this wallet's. */
    const j2 = retimed(v32(8453), Date.now());
    const relay2 = fakeRelay(j2);
    const r2 = await RS.quoteRecover({ own: OWN, chainId: 8453, amountRaw: "10000000", fetchImpl: relay2 });
    const before2 = b.asked.length;
    const ok2 = await RS.executeRecover({ review: r2, ownNow: () => OWN, journal: memJournal(), fetchImpl: relay2 });
    assert.equal(ok2.ok, true);
    assert.deepEqual(b.asked.slice(before2).map(([td]) => td.primaryType), ["MulticallAuthorization", "ReceiveWithAuthorization"]);
    assert.match(b.asked[before2][1].uiOptions.description, /^Authorizing exactly 10 USDC from your wallet on Base for this move/);
    assert.deepEqual(relay2.posts.map((p) => p.body.kind), ["multicall-authorization", "eip3009"]);
    for (const [i, p] of relay2.posts.entries()) {
      const sign = j2.steps[0].items[i].data.sign;
      const who = await recoverTypedDataAddress({ ...viemTyped({ domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message: sign.value }), signature: sigOf(p.url) });
      assert.equal(who.toLowerCase(), OWN.toLowerCase(), `signature ${i}`);
    }

    /* 🔴 A review forged after it was verified (its permit now pays a stranger): the bridge refuses BEFORE Privy is
       asked; nothing is posted or recorded, and the row says so. */
    const fresh = await RS.quoteRecover({ own: OWN, chainId: 8453, amountRaw: "10000000", fetchImpl: fakeRelay(retimed(answer(8453), Date.now())) });
    for (const forge of [
      (v) => { v.signatures[0].typedData.message.to = OTHER; },
      (v) => { v.signatures[0].typedData.domain.chainId = 137; },
      /* the review's own amountRaw is frozen on the real review: only the message can be made to say more */
      (v) => { v.signatures[0].typedData.message.value = "100000000"; },
    ]) {
      const forged = clone(fresh);
      forge(forged);
      assert.equal(recoverTypedDataFromRequest(forged.signatures[0].typedData, forged, OWN), null, "the closed builder refuses it");
      const relay3 = fakeRelay(null);
      const j3 = memJournal();
      const before3 = b.asked.length;
      const no = await RS.executeRecover({ review: forged, ownNow: () => OWN, journal: j3, fetchImpl: relay3 });
      assert.equal(no.ok, false);
      assert.equal(no.code, "refused");
      assert.equal(no.message, RS.RECOVER_WORDS.refused);
      assert.equal(b.asked.length, before3, "Privy was never asked");
      assert.equal(relay3.posts.length, 0, "nothing posted");
      assert.equal(j3.get(OWN, 8453), null, "nothing recorded");
    }
    /* In place, on the real review: its figures are frozen, and a permit made to pay a stranger is still refused. */
    assert.throws(() => { fresh.amountRaw = "100000000"; }, TypeError);
    assert.throws(() => { fresh.signatures[0].typedData = null; }, TypeError);
    fresh.signatures[0].typedData.message.to = OTHER;
    const relay4 = fakeRelay(null);
    const before4 = b.asked.length;
    assert.equal((await RS.executeRecover({ review: fresh, ownNow: () => OWN, journal: memJournal(), fetchImpl: relay4 })).code, "refused");
    assert.equal(b.asked.length, before4);
    assert.equal(relay4.posts.length, 0);
  } finally {
    takeBack();
    b.h.unmount();
  }
  assert.equal(RS.recoverSigner(), null, "taken back");
});

/* ── R13 the Recover row ────────────────────────────────────────────────── */

test("R13) the Recover row: press → verified review → confirm signs through the bridge's signer and posts; a signer for another wallet reads \"can't sign here\" first", async () => {
  const H = await import("./lib/perpLiveHarness.mjs");
  const b = await mountBridgeSigner();
  const HOOK = "src/perp/deposit/usePrivateDeposit.js";
  const Mod = await H.bundle({ entry: HOOK, env: {}, stubs: H.autoStubs([HOOK]) });
  const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const json = retimed(answer(8453), Date.now());
  const relay = fakeRelay(json);
  const journal = memJournal();
  const deps = (signer) => ({
    read: async () => [{ chainId: 8453, chainName: "Base", chainLogo: null, raw: 10000000n, usdc: 10, offered: true }],
    quote: (a) => RS.quoteRecover({ ...a, fetchImpl: relay }),
    execute: (a) => RS.executeRecover({ ...a, fetchImpl: relay }),
    used: async () => null,
    journal,
    signer,
  });
  const h = Mod.mount(() => Mod.useStrandedRecover({ user: OWN, enabled: true, deps: deps(b.signer) }));
  h.render(); await tick(); h.flush();
  assert.equal(h.value.canSign, true, "the bridge's signer names this wallet");
  assert.equal(h.value.rows.length, 1);
  h.value.price(h.value.rows[0]); h.flush(); await tick(); h.flush();
  assert.equal(h.value.job.status, "review");
  assert.equal(h.value.job.review.receiveUsdc, "9.97678");
  const asked = b.asked.length;
  await h.value.confirm(); await tick(); h.flush();
  assert.equal(h.value.job.status, "sent");
  assert.equal(b.asked.length, asked + 1, "one window");
  assert.equal(relay.posts.length, 1);
  h.unmount();

  /* The bridge's signer is for OWN; another wallet connected here cannot use it, and the row says so before a press. */
  const h2 = Mod.mount(() => Mod.useStrandedRecover({ user: OTHER, enabled: true, deps: deps(b.signer) }));
  h2.render(); await tick(); h2.flush();
  assert.equal(h2.value.canSign, false);
  h2.unmount();
  /* A test signer that names no wallet is taken as it is; no signer at all cannot sign. */
  const h3 = Mod.mount(() => Mod.useStrandedRecover({ user: OWN, enabled: true, deps: deps(async () => `0x${"ab".repeat(65)}`) }));
  h3.render(); h3.flush();
  assert.equal(h3.value.canSign, true);
  h3.unmount();
  const h4 = Mod.mount(() => Mod.useStrandedRecover({ user: OWN, enabled: true, deps: deps(null) }));
  h4.render(); h4.flush();
  assert.equal(h4.value.canSign, false);
  h4.unmount();
  b.h.unmount();
});
