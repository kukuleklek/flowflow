/**
 * test-perp-silent-enable — Enable trading is INVISIBLE for a Privy login.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner (2026-09-22): "ต้องเซ็น Enable Trading ด้วยหรอวะ". For a PRIVY user the
 * one-time approveAgent (and approveBuilderFee, only when the builder fee is
 * configured) is signed by the embedded wallet with NO Privy window
 * (useSignTypedData, uiOptions.showWalletUIs false) and AUTOMATICALLY on the
 * first trade. Injected wallets keep their visible prompt. Withdraw and key
 * export ALWAYS keep their prompt.
 *
 *   S. the master signer pick (master.js / signing.js): silent only for a Privy
 *      wallet, only for approveAgent and approveBuilderFee, never withdraw3;
 *   T. the trader (client.js) against a FAKE Hyperliquid (fetch injected, the
 *      global fetch is a thrower): the first open enables itself, once, then
 *      the order proceeds; must_deposit comes back as must_deposit; a key
 *      Hyperliquid pruned is re-approved once and the refused flow re-run; an
 *      injected wallet is unchanged; withdraw keeps the prompt;
 *   B. the bridge (PrivyBridge.jsx, services/privy.js), bundled with Privy
 *      stubbed: the silent signer is registered only in a Perp build, calls
 *      Privy with showWalletUIs false and refuses anything that is not one of
 *      the two approvals; the VISIBLE Avalanche pair (B7–B9) and the VISIBLE
 *      Base / Polygon Recover signer (B10–B11, B4b) sign only what their closed
 *      builders rebuild from the review, on the SHOWN hook, and add no hook
 *      call and no silent place (G1 still counts exactly two);
 *   H. the seam (usePerpBackend.js): a Privy trader gets the silent signer and
 *      the ticket sees trading as ready (no Enable step); an injected one does not;
 *   G. source guards (comments stripped).
 *
 * Money safety: every signature here is made OFFLINE with the official Python
 * SDK's published test key; nothing reaches the network.
 *
 * Run: node --test scripts/test-perp-silent-enable.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { code, autoStubs, bundle, fakeBrowser } from "./lib/perpLiveHarness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EX = (f) => pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/exchange", f)).href;

let realNetworkAttempts = 0;
globalThis.fetch = () => { realNetworkAttempts++; throw new Error("test-perp-silent-enable: a real network call was attempted"); };

/* The official Python SDK's public test key plays the user's wallet. */
const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x14791697260E4c9A71f18484C9f997B308e59325";
const OTHER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000abc";
const BUILDER = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const ZERO = "0x0000000000000000000000000000000000000000";

let C, N, S, M, A, NC, viem, viemAccounts, ethers;
before(async () => {
  C = await import(EX("client.js"));
  N = await import(EX("network.js"));
  S = await import(EX("signing.js"));
  M = await import(EX("master.js"));
  A = await import(EX("agentStore.js"));
  NC = await import(EX("nonce.js"));
  viem = await import("viem");
  viemAccounts = await import("viem/accounts");
  ethers = await import("ethers");
});

const MAIN = () => N.hlNetworkProfile("mainnet");

const MARKETS = {
  BTC: { coin: "BTC", assetIndex: 0, szDecimals: 5, maxLeverage: 40, midPx: 85721.5, markPx: 85720, px: 85721.5, onlyIsolated: false, marginMode: null },
  SOL: { coin: "SOL", assetIndex: 5, szDecimals: 2, maxLeverage: 20, midPx: 116.6953, markPx: 116.7, px: 116.6953, onlyIsolated: false, marginMode: null },
};

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

/* The VISIBLE path: an EIP-1193 wallet on Avalanche behind ethers' BrowserProvider
   (what WalletContext hands the trader). Every typed-data request here is a
   window the user sees; prompts counts them. */
function chainWallet(key = PY_KEY) {
  const account = viemAccounts.privateKeyToAccount(key);
  const prompts = [];
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0xa86a";
      if (method === "net_version") return "43114";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const data = JSON.parse(params[1]);
        prompts.push(data);
        return account.signTypedData({ domain: data.domain, types: data.types, primaryType: data.primaryType, message: data.message });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, prompts, address: account.address };
}

/* The SILENT path: what services/privy hands the trader for a Privy login — the
   embedded wallet's no-window typed-data signer. Signs offline with the test key. */
function privySilent(key = PY_KEY) {
  const account = viemAccounts.privateKeyToAccount(key);
  const calls = [];
  let fail = null;
  const signer = {
    address: account.address,
    async signTypedData(typedData) {
      calls.push(typedData);
      if (fail) throw fail;
      return account.signTypedData(typedData);
    },
  };
  return { calls, signer, resolve: () => signer, fail(e) { fail = e; }, address: account.address };
}

/* A fake Hyperliquid (the same one test-hl-exchange-client.mjs drives). */
function fakeHl(init = {}) {
  const profile = MAIN();
  const st = { positions: {}, openOrders: [], maxBuilderFee: 0, time: T0, nextOid: 9000, ...init };
  const posts = [];
  const infos = [];
  const script = init.script || {};
  const res = (obj, status = 200) => new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const defaultOrderReply = (body) => ({
    status: "ok",
    response: { type: "order", data: { statuses: body.action.orders.map((o) => ({ filled: { totalSz: o.s, avgPx: o.p, oid: st.nextOid++ } })) } },
  });
  async function fetchImpl(url, reqInit) {
    const body = JSON.parse(reqInit.body);
    if (url === profile.infoUrl) {
      infos.push(body);
      switch (body.type) {
        case "clearinghouseState":
          return res({
            assetPositions: Object.entries(st.positions).map(([coin, p]) => ({ type: "oneWay", position: { coin, szi: String(p.szi), leverage: { type: "isolated", value: p.leverage ?? 5, rawUsd: "0" }, entryPx: String(p.entryPx ?? 100), positionValue: "0", unrealizedPnl: "0", returnOnEquity: "0", liquidationPx: null, marginUsed: "0", maxLeverage: 40, cumFunding: {} } })),
            marginSummary: { accountValue: "100", totalNtlPos: "0", totalRawUsd: "100", totalMarginUsed: "0" },
            crossMarginSummary: { accountValue: "100", totalNtlPos: "0", totalRawUsd: "100", totalMarginUsed: "0" },
            crossMaintenanceMarginUsed: "0", withdrawable: "100", time: st.time,
          });
        case "frontendOpenOrders": return res(st.openOrders);
        case "maxBuilderFee": return res(st.maxBuilderFee);
        case "orderStatus": return res({ status: "unknownOid" });
        default: return res(null);
      }
    }
    if (url === profile.exchangeUrl) {
      posts.push(body);
      const h = script[body.action.type];
      const r = h ? h(body, st, posts) : undefined;
      if (r !== undefined) return res(r);
      if (body.action.type === "order") return res(defaultOrderReply(body));
      if (body.action.type === "cancel") return res({ status: "ok", response: { type: "cancel", data: { statuses: body.action.cancels.map(() => "success") } } });
      return res({ status: "ok", response: { type: "default" } });
    }
    throw new Error(`unexpected url ${url}`);
  }
  return { fetchImpl, posts, infos, st, profile };
}

let cloidSeq = 0;
const nextCloid = () => `0x${(++cloidSeq).toString(16).padStart(32, "0")}`;

async function trader({ hl = fakeHl(), wallet = chainWallet(), walletType = "privy", silent = privySilent(), builder = { address: "", feeTenthsBp: 0 }, now = () => T0, storage = memStorage() } = {}) {
  const signer = await new ethers.BrowserProvider(wallet.provider).getSigner();
  const agents = A.createAgentStore({ profile: MAIN(), storage, now });
  const nonces = NC.createNonceAllocator({ profile: MAIN(), storage, locks: null, now });
  const t = C.createHlTrader({
    master: MASTER, signer, walletType, chainId: 43114,
    market: (coin) => MARKETS[coin] || null,
    builder, profile: MAIN(),
    silentSigner: silent ? silent.resolve : null,
    deps: { fetchImpl: hl.fetchImpl, agents, nonces, randomCloid: nextCloid, now },
  });
  return { t, hl, wallet, silent, agents, nonces, storage, signer };
}

const sigHex = (s) => viem.serializeSignature({ r: s.r, s: s.s, v: BigInt(s.v) });

async function recoverL1(body) {
  const hash = S.hlActionHash({ action: body.action, nonce: body.nonce });
  return (await viem.recoverTypedDataAddress({
    domain: { ...S.HL_L1_DOMAIN },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent", message: { source: "a", connectionId: hash }, signature: sigHex(body.signature),
  })).toLowerCase();
}
async function recoverUser(body) {
  const types = S.HL_USER_SIGNED_TYPES[body.action.type];
  const primaryType = Object.keys(types)[0];
  const message = Object.fromEntries(types[primaryType].map((f) => [f.name, f.type === "uint64" ? BigInt(body.action[f.name]) : body.action[f.name]]));
  return (await viem.recoverTypedDataAddress({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: parseInt(body.action.signatureChainId, 16), verifyingContract: ZERO },
    types, primaryType, message, signature: sigHex(body.signature),
  })).toLowerCase();
}

/* THE NAME PRODUCTION SENDS, from the producer itself (agentStore). A stub
   name here is how the bridge's own cap on it went unnoticed: the real name is
   34 characters and every test signed a 22-character one. */
const approveAgentAction = () => M.buildApproveAgentAction({ profile: MAIN(), signatureChainId: "0xa86a", agentAddress: "0x" + "7".repeat(40), agentName: A.agentNameWithExpiry(T0 + DAY), nonce: T0 });
const withdrawAction = () => M.buildWithdrawAction({ profile: MAIN(), signatureChainId: "0xa86a", destination: MASTER, amount: "10", time: T0 });
const builderAction = () => M.buildApproveBuilderFeeAction({ profile: MAIN(), signatureChainId: "0xa86a", builder: BUILDER, maxFeeRate: "0.05%", nonce: T0 });

/* ════════════════════════════════════════════════════════════════════════════
   S. WHICH SIGNER SIGNS A MASTER ACTION
   ════════════════════════════════════════════════════════════════════════════ */

test("S1) a Privy wallet signs approveAgent with the SILENT signer: no window, and the signature is the master's", async () => {
  const w = chainWallet();
  const silent = privySilent();
  const signer = await new ethers.BrowserProvider(w.provider).getSigner();
  const action = approveAgentAction();
  const r = await M.signMasterAction({ signer, action, walletType: "privy", silent: silent.signer });
  assert.equal(silent.calls.length, 1, "the silent signer was not used");
  assert.equal(w.prompts.length, 0, "a Privy window was shown for approveAgent");
  assert.equal(r.silent, true);
  assert.equal(r.address, MASTER.toLowerCase());
  assert.equal(silent.calls[0].primaryType, "HyperliquidTransaction:ApproveAgent");
  assert.equal(silent.calls[0].domain.name, "HyperliquidSignTransaction");
  assert.equal(await recoverUser({ action, signature: r.signature }), MASTER.toLowerCase());
});

test("S2) approveBuilderFee is silent too (Enable trading's second approval)", async () => {
  const w = chainWallet();
  const silent = privySilent();
  const signer = await new ethers.BrowserProvider(w.provider).getSigner();
  const action = builderAction();
  const r = await M.signMasterAction({ signer, action, walletType: "privy", silent: silent.signer });
  assert.equal(r.silent, true);
  assert.equal(w.prompts.length, 0);
  assert.equal(await recoverUser({ action, signature: r.signature }), MASTER.toLowerCase());
});

test("S3) 🔴 withdraw3 NEVER goes silent, even for a Privy wallet handed a silent signer: the visible prompt signs", async () => {
  const w = chainWallet();
  const silent = privySilent();
  const signer = await new ethers.BrowserProvider(w.provider).getSigner();
  const action = withdrawAction();
  const r = await M.signMasterAction({ signer, action, walletType: "privy", silent: silent.signer });
  assert.equal(silent.calls.length, 0, "a withdrawal was signed with no window");
  assert.equal(w.prompts.length, 1);
  assert.equal(r.silent, false);
  assert.equal(await recoverUser({ action, signature: r.signature }), MASTER.toLowerCase());
});

test("S4) an injected wallet keeps its visible prompt for approveAgent, whatever it is handed", async () => {
  for (const walletType of ["metamask", "okx", "rabby", null]) {
    const w = chainWallet();
    const silent = privySilent();
    const signer = await new ethers.BrowserProvider(w.provider).getSigner();
    const r = await M.signMasterAction({ signer, action: approveAgentAction(), walletType, silent: silent.signer });
    assert.equal(silent.calls.length, 0, String(walletType));
    assert.equal(w.prompts.length, 1, String(walletType));
    assert.equal(r.silent, false);
  }
});

