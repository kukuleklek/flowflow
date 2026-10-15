// FlowFlow's own limits, on top of Hyperliquid's (SPEC §2.3). They are enforced in code, before anything is signed,
// for the trade form and the Agent alike: the demo runs on mainnet with real money.
//
// 🔴 AN ENV VALUE CAN ONLY LOWER A CAP, NEVER RAISE IT. The ceilings below are code: VITE_MAX_MARGIN_USDC=200 in a
// build still caps every order at 20 USDC, and VITE_AGENT_MAX_LEVERAGE=50 still caps the Agent at 10x (api/chat.js
// and api/realtime-session.js state the same caps in the prompts, lowered by the same env, never raised).
// This file has no imports (the attack suite loads a copy of it with an injected env).

/* Vite's env in the browser; nothing (defaults) under Node, where the tests and the server read this file. */
const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};

/** The ceilings no env can pass. */
export const HARD_MAX_MARGIN_USDC = 20;
export const HARD_AGENT_MAX_LEVERAGE = 10;

/* A positive env number, at most the ceiling; anything else is the ceiling. */
const lowerOnly = (v, ceiling) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, ceiling) : ceiling;
};

/** Most USDC of margin one order may put up. */
export const MAX_MARGIN_USDC = lowerOnly(ENV.VITE_MAX_MARGIN_USDC, HARD_MAX_MARGIN_USDC);

/** Highest leverage the Agent may propose (the form offers the market's own detents). */
export const AGENT_MAX_LEVERAGE = lowerOnly(ENV.VITE_AGENT_MAX_LEVERAGE, HARD_AGENT_MAX_LEVERAGE);

/* ── HIP-3 stock perps (docs/PLAN-HIP3-STOCKS.md §4.0) ───────────────────────────────────────────────────────────
   A stock lives on its own Hyperliquid pot (dex "xyz"); an order there needs USDC moved into that pot first, and the
   money comes home when the stock is sold. Owner, 2026-10-15 (Q0, Q9): "การย้ายเงิน เข้าออก และย้ายออกมาจาก HIP
   ตอนขาย ควร Auto คนไม่ต้องรู้ห่าอะไรเลย ไม่ต้องมีเพดาน ไม่ต้องผ่าน Relay" — automatic, no amount cap, not through
   Relay. What stays is correctness, not a cap (exchange/client.js): the customer's own address only, only the pots
   listed here, exactly what the order needs, one move at a time, never pulled out from under a cross position.
   VITE_STOCK_AUTO_MOVE=off is the kill switch (an emergency stop, not a setting). */
export const STOCK_AUTO_MOVE = ENV.VITE_STOCK_AUTO_MOVE !== "off";
/** The only pots money may move to or from (besides the main one). */
export const STOCK_DEXES = Object.freeze(["xyz"]);

/** The cap's words, when an amount is over it. */
export const marginCapText = () => `Max ${MAX_MARGIN_USDC} USDC per order in FlowFlow for now`;
