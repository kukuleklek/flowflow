/**
 * test-agent-funds — where the customer's money is (src/agent/funds.js) and the Agent's get_funds tool.
 *
 * Owner, 2026-10-15: "agent ต้องรู้ว่าเงินเขาอยู่ที่ไหน เงินติดอยู่ที่ไหนบ้าง". The case behind it: a trade card could
 * not be confirmed because the Perp balance was 0 while 9.918 USDC sat in the customer's own wallet on Arbitrum
 * waiting for the first deposit's last hop. Every reader is a fake: no chain, no deposit service, no network.
 *
 * Run: node --test scripts/test-agent-funds.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFunds, depositsFrom, perpFunds, marginShortfall } from "../src/agent/funds.js";
import { READ_TOOLS, TOOLS, isReadTool } from "../src/agent/tools.js";
import { runReadTool, proposeAction } from "../src/agent/runTool.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { respondLocally } from "../src/agent/respond.js";
import { parseShortcut } from "../src/agent/shortcuts.js";
import { parsePerpMarkets } from "../src/lib/hyperliquid/markets.js";
import { quoteOpenLive, quoteAddLive } from "../src/perp/live/perpBackend.js";
import { FIRST_HOP_PLAN_ID } from "../src/lib/relay/firstDeposit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const DEP = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000_000;

const raw = (usdc) => BigInt(Math.round(usdc * 1e6));
const wallet = (usdc) => async () => ({ raw: raw(usdc), usdc });
const never = () => new Promise(() => {});
const noDeposits = () => ({ entries: [] });

function live({ equity = 0, available = 0, reason = null, positions = [], answered = true, idleSpot = null } = {}) {
  const byCoin = Object.fromEntries(positions.map((p) => [p.coin, p]));
  return {
    connected: true, mock: false, address: USER, feeRate: 0.00045,
    account: {
      mode: { source: "perp" },
      perpBalanceUsdc: answered
        ? { answered: true, source: "perp", equityUsdc: equity, availableUsdc: available, holdUsdc: null, idleSpotUsdc: idleSpot, reason }
        : { answered: false, source: null, equityUsdc: null, availableUsdc: null, reason: "perp-unanswered" },
      positions: answered ? { answered: true, list: positions, byCoin } : { answered: false, list: [], byCoin: {} },
      orders: { answered: true, list: [] },
      fills: { answered: true, list: [] },
    },
    quoteOpen: (a) => quoteOpenLive(a),
    quoteAdd: (a) => quoteAddLive(a),
  };
}

test("F1) 🔴 the owner's case: Perp at 0, 9.918 USDC in the customer's own wallet on Arbitrum — said exactly, and that it moves by itself", async () => {
  const f = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(9.918), readDeposits: noDeposits, now: () => NOW });
  assert.equal(f.signed_in, true);
  assert.deepEqual([f.perp.balanceUsdc, f.perp.availableUsdc, f.perp.inPositionsUsdc], [0, 0, 0]);
  assert.equal(f.perp.neverFunded, true);
  assert.equal(f.arbitrumWallet.usdc, 9.918);
  assert.equal(f.arbitrumWallet.waitingToMove, true);
  assert.equal(f.arbitrumWallet.move, "by-itself");
  /* Two accounts in the customer's words (owner, 2026-10-15): the hop's USDC is money joining the Main Account. */
  assert.match(f.summary, /9\.918 USDC is on its way into your Main Account/);
  assert.match(f.summary, /moves in by itself/);
  assert.doesNotMatch(f.summary, /Perp account|your own wallet|Arbitrum/, "no third place, no chain the customer need not act on");
  assert.equal(f.next, null, "money is already on its way: no Deposit panel to push");
  assert.doesNotThrow(() => JSON.stringify(f), "no BigInt reaches the model");
  assert.doesNotMatch(JSON.stringify(f), /relay|hyperliquid/i, "no provider and no venue named");
});

