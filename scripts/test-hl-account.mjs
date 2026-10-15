/**
 * test-hl-account — what the connected user OWNS on Hyperliquid, read from the
 * venue's own answers: mode, role, the Perp USDC balance, positions, open and
 * trigger orders (TP/SL per coin), fills, ledger lines and the events a screen
 * can toast (liquidation, ADL, system cancels).
 *
 *   node --test scripts/test-hl-account.mjs
 *
 * Pinned to LIVE answers captured read-only on 2026-09-22
 * (scripts/test-hl-account-fixtures.mjs says who, what and how). Synthetic rows
 * are labelled synthetic where they appear, and exist only for cases no public
 * address showed that day (a liquidation, an ADL, a Relay-style credit).
 *
 * MONEY_RULES section 0: unknown is null (a dash on screen), never 0. A zero
 * Hyperliquid actually sent ("0.0") is a measured zero and stays 0. A
 * never-used address (userRole "missing") is a KNOWN zero, not an unknown.
 * Section 1: one source per figure. The Perp balance comes from exactly one of
 * the two clearinghouses, chosen by the account's mode, and the other is never
 * blended in. Positions are Hyperliquid's numbers, displayed, never re-derived.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { A, B, C, FRESH, DEFAULT_MODE, WS, ADDR, MEASURED } from "./test-hl-account-fixtures.mjs";

const P = await import("../src/lib/hyperliquid/account/parse.js");
const BAL = await import("../src/lib/hyperliquid/account/balance.js");
const EV = await import("../src/lib/hyperliquid/account/events.js");

const near = (a, b, eps = 1e-9) => assert.ok(a != null && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const onlyNumbersOrNull = (obj, label) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") continue;
    if (typeof v === "string" || typeof v === "boolean") continue;
    assert.ok(v === null || (typeof v === "number" && Number.isFinite(v)), `${label}.${k} = ${v}`);
  }
};

/* ── addresses, role, mode ─────────────────────────────────────────────── */

test("A1) addresses: 0x + 40 hex, lowercased; anything else is not an address", () => {
  assert.equal(P.normAddress("0x9895EA2D96CB41D03F6EFC76DEF2AE0186254734"), ADDR.A);
  for (const bad of [null, undefined, "", "0x123", "9895ea2d96cb41d03f6efc76def2ae0186254734", ` ${ADDR.A}`, 42, {}]) {
    assert.equal(P.normAddress(bad), null, String(bad));
  }
});

