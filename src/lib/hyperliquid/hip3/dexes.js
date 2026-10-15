// ─────────────────────────────────────────────────────────────────────────────
// HIP-3 dexes: who runs each one, its live index, its caps and its collateral.
// ─────────────────────────────────────────────────────────────────────────────
//
// venues.js parsePerpDexs keeps only { index, name, fullName }, which is all the
// market table needs. The Stocks plan needs the rest of the same answer:
// measured 2026-10-15 (scripts/fixtures/hip3/perp-dexs.json), every entry also
// carries deployer, oracleUpdater, feeRecipient, assetToStreamingOiCap,
// subDeployers (who may setOracle / haltTrading / registerAsset),
// assetToFundingMultiplier, assetToFundingInterestRate and assetToFundingClamp.
//
// THE INDEX IS THE POSITION IN THE LIVE ANSWER, exactly as venues.js reads it:
// entry 0 is null (the main dex), xyz was 1, mkts 9, io 10 on that date. It is
// never written down here; an asset id built on a remembered index is an order
// for the wrong market (venues.js has the whole argument).
//
// COLLATERAL IS NOT ALWAYS USDC. Same day, /info {type:"allPerpMetas"}:
// collateralToken 0 (USDC) for xyz, abcd, para, mkts, io; 360 (USDH) for flx,
// vntl, km; 235 (USDE) for hyna; 268 (USDT0) for cash. FlowFlow's Main Account
// is USDC, so only a USDC dex can be funded from it (exchange/venueCollateral.js
// refuses the rest); dexCollateral() says which is which.
//
// Pure: nothing here fetches. reads.js asks, this file reads the answer.

/** The spot token index of USDC (spotMeta, measured 2026-09-23 and 2026-10-15). */
export const USDC_TOKEN_INDEX = 0;

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const addrOrNull = (a) => (isAddr(a) ? a.toLowerCase() : null);
const num = (v) => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/* [["xyz:TSLA", "25000000.0"], ...] -> Map(coin -> number). Unreadable pairs are skipped, not zeroed. */
function pairMap(list) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (!Array.isArray(e) || e.length < 2 || typeof e[0] !== "string") continue;
    const v = num(e[1]);
    if (v != null) out.set(e[0], v);
  }
  return out;
}

/* [["setOracle", ["0x…", …]], ...] -> { setOracle: ["0x…"] } */
function subDeployersOf(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (!Array.isArray(e) || typeof e[0] !== "string" || !Array.isArray(e[1])) continue;
    out[e[0]] = Object.freeze(e[1].map(addrOrNull).filter(Boolean));
  }
  return Object.freeze(out);
}

/**
 * perpDexs -> every HIP-3 dex with its live index and what the answer says about it.
 * @returns {{ list: object[], byName: Map<string, object>, count: number }}
 *   row: { index, name, fullName, deployer, oracleUpdater, feeRecipient,
 *          oiCapUsd: Map, fundingMultiplier: Map, fundingInterestRate: Map,
 *          fundingClamp: Map, subDeployers: Record<string, string[]> }
 */
export function parseDexes(json) {
  const list = [];
  const byName = new Map();
  if (!Array.isArray(json)) return { list, byName, count: 0 };
  json.forEach((e, index) => {
    if (index === 0 || !e || typeof e !== "object") return;
    const name = typeof e.name === "string" && /^[a-z0-9]{1,16}$/.test(e.name) ? e.name : null;
    if (!name || byName.has(name)) return;
    const row = Object.freeze({
      index,
      name,
      fullName: typeof e.fullName === "string" && e.fullName ? e.fullName : null,
      deployer: addrOrNull(e.deployer),
      /* null in the answer for xyz, mkts and abcd: the oracle is then pushed by a
         sub-deployer named under setOracle, not by a single updater. */
      oracleUpdater: addrOrNull(e.oracleUpdater),
      feeRecipient: addrOrNull(e.feeRecipient),
      oiCapUsd: pairMap(e.assetToStreamingOiCap),
      fundingMultiplier: pairMap(e.assetToFundingMultiplier),
      fundingInterestRate: pairMap(e.assetToFundingInterestRate),
      fundingClamp: pairMap(e.assetToFundingClamp),
      subDeployers: subDeployersOf(e.subDeployers),
    });
    list.push(row);
    byName.set(name, row);
  });
  return { list, byName, count: json.length };
}

/**
 * A dex's collateral, from its own meta.collateralToken and spotMeta's tokens.
 * @param {any} meta /info {type:"meta", dex} (or one metaAndAssetCtxs [0])
 * @param {Array<{index:number,name:string}>|null} spotTokens spotMeta.tokens
 * @returns {{ index: number|null, name: string|null, isUsdc: boolean|null }}
 *   isUsdc null: the meta did not say, so nobody may fund it yet
 */
export function dexCollateral(meta, spotTokens = null) {
  const index = meta && Number.isSafeInteger(meta.collateralToken) && meta.collateralToken >= 0 ? meta.collateralToken : null;
  if (index == null) return { index: null, name: null, isUsdc: null };
  const row = Array.isArray(spotTokens) ? spotTokens.find((t) => t && t.index === index) : null;
  return { index, name: row && typeof row.name === "string" ? row.name : null, isUsdc: index === USDC_TOKEN_INDEX };
}

/**
 * How much of a market's streaming OI cap is used, 0..1+, or null when either
 * figure is unknown. A market at its cap takes no new opening orders, which the
 * guard (guard.js) turns into a refusal before anything is signed.
 */
export function oiCapUse(openInterestUsd, capUsd) {
  const oi = num(openInterestUsd);
  const cap = num(capUsd);
  if (oi == null || cap == null || cap <= 0 || oi < 0) return null;
  return oi / cap;
}
