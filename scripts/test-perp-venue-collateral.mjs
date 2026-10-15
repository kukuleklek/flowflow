/**
 * test-perp-venue-collateral — ONE PERP BALANCE, AND A VENUE MARKET THAT TRADES.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-23: the customer sees ONE Perp balance, a venue market has to be
 * tradable, and nothing on a money screen says "dex".
 *
 * WHAT WAS WRONG, MEASURED THAT DAY (POST https://api.hyperliquid.xyz/info,
 * read-only; no order, transfer, approval or signature was ever sent):
 *   • clearinghouseState{user, dex:"xyz"} is a SEPARATE pot. 0xdd966dff… held
 *     30,000.00 on the main dex and 1,272,516.69 on xyz.
 *   • In standard mode a venue pot starts EMPTY, and Hyperliquid then says you
 *     may trade nothing there: 0x09bc1cf4… (mode "default", 5,224,203.98 on the
 *     main dex) answered activeAssetData{coin:"xyz:TSLA"}
 *     availableToTrade ["0.0","0.0"], maxTradeSzs ["0.0","0.0"]. The ticket read
 *     that figure and printed "Available 0.00".
 *   • Docs (exchange-endpoint, Agent Send Asset, read 2026-09-23): the trading
 *     key CAN move the collateral — agentSendAsset, signed as an L1 action,
 *     destination must match the source, only the collateral token may cross a
 *     perp dex. So it needs no wallet prompt and the customer learns nothing.
 *   • The collateral token is NOT always USDC: /info {type:"meta", dex} answers
 *     collateralToken 0 (USDC) for xyz and io, and 360 (USDH) for flx, vntl, km.
 *   • FEES: the docs mention none for sendAsset or agentSendAsset, and
 *     trading/fees says nothing about moving collateral to or from a perp dex.
 *     Measured over two real addresses' userNonFundingLedgerUpdates: 715 self
 *     transfers touching the xyz dex, every one "fee":"0.0",
 *     "nativeTokenFee":"0.0", "feeToken":"". A measurement is not a guarantee, so
 *     no screen claims anything — and never the word "free".
 *
 *   A. the action (venueCollateral.js): the documented field ORDER, the L1 hash
 *      recovering to the agent key, the destination forced to the master, a
 *      non-USDC venue refused, the token derived and never hardcoded
 *   P. the plans: the shortfall rounded UP (a flooring leaves the order short by
 *      a millionth and Hyperliquid refuses it), the sweep reading Hyperliquid's
 *      own withdrawable, and a venue still holding a position left alone
 *   T. the trader on a venue market, against a FAKE Hyperliquid whose pots really
 *      move: exactly the shortfall, then the order — with the HIP-3 asset id
 *   R. the refusals: a short balance refuses before anything is signed; a refused
 *      order brings the money straight back; a credit that never lands brings it
 *      back and places NOTHING; an unknown outcome leaves it alone
 *   S. the sweep when the last position on a venue closes
 *   W. the words: no dex, no venue, no HIP-3, no transfer, no "free"
 *
 * Money safety: every signature is made OFFLINE with the official Python SDK's
 * published test key, the global fetch throws, and no request leaves the process.
 *
 * Run: node --test scripts/test-perp-venue-collateral.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { code } from "./lib/perpLiveHarness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EX = (f) => pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/exchange", f)).href;

let realNetworkAttempts = 0;
globalThis.fetch = () => { realNetworkAttempts++; throw new Error("test-perp-venue-collateral: a real network call was attempted"); };

/* The official Python SDK's public test key plays the user's wallet. */
const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x14791697260E4c9A71f18484C9f997B308e59325";
const T0 = 1_700_000_000_000;

/* Measured 2026-09-23, /info {type:"spotMeta"}: USDC is spot token 0. */
const USDC_TOKEN_ID = "0x6d1e7cde53ba9467b783cb7c530ce054";
const USDC_TOKEN = `USDC:${USDC_TOKEN_ID}`;
/* And token 360 is USDH, which flx, vntl and km all take as collateral instead. */
const USDH_TOKEN_ID = "0x54e00a5988577cb0b0c9ab0cb6ef7f4b";

let C, V, N, S, A, NC, viem, viemAccounts, ethers;
before(async () => {
  C = await import(EX("client.js"));
  V = await import(EX("venueCollateral.js"));
  N = await import(EX("network.js"));
  S = await import(EX("signing.js"));
  A = await import(EX("agentStore.js"));
  NC = await import(EX("nonce.js"));
  viem = await import("viem");
  viemAccounts = await import("viem/accounts");
  ethers = await import("ethers");
});

const MAIN = () => N.hlNetworkProfile("mainnet");

/* Market rows as markets.js builds them. The venue rows carry the HIP-3 asset id
   (100000 + dexIndex*10000 + index) the pinned suite proves: measured
   2026-09-23, perpDexs puts xyz at index 1 and meta{dex:"xyz"} puts xyz:TSLA at
   universe index 1, so 110001. xyz:TSLA also carries growthMode "enabled" — as
   103 of the 108 non-delisted xyz assets do — which is why its fee is unknown. */
const MARKETS = {
  BTC: { coin: "BTC", label: "BTC", assetIndex: 0, szDecimals: 5, maxLeverage: 40, midPx: 85721.5, markPx: 85720, px: 85721.5, onlyIsolated: false, marginMode: null, takerFeeMultiplier: 1 },
  "xyz:TSLA": { coin: "xyz:TSLA", label: "TSLA", dex: "xyz", isHip3: true, assetIndex: 110001, szDecimals: 3, maxLeverage: 20, midPx: 380, markPx: 380, px: 380, onlyIsolated: false, marginMode: null, growthMode: "enabled", takerFeeMultiplier: null },
  "xyz:AAPL": { coin: "xyz:AAPL", label: "AAPL", dex: "xyz", isHip3: true, assetIndex: 110002, szDecimals: 3, maxLeverage: 20, midPx: 200, markPx: 200, px: 200, onlyIsolated: false, marginMode: null, growthMode: null, takerFeeMultiplier: 2 },
};
const COIN_BY_ASSET = Object.fromEntries(Object.values(MARKETS).map((m) => [m.assetIndex, m.coin]));
/* The main dex's own all-in taker rate, as the perp page resolves it. */
const BASE_RATE = 0.00045;
const feeRateOf = (m) => (m && typeof m.takerFeeMultiplier === "number" ? BASE_RATE * m.takerFeeMultiplier : null);

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

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

