/**
 * HIP-3 stock perps — the read client (src/lib/hyperliquid/hip3/reads.js), and
 * the proof that the whole hip3 layer is READ-ONLY.
 *
 * A fake /info answers from the 2026-10-15 fixtures and records every body it
 * was sent. No network.
 *
 * Run: node --test scripts/test-hip3-reads.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3", `${name}.json`), "utf8")).response;

globalThis.fetch = () => { throw new Error("no network in tests"); };

const H = await import("../src/lib/hyperliquid/hip3/index.js");

const USER = "0x00000000000000000000000000000000000057D1";
/* The /info types this layer may ever send. Nothing else is allowed through. */
const READ_TYPES = new Set(["perpDexs", "metaAndAssetCtxs", "allMids", "perpDexLimits", "perpsAtOpenInterestCap",
  "candleSnapshot", "clearinghouseState", "frontendOpenOrders", "activeAssetData", "userAbstraction"]);

function fakeInfo({ fail = new Set() } = {}) {
  const sent = [];
  const info = async (body) => {
    sent.push(body);
    assert.ok(READ_TYPES.has(body.type), `unexpected /info type ${body.type}`);
    if (fail.has(body.type)) throw new Error(`${body.type} failed`);
    switch (body.type) {
      case "perpDexs": return fx("perp-dexs");
      case "metaAndAssetCtxs": return fx(`${body.dex}-meta-and-asset-ctxs`);
      case "allMids": return fx(`${body.dex}-all-mids`);
      case "perpDexLimits": return fx(`${body.dex}-perp-dex-limits`);
      case "perpsAtOpenInterestCap": return fx(`${body.dex}-perps-at-oi-cap`);
      case "candleSnapshot": return fx("xyz-candles-TSLA-1h-weekend");
      case "clearinghouseState": return body.dex === "xyz" ? fx("user-std-xyz-clearinghouse") : fx("user-std-main-clearinghouse");
      case "activeAssetData": return fx("user-std-active-asset-TSLA");
      case "userAbstraction": return fx("user-std-mode");
      case "frontendOpenOrders": return [];
      default: throw new Error("unreachable");
    }
  };
  return { info, sent };
}

test("stocks(): perpDexs first for the index, then limits, table and caps, then the screen", async () => {
  const f = fakeInfo();
  const r = await H.createHip3Reader({ info: f.info, now: () => 42 }).stocks();
  assert.equal(r.ok, true);
  assert.equal(r.value.dex, "xyz");
  assert.equal(r.value.dexIndex, 1);
  assert.equal(r.value.listed.length, 17);
  assert.equal(r.value.held.length, 2);
  assert.equal(r.value.collateralToken, 0);
  assert.equal(r.value.at, 42);
  assert.deepEqual(f.sent.map((b) => b.type), ["perpDexs", "perpDexLimits", "perpsAtOpenInterestCap", "metaAndAssetCtxs"]);
  for (const b of f.sent.slice(1)) assert.equal(b.dex, "xyz");
});

test("stocks(): caps unreadable -> everything held, nothing listed on a guess", async () => {
  const f = fakeInfo({ fail: new Set(["perpDexLimits"]) });
  const r = await H.createHip3Reader({ info: f.info }).stocks();
  /* perpDexs still carries the streaming caps, so the gate can read them from there. */
  assert.equal(r.ok, true);
  assert.equal(r.value.listed.length, 17, "the perpDexs streaming caps stand in for perpDexLimits");
  const noCaps = fakeInfo({ fail: new Set(["perpDexLimits"]) });
  const reader = H.createHip3Reader({ info: async (b) => (b.type === "perpDexs" ? fx("perp-dexs").map((e) => (e ? { ...e, assetToStreamingOiCap: [] } : e)) : noCaps.info(b)) });
  const r2 = await reader.stocks();
  assert.equal(r2.value.listed.length, 0);
  assert.ok(r2.value.held.every((h) => h.reasons.includes("cap_unknown")));
});

test("stocks(): perpDexs failing, or the dex missing, fails the read — no remembered index", async () => {
  const r = await H.createHip3Reader({ info: fakeInfo({ fail: new Set(["perpDexs"]) }).info }).stocks();
  assert.deepEqual(r, { ok: false, error: "perpDexs failed" });
  const r2 = await H.createHip3Reader({ info: async () => [null] }).stocks();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /not listed/);
});

test("the single reads answer { ok, value } and never throw", async () => {
  const f = fakeInfo();
  const R = H.createHip3Reader({ info: f.info });
  const mids = await R.mids("xyz");
  assert.ok(mids.value.has("xyz:TSLA"));
  const c = await R.candles("xyz:TSLA", "1h", { startTime: 1, endTime: 2 });
  assert.equal(c.value.length, 85);
  assert.equal(typeof c.value[0].time, "number");
  assert.deepEqual(f.sent.at(-1), { type: "candleSnapshot", req: { coin: "xyz:TSLA", interval: "1h", startTime: 1, endTime: 2 } }, "a qualified coin, no dex field");
  const u = await R.userDex(USER, "xyz");
  assert.equal(u.value.positions.length, 8);
  assert.equal(f.sent.at(-1).user, USER.toLowerCase(), "the master address, lowercased");
  const all = await R.userDexes(USER, ["xyz", "mkts"]);
  assert.deepEqual(all.value.map((s) => [s.dex, s.state.accountValue]), [["xyz", 151858.800726], ["mkts", 0]]);
  const a = await R.activeAsset(USER, "xyz:TSLA");
  assert.equal(a.value.leverageType, "cross");
  assert.equal(a.value.availableUsdc, 137495.484636, "the smaller of the pair");
  assert.equal((await R.mode(USER)).value, "disabled");
  const failing = H.createHip3Reader({ info: async () => { throw new Error("HTTP 500"); } });
  assert.deepEqual(await failing.userDex(USER, "xyz"), { ok: false, error: "HTTP 500" });
  assert.equal((await H.createHip3Reader({ info: async () => ({}) }).mids("xyz")).ok, true, "an empty mids object is an answer");
  assert.equal((await H.createHip3Reader({ info: async () => "x" }).userDex(USER, "xyz")).ok, false);
});

test("bad input never reaches the network", async () => {
  const f = fakeInfo();
  const R = H.createHip3Reader({ info: f.info });
  const results = await Promise.all([
    R.markets("XYZ; drop", { dexIndex: 1 }), R.mids(""), R.limits("a/b"), R.atCap(null),
    R.candles("TSLA", "1h", { startTime: 1, endTime: 2 }), R.candles("xyz:TSLA", "2h", { startTime: 1, endTime: 2 }),
    R.candles("xyz:TSLA", "1h", { startTime: 5, endTime: 2 }), R.userDex("0x123", "xyz"), R.userDex(USER, "BAD"),
    R.activeAsset(USER, "TSLA"), R.mode("nope"), R.userOrders(USER, ""),
  ]);
  for (const r of results) assert.equal(r.ok, false);
  assert.equal(f.sent.length, 0);
});

test("the hip3 layer is read-only: no exchange import, no signing, no transfer action", () => {
  const dir = path.join(ROOT, "src/lib/hyperliquid/hip3");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /from\s+"[^"]*exchange[^"]*"/, `${f} imports nothing from exchange/`);
    assert.doesNotMatch(code, /signTypedData|signL1|privateKey|\/exchange\b|sendAsset|usdClassTransfer|approveBuilderFee|updateLeverage/i, f);
    assert.doesNotMatch(code, /\bfetch\(|WebSocket|localStorage|indexedDB/, `${f} talks to nothing on its own`);
  }
});
