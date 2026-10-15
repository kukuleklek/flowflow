// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid signatures — the ONLY file that imports the signing SDK.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THE SDK, AND ONLY ITS /signing SUBPATH. @nktkas/hyperliquid (MIT, pinned
// exactly at 0.33.3; linked from Hyperliquid's own docs and used by Privy's
// Hyperliquid recipes) does the one part that is easy to get subtly wrong: the
// msgpack encoding of an L1 action (key order, int64 widening, dropped
// undefined keys) and the keccak connectionId the phantom agent signs. Its
// /signing entry pulls in @noble/hashes and a vendored msgpack encoder — a few
// KB — and nothing of the valibot schemas behind its api/ modules, so the EIP-712
// type lists below are copied from the official Python SDK (signing.py)
// instead of imported. scripts/test-hl-exchange-signing.mjs proves the result
// byte for byte against the official Python and Rust SDK test vectors.
//
// TWO KINDS OF SIGNER, never mixed:
//   the TRADING KEY (agent): a viem local account generated on this device
//     (agentStore.js). It signs every L1 action — order, cancel, leverage — with
//     the fixed phantom-agent domain (chainId 1337), silently.
//   the MASTER wallet: the user's own wallet through the shared ethers signer
//     WalletContext builds (Privy or injected). It signs only user-signed
//     actions (approveAgent, approveBuilderFee, withdraw3), on the wallet's
//     current chain (network.js). An L1 payload is refused before it ever
//     reaches the master wallet: on its own chain the wallet would reject domain 1337,
//     and a blind hash is not something the user should be asked to sign.
//     For a Privy login the SAME wallet can also sign with no window
//     (typedSignerFromSilent, Privy's useSignTypedData with showWalletUIs
//     false); master.js allows that for Enable trading's two approvals only.
//     It is a master wallet too, so signL1 refuses it just the same.
//
// This file loads only inside the lazy perp chunk (see index.js).

