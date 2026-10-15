// FlowFlow number/format helpers — terminal-grade, tabular, compact.

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* ════════════════════════════════════════════════════════════════════════════
   🔴 `Number(null) === 0`, AND THAT IS THE WHOLE BUG.
   ----------------------------------------------------------------------------
   Ten of this module's fourteen exports guarded only on `Number.isFinite`, so an
   UNKNOWN arrived as a confident zero. Measured by probing the live module:

       fmtUsd(null)        "$0"          fmtNum(null)          "0"
       fmtPct(null)        "+0.00%"      fmtPrice(null)        "0"
       fmtUsdPrice(null)   "$0"          fmtUsdPriceFull(null) "$0"
       fmtPriceFull(null)  "0"           fmtUsdPrice(-1.5)     "$0"   ← every
                                          negative, because its guard was `+v > 0`

   `fmtCompact`, `fmtPnl`, `fmtRoi` and `fmtUsdHero` already carried the
   `n == null ⇒ DASH` rule — the module knew the rule and applied it to four of
   its fourteen. It applies to all of them now, so §0 cannot be lost by picking
   the wrong formatter. `0` still prints "$0": a MEASURED zero is a number.
   ════════════════════════════════════════════════════════════════════════════ */

/** Is this an unknown rather than a quantity? Null, undefined, "" and NaN. */
const unknown = (n) => n == null || n === "" || !Number.isFinite(Number(n));

/** Compact USD: $1.2K / $3.4M / $920. `null` ⇒ "—", never "$0". */
/**
 * @param full  render the WHOLE number instead of K/M/B (owner, 2026-08-23:
 *              "หน้า Portflio ในคอมอะ ในคอมอยากได้แบบเลขเต็ม").
 *              Compacting is a NARROW-SCREEN answer: "$1.1K" fits a 375px row
 *              and loses $49 doing it. A desktop portfolio has the width to say
 *              $1,149.32 and a page about your own money should. Opt-in per call
 *              site rather than a breakpoint read inside a pure formatter — this
 *              function must stay a function of its arguments.
 */
export function fmtUsd(n, { dp, full = false } = {}) {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (full && a >= 1) {
    return `$${v.toLocaleString("en-US", { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 })}`;
  }
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1)   return `$${v.toFixed(dp ?? 2)}`;
  if (a === 0)  return "$0";
  if (a < 0.01) return "<$0.01";
  return `$${v.toFixed(3)}`;
}

/** Compact plain number: 1.2K / 3.4M. `null` ⇒ "—", never "0". */
export function fmtNum(n) {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Token / price value with sub-penny "leading-zero subscript" like GMGN:
 * 0.0₅1524 for 0.000001524. Returns a JSX-free string using unicode subscripts.
 *
 * NOT the price-QUOTING formatter any more — fmtUsdMicroPrice is, on every
 * surface that states a price (docs/MOBILE_DESIGN_SYSTEM.md §1.5). This stays for
 * the rows, tapes and quantities that already call it, and it quotes the SAME
 * number: below $1 it delegates outright, and above $1 it keeps four decimals
 * where the quoting formatter keeps four significant digits — more precision,
 * never a different value.
 */
export function fmtPrice(n) {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "0";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1)    return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  /* Below $1 this IS fmtMicroPrice: same four significant digits, same zero
     threshold, same subscript alphabet. It used to keep its own copy of all
     three, and the copy TRUNCATED (`toFixed(18)` then `slice(0, 4)`) where the
     shared one ROUNDS — so 0.00012349 read $0.0001234 on the desktop rail and
     $0.0001235 in the token header beside it. The same figure, two values, which
     is the pair class §1 names. One rounding rule, one alphabet, one home; the
     two spellings may differ, what they say the number is may not. */
  return fmtMicroPrice(v);
}

/** USD price of a token — keeps sub-cent precision via subscript (never "<$0.01").
 *  Use for PRICES; use fmtUsd for volumes / trade values. */
