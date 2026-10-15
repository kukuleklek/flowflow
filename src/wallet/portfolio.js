// THE WHOLE BALANCE: one total across every place the customer's money sits, and the parts it is made of.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "ตรงกล่อง Balance ควรรวม Balance ของ Avax Staked Asset — และหน้า Wallet แม้ในการมีทุกอย่าง
// และ Recognized ทุก Balance". The Home portfolio card and the Wallet page both draw this object; nothing here reads
// the network (src/hooks/usePortfolio.js does, and hands the answers in), so the Node suite drives it with plain data.
//
// Owner, 2026-10-15: "อย่าเรียก Perp Account … ลูกค้าไม่ต้องรู้หรอกว่า อะไรมันแยกกัน เอารวมกันให้หมดเลย", then "แยกบัญชี
// แค่ Main, Spot" and "USDC Staked AAVE บน AVAX อยู่ใน Spot อีกที". The customer sees TWO accounts and one total; which
// chain holds what is the app's business, not theirs:
//
//   Main Account   (key "perp")  Hyperliquid: the account's equity (positions included), + its Spot USDC (the equity
//                                leaves it out), + the USDC in the customer's own wallet on Arbitrum (the first
//                                deposit's last hop, which moves into it by itself)          funds.js perpFunds, arbitrumWallet
//   Spot Account   (key "avax")  the customer's own wallet on Avalanche: the whitelisted coins in USD, + inside it,
//                                "USDC Staked AAVE" (USDC supplied to Aave V3 on Avalanche, aAvaUSDC, 1 : 1 USDC)
//                                                                                              lib/avax/read.js + prices
//
//   inFlight  deposits on their way, a hop moving, Avax moves in progress: SHOWN APART, NEVER ADDED. Money that has
//             left one place and not reached the next is in no balance above, and the total never counts it twice.
//
// 🔴 UNKNOWN IS NULL, NEVER 0. A part that was not read, or could not be, is "—" and the total says it is partial;
// an asset held with no price is unpriced (partial), never $0. A part that does not apply (a mock account has no
// wallet on any chain) is "off": it is not counted and it does not make the total partial.
//
// READ ONLY. Nothing here signs, sends or starts anything.

import { whitelistAssets } from "../lib/avax/whitelist.js";
import { displayPrice } from "../lib/avax/prices.js";
import { formatRaw } from "../lib/avax/units.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

/** "$1,234.56"; a non-zero amount under a cent is "<$0.01", never "$0.00"; unknown is "—". */
export function usdText(v) {
  if (!fin(v)) return "—";
  if (v > 0 && v < 0.005) return "<$0.01";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `−$${s}` : `$${s}`;
}

/** "5.70%" or "—". */
export function pctText(v, dp = 2) {
  return fin(v) ? `${v.toFixed(dp)}%` : "—";
}

/* How many decimals an asset's amount is shown with (cut down, never rounded up). */
const AMOUNT_DP = { USDC: 2, USDT: 2, AVAX: 4, WAVAX: 4, "BTC.b": 6, XAUt0: 4 };

/* Where an asset's logo comes from: the whitelist's own file when it ships one, else nothing (an initial disc). */
const LOCAL_LOGOS = new Set(["/tokens/usdc.svg", "/tokens/usdt.svg", "/hl-coins/AVAX.svg", "/hl-coins/BTC.svg"]);
/* Coins whose own file is not shipped yet draw the app's local mark for the same metal (a coin logo, not a vendor's). */
const LOGO_FALLBACK = { XAUt0: "/hl-coins/xyz-GOLD.svg" };

/* The owner's names (2026-10-15): Hyperliquid is the Main Account, the Avax wallet is the Spot Account, and the Aave
   position is "USDC Staked AAVE", a holding inside the Spot Account (on AVAX). */
