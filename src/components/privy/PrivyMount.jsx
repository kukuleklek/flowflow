import { PrivyProvider } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { PRIVY_APP_ID, PRIVY_CHAIN_ID } from "../../services/privy.js";
import { AVAX_CHAIN_ID, AVAX_CHAIN_NAME, AVAX_RPC, SNOWTRACE } from "../../lib/avax/config.js";
import PrivyBridge from "./PrivyBridge.jsx";
import PrivyHeadless from "./PrivyHeadless.jsx";

/**
 * Arbitrum: the chain the embedded wallet is parked on. Hyperliquid signs user
 * actions for the wallet's current chain, so this is what makes signatureChainId
 * 0xa4b1. It is also where the first-deposit plan's last hop happens.
 */
export const arbitrumChain = defineChain({
  id: PRIVY_CHAIN_ID,
  name: "Arbitrum One",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://arb1.arbitrum.io/rpc"] },
    public: { http: ["https://arb1.arbitrum.io/rpc"] },
  },
  blockExplorers: { default: { name: "Arbiscan", url: "https://arbiscan.io" } },
});

/**
 * Avalanche C-Chain: where the Avax Wallet (the owner's "Spot Account") lives —
 * the SAME embedded EOA, on 43114. Listed so Privy can send an Avalanche
 * transaction when one names chainId 43114 (src/avax/closedTx.js builds every
 * one): Privy builds its own client for the chain the transaction names, so the
 * wallet is never switched to it and stays parked on Arbitrum, the default
 * below. 🔴 Nothing in this app calls switchChain(43114): the Main Account's
 * signatures keep signatureChainId 0xa4b1 (exchange/client.js masterGate).
 *
 * The RPC is lib/avax/config.js's AVAX_RPC, the one the read layer already uses
 * (CORS checked from our origin, 2026-10-15) — imported, not written out, so the
 * two cannot drift (scripts/test-avax-signers.mjs).
 */
export const avalancheChain = defineChain({
  id: AVAX_CHAIN_ID,
  name: AVAX_CHAIN_NAME,
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: {
    default: { http: [AVAX_RPC] },
    public: { http: [AVAX_RPC] },
  },
  blockExplorers: { default: { name: "Snowtrace", url: SNOWTRACE } },
});

/** Privy's chain settings: both chains, Arbitrum first and the default, our own RPC for Avalanche. */
export const PRIVY_CHAINS = Object.freeze({
  defaultChain: arbitrumChain,
  supportedChains: [arbitrumChain, avalancheChain],
  rpcConfig: { rpcUrls: { [AVAX_CHAIN_ID]: AVAX_RPC } },
});

/**
 * PrivyMount — the whole `@privy-io/react-auth` dependency lives behind this
 * module, which <PrivyGate> React.lazy's. It renders no app content: the bridge
 * and the headless reporter return null, and FlowFlow draws its own login card.
 *
 * Embedded-wallet windows are pinned ON here (2026-09-30): otherwise
 * the Privy dashboard decides, and one click there would silently remove every
 * money confirmation. The only no-window signatures are per call and named
 * (PrivyBridge's silent pair). priceDisplay asks for the token, not a fiat figure
 * Privy prices itself, which FlowFlow cannot check.
 */
export default function PrivyMount() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["google", "email", "passkey"],
        defaultChain: PRIVY_CHAINS.defaultChain,
        supportedChains: PRIVY_CHAINS.supportedChains,
        rpcConfig: PRIVY_CHAINS.rpcConfig,
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          showWalletUIs: true,
          priceDisplay: { primary: "native-token", secondary: null },
        },
        appearance: {
          theme: "light",
          accentColor: "#09090b",
          logo: "/flowflow-mark.svg",
        },
      }}
    >
      <PrivyBridge />
      <PrivyHeadless />
    </PrivyProvider>
  );
}
