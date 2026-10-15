import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SuccessCheck } from "./kit/index.ts";
import Icon from "./Icon.jsx";

/* A tiny toast store (one visible stack, newest on top, at most 3). The motion is transitions.dev 22 with the
   kit's toast tokens: open 350ms rising 16px from scale .97 through a 2px blur, close 250ms the same way back. */

let items = [];
let seq = 0;
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const CLOSE_MS = 250;

export function toast({ title, text = null, tone = "success", ms = 3200 }) {
  const id = ++seq;
  if (import.meta.env.DEV) (globalThis.__ffToastLog ||= []).push(`${tone}: ${title}${text ? ` · ${text}` : ""}`);
  items = [{ id, title, text, tone, closing: false }, ...items].slice(0, 3);
  emit();
  setTimeout(() => dismiss(id), ms);
  return id;
}

export function dismiss(id) {
  if (!items.some((t) => t.id === id && !t.closing)) return;
  items = items.map((t) => (t.id === id ? { ...t, closing: true } : t));
  emit();
  setTimeout(() => { items = items.filter((t) => t.id !== id); emit(); }, CLOSE_MS);
}

const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const snap = () => items;

function ToastIcon({ tone }) {
  if (tone === "success") return <SuccessCheck size={20} className="text-success" />;
  if (tone === "error") return <Icon name="alert" size={18} className="text-destructive" />;
  return <Icon name="info" size={18} className="text-muted-foreground" />;
}

function ToastRow({ t }) {
  const [shown, setShown] = useState(false);
  const el = useRef(null);
  /* A forced reflow, then the open state: an animation frame never comes in a background tab. */
  useEffect(() => { if (el.current) void el.current.offsetWidth; setShown(true); }, []);
  return (
    <div
      ref={el}
      role={t.tone === "error" ? "alert" : "status"}
      className={`ff-toast pointer-events-auto flex w-full items-start gap-3 rounded-xl bg-card px-4 py-3 shadow-float ${shown && !t.closing ? "is-open" : ""} ${t.closing ? "is-closing" : ""}`}
      onClick={() => dismiss(t.id)}
    >
      <span className="mt-px shrink-0"><ToastIcon tone={t.tone} /></span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{t.title}</span>
        {t.text ? <span className="num mt-0.5 block text-xs text-muted-foreground">{t.text}</span> : null}
      </span>
    </div>
  );
}

export function ToastHost() {
  const list = useSyncExternalStore(subscribe, snap, snap);
  return (
    <div
      aria-live="polite"
      className="ff-toast-host pointer-events-none fixed inset-x-0 bottom-[calc(84px+env(safe-area-inset-bottom))] z-[80] mx-auto flex w-full max-w-sm flex-col gap-2 px-4 md:bottom-6 md:left-auto md:right-6 md:mx-0"
    >
      {list.map((t) => <ToastRow key={t.id} t={t} />)}
    </div>
  );
}