test("S5) the silent allowlist is exactly the two Enable trading approvals", () => {
  assert.deepEqual([...M.HL_SILENT_MASTER_ACTIONS], ["approveAgent", "approveBuilderFee"]);
  assert.equal(M.silentMasterAllowed("privy", "approveAgent"), true);
  assert.equal(M.silentMasterAllowed("privy", "approveBuilderFee"), true);
  assert.equal(M.silentMasterAllowed("privy", "withdraw3"), false);
  assert.equal(M.silentMasterAllowed("metamask", "approveAgent"), false);
  assert.equal(M.silentMasterAllowed("walletconnect", "approveAgent"), false);
});

test("S6) the silent signer is a MASTER wallet: it can never sign an L1 action (orders are the trading key's)", async () => {
  const silent = privySilent();
  const wrapped = S.typedSignerFromSilent(silent.signer);
  assert.equal(wrapped.address, MASTER.toLowerCase());
  await assert.rejects(
    () => S.signL1({ wallet: wrapped, action: { type: "cancel", cancels: [] }, nonce: T0, profile: MAIN() }),
    /never by the master wallet/,
  );
  assert.equal(silent.calls.length, 0);
  assert.throws(() => S.typedSignerFromSilent(null), /silent/i);
  assert.throws(() => S.typedSignerFromSilent({ address: "nope", signTypedData() {} }), /silent/i);
});

/* ════════════════════════════════════════════════════════════════════════════
   T. THE TRADER ENABLES ITSELF ON THE FIRST TRADE (Privy only)
   ════════════════════════════════════════════════════════════════════════════ */

test("T1) Privy, no trading key: the first open signs approveAgent SILENTLY, once, then the order proceeds — no window at all", async () => {
  const ctx = await trader();
  assert.equal(ctx.t.isTradingEnabled().enabled, false);
  assert.equal(ctx.t.isTradingEnabled().auto, true, "a Privy trader with a silent signer enables itself");
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ctx.hl.posts.map((b) => b.action.type), ["approveAgent", "updateLeverage", "order"]);
  assert.equal(await recoverUser(ctx.hl.posts[0]), MASTER.toLowerCase(), "the approval is the master's");
  const agent = ctx.hl.posts[0].action.agentAddress;
  assert.equal(await recoverL1(ctx.hl.posts[1]), agent, "the leverage change is the new trading key's");
  assert.equal(await recoverL1(ctx.hl.posts[2]), agent, "the order is the new trading key's");
  assert.equal(ctx.wallet.prompts.length, 0, "no Privy window");
  assert.equal(ctx.silent.calls.length, 1);
  assert.deepEqual(r.autoEnabled, { signatures: 1, validUntil: T0 + DAY, builderApproved: null });
  assert.equal(ctx.t.isTradingEnabled().enabled, true);
  const again = await ctx.t.openMarket({ coin: "SOL", side: "buy", marginUsdc: 20, leverage: 2 });
  assert.equal(again.ok, true);
  assert.equal(again.autoEnabled, undefined, "an active key trades without enabling again");
  assert.equal(ctx.hl.posts.filter((b) => b.action.type === "approveAgent").length, 1);
  assert.equal(realNetworkAttempts, 0);
});

test("T2) builder configured and not approved: approveAgent AND approveBuilderFee, both silent, then the order carries the builder", async () => {
  const hl = fakeHl({ maxBuilderFee: 0 });
  const ctx = await trader({ hl, builder: { address: BUILDER, feeTenthsBp: 50 } });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["approveAgent", "approveBuilderFee", "updateLeverage", "order"]);
  assert.equal(await recoverUser(hl.posts[1]), MASTER.toLowerCase());
  assert.deepEqual(hl.posts[3].action.builder, { b: BUILDER, f: 50 });
  assert.equal(ctx.wallet.prompts.length, 0);
  assert.equal(ctx.silent.calls.length, 2);
  assert.equal(r.autoEnabled.signatures, 2);
});

test("T3) two opens at once on two markets: ONE Enable (deduped), both orders proceed", async () => {
  const ctx = await trader();
  const [a, b] = await Promise.all([
    ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 }),
    ctx.t.openMarket({ coin: "SOL", side: "sell", marginUsdc: 20, leverage: 2 }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(ctx.hl.posts.filter((p) => p.action.type === "approveAgent").length, 1);
  assert.equal(ctx.hl.posts.filter((p) => p.action.type === "order").length, 2);
  assert.equal(ctx.silent.calls.length, 1);
});

test("T4) a brand-new address: the silent approval is refused with 'Must deposit', and the open answers must_deposit (the page's Deposit step); no order is sent", async () => {
  const hl = fakeHl({ script: { approveAgent: () => ({ status: "err", response: `Must deposit before performing actions. User: ${MASTER.toLowerCase()}` }) } });
  const ctx = await trader({ hl });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "must_deposit");
  assert.match(r.message, /[Dd]eposit/);
  assert.equal(r.needsEnable === true, false, "must_deposit is not an Enable trading step");
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["approveAgent"]);
  assert.equal(ctx.agents.status(MASTER).state, "none", "the unapproved key is thrown away");
  assert.equal(ctx.wallet.prompts.length, 0);
});

test("T5) an INJECTED wallet is unchanged: the open answers needs_enable with nothing signed or sent", async () => {
  for (const opts of [{ walletType: "metamask" }, { walletType: "metamask", silent: privySilent() }, { walletType: "privy", silent: null }]) {
    const ctx = await trader(opts);
    assert.equal(ctx.t.isTradingEnabled().auto, false, JSON.stringify(opts.walletType));
    const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
    assert.equal(r.code, "needs_enable");
    assert.equal(r.needsEnable, true);
    assert.equal(ctx.hl.posts.length, 0);
    assert.equal(ctx.wallet.prompts.length, 0);
    if (ctx.silent) assert.equal(ctx.silent.calls.length, 0);
  }
});

test("T6) a key Hyperliquid pruned mid-session: re-approved silently ONCE and the refused flow re-run; the order is sent exactly once", async () => {
  let refuse = 1;
  const hl = fakeHl({ script: { updateLeverage: () => (refuse-- > 0 ? { status: "err", response: `User or API Wallet ${"0x" + "ab".repeat(20)} does not exist.` } : undefined) } });
  const ctx = await trader({ hl });
  const first = await ctx.t.enableTrading();
  assert.equal(first.ok, true);
  hl.posts.length = 0;
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["updateLeverage", "approveAgent", "updateLeverage", "order"]);
  assert.notEqual(hl.posts[1].action.agentAddress, first.agentAddress, "never reuse an agent address");
  assert.equal(await recoverL1(hl.posts[3]), hl.posts[1].action.agentAddress);
  assert.equal(ctx.wallet.prompts.length, 0);
});

test("T7) pruned again after the re-approval: no loop — the refusal comes back as it is", async () => {
  const hl = fakeHl({ script: { updateLeverage: () => ({ status: "err", response: `User or API Wallet ${"0x" + "ab".repeat(20)} does not exist.` }) } });
  const ctx = await trader({ hl });
  await ctx.t.enableTrading();
  hl.posts.length = 0;
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "agent_missing");
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["updateLeverage", "approveAgent", "updateLeverage"]);
  assert.equal(hl.posts.filter((b) => b.action.type === "order").length, 0);
});

test("T8) an EXPIRED key before a close, and before a TP/SL move a day later: each enables itself silently first (a position outlives a 24-hour key)", async () => {
  let now = T0;
  const hl = fakeHl({ positions: { SOL: { szi: "-3.5", leverage: 4 } } });
  const ctx = await trader({ hl, now: () => now });
  await ctx.t.enableTrading();
  now = T0 + DAY;
  hl.st.time = now;
  assert.equal(ctx.t.isTradingEnabled().state, "expired");
  hl.posts.length = 0;
  const close = await ctx.t.closeFraction("SOL", 0.5);
  assert.equal(close.ok, true, JSON.stringify(close));
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["approveAgent", "order"]);
  assert.equal(close.autoEnabled.signatures, 1);
  now = T0 + 2 * DAY;
  hl.st.time = now;
  hl.posts.length = 0;
  const tpsl = await ctx.t.setTpSl("SOL", { sl: 130 });
  assert.equal(tpsl.ok, true, JSON.stringify(tpsl));
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["approveAgent", "order"]);
  assert.equal(ctx.wallet.prompts.length, 0);
  assert.equal(ctx.silent.calls.length, 3);
});

test("T9) 🔴 the silent signer answers for ANOTHER address: it is not used, and no Privy window opens in its place — the answer is a plain retry", async () => {
  const ctx = await trader({ silent: privySilent(OTHER_KEY) });
  const r = await ctx.t.enableTrading();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "wallet_not_ready");
  assert.equal(r.retry, true);
  assert.equal(ctx.silent.calls.length, 0, "a foreign approval is never signed");
  assert.equal(ctx.wallet.prompts.length, 0, "and Privy's own window is never opened on the enable path");
  assert.equal(ctx.hl.posts.length, 0, "nothing was sent");
});

test("T9b) a Privy login whose bridge has not registered yet: the same plain retry, never a window", async () => {
  const ctx = await trader({ silent: { calls: [], signer: null, resolve: () => null, address: MASTER } });
  const r = await ctx.t.enableTrading();
  assert.equal(r.ok, false);
  assert.equal(r.code, "wallet_not_ready");
  assert.equal(ctx.wallet.prompts.length, 0);
  assert.equal(ctx.hl.posts.length, 0);
});

test("T10) 🔴 withdraw on a Privy trader keeps Privy's window: the silent signer is never asked", async () => {
  const ctx = await trader();
  const r = await ctx.t.withdraw(25.5, { destination: MASTER });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ctx.hl.posts.map((b) => b.action.type), ["withdraw3"]);
  assert.equal(ctx.silent.calls.length, 0);
  assert.equal(ctx.wallet.prompts.length, 1);
  assert.equal(ctx.wallet.prompts[0].primaryType, "HyperliquidTransaction:Withdraw");
});

test("T11) a silent signing failure is the mapped error, the key is discarded, and no order is sent", async () => {
  const silent = privySilent();
  silent.fail(new Error("Embedded wallet is not ready"));
  const ctx = await trader({ silent });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "signature_failed");
  assert.match(r.message, /Embedded wallet is not ready/);
  assert.equal(ctx.hl.posts.length, 0);
  assert.equal(ctx.agents.status(MASTER).state, "none");
});

/* ════════════════════════════════════════════════════════════════════════════
   B. THE BRIDGE: PrivyBridge registers the silent signer, services/privy hands it out
   ════════════════════════════════════════════════════════════════════════════ */

const BRIDGE = "src/components/privy/PrivyBridge.jsx";
const SVC = "src/services/privy.js";
const EMBEDDED = "0x14791697260e4c9a71f18484c9f997b308e59325";

function typedDataFor(action) {
  const types = S.HL_USER_SIGNED_TYPES[action.type];
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 43114, verifyingContract: ZERO },
    types: { EIP712Domain: [{ name: "name", type: "string" }], ...types },
    primaryType: Object.keys(types)[0],
    message: action,
  };
}

/* `keep`: more of the bridge's own imports to bundle for real (the Avalanche pair's
   closed builders and the window options) — everything else it imports is a stub.
   Each hook instance knows its place in the render (`which`): with the Perp mode
   on, instance 0 of each hook is the SILENT pair and instance 1 the SHOWN one. */
async function mountBridge(env, { keep = [], address = EMBEDDED, impl = {} } = {}) {
  fakeBrowser();
  const calls = { sign: [], send: [], registered: [], hooks: [] };
  const seen = { sign: 0, send: 0 };
  globalThis.__impl = {
    usePrivy: () => { seen.sign = 0; seen.send = 0; return { ready: true, authenticated: true }; },
    useWallets: () => ({ wallets: [{ walletClientType: "privy", address }] }),
    useLogout: () => ({ logout: async () => {} }),
    useLogin: () => ({ login: () => {} }),
    useExportWallet: () => ({ exportWallet: async () => {} }),
    useSignTypedData: () => {
      calls.hooks.push("useSignTypedData");
      const which = seen.sign++;
      return { signTypedData: async (input, opts) => { calls.sign.push([input, opts, which]); return { signature: `0x${"11".repeat(65)}` }; } };
    },
    useSendTransaction: () => {
      calls.hooks.push("useSendTransaction");
      const which = seen.send++;
      return { sendTransaction: async (input, opts) => { calls.send.push([input, opts, which]); return { hash: `0x${"cd".repeat(32)}` }; } };
    },
    registerPrivyApi: (api) => calls.registered.push(api),
    privyChainId: () => 43114,
    ...impl,
  };
  const Mod = await bundle({ entry: BRIDGE, env, stubs: autoStubs([BRIDGE], { keep: ["src/lib/perpFlag.js", ...keep] }) });
  const h = Mod.mount(() => Mod.default());
  h.render(); h.flush();
  return { calls, h, api: () => calls.registered[calls.registered.length - 1] };
}

