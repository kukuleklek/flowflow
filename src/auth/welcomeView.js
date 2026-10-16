/**
 * welcomeView — the first-visit welcome's rules, apart from React so node can test them (scripts/test-welcome-flow.mjs).
 *
 * Owner, 2026-10-15: opening the site lands on /trade/BTC; a signed-out visitor on a DESKTOP sees a "Log in or sign
 * up" modal (Canva's layout: Sign in / Sign up on the left, FlowFlow's pitch with floating chips on the right), X
 * closes it and the chart stays usable. Phones never get it ("ส่วนมือถือ ไม่ต้องมี หน้ากั้นแบบนี้"). A sign-in started
 * from it ends on the same coin with the Chat tab open in the trade aside.
 *
 * The modal draws ConnectCard (the header's own sign-in), so there is one sign-in path. Nothing here signs or sends.
 */

/** MarketPage's own desktop breakpoint (useIsDesktop: min-width 1024px, Tailwind lg). */
export const WELCOME_DESKTOP_MIN = 1024;

/** sessionStorage: shown once per visit (a tab), never again until the tab is closed. */
export const WELCOME_SEEN_KEY = "ff.welcome.seen";
/** sessionStorage: { coin, at } written when a sign-in starts in the modal; survives the Google redirect. */
export const WELCOME_HANDOFF_KEY = "ff.welcome.handoff";
/** A hand-off older than this is a sign-in someone gave up on: ignored and cleared. */
export const WELCOME_HANDOFF_TTL_MS = 15 * 60 * 1000;

/** The words, exactly as the owner wrote them. */
export const WELCOME_COPY = Object.freeze({
  heading: "Log in or sign up",
  sub: "Long, short or ask FlowFlow.",
  titleLead: "FlowFlow: Privacy AI Perp DEX and DeFi Access on",
  network: "Mainnet",
  event: "U-Hackathon 2026",
  tagline: "Talk or Type To Trade",
  privyLead: "Powered by",
  privyTail: "a Stripe company",
});

/* A chip is a row of parts: a string, { logo, h, aspect | round } (a file under /public, drawn at its own aspect,
   the width known before the file loads so the chips can be placed at once), { icon } (Icon.jsx),
   or { flip: [a, b] } (the word that swaps every WELCOME_FLIP_MS). */
export const WELCOME_CHIPS = Object.freeze([
  { id: "hype", parts: ["Long", { logo: "/hl-coins/HYPE.svg", round: true }, "HYPE with setup data from", { logo: "/sponsors/tokenomist/tokenomist-mark-primary.png", h: 16, aspect: 621 / 624 }, "Tokenomist"] },
  { id: "ubot", parts: [{ logo: "/sponsors/ubot/ubot-logo.svg", h: 14, aspect: 79.0532 / 22.8459, alt: "u.bot" }, "Advice on position"] },
  { id: "perp", parts: ["Perp DEX on", { logo: "/sponsors/avalanche/AvalancheLogo_Horizontal_4C.clean.svg", h: 13, aspect: 1835 / 271, alt: "Avalanche" }] },
  { id: "private", parts: [{ icon: "lock" }, "Private", { flip: ["Deposit", "Withdraw"] }, "with", { logo: "/hl-coins/NEAR.svg", round: true }, "NEAR Intents"] },
  { id: "stake", parts: ["Staking", { logo: "/tokens/usdc.svg", round: true }, "USDC on", { logo: "/sponsors/aave/aave-logo-full-dark.clean.svg", h: 11, aspect: 833 / 139, alt: "Aave" }, { logo: "/sponsors/avalanche/Avalanche_Logomark_Red.clean.svg", h: 13, aspect: 639 / 564, alt: "Avalanche" }] },
  { id: "talk", parts: [{ icon: "mic" }, "Talk To Open Position"] },
  { id: "sltp", parts: [{ icon: "shield" }, "Auto SL/TP"] },
]);

/** The prompt bar types these in turn. */
export const WELCOME_ASKS = Object.freeze(["Long BTC 5x, stop loss 2%", "What unlocks this week?", "Close half my ETH", "Is my SOL position safe?"]);
export const WELCOME_FLIP_MS = 2000;

