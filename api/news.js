// GET /api/news?coin=HYPE | ?ticker=TSLA | ?topic=crypto|stocks|market — free headlines for the FlowFlow chat (a Vercel
// function; AGENT-STOCKS-AND-MAP.md items 12 and 18). No key: every source is a public RSS feed, checked live on
// 2026-10-15 (crypto: CoinDesk, Cointelegraph + its per-coin tag feeds, The Block, Decrypt; US stocks: Yahoo Finance
// and Nasdaq per-ticker feeds; US market: CNBC Markets and Yahoo Finance's S&P 500 feed). CryptoPanic and the
// CryptoCompare / CoinDesk data APIs now answer 401/403 without a key, so they are not used.
//
// 🔴 HEADLINES ONLY. An answer is at most 5 × { title, source, url, publishedAt }: the headline as the newsroom wrote it
// (HTML stripped, entities decoded, never rewritten or cut), who published it, the link to read it there, and when. Feed
// descriptions and article bodies are never read into the answer (copyright: we point to the article, we do not copy
// it). Headline text is third-party data: the chat shows it as a quote and the model must never act on it.
//
// 🔴 NO OPEN PROXY. The caller picks WHAT (a coin, a whitelisted ticker, a topic), never WHERE: every upstream URL is
// built here from a fixed host list (UPSTREAM_HOSTS) and our own tables (a coin's Cointelegraph tag comes from
// CT_TAGS; a ticker must be on the HIP-3 stock whitelist). Pages other than ours are refused (originCheck.js), 30 calls
// a minute per IP, each upstream call has a timeout and a size cap, and each feed is read at most once per 10 min per
// warm instance (the CDN keeps each answer 10 min too): a few dozen feeds in all, each asked like one reader's RSS app.
// None of these feeds publishes a rate limit. Their terms: Yahoo allows its RSS shown unmodified, attributed and
// linked to the article (we do exactly that); Cointelegraph's and Decrypt's site terms say personal / non-commercial
// use, so a production launch needs the owner's call (or a licensed news API) for those two.
//
// A coin is matched against headlines by src/lib/news/match.js (a capital ticker or the project's name, never "hype"
// for HYPE). A source that fails is skipped (its last answer is served for up to 6 h); when every source fails the
// answer is 200 { items: [], unavailable: true } so the chat simply shows no news.
import { paidOriginAllowed } from "../src/lib/originCheck.js";
import { resolveStock } from "../src/lib/hyperliquid/hip3/names.js";
import { STOCK_WHITELIST } from "../src/lib/hyperliquid/hip3/whitelist.js";
import { headlineMentionsCoin, headlineMentionsStock, isTickerRoundup, newsBase, NASDAQ_100_RE } from "../src/lib/news/match.js";

export const RATE_PER_MIN = 30;
export const MAX_ITEMS = 5;
/** Per source in one answer, so five CoinDesk headlines never crowd out everyone else. */
export const MAX_PER_SOURCE = 3;
export const FEED_TTL_MS = 10 * 60_000;
export const STALE_MS = 6 * 3_600_000;
/** After a failed read, a source is not asked again for this long (its stale copy, if any, is served). */
export const FAIL_BACKOFF_MS = 60_000;
export const FEED_TIMEOUT_MS = 6_000;
export const MAX_FEED_BYTES = 2_000_000;
/** Longer headlines are left out (never cut, see cleanTitle). */
export const TITLE_MAX = 300;
const URL_MAX = 600;
const ITEMS_PER_FEED = 60;
const MAX_CACHE = 200;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How old a headline may be: a coin or a stock may be quiet for a week; "today's news" may not. */
export const MAX_AGE_MS = Object.freeze({ coin: 14 * DAY_MS, stock: 14 * DAY_MS, index: 3 * DAY_MS, topic: 2 * DAY_MS });
const CDN_TTL_S = 600;

/** The only hosts this function ever calls. */
export const UPSTREAM_HOSTS = Object.freeze(new Set([
  "www.coindesk.com", "cointelegraph.com", "www.theblock.co", "decrypt.co",
  "search.cnbc.com", "feeds.finance.yahoo.com", "www.nasdaq.com",
]));

