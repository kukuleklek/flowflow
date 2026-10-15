/**
 * test-avax-signers — THE AVAX WALLET SIGNS FOR REAL, AND ONLY IN A WINDOW.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
 * Privy เลย แล้วเตรียมเทสเงินจริง 2 USDC ไป-กลับ". src/avax/signers.js is what the
 * Avax flows sign with; this file runs it against a FAKE Privy (the hooks are
 * recorders) and the REAL bridge, services/privy, closed builders and trader:
 *
 *   S. getAvaxSigners / subscribeAvaxSigners: null until Privy, the bridge's
 *      Avalanche pair and the Perp backend agree on ONE address; stable; gone
 *      on logout, on another account, on a mock / view-as / injected backend;
 *   W. the windows: every Avalanche tx and typed data through the SHOWN hook,
 *      with the decoded words; a refusal never reaches Privy and reads as a
 *      cancel; the user's no is code 4001; anything else stays unknown;
 *   P. the Main Account's half: the authorize step pinned, the sendAsset to the
 *      PINNED depository and never over min(maxDebit, MAX_MOVE_USDC) — through
 *      the real exchange client and relayOut, signatureChainId 0xa4b1;
 *   R. the rehearsal of the owner's live test — 2 USDC out and back — with every
 *      executor run end to end on recorded quotes: move-in (executeOwnMove),
 *      move-out (executeMoveOut), swap (executeSwap) and Aave;
 *   C. the pieces around it: Privy's chains (Avalanche + our RPC, Arbitrum the
 *      default), the limits table (env lowers, never raises; stake cap == aaveTx),
 *      the window words == the card's, the depository pins agree, no switchChain.
 *
 * 🔴 MONEY SAFETY. Nothing here signs anything real or reaches a network: the
 * global fetch is a thrower, every Privy hook, Relay endpoint and Hyperliquid
 * endpoint is a recorder, and the only key is the official Python SDK's
 * published test key. Fixtures are read-only Relay answers (scripts/fixtures/avax).
 *
 * Run: node --test scripts/test-avax-signers.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { autoStubs, bundle, fakeBrowser, code } from "./lib/perpLiveHarness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let realNetworkAttempts = 0;
globalThis.fetch = () => { realNetworkAttempts++; throw new Error("test-avax-signers: a real network call was attempted"); };

const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const OWN = "0x14791697260e4c9a71f18484c9f997b308e59325";
const OWN_CHECKSUM = "0x14791697260E4c9A71f18484C9f997B308e59325";
const STRANGER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const DEPOSITORY = "0x66cf0aace1b4e562593bec10ec7868fba9932224";
const GWEI = 10n ** 9n;
const FEES = Object.freeze({ maxFeePerGas: 11n * GWEI, maxPriorityFeePerGas: GWEI });
const HASH = `0x${"cd".repeat(32)}`;
const SIG = `0x${"11".repeat(65)}`;
const BRIDGE = "src/components/privy/PrivyBridge.jsx";
const RIG = "scripts/lib/avaxSignersRig.js";

/* A recorded quote, re-addressed from the burn address it was captured for to the test wallet. */
const FIX = path.join(ROOT, "scripts/fixtures/avax");
function fixtureFor(name, own = OWN) {
  const text = fs.readFileSync(path.join(FIX, name), "utf8").replace(/000000000000000000000000000000000000dead/gi, own.slice(2));
  return JSON.parse(text);
}

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const timers = { setTimeout: () => 0, clearTimeout: () => {} };

let Rig;
let CT, AT, SD, SW, MO, OM, MI, FL, PINS, CFG, GAS, GR, SC, R, C, N, AAVE, WD, viem, viemAccounts;

/* The fake Privy: every hook a recorder that knows its place in the render (0 silent, 1 shown, with the Perp mode on). */
const privy = { sign: [], send: [], address: OWN, sendImpl: null, signImpl: null, hooks: [] };
function fakePrivyHooks() {
  const seen = { sign: 0, send: 0 };
  globalThis.__impl = {
    usePrivy: () => { seen.sign = 0; seen.send = 0; return { ready: true, authenticated: true }; },
    useWallets: () => ({ wallets: [{ walletClientType: "privy", address: privy.address }] }),
    useLogout: () => ({ logout: async () => {} }),
    useLogin: () => ({ login: () => {} }),
    useSignTypedData: () => {
      privy.hooks.push("useSignTypedData");
      const which = seen.sign++;
      return { signTypedData: async (input, opts) => { privy.sign.push([input, opts, which]); return privy.signImpl ? privy.signImpl(input, opts) : { signature: SIG }; } };
    },
    useSendTransaction: () => {
      privy.hooks.push("useSendTransaction");
      const which = seen.send++;
      return { sendTransaction: async (input, opts) => { privy.send.push([input, opts, which]); return privy.sendImpl ? privy.sendImpl(input, opts) : { hash: HASH }; } };
    },
  };
}