export const fmtUsdPrice = (v) =>
  (unknown(v) ? "—" : +v > 0 ? "$" + fmtPrice(v) : +v === 0 ? "$0" : "-$" + fmtPrice(Math.abs(+v)));

/**
 * fmtPriceFull — the SAME number as fmtPrice, written out in full.
 * docs/MOBILE_DESIGN_SYSTEM.md §1.5: "full precision, no subscript-zero notation
 * on mobile" → `$0.00000663`, never `$0.0₅3146`.
 *
 * The subscript form is a desktop-terminal shorthand. It packs a 12-character
 * number into 8 by asking the reader to decode a glyph, and the glyph itself is
 * rendered at roughly 60% of its host — at our 15px row scale that is 9px of
 * ink, under our own type floor, on the one character that carries the
 * magnitude. On a phone the zeros are cheaper than the decoding.
 *
 * Four significant figures, the same cut fmtPrice takes, so the two helpers
 * agree about what the number IS and differ only in how it is spelled. It lives
 * here, beside fmtPrice, rather than in a mobile-local helper: a second home for
 * the rounding rule is how two surfaces end up quoting two different prices.
 */
export function fmtPriceFull(n) {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "0";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1000) return sign + a.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1) return sign + a.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  /* `0.` + every leading zero + four significant digits, trailing zeros cut —
     ROUNDED through the shared primitive rather than truncated, so this and
     fmtMicroPrice cannot say the number is two different things. */
  const { int, frac } = decimalParts(a, PRICE_SIG);
  if (int !== "0") return sign + int;                 // 0.99999 carried up to 1
  const cut = frac.replace(/0+$/, "");
  return cut ? `${sign}0.${cut}` : "0";
}

/** USD price written out in full — the mobile counterpart of fmtUsdPrice. */
export const fmtUsdPriceFull = (v) =>
  (unknown(v) ? "—" : +v > 0 ? "$" + fmtPriceFull(v) : +v === 0 ? "$0" : "-$" + fmtPriceFull(Math.abs(+v)));

/* ════════════════════════════════════════════════════════════════════════════
   THE MICRO-CAP PRICE FORMATTER — ONE SPELLING FOR EVERY SURFACE.
   ----------------------------------------------------------------------------
   Measured on one screen, one coin, one second:

       chart price scale   ChartPanel axisLabel      "$5.9e-6"
       chart OHLC legend   the same axisLabel        "$5.9e-6"
       mobile live pill    fmtCompact -> fmtPrice    "$0.0(5)5861"
       token header        fmtUsdPriceFull           "$0.000005861"

   docs/MONEY_RULES.md §1 names that pair — a chart's latest USD price against
   the token header — as two surfaces that must be INCAPABLE of disagreeing, so
   the answer is one function every one of them calls, not four that agree on a
   good day. fmtPrice / fmtPriceFull stay for the surfaces that already use them
   (rows, tapes, quantities); a PRICE goes through here.

   THE SUBSCRIPT GLYPHS ARE NOT IN OUR FONT, AND THAT IS FINE — MEASURED, NOT
   ASSUMED. public/fonts/geist.woff2 is a 29,288-byte subset carrying 225
   codepoints; its cmap (two format-4 subtables) covers U+0024 and U+2014 and
   does NOT cover U+2080-U+2089. So every subscript here is drawn by the next
   face in --p-font-num. Rendered in Chrome at 40px through the real stack, the
   glyph is a true subscript and not a missing-glyph box: 141 ink px in an 11x15
   box sitting BELOW the baseline, against 352 ink px in a 20x29 box for the
   ASCII digit beside it, where a codepoint no font carries (U+E0A7) draws a
   460-ink-px 28x26 rectangle instead. Canvas measureText at the chart's own
   sizes: "$0.0(5)5861" is 51.7px at 11px and 60.9px at 13px, against 77.4px and
   91.5px for the same number written out — which is why the mobile live pill
   cannot spell it out at all, since RIGHT_GUTTER (ChartPanel) is 79px.
   ════════════════════════════════════════════════════════════════════════════ */