test("F2) 🔴 unknown is null, never 0: an unanswered account and an unreadable wallet say so", async () => {
  const f = await readFunds({ backend: live({ answered: false }), readArbitrum: async () => { throw new Error("rpc down"); }, readDeposits: noDeposits });
  assert.deepEqual(f.perp, { balanceUsdc: null, availableUsdc: null, inPositionsUsdc: null, openPositions: null, inSpotUsdc: null, neverFunded: false, partial: false, partialReason: null });
  assert.equal(f.arbitrumWallet.usdc, null);
  assert.equal(f.arbitrumWallet.waitingToMove, null);
  assert.match(f.summary, /hasn't loaded/);
  assert.match(f.summary, /couldn't be checked just now/);
  assert.doesNotMatch(f.summary, /\b0 USDC/, "nothing unread reads as empty");
  assert.equal(f.next, null, "an unread wallet is no reason to send the customer to deposit");
  /* A chain read that never answers does not hold the rest of the answer. */
  const slow = await readFunds({ backend: live({ equity: 12, available: 12 }), readArbitrum: never, readDeposits: noDeposits, timeoutMs: 20 });
  assert.equal(slow.perp.balanceUsdc, 12);
  assert.equal(slow.arbitrumWallet.usdc, null);
});

test("F3) under the 5 USDC floor the money waits for more; it is never called 'waiting to move'", async () => {
  const f = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(2.5), readDeposits: noDeposits });
  assert.equal(f.arbitrumWallet.waitingToMove, false);
  assert.equal(f.arbitrumWallet.belowMinimum, true);
  assert.equal(f.arbitrumWallet.minimumUsdc, 5);
  assert.match(f.summary, /2\.5 USDC is waiting to join your Main Account: it moves in once 5 USDC has arrived/);
  /* The floor is checked on base units: 4.999999 is under it, 5 is not. */
  const under = await readFunds({ backend: live(), readArbitrum: async () => ({ raw: 4999999n, usdc: 4.999999 }), readDeposits: noDeposits });
  assert.equal(under.arbitrumWallet.waitingToMove, false);
  const at = await readFunds({ backend: live(), readArbitrum: async () => ({ raw: 5000000n, usdc: 5 }), readDeposits: noDeposits });
  assert.equal(at.arbitrumWallet.waitingToMove, true);
});

test("F4) where the move stands, from the last hop's runner: moving, needs a press, no gas, refused, just sent", async () => {
  const at = (step, extra = {}) => readFunds({
    backend: live(), readArbitrum: wallet(9.918), readDeposits: noDeposits, now: () => NOW,
    readMove: async () => ({ step, code: null, usdc: 9.918, at: NOW - 1000, ...extra }),
  });
  assert.equal((await at("sending")).arbitrumWallet.move, "moving");
  assert.match((await at("sending")).summary, /moving into your Main Account now/);
  const press = await at("again");
  assert.equal(press.arbitrumWallet.move, "needs-press");
  assert.equal(press.next, "open_deposit");
  assert.match(press.summary, /Deposit panel has a button/);
  const gas = await at("failed", { code: "no-gas" });
  assert.equal(gas.arbitrumWallet.move, "needs-gas");
  assert.match(gas.summary, /needs a little Arbitrum gas/, "the network is named where the customer must act on it");
  assert.equal((await at("failed", { code: "send-failed" })).arbitrumWallet.move, "failed");
  /* Sent a moment ago and the wallet already reads empty: on its way, said once. */
  const sent = await readFunds({
    backend: live(), readArbitrum: wallet(0), readDeposits: noDeposits, now: () => NOW,
    readMove: async () => ({ step: "sent", usdc: 9.918, at: NOW - 30_000 }),
  });
  assert.equal(sent.arbitrumWallet.justMovedUsdc, 9.918);
  assert.match(sent.summary, /9\.918 USDC was just moved into your Main Account/);
  assert.equal(sent.next, null);
  /* ...but an old "sent" is history, not money on its way. */
  const old = await readFunds({
    backend: live(), readArbitrum: wallet(0), readDeposits: noDeposits, now: () => NOW,
    readMove: async () => ({ step: "sent", usdc: 9.918, at: NOW - 60 * 60_000 }),
  });
  assert.equal(old.arbitrumWallet.justMovedUsdc, null);
});

