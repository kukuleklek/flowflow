/**
 * test-intents-withdraw — the PRIVATE withdrawal's backend (Normal | Private toggle).
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "Start Now ทำ Backend ก่อน".
 *
 * 🔴 MONEY SAFETY. Nothing here signs, holds a key, or posts anywhere. Every
 * fetch is a fake that records what it was asked; the wallet step is a recorder.
 * The fixtures are LIVE, READ-ONLY captures (scripts/fixtures/intents/
 * withdraw-live-2026-10-15.json): dry:true quotes 20 USDC out of HyperCore to
 * Arbitrum, Base and Solana (this task; Base answered "Quoting for this pair is
 * not available" for a few minutes at 07:14 UTC, that refusal is kept too),
 * the research capture of HyperCore -> Base (06:39 UTC),
 * the SHAPE of a real quote (the one dry:false research capture), Hyperliquid
 * info answers, sanctions-oracle answers, and a status 404.
 *
 * Run: node --test scripts/test-intents-withdraw.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const W = await imp("src/lib/intents/withdraw.js");
const S = await imp("src/lib/hyperliquid/exchange/intentsOut.js");
const J = await imp("src/lib/intents/withdrawJournal.js");
const T = await imp("src/lib/intents/withdrawStatus.js");
const O = await imp("src/lib/intents/sanctionsOracle.js");
const Q = await imp("api/intents-quote.js");
const G = await imp("src/lib/intents/guard.js");
const A = await imp("src/lib/intents/assets.js");
const C = await imp("src/lib/intents/config.js");
const M = await imp("src/lib/hyperliquid/exchange/master.js");
const R = await imp("src/lib/hyperliquid/exchange/relayOut.js");
const SG = await imp("src/lib/hyperliquid/exchange/signing.js");
const N = await imp("src/lib/hyperliquid/exchange/network.js");
const SW = await imp("src/services/signWords.js");

const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/intents/withdraw-live-2026-10-15.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const route = (id) => W.privateWithdrawRouteById(id);
const PROFILE = N.hlNetworkProfile("mainnet");

/* The real-quote capture (research, dry:false, random addresses). */
const REAL = FIX.real.response;
const REAL_AT = Date.parse(FIX.real.capturedAt);
const REAL_USER = REAL.quoteRequest.refundTo;
const REAL_TO = REAL.quoteRequest.recipient;
const REAL_DEPOSIT = REAL.quote.depositAddress;
const realCtx = (over = {}) => ({
  user: REAL_USER, recipient: REAL_TO, route: route("arbitrum-usdc"), amountUsdc: "20", dry: false,
  deadline: REAL.quoteRequest.deadline, now: REAL_AT, ...over,
});
const realQuote = (mutate = null, ctx = {}) => {
  const j = clone(REAL);
  if (mutate) mutate(j);
  return W.parseIntentsWithdrawQuote(j, realCtx(ctx));
};

/* Dry captures. */
const dryCtx = (id, over = {}) => {
  const c = FIX.dry[id];
  return {
    user: c.user, recipient: c.recipient, route: route(id.replace(/-research$/, "")), amountUsdc: "20", dry: true,
    deadline: c.response.quoteRequest.deadline, now: Date.parse(c.response.timestamp), ...over,
  };
};
const dryQuote = (id, mutate = null, over = {}) => {
  const j = clone(FIX.dry[id].response);
  if (mutate) mutate(j);
  return W.parseIntentsWithdrawQuote(j, dryCtx(id, over));
};

const refusesWith = (fn, re) => assert.throws(fn, (e) => e && e.code === "unsafe-quote" && re.test(e.message));

