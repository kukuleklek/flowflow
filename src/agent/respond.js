// What the Agent says back when it does not need the LLM (and the fallback when the LLM is unreachable).
// Reads only live data already on the page; never signs, never sends. Trades always become cards.
import { formatHlPrice, formatHlPct, peekHlCandles } from "../lib/hyperliquid/index.js";
import { balanceView, positionView, perpCoinLabel, perpMarketFeeRate } from "../perp/live/perpLiveView.js";
import { topMovers, marketLabel, mainMarkets } from "../trade/marketLists.js";
import { parseShortcut } from "./shortcuts.js";
import { marginShortfall, shortfallText } from "./funds.js";
import { SETUP_INTERVAL, SETUP_BARS, withRecommendedTpSl } from "./setups.js";
import { assetState, suggestAssets, assetsCard } from "./suggest.js";
import { MAX_MARGIN_USDC, AGENT_MAX_LEVERAGE } from "../perp/guardrails.js";
import { peekEarnApy, EARN_ENABLED } from "./earn.js";
import { TOKENOMIST_ON } from "../lib/tokenomist/client.js";
import { ASK_CLOSE } from "./closeAll.js";
import { coinLabel } from "./cards/viewWords.js";
import { addCapCheck } from "./caps.js";

const fin = (v) => typeof v === "number" && Number.isFinite(v);

export const HELP = "Try “long ETH 10 3x”, “any setups?”, “stake 20 USDC” or “analyze HYPE”.";

/* The 1h candles the setups read, if this tab already has them (the trade card's mini chart fetches the same ones):
   a shortcut answers at once, so it never waits on the network for its recommended TP / SL. */
const peekCandles = (coin) => {
  try { return peekHlCandles(coin, SETUP_INTERVAL, { bars: SETUP_BARS }); } catch { return null; }
};

/**
 * @returns {{ handled: boolean, messages: object[] }} messages to append (assistant text, status lines, cards)
 */
