/* test-avax-signers' bundle entry: the Avax Wallet's signers, the REAL services/privy they read, and the REAL Privy
   bridge that registers into it — one module graph, so the bridge's registration is the one signers.js sees. Only
   @privy-io/react-auth is faked (scripts/test-avax-signers.mjs). Test-only; nothing in src/ imports this. */
export * from "../../src/avax/signers.js";
export { registerPrivyApi, registerPrivyLogin, getPrivySnapshot, privyAvalancheTxSender, privyAvalancheTypedSigner } from "../../src/services/privy.js";
export { default as PrivyBridge } from "../../src/components/privy/PrivyBridge.jsx";
