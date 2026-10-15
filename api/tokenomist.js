// GET /api/tokenomist?op=<op>&… — the Tokenomist proxy (a Vercel function; plan v2 §2.6, R-tokenomist.md §6).
//
// It holds TOKENOMIST_API_KEY (server only, never VITE_) and nothing else. Only the ops below exist; no path, slug
// or parameter is passed through: the coin is mapped to its Tokenomist id from OUR map (src/lib/tokenomist/slugs.js),
// the dates are computed here (today UTC + a whole number of days, so every user hits the same cache entry), and
// numbers are clamped. The caller's `days` never reaches Tokenomist as is: it is snapped UP to a few windows (BUCKETS),
// one upstream call fetches that window, and the answer is cut to the days asked here — so walking days=7..365 costs
// at most four calls per coin, not 359 (the month has 1,000 credits, and at 90% the Analyze pill goes dark for all). Answers are trimmed to the fields the Agent shows (less redistributed data, smaller payload).
//
//   op=unlocks  coin, days(7–365, default 90)   next cliff unlocks + the token's supply (E3 + E1)
//   op=upcoming days(1–60, default 14)          next unlock per token, only markets we map (E4)
//   op=emission coin, days(30–365, default 90)  weekly new supply (E7)
//   op=alloc    coin                            allocations (E8)
//
// No key → 503 { ok:false, error:"not_configured" }. A coin Tokenomist does not cover → 200 { ok:true, covered:false }
// (no upstream call). Upstream 429 → 429 "quota" (never retried); 4xx → 502 "unavailable" (never retried); a
// network error or 5xx is retried once (idempotent GET; failures cost no credit). `status:false` on a 200 is an error.
// A small per-instance cache (also served stale when upstream fails, up to a day) and the CDN header keep the
// 1,000-credit month safe; at 90% of the month's credit only cached answers are served.
import { slugFor, hlCoinFor, coinForSlug, tokenomistPage, SLUG_RE } from "../src/lib/tokenomist/slugs.js";
import { allocationLabel } from "../src/lib/tokenomist/allocations.js";

export const TOKENOMIST_BASE = "https://api.tokenomist.ai";
export const RATE_PER_MIN = 30;
const TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
const STALE_MS = DAY_MS;
const MAX_CACHE = 300;
/** At this share of the month's credit, only cached answers are served. */
export const QUOTA_STOP = 0.9;

/** op → its parameters (name → [min, max, default]), the windows actually fetched (days snap UP to one), and the CDN
 *  time to live (seconds). */
export const OPS = Object.freeze({
  unlocks: { coin: true, days: [7, 365, 90], buckets: [30, 90, 180, 365], ttl: 43_200 },
  upcoming: { coin: false, days: [1, 60, 14], buckets: [14, 30, 60], ttl: 10_800 },
  emission: { coin: true, days: [30, 365, 90], buckets: [90, 180, 365], ttl: 86_400 },
  alloc: { coin: true, days: null, buckets: null, ttl: 86_400 },
});

