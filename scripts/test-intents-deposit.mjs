/**
 * test-intents-deposit — PRIVATE MODE'S DEPOSIT (Normal | Private), through a one-time 1Click address.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "Start Now ทำ Backend ก่อน". What this suite pins:
 *
 *   A. the assets, pairs and routes, and exact unit arithmetic (BigInt, never rounded);
 *   B. the plan: private-arb only for a Privy wallet whose Arbitrum ETH was READ and clears the floor;
 *   C. the quote body: recipient = refundTo = the connected wallet, nothing else in it, and the proxy accepts it;
 *   D. the answer is VERIFIED on its own echo before any address is shown (every refusal, one by one);
 *   E. the one-time address: route live first, cached per (user, route, plan, amount, privacy), reused ONLY while
 *      the service still says PENDING_DEPOSIT, forgotten otherwise;
 *   F. the status mapping: all seven statuses, INCOMPLETE_DEPOSIT never credited, a foreign row is unknown;
 *   G. the tracker: trackDeposits' contract and schedule;
 *   H. the deposit watch: a provider per entry, persisted, legacy entries are Relay's, private-arb lands in the wallet;
 *   I. source guards: nothing here signs, the silent list does not grow, the key never reaches the page.
 *
 * MONEY SAFETY. No request leaves this process: global fetch throws, and every call goes through a mock. The quote
 * fixtures are live DRY answers (scripts/fixtures/intents, each file names its source). No dry:false quote was made
 * for this suite: the non-dry deposit answer below is the live dry answer given the address fields exactly as the
 * one live non-dry answer carries them (nondry-hc-to-arb-20-research.json). Status answers are SYNTHETIC, shaped by
 * the API's own schema (GetExecutionStatusResponse) around the live quote echo: no deposit has been made.
 *
 * Run: node --test scripts/test-intents-deposit.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/stripComments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) => stripComments(read(rel));
const fixture = (name) => JSON.parse(read(`scripts/fixtures/intents/${name.endsWith(".json") ? name : `${name}.json`}`));

const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error("live network is forbidden in test-intents-deposit"); }; });
after(() => { globalThis.fetch = realFetch; });

let C; let A; let CL; let S; let D; let G; let W; let R; let AB; let WF; let RD; let PV;
before(async () => {
  C = await import("../src/lib/intents/config.js");
  A = await import("../src/lib/intents/assets.js");
  CL = await import("../src/lib/intents/client.js");
  S = await import("../src/lib/intents/status.js");
  D = await import("../src/lib/intents/deposit.js");
  G = await import("../src/lib/intents/guard.js");
  W = await import("../src/perp/deposit/depositWatch.js");
  PV = await import("../src/perp/deposit/perpDepositView.js");
  R = await import("../src/lib/relay/routes.js");
  AB = await import("../src/lib/relay/arbitrumBridge.js");
  WF = await import("../src/perp/deposit/walletFunds.js");
  RD = await import("../src/lib/relay/depositAddress.js");
});

/* Public, well-known development addresses (no key is used anywhere here). */
const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEP = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const DEP2 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const CAPTURE_USER = /0xa1581fb128e573fef727dd9fc2630d0d695a1956/gi;
const NOW = Date.parse("2026-10-15T07:01:10.000Z");
const HOUR = 3600000;
const iso = (t) => new Date(t).toISOString();

const UP_QUOTE = "https://1click.chaindefuser.com/v0/quote";
const UP_STATUS = "https://1click.chaindefuser.com/v0/status";
const UP_TOKENS = "https://1click.chaindefuser.com/v0/tokens";

/** A live dry answer as the service would give it to `user`. */
const quoteFor = (name, user = USER, mutate = null) => {
  const f = fixture(name);
  const j = JSON.parse(JSON.stringify(f.answer).replace(CAPTURE_USER, user));
  if (mutate) mutate(j);
  return j;
};
/* The live dry answer as a NON-dry one: the echo says dry:false and the quote carries the three address fields
   exactly as the one live non-dry answer does (a checksummed address, deadline = timeWhenInactive, +72 h). */
const NONDRY_SHAPE = fixture("nondry-hc-to-arb-20-research.json").answer.quote;
const nonDryFor = (name, { user = USER, addr = DEP, life = 72 * HOUR, mutate = null } = {}) => quoteFor(name, user, (j) => {
  j.quoteRequest.dry = false;
  j.quote.depositAddress = addr;
  j.quote.deadline = iso(NOW + life);
  j.quote.timeWhenInactive = iso(NOW + life);
  if (mutate) mutate(j);
});

const TOKENS = fixture("tokens-subset.json").tokens;

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _m: m,
  };
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/* One mock for every host this folder reads: the token list, the quote, the status. */
function mockFetch({ quote = () => jsonRes(201, nonDryFor("dry-arb-to-hc-25")), status = () => jsonRes(200, statusOf("PENDING_DEPOSIT")), tokens = () => jsonRes(200, TOKENS) } = {}) {
  const calls = { quote: [], status: [], tokens: [] };
  const f = async (url, init = {}) => {
    const u = String(url);
    if (u === UP_TOKENS) { calls.tokens.push(u); return tokens(calls.tokens.length); }
    if (u === UP_QUOTE || u === "/api/intents-quote") { calls.quote.push({ url: u, body: JSON.parse(init.body) }); return quote(calls.quote.length, JSON.parse(init.body)); }
    if (u.startsWith(UP_STATUS) || u.startsWith("/api/intents-status")) { calls.status.push(u); return status(calls.status.length, u); }
    throw new Error(`unexpected request ${u}`);
  };
  f.calls = calls;
  return f;
}

/* SYNTHETIC status answers, shaped by the API's GetExecutionStatusResponse around the live quote echo. */
function statusOf(st, { user = USER, addr = DEP, swap = {}, mutate = null, updatedAt = NOW + 60000 } = {}) {
  const q = nonDryFor("dry-arb-to-hc-25", { user, addr });
  const j = {
    correlationId: "synthetic-status",
    quoteResponse: q,
    status: st,
    updatedAt: iso(updatedAt),
    swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...swap },
  };
  if (mutate) mutate(j);
  return j;
}
const TX_IN = `0x${"a".repeat(64)}`;
const TX_OUT = `0x${"b".repeat(64)}`;

const arbRoute = () => A.privateRouteById("arbitrum-usdc");
const baseRoute = () => A.privateRouteById("base-usdc");
const ask = (over = {}) => ({
  user: USER, connected: USER, route: arbRoute(), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", confidentiality: "public",
  fetchImpl: mockFetch(), storage: fakeStorage(), memory: new Map(), now: () => NOW, network: "mainnet",
  tokensMemo: CL.newIntentsTokensMemo(), quoteUrl: UP_QUOTE, statusUrl: UP_STATUS, statusFallbackUrl: UP_STATUS,
  ...over,
});

/* ════════════════════════════════════════════════════════════════════════════
   A. ASSETS, PAIRS, ROUTES, UNITS
   ════════════════════════════════════════════════════════════════════════════ */

