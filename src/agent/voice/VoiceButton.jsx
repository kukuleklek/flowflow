// The mic in the Agent's composer, beside the send mark. FlowFlow's look: at rest a quiet mic glyph; in a call it
// becomes the ink tile of the FlowFlow mark (src/ui/Logo.jsx), and what is inside it says what the call is doing:
//   connecting  a lime arc turns around the mic
//   listening   five level bars follow your voice (the middle one lime, like the mark's top wave)
//   thinking    the mark's two waves sway (the send button's busy state)
//   speaking    the mark's two waves rise and fall with the Agent's voice
// 40px tile like the send mark, 44px hit area (ff-hit), aria-pressed while a call is on. Reduced motion: the states
// change colour and shape only, nothing moves.
//
// In a call, a hairline ring inside the tile runs down with the time left (the server's limit), amber for the last
// 20 seconds, and a tap ends it.
//
// Mount: <VoiceButton coin={coin} disabled={busy} /> inside the composer, before the send button (`disabled` only
// stops a NEW call from starting, and says why on hover; a call that is on can always be ended). <VoiceStatus /> is
// the call's popup (design review, voice 1–6): a floating white card 12px above the composer, only while a call is
// on — the same live tile on the left, the state and the time left in the middle (with the last thing heard or said
// under it), End on the right. When the call makes a card it says "Card ready: tap Confirm" and pulses the card once:
// a voice call never confirms anything. Lime stays on the tile. Both render nothing when voice is off
// (VITE_VOICE=off) or the browser can't make a call.
import { useEffect, useRef, useState } from "react";
import { useVoice, useVoiceState, voiceLevels, stopVoice } from "./useVoice.js";
import { voiceSupported } from "./session.js";
import { useChat } from "../store.js";

const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
const VOICE_ON = String(ENV.VITE_VOICE || "").toLowerCase() !== "off";

const WORDS = {
  idle: "Talk to FlowFlow",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "FlowFlow speaking",
};

const reducedMotion = () => {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/* The meter: every frame, the mic and Agent levels go into --mic / --out on the svg (no React render per frame). */
function useMeter(active, ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!active || reducedMotion()) {
      el.style.setProperty("--mic", "0");
      el.style.setProperty("--out", "0.35");
      return undefined;
    }
    let raf = 0;
    let m = 0;
    let o = 0;
    const tick = () => {
      const l = voiceLevels();
      m += (l.mic - m) * (l.mic > m ? 0.55 : 0.18);
      o += (l.out - o) * (l.out > o ? 0.55 : 0.18);
      el.style.setProperty("--mic", m.toFixed(3));
      el.style.setProperty("--out", o.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, ref]);
}

const FADE = { transition: "opacity var(--duration-quick) var(--ease-out)" };
const show = (on) => ({ ...FADE, opacity: on ? 1 : 0 });
/* An svg part that scales about its own centre. */
const SCALE = { transformBox: "fill-box", transformOrigin: "center", transition: "transform 90ms linear" };
/* Five bars, 24 units tall at full scale: a resting shape (rest) that grows with the mic level (k). */
const BARS = [
  { x: 14.5, rest: 0.34, k: 0.9 },
  { x: 22.5, rest: 0.56, k: 1.25 },
  { x: 30.5, rest: 0.8, k: 1.45, lime: true },
  { x: 38.5, rest: 0.56, k: 1.25 },
  { x: 46.5, rest: 0.34, k: 0.9 },
];

/** The last stretch of a call: the ring and the popup's clock turn amber (a notice, not lime: lime means "act"). */
export const LAST_MS = 20_000;

/* The call's time still left: { share (1 → 0), ms }, ticking once a second while a call is on. */
function useTimeLeft(on, endsAt, maxSeconds) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  if (!on || !Number.isFinite(endsAt) || !Number.isFinite(maxSeconds) || maxSeconds <= 0) return null;
  const ms = Math.max(0, endsAt - now);
  return { share: Math.max(0, Math.min(1, ms / (maxSeconds * 1000))), ms };
}

/* The tile's inside for one call state: the mic (rest, connecting), five level bars (listening), the mark's two waves
   (thinking, speaking), and the time-left ring. Drawn by the button and by the popup alike. */
