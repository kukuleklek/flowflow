/**
 * test-relay-deposit — THE PERP WALLET'S DEPOSIT ADDRESS, THROUGH RELAY.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-22: "Perp Wallet รับเป็น Relay.link เลย" / "และ Deposit ด้วย Relay
 * Deposit Address อะ" / "amount ขอเป็น USDC ได้ปะ".
 *
 * A user sends USDC (or USDT) on Base, Arbitrum, Polygon, Optimism, Ethereum or
 * BNB to a Relay deposit address; Relay sweeps it and credits USDC to the SAME
 * user's Hyperliquid perp account (Relay chain 1337). What this suite pins:
 *
 *   A. the routes: nine origin routes, USDC first, each one confirmed against a
 *      live GET https://api.relay.link/chains (2026-09-22, subset below);
 *   B. the quote request: recipient AND refundTo are the connected wallet, hard;
 *      every refusal happens before any request leaves;
 *   C. the quote answer is VERIFIED before an address is shown: the recipient,
 *      every refund recipient, every output payment, the destination (1337,
 *      USDC Perps), the origin token, and the transfer the step describes;
 *   D. the address is cached per (user, route), because Relay mints a NEW
 *      address on every quote (live, 2026-09-22: two quotes, same route, two
 *      addresses) and each one carries a 180-day deadline;
 *   E. deposit statuses from GET /requests/v2?depositAddress=: unknown is a
 *      dash (null), never 0;
 *   F. the tracker polls gently: visible tab only, backoff when idle or failing;
 *   G. the CSP lets a flag-on build reach api.relay.link, a flag-off build not;
 *   H. source guards: nothing here signs, sends, or touches real money figures.
 *
 * MONEY SAFETY. No request leaves this process: global fetch throws, and every
 * call below goes through a mock that records it. The fixtures are live answers
 * captured once with recipient = refundTo = 0x…dEaD (the burn address).
 *
 * Run: node --test scripts/test-relay-deposit.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/stripComments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(P(rel), "utf8");
const code = (rel) => stripComments(read(rel));

const ROUTES_FILE = "src/lib/relay/routes.js";
const DEPOSIT_FILE = "src/lib/relay/depositAddress.js";

/* No live network, ever: anything that forgets to take the mock fails loudly. */
const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error("live network is forbidden in test-relay-deposit"); }; });
after(() => { globalThis.fetch = realFetch; });

let R;   // routes.js
let D;   // depositAddress.js
before(async () => {
  R = await import(`../${ROUTES_FILE}`);
  D = await import(`../${DEPOSIT_FILE}`);
});

/* Public, well-known development addresses (no key is used anywhere here). */
const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEAD = "0x000000000000000000000000000000000000dEaD";

/* ── live GET https://api.relay.link/chains, 2026-09-22 09:47 UTC ─────────────
   The chains the routes touch, their USDC/USDT solver currencies only.
   Values are unedited. Avalanche (43114) was read on 2026-09-23 when the owner
   asked for it, and it carries ALL its solver currencies of that day, because
   what is NOT there is the point: USDT is not one, so there is no Avalanche
   USDT route, and USDe is one we do not offer. */
