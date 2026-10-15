// ─────────────────────────────────────────────────────────────────────────────
// VIEW AS, localhost only: read another Perp account, read-only, to check the
// Perp pages against real numbers.
// ─────────────────────────────────────────────────────────────────────────────
//
//   http://localhost:4400/perp/BTC?perpViewAs=0x12...ab
//
// makes the account layer read THAT address instead of the connected wallet's
// (usePerpAccount.js). The backend seam builds no trader while a view is on and
// refuses every action (perp/live/usePerpBackend.js), and a fixed banner,
// "Viewing 0x12…ab (read-only)", stays on screen while any surface shows the
// viewed account's figures.
//
// NEVER ON ANOTHER HOST. The page's hostname must be exactly one of
// PERP_VIEW_AS_HOSTS, compared whole: no suffix, no substring, no pattern, so
// localhost.example.xyz or 127.0.0.1.nip.io do not qualify. On a deployed host
// the parameter is read by nothing.
//
// THE LATCH. A route change inside the app drops the query string, so the view
// is remembered for the life of this tab (module memory, no storage) once seen:
// ?perpViewAs=off, or any value that is not an address, ends it. A reload
// without the parameter starts without a view.
//
// Nothing here signs, sends or stores anything.

/** The query parameter. */
export const PERP_VIEW_AS_PARAM = "perpViewAs";

/** The only hosts a view can be turned on from. */
export const PERP_VIEW_AS_HOSTS = Object.freeze(["localhost", "127.0.0.1"]);

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** "Viewing 0x12…ab (read-only)" */
export function perpViewAsLabel(address) {
  const a = String(address).toLowerCase();
  return `Viewing ${a.slice(0, 4)}…${a.slice(-2)} (read-only)`;
}

function hostAllowed(loc) {
  const host = loc && typeof loc.hostname === "string" ? loc.hostname : "";
  return PERP_VIEW_AS_HOSTS.some((h) => h === host);
}

/* The parameter's raw value: null when it is absent. */
function paramOf(loc) {
  const search = typeof loc.search === "string" ? loc.search : "";
  try {
    return new URLSearchParams(search).get(PERP_VIEW_AS_PARAM);
  } catch {
    return null;
  }
}

/* One frozen object per address, so a view is the same value on every render. */
const VIEWS = new Map();
function viewFor(address) {
  const a = address.toLowerCase();
  let v = VIEWS.get(a);
  if (!v) {
    v = Object.freeze({ address: a, label: perpViewAsLabel(a), readOnly: true });
    VIEWS.set(a, v);
  }
  return v;
}

/**
 * The view a location asks for, with no memory: { address, label, readOnly }
 * or null. Null on every host but localhost and 127.0.0.1.
 * @param {{ hostname?: string, search?: string }|null|undefined} loc
 */
export function perpViewAsFrom(loc) {
  if (!loc || typeof loc !== "object" || !hostAllowed(loc)) return null;
  const raw = paramOf(loc);
  return isAddress(raw) ? viewFor(raw) : null;
}

/** A per-tab memory of the view (see THE LATCH). */
export function createPerpViewAsLatch() {
  let held = null;
  return {
    read(loc) {
      if (!loc || typeof loc !== "object" || !hostAllowed(loc)) return null;
      const raw = paramOf(loc);
      if (raw != null) held = isAddress(raw) ? viewFor(raw) : null;
      return held;
    },
  };
}

function currentLocation() {
  try {
    const g = globalThis;
    return g.location || (g.window && g.window.location) || null;
  } catch {
    return null;
  }
}

const TAB = createPerpViewAsLatch();

/** This tab's view, or null. */
export function perpViewAs(loc = currentLocation()) {
  return TAB.read(loc);
}

/* ── the banner ─────────────────────────────────────────────────────────── */

let bannerEl = null;
let bannerHolds = 0;

function currentDocument() {
  try {
    return typeof document === "undefined" ? null : document;
  } catch {
    return null;
  }
}

/**
 * Keep the fixed "Viewing 0x12…ab (read-only)" banner on screen. Refcounted:
 * one element however many surfaces hold it, removed when the last lets go.
 * Returns the release function. No view, or no document: nothing to draw.
 */
export function retainPerpViewAsBanner(view, doc = currentDocument()) {
  if (!view || !doc || typeof doc.createElement !== "function" || !doc.body || typeof doc.body.appendChild !== "function") {
    return () => {};
  }
  bannerHolds++;
  if (!bannerEl) {
    const el = doc.createElement("div");
    el.setAttribute("data-test", "perp-view-as");
    el.setAttribute("role", "status");
    Object.assign(el.style, {
      position: "fixed",
      top: "0",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483000",
      pointerEvents: "none",
      padding: "4px 12px",
      borderRadius: "0 0 10px 10px",
      background: "#f5a524",
      color: "#1a1300",
      font: "600 12px/1.3 system-ui, sans-serif",
      whiteSpace: "nowrap",
    });
    doc.body.appendChild(el);
    bannerEl = el;
  }
  bannerEl.textContent = view.label;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    bannerHolds--;
    if (bannerHolds > 0) return;
    bannerHolds = 0;
    const el = bannerEl;
    bannerEl = null;
    try {
      if (el && typeof el.remove === "function") el.remove();
      else if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch { /* already gone */ }
  };
}
