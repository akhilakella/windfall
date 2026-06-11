// ============================================================
// WINDFALL — app.js
// ============================================================
let token = localStorage.getItem("wf_token");
let currentUser = null;
let isAdmin = false;
let map = null;
let markers = {};
let tempMarker = null;
let allTrees = [];
let activeTypeFilter = "all";
let activeStatusFilter = "all";
let publicMap = null;
let heatLayer = null;
let heatmapActive = false;
let lastAnalytics = null;
let userPos = null;
let lastLeaderboardUsers = null;
let pendingTreeId = null;

// ==================== DISTANCE ====================
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceLabel(tree) {
  if (!userPos) return "";
  const km = distanceKm(userPos.lat, userPos.lng, tree.lat, tree.lng);
  return km < 1 ? `${Math.round(km * 1000)}m away` : `${km.toFixed(1)}km away`;
}

function captureUserPos() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    p => { userPos = { lat: p.coords.latitude, lng: p.coords.longitude }; },
    () => {},
    { maximumAge: 300000, timeout: 10000 }
  );
}

// ==================== INIT ====================
document.addEventListener("DOMContentLoaded", async () => {
  registerSW();
  setupAuthTabs();
  setupAuthForms();
  setupNavButtons();
  setupPanelCloses();
  setupFAB();
  setupLeaderboardBtn();
  setupProfileBtn();
  setupAdminTabs();
  setupFilters();
  checkResetToken();

  document.getElementById("leaderboardSearch").addEventListener("input", (e) => renderLeaderboard(e.target.value.trim()));
  document.getElementById("myTreesSearch").addEventListener("input", renderMyTrees);
  document.getElementById("myTreesSort").addEventListener("change", renderMyTrees);

  document.getElementById("maintenanceRefreshBtn").addEventListener("click", async () => {
    showToast("Checking...");
    const stillBlocked = await checkMaintenanceMode();
    if (!stillBlocked && token && currentUser) showApp();
    else if (!stillBlocked) { document.getElementById("maintenanceScreen").classList.remove("active"); document.getElementById("authScreen").classList.add("active"); }
  });

  // Shared tree link — remember it, open after login + map load
  const treeMatch = window.location.pathname.match(/^\/tree\/([a-zA-Z0-9-]+)/);
  if (treeMatch) { pendingTreeId = treeMatch[1]; window.history.replaceState({}, "", "/"); }

  // Public map route — show read-only map without login
  if (window.location.pathname === "/map" && !token) {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("token")) { openPublicMap(); return; }
  }

  if (token) {
    try {
      const res = await apiFetch("/api/me");
      if (res.ok) { currentUser = await res.json(); showApp(); }
      else { localStorage.removeItem("wf_token"); token = null; }
    } catch { localStorage.removeItem("wf_token"); token = null; }
  }
});

function registerSW() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// ==================== PUBLIC MAP (read-only, no login) ====================
function openPublicMap() {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("publicMapScreen").classList.add("active");
  window.history.replaceState({}, "", "/map");
  initPublicMap();
}
window.openPublicMap = openPublicMap;

function closePublicMap() {
  document.getElementById("publicMapScreen").classList.remove("active");
  if (token && currentUser) {
    document.getElementById("appScreen").classList.add("active");
  } else {
    document.getElementById("authScreen").classList.add("active");
  }
  window.history.replaceState({}, "", "/");
}
window.closePublicMap = closePublicMap;

async function initPublicMap() {
  if (!publicMap) {
    publicMap = L.map("publicMap", { zoomControl: false }).setView([52.3704, -1.2655], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 }).addTo(publicMap);
    L.control.zoom({ position: "bottomright" }).addTo(publicMap);
  } else {
    publicMap.invalidateSize();
  }
  try {
    const res = await fetch("/api/trees");
    const trees = await res.json();
    trees.forEach(tree => {
      const color = getStatusColor(tree.status), emoji = getFruitEmoji(tree.type);
      const icon = L.divIcon({ className: "temp-pin", html: `<div style="width:36px;height:36px;border-radius:50%;background:${color}22;border:2.5px solid ${color};box-shadow:0 0 10px ${color}88;display:flex;align-items:center;justify-content:center;font-size:18px;">${emoji}</div>`, iconAnchor: [18, 18], popupAnchor: [0, -20] });
      const kgText = tree.estimatedKg > 0 ? `~${tree.estimatedKg}kg · ` : "";
      L.marker([tree.lat, tree.lng], { icon })
        .bindPopup(`<div class="popup-title">${emoji} ${esc(capitalise(tree.type))} Tree</div><div class="popup-sub">${esc(kgText)}${esc(capitalise(tree.landType))}</div><p style="font-size:0.8rem;color:#888;margin-top:6px;">Sign in to view details &amp; log pickups 🌿</p>`)
        .addTo(publicMap);
    });
    const count = trees.length;
    document.getElementById("publicMapTreeCount").textContent = `${count} tree${count !== 1 ? "s" : ""} mapped`;
  } catch { console.error("Could not load public trees"); }
}

// ==================== AUTH ====================
function setupAuthTabs() {
  document.querySelectorAll(".auth-tab:not([data-admin-tab])").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab:not([data-admin-tab])").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.tab + "Form").classList.add("active");
    });
  });
}

function setupAuthForms() {
  document.getElementById("loginBtn").addEventListener("click", doLogin);
  document.getElementById("registerBtn").addEventListener("click", doRegister);
  ["loginEmail","loginPass","regName","regEmail","regPass"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") { if (id.startsWith("login")) doLogin(); else doRegister(); }
    });
  });
}

async function doLogin() {
  const email = val("loginEmail"), pass = val("loginPass");
  const err = document.getElementById("loginError");
  err.classList.add("hidden");
  if (!email || !pass) { showErr(err, "Please fill in all fields."); return; }
  setLoading("loginBtn", true, "Sign In");
  document.getElementById("loginBtn").style.display = "none";
  document.getElementById("loginLoader").style.display = "flex";
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pass }) });
    const data = await res.json();
    if (res.status === 403 && data.error === "pending") {
      document.getElementById("authScreen").classList.remove("active");
      document.getElementById("pendingScreen").classList.add("active");
      return;
    }
    if (!res.ok) { showErr(err, data.error || data.message || "Login failed."); return; }
    token = data.token; currentUser = data.user;
    localStorage.setItem("wf_token", token);
    showApp();
  } catch { showErr(err, "Network error. Please try again."); }
  finally {
    setLoading("loginBtn", false, "Sign In");
    document.getElementById("loginBtn").style.display = "";
    document.getElementById("loginLoader").style.display = "none";
  }
}

async function doRegister() {
  const name = val("regName"), email = val("regEmail"), pass = val("regPass");
  const err = document.getElementById("regError");
  err.classList.add("hidden");
  if (!name || !email || !pass) { showErr(err, "Please fill in all fields."); return; }
  if (pass.length < 6) { showErr(err, "Password must be at least 6 characters."); return; }
  setLoading("registerBtn", true, "Request Access");
  try {
    const res = await fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password: pass }) });
    const data = await res.json();
    if (!res.ok) { showErr(err, data.error || "Registration failed."); return; }
    if (data.pending) {
      document.getElementById("authScreen").classList.remove("active");
      document.getElementById("pendingScreen").classList.add("active");
      return;
    }
    // Admin registered directly
    token = data.token; currentUser = data.user;
    localStorage.setItem("wf_token", token);
    showApp();
  } catch { showErr(err, "Network error. Please try again."); }
  finally { setLoading("registerBtn", false, "Request Access"); }
}

document.getElementById("backFromPendingBtn").addEventListener("click", () => {
  document.getElementById("pendingScreen").classList.remove("active");
  document.getElementById("authScreen").classList.add("active");
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  token = null; currentUser = null; isAdmin = false;
  localStorage.removeItem("wf_token");
  closeAllPanels();
  document.getElementById("appScreen").classList.remove("active");
  document.getElementById("authScreen").classList.add("active");
  const adminBtn = document.querySelector('[data-view="admin"]');
  if (adminBtn) adminBtn.remove();
  showToast("Signed out 👋");
});

// ==================== FORGOT / RESET PASSWORD ====================
document.getElementById("forgotPassBtn").addEventListener("click", () => {
  document.getElementById("authScreen").classList.remove("active");
  document.getElementById("forgotScreen").classList.add("active");
});

document.getElementById("backToLoginBtn").addEventListener("click", () => {
  document.getElementById("forgotScreen").classList.remove("active");
  document.getElementById("authScreen").classList.add("active");
});

