// ─────────────────────────────────────────────────────────────────────────────
// "Arrived": has a deposit landed in the Perp account? Pure: no clock of its own.
// ─────────────────────────────────────────────────────────────────────────────
//
// The Deposit sheet starts a deposit at sinceMs (this device's clock) and waits
// for Hyperliquid to credit the account. The credit is a ledger line
// (userNonFundingLedgerUpdates): a CCTP deposit arrives as a "send" from
// Circle's CoreDepositWallet (seen live, 2026-09-22), a bridge deposit as
// "deposit", a transfer from another Hyperliquid account as "send" or
// "spotTransfer". parse.js reads each one's direction and USDC amount; this
// file only picks the inbound USDC credits at or after the start.
//
// CLOCKS. Ledger times are Hyperliquid's; sinceMs is the phone's. A phone that
// runs fast would stamp the start AFTER a credit that really came later, and
// the sheet would never flip. webData3 reports the server time and the
// snapshot keeps when it arrived here, so the start is moved onto the server's
// clock when that is known (clock "server"), and used as given when it is not
// (clock "device").
//
// UNKNOWN IS NULL. Until the ledger has answered, arrived is null (a dash, not
// a no). After it has, arrived is true or false.

import { arrivalsSince } from "./parse.js";

const NOT_ANSWERED = Object.freeze({ answered: false, arrived: null, lines: Object.freeze([]), clock: null });

/**
 * @param {object|null|undefined} snap a usePerpAccount snapshot
 * @param {{ sinceMs?: number|null, minUsdc?: number|null }} [opts]
 *   sinceMs: when the user started the deposit, by this device's clock;
 *   minUsdc: the smallest credit that counts (keeps dust from reading as the deposit)
 * @returns {{ answered: boolean, arrived: boolean|null, lines: object[], clock: "server"|"device"|null }}
 *   lines: the matching credits, newest first (parse.js ledger lines)
 */
export function perpDepositArrival(snap, { sinceMs = null, minUsdc = null } = {}) {
  if (!snap || !snap.ledger || snap.ledger.answered !== true) return NOT_ANSWERED;
  const server = snap.server || {};
  const skewKnown = typeof server.time === "number" && Number.isFinite(server.time)
    && typeof server.at === "number" && Number.isFinite(server.at);
  const since = sinceMs == null ? null : skewKnown ? sinceMs + (server.time - server.at) : sinceMs;
  const lines = Object.freeze(arrivalsSince(snap.ledger.list, since, { minUsdc }));
  return Object.freeze({ answered: true, arrived: lines.length > 0, lines, clock: skewKnown ? "server" : "device" });
}
