// WHERE THE CUSTOMER'S MONEY IS, as one small plain object: the Agent's get_funds tool, and any screen that wants it.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "agent ต้องรู้ว่าเงินเขาอยู่ที่ไหน เงินติดอยู่ที่ไหนบ้าง". The case that asked for it: a trade
// card could not be confirmed because the Perp balance was 0 while 9.918 USDC sat in the customer's own wallet on
// Arbitrum waiting for the first deposit's last hop, and all anybody could read was "More than you can use right
// now". So this answers, in figures and in one plain sentence:
//
//   perp              { balanceUsdc, availableUsdc, inPositionsUsdc, partial, ... } the Perp account (the account
//                     layer); `partial` when part of it could not be read, so its figure is no claim of "empty"
//   arbitrumWallet    { usdc, waitingToMove, move, movingUsdc, ... } the customer's own USDC on Arbitrum, read from
//                     the chain: at or over the floor it is money waiting to move into Perp; under it, it waits for
//                     more; a move already under way is money on its way whatever the wallet now reads
//   depositsOnTheWay  [{ amount, token, from, to, stage }] what the deposit watch is following for this wallet
//   depositsUnread    null, "loading" or "failed": the watch has not answered for this wallet, so "nothing is on
//                     its way" cannot be said
//   summary           one line, plain words
//
// 🔴 UNKNOWN IS NULL, NEVER 0 (docs/MONEY_RULES.md section 0). A balance that was not read, or could not be, is null,
// and the sentence says so; it never reads as an empty wallet. No figure here is invented or remembered: each one is
// the account layer's, the chain's, or the deposit watch's latest answer.
//
// NO PROVIDER, NO VENUE (owner, 2026-09-23): no deposit service or exchange is named. TWO ACCOUNTS (owner,
// 2026-10-15): the sentences name only the Main Account (trading money; USDC on the first deposit's hop is money
// joining it) and the Spot Account. Arbitrum is named only where the customer must act on it: the gas a move needs.
// The figures' keys (perp, arbitrumWallet) stay as they are: they are identifiers, not words.
//
// READ ONLY. Nothing here signs, sends or starts a move: the move itself belongs to perp/deposit/perpFunding.js, and
// its state comes in through readMove. Every reader is injected, so the Node suite drives this with fakes. A mock
// build reads the mock account only (no chain, no deposit watch).
import { readArbitrumUsdcBalance, BRIDGE_MIN_RAW, BRIDGE_MIN_USDC, ARBITRUM_CHAIN_NAME } from "../lib/relay/arbitrumBridge.js";
import { depositWatch } from "../perp/deposit/depositWatch.js";
import { DEPOSIT_CHAINS, routeById } from "../lib/relay/routes.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);
const r6 = (v) => (fin(v) ? Math.round(v * 1e6) / 1e6 : null);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Where each FlowFlow product keeps its money (plan v2 §2.5, the money map the Agent always knows). */
export const MONEY_MAP = Object.freeze({
  trade: "Main Account (USDC margin)",
  earn: "USDC Staked AAVE, inside the Spot Account (on AVAX)",
  swap: "Spot Account (coming soon)",
});

/** How long the chain read may take before the rest of the answer goes without it. */
export const FUNDS_CHAIN_TIMEOUT_MS = 8000;
/** A move started this long ago is no longer "on its way": its money has had time to arrive. */
export const FUNDS_RECENT_MOVE_MS = 3 * 60 * 1000;
/** A finished deposit that went wrong is still worth saying for this long (by the deposit service's own time). */
export const FUNDS_PROBLEM_MAX_MS = 24 * 60 * 60 * 1000;

const floorCents = (v) => Math.floor(v * 100 + 1e-9) / 100;

/** "9.918" (up to `digits` decimals, no trailing zeros). */
const num = (v, digits = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: digits });
/** "9.918 USDC". */
const usdc = (v, digits = 2) => `${num(v, digits)} USDC`;

function withTimeout(promise, ms) {
  let t = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); }),
  ]);
}

