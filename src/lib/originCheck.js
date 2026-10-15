// Which pages may spend FlowFlow's paid server keys (api/chat.js: the LLM key; api/realtime-session.js: the OpenAI
// voice key). Server-side only; pure. A browser always sends Origin on a POST, so a missing Origin (curl, a script) is
// refused too. Production, the project's preview deployments, and local dev (vite at localhost:5173 / :5174).
export const ORIGIN_OK = Object.freeze([
  /^https:\/\/flowflow-alpha\.vercel\.app$/,
  /^https:\/\/www\.flowflow-alpha\.vercel\.app$/,
  /^https:\/\/flowflow-[a-z0-9-]+-flow-flow\.vercel\.app$/,
  /^http:\/\/localhost:\d{2,5}$/,
  /^http:\/\/127\.0\.0\.1:\d{2,5}$/,
]);

/** True only for one of our own pages. No Origin, no call. */
export const paidOriginAllowed = (origin) => typeof origin === "string" && ORIGIN_OK.some((re) => re.test(origin));
