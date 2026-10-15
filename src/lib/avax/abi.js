// ─────────────────────────────────────────────────────────────────────────────
// Strict ABI words for the Avax money layer: encode and decode 32-byte words by
// hand, so every byte a builder emits and every byte a reader trusts is checked.
// ─────────────────────────────────────────────────────────────────────────────
//
// Why not a general ABI library here: a closed builder must refuse anything that
// is not exactly the shape it expects (wrong length, dirty high bits in an
// address word, a bool that is 2). A general decoder is lenient on purpose.
// The tests cross-check every encoder against viem's.
//
// Pure. Nothing runs at import time.

export const MAX_UINT256 = (1n << 256n) - 1n;
const ADDR_WORD_RE = /^0{24}[0-9a-f]{40}$/;
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

export class AbiError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = "AbiError";
    this.code = "bad-abi";
    this.detail = detail;
  }
}

/** Lowercase hex without 0x. Throws on anything that is not whole-byte hex. */
export function strip0x(hex) {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) throw new AbiError("Not hex data");
  return hex.slice(2).toLowerCase();
}

/** A 20-byte address as one word. */
export function addressWord(addr) {
  if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new AbiError("Not an address", { addr });
  return addr.slice(2).toLowerCase().padStart(64, "0");
}

/** A uint256 as one word. */
export function uintWord(n) {
  if (typeof n !== "bigint" || n < 0n || n > MAX_UINT256) throw new AbiError("Not a uint256", { n: String(n) });
  return n.toString(16).padStart(64, "0");
}

/** A bool as one word. */
export function boolWord(b) {
  return (b ? "1" : "0").padStart(64, "0");
}

/** Word `i` (0-based) of a 0x-less body. Throws when the body is short. */
export function wordAt(body, i) {
  const s = i * 64;
  if (body.length < s + 64) throw new AbiError("Short data", { need: s + 64, have: body.length });
  return body.slice(s, s + 64);
}

/** A word as a uint256 BigInt. */
export function wordToUint(w) {
  return BigInt(`0x${w}`);
}

/** A word as an address (lowercase). Throws if the 12 high bytes are not zero. */
export function wordToAddress(w) {
  if (!ADDR_WORD_RE.test(w)) throw new AbiError("Not an address word", { w });
  return `0x${w.slice(24)}`;
}

/** A word as a bool. Throws on anything but 0 or 1. */
export function wordToBool(w) {
  const n = wordToUint(w);
  if (n !== 0n && n !== 1n) throw new AbiError("Not a bool word", { w });
  return n === 1n;
}

/** The return data of a `returns (uint256)` call: EXACTLY one word, or throw. */
export function decodeUint(hex) {
  const body = strip0x(hex);
  if (body.length !== 64) throw new AbiError("Not one uint256", { bytes: body.length / 2 });
  return wordToUint(body);
}

/** The 4-byte selector of calldata ("0x12345678"), lowercase. */
export function selectorOf(data) {
  const body = strip0x(data);
  if (body.length < 8) throw new AbiError("No selector");
  return `0x${body.slice(0, 8)}`;
}

/* Error(string) and Panic(uint256). */
const ERROR_STRING = "08c379a0";
const PANIC = "4e487b71";

/**
 * Revert data → { selector, message }. Error(string) gives its text, Panic its
 * code, a custom error its selector (the caller maps known ones). Never throws.
 */
export function decodeRevert(data) {
  let body;
  try { body = strip0x(data); } catch { return { selector: null, message: null }; }
  if (body.length < 8) return { selector: null, message: null };
  const sel = body.slice(0, 8);
  const rest = body.slice(8);
  try {
    if (sel === ERROR_STRING) {
      const off = Number(wordToUint(wordAt(rest, 0)));
      const len = Number(wordToUint(rest.slice(off * 2, off * 2 + 64)));
      const strHex = rest.slice(off * 2 + 64, off * 2 + 64 + len * 2);
      if (strHex.length !== len * 2) return { selector: `0x${sel}`, message: null };
      const bytes = new Uint8Array(strHex.match(/../g)?.map((b) => parseInt(b, 16)) || []);
      return { selector: `0x${sel}`, message: new TextDecoder().decode(bytes) };
    }
    if (sel === PANIC) return { selector: `0x${sel}`, message: `panic 0x${wordToUint(wordAt(rest, 0)).toString(16)}` };
  } catch { /* fall through */ }
  return { selector: `0x${sel}`, message: null };
}
