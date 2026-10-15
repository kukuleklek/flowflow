// ─────────────────────────────────────────────────────────────────────────────
// THE SPOT ACCOUNT PANELS' WORDS AND GATES (Move in / Move out / Stake / Unstake /
// Swap on the Wallet page). PURE: no React, no env read, no network, nothing signs.
// The panels (AvaxPanels.jsx) draw what these return; scripts/test-avax-panels.mjs
// drives them with plain data.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every figure comes from the review src/avax/money.js made (its `rows`, `gasText`,
// `windows`, `whyNot`); this file only orders, words and gates them. It never
// computes a fee, an amount that arrives or a minimum of its own.
//
// 🔴 THE RULES THESE HELPERS HOLD FOR THE PANELS
//   1. CONFIRM ONLY ON A COMPLETE CARD (confirmGate): the review must be one the
//      hook says is confirmable, AND no figure the customer pays or receives may
//      print "—". money.js already refuses most unknowns; a "—" that slips through
//      (an unread fee) still gets no Confirm here, because the customer could not
//      see what they pay.
//   2. NO "TRY AGAIN" AFTER MONEY MAY HAVE LEFT (outcomeView): "Review again" is
//      offered only when the outcome says nothing moved (cancelled /
//      error-before-money / a price that never became a run). Any other state —
//      unknown, sending, arriving, a state this file does not know — is treated as
//      "money may be moving": it says where to look and offers nothing to press.
//   3. NO RECIPIENT ANYWHERE. Nothing here takes an address; the only one ever printed is
//      the customer's OWN, shortened, in the review row money.js builds from the signers
//      (plan §3.8.6 "0x7a3f…c1e9 ✓ your wallet"). Links are built only from a 32-byte tx
//      hash or Relay request id.
//   4. UNKNOWN IS "—", NEVER 0: a balance the panel could not read gives no Max.
//   5. THE EXITS ARE NEVER BEHIND THE BUILD FLAG (plan §3.3, owner: "users can always act —
//      Aave withdraw, swaps, exits"). With VITE_EARN off, Move in / Stake / a swap INTO
//      anything stay closed, but Move out, Unstake and a swap back to USDC open whenever the
//      Spot Account holds something to take out (exitsOpen) — a build that turns the entries
//      off can never strand money in the Spot Account.

import { snowtraceTx } from "../../lib/avax/config.js";
import { assetBySymbol } from "../../lib/avax/whitelist.js";
import { formatRaw } from "../../lib/avax/units.js";

const DASH = "—";
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/* ── which panel ──────────────────────────────────────────────────────────── */

/** The five panels of the Spot Account, in pill order. */
export const PANEL_KINDS = Object.freeze(["swap", "move-in", "move-out", "stake", "unstake"]);
/* Older names that land here: the Agent's StakeCard opens `/wallet?panel=earn&amount=…`; plan §4.1 says aave-withdraw. */
const ALIAS = Object.freeze({ earn: "stake", "aave-withdraw": "unstake" });

/** `?panel=` → the Spot panel it names, or null (deposit / withdraw belong to the Main Account card). */
export function panelKind(raw) {
  if (typeof raw !== "string") return null;
  const k = ALIAS[raw] || raw;
  return PANEL_KINDS.includes(k) ? k : null;
}

/** Each panel's head: title, the two places it joins, its mark. Owner's names (2026-10-15).
 *  Marks: the owner's rule "เห็นโลโก้แค่ Tokenomist กับ Avax พอละ" (only the Tokenomist and Avax logos show) — so the
 *  Avalanche mark, or USDC with the Avalanche badge for the staked USDC (the Spot Account card's own row); never a
 *  vendor's mark (no Aave, Relay, Hyperliquid or Privy logo on these panels). */