test("B1) Perp build: the bridge registers a silent signer for the EMBEDDED wallet that calls Privy with showWalletUIs false", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  assert.equal(typeof api.signTypedDataSilently, "function");
  assert.equal(api.embeddedAddress, EMBEDDED);
  assert.equal(api.exportWallet, undefined, "no key export is registered any more (owner, 2026-09-23)");
  const sig = await api.signTypedDataSilently(typedDataFor(approveAgentAction()), EMBEDDED);
  assert.equal(sig, `0x${"11".repeat(65)}`, "the bare hex signature, as the signing SDK reads it");
  assert.equal(b.calls.sign.length, 1);
  const [input, opts] = b.calls.sign[0];
  assert.deepEqual(opts, { address: EMBEDDED, uiOptions: { showWalletUIs: false } });
  assert.equal(input.primaryType, "HyperliquidTransaction:ApproveAgent");
  await api.signTypedDataSilently(typedDataFor(builderAction()), EMBEDDED);
  assert.equal(b.calls.sign.length, 2);
  b.h.unmount();
});

test("B2) 🔴 the bridge refuses to sign anything else silently: a withdrawal, a foreign domain, a permit", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  await assert.rejects(() => api.signTypedDataSilently(typedDataFor(withdrawAction()), EMBEDDED), /silent/i);
  const foreign = { ...typedDataFor(approveAgentAction()), domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO } };
  await assert.rejects(() => api.signTypedDataSilently(foreign, EMBEDDED), /silent/i);
  const permit = { domain: { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: BUILDER }, types: { Permit: [{ name: "owner", type: "address" }] }, primaryType: "Permit", message: { owner: EMBEDDED } };
  await assert.rejects(() => api.signTypedDataSilently(permit, EMBEDDED), /silent/i);
  await assert.rejects(() => api.signTypedDataSilently(null, EMBEDDED), /silent/i);
  assert.equal(b.calls.sign.length, 0, "Privy was never asked");
  b.h.unmount();
});

test("B2a) 🔴 THE REAL AGENT NAME signs with no window, whatever its length — and a name this app never asks for does not", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  /* The exact string the agent store builds, straight from the producer. */
  const real = A.agentNameWithExpiry(T0 + DAY);
  assert.equal(real.length, 34, "the name production sends is 34 characters; a cap below that refuses every real approval");
  const action = M.buildApproveAgentAction({ profile: MAIN(), signatureChainId: "0xa86a", agentAddress: "0x" + "7".repeat(40), agentName: real, nonce: T0 });
  await api.signTypedDataSilently(typedDataFor(action), EMBEDDED);
  assert.equal(b.calls.sign.length, 1, "the real Enable trading approval was refused a silent signature");
  assert.equal(b.calls.sign[0][0].message.agentName, real, "the name signed is the one the store built");
  /* Another app's agent, or a renamed one, is not ours to sign unseen. */
  for (const name of ["someone else valid_until 1700086400000", "flowflow", "flowflow valid_until", "flowflow valid_until abc", "flowflow valid_until 1700086400000 extra"]) {
    await assert.rejects(() => api.signTypedDataSilently(typedDataFor({ ...action, agentName: name }), EMBEDDED), /silent/i, name);
  }
  assert.equal(b.calls.sign.length, 1, "Privy was asked again for a name this app never sends");
  b.h.unmount();
});

test("B2b) 🔴 CLOSED BUILDERS: Privy is asked to sign what the bridge BUILT, not what it was handed — and that signature is the one Hyperliquid reads", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  const action = approveAgentAction();
  /* An extra field smuggled into the message, and a bogus EIP712Domain list. */
  const request = typedDataFor(action);
  request.message = { ...action, drainTo: "0x" + "9".repeat(40) };
  request.types = { ...request.types, Extra: [{ name: "x", type: "string" }] };
  await api.signTypedDataSilently(request, EMBEDDED);
  const [sent] = b.calls.sign[0];
  assert.deepEqual(Object.keys(sent.message), ["hyperliquidChain", "agentAddress", "agentName", "nonce"], "only the typed fields reach Privy");
  assert.deepEqual(Object.keys(sent.types).sort(), ["EIP712Domain", "HyperliquidTransaction:ApproveAgent"]);
  assert.deepEqual(sent.domain, { name: "HyperliquidSignTransaction", version: "1", chainId: 43114, verifyingContract: ZERO });

  /* What the bridge builds hashes to the same thing the signing SDK builds, so
     Hyperliquid recovers the same wallet from it. Signed offline, both ways. */
  const account = viemAccounts.privateKeyToAccount(PY_KEY);
  const sdk = typedDataFor(action);
  const mine = await account.signTypedData({ domain: sent.domain, types: sent.types, primaryType: sent.primaryType, message: sent.message });
  const theirs = await account.signTypedData({
    domain: sdk.domain, types: { ...S.HL_USER_SIGNED_TYPES[action.type] }, primaryType: sdk.primaryType, message: action,
  });
  assert.equal(mine, theirs, "the rebuilt typed data must hash exactly as the SDK's");
  b.h.unmount();
});

test("B2c) the builders check every field: a bad agent address, an empty name, a fee that is not a percent, a foreign chain id", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  const bad = (edit) => {
    const td = typedDataFor(approveAgentAction());
    return { ...td, ...edit };
  };
  await assert.rejects(() => api.signTypedDataSilently(bad({ message: { ...approveAgentAction(), agentAddress: "0x1234" } }), EMBEDDED), /silent/i);
  await assert.rejects(() => api.signTypedDataSilently(bad({ message: { ...approveAgentAction(), agentName: "" } }), EMBEDDED), /silent/i);
  await assert.rejects(() => api.signTypedDataSilently(bad({ message: { ...approveAgentAction(), nonce: -1 } }), EMBEDDED), /silent/i);
  await assert.rejects(() => api.signTypedDataSilently(bad({ message: { ...approveAgentAction(), hyperliquidChain: "Mainnet2" } }), EMBEDDED), /silent/i);
  await assert.rejects(() => api.signTypedDataSilently(bad({ domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 1, verifyingContract: ZERO } }), EMBEDDED), /silent/i);
  await assert.rejects(() => api.signTypedDataSilently(bad({ domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 43114, verifyingContract: BUILDER } }), EMBEDDED), /silent/i);
  const fee = typedDataFor(builderAction());
  await assert.rejects(() => api.signTypedDataSilently({ ...fee, message: { ...builderAction(), maxFeeRate: "0.05" } }, EMBEDDED), /silent/i);
  assert.equal(b.calls.sign.length, 0, "Privy was never asked");
  b.h.unmount();
});

test("B3) a build with the Perp mode OFF can ask for no signature at all, silent or otherwise", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "0" });
  const api = b.api();
  assert.equal("signTypedDataSilently" in api, false);
  assert.equal("embeddedAddress" in api, false);
  assert.equal("sendPerpFunding" in api, false, "nothing of the first-deposit hop ships in a flag-off build");
  /* 🔴 EXACTLY TWO HOOK CALLS, AND BOTH ARE THE VISIBLE PAIR. Since
     2026-09-30 the bridge also asks Privy for the pair that carries a money
     window's WORDS (services/signWords), in every build, because a
     Withdraw and a trade want theirs whatever the Perp flag says. Asking
     for words never asks for less than a window — that pair writes the
     window-shown flag in itself, every time.
     What this test is for is unchanged, and now says it in figures: a
     flag-off build has NO WAY to ask for a signature with no window. The
     silent API is not registered, and a THIRD hook call here is a new signer
     being wired where none belongs. */
  assert.deepEqual(b.calls.hooks, ["useSignTypedData", "useSendTransaction"]);
  assert.deepEqual(b.calls.sign, [], "and Privy has been asked to sign nothing");
  assert.deepEqual(b.calls.send, [], "and to send nothing");
  b.h.unmount();
});

/* ── THE OTHER NO-WINDOW ACTION: the last hop of a first deposit ────────────
   Owner, 2026-09-27: "ครั้งแรก เกือบ noo fee". A deposit credited straight into a
   brand-new Perp account is charged a one-time cost (measured 1.245194 USDC on
   25 from Base); a plain USDC transfer into the venue's own deposit contract is
   charged nothing, so a first deposit lands in the customer's own wallet and
   their own wallet makes that one transfer. The addresses are written out here
   in full, and scripts/test-perp-first-deposit.mjs compares them with the Perp
   module that owns them, so the two cannot drift apart. */
const FUND_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const FUND_BRIDGE = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";
const fundTx = (over = {}) => ({
  chainId: 42161,
  to: FUND_USDC,
  data: `0xa9059cbb${FUND_BRIDGE.slice(2).padStart(64, "0")}${(25000000n).toString(16).padStart(64, "0")}`,
  value: "0x0",
  ...over,
});

test("B5) Perp build: the bridge sends ONE transfer with no window — rebuilt, to the deposit contract, and it answers with the hash", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  assert.equal(typeof api.sendPerpFunding, "function");
  const hash = await api.sendPerpFunding(fundTx(), EMBEDDED);
  assert.equal(hash, `0x${"cd".repeat(32)}`);
  assert.equal(b.calls.send.length, 1);
  const [input, opts] = b.calls.send[0];
  assert.deepEqual(opts, { address: EMBEDDED, uiOptions: { showWalletUIs: false } });
  assert.deepEqual(input, fundTx(), "the transfer Privy is asked for is the one the bridge built");
  assert.equal(input.data.slice(0, 10), "0xa9059cbb");
  assert.equal(`0x${input.data.slice(34, 74)}`, FUND_BRIDGE, "the money goes to the deposit contract and nowhere else");
  b.h.unmount();
});

test("B5b) 🔴 CLOSED BUILDER: the request's amount is the only thing that carries over, and it is re-encoded", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  /* Upper case, a decimal value, and a from the builder has no business with. */
  await api.sendPerpFunding({ ...fundTx({ value: 0, from: "0x" + "9".repeat(40) }), data: fundTx().data.toUpperCase().replace("0XA9", "0xa9") }, EMBEDDED);
  const [input] = b.calls.send[0];
  assert.deepEqual(Object.keys(input).sort(), ["chainId", "data", "to", "value"], "nothing the caller added survives");
  assert.equal(input.data, fundTx().data, "re-encoded in the builder's own casing");
  b.h.unmount();
});

test("B6) 🔴 the bridge refuses every other transaction: another chain, another token, another recipient, below the floor, or carrying value", async () => {
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" });
  const api = b.api();
  const amount = (raw) => `0xa9059cbb${FUND_BRIDGE.slice(2).padStart(64, "0")}${raw.toString(16).padStart(64, "0")}`;
  const bad = [
    fundTx({ chainId: 1 }),
    fundTx({ chainId: 8453 }),
    /* Avalanche is in Privy's supportedChains now (the Avax Wallet): the no-window transfer still refuses it (plan §3.9.4). */
    fundTx({ chainId: 43114 }),
    fundTx({ chainId: "0xa86a" }),
    fundTx({ to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }),
    fundTx({ data: `0xa9059cbb${"11".repeat(32)}${(25000000n).toString(16).padStart(64, "0")}` }),
    fundTx({ data: amount(4999999n) }),
    fundTx({ data: amount(0n) }),
    fundTx({ value: "0x1" }),
    fundTx({ data: "0x23b872dd" + fundTx().data.slice(10) }),
    fundTx({ data: "0xa9059cbb" }),
    fundTx({ data: `${fundTx().data}00` }),
    { chainId: 42161 },
    null,
  ];
  for (const request of bad) {
    await assert.rejects(() => api.sendPerpFunding(request, EMBEDDED), /no window/i, JSON.stringify(request));
  }
  assert.equal(b.calls.send.length, 0, "Privy was never asked");
  b.h.unmount();
});

test("B4) services/privy hands out the silent signer only once the bridge registered one", async () => {
  fakeBrowser();
  globalThis.__impl = {};
  const Svc = await bundle({ entry: SVC, env: { VITE_PRIVY_APP_ID: "app" }, stubs: autoStubs([SVC]) });
  assert.equal(Svc.privySilentTypedSigner(), null, "nothing registered");
  Svc.registerPrivyApi({ ready: true, authenticated: true });
  assert.equal(Svc.privySilentTypedSigner(), null, "a bridge without the silent signer (Perp off)");
  const seen = [];
  Svc.registerPrivyApi({ ready: true, authenticated: true, embeddedAddress: EMBEDDED, signTypedDataSilently: async (td, addr) => { seen.push([td, addr]); return "0xsig"; } });
  const s = Svc.privySilentTypedSigner();
  assert.equal(s.address, EMBEDDED);
  assert.equal(await s.signTypedData({ primaryType: "x" }), "0xsig");
  assert.deepEqual(seen, [[{ primaryType: "x" }, EMBEDDED]]);
  /* The funding sender is handed out the same way, and only once registered. */
  assert.equal(Svc.privySilentTxSender(), null, "a bridge that registered no sender");
  const sent = [];
  Svc.registerPrivyApi({ ready: true, authenticated: true, embeddedAddress: EMBEDDED, sendPerpFunding: async (tx, addr) => { sent.push([tx, addr]); return "0xhash"; } });
  const tx = Svc.privySilentTxSender();
  assert.equal(tx.address, EMBEDDED, "the embedded wallet's own address, which is the Perp account's");
  assert.equal(await tx.sendTransaction({ to: "0x1" }), "0xhash");
  assert.deepEqual(sent, [[{ to: "0x1" }, EMBEDDED]]);
});

