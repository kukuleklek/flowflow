/**
 * test-avax-registry — THE FLOW REGISTRY (src/avax/flows.js): every Avax-side money
 * move written down BEFORE the window that moves money, and the plan reviewer's
 * blocker held — a reload can never bring a Confirm back. Plan v2 §3.7, §2.9, §3.6.
 *
 * Nothing here touches a network or a wallet. Storage is an in-memory fake that can
 * drop writes, throw on write (quota), throw on read (blocked site data) or hold junk.
 *
 * Run: node --test scripts/test-avax-registry.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const FL = await imp("src/avax/flows.js");
const OM = await imp("src/lib/relay/ownMove.js");
const MI = await imp("src/lib/relay/moveIn.js");

const OWN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T0 = 1792044000000;

class MemStorage {
  constructor() { this.m = new Map(); this.drop = false; this.throwOnSet = false; this.throwOnGet = false; }
  getItem(k) { if (this.throwOnGet) throw new Error("SecurityError"); return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.throwOnSet) throw new Error("QuotaExceededError"); if (!this.drop) this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const clock = (t = T0) => { const c = { t }; c.now = () => c.t; return c; };
/* A page load: a fresh registry (new tabId) on the same storage. */
const page = (storage, c, own = OWN) => FL.createFlowRegistry({ storage, own, now: c.now });

test("R1) one key per account, lowercase; no address in any record; unknown keys refused", () => {
  assert.equal(FL.flowsKey(OWN), `flowflow.flows.v1:${OWN.toLowerCase()}`);
  assert.equal(FL.flowsKey("0x0000000000000000000000000000000000000000"), null);
  assert.equal(FL.flowsKey("nope"), null);
  const s = new MemStorage();
  const c = clock();
  const reg = page(s, c);
  const rec = reg.begin({ kind: "move-in", amounts: { out: "6", in: "6.342288", topupUsd: 0.3 }, maxDebit: 6.7, envelopeHash: "sha256:abc" });
  reg.confirm(rec.id);
  reg.beforeWindow(rec.id, { requestId: `0x${"17".repeat(32)}`, hlNonce: 1792044083340 });
  const text = s.getItem(FL.flowsKey(OWN));
  assert.doesNotMatch(text, /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/, "the stored text holds no address");
  assert.doesNotMatch(text, /recipient/i);
  /* Every way of smuggling an address or an unknown field in is refused before it is stored. */
  const bad = [
    { recipient: OTHER_ACCOUNT },
    { requestId: OTHER_ACCOUNT },
    { why: `sent to ${OTHER_ACCOUNT}` },
    { amounts: { to: OTHER_ACCOUNT } },
    { steps: [{ kind: "swap", state: "done", to: "x" }] },
    { quote: { any: 1 } },
  ];
  const base = reg.get(rec.id);
  for (const patch of bad) {
    assert.throws(() => FL.sanitizeRecord({ ...base, ...patch }), (e) => e.code === "bad-record", JSON.stringify(patch));
  }
  /* …and through the registry's own calls, nothing of it lands in storage. */
  assert.throws(() => reg.beforeWindow(rec.id, { recipient: OTHER_ACCOUNT }), (e) => e.code === "bad-record");
  assert.throws(() => reg.update(rec.id, { txHash: OTHER_ACCOUNT }), (e) => e.code === "bad-record");
  assert.doesNotMatch(s.getItem(FL.flowsKey(OWN)), /70997970/i);
  assert.throws(() => reg.begin({ kind: "withdraw-to-anyone" }), (e) => e.code === "bad-record");
  for (const kind of FL.FLOW_KINDS) assert.ok(page(new MemStorage(), c).begin({ kind }), kind);
});

test("R2) 🔴 Confirm is shown only by the page that made the card, inside 10 minutes — a reload never brings it back", () => {
  const s = new MemStorage();
  const c = clock();
  const a = page(s, c);
  const rec = a.begin({ kind: "swap", amounts: { in: "2" } });
  assert.equal(a.view(a.get(rec.id)).confirmable, true);
  /* Reload: same storage, new page. */
  const b = page(s, c);
  const v = b.view(b.get(rec.id));
  assert.equal(v.confirmable, false);
  assert.equal(v.askAgain, true);
  assert.equal(b.confirm(rec.id).code, "ask-again");
  /* The original page, after 10 minutes. */
  c.t += FL.MONEY_CARD_TTL_MS;
  assert.equal(a.view(a.get(rec.id)).confirmable, false);
  assert.equal(a.confirm(rec.id).code, "ask-again");
  assert.equal(a.expireStale(), 1);
  assert.equal(a.get(rec.id).state, "expired");
});

