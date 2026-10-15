// ─────────────────────────────────────────────────────────────────────────────
// What the user's OWN wallet signs: approveAgent, approveBuilderFee, withdraw3.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner: "ใช้ Privy นั้นแหละ คุม" — the wallet the user logged in with (Privy's
// embedded wallet, or an injected one) controls the Perp account. It signs
// through the SHARED ethers signer WalletContext builds for every wallet type;
// signer.signTypedData already reaches Privy and injected wallets unchanged
// (code-wallet-money research: legacyTx only touches sendTransaction).
//
// Only these four actions are signed here, each one a wallet prompt:
//   sendAsset          the DEPOSIT step of a Relay withdrawal: the Perp
//                      account's own USDC to Relay's depository on HyperCore,
//                      which pays the user out on the chain they chose, in
//                      seconds, for cents. Every field of it comes from the
//                      live Relay quote step and is checked there (relayOut.js)
//                      before it reaches this file; nothing about it is fixed
//                      in our source, because Relay's depository is not.
//   approveAgent       once per Enable trading: authorises a short-lived key
//                      that can trade but cannot withdraw (agentStore.js)
//   approveBuilderFee  only when FlowFlow's builder fee is configured, and
//                      only while Hyperliquid does not already hold it
//   withdraw3          USDC out of the Perp account to the user's OWN address,
//                      which Hyperliquid sends on Arbitrum One through its
//                      native bridge, minus a $1 fee, in about 5 minutes
//                      (exchange-endpoint docs; another page says 3-4 min).
//                      That bridge is the deprecated Bridge2; whether it
//                      serves large withdrawals was not checked (critic_A).
//
// WHICH WINDOW. Owner (2026-09-22): "ต้องเซ็น Enable Trading ด้วยหรอวะ". For a
// PRIVY login, approveAgent and approveBuilderFee are signed by the embedded
// wallet with NO window (Privy's useSignTypedData, uiOptions.showWalletUIs
// false; signing.js typedSignerFromSilent), so Enable trading is invisible and
// happens by itself on the first trade (client.js). HL_SILENT_MASTER_ACTIONS is
// the whole list: withdraw3 is NEVER on it, and an injected wallet never signs
// silently, whatever it is handed. Key export is Privy's own modal and never
// passes through here.
//
// signatureChainId is the wallet's CURRENT chain (network.js — UNVERIFIED that
// Hyperliquid accepts every chain; the exact error is shown if it does not).
//
// WALLETCONNECT is refused with a plain message: the WalletConnect
// session is pinned to one chain (walletConnectProvider), and a mobile
// wallet behind it is not known to sign these domains. "Not supported yet".

import { isAddress as isViemAddress } from "viem";

import { browserTimers } from "../browser.js";
import { HL_USER_SIGNED_TYPES, signUserSigned, typedSignerFromEthers, typedSignerFromSilent } from "./signing.js";

export const HL_WITHDRAW_FEE_USDC = 1;
export const HL_WITHDRAW_CHAIN = "Arbitrum One";
export const HL_WITHDRAW_ETA_MINUTES = 5;
/** USDC on Hyperliquid carries 6 decimals; a finer amount is refused, never rounded. */
export const HL_USDC_DECIMALS = 6;

const lower = (a) => String(a).toLowerCase();
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The master actions a Privy embedded wallet may sign with no window: Enable trading's two, never withdraw3. */
export const HL_SILENT_MASTER_ACTIONS = Object.freeze(["approveAgent", "approveBuilderFee"]);

/** May this action be signed with no window by this wallet type? */
export function silentMasterAllowed(walletType, actionType) {
  return walletType === "privy" && HL_SILENT_MASTER_ACTIONS.includes(actionType);
}

/* ── no wallet call may hang forever ───────────────────────────────────────
   Owner, 2026-09-22: "กด Activate Wallet แล้วแม่งแบบ จอดำอะ" — a screen with
   nothing on it and nothing to press. A wallet that never answers (a Privy
   window that failed to render, an injected wallet whose tab was closed, an
   embedded wallet that never finished recovering) used to leave the sheet on
   "Confirm in your wallet…" for as long as the page was open. Every signature
   the perp path asks for is raced against this, and the loser is the signature:
   the request is DROPPED, never posted, so a late answer cannot move money. */

/** How long a wallet may take to answer a perp signature before we give up on it. */
export const HL_WALLET_PROMPT_TIMEOUT_MS = 60_000;

/** The error a dropped wallet call throws. Recognised by walletTimeout, not by its text. */
export class HlWalletTimeoutError extends Error {
  constructor(ms) {
    super(`Your wallet didn't answer in ${Math.round(ms / 1000)} seconds, so nothing was sent.`);
    this.name = "HlWalletTimeoutError";
    this.walletTimeout = true;
  }
}

/** Is this the timeout above (whatever wrapped it)? */
export function isWalletTimeout(e) {
  return !!(e && (e.walletTimeout === true || (e.cause && e.cause.walletTimeout === true)));
}

