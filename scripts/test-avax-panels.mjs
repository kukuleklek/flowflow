/**
 * test-avax-panels — THE SPOT ACCOUNT PANELS (src/wallet/avax/): the pure words and gates of panelView.js, the DEV
 * sample states of panelPreview.js, and static checks that the panel files cannot sign, send, take a recipient or
 * offer "Try again".
 *
 * 🔴 MONEY SAFETY. Nothing here signs, holds a key or reaches a network. The panels' only way to money is
 * useAvaxAction (src/avax/useAvaxMoney.js → money.js → the visible signers); these tests hold the UI side of the
 * rules: no Confirm on an incomplete card, no "Review again" once money may have left, no address anywhere.
 *
 * Run: node --test scripts/test-avax-panels.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const PV = await imp("src/wallet/avax/panelView.js");
const LIM = await imp("src/avax/limits.js");

const HASH = `0x${"ab".repeat(32)}`;
const HASH2 = `0x${"cd".repeat(32)}`;
const CAPS = { moveUsdc: 20, stakeUsdc: 20, swapUsd: 20 };

/* A review shaped as money.js makeReview() makes it (only the fields the panels read). */
function review(over = {}) {
  return Object.freeze({
    kind: "move-in", id: "f1", title: "Move to your Spot Account", exit: false, route: null, confirmable: true, whyNot: null,
    amountText: "2 USDC", receiveText: "2 USDC", gasText: "includes ≈0.0208 AVAX for gas (≈$0.20)", windows: 2,
    warnings: [], liq: [],
    rows: [
      { key: "amount", label: "You move", value: "2 USDC", note: null },
      { key: "debit", label: "Leaves your Main Account", value: "2.244594 USDC", note: "at most 2.55 USDC" },
      { key: "fee", label: "Fee", value: "0.044594 USDC", note: null },
      { key: "gas", label: "Gas for later", value: "≈0.0208 AVAX ($0.20) · stays in your Spot Account", note: null },
      { key: "receive", label: "Arrives in your Spot Account", value: "2 USDC", note: "exactly" },
      { key: "time", label: "Time", value: "≈30 s", note: null },
      { key: "liq-BTC", label: "Liq after move · BTC", value: "60000 → 60100", note: null },
      { key: "windows", label: "Signatures", value: "2 signatures in your wallet", note: null },
    ],
    stages: [{ key: "authorize", label: "Approve the move", state: "todo" }],
    ...over,
  });
}
const action = (over = {}) => ({ ready: true, why: null, phase: "review", review: review(), canConfirm: true, outcome: null, ...over });

/* ── which panel ─────────────────────────────────────────────────────────── */

test("P1 panelKind: the five panels, the Agent's 'earn' and plan's 'aave-withdraw'; deposit/withdraw stay the Main Account's", () => {
  for (const k of ["swap", "move-in", "move-out", "stake", "unstake"]) assert.equal(PV.panelKind(k), k);
  assert.equal(PV.panelKind("earn"), "stake");
  assert.equal(PV.panelKind("aave-withdraw"), "unstake");
  for (const k of ["deposit", "withdraw", "", "Stake", "gas", null, undefined, 5]) assert.equal(PV.panelKind(k), null);
  for (const k of PV.PANEL_KINDS) {
    assert.ok(PV.PANEL_COPY[k] && PV.PANEL_COPY[k].title, `copy for ${k}`);
    assert.ok(PV.HOW_IT_WORKS[k], `tip for ${k}`);
  }
  assert.equal(PV.PANEL_COPY["move-in"].to, "Spot Account");
  assert.equal(PV.PANEL_COPY["move-out"].to, "Main Account");
});

/* ── amounts ─────────────────────────────────────────────────────────────── */

test("P2 typedAmount keeps digits and one dot, cut to the asset's decimals", () => {
  assert.equal(PV.typedAmount("1,5"), "1.5");
  assert.equal(PV.typedAmount("abc"), "");
  assert.equal(PV.typedAmount("$ 2.50 USDC"), "2.50");
  assert.equal(PV.typedAmount("00.123456789", 6), "0.123456");
  assert.equal(PV.typedAmount("1.2.3"), "1.23");
  assert.equal(PV.typedAmount("007"), "7");
  assert.equal(PV.typedAmount(".5"), "0.5");
  assert.equal(PV.typedAmount("12.34", 0), "12");
  assert.equal(PV.typedAmount("0.000000019", 8), "0.00000001");
});

