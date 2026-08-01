#!/usr/bin/env node
// ============================================================
// WINDFALL — Regression Check Pack
// ------------------------------------------------------------
// Fast, dependency-free static checks that catch the bugs that
// have actually broken Windfall: dead buttons, missing handlers,
// typo'd element IDs, calls to routes that don't exist — PLUS a
// full FEATURE INVENTORY that verifies every single feature is
// still wired end-to-end (button -> handler -> element -> route).
//
// Run after EVERY change, before you push:
//     npm test
//
// Exit 0 = all good. Exit 1 = something is broken.
// ============================================================

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

let errors = 0, warnings = 0;
const fail = m => { errors++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); };
const warn = m => { warnings++; console.log(`  \x1b[33m! ${m}\x1b[0m`); };
const ok   = m => console.log(`  \x1b[32m✓ ${m}\x1b[0m`);
const section = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
const lineAt = (text, i) => text.slice(0, i).split("\n").length;

const appJs = read("app.js");
const indexHtml = read("index.html");
const serverJs = read("server.js");
const styleCss = read("style.css");
const swJs = read("sw.js");

// ---------- reusable predicates ----------
const appHasFn = n => new RegExp(`\\bfunction\\s+${n}\\b`).test(appJs) || new RegExp(`\\bwindow\\.${n}\\s*=`).test(appJs) || new RegExp(`\\b(const|let|var)\\s+${n}\\b`).test(appJs);
const srvHasFn = n => new RegExp(`\\bfunction\\s+${n}\\b`).test(serverJs);
const idExists = id => new RegExp(`id=\\\\?["']${id}\\\\?["']`).test(indexHtml) || new RegExp(`id=\\\\?["']${id}\\\\?["']`).test(appJs);
const routeExists = p => new RegExp(`app\\.(get|post|patch|put|delete)\\(\\s*["'\`]${p.replace(/[/]/g, "\\/").replace(/:/g, ":")}`).test(serverJs);
const appHas = s => appJs.includes(s);
const srvHas = s => serverJs.includes(s);
const htmlHas = s => indexHtml.includes(s);
const cssHas = s => styleCss.includes(s);

// req kinds: fn(app), srvfn, id, route, app, srv, html, css
const R = {
  fn:    n => ({ label: `app fn ${n}()`,        test: () => appHasFn(n) }),
  srvfn: n => ({ label: `server fn ${n}()`,     test: () => srvHasFn(n) }),
  id:    n => ({ label: `element #${n}`,        test: () => idExists(n) }),
  route: p => ({ label: `route ${p}`,           test: () => routeExists(p) }),
  app:   s => ({ label: `app.js: "${s}"`,       test: () => appHas(s) }),
  srv:   s => ({ label: `server.js: "${s}"`,    test: () => srvHas(s) }),
  html:  s => ({ label: `index.html: "${s}"`,   test: () => htmlHas(s) }),
  css:   s => ({ label: `style.css: "${s}"`,    test: () => cssHas(s) })
};

