/**
 * test-portfolio — the whole balance (src/wallet/portfolio.js): one total across the Perp account, the Avax wallet,
 * Aave USDC and the Arbitrum hop wallet, with what is on its way shown apart and never added.
 *
 * Owner, 2026-10-15: "ตรงกล่อง Balance ควรรวม Balance ของ Avax Staked Asset — และหน้า Wallet ... Recognized ทุก Balance".
 * Every answer is plain data: no chain, no price service, no network.
 *
 * Run: node --test scripts/test-portfolio.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portfolioView, avaxAssets, inFlightRows, usdText, pctText, holdingsRows } from "../src/wallet/portfolio.js";
import { previewInputs } from "../src/wallet/portfolioPreview.js";
import { customerWords } from "../src/wallet/words.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const perpOk = (balance = 1000, extra = {}) => ({
  balanceUsdc: balance, availableUsdc: balance - 29.23, inPositionsUsdc: 29.23, openPositions: 2,
  inSpotUsdc: null, neverFunded: false, partial: false, partialReason: null, ...extra,
});

const asset = (symbol, decimals, amount, native = false) => {
  const raw = amount == null ? null : BigInt(Math.round(amount * 10 ** Math.min(decimals, 12))) * 10n ** BigInt(Math.max(0, decimals - 12));
  return { symbol, decimals, native, raw, amount };
};
function account({ usdc = 0, avax = 0, wavax = 0, btcb = 0, usdt = 0, xaut = 0, aave = 0, missing = [] } = {}) {
  const a = (s, d, v, n) => asset(s, d, missing.includes(s) ? null : v, n);
  return {
    assets: [a("USDC", 6, usdc), a("AVAX", 18, avax, true), a("WAVAX", 18, wavax), a("BTC.b", 8, btcb), a("USDT", 6, usdt), a("XAUt0", 6, xaut)],
    aave: {
      suppliedRaw: missing.includes("aave") ? null : BigInt(Math.round(aave * 1e6)),
      suppliedUsdc: missing.includes("aave") ? null : aave,
      status: { apyPct: 5.7002, frozen: false, paused: false },
    },
  };
}
const RELAY = { USDC: 1, AVAX: 10, WAVAX: 10, "BTC.b": 80000, USDT: 1, XAUt0: 4000 };
const arbOk = (usdc = 0, extra = {}) => ({ status: "ok", wallet: { usdc, waitingToMove: usdc >= 5, belowMinimum: usdc > 0 && usdc < 5, minimumUsdc: 5, move: null, ...extra } });
const noDeposits = { onTheWay: [], problems: [], unread: null };

function live(over = {}) {
  return portfolioView({
    signedIn: true, mock: false, settled: true,
    perp: perpOk(),
    avax: { status: "ok", account: account({ usdc: 100, avax: 2, aave: 250 }) },
    prices: { relay: RELAY, mids: { AVAX: 9.9, BTC: 79000 } },
    arbitrum: arbOk(0),
    deposits: noDeposits,
    flows: [],
    ...over,
  });
}
const part = (v, key) => v.parts.find((p) => p.key === key);

/* ── the total ─────────────────────────────────────────────────────────── */

test("two accounts, one total: Main Account (Hyperliquid + its Spot USDC + the Arbitrum hop), Spot Account (coins + USDC Staked AAVE)", () => {
  const v = live({ arbitrum: arbOk(9.918) });
  // 1000 main + 9.918 arbitrum (folded into Main) + (100 USDC + 2 AVAX × 10) coins + 250 staked, both in Spot
  assert.equal(v.total.usd, 1379.92);
  assert.equal(v.total.text, "$1,379.92");
  assert.equal(v.total.partial, false);
  assert.deepEqual(v.parts.map((p) => p.label), ["Main Account", "Spot Account"]);
  assert.equal(part(v, "perp").usd, 1009.918);
  assert.equal(part(v, "perp").arrivingUsd, 9.918);
  assert.equal(part(v, "avax").usd, 370);
  assert.equal(part(v, "avax").coinsUsd, 120);
  assert.equal(part(v, "avax").stakedUsd, 250);
  assert.equal(v.aave.label, "USDC Staked AAVE");
  assert.equal(v.aave.where, "on AVAX");
  assert.equal(v.aave.usd, 250);
  assert.equal(v.parts.some((p) => /perp|arbitrum|avax wallet|aave/i.test(p.label)), false, "no chain or venue names");
});