/* A Storage-shaped fake (getItem/setItem/removeItem/key/length). */
function memStorage({ dropWrites = false, throwOnSet = false } = {}) {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (throwOnSet) throw new Error("quota"); if (!dropWrites) m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

/* A preflight answered by fake Hyperliquid info. */
const LIVE_PTC = FIX.hl.ptcFresh.response; // {"isSanctioned":false,"userExists":false,"fee":"1.0",...}
function fakeInfo({ ptc = LIVE_PTC, role = { role: "missing" }, chs = { withdrawable: "100.0" }, fail = {} } = {}) {
  const calls = [];
  const fn = async (body) => {
    calls.push(body);
    if (fail[body.type]) throw new Error("down");
    if (body.type === "preTransferCheck") return ptc;
    if (body.type === "userRole") return role;
    if (body.type === "clearinghouseState") return chs;
    if (body.type === "userNonFundingLedgerUpdates") return fail.ledgerRows || [];
    throw new Error(`unexpected ${body.type}`);
  };
  fn.calls = calls;
  return fn;
}
const preflightFor = (quote, o = {}) => W.readWithdrawPreflight({ quote, info: fakeInfo(o), now: () => quote.quotedAt + 1000, ...(o.withdrawableUsdc !== undefined ? { withdrawableUsdc: o.withdrawableUsdc } : {}) });

beforeEach(() => { W.clearScreenMemo(); SW.disarmSignWords(); });

/* ── W1 the table matches the service's token list ─────────────────────────── */

test("W1) every route and the origin are listed by GET /v0/tokens with the same contract and decimals; a drift is caught", () => {
  assert.deepEqual(W.withdrawRouteTokenProblems(FIX.tokens), []);
  const t = clone(FIX.tokens);
  t.find((x) => x.assetId === route("arbitrum-usdc").assetId).decimals = 18;
  assert.match(W.withdrawRouteTokenProblems(t).join("\n"), /arbitrum-usdc: decimals are 18/);
  assert.match(W.withdrawRouteTokenProblems(FIX.tokens.filter((x) => x.blockchain !== "hypercore")).join("\n"), /origin/);
  assert.equal(W.HL_INTENTS_USDC.decimals, 8);
  assert.equal(W.HL_USDC_SEND_TOKEN, R.HL_USDC_TOKEN.mainnet, "the sendAsset token mirrors the signing layer's own constant");
  assert.equal(route("solana-usdc").enabled, false, "Solana is priced, not offered, until its recipient can be screened");
  /* The owner's four chains (2026-10-15), in his chain order; Solana stays off. */
  assert.deepEqual(W.PRIVATE_WITHDRAW_ROUTES.map((r) => r.id), ["base-usdc", "avalanche-usdc", "arbitrum-usdc", "polygon-usdc", "solana-usdc"]);
  assert.deepEqual(W.PRIVATE_WITHDRAW_ROUTES.filter((r) => r.enabled).map((r) => r.chainId), [8453, 43114, 42161, 137]);
  assert.equal(route("avalanche-usdc").assetId, A.AVALANCHE_INTENTS_USDC.assetId);
  assert.equal(route("polygon-usdc").assetId, A.POLYGON_INTENTS_USDC.assetId);
  /* One table of assets for the whole Private route: the withdraw rows ARE the shared assets, and each enabled
     row is a withdraw pair the shared proxy forwards; Solana is not one. */
  assert.equal(W.HL_INTENTS_USDC, A.HYPERCORE_USDC);
  assert.equal(route("base-usdc").assetId, A.BASE_INTENTS_USDC.assetId);
  assert.equal(route("arbitrum-usdc").assetId, A.ARBITRUM_INTENTS_USDC.assetId);
  for (const r of W.PRIVATE_WITHDRAW_ROUTES) {
    const pair = A.intentsPairOf(A.HYPERCORE_USDC.assetId, r.assetId);
    assert.equal(!!(pair && pair.direction === "withdraw"), r.enabled, r.id);
  }
  assert.equal(W.PRIVATE_WITHDRAW_MIN_USDC, C.PRIVATE_LIMITS.withdrawMinUsdc);
  assert.equal(W.PRIVATE_WITHDRAW_MAX_USDC, C.PRIVATE_LIMITS.maxTxUsdc);
  assert.equal(W.PRIVATE_WITHDRAW_DAY_CAP_USDC, C.PRIVATE_LIMITS.maxDayUsdc);
});

/* ── W2 the body ───────────────────────────────────────────────────────────── */

test("W2) the body: exactly the 13 keys, refundTo = the user, recipient exactly as typed, 8-decimal amount, the probe's privacy level, no fee/memo keys", () => {
  const user = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const to = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const now = Date.parse("2026-10-15T07:00:00.250Z");
  const b = W.buildIntentsWithdrawBody({ user, recipient: to, route: route("arbitrum-usdc"), amountUsdc: "20.5", dry: true, now });
  assert.deepEqual(Object.keys(b).sort(), ["amount", "confidentiality", "deadline", "depositType", "destinationAsset", "dry", "originAsset", "recipient", "recipientType", "refundTo", "refundType", "slippageTolerance", "swapType"]);
  assert.equal(b.confidentiality, "public", "default: the keyless level, which is NOT private");
  assert.equal(W.buildIntentsWithdrawBody({ user, recipient: to, route: route("arbitrum-usdc"), amountUsdc: "20", dry: true, now, confidentiality: "basic" }).confidentiality, "basic");
  assert.equal(b.refundTo, user.toLowerCase());
  assert.equal(b.recipient, to, "never re-cased");
  assert.equal(b.amount, "2050000000");
  assert.equal(b.originAsset, W.HL_INTENTS_USDC.assetId);
  assert.equal(b.destinationAsset, route("arbitrum-usdc").assetId);
  assert.equal(b.swapType, "EXACT_INPUT");
  assert.equal(b.slippageTolerance, 100);
  assert.equal(b.deadline, "2026-10-15T08:00:00.000Z", "one hour, second precision");
  for (const bad of [
    () => W.buildIntentsWithdrawBody({ user, recipient: to, route: { ...route("arbitrum-usdc") }, amountUsdc: "20", dry: true, now }),
    () => W.buildIntentsWithdrawBody({ user, recipient: to.toLowerCase().replace("7099", "7O99"), route: route("arbitrum-usdc"), amountUsdc: "20", dry: true, now }),
    () => W.buildIntentsWithdrawBody({ user, recipient: ` ${to}`, route: route("arbitrum-usdc"), amountUsdc: "20", dry: true, now }),
    () => W.buildIntentsWithdrawBody({ user, recipient: to, route: route("arbitrum-usdc"), amountUsdc: "1.0000001", dry: true, now }),
    () => W.buildIntentsWithdrawBody({ user: "0x0000000000000000000000000000000000000000", recipient: to, route: route("arbitrum-usdc"), amountUsdc: "20", dry: true, now }),
    () => W.buildIntentsWithdrawBody({ user, recipient: to, route: route("arbitrum-usdc"), amountUsdc: "20", dry: "yes", now }),
    () => W.buildIntentsWithdrawBody({ user, recipient: to, route: route("arbitrum-usdc"), amountUsdc: "20", dry: true, now, confidentiality: "secret" }),
    () => W.buildIntentsWithdrawBody({ user, recipient: to, route: route("arbitrum-usdc"), amountUsdc: "20", dry: true, now, slippageBps: 301 }),
  ]) assert.throws(bad, W.IntentsWithdrawError);
});

/* ── W3 the address the customer types ─────────────────────────────────────── */

test("W3) destinations: EIP-55 checked and never re-cased; zero/dead refused; Solana base58 32 bytes; program ids refused; own flagged", () => {
  const evm = route("base-usdc");
  const good = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  assert.equal(W.validatePrivateDestination(good, evm).ok, true);
  assert.equal(W.validatePrivateDestination(good, evm).checksum, true);
  assert.equal(W.validatePrivateDestination(good.toLowerCase(), evm).ok, true);
  assert.equal(W.validatePrivateDestination(good.replace("C51", "c51"), evm).ok, false, "a one-letter case typo fails EIP-55");
  assert.equal(W.validatePrivateDestination("0x0000000000000000000000000000000000000000", evm).ok, false);
  assert.equal(W.validatePrivateDestination("0x000000000000000000000000000000000000dEaD", evm).ok, false);
  assert.equal(W.validatePrivateDestination(FIX.dry["solana-usdc"].recipient, evm).ok, false);
  assert.equal(W.validatePrivateDestination("", evm).empty, true);
  assert.equal(W.validatePrivateDestination(good, evm, { own: good.toLowerCase() }).isOwn, true);
  const sol = route("solana-usdc");
  assert.equal(W.validatePrivateDestination(FIX.dry["solana-usdc"].recipient, sol).ok, true);
  assert.equal(W.validatePrivateDestination(good, sol).ok, false);
  assert.equal(W.validatePrivateDestination("11111111111111111111111111111111", sol).ok, false, "the all-zero key burns money");
  assert.equal(W.validatePrivateDestination("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", sol).ok, false, "USDC's mint is not a wallet");
  assert.equal(W.validatePrivateDestination("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", sol).ok, false);
  assert.equal(W.validatePrivateDestination("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4", sol).ok, false, "a key one character short is not 32 bytes");
  assert.equal(W.validatePrivateDestination("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4O", sol).ok, false, "O is not base58");
  assert.equal(W.sameRecipient(sol, "AbC", "abc"), false, "Solana addresses are compared exactly");
});

/* ── W4 the live dry quotes verify ─────────────────────────────────────────── */

test("W4) the live dry quotes (Arbitrum, Solana; Base from research) verify, with the figures in exact units", () => {
  const arb = dryQuote("arbitrum-usdc");
  assert.equal(arb.dry, true);
  assert.equal(arb.depositAddress, null);
  assert.equal(arb.amountRaw, "2000000000");
  assert.equal(arb.hlAmount, "20");
  assert.equal(arb.receive, "19.7947");
  assert.equal(arb.minReceive, "19.596753");
  assert.equal(arb.serviceFeeUsdc, "0.2053");
  assert.equal(arb.refundFeeUsdc, "0.3153");
  assert.equal(arb.withdrawFee, "0.0053");
  assert.equal(arb.platformFeeBps, 0);
  assert.equal(arb.confidentiality, "public");
  assert.equal(arb.private, false, "keyless is NOT private, and the reading says so");
  assert.equal(arb.signatureVerified, false);
  assert.equal(W.isVerifiedWithdrawQuote(arb), true);
  assert.equal(W.isVerifiedWithdrawQuote({ ...arb }), false, "a copy is not a verified quote");

  const sol = dryQuote("solana-usdc");
  assert.equal(sol.platformFeeBps, 1, "the keyless service's own 1 bp fee is accepted and reported");
  assert.equal(Number(sol.receive) > 19 && Number(sol.receive) < 19.8, true);

  const base = dryQuote("base-usdc");
  assert.equal(Number(base.receive) > 19.7 && Number(base.receive) < 19.8, true);
  assert.equal(base.platformFeeBps, 1, "Base carries the service's own 1 bp, to its own account");
  /* The research capture of the same pair (06:39 UTC, a lower-case recipient, no request deadline of ours). */
  const old = W.parseIntentsWithdrawQuote(clone(FIX.dry["base-usdc-research"].response), { ...dryCtx("base-usdc-research"), route: route("base-usdc"), deadline: null });
  assert.equal(old.receive, "19.795174");
});

/* ── W5 every tamper of the echo or the quote is refused ───────────────────── */

test("W5) the verifier refuses every field of the echo and the quote that is not what was asked", () => {
  const T5 = [
    [(j) => { j.quoteRequest.recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; }, /recipient/],
    [(j) => { j.quoteRequest.refundTo = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; }, /refund would not come back/],
    [(j) => { j.quoteRequest.originAsset = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"; }, /Perp USDC/],
    [(j) => { j.quoteRequest.destinationAsset = route("base-usdc").assetId; }, /destination token/],
    [(j) => { j.quoteRequest.amount = "2000000100"; }, /amount/],
    [(j) => { j.quoteRequest.swapType = "FLEX_INPUT"; }, /exact-input/],
    [(j) => { j.quoteRequest.slippageTolerance = 500; }, /slippage/],
    [(j) => { j.quoteRequest.depositType = "INTENTS"; }, /origin chain/],
    [(j) => { j.quoteRequest.refundType = "INTENTS"; }, /origin chain/],
    [(j) => { j.quoteRequest.recipientType = "INTENTS"; }, /destination chain/],
    [(j) => { j.quoteRequest.deadline = "2026-10-15T09:00:00.000Z"; }, /refund time/],
    [(j) => { j.quoteRequest.dry = false; }, /real one/],
    [(j) => { j.quoteRequest.customRecipientMsg = "hi"; }, /customRecipientMsg/],
    [(j) => { j.quoteRequest.virtualChainRecipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; }, /virtualChainRecipient/],
    [(j) => { j.quoteRequest.referral = "someone"; }, /referral/],
    [(j) => { j.quoteRequest.confidentiality = "secret"; }, /privacy mode/],
    [(j) => { j.quoteRequest.appFees = [{ recipient: C.INTENTS_PLATFORM_FEE_ACCOUNTS[0], fee: 26 }]; }, /fee is higher/],
    [(j) => { j.quoteRequest.appFees = [{ recipient: "fee.near", fee: 1 }]; }, /somebody this app does not know/],
    [(j) => { j.quoteRequest.appFees = [{ recipient: FIX.dry["arbitrum-usdc"].user, fee: 1 }]; }, /somebody this app does not know/],
    [(j) => { j.quoteRequest.appFees = { recipient: "x" }; }, /fee list/],
    [(j) => { j.quote.amountIn = "1999999900"; }, /amount leaving/],
    [(j) => { j.quote.minAmountIn = "1"; }, /minimum deposit/],
    [(j) => { j.quote.minAmountOut = "19794701"; }, /minimum that arrives/],
    [(j) => { j.quote.minAmountOut = "0"; }, /minimum that arrives/],
    [(j) => { j.quote.amountOut = "2000000001"; j.quote.minAmountOut = "1"; }, /units are wrong/],
    [(j) => { j.quote.minAmountOut = "15000000"; }, /take too much/],
    [(j) => { j.quote.refundFee = "2000000000"; }, /return nothing/],
    [(j) => { j.quote.refundFee = "-1"; }, /refund fee/],
    [(j) => { j.quote.amountOut = 19794700; }, /cannot be read/],
    [(j) => { j.quote.depositAddress = "0xD991E062BFac9d04C0bC667f7071d3697C752E0E"; }, /priced-only quote came with an address/],
    [(j) => { delete j.quoteRequest; }, /does not say/],
  ];
  for (const [mutate, re] of T5) refusesWith(() => dryQuote("arbitrum-usdc", mutate), re);
  refusesWith(() => dryQuote("arbitrum-usdc", null, { expectConfidentiality: "basic" }), /privacy mode is not the one/);
  refusesWith(() => W.parseIntentsWithdrawQuote(null, dryCtx("arbitrum-usdc")), /not a quote/);
  /* The Solana echo is compared EXACTLY (base58 is case-sensitive). */
  refusesWith(() => dryQuote("solana-usdc", (j) => { j.quoteRequest.recipient = j.quoteRequest.recipient.toLowerCase(); }), /recipient/);
});

/* ── W6 a real quote: the deposit address ──────────────────────────────────── */

test("W6) a real quote verifies only with a plain HyperCore deposit address that is alive long enough", () => {
  const q = realQuote();
  assert.equal(q.dry, false);
  assert.equal(q.depositAddress, REAL_DEPOSIT);
  assert.equal(q.deadlineAt, Date.parse("2026-10-18T07:45:10.000Z"), "the address lives 72 h although 1 h was asked");
  assert.equal(q.refundStartsAt, Date.parse("2026-10-15T07:45:10.000Z"));
  assert.equal(W.withdrawQuoteFresh(q, REAL_AT + 1000), true);
  assert.equal(W.withdrawQuoteFresh(q, REAL_AT + W.WITHDRAW_QUOTE_TTL_MS), false, "60 s and it is quoted again");
  const T6 = [
    [(j) => { j.quote.depositAddress = REAL_USER; }, /your own account/],
    [(j) => { j.quote.depositAddress = REAL_TO; }, /is the recipient/],
    [(j) => { j.quote.depositAddress = "0x0000000000000000000000000000000000000000"; }, /not a HyperCore account/],
    [(j) => { j.quote.depositAddress = "0x000000000000000000000000000000000000dEaD"; }, /burn address/],
    [(j) => { j.quote.depositAddress = "So1anaAddre55So1anaAddre55So1anaAddre55So1"; }, /not a HyperCore account/],
    [(j) => { j.quote.depositAddress = REAL_DEPOSIT.replace("BFac", "BFAc"); }, /checksum/],
    [(j) => { delete j.quote.depositAddress; }, /not a HyperCore account/],
    [(j) => { j.quote.depositMemo = "123"; }, /depositMemo/],
    [(j) => { j.quote.chainDepositAddresses = [{ blockchain: "arb", address: "0x1" }]; }, /chainDepositAddresses/],
    [(j) => { j.quote.deadline = new Date(REAL_AT + 10 * 60_000).toISOString(); }, /expires too soon/],
    [(j) => { delete j.quote.deadline; }, /no readable deadline/],
    [(j) => { j.quote.timeWhenInactive = new Date(REAL_AT + 60_000).toISOString(); }, /goes cold too soon/],
    [(j) => { j.quoteRequest.dry = true; }, /priced-only/],
  ];
  for (const [mutate, re] of T6) refusesWith(() => realQuote(mutate), re);
});

/* ── W7 amounts are exact ──────────────────────────────────────────────────── */

test("W7) amounts: BigInt both ways; 8 -> 6 decimals exactly; a digit below the 6th is refused, never rounded", () => {
  assert.deepEqual(W.parsePrivateWithdrawAmount("500"), { ok: true, units: "50000000000", hl: "500", usdc: 500 });
  assert.equal(W.parsePrivateWithdrawAmount("0.000001").units, "100");
  assert.equal(W.parsePrivateWithdrawAmount("0.0000001").ok, false);
  assert.equal(W.parsePrivateWithdrawAmount("1e3").ok, false);
  assert.equal(W.parsePrivateWithdrawAmount("-5").ok, false);
  assert.equal(W.parsePrivateWithdrawAmount(0.1 + 0.2).units, "30000000", "a float is read at 8 decimals");
  assert.equal(W.hlAmountFromUnits("2000000000"), "20");
  assert.equal(W.hlAmountFromUnits("2000000100"), "20.000001");
  assert.equal(W.hlAmountFromUnits("2000000001"), null, "sub-micro: refused");
  assert.equal(W.hlAmountFromUnits("0"), null);
  assert.equal(W.unitsToDecimal("123456789012345678901234567890", 8), "1234567890123456789012.3456789");
  assert.equal(M.formatUsdcAmount(W.hlAmountFromUnits("2000000100")), "20.000001", "the signing layer's formatter agrees");
});

/* ── W8 screening ──────────────────────────────────────────────────────────── */

test("W8) the oracle answer: exactly one word of 0/1, and \"0x\" (no contract) is UNKNOWN, never clear", () => {
  assert.equal(O.readOracleAnswer(FIX.oracleRaw.listed), true);
  assert.equal(O.readOracleAnswer(FIX.oracleRaw.clear), false);
  assert.equal(O.readOracleAnswer(FIX.oracleRaw.noContractOnBase), null);
  assert.equal(O.readOracleAnswer(`0x${"0".repeat(63)}2`), null);
  assert.equal(O.readOracleAnswer(undefined), null);
  assert.equal(O.isSanctionedCallData("0x7F367cC41522cE07553e823bf3be79A889DEbe1B"), `0xdf592f7d${"0".repeat(24)}7f367cc41522ce07553e823bf3be79a889debe1b`);
  assert.throws(() => O.isSanctionedCallData("not"));
  /* Live, read-only: the Lazarus address is listed on both chains, a fresh one is not. */
  assert.equal(FIX.oracle["0x7F367cC41522cE07553e823bf3be79A889DEbe1B"].sanctioned, true);
  assert.equal(Object.values(FIX.oracle).filter((r) => r.sanctioned === false).length, 1);
});

test("W8b) oracleSanctioned: any yes wins; one readable no is clear; nothing readable is null; non-EVM is null", async () => {
  const rpc = (answers) => {
    const f = async (url, init) => {
      const a = answers[url];
      if (a instanceof Error) throw a;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: a }) };
    };
    return f;
  };
  const [arb, eth] = O.SANCTIONS_RPCS.map((r) => r.url);
  const a = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  assert.equal((await O.oracleSanctioned(a, { fetchImpl: rpc({ [arb]: FIX.oracleRaw.clear, [eth]: FIX.oracleRaw.listed }) })).sanctioned, true);
  assert.equal((await O.oracleSanctioned(a, { fetchImpl: rpc({ [arb]: FIX.oracleRaw.clear, [eth]: new Error("down") }) })).sanctioned, false);
  assert.equal((await O.oracleSanctioned(a, { fetchImpl: rpc({ [arb]: "0x", [eth]: "0x" }) })).sanctioned, null);
  assert.equal((await O.oracleSanctioned(a, { fetchImpl: rpc({ [arb]: new Error("x"), [eth]: new Error("y") }) })).sanctioned, null);
  assert.equal((await O.oracleSanctioned("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T")).why, "not-evm");
});

