// ─────────────────────────────────────────────────────────────────────────────
// The words a signing window may carry — and nothing else.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-30: "ปุ่มเซ็นของ Privy ไม่เฟี้ยวเลยอะ … เราใส่การเซ็นไปในปุ่ม
// นั้นๆเลยไม่ได้หรอ", and when asked whether money should be signed with no
// window at all: "ไม่ต้องเซ็นเงียบ แต่ทำ popup ให้สวย". So the confirmation
// STAYS, and it learns to say what the button said.
//
// ── Why a register, and not an argument ─────────────────────────────────────
// The words Privy's window can print (title / description / buttonText) are a
// per-call argument to Privy's OWN hooks. Every money signature in this app
// goes through the shared ethers signer WalletContext builds over the wallet's
// EIP-1193 provider, and that provider takes no such argument — so the window
// renders Privy's stock strings and this app cannot say a word on it.
//
// Rather than thread a Privy-shaped signer down through the trading layer, the
// money paths ARM the words here, one signature at a time, and the Privy bridge
// reads them at the moment the wallet is asked. Only the Privy bridge reads
// them; an injected wallet, WalletConnect and the trading key never touch this
// file, so they are exactly what they were.
//
// ── The four rules this file exists to hold ─────────────────────────────────
//  1. SINGLE USE. An arming is consumed by the first matching request, whatever
//     the outcome. Words cannot linger and end up over the wrong money.
//  2. IT EXPIRES. Past the wallet-prompt window an arming is dead, so a tab
//     left open for an hour cannot decorate a later signature.
//  3. IT MUST MATCH, AND IT FAILS CLOSED. An arming names the method it is for,
//     and typed data also names its primaryType. A request that is not the one
//     the words were written for gets Privy's stock copy — never someone
//     else's sentence. An arming that names NO method matches nothing at all:
//     the default used to be typed data, which would have put a new window's
//     sentence on the next typed signature of the minute, whatever it was.
//  4. IT CANNOT MAKE A SIGNATURE QUIET. Only the three text keys and an icon
//     survive readSignWords; the flag that hides the window is not one of them
//     and cannot be set from here. Both option builders below put that flag in
//     LAST, at visible, so no caller and no spread can turn it off. The
//     no-window path is a different pair of functions in a different file, with
//     its own allowlist, and this one can never reach it.
//
// Nothing in this file removes or bypasses a confirmation. It is the words on
// one, and that is the whole of it.

/** How long an arming lives. The wallet-prompt window the perp path already races (master.js). */
export const SIGN_WORDS_TTL_MS = 60_000;

/** The only text a caller may put on a window. */
const TEXT_KEYS = Object.freeze(["title", "description", "buttonText"]);

/** The two request methods a window can be carried on. */
export const SIGN_WORDS_TYPED_DATA = "eth_signTypedData_v4";
export const SIGN_WORDS_TRANSACTION = "eth_sendTransaction";

/* Privy's own screen ellipsifies; this keeps a runaway string out of it. */
const MAX_TEXT = 240;

/** One line, trimmed and collapsed, or null when there is nothing to print. */
function oneLine(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/**
 * What a caller asked for, reduced to what a window may carry: the three text
 * keys, an icon url, the method it is for and — for typed data — the
 * primaryType it belongs to. Anything else the caller put in the object is
 * dropped here and cannot be recovered downstream.
 *
 * @returns {Readonly<object>|null} null when there is no text worth showing
 */
export function readSignWords(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const k of TEXT_KEYS) {
    const s = oneLine(input[k]);
    if (s) out[k] = s;
  }
  if (Object.keys(out).length === 0) return null;
  const icon = oneLine(input.iconUrl);
  /* Root-relative only: the apex sets Cross-Origin-Resource-Policy same-site,
     so an absolute url renders broken off-apex (PrivyMount says the same). */
  if (icon && icon.startsWith("/")) out.iconUrl = icon;
  /* One of the two, or nothing: words with no method are words that can never
     be taken, which is what rule 3 is for. Every builder in lib/signCopy names
     one, so this only ever catches a NEW window that forgot to. */
  out.method = input.method === SIGN_WORDS_TRANSACTION || input.method === SIGN_WORDS_TYPED_DATA
    ? input.method
    : null;
  out.primaryType = typeof input.primaryType === "string" && input.primaryType ? input.primaryType : null;
  return Object.freeze(out);
}

let armed = null;

/**
 * The words for the NEXT matching signature. Called as the last thing before
 * the wallet is asked, by the surface that already has the figures on screen.
 * @returns {Readonly<object>|null} what was armed, for a caller that wants to check
 */
export function armSignWords(input, { now = Date.now } = {}) {
  const words = readSignWords(input);
  armed = words ? { words, at: now() } : null;
  return words;
}

/** Throw an arming away — a flow that refused before the wallet was asked. */
export function disarmSignWords() {
  armed = null;
}

/** What is armed, without consuming it. For tests and for nothing else. */
export function peekSignWords() {
  return armed ? armed.words : null;
}

/**
 * The words for this request, if they were written for it. ALWAYS consumes the
 * arming, match or no match: words that did not fit this signature must not be
 * left lying about for the next one.
 * @returns {Readonly<object>|null}
 */
export function takeSignWords({ method, primaryType = null, now = Date.now } = {}) {
  const held = armed;
  armed = null;
  if (!held) return null;
  if (!Number.isFinite(held.at) || now() - held.at > SIGN_WORDS_TTL_MS) return null;
  if (held.words.method !== method) return null;
  if (held.words.primaryType && held.words.primaryType !== primaryType) return null;
  return held.words;
}

/* ── the two option objects Privy's screens take ───────────────────────────
   Their shapes differ and the difference is not cosmetic: the sign screen has
   a top-level title, and the transaction screen has none — its title lives
   under transactionInfo. Building them here rather than at the bridge keeps
   the one invariant in one place: the flag that hides the window is written
   LAST, at visible, on both. */

/** The window is shown. Not a caller's choice, on either builder below. */
const WINDOW_SHOWN = true;

/** Privy's Sign Message screen: title, description, button, icon. */
export function signMessageUiOptions(words) {
  const w = words || {};
  return {
    ...(w.title ? { title: w.title } : {}),
    ...(w.description ? { description: w.description } : {}),
    ...(w.buttonText ? { buttonText: w.buttonText } : {}),
    ...(w.iconUrl ? { iconUrl: w.iconUrl } : {}),
    /* Privy renders a cancel button only when this is on; without it the one
       way out of the window is the X in its corner. */
    isCancellable: true,
    showWalletUIs: WINDOW_SHOWN,
  };
}

/** Privy's Transaction screen: the title is nested, and there is no icon slot. */
export function sendTransactionUiOptions(words) {
  const w = words || {};
  return {
    ...(w.description ? { description: w.description } : {}),
    ...(w.buttonText ? { buttonText: w.buttonText } : {}),
    ...(w.title ? { transactionInfo: { title: w.title } } : {}),
    isCancellable: true,
    showWalletUIs: WINDOW_SHOWN,
  };
}