import { createL1ActionHash, signL1Action, signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { privateKeyToAccount } from "viem/accounts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The phantom-agent domain every L1 action is signed under. Never the wallet's chain. */
export const HL_L1_DOMAIN = Object.freeze({ name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO_ADDRESS });

const field = (name, type) => Object.freeze({ name, type });

/**
 * EIP-712 types of the user-signed actions FlowFlow sends, keyed by action type.
 * Field ORDER is part of the typehash. Source: hyperliquid-python-sdk signing.py
 * (sign_agent, sign_approve_builder_fee, WITHDRAW_SIGN_TYPES).
 */
export const HL_USER_SIGNED_TYPES = Object.freeze({
  /* sendAsset moves the Perp account's own USDC to another Hyperliquid account.
     FlowFlow signs it for ONE purpose: the deposit step of a Relay withdrawal,
     whose depository address and every other field come from the live Relay
     quote (relayOut.js is the only gate that may build one). Field order is
     part of the typehash; this list is Hyperliquid's own (exchange endpoint
     docs, sendAsset) and is checked against the quote step before signing. */
  sendAsset: Object.freeze({
    "HyperliquidTransaction:SendAsset": Object.freeze([
      field("hyperliquidChain", "string"), field("destination", "string"), field("sourceDex", "string"),
      field("destinationDex", "string"), field("token", "string"), field("amount", "string"),
      field("fromSubAccount", "string"), field("nonce", "uint64"),
    ]),
  }),
  approveAgent: Object.freeze({
    "HyperliquidTransaction:ApproveAgent": Object.freeze([
      field("hyperliquidChain", "string"), field("agentAddress", "address"), field("agentName", "string"), field("nonce", "uint64"),
    ]),
  }),
  approveBuilderFee: Object.freeze({
    "HyperliquidTransaction:ApproveBuilderFee": Object.freeze([
      field("hyperliquidChain", "string"), field("maxFeeRate", "string"), field("builder", "address"), field("nonce", "uint64"),
    ]),
  }),
  withdraw3: Object.freeze({
    "HyperliquidTransaction:Withdraw": Object.freeze([
      field("hyperliquidChain", "string"), field("destination", "string"), field("amount", "string"), field("time", "uint64"),
    ]),
  }),
});

const MASTER_WALLET = Symbol("hl.masterWallet");

/* r and s as 32-byte lowercase hex, v as 27 or 28 (what /exchange expects). */
function normalizeSignature(sig) {
  const hex32 = (h) => `0x${String(h).replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  const v = Number(sig && sig.v);
  if (!sig || !(v === 27 || v === 28)) throw new Error("the wallet returned an unreadable signature");
  return { r: hex32(sig.r), s: hex32(sig.s), v };
}

/* The SDK wraps whatever the wallet threw in its own generic error ("Failed to
   sign the typed data using the wallet") and keeps the original as the cause.
   The original is what matters: a declined popup (code 4001, or ethers'
   ACTION_REJECTED) and MetaMask's chain-mismatch text live only there. */
async function unwrapWalletError(run) {
  try {
    return await run();
  } catch (e) {
    if (e && e.name === "AbstractWalletError" && e.cause) throw e.cause;
    throw e;
  }
}

/**
 * keccak(msgpack(action) + nonce + vault flag [+ expiresAfter]): the
 * connectionId the phantom agent signs.
 * @returns {string} 0x-prefixed 32-byte hex
 */
export function hlActionHash({ action, nonce, vaultAddress, expiresAfter }) {
  return createL1ActionHash({ action, nonce, vaultAddress, expiresAfter });
}

/**
 * Sign an L1 action (order, cancel, updateLeverage, ...) with the TRADING KEY.
 * @param {{ wallet: object, action: object, nonce: number, profile: object,
 *   vaultAddress?: string, expiresAfter?: number }} a
 * @returns {Promise<{ r: string, s: string, v: number }>}
 */
export async function signL1({ wallet, action, nonce, profile, vaultAddress, expiresAfter }) {
  if (!wallet || wallet[MASTER_WALLET]) {
    throw new Error("L1 actions are signed by the trading key, never by the master wallet");
  }
  if (!profile || typeof profile.isMainnet !== "boolean") throw new Error("signL1 needs a network profile");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("signL1 needs a whole-number nonce");
  const sig = await unwrapWalletError(() => signL1Action({ wallet, action, nonce, isTestnet: !profile.isMainnet, vaultAddress, expiresAfter }));
  return normalizeSignature(sig);
}

/**
 * Sign a user-signed action. The domain chainId is the action's own
 * signatureChainId; the message is the action's typed fields only.
 * @returns {Promise<{ r: string, s: string, v: number }>}
 */
export async function signUserSigned({ wallet, action, types }) {
  if (!action || typeof action.signatureChainId !== "string") throw new Error("a user-signed action needs its signatureChainId");
  const sig = await unwrapWalletError(() => signUserSignedAction({ wallet, action, types }));
  return normalizeSignature(sig);
}

/**
 * Wrap an ethers v6 signer (WalletContext's shared signer) as a typed-data
 * signer. Marked as the MASTER wallet, so signL1 refuses it.
 * @returns {Promise<{ address: string, signTypedData: Function }>}
 */
export async function typedSignerFromEthers(signer) {
  if (!signer || typeof signer.signTypedData !== "function" || typeof signer.getAddress !== "function") {
    throw new Error("no wallet signer");
  }
  const address = String(await signer.getAddress()).toLowerCase();
  const wrapped = {
    address,
    /* ethers derives the domain type itself and refuses a second copy of it. */
    signTypedData({ domain, types, message }) {
      const own = { ...types };
      delete own.EIP712Domain;
      return signer.signTypedData(domain, own, message);
    },
  };
  Object.defineProperty(wrapped, MASTER_WALLET, { value: true });
  return Object.freeze(wrapped);
}

/**
 * Wrap the Privy embedded wallet's NO-WINDOW typed-data signer (services/privy
 * privySilentTypedSigner: { address, signTypedData(typedData) -> hex }) as a
 * typed-data signer. Marked as the MASTER wallet, so signL1 refuses it. The
 * typed data reaches it whole (EIP712Domain in types, primaryType named), as
 * eth_signTypedData_v4 carries it.
 * @returns {{ address: string, signTypedData: Function }}
 */
export function typedSignerFromSilent(silent) {
  if (!silent || typeof silent.signTypedData !== "function" || typeof silent.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(silent.address)) {
    throw new Error("no silent signer");
  }
  const wrapped = {
    address: silent.address.toLowerCase(),
    async signTypedData({ domain, types, primaryType, message }) {
      const out = await silent.signTypedData({ domain, types, primaryType, message });
      return out && typeof out === "object" && typeof out.signature === "string" ? out.signature : out;
    },
  };
  Object.defineProperty(wrapped, MASTER_WALLET, { value: true });
  return Object.freeze(wrapped);
}

/** The trading key as a viem local account. */
export function agentAccountFromKey(privateKey) {
  return privateKeyToAccount(privateKey);
}