const SUB_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n) => String(n).split("").map((d) => SUB_DIGITS[+d]).join("");

/** Significant digits a price is quoted to. */
export const PRICE_SIG = 4;
/** Leading zeros after the decimal point at which the subscript takes over. */
export const PRICE_SUB_FROM = 4;

const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/* |a| split into plain decimal parts at `sig` significant digits. It goes
   through toExponential ON PURPOSE: that is the only rounding primitive that
   is exact at 1e-12, and reading the exponent back is what lets this emit a
   plain decimal at every magnitude instead of falling out as e-notation. */
function decimalParts(a, sig) {
  /* toExponential accepts 0..100 fraction digits and throws a RangeError past
     that, which |v| >= 1e99 reached through the >=$1 branch below. A price that
     large is nonsense, but a formatter that THROWS inside render is worse than
     one that prints the nonsense: every other export here returns a string. */
  const digitsAfter = clamp(sig - 1, 0, 100);
  const [mant, ex] = a.toExponential(digitsAfter).split("e");
  const exp = Number(ex);
  const digits = mant.replace(".", "");
  if (exp < 0) return { int: "0", frac: "0".repeat(-exp - 1) + digits };
  if (exp + 1 >= digits.length) return { int: digits + "0".repeat(exp + 1 - digits.length), frac: "" };
  return { int: digits.slice(0, exp + 1), frac: digits.slice(exp + 1) };
}

/**
 * fmtMicroPrice — a price at four significant digits, with the leading zeros of
 * a sub-cent price folded into a subscript count once there are four or more.
 * `0.000005861` reads `0.0₅5861`; `0.0001234` keeps its zeros, because three of
 * them are still cheaper to read than a glyph. Never e-notation, at any
 * magnitude. Unknown is a dash (§0); a MEASURED zero is a number.
 *
 * Above $1 the money conventions outrank the significant-digit count: cents are
 * never dropped below $1,000 and whole dollars are never rounded away, so
 * $123.46 stays $123.46 rather than becoming $123.5.
 */
export function fmtMicroPrice(n) {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  const intDigits = a >= 1 ? Math.floor(Math.log10(a)) + 1 : 0;
  /* Past 1e21 a double has no digits left to round to — Number#toString itself
     gives up and switches to e-notation there — so the shortest decimal that
     round-trips, with the exponent written out, IS the number. This is also what
     keeps the call below off toExponential's 100-digit ceiling, which made
     |v| >= 1e99 throw a RangeError inside render: a token header formats an
     indexer-derived price with no try/catch, so a throw here blanks the header
     rather than printing the nonsense. */
  if (a >= 1e21) return sign + group(plainDecimal(a).split(".")[0]);
  const { int, frac } = decimalParts(a, a >= 1 ? Math.max(PRICE_SIG, intDigits + 2) : PRICE_SIG);
  const cut = frac.replace(/0+$/, "");
  /* Money convention outranks the digit count above $1: below $1,000 the cents
     column is ALWAYS drawn, so a scale of dollar figures cannot come out ragged
     ($123.5 stacked over $123.46) and $5.80 is never $5.8. The old axis drew
     toFixed(2) here and the docblock above promises it. */
  if (int !== "0") return sign + group(int) + (a < 1000 ? "." + cut.padEnd(2, "0") : cut ? "." + cut : "");
  const zeros = (/^0*/.exec(cut) || [""])[0].length;
  if (zeros >= PRICE_SUB_FROM) return `${sign}0.0${subscript(zeros)}${cut.slice(zeros)}`;
  return `${sign}0.${cut}`;
}

/** USD price, the one every price surface quotes. `null` ⇒ "—", never "$0". */
export const fmtUsdMicroPrice = (v) =>
  (unknown(v) ? "—" : +v === 0 ? "$0" : +v > 0 ? "$" + fmtMicroPrice(v) : "-$" + fmtMicroPrice(Math.abs(+v)));

