// POST /api/onchain-withdraw { user, chainId?, private? } — counts the user's withdrawals on Avalanche.
// GET  /api/onchain-withdraw?user=0x… — their FlowFlow account and count, read from the contract.
//
// The contract (contracts/src/FlowFlowAccounts.sol, FlowFlowAccountFactory on Avalanche C-Chain) holds no money: it
// keeps one account per user and a public count of the withdrawals they signed in FlowFlow. Only this server's
// recorder key may count one, and it counts ONLY what it reads itself on Hyperliquid: the user's own outbound USDC
// transfers of the last day (userNonFundingLedgerUpdates), each once, by its Hyperliquid tx hash. The browser says
// which user; it can never say what was withdrawn. chainId / private are labels for the newest one only.
//
// Env (server only): AVAX_RECORDER_KEY (the recorder's key), AVAX_FACTORY (the contract), AVAX_RPC (optional).
// Without them it answers 503 and the app carries on: counting never holds a withdrawal up.

import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";
import { parseLedger } from "../src/lib/hyperliquid/account/parse.js";
import { originAllowed, createRateLimiter } from "../src/lib/intents/guard.js";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const DEFAULT_RPC = "https://api.avax.network/ext/bc/C/rpc";
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_CALL = 3;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const COUNTED = new Set(["withdraw", "send", "spotTransfer"]);
const ABI = [
  "function recordWithdraw(address user, uint256 amountUsdc, uint256 destChainId, bytes32 hlTxHash, bool isPrivate)",
  "function recorded(bytes32) view returns (bool)",
  "function accountOf(address) view returns (address)",
  "function predictAccount(address) view returns (address)",
  "function withdrawCount(address) view returns (uint256)",
  "function withdrawnUsdc(address) view returns (uint256)",
];

export const rateLimited = createRateLimiter(20);
const json = (status, obj) => ({ status, body: JSON.stringify(obj) });

export function configOf(env = process.env) {
  const key = String(env.AVAX_RECORDER_KEY || "").trim();
  const factory = String(env.AVAX_FACTORY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !ADDRESS_RE.test(factory)) return null;
  return { key, factory, rpc: String(env.AVAX_RPC || "").trim() || DEFAULT_RPC };
}

/** The user's own outbound USDC transfers in the window, oldest first: what may be counted. */
export function withdrawalsOf(ledgerJson, user, now = Date.now()) {
  const lines = parseLedger(ledgerJson, user) || [];
  return lines
    .filter((l) => COUNTED.has(l.type) && l.direction === "out" && Number.isFinite(l.usdc) && l.usdc > 0
      && typeof l.hash === "string" && HASH_RE.test(l.hash) && Number.isFinite(l.time) && now - l.time <= WINDOW_MS)
    .sort((a, b) => a.time - b.time);
}

/* One recorder, one nonce at a time. */
let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

/** The exchange without HTTP (tests call this). */
export async function recordOnce({ user, chainId = 0, isPrivate = false, env = process.env, fetchImpl = fetch, contract = null, now = Date.now() }) {
  if (typeof user !== "string" || !ADDRESS_RE.test(user)) return json(400, { error: "bad_request", message: "Not an address." });
  const cfg = configOf(env);
  if (!cfg && !contract) return json(503, { error: "not_configured" });
  const me = getAddress(user);
  let ledger;
  try {
    const r = await fetchImpl(HL_INFO, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "userNonFundingLedgerUpdates", user: me, startTime: now - WINDOW_MS }),
    });
    ledger = await r.json();
  } catch {
    return json(502, { error: "ledger_unreadable" });
  }
  const c = contract || new Contract(cfg.factory, ABI, new Wallet(cfg.key, new JsonRpcProvider(cfg.rpc, 43114, { staticNetwork: true })));
  const all = withdrawalsOf(ledger, me, now);
  const newest = all.length ? all[all.length - 1].hash : null;
  return serial(async () => {
    const counted = [];
    for (const w of all) {
      if (counted.length >= MAX_PER_CALL) break;
      if (await c.recorded(w.hash)) continue;
      const label = w.hash === newest;
      const tx = await c.recordWithdraw(me, BigInt(Math.round(w.usdc * 1e6)), BigInt(label && Number.isInteger(chainId) && chainId > 0 ? chainId : 0), w.hash, label && isPrivate === true);
      await tx.wait();
      counted.push({ hlTxHash: w.hash, usdc: w.usdc, tx: tx.hash });
    }
    return json(200, { counted, ...(await accountView(c, me)) });
  });
}

async function accountView(c, user) {
  const [account, predicted, count, usdc] = await Promise.all([c.accountOf(user), c.predictAccount(user), c.withdrawCount(user), c.withdrawnUsdc(user)]);
  const a = /^0x0{40}$/.test(account) ? null : account;
  return { account: a || predicted, created: !!a, withdrawals: Number(count), withdrawnUsdc: Number(usdc) / 1e6 };
}

function send(res, out) {
  res.statusCode = out.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(out.body);
}

async function bodyOf(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 2000) break; }
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

export default async function handler(req, res) {
  if (!originAllowed(req.headers.origin)) return send(res, json(403, { error: "forbidden" }));
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, json(429, { message: "Too many requests. Wait a minute." }));
  const cfg = configOf();
  if (!cfg) return send(res, json(503, { error: "not_configured" }));
  try {
    if (req.method === "GET") {
      const user = new URL(req.url || "/", "http://local").searchParams.get("user") || "";
      if (!ADDRESS_RE.test(user)) return send(res, json(400, { error: "bad_request" }));
      const c = new Contract(cfg.factory, ABI, new JsonRpcProvider(cfg.rpc, 43114, { staticNetwork: true }));
      return send(res, json(200, { factory: cfg.factory, ...(await accountView(c, getAddress(user))) }));
    }
    if (req.method !== "POST") return send(res, json(405, { error: "method_not_allowed" }));
    const b = await bodyOf(req);
    return send(res, await recordOnce({ user: b.user, chainId: Number(b.chainId) || 0, isPrivate: b.private === true }));
  } catch (e) {
    /* Never the key: ethers errors carry no private key, but trim them anyway. */
    return send(res, json(500, { error: "record_failed", message: String((e && e.shortMessage) || (e && e.message) || e).slice(0, 200) }));
  }
}