document.getElementById("sendResetBtn").addEventListener("click", async () => {
  const email = document.getElementById("forgotEmail").value.trim();
  if (!email) { showForgotMsg("Please enter your email.", false); return; }
  setLoading("sendResetBtn", true, "📧 Send Reset Link");
  try {
    await fetch("/api/forgot-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    showForgotMsg("If that email is registered, a reset link is on its way! Check your inbox.", true);
  } catch { showForgotMsg("Something went wrong. Please try again.", false); }
  finally { setLoading("sendResetBtn", false, "📧 Send Reset Link"); }
});

function showForgotMsg(text, success) {
  const el = document.getElementById("forgotMsg");
  el.textContent = text;
  el.style.background = success ? "rgba(76,175,80,0.15)" : "rgba(192,57,43,0.15)";
  el.style.border = success ? "1px solid rgba(76,175,80,0.4)" : "1px solid rgba(192,57,43,0.4)";
  el.style.color = success ? "#81c784" : "#ff8a7a";
  el.classList.remove("hidden");
}

function checkResetToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById("resetScreen").classList.add("active");
    window._resetToken = token;
  }
}

document.getElementById("doResetBtn").addEventListener("click", async () => {
  const newPass = document.getElementById("resetNewPass").value;
  const confirmPass = document.getElementById("resetConfirmPass").value;
  if (!newPass || !confirmPass) { showResetMsg("Please fill in both fields.", false); return; }
  if (newPass.length < 6) { showResetMsg("Password must be at least 6 characters.", false); return; }
  if (newPass !== confirmPass) { showResetMsg("Passwords don't match!", false); return; }
  setLoading("doResetBtn", true, "🔑 Set New Password");
  try {
    const res = await fetch("/api/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: window._resetToken, newPassword: newPass }) });
    const data = await res.json();
    if (res.ok) {
      showResetMsg("Password updated! You can now sign in.", true);
      setTimeout(() => { document.getElementById("resetScreen").classList.remove("active"); document.getElementById("authScreen").classList.add("active"); window.history.replaceState({}, "", "/"); }, 2000);
    } else { showResetMsg(data.error || "Reset failed. The link may have expired.", false); }
  } catch { showResetMsg("Something went wrong.", false); }
  finally { setLoading("doResetBtn", false, "🔑 Set New Password"); }
});

function showResetMsg(text, success) {
  const el = document.getElementById("resetMsg");
  el.textContent = text;
  el.style.background = success ? "rgba(76,175,80,0.15)" : "rgba(192,57,43,0.15)";
  el.style.border = success ? "1px solid rgba(76,175,80,0.4)" : "1px solid rgba(192,57,43,0.4)";
  el.style.color = success ? "#81c784" : "#ff8a7a";
  el.classList.remove("hidden");
}

// ==================== APP INIT ====================
let maintenancePollStarted = false;

async function showApp() {
  try {
    const res = await apiFetch("/api/admin/check");
    const data = await res.json();
    isAdmin = data.isAdmin;
    if (isAdmin && !document.querySelector('[data-view="admin"]')) {
      const nav = document.querySelector(".bottom-nav");
      const btn = document.createElement("button");
      btn.className = "nav-btn"; btn.dataset.view = "admin";
      btn.innerHTML = `<span class="nav-icon">🔧</span><span class="nav-label">Admin</span>`;
      nav.appendChild(btn);
      btn.addEventListener("click", () => {
        document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        openAdminPanel();
      });
    }
  } catch {}

  // Non-admins get bounced to the maintenance screen if it's switched on
  const blocked = await checkMaintenanceMode();
  if (blocked) return;

  document.getElementById("authScreen").classList.remove("active");
  document.getElementById("maintenanceScreen").classList.remove("active");
  document.getElementById("appScreen").classList.add("active");
  initMap();
  loadTrees();
  updateProfilePanel();
  captureUserPos();

  if (!maintenancePollStarted) {
    maintenancePollStarted = true;
    setInterval(checkMaintenanceMode, 60000);
  }
}

// Returns true if the current (non-admin) user has been shown the maintenance screen
async function checkMaintenanceMode() {
  try {
    const res = await fetch("/api/maintenance");
    const data = await res.json();
    const screen = document.getElementById("maintenanceScreen");
    if (data.enabled && !isAdmin) {
      document.getElementById("maintenanceMsg").textContent = (data.message && data.message.trim()) || "We're making some improvements to Windfall right now. Hang tight — we'll be back shortly!";
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      screen.classList.add("active");
      return true;
    }
    if (screen.classList.contains("active")) {
      screen.classList.remove("active");
      document.getElementById("appScreen").classList.add("active");
    }
    return false;
  } catch { return false; }
}

// ==================== MAP ====================
function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false }).setView([52.3704, -1.2655], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.on("click", (e) => {
    if (document.getElementById("reportPanel").classList.contains("open")) {
      document.getElementById("pinLat").value = e.latlng.lat.toFixed(6);
      document.getElementById("pinLng").value = e.latlng.lng.toFixed(6);
      placeTempMarker(e.latlng.lat, e.latlng.lng);
    }
  });
}

function placeTempMarker(lat, lng) {
  if (tempMarker) map.removeLayer(tempMarker);
  tempMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "temp-pin", html: `<div style="font-size:28px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5))">📍</div>`, iconAnchor: [14, 28] }) }).addTo(map);
}

function getStatusColor(s) { return s === "active" ? "#4CAF50" : s === "picked" ? "#3498db" : "#e74c3c"; }
function getFruitEmoji(t) { return ({ apple:"🍎", pear:"🍐", plum:"🟣", cherry:"🍒", other:"🌳" })[t] || "🌳"; }

function addTreeMarker(tree) {
  if (markers[tree.id]) map.removeLayer(markers[tree.id]);
  const color = getStatusColor(tree.status), emoji = getFruitEmoji(tree.type);
  const verifiedBadge = tree.verified ? `<div style="position:absolute;top:-3px;right:-3px;background:#4CAF50;border:1.5px solid #111d10;border-radius:50%;width:14px;height:14px;font-size:9px;display:flex;align-items:center;justify-content:center;color:white;">✓</div>` : "";
  const icon = L.divIcon({ className: "temp-pin", html: `<div style="position:relative;display:inline-block;"><div style="width:36px;height:36px;border-radius:50%;background:${color}22;border:2.5px solid ${color};box-shadow:0 0 10px ${color}88;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;">${emoji}</div>${verifiedBadge}</div>`, iconAnchor: [18,18], popupAnchor: [0,-20] });
  const marker = L.marker([tree.lat, tree.lng], { icon });
  const kgText = tree.estimatedKg > 0 ? `~${tree.estimatedKg}kg` : "";
  // Popup content is a function so the distance reflects the user's position at open time
  marker.bindPopup(() => {
    const dist = distanceLabel(tree);
    return `<div class="popup-title">${emoji} ${esc(capitalise(tree.type))} Tree</div><div class="popup-sub">${kgText ? esc(kgText) + " · " : ""}${esc(capitalise(tree.landType))} · by ${esc(tree.reportedByName)}${dist ? `<br/>📏 ${dist}` : ""}</div><button class="popup-btn" onclick="openTreePanel('${esc(tree.id)}')">View Details</button>`;
  });
  markers[tree.id] = marker;
  const typeOk = activeTypeFilter === "all" || tree.type === activeTypeFilter;
  const statusOk = activeStatusFilter === "all" || tree.status === activeStatusFilter;
  if (typeOk && statusOk) marker.addTo(map);
}

async function loadTrees() {
  try {
    const res = await fetch("/api/trees");
    allTrees = await res.json();
    allTrees.forEach(t => addTreeMarker(t));
    if (pendingTreeId) {
      const id = pendingTreeId; pendingTreeId = null;
      const tree = allTrees.find(t => t.id === id);
      if (tree) { map.setView([tree.lat, tree.lng], 16); openTreePanel(id); }
      else showToast("That tree is no longer on the map 🍂");
    }
  } catch { console.error("Could not load trees"); }
}

