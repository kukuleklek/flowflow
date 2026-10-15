// DEV ONLY. Loaded by ChatThread only when import.meta.env.DEV (never in a build) and the URL asks for it:
//   /agent?fixture=analysis&coin=ETH[&profile=Bolder]   the real analysis card for that market (live candles, the
//                                                       account's position if it holds one), as the pill would show it
// It reads exactly what the Analyze pill reads (runTool.js analysisFor) and pushes the user's words and the card, so
// a screenshot shows the real card without waiting on the model. Nothing here sends or signs.
import { perpMarketsStore } from "../../lib/hyperliquid/index.js";
import { chat } from "../store.js";
import { toolCtxFrom } from "../agent.js";
import { analysisFor } from "../runTool.js";

/* The markets list, once it has loaded (at most ~10 s). */
async function marketsReady() {
  for (let i = 0; i < 50; i++) {
    const s = perpMarketsStore().getSnapshot();
    if (s && s.ready && s.markets && s.markets.length) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/* The account as the page sees it now, once its positions have been read (at most ~6 s; signed out: at once). */
async function accountReady(getBackend) {
  for (let i = 0; i < 30; i++) {
    const b = getBackend();
    if (b && b.connected && b.account && b.account.positions && b.account.positions.answered) return b;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getBackend();
}

export async function runDevFixture(name, { getBackend = () => null, coin = null, profile = null } = {}) {
  if (name !== "analysis") return;
  const c = typeof coin === "string" && /^[A-Za-z0-9:]{1,24}$/.test(coin) ? coin : "ETH";
  const p = typeof profile === "string" && /^(safer|balanced|bolder)$/i.test(profile) ? profile : null;
  const words = `Analyze ${c.toUpperCase()}${p ? ` ${p} setup` : ""}`;
  /* A reload of the same URL (the screenshot tool seeds, then loads again) shows the card once. */
  if (chat.get().messages.some((m) => m.role === "user" && m.text === words)) return;
  await marketsReady();
  const backend = await accountReady(getBackend);
  chat.push({ role: "user", text: words });
  const r = await analysisFor(toolCtxFrom({ backend, readTimeoutMs: 10_000 }), c, { profile: p }).catch(() => null);
  if (r && r.card) chat.push({ role: "card", card: r.card });
  else chat.push({ role: "assistant", text: (r && r.result && r.result.error) || "Couldn't analyze that market (dev fixture).", tone: "error" });
}
