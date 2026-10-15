// ─────────────────────────────────────────────────────────────────────────────
// THE AVAX WALLET'S SIGNERS: the four calls the Swap / Move / Stake flows sign
// with, each one a VISIBLE window, and none of them able to pay anyone but the
// user's own embedded address.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
// Privy เลย แล้วเตรียมเทสเงินจริง 2 USDC ไป-กลับ". This module is the one thing
// the Avax flows (the hooks, the executors in lib/relay/{ownMove,moveOut,swap}.js)
// are handed to sign with:
//
//   getAvaxSigners() → null, or {
//     own                the embedded address, lowercase — the ONLY recipient
//     sendAvaxTx         (tx, { words, check }) => hash          Avalanche tx, Privy's window
//     signAvaxTypedData  (typedData, { words, review }) => sig   the move back to the Main Account
//     signAuthorize      (step) => { ok, signature, post } | refusal   Main Account, authorize window
//     sendDeposit        ({ step, amountUsdc, maxDebitUsdc? }) => { ok } | refusal   Main Account, sendAsset window
//   }
//   subscribeAvaxSigners(cb) → unsubscribe     cb(signers|null) on login, logout, account switch
//   AvaxSignRefused                             code "refused": thrown BEFORE Privy is asked
//
// WHERE EACH ONE SIGNS
//   sendAvaxTx / signAvaxTypedData  services/privy's Avalanche pair, which the
//       Privy bridge registers on its SHOWN hooks (PrivyBridge "THE AVAX WALLET").
//       The request is checked here by the closed builders (src/avax/closedTx.js)
//       and checked AGAIN in the bridge at the moment Privy is asked; the window's
//       words are built there from the decoded figures. `words` is accepted and
//       never printed: a caller cannot put its own sentence over money.
//   signAuthorize / sendDeposit  the Perp backend's own two calls — the very ones
//       today's Withdraw signs with (perp/live/perpBackend.js → exchange/client.js
//       signRelayAuthorize / sendRelayDeposit), registered by <BackendProvider>
//       (registerAvaxPerpSigners). Their windows are the wallet's, with the words
//       executeOwnMove arms (lib/signCopy.js ownMoveSignWords).
//
// 🔴 THE MONEY RULES OF THIS FILE
//   1. ONE ADDRESS. Signers exist only when Privy is signed in, the bridge's
//      Avalanche pair, the Perp backend (live, not view-as, a Privy wallet) and
//      Privy's own session all name the SAME address; it is read again before
//      every window, and a change refuses ("Your wallet changed").
//   2. NOTHING SILENT. Every call here opens a window. There is no option to ask
//      for less, and services/privy has no no-window path for Avalanche.
//   3. A MOVE OUT OF THE MAIN ACCOUNT goes only to Relay's PINNED HyperCore
//      depository and takes at most min(maxDebitUsdc, MAX_MOVE_USDC) — the env
//      may lower the 20 USDC cap, never raise it (src/avax/limits.js).
//   4. NEVER A CHAIN SWITCH. Nothing here, and nothing it calls, switches the
//      wallet to 43114 (scripts/test-avax-signers.mjs greps the whole of src/).
//   5. A REFUSAL IS NOT AN UNKNOWN. AvaxSignRefused is thrown before Privy is
//      asked and reads as "Cancelled. Nothing moved."; the user saying no in the
//      window rethrows with code 4001; anything else after the window is asked
//      is passed on as it is, and the executors treat it as UNKNOWN (the
//      transaction may be out) — never as a refusal.

import {
  privyAvalancheTxSender, privyAvalancheTypedSigner, subscribePrivyApi, subscribePrivy, getPrivySnapshot, privyApiSeq,
} from "../services/privy.js";
import { avaxTxFromRequest, avaxTypedDataFromRequest, AvaxSignRefused } from "./closedTx.js";
import { resolveLimits } from "./limits.js";
import { RELAY_HL_DEPOSITORY } from "../lib/avax/config.js";

export { AvaxSignRefused };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const isAddr = (a) => typeof a === "string" && ADDRESS_RE.test(a) && !/^0x0{40}$/.test(a);
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/* The Main Account's refusals, in the trader's own { ok: false, code, message } shape. None names a provider. */
const PERP_WORDS = Object.freeze({
  wallet: "Your wallet changed. Nothing was signed.",
  badStep: "This move's authorization isn't the one this app signs, so nothing was signed.",
  movesOff: "Moves are off in FlowFlow for now. Nothing was sent.",
});
const refusal = (code, message) => ({ ok: false, code, message });