const LIVE_CHAINS = [
  { id: 8453, name: "base", displayName: "Base", vmType: "evm", depositEnabled: true, disabled: false, explorerUrl: "https://basescan.org",
    solverCurrencies: [{ symbol: "USDT", address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", decimals: 6 }, { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 }] },
  { id: 42161, name: "arbitrum", displayName: "Arbitrum", vmType: "evm", depositEnabled: true, disabled: false, explorerUrl: "https://arbiscan.io",
    solverCurrencies: [{ symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 }, { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 }] },
  { id: 137, name: "polygon", displayName: "Polygon", vmType: "evm", depositEnabled: true, disabled: false, explorerUrl: "https://polygonscan.com",
    solverCurrencies: [{ symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 }, { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 }] },
  { id: 10, name: "optimism", displayName: "Optimism", vmType: "evm", depositEnabled: true, disabled: false, explorerUrl: "https://optimistic.etherscan.io",
    solverCurrencies: [{ symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 }, { symbol: "USDT", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 }] },
  { id: 1, name: "ethereum", displayName: "Ethereum", vmType: "evm", depositEnabled: true, disabled: false, explorerUrl: "https://etherscan.io",
    solverCurrencies: [{ symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 }, { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 }] },
  { id: 56, name: "bsc", displayName: "BNB", vmType: "evm", depositEnabled: true, disabled: false, explorerUrl: "https://bscscan.com",
    solverCurrencies: [{ symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 }, { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 }] },
  { id: 43114, name: "avalanche", displayName: "Avalanche", vmType: "evm", depositEnabled: true, disabled: false, explorerUrl: "https://snowtrace.io",
    solverCurrencies: [{ symbol: "USDC", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 }, { symbol: "USDe", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 }] },
  { id: 1337, name: "hyperliquid", displayName: "Hyperliquid", vmType: "hypevm", depositEnabled: true, disabled: false, explorerUrl: "https://app.hyperliquid.xyz/explorer",
    solverCurrencies: [{ symbol: "USDC", address: "0x00000000000000000000000000000000", decimals: 8 }] },
];

/* ── live POST https://api.relay.link/quote/v2, 2026-09-22 09:48:20 UTC ───────
   Body: user = recipient = refundTo = 0x…dEaD, Base USDC 20000000 -> 1337
   USDC (Perps), EXACT_INPUT, useDepositAddress true. The answer, trimmed to the
   fields the parser reads; values unedited. */
const LIVE_QUOTE_TEXT = String.raw`{"requestId":"0x17900705003a1f7025e77356f88c9ce3502471a654d7b63aa9959258c4ca4e9a","steps":[{"id":"deposit","kind":"transaction","items":[{"status":"incomplete","data":{"from":"0x000000000000000000000000000000000000dEaD","to":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","data":"0xa9059cbb000000000000000000000000badfbe97b7244a57c0ef7c5cd8d2a907923f074d0000000000000000000000000000000000000000000000000000000001312d00","value":"0","chainId":8453},"check":{"endpoint":"/intents/status/v3?requestId=0x17900705003a1f7025e77356f88c9ce3502471a654d7b63aa9959258c4ca4e9a","method":"GET"}}],"requestId":"0x17900705003a1f7025e77356f88c9ce3502471a654d7b63aa9959258c4ca4e9a","depositAddress":"0xbadfbe97b7244a57c0ef7c5cd8d2a907923f074d"}],"fees":{"relayer":{"currency":{"chainId":8453,"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","symbol":"USDC","decimals":6},"amount":"29496","amountFormatted":"0.029496","amountUsd":"0.029495"},"relayerGas":{"currency":{"chainId":8453,"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","symbol":"USDC","decimals":6},"amount":"7496","amountFormatted":"0.007496","amountUsd":"0.007496"},"relayerService":{"currency":{"chainId":8453,"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","symbol":"USDC","decimals":6},"amount":"22000","amountFormatted":"0.022","amountUsd":"0.021999"}},"details":{"operation":"swap","sender":"0x000000000000000000000000000000000000dEaD","recipient":"0x000000000000000000000000000000000000dEaD","currencyIn":{"currency":{"chainId":8453,"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","symbol":"USDC","name":"USD Coin","decimals":6},"amount":"20000000","amountFormatted":"20.0"},"currencyOut":{"currency":{"chainId":1337,"address":"0x00000000000000000000000000000000","symbol":"USDC","name":"USDC (Perps)","decimals":8},"amount":"1997050400","amountFormatted":"19.970504","minimumAmount":"1957109300"},"timeEstimate":1},"protocol":{"v2":{"orderId":"0x56f49197e8e60dc3f21912dab376f59fd84f9050fd7cb70c3dc89e41faed77d9","orderData":{"inputs":[{"payment":{"chainId":"base","currency":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","amount":"20000000","weight":"1"},"refunds":[{"chainId":"base","recipient":"0x000000000000000000000000000000000000dEaD","currency":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","deadline":1805622500},{"chainId":"hyperliquid","recipient":"0x000000000000000000000000000000000000dEaD","currency":"0x00000000000000000000000000000000","deadline":1805622500}]}],"output":{"chainId":"hyperliquid","payments":[{"recipient":"0x000000000000000000000000000000000000dEaD","currency":"0x00000000000000000000000000000000","minimumAmount":"1957109300","expectedAmount":"1997050400"}],"deadline":1805622500}},"paymentDetails":{"chainId":"base","depository":"0x4cd00e387622c35bddb9b4c962c136462338bc31","currency":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","amount":"20000000"}}}}`;
const LIVE_DEPOSIT_ADDRESS = "0xbadfbe97b7244a57c0ef7c5cd8d2a907923f074d";
/* The second live quote, same route and same dEaD user, 20 s later, amount 50:
   a DIFFERENT address. That is why the address must be cached. */
const LIVE_SECOND_ADDRESS = "0xa9070019344b5a191b18721ef085b7e626daf86a";
const QUOTED_AT = Date.UTC(2026, 8, 22, 9, 48, 20);
const DEADLINE_MS = 1805622500 * 1000;
const DAY = 86400000;

/** The live answer as Relay would give it to `user`: every dEaD becomes that user. */
const quoteFor = (user, mutate = null) => {
  const q = JSON.parse(LIVE_QUOTE_TEXT.replace(/0x000000000000000000000000000000000000dEaD/gi, user));
  if (mutate) mutate(q);
  return q;
};

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
/* Every address is shown only after the route passes Relay's live chains list,
   so each mock also answers GET /chains (the saved live subset, unless a test
   hands in its own answer). Those reads are kept apart in chainsCalls, so calls
   stays the quote and status requests each test counts. */
function mockFetch(handler, { chains = () => jsonRes(200, { chains: LIVE_CHAINS }) } = {}) {
  const calls = [];
  const chainsCalls = [];
  const f = async (url, init = {}) => {
    if (String(url) === "https://api.relay.link/chains") {
      chainsCalls.push({ url: String(url), method: String(init.method || "GET").toUpperCase() });
      return chains(chainsCalls.length);
    }
    calls.push({ url: String(url), method: String(init.method || "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    return handler(String(url), init, calls.length);
  };
  f.calls = calls;
  f.chainsCalls = chainsCalls;
  return f;
}
const routeOf = (id) => R.routeById(id);

/* ════════════════════════════════════════════════════════════════════════════
   A. ROUTES
   ════════════════════════════════════════════════════════════════════════════ */

/* THE ORDER IS THE OWNER'S (2026-09-23): "เรียงเชนใหม่ BASE , AVAX อื่นๆตามมา", then
   "Deposit Avax ต้องอยู่อันที่สองสิวะ" when Base's USDT had taken the second row.
   USDC rows in his chain order, USDT rows after in the same order, so Avalanche is
   the second row of the whole list and of the USDC filter alike.

   BNB USDC joined on 2026-09-27 ("เอาทุกเชน" — every chain), and it is LAST in the
   USDC block because that is where BNB already sits in the USDT block: his order
   is the same both sides, and not one row he has already placed moves. */
test("A1) eleven origin routes in the owner's order: Base (default), Avalanche, Arbitrum, Optimism, Polygon, Ethereum, BNB; then USDT on Base, Arbitrum, Polygon, BNB", () => {
  assert.deepEqual(R.PERP_DEPOSIT_ROUTES.map((r) => r.id), [
    "base-usdc", "avalanche-usdc", "arbitrum-usdc", "optimism-usdc", "polygon-usdc", "ethereum-usdc", "bnb-usdc",
    "base-usdt", "arbitrum-usdt", "polygon-usdt", "bnb-usdt",
  ]);
  assert.equal(R.PERP_DEPOSIT_ROUTES[1].id, "avalanche-usdc", "Avalanche is the second row");
  assert.equal(R.DEFAULT_ROUTE_ID, "base-usdc");
  assert.equal(R.routeById(R.DEFAULT_ROUTE_ID), R.PERP_DEPOSIT_ROUTES[0]);
  assert.deepEqual(R.DEPOSIT_TOKENS.map((t) => t.symbol), ["USDC", "USDT"], "USDC leads (owner: the UI leads with USDC)");
  assert.deepEqual(R.routesForToken("USDC").map((r) => r.chainName), ["Base", "Avalanche", "Arbitrum", "Optimism", "Polygon", "Ethereum", "BNB"]);
  assert.deepEqual(R.routesForToken("USDT").map((r) => r.chainName), ["Base", "Arbitrum", "Polygon", "BNB"]);
  assert.equal(R.defaultRouteForToken("USDT").id, "base-usdt");
  assert.equal(R.routeById("bsc-usdt"), null);
  assert.equal(R.routeById(undefined), null);
});

test("A1b) 🔴 Avalanche is USDC only, because that is what Relay's solver takes there: no USDT route, and no USDe route either", () => {
  const avax = LIVE_CHAINS.find((c) => c.id === 43114);
  assert.deepEqual(avax.solverCurrencies.map((t) => t.symbol).sort(), ["USDC", "USDe"], "the live list that day");
  const ours = R.PERP_DEPOSIT_ROUTES.filter((r) => r.chainId === 43114);
  assert.deepEqual(ours.map((r) => r.token), ["USDC"], "a token Relay's solver does not process is lost when it is sent to a deposit address");
  assert.equal(ours[0].address, "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e");
  assert.equal(ours[0].decimals, 6);
  assert.equal(ours[0].chainName, "Avalanche");
  assert.equal(ours[0].explorer, "https://snowtrace.io");
  assert.ok(ours[0].chainLogo, "Avalanche paints a logo, not an empty circle");
});

test("A2) 🔴 every route is a live Relay solver currency on an enabled EVM chain: token, address and decimals match /chains", () => {
  assert.deepEqual(R.relayRouteProblems(LIVE_CHAINS), [], "the routes table disagrees with the live chains list");
  for (const r of R.PERP_DEPOSIT_ROUTES) {
    const c = LIVE_CHAINS.find((x) => x.id === r.chainId);
    assert.equal(c.vmType, "evm", `${r.id}: EVM only in v1 (refundTo must be the same address the user controls)`);
    const t = c.solverCurrencies.find((x) => x.address === r.address);
    assert.ok(t, `${r.id}: ${r.address} is not a solver currency on ${c.displayName}`);
    assert.equal(t.symbol, r.token);
    assert.equal(t.decimals, r.decimals);
    assert.equal(c.displayName, r.chainName);
    assert.equal(c.explorerUrl, r.explorer);
  }
  /* 🔴 BNB IS THE 18-DECIMAL CHAIN, BOTH TOKENS. A route priced in the wrong
     decimals asks Relay for a thousand-billion-fold amount, so the quote is
     refused or, worse, priced on something else. Both rows are named here so the
     exception stays an exception. */
  assert.equal(routeOf("bnb-usdt").decimals, 18, "BNB USDT is 18 decimals");
  assert.equal(routeOf("bnb-usdc").decimals, 18, "BNB USDC is 18 decimals (live quote, 2026-09-27: 20 tokens priced as 20000000000000000000)");
  assert.equal(routeOf("bnb-usdc").address, "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");
  assert.equal(routeOf("bnb-usdc").chainId, 56);
  assert.ok(R.PERP_DEPOSIT_ROUTES.filter((r) => r.chainId !== 56).every((r) => r.decimals === 6));
});

test("A3) the checker is not a tautology: a disabled chain, a moved token or wrong decimals are each reported", () => {
  const clone = () => JSON.parse(JSON.stringify(LIVE_CHAINS));
  const off = clone(); off.find((c) => c.id === 137).depositEnabled = false;
  assert.match(R.relayRouteProblems(off).join("\n"), /polygon-usdc/);
  const gone = clone(); gone.find((c) => c.id === 8453).solverCurrencies = gone.find((c) => c.id === 8453).solverCurrencies.filter((t) => t.symbol !== "USDC");
  assert.match(R.relayRouteProblems(gone).join("\n"), /base-usdc/);
  const dec = clone(); dec.find((c) => c.id === 56).solverCurrencies.find((t) => t.symbol === "USDT").decimals = 6;
  assert.match(R.relayRouteProblems(dec).join("\n"), /bnb-usdt/);
  const hl = clone(); hl.find((c) => c.id === 1337).depositEnabled = false;
  assert.ok(R.relayRouteProblems(hl).length > 0, "the destination (1337) going down is a problem too");
  assert.ok(R.relayRouteProblems(null).length > 0, "no chains list is not a pass");
});

test("A5) destination constants: Relay chain 1337, USDC (Perps) at the 32-hex placeholder, 8 decimals", () => {
  assert.equal(R.RELAY_API, "https://api.relay.link");
  assert.equal(R.HL_RELAY_CHAIN_ID, 1337);
  assert.equal(R.HL_PERP_USDC, "0x00000000000000000000000000000000");
  assert.equal(R.HL_PERP_USDC.length, 34, "32 hex digits, not an EVM address");
  const hl = LIVE_CHAINS.find((c) => c.id === 1337).solverCurrencies[0];
  assert.equal(hl.address, R.HL_PERP_USDC);
  assert.equal(hl.decimals, R.HL_PERP_USDC_DECIMALS);
});

test("A7) the nominal pricing amount is 20 tokens in base units: 6 and 18 decimals exact (BigInt, no float)", () => {
  assert.equal(R.NOMINAL_DEPOSIT, 20);
  assert.equal(R.nominalAmount(routeOf("base-usdc")), "20000000");
  assert.equal(R.nominalAmount(routeOf("bnb-usdt")), "20000000000000000000");
  assert.throws(() => R.nominalAmount({ decimals: 1.5 }));
});

/* ════════════════════════════════════════════════════════════════════════════
   B. THE QUOTE REQUEST
   ════════════════════════════════════════════════════════════════════════════ */

test("B1) the body: recipient = refundTo = the user, destination 1337 USDC (Perps), EXACT_INPUT, deposit address on", () => {
  const b = D.buildDepositQuoteBody({ user: USER, route: routeOf("base-usdc") });
  assert.deepEqual(b, {
    user: USER,
    recipient: USER,
    refundTo: USER,
    originChainId: 8453,
    originCurrency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    destinationChainId: 1337,
    destinationCurrency: "0x00000000000000000000000000000000",
    amount: "20000000",
    tradeType: "EXACT_INPUT",
    useDepositAddress: true,
  });
  const bnb = D.buildDepositQuoteBody({ user: USER, route: routeOf("bnb-usdt") });
  assert.equal(bnb.originChainId, 56);
  assert.equal(bnb.amount, "20000000000000000000");
});

test("B2) 🔴 refused BEFORE any request: a missing or other connected wallet, a bad address, an unknown route, a testnet build", async () => {
  const f = mockFetch(() => { throw new Error("must not be called"); });
  const base = { user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT };
  const cases = [
    [{ connected: undefined }, "not-connected"],
    [{ connected: null }, "not-connected"],
    [{ connected: OTHER }, "not-connected"],
    [{ user: "0x1234" }, "bad-user"],
    [{ user: "0x0000000000000000000000000000000000000000", connected: "0x0000000000000000000000000000000000000000" }, "bad-user"],
    [{ route: null }, "bad-route"],
    [{ route: { ...routeOf("base-usdc") } }, "bad-route"],
    [{ route: { ...routeOf("base-usdc"), chainId: 56, id: "bsc-usdt" } }, "bad-route"],
    [{ network: "testnet" }, "testnet-off"],
  ];
  for (const [over, codeWant] of cases) {
    await assert.rejects(D.getPerpDepositAddress({ ...base, ...over }), (e) => {
      assert.ok(e instanceof D.RelayDepositError, `${JSON.stringify(over)}: ${e}`);
      assert.equal(e.code, codeWant, JSON.stringify(over));
      return true;
    });
  }
  assert.equal(f.calls.length, 0, "nothing left the process");
});

test("B2b) 🔴 a saved address is not a way around the connected check: another connected wallet gets nothing, not even from the cache", async () => {
  const storage = fakeStorage();
  const memory = new Map();
  const ok = mockFetch(() => jsonRes(200, quoteFor(USER)));
  await D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: ok, storage, memory, now: () => QUOTED_AT });
  assert.equal(ok.calls.length, 1, "the control: USER's address is now saved");
  const f = mockFetch(() => { throw new Error("must not be called"); });
  for (const connected of [OTHER, null, undefined]) {
    await assert.rejects(
      D.getPerpDepositAddress({ user: USER, connected, route: routeOf("base-usdc"), fetchImpl: f, storage, memory, now: () => QUOTED_AT }),
      (e) => e instanceof D.RelayDepositError && e.code === "not-connected", String(connected),
    );
  }
  assert.equal(f.calls.length, 0);
});

test("B3) the connected check is case-insensitive (a checksummed and a lowercased form are one wallet)", async () => {
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const got = await D.getPerpDepositAddress({ user: USER, connected: USER.toLowerCase(), route: routeOf("base-usdc"), fetchImpl: f, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT });
  assert.equal(got.depositAddress, LIVE_DEPOSIT_ADDRESS);
});

test("B4) exactly one POST to https://api.relay.link/quote/v2 with the JSON body, after one GET of Relay's chains list, and nothing else", async () => {
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  await D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT, chainsMemo: D.newRelayChainsMemo() });
  assert.deepEqual(f.chainsCalls, [{ url: "https://api.relay.link/chains", method: "GET" }], "the route check: one read-only GET");
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, "https://api.relay.link/quote/v2");
  assert.equal(c.method, "POST");
  assert.equal(String(c.headers["Content-Type"] || c.headers["content-type"]), "application/json");
  assert.deepEqual(c.body, D.buildDepositQuoteBody({ user: USER, route: routeOf("base-usdc") }));
});

/* ════════════════════════════════════════════════════════════════════════════
   C. THE ANSWER IS VERIFIED BEFORE AN ADDRESS IS SHOWN
   ════════════════════════════════════════════════════════════════════════════ */

test("C1) the live answer parses: the address, the fee (in minus out, exactly the relayer fee), the time, the 180-day deadline", () => {
  const q = D.parseDepositQuote(quoteFor(USER), { user: USER, route: routeOf("base-usdc"), now: QUOTED_AT });
  assert.equal(q.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(q.feeEstimateUsdc, 0.029496, "20.0 in, 19.970504 USDC (Perps) out");
  assert.equal(q.timeEstimateSec, 1);
  assert.equal(q.expiresAt, DEADLINE_MS);
  assert.equal(q.expiresAt - QUOTED_AT, 180 * DAY, "an open address's order lives 180 days");
  assert.equal(q.quotedAt, QUOTED_AT);
  assert.equal(q.activationIncluded, false, "relayerGas 0.007496: the dEaD account already exists on Hyperliquid");
  assert.equal(q.requestId, "0x17900705003a1f7025e77356f88c9ce3502471a654d7b63aa9959258c4ca4e9a");
});

test("C2) a first deposit's activation shows up as relayerGas of about 1.2 USDC and is flagged", () => {
  const q = D.parseDepositQuote(quoteFor(USER, (x) => {
    x.fees.relayerGas.amount = "1207496"; x.fees.relayerGas.amountFormatted = "1.207496";
    x.details.currencyOut.amountFormatted = "18.770504";
  }), { user: USER, route: routeOf("base-usdc"), now: QUOTED_AT });
  assert.equal(q.activationIncluded, true);
  assert.equal(q.feeEstimateUsdc, 1.229496);
  assert.equal(q.activationUsdc, 1.207496, "the LIVE figure the first-deposit line prints, not a constant");
});

test("C2c) 🔴 the activation figure is the quote's own, and is withheld wherever the quote cannot tell it apart from gas", () => {
  const base = D.parseDepositQuote(quoteFor(USER), { user: USER, route: routeOf("base-usdc"), now: QUOTED_AT });
  assert.equal(base.activationIncluded, false);
  assert.equal(base.activationUsdc, null, "an account that already exists is charged no activation to report");
  const route = routeOf("ethereum-usdc");
  const eth = D.parseDepositQuote(quoteFor(USER, (x) => {
    x.details.currencyIn.currency = { chainId: 1, address: route.address, symbol: "USDC", decimals: 6 };
    x.steps[0].items[0].data.to = route.address;
    x.steps[0].items[0].data.chainId = 1;
    x.fees.relayerGas.amountFormatted = "1.9";
  }), { user: USER, route, now: QUOTED_AT });
  assert.equal(eth.activationIncluded, null);
  assert.equal(eth.activationUsdc, null, "1.9 on L1 is gas, the activation, or both: a figure nobody can tell apart is not printed");
});

test("C2b) on Ethereum mainnet a large relayerGas is NOT claimed as the activation: L1 gas alone can pass 1 USDC, so it is unknown (null)", () => {
  const route = routeOf("ethereum-usdc");
  const eth = (gas) => D.parseDepositQuote(quoteFor(USER, (x) => {
    x.details.currencyIn.currency = { chainId: 1, address: route.address, symbol: "USDC", decimals: 6 };
    x.steps[0].items[0].data.to = route.address;
    x.steps[0].items[0].data.chainId = 1;
    x.fees.relayerGas.amountFormatted = gas;
  }), { user: USER, route, now: QUOTED_AT });
  assert.equal(eth("1.9").activationIncluded, null, "gas or activation: the answer cannot tell");
  assert.equal(eth("0.4").activationIncluded, false, "below 1 USDC there is certainly no 1.2 activation in it");
  assert.equal(eth("1.9").feeEstimateUsdc, 0.029496, "the fee itself is still shown");
});

test("C3) 🔴 REFUSED: any recipient, refund or payment that is not the user; a wrong destination; a wrong origin token", () => {
  const route = routeOf("base-usdc");
  const bad = {
    "details.recipient": (q) => { q.details.recipient = OTHER; },
    "details.recipient missing": (q) => { delete q.details.recipient; },
    "a refund recipient": (q) => { q.protocol.v2.orderData.inputs[0].refunds[0].recipient = OTHER; },
    "the destination refund recipient": (q) => { q.protocol.v2.orderData.inputs[0].refunds[1].recipient = OTHER; },
    "no refunds at all": (q) => { q.protocol.v2.orderData.inputs[0].refunds = []; },
    "an output payment": (q) => { q.protocol.v2.orderData.output.payments[0].recipient = OTHER; },
    "a second output payment": (q) => { q.protocol.v2.orderData.output.payments.push({ recipient: OTHER, currency: R.HL_PERP_USDC }); },
    "no order data": (q) => { delete q.protocol; },
    "output on another chain": (q) => { q.protocol.v2.orderData.output.chainId = "base"; },
    "currencyOut chain": (q) => { q.details.currencyOut.currency.chainId = 999; },
    "currencyOut token (Spot USDC)": (q) => { q.details.currencyOut.currency.address = "0x6d1e7cde53ba9467b783cb7c530ce054"; },
    "currencyIn chain": (q) => { q.details.currencyIn.currency.chainId = 42161; },
    "currencyIn token": (q) => { q.details.currencyIn.currency.address = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"; },
  };
  for (const [name, mut] of Object.entries(bad)) {
    assert.throws(() => D.parseDepositQuote(quoteFor(USER, mut), { user: USER, route, now: QUOTED_AT }),
      (e) => e instanceof D.RelayDepositError && e.code === "unsafe-quote", name);
  }
  assert.throws(() => D.parseDepositQuote(quoteFor(DEAD), { user: USER, route, now: QUOTED_AT }),
    (e) => e.code === "unsafe-quote", "an answer made out for somebody else");
});

test("C4) 🔴 REFUSED: a missing, malformed, zero or self deposit address, and a step whose transfer points elsewhere", () => {
  const route = routeOf("base-usdc");
  const bad = {
    missing: (q) => { delete q.steps[0].depositAddress; },
    empty: (q) => { q.steps[0].depositAddress = ""; },
    short: (q) => { q.steps[0].depositAddress = "0xbadfbe97b7244a57c0ef7c5cd8d2a907923f07"; },
    "not hex": (q) => { q.steps[0].depositAddress = "0xbadfbe97b7244a57c0ef7c5cd8d2a907923f074z"; },
    zero: (q) => { q.steps[0].depositAddress = "0x0000000000000000000000000000000000000000"; },
    "the user": (q) => { q.steps[0].depositAddress = USER; },
    "two steps": (q) => { q.steps.push(q.steps[0]); },
    "no steps": (q) => { q.steps = []; },
    "transfer to another address": (q) => { q.steps[0].items[0].data.data = q.steps[0].items[0].data.data.replace("badfbe97b7244a57c0ef7c5cd8d2a907923f074d", "a9070019344b5a191b18721ef085b7e626daf86a"); },
    "transfer of another token": (q) => { q.steps[0].items[0].data.to = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"; },
    "transfer on another chain": (q) => { q.steps[0].items[0].data.chainId = 42161; },
  };
  for (const [name, mut] of Object.entries(bad)) {
    assert.throws(() => D.parseDepositQuote(quoteFor(USER, mut), { user: USER, route, now: QUOTED_AT }),
      (e) => e instanceof D.RelayDepositError && (e.code === "bad-deposit-address" || e.code === "unsafe-quote"), name);
  }
});

test("C5) an unreadable fee or time is null (the dash), never 0 — and never a reason to refuse the address", () => {
  const route = routeOf("base-usdc");
  const q = D.parseDepositQuote(quoteFor(USER, (x) => {
    delete x.details.currencyOut.amountFormatted;
    x.details.timeEstimate = "soon";
    delete x.fees.relayerGas;
    delete x.protocol.v2.orderData.output.deadline;
  }), { user: USER, route, now: QUOTED_AT });
  assert.equal(q.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(q.feeEstimateUsdc, null);
  assert.equal(q.timeEstimateSec, null);
  assert.equal(q.activationIncluded, null);
  assert.equal(q.expiresAt, null, "no deadline in the answer is unknown, not forever");
  const neg = D.parseDepositQuote(quoteFor(USER, (x) => { x.details.currencyOut.amountFormatted = "20.5"; }), { user: USER, route, now: QUOTED_AT });
  assert.equal(neg.feeEstimateUsdc, null, "out above in is not a negative fee");
});

test("C6) BNB USDT (18 decimals) parses the same way", () => {
  const route = routeOf("bnb-usdt");
  const q = D.parseDepositQuote(quoteFor(USER, (x) => {
    x.details.currencyIn.currency = { chainId: 56, address: route.address, symbol: "USDT", decimals: 18 };
    x.details.currencyIn.amountFormatted = "20.0";
    /* The dollar value every live answer states beside its own token amount, on
       both sides, because these two sides are two different tokens (C6b). Here
       both of them sit at exactly a dollar, so the fee is the same 0.029496. */
    x.details.currencyIn.amountUsd = "20.0";
    x.details.currencyOut.amountUsd = "19.970504";
    x.steps[0].items[0].data.to = route.address;
    x.steps[0].items[0].data.chainId = 56;
  }), { user: USER, route, now: QUOTED_AT });
  assert.equal(q.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(q.feeEstimateUsdc, 0.029496);
});

/* The live BNB USDT answer, 2026-09-28 (direct plan, 20 tokens, a brand-new
   account): 20.0 USDT in, stated as 19.977660 dollars; 18.699911 USDC out,
   stated as 18.697966 dollars; details.totalImpact.usd -1.279694; and
   fees.relayerGas 1.237340602861353998 with currency.symbol USDT beside
   amountUsd 1.235958. Both figures the screen prints from this answer are named
   USDC, so both have to BE in that unit. */
test("C6b) 🔴 on a USDT route the fee and the one-time cost are the answer's own DOLLARS, never a USDT amount under the word USDC", () => {
  const route = routeOf("bnb-usdt");
  const usdtQuote = (edit = null) => quoteFor(USER, (x) => {
    x.details.currencyIn.currency = { chainId: 56, address: route.address, symbol: "USDT", decimals: 18 };
    x.details.currencyIn.amountFormatted = "20.0";
    x.details.currencyIn.amountUsd = "19.977660";
    x.details.currencyOut.amountFormatted = "18.699911";
    x.details.currencyOut.amountUsd = "18.697966";
    x.fees.relayerGas.currency = { chainId: 56, address: route.address, symbol: "USDT", decimals: 18 };
    x.fees.relayerGas.amountFormatted = "1.237340602861353998";
    x.fees.relayerGas.amountUsd = "1.235958";
    x.steps[0].items[0].data.to = route.address;
    x.steps[0].items[0].data.chainId = 56;
    if (edit) edit(x);
  });
  const q = D.parseDepositQuote(usdtQuote(), { user: USER, route, now: QUOTED_AT });
  /* The answer's own impact figure, to the last digit it states. */
  assert.equal(q.feeEstimateUsdc, 1.279694);
  assert.notEqual(q.feeEstimateUsdc, 1.300089, "20.0 USDT minus 18.699911 USDC is not a figure in any unit");
  assert.equal(q.activationIncluded, true);
  assert.equal(q.activationUsdc, 1.235958, "the one-time cost in dollars");
  assert.notEqual(q.activationUsdc, 1.237340602861353998, "that is USDT, and the line beside it says USDC");
  /* An answer that states no dollar value for a leg in another token states no
     fee this screen can print: the dash, never a mixed subtraction. */
  const noUsd = D.parseDepositQuote(usdtQuote((x) => { delete x.details.currencyIn.amountUsd; }), { user: USER, route, now: QUOTED_AT });
  assert.equal(noUsd.feeEstimateUsdc, null);
  const noGasUsd = D.parseDepositQuote(usdtQuote((x) => { delete x.fees.relayerGas.amountUsd; }), { user: USER, route, now: QUOTED_AT });
  assert.equal(noGasUsd.activationIncluded, null, "a cost only stated in another token is not read as 1.2 USDC");
  assert.equal(noGasUsd.activationUsdc, null);
  /* A USDC route is untouched: one token on both sides, one plain difference. */
  assert.equal(D.parseDepositQuote(quoteFor(USER), { user: USER, route: routeOf("base-usdc"), now: QUOTED_AT }).feeEstimateUsdc, 0.029496);
});

test("C7) a Relay error answer becomes a RelayDepositError carrying the REASON it gave, with its own name scrubbed out of it; nothing is cached", async () => {
  const storage = fakeStorage();
  const memory = new Map();
  const f = mockFetch(() => jsonRes(400, { message: "Origin chain 12345 not supported", errorCode: "UNSUPPORTED_CHAIN" }));
  await assert.rejects(
    D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory, now: () => QUOTED_AT }),
    (e) => e instanceof D.RelayDepositError && e.code === "relay-error" && /Origin chain 12345 not supported/.test(e.message) && e.detail.errorCode === "UNSUPPORTED_CHAIN" && e.detail.status === 400,
  );
  assert.equal(storage._m.size, 0);
  assert.equal(memory.size, 0);
  /* 🔴 AND WHEN THE ANSWER CARRIES NO WORDS OF ITS OWN, the fallback sentence is
     OURS — so it names no provider (owner, 2026-09-23: "ไม่ต้องบอกด้วย ว่าใช้
     Deposit ด้วย Relay"). This is the one branch the suite never drove: every
     other case here hands the mock a `message`, so the fallback went out to the
     glass unread, through depositErrorText's "relay-error" passthrough. */
  const mute = mockFetch(() => jsonRes(500, {}));
  await assert.rejects(
    D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: mute, storage, memory, now: () => QUOTED_AT }),
    (e) => {
      assert.equal(e.code, "relay-error");
      assert.doesNotMatch(e.message, /relay|hyperliquid/i, e.message);
      assert.match(e.message, /500/, "it still says what came back");
      return true;
    },
  );
  const net = mockFetch(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(
    D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: net, storage, memory, now: () => QUOTED_AT }),
    (e) => e instanceof D.RelayDepositError && e.code === "network",
  );

  /* 🔴 AND WHEN THE ANSWER NAMES ITSELF, THE NAME DOES NOT REACH THE GLASS.
     The deposit sheet prints a relay-error's message verbatim, so the words the
     service chose are scrubbed here, where they enter this app, exactly as the
     withdraw path does it (lib/relay/plainWords.js). The REASON survives whole:
     that half is what tells a user what to do next. */
  const named = [
    ["Relay does not support origin chain 12345", /does not support origin chain 12345/],
    ["Failed to relay the transaction", /transaction/],
    ["This quote is for the other Hyperliquid network", /quote is for the other/],
  ];
  for (const [said, keeps] of named) {
    const f2 = mockFetch(() => jsonRes(400, { message: said }));
    await assert.rejects(
      D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f2, storage, memory, now: () => QUOTED_AT }),
      (e) => {
        assert.equal(e.code, "relay-error");
        assert.doesNotMatch(e.message, /relay|hyperliquid|hypercore|hyperevm/i, e.message);
        assert.match(e.message, keeps, e.message);
        assert.doesNotMatch(e.message, /\bthe the\b/i, e.message);
        assert.doesNotMatch(e.message, /\b(?:the|a|an|your|this) the\b/i, e.message);
        return true;
      },
    );
  }
  /* The one screen those words land on wraps them and adds no name of its own. */
  assert.equal(storage._m.size, 0);
});

