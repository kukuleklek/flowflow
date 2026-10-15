// POST /api/chat — FlowFlow's only server code (a Vercel function; vite.config.js mounts the same handler in dev).
//
// It holds the LLM key and nothing else: no user keys, no state, no money. Only our own pages may call it (Origin
// allow-list, src/lib/originCheck.js; a missing Origin is refused too: the key is paid). It adds the system prompt and the tool
// list itself (the browser cannot replace them, so the free key cannot be borrowed as a general-purpose LLM),
// keeps only well-formed chat messages, and answers with ONE assistant message. The browser runs the tools.
//
// Providers speak the OpenAI Chat Completions format: LLM_* (primary: OpenAI gpt-5.4-mini on prod) and LLM_FALLBACK_*
// (the free Gemini chain; tried on 429 / 5xx / network). Without TOKENOMIST_API_KEY the get_unlocks tool is not offered.
// LLM_MODEL / LLM_FALLBACK_MODEL may list several models ("a,b,c"), tried in that order on the same key: free models
// are often "experiencing high demand" (503) one at a time.
import { TOOLS, HISTORY_MAX, windowHistory, toolsFor } from "../src/agent/tools.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { paidOriginAllowed } from "../src/lib/originCheck.js";
import { HARD_MAX_MARGIN_USDC, HARD_AGENT_MAX_LEVERAGE } from "../src/perp/guardrails.js";

/* The model's window: the same one the browser keeps (tools.js windowHistory), so the two cut a history alike. */
const MAX_MESSAGES = HISTORY_MAX;
/* How much of a request's history is read at all, and how many calls one step may carry: a bound on the work done
   per request, not the window (the window is cut after the repair, from what is read). */
const MAX_INPUT = 200;
const MAX_CALLS = 32;
const MAX_CHARS = 6000;
/* One user message can take up to 5 model calls (agent.js MAX_STEPS), so 60 a minute is about a dozen messages. */
export const RATE_PER_MIN = 60;
/* A request body over this is refused unread (a full window of messages of at most 6000 characters, plus signatures,
   fits well). */
export const MAX_BODY_BYTES = 1_000_000;
/* What a tool call whose answer never came back gets, so the provider accepts the conversation (agent.js says the same). */
export const INTERRUPTED_RESULT = JSON.stringify({ error: "No result: the app was interrupted." });
const TIMEOUT_MS = 20_000;
/* No new model is tried once this much of the request has gone (a serverless function has a time limit). */
const DEADLINE_MS = 40_000;
const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,80}$/;

const hits = new Map();

/** A rough per-IP limit (per warm instance), enough to keep one tab from draining a free quota. */
export function rateLimited(ip, now = Date.now()) {
  const k = ip || "unknown";
  const recent = (hits.get(k) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(k, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_PER_MIN;
}

export function providersFromEnv(env) {
  const p = (prefix) => {
    const base = String(env[`${prefix}BASE_URL`] || "").trim();
    const models = String(env[`${prefix}MODEL`] || "").split(",").map((m) => m.trim()).filter(Boolean);
    const key = String(env[`${prefix}API_KEY`] || "").trim();
    return base && key ? models.map((model) => ({ base: base.replace(/\/+$/, ""), model, key })) : [];
  };
  return [...p("LLM_"), ...p("LLM_FALLBACK_")];
}

const str = (v) => (typeof v === "string" ? v.slice(0, MAX_CHARS) : "");

/** What this server has: a Tokenomist key (get_unlocks is offered only then), and the earn entry's build flag. */
export function serverFlags(env = {}) {
  return { unlocks: !!String(env.TOKENOMIST_API_KEY || "").trim(), earnOn: String(env.VITE_EARN || "") === "on" };
}

/* FlowFlow's caps as the prompt states them: an env value may lower one, never raise it (the browser enforces the same
   ceilings in code: src/perp/guardrails.js). Voice mode (api/realtime-session.js) states the same caps from here. */
const capOf = (v, hard) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, hard) : hard;
};
export function capsFromEnv(env = {}) {
  return {
    maxMarginUsdc: capOf(env.VITE_MAX_MARGIN_USDC, HARD_MAX_MARGIN_USDC),
    maxLeverage: capOf(env.VITE_AGENT_MAX_LEVERAGE, HARD_AGENT_MAX_LEVERAGE),
    maxStakeUsdc: capOf(env.VITE_MAX_STAKE_USDC, 20),
  };
}