/** The Perp account's figures; each one null when it has not been read. */
export function perpFunds(backend) {
  const acc = (backend && backend.account) || {};
  const bal = acc.perpBalanceUsdc;
  const known = !!(bal && bal.answered === true && fin(bal.equityUsdc));
  const list = acc.positions && acc.positions.answered ? (acc.positions.list || []).filter((p) => p && fin(p.szi) && p.szi !== 0) : null;
  let inPositions = null;
  if (list) {
    inPositions = 0;
    for (const p of list) {
      if (!fin(p.marginUsed)) { inPositions = null; break; }
      inPositions += p.marginUsed;
    }
  }
  /* Read only in part (the account layer's `complete: false`): the figure is what was read, never "all there is". */
  const partial = known && bal.complete === false;
  return {
    balanceUsdc: known ? r2(bal.equityUsdc) : null,
    availableUsdc: known && fin(bal.availableUsdc) ? r2(bal.availableUsdc) : null,
    inPositionsUsdc: inPositions == null ? null : r2(inPositions),
    openPositions: list ? list.length : null,
    /* Standard mode keeps Spot USDC apart: it is the customer's, and it is not trading money until it is moved. */
    inSpotUsdc: known && bal.source === "perp" && fin(bal.idleSpotUsdc) ? r2(bal.idleSpotUsdc) : null,
    neverFunded: !partial && !!(bal && bal.reason === "new-account"),
    partial,
    partialReason: partial ? (typeof bal.incompleteReason === "string" ? bal.incompleteReason : "unread") : null,
  };
}

/**
 * Is this margin more than the Perp account can use right now? The trade card's own test, as near as the account's
 * figures go: the card says "More than you can use right now" when the margin is over what the order may use, which
 * is the FREE amount (money backing open positions or orders is in the balance, not free) less the order's fee
 * (trade/useOrderQuote.js, perp/live/perpBackend.js liveLimits). A venue market also draws on its own pot, which the
 * account figures do not show, so there only the balance is held against it (no claim that cannot be backed).
 *
 * Returns null when the margin fits or a figure was not read; otherwise
 * { balanceUsdc, freeUsdc, maxMarginUsdc, inPositionsUsdc } for the model and the line under the card.
 */
export function marginShortfall(backend, { marginUsdc, leverage = null, feeRate = null, coin = null } = {}) {
  const acc = backend && backend.account ? backend.account : null;
  const bal = acc ? acc.perpBalanceUsdc : null;
  if (!fin(marginUsdc) || marginUsdc <= 0 || !bal || bal.answered !== true || !fin(bal.equityUsdc)) return null;
  const venue = typeof coin === "string" && coin.includes(":");
  const free = Math.max(0, !venue && fin(bal.availableUsdc) ? bal.availableUsdc : bal.equityUsdc);
  const lev = fin(leverage) && leverage >= 1 ? Math.floor(leverage) : null;
  const max = lev != null && fin(feeRate) && feeRate > 0 ? floorCents(free / (1 + lev * feeRate)) : floorCents(free);
  if (marginUsdc <= max) return null;
  const held = r2(Math.max(0, bal.equityUsdc - free));
  return { balanceUsdc: r2(bal.equityUsdc), freeUsdc: r2(free), maxMarginUsdc: max, inPositionsUsdc: held > 0 ? held : 0 };
}

/** The plain sentence for a margin the account cannot use: what it holds, what of it is free, and why that is short. */
export function shortfallText(s, marginUsdc) {
  const m = num(marginUsdc);
  if (!s) return "";
  if (s.freeUsdc < s.balanceUsdc - 0.005) {
    return `Your Main Account has ${num(s.balanceUsdc)} USDC, but only ${num(s.freeUsdc)} USDC of it is free to use (the rest backs open positions or orders), less than this ${m} USDC margin`;
  }
  if (marginUsdc <= s.freeUsdc) {
    return `Your Main Account has ${num(s.freeUsdc)} USDC free, and this ${m} USDC margin plus its fee is more than that`;
  }
  return `Your Main Account has ${num(s.balanceUsdc)} USDC, less than this ${m} USDC margin`;
}

