// Voice Mode in an ElevenLabs voice: the Realtime model answers in text and api/tts.js speaks it. The key stays on the
// server; our pages only; the session's audio is off only when ElevenLabs is set up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { speak, speakable, ttsConfigured, DEFAULT_VOICE_ID, DEFAULT_MODEL, MAX_CHARS } from "../api/tts.js";
import { sessionRequest } from "../api/realtime-session.js";

const KEY = "sk_test_eleven_0000";
const ENV = { ELEVENLABS_API_KEY: KEY };
const ORIGIN = "https://flowflow-alpha.vercel.app";
const mp3 = () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0xf3, 1, 2]).buffer }; };
  f.calls = calls;
  return f;
};

test("T1) speaks one answer: the key in the header only, the default voice and model, mp3 back", async () => {
  const f = mp3();
  const r = await speak({ origin: ORIGIN, ip: "10.1.0.1", text: "Your **BTC** card is ready.", env: ENV, fetchImpl: f });
  assert.equal(r.status, 200);
  assert.ok(Buffer.isBuffer(r.audio) && r.audio.length === 4);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, new RegExp(`/v1/text-to-speech/${DEFAULT_VOICE_ID}\\?output_format=mp3_44100_64$`));
  assert.equal(f.calls[0].init.headers["xi-api-key"], KEY);
  assert.deepEqual(f.calls[0].body, { text: "Your BTC card is ready.", model_id: DEFAULT_MODEL });
  assert.doesNotMatch(f.calls[0].url, new RegExp(KEY));
});

test("T2) refused before anything is fetched: other sites, no key, VOICE_TTS=openai, no text", async () => {
  const f = mp3();
  for (const origin of [undefined, "", "https://evil.example"]) assert.equal((await speak({ origin, ip: "10.1.0.2", text: "hi", env: ENV, fetchImpl: f })).status, 403);
  assert.equal((await speak({ origin: ORIGIN, ip: "10.1.0.2", text: "hi", env: {}, fetchImpl: f })).status, 503);
  assert.equal((await speak({ origin: ORIGIN, ip: "10.1.0.2", text: "hi", env: { ...ENV, VOICE_TTS: "openai" }, fetchImpl: f })).status, 503);
  assert.equal((await speak({ origin: ORIGIN, ip: "10.1.0.2", text: "   ", env: ENV, fetchImpl: f })).status, 400);
  assert.equal(f.calls.length, 0);
});

test("T3) one short answer at most; a bad env voice or model falls back to the defaults", async () => {
  assert.equal(speakable("x".repeat(5000)).length, MAX_CHARS);
  assert.equal(speakable(null), null);
  const f = mp3();
  await speak({ origin: ORIGIN, ip: "10.1.0.3", text: "ok", env: { ...ENV, ELEVENLABS_VOICE_ID: "../../x", ELEVENLABS_MODEL: "gpt-4" }, fetchImpl: f });
  assert.match(f.calls[0].url, new RegExp(DEFAULT_VOICE_ID));
  assert.equal(f.calls[0].body.model_id, DEFAULT_MODEL);
});

test("T4) the Realtime session answers in text only when ElevenLabs is set up; otherwise its own voice", () => {
  assert.equal(ttsConfigured(ENV), true);
  assert.equal(ttsConfigured({}), false);
  const el = sessionRequest({ env: ENV }).session;
  assert.deepEqual(el.output_modalities, ["text"]);
  assert.equal("output" in el.audio, false);
  assert.ok(el.audio.input.transcription, "it still listens and transcribes");
  assert.ok(el.tools.length > 0, "same tools");
  const own = sessionRequest({ env: {} }).session;
  assert.deepEqual(own.output_modalities, ["audio"]);
  assert.ok(own.audio.output.voice);
});
