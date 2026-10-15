/**
 * test-hl-ws — ONE shared Hyperliquid WebSocket per tab, driven with a fake
 * socket and a fake clock.
 *
 *   node --test scripts/test-hl-ws.mjs
 *
 * Owner rule 4: do not hammer public endpoints. One socket per tab, refcounted
 * subscriptions, paused while the tab is hidden, no tight loops. Hyperliquid's
 * own limits per IP: 10 sockets, 30 new connections a minute, 1000
 * subscriptions; the server drops a socket after 60 s without a message, so
 * the client pings.
 *
 * Live facts pinned here (read-only probe, 2026-09-22): the subscription ack
 * arrives on channel "subscriptionResponse" and echoes the subscription with
 * its keys REORDERED; a candle push is keyed by data.s and data.i; activeAssetCtx
 * by data.coin; a rejected subscription arrives on channel "error" as a string
 * that embeds the request; ping is answered on channel "pong".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHlWs, hlSubKey } from "../src/lib/hyperliquid/ws.js";

/* ── fakes ─────────────────────────────────────────────────────────────── */

function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    pending: () => timers.size,
    nextIn: () => Math.min(...[...timers.values()].map((x) => x.at - t)),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best[1].at || (x.at === best[1].at && id < best[0]))) best = [id, x];
        if (!best) break;
        timers.delete(best[0]);
        t = best[1].at;
        best[1].fn();
      }
      t = end;
    },
  };
}

function fakeSockets() {
  const all = [];
  const make = (url) => {
    const s = {
      url, readyState: 0, sent: [], closed: false,
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send(str) {
        if (s.readyState !== 1) throw new Error("InvalidStateError: send while not OPEN");
        s.sent.push(JSON.parse(str));
      },
      close() { if (s.closed) return; s.closed = true; s.readyState = 3; if (s.onclose) s.onclose({ code: 1000 }); },
      /* test drivers */
      open() { s.readyState = 1; if (s.onopen) s.onopen({}); },
      recv(obj) { if (s.onmessage) s.onmessage({ data: JSON.stringify(obj) }); },
      drop(code = 1006) { if (s.closed) return; s.closed = true; s.readyState = 3; if (s.onclose) s.onclose({ code }); },
      subs() { return s.sent.filter((m) => m.method === "subscribe").map((m) => m.subscription); },
      unsubs() { return s.sent.filter((m) => m.method === "unsubscribe").map((m) => m.subscription); },
      pings() { return s.sent.filter((m) => m.method === "ping").length; },
    };
    all.push(s);
    return s;
  };
  return { all, make, last: () => all[all.length - 1] };
}

function fakeVisibility(hidden = false) {
  const fns = new Set();
  return {
    isHidden: () => hidden,
    onVisibilityChange: (fn) => { fns.add(fn); return () => fns.delete(fn); },
    set(h) { hidden = h; for (const fn of [...fns]) fn(); },
    listeners: () => fns.size,
  };
}

function rig(opts = {}) {
  const clock = fakeClock();
  const sockets = fakeSockets();
  const vis = fakeVisibility(!!opts.hidden);
  const ws = createHlWs({
    url: "wss://x.test/ws",
    createSocket: sockets.make,
    timers: clock.timers,
    now: clock.now,
    random: () => 0.5,
    isHidden: vis.isHidden,
    onVisibilityChange: vis.onVisibilityChange,
    ...opts.deps,
  });
  return { clock, sockets, vis, ws };
}

const CANDLE = { type: "candle", coin: "BTC", interval: "1m" };
const candleMsg = (c = "85520.0", s = "BTC", i = "1m") => ({ channel: "candle", data: { t: 1, T: 2, s, i, o: "1", c, h: "1", l: "1", v: "1", n: 1 } });

/* ── tests ─────────────────────────────────────────────────────────────── */