test("Spot USDC (left out of the Hyperliquid equity) is in the Main Account, counted once", () => {
  const v = live({ perp: perpOk(1000, { inSpotUsdc: 12.5 }) });
  assert.equal(part(v, "perp").usd, 1012.5);
  assert.equal(part(v, "perp").spotUsd, 12.5);
  assert.equal(v.total.usd, 1000 + 12.5 + 120 + 250);
  assert.equal(v.parts.length, 2);
});

test("an Arbitrum wallet at 0 adds nothing and never shows as its own place", () => {
  const v = live({ arbitrum: arbOk(0) });
  assert.equal(part(v, "perp").usd, 1000);
  assert.equal(part(v, "perp").arrivingUsd, null);
  assert.equal(v.total.partial, false);
});

test("the Arbitrum hop unreadable: the Main Account is partial (never a silent 0)", () => {
  const v = live({ arbitrum: { status: "failed" } });
  assert.equal(part(v, "perp").status, "partial");
  assert.equal(part(v, "perp").usd, 1000);
  assert.equal(v.total.partial, true);
  assert.deepEqual(v.total.missing, ["Main Account"]);
});

test("Avalanche unreadable: its parts are '—', the total is partial and names what is missing", () => {
  const v = live({ avax: { status: "failed", why: "Couldn't read Avalanche" } });
  assert.equal(part(v, "avax").status, "unknown");
  assert.equal(part(v, "avax").usdText, "—");
  assert.equal(v.aave.usdText, "—");
  assert.equal(v.total.partial, true);
  assert.deepEqual(v.total.missing, ["Spot Account"]);
  assert.equal(v.total.usd, 1000, "only what was read is added");
});

test("a held asset with no price is unpriced (partial), never $0", () => {
  const v = live({
    avax: { status: "ok", account: account({ usdc: 100, xaut: 0.5 }) },
    prices: { relay: { USDC: 1 }, mids: null },
  });
  const x = v.assets.find((a) => a.symbol === "XAUt0");
  assert.equal(x.status, "unpriced");
  assert.equal(x.usd, null);
  assert.equal(x.usdText, "No price");
  assert.equal(part(v, "avax").status, "partial");
  assert.equal(part(v, "avax").usd, 100);
  assert.equal(v.total.partial, true);
});

test("an asset at 0 is $0 even without a price; an unread asset is '—'", () => {
  const rows = avaxAssets(account({ usdc: 5, missing: ["BTC.b"] }), { relay: {}, mids: null });
  const usdt = rows.find((a) => a.symbol === "USDT");
  assert.equal(usdt.usd, 0);
  assert.equal(usdt.status, "ok");
  const btc = rows.find((a) => a.symbol === "BTC.b");
  assert.equal(btc.status, "unknown");
  assert.equal(btc.amountText, "—");
  assert.equal(btc.usdText, "—");
  /* USDC with no Relay price falls back to the $1 peg (the app's base unit). */
  assert.equal(rows.find((a) => a.symbol === "USDC").usd, 5);
});

test("AVAX and BTC.b fall back to the Hyperliquid mid when Relay has no price", () => {
  const rows = avaxAssets(account({ avax: 1, btcb: 0.001 }), { relay: {}, mids: { AVAX: 9.5, BTC: 80000 } });
  assert.equal(rows.find((a) => a.symbol === "AVAX").usd, 9.5);
  assert.equal(rows.find((a) => a.symbol === "BTC.b").usd, 80);
});

test("an Aave position that was not read is unknown, not 0", () => {
  const v = live({ avax: { status: "ok", account: account({ usdc: 1, missing: ["aave"] }) } });
  assert.equal(v.aave.status, "unknown");
  assert.equal(v.aave.usd, null);
  assert.equal(part(v, "avax").status, "partial", "the coins were read; the staked part was not");
  assert.equal(part(v, "avax").usd, 1, "only what was read is added");
  assert.equal(v.total.partial, true);
  assert.equal(v.aave.apyPct, 5.7002, "the APY still shows from the reserve");
});

test("the Perp balance not read yet: no total at all (a skeleton), never a total without it", () => {
  const v = live({ perp: { balanceUsdc: null, neverFunded: false }, settled: false });
  assert.equal(v.total.loading, true);
  assert.equal(v.total.usd, null);
  assert.equal(v.total.text, "—");
  const later = live({ perp: { balanceUsdc: null, neverFunded: false }, settled: true });
  assert.equal(part(later, "perp").status, "unknown");
  assert.equal(later.total.partial, true);
  assert.deepEqual(later.total.missing, ["Main Account"]);
});