export function respondLocally(text, {
  markets, byCoin, backend, coin = null, candlesOf = peekCandles, apyPct = peekEarnApy(), tokenomist = TOKENOMIST_ON, earnEnabled = EARN_ENABLED,
  stockCoin = null, now = Date.now(), stockOnly = false,
}) {
  const coins = mainMarkets(markets).map((m) => m.coin);
  const th = /[฀-๿]/.test(String(text || ""));
  const heldOf = (c) => {
    const p = backend && backend.account && backend.account.positions && backend.account.positions.byCoin ? backend.account.positions.byCoin[c] : null;
    return p && fin(p.szi) && p.szi !== 0 ? p : null;
  };
  /* A bare TP / SL number is read against the live price (shortcuts.js parseTpSl), with the held position's side when
     the sentence names none ("sl 85 HYPE"). */
  const intent = parseShortcut(text, coins, {
    refPxOf: (c) => (byCoin && byCoin[c] && fin(byCoin[c].px) && byCoin[c].px > 0 ? byCoin[c].px : null),
    sideOf: (c) => { const p = heldOf(c); return p ? (p.side === "short" || p.szi < 0 ? "sell" : "buy") : null; },
  });
  if (!intent) return { handled: false, messages: [] };
  /* The sentence names a stock (agent.js resolved it): a crypto the parser found is only a piece of its name ("S" in
     "S&P 500"), never the market. */
  if (stockOnly) {
    if (intent.kind === "open") return { handled: false, messages: [] };
    if (intent.kind === "close" || intent.kind === "tpsl") intent.coin = null;
  }
  /* "close TSLA": the sentence's stock (agent.js resolved it) for a close or a TP / SL that named no crypto. */
  if ((intent.kind === "close" || intent.kind === "tpsl") && !intent.coin && stockCoin) intent.coin = stockCoin;
  const boxes = (surface) => {
    try {
      const items = suggestAssets(assetState({ backend, snapshot: { markets, byCoin }, apyPct, earnEnabled, tokenomist }), { surface });
      return items.length ? [{ role: "card", card: assetsCard(items) }] : [];
    } catch {
      return [];
    }
  };

  if (intent.kind === "movers") {
    const list = topMovers(markets, 5);
    if (!list.length) return { handled: true, messages: [{ role: "assistant", text: "Markets are still loading. Ask again in a second." }] };
    const parts = list.map((m) => `${marketLabel(m)} ${formatHlPct(m.change24hPct)}`);
    return {
      handled: true,
      messages: [
        { role: "status", text: "Read markets" },
        { role: "assistant", text: `Biggest 24h moves: ${parts.join(", ")}.` },
        ...boxes("movers"),
      ],
    };
  }

  if (intent.kind === "account") {
    if (!backend.connected) return { handled: true, messages: [{ role: "assistant", text: "Sign in and I can read your account." }] };
    const acc = backend.account || {};
    const bal = balanceView(acc.perpBalanceUsdc);
    const list = acc.positions && acc.positions.answered ? (acc.positions.list || []).filter((p) => fin(p.szi) && p.szi !== 0) : null;
    if (list == null) return { handled: true, messages: [{ role: "assistant", text: "Your account is still loading." }] };
    const pos = list.map((p) => {
      const v = positionView(p, { szDecimals: byCoin[p.coin] ? byCoin[p.coin].szDecimals : null });
      return `${coinLabel(p.coin, byCoin[p.coin]) || perpCoinLabel(p.coin, byCoin[p.coin])} ${v.pill} ${v.pnlText} (${v.roeText})`;
    });
    return {
      handled: true,
      messages: [
        { role: "status", text: "Checked account" },
        { role: "assistant", text: `Main Account ${bal.known ? `$${bal.text}` : "—"}. ${pos.length ? `Open: ${pos.join("; ")}.` : "No open positions."}` },
        ...boxes("account"),
      ],
    };
  }

  if (intent.kind === "close") {
    /* No market named: the one open position when there is only one; else ask, and "all" / "เอาหมดเลย" answers it
       with the close-all card (closeAll.js reads the `ask` mark). */
    const ps = backend && backend.account && backend.account.positions ? backend.account.positions : null;
    const open = ps && ps.answered ? (ps.list || []).filter((p) => p && fin(p.szi) && p.szi !== 0) : [];
    /* 🔴 "The one open position" only from the WHOLE list: stock positions join it after the crypto ones (account
       store: positions.complete), so "close" with BTC loaded and TSLA still loading must ask, not close BTC. */
    const whole = !!(ps && ps.complete === true);
    const target = intent.coin || coin || (whole && open.length === 1 ? open[0].coin : null);
    if (!target) {
      return {
        handled: true,
        messages: [{
          role: "assistant", ask: ASK_CLOSE,
          text: /[฀-๿]/.test(text) ? "ปิดตัวไหน? พิมพ์ “ปิดครึ่ง ETH” หรือ “ปิดทุก position”" : "Which market should I close? Say “close half ETH”, or “close all”.",
        }],
      };
    }
    return {
      handled: true,
      messages: [
        { role: "status", text: "Checked account" },
        { role: "card", card: { kind: "close", coin: target, fraction: intent.fraction, status: "review" } },
      ],
    };
  }

  if (intent.kind === "tpsl") {
    /* A price the user typed rides as the price ("ตั้ง SL ETH 2300" is a stop AT 2300): the card turns it into the
       editor's own words exactly on that tick (TradeCard TpSlCard). A bare number read as a price is said, never
       silent. */
    const legPx = { ...(fin(intent.tpPx) ? { tpPx: intent.tpPx } : {}), ...(fin(intent.slPx) ? { slPx: intent.slPx } : {}) };
    const readLine = intent.pxRead ? readAsPriceLine(intent, th) : null;
    return {
      handled: true,
      messages: [
        { role: "status", text: "Checked account" },
        ...(readLine ? [{ role: "assistant", text: readLine }] : []),
        { role: "card", card: { kind: "tpsl", coin: intent.coin, tpPct: intent.tpPct, slPct: intent.slPct, ...legPx, status: "review" } },
      ],
    };
  }

  /* open */
  const m0 = byCoin[intent.coin];
  const px0 = m0 && fin(m0.px) && m0.px > 0 ? m0.px : null;
  const said = [];
  /* "long 0.5 ETH 5x": a size in the coin, priced at the live mark into the margin it needs at that leverage (said in
     one line, and capped like any margin below). No price or no leverage: ask instead of guessing. */
  if (fin(intent.sizeCoin) && intent.sizeCoin > 0 && !fin(intent.marginUsdc)) {
    if (px0 != null && fin(intent.leverage) && intent.leverage >= 1) {
      const need = Math.ceil(((intent.sizeCoin * px0) / intent.leverage) * 100) / 100;
      intent.marginUsdc = need;
      said.push(`${intent.sizeCoin} ${intent.coin} is about $${Math.round(intent.sizeCoin * px0).toLocaleString("en-US")}: ${need} USDC of margin at ${intent.leverage}x.`);
    } else {
      return { handled: true, messages: [{ role: "assistant", text: `What leverage for ${intent.sizeCoin} ${intent.coin}? Say it like “long ${intent.sizeCoin} ${intent.coin} 5x”, or give the margin in USDC.` }] };
    }
  }
  if (fin(intent.notionalUsd) && !fin(intent.marginUsdc)) {
    return { handled: true, messages: [{ role: "assistant", text: `What leverage for a $${intent.notionalUsd} position on ${intent.coin}? The margin is the position ÷ the leverage.` }] };
  }
  if (fin(intent.notionalUsd) && fin(intent.marginUsdc)) said.push(`A $${intent.notionalUsd} position at ${intent.leverage}x is ${intent.marginUsdc} USDC of margin.`);
  /* "Long HYPE for me": a side and a market, no amount at all. Not a card with a guessed margin: the setups answer it
     (intents.js), with that side. */
  if (!fin(intent.marginUsdc) && !fin(intent.leverage) && !fin(intent.sizeCoin) && !fin(intent.notionalUsd) && intent.tpPct == null && intent.slPct == null) {
    return { handled: false, messages: [] };
  }
  if (!fin(intent.marginUsdc)) {
    return { handled: true, messages: [{ role: "assistant", text: `How much margin for the ${intent.side === "buy" ? "long" : "short"} on ${intent.coin}? Say it in USDC, like “${intent.side === "buy" ? "long" : "short"} ${intent.coin} 20 5x”.` }] };
  }
  const m = byCoin[intent.coin];
  const heldAny = heldOf(intent.coin);
  /* Held on the OTHER side is not an add: the card says "close it first" (one position per market). */
  const held = heldAny && (heldAny.side === "short" || heldAny.szi < 0 ? "sell" : "buy") === intent.side ? heldAny : null;
  /* 🔴 AN ADD IS AN AGENT ORDER UNDER THE SAME CAPS (caps.js): it goes out at the position's own leverage, so a
     position held above what FlowFlow would open now gets no add card, whatever leverage the sentence named. */
  if (held) {
    const add = addCapCheck({ coin: intent.coin, position: held, market: m, now, lang: th ? "th" : "en" });
    if (!add.ok) return { handled: true, messages: [{ role: "assistant", text: add.text }] };
  }
  /* 🔴 No leverage named (and nothing held to add to): ask, never a card that falls back to a default leverage the
     user never said ("ชอร์ต BTC 15 ดอล 3 เท่า" used to go out at 5x when "เท่า" was not read). */
  if (!heldAny && !fin(intent.leverage)) {
    const capNow = Math.max(1, Math.floor(Math.min(AGENT_MAX_LEVERAGE, m && fin(m.maxLeverage) && m.maxLeverage >= 1 ? m.maxLeverage : AGENT_MAX_LEVERAGE)));
    const sideWord = intent.side === "buy" ? "long" : "short";
    return {
      handled: true,
      messages: [{
        role: "assistant",
        text: th
          ? `leverage เท่าไหร่สำหรับ ${sideWord} ${intent.coin}? (สูงสุด ${capNow}x) เช่น “${sideWord} ${intent.coin} ${Math.min(intent.marginUsdc, MAX_MARGIN_USDC)} 3x”`
          : `What leverage for the ${sideWord} on ${intent.coin}? (max ${capNow}x) Say it like “${sideWord} ${intent.coin} ${Math.min(intent.marginUsdc, MAX_MARGIN_USDC)} 3x”.`,
      }],
    };
  }
  /* FlowFlow's caps, on the card itself (the model's path, runTool.js proposeAction, does the same): the card then
     shows, quotes and recommends its TP / SL at what it will actually trade. "long BTC 10 40x" is a 10x card, and the
     model's history is told 10x. */
  const capped = [];
  let margin = intent.marginUsdc;
  if (margin > MAX_MARGIN_USDC) { margin = MAX_MARGIN_USDC; capped.push(`margin to ${MAX_MARGIN_USDC} USDC`); }
  const maxLev = Math.max(1, Math.floor(Math.min(AGENT_MAX_LEVERAGE, m && fin(m.maxLeverage) && m.maxLeverage >= 1 ? m.maxLeverage : AGENT_MAX_LEVERAGE)));
  let leverage = fin(intent.leverage) ? intent.leverage : null;
  if (leverage != null && leverage > maxLev) { leverage = maxLev; capped.push(`leverage to ${maxLev}x`); }
  if (leverage != null && leverage < 1) leverage = 1;
  /* A margin over what the Main Account can use (the FREE amount less the fee, the card's own test; money backing
     open positions is in the balance but not free): the card cannot be confirmed, and the reader is told why and
     where to look, instead of being left with "More than you can use right now" (owner, 2026-10-15). The figures are
     the account layer's; an unread balance says nothing here. Where the rest of the money is needs a read (get_funds). */
  const lev = held && held.leverage && fin(held.leverage.value) ? held.leverage.value : leverage;
  const gap = backend && backend.connected
    ? marginShortfall(backend, { marginUsdc: margin, leverage: lev, feeRate: perpMarketFeeRate(m, backend.feeRate), coin: intent.coin })
    : null;
  const short = !!gap;
  /* No TP / SL typed: the recommended one from the 1h chart, when this tab has it (the user's own always wins, and
     "no tp sl" means none). */
  /* The line above the card says what it is, never what to do with it or what state it is in: it stays on screen after
     the card fills or is cancelled (item 8). */
  /* "tp 90000 sl 80000", "sl $2300", "sl 85" on HYPE: PRICES. The card carries the price itself (tpPx / slPx) and
     prices the leg on exactly that tick from its own quote (TradeCard OpenCard); the ROE % here is only what the
     model's history is told. A level on the wrong side of the price is left off and said. */
  let tpPct = intent.tpPct;
  let slPct = intent.slPct;
  let tpPx = null;
  let slPx = null;
  if ((fin(intent.tpPx) || fin(intent.slPx)) && px0 != null && fin(lev)) {
    const buy = intent.side === "buy";
    const roe = (p) => Math.round((Math.abs(p - px0) / px0) * lev * 1000) / 10;
    if (fin(intent.tpPx)) { if (buy ? intent.tpPx > px0 : intent.tpPx < px0) { tpPct = roe(intent.tpPx); tpPx = intent.tpPx; } else said.push(th ? `TP ${intent.tpPx.toLocaleString("en-US")} อยู่ผิดฝั่งของราคา จึงไม่ใส่` : `TP ${intent.tpPx.toLocaleString("en-US")} is on the wrong side of the price, so it is left off.`); }
    if (fin(intent.slPx)) { if (buy ? intent.slPx < px0 : intent.slPx > px0) { slPct = roe(intent.slPx); slPx = intent.slPx; } else said.push(th ? `SL ${intent.slPx.toLocaleString("en-US")} อยู่ผิดฝั่งของราคา จึงไม่ใส่` : `SL ${intent.slPx.toLocaleString("en-US")} is on the wrong side of the price, so it is left off.`); }
    if (intent.pxRead && (tpPx != null || slPx != null)) said.push(readAsPriceLine({ tpPx, slPx }, th));
  }
  const typedLegs = fin(tpPct) || fin(slPct) || fin(intent.tpPx) || fin(intent.slPx);
  let openCard = {
    kind: "open", coin: intent.coin, side: intent.side, marginUsdc: margin, leverage, tpPct: fin(tpPct) ? tpPct : null, slPct: fin(slPct) ? slPct : null,
    ...(tpPx != null ? { tpPx } : {}), ...(slPx != null ? { slPx } : {}), status: "review",
  };
  if (m && !held && !intent.noTpSl && !typedLegs && Number.isFinite(leverage)) {
    let candles = null;
    try { candles = candlesOf(intent.coin); } catch { candles = null; }
    if (candles) openCard = withRecommendedTpSl(openCard, { market: m, candles });
  }
  return {
    handled: true,
    messages: [
      { role: "status", text: "Checked account · Quoted trade" },
      {
        role: "assistant",
        text: `${said.length ? `${said.join(" ")} ` : ""}${intent.side === "buy" ? "Long" : "Short"} ${intent.coin}${m ? ` at about ${formatHlPrice(m.px, m.szDecimals)}` : ""}.${capped.length ? ` Capped the ${capped.join(" and the ")} (FlowFlow's limit).` : ""}${held ? ` Adds to your ${intent.coin} position at its ${lev}x.` : ""}`,
      },
      { role: "card", card: openCard },
      ...(short ? [{
        role: "assistant",
        text: `${shortfallText(gap, margin)}, so the card can't be confirmed yet. Ask “where is my money?” and I'll check your Main Account and any deposit on its way.`,
      }] : []),
    ],
  };
}

/** "Read 85 as a price ($85)": a bare TP / SL number read as a price is said, never silent (shortcuts.js parseTpSl). */
export function readAsPriceLine({ tpPx = null, slPx = null } = {}, th = false) {
  const p = (v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
  const parts = [fin(tpPx) ? `TP ${p(tpPx)}` : null, fin(slPx) ? `SL ${p(slPx)}` : null].filter(Boolean);
  if (!parts.length) return "";
  return th ? `อ่านเป็นราคา: ${parts.join(" · ")}` : `Read as prices: ${parts.join(" · ")}.`;
}
