/**
 * test-perp-sendasset — WITHDRAWING THROUGH RELAY, AND ONLY WHAT THE USER ASKED.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-22: "ขาออกแพงชิบหาย" / "มันถูกสัสๆเลย Relay อะ Hypercore > ออกมา" /
 * "แล้วมันควรต้องออกได้หลายเชนด้วยนะ" / "withdraw คือให้ใส่ เลข Wallet ได้ด้วยดิวะ".
 *
 * A Relay withdrawal is two signatures, both from the LIVE quote: Relay's own
 * authorize message, and a Hyperliquid sendAsset that moves the Perp USDC to
 * Relay's depository. Nothing about either is hard-coded in our source — which
 * is exactly why the exchange layer has to refuse a step that is not the one
 * the user asked for. This file is that gate's test, against a REAL recorded
 * quote (scripts/fixtures/relay-withdraw-quote.json: 5 USDC out to Arbitrum,
 * taken 2026-09-22, addresses are the burn address).
 *
 *   G. the gate (relayOut.js): the recorded step passes; a tampered amount,
 *      asset, dex, sub-account, network, type list, nonce or wallet does not
 *   A. the action (master.js): Hyperliquid's own field list and order, and a
 *      signature the network recovers as the user's — signed offline
 *   T. the trader (client.js) against a FAKE Hyperliquid: one POST, the silent
 *      signer never asked, a lost reply that is "Not confirmed" and not retried
 *   W. withdraw3 keeps working, now to an address the user confirmed: EIP-55
 *      checked, never re-cased, never defaulted to the wallet inside the
 *      exchange layer
 *
 * Money safety: every signature is made OFFLINE with the official Python SDK's
 * published test key, the global fetch throws, and no /exchange call leaves the
 * process.
 *
 * Run: node --test scripts/test-perp-sendasset.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { code } from "./lib/perpLiveHarness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (rel) => path.join(ROOT, rel);
const imp = (rel) => import(pathToFileURL(P(rel)).href);

let realNetworkAttempts = 0;
globalThis.fetch = () => { realNetworkAttempts++; throw new Error("test-perp-sendasset: a real network call was attempted"); };

const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const PY_ADDRESS = "0x14791697260E4c9A71f18484C9f997B308e59325";
const T0 = 1_700_000_000_000;

const QUOTE = JSON.parse(fs.readFileSync(P("scripts/fixtures/relay-withdraw-quote.json"), "utf8"));
/* The wallet the recorded quote was made for. */
const QUOTE_USER = QUOTE.request.user;
const stepOf = (id) => JSON.parse(JSON.stringify(QUOTE.steps.find((s) => s.id === id)));
const NONCE = QUOTE.steps.find((s) => s.id === "deposit").items[0].data.nonce;

let R, M, C, N, S, viem, viemAccounts;
before(async () => {
  R = await imp("src/lib/hyperliquid/exchange/relayOut.js");
  M = await imp("src/lib/hyperliquid/exchange/master.js");
  C = await imp("src/lib/hyperliquid/exchange/client.js");
  N = await imp("src/lib/hyperliquid/exchange/network.js");
  S = await imp("src/lib/hyperliquid/exchange/signing.js");
  viem = await import("viem");
  viemAccounts = await import("viem/accounts");
});

const MAIN = () => N.hlNetworkProfile("mainnet");
const readDeposit = (step, over = {}) => R.readRelayDepositStep(step, { profile: MAIN(), amountUsdc: "5", master: QUOTE_USER, now: NONCE, ...over });

/* ════════════════════════════════════════════════════════════════════════════
   G. THE GATE
   ════════════════════════════════════════════════════════════════════════════ */

test("G1) 🔴 the REAL recorded quote passes, and every field comes from it — including Relay's depository", () => {
  const r = readDeposit(stepOf("deposit"));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.fields, {
    destination: "0x66cf0aace1b4e562593bec10ec7868fba9932224",
    sourceDex: "",
    destinationDex: "",
    token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
    amount: "5",
    fromSubAccount: "",
    nonce: NONCE,
  });
  assert.equal(r.check.endpoint, `/intents/status/v3?requestId=${QUOTE.requestId}`);
  const src = code("src/lib/hyperliquid/exchange/relayOut.js");
  assert.doesNotMatch(src, /0x66cf0aace1b4e562593bec10ec7868fba9932224/i, "the depository must never be hard-coded");
});

