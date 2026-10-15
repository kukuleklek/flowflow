/**
 * test-hl-exchange-client — THE ONE FACADE THE PERP PAGE CALLS, AGAINST A FAKE HYPERLIQUID.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner: "ใช้ Privy นั้นแหละ คุม ทำเลยพวก ให้แม่งเทรดได้จริงเลย" / "ในหน้าซื้อขาย
 * หน้า Position อะ ทำ Full Wire" — the trade page and the position page, fully
 * wired, really trading, controlled by the user's own wallet.
 *
 * createHlTrader({master, signer, walletType, chainId, market, builder}) is run
 * end to end against a FAKE Hyperliquid (fetch is injected; the real global
 * fetch is replaced by a thrower for the whole file, so a slip cannot reach the
 * network). Every body the fake receives is checked the way Hyperliquid would
 * check it: the signature is RECOVERED — L1 bodies must recover to the agent
 * key, user-signed bodies to the master — and the nonce must be fresh.
 *
 *   E. enableTrading: approveAgent (+ approveBuilderFee only when configured and
 *      not already approved), WalletConnect refused, a foreign signer refused,
 *      a declined popup and "Must deposit" handled, the key rotated on renewal;
 *   O. openMarket: isolated leverage first, then ONE IOC; TP/SL ride a
 *      normalTpsl group and are VERIFIED after the fill, and a partial fill that
 *      dropped them gets positionTpsl for the real size; orphaned triggers of a
 *      closed position are cleared before a new open; an existing position
 *      is refused; the builder field only when configured;
 *   A. addMarket: the position's own leverage, and a fixed-size TP/SL is
 *      re-placed to cover the new size (place first, cancel after);
 *   C. closeFraction: reduce-only; a full close clears the coin's triggers;
 *   T. setTpSl: place the new trigger FIRST, cancel the old one AFTER; a failed
 *      place cancels nothing;
 *   W. withdraw: to the user's OWN address only, amount rules, fee and chain;
 *   F. failures: agent pruned mid-session -> Enable trading again; a lost reply
 *      is looked up by cloid and NEVER re-sent; nothing secret leaks.
 *
 * Run: node --test scripts/test-hl-exchange-client.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EX = (f) => pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/exchange", f)).href;

let realNetworkAttempts = 0;
globalThis.fetch = () => { realNetworkAttempts++; throw new Error("test-hl-exchange-client: a real network call was attempted"); };

/* The official Python SDK's public test key plays the user's wallet. */
const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x14791697260E4c9A71f18484C9f997B308e59325";
const BUILDER = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

let C, N, S, A, NC, viem, viemAccounts, ethers;
before(async () => {
  C = await import(EX("client.js"));
  N = await import(EX("network.js"));
  S = await import(EX("signing.js"));
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
  ETH: { coin: "ETH", assetIndex: 1, szDecimals: 4, maxLeverage: 25, midPx: 2900, markPx: 2900, px: 2900, onlyIsolated: false, marginMode: null },
};

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

/* A wallet behind ethers' BrowserProvider — what WalletContext hands us. It sits on Arbitrum (42161), where FlowFlow
   parks its Privy wallet: a Privy wallet's user-signed actions are pinned to signatureChainId 0xa4b1 (client.js
   masterGate, so the Avax Wallet's 43114 signing can never reach them), and this wallet, like MetaMask, refuses typed
   data for any other chain. */
function chainWallet(key = PY_KEY) {
  const account = viemAccounts.privateKeyToAccount(key);
  const prompts = [];
  let decline = false;
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0xa4b1";
      if (method === "net_version") return "42161";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const data = JSON.parse(params[1]);
        prompts.push(data);
        if (decline) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        if (Number(data.domain.chainId) !== 42161) throw new Error(`Provided chainId "${data.domain.chainId}" must match the active chainId "42161"`);
        return account.signTypedData({ domain: data.domain, types: data.types, primaryType: data.primaryType, message: data.message });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, prompts, decline(v = true) { decline = v; }, address: account.address };
}

