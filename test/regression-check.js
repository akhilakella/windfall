#!/usr/bin/env node
// ============================================================
// WINDFALL — Regression Check Pack
// ------------------------------------------------------------
// A fast, dependency-free static check that catches the kinds of
// bugs that have actually broken Windfall in the past — silently
// dead buttons, missing handlers, typo'd element IDs, and calls to
// API endpoints that don't exist on the server.
//
// Run it after EVERY change, before you push:
//     npm test
//   (or)  node test/regression-check.js
//
// Exit code 0 = all good. Exit code 1 = something is broken.
// ============================================================

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

let errors = 0;
let warnings = 0;
const fail = msg => { errors++; console.log(`  \x1b[31m✗ ${msg}\x1b[0m`); };
const warn = msg => { warnings++; console.log(`  \x1b[33m! ${msg}\x1b[0m`); };
const ok = msg => console.log(`  \x1b[32m✓ ${msg}\x1b[0m`);
const section = title => console.log(`\n\x1b[1m${title}\x1b[0m`);

// Turn a character offset into a 1-based line number for friendly errors
function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

const appJs = read("app.js");
const indexHtml = read("index.html");
const serverJs = read("server.js");

// ============================================================
// CHECK 0 — JavaScript syntax (catches typos, unclosed brackets)
// ============================================================
section("0. JavaScript syntax");
for (const file of ["app.js", "server.js", "sw.js"]) {
  try {
    execSync(`node --check "${path.join(ROOT, file)}"`, { stdio: "pipe" });
    ok(`${file} parses`);
  } catch (e) {
    fail(`${file} has a syntax error:\n${e.stderr ? e.stderr.toString() : e.message}`);
  }
}

// ============================================================
// Collect inline event handlers from app.js + index.html.
// Matches on*="..." (the value stops at the first double-quote,
// which is exactly how the browser parses it too).
// ============================================================
function collectHandlers(text, fileName) {
  const re = /\son(click|change|input|submit|error|keydown|keyup)="([^"]*)"/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ event: m[1], value: m[2], file: fileName, line: lineAt(text, m.index) });
  }
  return out;
}
const handlers = [...collectHandlers(appJs, "app.js"), ...collectHandlers(indexHtml, "index.html")];

// ============================================================
// CHECK A — inline handler attribute integrity
// The bug that bit us: JSON.stringify() inside a double-quoted
// onclick emits its own double-quotes and closes the attribute
// early, so the button silently does nothing.
// ============================================================
section("A. Inline handler attributes are well-formed");
let attrIssues = 0;
for (const h of handlers) {
  if (/JSON\.stringify/.test(h.value)) {
    fail(`${h.file}:${h.line} — on${h.event} uses JSON.stringify(), which emits double-quotes and breaks the attribute. Pass an id only, or use single quotes.`);
    attrIssues++;
  }
}
if (attrIssues === 0) ok(`${handlers.length} inline handlers, none use quote-breaking patterns`);

// ============================================================
// CHECK B — every inline handler calls a function that exists
// and is reachable from global scope (top-level `function NAME`
// or `window.NAME =`). Catches renamed/removed/forgotten-export
// handlers — i.e. buttons wired to nothing.
// ============================================================
section("B. Inline handlers point at real, global functions");
const GLOBALS = new Set(["document", "window", "this", "event", "alert", "confirm", "prompt", "sendPrompt", "console"]);
const definedFns = new Set();
for (const m of appJs.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)) definedFns.add(m[1]);
for (const m of appJs.matchAll(/\bwindow\.([A-Za-z_]\w*)\s*=/g)) definedFns.add(m[1]);