test("G2) 🔴 the amount is the one the user typed, to the last decimal — never the quote's own", () => {
  assert.equal(readDeposit(stepOf("deposit"), { amountUsdc: "5.000000" }).ok, true, "the same number written differently");
  assert.equal(readDeposit(stepOf("deposit"), { amountUsdc: 5 }).ok, true);
  for (const wrong of ["5.000001", "4.999999", "50", "0.5", "", null]) {
    const r = readDeposit(stepOf("deposit"), { amountUsdc: wrong });
    assert.equal(r.ok, false, `accepted ${wrong}`);
    assert.equal(r.code, "amount_mismatch");
  }
  const step = stepOf("deposit");
  step.items[0].data.action.parameters.amount = "50.000000";
  assert.equal(readDeposit(step).code, "amount_mismatch", "a quote for ten times the amount is refused");
});

test("G3) 🔴 only USDC out of the Perp account itself: another asset, another dex, a sub-account, another network", () => {
  const edit = (fn) => { const s = stepOf("deposit"); fn(s.items[0].data.action.parameters); return readDeposit(s); };
  assert.equal(edit((p) => { p.token = "PURR:0xc4bf3f870c0e9465323c0b6ed28096c2"; }).code, "not_usdc");
  assert.equal(edit((p) => { p.token = "USDC:0x0000000000000000000000000000dead"; }).code, "not_usdc", "USDC's own token id, not just the name");
  assert.match(edit((p) => { p.sourceDex = "spot"; }).message, /somewhere other than your Perp account/);
  assert.equal(edit((p) => { p.destinationDex = "vault"; }).code, "bad_quote");
  assert.equal(edit((p) => { p.fromSubAccount = `0x${"5".repeat(40)}`; }).code, "bad_quote");
  assert.equal(edit((p) => { p.hyperliquidChain = "Testnet"; }).code, "wrong_network");
  assert.equal(edit((p) => { p.destination = QUOTE_USER; }).code, "bad_quote", "a transfer back to the user's own account is not a withdrawal");
  assert.equal(edit((p) => { p.destination = "not an address"; }).code, "bad_quote");
});

test("G4) 🔴 the step's own type list must be Hyperliquid's, field for field and in order", () => {
  const swap = () => {
    const s = stepOf("deposit");
    const list = s.items[0].data.eip712Types["HyperliquidTransaction:SendAsset"];
    [list[1], list[4]] = [list[4], list[1]];
    return readDeposit(s);
  };
  assert.equal(swap().code, "bad_quote");
  const retyped = stepOf("deposit");
  retyped.items[0].data.eip712Types["HyperliquidTransaction:SendAsset"][7].type = "uint256";
  assert.equal(readDeposit(retyped).code, "bad_quote");
  const renamed = stepOf("deposit");
  renamed.items[0].data.eip712PrimaryType = "HyperliquidTransaction:Withdraw";
  assert.equal(readDeposit(renamed).code, "bad_quote");
  const wrongAction = stepOf("deposit");
  wrongAction.items[0].data.action.type = "withdraw3";
  assert.equal(readDeposit(wrongAction).code, "bad_quote");
  const wrongKind = stepOf("deposit");
  wrongKind.kind = "signature";
  assert.equal(readDeposit(wrongKind).code, "bad_quote");
  const two = stepOf("deposit");
  two.items.push(two.items[0]);
  assert.equal(readDeposit(two).code, "bad_quote", "a withdrawal has exactly one deposit item");
});

test("G5) a quote left open too long is refused here rather than by Hyperliquid", () => {
  assert.equal(readDeposit(stepOf("deposit"), { now: NONCE + 3 * 86_400_000 }).code, "quote_expired");
  assert.equal(readDeposit(stepOf("deposit"), { now: NONCE - 2 * 86_400_000 }).code, "quote_expired");
  assert.equal(readDeposit(stepOf("deposit"), { now: NONCE + 86_000_000 }).ok, true, "inside Hyperliquid's window");
  const mismatched = stepOf("deposit");
  mismatched.items[0].data.nonce = NONCE + 1;
  assert.equal(readDeposit(mismatched).code, "bad_quote", "the step's two nonces must agree");
});

