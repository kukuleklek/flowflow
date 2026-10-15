// ─────────────────────────────────────────────────────────────────────────────
// Privy — email / Google / passkey login backed by an embedded EOA, which IS the
// customer's Hyperliquid account.
// ─────────────────────────────────────────────────────────────────────────────
//
// Privy's API is hook-based; the rest of the app is not. This module is the
// bridge: <PrivyBridge> (signing, provider) and <PrivyHeadless> (FlowFlow's own
// login card, no Privy modal) register their hook-derived APIs here, and the
// app calls plain functions. The app tree never consumes a Privy hook directly.
//
// MOUNT ON DEMAND. `@privy-io/react-auth` is a big chunk. <PrivyGate> mounts it
// when someone asks (a login, a returning session, an OAuth redirect return), so
// the market list paints without it.
//
// THE CHAIN. FlowFlow parks the embedded wallet on Arbitrum (42161). Hyperliquid's
// user-signed actions take the wallet's current chain as their signatureChainId
// (exchange/network.js "wallet" mode), so they are signed for 0xa4b1, the chain the
// official docs use, and a wallet is never asked to sign for a chain it is not on.

import { PRIVY_CONFIG_URL, privyMethodsFromConfig } from "./privyMethods.js";

/** Public client id from the Privy dashboard. Not a secret: the dashboard's
 *  allowed-domains list is the boundary. */
export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID || "").trim();

/** When false every Privy button is hidden and the chunk is never fetched. */
export function isPrivyConfigured() {
  return PRIVY_APP_ID.length > 0;
}

// ── The dashboard's sign-in switches (privyMethods.js) ──────────────────────
// Fetched once, without mounting the SDK. A failure leaves them unknown (every
// method shown) and lets the next sign-in card ask again.
let _methods = null;
let _methodsReq = null;
const _methodSubs = new Set();

export function loadPrivyMethods(fetchImpl = globalThis.fetch) {
  if (!isPrivyConfigured() || _methods || _methodsReq) return;
  _methodsReq = fetchImpl(PRIVY_CONFIG_URL(PRIVY_APP_ID), { headers: { "privy-app-id": PRIVY_APP_ID } })
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      _methods = privyMethodsFromConfig(cfg);
      if (_methods) for (const fn of _methodSubs) fn();
    })
    .catch(() => {})
    .finally(() => { _methodsReq = null; });
}

export function subscribePrivyMethods(fn) {
  _methodSubs.add(fn);
  return () => _methodSubs.delete(fn);
}

export const getPrivyMethods = () => _methods;

/** Arbitrum One. */
export const PRIVY_CHAIN_ID = 42161;

export function privyChainId() {
  return PRIVY_CHAIN_ID;
}

/** Set while this browser has a Privy session, so the next page load mounts
 *  Privy straight away to restore it. A hint only: Privy's own session decides. */
const SESSION_HINT_KEY = "flowflow.privy.session.v1";

export function hasSessionHint() {
  try { return globalThis.localStorage?.getItem(SESSION_HINT_KEY) === "1"; } catch { return false; }
}

/* This load is coming back from Google, or this browser had a session: until Privy answers, a sign-in surface says
   "Signing you in…" rather than offering Sign in again. Read once, at load. */
const RESTORING_AT_LOAD = isPrivyConfigured() && typeof window !== "undefined"
  && (hasSessionHint() || new URLSearchParams(window.location.search).has("privy_oauth_code"));

export const restoringAtLoad = () => RESTORING_AT_LOAD;

function setSessionHint(on) {
  try {
    if (on) globalThis.localStorage?.setItem(SESSION_HINT_KEY, "1");
    else globalThis.localStorage?.removeItem(SESSION_HINT_KEY);
  } catch { /* storage refused */ }
}

// ── The auth snapshot React reads (useSyncExternalStore) ────────────────────
//
// phase: "off"      Privy is not configured (no app id)
//        "idle"     configured, not mounted yet (nobody asked)
//        "booting"  mounted, the SDK is starting or restoring a session
//        "ready"    the SDK answered: authenticated says whether there is a user

let _snap = Object.freeze({
  phase: isPrivyConfigured() ? "idle" : "off",
  authenticated: false,
  address: null,
  user: null,
});
const _subs = new Set();

