// ─────────────────────────────────────────────────────────────────────────────
// reqCache — collapse N independent pollers of the SAME object into one fetch.
// ─────────────────────────────────────────────────────────────────────────────
//
// The token page fetched the identical `/candles?token=..&interval=300&limit=1000`
// TWICE (ChartPanel had its own 15s poll and useTokenData had another), and the
// desktop shell mounts TWO `useHotFeed` instances (the left rail and the ticker)
// that poll the identical 15 KB `/hot` payload every 8s. Measured on a live token
// page, 2026-08-18: 8.3 `/candles` req/min and 16.6 `/hot` req/min, of which
// exactly half was byte-identical duplication — and `/candles` carries no
// `Cache-Control`/`ETag`, so the browser could not dedupe it either.
//
// This is the same shape as the `_junoRows` memo already in useHotFeed.js, made
// reusable: a TTL memo plus IN-FLIGHT coalescing. The in-flight half matters as
// much as the TTL — three components mounting in the same tick would all miss a
// pure TTL cache and fire three requests.
//
// TTL is deliberately just under the caller's poll period (see CACHE_FRACTION at
// each call site): with two 15s pollers offset by ~7s and a 13.5s TTL, the second
// one always hits the memo, so the pair costs exactly one poll period's worth of
// requests instead of two. Data is at most (TTL) old, which is noise next to the
// indexer's own ~2 min cron.
//
// NOT a substitute for HTTP caching — `cache-control: s-maxage=2,
// stale-while-revalidate=8` on the worker collapses N *viewers* to one origin
// fetch. This collapses N *components in one tab*. They compose.

const _mem = new Map(); // key -> { at, val, inflight }, least recently used first

// 🔴 BOUNDED. Every key ever asked — a /candles payload per coin per interval, a
// /hot list, a holder count — used to stay in `_mem` for the life of the tab, and
// dropCached has no callers, so a long browsing session only ever grew. Now the
// least recently USED entries go once there are more than MAX_ENTRIES. Two rules:
//   · an entry with a flight in the air is never evicted: its callers are
//     joined to it, and a second caller must still find it to join;
//   · a read is a use — a cachedFetch hit and a cachedPeek both move the key to
//     the recent end, so the page being revisited is the last thing to go.
// 500 is generous on purpose: a coin page holds a handful of keys, so the
// revisit-paints-instantly peek survives far more browsing than anyone does.
const MAX_ENTRIES = 500;
function touch(key, entry) {
  _mem.delete(key);
  _mem.set(key, entry);
}
function trim() {
  if (_mem.size <= MAX_ENTRIES) return;
  for (const [k, e] of _mem) {
    if (_mem.size <= MAX_ENTRIES) break;
    if (e.inflight) continue;
    _mem.delete(k);
  }
}

/**
 * @param key    stable identity of the object being fetched
 * @param ttlMs  serve the memo when it is younger than this
 * @param fn     () => Promise<value>  — only called on a miss
 */
export function cachedFetch(key, ttlMs, fn) {
  const hit = _mem.get(key);
  if (hit) {
    touch(key, hit);
    if (hit.inflight) return hit.inflight;                       // coalesce
    if (Date.now() - hit.at < ttlMs) return Promise.resolve(hit.val);
  }
  const entry = hit || {};
  entry.inflight = Promise.resolve()
    .then(fn)
    .then((val) => {
      // Only a REAL answer refreshes the memo. Every fetcher in candleSource.js
      // resolves null on failure; caching that would pin the UI to "no data" for
      // the whole TTL instead of letting the next poll retry immediately.
      if (val != null) { entry.at = Date.now(); entry.val = val; }
      entry.inflight = null;
      return val;
    })
    .catch((e) => { entry.inflight = null; throw e; });
  _mem.set(key, entry);
  trim();   // after the set: the entry just given a flight is never the one dropped
  return entry.inflight;
}

/**
 * The last REAL answer for a key, read synchronously, or null.
 *
 * 🔴 FOR PAINTING WHAT WE ALREADY KNOW, not for deciding anything. Owner,
 * 2026-09-08: *"สลับหน้า พอกดกลับมา หน้าเหรียญก็เหมือนดึงใหม่ / โหลดครั้งแรกไปแล้ว
 * มันควรเก็บไว้ใน Cache ดิ"*. The bytes were already here — `cachedFetch` keeps the
 * value in `_mem` — but every consumer threw its own copy away on unmount and came
 * back to a blank screen while it re-asked for something this module could have
 * handed over instantly.
 *
 * `maxAgeMs` defaults to Infinity ON PURPOSE: this is stale-while-revalidate, and
 * the point is to show the last known picture AT ONCE and let the live poll
 * correct it a moment later. A caller that must not show a stale value passes a
 * real age and gets null instead.
 */
export function cachedPeek(key, maxAgeMs = Infinity) {
  const hit = _mem.get(key);
  if (!hit || hit.val == null) return null;
  if (maxAgeMs !== Infinity && Date.now() - hit.at >= maxAgeMs) return null;
  touch(key, hit);
  return hit.val;
}

/** Drop one key (or everything). Used when a token/indexer switch makes the
 *  memo meaningless rather than merely stale. */
export function dropCached(key) {
  if (key == null) _mem.clear();
  else for (const k of [..._mem.keys()]) if (k === key || k.startsWith(key)) _mem.delete(k);
}
