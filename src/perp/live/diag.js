// ─────────────────────────────────────────────────────────────────────────────
// PERP DIAGNOSTICS: the last 50 steps of the perp path, on the device, with a
// Copy button — so a failure on a phone can be READ instead of guessed at.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-22, on the enable step: "กด Activate Wallet แล้วแม่งแบบ จอดำอะ".
// Nothing on that screen said what had failed, and a phone has no console. This
// module keeps a small ring buffer of what the perp path did — enable attempts
// with their timings, the wallet type, the chain id and signatureChainId,
// Hyperliquid's own answer text, the error names a wallet threw, and any window
// error or unhandled rejection raised while a perp page is open.
//
// WHAT MAY NEVER ENTER IT: key material, signatures, full typed data. Every
// value is scrubbed before it is stored (diagScrub): an object becomes the word
// object, a string has every hex run LONGER than an address replaced, and the
// field names that carry secrets are dropped whatever they hold. The buffer is
// what the owner copies into a chat, so it is written as if it were public.
//
// It is memory only (no storage, nothing sent anywhere), it is bounded, and
// recording is cheap enough to be always on inside a Perp build. The SHEET that
// shows it opens only with ?perpdebug=1 on the URL.

/** The URL parameter that shows the sheet. */
export const PERP_DIAG_PARAM = "perpdebug";
/** How many entries the ring buffer keeps. */
export const PERP_DIAG_KEPT = 50;
/** The path prefix a window error is recorded on. */
export const PERP_DIAG_PATH = "/trade";
/** Longest value kept, in characters. */
export const PERP_DIAG_VALUE_MAX = 160;
/** Most fields kept on one entry. */
export const PERP_DIAG_FIELDS_MAX = 10;
/** What a scrubbed value is replaced with. */
export const PERP_DIAG_REDACTED = "[redacted]";

/* Any hex run LONGER than an address: a private key (64), a signature (130), a
   keccak hash (64), an encoded payload. An address (40) is kept — it is public
   and it is the first thing needed to look an account up. */
const LONG_HEX = /(?:0x)?[0-9a-fA-F]{41,}/g;

/* Field names that are dropped whatever they hold, so a future call site cannot
   put a secret in by naming it plainly. signatureChainId is the one name with
   "signature" in it that stays: it is a chain id, and it is one of the things
   the owner has to be able to read off the screen. */
const SECRET_FIELD = /priv|secret|seed|mnemonic|passphrase|entropy|typeddata|payload|signature(?!chainid)|^r$|^s$|token$/i;

/** One value, as it may be stored: a scalar, never an object, never long. */
export function diagScrub(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v !== "string") return "[object]";
  const cut = v.replace(LONG_HEX, PERP_DIAG_REDACTED);
  return cut.length > PERP_DIAG_VALUE_MAX ? `${cut.slice(0, PERP_DIAG_VALUE_MAX)}…` : cut;
}

/** { at, step, fields } — the stored shape, scrubbed. */
export function diagEntry(step, fields, at) {
  const out = {};
  let n = 0;
  if (fields && typeof fields === "object") {
    for (const k of Object.keys(fields)) {
      if (n >= PERP_DIAG_FIELDS_MAX) break;
      if (SECRET_FIELD.test(k)) continue;
      const v = diagScrub(fields[k]);
      if (v === null && fields[k] === undefined) continue;
      out[String(k).slice(0, 24)] = v;
      n++;
    }
  }
  return { at, step: String(step || "step").slice(0, 40), fields: out };
}

/**
 * A ring buffer of the last `kept` entries.
 * @param {{ kept?: number, now?: () => number }} o
 */
export function createPerpDiag({ kept = PERP_DIAG_KEPT, now = () => Date.now() } = {}) {
  const items = [];
  const fns = new Set();
  let version = 0;
  const bump = () => { version++; for (const f of [...fns]) { try { f(); } catch { /* a listener is a courtesy */ } } };
  return {
    /** Record one step. Never throws, never returns anything a caller can gate on. */
    push(step, fields) {
      try {
        items.push(diagEntry(step, fields, now()));
        while (items.length > kept) items.shift();
        bump();
      } catch { /* a diagnostic may not break the path it watches */ }
    },
    list() { return items.slice(); },
    clear() { items.length = 0; bump(); },
    subscribe(fn) { fns.add(fn); return () => { fns.delete(fn); }; },
    version: () => version,
    /** The text the Copy button puts on the clipboard. */
    text() {
      const first = items.length ? items[0].at : now();
      const head = `FlowFlow perp diag · ${new Date(first).toISOString()} · ${items.length} entries`;
      const lines = items.map((e) => {
        const secs = ((e.at - first) / 1000).toFixed(3);
        const fields = Object.keys(e.fields).map((k) => `${k}=${e.fields[k]}`).join(" ");
        return `+${secs} ${e.step}${fields ? ` ${fields}` : ""}`;
      });
      return [head, ...lines].join("\n");
    },
  };
}