test("A1) the five assets are the verified ones: HyperCore perps USDC (8 dp); Arbitrum, Avalanche, Base and Polygon native USDC (6 dp)", () => {
  assert.equal(A.HYPERCORE_USDC.assetId, "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054");
  assert.equal(A.HYPERCORE_USDC.decimals, 8);
  assert.equal(A.ARBITRUM_INTENTS_USDC.assetId, "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near");
  assert.equal(A.BASE_INTENTS_USDC.assetId, "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near");
  assert.equal(A.ARBITRUM_INTENTS_USDC.decimals, 6);
  assert.equal(A.BASE_INTENTS_USDC.decimals, 6);
  /* Written out (the proxy bundles nothing else); held equal to the Relay tables here. */
  assert.equal(A.ARBITRUM_INTENTS_USDC.contractAddress, AB.ARBITRUM_USDC);
  assert.equal(A.ARBITRUM_INTENTS_USDC.contractAddress, R.routeById("arbitrum-usdc").address);
  assert.equal(A.BASE_INTENTS_USDC.contractAddress, R.routeById("base-usdc").address);
  /* Owner, 2026-10-15: the four chains. The HOT-bridge ids are read off the live list (not derived from the contract);
     the contract is the NATIVE USDC each Relay route already uses, never a bridged USDC.e. */
  assert.equal(A.AVALANCHE_INTENTS_USDC.assetId, "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o");
  assert.equal(A.POLYGON_INTENTS_USDC.assetId, "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L");
  assert.equal(A.AVALANCHE_INTENTS_USDC.contractAddress, R.routeById("avalanche-usdc").address);
  assert.equal(A.POLYGON_INTENTS_USDC.contractAddress, R.routeById("polygon-usdc").address);
  assert.notEqual(A.POLYGON_INTENTS_USDC.contractAddress, "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "not USDC.e");
  for (const a of [A.AVALANCHE_INTENTS_USDC, A.POLYGON_INTENTS_USDC]) {
    assert.equal(a.decimals, 6);
    const live = TOKENS.find((t) => t.assetId === a.assetId);
    assert.ok(live, `${a.assetId} is in the live list`);
    assert.equal(live.contractAddress.toLowerCase(), a.contractAddress);
    assert.equal(live.blockchain, a.blockchain);
  }
  /* 🔴 The other HyperCore "USDC" in the live list is not the perps balance. */
  const decoy = TOKENS.find((t) => t.assetId.startsWith("1cs_v1:hypercore:erc20:"));
  assert.ok(decoy && decoy.symbol === "USDC" && decoy.decimals === 6, "the live list carries it");
  assert.equal(A.intentsAssetById(decoy.assetId), null);
});

test("A2) the live token list carries every asset as we know it; a missing one, other decimals or another contract is a problem line", () => {
  assert.deepEqual(A.intentsRouteProblems(TOKENS), []);
  assert.deepEqual(A.intentsRouteProblems(null), ["no token list"]);
  const without = TOKENS.filter((t) => t.assetId !== A.HYPERCORE_USDC.assetId);
  assert.match(A.intentsRouteProblems(without).join(";"), /not listed/);
  const dec = TOKENS.map((t) => (t.assetId === A.HYPERCORE_USDC.assetId ? { ...t, decimals: 6 } : t));
  assert.match(A.intentsRouteProblems(dec).join(";"), /decimals are 6, not 8/);
  const con = TOKENS.map((t) => (t.assetId === A.ARBITRUM_INTENTS_USDC.assetId ? { ...t, contractAddress: OTHER } : t));
  assert.match(A.intentsRouteProblems(con).join(";"), /contract is/);
});

test("A3) twelve pairs and no others: the four chains' USDC into perps or the own Arbitrum wallet, and perps out to each", () => {
  assert.equal(A.INTENTS_PAIRS.length, 12);
  const H = A.HYPERCORE_USDC.assetId; const AR = A.ARBITRUM_INTENTS_USDC.assetId; const B = A.BASE_INTENTS_USDC.assetId;
  const AV = A.AVALANCHE_INTENTS_USDC.assetId; const P = A.POLYGON_INTENTS_USDC.assetId;
  for (const o of [AR, AV, B, P]) {
    assert.equal(A.intentsPairOf(o, H).direction, "deposit", o);
    assert.equal(A.intentsPairOf(o, AR).direction, "deposit", `${o} → own Arbitrum wallet (private-arb)`);
    assert.equal(A.intentsPairOf(H, o).direction, "withdraw", o);
  }
  assert.equal(A.intentsPairOf(H, H), null);
  for (const o of [B, AV, P]) assert.equal(A.intentsPairOf(o, o), null, "no same-chain pair but Arbitrum's own");
  assert.equal(A.intentsPairOf(B, AV), null);
  assert.equal(A.intentsPairOf(AR, "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f"), null);
  /* Nothing else: Ethereum, BNB, OP, Solana, BTC and other assets are not origins. */
  for (const id of ["nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "nep141:btc.omft.near", "nep141:arb.omft.near"]) {
    assert.equal(A.intentsPairOf(id, H), null, id);
    assert.equal(A.intentsPairOf(H, id), null, id);
  }
});

test("A4) the private routes use the Relay route ids (so the watch, the strip and get_funds name them the same), Arbitrum first", () => {
  assert.deepEqual(A.PRIVATE_DEPOSIT_ROUTES.map((r) => r.id), ["arbitrum-usdc", "avalanche-usdc", "base-usdc", "polygon-usdc"]);
  assert.deepEqual(A.PRIVATE_DEPOSIT_ROUTES.map((r) => r.refundLands), ["auto-move", "spot", "recover", "recover"]);
  /* 🔴 ONE SWITCH: Base and Polygon only once Recover can sign — it can (PrivyBridge's visible Recover signer). */
  assert.equal(C.PRIVATE_RECOVER_READY, true);
  assert.deepEqual(A.privateDepositRoutesOffered().map((r) => r.id), ["arbitrum-usdc", "avalanche-usdc", "base-usdc", "polygon-usdc"]);
  assert.deepEqual(A.privateDepositRoutesOffered({ recoverReady: false }).map((r) => r.id), ["arbitrum-usdc", "avalanche-usdc"]);
  assert.equal(A.offeredPrivateRoute("base-usdc", { recoverReady: false }).id, "arbitrum-usdc", "a hidden route never stands");
  assert.equal(A.offeredPrivateRoute("base-usdc").id, "base-usdc");
  assert.equal(A.offeredPrivateRoute("polygon-usdc", { recoverReady: true }).id, "polygon-usdc");
  assert.equal(A.DEFAULT_PRIVATE_ROUTE_ID, "arbitrum-usdc");
  for (const r of A.PRIVATE_DEPOSIT_ROUTES) {
    const relay = R.routeById(r.id);
    assert.equal(relay.chainName, r.chainName);
    assert.equal(relay.token, r.token);
    assert.equal(relay.chainId, r.chainId);
    assert.equal(r.provider, "near");
  }
  assert.equal(arbRoute().refundAutoMoves, true, "a refund on Arbitrum lands where the auto-mover picks it up");
  assert.equal(baseRoute().refundAutoMoves, false, "a refund on Base has no in-app way back yet");
});

test("A5) 🔴 exact units: parsed and scaled with BigInt; 8 → 6 refuses a sub-micro remainder instead of rounding it", () => {
  assert.equal(A.parseUnitsExact("25", 6), 25000000n);
  assert.equal(A.parseUnitsExact("25.5", 6), 25500000n);
  assert.equal(A.parseUnitsExact(".5", 6), 500000n);
  assert.equal(A.parseUnitsExact("0.000001", 6), 1n);
  assert.throws(() => A.parseUnitsExact("0.0000001", 6), RangeError);
  for (const bad of ["", "-1", "1e3", "1,000", "abc", "1.2.3", " ", null]) assert.throws(() => A.parseUnitsExact(bad, 6), RangeError, String(bad));
  assert.equal(A.formatUnitsExact(2468470000n, 8), "24.6847");
  assert.equal(A.formatUnitsExact(0n, 6), "0");
  assert.equal(A.rescaleExact(25000000n, 6, 8), 2500000000n);
  assert.equal(A.rescaleExact(2500000000n, 8, 6), 25000000n);
  assert.throws(() => A.rescaleExact(2500000001n, 8, 6), RangeError);
  /* A million BNB-style 18-decimal tokens is 2^80: not a float. */
  assert.equal(A.parseUnitsExact("1000000", 18), 10n ** 24n);
  assert.equal(A.rawOf("25000000"), 25000000n);
  assert.equal(A.rawOf("2.5"), null);
  assert.equal(A.rawOf(25000000), null, "a number is not a base-unit string");
});

/* ════════════════════════════════════════════════════════════════════════════
   B. WHICH PLAN
   ════════════════════════════════════════════════════════════════════════════ */

test("B1) private-arb only for a Privy wallet whose Arbitrum ETH was read and clears 3× the hop; everything else is private-core", () => {
  const floor = D.privateArbGasFloorWei();
  assert.equal(floor, 68100n * 100000000n * 3n, "68,100 gas × 0.1 gwei × 3");
  assert.equal(D.privatePlanFor({ walletType: "privy", gasWei: floor }), "private-arb");
  assert.equal(D.privatePlanFor({ walletType: "privy", gasWei: floor - 1n }), "private-core");
  assert.equal(D.privatePlanFor({ walletType: "privy", gasWei: 0n }), "private-core", "0 ETH: the mover would refuse no-gas");
  assert.equal(D.privatePlanFor({ walletType: "privy", gasWei: null }), "private-core", "unread is not enough");
  assert.equal(D.privatePlanFor({ walletType: "privy" }), "private-core");
  assert.equal(D.privatePlanFor({ walletType: "injected", gasWei: 10n ** 18n }), "private-core", "the auto-mover moves only the in-app wallet's money");
  assert.equal(D.privatePlanFor({}), "private-core");
  /* A live gas price above the floor price raises the floor. */
  assert.equal(D.privatePlanFor({ walletType: "privy", gasWei: floor, gasPriceWei: 200000000n }), "private-core");
  assert.equal(D.privateArbGasOk({ gasWei: null }), null);
  assert.equal(D.privatePlanLandsInWallet("private-arb"), true);
  assert.equal(D.privatePlanLandsInWallet("private-core"), false);
});

test("B2) the read version never rejects: a failed gas read is private-core", async () => {
  assert.deepEqual(await D.choosePrivatePlan({ owner: USER, walletType: "privy", readGas: async () => { throw new Error("rpc down"); } }), { planId: "private-core", gasWei: null });
  assert.deepEqual(await D.choosePrivatePlan({ owner: USER, walletType: "privy", readGas: async () => 10n ** 15n }), { planId: "private-arb", gasWei: 10n ** 15n });
  assert.deepEqual(await D.choosePrivatePlan({ owner: USER, walletType: "privy", readGas: async () => "lots" }), { planId: "private-core", gasWei: null });
  let asked = false;
  assert.equal((await D.choosePrivatePlan({ owner: USER, walletType: "injected", readGas: async () => { asked = true; return 10n ** 18n; } })).planId, "private-core");
  assert.equal(asked, false, "nothing is read for a wallet that cannot take private-arb");
});

/* ════════════════════════════════════════════════════════════════════════════
   C. THE QUOTE BODY
   ════════════════════════════════════════════════════════════════════════════ */

test("C1) 🔴 recipient AND refundTo are the connected wallet; the body carries nothing else we did not choose", () => {
  const b = D.buildIntentsDepositQuoteBody({ user: USER, connected: USER, route: arbRoute(), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", now: NOW });
  assert.deepEqual(b, {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: A.ARBITRUM_INTENTS_USDC.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: A.HYPERCORE_USDC.assetId,
    amount: "25000000", refundTo: USER, refundType: "ORIGIN_CHAIN", recipient: USER, recipientType: "DESTINATION_CHAIN",
    deadline: iso(NOW + HOUR), confidentiality: "public",
  });
  const arb = D.buildIntentsDepositQuoteBody({ user: USER, connected: USER, route: baseRoute(), plan: D.PRIVATE_ARB_PLAN, amountRaw: "25000000", dry: true, now: NOW });
  assert.equal(arb.destinationAsset, A.ARBITRUM_INTENTS_USDC.assetId);
  assert.equal(arb.dry, true);
  for (const k of ["appFees", "customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient", "referral", "rebates", "insured"]) assert.equal(k in b, false, k);
});

test("C2) refused before anything leaves: another wallet, a Relay route object, an unknown plan, testnet, a bad privacy level", () => {
  const base = { user: USER, connected: USER, route: arbRoute(), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", now: NOW };
  const code = (over) => { try { D.buildIntentsDepositQuoteBody({ ...base, ...over }); return "ok"; } catch (e) { return e.code; } };
  assert.equal(code({}), "ok");
  assert.equal(code({ connected: OTHER }), "not-connected");
  assert.equal(code({ user: "0xabc", connected: "0xabc" }), "bad-user");
  assert.equal(code({ user: "0x0000000000000000000000000000000000000000", connected: "0x0000000000000000000000000000000000000000" }), "bad-user");
  assert.equal(code({ route: R.routeById("arbitrum-usdc") }), "bad-route", "a Relay route object is not a private route");
  assert.equal(code({ route: { ...arbRoute() } }), "bad-route", "a copy is not this table's own object");
  assert.equal(code({ plan: { ...D.PRIVATE_CORE_PLAN } }), "bad-plan");
  assert.equal(code({ network: "testnet" }), "testnet-off");
  assert.equal(code({ confidentiality: "secret" }), "confidentiality-mismatch");
  assert.equal(code({ amountRaw: "abc" }), "bad-amount");
  assert.equal(code({ slippageBps: 301 }), "bad-amount");
});

test("C3) the owner's limits: at least 10, at most 500, typed amounts parsed exactly (never rounded)", () => {
  const r = arbRoute();
  assert.deepEqual(D.privateDepositAmount(r, "25"), { amountRaw: "25000000", amountUsdc: 25 });
  assert.deepEqual(D.privateDepositAmount(r, "10"), { amountRaw: "10000000", amountUsdc: 10 });
  assert.deepEqual(D.privateDepositAmount(r, "500"), { amountRaw: "500000000", amountUsdc: 500 });
  const codeOf = (t, o) => { try { D.privateDepositAmount(r, t, o); return "ok"; } catch (e) { return e.code; } };
  assert.equal(codeOf("9.999999"), "below-min");
  assert.equal(codeOf("500.000001"), "over-tx-cap");
  assert.equal(codeOf("25.1234567"), "bad-amount", "a seventh decimal is refused, not rounded");
  assert.equal(codeOf("-25"), "bad-amount");
  assert.equal(codeOf("200", { limits: { ...C.PRIVATE_LIMITS, maxTxUsdc: 100 } }), "over-tx-cap");
  const codeB = (amountRaw) => { try { D.buildIntentsDepositQuoteBody({ user: USER, connected: USER, route: r, plan: D.PRIVATE_CORE_PLAN, amountRaw, now: NOW }); return "ok"; } catch (e) { return e.code; } };
  assert.equal(codeB("9999999"), "below-min");
  assert.equal(codeB("500000001"), "over-tx-cap");
});

test("C4) the body the page builds is exactly one the proxy accepts (the same allow-list, both sides), from each of the four chains", () => {
  for (const [route, plan] of A.PRIVATE_DEPOSIT_ROUTES.flatMap((r) => [[r, D.PRIVATE_CORE_PLAN], [r, D.PRIVATE_ARB_PLAN]])) {
    for (const dry of [true, false]) {
      const b = D.buildIntentsDepositQuoteBody({ user: USER, connected: USER, route, plan, amountRaw: "25000000", dry, now: NOW });
      const c = G.checkQuoteBody(b, { now: NOW, confidentiality: "public" });
      assert.equal(c.ok, true, `${route.id} → ${plan.id} dry=${dry}: ${c.error}`);
      assert.equal(c.direction, "deposit");
      assert.equal(c.amountUsdc, 25);
      assert.deepEqual(Object.keys(c.body).sort(), Object.keys(b).sort());
    }
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   D. THE ANSWER IS VERIFIED ON ITS OWN ECHO
   ════════════════════════════════════════════════════════════════════════════ */

const parse = (json, over = {}) => D.parseIntentsDepositQuote(json, { user: USER, route: arbRoute(), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", confidentiality: "public", dry: true, now: NOW, ...over });

test("D1) live dry answer, Arbitrum USDC → perps, 25: passes; every figure is the answer's own, exact", () => {
  const q = parse(quoteFor("dry-arb-to-hc-25"));
  assert.equal(q.plan, "private-core");
  assert.equal(q.depositAddress, null, "a price-only quote reserves nothing");
  assert.equal(q.amountIn, 25);
  assert.equal(q.amountOut, 24.6847);
  assert.equal(q.minAmountOut, 24.434753);
  assert.equal(q.feeUsdc, 0.3153, "25 − 24.6847, at 8 decimals, exactly");
  assert.equal(q.withdrawFeeUsdc, 0.3153);
  assert.equal(q.refundFeeUsdc, 0.0053, "a refund's cost, in the origin token");
  assert.equal(q.platformFeeBps, 0);
  assert.equal(q.timeEstimateSec, 35);
  assert.equal(q.private, false, "public is a preview, never 'Private'");
  assert.equal(q.signatureVerified, false, "UNVERIFIED, and it says so");
  assert.match(q.signature, /^ed25519:/);
});

test("D2) live dry answer, Arbitrum USDC → own Arbitrum wallet (private-arb), 25: passes, and the least that can arrive clears 5", () => {
  const q = parse(quoteFor("dry-arb-to-arb-25"), { plan: D.PRIVATE_ARB_PLAN });
  assert.equal(q.plan, "private-arb");
  assert.equal(q.amountOut, 24.9947);
  assert.equal(q.minAmountOut, 24.744753);
  assert.ok(q.minAmountOut >= AB.BRIDGE_MIN_USDC);
  assert.equal(q.feeUsdc, 0.0053);
});

test("D3) the research track's live Base → perps answer carries the service's own 1 bp fee: allowed, and reported", () => {
  const f = fixture("dry-base-to-hc-20-research.json");
  const j = JSON.parse(JSON.stringify(f.answer).split(f.user).join(USER));
  const q = D.parseIntentsDepositQuote(j, { user: USER, route: baseRoute(), plan: D.PRIVATE_CORE_PLAN, amountRaw: "20000000", confidentiality: "public", dry: true, now: NOW });
  assert.equal(q.platformFeeBps, 1);
  assert.equal(q.amountOut, 19.68086);
});

test("D4) a non-dry answer: the address is EIP-55 checked, kept lowercase, and shown until 6 h before it goes inactive", () => {
  const q = parse(nonDryFor("dry-arb-to-hc-25"), { dry: false });
  assert.equal(q.depositAddress, DEP.toLowerCase());
  assert.equal(q.expiresAt, NOW + 72 * HOUR);
  assert.equal(q.inactiveAt, NOW + 72 * HOUR);
  assert.equal(q.showUntil, NOW + 66 * HOUR);
  /* A one-hour address is shown for its first half, not refused, not shown to its last second. */
  const short = parse(nonDryFor("dry-arb-to-hc-25", { life: HOUR }), { dry: false });
  assert.equal(short.showUntil, NOW + HOUR / 2);
  /* The real non-dry shape (the research track's one live address) passes the address check as given. */
  assert.equal(NONDRY_SHAPE.depositAddress, "0xD991E062BFac9d04C0bC667f7071d3697C752E0E");
  assert.equal(parse(nonDryFor("dry-arb-to-hc-25", { addr: NONDRY_SHAPE.depositAddress }), { dry: false }).depositAddress, NONDRY_SHAPE.depositAddress.toLowerCase());
});

test("D5) 🔴 every way an answer can fail to pay this wallet is refused, one by one, and no address comes out", () => {
  const nd = (m) => nonDryFor("dry-arb-to-hc-25", { mutate: m });
  const cases = [
    ["recipient is another wallet", nd((j) => { j.quoteRequest.recipient = OTHER; }), "unsafe-quote"],
    ["refundTo is another wallet", nd((j) => { j.quoteRequest.refundTo = OTHER; }), "unsafe-quote"],
    ["recipient missing", nd((j) => { delete j.quoteRequest.recipient; }), "unsafe-quote"],
    ["paid into Intents, not the chain", nd((j) => { j.quoteRequest.recipientType = "INTENTS"; }), "unsafe-quote"],
    ["refund into Intents", nd((j) => { j.quoteRequest.refundType = "INTENTS"; }), "unsafe-quote"],
    ["confidential-intents deposit type", nd((j) => { j.quoteRequest.depositType = "CONFIDENTIAL_INTENTS"; }), "unsafe-quote"],
    ["a memo deposit", nd((j) => { j.quoteRequest.depositMode = "MEMO"; }), "unsafe-quote"],
    ["flex input", nd((j) => { j.quoteRequest.swapType = "FLEX_INPUT"; }), "unsafe-quote"],
    ["any input", nd((j) => { j.quoteRequest.swapType = "ANY_INPUT"; }), "unsafe-quote"],
    ["another origin token", nd((j) => { j.quoteRequest.originAsset = A.BASE_INTENTS_USDC.assetId; }), "unsafe-quote"],
    ["the decoy HyperCore USDC", nd((j) => { j.quoteRequest.destinationAsset = "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f"; }), "unsafe-quote"],
    ["another amount asked", nd((j) => { j.quoteRequest.amount = "26000000"; }), "unsafe-quote"],
    ["a privacy level not asked for", nd((j) => { j.quoteRequest.confidentiality = "basic"; }), "unsafe-quote"],
    ["an app fee to someone else", nd((j) => { j.quoteRequest.appFees = [{ recipient: "flowflow.near", fee: 1 }]; }), "unsafe-quote"],
    ["an app fee to an EVM address", nd((j) => { j.quoteRequest.appFees = [{ recipient: OTHER, fee: 1 }]; }), "unsafe-quote"],
    ["the platform fee above 25 bps", nd((j) => { j.quoteRequest.appFees = [{ recipient: C.INTENTS_PLATFORM_FEE_ACCOUNTS[0], fee: 26 }]; }), "unsafe-quote"],
    ["two platform fees summing above 25", nd((j) => { j.quoteRequest.appFees = [{ recipient: C.INTENTS_PLATFORM_FEE_ACCOUNTS[0], fee: 20 }, { recipient: C.INTENTS_PLATFORM_FEE_ACCOUNTS[0], fee: 6 }]; }), "unsafe-quote"],
    ["a fractional fee", nd((j) => { j.quoteRequest.appFees = [{ recipient: C.INTENTS_PLATFORM_FEE_ACCOUNTS[0], fee: 1.5 }]; }), "unsafe-quote"],
    ["a custom recipient message", nd((j) => { j.quoteRequest.customRecipientMsg = "x.near"; }), "unsafe-quote"],
    ["a virtual-chain recipient", nd((j) => { j.quoteRequest.virtualChainRecipient = OTHER; }), "unsafe-quote"],
    ["a virtual-chain refund recipient", nd((j) => { j.quoteRequest.virtualChainRefundRecipient = OTHER; }), "unsafe-quote"],
    ["rebates", nd((j) => { j.quoteRequest.rebates = [{ recipient: "x.near", share: 100 }]; }), "unsafe-quote"],
    ["insurance added", nd((j) => { j.quoteRequest.insured = true; }), "unsafe-quote"],
    ["slippage above 3%", nd((j) => { j.quoteRequest.slippageTolerance = 500; }), "unsafe-quote"],
    ["the dry flag is not the one asked", nd((j) => { j.quoteRequest.dry = true; }), "unsafe-quote"],
    ["amountIn is not the amount", nd((j) => { j.quote.amountIn = "24000000"; }), "unsafe-quote"],
    ["a smaller deposit would be taken", nd((j) => { j.quote.minAmountIn = "20000000"; }), "unsafe-quote"],
    ["minAmountOut above amountOut", nd((j) => { j.quote.minAmountOut = "2468470001"; }), "unsafe-quote"],
    ["minAmountOut zero", nd((j) => { j.quote.minAmountOut = "0"; }), "unsafe-quote"],
    ["amountOut unreadable", nd((j) => { j.quote.amountOut = "24.68"; }), "unsafe-quote"],
    ["a loss far above the route's", nd((j) => { j.quote.amountOut = "2300000000"; j.quote.minAmountOut = "2200000000"; }), "unsafe-quote"],
    ["a memo on the quote", nd((j) => { j.quote.depositMemo = "123"; }), "unsafe-quote"],
    ["no deposit address", nd((j) => { delete j.quote.depositAddress; }), "bad-deposit-address"],
    ["the zero address", nd((j) => { j.quote.depositAddress = "0x0000000000000000000000000000000000000000"; }), "bad-deposit-address"],
    ["the wallet itself", nd((j) => { j.quote.depositAddress = USER; }), "bad-deposit-address"],
    ["not EVM (a NEAR account)", nd((j) => { j.quote.depositAddress = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd"; }), "bad-deposit-address"],
    ["a broken EIP-55 checksum", nd((j) => { j.quote.depositAddress = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293Bc"; }), "bad-deposit-address"],
    ["no deadline", nd((j) => { delete j.quote.deadline; delete j.quote.timeWhenInactive; }), "unsafe-quote"],
    ["a deadline in the past", nd((j) => { j.quote.deadline = iso(NOW - 1000); j.quote.timeWhenInactive = iso(NOW - 1000); }), "unsafe-quote"],
    ["too little time to send", nd((j) => { j.quote.deadline = iso(NOW + 15 * 60000); j.quote.timeWhenInactive = iso(NOW + 15 * 60000); }), "unsafe-quote"],
    ["a deadline beyond a month", nd((j) => { j.quote.deadline = iso(NOW + 40 * 24 * HOUR); j.quote.timeWhenInactive = iso(NOW + 40 * 24 * HOUR); }), "unsafe-quote"],
    ["no quote at all", { quoteRequest: {} }, "unsafe-quote"],
    ["nothing", null, "unsafe-quote"],
  ];
  for (const [why, json, want] of cases) {
    assert.throws(() => parse(json, { dry: false }), (e) => e instanceof CL.IntentsError && e.code === want, why);
  }
  /* A price-only answer that came back with an address is not what was asked for. */
  assert.throws(() => parse(quoteFor("dry-arb-to-hc-25", USER, (j) => { j.quote.depositAddress = DEP; })), /price-only/);
  /* private-arb: the least that can arrive must clear the last step's 5 USDC floor. */
  const under = quoteFor("dry-arb-to-arb-25", USER, (j) => { j.quoteRequest.amount = "10000000"; j.quote.amountIn = "10000000"; j.quote.minAmountIn = "10000000"; j.quote.amountOut = "5000000"; j.quote.minAmountOut = "4999999"; });
  assert.throws(() => parse(under, { plan: D.PRIVATE_ARB_PLAN, amountRaw: "10000000" }), /under what the last step can move/);
  /* The same answer on another plan, or for another user, is refused too. */
  assert.throws(() => parse(quoteFor("dry-arb-to-arb-25")), /destination/);
  assert.throws(() => parse(quoteFor("dry-arb-to-hc-25"), { user: OTHER }), /recipient/);
  assert.throws(() => parse(quoteFor("dry-arb-to-hc-25"), { confidentiality: "basic" }), /privacy level/);
});

/* ════════════════════════════════════════════════════════════════════════════
   E. THE ONE-TIME ADDRESS
   ════════════════════════════════════════════════════════════════════════════ */

test("E1) the first ask: route checked, ONE non-dry quote, verified, saved under its own prefix; the result says how to watch it", async () => {
  const f = mockFetch();
  const st = fakeStorage();
  const r = await D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: st }));
  assert.equal(f.calls.tokens.length, 1, "the token list is read before any address is shown");
  assert.equal(f.calls.quote.length, 1);
  assert.equal(f.calls.status.length, 0, "nothing saved, nothing to check");
  const body = f.calls.quote[0].body;
  assert.equal(body.dry, false);
  assert.equal(body.recipient, USER);
  assert.equal(body.refundTo, USER);
  assert.equal(r.depositAddress, DEP.toLowerCase());
  assert.equal(r.fromCache, false);
  assert.equal(r.amountIn, 25);
  assert.equal(r.amountOut, 24.6847);
  assert.equal(r.feeUsdc, 0.3153);
  assert.equal(r.private, false);
  assert.deepEqual({ ...r.watch }, { address: DEP.toLowerCase(), routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  const key = D.privateDepositCacheKey(USER, "arbitrum-usdc", "private-core", "25000000", "public");
  assert.ok(key.startsWith("flowflow.privateDeposit.v1:"));
  assert.notEqual(C.PRIVATE_DEPOSIT_PREFIX, RD.DEPOSIT_CACHE_PREFIX, "never the Relay cache's prefix");
  const saved = JSON.parse(st.getItem(key));
  assert.equal(saved.provider, "near");
  assert.equal(saved.depositAddress, DEP.toLowerCase());
  assert.ok(saved.answer && saved.answer.signature, "the whole signed answer is kept for disputes");
});

test("E2) 🔴 ONE ADDRESS, ONE DEPOSIT: a saved address is reused only while the service says PENDING_DEPOSIT for this wallet", async () => {
  const st = fakeStorage();
  const memory = new Map();
  await D.getPrivateDepositAddress(ask({ storage: st, memory }));
  /* Still waiting: the same address, no new quote. */
  const f1 = mockFetch();
  const again = await D.getPrivateDepositAddress(ask({ fetchImpl: f1, storage: st, memory }));
  assert.equal(again.depositAddress, DEP.toLowerCase());
  assert.equal(again.fromCache, true);
  assert.equal(f1.calls.quote.length, 0);
  assert.equal(f1.calls.status.length, 1);
  /* Each of these says "not reusable": a deposit seen, an unknown address, a read that failed, another wallet's echo. */
  const notReusable = [
    ["a deposit is known", () => jsonRes(200, statusOf("KNOWN_DEPOSIT_TX"))],
    ["already credited", () => jsonRes(200, statusOf("SUCCESS"))],
    ["less than quoted", () => jsonRes(200, statusOf("INCOMPLETE_DEPOSIT"))],
    ["unknown to the service", () => jsonRes(404, { message: "not found" })],
    ["the read failed", () => { throw new Error("offline"); }],
    ["a 500", () => jsonRes(500, { message: "boom" })],
    ["another wallet's echo", () => jsonRes(200, statusOf("PENDING_DEPOSIT", { user: OTHER }))],
    ["another address's echo", () => jsonRes(200, statusOf("PENDING_DEPOSIT", { addr: DEP2 }))],
  ];
  for (const [why, status] of notReusable) {
    const s2 = fakeStorage();
    const m2 = new Map();
    await D.getPrivateDepositAddress(ask({ storage: s2, memory: m2 }));
    const f = mockFetch({ status, quote: () => jsonRes(201, nonDryFor("dry-arb-to-hc-25", { addr: DEP2 })) });
    const r = await D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: s2, memory: m2 }));
    assert.equal(f.calls.quote.length, 1, `${why}: a new address is quoted`);
    assert.equal(r.depositAddress, DEP2.toLowerCase(), why);
    assert.equal(r.fromCache, false, why);
  }
});

test("E3) the key is (user, route, plan, amount, privacy): another amount, plan or privacy level never gets this address", async () => {
  const st = fakeStorage();
  const memory = new Map();
  await D.getPrivateDepositAddress(ask({ storage: st, memory }));
  const asks = [
    ask({ amountRaw: "30000000", fetchImpl: mockFetch({ quote: (n, b) => jsonRes(201, nonDryFor("dry-arb-to-hc-25", { addr: DEP2, mutate: (j) => { j.quoteRequest.amount = b.amount; j.quote.amountIn = b.amount; j.quote.minAmountIn = b.amount; const out = BigInt(b.amount) * 100n - 31530000n; j.quote.amountOut = String(out); j.quote.minAmountOut = String((out * 99n) / 100n); } })) }) }),
    ask({ plan: D.PRIVATE_ARB_PLAN, fetchImpl: mockFetch({ quote: () => jsonRes(201, nonDryFor("dry-arb-to-arb-25", { addr: DEP2 })) }) }),
    ask({ confidentiality: "basic", fetchImpl: mockFetch({ quote: () => jsonRes(201, nonDryFor("dry-arb-to-hc-25", { addr: DEP2, mutate: (j) => { j.quoteRequest.confidentiality = "basic"; } })) }) }),
  ];
  const results = [];
  for (const a of asks) {
    const r = await D.getPrivateDepositAddress({ ...a, storage: st, memory });
    assert.equal(a.fetchImpl.calls.quote.length, 1);
    assert.equal(r.depositAddress, DEP2.toLowerCase());
    results.push(r);
  }
  assert.deepEqual(results.map((r) => r.private), [false, false, true], "a confidential answer, asked and echoed, is the one thing called private");
  /* The public address is still the public ask's (its own key, its own status check). */
  const again = await D.getPrivateDepositAddress({ ...ask(), storage: st, memory });
  assert.equal(again.depositAddress, DEP.toLowerCase());
  assert.equal(again.fromCache, true);
});

test("E4) a saved entry is ignored when tampered, foreign, past its show time, or not ours", async () => {
  const key = D.privateDepositCacheKey(USER, "arbitrum-usdc", "private-core", "25000000", "public");
  const good = {
    v: 1, provider: "near", user: USER.toLowerCase(), routeId: "arbitrum-usdc", planId: "private-core",
    originAsset: A.ARBITRUM_INTENTS_USDC.assetId, destinationAsset: A.HYPERCORE_USDC.assetId, amountRaw: "25000000",
    confidentiality: "public", depositAddress: DEP.toLowerCase(), expiresAt: NOW + 72 * HOUR, inactiveAt: NOW + 72 * HOUR,
    showUntil: NOW + 66 * HOUR, quotedAt: NOW - 1000,
  };
  const bad = [
    { ...good, user: OTHER.toLowerCase() },
    { ...good, depositAddress: USER.toLowerCase() },
    { ...good, depositAddress: "0x123" },
    { ...good, provider: undefined },
    { ...good, v: 2 },
    { ...good, destinationAsset: A.ARBITRUM_INTENTS_USDC.assetId },
    { ...good, amountRaw: "26000000" },
    { ...good, showUntil: NOW - 1 },
    { ...good, showUntil: NOW + 80 * HOUR },
    { ...good, quotedAt: NOW + 3600000 },
  ];
  for (const e of bad) {
    const f = mockFetch({ quote: () => jsonRes(201, nonDryFor("dry-arb-to-hc-25", { addr: DEP2 })) });
    const r = await D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: fakeStorage({ [key]: JSON.stringify(e) }), memory: new Map() }));
    assert.equal(r.depositAddress, DEP2.toLowerCase(), JSON.stringify(e).slice(0, 80));
    assert.equal(f.calls.status.length, 0, "an unusable entry is not even checked");
  }
  const f = mockFetch();
  const r = await D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: fakeStorage({ [key]: JSON.stringify(good) }), memory: new Map() }));
  assert.equal(r.fromCache, true, "the well-formed one is used (after its status check)");
});

test("E5) a route the live token list does not carry as we know it shows NO address, and forgets the saved one", async () => {
  const st = fakeStorage();
  const memory = new Map();
  await D.getPrivateDepositAddress(ask({ storage: st, memory }));
  const key = D.privateDepositCacheKey(USER, "arbitrum-usdc", "private-core", "25000000", "public");
  assert.ok(st.getItem(key));
  const f = mockFetch({ tokens: () => jsonRes(200, TOKENS.map((t) => (t.assetId === A.HYPERCORE_USDC.assetId ? { ...t, decimals: 6 } : t))) });
  await assert.rejects(D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: st, memory })), (e) => e.code === "route-unavailable");
  assert.equal(f.calls.quote.length, 0);
  assert.equal(f.calls.status.length, 0);
  assert.equal(st.getItem(key), null, "its saved address is forgotten");
  const down = mockFetch({ tokens: () => { throw new Error("offline"); } });
  await assert.rejects(D.getPrivateDepositAddress(ask({ fetchImpl: down })), (e) => e.code === "network", "an unreadable list shows no address either");
  assert.equal(down.calls.quote.length, 0);
});

test("E6) refusals come back as codes a screen can word, in words that name no provider", async () => {
  const cases = [
    [() => jsonRes(503, { error: "private_mode_off", enabled: false, message: "Private mode is off." }), "private-mode-off"],
    [() => jsonRes(451, { error: "sanctioned", message: G.SANCTIONED_MESSAGE }), "sanctioned"],
    [() => jsonRes(503, { error: "screen_unavailable", message: G.SCREEN_UNAVAILABLE_MESSAGE }), "screen-unavailable"],
    [() => jsonRes(422, { error: "over_day_cap", max: 1000 }), "over-day-cap"],
    [() => jsonRes(422, { error: "over_tx_cap", max: 500 }), "over-tx-cap"],
    [() => jsonRes(422, { error: "below_min", min: 10 }), "below-min"],
    [() => jsonRes(409, { error: "confidentiality_mismatch", confidentiality: "basic" }), "confidentiality-mismatch"],
    [() => jsonRes(429, { message: "Too many quotes. Wait a minute." }), "rate-limited"],
    [() => jsonRes(fixture("refused-confidential-401.json").status, fixture("refused-confidential-401.json").answer), "intents-error"],
    [() => jsonRes(400, fixture("refused-base-pair-unavailable.json").answer), "intents-error"],
    [() => jsonRes(400, { message: "NEAR Intents via 1Click (chaindefuser.com) on HyperCore refused it" }), "intents-error"],
    [() => { throw new Error("offline"); }, "network"],
    [() => jsonRes(201, "not json"), "bad-response"],
    [() => jsonRes(201, { hello: 1 }), "unsafe-quote"],
  ];
  for (const [quote, want] of cases) {
    const p = D.getPrivateDepositAddress(ask({ fetchImpl: mockFetch({ quote }) }));
    await assert.rejects(p, (e) => {
      assert.equal(e.code, want);
      assert.doesNotMatch(e.message, /\bNEAR\b|1click|chaindefuser|defuse|hyperliquid|hypercore/i, e.message);
      return true;
    });
  }
  const live = await D.getPrivateDepositAddress(ask({ fetchImpl: mockFetch({ quote: () => jsonRes(400, fixture("refused-base-pair-unavailable.json").answer) }) })).catch((e) => e);
  assert.equal(live.message, "Quoting for this pair is not available", "the service's own reason survives, made plain");
});

test("E7) an answer that does not check out: no address, nothing saved, and the next ask quotes again", async () => {
  const st = fakeStorage();
  const memory = new Map();
  const f = mockFetch({ quote: () => jsonRes(201, nonDryFor("dry-arb-to-hc-25", { mutate: (j) => { j.quoteRequest.recipient = OTHER; } })) });
  await assert.rejects(D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: st, memory })), (e) => e.code === "unsafe-quote");
  assert.equal(st._m.size, 0);
  assert.equal(memory.size, 0);
  assert.equal(D._privateDepositInflightSize(), 0);
});