// ==================== FAB / REPORT ====================
function setupFAB() {
  document.getElementById("addTreeBtn").addEventListener("click", () => { openPanel("reportPanel"); showToast("Tap the map to drop a pin 📍"); });

  document.getElementById("useLocationBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { showToast("Geolocation not supported"); return; }
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      document.getElementById("pinLat").value = lat.toFixed(6);
      document.getElementById("pinLng").value = lng.toFixed(6);
      map.setView([lat, lng], 16);
      placeTempMarker(lat, lng);
      showToast("Location found! ✅");
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`);
        const d = await r.json();
        const addr = d.address;
        const street = [addr.house_number, addr.road, addr.suburb, addr.town || addr.city || addr.village].filter(Boolean).join(", ");
        document.getElementById("pinAddress").value = street || d.display_name?.split(",").slice(0,3).join(",") || "";
      } catch { document.getElementById("pinAddress").value = ""; }
    }, () => showToast("Could not get location"));
  });

  document.getElementById("submitTreeBtn").addEventListener("click", submitTree);
}

// Phone cameras produce 5-12MB images; shrink to ~100-200KB before upload so
// they fit comfortably in Redis and the AI checker's request body limit.
function compressImage(file, maxDim = 1024, quality = 0.72) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(b => resolve(b || file), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function submitTree() {
  const lat = document.getElementById("pinLat").value;
  const lng = document.getElementById("pinLng").value;
  const type = document.getElementById("treeType").value;
  const landType = document.getElementById("landType").value;
  const notes = document.getElementById("treeNotes").value;
  const estKg = document.getElementById("estKg").value;
  const address = document.getElementById("pinAddress").value;
  const photoFile = document.getElementById("treePhoto").files[0];
  const err = document.getElementById("reportError");
  err.classList.add("hidden");
  if (!lat || !lng) { showErr(err, "Please pick a location on the map or use your GPS."); return; }
  const fd = new FormData();
  fd.append("lat", lat); fd.append("lng", lng); fd.append("type", type);
  fd.append("landType", landType); fd.append("notes", notes);
  fd.append("estimatedKg", estKg || 0); fd.append("address", address || "");
  setLoading("submitTreeBtn", true, "Drop Pin 📍");
  if (photoFile) fd.append("photo", await compressImage(photoFile), "photo.jpg");
  try {
    const res = await fetch("/api/trees", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
    const tree = await res.json();
    if (!res.ok) { showErr(err, tree.error || "Failed to submit."); return; }
    allTrees.push(tree);
    addTreeMarker(tree);
    if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
    ["pinLat","pinLng","treeNotes","estKg","pinAddress"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("treePhoto").value = "";
    document.getElementById("aiCheckBtn").style.display = "none";
    const aiResult = document.getElementById("aiResult");
    aiResult.className = "ai-result hidden"; aiResult.innerHTML = "";
    closePanel("reportPanel");
    showToast(`${getFruitEmoji(tree.type)} Tree pinned! Thanks for rescuing fruit! 🌿`);
    currentUser.treesReported = (currentUser.treesReported || 0) + 1;
    updateProfilePanel();
  } catch { showErr(err, "Network error."); }
  finally { setLoading("submitTreeBtn", false, "Drop Pin 📍"); }
}

// ==================== TREE DETAIL ====================
function openTreePanel(treeId) {
  const tree = allTrees.find(t => t.id === treeId);
  if (!tree) return;
  map.closePopup();
  const emoji = getFruitEmoji(tree.type);
  document.getElementById("treePanelTitle").textContent = `${emoji} ${capitalise(tree.type)} Tree`;
  const pickupList = (tree.pickups || []).map(p => { const d = DEST_META[p.destination]; return `<div class="pickup-row"><span>${esc(p.byName)}</span><span>${d ? d[0] + " " : ""}${esc(p.kg)}kg · ${timeSince(p.at)}</span></div>`; }).join("") || "<p style='font-size:0.82rem;color:var(--text-muted)'>No pickups yet — be the first!</p>";
  const commentList = (tree.comments || []).map(c => `<div class="comment-row"><span class="comment-name" style="cursor:pointer" onclick="openUserProfile('${esc(c.userId)}')">${esc(c.userName)}</span><span class="comment-time">${timeSince(c.at)}</span><p class="comment-text">${esc(c.text)}</p></div>`).join("") || "<p style='font-size:0.82rem;color:var(--text-muted)'>No comments yet — leave a note!</p>";
  document.getElementById("treePanelBody").innerHTML = `
    ${tree.photo ? `<img src="${esc(tree.photo)}" class="tree-detail-photo" alt="Tree photo" onerror="this.remove()" />` : ""}
    <div class="tree-meta">
      <span class="tree-chip">${emoji} ${esc(capitalise(tree.type))}</span>
      <span class="tree-chip">📍 ${esc(capitalise(tree.landType))}</span>
      ${tree.estimatedKg > 0 ? `<span class="tree-chip">~${esc(tree.estimatedKg)}kg</span>` : ""}
      <span class="tree-status-chip status-${esc(tree.status)}">${esc(capitalise(tree.status))}</span>
      ${distanceLabel(tree) ? `<span class="tree-chip">📏 ${distanceLabel(tree)}</span>` : ""}
      ${tree.verified ? '<span class="tree-chip" style="background:rgba(76,175,80,0.15);color:#81c784;border-color:rgba(76,175,80,0.35);">✅ Verified</span>' : ""}
    </div>
    ${tree.notes ? `<p class="tree-notes">"${esc(tree.notes)}"</p>` : ""}
    <div style="font-size:0.8rem;color:var(--text-muted)">Reported by ${esc(tree.reportedByName)} · ${timeSince(tree.reportedAt)}${tree.address ? `<br/>📍 ${esc(tree.address)}` : ""}</div>
    <div style="display:flex;gap:10px;">
      <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(tree.lat)},${encodeURIComponent(tree.lng)}" target="_blank" rel="noopener" class="btn-secondary" style="flex:1;text-align:center;text-decoration:none;display:block;padding:10px 14px;font-size:0.9rem;">🗺️ Directions</a>
      <button class="btn-secondary" style="flex:1;padding:10px 14px;font-size:0.9rem;" onclick="shareTree('${esc(tree.id)}')">📤 Share Tree</button>
    </div>
    <div>
      <h3 style="font-family:'Fraunces',serif;font-size:0.95rem;color:var(--text-sub);margin-bottom:8px;">Update Status</h3>
      <div class="status-btn-row">
        <button class="status-btn${tree.status==='active'?' active':''}" onclick="updateTreeStatus('${tree.id}','active')">🌿 Ready</button>
        <button class="status-btn${tree.status==='picked'?' active':''}" onclick="updateTreeStatus('${tree.id}','picked')">✅ Picked</button>
        <button class="status-btn${tree.status==='rotten'?' active':''}" onclick="updateTreeStatus('${tree.id}','rotten')">🍂 Rotten</button>
      </div>
    </div>
    <div class="tree-pickup-form">
      <h3 style="font-family:'Fraunces',serif;font-size:1rem;color:var(--text-sub)">Log a Pickup</h3>
      <input type="number" id="pickupKg" placeholder="How many kg did you rescue?" min="0" step="0.5" />
      <select id="pickupDest">
        <option value="eaten">🍎 Eaten fresh</option>
        <option value="animals">🐾 Animal feed / sanctuary</option>
        <option value="juice">🍾 Juice or cider</option>
        <option value="baking">🥧 Baking &amp; cooking</option>
        <option value="donated">🤝 Donated / shared</option>
      </select>
      <button class="btn-primary btn-sm" onclick="logPickup('${tree.id}')">✅ Log Pickup</button>
    </div>
    <div>
      <h3 style="font-family:'Fraunces',serif;font-size:1rem;color:var(--text-sub);margin-bottom:8px">Pickup History</h3>
      <div class="pickup-history">${pickupList}</div>
    </div>
    <div>
      <h3 style="font-family:'Fraunces',serif;font-size:1rem;color:var(--text-sub);margin-bottom:8px">💬 Comments</h3>
      <div class="comment-list" id="commentList-${tree.id}">${commentList}</div>
      <div class="comment-form">
        <textarea id="commentText-${tree.id}" placeholder="Leave a note about this tree..." rows="2"></textarea>
        <button class="btn-secondary btn-sm" onclick="addComment('${tree.id}')">Post Comment</button>
      </div>
    </div>`;
  openPanel("treePanel");
}
window.openTreePanel = openTreePanel;

async function shareTree(treeId) {
  const tree = allTrees.find(t => t.id === treeId);
  const url = `${location.origin}/tree/${treeId}`;
  const title = tree ? `${getFruitEmoji(tree.type)} ${capitalise(tree.type)} tree on Windfall` : "A fruit tree on Windfall";
  if (navigator.share) {
    try { await navigator.share({ title, text: `${title} — come help rescue the fruit! 🌿`, url }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); showToast("🔗 Link copied — send it to a friend!"); }
  catch { prompt("Copy this link:", url); }
}
window.shareTree = shareTree;

const DEST_META = {
  eaten:   ["🍎", "Eaten fresh"],
  animals: ["🐾", "Animal feed"],
  juice:   ["🍾", "Juice & cider"],
  baking:  ["🥧", "Baking"],
  donated: ["🤝", "Donated"]
};

async function logPickup(treeId) {
  const kg = parseFloat(document.getElementById("pickupKg").value) || 0;
  if (kg <= 0) { showToast("Enter how many kg you rescued!"); return; }
  const destination = document.getElementById("pickupDest")?.value || "eaten";
  try {
    const res = await apiFetch(`/api/trees/${treeId}/pickup`, { method: "PATCH", body: JSON.stringify({ kg, destination }) });
    const updated = await res.json();
    if (!res.ok) { showToast(updated.error || "Failed to log pickup"); return; }
    const idx = allTrees.findIndex(t => t.id === treeId);
    if (idx !== -1) allTrees[idx] = updated;
    addTreeMarker(updated);
    closePanel("treePanel");
    showToast(`🎉 ${kg}kg rescued! You're a hero!`);
    currentUser.kgRescued = (currentUser.kgRescued || 0) + kg;
    currentUser.pickups = (currentUser.pickups || 0) + 1;
    updateProfilePanel();
  } catch { showToast("Failed to log pickup"); }
}
window.logPickup = logPickup;

