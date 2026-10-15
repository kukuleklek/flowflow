// ─────────────────────────────────────────────────────────────────────────────
// The Avax Wallet's fixed facts: the chain, the read endpoint, and every
// contract FlowFlow will read from or build a call for on Avalanche C-Chain.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ใช้ Aave V3 USDC บน Avalanche (5.70%)". The Avax Wallet is
// the SAME Privy embedded EOA as the Perp account, on chain 43114. Its vault is
// Aave V3 (not V4): Pool 0x794a…14aD, aAvaUSDC 0x625E…b4cD, native Circle USDC
// 0xB97E…8a6E.
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. ONLY VERIFIED ADDRESSES. Every address below was read on chain
//      (eth_getCode, and the reads named beside it) on 2026-10-15, block
//      97,586,280 – 97,591,655. Nothing here is copied from a UI or a guess.
//   2. LOWERCASE, FROZEN. Compare with sameAddress() from relay/depositAddress.js,
//      never with ===, and never mutate these objects at run time.
//   3. Nothing reads the env and nothing runs at import time, so the browser,
//      the server and the node tests see the same constants.
//
// Sources: plan-avax/R-aave.md §2 (Aave V3 rows), R-swap.md §3 + Verification
// (whitelist, Relay contracts from live GET /chains), R-relay.md §3.4.

export const AVAX_CHAIN_ID = 43114;
/** What eth_chainId answers on this chain. */
export const AVAX_CHAIN_ID_HEX = "0xa86a";
/** The chain's name as the customer reads it (Avax cards may name it). */
export const AVAX_CHAIN_NAME = "Avalanche";

/* Public read endpoint. CORS echoes our origin (checked from
   https://flowflow-alpha.vercel.app, 2026-10-15), JSON-RPC batches answer.
   🔴 PrivyMount's Avalanche chain must use this SAME string (after gate). */
export const AVAX_RPC = "https://api.avax.network/ext/bc/C/rpc";

export const SNOWTRACE = "https://snowtrace.io";
export const snowtraceTx = (hash) => `${SNOWTRACE}/tx/${hash}`;
export const snowtraceAddress = (address) => `${SNOWTRACE}/address/${address}`;

/** Native AVAX, the way Relay and the whitelist name it. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
export const AVAX_DECIMALS = 18;
export const WEI_PER_AVAX = 10n ** 18n;
export const GWEI = 1000000000n;

/** Native Circle USDC (NOT USDC.e 0xa7d7…c664). name "USD Coin", version "2", 6 dp. */
export const USDC = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e";
export const USDC_DECIMALS = 6;
/** EIP-2612 / EIP-3009 domain of that USDC (R-aave §6A: separator matches on chain). */
export const USDC_EIP712_DOMAIN = Object.freeze({ name: "USD Coin", version: "2", chainId: AVAX_CHAIN_ID, verifyingContract: USDC });

/* AAVE V3, "Avalanche Aave Market". pool == PoolAddressesProvider.getPool();
   POOL_REVISION() == 11 (custom-error reverts, virtual accounting);
   aUsdc == Pool.getReserveData(USDC).aTokenAddress, UNDERLYING == USDC,
   POOL() == pool, decimals 6. */
export const AAVE_V3 = Object.freeze({
  poolAddressesProvider: "0xa97684ead0e402dc232d5a977953df7ecbab3cdb",
  pool: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
  poolDataProvider: "0x243aa95cac2a25651eda86e80bee66114413c43b",
  aUsdc: "0x625e7708f30ca75bfd92586e17077590c60eb4cd",
  variableDebtUsdc: "0xfccf3cabbe80101232d343252614b6a3ee81c989",
  marketId: "Avalanche Aave Market",
  poolRevision: 11,
});

/** Multicall3 (3,808 bytes of code on 43114; getEthBalance == eth_getBalance, checked). */
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

/* RELAY on 43114, from live GET /chains (2026-10-15). On Mon 2026-10-26 Relay
   moves to v3.2; approvals do not carry over, so BOTH pairs stay allowed past
   that date (plan §3.1 pin). */
export const RELAY_AVAX = Object.freeze({
  v3: Object.freeze({
    erc20Router: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
    approvalProxy: "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be",
  }),
  "v3.2": Object.freeze({
    erc20Router: "0x0729e2a4716d9f7dd17858d5d504426d228697f7",
    approvalProxy: "0x5567954cd026cebfe486062cb75848e0f1c12e58",
  }),
  /** protocol.v2.depository on 43114 (the paid exit's deposit target). */
  depository: "0x4cd00e387622c35bddb9b4c962c136462338bc31",
  relayReceiver: "0xa5f565650890fba1824ee0f21ebbbf660a179934",
  /** solverAddresses (an EOA: no code). The only address a swap's fee cleanup may pay. */
  solvers: Object.freeze(["0xf70da97812cb96acdf810712aa562db8dfa3dbef"]),
  /** 0x AllowanceHolder (1,009 bytes of code), the DEX spender inside a 0x-routed swap. */
  allowanceHolder: "0x0000000000001ff3684f28c67538d4d072c22734",
});

/** Both ApprovalProxy versions: the only spenders a swap approve may name. */
export const RELAY_APPROVAL_PROXIES = Object.freeze([RELAY_AVAX.v3.approvalProxy, RELAY_AVAX["v3.2"].approvalProxy]);

/** Relay's depository on HyperCore (chain 1337), the pin for every own-move sendAsset.
 *  Not an Avalanche contract: the sendAsset destination in every live 1337 → 43114 quote
 *  captured 2026-10-15 (plan-avax/relay-raw). HyperCore has no eth_getCode to check. */
export const RELAY_HL_DEPOSITORY = "0x66cf0aace1b4e562593bec10ec7868fba9932224";

/** Chainlink AVAX/USD on 43114 (9,571 bytes of code; read $9.6389 on 2026-10-15). Reference only. */
export const CHAINLINK_AVAX_USD = "0x0a77230d17318075983913bc2145db16c7366156";

/** When and where the pins above were last checked. */
export const VERIFIED_AT = Object.freeze({ on: "2026-10-15", blocks: [97586280, 97591655] });