/** The fixed feeds. `aggregator`: its items link to other publishers, so the source shown is the publisher's. */
export const FEEDS = Object.freeze({
  coindesk: Object.freeze({ key: "coindesk", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" }),
  cointelegraph: Object.freeze({ key: "cointelegraph", name: "Cointelegraph", url: "https://cointelegraph.com/rss" }),
  theblock: Object.freeze({ key: "theblock", name: "The Block", url: "https://www.theblock.co/rss.xml" }),
  decrypt: Object.freeze({ key: "decrypt", name: "Decrypt", url: "https://decrypt.co/feed" }),
  cnbcMarkets: Object.freeze({ key: "cnbc:markets", name: "CNBC", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" }),
});
const yahooFeed = (sym) => ({
  key: `yahoo:${sym}`, name: "Yahoo Finance", aggregator: true,
  url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`,
});
const nasdaqFeed = (sym) => ({ key: `nasdaq:${sym}`, name: "Nasdaq", url: `https://www.nasdaq.com/feed/rssoutbound?symbol=${encodeURIComponent(sym)}` });
const ctTagFeed = (tag) => ({ key: `ct:${tag}`, name: "Cointelegraph", url: `https://cointelegraph.com/rss/tag/${tag}` });

/** Bare ticker -> its Cointelegraph tag feed (each answered 200 with items on 2026-10-15; the rest 404). More depth
 *  for a coin than the front pages; every headline still has to name the coin. */
export const CT_TAGS = Object.freeze({
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", HYPE: "hyperliquid", XRP: "xrp", DOGE: "dogecoin", ADA: "cardano",
  LINK: "chainlink", AVAX: "avalanche", SUI: "sui", AAVE: "aave", UNI: "uniswap", NEAR: "near-protocol", TON: "ton",
  TRX: "tron", LTC: "litecoin", DOT: "polkadot", ARB: "arbitrum", BNB: "bnb", PEPE: "pepe", WLD: "worldcoin",
  ZEC: "zcash", APT: "aptos", INJ: "injective", MON: "monad", BCH: "bitcoin-cash", XLM: "stellar", HBAR: "hedera",
  SHIB: "shiba-inu", FIL: "filecoin", ATOM: "cosmos", POL: "polygon", ALGO: "algorand", ICP: "internet-computer",
  EIGEN: "eigenlayer",
});

/** Who published a link from an aggregator feed (by host; an unknown host is shown as the host itself). */
const PUBLISHERS = Object.freeze({
  "fool.com": "The Motley Fool", "benzinga.com": "Benzinga", "stocktwits.com": "Stocktwits", "reuters.com": "Reuters",
  "bloomberg.com": "Bloomberg", "cnbc.com": "CNBC", "investors.com": "Investor's Business Daily", "barrons.com": "Barron's",
  "marketwatch.com": "MarketWatch", "wsj.com": "WSJ", "finance.yahoo.com": "Yahoo Finance", "yahoo.com": "Yahoo Finance",
  "nasdaq.com": "Nasdaq", "zacks.com": "Zacks", "seekingalpha.com": "Seeking Alpha", "thestreet.com": "TheStreet",
  "insidermonkey.com": "Insider Monkey", "gurufocus.com": "GuruFocus", "investopedia.com": "Investopedia",
  "247wallst.com": "24/7 Wall St.", "tipranks.com": "TipRanks", "simplywall.st": "Simply Wall St", "investing.com": "Investing.com",
  "forbes.com": "Forbes", "ft.com": "Financial Times", "apnews.com": "AP", "businessinsider.com": "Business Insider",
  "techcrunch.com": "TechCrunch", "electrek.co": "Electrek", "kiplinger.com": "Kiplinger", "marketbeat.com": "MarketBeat",
  "globenewswire.com": "GlobeNewswire", "prnewswire.com": "PR Newswire", "businesswire.com": "Business Wire",
  "accesswire.com": "ACCESSWIRE", "coindesk.com": "CoinDesk", "cointelegraph.com": "Cointelegraph", "decrypt.co": "Decrypt",
  "theblock.co": "The Block", "investorplace.com": "InvestorPlace", "fxstreet.com": "FXStreet", "axios.com": "Axios",
});

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/* ── feed text -> headlines ───────────────────────────────────────────────── */

const NAMED = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", hellip: "…", euro: "€", pound: "£", yen: "¥", copy: "©", reg: "®", trade: "™", times: "×",
});
const ENTITY_RE = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi;
function decodeOnce(s) {
  return s.replace(ENTITY_RE, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return fin(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : " ";
    }
    const v = NAMED[e.toLowerCase()];
    return v == null ? m : v;
  });
}
/** Entities decoded (twice at most: some feeds encode "&amp;#8217;"). */
const HAS_ENTITY_RE = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/i;
export function decodeEntities(s) {
  const once = decodeOnce(String(s));
  return HAS_ENTITY_RE.test(once) ? decodeOnce(once) : once;
}
const stripCdata = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
/* Control, zero-width and direction-override characters: a headline can never hide text or flip its own direction. */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/**
 * A feed title as plain one-line text: CDATA unwrapped, tags removed (also entity-encoded ones, and a script or style
 * block with its contents), entities decoded, invisible characters dropped, whitespace collapsed. "" when nothing is
 * left. Never shortened: the feeds' terms (Yahoo's says it outright) allow showing a headline only without
 * modification, so a headline too long to show (TITLE_MAX) is left out, not cut; the UI clamps lines, not words.
 */
export function cleanTitle(s) {
  if (typeof s !== "string") return "";
  const noCode = (x) => x.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
  let t = noCode(stripCdata(s)).replace(/<[^>]*>/g, " ");
  t = noCode(decodeEntities(t)).replace(/<\/?[a-z][^>]*>/gi, " ");
  return t.replace(INVISIBLE_RE, " ").replace(/\s+/g, " ").trim();
}

/** An article link we can hand to a browser: absolute https, no credentials, tracking parameters removed; else null. */
export function cleanUrl(s) {
  if (typeof s !== "string") return null;
  const raw = decodeEntities(stripCdata(s)).replace(INVISIBLE_RE, "").trim();
  if (!raw || raw.length > 2000) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || k === ".tsrc") u.searchParams.delete(k);
  const out = u.toString();
  return out.length <= URL_MAX ? out : null;
}

/** The publisher of an aggregator's link: a known name by host, else the bare host. */
export function publisherOf(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  host = host.replace(/^www\./, "");
  for (const [d, name] of Object.entries(PUBLISHERS)) if (host === d || host.endsWith(`.${d}`)) return name;
  return /^[a-z0-9.-]{3,60}$/.test(host) ? host : null;
}

const tagText = (body, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(body);
  return m ? m[1] : null;
};
function linkOf(body) {
  const rss = /<link>([\s\S]*?)<\/link>/i.exec(body);
  if (rss && rss[1].trim()) return rss[1];
  /* Atom: the alternate link (or the only one). */
  const links = [...body.matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /\brel=["']alternate["']/i.test(a)) || links.find((a) => !/\brel=/i.test(a));
  const href = pick && /\bhref=["']([^"']+)["']/i.exec(pick);
  return href ? href[1] : null;
}
function dateOf(body) {
  for (const tag of ["pubDate", "published", "dc:date", "updated", "atom:updated"]) {
    const v = tagText(body, tag);
    if (v == null) continue;
    const ms = Date.parse(stripCdata(v).trim());
    if (fin(ms)) return ms;
  }
  return null;
}

/**
 * The headlines in an RSS or Atom document: { title, url, at (ms), sponsored } per item, at most `max`. Only the
 * title, the link, the date and CNBC's sponsored flag are read; descriptions and bodies never are. Null when the text
 * is not a feed at all (an HTML block page, an error).
 */
export function parseFeed(xml, { max = ITEMS_PER_FEED } = {}) {
  if (typeof xml !== "string" || !/<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 5000))) return null;
  const out = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < max) {
    const body = m[2];
    out.push({
      title: cleanTitle(tagText(body, "title") || ""),
      url: cleanUrl(linkOf(body)),
      at: dateOf(body),
      sponsored: /<metadata:sponsored>\s*true\s*<\/metadata:sponsored>/i.test(body),
    });
  }
  return out;
}

/* ── upstream ─────────────────────────────────────────────────────────────── */

/** The proxy's memory, one per warm instance: parsed feeds, failures, flights in the air, per-IP hits. */
export function createNewsState() {
  return { feeds: new Map(), fails: new Map(), inflight: new Map(), hits: new Map() };
}
const STATE = createNewsState();

/** A rough per-IP limit (per warm instance). */
export function rateLimited(ip, now = Date.now(), state = STATE) {
  const k = ip || "unknown";
  const recent = (state.hits.get(k) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  state.hits.set(k, recent);
  if (state.hits.size > 5000) state.hits.clear();
  return recent.length > RATE_PER_MIN;
}

const ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8";

/* One GET with an end: the timer also covers reading the body, and a host outside UPSTREAM_HOSTS is never called. */
async function fetchFeed(url, fetchImpl, timeoutMs) {
  if (!UPSTREAM_HOSTS.has(new URL(url).hostname)) throw new Error("host");
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { if (ctrl) ctrl.abort(); reject(new Error("timeout")); }, timeoutMs);
  });
  try {
    const r = await Promise.race([
      fetchImpl(url, { method: "GET", headers: { accept: ACCEPT }, redirect: "follow", ...(ctrl ? { signal: ctrl.signal } : {}) }),
      timeout,
    ]);
    if (!r || r.status !== 200) throw new Error("status");
    const len = Number(r.headers && typeof r.headers.get === "function" ? r.headers.get("content-length") : NaN);
    if (fin(len) && len > MAX_FEED_BYTES) throw new Error("too_big");
    const text = await Promise.race([r.text(), timeout]);
    if (typeof text !== "string" || text.length > MAX_FEED_BYTES) throw new Error("too_big");
    const items = parseFeed(text);
    if (!items) throw new Error("not_a_feed");
    return items;
  } finally {
    clearTimeout(timer);
  }
}