test("hlSubKey is canonical: the same subscription in any key order is one key", () => {
  assert.equal(hlSubKey({ type: "candle", coin: "BTC", interval: "1m" }), hlSubKey({ interval: "1m", coin: "BTC", type: "candle" }));
  assert.notEqual(hlSubKey(CANDLE), hlSubKey({ ...CANDLE, interval: "5m" }));
});

test("nothing happens until someone subscribes (no socket at import or creation)", () => {
  const { sockets, clock, vis, ws } = rig();
  assert.equal(sockets.all.length, 0);
  assert.equal(clock.pending(), 0);
  assert.equal(vis.listeners(), 0);
  assert.equal(ws.status(), "idle");
});

test("many subscribers, one socket, one server subscription per distinct key", () => {
  const { sockets, ws } = rig();
  const a = [];
  const b = [];
  ws.subscribe(CANDLE, (d) => a.push(d));
  ws.subscribe({ interval: "1m", coin: "BTC", type: "candle" }, (d) => b.push(d));
  ws.subscribe({ type: "allMids" }, () => {});
  assert.equal(sockets.all.length, 1, "one socket for the tab");
  const s = sockets.last();
  assert.deepEqual(s.sent, [], "nothing is sent on a CONNECTING socket");
  s.open();
  assert.equal(ws.status(), "open");
  assert.equal(s.subs().length, 2, "BTC 1m candle once, allMids once");
  s.recv({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "candle", interval: "1m", coin: "BTC" } } });
  s.recv(candleMsg());
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].c, "85520.0", "handlers get the message's data");
});

test("routing: a candle for another coin or interval does not reach this subscriber", () => {
  const { sockets, ws } = rig();
  const got = [];
  ws.subscribe(CANDLE, (d) => got.push(d));
  const eth = [];
  ws.subscribe({ type: "activeAssetCtx", coin: "ETH" }, (d) => eth.push(d));
  sockets.last().open();
  sockets.last().recv(candleMsg("1", "ETH", "1m"));
  sockets.last().recv(candleMsg("1", "BTC", "5m"));
  sockets.last().recv({ channel: "activeAssetCtx", data: { coin: "BTC", ctx: {} } });
  assert.equal(got.length, 0);
  assert.equal(eth.length, 0);
  sockets.last().recv({ channel: "activeAssetCtx", data: { coin: "ETH", ctx: { markPx: "1" } } });
  assert.equal(eth.length, 1);
});

test("refcount: the server unsubscribe goes out only when the LAST handler for a key leaves", () => {
  const { sockets, ws } = rig();
  const off1 = ws.subscribe(CANDLE, () => {});
  const off2 = ws.subscribe(CANDLE, () => {});
  const s = sockets.last();
  s.open();
  off1();
  assert.equal(s.unsubs().length, 0);
  off2();
  assert.deepEqual(s.unsubs(), [CANDLE]);
  off2(); // idempotent
  assert.equal(s.unsubs().length, 1);
});

