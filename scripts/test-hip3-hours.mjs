/**
 * HIP-3 stock perps — US market hours (src/lib/hyperliquid/hip3/hours.js).
 *
 * The calendar is NYSE's (nyse.com/markets/hours-calendars, read 2026-10-15).
 * Instants are UTC; New York is UTC-4 until 1 Nov 2026, UTC-5 after.
 *
 * Run: node --test scripts/test-hip3-hours.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3", `${name}.json`), "utf8")).response;

globalThis.fetch = () => { throw new Error("no network in tests"); };

const H = await import("../src/lib/hyperliquid/hip3/hours.js");
const { parseHlCandles } = await import("../src/lib/hyperliquid/candles.js");

const at = (iso) => Date.parse(iso);
const session = (iso) => H.usEquitySession(at(iso)).session;

test("the session at the capture instant (Thu 03:37 New York) is overnight and closed", () => {
  const s = H.usEquitySession(at("2026-10-15T07:37:00Z"));
  assert.deepEqual(s, { session: "overnight", open: false, closed: true, nyDate: "2026-10-15", holiday: null, earlyClose: false, calendarKnown: true });
});

test("a weekday, edge by edge (EDT)", () => {
  assert.equal(session("2026-10-15T07:59:00Z"), "overnight");
  assert.equal(session("2026-10-15T08:00:00Z"), "pre", "4:00 a.m. ET");
  assert.equal(session("2026-10-15T13:29:00Z"), "pre");
  assert.equal(session("2026-10-15T13:30:00Z"), "regular", "9:30 a.m. ET");
  assert.equal(session("2026-10-15T19:59:00Z"), "regular");
  assert.equal(session("2026-10-15T20:00:00Z"), "post", "4:00 p.m. ET");
  assert.equal(session("2026-10-15T23:59:00Z"), "post");
  assert.equal(session("2026-10-16T00:00:00Z"), "overnight", "8:00 p.m. ET");
});

test("daylight saving is the platform's: 9:30 ET is 14:30Z after 1 Nov 2026", () => {
  assert.equal(session("2026-11-02T13:30:00Z"), "pre");
  assert.equal(session("2026-11-02T14:30:00Z"), "regular");
});

test("weekends, holidays and early closes", () => {
  assert.equal(session("2026-10-10T15:00:00Z"), "weekend");
  assert.equal(session("2026-10-11T23:00:00Z"), "weekend", "Sunday 7 p.m. ET is still the weekend");
  const tg = H.usEquitySession(at("2026-11-26T15:00:00Z"));
  assert.equal(tg.session, "holiday");
  assert.equal(tg.holiday, "Thanksgiving Day");
  assert.equal(tg.closed, true);
  assert.equal(session("2026-11-27T17:59:00Z"), "regular", "12:59 p.m. ET on the early-close day");
  assert.equal(session("2026-11-27T18:00:00Z"), "post", "1:00 p.m. ET early close");
  assert.equal(H.usEquitySession(at("2026-11-27T15:00:00Z")).earlyClose, true);
  assert.equal(session("2027-06-18T15:00:00Z"), "holiday", "Juneteenth observed");
  assert.equal(session("2027-12-24T15:00:00Z"), "holiday");
  assert.equal(session("2026-10-12T15:00:00Z"), "regular", "Columbus Day: NYSE is open");
});

test("past the written calendar, the weekday rule answers and says the calendar is old", () => {
  const s = H.usEquitySession(at("2028-03-01T15:00:00Z"));
  assert.equal(s.session, "regular");
  assert.equal(s.calendarKnown, false);
  assert.equal(H.nextRegularOpen(at("2028-03-01T15:00:00Z")), null, "no open date we cannot vouch for");
  assert.equal(H.usEquitySession(NaN).session, null);
});

test("nextRegularOpen skips nights, weekends and holidays", () => {
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(iso(H.nextRegularOpen(at("2026-10-15T07:37:00Z"))), "2026-10-15T13:30:00.000Z");
  assert.equal(iso(H.nextRegularOpen(at("2026-10-16T21:00:00Z"))), "2026-10-19T13:30:00.000Z", "Friday evening -> Monday");
  assert.equal(iso(H.nextRegularOpen(at("2026-11-25T21:00:00Z"))), "2026-11-27T14:30:00.000Z", "over Thanksgiving, in EST");
  assert.equal(iso(H.nextRegularOpen(at("2026-12-31T22:00:00Z"))), "2027-01-04T14:30:00.000Z", "New Year's Day, then the weekend");
  assert.equal(iso(H.nextRegularOpen(at("2026-10-15T13:30:00Z"))), "2026-10-15T13:30:00.000Z", "exactly at the open is the open");
});

test("the holiday list matches NYSE's: ten closures a year, all weekdays", () => {
  for (const y of H.CALENDAR_YEARS) {
    const days = Object.keys(H.NYSE_HOLIDAYS).filter((d) => d.startsWith(`${y}-`));
    assert.equal(days.length, 10, String(y));
    for (const d of days) {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      assert.ok(wd >= 1 && wd <= 5, `${d} is a weekday`);
    }
  }
});

test("coreSessionCandles: the weekend's 1h range is a fraction of a trading day's", () => {
  const bars = parseHlCandles(fx("xyz-candles-TSLA-1h-weekend"));
  assert.equal(bars.length, 85, "Fri 12:00Z to Tue 00:00Z, every hour traded");
  const core = H.coreSessionCandles(bars);
  /* Fri 9 Oct 13:30–20:00Z has 6 bars starting inside (14..19Z), Mon 12 Oct 6 more. */
  assert.equal(core.length, 12);
  const avg = (list) => list.reduce((s, c) => s + (c.high - c.low), 0) / list.length;
  const weekend = bars.filter((c) => H.usEquitySession(c.time * 1000).session === "weekend");
  assert.equal(weekend.length, 48);
  assert.ok(avg(core) > 3 * avg(weekend), `core ${avg(core).toFixed(2)} vs weekend ${avg(weekend).toFixed(2)}`);
});