/* A feed's headlines: cached while fresh; one flight per feed however many callers; a failure serves the last copy
   (up to STALE_MS) and is not retried for FAIL_BACKOFF_MS. Never rejects: { items } or { items: null }. */
function readFeed(feed, io) {
  const { st, fetchImpl, now, timeoutMs } = io;
  const t = now();
  const hit = st.feeds.get(feed.key);
  const stale = (at) => (hit && at - hit.at < FEED_TTL_MS + STALE_MS ? { items: hit.items, stale: true } : { items: null });
  if (hit && t - hit.at < FEED_TTL_MS) return Promise.resolve({ items: hit.items });
  const failedAt = st.fails.get(feed.key);
  if (failedAt != null && t - failedAt < FAIL_BACKOFF_MS) return Promise.resolve(stale(t));
  if (st.inflight.has(feed.key)) return st.inflight.get(feed.key);
  const flight = (async () => {
    try {
      const items = await fetchFeed(feed.url, fetchImpl, timeoutMs);
      st.feeds.delete(feed.key);
      st.feeds.set(feed.key, { at: now(), items });
      st.fails.delete(feed.key);
      while (st.feeds.size > MAX_CACHE) st.feeds.delete(st.feeds.keys().next().value);
      return { items };
    } catch {
      st.fails.set(feed.key, now());
      if (st.fails.size > MAX_CACHE) st.fails.clear();
      return stale(now());
    } finally {
      st.inflight.delete(feed.key);
    }
  })();
  st.inflight.set(feed.key, flight);
  return flight;
}

