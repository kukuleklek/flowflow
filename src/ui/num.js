/** Typographic minus (U+2212) for any displayed signed figure: "-$0.54" → "−$0.54", "-1.93%" → "−1.93%".
 *  Presentation only: never feed the result back into maths. */
export const minus = (s) => (s == null ? s : String(s).replace(/-(?=[$\d.])/g, "−"));