test("a late subscriber to a live key gets the last message at once (no blank until the next push)", () => {
  const { sockets, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  sockets.last().recv(candleMsg("42"));
  const late = [];
  ws.subscribe(CANDLE, (d) => late.push(d));
  assert.equal(late.length, 1);
  assert.equal(late[0].c, "42");
});

test("the last message is forgotten when the socket drops: no stale replay after a reconnect", () => {
  const { sockets, clock, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  sockets.last().recv(candleMsg("42"));
  sockets.last().drop();
  clock.advance(60_000);
  const late = [];
  ws.subscribe(CANDLE, (d) => late.push(d));
  assert.equal(late.length, 0);
});

test("reconnect: backoff grows and caps, and every live subscription is re-sent on the new socket", () => {
  const { sockets, clock, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  ws.subscribe({ type: "allMids" }, () => {});
  sockets.last().open();
  const delays = [];
  for (let k = 0; k < 8; k++) {
    sockets.last().drop();
    assert.equal(ws.status(), "reconnecting");
    const n = sockets.all.length;
    const wait = clock.nextIn();
    delays.push(wait);
    clock.advance(wait - 1);
    assert.equal(sockets.all.length, n, "no socket before the backoff elapses");
    clock.advance(1);
    assert.equal(sockets.all.length, n + 1);
    // The next pass drops it before it ever opens: the delay must keep growing.
  }
  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
  assert.ok(delays.every((d) => d <= 30_000), `capped at 30 s: ${delays}`);
  assert.equal(delays[7], 30_000);
  const s = sockets.last();
  s.open();
  assert.equal(s.subs().length, 2, "both subscriptions re-sent");
});

test("backoff resets only after a connection stayed up (a flapping server cannot make it tight)", () => {
  const { sockets, clock, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  sockets.last().drop();
  clock.advance(clock.nextIn());          // attempt 1 -> 1000
  sockets.last().open();
  sockets.last().drop();                  // opened but dropped at once
  assert.equal(clock.nextIn(), 2000, "an open that did not last is still a failure");
  clock.advance(2000);
  sockets.last().open();
  clock.advance(15_000);                  // stayed up long enough
  sockets.last().drop();
  assert.equal(clock.nextIn(), 1000, "a stable connection resets the backoff");
});

test("ping keeps the socket alive; a silent socket is treated as dead and replaced", () => {
  const { sockets, clock, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  const s = sockets.last();
  s.open();
  clock.advance(30_000);
  assert.equal(s.pings(), 1);
  s.recv({ channel: "pong" });
  clock.advance(30_000);
  assert.equal(s.pings(), 2);
  // Now nothing comes back at all.
  clock.advance(60_000);
  assert.ok(s.closed, "a socket silent for too long is closed");
  assert.equal(ws.status(), "reconnecting");
});

test("hidden tab: the socket closes after a short grace, nothing reconnects while hidden, visible resumes", () => {
  const { sockets, clock, vis, ws } = rig();
  const got = [];
  ws.subscribe(CANDLE, (d) => got.push(d));
  const s = sockets.last();
  s.open();
  vis.set(true);
  clock.advance(1000);
  assert.equal(s.closed, false, "a quick tab flip does not cost a reconnect");
  clock.advance(10_000);
  assert.equal(s.closed, true, "paused while hidden");
  assert.equal(ws.status(), "paused");
  clock.advance(10 * 60_000);
  assert.equal(sockets.all.length, 1, "no reconnect attempts while hidden");
  assert.equal(clock.pending(), 0, "no timers ticking while hidden");
  vis.set(false);
  assert.equal(sockets.all.length, 2, "visible reconnects at once");
  sockets.last().open();
  assert.deepEqual(sockets.last().subs(), [CANDLE], "and re-sends the live subscriptions");
});

test("a quick hide/show inside the grace keeps the same socket", () => {
  const { sockets, clock, vis, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  vis.set(true);
  clock.advance(2000);
  vis.set(false);
  clock.advance(60_000);
  assert.equal(sockets.all.length, 1);
  assert.equal(sockets.last().closed, false);
});

test("a socket that drops while hidden waits for visible instead of retrying", () => {
  const { sockets, clock, vis, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  vis.set(true);
  sockets.last().drop();
  clock.advance(5 * 60_000);
  assert.equal(sockets.all.length, 1);
  vis.set(false);
  assert.equal(sockets.all.length, 2);
});

test("a reconnect already waiting when the tab hides is cancelled, not left ticking", () => {
  const { sockets, clock, vis, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  sockets.last().drop();
  assert.equal(ws.status(), "reconnecting");
  vis.set(true);
  assert.equal(clock.pending(), 0, "the backoff timer is cleared on hide");
  assert.equal(ws.status(), "paused");
  clock.advance(5 * 60_000);
  assert.equal(sockets.all.length, 1);
  vis.set(false);
  assert.equal(sockets.all.length, 2, "and visible reconnects at once, without waiting out a backoff");
});

test("subscribing while the tab is hidden opens nothing until it is visible", () => {
  const { sockets, vis, ws } = rig({ hidden: true });
  ws.subscribe(CANDLE, () => {});
  assert.equal(sockets.all.length, 0);
  assert.equal(ws.status(), "paused");
  vis.set(false);
  assert.equal(sockets.all.length, 1);
});

test("no leaks: when the last subscriber leaves, the socket closes after a linger, every timer and listener is gone", () => {
  const { sockets, clock, vis, ws } = rig();
  const off = ws.subscribe(CANDLE, () => {});
  const off2 = ws.subscribe({ type: "allMids" }, () => {});
  sockets.last().open();
  assert.equal(vis.listeners(), 1);
  off();
  off2();
  assert.equal(sockets.last().closed, false, "a route change that resubscribes at once reuses the socket");
  clock.advance(15_000);
  assert.equal(sockets.last().closed, true);
  assert.equal(ws.status(), "idle");
  assert.equal(clock.pending(), 0, "no ping, no reconnect, no linger timer left");
  assert.equal(vis.listeners(), 0, "the visibility listener is removed");
  clock.advance(10 * 60_000);
  assert.equal(sockets.all.length, 1, "nothing reconnects an idle client");
});

test("resubscribing inside the linger keeps the socket", () => {
  const { sockets, clock, ws } = rig();
  const off = ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  off();
  clock.advance(1000);
  ws.subscribe(CANDLE, () => {});
  clock.advance(60_000);
  assert.equal(sockets.all.length, 1);
  assert.equal(sockets.last().closed, false);
  assert.deepEqual(sockets.last().subs(), [CANDLE, CANDLE], "unsubscribed on the server, then subscribed again");
});

test("a rejected subscription reaches that subscriber's onError and is not re-sent on reconnect", () => {
  const { sockets, clock, ws } = rig();
  const errs = [];
  const bad = { type: "webData2", user: "0x0000000000000000000000000000000000000000" };
  ws.subscribe(bad, () => {}, { onError: (e) => errs.push(e) });
  ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  sockets.last().recv({ channel: "error", data: `Error parsing JSON into valid websocket request: ${JSON.stringify({ method: "subscribe", subscription: bad })}` });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Error parsing JSON/);
  sockets.last().drop();
  clock.advance(clock.nextIn());
  sockets.last().open();
  assert.deepEqual(sockets.last().subs(), [CANDLE]);
});

test("a handler that throws does not stop the others", () => {
  const { sockets, ws } = rig();
  const got = [];
  ws.subscribe(CANDLE, () => { throw new Error("bad handler"); });
  ws.subscribe(CANDLE, (d) => got.push(d));
  sockets.last().open();
  sockets.last().recv(candleMsg());
  assert.equal(got.length, 1);
});

test("garbage frames are ignored", () => {
  const { sockets, ws } = rig();
  const got = [];
  ws.subscribe(CANDLE, (d) => got.push(d));
  const s = sockets.last();
  s.open();
  s.onmessage({ data: "not json" });
  s.onmessage({ data: "null" });
  s.recv({ channel: "candle" });
  assert.equal(got.length, 0);
});

test("onStatus reports the lifecycle so a price surface can say it is not live", () => {
  const { sockets, clock, vis, ws } = rig();
  const seen = [];
  const off = ws.onStatus((st) => seen.push(st));
  const unsub = ws.subscribe(CANDLE, () => {});
  sockets.last().open();
  sockets.last().drop();
  clock.advance(clock.nextIn());
  sockets.last().open();
  vis.set(true);
  clock.advance(10_000);
  vis.set(false);
  sockets.last().open();
  unsub();
  clock.advance(15_000);
  off();
  assert.deepEqual(seen, ["connecting", "open", "reconnecting", "connecting", "open", "paused", "connecting", "open", "idle"]);
});

test("stats() counts sockets ever opened, keys and handlers", () => {
  const { sockets, ws } = rig();
  ws.subscribe(CANDLE, () => {});
  ws.subscribe(CANDLE, () => {});
  ws.subscribe({ type: "allMids" }, () => {});
  sockets.last().open();
  assert.deepEqual(ws.stats(), { sockets: 1, keys: 2, handlers: 3 });
});