/* The move's state as the runner reports it (perpFunding's fundingStep), in the words this file uses. */
function moveWord(m) {
  if (!m || typeof m.step !== "string") return null;
  if (m.step === "sending") return "moving";
  if (m.step === "auto") return "by-itself";
  if (m.step === "sent") return "sent";
  if (m.step === "failed") return m.code === "no-gas" ? "needs-gas" : "failed";
  if (m.step === "offer" || m.step === "again") return "needs-press";
  return null;
}

async function arbitrumFunds(address, { readArbitrum, readMove, timeoutMs, now }) {
  let bal = null;
  try { bal = await withTimeout(readArbitrum(address), timeoutMs); } catch { bal = null; }
  const raw = bal && typeof bal.raw === "bigint" ? bal.raw : null;
  const amount = bal && fin(bal.usdc) ? bal.usdc : null;
  let move = null;
  try { move = typeof readMove === "function" ? await withTimeout(readMove(address), Math.min(2000, timeoutMs)) : null; } catch { move = null; }
  const sentAt = move && fin(move.at) ? move.at : null;
  const recentMove = move && move.step === "sent" && fin(move.usdc) && sentAt != null && now() - sentAt < FUNDS_RECENT_MOVE_MS
    ? r6(move.usdc) : null;
  /* A move the runner is sending right now is money on its way, whatever the wallet reads by now: once it is sent
     the wallet is empty (or under the floor) while the money has not reached the Perp account yet. */
  const movingUsdc = move && move.step === "sending" && fin(move.usdc) && move.usdc > 0 ? r6(move.usdc) : null;
  if (amount == null) {
    return { usdc: null, waitingToMove: null, belowMinimum: null, minimumUsdc: BRIDGE_MIN_USDC, move: moveWord(move), movingUsdc, justMovedUsdc: recentMove };
  }
  const waiting = raw != null ? raw >= BRIDGE_MIN_RAW : amount >= BRIDGE_MIN_USDC;
  let word = moveWord(move);
  /* A runner that has not looked at this wallet says nothing; money over the floor then moves by itself. */
  if (waiting && (word == null || word === "sent")) word = word === "sent" && recentMove != null ? "moving" : "by-itself";
  if (!waiting && word !== "sent" && !(word === "moving" && movingUsdc != null)) word = null;
  return {
    usdc: r6(amount),
    waitingToMove: waiting,
    belowMinimum: amount > 0 && !waiting,
    minimumUsdc: BRIDGE_MIN_USDC,
    move: word,
    movingUsdc: word === "moving" ? movingUsdc : null,
    justMovedUsdc: recentMove,
  };
}

/**
 * What the deposit watch is following for this wallet: deposits on their way, recent ones that went wrong, and
 * `unread` when a watch of this wallet has not answered ("loading": its first look is still out; "failed": its last
 * look failed, or it stopped without one). An unread watch is no claim that nothing is on its way.
 */
export function depositsFrom(state, address, now = Date.now()) {
  const who = typeof address === "string" ? address.toLowerCase() : null;
  const onTheWay = [];
  const problems = [];
  let unread = null;
  if (!who) return { onTheWay, problems, unread };
  if (!state || !Array.isArray(state.entries)) return { onTheWay, problems, unread: "failed" };
  for (const e of state.entries) {
    if (!e || e.user !== who) continue;
    if (e.state !== "ok") {
      const failed = e.state === "error" || e.watching === false;
      unread = failed || unread === "failed" ? "failed" : "loading";
    }
    const route = e.routeId ? routeById(e.routeId) : null;
    (e.requests || []).forEach((r, i) => {
      if (!r) return;
      const chain = r.inChainId != null && DEPOSIT_CHAINS[r.inChainId] ? DEPOSIT_CHAINS[r.inChainId].name : route ? route.chainName : null;
      const row = {
        amount: fin(r.amountIn) ? r6(r.amountIn) : null,
        token: r.symbolIn || (route ? route.token : null),
        from: chain,
      };
      if (r.status === "arriving") {
        const recent = !!(Array.isArray(e.movingNow) && e.movingNow[i]);
        onTheWay.push({
          ...row,
          /* One place in the customer's words: a first deposit's hop through Arbitrum is joining the Main Account too. */
          to: "your Main Account",
          stage: recent ? "on its way" : "taking longer than usual",
        });
      } else if (r.status === "incomplete") {
        /* A Private deposit where less arrived than was quoted (depositWatch.js): the money waits with the deposit
           service until its refund, up to ~72 hours later. Not money on its way in, and never silent (pass 2): a
           problem row, in plain words, the service never named. */
        problems.push({ ...row, stage: "less arrived than was quoted: it is held and sent back to where it came from after the deadline (up to about 3 days)" });
      } else if ((r.status === "refunded" || r.status === "failed") && fin(r.createdAt) && now - r.createdAt < FUNDS_PROBLEM_MAX_MS) {
        problems.push({ ...row, stage: r.status === "refunded" ? "sent back to where it came from" : "didn't go through" });
      }
    });
  }
  return { onTheWay, problems, unread };
}