export const PART_LABEL = Object.freeze({
  perp: "Main Account",
  avax: "Spot Account",
});
export const STAKED_LABEL = "USDC Staked AAVE";
export const STAKED_WHERE = "on AVAX";

/** Words for a part that does not apply here. */
export const OFF_WHY = Object.freeze({ mock: "Live only" });

/* ── the parts ───────────────────────────────────────────────────────────── */

function perpPart(perp, { settled }) {
  if (!perp || perp.balanceUsdc == null) {
    /* A never-funded account answered: it is 0, and that is a real answer. */
    if (perp && perp.neverFunded) return { key: "perp", status: "ok", usd: 0, freeUsd: 0, inPositionsUsd: 0 };
    return { key: "perp", status: settled ? "unknown" : "loading", usd: null };
  }
  return {
    key: "perp",
    status: perp.partial ? "partial" : "ok",
    usd: perp.balanceUsdc,
    freeUsd: perp.availableUsdc,
    inPositionsUsd: perp.inPositionsUsdc,
    openPositions: perp.openPositions,
    partialReason: perp.partialReason || null,
  };
}

function spotPart(perp) {
  /* Only when there is some: Spot USDC is 0 or unread for nearly everybody, and its row would only be noise. */
  if (!perp || !fin(perp.inSpotUsdc) || perp.inSpotUsdc <= 0) return null;
  return { key: "spot", status: "ok", usd: perp.inSpotUsdc };
}

/**
 * The Avax wallet's assets, priced. `account` is readAvaxAccount()'s answer (or null), `prices` {relay, mids}.
 * Each row: { symbol, name, logo, amount, amountText, price, usd, usdText, held, status }.
 *   status "ok" (amount and value known) | "unpriced" (held, no price) | "unknown" (amount unread)
 */
export function avaxAssets(account, { relay = {}, mids = null, env = undefined } = {}) {
  const list = env === undefined ? whitelistAssets() : whitelistAssets(env);
  const read = account && Array.isArray(account.assets) ? account.assets : [];
  return list.map((a) => {
    const got = read.find((x) => x && x.symbol === a.symbol) || null;
    const raw = got && typeof got.raw === "bigint" ? got.raw : null;
    const amount = got && fin(got.amount) ? got.amount : null;
    const { usd: price } = displayPrice(a.symbol, { relay, mids });
    let usd = null;
    let status = "unknown";
    if (amount != null && raw != null) {
      if (raw === 0n) { usd = 0; status = "ok"; }
      else if (fin(price)) { usd = amount * price; status = "ok"; }
      else status = "unpriced";
    }
    return {
      symbol: a.symbol,
      name: a.name,
      logo: a.logo && LOCAL_LOGOS.has(a.logo) ? a.logo : LOGO_FALLBACK[a.symbol] || null,
      native: !!a.native,
      role: a.role,
      tip: a.tip || null,
      amount,
      amountText: raw == null ? "—" : formatRaw(raw, a.decimals, AMOUNT_DP[a.symbol] ?? 4),
      price: fin(price) ? price : null,
      usd,
      usdText: status === "unpriced" ? "No price" : usdText(usd),
      held: raw != null && raw > 0n,
      status,
    };
  });
}

function avaxPart(avax, assets, { settled }) {
  const st = avax ? avax.status : "loading";
  if (st === "off") return { key: "avax", status: "off", usd: null, why: avax.why || OFF_WHY.mock };
  if (st === "loading" || st === "failed" || !avax.account) {
    if (st === "loading" && !settled) return { key: "avax", status: "loading", usd: null };
    return { key: "avax", status: "unknown", usd: null, why: avax && avax.why ? avax.why : "Couldn't read Avalanche" };
  }
  let usd = 0;
  let known = 0;
  let missing = 0;
  for (const a of assets) {
    if (a.status === "ok") { usd += a.usd; known += 1; } else missing += 1;
  }
  const held = assets.filter((a) => a.held).length;
  if (!known) return { key: "avax", status: "unknown", usd: null, held, why: "Couldn't read Avalanche" };
  return { key: "avax", status: missing ? "partial" : "ok", usd, held };
}

