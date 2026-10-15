// ─────────────────────────────────────────────────────────────────────────────
// Relay deposit routes: where a Perp wallet deposit may come FROM.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-22: "Perp Wallet รับเป็น Relay.link เลย" / "amount ขอเป็น USDC ได้ปะ"
// / "หน้า UXUI เน้นให้ใช้ USDC (with Logo) ด้วยนะ" / "และ Deposit ด้วย Relay Deposit
// Address อะ". The Perp wallet is the user's own Hyperliquid account (the same
// EOA address), funded by sending a stablecoin to a Relay deposit address; Relay
// sweeps it and credits USDC (Perps) on Hyperliquid, which Relay calls chain 1337.
//
// THE TABLE. Nine origin routes, USDC first because the owner wants the screen to
// lead with USDC. Every row was checked against ONE live GET
// https://api.relay.link/chains on 2026-09-22 09:47 UTC: each token is a Relay
// SOLVER currency (only solver currencies can be processed by a deposit address;
// anything else sent to one is unrecoverable, per Relay's deposit-address docs),
// on a chain with depositEnabled true and disabled false. relayRouteProblems()
// re-checks the table against any /chains answer, and the test suite runs it
// against the saved live subset.
//
// EVM ONLY IN V1. A refund goes back to refundTo on the ORIGIN chain, and refundTo
// is the user's own address — on every chain in this table, the same address the
// Perp account itself lives at.
//
// 🔴 AND WHAT REACHES THAT MONEY IS THIS APP. These lines used to justify the
// design by saying the customer held an exportable key and so controlled the
// refund from outside. That stopped being true on 2026-09-23, when the owner
// removed key export (src/services/privy.js): from then until 2026-09-29 a
// refund landed in a wallet nobody could spend from, and this app read no
// balance and sent no transaction on any origin chain either. The justification
// now is perp/recover (lib/relay/recoverFund.js): it reads those balances on
// every chain in this table, tells the customer what is sitting in their own
// wallet, and moves it into their Perp account on one signature that costs them
// no gas. THE REFUND DESIGN IS ONLY SAFE WHILE THAT SURFACE EXISTS.
//
// Nothing here runs at import time and nothing reads the env, so every rule in
// this file is provable in Node (scripts/test-relay-deposit.mjs).

import { CHAIN_LOGO_FILES } from "./chainLogos.js";

export const RELAY_API = "https://api.relay.link";

/* Relay needs an API key on every POST /quote/v2 (from 2026-10-02), and the key must never reach the browser. So a
   page asks our own /api/relay-quote (api/relay-quote.js adds the key and passes the answer back verbatim); Node —
   the tests and scripts, where there is no page and no key to hide — asks Relay directly, as before. Every answer is
   still verified by the same code either way. */
export const RELAY_QUOTE_URL = typeof window === "undefined" ? `${RELAY_API}/quote/v2` : "/api/relay-quote";

/* Hyperliquid as Relay names it: chain 1337, vmType hypevm. Its native currency
   is USDC (Perps) at a 32-hex-digit placeholder (not an EVM address), 8 decimals. */
export const HL_RELAY_CHAIN_ID = 1337;
export const HL_PERP_USDC = "0x00000000000000000000000000000000";
export const HL_PERP_USDC_DECIMALS = 8;

/* A quote needs an amount even for an open deposit address; the route is priced
   on this many tokens, and the sheet says so next to the fee. */
export const NOMINAL_DEPOSIT = 20;

/* THE SIZES THE FEE BREAKDOWN PRICES, in the owner's own order (2026-09-28:
   "เช่น ถ้า Deposit 100,1000,5000,10000,100000,500000,1M ไรงี้"), with the size the
   sheet already prices at the head of the list so a reader can see the figure in
   the list and the figure above it agree. They live here, beside NOMINAL_DEPOSIT
   and the arithmetic that turns any of them into an amount, because that is the
   one place a size becomes money. */
export const DEPOSIT_FEE_SIZES = Object.freeze([NOMINAL_DEPOSIT, 100, 1000, 5000, 10000, 100000, 500000, 1000000]);

/* The two tokens, USDC first. The logos are the app's own files in public/tokens,
   the same ones the Deposit sheet and the pay-asset picker already paint. */
export const DEPOSIT_TOKENS = Object.freeze([
  Object.freeze({ symbol: "USDC", name: "USD Coin", logo: "/tokens/usdc.svg" }),
  Object.freeze({ symbol: "USDT", name: "Tether USD", logo: "/tokens/usdt.svg" }),
]);

/* The chains' own logos (owner, 2026-09-22: "หน้า Deposit Withdraw โลโก้ Chain
   ไม่ครบ"): Relay's icons, snapshotted into perp-public/chain-logos/ by
   scripts/fetch-chain-logos.mjs and served from our origin under a content
   version (chainLogos.js is that script's generated table). */
export const CHAIN_LOGO_DIR = "/chain-logos/";

