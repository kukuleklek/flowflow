// The Hyperliquid TRADING layer: signing, the trading key, nonces, orders and
// the one facade the perp pages call (createHlTrader).
//
// Import it ONLY from the lazy perp surfaces (src/perp/, the perp page,
// the perp account and deposit code). The eager hyperliquid barrel
// (../index.js) never re-exports it, so a build with the Perp mode off ships
// none of this, and none of the signing SDK (scripts/test-hl-exchange-bundle.mjs).
//
// Importing this file does nothing by itself: no request, no timer, no storage
// read until a function is called.

export {
  createHlTrader, sharedTradingState, HL_RENEW_BEFORE_MS,
} from "./client.js";

export {
  HL_NETWORK, HL_TRADE_NETWORK, HL_EXCHANGE_URLS, HL_SIGNATURE_CHAIN_ID,
  hlNetworkProfile, signatureChainIdFor,
} from "./network.js";

export {
  HL_AGENT_NAME, HL_AGENT_TTL_MS, HL_AGENT_EXPIRY_MARGIN_MS,
  agentNameWithExpiry, createAgentStore, wipeAgentOnWalletChange,
} from "./agentStore.js";

export { HL_NONCE_WINDOW, createNonceAllocator, isNonceInWindow } from "./nonce.js";

export {
  HL_WITHDRAW_FEE_USDC, HL_WITHDRAW_CHAIN, HL_WITHDRAW_ETA_MINUTES, HL_USDC_DECIMALS,
  masterSupport, formatUsdcAmount, withdrawQuote,
} from "./master.js";

export {
  HL_COLLATERAL_DECIMALS, HL_SPOT_DEX, HL_USDC_TOKEN_INDEX, VENUE_COLLATERAL_MESSAGE,
  buildAgentSendAssetAction, ceilCollateralAmount, floorCollateralAmount,
  planVenueSweep, planVenueTopUp, venueCollateralToken, venueOfCoin, venueOrderCollateral,
} from "./venueCollateral.js";

export {
  HL_MIN_ORDER_USDC, HL_DEFAULT_SLIPPAGE, HL_MIN_SLIPPAGE, HL_MAX_SLIPPAGE, HL_BUILDER_MAX_TENTHS_BP,
  roundHlOrderPx, roundHlSize, hlSlippagePx, checkOpenMinimum, builderMaxFeeRate, resolveBuilder,
  validateTpSl, classifyTpSlOrders, mapHlError,
  planOpenMarket, planAddMarket, planCloseFraction, planPositionTpsl, planTpSlMove,
} from "./orders.js";
