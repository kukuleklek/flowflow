// ─────────────────────────────────────────────────────────────────────────────
// WalletContext — the one wallet every screen reads (FlowFlow: Privy only).
// ─────────────────────────────────────────────────────────────────────────────
//
// The shape the perp layer expects, so usePerpBackend reads it unchanged:
//   { address, signer, walletType, chainId, isConnected }
// plus what FlowFlow's own screens need: phase, user, connecting, pending, disconnect.
// `pending` ("restoring" | "wallet" | null) is the moment between signed out and signed in, so no screen offers
// Sign in again while a session is arriving (privyUser.js signInPending).
//
// address arrives as soon as Privy reports the embedded wallet (the account
// figures can stream from that alone); signer follows once the wallet's provider
// is fetched and parked on Arbitrum. The trader is built only when both exist.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BrowserProvider } from "ethers";
import { connectPrivy, disconnectPrivy, getPrivySnapshot, restoringAtLoad, subscribePrivy } from "../services/privy.js";
import { signInPending } from "../services/privyUser.js";
import { PERP_BACKEND } from "../perp/live/config.js";
import { chat, agentAccountKey } from "../agent/store.js";

/* A restore that has not answered by then (Privy blocked, offline) gives the Sign in button back. */
const RESTORE_MAX_MS = 12_000;

const WalletContext = createContext(null);

const lower = (a) => (typeof a === "string" ? a.toLowerCase() : null);

export function WalletProvider({ children }) {
  const privy = useSyncExternalStore(subscribePrivy, getPrivySnapshot, getPrivySnapshot);
  const [conn, setConn] = useState({ address: null, signer: null, chainId: null, error: null });
  const attempt = useRef(0);

  const address = privy.authenticated && privy.address ? privy.address : null;
  const [restoring, setRestoring] = useState(restoringAtLoad);
  useEffect(() => {
    if (!restoring) return undefined;
    const t = setTimeout(() => setRestoring(false), RESTORE_MAX_MS);
    return () => clearTimeout(t);
  }, [restoring]);
  const pending = signInPending({ phase: privy.phase, authenticated: privy.authenticated, address, restoring });

  /* Build the signer for the signed-in wallet; drop it on sign-out. */
  useEffect(() => {
    const my = ++attempt.current;
    if (!address) {
      setConn({ address: null, signer: null, chainId: null, error: null });
      return;
    }
    setConn((c) => (lower(c.address) === lower(address) ? c : { address, signer: null, chainId: null, error: null }));
    (async () => {
      try {
        const eip1193 = await connectPrivy({ silent: true });
        const provider = new BrowserProvider(eip1193, "any");
        const signer = await provider.getSigner(address);
        const net = await provider.getNetwork();
        if (attempt.current !== my) return;
        setConn({ address, signer, chainId: Number(net.chainId), error: null });
      } catch (e) {
        if (attempt.current !== my) return;
        setConn({ address, signer: null, chainId: null, error: String(e?.message || e) });
      }
    })();
  }, [address]);

  /* The trading key must not outlive the wallet that approved it on this device
     (walletEnd.js): a switch or a sign-out wipes the old master's key. */
  const prevMaster = useRef(undefined);
  useEffect(() => {
    if (privy.phase !== "ready") return;
    const prev = prevMaster.current === undefined ? null : prevMaster.current;
    const next = lower(address);
    if (prevMaster.current !== undefined && prev === next) return;
    prevMaster.current = next;
    import("../perp/live/walletEnd.js").then((m) => m.wipePerpAgentOnWalletEnd(prev, next)).catch(() => {});
  }, [privy.phase, address]);

  /* ONE ACCOUNT, ONE AGENT (agent/store.js; owner, 2026-10-15). The Agent's conversation follows the wallet: this
     address's own, "guest" once signed out, "mock" in a mock build. While a sign-in is still arriving the one on
     screen stays. A layout effect, so a sign-out or a switch never paints a frame of the other account's chat. */
  const agentKey = agentAccountKey({ mock: PERP_BACKEND === "mock", address, pending });
  useLayoutEffect(() => {
    if (agentKey) chat.setAccount(agentKey);
  }, [agentKey]);

  const disconnect = useCallback(() => disconnectPrivy(), []);

  const value = useMemo(() => ({
    address,
    signer: conn.address && lower(conn.address) === lower(address) ? conn.signer : null,
    walletType: address ? "privy" : null,
    chainId: conn.chainId,
    isConnected: !!address,
    phase: privy.phase,
    user: privy.user,
    connecting: !!address && !conn.signer && !conn.error,
    pending,
    walletError: conn.error,
    disconnect,
  }), [address, conn, privy.phase, privy.user, pending, disconnect]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const v = useContext(WalletContext);
  if (!v) throw new Error("useWallet() needs <WalletProvider>");
  return v;
}
