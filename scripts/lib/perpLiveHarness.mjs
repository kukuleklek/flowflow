/**
 * THE RENDER HARNESS for the live perp screens (scripts/test-perp-live-ui-render.mjs).
 *
 * The same pattern as scripts/test-perp-page.mjs and test-relay-deposit-sheet.mjs:
 * each component is bundled by esbuild with its neighbours replaced by markers
 * and React replaced by a small hook runner. There is no DOM: effects run,
 * nothing paints, refs stay unattached. What a test can do is render, read the
 * element tree, and call the handlers the tree carries.
 *
 * Neighbours are stubbed by NAME: every stubbed export is a named function
 * carrying __stub, and globalThis.__impl[name] gives one of them behaviour
 * (a hook's return value, a callback recorder).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "./stripComments.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const P = (rel) => path.join(ROOT, rel);
export const read = (rel) => fs.readFileSync(P(rel), "utf8");
export const code = (rel) => stripComments(read(rel));

const FAKE_REACT = String.raw`
const S = (globalThis.__perpLiveHooks ||= { cur: null });
function slot() { const c = S.cur; if (!c) throw new Error("hook outside mount()"); return [c, c.i++]; }
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
export function useRef(v) { const [c, i] = slot(); if (!(i in c.slots)) c.slots[i] = { current: v }; return c.slots[i]; }
export function useState(v) {
  const [c, i] = slot();
  if (!(i in c.slots)) c.slots[i] = { v: typeof v === "function" ? v() : v };
  const box = c.slots[i];
  return [box.v, (n) => { const nv = typeof n === "function" ? n(box.v) : n; if (!Object.is(nv, box.v)) { box.v = nv; c.dirty = true; } }];
}
export function useReducer(r, init, initFn) {
  const [c, i] = slot();
  if (!(i in c.slots)) c.slots[i] = { v: initFn ? initFn(init) : init };
  const box = c.slots[i];
  return [box.v, (a) => { const nv = r(box.v, a); if (!Object.is(nv, box.v)) { box.v = nv; c.dirty = true; } }];
}
export function useMemo(f, deps) { const [c, i] = slot(); const b = c.slots[i]; if (b && deps && same(b.deps, deps)) return b.v; const v = f(); c.slots[i] = { v, deps }; return v; }
export function useCallback(f, deps) { return useMemo(() => f, deps); }
export function useEffect(fn, deps) {
  const [c, i] = slot(); const b = c.slots[i];
  if (b && deps && same(b.deps, deps)) return;
  c.effects.push(() => { if (b && typeof b.cleanup === "function") b.cleanup(); c.slots[i] = { deps, cleanup: fn() }; });
}
export const useLayoutEffect = useEffect;
export const useInsertionEffect = useEffect;
export function useId() { return "id"; }
export function useSyncExternalStore(sub, get) { return get(); }
export function createContext(v) { return { _v: v, Provider: "Provider" }; }
export function useContext(ctx) { return ctx ? ctx._v : undefined; }
export function useTransition() { return [false, (f) => f()]; }
export function useDeferredValue(v) { return v; }
export function useImperativeHandle() {}
export function useDebugValue() {}
export function createElement(type, props, ...children) {
  const p = { ...(props || {}) };
  const key = p.key == null ? null : p.key; delete p.key;
  if (children.length === 1) p.children = children[0]; else if (children.length > 1) p.children = children;
  return { $$el: true, type, key, props: p };
}
export const Fragment = "Fragment";
export const Suspense = "Suspense";
export const StrictMode = "StrictMode";
export function memo(x) { return x; }
export function forwardRef(x) { return x; }
export function lazy(load) { return { $$lazy: true, load }; }
export function isValidElement(x) { return !!(x && x.$$el); }
const toArray = (c) => (Array.isArray(c) ? c.flat(Infinity) : c == null ? [] : [c]).filter((x) => x != null && x !== false && x !== true);
export const Children = { toArray, map: (c, f) => toArray(c).map(f), count: (c) => toArray(c).length };
export function mount(fn) {
  const c = { slots: {}, i: 0, effects: [], dirty: false, value: undefined, dead: false };
  const render = () => {
    const prev = S.cur; S.cur = c; c.i = 0; c.effects = [];
    try { c.value = fn(); } finally { S.cur = prev; }
    const fx = c.effects; c.effects = [];
    for (const e of fx) e();
    return c.value;
  };
  return {
    render,
    get value() { return c.value; },
    flush() { let n = 0; while (!c.dead && c.dirty && n++ < 50) { c.dirty = false; render(); } return c.value; },
    unmount() {
      c.dead = true;
      for (const k of Object.keys(c.slots)) { const b = c.slots[k]; if (b && typeof b.cleanup === "function") b.cleanup(); }
    },
  };
}
const React = { useRef, useState, useReducer, useMemo, useCallback, useEffect, useLayoutEffect, useInsertionEffect, useId,
  useSyncExternalStore, createContext, useContext, useTransition, useDeferredValue, useImperativeHandle, useDebugValue,
  createElement, Fragment, Suspense, StrictMode, memo, forwardRef, lazy, isValidElement, Children };
export default React;
`;
const FAKE_JSX = `
export const Fragment = "Fragment";
export function jsx(type, props, key) { return { $$el: true, type, key: key == null ? null : key, props: { ...(props || {}) } }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
`;
const FAKE_DOM = `
export function createPortal(node) { return node; }
export default { createPortal };
`;

const STUB_HEAD = `
const __impl = () => (globalThis.__impl || {});
function __mk(name) {
  const f = function (...a) { const g = __impl()[name]; return g ? g(...a) : null; };
  Object.defineProperty(f, "name", { value: name });
  f.__stub = name;
  return f;
}
`;
function stubSource({ names = [], def = null, values = {}, real = null }) {
  let s = STUB_HEAD;
  if (real) s += `export * from ${JSON.stringify(`REAL:${real}`)};\n`;
  for (const n of new Set(names)) {
    if (n === "default") continue;
    s += n in values ? `export const ${n} = ${values[n]};\n` : `export const ${n} = __mk(${JSON.stringify(n)});\n`;
  }
  if (def) s += `const __d = ${values.default || `__mk(${JSON.stringify(def)})`};\nexport default __d;\n`;
  return s;
}

/** Static and dynamic imports of a source file, comments stripped. */
function importsOf(src) {
  const s = stripComments(src);
  const out = [];
  for (const m of s.matchAll(/import\s+([^;"'`]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1].trim();
    const brace = clause.match(/\{([\s\S]*)\}/);
    const names = brace ? brace[1].split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split(/\s+as\s+/)[0].trim()) : [];
    const head = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
    out.push({ spec: m[2], def: head && !head.startsWith("*") ? head : null, names });
  }
  for (const m of s.matchAll(/import\s*["']([^"']+)["']/g)) out.push({ spec: m[1], def: null, names: [] });
  for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], def: "default", names: [], dynamic: true });
  return out;
}

