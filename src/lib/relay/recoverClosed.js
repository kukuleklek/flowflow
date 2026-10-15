// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSED BUILDER OF RECOVER'S WINDOW: the typed data the customer's own
// wallet may sign to move USDC from Base or Polygon into their balance, REBUILT
// from the Recover review it belongs to, and refused before Privy is asked when
// it is anything else.
// PURE: no env, no network, no React; the clock is a parameter.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "เอา ARB, Avax, Base, Polygon พอแระ". A private deposit's
// refund lands in the customer's own wallet on its origin chain; on Base and
// Polygon there is no gas there, and lib/relay/recoverStranded.js is the way
// back: one EIP-3009 ReceiveWithAuthorization on that chain's USDC (and, from
// Relay v3.2 on 2026-10-26, a MulticallAuthorization before it). PrivyBridge
// signs it on its SHOWN hook — a visible window, never the silent pair — and
// what that window is asked to sign is not the caller's request. It is what
// recoverTypedDataFromRequest BUILDS from the request and from the review it
// names, the discipline of src/avax/closedTx.js applied per chain.
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. FROM OWN, TO RELAY'S PINNED RECEIVER, FOR THE REVIEWED AMOUNT. The USDC
//      authorization is from the signing wallet, to Relay's approval proxy (v3
//      alone; v3.2 only behind its call authorization, never alone — ATK-05),
//      for exactly review.amountRaw, with the review's own nonce and deadline.
//   2. THAT CHAIN'S NATIVE USDC. The domain is "USD Coin" version "2" on 8453 or
//      137, verifying contract that chain's native USDC (never USDC.e, never
//      USDbC, never the other chain's). The pins are WRITTEN OUT below, not
//      imported: a change to recoverStranded's table does not widen what this
//      signs (scripts/test-private-recover.mjs R11 holds the two together).
//   3. A SANE WINDOW. validBefore at most 600 s (+120 s clock skew) ahead, at
//      least 30 s left; validAfter no later than the skew.
//   4. NOTHING ELSE. Another primary type (a TransferWithAuthorization anyone
//      could submit, a Permit), another field, another key, another domain key:
//      null. The request must ALSO be, field for field, one of the signatures
//      parseRecoverQuote produced for THIS review.
//   5. THE WORDS ARE THE DECODED ONES (lib/signCopy.js recoverMoveInSignWords),
//      from the amount read out of what is about to be signed.
//   6. ONE READ. The request and the review are first copied, once, as plain
//      data (own data properties only: an accessor, a symbol key, a class
//      instance, a function or a cycle refuses). Every check, the comparison and
//      the built request then read that copy alone, so a getter cannot answer
//      the check with one payee or amount and the signature with another.

import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import { recoverMoveInSignWords } from "../signCopy.js";
import { readSignWords } from "../../services/signWords.js";

/* ── the pins (live GET /chains, eth_getCode and USDC name/version/DOMAIN_SEPARATOR, 2026-10-15) ── */