/* A fake Hyperliquid. State is mutable so a script can move it between calls. */
function fakeHl(init = {}) {
  const profile = MAIN();
  const st = {
    positions: {}, openOrders: [], maxBuilderFee: 0, time: T0, nextOid: 9000,
    ...init,
  };
  const posts = [];
  const infos = [];
  const script = init.script || {};
  const res = (obj, status = 200) => new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const defaultOrderReply = (body) => ({
    status: "ok",
    response: { type: "order", data: { statuses: body.action.orders.map((o, i) => {
      if (o.t.trigger) return body.action.grouping === "normalTpsl" && i > 0 ? "waitingForTrigger" : { resting: { oid: st.nextOid++ } };
      return { filled: { totalSz: o.s, avgPx: o.p, oid: st.nextOid++ } };
    }) } },
  });
  async function fetchImpl(url, reqInit) {
    const body = JSON.parse(reqInit.body);
    if (url === profile.infoUrl) {
      infos.push(body);
      if (script.info) { const r = script.info(body, st); if (r !== undefined) return res(r); }
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
      if (r instanceof Error) throw r;
      if (r && r.$status) return res(r.body, r.$status);
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

async function trader({ hl = fakeHl(), wallet = chainWallet(), walletType = "privy", builder = { address: "", feeTenthsBp: 0 }, now = () => T0, storage = memStorage(), master = MASTER } = {}) {
  const signer = await new ethers.BrowserProvider(wallet.provider).getSigner();
  const agents = A.createAgentStore({ profile: MAIN(), storage, now });
  const nonces = NC.createNonceAllocator({ profile: MAIN(), storage, locks: null, now });
  const t = C.createHlTrader({
    master, signer, walletType, chainId: 42161,
    market: (coin) => MARKETS[coin] || null,
    builder,
    profile: MAIN(),
    deps: { fetchImpl: hl.fetchImpl, agents, nonces, randomCloid: nextCloid, now },
  });
  return { t, hl, wallet, agents, nonces, storage };
}

const ZERO = "0x0000000000000000000000000000000000000000";
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

async function enabled(opts = {}) {
  const ctx = await trader(opts);
  const r = await ctx.t.enableTrading();
  assert.equal(r.ok, true, JSON.stringify(r));
  ctx.agent = r.agentAddress;
  ctx.hl.posts.length = 0;
  ctx.hl.infos.length = 0;
  ctx.promptsBefore = ctx.wallet.prompts.length;
  return ctx;
}

/* ════════════════════════════════════════════════════════════════════════════
   E. ENABLE TRADING
   ════════════════════════════════════════════════════════════════════════════ */

test("E1) enableTrading, builder off: ONE wallet prompt (approveAgent on 0xa4b1), a named 24h agent, recovered to the master", async () => {
  const { t, hl, wallet, agents } = await trader();
  assert.equal(t.isTradingEnabled().enabled, false);
  const r = await t.enableTrading();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.signatures, 1);
  assert.equal(r.validUntil, T0 + DAY);
  assert.equal(wallet.prompts.length, 1);
  assert.equal(hl.posts.length, 1);
  const body = hl.posts[0];
  assert.deepEqual(Object.keys(body).sort(), ["action", "nonce", "signature"]);
  assert.equal(body.action.type, "approveAgent");
  assert.equal(body.action.signatureChainId, "0xa4b1");
  assert.equal(body.action.hyperliquidChain, "Mainnet");
  assert.equal(body.action.agentAddress, r.agentAddress);
  assert.equal(body.action.agentName, `flowflow valid_until ${T0 + DAY}`);
  assert.equal(body.nonce, body.action.nonce, "the outer nonce must equal the action's (exchange-endpoint docs)");
  assert.equal(await recoverUser(body), MASTER.toLowerCase());
  assert.equal(agents.status(MASTER).state, "active");
  assert.equal(t.isTradingEnabled().enabled, true);
  assert.equal(hl.infos.filter((b) => b.type === "maxBuilderFee").length, 0, "no builder configured: nothing to check or approve");
  assert.equal(realNetworkAttempts, 0);
});

test("E2) builder on: approveAgent AND approveBuilderFee (0.05%) the first time; a renewal once maxBuilderFee covers f is ONE signature, with a NEW key", async () => {
  const builder = { address: BUILDER, feeTenthsBp: 50 };
  const hl = fakeHl({ maxBuilderFee: 0 });
  let now = T0;
  const { t, wallet } = await trader({ hl, builder, now: () => now });
  const r = await t.enableTrading();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.signatures, 2);
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["approveAgent", "approveBuilderFee"]);
  const bf = hl.posts[1];
  assert.equal(bf.action.maxFeeRate, "0.05%");
  assert.equal(bf.action.builder, BUILDER);
  assert.equal(await recoverUser(bf), MASTER.toLowerCase(), "the MAIN wallet signs the builder approval, never the agent");
  hl.st.maxBuilderFee = 50;
  now = T0 + DAY;
  hl.st.time = now;
  assert.equal(t.isTradingEnabled().enabled, false, "the key expired");
  hl.posts.length = 0;
  const again = await t.enableTrading();
  assert.equal(again.ok, true);
  assert.equal(again.signatures, 1);
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["approveAgent"]);
  assert.notEqual(again.agentAddress, r.agentAddress, "never reuse an agent address");
  assert.equal(wallet.prompts.length, 3);
});

test("E3) WalletConnect is refused plainly — its session is pinned to one chain — with no request and no prompt", async () => {
  const { t, hl, wallet } = await trader({ walletType: "walletconnect" });
  for (const r of [await t.enableTrading(), await t.withdraw(20)]) {
    assert.equal(r.ok, false);
    assert.equal(r.code, "walletconnect_unsupported");
    assert.match(r.message, /WalletConnect/);
  }
  assert.equal(hl.posts.length + hl.infos.length, 0);
  assert.equal(wallet.prompts.length, 0);
});