function depositLine(d) {
  const what = d.amount != null ? `${num(d.amount, 6)} ${d.token || "USDC"}` : `A deposit${d.token ? ` of ${d.token}` : ""}`;
  return `${what}${d.from ? ` from ${d.from}` : ""}`;
}

/** The one sentence, from the figures above. */
export function fundsSummary({
  perp, arbitrumWallet: w, depositsOnTheWay: ways, depositProblems: bad = [], depositsUnread = null, next = null,
}) {
  const out = [];
  const parts = [];
  if (perp.availableUsdc != null) parts.push(`${usdc(perp.availableUsdc)} free`);
  if (perp.inPositionsUsdc != null && perp.inPositionsUsdc > 0) parts.push(`${usdc(perp.inPositionsUsdc)} in open positions`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  if (perp.balanceUsdc == null) out.push(perp.neverFunded ? "Your Main Account has no money yet." : "Your Main Account balance hasn't loaded yet.");
  else if (perp.partial && perp.partialReason === "other-collateral") {
    out.push(`Your Main Account holds ${usdc(perp.balanceUsdc)}${detail}; other collateral there is not counted in that figure.`);
  } else if (perp.partial) {
    out.push(`Part of your Main Account couldn't be read just now; the part that was read holds ${usdc(perp.balanceUsdc)}${detail}.`);
  } else if (perp.neverFunded || perp.balanceUsdc <= 0) out.push("Your Main Account is at 0 USDC.");
  else out.push(`Your Main Account holds ${usdc(perp.balanceUsdc)}${detail}.`);
  if (perp.inSpotUsdc != null && perp.inSpotUsdc > 0) out.push(`${usdc(perp.inSpotUsdc)} in your Main Account is set aside and not used for trading.`);
  /* The first deposit's last hop, in the customer's words: money joining the Main Account (it is counted there). The
     network is named only where the customer must act on it: the gas the move needs. */
  if (w) {
    const amt = w.usdc != null ? usdc(w.usdc, 6) : null;
    const moving = w.move === "moving" && w.movingUsdc != null && !w.waitingToMove
      ? `${usdc(w.movingUsdc, 6)} is moving into your Main Account now.` : null;
    if (w.usdc == null) {
      out.push("Money on its way into your Main Account couldn't be checked just now.");
      if (moving) out.push(moving);
    } else if (w.waitingToMove) {
      if (w.move === "moving") out.push(`${amt} is moving into your Main Account now.`);
      else if (w.move === "needs-press") out.push(`${amt} is waiting to move into your Main Account: the Deposit panel has a button to move it.`);
      else if (w.move === "needs-gas") out.push(`${amt} is waiting to move into your Main Account, but the move needs a little ${ARBITRUM_CHAIN_NAME} gas and there is none yet.`);
      else if (w.move === "failed") out.push(`${amt} is waiting to move into your Main Account. The last move didn't go through: the Deposit panel can try again.`);
      else out.push(`${amt} is on its way into your Main Account: it moves in by itself within a few minutes; if it hasn't, the Deposit panel has a button to move it.`);
    } else {
      if (moving) out.push(moving);
      if (w.belowMinimum) out.push(`${amt} is waiting to join your Main Account: it moves in once ${BRIDGE_MIN_USDC} USDC has arrived.`);
    }
    if (w.justMovedUsdc != null && !w.waitingToMove) out.push(`${usdc(w.justMovedUsdc, 6)} was just moved into your Main Account; it shows there within a minute or two.`);
  }
  for (const d of ways.slice(0, 3)) out.push(`${depositLine(d)} is ${d.stage} to ${d.to}.`);
  for (const d of bad.slice(0, 2)) out.push(`${depositLine(d)} ${d.stage === "didn't go through" ? "didn't go through" : /^less arrived/.test(d.stage) ? `is a problem: ${d.stage}` : `was ${d.stage}`}.`);
  if (depositsUnread === "loading") out.push("Whether a deposit is on its way is still being checked.");
  else if (depositsUnread) out.push("Whether a deposit is on its way couldn't be checked just now.");
  if (next === "open_deposit" && !(w && w.waitingToMove)) out.push("No money is on its way: a deposit is the way to start trading.");
  return out.join(" ");
}

/* What the Agent can offer next: the Deposit panel when there is nothing anywhere, or a move that needs a press.
   Anything not read (a Perp balance read in part, a wallet or a deposit watch that has not answered) is no claim of
   "nothing anywhere": then nothing is offered. */
function nextStep({ perp, arbitrumWallet: w, depositsOnTheWay: ways, depositsUnread }) {
  if (w && w.waitingToMove && (w.move === "needs-press" || w.move === "failed")) return "open_deposit";
  const empty = !perp.partial && (perp.neverFunded || (perp.balanceUsdc != null && perp.balanceUsdc <= 0));
  const nothingComing = !ways.length && !depositsUnread
    && !(w && (w.waitingToMove || w.justMovedUsdc != null || w.belowMinimum || w.move === "moving"));
  return empty && nothingComing && !(w && w.usdc == null) ? "open_deposit" : null;
}

/**
 * Where this account's money is, right now.
 *
 *   backend       the perp backend (connected, mock, address, account)
 *   address       the wallet (default backend.address)
 *   readArbitrum  (owner) => { raw: bigint, usdc: number } from the chain (default readArbitrumUsdcBalance)
 *   readDeposits  () => the deposit watch's state (default depositWatch.getState)
 *   readMove      (owner) => the last-hop runner's { step, code, usdc, at } or null (default: none)
 *
 * Resolves a JSON-able object (no BigInt). Never rejects.
 */
export async function readFunds({
  backend,
  address = backend ? backend.address : null,
  readArbitrum = (owner) => readArbitrumUsdcBalance({ owner }),
  readDeposits = () => depositWatch.getState(),
  readMove = null,
  timeoutMs = FUNDS_CHAIN_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const b = backend || {};
  if (!b.connected) {
    return { signed_in: false, perp: null, arbitrumWallet: null, depositsOnTheWay: [], summary: "Not signed in. Sign in to see where your money is." };
  }
  const perp = perpFunds(b);
  if (b.mock) {
    const base = { perp, arbitrumWallet: null, depositsOnTheWay: [], depositProblems: [], depositsUnread: null };
    return { signed_in: true, mock: true, ...base, next: null, where: MONEY_MAP, summary: `Mock account (mock money). ${fundsSummary(base)}` };
  }
  const who = typeof address === "string" && ADDR.test(address) ? address : null;
  let arbitrumWallet = null;
  let deps = { onTheWay: [], problems: [], unread: null };
  if (who) {
    arbitrumWallet = await arbitrumFunds(who, { readArbitrum, readMove, timeoutMs, now });
    /* A watch that could not be read is "not checked", never "nothing coming". */
    try { deps = depositsFrom(readDeposits(), who, now()); } catch { deps = { onTheWay: [], problems: [], unread: "failed" }; }
  }
  const out = { perp, arbitrumWallet, depositsOnTheWay: deps.onTheWay, depositProblems: deps.problems, depositsUnread: deps.unread };
  const next = nextStep(out);
  return { signed_in: true, mock: false, ...out, next, where: MONEY_MAP, summary: fundsSummary({ ...out, next }) };
}