/** The chains Recover signs on, each with its NATIVE USDC (the only token a Recover window may name). */
export const RECOVER_SIGN_CHAINS = Object.freeze({
  8453: Object.freeze({ chainId: 8453, chainName: "Base", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }),
  137: Object.freeze({ chainId: 137, chainName: "Polygon", usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" }),
});
/** Relay's contracts on both chains (the same CREATE2 addresses). */
export const RECOVER_SIGN_RELAY = Object.freeze({
  v3ApprovalProxy: "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be",
  v32ApprovalProxy: "0x5567954cd026cebfe486062cb75848e0f1c12e58",
  depository: "0x4cd00e387622c35bddb9b4c962c136462338bc31",
});
const USDC_DOMAIN = Object.freeze({ name: "USD Coin", version: "2" });
const MCA_DOMAIN = Object.freeze({ name: "RelayApprovalProxy", version: "3.1" });

/** The grant's window against the signer's clock (recoverStranded's PERMIT_MAX_VALID_S / PERMIT_CLOCK_SKEW_S, and executeRecover's 30 s). */
export const RECOVER_SIGN_WINDOW = Object.freeze({ maxValidS: 600, clockSkewS: 120, minLeftS: 30 });

const NATIVE = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const DIGITS = /^[0-9]+$/;
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const isAddr = (a) => typeof a === "string" && ADDRESS_RE.test(a) && lower(a) !== NATIVE;
const isPlain = (o) => !!o && typeof o === "object" && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* The two calls a call authorization may pin, and nothing else decodes. */
const MCA_CALL_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);

/** The customer's words when the builder refuses (recoverStranded RECOVER_WORDS.refused says the same). */
export const RECOVER_REFUSED_WORDS = "Stopped for safety before your wallet opened. Nothing moved. Try again.";

/**
 * Thrown by the Privy bridge BEFORE Privy is asked, when a request is not the
 * one this file builds for that review. Nothing was signed or sent.
 *
 * Its message says the wallet never opened and nothing moved: this is the
 * opposite of an unknown outcome, and executeRecover reads its code ("refused")
 * as a cancel before any money.
 */
export class RecoverSignRefused extends Error {
  constructor(why = "not-built", detail = null) {
    super(RECOVER_REFUSED_WORDS);
    this.name = "RecoverSignRefused";
    this.code = "refused";
    this.why = why;
    this.detail = detail;
  }
}

/* A uint as typed data carries one: bigint, safe integer, 0x-hex or decimal digits. Null otherwise. */
function qty(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^[0-9]{1,78}$/.test(v)) return BigInt(v);
  return null;
}
const uintIs = (v, want) => { const n = qty(v); return n != null && n === want; };
const rawOf = (v) => (typeof v === "string" && DIGITS.test(v) ? BigInt(v) : null);
const fmt6 = (raw) => {
  const frac = (raw % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${raw / 1000000n}.${frac}` : `${raw / 1000000n}`;
};

const EIP712_DOMAIN_FIELDS = Object.freeze([["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"]]);
const RWA_FIELDS = Object.freeze([["from", "address"], ["to", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"], ["nonce", "bytes32"]]);
const MCA_FIELDS = Object.freeze([
  ["from", "address"], ["relayer", "address"], ["msgValue", "uint256"], ["refundTo", "address"], ["nftRecipient", "address"],
  ["metadata", "bytes"], ["fundingIndex", "uint256"], ["calls", "Call3Value[]"], ["funding", "FundingAuthorization[]"],
]);
const CALL3_FIELDS = Object.freeze([["target", "address"], ["allowFailure", "bool"], ["value", "uint256"], ["callData", "bytes"]]);
const FUNDING_FIELDS = Object.freeze([["token", "address"], ["from", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"]]);
/* What a request may carry at its top level (executeRecover hands over exactly these four). */
const TYPED_DATA_KEYS = Object.freeze(["domain", "types", "primaryType", "message"]);

const fieldList = (pairs) => pairs.map(([name, type]) => ({ name, type }));
const fieldsAre = (list, want) => Array.isArray(list) && list.length === want.length
  && list.every((f, i) => isPlain(f) && Object.keys(f).length === 2 && f.name === want[i][0] && f.type === want[i][1]);
const sameKeys = (o, pairs) => isPlain(o) && Object.keys(o).length === pairs.length && pairs.every(([k]) => has(o, k));
const pick = (o, pairs) => Object.fromEntries(pairs.map(([k]) => [k, o[k]]));

/* The types a request carries: exactly `want` (by name), plus an EIP712Domain only when it is the standard one. */
function typesAre(types, want) {
  if (!isPlain(types)) return false;
  const keys = Object.keys(types).filter((k) => k !== "EIP712Domain");
  if (keys.length !== Object.keys(want).length) return false;
  if (has(types, "EIP712Domain") && !fieldsAre(types.EIP712Domain, EIP712_DOMAIN_FIELDS)) return false;
  return Object.entries(want).every(([k, fields]) => has(types, k) && fieldsAre(types[k], fields));
}

/* Exactly the four domain keys, this name and version, THIS chain, THIS contract. */
function domainIs(dom, { name, version }, chainId, verifyingContract) {
  return isPlain(dom) && Object.keys(dom).length === 4 && EIP712_DOMAIN_FIELDS.every(([k]) => has(dom, k))
    && dom.name === name && dom.version === version
    && uintIs(dom.chainId, BigInt(chainId)) && typeof dom.verifyingContract === "string" && lower(dom.verifyingContract) === verifyingContract;
}

/* Rule 3, against the signer's clock. */
function windowOk(validAfter, validBefore, nowS) {
  const va = qty(validAfter);
  const vb = qty(validBefore);
  if (va == null || vb == null || vb <= va) return false;
  if (vb > BigInt(nowS + RECOVER_SIGN_WINDOW.maxValidS + RECOVER_SIGN_WINDOW.clockSkewS)) return false;
  if (vb < BigInt(nowS + RECOVER_SIGN_WINDOW.minLeftS)) return false;
  if (va > BigInt(nowS + RECOVER_SIGN_WINDOW.clockSkewS)) return false;
  return true;
}

/* EIP-3009 ReceiveWithAuthorization on this chain's USDC: from own, to the pinned receiver, for the review's amount, nonce and deadline. */
function readRwa(td, { review, own, raw, nowS, chain, receiver }) {
  if (!isPlain(td) || td.primaryType !== "ReceiveWithAuthorization") return null;
  if (!domainIs(td.domain, USDC_DOMAIN, chain.chainId, chain.usdc)) return null;
  if (!typesAre(td.types, { ReceiveWithAuthorization: RWA_FIELDS })) return null;
  const m = td.message;
  if (!sameKeys(m, RWA_FIELDS)) return null;
  if (typeof m.from !== "string" || lower(m.from) !== own) return null;
  if (typeof m.to !== "string" || lower(m.to) !== receiver) return null;
  if (!uintIs(m.value, raw)) return null;
  if (typeof m.nonce !== "string" || !BYTES32_RE.test(m.nonce) || lower(m.nonce) !== review.permitNonce) return null;
  if (!uintIs(m.validBefore, BigInt(review.validBefore))) return null;
  if (!windowOk(m.validAfter, m.validBefore, nowS)) return null;
  return Object.freeze({
    domain: Object.freeze({ name: USDC_DOMAIN.name, version: USDC_DOMAIN.version, chainId: chain.chainId, verifyingContract: chain.usdc }),
    types: Object.freeze({ EIP712Domain: fieldList(EIP712_DOMAIN_FIELDS), ReceiveWithAuthorization: fieldList(RWA_FIELDS) }),
    primaryType: "ReceiveWithAuthorization",
    message: Object.freeze(pick(m, RWA_FIELDS)),
  });
}

/* [USDC.approve(depository, X)]? then depository.depositErc20(own, USDC, X, orderId): recoverStranded's checkMcaCalls rule, read again here. */
function mcaCallsOk(calls, { own, raw, orderId, chain }) {
  if (typeof orderId !== "string" || !BYTES32_RE.test(orderId)) return false;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 2) return false;
  return calls.every((c, i) => {
    if (!sameKeys(c, CALL3_FIELDS) || c.allowFailure !== false || !uintIs(c.value, 0n)) return false;
    if (typeof c.target !== "string" || typeof c.callData !== "string") return false;
    let d;
    try { d = decodeFunctionData({ abi: MCA_CALL_ABI, data: c.callData }); } catch { return false; }
    if (lower(encodeFunctionData({ abi: MCA_CALL_ABI, functionName: d.functionName, args: d.args })) !== lower(c.callData)) return false;
    const last = i === calls.length - 1;
    if (d.functionName === "approve") {
      return !last && lower(c.target) === chain.usdc && lower(d.args[0]) === RECOVER_SIGN_RELAY.depository && d.args[1] === raw;
    }
    if (d.functionName === "depositErc20") {
      return last && lower(c.target) === RECOVER_SIGN_RELAY.depository && lower(d.args[0]) === own && lower(d.args[1]) === chain.usdc
        && d.args[2] === raw && lower(d.args[3]) === lower(orderId);
    }
    return false;
  });
}

/* The call authorization (Relay v3.2, from 2026-10-26) on the v3.2 proxy of THIS chain, pulling exactly X of own USDC into one deposit for own. */
function readMca(td, { review, own, raw, nowS, chain }) {
  if (!isPlain(td) || td.primaryType !== "MulticallAuthorization") return null;
  if (!domainIs(td.domain, MCA_DOMAIN, chain.chainId, RECOVER_SIGN_RELAY.v32ApprovalProxy)) return null;
  if (!typesAre(td.types, { MulticallAuthorization: MCA_FIELDS, Call3Value: CALL3_FIELDS, FundingAuthorization: FUNDING_FIELDS })) return null;
  const m = td.message;
  if (!sameKeys(m, MCA_FIELDS)) return null;
  if (lower(m.from) !== own || lower(m.refundTo) !== own) return null;
  if (!(lower(m.nftRecipient) === own || lower(m.nftRecipient) === NATIVE)) return null;
  if (!ADDRESS_RE.test(String(m.relayer)) || !uintIs(m.msgValue, 0n) || !uintIs(m.fundingIndex, 0n)) return null;
  if (typeof m.metadata !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(m.metadata)) return null;
  const f = Array.isArray(m.funding) && m.funding.length === 1 ? m.funding[0] : null;
  if (!sameKeys(f, FUNDING_FIELDS) || lower(f.token) !== chain.usdc || lower(f.from) !== own || !uintIs(f.value, raw)) return null;
  if (!windowOk(f.validAfter, f.validBefore, nowS)) return null;
  if (!mcaCallsOk(m.calls, { own, raw, orderId: review.orderId, chain })) return null;
  return Object.freeze({
    domain: Object.freeze({ name: MCA_DOMAIN.name, version: MCA_DOMAIN.version, chainId: chain.chainId, verifyingContract: RECOVER_SIGN_RELAY.v32ApprovalProxy }),
    types: Object.freeze({
      EIP712Domain: fieldList(EIP712_DOMAIN_FIELDS), MulticallAuthorization: fieldList(MCA_FIELDS),
      Call3Value: fieldList(CALL3_FIELDS), FundingAuthorization: fieldList(FUNDING_FIELDS),
    }),
    primaryType: "MulticallAuthorization",
    message: Object.freeze({
      ...pick(m, MCA_FIELDS),
      calls: m.calls.map((c) => Object.freeze(pick(c, CALL3_FIELDS))),
      funding: [Object.freeze(pick(f, FUNDING_FIELDS))],
    }),
  });
}

/* Rule 6: a deep copy of plain data, read once. Strings, numbers, booleans, bigints, null; arrays and plain objects
   of OWN, enumerable DATA properties (an array's length aside). Anything else throws, and the caller refuses. A shared
   branch is copied twice (a cycle is refused); the depth is bounded. */
const SNAPSHOT_DEPTH = 12;
const NOT_PLAIN = Object.freeze({ notPlain: true });
function plainData(v, depth = 0, path = new Set()) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return v;
  if (t !== "object" || depth > SNAPSHOT_DEPTH || path.has(v)) throw NOT_PLAIN;
  const arr = Array.isArray(v);
  const proto = Object.getPrototypeOf(v);
  if (arr ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw NOT_PLAIN;
  path.add(v);
  const out = arr ? [] : {};
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k === "symbol") throw NOT_PLAIN;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) throw NOT_PLAIN;
    if (arr && k === "length") continue;
    if (!d.enumerable) throw NOT_PLAIN;
    out[k] = plainData(d.value, depth + 1, path);
  }
  path.delete(v);
  return out;
}
/* The review's fields this file reads, each read once as an own data property (then copied as plain data). */
const REVIEW_FIELDS = Object.freeze(["kind", "own", "chainId", "amountRaw", "validBefore", "permitNonce", "orderId", "minimumUsdc", "signatures"]);
function reviewSnapshot(review) {
  if (!review || typeof review !== "object") return null;
  const out = {};
  for (const k of REVIEW_FIELDS) {
    const d = Object.getOwnPropertyDescriptor(review, k);
    if (d && !("value" in d)) throw NOT_PLAIN;
    out[k] = d ? plainData(d.value) : undefined;
  }
  return out;
}

/* A stable text of a typed data, for "the request is the review's own" (bigints as text). */
const stable = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x));

/**
 * THE CLOSED TYPED-DATA BUILDER FOR RECOVER. The typed data Privy may be asked
 * to sign for this move into the balance — rebuilt from the request, which must
 * be one of the signatures parseRecoverQuote produced for THIS review, field by
 * field — or null.
 *
 * @param {object} typedData { domain, types, primaryType, message } as executeRecover hands it over
 * @param {object} review    the Recover review (lib/relay/recoverStranded.js parseRecoverQuote)
 * @param {string} own       the embedded wallet's address (the only payer, and the review's own)
 * @param {{ now?: number }} [o]
 * @returns {Readonly<{ kind: "eip3009"|"multicall-authorization", chainId: number, typedData: object, words: object }>|null}
 */
export function recoverTypedDataFromRequest(typedDataIn, reviewIn, own, { now = Date.now() } = {}) {
  if (!isAddr(own)) return null;
  const o = lower(own);
  /* Rule 6: from here on, only the copies are read. */
  let typedData;
  let review;
  try {
    typedData = plainData(typedDataIn);
    review = reviewSnapshot(reviewIn);
  } catch {
    return null;
  }
  if (!isPlain(typedData) || !Object.keys(typedData).every((k) => TYPED_DATA_KEYS.includes(k))) return null;
  if (!review || review.kind !== "recover" || review.own !== o) return null;
  const chain = Object.prototype.hasOwnProperty.call(RECOVER_SIGN_CHAINS, review.chainId) && Number.isSafeInteger(review.chainId)
    ? RECOVER_SIGN_CHAINS[review.chainId] : null;
  if (!chain) return null;
  const sigs = Array.isArray(review.signatures) ? review.signatures : null;
  if (!sigs || sigs.length < 1 || sigs.length > 2) return null;
  const raw = rawOf(review.amountRaw);
  if (raw == null || raw <= 0n) return null;
  if (!Number.isSafeInteger(review.validBefore) || typeof review.permitNonce !== "string" || !BYTES32_RE.test(review.permitNonce)) return null;
  const nowS = Math.floor(Number(now) / 1000);
  if (!Number.isFinite(nowS)) return null;

  /* Which of the review's own signatures this is, by its place: the call
     authorization comes FIRST and only with two (v3.2); the USDC authorization is
     always LAST, to the v3 proxy alone or to the v3.2 proxy behind its call
     authorization — never the other way round (ATK-05). */
  const index = sigs.findIndex((s) => s && s.typedData && s.typedData.primaryType === typedData.primaryType);
  if (index < 0) return null;
  const last = index === sigs.length - 1;
  const ctx = { review, own: o, raw, nowS, chain };
  let mine;
  let theirs;
  if (last) {
    const receiver = sigs.length === 2 ? RECOVER_SIGN_RELAY.v32ApprovalProxy : RECOVER_SIGN_RELAY.v3ApprovalProxy;
    mine = readRwa(typedData, { ...ctx, receiver });
    theirs = readRwa(sigs[index].typedData, { ...ctx, receiver });
  } else {
    mine = readMca(typedData, ctx);
    theirs = readMca(sigs[index].typedData, ctx);
  }
  /* Both readable, and the request is the review's own signature — not another
     review's, not the same shape for another amount, nonce, deadline or payee. */
  if (!mine || !theirs || stable(mine) !== stable(theirs)) return null;
  const words = recoverMoveInSignWords({ amount: fmt6(raw), minimum: typeof review.minimumUsdc === "string" ? review.minimumUsdc : null, chainName: chain.chainName });
  const w = readSignWords(last ? words.permit : words.authorize);
  if (!w) return null;
  return Object.freeze({ kind: last ? "eip3009" : "multicall-authorization", chainId: chain.chainId, typedData: mine, words: w });
}
