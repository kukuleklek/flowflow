// ─────────────────────────────────────────────────────────────────────────────
// THE PERP LEG OF THE PORTFOLIO TOTAL, and the ONE fold that adds it.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner decision, 2026-09-22, after testing the Perp mode on a phone:
//   "Balance กลางของหน้าหลัก ควร Recognize Perp Account ด้วยดิ Balance บน Perp อะ"
// The home balance (Portfolio) counts the Perp account. MONEY_RULES section 1:
//
//   Portfolio = wallet cash + every token holding + the Perp account
//   Cash      = the wallet's stablecoins, unchanged. Perp USDC is never Cash.
//
// PURE and a LEAF: no import, no env, no network, no clock. The node suites
// import it directly; the flag-off bundle drops it, because its only callers
// sit behind PERP_ENABLED (hooks/usePerpLeg.js, and usePortfolio's one fold).
//
// THE LEG is read from the account layer's own snapshot for the connected
// address (lib/hyperliquid/account, perpBalanceUsdc), never re-derived:
//   unified / portfolio margin   equityUsdc is the spot USDC total, which is
//                                the account's equity. The perp dex's figure is
//                                the same money: it is never added again.
//   standard (disabled, default, dexAbstraction)
//                                equityUsdc is the perp accountValue, and the
//                                USDC idle in spot (idleSpotUsdc, reported apart
//                                by the account layer) is the same Hyperliquid
//                                account's money: it is counted beside it.
// USDC is valued at par, as every stablecoin in this app is (usdValueOf).
//
// STATES (MONEY_RULES section 0: unknown is never 0, never silently omitted):
//   known     every part answered; usdc is the figure
//   settling  not answered yet (or a part still in flight): the answered part
//             counts, and the total carries the settling pulse until it lands
//   partial   answered but a floor (other collateral, USDC on another dex, or a
//             part that failed): counted, and the total is incomplete
//   unknown   nobody can read it (an API wallet, an unknown mode, a failed read
//             with nothing in flight): adds nothing, the total is incomplete
// A never-used address (userRole "missing") is a KNOWN 0.

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** The leg before anything has answered: the Perp chunk has not reported yet. */
export const PERP_LEG_UNREAD = Object.freeze({ state: "settling", usdc: null, reason: "perp-leg-unread" });

/* Reasons the account layer gives that no amount of waiting will change. */
const TERMINAL = new Set(["agent-address", "mode-unknown", "spot-unreadable", "perp-unreadable"]);

const leg = (state, usdc, reason) => Object.freeze({ state, usdc, reason: reason || null });

/** A leg nobody could read (the Perp chunk failed to load, for one). */
export function perpLegFailed(reason = "perp-leg-failed") {
  return leg("unknown", null, reason);
}

/**
 * The Perp leg from one account-layer snapshot (the store's frozen snapshot
 * for the connected address).
 * @param {object|null|undefined} snap
 * @returns {{ state: "known"|"settling"|"partial"|"unknown", usdc: number|null, reason: string|null }}
 */
export function perpLegOf(snap) {
  if (!snap || typeof snap !== "object") return PERP_LEG_UNREAD;
  const b = snap.perpBalanceUsdc && typeof snap.perpBalanceUsdc === "object" ? snap.perpBalanceUsdc : {};
  /* Still asking, or nothing has failed: an unanswered part may yet answer. */
  const working = snap.loading === true || !snap.error;
  if (b.answered === true && fin(b.equityUsdc)) {
    const standard = b.source === "perp" && b.reason !== "new-account";
    const idleKnown = !standard || fin(b.idleSpotUsdc);
    const usdc = b.equityUsdc + (standard && fin(b.idleSpotUsdc) ? b.idleSpotUsdc : 0);
    if (b.complete === false) return leg("partial", usdc, b.incompleteReason || "perp-leg-incomplete");
    if (b.complete === true && idleKnown) return leg("known", usdc, null);
    const why = !idleKnown ? "spot-unanswered" : b.incompleteReason || "perp-leg-pending";
    return leg(working ? "settling" : "partial", usdc, why);
  }
  if (TERMINAL.has(b.reason)) return leg("unknown", null, b.reason);
  return working ? leg("settling", null, b.reason || "perp-leg-unanswered") : leg("unknown", null, b.reason || "perp-leg-failed");
}

/** Two legs that say the same thing (null is OFF, and equal only to null). */
export function sameLeg(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state && Object.is(a.usdc, b.usdc) && a.reason === b.reason;
}

/**
 * THE ONE FOLD: the chain summary (portfolioScan summarizePortfolio) plus the
 * Perp leg. usePortfolio calls it once, behind PERP_ENABLED; every surface
 * prints the total it returns.
 *
 * No leg (undefined: flag off, or not the connected wallet's own store; null:
 * OFF, as under MOCK money) returns the SAME summary object: today's total.
 *
 * Added fields:
 *   chainValue     the chain total before the Perp leg (the pill's P&L % base)
 *   perpLeg        the leg that was folded
 *   totalSettling  true while the leg has not answered: print the total WITH
 *                  the settling pulse, never as final
 * Changed fields: totalValue (plus the leg's USDC), valueComplete (false when
 * the leg is partial or unknown), unpricedCount (plus one for such an account:
 * a real holding the total could not value). cashUsd is never touched.
 */
export function foldPerpLeg(summary, perpLeg) {
  if (perpLeg == null || !summary || typeof summary !== "object") return summary;
  const chain = summary.totalValue;
  const gap = perpLeg.state === "partial" || perpLeg.state === "unknown";
  return {
    ...summary,
    chainValue: chain,
    perpLeg,
    /* The chain leg decides whether there is a total at all: a Perp-only
       figure would publish an understatement as the Portfolio. */
    totalValue: chain == null ? null : chain + (fin(perpLeg.usdc) ? perpLeg.usdc : 0),
    valueComplete: summary.valueComplete === true && !gap,
    unpricedCount: (summary.unpricedCount || 0) + (gap ? 1 : 0),
    totalSettling: perpLeg.state === "settling",
  };
}

const normAddr = (a) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null);

/**
 * The bridge between the lazy Perp chunk (which reads the account layer) and
 * usePortfolio (which folds): one leg per address. An address nobody has fed
 * reads PERP_LEG_UNREAD, so the total pulses from the first frame instead of
 * printing a chain-only figure that later jumps. null is OFF (nothing to fold).
 */
export function createPerpLegStore() {
  const legs = new Map();
  const fns = new Set();
  return {
    get(address) {
      const a = normAddr(address);
      if (!a) return null;
      return legs.has(a) ? legs.get(a) : PERP_LEG_UNREAD;
    },
    set(address, next) {
      const a = normAddr(address);
      if (!a) return;
      const value = next == null ? null : next;
      if (legs.has(a) && sameLeg(legs.get(a), value)) return;
      legs.set(a, value);
      for (const fn of [...fns]) { try { fn(); } catch { /* a listener's bug stays its own */ } }
    },
    subscribe(fn) {
      fns.add(fn);
      return () => { fns.delete(fn); };
    },
  };
}

let tabStore = null;
/** The tab's one bridge, created on first use (importing this file does nothing). */
export function perpLegStore() {
  if (!tabStore) tabStore = createPerpLegStore();
  return tabStore;
}
