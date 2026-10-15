// ─────────────────────────────────────────────────────────────────────────────
// US stock market hours: is the market a stock perp follows open right now?
// ─────────────────────────────────────────────────────────────────────────────
//
// A stock perp on a HIP-3 dex trades 24/7 (measured 2026-10-15: xyz:TSLA filled
// trades in every hour of the weekend of 10–11 October, at a fraction of the
// weekday volume, and its book was live at 03:37 New York time on a Thursday).
// The SHARE does not. While the US market is shut, the price comes from the
// deployer's own off-hours feed and the book is thin; at the next open the
// price can gap past a stop. That is the risk the Stocks screens print, and this
// file is the one place that decides which state we are in.
//
// THE CALENDAR IS NYSE's, read 2026-10-15 from nyse.com/markets/hours-calendars:
//   core session 9:30 a.m. – 4:00 p.m. ET; NYSE Arca early session from 4:00 a.m.,
//   late session to 8:00 p.m.; 1:00 p.m. early closes on the days listed below.
// Only 2026 and 2027 are written down. Past that, calendarKnown is false: the
// weekday rule still answers, and a screen can say the holiday list is old.
//
// WHERE THE PRICE COMES FROM is a second, different question, and it is the
// deployer's (docs.trade.xyz, read 2026-10-15):
//   US stocks   external prices "from Sunday 8:05 PM ET to Friday 8:00 PM ET":
//               pre 4:00–9:30, market 9:30–4:00, post 4:00–8:00, overnight
//               8:05 PM–4:00 AM "provided by Blue Ocean ATS (BOATS)"
//               (perpetuals/markets/stocks/us). Otherwise an internal price:
//               an EMA of the book's impact price, τ 30 min (mechanics/
//               oracle-price), which "continues to follow applicable equity
//               market holidays" (changelog/equities-internal-session-hours).
//   US indices  spot index in the cash session, futures quotes otherwise, on
//               session "F": Sunday 6 PM to Friday 5 PM ET with a daily
//               5–6 PM break Mon–Thu (markets/equity-indices/us).
// Either way the mark is held within ±(1/max leverage) of a reference that can
// re-anchor a few times, then "becomes a hard cap until external pricing
// resumes" (mechanics/discovery-bounds). xyzPriceSource() says which regime an
// instant is in. HOLIDAYS are INFERRED: we treat a whole NYSE holiday as
// internal for both kinds; the deployer's own holiday page lists dates, not
// hours, and index futures follow their own calendar.
//
// Time zone maths uses Intl with "America/New_York", so daylight saving is the
// platform's, not ours. Pure apart from Intl; the caller passes the clock.

export const NY_TZ = "America/New_York";

/** Full-day NYSE closures, New York dates. Source above. */
export const NYSE_HOLIDAYS = Object.freeze({
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King, Jr. Day",
  "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King, Jr. Day",
  "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
});

/** 1:00 p.m. early closes. Source above (no other 2027 early close was listed). */
export const NYSE_EARLY_CLOSES = Object.freeze(["2026-11-27", "2026-12-24", "2027-11-26"]);

export const CALENDAR_YEARS = Object.freeze([2026, 2027]);

const MIN = { pre: 4 * 60, open: 9 * 60 + 30, close: 16 * 60, early: 13 * 60, post: 20 * 60 };

let fmt = null;
function nyFormat() {
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: NY_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    });
  }
  return fmt;
}

/** New York wall time of an instant: { date: "YYYY-MM-DD", year, minutes (0..1439), weekday (0 Sun .. 6 Sat) }. */
export function nyParts(ms) {
  const p = {};
  for (const x of nyFormat().formatToParts(new Date(ms))) p[x.type] = x.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: wd,
  };
}

/**
 * The US stock market's state at an instant.
 *   regular    core session: the share trades, the oracle follows it
 *   pre        early session (4:00 – 9:30 ET)
 *   post       late session, to 8:00 p.m. (also after a 1:00 p.m. early close: the
 *              source gives no other end for that day's late session)
 *   overnight  a weekday night
 *   weekend    Saturday or Sunday in New York
 *   holiday    an NYSE full-day closure
 * @returns {{ session: string, open: boolean, closed: boolean, nyDate: string, holiday: string|null,
 *   earlyClose: boolean, calendarKnown: boolean }}
 *   open: the core session is on. closed: no US session of any kind is on.
 */