async function updateTreeStatus(treeId, status) {
  try {
    const res = await apiFetch(`/api/trees/${treeId}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (!res.ok) { showToast("Failed to update status"); return; }
    const updated = await res.json();
    const idx = allTrees.findIndex(t => t.id === treeId);
    if (idx !== -1) allTrees[idx] = updated;
    addTreeMarker(updated);
    applyFilters();
    openTreePanel(treeId);
    showToast("Status updated! ✅");
  } catch { showToast("Failed to update status"); }
}
window.updateTreeStatus = updateTreeStatus;

async function addComment(treeId) {
  const textarea = document.getElementById(`commentText-${treeId}`);
  const text = textarea ? textarea.value.trim() : "";
  if (!text) { showToast("Type a comment first!"); return; }
  try {
    const res = await apiFetch(`/api/trees/${treeId}/comments`, { method: "POST", body: JSON.stringify({ text }) });
    const comment = await res.json();
    if (!res.ok) { showToast(comment.error || "Failed to post comment"); return; }
    const treeIdx = allTrees.findIndex(t => t.id === treeId);
    if (treeIdx !== -1) {
      if (!allTrees[treeIdx].comments) allTrees[treeIdx].comments = [];
      allTrees[treeIdx].comments.push(comment);
    }
    textarea.value = "";
    const listEl = document.getElementById(`commentList-${treeId}`);
    if (listEl) {
      const comments = allTrees[treeIdx]?.comments || [];
      listEl.innerHTML = comments.map(c => `<div class="comment-row"><span class="comment-name" style="cursor:pointer" onclick="openUserProfile('${esc(c.userId)}')">${esc(c.userName)}</span><span class="comment-time">${timeSince(c.at)}</span><p class="comment-text">${esc(c.text)}</p></div>`).join("");
    }
    showToast("Comment posted! 💬");
  } catch { showToast("Failed to post comment"); }
}
window.addComment = addComment;

// ==================== PROFILE ====================
function setupProfileBtn() {
  document.getElementById("profileBtn").addEventListener("click", () => { updateProfilePanel(); openPanel("profilePanel"); });
  document.getElementById("changePassBtn").addEventListener("click", async () => {
    const newPass = document.getElementById("newPass").value;
    const confirmPass = document.getElementById("confirmNewPass").value;
    const msg = document.getElementById("changePassMsg");
    msg.classList.add("hidden");
    if (!newPass || !confirmPass) { showPassMsg("Please fill in both fields.", false); return; }
    if (newPass.length < 6) { showPassMsg("Password must be at least 6 characters.", false); return; }
    if (newPass !== confirmPass) { showPassMsg("Passwords don't match!", false); return; }
    try {
      const res = await apiFetch("/api/change-password", { method: "POST", body: JSON.stringify({ newPassword: newPass }) });
      const data = await res.json();
      if (res.ok) { showPassMsg("✅ Password updated!", true); document.getElementById("newPass").value = ""; document.getElementById("confirmNewPass").value = ""; }
      else { showPassMsg(data.error || "Failed to update password.", false); }
    } catch { showPassMsg("Something went wrong.", false); }
  });
}

function showPassMsg(text, success) {
  const el = document.getElementById("changePassMsg");
  el.textContent = text;
  el.style.background = success ? "rgba(76,175,80,0.15)" : "rgba(192,57,43,0.15)";
  el.style.border = success ? "1px solid rgba(76,175,80,0.4)" : "1px solid rgba(192,57,43,0.4)";
  el.style.color = success ? "#81c784" : "#ff8a7a";
  el.classList.remove("hidden");
}

function updateProfilePanel() {
  if (!currentUser) return;
  document.getElementById("profileName").textContent = currentUser.name || "";
  document.getElementById("profileEmail").textContent = currentUser.email || "";
  document.getElementById("statKg").textContent = (currentUser.kgRescued || 0).toFixed(1);
  document.getElementById("statTrees").textContent = Math.max(allTrees.filter(t => t.reportedBy === currentUser.id).length, currentUser.treesReported || 0);
  document.getElementById("statPickups").textContent = currentUser.pickups || 0;
  const badgeMap = {
    "developer": ["⚙️", "Developer"],
    "admin": ["👑", "Admin"],
    "tree-scout":["🌱","Tree Scout"],
    "orchard-mapper":["🗺️","Orchard Mapper"],
    "apple-saver":["🍎","Apple Saver"],
    "animal-hero":["🐾","Animal Hero"],
    "windfall-legend":["👑","Windfall Legend"],
    "gleaner":["🧺","Gleaner"]
  };
  const bc = document.getElementById("badgesContainer");
  const badges = currentUser.badges || [];
  bc.innerHTML = badges.length === 0 ? `<p class="no-badges">Report your first tree to earn a badge! 🌱</p>` : badges.map(b => { const [icon, name] = badgeMap[b] || ["⭐", b]; return `<div class="badge">${icon} ${name}</div>`; }).join("");
}

// ==================== LEADERBOARD ====================
function setupLeaderboardBtn() {
  document.getElementById("updatesBtn").addEventListener("click", openUpdatesPanel);
  document.getElementById("leaderboardBtn").addEventListener("click", openLeaderboard);
}

async function openLeaderboard() {
  try {
    const res = await fetch("/api/leaderboard");
    const data = await res.json();
    lastLeaderboardUsers = { users: data.users, totalKg: data.totalKg };
    document.getElementById("leaderboardSearch").value = "";
    renderLeaderboard("");
    openPanel("leaderboardPanel");
  } catch { showToast("Could not load rankings"); }
}

function renderLeaderboard(filter) {
  if (!lastLeaderboardUsers) return;
  const { users, totalKg } = lastLeaderboardUsers;
  const medals = ["gold","silver","bronze"];
  const q = (filter || "").toLowerCase();
  // Keep original ranks (and medals) even when the list is filtered
  const visible = users.map((u, i) => ({ u, i })).filter(({ u }) => !q || u.name.toLowerCase().includes(q));

  // Community impact: where the rescued fruit actually went
  const destTotals = {};
  allTrees.forEach(t => (t.pickups || []).forEach(p => {
    const d = p.destination || "eaten";
    destTotals[d] = (destTotals[d] || 0) + (p.kg || 0);
  }));
  const destChips = Object.entries(destTotals)
    .filter(([, kg]) => kg > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([d, kg]) => { const [icon, label] = DEST_META[d] || ["🍏", d]; return `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(74,124,63,0.18);border:1px solid var(--border);border-radius:100px;padding:4px 10px;font-size:0.75rem;color:var(--text-sub);">${icon} ${label}: <strong style="color:var(--green-light);">${kg.toFixed(1)}kg</strong></span>`; })
    .join(" ");

  document.getElementById("leaderboardList").innerHTML = `
    <div style="background:rgba(74,124,63,0.15);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;text-align:center;margin-bottom:8px;">
      <div style="font-family:'Fraunces',serif;font-size:2rem;font-weight:900;color:var(--green-light);">${(totalKg||0).toFixed(1)}kg</div>
      <div style="font-size:0.8rem;color:var(--text-sub);margin-top:4px;">total fruit rescued by Warwickshire community 🍎</div>
      ${destChips ? `<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px;">${destChips}</div>` : ""}
    </div>
    ${visible.length === 0
      ? `<p style="color:var(--text-muted);text-align:center">${q ? "No rescuers match that search 🔍" : "No rescuers yet — be first! 🍎"}</p>`
      : visible.map(({ u, i }) => `
        <div class="leader-row">
          <div class="leader-rank ${medals[i]||""}">${i===0?"🥇":i===1?"🥈":i===2?"🥉":i+1}</div>
          <div class="leader-info">
            <div class="leader-name" style="cursor:pointer" onclick="openUserProfile('${esc(u.id)}')">${esc(u.name)} ${u.email === "akhilakella@outlook.com" ? '<span style="font-size:0.7rem;background:rgba(212,168,67,0.2);color:var(--gold);border:1px solid rgba(212,168,67,0.4);border-radius:100px;padding:2px 8px;margin-left:4px;">👑 Dev</span>' : ""}</div>
            <div class="leader-sub">${u.treesReported} trees · ${u.pickups} pickups</div>
          </div>
          <div class="leader-kg">${u.kgRescued.toFixed(1)}kg</div>
        </div>`).join("")}`;
}

// ==================== MY TREES ====================
function openMyTrees() {
  document.getElementById("myTreesSearch").value = "";
  renderMyTrees();
  openPanel("myTreesPanel");
}
window.openMyTrees = openMyTrees;

function renderMyTrees() {
  const q = document.getElementById("myTreesSearch").value.trim().toLowerCase();
  const sort = document.getElementById("myTreesSort").value;
  let mine = allTrees.filter(t => t.reportedBy === currentUser.id);
  if (q) mine = mine.filter(t => [t.type, t.notes, t.address, t.status].some(f => (f || "").toLowerCase().includes(q)));
  if (sort === "newest") mine.sort((a, b) => b.reportedAt - a.reportedAt);
  else if (sort === "oldest") mine.sort((a, b) => a.reportedAt - b.reportedAt);
  else if (sort === "type") mine.sort((a, b) => a.type.localeCompare(b.type));
  else if (sort === "nearest" && userPos) mine.sort((a, b) => distanceKm(userPos.lat, userPos.lng, a.lat, a.lng) - distanceKm(userPos.lat, userPos.lng, b.lat, b.lng));
  document.getElementById("myTreesList").innerHTML = mine.length === 0
    ? `<p style="color:var(--text-muted);text-align:center">${q ? "No trees match that search 🔍" : "You haven't reported any trees yet!<br><br>Tap the ＋ button to get started. 🌱"}</p>`
    : mine.map(t => { const dist = distanceLabel(t); return `<div class="my-tree-card" onclick="openTreePanel('${esc(t.id)}');closePanel('myTreesPanel')"><div class="my-tree-header"><span class="my-tree-type">${getFruitEmoji(t.type)} ${esc(capitalise(t.type))} Tree</span><span class="my-tree-date">${timeSince(t.reportedAt)}</span></div><div class="my-tree-notes">${t.notes ? esc(t.notes) : "No notes"}${dist ? ` · 📏 ${dist}` : ""}</div></div>`; }).join("");
}

// ==================== FILTERS ====================
function setupFilters() {
  document.querySelectorAll(".filter-pill[data-filter-type]").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".filter-pill[data-filter-type]").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      activeTypeFilter = pill.dataset.filterType;
      applyFilters();
    });
  });
  document.querySelectorAll(".filter-pill[data-filter-status]").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".filter-pill[data-filter-status]").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      activeStatusFilter = pill.dataset.filterStatus;
      applyFilters();
    });
  });
}

function applyFilters() {
  if (!map) return;
  allTrees.forEach(tree => {
    const marker = markers[tree.id];
    if (!marker) return;
    const typeOk = activeTypeFilter === "all" || tree.type === activeTypeFilter;
    const statusOk = activeStatusFilter === "all" || tree.status === activeStatusFilter;
    if (typeOk && statusOk) { if (!map.hasLayer(marker)) marker.addTo(map); }
    else { if (map.hasLayer(marker)) map.removeLayer(marker); }
  });
}

// ==================== HEATMAP ====================
function toggleHeatmap() {
  if (!map) return;
  if (typeof L.heatLayer !== "function") { showToast("Heatmap not loaded yet — try again in a moment"); return; }
  heatmapActive = !heatmapActive;
  const btn = document.getElementById("heatmapBtn");
  if (heatmapActive) {
    // Build intensity points: use actual kg rescued, fall back to estimatedKg, then default 5
    const points = allTrees.map(t => {
      const kgTotal = (t.pickups || []).reduce((s, p) => s + (p.kg || 0), 0) || t.estimatedKg || 5;
      return [t.lat, t.lng, Math.min(kgTotal / 30, 1.0)];
    });
    if (!heatLayer) {
      heatLayer = L.heatLayer(points, {
        radius: 38, blur: 28, maxZoom: 17,
        gradient: { 0.0: "#0d2b0d", 0.35: "#2d6a2d", 0.6: "#6abf6a", 1.0: "#d4e84c" }
      });
    } else {
      heatLayer.setLatLngs(points);
    }
    heatLayer.addTo(map);
    // Hide individual markers while heatmap is on
    Object.values(markers).forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
    btn.style.background = "rgba(74,124,63,0.55)";
    btn.style.borderRadius = "8px";
    btn.title = "Hide heatmap";
    showToast("🌡️ Heatmap on — brighter = more fruit");
  } else {
    if (heatLayer) map.removeLayer(heatLayer);
    applyFilters(); // restore markers
    btn.style.background = "";
    btn.style.borderRadius = "";
    btn.title = "Show heatmap";
    showToast("Heatmap off");
  }
}
window.toggleHeatmap = toggleHeatmap;

// ==================== NAV ====================
function setupNavButtons() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      closeAllPanels();
      if (view === "map") {}
      else if (view === "mytrees") openMyTrees();
      else if (view === "leaderboard") openLeaderboard();
      else if (view === "profile") { updateProfilePanel(); openPanel("profilePanel"); }
      else if (view === "ai") openAiCheckerPanel();
      else if (view === "contact") openPanel("contactPanel");
    });
  });
}

// ==================== PANELS ====================
function setupPanelCloses() {
  [["closeReport","reportPanel"],["closeTree","treePanel"],["closeProfile","profilePanel"],["closeLeaderboard","leaderboardPanel"],["closeMyTrees","myTreesPanel"],["closeContact","contactPanel"],["closeAdmin","adminPanel"],["closeUpdates","updatesPanel"],["closeUserProfile","userProfilePanel"],["closeAiChecker","aiCheckerPanel"]].forEach(([btnId, panelId]) => {
    document.getElementById(btnId).addEventListener("click", () => closePanel(panelId));
  });
  document.getElementById("overlay").addEventListener("click", closeAllPanels);
}

function openPanel(id) { closeAllPanels(); document.getElementById(id).classList.add("open"); document.getElementById("overlay").classList.remove("hidden"); }
function closePanel(id) { document.getElementById(id).classList.remove("open"); document.getElementById("overlay").classList.add("hidden"); }
function closeAllPanels() { document.querySelectorAll(".panel").forEach(p => p.classList.remove("open")); document.getElementById("overlay").classList.add("hidden"); }
window.closePanel = closePanel;

// ==================== ADMIN ====================
function setupAdminTabs() {
  document.querySelectorAll("[data-admin-tab]").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-admin-tab]").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".admin-tab-content").forEach(c => c.style.display = "none");
      tab.classList.add("active");
      const name = tab.dataset.adminTab;
      document.getElementById(`adminTab-${name}`).style.display = "flex";
      if (name === "requests") loadAdminRequests();
      if (name === "analytics") loadAdminAnalytics();
      if (name === "trees") loadAdminTrees();
      if (name === "announce") loadAdminAnnouncements();
      if (name === "maintenance") loadMaintenanceStatus();
      if (name === "danger") loadAdminUsers();
    });
  });

  document.getElementById("resetStatsBtn").addEventListener("click", async () => {
    if (!confirm("Reset ALL users stats? Cannot be undone!")) return;
    try {
      const res = await apiFetch("/api/admin/reset-stats", { method: "POST" });
      if (res.ok) { showToast("✅ All stats reset!"); currentUser.kgRescued = 0; currentUser.pickups = 0; currentUser.treesReported = 0; currentUser.badges = []; updateProfilePanel(); }
      else showToast("Failed to reset stats");
    } catch { showToast("Error resetting stats"); }
  });

  document.getElementById("postAnnouncementBtn").addEventListener("click", async () => {
    const title = document.getElementById("announcementTitle").value.trim();
    const body = document.getElementById("announcementBody").value.trim();
    if (!title || !body) { showToast("Title and body are required"); return; }
    try {
      const res = await apiFetch("/api/admin/announcements", { method: "POST", body: JSON.stringify({ title, body }) });
      if (res.ok) {
        document.getElementById("announcementTitle").value = "";
        document.getElementById("announcementBody").value = "";
        showToast("📢 Update posted!");
        loadAdminAnnouncements();
      } else showToast("Failed to post update");
    } catch { showToast("Error posting update"); }
  });

  document.getElementById("toggleMaintenanceBtn").addEventListener("click", async () => {
    const btn = document.getElementById("toggleMaintenanceBtn");
    const enabling = btn.dataset.enabled !== "1";
    const message = document.getElementById("maintenanceMessageInput").value.trim();
    if (enabling && !confirm("Turn maintenance mode ON? Other users will see a 'we're working on it' screen instead of the app. You'll still have full access to everything.")) return;
    try {
      const res = await apiFetch("/api/admin/maintenance", { method: "POST", body: JSON.stringify({ enabled: enabling, message }) });
      if (res.ok) {
        showToast(enabling ? "🚧 Maintenance mode is ON" : "✅ Maintenance mode is OFF");
        loadMaintenanceStatus();
      } else showToast("Failed to update maintenance mode");
    } catch { showToast("Error updating maintenance mode"); }
  });
}

async function loadMaintenanceStatus() {
  try {
    const res = await apiFetch("/api/maintenance");
    const data = await res.json();
    const statusText = document.getElementById("maintenanceStatusText");
    const btn = document.getElementById("toggleMaintenanceBtn");
    const box = document.getElementById("maintenanceStatusBox");
    document.getElementById("maintenanceMessageInput").value = data.message || "";
    if (data.enabled) {
      statusText.textContent = "🔴 ON — visitors see the maintenance screen, you still have full access";
      box.style.background = "rgba(192,57,43,0.1)";
      box.style.border = "1px solid rgba(192,57,43,0.3)";
      btn.textContent = "✅ Turn Maintenance Mode Off";
      btn.className = "btn-secondary";
    } else {
      statusText.textContent = "🟢 OFF — everyone can use the app as normal";
      box.style.background = "rgba(76,175,80,0.1)";
      box.style.border = "1px solid rgba(76,175,80,0.3)";
      btn.textContent = "🚧 Turn Maintenance Mode On";
      btn.className = "btn-primary";
    }
    btn.dataset.enabled = data.enabled ? "1" : "0";
  } catch { showToast("Could not load maintenance status"); }
}

async function loadAdminRequests() {
  try {
    const res = await apiFetch("/api/admin/requests");
    const data = await res.json();
    document.getElementById("adminRequestsList").innerHTML = data.length === 0
      ? `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">No pending requests 🎉</p>`
      : data.map(u => `
          <div class="my-tree-card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <div>
              <div class="my-tree-type" style="font-size:0.9rem;">${esc(u.name)}</div>
              <div class="my-tree-notes">${esc(u.email)} · ${timeSince(u.joinedAt)}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button onclick="approveUser('${esc(u.id)}')" style="background:rgba(76,175,80,0.2);border:1px solid rgba(76,175,80,0.4);color:#81c784;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">✅ Approve</button>
              <button onclick="rejectUser('${esc(u.id)}', ${JSON.stringify(esc(u.name))})" style="background:rgba(192,57,43,0.2);border:1px solid rgba(192,57,43,0.4);color:#ff8a7a;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">✕ Reject</button>
            </div>
          </div>`).join("");
  } catch { showToast("Could not load requests"); }
}

async function approveUser(userId) {
  try {
    const res = await apiFetch(`/api/admin/approve/${userId}`, { method: "POST" });
    if (res.ok) { showToast("✅ User approved!"); loadAdminRequests(); }
    else showToast("Failed to approve user");
  } catch { showToast("Error approving user"); }
}
window.approveUser = approveUser;

async function rejectUser(userId, userName) {
  if (!confirm(`Reject and delete "${userName}"?`)) return;
  try {
    const res = await apiFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) { showToast(`🗑 ${userName} rejected`); loadAdminRequests(); }
    else showToast("Failed to reject user");
  } catch { showToast("Error rejecting user"); }
}
window.rejectUser = rejectUser;

