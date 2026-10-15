// ─────────────────────────────────────────────────────────────────────────────
// Feeds live MARK prices into the mock engine — only for coins it holds.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner rule 4: one WebSocket per tab. The feeder opens nothing. It asks the
// app's one market store (lib/hyperliquid/markets.js) to stream a coin with
// retainCoin — the refcounted activeAssetCtx subscription the market page
// already uses — for exactly the coins with an open mock position, and lets go
// of a coin the moment its position is gone.
//
// It feeds markPx, the exchange's MARK (what Hyperliquid triggers TP / SL and
// liquidations on), never the mid the list prints. While the store says a
// coin is stale (the stream paused in a hidden tab, or is reconnecting) it
// feeds nothing and flags the engine's mark stale, so no trigger ever fires on
// a frozen price. The first fresh mark after that is fed at once.
//
// Refcounted: every usePerpMock mount retains it; the last release stops it.

import { isPerpMarketStale } from "../../lib/hyperliquid/markets.js";

const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * @param {{ engine: object, markets: { subscribe: Function, getSnapshot: Function, retainCoin: Function },
 *   isStale?: (snapshot: object, coin: string) => boolean }} deps
 */
export function createPerpMockFeeder({ engine, markets, isStale = isPerpMarketStale } = {}) {
  let users = 0;
  let offEngine = null;
  let offMarkets = null;
  const held = new Map();   // coin -> release from markets.retainCoin
  const fed = new Map();    // coin -> the last mark handed to the engine

  function sync() {
    const positions = engine.getSnapshot().positions;
    for (const coin of [...held.keys()]) {
      if (Object.prototype.hasOwnProperty.call(positions, coin)) continue;
      const release = held.get(coin);
      held.delete(coin);
      fed.delete(coin);
      release();
    }
    for (const coin of Object.keys(positions)) {
      if (!held.has(coin)) held.set(coin, markets.retainCoin(coin));
    }
  }

  function feed() {
    const snap = markets.getSnapshot();
    const byCoin = snap && snap.byCoin ? snap.byCoin : null;
    for (const coin of [...held.keys()]) {
      if (!held.has(coin)) continue;
      const row = byCoin && Object.prototype.hasOwnProperty.call(byCoin, coin) ? byCoin[coin] : null;
      const mark = row ? row.markPx : null;
      if (!posNum(mark)) continue;
      if (isStale(snap, coin)) {
        fed.delete(coin);
        engine.markStale(coin);
        continue;
      }
      if (fed.get(coin) === mark) continue;
      fed.set(coin, mark);
      engine.onMark(coin, mark);
    }
  }

  function onEngine() {
    sync();
    feed();
  }

  function start() {
    offEngine = engine.subscribe(onEngine);
    offMarkets = markets.subscribe(feed);
    onEngine();
  }

  function stop() {
    if (offEngine) { offEngine(); offEngine = null; }
    if (offMarkets) { offMarkets(); offMarkets = null; }
    for (const release of held.values()) release();
    held.clear();
    fed.clear();
  }

  return {
    /** Start feeding (the first caller) and get the release. */
    retain() {
      if (users++ === 0) start();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (--users === 0) stop();
      };
    },
    /** The coins currently streamed for the mock (for tests and debugging). */
    coins: () => [...held.keys()],
  };
}
