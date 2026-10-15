// HIP-3 stock perps — the READ-ONLY layer the Stocks plan builds on (docs/PLAN-HIP3-STOCKS.md).
// No signing, no orders, no transfers live here. Importing this file does nothing by itself.

export { parseDexes, dexCollateral, oiCapUse, USDC_TOKEN_INDEX } from "./dexes.js";
export { hlAssetId, decodeHlAssetId, stockAssetId, roundTrip } from "./assetId.js";
export { parseStockRows, parseDexMids, withMid, parseAtCap, marginKind, hip3TakerFeeMultiplier, GROWTH_MODE_FEE_SCALE } from "./stocks.js";
export { STOCK_DEX, STOCK_WHITELIST, STOCK_GATES, gateReasons, screenStocks, isWhitelistedStock } from "./whitelist.js";
export {
  NY_TZ, NYSE_HOLIDAYS, NYSE_EARLY_CLOSES, CALENDAR_YEARS,
  nyParts, usEquitySession, xyzPriceSource, nextRegularOpen, coreSessionCandles,
} from "./hours.js";
export { parseDexUserState, hip3Equity, idleDexUsdc, potSourceFor } from "./pots.js";
export { checkStockOrder, STOCK_GUARD_TEXT, CLOSED_AGENT_MAX_LEVERAGE, ORACLE_GAP_WARN_BPS } from "./guard.js";
export { createHip3Reader } from "./reads.js";
export { STOCK_ALIASES, resolveStock, findStockInText } from "./names.js";
export { HIP3_LOGO_DIR, HIP3_LOGO_FILES, HIP3_LOGO_MISSING, hasStockLogo, stockLogoUrl } from "./logos.js";
