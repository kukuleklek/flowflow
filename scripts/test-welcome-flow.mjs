/**
 * test-welcome-flow — THE FIRST-VISIT WELCOME (no React, no network).
 * ════════════════════════════════════════════════════════════════════════════
 * Owner, 2026-10-15: "/" lands on /trade/BTC and the old home moves to /home; a signed-out desktop visitor sees a
 * Canva-style "Log in or sign up" modal (Sign in / Sign up left, the pitch and floating chips right, X to browse);
 * a sign-in that began there opens the terminal's Chat tab; phones never get the modal ("ส่วนมือถือ ไม่ต้องมี").
 *
 *   W1  routes: "/" → /trade/BTC (query kept, ?coin= honoured), /home is the markets list, /trade → /home
 *   W2  no link that means "the markets list" still points at bare /trade
 *   W3  shouldShowWelcome: desktop, coin page, configured, signed out, not restoring, not seen, no sheet; mock only DEV
 *   W4  seen once per visit; storage that throws never breaks the page
 *   W5  the hand-off: once, desktop, signed in with nothing pending, survives a reload, stale ones dropped
 *   W6  the words and the chips, exactly; the Avalanche wordmark + Mainnet; Powered by Privy under the buttons
 *   W7  one sign-in path: the modal draws ConnectCard (start "pair") and never imports Privy
 *   W8  phones: MarketPage mounts the welcome only on desktop
 *   W9  chips are placed without overlapping each other or the prompt bar, inside the panel
 *   W10 reduced motion and the DEV previews (?ffwelcome=1 | done) are DEV-only
 *   W11 every chip logo file exists
 *
 * Run: node --test scripts/test-welcome-flow.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WELCOME_CHIPS, WELCOME_COPY, WELCOME_DESKTOP_MIN, WELCOME_HANDOFF_KEY, WELCOME_HANDOFF_TTL_MS, WELCOME_SEEN_KEY,
  beginHandoff, coinOfPath, devWelcome, markWelcomeSeen, pendingHandoff, placeChips, shouldShowWelcome, takeHandoff, welcomeSeen,
} from "../src/auth/welcomeView.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (p) => readFileSync(join(ROOT, p), "utf8");

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };

const BASE = { desktop: true, path: "/trade/BTC", configured: true, signedIn: false, pending: null, restoring: false, seen: false, sheetOpen: false, mock: false, forced: false };

test("W1 routes: / lands on /trade/BTC (query kept, ?coin= honoured), /home is the markets list, /trade → /home", () => {
  const app = src("src/App.jsx");
  assert.match(app, /<Route index element={<Landing \/>} \/>/);
  assert.match(app, /pathname: `\/trade\/\$\{encodeURIComponent\(coin && coin\.length <= 32 \? coin : "BTC"\)\}`/);
  assert.match(app, /search: rest \? `\?\$\{rest\}` : ""/, "the rest of the query (a Google return's code) survives the redirect");
  assert.match(app, /if \(!coin && !isDesktop\(\)\) return <Navigate to=\{\{ pathname: "\/home"/, "phones open / on the markets list");
  assert.match(app, /min-width: \$\{WELCOME_DESKTOP_MIN\}px/);
  assert.match(app, /<Route path="\/home" element={<MarketsPage \/>} \/>/);
  assert.match(app, /<Route path="\/trade" element={<Navigate to="\/home" replace \/>} \/>/);
  assert.match(app, /<Route path="\/trade\/:coin" element={<MarketPage \/>} \/>/);
  assert.match(app, /<Route path="\*" element={<Navigate to="\/trade\/BTC" replace \/>} \/>/);
});

test("W2 no 'markets list' link still points at bare /trade; the Trade tab is lit on /home and every coin page", () => {
  for (const f of ["src/layout/AppShell.jsx", "src/trade/CoinBar.jsx", "src/trade/PositionsPanel.jsx", "src/trade/MarketPage.jsx"]) {
    assert.doesNotMatch(src(f), /to="\/trade"/, `${f} still links to /trade`);
  }
  const shell = src("src/layout/AppShell.jsx");
  assert.match(shell, /\{ to: "\/home", label: "Trade", icon: "trade", on: \(p\) => p === "\/home" \|\| p\.startsWith\("\/trade"\) \}/);
  assert.match(shell, /aria-current=\{on \? "page" : undefined\}/);
  assert.match(shell, /<NavLink to="\/home" aria-label="FlowFlow home"/);
  assert.match(src("src/perp/live/diag.js"), /pathname === "\/home"/, "the perp diagnostics still record on the markets list");
});

test("W3 shouldShowWelcome: every condition must hold", () => {
  assert.equal(shouldShowWelcome(BASE), true);
  assert.equal(shouldShowWelcome({ ...BASE, path: "/trade/ETH" }), true, "a deep link to another coin opens it too");
  assert.equal(shouldShowWelcome({ ...BASE, path: "/trade/xyz%3ANVDA" }), true);
  const off = {
    desktop: false, path: "/home", configured: false, signedIn: true, pending: "wallet", restoring: true, seen: true, sheetOpen: true, mock: true,
  };
  for (const [k, v] of Object.entries(off)) assert.equal(shouldShowWelcome({ ...BASE, [k]: v }), false, `${k}=${v} must keep it closed`);
  assert.equal(shouldShowWelcome({ ...BASE, path: "/agent" }), false);
  assert.equal(shouldShowWelcome({ ...BASE, path: "/wallet" }), false);
  assert.equal(shouldShowWelcome(null), false);
  // the DEV preview opens it anywhere on a desktop coin page (even mock / signed in), never on a phone
  assert.equal(shouldShowWelcome({ ...BASE, forced: true, mock: true, signedIn: true, seen: true }), true);
  assert.equal(shouldShowWelcome({ ...BASE, forced: true, desktop: false }), false);
  assert.equal(WELCOME_DESKTOP_MIN, 1024);
  assert.match(src("src/trade/MarketPage.jsx"), /const q = "\(min-width: 1024px\)";/, "the same breakpoint MarketPage uses");
});

test("W4 seen once per visit (sessionStorage), and a storage that throws never breaks the page", () => {
  const st = store();
  assert.equal(welcomeSeen(st), false);
  markWelcomeSeen(st);
  assert.equal(welcomeSeen(st), true);
  assert.equal(st._m.get(WELCOME_SEEN_KEY), "1");
  assert.equal(welcomeSeen(broken), false);
  assert.doesNotThrow(() => markWelcomeSeen(broken));
  assert.doesNotThrow(() => beginHandoff(broken, "BTC"));
  assert.equal(pendingHandoff(broken), null);
  const modal = src("src/auth/WelcomeModal.jsx");
  assert.match(modal, /window\.sessionStorage/, "per visit: sessionStorage, not localStorage");
  assert.doesNotMatch(modal, /localStorage/);
});

test("W5 the hand-off: once, desktop, signed in with nothing pending; survives Google's redirect; stale ones dropped", () => {
  const now = 1_000_000;
  const st = store();
  assert.equal(takeHandoff(st, { desktop: true, signedIn: true, pending: null, path: "/trade/BTC" }, now), null, "no sign-in began in the modal");
  beginHandoff(st, "BTC", now);
  assert.deepEqual(JSON.parse(st._m.get(WELCOME_HANDOFF_KEY)), { coin: "BTC", at: now });
  // still signing in: wait, keep the flag
  assert.equal(takeHandoff(st, { desktop: true, signedIn: false, pending: null, path: "/trade/BTC" }, now + 1), null);
  assert.equal(takeHandoff(st, { desktop: true, signedIn: true, pending: "wallet", path: "/trade/BTC" }, now + 1), null);
  assert.equal(pendingHandoff(st, now + 2), "BTC", "the flag outlives the reload a Google sign-in makes");
  assert.deepEqual(takeHandoff(st, { desktop: true, signedIn: true, pending: null, path: "/trade/BTC" }, now + 3), { tab: "chat" });
  assert.equal(takeHandoff(st, { desktop: true, signedIn: true, pending: null, path: "/trade/BTC" }, now + 4), null, "never twice");
  // a phone, or not on a coin page: cleared, nothing opens
  beginHandoff(st, "ETH", now);
  assert.equal(takeHandoff(st, { desktop: false, signedIn: true, pending: null, path: "/trade/ETH" }, now + 1), null);
  assert.equal(st._m.has(WELCOME_HANDOFF_KEY), false);
  // stale / broken / from the future: dropped
  beginHandoff(st, "BTC", now);
  assert.equal(pendingHandoff(st, now + WELCOME_HANDOFF_TTL_MS + 1), null);
  assert.equal(st._m.has(WELCOME_HANDOFF_KEY), false);
  st.setItem(WELCOME_HANDOFF_KEY, "{not json");
  assert.equal(pendingHandoff(st, now), null);
  st.setItem(WELCOME_HANDOFF_KEY, JSON.stringify({ coin: "BTC", at: now + 10 * 60_000 }));
  assert.equal(pendingHandoff(st, now), null);
  beginHandoff(st, "", now);
  assert.equal(st._m.has(WELCOME_HANDOFF_KEY), false, "no coin, no flag");
  // MarketPage turns it into the Chat tab
  assert.match(src("src/trade/MarketPage.jsx"), /<Welcome coin=\{coin\} onChat=\{\(\) => setTab\("chat"\)\} \/>/);
  assert.match(src("src/trade/TradePanel.jsx"), /\{ value: "chat", label: "Chat"/);
});

test("W6 the words and the chips, exactly as the owner wrote them", () => {
  assert.equal(WELCOME_COPY.heading, "Log in or sign up");
  assert.equal(WELCOME_COPY.titleLead, "FlowFlow: Privacy AI Perp DEX and DeFi Access on");
  assert.equal(WELCOME_COPY.network, "Mainnet");
  assert.equal(WELCOME_COPY.tagline, "Talk or Type To Trade");
  assert.equal(WELCOME_COPY.event, "U-Hackathon 2026", "one grey box under the title (owner, 2026-10-16)");
  assert.equal((src("src/auth/WelcomeModal.jsx").match(/\{WELCOME_COPY\.event\}/g) || []).length, 1);
  const text = (c) => c.parts.map((p) => (typeof p === "string" ? p : p.flip ? p.flip.join("/") : p.alt ? `[${p.alt}]` : p.logo ? "[logo]" : "")).filter(Boolean).join(" ");
  assert.deepEqual(WELCOME_CHIPS.map(text), [
    "Long [logo] HYPE with setup data from [logo] Tokenomist",
    "[u.bot] Advice on position",
    "Perp DEX on [Avalanche]",
    "Private Deposit/Withdraw with [logo] NEAR Intents",
    "Staking [logo] USDC on [Aave] [Avalanche]",
    "Talk To Open Position",
    "Auto SL/TP",
  ]);
  const modal = src("src/auth/WelcomeModal.jsx");
  assert.match(modal, /<SponsorLogo name="avalanche" variant="wordmark" size=\{21\} alt="Avalanche" \/>/, "the title's Avalanche is the logo");
  assert.match(modal, /\{WELCOME_COPY\.network\}/);
  assert.match(modal, /<SponsorLogo name="privy" variant="wordmark" size=\{15\} alt="Privy" \/>/);
  assert.equal(WELCOME_COPY.privyLead, "Powered by");
  assert.equal(WELCOME_COPY.privyTail, "a Stripe company");
  assert.doesNotMatch(modal, /PoweredBy\b/, "no Powered by row on the right (owner: too busy)");
});

test("W7 one sign-in path: the modal draws ConnectCard and never touches Privy itself", () => {
  const modal = src("src/auth/WelcomeModal.jsx");
  assert.match(modal, /<ConnectCard start="pair" bare onBegin=\{\(\) => beginHandoff\(session\(\), coin\)\} onDone=\{onClose\} \/>/);
  assert.doesNotMatch(modal, /@privy-io/);
  assert.doesNotMatch(modal, /loginWith|sendEmailCode|signupWithPasskey|requestPrivyMount/);
  const card = src("src/auth/ConnectCard.jsx");
  assert.match(card, /view === "pair"/);
  assert.match(card, /onClick=\{\(\) => pick\("login"\)\}>Sign in<\/Button>/);
  assert.match(card, /onClick=\{\(\) => pick\("signup"\)\}>Sign up<\/Button>/);
  assert.match(card, /try \{ onBegin\?\.\(kind\); \} catch/, "onBegin runs before the sign-in, and never blocks it");
  assert.match(card, /view === "list" \? \(start === "pair" \? "pair" : "choose"\)/, "Back from a list returns to the two buttons");
  assert.match(card, /const logIn = start === "pair" \? "Sign in" : "Log in";/, "the header keeps its words");
});

test("W8 phones never get the modal: MarketPage mounts it on desktop only", () => {
  const page = src("src/trade/MarketPage.jsx");
  assert.match(page, /\{desktop \? <Welcome coin=\{coin\} onChat=\{\(\) => setTab\("chat"\)\} \/> : null\}/);
  assert.equal((page.match(/<Welcome /g) || []).length, 1);
});

test("W9 chips never overlap each other or the prompt bar, and stay inside the panel", () => {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const sizes = [[330, 32], [180, 32], [170, 32], [300, 32], [290, 32], [170, 32], [120, 32]].map(([w, h]) => ({ w, h }));
  const box = { w: 560, h: 380 };
  const avoid = { x: 110, y: 162, w: 340, h: 56 };
  for (let run = 0; run < 40; run++) {
    const spots = placeChips(sizes, box, avoid, rand);
    const rects = spots.map((s, i) => (s ? { x: s.x, y: s.y, w: sizes[i].w, h: sizes[i].h } : null)).filter(Boolean);
    assert.ok(rects.length >= 6, `run ${run}: placed ${rects.length}`);
    const meet = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= box.w && r.y + r.h <= box.h, `run ${run}: outside the panel`);
      assert.equal(meet(r, avoid), false, `run ${run}: on the prompt bar`);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.equal(meet(rects[i], rects[j]), false, `run ${run}: chips ${i} and ${j} overlap`);
  }
  assert.deepEqual(placeChips([{ w: 900, h: 30 }], box, avoid, rand), [null], "no room: left out, never overlapping");
});

test("W10 reduced motion and the DEV previews", () => {
  const css = src("src/styles/app.css");
  const rm = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(rm, /\.ff-chip\.is-on \{ animation: none; opacity: 1; \}/);
  assert.match(rm, /\.ff-caret, \.ff-mic-ping::after \{ animation: none; \}/);
  assert.match(src("src/auth/WelcomeModal.jsx"), /useReducedMotion\(\)/);
  assert.equal(devWelcome("?ffwelcome=1", true), "open");
  assert.equal(devWelcome("?ffwelcome=done", true), "done");
  assert.equal(devWelcome("?ffwelcome=1", false), null, "DEV only");
  assert.equal(devWelcome("?ffwelcome=yes", true), null);
  assert.match(src("src/auth/WelcomeModal.jsx"), /devWelcome\(search, import\.meta\.env\.DEV\)/);
  assert.equal(coinOfPath("/trade/BTC"), "BTC");
  assert.equal(coinOfPath("/trade/xyz%3ANVDA"), "xyz:NVDA");
  assert.equal(coinOfPath("/home"), null);
});

test("W11 every chip logo is a file the app serves", () => {
  for (const c of WELCOME_CHIPS) for (const p of c.parts) {
    if (p && p.logo) assert.ok(existsSync(join(ROOT, "public", p.logo)), `missing public${p.logo}`);
  }
  const ubot = src("public/sponsors/ubot/ubot-logo.svg");
  assert.doesNotMatch(ubot, /<script|\son[a-z]+=|href=/i, "the u.bot file is a plain drawing");
});
