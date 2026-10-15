import { useEffect, useRef, useState } from "react";

const CLOSE_MS = 150;

/**
 * A panel that grows from its trigger (transitions.dev 05, the kit's `.t-dropdown` without Radix): opens at scale
 * .97 → 1 over 250ms, closes to .99 over 150ms, then unmounts. Never a centred modal. Closes on Escape and on a
 * press outside, unless `busy` (a sign-in in flight must not lose its card). The open state follows a forced reflow
 * rather than an animation frame, which a background tab never delivers.
 */
export default function Popover({ open, onClose, anchor = "right", busy = false, className = "", children, label }) {
  const [render, setRender] = useState(open);
  const [phase, setPhase] = useState("closed");
  const ref = useRef(null);

  useEffect(() => {
    if (open) { setRender(true); return undefined; }
    if (!render) return undefined;
    setPhase("closing");
    const t = setTimeout(() => { setRender(false); setPhase("closed"); }, CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!render || !open) return;
    if (ref.current) void ref.current.offsetWidth;
    setPhase("open");
  }, [render, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose?.(); };
    const onDown = (e) => {
      if (busy || !ref.current) return;
      if (!ref.current.contains(e.target) && !e.target.closest?.("[data-popover-trigger]")) onClose?.();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open, busy, onClose]);

  if (!render) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-origin={anchor === "right" ? "top-right" : anchor === "center" ? "top-center" : undefined}
      className={`t-dropdown absolute top-[calc(100%+8px)] z-50 ${anchor === "right" ? "right-0" : anchor === "center" ? "left-1/2 -translate-x-1/2" : "left-0"} ${phase === "open" ? "is-open" : phase === "closing" ? "is-closing" : ""} rounded-xl bg-popover p-3 shadow-float ${className}`}
    >
      {children}
    </div>
  );
}