async function loadAdminAnalytics() {
  try {
    const res = await apiFetch("/api/admin/analytics");
    const data = await res.json();
    lastAnalytics = data; // stored for year card generation
    document.getElementById("aStat-kg").textContent = (data.totalKg || 0).toFixed(1);
    document.getElementById("aStat-trees").textContent = data.totalTrees || 0;
    document.getElementById("aStat-users").textContent = data.totalUsers || 0;
    document.getElementById("adminTopUsers").innerHTML = (data.topUsers || []).length === 0
      ? `<p style="color:var(--text-muted);font-size:0.85rem">No users yet</p>`
      : data.topUsers.map((u, i) => `<div class="leader-row"><div class="leader-rank">${i+1}</div><div class="leader-info"><div class="leader-name">${esc(u.name)}</div><div class="leader-sub">${u.treesReported} trees · ${u.pickups} pickups</div></div><div class="leader-kg">${u.kgRescued.toFixed(1)}kg</div></div>`).join("");
  } catch { showToast("Could not load analytics"); }
}

function loadAdminTrees() {
  document.getElementById("adminTreesList").innerHTML = allTrees.length === 0
    ? `<p style="color:var(--text-muted);text-align:center">No trees yet.</p>`
    : allTrees.map(t => `
        <div class="my-tree-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <div>
              <div class="my-tree-type">${getFruitEmoji(t.type)} ${esc(capitalise(t.type))}</div>
              <div class="my-tree-notes">by ${esc(t.reportedByName)} · ${esc(t.address || "No address")}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button onclick="toggleVerifyTree('${esc(t.id)}', ${!t.verified})" title="${t.verified ? 'Remove verification' : 'Mark as verified'}" style="background:${t.verified ? 'rgba(212,168,67,0.2)' : 'rgba(76,175,80,0.2)'};border:1px solid ${t.verified ? 'rgba(212,168,67,0.4)' : 'rgba(76,175,80,0.4)'};color:${t.verified ? 'var(--gold)' : '#81c784'};border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">${t.verified ? '🔓' : '✅'}</button>
              <button onclick="openEditTree('${esc(t.id)}')" style="background:rgba(74,124,63,0.2);border:1px solid var(--border);color:var(--green-light);border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">✏️</button>
              <button onclick="deleteTree('${esc(t.id)}')" style="background:rgba(192,57,43,0.2);border:1px solid rgba(192,57,43,0.4);color:#ff8a7a;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">🗑</button>
            </div>
          </div>
          <div id="editForm-${esc(t.id)}" style="display:none;flex-direction:column;gap:8px;margin-top:8px;border-top:1px solid var(--border);padding-top:8px;">
            <input type="text" id="editNotes-${esc(t.id)}" value="${esc(t.notes||"")}" placeholder="Notes" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-main);font-family:'DM Sans',sans-serif;font-size:0.85rem;outline:none;" />
            <input type="text" id="editAddress-${esc(t.id)}" value="${esc(t.address||"")}" placeholder="Address" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-main);font-family:'DM Sans',sans-serif;font-size:0.85rem;outline:none;" />
            <input type="number" id="editKg-${esc(t.id)}" value="${esc(t.estimatedKg||0)}" placeholder="Estimated kg" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-main);font-family:'DM Sans',sans-serif;font-size:0.85rem;outline:none;" />
            <button onclick="saveEditTree('${esc(t.id)}')" class="btn-primary btn-sm">💾 Save</button>
          </div>
        </div>`).join("");
}

