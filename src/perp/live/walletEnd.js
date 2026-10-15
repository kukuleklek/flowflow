// The trading key must not outlive the wallet that approved it on this device.
//
// critic_A: "The key must be stored by (network, master address) and wiped on
// accountsChanged, disconnect and Privy logout." The key store already keys
// records by (network, master), so account B can never trade with account A's
// key; this wipes A's key from this browser the moment A stops being the
// connected wallet (a switch to B, Disconnect, or a Privy logout, which
// disconnects). The first wallet a page load sees keeps only its own key: a
// switch made while no tab was open (prevMaster null, nextMaster B) wipes
// every other account's key too. A stolen copy keeps working on Hyperliquid until its
// valid_until (24 hours at most, agentStore.js); wiping removes OUR copy.
//
// WalletContext calls this through a LAZY import behind PERP_ENABLED, so a
// build without the Perp mode carries none of it. Never throws.

import { sharedTradingState, wipeAgentOnWalletChange } from "../../lib/hyperliquid/exchange/index.js";

/**
 * @param {string|null} prevMaster the wallet that was connected (null on a page load's first wallet)
 * @param {string|null} nextMaster the wallet connected now (null after Disconnect)
 * @returns {boolean} whether a key was wiped
 */
export function wipePerpAgentOnWalletEnd(prevMaster, nextMaster) {
  try {
    return wipeAgentOnWalletChange(sharedTradingState().agents, prevMaster, nextMaster) === true;
  } catch {
    return false;
  }
}
