// ─────────────────────────────────────────────────────────────────────────────
// Token amounts ↔ base units, exactly. No float ever decides how many base units
// are moved: amounts become BigInt by string arithmetic, and extra decimals are
// cut DOWN (never rounded up, so a move is never larger than what was asked).
// ─────────────────────────────────────────────────────────────────────────────
//
// Unknown is null, never 0: every reader here answers null for null, NaN,
// negatives and garbage, and the formatters print "—" for it.

const DEC_RE = /^(\d+)(?:\.(\d*))?$/;

/* A finite non-negative number → a plain decimal string with no exponent. */
function plain(n) {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return null;
  const digits = m[1] + (m[2] || "");
  const exp = Number(m[3]) - (m[2] ? m[2].length : 0);
  if (exp >= 0) return digits + "0".repeat(exp);
  const pad = digits.padStart(-exp + 1, "0");
  return `${pad.slice(0, pad.length + exp)}.${pad.slice(pad.length + exp)}`;
}

/**
 * An amount (number or decimal string, in whole tokens) → base units (BigInt),
 * cut down to `decimals`. null for anything that is not a finite amount ≥ 0.
 */
export function toRaw(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  let s;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) return null;
    s = plain(amount);
  } else if (typeof amount === "string") {
    s = amount.trim();
  } else return null;
  const m = s && DEC_RE.exec(s);
  if (!m) return null;
  const frac = (m[2] || "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * 10n ** BigInt(decimals) + (decimals ? BigInt(frac || "0") : 0n);
}

/** Base units → an exact decimal string ("10.5", "0.000123"). null for unknown. */
export function fromRaw(raw, decimals) {
  if (typeof raw !== "bigint" || raw < 0n || !Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const frac = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${raw / unit}.${frac}` : `${raw / unit}`;
}

/** Base units → a number (display and USD maths only, never for sending). null for unknown. */
export function rawToNumber(raw, decimals) {
  const s = fromRaw(raw, decimals);
  return s == null ? null : Number(s);
}

/**
 * Base units → display text with at most `dp` decimals, cut down, and a
 * non-zero amount never printed as "0" ("<0.0001" instead). "—" for unknown.
 */
export function formatRaw(raw, decimals, dp = 4) {
  const s = fromRaw(raw, decimals);
  if (s == null) return "—";
  if (raw === 0n) return "0";
  const [w, f = ""] = s.split(".");
  const cut = f.slice(0, dp).replace(/0+$/, "");
  if (w === "0" && !cut) return `<0.${"0".repeat(Math.max(0, dp - 1))}1`;
  return cut ? `${w}.${cut}` : w;
}
