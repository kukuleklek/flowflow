/**
 * test-privy-methods — the sign-in card shows only the methods the Privy dashboard has switched on, read from
 * Privy's public app config; an unknown answer (offline, blocked, not a config) shows every method, as before.
 * Run: node --test scripts/test-privy-methods.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRIVY_CONFIG_URL, methodOn, privyMethodsFromConfig } from "../src/services/privyMethods.js";

test("P1) the dashboard's switches, read from the app config", () => {
  const m = privyMethodsFromConfig({ google_oauth: false, email_auth: true, passkey_auth: false, apple_oauth: true });
  assert.deepEqual({ ...m }, { google: false, email: true, passkey: false, passkeySignup: false });
  assert.equal(methodOn(m, "google"), false);
  assert.equal(methodOn(m, "email"), true);
  assert.equal(methodOn(m, "passkey"), false);
});

test("P2) not a config (error body, null, HTML) is unknown, and unknown shows every method", () => {
  for (const bad of [null, undefined, "nope", { error: "Invalid app ID" }, { google_oauth: true }]) {
    assert.equal(privyMethodsFromConfig(bad), null);
  }
  for (const name of ["google", "email", "passkey"]) assert.equal(methodOn(null, name), true);
});

test("P3) the config URL is Privy's, with the app id escaped", () => {
  assert.equal(PRIVY_CONFIG_URL("cexample0app0id0000000000"), "https://auth.privy.io/api/v1/apps/cexample0app0id0000000000");
  assert.equal(PRIVY_CONFIG_URL("a/b?c"), "https://auth.privy.io/api/v1/apps/a%2Fb%3Fc");
});

test("P4) passkey sign-up is its own switch, and is offered only when known to be on", () => {
  const loginOnly = privyMethodsFromConfig({ google_oauth: true, email_auth: true, passkey_auth: true, passkeys_for_signup_enabled: false });
  assert.equal(methodOn(loginOnly, "passkey"), true, "a returning user can still use their passkey");
  assert.equal(methodOn(loginOnly, "passkeySignup"), false, "a new user is not sent into a passkey flow that fails");
  const both = privyMethodsFromConfig({ google_oauth: true, email_auth: true, passkey_auth: true, passkeys_for_signup_enabled: true });
  assert.equal(methodOn(both, "passkeySignup"), true);
  const signupButNoPasskeys = privyMethodsFromConfig({ email_auth: true, passkey_auth: false, passkeys_for_signup_enabled: true });
  assert.equal(methodOn(signupButNoPasskeys, "passkeySignup"), false);
  assert.equal(methodOn(null, "passkeySignup"), false, "unknown config: no passkey sign-up row");
});
