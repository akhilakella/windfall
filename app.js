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
  loadAnnouncement();

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
  finally { setLoading("loginBtn", false, "Sign In"); }
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
async function showApp() {
  document.getElementById("authScreen").classList.remove("active");
  document.getElementById("appScreen").classList.add("active");
  initMap();
  loadTrees();
  updateProfilePanel();
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
  marker.bindPopup(`<div class="popup-title">${emoji} ${capitalise(tree.type)} Tree</div><div class="popup-sub">${kgText ? kgText + " · " : ""}${capitalise(tree.landType)} · by ${tree.reportedByName}</div><button class="popup-btn" onclick="openTreePanel('${tree.id}')">View Details</button>`);
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
  if (photoFile) fd.append("photo", photoFile);
  setLoading("submitTreeBtn", true, "Drop Pin 📍");
  try {
    const res = await fetch("/api/trees", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
    const tree = await res.json();
    if (!res.ok) { showErr(err, tree.error || "Failed to submit."); return; }
    allTrees.push(tree);
    addTreeMarker(tree);
    if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
    ["pinLat","pinLng","treeNotes","estKg","pinAddress"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("treePhoto").value = "";
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
  const pickupList = (tree.pickups || []).map(p => `<div class="pickup-row"><span>${p.byName}</span><span>${p.kg}kg · ${timeSince(p.at)}</span></div>`).join("") || "<p style='font-size:0.82rem;color:var(--text-muted)'>No pickups yet — be the first!</p>";
  const commentList = (tree.comments || []).map(c => `<div class="comment-row"><span class="comment-name">${c.userName}</span><span class="comment-time">${timeSince(c.at)}</span><p class="comment-text">${c.text}</p></div>`).join("") || "<p style='font-size:0.82rem;color:var(--text-muted)'>No comments yet — leave a note!</p>";
  document.getElementById("treePanelBody").innerHTML = `
    ${tree.photo ? `<img src="${tree.photo}" class="tree-detail-photo" alt="Tree photo" />` : ""}
    <div class="tree-meta">
      <span class="tree-chip">${emoji} ${capitalise(tree.type)}</span>
      <span class="tree-chip">📍 ${capitalise(tree.landType)}</span>
      ${tree.estimatedKg > 0 ? `<span class="tree-chip">~${tree.estimatedKg}kg</span>` : ""}
      <span class="tree-status-chip status-${tree.status}">${capitalise(tree.status)}</span>
      ${tree.verified ? '<span class="tree-chip" style="background:rgba(76,175,80,0.15);color:#81c784;border-color:rgba(76,175,80,0.35);">✅ Verified</span>' : ""}
    </div>
    ${tree.notes ? `<p class="tree-notes">"${tree.notes}"</p>` : ""}
    <div style="font-size:0.8rem;color:var(--text-muted)">Reported by ${tree.reportedByName} · ${timeSince(tree.reportedAt)}${tree.address ? `<br/>📍 ${tree.address}` : ""}</div>
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

async function logPickup(treeId) {
  const kg = parseFloat(document.getElementById("pickupKg").value) || 0;
  if (kg <= 0) { showToast("Enter how many kg you rescued!"); return; }
  try {
    const res = await apiFetch(`/api/trees/${treeId}/pickup`, { method: "PATCH", body: JSON.stringify({ kg }) });
    const updated = await res.json();
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
      listEl.innerHTML = comments.map(c => `<div class="comment-row"><span class="comment-name">${c.userName}</span><span class="comment-time">${timeSince(c.at)}</span><p class="comment-text">${c.text}</p></div>`).join("");
    }
    showToast("Comment posted! 💬");
  } catch { showToast("Failed to post comment"); }
}
window.addComment = addComment;

// ==================== PROFILE ====================
function setupProfileBtn() {
  document.getElementById("profileBtn").addEventListener("click", () => openPanel("profilePanel"));
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
  document.getElementById("profileName").textContent = currentUser.name;
  document.getElementById("profileEmail").textContent = currentUser.email;
  document.getElementById("statKg").textContent = (currentUser.kgRescued || 0).toFixed(1);
  document.getElementById("statTrees").textContent = currentUser.treesReported || 0;
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
  document.getElementById("leaderboardBtn").addEventListener("click", openLeaderboard);
}

async function openLeaderboard() {
  try {
    const res = await fetch("/api/leaderboard");
    const data = await res.json();
    const { users, totalKg } = data;
    const medals = ["gold","silver","bronze"];
    document.getElementById("leaderboardList").innerHTML = `
      <div style="background:rgba(74,124,63,0.15);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;text-align:center;margin-bottom:12px;">
        <div style="font-family:'Fraunces',serif;font-size:2rem;font-weight:900;color:var(--green-light);">${(totalKg||0).toFixed(1)}kg</div>
        <div style="font-size:0.8rem;color:var(--text-sub);margin-top:4px;">total fruit rescued by Warwickshire community 🍎</div>
      </div>
      ${users.length === 0
        ? `<p style="color:var(--text-muted);text-align:center">No rescuers yet — be first! 🍎</p>`
        : users.map((u, i) => `
          <div class="leader-row">
            <div class="leader-rank ${medals[i]||""}">${i===0?"🥇":i===1?"🥈":i===2?"🥉":i+1}</div>
            <div class="leader-info">
              <div class="leader-name">${u.name} ${u.email === "akhilakella@outlook.com" ? '<span style="font-size:0.7rem;background:rgba(212,168,67,0.2);color:var(--gold);border:1px solid rgba(212,168,67,0.4);border-radius:100px;padding:2px 8px;margin-left:4px;">👑 Dev</span>' : ""}</div>
              <div class="leader-sub">${u.treesReported} trees · ${u.pickups} pickups</div>
            </div>
            <div class="leader-kg">${u.kgRescued.toFixed(1)}kg</div>
          </div>`).join("")}`;
    openPanel("leaderboardPanel");
  } catch { showToast("Could not load rankings"); }
}

// ==================== MY TREES ====================
function openMyTrees() {
  const mine = allTrees.filter(t => t.reportedBy === currentUser.id);
  document.getElementById("myTreesList").innerHTML = mine.length === 0
    ? `<p style="color:var(--text-muted);text-align:center">You haven't reported any trees yet!<br><br>Tap the ＋ button to get started. 🌱</p>`
    : mine.map(t => `<div class="my-tree-card" onclick="openTreePanel('${t.id}');closePanel('myTreesPanel')"><div class="my-tree-header"><span class="my-tree-type">${getFruitEmoji(t.type)} ${capitalise(t.type)} Tree</span><span class="my-tree-date">${timeSince(t.reportedAt)}</span></div><div class="my-tree-notes">${t.notes || "No notes"}</div></div>`).join("");
  openPanel("myTreesPanel");
}
window.openMyTrees = openMyTrees;

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
      else if (view === "contact") openPanel("contactPanel");
    });
  });
}