test("E8) two asks at once share ONE quote (never two reserved addresses for one tap)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = mockFetch({ quote: async () => { await gate; return jsonRes(201, nonDryFor("dry-arb-to-hc-25")); } });
  const st = fakeStorage();
  const memory = new Map();
  const tokensMemo = CL.newIntentsTokensMemo();
  const a = D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: st, memory, tokensMemo }));
  const b = D.getPrivateDepositAddress(ask({ fetchImpl: f, storage: st, memory, tokensMemo }));
  await new Promise((r) => setImmediate(r));
  release();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(f.calls.quote.length, 1);
  assert.equal(x.depositAddress, y.depositAddress);
});

test("E9) a used address is forgotten on request (every saved copy of it for this wallet)", async () => {
  const st = fakeStorage();
  const memory = new Map();
  await D.getPrivateDepositAddress(ask({ storage: st, memory }));
  assert.equal(D.forgetPrivateDepositAddress({ user: USER, depositAddress: DEP, storage: st, memory }), 2, "the session copy and the saved one");
  assert.equal(st._m.size, 0);
  assert.equal(memory.size, 0);
  assert.equal(D.forgetPrivateDepositAddress({ user: USER, depositAddress: "nope", storage: st, memory }), 0);
});

test("E10) a price-only quote: dry body, same verifier, no address reserved, nothing saved", async () => {
  const f = mockFetch({ quote: () => jsonRes(201, quoteFor("dry-arb-to-hc-10", USER)) });
  const q = await D.quotePrivateDeposit({ ...ask({ fetchImpl: f }), amountRaw: "10000000" });
  assert.equal(f.calls.quote[0].body.dry, true);
  assert.equal(q.depositAddress, null);
  assert.equal(q.amountOut, 9.6847);
  assert.equal(q.feeUsdc, 0.3153);
  await assert.rejects(D.quotePrivateDeposit({ ...ask(), amountRaw: "9000000" }), (e) => e.code === "below-min");
});