/* ── what to read for a query ─────────────────────────────────────────────── */

const bad = (message) => ({ error: message });

/** The caller's query -> the feeds to read and the rule a headline must pass. Exactly one of coin / ticker / topic. */
export function planFor(query) {
  const q = query && typeof query === "object" ? query : {};
  const keys = Object.keys(q);
  for (const k of keys) if (!["coin", "ticker", "topic"].includes(k)) return bad(`Unknown parameter ${String(k).slice(0, 20)}.`);
  if (keys.length !== 1) return bad("Ask for one coin, ticker or topic.");
  const raw = typeof q[keys[0]] === "string" ? q[keys[0]].trim() : "";

  if (keys[0] === "topic") {
    const topic = raw.toLowerCase();
    const crypto = [FEEDS.coindesk, FEEDS.cointelegraph, FEEDS.theblock];
    const stocks = [FEEDS.cnbcMarkets, yahooFeed("^GSPC")];
    const feeds = topic === "crypto" ? crypto : topic === "stocks" ? stocks : topic === "market" ? [...crypto, ...stocks] : null;
    if (!feeds) return bad("topic is crypto, stocks or market.");
    return { query: { topic }, feeds, keep: () => true, maxAgeMs: MAX_AGE_MS.topic };
  }

  if (!/^[A-Za-z0-9]{1,20}(:[A-Za-z0-9]{1,20})?$/.test(raw)) return bad(`A ${keys[0]} is needed.`);
  /* A stock asked for as a coin ("xyz:TSLA", the app's market name) is a ticker. */
  const asTicker = keys[0] === "ticker" || raw.includes(":");
  if (!asTicker) {
    const base = newsBase(raw);
    if (!base) return bad("A coin is needed.");
    const feeds = [FEEDS.coindesk, FEEDS.cointelegraph, FEEDS.theblock, FEEDS.decrypt];
    if (Object.prototype.hasOwnProperty.call(CT_TAGS, base)) feeds.push(ctTagFeed(CT_TAGS[base]));
    return { query: { coin: base }, feeds, keep: (title) => headlineMentionsCoin(title, base), maxAgeMs: MAX_AGE_MS.coin };
  }
  const coin = resolveStock(raw);
  const w = coin ? STOCK_WHITELIST.find((x) => x.coin === coin) : null;
  const ticker = w ? w.coin.slice(w.coin.indexOf(":") + 1) : raw.slice(raw.indexOf(":") + 1).toUpperCase();
  /* Not a stock FlowFlow lists (GOLD, AVGO…): nothing is fetched, and the chat says it has no news for it. */
  if (!w) return { query: { ticker }, covered: false };
  if (w.kind === "index") {
    /* An index has no ticker feed: its news is the US market's. The US 100 index is never the Nasdaq-100. */
    const keep = coin === "xyz:XYZ100" ? (title) => !NASDAQ_100_RE.test(title) : () => true;
    return { query: { ticker, name: w.name, kind: "index" }, feeds: [FEEDS.cnbcMarkets, yahooFeed("^GSPC")], keep, maxAgeMs: MAX_AGE_MS.index };
  }
  return {
    query: { ticker, name: w.name, kind: "stock" },
    feeds: [yahooFeed(ticker), nasdaqFeed(ticker)],
    keep: (title) => headlineMentionsStock(title, coin) && !isTickerRoundup(title),
    maxAgeMs: MAX_AGE_MS.stock,
  };
}

