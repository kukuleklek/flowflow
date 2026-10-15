// The perp mock's ONE read of the build environment.
//
// VITE_PERP_BUILDER_FEE is the builder fee in tenths of a basis point (the
// Hyperliquid "f" unit: 10 = 1 bp = 0.01%; FOMO charges 50). Empty or absent =
// 0, because the owner may not have set it yet. See fees.js for the rules.
//
// Every other perp-mock file takes the rate as an argument or imports it from
// here, so the fee on the ticket, on a fill and in the history cannot come from
// two different readings of the env.

import { parseBuilderFeeTenthsBp, perpTakerFeeRate } from "./fees.js";

/** The configured builder fee in tenths of a basis point, or null when the setting is unreadable. */
export const PERP_BUILDER_FEE_TENTHS_BP = parseBuilderFeeTenthsBp(import.meta.env.VITE_PERP_BUILDER_FEE);

/** HL taker 0.045% + the builder fee, as a fraction of notional; null when the builder fee is unknown. */
export const PERP_MOCK_FEE_RATE = perpTakerFeeRate(PERP_BUILDER_FEE_TENTHS_BP);