export function subscribePrivy(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

export function getPrivySnapshot() {
  return _snap;
}

function publish(patch) {
  const next = { ..._snap, ...patch };
  const same = Object.keys(next).every((k) => Object.is(next[k], _snap[k]));
  if (same) return;
  _snap = Object.freeze(next);
  for (const fn of [..._subs]) {
    try { fn(); } catch { /* a subscriber must not stop the others */ }
  }
}

// ── Mount-on-demand plumbing ────────────────────────────────────────────────
let _mountListener = null;
let _mountRequested = false;

/** <PrivyGate> subscribes; returns an unsubscribe fn. */
export function onPrivyMountRequested(fn) {
  _mountListener = fn;
  if (_mountRequested) fn(); // a login beat the gate's mount: replay it
  return () => { if (_mountListener === fn) _mountListener = null; };
}

export function requestPrivyMount() {
  if (!isPrivyConfigured()) return;
  if (_snap.phase === "idle") publish({ phase: "booting" });
  _mountRequested = true;
  _mountListener?.();
}

// ── Hook → imperative bridge ────────────────────────────────────────────────
let _api = null;
let _readyWaiters = [];
/* Who wants to hear that the bridge (re)registered, and how many times it has:
   the app-wide deposit mover (perp/deposit/AutoMover.jsx) waits for the
   no-window sender to exist before it reads or moves anything. */
let _apiSeq = 0;
const _apiSubs = new Set();

/** <PrivyBridge> registers signing and the provider. */
export function registerPrivyApi(api) {
  _api = api;
  _apiSeq += 1;
  if (api?.ready) {
    _readyWaiters.splice(0).forEach((resolve) => resolve(api));
  }
  for (const fn of [..._apiSubs]) {
    try { fn(); } catch { /* a subscriber must not stop the others */ }
  }
}

/** Called after every registration of the bridge's API. Returns the unsubscribe. */
export function subscribePrivyApi(fn) {
  _apiSubs.add(fn);
  return () => { _apiSubs.delete(fn); };
}

/** How many times the bridge has registered (a snapshot for useSyncExternalStore). */
export function privyApiSeq() {
  return _apiSeq;
}

let _login = null;
let _loginWaiters = [];

/** <PrivyHeadless> registers the login functions and what it knows about the user. */
export function registerPrivyLogin(login) {
  _login = login;
  if (login?.ready) {
    _loginWaiters.splice(0).forEach((resolve) => resolve(login));
    publish({
      phase: "ready",
      authenticated: !!login.authenticated,
      address: login.authenticated && login.embeddedAddress ? login.embeddedAddress : null,
      user: login.authenticated ? login.user || null : null,
    });
    if (login.authenticated) setSessionHint(true);
  }
}

function whenReady(getter, waiters, timeoutMs = 15000) {
  const now = getter();
  if (now?.ready) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Privy failed to start. Check VITE_PRIVY_APP_ID and the dashboard's allowed domains.")),
      timeoutMs,
    );
    waiters.push((api) => { clearTimeout(timer); resolve(api); });
  });
}

const whenPrivyReady = (ms) => whenReady(() => _api, _readyWaiters, ms);
const whenLoginReady = (ms) => whenReady(() => _login, _loginWaiters, ms);

// ── Headless login (FlowFlow's own card, no Privy modal) ────────────────────

/** Leaves the page for Google, and comes back with ?privy_oauth_code. */
export async function loginWithGoogle() {
  if (!isPrivyConfigured()) throw new Error("Sign-in is not configured.");
  requestPrivyMount();
  const l = await whenLoginReady();
  setSessionHint(true);
  return l.loginWithGoogle();
}

export async function sendEmailCode(email) {
  if (!isPrivyConfigured()) throw new Error("Sign-in is not configured.");
  requestPrivyMount();
  const l = await whenLoginReady();
  return l.sendEmailCode(email);
}

export async function loginWithEmailCode(code) {
  const l = await whenLoginReady();
  await l.loginWithEmailCode(code);
  setSessionHint(true);
}

/** An existing passkey. A new user has none: they sign up with signupWithPasskey instead. */
export async function loginWithPasskey() {
  if (!isPrivyConfigured()) throw new Error("Sign-in is not configured.");
  requestPrivyMount();
  const l = await whenLoginReady();
  await l.loginWithPasskey();
  setSessionHint(true);
}