test("a never-funded Perp account is a real 0", () => {
  const v = live({ perp: { balanceUsdc: null, neverFunded: true } });
  assert.equal(part(v, "perp").usd, 0);
  assert.equal(part(v, "perp").status, "ok");
});

test("a Perp balance read only in part makes the total partial", () => {
  const v = live({ perp: perpOk(500, { partial: true, partialReason: "perp-venues-partial" }) });
  assert.equal(part(v, "perp").status, "partial");
  assert.equal(v.total.partial, true);
});

test("Avalanche still loading in the first wait: the total waits too (no jump); after it, partial", () => {
  const v = live({ avax: { status: "loading" }, arbitrum: { status: "loading" }, settled: false });
  assert.equal(v.total.loading, true);
  assert.equal(v.total.usd, null);
  assert.equal(part(v, "avax").status, "loading");
  assert.equal(part(v, "perp").status, "loading", "the Main Account waits for its hop wallet too");
  /* After the wait a part still loading is unknown ("—") and the total is what was read, marked partial. */
  const later = live({ avax: { status: "loading" }, arbitrum: { status: "loading" }, settled: true });
  assert.equal(part(later, "avax").status, "unknown");
  assert.equal(later.total.loading, false);
  assert.equal(later.total.usd, 1000);
  assert.equal(later.total.partial, true);
  assert.deepEqual(later.total.missing, ["Main Account", "Spot Account"]);
});

/* ── in flight: shown apart, never added ────────────────────────────────── */

test("a deposit on its way and a hop that left the Arbitrum wallet are listed, not added", () => {
  const v = live({
    arbitrum: arbOk(0, { waitingToMove: false, move: "moving", movingUsdc: 9.918 }),
    deposits: { onTheWay: [{ amount: 20, token: "USDC", from: "Base", to: "your Perp account", stage: "on its way" }], problems: [], unread: null },
  });
  assert.equal(v.total.usd, 1000 + 120 + 250, "nothing in flight is in the total");
  assert.deepEqual(v.inFlight.map((r) => r.kind), ["deposit", "hop"]);
  assert.equal(v.inFlight[0].amountText, "20 USDC");
  assert.equal(v.inFlight[0].stage, "On its way");
  assert.equal(v.inFlight[0].to, "your balance");
  assert.equal(v.inFlight[1].stage, "Moving");
  assert.equal(v.inFlight[1].title, "Joining your balance");
  assert.equal(v.inFlight[1].amountText, "9.92 USDC", "USDC to the cent");
  assert.equal(v.inFlight.some((r) => /perp|arbitrum/i.test(`${r.title} ${r.to}`)), false, "no chain the customer needn't know");
});

test("money still IN the Arbitrum wallet while its move starts is counted once (in the Main Account), not in flight", () => {
  const v = live({ arbitrum: arbOk(9.918, { waitingToMove: true, move: "moving", movingUsdc: 9.918 }) });
  assert.equal(part(v, "perp").usd, 1009.918);
  assert.equal(v.inFlight.length, 0);
  assert.equal(v.total.usd, 1379.92);
});

test("an Avax flow that may have moved says so in print (never a second send)", () => {
  const rows = inFlightRows({
    flows: [
      { id: "aaaaaa", kind: "swap", state: "unknown", amounts: { fromAmount: "0.5", from: "AVAX" } },
      { id: "bbbbbb", kind: "stake", state: "arriving", amounts: { usdc: "50" } },
      { id: "cccccc", kind: "stake", state: "done", amounts: { usdc: "50" } },
      { id: "dddddd", kind: "stake", state: "review" },
    ],
  });
  assert.equal(rows.length, 2, "settled and review records are not in flight");
  assert.equal(rows[0].stage, "Not confirmed. Don't send it again.");
  assert.equal(rows[0].tone, "warn");
  assert.equal(rows[0].amountText, "0.5 AVAX");
  assert.equal(rows[1].title, "Staking USDC");
  assert.equal(rows[0].title, "Swap");
  assert.equal(rows[1].amountText, "50 USDC");
});

test("a refunded deposit is listed with a warning tone", () => {
  const rows = inFlightRows({ deposits: { onTheWay: [], problems: [{ amount: 3, token: "USDC", from: "Polygon", stage: "sent back to where it came from" }] } });
  assert.equal(rows[0].kind, "problem");
  assert.equal(rows[0].stage, "Sent back");
  assert.equal(rows[0].tone, "warn");
});