test("E4) a signer that is not the master is refused: an agent approved by the wrong wallet would trade someone else's account", async () => {
  const other = chainWallet("0x0000000000000000000000000000000000000000000000000000000000000abc");
  const { t, hl } = await trader({ wallet: other });
  const r = await t.enableTrading();
  assert.equal(r.code, "wallet_mismatch");
  assert.equal(hl.posts.length, 0);
});

test("E5) a declined popup is 'signature_rejected', and the unapproved key is thrown away", async () => {
  const w = chainWallet();
  w.decline();
  const { t, hl, agents } = await trader({ wallet: w });
  const r = await t.enableTrading();
  assert.equal(r.ok, false);
  assert.equal(r.code, "signature_rejected");
  assert.equal(hl.posts.length, 0);
  assert.equal(agents.status(MASTER).state, "none");
});

test("E6) 'Must deposit before performing actions' (a brand-new address) maps to must_deposit, and the key is discarded", async () => {
  const hl = fakeHl({ script: { approveAgent: () => ({ status: "err", response: `Must deposit before performing actions. User: ${MASTER.toLowerCase()}` }) } });
  const { t, agents } = await trader({ hl });
  const r = await t.enableTrading();
  assert.equal(r.ok, false);
  assert.equal(r.code, "must_deposit");
  assert.match(r.message, /[Dd]eposit/);
  assert.match(r.hlText, /Must deposit/);
  assert.equal(agents.status(MASTER).state, "none");
});

test("E7) a half-set builder config is refused at Enable trading, before any prompt", async () => {
  const { t, hl, wallet } = await trader({ builder: { address: "", feeTenthsBp: 50 } });
  const r = await t.enableTrading();
  assert.equal(r.code, "builder_config_invalid");
  assert.equal(hl.posts.length + wallet.prompts.length, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   O. OPEN
   ════════════════════════════════════════════════════════════════════════════ */

test("O1) openMarket before Enable trading: needs_enable, nothing sent", async () => {
  const { t, hl } = await trader();
  const r = await t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "needs_enable");
  assert.equal(r.needsEnable, true);
  assert.equal(hl.posts.length, 0);
});

test("O2) openMarket, no TP/SL: isolated leverage, then ONE IOC — both signed by the AGENT, no popup, fresh increasing nonces", async () => {
  const ctx = await enabled();
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ctx.hl.posts.map((b) => b.action.type), ["updateLeverage", "order"]);
  assert.deepEqual(ctx.hl.posts[0].action, { type: "updateLeverage", asset: 0, isCross: false, leverage: 5 });
  const order = ctx.hl.posts[1].action;
  assert.equal(order.grouping, "na");
  assert.equal("builder" in order, false, "builder off: the key does not exist");
  assert.deepEqual(order.orders.map((o) => ({ a: o.a, b: o.b, p: o.p, s: o.s, r: o.r, t: o.t })), [{ a: 0, b: true, p: "90008", s: "0.00117", r: false, t: { limit: { tif: "Ioc" } } }]);
  for (const b of ctx.hl.posts) assert.equal(await recoverL1(b), ctx.agent, `${b.action.type} recovers to the agent`);
  assert.ok(ctx.hl.posts[1].nonce > ctx.hl.posts[0].nonce);
  assert.equal(ctx.wallet.prompts.length, ctx.promptsBefore, "the master wallet was never asked");
  assert.equal(r.status, "filled");
  assert.deepEqual({ totalSz: r.filled.totalSz, avgPx: r.filled.avgPx }, { totalSz: "0.00117", avgPx: "90008" });
  assert.equal(r.partial, false);
  assert.equal(r.size, "0.00117");
  assert.equal(r.leverage, 5);
  assert.deepEqual(ctx.hl.infos.map((b) => b.type), ["clearinghouseState", "frontendOpenOrders"], "position and orphan checks, both read-only");
});

test("O3) builder on: the order carries {b, f} after grouping", async () => {
  const ctx = await enabled({ builder: { address: BUILDER, feeTenthsBp: 10 }, hl: fakeHl({ maxBuilderFee: 10 }) });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "sell", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, true);
  const order = ctx.hl.posts.find((b) => b.action.type === "order").action;
  assert.deepEqual(order.builder, { b: BUILDER, f: 10 });
  assert.deepEqual(Object.keys(order), ["type", "orders", "grouping", "builder"]);
});