test("A2) userRole: user / missing read as sent; an agent names its master; garbage is unknown", () => {
  assert.deepEqual(P.parseUserRole(A.userRole), { role: "user", master: null });
  assert.deepEqual(P.parseUserRole(FRESH.userRole), { role: "missing", master: null });
  /* synthetic, shape from the info-endpoint page */
  assert.deepEqual(P.parseUserRole({ role: "agent", data: { user: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" } }),
    { role: "agent", master: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" });
  for (const bad of [null, "user", {}, { role: 7 }, { role: "" }]) assert.deepEqual(P.parseUserRole(bad), { role: null, master: null });
});

test("A3) userAbstraction: the raw mode string, and which clearinghouse holds the USDC", () => {
  assert.equal(P.parseUserAbstraction(A.userAbstraction), "unifiedAccount");
  assert.equal(P.parseUserAbstraction(B.userAbstraction), "disabled");
  assert.equal(P.parseUserAbstraction(FRESH.userAbstraction), "default");
  for (const bad of [null, 42, "", {}, ["unifiedAccount"]]) assert.equal(P.parseUserAbstraction(bad), null);
  /* Documented: unified and portfolio margin keep every balance in the spot
     clearinghouse. Standard (disabled) and the discontinued dexAbstraction keep
     USDC in the perp one. "default" is not documented: Hyperliquid's own
     frontend treats an unset mode as not-unified for balances, and 6 of 6 live
     default-mode traders measured hold their USDC in the perp clearinghouse. */
  assert.equal(P.balanceSourceFor("unifiedAccount"), "spot");
  assert.equal(P.balanceSourceFor("portfolioMargin"), "spot");
  assert.equal(P.balanceSourceFor("disabled"), "perp");
  assert.equal(P.balanceSourceFor("dexAbstraction"), "perp");
  assert.equal(P.balanceSourceFor("default"), "perp");
  assert.equal(P.balanceSourceFor("someFutureMode"), null, "a mode we do not know picks no source");
  assert.equal(P.balanceSourceFor(null), null);
});

/* ── clearinghouse: positions exactly as Hyperliquid sends them ─────────── */

test("B1) positions: Hyperliquid's own figures, strings become numbers, nothing re-derived", () => {
  const ch = P.parseClearinghouse(A.clearinghouseState);
  assert.equal(ch.time, 1790070457694);
  assert.equal(ch.accountValue, 109825.54706);
  assert.equal(ch.withdrawable, 0, "a measured zero stays zero");
  assert.equal(ch.crossMaintenanceMarginUsed, 32283.813808);
  assert.equal(ch.totalMarginUsed, 66965.038903);
  assert.equal(ch.positions.length, 6);
  const btc = ch.positions.find((p) => p.coin === "BTC");
  assert.deepEqual(btc, {
    coin: "BTC", dex: "", szi: 4.81064, side: "long", entryPx: 80926.7, positionValue: 414330.80192,
    unrealizedPnl: 25021.102078, returnOnEquity: 2.5708172273, liquidationPx: 61092.0544535562,
    leverage: { type: "cross", value: 40, rawUsd: null }, marginUsed: 10358.270048, maxLeverage: 40,
    cumFunding: { allTime: 841.398435, sinceOpen: 693.73039, sinceChange: 44.510097 },
  });
  for (const p of ch.positions) onlyNumbersOrNull(p, p.coin);
});

test("B2) a null liquidation price from Hyperliquid stays null; shorts are shorts; isolated keeps its rawUsd", () => {
  const a = P.parseClearinghouse(A.clearinghouseState);
  assert.equal(a.positions.find((p) => p.coin === "AR").liquidationPx, null);
  assert.equal(a.positions.find((p) => p.coin === "HYPE").liquidationPx, null);
  const b = P.parseClearinghouse(B.clearinghouseState);
  assert.deepEqual(b.positions.map((p) => [p.coin, p.side, p.szi]), [["BTC", "short", -0.17449], ["SOL", "short", -135.88]]);
  assert.equal(b.positions[0].cumFunding.sinceOpen, -14.94601, "funding paid is negative, as sent");
  const c = P.parseClearinghouse(C.clearinghouseState);
  assert.deepEqual(c.positions[0].leverage, { type: "isolated", value: 36, rawUsd: 15758.314236 });
  assert.equal(c.positions[0].cumFunding.sinceOpen, 0);
});

test("B3) the WebSocket frame parses to the same shape, and the dex is carried", () => {
  const ws = P.parseClearinghouse(WS.clearinghouseStateA.data);
  assert.equal(ws.dex, "");
  assert.equal(ws.accountValue, 111021.489471);
  assert.equal(ws.withdrawable, 670.298123);
  assert.equal(ws.positions.length, 6);
  const xyz = P.parseClearinghouse(A.xyzClearinghouseState, { dex: "xyz" });
  assert.equal(xyz.dex, "xyz");
  assert.equal(xyz.positions[0].coin, "xyz:HOOD");
  assert.equal(xyz.positions[0].dex, "xyz");
});

test("B4) unreadable answers are null, not an empty account; a position with an unreadable size is kept, unknown", () => {
  for (const bad of [null, "x", [], {}, { assetPositions: "no" }]) assert.equal(P.parseClearinghouse(bad), null, JSON.stringify(bad));
  const j = structuredClone(B.clearinghouseState);
  j.assetPositions[0].position.szi = "abc";
  j.assetPositions[0].position.unrealizedPnl = "";
  const ch = P.parseClearinghouse(j);
  assert.equal(ch.positions.length, 2, "never silently dropped");
  assert.equal(ch.positions[0].szi, null);
  assert.equal(ch.positions[0].side, null);
  assert.equal(ch.positions[0].unrealizedPnl, null);
});

/* ── spot clearinghouse ────────────────────────────────────────────────── */

test("C1) spot state: USDC total and hold, and Hyperliquid's available-after-maintenance, REST or WS", () => {
  const s = P.parseSpotState(A.spotClearinghouseState);
  assert.deepEqual(s.usdc, { total: 155293.727137, hold: 114127.591702 });
  assert.equal(s.availableAfterMaintenance[0], 118907.833065);
  const w = P.parseSpotState(WS.spotStateA.data);
  assert.deepEqual(w.usdc, { total: 155650.43365, hold: 114456.298811 });
  const f = P.parseSpotState(FRESH.spotClearinghouseState);
  assert.deepEqual(f.usdc, { total: 0, hold: 0 }, "an answered spot state with no USDC row holds no USDC");
  for (const bad of [null, {}, { balances: "x" }]) assert.equal(P.parseSpotState(bad), null);
});

/* ── the Perp balance: ONE source, chosen by mode ──────────────────────── */

const perpOf = (x) => P.parseClearinghouse(x.clearinghouseState);
const spotOf = (x) => P.parseSpotState(x.spotClearinghouseState);

test("D1) unified: the USDC balance is the SPOT total; available is total minus hold; the perp withdrawable is ignored", () => {
  const b = BAL.resolvePerpBalance({ role: "user", mode: "unifiedAccount", perp: perpOf(A), spot: spotOf(A) });
  assert.equal(b.answered, true);
  assert.equal(b.source, "spot");
  assert.equal(b.equityUsdc, 155293.727137);
  assert.equal(b.holdUsdc, 114127.591702);
  near(b.availableUsdc, 155293.727137 - 114127.591702);
  assert.equal(b.idleSpotUsdc, null, "in unified mode the spot USDC IS the balance, not an idle extra");
  assert.notEqual(b.equityUsdc, 109825.54706, "not the per-dex accountValue");
  assert.notEqual(b.availableUsdc, 0, "not the per-dex withdrawable, which is not meaningful in unified mode");
  /* Why the spot total is the equity: it moved cent-for-cent with the perp
     accountValue between two live pushes. */
  const [m1, m2] = MEASURED.unifiedCoMove;
  near(m2.spotTotal - m1.spotTotal, m2.accountValue - m1.accountValue, 1e-6);
});

test("D2) standard: equity is accountValue, available is withdrawable (a measured 0 stays 0), spot USDC is reported apart", () => {
  const b = BAL.resolvePerpBalance({ role: "user", mode: "disabled", perp: perpOf(B), spot: spotOf(B) });
  assert.equal(b.source, "perp");
  assert.equal(b.equityUsdc, 2900.93691);
  assert.equal(b.availableUsdc, 0);
  assert.equal(b.holdUsdc, null);
  assert.equal(b.idleSpotUsdc, 9380.04956985, "spot USDC in standard mode is NOT perp margin until moved");
  assert.notEqual(b.equityUsdc, 2900.93691 + 9380.04956985, "never blended");
});

test("D3) default: read like standard (the venue's own rule, measured 6 of 6); a spot state with no USDC is a known zero apart", () => {
  const b = BAL.resolvePerpBalance({ role: "user", mode: "default", perp: perpOf(DEFAULT_MODE), spot: spotOf(DEFAULT_MODE) });
  assert.equal(b.source, "perp");
  assert.equal(b.equityUsdc, 109945.428951);
  assert.equal(b.availableUsdc, 61867.569553);
  assert.equal(b.idleSpotUsdc, 0);
});

test("D4) a never-used address is a KNOWN zero, whatever else is still loading", () => {
  const b = BAL.resolvePerpBalance({ role: "missing", mode: null, perp: null, spot: null });
  assert.equal(b.answered, true);
  assert.equal(b.equityUsdc, 0);
  assert.equal(b.availableUsdc, 0);
  assert.equal(b.reason, "new-account");
  const f = BAL.resolvePerpBalance({ role: "missing", mode: "default", perp: perpOf(FRESH), spot: spotOf(FRESH) });
  assert.equal(f.equityUsdc, 0);
  assert.equal(f.reason, "new-account");
});

test("D4b) a role answer of never-used is outranked by a clearinghouse that already shows USDC (the first deposit landed)", () => {
  const funded = P.parseClearinghouse({ ...FRESH.clearinghouseState, marginSummary: { ...FRESH.clearinghouseState.marginSummary, accountValue: "18.778" }, withdrawable: "18.778" });
  const b = BAL.resolvePerpBalance({ role: "missing", mode: "default", perp: funded, spot: spotOf(FRESH) });
  assert.equal(b.reason, null);
  assert.equal(b.equityUsdc, 18.778, "not a confident zero over real money");
  const noMode = BAL.resolvePerpBalance({ role: "missing", mode: null, perp: funded, spot: null });
  assert.equal(noMode.equityUsdc, null);
  assert.equal(noMode.reason, "mode-unanswered");
});

test("D5) unknown stays unknown: no mode, an unknown mode, or the chosen clearinghouse unanswered -> null with a reason", () => {
  const cases = [
    [{ role: "user", mode: null, perp: perpOf(B), spot: spotOf(B) }, "mode-unanswered"],
    [{ role: null, mode: null, perp: perpOf(B), spot: spotOf(B) }, "mode-unanswered"],
    [{ role: "user", mode: "someFutureMode", perp: perpOf(B), spot: spotOf(B) }, "mode-unknown"],
    [{ role: "user", mode: "unifiedAccount", perp: perpOf(A), spot: null }, "spot-unanswered"],
    [{ role: "user", mode: "disabled", perp: null, spot: spotOf(B) }, "perp-unanswered"],
  ];
  for (const [input, reason] of cases) {
    const b = BAL.resolvePerpBalance(input);
    assert.equal(b.answered, false, reason);
    assert.equal(b.reason, reason);
    for (const k of ["equityUsdc", "availableUsdc", "holdUsdc"]) assert.equal(b[k], null, `${reason} ${k}`);
  }
});

test("D6) an agent address has no balance of its own: dash, and the master is named", () => {
  const b = BAL.resolvePerpBalance({ role: "agent", master: ADDR.A, mode: "default", perp: perpOf(FRESH), spot: spotOf(FRESH) });
  assert.equal(b.answered, false);
  assert.equal(b.reason, "agent-address");
  assert.equal(b.equityUsdc, null);
  assert.equal(b.master, ADDR.A);
});

test("D7) portfolio margin: the USDC figure is honest about being USDC only when other collateral is held", () => {
  const spot = P.parseSpotState({ balances: [{ coin: "USDC", token: 0, total: "500.0", hold: "100.0", entryNtl: "0.0" }, { coin: "HYPE", token: 150, total: "3.0", hold: "0.0", entryNtl: "120.0" }] });
  const b = BAL.resolvePerpBalance({ role: "user", mode: "portfolioMargin", perp: null, spot });
  assert.equal(b.source, "spot");
  assert.equal(b.equityUsdc, 500);
  assert.equal(b.complete, false);
  assert.equal(b.incompleteReason, "other-collateral");
  const onlyUsdc = BAL.resolvePerpBalance({ role: "user", mode: "unifiedAccount", perp: null, spot: spotOf(A) });
  assert.equal(onlyUsdc.complete, true);
});

/* ── open orders and TP/SL per coin ────────────────────────────────────── */

test("E1) open orders keep Hyperliquid's trigger fields; TP and SL are told apart by the order type", () => {
  const orders = P.parseOpenOrders(A.frontendOpenOrders);
  assert.equal(orders.length, 7);
  const zec = orders[0];
  assert.deepEqual(zec, {
    coin: "ZEC", oid: 552794034828, cloid: null, side: "sell", limitPx: 1287, sz: 30, origSz: 30,
    timestamp: 1790069152237, isTrigger: true, triggerPx: 1430, triggerCondition: "Price below 1430",
    orderType: "Stop Market", reduceOnly: true, isPositionTpsl: false, tif: null, tpsl: "sl", children: [],
  });
  assert.deepEqual(orders.map((o) => [o.coin, o.tpsl]), [["ZEC", "sl"], ["NEAR", "tp"], ["NEAR", "sl"], ["NEAR", "sl"], ["NEAR", "sl"], ["ETH", "sl"], ["ETH", "sl"]]);
  const ws = P.parseOpenOrders(WS.openOrdersA_first2.data);
  assert.deepEqual(ws.map((o) => o.oid), [552794034828, 552789268425]);
});

test("E2) TP/SL per coin: every live trigger listed, the POSITION TP/SL named, size 0 meaning the whole position", () => {
  const byCoin = P.tpslByCoin(P.parseOpenOrders(A.frontendOpenOrders));
  assert.equal(byCoin.NEAR.tp.length, 1);
  assert.equal(byCoin.NEAR.sl.length, 3);
  assert.equal(byCoin.NEAR.tp[0].triggerPx, 7.4);
  assert.equal(byCoin.NEAR.positionTp, null, "these are fixed-size TP/SL, not position TP/SL");
  assert.equal(byCoin.ETH.sl.length, 2);
  assert.equal(byCoin.BTC, undefined);
  const c = P.tpslByCoin(P.parseOpenOrders(C.frontendOpenOrders));
  assert.equal(c.BTC.positionSl.oid, 552810049453);
  assert.equal(c.BTC.positionSl.sz, 0);
  assert.equal(c.BTC.positionSl.side, "buy", "a stop on a short buys");
  assert.equal(c.BTC.positionTp, null);
});

test("E3) TP/SL children waiting on an unfilled entry are pending, not live", () => {
  /* synthetic: an entry with normalTpsl children, shape from frontendOpenOrders */
  const entry = { coin: "SOL", side: "B", limitPx: "110.0", sz: "1.0", oid: 1, timestamp: 1, triggerCondition: "N/A", isTrigger: false, triggerPx: "0.0",
    children: [
      { coin: "SOL", side: "A", limitPx: "130.0", sz: "1.0", oid: 2, timestamp: 1, triggerCondition: "Price above 130", isTrigger: true, triggerPx: "130.0", children: [], isPositionTpsl: false, reduceOnly: true, orderType: "Take Profit Market", origSz: "1.0", tif: null, cloid: null },
    ],
    isPositionTpsl: false, reduceOnly: false, orderType: "Limit", origSz: "1.0", tif: "Gtc", cloid: null };
  const byCoin = P.tpslByCoin(P.parseOpenOrders([entry]));
  assert.equal(byCoin.SOL.tp.length, 0);
  assert.equal(byCoin.SOL.pending.length, 1);
  assert.equal(byCoin.SOL.pending[0].tpsl, "tp");
  assert.equal(byCoin.SOL.pending[0].parentOid, 1);
});

test("E4) a trigger that is NOT reduce-only opens or adds to a position: it is never drawn as the position's TP or SL", () => {
  /* synthetic, the shape of A's live Stop Market with reduceOnly false: a stop ENTRY */
  const stopEntry = { ...A.frontendOpenOrders[0], oid: 11, reduceOnly: false, side: "B", triggerCondition: "Price above 1600", triggerPx: "1600.0" };
  const orders = P.parseOpenOrders([A.frontendOpenOrders[0], stopEntry]);
  assert.deepEqual(orders.map((o) => [o.oid, o.tpsl, o.reduceOnly]), [[552794034828, "sl", true], [11, "sl", false]], "the order keeps Hyperliquid's own kind");
  const zec = P.tpslByCoin(orders).ZEC;
  assert.deepEqual(zec.sl.map((o) => o.oid), [552794034828], "only the reduce-only stop protects the position");
  assert.deepEqual(zec.tp, []);
  assert.deepEqual(zec.entryTriggers.map((o) => o.oid), [11]);
  assert.deepEqual(P.tpslByCoin(P.parseOpenOrders(A.frontendOpenOrders)).NEAR.entryTriggers, []);
});

/* ── fills ─────────────────────────────────────────────────────────────── */

test("F1) fills: numbers, sides, per coin, newest first; REST and the WS snapshot merge by trade id", () => {
  const rest = P.parseFills(A.userFillsNewest6);
  assert.equal(rest.length, 6);
  const f = rest[0];
  assert.equal(f.coin, "AR");
  assert.equal(f.side, "sell");
  assert.equal(f.px, 4.3647);
  assert.equal(f.closedPnl, -432.23942);
  assert.equal(f.dir, "Close Long");
  assert.equal(f.liquidation, null);
  const snap = P.parseFills(WS.userFillsSnapshotA_4overlapping.data);
  assert.equal(snap.length, 4);
  const merged = P.mergeFills(rest, snap);
  assert.equal(merged.length, 6, "the live WS snapshot overlapped the REST answer completely (30 of 30)");
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].time >= merged[i].time);
  const byCoin = P.fillsByCoin(merged);
  assert.ok(byCoin.AR.length >= 1);
});

test("F2) fill history past the venue's 2000 cap is flagged partial, never presented as complete", () => {
  assert.equal(P.HL_FILLS_CAP, 2000);
  assert.equal(P.fillsPartial(A.userFillsCount), false, "1775 fills: the whole recent history");
  assert.equal(P.fillsPartial(2000), true);
  assert.equal(P.fillsPartial(null), null, "unknown count, unknown completeness");
});

/* ── ledger: deposits the Deposit sheet can wait for ───────────────────── */

test("G1) the live CCTP deposit line is an inbound USDC credit to the perp dex", () => {
  const [line] = P.parseLedger(A.userNonFundingLedgerUpdates, ADDR.A);
  assert.equal(line.type, "send");
  assert.equal(line.direction, "in");
  assert.equal(line.usdc, 50137.38);
  assert.equal(line.token, "USDC");
  assert.equal(line.from, "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24", "Circle's CoreDepositWallet");
  assert.equal(line.toDex, "");
  const ws = P.parseLedger(WS.ledgerSnapshotA.data, ADDR.A);
  assert.deepEqual(ws.map((l) => l.hash), [line.hash]);
});

test("G2) directions: bridge deposit in, withdraw out, own-account moves internal, a non-USDC token has no USDC amount", () => {
  const me = ADDR.B;
  /* synthetic lines, shapes from the WsUserNonFundingLedgerUpdates definitions */
  const lines = P.parseLedger([
    { time: 5, hash: "0x05", delta: { type: "deposit", usdc: "100.0" } },
    { time: 4, hash: "0x04", delta: { type: "withdraw", usdc: "20.0", nonce: 1, fee: "1.0" } },
    { time: 3, hash: "0x03", delta: { type: "accountClassTransfer", usdc: "10.0", toPerp: true } },
    { time: 2, hash: "0x02", delta: { type: "send", user: me, destination: me, sourceDex: "spot", destinationDex: "", token: "USDC", amount: "7.0", usdcValue: "7.0", fee: "0.0" } },
    { time: 1, hash: "0x01", delta: { type: "spotTransfer", token: "HYPE", amount: "2.0", usdcValue: "90.0", user: "0x1111111111111111111111111111111111111111", destination: me, fee: "0.0" } },
    { time: 0, hash: "0x00", delta: { type: "internalTransfer", usdc: "3.0", user: me, destination: "0x2222222222222222222222222222222222222222", fee: "0.0" } },
  ], me);
  assert.deepEqual(lines.map((l) => [l.type, l.direction, l.usdc]), [
    ["deposit", "in", 100], ["withdraw", "out", 20], ["accountClassTransfer", "internal", 10],
    ["send", "internal", 7], ["spotTransfer", "in", null], ["internalTransfer", "out", 3],
  ]);
  assert.equal(lines[4].usdValue, 90);
  assert.equal(lines[4].token, "HYPE");
});

test("G3) arrivals: inbound USDC credits at or after a moment, at or above a floor, newest first", () => {
  const me = ADDR.FRESH;
  /* synthetic Relay-style credit: a solver account sends USDC to the user's perp dex */
  const lines = P.parseLedger([
    { time: 2000, hash: "0xb", delta: { type: "send", user: "0x3333333333333333333333333333333333333333", destination: me, sourceDex: "spot", destinationDex: "", token: "USDC", amount: "18.778", usdcValue: "18.778", fee: "0.0" } },
    { time: 1000, hash: "0xa", delta: { type: "deposit", usdc: "5.0" } },
  ], me);
  assert.deepEqual(P.arrivalsSince(lines, 1500).map((l) => l.hash), ["0xb"]);
  assert.deepEqual(P.arrivalsSince(lines, 0, { minUsdc: 10 }).map((l) => l.hash), ["0xb"]);
  assert.deepEqual(P.arrivalsSince(lines, 0).map((l) => l.hash), ["0xb", "0xa"]);
  assert.deepEqual(P.arrivalsSince(null, 0), []);
});

/* ── events a screen can toast ─────────────────────────────────────────── */

const me = ADDR.B;
const fill = (over) => ({ coin: "BTC", px: "90000.0", sz: "0.1", side: "B", time: 10, startPosition: "-0.1", dir: "Close Short", closedPnl: "-50.0", hash: "0xh", oid: 1, crossed: true, fee: "1.0", tid: 1, feeToken: "USDC", ...over });

test("H1) liquidation and ADL are read from fills the way Hyperliquid's own frontend reads them", () => {
  /* synthetic fills: field shapes from the WsFill definition; the direction
     strings are the constants Hyperliquid's frontend compares against */
  const fills = P.parseFills([
    fill({ tid: 1, liquidation: { liquidatedUser: me, markPx: "90010.0", method: "market" } }),
    fill({ tid: 2, liquidation: { liquidatedUser: "0x4444444444444444444444444444444444444444", markPx: "90010.0", method: "market" } }),
    fill({ tid: 3, dir: "Auto-Deleveraging" }),
    fill({ tid: 4, dir: "Liquidated Isolated Short" }),
    fill({ tid: 5 }),
  ]);
  const ev = EV.eventsFromFills(fills, me);
  assert.deepEqual(ev.map((e) => [e.kind, e.detail.tid]), [["liquidation", 1], ["adl", 3], ["liquidation", 4]],
    "a fill where SOMEONE ELSE was liquidated is a counterparty fill, not an event");
});

test("H2) ledger, userEvents, order updates and notifications each become events", () => {
  const led = EV.eventsFromLedger(P.parseLedger([{ time: 20, hash: "0xl", delta: { type: "liquidation", accountValue: "12.5", leverageType: "Isolated", liquidatedPositions: [{ coin: "BTC", szi: "-0.1" }] } }], me));
  assert.deepEqual(led.map((e) => [e.kind, e.coin]), [["liquidation", "BTC"]]);
  const ue = EV.eventsFromUserEvents({ liquidation: { lid: 9, liquidator: "0x5555555555555555555555555555555555555555", liquidated_user: me, liquidated_ntl_pos: "900.0", liquidated_account_value: "12.0" } }, me, 30);
  assert.deepEqual(ue.map((e) => e.kind), ["liquidation"]);
  assert.deepEqual(EV.eventsFromUserEvents({ liquidation: { lid: 9, liquidator: "0x5", liquidated_user: "0x6666666666666666666666666666666666666666" } }, me, 30), []);
  const cancels = EV.eventsFromUserEvents({ nonUserCancel: [{ coin: "ETH", oid: 7 }, { coin: "SOL", oid: 8 }] }, me, 31);
  assert.deepEqual(cancels.map((e) => [e.kind, e.coin]), [["systemCancel", "ETH"], ["systemCancel", "SOL"]]);
  assert.deepEqual(EV.eventsFromUserEvents({ funding: { coin: "BTC", usdc: "-1.0" } }, me, 32), [], "hourly funding is not a toast");
  const ou = EV.eventsFromOrderUpdates([{ order: { coin: "BTC", side: "A", limitPx: "1.0", sz: "0.0", oid: 11, timestamp: 1, origSz: "0.1" }, status: "marginCanceled", statusTimestamp: 40 }]);
  assert.deepEqual(ou.map((e) => [e.kind, e.status, e.coin]), [["order", "marginCanceled", "BTC"]]);
  const n = EV.eventFromNotification({ notification: "Your order was filled" }, 50);
  assert.equal(n.kind, "notification");
  assert.equal(n.text, "Your order was filled");
  assert.equal(EV.eventFromNotification({ notification: "" }, 50), null);
});

test("H3) one liquidation seen by several streams is one group: the first to arrive leads, the rest follow", () => {
  const a = EV.eventsFromFills(P.parseFills([fill({ tid: 1, time: 1000, liquidation: { liquidatedUser: me, markPx: "1", method: "market" } })]), me);
  const b = EV.eventsFromLedger(P.parseLedger([{ time: 4000, hash: "0xl", delta: { type: "liquidation", accountValue: "1", leverageType: "Cross", liquidatedPositions: [{ coin: "BTC", szi: "1" }] } }], me));
  const r1 = EV.mergeEvents([], a);
  assert.equal(r1.added.length, 1);
  assert.equal(r1.added[0].lead, true);
  const r2 = EV.mergeEvents(r1.events, b);
  assert.equal(r2.added.length, 1);
  assert.equal(r2.added[0].lead, false, "same liquidation, second stream: grouped, not a second toast");
  assert.equal(r2.added[0].groupId, r1.added[0].groupId);
  const r3 = EV.mergeEvents(r2.events, a);
  assert.equal(r3.added.length, 0, "the same event twice is one event");
  const later = EV.eventsFromLedger(P.parseLedger([{ time: 999999, hash: "0xm", delta: { type: "liquidation", accountValue: "1", leverageType: "Cross", liquidatedPositions: [{ coin: "BTC", szi: "1" }] } }], me));
  assert.equal(EV.mergeEvents(r3.events, later).added[0].lead, true, "a liquidation minutes later is a new one");
});