// ==================== PANELS ====================
function setupPanelCloses() {
  [["closeReport","reportPanel"],["closeTree","treePanel"],["closeProfile","profilePanel"],["closeLeaderboard","leaderboardPanel"],["closeMyTrees","myTreesPanel"],["closeContact","contactPanel"],["closeAdmin","adminPanel"]].forEach(([btnId, panelId]) => {
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
      if (name === "announce") loadCurrentAnnouncement();
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
    const message = document.getElementById("announcementText").value.trim();
    try {
      const res = await apiFetch("/api/admin/announcement", { method: "POST", body: JSON.stringify({ message }) });
      if (res.ok) { showToast("📢 Notice posted!"); loadAnnouncement(); }
      else showToast("Failed to post notice");
    } catch { showToast("Error posting notice"); }
  });

  document.getElementById("clearAnnouncementBtn").addEventListener("click", async () => {
    try {
      await apiFetch("/api/admin/announcement", { method: "POST", body: JSON.stringify({ message: "" }) });
      document.getElementById("announcementBanner").classList.add("hidden");
      document.getElementById("announcementText").value = "";
      showToast("Notice cleared!");
    } catch { showToast("Error clearing notice"); }
  });

  document.getElementById("dismissAnnouncement").addEventListener("click", () => {
    document.getElementById("announcementBanner").classList.add("hidden");
  });
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
              <div class="my-tree-type" style="font-size:0.9rem;">${u.name}</div>
              <div class="my-tree-notes">${u.email} · ${timeSince(u.joinedAt)}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button onclick="approveUser('${u.id}')" style="background:rgba(76,175,80,0.2);border:1px solid rgba(76,175,80,0.4);color:#81c784;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">✅ Approve</button>
              <button onclick="rejectUser('${u.id}', '${u.name}')" style="background:rgba(192,57,43,0.2);border:1px solid rgba(192,57,43,0.4);color:#ff8a7a;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">✕ Reject</button>
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
    document.getElementById("aStat-kg").textContent = (data.totalKg || 0).toFixed(1);
    document.getElementById("aStat-trees").textContent = data.totalTrees || 0;
    document.getElementById("aStat-users").textContent = data.totalUsers || 0;
    document.getElementById("adminTopUsers").innerHTML = (data.topUsers || []).length === 0
      ? `<p style="color:var(--text-muted);font-size:0.85rem">No users yet</p>`
      : data.topUsers.map((u, i) => `<div class="leader-row"><div class="leader-rank">${i+1}</div><div class="leader-info"><div class="leader-name">${u.name}</div><div class="leader-sub">${u.treesReported} trees · ${u.pickups} pickups</div></div><div class="leader-kg">${u.kgRescued.toFixed(1)}kg</div></div>`).join("");
  } catch { showToast("Could not load analytics"); }
}