/* ════════════════════════════════════════════════════════════════════════════
   B7–B9. THE AVAX WALLET: Avalanche signs through the bridge, ALWAYS in a window
   ════════════════════════════════════════════════════════════════════════════
   Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
   Privy เลย". The Avax Wallet's transactions and its move back to the Main
   Account sign through the bridge's SHOWN pair, and only what the two closed
   builders (src/avax/closedTx.js, exported by the bridge) REBUILD from the
   request and its review reaches Privy. Fixtures are read-only Relay answers;
   nothing here signs anything real. */

const AVX = (f) => pathToFileURL(path.join(ROOT, f)).href;
const avx = {};
async function avaxMods() {
  if (avx.CT) return avx;
  avx.CT = await import(AVX("src/avax/closedTx.js"));
  avx.AT = await import(AVX("src/lib/avax/aaveTx.js"));
  avx.SD = await import(AVX("src/lib/avax/swapDecode.js"));
  avx.SW = await import(AVX("src/lib/relay/swap.js"));
  avx.MO = await import(AVX("src/lib/relay/moveOut.js"));
  avx.PINS = await import(AVX("src/lib/avax/relayPins.js"));
  avx.fs = await import("node:fs");
  return avx;
}
const fixture = (name) => JSON.parse(avx.fs.readFileSync(path.join(ROOT, "scripts/fixtures/avax", name), "utf8"));
const GWEI = 10n ** 9n;
const FEES = Object.freeze({ maxFeePerGas: 11n * GWEI, maxPriorityFeePerGas: 1n * GWEI });
const DEAD_LC = "0x000000000000000000000000000000000000dead";
const STRANGER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const word = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/* A swap review straight from a recorded quote, for the wallet that asked for it. */
function swapReview(name) {
  const fx = fixture(name);
  const j = fx.response;
  const b = fx.body || {};
  const own = String(b.user || j.details.sender).toLowerCase();
  const review = avx.SD.parseSwapQuote(j, {
    own, from: b.originCurrency || j.details.currencyIn.currency.address, to: b.destinationCurrency || j.details.currencyOut.currency.address,
    amountRaw: b.amount || j.details.currencyIn.amount, now: Date.now(),
  });
  return { own, review };
}

test("B7) 🔴 avaxTxFromRequest: Aave — exactly approve / supply / withdraw for own, refused for another spender, onBehalfOf or to, unlimited, another chain, value, unknown keys or a fee over the cap; the exit is exempt from the 12 gwei cap", async () => {
  const { CT, AT } = await avaxMods();
  const [approve, supply] = AT.buildSupplySteps({ own: EMBEDDED, amountRaw: 2000000n, allowanceRaw: 0n, fees: FEES }).map((s) => s.tx);
  const withdraw = AT.buildWithdrawTx({ own: EMBEDDED, amountRaw: "max", fees: FEES });
  const ok = (tx) => CT.avaxTxFromRequest(tx, { kind: "aave" }, EMBEDDED);
  for (const [tx, kind, sentence] of [[approve, "aave-approve", "Allow exactly 2 USDC for Aave"], [supply, "aave-supply", "Supply 2 USDC to Aave on Avalanche"], [withdraw, "aave-withdraw", "Withdraw all your USDC from Aave"]]) {
    const b = ok(tx);
    assert.ok(b, kind);
    assert.equal(b.kind, kind);
    assert.equal(b.words.description, sentence, "the window says what the decoded call does");
    assert.deepEqual(Object.keys(b.tx).sort(), ["chainId", "data", "from", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "to", "value"], "Privy's own key names, nothing else");
    assert.equal(b.tx.chainId, 43114);
    assert.equal(b.tx.value, "0x0");
  }
  const sel = (tx) => tx.data.slice(0, 10);
  const bad = [
    ["foreign spender", { ...approve, data: `${sel(approve)}${word(STRANGER)}${approve.data.slice(74)}` }],
    ["unlimited approve", { ...approve, data: `${approve.data.slice(0, 74)}${"f".repeat(64)}` }],
    ["onBehalfOf another", { ...supply, data: `${supply.data.slice(0, 138)}${word(STRANGER)}${supply.data.slice(202)}` }],
    ["withdraw to another", { ...withdraw, data: `${withdraw.data.slice(0, 138)}${word(STRANGER)}` }],
    ["another chain (1)", { ...supply, chainId: 1 }],
    ["another chain (Arbitrum)", { ...supply, chainId: 42161 }],
    ["nonzero value", { ...supply, value: "0x1" }],
    ["unknown key: nonce", { ...supply, nonce: 7 }],
    ["unknown key: accessList", { ...supply, accessList: [] }],
    ["unknown key: authorizationList", { ...supply, authorizationList: [] }],
    ["from another", { ...supply, from: STRANGER }],
    ["no fee stated", { ...supply, maxFeePerGas: undefined }],
    ["tip over 1 gwei", { ...supply, maxPriorityFeePerGas: `0x${(2n * GWEI).toString(16)}` }],
    ["13 gwei on a supply", { ...supply, maxFeePerGas: `0x${(13n * GWEI).toString(16)}` }],
    ["13 gwei on an approve", { ...approve, maxFeePerGas: `0x${(13n * GWEI).toString(16)}` }],
    ["another gas limit", { ...supply, gasLimit: "0x7a120" }],
    ["trailing bytes", { ...supply, data: `${supply.data}00` }],
    ["another contract", { ...supply, to: STRANGER }],
  ];
  for (const [why, tx] of bad) assert.equal(ok(tx), null, why);
  /* The exit: an Aave withdraw at 25 gwei (a fee spike is when people leave) still builds; its tip is still capped. */
  const spike = { ...withdraw, maxFeePerGas: `0x${(25n * GWEI).toString(16)}` };
  assert.equal(ok(spike).exit, true);
  assert.equal(ok({ ...spike, maxPriorityFeePerGas: `0x${(5n * GWEI).toString(16)}` }), null, "an exit's tip is capped too (ATK-15)");
  /* Not this wallet's, not a check this app knows, not a check at all. */
  assert.equal(CT.avaxTxFromRequest(supply, { kind: "aave" }, STRANGER), null);
  assert.equal(CT.avaxTxFromRequest(supply, { kind: "raw" }, EMBEDDED), null);
  assert.equal(CT.avaxTxFromRequest(supply, null, EMBEDDED), null);
  assert.equal(CT.avaxTxFromRequest(supply, undefined, EMBEDDED), null);
});

test("B7b) 🔴 avaxTxFromRequest: a swap is exactly swapTxRequests(review)[index], read again on its own — refused for another index, another wallet, a forged refund / recipient / minimum, a fee over the cap unless it is the exit swap", async () => {
  const { CT, SD, SW } = await avaxMods();
  const { own, review } = swapReview("live-swap-usdc-btcb-2.json");
  const txs = SW.swapTxRequests(review, { maxFeePerGasWei: 11n * GWEI });
  assert.deepEqual(txs.map((t) => t.purpose), ["approve", "swap"]);
  const b0 = CT.avaxTxFromRequest(txs[0], { kind: "swap", review, index: 0 }, own);
  const b1 = CT.avaxTxFromRequest(txs[1], { kind: "swap", review, index: 1 }, own);
  assert.equal(b0.kind, "swap-approve");
  assert.equal(b1.kind, "swap-swap");
  const ww = SD.swapWindowWords(review);
  assert.equal(b1.words.description, ww.swap, "the window's sentence is swapWindowWords' own");
  assert.ok(b0.words.description.startsWith(ww.approve));
  assert.equal(b1.exit, false);
  /* The wrong place, the wrong wallet, a byte off. */
  assert.equal(CT.avaxTxFromRequest(txs[0], { kind: "swap", review, index: 1 }, own), null);
  assert.equal(CT.avaxTxFromRequest(txs[1], { kind: "swap", review, index: 2 }, own), null);
  assert.equal(CT.avaxTxFromRequest(txs[1], { kind: "swap", review, index: 1 }, STRANGER), null);
  assert.equal(CT.avaxTxFromRequest({ ...txs[1], data: `${txs[1].data.slice(0, -2)}00` }, { kind: "swap", review, index: 1 }, own), null);
  assert.equal(CT.avaxTxFromRequest({ ...txs[1], value: "0x1" }, { kind: "swap", review, index: 1 }, own), null);
  /* A forged REVIEW (the request equal to it, byte for byte): the re-read still refuses. */
  const d = viem.decodeFunctionData({ abi: SD.SWAP_ABI, data: txs[1].data });
  const forge = (args) => {
    const data = viem.encodeFunctionData({ abi: SD.SWAP_ABI, functionName: "transferAndMulticall", args }) + review.requestId.slice(2);
    const r = { ...review, txs: review.txs.map((t) => (t.purpose === "swap" ? { ...t, data } : t)) };
    const t = SW.swapTxRequests(r, { maxFeePerGasWei: 11n * GWEI })[1];
    return CT.avaxTxFromRequest(t, { kind: "swap", review: r, index: 1 }, own);
  };
  assert.ok(forge([...d.args]), "re-encoding the same arguments is the same swap");
  assert.equal(forge([d.args[0], d.args[1], d.args[2], STRANGER, d.args[4], d.args[5]]), null, "a refund to someone else");
  assert.equal(forge([d.args[0], d.args[1], d.args[2], d.args[3], STRANGER, d.args[5]]), null, "a recipient that is someone else");
  assert.equal(forge([d.args[0], [d.args[1][0] + 1n], d.args[2], d.args[3], d.args[4], d.args[5]]), null, "another amount pulled");
  assert.equal(CT.avaxTxFromRequest(txs[1], { kind: "swap", review: { ...review, minOutRaw: String(BigInt(review.minOutRaw) - 1n) }, index: 1 }, own), null, "a minimum that is not the calldata's");
  /* Fees: 13 gwei refuses a swap INTO an asset; the exit swap back to USDC may pay it. */
  assert.equal(SW.swapTxRequests(review, { maxFeePerGasWei: 13n * GWEI }), null);
  assert.equal(CT.avaxTxFromRequest({ ...txs[1], maxFeePerGas: `0x${(13n * GWEI).toString(16)}` }, { kind: "swap", review, index: 1 }, own), null);
  const exit = swapReview("swap-q11-btcb-usdc.json");
  const ex = SW.swapTxRequests(exit.review, { maxFeePerGasWei: 25n * GWEI });
  const last = ex.length - 1;
  const bx = CT.avaxTxFromRequest(ex[last], { kind: "swap", review: exit.review, index: last }, exit.own);
  assert.ok(bx, "the exit swap at 25 gwei");
  assert.equal(bx.exit, true);
  /* A stable over the swap cap is not a swap this app offers. */
  const big = { ...review, amountRaw: "21000000" };
  assert.equal(CT.avaxTxFromRequest(txs[1], { kind: "swap", review: big, index: 1 }, own), null);
});