function watchState() {
  return {
    entries: [
      {
        address: DEP, user: USER, routeId: "base-usdc", planId: FIRST_HOP_PLAN_ID, watching: true,
        requests: [
          { id: "a", status: "arriving", amountIn: 25, symbolIn: "USDC", inChainId: 8453, createdAt: NOW - 60_000 },
          { id: "b", status: "arriving", amountIn: 10, symbolIn: "USDT", inChainId: 42161, createdAt: NOW - 5 * 3600_000 },
          { id: "c", status: "credited", amountIn: 30, symbolIn: "USDC", inChainId: 8453, createdAt: NOW - 3600_000 },
          { id: "d", status: "refunded", amountIn: 7, symbolIn: "USDC", inChainId: 8453, createdAt: NOW - 3600_000 },
        ],
        movingNow: [true, false, false, false],
      },
      {
        address: "0x4444444444444444444444444444444444444444", user: OTHER, routeId: "base-usdc", planId: null, watching: true,
        requests: [{ id: "x", status: "arriving", amountIn: 999, symbolIn: "USDC", inChainId: 8453, createdAt: NOW }],
        movingNow: [true],
      },
    ],
  };
}

test("F5) deposits on their way come from the deposit watch, for THIS wallet only, in plain words", async () => {
  const { onTheWay, problems } = depositsFrom(watchState(), USER.toUpperCase().replace("0X", "0x"), NOW);
  assert.deepEqual(onTheWay, [
    { amount: 25, token: "USDC", from: "Base", to: "your Main Account", stage: "on its way" },
    { amount: 10, token: "USDT", from: "Arbitrum", to: "your Main Account", stage: "taking longer than usual" },
  ]);
  assert.deepEqual(problems, [{ amount: 7, token: "USDC", from: "Base", stage: "sent back to where it came from" }]);
  assert.ok(!JSON.stringify(onTheWay).includes("999"), "another wallet's deposit is never this one's");
  const f = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(0), readDeposits: watchState, now: () => NOW });
  assert.equal(f.depositsOnTheWay.length, 2);
  assert.match(f.summary, /25 USDC from Base is on its way to your Main Account\./);
  assert.match(f.summary, /7 USDC from Base was sent back to where it came from\./);
  assert.equal(f.next, null, "money is coming: no push to deposit again");
  assert.doesNotMatch(JSON.stringify(f), /relay|hyperliquid/i);
  /* A watch that throws is an empty list, not a dead tool. */
  const broken = await readFunds({ backend: live(), readArbitrum: wallet(0), readDeposits: () => { throw new Error("x"); } });
  assert.deepEqual(broken.depositsOnTheWay, []);
});

test("F6) nothing anywhere: Perp at 0, wallet empty, nothing coming → offer the Deposit panel", async () => {
  const f = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(0), readDeposits: noDeposits });
  assert.equal(f.next, "open_deposit");
  assert.match(f.summary, /Main Account has no money yet|Main Account is at 0 USDC/);
  assert.match(f.summary, /deposit is the way to start/);
});

test("F7) a funded account: balance, free, in positions, and USDC parked in Spot all said apart", async () => {
  const pos = { coin: "ETH", szi: 0.05, marginUsed: 20.004 };
  const f = await readFunds({ backend: live({ equity: 120.5, available: 100.25, positions: [pos], idleSpot: 3 }), readArbitrum: wallet(0), readDeposits: noDeposits });
  assert.deepEqual([f.perp.balanceUsdc, f.perp.availableUsdc, f.perp.inPositionsUsdc, f.perp.openPositions, f.perp.inSpotUsdc], [120.5, 100.25, 20, 1, 3]);
  assert.match(f.summary, /Your Main Account holds 120\.5 USDC \(100\.25 USDC free, 20 USDC in open positions\)\./);
  assert.match(f.summary, /3 USDC in your Main Account is set aside and not used for trading/);
  assert.doesNotMatch(f.summary, /in Spot\b/, "'Spot' is the Spot Account now: never for money inside the Main Account");
  assert.equal(f.next, null);
  /* A position whose margin is not read makes the sum unknown, not smaller. */
  assert.equal(perpFunds(live({ equity: 50, available: 30, positions: [{ coin: "BTC", szi: 1, marginUsed: null }] })).inPositionsUsdc, null);
});