let mounted = null;
/** Sign `address` in: Privy's session, the bridge (its Avalanche pair), and a Perp backend for the same account. */
function signIn(address = OWN, { backend = {} } = {}) {
  if (mounted) { mounted.unmount(); mounted = null; }
  privy.address = address;
  privy.sign.length = 0;
  privy.send.length = 0;
  privy.hooks.length = 0;
  privy.sendImpl = null;
  privy.signImpl = null;
  Rig.registerPrivyLogin({ ready: true, authenticated: true, embeddedAddress: address, user: null });
  mounted = Rig.mount(() => Rig.PrivyBridge());
  mounted.render();
  mounted.flush();
  const calls = { authorize: [], deposit: [] };
  const b = {
    kind: "live", mock: false, address, walletType: "privy", readOnly: false, viewAs: false,
    signRelayAuthorize: async (step) => { calls.authorize.push(step); return { ok: true, signature: SIG, post: { endpoint: "/authorize", method: "POST", body: {} } }; },
    sendRelayDeposit: async (args) => { calls.deposit.push(args); return { ok: true }; },
    ...backend,
  };
  const off = Rig.registerAvaxPerpSigners(b);
  return { calls, off, backend: b };
}

before(async () => {
  fakeBrowser();
  fakePrivyHooks();
  const keep = ["src/services/privy.js", "src/services/signWords.js", "src/lib/perpFlag.js", "src/avax/closedTx.js"];
  Rig = await bundle({ entry: RIG, env: { VITE_PRIVY_APP_ID: "app", VITE_PERP_ENABLED: "1" }, stubs: autoStubs([BRIDGE], { keep }) });
  CT = await imp("src/avax/closedTx.js");
  AT = await imp("src/lib/avax/aaveTx.js");
  SD = await imp("src/lib/avax/swapDecode.js");
  SW = await imp("src/lib/relay/swap.js");
  MO = await imp("src/lib/relay/moveOut.js");
  OM = await imp("src/lib/relay/ownMove.js");
  MI = await imp("src/lib/relay/moveIn.js");
  FL = await imp("src/avax/flows.js");
  PINS = await imp("src/lib/avax/relayPins.js");
  CFG = await imp("src/lib/avax/config.js");
  GAS = await imp("src/lib/avax/gas.js");
  GR = await imp("src/avax/limits.js");
  SC = await imp("src/lib/signCopy.js");
  R = await imp("src/lib/hyperliquid/exchange/relayOut.js");
  C = await imp("src/lib/hyperliquid/exchange/client.js");
  N = await imp("src/lib/hyperliquid/exchange/network.js");
  WD = await imp("src/lib/relay/withdraw.js");
  AAVE = AT;
  viem = await import("viem");
  viemAccounts = await import("viem/accounts");
});

/* ════════════════════════════════════════════════════════════════════════════
   S. WHEN THERE ARE SIGNERS AT ALL
   ════════════════════════════════════════════════════════════════════════════ */

