/**
 * test-perp-first-deposit — A FIRST DEPOSIT THAT NEVER PAYS THE ONE-TIME COST.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-09-27: "ทำเลยยยยยยยยยยยย เอาทุกเชน ให้มัน ครั้งแรก เกือบ noo fee" — do
 * it, every chain, make the first one almost no fee; and, earlier, "ไม่อยากมี
 * relayer" — no server of ours in the path.
 *
 * WHAT THIS PINS
 *
 *   Q. the quote: destination, recipient, refundTo, the gas top-up and its
 *      scale, and every refusal that sends the screen back to the direct plan;
 *   M. the floor: computed from the quote's own GUARANTEED minimum, never the
 *      expected amount, and rounded up to a whole token;
 *   P. which plan a wallet gets, and the fall-back when the cheap one refuses;
 *   C. the two plans keep their own caches, so neither can hand back the other's
 *      address;
 *   B. the last hop: the sender is the customer, the destination is the deposit
 *      contract, the amount is the chain's, and nothing under the floor is ever
 *      sent. Every address is written out here in full.
 *   R. the resume machine: never two signatures for one landing, and (owner,
 *      2026-10-15) money that is there moves by itself, watched or not;
 *   W. the words, and no provider or venue in any of them;
 *   H. the hook, on the tab's one runner (perp/deposit/perpFunding.js): money
 *      at or over the floor moves by itself ONCE on every plan, an unresolved
 *      attempt is a button, and a failure leaves the money in the customer's
 *      own wallet (the runner's own tests: scripts/test-perp-funding.mjs);
 *   X. the bridge's closed builder: the one transaction Privy may be asked to
 *      send with no window;
 *   G. source guards.
 *
 * Every figure called "measured" was read from a live quote or from the chain on
 * 2026-09-27. Nothing here signs, sends or spends: the one live answer is frozen
 * into LIVE_QUOTE below, and every other input is made up on purpose.
 *
 * Run: node --test scripts/test-perp-first-deposit.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/stripComments.mjs";
import { autoStubs, bundle } from "./lib/perpLiveHarness.mjs";

import * as F from "../src/lib/relay/firstDeposit.js";
import * as A from "../src/lib/relay/arbitrumBridge.js";
import * as D from "../src/lib/relay/depositAddress.js";
import * as MV from "../src/perp/deposit/firstDepositMove.js";
import * as V from "../src/perp/deposit/perpDepositView.js";
import { routeById, PERP_DEPOSIT_ROUTES } from "../src/lib/relay/routes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) => stripComments(read(rel));

/* 🔴 THE ADDRESSES, WRITTEN DOWN. If any one of these changes, money goes
   somewhere else, so they are spelled out here and compared with the code.
     USDC   native USDC on Arbitrum (not the bridged one)
     BRIDGE the venue's own deposit contract: a transfer to it credits the SENDER
   Both were read on chain on 2026-09-27: the deposit contract held over
   563,430,000 USDC, which is not an address anybody typed by accident. */
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BRIDGE = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";
const ARB = 42161;

/* The wallet the live quote below was made for, and one that is not it. */
const USER = "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e";
const OTHER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const DEP = "0xd8236f7217cef2aa2e1627eded1ae59de850e341";
const HASH = `0x${"ab".repeat(32)}`;

/* ════════════════════════════════════════════════════════════════════════════
   ONE LIVE ANSWER, frozen. POST https://api.relay.link/quote/v2, 2026-09-27:
   20 USDC on Base to USDC on Arbitrum for a fresh random address, with
   useDepositAddress and topupGasAmount 50000. Trimmed of logo and metadata
   blocks only; every figure and address is as it came back.
   ════════════════════════════════════════════════════════════════════════════ */
const LIVE_QUOTE = {
  "requestId": "0x1790523416841f843189d50fb78e7aaece6cc9262213d8c24d61041676b721cd",
  "steps": [
    {
      "id": "deposit",
      "kind": "transaction",
      "depositAddress": "0xd8236f7217cef2aa2e1627eded1ae59de850e341",
      "items": [
        {
          "data": {
            "from": "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e",
            "to": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            "data": "0xa9059cbb000000000000000000000000d8236f7217cef2aa2e1627eded1ae59de850e3410000000000000000000000000000000000000000000000000000000001312d00",
            "value": "0",
            "chainId": 8453
          }
        }
      ]
    }
  ],
  "fees": {
    "relayer": {
      "currency": {
        "chainId": 8453,
        "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "symbol": "USDC",
        "name": "USD Coin",
        "decimals": 6
      },
      "amount": "127843",
      "amountFormatted": "0.127843",
      "amountUsd": "0.127830",
      "minimumAmount": "127843"
    },
    "relayerGas": {
      "currency": {
        "chainId": 8453,
        "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "symbol": "USDC",
        "name": "USD Coin",
        "decimals": 6
      },
      "amount": "105841",
      "amountFormatted": "0.105841",
      "amountUsd": "0.105830",
      "minimumAmount": "105841"
    }
  },
  "details": {
    "operation": "swap",
    "sender": "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e",
    "recipient": "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e",
    "currencyIn": {
      "currency": {
        "chainId": 8453,
        "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "symbol": "USDC",
        "name": "USD Coin",
        "decimals": 6
      },
      "amount": "20000000",
      "amountFormatted": "20.0",
      "amountUsd": "19.998000",
      "minimumAmount": "20000000"
    },
    "currencyOut": {
      "currency": {
        "chainId": 42161,
        "address": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        "symbol": "USDC",
        "name": "USD Coin",
        "decimals": 6
      },
      "amount": "19872157",
      "amountFormatted": "19.872157",
      "amountUsd": "19.870170",
      "minimumAmount": "19474714"
    },
    "currencyGasTopup": {
      "currency": {
        "chainId": 42161,
        "address": "0x0000000000000000000000000000000000000000",
        "symbol": "ETH",
        "name": "Ether",
        "decimals": 18
      },
      "amount": "18610381373657",
      "amountFormatted": "0.000018610381373657",
      "amountUsd": "0.050000",
      "minimumAmount": "18610381373657"
    },
    "slippageTolerance": {
      "destination": {
        "percent": "1.99"
      }
    },
    "timeEstimate": 1
  },
  "protocol": {
    "v2": {
      "orderData": {
        "inputs": [
          {
            "payment": {
              "chainId": "base",
              "currency": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              "amount": "20000000",
              "weight": "1"
            },
            "refunds": [
              {
                "chainId": "base",
                "recipient": "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e",
                "currency": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                "minimumAmount": "0",
                "deadline": 1806075417
              },
              {
                "chainId": "arbitrum",
                "recipient": "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e",
                "currency": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
                "minimumAmount": "0",
                "deadline": 1806075417
              }
            ]
          }
        ],
        "output": {
          "chainId": "arbitrum",
          "payments": [
            {
              "recipient": "0x75718fc2d86c7ffff7f515a5afccdd6c3fafb78e",
              "currency": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
              "minimumAmount": "19474714",
              "expectedAmount": "19872157"
            }
          ],
          "calls": [],
          "deadline": 1806075417
        }
      }
    }
  }
};

const clone = () => JSON.parse(JSON.stringify(LIVE_QUOTE));
const parse = (j, over = {}) => F.parseFirstDepositQuote(j, { user: USER, route: routeById("base-usdc"), now: 1759000000000, ...over });

/* A Relay answer, as fetch gives it. */
const answer = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
/* Enough of a live /chains list for one route and the direct destination. */
const MIN_CHAINS = [
  { id: 1337, depositEnabled: true, disabled: false, vmType: "hypevm", solverCurrencies: [{ address: "0x00000000000000000000000000000000", symbol: "USDC", decimals: 8 }] },
  { id: 8453, depositEnabled: true, disabled: false, vmType: "evm", solverCurrencies: [{ address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 }] },
];
const fakeStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()], map: m };
};
const NO_TIMERS = { setTimeout: () => 1, clearTimeout: () => {} };
/** One Relay, answering the quotes given in order. */
function relayFake(quotes) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/chains")) return answer({ chains: MIN_CHAINS });
    const body = JSON.parse(init.body);
    posts.push(body);
    const next = quotes.shift();
    if (next === undefined) throw new Error("relayFake: a quote was asked for that this test did not expect");
    return typeof next === "function" ? next(body) : next;
  };
  return { fetchImpl, posts };
}
const askFor = (over = {}) => ({
  user: USER, connected: USER, route: routeById("base-usdc"),
  storage: fakeStore(), memory: new Map(), chainsMemo: D.newRelayChainsMemo(),
  network: "mainnet", timers: NO_TIMERS, now: () => 1759000000000, ...over,
});

/* ════════════════════════════════════════════════════════════════════════════
   Q. THE QUOTE
   ════════════════════════════════════════════════════════════════════════════ */

test("Q1) the body: one deposit address, quoted to the customer's OWN address on Arbitrum in USDC, with gas beside it", () => {
  assert.deepEqual(F.buildFirstDepositQuoteBody({ user: USER, route: routeById("base-usdc") }), {
    user: USER, recipient: USER, refundTo: USER,
    originChainId: 8453, originCurrency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    destinationChainId: ARB, destinationCurrency: USDC,
    amount: "20000000", tradeType: "EXACT_INPUT", useDepositAddress: true,
    topupGas: true, topupGasAmount: "50000",
  });
  /* recipient and refundTo are the customer in every row, and BNB's 18 decimals
     are priced as 18 decimals (a row this table gained the same day). */
  for (const r of PERP_DEPOSIT_ROUTES) {
    const b = F.buildFirstDepositQuoteBody({ user: USER, route: r });
    assert.equal(b.recipient, USER, r.id);
    assert.equal(b.refundTo, USER, r.id);
    assert.equal(b.destinationChainId, ARB, r.id);
    assert.equal(b.destinationCurrency, USDC, r.id);
    assert.equal(b.amount, r.decimals === 18 ? "20000000000000000000" : "20000000", r.id);
  }
});