test("B7c) avaxTxFromRequest: the allowance reset and the paid exit are their closed builders' output, at their gas sizes, and nothing else", async () => {
  const { CT, SW, MO, PINS } = await avaxMods();
  const reset = { ...SW.buildRemoveAllowanceTx({ token: "USDC", spender: PINS.RELAY_V3.approvalProxy }), gasLimit: 75000n, ...FEES };
  const br = CT.avaxTxFromRequest(reset, { kind: "swap-allowance-reset", args: { token: "USDC", spender: PINS.RELAY_V3.approvalProxy } }, EMBEDDED);
  assert.equal(br.kind, "swap-allowance-reset");
  assert.match(br.words.description, /Remove the USDC allowance/);
  assert.equal(CT.avaxTxFromRequest(reset, { kind: "swap-allowance-reset", args: { token: "USDC", spender: STRANGER } }, EMBEDDED), null);
  assert.equal(CT.avaxTxFromRequest({ ...reset, gasLimit: 200000n }, { kind: "swap-allowance-reset", args: { token: "USDC", spender: PINS.RELAY_V3.approvalProxy } }, EMBEDDED), null);
  assert.equal(CT.avaxTxFromRequest({ ...reset, maxFeePerGas: 13n * GWEI }, { kind: "swap-allowance-reset", args: { token: "USDC", spender: PINS.RELAY_V3.approvalProxy } }, EMBEDDED), null);

  const ONE = "0x1111111111111111111111111111111111111111";
  const review = MO.parsePaidExitQuote(fixture("relay-q11-back-plain.json").response, { own: ONE, amountRaw: "10000000" });
  const [ap, dep] = MO.buildPaidExitTxs({ own: ONE, amountRaw: review.amountRaw, orderId: review.orderId });
  const spike = { maxFeePerGas: 25n * GWEI, maxPriorityFeePerGas: GWEI };
  const a = CT.avaxTxFromRequest({ ...ap, gasLimit: 80000n, ...spike }, { kind: "paid-exit", review, index: 0 }, ONE);
  const b = CT.avaxTxFromRequest({ ...dep, gasLimit: 100000n, ...spike }, { kind: "paid-exit", review, index: 1 }, ONE);
  assert.equal(a.exit && b.exit, true, "the paid exit is an exit: it may pay a fee spike");
  assert.equal(b.words.description.startsWith("Move 10 USDC to your Main Account."), true);
  assert.equal(CT.avaxTxFromRequest({ ...dep, gasLimit: 100000n, ...spike }, { kind: "paid-exit", review, index: 0 }, ONE), null, "the deposit in the approve's place");
  assert.equal(CT.avaxTxFromRequest({ ...dep, gasLimit: 150000n, ...spike }, { kind: "paid-exit", review, index: 1 }, ONE), null, "more gas than the exit reserve is sized for");
  assert.equal(CT.avaxTxFromRequest({ ...dep, gasLimit: 100000n, ...spike }, { kind: "paid-exit", review: { ...review, own: STRANGER }, index: 1 }, ONE), null);
  assert.equal(CT.avaxTxFromRequest({ ...dep, gasLimit: 100000n, ...spike }, { kind: "paid-exit", review: { ...review, route: "permit" }, index: 1 }, ONE), null);
  const other = MO.buildPaidExitTxs({ own: STRANGER, amountRaw: review.amountRaw, orderId: review.orderId })[1];
  assert.equal(CT.avaxTxFromRequest({ ...other, gasLimit: 100000n, ...spike }, { kind: "paid-exit", review, index: 1 }, ONE), null, "a deposit credited to someone else");
});

/* The 2026-10-26 shape: a MulticallAuthorization first, then the EIP-3009 to the v3.2 proxy (moveOut.js F15's fixture). */
function moveOutWithMca(MO, PINS, j, mutate = null) {
  const item = j.steps[0].items[0];
  item.data.sign.value.to = PINS.RELAY_V32.approvalProxy;
  const vb = item.data.sign.value.validBefore;
  const ABI = MO.MOVE_OUT_ABI;
  const mca = {
    status: "incomplete",
    data: {
      sign: {
        signatureKind: "eip712",
        domain: { name: "RelayApprovalProxy", version: "3.1", chainId: 43114, verifyingContract: PINS.RELAY_V32.approvalProxy },
        types: {
          MulticallAuthorization: [
            { name: "from", type: "address" }, { name: "relayer", type: "address" }, { name: "msgValue", type: "uint256" },
            { name: "refundTo", type: "address" }, { name: "nftRecipient", type: "address" }, { name: "metadata", type: "bytes" },
            { name: "fundingIndex", type: "uint256" }, { name: "calls", type: "Call3Value[]" }, { name: "funding", type: "FundingAuthorization[]" },
          ],
          Call3Value: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }],
          FundingAuthorization: [{ name: "token", type: "address" }, { name: "from", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }],
        },
        primaryType: "MulticallAuthorization",
        value: {
          from: DEAD_LC, relayer: PINS.RELAY_SOLVERS[0], msgValue: "0", refundTo: DEAD_LC, nftRecipient: DEAD_LC, metadata: "0x", fundingIndex: 0,
          calls: [
            { target: PINS.AVAX_USDC, allowFailure: false, value: "0", callData: viem.encodeFunctionData({ abi: ABI, functionName: "approve", args: [PINS.AVAX_DEPOSITORY, 2000000n] }) },
            { target: PINS.AVAX_DEPOSITORY, allowFailure: false, value: "0", callData: viem.encodeFunctionData({ abi: ABI, functionName: "depositErc20", args: [DEAD_LC, PINS.AVAX_USDC, 2000000n, j.protocol.v2.orderId] }) },
          ],
          funding: [{ token: PINS.AVAX_USDC, from: DEAD_LC, value: "2000000", validAfter: 0, validBefore: vb }],
        },
      },
      post: { endpoint: "/execute/permits", method: "POST", body: { kind: "multicall-authorization", requestId: j.requestId, api: "swap" } },
    },
  };
  j.steps[0].items = [mca, item];
  if (mutate) mutate(mca.data.sign.value, item.data.sign.value);
  return j;
}

test("B8) 🔴 avaxTypedDataFromRequest: only the review's OWN permit (and its call authorization) — refused for another review, another domain or chain, another payee, amount, nonce, deadline or field", async () => {
  const { CT, MO, PINS } = await avaxMods();
  const fx = fixture("live-move-out-2.json");
  const at = fx.capturedAt + 1000;
  const review = MO.parseMoveOutQuote(fx.response, { own: DEAD_LC, amountRaw: "2000000", now: at });
  const td = review.signatures[0].typedData;
  const b = CT.avaxTypedDataFromRequest(td, review, DEAD_LC, { now: at });
  assert.equal(b.kind, "eip3009");
  assert.equal(b.words.description.startsWith("Move 2 USDC to your Main Account."), true);
  assert.equal(b.typedData.domain.chainId, 43114);
  assert.deepEqual(b.typedData.message, td.message, "the message signed is the review's own, field for field");
  const big = (m) => ({ ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) });
  assert.equal(
    viem.hashTypedData({ ...b.typedData, message: big(b.typedData.message) }),
    viem.hashTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: big(td.message) }),
    "the rebuilt typed data hashes exactly as Relay's: the signature Relay checks is the one Privy makes",
  );
  const edit = (f) => { const c = JSON.parse(JSON.stringify(td)); f(c); return c; };
  const bad = [
    ["domain chainId 1", edit((c) => { c.domain.chainId = 1; })],
    ["domain chainId Arbitrum", edit((c) => { c.domain.chainId = 42161; })],
    ["another token's domain", edit((c) => { c.domain.verifyingContract = STRANGER; })],
    ["another domain name", edit((c) => { c.domain.name = "USD Coin "; })],
    ["paid to a stranger", edit((c) => { c.message.to = STRANGER; })],
    ["from a stranger", edit((c) => { c.message.from = STRANGER; })],
    ["another amount", edit((c) => { c.message.value = "2000001"; })],
    ["another nonce", edit((c) => { c.message.nonce = `0x${"ab".repeat(32)}`; })],
    ["another deadline", edit((c) => { c.message.validBefore += 1; })],
    ["an extra field", edit((c) => { c.message.extra = 1; })],
    ["an extra type", edit((c) => { c.types.Extra = [{ name: "x", type: "string" }]; })],
    ["a Permit instead", edit((c) => { c.primaryType = "Permit"; })],
  ];
  for (const [why, t] of bad) assert.equal(CT.avaxTypedDataFromRequest(t, review, DEAD_LC, { now: at }), null, why);
  /* Another review: the same shape for another amount or wallet is not THIS move. */
  assert.equal(CT.avaxTypedDataFromRequest(td, { ...review, amountRaw: "3000000" }, DEAD_LC, { now: at }), null);
  assert.equal(CT.avaxTypedDataFromRequest(td, review, STRANGER, { now: at }), null);
  assert.equal(CT.avaxTypedDataFromRequest(td, { ...review, route: "paid" }, DEAD_LC, { now: at }), null);
  /* Too late to sign (under 30 s left), and a grant that would stay usable too long. */
  assert.equal(CT.avaxTypedDataFromRequest(td, review, DEAD_LC, { now: (review.validBefore - 20) * 1000 }), null);
  assert.equal(CT.avaxTypedDataFromRequest(td, review, DEAD_LC, { now: (review.validBefore - 1000) * 1000 }), null);

  /* After 2026-10-26: the call authorization first, then the permit to the v3.2 proxy. */
  const j2 = moveOutWithMca(MO, PINS, JSON.parse(JSON.stringify(fx.response)));
  const r2 = MO.parseMoveOutQuote(j2, { own: DEAD_LC, amountRaw: "2000000", now: at });
  const m = CT.avaxTypedDataFromRequest(r2.signatures[0].typedData, r2, DEAD_LC, { now: at });
  const p = CT.avaxTypedDataFromRequest(r2.signatures[1].typedData, r2, DEAD_LC, { now: at });
  assert.equal(m.kind, "multicall-authorization");
  assert.equal(p.kind, "eip3009");
  assert.match(m.words.description, /^Authorizing exactly 2 USDC for this move/);
  /* The lone v3 permit is not the second half of a v3.2 pair, and the other way round (ATK-05). */
  assert.equal(CT.avaxTypedDataFromRequest(td, r2, DEAD_LC, { now: at }), null);
  const mca = JSON.parse(JSON.stringify(r2.signatures[0].typedData));
  const tamper = (f) => { const c = JSON.parse(JSON.stringify(mca)); f(c.message); return c; };
  for (const [why, t] of [
    ["a transfer to a stranger", tamper((v) => { v.calls[1] = { target: PINS.AVAX_USDC, allowFailure: false, value: "0", callData: viem.encodeFunctionData({ abi: MO.MOVE_OUT_ABI, functionName: "transfer", args: [STRANGER, 2000000n] }) }; })],
    ["a deposit for another order", tamper((v) => { v.calls[1].callData = viem.encodeFunctionData({ abi: MO.MOVE_OUT_ABI, functionName: "depositErc20", args: [DEAD_LC, PINS.AVAX_USDC, 2000000n, `0x${"cd".repeat(32)}`] }); })],
    ["a deposit credited to a stranger", tamper((v) => { v.calls[1].callData = viem.encodeFunctionData({ abi: MO.MOVE_OUT_ABI, functionName: "depositErc20", args: [STRANGER, PINS.AVAX_USDC, 2000000n, j2.protocol.v2.orderId] }); })],
    ["a refund to a stranger", tamper((v) => { v.refundTo = STRANGER; })],
    ["more pulled", tamper((v) => { v.funding[0].value = "3000000"; })],
    ["AVAX spent", tamper((v) => { v.msgValue = "1"; })],
  ]) assert.equal(CT.avaxTypedDataFromRequest(t, r2, DEAD_LC, { now: at }), null, why);
});

test("B9) 🔴 the bridge's Avalanche pair IS the visible hook: Privy is asked with the window shown and the decoded words, through the SHOWN instance, never the silent one — and a refusal never reaches Privy", async () => {
  const { AT, MO } = await avaxMods();
  for (const env of [{ VITE_PERP_ENABLED: "1" }, { VITE_PERP_ENABLED: "0" }]) {
    const b = await mountBridge(env, { keep: ["src/avax/closedTx.js", "src/services/signWords.js"] });
    const api = b.api();
    const perp = env.VITE_PERP_ENABLED === "1";
    /* Still exactly the hooks there were: the silent pair (Perp only) then the shown pair. No new hook call. */
    assert.deepEqual(b.calls.hooks, perp ? ["useSignTypedData", "useSendTransaction", "useSignTypedData", "useSendTransaction"] : ["useSignTypedData", "useSendTransaction"]);
    assert.equal("embeddedAddress" in api, perp, "the Avalanche pair does not register the silent signer's address");
    const shown = perp ? 1 : 0;
    assert.equal(api.avalanche.address, EMBEDDED);
    const supply = AT.buildSupplyTx({ own: EMBEDDED, amountRaw: 2000000n, fees: FEES });
    const hash = await api.avalanche.sendTransaction(supply, { kind: "aave" });
    assert.equal(hash, `0x${"cd".repeat(32)}`);
    assert.equal(b.calls.send.length, 1);
    const [input, opts, which] = b.calls.send[0];
    assert.equal(which, shown, "the SHOWN sendTransaction hook, never the silent one");
    assert.equal(opts.address, EMBEDDED);
    assert.equal(opts.uiOptions.showWalletUIs, true, "the window is shown");
    assert.equal(opts.uiOptions.description, "Supply 2 USDC to Aave on Avalanche");
    assert.equal(opts.uiOptions.buttonText, "Stake");
    assert.equal(input.chainId, 43114);
    assert.equal(input.data, supply.data);
    /* A refusal: thrown before Privy, and it reads as a cancel (nothing was sent). */
    await assert.rejects(() => api.avalanche.sendTransaction({ ...supply, chainId: 1 }, { kind: "aave" }), (e) => e.code === "refused" && /Cancelled/.test(e.message));
    await assert.rejects(() => api.avalanche.sendTransaction(supply, { kind: "anything" }), (e) => e.code === "refused");
    assert.equal(b.calls.send.length, 1, "Privy was never asked again");
    b.h.unmount();
  }
  /* The typed data, through the shown sign hook, for the wallet the review is for. */
  const fx = fixture("live-move-out-2.json");
  const review = MO.parseMoveOutQuote(fx.response, { own: DEAD_LC, amountRaw: "2000000", now: fx.capturedAt + 1000 });
  /* The bridge reads the real clock: re-time the recorded deadline the way a fresh quote would carry it. */
  const vb = Math.floor(Date.now() / 1000) + 600;
  const td = { ...review.signatures[0].typedData, message: { ...review.signatures[0].typedData.message, validBefore: vb } };
  const fresh = { ...review, validBefore: vb, signatures: [{ ...review.signatures[0], typedData: td }] };
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" }, { keep: ["src/avax/closedTx.js", "src/services/signWords.js"], address: DEAD_LC });
  const api = b.api();
  const sig = await api.avalanche.signTypedData(td, fresh);
  assert.equal(sig, `0x${"11".repeat(65)}`);
  const [input, opts, which] = b.calls.sign[0];
  assert.equal(which, 1, "the SHOWN signTypedData hook");
  assert.equal(opts.uiOptions.showWalletUIs, true);
  assert.match(opts.uiOptions.description, /^Move 2 USDC to your Main Account\./);
  assert.equal(input.domain.chainId, 43114);
  await assert.rejects(() => api.avalanche.signTypedData({ ...td, message: { ...td.message, to: STRANGER } }, fresh), (e) => e.code === "refused");
  assert.equal(b.calls.sign.length, 1);
  b.h.unmount();
});