/** Our own versioned logo file for a chain, or null when the snapshot has none. */
export function chainLogoUrl(chainId) {
  const f = chainId == null ? null : CHAIN_LOGO_FILES[String(chainId)];
  return f ? `${CHAIN_LOGO_DIR}${f}` : null;
}

/* The origin chains. logo is the snapshotted file above. mark, color and ink
   draw the small inline letter badge a chain falls back to when it has no
   file (ink is the letters' colour: dark on BNB's yellow, white elsewhere).
   explorer is Relay's own explorerUrl for the chain (live /chains, 2026-09-22). */
export const DEPOSIT_CHAINS = Object.freeze({
  8453: Object.freeze({ id: 8453, name: "Base", logo: chainLogoUrl(8453), mark: "B", color: "#0052FF", ink: "#FFFFFF", explorer: "https://basescan.org" }),
  42161: Object.freeze({ id: 42161, name: "Arbitrum", logo: chainLogoUrl(42161), mark: "A", color: "#28A0F0", ink: "#FFFFFF", explorer: "https://arbiscan.io" }),
  137: Object.freeze({ id: 137, name: "Polygon", logo: chainLogoUrl(137), mark: "P", color: "#8247E5", ink: "#FFFFFF", explorer: "https://polygonscan.com" }),
  10: Object.freeze({ id: 10, name: "Optimism", logo: chainLogoUrl(10), mark: "OP", color: "#FF0420", ink: "#FFFFFF", explorer: "https://optimistic.etherscan.io" }),
  1: Object.freeze({ id: 1, name: "Ethereum", logo: chainLogoUrl(1), mark: "E", color: "#627EEA", ink: "#FFFFFF", explorer: "https://etherscan.io" }),
  56: Object.freeze({ id: 56, name: "BNB", logo: chainLogoUrl(56), mark: "BNB", color: "#F0B90B", ink: "#1E2026", explorer: "https://bscscan.com" }),
  43114: Object.freeze({ id: 43114, name: "Avalanche", logo: chainLogoUrl(43114), mark: "AV", color: "#E84142", ink: "#FFFFFF", explorer: "https://snowtrace.io" }),
});

/** Every chain logo file the deposit and withdraw sheets can draw, for preloading. */
export const CHAIN_LOGO_URLS = Object.freeze(Object.values(DEPOSIT_CHAINS).map((c) => c.logo).filter(Boolean));

function makeRoute(id, chainId, token, address, decimals) {
  const chain = DEPOSIT_CHAINS[chainId];
  const tok = DEPOSIT_TOKENS.find((t) => t.symbol === token);
  return Object.freeze({
    id,
    chainId,
    chainName: chain.name,
    token,
    tokenName: tok.name,
    address,
    decimals,
    logo: tok.logo,
    chainLogo: chain.logo,
    explorer: chain.explorer,
    mark: chain.mark,
    color: chain.color,
    ink: chain.ink,
  });
}

/* Addresses are lowercase, exactly as Relay's /chains lists them. Polygon USDC
   is the NATIVE one (0x3c49…); bridged USDC.e (0x2791…) is a different solver
   currency and is not this route. BNB's USDT has 18 decimals.

   BNB USDC (56, 0x8ac7…, 18 DECIMALS), added 2026-09-27: the owner asked for every
   chain on the first deposit ("เอาทุกเชน"), and this was the one stablecoin row the
   deposit table was missing while the withdraw table already carried it. Checked
   the same way as every other row, on live quotes that day: Relay lists it on 56
   as a solver currency and priced 20 tokens as 20000000000000000000, which is the
   18 decimals below. It is the dearest USDC row (its fee grows with size), and it
   goes LAST in the USDC block, where BNB sits in the USDT block, so not one row
   the owner has already ordered moves.

   AVALANCHE (43114), owner 2026-09-23: "ขอเอา Avax เข้ามาด้วยดิ". Added after ONE
   live GET /chains that day: depositEnabled true, disabled false, vmType evm,
   and USDC 0xb97e… with 6 decimals among its solverCurrencies. THERE IS NO USDT
   ROUTE HERE, and that is not an omission: Avalanche's solver currencies that
   day were USDC and USDe only, and a token Relay's solver does not process is
   unrecoverable when it is sent to a deposit address. USDe is a different asset
   from the two this screen offers, so it is not a route either. If Relay lists
   Avalanche USDT later, it goes in the USDT block below like any other row. */
/* THE ORDER OF THIS LIST IS THE ORDER OF THE PICKER, AND IT IS THE OWNER'S, given
   twice on 2026-09-23: "เรียงเชนใหม่ BASE , AVAX อื่นๆตามมา" for both money screens,
   then, after he saw a list where Base's USDT sat second, "Deposit Avax ต้องอยู่อันที่
   สองสิวะ". So: the USDC rows in his chain order first, the USDT rows after in the
   same order. Avalanche is the second ROW however the screen reads this list —
   every route, or filtered to one token. The first row is also the default
   (DEFAULT_ROUTE_ID), and withdraw.js is ordered the same way.
   (An earlier attempt at this reorder was removed by a review that could not verify
   the request; his words above are why it is back.) */