test("Q1b) 🔴 the gas top-up scale is a MILLIONTH of a dollar, which is not what the reference says", () => {
  /* Measured ladder on this route, reading details.currencyGasTopup.amountUsd
     (2026-09-27): 1000 -> $0.001, 30000 -> $0.030, 100000 -> $0.100,
     1000000 -> $1.000. The published example says 100000 = $1, which is ten
     times out; and asking for gas with NO amount takes the documented $2.00
     default, measured at 2.066983 USDC of fee — more than the one-time cost this
     whole plan removes. So it is always sent, explicitly. */
  assert.equal(F.TOPUP_SCALE_PER_USD, 1000000);
  assert.equal(F.TOPUP_GAS_USD, 0.05);
  assert.equal(F.TOPUP_GAS_AMOUNT, "50000");
  assert.equal(typeof F.TOPUP_GAS_AMOUNT, "string");
  assert.equal(F.buildFirstDepositQuoteBody({ user: USER, route: routeById("base-usdc") }).topupGas, true);
});

test("Q2) 🔴 the live answer verifies, and every figure the screen reads comes out of it", () => {
  const q = parse(clone());
  assert.equal(q.depositAddress, DEP);
  assert.equal(q.feeEstimateUsdc, 0.127843, "20 in, 19.872157 out: the whole cost, gas top-up included");
  assert.equal(q.minInputUsdc, 6);
  assert.equal(q.topupUsd, 0.05);
  /* 🔴 NO ONE-TIME COST ON THIS PLAN, and not because the gas looked small: the
     destination is the customer's own wallet on a chain they already exist on. */
  assert.equal(q.activationIncluded, false);
  assert.equal(q.activationUsdc, null);
  /* The crossing's own estimate plus the documented last hop ("credited to the
     account that sent it in less than 1 minute"). */
  assert.equal(q.timeEstimateSec, 61);
  assert.equal(F.LAST_HOP_SEC, 60);
  assert.equal(q.expiresAt, 1806075417000);
  assert.equal(q.plan, undefined, "the plan is named by the cache layer, not by the verifier");
  assert.equal(q.requestId, "0x1790523416841f843189d50fb78e7aaece6cc9262213d8c24d61041676b721cd");
});

/* 🔴 THE WHOLE CLAIM, ON THE CAPTURED ANSWER, END TO END. The owner's complaint
   was that the first deposit still said it was expensive, and half of that was
   arithmetic: the quote's difference swallows the gas top-up, which is delivered
   into the customer's own wallet and stays theirs. Every other proof of this
   lived in a one-off script against a live quote, so this is the one that runs
   again: the recorded answer through the verifier, through the view, to the
   words on the tile — and checked against the answer's OWN stated dollars on
   both legs, so the premise is pinned to Relay's arithmetic and not to a number
   typed here. */
test("Q2b) 🔴 the recorded answer's printed fee is what the deposit costs, checked against the answer's own dollars", () => {
  const j = clone();
  const q = { ...parse(j), plan: F.FIRST_HOP_PLAN_ID };
  assert.equal(q.feeEstimateUsdc, 0.127843, "the quote's own difference, top-up included");
  const net = V.depositFeeForDisplay(q, []);
  assert.equal(net, 0.077843);
  assert.equal(V.feeText(net), "≈ 0.08 USDC");
  assert.equal(V.feeText(q.feeEstimateUsdc), "≈ 0.13 USDC", "what the tile said before, 1.6x the cost");
  /* The answer states each leg in dollars too, and what the deposit really loses
     is what went in less what came out less the gas the customer keeps. */
  const d = j.details;
  const own = Number(d.currencyIn.amountUsd) - Number(d.currencyOut.amountUsd) - Number(d.currencyGasTopup.amountUsd);
  assert.equal(own.toFixed(6), "0.077830");
  assert.equal(Math.abs(net - own) < 0.0005, true, `the tile and the answer agree to well under a cent: ${net} against ${own}`);
  assert.equal(Math.abs(q.feeEstimateUsdc - own) > 0.049, true, "the un-netted figure does not");
  /* And the top-up itself is never the fee it is subtracted from. */
  assert.equal(q.topupUsd, F.TOPUP_GAS_USD);
  assert.equal(V.depositFeeForDisplay({ ...q, plan: "direct" }, []), 0.127843, "no top-up comes out of a plan that carries none");
});

test("Q3) 🔴 REFUSED: no gas, another chain's gas, a token that is not the chain's own, gas exposed to slippage, gas too small to make the hop", () => {
  const bad = [
    (j) => { delete j.details.currencyGasTopup; },
    (j) => { j.details.currencyGasTopup.currency.chainId = 8453; },
    (j) => { j.details.currencyGasTopup.currency.address = USDC; },
    (j) => { j.details.currencyGasTopup.currency.decimals = 6; },
    (j) => { j.details.currencyGasTopup.minimumAmount = "1"; },
    (j) => { j.details.currencyGasTopup.amount = null; },
    (j) => { j.details.currencyGasTopup.amountUsd = "0.024"; },
    (j) => { j.details.currencyGasTopup.amountUsd = "nope"; },
  ];
  for (const edit of bad) {
    const j = clone();
    edit(j);
    assert.throws(() => parse(j), (e) => e.code === "unsafe-quote", JSON.stringify(j.details.currencyGasTopup));
  }
  /* Half of what was asked for still buys about seven hops, so it stands. */
  const ok = clone();
  ok.details.currencyGasTopup.amountUsd = "0.025";
  assert.equal(parse(ok).topupUsd, 0.025);
});

test("Q4) 🔴 REFUSED: a destination that is not the customer's own Arbitrum USDC, and an order that pays anyone else", () => {
  const bad = [
    (j) => { j.details.currencyOut.currency.chainId = 1337; },
    (j) => { j.details.currencyOut.currency.address = "0x00000000000000000000000000000000"; },
    (j) => { j.details.currencyOut.currency.decimals = 8; },
    (j) => { j.protocol.v2.orderData.output.chainId = "hyperliquid"; },
    (j) => { j.protocol.v2.orderData.output.payments[0].recipient = OTHER; },
    (j) => { j.protocol.v2.orderData.output.payments[0].currency = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; },
    (j) => { j.protocol.v2.orderData.output.calls = [{ to: OTHER, data: "0x" }]; },
    (j) => { j.protocol.v2.orderData.inputs[0].refunds[1].recipient = OTHER; },
    (j) => { j.details.recipient = OTHER; },
    (j) => { j.steps[0].items[0].data.data = `0xa9059cbb${OTHER.slice(2).padStart(64, "0")}${"0".repeat(64)}`; },
    (j) => { j.steps[0].depositAddress = USER; },
  ];
  for (const edit of bad) {
    const j = clone();
    edit(j);
    assert.throws(() => parse(j), (e) => e.code === "unsafe-quote" || e.code === "bad-deposit-address", JSON.stringify(edit));
  }
  /* The answer for another wallet is refused for this one. */
  assert.throws(() => parse(clone(), { user: OTHER }), (e) => e.code === "unsafe-quote");
});

test("Q5) the verifier is the direct plan's own, run against another destination: one step, and the deposit address is never the wallet", () => {
  const j = clone();
  j.steps.push({ ...j.steps[0] });
  assert.throws(() => parse(j), /exactly one deposit step/);
  assert.equal(F.FIRST_HOP_DESTINATION.chainId, ARB);
  assert.equal(F.FIRST_HOP_DESTINATION.currency, USDC);
  assert.equal(F.FIRST_HOP_DESTINATION.orderChain, "arbitrum");
  assert.equal(F.FIRST_HOP_DESTINATION.carriesActivation, false);
  assert.equal(D.DIRECT_DESTINATION.carriesActivation, true, "the direct plan still reads its own one-time cost");
});

/* ════════════════════════════════════════════════════════════════════════════
   M. THE FLOOR
   ════════════════════════════════════════════════════════════════════════════ */

test("M1) 🔴 the floor is computed from the GUARANTEED minimum, not the expected amount", () => {
  /* The live Base quote: 20 in, 19.872157 expected, 19.474714 guaranteed. */
  assert.equal(F.firstDepositMinInput({ amountIn: 20, amountOut: 19.872157, minimumOut: 19.474714 }), 6);
  /* A route that allows 20% slippage and costs 0.5 to cross. Read off the
     EXPECTED amount it would answer 6 — and a 6 USDC deposit there can deliver
     4.8, which the deposit contract accepts, never credits and never returns. */
  assert.equal(F.firstDepositMinInput({ amountIn: 20, amountOut: 19.5, minimumOut: 15.6 }), 7);
  /* Ethereum L1, measured the same day: the crossing alone costs 4.967156. */
  assert.equal(F.firstDepositMinInput({ amountIn: 20, amountOut: 15.032844, minimumOut: 14.732188 }), 11);
  /* No slippage and no cost is still the contract's own 5. */
  assert.equal(F.firstDepositMinInput({ amountIn: 20, amountOut: 20, minimumOut: 20 }), 5);
  assert.equal(A.BRIDGE_MIN_USDC, 5);
});

