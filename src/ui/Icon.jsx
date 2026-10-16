// A small inline icon set (stroke icons on a 24px grid, 1.75 stroke), so the app ships no icon font. The Agent is the
// FlowFlow double wave (`agent`, or AgentMark), never a glint/star "AI" glyph; Trade is two candles (`trade`).
const PATHS = {
  arrowLeft: "M19 12H5m6-6-6 6 6 6",
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  arrowDown: "M12 5v14m6-6-6 6-6-6",
  arrowUpRight: "M7 17 17 7M8 7h9v9",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 6 6 6-6 6",
  check: "M5 12.5 10 17 19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  copy: "M9 9h10v10H9zM5 15V5h10",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4 4",
  wallet: "M4 7.5A2.5 2.5 0 0 1 6.5 5H17M6.5 7.5h11.5a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 17v-7a2.5 2.5 0 0 1 2.5-2.5ZM16 13.5h1.5",
  chart: "M4 19h16M7 15l3-4 3 2 4-6",
  chat: "M5 18.5V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-3 2.5Z",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  key: "M14 10a4 4 0 1 0-3.5 4L8 16.5V19h2.5v-2h2v-2l1.5-1.5M15 8h.01",
  star: "m12 4 2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6l5.6-.6L12 4Z",
  logout: "M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  info: "M12 16v-4m0-4h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  alert: "M12 9v4m0 4h.01M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z",
  send: "M5 12h14M13 6l6 6-6 6",
  trade: "M7 3.5v3M7 16.5v4M17 3.5v5M17 15.5v5M5.95 6.5h2.1a1.2 1.2 0 0 1 1.2 1.2v7.6a1.2 1.2 0 0 1-1.2 1.2h-2.1a1.2 1.2 0 0 1-1.2-1.2V7.7a1.2 1.2 0 0 1 1.2-1.2ZM15.95 8.5h2.1a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1-1.2 1.2h-2.1a1.2 1.2 0 0 1-1.2-1.2V9.7a1.2 1.2 0 0 1 1.2-1.2Z",
  agent: "M3.5 9.5c2.8-2.8 5.7-2.8 8.5 0s5.7 2.8 8.5 0M3.5 15.5c2.8-2.8 5.7-2.8 8.5 0s5.7 2.8 8.5 0",
  expand: "M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15",
  lock: "M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11ZM8 11V7.5a4 4 0 0 1 8 0V11",
  mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4",
  shield: "M12 3.5 5 6v5.5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6l-7-2.5ZM9 12l2 2 4-4",
};

export default function Icon({ name, size = 18, className = "", strokeWidth = 1.75, title }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}

/** The Google "G", the one brand mark the sign-in card uses. */
export function GoogleMark({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function Spinner({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="ff-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