/* Same story from two feeds (Yahoo and Nasdaq carry the same Motley Fool piece): one headline. */
const titleKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 90);

/** Newest first, no duplicates, MAX_ITEMS in all, and at most MAX_PER_SOURCE from one source while others have news
 *  to show (a coin only one newsroom covers still gets its five). */
export function pickHeadlines(pool, { keep = () => true, maxAgeMs, now }) {
  const seen = new Set();
  const per = new Map();
  const out = [];
  const overflow = [];
  const rows = pool
    .filter((it) => it && it.title && it.title.length >= 8 && it.title.length <= TITLE_MAX && it.url && fin(it.at) && !it.sponsored
      && it.at <= now + 10 * 60_000 && now - it.at <= maxAgeMs && keep(it.title))
    .map((it, i) => ({ ...it, i }))
    .sort((a, b) => b.at - a.at || a.i - b.i);
  for (const it of rows) {
    const k = titleKey(it.title);
    if (!k || seen.has(k) || seen.has(it.url)) continue;
    const source = (it.feed && it.feed.aggregator ? publisherOf(it.url) : null) || (it.feed && it.feed.name) || null;
    if (!source) continue;
    seen.add(k);
    seen.add(it.url);
    const row = { title: it.title, source, url: it.url, publishedAt: new Date(it.at).toISOString(), at: it.at };
    if ((per.get(source) || 0) >= MAX_PER_SOURCE) { overflow.push(row); continue; }
    per.set(source, (per.get(source) || 0) + 1);
    out.push(row);
    if (out.length >= MAX_ITEMS) break;
  }
  for (const row of overflow) { if (out.length >= MAX_ITEMS) break; out.push(row); }
  return out.sort((a, b) => b.at - a.at).map(({ at, ...row }) => row);
}