test("R3) 🔴 the load rule: every in-flight state becomes UNKNOWN (persisted, resumeFrom kept); settled ones stay; stale reviews expire", () => {
  const s = new MemStorage();
  const c = clock();
  const rec = (id, state, extra = {}) => ({ id, kind: "move-in", state, startedAt: T0, updatedAt: T0, tabId: "tOld", ...extra });
  FL.writeFlows(s, OWN, [
    rec("fconfirmed", "confirmed"),
    rec("fsending1", "sending", { requestId: `0x${"ab".repeat(32)}`, hlNonce: 1792044083340 }),
    rec("farriving", "arriving", { txHash: `0x${"cd".repeat(32)}` }),
    rec("fdone0001", "done", { evidence: "receipt 1" }),
    rec("frefund01", "refunded", { evidence: "status refund" }),
    rec("freview01", "review"),
  ]);
  c.t = T0 + FL.MONEY_CARD_TTL_MS + 1;
  const b = page(s, c);
  assert.equal(b.loaded.changed, 4);
  for (const [id, st] of [["fconfirmed", "confirmed"], ["fsending1", "sending"], ["farriving", "arriving"]]) {
    const r = b.get(id);
    assert.equal(r.state, "unknown", st);
    assert.equal(r.resumeFrom, st);
    const v = b.view(r);
    assert.equal(v.confirmable, false);
    assert.equal(v.watching, true);
  }
  assert.equal(b.get("fsending1").requestId, `0x${"ab".repeat(32)}`, "what to watch is kept");
  assert.equal(b.get("fdone0001").state, "done");
  assert.equal(b.get("frefund01").state, "refunded");
  assert.equal(b.get("freview01").state, "expired");
  /* Persisted: a third page reads the same, with nothing left to map. */
  const third = page(s, c);
  assert.equal(third.loaded.changed, 0);
  assert.equal(third.get("fsending1").state, "unknown");
  /* No record anywhere is confirmable after a reload — including a fresh review from the dead page. */
  FL.writeFlows(s, OWN, [...third.list(), rec("freview02", "review", { startedAt: c.t - 1000 })]);
  const fourth = page(s, c);
  for (const r of fourth.list()) assert.equal(fourth.view(r).confirmable, false, r.state);
  assert.equal(fourth.view(fourth.get("freview02")).askAgain, true);
});

test("R4) the Confirm gate: a double tap confirms once; nothing confirms while another move runs or is unknown", () => {
  const s = new MemStorage();
  const c = clock();
  const a = page(s, c);
  const one = a.begin({ kind: "move-out" });
  const two = a.begin({ kind: "swap" });
  assert.equal(a.confirm(one.id).ok, true);
  assert.equal(a.confirm(one.id).code, "already");
  assert.equal(a.confirm(two.id).code, "busy");
  assert.equal(a.canStart().code, "busy");
  a.beforeWindow(one.id, {});
  a.markUnknown(one.id, "not_confirmed");
  assert.equal(a.confirm(two.id).code, "unknown");
  assert.equal(a.canStart().code, "unknown");
  a.finish(one.id, "done", "status success + Perp balance +1.97");
  assert.equal(a.canStart().ok, true);
  assert.equal(a.confirm(two.id).ok, true);
});

test("R5) beforeWindow writes, READS BACK, and throws when storage did not keep it — so no window opens", () => {
  const s = new MemStorage();
  const c = clock();
  const a = page(s, c);
  const r = a.begin({ kind: "swap" });
  a.confirm(r.id);
  const ok = a.beforeWindow(r.id, { step: "approve", txNonce: 7 });
  assert.equal(ok.state, "sending");
  assert.equal(a.get(r.id).txNonce, 7);
  s.drop = true;
  assert.throws(() => a.beforeWindow(r.id, { step: "swap" }), (e) => e.code === "storage");
  s.drop = false;
  s.throwOnSet = true;
  assert.throws(() => a.beforeWindow(r.id, { step: "swap" }), (e) => e.code === "storage");
  s.throwOnSet = false;
  /* Only the page that confirmed it may open its windows. */
  const b = page(s, c);
  assert.throws(() => b.beforeWindow(r.id, {}), (e) => e.code === "not-owner");
  /* A review card cannot open a window: Confirm first. */
  const r2 = page(new MemStorage(), c);
  const x = r2.begin({ kind: "swap" });
  assert.throws(() => r2.beforeWindow(x.id, {}), (e) => e.code === "bad-state");
});