test("C8) 🔴 REFUSED: an order that runs calls on Hyperliquid (a deposit address carries no destination calldata)", () => {
  /* Relay's deposit-address guide: "Calldata execution on destination is not
     allowed". The live answer has output.calls = []. A call list is the one
     place an order could move the credited USDC on after paying the user. */
  const route = routeOf("base-usdc");
  const withCalls = (calls) => quoteFor(USER, (q) => { q.protocol.v2.orderData.output.calls = calls; });
  for (const [name, calls] of Object.entries({
    "one call": [{ to: OTHER, data: "0x", value: "0" }],
    "a call list that is not a list": { to: OTHER },
    "a string": "0xdeadbeef",
  })) {
    assert.throws(() => D.parseDepositQuote(withCalls(calls), { user: USER, route, now: QUOTED_AT }),
      (e) => e instanceof D.RelayDepositError && e.code === "unsafe-quote", name);
  }
  assert.equal(D.parseDepositQuote(withCalls([]), { user: USER, route, now: QUOTED_AT }).depositAddress, LIVE_DEPOSIT_ADDRESS, "the live shape: an empty list");
  assert.equal(D.parseDepositQuote(quoteFor(USER), { user: USER, route, now: QUOTED_AT }).depositAddress, LIVE_DEPOSIT_ADDRESS, "no calls field at all (the trimmed fixture)");
});

