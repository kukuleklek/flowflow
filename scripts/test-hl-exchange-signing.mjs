/**
 * test-hl-exchange-signing — THE SIGNATURES HYPERLIQUID WILL CHECK, BYTE FOR BYTE.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner: "ใช้ Privy นั้นแหละ คุม ทำเลยพวก ให้แม่งเทรดได้จริงเลย" — the user's own
 * wallet controls the Perp account, and it must REALLY trade.
 *
 * A wrong signature does not fail cleanly on Hyperliquid: it recovers some other
 * address and comes back as "User or API Wallet 0x... does not exist" or "Must
 * deposit before performing actions" (official Signing page). So the signing
 * layer (src/lib/hyperliquid/exchange/) is pinned against vectors that
 * were published by someone else, from fixed PUBLIC test keys, fully offline:
 *
 *   A. the network constant: one switch drives URLs, the phantom-agent source,
 *      hyperliquidChain and the storage namespace; signatureChainId follows the
 *      wallet's current chain (0xa86a on Avalanche), in exactly one place;
 *   B. L1 (phantom agent) vectors from the OFFICIAL Python SDK
 *      (hyperliquid-python-sdk tests/signing_test.py, last changed 2026-06-04,
 *      commit 2fdb18f951): the production connectionId, a Gtc order, the same
 *      with a cloid, a market stop-loss trigger, a uint64 field, a vault, and
 *      scheduleCancel with and without a time — each on mainnet AND testnet;
 *   C. user-signed vectors: Withdraw and UsdSend from the Python SDK, the same
 *      two from the official Rust SDK (hyperliquid-rust-sdk
 *      src/signature/create_signature.rs), and UsdSend from the TypeScript SDK
 *      we depend on (@nktkas/hyperliquid v0.33.3 tests/signing/mod.test.ts);
 *   D. approveAgent and approveBuilderFee. NO official SDK publishes a vector for
 *      either (Python, Rust and TypeScript test suites all checked 2026-09-22).
 *      They are pinned three ways instead: against a digest assembled BY HAND
 *      from the Rust SDK's own struct-hash formula (golden values computed
 *      before the implementation existed), against viem's independent EIP-712
 *      signer, and by recovering the signer's address;
 *   E. the PRODUCTION path: an ethers v6 BrowserProvider over an EIP-1193
 *      provider that sits on Avalanche (chain 43114) — the exact shape WalletContext
 *      hands us for Privy and injected wallets. The wallet receives
 *      eth_signTypedData_v4 with domain chainId 43114 (so MetaMask's "must match
 *      the active chainId" check passes) and the result recovers to the master.
 *
 * Nothing here talks to the network: global fetch is replaced by a thrower for
 * the whole file.
 *
 * Run: node --test scripts/test-hl-exchange-signing.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EX = (f) => pathToFileURL(path.join(ROOT, "src/lib/hyperliquid/exchange", f)).href;

globalThis.fetch = () => { throw new Error("test-hl-exchange-signing: a real network call was attempted"); };

/* The official SDKs' published test keys. They hold nothing and never will. */
const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const RUST_KEY = "0xe908f86dbb4d55ac876378565aafeabc187f6690f046459397b17d9b9a19688e";
const NK_KEY = "0x822e9959e022b78423eb653a62ea0020cd283e71a2a8133a6ff2aeffaf373cff";

let N, S, M, O, viem, viemAccounts, ethers;
before(async () => {
  N = await import(EX("network.js"));
  S = await import(EX("signing.js"));
  M = await import(EX("master.js"));
  O = await import(EX("orders.js"));
  viem = await import("viem");
  viemAccounts = await import("viem/accounts");
  ethers = await import("ethers");
});

/* The Python SDK prints r and s with to_hex(int), which drops leading zeros.
   Compare as numbers so a 63-digit published value still has to be exact. */
function sameSig(got, want, label) {
  assert.equal(BigInt(got.r), BigInt(want.r), `${label}: r`);
  assert.equal(BigInt(got.s), BigInt(want.s), `${label}: s`);
  assert.equal(Number(got.v), want.v, `${label}: v`);
  assert.match(got.r, /^0x[0-9a-f]{64}$/, `${label}: r is 32 bytes of lowercase hex on the wire`);
  assert.match(got.s, /^0x[0-9a-f]{64}$/, `${label}: s is 32 bytes of lowercase hex on the wire`);
}
const fromHex65 = (h) => ({ r: `0x${h.slice(2, 66)}`, s: `0x${h.slice(66, 130)}`, v: parseInt(h.slice(130, 132), 16) });

