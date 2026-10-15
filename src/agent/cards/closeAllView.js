// Close all (item 7; seen live: "ปิดทุก Position ของกู" got "Which market should I close?", and "เอาหมดเลย" then closed only
// BTC while CHIP 3x Long stayed open). What CloseAllCard prints and how it reads each close's answer. PURE.
//
// The card lists EVERY open position (crypto and stocks, one Main Account) with its size and P&L from Hyperliquid's own
// numbers (positionView: one source per figure), and closes them ONE BY ONE through the caller's closeOne(coin) — the
// same reduce-only path a single close takes. It never opens anything: the only call it can make is closeOne, once per
// row per tap, for a coin that was on the list when the person tapped.
import { positionView, tradeErrorView } from "../../perp/live/perpLiveView.js";
import { minus } from "../../ui/num.js";
import { coinLabel, isStockCoin, stockNameOf } from "./viewWords.js";
import { usdSigned } from "./finalTradeView.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * The rows, biggest P&L first, each market once, only positions with a size.
 * @param {object[]} positions the account's positions (Hyperliquid's clearinghouseState rows, account layer shape)
 * @param {{ byCoin?: object }} o the live market rows (for the size decimals and the ticker)
 */
export function closeAllRows(positions, { byCoin = {} } = {}) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(positions) ? positions : []) {
    if (!p || typeof p.coin !== "string" || !p.coin || !fin(p.szi) || p.szi === 0 || seen.has(p.coin)) continue;
    seen.add(p.coin);
    const m = byCoin && byCoin[p.coin] ? byCoin[p.coin] : null;
    const v = positionView(p, { szDecimals: m && Number.isInteger(m.szDecimals) ? m.szDecimals : null });
    if (!v) continue;
    out.push({
      coin: p.coin,
      label: coinLabel(p.coin, m),
      name: isStockCoin(p.coin) ? stockNameOf(p.coin) : null,
      isStock: isStockCoin(p.coin),
      side: v.side,
      pill: v.pill,
      sizeText: v.sizeText,
      pnlUsd: v.pnlUsd,
      /* Typographic minus for display ("−$2.10"); the figure itself is pnlUsd. */
      pnlText: minus(v.pnlText),
      pnlTone: v.pnlTone,
    });
  }
  return out.sort((a, b) => Math.abs(b.pnlUsd || 0) - Math.abs(a.pnlUsd || 0));
}

/** The rows' P&L added up, or null when any is unknown (never a partial sum shown as the whole). */
export function totalPnl(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let t = 0;
  for (const r of rows) { if (!fin(r.pnlUsd)) return null; t += r.pnlUsd; }
  return t;
}

/**
 * One close's answer.
 *   done      closed (the share asked: all, or the half / quarter the card says)
 *   partial   🔴 only PART of the asked size filled (a reduce-only IOC on a thin book): the rest is still open, said
 *             with the filled vs asked size, and the row may be tried again (pass-2 review: it counted as "Closed")
 *   gone      it was already closed (elsewhere, or by its own TP / SL): nothing to do, not a failure
 *   failed    refused: nothing changed for that market; a new tap may try it again
 *   unknown   🔴 the reply was lost: never re-sent from here; the person checks the position first
 */
export function closeOutcome(r) {
  if (r && r.ok === true) {
    const partial = r.partial === true || (typeof r.status === "string" && r.status !== "filled");
    if (partial) {
      const got = r.filled && r.filled.totalSz != null ? String(r.filled.totalSz) : null;
      const asked = r.size != null ? String(r.size) : null;
      return { state: "partial", text: r.status && r.status !== "filled" ? "On the book, not filled yet. Check this position." : got && asked ? `Partly closed: ${got} of ${asked}. The rest is still open.` : "Partly closed. The rest is still open." };
    }
    return { state: "done", text: "Closed" };
  }
  if (r && r.code === "no_position") return { state: "gone", text: "Already closed" };
  const e = r && r.ok === false ? tradeErrorView(r) : null;
  if (!e || e.next === "positions") return { state: "unknown", text: (e && e.text) || "Not confirmed. Check this position." };
  return { state: "failed", text: e.text };
}