test("O4) TP/SL on the entry ride ONE normalTpsl group, and are VERIFIED after the fill — present, so nothing more is sent", async () => {
  const hl = fakeHl({
    script: {
      order(body, st) {
        const [entry, tp, sl] = body.action.orders;
        st.openOrders = [
          { coin: "SOL", side: "A", limitPx: tp.p, sz: tp.s, oid: 501, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: tp.t.trigger.triggerPx, children: [], isPositionTpsl: false, reduceOnly: true, orderType: "Take Profit Market", origSz: tp.s, tif: null, cloid: tp.c },
          { coin: "SOL", side: "A", limitPx: sl.p, sz: sl.s, oid: 502, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: sl.t.trigger.triggerPx, children: [], isPositionTpsl: false, reduceOnly: true, orderType: "Stop Market", origSz: sl.s, tif: null, cloid: sl.c },
        ];
        st.positions.SOL = { szi: entry.s, leverage: 4 };
        return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: entry.s, avgPx: "116.8", oid: 500 } }, "waitingForTrigger", "waitingForTrigger"] } } };
      },
    },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.openMarket({ coin: "SOL", side: "buy", marginUsdc: 50, leverage: 4, tp: 130, sl: 110 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const order = hl.posts.find((b) => b.action.type === "order").action;
  assert.equal(order.grouping, "normalTpsl");
  assert.deepEqual(order.orders.map((o) => o.t.trigger ? o.t.trigger.tpsl : "entry"), ["entry", "tp", "sl"]);
  assert.deepEqual(r.tpsl, { tp: "placed", sl: "placed" });
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["updateLeverage", "order"], "verified present: no second placement");
  assert.equal(hl.infos.filter((b) => b.type === "frontendOpenOrders").length, 2, "one orphan check before, one verification after");
});

