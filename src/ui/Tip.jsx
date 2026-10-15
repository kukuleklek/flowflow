import { useEffect, useId, useRef, useState } from "react";
import Icon from "./Icon.jsx";

const CLOSE_MS = 150;

/**
 * A Tip: the words a screen would otherwise print in full, folded behind a small ⓘ. Owner, on the redesign mocks:
 * "แอบ AI เกินไปนิดนึง ควรจะเป็นแบบว่า Tips เล็ก แล้วกดแล้ว พวกคำพูด… ออกมา" — sentences of explanation read as
 * generated; a quiet mark that opens them on a press does not.
 *
 * One press opens the words in a small bubble that grows out of the mark (the kit's `.t-dropdown`, origin at the
 * mark); a press outside, Escape, or the mark again closes it. The open state follows a forced reflow, as Popover's
 * does, because a background tab never delivers an animation frame.
 *
 * 🔴 NOT FOR MONEY WARNINGS. "Send only USDC on Base", a deposit floor below which money is lost, an error: those stay
 * printed. A Tip is for explanations (how it works, what a figure means), never for what can lose money.
 *
 *   label     optional 1–2 words beside the mark ("Mock", "Fee", "How it works"); without one the mark stands alone
 *   children  the words
 *   align     where the bubble sits under the mark: "center" (default) | "start" | "end" (use start/end near a screen edge)
 *   title     the accessible name when there is no label
 */
export default function Tip({ label = null, children, align = "center", title = "More info", className = "" }) {
  const [open, setOpen] = useState(false);
  const [render, setRender] = useState(false);
  const [phase, setPhase] = useState("closed");
  const box = useRef(null);
  const bubble = useRef(null);
  const id = useId();

  useEffect(() => {
    if (open) { setRender(true); return undefined; }
    if (!render) return undefined;
    setPhase("closing");
    const t = setTimeout(() => { setRender(false); setPhase("closed"); }, CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!render || !open) return;
    if (bubble.current) void bubble.current.offsetWidth;
    setPhase("open");
  }, [render, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open]);

  /* The placing wrapper carries the translate; the animated bubble inside carries only the kit's scale, so the two
     transforms never overwrite each other. */
  const place = align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2";
  const origin = align === "start" ? "top-left" : align === "end" ? "top-right" : "top-center";

  return (
    <span ref={box} className={`relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={render ? id : undefined}
        aria-label={label ? undefined : title}
        className="ff-hit ff-press inline-flex items-center gap-1 rounded-full text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name="info" size={14} />
        {label ? <span>{label}</span> : null}
      </button>
      {render ? (
        <span className={`absolute top-[calc(100%+6px)] z-50 ${place}`}>
          <span
            ref={bubble}
            id={id}
            role="note"
            data-origin={origin}
            className={`t-dropdown block w-max max-w-[min(260px,calc(100vw-32px))] rounded-lg border bg-popover px-3 py-2 text-left text-xs leading-relaxed text-foreground shadow-float ${phase === "open" ? "is-open" : phase === "closing" ? "is-closing" : ""}`}
          >
            {children}
          </span>
        </span>
      ) : null}
    </span>
  );
}
