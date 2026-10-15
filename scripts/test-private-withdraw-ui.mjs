/**
 * test-private-withdraw-ui — THE PRIVATE WITHDRAW SCREEN (Normal | Private), its one signature, and its rules.
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: the "Normal | Private" toggle on Withdraw, the four chains ("เอา ARB, Avax, Base, Polygon
 * พอแระ"), "Private" only with the partner key, and Hyperliquid's activation fee as its own row that has to stay
 * behind (commit 27f3a4a). What this suite pins:
 *
 *   V1  only Base, Avalanche, Arbitrum and Polygon USDC are offered
 *   V2  the toggle and the label: "Preview · not private yet" unless the probe AND the quote are confidential
 *   V3  amounts: min / max / decimals / balance, and the activation fee left behind before any real quote; the
 *       header's "Withdrawable" in whole cents rounded down; Max's note; the one-tap smaller amount
 *   V4  the destination is exactly what was typed (EIP-55, no burn address); the own wallet gets one short caution,
 *       and the in-app wallet on Arbitrum is refused (it would land straight back, minus the fees)
 *   V5  the review's rows from a REAL verified quote and preflight, the Deposit's look: send, receive ≈ (its Tip: at
 *       least), fee (its Tip: the refund fee), activation and "From your balance" (when it applies), time; the
 *       screening only when it refused; unknown is the dash and holds Confirm
 *   V6  the activation fee has to stay behind: Confirm held, "Withdraw X instead"
 *   V7  the one window's words: the rows' own figures, no address, no provider, armed only for a SendAsset
 *   V8  every refusal in plain words; sanctions with no workaround; Normal only as the customer's tap
 *   V9  the result screen: a lost reply is "Not confirmed", never "nothing sent", and names what LEFT the balance
 *       (amount + activation fee); a mismatch is never "arrived"
 *   V10 an unsettled private withdrawal blocks the next one, in words, with the figure that left the balance
 *   V11 the day cap in two decimals with the reader's own reset time; this browser's 24-hour cap carries its figure
 *   C1–C5 the exchange client's sendIntentsDeposit with a FAKE Hyperliquid and an OFFLINE wallet: one VISIBLE
 *       prompt, one POST, the no-window signer never asked; a lost reply is not_confirmed (lost, retry:false) and
 *       the executor records it unknown — never "nothing sent"; refusals never reach the wallet; the backend seam
 *   C6  two clocks: freshness on the browser clock that stamped the quote, the nonce on Hyperliquid's — a device a
 *       minute off still sends
 *   H1–H7 the sheet's hook (usePrivateWithdraw, a fake React): the real quote only on the press, ONE execute with the
 *       backend's sendIntentsDeposit, a stale quote re-priced and SHOWN before signing, a lost reply blocks the next;
 *       locked while followed
 *   R1–R3 the panel itself (esbuild, neighbours stubbed): ONE tree on Normal whatever the ledger says (the note is a
 *       prop, never a wrapper); a locked toggle ignores a change; the blocked form holds still with its reason first
 *   S1  source guards: the no-window count (G1) is unchanged, the DEV preview is DEV-only, Normal is the old code,
 *       nothing falls back to Normal by itself
 *
 * MONEY SAFETY: global fetch throws; every outside call is a fake; every signature is made OFFLINE with the official
 * Python SDK's published test key; no /exchange call leaves the process. Nothing is sent.
 *
 * Run: node --test scripts/test-private-withdraw-ui.mjs
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "./lib/stripComments.mjs";
import { autoStubs, bundle as bundlePanel, all as allEls } from "./lib/perpLiveHarness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) => stripComments(read(rel));
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

/* ── a fake React for the hook tests, resolved for "react" before anything imports it ── */
const FAKE_REACT = String.raw`
const S = (globalThis.__ffWdHooks ||= { cur: null });
function slot() { const c = S.cur; if (!c) throw new Error("hook outside mount()"); return [c, c.i++]; }
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
export function useRef(v) { const [c, i] = slot(); if (!(i in c.slots)) c.slots[i] = { current: v }; return c.slots[i]; }
export function useState(v) {
  const [c, i] = slot();
  if (!(i in c.slots)) c.slots[i] = { v: typeof v === "function" ? v() : v };
  const box = c.slots[i];
  return [box.v, (n) => { const nv = typeof n === "function" ? n(box.v) : n; if (!Object.is(nv, box.v)) { box.v = nv; c.dirty = true; } }];
}
export function useReducer(r, init) {
  const [c, i] = slot();
  if (!(i in c.slots)) c.slots[i] = { v: init };
  const box = c.slots[i];
  return [box.v, (a) => { const nv = r(box.v, a); if (!Object.is(nv, box.v)) { box.v = nv; c.dirty = true; } }];
}
export function useMemo(f, deps) { const [c, i] = slot(); const b = c.slots[i]; if (b && deps && same(b.deps, deps)) return b.v; const v = f(); c.slots[i] = { v, deps }; return v; }
export function useCallback(f, deps) { return useMemo(() => f, deps); }
export function useEffect(fn, deps) {
  const [c, i] = slot(); const b = c.slots[i];
  if (b && deps && same(b.deps, deps)) return;
  c.effects.push(() => { if (b && typeof b.cleanup === "function") b.cleanup(); c.slots[i] = { deps, cleanup: fn() }; });
}
export const useLayoutEffect = useEffect;
export function useSyncExternalStore(sub, get) { return get(); }
export function mount(fn) {
  const c = { slots: {}, i: 0, effects: [], dirty: false, value: undefined, dead: false };
  const render = () => {
    if (c.dead) return c.value;
    const prev = S.cur; S.cur = c; c.i = 0; c.effects = [];
    try { c.value = fn(); } finally { S.cur = prev; }
    const fx = c.effects; c.effects = [];
    for (const e of fx) e();
    return c.value;
  };
  return {
    render,
    get value() { return c.value; },
    flush() { let n = 0; while (!c.dead && c.dirty && n++ < 50) { c.dirty = false; render(); } return c.value; },
    unmount() { c.dead = true; for (const k of Object.keys(c.slots)) { const b = c.slots[k]; if (b && typeof b.cleanup === "function") b.cleanup(); } },
  };
}
export default { useRef, useState, useReducer, useMemo, useCallback, useEffect, useLayoutEffect, useSyncExternalStore };
`;
const FAKE_URL = `data:text/javascript,${encodeURIComponent(FAKE_REACT)}`;
register(`data:text/javascript,${encodeURIComponent(`
const FAKE = ${JSON.stringify(FAKE_URL)};
export async function resolve(spec, ctx, next) { if (spec === "react") return { url: FAKE, shortCircuit: true }; return next(spec, ctx); }
`)}`, import.meta.url);

const realFetch = globalThis.fetch;
let realNetworkAttempts = 0;
before(() => { globalThis.fetch = () => { realNetworkAttempts++; throw new Error("live network is forbidden in test-private-withdraw-ui"); }; });
after(() => { globalThis.fetch = realFetch; assert.equal(realNetworkAttempts, 0, "no real network call was attempted"); });

