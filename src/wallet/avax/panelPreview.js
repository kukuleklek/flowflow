// DEV ONLY (the Spot panels' ?ffAvaxPanelPreview=…): a sample action state per panel, so the review, progress and
// receipt states — which need a signed-in Privy wallet and a live quote — can be looked at and screenshotted on a
// local server. Only reached behind `import.meta.env.DEV` (AvaxPanels.jsx), so a production build drops this file,
// the same way usePortfolio drops portfolioPreview.js.
//
// 🔴 NOTHING HERE CAN MOVE MONEY. The sample's price / refresh / confirm / close do nothing at all: they never reach
// src/avax/money.js, a signer or the network. The figures are the 2 USDC live dry run's (scratchpad avaxsign/dryrun.out,
// 2026-10-15) and are never shown as real outside a dev server.
//
//   ?panel=move-in&ffAvaxPanelPreview=review      phases: pricing | review | blocked | requote | running | arriving |
//                                                          done | unknown | failed | expired

const row = (key, label, value, note = null) => Object.freeze({ key, label, value, note });
const noop = () => null;
const noopAsync = async () => null;
const HASH_A = "0x3f1c9e0a5b7d2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
const HASH_B = "0x9a8b7c6d5e4f30211203a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
const REQ = "0x5e2d1c0b9a8f7e6d5c4b3a29180716253443526170819a0b1c2d3e4f5a6b7c8d";
/* The "Goes to" row money.js prints from the signers' own address (plan §3.8.6), shortened — a sample, never real. */
const TO = "0x7a3f…c1e9 ✓ your wallet";

const SAMPLES = {
  "move-in": {
    title: "Move to your Spot Account", amountText: "2 USDC", receiveText: "2 USDC", windows: 2,
    gasText: "includes ≈0.0208 AVAX for gas (≈$0.20)",
    rows: [
      row("amount", "You move", "2 USDC"),
      row("debit", "Leaves your Main Account", "2.244594 USDC", "at most 2.55 USDC"),
      row("fee", "Fee", "0.044594 USDC"),
      row("gas", "Gas for later", "≈0.0208 AVAX ($0.20) · stays in your Spot Account"),
      row("receive", "Arrives in your Spot Account", "2 USDC", "exactly"),
      row("to", "Goes to", TO, "your Spot Account"),
      row("time", "Time", "≈1–2 min"),
      row("windows", "Signatures", "2 signatures in your wallet"),
    ],
    stages: [["authorize", "Approve the move"], ["send", "Leave your Main Account"], ["arrive", "Arrive in your Spot Account"]],
    done: { message: "Arrived in your Spot Account.", requestId: REQ, receiptText: "Spot Account USDC +2.000000" },
  },
  "move-out": {
    title: "Move to your Main Account", amountText: "2 USDC", receiveText: "1.968841 USDC", windows: 1, route: "permit", exit: true,
    rows: [
      row("amount", "You move", "2 USDC"),
      row("fee", "Fee", "0.031159 USDC"),
      row("network", "Network fee", "None, no AVAX needed"),
      row("receive", "Arrives in your Main Account", "1.968841 USDC", "at least 1.902884 USDC"),
      row("to", "Goes to", TO, "your Main Account, the same address"),
      row("time", "Time", "≈1–2 min"),
      row("windows", "Signatures", "1 signature in your wallet"),
    ],
    stages: [["sign0", "Sign the move"], ["send", "Leave your Spot Account"], ["arrive", "Arrive in your Main Account"]],
    done: { message: "Arrived in your Main Account.", requestId: REQ },
  },
  stake: {
    title: "Stake USDC in Aave", amountText: "2 USDC", receiveText: "2 USDC in Aave", windows: 2,
    rows: [
      row("amount", "You stake", "2 USDC"),
      row("apy", "APY now", "5.78%", "Aave V3 on Avalanche, it changes"),
      row("fee", "Fee", "No fee"),
      row("network", "Network fee", "up to ≈0.0045 AVAX ($0.04)", "paid in AVAX from your Spot Account"),
      row("receive", "Goes into", "Aave on Avalanche"),
      row("to", "Goes to", TO, "Aave holds it for this wallet"),
      row("windows", "Signatures", "2 signatures in your wallet"),
    ],
    stages: [["approve", "Allow exactly 2 USDC for Aave"], ["supply", "Supply 2 USDC to Aave on Avalanche"]],
    done: { message: "2 USDC is in Aave.", txHashes: [HASH_A, HASH_B], receiptText: "Aave USDC +2.000000" },
  },
  unstake: {
    title: "Unstake USDC from Aave", amountText: "All your USDC in Aave", receiveText: "250.123456 USDC in your Spot Account", windows: 1, exit: true,
    rows: [
      row("amount", "You unstake", "250.123456 USDC (all, with interest to the second)"),
      row("fee", "Fee", "No fee"),
      row("network", "Network fee", "up to ≈0.0066 AVAX ($0.06)", "paid in AVAX from your Spot Account"),
      row("receive", "Arrives in", "Your Spot Account"),
      row("to", "Goes to", TO, "your Spot Account"),
      row("windows", "Signatures", "1 signature in your wallet"),
    ],
    stages: [["withdraw", "Withdraw all your USDC from Aave"]],
    done: { message: "All your USDC is back in your Spot Account.", txHashes: [HASH_A], receiptText: "Spot Account USDC +250.123456" },
  },
  swap: {
    title: "Swap USDC to BTC.b", amountText: "2 USDC", receiveText: "0.00002452 BTC.b", minimumText: "0.00002427 BTC.b", windows: 2,
    rows: [
      row("amount", "You swap", "2 USDC"),
      row("fee", "Fee", "0.004 USDC"),
      row("network", "Network fee", "up to ≈0.0061 AVAX ($0.06)", "paid in AVAX from your Spot Account"),
      row("receive", "You get about", "0.00002452 BTC.b"),
      row("minimum", "Minimum received", "0.00002427 BTC.b", "if the price moves more, nothing is swapped"),
      row("to", "Goes to", TO, "your Spot Account"),
      row("loss", "Worst case vs market", "1.21%"),
      row("time", "Time", "≈2 s"),
      row("windows", "Signatures", "2 signatures in your wallet"),
    ],
    stages: [["approve", "Allow exactly 2 USDC for this swap"], ["swap", "Swap 2 USDC for at least 0.00002427 BTC.b"]],
    done: { message: "Swapped 2 USDC: BTC.b +0.00002449", txHashes: [HASH_A, HASH_B], receiptText: "BTC.b +0.00002449" },
  },
};