function openEditTree(treeId) {
  const form = document.getElementById(`editForm-${treeId}`);
  form.style.display = form.style.display === "none" ? "flex" : "none";
}
window.openEditTree = openEditTree;

async function saveEditTree(treeId) {
  const notes = document.getElementById(`editNotes-${treeId}`).value;
  const address = document.getElementById(`editAddress-${treeId}`).value;
  const estimatedKg = document.getElementById(`editKg-${treeId}`).value;
  try {
    const res = await apiFetch(`/api/admin/trees/${treeId}`, { method: "PATCH", body: JSON.stringify({ notes, address, estimatedKg }) });
    if (res.ok) { const updated = await res.json(); const idx = allTrees.findIndex(t => t.id === treeId); if (idx !== -1) allTrees[idx] = updated; addTreeMarker(updated); showToast("✅ Tree updated!"); loadAdminTrees(); }
    else showToast("Failed to update tree");
  } catch { showToast("Error updating tree"); }
}
window.saveEditTree = saveEditTree;

async function deleteTree(treeId) {
  if (!confirm("Delete this tree from the map?")) return;
  try {
    const res = await apiFetch(`/api/trees/${treeId}`, { method: "DELETE" });
    if (res.ok) { allTrees = allTrees.filter(t => t.id !== treeId); if (markers[treeId]) { map.removeLayer(markers[treeId]); delete markers[treeId]; } showToast("🗑 Tree deleted!"); loadAdminTrees(); }
    else showToast("Failed to delete tree");
  } catch { showToast("Error deleting tree"); }
}
window.deleteTree = deleteTree;

async function toggleVerifyTree(treeId, verified) {
  try {
    const res = await apiFetch(`/api/admin/trees/${treeId}`, { method: "PATCH", body: JSON.stringify({ verified }) });
    if (res.ok) {
      const updated = await res.json();
      const idx = allTrees.findIndex(t => t.id === treeId);
      if (idx !== -1) allTrees[idx] = updated;
      addTreeMarker(updated);
      applyFilters();
      loadAdminTrees();
      showToast(verified ? "✅ Tree verified!" : "🔓 Verification removed");
    } else showToast("Failed to update tree");
  } catch { showToast("Error updating tree"); }
}
window.toggleVerifyTree = toggleVerifyTree;