test("R6) storage that cannot be used: no money flow starts in this browser (never read as 'nothing in flight')", () => {
  const c = clock();
  const blocked = new MemStorage();
  blocked.throwOnGet = true;
  const a = page(blocked, c);
  assert.equal(a.available(), false);
  assert.equal(a.canStart().code, "storage");
  assert.throws(() => a.begin({ kind: "swap" }), (e) => e.code === "storage");
  const quota = new MemStorage();
  quota.throwOnSet = true;
  const b = page(quota, c);
  assert.equal(b.available(), false);
  assert.equal(b.canStart().code, "storage");
  const junk = new MemStorage();
  junk.setItem(FL.flowsKey(OWN), "{not json");
  const d = page(junk, c);
  assert.equal(d.canStart().code, "storage");
  assert.deepEqual(FL.readFlows(junk, OWN), { ok: false, code: "corrupt", flows: [] });
  const noStore = FL.createFlowRegistry({ storage: null, own: OWN, now: c.now });
  assert.equal(noStore.canStart().code, "storage");
  /* A record carrying an address in storage (tampering) is corrupt, not trusted. */
  const t = new MemStorage();
  t.setItem(FL.flowsKey(OWN), JSON.stringify({ v: 1, flows: [{ id: "fabcdef1", kind: "swap", state: "review", startedAt: T0, why: OTHER_ACCOUNT }] }));
  assert.equal(FL.readFlows(t, OWN).code, "corrupt");
});

test("R7) cross-tab: one tab's move locks the others; a second tab's load rule cannot steal it, the owner carries on", () => {
  const s = new MemStorage();
  const c = clock();
  const a = page(s, c);
  const r = a.begin({ kind: "swap" });
  a.confirm(r.id);
  a.beforeWindow(r.id, { step: "approve" });
  /* Tab B opens while A is mid-swap. */
  const b = page(s, c);
  assert.equal(b.get(r.id).state, "unknown");
  assert.equal(b.get(r.id).why, FL.LOADED_ELSEWHERE);
  assert.equal(b.canStart().ok, false);
  assert.throws(() => b.beforeWindow(r.id, {}), (e) => e.code === "not-owner");
  assert.throws(() => b.cancel(r.id, "x"), (e) => e.code === "bad-state", "another tab cannot call it nothing");
  /* A — still alive, still the owner — opens its next window and finishes. */
  assert.equal(a.beforeWindow(r.id, { step: "swap" }).state, "sending");
  a.update(r.id, { state: "arriving" });
  a.finish(r.id, "done", "receipt status 1 + BTC.b +0.00002461");
  assert.equal(b.get(r.id).state, "done");
  assert.equal(b.canStart().ok, true);
  /* An unknown that is an OUTCOME (lost reply) is not resumable, even by its owner. */
  const r2 = a.begin({ kind: "move-in" });
  a.confirm(r2.id);
  a.beforeWindow(r2.id, {});
  a.markUnknown(r2.id, "not_confirmed");
  assert.throws(() => a.beforeWindow(r2.id, {}), (e) => e.code === "bad-state");
  assert.throws(() => a.update(r2.id, { state: "arriving" }), (e) => e.code === "bad-state");
  assert.throws(() => a.cancel(r2.id, "x"), (e) => e.code === "bad-state");
  /* Accounts are separate registries. */
  assert.equal(page(s, c, OTHER_ACCOUNT).canStart().ok, true);
});

test("R8) settling: only with evidence; 'nothing moved' is refused once money may have left", () => {
  const s = new MemStorage();
  const c = clock();
  const a = page(s, c);
  const r = a.begin({ kind: "move-out" });
  a.confirm(r.id);
  a.beforeWindow(r.id, { permitNonce: `0x${"cd".repeat(32)}`, validBefore: 1792044682 });
  a.update(r.id, { state: "arriving" });
  assert.throws(() => a.finish(r.id, "done", ""), (e) => e.code === "no-evidence");
  assert.throws(() => a.finish(r.id, "error-before-money", "x"), (e) => e.code === "bad-state");
  assert.throws(() => a.cancel(r.id, "user"), (e) => e.code === "bad-state");
  assert.throws(() => a.update(r.id, { state: "done" }), (e) => e.code === "bad-state", "update never settles");
  a.markUnknown(r.id, "status unknown");
  assert.equal(a.get(r.id).resumeFrom, "arriving");
  const fin = a.finish(r.id, "refunded", "status refund; USDC back in the Avax Wallet");
  assert.equal(fin.state, "refunded");
  /* Settled is settled. */
  assert.equal(a.finish(r.id, "done", "late").state, "refunded");
  /* Before any money window: cancel is fine. */
  const r2 = a.begin({ kind: "swap" });
  a.confirm(r2.id);
  assert.equal(a.cancel(r2.id, "user closed the window").state, "cancelled");
});

