// DEV ONLY: sample states of the Private Withdraw screen, for screenshots.
// ─────────────────────────────────────────────────────────────────────────────
//
// wallet/WithdrawPanel.jsx imports this file DYNAMICALLY, inside an
// `import.meta.env.DEV` branch, when the page carries ?ffPrivateWithdrawPreview=<kind>:
// a production build has no branch and no chunk for it (the build is grepped for
// PRIVATE_WITHDRAW_PREVIEW_MARK). Nothing here reaches the network and nothing
// signs: the quote service, Hyperliquid's info and the status endpoint are fakes
// below, and "Confirm and sign" is answered by a fake that never asks a wallet.
// A real (non-dry) quote reserves a one-time address and is never asked for here.
//
// The answers go through the REAL verifier, preflight, executor and journal
// (lib/intents/withdraw.js, withdrawJournal.js), so every figure and every block
// on screen is the one the live code would draw from such an answer. The figures
// are the live dry quotes of 2026-10-15 (scripts/fixtures/intents/
// dry-four-chains-2026-10-15.json: 20 USDC out to Base, fee 0.2053, refund fee
// 0.3153, ~37 s) and Hyperliquid's own preTransferCheck for a fresh address
// (fee "1.0"). The wallet is a placeholder (0x1111…); the one-time address and the
// typed recipient are the last 20 bytes of keccak256 of fixed strings: realistic
// on screen, nobody's key.
//
//   ?ffPrivateWithdrawPreview=
//     normal | normal-unsettled         Normal, with the toggle (and the notice an unsettled private one puts there)
//     form | form-private | form-own    the form with a price (preview label | confidential | own wallet typed)
//     form-own-arb                      the in-app wallet typed on Arbitrum (refused: it would land straight back)
//     review | review-short             the review (activation row) | the activation can't stay behind
//     sending | sent | arrived          the one window open | on its way | arrived
//     unknown | blocked                 a lost reply (not confirmed) | the next one blocked by it
//     sanctioned | paused | off | error the refusals (sanctions | route paused | switched off | day cap)

import { IntentsError } from "../../lib/intents/client.js";
import { PRIVATE_LIMITS } from "../../lib/intents/config.js";
import { quoteIntentsWithdraw, readWithdrawPreflight, executeIntentsWithdraw } from "../../lib/intents/withdraw.js";
import { createWithdrawJournal, recipientTag } from "../../lib/intents/withdrawJournal.js";
import { MODE_NORMAL, MODE_PRIVATE } from "./privateWithdrawView.js";

export const PRIVATE_WITHDRAW_PREVIEW_MARK = "ff-private-withdraw-preview-fixture";

const USER = "0x1111111111111111111111111111111111111111";
const ONE_TIME = "0xbE95F7774F20655D771556a6dFC62C2De6BF3967";
const RECIPIENT = "0x5Cf7d980F5B85BdA5E9CdDec35F1B003b6767372";
const HOUR = 3600e3;

const probeOf = (confidential, enabled = true) => (enabled
  ? { enabled: true, confidential, confidentiality: confidential ? "basic" : "public", limits: PRIVATE_LIMITS }
  : { enabled: false, confidential: false, confidentiality: null, limits: PRIVATE_LIMITS });

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/* The quote service, as it answered live: the echo of what was asked, the measured route's figures. */
function quoteAnswer(body) {
  const now = Date.now();
  const inUnits = BigInt(body.amount);
  const outMicro = inUnits / 100n - 205_300n;
  const minMicro = outMicro - inUnits / 10_000n;
  const real = body.dry === false;
  const deadline = new Date(Math.floor((now + 72 * HOUR) / 1000) * 1000).toISOString();
  return {
    quote: {
      amountIn: body.amount,
      minAmountIn: body.amount,
      amountOut: outMicro.toString(),
      minAmountOut: minMicro.toString(),
      timeEstimate: 37,
      refundFee: "31530000",
      withdrawFee: "5300",
      ...(real ? { deadline, timeWhenInactive: deadline, depositAddress: ONE_TIME } : {}),
    },
    quoteRequest: { ...body, depositMode: "SIMPLE", appFees: [] },
    signature: "ed25519:preview",
    timestamp: new Date(now).toISOString(),
    correlationId: PRIVATE_WITHDRAW_PREVIEW_MARK,
  };
}

const fakeQuoteFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  return { ok: true, status: 201, json: async () => quoteAnswer(body) };
};

/* Hyperliquid's info, as it answered live for a fresh address (fee "1.0", role "missing"). */
const fakeInfo = (withdrawable) => async (body) => {
  if (body.type === "preTransferCheck") return { isSanctioned: false, userExists: false, fee: "1.0", userHasSentTx: false };
  if (body.type === "userRole") return { role: "missing" };
  if (body.type === "clearinghouseState") return { withdrawable: String(withdrawable) };
  return [];
};