/* ════════════════════════════════════════════════════════════════════════════
   D. ONE ADDRESS PER (USER, ROUTE): THE CACHE
   ════════════════════════════════════════════════════════════════════════════ */

test("D1) 🔴 the second open shows the SAME address with no request, although Relay would mint a new one", async () => {
  const storage = fakeStorage();
  let n = 0;
  const f = mockFetch(() => jsonRes(200, quoteFor(USER, (q) => {
    if (n++ > 0) {   // what the live API did on the second quote: a new address
      q.steps[0].depositAddress = LIVE_SECOND_ADDRESS;
      q.steps[0].items[0].data.data = q.steps[0].items[0].data.data.replace("badfbe97b7244a57c0ef7c5cd8d2a907923f074d", LIVE_SECOND_ADDRESS.slice(2));
    }
  })));
  const args = { user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, now: () => QUOTED_AT + 60000 };
  const first = await D.getPerpDepositAddress({ ...args, memory: new Map() });
  /* a new page load: memory gone, localStorage kept */
  const second = await D.getPerpDepositAddress({ ...args, memory: new Map() });
  assert.equal(f.calls.length, 1);
  assert.equal(first.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(second.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(second.route, routeOf("base-usdc"));
  assert.equal(second.feeEstimateUsdc, 0.029496, "a fresh quote's fee is still shown");
  const key = D.depositCacheKey(USER, "base-usdc");
  assert.equal(key, `flowflow.perpDeposit.v1:${USER.toLowerCase()}:base-usdc`);
  assert.ok(storage.getItem(key), "written under (user, route)");
});

test("D2) private mode (storage throws) still keeps one address for the session, in memory", async () => {
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  const memory = new Map();
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const args = { user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage: throwing, memory, now: () => QUOTED_AT };
  const a = await D.getPerpDepositAddress(args);
  const b = await D.getPerpDepositAddress(args);
  assert.equal(a.depositAddress, b.depositAddress);
  assert.equal(f.calls.length, 1);
  const none = await D.getPerpDepositAddress({ ...args, storage: null, memory: new Map() });
  assert.equal(none.depositAddress, LIVE_DEPOSIT_ADDRESS, "no storage at all is not an error");
});

test("D3) two opens at once make ONE quote (two quotes would be two different addresses)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = mockFetch(async () => { await gate; return jsonRes(200, quoteFor(USER)); });
  const args = { user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT };
  const p1 = D.getPerpDepositAddress(args);
  const p2 = D.getPerpDepositAddress(args);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(f.calls.length, 1);
  assert.equal(a.depositAddress, b.depositAddress);
});

test("D4) the cache is per user AND per route: another route or another wallet quotes again", async () => {
  const storage = fakeStorage();
  const memory = new Map();
  const f = mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    return jsonRes(200, quoteFor(body.user, (q) => {
      if (body.originChainId === 42161) {
        q.details.currencyIn.currency.chainId = 42161;
        q.details.currencyIn.currency.address = body.originCurrency;
        q.steps[0].items[0].data.chainId = 42161;
        q.steps[0].items[0].data.to = body.originCurrency;
      }
    }));
  });
  const common = { fetchImpl: f, storage, memory, now: () => QUOTED_AT };
  await D.getPerpDepositAddress({ ...common, user: USER, connected: USER, route: routeOf("base-usdc") });
  await D.getPerpDepositAddress({ ...common, user: USER, connected: USER, route: routeOf("arbitrum-usdc") });
  await D.getPerpDepositAddress({ ...common, user: OTHER, connected: OTHER, route: routeOf("base-usdc") });
  await D.getPerpDepositAddress({ ...common, user: USER, connected: USER, route: routeOf("base-usdc") });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map((c) => [c.body.recipient, c.body.originChainId]), [[USER, 8453], [USER, 42161], [OTHER, 8453]]);
});

test("D5) an address is renewed 14 days before its order's deadline, not used up to the last second", async () => {
  const storage = fakeStorage();
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const at = (t) => D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory: new Map(), now: () => t });
  await at(QUOTED_AT);
  await at(DEADLINE_MS - 15 * DAY);
  assert.equal(f.calls.length, 1, "still 15 days to go: reused");
  await at(DEADLINE_MS - 13 * DAY);
  assert.equal(f.calls.length, 2, "13 days to go: re-quoted");
  assert.equal(D.RENEW_BEFORE_MS, 14 * DAY);
});

test("D6) a deadline Relay did not state is not forever: the address is reused for 16 days, then renewed", async () => {
  const storage = fakeStorage();
  const f = mockFetch(() => jsonRes(200, quoteFor(USER, (q) => { delete q.protocol.v2.orderData.output.deadline; })));
  const at = (t) => D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory: new Map(), now: () => t });
  const a = await at(QUOTED_AT);
  assert.equal(a.expiresAt, null);
  await at(QUOTED_AT + 15 * DAY);
  assert.equal(f.calls.length, 1);
  await at(QUOTED_AT + 17 * DAY);
  assert.equal(f.calls.length, 2);
});

test("D7) a cached fee older than an hour is withheld (null), while the address itself is still reused", async () => {
  const storage = fakeStorage();
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const at = (t) => D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory: new Map(), now: () => t });
  await at(QUOTED_AT);
  const fresh = await at(QUOTED_AT + 59 * 60000);
  assert.equal(fresh.feeEstimateUsdc, 0.029496);
  const old = await at(QUOTED_AT + 61 * 60000);
  assert.equal(old.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(old.feeEstimateUsdc, null);
  assert.equal(old.activationIncluded, null);
  assert.equal(old.timeEstimateSec, 1, "the time estimate is a property of the route, kept");
  assert.equal(f.calls.length, 1);
  assert.equal(D.FEE_FRESH_MS, 3600000);
});

