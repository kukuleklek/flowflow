// EARN: the Agent's stake playbook (owner: "AI แม่งพาเปิด Position หรือพา Staking เลยได้ไหม"). FlowFlow's earn product
// is USDC supplied to Aave V3 on Avalanche (owner's decision, R-aave.md). In the customer's words (owner, 2026-10-15,
// two accounts): "USDC Staked AAVE", a holding inside the Spot Account (on AVAX), moved there from the Main Account.
//
// This file only READS (the live Aave V3 USDC supply APY, through the finished read layer src/lib/avax/read.js) and
// builds the "stake" card. It never moves money: the card's own Confirm (built by the Avax Wallet flows, behind
// VITE_EARN) is the only way anything happens. With VITE_EARN off (prod until the live test) the card still shows the
// live APY, the steps and what the user can do now: "Opens with the Spot Account", never a dead end.
//
// 🔴 UNKNOWN IS NULL: an APY that could not be read is null (a dash), never 0.
import { readAaveUsdcMarket } from "../lib/avax/read.js";

const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** The entry into earn is on only with this build flag (plan v2 §2.9: flags close the way in, never the way out). */
export const EARN_ENABLED = ENV.VITE_EARN === "on";
/** Most USDC one stake card may name (plan v2 HARD.stakeUsdc; an env value can lower it, never raise it). */
export const MAX_STAKE_USDC = Math.min(20, num(ENV.VITE_MAX_STAKE_USDC, 20));
export const EARN_PROTOCOL = "Aave V3";
export const EARN_CHAIN = "Avalanche";
/** How long a read APY is reused. */
export const EARN_APY_TTL_MS = 5 * 60_000;
export const EARN_READ_TIMEOUT_MS = 6000;

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);
const fmt = (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });

let cached = null; /* { at, value } */

/** The last APY read (within its time to live), or null. */
export function peekEarnApy(now = Date.now()) {
  return cached && now - cached.at < EARN_APY_TTL_MS && cached.value && fin(cached.value.apyPct) ? cached.value.apyPct : null;
}

/** For tests: forget the cached reading. */
export function resetEarnCache() {
  cached = null;
}

/**
 * The live Aave V3 USDC reserve on Avalanche: { apyPct, active, frozen, paused, at }. Never rejects: anything
 * unreadable is null. `read` is injectable (the Node suite never touches the network).
 */
