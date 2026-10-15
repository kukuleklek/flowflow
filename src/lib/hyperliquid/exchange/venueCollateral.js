// ─────────────────────────────────────────────────────────────────────────────
// VENUE COLLATERAL: moving the customer's own USDC to the market it is trading.
// ─────────────────────────────────────────────────────────────────────────────
//
// THE PROBLEM, MEASURED 2026-09-23 (POST https://api.hyperliquid.xyz/info,
// read-only, three real addresses):
//
//   clearinghouseState{user, dex:"xyz"} is a SEPARATE POT from
//   clearinghouseState{user, dex:""}. A standard-mode account (userAbstraction
//   "disabled" or "default" — every FlowFlow customer, see the FRESH fixture)
//   starts a venue market with none of its money there:
//
//     0x09bc1cf4…  mode "default"   main accountValue 5,224,203.98
//                  xyz accountValue 0.0, xyz withdrawable 0.0
//                  activeAssetData{coin:"xyz:TSLA"}
//                    availableToTrade ["0.0","0.0"], maxTradeSzs ["0.0","0.0"]
//
//   Hyperliquid says: you may trade NOTHING here. The ticket read that figure
//   and printed "Available 0.00" to a customer holding five million dollars.
//
// THE ANSWER is agentSendAsset: the same move, signed as an L1 action by the
// TRADING KEY instead of EIP-712 by the customer's wallet — so it needs no
// prompt and the customer never learns that their money lives in pots. Docs
// (exchange-endpoint, Agent Send Asset, read 2026-09-23) and the pinned SDK
// (node_modules/@nktkas/hyperliquid 0.33.3, api/exchange/_methods/agentSendAsset.js):
//
//   fields, IN THIS ORDER   type, destination, sourceDex, destinationDex,
//                           token, amount, fromSubAccount, nonce
//   signing                 L1 Action
//   nonce                   "Equal to the envelope nonce"
//   destination             "must match the source address"
//   token                   "Only the collateral token can be transferred to
//                           or from a perp DEX"
//
// KEY ORDER IS PART OF THE SIGNED HASH (msgpack, as orders.js already states),
// so the action is built key by key here and nowhere else.
//
// UNVERIFIED AGAINST THE LIVE EXCHANGE, and said out loud rather than assumed:
// the field list, the signing scheme and the restrictions above are the docs' and
// the pinned SDK's, read 2026-09-23 — but /exchange only answers a SIGNED action,
// and nothing in this project sends one to find out (no order, no transfer, no
// signature was sent while this was written). If Hyperliquid refuses an
// agentSendAsset from this build's trading key, the refusal is Hyperliquid's own
// text on the ticket and NOTHING has moved: the money is where it was, no order
// was placed, and perp/live/diag.js has the reply. That is the failure this is
// designed to have.
//
// THE COLLATERAL TOKEN IS NOT ALWAYS USDC, and that is not theoretical.
// Measured 2026-09-23, /info {type:"meta", dex}: collateralToken is 0 (USDC) for
// xyz and io, and 360 for flx, vntl and km — token 360 is USDH
// (/info {type:"spotMeta"}). A move built for USDC into a USDH venue is a
// refused action at best. So the token string is DERIVED at run time from the
// venue's own collateralToken plus spotMeta, exactly as venues.js derives an
// asset id from the live perpDexs answer, and a venue whose collateral is not
// USDC is REFUSED here rather than topped up with the wrong asset.
//
// THE FEE: NOTHING IS CLAIMED. The docs mention no fee for sendAsset or
// agentSendAsset, and trading/fees says nothing about moving collateral to or
// from a perp dex. MEASURED 2026-09-23, userNonFundingLedgerUpdates over two
// real addresses: 715 self transfers touching the xyz dex (365 in, 344 out, 5
// from spot, 1 to spot), every one of them "fee":"0.0",
// "nativeTokenFee":"0.0", "feeToken":"". That is a measurement, not a
// guarantee — so no screen says "free", "no fee" or anything else about it
// (MONEY_RULES section 0: if it is not documented and not measured it is not
// claimed; a measurement of the past is not a promise about the next one).
//
// PURE: nothing here fetches, signs, reads a clock or touches storage. client.js
// is the only caller, and scripts/test-perp-venue-collateral.mjs drives every
// branch offline.
//
// WHY THE COIN SPLIT AND THE MAIN-DEX NAME LIVE HERE TOO. venues.js owns both for
// the MARKETS layer, and this layer imports nothing from it: the exchange layer's
// whole import list is its own siblings plus three leaves (browser.js, info.js,
// config.js, format.js), which is what keeps the signing SDK out of a flag-off
// build (scripts/test-hl-exchange-bundle.mjs). client.js already carried its own
// one-line dexOf for exactly that reason; this file is now the single place the
// exchange layer splits a name, and test-perp-venue-collateral.mjs A5 pins the two
// definitions to each other so they cannot drift.

