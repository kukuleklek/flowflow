// The browser side of Tokenomist: one call to our own /api/tokenomist (the key lives there), and the pure view of
// its answer for the Agent: the "unlocks" card the chat draws, and the small result the model reads.
//
// 🔴 UNKNOWN IS NULL, NEVER 0. A figure Tokenomist did not give, or a price we could not read, stays null (the UI
// prints a dash). USD values use the live market price when we have it (k-markets: price per 1,000 tokens), else
// Tokenomist's own value, and say which. Unlock figures are scheduled, not certain. Tokenomist text is data.
import { slugFor, hlCoinFor, priceDivisor, tokenSymbolOf, tokenomistPage } from "./slugs.js";
import { allocationLabel } from "./allocations.js";

const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
/** The build flag: set "on" only when the server has TOKENOMIST_API_KEY. Off, the Analyze pill says plain "Analyze"
 *  (no Tokenomist mark) and the analysis card's emission row is a dash. */
export const TOKENOMIST_ON = ENV.VITE_TOKENOMIST === "on";

export const TOKENOMIST_URL = "/api/tokenomist";
export const TOKENOMIST_TIMEOUT_MS = 12_000;
const DAY_MS = 86_400_000;

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r1 = (v) => (fin(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);

/** "9.92M", "1.2B", "850K", "12.5". Null in, null out. */
export function compactAmount(n) {
  if (!fin(n)) return null;
  const a = Math.abs(n);
  const f = (v, s) => `${Number(v.toPrecision(3)).toString()}${s}`;
  if (a >= 1e12) return f(n / 1e12, "T");
  if (a >= 1e9) return f(n / 1e9, "B");
  if (a >= 1e6) return f(n / 1e6, "M");
  if (a >= 1e3) return f(n / 1e3, "K");
  return Number(n.toPrecision(3)).toString();
}
const usdText = (n) => (fin(n) ? `$${compactAmount(n)}` : null);

/**
 * GET /api/tokenomist with an end. Never rejects.
 * @returns {Promise<{ status: number, body: object|null } | { failed: "timeout"|"network" }>}
 */
export async function fetchTokenomist(params, { fetchImpl = globalThis.fetch, timeoutMs = TOKENOMIST_TIMEOUT_MS, base = TOKENOMIST_URL } = {}) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  let t = null;
  const timer = new Promise((resolve) => { t = setTimeout(() => { timedOut = true; if (ctrl) ctrl.abort(); resolve({ failed: "timeout" }); }, timeoutMs); });
  const qs = new URLSearchParams(params).toString();
  const call = (async () => {
    try {
      const r = await fetchImpl(`${base}?${qs}`, { method: "GET", headers: { accept: "application/json" }, ...(ctrl ? { signal: ctrl.signal } : {}) });
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    } catch {
      return { failed: timedOut ? "timeout" : "network" };
    }
  })();
  try {
    return await Promise.race([call, timer]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * The unlock schedule for one market, normalized:
 *   { configured:false }                          no key on the server
 *   { configured:true, covered:false, coin }      Tokenomist has no page for it
 *   { configured:true, error:"quota"|"unavailable", coin }
 *   { configured:true, covered:true, coin, ...the server's unlocks body }
 */
export async function readUnlocks(coin, { days = 90, fetchImpl, timeoutMs, base } = {}) {
  const c = hlCoinFor(coin) || (typeof coin === "string" ? coin.trim() : "");
  if (!slugFor(c)) return { configured: true, covered: false, coin: String(c || coin || "").toUpperCase() || null };
  const r = await fetchTokenomist({ op: "unlocks", coin: c, days: String(days) }, { fetchImpl, timeoutMs, base });
  if (r.failed) return { configured: true, error: "unavailable", coin: c };
  const b = r.body && typeof r.body === "object" ? r.body : null;
  if (r.status === 503 && b && b.error === "not_configured") return { configured: false, coin: c };
  if (r.status === 404) return { configured: false, coin: c };
  if (r.status === 429) return { configured: true, error: "quota", coin: c };
  if (r.status !== 200 || !b || b.ok !== true) return { configured: true, error: "unavailable", coin: c };
  if (b.covered === false) return { configured: true, covered: false, coin: c };
  return { ...b, configured: true, covered: true, coin: c };
}

/**
 * One market's emission (new supply, week by week) over the next `days`, normalized like readUnlocks:
 *   { configured:false } | { configured:true, covered:false, coin } | { configured:true, error, coin }
 *   { configured:true, covered:true, coin, weeks:[{ start, amount|null, valueUsd|null }], totalAmount|null }
 * The analysis card reads its monthly pace from it (src/agent/analyze.js). Never rejects.
 */
export async function readEmission(coin, { days = 90, fetchImpl, timeoutMs, base } = {}) {
  const c = hlCoinFor(coin) || (typeof coin === "string" ? coin.trim() : "");
  if (!slugFor(c)) return { configured: true, covered: false, coin: String(c || coin || "").toUpperCase() || null };
  const r = await fetchTokenomist({ op: "emission", coin: c, days: String(days) }, { fetchImpl, timeoutMs, base });
  if (r.failed) return { configured: true, error: "unavailable", coin: c };
  const b = r.body && typeof r.body === "object" ? r.body : null;
  if (r.status === 503 && b && b.error === "not_configured") return { configured: false, coin: c };
  if (r.status === 404) return { configured: false, coin: c };
  if (r.status === 429) return { configured: true, error: "quota", coin: c };
  if (r.status !== 200 || !b || b.ok !== true) return { configured: true, error: "unavailable", coin: c };
  if (b.covered === false) return { configured: true, covered: false, coin: c };
  const weeks = (Array.isArray(b.weeks) ? b.weeks : [])
    .filter((w) => w && typeof w.start === "string")
    .map((w) => ({ start: w.start, amount: fin(w.amount) ? w.amount : null, valueUsd: fin(w.valueUsd) ? w.valueUsd : null }));
  return { configured: true, covered: true, coin: c, weeks, totalAmount: fin(b.totalAmount) ? b.totalAmount : null };
}

const inDaysOf = (date, now) => {
  const t = Date.parse(`${date}T00:00:00Z`);
  return fin(t) ? Math.max(0, Math.ceil((t - now) / DAY_MS)) : null;
};

/**
 * The card and the model's result for one market's unlocks.
 * @param {object} raw readUnlocks()'s answer
 * @param {{ coin?: string, market?: object|null, now?: number, days?: number }} o market: the live market row (px)
 * @returns {{ card: object, result: object }}
 */
export function unlocksView(raw, { coin = null, market = null, now = Date.now(), days = 90 } = {}) {
  const r = raw && typeof raw === "object" ? raw : { configured: true, error: "unavailable" };
  const c = (r.coin && hlCoinFor(r.coin)) || hlCoinFor(coin) || r.coin || coin || null;
  const sym = c ? tokenSymbolOf(c) : null;
  const base = { kind: "unlocks", coin: c, source: "Tokenomist" };
  if (r.configured === false) {
    return {
      card: { ...base, configured: false, covered: null, next: null, events: [], updatedAt: null, url: null },
      result: { coin: c, configured: false, note: "Unlock data (Tokenomist) is not connected yet. Do not quote unlock figures." },
    };
  }
  if (r.covered === false) {
    return {
      card: { ...base, configured: true, covered: false, next: null, events: [], updatedAt: null, url: null },
      result: { coin: c, configured: true, covered: false, note: `Tokenomist has no unlock schedule for ${sym}.` },
    };
  }
  if (r.error) {
    return {
      card: { ...base, configured: true, covered: true, error: r.error, next: null, events: [], updatedAt: null, url: tokenomistPage(slugFor(c)) },
      result: { coin: c, configured: true, error: r.error === "quota" ? "Unlock data is over its monthly limit right now." : "Unlock data couldn't be read right now." },
    };
  }
  const token = r.token || null;
  const circ = token && fin(token.circulatingSupply) && token.circulatingSupply > 0 ? token.circulatingSupply : null;
  const px = market && fin(market.px) && market.px > 0 ? market.px / priceDivisor(c) : null;
  const rows = (Array.isArray(r.events) ? r.events : []).filter((e) => e && typeof e.date === "string" && fin(e.amount) && e.amount > 0).map((e) => {
    const live = px != null ? e.amount * px : null;
    return {
      date: e.date,
      inDays: inDaysOf(e.date, now),
      amount: e.amount,
      usd: live != null ? r2(live) : fin(e.valueUsd) ? r2(e.valueUsd) : null,
      usdBasis: live != null ? "live" : fin(e.valueUsd) ? "tokenomist" : null,
      pctCirculating: circ != null ? r2((e.amount / circ) * 100) : null,
      pctMcap: fin(e.pctMcap) ? r2(e.pctMcap) : null,
      /* Names are mapped to Tokenomist's standard labels again here (a cached or stale answer included): third-party
         text never reaches the model's result as written. */
      to: Array.isArray(e.to) ? e.to.slice(0, 3).filter((x) => x && typeof x === "object").map((x) => ({ name: allocationLabel(x.name), pct: fin(x.pct) ? x.pct : null })) : [],
      committed: fin(e.committed) ? e.committed : null,
    };
  });
  const next = rows[0] || null;
  const card = {
    ...base,
    configured: true,
    covered: true,
    symbol: (token && token.symbol) || sym,
    name: token ? token.name : null,
    next,
    events: rows.slice(0, 5),
    totalEvents: fin(r.totalEvents) ? r.totalEvents : rows.length,
    windowDays: r.window && fin(r.window.days) ? r.window.days : days,
    updatedAt: r.updatedAt || null,
    url: r.url || tokenomistPage(slugFor(c)),
  };
  const amt = (n) => (fin(n) ? `${compactAmount(n)} ${sym}` : null);
  const result = {
    coin: c,
    configured: true,
    covered: true,
    source: "Tokenomist",
    data_updated: card.updatedAt,
    next: next ? {
      date: next.date,
      in_days: next.inDays,
      amount: amt(next.amount),
      value_usd: usdText(next.usd),
      pct_of_circulating: next.pctCirculating != null ? `${r1(next.pctCirculating)}%` : null,
      to: next.to.map((t) => (t.pct != null ? `${t.name} ${t.pct}%` : t.name)),
      ...(next.committed != null ? { team_says_will_claim: amt(next.committed) } : {}),
    } : null,
    more_events_in_window: Math.max(0, card.totalEvents - (next ? 1 : 0)),
    note: next ? "Scheduled, not certain. Not advice." : `No scheduled unlocks in the next ${card.windowDays} days.`,
  };
  return { card, result };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(d || "");
};

/** The one line the Agent says over the card (data, not advice). */
export function unlocksLine(card, lang = "en") {
  const th = lang === "th";
  const sym = card && (card.symbol || card.coin);
  if (!card || card.configured === false) return th ? "ยังไม่ได้เชื่อมข้อมูล unlock (Tokenomist)" : "Unlock data (Tokenomist) isn't connected yet.";
  if (card.covered === false) return th ? `Tokenomist ไม่มีตาราง unlock ของ ${sym}` : `Tokenomist has no unlock schedule for ${sym}.`;
  if (card.error) return th ? "อ่านข้อมูล unlock ไม่ได้ตอนนี้" : "Couldn't read unlocks right now.";
  const n = card.next;
  if (!n) return th ? `${sym} ไม่มี unlock ตามตารางใน ${card.windowDays} วันข้างหน้า` : `No scheduled ${sym} unlocks in the next ${card.windowDays} days.`;
  const parts = [`${compactAmount(n.amount)} ${sym}`];
  if (n.usd != null) parts.push(`≈ ${usdText(n.usd)}`);
  if (n.pctCirculating != null) parts.push(th ? `${r1(n.pctCirculating)}% ของที่หมุนเวียน` : `${r1(n.pctCirculating)}% of circulating`);
  const when = `${shortDate(n.date)}${n.inDays != null ? (th ? ` (อีก ${n.inDays} วัน)` : ` (in ${n.inDays}d)`) : ""}`;
  return th
    ? `${sym} unlock ถัดไป ${when}: ${parts.join(", ")} ตามตาราง ไม่แน่นอน`
    : `Next ${sym} unlock ${when}: ${parts.join(", ")}. Scheduled, not certain.`;
}
