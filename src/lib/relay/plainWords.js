// ─────────────────────────────────────────────────────────────────────────────
// THE WORDS THAT COME FROM SOMEWHERE ELSE, made plain before they reach a money
// screen. PURE: no React, no network, no env, no clock.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-23: "ไม่ต้องบอกด้วย ว่าใช้ Deposit ด้วย Relay" / "ไม่ต้องไปอ้าง
// Hyperliquid" / "ให้ใช้คำว่า Withdraw แทนคำว่า Relay". No money screen names the
// provider or the venue.
//
// Our own strings obey that by being written that way. Two kinds of message are
// NOT ours and still land on the glass verbatim: the trading layer's refusals on
// a money step (a refused signature, a request that timed out, a transfer it
// could not confirm) and the quote service's own error text on a deposit or a
// withdrawal. Both name themselves freely, so a screen that spells out no
// provider in its JSX can still print one.
//
// 🔴 ONE SCRUB, ONE HOME. The withdraw path and the deposit path both need it,
// so it lives here rather than one reaching into the other: lib/relay/withdraw.js
// re-exports it for the callers it already has, and lib/relay/depositAddress.js
// applies it where it wraps the service's own text.
//
// THE NAME GOES; THE DIAGNOSIS STAYS. "…didn't read this signature as coming
// from your wallet … said: Invalid chain" is what tells a user what happened,
// and all of it survives — only who said it is made plain.

/* A name that is part of a host name is left whole rather than cut in half
   (api.hyperliquid.xyz), and a determiner in front of the name is swallowed so
   the replacement does not double it ("the other Hyperliquid network" must not
   become "the other the trading service network"). */
const PROVIDER_NAMES = /(^|[^./@\w])((?:the|a|an|your|this|its|their)\s+(?:own\s+|other\s+)?)?(hyperliquid|hypercore|hyperevm|relay)('s)?\b(?!\.[a-z])/gi;

/* PRIVATE MODE'S PROVIDER (2026-10-15): near | 1click | defuse | chaindefuser |
   intents, the same shape (a host name left whole, the determiner swallowed). Its
   own pass, because "near" is also an English word ("near the limit"): only the
   capitalised name NEAR is the provider's, every other spelling of it is left be.
   lib/intents/client.js scrubs these where it throws; this catches any other path. */
const INTENTS_PROVIDER_NAMES = /(^|[^./@\w])((?:[Tt]he|[Aa]n?|[Yy]our|[Tt]his|[Ii]ts|[Tt]heir)\s+(?:own\s+|other\s+)?)?(NEAR(?:\s+[Ii]ntents)?|1-?[Cc]lick|[Dd]efuse|DEFUSE|[Cc]hain[Dd]efuser|CHAINDEFUSER|[Ii]ntents|INTENTS)('s)?(?:\s+(?:service|API))?\b(?!\.[a-z])/g;

/* The plain noun for each name, WITHOUT an article: the article is whatever the
   sentence already had, or "the" when it had none. */
const PLAIN = { relay: "withdrawal service", other: "trading service", intents: "private route service" };

/* "relay" is also an ordinary verb, and the quote service writes it that way
   ("Failed to relay the transaction"). A noun phrase there garbles the sentence,
   so a LOWERCASE relay in verb position becomes a verb. A proper noun is
   capitalised, which is what tells the two apart. */
const VERB_BEFORE = /\b(?:to|not|never|also|will|would|can|could|cannot|may|must|shall|should|might)\s+$/i;

/**
 * One borrowed message, with the provider's and the venue's names replaced by
 * what they are to the user, and every other word of it kept.
 * @param {unknown} text
 * @returns {string}
 */
export function plainMoneyWords(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  const out = s
    .replace(PROVIDER_NAMES, (m, pre, det, name, poss, offset, whole) => {
      const isRelay = /^relay$/i.test(name);
      if (isRelay && name === name.toLowerCase() && !det && VERB_BEFORE.test(whole.slice(0, offset + pre.length))) {
        return `${pre}forward${poss || ""}`;
      }
      const plain = isRelay ? PLAIN.relay : PLAIN.other;
      return det ? `${pre}${det}${plain}${poss || ""}` : `${pre}the ${plain}${poss || ""}`;
    })
    .replace(INTENTS_PROVIDER_NAMES, (m, pre, det, name, poss) => (det ? `${pre}${det}${PLAIN.intents}${poss || ""}` : `${pre}the ${PLAIN.intents}${poss || ""}`))
    .replace(/(^|[.!?]\s+)the /g, (m, pre) => `${pre}The `);
  /* A sentence that opened with a capital still opens with one. */
  return /^[a-z]/.test(out) && /^[A-Z]/.test(s) ? out[0].toUpperCase() + out.slice(1) : out;
}

export default plainMoneyWords;