const MAINNET = () => N.hlNetworkProfile("mainnet");
const TESTNET = () => N.hlNetworkProfile("testnet");

/* ════════════════════════════════════════════════════════════════════════════
   A. THE NETWORK CONSTANT
   ════════════════════════════════════════════════════════════════════════════ */

test("A1) one constant drives the network: mainnet everywhere, and testnet is one flip away with every derived value flipped with it", () => {
  const cfg = N;
  assert.equal(cfg.HL_NETWORK, "mainnet");
  const m = MAINNET();
  assert.deepEqual(
    { ...m },
    {
      network: "mainnet", isMainnet: true,
      infoUrl: "https://api.hyperliquid.xyz/info",
      exchangeUrl: "https://api.hyperliquid.xyz/exchange",
      wsUrl: "wss://api.hyperliquid.xyz/ws",
      source: "a", hyperliquidChain: "Mainnet",
      storagePrefix: "flowflow.hl.mainnet",
    },
  );
  const t = TESTNET();
  assert.equal(t.exchangeUrl, "https://api.hyperliquid-testnet.xyz/exchange");
  assert.equal(t.infoUrl, "https://api.hyperliquid-testnet.xyz/info");
  assert.equal(t.source, "b");
  assert.equal(t.hyperliquidChain, "Testnet");
  assert.equal(t.storagePrefix, "flowflow.hl.testnet");
  assert.deepEqual({ ...N.HL_TRADE_NETWORK }, { ...m }, "the default profile is the configured network");
  assert.ok(Object.isFrozen(m));
  assert.throws(() => N.hlNetworkProfile("devnet"), /unknown Hyperliquid network/);
  for (const p of [m, t]) {
    assert.equal(new URL(p.exchangeUrl).host, new URL(p.infoUrl).host, "info and exchange never point at different networks");
  }
});

test("A2) signatureChainId is the wallet's CURRENT chain (0xa86a on Avalanche) — one constant, so a rejection by Hyperliquid is a one-line change", () => {
  assert.equal(N.HL_SIGNATURE_CHAIN_ID, "wallet");
  assert.equal(N.signatureChainIdFor(43114), "0xa86a");
  assert.equal(N.signatureChainIdFor(42161), "0xa4b1");
  assert.equal(N.signatureChainIdFor(1), "0x1");
  assert.equal(N.signatureChainIdFor(null), null, "an unknown chain is unknown, never guessed");
  assert.equal(N.signatureChainIdFor(0), null);
  assert.equal(N.signatureChainIdFor(1.5), null);
  assert.equal(N.signatureChainIdFor(43114, "0xA4B1"), "0xa4b1", "a fixed override is used as given, lowercased");
  assert.equal(N.signatureChainIdFor(43114, "arbitrum"), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   B. L1 ACTIONS — official Python SDK vectors (tests/signing_test.py)
   ════════════════════════════════════════════════════════════════════════════ */

test("B1) test_phantom_agent_creation_matches_production: the connectionId of a real ETH IOC order", () => {
  const wire = O.buildOrderWire({
    asset: 4, isBuy: true,
    px: O.roundHlOrderPx(1670.1, 4), sz: O.roundHlSize(0.0147, 4),
    reduceOnly: false, tif: "Ioc",
  });
  assert.deepEqual(wire, { a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } });
  const action = O.buildOrderAction({ orders: [wire] });
  assert.deepEqual(Object.keys(action), ["type", "orders", "grouping"], "msgpack key order is part of the hash");
  assert.equal(
    S.hlActionHash({ action, nonce: 1677777606040 }),
    "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908",
  );
});

const pyOrder = (extra = {}) => O.buildOrderAction({
  orders: [O.buildOrderWire({ asset: 1, isBuy: true, px: O.hlDecimalString(100), sz: O.hlDecimalString(100), reduceOnly: false, tif: "Gtc", ...extra })],
});

test("B2) test_l1_action_signing_order_matches: an agent key signs a Gtc order, mainnet and testnet", async () => {
  const agent = S.agentAccountFromKey(PY_KEY);
  const action = pyOrder();
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: MAINNET() }),
    { r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28 }, "mainnet");
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: TESTNET() }),
    { r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27 }, "testnet");
});