test("P3 floorText cuts DOWN, never rounds up, and never prints 0 or an exponent", () => {
  assert.equal(PV.floorText(2.0000019, 6), "2.000001");
  assert.equal(PV.floorText(1.9999999, 6), "1.999999");
  assert.equal(PV.floorText(20, 6), "20");
  assert.equal(PV.floorText(0.1 + 0.2, 6), "0.3");
  assert.equal(PV.floorText(2.000001, 6), "2.000001", "a float a hair under the raw value is not cut a unit lower");
  for (const bad of [0, -1, NaN, Infinity, 1e-7, null, "2"]) assert.equal(PV.floorText(bad, 6), null);
});

test("P4 maxFor: only where safe, never above the cap, never from an unread balance", () => {
  assert.equal(PV.maxFor("move-in", { spotUsdc: 100, caps: CAPS }), null, "fees come on top of a move in: no Max");
  assert.equal(PV.maxFor("move-out", { spotUsdc: 120.5, caps: CAPS }), "20");
  assert.equal(PV.maxFor("move-out", { spotUsdc: 2.3456789, caps: CAPS }), "2.345678");
  assert.equal(PV.maxFor("move-out", { spotUsdc: null, caps: CAPS }), null, "unknown is not 0 and gives no Max");
  assert.equal(PV.maxFor("move-out", { spotUsdc: 0, caps: CAPS }), null);
  assert.equal(PV.maxFor("stake", { spotUsdc: 7.25, caps: { ...CAPS, stakeUsdc: 5 } }), "5", "an env-lowered cap holds");
  assert.equal(PV.maxFor("stake", { spotUsdc: 7.25, caps: { ...CAPS, stakeUsdc: 0 } }), null, "a cap of 0 = off");
  assert.equal(PV.maxFor("unstake", { stakedUsdc: 250.12 }), "all");
  assert.equal(PV.maxFor("unstake", { stakedUsdc: 0 }), null);
  assert.equal(PV.maxFor("unstake", { stakedUsdc: null }), null);
  /* Swaps: a pegged stable up to the cap; anything else 2 % under the cap at its shown price; no price, no Max. */
  assert.equal(PV.maxFor("swap", { caps: CAPS, from: { amount: 120.5, price: 0.9999, peg: 1, decimals: 6 } }), "20");
  assert.equal(PV.maxFor("swap", { caps: CAPS, from: { amount: 3, price: 0.9999, peg: 1, decimals: 6 } }), "3");
  const btc = PV.maxFor("swap", { caps: CAPS, from: { amount: 0.001, price: 80000, peg: null, decimals: 8 } });
  assert.equal(btc, "0.000245");
  assert.ok(Number(btc) * 80000 <= 20, "never above the cap at the price shown");
  assert.equal(PV.maxFor("swap", { caps: CAPS, from: { amount: 0.0001, price: 80000, peg: null, decimals: 8 } }), "0.0001");
  assert.equal(PV.maxFor("swap", { caps: CAPS, from: { amount: 2, price: null, peg: null, decimals: 18 } }), null);
  assert.equal(PV.maxFor("swap", { caps: CAPS, from: null }), null);
  /* Every Max a panel offers stays inside the hard caps money.js enforces. */
  assert.ok(Number(PV.maxFor("move-out", { spotUsdc: 1e9, caps: LIM.HARD })) <= LIM.HARD.moveUsdc);
  assert.ok(Number(PV.maxFor("stake", { spotUsdc: 1e9, caps: LIM.HARD })) <= LIM.HARD.stakeUsdc);
});