// ============================================================
// THE FEATURE INVENTORY — every feature, and what proves it exists.
// Add a line here whenever you add a feature.
// ============================================================
const FEATURES = [
  ["Register / sign-up",              [R.route("/api/register"), R.fn("doRegister"), R.id("regEmail"), R.id("registerBtn")]],
  ["Login",                           [R.route("/api/login"), R.fn("doLogin"), R.id("loginEmail"), R.id("loginBtn")]],
  ["Sign-in liquid loader",           [R.id("loginLoader"), R.css("liquid-fill")]],
  ["Logout",                          [R.id("logoutBtn")]],
  ["Forgot password",                 [R.route("/api/forgot-password"), R.id("forgotEmail"), R.id("sendResetBtn")]],
  ["Reset password",                  [R.route("/api/reset-password"), R.fn("checkResetToken"), R.id("resetNewPass")]],
  ["Change password",                 [R.route("/api/change-password"), R.id("changePassBtn")]],
  ["Pending-approval screen",         [R.id("pendingScreen")]],

  ["Map + markers",                   [R.route("/api/trees"), R.fn("initMap"), R.fn("addTreeMarker"), R.fn("loadTrees"), R.fn("getStatusColor"), R.fn("getFruitEmoji")]],
  ["Public read-only map",            [R.fn("openPublicMap"), R.fn("initPublicMap"), R.id("publicMapScreen")]],
  ["Report a tree",                   [R.fn("submitTree"), R.id("reportPanel"), R.id("treeType"), R.id("landType"), R.id("submitTreeBtn")]],
  ["Use my location (geocode)",       [R.id("useLocationBtn"), R.app("nominatim")]],
  ["Photo upload + compression",      [R.fn("compressImage"), R.srv("memoryStorage"), R.srv("base64")]],
  ["Photos served separately (fast map)", [R.srvfn("publicTree"), R.route("/api/trees/:id/photo"), R.srv("hasPhoto"), R.app("tree.hasPhoto"), R.srv("Cache-Control")]],
  ["AI fruit checker (inline)",       [R.route("/api/ai-check"), R.id("aiCheckBtn"), R.id("aiResult")]],
  ["AI fruit checker (standalone)",   [R.fn("openAiCheckerPanel"), R.id("aiCheckerPanel"), R.id("aiCheckerRunBtn")]],
  ["AI model fallback chain",         [R.srv("for (const model of models)")]],

  ["Tree detail panel",               [R.fn("openTreePanel"), R.id("treePanel")]],
  ["Log a pickup",                    [R.route("/api/trees/:id/pickup"), R.fn("logPickup")]],
  ["Pickup destination (where fruit went)", [R.id("pickupDest"), R.app("DEST_META"), R.srv("validDests")]],
  ["Pickup destination: green bin + other", [R.srv('"greenbin"'), R.srv('"other"'), R.srv("destinationOther"), R.app("greenbin:"), R.fn("togglePickupOther"), R.id("pickupDestOther")]],
  ["Pickup haul photo",               [R.id("pickupPhoto"), R.route("/api/pickups/:pickupId/photo"), R.srv("pickupphoto:"), R.app("/api/pickups/")]],
  ["Camera or gallery choice",        [{ label: "no forced camera capture on photo inputs", test: () => !/type="file"[^>]*capture=/.test(indexHtml) }]],
  ["1 tonne community target bar",    [R.app("targetKg"), R.app("1 tonne target")]],
  ["Comments on trees",               [R.route("/api/trees/:id/comments"), R.fn("addComment")]],
  ["Update tree status",              [R.route("/api/trees/:id/status"), R.fn("updateTreeStatus")]],
  ["Get directions link",            [R.app("google.com/maps/dir")]],
  ["Share a tree",                    [R.fn("shareTree"), R.app("/tree/"), R.app("navigator.share")]],
  ["Shared /tree/:id deep link",      [R.app("pendingTreeId"), R.app("/^\\/tree\\/")]],

  ["Filter by fruit type",            [R.app("activeTypeFilter"), R.html('data-filter-type="apple"')]],
  ["Blackberry fruit type (everywhere)", [R.app("blackberry:"), R.html('data-filter-type="blackberry"'), R.html('value="blackberry"'), R.srv('"blackberry"'), R.app('type: "blackberry"')]],
  ["Filter by status",                [R.app("activeStatusFilter"), R.html('data-filter-status="active"')]],
  ["Filter by distance (1/5/10/custom)", [R.app("activeDistFilter"), R.id("customDistInput"), R.html('data-filter-dist="1"'), R.html('data-filter-dist="custom"')]],
  ["Distance-from-me labels",         [R.fn("distanceKm"), R.fn("distanceLabel"), R.fn("captureUserPos")]],
  ["Heatmap toggle",                  [R.fn("toggleHeatmap"), R.id("heatmapBtn")]],

  ["Leaderboard / rankings",          [R.route("/api/leaderboard"), R.fn("openLeaderboard"), R.fn("renderLeaderboard")]],
  ["Leaderboard search",              [R.id("leaderboardSearch")]],
  ["This-season leaderboard",         [R.app("leaderboardPeriod"), R.fn("loadLeaderboard"), R.id("lbTabSeason"), R.id("lbTabAll"), R.srv("req.query.period")]],
  ["Community impact breakdown",      [R.app("destTotals")]],
  ["My Trees list",                   [R.fn("openMyTrees"), R.fn("renderMyTrees"), R.id("myTreesList")]],
  ["My Trees search + sort",          [R.id("myTreesSearch"), R.id("myTreesSort")]],
  ["Profile + stats",                 [R.route("/api/me"), R.fn("updateProfilePanel"), R.id("statKg")]],
  ["Badges",                          [R.srvfn("computeBadges"), R.app("badgeMap"), R.srv("windfall-legend")]],
  ["Bonus badges (all-rounder/night-owl/season-opener)", [R.srv("all-rounder"), R.srv("night-owl"), R.srv("season-opener"), R.app("all-rounder"), R.srv("pickedTypes"), R.srv("nightOwl")]],
  ["Personal share card",             [R.fn("openShareCard"), R.fn("drawShareCard"), R.fn("shareShareCard"), R.fn("downloadShareCard"), R.id("shareStatsBtn"), R.id("shareCardCanvas")]],
  ["Public user profiles",            [R.route("/api/users/:id/profile"), R.fn("openUserProfile")]],

  ["Community impact counter (sign-in)", [R.fn("loadCommunityImpact"), R.id("communityImpact"), R.css("community-impact")]],
  ["Announcements (view)",            [R.route("/api/announcements"), R.fn("openUpdatesPanel"), R.id("updatesBtn")]],
  ["Announcement unread dot",         [R.fn("checkAnnouncementsDot"), R.id("updatesDot"), R.app("wf_seenUpdates"), R.css("icon-dot")]],
  ["Notification bell",               [R.fn("openNotifsPanel"), R.fn("computeNotifications"), R.fn("refreshNotifsBadge"), R.id("notifsBtn"), R.id("notifsBadge"), R.app("wf_seenNotifs")]],

  ["Seasonal harvest calendar",       [R.app("FRUIT_SEASONS"), R.fn("inSeason"), R.fn("openSeasonsPanel"), R.id("seasonsBtn"), R.id("seasonsPanel"), R.css("season-strip")]],
  ["Season hint in report form",      [R.fn("updateSeasonHint"), R.id("seasonHint")]],
  ["In-season map glow",              [R.app("seasonal"), R.app("rgba(212,168,67")]],

  ["Maintenance mode",                [R.route("/api/maintenance"), R.route("/api/admin/maintenance"), R.fn("checkMaintenanceMode"), R.fn("loadMaintenanceStatus"), R.id("maintenanceScreen"), R.id("toggleMaintenanceBtn")]],

  ["Admin panel",                     [R.route("/api/admin/check"), R.fn("openAdminPanel"), R.id("adminPanel")]],
  ["Admin: approve requests",         [R.route("/api/admin/requests"), R.route("/api/admin/approve/:id"), R.fn("loadAdminRequests"), R.fn("approveUser")]],
  ["Admin: reject / delete users",    [R.route("/api/admin/users/:id"), R.fn("rejectUser"), R.fn("deleteUser")]],
  ["Admin: suspend / unsuspend user", [R.route("/api/admin/users/:id/suspend"), R.fn("suspendUser"), R.srvfn("getSuspendedIds"), R.srvfn("blockIfSuspended"), R.srv("suspended:users"), R.fn("reloadMapMarkers")]],
  ["Suspended-account screen",        [R.id("suspendedScreen"), R.id("backFromSuspendedBtn"), R.app('data.error === "suspended"'), R.srv('"suspended"')]],
  ["Admin: pending-count badge",      [R.fn("refreshAdminBadge"), R.fn("setAdminBadge"), R.id("adminBadge")]],
  ["Admin: analytics",                [R.route("/api/admin/analytics"), R.fn("loadAdminAnalytics")]],
  ["Admin: delete a pickup",          [R.route("/api/admin/trees/:id/pickups/:index"), R.fn("deletePickup"), R.app("deletePickup(")]],
  ["Admin: manage trees",             [R.route("/api/admin/trees/:id"), R.fn("loadAdminTrees"), R.fn("openEditTree"), R.fn("saveEditTree")]],
  ["Admin: verify tree",              [R.fn("toggleVerifyTree")]],
  ["Admin: delete tree",              [R.route("/api/trees/:id"), R.fn("deleteTree")]],
  ["Admin: announcements post/delete",[R.route("/api/admin/announcements"), R.fn("loadAdminAnnouncements"), R.fn("deleteAnnouncement")]],
  ["Admin: reset all stats",          [R.route("/api/admin/reset-stats"), R.id("resetStatsBtn")]],
  ["Admin: manage users list",        [R.route("/api/admin/users"), R.fn("loadAdminUsers")]],
  ["CSV export",                      [R.fn("downloadCSV"), R.fn("buildAndDownloadCSV")]],
  ["Year recap card",                 [R.fn("showYearCard"), R.fn("drawYearCard"), R.fn("downloadYearCard")]],

  ["Email: new-user notification",    [R.srvfn("sendEmail"), R.srv("New Windfall sign-up")]],
  ["Email: welcome on approve",       [R.srvfn("welcomeEmailHtml"), R.srv("welcomeEmailHtml(user.name")]],
  ["Email: password reset",           [R.srv("Reset your Windfall password")]],
  ["Email: weekly admin digest",      [R.srvfn("buildWeeklyDigest"), R.srvfn("digestEmailHtml"), R.srvfn("sendWeeklyDigestIfDue"), R.route("/api/admin/send-digest"), R.id("sendDigestBtn")]],
  ["Email: Resend integration",       [R.srv("api.resend.com/emails"), R.srv("RESEND_API_KEY")]],
  ["Email: notify tree owner",        [R.srvfn("notifyTreeOwner"), R.srvfn("treeActivityEmailHtml"), R.srv("emailNotifications")]],
  ["Email notification opt-out",      [R.route("/api/email-prefs"), R.id("emailPrefToggle")]],
  ["Rate limiting",                   [R.srvfn("rateLimit"), R.srvfn("underLimit"), R.srv('scope: "login"'), R.srv('scope: "register"'), R.srv("trust proxy"), R.srv("429")]],
  ["Automated off-site backup",       [R.srvfn("buildBackup"), R.srvfn("emailBackup"), R.srvfn("sendBackupIfDue"), R.route("/api/admin/send-backup"), R.id("sendBackupBtn"), R.srv("backup:lastSent"), R.srv("attachments")]],

  ["Onboarding tour",                 [R.app("TOUR_SLIDES"), R.fn("startTour"), R.fn("renderTourSlide"), R.fn("endTour"), R.id("tourOverlay"), R.id("tourNext"), R.id("tourSkip"), R.id("replayTourBtn"), R.app("wf_seenTour"), R.css("tour-card")]],
  ["In-app confirm dialog",           [R.fn("confirmDialog"), R.css("confirm-overlay")]],
  ["Canonical domain redirect",       [R.html("windfall-app.co.uk"), R.html("windfall-jvc3.onrender.com"), R.html("display-mode: standalone")]],
  ["PWA install (manifest)",          [R.html("manifest.json")]],
  ["Service worker registered",       [R.fn("registerSW"), R.app('register("/sw.js")')]]
  // (the SW cache-version string is checked explicitly after the loop below)
];