/* The shortest decimal that round-trips, with any e-notation expanded. */
function plainDecimal(a) {
  const s = String(a);
  if (!/e/i.test(s)) return s;
  const [mant, ex] = s.split("e");
  const exp = Number(ex);
  const digits = mant.replace(".", "");
  if (exp < 0) return "0." + "0".repeat(-exp - 1) + digits;
  if (exp + 1 >= digits.length) return digits + "0".repeat(exp + 1 - digits.length);
  return digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
}

/**
 * fmtPriceExact — every digit the number actually has, for the title/tooltip
 * behind a compacted price. The compact form asks the reader to decode a glyph;
 * this is the escape hatch that means they never have to trust it.
 */
export function fmtPriceExact(n) {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const [int, frac = ""] = plainDecimal(Math.abs(v)).split(".");
  return (v < 0 ? "-" : "") + group(int) + (frac ? "." + frac : "");
}

/** USD price written out in full, for a title/tooltip. */
export const fmtUsdPriceExact = (v) =>
  (unknown(v) ? "—" : +v === 0 ? "$0" : +v > 0 ? "$" + fmtPriceExact(v) : "-$" + fmtPriceExact(Math.abs(+v)));

/**
 * priceTickStep — the tick step fmtMicroPrice implies: the smallest difference
 * the LABEL can show at this magnitude. Anything finer produces two tick marks
 * that print the same string.
 *
 * 🔴 `base` IS RETURNED, AND IT IS NOT DECORATION. lightweight-charts derives
 * `base = priceFormat.base ?? 1 / priceFormat.minMove` and then factorises it
 * (dist/lightweight-charts.development.mjs ~4246); a base that is not a decimal
 * power of ten and not a product of 2s and 5s makes its PriceTickSpanCalculator
 * constructor `throw new Error("unexpected base")`. ChartPanel used to pass
 * `Math.pow(10, -5)`, which is 0.000009999999999999999, so 1/minMove came out
 * as 100000.00000000001 and every coin priced between $0.01 and $1 threw inside
 * applyOptions — silently, into ChartPanel's catch, leaving that whole decade of
 * prices on the library's default labels. Returning an exact integer power of
 * ten and letting `minMove` be its reciprocal closes that off by construction.
 */
export function priceTickStep(v) {
  const a = Math.abs(Number(v));
  const decade = Number.isFinite(a) && a > 0 ? Math.floor(Math.log10(a)) : -6;
  const k = clamp(PRICE_SIG - 1 - decade, 2, 12);
  const base = Math.pow(10, k);
  return { minMove: 1 / base, base };
}

// Below this a signed USD figure is FLAT at display precision, so it must be
// rendered neutral and unsigned: "-<$0.01" claims a direction the number does not
// support, and "+<$0.01" next to "-<$0.01" invents a ranking out of rounding.
export const FLAT_USD = 0.01;

/**
 * signedUsdParts(v) → { text, flat, up } — the FORMATTING facts about a signed
 * USD amount, with no styling opinion, so every surface that shows PnL words it
 * identically. Callers map `flat`/`up` onto their own tone classes.
 *
 * This lives here because it was duplicated: the /leaderboard trader rows applied
 * the flat rule while the rail and the Copy-Vault cards did not, so the SAME
 * vault read "$0.00" on one surface and "-<$0.01" on the other. One rule, one
 * home.
 */
export function signedUsdParts(v, { full = false } = {}) {
  if (unknown(v)) return { text: DASH, flat: true, up: true };
  if (v == null || !Number.isFinite(Number(v))) return { text: "—", flat: true, up: true };
  const n = Number(v);
  /* 🔴 EXACT ZERO AND SUB-CENT ARE DIFFERENT NUMBERS. Returning "$0.00" for
     both put four "$0.00" cards in the Top trades strip of a wallet whose best
     trades are each worth a fraction of a cent — §0, and it reads as a broken
     page. fmtUsd already says "<$0.01"; these three call sites simply did not.
     The no-sign rule survives: "<$0.01" claims no direction either. */
  if (n === 0) return { text: "$0.00", flat: true, up: true };
  if (Math.abs(n) < FLAT_USD) return { text: "<$0.01", flat: true, up: n >= 0 };
  return { text: `${n >= 0 ? "+" : "-"}${fmtUsd(Math.abs(n), { full })}`, flat: false, up: n >= 0 };
}

