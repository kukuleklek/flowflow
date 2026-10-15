/**
 * test-portfolio-tabs — the Wallet's tab row, hosted by src/trade/PositionsPanel.jsx.
 *
 * Owner, 2026-10-15: "Position | Order | History | Spot", "เอา On its way ไปอยู่ใน History", "Swap Move IN, Move Out,
 * Stake, Unstake ย้ายไปใน Spot", "เน้นคลีนๆโล่งๆ". PositionsPanel gained three OPTIONAL props for it:
 *   extraTabs    [{ value, label, count?, render() }] appended after History
 *   historyLead  a node above the fills in History
 *   tab / onTab  a controlled tab; uncontrolled (its own state) when `tab` is absent
 * and every caller that passes none of them (MarketPage, the Agent's PositionHero / TradeCard) must see exactly what
 * it saw before. The panel is rendered with the shared harness (no DOM; neighbours stubbed by name).
 *
 * Run: node --test scripts/test-portfolio-tabs.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { autoStubs, bundle, stubsNamed, textOf, all, code } from "./lib/perpLiveHarness.mjs";

const FILE = "src/trade/PositionsPanel.jsx";
let B;

const ACCOUNT = {
  positions: { answered: true, list: [{ coin: "xyz:TSLA", szi: 2, entryPx: 400, marginUsed: 40 }, { coin: "BTC", szi: 0.001, entryPx: 80000, marginUsed: 8 }] },
  orders: { answered: true, list: [] },
  fills: { answered: true, list: [{ tid: 1, coin: "BTC", side: "buy", sz: 0.001, px: 80000, time: 1 }] },
};

before(async () => {
  globalThis.__impl = {
    useBackend: () => ({ connected: true, mock: true, account: ACCOUNT }),
    useWallet: () => ({ pending: null }),
    usePerpMarkets: () => ({ byCoin: {}, ready: true }),
    usePresenceList: (items, key) => items.map((item) => ({ key: key(item), item, leaving: false })),
  };
  B = await bundle({ entry: FILE, stubs: autoStubs([FILE]) });
});

const segOf = (h) => stubsNamed(h.value, "Seg")[0];
const values = (seg) => seg.props.items.map((i) => i.value);

test("no new props: the same three tabs, its own state, History is the fills alone", () => {
  const h = B.mount(() => B.default({}));
  h.render();
  const seg = segOf(h);
  assert.deepEqual(values(seg), ["positions", "orders", "history"]);
  assert.equal(seg.props.value, "positions");
  seg.props.onChange("history");
  h.flush();
  assert.equal(segOf(h).props.value, "history", "uncontrolled: the panel keeps its own tab");
  assert.equal(textOf(h.value).includes("LEAD"), false);
  h.unmount();
});

test("positions still render every market, a stock (xyz:TSLA) included", () => {
  const h = B.mount(() => B.default({}));
  h.render();
  const rows = all(h.value).filter((e) => e.type && e.type.name === "PositionRow");
  assert.deepEqual(rows.map((r) => r.props.p.coin), ["xyz:TSLA", "BTC"]);
  h.unmount();
});

test("extraTabs are appended after History and draw their own body", () => {
  const extra = [{ value: "spot", label: "Spot", render: () => ({ $$el: true, type: "div", key: null, props: { children: "SPOT BODY" } }) }];
  const h = B.mount(() => B.default({ extraTabs: extra }));
  h.render();
  assert.deepEqual(values(segOf(h)), ["positions", "orders", "history", "spot"]);
  segOf(h).props.onChange("spot");
  h.flush();
  assert.ok(textOf(h.value).includes("SPOT BODY"));
  h.unmount();
});

test("historyLead sits above the fills in History only", () => {
  const lead = { $$el: true, type: "section", key: null, props: { children: "LEAD" } };
  const h = B.mount(() => B.default({ historyLead: lead }));
  h.render();
  assert.equal(textOf(h.value).includes("LEAD"), false, "not on Positions");
  segOf(h).props.onChange("history");
  h.flush();
  const kids = all(h.value);
  const leadAt = kids.findIndex((e) => e === lead);
  const fillsAt = kids.findIndex((e) => e.type && e.type.name === "HistoryList");
  assert.ok(leadAt >= 0 && fillsAt > leadAt, "the lead comes before the fills");
  h.unmount();
});

test("tab / onTab: controlled from outside", () => {
  const seen = [];
  const h = B.mount(() => B.default({ tab: "orders", onTab: (t) => seen.push(t) }));
  h.render();
  assert.equal(segOf(h).props.value, "orders");
  segOf(h).props.onChange("history");
  h.flush();
  assert.deepEqual(seen, ["history"]);
  assert.equal(segOf(h).props.value, "orders", "controlled: only the host moves the tab");
  h.unmount();
});

test("the edit is additive: same export, same default tab, no caller had to change", () => {
  const src = code(FILE);
  assert.match(src, /export default function PositionsPanel\(\{ coin = null, extraTabs = null, historyLead = null, tab: tabProp = null, onTab = null \}\)/);
  assert.match(src, /useState\("positions"\)/);
  for (const caller of ["src/trade/MarketPage.jsx", "src/agent/PositionHero.jsx", "src/agent/TradeCard.jsx"]) {
    let s = "";
    try { s = code(caller); } catch { continue; }
    assert.doesNotMatch(s, /extraTabs|historyLead/, `${caller} passes none of the new props`);
  }
});