/** Hyperliquid's own name for the main perp dex in an action or an /info body. */
export const HL_MAIN_DEX = "";
/** Hyperliquid's own name for the spot balance in a sendAsset. */
export const HL_SPOT_DEX = "spot";
/** The spot token index of USDC (measured 2026-09-23, /info {type:"spotMeta"}). */
export const HL_USDC_TOKEN_INDEX = 0;
/** USDC on Hyperliquid carries 6 decimals; a finer amount is refused, never rounded. */
export const HL_COLLATERAL_DECIMALS = 6;

const POW = 10 ** HL_COLLATERAL_DECIMALS;
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a) => String(a).toLowerCase();
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/** What a customer is told when their Perp balance cannot cover an order. */
export const VENUE_COLLATERAL_MESSAGE = Object.freeze({
  short: "Your Perp balance doesn't cover this order. Use a smaller amount, or add USDC.",
  unreadable: "Couldn't read your Perp balance just now, so nothing was sent. Try again in a moment.",
  /* A venue whose collateral is another token. No dex, no venue, no token name:
     the customer asked to buy something and it cannot be bought here yet. */
  unsupported: "This market can't be traded from FlowFlow yet.",
  /* The money reached the account but Hyperliquid has not credited the market
     yet. It is the customer's money, it is in their Perp account, and no order
     was placed — which is the whole sentence. */
  timeout: "Your money is in your Perp account. The order wasn't placed — try again.",
  /* Moves are switched off (guardrails.js STOCK_AUTO_MOVE kill switch, or no policy at all). */
  closed: "Trading on this market is paused. Nothing was sent.",
});

/**
 * May this build move collateral into (and back out of) this dex at all? The
 * policy is the caller's (usePerpBackend reads guardrails.js); NO policy is the
 * safe answer: nothing moves. There is no amount cap (owner, 2026-10-15): a move
 * is exactly what the order needs, and the order's own margin cap bounds it.
 * @param {{ auto?: boolean, dexes?: string[] }|null} policy
 * @returns {{ ok: true }|{ ok: false, code: string, message: string }}
 */
export function venueMoveAllowed(policy, { dex } = {}) {
  const p = policy && typeof policy === "object" ? policy : null;
  if (!p || p.auto !== true) return fail("market_unsupported", VENUE_COLLATERAL_MESSAGE.closed);
  if (!Array.isArray(p.dexes) || !p.dexes.includes(dex)) return fail("market_unsupported", VENUE_COLLATERAL_MESSAGE.unsupported);
  return { ok: true };
}

/** A decimal string for Hyperliquid, cut DOWN to 6 decimals. Null when it is not a positive number. */
export function floorCollateralAmount(x) {
  if (!fin(x) || x <= 0) return null;
  const units = Math.floor(x * POW + 1e-6);
  return units > 0 ? trim(units) : null;
}

/** A decimal string for Hyperliquid, rounded UP to 6 decimals: a shortfall must be COVERED. */
export function ceilCollateralAmount(x) {
  if (!fin(x) || x <= 0) return null;
  const units = Math.ceil(x * POW - 1e-6);
  return units > 0 ? trim(units) : null;
}