test("W8c) screenWithdrawAddresses: oracle REQUIRED (unknown refuses), Hyperliquid's isSanctioned ADDITIVE, non-EVM needs its own screen", async () => {
  const user = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const to = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const oracle = (map) => async (addr) => ({ sanctioned: addr.toLowerCase() in map ? map[addr.toLowerCase()] : false });
  const info = (flag) => async (b) => ({ ...LIVE_PTC, isSanctioned: flag(b.user) });
  const go = (o) => { W.clearScreenMemo(); return W.screenWithdrawAddresses({ user, recipient: to, route: route("arbitrum-usdc"), oracle: oracle({}), info: info(() => false), now: () => 0, ...o }); };
  assert.equal((await go({})).ok, true);
  assert.equal((await go({ oracle: oracle({ [to.toLowerCase()]: true }) })).code, "sanctioned");
  assert.equal((await go({ oracle: oracle({ [user.toLowerCase()]: true }) })).code, "sanctioned", "the sender is screened too");
  assert.equal((await go({ info: info((a) => a === to) })).code, "sanctioned", "Hyperliquid's yes refuses even when the oracle says no");
  assert.equal((await go({ oracle: oracle({ [to.toLowerCase()]: null }) })).code, "screen-unavailable");
  assert.equal((await go({ oracle: async () => { throw new Error("down"); } })).code, "screen-unavailable");
  assert.equal((await go({ info: async () => { throw new Error("down"); } })).ok, true, "an unreadable HL answer is ignored; the oracle is the required one");
  const sol = route("solana-usdc");
  const solTo = FIX.dry["solana-usdc"].recipient;
  assert.equal((await go({ route: sol, recipient: solTo })).code, "screen-unavailable", "no Solana screen = unknown = refused");
  assert.equal((await go({ route: sol, recipient: solTo, screenOther: async () => false })).ok, true);
  assert.equal((await go({ route: sol, recipient: solTo, screenOther: async () => true })).code, "sanctioned");
  assert.match((await go({ oracle: oracle({ [to.toLowerCase()]: true }) })).message, /can't be used.*sanctions/);
});

/* ── W9 quoting end to end (fake service) ──────────────────────────────────── */

function fakeService(answer, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const a = typeof answer === "function" ? answer(JSON.parse(init.body)) : answer;
    return { ok: status >= 200 && status < 300, status, json: async () => a };
  };
  fn.calls = calls;
  return fn;
}
const okScreen = async () => ({ ok: true, code: null, message: null, results: [] });