function aavePart(avax, { usdcPrice, apyPct, settled }) {
  const st = avax ? avax.status : "loading";
  const reserve = avax && avax.account && avax.account.aave ? avax.account.aave.status : null;
  const base = {
    key: "aave",
    apyPct: fin(apyPct) ? apyPct : reserve && fin(reserve.apyPct) ? reserve.apyPct : null,
    frozen: !!(reserve && reserve.frozen),
    paused: !!(reserve && reserve.paused),
  };
  if (st === "off") return { ...base, status: "off", usd: null, suppliedUsdc: null, why: avax.why || OFF_WHY.mock };
  if (st === "loading" && !settled) return { ...base, status: "loading", usd: null, suppliedUsdc: null };
  const supplied = avax && avax.account && avax.account.aave ? avax.account.aave.suppliedUsdc : null;
  if (!fin(supplied)) return { ...base, status: "unknown", usd: null, suppliedUsdc: null };
  /* aAvaUSDC redeems 1 : 1 for USDC; it is worth what USDC is worth (Relay's price, else the $1 peg). */
  const px = fin(usdcPrice) ? usdcPrice : 1;
  return { ...base, status: "ok", usd: supplied === 0 ? 0 : supplied * px, suppliedUsdc: supplied };
}

function arbitrumPart(arb, { settled }) {
  const st = arb ? arb.status : "loading";
  if (st === "off") return { key: "arbitrum", status: "off", usd: null, why: arb.why || OFF_WHY.mock, show: false };
  const w = arb && arb.wallet ? arb.wallet : null;
  if (!w || w.usdc == null) {
    if (st === "loading" && !settled) return { key: "arbitrum", status: "loading", usd: null, show: false };
    /* Unread: shown as "—" (and the total is partial) only once it has failed; quiet while it loads. */
    return { key: "arbitrum", status: "unknown", usd: null, show: true };
  }
  let note = null;
  if (w.waitingToMove) note = w.move === "moving" ? "Moving in" : w.move === "needs-gas" ? "Needs gas to move" : w.move === "failed" ? "Move didn't go through" : w.move === "needs-press" ? "Ready to move" : "Moving in";
  else if (w.belowMinimum) note = `Waits for ${w.minimumUsdc} USDC`;
  return { key: "arbitrum", status: "ok", usd: w.usdc, show: w.usdc > 0, note, waitingToMove: !!w.waitingToMove, belowMinimum: !!w.belowMinimum };
}

/* ── in flight: shown apart, never added ─────────────────────────────────── */

/* In the customer's words: one balance, never an account or a chain. */
const FLOW_TITLE = Object.freeze({
  stake: "Staking USDC",
  unstake: "Unstaking USDC",
  "move-in": "Moving funds",
  "move-out": "Moving funds",
  swap: "Swap",
  "gas-topup": "Gas top-up",
  "remove-allowance": "Removing an approval",
});
const IN_FLIGHT = new Set(["confirmed", "sending", "arriving", "unknown"]);

/** A flow record's amount, when it says one in a shape this page knows ({usdc}, {amount, symbol}, {fromAmount, from}). */
function flowAmount(a) {
  if (!a || typeof a !== "object") return { amount: null, token: null };
  const n = (v) => (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fin(v) ? v : null);
  if (n(a.usdc) != null) return { amount: n(a.usdc), token: "USDC" };
  if (n(a.amount) != null) return { amount: n(a.amount), token: typeof a.symbol === "string" ? a.symbol : typeof a.token === "string" ? a.token : null };
  if (n(a.fromAmount) != null) return { amount: n(a.fromAmount), token: typeof a.from === "string" ? a.from : null };
  return { amount: null, token: null };
}

