// POST /api/realtime-session — starts a Voice Mode call: mints a short-lived OpenAI Realtime client secret.
//
// The browser connects to OpenAI over WebRTC with the secret this returns (src/agent/voice/session.js); it never sees
// OPENAI_API_KEY. The whole session is set HERE, server side: the model, FlowFlow's own system prompt plus the voice
// rules, the same tool schemas as the text Agent (tools.js, in Realtime's format), a voice, server VAD and input
// transcription (so what the user said shows in the chat). The browser sends no config at all.
//
// The owner's credit is small ($5), so every call is bounded:
//   • only our own pages (Origin allow-list; a missing Origin is refused too: a browser always sends one on POST);
//   • VOICE_PER_IP_PER_HOUR calls per IP an hour, and VOICE_ALL_PER_HOUR for everyone, per warm instance;
//   • the secret must be used within SECRET_TTL_SECONDS, and the browser hangs up after maxSeconds (it is told here);
//   • max_output_tokens bounds every spoken answer;
//   • VOICE_MODE=off in the server env turns it off without a deploy of code.
// It never returns the API key, and scrubs it from any upstream text.
import { createHash } from "node:crypto";
import { systemPrompt } from "../src/agent/prompt.js";
import { toolsFor } from "../src/agent/tools.js";
import { realtimeTools, voiceInstructions } from "../src/agent/voice/voiceTools.js";
import { paidOriginAllowed } from "../src/lib/originCheck.js";
import { capsFromEnv, serverFlags } from "./chat.js";

const UPSTREAM = "https://api.openai.com/v1/realtime/client_secrets";
/** On the owner's key (GET /v1/models lists it). VOICE_MODEL may name another gpt-realtime model. */
export const REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const VOICE = "marin";
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
/** The browser hangs up after this. VOICE_MAX_SECONDS may lower it, never raise it. */
export const MAX_SESSION_SECONDS = 180;
/** How long the secret stays usable to OPEN a call (the WebRTC handshake follows at once). */
export const SECRET_TTL_SECONDS = 60;
export const PER_IP_PER_HOUR = 6;
export const ALL_PER_HOUR = 60;
/** One spoken answer's ceiling (audio tokens included): a few sentences. */
export const MAX_OUTPUT_TOKENS = 800;
const TIMEOUT_MS = 10_000;
const HOUR = 3_600_000;
const MODEL_RE = /^gpt-realtime[a-z0-9.-]{0,40}$/;

/** Our own pages only (src/lib/originCheck.js, the same list as api/chat.js). Unlike the quote proxy, a call costs
 *  money: no Origin, no call. */
export const originAllowed = paidOriginAllowed;

const lowerOnly = (v, max, min = 1) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : max;
};

/** The limits in force: the constants, lowered (never raised) by env. */
export function limitsFromEnv(env = {}) {
  return {
    maxSeconds: lowerOnly(env.VOICE_MAX_SECONDS, MAX_SESSION_SECONDS, 30),
    perIp: lowerOnly(env.VOICE_PER_IP_PER_HOUR, PER_IP_PER_HOUR),
    all: lowerOnly(env.VOICE_ALL_PER_HOUR, ALL_PER_HOUR),
  };
}

/* ── Rate limits (per warm instance) ──────────────────────────────────────────────────────────────────────── */

const byIp = new Map();
let everyone = [];

/** Counts this request and says whether it is over a limit: null when it may go, else { scope, retryAfter } (s). */
export function rateCheck(ip, now = Date.now(), limits = limitsFromEnv()) {
  const k = ip || "unknown";
  const mine = (byIp.get(k) || []).filter((t) => now - t < HOUR);
  everyone = everyone.filter((t) => now - t < HOUR);
  const wait = (list) => Math.max(1, Math.ceil((list[0] + HOUR - now) / 1000));
  if (mine.length >= limits.perIp) { byIp.set(k, mine); return { scope: "ip", retryAfter: wait(mine) }; }
  if (everyone.length >= limits.all) return { scope: "all", retryAfter: wait(everyone) };
  mine.push(now);
  everyone.push(now);
  byIp.set(k, mine);
  if (byIp.size > 5000) byIp.clear();
  return null;
}

/** Tests: forget every call counted so far. */
export function resetRateLimits() { byIp.clear(); everyone = []; }

/* ── The session ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The body POSTed to /v1/realtime/client_secrets. Everything the call may do is decided here, from the same server
 *  settings as the text Agent (api/chat.js): the caps (env may lower them, never raise them), get_unlocks only with a
 *  Tokenomist key, and the earn flag. */
