// The Pending popup's words: ONE box about the customer's deposit, on every page.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ตอน Deposit Asset Pending อยู่ ต้องมีขึ้นบนจอด้วยดิ เป็นกล่อง
// popup ว่า Pending". While a deposit is on its way, while its last hop moves it,
// and once it is there, a box says so wherever the customer is
// (perp/deposit/DepositStatus.jsx draws it).
//
// It reads three things that already exist, and invents nothing:
//   • the deposit watch's one deposit for this wallet (depositWatch's
//     pickDepositStatus), in the Deposit panel's own words (perpDepositView's
//     depositStatusView over depositRowView), so the box and the panel's rows
//     can never print one deposit two ways;
//   • the tab's one move (perpFunding's fundingStep), the same answer the
//     panel's move line reads;
//   • whether a Deposit panel is open right now: then the panel is saying all of
//     it, and the box says nothing.
//
// WHAT IT SAYS, in priority order (one box, never two):
//   moving       "Moving 9.92 USDC into your Perp account…"   live mark
//   move-failed  "9.92 USDC is waiting in your wallet" + Move it now   stays, ×
//   sent         "+9.92 USDC on its way to your Perp account"  check, leaves
//   arriving     "Deposit pending · 20 USDC from Base"         live mark
//   credited     "+9.92 USDC in your Perp account"             check, leaves
//   landed       "+9.92 USDC landed in your wallet"            stays, ×
//   short        "4.2 USDC is waiting in your wallet"          stays, ×
//   incomplete   "Deposit will be refunded" · less than quoted stays, ×
//   refunded     "Deposit refunded"                            stays, ×
//   failed       "Deposit didn't go through"                   stays, ×
//
// PRIVATE ROWS (provider "near") read the same, with three differences: an
// INCOMPLETE one (less arrived than quoted) has its own lingering box, never a
// credit, closed under its own name (incompleteAckId) so the refund after it is
// still announced; a private-arb landing reads "arrived", then the auto-move; and
// a refund names where it really went (Avalanche: the Spot Account; Base and
// Polygon: the wallet there, which Deposit's Recover moves in).
//
// 🔴 "IN YOUR PERP ACCOUNT" ONLY WHEN IT IS. A deposit on the direct plan that
// is credited IS in the Perp account. The last hop of the first-deposit plan is
// a transfer that has been SENT, which the deposit contract credits shortly
// after: that is "on its way", the same words the panel's row uses
// (FIRST_HOP_PHASES_MOVED), and never a claim the app has not seen happen.
//
// NO PROVIDER, NO VENUE, NO PLUMBING (owner, 2026-09-23 / 2026-09-27). The
// landing network is named only where the customer's money sits there and may
// need them.
//
// No React, no network: plain values in, one view out. Tested in Node.

import { DASH } from "../../lib/format.js";
import { routeById, DEPOSIT_CHAINS, DEPOSIT_TOKENS } from "../../lib/relay/routes.js";
import { BRIDGE_MIN_USDC } from "../../lib/relay/arbitrumBridge.js";
import { FIRST_HOP_LANDING } from "../../lib/relay/firstDeposit.js";
import { depositStatusView, planIsFirstHop, incompleteLabel, incompleteAckId } from "./perpDepositView.js";
import { PRIVATE_ARB_PLAN_ID, PROVIDER_NEAR } from "../../lib/intents/config.js";
import { moveAmountText } from "./firstDepositMove.js";

/** Where a tap on the box goes: the Deposit panel. */
export const DEPOSIT_POPUP_GO = "/wallet?panel=deposit";
/** A box that leaves by itself does so after this long on a VISIBLE tab. */
export const DEPOSIT_POPUP_LEAVE_MS = 6000;

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lc = (a) => (isAddr(a) ? a.toLowerCase() : null);

/** Is a Deposit panel showing an address for this wallet right now? (depositWatch's held) */
export function depositPanelOpen(watchState, user) {
  const who = lc(user);
  if (!who || !watchState || !Array.isArray(watchState.entries)) return false;
  return watchState.entries.some((e) => e && e.user === who && e.held);
}

