/**
 * test-voice-api — api/realtime-session.js, the server half of Voice Mode. It mints a short-lived OpenAI Realtime
 * client secret with the session set SERVER SIDE (model, FlowFlow's prompt + voice rules, the same tools in Realtime's
 * format, voice, server VAD, input transcription), and guards the owner's small credit: our pages only, per-IP and
 * global hourly limits, a short secret, a time limit the browser obeys, and never the API key in any answer.
 * Also the tool conversion (src/agent/voice/voiceTools.js realtimeTools).
 *
 * No network: OpenAI is a fake fetch.
 * Run: node --test scripts/test-voice-api.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import handler, {
  createVoiceSession, sessionRequest, originAllowed, rateCheck, resetRateLimits, limitsFromEnv, safetyId,
  REALTIME_MODEL, VOICE, TRANSCRIBE_MODEL, MAX_SESSION_SECONDS, SECRET_TTL_SECONDS, PER_IP_PER_HOUR, ALL_PER_HOUR, MAX_OUTPUT_TOKENS,
} from "../api/realtime-session.js";
import { TOOLS, toolsFor } from "../src/agent/tools.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { realtimeTools, VOICE_TOOL_NAMES, VOICE_STYLE } from "../src/agent/voice/voiceTools.js";

const KEY = "sk-proj-TESTKEY1234567890abcdef";
const ENV = { OPENAI_API_KEY: KEY };
const ORIGIN = "https://flowflow-alpha.vercel.app";

function fake(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    if (body instanceof Error) throw body;
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}
const okSecret = () => fake(200, { value: "ek_68af0abc1234", expires_at: 1_800_000_060, session: { type: "realtime", id: "sess_1" } });

let ipSeq = 0;
const freshIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

test("V1) the session is decided on the server: model, prompt + voice rules, tools, voice, VAD, transcription", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  const r = sessionRequest({ env: {}, now });
  assert.deepEqual(r.expires_after, { anchor: "created_at", seconds: SECRET_TTL_SECONDS });
  assert.ok(SECRET_TTL_SECONDS <= 120, "the secret only has to live through the handshake");
  const s = r.session;
  assert.equal(s.type, "realtime");
  assert.equal(s.model, REALTIME_MODEL);
  assert.equal(REALTIME_MODEL, "gpt-realtime-2.1-mini");
  assert.ok(s.instructions.startsWith(systemPrompt({ maxMarginUsdc: 20, maxLeverage: 10, now })), "FlowFlow's own prompt first");
  assert.ok(s.instructions.endsWith(VOICE_STYLE), "then the voice rules");
  assert.deepEqual(s.output_modalities, ["audio"]);
  assert.equal(s.audio.output.voice, VOICE);
  assert.equal(s.audio.input.turn_detection.type, "server_vad");
  assert.equal(s.audio.input.turn_detection.create_response, true);
  assert.equal(s.audio.input.transcription.model, TRANSCRIBE_MODEL, "transcripts show in the chat");
  /* The text Agent's tools, as the server has them: no Tokenomist key in this env, so no get_unlocks (A10). */
  assert.deepEqual(s.tools, realtimeTools(toolsFor({ unlocks: false })));
  assert.deepEqual(sessionRequest({ env: { TOKENOMIST_API_KEY: "k" }, now }).session.tools, realtimeTools(TOOLS));
  assert.equal(s.tool_choice, "auto");
  assert.equal(s.max_output_tokens, MAX_OUTPUT_TOKENS);
  assert.ok(MAX_OUTPUT_TOKENS <= 1000);
  assert.equal(s.tracing, null);
  /* The limits in the prompt are the app's (the same env as the text Agent). */
  assert.match(sessionRequest({ env: { VITE_MAX_MARGIN_USDC: "15", VITE_AGENT_MAX_LEVERAGE: "5" } }).session.instructions, /margin at most 15 USDC per order, leverage at most 5x/);
});