/**
 * Where the whole run stands, in one honest line.
 * @param {object[]} rows    closeAllRows
 * @param {object} states    coin → { state: "idle"|"closing"|"done"|"gone"|"failed"|"unknown", text? }
 */
export function closeAllSummary(rows, states = {}) {
  const st = (c) => (states && states[c] && states[c].state) || "idle";
  const list = Array.isArray(rows) ? rows : [];
  const count = (s) => list.filter((r) => st(r.coin) === s).length;
  const done = count("done") + count("gone");
  const failed = list.filter((r) => st(r.coin) === "failed" || st(r.coin) === "partial");
  const partial = list.filter((r) => st(r.coin) === "partial");
  const unknown = list.filter((r) => st(r.coin) === "unknown");
  const running = list.some((r) => st(r.coin) === "closing");
  const started = list.some((r) => st(r.coin) !== "idle");
  const settled = started && !running && list.every((r) => st(r.coin) !== "idle");
  const total = list.length;
  const names = (a) => a.map((r) => r.label).join(", ");
  let text = null;
  if (settled) {
    if (done === total) text = total === 1 ? "Closed your position." : `Closed all ${total} positions.`;
    else {
      const parts = [`Closed ${done} of ${total}.`];
      const refused = failed.filter((r) => st(r.coin) !== "partial");
      if (partial.length) parts.push(`${names(partial)} only partly closed: the rest is still open.`);
      if (refused.length) parts.push(`${names(refused)} didn't close.`);
      if (unknown.length) parts.push(`${names(unknown)} not confirmed: check ${unknown.length === 1 ? "it" : "them"} before trying again.`);
      text = parts.join(" ");
    }
  }
  return { total, done, failed: failed.length, partial: partial.length, unknown: unknown.length, running, settled, text, retry: failed.map((r) => r.coin) };
}

/** "Close all · 3" / "Close 1 position"; a share: "Close half of each · 2". */
export const closeAllLabel = (n, fraction = 1) => {
  if (fraction < 1) {
    const share = fraction === 0.5 ? "half" : `${Math.round(fraction * 100)}%`;
    return n === 1 ? `Close ${share} · 1 position` : `Close ${share} of each · ${n}`;
  }
  return n === 1 ? "Close 1 position" : `Close all · ${n}`;
};

/**
 * What the closed rows realized, from the P&L each showed when it was closed (its last streamed figure, × the share
 * closed): an estimate, labelled so; null when any closed row's figure is unknown (never a partial sum as the whole).
 */
export function realizedOf(rows, states = {}, fraction = 1) {
  const closed = (Array.isArray(rows) ? rows : []).filter((r) => states && states[r.coin] && states[r.coin].state === "done");
  if (!closed.length) return null;
  let t = 0;
  for (const r of closed) { if (!fin(r.pnlUsd)) return null; t += r.pnlUsd * (fraction > 0 && fraction <= 1 ? fraction : 1); }
  return t;
}

export { usdSigned };

/**
 * Close the listed coins ONE BY ONE through the caller's closeOne — the component's whole run, kept here so the rules
 * are tested: in order, each coin once, only the coins given (never a coin from anywhere else), never anything but
 * closeOne, and a refusal or a throw on one row never stops the rows after it (each gets its own honest answer).
 * @param {{ coins: string[], closeOne: (coin: string) => Promise<object>, onState?: (coin, outcome) => void }} o
 * @returns {Promise<object>} coin → outcome ({ state, text })
 */
export async function runCloseAll({ coins, closeOne, onState = null } = {}) {
  const out = {};
  if (typeof closeOne !== "function") return out;
  const tell = (c, o) => { if (typeof onState === "function") onState(c, o); };
  for (const coin of [...new Set((Array.isArray(coins) ? coins : []).filter((c) => typeof c === "string" && c))]) {
    tell(coin, { state: "closing", text: null });
    let r;
    try { r = await closeOne(coin); } catch (e) { r = { ok: false, code: "unexpected", message: String((e && e.message) || e || "") }; }
    out[coin] = closeOutcome(r);
    tell(coin, out[coin]);
  }
  return out;
}