/* A saved entry holds a figure, not the arithmetic that made it, and on a route
   whose origin token is not USDC that arithmetic changed (C6b): the fee and the
   one-time cost are the answer's own dollars now, where they were a token amount
   under the word USDC before. Both are inside their hour, both are this user's
   and this route's, so nothing else here refuses the older one — and the same
   figure two ways within one hour of a deploy is exactly what MONEY_RULES 1
   forbids. Taken from the recorded 20 USDT answer from Base: 20.0 in stated as
   19.978080 dollars, 19.76115 USDC out stated as 19.759095. */
test("D7b) 🔴 a saved fee written by the OLD arithmetic is withheld like a stale one, and the address is still reused", async () => {
  const route = routeOf("bnb-usdt");
  const key = D.depositCacheKey(USER, route.id);
  const saved = {
    v: 1, user: USER.toLowerCase(), routeId: route.id, chainId: route.chainId, currency: route.address,
    depositAddress: LIVE_DEPOSIT_ADDRESS,
    /* 20.0 USDT minus 19.76115 USDC: a figure in no unit, which is the point. */
    feeEstimateUsdc: 0.23885, activationIncluded: true, activationUsdc: 1.223673,
    timeEstimateSec: 1, quotedAt: QUOTED_AT, pricedAt: QUOTED_AT, expiresAt: DEADLINE_MS, requestId: null,
  };
  const storage = fakeStorage({ [key]: JSON.stringify(saved) });
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const got = await D.getPerpDepositAddress({ user: USER, connected: USER, route, fetchImpl: f, storage, memory: new Map(), now: () => QUOTED_AT + 60000 });
  assert.equal(got.depositAddress, LIVE_DEPOSIT_ADDRESS, "the address is the customer's and is kept");
  assert.equal(f.calls.length, 0, "no new quote: only the figure is withheld");
  assert.equal(got.feeEstimateUsdc, null);
  assert.equal(got.activationUsdc, null);
  assert.equal(got.activationIncluded, null);
  assert.equal(got.feeStale, true, "withheld for its arithmetic, which the sheet re-prices exactly as it does an old one");
  /* The marker the new arithmetic writes, and the same entry with it: kept. */
  const marked = fakeStorage({ [key]: JSON.stringify({ ...saved, feeDefinition: D.FEE_DEFINITION }) });
  const ok = await D.getPerpDepositAddress({ user: USER, connected: USER, route, fetchImpl: mockFetch(() => jsonRes(200, quoteFor(USER))), storage: marked, memory: new Map(), now: () => QUOTED_AT + 60000 });
  assert.equal(ok.feeEstimateUsdc, 0.23885);
  assert.equal(ok.feeStale, false);
  /* And a USDC route cannot be moved by the change, so an entry saved before the
     marker existed still stands on one: no customer is shown a dash for nothing. */
  const usdc = routeOf("base-usdc");
  const uKey = D.depositCacheKey(USER, usdc.id);
  const uStore = fakeStorage({ [uKey]: JSON.stringify({ ...saved, routeId: usdc.id, chainId: usdc.chainId, currency: usdc.address, feeEstimateUsdc: 0.029496 }) });
  const u = await D.getPerpDepositAddress({ user: USER, connected: USER, route: usdc, fetchImpl: mockFetch(() => jsonRes(200, quoteFor(USER))), storage: uStore, memory: new Map(), now: () => QUOTED_AT + 60000 });
  assert.equal(u.feeEstimateUsdc, 0.029496);
  assert.equal(u.feeStale, false);
  /* A fresh quote writes the marker, so nothing it saves is ever re-priced for
     its arithmetic: the withholding above happens once and never loops. */
  const fresh = fakeStorage();
  await D.getPerpDepositAddress({ user: USER, connected: USER, route: usdc, fetchImpl: mockFetch(() => jsonRes(200, quoteFor(USER))), storage: fresh, memory: new Map(), now: () => QUOTED_AT });
  assert.equal(JSON.parse(fresh.getItem(uKey)).feeDefinition, D.FEE_DEFINITION);
});

test("D8) 🔴 a tampered or foreign cache entry is ignored: another user's address never shows for this user", async () => {
  const key = D.depositCacheKey(USER, "base-usdc");
  const good = { v: 1, user: USER.toLowerCase(), routeId: "base-usdc", chainId: 8453, currency: routeOf("base-usdc").address, depositAddress: LIVE_SECOND_ADDRESS, feeEstimateUsdc: 0.03, timeEstimateSec: 1, activationIncluded: false, quotedAt: QUOTED_AT, expiresAt: DEADLINE_MS, requestId: null };
  const poison = {
    "another user": { ...good, user: OTHER.toLowerCase() },
    "another route": { ...good, routeId: "arbitrum-usdc" },
    "another chain": { ...good, chainId: 42161 },
    "another token": { ...good, currency: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2" },
    "a bad address": { ...good, depositAddress: "0x1234" },
    "a zero address": { ...good, depositAddress: "0x0000000000000000000000000000000000000000" },
    "an old version": { ...good, v: 0 },
    "a future quote": { ...good, quotedAt: QUOTED_AT + 5 * DAY },
    "not JSON": "{oops",
  };
  for (const [name, entry] of Object.entries(poison)) {
    const storage = fakeStorage({ [key]: typeof entry === "string" ? entry : JSON.stringify(entry) });
    const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
    const got = await D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory: new Map(), now: () => QUOTED_AT });
    assert.equal(got.depositAddress, LIVE_DEPOSIT_ADDRESS, name);
    assert.equal(f.calls.length, 1, `${name}: re-quoted`);
  }
  const storage = fakeStorage({ [key]: JSON.stringify(good) });
  const f = mockFetch(() => { throw new Error("must not be called"); });
  const got = await D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory: new Map(), now: () => QUOTED_AT });
  assert.equal(got.depositAddress, LIVE_SECOND_ADDRESS, "the control: a valid entry is used");
});

/* ════════════════════════════════════════════════════════════════════════════
   P. RE-PRICING A SAVED ADDRESS (the fee moves; the address must not)
   Owner, 2026-09-22: "ถ้า Activate Account เสร็จ แม่งยังโชว์ Fee 2.5 First time อยู่".
   A quote made while the Hyperliquid account was new carries the activation in
   its fee, and the address it came with is kept for months. Once the account
   exists that fee is wrong. A new quote would mint a new address, so the fee is
   re-priced from a fresh quote and ONLY its figures are kept: the address the
   user may have saved stays the one on screen.
   ════════════════════════════════════════════════════════════════════════════ */

/* The live answer with the activation in it (a first deposit): relayerGas 1.2. */
const activationQuote = (user) => quoteFor(user, (x) => {
  x.fees.relayerGas.amount = "1207496"; x.fees.relayerGas.amountFormatted = "1.207496";
  x.details.currencyOut.amountFormatted = "18.770504";
});
/* The live answer as a second quote gives it: the same route, a NEW address. */
const secondAddressQuote = (user) => quoteFor(user, (q) => {
  q.steps[0].depositAddress = LIVE_SECOND_ADDRESS;
  q.steps[0].items[0].data.data = q.steps[0].items[0].data.data.replace("badfbe97b7244a57c0ef7c5cd8d2a907923f074d", LIVE_SECOND_ADDRESS.slice(2));
});