/* ── the Main Account's half: the Perp backend the existing Withdraw signs with ── */

let perp = null;
let perpSeq = 0;
const perpSubs = new Set();

/* The backend's two Relay calls, when they answer for a live Privy account; null otherwise. */
function perpOf(backend) {
  const b = backend && typeof backend === "object" ? backend : null;
  if (!b || b.kind !== "live" || b.mock === true || b.readOnly === true || b.viewAs) return null;
  if (b.walletType !== "privy" || !isAddr(b.address)) return null;
  if (typeof b.signRelayAuthorize !== "function" || typeof b.sendRelayDeposit !== "function") return null;
  return Object.freeze({ own: lower(b.address), signRelayAuthorize: b.signRelayAuthorize, sendRelayDeposit: b.sendRelayDeposit });
}

/**
 * <BackendProvider> hands over the Perp backend (usePerpBackend()) whenever its
 * account or its trader changes. Returns the unregister.
 * @param {{ kind: string, address: string|null, walletType: string|null, readOnly?: boolean,
 *   signRelayAuthorize: Function, sendRelayDeposit: Function }} backend
 */
export function registerAvaxPerpSigners(backend) {
  const next = perpOf(backend);
  perp = next;
  perpSeq += 1;
  for (const fn of [...perpSubs]) { try { fn(); } catch { /* a subscriber must not stop the others */ } }
  return () => {
    if (perp !== next) return;
    perp = null;
    perpSeq += 1;
    for (const fn of [...perpSubs]) { try { fn(); } catch { /* likewise */ } }
  };
}

/* ── the one address (rule 1) ─────────────────────────────────────────────── */

function ownNow() {
  const snap = getPrivySnapshot();
  if (!snap || snap.phase !== "ready" || !snap.authenticated) return null;
  const tx = privyAvalancheTxSender();
  const td = privyAvalancheTypedSigner();
  const p = perp;
  if (!tx || !td || !p) return null;
  const own = lower(tx.address);
  if (!isAddr(own) || lower(td.address) !== own || p.own !== own) return null;
  /* Privy's own session names the same wallet, when it names one. */
  if (snap.address && lower(snap.address) !== own) return null;
  return own;
}

const wrongWallet = () => new AvaxSignRefused("wallet-changed");

/* The user saying no in Privy's window (or closing it): code 4001, whatever Privy wrapped it in. */
function isUserRejection(e) {
  if (!e) return false;
  const codes = [e.code, e.cause && e.cause.code, e.error && e.error.code];
  if (codes.includes(4001) || codes.includes("ACTION_REJECTED")) return true;
  return /user rejected|rejected the request|denied|user exited|cancel/i.test(String(e.message || e));
}

function walletError(e) {
  if (e instanceof AvaxSignRefused) return e;
  if (isUserRejection(e)) {
    const err = new Error("Cancelled in your wallet. Nothing was sent.");
    err.code = 4001;
    err.cause = e;
    return err;
  }
  return e;
}

/* ── the HyperCore authorize step a move into the Spot Account signs ─────── */

/*
 * The authorize step an own move signs is Relay's RelayNonceMapping for THIS
 * wallet on HyperCore, posted back to /authorize (live, 2026-10-15). It moves
 * nothing by itself; anything else is not signed for a move. The trader's own
 * gate (exchange/relayOut.js) checks every address in it again.
 */
function authorizeStepProblem(step, own) {
  const item = step && step.id === "authorize" && step.kind === "signature" && Array.isArray(step.items) && step.items.length === 1 ? step.items[0] : null;
  const data = item && item.data;
  const sign = data && data.sign;
  if (!sign || sign.signatureKind !== "eip712" || sign.primaryType !== "NonceMapping") return "shape";
  if (!sign.domain || sign.domain.name !== "RelayNonceMapping") return "domain";
  const v = sign.value || {};
  if (v.chainId !== "hyperliquid" || lower(v.wallet) !== own || (v.depositor != null && lower(v.depositor) !== own)) return "wallet";
  if (!data.post || data.post.endpoint !== "/authorize") return "post";
  return null;
}

/* ── the signers ──────────────────────────────────────────────────────────── */

