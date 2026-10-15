// The live perp screens' ONE read of the build environment.
//
//   VITE_PERP_BACKEND          "mock" selects the MOCK backend (dev verification,
//                              maybe a demo later). Anything else, unset
//                              included, is LIVE: real Hyperliquid orders.
//   VITE_PERP_BUILDER_ADDRESS  FlowFlow's builder address. It attaches (and asks
//                              the user to approve it) only together with the
//                              fee; a half-set config refuses opens, never closes.
//
// The builder FEE is read in exactly one other place, perp/mock/config.js, and
// imported from there, so the ticket's fee, the order's builder field and the
// mock's fills cannot come from two readings of the env.

import { PERP_BUILDER_FEE_TENTHS_BP } from "../mock/config.js";
import { perpBackendKind, resolvePerpBuilder } from "./perpBackend.js";
import { perpFeeRateFor } from "./perpLiveView.js";

/** "live" | "mock" for this build. */
export const PERP_BACKEND = perpBackendKind(import.meta.env.VITE_PERP_BACKEND);

/** What the trader is handed: { address, feeTenthsBp }. */
export const PERP_BUILDER = Object.freeze({
  address: String(import.meta.env.VITE_PERP_BUILDER_ADDRESS || "").trim(),
  feeTenthsBp: PERP_BUILDER_FEE_TENTHS_BP,
});

/** The builder config as the exchange layer resolves it (on / off / invalid). */
export const PERP_BUILDER_RESOLVED = Object.freeze(resolvePerpBuilder(PERP_BUILDER));

/** Hyperliquid taker + builder fee as a fraction of notional; null when the config is half set. */
export const PERP_FEE_RATE = perpFeeRateFor(PERP_BUILDER_RESOLVED);