test("B3) test_l1_action_signing_order_with_cloid_matches: the cloid rides as the order's last key", async () => {
  const agent = S.agentAccountFromKey(PY_KEY);
  const action = pyOrder({ cloid: "0x00000000000000000000000000000001" });
  assert.deepEqual(Object.keys(action.orders[0]), ["a", "b", "p", "s", "r", "t", "c"]);
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: MAINNET() }),
    { r: "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3", s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da", v: 27 }, "mainnet");
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: TESTNET() }),
    { r: "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d", s: "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988", v: 28 }, "testnet");
});

test("B4) test_l1_action_signing_tpsl_order_matches: a market stop-loss trigger, keys isMarket, triggerPx, tpsl in that order", async () => {
  const agent = S.agentAccountFromKey(PY_KEY);
  const action = O.buildOrderAction({
    orders: [O.buildOrderWire({
      asset: 1, isBuy: true, px: "100", sz: "100", reduceOnly: false,
      trigger: { isMarket: true, triggerPx: O.hlDecimalString(103), tpsl: "sl" },
    })],
  });
  assert.deepEqual(Object.keys(action.orders[0].t.trigger), ["isMarket", "triggerPx", "tpsl"]);
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: MAINNET() }),
    { r: "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9", s: "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405", v: 27 }, "mainnet");
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: TESTNET() }),
    { r: "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4", s: "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac", v: 28 }, "testnet");
});

test("B5) test_l1_action_signing_matches: an integer past 2^32 is packed as uint64 (oids already are ~7.7e10)", async () => {
  const agent = S.agentAccountFromKey(PY_KEY);
  const action = { type: "dummy", num: 100000000000 };
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: MAINNET() }),
    { r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27 }, "mainnet");
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: TESTNET() }),
    { r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28 }, "testnet");
});

test("B6) test_l1_action_signing_matches_with_vault: the vault marker is folded into the hash", async () => {
  const agent = S.agentAccountFromKey(PY_KEY);
  const action = { type: "dummy", num: 100000000000 };
  const vaultAddress = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: MAINNET(), vaultAddress }),
    { r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239", s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", v: 28 }, "mainnet");
  sameSig(await S.signL1({ wallet: agent, action, nonce: 0, profile: TESTNET(), vaultAddress }),
    { r: "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b", s: "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60", v: 27 }, "testnet");
});

test("B7) test_schedule_cancel_action: with and without a time", async () => {
  const agent = S.agentAccountFromKey(PY_KEY);
  sameSig(await S.signL1({ wallet: agent, action: { type: "scheduleCancel" }, nonce: 0, profile: MAINNET() }),
    { r: "0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9", s: "0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0", v: 27 }, "no time, mainnet");
  sameSig(await S.signL1({ wallet: agent, action: { type: "scheduleCancel", time: 123456789 }, nonce: 0, profile: TESTNET() }),
    { r: "0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc", s: "0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678", v: 27 }, "with time, testnet");
});