function TileArt({ st, on, left, still, svg, rest = "fill-transparent group-hover:fill-muted" }) {
  return (
    <svg ref={svg} viewBox="0 0 64 64" className="block size-full" aria-hidden="true">
      {/* The tile: nothing at rest (a hover wash), the mark's ink in a call. */}
      <rect
        width="64" height="64" rx="16"
        className={on ? "fill-foreground" : rest}
        style={{ transition: "fill var(--duration-quick) var(--ease-out)" }}
      />

      {/* The time left: a hairline inside the tile's edge that runs down, amber for the last 20 seconds. */}
      {left != null ? (
        <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" fill="none" pathLength="100" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={`${(left.share * 100).toFixed(2)} 100`}
          style={{ stroke: left.ms < LAST_MS ? "rgb(var(--warning-rgb))" : "rgb(var(--background-rgb) / 0.32)", transition: "stroke-dasharray 1s linear, stroke var(--duration-quick) var(--ease-out)" }} />
      ) : null}

      {/* Rest and connecting: the mic. */}
      <g style={show(st === "idle" || st === "connecting")} fill="none" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round"
        className={st === "connecting" ? "stroke-background" : "stroke-current"}>
        <rect x="25" y="13" width="14" height="24" rx="7" />
        <path d="M17.5 30a14.5 14.5 0 0 0 29 0M32 44.5V51" />
      </g>
      {st === "connecting" ? (
        <g className={still ? undefined : "ff-spin"} style={{ transformOrigin: "32px 32px" }}>
          <circle cx="32" cy="32" r="26" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="38 200"
            style={{ stroke: "rgb(var(--brand-solid-rgb))" }} />
        </g>
      ) : null}

      {/* Listening: five bars on the mic level. */}
      <g style={show(st === "listening")}>
        {BARS.map((b) => (
          <rect key={b.x} x={b.x} y="20" width="5" height="24" rx="2.5"
            style={{ ...SCALE, fill: b.lime ? "rgb(var(--brand-solid-rgb))" : "rgb(var(--background-rgb))", transform: `scaleY(calc(${b.rest} + var(--mic, 0) * ${b.k}))` }} />
        ))}
      </g>

      {/* Thinking and speaking: the FlowFlow mark's waves. */}
      <g style={show(st === "thinking" || st === "speaking")} fill="none" strokeWidth="5" strokeLinecap="round">
        <path d="M14 26c6-6 12-6 18 0s12 6 18 0"
          style={{
            ...SCALE, stroke: "rgb(var(--brand-solid-rgb))",
            transform: st === "speaking" ? "scaleY(calc(0.7 + var(--out, 0) * 1.9))" : undefined,
            animation: st === "thinking" && !still ? "ff-sway 1200ms var(--ease-in-out) infinite" : undefined,
          }} />
        <path d="M14 40c6-6 12-6 18 0s12 6 18 0"
          style={{
            ...SCALE, stroke: "rgb(var(--background-rgb))",
            transform: st === "speaking" ? "scaleY(calc(0.7 + var(--out, 0) * 1.4))" : undefined,
            animation: st === "thinking" && !still ? "ff-sway 1200ms var(--ease-in-out) -600ms infinite" : undefined,
          }} />
      </g>
    </svg>
  );
}

export default function VoiceButton({ coin = null, disabled = false, className = "" }) {
  const v = useVoice({ coin });
  const svg = useRef(null);
  const st = v.state;
  const on = st !== "idle";
  const [still] = useState(reducedMotion);
  const left = useTimeLeft(on && st !== "connecting", v.endsAt, v.maxSeconds);
  useMeter(on, svg);
  if (!VOICE_ON || !v.supported) return null;
  /* A mic that can't start a call says why (design review, voice 5): the Agent is still answering. */
  const why = on ? "End voice" : disabled ? "Wait for FlowFlow to finish" : "Talk to FlowFlow";

  return (
    <button
      type="button"
      onClick={v.toggle}
      disabled={disabled && !on}
      aria-pressed={on}
      aria-label={why}
      title={why}
      data-state={st}
      className={`ff-press ff-hit group relative size-10 shrink-0 rounded-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 lg:size-9 ${className}`}
    >
      <TileArt st={st} on={on} left={left} still={still} svg={svg} />
      <span className="sr-only" aria-live="polite">{on ? WORDS[st] : ""}</span>
    </button>
  );
}