test("P5 priceArgs: the hook's args, or null when there is nothing to price (no recipient field exists)", () => {
  assert.deepEqual(PV.priceArgs("move-in", { amount: "2" }), { amountUsdc: "2" });
  assert.deepEqual(PV.priceArgs("unstake", { amount: "all" }), { amountUsdc: "all" });
  assert.equal(PV.priceArgs("stake", { amount: "all" }), null, "only unstake takes 'all'");
  assert.deepEqual(PV.priceArgs("swap", { amount: "2", from: "USDC", to: "BTC.b" }), { from: "USDC", to: "BTC.b", amount: "2" });
  assert.equal(PV.priceArgs("swap", { amount: "2", from: "USDC", to: "USDC" }), null);
  assert.equal(PV.priceArgs("swap", { amount: "2", from: "USDC", to: null }), null);
  for (const a of ["", "0", "0.000", ".", "1.", "-1", "1e3", "abc"]) assert.equal(PV.priceArgs("move-out", { amount: a }), null, a);
  for (const k of PV.PANEL_KINDS) {
    const x = PV.priceArgs(k, { amount: "2", from: "USDC", to: "BTC.b" });
    assert.ok(x, k);
    for (const key of Object.keys(x)) assert.ok(!/recipient|to_address|address|refund/i.test(key), `${k}: ${key}`);
  }
});

/* ── the review ──────────────────────────────────────────────────────────── */

test("P6 reviewLines: money.js's rows in order; Signatures out; the gas row in the owner's words; liq amber", () => {
  const lines = PV.reviewLines(review());
  assert.deepEqual(lines.map((l) => l.key), ["amount", "debit", "fee", "gas", "receive", "time", "liq-BTC"]);
  const gas = lines.find((l) => l.key === "gas");
  assert.equal(gas.value, "includes ≈0.0208 AVAX for gas (≈$0.20)");
  assert.equal(gas.note, "Stays in your Spot Account");
  assert.equal(lines.find((l) => l.key === "liq-BTC").tone, "warning");
  assert.equal(lines.find((l) => l.key === "receive").tone, "strong");
  assert.equal(lines.find((l) => l.key === "debit").note, "at most 2.55 USDC");
  /* No gas phrase: the row's own value stands. */
  const g2 = PV.reviewLines(review({ gasText: null })).find((l) => l.key === "gas");
  assert.equal(g2.value, "≈0.0208 AVAX ($0.20) · stays in your Spot Account");
  assert.deepEqual(PV.reviewLines(null), []);
  assert.deepEqual(PV.reviewLines({ rows: null }), []);
});

test("P7 unknownFigure: a paid or received figure printed '—' is caught; the time is not money", () => {
  assert.equal(PV.unknownFigure(review()), null);
  const rows = review().rows.map((r) => (r.key === "fee" ? { ...r, value: "—" } : r));
  assert.equal(PV.unknownFigure(review({ rows })), "Fee");
  const rows2 = review().rows.map((r) => (r.key === "receive" ? { ...r, value: "" } : r));
  assert.equal(PV.unknownFigure(review({ rows: rows2 })), "Arrives in your Spot Account");
  const rows3 = review().rows.map((r) => (r.key === "time" ? { ...r, value: "—" } : r));
  assert.equal(PV.unknownFigure(review({ rows: rows3 })), null);
});

test("P8 windowsLine: 'You'll approve N windows in your wallet', or nothing when the count is unknown", () => {
  assert.equal(PV.windowsLine(1), "You'll approve 1 window in your wallet");
  assert.equal(PV.windowsLine(2), "You'll approve 2 windows in your wallet");
  for (const n of [0, -1, 1.5, NaN, null, "2"]) assert.equal(PV.windowsLine(n), null);
});