/** "/trade/:coin" → the coin, else null. */
export function coinOfPath(path) {
  const m = typeof path === "string" ? /^\/trade\/([^/?#]+)/.exec(path) : null;
  if (!m) return null;
  try { return decodeURIComponent(m[1]) || null; } catch { return null; }
}

/**
 * Should the welcome open now? Every condition must hold:
 *   desktop · a coin page · Privy configured · signed out and not on the way in (no pending, no restore at load: a
 *   session hint or a Google return) · not seen this visit · no sheet open (it waits for the sheet to close).
 * A mock build opens it only through the DEV preview (sibling sessions screenshot the mock server).
 */
export function shouldShowWelcome(s) {
  if (!s || !s.desktop) return false;
  if (!coinOfPath(s.path)) return false;
  if (s.forced) return true;
  if (s.mock) return false;
  if (!s.configured) return false;
  if (s.signedIn || s.pending || s.restoring) return false;
  if (s.seen) return false;
  if (s.sheetOpen) return false;
  return true;
}

const get = (st, k) => { try { return st ? st.getItem(k) : null; } catch { return null; } };
const set = (st, k, v) => { try { if (st) st.setItem(k, v); } catch { /* storage refused */ } };
const del = (st, k) => { try { if (st) st.removeItem(k); } catch { /* storage refused */ } };

export const welcomeSeen = (st) => get(st, WELCOME_SEEN_KEY) === "1";
export const markWelcomeSeen = (st) => set(st, WELCOME_SEEN_KEY, "1");

/** A sign-in starts in the modal: remember where it began (a Google sign-in leaves the page and comes back). */
export function beginHandoff(st, coin, now = Date.now()) {
  if (!coin) return;
  set(st, WELCOME_HANDOFF_KEY, JSON.stringify({ coin: String(coin), at: now }));
}

/** The pending hand-off's coin, or null (missing, unreadable or stale ones are cleared). */
export function pendingHandoff(st, now = Date.now()) {
  const raw = get(st, WELCOME_HANDOFF_KEY);
  if (!raw) return null;
  let v = null;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || typeof v.coin !== "string" || !Number.isFinite(v.at) || now - v.at > WELCOME_HANDOFF_TTL_MS || v.at > now + 60_000) {
    del(st, WELCOME_HANDOFF_KEY);
    return null;
  }
  return v.coin;
}

/**
 * After a sign-in: { tab: "chat" } once, when the sign-in began in the modal, the visitor is now signed in (address
 * there, nothing pending) on a desktop coin page. The flag is cleared either way once signed in, so it never fires
 * twice. The coin need not match: the page they are on is the one to talk about.
 */
export function takeHandoff(st, { desktop, signedIn, pending, path }, now = Date.now()) {
  const coin = pendingHandoff(st, now);
  if (!coin || !signedIn || pending) return null;
  del(st, WELCOME_HANDOFF_KEY);
  if (!desktop || !coinOfPath(path)) return null;
  return { tab: "chat" };
}

/** DEV previews (like ?ffveil=): ?ffwelcome=1 opens the modal, ?ffwelcome=done runs the hand-off. */
export function devWelcome(search, dev) {
  if (!dev || typeof search !== "string") return null;
  let v = null;
  try { v = new URLSearchParams(search).get("ffwelcome"); } catch { v = null; }
  return v === "1" ? "open" : v === "done" ? "done" : null;
}

/**
 * Random spots for the chips that never touch each other or the prompt bar (best candidate: of many random free
 * spots, the one farthest from what is placed, so they spread out). `sizes` [{ w, h }], `box` { w, h }, `avoid`
 * { x, y, w, h } (the prompt bar), `rand` () => [0, 1). Returns [{ x, y } | null] (null: no room, the chip is left out).
 */
export function placeChips(sizes, box, avoid, rand = Math.random, { gap = 12, pad = 4, tries = 600 } = {}) {
  const taken = avoid ? [{ x: avoid.x - gap, y: avoid.y - gap, w: avoid.w + gap * 2, h: avoid.h + gap * 2 }] : [];
  const hit = (r) => taken.some((t) => r.x < t.x + t.w && r.x + r.w > t.x && r.y < t.y + t.h && r.y + r.h > t.y);
  return sizes.map(({ w, h }) => {
    let best = null;
    let bestD = -1;
    for (let k = 0; k < tries; k++) {
      const c = { x: pad + rand() * Math.max(0, box.w - w - pad * 2), y: pad + rand() * Math.max(0, box.h - h - pad * 2), w: w + gap, h: h + gap };
      if (c.x + w > box.w - pad + 0.001 || c.y + h > box.h - pad + 0.001 || hit(c)) continue;
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      const d = taken.length ? Math.min(...taken.map((t) => Math.hypot(cx - (t.x + t.w / 2), (cy - (t.y + t.h / 2)) * 1.6))) : rand();
      if (d > bestD) { bestD = d; best = c; }
    }
    if (!best) return null;
    taken.push(best);
    return { x: Math.round(best.x), y: Math.round(best.y) };
  });
}