export function sessionRequest({ env = {}, now = new Date() } = {}) {
  const model = MODEL_RE.test(String(env.VOICE_MODEL || "")) ? String(env.VOICE_MODEL) : REALTIME_MODEL;
  const flags = serverFlags(env);
  const base = systemPrompt({ ...capsFromEnv(env), unlocks: flags.unlocks, earnOn: flags.earnOn, now });
  return {
    expires_after: { anchor: "created_at", seconds: SECRET_TTL_SECONDS },
    session: {
      type: "realtime",
      model,
      instructions: voiceInstructions(base),
      output_modalities: ["audio"],
      audio: {
        input: {
          noise_reduction: { type: "near_field" },
          transcription: {
            model: TRANSCRIBE_MODEL,
            prompt: "Crypto perpetual futures, Thai or English. Words: long, short, leverage, margin, USDC, take profit, stop loss, TP, SL, BTC, ETH, SOL, HYPE, AVAX, Aave, staking, ลอง, ชอร์ต, เลเวอเรจ, ยืนยัน.",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: VOICE },
      },
      tools: realtimeTools(toolsFor({ unlocks: flags.unlocks })),
      tool_choice: "auto",
      max_output_tokens: MAX_OUTPUT_TOKENS,
      tracing: null,
    },
  };
}

/** A stable, privacy-preserving id for the caller (OpenAI's OpenAI-Safety-Identifier): a hash, never the IP. */
export const safetyId = (ip) => createHash("sha256").update(`flowflow-voice:${ip || "unknown"}`).digest("hex").slice(0, 32);

const scrub = (text, key) => (key ? String(text).split(key).join("[key]") : String(text));

/**
 * The exchange without HTTP (tests call this).
 * @returns {Promise<{ status: number, body: object, headers?: object }>}
 */
export async function createVoiceSession({ origin, ip, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  if (!originAllowed(origin)) return { status: 403, body: { error: "forbidden" } };
  if (String(env.VOICE_MODE || "").trim().toLowerCase() === "off") {
    return { status: 503, body: { error: "voice_off", message: "Voice is switched off for now. Type instead." } };
  }
  const key = String(env.OPENAI_API_KEY || "").trim();
  if (!key) return { status: 503, body: { error: "not_configured", message: "Voice isn't set up on this server yet. Type instead." } };
  const limits = limitsFromEnv(env);
  const over = rateCheck(ip, now, limits);
  if (over) {
    return {
      status: 429,
      headers: { "retry-after": String(over.retryAfter) },
      body: {
        error: "rate_limited",
        retryAfter: over.retryAfter,
        message: over.scope === "ip" ? `That's ${limits.perIp} voice calls this hour. Type, or try again later.` : "Voice is busy right now. Try again in a few minutes.",
      },
    };
  }
  const request = sessionRequest({ env, now: new Date(now) });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(UPSTREAM, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "openai-safety-identifier": safetyId(ip) },
      body: JSON.stringify(request),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (r.status < 200 || r.status >= 300) {
      const e = json && json.error && typeof json.error === "object" ? json.error : {};
      const code = typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : `http_${r.status}`;
      const quota = code === "insufficient_quota" || r.status === 429;
      return {
        status: quota ? 429 : 502,
        body: {
          error: quota ? "upstream_busy" : "upstream_failed",
          code: scrub(code, key).slice(0, 60),
          message: quota ? "Voice is out of credit or busy right now. Type instead." : "Couldn't start voice. Try again, or type instead.",
          detail: typeof e.message === "string" ? scrub(e.message, key).slice(0, 200) : null,
        },
      };
    }
    const value = json && typeof json.value === "string" ? json.value : null;
    if (!value || value === key || !/^ek_[A-Za-z0-9_-]+$/.test(value)) return { status: 502, body: { error: "upstream_failed", message: "Couldn't start voice. Try again." } };
    return {
      status: 200,
      body: {
        value,
        expiresAt: json && Number.isFinite(json.expires_at) ? json.expires_at : null,
        model: request.session.model,
        voice: VOICE,
        maxSeconds: limits.maxSeconds,
      },
    };
  } catch (e) {
    return { status: 504, body: { error: "timeout", message: e && e.name === "AbortError" ? "Voice took too long to start. Try again." : "Couldn't reach voice. Try again." } };
  } finally {
    clearTimeout(t);
  }
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const out = await createVoiceSession({ origin: req.headers.origin, ip });
  return send(res, out.status, out.body, out.headers || {});
}