/** A new account on a new passkey (only when the dashboard allows passkey sign-up). */
export async function signupWithPasskey() {
  if (!isPrivyConfigured()) throw new Error("Sign-in is not configured.");
  requestPrivyMount();
  const l = await whenLoginReady();
  await l.signupWithPasskey();
  setSessionHint(true);
}

/**
 * The embedded wallet's EIP-1193 provider, parked on Arbitrum, once a user is
 * signed in. Never opens a window: with no session it throws PRIVY_NO_SESSION.
 */
export async function connectPrivy({ silent = true, method, viaRedirect = false } = {}) {
  if (!isPrivyConfigured()) throw new Error("Privy is not configured");
  if (_endingSession) {
    await Promise.race([
      _endingSession,
      new Promise((r) => setTimeout(r, PRIVY_TEARDOWN_WAIT_MS)),
    ]).catch(() => {});
  }
  requestPrivyMount();
  const api = await whenPrivyReady();
  return api.connect({ silent, method, viaRedirect });
}

// ── No key export ───────────────────────────────────────────────────────────
// Key export was removed (owner, 2026-09-23); FlowFlow never had it.

// ── Enable trading with no window ───────────────────────────────────────────
//
// For a Privy login, Hyperliquid's Enable trading approvals (approveAgent, and
// approveBuilderFee when a builder fee is configured) are signed by the embedded
// wallet with no Privy window: PrivyBridge registers signTypedDataSilently
// (useSignTypedData, showWalletUIs false) and refuses any other typed data
// itself. The trading layer reads it here, at signing time, for those two
// approvals only (exchange/master.js). Withdraw keeps its window.

/**
 * @returns {{ address: string, signTypedData: (typedData: object) => Promise<string> }|null}
 *   the embedded wallet's no-window typed-data signer; null when the bridge
 *   registered none (Perp mode off, or not logged in with Privy)
 */
export function privySilentTypedSigner() {
  const api = _api;
  if (!api || typeof api.signTypedDataSilently !== "function") return null;
  const address = typeof api.embeddedAddress === "string" && api.embeddedAddress ? api.embeddedAddress : null;
  if (!address) return null;
  return { address, signTypedData: (typedData) => api.signTypedDataSilently(typedData, address) };
}

/**
 * The last hop of a first deposit, with no window (the first-deposit
 * plan). PrivyBridge rebuilds that one transfer itself and refuses anything else.
 * @returns {{ address: string, sendTransaction: (tx: object) => Promise<string> }|null}
 */
export function privySilentTxSender() {
  const api = _api;
  if (!api || typeof api.sendPerpFunding !== "function") return null;
  const address = typeof api.embeddedAddress === "string" && api.embeddedAddress ? api.embeddedAddress : null;
  if (!address) return null;
  return { address, sendTransaction: (tx) => api.sendPerpFunding(tx, address) };
}

// ── The Avax Wallet: Avalanche, ALWAYS with a window ────────────────────────
//
// Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
// Privy เลย". The Avax Wallet is the same embedded EOA on chain 43114, and every
// Avalanche transaction and typed-data signature it makes opens Privy's VISIBLE
// window: PrivyBridge registers `api.avalanche` on the shown pair (the hooks that
// carry the button's words), never on the silent pair above, and rebuilds every
// request with the closed builders in src/avax/closedTx.js before Privy is asked.
// There is no no-window path for Avalanche here, and none may be added.
//
// It lives under its own key, not beside `embeddedAddress`: a flag-off build
// registers no silent signer and no embeddedAddress (test-perp-silent-enable B3),
// and a visible Avalanche signer must not look like one.
//
// The callers are src/avax/signers.js and nothing else.

/**
 * The embedded wallet's VISIBLE Avalanche transaction sender, or null until the
 * bridge registered one.
 * @returns {{ address: string, sendTransaction: (tx: object, check: object) => Promise<string> }|null}
 *   sendTransaction resolves the tx hash; the bridge refuses anything the closed builder does not build
 */
export function privyAvalancheTxSender() {
  const a = _api && _api.avalanche;
  if (!a || typeof a.sendTransaction !== "function") return null;
  const address = typeof a.address === "string" && a.address ? a.address : null;
  if (!address) return null;
  return { address, sendTransaction: (tx, check) => a.sendTransaction(tx, check) };
}

/**
 * The embedded wallet's VISIBLE Avalanche typed-data signer (the move back to
 * the Main Account), or null until the bridge registered one.
 * @returns {{ address: string, signTypedData: (typedData: object, review: object) => Promise<string> }|null}
 *   signTypedData resolves the 65-byte hex signature
 */