/* ════════════════════════════════════════════════════════════════════════════
   F. STATUS → ROWS
   ════════════════════════════════════════════════════════════════════════════ */

const rowsOf = (st, o = {}) => S.normalizeIntentsStatus(statusOf(st, o), { user: USER, depositAddress: DEP });

test("F1) all seven statuses: waiting is no row, KNOWN/PROCESSING arriving, SUCCESS credited, REFUNDED, FAILED, and INCOMPLETE never credited", () => {
  assert.deepEqual(rowsOf("PENDING_DEPOSIT"), [], "nothing sent yet: 'Waiting for your deposit'");
  const want = { KNOWN_DEPOSIT_TX: "arriving", PROCESSING: "arriving", SUCCESS: "credited", REFUNDED: "refunded", FAILED: "failed", INCOMPLETE_DEPOSIT: "incomplete" };
  for (const [st, status] of Object.entries(want)) {
    const rows = rowsOf(st);
    assert.equal(rows.length, 1, st);
    assert.equal(rows[0].status, status, st);
    assert.equal(rows[0].intentsStatus, st);
    assert.equal(rows[0].provider, "near");
    assert.equal(rows[0].id, `near:${DEP.toLowerCase()}`, "one swap per address, one stable id");
  }
  assert.equal(rowsOf("SOMETHING_NEW")[0].status, "unknown", "an unmapped status is never credited");
  assert.notEqual(rowsOf("INCOMPLETE_DEPOSIT")[0].status, "credited");
});