function trim(units) {
  const int = Math.floor(units / POW);
  const frac = String(units % POW).padStart(HL_COLLATERAL_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : String(int);
}

/**
 * The venue name a qualified market name carries ("xyz:TSLA" -> "xyz"), or null
 * for a main-dex market ("BTC"). The ONE place this app splits a coin name for
 * the purpose of moving money.
 */
export function venueOfCoin(coin) {
  if (typeof coin !== "string" || !coin.includes(":")) return null;
  const dex = coin.slice(0, coin.indexOf(":"));
  return dex ? dex : null;
}

/**
 * The token string a sendAsset names the venue's collateral by ("USDC:0x…"),
 * derived from the venue's OWN collateralToken and the spot token list. Never
 * hardcoded: measured 2026-09-23, xyz answers collateralToken 0 (USDC,
 * tokenId 0x6d1e7cde53ba9467b783cb7c530ce054) while flx, vntl and km all answer
 * 360 (USDH).
 *
 * @param {{ collateralToken?: number|null, spotTokens?: Array<{index?: number, name?: string, tokenId?: string}> }} o
 *   collateralToken: /info {type:"meta", dex} collateralToken
 *   spotTokens: /info {type:"spotMeta"} tokens
 * @returns {{ ok: true, token: string, name: string, index: number }|{ ok: false, code: string, message: string }}
 */
export function venueCollateralToken({ collateralToken = null, spotTokens = null } = {}) {
  if (!Number.isSafeInteger(collateralToken) || collateralToken < 0) {
    return fail("collateral_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  }
  /* ONLY USDC. FlowFlow's whole Perp mode is a USDC account: the balance, the
     ticket, the deposit and the way out are all USDC, so a venue margined in
     another token is not something this build can fund — and funding it with
     USDC is not a thing Hyperliquid allows in any case. */
  if (collateralToken !== HL_USDC_TOKEN_INDEX) {
    return fail("collateral_unsupported", VENUE_COLLATERAL_MESSAGE.unsupported, { collateralToken });
  }
  const list = Array.isArray(spotTokens) ? spotTokens : null;
  if (!list) return fail("collateral_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  const row = list.find((t) => t && Number.isSafeInteger(t.index) && t.index === collateralToken) || null;
  const name = row && typeof row.name === "string" && row.name ? row.name : null;
  const tokenId = row && typeof row.tokenId === "string" && /^0x[0-9a-f]+$/i.test(row.tokenId) ? row.tokenId : null;
  if (!name || !tokenId) return fail("collateral_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  return { ok: true, token: `${name}:${tokenId}`, name, index: collateralToken };
}

/**
 * The agentSendAsset action, keys inserted in the documented order. The TRADING
 * KEY signs it (signL1), and its nonce must equal the envelope's — which is why
 * client.js allocates the nonce first and hands it to this builder
 * (sendL1With).
 *
 * @param {{ destination: string, sourceDex: string, destinationDex: string,
 *   token: string, amount: string, fromSubAccount?: string, nonce: number }} o
 *   destination MUST be the master's own address (the docs' own restriction);
 *   client.js passes nothing else, and a mismatch throws here as well.
 * @returns {object} the action, ready for signL1
 */
export function buildAgentSendAssetAction({ destination, sourceDex, destinationDex, token, amount, fromSubAccount = "", nonce } = {}) {
  /* THE WORDS OF THESE THROWS REACH A CUSTOMER. A builder that throws lands in
     client.js's sendL1With catch, which prints "Couldn't sign with the trading
     key: <this text>" on the trade ticket — so not one of them names a dex, a
     venue or an API action (rule 9). They are still developer errors: every
     caller passes checked values. */
  if (!isAddress(destination)) throw new Error("a collateral move needs a destination address");
  if (typeof sourceDex !== "string" || typeof destinationDex !== "string") throw new Error("a collateral move needs both account names");
  if (sourceDex === destinationDex) throw new Error("a collateral move would move money to where it already is");
  if (typeof token !== "string" || !token) throw new Error("a collateral move needs a token");
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) throw new Error("a collateral move amount is a positive decimal string");
  if (typeof fromSubAccount !== "string") throw new Error("a collateral move needs a sub-account (empty string when it is not one)");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("a collateral move needs a nonce");
  return {
    type: "agentSendAsset",
    destination: lower(destination),
    sourceDex,
    destinationDex,
    token,
    amount,
    fromSubAccount,
    nonce,
  };
}

/**
 * What an order on a venue market needs in that market's own collateral: the
 * margin, plus the taker fee the fill will cost when that fee is KNOWN.
 *
 * An unknown fee (a fee scale venues.js cannot read: it answers null and the
 * ticket shows its dash; growth mode is a number since patch P1) adds nothing here, which is exactly what the ticket's own Max does in
 * that case. The two figures agree by construction: overstating the need would
 * move money the order does not use, understating it lets Hyperliquid refuse
 * the order — and a refused order sweeps the money straight back.
 *
 * @param {{ marginUsdc: number, leverage: number, feeRate: number|null }} o
 * @returns {number|null} null when the margin or the leverage cannot be read
 */
export function venueOrderCollateral({ marginUsdc, leverage, feeRate = null } = {}) {
  if (!fin(marginUsdc) || marginUsdc <= 0) return null;
  if (!Number.isInteger(leverage) || leverage < 1) return null;
  if (!fin(feeRate) || feeRate <= 0) return marginUsdc;
  return marginUsdc * (1 + leverage * feeRate);
}

/**
 * The move that makes an order on a venue market possible, or the refusal that
 * keeps it from being sent.
 *
 * @param {{ needUsdc: number|null, venueAvailableUsdc: number|null, mainAvailableUsdc: number|null }} o
 *   needUsdc            venueOrderCollateral()
 *   venueAvailableUsdc  activeAssetData availableToTrade for THIS coin: what
 *                       Hyperliquid says a new order may use, its own figure
 *   mainAvailableUsdc   the main dex's withdrawable: what can actually leave it
 * @returns {{ ok: true, amount: string|null, shortfallUsdc: number }|{ ok: false, code: string, message: string }}
 *   amount null: nothing has to move, the money is already there
 */
export function planVenueTopUp({ needUsdc = null, venueAvailableUsdc = null, mainAvailableUsdc = null } = {}) {
  if (!fin(needUsdc) || needUsdc <= 0) return fail("state_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  if (!fin(venueAvailableUsdc) || venueAvailableUsdc < 0) return fail("state_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  const shortfall = needUsdc - venueAvailableUsdc;
  /* Already covered. A sub-cent shortfall is still a shortfall: it is moved,
     because Hyperliquid refuses the order for it. */
  if (shortfall <= 0) return { ok: true, amount: null, shortfallUsdc: 0 };
  if (!fin(mainAvailableUsdc) || mainAvailableUsdc < 0) return fail("state_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  const amount = ceilCollateralAmount(shortfall);
  if (amount == null) return fail("state_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  /* The main account has to hold what the move takes out of it. The comparison
     is against the ROUNDED-UP amount, because that is what would be sent. */
  if (Number(amount) > mainAvailableUsdc) return fail("insufficient_margin", VENUE_COLLATERAL_MESSAGE.short, { shortfallUsdc: shortfall });
  return { ok: true, amount, shortfallUsdc: shortfall };
}

/**
 * The move that brings a venue's idle collateral home after a sell: the last
 * position closed, or a partial close when every position left is isolated.
 *
 * THE FIGURE IS HYPERLIQUID'S OWN withdrawable, never a computed one (MONEY_RULES
 * section 1: one source per figure). A venue holding a CROSS position (or one
 * whose margin type cannot be read) is left alone — that money backs it.
 *
 * @param {{ venueWithdrawableUsdc: number|null, venuePositions: number|null, venueCrossPositions?: number|null }} o
 * @returns {{ ok: true, amount: string|null }|{ ok: false, code: string, message: string }}
 *   amount null: there is nothing idle to bring back
 */
export function planVenueSweep({ venueWithdrawableUsdc = null, venuePositions = null, venueCrossPositions = null } = {}) {
  if (!Number.isSafeInteger(venuePositions) || venuePositions < 0) return fail("state_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  /* AFTER A SELL, EVEN A PARTIAL ONE (owner, 2026-10-15: money comes out of the
     stock pot when the stock is sold, automatically). With positions still open
     the pot's withdrawable may still come home ONLY when every one of them is
     ISOLATED — an isolated position's margin is its own and is not in that figure,
     and FlowFlow opens nothing else. A cross position (opened elsewhere) leans on
     the pot's free money, so then nothing moves; an unknown count is treated as one. */
  if (venuePositions > 0 && venueCrossPositions !== 0) return { ok: true, amount: null };
  if (!fin(venueWithdrawableUsdc) || venueWithdrawableUsdc < 0) return fail("state_unknown", VENUE_COLLATERAL_MESSAGE.unreadable);
  return { ok: true, amount: floorCollateralAmount(venueWithdrawableUsdc) };
}