test("G6) the authorize step is passed through EXACTLY as Relay wrote it, and only for this wallet", () => {
  const step = stepOf("authorize");
  const r = R.readRelayAuthorizeStep(step, { master: QUOTE_USER });
  assert.equal(r.ok, true, JSON.stringify(r));
  const sign = step.items[0].data.sign;
  assert.deepEqual(r.typedData, { domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message: sign.value });
  assert.deepEqual(r.post, step.items[0].data.post);
  assert.equal(r.typedData.domain.name, "RelayNonceMapping");

  const foreign = stepOf("authorize");
  foreign.items[0].data.sign.value.wallet = `0x${"9".repeat(40)}`;
  assert.equal(R.readRelayAuthorizeStep(foreign, { master: QUOTE_USER }).code, "wallet_mismatch");
  const notEip712 = stepOf("authorize");
  notEip712.items[0].data.sign.signatureKind = "eip191";
  assert.equal(R.readRelayAuthorizeStep(notEip712, { master: QUOTE_USER }).code, "bad_quote");
  const noPost = stepOf("authorize");
  delete noPost.items[0].data.post;
  assert.equal(R.readRelayAuthorizeStep(noPost, { master: QUOTE_USER }).code, "bad_quote");
  const offsite = stepOf("authorize");
  offsite.items[0].data.post.endpoint = "https://example.com/authorize";
  assert.equal(R.readRelayAuthorizeStep(offsite, { master: QUOTE_USER }).code, "bad_quote", "the endpoint is a path on Relay, never a URL of its choosing");
});

/* ════════════════════════════════════════════════════════════════════════════
   A. THE ACTION AND ITS SIGNATURE (offline)
   ════════════════════════════════════════════════════════════════════════════ */

test("A1) 🔴 the built action is Hyperliquid's sendAsset, and the network recovers the user from its signature", async () => {
  const read = readDeposit(stepOf("deposit"));
  const action = M.buildSendAssetAction({ profile: MAIN(), signatureChainId: "0xa86a", ...read.fields });
  assert.deepEqual(Object.keys(action), [
    "type", "signatureChainId", "hyperliquidChain", "destination", "sourceDex", "destinationDex",
    "token", "amount", "fromSubAccount", "nonce",
  ]);
  assert.equal(action.type, "sendAsset");
  assert.equal(action.hyperliquidChain, "Mainnet");

  const account = viemAccounts.privateKeyToAccount(PY_KEY);
  const wallet = { address: account.address, signTypedData: (td) => account.signTypedData(td) };
  const sig = await S.signUserSigned({ wallet, action, types: S.HL_USER_SIGNED_TYPES.sendAsset });
  const hex = `${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}`;
  const recovered = await viem.recoverTypedDataAddress({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 43114, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { "HyperliquidTransaction:SendAsset": [...S.HL_USER_SIGNED_TYPES.sendAsset["HyperliquidTransaction:SendAsset"]] },
    primaryType: "HyperliquidTransaction:SendAsset",
    message: action,
    signature: hex,
  });
  assert.equal(recovered.toLowerCase(), PY_ADDRESS.toLowerCase());
});

test("A2) 🔴 sendAsset can NEVER be signed with no window, whatever it is handed", () => {
  assert.equal(M.silentMasterAllowed("privy", "sendAsset"), false);
  assert.deepEqual([...M.HL_SILENT_MASTER_ACTIONS], ["approveAgent", "approveBuilderFee"]);
  const c = code("src/lib/hyperliquid/exchange/client.js");
  const relay = c.slice(c.indexOf("async signRelayAuthorize"), c.indexOf("async function doEnable"));
  assert.ok(relay.length > 200);
  assert.doesNotMatch(relay, /quiet|silentFor/, "the Relay path never reaches the no-window signer");
});

/* ════════════════════════════════════════════════════════════════════════════
   T. THE TRADER
   ════════════════════════════════════════════════════════════════════════════ */

function fakeWallet(key = PY_KEY) {
  const account = viemAccounts.privateKeyToAccount(key);
  const prompts = [];
  return {
    address: account.address,
    prompts,
    signer: {
      getAddress: async () => account.address,
      provider: { getNetwork: async () => ({ chainId: 42161n }) },
      signTypedData: async (domain, types, message) => {
        prompts.push({ domain, types, message });
        const primaryType = Object.keys(types)[0];
        return account.signTypedData({ domain, types, primaryType, message });
      },
    },
  };
}