test("P9 confirmGate: Confirm only on a complete, confirmable card the hook can run", () => {
  assert.deepEqual(PV.confirmGate({ earnOn: true, action: action() }), { enabled: true, why: null });
  assert.equal(PV.confirmGate({ earnOn: false, action: action() }).enabled, false, "behind VITE_EARN");
  assert.equal(PV.confirmGate({ earnOn: false, action: action() }).why, "Opens after the live test");
  assert.equal(PV.confirmGate({ earnOn: true, mock: true, action: action() }).why, "Live only");
  assert.equal(PV.confirmGate({ earnOn: true, action: null }).enabled, false);
  assert.equal(PV.confirmGate({ earnOn: true, action: action({ ready: false, why: "Sign in first" }) }).why, "Sign in first");
  assert.equal(PV.confirmGate({ earnOn: true, action: action({ phase: "pricing" }) }).enabled, false);
  assert.equal(PV.confirmGate({ earnOn: true, action: action({ phase: "running" }) }).enabled, false);
  assert.equal(PV.confirmGate({ earnOn: true, action: action({ canConfirm: false }) }).enabled, false);
  const blocked = PV.confirmGate({ earnOn: true, action: action({ review: review({ confirmable: false, whyNot: "Not enough USDC in your Spot Account" }) }) });
  assert.deepEqual(blocked, { enabled: false, why: "Not enough USDC in your Spot Account" });
  const rows = review().rows.map((r) => (r.key === "fee" ? { ...r, value: "—" } : r));
  const unknownFee = PV.confirmGate({ earnOn: true, action: action({ review: review({ rows }) }) });
  assert.equal(unknownFee.enabled, false, "a '—' the customer would pay by is never confirmable, even if the hook says it is");
  assert.match(unknownFee.why, /^Fee is unknown/);
  assert.equal(PV.confirmGate({ earnOn: true, action: action({ review: review({ windows: null }) }) }).enabled, false);
});

test("P9b whyTone: states and the customer's own cancel read quiet; everything else is an error", () => {
  for (const w of ["Still loading", "Sign in first", "View only", "Live only", "Opens after the live test", "Cancelled. Nothing moved."]) assert.equal(PV.whyTone(w), "muted", w);
  /* A limit is a fact of the card, not a refusal that reads like an attack (F17). */
  for (const w of ["Max 20 USDC per move in FlowFlow for now.", "Max ≈19.65 USDC this time: the fee and gas come on top, and at most 20 USDC leaves your Main Account per move."]) assert.equal(PV.whyTone(w), "muted", w);
  for (const w of ["Not enough USDC in your Spot Account", "It didn't go through on Avalanche. Only the network fee was spent.", "The move's price did not check out (the order pays more than once); nothing is signed"]) assert.equal(PV.whyTone(w), "error", w);
  assert.equal(PV.whyTone(null), null);
});

test("P10 stages: marks, and which active stage is a wallet window", () => {
  assert.equal(PV.stageMark("todo"), "todo");
  assert.equal(PV.stageMark("active"), "spin");
  assert.equal(PV.stageMark("done"), "check");
  assert.equal(PV.stageMark("failed"), "fail");
  assert.equal(PV.stageMark("unknown"), "unknown");
  assert.equal(PV.stageMark("weird"), "todo");
  assert.equal(PV.stageIsWindow({ key: "authorize", state: "active" }), true);
  assert.equal(PV.stageIsWindow({ key: "arrive", state: "active" }), false, "the money travelling is not a window");
  assert.equal(PV.stageIsWindow({ key: "swap", state: "done" }), false);
});

/* ── the outcome (rule 2: no "Try again" after money may have left) ──────── */

test("P11 outcomeView: done, arriving and refunded say what happened, with links", () => {
  const d = PV.outcomeView({ kind: "stake", phase: "done", outcome: { ok: true, state: "done", message: "2 USDC is in Aave.", receiptText: "Aave USDC +2.000000", txHashes: [HASH, HASH2] } });
  assert.equal(d.tone, "done");
  assert.equal(d.title, "2 USDC is in Aave.");
  assert.equal(d.receipt, "Aave USDC +2.000000");
  assert.deepEqual(d.links.map((l) => l.label), ["Snowtrace 1", "Snowtrace 2"]);
  assert.equal(d.links[0].href, `https://snowtrace.io/tx/${HASH}`);
  assert.equal(d.reviewAgain, false);
  const a = PV.outcomeView({ kind: "move-in", phase: "arriving", outcome: { ok: true, state: "arriving", message: "On its way.", requestId: HASH }, note: { text: "On its way to your Spot Account.", href: null } });
  assert.equal(a.tone, "arriving");
  assert.equal(a.message, "On its way to your Spot Account.");
  assert.deepEqual(a.links, [{ label: "Track", href: `https://relay.link/transaction/${HASH}` }]);
  assert.equal(a.reviewAgain, false);
  const r = PV.outcomeView({ kind: "move-in", phase: "refunded", outcome: { ok: false, state: "refunded", message: "Refunded to your Main Account." } });
  assert.equal(r.tone, "refunded");
  assert.equal(r.reviewAgain, false);
});