test("F2) the figures are what really happened, at the assets' own decimals; unknown is null, never 0", () => {
  const arriving = rowsOf("KNOWN_DEPOSIT_TX", { swap: { depositedAmount: "25000000", depositedAmountFormatted: "25.0", originChainTxHashes: [{ hash: TX_IN, explorerUrl: "x" }] } })[0];
  assert.equal(arriving.amountIn, 25);
  assert.equal(arriving.symbolIn, "USDC");
  assert.equal(arriving.amountOut, null, "nothing has landed");
  assert.equal(arriving.inTxHash, TX_IN);
  assert.equal(arriving.inChainId, 42161);
  assert.equal(arriving.planId, "private-core");
  assert.equal(arriving.direction, "deposit");
  const done = rowsOf("SUCCESS", { swap: { depositedAmount: "25000000", amountIn: "25000000", amountOut: "2468470000", amountOutFormatted: "24.6847", destinationChainTxHashes: [{ hash: TX_OUT, explorerUrl: "y" }] } })[0];
  assert.equal(done.amountOut, 24.6847);
  assert.equal(done.symbolOut, "USDC");
  assert.equal(done.outTxHash, TX_OUT);
  const noFigures = rowsOf("PROCESSING")[0];
  assert.equal(noFigures.amountIn, null);
  assert.equal(noFigures.inTxHash, null);
  const refunded = rowsOf("REFUNDED", { swap: { depositedAmount: "24000000", refundedAmount: "23994700", refundReason: "PARTIAL_DEPOSIT" } })[0];
  assert.equal(refunded.refundedAmount, 23.9947);
  assert.equal(refunded.failReason, "PARTIAL_DEPOSIT");
  const incomplete = rowsOf("INCOMPLETE_DEPOSIT", { swap: { depositedAmount: "24000000" } })[0];
  assert.equal(incomplete.amountIn, 24);
  assert.equal(incomplete.refundAfter, NOW + 72 * HOUR, "'Less than quoted · refunded after {deadline}'");
  /* The row's time is its last change, not the quote's birth (an address can sit on screen for hours). */
  assert.equal(arriving.createdAt, NOW + 60000);
  assert.equal(rowsOf("PROCESSING", { mutate: (j) => { delete j.updatedAt; } })[0].createdAt, Date.parse(quoteFor("dry-arb-to-hc-25").timestamp));
  /* Every field a Relay row has, so every reader of the watch reads both the same. */
  const relayKeys = Object.keys(RD.normalizeRelayRequest({}));
  for (const k of relayKeys) assert.ok(k in arriving, k);
});

