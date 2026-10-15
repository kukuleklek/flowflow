import { useEffect, useRef, useState } from "react";

const CLOSE_MS = 250;

/**
 * A phone sheet: the panel slides up from the bottom edge, 400ms on the sheet curve, and
 * closes in 250ms (CLOSE_MS), over a fading scrim. Reduced motion: an opacity fade. Height changes inside are the
 * caller's AutoHeight.
 *
 * The enter state is applied after a forced reflow, not on an animation frame: frames are paused in a background
 * tab, which would leave the sheet mounted and invisible.
 */
export default function Sheet({ open, onClose, label, busy = false, children }) {
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(false);
  const panel = useRef(null);

  useEffect(() => {
    if (open) { setRender(true); return undefined; }
    setShown(false);
    const t = setTimeout(() => setRender(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!render || !open) return;
    if (panel.current) void panel.current.offsetWidth;
    setShown(true);
  }, [render, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose?.(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, busy, onClose]);

  if (!render) return null;
  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={label}>
      <div
        className={`ff-scrim absolute inset-0 bg-foreground/25 ${shown ? "is-open" : ""}`}
        onClick={() => { if (!busy) onClose?.(); }}
      />
      <div ref={panel} className={`ff-sheet absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-2xl bg-card px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2 shadow-float ${shown ? "is-open" : ""}`}>
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-input" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}