/**
 * A fake Hyperliquid WITH POTS. clearinghouseState and activeAssetData answer per
 * dex, and agentSendAsset really moves money between them — so the credit
 * confirmation in client.js is exercised, not stubbed.
 */
function fakeHl(init = {}) {
  const profile = MAIN();
  const st = {
    pots: { "": { free: 1000, positions: {} }, xyz: { free: 0, positions: {} } },
    collateralToken: { "": 0, xyz: 0 },
    openOrders: {},
    time: T0,
    nextOid: 9000,
    /* A credit that never shows up in activeAssetData: the timeout path. */
    creditVisible: true,
    ...init,
  };
  const posts = [];
  const infos = [];
  /* One ordered log of everything the fake was asked, in the order it was asked:
     the only way to see whether two flows interleaved. */
  const log = [];
  const script = init.script || {};
  const res = (obj, status = 200) => new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const pot = (dex) => st.pots[dex || ""] || { free: 0, positions: {} };
  const clearing = (dex) => {
    const p = pot(dex);
    return {
      assetPositions: Object.entries(p.positions).map(([coin, q]) => ({ type: "oneWay", position: { coin, szi: String(q.szi), leverage: { type: q.cross ? "cross" : "isolated", value: q.leverage ?? 5, rawUsd: "0" }, entryPx: String(q.entryPx ?? 100), positionValue: "0", unrealizedPnl: "0", returnOnEquity: "0", liquidationPx: null, marginUsed: "0", maxLeverage: 40, cumFunding: {} } })),
      marginSummary: { accountValue: String(p.free), totalNtlPos: "0", totalRawUsd: String(p.free), totalMarginUsed: "0" },
      crossMarginSummary: { accountValue: String(p.free), totalNtlPos: "0", totalRawUsd: String(p.free), totalMarginUsed: "0" },
      crossMaintenanceMarginUsed: "0", withdrawable: String(p.free), time: st.time,
    };
  };
  async function fetchImpl(url, reqInit) {
    const body = JSON.parse(reqInit.body);
    if (url === profile.infoUrl) {
      infos.push(body);
      log.push(`info:${body.type}:${body.dex ?? ""}${body.coin ? `:${body.coin}` : ""}`);
      if (script.info) { const r = script.info(body, st); if (r !== undefined) return res(r); }
      switch (body.type) {
        case "clearinghouseState": return res(clearing(body.dex));
        case "frontendOpenOrders": return res(st.openOrders[body.dex || ""] || []);
        case "activeAssetData": {
          const dex = body.coin.includes(":") ? body.coin.split(":")[0] : "";
          const free = st.creditVisible ? pot(dex).free : Math.min(pot(dex).free, st.frozenFree ?? 0);
          return res({ user: body.user, coin: body.coin, leverage: { type: "cross", value: 20 }, maxTradeSzs: ["0.0", "0.0"], availableToTrade: [String(free), String(free)], markPx: "380.0" });
        }
        case "meta": return res({ universe: [], marginTables: [], collateralToken: st.collateralToken[body.dex || ""] });
        case "spotMeta": return res({ tokens: [{ index: 0, name: "USDC", tokenId: USDC_TOKEN_ID, szDecimals: 8, weiDecimals: 8 }, { index: 360, name: "USDH", tokenId: USDH_TOKEN_ID, szDecimals: 2, weiDecimals: 8 }] });
        case "maxBuilderFee": return res(0);
        case "orderStatus": return res({ status: "unknownOid" });
        default: return res(null);
      }
    }
    if (url === profile.exchangeUrl) {
      posts.push(body);
      log.push(`post:${body.action.type}`);
      const h = script[body.action.type];
      const r = h ? h(body, st, posts) : undefined;
      if (r instanceof Error) throw r;
      if (r && r.$status) return res(r.body, r.$status);
      if (r !== undefined) return res(r);
      if (body.action.type === "agentSendAsset") {
        const from = pot(body.action.sourceDex);
        const to = pot(body.action.destinationDex);
        const amt = Number(body.action.amount);
        if (amt > from.free + 1e-9) return res({ status: "err", response: "Insufficient balance" });
        from.free = Math.round((from.free - amt) * 1e6) / 1e6;
        to.free = Math.round((to.free + amt) * 1e6) / 1e6;
        return res({ status: "ok", response: { type: "default" } });
      }
      if (body.action.type === "order") {
        /* A fill really moves the pot's positions, so a full close leaves the
           venue with none and the sweep has something true to read. */
        for (const o of body.action.orders) {
          if (o.t && o.t.trigger) continue;
          const coin = COIN_BY_ASSET[o.a];
          if (!coin) continue;
          const p = pot(coin.includes(":") ? coin.split(":")[0] : "");
          const held = p.positions[coin];
          const sz = Number(o.s) * (o.b ? 1 : -1);
          if (o.r) {
            if (!held) continue;
            const left = Math.round((held.szi + sz) * 1e8) / 1e8;
            if (Math.abs(left) < 1e-9) delete p.positions[coin]; else held.szi = left;
          } else if (held) {
            held.szi = Math.round((held.szi + sz) * 1e8) / 1e8;
          } else {
            p.positions[coin] = { szi: sz, entryPx: Number(o.p), leverage: 10 };
          }
        }
        return res({ status: "ok", response: { type: "order", data: { statuses: body.action.orders.map((o) => ({ filled: { totalSz: o.s, avgPx: o.p, oid: st.nextOid++ } })) } } });
      }
      if (body.action.type === "cancel") return res({ status: "ok", response: { type: "cancel", data: { statuses: body.action.cancels.map(() => "success") } } });
      return res({ status: "ok", response: { type: "default" } });
    }
    throw new Error(`unexpected url ${url}`);
  }
  return { fetchImpl, posts, infos, log, st, profile };
}

let cloidSeq = 0;
const nextCloid = () => `0x${(++cloidSeq).toString(16).padStart(32, "0")}`;

/* The move mechanics below run with moves OPEN and no amount cap; the owner's gate (plan Q0) has its own tests (G*). */
const MOVES_OPEN = Object.freeze({ auto: true, dexes: ["xyz"] });