function fakeHl({ reply = { status: "ok", response: { type: "default" } }, status = 200 } = {}) {
  const posts = [];
  return {
    posts,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (/\/exchange$/.test(url)) {
        posts.push(body);
        if (reply === "lost") throw new Error("network down");
        return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
      }
      return new Response(JSON.stringify({ time: T0, assetPositions: [], marginSummary: {}, crossMarginSummary: {}, withdrawable: "100" }), { status: 200 });
    },
  };
}

function memAgents() {
  return {
    status: () => ({ state: "none", address: null, validUntil: null, reason: null, persisted: false }),
    account: () => null, prepare: () => ({ address: `0x${"7".repeat(40)}`, agentName: "flowflow", validUntil: T0, persisted: false }),
    markApproved: () => true, discardPending: () => {}, markRejected: () => {}, clear: () => {},
    subscribe: () => () => {}, version: () => 1,
  };
}
const memNonces = () => ({ next: async () => T0 + 1, serverNow: () => NONCE, noteServerTime: () => {} });

function traderFor({ hl = fakeHl(), wallet = fakeWallet(), silent = null } = {}) {
  const t = C.createHlTrader({
    master: wallet.address, signer: wallet.signer, walletType: "privy", chainId: 42161, market: () => null,
    profile: MAIN(), silentSigner: silent, deps: { fetchImpl: hl.fetchImpl, agents: memAgents(), nonces: memNonces() },
  });
  return { t, hl, wallet };
}

/* The recorded step, re-addressed to the test wallet (the quote's own user is the burn address). */
function depositStepFor(address) {
  const s = stepOf("deposit");
  return s;
}

