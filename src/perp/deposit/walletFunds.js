// "Money just landed in this wallet": one signal, from the deposit watch to Recover.
// ─────────────────────────────────────────────────────────────────────────────
//
// On the first-deposit plan a deposit lands in the customer's OWN wallet, and the
// Perp account screen's Recover lines are what offer to move it the rest of the
// way. Recover looks once per wallet per session and reuses that look for a
// minute (perp/recover/useRecoverFund.js), so a landing after its look was
// invisible there: the status strip pointed at the Perp account and the Perp
// account said nothing.
//
// So the deposit watch (perp/deposit/depositWatch.js) bumps a per-wallet count
// here when such a deposit lands, and Recover treats a look taken before the
// bump as stale. A count, not a time: nothing here compares two clocks.
//
// No network, no timer, nothing at import time. In memory only: a new session
// has no look to be stale.

const SEQ = new Map();
const SUBS = new Set();

const keyOf = (user) => String(user || "").toLowerCase();

/** How many landings this session has seen for a wallet. */
export function walletFundsSeq(user) {
  return SEQ.get(keyOf(user)) || 0;
}

/** A deposit has just landed in this wallet. */
export function markWalletFunds(user) {
  const k = keyOf(user);
  if (!k) return;
  SEQ.set(k, (SEQ.get(k) || 0) + 1);
  for (const fn of [...SUBS]) { try { fn(k); } catch { /* one dead listener is not the others' problem */ } }
}

/** Called with the wallet (lower case) on every landing. Returns the unsubscribe. */
export function onWalletFunds(fn) {
  SUBS.add(fn);
  return () => { SUBS.delete(fn); };
}