test("W9) quoteIntentsWithdraw: limits and route refused before any request; screened before the quote; the answer verified", async () => {
  const c = FIX.dry["arbitrum-usdc"];
  const at = Date.parse(c.response.timestamp);
  /* Echo the live answer, with the deadline our builder asked for. */
  const svc = fakeService((b) => { const j = clone(c.response); j.quoteRequest.deadline = b.deadline; return j; });
  /* A level the page asked for that the echo does not carry is refused (the shared proxy forces it; the service echoes it). */
  const echoPublic = fakeService((b) => { const j = clone(c.response); j.quoteRequest.deadline = b.deadline; return j; });
  await assert.rejects(W.quoteIntentsWithdraw({ user: c.user, recipient: c.recipient, route: route("arbitrum-usdc"), amountUsdc: "20", screen: okScreen, fetchImpl: echoPublic, now: () => at, quoteUrl: "https://x/quote", confidentiality: "basic" }), (e) => e.code === "unsafe-quote" && /privacy mode/.test(e.message));
  const base = { user: c.user, recipient: c.recipient, route: route("arbitrum-usdc"), amountUsdc: "20", screen: okScreen, fetchImpl: svc, now: () => at, quoteUrl: "https://x/quote" };
  const q = await W.quoteIntentsWithdraw(base);
  assert.equal(q.receive, "19.7947");
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].body.dry, true, "priced-only by default");
  assert.equal(svc.calls[0].body.appFees, undefined);
  assert.equal(svc.calls[0].body.confidentiality, "public", "the probe's level, which the shared proxy holds to its own");

  const n = svc.calls.length;
  const refused = async (o, code) => {
    await assert.rejects(W.quoteIntentsWithdraw({ ...base, ...o }), (e) => e.code === code);
  };
  await refused({ amountUsdc: "4.99" }, "below-min");
  await refused({ amountUsdc: "500.000001" }, "over-tx-cap");
  await refused({ amountUsdc: "300", limits: { ...C.PRIVATE_LIMITS, maxTxUsdc: 250 } }, "over-tx-cap");
  await refused({ amountUsdc: "600", limits: { ...C.PRIVATE_LIMITS, maxTxUsdc: 9999 } }, "over-tx-cap");
  await refused({ confidentiality: "secret" }, "bad-request");
  await refused({ route: route("solana-usdc"), recipient: FIX.dry["solana-usdc"].recipient }, "route-off");
  await refused({ network: "testnet" }, "testnet-off");
  await refused({ recipient: "0x123" }, "bad-recipient");
  await refused({ dry: false }, "no-journal");
  await refused({ screen: async () => ({ ok: false, code: "sanctioned", message: "x" }) }, "sanctioned");
  await refused({ screen: async () => ({ ok: false, code: "screen-unavailable", message: "x" }) }, "screen-unavailable");
  assert.equal(svc.calls.length, n, "not one of those reached the service");

  /* A real quote reads the journal first: an unsettled withdrawal or the day cap stops it. */
  const journal = { canStart: () => ({ ok: false, code: "over-day-cap", message: "cap" }) };
  await refused({ dry: false, journal }, "over-day-cap");
  assert.equal(svc.calls.length, n);
  await assert.rejects(W.quoteIntentsWithdraw({ ...base, fetchImpl: fakeService(() => { const j = clone(c.response); j.quoteRequest.deadline = "2026-10-15T23:00:00.000Z"; return j; }) }), (e) => e.code === "unsafe-quote", "a deadline we did not ask for is refused");
});

test("W9b) the shared proxy's refusals and the service's own words reach the screen as the shared codes, in plain words naming no provider", async () => {
  const c = FIX.dry["arbitrum-usdc"];
  const base = { user: c.user, recipient: c.recipient, route: route("arbitrum-usdc"), amountUsdc: "20", screen: okScreen, now: () => Date.parse(c.response.timestamp), quoteUrl: "/api/intents-quote" };
  const cases = [
    [fakeService({ error: "private_mode_off", enabled: false, message: "Private mode is off." }, 503), "private-mode-off"],
    [fakeService({ error: "sanctioned", message: G.SANCTIONED_MESSAGE }, 451), "sanctioned"],
    [fakeService({ error: "screen_unavailable", message: G.SCREEN_UNAVAILABLE_MESSAGE }, 503), "screen-unavailable"],
    [fakeService({ error: "over_day_cap", message: "Private moves are limited to 1000 USDC a day." }, 422), "over-day-cap"],
    [fakeService({ error: "confidentiality_mismatch", message: "The privacy level changed. Reload and try again." }, 409), "confidentiality-mismatch"],
    [fakeService({ error: "pair_not_allowed", message: "That route is not offered." }, 400), "intents-error"],
    [fakeService({ message: "x" }, 429), "rate-limited"],
    [fakeService(FIX.baseUnavailable.response, 400), "intents-error"],
    [fakeService({ message: "NEAR Intents: HyperCore deposit via 1Click failed" }, 500), "intents-error"],
  ];
  for (const [f, code] of cases) {
    await assert.rejects(W.quoteIntentsWithdraw({ ...base, fetchImpl: f }), (e) => {
      assert.equal(e.code, code);
      assert.equal(e instanceof W.IntentsWithdrawError, true);
      assert.doesNotMatch(e.message, /NEAR|1Click|Defuse|Hyperliquid|HyperCore|Relay|intents/i);
      return true;
    });
  }
  await assert.rejects(W.quoteIntentsWithdraw({ ...base, fetchImpl: async () => { throw new Error("offline"); } }), (e) => e.code === "network");
});

/* ── W10 the preflight ─────────────────────────────────────────────────────── */