function loadAdminTrees() {
  document.getElementById("adminTreesList").innerHTML = allTrees.length === 0
    ? `<p style="color:var(--text-muted);text-align:center">No trees yet.</p>`
    : allTrees.map(t => `
        <div class="my-tree-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <div>
              <div class="my-tree-type">${getFruitEmoji(t.type)} ${capitalise(t.type)}</div>
              <div class="my-tree-notes">by ${t.reportedByName} · ${t.address || "No address"}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button onclick="toggleVerifyTree('${t.id}', ${!t.verified})" title="${t.verified ? 'Remove verification' : 'Mark as verified'}" style="background:${t.verified ? 'rgba(212,168,67,0.2)' : 'rgba(76,175,80,0.2)'};border:1px solid ${t.verified ? 'rgba(212,168,67,0.4)' : 'rgba(76,175,80,0.4)'};color:${t.verified ? 'var(--gold)' : '#81c784'};border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">${t.verified ? '🔓' : '✅'}</button>
              <button onclick="openEditTree('${t.id}')" style="background:rgba(74,124,63,0.2);border:1px solid var(--border);color:var(--green-light);border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">✏️</button>
              <button onclick="deleteTree('${t.id}')" style="background:rgba(192,57,43,0.2);border:1px solid rgba(192,57,43,0.4);color:#ff8a7a;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;">🗑</button>
            </div>
          </div>
          <div id="editForm-${t.id}" style="display:none;flex-direction:column;gap:8px;margin-top:8px;border-top:1px solid var(--border);padding-top:8px;">
            <input type="text" id="editNotes-${t.id}" value="${t.notes||""}" placeholder="Notes" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-main);font-family:'DM Sans',sans-serif;font-size:0.85rem;outline:none;" />
            <input type="text" id="editAddress-${t.id}" value="${t.address||""}" placeholder="Address" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-main);font-family:'DM Sans',sans-serif;font-size:0.85rem;outline:none;" />
            <input type="number" id="editKg-${t.id}" value="${t.estimatedKg||0}" placeholder="Estimated kg" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-main);font-family:'DM Sans',sans-serif;font-size:0.85rem;outline:none;" />
            <button onclick="saveEditTree('${t.id}')" class="btn-primary btn-sm">💾 Save</button>
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
              <div class="my-tree-type" style="font-size:0.9rem;">${u.name}</div>
              <div class="my-tree-notes">${u.email} · ${u.kgRescued.toFixed(1)}kg · ${u.treesReported} trees</div>
            </div>
            ${u.email !== "akhilakella@outlook.com" ? `<button onclick="deleteUser('${u.id}','${u.name}')" style="background:rgba(192,57,43,0.2);border:1px solid rgba(192,57,43,0.4);color:#ff8a7a;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;flex-shrink:0;margin-left:10px;">🗑</button>` : `<span style="font-size:0.75rem;color:var(--gold);flex-shrink:0;">👑 Admin</span>`}
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

async function loadCurrentAnnouncement() {
  try {
    const res = await fetch("/api/announcement");
    const data = await res.json();
    if (data && data.message) document.getElementById("announcementText").value = data.message;
  } catch {}
}

async function loadAnnouncement() {
  try {
    const res = await fetch("/api/announcement");
    const data = await res.json();
    if (data && data.message) {
      document.getElementById("announcementMsg").textContent = "📢 " + data.message;
      document.getElementById("announcementBanner").classList.remove("hidden");
    }
  } catch {}
}

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
    const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file); });
    const mediaType = file.type || "image/jpeg";
    const response = await fetch("/api/ai-check", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ imageBase64: base64, mediaType }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    resultDiv.className = `ai-result grade-${result.grade}`;
    resultDiv.innerHTML = `<div class="ai-result-header">${result.emoji} ${result.headline}</div><p>${result.summary}</p><p style="margin-top:8px;opacity:0.8">💡 ${result.tips}</p>`;
  } catch (err) {
    resultDiv.className = "ai-result grade-ok";
    resultDiv.innerHTML = `<div class="ai-result-header">⚠️ Check unavailable</div><p>Could not analyse the photo right now. You can still submit the tree!</p>`;
  }
});

// ==================== HELPERS ====================
async function apiFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) }, body: opts.body });
}

function val(id) { return document.getElementById(id).value.trim(); }
function showErr(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }

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