test("M2) a figure it cannot stand behind is null, and a plan with no floor is refused rather than shown", () => {
  for (const bad of [
    {}, { amountIn: 20 }, { amountIn: 20, amountOut: 19 },
    { amountIn: 20, amountOut: 0, minimumOut: 0 },
    { amountIn: 20, amountOut: 19, minimumOut: 20 },
    { amountIn: "x", amountOut: 19, minimumOut: 18 },
    { amountIn: 20, amountOut: 19, minimumOut: 0.001 },
  ]) assert.equal(F.firstDepositMinInput(bad), null, JSON.stringify(bad));
  const j = clone();
  j.details.currencyOut.minimumAmount = null;
  assert.throws(() => parse(j), (e) => e.code === "unsafe-quote");
});

test("M3) a favourable rate is read as no cost, never as a discount on the floor", () => {
  /* USDT worth a shade over a dollar: more comes out than went in. The floor is
     then the slippage alone, and never less than the contract's own. */
  assert.equal(F.firstDepositMinInput({ amountIn: 20, amountOut: 20.1, minimumOut: 19.698 }), 6);
});

/* ════════════════════════════════════════════════════════════════════════════
   P. WHICH PLAN, AND THE FALL-BACK
   ════════════════════════════════════════════════════════════════════════════ */

test("P1) 🔴 the long way round is for a brand-new account AND a wallet that can finish it by itself", () => {
  const pick = (o) => V.depositPlanFor(o);
  assert.equal(pick({ accountNew: true, walletType: "privy" }), F.FIRST_HOP_PLAN_ID);
  assert.equal(pick({ accountNew: false, walletType: "privy" }), "direct");
  assert.equal(pick({ accountNew: null, walletType: "privy" }), null, "nobody knows yet: no address is asked for");
  /* 🔴 A WALLET THAT CANNOT SIGN THE LAST HOP MUST NEVER BE SENT DOWN IT. Its
     money would land on the landing chain and stop there. It is answered at
     once, with today's route, without waiting for the account layer. */
  for (const w of ["metamask", "walletconnect", "okx", null, undefined]) {
    assert.equal(pick({ accountNew: true, walletType: w }), "direct", String(w));
    assert.equal(pick({ accountNew: null, walletType: w }), "direct", String(w));
  }
  /* The account layer asked and got nothing back: the direct plan stands in, so
     a flaky read never leaves the screen with no address at all. */
  assert.equal(pick({ accountNew: null, walletType: "privy", accountFailed: true }), "direct");
  assert.equal(pick({}), "direct");
  assert.equal(V.walletCanFinishFirstHop("privy"), true);
  for (const w of ["metamask", "walletconnect", null, undefined, ""]) assert.equal(V.walletCanFinishFirstHop(w), false, String(w));
  assert.equal(V.planIsFirstHop(F.FIRST_HOP_PLAN_ID), true);
  assert.equal(V.planIsFirstHop("direct"), false);
  assert.equal(V.planIsFirstHop(null), false);
});

test("P2) the first-deposit plan asks for its own destination, and the answer says which plan it is", async () => {
  const r = relayFake([answer(clone())]);
  const got = await F.getDepositAddressForPlan(askFor({ planId: F.FIRST_HOP_PLAN_ID, fetchImpl: r.fetchImpl }));
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].destinationChainId, ARB);
  assert.equal(r.posts[0].topupGasAmount, "50000");
  assert.equal(got.plan, F.FIRST_HOP_PLAN_ID);
  assert.equal(got.depositAddress, DEP);
  assert.equal(got.minInputUsdc, 6);
  assert.equal(got.feeEstimateUsdc, 0.127843);
});

test("P2b) no plan, or the direct one, asks for the destination that shipped first — and no gas top-up", async () => {
  for (const planId of [null, "direct"]) {
    const r = relayFake([answer({ steps: [] })]);
    await assert.rejects(() => F.getDepositAddressForPlan(askFor({ planId, fetchImpl: r.fetchImpl })));
    assert.equal(r.posts[0].destinationChainId, 1337);
    assert.equal(r.posts[0].topupGas, undefined);
    assert.equal(r.posts[0].topupGasAmount, undefined);
  }
});

test("P3) 🔴 a refusal about the PRICE or the SHAPE falls back to today's route: a customer with no address is worse off than one who pays", async () => {
  /* Measured reason this happens: from Ethereum L1 the quote is refused outright
     below a size that moves with L1 gas — AMOUNT_TOO_LOW, then, as the amount
     rises, GAS_IMPACT_TOO_HIGH. The cheap plan is simply not available there
     right now, and today's route still works. */
  const noGas = () => { const j = clone(); delete j.details.currencyGasTopup; return j; };
  const cases = [
    [answer({ message: "Amount too low to cover swap fees and gas top up.", errorCode: "AMOUNT_TOO_LOW" }, false, 400), "priced out"],
    [answer({ message: "Gas impact is too high: -77.33%", errorCode: "GAS_IMPACT_TOO_HIGH" }, false, 400), "gas impact"],
    [answer(noGas()), "an answer that carries no gas for the last hop"],
    /* An answer whose SHAPE is wrong. (A 5xx is not this: it is a service that
       is down for a moment, and it never falls back — P3c.) */
    [answer("not json at all"), "an unreadable answer"],
  ];
  for (const [first, what] of cases) {
    const r = relayFake([first, answer({ message: "the direct one answered second" }, false, 400)]);
    await assert.rejects(
      () => F.getDepositAddressForPlan(askFor({ planId: F.FIRST_HOP_PLAN_ID, fetchImpl: r.fetchImpl })),
      /direct one answered second/,
      what,
    );
    assert.deepEqual(r.posts.map((p) => p.destinationChainId), [ARB, 1337], `${what}: the long way first, then the short way`);
  }
});

test("P3b) 🔴 a refusal the direct plan would share is passed straight through, and asks nothing twice", async () => {
  /* Not connected: the direct plan refuses in the same words, so asking again
     would only cost the customer another second. */
  const r = relayFake([]);
  await assert.rejects(
    () => F.getDepositAddressForPlan(askFor({ planId: F.FIRST_HOP_PLAN_ID, connected: OTHER, fetchImpl: r.fetchImpl })),
    (e) => e.code === "not-connected",
  );
  assert.equal(r.posts.length, 0);
  /* A route Relay has closed: the address is hidden on either plan. */
  const closed = { ...MIN_CHAINS[1], depositEnabled: false };
  const noRoute = {
    fetchImpl: async (url) => (String(url).endsWith("/chains") ? answer({ chains: [MIN_CHAINS[0], closed] }) : answer({}, false, 500)),
  };
  await assert.rejects(
    () => F.getDepositAddressForPlan(askFor({ planId: F.FIRST_HOP_PLAN_ID, fetchImpl: noRoute.fetchImpl })),
    (e) => e.code === "route-unavailable",
  );
  assert.deepEqual(F.FALL_BACK_ON, ["relay-error", "unsafe-quote", "bad-deposit-address", "bad-response"]);
});

test("P3c) 🔴 a MOMENTARY refusal (rate limit, timeout, service down) never hands a brand-new account the 1.22 route", async () => {
  /* Owner, 2026-10-15: "มันมีเส้นทางที่ไม่ต้องเสีย 1.22". Asked again a moment
     later, the same no-cost quote goes through; the direct plan's first deposit
     pays the one-time cost. So the refusal is shown, with its retry. */
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    const r = relayFake([answer({ message: `the service answered ${status}` }, false, status), answer({ message: "the direct one was asked" }, false, 400)]);
    await assert.rejects(
      () => F.getDepositAddressForPlan(askFor({ planId: F.FIRST_HOP_PLAN_ID, fetchImpl: r.fetchImpl })),
      (e) => e.code === "relay-error" && e.detail.status === status,
      String(status),
    );
    assert.deepEqual(r.posts.map((p) => p.destinationChainId), [ARB], `${status}: the no-cost route only`);
  }
  assert.equal(F.isMomentaryRefusal({ code: "relay-error", detail: { status: 400 } }), false, "a price refusal is not momentary");
  assert.equal(F.isMomentaryRefusal({ code: "unsafe-quote", detail: { status: 503 } }), false, "only the service's own refusals");
});

/* ════════════════════════════════════════════════════════════════════════════
   C. TWO PLANS, TWO CACHES
   ════════════════════════════════════════════════════════════════════════════ */

