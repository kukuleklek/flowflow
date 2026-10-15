// ─────────────────────────────────────────────────────────────────────────────
// HIP-3 asset ids: build one from LIVE answers, and read one back.
// ─────────────────────────────────────────────────────────────────────────────
//
// venues.js owns the rule (docs, for-developers/api/asset-ids):
//   100000 + perpDexIndex * 10000 + the coin's index in THAT dex's universe
// and this file adds the two things a stock order needs on top of it:
//
//   1. stockAssetId(): the id for a NAME ("xyz:TSLA"), from the live perpDexs
//      order and the dex's own full universe (delisted rows included: the index
//      is the position in the FULL list). Measured 2026-10-15: xyz is index 1,
//      xyz:TSLA position 1, so 110001; mkts:US500 is 190000; io:OAI 200000.
//   2. decodeHlAssetId(): the id back into { kind, dexIndex, index }, so the
//      signer can check, right before signing, that the id it holds still
//      names the market the customer picked (roundTrip). A wrong id is someone
//      else's market with this customer's money.
//
// A delisted coin has an index but gets no id: nothing may be opened on it.

import {
  HL_HIP3_DEX_STRIDE, HL_HIP3_ID_BASE, HL_MAIN_ID_MAX, HL_OUTCOME_ID_BASE, HL_SPOT_ID_BASE, hlAssetId,
} from "../venues.js";
import { splitHlMarket } from "../coins.js";

export { hlAssetId };

/**
 * An asset id read back. kind: "main" | "spot" | "hip3" | "outcome" | null.
 * @returns {{ kind: string|null, dexIndex: number|null, index: number|null }}
 */
export function decodeHlAssetId(id) {
  if (!Number.isSafeInteger(id) || id < 0) return { kind: null, dexIndex: null, index: null };
  if (id < HL_MAIN_ID_MAX) return { kind: "main", dexIndex: 0, index: id };
  if (id < HL_HIP3_ID_BASE) return { kind: "spot", dexIndex: null, index: id - HL_SPOT_ID_BASE };
  if (id < HL_OUTCOME_ID_BASE) {
    const rest = id - HL_HIP3_ID_BASE;
    return { kind: "hip3", dexIndex: Math.floor(rest / HL_HIP3_DEX_STRIDE), index: rest % HL_HIP3_DEX_STRIDE };
  }
  return { kind: "outcome", dexIndex: null, index: null };
}

/**
 * The asset id of a qualified HIP-3 market, or a refusal that says why not.
 *
 * @param {string} coin "xyz:TSLA"
 * @param {{ dexes: { byName: Map<string, {index:number}> }, universe: Array<{name:string,isDelisted?:boolean}> }} o
 *   dexes     parseDexes(perpDexs) from THIS session's answer
 *   universe  that dex's meta.universe, in the order it was answered
 * @returns {{ ok: true, id: number, dexIndex: number, index: number }|{ ok: false, code: string }}
 */
export function stockAssetId(coin, { dexes, universe } = {}) {
  const { dex, base } = splitHlMarket(coin);
  if (!dex || !base) return { ok: false, code: "not_hip3" };
  const live = dexes && dexes.byName instanceof Map ? dexes.byName.get(dex) : null;
  if (!live || !Number.isSafeInteger(live.index) || live.index < 1) return { ok: false, code: "dex_unknown" };
  if (!Array.isArray(universe)) return { ok: false, code: "universe_unknown" };
  const index = universe.findIndex((u) => u && u.name === coin);
  if (index < 0) return { ok: false, code: "coin_unknown" };
  /* The same name twice in one universe is a mix-up, never a coin flip. */
  if (universe.findIndex((u, i) => i > index && u && u.name === coin) >= 0) return { ok: false, code: "coin_ambiguous" };
  if (universe[index].isDelisted === true) return { ok: false, code: "delisted" };
  const id = hlAssetId({ dexIndex: live.index, assetIndex: index });
  if (id == null) return { ok: false, code: "id_out_of_range" };
  return { ok: true, id, dexIndex: live.index, index };
}

/**
 * Does this id still name this coin, by today's answers? The signer's last check.
 * @returns {boolean}
 */
export function roundTrip(id, coin, { dexes, universe } = {}) {
  const d = decodeHlAssetId(id);
  if (d.kind !== "hip3") return false;
  const { dex } = splitHlMarket(coin);
  const live = dexes && dexes.byName instanceof Map ? dexes.byName.get(dex) : null;
  if (!live || live.index !== d.dexIndex) return false;
  const row = Array.isArray(universe) ? universe[d.index] : null;
  return !!row && row.name === coin && row.isDelisted !== true;
}