test("W10) preflight: the live answers give the 1.0 account fee and a balance check of amount + fee; anything unreadable blocks", async () => {
  const q = realQuote();
  const ok = await preflightFor(q);
  assert.equal(ok.ok, true);
  assert.equal(ok.accountFeeUsdc, 1);
  assert.equal(ok.needsUsdc, "21");
  assert.equal(ok.role, "missing");
  assert.equal(W.isVerifiedPreflight(ok), true);
  assert.equal(W.preflightFresh(ok, q, q.quotedAt + 2000), true);
  assert.equal(W.preflightFresh(ok, q, q.quotedAt + 1000 + W.WITHDRAW_PREFLIGHT_TTL_MS), false);
  assert.equal(W.preflightFresh({ ...ok }, q, q.quotedAt + 2000), false, "a copy is not a preflight");

  const info = fakeInfo();
  await W.readWithdrawPreflight({ quote: q, info, now: () => q.quotedAt });
  const ptc = info.calls.find((b) => b.type === "preTransferCheck");
  assert.deepEqual(ptc, { type: "preTransferCheck", user: REAL_DEPOSIT, source: q.user }, "user = the DESTINATION, source = the sender");

  const code = async (o) => (await preflightFor(q, o)).code;
  assert.equal(await code({ ptc: FIX.hl.ptcLazarus.response }), "sanctioned");
  assert.equal(await code({ role: { role: "vault" } }), "bad-deposit-address");
  assert.equal(await code({ role: { role: "agent" } }), "bad-deposit-address");
  assert.equal(await code({ role: {} }), "check-unknown");
  assert.equal(await code({ ptc: { ...LIVE_PTC, fee: undefined } }), "fee-unknown", "an unreadable fee blocks Confirm; it is never shown as 0");
  assert.equal(await code({ ptc: { ...LIVE_PTC, fee: "2.0" } }), "fee-high");
  assert.equal(await code({ ptc: { fee: "1.0" } }), "check-unknown");
  assert.equal(await code({ chs: { withdrawable: "20.999999" } }), "insufficient", "20 + the 1.0 fee needs 21");
  assert.equal(await code({ chs: { withdrawable: "21.0" } }), null);
  assert.equal(await code({ chs: {} }), "balance-unknown");
  assert.equal(await code({ fail: { preTransferCheck: true } }), "check-unknown");
  assert.equal(await code({ withdrawableUsdc: 5 }), "insufficient", "the screen's own withdrawable is used when given");
  assert.equal(await code({ withdrawableUsdc: Number.NaN }), "balance-unknown");
  assert.equal((await W.readWithdrawPreflight({ quote: dryQuote("arbitrum-usdc"), info: fakeInfo() })).code, "bad-quote");
});

test("W11) the review: Confirm works only with a fresh real quote AND its own fresh ok preflight; unknown figures are null", async () => {
  const q = realQuote();
  const pf = await preflightFor(q);
  const at = q.quotedAt + 2000;
  const r = W.privateWithdrawReview({ quote: q, preflight: pf, now: at });
  assert.equal(r.confirmable, true);
  assert.equal(r.accountFeeUsdc, "1");
  assert.equal(r.serviceFeeUsdc, "0.2053");
  assert.equal(r.totalFeeUsdc, "1.2053");
  assert.equal(r.refundFeeUsdc, "0.3153");
  assert.equal(r.private, false);
  assert.equal(W.privateWithdrawReview({ quote: dryQuote("arbitrum-usdc"), now: at }).why, "priced-only");
  assert.equal(W.privateWithdrawReview({ quote: q, preflight: null, now: at }).why, "unchecked");
  assert.equal(W.privateWithdrawReview({ quote: q, preflight: pf, now: q.quotedAt + W.WITHDRAW_QUOTE_TTL_MS }).why, "stale");
  const blocked = await preflightFor(q, { ptc: { ...LIVE_PTC, fee: null } });
  const rb = W.privateWithdrawReview({ quote: q, preflight: blocked, now: at });
  assert.equal(rb.confirmable, false);
  assert.equal(rb.accountFeeUsdc, null, "unknown is null, never 0");
  assert.equal(rb.totalFeeUsdc, null);
});

/* ── W12 the unsigned sendAsset ────────────────────────────────────────────── */

test("W12) the UNSIGNED sendAsset: to the verified deposit address, USDC, the exact amount, Perp to Perp, visible; built by master.js", async () => {
  const q = realQuote();
  const pf = await preflightFor(q);
  const now = q.quotedAt + 3000;
  const b = S.buildIntentsSendAsset({ quote: q, preflight: pf, profile: PROFILE, signatureChainId: "0xa4b1", nonce: now, master: REAL_USER, amountUsdc: "20", now });
  assert.equal(b.ok, true, b.message);
  assert.deepEqual(b.action, {
    type: "sendAsset", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet",
    destination: REAL_DEPOSIT.toLowerCase(), sourceDex: "", destinationDex: "",
    token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "20", fromSubAccount: "", nonce: now,
  });
  assert.equal(b.visible, true);
  assert.equal(b.primaryType, "HyperliquidTransaction:SendAsset");
  assert.deepEqual(b.types, SG.HL_USER_SIGNED_TYPES.sendAsset);
  assert.deepEqual(b.types["HyperliquidTransaction:SendAsset"].map((f) => [f.name, f.type]), R.RELAY_SEND_ASSET_FIELDS.map((x) => [...x]));
  assert.notEqual(b.action.destination, REAL_TO.toLowerCase(), "never the recipient");
  assert.notEqual(b.action.destination, REAL_USER.toLowerCase(), "never the user");

  const no = (o, code) => {
    const r = S.buildIntentsSendAsset({ quote: q, preflight: pf, profile: PROFILE, signatureChainId: "0xa4b1", nonce: now, master: REAL_USER, now, ...o });
    assert.equal(r.ok, false, code);
    assert.equal(r.code, code);
    assert.doesNotMatch(r.message, /Hyperliquid|NEAR|Relay|1Click/);
  };
  no({ quote: { ...q } }, "bad_quote");
  no({ quote: dryQuote("arbitrum-usdc") }, "bad_quote");
  no({ now: q.quotedAt + W.WITHDRAW_QUOTE_TTL_MS }, "quote_expired");
  no({ preflight: { ...pf } }, "recheck");
  no({ preflight: null }, "recheck");
  no({ master: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }, "wallet_mismatch");
  no({ master: "nope" }, "no_wallet");
  no({ profile: N.hlNetworkProfile("testnet") }, "wrong_network");
  no({ nonce: now - R.HL_NONCE_PAST_MS - 1 }, "quote_expired");
  no({ nonce: 0 }, "bad_nonce");
  no({ amountUsdc: "20.5" }, "amount_mismatch");
  /* A preflight of ANOTHER quote (same address, a different reading) is not this one's. */
  const q2 = realQuote(null, { now: REAL_AT + 1 });
  const pf2 = await preflightFor(q2);
  no({ preflight: pf2 }, "recheck");
});

test("W13) the no-window list did not grow: sendAsset is never silent, and nothing in the Privy bridge reaches this route", () => {
  assert.deepEqual([...M.HL_SILENT_MASTER_ACTIONS], ["approveAgent", "approveBuilderFee"]);
  assert.equal(M.silentMasterAllowed("privy", "sendAsset"), false);
  assert.equal(S.INTENTS_SEND_ACTION, "sendAsset");
  for (const f of ["src/components/privy/PrivyBridge.jsx", "src/services/privy.js", "src/lib/hyperliquid/exchange/master.js"]) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(text, /lib\/intents|intents\//, `${f} must not import the Private route`);
  }
  const bridge = fs.readFileSync(path.join(ROOT, "src/components/privy/PrivyBridge.jsx"), "utf8");
  const silent = bridge.slice(bridge.indexOf("const SILENT_APPROVALS = {"), bridge.indexOf("};", bridge.indexOf("const SILENT_APPROVALS = {")));
  assert.deepEqual([...silent.matchAll(/"(HyperliquidTransaction:[A-Za-z]+)"/g)].map((m) => m[1]), ["HyperliquidTransaction:ApproveAgent", "HyperliquidTransaction:ApproveBuilderFee"]);
});

/* ── W14 the journal ───────────────────────────────────────────────────────── */

