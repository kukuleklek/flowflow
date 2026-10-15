// DEV ONLY: sample states of the Private Deposit screen, for screenshots.
// ─────────────────────────────────────────────────────────────────────────────
//
// wallet/DepositPanel.jsx imports this file DYNAMICALLY, inside an
// `import.meta.env.DEV` branch, when the page carries ?ffPrivatePreview=<kind>:
// a production build has no branch and no chunk for it (the build is grepped for
// PRIVATE_PREVIEW_MARK). Nothing here reaches the network: every outside call the
// hook makes is a fake below, and "Get address" is answered by a fixture — a
// non-dry quote reserves a real one-time address and is never asked for here.
//
// The figures are the live dry quotes of 2026-10-15 (scripts/fixtures/intents:
// 25 USDC Arbitrum → perps: out 24.6847, minimum 24.434753, fee 0.3153, refund
// fee 0.0053, ~35 s). The wallet is a placeholder (0x1111…) and the one-time
// address is the last 20 bytes of keccak256("flowflow.private-preview.one-time-address"):
// realistic on screen, nobody's key.
//
//   ?ffPrivatePreview=
//     form | form-arb | form-external   the form (refund words: needs gas | auto | own wallet)
//     address | avalanche | private     an address on screen (Arbitrum | Avalanche | confidential probe)
//     watch | used | incomplete         the address after the watch saw a row (arriving | credited |
//                                       less than quoted, past showUntil: the row stays on screen)
//     expired                           past showUntil with nothing seen at it
//     error | sanctioned | off | paused the refusals (day cap | sanctions | switched off | route paused)
//     recover                           the Recover rows (Base / Polygon) on Private, with a signer
//     recover-normal | recover-off      the same rows on Normal, and on the switched-off screen
//     recover-refused                   a confirm the signer refused before the wallet was asked
//
// Recover's fixture signer is a function that names the placeholder wallet and
// refuses: it is never called (the fixture's execute answers by itself), and it
// could not sign if it were. The review figures are the live 10 USDC quotes of
// 2026-10-15 (scripts/fixtures/recover: Base 9.97678, Polygon 9.974281).

import { IntentsError } from "../../lib/intents/client.js";
import { PRIVATE_LIMITS } from "../../lib/intents/config.js";
import { RECOVER_WORDS } from "../../lib/relay/recoverStranded.js";
import { createDepositWatch } from "./depositWatch.js";

export const PRIVATE_PREVIEW_MARK = "ff-private-preview-fixture";

const USER = "0x1111111111111111111111111111111111111111";
const ADDRESS = "0x5C91f262F40DB5dac4320C0B8002a5a9360C773B";

const probeOf = (confidential) => ({
  enabled: true,
  confidential,
  confidentiality: confidential ? "basic" : "public",
  limits: PRIVATE_LIMITS,
});

function dryOf({ route, plan, amountRaw, confidentiality }) {
  const amountIn = Number(amountRaw) / 1e6;
  /* The measured route: a flat 0.3153 withdraw fee into perps, 1 % slippage on the guarantee. */
  const amountOut = Math.round((amountIn - 0.3153) * 1e6) / 1e6;
  return {
    plan: plan.id,
    provider: "near",
    depositAddress: null,
    amountIn,
    amountInRaw: String(amountRaw),
    symbolIn: "USDC",
    amountOut,
    minAmountOut: Math.round((amountOut - amountIn * 0.01) * 1e6) / 1e6,
    symbolOut: "USDC",
    feeUsdc: 0.3153,
    withdrawFeeUsdc: 0.3153,
    refundFeeUsdc: 0.0053,
    platformFeeBps: 0,
    timeEstimateSec: route.id === "arbitrum-usdc" ? 35 : 45,
    signatureVerified: false,
    confidentiality,
    private: confidentiality !== "public",
    route,
    [PRIVATE_PREVIEW_MARK]: true,
  };
}

function addressOf(ask, now, { gone = false } = {}) {
  const d = dryOf(ask);
  const expiresAt = gone ? now + 5 * 3600e3 : now + 72 * 3600e3;
  return {
    ...d,
    depositAddress: ADDRESS,
    expiresAt,
    inactiveAt: expiresAt,
    showUntil: gone ? now - 1000 : expiresAt - 6 * 3600e3,
    quotedAt: now,
    fromCache: false,
    watch: Object.freeze({ address: ADDRESS, routeId: ask.route.id, planId: ask.plan.id, provider: "near" }),
  };
}

/* A watch with the real logic and a fake service: it answers `rows` once. */
function fakeWatch(rows) {
  const fake = ({ depositAddress, onUpdate }) => {
    const t = setTimeout(() => onUpdate({ depositAddress, state: "ok", requests: rows, checkedAt: Date.now(), error: null }), 250);
    return { stop() { clearTimeout(t); }, refresh() { return true; }, snapshot() { return null; } };
  };
  return createDepositWatch({ track: fake, trackers: { near: fake }, storage: null });
}

