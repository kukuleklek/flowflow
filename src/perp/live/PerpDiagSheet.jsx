import { useState, useSyncExternalStore } from "react";
import { perpDiag } from "./diag.js";

/* ?perpdebug=1: a small switch, and a sheet with the trading layer's recent steps (names, codes, timings, never
   anything that can sign) and a Copy button, so a failure on a phone can be read instead of guessed at. */
export default function PerpDiagSheet() {
  const d = perpDiag();
  useSyncExternalStore(d.subscribe, d.version, d.version);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = d.text();
  return (
    <div style={{ position: "fixed", left: 12, bottom: 150, zIndex: 90, fontFamily: "var(--font-geist-mono)" }}>
      {open ? (
        <div className="w-[min(92vw,520px)] rounded-2xl border bg-card p-3 text-[11px] shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-medium">Perp diagnostics · {d.list().length}</span>
            <span className="flex gap-1.5">
              <button type="button" className="rounded-md border px-2 py-1" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* refused */ } }}>{copied ? "Copied" : "Copy"}</button>
              <button type="button" className="rounded-md border px-2 py-1" onClick={() => d.clear()}>Clear</button>
              <button type="button" className="rounded-md border px-2 py-1" onClick={() => setOpen(false)}>Close</button>
            </span>
          </div>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2">{text}</pre>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="rounded-full border bg-card px-3 py-1.5 text-[11px] shadow-lg">diag {d.list().length}</button>
      )}
    </div>
  );
}