/** The token's own logo, or null. */
export function tokenLogoOf(symbol) {
  const t = DEPOSIT_TOKENS.find((x) => x.symbol === symbol);
  return t ? t.logo : null;
}

/* The figure as the move line prints it ("9.92 USDC"), or null when unknown:
   the box then says "your deposit" rather than a dash in a sentence. */
function moveFigure(usdc) {
  const t = moveAmountText(usdc);
  return t === DASH ? null : t;
}

/* The chain a deposit came from: its name and its logo, from the row's own
   origin chain first, the route's otherwise. */
function originOf(row, route) {
  const c = row && DEPOSIT_CHAINS[row.inChainId];
  if (c) return { chainId: c.id, chainName: c.name, chainLogo: c.logo };
  if (route) return { chainId: route.chainId, chainName: route.chainName, chainLogo: route.chainLogo };
  return { chainId: null, chainName: null, chainLogo: null };
}

const from = (o) => (o.chainName ? `from ${o.chainName}` : "");

function makeBox(kind, fields) {
  const v = {
    kind,
    key: kind,
    title: "",
    sub: "",
    amount: null,
    token: "USDC",
    tokenLogo: tokenLogoOf("USDC"),
    chainId: null,
    chainName: null,
    chainLogo: null,
    live: false,
    check: false,
    alert: false,
    lingers: false,
    leaves: false,
    action: null,
    go: DEPOSIT_POPUP_GO,
    ackRow: null,
    ackMove: false,
    ...fields,
  };
  if (fields.token) v.tokenLogo = tokenLogoOf(fields.token);
  v.text = v.sub ? `${v.title} · ${v.sub}` : v.title;
  return Object.freeze(v);
}

/**
 * The one box to draw, or null for none.
 *
 *   user     the wallet on screen (none: no box)
 *   pick     depositWatch's pickDepositStatus(state, user), or null
 *   held     a Deposit panel is open for this wallet (depositPanelOpen)
 *   move     perpFunding's fundingStep(state, user, { canAuto }) for this wallet
 *
 * The box carries what to acknowledge when it is closed or leaves:
 * ackRow { address, id } is the watch's row (depositWatch.dismiss), ackMove the
 * runner's last move (perpFunding.acknowledge).
 */