/** A specifier as the key the stubs are filed under: a package name, or a repo path. */
export function keyFor(spec, dir) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return spec;
  const base = path.resolve(dir, spec);
  for (const c of [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, path.join(base, "index.js"), path.join(base, "index.jsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(ROOT, c).split(path.sep).join("/");
  }
  return path.relative(ROOT, base).split(path.sep).join("/");
}

/**
 * Stubs for every import of `files` (repo paths) except `keep`, merged by target.
 * extra[key] = { real: "<repo path>", only: [names to stub over the real module] }
 */
export function autoStubs(files, { keep = [], values = {}, extra = {} } = {}) {
  const want = new Map();
  for (const f of files) {
    const dir = path.dirname(P(f));
    for (const imp of importsOf(read(f))) {
      if (imp.spec === "react" || imp.spec.startsWith("react/") || imp.spec === "react-dom") continue;
      const k = keyFor(imp.spec, dir);
      if (keep.includes(k)) continue;
      const w = want.get(k) || { names: new Set(), def: null };
      imp.names.forEach((n) => w.names.add(n));
      if (imp.def) w.def = w.def || (imp.def === "default" ? path.basename(k).replace(/\.\w+$/, "") : imp.def);
      want.set(k, w);
    }
  }
  const out = {};
  for (const [k, w] of want) {
    const e = extra[k] || {};
    const names = [...w.names, ...(e.names || [])].filter((n) => !e.real || (e.only || []).includes(n));
    out[k] = stubSource({ names, def: w.def || e.def || null, values: { ...values, ...(e.values || {}) }, real: e.real || null });
  }
  return out;
}

let seq = 0;
/** Bundle a repo file with its stubs; the result re-exports the hook runner's mount(). */
export async function bundle({ entry, env = {}, stubs = {} }) {
  const mod = await import("esbuild");
  const esbuild = mod.build ? mod : mod.default;
  const out = path.join(os.tmpdir(), `ff-perp-live-${process.pid}-${Date.now()}-${seq++}.mjs`);
  const abs = JSON.stringify(P(entry));
  const hasDefault = /^\s*export\s+default\b/m.test(stripComments(read(entry)));
  const input = {
    contents: `export * from ${abs};\n${hasDefault ? `export { default } from ${abs};\n` : ""}export { mount } from "react";\n`,
    resolveDir: ROOT, loader: "js", sourcefile: `${path.basename(entry)}.entry.js`,
  };
  await esbuild.build({
    stdin: input,
    bundle: true, format: "esm", platform: "node", logLevel: "silent", outfile: out, keepNames: true,
    loader: { ".js": "jsx", ".jsx": "jsx" }, jsx: "automatic",
    define: { "import.meta.env": JSON.stringify(env) },
    plugins: [{
      name: "perp-live-stubs",
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "fake" }));
        b.onResolve({ filter: /^react-dom$/ }, () => ({ path: "react-dom", namespace: "fake" }));
        b.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({ path: "jsx", namespace: "fake" }));
        b.onResolve({ filter: /^REAL:/ }, (a) => ({ path: P(a.path.slice(5)) }));
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.kind === "entry-point") return undefined;
          const k = keyFor(a.path, a.resolveDir || ROOT);
          if (Object.prototype.hasOwnProperty.call(stubs, k)) return { path: k, namespace: "stub" };
          return undefined;
        });
        b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({
          contents: a.path === "react" ? FAKE_REACT : a.path === "react-dom" ? FAKE_DOM : FAKE_JSX, loader: "js",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: ROOT }));
      },
    }],
  });
  return import(pathToFileURL(out).href);
}

