// Pure reads of Privy's user object and of the moment between "signed out" and "signed in". No Vite, no React.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The address of the user's Privy-made (embedded) Ethereum wallet, from the user object, or null.
 * Privy lists it in `linkedAccounts` as soon as the user is authenticated, while useWallets() is still getting the
 * wallet ready to sign: the account figures can stream from the address at once, and the signer follows.
 */
export function embeddedAddressOf(user) {
  const list = user && Array.isArray(user.linkedAccounts) ? user.linkedAccounts : [];
  const w = list.find((a) => a && a.type === "wallet" && a.walletClientType === "privy" && (!a.chainType || a.chainType === "ethereum"));
  const address = w && typeof w.address === "string" ? w.address : null;
  return address && ADDRESS_RE.test(address) ? address : null;
}

/**
 * What a sign-in surface shows instead of "Sign in" while a session is on its way:
 *   "restoring"  this load is an OAuth return or a remembered session, and Privy has not answered yet
 *   "wallet"     signed in, the embedded wallet is still being made or fetched
 *   null         nothing pending: signed in with an address, signed out, or Privy is off
 */
export function signInPending({ phase, authenticated, address, restoring }) {
  if (address || phase === "off") return null;
  if (phase === "ready") return authenticated ? "wallet" : null;
  return restoring ? "restoring" : null;
}
