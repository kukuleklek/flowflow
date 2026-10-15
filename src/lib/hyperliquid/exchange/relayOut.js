// ─────────────────────────────────────────────────────────────────────────────
// THE GATE ON A RELAY WITHDRAWAL: what a quote step is allowed to make us sign.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-22: "ขาออกแพงชิบหาย" / "มันถูกสัสๆเลย Relay อะ Hypercore > ออกมา"
// / "แล้วมันควรต้องออกได้หลายเชนด้วยนะ". Hyperliquid's own bridge pays $1, lands on
// Arbitrum only, and takes minutes. Relay quoted 5 USDC out to Arbitrum for
// $0.0045 in about a second, and to Base, Polygon, Optimism and Ethereum too.
//
// Relay's withdrawal is TWO steps the user signs, both of them from the live
// quote:
//
//   authorize  an EIP-712 message of Relay's own (RelayNonceMapping) that ties
//              the deposit about to be made to this order. Signed, then posted
//              to the endpoint the step names.
//   deposit    a Hyperliquid "sendAsset" action moving the USDC from the Perp
//              account to RELAY'S DEPOSITORY on HyperCore, with Relay's nonce.
//              Signed, then posted to Hyperliquid's /exchange like any other
//              user-signed action.
//
// NOTHING ABOUT EITHER STEP IS HARD-CODED HERE, because none of it is ours: the
// depository address, the nonce, the amount string and the dex names are
// Relay's, and Relay's published example is already out of date. What this file
// does instead is REFUSE a step that is not the one the user asked for:
//
//   * the action must be sendAsset, with Hyperliquid's own field list and
//     primary type, on the network the app is trading on;
//   * the asset must be USDC — the only thing a Perp account holds — and, on
//     mainnet, USDC's own token id as Hyperliquid publishes it;
//   * the amount must equal the amount the user typed, to the last of USDC's
//     six decimals. Not "close to", not "at most";
//   * the source dex must be the Perp account's own (the empty name), and the
//     transfer must not come from a sub-account;
//   * the destination must be an address, and must NOT be the user's own
//     wallet (that is not a withdrawal, and Relay would never quote it);
//   * the nonce must be the step's own and inside Hyperliquid's window, so a
//     quote left open for an hour is refused rather than silently rejected;
//   * the authorize message must name THIS wallet, and nothing else.
//
// A refusal is { ok: false, code, message } in plain words. Every check here
// runs before any wallet is asked for anything.

import { formatUsdcAmount } from "./master.js";

/** The two steps, by the id Relay gives them. */
export const RELAY_STEP = Object.freeze({ authorize: "authorize", deposit: "deposit" });

/** Hyperliquid's own primary type for the deposit step. */
export const RELAY_SEND_ASSET_TYPE = "HyperliquidTransaction:SendAsset";

/** The field list the deposit step must carry, in order (Hyperliquid's own). */
export const RELAY_SEND_ASSET_FIELDS = Object.freeze([
  ["hyperliquidChain", "string"], ["destination", "string"], ["sourceDex", "string"], ["destinationDex", "string"],
  ["token", "string"], ["amount", "string"], ["fromSubAccount", "string"], ["nonce", "uint64"],
]);

/**
 * USDC's spot token as Hyperliquid publishes it (info spotMeta, read
 * 2026-09-23). The Perp account holds nothing else. Null for a network whose
 * id has not been read, where the name half is checked and the id is not.
 */
export const HL_USDC_TOKEN = Object.freeze({
  mainnet: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
  testnet: null,
});

/** Hyperliquid refuses a nonce older than 2 days or more than a day ahead. */
export const HL_NONCE_PAST_MS = 2 * 86_400_000;
export const HL_NONCE_FUTURE_MS = 86_400_000;

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a) => String(a).toLowerCase();
const fail = (code, message) => ({ ok: false, code, message });

const BAD_QUOTE = "This withdrawal quote isn't the one you asked for, so nothing was signed. Get a new quote and try again.";
const STALE_QUOTE = "This quote is too old for Hyperliquid to accept. Get a new one and try again.";

/* The one item of a step: Relay sends a list, and a withdrawal has exactly one.
   The signed part is under `data`; the status endpoint is the item's own. */