/* ── mock and signed out ────────────────────────────────────────────────── */

test("a mock account: the Main Account only; Spot Account and USDC Staked are off (not partial, not counted)", () => {
  const v = portfolioView({
    signedIn: true, mock: true, settled: true, perp: perpOk(1000),
    avax: { status: "off", why: "Live only" }, arbitrum: { status: "off", why: "Live only" },
    deposits: null, apyPct: 5.7,
  });
  assert.equal(v.total.usd, 1000);
  assert.equal(v.total.partial, false);
  assert.deepEqual(v.shown.map((p) => p.key), ["perp"]);
  assert.equal(v.aave.status, "off");
  assert.equal(v.parts.length, 2);
  assert.equal(part(v, "avax").status, "off");
  assert.equal(v.inFlight.length, 0);
  assert.equal(v.apyPct, 5.7, "the live APY is still there to show");
});

test("signed out: no total, no parts", () => {
  const v = portfolioView({ signedIn: false });
  assert.equal(v.state, "signed-out");
  assert.equal(v.total, null);
  assert.equal(portfolioView({ signedIn: false, pending: true }).state, "pending");
});

/* ── words ──────────────────────────────────────────────────────────────── */

test("money words: cents under one are '<$0.01', unknown is '—', negatives use the minus sign", () => {
  assert.equal(usdText(0.004), "<$0.01");
  assert.equal(usdText(0), "$0.00");
  assert.equal(usdText(null), "—");
  assert.equal(usdText(NaN), "—");
  assert.equal(usdText(-3.5), "−$3.50");
  assert.equal(usdText(1234567.891), "$1,234,567.89");
  assert.equal(pctText(5.7002), "5.70%");
  assert.equal(pctText(null), "—");
});

test("every preview state draws (DEV only fixtures stay valid)", () => {
  for (const k of ["full", "partial", "empty", "loading", "flight"]) {
    const v = portfolioView(previewInputs(k, { signedIn: true, perp: perpOk(1000), mock: true }));
    assert.equal(v.state, "ready", k);
  }
});


/* ── the audit's findings (2026-10-15 two-account audit) ────────────────── */

test("the Main Account unread: its hop USDC is not counted on its own, and the total is never $0.00", () => {
  const unread = { balanceUsdc: null, neverFunded: false };
  const v = live({ perp: unread, arbitrum: arbOk(9.918), avax: { status: "failed" } });
  assert.equal(part(v, "perp").status, "unknown");
  assert.equal(v.total.usd, null);
  assert.equal(v.total.text, "—", "nothing read: a dash, not $0.00");
  assert.deepEqual(v.total.missing, ["Main Account", "Spot Account"]);
  const spotOnly = live({ perp: unread, arbitrum: arbOk(9.918) });
  assert.equal(spotOnly.total.usd, 370, "the Spot Account alone; the hop's 9.918 belongs to the unread Main Account");
  assert.equal(spotOnly.total.partial, true);
});

test("the Main card's stats add up to its figure: Available + In positions (equity the positions hold) + Arriving + Idle", () => {
  const v = live({ perp: perpOk(997.73, { availableUsdc: 971.03, inPositionsUsdc: 29.23, inSpotUsdc: 2 }), arbitrum: arbOk(9.918) });
  const m = part(v, "perp");
  assert.equal(m.inPositionsUsd, 26.7, "margin 29.23 with −2.53 unrealised P&L");
  assert.equal(m.marginUsd, 29.23);
  assert.equal(Math.round((m.freeUsd + m.inPositionsUsd + m.arrivingUsd + m.idleUsd) * 100) / 100, Math.round(m.usd * 100) / 100);
  assert.equal(m.arrivingLabel, "Arriving");
  const small = live({ arbitrum: arbOk(2) });
  assert.equal(part(small, "perp").arrivingLabel, "Waiting", "under the floor it waits");
});