export function privyAvalancheTypedSigner() {
  const a = _api && _api.avalanche;
  if (!a || typeof a.signTypedData !== "function") return null;
  const address = typeof a.address === "string" && a.address ? a.address : null;
  if (!address) return null;
  return { address, signTypedData: (typedData, review) => a.signTypedData(typedData, review) };
}

// ── Recover: Base and Polygon, ALWAYS with a window ─────────────────────────
//
// A private deposit's refund on Base or Polygon lands in the same embedded EOA
// with no gas there; the Deposit sheet's Recover row moves it into the balance
// with one typed-data signature (lib/relay/recoverStranded.js). PrivyBridge
// registers `api.recover` on the SHOWN sign hook and rebuilds every request with
// lib/relay/recoverClosed.js before Privy is asked, and also hands the same
// function to recoverStranded (provideRecoverSigner), which is how the Recover
// rows reach it. Like the Avalanche pair, it lives under its own key and is never
// a no-window signer.

/**
 * The embedded wallet's VISIBLE Recover typed-data signer (chain 8453 / 137),
 * or null until the bridge registered one.
 * @returns {{ address: string, signTypedData: (typedData: object, review: object) => Promise<string> }|null}
 *   signTypedData resolves the 65-byte hex signature; the bridge refuses anything the closed builder does not build
 */
export function privyRecoverTypedSigner() {
  const r = _api && _api.recover;
  if (!r || typeof r.signTypedData !== "function") return null;
  const address = typeof r.address === "string" && r.address ? r.address : null;
  if (!address) return null;
  return { address, signTypedData: (typedData, review) => r.signTypedData(typedData, review) };
}

// ── Ending the session ──────────────────────────────────────────────────────
//
// Measured (2026-08-20) that Privy's logout nulls the in-memory user
// BEFORE its network call, and deletes the persisted token only AFTER it. A
// failed or hung network leg therefore leaves the session on disk while the UI
// reads "logged out", and the next load signs the user straight back in. So:
// ask Privy to log out, then make sure the session is gone.

const PRIVY_SESSION_PREFIX = "privy:";
const PRIVY_SESSION_COOKIES = ["privy-token", "privy-refresh-token", "privy-id-token", "privy-session"];

function sweepPrivySession() {
  for (const store of [
    typeof localStorage !== "undefined" ? localStorage : null,
    typeof sessionStorage !== "undefined" ? sessionStorage : null,
  ]) {
    if (!store) continue;
    const doomed = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(PRIVY_SESSION_PREFIX)) doomed.push(k);
      }
    } catch { /* private mode / storage disabled */ }
    for (const k of doomed) { try { store.removeItem(k); } catch { /* quota race */ } }
  }
  try {
    const host = window.location.hostname;
    const parent = host.split(".").slice(-2).join(".");
    for (const name of PRIVY_SESSION_COOKIES) {
      for (const scope of ["", `;domain=${host}`, `;domain=.${parent}`]) {
        document.cookie = `${name}=;max-age=0;path=/${scope}`;
      }
    }
  } catch { /* SSR / no document */ }
}

const PRIVY_TEARDOWN_WAIT_MS = 3000;

let _endingSession = null;

/**
 * Ends the Privy session, and makes sure it is really ended. Never throws.
 * @returns {Promise<string>} "logged-out" | "no-bridge" | "logout-timed-out" | "logout-failed: …"
 */
export async function disconnectPrivy() {
  const run = (async () => {
    let status = "no-bridge";
    try {
      if (_api?.logout) {
        status = await Promise.race([
          Promise.resolve(_api.logout()).then(
            () => "logged-out",
            (e) => `logout-failed: ${e?.message || e}`,
          ),
          new Promise((r) => setTimeout(() => r("logout-timed-out"), PRIVY_TEARDOWN_WAIT_MS)),
        ]);
      }
    } catch (e) {
      status = `logout-failed: ${e?.message || e}`;
    } finally {
      // After the logout, not before: Privy's own revoke authenticates with the token below.
      sweepPrivySession();
      setSessionHint(false);
      publish({ authenticated: false, address: null, user: null });
    }
    return status;
  })();
  _endingSession = run;
  try { return await run; } finally { if (_endingSession === run) _endingSession = null; }
}