/* "20 USDC", "9.92 USDC" (USDC to the cent; a non-zero amount under a cent is "<0.01"), "0.5 AVAX" (other coins
   up to 6 decimals). */
const amountWords = (amount, token) => {
  if (amount == null || !fin(Number(amount))) return null;
  const t = token || "USDC";
  const n = Number(amount);
  if (t === "USDC" || t === "USDT") return n > 0 && n < 0.005 ? `<0.01 ${t}` : `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${t}`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${t}`;
};

/**
 * Everything on its way, newest first as the readers give it. Each row:
 *   { key, kind: "deposit"|"hop"|"flow"|"problem", title, amountText, from, to, stage, tone: "neutral"|"warn" }
 */
export function inFlightRows({ deposits = null, arbitrum = null, flows = null } = {}) {
  const rows = [];
  const d = deposits || {};
  (d.onTheWay || []).forEach((x, i) => {
    rows.push({
      key: `dep-${i}`,
      kind: "deposit",
      title: x.from ? `Deposit from ${x.from}` : "Deposit",
      amountText: amountWords(x.amount, x.token),
      token: x.token || "USDC",
      from: x.from || null,
      to: "your balance",
      stage: x.stage === "taking longer than usual" ? "Taking longer" : "On its way",
      tone: "neutral",
    });
  });
  const w = arbitrum && arbitrum.wallet ? arbitrum.wallet : null;
  if (w && !w.waitingToMove) {
    if (w.move === "moving" && fin(w.movingUsdc)) {
      rows.push({ key: "hop-moving", kind: "hop", title: "Joining your balance", amountText: amountWords(w.movingUsdc, "USDC"), token: "USDC", from: null, to: null, stage: "Moving", tone: "neutral" });
    } else if (fin(w.justMovedUsdc)) {
      rows.push({ key: "hop-sent", kind: "hop", title: "Joining your balance", amountText: amountWords(w.justMovedUsdc, "USDC"), token: "USDC", from: null, to: null, stage: "Arriving", tone: "neutral" });
    }
  }
  /* Newest first: the registry keeps its records oldest first, so they are sorted here by their last change. (Deposit
     requests come newest first from the deposit service already.) */
  const flowAt = (f) => (fin(f.updatedAt) ? f.updatedAt : fin(f.startedAt) ? f.startedAt : 0);
  const inFlight = (Array.isArray(flows) ? flows : []).filter((f) => f && IN_FLIGHT.has(f.state)).sort((x, y) => flowAt(y) - flowAt(x));
  for (const f of inFlight) {
    const { amount, token } = flowAmount(f.amounts);
    rows.push({
      key: `flow-${f.id}`,
      kind: "flow",
      title: FLOW_TITLE[f.kind] || "Move",
      amountText: amountWords(amount, token),
      token: token || "USDC",
      from: null,
      to: null,
      /* 🔴 Printed, never folded: money may have moved and the screen must not invite a second send. */
      stage: f.state === "unknown" ? "Not confirmed. Don't send it again." : f.state === "arriving" ? "Arriving" : "Sending",
      tone: f.state === "unknown" ? "warn" : "neutral",
    });
  }
  (d.problems || []).forEach((x, i) => {
    rows.push({
      key: `bad-${i}`,
      kind: "problem",
      title: x.from ? `Deposit from ${x.from}` : "Deposit",
      amountText: amountWords(x.amount, x.token),
      token: x.token || "USDC",
      from: x.from || null,
      to: null,
      stage: x.stage === "sent back to where it came from" ? "Sent back" : "Didn't go through",
      tone: "warn",
    });
  });
  return rows;
}

/* ── the balance as ONE list of what the customer holds ───────────────── */

/**
 * Owner, 2026-10-15: "Balance … มันต้องรวมกันไปเลย — แบบ BTCb ถ้ากดซื้อเข้า ไปบน Balance เลย พอกดขาย USDC วาปกลับไป
 * Hypercore … หรือแม้แต่ Avax แต่ในหน้า Balance อยู่ด้วยกันไปเลย". The Wallet lists what the customer HOLDS, one row
 * per asset, never per account or chain: USDC is one row (the Main Account's money, which trades, plus any USDC in
 * the Spot Account), then the staked USDC, then every other coin held. The rows add up to the balance.
 *
 * Row: { key, symbol, name, logo, usd, usdText, sub, amountText, status: "ok"|"partial"|"unknown"|"loading", tip }
 * Unknown is "—" (never 0); a part of a row that could not be read makes the row "partial".
 */
export function holdingsRows(v) {
  if (!v || v.state !== "ready") return [];
  const rows = [];
  const main = v.perp || null;
  const spotUsdc = (v.assets || []).find((a) => a.symbol === "USDC") || null;
  const usdcParts = [];
  let usdcStatus = "ok";
  if (main) {
    if (main.status === "loading") usdcStatus = "loading";
    else if (main.status === "unknown") usdcStatus = "partial";
    else { if (main.status === "partial") usdcStatus = "partial"; if (fin(main.usd)) usdcParts.push(main.usd); }
  }
  if (spotUsdc) {
    if (spotUsdc.status === "ok") usdcParts.push(spotUsdc.usd);
    else if (usdcStatus === "ok") usdcStatus = "partial";
  }
  if (!usdcParts.length && usdcStatus !== "loading") usdcStatus = "unknown";
  const usdcUsd = usdcParts.length ? usdcParts.reduce((a, x) => a + x, 0) : null;
  /* The USDC held, as an amount: the Main Account's money (USDC) + the Spot Account's USDC tokens. */
  const usdcAmount = (main && fin(main.usd) ? main.usd : 0) + (spotUsdc && spotUsdc.status === "ok" && fin(spotUsdc.amount) ? spotUsdc.amount : 0);
  const spotUnread = v.avax && (v.avax.status === "unknown" || v.avax.status === "partial");
  if (spotUnread && usdcStatus === "ok") usdcStatus = "partial";
  rows.push({
    key: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    logo: "/tokens/usdc.svg",
    usd: usdcUsd,
    usdText: usdText(usdcUsd),
    sub: main && fin(main.freeUsd) ? `${usdText(main.freeUsd)} available to trade` : null,
    amountText: usdcUsd != null ? `${usdcAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC` : null,
    status: usdcStatus,
    tip: null,
  });
  const st = v.aave;
  if (st && st.status === "ok" && fin(st.usd) && st.usd > 0) {
    rows.push({
      key: "staked",
      symbol: STAKED_LABEL,
      name: [st.apyPct != null ? `${pctText(st.apyPct)} APY` : null, STAKED_WHERE].filter(Boolean).join(" · "),
      logo: "/tokens/usdc.svg",
      chain: "Avalanche",
      usd: st.usd,
      usdText: usdText(st.usd),
      sub: null,
      amountText: `${st.suppliedUsdc.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`,
      status: "ok",
      tip: "The rate is variable and set by Aave. Staked USDC stays yours and can be taken out while Aave has free liquidity.",
      earning: st.apyPct != null,
    });
  }
  const coins = (v.assets || [])
    .filter((a) => a.symbol !== "USDC" && (a.held || a.status === "unknown"))
    .map((a) => ({
      key: a.symbol,
      symbol: a.symbol,
      name: a.name,
      logo: a.logo,
      usd: a.usd,
      usdText: a.status === "unpriced" ? "No price" : usdText(a.usd),
      sub: null,
      amountText: a.amountText === "—" ? "—" : `${a.amountText} ${a.symbol}`,
      status: a.status === "unpriced" ? "partial" : a.status,
      tip: a.tip,
      gas: a.role === "gas",
    }))
    .sort((x, y) => (fin(y.usd) ? y.usd : -1) - (fin(x.usd) ? x.usd : -1));
  const all = rows.concat(coins);
  /* Coins that could not be read are a row of their own ("—"), never a list that looks complete. */
  if (v.avax && v.avax.status === "unknown") {
    all.push({ key: "coins-unread", symbol: "Coins", name: "Couldn't read just now", logo: null, usd: null, usdText: "—", sub: null, amountText: null, status: "unknown", tip: null });
  }
  /* The printed rows add up to the printed balance: when every row was read, USDC takes the rounding cent. */
  const t = v.total && fin(v.total.usd) ? v.total.usd : null;
  if (t != null && all.every((r) => r.status === "ok" && fin(r.usd)) && all.length > 1) {
    const others = all.slice(1).reduce((a, r) => a + Math.round(r.usd * 100) / 100, 0);
    const usdc = Math.round((t - others) * 100) / 100;
    all[0] = { ...all[0], usd: usdc, usdText: usdText(usdc) };
  }
  return all;
}

/* ── the whole view ──────────────────────────────────────────────────────── */

/**
 * @param {object} p
 * @param {boolean} p.signedIn
 * @param {boolean} [p.pending]      a sign-in is on its way
 * @param {boolean} [p.mock]
 * @param {object|null} p.perp       funds.js perpFunds(backend)
 * @param {{status:string, account?:object, why?:string}|null} p.avax       "loading"|"ok"|"failed"|"off"
 * @param {{relay?:object, mids?:object}} [p.prices]
 * @param {number|null} [p.apyPct]   the Aave USDC supply APY when read on its own (signed out, mock)
 * @param {{status:string, wallet?:object}|null} p.arbitrum                  "loading"|"ok"|"failed"|"off"
 * @param {{onTheWay:any[], problems:any[], unread:string|null}|null} p.deposits
 * @param {any[]|null} [p.flows]     the Avax flow registry's records
 * @param {boolean} [p.settled]      past the first wait: a part still loading now reads as unknown
 */
export function portfolioView({
  signedIn = false, pending = false, mock = false, perp = null, avax = null, prices = {}, apyPct = null,
  arbitrum = null, deposits = null, flows = null, settled = false, env = undefined,
} = {}) {
  if (!signedIn) {
    return { state: pending ? "pending" : "signed-out", mock, total: null, parts: [], assets: [], aave: null, inFlight: [], apyPct: fin(apyPct) ? apyPct : null };
  }
  const relay = prices && prices.relay ? prices.relay : {};
  const mids = prices && prices.mids ? prices.mids : null;
  const assets = avax && avax.account ? avaxAssets(avax.account, { relay, mids, env }) : [];
  const usdcPrice = displayPrice("USDC", { relay, mids }).usd;

  /* The pieces, each with its own rule for unknown / loading / off … */
  const p = perpPart(perp, { settled });
  const spot = spotPart(perp);
  const av = avaxPart(avax, assets, { settled });
  const aave = aavePart(avax, { usdcPrice, apyPct, settled });
  const arb = arbitrumPart(arbitrum, { settled });
  const pieces = [p, spot, av, aave, arb].filter(Boolean);

  const loading = pieces.some((x) => x.status === "loading");

  /* … and the two accounts the customer sees. The Main Account is the Perp equity, its Spot USDC and the Arbitrum
     hop wallet together (the hop moves into it by itself); it is unknown when its equity is (then the hop is not
     counted anywhere: it belongs to the Main Account), partial when only the hop could not be read. */
  const arbUsd = arb.status === "ok" && fin(arb.usd) ? arb.usd : 0;
  let mainStatus = p.status;
  if (p.status === "ok" || p.status === "partial") {
    if (arb.status === "unknown") mainStatus = "partial";
    else if (arb.status === "loading") mainStatus = settled ? "partial" : "loading";
  }
  const arbWaiting = arb.status === "ok" && (arb.belowMinimum || /gas|didn't|Ready/.test(arb.note || ""));
  const main = {
    ...p,
    status: mainStatus,
    usd: fin(p.usd) ? p.usd + (spot ? spot.usd : 0) + arbUsd : null,
    /* The Main card's stats add up to its figure: Available + In positions (the equity the positions hold, their
       margin and their unrealised P&L) + Arriving / Waiting (the hop) + Idle (Spot USDC). */
    inPositionsUsd: fin(p.usd) && fin(p.freeUsd) ? Math.max(0, r2(p.usd - p.freeUsd)) : p.inPositionsUsd ?? null,
    marginUsd: p.inPositionsUsd ?? null,
    arrivingUsd: arbUsd > 0 ? arbUsd : null,
    arrivingLabel: arbWaiting ? "Waiting" : "Arriving",
    idleUsd: spot ? spot.usd : null,
    spotUsd: spot ? spot.usd : null,
  };
  /* The Spot Account is the Avalanche wallet's coins and, inside it, the staked USDC (one read answers both). */
  const staked = { ...aave, label: STAKED_LABEL, where: STAKED_WHERE, usdText: usdText(aave.usd) };
  let spotStatus;
  if (av.status === "off") spotStatus = "off";
  else if (av.status === "loading" || aave.status === "loading") spotStatus = "loading";
  else if (av.status === "unknown" && aave.status === "unknown") spotStatus = "unknown";
  else if (av.status === "ok" && aave.status === "ok") spotStatus = "ok";
  else spotStatus = "partial";
  const spotKnown = [av, aave].filter((x) => (x.status === "ok" || x.status === "partial") && fin(x.usd));
  const spotPlace = {
    ...av,
    status: spotStatus,
    usd: spotStatus === "off" || spotStatus === "unknown" || !spotKnown.length ? null : spotKnown.reduce((a, x) => a + x.usd, 0),
    coinsUsd: fin(av.usd) ? av.usd : null,
    stakedUsd: aave.status === "ok" && fin(aave.usd) ? aave.usd : null,
    apyPct: aave.apyPct,
  };
  const parts = [main, spotPlace].map((x) => ({ ...x, label: PART_LABEL[x.key], usdText: usdText(x.usd) }));
  const missing = parts
    .filter((x) => x.status === "unknown" || (x.status === "partial" && (x.key === "avax" || arb.status === "unknown")))
    .map((x) => x.label);

  /* No total until the Main Account answers, and none while a part is still in its first wait: a figure that jumps
     by a whole account a second later reads as money moving. After the wait, a part still unread is "—" and the
     total is printed as partial; when the part lands, the total takes it in. */
  const waiting = p.status === "loading" || (loading && !settled);
  /* The total is the two accounts added up, nothing else: a piece that belongs to an account nobody could read is
     not counted on its own. No account with a figure → no total ("—"), never $0.00. */
  const live = parts.filter((x) => x.status !== "off");
  const counted = live.filter((x) => (x.status === "ok" || x.status === "partial") && fin(x.usd));
  const usd = counted.reduce((a, x) => a + x.usd, 0);
  const total = {
    usd: counted.length && !waiting ? r2(usd) : null,
    text: counted.length && !waiting ? usdText(r2(usd)) : "—",
    loading: waiting,
    partial: live.some((x) => x.status === "partial" || x.status === "unknown" || x.status === "loading"),
    missing,
  };

  const inFlight = mock ? [] : inFlightRows({ deposits, arbitrum, flows });
  const unread = mock || !deposits ? null : deposits.unread || null;

  return {
    state: "ready",
    mock,
    total,
    parts,
    /* What the Home lists: every part that is counted, loading or unknown (not the "off" ones). */
    shown: parts.filter((x) => x.status !== "off"),
    assets,
    held: assets.filter((a) => a.held || a.status === "unknown"),
    aave: staked,
    perp: parts[0],
    avax: parts[1],
    apyPct: aave.apyPct,
    inFlight,
    inFlightUnread: unread,
  };
}