test("F8) mock build: the mock account only — no chain read, no deposit watch", async () => {
  let reads = 0;
  const mock = { connected: true, mock: true, address: null, account: { perpBalanceUsdc: { answered: true, source: "mock", equityUsdc: 1000, availableUsdc: 900 }, positions: { answered: true, list: [] } } };
  const f = await readFunds({ backend: mock, readArbitrum: async () => { reads++; return { raw: 1n, usdc: 0.000001 }; }, readDeposits: () => { reads++; return watchState(); } });
  assert.equal(reads, 0);
  assert.equal(f.mock, true);
  assert.equal(f.arbitrumWallet, null);
  assert.deepEqual(f.depositsOnTheWay, []);
  assert.equal(f.perp.balanceUsdc, 1000);
  assert.match(f.summary, /^Mock account \(mock money\)\./);
});

test("F9) signed out: says so, reads nothing", async () => {
  let reads = 0;
  const f = await readFunds({ backend: { connected: false }, readArbitrum: async () => { reads++; return null; }, readDeposits: () => { reads++; return null; } });
  assert.equal(f.signed_in, false);
  assert.equal(reads, 0);
  assert.match(f.summary, /Sign in/);
});

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hl-meta-and-asset-ctxs.json"), "utf8"));
const parsed = parsePerpMarkets(fixture.response, { now: 1 });
const snapshot = { markets: parsed.markets, byCoin: parsed.byCoin };

test("F10) get_funds is a READ tool with a schema the model sees, and runs through runReadTool with injected readers", async () => {
  assert.ok(READ_TOOLS.includes("get_funds"));
  assert.equal(isReadTool("get_funds"), true);
  const t = TOOLS.find((x) => x.function.name === "get_funds");
  assert.ok(t, "the model is told about it");
  assert.match(t.function.description, /Main Account/);
  assert.doesNotMatch(t.function.description, /Perp account|Arbitrum|Avax Wallet/, "the model is told the customer's names only");
  const r = await runReadTool("get_funds", {}, { snapshot, backend: live({ reason: "new-account" }), funds: { readArbitrum: wallet(9.918), readDeposits: noDeposits } });
  assert.equal(r.arbitrumWallet.usdc, 9.918);
  assert.match(r.summary, /9\.918 USDC/);
});

test("F11) a trade bigger than the Perp balance is flagged: the quote and the card both send the model to get_funds", async () => {
  const b = live({ reason: "new-account" });
  const q = await runReadTool("quote_trade", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 }, { snapshot, backend: b });
  assert.equal(q.perp_balance_usdc, 0);
  assert.match(q.funds_note, /get_funds/);
  const p = proposeAction("propose_open", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 }, { snapshot, backend: b });
  assert.equal(p.ok, true, "the card still shows: the customer sees what they asked for");
  assert.equal(p.fundsShort, true);
  assert.match(p.note, /cannot confirm the card yet/);
  /* A funded account is not flagged. */
  const rich = live({ equity: 100, available: 100 });
  assert.equal((await runReadTool("quote_trade", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 }, { snapshot, backend: rich })).funds_note, undefined);
  assert.equal(proposeAction("propose_open", { coin: "ETH", side: "long", margin_usdc: 10, leverage: 3 }, { snapshot, backend: rich }).fundsShort, undefined);
});

test("F12) the system prompt tells the model when to call get_funds and never to invent a figure", () => {
  const p = systemPrompt();
  assert.match(p, /call get_funds when the user asks about their money/);
  assert.match(p, /lack of funds/);
  assert.match(p, /USDC on its way into the Main Account\s+moves in by itself/);
  assert.match(p, /Never invent or estimate a figure/);
});