function itemOf(step, id, kind) {
  if (!step || typeof step !== "object" || step.id !== id || step.kind !== kind) return null;
  const items = Array.isArray(step.items) ? step.items : null;
  if (!items || items.length !== 1) return null;
  const item = items[0] && typeof items[0] === "object" ? items[0] : null;
  return item && item.data && typeof item.data === "object" ? item : null;
}

/**
 * The AUTHORIZE step, ready to sign: { ok, typedData, post } or a refusal. The
 * typed data is EXACTLY what Relay sent (domain, types, primaryType, message);
 * the only thing checked in it is that every wallet it names is this one.
 * @param {object} step the quote's authorize step
 * @param {{ master: string }} o
 */
export function readRelayAuthorizeStep(step, { master } = {}) {
  const item = itemOf(step, RELAY_STEP.authorize, "signature");
  if (!item) return fail("bad_quote", BAD_QUOTE);
  const data = item.data;
  const sign = data.sign && typeof data.sign === "object" ? data.sign : null;
  if (!sign || sign.signatureKind !== "eip712") return fail("bad_quote", BAD_QUOTE);
  const { domain, types, value, primaryType } = sign;
  if (!domain || typeof domain !== "object" || !types || typeof types !== "object") return fail("bad_quote", BAD_QUOTE);
  if (typeof primaryType !== "string" || !Array.isArray(types[primaryType])) return fail("bad_quote", BAD_QUOTE);
  if (!value || typeof value !== "object") return fail("bad_quote", BAD_QUOTE);
  if (!isAddress(master)) return fail("no_wallet", "Connect a wallet first.");
  /* Every address the message names must be this wallet: a message that maps
     someone else's deposit is not ours to sign. */
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (isAddress(v) && lower(v) !== lower(master)) {
      return fail("wallet_mismatch", "This quote was made for a different wallet. Get a new quote and try again.");
    }
  }
  const post = data.post && typeof data.post === "object" ? data.post : null;
  if (!post || typeof post.endpoint !== "string" || !post.endpoint.startsWith("/") || !post.body || typeof post.body !== "object") {
    return fail("bad_quote", BAD_QUOTE);
  }
  return {
    ok: true,
    typedData: { domain, types, primaryType, message: value },
    post: { endpoint: post.endpoint, method: typeof post.method === "string" ? post.method : "POST", body: post.body },
  };
}

const NO_LIMIT = "This move has no confirmed limit, so nothing was signed.";
const OVER_LIMIT = "This move takes more than you confirmed, so nothing was signed. Check the new price.";
const NOT_DEPOSITORY = "This move is not to the known depository, so nothing was signed.";

/**
 * The DEPOSIT step, ready to sign: { ok, fields, nonce, check } or a refusal.
 * `fields` is what buildSendAssetAction takes; nothing else may build one.
 * @param {object} step the quote's deposit step
 * @param {{ profile: object, amountUsdc: string|number, master: string, now?: number,
 *   ownMove?: { depository: string, maxDebitUsdc: number }|null }} o
 *   amountUsdc: the amount the USER typed, not the quote's
 *   ownMove: a move to the user's OWN Avax Wallet (src/avax/signers.js), with
 *   its two pins: `depository`, Relay's HyperCore depository as the Avax track
 *   pins it (lib/avax/config.js RELAY_HL_DEPOSITORY), and `maxDebitUsdc`, the
 *   most the move may take. The destination must then BE that depository and
 *   the amount at most that limit; a pin that is missing or unreadable refuses.
 *   Absent (a Withdraw): the rules above, exactly as before — and this file
 *   still names no depository of its own, because a Withdraw's is Relay's to
 *   choose (test-perp-sendasset G1).
 */