export async function readEarnApy({ read = readAaveUsdcMarket, fetchImpl, now = Date.now, timeoutMs = EARN_READ_TIMEOUT_MS, fresh = false } = {}) {
  const t = now();
  if (!fresh && cached && t - cached.at < EARN_APY_TTL_MS) return cached.value;
  let s = null;
  let timer = null;
  try {
    s = await Promise.race([
      Promise.resolve().then(() => read(fetchImpl ? { fetchImpl } : {})),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    s = null;
  } finally {
    clearTimeout(timer);
  }
  const value = {
    apyPct: s && fin(s.apyPct) && s.apyPct >= 0 ? r2(s.apyPct) : null,
    active: s && typeof s.active === "boolean" ? s.active : null,
    frozen: s && typeof s.frozen === "boolean" ? s.frozen : null,
    paused: s && typeof s.paused === "boolean" ? s.paused : null,
    at: t,
  };
  if (value.apyPct != null) cached = { at: t, value };
  return value;
}

/** The USDC amount a sentence names ("stake 20 usdc", "ฝาก 15 ดอลกินดอก", "$12.5"), or null. */
export function parseStakeAmount(text) {
  /* Not an amount: names with digits ("aave v3", "x10") and rates or periods ("5.7%", "3x", "30 days"). */
  const s = String(text || "").toLowerCase().replace(/,/g, "")
    .replace(/[a-z]+\d+(?:\.\d+)?/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:%|x(?![a-z])|apy|apr|days?|วัน|เดือน|ปี)/g, " ");
  const m =/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usdc|usd|\$|ดอล(?:ล่า|ลาร์)?|เหรียญ|บาท)?/i.exec(s);
  if (!m) return null;
  const n = Number(m[1] || m[2]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The "stake" card (shared contract):
 *   { kind:"stake", asset:"USDC", amountUsdc|null, apyPct|null, protocol:"Aave V3", chain:"Avalanche",
 *     steps:[{kind:"move",label},{kind:"supply",label}], enabled, note }
 * plus: capped, maxUsdc, perpFreeUsdc (free USDC in the Main Account, null when unread), perYearUsdc (amount × APY,
 * null when either is unknown), reserveOk (null unknown; false when Aave has the reserve paused or frozen).
 */
export function stakeCard({ amountUsdc = null, apy = null, enabled = EARN_ENABLED, perpFreeUsdc = null } = {}) {
  const asked = fin(amountUsdc) && amountUsdc > 0 ? amountUsdc : null;
  const capped = asked != null && asked > MAX_STAKE_USDC;
  const amount = asked == null ? null : r2(Math.min(asked, MAX_STAKE_USDC));
  const apyPct = apy && fin(apy.apyPct) ? r2(apy.apyPct) : null;
  const reserveOk = apy && (apy.active != null || apy.frozen != null || apy.paused != null)
    ? apy.active !== false && apy.frozen !== true && apy.paused !== true : null;
  const what = amount != null ? `${fmt(amount)} USDC` : "USDC";
  const notes = [];
  if (capped) notes.push(`Capped at ${MAX_STAKE_USDC} USDC per stake for now.`);
  if (reserveOk === false) notes.push("USDC Staked AAVE is paused right now.");
  if (!enabled) notes.push("Opens with the Spot Account. Your USDC stays in your Main Account for trading meanwhile.");
  else notes.push("Variable rate. USDC Staked AAVE is not trading margin.");
  return {
    kind: "stake",
    asset: "USDC",
    amountUsdc: amount,
    apyPct,
    protocol: EARN_PROTOCOL,
    chain: EARN_CHAIN,
    steps: [
      { kind: "move", label: `Move ${what} from your Main Account to your Spot Account` },
      { kind: "supply", label: `Stake ${what} as USDC Staked AAVE` },
    ],
    enabled: !!enabled,
    note: notes.join(" "),
    capped,
    maxUsdc: MAX_STAKE_USDC,
    perpFreeUsdc: fin(perpFreeUsdc) ? r2(perpFreeUsdc) : null,
    perYearUsdc: amount != null && apyPct != null ? r2((amount * apyPct) / 100) : null,
    reserveOk,
  };
}

/** The one line the Agent says over the stake card: the rate only. When staking is not open yet, the card's own lock
 *  row says so once (review, polish 1: the line, a note row and the lock row said it three times). */
export function stakeLine(card, lang = "en") {
  const th = lang === "th";
  const apy = card && card.apyPct != null ? `${card.apyPct.toFixed(2)}%` : null;
  if (th) {
    const rate = apy ? `ได้ประมาณ ${apy} ต่อปี (ผันผวน)` : "อ่าน APY ไม่ได้ตอนนี้";
    return `ฝาก USDC เป็น USDC Staked AAVE บน AVAX ${rate}`;
  }
  return apy ? `USDC Staked AAVE on AVAX pays ${apy} APY, variable.` : "USDC Staked AAVE on AVAX: the APY couldn't be read right now.";
}

/** What the model reads after propose_stake. */
export function stakeForModel(card) {
  return {
    shown: true,
    /* The customer's name for it (the protocol and chain fields stay as data). */
    product: "USDC Staked AAVE, inside the Spot Account (on AVAX)",
    asset: "USDC",
    protocol: EARN_PROTOCOL,
    chain: EARN_CHAIN,
    amount_usdc: card.amountUsdc,
    apy_pct: card.apyPct,
    enabled: card.enabled,
    steps: card.steps.map((s) => s.label),
    note: `${card.note} The card moves nothing until the user confirms on it. Do not say money moved or is earning.`,
  };
}