test("C1) 🔴 each plan keeps its addresses under its own key, so neither can hand back the other's", async () => {
  assert.equal(D.depositCacheKey(USER, "base-usdc"), `flowflow.perpDeposit.v1:${USER}:base-usdc`);
  assert.equal(D.depositCacheKey(USER, "base-usdc", F.FIRST_HOP_PLAN), `flowflow.perpFirst.v1:${USER}:base-usdc`);
  assert.notEqual(F.FIRST_DEPOSIT_CACHE_PREFIX, D.DEPOSIT_CACHE_PREFIX);

  const ask = askFor({ planId: F.FIRST_HOP_PLAN_ID, fetchImpl: relayFake([answer(clone())]).fetchImpl });
  const first = await F.getDepositAddressForPlan(ask);
  assert.equal(first.depositAddress, DEP);
  assert.deepEqual(ask.storage.keys(), [`flowflow.perpFirst.v1:${USER}:base-usdc`]);
  /* The same wallet and route on the direct plan reads NOTHING from that entry:
     it is a cache miss, and a fresh quote is asked for. */
  const r2 = relayFake([answer({ message: "the direct plan asked for its own" }, false, 400)]);
  await assert.rejects(
    () => F.getDepositAddressForPlan({ ...ask, planId: "direct", fetchImpl: r2.fetchImpl }),
    /direct plan asked for its own/,
  );
  assert.equal(r2.posts.length, 1);
  /* And the saved first-deposit address is still there, untouched. */
  const again = await F.getDepositAddressForPlan({ ...ask, fetchImpl: relayFake([]).fetchImpl });
  assert.equal(again.depositAddress, DEP);
  assert.equal(again.fromCache, true);
  assert.equal(again.plan, F.FIRST_HOP_PLAN_ID);
  assert.equal(again.minInputUsdc, 6, "the floor survives the round trip through the cache");
});

test("C2) 🔴 an address saved before plans existed reads as the direct one it was quoted as", async () => {
  const storage = fakeStore();
  const entry = {
    v: 1, user: USER.toLowerCase(), routeId: "base-usdc", chainId: 8453,
    currency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", depositAddress: DEP,
    feeEstimateUsdc: 1.24, activationIncluded: true, activationUsdc: 1.22,
    timeEstimateSec: 1, quotedAt: 1758999000000, pricedAt: 1758999000000, expiresAt: null, requestId: null,
  };
  storage.setItem(`flowflow.perpDeposit.v1:${USER.toLowerCase()}:base-usdc`, JSON.stringify(entry));
  const got = await F.getDepositAddressForPlan(askFor({ planId: "direct", storage, fetchImpl: relayFake([]).fetchImpl }));
  assert.equal(got.depositAddress, DEP, "the address a customer may have saved in an exchange is still theirs");
  assert.equal(got.plan, "direct");
  /* The first-deposit plan does not read it. */
  const r = relayFake([answer(clone())]);
  const first = await F.getDepositAddressForPlan(askFor({ planId: F.FIRST_HOP_PLAN_ID, storage, fetchImpl: r.fetchImpl }));
  assert.equal(r.posts.length, 1, "a quote of its own");
  assert.equal(first.plan, F.FIRST_HOP_PLAN_ID);
});

/* ════════════════════════════════════════════════════════════════════════════
   B. THE LAST HOP
   ════════════════════════════════════════════════════════════════════════════ */

const RAW25 = 25000000n;
const transferData = (raw) => `0xa9059cbb${BRIDGE.slice(2).padStart(64, "0")}${raw.toString(16).padStart(64, "0")}`;

test("B1) 🔴 THE ADDRESSES, WRITTEN DOWN: the transfer is of Arbitrum USDC, to the deposit contract, on chain 42161", () => {
  assert.equal(A.ARBITRUM_CHAIN_ID, ARB);
  assert.equal(A.ARBITRUM_USDC, USDC);
  assert.equal(A.ARBITRUM_USDC_DECIMALS, 6);
  assert.equal(A.PERP_DEPOSIT_CONTRACT, BRIDGE);
  assert.equal(A.BRIDGE_MIN_USDC, 5);
  assert.equal(A.BRIDGE_MIN_RAW, 5000000n);
  assert.equal(A.ARBITRUM_RPC, "https://arb1.arbitrum.io/rpc");
  const call = A.bridgeTransferCall({ owner: USER, raw: RAW25 });
  assert.deepEqual(call, { chainId: ARB, to: USDC, data: transferData(RAW25), value: "0x0" });
  /* The destination is read back OUT of the calldata that was just built. */
  assert.equal(`0x${call.data.slice(34, 74)}`, BRIDGE);
  assert.equal(BigInt(`0x${call.data.slice(74)}`), RAW25);
  assert.equal(call.data.length, 138);
});

test("B2) 🔴 NOTHING UNDER THE FLOOR IS EVER BUILT: below it the money is accepted, never credited and never returned", () => {
  for (const raw of [0n, 1n, 4999999n]) {
    assert.throws(() => A.bridgeTransferCall({ owner: USER, raw }), (e) => e.code === "below-minimum", String(raw));
  }
  assert.ok(A.bridgeTransferCall({ owner: USER, raw: 5000000n }), "exactly the floor is allowed");
  for (const bad of [undefined, null, 25, "25000000", 25000000.5]) {
    assert.throws(() => A.bridgeTransferCall({ owner: USER, raw: bad }), (e) => e.code === "bad-amount" || e.code === "below-minimum", String(bad));
  }
  for (const owner of [null, "", "0x1", OTHER.slice(0, 20), "0x0000000000000000000000000000000000000000"]) {
    assert.throws(() => A.bridgeTransferCall({ owner, raw: RAW25 }), (e) => e.code === "bad-address", String(owner));
  }
});

/* A signer that records what it was asked to send. */
function fakeSigner({ address = USER, hash = HASH, fail = null } = {}) {
  const sent = [];
  return {
    sent,
    signer: {
      address,
      sendTransaction: async (tx) => {
        sent.push(tx);
        if (fail) throw fail;
        return { hash };
      },
    },
  };
}
/** An Arbitrum RPC that answers one balance. */
function rpcFake(hex, { ok = true, body = null } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok, status: ok ? 200 : 500, json: async () => body || { jsonrpc: "2.0", id: 1, result: hex } };
    },
  };
}
const moveWith = (over = {}) => ({ owner: USER, connected: USER, timers: NO_TIMERS, now: () => 1759000000000, ...over });

test("B3) 🔴 the amount is what is THERE, read from the chain at that moment — never a remembered figure", async () => {
  const rpc = rpcFake("0x" + RAW25.toString(16).padStart(64, "0"));
  const s = fakeSigner();
  const out = await A.moveArbitrumUsdcToPerp(moveWith({ sender: s.signer, fetchImpl: rpc.fetchImpl }));
  assert.equal(out.txHash, HASH);
  assert.equal(out.raw, RAW25);
  assert.equal(out.usdc, 25);
  /* 🔴 TWO READS AND NOTHING ELSE: what is there to move, and whether there is
     any gas at that address to move it with. Both are reads — the only thing this
     lib ever sends to a host — and the transfer itself goes to the signer, never
     to the network (G2 pins the method names). */
  assert.equal(rpc.calls.length, 2);
  for (const c of rpc.calls) assert.equal(c.url, "https://arb1.arbitrum.io/rpc");
  assert.equal(rpc.calls[0].body.method, "eth_call");
  assert.equal(rpc.calls[0].body.params[0].to, USDC, "the balance is read off the token");
  assert.equal(rpc.calls[0].body.params[0].data, `0x70a08231${USER.slice(2).padStart(64, "0")}`);
  assert.equal(rpc.calls[1].body.method, "eth_getBalance");
  assert.equal(rpc.calls[1].body.params[0], USER, "the gas is read off the customer's own address");
  assert.deepEqual(s.sent, [{ chainId: ARB, to: USDC, data: transferData(RAW25), value: "0x0" }]);
  assert.equal(s.sent.length, 1, "one transfer, not two");
});

test("B4) 🔴 THE SENDER IS THE CUSTOMER: the deposit is credited to whoever sent it, so a foreign signer is refused", async () => {
  const bal = "0x" + RAW25.toString(16).padStart(64, "0");
  const cases = [
    [moveWith({ sender: fakeSigner({ address: OTHER }).signer, fetchImpl: rpcFake(bal).fetchImpl }), "wrong-signer"],
    [moveWith({ sender: fakeSigner({ address: null }).signer, fetchImpl: rpcFake(bal).fetchImpl }), "wrong-signer"],
    [moveWith({ connected: OTHER, sender: fakeSigner().signer, fetchImpl: rpcFake(bal).fetchImpl }), "not-connected"],
    [moveWith({ owner: null, sender: fakeSigner().signer, fetchImpl: rpcFake(bal).fetchImpl }), "bad-address"],
    [moveWith({ sender: null, fetchImpl: rpcFake(bal).fetchImpl }), "no-signer"],
    [moveWith({ sender: {}, fetchImpl: rpcFake(bal).fetchImpl }), "no-signer"],
  ];
  for (const [args, codeWanted] of cases) {
    await assert.rejects(() => A.moveArbitrumUsdcToPerp(args), (e) => e.code === codeWanted, codeWanted);
  }
  /* Not one of those refusals read the chain or reached the signer. */
  const s = fakeSigner({ address: OTHER });
  await assert.rejects(() => A.moveArbitrumUsdcToPerp(moveWith({ sender: s.signer, fetchImpl: rpcFake(bal).fetchImpl })));
  assert.deepEqual(s.sent, []);
});

test("B5) 🔴 a short balance is not touched, and the attempt is never written down for it", async () => {
  const s = fakeSigner();
  let wrote = 0;
  await assert.rejects(
    () => A.moveArbitrumUsdcToPerp(moveWith({
      sender: s.signer,
      fetchImpl: rpcFake("0x" + (4999999n).toString(16).padStart(64, "0")).fetchImpl,
      beforeSend: () => { wrote += 1; },
    })),
    (e) => e.code === "below-minimum" && e.detail.usdc === 4.999999,
  );
  assert.deepEqual(s.sent, []);
  assert.equal(wrote, 0, "nothing was written down, because nothing was signed");
});