/**
 * The whole exchange, without HTTP: tests call this directly.
 * @param {{ query: Record<string,string>, fetchImpl?: typeof fetch, now?: () => number, state?: object, timeoutMs?: number }} o
 * @returns {Promise<{ status: number, body: object, ttl: number|null }>}
 */
export async function newsOnce({ query = {}, fetchImpl = fetch, now = Date.now, state = STATE, timeoutMs = FEED_TIMEOUT_MS } = {}) {
  const plan = planFor(query);
  if (plan.error) return { status: 400, body: { ok: false, error: "bad_request", message: plan.error }, ttl: null };
  if (plan.covered === false) return { status: 200, body: { ok: true, query: plan.query, covered: false, items: [] }, ttl: CDN_TTL_S };
  const io = { st: state, fetchImpl, now, timeoutMs };
  const reads = await Promise.all(plan.feeds.map((f) => readFeed(f, io)));
  const pool = [];
  reads.forEach((r, i) => { if (r.items) for (const it of r.items) pool.push({ ...it, feed: plan.feeds[i] }); });
  const failed = reads.filter((r) => !r.items).length;
  const items = pickHeadlines(pool, { keep: plan.keep, maxAgeMs: plan.maxAgeMs, now: now() });
  const body = { ok: true, query: plan.query, covered: true, items };
  if (failed === reads.length) body.unavailable = true;
  else if (failed || reads.some((r) => r.stale)) body.partial = true;
  /* A failure is never cached at the CDN: the next reader tries again. */
  return { status: 200, body, ttl: failed === reads.length ? null : CDN_TTL_S };
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

/**
 * Only our own pages. A browser omits Origin on a same-origin GET, so then the browser's own Sec-Fetch-Site (which a
 * page cannot set) or, on an older browser, the Referer must say it is us. curl and scripts carry neither: refused.
 */
export function newsRequestAllowed(headers) {
  const h = headers || {};
  const origin = typeof h.origin === "string" ? h.origin : "";
  if (origin) return paidOriginAllowed(origin);
  if (h["sec-fetch-site"] === "same-origin") return true;
  try { return paidOriginAllowed(new URL(String(h.referer || "")).origin); } catch { return false; }
}

function send(res, status, body, ttl) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  if (status === 200 && ttl) {
    res.setHeader("cache-control", "public, max-age=300");
    res.setHeader("vercel-cdn-cache-control", `max-age=${ttl}, stale-while-revalidate=${ttl * 3}, stale-if-error=21600`);
  } else {
    res.setHeader("cache-control", "no-store");
  }
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
  if (!newsRequestAllowed(req.headers)) return send(res, 403, { ok: false, error: "forbidden" });
  const ip = String((req.headers && req.headers["x-forwarded-for"]) || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, 429, { ok: false, error: "rate_limited" });
  let query = {};
  try {
    const u = new URL(req.url || "/", "http://localhost");
    query = Object.fromEntries(u.searchParams.entries());
  } catch {
    return send(res, 400, { ok: false, error: "bad_request" });
  }
  const out = await newsOnce({ query });
  return send(res, out.status, out.body, out.ttl);
}
