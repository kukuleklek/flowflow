// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONS SCREEN FOR PRIVATE MODE: is an EVM address on the OFAC list?
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "Start Now ทำ Backend ก่อน" (the Normal | Private toggle's
// backend). Plan §7 guardrail 2: every Private quote is screened BEFORE it is
// asked for, and a hit is refused with words that never coach a workaround.
//
// THE SOURCE. Chainalysis's sanctions oracle, a public contract with one read,
// isSanctioned(address) -> bool, at the same address on Ethereum and Arbitrum.
// Read with a plain eth_call on a public RPC: no key, nothing signed, nothing
// sent. Measured 2026-10-15 (read-only): code present on Arbitrum One and on
// Ethereum; NO code at that address on Base (eth_call answers "0x"); the
// Lazarus address 0x7F36…be1B answers 1 on both chains, a dev address 0.
//
// 🔴 THE RULES OF THIS FILE
//   1. "0x" IS NOT "no". An eth_call to an address with no contract answers
//      "0x", and a decoder that reads that as false would clear everybody on a
//      chain where the oracle does not exist. Only an answer that is exactly
//      one 32-byte word of 0 or 1 is read; anything else is null (unknown).
//   2. ANY "yes" WINS. Both chains are asked. The two lists are updated by
//      separate transactions, so one may be ahead of the other: a hit on
//      either is a hit.
//   3. UNKNOWN IS NOT CLEAR. No definite answer from any RPC is null, and the
//      caller refuses on null (nothing is quoted on an unscreened address).
//   4. EVM ONLY. A Solana (or any non-0x) address cannot be asked this
//      contract; it comes back null with why "not-evm", never false.
//
// UNVERIFIED, and named so nobody reads it as measured: research
// (R-compliance §6.3) quotes Chainalysis saying the on-chain oracle "is no
// longer maintained". It still answered correctly for a 2022 designation on
// 2026-10-15, but a stale list would miss newer ones. The withdraw path
// therefore ALSO reads Hyperliquid's own isSanctioned for every EVM address it
// can (withdraw.js screenWithdrawAddresses), and the plan's OFAC SDN list
// (github.com/0xB10C/ofac-sanctioned-digital-currency-addresses, server-side
// copy) is still owed as a third source.
//
// PURE: fetch, timers and the RPC list are injected; nothing runs at import
// time and nothing reads the env, so the server proxy and the browser share it.

/** The oracle contract (Chainalysis), the same address on every chain it is on. */
export const SANCTIONS_ORACLE = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";

/** keccak256("isSanctioned(address)")[0..4]. */
export const IS_SANCTIONED_SELECTOR = "0xdf592f7d";

/** Where the oracle was found live (2026-10-15). Base has no code there: not on this list. */
export const SANCTIONS_RPCS = Object.freeze([
  Object.freeze({ chainId: 42161, url: "https://arb1.arbitrum.io/rpc" }),
  Object.freeze({ chainId: 1, url: "https://ethereum-rpc.publicnode.com" }),
]);

export const SANCTIONS_TIMEOUT_MS = 8000;

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/** The eth_call data for isSanctioned(address). Throws on a non-address (never asks a malformed question). */
export function isSanctionedCallData(address) {
  if (typeof address !== "string" || !HEX40.test(address)) throw new Error("not an EVM address");
  return `${IS_SANCTIONED_SELECTOR}${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/**
 * One eth_call result, read: true, false, or null when it is not exactly one
 * 32-byte word holding 0 or 1 ("0x" from an address with no contract is null).
 */
export function readOracleAnswer(result) {
  if (typeof result !== "string" || !WORD.test(result)) return null;
  const v = BigInt(result);
  if (v === 0n) return false;
  if (v === 1n) return true;
  return null;
}

async function askOne(rpc, address, { fetchImpl, timers, timeoutMs }) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const guard = ctrl ? timers.setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(rpc.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: SANCTIONS_ORACLE, data: isSanctionedCallData(address) }, "latest"],
      }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || !res.ok) return { chainId: rpc.chainId, answer: null, error: `rpc answered ${res ? res.status : "nothing"}` };
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    const answer = json && !json.error ? readOracleAnswer(json.result) : null;
    return { chainId: rpc.chainId, answer, error: answer == null ? "unreadable answer" : null };
  } catch (e) {
    return { chainId: rpc.chainId, answer: null, error: String((e && e.message) || e) };
  } finally {
    if (guard != null) timers.clearTimeout(guard);
  }
}

/**
 * Is this address sanctioned, by the oracle? Never throws.
 * @returns {Promise<{ address: string, sanctioned: boolean|null, why: string|null, answers: object[] }>}
 *   sanctioned: true on any "yes", false when at least one chain answered and none said yes, null otherwise.
 */
export async function oracleSanctioned(address, {
  rpcs = SANCTIONS_RPCS, fetchImpl = globalThis.fetch, timers = defaultTimers, timeoutMs = SANCTIONS_TIMEOUT_MS,
} = {}) {
  if (typeof address !== "string" || !HEX40.test(address)) return { address: String(address), sanctioned: null, why: "not-evm", answers: [] };
  if (typeof fetchImpl !== "function" || !Array.isArray(rpcs) || rpcs.length === 0) {
    return { address, sanctioned: null, why: "no-rpc", answers: [] };
  }
  const answers = await Promise.all(rpcs.map((rpc) => askOne(rpc, address, { fetchImpl, timers, timeoutMs })));
  if (answers.some((a) => a.answer === true)) return { address, sanctioned: true, why: "listed", answers };
  if (answers.some((a) => a.answer === false)) return { address, sanctioned: false, why: null, answers };
  return { address, sanctioned: null, why: "unreadable", answers };
}

/** The words a refusal shows (plan §4). They name no list provider and never suggest a way round. */
export const SANCTIONS_WORDS = Object.freeze({
  listed: "This address can't be used. It appears on a sanctions or stolen-funds list. Contact support if you think this is a mistake.",
  unknown: "We couldn't run the safety check on this address just now, so nothing was priced. Try again in a moment.",
});