test("B8) the L1 domain is the fixed phantom-agent domain: Exchange / 1 / chainId 1337 / zero address — never the wallet's chain", () => {
  assert.deepEqual({ ...S.HL_L1_DOMAIN }, {
    name: "Exchange", version: "1", chainId: 1337,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   C. USER-SIGNED ACTIONS — Python, Rust and TypeScript SDK vectors
   ════════════════════════════════════════════════════════════════════════════ */

const USD_SEND_TYPES = {
  "HyperliquidTransaction:UsdSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
};

test("C1) the Withdraw type list is the official one, field for field and in order (the order is in the typehash)", () => {
  assert.deepEqual(S.HL_USER_SIGNED_TYPES.withdraw3, {
    "HyperliquidTransaction:Withdraw": [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
  });
  assert.deepEqual(S.HL_USER_SIGNED_TYPES.approveAgent, {
    "HyperliquidTransaction:ApproveAgent": [
      { name: "hyperliquidChain", type: "string" },
      { name: "agentAddress", type: "address" },
      { name: "agentName", type: "string" },
      { name: "nonce", type: "uint64" },
    ],
  });
  assert.deepEqual(S.HL_USER_SIGNED_TYPES.approveBuilderFee, {
    "HyperliquidTransaction:ApproveBuilderFee": [
      { name: "hyperliquidChain", type: "string" },
      { name: "maxFeeRate", type: "string" },
      { name: "builder", type: "address" },
      { name: "nonce", type: "uint64" },
    ],
  });
});

test("C2) Python test_sign_withdraw_from_bridge_action, through OUR withdraw3 builder and an ethers v6 signer", async () => {
  const wallet = new ethers.Wallet(PY_KEY);
  const action = M.buildWithdrawAction({
    profile: TESTNET(), signatureChainId: "0x66eee",
    destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423,
  });
  assert.deepEqual(action, {
    type: "withdraw3", signatureChainId: "0x66eee", hyperliquidChain: "Testnet",
    destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423,
  });
  const { signature } = await M.signMasterAction({ signer: wallet, action });
  sameSig(signature, { r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9", s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881", v: 28 }, "withdraw");
});

test("C3) Python test_sign_usd_transfer_action, through the generic user-signed path", async () => {
  const typed = await S.typedSignerFromEthers(new ethers.Wallet(PY_KEY));
  const action = {
    type: "usdSend", signatureChainId: "0x66eee", hyperliquidChain: "Testnet",
    destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423,
  };
  sameSig(await S.signUserSigned({ wallet: typed, action, types: USD_SEND_TYPES }),
    { r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073", s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7", v: 27 }, "usdSend");
});

test("C4) Rust SDK test_sign_withdraw_from_bridge_action and test_sign_usd_transfer_action (a checksummed destination STRING, chain 421614)", async () => {
  const wallet = new ethers.Wallet(RUST_KEY);
  /* Built by hand: the Rust vector signs the CHECKSUMMED string, and our builder
     lowercases every address (official Signing page), so it cannot make it. */
  const withdraw = { type: "withdraw3", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", destination: "0x0D1d9635D0640821d15e323ac8AdADfA9c111414", amount: "1", time: 1690393044548 };
  const w = await M.signMasterAction({ signer: wallet, action: withdraw });
  sameSig(w.signature, fromHex65("0xb3172e33d2262dac2b4cb135ce3c167fda55dafa6c62213564ab728b9f9ba76b769a938e9f6d603dae7154c83bf5a4c3ebab81779dc2db25463a3ed663c82ae41c"), "rust withdraw");
  const typed = await S.typedSignerFromEthers(wallet);
  const send = { type: "usdSend", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", destination: "0x0D1d9635D0640821d15e323ac8AdADfA9c111414", amount: "1", time: 1690393044548 };
  sameSig(await S.signUserSigned({ wallet: typed, action: send, types: USD_SEND_TYPES }),
    fromHex65("0x214d507bbdaebba52fa60928f904a8b2df73673e3baba6133d66fe846c7ef70451e82453a6d8db124e7ed6e60fa00d4b7c46e4d96cb2bd61fd81b6e8953cc9d21b"), "rust usdSend");
});

test("C5) @nktkas/hyperliquid's own UsdSend vector, from a viem local account", async () => {
  const wallet = viemAccounts.privateKeyToAccount(NK_KEY);
  const action = { hyperliquidChain: "Mainnet", signatureChainId: "0x66eee", destination: "0x1234567890123456789012345678901234567890", amount: "1000", time: 1234567890 };
  sameSig(await S.signUserSigned({ wallet, action, types: USD_SEND_TYPES }),
    { r: "0xf777c38efe7c24cc71209526ae608f4e384d0586edf578f0e97b4b9f7c7adcc6", s: "0x104a4a97c48ae77bf5bd777bdd45fe72d8f5ff29116b5ff64fd8cfe4ea610786", v: 28 }, "nktkas usdSend");
});

/* ════════════════════════════════════════════════════════════════════════════
   D. approveAgent / approveBuilderFee — no official vector exists; three-way pin
   ════════════════════════════════════════════════════════════════════════════ */

/* Computed from a digest assembled by hand with the Rust SDK's struct-hash formula
   for ApproveAgent / ApproveBuilderFee (keccak of the literal type string, keccak
   of each string field, abi-encoded words), a hand-built HyperliquidSignTransaction
   domain separator, and a raw secp256k1 signature over
   keccak(0x1901 || domain || struct). No EIP-712 library and none of our code was
   involved. */
const GOLDEN = {
  approveAgent: {
    "0xa86a": { r: "0xc8eb5b1767cb16799cdecf4a14e06652eea4ee18a4368deb6221d8931ee66aca", s: "0x1019e440baca424cdf270e775b832766eab781242c621d60f5379a1756b1c6ef", v: 28 },
    "0x66eee": { r: "0x8aefc90e05eac4be3f236658a634f7b29dddd48977be0ebc5a930c3e19317597", s: "0x2f961e6ee535dc13c1019509297fb57047845eb94e7f3a9b532804d8ce1f5c24", v: 27 },
  },
  approveBuilderFee: {
    "0xa86a": { r: "0x93be9f2238588149be7ceab51b531b8432201203954252dcea4637e8c3cbed8b", s: "0x317dbbfc07c56b3ed613ec166ae0776d0e30c431b301eaa4aee5a2569eff89d0", v: 28 },
    "0x66eee": { r: "0xd6ba18a69119e91166918ab1b4919fbeb7521a3271bb2a9a12e209c4189e5ec0", s: "0x05216cf5f4d971b0c926f506d2acc1c187adacf8664d269a2c58bc5f830acd10", v: 28 },
  },
};
const PY_ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325";

function handDigest(chainId, structHash) {
  const k = (s) => viem.keccak256(viem.stringToBytes(s));
  const domain = viem.keccak256(viem.encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k("HyperliquidSignTransaction"), k("1"), BigInt(chainId), "0x0000000000000000000000000000000000000000"],
  ));
  return viem.keccak256(viem.concat(["0x1901", domain, structHash]));
}

for (const chain of ["0xa86a", "0x66eee"]) {
  test(`D1) approveAgent on signatureChainId ${chain}: golden, viem, and the hand-built Rust-formula digest all agree, and it recovers to the master`, async () => {
    const action = M.buildApproveAgentAction({
      profile: MAINNET(), signatureChainId: chain,
      agentAddress: "0x5E9EE1089755C3435139848E47E6635505D5A13A",
      agentName: "flowflow valid_until 1700000000000", nonce: 1699913600000,
    });
    assert.deepEqual(action, {
      type: "approveAgent", signatureChainId: chain, hyperliquidChain: "Mainnet",
      agentAddress: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
      agentName: "flowflow valid_until 1700000000000", nonce: 1699913600000,
    }, "the agent address is lowercased before signing (official Signing page)");
    const ours = (await M.signMasterAction({ signer: new ethers.Wallet(PY_KEY), action })).signature;
    sameSig(ours, GOLDEN.approveAgent[chain], "golden");

    const viemSig = viem.parseSignature(await viemAccounts.privateKeyToAccount(PY_KEY).signTypedData({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: Number(chain), verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: S.HL_USER_SIGNED_TYPES.approveAgent,
      primaryType: "HyperliquidTransaction:ApproveAgent",
      message: { hyperliquidChain: "Mainnet", agentAddress: action.agentAddress, agentName: action.agentName, nonce: BigInt(action.nonce) },
    }));
    sameSig(ours, { r: viemSig.r, s: viemSig.s, v: Number(viemSig.v) }, "viem");

    const k = (s) => viem.keccak256(viem.stringToBytes(s));
    const struct = viem.keccak256(viem.encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
      [k("HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)"), k("Mainnet"), action.agentAddress, k(action.agentName), BigInt(action.nonce)],
    ));
    const signer = await viem.recoverAddress({ hash: handDigest(Number(chain), struct), signature: viem.serializeSignature({ r: ours.r, s: ours.s, v: BigInt(ours.v) }) });
    assert.equal(signer.toLowerCase(), PY_ADDRESS);
  });

  test(`D2) approveBuilderFee on signatureChainId ${chain}: golden, viem, hand-built digest, recovery`, async () => {
    const action = M.buildApproveBuilderFeeAction({
      profile: MAINNET(), signatureChainId: chain,
      builder: "0x1719884EB866cb12b2287399b15f7db5e7d775ea", maxFeeRate: "0.05%", nonce: 1699913600000,
    });
    assert.deepEqual(action, {
      type: "approveBuilderFee", signatureChainId: chain, hyperliquidChain: "Mainnet",
      maxFeeRate: "0.05%", builder: "0x1719884eb866cb12b2287399b15f7db5e7d775ea", nonce: 1699913600000,
    });
    const ours = (await M.signMasterAction({ signer: new ethers.Wallet(PY_KEY), action })).signature;
    sameSig(ours, GOLDEN.approveBuilderFee[chain], "golden");
    const k = (s) => viem.keccak256(viem.stringToBytes(s));
    const struct = viem.keccak256(viem.encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint64" }],
      [k("HyperliquidTransaction:ApproveBuilderFee(string hyperliquidChain,string maxFeeRate,address builder,uint64 nonce)"), k("Mainnet"), k("0.05%"), action.builder, BigInt(action.nonce)],
    ));
    const signer = await viem.recoverAddress({ hash: handDigest(Number(chain), struct), signature: viem.serializeSignature({ r: ours.r, s: ours.s, v: BigInt(ours.v) }) });
    assert.equal(signer.toLowerCase(), PY_ADDRESS);
  });
}

test("D3) a signer that is not an approve/withdraw action is refused: the master key signs only the three actions it is for", async () => {
  await assert.rejects(M.signMasterAction({ signer: new ethers.Wallet(PY_KEY), action: { type: "usdSend", signatureChainId: "0xa86a", hyperliquidChain: "Mainnet" } }), /not a master action/);
  await assert.rejects(M.signMasterAction({ signer: new ethers.Wallet(PY_KEY), action: { type: "order" } }), /not a master action/);
});

/* ════════════════════════════════════════════════════════════════════════════
   E. THE PRODUCTION PATH — ethers BrowserProvider over an EIP-1193 wallet on Avalanche
   ════════════════════════════════════════════════════════════════════════════ */

/* What WalletContext.setup() does: new BrowserProvider(eip1193) -> getSigner().
   The fake wallet answers like MetaMask / Privy: it is on chain 43114, it refuses
   typed data whose domain chainId differs from the active chain (MetaMask's
   signature-controller rule), and it signs what it is handed with the key. */
function fakeChainWallet(key) {
  const account = viemAccounts.privateKeyToAccount(key);
  const seen = [];
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0xa86a";
      if (method === "net_version") return "43114";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const [addr, json] = params;
        const data = JSON.parse(json);
        seen.push({ addr, data });
        if (addr.toLowerCase() !== account.address.toLowerCase()) throw new Error("wrong account");
        if (data.domain && data.domain.chainId != null && Number(data.domain.chainId) !== 43114) {
          throw new Error(`Provided chainId "${data.domain.chainId}" must match the active chainId "43114"`);
        }
        return account.signTypedData({ domain: data.domain, types: data.types, primaryType: data.primaryType, message: data.message });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, seen, address: account.address };
}

test("E1) approveAgent through BrowserProvider on Avalanche: the wallet sees domain chainId 43114, accepts, and the signature matches the golden 0xa86a vector", async () => {
  const w = fakeChainWallet(PY_KEY);
  const signer = await new ethers.BrowserProvider(w.provider).getSigner();
  const chainId = await M.resolveWalletChainId(signer);
  assert.equal(chainId, 43114);
  const action = M.buildApproveAgentAction({
    profile: MAINNET(), signatureChainId: N.signatureChainIdFor(chainId),
    agentAddress: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
    agentName: "flowflow valid_until 1700000000000", nonce: 1699913600000,
  });
  const { signature, address } = await M.signMasterAction({ signer, action });
  assert.equal(address, PY_ADDRESS);
  sameSig(signature, GOLDEN.approveAgent["0xa86a"], "production path");
  assert.equal(w.seen.length, 1, "exactly one wallet prompt");
  const { data } = w.seen[0];
  assert.equal(Number(data.domain.chainId), 43114);
  assert.equal(data.domain.name, "HyperliquidSignTransaction");
  assert.equal(data.primaryType, "HyperliquidTransaction:ApproveAgent");
  assert.deepEqual(Object.keys(data.message).sort(), ["agentAddress", "agentName", "hyperliquidChain", "nonce"], "the wallet is shown only the typed fields");
});

test("E2) the same wallet REFUSES a mismatched domain (the reason signatureChainId follows the wallet): a fixed 0xa4b1 is rejected by an Avalanche wallet", async () => {
  const w = fakeChainWallet(PY_KEY);
  const signer = await new ethers.BrowserProvider(w.provider).getSigner();
  const action = M.buildApproveAgentAction({
    profile: MAINNET(), signatureChainId: "0xa4b1",
    agentAddress: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
    agentName: "flowflow", nonce: 1,
  });
  await assert.rejects(M.signMasterAction({ signer, action }), /must match the active chainId/);
});

test("E3) an L1 action is never handed to the master wallet: the agent signs it locally (domain 1337 would be refused on Avalanche)", async () => {
  const w = fakeChainWallet(PY_KEY);
  const signer = await new ethers.BrowserProvider(w.provider).getSigner();
  const typed = await S.typedSignerFromEthers(signer);
  await assert.rejects(S.signL1({ wallet: typed, action: pyOrder(), nonce: 0, profile: MAINNET() }), /must match the active chainId|master wallet/);
  assert.equal(w.seen.length, 0, "the master wallet never even saw an L1 payload");
});