export const fmtPct = (n, dp = 2) => {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
};

// Past this, an ROI figure carries no information: it means the cost basis was
// dust, not that the trade was good. The board really does serve rows like
// +2,927,412% off a dust-sized buy — printing that verbatim reads as a data bug
// and drowns every honest number next to it, so it is shown as a BOUND instead.
export const ROI_CAP = 9999;

/** ROI% for display. `null` (no cost basis in the window) → "—"; anything past
 *  ±ROI_CAP → the bound, not the meaningless exact figure. */
export const fmtRoi = (n) => {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (v > ROI_CAP) return ">+9,999%";
  if (v < -ROI_CAP) return "<-9,999%";
  return fmtPct(v);
};

export const short = (a = "", head = 4, tail = 4) =>
  a && a.length > head + tail + 2 ? `${a.slice(0, head + 2)}…${a.slice(-tail)}` : a;

export function ago(ts) {
  // 🔴 `Math.max(0, …)` TURNS AN UNREADABLE TIMESTAMP INTO "0s" — "traded 0s
  // ago" over a row whose time nobody knows, which is §0 in a different unit.
  // Found by test-one-book driving every export of this module over the
  // non-numeric inputs; `ago(Infinity)` returned "0s".
  if (ts == null || ts === "" || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const signColor = (v) => (Number(v) >= 0 ? "var(--p-pos)" : "var(--p-neg)");

/* ════════════════════════════════════════════════════════════════════════════
   MOBILE FORMATTING HELPERS  (docs/MOBILE_DESIGN_SYSTEM.md §1.5)
   These live HERE, next to fmtPrice / fmtPct / ago, rather than in a second
   lib/fmt.js — a parallel module would fork the rules the whole app already
   shares and we would be back to two surfaces wording the same number two ways.
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * fmtCompact — abbreviated USD for MC / volume / TVL: `$32.7M`, `$1.6K`, `$920`.
 * One significant decimal on the abbreviated tiers (fmtUsd uses two, which reads
 * as false precision at row scale), trailing `.0` dropped. The unit that follows
 * ("MC") is the caller's, rendered in --p-ink-2.
 */
export function fmtCompact(n) {
  if (unknown(n)) return "—";
  // `Number(null)` is 0, so an unguarded null renders "$0" — a market cap the
  // token does not have, printed with the same confidence as one it does. A
  // value we do not know is "—", never a zero that never moves.
  const v = Number(n);
  if (n == null || n === "" || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  const trim = (x) => x.toFixed(1).replace(/\.0$/, "");
  if (a >= 1e9) return `${sign}$${trim(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${trim(a / 1e3)}K`;
  if (a === 0) return "$0";
  if (a >= 1) return `${sign}$${a.toFixed(2).replace(/\.00$/, "")}`;
  return `${sign}$${fmtPrice(a)}`;
}

/**
 * fmtPnl — a P&L figure is NEVER abbreviated. `+$182,531.22`, `-$4.20`, `$0.00`.
 * Comma-grouped, always to the cent, always signed except at the flat boundary
 * (below one cent a sign claims a direction the number cannot support — the same
 * rule signedUsdParts already enforces).
 */
export function fmtPnl(n) {
  if (unknown(n)) return "—";
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return "—";
  /* 🔴 A MEASURED ZERO AND A SUB-CENT AMOUNT ARE NOT THE SAME NUMBER. This line
     used to return "$0.00" for both, which put four "$0.00" cards in the Top
     trades strip of a wallet whose best trades are all worth a fraction of a
     cent — a §0 fabrication that reads as a broken page. fmtUsd already had the
     right answer ("<$0.01"); fmtPnl simply did not use it. The no-sign rule the
     docblock argues for is about DIRECTION and survives intact: "<$0.01" claims
     no direction either. */
  if (v === 0) return "$0.00";
  if (Math.abs(v) < FLAT_USD) return "<$0.01";
  const body = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v >= 0 ? "+" : "-"}$${body}`;
}

/**
 * fmtUsdHero — the WALLET-BALANCE shape. `$1,200.00`, `$0.00`, `$1.2M`, `—`.
 *
 * Full notation up to $100K, abbreviated above it. It exists because a wallet
 * balance is rendered by more than one surface — the mobile home hero, the
 * /portfolio hero, and the header's "My balance" box — and `fmtUsd` compacts at
 * $1.2K while the hero prints $1,200.00. Measured on the owner's wallet shape
 * ($1,200 USDT, no native gas token) with the two surfaces mounted together:
 *
 *     header box   $1.2K
 *     home hero    $1,200.00
 *
 * One figure, from one hook, in two shapes — which reads as two numbers, the
 * same confusion MONEY_RULES §1 is about. Balance surfaces share this.
 */
export const fmtUsdHero = (v) =>
  (v == null ? "—" : Math.abs(v) >= 1e5 ? fmtCompact(v) : fmtPnl(v).replace(/^\+/, ""));

/** Solid direction glyphs. A chevron or an arrow reads as a control, not a value. */
export const UP_GLYPH = "▲";   // ▲
export const DOWN_GLYPH = "▼"; // ▼

/** fmtPctGlyph — `▲ 16.15%` / `▼ 1.44%`. Two decimals, never a sign character. */
export function fmtPctGlyph(n, dp = 2) {
  // 🔴 `Number("") === 0`, so an empty string rendered "▲ 0.00%" — a confident
  // flat move wearing an UP arrow, for a change nobody measured. The glyph makes
  // it worse than the bare number: direction carried by an icon is a sign no
  // source regex can see. Same class as the ten formatters at the top of this
  // file; found by test-one-book driving EVERY export over non-numeric inputs.
  if (unknown(n)) return "—";
  const v = Number(n);
  return `${v >= 0 ? UP_GLYPH : DOWN_GLYPH} ${Math.abs(v).toFixed(dp)}%`;
}

/** fmtAgo — compact relative time (`6s`, `1m`, `13h`). Thin wrapper over `ago`. */
export const fmtAgo = (ts) => ago(ts);

/**
 * splitMoney("$1,234.56") → { int: "$1,234", frac: ".56", suffix: "" }
 *            "$32.7M"     → { int: "$32",    frac: ".7",  suffix: "M" }
 *            "$1,234"     → { int: "$1,234", frac: "",    suffix: "" }
 *
 * The two-tone hero number: the integer carries the value, the fraction is noise
 * at 40px. <Money> renders `int` at --p-ink, `frac` at --p-ink-4, and `suffix`
 * back at --p-ink — a dimmed "M" would cost the reader the magnitude, which is
 * the one thing the figure is for.
 *
 * Splits on the LAST "." only. Everything here is formatted en-US (USD-only
 * display), so "," is always a thousands separator and must never be dimmed.
 */
export function splitMoney(str) {
  const s = String(str ?? "");
  const i = s.lastIndexOf(".");
  if (i < 0) return { int: s, frac: "", suffix: "" };
  const rest = s.slice(i);
  const m = rest.match(/^(\.\d+)(.*)$/);
  if (!m) return { int: s, frac: "", suffix: "" };
  return { int: s.slice(0, i), frac: m[1], suffix: m[2] };
}

/** Deterministic 2-stop gradient from a seed (token avatar fallback). */
export function seedGradient(seed = "") {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 88 + (h % 70)) % 360;
  return `linear-gradient(135deg, hsl(${a} 68% 46%), hsl(${b} 70% 36%))`;
}

/* ════════════════════════════════════════════════════════════════════════════
   THE DASH — the one place a withheld figure becomes text
   ----------------------------------------------------------------------------
   Owner, 2026-08-19: *"เราไม่ต้องทำป้ายเตือนห่าอะไรเลยนะ รก เอาออกให้หมดเลย
   ในหน้า Profiles ด้วย / ไม่ใช่ว่าเราต้องบอกไปซักทุกอย่าง"* — no warning labels
   anywhere, including the profile page; we do not have to tell them everything.

   Every caveat string in this app is gone, which makes docs/MONEY_RULES.md §0
   the whole defence: with no sentence left to qualify a figure, the figure has
   to be right or ABSENT. This is absent. It is a glyph, not a label — nothing
   here ever grows a `title`, an icon or a tooltip, because that is the label
   coming back through a side door.

   Wired as ONE function rather than as a per-component `x == null ? "—" : …`
   judgement, so "what does an unknown look like" has a single answer and a
   single test. `known === false` beats any value that was passed alongside it:
   a figure computed from incomplete inputs is withheld even when the arithmetic
   produced a finite number.
   ════════════════════════════════════════════════════════════════════════════ */

/** The withheld glyph. Never a sentence, never a tooltip. */
export const DASH = "—";

/**
 * Render a figure, or withhold it.
 *
 * @param {number|null|undefined} v      the figure
 * @param {(n:number)=>string}    format how to print it when it may be printed
 * @param {boolean}               known  false ⇒ withhold regardless of `v`
 */
export function figure(v, format, known = true) {
  if (known === false || v == null) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return format(n);
}

/* ═════════════════════════════════════════════════════════════════════════════
   USDC, PAST THE CENT — and one home for it
   ----------------------------------------------------------------------------
   Two decimals at least, six at most: a withdrawal's fee on the far side can be
   under a cent, so rounding 4.995497 to "5.00" prints the whole fee away and
   overstates what lands (docs/MONEY_RULES.md §0).

   IT LIVES HERE BECAUSE THERE WERE TWO OF IT. The Perp Withdraw sheet's own
   rows used this shape while the words on its two signing windows used a
   plain 6-decimal one, so a 25 USDC withdrawal drew "25.00 USDC" on the row
   the customer read and "25 USDC out." on the window they signed — every
   amount with fewer than two decimals, which is the normal typed withdrawal.
   §1 says that pair must be INCAPABLE of disagreeing, so both call this.
   ═════════════════════════════════════════════════════════════════════════════ */

/** "25.00" / "24.889" / "4.995497", or the dash when there is no figure. */
export function usdcExact(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return DASH;
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/**
 * The money-parts contract for a figure that is ALREADY in USD (a chain-scan value, a
 * pair leg). One function, so "how do we word a dollar" has one answer.
 */
export function usdParts(usd, { signed = false, known = true, full = false } = {}) {
  if (known === false || usd == null || !Number.isFinite(Number(usd))) {
    return { text: DASH, flat: true, up: true, known: false };
  }
  const n = Number(usd);
  if (signed) return { ...signedUsdParts(n, { full }), known: true };
  if (n === 0) return { text: "$0.00", flat: true, up: true, known: true };
  if (Math.abs(n) < FLAT_USD) return { text: "<$0.01", flat: true, up: n >= 0, known: true };
  return { text: fmtUsd(n, { full }), flat: false, up: n >= 0, known: true };
}

/* ════════════════════════════════════════════════════════════════════════════
   A QUANTITY OF A TOKEN — one format, at every breakpoint.
   ----------------------------------------------------------------------------
   A quantity reads the same at every breakpoint: compact is the app's language for a
   quantity, and the full figure belongs in the coin sheet, where it is asked for.

   🔴 AND NEVER A ROUNDED BAG. `fmtNum` ends in `maximumFractionDigits: 0`, so a
   dust balance of 0.0051 printed "0" ("you have none") and 2.5208 printed "3"
   (19% larger than the bag). Both directions are §0.

   ── THE RULE, AND IT HOLDS FROM 1 wei TO A 9-FIGURE BAG ─────────────────────
   1. A MEASURED zero prints "0". Nothing else ever does. A balance the chain
      returned as nonzero always keeps at least one significant digit, however
      many leading zeros that costs (an ERC-20 carries at most 18 decimals, so
      the deepest dust still terminates).
   2. FOUR significant figures. That is the app's language everywhere else
      (`fmtPrice`, `fmtPriceFull`), and at row scale it is all the ink there is.
   3. TRUNCATED, never rounded — toward zero, on both signs. A displayed
      quantity is therefore never larger than the bag. Rounding is what turned
      2.5208 into "3"; half-up would do it again at the next boundary, and a
      quantity that overstates is the direction §0 names as the one to refuse.
   ══════════════════════════════════════════════════════════════════════════ */

/** Significant figures a quantity is shown to. */
export const QTY_SIG = 4;
/** An ERC-20 carries at most this many decimals, so truncation terminates. */
const QTY_MAX_DP = 18;

/**
 * `x` cut (never rounded) to `dp` decimals, as a string.
 *
 * 🔴 THE GUARD DIGITS ARE NOT OPTIONAL AND A FIXED 20 IS NOT ENOUGH EITHER.
 * `toFixed` ROUNDS, and a run of 9s carries straight through a short guard into
 * a printed digit. Both failures were measured, not reasoned about:
 *
 *     dp + 2   `(1999.9/1e3).toFixed(3)` → "2.000"  ⇒ 1,999.9 rendered "2K"
 *     a flat 20  `(7.959961742499476e-16).toFixed(20)` → "0.00000000000000079600"
 *                ⇒ 18-decimal dust rendered 0.05% LARGER than the bag
 *
 * — an overstatement produced by the very helper written to prevent one, twice.
 * So the guard scales WITH the cut: 25 digits below it, capped at `toFixed`'s
 * own limit of 100. A carry would need 25 consecutive 9s to reach a printed
 * digit, which no balance in an 18-decimal token can produce.
 */
function truncFixed(x, dp) {
  const a = Math.abs(x);
  const s = a.toFixed(Math.min(100, Math.max(0, dp) + 25));
  // toFixed goes exponential at 1e21; nothing this app renders does, but a
  // string with an "e" in it must never be sliced as if it were positional.
  if (s.includes("e") || s.includes("E")) return String(a);
  const dot = s.indexOf(".");
  if (dp <= 0) return s.slice(0, dot);
  return s.slice(0, dot + 1 + dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export const tokenAmount = (v) => {
  // `unknown`, not a hand-rolled null check: `Number("") === 0` is FINITE, so an
  // empty string reached the zero branch and rendered "0". That is the module's
  // own oldest bug (see the header) reintroduced by a local guard — the shared
  // predicate is the only one that knows "" is an absence.
  if (unknown(v)) return DASH;
  const n = Number(v);
  if (n === 0) return "0";                       // MEASURED. The only "0" there is.
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  // Compact above a thousand — the app's language for a big bag, truncated so
  // 1,999 never reads "2.0K".
  if (a >= 1e9) return `${sign}${truncFixed(a / 1e9, 2)}B`;
  if (a >= 1e6) return `${sign}${truncFixed(a / 1e6, 2)}M`;
  if (a >= 1e3) return `${sign}${truncFixed(a / 1e3, 1)}K`;

  // Below a thousand: QTY_SIG significant figures. `Math.floor(log10)` gives the
  // exponent, so the decimal count grows with the leading zeros and dust keeps
  // its digits instead of collapsing to "0".
  const exp = Math.floor(Math.log10(a));
  const dp = Math.max(0, Math.min(QTY_MAX_DP, QTY_SIG - 1 - exp));
  const body = truncFixed(a, dp);
  // A truncation that ate every digit would print the empty bag the chain says
  // this is not. Fall back to the deepest cut an ERC-20 can need.
  return sign + (Number(body) === 0 ? truncFixed(a, QTY_MAX_DP) : body);
};