test("P1) 🔴 an address saved while the account was new is RE-PRICED, not replaced: the same address, the new fee saved beside it, the re-quote's own address thrown away", async () => {
  const storage = fakeStorage();
  const memory = new Map();
  const route = routeOf("base-usdc");
  const first = mockFetch(() => jsonRes(200, activationQuote(USER)));
  const a = await D.getPerpDepositAddress({ user: USER, connected: USER, route, fetchImpl: first, storage, memory, now: () => QUOTED_AT });
  assert.equal(a.activationIncluded, true, "the control: priced with the activation");
  assert.equal(a.feeEstimateUsdc, 1.229496);
  assert.equal(a.pricedAt, QUOTED_AT, "a new quote is priced when it is made");
  assert.equal(a.feeStale, false);

  const T = QUOTED_AT + 10 * 60000;
  const f = mockFetch(() => jsonRes(200, secondAddressQuote(USER)));
  const p = await D.repriceDepositFee({ user: USER, connected: USER, route, depositAddress: a.depositAddress, fetchImpl: f, storage, memory: new Map(), now: () => T });
  assert.equal(f.calls.length, 1, "one quote");
  assert.equal(f.calls[0].url, "https://api.relay.link/quote/v2");
  assert.deepEqual(f.calls[0].body, D.buildDepositQuoteBody({ user: USER, route }), "the same verified body: recipient = refundTo = the user");
  assert.equal(p.depositAddress, LIVE_DEPOSIT_ADDRESS, "the address on screen is kept");
  assert.equal(p.feeEstimateUsdc, 0.029496);
  assert.equal(p.activationIncluded, false);
  assert.equal(p.timeEstimateSec, 1);
  assert.equal(p.pricedAt, T);

  const saved = JSON.parse(storage.getItem(D.depositCacheKey(USER, "base-usdc")));
  assert.equal(saved.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(saved.feeEstimateUsdc, 0.029496);
  assert.equal(saved.activationIncluded, false);
  assert.equal(saved.pricedAt, T);
  assert.equal(saved.quotedAt, QUOTED_AT, "the address's own age is untouched");
  assert.equal(saved.expiresAt, DEADLINE_MS, "and so is its deadline");
  assert.doesNotMatch(storage.getItem(D.depositCacheKey(USER, "base-usdc")), new RegExp(LIVE_SECOND_ADDRESS.slice(2), "i"), "the re-quote's address is never saved");

  const none = mockFetch(() => { throw new Error("must not be called"); });
  const again = await D.getPerpDepositAddress({ user: USER, connected: USER, route, fetchImpl: none, storage, memory: new Map(), now: () => T + 10 * 60000 });
  assert.equal(again.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(again.feeEstimateUsdc, 0.029496, "the next open reads the re-priced fee");
  assert.equal(again.activationIncluded, false);
  assert.equal(again.pricedAt, T);
  assert.equal(none.calls.length, 0);
});

test("P2) a saved fee past its hour says it is stale (withheld, not unknown); a re-price brings it back and it is fresh for another hour", async () => {
  const storage = fakeStorage();
  const route = routeOf("base-usdc");
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const at = (t) => D.getPerpDepositAddress({ user: USER, connected: USER, route, fetchImpl: f, storage, memory: new Map(), now: () => t });
  await at(QUOTED_AT);
  assert.equal((await at(QUOTED_AT + 59 * 60000)).feeStale, false);
  const old = await at(QUOTED_AT + 61 * 60000);
  assert.equal(old.feeEstimateUsdc, null);
  assert.equal(old.feeStale, true, "withheld for its age: a re-price can fix it");
  const T = QUOTED_AT + 61 * 60000;
  const p = await D.repriceDepositFee({ user: USER, connected: USER, route, depositAddress: old.depositAddress, fetchImpl: f, storage, memory: new Map(), now: () => T });
  assert.equal(p.feeEstimateUsdc, 0.029496);
  const back = await at(T + 30 * 60000);
  assert.equal(back.feeEstimateUsdc, 0.029496);
  assert.equal(back.feeStale, false);
  assert.equal(f.calls.length, 2, "the first quote and the re-price");
  const unread = await D.getPerpDepositAddress({ user: USER, connected: USER, route, fetchImpl: mockFetch(() => jsonRes(200, quoteFor(USER, (q) => { delete q.details.currencyOut.amountFormatted; }))), storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT });
  assert.equal(unread.feeEstimateUsdc, null);
  assert.equal(unread.feeStale, false, "a fee Relay did not state is unknown, not stale");
});

test("P3) 🔴 a re-price is refused exactly like the address: no wallet or another one, a copied route, a testnet build, a dead route, a malformed address; an unsafe answer leaves the saved entry untouched", async () => {
  const route = routeOf("base-usdc");
  const key = D.depositCacheKey(USER, "base-usdc");
  const savedEntry = { v: 1, user: USER.toLowerCase(), routeId: "base-usdc", chainId: 8453, currency: route.address, depositAddress: LIVE_DEPOSIT_ADDRESS, feeEstimateUsdc: 1.229496, timeEstimateSec: 1, activationIncluded: true, quotedAt: QUOTED_AT, expiresAt: DEADLINE_MS, requestId: null };
  const f = mockFetch(() => { throw new Error("must not be called"); });
  const base = { user: USER, connected: USER, route, depositAddress: LIVE_DEPOSIT_ADDRESS, fetchImpl: f, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT };
  const cases = [
    [{ connected: null }, "not-connected"],
    [{ connected: OTHER }, "not-connected"],
    [{ user: "0x1234" }, "bad-user"],
    [{ route: { ...route } }, "bad-route"],
    [{ network: "testnet" }, "testnet-off"],
    [{ depositAddress: "0x1234" }, "bad-deposit-address"],
    [{ depositAddress: USER }, "bad-deposit-address"],
  ];
  for (const [over, want] of cases) {
    await assert.rejects(D.repriceDepositFee({ ...base, ...over }), (e) => e instanceof D.RelayDepositError && e.code === want, JSON.stringify(over));
  }
  assert.equal(f.calls.length, 0, "nothing left the process");

  const dead = mockFetch(() => { throw new Error("no quote may be asked for a dead route"); }, { chains: () => jsonRes(200, { chains: chainsWith((c) => { c.find((x) => x.id === 8453).depositEnabled = false; }) }) });
  await assert.rejects(
    D.repriceDepositFee({ ...base, fetchImpl: dead, chainsMemo: D.newRelayChainsMemo() }),
    (e) => e instanceof D.RelayDepositError && e.code === "route-unavailable",
  );
  assert.equal(dead.calls.length, 0);

  const storage = fakeStorage({ [key]: JSON.stringify(savedEntry) });
  const bad = mockFetch(() => jsonRes(200, quoteFor(OTHER)));
  await assert.rejects(
    D.repriceDepositFee({ ...base, fetchImpl: bad, storage }),
    (e) => e instanceof D.RelayDepositError && e.code === "unsafe-quote",
  );
  assert.deepEqual(JSON.parse(storage.getItem(key)), savedEntry, "a quote that does not pay this wallet changes nothing");
});

test("P4) a re-price for an address that is not the saved one (renewed meanwhile, or never saved) returns its figures and writes nothing", async () => {
  const route = routeOf("base-usdc");
  const key = D.depositCacheKey(USER, "base-usdc");
  const savedEntry = { v: 1, user: USER.toLowerCase(), routeId: "base-usdc", chainId: 8453, currency: route.address, depositAddress: LIVE_SECOND_ADDRESS, feeEstimateUsdc: 0.03, timeEstimateSec: 1, activationIncluded: false, quotedAt: QUOTED_AT, expiresAt: DEADLINE_MS, requestId: null };
  const storage = fakeStorage({ [key]: JSON.stringify(savedEntry) });
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const p = await D.repriceDepositFee({ user: USER, connected: USER, route, depositAddress: LIVE_DEPOSIT_ADDRESS, fetchImpl: f, storage, memory: new Map(), now: () => QUOTED_AT });
  assert.equal(p.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(p.feeEstimateUsdc, 0.029496);
  assert.deepEqual(JSON.parse(storage.getItem(key)), savedEntry, "another address's entry is not touched");
  const empty = fakeStorage();
  await D.repriceDepositFee({ user: USER, connected: USER, route, depositAddress: LIVE_DEPOSIT_ADDRESS, fetchImpl: f, storage: empty, memory: new Map(), now: () => QUOTED_AT });
  assert.equal(empty.getItem(key), null, "a re-price never creates an entry (only a quote's own address may be saved)");
});

test("P5) two re-prices at once share one quote", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = mockFetch(async () => { await gate; return jsonRes(200, quoteFor(USER)); });
  const args = { user: USER, connected: USER, route: routeOf("base-usdc"), depositAddress: LIVE_DEPOSIT_ADDRESS, fetchImpl: f, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT };
  const p1 = D.repriceDepositFee(args);
  const p2 = D.repriceDepositFee(args);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(f.calls.length, 1);
  assert.equal(a.feeEstimateUsdc, b.feeEstimateUsdc);
});

/* ════════════════════════════════════════════════════════════════════════════
   R. THE ROUTE IS RE-CHECKED AGAINST RELAY'S LIVE CHAINS LIST
   ════════════════════════════════════════════════════════════════════════════ */

const chainsWith = (mutate) => {
  const c = JSON.parse(JSON.stringify(LIVE_CHAINS));
  mutate(c);
  return c;
};

test("R1) 🔴 a SAVED address is not shown once Relay stops taking that route: the address is hidden AND forgotten; other routes still work", async () => {
  const storage = fakeStorage();
  const memory = new Map();
  const ok = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const first = await D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: ok, storage, memory, now: () => QUOTED_AT, chainsMemo: D.newRelayChainsMemo() });
  assert.equal(first.depositAddress, LIVE_DEPOSIT_ADDRESS, "the control: saved");
  const key = D.depositCacheKey(USER, "base-usdc");
  assert.ok(storage.getItem(key));
  const cases = {
    "deposits turned off on Base": (c) => { c.find((x) => x.id === 8453).depositEnabled = false; },
    "Base disabled": (c) => { c.find((x) => x.id === 8453).disabled = true; },
    "Base USDC no longer a solver currency": (c) => { const b = c.find((x) => x.id === 8453); b.solverCurrencies = b.solverCurrencies.filter((t) => t.symbol !== "USDC"); },
    "the destination (1337 USDC Perps) down": (c) => { c.find((x) => x.id === 1337).depositEnabled = false; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const s2 = fakeStorage({ [key]: storage.getItem(key) });
    const m2 = new Map();
    const f = mockFetch(() => { throw new Error("no quote may be asked for a dead route"); }, { chains: () => jsonRes(200, { chains: chainsWith(mutate) }) });
    await assert.rejects(
      D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage: s2, memory: m2, now: () => QUOTED_AT + 60000, chainsMemo: D.newRelayChainsMemo() }),
      (e) => e instanceof D.RelayDepositError && e.code === "route-unavailable" && e.detail.problems.length > 0, name,
    );
    assert.equal(f.calls.length, 0, `${name}: no quote`);
    assert.equal(s2.getItem(key), null, `${name}: the saved address is forgotten`);
    assert.equal(m2.has(key), false, name);
  }
  /* Only Base down: Arbitrum USDC is still offered. */
  const arb = mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    return jsonRes(200, quoteFor(body.user, (q) => {
      q.details.currencyIn.currency.chainId = 42161;
      q.details.currencyIn.currency.address = body.originCurrency;
      q.steps[0].items[0].data.chainId = 42161;
      q.steps[0].items[0].data.to = body.originCurrency;
    }));
  }, { chains: () => jsonRes(200, { chains: chainsWith((c) => { c.find((x) => x.id === 8453).depositEnabled = false; }) }) });
  const other = await D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("arbitrum-usdc"), fetchImpl: arb, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT, chainsMemo: D.newRelayChainsMemo() });
  assert.equal(other.depositAddress, LIVE_DEPOSIT_ADDRESS);
});

test("R2) 🔴 a chains list that cannot be read shows NO address, not even a saved one, and keeps the saved one for later", async () => {
  const key = D.depositCacheKey(USER, "base-usdc");
  const saved = { v: 1, user: USER.toLowerCase(), routeId: "base-usdc", chainId: 8453, currency: routeOf("base-usdc").address, depositAddress: LIVE_DEPOSIT_ADDRESS, feeEstimateUsdc: 0.03, timeEstimateSec: 1, activationIncluded: false, quotedAt: QUOTED_AT, expiresAt: DEADLINE_MS, requestId: null };
  const answers = {
    network: () => { throw new Error("offline"); },
    "relay-error": () => jsonRes(503, { message: "maintenance" }),
    "bad-response": () => jsonRes(200, { nope: true }),
  };
  for (const [codeWant, chains] of Object.entries(answers)) {
    const storage = fakeStorage({ [key]: JSON.stringify(saved) });
    const f = mockFetch(() => { throw new Error("must not be called"); }, { chains });
    await assert.rejects(
      D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory: new Map(), now: () => QUOTED_AT, chainsMemo: D.newRelayChainsMemo() }),
      (e) => e instanceof D.RelayDepositError && e.code === codeWant, codeWant,
    );
    assert.ok(storage.getItem(key), `${codeWant}: a blip is not a route change; the saved address stays for next time`);
  }
});

test("R3) the chains list is read once per 30 minutes, and two opens at once share one read", async () => {
  const memo = D.newRelayChainsMemo();
  const storage = fakeStorage();
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)));
  const at = (t) => D.getPerpDepositAddress({ user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage, memory: new Map(), now: () => t, chainsMemo: memo });
  await Promise.all([at(QUOTED_AT), at(QUOTED_AT)]);
  assert.equal(f.chainsCalls.length, 1, "one read for two opens");
  await at(QUOTED_AT + 29 * 60000);
  assert.equal(f.chainsCalls.length, 1);
  await at(QUOTED_AT + 31 * 60000);
  assert.equal(f.chainsCalls.length, 2, "re-read after 30 minutes");
  assert.equal(D.ROUTE_CHECK_TTL_MS, 30 * 60000);
  assert.equal(f.calls.length, 1, "and the saved address is still the one quote");
});

test("R4) a failed chains read is not kept: the next open asks again", async () => {
  const memo = D.newRelayChainsMemo();
  let down = true;
  const f = mockFetch(() => jsonRes(200, quoteFor(USER)), { chains: () => (down ? jsonRes(500, {}) : jsonRes(200, { chains: LIVE_CHAINS })) });
  const args = { user: USER, connected: USER, route: routeOf("base-usdc"), fetchImpl: f, storage: fakeStorage(), memory: new Map(), now: () => QUOTED_AT, chainsMemo: memo };
  await assert.rejects(D.getPerpDepositAddress(args), (e) => e.code === "relay-error");
  down = false;
  const got = await D.getPerpDepositAddress(args);
  assert.equal(got.depositAddress, LIVE_DEPOSIT_ADDRESS);
  assert.equal(f.chainsCalls.length, 2);
});