test("P12 outcomeView: unknown says where to look and offers nothing to press", () => {
  const u = PV.outcomeView({
    kind: "move-in", phase: "unknown",
    outcome: { ok: false, state: "unknown", unknown: true, message: "Not confirmed yet. Don't send it again.", whereToLook: { text: "Check your Main Account and your Spot Account before moving again. Don't send it again.", href: null } },
  });
  assert.equal(u.tone, "unknown");
  assert.equal(u.title, "Not sure yet — we're checking. Don't send again.");
  assert.equal(u.where, "Check your Main Account and your Spot Account before moving again.", "the title says 'Don't send again' once");
  assert.equal(u.message, null, "no third 'Don't send it again'");
  const n = PV.outcomeView({ kind: "move-out", phase: "unknown", outcome: { ok: false, state: "unknown", unknown: true, message: "Not confirmed yet. Don't send it again." }, note: { text: "Left your Spot Account. On its way to your Main Account.", href: null } });
  assert.equal(n.message, "Left your Spot Account. On its way to your Main Account.", "the watcher's news still shows");
  assert.equal(u.reviewAgain, false);
  assert.equal(u.requote, false);
  /* A failure this file can't call "nothing moved" is treated as unknown: no Review again. */
  for (const outcome of [null, { ok: false, state: "sending", message: "?" }, { ok: false, state: "arriving" }, { ok: false, state: "confirmed" },
    { ok: false, alreadyRun: true, state: "sending", code: "already-run", message: "This move already started." }, { ok: false, unknown: true, state: "cancelled" }]) {
    const v = PV.outcomeView({ kind: "move-out", phase: "failed", outcome });
    assert.equal(v.tone, "unknown", JSON.stringify(outcome));
    assert.equal(v.reviewAgain, false, JSON.stringify(outcome));
    assert.match(v.where, /Check your Spot Account and your Main Account/);
  }
});

test("P13 outcomeView: nothing moved → Review again; an expired price or a moved fee re-prices by itself", () => {
  const c = PV.outcomeView({ kind: "swap", phase: "failed", outcome: { ok: false, state: "cancelled", code: "cancelled", message: "Cancelled. Nothing moved." } });
  assert.equal(c.tone, "failed");
  assert.equal(c.title, "Cancelled. Nothing moved.");
  assert.equal(c.reviewAgain, true);
  assert.equal(c.requote, false);
  const e = PV.outcomeView({ kind: "swap", phase: "failed", outcome: { ok: false, state: "cancelled", code: "price_expired", message: "Price expired. Nothing moved." } });
  assert.equal(e.requote, true);
  const allowed = PV.outcomeView({ kind: "swap", phase: "failed", outcome: { ok: false, state: "error-before-money", code: "price_expired", message: "Allowed but not sent. Price expired. Nothing moved.", allowanceLeft: true } });
  assert.equal(allowed.requote, true);
  const fee = PV.outcomeView({ kind: "stake", phase: "failed", outcome: { ok: false, state: "cancelled", needsConfirm: true, code: "fee-moved", message: "Avalanche's network fee went up. Check the new price. Nothing moved." } });
  assert.equal(fee.requote, true);
  const reverted = PV.outcomeView({ kind: "stake", phase: "failed", outcome: { ok: false, state: "error-before-money", code: "reverted", message: "It didn't go through on Avalanche. Only the network fee was spent.", txHash: HASH } });
  assert.equal(reverted.reviewAgain, true);
  assert.equal(reverted.requote, false);
  const priced = PV.outcomeView({ kind: "move-in", phase: "failed", outcome: { ok: false, state: null, message: "Couldn't price this right now. Nothing moved." } });
  assert.equal(priced.reviewAgain, true);
  assert.equal(PV.nothingMoved({ ok: true, state: "done" }), false);
  assert.equal(PV.nothingMoved({ ok: false, state: "expired", code: "closed" }), true);
  assert.equal(PV.nothingMoved({ ok: false, state: null }), false, "a bare failure with no code or words is not proof");
});