/* The follow-up: one reading after a moment, settled into the journal like the real tracker does (an arrived
   reading carries the delivered figure, as the status endpoint's amountOutFormatted does). */
const fakeTrack = (status, state, receive = null) => ({ depositAddress, journal, onUpdate }) => {
  const t = setTimeout(() => {
    if (state && journal) { try { journal.settle(depositAddress, state, { why: "preview" }); } catch { /* preview */ } }
    onUpdate({ status, mismatch: false, serviceStatus: null, receive });
  }, 400);
  return { stop: () => clearTimeout(t), refresh() {}, snapshot: () => null };
};

const refuse = (code, message, detail = null) => () => Promise.reject(new IntentsError(code, message, detail));

/** A record left "unknown" an hour ago (a lost reply), as the journal stores it. */
function unknownSeed(user) {
  const now = Date.now();
  const rec = {
    v: 1, id: ONE_TIME.toLowerCase(), token: "preview", state: "unknown", routeId: "base-usdc", recipientTag: recipientTag(RECIPIENT),
    amountRaw: "2000000000", accountFeeUsdc: 1, deadlineAt: now + 70 * HOUR, refundStartsAt: now, correlationId: null,
    confidentiality: "public", createdAt: now - HOUR, updatedAt: now - HOUR, sentAt: null, why: "not_confirmed",
  };
  return { [`flowflow.privateWithdraw.v1:${user}:${rec.id}`]: JSON.stringify(rec) };
}

/** The preview for `kind`, or null for an unknown kind. */
export function privateWithdrawPreview(kind) {
  const known = [
    "normal", "normal-unsettled", "form", "form-private", "form-own", "form-own-arb", "review", "review-short", "sending", "sent", "arrived",
    "unknown", "blocked", "sanctioned", "paused", "off", "error",
  ];
  if (!known.includes(kind)) return null;
  const seeded = kind === "blocked" || kind === "normal-unsettled";
  const storage = memStorage(seeded ? unknownSeed(USER) : {});
  const short = kind === "review-short";
  const withdrawable = short ? 20.5 : 152.84;

  let quote = (o) => quoteIntentsWithdraw({ ...o, screen: async () => ({ ok: true, code: null, message: null, results: [] }), fetchImpl: fakeQuoteFetch, quoteUrl: "/preview" });
  if (kind === "sanctioned") quote = refuse("sanctioned", "listed");
  if (kind === "paused") quote = refuse("intents-error", "Quoting for this pair is not available");
  if (kind === "error") quote = refuse("over-day-cap", "Over the day cap.", { max: 1000, left: 15 });

  let send = async () => ({ ok: true, amountUsdc: "20", nonce: 1 });
  if (kind === "sending") send = () => new Promise(() => {});
  if (kind === "unknown") send = async () => ({ ok: false, code: "not_confirmed", lost: true, retry: false, message: "Your withdrawal wasn't confirmed. Check your Perp balance before trying again: it was NOT sent twice." });

  const track = kind === "arrived" ? fakeTrack("arrived", "arrived", "19.7947")
    : kind === "unknown" ? fakeTrack("waiting", null)
      : fakeTrack("arriving", "arriving");

  const deps = Object.freeze({
    readProbe: async () => (kind === "off" ? probeOf(false, false) : probeOf(kind === "form-private")),
    quote,
    preflight: (o) => readWithdrawPreflight({ ...o, info: fakeInfo(withdrawable) }),
    execute: (o) => executeIntentsWithdraw(o),
    track,
    settle: async () => null,
    journal: (user, o = {}) => createWithdrawJournal({ user, storage, ...o }),
    now: () => Date.now(),
  });

  const auto = ["review", "review-short"].includes(kind) ? "review"
    : ["sending", "sent", "arrived", "unknown"].includes(kind) ? "confirm" : null;
  return {
    [PRIVATE_WITHDRAW_PREVIEW_MARK]: true,
    mode: kind === "normal" || kind === "normal-unsettled" ? MODE_NORMAL : MODE_PRIVATE,
    user: USER,
    walletType: "privy",
    /* The form checks the balance itself; the short review needs the preflight to be the one that says so. */
    withdrawableUsdc: short ? null : withdrawable,
    deps,
    sendIntentsDeposit: send,
    initial: kind === "blocked" ? null : {
      routeId: kind === "form-own-arb" ? "arbitrum-usdc" : "base-usdc",
      amountText: "20",
      toText: kind === "form-own" || kind === "form-own-arb" ? USER : RECIPIENT,
      auto,
      attested: true,
    },
  };
}