/* The Recover rows' outside world, faked: two refunds of 10 USDC, the live review figures, a signer that never signs. */
function recoverFixture(kind) {
  const review = (chainId, chainName, receiveUsdc) => ({
    kind: "recover", own: USER, chainId, chainName, amountRaw: "10000000", amountUsdc: "10",
    receiveUsdc, costUsdc: (10 - Number(receiveUsdc)).toFixed(6), signatures: [], [PRIVATE_PREVIEW_MARK]: true,
  });
  return {
    ready: true,
    deps: {
      read: () => Promise.resolve([
        { chainId: 8453, chainName: "Base", chainLogo: "/chain-logos/8453.png?v=23cba86abd", raw: 10000000n, usdc: 10, offered: true },
        { chainId: 137, chainName: "Polygon", chainLogo: "/chain-logos/137.png?v=91593164ff", raw: 10000000n, usdc: 10, offered: true },
      ]),
      quote: ({ chainId }) => new Promise((res) => setTimeout(() => res(chainId === 137 ? review(137, "Polygon", "9.974281") : review(8453, "Base", "9.97678")), 200)),
      execute: () => new Promise((res) => setTimeout(() => res(kind === "recover-refused"
        ? { ok: false, code: "refused", state: "cancelled", message: RECOVER_WORDS.refused }
        : { ok: true, requestId: "0xpreview", state: "arriving" }), 400)),
      used: () => Promise.resolve(null),
      journal: null,
      signer: Object.assign(() => Promise.reject(new Error("preview: nothing signs here")), { address: USER }),
    },
  };
}

/** One sample state: { user, walletType, mode, deps, initial, recover }, or null for an unknown kind. */
export function privatePreview(kind) {
  const now = Date.now();
  const confidential = kind === "private";
  const recovering = typeof kind === "string" && kind.startsWith("recover");
  const row = (status, extra = {}) => ({ id: `near:${ADDRESS.toLowerCase()}`, provider: "near", status, amountIn: 25, symbolIn: "USDC", inChainId: 42161, createdAt: now - 40000, updatedAt: now - 40000, ...extra });
  const rows = kind === "watch" ? [row("arriving")]
    : kind === "used" ? [row("credited", { amountOut: 24.6847, symbolOut: "USDC" })]
      : kind === "incomplete" ? [row("incomplete", { amountIn: 24, refundAfter: now + 5 * 3600e3 })]
        : [];
  const fail = (code, message, detail = null) => () => Promise.reject(new IntentsError(code, message, detail));
  const deps = {
    readProbe: () => Promise.resolve(kind === "recover-off" ? { ...probeOf(false), enabled: false } : probeOf(confidential)),
    choosePlan: () => Promise.resolve(kind === "form-arb" ? { planId: "private-arb", gasWei: 10n ** 15n } : { planId: "private-core", gasWei: kind === "form-external" ? null : 0n }),
    quote: kind === "paused" ? fail("intents-error", "Quoting for this pair is not available")
      : (ask) => new Promise((res) => setTimeout(() => res(dryOf(ask)), 150)),
    getAddress: kind === "error" ? fail("over-day-cap", "Private moves are limited to 1000 USDC a day.", { max: 1000, left: 15 })
      : kind === "off" ? fail("private-mode-off", "Private mode is off.")
        : kind === "sanctioned" ? fail("sanctioned", "This address can't be used.")
          : (ask) => Promise.resolve(addressOf(ask, now, { gone: kind === "expired" || kind === "incomplete" })),
    forget: () => 0,
    watch: fakeWatch(rows),
    now: () => Date.now(),
  };
  const known = ["form", "form-arb", "form-external", "address", "avalanche", "private", "error", "sanctioned", "off", "paused", "watch", "used", "expired", "incomplete",
    "recover", "recover-normal", "recover-off", "recover-refused"];
  if (!known.includes(kind)) return null;
  /* The in-app wallet's Recover signer, as PrivyBridge provides it (naming the wallet it signs for; it never signs
     here). An outside wallet has none, so Base, Polygon and the Recover rows are not offered to it (recoverReadyFor). */
  const external = kind === "form-external";
  const recoverSigner = external ? null
    : recovering ? recoverFixture(kind).deps.signer
      : Object.assign(() => Promise.reject(new Error("preview: nothing signs here")), { address: USER });
  return {
    user: USER,
    walletType: external ? "external" : "privy",
    recoverSigner,
    mode: kind === "recover-normal" ? "normal" : "private",
    deps,
    initial: {
      routeId: kind === "avalanche" ? "avalanche-usdc" : "arbitrum-usdc",
      amountText: "25",
      /* Press "Get address" once for these (the fixture answers it). */
      press: ["address", "avalanche", "private", "error", "sanctioned", "off", "watch", "used", "expired", "incomplete"].includes(kind),
      attested: true,
    },
    recover: recovering ? recoverFixture(kind) : null,
  };
}