// ============================================================
// CHECK 0 — JavaScript syntax
// ============================================================
section("0. JavaScript syntax");
for (const file of ["app.js", "server.js", "sw.js", "test/regression-check.js"]) {
  try { execSync(`node --check "${path.join(ROOT, file)}"`, { stdio: "pipe" }); ok(`${file} parses`); }
  catch (e) { fail(`${file} syntax error:\n${e.stderr ? e.stderr.toString() : e.message}`); }
}

// ---------- inline handler collection (shared by A & B) ----------
function collectHandlers(text, fileName) {
  const re = /\son(click|change|input|submit|error|keydown|keyup)="([^"]*)"/g;
  const out = []; let m;
  while ((m = re.exec(text)) !== null) out.push({ event: m[1], value: m[2], file: fileName, line: lineAt(text, m.index) });
  return out;
}
const handlers = [...collectHandlers(appJs, "app.js"), ...collectHandlers(indexHtml, "index.html")];

// ============================================================
// CHECK A — inline handler attributes are well-formed
// ============================================================
section("A. Inline handler attributes well-formed");
let aBad = 0;
for (const h of handlers) if (/JSON\.stringify/.test(h.value)) { fail(`${h.file}:${h.line} — on${h.event} uses JSON.stringify() (breaks the attribute; pass an id only).`); aBad++; }
if (!aBad) ok(`${handlers.length} inline handlers, none use quote-breaking patterns`);