test("P14 outcomeLinks: only 32-byte hashes, only snowtrace.io / relay.link, no duplicates", () => {
  const links = PV.outcomeLinks({
    txHashes: [HASH, "0x1234", `0x${"zz".repeat(32)}`, 42],
    requestId: "not-a-hash",
    whereToLook: { text: "x", href: "javascript:alert(1)" },
  }, { text: "y", href: `https://snowtrace.io/tx/${HASH}` });
  assert.deepEqual(links, [{ label: "Snowtrace", href: `https://snowtrace.io/tx/${HASH}` }]);
  const other = PV.outcomeLinks({ whereToLook: { href: "https://evil.example/tx" } }, { href: "http://snowtrace.io/tx/x" });
  assert.deepEqual(other, []);
});

/* ── moves in progress ───────────────────────────────────────────────────── */

test("P15 flowRowView: titles, amounts and states in the customer's words; unknown never says it can be resent", () => {
  const m = PV.flowRowView({ id: "a", kind: "move-in", state: "arriving", amounts: { out: "2", topupUsd: 0.2 }, view: { watching: true }, note: { text: "On its way to your Spot Account.", href: null } });
  assert.equal(m.title, "Moving to Spot Account");
  assert.equal(m.amountText, "2 USDC");
  assert.equal(m.tone, "moving");
  assert.equal(m.note.text, "On its way to your Spot Account.");
  const u = PV.flowRowView({ id: "b", kind: "move-out", state: "unknown", amounts: { in: "2" }, view: { watching: true, unknown: true }, note: null });
  assert.equal(u.tone, "unknown");
  assert.equal(u.stateText, "Not confirmed yet. Don't send it again.");
  const s = PV.flowRowView({ id: "c", kind: "swap", state: "sending", amounts: { from: "USDC", to: "BTC.b", amountRaw: "2000000", minOutRaw: "2400" }, note: { text: "x", href: "https://evil.example" } });
  assert.equal(s.amountText, "2 USDC → BTC.b");
  assert.equal(s.stateText, "Sending");
  assert.equal(s.note.href, null, "only snowtrace.io / relay.link links");
  assert.equal(PV.flowRowView({ id: "d", kind: "unstake", state: "arriving", amounts: { in: "all" } }).amountText, "All staked USDC");
  assert.equal(PV.flowRowView(null), null);
});

/* ── the DEV sample states ───────────────────────────────────────────────── */

test("P16 panelPreview: nothing in it can move money; its review passes the gate, its blocked card does not", async () => {
  globalThis.window = { location: { search: "?ffAvaxPanelPreview=review" } };
  const P = await imp("src/wallet/avax/panelPreview.js");
  for (const kind of PV.PANEL_KINDS) {
    const s = P.panelPreview(kind);
    assert.ok(s, kind);
    assert.equal(s.confirm(), null);
    assert.equal(await s.price({ amountUsdc: "2" }), null);
    assert.deepEqual(PV.confirmGate({ earnOn: true, action: s }), { enabled: true, why: null }, kind);
    assert.ok(PV.windowsLine(s.review.windows), kind);
  }
  globalThis.window = { location: { search: "?ffAvaxPanelPreview=blocked" } };
  for (const kind of PV.PANEL_KINDS) assert.equal(PV.confirmGate({ earnOn: true, action: P.panelPreview(kind) }).enabled, false, kind);
  globalThis.window = { location: { search: "?ffAvaxPanelPreview=unknown" } };
  const u = P.panelPreview("move-in");
  assert.equal(PV.outcomeView({ kind: "move-in", phase: u.phase, outcome: u.outcome }).reviewAgain, false);
  globalThis.window = { location: { search: "" } };
  assert.equal(P.panelPreview("move-in"), null);
  delete globalThis.window;
});