test("V2) a call: POST client_secrets with the key as Bearer; the answer has the ek_ secret and the limits, never the key", async () => {
  resetRateLimits();
  const f = okSecret();
  const ip = freshIp();
  const r = await createVoiceSession({ origin: ORIGIN, ip, env: ENV, fetchImpl: f, now: Date.parse("2026-10-15T09:00:00Z") });
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  /* OpenAI's safety identifier: a hash, never the IP. */
  assert.equal(f.calls[0].init.headers["openai-safety-identifier"], safetyId(ip));
  assert.doesNotMatch(f.calls[0].init.headers["openai-safety-identifier"], /10\.0\./);
  assert.equal(f.calls[0].body.session.model, REALTIME_MODEL);
  assert.deepEqual(r.body, { value: "ek_68af0abc1234", expiresAt: 1_800_000_060, model: REALTIME_MODEL, voice: VOICE, maxSeconds: MAX_SESSION_SECONDS });
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(KEY));
  assert.equal("session" in r.body, false, "the prompt and tools stay on the server's side of the answer");
});

test("V3) refused before anything is fetched: other sites, no Origin, switched off, no key", async () => {
  resetRateLimits();
  const f = okSecret();
  for (const origin of [undefined, "", "https://evil.example", "https://flowflow-alpha.vercel.app.evil.example", "http://localhost.evil.example"]) {
    const r = await createVoiceSession({ origin, ip: freshIp(), env: ENV, fetchImpl: f });
    assert.equal(r.status, 403, String(origin));
  }
  assert.equal((await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: { ...ENV, VOICE_MODE: "off" }, fetchImpl: f })).status, 503);
  const nokey = await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: {}, fetchImpl: f });
  assert.equal(nokey.status, 503);
  assert.equal(nokey.body.error, "not_configured");
  assert.equal(f.calls.length, 0);
  for (const ok of [ORIGIN, "https://flowflow-abc123-flow-flow.vercel.app", "http://localhost:5173", "http://127.0.0.1:5174"]) assert.equal(originAllowed(ok), true, ok);
});

test("V4) the budget: 6 calls per IP an hour (then 429 with retry-after), a cap for everyone, both forgiven after an hour", async () => {
  resetRateLimits();
  const t0 = Date.parse("2026-10-15T09:00:00Z");
  const ip = freshIp();
  for (let i = 0; i < PER_IP_PER_HOUR; i++) {
    assert.equal((await createVoiceSession({ origin: ORIGIN, ip, env: ENV, fetchImpl: okSecret(), now: t0 + i * 1000 })).status, 200, `call ${i + 1}`);
  }
  const f = okSecret();
  const over = await createVoiceSession({ origin: ORIGIN, ip, env: ENV, fetchImpl: f, now: t0 + 10_000 });
  assert.equal(over.status, 429);
  assert.equal(f.calls.length, 0, "a refused call costs nothing");
  assert.ok(over.body.retryAfter > 0 && over.body.retryAfter <= 3600);
  assert.equal(over.headers["retry-after"], String(over.body.retryAfter));
  /* Another caller still gets in; after an hour this one does again. */
  assert.equal((await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: ENV, fetchImpl: okSecret(), now: t0 + 11_000 })).status, 200);
  assert.equal((await createVoiceSession({ origin: ORIGIN, ip, env: ENV, fetchImpl: okSecret(), now: t0 + 3_601_000 })).status, 200);
  /* Everyone together. */
  resetRateLimits();
  let tripped = null;
  for (let i = 0; i <= ALL_PER_HOUR && !tripped; i++) tripped = rateCheck(`192.168.${i}.1`, t0 + i, limitsFromEnv({}));
  assert.equal(tripped && tripped.scope, "all");
});

test("V5) limits from env may only go down; VOICE_MODEL must be a gpt-realtime name", () => {
  assert.deepEqual(limitsFromEnv({}), { maxSeconds: MAX_SESSION_SECONDS, perIp: PER_IP_PER_HOUR, all: ALL_PER_HOUR });
  assert.equal(limitsFromEnv({ VOICE_MAX_SECONDS: "600" }).maxSeconds, MAX_SESSION_SECONDS);
  assert.equal(limitsFromEnv({ VOICE_MAX_SECONDS: "90" }).maxSeconds, 90);
  assert.equal(limitsFromEnv({ VOICE_MAX_SECONDS: "5" }).maxSeconds, MAX_SESSION_SECONDS, "below the floor: ignored");
  assert.equal(limitsFromEnv({ VOICE_PER_IP_PER_HOUR: "100" }).perIp, PER_IP_PER_HOUR);
  assert.equal(limitsFromEnv({ VOICE_PER_IP_PER_HOUR: "2" }).perIp, 2);
  assert.equal(limitsFromEnv({ VOICE_ALL_PER_HOUR: "abc" }).all, ALL_PER_HOUR);
  assert.equal(sessionRequest({ env: { VOICE_MODEL: "gpt-realtime-2.1" } }).session.model, "gpt-realtime-2.1");
  for (const bad of ["gpt-4o", "gpt-realtime; DROP", "o3", ""]) assert.equal(sessionRequest({ env: { VOICE_MODEL: bad } }).session.model, REALTIME_MODEL, bad);
});