const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEP = (n) => `0x${String(n).padStart(40, "a")}`;
const claimArgs = (n, over = {}) => ({ depositAddress: DEP(n), routeId: "arbitrum-usdc", recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", amountRaw: "40000000000", accountFeeUsdc: 1, deadlineAt: 10_000_000, now: 1000, ...over });

test("W14) journal: a claim is written and read back; one claim per deposit address, ever; the recipient is not stored in clear", () => {
  const st = memStorage();
  const j = J.createWithdrawJournal({ user: USER, storage: st, now: () => 1000 });
  const c = j.claim(claimArgs(1));
  assert.equal(c.ok, true);
  assert.equal(c.record.state, "claimed");
  assert.equal(j.claim(claimArgs(1)).code, "used", "the same address: refused as used");
  assert.equal(j.claim(claimArgs(2)).code, "unsettled", "another address: refused while the first outcome is unknown");
  j.settle(DEP(1), "sent");
  assert.equal(j.claim(claimArgs(1)).code, "used", "a deposit address is paid once");
  const raw = JSON.stringify(st.dump());
  assert.doesNotMatch(raw, /70997970/i, "no readable recipient on the device");
  assert.equal(j.get(DEP(1)).recipientTag, J.recipientTag("0x70997970c51812dc3a010c7d01b50e0d17dc79c8"));
  assert.equal(J.recipientTag("AbC"), J.recipientTag("AbC"));
  assert.notEqual(J.recipientTag("AbC"), J.recipientTag("abc"), "non-EVM fingerprints are case-exact");
});

test("W14b) journal: nothing new while an outcome is unknown (until its address is dead); the 1,000 USDC day cap counts what left", () => {
  let t = 1000;
  const j = J.createWithdrawJournal({ user: USER, storage: memStorage(), now: () => t });
  assert.equal(j.claim(claimArgs(1)).ok, true);
  j.settle(DEP(1), "unknown");
  assert.equal(j.canStart({ amountRaw: "100" }).code, "unsettled");
  t = 10_000_001; /* past the first address's deadline */
  assert.equal(j.canStart({ amountRaw: "100" }).ok, true, "a dead address no longer blocks");
  t = 1000;
  j.settle(DEP(1), "sent");
  assert.equal(j.claim(claimArgs(2, { amountRaw: "50000000000" })).ok, true);  /* 400 + 500 */
  j.settle(DEP(2), "not-sent");
  assert.equal(j.claim(claimArgs(3, { amountRaw: "50000000000" })).ok, true, "a not-sent one does not count");
  j.settle(DEP(3), "arrived");
  const cap = j.claim(claimArgs(4, { amountRaw: "20000000000" }));  /* 900 + 200 > 1000 */
  assert.equal(cap.code, "over-day-cap");
  assert.equal(cap.leftUsdc, "100");
  assert.match(cap.message, /1,000 USDC a day.*100 USDC more/);
  t = 1000 + 86_400_000;
  assert.equal(j.canStart({ amountRaw: "20000000000" }).ok, true, "a rolling day");
  const lower = J.createWithdrawJournal({ user: USER, storage: memStorage(), now: () => 1000, dayCapUsdc: 300 });
  assert.equal(lower.canStart({ amountRaw: "40000000000" }).code, "over-day-cap", "a server may LOWER the day cap");
  const higher = J.createWithdrawJournal({ user: USER, storage: memStorage(), now: () => 1000, dayCapUsdc: 5000 });
  assert.equal(higher.canStart({ amountRaw: "110000000000" }).code, "over-day-cap", "never raise it");
});

test("W14c) journal: storage that throws or drops writes means no claim (and so no window); states only move forward", () => {
  assert.equal(J.createWithdrawJournal({ user: USER, storage: memStorage({ throwOnSet: true }) }).claim(claimArgs(1)).code, "registry");
  assert.equal(J.createWithdrawJournal({ user: USER, storage: memStorage({ dropWrites: true }) }).claim(claimArgs(1)).code, "registry");
  assert.equal(J.createWithdrawJournal({ user: USER, storage: null }).claim(claimArgs(1)).code, "registry");
  assert.equal(J.createWithdrawJournal({ user: "nope", storage: memStorage() }).claim(claimArgs(1)).code, "registry");
  const j = J.createWithdrawJournal({ user: USER, storage: memStorage(), now: () => 1000 });
  j.claim(claimArgs(1));
  assert.equal(j.settle(DEP(1), "arrived").state, "arrived");
  assert.equal(j.settle(DEP(1), "arriving"), null, "a late answer cannot walk it back");
  assert.equal(j.settle(DEP(1), "not-sent"), null);
  j.claim(claimArgs(2));
  j.settle(DEP(2), "not-sent");
  assert.equal(j.settle(DEP(2), "arriving").state, "arriving", "proof that money left overrides a reading of silence");
  assert.equal(j.settle(DEP(9), "sent"), null, "an unknown id is never created by settle");
  const st = memStorage();
  st.setItem(`${J.PRIVATE_WITHDRAW_PREFIX}${USER.toLowerCase()}:${DEP(5)}`, "{not json");
  assert.deepEqual(J.createWithdrawJournal({ user: USER, storage: st }).list(), [], "a malformed record is ignored, never trusted");
});

/* ── W15 the executor ──────────────────────────────────────────────────────── */

async function setup({ storage = memStorage() } = {}) {
  const q = realQuote();
  const pf = await preflightFor(q);
  const journal = J.createWithdrawJournal({ user: q.user, storage, now: () => q.quotedAt + 3000 });
  return { q, pf, journal, now: () => q.quotedAt + 3000 };
}
const recorder = (answer, journalRef) => {
  const calls = [];
  const fn = async (args) => {
    calls.push({ args, stateAtCall: journalRef.j.get(args.quote.depositAddress)?.state ?? null, words: SW.peekSignWords() });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  fn.calls = calls;
  return fn;
};

test("W15) execute: the record is WRITTEN before the wallet is asked; one call; sent -> journal 'sent'", async () => {
  const { q, pf, journal, now } = await setup();
  const ref = { j: journal };
  const send = recorder({ ok: true, amountUsdc: "20" }, ref);
  const words = { title: "Withdraw 20 USDC", method: "eth_signTypedData_v4", primaryType: "HyperliquidTransaction:SendAsset" };
  const mism = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, amountUsdc: "20.5", now });
  assert.equal(mism.code, "amount_mismatch");
  assert.equal(send.calls.length, 0, "a typed amount that is not the quote's never reaches the wallet");
  assert.equal(journal.get(REAL_DEPOSIT), null, "and nothing is recorded");
  const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, amountUsdc: "20", signWords: words, now });
  assert.equal(r.ok, true);
  assert.equal(send.calls[0].args.amountUsdc, "20", "the typed amount is handed to the gate to check again");
  assert.equal(r.depositAddress, REAL_DEPOSIT);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].stateAtCall, "claimed", "the idempotency record existed when the wallet was asked");
  assert.equal(send.calls[0].words.title, "Withdraw 20 USDC", "the window's words were armed for that one signature");
  assert.equal(SW.peekSignWords(), null, "and disarmed after");
  assert.equal(journal.get(REAL_DEPOSIT).state, "sent");
  const again = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, now });
  assert.equal(again.ok, false);
  assert.equal(again.code, "used");
  assert.equal(again.nothingSent, true);
  assert.equal(send.calls.length, 1, "never a second sendAsset for one address");
});

test("W15b) execute: a LOST reply is not confirmed, recorded unknown, and never sent again; a refusal is nothing sent", async () => {
  for (const answer of [{ ok: false, code: "not_confirmed", lost: true, retry: false }, { ok: false, code: "network", lost: true }, { ok: false, code: "unexpected" }, new Error("boom"), null]) {
    const { q, pf, journal, now } = await setup();
    const send = recorder(answer, { j: journal });
    const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, now });
    assert.equal(r.ok, false);
    assert.equal(r.notConfirmed, true, JSON.stringify(answer));
    assert.match(r.message, /NOT sent twice/);
    assert.equal(journal.get(REAL_DEPOSIT).state, "unknown");
    const again = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, now });
    assert.equal(again.ok, false);
    assert.equal(send.calls.length, 1);
  }
  for (const answer of [{ ok: false, code: "user_rejected", message: "You declined the signature in your wallet. Nothing was sent." }, { ok: false, code: "wallet_timeout", message: "x" }, { ok: false, code: "hl_error", message: "Hyperliquid said: Insufficient balance" }]) {
    const { q, pf, journal, now } = await setup();
    const send = recorder(answer, { j: journal });
    const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, now });
    assert.equal(r.nothingSent, true);
    assert.equal(r.notConfirmed, undefined);
    assert.equal(journal.get(REAL_DEPOSIT).state, "not-sent");
    assert.doesNotMatch(r.message, /Hyperliquid/, "the venue's name is made plain");
    assert.equal((await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, now })).code, "used", "a new attempt is a new quote");
  }
});

