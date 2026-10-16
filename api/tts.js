// POST /api/tts {text} → audio/mpeg: Voice Mode's spoken answers in an ElevenLabs voice.
// The brain stays OpenAI Realtime (it listens, calls the tools and writes the answer as text: realtime-session.js
// turns its audio off when this is configured); this only reads that text out loud.
//   • ELEVENLABS_API_KEY is server-only (never VITE_); the browser never sees it.
//   • ELEVENLABS_VOICE_ID / ELEVENLABS_MODEL may pick another voice or model.
//   • Our own pages only (a call costs money), one short answer per call, a per-IP and an overall hourly limit.
import { paidOriginAllowed } from "../src/lib/originCheck.js";

export const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // ElevenLabs' premade "Sarah"
export const DEFAULT_MODEL = "eleven_flash_v2_5";
export const MAX_CHARS = 600;
export const PER_IP_PER_HOUR = 240;
export const ALL_PER_HOUR = 2000;
const TIMEOUT_MS = 12_000;
const HOUR = 3_600_000;
const ID_RE = /^[A-Za-z0-9]{8,40}$/;
const MODEL_RE = /^eleven_[a-z0-9_]{2,40}$/;

/** Is ElevenLabs set up on this server? (realtime-session.js asks the same, to turn the model's own audio off.) */
export const ttsConfigured = (env = process.env) => !!String(env.ELEVENLABS_API_KEY || "").trim()
  && String(env.VOICE_TTS || "").trim().toLowerCase() !== "openai";

const byIp = new Map();
let everyone = [];
function allow(ip, now) {
  everyone = everyone.filter((t) => now - t < HOUR);
  const mine = (byIp.get(ip) || []).filter((t) => now - t < HOUR);
  if (mine.length >= PER_IP_PER_HOUR || everyone.length >= ALL_PER_HOUR) return false;
  mine.push(now);
  byIp.set(ip, mine);
  everyone.push(now);
  return true;
}

/** The text as it will be spoken: one short answer, no markup. null when there is nothing to say. */
export function speakable(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MAX_CHARS) : null;
}

export async function speak({ origin, ip, text, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  if (!paidOriginAllowed(origin)) return { status: 403, json: { error: "forbidden_origin" } };
  if (!ttsConfigured(env)) return { status: 503, json: { error: "not_configured" } };
  const say = speakable(text);
  if (!say) return { status: 400, json: { error: "no_text" } };
  if (!allow(ip || "?", now)) return { status: 429, json: { error: "rate_limited" } };
  const key = String(env.ELEVENLABS_API_KEY).trim();
  const voice = ID_RE.test(String(env.ELEVENLABS_VOICE_ID || "")) ? String(env.ELEVENLABS_VOICE_ID) : DEFAULT_VOICE_ID;
  const model = MODEL_RE.test(String(env.ELEVENLABS_MODEL || "")) ? String(env.ELEVENLABS_MODEL) : DEFAULT_MODEL;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: say, model_id: model }),
      signal: ctrl.signal,
    });
    if (!r.ok) return { status: r.status === 429 ? 429 : 502, json: { error: r.status === 429 ? "upstream_busy" : "upstream_failed", code: r.status } };
    const audio = Buffer.from(await r.arrayBuffer());
    if (!audio.length) return { status: 502, json: { error: "upstream_empty" } };
    return { status: 200, audio };
  } catch (e) {
    return { status: 504, json: { error: e && e.name === "AbortError" ? "timeout" : "unreachable" } };
  } finally {
    clearTimeout(t);
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 8_000) break; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const body = await readBody(req);
  const out = await speak({ origin: req.headers.origin, ip, text: body && body.text });
  res.statusCode = out.status;
  if (out.audio) {
    res.setHeader("content-type", "audio/mpeg");
    res.end(out.audio);
    return;
  }
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(out.json));
}