// ============================================================
// CHECK B — inline handlers call real global functions
// ============================================================
section("B. Inline handlers point at real global functions");
const GLOBALS = new Set(["document","window","this","event","alert","confirm","prompt","sendPrompt","console"]);
const defined = new Set();
for (const m of appJs.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)) defined.add(m[1]);
for (const m of appJs.matchAll(/\bwindow\.([A-Za-z_]\w*)\s*=/g)) defined.add(m[1]);
let bBad = 0;
for (const h of handlers) for (const c of h.value.matchAll(/(?:^|[^.\w$])([A-Za-z_]\w*)\s*\(/g)) {
  const n = c[1];
  if (GLOBALS.has(n) || defined.has(n)) continue;
  fail(`${h.file}:${h.line} — on${h.event} calls "${n}(...)" but no global function "${n}" exists.`); bBad++;
}
if (!bBad) ok("every inline handler resolves to a defined global function");

// ============================================================
// CHECK C — getElementById targets exist
// ============================================================
section("C. getElementById targets exist");
const definedIds = new Set();
for (const m of indexHtml.matchAll(/\bid=["']([^"']+)["']/g)) definedIds.add(m[1]);
for (const m of appJs.matchAll(/\bid=\\?["']([^"'${}\\]+)\\?["']/g)) definedIds.add(m[1]);
const refIds = new Map();
for (const m of appJs.matchAll(/getElementById\(\s*["']([^"'`]+)["']\s*\)/g)) if (!refIds.has(m[1])) refIds.set(m[1], lineAt(appJs, m.index));
let cBad = 0;
for (const [id, ln] of refIds) if (!definedIds.has(id)) { warn(`app.js:${ln} — getElementById("${id}") has no matching element.`); cBad++; }
if (!cBad) ok(`${refIds.size} element IDs all resolve`);

// ============================================================
// CHECK D — frontend API calls have server routes
// ============================================================
section("D. Frontend API calls have server routes");
const routes = [];
for (const m of serverJs.matchAll(/app\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/g)) routes.push(m[2]);
const routeMatches = call => {
  const norm = call.replace(/\$\{[^}]*\}/g, "*").replace(/\/+$/, "");
  return routes.some(r => { const rp = r.replace(/:[^/]+/g, "*").replace(/\/+$/, ""); return rp === norm || rp.replace(/\/\*$/, "") === norm.replace(/\/\*$/, ""); });
};
const apiCalls = new Map();
for (const m of appJs.matchAll(/["'`](\/api\/[A-Za-z0-9/_$\-{}.]+)["'`]/g)) if (!apiCalls.has(m[1])) apiCalls.set(m[1], lineAt(appJs, m.index));
let dBad = 0;
for (const [p, ln] of apiCalls) if (!routeMatches(p)) { warn(`app.js:${ln} — calls "${p}" but no matching server route.`); dBad++; }
if (!dBad) ok(`${apiCalls.size} API calls all map to a server route`);

// ============================================================
// CHECK E — bottom-nav buttons all handled
// ============================================================
section("E. Bottom-nav buttons all handled");
const navViews = [...indexHtml.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]);
const handled = new Set(["admin"]);
for (const m of appJs.matchAll(/view\s*===\s*["']([^"']+)["']/g)) handled.add(m[1]);
let eBad = 0;
for (const v of navViews) if (!handled.has(v)) { fail(`nav data-view="${v}" has no handler.`); eBad++; }
if (!eBad) ok(`${navViews.length} nav buttons all have handlers`);

// ============================================================
// CHECK F — FEATURE INVENTORY (the big one)
// ============================================================
section("F. Feature inventory — every feature wired end-to-end");
let featOk = 0, featBad = 0;
for (const [name, reqs] of FEATURES) {
  if (!reqs) continue;
  const missing = reqs.filter(r => r && typeof r.test === "function" && !r.test()).map(r => r.label);
  if (missing.length) { fail(`${name} — missing: ${missing.join("; ")}`); featBad++; }
  else featOk++;
}
// service worker cache version (explicit, keeps the table clean)
if (/const CACHE = "windfall-v\d+"/.test(swJs)) featOk++;
else { fail("Service worker — CACHE version string missing/!matching windfall-vN"); featBad++; }
if (!featBad) ok(`all ${featOk} features present and wired`);
else ok(`${featOk} features OK`);

// ============================================================
// Summary
// ============================================================
console.log("\n" + "─".repeat(56));
if (!errors && !warnings) console.log("\x1b[32m\x1b[1m✓ ALL CHECKS PASSED — safe to push.\x1b[0m");
else {
  if (warnings) console.log(`\x1b[33m${warnings} warning(s) — review, may be fine.\x1b[0m`);
  if (errors) console.log(`\x1b[31m\x1b[1m✗ ${errors} error(s) — fix before pushing.\x1b[0m`);
}
console.log("─".repeat(56));
process.exit(errors > 0 ? 1 : 0);