function signersFor(own) {
  const sameOwn = () => ownNow() === own;
  const perpFor = () => (sameOwn() && perp && perp.own === own ? perp : null);

  /** One Avalanche transaction, in Privy's window. Resolves the hash. */
  async function sendAvaxTx(tx, { check = null } = {}) {
    if (!sameOwn()) throw wrongWallet();
    const s = privyAvalancheTxSender();
    if (!s || lower(s.address) !== own) throw wrongWallet();
    if (!avaxTxFromRequest(tx, check, own)) throw new AvaxSignRefused("not-built", { kind: check && check.kind });
    let hash;
    try {
      hash = await s.sendTransaction(tx, check);
    } catch (e) {
      throw walletError(e);
    }
    /* The window was asked: no hash is an outcome nobody can read, not a refusal. */
    if (typeof hash !== "string" || !TX_HASH_RE.test(hash)) throw new Error("The wallet gave no transaction id. Check your Spot Account before sending again.");
    return hash;
  }

  /** One Avalanche typed-data signature (the move back to the Main Account), in Privy's window. */
  async function signAvaxTypedData(typedData, { review = null } = {}) {
    if (!sameOwn()) throw wrongWallet();
    const s = privyAvalancheTypedSigner();
    if (!s || lower(s.address) !== own) throw wrongWallet();
    if (!avaxTypedDataFromRequest(typedData, review, own)) throw new AvaxSignRefused("not-built", { kind: "typed-data" });
    let sig;
    try {
      sig = await s.signTypedData(typedData, review);
    } catch (e) {
      throw walletError(e);
    }
    /* Nothing is posted without a readable signature, so nothing moved. */
    if (typeof sig !== "string" || !SIGNATURE_RE.test(sig)) throw new Error("The wallet gave no signature. Nothing was sent.");
    return sig;
  }

  /** The Main Account's authorize window of a move into the Spot Account (executeOwnMove's signAuthorize). */
  async function signAuthorize(step) {
    const p = perpFor();
    if (!p) return refusal("wallet", PERP_WORDS.wallet);
    if (authorizeStepProblem(step, own)) return refusal("bad_quote", PERP_WORDS.badStep);
    return p.signRelayAuthorize(step);
  }

  /**
   * The Main Account's sendAsset window of a move into the Spot Account
   * (executeOwnMove's sendDeposit): to the pinned depository, at most
   * min(maxDebitUsdc, MAX_MOVE_USDC) — rule 3.
   */
  async function sendDeposit({ step, amountUsdc, maxDebitUsdc = null } = {}) {
    const p = perpFor();
    if (!p) return refusal("wallet", PERP_WORDS.wallet);
    const cap = resolveLimits().moveUsdc;
    if (!(cap > 0)) return refusal("moves_off", PERP_WORDS.movesOff);
    const asked = typeof maxDebitUsdc === "number" && Number.isFinite(maxDebitUsdc) && maxDebitUsdc > 0 ? maxDebitUsdc : null;
    return p.sendRelayDeposit({
      step, amountUsdc, ownMove: { depository: RELAY_HL_DEPOSITORY, maxDebitUsdc: asked == null ? cap : Math.min(asked, cap) },
    });
  }

  return Object.freeze({ own, sendAvaxTx, signAvaxTypedData, signAuthorize, sendDeposit });
}

/* One answer per state, so a React store reading this gets the SAME object until something changed. */
let cache = { key: null, value: null };

/**
 * The Avax Wallet's signers, or null until Privy, its embedded wallet, the
 * bridge's Avalanche pair and the Perp backend are all ready and agree on one
 * address. Stable between changes (safe for useSyncExternalStore).
 */
export function getAvaxSigners() {
  const snap = getPrivySnapshot() || {};
  const key = `${privyApiSeq()}|${perpSeq}|${snap.phase}|${snap.authenticated ? 1 : 0}|${lower(snap.address)}`;
  if (cache.key === key) return cache.value;
  const own = ownNow();
  const value = own ? (cache.value && cache.value.own === own ? cache.value : signersFor(own)) : null;
  cache = { key, value };
  return value;
}

/**
 * Called with the new signers (or null) whenever they appear, disappear or
 * change account. Returns the unsubscribe.
 */
export function subscribeAvaxSigners(cb) {
  if (typeof cb !== "function") return () => {};
  let last = getAvaxSigners();
  const fire = () => {
    const now = getAvaxSigners();
    if (now === last) return;
    last = now;
    try { cb(now); } catch { /* a subscriber's own error is its own */ }
  };
  const offPrivyApi = subscribePrivyApi(fire);
  const offPrivy = subscribePrivy(fire);
  perpSubs.add(fire);
  return () => {
    offPrivyApi();
    offPrivy();
    perpSubs.delete(fire);
  };
}