export const PERP_DEPOSIT_ROUTES = Object.freeze([
  makeRoute("base-usdc", 8453, "USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6),
  makeRoute("avalanche-usdc", 43114, "USDC", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", 6),
  makeRoute("arbitrum-usdc", 42161, "USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6),
  makeRoute("optimism-usdc", 10, "USDC", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6),
  makeRoute("polygon-usdc", 137, "USDC", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6),
  makeRoute("ethereum-usdc", 1, "USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6),
  makeRoute("bnb-usdc", 56, "USDC", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18),
  makeRoute("base-usdt", 8453, "USDT", "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", 6),
  makeRoute("arbitrum-usdt", 42161, "USDT", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 6),
  makeRoute("polygon-usdt", 137, "USDT", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", 6),
  makeRoute("bnb-usdt", 56, "USDT", "0x55d398326f99059ff775485246999027b3197955", 18),
]);

export const DEFAULT_ROUTE_ID = "base-usdc";

/** What the Deposit screen offers (owner, 2026-10-15): USDC only, Avalanche first, then Base and Arbitrum. The table
 *  above keeps every route the rest of the app (and the quote proxy's allow-list) still knows. */
export const SHOWN_DEPOSIT_ROUTE_IDS = Object.freeze(["avalanche-usdc", "base-usdc", "arbitrum-usdc"]);
export const SHOWN_DEPOSIT_ROUTES = Object.freeze(SHOWN_DEPOSIT_ROUTE_IDS.map((id) => PERP_DEPOSIT_ROUTES.find((r) => r.id === id)).filter(Boolean));

/** The route with this id, or null. Callers pass THIS object on, never a copy. */
export function routeById(id) {
  return PERP_DEPOSIT_ROUTES.find((r) => r.id === id) || null;
}

/** The routes for a token, in the table's order. */
export function routesForToken(symbol) {
  return PERP_DEPOSIT_ROUTES.filter((r) => r.token === symbol);
}

/** The first route for a token (USDC: Base; USDT: Arbitrum), or null. */
export function defaultRouteForToken(symbol) {
  return routesForToken(symbol)[0] || null;
}

/** The token entry (symbol, name, logo), or null. */
export function depositTokenOf(symbol) {
  return DEPOSIT_TOKENS.find((t) => t.symbol === symbol) || null;
}

/**
 * A whole number of tokens in the route's base units, as a decimal string.
 *
 * 🔴 BIGINT, NOT A FLOAT, AND THAT IS NOT DECORATION. The dearest sizes the fee
 * breakdown prices go through here too, and BNB's rows carry 18 decimals: a
 * million tokens there is 1000000000000000000000000, which is 2^80 and cannot be
 * held by a double at all. Every amount that leaves this app is built here.
 */
export function depositAmount(route, tokens) {
  const d = route && route.decimals;
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error("route has no usable decimals");
  if (!Number.isInteger(tokens) || tokens <= 0) throw new Error("a deposit is a whole number of tokens");
  return (BigInt(tokens) * 10n ** BigInt(d)).toString();
}

/** NOMINAL_DEPOSIT tokens in the route's base units, as a decimal string (BigInt: no float). */
export function nominalAmount(route) {
  return depositAmount(route, NOMINAL_DEPOSIT);
}

/**
 * What in the table a Relay /chains answer does NOT support, as readable lines.
 * Empty means every route is a solver currency (same address, symbol and
 * decimals) on an enabled EVM chain, and the destination (1337 USDC Perps) is up.
 */
export function relayRouteProblems(chains) {
  const out = [];
  if (!Array.isArray(chains)) return ["no chains list"];
  const byId = new Map(chains.map((c) => [Number(c && c.id), c]));
  const up = (c) => !!c && c.depositEnabled === true && c.disabled !== true;
  const hl = byId.get(HL_RELAY_CHAIN_ID);
  const hlUsdc = hl && (hl.solverCurrencies || []).find((t) => String(t.address).toLowerCase() === HL_PERP_USDC);
  if (!up(hl) || !hlUsdc || hlUsdc.decimals !== HL_PERP_USDC_DECIMALS) out.push("destination 1337 USDC (Perps) is not available");
  for (const r of PERP_DEPOSIT_ROUTES) {
    const c = byId.get(r.chainId);
    if (!up(c)) { out.push(`${r.id}: chain ${r.chainId} is missing or not accepting deposits`); continue; }
    if (c.vmType !== "evm") { out.push(`${r.id}: chain ${r.chainId} is not EVM`); continue; }
    const t = (c.solverCurrencies || []).find((x) => String(x.address).toLowerCase() === r.address);
    if (!t) { out.push(`${r.id}: ${r.address} is not a solver currency`); continue; }
    if (t.symbol !== r.token) out.push(`${r.id}: symbol is ${t.symbol}, not ${r.token}`);
    if (t.decimals !== r.decimals) out.push(`${r.id}: decimals are ${t.decimals}, not ${r.decimals}`);
  }
  return out;
}