function review(kind, s, { confirmable = true, whyNot = null } = {}) {
  const now = Date.now();
  return Object.freeze({
    kind, id: `preview-${kind}`, title: s.title, exit: !!s.exit, route: s.route || null, confirmable, whyNot,
    amount: "2", symbol: "USDC", amountText: s.amountText, receiveText: s.receiveText, minimumText: s.minimumText || null,
    feeText: "—", gasText: s.gasText || null, gasRowText: null, networkFeeText: null, timeText: "≈30 s",
    windows: s.windows, windowsText: `${s.windows} signature${s.windows === 1 ? "" : "s"} in your wallet`,
    quotedAt: now, expiresAt: now + 60_000, liq: [], warnings: Object.freeze([]), rows: Object.freeze(s.rows),
    stages: Object.freeze(s.stages.map(([key, label]) => Object.freeze({ key, label, state: "todo" }))),
  });
}

const progressAt = (r, active, mark = "active") => r.stages.map((s, i) => ({ ...s, state: i < active ? "done" : i === active ? mark : "todo" }));

const cache = new Map();

/** The sample action for `kind` under ?ffAvaxPanelPreview=, or null (no param / not a dev server / unknown phase). */
export function panelPreview(kind) {
  if (typeof window === "undefined") return null;
  let phase = null;
  try { phase = new URLSearchParams(window.location.search).get("ffAvaxPanelPreview"); } catch { phase = null; }
  const s = SAMPLES[kind];
  if (!phase || !s) return null;
  const key = `${kind}:${phase}`;
  if (cache.has(key)) return cache.get(key);
  const base = { ready: true, why: null, note: null, canConfirm: false, price: noopAsync, refresh: noopAsync, confirm: noop, close: noop };
  const r = review(kind, s);
  const last = r.stages.length - 1;
  let out;
  switch (phase) {
    case "pricing": out = { ...base, phase: "pricing", review: null, progress: null, outcome: null }; break;
    case "review": out = { ...base, phase: "review", review: r, progress: r.stages, outcome: null, canConfirm: true }; break;
    case "blocked": {
      const b = review(kind, s, { confirmable: false, whyNot: kind === "move-in" ? "More than you can move from your Main Account right now" : "Not enough USDC in your Spot Account" });
      out = { ...base, phase: "review", review: b, progress: b.stages, outcome: null };
      break;
    }
    case "requote":
      out = { ...base, phase: "review", review: r, progress: r.stages, canConfirm: true,
        outcome: { ok: false, state: "cancelled", needsConfirm: true, code: "requote-worse", message: "The price changed from the one you confirmed. Check the new one. Nothing moved.", review: r } };
      break;
    case "running": out = { ...base, phase: "running", review: r, progress: progressAt(r, Math.min(1, last)), outcome: null }; break;
    case "arriving":
      out = { ...base, phase: "arriving", review: r, progress: progressAt(r, last), note: { text: kind === "move-out" ? "On its way to your Main Account." : "On its way to your Spot Account.", href: null },
        outcome: { ok: true, state: "arriving", message: "On its way.", requestId: REQ } };
      break;
    case "done":
      out = { ...base, phase: "done", review: r, progress: r.stages.map((x) => ({ ...x, state: "done" })), outcome: { ok: true, state: "done", ...s.done } };
      break;
    case "unknown":
      out = { ...base, phase: "unknown", review: r, progress: progressAt(r, Math.min(1, last), "unknown"),
        outcome: { ok: false, state: "unknown", unknown: true, code: "not_confirmed", message: "Not confirmed yet. Don't send it again.",
          whereToLook: { text: "Check your Main Account and your Spot Account before moving again. Don't send it again.", href: null }, requestId: REQ } };
      break;
    case "failed":
      out = { ...base, phase: "failed", review: r, progress: progressAt(r, 0, "failed"), outcome: { ok: false, state: "cancelled", code: "cancelled", message: "Cancelled. Nothing moved." } };
      break;
    case "expired":
      out = { ...base, phase: "failed", review: r, progress: progressAt(r, 0, "failed"), outcome: { ok: false, state: "cancelled", code: "price_expired", message: "Price expired. Nothing moved." } };
      break;
    default: out = null;
  }
  const frozen = out ? Object.freeze(out) : null;
  cache.set(key, frozen);
  return frozen;
}