let handlerIssues = 0;
for (const h of handlers) {
  // pull out each "name(" call in the handler (skip .method() calls)
  for (const call of h.value.matchAll(/(?:^|[^.\w$])([A-Za-z_]\w*)\s*\(/g)) {
    const name = call[1];
    if (GLOBALS.has(name) || definedFns.has(name)) continue;
    fail(`${h.file}:${h.line} — on${h.event} calls "${name}(...)" but no global function "${name}" is defined (add it or window.${name} = ...).`);
    handlerIssues++;
  }
}
if (handlerIssues === 0) ok("every inline handler resolves to a defined global function");

// ============================================================
// CHECK C — getElementById ids that don't exist anywhere
// Looks at plain-string ids only (skips dynamic `${...}` ids).
// "Defined" = an id="..." in index.html OR built in an app.js
// template string (e.g. the admin badge created via innerHTML).
// ============================================================
section("C. getElementById targets exist");
const definedIds = new Set();
for (const m of indexHtml.matchAll(/\bid=["']([^"']+)["']/g)) definedIds.add(m[1]);
// ids created dynamically inside app.js template strings (no ${ } in them)
for (const m of appJs.matchAll(/\bid=["']([^"'${}]+)["']/g)) definedIds.add(m[1]);

const referencedIds = new Map(); // id -> first line
for (const m of appJs.matchAll(/getElementById\(\s*["']([^"'`]+)["']\s*\)/g)) {
  if (!referencedIds.has(m[1])) referencedIds.set(m[1], lineAt(appJs, m.index));
}
let missingIds = 0;
for (const [id, line] of referencedIds) {
  if (!definedIds.has(id)) {
    warn(`app.js:${line} — getElementById("${id}") has no matching element in index.html or app.js templates.`);
    missingIds++;
  }
}
if (missingIds === 0) ok(`${referencedIds.size} element IDs all resolve`);

// ============================================================
// CHECK D — every /api/... the frontend calls has a server route
// Catches endpoint typos and routes that were renamed on one side
// only. Dynamic segments (${id}) are normalised to match :params.
// ============================================================
section("D. Frontend API calls have matching server routes");
// Build the set of server routes as matchers
const routes = [];
for (const m of serverJs.matchAll(/app\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
  routes.push({ method: m[1].toUpperCase(), path: m[2] });
}
function routeMatches(callPath) {
  // normalise the frontend path: collapse any ${...} or trailing / into a wildcard segment
  const norm = callPath.replace(/\$\{[^}]*\}/g, "*").replace(/\/+$/, "");
  return routes.some(r => {
    const rp = r.path.replace(/:[^/]+/g, "*").replace(/\/+$/, "");
    if (rp === norm) return true;
    // allow frontend "/api/x" to match route "/api/x/*" when it appends an id at call time
    return rp.replace(/\/\*$/, "") === norm.replace(/\/\*$/, "");
  });
}
// collect api paths used in fetch/apiFetch
const apiCalls = new Map();
for (const m of appJs.matchAll(/["'`](\/api\/[A-Za-z0-9/_$\-{}.]+)["'`]/g)) {
  const p = m[1];
  if (!apiCalls.has(p)) apiCalls.set(p, lineAt(appJs, m.index));
}
let routeMisses = 0;
for (const [p, line] of apiCalls) {
  if (!routeMatches(p)) {
    warn(`app.js:${line} — calls "${p}" but no matching route found in server.js.`);
    routeMisses++;
  }
}
if (routeMisses === 0) ok(`${apiCalls.size} API calls all map to a server route`);

// ============================================================
// CHECK E — bottom-nav buttons are all handled
// Every data-view="X" should be handled by the nav click logic.
// ============================================================
section("E. Bottom-nav buttons are all handled");
const navViews = [...indexHtml.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]);
const handledViews = new Set();
// matches like:  view === "map"   or  view === 'profile'
for (const m of appJs.matchAll(/view\s*===\s*["']([^"']+)["']/g)) handledViews.add(m[1]);
// "admin" is wired up dynamically when the admin logs in
handledViews.add("admin");
let navIssues = 0;
for (const v of navViews) {
  if (!handledViews.has(v)) { fail(`index.html — bottom-nav button data-view="${v}" has no handler in app.js.`); navIssues++; }
}
if (navIssues === 0) ok(`${navViews.length} nav buttons all have handlers`);

// ============================================================
// Summary
// ============================================================
console.log("\n" + "─".repeat(52));
if (errors === 0 && warnings === 0) {
  console.log("\x1b[32m\x1b[1m✓ ALL CHECKS PASSED — safe to push.\x1b[0m");
} else {
  if (warnings) console.log(`\x1b[33m${warnings} warning(s) — review, but not necessarily broken.\x1b[0m`);
  if (errors) console.log(`\x1b[31m\x1b[1m✗ ${errors} error(s) — fix these before pushing.\x1b[0m`);
}
console.log("─".repeat(52));
process.exit(errors > 0 ? 1 : 0);
