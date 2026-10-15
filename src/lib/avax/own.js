// ─────────────────────────────────────────────────────────────────────────────
// ownAvaxAddress(): the ONE address money on Avalanche may belong to.
// ─────────────────────────────────────────────────────────────────────────────
//
// The Avax Wallet is the customer's Privy embedded EOA: the same key and the
// same address as their Perp account, on chain 43114 (plan §3.8, R-code §2.3).
//
// 🔴 THE MONEY RULES OF THIS FILE
//
//   1. THE ADDRESS IS COMPUTED, NEVER TYPED, NEVER FROM THE AGENT. It comes from
//      the connected wallet, and it is returned only when FOUR sources agree:
//        walletType === "privy"                       (an embedded wallet)
//        the connected wallet's address               (WalletContext)
//        the Perp backend's address                   (usePerpBackend b.address)
//        the Privy bridge's embedded address          (services/privy)
//      Anything else (an external wallet, view-as, read-only, the mock, a
//      disagreement, a malformed address) is null, and null means no Confirm.
//   2. CALL IT AGAIN AT CONFIRM AND BEFORE EVERY WINDOW. Do not keep the answer
//      in a card, the flow registry or session storage (plan §3.8.2).
//   3. Every address a quote or calldata names (sender, recipient, refundTo,
//      onBehalfOf, to) is compared with a FRESH answer through assertOwn().

import { isEvmAddress, sameAddress } from "../relay/depositAddress.js";

/** Why there is no own address, as the card prints it (D2). */
export const OWN_WHY = Object.freeze({
  signedOut: "Sign in first",
  notPrivy: "Swaps and Aave use your FlowFlow wallet",
  viewOnly: "View only",
  mock: "Live only",
  mismatch: "Your wallet is still loading",
});

/**
 * @param {object} ctx
 * @param {{address?:string, walletType?:string}} [ctx.wallet]  useWallet()
 * @param {{address?:string, mock?:boolean, readOnly?:boolean, viewAs?:any}} [ctx.backend]  usePerpBackend()
 * @param {string|null} [ctx.embeddedAddress]  the Privy bridge's embedded address
 * @returns {{ own: string|null, why: string|null }}  own is lowercase
 */
export function ownAvaxAddressWhy({ wallet = null, backend = null, embeddedAddress = null } = {}) {
  const w = wallet && typeof wallet === "object" ? wallet : {};
  const b = backend && typeof backend === "object" ? backend : {};
  if (b.mock) return { own: null, why: OWN_WHY.mock };
  if (b.readOnly || b.viewAs) return { own: null, why: OWN_WHY.viewOnly };
  if (!isEvmAddress(w.address)) return { own: null, why: OWN_WHY.signedOut };
  if (w.walletType !== "privy") return { own: null, why: OWN_WHY.notPrivy };
  if (!sameAddress(w.address, b.address) || !sameAddress(w.address, embeddedAddress)) {
    return { own: null, why: OWN_WHY.mismatch };
  }
  return { own: w.address.toLowerCase(), why: null };
}

/** The customer's own Avalanche address (lowercase), or null. See ownAvaxAddressWhy. */
export function ownAvaxAddress(ctx) {
  return ownAvaxAddressWhy(ctx).own;
}

export class NotOwnAddressError extends Error {
  constructor(field, value) {
    super(`The ${field} is not your own wallet`);
    this.name = "NotOwnAddressError";
    this.code = "not-own";
    this.field = field;
    this.value = value ?? null;
  }
}

/** Throws NotOwnAddressError unless `value` is the own address. `own` null always throws. */
export function assertOwn(own, value, field = "address") {
  if (!isEvmAddress(own) || !sameAddress(own, value)) throw new NotOwnAddressError(field, value);
  return own.toLowerCase();
}