async function loadAdminUsers() {
  try {
    const res = await apiFetch("/api/admin/users");
    const users = await res.json();
    document.getElementById("adminUsersList").innerHTML = users.length === 0
      ? `<p style="color:var(--text-muted);font-size:0.85rem">No approved users yet</p>`
      : users.map(u => `
          <div class="my-tree-card" style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div class="my-tree-type" style="font-size:0.9rem;">${esc(u.name)}</div>
              <div class="my-tree-notes">${esc(u.email)} · ${u.kgRescued.toFixed(1)}kg · ${u.treesReported} trees</div>
            </div>
            ${u.email !== "akhilakella@outlook.com" ? `<button onclick="deleteUser('${esc(u.id)}', ${JSON.stringify(esc(u.name))})" style="background:rgba(192,57,43,0.2);border:1px solid rgba(192,57,43,0.4);color:#ff8a7a;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;flex-shrink:0;margin-left:10px;">🗑</button>` : `<span style="font-size:0.75rem;color:var(--gold);flex-shrink:0;">👑 Admin</span>`}
          </div>`).join("");
  } catch { showToast("Could not load users"); }
}

async function deleteUser(userId, userName) {
  if (!confirm(`Delete user "${userName}"? Cannot be undone!`)) return;
  try {
    const res = await apiFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) { showToast(`🗑 ${userName} deleted`); loadAdminUsers(); }
    else showToast("Failed to delete user");
  } catch { showToast("Error deleting user"); }
}
window.deleteUser = deleteUser;

async function loadAdminAnnouncements() {
  try {
    const res = await fetch("/api/announcements");
    const posts = await res.json();
    document.getElementById("adminAnnouncementsList").innerHTML = posts.length === 0
      ? `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">No updates posted yet.</p>`
      : posts.map(p => `
          <div class="my-tree-card" style="gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div class="my-tree-type" style="font-size:0.9rem;">${esc(p.title)}</div>
                <div class="my-tree-notes">${timeSince(p.postedAt)}</div>
              </div>
              <button onclick="deleteAnnouncement('${esc(p.id)}')" style="background:rgba(192,57,43,0.2);border:1px solid rgba(192,57,43,0.4);color:#ff8a7a;border-radius:8px;padding:4px 9px;font-size:0.78rem;cursor:pointer;flex-shrink:0;margin-left:8px;">🗑</button>
            </div>
            <div class="my-tree-notes" style="margin-top:4px;">${esc(p.body)}</div>
          </div>`).join("");
  } catch {}
}

async function deleteAnnouncement(id) {
  try {
    const res = await apiFetch(`/api/admin/announcements/${id}`, { method: "DELETE" });
    if (res.ok) { showToast("🗑 Update deleted"); loadAdminAnnouncements(); }
    else showToast("Failed to delete");
  } catch { showToast("Error deleting update"); }
}
window.deleteAnnouncement = deleteAnnouncement;

async function openUpdatesPanel() {
  try {
    const res = await fetch("/api/announcements");
    const posts = await res.json();
    document.getElementById("updatesList").innerHTML = posts.length === 0
      ? `<p style="color:var(--text-muted);text-align:center;">No updates yet — check back soon! 🌿</p>`
      : posts.map(p => `
          <div class="my-tree-card" style="cursor:default;">
            <div class="my-tree-header">
              <span class="my-tree-type">${esc(p.title)}</span>
              <span class="my-tree-date">${timeSince(p.postedAt)}</span>
            </div>
            <div class="my-tree-notes" style="margin-top:4px;line-height:1.5;">${esc(p.body)}</div>
          </div>`).join("");
  } catch { showToast("Could not load updates"); return; }
  openPanel("updatesPanel");
}

// ==================== USER PROFILE ====================
async function openUserProfile(userId) {
  if (!userId) return;
  try {
    const res = await apiFetch(`/api/users/${userId}/profile`);
    if (!res.ok) { showToast("Could not load profile"); return; }
    const u = await res.json();
    const badgeMap = { "developer":["⚙️","Developer"],"admin":["👑","Admin"],"tree-scout":["🌱","Tree Scout"],"orchard-mapper":["🗺️","Orchard Mapper"],"apple-saver":["🍎","Apple Saver"],"animal-hero":["🐾","Animal Hero"],"windfall-legend":["👑","Windfall Legend"],"gleaner":["🧺","Gleaner"] };
    const treesAdded = allTrees.filter(t => t.reportedBy === userId);
    const badgesHtml = (u.badges || []).length === 0
      ? `<p style="font-size:0.85rem;color:var(--text-muted)">No badges yet</p>`
      : (u.badges || []).map(b => { const [icon, name] = badgeMap[b] || ["⭐", b]; return `<div class="badge">${icon} ${name}</div>`; }).join("");
    document.getElementById("userProfileBody").innerHTML = `
      <div class="profile-card">
        <div class="profile-avatar">${esc((u.name||"?").charAt(0).toUpperCase())}</div>
        <div class="profile-name">${esc(u.name)}</div>
        <div class="profile-email">Joined ${timeSince(u.joinedAt)}</div>
      </div>
      <div class="stats-row">
        <div class="stat-box"><div class="stat-num">${(u.kgRescued||0).toFixed(1)}</div><div class="stat-lbl">kg rescued</div></div>
        <div class="stat-box"><div class="stat-num">${treesAdded.length}</div><div class="stat-lbl">trees mapped</div></div>
        <div class="stat-box"><div class="stat-num">${u.pickups||0}</div><div class="stat-lbl">pickups</div></div>
      </div>
      <div class="badges-section"><h3>Badges</h3><div class="badges-grid">${badgesHtml}</div></div>
      ${treesAdded.length > 0 ? `
      <div>
        <h3 style="font-family:'Fraunces',serif;font-size:0.95rem;color:var(--text-sub);margin-bottom:8px;">🌳 Trees Mapped (${treesAdded.length})</h3>
        ${treesAdded.slice(0,5).map(t => `<div class="my-tree-card" onclick="openTreePanel('${esc(t.id)}');closePanel('userProfilePanel')"><div class="my-tree-header"><span class="my-tree-type">${getFruitEmoji(t.type)} ${esc(capitalise(t.type))} Tree</span><span class="my-tree-date">${timeSince(t.reportedAt)}</span></div></div>`).join("")}
      </div>` : ""}`;
    openPanel("userProfilePanel");
  } catch { showToast("Could not load profile"); }
}
window.openUserProfile = openUserProfile;

function openAdminPanel() {
  document.querySelectorAll("[data-admin-tab]").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".admin-tab-content").forEach(c => c.style.display = "none");
  document.querySelector("[data-admin-tab='requests']").classList.add("active");
  document.getElementById("adminTab-requests").style.display = "flex";
  loadAdminRequests();
  openPanel("adminPanel");
}

// ==================== AI FRUIT CHECKER ====================
document.getElementById("treePhoto").addEventListener("change", (e) => {
  const btn = document.getElementById("aiCheckBtn");
  const result = document.getElementById("aiResult");
  if (e.target.files[0]) { btn.style.display = "block"; result.className = "ai-result hidden"; result.innerHTML = ""; }
  else { btn.style.display = "none"; }
});

document.getElementById("aiCheckBtn").addEventListener("click", async () => {
  const file = document.getElementById("treePhoto").files[0];
  if (!file) return;
  const resultDiv = document.getElementById("aiResult");
  resultDiv.className = "ai-loading"; resultDiv.classList.remove("hidden");
  resultDiv.innerHTML = `<div class="ai-spinner"></div> Analysing fruit quality...`;
  try {
    const compressed = await compressImage(file);
    const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject; reader.readAsDataURL(compressed); });
    const mediaType = compressed.type || "image/jpeg";
    const response = await fetch("/api/ai-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ imageBase64: base64, mediaType }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const safeGrade = ["good","ok","bad"].includes(result.grade) ? result.grade : "ok";
    resultDiv.className = `ai-result grade-${safeGrade}`;
    resultDiv.innerHTML = `<div class="ai-result-header">${esc(result.emoji)} ${esc(result.headline)}</div><p>${esc(result.summary)}</p><p style="margin-top:8px;opacity:0.8">💡 ${esc(result.tips)}</p>`;
  } catch (err) {
    resultDiv.className = "ai-result grade-ok";
    resultDiv.innerHTML = `<div class="ai-result-header">⚠️ Check unavailable</div><p>Could not analyse the photo right now. You can still submit the tree!</p>`;
  }
});

