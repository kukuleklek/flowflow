// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAW USDC OUT OF THE PERP ACCOUNT THROUGH RELAY, to many chains.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-22: "ขา Withdraw ... ทำไมขาออกมัน Relay ไม่ได้อะ ขาออกแพงชิบหาย" /
// "มันถูกสัสๆเลย Relay อะ Hypercore > ออกมา" / "แล้วมันควรต้องออกได้หลายเชนด้วยนะ" /
// "withdraw คือให้ใส่ เลข Wallet ได้ด้วยดิวะ".
//
// Hyperliquid's own bridge (withdraw3) pays $1, only to Arbitrum, in 3-5
// minutes. Relay quotes, LIVE 2026-09-22 (origin 1337, USDC (Perps), 8
// decimals, EXACT_INPUT): 5 USDC -> Arbitrum pays 4.995486 (fee $0.0045, ~1 s);
// 5 -> Base pays 4.972956 (fee $0.027, ~2 s).
//
// SO THIS IS THE WAY OUT, AND SINCE 2026-09-23 IT IS THE ONLY ONE ON SCREEN
// (owner: "ไม่ต้องมี Option Hyperliquid Bridge / ให้ใช้คำว่า Withdraw แทนคำว่า
// Relay"). The sheet offers no method to choose: there is one Withdraw. The
// bridge action stays where it always was, in the exchange layer, as the
// wallet's own withdraw3 capability with its own tests — no screen reaches it.
//
// THE SHAPE OF A RELAY WITHDRAWAL (live quote, scripts/test-relay-withdraw.mjs
// carries it unedited). One POST /quote/v2 answers TWO steps, in this order:
//
//   1. "authorize"  kind "signature": an EIP-712 NonceMapping that ties the
//      deposit about to be made to this order. It is SIGNED by the user's
//      wallet and then POSTed exactly as the step says (its own endpoint, its
//      own body, the signature as the query parameter Relay's SDK sends).
//   2. "deposit"    kind "transaction": a Hyperliquid "sendAsset" action that
//      moves the USDC from the user's perp account to RELAY'S DEPOSITORY on
//      HyperCore. Every field of it — the depository address above all — is
//      taken from THIS quote. Relay's docs show a stale depository; one that is
//      hard-coded is money sent to the wrong place.
//
// Relay then pays the recipient on the destination chain and
// /intents/status/v3 says when it has landed.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. user is the connected wallet, always: it is the account the USDC leaves.
//      recipient is what the CUSTOMER entered and nothing else — there is no
//      default here and no screen that fills one in (owner, 2026-09-23), so a
//      missing one is refused rather than aimed at the wallet that is paying
//      (validateWithdrawDestination below: EIP-55 checked, never re-cased,
//      never truncated). refundTo is the user, so a refund comes back to the
//      account it left.
//   2. Relay's answer is VERIFIED before anything is signed: the sender, the
//      recipient, every order payment and every refund, the origin (1337 USDC
//      Perps) and the destination (the route's chain and token), the sendAsset
//      destination against the order's own depository, and its amount and nonce
//      against the authorize step's. Anything else is refused and nothing is
//      signed or sent.
//   3. Unknown is null, never 0 (docs/MONEY_RULES.md section 0).
//   4. Nothing here signs, holds a key, or posts to Hyperliquid. The caller
//      hands in the exchange layer's own two calls — signRelayAuthorize(step)
//      and sendRelayDeposit({ step, amountUsdc }) — which take the quote's RAW
//      steps and check them again on their own terms (exchange/relayOut.js).
//      Both ALWAYS show the wallet's own prompt, because money moves.
//   5. A LOST REPLY AFTER THE sendAsset IS NOT A REFUSAL. The USDC may be on
//      its way: the answer says notConfirmed and carries the requestId, the
//      sheet says "Not confirmed" and offers no Try again, and the status read
//      keeps watching (same rule as the withdraw3 sheet).
//
// UNVERIFIED, and named so nobody reads it as measured: no withdrawal has been
// executed from this code (it moves real money, so the suite signs nothing and
// posts nothing). The quote and its two steps are a live capture. Where the
// signature rides on the POST (the query parameter) is Relay's SDK's own
// convention, and the authorize domain's chainId is 1, which an injected wallet
// pinned to another chain may refuse: its exact words are shown if it does.

import {
  RELAY_API, RELAY_QUOTE_URL, HL_RELAY_CHAIN_ID, HL_PERP_USDC, HL_PERP_USDC_DECIMALS,
  DEPOSIT_CHAINS, chainLogoUrl,
} from "./routes.js";
import { HL_NETWORK } from "../hyperliquid/config.js";
import { browserTimers, browserNow } from "../hyperliquid/browser.js";
import { plainMoneyWords } from "./plainWords.js";
import { armSignWords, disarmSignWords } from "../../services/signWords.js";

/* The words for the next window, or none. `armWords(null)` clears, so a caller
   that passes nothing leaves every window exactly as it was — and the clear
   after each signature means a request that never reached a wallet cannot
   leave its sentence lying about for somebody else's money. */
const armWords = (words) => { if (words) armSignWords(words); else disarmSignWords(); };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/* The sendAsset message the deposit step must carry, field for field and in
   order: Hyperliquid's own list, and what says the message means what we think
   it means. MIRRORED, not imported, from the signing layer's own exported
   contract (exchange/relayOut.js RELAY_SEND_ASSET_TYPE / _FIELDS): the withdraw
   sheet's render tests pin the module graph this file may pull in, and the
   signing layer is deliberately not on it. scripts/test-relay-withdraw.mjs
   asserts the two lists are identical, so a drift is a failing test here rather
   than a refusal in the user's wallet. */
export const SEND_ASSET_TYPE = "HyperliquidTransaction:SendAsset";
export const SEND_ASSET_FIELDS = Object.freeze([
  ["hyperliquidChain", "string"], ["destination", "string"], ["sourceDex", "string"], ["destinationDex", "string"],
  ["token", "string"], ["amount", "string"], ["fromSubAccount", "string"], ["nonce", "uint64"],
]);

