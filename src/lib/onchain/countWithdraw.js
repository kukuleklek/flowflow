// After the user signs a withdrawal, ask our server to count it on Avalanche (api/onchain-withdraw.js). The server
// counts only what it reads itself on Hyperliquid, so this only says WHO. Fire-and-forget: never shown as an error,
// never holds anything up. Once per user per page for each withdrawal moment.
export const ONCHAIN_URL = "/api/onchain-withdraw";
const AFTER_MS = 8000;

export function countWithdrawOnAvalanche(user, { chainId = 0, isPrivate = false, fetchImpl = globalThis.fetch, setTimer = setTimeout, afterMs = AFTER_MS } = {}) {
  if (typeof user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(user) || typeof fetchImpl !== "function") return;
  /* The Hyperliquid ledger shows the transfer a moment after the signature. */
  setTimer(() => {
    Promise.resolve()
      .then(() => fetchImpl(ONCHAIN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user, chainId, private: isPrivate }) }))
      .catch(() => {});
  }, afterMs);
}