test("W15c) execute: no journal, an unwritable one, a stale quote or a stale/blocked preflight -> the wallet is never asked", async () => {
  const { q, pf, now } = await setup();
  const send = recorder({ ok: true }, { j: { get: () => null } });
  const blocked = await preflightFor(q, { ptc: { ...LIVE_PTC, fee: null } });
  const cases = [
    { journal: null },
    { journal: J.createWithdrawJournal({ user: q.user, storage: memStorage({ dropWrites: true }), now }) },
    { journal: J.createWithdrawJournal({ user: q.user, storage: memStorage({ throwOnSet: true }), now }) },
    { now: () => q.quotedAt + W.WITHDRAW_QUOTE_TTL_MS + 1 },
    { preflight: blocked },
    { preflight: { ...pf } },
    { quote: { ...q } },
    { quote: dryQuote("arbitrum-usdc") },
    { sendIntentsDeposit: undefined },
  ];
  for (const c of cases) {
    const journal = "journal" in c ? c.journal : J.createWithdrawJournal({ user: q.user, storage: memStorage(), now });
    const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: send, now, ...c });
    assert.equal(r.ok, false);
    assert.equal(r.nothingSent, true);
  }
  assert.equal(send.calls.length, 0);
});

/* ── W16 status ────────────────────────────────────────────────────────────── */

const statusAnswer = (status, mutate = null) => {
  const qr = clone(REAL);
  const j = {
    correlationId: "c", status, updatedAt: "2026-10-15T06:46:00.000Z",
    quoteResponse: { quote: qr.quote, quoteRequest: qr.quoteRequest },
    swapDetails: {
      intentHashes: [], nearTxHashes: [], amountOutFormatted: "19.7947", refundedAmountFormatted: status === "REFUNDED" ? "19.6847" : "0",
      originChainTxHashes: [{ hash: "0xin", explorerUrl: "" }], destinationChainTxHashes: [{ hash: "0xout", explorerUrl: "" }],
    },
  };
  if (mutate) mutate(j);
  return j;
};
const expectReal = { depositAddress: REAL_DEPOSIT, user: REAL_USER, routeId: "arbitrum-usdc", amountRaw: "2000000000", recipient: REAL_TO };

test("W16) status: the seven statuses folded; INCOMPLETE is never arrived; an answer about another withdrawal is unknown", () => {
  const fold = (s) => T.normalizeWithdrawStatus(statusAnswer(s), 200, expectReal).status;
  assert.equal(fold("PENDING_DEPOSIT"), "waiting");
  assert.equal(fold("KNOWN_DEPOSIT_TX"), "arriving");
  assert.equal(fold("PROCESSING"), "arriving");
  assert.equal(fold("SUCCESS"), "arrived");
  assert.equal(fold("INCOMPLETE_DEPOSIT"), "incomplete");
  assert.equal(fold("REFUNDED"), "refunded");
  assert.equal(fold("FAILED"), "failed");
  assert.equal(fold("SOMETHING_NEW"), "unknown");
  assert.equal(T.normalizeWithdrawStatus(FIX.status404.response, 404, expectReal).status, "not-found");
  assert.equal(T.normalizeWithdrawStatus({ message: "x" }, 500, expectReal).status, "unknown");
  const ok = T.normalizeWithdrawStatus(statusAnswer("SUCCESS"), 200, expectReal);
  assert.equal(ok.receive, "19.7947");
  assert.deepEqual(ok.outTxHashes, ["0xout"]);
  assert.equal(T.normalizeWithdrawStatus(statusAnswer("PROCESSING"), 200, expectReal).receive, null, "what arrived is only said on SUCCESS");
  for (const m of [
    (j) => { j.quoteResponse.quoteRequest.recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; },
    (j) => { j.quoteResponse.quoteRequest.refundTo = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; },
    (j) => { j.quoteResponse.quoteRequest.amount = "1"; },
    (j) => { j.quoteResponse.quoteRequest.destinationAsset = route("base-usdc").assetId; },
    (j) => { j.quoteResponse.quote.depositAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; },
  ]) {
    const s = T.normalizeWithdrawStatus(statusAnswer("SUCCESS", m), 200, expectReal);
    assert.equal(s.status, "unknown");
    assert.equal(s.mismatch, true);
  }
  /* After a reload only the fingerprint is known, and it is enough. */
  const tagged = { ...expectReal, recipient: undefined, recipientTag: J.recipientTag(REAL_TO) };
  delete tagged.recipient;
  assert.equal(T.normalizeWithdrawStatus(statusAnswer("SUCCESS"), 200, tagged).status, "arrived");
  assert.equal(T.normalizeWithdrawStatus(statusAnswer("SUCCESS"), 200, { ...tagged, recipientTag: J.recipientTag("0x1") }).status, "unknown");
});

test("W16a) the kill switch stops new moves, not the follow-up: a private_mode_off status read falls back to the keyless GET once", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.startsWith("/api/")) return { status: 503, ok: false, json: async () => ({ error: "private_mode_off" }) };
    return { status: 200, ok: true, json: async () => statusAnswer("SUCCESS") };
  };
  const s = await T.readIntentsWithdrawStatus({ depositAddress: REAL_DEPOSIT, expect: expectReal, fetchImpl, url: C.INTENTS_STATUS_PROXY });
  assert.equal(s.status, "arrived");
  assert.deepEqual(urls, [`/api/intents-status?depositAddress=${REAL_DEPOSIT}`, `https://1click.chaindefuser.com/v0/status?depositAddress=${REAL_DEPOSIT}`]);
  const plain = await T.readIntentsWithdrawStatus({ depositAddress: REAL_DEPOSIT, expect: expectReal, fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({ message: "down" }) }), url: C.INTENTS_STATUS_PROXY });
  assert.equal(plain.status, "unknown", "any other failure is unknown, never arrived");
});