test("customerWords: the Wallet's borrowed sentences say your balance, keep their meaning, leave networks the customer acts on", () => {
  assert.equal(customerWords("Credited as USDC in your Perp wallet."), "Credited as USDC in your balance.");
  assert.equal(customerWords("Moving 9.92 USDC into your Perp account…"), "Moving 9.92 USDC into your balance…");
  assert.equal(customerWords("Move it into your Perp account"), "Move it into your balance");
  assert.equal(customerWords("Check your Perp balance before trying again: it was NOT sent twice."), "Check your balance before trying again: it was NOT sent twice.");
  assert.equal(customerWords("Part of your Perp balance couldn't be read just now."), "Part of your balance couldn't be read just now.");
  assert.equal(customerWords("9.92 USDC is in your own wallet on Arbitrum."), "9.92 USDC is ready to join your balance.");
  assert.equal(customerWords("12.5 USDC in Spot, not used for perps."), "12.5 USDC here is not in use for trading yet.");
  const gas = "Moving it needs a little Arbitrum gas there, and there is none yet.";
  assert.equal(customerWords(gas), gas, "a network the customer must act on stays named");
  const warn = "Send only USDC on Base. Other tokens or networks can be lost.";
  assert.equal(customerWords(warn), warn, "money warnings pass through");
  assert.equal(customerWords(null), null);
  assert.equal(customerWords(""), "");
});


/* ── the balance as one list of holdings (owner: "BTCb ถ้ากดซื้อเข้า ไปบน Balance เลย … อยู่ด้วยกันไปเลย") ── */

test("holdings: one row per asset, USDC merged across accounts, staked next, coins by value; the rows add up to the balance", () => {
  const v = live({ arbitrum: arbOk(9.918), avax: { status: "ok", account: account({ usdc: 100, avax: 2, btcb: 0.001, aave: 250 }) } });
  const rows = holdingsRows(v);
  assert.deepEqual(rows.map((r) => r.symbol), ["USDC", "USDC Staked AAVE", "BTC.b", "AVAX"]);
  assert.equal(rows[0].usd, 1109.92, "Main Account money (with the hop) + Spot USDC, one row, to the cent");
  assert.equal(rows[0].amountText, "1,109.92 USDC");
  assert.equal(rows[0].sub, "$970.77 available to trade");
  assert.equal(rows[1].amountText, "250 USDC");
  assert.equal(rows[2].usd, 80);
  const sum = Math.round(rows.reduce((a, r) => a + r.usd, 0) * 100) / 100;
  assert.equal(sum, v.total.usd, "the printed rows add up to the printed balance");
  assert.equal(rows.some((r) => /main account|spot account|perp|arbitrum|hyperliquid/i.test(`${r.symbol} ${r.name} ${r.sub || ""}`)), false, "no account or venue names");
});

test("holdings: an unread Main Account leaves USDC partial (never 0); a mock lists USDC alone; signed out lists nothing", () => {
  const v = live({ perp: { balanceUsdc: null, neverFunded: false } });
  const usdc = holdingsRows(v)[0];
  assert.equal(usdc.status, "partial");
  assert.equal(usdc.usd, 100, "only the Spot USDC that was read");
  const goneRows = holdingsRows(live({ perp: { balanceUsdc: null, neverFunded: false }, avax: { status: "failed" } }));
  const gone = goneRows[0];
  assert.equal(gone.status, "unknown");
  assert.equal(gone.usdText, "—");
  assert.equal(goneRows[goneRows.length - 1].key, "coins-unread", "unread coins are a row of their own, never a complete-looking list");
  const spotFailed = holdingsRows(live({ avax: { status: "failed" } }));
  assert.equal(spotFailed[0].status, "partial", "USDC is partial while the Spot Account is unread");
  assert.equal(spotFailed[spotFailed.length - 1].usdText, "—");
  const mock = portfolioView({ signedIn: true, mock: true, settled: true, perp: perpOk(1000), avax: { status: "off" }, arbitrum: { status: "off" } });
  assert.deepEqual(holdingsRows(mock).map((r) => r.symbol), ["USDC"]);
  assert.deepEqual(holdingsRows(portfolioView({ signedIn: false })), []);
});

/* ── read only ──────────────────────────────────────────────────────────── */

test("the portfolio files sign nothing, send nothing and write no storage", () => {
  const files = ["src/wallet/portfolio.js", "src/hooks/usePortfolio.js", "src/wallet/portfolioPreview.js", "src/wallet/words.js"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    assert.doesNotMatch(src, /sendTransaction|signTypedData|eth_sendRawTransaction|\.run\(|\.check\(|setItem|removeItem|loadFlows|createFlowRegistry/, f);
  }
  const hook = fs.readFileSync(path.join(ROOT, "src/hooks/usePortfolio.js"), "utf8");
  assert.match(hook, /import\.meta\.env\.DEV \? previewKind\(\) : null/, "the preview is DEV only");
});
