// ─────────────────────────────────────────────────────────────────────────────
// A COPY OF THE OFAC SDN LIST'S ETH ADDRESSES, kept with the code (plan §7
// guardrail 2: "OFAC SDN ETH list ... เก็บสำเนาไว้ที่ server").
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน". The sanctions screen has three
// sources and ANY "listed" refuses:
//
//   1. this copy                       (here; no network, cannot be unreachable)
//   2. Chainalysis' on-chain oracle    (guard.js / sanctionsOracle.js, eth_call)
//   3. Hyperliquid's isSanctioned      (withdraw side only, preTransferCheck)
//
// WHY A COPY: Chainalysis has said the oracle is no longer actively maintained
// (R-compliance §6.3). If it stopped flagging an address, the oracle alone would
// clear it. A copy here keeps refusing what was listed when it was taken.
//
// 🔴 WHAT THIS COPY IS, measured, and what it is NOT:
//   • It is a SEED: addresses recalled as OFAC SDN ETH designations, each kept
//     ONLY because it answered isSanctioned = true on BOTH Arbitrum One and
//     Ethereum (read-only eth_call to the oracle 0x40C5…C8fb, 2026-10-15;
//     candidates that answered false were dropped). So today it refuses
//     nothing the oracle does not already refuse; it keeps refusing it if the
//     oracle stops answering "yes". Which designation each one is was NOT
//     re-checked against Treasury's own list (UNVERIFIED beyond the oracle).
//   • It is NOT yet the full list. The full ETH list is published nightly at
//     github.com/0xB10C/ofac-sanctioned-digital-currency-addresses
//     (sanctioned_addresses_ETH.txt). It was not downloaded in this task
//     (downloads were outside what this task was allowed to read). Replacing
//     OFAC_SDN_ETH_SEED with that file's lines (parseSdnList below reads it as
//     published) is owed before Private mode leaves preview.
//   • The owner's own additions go in server env INTENTS_SANCTIONS_EXTRA
//     (guard.js), checked beside this copy.
//
// PURE: no network, no env, nothing runs at import time. EVM addresses only.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Where the full list comes from, and when this seed was taken. */
export const OFAC_SDN_ETH_SOURCE = Object.freeze({
  list: "https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses (sanctioned_addresses_ETH.txt)",
  seedVerifiedAt: "2026-10-15",
  seedVerifiedBy: "isSanctioned(address) = true on Arbitrum One AND Ethereum (Chainalysis oracle 0x40C57923924B5c5c5455c48D93317139ADDaC8fb)",
  complete: false,
});

/* The seed (checksummed as published; compared in lower case). */
const OFAC_SDN_ETH_SEED = Object.freeze([
  "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", // Ronin bridge exploit, Lazarus Group (2022-04-14)
  "0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B",
  "0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073",
  "0x53b6936513e738f44FB50d2b9476730C0Ab3Bfc1",
  "0x35fB6f6DB4fb05e6A4cE86f2C93691425626d4b1",
  "0xF7B31119c2682c88d88D455dBb9d5932c65Cf1bE",
  "0x3e37627dEAA754090fBFbb8bd226c1CE66D255e9",
  "0x08723392Ed15743cc38513C4925f5e6be5c17243",
  "0x7F367cC41522cE07553e823bf3be79A889DEbe1B", // Lazarus Group (sanctionsOracle.js; the attack suite's SDN case)
  "0x7Db418b5D567A4e0E8c59Ad71BE1FcE48f3E6107",
  "0x72a5843cc08275C8171E582972Aa4fDa8C397B2A",
  "0x7F19720A857F834887FC9A7bC0a0fBe7Fc7f8102",
  "0x9F4cda013E354b8fC285BF4b9A60460cEe7f7Ea9",
  "0x1da5821544e25c636c1417Ba96Ade4Cf6D2f9B5A",
  "0x2f389cE8bD8ff92De3402FFCe4691d17fC4f6535",
  "0x19Aa5Fe80D33a56D56c78e82eA5E50E5d80b4Dff",
  "0xe7aa314c77F4233C18C6CC84384A9247c0cf367B",
  "0x308eD4B7b49797e1A98D3818bFF6fe5385410370",
  "0x67d40EE1A85bf4a4Bb7Ffae16De985e8427B6b45",
  "0x6f1cA141A28907F78Ebaa64fb83A9088b02A8352",
  "0x48549a34AE37b12F6a30566245176994e17C6b4A",
  "0x5512d943eD1f7c8a43F3435C85F7aB68b30121b0",
  "0xC455f7fd3e0e12afd51fba5c106909934D8A0e4a",
  "0xa7e5d5A720f06526557c513402f2e6B5fA20b008",
  "0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C",
  "0x901bb9583b24D97e995513C6778dc6888AB6870e",
  "0x7FF9cFad3877F21d41Da833E2F775dB0569eE3D9",
]);

/**
 * Lines of a published list (one address per line; blank lines, comments and
 * anything that is not a 20-byte hex address are skipped) as a Set of lower-case
 * addresses. For refreshing the copy from sanctioned_addresses_ETH.txt.
 */
export function parseSdnList(text) {
  const out = new Set();
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const a = line.trim().split(/[\s,#]/)[0];
    if (ADDRESS_RE.test(a)) out.add(a.toLowerCase());
  }
  return out;
}

/** The copy, lower case. */
export const OFAC_SDN_ETH = Object.freeze([...new Set(OFAC_SDN_ETH_SEED.map((a) => a.toLowerCase()))]);
const SET = new Set(OFAC_SDN_ETH);

/** Is this EVM address on the copy? false for anything that is not one (other screens decide those). */
export function sdnListed(address) {
  return typeof address === "string" && ADDRESS_RE.test(address) && SET.has(address.toLowerCase());
}
