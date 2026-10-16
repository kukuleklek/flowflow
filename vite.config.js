import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/* In dev, serve the api/*.js functions at /api/* exactly as Vercel will: the same handlers, with the server-only keys
   (LLM_*, RELAY_API_KEY, OPENAI_API_KEY for voice, TOKENOMIST_*, VOICE_* limits, and Private mode's PRIVATE_MODE,
   NEAR_INTENTS_*, INTENTS_*) read from .env.local into process.env (never into the bundle; only VITE_* reach the
   browser). A variable already in the process env wins over the file: `PRIVATE_MODE=on npx vite` turns Private on
   for that server (the handlers read process.env at each request). */
const DEV_API = ["chat", "relay-quote", "realtime-session", "tokenomist", "intents-quote", "intents-status", "news", "onchain-withdraw", "tts"];
const SERVER_ENV = (k) => k.startsWith("LLM_") || k === "RELAY_API_KEY" || k === "OPENAI_API_KEY"
  || k === "TOKENOMIST_API_KEY" || k.startsWith("TOKENOMIST_") || k.startsWith("VOICE_")
  || k === "PRIVATE_MODE" || k.startsWith("NEAR_INTENTS_") || k.startsWith("INTENTS_") || k.startsWith("AVAX_") || k.startsWith("ELEVENLABS_");

function apiInDev(env) {
  return {
    name: "flowflow-api-dev",
    configureServer(server) {
      for (const [k, v] of Object.entries(env)) if (SERVER_ENV(k) && process.env[k] == null) process.env[k] = v;
      for (const name of DEV_API) {
        server.middlewares.use(`/api/${name}`, async (req, res) => {
          try {
            const mod = await server.ssrLoadModule(`/api/${name}.js`);
            await mod.default(req, res);
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "dev_handler_failed", message: String(e?.message || e) }));
          }
        });
      }
    },
  };
}

/* VITE_TOKENOMIST (the "Analyze with Tokenomist" pill) is derived, never typed into the bundle by hand: "on" only when
   the server holds TOKENOMIST_API_KEY, so a build without the key never shows a pill whose answer would be "not
   connected". VITE_TOKENOMIST=off turns it off anyway. Dev only: VITE_TOKENOMIST=on forces the pill for a screenshot
   (its answer then shows the not-connected card). Only the flag reaches the browser, never the key. */
function tokenomistFlag(env, mode) {
  const set = String(env.VITE_TOKENOMIST || "").trim().toLowerCase();
  if (set === "off") return "off";
  if (String(env.TOKENOMIST_API_KEY || "").trim()) return "on";
  return mode === "development" && set === "on" ? "on" : "off";
}

/* VITE_EARN (Move in, Stake, Swap on the Avalanche Spot Account): ON unless an env says "off" (owner, 2026-10-15:
   "เปิดไปก่อนเลย"). The exits never waited for it. api/chat.js reads the same rule for the Agent's prompt. */
function earnFlag(env) {
  return String(env.VITE_EARN || "").trim().toLowerCase() === "off" ? "off" : "on";
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    /* Two dev servers on one checkout (5173 live, 5174 mock) must not share one prebundle cache: one rewriting it
       under the other loads two copies of React (a blank page). The mock sets VITE_CACHE_DIR. */
    ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
    plugins: [react(), apiInDev(env)],
    define: {
      "import.meta.env.VITE_TOKENOMIST": JSON.stringify(tokenomistFlag({ ...env, ...process.env }, mode)),
      "import.meta.env.VITE_EARN": JSON.stringify(earnFlag({ ...env, ...process.env })),
    },
  };
});
