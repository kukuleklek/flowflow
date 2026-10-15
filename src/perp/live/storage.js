// The page's storage for small per-browser picks (the ticket's leverage per
// market), or null when the browser refuses it (private mode, blocked site
// data, a sandboxed frame). Reaching for it can itself throw. Nothing that must
// persist reliably, or that is money, is kept here.

export function perpStorage() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === "function" && typeof s.setItem === "function" ? s : null;
  } catch {
    return null;
  }
}