test("T1) 🔴 the deposit step is signed VISIBLY and posted ONCE, exactly as the quote wrote it", async () => {
  const wallet = fakeWallet();
  const silentCalls = [];
  const ctx = traderFor({
    wallet,
    silent: () => ({ address: wallet.address, signTypedData: (td) => { silentCalls.push(td); return `0x${"11".repeat(65)}`; } }),
  });
  const step = depositStepFor(wallet.address);
  step.items[0].data.action.parameters.destination = "0x66cf0aace1b4e562593bec10ec7868fba9932224";
  const r = await ctx.t.sendRelayDeposit({ step, amountUsdc: "5" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctx.hl.posts.length, 1);
  assert.equal(ctx.hl.posts[0].action.type, "sendAsset");
  assert.equal(ctx.hl.posts[0].action.destination, "0x66cf0aace1b4e562593bec10ec7868fba9932224");
  assert.equal(ctx.hl.posts[0].action.amount, "5");
  assert.equal(ctx.hl.posts[0].nonce, NONCE);
  /* A Privy wallet signs for Arbitrum, where FlowFlow parks it, whatever else it touched (client.js masterGate). */
  assert.equal(ctx.hl.posts[0].action.signatureChainId, "0xa4b1");
  assert.equal(wallet.prompts.length, 1, "the user saw exactly one prompt");
  assert.equal(silentCalls.length, 0, "the no-window signer was never asked to move money");
  assert.equal(r.amountUsdc, "5");
  assert.equal(r.check.endpoint, `/intents/status/v3?requestId=${QUOTE.requestId}`);
});

test("T2) 🔴 a lost reply is Not confirmed, with no Try again, and is never sent twice", async () => {
  const wallet = fakeWallet();
  const ctx = traderFor({ wallet, hl: fakeHl({ reply: "lost" }) });
  const r = await ctx.t.sendRelayDeposit({ step: depositStepFor(wallet.address), amountUsdc: "5" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_confirmed");
  assert.equal(r.retry, false);
  assert.match(r.message, /NOT sent twice/);
  assert.equal(ctx.hl.posts.length, 1);
});

test("T3) a refused step never reaches the wallet at all", async () => {
  const wallet = fakeWallet();
  const ctx = traderFor({ wallet });
  const r = await ctx.t.sendRelayDeposit({ step: depositStepFor(wallet.address), amountUsdc: "6" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "amount_mismatch");
  assert.equal(wallet.prompts.length, 0);
  assert.equal(ctx.hl.posts.length, 0);
});

test("T4) the authorize step: one visible prompt, the 65-byte signature, and Relay's own post details", async () => {
  const wallet = fakeWallet();
  const ctx = traderFor({ wallet });
  const step = stepOf("authorize");
  for (const k of Object.keys(step.items[0].data.sign.value)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(step.items[0].data.sign.value[k])) step.items[0].data.sign.value[k] = wallet.address;
  }
  const r = await ctx.t.signRelayAuthorize(step);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(r.post.endpoint, "/authorize");
  assert.equal(r.post.method, "POST");
  assert.equal(wallet.prompts.length, 1);
  assert.equal(wallet.prompts[0].domain.name, "RelayNonceMapping");
  assert.equal(ctx.hl.posts.length, 0, "nothing of Relay's is posted to Hyperliquid");
  const recovered = await viem.recoverTypedDataAddress({
    domain: step.items[0].data.sign.domain,
    types: step.items[0].data.sign.types,
    primaryType: step.items[0].data.sign.primaryType,
    message: step.items[0].data.sign.value,
    signature: r.signature,
  });
  assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
});

/* ════════════════════════════════════════════════════════════════════════════
   W. WITHDRAW3, TO AN ADDRESS THE USER CONFIRMED
   ════════════════════════════════════════════════════════════════════════════ */

test("W1) 🔴 EIP-55: all-lowercase is taken as given, a mixed-case address must pass its checksum, and nothing is re-cased", () => {
  const checksummed = viem.getAddress(`0x${"ab".repeat(20)}`);
  const ok = M.readDestinationAddress(checksummed);
  assert.equal(ok.ok, true);
  assert.equal(ok.address, checksummed, "the address is kept exactly as the user pasted it");
  assert.equal(ok.lower, checksummed.toLowerCase());
  assert.equal(M.readDestinationAddress(checksummed.toLowerCase()).ok, true, "all-lowercase carries no checksum to fail");
  assert.equal(M.readDestinationAddress(`0x${checksummed.slice(2).toUpperCase()}`).ok, true, "all-uppercase neither");
  const broken = `${checksummed.slice(0, -1)}${checksummed.slice(-1) === "A" ? "a" : "A"}`;
  assert.equal(M.readDestinationAddress(broken).code, "bad_checksum");
  for (const bad of ["", "0x", "0x1234", `0x${"z".repeat(40)}`, PY_ADDRESS.slice(2), null, 42]) {
    assert.equal(M.readDestinationAddress(bad).code, "bad_address", String(bad));
  }
  assert.equal(M.readDestinationAddress(`0x${"0".repeat(40)}`).code, "burn_address");
  assert.equal(M.readDestinationAddress("0x000000000000000000000000000000000000dEaD").code, "burn_address");
  assert.equal(M.readDestinationAddress("  " + checksummed + "  ").ok, true, "pasted with spaces around it");
});

test("W2) 🔴 the exchange layer never picks the destination itself", async () => {
  const wallet = fakeWallet();
  const ctx = traderFor({ wallet });
  const none = await ctx.t.withdraw(25);
  assert.equal(none.ok, false);
  assert.equal(none.code, "no_destination");
  assert.equal(ctx.hl.posts.length, 0);
  assert.equal(wallet.prompts.length, 0);
  const bad = await ctx.t.withdraw(25, { destination: "0xnope" });
  assert.equal(bad.code, "bad_address");
  const other = viem.getAddress(`0x${"cd".repeat(20)}`);
  const r = await ctx.t.withdraw(25, { destination: other });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctx.hl.posts[0].action.type, "withdraw3");
  assert.equal(ctx.hl.posts[0].action.destination, other.toLowerCase(), "the action carries it lowercase, as Hyperliquid takes it");
  assert.equal(r.destination, other, "and the answer gives it back exactly as it was confirmed");
  assert.equal(wallet.prompts.length, 1);
});

test("W3) the seam fills in the user's OWN address when a screen has not asked for one, and passes a pasted one through", async () => {
  const B = await imp("src/perp/live/perpBackend.js");
  const calls = [];
  const trader = {
    master: PY_ADDRESS.toLowerCase(),
    withdraw: async (amount, opts) => { calls.push([amount, opts]); return { ok: true }; },
  };
  const actions = B.createLiveActions({ trader, locks: new Set() });
  await actions.withdraw("10");
  await actions.withdraw("10", { destination: "0x1111111111111111111111111111111111111111" });
  assert.deepEqual(calls, [
    ["10", { destination: PY_ADDRESS.toLowerCase() }],
    ["10", { destination: "0x1111111111111111111111111111111111111111" }],
  ]);
  assert.equal(realNetworkAttempts, 0);
});