test("F3) 🔴 a row that is not this wallet's is unknown: another recipient, another refundTo, another address, a foreign asset", () => {
  assert.equal(S.normalizeIntentsStatus(statusOf("SUCCESS", { user: OTHER }), { user: USER, depositAddress: DEP })[0].status, "unknown");
  assert.equal(S.normalizeIntentsStatus(statusOf("SUCCESS", { mutate: (j) => { j.quoteResponse.quoteRequest.refundTo = OTHER; } }), { user: USER, depositAddress: DEP })[0].status, "unknown");
  assert.equal(S.normalizeIntentsStatus(statusOf("SUCCESS", { addr: DEP2 }), { user: USER, depositAddress: DEP })[0].status, "unknown");
  assert.equal(S.normalizeIntentsStatus(statusOf("SUCCESS", { mutate: (j) => { j.quoteResponse.quoteRequest.destinationAsset = "nep141:wrap.near"; } }), { user: USER, depositAddress: DEP })[0].status, "unknown");
  assert.equal(rowsOf("SUCCESS")[0].mismatch, false);
  /* A withdrawal's recipient is what the customer typed: held to `expect` instead. */
  const w = statusOf("SUCCESS", { mutate: (j) => { j.quoteResponse.quoteRequest.recipient = OTHER; } });
  assert.equal(S.normalizeIntentsStatus(w, { depositAddress: DEP, expect: { recipient: OTHER, refundTo: USER } })[0].status, "credited");
  assert.deepEqual(S.normalizeIntentsStatus(null), []);
});