export const PANEL_COPY = Object.freeze({
  "move-in": Object.freeze({ title: "Move in", from: "Main Account", to: "Spot Account", mark: "avalanche" }),
  "move-out": Object.freeze({ title: "Move out", from: "Spot Account", to: "Main Account", mark: "avalanche" }),
  stake: Object.freeze({ title: "Stake", from: "Spot Account", to: "USDC Staked", mark: "usdc" }),
  unstake: Object.freeze({ title: "Unstake", from: "USDC Staked", to: "Spot Account", mark: "usdc" }),
  swap: Object.freeze({ title: "Swap", from: null, to: null, mark: "avalanche" }),
});

/** The panels that are a way OUT (rule 5): open whatever the build flag says. A swap is one only when it sells into USDC. */
export const EXIT_PANELS = Object.freeze(["move-out", "unstake", "swap"]);

/** Is this panel (and, for a swap, this review) an exit (rule 5)? */
export function isExitPanel(kind, review = null) {
  if (kind === "move-out" || kind === "unstake") return true;
  return kind === "swap" && !!review && review.exit === true;
}

/**
 * With the build flag off, which exits does the Spot Account offer (rule 5)? Only for money that
 * is there: USDC to move out, staked USDC to unstake, a held coin to swap back to USDC.
 * Unknown balances offer nothing (never read as 0, never as "something").
 * @param {object} v  usePortfolio()'s view: { assets: [{ symbol, amount, status, held, native? }], aave }
 */
export function exitsOpen(v) {
  const assets = v && Array.isArray(v.assets) ? v.assets : [];
  const has = (a) => !!a && a.status !== "unknown" && fin(a.amount) && a.amount > 0;
  const usdc = assets.find((a) => a.symbol === "USDC");
  const moveOut = has(usdc);
  const unstake = !!(v && v.aave && v.aave.status === "ok" && fin(v.aave.suppliedUsdc) && v.aave.suppliedUsdc > 0);
  const swap = assets.some((a) => a.symbol !== "USDC" && a.symbol !== "AVAX" && !a.native && has(a));
  return Object.freeze({ moveOut, unstake, swap, any: moveOut || unstake || swap });
}

/** How each run goes, for the panel's "How it works" Tip (an explanation, so a Tip — USER-REQUESTS D1). */
export const HOW_IT_WORKS = Object.freeze({
  "move-in": "Two windows: you approve the move, then it leaves your Main Account. It arrives in your Spot Account with a little AVAX for gas when you have none.",
  "move-out": "One window: you sign the move. No AVAX is needed; the network fee is in the fee shown.",
  stake: "Up to two windows: allow exactly this much USDC, then stake it in Aave. The rate is variable and the USDC stays yours.",
  unstake: "One window: your USDC comes back from Aave to your Spot Account.",
  swap: "Up to two windows: allow exactly this amount, then swap it. If the price moves past the minimum, nothing is swapped.",
});

/**
 * The "How it works" Tip FOR THIS CARD: a count or an AVAX claim in the Tip must agree with the
 * review beside it (the move out's windows come from its quote: 1 signature today, 2 from
 * 2026-10-26, or the paid route's approve + send with its fee in AVAX).
 */
export function howItWorks(kind, review = null) {
  if (kind === "move-out" && review) {
    if (review.route === "paid") {
      return review.windows === 1
        ? "One window: you send the move from your Spot Account. Its network fee is paid in AVAX, shown above."
        : "Two windows: allow exactly this USDC, then send the move from your Spot Account. Its network fee is paid in AVAX, shown above.";
    }
    if (review.route === "permit" && review.windows === 2) return "Two windows: you allow the move, then you sign it. No AVAX is needed; the network fee is in the fee shown.";
  }
  if (kind === "unstake" && review && fin(review.windows) && review.windows !== 1) return "Your USDC comes back from Aave to your Spot Account, one window per step shown.";
  return HOW_IT_WORKS[kind] || null;
}

/* ── amounts ──────────────────────────────────────────────────────────────── */