export function depositPopupView({ user = null, pick = null, held = false, move = null } = {}) {
  if (!lc(user) || held) return null;
  const m = move || { step: "idle", usdc: null, code: null, acked: true, balanceRead: false, balanceRaw: null, checking: false };
  const route = pick ? routeById(pick.routeId) : null;
  const row = pick && route ? pick.row : null;
  const sv = row ? depositStatusView(row, route, pick.planId) : null;
  const origin = originOf(row, route);
  /* An INCOMPLETE row is closed under its own name: the refund that follows it keeps the row's id and is news again. */
  const rowAck = row && typeof row.id === "string" && row.status !== "arriving"
    ? { address: pick.address, id: row.status === "incomplete" ? incompleteAckId(row.id) : row.id }
    : null;
  const isPrivate = !!(pick && pick.provider === PROVIDER_NEAR);
  const fig = moveFigure(m.usdc);
  const firstHop = !!(pick && planIsFirstHop(pick.planId));
  const landedHere = !!(sv && row.status === "credited" && firstHop);
  /* Every box carries the move it was drawn from, so closing it acknowledges
     that move and never a newer one that started meanwhile. */
  const box = (kind, fields) => makeBox(kind, { moveSeq: Number.isFinite(m.seq) ? m.seq : 0, ...fields });
  /* A move's box names the deposit's chain only when that deposit IS the money
     being moved (another deposit still on its way is not). */
  const moveOrigin = landedHere ? origin : {};

  /* 1. The last hop, in flight: the one thing on screen that is moving money. */
  if (m.step === "sending") {
    return box("moving", {
      key: `moving:${m.seq}`,
      title: fig ? `Moving ${fig} into your Perp account…` : "Moving your deposit into your Perp account…",
      sub: landedHere && origin.chainName ? `Deposit ${from(origin)} · no action needed` : "No action needed",
      amount: fig,
      ...moveOrigin,
      live: true,
    });
  }

  /* 2. A move that did not go, or an attempt that never answered: the money is
     the customer's, it is sitting in their wallet, and it takes a press. */
  if ((m.step === "failed" || m.step === "again") && !m.acked) {
    let sub = "Its move into your Perp account didn't finish.";
    if (m.step === "failed") {
      sub = m.code === "no-gas"
        ? `Moving it needs a little ${FIRST_HOP_LANDING} gas there, and there is none yet.`
        : "The move into your Perp account didn't go through.";
    }
    return box("move-failed", {
      key: `move-failed:${m.seq}:${m.step}`,
      title: fig ? `${fig} is waiting in your wallet` : "Your deposit is waiting in your wallet",
      sub,
      amount: fig,
      ...moveOrigin,
      alert: true,
      lingers: true,
      action: "Move it now",
      ackMove: true,
      ackRow: landedHere ? rowAck : null,
    });
  }

  /* 3. The move went: sent, and the deposit contract credits it shortly. */
  if (m.step === "sent" && !m.acked) {
    return box("sent", {
      key: `sent:${m.seq}`,
      title: fig ? `+${fig} on its way to your Perp account` : "Your deposit is on its way to your Perp account",
      sub: landedHere && origin.chainName ? `Deposit ${from(origin)}` : "Moved from your wallet",
      amount: fig ? `+${fig}` : null,
      ...moveOrigin,
      check: true,
      leaves: true,
      ackMove: true,
      ackRow: landedHere ? rowAck : null,
    });
  }

  if (sv) {
    /* 4. On its way to us. */
    if (row.status === "arriving") {
      const amt = sv.amount === DASH ? sv.token : sv.amount;
      return box("arriving", {
        key: `arriving:${sv.key}`,
        title: "Deposit pending",
        sub: origin.chainName ? `${amt} ${from(origin)}` : amt,
        amount: sv.amount === DASH ? null : sv.amount,
        token: sv.token,
        ...origin,
        live: true,
      });
    }
    if (row.status === "credited") {
      const amt = sv.amount === DASH ? null : sv.amount;
      /* 5. The direct plan: credited means in the Perp account. */
      if (!firstHop) {
        return box("credited", {
          key: `credited:${sv.key}`,
          title: amt ? `${amt} in your Perp account` : "Your deposit is in your Perp account",
          sub: origin.chainName ? `Deposit ${from(origin)}` : "Deposit",
          amount: amt,
          token: sv.token,
          ...origin,
          check: true,
          leaves: true,
          ackRow: rowAck,
        });
      }
      /* 6. The first-deposit plan: landed in the customer's own wallet, and the
         last hop is what happens next. */
      if (m.step === "auto") {
        const f = fig || (amt ? amt.replace(/^\+/, "") : null);
        return box("moving", {
          key: `moving:auto:${sv.key}`,
          title: f ? `Moving ${f} into your Perp account…` : "Moving your deposit into your Perp account…",
          sub: origin.chainName ? `Deposit ${from(origin)} · no action needed` : "No action needed",
          amount: f,
          token: sv.token,
          ...origin,
          live: true,
        });
      }
      if (m.step === "short") {
        return box("short", {
          key: `short:${sv.key}`,
          title: fig ? `${fig} is waiting in your wallet` : "Your deposit is waiting in your wallet",
          sub: `It takes ${BRIDGE_MIN_USDC} USDC to move into your Perp account.`,
          amount: fig,
          ...origin,
          alert: true,
          lingers: true,
          ackRow: rowAck,
        });
      }
      /* Read, and nothing there: the money has already left the wallet, and
         the only way out of it is the move into the Perp account. */
      if (m.step === "idle" && m.balanceRead && m.balanceRaw === 0n) {
        return box("sent", {
          key: `sent:row:${sv.key}`,
          title: amt ? `${amt} on its way to your Perp account` : "Your deposit is on its way to your Perp account",
          sub: origin.chainName ? `Deposit ${from(origin)}` : "Deposit",
          amount: amt,
          token: sv.token,
          ...origin,
          check: true,
          leaves: true,
          ackRow: rowAck,
        });
      }
      /* Not read yet, unreadable, or the wallet cannot sign by itself just now:
         it landed (the row says so) and nothing more is claimed. A Private
         deposit was paid from somewhere else, so "your wallet" would read as
         money bounced back: it "arrived", and the move is what comes next. */
      if (isPrivate && pick.planId === PRIVATE_ARB_PLAN_ID) {
        const looking = m.checking || !m.balanceRead;
        return box("landed", {
          key: `landed:${sv.key}`,
          title: amt ? `${amt} arrived` : "Your deposit arrived",
          sub: looking ? "Moving to your Main Account · no action needed" : "Waiting to move to your Main Account",
          amount: amt,
          token: sv.token,
          ...origin,
          live: looking,
          lingers: !looking,
          ackRow: rowAck,
        });
      }
      return box("landed", {
        key: `landed:${sv.key}`,
        title: amt ? `${amt} landed in your wallet` : "Your deposit landed in your wallet",
        sub: origin.chainName ? `Deposit ${from(origin)}` : "Deposit",
        amount: amt,
        token: sv.token,
        ...origin,
        live: m.checking || !m.balanceRead,
        lingers: !m.checking && m.balanceRead,
        ackRow: rowAck,
      });
    }
    /* 7. It came back, or it did not go: it stays until it is closed. An
       unknown figure names the token instead of printing a dash in a sentence. */
    const what = sv.amount === DASH ? `Your ${sv.token}` : sv.amount;
    /* Less arrived than was quoted: it waits for its refund, which is said here
       until it is closed (never a credit, never "pending"). */
    if (row.status === "incomplete") {
      return box("incomplete", {
        key: `incomplete:${sv.key}`,
        title: "Deposit will be refunded",
        sub: `${origin.chainName ? `${what} ${from(origin)} · ` : ""}${incompleteLabel(row.refundAfter)}`,
        amount: null,
        token: sv.token,
        ...origin,
        alert: true,
        lingers: true,
        ackRow: rowAck,
      });
    }
    if (row.status === "refunded") {
      const back = origin.chainName ? ` on ${origin.chainName}` : "";
      /* Where a Private refund really is: Avalanche's wallet is the Spot Account;
         on Base or Polygon it waits in the wallet there, and Deposit's Recover moves it in. */
      let sub = `${what} went back to your own address${back}`;
      if (isPrivate && origin.chainId === 43114) sub = `${what} went back to your Spot Account`;
      else if (isPrivate && (origin.chainId === 8453 || origin.chainId === 137)) sub = `${what} went back to your wallet${back} · Open Deposit to move it in`;
      return box("refunded", {
        key: `refunded:${sv.key}`,
        title: "Deposit refunded",
        sub,
        amount: sv.amount === DASH ? null : sv.amount,
        token: sv.token,
        ...origin,
        alert: true,
        lingers: true,
        ackRow: rowAck,
      });
    }
    if (row.status === "failed") {
      return box("failed", {
        key: `failed:${sv.key}`,
        title: "Deposit didn't go through",
        sub: origin.chainName ? `${what} ${from(origin)}` : what,
        amount: sv.amount === DASH ? null : sv.amount,
        token: sv.token,
        ...origin,
        alert: true,
        lingers: true,
        ackRow: rowAck,
      });
    }
  }

  /* 8. Money found sitting in the wallet with no deposit row to go with it (an
     old deposit, a reload): it is moving by itself now. */
  if (m.step === "auto") {
    return box("moving", {
      key: "moving:found",
      title: fig ? `Moving ${fig} into your Perp account…` : "Moving your deposit into your Perp account…",
      sub: "No action needed",
      amount: fig,
      live: true,
    });
  }
  return null;
}
