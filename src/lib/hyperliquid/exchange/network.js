// ─────────────────────────────────────────────────────────────────────────────
// Which Hyperliquid the trading layer talks to — derived from ONE constant.
// ─────────────────────────────────────────────────────────────────────────────
//
// HL_NETWORK lives in ../config.js (the read-only market layer's switch). Every
// value that must change together when it flips is derived here, in one place:
//
//   info / exchange / ws URLs
//   the phantom-agent source      "a" mainnet, "b" testnet (L1 signatures)
//   hyperliquidChain              "Mainnet" / "Testnet" (user-signed actions)
//   the storage namespace         agent keys and nonces never cross networks
//
// Asset indexes differ between the networks (mainnet 0 is BTC, testnet 0 is
// SOL), so nothing here picks a network at runtime.
//
// signatureChainId (user-signed actions: approveAgent, approveBuilderFee,
// withdraw3) is the EIP-712 domain chainId the MASTER wallet signs with. We use
// the wallet's CURRENT chain so no chain switch is
// ever needed: MetaMask refuses typed data whose domain chainId differs from
// the active chain. The official SDK
// comment says it "can be any chain" and the docs' examples use 0xa4b1 and
// 0x66eee, but no official page says every chain is accepted: UNVERIFIED (spike S1).
// If Hyperliquid rejects it, the exact Hyperliquid error text is shown to the
// user (orders.js mapHlError passes unknown text through verbatim), and the
// fix is to set HL_SIGNATURE_CHAIN_ID below to a fixed chain such as "0xa4b1"
// — at the price of a chain switch for injected wallets.

import { HL_NETWORK, hlEndpoints } from "../config.js";

export { HL_NETWORK };

export const HL_EXCHANGE_URLS = Object.freeze({
  mainnet: "https://api.hyperliquid.xyz/exchange",
  testnet: "https://api.hyperliquid-testnet.xyz/exchange",
});

/**
 * Everything that follows from the network choice.
 * @param {string} [network] default: HL_NETWORK
 * @returns {Readonly<{ network: string, isMainnet: boolean, infoUrl: string,
 *   exchangeUrl: string, wsUrl: string, source: string, hyperliquidChain: string,
 *   storagePrefix: string }>}
 */
export function hlNetworkProfile(network = HL_NETWORK) {
  const e = hlEndpoints(network);
  const isMainnet = network === "mainnet";
  return Object.freeze({
    network,
    isMainnet,
    infoUrl: e.info,
    exchangeUrl: HL_EXCHANGE_URLS[network],
    wsUrl: e.ws,
    source: isMainnet ? "a" : "b",
    hyperliquidChain: isMainnet ? "Mainnet" : "Testnet",
    storagePrefix: `flowflow.hl.${network}`,
  });
}

/** The profile of the configured network. */
export const HL_TRADE_NETWORK = hlNetworkProfile();

/** "wallet" = sign user actions on the wallet's current chain. Or a fixed hex id.
 *  FlowFlow keeps "wallet" and parks the Privy wallet on Arbitrum (PrivyProvider defaultChain), so the
 *  domain chainId is 0xa4b1, the chain the official docs' examples use, and never mismatches the wallet. */
export const HL_SIGNATURE_CHAIN_ID = "wallet";

/**
 * The signatureChainId for a user-signed action, as lowercase hex ("0xa4b1").
 * Null when the wallet's chain is unknown or the setting is unreadable — never a
 * guessed chain, because the wallet would refuse (or sign the wrong domain).
 * @param {number|null} walletChainId
 * @param {string} [mode]
 */
export function signatureChainIdFor(walletChainId, mode = HL_SIGNATURE_CHAIN_ID) {
  if (mode === "wallet") {
    return Number.isSafeInteger(walletChainId) && walletChainId > 0 ? `0x${walletChainId.toString(16)}` : null;
  }
  if (typeof mode === "string" && /^0x[0-9a-f]+$/i.test(mode) && Number(mode) > 0) return mode.toLowerCase();
  return null;
}