async function trader({ hl = fakeHl(), wallet = chainWallet(), now = () => T0, storage = memStorage(), venueCreditTries = 2, venueCreditWaitMs = 0, venueMoves = MOVES_OPEN } = {}) {
  const signer = await new ethers.BrowserProvider(wallet.provider).getSigner();
  const agents = A.createAgentStore({ profile: MAIN(), storage, now });
  const nonces = NC.createNonceAllocator({ profile: MAIN(), storage, locks: null, now });
  const t = C.createHlTrader({
    master: MASTER, signer, walletType: "privy", chainId: 43114,
    market: (coin) => MARKETS[coin] || null,
    builder: { address: "", feeTenthsBp: 0 },
    profile: MAIN(),
    feeRateOf,
    venueMoves,
    deps: { fetchImpl: hl.fetchImpl, agents, nonces, randomCloid: nextCloid, now, venueCreditTries, venueCreditWaitMs },
  });
  return { t, hl, wallet, agents, nonces };
}

async function enabled(opts = {}) {
  const ctx = await trader(opts);
  const r = await ctx.t.enableTrading();
  assert.equal(r.ok, true, JSON.stringify(r));
  ctx.agent = r.agentAddress.toLowerCase();
  ctx.hl.posts.length = 0;
  ctx.hl.infos.length = 0;
  ctx.hl.log.length = 0;
  ctx.promptsBefore = ctx.wallet.prompts.length;
  return ctx;
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

const moves = (hl) => hl.posts.filter((b) => b.action.type === "agentSendAsset").map((b) => b.action);
const orders = (hl) => hl.posts.filter((b) => b.action.type === "order");

/* ════════════════════════════════════════════════════════════════════════════
   A. THE ACTION
   ════════════════════════════════════════════════════════════════════════════ */

test("A1) 🔴 the documented field ORDER, key by key — it is part of the signed hash", () => {
  const action = V.buildAgentSendAssetAction({
    destination: MASTER, sourceDex: "", destinationDex: "xyz", token: USDC_TOKEN, amount: "12.5", nonce: T0,
  });
  /* Docs (Agent Send Asset) and the pinned SDK 0.33.3
     (api/exchange/_methods/agentSendAsset.js), which reorders by schema order. */
  assert.deepEqual(Object.keys(action), [
    "type", "destination", "sourceDex", "destinationDex", "token", "amount", "fromSubAccount", "nonce",
  ]);
  assert.equal(action.type, "agentSendAsset");
  assert.equal(action.fromSubAccount, "", "the main account, not a sub-account");
  assert.equal(action.destination, MASTER.toLowerCase(), "lowercased, as every address this layer sends is");
  /* No hyperliquidChain and no signatureChainId: this is an L1 action, not a
     user-signed one (the SDK's own field list says so). */
  assert.equal("signatureChainId" in action, false);
  assert.equal("hyperliquidChain" in action, false);
  /* The hash is order-sensitive: the same values in another order hash differently. */
  const swapped = { type: "agentSendAsset", destination: action.destination, sourceDex: "", destinationDex: "xyz", token: USDC_TOKEN, amount: "12.5", nonce: T0, fromSubAccount: "" };
  assert.notEqual(
    S.hlActionHash({ action, nonce: T0 }),
    S.hlActionHash({ action: swapped, nonce: T0 }),
    "msgpack key order changes the hash, so the builder's order is the contract",
  );
});

test("A2) 🔴 nothing but a positive amount, a real address and a real nonce gets built", () => {
  const ok = { destination: MASTER, sourceDex: "", destinationDex: "xyz", token: USDC_TOKEN, amount: "1", nonce: T0 };
  assert.doesNotThrow(() => V.buildAgentSendAssetAction(ok));
  for (const bad of [
    { destination: "0xnope" }, { destination: null },
    { sourceDex: null }, { destinationDex: 1 },
    { sourceDex: "xyz", destinationDex: "xyz" },
    { token: "" }, { token: null },
    { amount: "0" }, { amount: "-1" }, { amount: 1 }, { amount: "1e3" }, { amount: "" },
    { fromSubAccount: null },
    { nonce: -1 }, { nonce: 1.5 }, { nonce: null },
  ]) {
    assert.throws(() => V.buildAgentSendAssetAction({ ...ok, ...bad }), `built one from ${JSON.stringify(bad)}`);
  }
});

test("A3) 🔴 the token string is DERIVED from the venue's own collateralToken, and a venue that does not take USDC is refused", () => {
  const spotTokens = [{ index: 0, name: "USDC", tokenId: USDC_TOKEN_ID }, { index: 360, name: "USDH", tokenId: USDH_TOKEN_ID }];
  const usdc = V.venueCollateralToken({ collateralToken: 0, spotTokens });
  assert.deepEqual(usdc, { ok: true, token: USDC_TOKEN, name: "USDC", index: 0 });
  /* Measured 2026-09-23: flx, vntl and km all answer collateralToken 360 (USDH).
     Funding one of those with USDC is money sent where it does not belong. */
  const usdh = V.venueCollateralToken({ collateralToken: 360, spotTokens });
  assert.equal(usdh.ok, false);
  assert.equal(usdh.code, "collateral_unsupported");
  /* Unknown is unknown, not "probably USDC". */
  for (const bad of [{ collateralToken: null }, { collateralToken: -1 }, { collateralToken: 0, spotTokens: null }, { collateralToken: 0, spotTokens: [] }]) {
    const r = V.venueCollateralToken({ spotTokens, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, "collateral_unknown");
  }
  /* 🔴 AND IT IS NOT IN THE SOURCE. The same rule venues.js applies to dex
     indexes: take it from the live answer every time. */
  const src = code("src/lib/hyperliquid/exchange/venueCollateral.js");
  assert.doesNotMatch(src, new RegExp(USDC_TOKEN_ID, "i"), "the token id must never be hardcoded");
  assert.doesNotMatch(code("src/lib/hyperliquid/exchange/client.js"), new RegExp(USDC_TOKEN_ID, "i"));
});

test("A4) 🔴 the amount is cut to 6 decimals — DOWN for a sweep, UP for a shortfall", () => {
  /* A shortfall floored is a shortfall: Hyperliquid refuses the order for the
     last millionth, and the customer is told they have no money. */
  assert.equal(V.ceilCollateralAmount(1.0000001), "1.000001");
  assert.equal(V.ceilCollateralAmount(0.0000004), "0.000001");
  assert.equal(V.ceilCollateralAmount(12.5), "12.5");
  /* A sweep ceiled would ask for money that is not there. */
  assert.equal(V.floorCollateralAmount(1.0000009), "1");
  assert.equal(V.floorCollateralAmount(1161211.8896890001), "1161211.889689");
  for (const bad of [0, -1, NaN, Infinity, null, undefined, "5"]) {
    assert.equal(V.ceilCollateralAmount(bad), null, `ceil ${String(bad)}`);
    assert.equal(V.floorCollateralAmount(bad), null, `floor ${String(bad)}`);
  }
});

test("A4b) the collateral decimals are USDC's own, the same number master.js withdraws by", async () => {
  const M = await import(EX("master.js"));
  assert.equal(V.HL_COLLATERAL_DECIMALS, M.HL_USDC_DECIMALS, "two constants, one fact: 6 decimals");
  assert.equal(V.HL_USDC_TOKEN_INDEX, 0, "measured 2026-09-23, /info {type:\"spotMeta\"}");
  assert.equal(V.HL_MAIN_DEX, "");
  assert.equal(V.HL_SPOT_DEX, "spot");
});

test("A5) the exchange layer's own coin split and main-dex name AGREE with venues.js — two definitions, one meaning", async () => {
  /* The exchange layer imports nothing from the markets layer on purpose (it is
     what keeps the signing SDK out of a flag-off build), so these two facts are
     written twice. They are pinned to each other here rather than left to luck. */
  const VEN = await import(pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/venues.js")).href);
  assert.equal(V.HL_MAIN_DEX, VEN.HL_MAIN_DEX);
  for (const coin of ["xyz:TSLA", "flx:NVDA", "BTC", "kPEPE"]) {
    const base = VEN.hlMarketBase(coin);
    const dex = V.venueOfCoin(coin);
    assert.equal(dex == null ? coin : `${dex}:${base}`, coin, coin);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   P. THE PLANS
   ════════════════════════════════════════════════════════════════════════════ */

test("P1) 🔴 the order's own requirement: the margin, plus the fee only when the fee is KNOWN", () => {
  assert.equal(V.venueOrderCollateral({ marginUsdc: 100, leverage: 20, feeRate: 0.0009 }), 100 * (1 + 20 * 0.0009));
  /* A growth-mode asset's rate is null on purpose (the docs give a range, and
     venues.js refuses to invent a number). The ticket's own Max caps at the plain
     available in that case, so the move sizes itself the same way: the two
     figures agree by construction. */
  assert.equal(V.venueOrderCollateral({ marginUsdc: 100, leverage: 20, feeRate: null }), 100);
  for (const bad of [{ marginUsdc: 0 }, { marginUsdc: -5 }, { marginUsdc: null }, { leverage: 0 }, { leverage: 1.5 }, { leverage: null }]) {
    assert.equal(V.venueOrderCollateral({ marginUsdc: 100, leverage: 20, feeRate: null, ...bad }), null, JSON.stringify(bad));
  }
});

test("P2) 🔴 the shortfall, and a balance that cannot cover it — in the customer's words", () => {
  /* Already there: nothing moves. */
  assert.deepEqual(V.planVenueTopUp({ needUsdc: 50, venueAvailableUsdc: 50, mainAvailableUsdc: 1000 }), { ok: true, amount: null, shortfallUsdc: 0 });
  assert.deepEqual(V.planVenueTopUp({ needUsdc: 50, venueAvailableUsdc: 900, mainAvailableUsdc: 0 }), { ok: true, amount: null, shortfallUsdc: 0 });
  /* Part of it is there: only the rest moves. "exactly the collateral that order
     needs", not the balance. */
  const part = V.planVenueTopUp({ needUsdc: 50, venueAvailableUsdc: 20, mainAvailableUsdc: 1000 });
  assert.equal(part.ok, true);
  assert.equal(part.amount, "30");
  /* Nothing there: all of it moves, rounded UP to the 6th decimal. */
  assert.equal(V.planVenueTopUp({ needUsdc: 18.0000004, venueAvailableUsdc: 0, mainAvailableUsdc: 1000 }).amount, "18.000001");
  /* More than the account holds: REFUSED, with a sentence that names no dex. */
  const short = V.planVenueTopUp({ needUsdc: 50, venueAvailableUsdc: 0, mainAvailableUsdc: 49.999999 });
  assert.equal(short.ok, false);
  assert.equal(short.code, "insufficient_margin");
  assert.match(short.message, /Perp balance/);
  assert.doesNotMatch(short.message, /dex|venue|hip-?3|transfer|hyperliquid|free/i, short.message);
  /* Unknown is never read as zero. */
  for (const bad of [{ needUsdc: null }, { needUsdc: 0 }, { venueAvailableUsdc: null }, { venueAvailableUsdc: -1 }, { mainAvailableUsdc: null }]) {
    const r = V.planVenueTopUp({ needUsdc: 50, venueAvailableUsdc: 0, mainAvailableUsdc: 1000, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, "state_unknown");
  }
});

test("P3) 🔴 the sweep moves HYPERLIQUID'S OWN withdrawable, and never out from under a position", () => {
  assert.deepEqual(V.planVenueSweep({ venueWithdrawableUsdc: 41.239999, venuePositions: 0 }), { ok: true, amount: "41.239999" });
  assert.deepEqual(V.planVenueSweep({ venueWithdrawableUsdc: 0, venuePositions: 0 }), { ok: true, amount: null });
  /* A position is still open: that collateral is margin, not idle money. */
  assert.deepEqual(V.planVenueSweep({ venueWithdrawableUsdc: 900, venuePositions: 1 }), { ok: true, amount: null });
  for (const bad of [{ venuePositions: null }, { venuePositions: -1 }, { venueWithdrawableUsdc: null }, { venueWithdrawableUsdc: -3 }]) {
    const r = V.planVenueSweep({ venueWithdrawableUsdc: 10, venuePositions: 0, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("P4) venueOfCoin is the ONE place a coin name is split for the purpose of moving money", () => {
  assert.equal(V.venueOfCoin("xyz:TSLA"), "xyz");
  assert.equal(V.venueOfCoin("BTC"), null);
  assert.equal(V.venueOfCoin(":TSLA"), null);
  for (const bad of [null, undefined, 1, {}, ""]) assert.equal(V.venueOfCoin(bad), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   T. THE TRADER ON A VENUE MARKET
   ════════════════════════════════════════════════════════════════════════════ */

test("T1) 🔴 a venue market now TRADES: the shortfall moves with the trading key, then the order goes out with the HIP-3 asset id", async () => {
  const ctx = await enabled();
  /* The measured starting point: the account's money is on the main dex and the
     venue pot is empty, so Hyperliquid says nothing may be traded there. */
  assert.deepEqual([ctx.hl.st.pots[""].free, ctx.hl.st.pots.xyz.free], [1000, 0]);
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const m = moves(ctx.hl);
  assert.equal(m.length, 1, "ONE move, and only because it was needed");
  assert.deepEqual(
    { destination: m[0].destination, sourceDex: m[0].sourceDex, destinationDex: m[0].destinationDex, token: m[0].token, amount: m[0].amount, fromSubAccount: m[0].fromSubAccount },
    { destination: MASTER.toLowerCase(), sourceDex: "", destinationDex: "xyz", token: USDC_TOKEN, amount: "100", fromSubAccount: "" },
    "xyz:TSLA is growth mode, so the fee is unknown and the need is the margin — the same figure the ticket's Max uses",
  );
  /* The nonce in the body EQUALS the envelope's (docs: "Equal to the envelope
     nonce"), which is why client.js allocates it before building the action. */
  const body = ctx.hl.posts.find((b) => b.action.type === "agentSendAsset");
  assert.equal(body.action.nonce, body.nonce);
  /* THE TRADING KEY SIGNED IT: no wallet prompt, and the recovered address is the
     agent, not the master. */
  assert.equal(await recoverL1(body), ctx.agent);
  assert.equal(ctx.wallet.prompts.length, ctx.promptsBefore, "the customer saw no prompt at all");
  /* And the order itself carries the HIP-3 id: 100000 + 1*10000 + 1. */
  const o = orders(ctx.hl);
  assert.equal(o.length, 1);
  assert.equal(o[0].action.orders[0].a, 110001);
  assert.equal(ctx.hl.st.pots[""].free, 900, "exactly the shortfall left the main pot");
  assert.equal(ctx.hl.st.pots.xyz.free, 100);
});

test("T2) a MAIN-DEX market is untouched: no move, and not one extra request", async () => {
  const ctx = await enabled();
  const r = await ctx.t.openMarket({ coin: "BTC", side: "buy", marginUsdc: 50, leverage: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(moves(ctx.hl), []);
  assert.deepEqual(ctx.hl.infos.filter((b) => b.type === "activeAssetData" || b.type === "meta" || b.type === "spotMeta"), []);
  assert.equal(orders(ctx.hl)[0].action.orders[0].a, 0);
});

test("T3) the money is already there: nothing moves, and the order still goes out", async () => {
  const ctx = await enabled({ hl: fakeHl({ pots: { "": { free: 1000, positions: {} }, xyz: { free: 500, positions: {} } } }) });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(moves(ctx.hl), []);
  assert.equal(orders(ctx.hl).length, 1);
  assert.deepEqual([ctx.hl.st.pots[""].free, ctx.hl.st.pots.xyz.free], [1000, 500]);
});

test("T4) a KNOWN fee is part of the requirement, so the move covers the fill AND its fee", async () => {
  const ctx = await enabled();
  /* xyz:AAPL is not in growth mode: deployerFeeScale 1.0 doubles Hyperliquid's own
     rate, so the market's taker rate is known and the fee has to fit too. */
  const r = await ctx.t.openMarket({ coin: "xyz:AAPL", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const want = V.ceilCollateralAmount(100 * (1 + 10 * BASE_RATE * 2));
  assert.equal(want, "100.9");
  assert.equal(moves(ctx.hl)[0].amount, want, "margin plus the fee the fill will really cost");
  assert.ok(Number(moves(ctx.hl)[0].amount) > 100);
});

test("T5) adding to a venue position moves more margin the same way, with no prompt", async () => {
  const ctx = await enabled({ hl: fakeHl({ pots: { "": { free: 1000, positions: {} }, xyz: { free: 0, positions: { "xyz:TSLA": { szi: 2.5, entryPx: 380, leverage: 10 } } } } }) });
  const r = await ctx.t.addMarket({ coin: "xyz:TSLA", marginUsdc: 40 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(moves(ctx.hl).length, 1);
  assert.equal(moves(ctx.hl)[0].amount, "40");
  assert.equal(moves(ctx.hl)[0].destinationDex, "xyz");
  assert.equal(ctx.wallet.prompts.length, ctx.promptsBefore);
});

test("T6) 🔴 two tickets on the SAME venue do not both spend the same money: the decisions are serialised", async () => {
  const ctx = await enabled({ hl: fakeHl({ pots: { "": { free: 200, positions: {} }, xyz: { free: 0, positions: {} } } }) });
  /* The per-market lock (exclusive) does not cover this: it is per COIN, and these
     are two coins on one venue drawing on one main pot. Without the collateral
     queue both would read 200, both would decide their 100 fits, and the second
     move would be refused for money the first had already taken. */
  const [a, b] = await Promise.all([
    ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 }),
    ctx.t.openMarket({ coin: "xyz:AAPL", side: "buy", marginUsdc: 100, leverage: 10 }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  const mainReads = ctx.hl.log.map((x, i) => [x, i]).filter(([x]) => x === "info:clearinghouseState:").map(([, i]) => i);
  const sends = ctx.hl.log.map((x, i) => [x, i]).filter(([x]) => x === "post:agentSendAsset").map(([, i]) => i);
  /* TWO looks, not one. info.js coalesces identical in-flight bodies, so two
     flows deciding at the same moment would have SHARED a single main-pot read
     and both seen the whole 200 — the exact double spend. Serialised, each order
     reads the pot as it is when its own turn comes. */
  assert.equal(mainReads.length, 2, "one look at the main pot per order, not one shared between them");
  assert.equal(sends.length, 2);
  assert.ok(sends[0] < mainReads[1], `the second order looked at the main pot only after the first move: ${ctx.hl.log.join(" ")}`);
  /* And the second move is sized against the pot AS IT NOW IS, which is the proof
     that it really looked again: xyz:TSLA is growth mode so its need was the bare
     100; xyz:AAPL's fee IS known, so it needed 100.9 and found 100 already there. */
  const m = moves(ctx.hl);
  assert.deepEqual(m.map((x) => x.amount), ["100", "0.9"]);
  assert.deepEqual([ctx.hl.st.pots[""].free, ctx.hl.st.pots.xyz.free], [99.1, 100.9]);
});

/* ════════════════════════════════════════════════════════════════════════════
   R. THE REFUSALS — money is never left stranded, and never moved for nothing
   ════════════════════════════════════════════════════════════════════════════ */

test("R1) 🔴 a balance that cannot cover the order: NOTHING is signed, and the words name no dex", async () => {
  const ctx = await enabled({ hl: fakeHl({ pots: { "": { free: 10, positions: {} }, xyz: { free: 0, positions: {} } } }) });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "insufficient_margin");
  assert.deepEqual(ctx.hl.posts, [], "not one action was sent: no move, no leverage change, no order");
  assert.doesNotMatch(r.message, /dex|venue|hip-?3|transfer|hyperliquid|free/i, r.message);
});

test("R2) 🔴 the order is refused: the money comes straight back, and the sweep reads the pot's own withdrawable", async () => {
  const ctx = await enabled({
    hl: fakeHl({ script: { order: () => ({ status: "err", response: "Order could not immediately match against any resting orders." }) } }),
  });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, false);
  const m = moves(ctx.hl);
  assert.equal(m.length, 2, "out, and back");
  assert.deepEqual([m[0].sourceDex, m[0].destinationDex, m[0].amount], ["", "xyz", "100"]);
  assert.deepEqual([m[1].sourceDex, m[1].destinationDex, m[1].amount], ["xyz", "", "100"]);
  assert.deepEqual(r.collateralReturned, { returned: true, amount: "100", code: null });
  assert.deepEqual([ctx.hl.st.pots[""].free, ctx.hl.st.pots.xyz.free], [1000, 0], "the balance is exactly what it was");
});

test("R3) 🔴 an UNKNOWN outcome leaves the money alone: it may already be margin on a filled order", async () => {
  const ctx = await enabled({ hl: fakeHl({ script: { order: () => new Error("network down") } }) });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown_outcome");
  assert.equal(moves(ctx.hl).length, 1, "the top-up only: nothing is pulled back on a maybe");
  assert.deepEqual(r.collateralReturned, { returned: false, reason: "outcome_unknown" });
  assert.equal(ctx.hl.st.pots.xyz.free, 100, "it is the customer's money, in their own Perp account");
});

test("R4) 🔴 the credit never shows up: the money goes back and NO order is placed", async () => {
  /* activeAssetData keeps answering 0 however much the pot holds. */
  const ctx = await enabled({ hl: fakeHl({ creditVisible: false, frozenFree: 0 }) });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_confirmed");
  assert.equal(r.retry, true);
  assert.deepEqual(orders(ctx.hl), [], "an order is NEVER signed against a credit Hyperliquid has not confirmed");
  const m = moves(ctx.hl);
  assert.equal(m.length, 2);
  assert.deepEqual([m[1].sourceDex, m[1].destinationDex], ["xyz", ""]);
  assert.deepEqual([ctx.hl.st.pots[""].free, ctx.hl.st.pots.xyz.free], [1000, 0]);
  /* And the sentence is the customer's: their money, in their account, no order. */
  assert.match(r.message, /Your money is in your Perp account\. The order wasn't placed/);
  assert.doesNotMatch(r.message, /dex|venue|hip-?3|transfer|hyperliquid/i, r.message);
});

test("R5) 🔴 a venue whose collateral is not USDC is refused before anything is signed", async () => {
  const ctx = await enabled({ hl: fakeHl({ collateralToken: { "": 0, xyz: 360 } }) });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "market_unsupported");
  assert.deepEqual(ctx.hl.posts, []);
  assert.match(r.message, /can't be traded from FlowFlow yet/);
  assert.doesNotMatch(r.message, /dex|venue|hip-?3|usdh|token|collateral/i, r.message);
});

test("R6) a collateral read that FAILS stops the order; it is not guessed at and not remembered", async () => {
  let metaCalls = 0;
  const ctx = await enabled({
    hl: fakeHl({ script: { info: (b) => { if (b.type === "meta") { metaCalls++; return null; } return undefined; } } }),
  });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "state_unknown");
  assert.deepEqual(ctx.hl.posts, []);
  const again = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 100, leverage: 10 });
  assert.equal(again.ok, false);
  assert.ok(metaCalls >= 2, "a failed read is asked again, never cached as a verdict");
});

/* ════════════════════════════════════════════════════════════════════════════
   S. THE SWEEP ON CLOSE
   ════════════════════════════════════════════════════════════════════════════ */

test("S1) 🔴 the last venue position closes: its idle collateral comes home, by Hyperliquid's own withdrawable", async () => {
  const hl = fakeHl({ pots: { "": { free: 100, positions: {} }, xyz: { free: 250.5, positions: { "xyz:TSLA": { szi: 1.5, entryPx: 380, leverage: 10 } } } } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.closeFraction("xyz:TSLA", 1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.closesAll, true);
  /* The reduce-only triggers are cancelled BEFORE the sweep, so the figure it
     reads is what is really free. */
  assert.deepEqual(r.collateralSwept, { swept: true, amount: "250.5", code: null });
  const m = moves(hl);
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].sourceDex, m[0].destinationDex, m[0].amount, m[0].token], ["xyz", "", "250.5", USDC_TOKEN]);
  assert.deepEqual([hl.st.pots[""].free, hl.st.pots.xyz.free], [350.5, 0]);
  assert.equal(ctx.wallet.prompts.length, ctx.promptsBefore, "no prompt to bring your own money home");
});

test("S2) 🔴 a PARTIAL sell brings the freed money home too, when every position left on the pot is isolated", async () => {
  /* Owner, 2026-10-15: money comes out of the stock pot when the stock is sold, automatically. The fake's
     withdrawable is the pot's free cash; an isolated position's own margin is not in it. */
  const hl = fakeHl({ pots: { "": { free: 100, positions: {} }, xyz: { free: 250, positions: { "xyz:TSLA": { szi: 4, entryPx: 380, leverage: 10 } } } } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.closeFraction("xyz:TSLA", 0.5);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.closesAll, false);
  assert.deepEqual(r.collateralSwept, { swept: true, amount: "250", code: null });
  const m = moves(hl);
  assert.deepEqual(m.map((x) => [x.sourceDex, x.destinationDex, x.amount]), [["xyz", "", "250"]]);
  assert.equal(hl.st.pots["xyz"].positions["xyz:TSLA"].szi, 2, "the rest of the position is untouched");
  assert.equal(ctx.wallet.prompts.length, ctx.promptsBefore, "no prompt");
});

test("S3) closing a MAIN-DEX position sweeps nothing and asks nothing", async () => {
  const hl = fakeHl({ pots: { "": { free: 100, positions: { BTC: { szi: 0.01, entryPx: 85000, leverage: 5 } } }, xyz: { free: 0, positions: {} } } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.closeFraction("BTC", 1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.collateralSwept, undefined);
  assert.deepEqual(moves(hl), []);
  assert.deepEqual(hl.infos.filter((b) => b.type === "meta" || b.type === "spotMeta"), []);
});

test("S4) another ISOLATED position on the same pot: the idle money still comes home (its margin is its own)", async () => {
  const hl = fakeHl({ pots: { "": { free: 100, positions: {} }, xyz: { free: 250, positions: { "xyz:TSLA": { szi: 1.5, entryPx: 380, leverage: 10 }, "xyz:AAPL": { szi: 3, entryPx: 200, leverage: 10 } } } } });
  const ctx = await enabled({ hl });
  const r = await ctx.t.closeFraction("xyz:TSLA", 1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.collateralSwept, { swept: true, amount: "250", code: null });
  assert.ok(hl.st.pots.xyz.positions["xyz:AAPL"], "AAPL is still open");
});

test("S5) 🔴 a CROSS position on the pot (opened elsewhere) keeps the money there: it leans on that free cash", async () => {
  const hl = fakeHl({ pots: { "": { free: 100, positions: {} }, xyz: { free: 250, positions: { "xyz:TSLA": { szi: 1.5, entryPx: 380, leverage: 10 }, "xyz:AAPL": { szi: 3, entryPx: 200, leverage: 10, cross: true } } } } });
  const ctx = await enabled({ hl });
  const full = await ctx.t.closeFraction("xyz:TSLA", 1);
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.deepEqual(full.collateralSwept, { swept: false, reason: "position_open" });
  assert.deepEqual(moves(hl), []);
  const hl2 = fakeHl({ pots: { "": { free: 100, positions: {} }, xyz: { free: 250, positions: { "xyz:TSLA": { szi: 4, entryPx: 380, leverage: 10, cross: true } } } } });
  const ctx2 = await enabled({ hl: hl2 });
  const part = await ctx2.t.closeFraction("xyz:TSLA", 0.5);
  assert.deepEqual(part.collateralSwept, { swept: false, reason: "position_open" });
  assert.deepEqual(moves(hl2), []);
});

test("S6) the sweep rule itself: positions open + cross count unknown = nothing moves", () => {
  assert.deepEqual(V.planVenueSweep({ venueWithdrawableUsdc: 10, venuePositions: 1 }), { ok: true, amount: null }, "old callers keep the old rule");
  assert.deepEqual(V.planVenueSweep({ venueWithdrawableUsdc: 10, venuePositions: 1, venueCrossPositions: 0 }), { ok: true, amount: "10" });
  assert.deepEqual(V.planVenueSweep({ venueWithdrawableUsdc: 10, venuePositions: 2, venueCrossPositions: 1 }), { ok: true, amount: null });
  assert.deepEqual(V.planVenueSweep({ venueWithdrawableUsdc: 10, venuePositions: 0 }), { ok: true, amount: "10" });
});

/* ════════════════════════════════════════════════════════════════════════════
   W. THE WORDS, AND THE FEE NOBODY CLAIMS
   ════════════════════════════════════════════════════════════════════════════ */

/* Every quoted string in a source file, scanned properly: a naive regex matches
   the CODE between two strings as well, which is how a guard starts passing for
   the wrong reason. Comments are stripped by code() first — four times in this
   repo a file's own prose about a forbidden word has satisfied the test that
   forbade it. */
function stringsOf(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    let j = i + 1;
    let buf = "";
    while (j < src.length && src[j] !== q) {
      if (src[j] === "\\") { buf += src[j + 1] || ""; j += 2; continue; }
      if (q !== "`" && src[j] === "\n") { buf = null; break; }
      buf += src[j];
      j++;
    }
    if (buf != null && j < src.length) out.push(buf);
    i = j;
  }
  return out;
}

test("W1) 🔴 no provider and no venue jargon in anything this layer can say out loud", () => {
  const JARGON = /\bdex(es)?\b|\bvenue\b|hip-?3|\bxyz\b|hyperliquid|hypercore|hyperevm|relay|3rd party|third party|agentSendAsset|sendAsset/i;
  const src = code("src/lib/hyperliquid/exchange/venueCollateral.js");
  /* Anything with a space in it is a sentence a human could read; identifiers,
     dex names and field names are single words this layer has to use. */
  const sentences = stringsOf(src).filter((x) => /\s/.test(x) && /[a-z]{3}/i.test(x));
  assert.ok(sentences.length > 6, `only ${sentences.length} sentences found: the scanner is broken`);
  for (const x of sentences) assert.doesNotMatch(x, JARGON, x);
  /* The named messages, which are the only ones a screen prints. */
  for (const x of Object.values(V.VENUE_COLLATERAL_MESSAGE)) {
    assert.doesNotMatch(x, /\bdex(es)?\b|\bvenue\b|hip-?3|\bxyz\b|hyperliquid|relay|transfer|wallet/i, x);
    assert.match(x, /Perp|market|order/, x);
  }
  /* And every refusal this module can return takes its words from that list, so
     a new branch cannot invent a sentence nobody read. */
  const fails = [...src.matchAll(/fail\(\s*"[a-z_]+"\s*,\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(fails.length >= 6, `only ${fails.length} refusals found`);
  for (const f of fails) assert.match(f, /^VENUE_COLLATERAL_MESSAGE\./, f);
});

test("W2) 🔴 NOTHING CLAIMS A FEE, and nothing says free — measured is not documented, and documented is nothing at all", () => {
  /* Docs: no fee is mentioned for sendAsset or agentSendAsset, and trading/fees
     says nothing about moving collateral to or from a perp dex. Measured
     2026-09-23 over 715 real self transfers touching the xyz dex: every one
     "fee":"0.0". A measurement of the past is not a promise about the next one,
     so the UI claims nothing rather than claiming zero. */
  for (const f of ["src/lib/hyperliquid/exchange/venueCollateral.js", "src/lib/hyperliquid/exchange/client.js"]) {
    for (const x of stringsOf(code(f))) {
      assert.doesNotMatch(x, /\bfree\b|no fee|zero fee|fee-?less|at no cost|instantly/i, `${f}: ${x}`);
    }
  }
  for (const s of Object.values(V.VENUE_COLLATERAL_MESSAGE)) assert.doesNotMatch(s, /fee|free|cost/i, s);
});

test("W3) the collateral move is signed by the TRADING KEY, never by the customer's wallet", () => {
  const src = code("src/lib/hyperliquid/exchange/client.js");
  /* agentSendAsset is built for sendL1With (the trading key). It must never be
     handed to sendMaster, which is the wallet prompt. */
  assert.match(src, /sendL1With\(\(nonce\) => buildAgentSendAssetAction/);
  assert.doesNotMatch(src, /sendMaster\([^)]*AgentSendAsset/);
  /* And the signing layer refuses an L1 payload from the master wallet anyway
     (signing.js signL1), which is what makes that a rule and not a habit. */
  assert.match(code("src/lib/hyperliquid/exchange/signing.js"), /L1 actions are signed by the trading key, never by the master wallet/);
});

test("W4) not one real request left this process", () => {
  assert.equal(realNetworkAttempts, 0);
});

/* ── G. THE OWNER'S GATE (docs/PLAN-HIP3-STOCKS.md §4.0, Q0) ─────────────────────────────────────────────────────
   The move into a stock pot is signed by the trading key with no window. Until the owner says yes it does not
   happen: no policy (the default), or auto off, refuses BEFORE anything is signed. */

test("G1) 🔴 NO POLICY = NOTHING MOVES: a stock order that needs money moved is refused before any signature", async () => {
  const ctx = await enabled({ venueMoves: null });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "market_unsupported");
  assert.equal(r.message, V.VENUE_COLLATERAL_MESSAGE.closed);
  assert.deepEqual(moves(ctx.hl), [], "no agentSendAsset");
  assert.deepEqual(orders(ctx.hl), [], "no order");
  assert.deepEqual([ctx.hl.st.pots[""].free, ctx.hl.st.pots.xyz.free], [1000, 0], "the money is where it was");
  const off = await enabled({ venueMoves: { auto: false, dexes: ["xyz"] } });
  const r2 = await off.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2 });
  assert.equal(r2.code, "market_unsupported");
  assert.deepEqual(moves(off.hl), []);
});

test("G2) moves off, money ALREADY in the pot: the order still goes out (nothing has to move)", async () => {
  const ctx = await enabled({ venueMoves: null, hl: fakeHl({ pots: { "": { free: 1000, positions: {} }, xyz: { free: 500, positions: {} } } }) });
  const r = await ctx.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(moves(ctx.hl), []);
  assert.equal(orders(ctx.hl).length, 1);
});

test("G3) moves on: NO amount cap (owner), but only the listed pot", async () => {
  const ok = await enabled({ venueMoves: MOVES_OPEN });
  const r = await ok.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 500, leverage: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(moves(ok.hl)[0].amount, "500", "exactly what the order needs, however much (the order cap is the ticket's business)");
  const other = await enabled({ venueMoves: { auto: true, dexes: ["mkts"] } });
  const r3 = await other.t.openMarket({ coin: "xyz:TSLA", side: "buy", marginUsdc: 10, leverage: 2 });
  assert.equal(r3.code, "market_unsupported");
  assert.deepEqual(moves(other.hl), []);
});

test("G4) moves off: closing the last stock position sweeps nothing silently; the money stays in its pot", async () => {
  const hl = fakeHl({ pots: { "": { free: 100, positions: {} }, xyz: { free: 250.5, positions: { "xyz:TSLA": { szi: 1.5, entryPx: 380, leverage: 10 } } } } });
  const ctx = await enabled({ hl, venueMoves: null });
  const r = await ctx.t.closeFraction("xyz:TSLA", 1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.collateralSwept, { swept: false, reason: "moves_off" });
  assert.deepEqual(moves(hl), []);
});

test("G5) the policy check itself", () => {
  assert.equal(V.venueMoveAllowed(MOVES_OPEN, { dex: "xyz" }).ok, true);
  assert.equal(V.venueMoveAllowed(MOVES_OPEN, { dex: "para" }).code, "market_unsupported");
  assert.equal(V.venueMoveAllowed(null, { dex: "xyz" }).code, "market_unsupported", "no policy: nothing moves");
  assert.equal(V.venueMoveAllowed({ auto: false, dexes: ["xyz"] }, { dex: "xyz" }).message, V.VENUE_COLLATERAL_MESSAGE.closed);
  assert.equal(V.venueMoveAllowed({ auto: "yes", dexes: ["xyz"] }, { dex: "xyz" }).ok, false, "only true opens it");
});

test("G6) guardrails: moves are ON (owner, 2026-10-15) unless the kill switch says exactly \"off\"; the app passes them", async () => {
  const G = await import("../src/perp/guardrails.js");
  assert.equal(G.STOCK_AUTO_MOVE, true, "no env under node: on");
  assert.deepEqual([...G.STOCK_DEXES], ["xyz"]);
  assert.equal("MAX_VENUE_MOVE_USDC" in G, false, "no move cap exists");
  assert.match(code("src/perp/guardrails.js"), /STOCK_AUTO_MOVE\s*=\s*ENV\.VITE_STOCK_AUTO_MOVE\s*!==\s*"off"/);
  const bp = code("src/perp/live/usePerpBackend.js");
  assert.match(bp, /venueMoves:\s*\{\s*auto:\s*STOCK_AUTO_MOVE,\s*dexes:\s*STOCK_DEXES\s*\}/, "the app passes the guardrails, nothing else");
});

test("R5) adding to an ISOLATED stock position and the order is refused: the top-up comes home, the position is untouched", async () => {
  const hl = fakeHl({
    pots: { "": { free: 1000, positions: {} }, xyz: { free: 0, positions: { "xyz:TSLA": { szi: 1, entryPx: 380, leverage: 10 } } } },
    script: { order: () => ({ status: "err", response: "Order could not immediately match against any resting orders." }) },
  });
  const ctx = await enabled({ hl });
  const r = await ctx.t.addMarket({ coin: "xyz:TSLA", marginUsdc: 20 });
  assert.equal(r.ok, false);
  const m = moves(hl);
  assert.deepEqual(m.map((x) => [x.sourceDex, x.destinationDex]), [["", "xyz"], ["xyz", ""]], "out, and back");
  assert.equal(r.collateralReturned.returned, true);
  assert.equal(hl.st.pots[""].free, 1000, "the balance is exactly what it was");
  assert.equal(hl.st.pots.xyz.positions["xyz:TSLA"].szi, 1);
});