// ==================== STANDALONE AI CHECKER ====================
function openAiCheckerPanel() {
  document.getElementById("aiCheckerPhoto").value = "";
  document.getElementById("aiCheckerRunBtn").style.display = "none";
  const result = document.getElementById("aiCheckerResult");
  result.className = "ai-result hidden";
  result.innerHTML = "";
  openPanel("aiCheckerPanel");
}
window.openAiCheckerPanel = openAiCheckerPanel;

document.getElementById("aiCheckerPhoto").addEventListener("change", (e) => {
  document.getElementById("aiCheckerRunBtn").style.display = e.target.files[0] ? "block" : "none";
  const result = document.getElementById("aiCheckerResult");
  result.className = "ai-result hidden";
  result.innerHTML = "";
});

document.getElementById("aiCheckerRunBtn").addEventListener("click", async () => {
  const file = document.getElementById("aiCheckerPhoto").files[0];
  if (!file) return;
  const resultDiv = document.getElementById("aiCheckerResult");
  resultDiv.className = "ai-loading"; resultDiv.classList.remove("hidden");
  resultDiv.innerHTML = `<div class="ai-spinner"></div> Analysing fruit quality...`;
  try {
    const compressed = await compressImage(file);
    const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject; reader.readAsDataURL(compressed); });
    const mediaType = compressed.type || "image/jpeg";
    const response = await fetch("/api/ai-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ imageBase64: base64, mediaType }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const safeGrade = ["good","ok","bad"].includes(result.grade) ? result.grade : "ok";
    resultDiv.className = `ai-result grade-${safeGrade}`;
    resultDiv.innerHTML = `<div class="ai-result-header">${esc(result.emoji)} ${esc(result.headline)}</div><p>${esc(result.summary)}</p><p style="margin-top:8px;opacity:0.8">💡 ${esc(result.tips)}</p>`;
  } catch (err) {
    resultDiv.className = "ai-result grade-ok";
    resultDiv.innerHTML = `<div class="ai-result-header">⚠️ Check unavailable</div><p>Could not analyse the photo right now. Try again in a moment!</p>`;
  }
});

// ==================== CSV EXPORT ====================
function downloadCSV(type) {
  if (type === "trees") {
    const headers = ["ID","Type","Land Type","Status","Lat","Lng","Address","Estimated Kg","Total Kg Rescued","Total Pickups","Reported By","Reported At","Verified","Notes"];
    const rows = allTrees.map(t => {
      const totalKg = (t.pickups || []).reduce((s, p) => s + (p.kg || 0), 0);
      return [t.id, t.type, t.landType, t.status, t.lat, t.lng, t.address || "", t.estimatedKg || 0, totalKg.toFixed(1), (t.pickups || []).length, t.reportedByName, new Date(t.reportedAt).toISOString(), t.verified ? "Yes" : "No", t.notes || ""];
    });
    buildAndDownloadCSV("windfall-trees.csv", headers, rows);
  } else if (type === "users") {
    apiFetch("/api/admin/users").then(r => r.json()).then(users => {
      const headers = ["Name","Email","Kg Rescued","Trees Reported","Pickups","Joined"];
      const rows = users.map(u => [u.name, u.email, (u.kgRescued || 0).toFixed(1), u.treesReported, u.pickups, new Date(u.joinedAt).toISOString()]);
      buildAndDownloadCSV("windfall-users.csv", headers, rows);
    }).catch(() => showToast("Could not fetch user data for export"));
  }
}
window.downloadCSV = downloadCSV;

function buildAndDownloadCSV(filename, headers, rows) {
  const lines = [headers, ...rows].map(row =>
    row.map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",")
  );
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  showToast(`📥 ${filename} downloaded!`);
}

// ==================== YEAR RECAP CARD ====================
async function showYearCard() {
  if (!lastAnalytics) {
    setYearCardLoading(true);
    try {
      const res = await apiFetch("/api/admin/analytics");
      if (!res.ok) { showToast("Could not load stats"); setYearCardLoading(false); return; }
      lastAnalytics = await res.json();
    } catch { showToast("Could not load stats"); setYearCardLoading(false); return; }
  }
  const panel = document.getElementById("yearCardPanel");
  panel.style.display = "flex";
  // Load the logo onto the canvas
  const logoImg = await new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/icon-192.png";
  });
  drawYearCard(logoImg);
}
window.showYearCard = showYearCard;

function setYearCardLoading(on) {
  const panel = document.getElementById("yearCardPanel");
  if (on) { panel.style.display = "flex"; panel.dataset.loading = "1"; }
  else { panel.dataset.loading = ""; }
}

function drawYearCard(logoImg) {
  const year = new Date().getFullYear();
  const kg = (lastAnalytics.totalKg || 0).toFixed(1);
  const trees = lastAnalytics.totalTrees || 0;
  const users = lastAnalytics.totalUsers || 0;

  const canvas = document.getElementById("yearCardCanvas");
  canvas.width = 1200; canvas.height = 630;
  const ctx = canvas.getContext("2d");

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 1200, 630);
  bg.addColorStop(0, "#060f06"); bg.addColorStop(1, "#122112");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 1200, 630);

  // Decorative circles
  [[1150, 0, 280, "rgba(74,124,63,0.18)"], [1080, 0, 160, "rgba(74,124,63,0.12)"], [80, 630, 220, "rgba(74,124,63,0.1)"]].forEach(([x,y,r,c]) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
  });

  // Brand: logo + name
  if (logoImg) {
    ctx.drawImage(logoImg, 72, 58, 96, 96);
    ctx.font = "bold 74px Georgia, serif";
    ctx.fillStyle = "#e8f0e6";
    ctx.fillText("Windfall", 182, 125);
    ctx.font = "27px sans-serif";
    ctx.fillStyle = "#7cb87c";
    ctx.fillText("Warwickshire Community Apple Rescue  •  " + year, 182, 165);
  } else {
    ctx.fillStyle = "#4a7c3f"; ctx.fillRect(72, 72, 7, 130);
    ctx.font = "bold 76px Georgia, serif";
    ctx.fillStyle = "#e8f0e6";
    ctx.fillText("Windfall", 100, 155);
    ctx.font = "30px sans-serif";
    ctx.fillStyle = "#7cb87c";
    ctx.fillText("Warwickshire Community Apple Rescue  •  " + year, 100, 200);
  }

  // Divider
  ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fillRect(72, 200, 1056, 1);

  // Big kg number
  ctx.font = "bold 175px Georgia, serif";
  ctx.fillStyle = "#3d6b35";
  ctx.fillText(kg, 72, 430);

  ctx.font = "bold 50px sans-serif";
  ctx.fillStyle = "#c8e6c9";
  ctx.fillText("kg of fruit rescued from the streets", 72, 490);

  // Stat chips
  const chips = ["🌳 " + trees + " trees mapped", "👤 " + users + " rescuers"];
  let cx = 72;
  chips.forEach(text => {
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(74,124,63,0.28)";
    rrect(ctx, cx - 10, 520, tw + 30, 44, 22); ctx.fill();
    ctx.strokeStyle = "rgba(74,124,63,0.55)"; ctx.lineWidth = 1.5;
    rrect(ctx, cx - 10, 520, tw + 30, 44, 22); ctx.stroke();
    ctx.font = "26px sans-serif"; ctx.fillStyle = "#a5d6a7";
    ctx.fillText(text, cx + 6, 548);
    cx += tw + 56;
  });

  // URL footer
  ctx.font = "22px sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillText("windfall-jvc3.onrender.com", 72, 608);

  // Community badge (top right)
  ctx.fillStyle = "rgba(74,124,63,0.22)";
  rrect(ctx, 900, 56, 256, 54, 27); ctx.fill();
  ctx.strokeStyle = "rgba(74,124,63,0.5)"; ctx.lineWidth = 1.5;
  rrect(ctx, 900, 56, 256, 54, 27); ctx.stroke();
  ctx.font = "bold 21px sans-serif"; ctx.fillStyle = "#81c784"; ctx.textAlign = "center";
  ctx.fillText("Community Powered ♥", 1028, 89); ctx.textAlign = "left";
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function downloadYearCard() {
  const canvas = document.getElementById("yearCardCanvas");
  const a = document.createElement("a");
  a.download = `windfall-${new Date().getFullYear()}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
  showToast("🎴 Year card saved!");
}
window.downloadYearCard = downloadYearCard;

// ==================== HELPERS ====================
async function apiFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) }, body: opts.body });
}

function val(id) { return document.getElementById(id).value.trim(); }
function showErr(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }

function setLoading(id, loading, label) {
  const btn = document.getElementById(id);
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : label;
}

function capitalise(str) { if (!str) return ""; return str.charAt(0).toUpperCase() + str.slice(1).replace(/-/g, " "); }

function timeSince(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return Math.floor(secs / 60) + "m ago";
  if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
  return Math.floor(secs / 86400) + "d ago";
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}