export function readRelayDepositStep(step, { profile, amountUsdc, master, now = Date.now(), ownMove = null } = {}) {
  const item = itemOf(step, RELAY_STEP.deposit, "transaction");
  if (!item) return fail("bad_quote", BAD_QUOTE);
  const data = item.data;
  if (!profile || typeof profile.hyperliquidChain !== "string") return fail("bad_quote", BAD_QUOTE);
  if (!isAddress(master)) return fail("no_wallet", "Connect a wallet first.");

  const action = data.action && typeof data.action === "object" ? data.action : null;
  const p = action && action.parameters && typeof action.parameters === "object" ? action.parameters : null;
  if (!action || action.type !== "sendAsset" || !p) return fail("bad_quote", BAD_QUOTE);

  /* The step's own type list must be Hyperliquid's, field for field: it is what
     says the message we sign means what we think it means. */
  if (data.eip712PrimaryType !== RELAY_SEND_ASSET_TYPE) return fail("bad_quote", BAD_QUOTE);
  const list = data.eip712Types && typeof data.eip712Types === "object" ? data.eip712Types[RELAY_SEND_ASSET_TYPE] : null;
  if (!Array.isArray(list) || list.length !== RELAY_SEND_ASSET_FIELDS.length) return fail("bad_quote", BAD_QUOTE);
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || f.name !== RELAY_SEND_ASSET_FIELDS[i][0] || f.type !== RELAY_SEND_ASSET_FIELDS[i][1]) return fail("bad_quote", BAD_QUOTE);
  }

  if (p.hyperliquidChain !== profile.hyperliquidChain) {
    return fail("wrong_network", "This quote is for the other Hyperliquid network. Get a new quote and try again.");
  }

  /* USDC, and on mainnet USDC's own token id. */
  const token = typeof p.token === "string" ? p.token : "";
  const known = HL_USDC_TOKEN[profile.network] || null;
  const usdc = known ? token === known : /^USDC:0x[0-9a-f]{32}$/i.test(token);
  if (!usdc) return fail("not_usdc", "This quote moves something other than your Perp USDC, so nothing was signed.");

  /* The amount the user typed, exactly. */
  const want = formatUsdcAmount(amountUsdc);
  const got = formatUsdcAmount(p.amount);
  if (!want || !got || want !== got) {
    return fail("amount_mismatch", "This quote is for a different amount than the one you entered, so nothing was signed.");
  }

  if (typeof p.sourceDex !== "string" || p.sourceDex !== "") {
    return fail("bad_quote", "This quote takes the money from somewhere other than your Perp account, so nothing was signed.");
  }
  if (typeof p.destinationDex !== "string" || (p.destinationDex !== "" && p.destinationDex !== "spot")) return fail("bad_quote", BAD_QUOTE);
  if (p.fromSubAccount !== "") return fail("bad_quote", BAD_QUOTE);

  if (!isAddress(p.destination)) return fail("bad_quote", BAD_QUOTE);
  if (lower(p.destination) === lower(master)) {
    return fail("bad_quote", "This quote would send the money back to your own Perp account, so nothing was signed.");
  }

  /* 🔴 AN OWN MOVE: the pinned depository, and never more than was confirmed.
     The quote's parser (lib/relay/ownMove.js) already refused any other
     depository and any debit over the card's maxDebit; this is the same pair of
     rules at the last step before the wallet is asked, where nothing the quote
     says can widen them. Both pins come from the caller, never from the quote. */
  if (ownMove != null) {
    const o = typeof ownMove === "object" ? ownMove : {};
    const cap = typeof o.maxDebitUsdc === "number" && Number.isFinite(o.maxDebitUsdc) && o.maxDebitUsdc > 0 ? o.maxDebitUsdc : null;
    if (cap == null) return fail("no_limit", NO_LIMIT);
    if (!isAddress(o.depository) || /^0x0{40}$/i.test(o.depository)) return fail("bad_quote", NOT_DEPOSITORY);
    if (lower(p.destination) !== lower(o.depository)) return fail("bad_quote", NOT_DEPOSITORY);
    if (!(Number(got) <= cap + 1e-9)) return fail("over_limit", OVER_LIMIT);
  }

  const nonce = p.nonce;
  if (!Number.isSafeInteger(nonce) || nonce <= 0 || (data.nonce != null && data.nonce !== nonce)) return fail("bad_quote", BAD_QUOTE);
  if (nonce < now - HL_NONCE_PAST_MS || nonce > now + HL_NONCE_FUTURE_MS) return fail("quote_expired", STALE_QUOTE);

  /* Where the caller may watch this withdrawal land. Relay puts it on the item
     itself, beside the data it wants signed. */
  const c = item.check && typeof item.check === "object" ? item.check : null;
  const check = c && typeof c.endpoint === "string" && c.endpoint.startsWith("/")
    ? { endpoint: c.endpoint, method: typeof c.method === "string" ? c.method : "GET" }
    : null;

  return {
    ok: true,
    fields: {
      destination: p.destination,
      sourceDex: p.sourceDex,
      destinationDex: p.destinationDex,
      token,
      amount: got,
      fromSubAccount: "",
      nonce,
    },
    nonce,
    check,
  };
}