test("O5) 🔴 a PARTIAL IOC fill drops the normalTpsl children (TP/SL docs): the client places positionTpsl for the REAL size", async () => {
  const hl = fakeHl({
    script: {
      order(body, st) {
        if (body.action.grouping === "positionTpsl") return undefined;
        st.positions.SOL = { szi: "0.9", leverage: 4 };
        st.openOrders = [];
        return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.9", avgPx: "116.9", oid: 600 } }, "waitingForFill", "waitingForFill"] } } };
      },
    },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.openMarket({ coin: "SOL", side: "buy", marginUsdc: 50, leverage: 4, tp: 130, sl: 110 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.partial, true);
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["updateLeverage", "order", "order"]);
  const fix = hl.posts[2].action;
  assert.equal(fix.grouping, "positionTpsl");
  assert.deepEqual(fix.orders.map((o) => [o.t.trigger.tpsl, o.t.trigger.triggerPx, o.s, o.r, o.b]), [["tp", "130", "0.9", true, false], ["sl", "110", "0.9", true, false]]);
  assert.deepEqual(r.tpsl, { tp: "placed_after_fill", sl: "placed_after_fill" });
  assert.equal(await recoverL1(hl.posts[2]), ctx.agent);
});

test("O6) the verification read failing is reported as 'unverified' — never as placed", async () => {
  const hl = fakeHl({
    script: {
      info(body, st) { if (body.type === "frontendOpenOrders" && st.filledOnce) return "not json at all"; return undefined; },
      order(body, st) { st.filledOnce = true; st.positions.SOL = { szi: "1.71", leverage: 4 }; return undefined; },
    },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.openMarket({ coin: "SOL", side: "buy", marginUsdc: 50, leverage: 4, sl: 110 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tpsl, { tp: "not_requested", sl: "unverified" });
});

test("O7) an existing position is refused (use addMarket or close); the read failing is 'state_unknown', never assumed flat", async () => {
  const ctx = await enabled({ hl: fakeHl({ positions: { BTC: { szi: "0.001", leverage: 5 } } }) });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.code, "position_exists");
  assert.equal(ctx.hl.posts.length, 0);
  const broken = await enabled({ hl: fakeHl({ script: { info: (b) => (b.type === "clearinghouseState" ? { nope: 1 } : undefined) } }) });
  const r2 = await broken.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r2.code, "state_unknown");
  assert.equal(broken.hl.posts.length, 0);
});

test("O8) a closed position's leftover reduce-only triggers are cancelled BEFORE a new open — an old stop must not close the new position", async () => {
  const leftovers = [
    { coin: "BTC", side: "A", limitPx: "80000", sz: "0.002", oid: 71, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: "80000", children: [], isPositionTpsl: false, reduceOnly: true, orderType: "Stop Market", origSz: "0.002", tif: null, cloid: null },
    { coin: "ETH", side: "A", limitPx: "2000", sz: "1", oid: 72, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: "2000", children: [], isPositionTpsl: false, reduceOnly: true, orderType: "Stop Market", origSz: "1", tif: null, cloid: null },
  ];
  const ctx = await enabled({ hl: fakeHl({ openOrders: leftovers }) });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.hl.posts.map((b) => b.action.type), ["cancel", "updateLeverage", "order"]);
  assert.deepEqual(ctx.hl.posts[0].action.cancels, [{ a: 0, o: 71 }], "only this coin's orphans");
  assert.deepEqual(r.clearedOrphans, [71]);
});

test("O9) a refused order maps to plain English and keeps Hyperliquid's text; the leverage change failing stops the order", async () => {
  const hl = fakeHl({ script: { order: () => ({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin to place order. asset=0" }] } } }) } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "insufficient_margin");
  assert.equal(r.hlText, "Insufficient margin to place order. asset=0");
  const hl2 = fakeHl({ script: { updateLeverage: () => ({ status: "err", response: "Cannot switch leverage type with open position." }) } });
  const ctx2 = await enabled({ hl: hl2 });
  const r2 = await ctx2.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r2.ok, false);
  assert.equal(r2.message, "Cannot switch leverage type with open position.", "unknown text passes through verbatim");
  assert.deepEqual(hl2.posts.map((b) => b.action.type), ["updateLeverage"], "no order after a failed leverage change");
});

/* ════════════════════════════════════════════════════════════════════════════
   A. ADD
   ════════════════════════════════════════════════════════════════════════════ */

test("A1) addMarket: same side at the position's own leverage, no leverage change; a fixed-size stop is re-placed to cover the new size, place first", async () => {
  const hl = fakeHl({
    positions: { ETH: { szi: "-0.5", leverage: 10 } },
    openOrders: [{ coin: "ETH", side: "B", limitPx: "3100", sz: "0.5", oid: 81, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: "3100", children: [], isPositionTpsl: false, reduceOnly: true, orderType: "Stop Market", origSz: "0.5", tif: null, cloid: null }],
    script: { order(body, st) { if (body.action.grouping === "na") st.positions.ETH = { szi: "-0.569", leverage: 10 }; return undefined; } },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.addMarket({ coin: "ETH", marginUsdc: 20 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["order", "order", "cancel"]);
  assert.deepEqual(hl.posts[0].action.orders.map((o) => [o.b, o.s, o.r]), [[false, "0.069", false]]);
  assert.equal(hl.posts[1].action.grouping, "positionTpsl");
  assert.deepEqual(hl.posts[1].action.orders.map((o) => [o.t.trigger.tpsl, o.t.trigger.triggerPx, o.s]), [["sl", "3100", "0.569"]]);
  assert.deepEqual(hl.posts[2].action.cancels, [{ a: 1, o: 81 }]);
  assert.deepEqual(r.tpslResized, ["sl"]);
});

/* ════════════════════════════════════════════════════════════════════════════
   C. CLOSE
   ════════════════════════════════════════════════════════════════════════════ */

test("C1) closeFraction 50%: one reduce-only IOC on the closing side; the stop stays", async () => {
  const ctx = await enabled({ hl: fakeHl({ positions: { SOL: { szi: "-3.5", leverage: 4 } } }) });
  const r = await ctx.t.closeFraction("SOL", 0.5);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ctx.hl.posts.map((b) => b.action.type), ["order"]);
  const o = ctx.hl.posts[0].action.orders[0];
  assert.deepEqual([o.b, o.s, o.r, o.t], [true, "1.75", true, { limit: { tif: "Ioc" } }]);
  assert.equal(r.closesAll, false);
  assert.equal(await recoverL1(ctx.hl.posts[0]), ctx.agent);
});

test("C2) closeFraction 100% sends the exact size, then clears the coin's leftover triggers", async () => {
  const hl = fakeHl({
    positions: { SOL: { szi: "3.51", leverage: 4 } },
    openOrders: [{ coin: "SOL", side: "A", limitPx: "110", sz: "3.51", oid: 91, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: "110", children: [], isPositionTpsl: true, reduceOnly: true, orderType: "Stop Market", origSz: "3.51", tif: null, cloid: null }],
    script: { order(body, st) { delete st.positions.SOL; return undefined; } },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.closeFraction("SOL", 1);
  assert.equal(r.ok, true);
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["order", "cancel"]);
  assert.equal(hl.posts[0].action.orders[0].s, "3.51");
  assert.deepEqual(hl.posts[1].action.cancels, [{ a: 5, o: 91 }]);
  assert.deepEqual(r.cleanup, { cancelled: [91], failed: [] });
});

test("C3) nothing to close is said plainly", async () => {
  const ctx = await enabled();
  const r = await ctx.t.closeFraction("SOL", 1);
  assert.equal(r.code, "no_position");
  assert.equal(ctx.hl.posts.length, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   T. TP/SL EDITS
   ════════════════════════════════════════════════════════════════════════════ */

const oldSl = { coin: "BTC", side: "A", limitPx: "80000", sz: "0.002", oid: 21, timestamp: 1, triggerCondition: "", isTrigger: true, triggerPx: "80000", children: [], isPositionTpsl: true, reduceOnly: true, orderType: "Stop Market", origSz: "0.002", tif: null, cloid: null };

test("T1) 🔴 moving the stop: the NEW trigger is placed first, the OLD one cancelled after — never a moment without a stop", async () => {
  const ctx = await enabled({ hl: fakeHl({ positions: { BTC: { szi: "0.002", leverage: 5 } }, openOrders: [oldSl] }) });
  const r = await ctx.t.setTpSl("BTC", { sl: 82000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ctx.hl.posts.map((b) => b.action.type), ["order", "cancel"]);
  assert.equal(ctx.hl.posts[0].action.grouping, "positionTpsl");
  assert.equal(ctx.hl.posts[0].action.orders[0].t.trigger.triggerPx, "82000");
  assert.deepEqual(ctx.hl.posts[1].action.cancels, [{ a: 0, o: 21 }]);
  assert.ok(ctx.hl.posts[1].nonce > ctx.hl.posts[0].nonce);
  assert.deepEqual(r.cancelled, [21]);
  assert.equal(r.placed.sl.triggerPx, "82000");
});

test("T2) a failed placement cancels NOTHING — the old stop keeps guarding the position", async () => {
  const hl = fakeHl({ positions: { BTC: { szi: "0.002", leverage: 5 } }, openOrders: [oldSl], script: { order: () => ({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Invalid TP/SL price. asset=0" }] } } }) } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.setTpSl("BTC", { sl: 82000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_tpsl");
  assert.deepEqual(hl.posts.map((b) => b.action.type), ["order"], "no cancel was sent");
});

test("T3) the old order already gone is fine; any other cancel failure is reported (two stops beat none) for a retry", async () => {
  const gone = fakeHl({ positions: { BTC: { szi: "0.002", leverage: 5 } }, openOrders: [oldSl], script: { cancel: () => ({ status: "ok", response: { type: "cancel", data: { statuses: [{ error: "Order was never placed, already canceled, or filled." }] } } }) } });
  const a = await enabled({ hl: gone });
  const r = await a.t.setTpSl("BTC", { sl: 82000 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.cancelled, [21]);
  assert.deepEqual(r.cancelFailed, []);
  const stuck = fakeHl({ positions: { BTC: { szi: "0.002", leverage: 5 } }, openOrders: [oldSl], script: { cancel: () => new Error("socket hang up") } });
  const b = await enabled({ hl: stuck });
  const r2 = await b.t.setTpSl("BTC", { sl: 82000 });
  assert.equal(r2.ok, true, "the new stop IS in place");
  assert.deepEqual(r2.cancelFailed, [21]);
  assert.match(r2.warning, /old/i);
});

test("T4) removing a TP (null) only cancels; a TP on the wrong side is refused before anything is signed", async () => {
  const tpOrder = { ...oldSl, oid: 22, orderType: "Take Profit Market", triggerPx: "95000" };
  const ctx = await enabled({ hl: fakeHl({ positions: { BTC: { szi: "0.002", leverage: 5 } }, openOrders: [oldSl, tpOrder] }) });
  const r = await ctx.t.setTpSl("BTC", { tp: null });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.hl.posts.map((b) => b.action.type), ["cancel"]);
  assert.deepEqual(ctx.hl.posts[0].action.cancels, [{ a: 0, o: 22 }]);
  ctx.hl.posts.length = 0;
  const bad = await ctx.t.setTpSl("BTC", { tp: 80000 });
  assert.equal(bad.code, "invalid_tpsl");
  assert.equal(ctx.hl.posts.length, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   W. WITHDRAW
   ════════════════════════════════════════════════════════════════════════════ */

test("W1) withdraw goes where the CONFIRM SCREEN said: one master prompt, withdraw3 on 0xa4b1, $1 fee, Arbitrum, ~5 minutes", async () => {
  const { t, hl, wallet } = await trader();
  /* Owner, 2026-09-22: "withdraw คือให้ใส่ เลข Wallet ได้ด้วยดิวะ". The destination
     is explicit — the user's own address here, a pasted one when they paste
     one — and there is no default inside the trading layer (test-perp-sendasset
     W2 pins that a missing one is refused rather than sent to the wallet). */
  const r = await t.withdraw(25.5, { destination: MASTER });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(hl.posts.length, 1);
  const body = hl.posts[0];
  assert.deepEqual(body.action, { type: "withdraw3", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", destination: MASTER.toLowerCase(), amount: "25.5", time: body.nonce });
  assert.equal(await recoverUser(body), MASTER.toLowerCase());
  assert.equal(wallet.prompts.length, 1);
  assert.deepEqual({ amountUsdc: r.amountUsdc, feeUsdc: r.feeUsdc, receiveUsdc: r.receiveUsdc, destination: r.destination, chain: r.chain, etaMinutes: r.etaMinutes },
    { amountUsdc: "25.5", feeUsdc: 1, receiveUsdc: 24.5, destination: MASTER, chain: "Arbitrum One", etaMinutes: 5 },
    "the answer gives the address back exactly as it was confirmed, never re-cased");
});

test("W2) withdraw amounts: must beat the $1 fee, at most 6 decimals, a real number — refused, never rounded", async () => {
  const { t, hl, wallet } = await trader();
  for (const [amt, code] of [[1, "withdraw_too_small"], [0.5, "withdraw_too_small"], [1.1234567, "bad_input"], ["abc", "bad_input"], [-5, "bad_input"], [NaN, "bad_input"]]) {
    const r = await t.withdraw(amt, { destination: MASTER });
    assert.equal(r.ok, false, String(amt));
    assert.equal(r.code, code, String(amt));
  }
  assert.equal(hl.posts.length + wallet.prompts.length, 0);
  const ok = await t.withdraw("13.104114", { destination: MASTER });
  assert.equal(ok.ok, true);
  assert.equal(hl.posts[0].action.amount, "13.104114");
});

/* ════════════════════════════════════════════════════════════════════════════
   F. FAILURES AND SECRETS
   ════════════════════════════════════════════════════════════════════════════ */

test("F1) the agent pruned mid-session ('User or API Wallet ... does not exist') -> needs Enable trading again", async () => {
  const hl = fakeHl({ script: { updateLeverage: (b) => ({ status: "err", response: `User or API Wallet ${"0x" + "ab".repeat(20)} does not exist.` }) } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "agent_missing");
  assert.equal(r.needsEnable, true);
  assert.equal(ctx.agents.status(MASTER).state, "rejected");
  assert.equal(ctx.t.isTradingEnabled().enabled, false);
});

test("F2) 🔴 a lost reply is NEVER re-sent: the order is looked up by its cloid; found filled -> reported; not found -> unknown_outcome", async () => {
  let lookups = 0;
  const hl = fakeHl({
    script: {
      order: () => new Error("network down"),
      info(body) {
        if (body.type !== "orderStatus") return undefined;
        lookups++;
        return { status: "order", order: { order: { coin: "BTC", side: "B", limitPx: "90008", sz: "0", oid: 777, timestamp: 1, origSz: "0.00117", cloid: body.oid }, status: "filled", statusTimestamp: 2 } };
      },
    },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(hl.posts.filter((b) => b.action.type === "order").length, 1, "sent once, never again");
  assert.equal(lookups, 1);
  assert.equal(r.ok, true);
  assert.equal(r.status, "filled");
  assert.equal(r.recovered, true);
  const orderBody = hl.posts.find((b) => b.action.type === "order");
  assert.equal(hl.infos.find((b) => b.type === "orderStatus").oid, orderBody.action.orders[0].c, "looked up by the entry's cloid");

  const hl2 = fakeHl({ script: { order: () => new Error("network down") } });
  const ctx2 = await enabled({ hl: hl2 });
  const r2 = await ctx2.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "unknown_outcome");
  assert.match(r2.message, /position/i);
  assert.equal(hl2.posts.filter((b) => b.action.type === "order").length, 1);
});

test("F3) HTTP 429 is rate_limited, not a crash", async () => {
  const ctx = await enabled({ hl: fakeHl({ script: { updateLeverage: () => ({ $status: 429, body: "Too Many Requests" }) } }) });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.code, "rate_limited");
});

test("F4) the server's clock corrects the nonce: a phone 3 days slow still signs inside Hyperliquid's window", async () => {
  const serverTime = T0;
  const local = T0 - 3 * DAY;
  const ctx = await enabled({ hl: fakeHl({ time: serverTime }), now: () => local });
  await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  const nonce = ctx.hl.posts[0].nonce;
  assert.ok(NC.isNonceInWindow(nonce, serverTime), `nonce ${nonce} vs server ${serverTime}`);
});

test("F5) nothing secret leaks: the agent's private key is in no request, no result and no error", async () => {
  const hl = fakeHl({ script: { order: () => ({ status: "err", response: "boom" }) } });
  const ctx = await enabled({ hl });
  const results = [
    await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 }),
    ctx.t.isTradingEnabled(),
  ];
  const rec = ctx.agents.read(MASTER);
  assert.ok(rec && rec.privateKey);
  const secret = rec.privateKey.slice(2).toLowerCase();
  const everything = JSON.stringify([hl.posts, hl.infos, results]).toLowerCase();
  assert.equal(everything.includes(secret), false);
  assert.equal(realNetworkAttempts, 0, "and not one real request in the whole file");
});

test("F6) disableTrading wipes this master's key; a trader built with production defaults opens nothing until asked", async () => {
  const ctx = await enabled();
  ctx.t.disableTrading();
  assert.equal(ctx.t.isTradingEnabled().enabled, false);
  assert.equal(ctx.agents.status(MASTER).state, "none");
  const signer = await new ethers.BrowserProvider(chainWallet().provider).getSigner();
  const prod = C.createHlTrader({ master: MASTER, signer, walletType: "privy", chainId: 42161, market: () => null, builder: {} });
  assert.equal(prod.network, "mainnet");
  const r = await prod.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(realNetworkAttempts, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   G. MORE GUARDRAILS
   ════════════════════════════════════════════════════════════════════════════ */

test("G1) a 5xx from the edge is an UNKNOWN outcome, not a refusal: the order is looked up by cloid and never re-sent", async () => {
  let lookups = 0;
  const hl = fakeHl({
    script: {
      order: () => ({ $status: 502, body: "<html>502 Bad Gateway</html>" }),
      info(body) { if (body.type === "orderStatus") { lookups++; return { status: "unknownOid" }; } return undefined; },
    },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown_outcome");
  assert.equal(lookups, 1);
  assert.equal(hl.posts.filter((b) => b.action.type === "order").length, 1);
  assert.doesNotMatch(r.message, /<html>/, "an edge page is never shown as Hyperliquid's words");
});

test("G2) S1 surfaced: if Hyperliquid reads the approval as signed by SOME OTHER address (e.g. it did not accept the signatureChainId), the user sees that plainly with Hyperliquid's exact text", async () => {
  const other = "0x" + "cd".repeat(20);
  const hl = fakeHl({ script: { approveAgent: () => ({ status: "err", response: `Must deposit before performing actions. User: ${other}` }) } });
  const { t, agents } = await trader({ hl });
  const r = await t.enableTrading();
  assert.equal(r.ok, false);
  assert.equal(r.code, "signature_not_recognized");
  assert.equal(r.hlText, `Must deposit before performing actions. User: ${other}`);
  assert.ok(r.message.includes(r.hlText), "the exact Hyperliquid text is in the message");
  assert.equal(agents.status(MASTER).state, "none");
});

test("G3) a double tap is refused, not doubled: one market, one action at a time", async () => {
  const ctx = await enabled();
  const [a, b] = await Promise.all([
    ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 }),
    ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 20, leverage: 5 }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.code, "busy");
  assert.equal(ctx.hl.posts.filter((p) => p.action.type === "order").length, 1);
});

test("G4) the page's shared state: one store and one counter per network, and the key's expiry is judged on Hyperliquid's clock", async () => {
  const s1 = C.sharedTradingState(MAIN());
  const s2 = C.sharedTradingState(MAIN());
  assert.equal(s1, s2);
  assert.notEqual(C.sharedTradingState(N.hlNetworkProfile("testnet")), s1);
  const local = Date.now();
  s1.nonces.noteServerTime(local + 3 * DAY, local);
  const rec = s1.agents.prepare("0x" + "ee".repeat(20), { at: s1.nonces.serverNow() });
  assert.ok(Math.abs(rec.validUntil - (local + 4 * DAY)) < 5_000);
  s1.agents.markApproved("0x" + "ee".repeat(20), rec.address);
  s1.nonces.noteServerTime(local + 4 * DAY, local);
  assert.equal(s1.agents.status("0x" + "ee".repeat(20)).state, "expired", "Hyperliquid's clock says it has expired, whatever this device's clock says");
  s1.agents.clear("0x" + "ee".repeat(20));
  s1.nonces.noteServerTime(local, local);
});

test("G5) cancelOrders by oid: signed by the agent, the venue's 'already gone' counts as done", async () => {
  const hl = fakeHl({ script: { cancel: () => ({ status: "ok", response: { type: "cancel", data: { statuses: ["success", { error: "Order was never placed, already canceled, or filled." }] } } }) } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.cancelOrders("SOL", [11, 12]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.cancelled, [11, 12]);
  assert.deepEqual(hl.posts[0].action, { type: "cancel", cancels: [{ a: 5, o: 11 }, { a: 5, o: 12 }] });
  assert.equal(await recoverL1(hl.posts[0]), ctx.agent);
});

test("G6) Enable trading while a key is active (a second tab, a double click) asks nothing; within the last hour it renews with a NEW key", async () => {
  let now = T0;
  const ctx = await trader({ now: () => now });
  const first = await ctx.t.enableTrading();
  assert.equal(first.ok, true);
  const again = await ctx.t.enableTrading();
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(again.signatures, 0);
  assert.equal(again.agentAddress, first.agentAddress);
  assert.equal(ctx.wallet.prompts.length, 1, "no second prompt");
  now = first.validUntil - 30 * 60_000;
  ctx.hl.st.time = now;
  const renew = await ctx.t.enableTrading();
  assert.equal(renew.ok, true);
  assert.equal(renew.signatures, 1);
  assert.notEqual(renew.agentAddress, first.agentAddress);
  assert.equal(ctx.wallet.prompts.length, 2);
});

test("G7) two Enable trading calls at once share ONE approval", async () => {
  const ctx = await trader();
  const [a, b] = await Promise.all([ctx.t.enableTrading(), ctx.t.enableTrading()]);
  assert.equal(a, b);
  assert.equal(ctx.wallet.prompts.length, 1);
  assert.equal(ctx.hl.posts.filter((p) => p.action.type === "approveAgent").length, 1);
});

test("G8) two tabs enabling at the same moment: the tab whose pending key was replaced says so ('superseded'); the other tab's key is the one stored", async () => {
  const storage = memStorage();
  let release;
  const gate = new Promise((r) => { release = r; });
  const wA = chainWallet();
  const signA = wA.provider.request;
  wA.provider.request = async (args) => { if (args.method === "eth_signTypedData_v4") await gate; return signA(args); };
  const tabA = await trader({ storage, wallet: wA });
  const tabB = await trader({ storage });
  const pa = tabA.t.enableTrading();
  for (let i = 0; i < 200 && tabA.agents.status(MASTER).state !== "pending"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(tabA.agents.status(MASTER).state, "pending", "tab A is waiting on its wallet prompt");
  const rb = await tabB.t.enableTrading();
  assert.equal(rb.ok, true);
  release();
  const ra = await pa;
  assert.equal(ra.ok, false);
  assert.equal(ra.code, "superseded");
  assert.equal(tabA.agents.status(MASTER).state, "active");
  assert.equal(tabA.agents.status(MASTER).address, rb.agentAddress, "both tabs now trade with tab B's key");
});