let V; let W; let J; let SC; let SW; let C; let N; let M; let PB; let React; let H; let viemAccounts; let viem;
before(async () => {
  V = await imp("src/perp/withdraw/privateWithdrawView.js");
  W = await imp("src/lib/intents/withdraw.js");
  J = await imp("src/lib/intents/withdrawJournal.js");
  SC = await imp("src/lib/signCopy.js");
  SW = await imp("src/services/signWords.js");
  C = await imp("src/lib/hyperliquid/exchange/client.js");
  N = await imp("src/lib/hyperliquid/exchange/network.js");
  M = await imp("src/lib/hyperliquid/exchange/master.js");
  PB = await imp("src/perp/live/perpBackend.js");
  React = await import("react");
  H = await imp("src/perp/withdraw/usePrivateWithdraw.js");
  viemAccounts = await import("viem/accounts");
  viem = await import("viem");
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const FIX = JSON.parse(read("scripts/fixtures/intents/withdraw-live-2026-10-15.json"));
const REAL = FIX.real.response; // the one dry:false research capture (random addresses), used as the SHAPE of a real answer
const REAL_AT = Date.parse(FIX.real.capturedAt);
const REAL_TO = REAL.quoteRequest.recipient;
const REAL_DEPOSIT = REAL.quote.depositAddress;
const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const PY_ADDRESS = "0x14791697260E4c9A71f18484C9f997B308e59325";
const RECIPIENT = "0x5Cf7d980F5B85BdA5E9CdDec35F1B003b6767372";
const PROVIDERS = /\bNEAR\b|1-?click|defuse|\bintents\b|\bRelay\b|Hyperliquid|chaindefuser/i;
const CLAIMS = /(?<!isn't )anonymous|untraceable|no KYC|invisible|hide from|\bmixer\b|tumbler|launder|can'?t be tracked|\bVPN\b|\bZK\b|zero-knowledge/i;
const clone = (x) => JSON.parse(JSON.stringify(x));
const route = (id) => W.privateWithdrawRouteById(id);

function memStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** The live real-quote capture, re-addressed to `user` (its refundTo), verified by the REAL parser at its capture time. */
function realQuoteFor(user = PY_ADDRESS, { now = REAL_AT } = {}) {
  const j = clone(REAL);
  j.quoteRequest.refundTo = user.toLowerCase();
  return W.parseIntentsWithdrawQuote(j, { user, recipient: REAL_TO, route: route("arbitrum-usdc"), amountUsdc: "20", dry: false, deadline: j.quoteRequest.deadline, now });
}

/* Hyperliquid's info, as it answered live for a fresh address (fee "1.0", role "missing"). */
function fakeInfo({ fee = "1.0", sanctioned = false, withdrawable = "100.0", role = "missing", noFee = false } = {}) {
  return async (body) => {
    if (body.type === "preTransferCheck") return noFee ? { isSanctioned: sanctioned, userExists: false } : { isSanctioned: sanctioned, userExists: false, fee, userHasSentTx: false };
    if (body.type === "userRole") return { role };
    if (body.type === "clearinghouseState") return { withdrawable };
    if (body.type === "userNonFundingLedgerUpdates") return [];
    throw new Error(`unexpected ${body.type}`);
  };
}
const preflightOf = (quote, o = {}) => W.readWithdrawPreflight({ quote, info: fakeInfo(o), now: () => quote.quotedAt + 1000, ...(o.withdrawableUsdc !== undefined ? { withdrawableUsdc: o.withdrawableUsdc } : {}) });

/* ════════════════════════════════════════════════════════════════════════════
   V. THE VIEW
   ════════════════════════════════════════════════════════════════════════════ */

test("V1) 🔴 exactly Base, Avalanche, Arbitrum and Polygon USDC are offered; Solana or an unknown id falls back to the default", () => {
  assert.deepEqual(V.privateWithdrawChains().map((r) => [r.id, r.chainId, r.token, r.chainName]), [
    ["base-usdc", 8453, "USDC", "Base"], ["avalanche-usdc", 43114, "USDC", "Avalanche"],
    ["arbitrum-usdc", 42161, "USDC", "Arbitrum"], ["polygon-usdc", 137, "USDC", "Polygon"],
  ]);
  assert.equal(V.privateWithdrawRouteFor("solana-usdc").id, "base-usdc", "Solana is priced, never offered");
  assert.equal(V.privateWithdrawRouteFor("nope").id, "base-usdc");
  for (const r of V.privateWithdrawChains()) assert.equal(V.privateWithdrawRouteFor(r.id), r, "the route object itself (the verifier checks identity)");
  assert.match(code("src/wallet/WithdrawPanel.jsx"), /privateWithdrawChains\(\)\.map\(/, "the panel draws its chips from that list");
});

test("V2) 🔴 \"Preview · not private yet\" unless the probe is confidential AND the quote came back confidential; the toggle shows only on a clear on", () => {
  const pub = { enabled: true, confidential: false, confidentiality: "public" };
  const conf = { enabled: true, confidential: true, confidentiality: "basic" };
  const off = { enabled: false, confidential: false, confidentiality: null };
  assert.equal(V.privateToggleShown(pub), true);
  assert.equal(V.privateToggleShown(off), false);
  assert.equal(V.privateToggleShown(null), false);
  assert.equal(V.privateToggleShown(off, V.MODE_PRIVATE), true, "switched off while on Private: the toggle stays so Normal is one tap away");
  assert.equal(V.privateToggleLabel(pub), "Private · preview");
  assert.equal(V.privateToggleLabel(conf), "Private");
  assert.deepEqual(V.privateWithdrawPrivacy({ probe: pub }), { private: false, label: "Preview · not private yet", tone: "warning" });
  assert.equal(V.privateWithdrawPrivacy({ probe: conf }).label, "Private");
  assert.equal(V.privateWithdrawPrivacy({ probe: conf, quote: { private: false } }).label, "Preview · not private yet", "a public quote is a preview whatever the probe said");
  assert.equal(V.privateWithdrawPrivacy({ probe: conf, quote: { private: true } }).label, "Private");
  assert.equal(V.privateWithdrawPrivacy({ probe: pub, quote: { private: true } }).label, "Preview · not private yet");
  assert.equal(V.privateWithdrawPrivacy({ probe: { enabled: true, confidential: true, confidentiality: "public" } }).private, false);
  for (const s of [V.PRIVATE_WITHDRAW_TIP, V.PRIVATE_WITHDRAW_PREVIEW_NOTE, V.PRIVATE_FOOTER, V.PRIVATE_ATTEST, V.ACTIVATION_TIP, V.SCREEN_TIP, V.HOW_IT_WORKS]) {
    assert.doesNotMatch(s, CLAIMS, s);
    assert.doesNotMatch(s, PROVIDERS, s);
  }
  assert.match(V.PRIVATE_WITHDRAW_TIP, /isn't anonymous/);
});

test("V3) 🔴 amounts: min, max, decimals and balance in plain words; 1 USDC of activation is left behind before any real quote", () => {
  const a = (t, o = {}) => V.privateWithdrawAmountOf(t, o);
  assert.deepEqual(a(""), { ok: false, units: null, hl: null, usdc: null, error: null }, "empty says nothing yet");
  assert.equal(a("1.1234567").error.code, "bad-amount", "more than 6 decimals is refused, never rounded");
  assert.equal(a("4.99").error.code, "below-min");
  assert.match(a("4.99").error.text, /smallest private withdrawal is 5 USDC/);
  assert.match(a("9", { limits: { withdrawMinUsdc: 10 } }).error.text, /is 10 USDC/, "the server may raise the minimum");
  assert.equal(a("500.01").error.code, "over-tx-cap");
  assert.match(a("150", { limits: { maxTxUsdc: 100 } }).error.text, /largest private withdrawal is 100 USDC/, "the server may lower the cap");
  assert.equal(a("600", { limits: { maxTxUsdc: 1000 } }).error.code, "over-tx-cap", "and never raise it");
  assert.equal(a("20").ok, true, "an unknown balance is the preflight's to check");
  assert.equal(a("20", { withdrawableUsdc: 21 }).ok, true, "20 + 1 activation = 21: fits exactly");
  const short = a("20", { withdrawableUsdc: 20.5 });
  assert.equal(short.error.code, "activation-reserve");
  assert.equal(short.error.text, "Leave 1.00 USDC in your balance for the activation fee.", "the figure is the button under it, not repeated");
  assert.deepEqual(V.privateWithdrawAmountFix(short.error, { withdrawableUsdc: 20.5 }), { usdc: 19.5, text: "Withdraw 19.50 USDC instead" });
  assert.equal(V.privateWithdrawAmountFix(a("5", { withdrawableUsdc: 5.5 }).error, { withdrawableUsdc: 5.5 }), null, "nothing below the minimum is offered");
  assert.equal(a("19.5", { withdrawableUsdc: 20.5 }).ok, true);
  assert.equal(a("19.500001", { withdrawableUsdc: 20.5 }).error.code, "activation-reserve");
  assert.equal(a("21", { withdrawableUsdc: 20.5 }).error.code, "over-balance");
  /* Max: whole cents, the activation behind, held to the cap; nothing to offer below the minimum. */
  assert.equal(V.privateWithdrawMaxUsdc(20.5), 19.5);
  assert.equal(V.privateWithdrawMaxUsdc(152.849), 151.84);
  assert.equal(V.privateWithdrawMaxUsdc(1000), 500);
  assert.equal(V.privateWithdrawMaxUsdc(1000, { maxTxUsdc: 50 }), 50);
  assert.equal(V.privateWithdrawMaxUsdc(5.99), null);
  assert.equal(V.privateWithdrawMaxUsdc(null), null);
  assert.equal(V.ACTIVATION_RESERVE_USDC, W.MAX_ACCOUNT_FEE_USDC);
  assert.equal(V.privateWithdrawLimitsText(), "Min 5 · Max 500 per withdrawal · 1,000 per day (USDC)");
  /* The header's "Withdrawable": two decimals like Normal's, rounded DOWN (never a cent above what can leave). */
  assert.equal(V.privateWithdrawableShown(152.843921), 152.84);
  assert.equal(V.privateWithdrawableShown(152.84), 152.84, "no float drift down a cent");
  assert.equal(V.privateWithdrawableShown(0.999999), 0.99);
  assert.equal(V.privateWithdrawableShown(null), null);
  const panel = code("src/wallet/WithdrawPanel.jsx");
  assert.match(panel, /Withdrawable <span className="num text-foreground">\{shown != null \? usdcNumber\(shown\) : "—"\}<\/span> · Max/);
  assert.doesNotMatch(panel.slice(panel.indexOf("function PrivateWithdraw")), /usdcExact/, "Private prints no 6-decimal money");
  /* Max's figure is 1.00 under "Withdrawable": the line under the field says why, only when the fee is what holds it. */
  assert.equal(V.privateWithdrawAmountNote({ amountText: "151.84", withdrawableUsdc: 152.849 }), "1.00 USDC stays behind for the activation fee.");
  assert.equal(V.privateWithdrawAmountNote({ amountText: "20", withdrawableUsdc: 152.849 }), V.privateWithdrawLimitsText());
  assert.equal(V.privateWithdrawAmountNote({ amountText: "500.00", withdrawableUsdc: 1000 }), V.privateWithdrawLimitsText(), "held by the cap, not the fee");
});

test("V4) 🔴 the destination is exactly what was typed (EIP-55, no burn address); the own wallet is allowed with a caution", () => {
  const base = route("base-usdc");
  const d = (t, o = {}) => V.privateWithdrawDestinationOf(t, base, o);
  assert.deepEqual(d(RECIPIENT), { ok: true, address: RECIPIENT, error: null, caution: null, own: false });
  assert.equal(d(RECIPIENT.toLowerCase()).address, RECIPIENT.toLowerCase(), "never re-cased");
  const typo = RECIPIENT.slice(0, -1) + (RECIPIENT.endsWith("2") ? "3" : "2");
  const flipped = `0x${RECIPIENT.slice(2).replace(/[a-f]/, (c) => c.toUpperCase())}`;
  assert.equal(d(flipped).ok, false, "one wrong capital fails the checksum");
  assert.match(d(flipped).error, /EIP-55/);
  assert.equal(d(typo).ok, false, "one changed character fails a mixed-case checksum too");
  assert.equal(d("0x0000000000000000000000000000000000000000").ok, false);
  assert.equal(d("0x000000000000000000000000000000000000dEaD").ok, false);
  assert.equal(d("0x1234").ok, false);
  assert.equal(d("").error, null, "empty says nothing yet");
  const own = d(PY_ADDRESS.toLowerCase(), { own: PY_ADDRESS });
  assert.equal(own.ok, true);
  assert.equal(own.own, true, "the panel offers Use Normal withdraw beside it");
  assert.equal(own.caution, "That's your own FlowFlow wallet, so Private hides nothing here.", "one short sentence, whatever the chain");
  assert.equal(d(RECIPIENT).own, false);
  /* The in-app wallet: on Base, Avalanche and Polygon the same short caution (no Arbitrum clause there)… */
  for (const id of ["base-usdc", "avalanche-usdc", "polygon-usdc"]) {
    const r = V.privateWithdrawDestinationOf(PY_ADDRESS, route(id), { own: PY_ADDRESS, walletType: "privy" });
    assert.equal(r.ok, true, id);
    assert.equal(r.caution, V.OWN_WALLET_CAUTION, id);
    assert.doesNotMatch(r.caution, /Arbitrum/, id);
  }
  /* …and on Arbitrum it is refused: it would land straight back in the balance, minus 0.21 + 1.00 USDC. */
  const arb = V.privateWithdrawDestinationOf(PY_ADDRESS, route("arbitrum-usdc"), { own: PY_ADDRESS, walletType: "privy" });
  assert.deepEqual([arb.ok, arb.error, arb.own], [false, "On Arbitrum this lands straight back in your balance, minus the fees. Pick another address.", true]);
  assert.equal(V.privateWithdrawDestinationOf(PY_ADDRESS, route("arbitrum-usdc"), { own: PY_ADDRESS, walletType: "external" }).ok, true, "an outside wallet is not moved by the app");
  const panel = code("src/wallet/WithdrawPanel.jsx");
  assert.match(panel, /<MoneyWarning>\{customerWords\(p\.dest\.caution\)\}<\/MoneyWarning>\s*\{p\.dest\.own \? <Button variant="outline" size="sm" onClick=\{onNormal\}>Use Normal withdraw<\/Button> : null\}/, "boxed, with Normal one tap away");
});

test("V5) 🔴 the review's rows come from the REAL verified quote and preflight; the activation row only when it applies; unknown is the dash and holds Confirm", async () => {
  const q = realQuoteFor();
  const pf = await preflightOf(q);
  assert.equal(pf.ok, true, pf.message);
  const rv = W.privateWithdrawReview({ quote: q, preflight: pf, now: q.quotedAt + 2000 });
  assert.equal(rv.confirmable, true);
  const rows = V.privateWithdrawRows({ quote: q, review: rv, preflight: pf });
  /* The Deposit's look: the floor and the refund fee ride in Tips, and what leaves the balance is printed. */
  assert.deepEqual(rows.map((r) => [r.label, r.value]), [
    ["You send", "20.00 USDC"],
    ["You receive", "≈ 19.79 USDC"],
    ["Fee", "0.21 USDC"],
    ["Activation fee", "1.00 USDC"],
    ["From your balance", "21.00 USDC"],
    ["Arrives in", "~34s"],
  ]);
  assert.equal(rows.find((r) => r.key === "receive").strong, true);
  assert.equal(rows.find((r) => r.key === "total").strong, true, "the total that leaves is read like the receive row");
  assert.equal(rows.find((r) => r.key === "receive").tip, "On Arbitrum, at the address below. At least 19.59 USDC arrives, or it's refunded to your balance.");
  assert.equal(rows.find((r) => r.key === "fee").tip, "If it's refunded, 0.32 USDC is kept.");
  assert.equal(rows.find((r) => r.key === "activation").tip, "The trading network charges 1 USDC to activate a new address. Every private withdrawal uses a new one-time address, so every one pays it.");
  assert.ok(!rows.some((r) => ["min", "refund", "screen"].includes(r.key)), "no 'At least' or 'Refund fee' row, and a passed check is not a row");
  /* At least is a floor: 19.596753 never prints as 19.60. */
  assert.equal(V.privateAmountText("19.596753", { floor: true }), "19.59 USDC");
  /* An activated destination and source: no activation row at all. */
  const pf0 = await preflightOf(q, { fee: "0.0" });
  const rows0 = V.privateWithdrawRows({ quote: q, review: W.privateWithdrawReview({ quote: q, preflight: pf0, now: q.quotedAt + 2000 }), preflight: pf0 });
  assert.equal(rows0.some((r) => r.key === "activation" || r.key === "total"), false, "only when it applies");
  /* Unreadable: the dash, never 0, and Confirm is held. */
  const pfU = await preflightOf(q, { noFee: true });
  assert.equal(pfU.code, "fee-unknown");
  const rvU = W.privateWithdrawReview({ quote: q, preflight: pfU, now: q.quotedAt + 2000 });
  assert.equal(rvU.confirmable, false);
  const rowsU = V.privateWithdrawRows({ quote: q, review: rvU, preflight: pfU });
  assert.equal(rowsU.find((r) => r.key === "activation").value, "—");
  assert.equal(rowsU.find((r) => r.key === "total").value, "—", "never a total without its fee");
  /* The one-time address on a sanctions list: "Refused", and held. */
  const pfS = await preflightOf(q, { sanctioned: true });
  assert.equal(V.privateWithdrawRows({ quote: q, review: W.privateWithdrawReview({ quote: q, preflight: pfS, now: q.quotedAt + 2000 }), preflight: pfS }).find((r) => r.key === "screen").value, "Refused");
  assert.equal(W.privateWithdrawReview({ quote: q, preflight: pfS, now: q.quotedAt + 2000 }).confirmable, false);
  assert.equal(V.screeningText(null), "—");
  for (const r of rows) assert.doesNotMatch(`${r.label} ${r.tip || ""}`, PROVIDERS, r.label);
  /* The dry quote's box: the 1.00 USDC every private withdrawal pays (no "up to"), and when it arrives. */
  assert.deepEqual(V.privateWithdrawDryRows(null).map((r) => [r.label, r.value]), [["You receive", "—"], ["Fee", "—"], ["Activation fee", "—"], ["Arrives in", "—"]]);
  assert.deepEqual(V.privateWithdrawDryRows(q).map((r) => r.value), ["≈ 19.79 USDC", "0.21 USDC", "1.00 USDC", "~34s"]);
  assert.match(V.privateWithdrawDryRows(q)[0].tip, /^On Arbitrum, at the address you entered\. At least 19\.59 USDC arrives/);
  /* The panel draws a strong row's LABEL as the Deposit does (medium, in the ink). */
  const panel = code("src/wallet/WithdrawPanel.jsx");
  assert.match(panel, /<dt className=\{strong \? "font-medium text-foreground" : "text-muted-foreground"\}>/);
  assert.match(panel, /<Row key=\{r\.key\} strong=\{r\.strong\}/);
});

test("V6) 🔴 the activation fee has to stay behind: Confirm held, the most that can go offered as the customer's own tap", async () => {
  const q = realQuoteFor();
  const pf = await preflightOf(q, { withdrawableUsdc: 20.5 });
  assert.equal(pf.ok, false);
  assert.equal(pf.code, "insufficient");
  assert.equal(W.privateWithdrawReview({ quote: q, preflight: pf, now: q.quotedAt + 2000 }).confirmable, false);
  const act = V.privateWithdrawActivation({ preflight: pf, withdrawableUsdc: 20.5 });
  assert.equal(act.short, true);
  assert.equal(act.applies, true);
  assert.equal(act.maxUsdc, 19.5);
  assert.equal(act.text, "The 1.00 USDC activation fee has to stay in your balance.", "the button under it carries the smaller figure");
  const exact = await preflightOf(q, { withdrawableUsdc: 21 });
  assert.equal(exact.ok, true, "20 + 1 = 21 exactly fits");
  assert.equal(V.privateWithdrawActivation({ preflight: exact, withdrawableUsdc: 21 }).short, false);
  assert.equal(V.privateWithdrawActivation({ preflight: await preflightOf(q, { withdrawableUsdc: 5.5 }), withdrawableUsdc: 5.5 }).maxUsdc, null, "nothing below the minimum is offered");
  const panel = code("src/wallet/WithdrawPanel.jsx");
  assert.match(panel, /onClick=\{\(\) => p\.edit\(act\.maxUsdc\.toFixed\(2\)\)\}/, "the smaller amount is a tap back to the form, never sent by itself");
  /* The review's money warnings are boxed (the Deposit's MoneyWarning), never loose small text. */
  assert.match(panel, /<MoneyWarning role="alert">\{act\.text\}<\/MoneyWarning>/);
  assert.match(panel, /<MoneyWarning>Send only to an address that accepts \{rs\.quote\.route\.token\} on \{rs\.quote\.route\.chainName\}\. Other networks can be lost\.<\/MoneyWarning>/);
  assert.match(panel, /\{rs\.requoted \? <MoneyWarning>New price: the last one expired\. Check the figures, then confirm\.<\/MoneyWarning> : null\}/);
  assert.match(panel, /const canPress = !!rv && !busy && !act\.short && !refused/);
});

test("V7) 🔴 the ONE window's words: the rows' own figures, no address, no provider, armed only for a SendAsset", async () => {
  const q = realQuoteFor();
  const pf = await preflightOf(q);
  const rv = W.privateWithdrawReview({ quote: q, preflight: pf, now: q.quotedAt + 2000 });
  const words = SC.privateWithdrawSignWords({ quote: q, review: rv });
  assert.equal(words.method, "eth_signTypedData_v4");
  assert.equal(words.primaryType, "HyperliquidTransaction:SendAsset");
  assert.equal(words.title, "Withdraw", "a keyless quote is not called private");
  assert.equal(words.buttonText, "Confirm the withdrawal");
  assert.equal(words.description, "20.00 USDC out. You receive ≈ 19.79 USDC on Arbitrum. A 1.00 USDC activation fee also leaves your balance.");
  const rows = Object.fromEntries(V.privateWithdrawRows({ quote: q, review: rv, preflight: pf }).map((r) => [r.key, r.value]));
  for (const k of ["send", "receive", "activation"]) assert.ok(words.description.includes(rows[k]), `the window prints the row's ${k} exactly`);
  assert.equal(V.privateAmountText, SC.privateAmountText, "one formatter for the screen and the window");
  const all = `${words.title} ${words.description} ${words.buttonText}`;
  assert.doesNotMatch(all, /0x[0-9a-f]{4}/i, "no address: the payload below names the one-time address, not the recipient");
  assert.doesNotMatch(all, PROVIDERS);
  assert.equal(SC.privateWithdrawSignWords({ quote: { ...q, private: true }, review: rv }).title, "Private withdraw", "Private only for a partner-key quote");
  const pf0 = await preflightOf(q, { fee: "0.0" });
  assert.doesNotMatch(SC.privateWithdrawSignWords({ quote: q, review: W.privateWithdrawReview({ quote: q, preflight: pf0, now: q.quotedAt + 2000 }) }).description, /activation/);
  assert.equal(SC.privateWithdrawSignWords({}).description, "This is the withdrawal itself.", "no figure, no sentence about one");
  /* It survives the window's filter, and it is taken ONLY by a SendAsset (it fails closed for any other). */
  assert.ok(SW.readSignWords(words));
  SW.armSignWords(words);
  assert.equal(SW.takeSignWords({ method: "eth_signTypedData_v4", primaryType: "HyperliquidTransaction:Withdraw" }), null);
  SW.armSignWords(words);
  assert.equal(SW.takeSignWords({ method: "eth_signTypedData_v4", primaryType: "HyperliquidTransaction:SendAsset" }).title, "Withdraw");
  assert.equal(SW.peekSignWords(), null, "single use");
});

test("V8) every refusal in plain words, no provider and no workaround; Normal is only ever a button; amount refusals sit under the amount", () => {
  const E = (code, message = "", detail = null) => ({ code, message, detail });
  const codes = [
    "private-mode-off", "sanctioned", "screen-unavailable", "below-min", "over-tx-cap", "over-day-cap", "confidentiality-mismatch",
    "rate-limited", "testnet-off", "bad-user", "intents-error", "network", "unsafe-quote", "bad-response", "insufficient", "unsettled",
    "used", "check-unknown", "fee-unknown", "balance-unknown", "fee-high", "bad-deposit-address", "stale-quote", "recheck",
    "user_rejected", "wallet_timeout", "hl_error", "not_confirmed", "made-up",
  ];
  for (const c of codes) {
    const t = V.privateWithdrawErrorText(E(c, c === "user_rejected" ? "You declined the signature in your wallet. Nothing was sent." : ""));
    assert.ok(typeof t === "string" && t.length > 10, c);
    assert.doesNotMatch(t, PROVIDERS, c);
    assert.doesNotMatch(t, /\bVPN\b|another country|use a different wallet|workaround/i, c);
  }
  assert.match(V.privateWithdrawErrorText(E("sanctioned")), /sanctions or stolen-funds list/);
  assert.deepEqual(V.privateWithdrawErrorActions(E("sanctioned")), [], "no button around a sanctions refusal");
  assert.deepEqual(V.privateWithdrawErrorActions(E("unsettled")), [], "an unsettled one settles by itself");
  assert.deepEqual(V.privateWithdrawErrorActions(E("private-mode-off")), ["normal", "retry"]);
  const paused = E("intents-error", "Quoting for this pair is not available");
  assert.deepEqual(V.privateWithdrawErrorActions(paused), ["normal", "retry"]);
  assert.equal(V.privateWithdrawErrorText(paused, { chainName: "Base" }), "Private withdrawals to Base are paused right now. Try again later, or use Normal withdraw.");
  assert.deepEqual(V.privateWithdrawErrorActions(E("network")), ["retry", "normal"]);
  assert.match(V.privateWithdrawErrorText(E("over-day-cap", "", { max: 1000, left: 15 })), /up to 15\.00 USDC more/);
  assert.match(V.privateWithdrawErrorText(E("hl_error", "Insufficient USDC balance for token transfer gas")), /^Leave 1\.00 USDC in your balance for the activation fee, then try again\. Nothing was sent\.$/);
  const lost = V.privateWithdrawErrorText(E("not_confirmed", "x"));
  assert.match(lost, /NOT sent twice/);
  assert.doesNotMatch(lost, /Nothing was sent/, "a lost reply is never 'nothing sent'");
  for (const c of ["bad-amount", "below-min", "over-tx-cap", "over-day-cap"]) assert.equal(V.privateWithdrawErrorPlace(E(c)), "amount", c);
  for (const c of ["sanctioned", "network", "private-mode-off", "unsettled"]) assert.equal(V.privateWithdrawErrorPlace(E(c)), "box", c);
});

test("V9) 🔴 the result: a lost reply is \"Not confirmed\" (never nothing sent); a reading about another withdrawal is never arrived; incomplete is refunded", () => {
  const r = (o) => V.privateWithdrawResultView({ chainName: "Base", ...o });
  const unknown = r({ phase: "unknown", leavesUsdc: 21 });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.title, "Not confirmed");
  /* 🔴 The figure to check is what LEFT the balance (20.00 + the 1.00 activation), never the 19.79 that arrives. */
  assert.equal(unknown.note, "It may have gone through. Don't withdraw again yet: if your balance dropped by 21.00 USDC, it went. We keep checking.");
  assert.doesNotMatch(unknown.note, /nothing (was )?sent|failed|sheet/i);
  assert.doesNotMatch(r({ phase: "unknown" }).note, /\d/, "no figure is invented when none is known");
  const panel = code("src/wallet/WithdrawPanel.jsx");
  assert.match(panel, /const leavesUsdc = journalLeavesUsdc\(\{ amountRaw: qq\.amountRaw, accountFeeUsdc: rs\.preflight \? rs\.preflight\.accountFeeUsdc : null \}\);/);
  assert.match(panel, /privateWithdrawResultView\(\{[^}]*leavesUsdc \}\)/);
  assert.equal(r({ phase: "unknown", snapshot: { status: "waiting", mismatch: false } }).state, "unknown", "waiting proves nothing");
  assert.notEqual(r({ phase: "sent", snapshot: { status: "arrived", mismatch: true } }).state, "arrived", "a mismatch is never arrived");
  assert.equal(r({ phase: "sent", snapshot: { status: "arrived", mismatch: false } }).title, "Arrived", "the line under it names the chain once");
  /* Arrived prints the delivered figure, exact; the quote's ≈ only until then. */
  assert.match(panel, /const got = done && p\.snapshot && !p\.snapshot\.mismatch && p\.snapshot\.receive != null/);
  assert.match(panel, /privateAmountText\(got != null \? got : qq\.receive, \{ approx: got == null \}\)/);
  const inc = r({ phase: "sent", snapshot: { status: "incomplete", mismatch: false }, refundStartsAt: Date.UTC(2026, 9, 15, 8) });
  assert.equal(inc.title, "Less than expected");
  assert.match(inc.note, /refunded to your balance after/);
  assert.equal(r({ phase: "sent", journalState: "refunded" }).title, "Refunded");
  assert.equal(r({ phase: "unknown", journalState: "not-sent" }).title, "Not sent", "only reads settle it as not sent");
  assert.equal(r({ phase: "unknown", journalState: "sent" }).title, "On its way", "the ledger's proof that it left");
  assert.equal(r({ phase: "sent" }).title, "On its way");
});

test("V10) 🔴 an unsettled private withdrawal blocks the next one, in plain words", () => {
  const t = REAL_AT;
  const journal = J.createWithdrawJournal({ user: PY_ADDRESS, storage: memStorage(), now: () => t });
  assert.equal(journal.claim({ depositAddress: REAL_DEPOSIT, routeId: "arbitrum-usdc", recipient: REAL_TO, amountRaw: "2000000000", accountFeeUsdc: 1, deadlineAt: t + 3600e3, now: t }).ok, true);
  journal.settle(REAL_DEPOSIT, "unknown", { now: t });
  const open = journal.unsettled(t);
  assert.equal(open.length, 1);
  assert.equal(journal.canStart({ amountRaw: "500000000", now: t }).code, "unsettled");
  /* 🔴 The figure is what LEFT the balance: 20.00 + the 1.00 activation the preflight read (taken on top). */
  assert.equal(V.journalLeavesUsdc(open[0]), 21);
  const text = V.unsettledBlockText(open);
  assert.match(text, /^Your private withdrawal of 21\.00 USDC \(.+\) isn't confirmed yet\. If your balance dropped by 21\.00 USDC, it went\. A new private withdrawal waits until we know\.$/);
  assert.doesNotMatch(text, /0x/i, "the journal keeps no recipient, and the words name none");
  assert.doesNotMatch(text, /sheet/i, "no internal words");
  /* On Normal: the risk there is sending the same money again another way. */
  assert.match(V.unsettledBlockText(open, { normal: true }), /^A private withdrawal of 21\.00 USDC \(.+\) isn't confirmed yet\. If your balance dropped by 21\.00 USDC, it went: don't send it again\.$/);
  assert.equal(V.journalLeavesUsdc({ amountRaw: "2000000000", accountFeeUsdc: null }), 20, "no fee read: the amount alone");
  assert.equal(V.unsettledBlockText([]), null);
  assert.equal(V.journalStateText("unknown"), "Not confirmed yet");
  assert.equal(V.journalAmountText(open[0]), "20.00 USDC");
});

test("V11) the day cap: two decimals, the reset in the reader's own time; this browser's 24-hour cap carries its figure", async () => {
  const E = (code, detail = null, message = "") => ({ code, message, detail });
  const now = Date.UTC(2026, 9, 15, 17, 35);
  const reset = V.nextUtcMidnight(now);
  assert.equal(reset, Date.UTC(2026, 9, 16));
  const text = V.privateWithdrawErrorText(E("over-day-cap", { max: 1000, left: 15 }), { now });
  assert.equal(text, `Over today's private limit. You can withdraw up to 15.00 USDC more privately today (resets ${V.shortTimeText(reset)}).`);
  assert.doesNotMatch(text, /UTC/, "the reader's own time, not UTC");
  assert.match(V.privateWithdrawErrorText(E("over-day-cap", { max: 1000, left: 15 })), /\(resets 00:00 UTC\)/, "no clock handed in: the plain UTC words");
  assert.equal(V.privateWithdrawErrorText(E("over-day-cap", { max: 1000, left: 0 }), { now }), `You've reached today's private limit. Try again after ${V.shortTimeText(reset)}.`);
  /* The smaller amount, one tap: what the cap still allows, held to Max (the activation fee behind). */
  assert.deepEqual(V.privateWithdrawAmountFix(E("over-day-cap", { max: 1000, left: 15 }), { withdrawableUsdc: 152.84 }), { usdc: 15, text: "Withdraw 15.00 USDC instead" });
  assert.equal(V.privateWithdrawAmountFix(E("over-day-cap", { max: 1000, left: 15 }), { withdrawableUsdc: 10.5 }).usdc, 9.5, "never more than can leave with the fee behind");
  assert.equal(V.privateWithdrawAmountFix(E("over-day-cap", { max: 1000, left: 3 }), { withdrawableUsdc: 100 }), null, "below the minimum: nothing offered");
  /* This browser's record counts the last 24 hours (withdrawJournal canStart): its figure rides on the refusal. */
  const journal = { user: PY_ADDRESS.toLowerCase(), canStart: () => ({ ok: false, code: "over-day-cap", message: "cap", leftUsdc: "15.5" }) };
  const e = await W.quoteIntentsWithdraw({ user: PY_ADDRESS, recipient: RECIPIENT, route: route("base-usdc"), amountUsdc: "20", dry: false, journal, screen: okScreen, fetchImpl: () => { throw new Error("no quote after a refusal"); } }).catch((x) => x);
  assert.equal(e.code, "over-day-cap");
  assert.deepEqual(e.detail, { left: 15.5, rolling: true });
  assert.equal(V.privateWithdrawErrorText(e), "Over the private limit for the last 24 hours. You can withdraw up to 15.50 USDC more privately now.");
  const panel = code("src/wallet/WithdrawPanel.jsx");
  assert.match(panel, /privateWithdrawErrorText\(e, \{ chainName: route \? route\.chainName : null, now: Date\.now\(\) \}\)/);
  assert.match(panel, /\{amountFix \? <Button variant="secondary" size="sm" className="mt-2" onClick=\{\(\) => p\.setAmountText\(amountFix\.usdc\.toFixed\(2\)\)\}>\{amountFix\.text\}<\/Button> : null\}/);
});

/* ════════════════════════════════════════════════════════════════════════════
   C. THE EXCHANGE CLIENT'S sendIntentsDeposit (fake Hyperliquid, offline wallet)
   ════════════════════════════════════════════════════════════════════════════ */

function fakeWallet(key = PY_KEY) {
  const account = viemAccounts.privateKeyToAccount(key);
  const prompts = [];
  return {
    address: account.address,
    prompts,
    signer: {
      getAddress: async () => account.address,
      provider: { getNetwork: async () => ({ chainId: 42161n }) },
      signTypedData: async (domain, types, message) => {
        prompts.push({ domain, types, message, words: SW.peekSignWords() });
        const primaryType = Object.keys(types)[0];
        return account.signTypedData({ domain, types, primaryType, message });
      },
    },
  };
}
function fakeHl({ reply = { status: "ok", response: { type: "default" } }, status = 200 } = {}) {
  const posts = [];
  return {
    posts,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (/\/exchange$/.test(url)) {
        posts.push(body);
        if (reply === "lost") throw new Error("network down");
        return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
      }
      return new Response(JSON.stringify({ time: REAL_AT, assetPositions: [], marginSummary: {}, crossMarginSummary: {}, withdrawable: "100" }), { status: 200 });
    },
  };
}
function memAgents() {
  return {
    status: () => ({ state: "none", address: null, validUntil: null, reason: null, persisted: false }),
    account: () => null, prepare: () => ({ address: `0x${"7".repeat(40)}`, agentName: "flowflow", validUntil: REAL_AT, persisted: false }),
    markApproved: () => true, discardPending: () => {}, markRejected: () => {}, clear: () => {},
    subscribe: () => () => {}, version: () => 1,
  };
}
const AT = REAL_AT + 3000;
/* Two clocks, as in a browser: `clock` is the device's (it stamped the quote and the preflight), `serverNow` is
   Hyperliquid-corrected time (the nonce's). */
function traderFor({ hl = fakeHl(), wallet = fakeWallet(), silent = null, serverNow = AT, clock = AT, nonce = null } = {}) {
  const nonces = { next: async () => (nonce == null ? serverNow : nonce), serverNow: () => serverNow, noteServerTime: () => {} };
  const t = C.createHlTrader({
    master: wallet.address, signer: wallet.signer, walletType: "privy", chainId: 42161, market: () => null,
    profile: N.hlNetworkProfile("mainnet"), silentSigner: silent, deps: { fetchImpl: hl.fetchImpl, agents: memAgents(), nonces, now: () => clock },
  });
  return { t, hl, wallet };
}

test("C1) 🔴 sendIntentsDeposit: ONE visible prompt in the user's own wallet, ONE post, to the verified one-time address, the exact amount — the no-window signer never asked", async () => {
  const wallet = fakeWallet();
  const silentCalls = [];
  const ctx = traderFor({ wallet, silent: () => ({ address: wallet.address, signTypedData: (td) => { silentCalls.push(td); return `0x${"11".repeat(65)}`; } }) });
  const q = realQuoteFor(wallet.address);
  const pf = await preflightOf(q);
  const r = await ctx.t.sendIntentsDeposit({ quote: q, preflight: pf, amountUsdc: "20" });
  assert.deepEqual(r, { ok: true, amountUsdc: "20", nonce: AT });
  assert.equal(wallet.prompts.length, 1, "exactly one prompt");
  assert.equal(silentCalls.length, 0, "the no-window signer never moves money");
  assert.equal(ctx.hl.posts.length, 1, "posted once");
  assert.deepEqual(ctx.hl.posts[0].action, {
    type: "sendAsset", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet",
    destination: REAL_DEPOSIT.toLowerCase(), sourceDex: "", destinationDex: "",
    token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "20", fromSubAccount: "", nonce: AT,
  });
  assert.equal(ctx.hl.posts[0].nonce, AT);
  assert.notEqual(ctx.hl.posts[0].action.destination, REAL_TO.toLowerCase(), "never the recipient directly");
  assert.equal(Object.keys(wallet.prompts[0].types)[0], "HyperliquidTransaction:SendAsset");
  assert.equal(wallet.prompts[0].message.destination, REAL_DEPOSIT.toLowerCase(), "what the window shows is what is posted");
  assert.equal(wallet.prompts[0].domain.chainId, 42161, "a Privy wallet signs for Arbitrum, where it is parked");
});

test("C2) 🔴 a LOST reply is not_confirmed (lost, retry:false), the executor records it UNKNOWN — never \"nothing sent\" — and it is never sent again", async () => {
  for (const spec of [{ reply: "lost" }, { reply: "<html>bad gateway</html>", status: 502 }, { reply: "not json", status: 200 }]) {
    const wallet = fakeWallet();
    const ctx = traderFor({ wallet, hl: fakeHl(spec) });
    const q = realQuoteFor(wallet.address);
    const pf = await preflightOf(q);
    const direct = await ctx.t.sendIntentsDeposit({ quote: q, preflight: pf, amountUsdc: "20" });
    assert.equal(direct.ok, false);
    if (direct.lost) {
      assert.deepEqual([direct.code, direct.lost, direct.retry], ["not_confirmed", true, false]);
      assert.match(direct.message, /NOT sent twice/);
    } else {
      assert.equal(direct.code, "bad_response", "a 2xx nobody can read");
    }
    /* Through the executor, with a journal: one claim, one call, unknown, blocks, never sent again. */
    const wallet2 = fakeWallet();
    const ctx2 = traderFor({ wallet: wallet2, hl: fakeHl(spec) });
    const q2 = realQuoteFor(wallet2.address);
    const pf2 = await preflightOf(q2);
    const journal = J.createWithdrawJournal({ user: q2.user, storage: memStorage(), now: () => AT });
    const words = SC.privateWithdrawSignWords({ quote: q2, review: W.privateWithdrawReview({ quote: q2, preflight: pf2, now: AT }) });
    const r = await W.executeIntentsWithdraw({ quote: q2, preflight: pf2, journal, sendIntentsDeposit: (o) => ctx2.t.sendIntentsDeposit(o), amountUsdc: "20", signWords: words, now: () => AT });
    assert.equal(r.ok, false);
    assert.equal(r.notConfirmed, true);
    assert.equal(r.nothingSent, undefined, "never 'nothing sent' over a reply nobody saw");
    assert.match(V.privateWithdrawErrorText(r), /NOT sent twice/);
    assert.equal(journal.get(REAL_DEPOSIT).state, "unknown");
    assert.equal(journal.canStart({ amountRaw: "500000000", now: AT }).code, "unsettled", "the next one waits");
    const again = await W.executeIntentsWithdraw({ quote: q2, preflight: pf2, journal, sendIntentsDeposit: (o) => ctx2.t.sendIntentsDeposit(o), now: () => AT });
    assert.equal(again.code, "used");
    assert.equal(ctx2.hl.posts.length, 1, "one post, ever, for this address");
    assert.equal(wallet2.prompts.length, 1);
    assert.equal(wallet2.prompts[0].words.primaryType, "HyperliquidTransaction:SendAsset", "the words were armed for that one window");
    assert.equal(SW.peekSignWords(), null, "and disarmed after");
  }
});

test("C3) 🔴 a refused step never reaches the wallet: stale quote, another wallet's quote, another amount, a copied preflight", async () => {
  const wallet = fakeWallet();
  const q = realQuoteFor(wallet.address);
  const pf = await preflightOf(q);
  const cases = [
    [{ clock: q.quotedAt + W.WITHDRAW_QUOTE_TTL_MS + 1 }, { quote: q, preflight: pf, amountUsdc: "20" }, "quote_expired"],
    [{ nonce: AT - 3 * 24 * 3600e3 }, { quote: q, preflight: pf, amountUsdc: "20" }, "quote_expired"],
    [{}, { quote: realQuoteFor("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"), preflight: pf, amountUsdc: "20" }, "wallet_mismatch"],
    [{}, { quote: q, preflight: pf, amountUsdc: "20.5" }, "amount_mismatch"],
    [{}, { quote: q, preflight: { ...pf }, amountUsdc: "20" }, "recheck"],
    [{}, { quote: { ...q }, preflight: pf, amountUsdc: "20" }, "bad_quote"],
  ];
  for (const [o, args, codeWant] of cases) {
    const ctx = traderFor({ wallet, ...o });
    const before = wallet.prompts.length;
    const r = await ctx.t.sendIntentsDeposit(args);
    assert.equal(r.ok, false, codeWant);
    assert.equal(r.code, codeWant);
    assert.equal(wallet.prompts.length, before, `${codeWant}: the wallet was never asked`);
    assert.equal(ctx.hl.posts.length, 0, `${codeWant}: nothing posted`);
    assert.ok(W.WITHDRAW_NOT_SENT_CODES.includes(codeWant), `${codeWant} proves nothing was sent`);
  }
  /* Unsupported wallet: refused before anything. */
  const wc = C.createHlTrader({ master: wallet.address, signer: wallet.signer, walletType: "walletconnect", chainId: 42161, market: () => null, profile: N.hlNetworkProfile("mainnet"), deps: { now: () => AT, fetchImpl: fakeHl().fetchImpl, agents: memAgents(), nonces: { next: async () => AT, serverNow: () => AT, noteServerTime() {} } } });
  const r = await wc.sendIntentsDeposit({ quote: q, preflight: pf, amountUsdc: "20" });
  assert.equal(r.ok, false);
});

test("C4) Hyperliquid's own refusal (the activation can't stay behind) is passed through: the executor records it not-sent and says so in plain words", async () => {
  const wallet = fakeWallet();
  const ctx = traderFor({ wallet, hl: fakeHl({ reply: { status: "err", response: "Insufficient USDC balance for token transfer gas" } }) });
  const q = realQuoteFor(wallet.address);
  const pf = await preflightOf(q);
  const journal = J.createWithdrawJournal({ user: q.user, storage: memStorage(), now: () => AT });
  const r = await W.executeIntentsWithdraw({ quote: q, preflight: pf, journal, sendIntentsDeposit: (o) => ctx.t.sendIntentsDeposit(o), amountUsdc: "20", now: () => AT });
  assert.equal(r.code, "hl_error");
  assert.equal(r.nothingSent, true);
  assert.equal(journal.get(REAL_DEPOSIT).state, "not-sent");
  assert.equal(V.privateWithdrawErrorText(r), "Leave 1.00 USDC in your balance for the activation fee, then try again. Nothing was sent.");
  assert.equal(ctx.hl.posts.length, 1);
});

test("C6) 🔴 two clocks: the quote and preflight are judged on the browser clock that stamped them, the nonce on Hyperliquid's — a device a minute off still sends, once", async () => {
  for (const skew of [0, 5000, -5000, 65000, -65000, 10 * 60000]) {
    const wallet = fakeWallet();
    /* Confirm pressed 8 s after the quote, on the device's clock; Hyperliquid's clock is `skew` away from it. */
    const ctx = traderFor({ wallet, clock: AT + 5000, serverNow: AT + 5000 + skew });
    const q = realQuoteFor(wallet.address);
    const pf = await preflightOf(q);
    const r = await ctx.t.sendIntentsDeposit({ quote: q, preflight: pf, amountUsdc: "20" });
    assert.equal(r.ok, true, `skew ${skew / 1000}s: ${r.code} ${r.message}`);
    assert.equal(wallet.prompts.length, 1, `skew ${skew / 1000}s: one window`);
    assert.equal(ctx.hl.posts[0].nonce, AT + 5000 + skew, "the nonce is Hyperliquid's time");
  }
  /* The gate itself: freshness on `now`, the nonce window on `serverNow`. */
  const S = await imp("src/lib/hyperliquid/exchange/intentsOut.js");
  const q = realQuoteFor(PY_ADDRESS);
  const pf = await preflightOf(q);
  const base = { quote: q, preflight: pf, profile: N.hlNetworkProfile("mainnet"), signatureChainId: "0xa4b1", master: PY_ADDRESS, amountUsdc: "20" };
  const t = q.quotedAt + 8000;
  assert.equal(S.buildIntentsSendAsset({ ...base, nonce: t + 65000, now: t, serverNow: t + 65000 }).ok, true, "Hyperliquid a minute ahead");
  assert.equal(S.buildIntentsSendAsset({ ...base, nonce: t - 65000, now: t, serverNow: t - 65000 }).ok, true, "Hyperliquid a minute behind");
  assert.equal(S.buildIntentsSendAsset({ ...base, nonce: t, now: q.quotedAt + W.WITHDRAW_QUOTE_TTL_MS, serverNow: t }).code, "quote_expired", "a minute on the browser's clock is still a minute");
  assert.equal(S.buildIntentsSendAsset({ ...base, nonce: t - 3 * 24 * 3600e3, now: t, serverNow: t }).code, "quote_expired", "the nonce window is Hyperliquid's");
  assert.match(code("src/lib/hyperliquid/exchange/client.js"), /buildIntentsSendAsset\(\{\s*quote, preflight, profile, signatureChainId: g\.sigChain, nonce, master: masterLc, amountUsdc, now: now\(\), serverNow: nonces\.serverNow\(\),\s*\}\)/);
});

test("C5) the backend seam exposes sendIntentsDeposit like sendRelayDeposit: the \"withdraw\" lock live; refused on mock, view-only and with no wallet", async () => {
  assert.ok(PB.PERP_BACKEND_ACTIONS.includes("sendIntentsDeposit"));
  const seen = [];
  const live = PB.createLiveActions({ trader: { sendIntentsDeposit: async (a) => { seen.push(a); return { ok: true }; } }, locks: new Set() });
  const args = { quote: { tag: 1 }, preflight: { tag: 2 }, amountUsdc: "20" };
  assert.deepEqual(await live.sendIntentsDeposit(args), { ok: true });
  assert.equal(seen[0], args, "the arguments as handed in");
  const locks = new Set(["withdraw"]);
  const busy = PB.createLiveActions({ trader: { sendIntentsDeposit: async () => ({ ok: true }) }, locks });
  assert.equal((await busy.sendIntentsDeposit(args)).code, "busy", "one money step out of the account at a time");
  assert.equal((await PB.createViewOnlyActions({ label: "View" }).sendIntentsDeposit(args)).code, "view_only");
  assert.equal((await PB.createLiveActions({ trader: null }).sendIntentsDeposit(args)).code, "no_wallet");
  const src = code("src/perp/live/perpBackend.js");
  assert.match(src, /sendIntentsDeposit: \(args\) => run\("withdraw", undefined, \(\) => trader\.sendIntentsDeposit\(args\)\)/);
  assert.match(src, /sendIntentsDeposit: \(\) => Promise\.resolve\(fail\("mock_withdraw"/);
});

/* ════════════════════════════════════════════════════════════════════════════
   H. THE SHEET'S HOOK (a fake React; the real verifier, preflight, executor and journal)
   ════════════════════════════════════════════════════════════════════════════ */

const PROBE = Object.freeze({ status: "ready", enabled: true, confidential: false, confidentiality: "public", limits: Object.freeze({ depositMinUsdc: 10, withdrawMinUsdc: 5, maxTxUsdc: 500, maxDayUsdc: 1000 }) });
const okScreen = async () => ({ ok: true, code: null, message: null, results: [] });
let addressSeq = 0;
const nextAddress = () => viem.getAddress(`0x${(0xabcdef000000n + BigInt(++addressSeq)).toString(16).padStart(40, "0")}`);

/* The quote service, as it answered live: the echo of what was asked; a real ask gets a NEW one-time address. */
const answerFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const inUnits = BigInt(body.amount);
  const out = inUnits / 100n - 205_300n;
  const deadline = new Date(Math.floor((Date.now() + 72 * 3600e3) / 1000) * 1000).toISOString();
  const quote = { amountIn: body.amount, minAmountIn: body.amount, amountOut: out.toString(), minAmountOut: (out - inUnits / 10_000n).toString(), timeEstimate: 37, refundFee: "31530000", withdrawFee: "5300" };
  if (body.dry === false) Object.assign(quote, { deadline, timeWhenInactive: deadline, depositAddress: nextAddress() });
  return { ok: true, status: 201, json: async () => ({ quote, quoteRequest: { ...body, depositMode: "SIMPLE", appFees: [] }, timestamp: new Date().toISOString(), correlationId: "test" }) };
};

function hookDeps({ storage = memStorage(), clock = { skew: 0 } } = {}) {
  const calls = { quote: [], preflight: [], execute: [], track: [], settle: [] };
  const deps = Object.freeze({
    readProbe: async () => PROBE,
    quote: (o) => { calls.quote.push(o); return W.quoteIntentsWithdraw({ ...o, screen: okScreen, fetchImpl: answerFetch, quoteUrl: "/test" }); },
    preflight: (o) => { calls.preflight.push(o); return W.readWithdrawPreflight({ ...o, info: fakeInfo() }); },
    execute: (o) => { calls.execute.push(o); return W.executeIntentsWithdraw(o); },
    track: (o) => { calls.track.push(o); return { stop() {}, refresh() {}, snapshot: () => null }; },
    settle: async (o) => { calls.settle.push(o); return null; },
    journal: (user, o = {}) => J.createWithdrawJournal({ user, storage, ...o }),
    now: () => Date.now() + clock.skew,
  });
  return { deps, calls, storage, clock };
}

function sender(answer = { ok: true, amountUsdc: "20", nonce: 1 }) {
  const calls = [];
  const fn = async (args) => { calls.push({ args, words: SW.peekSignWords() }); return typeof answer === "function" ? answer(args) : answer; };
  fn.calls = calls;
  return fn;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(h, ms = 20) { for (let i = 0; i < 6; i++) { await wait(ms); h.flush(); } return h.value; }

/* Every mounted sheet is unmounted after its test, pass or fail (its timers and intervals with it). */
const mounted = [];
afterEach(() => { while (mounted.length) { try { mounted.pop().unmount(); } catch { /* already gone */ } } });

function mountSheet({ deps, send, initial = { routeId: "base-usdc", amountText: "20", toText: RECIPIENT }, withdrawableUsdc = 100 }) {
  const h = React.mount(() => {
    const ledger = H.usePrivateWithdrawLedger({ user: PY_ADDRESS, deps, limits: PROBE.limits });
    const p = H.usePrivateWithdraw({ user: PY_ADDRESS, walletType: "privy", probe: PROBE, active: true, withdrawableUsdc, sendIntentsDeposit: send, ledger, deps, initial });
    return { ledger, p };
  });
  mounted.push(h);
  h.render();
  h.flush();
  return h;
}

test("H0) the toggle and Edit are free on the form, and locked once a withdrawal is signed or followed (sent / not confirmed)", async () => {
  const { deps } = hookDeps();
  const h = mountSheet({ deps, send: sender() });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  const v = await settle(h);
  assert.equal(v.p.locked, false, "the form: the customer may switch");
  const hook = code("src/perp/withdraw/usePrivateWithdraw.js");
  assert.match(hook, /const locked = rev\.status === "loading" \|\| send\.phase === "signing" \|\| send\.phase === "refreshing" \|\| send\.phase === "sent" \|\| send\.phase === "unknown";/);
  h.unmount();
});

test("H1) 🔴 typing asks only DRY quotes; the REAL one (a one-time address) is asked only on the customer's press, with the journal, then the preflight", async () => {
  const { deps, calls } = hookDeps();
  const send = sender();
  const h = mountSheet({ deps, send });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  let v = await settle(h);
  assert.equal(calls.quote.length, 1);
  assert.equal(calls.quote[0].dry, true);
  assert.equal(calls.quote[0].recipient, RECIPIENT, "the typed address, exactly");
  assert.equal(calls.quote[0].route, route("base-usdc"));
  assert.equal(v.p.quote.status, "ready", v.p.quote.error && v.p.quote.error.message);
  assert.equal(v.p.canReview, true);
  await wait(300);
  h.flush();
  assert.equal(calls.quote.filter((c) => c.dry === false).length, 0, "no real quote before the press");
  await v.p.review();
  v = await settle(h);
  const real = calls.quote.filter((c) => c.dry === false);
  assert.equal(real.length, 1);
  assert.equal(real[0].journal, v.ledger.journal, "the journal (day cap, nothing unsettled) is read first");
  assert.equal(calls.preflight.length, 1);
  assert.equal(calls.preflight[0].withdrawableUsdc, 100, "the balance the screen shows");
  assert.equal(v.p.stage, "review");
  assert.equal(v.p.reviewView.confirmable, true);
  assert.equal(calls.execute.length, 0, "nothing signed by a review");
  assert.equal(send.calls.length, 0);
  h.unmount();
});

test("H2) 🔴 Confirm: ONE execute with the backend's sendIntentsDeposit and the one window's words; then the follow-up", async () => {
  const { deps, calls } = hookDeps();
  const send = sender();
  const h = mountSheet({ deps, send });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  let v = await settle(h);
  await v.p.review();
  v = await settle(h);
  const quote = v.p.reviewState.quote;
  await v.p.confirm();
  v = await settle(h);
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].sendIntentsDeposit, send, "the backend's one visible signature, nothing else");
  assert.equal(calls.execute[0].amountUsdc, "20", "what the customer typed, checked again by the gate");
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].args.quote, quote, "the reviewed quote itself");
  assert.equal(send.calls[0].words.primaryType, "HyperliquidTransaction:SendAsset");
  assert.match(send.calls[0].words.description, /^20\.00 USDC out\. You receive ≈ 19\.79 USDC on Base\. A 1\.00 USDC activation fee also leaves your balance\.$/);
  assert.equal(SW.peekSignWords(), null);
  assert.equal(v.p.stage, "result");
  assert.equal(v.p.send.phase, "sent");
  assert.equal(v.p.locked, true, "H7: the toggle holds still while it is followed (a tap to Normal would drop the follow-up)");
  assert.equal(calls.track.length, 1);
  assert.equal(calls.track[0].depositAddress, quote.depositAddress);
  assert.equal(calls.track[0].expect.recipient, RECIPIENT, "the follow-up holds the answer to the typed address");
  assert.equal(v.ledger.journal.get(quote.depositAddress).state, "sent");
  await v.p.confirm();
  h.flush();
  assert.equal(send.calls.length, 1, "a second press after sent signs nothing");
  h.unmount();
});

test("H3) 🔴 a LOST reply: Not confirmed, never offered again; the next private withdrawal is blocked (no price, no review) until reads settle it", async () => {
  const storage = memStorage();
  const { deps, calls } = hookDeps({ storage });
  const send = sender({ ok: false, code: "not_confirmed", lost: true, retry: false, message: "Your withdrawal wasn't confirmed. Check your Perp balance before trying again: it was NOT sent twice." });
  const h = mountSheet({ deps, send });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  let v = await settle(h);
  await v.p.review();
  v = await settle(h);
  await v.p.confirm();
  v = await settle(h);
  assert.equal(v.p.send.phase, "unknown");
  assert.equal(v.p.stage, "result");
  assert.equal(v.p.locked, true, "H7: locked while a reply nobody saw is followed");
  assert.equal(v.p.send.result.notConfirmed, true);
  assert.equal(calls.track.length, 1, "followed anyway: the status may show it went");
  assert.equal(v.ledger.unsettled.length, 1);
  await v.p.confirm();
  h.flush();
  assert.equal(send.calls.length, 1, "never sent again");
  h.unmount();

  /* The sheet opened again on this browser: the record blocks, is read again, and nothing new is priced. */
  const again = hookDeps({ storage });
  const send2 = sender();
  const h2 = mountSheet({ deps: again.deps, send: send2 });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  const v2 = await settle(h2);
  assert.equal(v2.p.blocked, true);
  assert.equal(v2.p.canReview, false);
  assert.equal(again.calls.quote.length, 0, "nothing new starts while one is unsettled");
  assert.ok(again.calls.settle.length >= 1, "on open, the unsettled record is settled from reads");
  assert.equal(again.calls.settle[0].record.state, "unknown");
  assert.match(V.unsettledBlockText(v2.ledger.unsettled), /isn't confirmed yet/);
  h2.unmount();
});

test("H4) 🔴 a quote past its minute is priced again and SHOWN (a new one-time address) before anything is signed", async () => {
  const { deps, calls, clock } = hookDeps();
  const send = sender();
  const h = mountSheet({ deps, send });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  let v = await settle(h);
  await v.p.review();
  v = await settle(h);
  const first = v.p.reviewState.quote;
  clock.skew = W.WITHDRAW_QUOTE_TTL_MS + 1000;
  await wait(1100); /* the review's clock ticks once a second */
  v = await settle(h);
  assert.equal(v.p.reviewView.why, "stale");
  await v.p.confirm();
  v = await settle(h);
  assert.equal(calls.execute.length, 0, "the press re-priced; it did not sign");
  assert.equal(send.calls.length, 0);
  assert.equal(v.p.reviewState.requoted, true, "the screen says it was priced again");
  assert.notEqual(v.p.reviewState.quote, first);
  assert.notEqual(v.p.reviewState.quote.depositAddress, first.depositAddress, "a new one-time address");
  assert.equal(calls.quote.filter((c) => c.dry === false).length, 2);
  clock.skew = 0;
  await wait(1100);
  v = await settle(h);
  assert.equal(v.p.reviewView.confirmable, true);
  await v.p.confirm();
  v = await settle(h);
  assert.equal(send.calls.length, 1, "the next press signs the figures now on screen");
  assert.equal(send.calls[0].args.quote.depositAddress, v.p.reviewState.quote.depositAddress);
  h.unmount();
});

test("H5) a refusal in the wallet is nothing sent: said on the review; the next press gets a NEW quote first, never the used address", async () => {
  const { deps, calls } = hookDeps();
  let n = 0;
  const send = sender(() => (++n === 1 ? { ok: false, code: "user_rejected", message: "You declined the signature in your wallet. Nothing was sent." } : { ok: true }));
  const h = mountSheet({ deps, send });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  let v = await settle(h);
  await v.p.review();
  v = await settle(h);
  await v.p.confirm();
  v = await settle(h);
  assert.equal(v.p.send.phase, "error");
  assert.equal(v.p.stage, "review", "Private stays, the review stays");
  assert.match(V.privateWithdrawErrorText(v.p.send.result), /declined/);
  await v.p.confirm();
  v = await settle(h);
  assert.equal(send.calls.length, 1, "the press after a refusal re-prices, it does not sign");
  assert.equal(v.p.reviewState.requoted, true);
  await v.p.confirm();
  v = await settle(h);
  assert.equal(send.calls.length, 2);
  assert.notEqual(send.calls[0].args.quote.depositAddress, send.calls[1].args.quote.depositAddress, "never two signatures for one address");
  assert.equal(calls.execute.length, 2);
  h.unmount();
});

test("H6) an amount the form refuses (the activation would not stay behind) never reaches the quote service", async () => {
  const { deps, calls } = hookDeps();
  const h = mountSheet({ deps, send: sender(), withdrawableUsdc: 20.5 });
  await wait(H.DRY_QUOTE_DEBOUNCE_MS + 150);
  const v = await settle(h);
  assert.equal(v.p.amount.error.code, "activation-reserve");
  assert.equal(calls.quote.length, 0);
  assert.equal(v.p.canReview, false);
  h.unmount();
});

/* ════════════════════════════════════════════════════════════════════════════
   R. THE PANEL ITSELF (esbuild; its hooks and UI kit stubbed by name, its words and rules real; no DOM)
   ════════════════════════════════════════════════════════════════════════════ */

let PANEL = null;
async function panel() {
  if (PANEL) return PANEL;
  const entry = "src/wallet/WithdrawPanel.jsx";
  const stubs = autoStubs([entry], {
    keep: [
      "src/perp/withdraw/privateWithdrawView.js", "src/perp/live/perpLiveView.js", "src/lib/format.js", "src/lib/signCopy.js",
      "src/wallet/words.js", "src/lib/relay/withdraw.js",
    ],
    values: { rise: "() => ({ className: '', style: {} })", PRIVATE_WITHDRAW_DEPS: "Object.freeze({})" },
  });
  PANEL = await bundlePanel({ entry, stubs });
  return PANEL;
}
const PROBE_ON = Object.freeze({ status: "ready", enabled: true, confidential: false, confidentiality: "public", limits: PROBE.limits, reread() {} });
const UNSETTLED = Object.freeze({ id: REAL_DEPOSIT.toLowerCase(), state: "unknown", amountRaw: "2000000000", accountFeeUsdc: 1, createdAt: REAL_AT });
const liveBackend = () => ({ mock: false, readOnly: false, address: PY_ADDRESS, connected: true, walletType: "privy", account: { perpBalanceUsdc: null }, sendIntentsDeposit: async () => ({ ok: true }) });
const nameOf = (el) => (el && typeof el.type === "function" ? el.type.name : el && el.type);

test("R1) 🔴 ONE tree on Normal: the unsettled note is NormalWithdraw's prop, so its state (a Relay withdrawal being signed or followed) survives the note coming and going", async () => {
  const M = await panel();
  const ledger = { journal: {}, records: [], unsettled: [], inFlight: [], checking: false, recheck() {}, refresh() {} };
  globalThis.__impl = { usePrivateProbe: () => PROBE_ON, usePrivateWithdrawLedger: () => ledger };
  const backend = liveBackend();
  const h = M.mount(() => M.default({ backend, onBack() {} }));
  const settled = h.render();
  assert.equal(nameOf(settled), "NormalWithdraw", "Normal opens first");
  assert.equal(settled.props.notice, null);
  /* The ledger's 30 s look again finds a record unsettled (or settles one) while Normal is mid-withdrawal… */
  ledger.unsettled = [UNSETTLED];
  const open = h.render();
  /* …and React sees the same component type at the same place: it keeps NormalWithdraw's state (its phase "sending",
     its relaySent follow-up). A wrapper that appears and disappears would unmount it instead. */
  assert.equal(open.type, settled.type, "the same component");
  assert.equal(open.key, settled.key, "at the same key");
  assert.equal(nameOf(open.props.notice), "UnsettledNote");
  assert.equal(open.props.notice.props.normal, true, "in Normal's words");
  ledger.unsettled = [];
  const again = h.render();
  assert.equal(again.type, settled.type, "and back, without a remount");
  assert.equal(again.props.notice, null);
  /* Inside Normal, the note is above step 01 (read before anything is typed or signed). */
  const n = M.mount(() => open.type(open.props)).render();
  const list = allEls(n);
  const noteAt = list.findIndex((e) => nameOf(e) === "UnsettledNote");
  const stepAt = list.findIndex((e) => nameOf(e) === "StepHead" && e.props.n === "01");
  assert.ok(noteAt >= 0 && stepAt > noteAt, `the note comes before step 01 (${noteAt} < ${stepAt})`);
  /* Its words: the figure that left the balance, and "don't send it again". */
  assert.match(V.unsettledBlockText([UNSETTLED], { normal: true }), /21\.00 USDC.+don't send it again\.$/);
  const src = code("src/wallet/WithdrawPanel.jsx");
  assert.doesNotMatch(src, /<div>\{normal\}/, "no wrapper around Normal");
  delete globalThis.__impl;
});

test("R2) 🔴 a locked toggle ignores a change (a keyboard reaches Seg's buttons); an unlocked one switches", async () => {
  const M = await panel();
  const ledger = { journal: {}, records: [], unsettled: [], inFlight: [], checking: false, recheck() {}, refresh() {} };
  globalThis.__impl = { usePrivateProbe: () => PROBE_ON, usePrivateWithdrawLedger: () => ledger };
  const h = M.mount(() => M.default({ backend: liveBackend(), onBack() {} }));
  let el = h.render();
  const segOf = (locked) => allEls(M.mount(() => { const t = el.props.toggle(locked); return t.type(t.props); }).render()).find((e) => e.type && e.type.__stub === "Seg");
  const locked = segOf(true);
  assert.ok(locked, "the switch is drawn");
  locked.props.onChange("private");
  h.flush();
  el = h.render();
  assert.equal(nameOf(el), "NormalWithdraw", "locked: Enter or Space on Private changes nothing");
  const free = segOf(false);
  free.props.onChange("private");
  h.flush();
  el = h.render();
  assert.equal(nameOf(el), "PrivateWithdraw", "unlocked: the customer's own change switches");
  delete globalThis.__impl;
});

test("R3) the blocked form holds still: its reason first (above step 01), the inputs read-only, the chips off, Review drawn and disabled", async () => {
  const M = await panel();
  const ledger = { journal: {}, records: [UNSETTLED], unsettled: [UNSETTLED], inFlight: [UNSETTLED], checking: false, recheck() {}, refresh() {} };
  const noop = () => {};
  const p = {
    ready: true, limits: { depositMinUsdc: 10, withdrawMinUsdc: 5, maxTxUsdc: 500, maxDayUsdc: 1000 }, stage: "form", route: route("base-usdc"), routeId: "base-usdc",
    setRouteId: noop, amountText: "", setAmountText: noop, toText: "", setToText: noop,
    amount: { ok: false, units: null, hl: null, usdc: null, error: null }, dest: { ok: false, address: null, error: null, caution: null, own: false },
    blocked: true, canSign: true, askKey: null, quote: { key: null, status: "idle", data: null, error: null, retry: noop }, canReview: false, review: noop,
    reviewState: { key: null, status: "idle", quote: null, preflight: null, error: null }, reviewView: null, now: Date.now(), confirm: noop, recheck: noop,
    send: { phase: "idle", result: null }, locked: false, edit: noop, snapshot: null, journalState: null,
  };
  globalThis.__impl = { usePrivateProbe: () => PROBE_ON, usePrivateWithdrawLedger: () => ledger, usePrivateWithdraw: () => p };
  const h = M.mount(() => M.default({ backend: liveBackend(), onBack() {} }));
  let el = h.render();
  allEls(M.mount(() => { const t = el.props.toggle(false); return t.type(t.props); }).render()).find((e) => e.type && e.type.__stub === "Seg").props.onChange("private");
  h.flush();
  el = h.render();
  assert.equal(nameOf(el), "PrivateWithdraw");
  const tree = M.mount(() => el.type(el.props)).render();
  const list = allEls(tree);
  const notes = list.map((e, i) => [e, i]).filter(([e]) => nameOf(e) === "UnsettledNote");
  const stepAt = list.findIndex((e) => nameOf(e) === "StepHead" && e.props.n === "01");
  assert.equal(notes.length, 1, "said once");
  assert.ok(notes[0][1] < stepAt, "first, under the header");
  const inputs = list.filter((e) => e.type === "input" && e.props["aria-label"]);
  assert.deepEqual(inputs.map((e) => [e.props["aria-label"], e.props.readOnly]), [["Amount in USDC", true], ["Destination address", true]]);
  const chips = list.filter((e) => e.type === "button" && "aria-pressed" in e.props);
  assert.equal(chips.length, 4);
  assert.ok(chips.every((c) => c.props.disabled === true), "the network chips are off");
  const review = list.find((e) => e.type && e.type.__stub === "Button" && e.props.onClick === p.review);
  assert.ok(review, "Review withdrawal is still drawn");
  assert.equal(review.props.disabled, true);
  delete globalThis.__impl;
});

/* ════════════════════════════════════════════════════════════════════════════
   S. SOURCE GUARDS (comments stripped)
   ════════════════════════════════════════════════════════════════════════════ */

test("S1) 🔴 no new silent signing; the DEV preview is DEV-only; Normal is the old code; nothing falls back to Normal by itself", () => {
  /* G1's count is the point: the bridge still asks Privy for no window in exactly its two places. */
  const bridge = code("src/components/privy/PrivyBridge.jsx");
  assert.equal((bridge.match(/showWalletUIs\s*:\s*false/g) || []).length, 2);
  assert.doesNotMatch(bridge, /intents|sendIntentsDeposit/);
  assert.deepEqual([...M.HL_SILENT_MASTER_ACTIONS], ["approveAgent", "approveBuilderFee"]);
  assert.equal(M.silentMasterAllowed("privy", "sendAsset"), false);
  const client = code("src/lib/hyperliquid/exchange/client.js");
  assert.match(client, /import \{ buildIntentsSendAsset \} from "\.\/intentsOut\.js";/);
  const method = client.slice(client.indexOf("async sendIntentsDeposit("), client.indexOf("async function doEnable"));
  assert.ok(method.length > 200, "the method was found");
  assert.doesNotMatch(method, /quiet|silent/i, "never the no-window signer");
  assert.equal((method.match(/sendMaster\(/g) || []).length, 1, "one signature, one post");
  assert.match(method, /sendMaster\(built\.action\)/);
  assert.match(method, /fail\("not_confirmed", [^)]*\{ lost: true, retry: false \}\)/);

  const panel = code("src/wallet/WithdrawPanel.jsx");
  assert.doesNotMatch(panel, /hyperliquid\/exchange/, "the Wallet never reaches the signing layer");
  assert.doesNotMatch(panel, /^import .*privateWithdrawPreview/m);
  assert.match(panel, /if \(!import\.meta\.env\.DEV\) return undefined;[\s\S]{0,400}import\("\.\.\/perp\/withdraw\/privateWithdrawPreview\.js"\)/);
  assert.equal((panel.match(/privateWithdrawPreview\.js/g) || []).length, 1, "one way in: the DEV branch's dynamic import");
  /* The mode changes only on a tap (the toggle, a "Use Normal withdraw" button) and the preview's own start. */
  const chooses = panel.match(/dispatch\(\{ type: "choose"[^)]*\)/g) || [];
  assert.deepEqual(chooses.sort(), ['dispatch({ type: "choose", mode: MODE_NORMAL })', 'dispatch({ type: "choose", mode: m })', 'dispatch({ type: "choose", mode: preview.mode })'].sort());
  /* The real quote is the hook's, on a press: the panel has no quote of its own and no `dry: false`. */
  assert.doesNotMatch(panel, /dry:\s*false/);
  assert.match(panel, /onClick=\{p\.review\} disabled=\{!canPress\}>Review withdrawal</);
  assert.match(panel, /onClick=\{p\.confirm\}/);
  const hook = code("src/perp/withdraw/usePrivateWithdraw.js");
  assert.equal((hook.match(/dry: false/g) || []).length, 1, "one place asks for a real quote");
  assert.equal((hook.match(/deps\.execute\(/g) || []).length, 1, "one place signs");
  /* Normal: the same hooks and words as before, and a header that is the same element without the toggle. */
  for (const line of [
    "const q = useRelayWithdrawQuote({ user: wallet, recipient, route, amountUsdc, enabled: quoteAble }) || NO_QUOTE;",
    "quote, amountUsdc: w.amount, signAuthorize, sendDeposit, signWords: withdrawSignWords({ quote }), onPhase: (p) => setSigning(p),",
    "Your first withdrawal pays Hyperliquid&apos;s one-time {usdcExact(activation)} USDC activation, and it has to stay in your balance.",
    "const canConfirm = sendAble && !!pending && !activationShort && (phase === \"idle\" || phase === \"error\");",
    "Withdrawals move real USDC from your balance. Sign in with a live account first.",
  ]) assert.ok(panel.includes(line), line);
  assert.match(panel, /modeToggle \? <div className="flex min-w-0 items-center gap-3"><h2 className="text-h2">Withdraw<\/h2>\{modeToggle\}<\/div> : <h2 className="text-h2">Withdraw<\/h2>/);
  assert.match(panel, /function NormalWithdraw\(\{ backend: b, onBack, toggle = null, notice = null \}\)/);
  /* The notice is an additive slot: without one, Normal draws exactly what it drew. */
  assert.match(panel, /const noticeBlock = notice \? <div className="-mt-px border-t border-border pt-4">\{notice\}<\/div> : null;/);
  /* The toggle's lock is real: a locked change does nothing, whatever reaches Seg's buttons. */
  assert.match(panel, /onChange=\{locked \? KEEP_MODE : onChange\}/);
  /* Private is the connected wallet's own: never the mock, never a view-as. */
  assert.match(panel, /const wallet = b && !b\.mock && !b\.readOnly && b\.address \? b\.address : null;/);
  /* Nothing on the Private screens signs by itself. */
  for (const f of ["src/perp/withdraw/privateWithdrawView.js", "src/perp/withdraw/usePrivateWithdraw.js", "src/perp/withdraw/privateWithdrawPreview.js"]) {
    assert.doesNotMatch(code(f), /sendTransaction|personal_sign|eth_sendRawTransaction|privateKey|mnemonic|signTypedData/, f);
  }
  assert.match(read("src/perp/withdraw/privateWithdrawPreview.js"), /PRIVATE_WITHDRAW_PREVIEW_MARK = "ff-private-withdraw-preview-fixture"/);
});

test("V-auto) the activation fee stays behind by itself: an amount that would not leave it is lowered (never raised), with one quiet line", () => {
  const err = { code: "activation-reserve" };
  assert.equal(V.privateWithdrawAutoAmount(err, { amountText: "20.5", withdrawableUsdc: 20.5 }), 19.5);
  assert.equal(V.privateWithdrawAutoAmount(err, { amountText: "19.5", withdrawableUsdc: 20.5 }), null, "never raised or repeated");
  assert.equal(V.privateWithdrawAutoAmount({ code: "over-day-cap", detail: { left: 5 } }, { amountText: "20", withdrawableUsdc: 50 }), null, "a limit keeps its own tap");
  assert.equal(V.privateWithdrawAutoAmount(null, { amountText: "20", withdrawableUsdc: 50 }), null);
  assert.equal(V.privateWithdrawAdjustedText(19.5), "Adjusted to 19.50: 1.00 USDC stays behind for the activation fee, paid on every private withdrawal.");
});