/* ── the tab's one buffer ───────────────────────────────────────────────── */

let TAB = null;

/** This tab's buffer (created on first use). */
export function perpDiag() {
  if (!TAB) TAB = createPerpDiag();
  return TAB;
}

/**
 * The recorder the trading layer and the seam are handed: a plain function, so
 * nothing below the seam imports this module or can read what it holds.
 * @returns {(step: string, fields?: object) => void}
 */
export function perpDiagRecorder() {
  const d = perpDiag();
  return (step, fields) => d.push(step, fields);
}

/* ── the sheet's switch ─────────────────────────────────────────────────── */

function currentLocation() {
  try {
    const g = globalThis;
    return g.location || (g.window && g.window.location) || null;
  } catch {
    return null;
  }
}

/* Latched for the life of the tab, like the view-as switch: an in-app route
   change drops the query string, and the sheet must survive it. */
let latched = false;

/** Is the diagnostics sheet switched on for this tab? */
export function perpDiagOn(loc = currentLocation()) {
  if (!loc || typeof loc !== "object") return latched;
  let raw = null;
  try { raw = new URLSearchParams(typeof loc.search === "string" ? loc.search : "").get(PERP_DIAG_PARAM); } catch { raw = null; }
  if (raw != null) latched = raw !== "0" && raw !== "off";
  return latched;
}

/** For tests: forget the latch. */
export function resetPerpDiagLatch() {
  latched = false;
}

/** Is this path one of the perp pages? */
export function perpDiagPathOk(pathname) {
  return typeof pathname === "string" && (pathname === PERP_DIAG_PATH || pathname.startsWith(`${PERP_DIAG_PATH}/`) || pathname === "/home" || pathname.startsWith("/agent") || pathname.startsWith("/wallet"));
}

/**
 * Record a window error / unhandled rejection raised while a perp page is open.
 * Returns the remover. Nothing is recorded on any other page.
 */
export function watchPerpWindowErrors(win = typeof window === "undefined" ? null : window, diag = perpDiag()) {
  if (!win || typeof win.addEventListener !== "function") return () => {};
  const onPath = () => {
    try { return perpDiagPathOk(win.location && win.location.pathname); } catch { return false; }
  };
  const onError = (e) => {
    if (!onPath()) return;
    diag.push("window.error", { message: e && e.message, source: e && e.filename, line: e && e.lineno });
  };
  const onReject = (e) => {
    if (!onPath()) return;
    const r = e && e.reason;
    diag.push("window.unhandledrejection", {
      name: r && r.name, message: r && (typeof r === "string" ? r : r.message),
    });
  };
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onReject);
  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onReject);
  };
}

/* ── mounting the sheet, outside any page ───────────────────────────────── */

let started = false;

/**
 * With ?perpdebug=1 on the URL: start watching window errors and put a small
 * switch on screen that opens the diagnostics sheet. Called once per tab from
 * the backend seam, so no page has to carry it. Does nothing anywhere else.
 */
export function startPerpDiag() {
  if (started || !perpDiagOn()) return;
  const doc = typeof document === "undefined" ? null : document;
  if (!doc || !doc.body) return;
  started = true;
  watchPerpWindowErrors();
  const host = doc.createElement("div");
  host.setAttribute("data-test", "perp-diag-root");
  doc.body.appendChild(host);
  Promise.all([import("react-dom/client"), import("./PerpDiagSheet.jsx"), import("react")])
    .then(([client, sheet, React]) => {
      client.createRoot(host).render(React.createElement(sheet.default));
    })
    .catch(() => { /* the buffer is still there; only the sheet is missing */ });
}

export default perpDiag;
