import { createContext, useContext, useEffect } from "react";
import { usePerpBackend } from "./live/usePerpBackend.js";
import { registerAvaxPerpSigners } from "../avax/signers.js";

/* usePerpBackend builds the trader for the connected wallet. It runs ONCE, here, and every screen reads the same
   object, so two components can never hold two traders (or two views of the trading key) for one account. */
const BackendContext = createContext(null);

export function BackendProvider({ children }) {
  const backend = usePerpBackend();
  /* The Avax Wallet's moves out of the Main Account sign with the SAME two calls today's Withdraw does (the backend's
     signRelayAuthorize / sendRelayDeposit, one wallet window each), so they are handed to src/avax/signers.js from
     here, the one place the backend is built — never a second trader. Re-handed when the account or the trader
     changes; a mock, a view-as or a non-Privy wallet hands over nothing (signers.js refuses it). */
  const { kind, mock, address, walletType, readOnly, signRelayAuthorize, sendRelayDeposit } = backend;
  const viewAs = !!backend.viewAs;
  useEffect(
    () => registerAvaxPerpSigners({ kind, mock, address, walletType, readOnly, viewAs, signRelayAuthorize, sendRelayDeposit }),
    [kind, mock, address, walletType, readOnly, viewAs, signRelayAuthorize, sendRelayDeposit],
  );
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

export function useBackend() {
  const b = useContext(BackendContext);
  if (!b) throw new Error("useBackend() needs <BackendProvider>");
  return b;
}