/* Gemini 3 signs each tool-call step (extra_content.google.thought_signature) and refuses the next round unless the
   signature comes back with the call. It is opaque base64; keep it only in that shape and size. */
const MAX_SIGNATURE = 32_000;
const SIGNATURE_RE = /^[A-Za-z0-9+/=_-]+$/;
/* Google's documented placeholder for a call it did not sign: one made by the fallback, or by another of the listed
   models (a signature belongs to the model that made it, so each tool-call step carries `model`). */
const UNSIGNED = "skip_thought_signature_validator";
const signatureOf = (c) => {
  const s = c && c.extra_content && c.extra_content.google && c.extra_content.google.thought_signature;
  return typeof s === "string" && s.length <= MAX_SIGNATURE && SIGNATURE_RE.test(s) ? s : null;
};
const withSignature = (call, sig) => (sig ? { ...call, extra_content: { google: { thought_signature: sig } } } : call);
const isGoogle = (p) => /(^|\.)googleapis\.com(\/|$)/.test(String(p.base).replace(/^https?:\/\//, ""));
const isOpenAI = (p) => /(^|\.)openai\.com(\/|$)/.test(String(p.base).replace(/^https?:\/\//, ""));

/** The request one provider accepts. OpenAI's GPT-5-era and o-series models take max_completion_tokens (not
 *  max_tokens) and only their default temperature, and on /chat/completions with function tools they accept only
 *  reasoning_effort "none" (OpenAI: "Function tools with reasoning_effort are not supported … set reasoning_effort to
 *  'none'"), which also keeps a tool step quick. Everyone else (Gemini's and Groq's OpenAI-compatible endpoints) keeps
 *  the classic fields. */
export function requestBody(p, messages, tools = TOOLS) {
  const body = { model: p.model, messages: forProvider(p, messages), tools, tool_choice: "auto" };
  if (isOpenAI(p)) {
    return /^(gpt-5|gpt-6|o\d)/.test(p.model)
      ? { ...body, max_completion_tokens: 2000, reasoning_effort: "none" }
      : { ...body, max_completion_tokens: 2000, temperature: 0.3 };
  }
  return { ...body, temperature: 0.3, max_tokens: 800 };
}

/** The messages as one provider accepts them: Google gets every tool-call step signed by itself or by the
 *  placeholder, others get no extra fields; the `model` tag never leaves this server. */
export function forProvider(p, messages) {
  const google = isGoogle(p);
  return messages.map(({ model, ...m }) => {
    if (m.role !== "assistant" || !m.tool_calls) return m;
    const bare = m.tool_calls.map(({ extra_content, ...c }) => c);
    if (!google) return { ...m, tool_calls: bare };
    if ((!model || model === p.model) && m.tool_calls.some((c) => signatureOf(c))) return m;
    return { ...m, tool_calls: bare.map((c, i) => (i === 0 ? withSignature(c, UNSIGNED) : c)) };
  });
}

/**
 * Only user / assistant / tool messages in the shapes the providers accept; everything else is dropped. Then the
 * history is REPAIRED, because a conversation the browser lost a step of (a closed tab, an account switch, a tool
 * that threw) must not make every later turn fail:
 *   • it starts at a user message (a cut never leaves an assistant step or a tool result first);
 *   • every assistant tool call is followed by exactly one result for it, in the call's order: the browser's own when
 *     it sent one (even if it landed later), INTERRUPTED_RESULT when it did not;
 *   • a tool result with no call before it is dropped.
 * Then it is cut to the window (tools.js windowHistory) at step boundaries. A turn longer than the window (one
 * question, several steps of parallel reads) keeps its question and its latest steps: it is never cut to nothing.
 */
export function cleanMessages(input) {
  return windowHistory(repairHistory(shapeMessages(input)), MAX_MESSAGES);
}

function shapeMessages(input) {
  const list = Array.isArray(input) ? input.slice(-MAX_INPUT) : [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") out.push({ role: "user", content: str(m.content) });
    else if (m.role === "assistant") {
      const calls = Array.isArray(m.tool_calls)
        ? m.tool_calls
          .filter((c) => c && c.type === "function" && c.function && TOOL_NAMES.has(c.function.name) && typeof c.id === "string")
          .slice(0, MAX_CALLS)
          .map((c) => withSignature({ id: c.id.slice(0, 80), type: "function", function: { name: c.function.name, arguments: str(c.function.arguments) || "{}" } }, signatureOf(c)))
        : [];
      const model = typeof m.model === "string" && MODEL_RE.test(m.model) ? { model: m.model } : {};
      out.push(calls.length ? { role: "assistant", content: str(m.content) || "", tool_calls: calls, ...model } : { role: "assistant", content: str(m.content) });
    } else if (m.role === "tool" && typeof m.tool_call_id === "string") {
      out.push({ role: "tool", tool_call_id: m.tool_call_id.slice(0, 80), content: str(m.content) });
    }
  }
  return out;
}

function repairHistory(list) {
  /* A conversation cut by the window starts at its first user message. */
  const start = list.findIndex((m) => m.role === "user");
  if (start < 0) return [];
  const msgs = list.slice(start);
  const used = new Set();
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool") continue; /* placed with its call below, or an orphan */
    if (m.role !== "assistant" || !m.tool_calls) { out.push(m); continue; }
    /* One result per call id, and one call per id. */
    const seen = new Set();
    const calls = m.tool_calls.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    out.push(calls.length === m.tool_calls.length ? m : { ...m, tool_calls: calls });
    for (const c of calls) {
      /* Its result: the first unused one for this id before the next assistant step. */
      let found = null;
      for (let j = i + 1; j < msgs.length && msgs[j].role !== "assistant"; j++) {
        if (msgs[j].role === "tool" && !used.has(j) && msgs[j].tool_call_id === c.id) { found = j; break; }
      }
      if (found != null) { used.add(found); out.push(msgs[found]); }
      else out.push({ role: "tool", tool_call_id: c.id, content: INTERRUPTED_RESULT });
    }
  }
  return out;
}

async function callProvider(p, messages, fetchImpl, tools = TOOLS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify(requestBody(p, messages, tools)),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, retry: r.status === 429 || r.status >= 500, reason: text.slice(0, 200) };
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, status: 502, retry: true, reason: "bad JSON from provider" }; }
    const msg = json && json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) return { ok: false, status: 502, retry: true, reason: "no message from provider" };
    const calls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.filter((c) => c && c.function && TOOL_NAMES.has(c.function.name)).map((c, i) => withSignature({
        id: typeof c.id === "string" && c.id ? c.id : `call_${Date.now()}_${i}`,
        type: "function",
        function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments || {}) },
      }, signatureOf(c)))
      : [];
    return { ok: true, message: { role: "assistant", content: typeof msg.content === "string" ? msg.content : "", ...(calls.length ? { tool_calls: calls, model: p.model } : {}) } };
  } catch (e) {
    return { ok: false, status: 504, retry: true, reason: e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * The whole exchange, without HTTP: tests call this directly.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function chatOnce({ messages, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const providers = providersFromEnv(env);
  if (!providers.length) return { status: 503, body: { error: "not_configured", message: "The Agent's model is not configured on this server." } };
  const clean = cleanMessages(messages);
  if (!clean.length || clean[clean.length - 1].role === "assistant") return { status: 400, body: { error: "bad_request", message: "Nothing to answer." } };
  const flags = serverFlags(env);
  const tools = toolsFor({ unlocks: flags.unlocks });
  const full = [{ role: "system", content: systemPrompt({ ...capsFromEnv(env), unlocks: flags.unlocks, earnOn: flags.earnOn, now }) }, ...clean];
  let last = null;
  const started = Date.now();
  for (let i = 0; i < providers.length; i++) {
    if (i > 0 && Date.now() - started > DEADLINE_MS) break;
    const r = await callProvider(providers[i], full, fetchImpl, tools);
    if (r.ok) return { status: 200, body: { message: r.message, provider: i === 0 ? "primary" : "fallback", model: providers[i].model } };
    last = r;
    if (!r.retry) break;
  }
  /* 429 is a quota, 503 is Google's "high demand": both mean "busy, try again", not "broken". */
  const busy = last && (last.status === 429 || last.status === 503);
  return { status: busy ? 429 : 502, body: { error: busy ? "busy" : "upstream_failed", message: busy ? "The free model is busy. Try again in a moment." : "The model didn't answer.", detail: last ? last.reason : null } };
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (req.body.length > MAX_BODY_BYTES) return null;
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/* Our own pages only (the model key is paid): another site, or no Origin at all (curl, a script), is refused before
   anything is read or billed. */
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  if (!paidOriginAllowed(req.headers && req.headers.origin)) return send(res, 403, { error: "forbidden" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, 429, { error: "rate_limited", message: "Too many messages. Wait a minute." });
  const body = await readJson(req);
  if (!body) return send(res, 400, { error: "bad_request" });
  const out = await chatOnce({ messages: body.messages });
  return send(res, out.status, out.body);
}