const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* Cards that wait for a tap: a voice call can make them, never confirm them. */
const TAP_KINDS = new Set(["open", "close", "tpsl", "stake"]);

/* One soft ink outline around a card, once (Web Animations, on the outline so the card's own ring stays; nothing when
   motion is reduced). */
function pulseCard(id) {
  if (reducedMotion() || typeof document === "undefined") return;
  let el = null;
  try { el = document.querySelector(`[data-card-id="${CSS.escape(String(id))}"] > *`); } catch { return; }
  if (!el || typeof el.animate !== "function") return;
  try {
    /* Only the chat's own scroller moves (scrollIntoView would scroll every ancestor, the page too). */
    const box = el.closest(".overflow-y-auto");
    if (box) {
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) box.scrollBy({ top: r.bottom > b.bottom ? r.bottom - b.bottom : r.top - b.top, behavior: "smooth" });
    }
    el.animate(
      [
        { outline: "0px solid rgb(9 9 11 / 0)", outlineOffset: "0px" },
        { outline: "4px solid rgb(9 9 11 / 0.14)", outlineOffset: "0px" },
        { outline: "0px solid rgb(9 9 11 / 0)", outlineOffset: "0px" },
      ],
      { duration: 900, easing: "cubic-bezier(.2,.7,.2,1)" },
    );
  } catch { /* a pulse is decoration */ }
}

/* What the call heard or said last (the newest voice line in the thread), and the newest card it made that waits for
   a tap. Both only from this call: anything older than its start is ignored. */
function useCallLines(on) {
  const { messages } = useChat();
  const since = useRef(null);
  if (on && since.current == null) since.current = Date.now();
  if (!on) since.current = null;
  const t0 = since.current;
  let line = null;
  let card = null;
  if (on && t0 != null) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || !(m.at >= t0 - 500)) break;
      if (!card && m.role === "card" && m.card && TAP_KINDS.has(m.card.kind || "open") && (m.card.status || "review") === "review") card = m;
      if (!line && m.via === "voice" && typeof m.text === "string" && m.text.trim() && !m.pending) line = m.text.trim();
      if (card && line) break;
    }
  }
  return { line, card };
}

/** The call's popup: the live tile, the state and time left (the last line heard or said under it), End. Nothing
 *  when no call is on. */
export function VoiceStatus({ className = "" }) {
  const { state, endsAt, maxSeconds } = useVoiceState();
  const on = state !== "idle";
  const svg = useRef(null);
  const [still] = useState(reducedMotion);
  const left = useTimeLeft(on && state !== "connecting", endsAt, maxSeconds);
  const { line, card } = useCallLines(on);
  const [ready, setReady] = useState(null);
  useMeter(on, svg);
  /* A new card from this call: say so for a while, and pulse it once. */
  useEffect(() => {
    if (!card) return undefined;
    setReady(card.id);
    pulseCard(card.id);
    const t = setTimeout(() => setReady((r) => (r === card.id ? null : r)), 8000);
    return () => clearTimeout(t);
  }, [card && card.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!VOICE_ON || !on || !voiceSupported()) return null;
  const last = left != null && left.ms < LAST_MS;
  const sub = ready ? "Card ready: tap Confirm" : line;
  return (
    <div role="status" className={`t-swap-in flex items-center gap-3 rounded-2xl bg-card p-2 pr-2.5 shadow-float ring-1 ring-border ${className}`}>
      <span className="size-10 shrink-0"><TileArt st={state} on left={left} still={still} svg={svg} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-sm font-medium">
          <span className="truncate">{WORDS[state] || "Voice"}</span>
          {left != null ? (
            <span className={`num shrink-0 font-mono text-[11px] ${last ? "font-medium text-warning" : "text-muted-foreground"}`}>
              {last ? `Ends in ${mmss(left.ms)}` : `${mmss(left.ms)} left`}
            </span>
          ) : null}
        </span>
        {sub ? <span className={`mt-0.5 block truncate text-xs ${ready ? "font-medium text-foreground" : "text-muted-foreground"}`}>{sub}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => stopVoice("user")}
        className="ff-press ff-hit h-8 shrink-0 rounded-full bg-card px-3 text-xs font-medium text-foreground ring-1 ring-inset ring-border transition-colors hover:bg-muted"
      >
        End
      </button>
    </div>
  );
}