test("B6) 🔴 an unreadable balance THROWS: it must never read as an empty wallet", async () => {
  const bad = [
    rpcFake(null, { ok: false, body: { error: { message: "nope" } } }),
    rpcFake(null, { body: { jsonrpc: "2.0", error: { code: -32000, message: "nope" } } }),
    rpcFake(null, { body: { jsonrpc: "2.0", result: null } }),
    rpcFake("not-hex"),
    rpcFake("0x" + "f".repeat(64)),
  ];
  for (const r of bad) {
    await assert.rejects(() => A.readArbitrumUsdcBalance({ owner: USER, fetchImpl: r.fetchImpl, timers: NO_TIMERS }), (e) => e.code === "bad-response");
  }
  await assert.rejects(
    () => A.readArbitrumUsdcBalance({ owner: USER, fetchImpl: async () => { throw new Error("offline"); }, timers: NO_TIMERS }),
    (e) => e.code === "network",
  );
  /* A zero balance is a real zero, and says so. */
  const zero = await A.readArbitrumUsdcBalance({ owner: USER, fetchImpl: rpcFake("0x0").fetchImpl, timers: NO_TIMERS, now: () => 7 });
  assert.equal(zero.raw, 0n);
  assert.equal(zero.usdc, 0);
  assert.equal(zero.readAt, 7);
  assert.equal(A.usdcFromRaw(1n), 0.000001);
  assert.equal(A.usdcFromRaw(25000001n), 25.000001);
  assert.equal(A.usdcFromRaw(-1n), null);
  assert.equal(A.usdcFromRaw(25), null);
});

test("B7) the attempt is written down as the LAST thing before the signature, and a refused send is reported as one", async () => {
  const order = [];
  const s = fakeSigner({ fail: new Error("the wallet said no") });
  await assert.rejects(
    () => A.moveArbitrumUsdcToPerp(moveWith({
      sender: { address: USER, sendTransaction: async (tx) => { order.push("sign"); return s.signer.sendTransaction(tx); } },
      fetchImpl: rpcFake("0x" + RAW25.toString(16).padStart(64, "0")).fetchImpl,
      beforeSend: ({ raw, usdc, call }) => { order.push("write"); assert.equal(raw, RAW25); assert.equal(usdc, 25); assert.equal(call.to, USDC); },
    })),
    (e) => e.code === "send-failed",
  );
  assert.deepEqual(order, ["write", "sign"]);
  /* An answer that is not a transaction hash is a failure, not a success. */
  for (const hash of [null, "0x", "nope", `0x${"ab".repeat(31)}`]) {
    await assert.rejects(
      () => A.moveArbitrumUsdcToPerp(moveWith({
        sender: { address: USER, sendTransaction: async () => ({ hash }) },
        fetchImpl: rpcFake("0x" + RAW25.toString(16).padStart(64, "0")).fetchImpl,
      })),
      (e) => e.code === "send-failed", String(hash),
    );
  }
  /* A bare string hash is read too (a provider that answers one). */
  const plain = await A.moveArbitrumUsdcToPerp(moveWith({
    sender: { address: USER, sendTransaction: async () => HASH },
    fetchImpl: rpcFake("0x" + RAW25.toString(16).padStart(64, "0")).fetchImpl,
  }));
  assert.equal(plain.txHash, HASH);
});