/* ── the tree ───────────────────────────────────────────────────────────────── */
export const isEl = (n) => !!(n && typeof n === "object" && n.$$el === true);
function* nodes(n, mount = null, depth = 0) {
  if (n == null || typeof n === "boolean") return;
  if (Array.isArray(n)) { for (const x of n) yield* nodes(x, mount, depth); return; }
  if (!isEl(n)) return;
  yield n;
  /* One of OUR components, with a runner: what it RENDERS is the tree (a prop
     it does not render is not on screen, and walking the props too would count
     every child twice). A host element or a stub: its props are the tree. */
  if (mount && typeof n.type === "function" && !n.type.__stub && depth < 40) {
    const h = mount(() => n.type(n.props || {}));
    const outp = h.render();
    h.unmount();
    yield* nodes(outp, mount, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(n.props || {})) {
    if (k === "children" || isEl(v) || (Array.isArray(v) && v.some(isEl))) yield* nodes(v, mount, depth);
  }
}
/** Every element in a tree (props that are trees included); with `mount`, our own components expanded. */
export const all = (tree, mount) => [...nodes(tree, mount)];
export const stubsNamed = (tree, name, mount) => all(tree, mount).filter((e) => typeof e.type === "function" && e.type.__stub === name);
export function textOf(n, mount = null, depth = 0) {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map((x) => textOf(x, mount, depth)).join("");
  if (!isEl(n)) return "";
  if (mount && typeof n.type === "function" && !n.type.__stub && depth < 40) {
    const h = mount(() => n.type(n.props || {}));
    const outp = h.render();
    h.unmount();
    return textOf(outp, mount, depth + 1);
  }
  let t = textOf(n.props && n.props.children, mount, depth);
  for (const [k, v] of Object.entries(n.props || {})) {
    if (k !== "children" && (isEl(v) || (Array.isArray(v) && v.some(isEl)))) t += " " + textOf(v, mount, depth);
  }
  return t;
}
export const squash = (s) => String(s).replace(/\s+/g, " ").trim();
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** The first element whose own text (squashed) matches, of a given host type. */
export const findEl = (tree, type, re, mount = null) => all(tree, mount).find((e) => e.type === type && re.test(squash(textOf(e, mount))));
export const byTest = (tree, id, mount = null) => all(tree, mount).filter((e) => e.props && e.props["data-test"] === id);

/* ── the browser, as little of it as the components touch ─────────────────── */
export function fakeBrowser({ mobile = true, storage = null } = {}) {
  const events = [];
  const mem = new Map();
  const ls = storage || { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = {
    matchMedia: () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    dispatchEvent: (e) => { events.push(e); return true; },
    innerWidth: mobile ? 390 : 1440, innerHeight: 844, scrollY: 0,
    location: { href: "http://localhost/perp/BTC", origin: "http://localhost", hostname: "localhost" },
    history: { state: null },
    localStorage: ls,
  };
  globalThis.localStorage = ls;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : undefined; } };
  globalThis.document = {
    body: { style: {} },
    documentElement: { scrollHeight: 4000 },
    visibilityState: "visible",
    getElementById: () => ({ id: "app-shell" }),
    addEventListener() {}, removeEventListener() {},
  };
  return { events, storage: ls };
}
