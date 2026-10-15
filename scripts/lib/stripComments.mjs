/* ════════════════════════════════════════════════════════════════════════════
   ONE comment stripper for every source guard in scripts/.
   ════════════════════════════════════════════════════════════════════════════

   🔴 IT HAD THREE COPIES AND ALL THREE WERE WRONG, IN OPPOSITE DIRECTIONS.

   1. The original dropped only lines whose FIRST character was `//`, `*` or
      `/*`. Every block comment in this codebase indents its continuation lines
      without a leading `*`, so the BODY of a block comment survived. A guard
      could then be SATISFIED by prose naming the symbol it requires — and
      FAILED by prose quoting the deleted expression it exists to ban. Both were
      observed while landing the one-book collapse.

   2. The obvious repair — strip `/* … *\/` first — is worse. `lib/tradesApi.js`
      carries the line

          // CSP: the host is `https://*.example.workers.dev`, already in …

      and `//*` CONTAINS `/*`, so the block regex opened there and ate every
      line up to the next `*\/` — including `const API = (import.meta.env
      .VITE_TRADES_API || "")`. A guard asserting that line exists then failed
      against a file that plainly contains it.

   ORDER IS THE FIX: line comments first (so a URL or a `*\/` inside one cannot
   open or close a block), then block comments. The `[^:"'\`\\]` guard keeps
   `https://` inside a string literal from being read as a comment.

   Not a parser. It does not understand `/*` inside a string literal or a regex
   — a source guard is a cheap second opinion, and the tests that actually
   decide behaviour run the code (see test-one-book.mjs).
   ══════════════════════════════════════════════════════════════════════════ */

/** Source with comments removed. Line comments first — see the note above. */
export function stripComments(source) {
  return String(source)
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")   // line comments, sparing `https://`
    .replace(/\/\*[\s\S]*?\*\//g, " ");        // block comments, including {/* … */}
}

export default stripComments;