test("F13) a shortcut card bigger than the Perp balance says why under the card; a question about money goes to the model", () => {
  const r = respondLocally("long ETH 20 5x", { markets: snapshot.markets, byCoin: snapshot.byCoin, backend: live({ reason: "new-account" }) });
  assert.equal(r.handled, true);
  assert.deepEqual(r.messages.map((m) => m.role), ["status", "assistant", "card", "assistant"]);
  assert.match(r.messages[3].text, /Your Main Account has 0 USDC, less than this 20 USDC margin/);
  assert.match(r.messages[3].text, /I'll check your Main Account and any deposit on its way/);
  assert.match(r.messages[3].text, /where is my money/);
  const rich = respondLocally("long ETH 20 5x", { markets: snapshot.markets, byCoin: snapshot.byCoin, backend: live({ equity: 100, available: 100 }) });
  assert.deepEqual(rich.messages.map((m) => m.role), ["status", "assistant", "card"]);
  const unread = respondLocally("long ETH 20 5x", { markets: snapshot.markets, byCoin: snapshot.byCoin, backend: live({ answered: false }) });
  assert.equal(unread.messages.length, 3, "an unread balance claims nothing");
  for (const q of ["where is my money", "เงินฉันอยู่ไหน", "ยอดเงินเท่าไหร่", "my deposit hasn't arrived"]) assert.equal(parseShortcut(q, ["ETH", "BTC"]), null, q);
});

test("F14) what the card can use is the FREE amount less the fee: money in positions, and the whole balance, are both said", async () => {
  const btc = { coin: "BTC", side: "long", szi: 0.001, marginUsed: 28, leverage: { type: "isolated", value: 5 } };
  /* 30 held, 2 free (28 back a BTC long): a 20 USDC card cannot go. */
  const inPos = live({ equity: 30, available: 2, positions: [btc] });
  const r = respondLocally("long ETH 20 5x", { markets: snapshot.markets, byCoin: snapshot.byCoin, backend: inPos });
  assert.match(r.messages[3].text, /has 30 USDC, but only 2 USDC of it is free to use/);
  const q = await runReadTool("quote_trade", { coin: "ETH", side: "long", margin_usdc: 20, leverage: 5 }, { snapshot, backend: inPos });
  assert.equal(q.perp_balance_usdc, 30);
  assert.equal(q.free_usdc, 2);
  assert.match(q.funds_note, /backs open positions/);
  /* The whole balance as margin (under FlowFlow's 20 USDC cap): the fee does not fit, as on the card. */
  const whole = live({ equity: 15, available: 15 });
  const p = proposeAction("propose_open", { coin: "ETH", side: "long", margin_usdc: 15, leverage: 5 }, { snapshot, backend: whole });
  assert.equal(p.fundsShort, true);
  const s = respondLocally("long ETH 15 5x", { markets: snapshot.markets, byCoin: snapshot.byCoin, backend: whole });
  assert.match(s.messages[3].text, /15 USDC free, and this 15 USDC margin plus its fee is more than that/);
  /* Just under the fee line it fits; an unread balance claims nothing. */
  assert.equal(marginShortfall(whole, { marginUsdc: 14.9, leverage: 5, feeRate: 0.00045, coin: "ETH" }), null);
  assert.equal(marginShortfall(live({ answered: false }), { marginUsdc: 5, leverage: 5, feeRate: 0.00045, coin: "ETH" }), null);
  /* A venue market draws on its own pot too, which the account does not show: only the balance is held against it. */
  assert.equal(marginShortfall(inPos, { marginUsdc: 20, leverage: 5, feeRate: 0.00045, coin: "xyz:TSLA" }), null);
});

test("F15) a deposit watch still looking, or failed, is said as such and never sends the customer to deposit again", async () => {
  const entry = (state, user = USER) => () => ({ entries: [{ address: DEP, user, routeId: "base-usdc", planId: FIRST_HOP_PLAN_ID, watching: true, state, error: null, requests: [], movingNow: [] }] });
  const loading = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(0), readDeposits: entry("loading"), now: () => NOW });
  assert.equal(loading.depositsUnread, "loading");
  assert.match(loading.summary, /still being checked/);
  const failed = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(0), readDeposits: entry("error"), now: () => NOW });
  assert.match(failed.summary, /couldn't be checked just now/);
  assert.equal(failed.next, null);
  /* Another wallet's watch says nothing about this one. */
  const other = await readFunds({ backend: live({ reason: "new-account" }), readArbitrum: wallet(0), readDeposits: entry("loading", OTHER), now: () => NOW });
  assert.equal(other.depositsUnread, null);
  assert.equal(other.next, "open_deposit");
});