/**
 * Race a wallet promise against the timeout. The promise itself is not
 * cancellable — it is simply never read again.
 */
export function withWalletTimeout(promise, { ms = HL_WALLET_PROMPT_TIMEOUT_MS, timers = browserTimers } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  let id = null;
  const timeout = new Promise((_resolve, reject) => {
    id = timers.setTimeout(() => reject(new HlWalletTimeoutError(ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (id != null) timers.clearTimeout(id);
  });
}

/* ── a destination the user confirmed ──────────────────────────────────────
   Owner, 2026-09-22: "withdraw คือให้ใส่ เลข Wallet ได้ด้วยดิวะ" — money may
   leave to an address the user pasted. It is taken EXACTLY as typed: a
   mixed-case address must pass its EIP-55 checksum (a mistyped character
   changes it), an all-lowercase or all-uppercase one carries no checksum to
   fail, and nothing is ever silently re-cased or truncated. */

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** What each refusal means, in the words a confirm screen can print. */
export const DESTINATION_MESSAGE = Object.freeze({
  bad_address: "That isn't an EVM wallet address. It must start with 0x and have 40 characters after it.",
  bad_checksum: "That address fails its own checksum, so a character is wrong. Paste it again.",
  burn_address: "That address can never send the money back. Check it and paste it again.",
});

/**
 * A destination address exactly as the user gave it: { ok: true, address,
 * lower } or { ok: false, code, message }. Mixed case must pass EIP-55 (a
 * single mistyped character fails it); all-lowercase and all-uppercase carry no
 * checksum and are taken as given. Nothing is re-cased or shortened here — the
 * confirm screen shows what the user pasted.
 * @param {string} raw
 */
export function readDestinationAddress(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  const refuse = (code) => ({ ok: false, code, message: DESTINATION_MESSAGE[code] });
  if (!HEX40.test(s)) return refuse("bad_address");
  const body = s.slice(2);
  const cased = body === body.toUpperCase() ? `0x${body.toLowerCase()}` : s;
  if (!isViemAddress(cased, { strict: true })) return refuse("bad_checksum");
  if (/^0x0{40}$/i.test(s) || /^0x0{36}dead$/i.test(s)) return refuse("burn_address");
  return { ok: true, address: s, lower: lower(s) };
}

/** Can this wallet type sign for the Perp account? */
export function masterSupport(walletType) {
  if (walletType === "walletconnect") {
    return {
      ok: false,
      code: "walletconnect_unsupported",
      message: "Perp trading isn't supported for WalletConnect wallets yet. Log in with email or Google (Privy), or use a browser wallet.",
    };
  }
  return { ok: true };
}

function base(profile, signatureChainId) {
  if (!profile || typeof profile.hyperliquidChain !== "string") throw new Error("a network profile is required");
  if (typeof signatureChainId !== "string" || !/^0x[0-9a-f]+$/.test(signatureChainId)) throw new Error("signatureChainId must be lowercase hex");
  return { signatureChainId, hyperliquidChain: profile.hyperliquidChain };
}

/** { type, signatureChainId, hyperliquidChain, agentAddress, agentName, nonce } */
export function buildApproveAgentAction({ profile, signatureChainId, agentAddress, agentName, nonce }) {
  if (!isAddress(agentAddress)) throw new Error("approveAgent needs the agent's address");
  if (typeof agentName !== "string" || !agentName) throw new Error("approveAgent needs a name");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("approveAgent needs a nonce");
  return { type: "approveAgent", ...base(profile, signatureChainId), agentAddress: lower(agentAddress), agentName, nonce };
}

/** { type, signatureChainId, hyperliquidChain, maxFeeRate, builder, nonce } */
export function buildApproveBuilderFeeAction({ profile, signatureChainId, builder, maxFeeRate, nonce }) {
  if (!isAddress(builder)) throw new Error("approveBuilderFee needs the builder's address");
  if (typeof maxFeeRate !== "string" || !/^\d+(\.\d+)?%$/.test(maxFeeRate)) throw new Error("maxFeeRate is a percent string");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("approveBuilderFee needs a nonce");
  return { type: "approveBuilderFee", ...base(profile, signatureChainId), maxFeeRate, builder: lower(builder), nonce };
}

/**
 * { type, signatureChainId, hyperliquidChain, destination, sourceDex,
 * destinationDex, token, amount, fromSubAccount, nonce }
 *
 * Built ONLY from a Relay quote's deposit step, which relayOut.js has already
 * read and checked field by field. Nothing here guesses a value: a wrong
 * destination or a wrong token is money sent to the wrong place on a chain with
 * no way back.
 */
export function buildSendAssetAction({ profile, signatureChainId, destination, sourceDex, destinationDex, token, amount, fromSubAccount = "", nonce }) {
  if (!isAddress(destination)) throw new Error("sendAsset needs a destination address");
  if (typeof sourceDex !== "string" || typeof destinationDex !== "string") throw new Error("sendAsset needs both dex names");
  if (typeof token !== "string" || !token) throw new Error("sendAsset needs a token");
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) throw new Error("sendAsset amount is a decimal string");
  if (typeof fromSubAccount !== "string") throw new Error("sendAsset needs a fromSubAccount (empty string when it is not one)");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("sendAsset needs a nonce");
  return {
    type: "sendAsset", ...base(profile, signatureChainId), destination: lower(destination),
    sourceDex, destinationDex, token, amount, fromSubAccount, nonce,
  };
}

/** { type, signatureChainId, hyperliquidChain, destination, amount, time } */
export function buildWithdrawAction({ profile, signatureChainId, destination, amount, time }) {
  if (!isAddress(destination)) throw new Error("withdraw3 needs a destination address");
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) throw new Error("withdraw3 amount is a decimal string");
  if (!Number.isSafeInteger(time) || time < 0) throw new Error("withdraw3 needs a time");
  return { type: "withdraw3", ...base(profile, signatureChainId), destination: lower(destination), amount, time };
}

/**
 * A USDC amount as Hyperliquid's decimal string: "25.5". Null when it is not a
 * positive number or carries more than 6 decimals (refused, never rounded).
 */
export function formatUsdcAmount(x) {
  let s;
  if (typeof x === "string") s = x.trim();
  else if (typeof x === "number" && Number.isFinite(x)) s = x.toFixed(HL_USDC_DECIMALS + 2);
  else return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  let [int, frac = ""] = s.split(".");
  if (typeof x === "number") {
    /* A binary number is accepted when its 8-decimal form ends in "00". */
    if (frac.slice(HL_USDC_DECIMALS).replace(/0/g, "") !== "") return null;
    frac = frac.slice(0, HL_USDC_DECIMALS);
  }
  frac = frac.replace(/0+$/, "");
  if (frac.length > HL_USDC_DECIMALS) return null;
  int = int.replace(/^0+(?=\d)/, "");
  const out = frac ? `${int}.${frac}` : int;
  return Number(out) > 0 ? out : null;
}

/** What a withdrawal of this amount delivers. */
export function withdrawQuote(amount) {
  const n = Number(amount);
  return {
    amountUsdc: amount,
    feeUsdc: HL_WITHDRAW_FEE_USDC,
    receiveUsdc: Number.isFinite(n) ? Math.round((n - HL_WITHDRAW_FEE_USDC) * 1e6) / 1e6 : null,
    chain: HL_WITHDRAW_CHAIN,
    etaMinutes: HL_WITHDRAW_ETA_MINUTES,
  };
}

/** The wallet's current chain id: the caller's reading, or the signer's provider. Null when unknown. */
export async function resolveWalletChainId(signer, chainId = null) {
  if (Number.isSafeInteger(chainId) && chainId > 0) return chainId;
  try {
    const net = signer && signer.provider ? await signer.provider.getNetwork() : null;
    const id = net ? Number(net.chainId) : null;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Sign a master action with the user's wallet: one prompt, or none when the
 * wallet is Privy's, a silent signer is handed in and the action is on
 * HL_SILENT_MASTER_ACTIONS.
 * @param {{ signer: object, action: object, walletType?: string|null,
 *   silent?: { address: string, signTypedData: Function }|null }} a signer: an ethers v6 signer
 * @returns {Promise<{ signature: { r: string, s: string, v: number }, address: string, silent: boolean }>}
 */
export async function signMasterAction({ signer, action, walletType = null, silent = null, timeoutMs = HL_WALLET_PROMPT_TIMEOUT_MS, timers = browserTimers }) {
  const types = action && Object.prototype.hasOwnProperty.call(HL_USER_SIGNED_TYPES, action.type) ? HL_USER_SIGNED_TYPES[action.type] : null;
  if (!types) throw new Error(`${action && action.type} is not a master action`);
  const quiet = !!silent && silentMasterAllowed(walletType, action.type);
  const wallet = quiet ? typedSignerFromSilent(silent) : await typedSignerFromEthers(signer);
  const signature = await withWalletTimeout(signUserSigned({ wallet, action, types }), { ms: timeoutMs, timers });
  return { signature, address: wallet.address, silent: quiet };
}

/**
 * Sign typed data the way a third party gave it to us — the Relay withdrawal's
 * AUTHORIZE step, which is Relay's own EIP-712 message, not Hyperliquid's. It
 * is always a VISIBLE prompt (relayOut.js has checked that it names this
 * wallet, and the silent signer refuses anything that is not one of Enable
 * trading's two approvals in any case), and it returns the 65-byte signature
 * Relay's endpoint takes.
 * @returns {Promise<{ signature: string, address: string }>}
 */
export async function signTypedDataVisibly({ signer, typedData, timeoutMs = HL_WALLET_PROMPT_TIMEOUT_MS, timers = browserTimers }) {
  if (!typedData || typeof typedData !== "object") throw new Error("nothing to sign");
  const wallet = await typedSignerFromEthers(signer);
  const hex = await withWalletTimeout(wallet.signTypedData(typedData), { ms: timeoutMs, timers });
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(hex)) throw new Error("the wallet returned an unreadable signature");
  return { signature: hex, address: wallet.address };
}
