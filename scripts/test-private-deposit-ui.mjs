/**
 * test-private-deposit-ui — THE PRIVATE DEPOSIT SCREEN'S LOGIC (no React, no network).
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "เริ่มทำหน้าจอ Private mode เลย ฝั่ง Deposit ก่อน" and "เอา ARB, Avax,
 * Base, Polygon พอแระ". What this suite pins (perp/deposit/privateDepositView.js,
 * perpDepositView.js, depositPopupView.js, usePrivateDeposit.js's pieces, wallet/DepositPanel.jsx's wiring):
 *
 *   P1  the toggle shows only on a clear "on" from the probe (and while the customer is on Private)
 *   P2  "Preview · not private yet" whenever the probe is not confidential; "Private" only when it is
 *   P3  only the four chains; Base and Polygon only while PRIVATE_RECOVER_READY is on (it is); Normal's logos
 *   P4  refundTo = recipient = the customer's own wallet, from every origin; the echo is held to it
 *   P5  where a refund lands, in words, per origin
 *   P6  an error never moves the customer off Private; every Private error code has plain words
 *   P7  the address hides at showUntil, and the countdown says how long is left
 *   P8  a Private ("near") row is drawn by the Pending popup like a Relay row
 *   P9  INCOMPLETE: "Less than quoted · refunded after {date}", never credited, said until closed (own ack id)
 *   P10 the saved address is forgotten once the watch sees it used
 *   P11 private-arb reads like the first-deposit plan ("In your wallet", then the auto-move)
 *   P12 the provider's names never reach a money screen
 *   P13 source guards: the DEV preview is DEV-only, Normal is untouched, nothing falls back on its own
 *   P14 the dev mount carries the intents proxies and their server env; .env.example documents it
 *   P15 an Arbitrum refund is promised only what the wallet and its gas support (auto-move / needs ETH / own wallet)
 *   P16 a used one-time address is never offered again (no QR, copy or clock; its rows and "New deposit")
 *   P17 the figures beside an address are the ones that address is bound to
 *   P18 the server's own min / max / left reach the words; amount errors sit under the amount
 *   P19 Recover is reachable without Private (Normal, switched off), behind the one switch
 *   P20 the toggle never says "Private" beside "not private yet"
 *   P21 the four chains' live dry quotes (10:01Z) pass the real verifiers, deposits and withdrawals
 *   P22 Spot Account sentences keep the owner's words through the Wallet's shim
 *
 * MONEY SAFETY: global fetch throws; every outside call is a fake. Nothing signs or sends.
 *
 * Run: node --test scripts/test-private-deposit-ui.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/stripComments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) => stripComments(read(rel));
const fixture = (name) => JSON.parse(read(`scripts/fixtures/intents/${name}.json`));

const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error("live network is forbidden in test-private-deposit-ui"); }; });
after(() => { globalThis.fetch = realFetch; });

let V; let PV; let PP; let A; let C; let D; let CL; let W; let R; let PW; let S;
before(async () => {
  V = await import("../src/perp/deposit/privateDepositView.js");
  PV = await import("../src/perp/deposit/perpDepositView.js");
  PP = await import("../src/perp/deposit/depositPopupView.js");
  A = await import("../src/lib/intents/assets.js");
  C = await import("../src/lib/intents/config.js");
  D = await import("../src/lib/intents/deposit.js");
  CL = await import("../src/lib/intents/client.js");
  W = await import("../src/perp/deposit/depositWatch.js");
  R = await import("../src/lib/relay/routes.js");
  PW = await import("../src/lib/relay/plainWords.js");
  S = await import("../src/lib/intents/status.js");
});

const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEP = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const NOW = Date.parse("2026-10-15T07:01:10.000Z");
const HOUR = 3600000;
const CAPTURE_USER = /0xa1581fb128e573fef727dd9fc2630d0d695a1956/gi;
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _m: m,
  };
}

/* ── P1 / P2 the probe decides the toggle and the label ───────────────────── */