export function usEquitySession(ms) {
  const t = typeof ms === "number" && Number.isFinite(ms) ? ms : NaN;
  if (Number.isNaN(t)) return { session: null, open: false, closed: false, nyDate: null, holiday: null, earlyClose: false, calendarKnown: false };
  const { date, year, minutes, weekday } = nyParts(t);
  const calendarKnown = CALENDAR_YEARS.includes(year);
  const holiday = NYSE_HOLIDAYS[date] || null;
  const earlyClose = NYSE_EARLY_CLOSES.includes(date);
  const out = (session) => ({
    session, open: session === "regular", closed: session === "overnight" || session === "weekend" || session === "holiday",
    nyDate: date, holiday, earlyClose, calendarKnown,
  });
  if (weekday === 0 || weekday === 6) return out("weekend");
  if (holiday) return out("holiday");
  const close = earlyClose ? MIN.early : MIN.close;
  if (minutes >= MIN.open && minutes < close) return out("regular");
  if (minutes >= MIN.pre && minutes < MIN.open) return out("pre");
  if (minutes >= close && minutes < MIN.post) return out("post");
  return out("overnight");
}

/**
 * Which price an xyz market carries at an instant.
 * @param {number} ms
 * @param {"stock"|"index"} [kind]
 * @returns {"external"|"internal"|null} internal: the deployer's own model (thin book, bounded moves, a gap risk at reopen)
 */
export function xyzPriceSource(ms, kind = "stock") {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const { date, minutes, weekday } = nyParts(ms);
  if (NYSE_HOLIDAYS[date]) return "internal";
  if (kind === "index") {
    const open = 18 * 60;
    const close = 17 * 60;
    if (weekday === 6) return "internal";
    if (weekday === 0) return minutes >= open ? "external" : "internal";
    if (weekday === 5) return minutes < close ? "external" : "internal";
    return minutes >= close && minutes < open ? "internal" : "external";
  }
  const start = 20 * 60 + 5;
  const end = 20 * 60;
  if (weekday === 6) return "internal";
  if (weekday === 0) return minutes >= start ? "external" : "internal";
  if (weekday === 5) return minutes < end ? "external" : "internal";
  return minutes >= end && minutes < start ? "internal" : "external";
}

/* The UTC instant of a New York wall time. New York is UTC-4 or UTC-5; the one
   that reads back as the asked wall time is the answer. */
function nyInstant(date, minutes) {
  const [y, m, d] = date.split("-").map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, 0, minutes) + off * 3_600_000;
    const p = nyParts(ms);
    if (p.date === date && p.minutes === minutes) return ms;
  }
  return null;
}

/**
 * The next 9:30 a.m. ET core open after an instant (the instant itself when it
 * is exactly then), skipping weekends and the known holidays. null past the
 * known calendar, rather than a date that may be a holiday.
 */
export function nextRegularOpen(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  let probe = ms;
  for (let i = 0; i < 10; i++) {
    const p = nyParts(probe);
    if (!CALENDAR_YEARS.includes(p.year)) return null;
    const weekday = p.weekday >= 1 && p.weekday <= 5;
    if (weekday && !NYSE_HOLIDAYS[p.date]) {
      const at = nyInstant(p.date, MIN.open);
      if (at != null && at >= ms) return at;
    }
    /* Noon of the next New York day: far from any DST edge. */
    const noon = nyInstant(p.date, 12 * 60);
    probe = (noon == null ? probe : noon) + 24 * 3_600_000;
  }
  return null;
}

/**
 * Only the candles whose hour started inside the core session. For a stop
 * distance on a stock, the 14-bar range of a weekend is a fraction of a trading
 * day's (fixture xyz-candles-TSLA-1h-weekend.json): a stop sized on it sits
 * inside the Monday open's gap. The caller keeps its own minimum bar count.
 * @param {Array<{time:number}>} candles parseHlCandles() rows (time in SECONDS)
 */
export function coreSessionCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => c && Number.isFinite(c.time) && usEquitySession(c.time * 1000).open);
}
