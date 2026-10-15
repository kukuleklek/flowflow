// The app-wide deposit mover: mounted ONCE (src/main.jsx), draws nothing.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ทำไมเงิน ไม่ Move To Account แบบ Auto วะ ทุกเชนเลย ทำไมคนต้อง
// มากดเองวะ". The last hop of a deposit used to happen only while the Deposit
// panel was open. This makes it happen wherever the customer is: it tells the
// tab's one runner (perp/deposit/perpFunding.js) WHEN to read the wallet's own
// balance on the landing chain, and the runner moves what is there, by itself,
// under its money rules (nothing below the floor, nothing unreadable, nothing
// with an unresolved attempt written down, nothing twice).
//
// WHEN IT ASKS — and never on a timer of its own:
//   • a signed-in wallet that can make the hop with no window (on sign-in, on
//     app start, and the moment the Privy bridge hands over its sender);
//   • every time one of this wallet's deposits lands, comes back or fails
//     (depositWatch's landingSig) — the watch keeps polling only as it already
//     did, and it is focused here so a watch saved before a reload resumes;
//   • the tab coming back into view, which is when a phone customer returns
//     from the exchange app they sent the money from; the window getting focus
//     back (a desktop customer returning from another app); and the network
//     coming back (a move refused by a blip is tried again on the next look);
//   • after a move (the runner reads once more by itself).
//
// ONLY THE CUSTOMER'S OWN EMBEDDED WALLET. A wallet that is not a Privy login
// is never read and never moved. A Privy wallet whose no-window sender is not
// there YET is read (so the popup can say where its money is, rather than
// spinning on "landed") and never moved; the moment the sender arrives it is
// read again, and moved.
//
// 🔴 NOT IN A MOCK BUILD. VITE_PERP_BACKEND=mock is a demo of a pretend Perp
// account, but the Privy login, the wallet and the Arbitrum USDC in it are real:
// this mover stands down entirely there (and the runner refuses an automatic
// move in such a build as well).

import { useEffect, useSyncExternalStore } from "react";
import { useWallet } from "../../hooks/useWallet.js";
import { subscribePrivyApi, privyApiSeq } from "../../services/privy.js";
import { depositWatch, landingSig } from "./depositWatch.js";
import { perpFunding } from "./perpFunding.js";
import { walletCanFinishFirstHop } from "./perpDepositView.js";

/* Read once from the build: exactly "mock" is the mock build (perp/live/perpBackend's perpBackendKind). */
const MOCK_BUILD = import.meta.env.VITE_PERP_BACKEND === "mock";

export default function DepositAutoMover({ watch = depositWatch, funding = perpFunding }) {
  const { address, walletType } = useWallet();
  const wallet = address || null;
  /* Re-render when the Privy bridge (re)registers: that is when the no-window
     sender appears (or goes). */
  useSyncExternalStore(subscribePrivyApi, privyApiSeq, privyApiSeq);
  const ws = useSyncExternalStore(watch.subscribe, watch.getState, watch.getState);
  const own = !MOCK_BUILD && !!wallet && walletCanFinishFirstHop(walletType);
  const can = own && !!(wallet && walletCanFinishFirstHop(walletType) && funding.canRun(wallet));
  const sig = wallet ? landingSig(ws, wallet) : "";

  /* The wallet on screen, for the watch (saved watches resume) and the runner
     (another wallet's figures are dropped). */
  useEffect(() => { watch.focus(wallet); }, [watch, wallet]);
  useEffect(() => { funding.focus(wallet); }, [funding, wallet]);

  /* Sign-in, app start, the sender arriving, and every landing. Without the
     sender yet: a read only, so the box can say where the money is. */
  useEffect(() => {
    if (!own) return;
    if (can) funding.check({ user: wallet, connected: wallet, auto: true });
    else funding.check({ user: wallet, connected: wallet, auto: false });
  }, [own, can, wallet, sig, funding]);

  /* The tab coming back, the window getting focus back, the network coming back. */
  useEffect(() => {
    if (!can || typeof document === "undefined" || typeof window === "undefined") return undefined;
    const look = () => funding.check({ user: wallet, connected: wallet, auto: true });
    const onVisible = () => { if (document.visibilityState === "visible") look(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", look);
    window.addEventListener("online", look);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", look);
      window.removeEventListener("online", look);
    };
  }, [can, wallet, funding]);

  return null;
}
