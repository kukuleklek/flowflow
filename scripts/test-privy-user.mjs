/**
 * test-privy-user — after a sign-in the screen must move at once: the embedded wallet's address comes from Privy's
 * user object (before useWallets() is ready), and between "signed out" and "signed in" a sign-in surface says what
 * is happening instead of offering Sign in again.
 * Run: node --test scripts/test-privy-user.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddedAddressOf, signInPending } from "../src/services/privyUser.js";

const A = "0x1111111111111111111111111111111111111111";

test("U1) the embedded Ethereum wallet's address, from linkedAccounts", () => {
  const user = { linkedAccounts: [
    { type: "google_oauth", email: "a@b.c" },
    { type: "wallet", walletClientType: "metamask", chainType: "ethereum", address: "0x2222222222222222222222222222222222222222" },
    { type: "wallet", walletClientType: "privy", chainType: "solana", address: "So11111111111111111111111111111111111111112" },
    { type: "wallet", walletClientType: "privy", chainType: "ethereum", address: A },
  ] };
  assert.equal(embeddedAddressOf(user), A, "Privy's own Ethereum wallet, not an external or a Solana one");
});

test("U2) no user, no embedded wallet, or a malformed address: null", () => {
  assert.equal(embeddedAddressOf(null), null);
  assert.equal(embeddedAddressOf({}), null);
  assert.equal(embeddedAddressOf({ linkedAccounts: [{ type: "email", address: "a@b.c" }] }), null);
  assert.equal(embeddedAddressOf({ linkedAccounts: [{ type: "wallet", walletClientType: "privy", address: "0x123" }] }), null);
});

test("U3) the in-between states", () => {
  assert.equal(signInPending({ phase: "booting", authenticated: false, address: null, restoring: true }), "restoring");
  assert.equal(signInPending({ phase: "idle", authenticated: false, address: null, restoring: true }), "restoring");
  assert.equal(signInPending({ phase: "booting", authenticated: false, address: null, restoring: false }), null, "a first tap on Sign in is not a restore");
  assert.equal(signInPending({ phase: "ready", authenticated: true, address: null, restoring: false }), "wallet");
  assert.equal(signInPending({ phase: "ready", authenticated: true, address: A, restoring: true }), null, "signed in");
  assert.equal(signInPending({ phase: "ready", authenticated: false, address: null, restoring: true }), null, "Privy answered: signed out");
  assert.equal(signInPending({ phase: "off", authenticated: false, address: null, restoring: true }), null);
});