test("G1b) the bridge exports the two closed builders, never calls switchChain with Avalanche, and its Avalanche pair is built on the shown hooks", () => {
  const c = code(BRIDGE);
  assert.match(c, /export\s*\{\s*avaxTxFromRequest,\s*avaxTypedDataFromRequest\s*\}/);
  assert.doesNotMatch(c, /switchChain\(\s*(43114|0xa86a|AVAX)/i);
  const pair = c.slice(c.indexOf("const avalanche = useMemo"), c.indexOf("const pendingLogin"));
  assert.ok(pair.length > 200, "the Avalanche pair was found");
  assert.match(pair, /sendTransactionUiOptions\(built\.words\)/);
  assert.match(pair, /signMessageUiOptions\(built\.words\)/);
  assert.doesNotMatch(pair, /showWalletUIs/, "the pair names no window flag of its own: signWords writes it, shown");
  assert.doesNotMatch(pair, /privySign|privySend|silent/i, "the pair never touches the silent pair");
});

/* ════════════════════════════════════════════════════════════════════════════
   B10–B11. RECOVER: Base and Polygon sign through the bridge, ALWAYS in a window
   ════════════════════════════════════════════════════════════════════════════
   Owner, 2026-10-15: "เอา ARB, Avax, Base, Polygon พอแระ". A private deposit's
   refund on Base or Polygon lands in the embedded EOA with no gas there; the
   Recover row moves it into the balance with one EIP-3009
   ReceiveWithAuthorization on that chain's native USDC (and, from 2026-10-26, a
   MulticallAuthorization before it). The bridge signs it on the SHOWN hook, and
   only what lib/relay/recoverClosed.js REBUILDS from the request and its Recover
   review reaches Privy. Fixtures are live read-only Relay answers for the
   placeholder 0x…dEaD (nothing was signed or posted), re-addressed to the test
   wallet; every signature here is made offline with the public test key. */

const rec = {};
async function recoverMods() {
  if (rec.RC) return rec;
  rec.RC = await import(AVX("src/lib/relay/recoverClosed.js"));
  rec.RS = await import(AVX("src/lib/relay/recoverStranded.js"));
  rec.fs = await import("node:fs");
  return rec;
}
const REC_FIX = { 8453: "relay-recover-base-10", 137: "relay-recover-polygon-10" };
const DEAD_RE = /0x000000000000000000000000000000000000dEaD/gi;
const NATIVE_USDC = { 8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 137: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" };
const USDC_E_POLYGON = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDBC_BASE = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const CHAIN_NAME = { 8453: "Base", 137: "Polygon" };
const fieldsOf = (pairs) => pairs.map(([name, type]) => ({ name, type }));
const bigRwa = (m) => ({ ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) });

/* A Recover review for `own`, from the live answer. `at` is the clock it is priced on; `vbIn` re-times the permit's
   deadline (seconds after `at`) the way a fresh quote would carry it. */
function recoverReview(chainId, { own = EMBEDDED, at = null, vbIn = null, mutate = null } = {}) {
  const fx = JSON.parse(rec.fs.readFileSync(path.join(ROOT, "scripts/fixtures/recover", `${REC_FIX[chainId]}.json`), "utf8"));
  const j = JSON.parse(JSON.stringify(fx.response).replace(DEAD_RE, own));
  const now = at == null ? fx.capturedAt + 2000 : at;
  if (vbIn != null) j.steps[0].items[0].data.sign.value.validBefore = Math.floor(now / 1000) + vbIn;
  if (mutate) mutate(j, now);
  return { review: rec.RS.parseRecoverQuote(j, { own, chainId, amountRaw: "10000000", now }), now };
}

/* The v3.2 shape (none can exist before 2026-10-26): the call authorization first, then the permit to the v3.2 proxy. */
function recoverV32(chainId, { own = EMBEDDED } = {}) {
  return recoverReview(chainId, {
    own,
    mutate: (j, now) => {
      const usdc = NATIVE_USDC[chainId];
      const v32 = rec.RS.RECOVER_RELAY["v3.2"].approvalProxy;
      const dep = rec.RS.RECOVER_RELAY.depository;
      const rwa = j.steps[0].items[0];
      rwa.data.sign.value.to = v32;
      const enc = (functionName, args) => viem.encodeFunctionData({ abi: rec.RS.RECOVER_ABI, functionName, args });
      const mca = {
        status: "incomplete",
        data: {
          sign: {
            signatureKind: "eip712",
            domain: { name: "RelayApprovalProxy", version: "3.1", chainId, verifyingContract: v32 },
            primaryType: "MulticallAuthorization",
            types: {
              MulticallAuthorization: fieldsOf([["from", "address"], ["relayer", "address"], ["msgValue", "uint256"], ["refundTo", "address"], ["nftRecipient", "address"], ["metadata", "bytes"], ["fundingIndex", "uint256"], ["calls", "Call3Value[]"], ["funding", "FundingAuthorization[]"]]),
              Call3Value: fieldsOf([["target", "address"], ["allowFailure", "bool"], ["value", "uint256"], ["callData", "bytes"]]),
              FundingAuthorization: fieldsOf([["token", "address"], ["from", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"]]),
            },
            value: {
              from: own, relayer: "0xf70da97812cb96acdf810712aa562db8dfa3dbef", msgValue: "0", refundTo: own, nftRecipient: own, metadata: "0x", fundingIndex: 0,
              calls: [
                { target: usdc, allowFailure: false, value: "0", callData: enc("approve", [dep, 10000000n]) },
                { target: dep, allowFailure: false, value: "0", callData: enc("depositErc20", [own, usdc, 10000000n, j.protocol.v2.orderId]) },
              ],
              funding: [{ token: usdc, from: own, value: "10000000", validAfter: 0, validBefore: Math.floor(now / 1000) + 500 }],
            },
          },
          post: { endpoint: "/execute/permits", method: "POST", body: { kind: "multicall-authorization", requestId: j.requestId, api: "swap" } },
        },
      };
      j.steps[0].items = [mca, rwa];
    },
  });
}

test("B10) 🔴 recoverTypedDataFromRequest: only the Recover review's OWN permit on that chain's native USDC — refused for a foreign to or from, another chain, another token, a bigger value, an expired window or an unknown key", async () => {
  const { RC, RS } = await recoverMods();
  const account = viemAccounts.privateKeyToAccount(PY_KEY);
  for (const id of [8453, 137]) {
    const { review, now } = recoverReview(id);
    const td = review.signatures[0].typedData;
    const b = RC.recoverTypedDataFromRequest(td, review, EMBEDDED, { now });
    assert.ok(b, `the live ${CHAIN_NAME[id]} permit is built`);
    assert.equal(b.kind, "eip3009");
    assert.equal(b.chainId, id);
    assert.deepEqual(b.typedData.domain, { name: "USD Coin", version: "2", chainId: id, verifyingContract: NATIVE_USDC[id] });
    assert.deepEqual(b.typedData.message, td.message, "the message signed is the review's own, field for field");
    assert.equal(b.typedData.message.to, RS.RECOVER_RELAY.v3.approvalProxy, "to Relay's pinned v3 receiver, from the verified quote");
    assert.equal(b.words.description, `Move 10 USDC from your wallet on ${CHAIN_NAME[id]} into your balance. At least 9.77 USDC arrives. No gas needed.`);
    assert.equal(b.words.buttonText, "Move in");
    /* What Privy is handed hashes exactly as what Relay asked for: the signature Relay checks is the one the window
       made, and it recovers to this wallet. Signed offline. */
    assert.equal(viem.hashTypedData({ ...b.typedData, message: bigRwa(b.typedData.message) }), viem.hashTypedData({ ...td, message: bigRwa(td.message) }));
    const sig = await account.signTypedData({ ...b.typedData, message: bigRwa(b.typedData.message) });
    assert.equal((await viem.recoverTypedDataAddress({ ...td, message: bigRwa(td.message), signature: sig })).toLowerCase(), EMBEDDED);
  }

  const { review, now } = recoverReview(8453);
  const td = review.signatures[0].typedData;
  const no = (why, t, r = review, o = EMBEDDED, at = now) => assert.equal(RC.recoverTypedDataFromRequest(t, r, o, { now: at }), null, why);
  const edit = (f) => { const c = JSON.parse(JSON.stringify(td)); f(c); return c; };
  for (const [why, t] of [
    /* a foreign to / from */
    ["paid to a stranger", edit((c) => { c.message.to = STRANGER; })],
    ["paid to the v3.2 proxy, alone (ATK-05)", edit((c) => { c.message.to = RS.RECOVER_RELAY["v3.2"].approvalProxy; })],
    ["paid to the depository", edit((c) => { c.message.to = RS.RECOVER_RELAY.depository; })],
    ["paid to the token itself", edit((c) => { c.message.to = NATIVE_USDC[8453]; })],
    ["from a stranger", edit((c) => { c.message.from = STRANGER; })],
    ["from nobody", edit((c) => { c.message.from = ZERO; })],
    /* another chain */
    ["domain chainId 1", edit((c) => { c.domain.chainId = 1; })],
    ["domain chainId Arbitrum", edit((c) => { c.domain.chainId = 42161; })],
    ["domain chainId Polygon on a Base review", edit((c) => { c.domain.chainId = 137; })],
    ["domain chainId Avalanche", edit((c) => { c.domain.chainId = 43114; })],
    ["domain chainId missing", edit((c) => { delete c.domain.chainId; })],
    /* another token */
    ["Base's bridged USDbC", edit((c) => { c.domain.verifyingContract = USDBC_BASE; })],
    ["Polygon's USDC on a Base review", edit((c) => { c.domain.verifyingContract = NATIVE_USDC[137]; })],
    ["Arbitrum's USDC", edit((c) => { c.domain.verifyingContract = ARB_USDC; })],
    ["another token name", edit((c) => { c.domain.name = "USDC"; })],
    ["another token version", edit((c) => { c.domain.version = "1"; })],
    /* another value */
    ["one unit more", edit((c) => { c.message.value = "10000001"; })],
    ["ten times more", edit((c) => { c.message.value = "100000000"; })],
    ["more, written as hex", edit((c) => { c.message.value = "0x989681"; })],
    ["one unit less", edit((c) => { c.message.value = "9999999"; })],
    /* another window or nonce */
    ["another deadline", edit((c) => { c.message.validBefore += 1; })],
    ["usable only later", edit((c) => { c.message.validAfter = Math.floor(now / 1000) + 3600; })],
    ["another nonce", edit((c) => { c.message.nonce = `0x${"ab".repeat(32)}`; })],
    /* unknown keys */
    ["an extra message field", edit((c) => { c.message.extra = 1; })],
    ["an extra domain key", edit((c) => { c.domain.salt = `0x${"01".repeat(32)}`; })],
    ["an extra type", edit((c) => { c.types.Extra = [{ name: "x", type: "string" }]; })],
    ["an extra type field", edit((c) => { c.types.ReceiveWithAuthorization.push({ name: "x", type: "uint256" }); })],
    ["a field typed differently", edit((c) => { c.types.ReceiveWithAuthorization[2] = { name: "value", type: "uint128" }; })],
    ["a non-standard EIP712Domain", edit((c) => { c.types.EIP712Domain = [{ name: "name", type: "string" }, { name: "salt", type: "bytes32" }]; })],
    ["an extra top-level key", edit((c) => { c.account = STRANGER; })],
    /* another primary type */
    ["a TransferWithAuthorization (anyone could submit it)", edit((c) => { c.primaryType = "TransferWithAuthorization"; c.types = { TransferWithAuthorization: c.types.ReceiveWithAuthorization }; })],
    ["a Permit instead", edit((c) => { c.primaryType = "Permit"; })],
  ]) no(why, t);

  /* An expired window — and a deadline too far out for the signer's clock. At the edge it still signs. */
  const vb = review.validBefore;
  no("under 30 s left", td, review, EMBEDDED, (vb - 20) * 1000);
  no("past its deadline", td, review, EMBEDDED, (vb + 1) * 1000);
  no("usable for too long from here", td, review, EMBEDDED, (vb - 1000) * 1000);
  assert.ok(RC.recoverTypedDataFromRequest(td, review, EMBEDDED, { now: (vb - 31) * 1000 }), "31 s left still signs");

  /* Another review: the same shape for another wallet, chain, amount, nonce or deadline is not THIS move. */
  no("another wallet's review", td, { ...review, own: STRANGER });
  no("signed by another wallet", td, review, STRANGER);
  no("not a Recover review", td, { ...review, kind: "move-out" });
  no("a review on Polygon", td, { ...review, chainId: 137 });
  no("a review on Arbitrum", td, { ...review, chainId: 42161 });
  no("a review for another amount", td, { ...review, amountRaw: "10000001" });
  no("a review with another nonce", td, { ...review, permitNonce: `0x${"cd".repeat(32)}` });
  no("a review with another deadline", td, { ...review, validBefore: review.validBefore + 1 });
  no("three signatures", td, { ...review, signatures: [...review.signatures, ...review.signatures, ...review.signatures] });
  no("no review", td, null);
  for (const t of [null, "typed data", [td], { ...td, message: null }]) no("not typed data", t);
  /* Sane on its own, but not the review's own signature: only the field-for-field match refuses it. */
  no("another validAfter, still sane", edit((c) => { c.message.validAfter = 1; }));
  /* A review forged around parseRecoverQuote: even when the request IS that review's signature, the pins hold. */
  const forged = (f, over = {}) => { const r = { ...JSON.parse(JSON.stringify(review)), ...over }; f(r.signatures[0].typedData); return r; };
  for (const [why, f, over] of [
    ["a review paying a stranger", (t) => { t.message.to = STRANGER; }],
    ["a lone review paying the v3.2 proxy", (t) => { t.message.to = RS.RECOVER_RELAY["v3.2"].approvalProxy; }],
    ["a review from a stranger", (t) => { t.message.from = STRANGER; }],
    ["a review on Base's USDbC", (t) => { t.domain.verifyingContract = USDBC_BASE; }],
    ["a review naming Polygon's domain on Base", (t) => { t.domain.chainId = 137; }],
    ["a review signing more than it reviewed", (t) => { t.message.value = "10000001"; }],
    ["a review whose permit lives a day", (t) => { t.message.validBefore = Math.floor(now / 1000) + 86400; }, { validBefore: Math.floor(now / 1000) + 86400 }],
    ["a review that is a TransferWithAuthorization", (t) => { t.primaryType = "TransferWithAuthorization"; t.types = { TransferWithAuthorization: t.types.ReceiveWithAuthorization }; }],
    ["a review naming a primary type its types do not describe", (t) => { t.primaryType = "TransferWithAuthorization"; }],
  ]) {
    const r = forged(f, over);
    no(why, r.signatures[0].typedData, r);
  }
  /* Polygon: its bridged USDC.e is not its USDC, and a Base permit is not Polygon's. */
  const p = recoverReview(137);
  const ptd = p.review.signatures[0].typedData;
  no("Polygon's bridged USDC.e", { ...ptd, domain: { ...ptd.domain, verifyingContract: USDC_E_POLYGON } }, p.review, EMBEDDED, p.now);
  no("a Base permit under a Polygon review", td, p.review, EMBEDDED, p.now);

  /* After 2026-10-26: the call authorization first, then the permit to the v3.2 proxy — each exactly the review's own. */
  for (const id of [8453, 137]) {
    const v = recoverV32(id);
    const [m, pm] = v.review.signatures.map((s) => RC.recoverTypedDataFromRequest(s.typedData, v.review, EMBEDDED, { now: v.now }));
    assert.equal(m.kind, "multicall-authorization");
    assert.equal(m.typedData.domain.chainId, id);
    assert.match(m.words.description, new RegExp(`^Authorizing exactly 10 USDC from your wallet on ${CHAIN_NAME[id]} for this move`));
    assert.equal(pm.kind, "eip3009");
    assert.equal(pm.typedData.message.to, RS.RECOVER_RELAY["v3.2"].approvalProxy);
  }
  const v = recoverV32(8453);
  no("the lone v3 permit is not the second half of a v3.2 pair", td, v.review, EMBEDDED, v.now);
  no("a v3.2 permit is never a lone permit", v.review.signatures[1].typedData, review, EMBEDDED, now);
  const mca = v.review.signatures[0].typedData;
  const orderId = v.review.orderId;
  const enc = (functionName, args) => viem.encodeFunctionData({ abi: RS.RECOVER_ABI, functionName, args });
  const tamper = (f) => { const c = JSON.parse(JSON.stringify(mca)); f(c.message, c); return c; };
  for (const [why, t] of [
    ["a transfer to a stranger", tamper((x) => { x.calls[1] = { target: NATIVE_USDC[8453], allowFailure: false, value: "0", callData: enc("transfer", [STRANGER, 10000000n]) }; })],
    ["a deposit for another order", tamper((x) => { x.calls[1].callData = enc("depositErc20", [EMBEDDED, NATIVE_USDC[8453], 10000000n, `0x${"cd".repeat(32)}`]); })],
    ["a deposit credited to a stranger", tamper((x) => { x.calls[1].callData = enc("depositErc20", [STRANGER, NATIVE_USDC[8453], 10000000n, orderId]); })],
    ["an allowance for a stranger", tamper((x) => { x.calls[0].callData = enc("approve", [STRANGER, 10000000n]); })],
    ["a refund to a stranger", tamper((x) => { x.refundTo = STRANGER; })],
    ["more pulled", tamper((x) => { x.funding[0].value = "10000001"; })],
    ["another token pulled", tamper((x) => { x.funding[0].token = USDBC_BASE; })],
    ["gas money spent", tamper((x) => { x.msgValue = "1"; })],
    ["the other chain's proxy", tamper((x, c) => { c.domain.chainId = 137; })],
    ["an extra call field", tamper((x) => { x.calls[0].extra = 1; })],
    /* sane on their own, but not the review's own call authorization */
    ["another relayer", tamper((x) => { x.relayer = STRANGER; })],
    ["no NFT recipient rather than own", tamper((x) => { x.nftRecipient = ZERO; })],
    ["other metadata", tamper((x) => { x.metadata = "0x01"; })],
    ["another funding deadline, still sane", tamper((x) => { x.funding[0].validBefore -= 1; })],
  ]) no(why, t, v.review, EMBEDDED, v.now);
  /* A forged v3.2 review whose own deposit is for another order, or credited to a stranger: refused though request = review. */
  for (const [why, args] of [
    ["another order", [EMBEDDED, NATIVE_USDC[8453], 10000000n, `0x${"cd".repeat(32)}`]],
    ["a stranger's credit", [STRANGER, NATIVE_USDC[8453], 10000000n, orderId]],
  ]) {
    const r = JSON.parse(JSON.stringify(v.review));
    r.signatures[0].typedData.message.calls[1].callData = enc("depositErc20", args);
    no(`a review whose deposit is for ${why}`, r.signatures[0].typedData, r, EMBEDDED, v.now);
  }
});

test("B10b) 🔴 recoverTypedDataFromRequest reads ONCE: a getter, a symbol key, a hidden or non-plain field in the request or the review refuses — what is checked is what is signed", async () => {
  const { RC, RS } = await recoverMods();
  const { review, now } = recoverReview(8453);
  const td = review.signatures[0].typedData;
  const real = td.message;
  assert.ok(RC.recoverTypedDataFromRequest(td, review, EMBEDDED, { now }), "the live permit still builds");
  const no = (why, t, r) => assert.equal(RC.recoverTypedDataFromRequest(t, r, EMBEDDED, { now }), null, why);
  /* A message whose `to` and `value` answer the check honestly and the signature with a stranger and more. */
  const flip = (honest, evil) => { let n = 0; return { enumerable: true, configurable: true, get() { n++; return n % 2 === 1 ? honest : evil; } }; };
  const forgedMsg = () => {
    const m = { from: real.from };
    Object.defineProperty(m, "to", flip(real.to, STRANGER));
    Object.defineProperty(m, "value", flip(real.value, "999000000"));
    Object.assign(m, { validAfter: real.validAfter, validBefore: real.validBefore, nonce: real.nonce });
    return m;
  };
  const forged = { domain: td.domain, types: td.types, primaryType: td.primaryType, message: forgedMsg() };
  /* The request IS the review's own signature (the same object), so "request = review" alone would not catch it. */
  no("getter fields in the request and the review", forged, { ...review, signatures: [{ ...review.signatures[0], typedData: forged }] });
  no("getter fields in the request only", { ...td, message: forgedMsg() }, review);
  const viaDomain = { ...td, domain: {} };
  Object.defineProperty(viaDomain.domain, "chainId", { enumerable: true, get: () => 8453 });
  Object.assign(viaDomain.domain, { name: td.domain.name, version: td.domain.version, verifyingContract: td.domain.verifyingContract });
  no("a getter in the domain", viaDomain, review);
  const getterReview = { ...review };
  Object.defineProperty(getterReview, "amountRaw", { enumerable: true, get: () => review.amountRaw });
  no("a getter on the review", td, getterReview);
  no("a symbol key in the message", { ...td, message: { ...real, [Symbol("x")]: 1 } }, review);
  const hidden = { ...real };
  Object.defineProperty(hidden, "extra", { value: STRANGER, enumerable: false });
  no("a hidden field in the message", { ...td, message: hidden }, review);
  class Msg { constructor() { Object.assign(this, real); } }
  no("a class instance as the message", { ...td, message: new Msg() }, review);
  const cyclic = JSON.parse(JSON.stringify(td));
  cyclic.types.Self = [cyclic.types];
  no("a cycle", cyclic, review);
  /* A Proxy over honest data cannot change its answer between the check and the build: it is read once. */
  let reads = 0;
  const proxied = new Proxy({ ...real }, { get(t, k) { reads++; return k === "to" && reads > 3 ? STRANGER : t[k]; } });
  const built = RC.recoverTypedDataFromRequest({ ...td, message: proxied }, review, EMBEDDED, { now });
  assert.ok(built === null || built.typedData.message.to === RS.RECOVER_RELAY.v3.approvalProxy, "never a stranger in what is signed");
  if (built) assert.deepEqual(built.typedData.message, real);
  /* The refusal's words: safety, not blame; the same in the bridge's error and Recover's own words. */
  assert.equal(new RC.RecoverSignRefused().message, "Stopped for safety before your wallet opened. Nothing moved. Try again.");
  assert.equal(new RC.RecoverSignRefused().message, RS.RECOVER_WORDS.refused);
  assert.match(code("src/lib/relay/recoverClosed.js"), /typedData = plainData\(typedDataIn\);\s*review = reviewSnapshot\(reviewIn\);/);
});

test("B11) 🔴 the bridge's Recover signer IS the visible hook: handed to Recover, Privy asked through the SHOWN instance with the window shown and the decoded words — and a refusal never reaches Privy", async () => {
  await recoverMods();
  for (const env of [{ VITE_PERP_ENABLED: "1" }, { VITE_PERP_ENABLED: "0" }]) {
    const perp = env.VITE_PERP_ENABLED === "1";
    const provided = [];
    const taken = [];
    const b = await mountBridge(env, {
      keep: ["src/avax/closedTx.js", "src/services/signWords.js", "src/lib/relay/recoverClosed.js"],
      impl: { provideRecoverSigner: (fn) => { provided.push(fn); return () => taken.push(fn); } },
    });
    const api = b.api();
    /* Still exactly the hooks there were: no new hook call for Recover. */
    assert.deepEqual(b.calls.hooks, perp ? ["useSignTypedData", "useSendTransaction", "useSignTypedData", "useSendTransaction"] : ["useSignTypedData", "useSendTransaction"]);
    assert.equal("embeddedAddress" in api, perp, "Recover does not register the silent signer's address");
    assert.equal(api.recover.address, EMBEDDED);
    assert.equal(provided.length, 1, "handed to Recover once");
    assert.equal(provided[0], api.recover.signTypedData, "the very function the bridge registered");
    assert.equal(provided[0].address, EMBEDDED, "naming the wallet it signs for");
    const shown = perp ? 1 : 0;
    for (const id of [8453, 137]) {
      /* The bridge reads the real clock: priced now, with the deadline a fresh quote carries. */
      const { review } = recoverReview(id, { at: Date.now(), vbIn: 500 });
      const td = review.signatures[0].typedData;
      assert.equal(await provided[0](td, review), `0x${"11".repeat(65)}`);
      const [input, opts, which] = b.calls.sign[b.calls.sign.length - 1];
      assert.equal(which, shown, "the SHOWN signTypedData hook, never the silent one");
      assert.equal(opts.address, EMBEDDED);
      assert.equal(opts.uiOptions.showWalletUIs, true, "the window is shown");
      assert.equal(opts.uiOptions.title, "Move into your balance");
      assert.match(opts.uiOptions.description, new RegExp(`^Move 10 USDC from your wallet on ${CHAIN_NAME[id]} into your balance\\.`));
      assert.equal(opts.uiOptions.buttonText, "Move in");
      assert.equal(input.domain.chainId, id, "the chain is the domain's: no switch");
      assert.equal(input.domain.verifyingContract, NATIVE_USDC[id]);
      assert.deepEqual(input.message, td.message);
    }
    const asked = b.calls.sign.length;
    const { review } = recoverReview(8453, { at: Date.now(), vbIn: 500 });
    const td = review.signatures[0].typedData;
    const refused = (e) => e.code === "refused" && e.message === "Stopped for safety before your wallet opened. Nothing moved. Try again.";
    for (const t of [
      { ...td, message: { ...td.message, to: STRANGER } },
      { ...td, message: { ...td.message, from: STRANGER } },
      { ...td, domain: { ...td.domain, chainId: 137 } },
      { ...td, domain: { ...td.domain, verifyingContract: USDBC_BASE } },
      { ...td, message: { ...td.message, value: "10000001" } },
      { ...td, message: { ...td.message, extra: 1 } },
    ]) await assert.rejects(() => api.recover.signTypedData(t, review), refused);
    await assert.rejects(() => api.recover.signTypedData(td, { ...review, own: STRANGER }), refused);
    /* Priced long ago: 10 s left on the permit is too late to open a window. */
    const late = recoverReview(8453, { at: Date.now() - 500000, vbIn: 510 });
    await assert.rejects(() => api.recover.signTypedData(late.review.signatures[0].typedData, late.review), refused);
    assert.equal(b.calls.sign.length, asked, "Privy was never asked for any of them");
    assert.deepEqual(b.calls.send, [], "Recover sends no transaction");
    b.h.unmount();
    assert.deepEqual(taken, [provided[0]], "taken back when the bridge goes");
  }
  /* Another wallet signed in: the review is not its own, so nothing opens. */
  const provided = [];
  const b = await mountBridge({ VITE_PERP_ENABLED: "1" }, {
    keep: ["src/avax/closedTx.js", "src/services/signWords.js", "src/lib/relay/recoverClosed.js"],
    address: STRANGER,
    impl: { provideRecoverSigner: (fn) => { provided.push(fn); return () => {}; } },
  });
  const { review } = recoverReview(8453, { at: Date.now(), vbIn: 500 });
  await assert.rejects(() => provided[0](review.signatures[0].typedData, review), (e) => e.code === "refused");
  assert.equal(b.calls.sign.length, 0);
  b.h.unmount();
});

test("B4b) services/privy hands out the visible Recover signer only once the bridge registered one, under its own key", async () => {
  fakeBrowser();
  globalThis.__impl = {};
  const Svc = await bundle({ entry: SVC, env: { VITE_PRIVY_APP_ID: "app" }, stubs: autoStubs([SVC]) });
  assert.equal(Svc.privyRecoverTypedSigner(), null, "nothing registered");
  Svc.registerPrivyApi({ ready: true, authenticated: true, embeddedAddress: EMBEDDED, signTypedDataSilently: async () => "0xsilent" });
  assert.equal(Svc.privyRecoverTypedSigner(), null, "the silent signer is never handed out as Recover's");
  const seen = [];
  Svc.registerPrivyApi({ ready: true, authenticated: true, recover: { address: EMBEDDED, signTypedData: async (td, review) => { seen.push([td, review]); return "0xsig"; } } });
  const r = Svc.privyRecoverTypedSigner();
  assert.equal(r.address, EMBEDDED);
  assert.equal(await r.signTypedData({ primaryType: "ReceiveWithAuthorization" }, { kind: "recover" }), "0xsig");
  assert.deepEqual(seen, [[{ primaryType: "ReceiveWithAuthorization" }, { kind: "recover" }]]);
  assert.equal(Svc.privySilentTypedSigner(), null, "and Recover's is never handed out as a silent one");
});

test("G1c) the bridge exports Recover's closed builder, never switches to Base or Polygon, and its Recover signer is built on the shown hook and handed to Recover once", () => {
  const c = code(BRIDGE);
  assert.match(c, /export\s*\{\s*recoverTypedDataFromRequest\s*\}/);
  assert.doesNotMatch(c, /switchChain\(\s*(8453|137|0x2105|0x89|BASE|POLYGON)/i);
  assert.equal((c.match(/switchChain\(/g) || []).length, 1, "the one switch there was: parking the wallet on Arbitrum at connect");
  const pair = c.slice(c.indexOf("const recover = useMemo"), c.indexOf("const pendingLogin"));
  assert.ok(pair.length > 200, "the Recover signer was found");
  assert.match(pair, /recoverTypedDataFromRequest\(typedData, review, embeddedAddress\)/);
  assert.match(pair, /shownRef\.current\.sign/);
  assert.match(pair, /signMessageUiOptions\(built\.words\)/);
  assert.doesNotMatch(pair, /showWalletUIs/, "no window flag of its own: signWords writes it, shown");
  assert.doesNotMatch(pair, /privySign|privySend|silent/i, "never the silent pair");
  assert.equal((c.match(/provideRecoverSigner\(/g) || []).length, 1);
  assert.match(c, /provideRecoverSigner\(recover\.signTypedData\)/);
  const rc = code("src/lib/relay/recoverClosed.js");
  assert.doesNotMatch(rc, /fetch\(|import\.meta\.env|process\.env|signTypedData\(|sendTransaction|privateKey|localStorage/, "the closed builder is pure");
});

/* ════════════════════════════════════════════════════════════════════════════
   H. THE SEAM: a Privy trader gets the silent signer; the ticket skips Enable
   ════════════════════════════════════════════════════════════════════════════ */

const LIVE = "src/perp/live/";
const HOOK = `${LIVE}usePerpBackend.js`;
const CONFIG = `${LIVE}config.js`;
const KEEP = [
  `${LIVE}perpLiveView.js`, `${LIVE}perpBackend.js`, `${LIVE}slide.js`, `${LIVE}storage.js`, "src/lib/format.js", "src/lib/hyperliquid/format.js",
  "src/lib/hyperliquid/exchange/orders.js", "src/lib/hyperliquid/exchange/master.js",
  "src/lib/hyperliquid/exchange/signing.js", "src/perp/mock/fees.js", "src/perp/perpTicket.js",
  "src/perp/mock/perpMockMath.js", CONFIG, "src/perp/mock/config.js",
];

async function seam(wallet, trading) {
  fakeBrowser();
  const made = [];
  const fakeTrader = {
    network: "mainnet", master: MASTER.toLowerCase(),
    isTradingEnabled: () => trading,
    subscribe: () => () => {}, version: () => 1,
    enableTrading: async () => ({ ok: true }), openMarket: async () => ({ ok: true }), addMarket: async () => ({ ok: true }),
    closeFraction: async () => ({ ok: true }), setTpSl: async () => ({ ok: true }), withdraw: async () => ({ ok: true }),
  };
  globalThis.__impl = {
    useWallet: () => wallet,
    usePerpAccount: (a) => ({ address: a }),
    createHlTrader: (o) => { made.push(o); return fakeTrader; },
    perpMarketsStore: () => ({ getSnapshot: () => ({ byCoin: {}, staleSince: null }), subscribe: () => () => {} }),
    usePerpAssetData: () => ({ answered: false }),
  };
  const stubs = autoStubs([HOOK, CONFIG], {
    keep: KEEP,
    extra: { "src/lib/hyperliquid/markets.js": { real: "src/lib/hyperliquid/markets.js", only: ["perpMarketsStore"] } },
  });
  const Mod = await bundle({ entry: HOOK, env: { VITE_PERP_ENABLED: "1" }, stubs });
  const h = Mod.mount(() => Mod.usePerpBackend());
  h.render(); h.flush();
  return { h, made };
}

test("H1) a Privy wallet: the trader is handed services/privy's silent signer, and the ticket sees trading as READY before any key exists", async () => {
  const { h, made } = await seam(
    { address: MASTER, signer: { tag: "signer" }, walletType: "privy", chainId: 43114, isConnected: true },
    { enabled: false, auto: true, state: "none", agentAddress: null, validUntil: null, reason: null, persisted: null },
  );
  assert.equal(made.length, 1);
  assert.equal(typeof made[0].silentSigner, "function");
  assert.equal(made[0].silentSigner.__stub, "privySilentTypedSigner", "the one reader of the bridge's silent signer");
  const t = h.value.trading;
  assert.equal(t.enabled, true, "no Enable trading step for Privy: the first trade enables itself");
  assert.equal(t.auto, true);
  assert.equal(t.keyActive, false, "the key itself is not there yet");
  h.unmount();
});

test("H2) an injected wallet: no silent signer, and trading is enabled only by a live key", async () => {
  const { h, made } = await seam(
    { address: MASTER, signer: { tag: "signer" }, walletType: "metamask", chainId: 43114, isConnected: true },
    { enabled: false, auto: false, state: "none", agentAddress: null, validUntil: null, reason: null, persisted: null },
  );
  assert.equal(made[0].silentSigner, null);
  assert.equal(h.value.trading.enabled, false);
  assert.equal(h.value.trading.auto, false);
  h.unmount();
});

/* ════════════════════════════════════════════════════════════════════════════
   G. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

test("G1) the bridge asks Privy for NO window in exactly two places — the two Enable trading approvals and the one transfer that funds a first deposit — and only behind the Perp flag", () => {
  const c = code(BRIDGE);
  assert.match(c, /useSignTypedData/);
  assert.match(c, /PERP_ENABLED\s*\?\s*useSignTypedData/);
  /* 🔴 THE COUNT IS THE POINT. It was one for a year: Enable trading's two
     approvals, which authorise a key that can only trade. The second is the
     transfer that finishes a first deposit (B5/B6 above) — money MOVING, which
     is why it is a closed builder over one destination, one token, one chain and
     a floor, and why this number must be argued for before it changes again. A
     withdrawal is still not here and keeps its window. */
  assert.match(c, /PERP_ENABLED\s*\?\s*useSendTransaction/);
  assert.equal((c.match(/showWalletUIs\s*:\s*false/g) || []).length, 2);
  assert.match(c, /HyperliquidTransaction:ApproveAgent/);
  assert.match(c, /HyperliquidTransaction:ApproveBuilderFee/);
  assert.doesNotMatch(c, /HyperliquidTransaction:Withdraw/, "the withdrawal type is never on the silent list");
  assert.match(c, /0xaf88d065e77c8cc2239327c5edb3a432268e5831/, "native USDC on Arbitrum, written out");
  assert.match(c, /0x2df1c51e09aecf9cacb7bc98cb1742757f163df7/, "the deposit contract, written out");
  assert.match(c, /minRaw: 5000000n/, "the floor below which a transfer is never credited");
});

test("G2) withdraw keeps its prompt: the trader's withdraw path never passes the silent signer, and there is no key export left to silence", () => {
  const client = code("src/lib/hyperliquid/exchange/client.js");
  const w = client.slice(client.indexOf("async withdraw("), client.indexOf("async function doEnable"));
  assert.ok(w.length > 100, "the withdraw body was found");
  assert.doesNotMatch(w, /silent/i, "withdraw must not reach the silent signer");
  assert.doesNotMatch(code(SVC), /exportPrivyWallet|exportWallet/, "the export the owner removed cannot come back as a silent one");
  const m = code("src/lib/hyperliquid/exchange/master.js");
  assert.match(m, /HL_SILENT_MASTER_ACTIONS\s*=\s*Object\.freeze\(\[\s*"approveAgent",\s*"approveBuilderFee"\s*\]\)/);
});