test("R9) subscribeFlows: another tab's write reaches this page; other keys are ignored", () => {
  const s = new MemStorage();
  const c = clock();
  const handlers = [];
  const target = { addEventListener: (t, h) => handlers.push([t, h]), removeEventListener: (t, h) => { const i = handlers.findIndex((x) => x[1] === h); if (i >= 0) handlers.splice(i, 1); } };
  const seen = [];
  const off = FL.subscribeFlows(target, s, OWN, (flows) => seen.push(flows));
  page(s, c).begin({ kind: "swap" });
  for (const [, h] of handlers) { h({ key: "something-else" }); h({ key: FL.flowsKey(OWN) }); }
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].kind, "swap");
  off();
  assert.equal(handlers.length, 0);
});

test("R10) status polling: 4 s for 2 min, 15 s to 15 min, then 60 s", () => {
  const rec = { sentAt: T0 };
  assert.equal(FL.pollDelayMs(rec, T0 + 1000), 4000);
  assert.equal(FL.pollDelayMs(rec, T0 + 121_000), 15000);
  assert.equal(FL.pollDelayMs(rec, T0 + 901_000), 60000);
});

test("R11) settled records are pruned to 20; unsettled ones are never dropped", () => {
  const s = new MemStorage();
  const c = clock();
  const a = page(s, c);
  const keep = a.begin({ kind: "move-in" });
  a.confirm(keep.id);
  a.beforeWindow(keep.id, {});
  a.markUnknown(keep.id, "lost");
  for (let i = 0; i < 30; i += 1) {
    c.t += 1;
    const r = a.begin({ kind: "swap" });
    a.cancel(r.id, "test");
  }
  const flows = a.list();
  assert.equal(flows.filter((f) => FL.isTerminal(f.state)).length, FL.FLOWS_KEEP_SETTLED);
  assert.ok(flows.some((f) => f.id === keep.id && f.state === "unknown"));
});

test("R12) end to end with the real executor: a reload right after the money window shows NO Confirm, only a watched move", async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/avax/live-move-in-6-topup.json"), "utf8"));
  const own = "0x000000000000000000000000000000000000dEaD";
  const review = OM.parseOwnMoveQuote(fx.response, { own, dest: "usdc", amountRaw: "6000000", topupUsd: 0.3, maxDebitUsdc: MI.maxDebitUsdc(6, 0.3), now: fx.capturedAt });
  const s = new MemStorage();
  const c = clock(fx.capturedAt + 1000);
  const a = FL.createFlowRegistry({ storage: s, own, now: c.now });
  const r = a.begin({ kind: "move-in", amounts: { out: "6" }, maxDebit: review.maxDebitUsdc });
  assert.equal(a.confirm(r.id).ok, true);
  let reloaded = null;
  /* Not awaited: the window below never answers (the tab "died" inside it). */
  void OM.executeOwnMove({
    review, ownNow: () => own, flow: a.handle(r.id), now: c.now, timers: { setTimeout: () => 0, clearTimeout: () => {} },
    signAuthorize: async () => ({ ok: true, signature: `0x${"ab".repeat(65)}` }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    /* The tab dies the instant the sendAsset is asked for: another page loads the registry. */
    sendDeposit: async () => { reloaded = FL.createFlowRegistry({ storage: s, own, now: c.now }); return new Promise(() => {}); },
  });
  for (let i = 0; i < 50 && !reloaded; i += 1) await new Promise((res) => setTimeout(res, 2));
  assert.ok(reloaded, "the money window was reached");
  const rec = reloaded.get(r.id);
  assert.equal(rec.state, "unknown");
  assert.equal(rec.resumeFrom, "sending");
  assert.equal(rec.requestId, review.requestId);
  assert.equal(rec.hlNonce, review.hlNonce);
  assert.equal(reloaded.view(rec).confirmable, false);
  assert.equal(reloaded.view(rec).watching, true);
  assert.equal(reloaded.canStart().code, "unknown");
});