test("xyzPriceSource: US stocks take an outside price Sun 8:05 PM to Fri 8:00 PM ET, the model otherwise", () => {
  const src = (iso, kind) => H.xyzPriceSource(at(iso), kind);
  assert.equal(src("2026-10-15T07:37:00Z"), "external", "Thu 03:37 ET: overnight, Blue Ocean ATS");
  assert.equal(src("2026-10-16T23:59:00Z"), "external", "Fri 7:59 PM ET");
  assert.equal(src("2026-10-17T00:00:00Z"), "internal", "Fri 8:00 PM ET");
  assert.equal(src("2026-10-17T15:00:00Z"), "internal", "Saturday");
  assert.equal(src("2026-10-19T00:04:00Z"), "internal", "Sun 8:04 PM ET");
  assert.equal(src("2026-10-19T00:05:00Z"), "external", "Sun 8:05 PM ET");
  assert.equal(src("2026-10-14T00:02:00Z"), "internal", "the weekday 8:00–8:05 PM ET gap");
  assert.equal(src("2026-11-26T15:00:00Z"), "internal", "Thanksgiving (holiday hours INFERRED)");
  assert.equal(H.xyzPriceSource(NaN), null);
});

test("xyzPriceSource: indices follow the futures session, Sun 6 PM to Fri 5 PM ET, daily 5–6 PM break", () => {
  const src = (iso) => H.xyzPriceSource(at(iso), "index");
  assert.equal(src("2026-10-15T21:30:00Z"), "internal", "Thu 5:30 PM ET break");
  assert.equal(src("2026-10-15T22:00:00Z"), "external", "Thu 6:00 PM ET");
  assert.equal(src("2026-10-16T21:00:00Z"), "internal", "Fri 5:00 PM ET");
  assert.equal(src("2026-10-18T21:59:00Z"), "internal", "Sun 5:59 PM ET");
  assert.equal(src("2026-10-18T22:00:00Z"), "external", "Sun 6:00 PM ET");
});