test("P1) the toggle is hidden unless the probe says a clear \"on\"; it stays while the customer is on Private (their way back)", async () => {
  const probeOf = (status, body) => CL.readPrivateModeProbe({ fetchImpl: async () => jsonRes(status, body), url: "/api/intents-quote?probe=1" });
  const off = await probeOf(503, { error: "private_mode_off", enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(V.privateToggleShown(off), false);
  assert.equal(V.privateToggleShown(await CL.readPrivateModeProbe({ fetchImpl: async () => { throw new Error("down"); } })), false, "a probe that never answered hides it");
  assert.equal(V.privateToggleShown(await probeOf(200, { enabled: "true", confidentiality: "public" })), false, "anything but enabled:true is off");
  assert.equal(V.privateToggleShown(null), false);
  const on = await probeOf(200, { enabled: true, confidential: false, confidentiality: "public", limits: C.PRIVATE_LIMITS });
  assert.equal(V.privateToggleShown(on), true);
  assert.equal(V.privateToggleShown(off, V.MODE_PRIVATE), true, "switched off while on Private: the toggle stays so Normal is one tap away");
  assert.equal(V.privateToggleShown(off, V.MODE_NORMAL), false);
});

test("P2) 🔴 \"Preview · not private yet\" whenever the probe is not confidential; \"Private\" only when it is", async () => {
  const probeOf = (body) => CL.readPrivateModeProbe({ fetchImpl: async () => jsonRes(200, body), url: "/x" });
  const pub = await probeOf({ enabled: true, confidential: false, confidentiality: "public" });
  assert.deepEqual(V.privacyLabel(pub), { private: false, label: "Preview · not private yet", tone: "warning" });
  /* A server that claims confidential with a public level is NOT believed. */
  const liar = await probeOf({ enabled: true, confidential: true, confidentiality: "public" });
  assert.equal(liar.confidential, false);
  assert.equal(V.privacyLabel(liar).label, V.PREVIEW_LABEL);
  assert.equal(V.privacyLabel({ enabled: true, confidential: true, confidentiality: "public" }).private, false, "the view holds the same line on its own");
  const conf = await probeOf({ enabled: true, confidential: true, confidentiality: "basic" });
  assert.deepEqual(V.privacyLabel(conf), { private: true, label: "Private", tone: "plain" });
  assert.equal(V.privacyLabel(null).label, V.PREVIEW_LABEL, "unknown is never called private");
  /* Honest words only (plan §4). */
  for (const s of [V.PRIVATE_TIP, V.PREVIEW_LABEL, V.PREVIEW_NOTE, V.PRIVATE_FOOTER, V.PRIVATE_ATTEST]) {
    assert.doesNotMatch(s, /(?<!isn't )anonymous|untraceable|no KYC|invisible|hide from|\bmixer\b|tumbler|launder|can'?t be tracked|\bVPN\b|\bZK\b|zero-knowledge/i, s);
  }
  assert.match(V.PRIVATE_TIP, /isn't anonymous/);
});

/* ── P3 the four chains ──────────────────────────────────────────────────── */

test("P3) 🔴 only the four chains; Base and Polygon only while PRIVATE_RECOVER_READY is on (Recover can sign: it is); the picker reuses Normal's logos", () => {
  assert.equal(C.PRIVATE_RECOVER_READY, true, "on: PrivyBridge provides Recover's visible signer (test-private-recover R9, R12)");
  assert.deepEqual(V.privateChainOptions().map((r) => r.id), ["arbitrum-usdc", "avalanche-usdc", "base-usdc", "polygon-usdc"]);
  assert.deepEqual(V.privateChainOptions({ recoverReady: true }).map((r) => r.chainName), ["Arbitrum", "Avalanche", "Base", "Polygon"]);
  /* With the switch off they are hidden again, and a saved or typed id of a hidden chain never stands. */
  assert.deepEqual(V.privateChainOptions({ recoverReady: false }).map((r) => r.id), ["arbitrum-usdc", "avalanche-usdc"]);
  assert.equal(V.privateRouteFor("base-usdc", { recoverReady: false }).id, "arbitrum-usdc", "a saved or typed id of a hidden chain never stands");
  assert.equal(V.privateRouteFor("base-usdc").id, "base-usdc");
  assert.equal(V.privateRouteFor("polygon-usdc").id, "polygon-usdc");
  assert.equal(V.privateRouteFor("ethereum-usdc").id, "arbitrum-usdc");
  assert.equal(V.privateRouteFor("avalanche-usdc").id, "avalanche-usdc");
  for (const r of V.privateChainOptions({ recoverReady: true })) {
    assert.equal(r.token, "USDC", "USDC only");
    const normal = R.routeById(r.id);
    assert.equal(r.chainLogo, normal.chainLogo, `${r.id} draws Normal's own logo (lib/relay/chainLogos.js)`);
    assert.ok(r.chainLogo && r.chainLogo.startsWith("/chain-logos/"));
  }
  /* No Ethereum, BNB, OP, Solana or BTC anywhere in the table. */
  assert.deepEqual(A.PRIVATE_DEPOSIT_ROUTES.map((r) => r.chainId).sort((a, b) => a - b), [137, 8453, 42161, 43114]);
});

/* ── P4 refundTo is the customer's own ───────────────────────────────────── */

test("P4) 🔴 refundTo = recipient = the customer's own wallet, from every origin, on both plans; an echo naming anyone else is refused", () => {
  for (const route of A.PRIVATE_DEPOSIT_ROUTES) {
    for (const plan of D.PRIVATE_PLANS) {
      const b = D.buildIntentsDepositQuoteBody({ user: USER, connected: USER, route, plan, amountRaw: "25000000", dry: true, now: NOW });
      assert.equal(b.refundTo, USER, route.id);
      assert.equal(b.recipient, USER, route.id);
      assert.equal(b.refundType, "ORIGIN_CHAIN", "a refund goes back on the chain it came from (the four chains' own wallet)");
      assert.equal(b.originAsset, route.intentsAsset.assetId);
    }
  }
  assert.throws(() => D.buildIntentsDepositQuoteBody({ user: USER, connected: DEP, route: A.privateRouteById("avalanche-usdc"), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", now: NOW }), (e) => e.code === "not-connected");
  const answer = JSON.parse(JSON.stringify(fixture("dry-arb-to-hc-25").answer).replace(CAPTURE_USER, USER));
  const ctx = { user: USER, route: A.privateRouteById("arbitrum-usdc"), plan: D.PRIVATE_CORE_PLAN, amountRaw: "25000000", confidentiality: "public", dry: true, now: NOW };
  assert.equal(D.parseIntentsDepositQuote(answer, ctx).amountOut, 24.6847);
  const other = JSON.parse(JSON.stringify(answer));
  other.quoteRequest.refundTo = DEP;
  assert.throws(() => D.parseIntentsDepositQuote(other, ctx), (e) => e.code === "unsafe-quote" && /refund/.test(e.message));
});

/* ── P5 the words around the money ───────────────────────────────────────── */

test("P5) where a refund lands, per origin; the money warnings; what lands, as label and value, in two decimals", () => {
  const r = (id) => A.privateRouteById(id);
  assert.equal(V.privateRefundText(r("arbitrum-usdc"), V.REFUND_AUTO), "If refunded, the money returns to your Main Account automatically.");
  assert.equal(V.privateRefundText(r("avalanche-usdc")), "Refunds go to your Spot Account.");
  assert.match(V.privateRefundText(r("base-usdc")), /own wallet on Base\. Recover moves it into your Main Account with no gas/);
  assert.match(V.privateRefundText(r("polygon-usdc")), /Polygon/);
  assert.equal(V.privateSendOnlyText(r("avalanche-usdc")), "Send only USDC on Avalanche. Other tokens or networks can be lost.");
  /* Step 02's title is the money-critical instruction, from the amount the ADDRESS is bound to. */
  assert.equal(V.oneTimeAddressTitle({ amountInRaw: "25000000" }, r("arbitrum-usdc"), "25"), "Send exactly 25 USDC on Arbitrum");
  assert.equal(V.oneTimeAddressTitle({ amountInRaw: "25500000" }, r("arbitrum-usdc"), "25.50"), "Send exactly 25.5 USDC on Arbitrum");
  assert.equal(V.oneTimeAddressTitle(null, r("avalanche-usdc"), "10"), "Send exactly 10 USDC on Avalanche");
  assert.equal(V.privateSummaryText({ amountInRaw: "25000000" }, r("arbitrum-usdc"), "25"), "25 USDC · Arbitrum");
  /* The printed warning is short; why a refund happens is its Tip; where it goes stays printed (privateRefundText). */
  assert.equal(V.oneTimeAddressWarning(), "One transfer only. Other tokens or networks can be lost. Don't reuse this address.");
  assert.equal(V.LESS_ARRIVES_TIP, "If less than the exact amount arrives (some exchanges take a fee), it isn't credited: it's refunded.");
  /* Money is two decimals, as Normal prints it (owner, 2026-09-28); more only under a cent; the guarantee rounds DOWN. */
  const q = { plan: "private-core", amountOut: 24.6847, minAmountOut: 24.434753, feeUsdc: 0.3153, refundFeeUsdc: 0.0053, timeEstimateSec: 35 };
  assert.equal(V.privateUsdcText(24.6847), "≈ 24.68 USDC");
  assert.equal(V.privateUsdcText(0.3153), "≈ 0.32 USDC");
  assert.equal(V.privateUsdcText(0.0053), "≈ 0.0053 USDC");
  assert.equal(V.privateUsdcText(24.439999, { approx: false, floor: true }), "24.43 USDC", "a guarantee is never printed above what was promised");
  assert.equal(V.privateUsdcText(24.43, { approx: false, floor: true }), "24.43 USDC");
  assert.equal(V.privateMinimumText(q), "At least 24.43 USDC is guaranteed to arrive, or it is refunded.");
  const rows = V.privateQuoteRows(q);
  assert.deepEqual(rows.map((x) => [x.label, x.value]), [["You receive", "≈ 24.68 USDC"], ["Fee", "≈ 0.32 USDC"], ["Arrives in", "~35s"]]);
  assert.equal(rows[0].strong, true, "the key figure sits in the value column, at the strong weight");
  assert.equal(rows[0].tip, "Lands in your Main Account. At least 24.43 USDC is guaranteed to arrive, or it is refunded.");
  /* What a refund keeps is the Fee's Tip, not a second charge on every deposit. */
  assert.equal(rows[1].tip, "If the deposit is refunded, 0.0053 USDC is kept.");
  assert.ok(!rows.some((x) => /refund fee/i.test(x.label)));
  assert.match(V.privateQuoteRows({ ...q, plan: "private-arb" })[0].tip, /^Lands in your wallet on Arbitrum, then moves into your Main Account automatically\./);
  /* Unknown is the dash, never 0. */
  assert.deepEqual(V.privateQuoteRows(null).map((x) => x.value), ["—", "—", "—"]);
  assert.deepEqual(V.privateQuoteRows({ feeUsdc: null, refundFeeUsdc: undefined }).map((x) => x.value), ["—", "—", "—"]);
  assert.equal(V.privateLimitsText(C.PRIVATE_LIMITS), "Min 10 · Max 500 per deposit · 1,000 per day (USDC)");
  assert.equal(V.privateLimitsText({ ...C.PRIVATE_LIMITS, maxTxUsdc: 9000, maxDayUsdc: 200 }), "Min 10 · Max 500 per deposit · 200 per day (USDC)", "a probe can lower a cap, never raise it");
  const route = r("arbitrum-usdc");
  assert.equal(V.privateAmountOf(route, "", C.PRIVATE_LIMITS).error, null, "nothing typed: nothing to say");
  assert.equal(V.privateAmountOf(route, "9.99", C.PRIVATE_LIMITS).error.code, "below-min");
  assert.equal(V.privateAmountOf(route, "500.000001", C.PRIVATE_LIMITS).error.code, "over-tx-cap");
  assert.equal(V.privateAmountOf(route, "1.2.3", C.PRIVATE_LIMITS).error.code, "bad-amount");
  const many = V.privateAmountOf(route, "10.1234567", C.PRIVATE_LIMITS).error;
  assert.equal(many.code, "bad-amount", "more decimals than USDC carries is refused, never rounded");
  assert.equal(PV.depositErrorText(many), "USDC has up to 6 decimals.", "and the screen says what is wrong");
  assert.equal(V.privateAmountOf(route, "10.1234560", C.PRIVATE_LIMITS).error, null, "trailing zeros are not extra digits");
  assert.equal(PV.depositErrorText(V.privateAmountOf(route, "1.2.3", C.PRIVATE_LIMITS).error), "Enter an amount like 25 or 25.5.");
  assert.deepEqual(V.privateAmountOf(route, "25", C.PRIVATE_LIMITS), { amountRaw: "25000000", amountUsdc: 25, error: null });
});

/* ── P6 errors keep Private ─────────────────────────────────────────────── */

const PRIVATE_CODES = [
  "private-mode-off", "sanctioned", "screen-unavailable", "below-min", "over-tx-cap", "over-day-cap",
  "confidentiality-mismatch", "rate-limited", "intents-error", "bad-amount", "bad-plan", "bad-route", "network",
  "bad-response", "route-unavailable", "unsafe-quote", "bad-deposit-address", "not-connected", "bad-user", "testnet-off",
];

test("P6) 🔴 an error never moves the customer off Private; only their own tap does", () => {
  let s = V.privateSheetReducer(V.PRIVATE_SHEET_START, { type: "choose", mode: V.MODE_PRIVATE });
  assert.equal(s.mode, V.MODE_PRIVATE);
  for (const code of PRIVATE_CODES) {
    s = V.privateSheetReducer(s, { type: "error", error: new CL.IntentsError(code, "x") });
    assert.equal(s.mode, V.MODE_PRIVATE, code);
    assert.equal(s.error.code, code);
  }
  s = V.privateSheetReducer(s, { type: "probe", probe: { enabled: false } });
  assert.equal(s.mode, V.MODE_PRIVATE, "the server switching off is said on Private, not acted on");
  s = V.privateSheetReducer(s, { type: "choose", mode: "something" });
  assert.equal(s.mode, V.MODE_PRIVATE);
  s = V.privateSheetReducer(s, { type: "choose", mode: V.MODE_NORMAL });
  assert.equal(s.mode, V.MODE_NORMAL);
  assert.equal(s.error, null);
  assert.equal(V.PRIVATE_SHEET_START.mode, V.MODE_NORMAL, "the sheet opens on Normal");
});

test("P6b) every Private error code has its own plain words: no provider, no workaround, sanctions in plan §4's words", () => {
  const generic = PV.depositErrorText({ code: "never-heard-of-it" });
  const seen = new Set();
  for (const code of ["private-mode-off", "sanctioned", "screen-unavailable", "below-min", "over-tx-cap", "over-day-cap", "confidentiality-mismatch", "rate-limited", "intents-error", "bad-amount", "bad-plan"]) {
    const t = PV.depositErrorText(new CL.IntentsError(code, "The private route service refused", { min: 10, max: 500 }));
    assert.notEqual(t, generic, `${code} has its own sentence`);
    assert.doesNotMatch(t, /NEAR|1click|defuse|chaindefuser|intents|Relay|Hyperliquid/i, code);
    seen.add(t);
  }
  assert.equal(PV.depositErrorText({ code: "sanctioned" }), "Your wallet can't use Private deposits. It appears on a sanctions or stolen-funds list. Contact support if you think this is a mistake.");
  assert.equal(PV.depositErrorText({ code: "private-mode-off" }), "Private deposits are off right now. Use Normal deposit, or try again later.");
  assert.equal(PV.depositErrorText({ code: "screen-unavailable" }), "The safety check couldn't run just now. Try again in a minute.");
  for (const c of ["private-mode-off", "screen-unavailable"]) assert.doesNotMatch(PV.depositErrorText({ code: c }), /Nothing was quoted/, "no engineer wording");
  assert.doesNotMatch(PV.depositErrorText({ code: "sanctioned" }), /VPN|another wallet|try a different/i, "no workaround");
  assert.match(PV.depositErrorText(new CL.IntentsError("below-min", "x", { min: 12 })), /12 USDC/);
  /* The service not quoting a route is a pause, in our words, with the chain and the way out. */
  assert.equal(PV.depositErrorText(new CL.IntentsError("intents-error", "Quoting for this pair is not available"), { chainName: "Avalanche" }), "Private deposits from Avalanche are paused right now. Try again later, or use Normal deposit.");
  assert.match(PV.depositErrorText(new CL.IntentsError("intents-error", "Amount is too low")), /^Couldn't get a private quote: Amount is too low/);
  assert.match(PV.depositErrorText(new CL.IntentsError("bad-route", "x")), /can't be priced/);
  /* The live refusal of 2026-10-15 09:08–09:45Z (every pair): plain words, Private kept, no address. */
  const refused = fixture("refused-all-pairs-2026-10-15").answers["dry-avax-to-hc-20"];
  const err = CL.intentsErrorOf(refused.status, refused.answer);
  assert.equal(err.code, "intents-error");
  assert.equal(PV.depositErrorText(err, { chainName: "Avalanche" }), "Private deposits from Avalanche are paused right now. Try again later, or use Normal deposit.");
  assert.deepEqual(V.privateErrorActions(err), ["normal", "retry"], "Use Normal deposit is offered first (as a tap)");
  assert.equal(V.privateSheetReducer({ ...V.PRIVATE_SHEET_START, mode: V.MODE_PRIVATE }, { type: "error", error: err }).mode, V.MODE_PRIVATE);
  /* Normal's own codes keep their sentences (byte-for-byte). */
  assert.equal(PV.depositErrorText({ code: "bad-route", name: "RelayDepositError" }), "Couldn't get a deposit address. Try again.");
  assert.equal(PV.depositErrorText({ code: "network" }), "Couldn't reach the deposit service. Check your connection and try again.");
});

/* ── P7 showUntil ───────────────────────────────────────────────────────── */

test("P7) 🔴 the address hides at showUntil (never after), and the countdown says how long is left", () => {
  const res = { depositAddress: DEP, showUntil: NOW + 65 * HOUR, expiresAt: NOW + 72 * HOUR };
  assert.equal(V.addressVisible(res, NOW), true);
  assert.equal(V.addressVisible(res, res.showUntil - 1), true);
  assert.equal(V.addressVisible(res, res.showUntil), false, "at showUntil it is gone");
  assert.equal(V.addressVisible(res, res.showUntil + 1), false);
  assert.equal(V.addressVisible({ ...res, showUntil: null }, NOW), false, "no time to compare: not shown");
  assert.equal(V.addressVisible({ ...res, depositAddress: null }, NOW), false);
  /* In the units a reader can act on: a date over a day, hours and minutes under one, a clock under an hour. */
  assert.match(V.countdownText(res, NOW), /^Valid until \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  assert.equal(V.countdownText({ ...res, showUntil: NOW + 5 * HOUR + 12 * 60000 + 5000 }, NOW), "Expires in 5 h 12 min");
  assert.equal(V.countdownText({ ...res, showUntil: NOW + 24 * HOUR }, NOW), "Expires in 24 h 0 min");
  assert.equal(V.countdownText({ ...res, showUntil: NOW + 305000 }, NOW), "Expires in 05:05");
  assert.equal(V.countdownText(res, res.showUntil), null);
  /* The library never shows less than MIN_SHOW_MS, and hides 6 h before the address goes cold (deposit.js). */
  assert.equal(C.HIDE_BEFORE_INACTIVE_MS, 6 * HOUR);
});

/* ── P8 near rows in the Pending popup ──────────────────────────────────── */

const nearRow = (status, chainId, extra = {}) => ({ id: `near:${DEP.toLowerCase()}`, provider: "near", status, inChainId: chainId, createdAt: NOW - 60000, updatedAt: NOW - 60000, ...extra });

test("P8) a Private row is drawn by the Pending popup like a Relay row: pending, then in the account", async () => {
  const pick = (planId, row, routeId) => ({ address: DEP.toLowerCase(), routeId, planId, provider: "near", row });
  const arriving = PP.depositPopupView({ user: USER, pick: pick("private-core", nearRow("arriving", 43114, { amountIn: 25, symbolIn: "USDC" }), "avalanche-usdc") });
  assert.equal(arriving.kind, "arriving");
  assert.equal(arriving.title, "Deposit pending");
  assert.equal(arriving.sub, "25 USDC from Avalanche");
  assert.equal(arriving.chainLogo, R.routeById("avalanche-usdc").chainLogo);
  assert.equal(arriving.live, true);
  const credited = PP.depositPopupView({ user: USER, pick: pick("private-core", nearRow("credited", 42161, { amountIn: 25, amountOut: 24.6847, symbolOut: "USDC" }), "arbitrum-usdc") });
  assert.equal(credited.kind, "credited");
  assert.match(credited.title, /^\+24\.68 USDC in your Perp account$/, "a Private row prints money in two decimals");
  assert.equal(credited.sub, "Deposit from Arbitrum");
  const refunded = PP.depositPopupView({ user: USER, pick: pick("private-core", nearRow("refunded", 43114, { amountIn: 25 }), "avalanche-usdc") });
  assert.equal(refunded.kind, "refunded");
  assert.equal(refunded.sub, "25 USDC went back to your Spot Account", "an Avalanche refund names where it really is");
  const arbBack = PP.depositPopupView({ user: USER, pick: pick("private-core", nearRow("refunded", 42161, { amountIn: 25 }), "arbitrum-usdc") });
  assert.equal(arbBack.sub, "25 USDC went back to your own address on Arbitrum");
  const baseBack = PP.depositPopupView({ user: USER, pick: pick("private-core", nearRow("refunded", 8453, { amountIn: 25 }), "base-usdc") });
  assert.equal(baseBack.sub, "25 USDC went back to your wallet on Base · Open Deposit to move it in", "Base/Polygon point to Recover");
  /* A Relay refund keeps its words. */
  const relayBack = PP.depositPopupView({ user: USER, pick: { address: DEP.toLowerCase(), routeId: "avalanche-usdc", planId: "direct", provider: "relay", row: { ...nearRow("refunded", 43114, { amountIn: 25 }), id: "0xabc", provider: undefined } } });
  assert.equal(relayBack.sub, "25 USDC went back to your own address on Avalanche");
  /* 🔴 THE BOX IS DRAWN IN THE CUSTOMER'S WORDS: one place, one name (owner: "อย่าเรียก Perp Account"); the Spot Account kept. */
  const status = code("src/perp/deposit/DepositStatus.jsx");
  assert.match(status, /const said = \(s\) => \(keepsOwnWords\(s\) \? s : customerWords\(s\)\);/);
  assert.match(status, /const v = inWords\(shownView\);/);
  const CW = (await import("../src/wallet/words.js")).customerWords;
  const said = (t) => (V.keepsOwnWords(t) ? t : CW(t));
  assert.equal(said(credited.title), "+24.68 USDC in your balance");
  assert.equal(said(refunded.sub), "25 USDC went back to your Spot Account");
  /* Through the real watch: a near entry's tracker answers, and the popup picks its row. */
  const fake = ({ depositAddress, onUpdate }) => { queueMicrotask(() => onUpdate({ depositAddress, state: "ok", requests: [nearRow("arriving", 42161, { amountIn: 25, symbolIn: "USDC", createdAt: Date.now() - 1000 })], checkedAt: Date.now(), error: null })); return { stop() {}, refresh() { return true; }, snapshot() { return null; } }; };
  const watch = W.createDepositWatch({ track: () => { throw new Error("a near entry never asks Relay"); }, trackers: { near: fake }, storage: null });
  const h = watch.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  return new Promise((done) => setTimeout(() => {
    h.release();
    const p = W.pickDepositStatus(watch.getState(), USER);
    assert.equal(p.provider, "near");
    const box = PP.depositPopupView({ user: USER, pick: p, held: PP.depositPanelOpen(watch.getState(), USER) });
    assert.equal(box.kind, "arriving");
    assert.equal(box.sub, "25 USDC from Arbitrum");
    watch.stopAll();
    done();
  }, 5));
});

/* ── P9 incomplete ─────────────────────────────────────────────────────── */

test("P9) 🔴 INCOMPLETE reads \"Less than quoted · refunded after {date}\", is never credited, and the popup says it until it is closed", () => {
  const at = NOW + 72 * HOUR;
  const row = nearRow("incomplete", 42161, { amountIn: 24, symbolIn: "USDC", refundAfter: at });
  const v = PV.depositRowView(row, A.privateRouteById("arbitrum-usdc"), "private-core");
  assert.equal(v.label, `Less than quoted · refunded after ${PV.refundAfterText(at)}`);
  assert.match(v.label, /^Less than quoted · refunded after \d{1,2} Oct, \d{2}:\d{2}$/);
  assert.equal(v.amount, "24 USDC", "what was sent, never a credited figure");
  assert.equal(PV.depositRowView({ ...row, refundAfter: null }, A.privateRouteById("arbitrum-usdc")).label, "Less than quoted · refunded later");
  const sv = PV.depositStatusView(row, R.routeById("arbitrum-usdc"), "private-core");
  assert.equal(sv.live, false);
  assert.equal(sv.go, null, "it names no place in the app");
  assert.equal(sv.lingers, true);
  /* The watch keeps following it, and the popup SAYS it (outside the open sheet nothing else would): never as
     money, never as an arrival, lingering until it is closed under its own name. */
  const state = { entries: [{ address: DEP.toLowerCase(), user: USER.toLowerCase(), routeId: "arbitrum-usdc", planId: "private-core", provider: "near", held: false, watching: true, seq: 1, okSeq: 1, state: "ok", requests: [row], checkedAt: NOW, error: null, acked: [], movingNow: [false] }] };
  const pick = W.pickDepositStatus(state, USER);
  assert.equal(pick.row.status, "incomplete");
  const box = PP.depositPopupView({ user: USER, pick });
  assert.equal(box.kind, "incomplete");
  assert.equal(box.title, "Deposit will be refunded");
  assert.equal(box.sub, `24 USDC from Arbitrum · Less than quoted · refunded after ${PV.refundAfterText(at)}`);
  assert.equal(box.lingers, true);
  assert.equal(box.live, false);
  assert.equal(box.check, false, "never a credit");
  assert.equal(box.amount, null, "no figure is announced as money");
  assert.deepEqual(box.ackRow, { address: DEP.toLowerCase(), id: `near:${DEP.toLowerCase()}#incomplete` });
  /* Closed: not said again; the refund after it keeps the row's own id and is news. */
  const closed = { entries: [{ ...state.entries[0], acked: [box.ackRow.id] }] };
  assert.equal(W.pickDepositStatus(closed, USER), null);
  const refunded = { entries: [{ ...closed.entries[0], requests: [{ ...row, status: "refunded", refundAfter: null }] }] };
  assert.equal(W.pickDepositStatus(refunded, USER).row.status, "refunded");
  /* While the sheet is open it is the sheet's to say. */
  assert.equal(W.pickDepositStatus({ entries: [{ ...state.entries[0], held: true }] }, USER), null);
  /* The status layer maps the service's INCOMPLETE_DEPOSIT to it, with the deadline. */
  assert.equal(S.INTENTS_STATUS_ROW.INCOMPLETE_DEPOSIT, "incomplete");
});

/* ── P10 forget-after-row ───────────────────────────────────────────────── */

test("P10) 🔴 the saved one-time address is forgotten the moment the watch shows a row for it (it is never offered again)", async () => {
  const storage = fakeStorage();
  const key = D.privateDepositCacheKey(USER, "arbitrum-usdc", "private-core", "25000000", "public");
  storage.setItem(key, JSON.stringify({ v: 1, provider: "near", user: USER.toLowerCase(), depositAddress: DEP.toLowerCase() }));
  storage.setItem("flowflow.privateDeposit.v1:someoneelse:arbitrum-usdc:private-core:25000000:public", JSON.stringify({ depositAddress: DEP.toLowerCase() }));
  const fake = ({ depositAddress, onUpdate }) => { queueMicrotask(() => onUpdate({ depositAddress, state: "ok", requests: [nearRow("arriving", 42161, { createdAt: Date.now() })], checkedAt: Date.now(), error: null })); return { stop() {}, refresh() { return true; }, snapshot() { return null; } }; };
  const watch = W.createDepositWatch({ track: () => { throw new Error("no relay"); }, trackers: { near: fake }, storage: null });
  const h = watch.show({ user: USER, address: DEP, routeId: "arbitrum-usdc", planId: "private-core", provider: "near" });
  await new Promise((r) => setTimeout(r, 5));
  const view = W.sheetTrackView(watch.getState(), DEP, { address: DEP.toLowerCase(), seq: h.seq });
  assert.equal(V.addressUsed(view.requests), true);
  assert.equal(V.addressUsed([]), false, "no row yet: nothing is forgotten");
  /* The hook's own call (usePrivateDeposit): forget({ user, depositAddress }). */
  assert.equal(D.forgetPrivateDepositAddress({ user: USER, depositAddress: DEP, storage, memory: new Map() }), 1);
  assert.equal(storage.getItem(key), null);
  assert.ok(storage._m.size === 1, "another wallet's entry is left alone");
  h.release();
  watch.stopAll();
  /* And the hook does exactly that: addressUsed(track.requests) → deps.forget({ user, depositAddress }), once. */
  const hook = code("src/perp/deposit/usePrivateDeposit.js");
  assert.match(hook, /addressUsed\(track\.requests\)[\s\S]{0,200}deps\.forget\(\{ user, depositAddress \}\)/);
  assert.match(hook, /provider: watchArgs\.provider/, "the watch is told the provider (near)");
});

/* ── P11 private-arb ───────────────────────────────────────────────────── */

test("P11) private-arb reads like the first-deposit plan: \"In your wallet\", then the auto-move; private-core is in the account", () => {
  assert.equal(PV.planIsFirstHop("private-arb"), true);
  assert.equal(PV.planIsFirstHop("private-core"), false);
  assert.equal(PV.depositPhases("private-arb").at(-1).label, "In your wallet");
  const row = nearRow("credited", 43114, { amountIn: 25, amountOut: 24.9947, symbolOut: "USDC" });
  assert.equal(PV.depositRowView(row, A.privateRouteById("avalanche-usdc"), "private-arb").label, "In your wallet");
  assert.equal(PV.depositRowView(row, A.privateRouteById("avalanche-usdc"), "private-core").label, "Credited");
  /* A Private customer paid from elsewhere: it "arrived" (never "landed in your wallet", which reads as bounced back). */
  const pickArb = { address: DEP.toLowerCase(), routeId: "avalanche-usdc", planId: "private-arb", provider: "near", row };
  const looking = PP.depositPopupView({ user: USER, pick: pickArb, move: { step: "idle", usdc: null, seq: 1, acked: true, balanceRead: false, balanceRaw: null, checking: true } });
  assert.equal(looking.kind, "landed");
  assert.equal(looking.title, "+24.99 USDC arrived");
  assert.equal(looking.sub, "Moving to your Main Account · no action needed");
  assert.equal(looking.live, true);
  const box = PP.depositPopupView({ user: USER, pick: pickArb, move: { step: "offer", usdc: 24.9947, seq: 1, acked: false, balanceRead: true, balanceRaw: null, checking: false } });
  assert.equal(box.kind, "landed");
  assert.equal(box.title, "+24.99 USDC arrived");
  assert.equal(box.sub, "Waiting to move to your Main Account", "no claim that nothing is needed when the move is not running itself");
  /* Normal's first-deposit landing keeps its words. */
  const normal = PP.depositPopupView({ user: USER, pick: { ...pickArb, planId: "arb-first", provider: "relay", row: { ...row, provider: undefined, id: "0xabc" } }, move: { step: "offer", usdc: 9.92, seq: 1, acked: false, balanceRead: true, balanceRaw: null, checking: false } });
  assert.match(normal.title, /landed in your wallet$/);
  /* Normal's first-deposit plan is unchanged. */
  assert.equal(PV.planIsFirstHop("arb-first"), true);
});

/* ── P12 names ─────────────────────────────────────────────────────────── */

test("P12) the provider's names never reach a money screen (plainWords, additive); the English word \"near\" is left alone", () => {
  const p = PW.plainMoneyWords;
  assert.equal(p("NEAR Intents refused the quote"), "The private route service refused the quote");
  assert.equal(p("Quoting via 1Click failed"), "Quoting via the private route service failed");
  assert.equal(p("The defuse contract said no"), "The private route service contract said no");
  assert.doesNotMatch(p("chaindefuser answered 500"), /chaindefuser/i);
  assert.equal(p("near the limit"), "near the limit");
  /* What it did before is unchanged. */
  assert.equal(p("Failed to relay the transaction"), "Failed to forward the transaction");
  assert.equal(p("Hyperliquid said: Invalid chain"), "The trading service said: Invalid chain");
  /* No screen string of the Private side names one. */
  for (const f of ["src/perp/deposit/privateDepositView.js", "src/wallet/DepositPanel.jsx"]) {
    const body = code(f).replace(/^import[\s\S]*?from "[^"]+";$/gm, "").replace(/import\("[^"]+"\)/g, "");
    const strings = body.match(/"[^"\n]*"|`[^`\n]*`/g) || [];
    for (const s of strings) assert.doesNotMatch(s, /\bNEAR\b|1click|defuse|chaindefuser|\bintents\b|Relay\b|Hyperliquid/i, `${f}: ${s}`);
  }
});

/* ── P13 source guards ─────────────────────────────────────────────────── */

test("P13) source guards: the DEV preview is DEV-only; Normal is the old code; nothing falls back to Normal by itself; nothing signs", () => {
  const panel = code("src/wallet/DepositPanel.jsx");
  /* The fixture module is imported ONLY dynamically, inside the import.meta.env.DEV branch. */
  assert.doesNotMatch(panel, /^import .*privateDepositPreview/m);
  assert.match(panel, /if \(!import\.meta\.env\.DEV\) return undefined;[\s\S]{0,400}import\("\.\.\/perp\/deposit\/privateDepositPreview\.js"\)/);
  assert.equal((panel.match(/privateDepositPreview/g) || []).length, 1);
  /* The mode changes only on a tap (the toggle, or the "Use Normal deposit" button) and the preview's own start. */
  const chooses = panel.match(/dispatch\(\{ type: "choose"[^)]*\)/g) || [];
  assert.deepEqual(chooses.sort(), ['dispatch({ type: "choose", mode: MODE_NORMAL })', 'dispatch({ type: "choose", mode: m })', 'dispatch({ type: "choose", mode: preview.mode })'].sort());
  /* "Get address" (a non-dry quote) only on a press: onClick, or the DEV preview's initial.press. */
  const presses = panel.match(/p\.getAddress/g) || [];
  assert.equal(presses.length, 2, "the Get address button and the Try again button");
  assert.match(panel, /onClick=\{p\.getAddress\}/);
  assert.match(panel, /initial=\{preview \? preview\.initial : null\}/);
  /* Normal: the same hooks and words as before, and a header that is the same element without the toggle. */
  const whole = panel;
  for (const line of [
    "const dep = usePerpDepositAddress({ user: wallet, connected: wallet, route, planId, enabled: !!(wallet && planId) });",
    "const { accountNew, planId } = useDepositPlan({ user: wallet, walletType, enabled: !!wallet });",
    "Send only {route.token} on {route.chainName}. Other tokens or networks can be lost.",
    "Deposits go to your balance. Sign in with a live account first (the mock account can't receive one).",
  ]) assert.ok(whole.includes(line), line);
  assert.match(panel, /toggle \? <div className="flex min-w-0 items-center gap-3"><h2 className="text-h2">Deposit<\/h2>\{toggle\}<\/div> : <h2 className="text-h2">Deposit<\/h2>/);
  /* Nothing on this screen signs or sends. */
  for (const f of ["src/perp/deposit/privateDepositView.js", "src/perp/deposit/usePrivateDeposit.js", "src/perp/deposit/privateDepositPreview.js"]) {
    assert.doesNotMatch(code(f), /sendTransaction|personal_sign|eth_sendRawTransaction|privateKey|mnemonic|sendAsset/, f);
  }
  /* The preview's fixture is marked, so the build can be grepped for it. */
  assert.match(read("src/perp/deposit/privateDepositPreview.js"), /PRIVATE_PREVIEW_MARK = "ff-private-preview-fixture"/);
});

/* ── P14 the dev mount and the env ─────────────────────────────────────── */

test("P14) the dev mount serves the intents proxies with their server env (never VITE_); .env.example documents it", () => {
  const v = read("vite.config.js");
  const list = /const DEV_API = \[([^\]]*)\]/.exec(v)[1];
  assert.match(list, /"intents-quote"/);
  assert.match(list, /"intents-status"/);
  const fn = /const SERVER_ENV = \(k\) => ([\s\S]*?);\n/.exec(v)[1];
  // eslint-disable-next-line no-new-func
  const SERVER_ENV = new Function("k", `return ${fn};`);
  for (const k of ["PRIVATE_MODE", "NEAR_INTENTS_JWT", "NEAR_INTENTS_CONFIDENTIALITY", "INTENTS_MAX_TX_USDC", "INTENTS_MAX_DAY_USDC", "INTENTS_SANCTIONS_EXTRA", "INTENTS_SANCTIONS_RPC"]) assert.equal(SERVER_ENV(k), true, k);
  for (const k of ["VITE_PRIVATE_MODE", "PRIVATE_MODEX", "HOME", "PATH"]) assert.equal(SERVER_ENV(k), false, k);
  const env = read(".env.example");
  assert.match(env, /^PRIVATE_MODE=off$/m);
  assert.match(env, /exactly "on"/);
  for (const k of ["NEAR_INTENTS_JWT=", "NEAR_INTENTS_CONFIDENTIALITY=basic", "INTENTS_MAX_TX_USDC=", "INTENTS_MAX_DAY_USDC=", "INTENTS_SANCTIONS_EXTRA=", "INTENTS_SANCTIONS_RPC="]) assert.ok(env.includes(`\n${k}`), k);
  assert.doesNotMatch(env, /VITE_(PRIVATE|NEAR|INTENTS)/);
});

/* ── P15–P22: the review's fixes (2026-10-15) ───────────────────────────── */

test("P15) 🔴 an Arbitrum refund is promised only what the facts support: auto-move for the in-app wallet with gas, never for a gasless or outside one", () => {
  const arb = A.privateRouteById("arbitrum-usdc");
  const floor = D.privateArbGasFloorWei();
  /* The facts choosePrivatePlan read: wallet type and ETH on Arbitrum (null = unread). */
  assert.equal(V.arbitrumRefundPath({ walletType: "privy", gasWei: floor, planId: "private-arb" }), V.REFUND_AUTO);
  assert.equal(V.arbitrumRefundPath({ walletType: "privy", gasWei: floor }), V.REFUND_AUTO);
  assert.equal(V.arbitrumRefundPath({ walletType: "privy", gasWei: 0n, planId: "private-core" }), V.REFUND_NEEDS_GAS, "a new in-app wallet with no ETH: the mover would stop on no-gas");
  assert.equal(V.arbitrumRefundPath({ walletType: "privy", gasWei: floor - 1n, planId: "private-core" }), V.REFUND_NEEDS_GAS);
  assert.equal(V.arbitrumRefundPath({ walletType: "privy", gasWei: null, planId: "private-core" }), V.REFUND_NEEDS_GAS, "unread is never a promise");
  assert.equal(V.arbitrumRefundPath({ walletType: "external", gasWei: floor, planId: "private-core" }), V.REFUND_OWN_WALLET, "the mover never moves for an outside wallet");
  assert.equal(V.arbitrumRefundPath({}), V.REFUND_OWN_WALLET);
  /* The words follow the path; only "auto" says it moves in by itself. */
  const auto = V.privateRefundText(arb, V.REFUND_AUTO);
  const gas = V.privateRefundText(arb, V.REFUND_NEEDS_GAS);
  const own = V.privateRefundText(arb, V.REFUND_OWN_WALLET);
  assert.match(auto, /automatically/);
  for (const t of [gas, own]) assert.doesNotMatch(t, /automatically|by themselves|by itself/, t);
  assert.equal(gas, "If refunded, the money goes back to your wallet on Arbitrum. Moving it into your Main Account then needs a little ETH there for gas.");
  assert.equal(own, "If refunded, the money goes back to your own wallet on Arbitrum.");
  assert.equal(V.privateRefundText(arb), gas, "no facts: the careful words");
  /* Avalanche's words do not depend on gas. */
  for (const path of [V.REFUND_AUTO, V.REFUND_NEEDS_GAS, V.REFUND_OWN_WALLET]) assert.equal(V.privateRefundText(A.privateRouteById("avalanche-usdc"), path), "Refunds go to your Spot Account.");
  /* The hook keeps the gas it chose the plan on, and the panel draws the path it hands over. */
  const hook = code("src/perp/deposit/usePrivateDeposit.js");
  assert.match(hook, /gasWei: r && typeof r\.gasWei === "bigint" \? r\.gasWei : null/);
  assert.match(hook, /arbitrumRefundPath\(\{ walletType, gasWei: [^)]*planId \}\)/);
  const panel = code("src/wallet/DepositPanel.jsx");
  assert.match(panel, /privateRefundText\(route, p\.refundPath\)/);
  assert.equal((panel.match(/said\(privateRefundText\(route, p\.refundPath\)\)/g) || []).length, 2, "printed in the form and beside the address");
  assert.doesNotMatch(panel, /privateRefundText\(route\)/, "never the route's words without the facts");
});

test("P16) 🔴 a used one-time address is never offered again: no QR, no copy, no clock — its rows and \"New deposit\"", () => {
  const ready = { status: "ready", visible: true, expired: false, used: false };
  assert.equal(V.addressStepOf(ready), "address");
  assert.equal(V.addressStepOf({ ...ready, used: true }), "used", "a row was seen: spent, whatever its clock says");
  assert.equal(V.addressStepOf({ ...ready, visible: false, expired: true }), "expired");
  assert.equal(V.addressStepOf({ ...ready, visible: false, expired: true, used: true }), "used");
  assert.equal(V.addressStepOf({ status: "loading" }), "loading");
  assert.equal(V.addressStepOf({ status: "error" }), "error");
  assert.equal(V.addressStepOf({ status: "idle" }), null);
  assert.equal(V.addressStepOf(), null);
  /* Any row with an id is a use (arriving, credited, refunded, failed, incomplete, even one not the customer's). */
  for (const status of ["arriving", "credited", "refunded", "failed", "incomplete", "unknown"]) assert.equal(V.addressUsed([nearRow(status, 42161)]), true, status);
  assert.equal(V.addressUsed([]), false);
  assert.match(V.ADDRESS_USED_TEXT, /has been used\. Don't send to it again/);
  assert.equal(V.ADDRESS_DROPPED_TEXT, "Don't send to the previous address.");
  /* The hook: the address it holds is watched (shown, used or expired) and "visible" is false once used. */
  const hook = code("src/perp/deposit/usePrivateDeposit.js");
  assert.match(hook, /const watchArgs = showing \? address\.data\.watch : null;/);
  assert.match(hook, /const used = !!depositAddress && addressUsed\(track\.requests\);/);
  assert.match(hook, /address: \{ \.\.\.address, visible: visible && !used, expired, used, now \}/);
  assert.match(hook, /if \(wasShown\) setDropped\(true\);/, "dropping a shown address says so once");
  /* The panel: the QR and Copy exist only in the "address" step; "used" draws the rows and New deposit. */
  const panel = code("src/wallet/DepositPanel.jsx");
  assert.match(panel, /const shownAddress = step === "address" \? a\.data\.depositAddress : null;/);
  assert.match(panel, /step === "used"[\s\S]{0,200}ADDRESS_USED_TEXT[\s\S]{0,200}PrivateRows[\s\S]{0,200}New deposit/);
  /* Past showUntil a used address keeps its rows on screen (an INCOMPLETE row outlives showUntil by ~6 h). */
  assert.equal(V.addressStepOf({ status: "ready", visible: false, expired: true, used: true }), "used");
});

test("P17) 🔴 the figures beside an address are the ones that address is bound to; the dry quote's only before it; the dash beside an error", () => {
  const dry = { plan: "private-core", amountOut: 24.6847, minAmountOut: 24.434753, feeUsdc: 0.3153 };
  const bound = { plan: "private-core", amountOut: 24.2, minAmountOut: 23.97, feeUsdc: 0.8, depositAddress: DEP };
  const q = { status: "ready", data: dry };
  assert.equal(V.privateFiguresOf({ quote: q, address: { status: "idle" } }), dry);
  assert.equal(V.privateFiguresOf({ quote: q, address: { status: "ready", data: bound } }), bound, "the address's own quote, never the dry one");
  assert.equal(V.privateMinimumText(V.privateFiguresOf({ quote: q, address: { status: "ready", data: bound } })), "At least 23.97 USDC is guaranteed to arrive, or it is refunded.");
  assert.equal(V.privateFiguresOf({ quote: q, address: { status: "error", error: {} } }), null, "beside an error: the dash, never a stale price");
  assert.equal(V.privateFiguresOf({ quote: { status: "error", error: {} }, address: { status: "idle" } }), null);
  assert.equal(V.privateFiguresOf({ quote: { status: "loading" }, address: { status: "idle" } }), null);
  assert.equal(V.privateFiguresOf(), null);
  /* The panel draws its quote rows from privateFiguresOf, and nowhere from q.data directly. */
  const panel = code("src/wallet/DepositPanel.jsx");
  assert.match(panel, /const figures = privateFiguresOf\(\{ quote: q, address: a \}\);/);
  assert.match(panel, /privateQuoteRows\(figures\)/);
  assert.doesNotMatch(panel, /q\.data/);
});

test("P18) the server's own figures reach the words (a lowered cap reads lowered); amount errors sit under the amount; the day cap says what is left", () => {
  const over = CL.intentsErrorOf(422, { error: "over_tx_cap", max: 200, message: "The largest private move is 200 USDC." });
  assert.equal(over.code, "over-tx-cap");
  assert.equal(over.detail.max, 200);
  assert.equal(PV.depositErrorText(over), "The largest private deposit is 200 USDC.");
  const below = CL.intentsErrorOf(422, { error: "below_min", min: 12, message: "x" });
  assert.equal(PV.depositErrorText(below), "The smallest private deposit is 12 USDC.");
  const day = CL.intentsErrorOf(422, { error: "over_day_cap", max: 1000, left: 15, message: "x" });
  assert.deepEqual([day.detail.max, day.detail.left], [1000, 15]);
  assert.equal(PV.depositErrorText(day), "Over today's private limit. You can send up to 15 USDC more today (resets 00:00 UTC).");
  assert.equal(PV.depositErrorText(CL.intentsErrorOf(422, { error: "over_day_cap", max: 1000, left: 0 })), "You've reached today's 1,000 USDC private limit. Try again after 00:00 UTC.");
  assert.equal(PV.depositErrorText({ code: "over-day-cap" }), "Over today's 1,000 USDC private limit. Try a smaller amount, or after 00:00 UTC.");
  /* Garbage figures are not carried. */
  const junk = CL.intentsErrorOf(422, { error: "over_tx_cap", max: "500", left: -1 });
  assert.equal(junk.detail.max, undefined);
  assert.equal(junk.detail.left, undefined);
  /* Where each is drawn, and what the box offers. */
  for (const c of ["bad-amount", "below-min", "over-tx-cap", "over-day-cap"]) assert.equal(V.privateErrorPlace({ code: c }), "amount", c);
  for (const c of ["sanctioned", "private-mode-off", "screen-unavailable", "rate-limited", "intents-error", "network"]) assert.equal(V.privateErrorPlace({ code: c }), "box", c);
  assert.deepEqual(V.privateErrorActions({ code: "private-mode-off" }), ["normal", "retry"], "Normal first, as the stronger button");
  assert.deepEqual(V.privateErrorActions({ code: "network" }), ["retry", "normal"], "every box error has a way back to Normal");
  assert.deepEqual(V.privateErrorActions({ code: "sanctioned" }), [], "no workaround is offered");
  /* The panel: a server refusal of the amount offers "Change amount" (focus the field), never a "Try again" that cannot work. */
  const panel = code("src/wallet/DepositPanel.jsx");
  assert.match(panel, /serverAmountErr \? \([\s\S]{0,200}onClick=\{changeAmount\}>Change amount</);
  assert.match(panel, /function ErrorNote[\s\S]{0,300}text-destructive/);
});

test("P19) 🔴 Recover is reachable without Private: on Normal and on the switched-off screen — for a wallet it can SIGN for, in one tree", () => {
  const panel = code("src/wallet/DepositPanel.jsx");
  /* Normal first, the rows after it or nothing: one tree, so Normal is never remounted when the signer comes or goes. */
  assert.match(panel, /return <>\{normal\}\{normalRecover \? <div className="mt-4">\{normalRecover\}<\/div> : null\}<\/>;/);
  assert.match(panel, /const normalRecover = !recoverReady \? null/);
  assert.match(panel, /: wallet \? <RecoverRows user=\{wallet\} ready \/> : null;/);
  assert.doesNotMatch(panel, /<div>\{normal\}/, "no wrapper that comes and goes around Normal");
  /* 🔴 recoverReady is THIS wallet's: the switch AND the injected signer naming it (the embedded wallet). */
  assert.match(panel, /const recoverReady = recoverReadyFor\(privateUser, preview \? preview\.recoverSigner \|\| null : injectedSigner\);/);
  assert.match(panel, /const routes = privateChainOptions\(\{ recoverReady \}\);/);
  assert.match(panel, /usePrivateDeposit\(\{ user, walletType, probe, active: true, deps, initial, recoverReady \}\)/);
  assert.match(panel, /const recoverRows = !recoverReady \? null : /);
  /* The switched-off screen draws it too. */
  assert.match(panel, /probe\.enabled !== true && !errCode\) \{[\s\S]{0,900}\{recoverRows\}/);
  assert.equal(C.PRIVATE_RECOVER_READY, true, "on now that the signer is wired: Normal carries the Recover rows (they draw nothing with no USDC there)");
});

test("P19b) 🔴 Base and Polygon only for a wallet Recover can sign for: an injected MetaMask or Rabby user is offered Arbitrum and Avalanche, and sees no Recover rows", () => {
  const OWN = "0x14791697260E4c9A71f18484C9f997B308e59325";
  const signer = Object.assign(async () => "0x", { address: OWN.toLowerCase() });
  assert.equal(V.recoverReadyFor(OWN, signer), true, "the embedded wallet whose signer PrivyBridge provides");
  assert.equal(V.recoverReadyFor(OWN, null), false, "no signer (an injected wallet, or before Privy is ready)");
  assert.equal(V.recoverReadyFor(OWN, Object.assign(async () => "0x", { address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" })), false, "a signer for another wallet");
  assert.equal(V.recoverReadyFor(OWN, async () => "0x"), false, "a signer that names no wallet is not assumed to be this one");
  assert.equal(V.recoverReadyFor(null, signer), false);
  assert.equal(V.recoverReadyFor(OWN, signer, { ready: false }), false, "the switch still rules");
  assert.deepEqual(V.privateChainOptions({ recoverReady: V.recoverReadyFor(OWN, null) }).map((r) => r.chainName), ["Arbitrum", "Avalanche"]);
  assert.deepEqual(V.privateChainOptions({ recoverReady: V.recoverReadyFor(OWN, signer) }).map((r) => r.chainName), ["Arbitrum", "Avalanche", "Base", "Polygon"]);
  /* The DEV preview's outside wallet has no signer, so it shows what an injected wallet sees. */
  const preview = read("src/perp/deposit/privateDepositPreview.js");
  assert.match(preview, /const recoverSigner = external \? null/);
});

test("P19c) Recover rows: no second Move in while one is reviewed, signed or on its way; on its way is a spinner, not success green; a refusal is boxed in plain words", () => {
  const panel = code("src/wallet/DepositPanel.jsx");
  assert.match(panel, /\{mine && \(j\.status === "review" \|\| j\.status === "signing" \|\| j\.status === "sent"\) \? null : \(/);
  assert.match(panel, /j\.status === "sent" \? <p className="flex items-center gap-1\.5 text-xs text-muted-foreground"><Spinner size=\{12\} \/>\{customerWords\("On its way to your Main Account\."\)\}<\/p>/);
  assert.doesNotMatch(panel.slice(panel.indexOf("function RecoverRows")), /text-success/);
  assert.match(panel, /j\.result\.unknown \? <MoneyWarning>\{customerWords\(j\.result\.message\)\}<\/MoneyWarning> : <ErrorNote>\{customerWords\(j\.result\.message\)\}<\/ErrorNote>/);
  /* The figures of the review line wrap whole, never "0.02" on one line and "USDC" on the next. */
  assert.match(panel, /<span className="whitespace-nowrap text-xs text-muted-foreground">· fee \{privateUsdcText\(Number\(j\.review\.costUsdc\)\)\}<\/span>/);
});

test("P20) the toggle never says Private beside \"not private yet\"; it is a header-sized pill", () => {
  assert.equal(V.privateToggleLabel({ enabled: true, confidential: false, confidentiality: "public" }), "Private · preview");
  assert.equal(V.privateToggleLabel({ enabled: true, confidential: true, confidentiality: "basic" }), "Private");
  assert.equal(V.privateToggleLabel(null), "Private · preview");
  const panel = code("src/wallet/DepositPanel.jsx");
  assert.match(panel, /size="xs"[\s\S]{0,200}label: privateToggleLabel\(probe\)/);
  assert.match(read("src/ui/Seg.jsx"), /xs: "ff-hit h-7 px-2\.5 text-xs font-medium"/);
  /* The chip carries no second warning icon. */
  assert.doesNotMatch(panel.slice(panel.indexOf("function PrivacyChip"), panel.indexOf("function PrivateRows")), /name="alert"/);
});

test("P21) 🔴 the four chains quote live: every 10:01Z dry answer (Arbitrum, Avalanche, Base, Polygon → perps; → own Arbitrum; perps → each) passes the real verifiers", async () => {
  const WD = await import("../src/lib/intents/withdraw.js");
  const fx = fixture("dry-four-chains-2026-10-15");
  const route = { arb: "arbitrum-usdc", avax: "avalanche-usdc", base: "base-usdc", pol: "polygon-usdc" };
  let deposits = 0;
  let withdrawals = 0;
  for (const [name, { status, answer }] of Object.entries(fx.answers)) {
    assert.equal(status, 201, name);
    const who = answer.quoteRequest.recipient;
    assert.equal(answer.quoteRequest.dry, true, `${name} is a dry quote`);
    assert.equal(answer.quote.depositAddress ?? null, null, `${name}: a dry quote reserves no address`);
    const dep = /^dry-(arb|avax|base|pol)-to-(hc|arb)-(\d+)$/.exec(name);
    if (dep) {
      const q = D.parseIntentsDepositQuote(answer, { user: who, route: A.privateRouteById(route[dep[1]]), plan: dep[2] === "hc" ? D.PRIVATE_CORE_PLAN : D.PRIVATE_ARB_PLAN, amountRaw: String(Number(dep[3]) * 1e6), confidentiality: "public", dry: true, now: Date.parse(answer.timestamp) });
      assert.ok(q.amountOut > 0 && q.minAmountOut <= q.amountOut, name);
      /* No live minimum above our own 10 USDC floor: the 10 USDC asks quoted. */
      assert.equal(answer.quote.minAmountIn, String(Number(dep[3]) * 1e6), `${name}: the service takes our minimum`);
      assert.equal(answer.quoteRequest.depositMode, "SIMPLE", `${name}: no memo`);
      deposits += 1;
      continue;
    }
    const wd = /^dry-hc-to-(arb|avax|base|pol)-(\d+)$/.exec(name);
    assert.ok(wd, name);
    const w = WD.parseIntentsWithdrawQuote(answer, { user: who, recipient: who, route: WD.privateWithdrawRouteById(route[wd[1]]), amountUsdc: wd[2], dry: true, deadline: answer.quoteRequest.deadline, now: Date.parse(answer.timestamp) });
    assert.ok(w, name);
    withdrawals += 1;
  }
  assert.equal(deposits, 13, "4 chains × (10, 20) → perps, 3 → own Arbitrum at 20, Arbitrum → own Arbitrum at 10 and 20");
  assert.equal(withdrawals, 8, "perps → 4 chains × (10, 20)");
  /* Avalanche → perps at 10 USDC, the runbook's T2b figure. */
  const avax = fx.answers["dry-avax-to-hc-10"].answer.quote;
  assert.equal(avax.amountOutFormatted, "9.68268");
});

test("P22) Spot Account sentences keep the owner's words through the Wallet's shim; every other account word is the shim's", async () => {
  const CW = (await import("../src/wallet/words.js")).customerWords;
  assert.equal(V.keepsOwnWords("Refunds go to your Spot Account."), true);
  assert.equal(V.keepsOwnWords("If refunded, the money returns to your Main Account automatically."), false);
  assert.equal(V.keepsOwnWords(null), false);
  assert.equal(CW(V.privateRefundText(A.privateRouteById("arbitrum-usdc"), V.REFUND_AUTO)), "If refunded, the money returns to your balance automatically.");
  const panel = code("src/wallet/DepositPanel.jsx");
  assert.match(panel, /const said = \(s\) => \(keepsOwnWords\(s\) \? s : customerWords\(s\)\);/);
  assert.match(panel, /\{said\(privateRefundText\(route, p\.refundPath\)\)\}/);
});