test("S1) null until Privy, the bridge's Avalanche pair AND the Perp backend agree on one address; then one stable object, own lowercase", () => {
  assert.equal(Rig.getAvaxSigners(), null, "nobody signed in");
  const { off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  assert.ok(s);
  assert.equal(s.own, OWN);
  assert.deepEqual(Object.keys(s).sort(), ["own", "sendAvaxTx", "sendDeposit", "signAuthorize", "signAvaxTypedData"]);
  assert.equal(Rig.getAvaxSigners(), s, "the same object until something changes (a store can read it)");
  assert.ok(Object.isFrozen(s));
  off();
  assert.equal(Rig.getAvaxSigners(), null, "the Perp backend went: no signers");
});

test("S2) 🔴 no signers for a mock, a view-as, a read-only or an injected backend, or a backend for ANOTHER account", () => {
  for (const backend of [
    { kind: "mock", mock: true }, { viewAs: true }, { readOnly: true }, { walletType: "metamask" },
    { address: STRANGER }, { signRelayAuthorize: undefined },
  ]) {
    const { off } = signIn(OWN, { backend });
    assert.equal(Rig.getAvaxSigners(), null, JSON.stringify(Object.keys(backend)));
    off();
  }
  /* Privy's own session naming another wallet. */
  const { off } = signIn(OWN);
  Rig.registerPrivyLogin({ ready: true, authenticated: true, embeddedAddress: STRANGER, user: null });
  assert.equal(Rig.getAvaxSigners(), null);
  Rig.registerPrivyLogin({ ready: true, authenticated: false, embeddedAddress: null, user: null });
  assert.equal(Rig.getAvaxSigners(), null, "logged out");
  off();
});

test("S3) subscribeAvaxSigners fires on login, account switch and logout — once per change", () => {
  const seen = [];
  const unsub = Rig.subscribeAvaxSigners((s) => seen.push(s ? s.own : null));
  const a = signIn(OWN);
  const other = "0x2222222222222222222222222222222222222222";
  a.off();
  const b = signIn(other);
  b.off();
  unsub();
  signIn(OWN).off();
  assert.deepEqual(seen.filter((x, i) => i === 0 || x !== seen[i - 1]), seen, "never the same answer twice in a row");
  assert.ok(seen.includes(OWN) && seen.includes(other) && seen.includes(null));
  assert.equal(seen.at(-1), null, "and nothing after unsubscribing");
});

/* ════════════════════════════════════════════════════════════════════════════
   W. THE WINDOWS
   ════════════════════════════════════════════════════════════════════════════ */

test("W1) 🔴 sendAvaxTx: Privy's SHOWN send hook, window shown, the decoded words, chainId 43114, the rebuilt tx — and it resolves the hash", async () => {
  const { off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const [approve] = AT.buildSupplySteps({ own: OWN, amountRaw: 2000000n, allowanceRaw: 0n, fees: FEES }).map((x) => x.tx);
  assert.equal(await s.sendAvaxTx(approve, { words: "anything a caller writes", check: { kind: "aave" } }), HASH);
  assert.equal(privy.send.length, 1);
  const [input, opts, which] = privy.send[0];
  assert.equal(which, 1, "instance 1 of useSendTransaction: the SHOWN pair, never the silent one");
  assert.equal(opts.uiOptions.showWalletUIs, true);
  assert.equal(opts.uiOptions.description, "Allow exactly 2 USDC for Aave", "the decoded words, never the caller's");
  assert.equal(opts.uiOptions.transactionInfo.title, "Allow USDC for Aave");
  assert.equal(opts.address, OWN);
  assert.equal(input.chainId, 43114);
  assert.equal(input.value, "0x0");
  assert.equal(input.gasLimit, "0x124f8");
  off();
});

test("W2) 🔴 a refusal is thrown BEFORE Privy is asked, code 'refused', and reads as a cancel (executeSwap counts it as nothing sent, never unknown)", async () => {
  const { off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const supply = AT.buildSupplyTx({ own: OWN, amountRaw: 2000000n, fees: FEES });
  for (const [tx, check] of [
    [{ ...supply, chainId: 42161 }, { kind: "aave" }],
    [supply, { kind: "raw" }],
    [supply, undefined],
    [{ ...supply, data: supply.data.replace(OWN.slice(2), STRANGER.slice(2)) }, { kind: "aave" }],
  ]) {
    await assert.rejects(() => s.sendAvaxTx(tx, { check }), (e) => e instanceof Rig.AvaxSignRefused && e.code === "refused" && /Cancelled/.test(e.message));
  }
  assert.equal(privy.send.length, 0, "Privy was never asked");
  off();
});

test("W3) the user's no is code 4001; a lost reply stays what it is (unknown to the executor); no hash is never a success", async () => {
  const { off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const supply = AT.buildSupplyTx({ own: OWN, amountRaw: 2000000n, fees: FEES });
  privy.sendImpl = () => { throw Object.assign(new Error("The user rejected the request"), { code: "unknown" }); };
  await assert.rejects(() => s.sendAvaxTx(supply, { check: { kind: "aave" } }), (e) => e.code === 4001);
  privy.sendImpl = () => { throw new Error("User exited the modal before submitting the transaction"); };
  await assert.rejects(() => s.sendAvaxTx(supply, { check: { kind: "aave" } }), (e) => e.code === 4001);
  privy.sendImpl = () => { throw new Error("socket hang up"); };
  await assert.rejects(() => s.sendAvaxTx(supply, { check: { kind: "aave" } }), (e) => e.code !== 4001 && e.code !== "refused" && /socket/.test(e.message));
  privy.sendImpl = () => ({ hash: "0x1234" });
  await assert.rejects(() => s.sendAvaxTx(supply, { check: { kind: "aave" } }), (e) => e.code !== "refused" && !/cancel|reject/i.test(e.message));
  off();
});

test("W4) 🔴 the wallet changing between the card and the window refuses it, before Privy", async () => {
  const { off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const supply = AT.buildSupplyTx({ own: OWN, amountRaw: 2000000n, fees: FEES });
  Rig.registerPrivyLogin({ ready: true, authenticated: true, embeddedAddress: STRANGER, user: null });
  await assert.rejects(() => s.sendAvaxTx(supply, { check: { kind: "aave" } }), (e) => e.code === "refused");
  assert.equal((await s.signAuthorize({})).code, "wallet");
  assert.equal((await s.sendDeposit({})).code, "wallet");
  assert.equal(privy.send.length, 0);
  off();
});

/* ════════════════════════════════════════════════════════════════════════════
   P. THE MAIN ACCOUNT'S HALF (the HyperCore windows of a move into the Spot Account)
   ════════════════════════════════════════════════════════════════════════════ */

const moveInFixture = () => fixtureFor("live-move-in-6-topup.json");
const moveInReview = (fx = moveInFixture()) => OM.parseOwnMoveQuote(fx.response, {
  own: OWN, dest: "usdc", amountRaw: "6000000", topupUsd: 0.3, maxDebitUsdc: MI.maxDebitUsdc(6, 0.3), now: fx.capturedAt,
});

test("P1) signAuthorize passes ONLY Relay's NonceMapping for this wallet, posted to /authorize, on to the backend's own signRelayAuthorize", async () => {
  const { calls, off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const review = moveInReview();
  const r = await s.signAuthorize(review.steps.authorize);
  assert.equal(r.ok, true);
  assert.equal(calls.authorize.length, 1);
  const edit = (f) => { const c = JSON.parse(JSON.stringify(review.steps.authorize)); f(c.items[0].data); return c; };
  for (const step of [
    edit((d) => { d.sign.primaryType = "Permit"; }),
    edit((d) => { d.sign.domain.name = "Something"; }),
    edit((d) => { d.sign.value.wallet = STRANGER; }),
    edit((d) => { d.sign.value.chainId = "ethereum"; }),
    edit((d) => { d.post.endpoint = "/execute"; }),
    null,
  ]) assert.equal((await s.signAuthorize(step)).code, "bad_quote");
  assert.equal(calls.authorize.length, 1, "nothing else reached the wallet");
  off();
});

test("P2) 🔴 sendDeposit hands the backend the own-move pins: the PINNED depository and min(maxDebit, MAX_MOVE_USDC)", async () => {
  const { calls, off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const step = moveInReview().steps.deposit;
  await s.sendDeposit({ step, amountUsdc: 6.342288, maxDebitUsdc: 6.7 });
  await s.sendDeposit({ step, amountUsdc: 6.342288 });
  await s.sendDeposit({ step, amountUsdc: 6.342288, maxDebitUsdc: 25 });
  await s.sendDeposit({ step, amountUsdc: 6.342288, maxDebitUsdc: "6.7" });
  assert.deepEqual(calls.deposit.map((c) => c.ownMove), [
    { depository: DEPOSITORY, maxDebitUsdc: 6.7 },
    { depository: DEPOSITORY, maxDebitUsdc: 20 },
    { depository: DEPOSITORY, maxDebitUsdc: 20 },
    { depository: DEPOSITORY, maxDebitUsdc: 20 },
  ], "the card's limit when it gives one, never above the 20 USDC cap");
  assert.equal(calls.deposit[0].step, step);
  assert.equal(calls.deposit[0].amountUsdc, 6.342288);
  off();
});

const MAIN = () => N.hlNetworkProfile("mainnet");

/* The user's wallet as WalletContext hands it to the trader (an ethers-like signer), parked on Arbitrum. */
function arbWallet() {
  const account = viemAccounts.privateKeyToAccount(PY_KEY);
  const prompts = [];
  return {
    account, prompts,
    signer: {
      getAddress: async () => account.address,
      provider: { getNetwork: async () => ({ chainId: 42161n }) },
      signTypedData: async (domain, types, message) => {
        prompts.push({ domain, types, message });
        return account.signTypedData({ domain, types, primaryType: Object.keys(types)[0], message });
      },
    },
  };
}
const memAgents = () => ({
  status: () => ({ state: "none", address: null, validUntil: null, reason: null, persisted: false }),
  account: () => null, prepare: () => ({ address: `0x${"7".repeat(40)}`, agentName: "x", validUntil: 0, persisted: false }),
  markApproved: () => true, discardPending: () => {}, markRejected: () => {}, clear: () => {}, subscribe: () => () => {}, version: () => 1,
});
function fakeHl() {
  const posts = [];
  return {
    posts,
    fetchImpl: async (url, init) => {
      if (/\/exchange$/.test(url)) { posts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { status: 200 }); }
      return new Response("{}", { status: 200 });
    },
  };
}
function realTrader({ nonce, wallet = arbWallet(), walletType = "privy", chainId = 42161 } = {}) {
  const hl = fakeHl();
  const t = C.createHlTrader({
    master: wallet.account.address, signer: wallet.signer, walletType, chainId, market: () => null, profile: MAIN(),
    deps: { fetchImpl: hl.fetchImpl, agents: memAgents(), nonces: { next: async () => nonce, serverNow: () => nonce, noteServerTime: () => {} } },
  });
  return { t, hl, wallet };
}

test("P3) 🔴 through the REAL trader: the sendAsset goes to the pinned depository for exactly the debit, signed for 0xa4b1 — over the limit or to another depository nothing is signed", async () => {
  const review = moveInReview();
  const step = review.steps.deposit;
  const nonce = step.items[0].data.nonce;
  const { t, hl, wallet } = realTrader({ nonce });
  const { off } = signIn(OWN, { backend: { signRelayAuthorize: (x) => t.signRelayAuthorize(x), sendRelayDeposit: (x) => t.sendRelayDeposit(x) } });
  const s = Rig.getAvaxSigners();

  const over = await s.sendDeposit({ step, amountUsdc: review.amountUsdc, maxDebitUsdc: 6 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "over_limit");
  const elsewhere = JSON.parse(JSON.stringify(step));
  elsewhere.items[0].data.action.parameters.destination = STRANGER;
  assert.equal((await s.sendDeposit({ step: elsewhere, amountUsdc: review.amountUsdc, maxDebitUsdc: 6.7 })).ok, false);
  assert.equal(wallet.prompts.length + hl.posts.length, 0, "no window, nothing posted");

  const r = await s.sendDeposit({ step, amountUsdc: review.amountUsdc, maxDebitUsdc: 6.7 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(hl.posts.length, 1);
  const a = hl.posts[0].action;
  assert.equal(a.type, "sendAsset");
  assert.equal(a.destination, DEPOSITORY);
  assert.equal(a.amount, "6.342288");
  assert.equal(a.signatureChainId, "0xa4b1", "a Privy wallet signs for Arbitrum, whatever else it touched");
  assert.equal(wallet.prompts.length, 1, "one visible prompt");
  assert.equal(wallet.prompts[0].domain.chainId, 42161);
  off();
});

test("P4) relayOut: an own move needs BOTH pins, from the caller; a Withdraw (no pins) is exactly what it was", () => {
  const step = moveInReview().steps.deposit;
  const nonce = step.items[0].data.nonce;
  const read = (ownMove) => R.readRelayDepositStep(step, { profile: MAIN(), amountUsdc: "6.342288", master: OWN, now: nonce, ownMove });
  assert.equal(read(null).ok, true, "a Withdraw: the depository is the quote's");
  assert.equal(read({ depository: DEPOSITORY, maxDebitUsdc: 6.342288 }).ok, true, "exactly at the limit");
  assert.equal(read({ depository: DEPOSITORY, maxDebitUsdc: 6.34 }).code, "over_limit");
  assert.equal(read({ depository: DEPOSITORY }).code, "no_limit");
  assert.equal(read({ depository: DEPOSITORY, maxDebitUsdc: Number.NaN }).code, "no_limit");
  assert.equal(read({ depository: DEPOSITORY, maxDebitUsdc: 0 }).code, "no_limit");
  assert.equal(read({ maxDebitUsdc: 20 }).code, "bad_quote", "no depository pin");
  assert.equal(read({ depository: STRANGER, maxDebitUsdc: 20 }).code, "bad_quote");
  assert.equal(read({ depository: "0x0000000000000000000000000000000000000000", maxDebitUsdc: 20 }).code, "bad_quote");
  assert.doesNotMatch(code("src/lib/hyperliquid/exchange/relayOut.js"), new RegExp(DEPOSITORY, "i"), "relayOut still names no depository of its own");
});

test("P5) masterGate: a Privy wallet signs every user-signed action for 0xa4b1 even when its provider reports Avalanche; an injected wallet keeps its own chain", async () => {
  assert.equal(C.HL_PRIVY_SIGNATURE_CHAIN_ID, `0x${(42161).toString(16)}`);
  const svc = code("src/services/privy.js");
  assert.match(svc, /PRIVY_CHAIN_ID\s*=\s*42161/, "the chain the Privy wallet is parked on");
  const review = moveInReview();
  const step = review.steps.deposit;
  const nonce = step.items[0].data.nonce;
  /* A Privy wallet whose provider says 43114 (it never should): still 0xa4b1. It signs any domain (an embedded wallet does). */
  const w = arbWallet();
  w.signer.provider.getNetwork = async () => ({ chainId: 43114n });
  const { t, hl } = realTrader({ nonce, wallet: w, chainId: 43114 });
  assert.equal((await t.sendRelayDeposit({ step, amountUsdc: "6.342288" })).ok, true);
  assert.equal(hl.posts[0].action.signatureChainId, "0xa4b1");
  /* An injected wallet on Avalanche signs for its own chain, as before. */
  const w2 = arbWallet();
  w2.signer.provider.getNetwork = async () => ({ chainId: 43114n });
  const inj = realTrader({ nonce, wallet: w2, walletType: "metamask", chainId: 43114 });
  assert.equal((await inj.t.sendRelayDeposit({ step, amountUsdc: "6.342288" })).ok, true);
  assert.equal(inj.hl.posts[0].action.signatureChainId, "0xa86a");
});

/* ════════════════════════════════════════════════════════════════════════════
   R. THE REHEARSAL: 2 USDC out and back, every executor end to end, on recorded quotes
   ════════════════════════════════════════════════════════════════════════════ */

function registry(storage, now) {
  return FL.createFlowRegistry({ storage, own: OWN, now, locks: null });
}

test("R1) 🔴 move-in (Main → Spot Account): executeOwnMove with the REAL signers and trader — authorize, POST, registry 'sending', ONE sendAsset to the pinned depository for 0xa4b1, 'arriving'", async () => {
  const fx = moveInFixture();
  const review = moveInReview(fx);
  const nonce = review.steps.deposit.items[0].data.nonce;
  const { t, hl, wallet } = realTrader({ nonce });
  const { off } = signIn(OWN, { backend: { signRelayAuthorize: (x) => t.signRelayAuthorize(x), sendRelayDeposit: (x) => t.sendRelayDeposit(x) } });
  const s = Rig.getAvaxSigners();
  const storage = new MemStorage();
  const clock = { now: fx.capturedAt + 1000 };
  const reg = registry(storage, () => clock.now);
  const rec = reg.begin({ kind: "move-in", amounts: { out: "6", in: "6.342288", topupUsd: 0.3 }, maxDebit: review.maxDebitUsdc });
  assert.equal(reg.confirm(rec.id).ok, true);
  const posts = [];
  const r = await OM.executeOwnMove({
    review, ownNow: () => s.own, flow: reg.handle(rec.id), now: () => clock.now, timers,
    signAuthorize: s.signAuthorize,
    sendDeposit: (args) => s.sendDeposit({ ...args, maxDebitUsdc: review.maxDebitUsdc }),
    signWords: SC.ownMoveSignWords(review),
    fetchImpl: async (url, init) => { posts.push([String(url).replace(/\?.*/, ""), JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state, "arriving");
  assert.deepEqual(posts.map((p) => p[0]), ["https://api.relay.link/authorize"]);
  assert.equal(wallet.prompts.length, 2, "two visible windows: the authorization, then the transfer");
  assert.equal(wallet.prompts[0].domain.name, "RelayNonceMapping");
  assert.equal(hl.posts.length, 1);
  assert.equal(hl.posts[0].action.destination, DEPOSITORY);
  assert.equal(hl.posts[0].action.amount, "6.342288");
  assert.equal(hl.posts[0].action.signatureChainId, "0xa4b1");
  assert.equal(reg.get(rec.id).state, "arriving");
  assert.equal(reg.get(rec.id).requestId, review.requestId);
  off();
});

test("R2) 🔴 move-out (Spot → Main Account): executeMoveOut with signAvaxTypedData — Privy's SHOWN sign hook, the decoded words, then the permit POST, 'arriving'", async () => {
  const fx = fixtureFor("live-move-out-2.json");
  /* Re-timed the way a fresh quote is: the recorded deadline has passed on this clock. */
  const nowS = Math.floor(Date.now() / 1000);
  fx.response.steps[0].items[0].data.sign.value.validBefore = nowS + 600;
  const review = MO.parseMoveOutQuote(fx.response, { own: OWN, amountRaw: "2000000", now: Date.now() });
  const { off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const storage = new MemStorage();
  const reg = registry(storage, () => Date.now());
  const rec = reg.begin({ kind: "move-out", amounts: { in: "2" } });
  assert.equal(reg.confirm(rec.id).ok, true);
  const posts = [];
  const r = await MO.executeMoveOut({
    review, ownNow: () => s.own, flow: reg.handle(rec.id), now: () => Date.now(), timers,
    signTypedData: (td) => s.signAvaxTypedData(td, { review }),
    fetchImpl: async (url, init) => { posts.push([String(url).replace(/\?.*/, ""), JSON.parse(init.body)]); return { ok: true, status: 200 }; },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(privy.sign.length, 1);
  const [input, opts, which] = privy.sign[0];
  assert.equal(which, 1, "the SHOWN signTypedData hook");
  assert.equal(opts.uiOptions.showWalletUIs, true);
  assert.match(opts.uiOptions.description, /^Move 2 USDC to your Main Account\. At least [\d.]+ USDC arrives\.$/);
  assert.equal(input.primaryType, "ReceiveWithAuthorization");
  assert.equal(input.domain.chainId, 43114);
  assert.equal(input.message.from.toLowerCase(), OWN);
  assert.equal(input.message.value, "2000000");
  assert.deepEqual(posts.map((p) => p[0]), ["https://api.relay.link/execute/permits"]);
  assert.equal(reg.get(rec.id).state, "arriving");
  /* A signature over another review is never asked for. */
  const other = MO.parseMoveOutQuote(fx.response, { own: OWN, amountRaw: "2000000", now: Date.now() });
  await assert.rejects(() => s.signAvaxTypedData(review.signatures[0].typedData, { review: { ...other, amountRaw: "3000000" } }), (e) => e.code === "refused");
  assert.equal(privy.sign.length, 1);
  off();
});

test("R3) 🔴 swap USDC → BTC.b and back: executeSwap with sendAvaxTx — approve then swap, each through the SHOWN hook with the decoded minimum; the way back is an exit", async () => {
  const run = async (name) => {
    const fx = fixtureFor(name);
    const j = fx.response;
    const b = fx.body || {};
    const review = SD.parseSwapQuote(j, {
      own: OWN, from: b.originCurrency || j.details.currencyIn.currency.address, to: b.destinationCurrency || j.details.currencyOut.currency.address,
      amountRaw: b.amount || j.details.currencyIn.amount, now: Date.now(),
    });
    const { off } = signIn(OWN);
    const s = Rig.getAvaxSigners();
    const storage = new MemStorage();
    const reg = registry(storage, () => Date.now());
    const rec = reg.begin({ kind: "swap", amounts: SW.swapEnvelope(review) });
    assert.equal(reg.confirm(rec.id).ok, true);
    const r = await SW.executeSwap({
      review, ownNow: () => s.own, maxFeePerGasWei: 11n * GWEI, flow: reg.handle(rec.id), now: () => Date.now(),
      sendTx: (tx, o) => s.sendAvaxTx(tx, { ...o, check: { kind: "swap", review, index: review.txs.findIndex((t) => t.purpose === tx.purpose) } }),
      waitReceipt: async () => ({ status: 1 }),
      preflight: async () => ({ ok: true }),
    });
    const sent = privy.send.map(([input, opts, which]) => ({ to: input.to, which, shown: opts.uiOptions.showWalletUIs, words: opts.uiOptions.description }));
    off();
    return { r, review, sent };
  };
  const there = await run("live-swap-usdc-btcb-2.json");
  assert.equal(there.r.ok, true, JSON.stringify(there.r));
  assert.equal(there.sent.length, 2);
  assert.ok(there.sent.every((x) => x.which === 1 && x.shown === true));
  assert.equal(there.sent[1].words, SD.swapWindowWords(there.review).swap);
  assert.match(there.sent[1].words, /^Swap 2 USDC for at least [\d.]+ BTC\.b$/);
  const back = await run("swap-q11-btcb-usdc.json");
  assert.equal(back.r.ok, true, JSON.stringify(back.r));
  assert.ok(back.sent.length >= 1 && back.sent.every((x) => x.shown === true));
  assert.match(back.sent.at(-1).words, /for at least [\d.]+ USDC$/);
});

test("R4) Stake and Unstake: approve exact + supply for own, then withdraw to own — three windows, the card's own sentences", async () => {
  const { off } = signIn(OWN);
  const s = Rig.getAvaxSigners();
  const steps = AT.buildSupplySteps({ own: OWN, amountRaw: 2000000n, allowanceRaw: 0n, fees: FEES });
  for (const st of steps) assert.equal(await s.sendAvaxTx(st.tx, { check: { kind: "aave" } }), HASH);
  const out = AT.buildWithdrawTx({ own: OWN, amountRaw: 2000000n, fees: { maxFeePerGas: 25n * GWEI, maxPriorityFeePerGas: GWEI } });
  assert.equal(await s.sendAvaxTx(out, { check: { kind: "aave" } }), HASH, "the exit may pay a fee spike");
  assert.deepEqual(privy.send.map(([, o]) => o.uiOptions.description), [
    AT.aaveTxSummary(AT.decodeAaveTx(steps[0].tx, OWN)),
    AT.aaveTxSummary(AT.decodeAaveTx(steps[1].tx, OWN)),
    AT.aaveTxSummary(AT.decodeAaveTx(out, OWN)),
  ], "the window and the card say the same sentence");
  off();
});

/* ════════════════════════════════════════════════════════════════════════════
   C. THE PIECES AROUND IT
   ════════════════════════════════════════════════════════════════════════════ */

test("C1) Privy's chains: Arbitrum first and the default, Avalanche listed with lib/avax/config.js's own RPC (and in rpcConfig), Snowtrace", async () => {
  fakeBrowser();
  const MOUNT = "src/components/privy/PrivyMount.jsx";
  const M = await bundle({ entry: MOUNT, env: { VITE_PRIVY_APP_ID: "app" }, stubs: autoStubs([MOUNT], { keep: ["viem", "src/lib/avax/config.js", "src/services/privy.js"] }) });
  assert.equal(M.PRIVY_CHAINS.defaultChain.id, 42161);
  assert.deepEqual(M.PRIVY_CHAINS.supportedChains.map((c) => c.id), [42161, 43114]);
  const av = M.avalancheChain;
  assert.equal(av.rpcUrls.default.http[0], CFG.AVAX_RPC);
  assert.equal(av.rpcUrls.public.http[0], CFG.AVAX_RPC);
  assert.equal(av.rpcUrls.default.http[0], "https://api.avax.network/ext/bc/C/rpc");
  assert.deepEqual(av.nativeCurrency, { name: "Avalanche", symbol: "AVAX", decimals: 18 });
  assert.equal(av.blockExplorers.default.url, "https://snowtrace.io");
  assert.deepEqual(M.PRIVY_CHAINS.rpcConfig, { rpcUrls: { 43114: CFG.AVAX_RPC } });
  /* And the provider is handed exactly that. */
  const el = M.default();
  assert.equal(el.props.config.defaultChain.id, 42161);
  assert.deepEqual(el.props.config.supportedChains.map((c) => c.id), [42161, 43114]);
  assert.equal(el.props.config.rpcConfig.rpcUrls[43114], CFG.AVAX_RPC);
  assert.equal(el.props.config.embeddedWallets.showWalletUIs, true, "windows stay pinned on");
});

test("C2) 🔴 nothing in src/ switches the wallet to Avalanche; nothing new asks Privy for no window", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(jsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  for (const f of walk(path.join(ROOT, "src"))) {
    const c = code(path.relative(ROOT, f));
    assert.doesNotMatch(c, /switchChain\(\s*(43114|0xa86a|AVAX_CHAIN_ID|avalanche)/i, f);
  }
  for (const f of ["src/avax/signers.js", "src/avax/closedTx.js", "src/services/privy.js", "src/lib/signCopy.js", "src/components/privy/PrivyMount.jsx"]) {
    assert.doesNotMatch(code(f), /showWalletUIs\s*:\s*false/, f);
  }
});

test("C3) the limits table (src/avax/limits.js): the Avax constants are the money layer's own objects; env lowers, never raises; garbage is the hard cap; stake cap == aaveTx's", () => {
  assert.equal(GR.GAS_LIMITS, GAS.GAS_LIMITS);
  assert.equal(GR.EXIT_RESERVE_WEI, GAS.EXIT_RESERVE_WEI);
  assert.equal(GR.SWAP_BACK_RESERVE_WEI, GAS.SWAP_BACK_RESERVE_WEI);
  assert.equal(GR.MAX_FEE_GWEI_NON_EXIT, GAS.MAX_FEE_GWEI_NON_EXIT);
  assert.equal(GR.TOPUP_USD, GAS.TOPUP_USD);
  assert.equal(GR.SWAP_LIMITS, SW.SWAP_LIMITS);
  assert.equal(GR.MONEY_CARD_TTL_MS, FL.MONEY_CARD_TTL_MS);
  assert.equal(BigInt(GR.HARD.stakeUsdc) * 10n ** 6n, AT.AAVE_SUPPLY_HARD_CAP_RAW, "HARD.stakeUsdc == aaveTx.AAVE_SUPPLY_HARD_CAP_RAW");
  assert.equal(GR.HARD.moveUsdc, MI.HARD_MAX_MOVE_USDC);
  assert.equal(GR.HARD.swapUsd, SW.SWAP_LIMITS.maxUsd);
  const L = (env) => GR.resolveLimits(env);
  assert.deepEqual([L({}).stakeUsdc, L({}).moveUsdc, L({}).swapUsd], [20, 20, 20]);
  assert.deepEqual([L({ VITE_MAX_STAKE_USDC: "50" }).stakeUsdc, L({ VITE_MAX_MOVE_USDC: "50" }).moveUsdc, L({ VITE_MAX_SWAP_USD: "99" }).swapUsd], [20, 20, 20], "never raised");
  assert.deepEqual([L({ VITE_MAX_STAKE_USDC: "5" }).stakeUsdc, L({ VITE_MAX_MOVE_USDC: "2.5" }).moveUsdc, L({ VITE_MAX_SWAP_USD: "3" }).swapUsd], [5, 2.5, 3], "lowered");
  for (const junk of ["abc", "NaN", "20%", "", " ", null, undefined, {}]) {
    assert.equal(L({ VITE_MAX_STAKE_USDC: junk }).stakeUsdc, 20, String(junk));
    assert.equal(L({ VITE_MAX_MOVE_USDC: junk }).moveUsdc, 20, String(junk));
    assert.equal(L({ VITE_SWAP_MAX_LOSS_PCT: junk }).swapMaxLossPct, 2, String(junk));
  }
  assert.equal(L({ VITE_MAX_MOVE_USDC: "0" }).moveUsdc, 0, "0 turns moves off");
  assert.equal(L({ VITE_SWAP_SLIPPAGE_BPS: "500" }).swapSlippageBps, 100);
  assert.equal(L({ VITE_SWAP_SLIPPAGE_BPS: "50" }).swapSlippageBps, 50);
  assert.equal(L({ VITE_SWAP_SLIPPAGE_BPS: "50" }).swapStableSlippageBps, 30);
  assert.equal(L({ VITE_SWAP_SLIPPAGE_BPS: "20" }).swapStableSlippageBps, 20);
  assert.ok(Object.isFrozen(L({})));
});

test("C4) the window words are the card's: Aave == aaveTxSummary, the move-in names the debit and the gas the card prints, the move-out names the minimum", () => {
  for (const [kind, amountRaw] of [["approve", 2000000n], ["supply", 2500000n], ["withdraw", 10000000n]]) {
    const tx = kind === "approve" ? AT.buildApproveTx({ own: OWN, amountRaw, fees: FEES })
      : kind === "supply" ? AT.buildSupplyTx({ own: OWN, amountRaw, fees: FEES }) : AT.buildWithdrawTx({ own: OWN, amountRaw, fees: FEES });
    const d = AT.decodeAaveTx(tx, OWN);
    assert.equal(CT.avaxTxFromRequest(tx, { kind: "aave" }, OWN).words.description, AT.aaveTxSummary(d), kind);
  }
  const review = moveInReview();
  const w = SC.ownMoveSignWords(review);
  assert.equal(w.deposit.primaryType, "HyperliquidTransaction:SendAsset");
  assert.equal(w.deposit.description, "Move 6 USDC to your Spot Account. 6.342288 USDC leaves your Main Account. It includes ≈0.0315 AVAX for gas (≈$0.30).");
  assert.ok(review.gasRow.text.includes("≈0.0315 AVAX ($0.30)"), "the same AVAX figure the card's Gas for later row prints");
  assert.equal(w.authorize.description, "Authorizing 6.342288 USDC out of your Main Account. Next, you confirm the move itself.");
  assert.equal(w.authorize.method, "eth_signTypedData_v4");
  const plain = SC.ownMoveSignWords({ ...review, topup: null });
  assert.equal(plain.deposit.description, "Move 6 USDC to your Spot Account. 6.342288 USDC leaves your Main Account.");
  const mo = SC.moveOutSignWords({ amount: "2", minimum: "1.903408" });
  assert.equal(mo.permit.description, "Move 2 USDC to your Main Account. At least 1.903408 USDC arrives.");
  assert.equal(SC.moveOutSignWords({ amount: "2", minimum: null }).permit.description, "Move 2 USDC to your Main Account.", "no clause over a figure nobody has");
  for (const words of [w.authorize, w.deposit, mo.permit, mo.authorize]) {
    assert.doesNotMatch(words.description, /—|Relay|Hyperliquid|undefined|null|NaN/);
  }
});

test("C5) the pins agree: the depository the signers pin is the Avax track's (config.js == relayPins.js), and a move mid-deposit reads 'sending', not unknown", () => {
  assert.equal(CFG.RELAY_HL_DEPOSITORY, DEPOSITORY);
  assert.equal(PINS.HL_DEPOSITORY, DEPOSITORY);
  assert.match(code("src/avax/signers.js"), /depository:\s*RELAY_HL_DEPOSITORY/);
  assert.equal(WD.INTENT_STATUS.depositing, "sending");
  assert.equal(realNetworkAttempts, 0);
});
