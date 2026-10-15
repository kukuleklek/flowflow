import { useEffect, useMemo, useRef } from "react";
import {
  usePrivy, useWallets, useLoginWithOAuth, useLoginWithEmail, useLoginWithPasskey, useSignupWithPasskey, useCreateWallet,
} from "@privy-io/react-auth";

import { registerPrivyLogin } from "../../services/privy.js";
import { embeddedAddressOf } from "../../services/privyUser.js";

/** `walletClientType` of Privy's own embedded wallet (vs a linked external one). */
const EMBEDDED_WALLET = "privy";

/* How long after a sign-in the embedded wallet may take to appear before we
   create it ourselves. Privy's headless email login does not create one (its own
   docs say so); OAuth and passkey do, through createOnLogin, a tick or two late.
   Every millisecond here is a new user looking at a screen that has not moved,
   and a second create is refused by Privy (caught below), so it is short. */
const CREATE_WALLET_AFTER_MS = 1200;

/** What the card and the header say about the signed-in user. Never the raw object. */
function userSummary(user) {
  if (!user) return null;
  if (user.google?.email) return { method: "google", label: user.google.email, name: user.google.name || null };
  if (user.email?.address) return { method: "email", label: user.email.address, name: null };
  const passkey = (user.linkedAccounts || []).some((a) => a.type === "passkey");
  if (passkey) return { method: "passkey", label: "Passkey", name: null };
  return { method: "other", label: "Signed in", name: null };
}

/**
 * PrivyHeadless — renders nothing. FlowFlow's login card (auth/ConnectCard.jsx)
 * draws every step itself, so this registers Privy's HEADLESS login hooks into
 * services/privy and reports who is signed in. It never opens a Privy modal.
 *
 * Kept apart from <PrivyBridge>, which owns signing and is held by its own
 * tests to an exact list of hooks.
 */
export default function PrivyHeadless() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { initOAuth } = useLoginWithOAuth();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { loginWithPasskey } = useLoginWithPasskey();
  const { signupWithPasskey } = useSignupWithPasskey();
  const { createWallet } = useCreateWallet();

  const embedded = wallets.find((w) => w.walletClientType === EMBEDDED_WALLET);
  /* The user object names the wallet before useWallets() has it ready to sign: report the address at once (the
     account streams from it), and let the signer follow (PrivyBridge.connect waits for the wallet itself). */
  const embeddedAddress = (embedded && typeof embedded.address === "string" ? embedded.address : null) || embeddedAddressOf(user);
  const summary = useMemo(() => userSummary(user), [user]);

  /* A signed-in user with no embedded wallet gets one, once. */
  const creating = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || embeddedAddress || creating.current) return undefined;
    const t = setTimeout(() => {
      if (creating.current) return;
      creating.current = true;
      Promise.resolve(createWallet()).catch(() => { creating.current = false; });
    }, CREATE_WALLET_AFTER_MS);
    return () => clearTimeout(t);
  }, [ready, authenticated, embeddedAddress, createWallet]);

  useEffect(() => {
    registerPrivyLogin({
      ready,
      authenticated,
      embeddedAddress,
      user: summary,
      loginWithGoogle: () => initOAuth({ provider: "google" }),
      sendEmailCode: (email) => sendCode({ email }),
      loginWithEmailCode: (code) => loginWithCode({ code }),
      loginWithPasskey: () => loginWithPasskey(),
      signupWithPasskey: () => signupWithPasskey(),
    });
  }, [ready, authenticated, embeddedAddress, summary, initOAuth, sendCode, loginWithCode, loginWithPasskey, signupWithPasskey]);

  return null;
}