/** What the amount box keeps from a keystroke: digits and one dot, at most `decimals` places. */
export function typedAmount(s, decimals = 6) {
  const t = String(s == null ? "" : s).replace(/,/g, ".").replace(/[^\d.]/g, "");
  const i = t.indexOf(".");
  if (i < 0) return t.replace(/^0+(?=\d)/, "");
  const whole = t.slice(0, i).replace(/^0+(?=\d)/, "") || "0";
  const frac = t.slice(i + 1).replace(/\./g, "").slice(0, Math.max(0, decimals));
  return decimals > 0 ? `${whole}.${frac}` : whole;
}

/** A number cut DOWN to `dp` places as plain text ("2.5", never "2.50000" or "1e-7"); null when not a positive number. */
export function floorText(n, dp = 6) {
  if (!fin(n) || n <= 0) return null;
  const f = 10 ** dp;
  const cut = Math.floor(n * f + 1e-9) / f;
  if (!(cut > 0)) return null;
  return cut.toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The Max a panel may offer, or null when no Max is safe to offer.
 *   move-in   none: the fee and any gas come ON TOP of the amount, so "all of it" would be refused
 *   move-out  the Spot Account's USDC, up to the move cap
 *   stake     the Spot Account's USDC, up to the stake cap
 *   unstake   "all" (Aave's MAX: every unit, interest to the second)
 *   swap      the from-asset held, up to the swap cap in USD at its peg, or at its shown price less 2 %
 *             (an unpegged price can move before the review); no price → no Max
 * @param {string} kind
 * @param {{ spotUsdc?: number|null, stakedUsdc?: number|null, caps?: object, from?: object|null }} ctx
 *   from: { amount, price, peg, decimals } of the asset sold
 */
export function maxFor(kind, { spotUsdc = null, stakedUsdc = null, caps = {}, from = null } = {}) {
  const cap = (k) => (fin(caps[k]) && caps[k] > 0 ? caps[k] : null);
  if (kind === "move-out" || kind === "stake") {
    const c = cap(kind === "stake" ? "stakeUsdc" : "moveUsdc");
    if (!fin(spotUsdc) || spotUsdc <= 0 || c == null) return null;
    return floorText(Math.min(spotUsdc, c), 6);
  }
  if (kind === "unstake") return fin(stakedUsdc) && stakedUsdc > 0 ? "all" : null;
  if (kind === "swap") {
    const c = cap("swapUsd");
    if (!from || !fin(from.amount) || from.amount <= 0 || c == null) return null;
    const pegged = fin(from.peg) && from.peg > 0;
    const px = pegged ? from.peg : fin(from.price) && from.price > 0 ? from.price : null;
    if (px == null) return null;
    const most = pegged ? c / px : (c * 0.98) / px;
    return floorText(Math.min(from.amount, most), Math.min(fin(from.decimals) ? from.decimals : 6, 8));
  }
  return null;
}

/** The args useAvaxAction(kind).price() takes, from what the panel holds; null when there is nothing to price. */
export function priceArgs(kind, { amount = "", from = null, to = null } = {}) {
  const a = String(amount == null ? "" : amount).trim();
  if (kind === "unstake" && a === "all") return { amountUsdc: "all" };
  if (!/^\d+(\.\d+)?$/.test(a) || !(Number(a) > 0)) return null;
  if (kind === "swap") return from && to && from !== to ? { from, to, amount: a } : null;
  return { amountUsdc: a };
}

/* ── the review ───────────────────────────────────────────────────────────── */

/* The rows a customer pays or receives by. One of them unknown = no Confirm (rule 1). */
const PAID_KEYS = Object.freeze(["amount", "debit", "fee", "gas", "network", "receive", "minimum"]);

const cap1 = (s) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);

/**
 * The review's figures in the order money.js wrote them, ready to draw:
 *   [{ key, label, value, note, tone: ""|"strong"|"warning", unknown }]
 * The "Signatures" row is left out (the panel prints it as "You'll approve N windows…" by the Confirm).
 * The gas row prints the owner's phrase (AD-8: "includes ≈0.0208 AVAX for gas (≈$0.20)") with where it stays.
 * A liquidation row is amber (DESIGN-SPEC rule 11).
 */
export function reviewLines(review) {
  if (!review || !Array.isArray(review.rows)) return [];
  const out = [];
  for (const r of review.rows) {
    if (!r || typeof r.key !== "string" || r.key === "windows") continue;
    const value = r.value == null || r.value === "" ? DASH : String(r.value);
    if (r.key === "gas") {
      const where = value.includes(" · ") ? value.split(" · ").slice(1).join(" · ") : null;
      out.push(Object.freeze({ key: "gas", label: r.label || "Gas for later", value: review.gasText || value, note: where ? cap1(where) : r.note || null, tone: "", unknown: value === DASH }));
      continue;
    }
    const tone = r.key.startsWith("liq-") ? "warning" : r.key === "receive" ? "strong" : "";
    out.push(Object.freeze({ key: r.key, label: String(r.label || ""), value, note: r.note || null, tone, unknown: value === DASH }));
  }
  return out;
}

/** The first figure the customer pays or receives by that is unknown ("—"), or null. */
export function unknownFigure(review) {
  const l = reviewLines(review).find((x) => x.unknown && PAID_KEYS.includes(x.key));
  return l ? l.label : null;
}

/** "You'll approve 2 windows in your wallet" — or null when the count is unknown. */
export function windowsLine(n) {
  if (!fin(n) || n <= 0 || Math.floor(n) !== n) return null;
  return `You'll approve ${n} window${n === 1 ? "" : "s"} in your wallet`;
}

/** A reason that is a state of the page (wait, sign in, live only) reads quiet; every other reason is an error.
 *  Both are printed (USER-REQUESTS D2: a blocked card's reason is never folded into a Tip). */
const WAIT_WORDS = new Set([
  "Still loading", "Your wallet is still loading", "Your Main Account is still loading", "Enter an amount",
  "Sign in first", "View only", "Live only", "Not on yet", "Opens after the live test",
]);
/* A limit ("Max 20 USDC per move…", "Max ≈19.65 USDC this time…") is a fact of the card, not a refusal: quiet. */
export const whyTone = (why) => (!why ? null : WAIT_WORDS.has(why) || /^Cancelled\./.test(why) || /^Max /.test(why) ? "muted" : "error");

/**
 * May the panel show a live Confirm? (rule 1; rule 5: an exit never waits for the flag)
 * @param {{ earnOn: boolean, mock: boolean, action: object, kind?: string }} p  action = useAvaxAction(kind)'s value
 * @returns {{ enabled: boolean, why: string|null }}  why: the printed reason when it may not
 */
export function confirmGate({ earnOn = false, mock = false, action = null, kind = null } = {}) {
  const no = (why) => Object.freeze({ enabled: false, why: why || null });
  if (!earnOn && !isExitPanel(kind, action && action.review)) return no("Opens after the live test");
  if (mock) return no("Live only");
  if (!action) return no("Your wallet is still loading");
  if (!action.ready) return no(action.why || "Your wallet is still loading");
  const r = action.review;
  if (action.phase !== "review" || !r) return no(null);
  if (!r.confirmable) return no(r.whyNot || "This can't be confirmed right now.");
  const unknown = unknownFigure(r);
  if (unknown) return no(`${unknown} is unknown right now, so this can't be confirmed.`);
  if (!windowsLine(r.windows)) return no("The number of wallet windows is unknown, so this can't be confirmed.");
  if (!action.canConfirm) return no(null);
  return Object.freeze({ enabled: true, why: null });
}

/* ── progress ─────────────────────────────────────────────────────────────── */

/** A stage's mark: todo ○ · active spinner · done ✓ · failed ✗ · unknown ! (amber: money may be moving). */
export function stageMark(state) {
  if (state === "active") return "spin";
  if (state === "done") return "check";
  if (state === "failed") return "fail";
  if (state === "unknown") return "unknown";
  return "todo";
}

/** Stages that are not a wallet window (the money travelling on its own). */
const NOT_A_WINDOW = new Set(["arrive"]);
/** The active stage opens a wallet window: the panel says where to look. */
export const stageIsWindow = (s) => !!s && s.state === "active" && !NOT_A_WINDOW.has(s.key);

/* ── the outcome ──────────────────────────────────────────────────────────── */

/* States in which nothing left the customer's accounts (flows.js TERMINAL minus done/refunded, + a card never run). */
const NOTHING_MOVED = new Set(["cancelled", "error-before-money", "expired", "review"]);
const RELAY_REQUEST_URL = "https://relay.link/transaction/";

/** Did this outcome end with nothing moved? Unknown anything = no (rule 2). */
export function nothingMoved(outcome) {
  if (!outcome || outcome.ok) return false;
  if (outcome.unknown || outcome.alreadyRun) return false;
  const st = outcome.state;
  return st == null ? outcome.code != null || typeof outcome.message === "string" : NOTHING_MOVED.has(st);
}

/** Explorer links for an outcome: each Avalanche tx on Snowtrace, the Relay request, where-to-look's own link. */
export function outcomeLinks(outcome, note = null) {
  const links = [];
  const seen = new Set();
  const add = (label, href) => { if (href && !seen.has(href)) { seen.add(href); links.push(Object.freeze({ label, href })); } };
  const hashes = outcome && Array.isArray(outcome.txHashes) ? outcome.txHashes.filter((h) => typeof h === "string" && HASH_RE.test(h)) : [];
  hashes.forEach((h, i) => add(hashes.length > 1 ? `Snowtrace ${i + 1}` : "Snowtrace", snowtraceTx(h)));
  const rid = outcome && typeof outcome.requestId === "string" && HASH_RE.test(outcome.requestId) ? outcome.requestId : null;
  if (rid) add("Track", `${RELAY_REQUEST_URL}${rid}`);
  const safe = (href) => (typeof href === "string" && /^https:\/\/(snowtrace\.io|relay\.link)\//.test(href) ? href : null);
  if (outcome && outcome.whereToLook) add("Check status", safe(outcome.whereToLook.href));
  if (note) add("Check status", safe(note.href));
  return links;
}

const UNKNOWN_TITLE = "Not sure yet — we're checking. Don't send again.";
const WHERE_DEFAULT = Object.freeze({
  "move-in": "Check your Main Account and your Spot Account before moving again.",
  "move-out": "Check your Spot Account and your Main Account before moving again.",
});

/**
 * What the panel says after Confirm.
 * @returns {{ tone: "running"|"arriving"|"done"|"refunded"|"unknown"|"failed"|null, title: string|null,
 *   message: string|null, where: string|null, links: object[], receipt: string|null,
 *   reviewAgain: boolean, requote: boolean }}
 *   reviewAgain  "Review again" may show (nothing moved, rule 2)
 *   requote      the price expired / the fee moved before anything was signed: price it again by itself
 */
export function outcomeView({ kind = null, phase = null, outcome = null, note = null } = {}) {
  const base = { tone: null, title: null, message: null, where: null, links: [], receipt: null, reviewAgain: false, requote: false };
  const o = outcome || {};
  const links = outcomeLinks(outcome, note);
  if (phase === "running") return Object.freeze({ ...base, tone: "running", title: "Confirm in your wallet", links });
  if (phase === "arriving") {
    return Object.freeze({ ...base, tone: "arriving", title: "On its way", message: (note && note.text) || o.message || null, links });
  }
  if (phase === "done") {
    return Object.freeze({ ...base, tone: "done", title: o.message || "Done.", receipt: o.receiptText || null, links });
  }
  if (phase === "refunded") {
    return Object.freeze({ ...base, tone: "refunded", title: o.message || "Refunded.", links });
  }
  if (phase === "failed" && nothingMoved(outcome)) {
    const expired = o.code === "price_expired" || o.code === "fee-moved" || (o.needsConfirm === true && !o.review);
    return Object.freeze({ ...base, tone: "failed", title: o.message || "Not sent. Nothing moved.", links, reviewAgain: true, requote: expired });
  }
  if (phase === "unknown" || phase === "failed") {
    /* Unknown, or a failure this file can't call "nothing moved": money may be moving. Say where to look; offer nothing.
       The title already says "Don't send again", so it is not repeated under it. */
    const again = /\s*Don't send (it )?again\.?\s*$/i;
    const where = ((o.whereToLook && o.whereToLook.text) || WHERE_DEFAULT[kind] || "Check your Spot Account before doing anything else.").replace(again, "");
    const said = (t) => typeof t === "string" && t.trim() && !/^Not confirmed yet\.?\s*Don't send (it )?again\.?$/i.test(t.trim()) ? t.replace(again, "") : null;
    return Object.freeze({ ...base, tone: "unknown", title: UNKNOWN_TITLE, message: said(note && note.text) || said(o.message), where, links });
  }
  return Object.freeze(base);
}

/* ── moves in progress (the Spot Account card) ───────────────────────────── */

const FLOW_TITLE = Object.freeze({
  stake: "Staking USDC",
  unstake: "Unstaking USDC",
  "move-in": "Moving to Spot Account",
  "move-out": "Moving to Main Account",
  swap: "Swap",
  "gas-topup": "Gas top-up",
  "remove-allowance": "Removing an approval",
});

function flowAmount(kind, a) {
  if (!a || typeof a !== "object") return null;
  if (kind === "move-in" && a.out != null) return `${a.out} USDC`;
  if ((kind === "move-out" || kind === "stake" || kind === "unstake") && a.in != null) return a.in === "all" ? "All staked USDC" : `${a.in} USDC`;
  if (kind === "swap" && a.from && a.to && a.amountRaw != null) {
    const t = assetBySymbol(a.from) || null;
    let amt = null;
    try { amt = t ? formatRaw(BigInt(a.amountRaw), t.decimals, Math.min(t.decimals, 8)) : null; } catch { amt = null; }
    return amt && amt !== DASH ? `${amt} ${a.from} → ${a.to}` : `${a.from} → ${a.to}`;
  }
  return null;
}

/**
 * One row of "Moves in progress" from a useAvaxMoney().flows record (its `view` and `note` included).
 * An UNKNOWN row always says where to look (plan §3.6 "Not confirmed yet + Check status ↗") — from the
 * watcher's note, or else from the record's own ids (its Relay request, its tx on Snowtrace) — so it
 * keeps that after the panel that ran it was closed.
 * @returns {{ id, title, amountText, stateText, tone: "moving"|"unknown", where: string|null, note: {text, href}|null }}
 */
export function flowRowView(f) {
  if (!f || typeof f !== "object") return null;
  const unknown = f.state === "unknown" || !!(f.view && f.view.unknown);
  const stateText = unknown ? "Not confirmed yet. Don't send it again."
    : f.state === "arriving" ? "On its way"
    : f.state === "sending" || f.state === "confirmed" ? "Sending"
    : f.state;
  const linkOk = (h) => (typeof h === "string" && /^https:\/\/(snowtrace\.io|relay\.link)\//.test(h) ? h : null);
  const own = typeof f.requestId === "string" && HASH_RE.test(f.requestId) ? `${RELAY_REQUEST_URL}${f.requestId}`
    : typeof f.txHash === "string" && HASH_RE.test(f.txHash) ? snowtraceTx(f.txHash) : null;
  const safe = (f.note && linkOk(f.note.href)) || (unknown ? linkOk(own) : null);
  const note = f.note && f.note.text ? Object.freeze({ text: String(f.note.text), href: safe })
    : unknown && safe ? Object.freeze({ text: stateText, href: safe }) : null;
  return Object.freeze({
    id: String(f.id || ""),
    title: FLOW_TITLE[f.kind] || "Move",
    amountText: flowAmount(f.kind, f.amounts),
    stateText,
    tone: unknown ? "unknown" : "moving",
    where: unknown ? WHERE_DEFAULT[f.kind] || "Check your Spot Account before doing anything else." : null,
    note,
  });
}