/* ════════════════════════════════════════════════════════════════════════════
   E. DEPOSIT STATUSES — GET /requests/v2?depositAddress=
   The shape is Relay's documented request object (status, recipient,
   data.inTxs / outTxs / metadata.currencyIn / currencyOut, createdAt). It was
   NOT called live here (not in the read-only allowance), so every field is
   read defensively.
   ════════════════════════════════════════════════════════════════════════════ */

const REQ = (over = {}) => ({
  id: "0xreq1",
  status: "success",
  user: USER,
  recipient: USER,
  data: {
    failReason: "N/A",
    inTxs: [{ hash: "0x" + "a".repeat(64), chainId: 8453, timestamp: 1790070600 }],
    outTxs: [{ hash: "0x" + "b".repeat(64), chainId: 1337, timestamp: 1790070602 }],
    metadata: {
      recipient: USER,
      currencyIn: { currency: { chainId: 8453, symbol: "USDC", decimals: 6 }, amount: "25000000", amountFormatted: "25.0" },
      currencyOut: { currency: { chainId: 1337, symbol: "USDC", decimals: 8 }, amount: "2496800000", amountFormatted: "24.968" },
    },
  },
  createdAt: "2026-09-22T10:00:00.000Z",
  updatedAt: "2026-09-22T10:00:03.000Z",
  ...over,
});

test("E1) Relay's statuses map onto three phases: arriving, credited, and the two exits (refunded, failed)", () => {
  const map = (s) => D.normalizeRelayRequest(REQ({ status: s }), { user: USER }).status;
  for (const s of ["waiting", "depositing", "pending", "submitted", "delayed"]) assert.equal(map(s), "arriving", s);
  assert.equal(map("success"), "credited");
  assert.equal(map("refund"), "refunded");
  assert.equal(map("refunded"), "refunded");
  assert.equal(map("failure"), "failed");
  assert.equal(map("something-new"), "unknown", "an unmapped status is not credited");
  assert.equal(map(undefined), "unknown");
});

test("E2) a row: amounts, symbols, tx hashes and times; unknowns are null, never 0", () => {
  const r = D.normalizeRelayRequest(REQ(), { user: USER });
  assert.deepEqual(
    { id: r.id, status: r.status, amountIn: r.amountIn, symbolIn: r.symbolIn, amountOut: r.amountOut, symbolOut: r.symbolOut, inTxHash: r.inTxHash, inChainId: r.inChainId, outTxHash: r.outTxHash, createdAt: r.createdAt, failReason: r.failReason, mismatch: r.mismatch },
    { id: "0xreq1", status: "credited", amountIn: 25, symbolIn: "USDC", amountOut: 24.968, symbolOut: "USDC", inTxHash: "0x" + "a".repeat(64), inChainId: 8453, outTxHash: "0x" + "b".repeat(64), createdAt: Date.parse("2026-09-22T10:00:00.000Z"), failReason: null, mismatch: false },
  );
  const bare = D.normalizeRelayRequest({ id: "0xreq2", status: "pending" }, { user: USER });
  assert.equal(bare.amountIn, null);
  assert.equal(bare.amountOut, null);
  assert.equal(bare.inTxHash, null);
  assert.equal(bare.createdAt, null);
  const junk = D.normalizeRelayRequest(REQ({ data: { metadata: { currencyIn: { amountFormatted: "abc" } }, inTxs: [{ hash: "nothex" }] } }), { user: USER });
  assert.equal(junk.amountIn, null);
  assert.equal(junk.inTxHash, null);
});

test("E3) 🔴 a request paying someone else is never shown as credited to this user", () => {
  const r = D.normalizeRelayRequest(REQ({ recipient: OTHER }), { user: USER });
  assert.equal(r.mismatch, true);
  assert.equal(r.status, "unknown");
  const m = D.normalizeRelayRequest(REQ({ recipient: undefined, data: { ...REQ().data, metadata: { ...REQ().data.metadata, recipient: OTHER } } }), { user: USER });
  assert.equal(m.status, "unknown");
});

