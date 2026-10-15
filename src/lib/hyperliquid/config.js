// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid endpoints — READ-ONLY market data for the Perp mode.
// ─────────────────────────────────────────────────────────────────────────────
//
// The browser talks to Hyperliquid DIRECTLY. Verified live 2026-09-22: POST
// /info answers with access-control-allow-origin *, so no proxy is needed — and
// a proxy would be wrong, because Hyperliquid rate-limits per IP (1200 weight a
// minute, 10 sockets, 30 new connections a minute). Routed through one of our
// workers, every FlowFlow user would share a single budget.
//
// Testnet is one constant away and never picked at runtime: asset indexes
// differ between the networks (mainnet index 0 is BTC, testnet index 0 is SOL),
// so a build that could flip networks on its own could send an order for the
// wrong coin once trading exists. Flip HL_NETWORK by hand for local testing.
//
// Nothing in this folder runs at import time: no socket, no request, no timer
// until a hook or a call asks for one. A production build that never routes to
// the Perp page therefore never talks to Hyperliquid at all.

export const HL_NETWORK = "mainnet";

export const HL_ENDPOINTS = Object.freeze({
  mainnet: Object.freeze({
    info: "https://api.hyperliquid.xyz/info",
    ws: "wss://api.hyperliquid.xyz/ws",
    app: "https://app.hyperliquid.xyz",
  }),
  testnet: Object.freeze({
    info: "https://api.hyperliquid-testnet.xyz/info",
    ws: "wss://api.hyperliquid-testnet.xyz/ws",
    app: "https://app.hyperliquid-testnet.xyz",
  }),
});

/** The endpoint set for a network (default: HL_NETWORK). Unknown names throw. */
export function hlEndpoints(network = HL_NETWORK) {
  const e = HL_ENDPOINTS[network];
  if (!e) throw new Error(`unknown Hyperliquid network: ${network}`);
  return e;
}