test("F4) one look: a 404 is nothing yet; with the kill switch off, the proxy's 503 falls back ONCE to the public read", async () => {
  const f404 = mockFetch({ status: () => jsonRes(404, fixture("status-404-madeup.json").answer) });
  assert.deepEqual(await S.lookIntentsDeposit({ depositAddress: DEP, user: USER, fetchImpl: f404, statusUrl: UP_STATUS }), []);
  const seen = [];
  const f = async (url) => {
    seen.push(String(url));
    if (String(url).startsWith("/api/intents-status")) return jsonRes(503, { error: "private_mode_off" });
    return jsonRes(200, statusOf("PROCESSING"));
  };
  const rows = await S.lookIntentsDeposit({ depositAddress: DEP, user: USER, fetchImpl: f, statusUrl: "/api/intents-status", fallbackUrl: UP_STATUS });
  assert.equal(rows[0].status, "arriving");
  assert.deepEqual(seen, [`/api/intents-status?depositAddress=${DEP}`, `${UP_STATUS}?depositAddress=${DEP}`]);
  /* Any other refusal is an error the tracker backs off on. */
  await assert.rejects(S.lookIntentsDeposit({ depositAddress: DEP, fetchImpl: async () => jsonRes(429, {}), statusUrl: UP_STATUS }), (e) => e.status === 429);
  await assert.rejects(S.lookIntentsDeposit({ depositAddress: "nope", fetchImpl: f }), (e) => e.code === "bad-deposit-address");
});

/* ════════════════════════════════════════════════════════════════════════════
   G. THE TRACKER
   ════════════════════════════════════════════════════════════════════════════ */

function fakeTimers() {
  let t = NOW;
  let seq = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { fn, at: t + ms, ms }); return id; },
    clearTimeout: (id) => { q.delete(id); },
    now: () => t,
    pending: () => [...q.values()].map((x) => x.ms),
    async fire() {
      const next = [...q.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return false;
      q.delete(next[0]);
      t = next[1].at;
      next[1].fn();
      await new Promise((r) => setImmediate(r));
      return true;
    },
  };
}
const settle = () => new Promise((r) => setImmediate(r));

test("G1) trackDeposits' contract: looks at once, answers ok with rows, polls on the same schedule, backs off on 429, stops clean", async () => {
  const timers = fakeTimers();
  const answers = [() => jsonRes(200, statusOf("PENDING_DEPOSIT")), () => jsonRes(200, statusOf("PROCESSING")), () => jsonRes(429, {}), () => jsonRes(200, statusOf("SUCCESS"))];
  let n = 0;
  const f = async () => answers[Math.min(n++, answers.length - 1)]();
  const snaps = [];
  const t = S.trackIntentsDeposit({ depositAddress: DEP, user: USER, onUpdate: (s) => snaps.push(s), fetchImpl: f, timers, now: timers.now, isHidden: () => false, onVisibility: () => () => {}, statusUrl: UP_STATUS });
  assert.equal(typeof t.stop, "function");
  assert.equal(typeof t.refresh, "function");
  assert.equal(typeof t.snapshot, "function");
  await settle();
  assert.equal(snaps[0].state, "ok");
  assert.deepEqual(snaps[0].requests, [], "waiting");
  assert.deepEqual(timers.pending(), [RD.nextPollDelay({ idleRounds: 0 })]);
  await timers.fire();
  assert.equal(snaps[1].requests[0].status, "arriving");
  assert.deepEqual(timers.pending(), [RD.nextPollDelay({ inFlight: true })], "money on its way is looked at sooner");
  await timers.fire();
  assert.equal(snaps[2].state, "ok", "a failed look keeps the rows on screen");
  assert.equal(snaps[2].requests[0].status, "arriving");
  assert.ok(snaps[2].error);
  assert.ok(timers.pending()[0] >= RD.TRACK_RATE_LIMIT_MS, "429: at least a minute");
  await timers.fire();
  assert.equal(snaps[3].requests[0].status, "credited");
  t.stop();
  assert.deepEqual(timers.pending(), []);
  assert.throws(() => S.trackIntentsDeposit({ depositAddress: "nope" }), (e) => e.code === "bad-deposit-address");
});

test("G2) a hidden tab does no work at all", async () => {
  const timers = fakeTimers();
  let asked = 0;
  const t = S.trackIntentsDeposit({ depositAddress: DEP, fetchImpl: async () => { asked += 1; return jsonRes(200, statusOf("PENDING_DEPOSIT")); }, timers, now: timers.now, isHidden: () => true, onVisibility: () => () => {}, statusUrl: UP_STATUS });
  await settle();
  assert.equal(asked, 0);
  assert.deepEqual(timers.pending(), []);
  t.stop();
});

/* ════════════════════════════════════════════════════════════════════════════
   H. THE DEPOSIT WATCH
   ════════════════════════════════════════════════════════════════════════════ */