test("E4) fetchDepositRequests: one GET to /requests/v2?depositAddress=, newest first; a bad answer throws", async () => {
  const f = mockFetch(() => jsonRes(200, { requests: [REQ({ id: "old", createdAt: "2026-09-22T09:00:00Z" }), REQ({ id: "new", createdAt: "2026-09-22T11:00:00Z", status: "pending" })] }));
  const rows = await D.fetchDepositRequests({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.relay.link/requests/v2?depositAddress=${LIVE_DEPOSIT_ADDRESS}`);
  assert.equal(f.calls[0].method, "GET");
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [["new", "arriving"], ["old", "credited"]]);
  const empty = await D.fetchDepositRequests({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: mockFetch(() => jsonRes(200, { requests: [] })) });
  assert.deepEqual(empty, []);
  await assert.rejects(D.fetchDepositRequests({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: mockFetch(() => jsonRes(200, { nope: 1 })) }));
  await assert.rejects(D.fetchDepositRequests({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: mockFetch(() => jsonRes(429, { message: "rate limited" })) }), (e) => e.status === 429);
  await assert.rejects(D.fetchDepositRequests({ depositAddress: "0x12", user: USER, fetchImpl: mockFetch(() => { throw new Error("no"); }) }), (e) => e.code === "bad-deposit-address");
});

/* ════════════════════════════════════════════════════════════════════════════
   F. THE TRACKER: GENTLE, VISIBLE-TAB ONLY, BACKING OFF
   ════════════════════════════════════════════════════════════════════════════ */

test("F1) the schedule: 8 s while a deposit is on its way; idle grows from 12 s to a 60 s cap; errors 15, 30, 60, 120 s; a 429 waits at least 60 s", () => {
  const d = D.nextPollDelay;
  assert.equal(d({ inFlight: true }), 8000);
  assert.equal(d({ inFlight: true, idleRounds: 3 }), 8000, "a few unchanged looks at 8 s: a real deposit lands in seconds");
  assert.equal(d({ inFlight: true, idleRounds: 4 }), 12000, "then a stuck request backs off");
  assert.equal(d({ inFlight: true, idleRounds: 5 }), 18000);
  assert.equal(d({ inFlight: true, idleRounds: 40 }), 60000, "to the same 60 s cap as idle");
  assert.equal(d({ idleRounds: 0 }), 12000);
  assert.equal(d({ idleRounds: 1 }), 18000);
  assert.equal(d({ idleRounds: 2 }), 27000);
  assert.equal(d({ idleRounds: 10 }), 60000);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => d({ errorStreak: n })), [15000, 30000, 60000, 120000, 120000, 120000]);
  assert.equal(d({ errorStreak: 1, rateLimited: true }), 60000);
  assert.equal(d({ errorStreak: 4, rateLimited: true }), 120000);
  assert.equal(d({ errorStreak: 1, inFlight: true }), 15000, "a failing API is not polled faster because a deposit is on its way");
});

/** A fake clock, timer queue and page. */
function fakeEnv({ hidden = false } = {}) {
  let t = QUOTED_AT;
  let seq = 0;
  const q = new Map();
  const vis = new Set();
  const env = {
    hidden,
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { fn, at: t + ms, ms }); return id; },
      clearTimeout: (id) => { q.delete(id); },
    },
    isHidden: () => env.hidden,
    onVisibility: (fn) => { vis.add(fn); return () => vis.delete(fn); },
    setHidden(h) { env.hidden = h; for (const fn of [...vis]) fn(); },
    pending: () => [...q.values()].map((x) => x.ms).sort((a, b) => a - b),
    listeners: () => vis.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        q.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
  return env;
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("F2) visible: polls at once, then on the schedule; each update is handed to onUpdate", async () => {
  const env = fakeEnv();
  const updates = [];
  const f = mockFetch(() => jsonRes(200, { requests: [] }));
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, onUpdate: (s) => updates.push(s), fetchImpl: f, ...env });
  await flush();
  assert.equal(f.calls.length, 1, "the first look is immediate");
  assert.equal(updates.at(-1).state, "ok");
  assert.deepEqual(updates.at(-1).requests, []);
  assert.equal(updates.at(-1).checkedAt, QUOTED_AT);
  assert.equal(tr.snapshot().state, "ok");
  await env.advance(11999);
  assert.equal(f.calls.length, 1);
  await env.advance(1);
  assert.equal(f.calls.length, 2, "12 s later");
  await env.advance(18000);
  assert.equal(f.calls.length, 3, "then 18 s (nothing changed)");
  tr.stop();
});

test("F3) 🔴 hidden: no request at all; coming back looks at once; hiding again parks it", async () => {
  const env = fakeEnv({ hidden: true });
  const f = mockFetch(() => jsonRes(200, { requests: [] }));
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: f, ...env });
  await env.advance(10 * 60000);
  assert.equal(f.calls.length, 0, "a hidden tab does no work");
  env.setHidden(false);
  await flush();
  assert.equal(f.calls.length, 1, "visible again: at once");
  env.setHidden(true);
  await env.advance(10 * 60000);
  assert.equal(f.calls.length, 1, "parked while hidden");
  assert.deepEqual(env.pending(), [], "no timer left armed while hidden");
  tr.stop();
});

test("F3b) a look that lands after the tab was hidden arms no timer; the next look waits for the tab to come back", async () => {
  const env = fakeEnv();
  let release;
  const f = mockFetch(() => new Promise((r) => { release = () => r(jsonRes(200, { requests: [] })); }));
  const updates = [];
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, onUpdate: (s) => updates.push(s), fetchImpl: f, ...env });
  await flush();
  env.setHidden(true);
  release();
  await flush();
  assert.equal(updates.at(-1).state, "ok", "the answer is still used");
  assert.deepEqual(env.pending(), [], "nothing armed while hidden");
  await env.advance(10 * 60000);
  assert.equal(f.calls.length, 1);
  env.setHidden(false);
  await flush();
  assert.equal(f.calls.length, 2, "back: at once");
  tr.stop();
});

test("F3c) a timer that fires while the tab is hidden, before the visibility event has arrived, makes no request", async () => {
  /* The page can be hidden a moment before visibilitychange is delivered (a
     phone locking, a tab switch under load): the look itself checks again. */
  const env = fakeEnv();
  const f = mockFetch(() => jsonRes(200, { requests: [] }));
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: f, ...env });
  await flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(env.pending(), [12000], "the next look is armed");
  env.hidden = true;   // hidden, and no event yet
  await env.advance(12000);
  assert.equal(f.calls.length, 1, "the armed look found the tab hidden and did nothing");
  assert.deepEqual(env.pending(), [], "and armed nothing");
  env.setHidden(false);
  await flush();
  assert.equal(f.calls.length, 2, "back: at once");
  tr.stop();
});

test("F4) a deposit on its way is polled every 8 s; once credited the cadence relaxes", async () => {
  const env = fakeEnv();
  let status = "pending";
  const f = mockFetch(() => jsonRes(200, { requests: [REQ({ status })] }));
  const updates = [];
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, onUpdate: (s) => updates.push(s), fetchImpl: f, ...env });
  await flush();
  assert.equal(updates.at(-1).requests[0].status, "arriving");
  await env.advance(8000);
  assert.equal(f.calls.length, 2);
  status = "success";
  await env.advance(8000);
  assert.equal(f.calls.length, 3);
  assert.equal(updates.at(-1).requests[0].status, "credited");
  await env.advance(8000);
  assert.equal(f.calls.length, 3, "not 8 s any more");
  await env.advance(4000);
  assert.equal(f.calls.length, 4, "12 s after the change");
  tr.stop();
});

test("F4b) a request stuck in flight (delayed, or an old one that never settles) does not hold the 8 s cadence for as long as the sheet is open", async () => {
  const env = fakeEnv();
  const f = mockFetch(() => jsonRes(200, { requests: [REQ({ status: "delayed" })] }));
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: f, ...env });
  await flush();
  assert.equal(f.calls.length, 1);
  const gaps = [];
  for (let i = 0; i < 9; i++) { gaps.push(env.pending()[0]); await env.advance(env.pending()[0]); }
  assert.deepEqual(gaps, [8000, 8000, 8000, 8000, 12000, 18000, 27000, 40500, 60000]);
  assert.equal(f.calls.length, 10);
  assert.deepEqual(env.pending(), [60000], "held at the cap, never faster");
  tr.stop();
});

test("F5) errors back off (15 s, 30 s, …); rows already shown are kept through a failed look", async () => {
  const env = fakeEnv();
  let fail = false;
  const f = mockFetch(() => (fail ? jsonRes(500, { message: "down" }) : jsonRes(200, { requests: [REQ()] })));
  const updates = [];
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, onUpdate: (s) => updates.push(s), fetchImpl: f, ...env });
  await flush();
  fail = true;
  await env.advance(12000);
  assert.equal(f.calls.length, 2);
  assert.equal(updates.at(-1).requests.length, 1, "the credited row stays on screen");
  assert.ok(updates.at(-1).error);
  await env.advance(14999);
  assert.equal(f.calls.length, 2);
  await env.advance(1);
  assert.equal(f.calls.length, 3, "15 s after the first failure");
  await env.advance(30000);
  assert.equal(f.calls.length, 4, "30 s after the second");
  fail = false;
  await env.advance(60000);
  assert.equal(f.calls.length, 5);
  assert.equal(updates.at(-1).error, null, "recovered");
  tr.stop();
});

test("F6) a first look that fails says error (no rows invented); a 429 waits 60 s", async () => {
  const env = fakeEnv();
  const f = mockFetch(() => jsonRes(429, { message: "Too many requests" }));
  const updates = [];
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, onUpdate: (s) => updates.push(s), fetchImpl: f, ...env });
  await flush();
  assert.equal(updates.at(-1).state, "error");
  assert.deepEqual(updates.at(-1).requests, []);
  await env.advance(59999);
  assert.equal(f.calls.length, 1);
  await env.advance(1);
  assert.equal(f.calls.length, 2);
  tr.stop();
});

test("F7) stop(): no more requests, no timers, no listener, and a late answer is dropped", async () => {
  const env = fakeEnv();
  let release;
  const f = mockFetch(() => new Promise((r) => { release = () => r(jsonRes(200, { requests: [REQ()] })); }));
  const updates = [];
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, onUpdate: (s) => updates.push(s), fetchImpl: f, ...env });
  await flush();
  assert.equal(env.listeners(), 1);
  tr.stop();
  release();
  await flush();
  assert.equal(updates.length, 0, "the answer landed after stop and was dropped");
  await env.advance(10 * 60000);
  assert.equal(f.calls.length, 1);
  assert.equal(env.listeners(), 0);
  assert.deepEqual(env.pending(), []);
});

test("F8) a request that hangs is abandoned after 20 s and counted as a failure (the tracker never wedges)", async () => {
  const env = fakeEnv();
  let n = 0;
  const f = mockFetch((url, init) => {
    n += 1;
    if (n === 1) return new Promise((_, rej) => { init.signal?.addEventListener?.("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    return jsonRes(200, { requests: [] });
  });
  const updates = [];
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, onUpdate: (s) => updates.push(s), fetchImpl: f, ...env });
  await flush();
  await env.advance(20000);
  assert.equal(updates.at(-1).state, "error");
  await env.advance(15000);
  assert.equal(f.calls.length, 2, "the next look happened on the error schedule");
  assert.equal(updates.at(-1).state, "ok");
  tr.stop();
});

test("F9) refresh() looks now; a malformed deposit address is refused before any request", async () => {
  const env = fakeEnv();
  const f = mockFetch(() => jsonRes(200, { requests: [] }));
  const tr = D.trackDeposits({ depositAddress: LIVE_DEPOSIT_ADDRESS, user: USER, fetchImpl: f, ...env });
  await flush();
  tr.refresh();
  await flush();
  assert.equal(f.calls.length, 2);
  tr.stop();
  assert.throws(() => D.trackDeposits({ depositAddress: "0x1234", fetchImpl: f, ...env }), (e) => e.code === "bad-deposit-address");
  assert.equal(f.calls.length, 2);
});

/* ════════════════════════════════════════════════════════════════════════════
   G. CSP — the browser may reach api.relay.link only in a flag-on build
   ════════════════════════════════════════════════════════════════════════════ */

/* 🔴 RECOVER FUND'S READ-ONLY RPCs, WRITTEN OUT HERE ONE BY ONE. Deriving this
   list from the module under test would check that the policy and the code agree
   and NOTHING ELSE: swapping a vendor in both places at once would then pass
   every CSP assertion in the repo with no review signal at all — the very hole
   the no-wildcard rule exists to close, reopened from the other end. So the six
   are LITERAL here, and the module's own list is asserted equal to them: a host
   added, removed or changed on either side fails, and fails where a reviewer of
   the policy is already looking. Arbitrum's is asserted separately above (it
   predates this feature), so it is not repeated. Each was checked from an https
   origin on 2026-09-29: OPTIONS 204 and POST 200, both with
   access-control-allow-origin *. */
const RECOVER_RPC_HOSTS = [
  "https://mainnet.base.org",
  "https://mainnet.optimism.io",
  "https://ethereum-rpc.publicnode.com",
  "https://polygon-bor-rpc.publicnode.com",
  "https://bsc-rpc.publicnode.com",
  "https://avalanche-c-chain-rpc.publicnode.com",
];

/* The module is imported INSIDE the test that needs it, never at module scope:
   a top-level await here would make every deposit guard in this file — refundTo,
   recipient, checkedBody, the deposit-address rules, 1400 lines of them —
   unloadable if one feature module failed to import, instead of failing the one
   CSP test that reads it.
   Compared as a SET (sorted), because the module's list falls out of its own
   chain-id order and which host is read first is not a policy question. */
async function recoverRpcOriginsFromModule() {
  const m = await import("../src/lib/relay/recoverFund.js");
  return m.RECOVER_RPC_ORIGINS.filter((o) => !o.includes("arbitrum")).slice().sort();
}

const directive = (csp, name) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

/* ════════════════════════════════════════════════════════════════════════════
   H. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

const LIB_FILES = [ROUTES_FILE, DEPOSIT_FILE];

test("H1) 🔴 the Relay lib signs nothing, sends nothing, holds no key, and never touches the Hyperliquid exchange endpoint", () => {
  for (const f of LIB_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /signTypedData|sendTransaction|eth_send|personal_sign|privateKey|mnemonic|Wallet\(|getSigner|useWallet/i, `${f} reaches for a signer`);
    assert.doesNotMatch(c, /hyperliquid\.xyz\/exchange|\/exchange["'`]/, `${f} names the exchange endpoint`);
    assert.doesNotMatch(c, /import\.meta\.env/, `${f} reads the env (it must stay provable in Node)`);
  }
});

test("H2) the lib's only hosts are Relay's API; the only paths are /quote/v2, /requests/v2 and the read-only /chains", () => {
  const all = LIB_FILES.map(code).join("\n");
  const hosts = [...all.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  const allowed = new Set(["api.relay.link", "basescan.org", "arbiscan.io", "polygonscan.com", "optimistic.etherscan.io", "etherscan.io", "bscscan.com", "snowtrace.io"]);
  assert.deepEqual([...new Set(hosts)].filter((h) => !allowed.has(h)), [], "an unexpected host");
  const paths = [...code(DEPOSIT_FILE).matchAll(/\/(quote|requests|execute|authorize|intents)\/[a-z0-9]+/gi)].map((m) => m[0]);
  assert.deepEqual([...new Set(paths)].sort(), ["/requests/v2"]);
  /* The quote goes to RELAY_QUOTE_URL: Relay's /quote/v2 itself, or (in a page) our own proxy, which adds the API key
     and forwards to exactly that path and nothing else (api/relay-quote.js). */
  assert.match(code(DEPOSIT_FILE), /fetchImpl\(RELAY_QUOTE_URL,/);
  const routes = fs.readFileSync(new URL("../src/lib/relay/routes.js", import.meta.url), "utf8");
  assert.match(routes, /export const RELAY_QUOTE_URL = typeof window === "undefined" \? `\$\{RELAY_API\}\/quote\/v2` : "\/api\/relay-quote";/);
  const proxy = fs.readFileSync(new URL("../api/relay-quote.js", import.meta.url), "utf8");
  assert.deepEqual([...proxy.matchAll(/https?:\/\/api\.relay\.link[^"'`\s]*/g)].map((m) => m[0]), ["https://api.relay.link/quote/v2"], "the proxy forwards to /quote/v2 only");
  const chainsReads = [...code(DEPOSIT_FILE).matchAll(/RELAY_API\}\/chains`,\s*\{\s*method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(chainsReads, ["GET"], "the chains list is one read-only GET");
});

test("H3) MONEY_RULES: no '?? 0', '|| 0' or Math.max(0, …) between an unknown and the screen", () => {
  for (const f of LIB_FILES) {
    assert.doesNotMatch(code(f), /\?\?\s*0(?![.\d])|\|\|\s*0(?![.\d])|Math\.max\(\s*0\s*,/, f);
  }
});

test("H4) Perp money stays its own figure: the Relay lib imports no wallet-money module", () => {
  for (const f of LIB_FILES) {
    assert.doesNotMatch(code(f), /usePortfolio|useWalletMoney|walletMoney|portfolioScan|walletBook/, f);
  }
});

test("H5) no quote is requested at import time (nothing runs until a sheet asks)", () => {
  for (const f of LIB_FILES) {
    const top = code(f).split("\n").filter((l) => /^\S/.test(l) && !/^(export\s+)?(async\s+)?(function|class|const|let|import|\}|\)|\])/.test(l));
    assert.deepEqual(top, [], `${f} runs something at module level`);
  }
});
