// Chat / voice → Spot Account panels (swap, unstake, move): the ask opens a pre-filled panel, never moves money.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIntent } from "../src/agent/intents.js";
import { spotHref, parseSwapAsk } from "../src/agent/spotAsk.js";
import { TOOLS, ACTION_TOOLS } from "../src/agent/tools.js";

const coins = ["BTC", "ETH", "HYPE", "SOL", "AVAX"];
const href = (t) => { const i = detectIntent(t, { coins }); return i ? spotHref({ action: i.kind, ...i }) : null; };

test("S1 swap asks open the swap panel with the pair and amount", () => {
  assert.equal(href("swap 10 usdc to btc"), "/wallet?panel=swap&amount=10&from=USDC&to=BTC.b");
  assert.equal(href("Buy BTC on Avax"), "/wallet?panel=swap&from=USDC&to=BTC.b");
  assert.equal(href("buy avax on avalanche"), "/wallet?panel=swap&from=USDC&to=WAVAX");
  assert.equal(href("แลก 20 USDC เป็นทอง"), "/wallet?panel=swap&amount=20&from=USDC&to=XAUt0");
  assert.equal(href("convert my btc.b to usdc"), "/wallet?panel=swap&from=BTC.b&to=USDC");
});

test("S2 native AVAX is never a swap target; unknown coins never reach the link", () => {
  assert.equal(parseSwapAsk("swap usdc to avax").to, "WAVAX");
  assert.equal(spotHref({ action: "swap", from: "USDC", to: "AVAX" }), "/wallet?panel=swap&from=USDC&to=WAVAX");
  assert.equal(spotHref({ action: "swap", from: "DOGE", to: "<x>" }), "/wallet?panel=swap");
  assert.equal(spotHref({ action: "drain" }), "/wallet");
  assert.equal(spotHref({ action: "stake", amount: "1e9" }), "/wallet?panel=stake");
});

test("S3 unstake and move asks", () => {
  assert.equal(href("unstake all"), "/wallet?panel=unstake");
  assert.equal(href("unstake 5 usdc"), "/wallet?panel=unstake&amount=5");
  assert.equal(detectIntent("ถอนจาก aave", { coins }).kind, "unstake");
  const m = detectIntent("move 5 usdc to spot", { coins });
  assert.equal(m.kind, "move"); assert.equal(m.amount, "5");
  assert.equal(detectIntent("stake 20 usdc", { coins }).kind, "stake");
});

test("S4 open_spot is an action tool the voice model may call", () => {
  assert.ok(ACTION_TOOLS.includes("open_spot"));
  assert.ok(TOOLS.some((t) => t.function.name === "open_spot"));
});