/* ── static: the panel files cannot sign, send, take a recipient or say "Try again" ── */

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FILES = ["src/wallet/avax/AvaxPanels.jsx", "src/wallet/avax/AvaxWallet.jsx", "src/wallet/avax/SpotMoves.jsx", "src/wallet/avax/panelView.js", "src/wallet/avax/panelPreview.js"];
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("S1 no signing, sending or chain switching in the panel files: money goes only through useAvaxAction", () => {
  for (const f of FILES) {
    const src = strip(read(f));
    for (const bad of [/showWalletUIs/, /switchChain/, /sendTransaction/, /signTypedData/, /eth_sendRawTransaction/, /sendAvaxTx/, /signAvaxTypedData/, /signAuthorize/, /sendDeposit/, /\.execute\(/]) {
      assert.ok(!bad.test(src), `${f}: ${bad}`);
    }
    for (const mod of [/avax\/signers/, /services\/privy/, /exchange\/client/, /relay\/(ownMove|moveOut|swap)\.js/, /components\/privy/]) {
      assert.ok(!mod.test(src), `${f} imports ${mod}`);
    }
  }
  const panels = strip(read("src/wallet/avax/AvaxPanels.jsx"));
  assert.match(panels, /useAvaxAction\(kind\)/);
  assert.match(panels, /disabled=\{!gate\.enabled\}/, "the Confirm button is the gate's");
  assert.match(panels, /if \(gate\.enabled\)[^\n]*a\.confirm\(a\.review\)/, "the tap checks the gate again, and names the review it was drawn with");
  assert.equal((panels.match(/a\.confirm\(/g) || []).length, 1, "one place confirms");
});

test("S2 no recipient, no address, no 'Try again' anywhere in the panels", () => {
  for (const f of FILES) {
    const src = strip(read(f));
    assert.ok(!/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.test(src), `${f}: an address`);
    assert.ok(!/recipient|refundTo|destination/i.test(src), `${f}: a recipient`);
    assert.ok(!/try again/i.test(src), `${f}: "Try again"`);
  }
});

test("S4 only the Avalanche mark: no vendor logo or vendor name drawn by the panels (owner: only Tokenomist + Avax logos)", () => {
  for (const f of ["src/wallet/avax/AvaxPanels.jsx", "src/wallet/avax/SpotMoves.jsx"]) {
    const src = strip(read(f));
    assert.ok(!/SponsorLogo/.test(src), `${f}: a sponsor logo`);
    assert.ok(!/MarkDisc name="(aave|relay|hyperliquid|privy)"/.test(src), `${f}: a vendor mark`);
  }
  for (const k of PV.PANEL_KINDS) {
    assert.ok(["avalanche", "usdc"].includes(PV.PANEL_COPY[k].mark), k);
    assert.ok(!/relay|hyperliquid|privy/i.test(PV.HOW_IT_WORKS[k]), `${k}: a vendor named in its tip`);
  }
});

test("S3 the build flag and the DEV sample gate", () => {
  const card = strip(read("src/wallet/avax/AvaxWallet.jsx"));
  assert.match(card, /export const EARN_ON = import\.meta\.env\.VITE_EARN === "on"/);
  /* The entries stay closed with the flag off; the EXITS never wait for it (plan §3.3, F15). */
  assert.match(card, /const open = EARN_ON \|\| exit;/, "a pill opens with the flag, or as an exit");
  assert.match(card, /disabled=\{!open \|\| !onClick\}/, "pills stay disabled with the flag off unless they are an exit");
  assert.match(card, /<ActionPill glyph="in" onClick/, "Move in is never an exit");
  assert.match(card, /<ActionPill glyph="stake" primary onClick/, "Stake is never an exit");
  assert.match(card, /return EARN_ON \? k : k && EXIT_PANELS\.includes\(k\) \? k : null;/, "with the flag off only an exit panel opens");
  assert.match(card, /EARN_ON \|\| exits\.any \? <SpotMoves \/> : null/, "no registry or watcher with the flag off and nothing to take out");
  const panels = strip(read("src/wallet/avax/AvaxPanels.jsx"));
  assert.match(panels, /import\.meta\.env\.DEV \? panelPreview\(kind\) : null/, "the sample states are DEV only");
  const view = strip(read("src/wallet/avax/panelView.js"));
  assert.ok(!/import\.meta/.test(view), "panelView is pure: no env read");
  const preview = strip(read("src/wallet/avax/panelPreview.js"));
  assert.ok(!/from "\.\.\/\.\.\/avax\//.test(preview) && !/fetch\(/.test(preview), "the samples reach no money code and no network");
});