function fakeTracker() {
  const calls = [];
  const fn = ({ depositAddress, user, onUpdate }) => { calls.push({ depositAddress, user, onUpdate }); return { stop() {}, refresh() { return true; } }; };
  fn.calls = calls;
  return fn;
}

test("H1) a Private entry is watched by the Private tracker and a Normal one by Relay's, exactly as before", () => {
  const relay = fakeTracker();
  const near = fakeTracker();
  const watch = W.createDepositWatch({ storage: null, now: () => NOW, track: relay, trackers: { near } });
  watch.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  watch.show({ user: USER, address: DEP2, routeId: "base-usdc", planId: "direct" });
  assert.deepEqual(near.calls.map((c) => c.depositAddress), [DEP.toLowerCase()]);
  assert.deepEqual(relay.calls.map((c) => c.depositAddress), [DEP2.toLowerCase()]);
  const st = watch.getState();
  assert.deepEqual(st.entries.map((e) => [e.address, e.provider]).sort(), [[DEP.toLowerCase(), "near"], [DEP2.toLowerCase(), "relay"]].sort());
  /* A provider the watch does not know is not watched by anybody. */
  const h = watch.show({ user: USER, address: OTHER, provider: "mystery" });
  assert.equal(h.seq, 0);
  assert.equal(watch.getState().entries.length, 2);
  watch.stopAll();
  /* The app's own watch carries the real Private tracker. */
  assert.equal(W.DEPOSIT_TRACKERS.near, S.trackIntentsDeposit);
  assert.deepEqual([...W.DEPOSIT_PROVIDERS], ["relay", "near"]);
});

test("H2) the provider is saved and resumes after a reload; an entry saved before providers existed is Relay's; an unknown one is skipped", () => {
  const storage = fakeStorage();
  const near = fakeTracker();
  const relay = fakeTracker();
  const w1 = W.createDepositWatch({ storage, now: () => NOW, track: relay, trackers: { near } });
  w1.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-arb", provider: "near" });
  w1.show({ user: USER, address: DEP2, routeId: "base-usdc", planId: "direct" });
  const saved = JSON.parse(storage.getItem(W.watchKey(USER)));
  const byAddr = Object.fromEntries(saved.list.map((r) => [r.address, r]));
  assert.equal(byAddr[DEP.toLowerCase()].provider, "near");
  assert.equal("provider" in byAddr[DEP2.toLowerCase()], false, "a Relay entry is saved exactly as before");
  w1.stopAll();
  /* Reload: a fresh watch over the same storage, plus a hand-made legacy entry and one from the future. */
  saved.list.push({ address: OTHER.toLowerCase(), routeId: "base-usdc", planId: "direct", shownAt: NOW, until: NOW + 1000, baselined: true, acked: [], hold: false, provider: "mystery" });
  storage.setItem(W.watchKey(USER), JSON.stringify(saved));
  const near2 = fakeTracker();
  const relay2 = fakeTracker();
  const w2 = W.createDepositWatch({ storage, now: () => NOW + 1, track: relay2, trackers: { near: near2 } });
  w2.focus(USER);
  assert.deepEqual(near2.calls.map((c) => c.depositAddress), [DEP.toLowerCase()]);
  assert.deepEqual(relay2.calls.map((c) => c.depositAddress), [DEP2.toLowerCase()]);
  assert.equal(w2.getState().entries.find((e) => e.address === DEP.toLowerCase()).planId, "private-arb");
  assert.equal(w2.getState().entries.some((e) => e.address === OTHER.toLowerCase()), false);
  w2.stopAll();
});

test("H3) a private-arb landing is money in the customer's own wallet (Recover's look is stale); a private-core landing is not", () => {
  for (const [planId, bumps] of [["private-arb", 1], ["private-core", 0]]) {
    const near = fakeTracker();
    const watch = W.createDepositWatch({ storage: null, now: () => NOW, trackers: { near } });
    const user = planId === "private-arb" ? "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" : "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    watch.show({ user, address: DEP, routeId: "arbitrum-usdc", planId, provider: "near" });
    const say = (st) => near.calls[0].onUpdate({ state: "ok", requests: S.normalizeIntentsStatus(statusOf(st, { user }), { user, depositAddress: DEP }), checkedAt: NOW, error: null });
    say("PROCESSING");
    const before = WF.walletFundsSeq(user);
    const sig0 = W.landingSig(watch.getState(), user);
    say("SUCCESS");
    assert.equal(WF.walletFundsSeq(user) - before, bumps, planId);
    assert.notEqual(W.landingSig(watch.getState(), user), sig0, `${planId}: a landing changes the mover's signature`);
    watch.stopAll();
  }
});

test("H4) 🔴 an INCOMPLETE deposit is said (never as money, never as a landing) until it is closed; closing it never silences the refund", () => {
  const near = fakeTracker();
  const watch = W.createDepositWatch({ storage: null, now: () => NOW, trackers: { near } });
  const h = watch.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  h.release();
  near.calls[0].onUpdate({ state: "ok", requests: rowsOf("INCOMPLETE_DEPOSIT"), checkedAt: NOW, error: null });
  const st = watch.getState();
  /* The strip says it (the money is waiting for a refund, not lost and not credited) … */
  const said = W.pickDepositStatus(st, USER);
  assert.equal(said.row.status, "incomplete");
  assert.equal(said.provider, "near");
  /* … it is never a landing … */
  assert.equal(W.landingSig(st, USER), "");
  /* … and closing it is acknowledged under its own name, so it is not said again. */
  watch.dismiss(said.address, PV.incompleteAckId(said.row.id));
  assert.equal(W.pickDepositStatus(watch.getState(), USER), null);
  near.calls[0].onUpdate({ state: "ok", requests: rowsOf("REFUNDED"), checkedAt: NOW, error: null });
  const pick = W.pickDepositStatus(watch.getState(), USER);
  assert.equal(pick.row.status, "refunded", "the refund after it is still news");
  assert.equal(pick.provider, "near");
  assert.equal(pick.routeId, "arbitrum-usdc");
  watch.stopAll();
});

/* ════════════════════════════════════════════════════════════════════════════
   I. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

const INTENTS_FILES = ["config", "assets", "client", "status", "deposit", "guard"].map((n) => `src/lib/intents/${n}.js`);

test("I1) 🔴 the silent-signing allow-list does not grow: nothing that signs silently imports this folder", async () => {
  for (const f of ["src/components/privy/PrivyBridge.jsx", "src/services/privy.js", "src/lib/hyperliquid/exchange/master.js", "src/perp/deposit/perpFunding.js", "src/lib/relay/arbitrumBridge.js"]) {
    assert.doesNotMatch(code(f), /lib\/intents|intents\//, f);
  }
  const M = await import("../src/lib/hyperliquid/exchange/master.js");
  assert.deepEqual([...M.HL_SILENT_MASTER_ACTIONS], ["approveAgent", "approveBuilderFee"]);
});

test("I2) nothing in this folder signs, sends a transaction, or reads a browser env key", () => {
  for (const f of INTENTS_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /signTypedData|sendTransaction|personal_sign|eth_sendRawTransaction|eth_sign\b|privateKey|mnemonic/, f);
    assert.doesNotMatch(c, /import\.meta\.env|VITE_/, f);
  }
  /* The partner key's name appears only in the server's guard. */
  for (const f of INTENTS_FILES.filter((x) => !x.endsWith("guard.js"))) assert.doesNotMatch(code(f), /NEAR_INTENTS_JWT|process\.env/, f);
  for (const f of ["api/intents-quote.js", "api/intents-status.js"]) assert.doesNotMatch(code(f), /VITE_/, f);
});

test("I3) honest words only (plan §4): none of the banned claims in this folder's strings", () => {
  for (const f of [...INTENTS_FILES, "api/intents-quote.js", "api/intents-status.js"]) {
    assert.doesNotMatch(code(f), /anonymous|untraceable|no KYC|invisible|hide from|\bmixer\b|tumbler|launder|can'?t be tracked|\bVPN\b|\bZK\b|zero-knowledge/i, f);
  }
});

test("I4) Normal mode's files are untouched by this folder (it only reads them)", () => {
  for (const f of ["src/lib/relay/depositAddress.js", "src/lib/relay/firstDeposit.js", "src/lib/relay/routes.js", "src/lib/relay/arbitrumBridge.js"]) {
    assert.doesNotMatch(code(f), /lib\/intents|\.\/intents|PROVIDER_NEAR|private-core|private-arb/, f);
  }
});