export const WITHDRAW_QUOTE_TIMEOUT_MS = 20000;
/** The authorize POST and the status read get the same guard the quote has. */
export const WITHDRAW_POST_TIMEOUT_MS = 20000;
export const WITHDRAW_STATUS_TIMEOUT_MS = 12000;
/** A quote older than this is re-quoted before anything is signed. */
export const RELAY_WITHDRAW_QUOTE_TTL_MS = 60000;
/** Below this, Relay's fee and minimum fill make a withdrawal pointless. */
export const RELAY_MIN_WITHDRAW_USDC = 1;
/** Where the addresses this wallet has withdrawn to are remembered (this browser only). */
export const WITHDRAW_TO_PREFIX = "flowflow.perpWithdrawTo.v1:";
export const WITHDRAW_TO_MAX = 5;

export class RelayWithdrawError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "RelayWithdrawError";
    this.code = code;
    this.detail = detail;
  }
}

/** A 20-byte hex address that is not the zero address. */
export function isEvmAddress(a) {
  return typeof a === "string" && ADDRESS_RE.test(a) && a.toLowerCase() !== ZERO_ADDRESS;
}

/** Same address, whatever the checksum casing. */
export function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && ADDRESS_RE.test(a) && ADDRESS_RE.test(b) && a.toLowerCase() === b.toLowerCase();
}

const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* A REQUEST THAT CANNOT HANG. Every call in this file gets the same abort
   guard: a request with no end is worse here than a refusal, because the sheet
   above reads "in flight" as "money may be moving" and will not reset itself
   while one is — an endpoint that never answers would leave the withdraw sheet
   saying "Confirm in your wallet…" for the life of the page, closing and
   reopening included. A timeout lands in the caller's own network branch. */
async function fetchGuarded(fetchImpl, url, init, { signal = null, timers = browserTimers, timeoutMs = WITHDRAW_POST_TIMEOUT_MS } = {}) {
  const ctrl = !signal && typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, { ...init, signal: signal || (ctrl ? ctrl.signal : undefined) });
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
}

/* ── where a withdrawal can go ────────────────────────────────────────────── */

function dest(id, chainId, token, address, decimals) {
  const chain = DEPOSIT_CHAINS[chainId];
  return Object.freeze({
    id,
    chainId,
    chainName: chain.name,
    token,
    address,
    decimals,
    logo: token === "USDT" ? "/tokens/usdt.svg" : "/tokens/usdc.svg",
    chainLogo: chainLogoUrl(chainId),
    explorer: chain.explorer,
  });
}

/**
 * The destinations, cheapest first (owner: Arbitrum is the default). Each token
 * is a Relay SOLVER currency on that chain in the live /chains answer of
 * 2026-09-22, exactly as the deposit table's rows are (routes.js), and
 * withdrawRouteProblems() re-checks the table against any /chains list.
 *
 * AVALANCHE (43114) joined on 2026-09-23 (owner: "ขอเอา Avax เข้ามาด้วยดิ"), from
 * the same live /chains read that added it to the deposit table. USDC only: the
 * chain's solver currencies that day were USDC and USDe, so there is no USDT
 * destination here to offer. A destination Relay cannot pay is a refused quote,
 * so this table never guesses one.
 */
/* THE ORDER IS THE OWNER'S, set 2026-09-23 for both money screens: "เรียงเชนใหม่
   BASE , AVAX อื่นๆตามมา". Chains in his order, USDC before USDT inside a chain,
   and the first row is the default — so Base, not Arbitrum, is now where a
   withdrawal starts. THE COST OF THAT IS REAL AND THE OWNER WAS TOLD IT: live
   quotes on 2026-09-22 for 5 USDC out charged about $0.005 to Arbitrum and about
   $0.027 to Base (both against the $1 the Hyperliquid bridge used to charge).
   The picker shows the live fee per destination, so a customer can still pick the
   cheaper chain; only the starting row changed. */