test("B8) 🔴 the receipt of a sent transfer: mined-and-done, mined-and-undone, not yet — and an unreadable one THROWS", async () => {
  const rx = (result) => rpcFake(null, { body: { jsonrpc: "2.0", id: 1, result } });
  const ok = rx({ transactionHash: HASH, blockNumber: "0x10", status: "0x1" });
  assert.equal(await A.readArbitrumTxReceipt({ txHash: HASH, fetchImpl: ok.fetchImpl, timers: NO_TIMERS }), "success");
  assert.equal(ok.calls[0].body.method, "eth_getTransactionReceipt", "a read, and only a read");
  assert.deepEqual(ok.calls[0].body.params, [HASH]);
  assert.equal(await A.readArbitrumTxReceipt({ txHash: HASH, fetchImpl: rx({ transactionHash: HASH, blockNumber: "0x10", status: "0x0" }).fetchImpl, timers: NO_TIMERS }), "reverted");
  /* No receipt is the chain's own "not mined (yet)": null, never "success". */
  assert.equal(await A.readArbitrumTxReceipt({ txHash: HASH, fetchImpl: rx(null).fetchImpl, timers: NO_TIMERS }), null);
  /* A receipt for another transaction, one with no block, a status nobody knows,
     an error, or no answer at all: unreadable, so the attempt stays unresolved. */
  for (const bad of [
    rx({ transactionHash: `0x${"cd".repeat(32)}`, blockNumber: "0x10", status: "0x1" }),
    rx({ transactionHash: HASH, status: "0x1" }),
    rx({ transactionHash: HASH, blockNumber: "0x10", status: "0x2" }),
    rx("0x1"),
    rpcFake(null, { ok: false, body: { error: { message: "nope" } } }),
    rpcFake(null, { body: { jsonrpc: "2.0", id: 1 } }),
  ]) {
    await assert.rejects(() => A.readArbitrumTxReceipt({ txHash: HASH, fetchImpl: bad.fetchImpl, timers: NO_TIMERS }), (e) => e.code === "bad-response");
  }
  for (const txHash of [null, "", "0x12", HASH.slice(0, -2)]) {
    await assert.rejects(() => A.readArbitrumTxReceipt({ txHash, fetchImpl: ok.fetchImpl, timers: NO_TIMERS }), (e) => e.code === "bad-hash", String(txHash));
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   R. THE RESUME MACHINE
   ════════════════════════════════════════════════════════════════════════════ */

test("R1) where the move stands, from the balance, the attempt written down, and whether the wallet can sign by itself", () => {
  const step = (o) => MV.moveStep(o);
  /* Nothing read, nothing there, or less than a cent of dust: nothing is shown. */
  assert.equal(step({ raw: null }), "idle", "an unread balance shows nothing, never a zero");
  assert.equal(step({}), "idle");
  assert.equal(step({ raw: 0n }), "idle");
  /* There, but under the floor: a stop, with its own sentence. */
  assert.equal(step({ raw: 4999999n }), "short");
  assert.equal(step({ raw: 4999999n, canAuto: true }), "short", "being able to sign does not make it enough");
  /* 🔴 THE OWNER'S RULE (2026-10-15): money at or over the floor, with no
     unresolved attempt, moves by itself — whether or not anybody watched it land.
     There is no "watched" any more; passing one changes nothing. */
  assert.equal(step({ raw: 5000000n }), "auto");
  assert.equal(step({ raw: RAW25, watched: false }), "auto", "money already there is not offered any more");
  assert.equal(step({ raw: RAW25, watched: true }), "auto");
  /* A wallet that cannot sign by itself right now (no no-window sender): offered. */
  assert.equal(step({ raw: RAW25, canAuto: false }), "offer");
  /* 🔴 NEVER TWO SIGNATURES FOR ONE LANDING. An attempt written down and not
     shown finished by the chain is never repeated by itself: it is a button. */
  assert.equal(step({ raw: RAW25, record: { v: 1 } }), "again");
  assert.equal(step({ raw: RAW25, record: { v: 1 }, failed: true }), "failed");
  assert.equal(step({ raw: RAW25, failed: true }), "failed", "a refusal is a button too");
  assert.equal(step({ raw: RAW25, sending: true }), "sending");
  assert.equal(step({ raw: null, sending: true }), "sending");
  assert.equal(step({ raw: 0n, sentUsdc: 25 }), "sent");
  assert.equal(MV.moveRunsItself("auto"), true);
  for (const s of ["idle", "short", "offer", "again", "failed", "sending", "sent"]) assert.equal(MV.moveRunsItself(s), false, s);
  assert.deepEqual(["offer", "again", "failed"].map(MV.moveCanPress), [true, true, true]);
  assert.deepEqual(["idle", "short", "auto", "sending", "sent"].map(MV.moveCanPress), [false, false, false, false, false]);
});

test("R2) the attempt written down survives a closed app, and belongs to one wallet only", () => {
  const s = fakeStore();
  assert.equal(MV.readMoveRecord(s, USER), null);
  assert.equal(MV.moveRecordKey(USER), `flowflow.perpFirstMove.v1:${USER.toLowerCase()}`);
  MV.writeMoveRecord(s, { user: USER, address: DEP, at: 1759000000000 });
  const r = MV.readMoveRecord(s, USER);
  assert.equal(r.v, 1);
  assert.equal(r.user, USER.toLowerCase());
  assert.equal(r.address, DEP);
  assert.equal(r.txHash, null, "written before the signature, so there is no hash yet");
  assert.equal(MV.readMoveRecord(s, OTHER), null, "another wallet's record is not this one's");
  MV.writeMoveRecord(s, { user: USER, address: DEP, raw: "25000000", txHash: HASH, at: 1759000000000 });
  assert.equal(MV.readMoveRecord(s, USER).txHash, HASH);
  MV.clearMoveRecord(s, USER);
  assert.equal(MV.readMoveRecord(s, USER), null);
  /* Junk, a foreign record and a missing store are all read as no record. */
  s.setItem(MV.moveRecordKey(USER), "{{{");
  assert.equal(MV.readMoveRecord(s, USER), null);
  s.setItem(MV.moveRecordKey(USER), JSON.stringify({ v: 1, user: OTHER }));
  assert.equal(MV.readMoveRecord(s, USER), null);
  s.setItem(MV.moveRecordKey(USER), JSON.stringify({ v: 2, user: USER }));
  assert.equal(MV.readMoveRecord(s, USER), null);
  assert.equal(MV.readMoveRecord(null, USER), null);
  assert.doesNotThrow(() => MV.clearMoveRecord(null, USER));
  /* A store that throws (private mode) loses nothing that was not already lost. */
  const angry = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(MV.readMoveRecord(angry, USER), null);
  assert.equal(MV.writeMoveRecord(angry, { user: USER, address: DEP }).user, USER.toLowerCase());
  assert.doesNotThrow(() => MV.clearMoveRecord(angry, USER));
});

/* ════════════════════════════════════════════════════════════════════════════
   W. THE WORDS
   ════════════════════════════════════════════════════════════════════════════ */

const STEPS = ["idle", "short", "offer", "again", "failed", "sending", "auto", "sent"];
const LINE_ARGS = { usdc: 24.897110, minInputUsdc: 6, landing: "Arbitrum" };
const LINES = STEPS.map((step) => [step, MV.moveLines(step, LINE_ARGS)]);
/* 🔴 THE SAME STATES ON THE PLAN WHOSE ADDRESS LANDS IN THIS WALLET. One
   sentence differs between the two plans, a customer reads whichever one they
   are on, so both sets are checked by every test below. */
const LINES_JOIN = STEPS.map((step) => [step, MV.moveLines(step, { ...LINE_ARGS, sameAddressJoins: true })]);

test("W1) every state says where the customer's money is, in their words", () => {
  const of = (step) => LINES.find(([s]) => s === step)[1];
  assert.deepEqual(of("idle"), { text: null, action: null });
  assert.match(of("auto").text, /^Moving 24\.89711 USDC into your Perp account…$/);
  assert.equal(of("sending").text, of("auto").text);
  assert.match(of("sent").text, /^24\.89711 USDC is on its way to your Perp account\.$/);
  assert.match(of("offer").text, /^24\.89711 USDC is in your own wallet on Arbitrum\.$/);
  assert.equal(of("offer").action, "Move it into your Perp account");
  assert.equal(of("again").action, of("offer").action);
  assert.match(of("failed").text, /The move didn't go through\./);
  assert.equal(of("failed").action, "Try the move again");
  /* 🔴 THE ONE STATE WHERE THE MONEY NEEDS THEM: it is theirs, it is on a chain
     they can see, and it takes one more deposit to move it. It has TWO sentences,
     because only ONE plan's address on screen lands in this very wallet. Telling
     a customer on the other plan to send more "to the same address" would credit
     the new money straight to their Perp account, leave this money exactly where
     it is, and never let it out — an embedded wallet has no key export. */
  assert.match(of("short").text, /is in your own wallet on Arbitrum\./);
  assert.match(of("short").text, /It takes 5 USDC to move into your Perp account, so it waits until that wallet holds 5 USDC\./);
  assert.doesNotMatch(of("short").text, /same address/, "this plan's address is not this money's way out");
  assert.equal(of("short").action, null, "there is nothing to press: the money is not touched");
  /* And on the plan whose address does land here, that IS what to do. */
  const joins = LINES_JOIN.find(([s]) => s === "short")[1];
  assert.match(joins.text, /^24\.89711 USDC is in your own wallet on Arbitrum\./);
  assert.match(joins.text, /It takes 5 USDC to move into your Perp account\./);
  assert.match(joins.text, /Send another deposit to the same address — at least 6 USDC — and it all moves together\./);
  assert.equal(joins.action, null);
  /* Nothing else on this screen depends on which plan it is: every other state is
     about money that is already where it needs to be to move. */
  for (const [step, line] of LINES) {
    if (step === "short") continue;
    assert.deepEqual(LINES_JOIN.find(([s]) => s === step)[1], line, `${step}: only the short sentence turns on the plan`);
  }
});

test("W2) 🔴 an unknown amount is the dash, never a zero and never a guess", () => {
  const dashed = MV.moveLines("offer", { usdc: null, landing: "Arbitrum" });
  assert.match(dashed.text, /^— is in your own wallet on Arbitrum\.$/);
  assert.equal(MV.moveAmountText(null), "—");
  assert.equal(MV.moveAmountText(undefined), "—");
  assert.equal(MV.moveAmountText(NaN), "—");
  assert.equal(MV.moveAmountText(-1), "—");
  assert.equal(MV.moveAmountText(0), "0 USDC");
  assert.equal(MV.moveAmountText(24.89711), "24.89711 USDC");
  assert.equal(MV.moveAmountText(1234.5), "1,234.5 USDC");
  /* With no floor to quote, the sentence keeps its own two facts and invents none. */
  const noFloor = MV.moveLines("short", { usdc: 4.5, minInputUsdc: null, landing: "Arbitrum", sameAddressJoins: true });
  assert.match(noFloor.text, /It takes 5 USDC to move into your Perp account\./);
  assert.match(noFloor.text, /Send another deposit to the same address and it all moves together\./);
  assert.doesNotMatch(noFloor.text, /at least/);
  /* The other plan's sentence quotes no deposit size at all, with a floor or
     without one: the only figures in it are this wallet's own and the one it takes. */
  for (const minInputUsdc of [6, null]) {
    const waits = MV.moveLines("short", { usdc: 4.5, minInputUsdc, landing: "Arbitrum" });
    assert.match(waits.text, /^4\.5 USDC is in your own wallet on Arbitrum\. It takes 5 USDC to move into your Perp account, so it waits until that wallet holds 5 USDC\.$/);
  }
});

test("W3) 🔴 NO PROVIDER AND NO VENUE IN ANY OF THEM (owner: \"ไม่ต้องบอกด้วย ว่าใช้ Deposit ด้วย Relay\" / \"ไม่ต้องไปอ้าง Hyperliquid\"), and never the word free", () => {
  for (const [step, line] of [...LINES, ...LINES_JOIN]) {
    for (const text of [line.text, line.action]) {
      if (!text) continue;
      assert.doesNotMatch(text, /relay/i, step);
      assert.doesNotMatch(text, /hyperliquid|hyper ?core|\bHL\b/i, step);
      assert.doesNotMatch(text, /\bbridge\b|activation|\btopup\b|gas top-?up|\bRPC\b/i, step);
      assert.doesNotMatch(text, /\bfree\b/i, step + ": the owner said almost no fee, so the screen shows the figure");
    }
  }
});

test("W4) the rules line carries the plan's OWN floor, and no one-time cost is named on a plan that does not pay one", () => {
  const route = routeById("base-usdc");
  const first = V.depositRules(route, { accountNew: true, planId: F.FIRST_HOP_PLAN_ID, minInputUsdc: 6 });
  const text = first.map((r) => r.text).join(" ");
  assert.match(text, /Minimum deposit 6 USDC\./);
  assert.doesNotMatch(text, /activation/i, "there is nothing to activate on this plan");
  assert.doesNotMatch(text, /First deposit only/);
  assert.match(text, /Send only USDC on Base\./);
  assert.match(text, /Refunds return to your own address on Base\./);
  assert.match(text, /Credited as USDC in your Perp wallet\./);
  /* Ethereum's floor is its own: measured 10.07, so eleven. */
  assert.match(V.depositRules(routeById("ethereum-usdc"), { accountNew: true, planId: F.FIRST_HOP_PLAN_ID, minInputUsdc: 11 }).map((r) => r.text).join(" "), /Minimum deposit 11 USDC\./);
  /* The direct plan is untouched: our own product floor, and the one-time cost. */
  const direct = V.depositRules(route, { accountNew: true, activationUsdc: 1.2075 }).map((r) => r.text).join(" ");
  assert.match(direct, /Minimum deposit 5 USDC\./);
  assert.match(direct, /First deposit only — about 1\.2075 USDC one-time account activation\./);
  /* 🔴 A first-deposit plan with no floor of its own states NO floor: 5 would be
     the one number on this screen that could cost somebody a top-up. */
  const noFloor = V.depositRules(route, { accountNew: true, planId: F.FIRST_HOP_PLAN_ID, minInputUsdc: null }).map((r) => r.text).join(" ");
  assert.doesNotMatch(noFloor, /Minimum deposit/);
});

test("W5) the crossing's last phase is called what it is, and the pill with it", () => {
  assert.deepEqual(V.depositPhases(F.FIRST_HOP_PLAN_ID).map((p) => p.label), ["Waiting", "Arriving", "In your wallet"]);
  assert.deepEqual(V.depositPhases("direct").map((p) => p.label), ["Waiting", "Arriving", "Credited"]);
  assert.deepEqual(V.depositPhases(null).map((p) => p.label), ["Waiting", "Arriving", "Credited"]);
  assert.equal(V.phaseIndex("credited", F.FIRST_HOP_PLAN_ID), 2);
  const row = { id: "r", status: "credited", amountOut: 24.89711, symbolOut: "USDC", amountIn: 25, symbolIn: "USDC", inChainId: 8453, inTxHash: null };
  assert.equal(V.depositRowView(row, routeById("base-usdc"), F.FIRST_HOP_PLAN_ID).label, "In your wallet");
  assert.equal(V.depositRowView(row, routeById("base-usdc")).label, "Credited");
  assert.equal(V.depositRowView(row, routeById("base-usdc"), F.FIRST_HOP_PLAN_ID).amount, "+24.89711 USDC");
});

/* ════════════════════════════════════════════════════════════════════════════
   H. THE HOOK (the real file, driving the real runner, with the chain and the
      signer faked). Owner, 2026-10-15: "ทำไมเงิน ไม่ Move To Account แบบ Auto วะ
      ทุกเชนเลย ทำไมคนต้องมากดเองวะ" — money that is there moves by itself, on
      every plan, whether or not the panel watched it land (firstDepositMove's
      rule 2). What did NOT change: one signature per landing, the record
      written before it, the floor, and an unreadable balance claiming nothing.
   ════════════════════════════════════════════════════════════════════════════ */

const HOOK = "src/perp/deposit/useFirstDeposit.js";
const FUNDING = "src/perp/deposit/perpFunding.js";
let HK;
let FD;
before(async () => {
  const stubs = autoStubs([HOOK, FUNDING], {
    /* The plan's id, the move machine and the runner are the real ones: a stub
       would make every comparison in the hook answer undefined. The chain read,
       the transfer and the wallet are the three things a test must not do, and
       each test hands the runner its own fakes for them. */
    keep: ["src/lib/relay/firstDeposit.js", "src/perp/deposit/firstDepositMove.js", FUNDING],
    extra: { "src/lib/relay/arbitrumBridge.js": { real: "src/lib/relay/arbitrumBridge.js", only: ["readArbitrumUsdcBalance", "moveArbitrumUsdcToPerp", "readArbitrumTxReceipt"] } },
  });
  HK = await bundle({ entry: HOOK, stubs });
  FD = await bundle({ entry: FUNDING, stubs });
});

const flushAsync = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
/* Let every effect this hook chains (read, move, read again) run to a standstill. */
/* The hook reads the runner through useSyncExternalStore, which the test runner
   does not subscribe to, so each round renders again to read the runner's state. */
const settle = async (w) => { for (let i = 0; i < 8; i++) { await flushAsync(); w.h.render(); w.h.flush(); } };
const credited = (at) => [{ id: "req1", status: "credited", amountOut: 25, symbolOut: "USDC", createdAt: at, updatedAt: at }];

/**
 * The hook on a fresh runner of its own. The chain is one balance (raw, base
 * units as a string; null = unreadable); a move reads it, writes the attempt
 * down through beforeSend, "signs", and empties the wallet.
 */
function hookWorld({ raw = "25000000", requests = [], storage = fakeStore(), fail = null, planId = "arb-first", canFinish = true, enabled = true, signer = USER, receipt = null } = {}) {
  const calls = { reads: [], moves: [], signed: [], receipts: [] };
  let balance = raw;
  const funding = FD.createPerpFunding({
    storage,
    locks: null,
    now: () => 2000,
    read: async (args) => {
      calls.reads.push(args);
      if (balance === null) throw new A.PerpMoveError("network", "no");
      return { raw: BigInt(balance), usdc: Number(balance) / 1e6, readAt: 1 };
    },
    move: async (args) => {
      calls.moves.push(args);
      if (!args.sender) throw new A.PerpMoveError("no-signer", "no signer");
      const there = BigInt(balance);
      if (typeof args.beforeSend === "function") args.beforeSend({ raw: there, usdc: Number(there) / 1e6, call: {} });
      if (fail) throw fail;
      calls.signed.push(there);
      balance = "0";
      return { txHash: HASH, raw: there, usdc: Number(there) / 1e6 };
    },
    receipt: async (args) => { calls.receipts.push(args); return receipt; },
    sender: () => (signer ? { address: signer, sendTransaction: async () => HASH } : null),
  });
  const props = { user: USER, connected: USER, planId, canFinish, depositAddress: DEP, minInputUsdc: 6, requests, enabled, funding };
  const h = HK.mount(() => HK.useFirstDepositMove(props));
  h.render();
  h.flush();
  /* The world changing under an open panel: the tracker's next answer, and the
     money on the chain. */
  const update = (over = {}) => {
    if (over.raw !== undefined) balance = over.raw;
    if (over.requests !== undefined) props.requests = over.requests;
    if (over.enabled !== undefined) props.enabled = over.enabled;
    h.render();
    h.flush();
  };
  return { h, calls, storage, props, funding, update, value: () => h.value, balance: () => balance };
}

test("H1) 🔴 money that arrives while the panel is open moves by itself, ONCE, and says so", async () => {
  const w = hookWorld({ raw: "0" });
  await settle(w);
  assert.equal(w.value().step, "idle", "nothing has arrived yet");
  assert.equal(w.calls.moves.length, 0);
  w.update({ requests: credited(3000), raw: "25000000" });
  await settle(w);
  assert.equal(w.calls.moves.length, 1, "one move, not two");
  assert.equal(w.calls.signed.length, 1, "one signature");
  assert.equal(w.calls.moves[0].owner, USER);
  assert.equal(w.calls.moves[0].connected, USER);
  assert.equal(w.calls.moves[0].sender.address, USER, "the customer's own wallet signs it");
  assert.equal(w.value().step, "sent");
  assert.match(w.value().text, /^25 USDC is on its way to your Perp account\.$/);
  assert.equal(w.value().action, null);
  assert.equal(w.value().canPress, false);
  /* The attempt was written down, then the money left, so nothing guards nothing. */
  assert.equal(MV.readMoveRecord(w.storage, USER), null, "a wallet with no money left needs no record");
  /* Re-renders and the same arrival again move nothing more. */
  w.update({ requests: credited(3000) });
  await settle(w);
  assert.equal(w.calls.signed.length, 1);
  w.h.unmount();
});

test("H2) 🔴 money that was ALREADY there when the panel opened moves by itself too (the owner's new rule) — once", async () => {
  /* The old rule offered this money with a button because nobody watched it
     land. The owner's rule is that a deposit one hop short is finished for the
     customer, on every chain, without a press. */
  const w = hookWorld({ requests: credited(1000) });
  await settle(w);
  assert.equal(w.calls.moves.length, 1, "money already in the wallet moves without a press");
  assert.equal(w.calls.signed.length, 1);
  assert.equal(w.value().step, "sent");
  assert.match(w.value().text, /25 USDC is on its way to your Perp account\./);
  /* Opening the panel again later reads again and finds nothing to move. */
  w.update({ enabled: false });
  w.update({ enabled: true });
  await settle(w);
  assert.equal(w.calls.signed.length, 1, "never a second signature for the same landing");
  w.h.unmount();
});

test("H2b) 🔴 NO CLOCK AND NO ARRIVAL DECIDE IT: a row stamped in the future, or no rows at all — the chain's balance is the only question", async () => {
  for (const [label, requests] of [["a row stamped far ahead", credited(4102444800000)], ["no rows at all", []]]) {
    const w = hookWorld({ requests });
    await settle(w);
    assert.equal(w.calls.signed.length, 1, label);
    assert.equal(w.value().step, "sent", label);
    w.h.unmount();
  }
});

test("H3) 🔴 an attempt already written down and not shown finished is never repeated by itself, and two presses at once are one move", async () => {
  const storage = fakeStore();
  /* Written before a signature whose answer never came back (the app died). */
  MV.writeMoveRecord(storage, { user: USER, address: DEP, raw: "25000000", at: 1 });
  const w = hookWorld({ requests: credited(3000), storage });
  await settle(w);
  assert.equal(w.calls.moves.length, 0, "the app came back to money it had already tried to move");
  assert.equal(w.value().step, "again");
  assert.equal(w.value().action, "Move it into your Perp account");
  assert.equal(w.value().canPress, true);
  const both = [w.value().run(), w.value().run()];
  await Promise.all(both);
  await settle(w);
  assert.equal(w.calls.moves.length, 1, "one move, however many presses");
  assert.equal(w.calls.signed.length, 1);
  w.h.unmount();

  /* A sent attempt whose receipt is not there yet is not finished either —
     even with more money in the wallet than it moved. (The very figure it
     moved, read back, is never finished by a receipt at all: F4.) */
  const pend = fakeStore();
  MV.writeMoveRecord(pend, { user: USER, address: DEP, raw: "20000000", txHash: HASH, at: 1 });
  const p = hookWorld({ storage: pend, receipt: null });
  await settle(p);
  assert.equal(p.calls.receipts.length >= 1, true, "the chain is asked whether it was mined");
  assert.equal(p.calls.moves.length, 0, "no receipt yet: it may still be on its way");
  assert.equal(p.value().step, "again");
  p.h.unmount();
});

test("H4) 🔴 a failure leaves the money in the customer's own wallet, says where it is, and is not retried by itself", async () => {
  const w = hookWorld({ raw: "0", fail: new A.PerpMoveError("send-failed", "The move didn't go through") });
  await settle(w);
  w.update({ requests: credited(3000), raw: "25000000" });
  await settle(w);
  assert.equal(w.calls.moves.length, 1);
  assert.equal(w.value().step, "failed");
  assert.match(w.value().text, /25 USDC is in your own wallet on Arbitrum\. The move didn't go through\./);
  assert.equal(w.value().action, "Try the move again");
  assert.equal(w.value().canPress, true);
  assert.equal(w.value().code, "send-failed");
  /* 🔴 The attempt is written down even though it failed, so nothing retries by
     itself: the customer decides. Another landing, a re-open: still one try. */
  assert.ok(MV.readMoveRecord(w.storage, USER), "the attempt was written before the signature");
  w.update({ requests: [{ ...credited(4000)[0], id: "req2" }], raw: "30000000" });
  await settle(w);
  assert.equal(w.calls.moves.length, 1, "an unresolved attempt is a button, never a second automatic try");
  assert.equal(w.value().step, "failed");
  w.h.unmount();
});

test("H5) a short balance is not touched, and an unreadable one shows nothing at all", async () => {
  const short = hookWorld({ raw: "4999999", requests: credited(3000) });
  await settle(short);
  assert.equal(short.calls.moves.length, 0);
  assert.equal(short.value().step, "short");
  assert.match(short.value().text, /It takes 5 USDC to move into your Perp account\./);
  short.h.unmount();

  const unread = hookWorld({ raw: null, requests: credited(3000) });
  await settle(unread);
  assert.equal(unread.calls.moves.length, 0);
  assert.equal(unread.value().step, "idle", "an unreadable balance claims nothing");
  assert.equal(unread.value().text, null);
  unread.h.unmount();

  const empty = hookWorld({ raw: "0" });
  await settle(empty);
  assert.equal(empty.value().step, "idle");
  assert.equal(empty.calls.moves.length, 0);
  empty.h.unmount();
});

test("H6) a wallet that cannot sign the hop, and a closed panel, read nothing and can move nothing", async () => {
  for (const props of [{ canFinish: false }, { enabled: false }]) {
    const w = hookWorld({ ...props, requests: credited(3000) });
    await settle(w);
    assert.deepEqual(w.calls.reads, [], JSON.stringify(props));
    assert.equal(w.value().step, "idle");
    await w.value().run();
    assert.deepEqual(w.calls.moves, [], JSON.stringify(props));
    w.h.unmount();
  }
  /* No no-window sender (yet): the money is OFFERED, never moved by itself. */
  const none = hookWorld({ signer: null, requests: credited(3000) });
  await settle(none);
  assert.equal(none.calls.moves.length, 0, "no sender, no automatic move");
  assert.equal(none.value().step, "offer");
  assert.equal(none.value().action, "Move it into your Perp account");
  none.h.unmount();
  /* A sender for ANOTHER address is no sender for this wallet. */
  const foreign = hookWorld({ signer: OTHER, requests: credited(3000) });
  await settle(foreign);
  assert.equal(foreign.calls.moves.length, 0, "only the customer's own wallet moves by itself");
  assert.equal(foreign.value().step, "offer");
  foreign.h.unmount();
});

test("H6b) 🔴 money left on the landing chain moves by itself on EVERY plan — the direct one included", async () => {
  /* A customer who saved their first-deposit address in an exchange and sent to
     it again months later, with the direct plan on screen: the money lands in
     their own wallet, one hop short, and now goes the rest of the way. */
  for (const planId of ["direct", null]) {
    const w = hookWorld({ planId, requests: credited(3000) });
    await settle(w);
    assert.equal(w.calls.reads.length >= 1, true, "the balance is read whatever the plan");
    assert.equal(w.calls.signed.length, 1, String(planId));
    assert.equal(w.value().step, "sent", String(planId));
    w.h.unmount();
  }
});

test("H7) the balance is read on opening and on each arrival — and on no timer at all", async () => {
  const w = hookWorld({ raw: "0", requests: [] });
  await settle(w);
  assert.equal(w.calls.reads.length, 1, "one read on opening");
  assert.equal(w.calls.reads[0].owner, USER.toLowerCase());
  w.h.render();
  w.h.flush();
  await settle(w);
  assert.equal(w.calls.reads.length, 1, "a re-render reads nothing more");
  w.update({ requests: credited(3000) });
  await settle(w);
  assert.equal(w.calls.reads.length, 2, "an arrival reads once more");
  w.h.unmount();
  for (const f of [HOOK, FUNDING]) assert.doesNotMatch(code(f), /setInterval|setTimeout/, `${f}: nothing here polls`);
});

test("H8) 🔴 the panel and the app-wide mover are ONE move: the panel shows what the shared runner is doing", async () => {
  const w = hookWorld({ raw: "0", enabled: false });
  await settle(w);
  /* The app-wide mover (not the panel) finds the money and moves it. */
  w.update({ raw: "25000000" });
  await w.funding.check({ user: USER, connected: USER, auto: true });
  assert.equal(w.calls.signed.length, 1);
  /* The panel opens afterwards: it reads the same runner, and moves nothing again. */
  w.update({ enabled: true, requests: credited(3000) });
  await settle(w);
  assert.equal(w.calls.signed.length, 1, "the panel never starts a second move for the same money");
  assert.equal(w.value().step, "sent", "and says what the runner did");
  assert.match(w.value().text, /25 USDC is on its way to your Perp account\./);
  w.h.unmount();
});

/* ════════════════════════════════════════════════════════════════════════════
   X. THE BRIDGE'S CLOSED BUILDER (scripts/test-perp-silent-enable.mjs B5/B6
      drives it through a mounted bridge; here it is compared with the module
      that OWNS these addresses, so the two copies cannot drift apart)
   ════════════════════════════════════════════════════════════════════════════ */

test("X1) 🔴 the bridge's written-out addresses are the Perp module's own, to the character", () => {
  const b = code("src/components/privy/PrivyBridge.jsx");
  assert.match(b, new RegExp(`chainId: ${A.ARBITRUM_CHAIN_ID}\\b`), "the chain");
  assert.ok(b.includes(`"${A.ARBITRUM_USDC}"`), "the token");
  assert.ok(b.includes(`"${A.PERP_DEPOSIT_CONTRACT}"`), "the deposit contract");
  assert.ok(b.includes(`minRaw: ${A.BRIDGE_MIN_RAW}n`), "the floor");
  assert.ok(b.includes('selector: "0xa9059cbb"'), "transfer(address,uint256)");
  /* And the transfer the Perp module builds is one the bridge would accept. */
  const call = A.bridgeTransferCall({ owner: USER, raw: RAW25 });
  assert.equal(call.chainId, ARB);
  assert.equal(call.to, USDC);
  assert.equal(`0x${call.data.slice(34, 74)}`, BRIDGE);
});

/* ════════════════════════════════════════════════════════════════════════════
   G. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

const LIB = "src/lib/relay/arbitrumBridge.js";
const PLAN = "src/lib/relay/firstDeposit.js";
const MOVE = "src/perp/deposit/firstDepositMove.js";
const POPUP = "src/perp/deposit/depositPopupView.js";
const NEW_FILES = [LIB, PLAN, MOVE, HOOK, FUNDING, POPUP];

test("G1) 🔴 nothing here holds a key, and the one signer is handed in", () => {
  for (const f of NEW_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /privateKey|mnemonic|new Wallet\(|signTypedData|personal_sign|eth_sign/i, `${f} reaches for a key`);
  }
  /* The lib takes a sender and asks it; it never goes looking for one. */
  assert.doesNotMatch(code(LIB), /services\/privy|useWallet|getSigner/, "the signer is the caller's, never this file's");
  assert.doesNotMatch(code(PLAN), /sendTransaction|services\/privy/, "the quote file sends nothing");
  assert.doesNotMatch(code(MOVE), /fetch\(|sendTransaction|services\/privy/, "the machine talks to nobody");
  assert.doesNotMatch(code(POPUP), /fetch\(|sendTransaction|services\/privy/, "the popup's words talk to nobody");
  /* 🔴 The runner is the only one that may ask the wallet (one runner per tab),
     and neither it nor the hook builds a call. */
  assert.match(code(FUNDING), /privySilentTxSender/);
  assert.doesNotMatch(code(HOOK), /privySilentTxSender|services\/privy/, "the panel's hook asks the runner, never the wallet");
  for (const f of [HOOK, FUNDING]) {
    assert.doesNotMatch(code(f), /0xa9059cbb|0x2df1c51e|0xaf88d065/, `${f}: the calldata and the addresses live in the lib, verified there`);
  }
});

test("G3) MONEY_RULES: no '?? 0', '|| 0' or Math.max(0, …) between an unknown and the screen", () => {
  for (const f of NEW_FILES) {
    assert.doesNotMatch(code(f), /\?\?\s*0(?![.\d])|\|\|\s*0(?![.\d])|Math\.max\(\s*0\s*,/, f);
  }
});

test("G4) nothing runs at import time in the new lib files", () => {
  for (const f of [LIB, PLAN, MOVE, FUNDING, POPUP]) {
    const top = code(f).split("\n").filter((l) => /^\S/.test(l) && !/^(export\s+)?(async\s+)?(function|class|const|let|import|\}|\)|\])/.test(l));
    assert.deepEqual(top, [], `${f} runs something at module level`);
  }
});

test("G5) the floor is one constant, compared as BigInt, and it is never written as a bare 5 anywhere else", () => {
  assert.equal(A.BRIDGE_MIN_RAW, BigInt(A.BRIDGE_MIN_USDC) * 1000000n);
  /* Every reader of the floor imports it. */
  for (const f of [PLAN, MOVE, FUNDING, POPUP]) assert.match(code(f), /BRIDGE_MIN_(USDC|RAW)/, f);
  const c = code(LIB);
  assert.match(c, /raw < BRIDGE_MIN_RAW/, "the build refuses below the floor");
  assert.match(c, /balance\.raw < BRIDGE_MIN_RAW/, "and so does the send, against the chain's own figure");
});
