// The Hyperliquid data layer for the Perp mode — READ-ONLY market data.
// No signing, no orders, no deposits, no agent keys live here.
//
// Importing this file does nothing by itself: no socket, no request, no timer.
// Everything starts when a hook mounts or a function is called.

export { HL_NETWORK, HL_ENDPOINTS, hlEndpoints } from "./config.js";
export { hlInfo, createHlInfo, HlInfoError, HL_INFO_TIMEOUT_MS } from "./info.js";
export { hlWs, hlSubscribe, createHlWs, hlSubKey } from "./ws.js";
export {
  usePerpMarkets, usePerpMarket, perpMarketsStore, createPerpMarketsStore,
  parsePerpMarkets, applyMids, applyAssetCtx, rankPerpMarkets, isPerpMarketStale,
  PERP_MARKETS_REFRESH_MS,
} from "./markets.js";
export {
  HL_INTERVALS, HL_INTERVAL_MS, FLOWFLOW_TF_TO_HL, hlInterval,
  parseHlCandle, parseHlCandles, mergeHlCandle,
  fetchHlCandles, peekHlCandles, subscribeHlCandles, HL_CANDLE_BARS, HL_CANDLE_TTL_MS,
} from "./candles.js";
export {
  HL_PRICE_SIG_FIGS, HL_PERP_MAX_DECIMALS,
  hlPriceDecimals, roundHlPrice, formatHlPrice, formatHlUsdCompact, formatHlPct,
  formatHlFunding, hlFundingAprPct, formatHlSize,
} from "./format.js";
export { hlLogoUrl, hlLogoUrls, hasLocalHlLogo, hlLogoName, HL_LOGO_DIR, HL_REMOTE_LOGO_BASE } from "./logos.js";
export { isHlCoinName, isHlMarketName, splitHlMarket, hlMarketBase, hlLogoFileName, hlRemoteLogoName } from "./coins.js";
export {
  HIP3_VENUES, HL_MAIN_DEX, HL_HIP3_ID_BASE, HL_HIP3_DEX_STRIDE, HL_SPOT_ID_BASE, HL_OUTCOME_ID_BASE,
  hlAssetId, isHlMainAssetId, isHlSpotAssetId, isHlHip3AssetId, isHlOutcomeAssetId,
  parsePerpDexs, resolveVenues, venueTakerFeeMultiplier, perpTakerFeeRate,
} from "./venues.js";
export {
  PERP_CATEGORIES, PERP_MEME_COINS, PERP_CATEGORY_OVERRIDES,
  perpCategoryOf, filterPerpMarkets, perpCategoryCounts,
} from "./perpCategories.js";