export const PERP_WITHDRAW_ROUTES = Object.freeze([
  dest("base-usdc", 8453, "USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6),
  dest("avalanche-usdc", 43114, "USDC", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", 6),
  dest("arbitrum-usdc", 42161, "USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6),
  dest("optimism-usdc", 10, "USDC", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6),
  dest("polygon-usdc", 137, "USDC", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6),
  dest("ethereum-usdc", 1, "USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6),
  dest("bnb-usdc", 56, "USDC", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18),
  dest("bnb-usdt", 56, "USDT", "0x55d398326f99059ff775485246999027b3197955", 18),
]);

export const DEFAULT_WITHDRAW_ROUTE_ID = "base-usdc";

/** What the Withdraw screen offers (owner, 2026-10-15): USDC only, Avalanche first, then Base and Arbitrum. */
export const SHOWN_WITHDRAW_ROUTE_IDS = Object.freeze(["avalanche-usdc", "base-usdc", "arbitrum-usdc"]);
export const SHOWN_WITHDRAW_ROUTES = Object.freeze(SHOWN_WITHDRAW_ROUTE_IDS.map((id) => PERP_WITHDRAW_ROUTES.find((r) => r.id === id)).filter(Boolean));

/** The destination with this id, or null. Callers pass THIS object on, never a copy. */
export function withdrawRouteById(id) {
  return PERP_WITHDRAW_ROUTES.find((r) => r.id === id) || null;
}

/** Every chain logo the withdraw sheet can draw, for preloading. */
export const WITHDRAW_LOGO_URLS = Object.freeze([
  "/tokens/usdc.svg",
  "/tokens/usdt.svg",
  ...new Set(PERP_WITHDRAW_ROUTES.map((r) => r.chainLogo).filter(Boolean)),
]);

/**
 * What in a Relay /chains answer stops a withdrawal to these destinations.
 * Empty means every destination is a live solver currency on an enabled EVM
 * chain, and the origin (1337 USDC Perps) is up.
 *
 * THE SUITE'S CHECK, NOT A RUNTIME GATE, and deliberately so. It is how the
 * table above is caught drifting from Relay's own list (test-relay-withdraw
 * W1, against a captured live answer). The withdraw sheet does NOT call it:
 * this is the way OUT of the account, and making it wait on /chains would shut
 * that door whenever that one endpoint is unreachable. A de-listed route is
 * refused by the quote instead, in Relay's own words, in the quote box.
 * (The DEPOSIT path is the other way round — depositAddress.js will not show
 * an address until assertRouteLive passes, because money sent to a dead route
 * is money gone, while a quote that is refused has cost nothing.)
 */
export function withdrawRouteProblems(chains, only = null) {
  const out = [];
  if (!Array.isArray(chains)) return ["no chains list"];
  const byId = new Map(chains.map((c) => [Number(c && c.id), c]));
  const up = (c) => !!c && c.disabled !== true;
  const hl = byId.get(HL_RELAY_CHAIN_ID);
  const hlUsdc = hl && (hl.solverCurrencies || []).find((t) => String(t.address).toLowerCase() === HL_PERP_USDC);
  if (!up(hl) || !hlUsdc || hlUsdc.decimals !== HL_PERP_USDC_DECIMALS) out.push("origin 1337 USDC (Perps) is not available");
  for (const r of PERP_WITHDRAW_ROUTES) {
    if (only && r !== only) continue;
    const c = byId.get(r.chainId);
    if (!up(c)) { out.push(`${r.id}: chain ${r.chainId} is missing or off`); continue; }
    if (c.vmType !== "evm") { out.push(`${r.id}: chain ${r.chainId} is not EVM`); continue; }
    const t = (c.solverCurrencies || []).find((x) => String(x.address).toLowerCase() === r.address);
    if (!t) { out.push(`${r.id}: ${r.address} is not a solver currency`); continue; }
    if (t.symbol !== r.token) out.push(`${r.id}: symbol is ${t.symbol}, not ${r.token}`);
    if (t.decimals !== r.decimals) out.push(`${r.id}: decimals are ${t.decimals}, not ${r.decimals}`);
  }
  return out;
}

/* ── the destination address the user may paste ───────────────────────────── */

/* EIP-55: the checksum casing of an address, from its keccak-256 hash. A
   mixed-case address that does not match has a typo in it, and an address with
   a typo is money gone. */
function eip55(lower, keccak) {
  const hex = lower.slice(2);
  const hash = keccak(hex);
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    const c = hex[i];
    out += /[0-9]/.test(c) ? c : parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * The address a user pasted, checked.
 *   ok       the address, EXACTLY as it was typed (never re-cased, never cut)
 *   error    why it cannot be used, in plain words
 *   checksum whether its capitalisation was checked (an all-lowercase address
 *            carries no checksum to check, which is normal and allowed)
 * @param {{ own?: string|null, keccak?: (hex: string) => string }} o
 *   keccak: hex of keccak-256 over the address's lowercase hex, for EIP-55.
 *   Without one, a mixed-case address is refused rather than trusted.
 */
export function validateWithdrawDestination(input, { own = null, keccak = null } = {}) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return { ok: false, address: "", error: null, empty: true, checksum: false, isOwn: false };
  const no = (error) => ({ ok: false, address: raw, error, empty: false, checksum: false, isOwn: false });
  if (!/^0x/i.test(raw)) return no("An address starts with 0x.");
  if (!ADDRESS_RE.test(raw)) return no("An EVM address is 0x and 40 more characters. Check you pasted the whole thing.");
  /* ONE VERDICT FOR ONE SCREEN. The same addresses the exchange layer refuses
     (exchange/master.js readDestinationAddress) are refused here, so no path
     through the app can decide an address is safe when the other one does not. */
  if (raw.toLowerCase() === ZERO_ADDRESS) return no("That is the zero address: money sent there is burned.");
  if (/^0x0{36}dead$/i.test(raw)) return no("That address can never send the money back. Check it and paste it again.");
  const body = raw.slice(2);
  const mixed = /[a-f]/.test(body) && /[A-F]/.test(body);
  let checksum = false;
  if (mixed) {
    if (typeof keccak !== "function") return no("This address's capitalisation can't be checked here. Paste it in lower case, or check it again.");
    if (eip55(raw.toLowerCase(), keccak) !== raw) {
      return no("That address has a typo: its capitalisation doesn't check out (EIP-55). Paste it again.");
    }
    checksum = true;
  }
  return { ok: true, address: raw, error: null, empty: false, checksum, isOwn: !!(own && sameAddress(raw, own)) };
}

/** "0xf39Fd6e51a … cffFb92266": the ends a reader compares, never a middle cut alone. */
export function destinationEnds(address, n = 6) {
  const a = String(address || "");
  if (!ADDRESS_RE.test(a)) return { head: a, middle: "", tail: "" };
  return { head: a.slice(0, n + 2), middle: a.slice(n + 2, a.length - n), tail: a.slice(a.length - n) };
}

/* ── sending it to the in-app wallet: a caution, not a block ──────────────── */
//
// The screen no longer offers the in-app wallet's address (owner, 2026-09-23:
// "ตอนหน้า Withdraw ไม่ต้องให้มี Wallet ของ Privy เลยดิ ให้ลูกค้า ใส่เอง หรือวางได้เลย"), but a
// customer may still enter it, and they are allowed to: it is their wallet.
// What they need told once is that FlowFlow offers no key export any more, so
// money that lands there cannot be reached with anything else.
//
// AN INJECTED WALLET GETS NO CAUTION. The user holds that key themselves, so
// sending to it is an ordinary withdrawal, and a warning on it would be noise
// on a money screen — which teaches people to read past the real ones.

/** The wallet type the seam reports for the in-app (embedded) wallet. */
export const IN_APP_WALLET_TYPE = "privy";

/* One sentence, in plain words, naming no provider and no venue. Since
   2026-10-15 the app moves USDC that sits in the in-app wallet on Arbitrum into
   the Perp account by itself (perp/deposit/perpFunding.js — the last hop of a
   deposit, which cannot tell a deposit from a withdrawal), so the sentence says
   that too, before anything is sent: a withdrawal there comes straight back,
   less its fee. */
const IN_APP_WITHDRAW_CAUTION = "That address is your in-app wallet, and FlowFlow can't give you its key, so money sent there can't be reached from outside the app, and USDC that lands there on Arbitrum moves straight back into your Perp account.";

/**
 * The caution for withdrawing to your own in-app wallet, or null when there is
 * nothing to say. It never refuses anything: the screen shows the sentence and
 * leaves the choice where it belongs.
 * @param {{ address?: string|null, wallet?: string|null, walletType?: string|null }} o
 *   address: the destination the customer entered; wallet: the connected one.
 */
export function inAppWithdrawCaution({ address = null, wallet = null, walletType = null } = {}) {
  if (walletType !== IN_APP_WALLET_TYPE) return null;
  if (!isEvmAddress(address) || !isEvmAddress(wallet)) return null;
  return sameAddress(address, wallet) ? IN_APP_WITHDRAW_CAUTION : null;
}

/* ── remembered destinations (this browser, this wallet) ──────────────────── */

const toKey = (user) => `${WITHDRAW_TO_PREFIX}${String(user).toLowerCase()}`;

/** The addresses this wallet has withdrawn to, newest first. */
export function recentDestinations(storage, user) {
  if (!storage || !isEvmAddress(user)) return [];
  let raw = null;
  try { raw = storage.getItem(toKey(user)); } catch { return []; }
  if (!raw) return [];
  let list = null;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((a) => isEvmAddress(a)).slice(0, WITHDRAW_TO_MAX);
}

/** Remember one destination for this wallet (newest first, at most WITHDRAW_TO_MAX). */
export function rememberDestination(storage, user, address) {
  if (!storage || !isEvmAddress(user) || !isEvmAddress(address)) return recentDestinations(storage, user);
  const kept = recentDestinations(storage, user).filter((a) => !sameAddress(a, address));
  const next = [address, ...kept].slice(0, WITHDRAW_TO_MAX);
  try { storage.setItem(toKey(user), JSON.stringify(next)); } catch { /* private mode: nothing is remembered */ }
  return next;
}

/* ── the quote ────────────────────────────────────────────────────────────── */

/**
 * A USDC amount in the origin's base units (8 decimals), as a decimal string.
 * BigInt only: a float would lose the last digits of a large amount.
 * @returns {string|null} null when the amount is not a usable number
 */
export function usdcToRelayUnits(amount, decimals = HL_PERP_USDC_DECIMALS) {
  const s = typeof amount === "number" ? (Number.isFinite(amount) ? String(amount) : "") : String(amount == null ? "" : amount).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [int = "", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const units = BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt((frac || "").padEnd(decimals, "0") || "0");
  return units > 0n ? units.toString() : null;
}

/**
 * The /quote/v2 body: out of the perp account, into the route's token on its
 * chain.
 *
 * ONE BODY BUILDER, TWO WAYS ROUND, AND THE SAME KEYS EITHER WAY. A withdrawal
 * states what LEAVES (`amountUsdc`, the origin's 8 decimals, EXACT_INPUT) and
 * the answer says what arrives. Buying a little gas for a stuck recovery states
 * what ARRIVES instead (`amountRaw`, the destination's own base units,
 * EXACT_OUTPUT) and the answer says what it costs — because only that way round
 * is the delivery guaranteed rather than estimated, and only a guaranteed figure
 * may be printed (lib/relay/gasBuy.js holds the measurements). Nothing else
 * about the request differs, which is why there is no second builder: the user
 * pays, the recipient is paid, and refundTo is the account the money left.
 */
export function buildWithdrawQuoteBody({ user, recipient, route, amountUsdc, amountRaw = null, tradeType = "EXACT_INPUT" }) {
  if (tradeType !== "EXACT_INPUT" && tradeType !== "EXACT_OUTPUT") {
    throw new RelayWithdrawError("bad-amount", "That is not a way to price this.");
  }
  let amount = null;
  if (amountRaw == null) {
    amount = usdcToRelayUnits(amountUsdc);
    if (!amount) throw new RelayWithdrawError("bad-amount", "Enter a USDC amount, with at most 8 decimals.");
  } else {
    /* Base units the CALLER read off an answer, never a typed decimal: a BigInt
       or its digits, and nothing else is accepted. */
    const raw = typeof amountRaw === "bigint" ? amountRaw
      : typeof amountRaw === "string" && /^[0-9]+$/.test(amountRaw) ? BigInt(amountRaw)
        : null;
    if (raw == null || raw <= 0n) throw new RelayWithdrawError("bad-amount", "That amount was not read from a quote.");
    amount = raw.toString();
  }
  return {
    user,
    recipient,
    refundTo: user,
    originChainId: HL_RELAY_CHAIN_ID,
    originCurrency: HL_PERP_USDC,
    destinationChainId: route.chainId,
    destinationCurrency: route.address,
    amount,
    tradeType,
  };
}

/* 🔴 EVERY MESSAGE BELOW IS READ BY THE USER, so none of them names the
   provider or the venue (owner, 2026-09-23: "ไม่ต้องบอกด้วย ว่าใช้ Deposit ด้วย
   Relay" / "ไม่ต้องไปอ้าง Hyperliquid"). The withdraw sheet renders these
   strings verbatim — a quote refusal under "Couldn't price this withdrawal",
   and an execute refusal on the confirm screen — so a name left in one of them
   reaches the glass even though no JSX spells it out. The names stay in the
   comments and the code, which is where the plumbing belongs.
   scripts/test-relay-withdraw.mjs S1b walks the RENDERED text of each screen,
   including the two a withdrawal actually ends on. */
function unsafe(why) {
  return new RelayWithdrawError("unsafe-quote", `The quote did not check out (${why}); nothing is signed`, { why });
}

/* 🔴 THE WORDS THAT COME FROM SOMEWHERE ELSE. Our own strings above name nobody,
   but two kinds of message are written elsewhere and still land on the glass
   verbatim: the trading layer's refusals on the money step (a refused signature,
   a request that timed out, a withdrawal it could not confirm) and the quote
   service's own error text. Both name themselves freely, so a screen that spells
   out no provider in its JSX can still print one — which is the owner's rule
   broken by a path nobody reads (2026-09-23: "ให้ใช้คำว่า Withdraw แทนคำว่า Relay" /
   "ไม่ต้องไปอ้าง Hyperliquid").

   THE SCRUB ITSELF LIVES IN plainWords.js, because the DEPOSIT path needs the
   same one (its quote refusals are the same service's words), and a module
   reaching into this one for a string function would drag the whole withdrawal
   with it. Re-exported here, where every caller of it already looks. */
export { plainMoneyWords };

const stepById = (steps, id) => steps.find((s) => s && s.id === id) || null;
const itemData = (step) => (step && Array.isArray(step.items) && step.items[0] && step.items[0].data) || null;

/**
 * Verify a withdraw /quote/v2 answer and read everything the sheet and the
 * execution need. Throws RelayWithdrawError unless the answer provably takes
 * the user's USDC and pays THIS recipient on THIS route.
 */
export function parseWithdrawQuote(json, { user, recipient, route, amountUsdc, now = Date.now(), network = HL_NETWORK } = {}) {
  if (!isEvmAddress(user)) throw new RelayWithdrawError("bad-user", "Not a wallet address");
  if (!isEvmAddress(recipient)) throw new RelayWithdrawError("bad-recipient", "Not a destination address");
  const steps = json && Array.isArray(json.steps) ? json.steps : null;
  if (!steps || steps.length !== 2) throw unsafe("a withdrawal is two steps: authorize, then the deposit");
  const auth = stepById(steps, "authorize");
  const dep = stepById(steps, "deposit");
  if (!auth || !dep) throw unsafe("the authorize or the deposit step is missing");
  if (steps.indexOf(auth) > steps.indexOf(dep)) throw unsafe("the authorize step must come first");
  if (auth.kind !== "signature" || dep.kind !== "transaction") throw unsafe("a step is not the kind it should be");

  /* Who pays, who is paid, in what. */
  const d = json.details || {};
  if (!sameAddress(d.sender, user)) throw unsafe("the sender is not this wallet");
  if (!sameAddress(d.recipient, recipient)) throw unsafe("the recipient is not the destination that was asked for");
  const cin = (d.currencyIn && d.currencyIn.currency) || {};
  const cout = (d.currencyOut && d.currencyOut.currency) || {};
  if (Number(cin.chainId) !== HL_RELAY_CHAIN_ID || String(cin.address).toLowerCase() !== HL_PERP_USDC) throw unsafe("the origin is not the USDC in your Perp wallet");
  if (Number(cout.chainId) !== route.chainId || String(cout.address).toLowerCase() !== route.address) throw unsafe("the destination token is not the route's");

  const amountIn = num(d.currencyIn && d.currencyIn.amountFormatted);
  const asked = num(amountUsdc);
  if (amountIn == null) throw unsafe("the amount leaving cannot be read");
  if (asked != null && Math.abs(amountIn - asked) > 1e-8) throw unsafe("the amount leaving is not the amount asked for");

  /* The order: every payment and every refund. */
  const v2 = (json.protocol && json.protocol.v2) || {};
  const order = v2.orderData;
  if (!order) throw unsafe("the order is missing, so its recipients cannot be checked");
  const output = order.output || {};
  const payments = Array.isArray(output.payments) ? output.payments : [];
  if (!payments.length || !payments.every((p) => p && sameAddress(p.recipient, recipient))) throw unsafe("an order payment is not to the destination");
  if (!payments.every((p) => String(p.currency).toLowerCase() === route.address)) throw unsafe("an order payment is not the route's token");
  if (output.calls !== undefined && !(Array.isArray(output.calls) && output.calls.length === 0)) throw unsafe("the order runs calls on the destination chain");
  const inputs = Array.isArray(order.inputs) ? order.inputs : [];
  if (!inputs.length) throw unsafe("the order has no input, so what leaves cannot be checked");
  /* 🔴 A REFUND MAY NAME EITHER ADDRESS THE USER CHOSE — THE RULE THAT REFUSED EVERY WITHDRAWAL TO A
     PASTED ADDRESS (owner, 2026-09-23: "ถอนไม่ได้อะ"; IMG_3248 is this refusal on 4.674406 USDC to
     Optimism, with an address pasted into the To field).

     MEASURED 2026-09-23, two read-only quotes (Optimism USDC and Avalanche USDC, 5 USDC out of 1337
     USDC (Perps), every role the burn address): the answer has no top-level "refunds" key at all, and
     orderData.inputs[0].refunds holds TWO entries — one on the ORIGIN chain in the origin currency,
     which mirrors the input, and one on the DESTINATION chain in the destination currency, carrying
     the same deadline and extraData as output.payments, which mirrors the output. The captured
     fixture of 2026-09-22 has exactly the same pair. (An earlier note here said a live answer carried
     no refunds on the order input at all; that is NOT what either quote shows, so do not rebuild this
     rule on it.)

     UNVERIFIED, and it cannot be read off those quotes: all three roles were the same address in them,
     so which role each refund names is INFERRED from the mirroring above — the origin-chain refund
     names refundTo (this wallet), the destination-chain one names the ORDER'S RECIPIENT. That is the
     only reading under which the owner's withdrawal fails where it did: demanding that EVERY refund
     name this wallet refused the destination-chain refund as soon as the recipient was an address the
     user pasted, before anything was signed. Withdrawals to their own wallet were unaffected, which is
     why every test passed.

     WHAT IS STILL REFUSED, because it is what can actually be wrong: a refund naming a THIRD address —
     neither this wallet nor the destination shown on the confirm screen. An absent refund list is
     accepted: it declares nothing to go wrong. */
  const refunds = inputs.flatMap((i) => (i && Array.isArray(i.refunds) ? i.refunds : []));
  const refundOk = (r) => r && (sameAddress(r.recipient, user) || sameAddress(r.recipient, recipient));
  if (!refunds.every(refundOk)) throw unsafe("a refund would go to an address you did not choose");

  /* The authorize step: an EIP-712 the user signs, and the POST that follows it. */
  const a = itemData(auth) || {};
  const sign = a.sign || {};
  const post = a.post || {};
  if (sign.signatureKind !== "eip712" || !sign.domain || !sign.types || !sign.value || typeof sign.primaryType !== "string") {
    throw unsafe("the authorize step is not a readable EIP-712");
  }
  if (!sameAddress(sign.value.wallet, user) || !sameAddress(sign.value.depositor, user)) throw unsafe("the authorize signature is not for this wallet");
  if (typeof post.endpoint !== "string" || !post.endpoint.startsWith("/") || String(post.method || "").toUpperCase() !== "POST" || !post.body) {
    throw unsafe("the authorize step does not say where to post it");
  }
  if (!sameAddress(post.body.wallet, user) || !sameAddress(post.body.depositor, user)) throw unsafe("the authorize body is not for this wallet");
  if (Number(post.body.walletChainId) !== HL_RELAY_CHAIN_ID) throw unsafe("the authorize body is for the wrong network");
  const nonce = sign.value.nonce;
  if (!Number.isFinite(Number(nonce)) || Number(post.body.nonce) !== Number(nonce)) throw unsafe("the authorize nonce does not match");
  if (typeof sign.value.id !== "string" || post.body.id !== sign.value.id) throw unsafe("the authorize order id does not match");

  /* The deposit step: Hyperliquid's own sendAsset, to RELAY'S OWN depository as
     THIS quote gives it (never a hard-coded address). */
  const dd = itemData(dep) || {};
  const action = dd.action || {};
  const params = action.parameters || {};
  if (action.type !== "sendAsset") throw unsafe("the deposit step is not a sendAsset");
  const pay = v2.paymentDetails || {};
  if (!isEvmAddress(pay.depository)) throw unsafe("the order names no depository");
  if (!sameAddress(params.destination, pay.depository)) throw unsafe("the sendAsset does not pay the order's depository");
  if (sameAddress(params.destination, user) || sameAddress(params.destination, recipient)) throw unsafe("the sendAsset destination is a wallet, not a depository");
  if (String(pay.currency).toLowerCase() !== HL_PERP_USDC) throw unsafe("the depository is not paid in USDC (Perps)");
  if (typeof params.token !== "string" || !params.token.startsWith("USDC:")) throw unsafe("the sendAsset does not move USDC");
  const sendAmount = num(params.amount);
  if (sendAmount == null || Math.abs(sendAmount - amountIn) > 1e-8) throw unsafe("the sendAsset amount is not the amount leaving");
  if (Number(params.nonce) !== Number(nonce)) throw unsafe("the sendAsset nonce is not the authorized one");
  const wantChain = network === "mainnet" ? "Mainnet" : "Testnet";
  if (params.hyperliquidChain !== wantChain) throw unsafe(`the sendAsset is not on ${wantChain}`);

  /* 🔴 THE SIGNER'S OWN CONTRACT, CHECKED HERE — WHERE NOTHING HAS BEEN SIGNED YET.
     Everything below is a rule the signing layer already enforces on this same step
     (exchange/relayOut.js readRelayDepositStep). The trouble was WHEN it enforced
     them: that code runs at step 3 of executeRelayWithdraw, so a quote it refuses has
     already cost the user the authorize signature in their wallet AND the POST that
     registers it. The user sees a wallet prompt, approves it, and only then is told
     the quote was never usable. Refused here, it is a line in the quote box with
     nothing signed and nothing registered — the same reason the refund rule above is
     read at quote time.

     This is a strict SUBSET of what the signer refuses, so it can never stop a
     withdrawal that would otherwise have gone through; it only moves the refusal
     earlier. Two rules it deliberately leaves to the signer: USDC's published token
     id (duplicating that constant here would give a money-identifying id two homes
     to drift between - the prefix is checked instead) and Hyperliquid's nonce window,
     which this file's own 60-second quote TTL already sits well inside. */
  if (params.fromSubAccount !== "") throw unsafe("the sendAsset comes from a sub-account");
  if (params.sourceDex !== "") throw unsafe("the money would leave an account other than your Perp one");
  if (params.destinationDex !== "" && params.destinationDex !== "spot") throw unsafe("the sendAsset pays an account it should not");
  if (dd.eip712PrimaryType !== SEND_ASSET_TYPE) throw unsafe("the sendAsset is not the message it should be");
  if (!dd.eip712Types || typeof dd.eip712Types !== "object") throw unsafe("the sendAsset has no EIP-712 types");
  const fields = dd.eip712Types[SEND_ASSET_TYPE];
  if (!Array.isArray(fields) || fields.length !== SEND_ASSET_FIELDS.length
      || !fields.every((f, i) => f && f.name === SEND_ASSET_FIELDS[i][0] && f.type === SEND_ASSET_FIELDS[i][1])) {
    throw unsafe("the sendAsset's field list is not the one it should be");
  }

  const check = (Array.isArray(dep.items) && dep.items[0] && dep.items[0].check) || null;
  const requestId = typeof json.requestId === "string" ? json.requestId : null;
  const fee = num(json.fees && json.fees.relayer && json.fees.relayer.amountFormatted);
  const time = num(d.timeEstimate);
  const receive = num(d.currencyOut && d.currencyOut.amountFormatted);
  const minimum = num(d.currencyOut && d.currencyOut.minimumAmount);

  return Object.freeze({
    requestId,
    route,
    user: user.toLowerCase(),
    recipient,
    amountUsdc: amountIn,
    receiveAmount: receive,
    minimumUnits: minimum,
    feeUsdc: fee,
    timeEstimateSec: time != null && time >= 0 ? time : null,
    depository: String(pay.depository).toLowerCase(),
    authorize: Object.freeze({
      domain: sign.domain,
      types: sign.types,
      primaryType: sign.primaryType,
      message: sign.value,
      endpoint: post.endpoint,
      method: "POST",
      body: post.body,
    }),
    sendAsset: Object.freeze({ ...params }),
    /* The steps as Relay sent them: the exchange layer takes these, not our
       reading of them, and checks them again before it signs anything. */
    steps: Object.freeze({ authorize: auth, deposit: dep }),
    statusEndpoint: check && typeof check.endpoint === "string" ? check.endpoint : requestId ? `/intents/status/v3?requestId=${requestId}` : null,
    quotedAt: now,
  });
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

/**
 * Hyperliquid's one-time ACTIVATION (1 USDC) a Relay quote prices in: what is sent − what arrives − Relay's fee, to the
 * cent. It is charged on an account's FIRST outbound transfer and has to stay in the balance. 0 when the quote has none.
 */
export function quoteActivationUsdc(quote) {
  if (!quote || !Number.isFinite(quote.amountUsdc) || !Number.isFinite(quote.receiveAmount)) return 0;
  const a = Math.round((quote.amountUsdc - quote.receiveAmount - (Number.isFinite(quote.feeUsdc) ? quote.feeUsdc : 0)) * 100) / 100;
  return a >= 0.5 ? a : 0;
}

/**
 * The most that can go with the activation left behind: withdrawable − activation − 0.01, floored to cents. Null when
 * nothing is to be held back or the balance is unknown.
 */
export function withdrawMaxUsdc(withdrawableUsdc, activationUsdc = 0) {
  if (!Number.isFinite(withdrawableUsdc) || withdrawableUsdc <= 0) return null;
  const hold = activationUsdc > 0 ? activationUsdc + 0.01 : 0;
  return Math.max(0, Math.floor((withdrawableUsdc - hold) * 100 + 1e-6) / 100);
}

/**
 * The amount the panel lowers itself to once a live quote shows the activation: withdrawableMax when the typed amount
 * would not leave it behind. Only ever LOWER (null when it already fits, nothing applies, or the lower amount is under
 * the minimum: then nothing can go and Confirm stays held with its line).
 */
export function activationAdjustedUsdc({ amountUsdc, withdrawableUsdc, activationUsdc, minUsdc = RELAY_MIN_WITHDRAW_USDC } = {}) {
  if (!(activationUsdc > 0) || !Number.isFinite(amountUsdc) || !Number.isFinite(withdrawableUsdc)) return null;
  if (withdrawableUsdc - amountUsdc >= activationUsdc + 0.005) return null;
  const max = withdrawMaxUsdc(withdrawableUsdc, activationUsdc);
  return max != null && max >= minUsdc && max < amountUsdc ? max : null;
}

/** The one quiet line under an amount the panel lowered. */
export const activationAdjustedText = (usdc, activationUsdc) =>
  `Adjusted to ${usdc.toFixed(2)}: Hyperliquid keeps ${activationUsdc.toFixed(2).replace(/\.00$/, "")} USDC once on your first withdrawal.`;

/** Is this quote still fresh enough to sign? */
export function withdrawQuoteFresh(quote, now = Date.now(), ttlMs = RELAY_WITHDRAW_QUOTE_TTL_MS) {
  return !!quote && Number.isFinite(quote.quotedAt) && now - quote.quotedAt < ttlMs;
}

/**
 * Ask Relay what this withdrawal pays, and verify the answer.
 * Reads only: one POST /quote/v2, nothing signed, nothing sent.
 */
export async function quoteRelayWithdraw({
  user,
  recipient,
  route,
  amountUsdc,
  fetchImpl = globalThis.fetch,
  now = browserNow,
  timers = browserTimers,
  network = HL_NETWORK,
  signal = null,
} = {}) {
  if (!isEvmAddress(user)) throw new RelayWithdrawError("bad-user", "Not a wallet address");
  if (!isEvmAddress(recipient)) throw new RelayWithdrawError("bad-recipient", "Not a destination address");
  if (!route || withdrawRouteById(route.id) !== route) throw new RelayWithdrawError("bad-route", "Not a supported destination");
  if (network !== "mainnet") throw new RelayWithdrawError("testnet-off", "Withdrawals work on mainnet only");
  const asked = num(amountUsdc);
  if (asked == null || asked < RELAY_MIN_WITHDRAW_USDC) {
    throw new RelayWithdrawError("too-small", `This route needs at least ${RELAY_MIN_WITHDRAW_USDC} USDC.`);
  }
  const body = buildWithdrawQuoteBody({ user, recipient, route, amountUsdc });
  if (!sameAddress(body.refundTo, user)) throw new RelayWithdrawError("bad-user", "a refund must come back to this wallet");

  let res;
  const ctrl = !signal && typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), WITHDRAW_QUOTE_TIMEOUT_MS) : null;
  try {
    res = await fetchImpl(RELAY_QUOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal || (ctrl ? ctrl.signal : undefined),
    });
  } catch (e) {
    throw new RelayWithdrawError("network", "Couldn't reach the withdrawal service for a quote", { cause: String((e && e.message) || e) });
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
  const json = await readJson(res);
  if (!res.ok) {
    /* The quote box prints this refusal as it stands, and the words are the
       service's own, so the name goes and the reason stays. */
    const msg = json && typeof json.message === "string" ? json.message : `the service answered ${res.status}`;
    throw new RelayWithdrawError("relay-error", plainMoneyWords(msg), { status: res.status, errorCode: (json && json.errorCode) || null });
  }
  return parseWithdrawQuote(json, { user, recipient, route, amountUsdc: asked, now: now(), network });
}

/**
 * Do the withdrawal: sign the authorize step, POST it exactly as the step says,
 * then send the sendAsset. Nothing here signs by itself — `signAuthorize` and
 * `sendDeposit` are the exchange layer's own calls (the backend seam's
 * signRelayAuthorize and sendRelayDeposit), and both prompt the wallet.
 *
 * @param {{ quote: object, amountUsdc: string|number,
 *   signAuthorize: (step: object) => Promise<{ ok: boolean, signature?: string, post?: object, code?: string, message?: string }>,
 *   sendDeposit: (o: { step: object, amountUsdc: string|number }) => Promise<{ ok: boolean, code?: string, message?: string, lost?: boolean }>,
 *   signWords?: { authorize?: object, deposit?: object }|null,
 *   onPhase?: (phase: string) => void }} o
 *   signWords: what each of the two windows should SAY, from the caller's own
 *   screen (lib/signCopy builds them). Words only — nothing here decides
 *   whether a window appears, and both signatures prompt the wallet with or
 *   without them.
 * @returns {Promise<{ ok: true, requestId, sentAt } | { ok: false, code, message, notConfirmed?: boolean, requestId? }>}
 *   Never throws: a surprise is { ok: false, code: "unexpected" }. notConfirmed
 *   means the sendAsset's reply was lost and the USDC may be on its way: the
 *   caller must NOT offer to send it again.
 */
export async function executeRelayWithdraw({
  quote,
  amountUsdc = null,
  signAuthorize,
  sendDeposit,
  signWords = null,
  fetchImpl = globalThis.fetch,
  now = browserNow,
  timers = browserTimers,
  onPhase = () => {},
} = {}) {
  /* Every message this function returns is rendered by the sheet, and some of them
     are the trading layer's own words, so they all go through the scrub above. */
  const fail = (code, message, extra = {}) => ({ ok: false, code, message: plainMoneyWords(message), ...extra });
  if (!quote || !quote.steps || !quote.steps.authorize || !quote.steps.deposit) return fail("bad-quote", "No quote to send.");
  if (typeof signAuthorize !== "function" || typeof sendDeposit !== "function") {
    /* There is ONE way out now, so this cannot point at another one. It says
       what is true — this build's wallet seam carries no signer — and nothing
       is signed or sent. */
    return fail("unsupported", "This wallet can't sign a withdrawal here yet, so nothing was sent.");
  }
  if (!withdrawQuoteFresh(quote, now())) return fail("stale-quote", "That quote is out of date. Getting a fresh one.");
  const amount = amountUsdc == null ? quote.amountUsdc : amountUsdc;

  /* 1. the authorize signature (the wallet prompts; nothing has moved yet) */
  let a;
  try {
    onPhase("authorize");
    /* The words for THIS window, armed as the last thing before the wallet is
       asked and consumed by that one request (services/signWords). The caller
       wrote them from the figures its own screen is showing, so the window and
       the screen behind it cannot disagree. Nothing about the signature
       changes: a build or a wallet with nowhere to put them signs exactly what
       it signed before, with Privy's own words on it. */
    armWords(signWords && signWords.authorize);
    a = await signAuthorize(quote.steps.authorize);
  } catch (e) {
    return fail("signing_failed", `Couldn't sign the authorization: ${String((e && e.message) || e)}`);
  } finally {
    disarmSignWords();
  }
  if (!a || a.ok !== true || typeof a.signature !== "string" || !a.signature) {
    return fail((a && a.code) || "signing_failed", (a && a.message) || "The wallet gave no signature, so nothing was sent.");
  }
  const post = a.post && typeof a.post === "object" ? a.post : quote.authorize;

  /* 2. POST it exactly as the step says (the signature rides as the query
        parameter Relay's own SDK sends). Still nothing moved — and this POST
        is guarded, so a Relay endpoint that never answers becomes the network
        refusal below rather than a sheet stuck mid-send forever. A timeout
        HERE is genuinely "nothing was sent": the sendAsset is step 3. */
  try {
    onPhase("authorizing");
    const endpoint = String(post.endpoint || quote.authorize.endpoint);
    const url = `${RELAY_API}${endpoint}${endpoint.includes("?") ? "&" : "?"}signature=${encodeURIComponent(a.signature)}`;
    const res = await fetchGuarded(fetchImpl, url, {
      method: String(post.method || "POST"),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(post.body),
    }, { timers, timeoutMs: WITHDRAW_POST_TIMEOUT_MS });
    if (!res.ok) {
      const json = await readJson(res);
      const msg = json && typeof json.message === "string" ? json.message : `the service answered ${res.status}`;
      return fail("authorize_failed", `The authorization wasn't accepted, so nothing was sent: ${msg}`);
    }
  } catch (e) {
    return fail("network", `Couldn't reach the withdrawal service to authorize, so nothing was sent: ${String((e && e.message) || e)}`);
  }

  /* 3. the sendAsset (the wallet prompts again; this is the step that moves it) */
  let r;
  try {
    onPhase("sending");
    armWords(signWords && signWords.deposit);
    r = await sendDeposit({ step: quote.steps.deposit, amountUsdc: amount });
  } catch (e) {
    return fail("unexpected", `Something went wrong and nothing was confirmed: ${String((e && e.message) || e)}`, { notConfirmed: true, requestId: quote.requestId });
  } finally {
    disarmSignWords();
  }
  if (!r || typeof r !== "object") return fail("unexpected", "The trading layer gave no answer. Check your Perp balance before trying again.", { notConfirmed: true, requestId: quote.requestId });
  if (r.ok !== true) {
    /* A lost reply is not a refusal: the USDC may already be on its way.
       🔴 "unexpected" IS ON THIS LIST because that is what the backend seam
       answers when the money step THREW (perp/live/perpBackend.js run's catch:
       "Something went wrong and nothing was confirmed"), and this file means the
       same thing by it two lines up. Off the list, a throw between the signature
       and the reply left the sheet on its error screen with Confirm live again —
       and a second tap past the 60 s TTL re-quotes, which is a fresh nonce and a
       genuinely SECOND withdrawal, not one Hyperliquid would reject. */
    const lost = r.lost === true || r.code === "not_confirmed" || r.code === "unknown_outcome" || r.code === "unexpected";
    return fail(r.code || "send_failed", r.message || "The transfer was refused.", lost ? { notConfirmed: true, requestId: quote.requestId } : {});
  }
  onPhase("sent");
  return { ok: true, requestId: quote.requestId, sentAt: now(), amountUsdc: quote.amountUsdc, receiveAmount: quote.receiveAmount, route: quote.route, recipient: quote.recipient };
}

/* ── where it got to: GET /intents/status/v3 ──────────────────────────────── */

/** Relay's intent statuses, folded into what the sheet says. Unmapped is "unknown", never "arrived". */
export const INTENT_STATUS = Object.freeze({
  waiting: "sending",
  /* Relay's state while the money is being deposited on the way in. The moves
     between the user's own accounts and the Avalanche swaps read their status
     through this same table, and a move mid-deposit is on its way, not unknown. */
  depositing: "sending",
  pending: "sending",
  submitted: "sending",
  delayed: "sending",
  success: "arrived",
  refund: "refunded",
  failure: "failed",
});

/**
 * Read one intent's status (read-only GET). Never throws: an unreadable answer
 * is { status: "unknown" }, which is not "arrived".
 */
export async function readWithdrawStatus({ requestId, endpoint = null, fetchImpl = globalThis.fetch, signal = null, timers = browserTimers } = {}) {
  const path = endpoint || (requestId ? `/intents/status/v3?requestId=${encodeURIComponent(requestId)}` : null);
  if (!path) return { status: "unknown", relayStatus: null, txHashes: [], error: "no request id" };
  let json = null;
  try {
    const res = await fetchGuarded(fetchImpl, `${RELAY_API}${path}`, { method: "GET" }, { signal, timers, timeoutMs: WITHDRAW_STATUS_TIMEOUT_MS });
    json = await readJson(res);
    if (!res.ok) return { status: "unknown", relayStatus: null, txHashes: [], error: `the service answered ${res.status}` };
  } catch (e) {
    return { status: "unknown", relayStatus: null, txHashes: [], error: String((e && e.message) || e) };
  }
  const relayStatus = json && typeof json.status === "string" ? json.status : null;
  const txHashes = json && Array.isArray(json.txHashes) ? json.txHashes.filter((h) => typeof h === "string") : [];
  return {
    status: (relayStatus && INTENT_STATUS[relayStatus]) || "unknown",
    relayStatus,
    txHashes,
    inTxHashes: json && Array.isArray(json.inTxHashes) ? json.inTxHashes.filter((h) => typeof h === "string") : [],
    details: json && typeof json.details === "string" ? json.details : null,
    error: null,
  };
}