test("V6) OpenAI's refusals never carry the key; quota is a 429; anything that is not an ek_ secret is not passed on", async () => {
  resetRateLimits();
  const leak = await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: ENV, fetchImpl: fake(401, { error: { message: `Incorrect API key provided: ${KEY}`, code: "invalid_api_key" } }) });
  assert.equal(leak.status, 502);
  assert.doesNotMatch(JSON.stringify(leak.body), new RegExp(KEY));
  assert.equal(leak.body.code, "invalid_api_key");
  const quota = await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: ENV, fetchImpl: fake(429, { error: { code: "insufficient_quota", message: "You exceeded your quota" } }) });
  assert.equal(quota.status, 429);
  assert.equal(quota.body.error, "upstream_busy");
  const echo = await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: ENV, fetchImpl: fake(200, { value: KEY }) });
  assert.equal(echo.status, 502, "the API key itself is never returned, whatever upstream says");
  assert.doesNotMatch(JSON.stringify(echo.body), new RegExp(KEY));
  const odd = await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: ENV, fetchImpl: fake(200, { value: "<script>" }) });
  assert.equal(odd.status, 502);
  const down = await createVoiceSession({ origin: ORIGIN, ip: freshIp(), env: ENV, fetchImpl: fake(0, new Error("ECONNRESET")) });
  assert.equal(down.status, 504);
});

test("V7) the HTTP handler: POST only, reads Origin and the caller's IP, answers no-store JSON", async () => {
  resetRateLimits();
  const res = () => {
    const r = { statusCode: 0, headers: {}, body: "" };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
    r.end = (b) => { r.body = b; };
    return r;
  };
  const get = res();
  await handler({ method: "GET", headers: {} }, get);
  assert.equal(get.statusCode, 405);
  const foreign = res();
  await handler({ method: "POST", headers: { origin: "https://evil.example", "x-forwarded-for": "1.2.3.4" } }, foreign);
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.headers["cache-control"], "no-store");
  assert.match(foreign.headers["content-type"], /application\/json/);
});

test("T1) tool conversion: the same tools, same names and schemas, in Realtime's flat { type, name, description, parameters }", () => {
  const rt = realtimeTools(TOOLS);
  assert.equal(rt.length, TOOLS.length);
  for (let i = 0; i < TOOLS.length; i++) {
    assert.deepEqual(Object.keys(rt[i]).sort(), ["description", "name", "parameters", "type"]);
    assert.equal(rt[i].type, "function");
    assert.equal(rt[i].name, TOOLS[i].function.name);
    assert.equal(rt[i].description, TOOLS[i].function.description);
    assert.deepEqual(rt[i].parameters, TOOLS[i].function.parameters);
  }
  assert.deepEqual(VOICE_TOOL_NAMES, rt.map((t) => t.name));
});

test("T2) 🔴 no tool that confirms, signs, sends or touches Autopilot can ever reach the voice model", () => {
  const extra = ["confirm_order", "execute_trade", "sign_tx", "approve_spend", "submit_card", "send_usdc", "place_order", "autopilot_grant", "transfer"]
    .map((name) => ({ type: "function", function: { name, description: "x", parameters: { type: "object", properties: {} } } }));
  const rt = realtimeTools([...TOOLS, ...extra]);
  assert.deepEqual(rt.map((t) => t.name), TOOLS.map((t) => t.function.name));
  for (const n of VOICE_TOOL_NAMES) assert.doesNotMatch(n, /(^|_)(confirm|execute|sign|submit|send|transfer|place|autopilot|grant)(_|$)/i, n);
  /* Whole words only: a read tool that merely contains one (signals, designs) is not caught. */
  const reads = ["get_signals", "get_design"].map((name) => ({ type: "function", function: { name, description: "x", parameters: { type: "object", properties: {} } } }));
  assert.deepEqual(realtimeTools(reads).map((t) => t.name), ["get_signals", "get_design"]);
  /* Malformed entries are skipped, never thrown on. */
  assert.deepEqual(realtimeTools([null, {}, { type: "function" }, { type: "function", function: { name: "" } }]), []);
});
