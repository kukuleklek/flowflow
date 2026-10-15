/**
 * HIP-3 stock logos (public/hip3-logos/, src/lib/hyperliquid/hip3/{logos,logoFiles}.js).
 *
 * The 115 SVGs are the HIP-3 logo hand-over (2026-10-15). They are
 * third-party files served from OUR origin, so every one must pass the same
 * verdict the logo fetch script applies before it ships a
 * file: anything that can run, load or navigate is refused, never cleaned.
 * svgVerdict below is that function, ported as is (FlowFlow has no snapshot
 * script of its own yet).
 *
 * Run: node --test scripts/test-hip3-logos.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public", "hip3-logos");
const fx = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/hip3", `${name}.json`), "utf8")).response;

globalThis.fetch = () => { throw new Error("no network in tests"); };

const H = await import("../src/lib/hyperliquid/hip3/index.js");
const { hlLogoFileName } = await import("../src/lib/hyperliquid/coins.js");
const { HL_LOGO_FILES } = await import("../src/lib/hyperliquid/logoManifest.js");

/* ── the verdict (the logo fetch script, 2026-10-15) ───── */

const SAFE_REF = /^\s*(#[^"'\s]*|data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]*|(?!.*\.\.)[A-Za-z0-9_~-][A-Za-z0-9._~-]*(#[A-Za-z0-9._~-]*)?)\s*$/i;

function svgVerdict(text) {
  const no = (reason) => ({ ok: false, reason });
  if (typeof text !== "string" || !text.trim()) return no("empty");
  const s = text.replace(/^﻿/, "");
  const bare = s.replace(/<!--[\s\S]*?-->/g, "").trim();
  const root = bare.search(/<svg[\s>]/i);
  if (root < 0 || !/<\/svg\s*>$/i.test(bare)) return no("not a complete SVG document");
  if (/<!ENTITY/i.test(s)) return no("declares an XML entity");
  if (/<!DOCTYPE[^>]*\[/i.test(s)) return no("DOCTYPE with an internal subset");
  const prolog = bare.slice(0, root).replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "").trim();
  if (prolog) return no("content before the root svg element");
  if (/<script[\s>/]/i.test(s)) return no("contains a script element");
  for (const tag of ["foreignObject", "iframe", "embed", "object", "audio", "video", "handler", "listener"]) {
    if (new RegExp(`<${tag}[\\s>/]`, "i").test(s)) return no(`contains a ${tag} element`);
  }
  if (/[\s"'/]on[a-z0-9_-]+\s*=/i.test(s)) return no("has an on* event handler attribute");
  if (/javascript\s*:/i.test(s)) return no("contains a javascript: URL");
  if (/attributeName\s*=\s*["']\s*([A-Za-z_][\w.-]*:)?href\s*["']/i.test(s)) return no("animates an href");
  if (/@import/i.test(s)) return no("imports a stylesheet");
  const refRe = /(?:^|[\s"'])(?:[A-Za-z_][\w.-]*:)?(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = refRe.exec(s))) {
    const v = m[2] ?? m[3] ?? "";
    if (!SAFE_REF.test(v)) return no(`has an external reference (${v.slice(0, 60)})`);
  }
  const urlRe = /url\(\s*(["']?)([^)"']*)\1\s*\)/gi;
  while ((m = urlRe.exec(s))) {
    if (!SAFE_REF.test(m[2])) return no(`has an external CSS url (${m[2].slice(0, 60)})`);
  }
  return { ok: true };
}

const SVG = (inner, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

test("the verdict: plain logos, fragments and raster data pass; anything that can run or load is refused", () => {
  assert.deepEqual(svgVerdict(SVG('<circle cx="5" cy="5" r="5"/>')), { ok: true });
  assert.equal(svgVerdict(SVG('<image href="data:image/png;base64,iVBORw0KGgo="/>')).ok, true);
  assert.equal(svgVerdict(SVG('<rect fill="url(#g)"/><use xlink:href="#g"/>')).ok, true);
  const bad = [
    SVG("<script>alert(1)</script>"), SVG("<g/>", ' onload="x()"'), SVG('<image href="https://evil.test/p.png"/>'),
    SVG('<image href="//evil.test/p"/>'), SVG('<image href="../x.svg"/>'), SVG('<a href="javascript:alert(1)"><rect/></a>'),
    SVG('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'), SVG("<foreignObject/>"), `<!DOCTYPE svg [<!ENTITY a "a">]>${SVG("<g/>")}`,
    SVG("<style>@import url(https://evil.test/x.css);</style>"), SVG('<rect style="fill:url(https://evil.test/p)"/>'),
    SVG('<image x:href="https://evil.test/t.png"/>', ' xmlns:x="http://www.w3.org/1999/xlink"'),
    "<!DOCTYPE html><html><body>app shell</body></html>", "",
  ];
  for (const b of bad) assert.equal(svgVerdict(b).ok, false, b.slice(0, 80));
});

/* ── the files ─────────────────────────────────────────────────────────────── */

const files = fs.readdirSync(DIR).filter((f) => !f.startsWith("."));

test("every file in public/hip3-logos is a safe SVG under 512 KB", () => {
  assert.equal(files.length, 115);
  for (const f of files) {
    assert.match(f, /^[a-z0-9]+-[A-Za-z0-9]+\.svg$/, f);
    const buf = fs.readFileSync(path.join(DIR, f));
    assert.ok(buf.length < 512 * 1024, `${f} is ${buf.length} bytes`);
    const v = svgVerdict(buf.toString("utf8"));
    assert.equal(v.ok, true, `${f}: ${v.reason}`);
  }
});

test("the table names every file exactly once, with the file's own content version", () => {
  const entries = Object.entries(H.HIP3_LOGO_FILES);
  assert.equal(entries.length, files.length);
  const seen = new Set();
  for (const [coin, ref] of entries) {
    const [file, q] = ref.split("?v=");
    assert.equal(file, hlLogoFileName(coin), `${coin} is filed by coins.js's one rule`);
    assert.ok(files.includes(file), file);
    assert.ok(!seen.has(file));
    seen.add(file);
    const v = crypto.createHash("sha256").update(fs.readFileSync(path.join(DIR, file))).digest("hex").slice(0, 10);
    assert.equal(q, v, `${file} version`);
  }
});

test("89 files are the same bytes as FlowFlow's own /hl-coins snapshot; 26 are new", () => {
  let same = 0;
  for (const [coin, ref] of Object.entries(H.HIP3_LOGO_FILES)) {
    if (!HL_LOGO_FILES[coin]) continue;
    const a = fs.readFileSync(path.join(DIR, ref.split("?")[0]));
    const b = fs.readFileSync(path.join(ROOT, "public/hl-coins", HL_LOGO_FILES[coin].split("?")[0]));
    assert.ok(a.equals(b), coin);
    same++;
  }
  assert.equal(same, 89);
  const fresh = Object.keys(H.HIP3_LOGO_FILES).filter((c) => !HL_LOGO_FILES[c]);
  assert.equal(fresh.length, 26);
  assert.deepEqual(fresh.filter((c) => c.startsWith("xyz:")).sort(), ["xyz:CVX", "xyz:HO", "xyz:OURA", "xyz:TLT"]);
});

test("every logo is a market live on 2026-10-15; MISSING is exactly the live ones with no file", () => {
  const live = new Set();
  for (const d of ["xyz", "para", "mkts", "io"]) {
    for (const u of fx(`${d}-meta-and-asset-ctxs`)[0].universe) if (!u.isDelisted) live.add(u.name);
  }
  for (const c of Object.keys(H.HIP3_LOGO_FILES)) assert.ok(live.has(c), `${c} is live`);
  const missing = [...live].filter((c) => !H.HIP3_LOGO_FILES[c]).sort();
  assert.deepEqual([...H.HIP3_LOGO_MISSING].sort(), missing);
  assert.equal(missing.filter((c) => c.startsWith("xyz:")).length, 22);
  assert.ok(missing.includes("xyz:AVGO"), "AVGO still has no picture: it stays off the whitelist");
});

test("stockLogoUrl: our file with its version, null for the missing and for anything not qualified", () => {
  assert.match(H.stockLogoUrl("xyz:TSLA"), /^\/hip3-logos\/xyz-TSLA\.svg\?v=[0-9a-f]{10}$/);
  assert.match(H.stockLogoUrl("io:OAI"), /^\/hip3-logos\/io-OAI\.svg\?v=[0-9a-f]{10}$/);
  assert.equal(H.stockLogoUrl("xyz:AVGO"), null);
  assert.equal(H.stockLogoUrl("TSLA"), null, "a main-dex name is logos.js's business");
  assert.equal(H.stockLogoUrl("xyz:../x"), null);
  assert.equal(H.stockLogoUrl(null), null);
  assert.equal(H.hasStockLogo("xyz:TSLA"), true);
  assert.equal(H.hasStockLogo("BTC"), false);
  for (const w of H.STOCK_WHITELIST) assert.ok(H.stockLogoUrl(w.coin), `${w.coin} has a logo`);
});