/** The window fetched for `days`: the smallest bucket that holds it (the op's largest when none does). */
export function bucketOf(days, buckets) {
  if (!Array.isArray(buckets) || !buckets.length) return days;
  return buckets.find((b) => b >= days) ?? buckets[buckets.length - 1];
}

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v) => (fin(v) ? v : null);
const round = (v, d = 2) => (fin(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const day = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Tokenomist text (token names) as data: letters, digits and a few signs, at most 40; else "Other". Allocation names
 *  are not passed on at all: they are mapped to Tokenomist's standard vocabulary (allocationLabel). */
const NAME_RE = /^[A-Za-z0-9 &()./%+-]{1,40}$/;
export function cleanName(s) {
  const t = typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";
  return NAME_RE.test(t) ? t : "Other";
}
const cleanSymbol = (s) => (typeof s === "string" && /^[A-Za-z0-9.]{1,12}$/.test(s.trim()) ? s.trim() : null);
const PRECISION = new Set(["day", "week", "month", "quarter", "year", "unknown"]);

class Fail extends Error {
  constructor(status, error, detail = null) {
    super(error);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

/** The proxy's memory: cached upstream answers, the last credit reading, the per-IP hits. One per warm instance. */
export function createTokenomistState() {
  return { cache: new Map(), credit: null, hits: new Map() };
}
const STATE = createTokenomistState();

/** A rough per-IP limit (per warm instance). */
export function rateLimited(ip, now = Date.now(), state = STATE) {
  const k = ip || "unknown";
  const recent = (state.hits.get(k) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  state.hits.set(k, recent);
  if (state.hits.size > 5000) state.hits.clear();
  return recent.length > RATE_PER_MIN;
}

const quotaLow = (st) => !!(st.credit && fin(st.credit.used) && fin(st.credit.limit) && st.credit.limit > 0 && st.credit.used / st.credit.limit >= QUOTA_STOP);

async function fetchOnce(url, key, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { method: "GET", headers: { "x-api-key": key, accept: "application/json" }, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json };
  } finally {
    clearTimeout(t);
  }
}

/* One upstream GET: a network error or 5xx is tried once more; 4xx (429 included) never is. */
async function fetchUpstream(url, key, fetchImpl, st) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await fetchOnce(url, key, fetchImpl);
    } catch {
      last = new Fail(502, "unavailable", "network");
      continue;
    }
    if (r.status === 429) throw new Fail(429, "quota");
    if (r.status >= 500) { last = new Fail(502, "unavailable", `upstream ${r.status}`); continue; }
    if (r.status !== 200) throw new Fail(502, "unavailable", `upstream ${r.status}`);
    if (!r.json || r.json.status !== true) throw new Fail(502, "unavailable", "upstream refused");
    const credit = r.json.metadata && r.json.metadata.credit;
    if (credit && fin(credit.used) && fin(credit.limit)) st.credit = { used: credit.used, limit: credit.limit };
    return r.json.data;
  }
  throw last || new Fail(502, "unavailable");
}

/* A cached upstream answer while fresh; at a low quota only the cache; a failure falls back to a stale copy. */
async function upstream(path, params, ttlS, io) {
  const { st, key, base, fetchImpl, now } = io;
  const qs = new URLSearchParams(params).toString();
  const k = `${path}${qs ? `?${qs}` : ""}`;
  const hit = st.cache.get(k);
  const t = now();
  if (hit && t - hit.at < ttlS * 1000) return hit.data;
  if (quotaLow(st)) {
    if (hit) return hit.data;
    throw new Fail(429, "quota");
  }
  try {
    const data = await fetchUpstream(`${base}${k}`, key, fetchImpl, st);
    st.cache.delete(k);
    st.cache.set(k, { at: t, data });
    while (st.cache.size > MAX_CACHE) st.cache.delete(st.cache.keys().next().value);
    return data;
  } catch (e) {
    if (hit && t - hit.at < ttlS * 1000 + STALE_MS) return hit.data;
    throw e;
  }
}

/* ── trimming ─────────────────────────────────────────────────────────────── */

/** One cliff unlock, as the Agent needs it. */
export function trimEvent(e) {
  const c = (e && e.cliffUnlocks) || {};
  const amount = numOrNull(c.cliffAmount ?? c.totalCliffAmount);
  const br = Array.isArray(c.allocationBreakdown) ? c.allocationBreakdown : [];
  const by = new Map();
  let committed = null;
  for (const a of br) {
    if (!a || typeof a !== "object") continue;
    const name = allocationLabel(a.standardAllocationName || a.allocationName);
    const amt = numOrNull(a.cliffAmount);
    by.set(name, (by.get(name) || 0) + (amt || 0));
    if (a.committedClaim && fin(a.committedClaim.amount)) committed = (committed || 0) + a.committedClaim.amount;
  }
  const to = [...by.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([name, amt]) => ({ name, pct: amount && amount > 0 && amt > 0 ? round((amt / amount) * 100, 1) : null }));
  const first = br.find((a) => a && typeof a === "object") || {};
  const precision = typeof first.unlockPrecision === "string" && PRECISION.has(first.unlockPrecision) ? first.unlockPrecision : null;
  return {
    date: day(e && e.unlockDate),
    amount,
    valueUsd: numOrNull(c.cliffValue ?? c.totalCliffValue),
    pctMcap: numOrNull(c.valueToMarketCap),
    refPrice: numOrNull(first.referencePrice ?? (e && e.referencePrice)),
    to,
    committed: committed == null ? null : round(committed, 2),
    precision,
    updatedAt: day(e && e.latestUpdateDate),
  };
}

/** The token's supply row (E1). */
export function trimToken(t) {
  if (!t || typeof t !== "object") return null;
  return {
    name: cleanName(t.name),
    symbol: cleanSymbol(t.symbol),
    circulatingSupply: numOrNull(t.circulatingSupply),
    maxSupply: numOrNull(t.maxSupply),
    marketCap: numOrNull(t.marketCap),
    unlockedAmount: numOrNull(t.unlockedAmount),
    totalLockedAmount: numOrNull(t.totalLockedAmount),
    listedMethod: ["INTERNAL", "AI", "EXTERNAL"].includes(t.listedMethod) ? t.listedMethod : null,
    updatedAt: day(t.lastUpdatedDate),
  };
}

/* ── the ops ──────────────────────────────────────────────────────────────── */

async function opUnlocks({ coin, slug, start, end, fetchEnd, days }, io) {
  const [ev, tok] = await Promise.allSettled([
    upstream(`/v5/unlock/events/${slug}`, { start, end: fetchEnd, pageSize: "50" }, OPS.unlocks.ttl, io),
    upstream("/v5/token/list", { tokenId: slug }, 86_400, io),
  ]);
  if (ev.status === "rejected") throw ev.reason;
  const list = (Array.isArray(ev.value) ? ev.value : []).map(trimEvent)
    .filter((e) => e.date && e.date >= start && e.date <= end && e.amount != null && e.amount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows = tok.status === "fulfilled" && Array.isArray(tok.value) ? tok.value : [];
  const token = trimToken(rows.find((r) => r && r.id === slug) || rows[0] || null);
  const updated = token && token.updatedAt ? token.updatedAt : list.map((e) => e.updatedAt).filter(Boolean).sort().at(-1) || null;
  return {
    ok: true, op: "unlocks", coin, covered: true, slug, source: "Tokenomist", url: tokenomistPage(slug), updatedAt: updated,
    window: { start, end, days }, token, events: list.slice(0, 8), totalEvents: list.length,
  };
}

async function opUpcoming({ start, end, fetchEnd, days }, io) {
  const data = await upstream("/v5/unlock/events/upcoming", { start, end: fetchEnd, pageSize: "100" }, OPS.upcoming.ttl, io);
  const out = [];
  for (const it of Array.isArray(data) ? data : []) {
    const c = it && SLUG_RE.test(String(it.tokenId)) ? coinForSlug(it.tokenId) : null;
    if (!c || !it.upcomingEvent) continue;
    const e = trimEvent(it.upcomingEvent);
    if (!e.date || e.date < start || e.date > end) continue;
    out.push({ coin: c, date: e.date, amount: e.amount, valueUsd: e.valueUsd, pctMcap: e.pctMcap, to: e.to.slice(0, 1) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, op: "upcoming", source: "Tokenomist", window: { start, end, days }, unlocks: out.slice(0, 10) };
}

async function opEmission({ coin, slug, start, end, fetchEnd, days }, io) {
  const data = await upstream(`/v5/emission/${slug}`, { start, end: fetchEnd, pageSize: "60" }, OPS.emission.ttl, io);
  const weeks = (Array.isArray(data) ? data : []).map((r) => ({ start: day(r && r.startDate), amount: numOrNull(r && r.unlockAmount), valueUsd: numOrNull(r && r.unlockValue) }))
    .filter((w) => w.start && w.start <= end).slice(0, 53);
  const known = weeks.filter((w) => w.amount != null);
  return {
    ok: true, op: "emission", coin, covered: true, slug, source: "Tokenomist", url: tokenomistPage(slug), window: { start, end, days },
    weeks, totalAmount: known.length ? round(known.reduce((s, w) => s + w.amount, 0), 2) : null,
  };
}

async function opAlloc({ coin, slug }, io) {
  const d = await upstream(`/v5/allocations/${slug}`, {}, OPS.alloc.ttl, io);
  const x = Array.isArray(d) ? d[0] : d;
  const list = x && Array.isArray(x.allocations) ? x.allocations : [];
  return {
    ok: true, op: "alloc", coin, covered: true, slug, source: "Tokenomist", url: tokenomistPage(slug), updatedAt: day(x && x.lastUpdatedDate),
    maxSupply: numOrNull(x && x.maxSupply),
    allocations: list.slice(0, 8).map((a) => ({
      name: allocationLabel(a && (a.standardAllocationName || a.allocationName)),
      pct: round(numOrNull(a && a.trackedAllocationPercentage), 1),
      unlocked: numOrNull(a && a.allocationUnlockedAmount),
      locked: numOrNull(a && a.allocationLockedAmount),
    })),
  };
}

const RUN = { unlocks: opUnlocks, upcoming: opUpcoming, emission: opEmission, alloc: opAlloc };

/**
 * The whole exchange, without HTTP: tests call this directly.
 * @param {{ query: Record<string,string>, env?: object, fetchImpl?: typeof fetch, now?: () => number, state?: object }} o
 * @returns {Promise<{ status: number, body: object, ttl: number|null }>}
 */
export async function tokenomistOnce({ query = {}, env = process.env, fetchImpl = fetch, now = Date.now, state = STATE } = {}) {
  const key = String(env.TOKENOMIST_API_KEY || "").trim();
  if (!key) return { status: 503, body: { ok: false, error: "not_configured" }, ttl: null };
  const q = query && typeof query === "object" ? query : {};
  const op = typeof q.op === "string" ? q.op : "";
  const spec = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  if (!spec) return { status: 400, body: { ok: false, error: "bad_request", message: "Unknown op." }, ttl: null };
  const allowed = new Set(["op", ...(spec.coin ? ["coin"] : []), ...(spec.days ? ["days"] : [])]);
  for (const k of Object.keys(q)) if (!allowed.has(k)) return { status: 400, body: { ok: false, error: "bad_request", message: `Unknown parameter ${k.slice(0, 20)}.` }, ttl: null };

  let coin = null;
  let slug = null;
  if (spec.coin) {
    const raw = typeof q.coin === "string" ? q.coin.trim() : "";
    if (!/^[A-Za-z0-9-]{1,20}$/.test(raw)) return { status: 400, body: { ok: false, error: "bad_request", message: "A coin is needed." }, ttl: null };
    coin = hlCoinFor(raw);
    slug = coin ? slugFor(coin) : null;
    if (!slug || !SLUG_RE.test(slug)) return { status: 200, body: { ok: true, op, coin: raw.toUpperCase(), covered: false, source: "Tokenomist" }, ttl: spec.ttl };
  }
  let days = null;
  if (spec.days) {
    const [lo, hi, dflt] = spec.days;
    if (q.days == null || q.days === "") days = dflt;
    else {
      const n = Number(q.days);
      if (!Number.isInteger(n)) return { status: 400, body: { ok: false, error: "bad_request", message: "days must be a whole number." }, ttl: null };
      days = Math.max(lo, Math.min(hi, n));
    }
  }
  const t = now();
  const start = ymd(t);
  const end = ymd(t + (days || 0) * DAY_MS);
  /* What is fetched: the bucket's window (one cache entry, and one credit, for every `days` inside it). */
  const fetchEnd = ymd(t + (bucketOf(days || 0, spec.buckets) || 0) * DAY_MS);
  const io = { st: state, key, base: String(env.TOKENOMIST_BASE_URL || TOKENOMIST_BASE).replace(/\/+$/, ""), fetchImpl, now };
  try {
    const body = await RUN[op]({ coin, slug, start, end, fetchEnd, days }, io);
    return { status: 200, body, ttl: spec.ttl };
  } catch (e) {
    if (e instanceof Fail) return { status: e.status, body: { ok: false, error: e.error }, ttl: null };
    return { status: 502, body: { ok: false, error: "unavailable" }, ttl: null };
  }
}

function send(res, status, body, ttl) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (status === 200 && ttl) {
    res.setHeader("cache-control", "public, max-age=300");
    res.setHeader("vercel-cdn-cache-control", `max-age=${ttl}, stale-while-revalidate=${ttl * 4}, stale-if-error=86400`);
  } else {
    res.setHeader("cache-control", "no-store");
  }
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, 429, { ok: false, error: "rate_limited" });
  let query = {};
  try {
    const u = new URL(req.url || "/", "http://localhost");
    query = Object.fromEntries(u.searchParams.entries());
  } catch {
    return send(res, 400, { ok: false, error: "bad_request" });
  }
  const out = await tokenomistOnce({ query });
  return send(res, out.status, out.body, out.ttl);
}
