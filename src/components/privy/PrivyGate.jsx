import { Suspense, lazy, useEffect, useState } from "react";
import { hasSessionHint, isPrivyConfigured, onPrivyMountRequested, requestPrivyMount } from "../../services/privy.js";

const loadPrivyMount = () => import("./PrivyMount.jsx");
const PrivyMount = lazy(loadPrivyMount);

/* Fetch the chunk while the reader looks at the markets, so a tap on Sign in is
   fast. Fetching is not mounting: nothing runs until someone asks. */
const PREFETCH_AFTER_MS = 2500;

/**
 * PrivyGate — renders nothing until Privy is needed. Mounted once, as a SIBLING
 * of the app (main.jsx), so no app component depends on a Privy context.
 *
 * Mounts at the FIRST PAINT when:
 *   · this load is an OAuth redirect return (?privy_oauth_code): Privy finishes
 *     the code exchange only if its provider is present from the start (the hang
 *     was measured without this);
 *   · this browser had a session (the hint services/privy keeps), so the header
 *     can show the account without a tap.
 * Otherwise on the first request (a tap on Sign in).
 */
export default function PrivyGate() {
  const [mounted, setMounted] = useState(() => {
    if (!isPrivyConfigured()) return false;
    const oauthReturn = new URLSearchParams(window.location.search).has("privy_oauth_code");
    return oauthReturn || hasSessionHint();
  });

  useEffect(() => {
    if (!isPrivyConfigured()) return undefined;
    if (mounted) requestPrivyMount();
    return onPrivyMountRequested(() => setMounted(true));
  }, [mounted]);

  useEffect(() => {
    if (!isPrivyConfigured() || mounted) return undefined;
    const t = setTimeout(() => { loadPrivyMount().catch(() => {}); }, PREFETCH_AFTER_MS);
    return () => clearTimeout(t);
  }, [mounted]);

  if (!isPrivyConfigured() || !mounted) return null;
  return (
    <Suspense fallback={null}>
      <PrivyMount />
    </Suspense>
  );
}
