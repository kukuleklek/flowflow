// Which sign-in methods the Privy dashboard has switched on, read from Privy's public app config (the same
// GET /api/v1/apps/:id its SDK makes). A row for a method the dashboard has off only ever fails with
// "Login with Google not allowed", so the sign-in card shows the methods that can work. Pure: no Vite, no React.

export const PRIVY_CONFIG_URL = (appId) => `https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}`;

/** The dashboard's switches, or null when the answer is not a Privy app config (unknown: show every method). */
export function privyMethodsFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || typeof cfg.email_auth !== "boolean") return null;
  return Object.freeze({
    google: cfg.google_oauth === true,
    email: cfg.email_auth === true,
    passkey: cfg.passkey_auth === true,
    /* Logging in with a passkey and creating an account on one are separate switches. */
    passkeySignup: cfg.passkey_auth === true && cfg.passkeys_for_signup_enabled === true,
  });
}

/** Is this method worth a row? Unknown config (loading, offline, blocked) shows them all, as before, except
 *  passkey sign-up: offered only when the dashboard is known to allow it, since a refused one just fails. */
export const methodOn = (methods, name) => (name === "passkeySignup" ? !!methods && methods.passkeySignup === true : !methods || methods[name] === true);