test("W16b) a lost reply is settled by reads only: the status first, then the customer's own ledger; never by sending", async () => {
  const mk = async (state) => {
    const j = J.createWithdrawJournal({ user: REAL_USER, storage: memStorage(), now: () => REAL_AT });
    j.claim({ depositAddress: REAL_DEPOSIT, routeId: "arbitrum-usdc", recipient: REAL_TO, amountRaw: "2000000000", deadlineAt: Date.parse(REAL.quote.deadline), now: REAL_AT });
    if (state !== "claimed") j.settle(REAL_DEPOSIT, state);
    return j;
  };
  const svc = (status, body) => async () => ({ status, ok: status === 200, json: async () => body });
  const later = () => REAL_AT + T.LEDGER_SETTLE_MS + 1;

  let j = await mk("unknown");
  assert.equal(await T.settleFromReads({ journal: j, record: j.get(REAL_DEPOSIT), user: REAL_USER, fetchImpl: svc(200, statusAnswer("PROCESSING")), now: later, info: fakeInfo() }), "arriving");

  j = await mk("unknown");
  const sent = [{ time: REAL_AT + 500, hash: "0xh", delta: { type: "send", user: REAL_USER, destination: REAL_DEPOSIT.toLowerCase(), sourceDex: "", destinationDex: "", token: "USDC", amount: "20.0", fee: "1.0" } }];
  assert.equal(await T.settleFromReads({ journal: j, record: j.get(REAL_DEPOSIT), user: REAL_USER, fetchImpl: svc(404, FIX.status404.response), now: later, info: fakeInfo({ fail: { ledgerRows: sent } }) }), "sent");

  j = await mk("claimed");
  assert.equal(await T.settleFromReads({ journal: j, record: j.get(REAL_DEPOSIT), user: REAL_USER, fetchImpl: svc(404, FIX.status404.response), now: later, info: fakeInfo() }), "not-sent");
  assert.equal(j.canStart({ amountRaw: "100" }).ok, true, "settled: a new withdrawal may start");

  j = await mk("unknown");
  assert.equal(await T.settleFromReads({ journal: j, record: j.get(REAL_DEPOSIT), user: REAL_USER, fetchImpl: svc(404, FIX.status404.response), now: () => REAL_AT + 1000, info: fakeInfo() }), null, "too early to read silence as no");
  assert.equal(await T.settleFromReads({ journal: j, record: j.get(REAL_DEPOSIT), user: REAL_USER, fetchImpl: svc(404, FIX.status404.response), now: later, info: fakeInfo({ fail: { userNonFundingLedgerUpdates: true } }) }), null, "an unreadable ledger decides nothing");
  assert.equal(await T.settleFromReads({ journal: j, record: j.get(REAL_DEPOSIT), user: REAL_USER, fetchImpl: svc(200, statusAnswer("SUCCESS", (x) => { x.quoteResponse.quoteRequest.refundTo = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; })), now: later, info: fakeInfo({ fail: { userNonFundingLedgerUpdates: true } }) }), null, "a mismatched answer settles nothing");
  assert.equal(j.get(REAL_DEPOSIT).state, "unknown");

  const led = await T.readSendOutcome({ user: REAL_USER, depositAddress: REAL_DEPOSIT, since: REAL_AT, now: later, info: fakeInfo({ fail: { ledgerRows: [{ delta: { type: "send", user: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", destination: REAL_DEPOSIT } }] } }) });
  assert.equal(led.sent, false, "someone else's send to that address is not ours");
});

test("W16c) the tracker polls, settles the journal, stops at an end, and parks while hidden", async () => {
  const j = J.createWithdrawJournal({ user: REAL_USER, storage: memStorage(), now: () => REAL_AT });
  j.claim({ depositAddress: REAL_DEPOSIT, routeId: "arbitrum-usdc", recipient: REAL_TO, amountRaw: "2000000000", deadlineAt: Date.parse(REAL.quote.deadline), now: REAL_AT });
  j.settle(REAL_DEPOSIT, "sent");
  const seq = ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"];
  let i = 0;
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => statusAnswer(seq[Math.min(i++, seq.length - 1)]) });
  const pending = [];
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  const seen = [];
  const tr = T.trackIntentsWithdraw({ depositAddress: REAL_DEPOSIT, expect: expectReal, journal: j, onUpdate: (s) => seen.push(s.status), fetchImpl, timers, now: () => REAL_AT, hidden: () => false, onVisibility: () => () => {} });
  const flush = async () => { for (let k = 0; k < 10; k++) await Promise.resolve(); };
  await flush();
  while (pending.length && seen.length < 3) { pending.shift()(); await flush(); }
  assert.deepEqual(seen, ["waiting", "arriving", "arrived"]);
  assert.equal(j.get(REAL_DEPOSIT).state, "arrived");
  assert.equal(tr.snapshot().status, "arrived");
  const before = i;
  while (pending.length) { pending.shift()(); await flush(); }
  assert.equal(i, before, "stopped: no more reads");
});

/* ── W17 the shared server half (api/intents-quote.js + guard.js) takes exactly what this file builds ── */

const PNOW = Date.parse("2026-10-15T07:00:01Z");
const goodBody = (over = {}) => ({
  ...W.buildIntentsWithdrawBody({ user: USER, recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", route: route("arbitrum-usdc"), amountUsdc: "20", dry: true, now: PNOW }),
  ...over,
});
function sharedNet({ oracle = () => false } = {}) {
  const calls = { upstream: [], rpc: [] };
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://1click.chaindefuser.com/")) {
      const b = JSON.parse(init.body);
      calls.upstream.push({ url: u, body: b, headers: init.headers });
      /* The live Arbitrum answer, echoing whatever was asked (the service echoes the request). */
      const j = clone(FIX.dry["arbitrum-usdc"].response);
      j.quoteRequest = { ...j.quoteRequest, ...b };
      if (!b.dry) Object.assign(j.quote, { depositAddress: REAL_DEPOSIT, deadline: new Date(PNOW + 72 * 3600000).toISOString(), timeWhenInactive: new Date(PNOW + 72 * 3600000).toISOString() });
      return { status: 200, ok: true, text: async () => JSON.stringify(j), json: async () => j };
    }
    const rpcBody = JSON.parse(init.body);
    calls.rpc.push(rpcBody);
    const v = oracle(`0x${rpcBody.params[0].data.slice(-40)}`);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: `0x${(v ? 1 : 0).toString(16).padStart(64, "0")}` }) };
  };
  fn.calls = calls;
  return fn;
}
const viaShared = (body, { env = { PRIVATE_MODE: "on" }, net = sharedNet() } = {}) => Q.intentsQuoteOnce({
  body, env, fetchImpl: net, rpcFetch: net, ledger: G.createDayLedger(), now: () => PNOW, screenMemo: G.newSanctionsMemo(), log: () => {},
});

test("W17) the shared proxy's own check accepts the withdraw body exactly as built (both routes, dry and real) and refuses Solana", () => {
  for (const id of ["base-usdc", "arbitrum-usdc"]) {
    for (const dry of [true, false]) {
      const b = W.buildIntentsWithdrawBody({ user: USER, recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", route: route(id), amountUsdc: "20", dry, now: PNOW });
      const r = G.checkQuoteBody(b, { now: PNOW, confidentiality: "public" });
      assert.equal(r.ok, true, `${id} dry=${dry}: ${JSON.stringify(r)}`);
      assert.equal(r.direction, "withdraw");
      assert.deepEqual(r.body, b, "forwarded unchanged");
      assert.deepEqual(r.addresses.sort(), [USER.toLowerCase(), "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"].sort(), "both the refund account and the typed recipient are screened");
    }
  }
  const sol = W.buildIntentsWithdrawBody({ user: USER, recipient: FIX.dry["solana-usdc"].recipient, route: route("solana-usdc"), amountUsdc: "20", dry: true, now: PNOW });
  assert.equal(G.checkQuoteBody(sol, { now: PNOW, confidentiality: "public" }).ok, false, "no Solana pair, as the route table says");
  assert.equal(G.checkQuoteBody(goodBody({ amount: "499999900" }), { now: PNOW }).error, "below_min");
  assert.equal(G.checkQuoteBody(goodBody({ amount: "50000000100" }), { now: PNOW }).error, "over_tx_cap");
  assert.equal(G.checkQuoteBody(goodBody(), { now: PNOW, confidentiality: "basic" }).error, "confidentiality_mismatch");
});

test("W17b) end to end through the shared proxy (fake service, fake RPC): screened first, forwarded unchanged with the key, and the answer verifies", async () => {
  const keyed = { PRIVATE_MODE: "on", NEAR_INTENTS_JWT: "jwt-xyz" };
  const net = sharedNet();
  assert.equal((await viaShared(goodBody(), { env: keyed, net })).status, 409, "with a key the server gives 'basic': a page that asked 'public' is told to reload");
  assert.equal(net.calls.upstream.length, 0);
  for (const dry of [true, false]) {
    const n = sharedNet();
    const body = goodBody({ confidentiality: "basic", dry });
    const r = await viaShared(body, { env: keyed, net: n });
    assert.equal(r.status, 200);
    assert.equal(n.calls.rpc.length >= 2, true, "the oracle was asked before the service");
    assert.deepEqual(n.calls.upstream[0].body, body, "forwarded unchanged");
    assert.doesNotMatch(r.body, /jwt-xyz/);
    const q = W.parseIntentsWithdrawQuote(JSON.parse(r.body), {
      user: USER, recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", route: route("arbitrum-usdc"), amountUsdc: "20",
      dry, deadline: body.deadline, now: PNOW, expectConfidentiality: "basic",
    });
    assert.equal(q.private, true);
    assert.equal(q.depositAddress, dry ? null : REAL_DEPOSIT);
  }
  const off = await viaShared(goodBody(), { env: {} });
  assert.equal(off.status, 503);
  assert.equal(JSON.parse(off.body).error, "private_mode_off");
  const listed = await viaShared(goodBody(), { net: sharedNet({ oracle: (a) => a === "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" }) });
  assert.equal(JSON.parse(listed.body).error, "sanctioned", "the typed recipient is screened by the server too");
});

/* ── W18 the words ─────────────────────────────────────────────────────────── */

test("W18) every word a screen can print names no provider and no banned privacy claim", () => {
  const texts = [
    ...Object.values(W.PRIVATE_WITHDRAW_WORDS).map((v) => (typeof v === "function" ? v("123") : v)),
    ...Object.values(O.SANCTIONS_WORDS),
    W.plainIntentsWords("NEAR Intents (1Click) via HyperCore: Relay failed at chaindefuser.com"),
    route("solana-usdc").offReason,
  ];
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(NEAR|1Click|Defuse|chaindefuser|Hyperliquid|HyperCore|Relay|intents)\b/i, t);
    assert.doesNotMatch(t, /anonymous|untraceable|no KYC|invisible|mixer|tumbler|launder|can't be tracked|VPN|\bZK\b/i, t);
  }
  assert.equal(W.plainIntentsWords("Funds near the deadline"), "Funds near the deadline", "the word 'near' is left alone");
  const src = ["src/lib/intents/withdraw.js", "src/lib/hyperliquid/exchange/intentsOut.js", "src/lib/intents/withdrawJournal.js", "src/lib/intents/withdrawStatus.js", "src/lib/intents/sanctionsOracle.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  for (const m of src.matchAll(/"([^"\n]*(?:anonymous|untraceable|mixer|tumbler|launder)[^"\n]*)"/gi)) assert.fail(`banned word in a string: ${m[1]}`);
});
