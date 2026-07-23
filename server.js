const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const path = require("path");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "windfall-secret-key-change-in-prod";
const ADMIN_EMAIL = "akhilakella@outlook.com";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  tls: redisUrl.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
});
redis.on("error", (err) => console.error("Redis error:", err));
redis.on("connect", () => console.log("Redis connected"));

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname)));
// Render sits behind a proxy, so trust it to read the real client IP
app.set("trust proxy", 1);

// Photos are stored as base64 data URLs inside the tree record in Redis.
// Render's disk is ephemeral, so files written to it vanish on every deploy.
// The frontend compresses photos before upload so these stay small (~100-200KB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
}

function adminMiddleware(req, res, next) {
  if (req.user.email !== ADMIN_EMAIL) return res.status(403).json({ error: "Admin only" });
  next();
}

// ---- RATE LIMITING ----
// Counts requests per key in Redis with an auto-expiring window. Protects
// against brute-forced logins, signup spam, and abuse of the AI checker.
// Fails open: if Redis has a wobble, requests are allowed through rather
// than locking real users out.
async function underLimit(key, max, windowSec) {
  try {
    const k = `rl:${key}`;
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, windowSec);
    return count <= max;
  } catch { return true; }
}

function rateLimit({ max, windowSec, scope, by = "ip", message }) {
  return async (req, res, next) => {
    const who = by === "user" && req.user ? `u:${req.user.id}` : `ip:${req.ip || "unknown"}`;
    const ok = await underLimit(`${scope}:${who}`, max, windowSec);
    if (!ok) {
      console.warn(`Rate limit hit: ${scope} by ${who}`);
      return res.status(429).json({ error: message || "Too many requests. Please wait a little and try again." });
    }
    next();
  };
}

// Escape user-supplied text before embedding it in email HTML
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Branded welcome email sent when the admin approves a new member.
// The logo is the hosted PNG (email clients block SVGs; PNGs are safe).
function welcomeEmailHtml(name, appUrl) {
  const firstName = esc((name || "").split(" ")[0] || "there");
  return `
  <div style="margin:0;padding:0;background:#0f1a0e;">
    <div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 32px;background:#111d10;border-radius:18px;color:#e8f0e6;text-align:center;">
      <img src="${appUrl}/icon-192.png" alt="Windfall" width="88" height="88" style="width:88px;height:88px;object-fit:contain;margin-bottom:12px;" />
      <div style="font-size:1.9rem;font-weight:800;letter-spacing:6px;color:#e8f0e6;margin-bottom:4px;">WINDFALL</div>
      <div style="height:3px;width:60px;background:linear-gradient(90deg,#7db874,#d4a843);margin:14px auto 24px;border-radius:2px;"></div>

      <h1 style="font-size:1.35rem;color:#d4a843;margin:0 0 16px;">Welcome aboard, ${firstName}</h1>

      <p style="font-size:0.98rem;line-height:1.65;color:#c9d8c4;margin:0 0 16px;">
        Your account has been approved, so you are officially part of the Windfall community.
      </p>
      <p style="font-size:0.98rem;line-height:1.65;color:#c9d8c4;margin:0 0 16px;">
        Every tree you map and every kilogram you rescue is fruit that would otherwise have gone to waste. Instead it feeds people and animals across Warwickshire. Small actions, real impact.
      </p>
      <p style="font-size:1.05rem;line-height:1.6;color:#7db874;font-weight:700;margin:0 0 28px;">
        Let's do this together.
      </p>

      <a href="${appUrl}" style="display:inline-block;background:#4a7c3f;color:#ffffff;padding:15px 40px;border-radius:12px;text-decoration:none;font-weight:700;font-size:1rem;box-shadow:0 6px 18px rgba(74,124,63,0.4);">
        Open Windfall
      </a>

      <p style="font-size:0.8rem;color:#556b52;margin:32px 0 0;line-height:1.6;">
        Ready to start? Sign in, drop your first pin on the map, and help rescue the harvest.<br/>
        Questions? Just reply to <a href="mailto:akhilakella@outlook.com" style="color:#7db874;">akhilakella@outlook.com</a>.
      </p>
    </div>
    <div style="text-align:center;font-size:0.72rem;color:#3a4a37;padding:16px;">Windfall · Community apple rescue · Warwickshire, UK</div>
  </div>`;
}

// Email sent to a tree's reporter when someone else picks from or comments on it.
function treeActivityEmailHtml({ ownerName, headline, detail, appUrl, treeId }) {
  const first = esc((ownerName || "").split(" ")[0] || "there");
  return `
  <div style="margin:0;padding:0;background:#0f1a0e;">
    <div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:36px 30px;background:#111d10;border-radius:18px;color:#e8f0e6;">
      <div style="text-align:center;">
        <img src="${appUrl}/icon-192.png" alt="Windfall" width="64" height="64" style="width:64px;height:64px;object-fit:contain;" />
        <div style="font-size:1.3rem;font-weight:800;letter-spacing:5px;margin:8px 0 2px;">WINDFALL</div>
        <div style="height:3px;width:56px;background:linear-gradient(90deg,#7db874,#d4a843);margin:14px auto 22px;border-radius:2px;"></div>
      </div>
      <p style="font-size:0.95rem;color:#c9d8c4;margin:0 0 14px;">Hi ${first},</p>
      <h2 style="font-size:1.1rem;color:#d4a843;margin:0 0 12px;">${esc(headline)}</h2>
      ${detail ? `<div style="background:rgba(74,124,63,0.15);border:1px solid rgba(74,124,63,0.4);border-radius:10px;padding:14px;margin:0 0 18px;font-size:0.9rem;color:#c9d8c4;">${esc(detail)}</div>` : ""}
      <div style="text-align:center;margin-top:20px;">
        <a href="${appUrl}/tree/${esc(treeId)}" style="display:inline-block;background:#4a7c3f;color:#ffffff;padding:13px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:0.95rem;">View the tree</a>
      </div>
      <p style="font-size:0.75rem;color:#556b52;margin:26px 0 0;text-align:center;line-height:1.6;">
        You are getting this because you reported this tree. You can turn these emails off in your profile.
      </p>
    </div>
  </div>`;
}

// Fire-and-forget notification to the person who reported a tree.
async function notifyTreeOwner(tree, actorId, { subject, headline, detail }) {
  try {
    if (!tree || !tree.reportedBy || tree.reportedBy === actorId) return;
    const raw = await redis.get(`user:${tree.reportedBy}`);
    if (!raw) return;
    const owner = JSON.parse(raw);
    if (!owner.email || owner.emailNotifications === false) return;
    const appUrl = process.env.APP_URL || "https://windfall-app.co.uk";
    await sendEmail({
      to: owner.email,
      subject,
      html: treeActivityEmailHtml({ ownerName: owner.name, headline, detail, appUrl, treeId: tree.id })
    });
  } catch (e) { console.error("Tree notification error:", e.message); }
}

// Send an email via Resend. Returns silently if no API key is configured.
// `attachments` (optional): [{ filename, content }] where content is base64.
async function sendEmail({ to, subject, html, attachments }) {
  if (!process.env.RESEND_API_KEY) { console.error("RESEND_API_KEY not set, email skipped"); return false; }
  try {
    const payload = { from: process.env.EMAIL_FROM || "Windfall <onboarding@resend.dev>", to, subject, html };
    if (attachments && attachments.length) payload.attachments = attachments;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify(payload)
    });
    if (!r.ok) { console.error("Email send failed:", await r.text()); return false; }
    return true;
  } catch (e) { console.error("Email send error:", e.message); return false; }
}

// ---- REGISTER ----
app.post("/api/register", rateLimit({ scope: "register", max: 5, windowSec: 3600, message: "Too many sign-up attempts. Please try again in an hour." }), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    const existing = await redis.get(`user:email:${email.toLowerCase()}`);
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL;
    const user = { id, name, email: email.toLowerCase(), password: hash, status: isAdmin ? "approved" : "pending", kgRescued: 0, treesReported: 0, pickups: 0, badges: [], joinedAt: Date.now() };
    await redis.set(`user:${id}`, JSON.stringify(user));
    await redis.set(`user:email:${email.toLowerCase()}`, id);
    if (isAdmin) {
      const token = jwt.sign({ id, name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, user: { id, name, email: user.email, kgRescued: 0, treesReported: 0, pickups: 0, badges: [] } });
    }
    // Notify the admin so they don't have to keep checking the app manually
    const appUrl = process.env.APP_URL || "https://windfall-app.co.uk";
    sendEmail({
      to: ADMIN_EMAIL,
      subject: `🌱 New Windfall sign-up: ${name}`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f1a0e;color:#e8f0e6;border-radius:16px;"><h1 style="color:#d4a843;">🍎 Windfall</h1><p>Someone new wants to join Windfall:</p><div style="background:rgba(74,124,63,0.15);border:1px solid rgba(74,124,63,0.4);border-radius:10px;padding:16px;margin:16px 0;"><p style="margin:0 0 6px;"><strong>Name:</strong> ${esc(name)}</p><p style="margin:0;"><strong>Email:</strong> ${esc(email.toLowerCase())}</p></div><p>Open the app and head to <strong>Admin → Requests</strong> to approve or reject them.</p><a href="${appUrl}" style="display:inline-block;background:#4a7c3f;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;">Review Request</a></div>`
    });
    res.json({ pending: true, message: "Your account is awaiting approval. You will be able to log in once the admin approves your request." });
  } catch (err) { console.error(err); res.status(500).json({ error: "Server error" }); }
});

// ---- LOGIN ----
app.post("/api/login", rateLimit({ scope: "login", max: 10, windowSec: 900, message: "Too many sign-in attempts. Please wait 15 minutes and try again." }), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "All fields required" });
    const userId = await redis.get(`user:email:${email.toLowerCase()}`);
    if (!userId) return res.status(401).json({ error: "Invalid email or password" });
    const user = JSON.parse(await redis.get(`user:${userId}`));
    // Guard against an orphaned email index pointing at a deleted user record
    if (!user || !user.password) return res.status(401).json({ error: "Invalid email or password" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid email or password" });
    if (user.status === "pending") return res.status(403).json({ error: "pending", message: "Your account is awaiting approval from the admin." });
    if (user.status === "rejected") return res.status(403).json({ error: "rejected", message: "Your account request was not approved. Contact akhilakella@outlook.com for help." });
    user.badges = computeBadges(user);
    await redis.set(`user:${userId}`, JSON.stringify(user));
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, kgRescued: user.kgRescued, treesReported: user.treesReported, pickups: user.pickups, badges: user.badges, emailNotifications: user.emailNotifications !== false } });
  } catch (err) { console.error(err); res.status(500).json({ error: "Server error" }); }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    if (!user) return res.status(404).json({ error: "User not found" });
    user.badges = computeBadges(user);
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));
    res.json({ id: user.id, name: user.name, email: user.email, kgRescued: user.kgRescued, treesReported: user.treesReported, pickups: user.pickups, badges: user.badges, emailNotifications: user.emailNotifications !== false });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Let users turn tree-activity emails on or off
app.post("/api/email-prefs", authMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`user:${req.user.id}`);
    if (!raw) return res.status(404).json({ error: "User not found" });
    const user = JSON.parse(raw);
    user.emailNotifications = req.body.enabled !== false;
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));
    res.json({ enabled: user.emailNotifications });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/change-password", authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    if (!user) return res.status(404).json({ error: "User not found" });
    user.password = await bcrypt.hash(newPassword, 10);
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/forgot-password", rateLimit({ scope: "forgot", max: 5, windowSec: 3600, message: "Too many reset requests. Please try again in an hour." }), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    const userId = await redis.get(`user:email:${email.toLowerCase()}`);
    if (!userId) return res.json({ success: true });
    const resetToken = uuidv4();
    await redis.set(`reset:${resetToken}`, userId, "EX", 3600);
    const resetUrl = `${process.env.APP_URL || "https://windfall-app.co.uk"}/reset-password?token=${resetToken}`;
    await sendEmail({
      to: email.toLowerCase(),
      subject: "Reset your Windfall password",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f1a0e;color:#e8f0e6;border-radius:16px;"><h1>🍎 Windfall</h1><p>Click below to reset your password. Expires in 1 hour.</p><a href="${resetUrl}" style="display:inline-block;background:#4a7c3f;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;">Reset Password</a></div>`
    });
    res.json({ success: true });
  } catch (err) { console.error(err); res.json({ success: true }); }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "All fields required" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const userId = await redis.get(`reset:${token}`);
    if (!userId) return res.status(400).json({ error: "Reset link is invalid or has expired" });
    const user = JSON.parse(await redis.get(`user:${userId}`));
    if (!user) return res.status(404).json({ error: "User not found" });
    user.password = await bcrypt.hash(newPassword, 10);
    await redis.set(`user:${userId}`, JSON.stringify(user));
    await redis.del(`reset:${token}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// ---- TREES ----
// Photos are large base64 blobs, so they are never sent with tree data.
// Clients get a `hasPhoto` flag and load the image itself from
// /api/trees/:id/photo, which keeps the map payload small and fast.
function publicTree(t) {
  const { photo, ...rest } = t;
  return { ...rest, hasPhoto: !!(photo && String(photo).startsWith("data:")) };
}

app.get("/api/trees", async (req, res) => {
  try {
    const keys = await redis.keys("tree:*");
    const trees = [];
    for (const key of keys) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const t = await redis.get(key);
      if (t) trees.push(publicTree(JSON.parse(t)));
    }
    res.json(trees);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Serves a single tree's photo as a real image, with long cache headers
app.get("/api/trees/:id/photo", async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).end();
    const photo = JSON.parse(raw).photo;
    if (!photo || !String(photo).startsWith("data:")) return res.status(404).end();
    const m = /^data:([^;]+);base64,(.*)$/s.exec(photo);
    if (!m) return res.status(404).end();
    res.set("Content-Type", m[1]);
    res.set("Cache-Control", "public, max-age=604800");
    res.send(Buffer.from(m[2], "base64"));
  } catch { res.status(404).end(); }
});

app.post("/api/trees", authMiddleware, rateLimit({ scope: "addtree", by: "user", max: 30, windowSec: 3600, message: "You have added a lot of trees in the last hour. Please try again shortly." }), upload.single("photo"), async (req, res) => {
  try {
    const { lat, lng, type, landType, notes, estimatedKg, address } = req.body;
    if (!lat || !lng || !type) return res.status(400).json({ error: "lat, lng and type required" });
    const id = uuidv4();
    const tree = { id, lat: parseFloat(lat), lng: parseFloat(lng), type, landType: landType || "unknown", notes: notes || "", address: address || "", estimatedKg: parseFloat(estimatedKg) || 0, status: "active", photo: req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}` : null, reportedBy: req.user.id, reportedByName: req.user.name, reportedAt: Date.now(), pickups: [] };
    await redis.set(`tree:${id}`, JSON.stringify(tree));
    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    user.treesReported = (user.treesReported || 0) + 1;
    user.badges = computeBadges(user);
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));
    res.json(publicTree(tree));
  } catch (err) { console.error(err); res.status(500).json({ error: "Server error" }); }
});

app.patch("/api/trees/:id/pickup", authMiddleware, rateLimit({ scope: "pickup", by: "user", max: 40, windowSec: 3600, message: "You have logged a lot of pickups in the last hour. Please try again shortly." }), async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    const tree = JSON.parse(raw);
    const kgNum = parseFloat(req.body.kg) || 0;
    const validDests = ["eaten", "animals", "juice", "baking", "donated"];
    const destination = validDests.includes(req.body.destination) ? req.body.destination : "eaten";
    if (!Array.isArray(tree.pickups)) tree.pickups = [];
    tree.pickups.push({ by: req.user.id, byName: req.user.name, kg: kgNum, destination, at: Date.now() });
    tree.status = "picked";
    await redis.set(`tree:${tree.id}`, JSON.stringify(tree));
    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    user.kgRescued = (user.kgRescued || 0) + kgNum;
    user.pickups = (user.pickups || 0) + 1;
    // Track distinct fruit types picked (for the all-rounder badge)
    if (["apple", "pear", "plum", "cherry", "blackberry"].includes(tree.type)) {
      user.pickedTypes = Array.from(new Set([...(user.pickedTypes || []), tree.type]));
    }
    // Night owl: a pickup logged between 9pm and 5am
    const hr = new Date().getHours();
    if (hr >= 21 || hr < 5) user.nightOwl = true;
    // Season opener: the first person to log a pickup this calendar year
    const year = new Date().getFullYear();
    const openerKey = `season:opener:${year}`;
    const opener = await redis.get(openerKey);
    if (!opener) { await redis.set(openerKey, req.user.id); user.seasonOpener = true; }
    else if (opener === req.user.id) { user.seasonOpener = true; }
    user.badges = computeBadges(user);
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));
    res.json(publicTree(tree));
    notifyTreeOwner(tree, req.user.id, {
      subject: `${req.user.name} rescued ${kgNum}kg from your ${tree.type} tree`,
      headline: `${req.user.name} just rescued ${kgNum}kg of fruit from your ${tree.type} tree.`,
      detail: "Thanks for putting it on the map. That is fruit which would otherwise have gone to waste."
    });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.patch("/api/trees/:id/status", authMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    const tree = JSON.parse(raw);
    tree.status = req.body.status || tree.status;
    await redis.set(`tree:${tree.id}`, JSON.stringify(tree));
    res.json(publicTree(tree));
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/trees/:id/comments", authMiddleware, rateLimit({ scope: "comment", by: "user", max: 20, windowSec: 600, message: "You are commenting very quickly. Please wait a moment." }), async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    const tree = JSON.parse(raw);
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Comment text required" });
    const comment = { id: uuidv4(), userId: req.user.id, userName: req.user.name, text: text.trim(), at: Date.now() };
    if (!tree.comments) tree.comments = [];
    tree.comments.push(comment);
    await redis.set(`tree:${tree.id}`, JSON.stringify(tree));
    res.json(comment);
    notifyTreeOwner(tree, req.user.id, {
      subject: `${req.user.name} commented on your ${tree.type} tree`,
      headline: `${req.user.name} left a comment on your ${tree.type} tree.`,
      detail: comment.text
    });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.delete("/api/trees/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    await redis.del(`tree:${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// ---- ADMIN ----
app.get("/api/admin/check", authMiddleware, (req, res) => {
  res.json({ isAdmin: req.user.email === ADMIN_EMAIL });
});

app.get("/api/admin/requests", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const keys = await redis.keys("user:*");
    const pending = [];
    for (const key of keys) {
      if (key.includes("email")) continue;
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const u = JSON.parse(await redis.get(key));
      if (u && u.status === "pending") pending.push({ id: u.id || parts[1], name: u.name, email: u.email, joinedAt: u.joinedAt });
    }
    pending.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
    res.json(pending);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/admin/approve/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`user:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "User not found" });
    const user = JSON.parse(raw);
    const wasPending = user.status === "pending";
    user.status = "approved";
    await redis.set(`user:${req.params.id}`, JSON.stringify(user));
    res.json({ success: true });

    // Welcome the new member (only on the pending → approved transition)
    if (wasPending && user.email) {
      const appUrl = process.env.APP_URL || "https://windfall-app.co.uk";
      sendEmail({
        to: user.email,
        subject: "🍎 You're in! Welcome to Windfall",
        html: welcomeEmailHtml(user.name, appUrl)
      });
    }
  } catch (err) { console.error("Approve error:", err); res.status(500).json({ error: "Server error" }); }
});

app.delete("/api/admin/users/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    console.log("Delete user request for id:", id);
    const raw = await redis.get(`user:${id}`);
    if (!raw) { console.error("Delete: no user record at key user:" + id); return res.status(404).json({ error: "User not found" }); }
    const user = JSON.parse(raw);
    // Always delete by the key we were given, even if the record's own id field is stale/missing
    await redis.del(`user:${id}`);
    if (user.email) await redis.del(`user:email:${user.email.toLowerCase()}`);
    console.log("Deleted user:", user.email || id);
    res.json({ success: true });
  } catch (err) { console.error("Delete user error:", err); res.status(500).json({ error: "Server error" }); }
});

app.get("/api/admin/users", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const keys = await redis.keys("user:*");
    const users = [];
    for (const key of keys) {
      if (key.includes("email")) continue;
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const u = JSON.parse(await redis.get(key));
      // Fall back to the id embedded in the key so old records without an id field are still deletable
      if (u && u.name && u.status !== "pending" && u.status !== "rejected") users.push({ id: u.id || parts[1], name: u.name, email: u.email, kgRescued: u.kgRescued || 0, treesReported: u.treesReported || 0, pickups: u.pickups || 0, joinedAt: u.joinedAt });
    }
    users.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
    res.json(users);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/admin/reset-stats", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const keys = await redis.keys("user:*");
    for (const key of keys) {
      if (key.includes("email")) continue;
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const u = JSON.parse(await redis.get(key));
      // Clear the badge-tracking fields too, otherwise all-rounder / night-owl /
      // season-opener would immediately come back after a reset.
      if (u) { u.kgRescued = 0; u.pickups = 0; u.treesReported = 0; u.badges = []; u.pickedTypes = []; u.nightOwl = false; u.seasonOpener = false; await redis.set(key, JSON.stringify(u)); }
    }
    const treeKeys = await redis.keys("tree:*");
    for (const key of treeKeys) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const t = JSON.parse(await redis.get(key));
      if (t) { t.pickups = []; t.status = "active"; await redis.set(key, JSON.stringify(t)); }
    }
    // Let a new season opener be crowned after a reset
    await redis.del(`season:opener:${new Date().getFullYear()}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.get("/api/admin/analytics", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userKeys = await redis.keys("user:*");
    const treeKeys = await redis.keys("tree:*");
    let totalUsers = 0, totalTrees = 0;
    const userMap = {};
    // Build user map from user records
    for (const key of userKeys) {
      if (key.includes("email")) continue;
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const u = JSON.parse(await redis.get(key));
      if (u && u.name && u.status === "approved") {
        totalUsers++;
        userMap[u.id] = { name: u.name, kgRescued: 0, treesReported: 0, pickups: u.pickups || 0 };
      }
    }
    // Count trees and kg from actual tree records
    for (const key of treeKeys) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      totalTrees++;
      const t = JSON.parse(await redis.get(key));
      if (t && t.reportedBy && userMap[t.reportedBy]) userMap[t.reportedBy].treesReported++;
      if (t && t.pickups) {
        for (const p of t.pickups) {
          if (p.by && userMap[p.by]) userMap[p.by].kgRescued += p.kg || 0;
        }
      }
    }
    const totalKg = Object.values(userMap).reduce((s, u) => s + u.kgRescued, 0);
    const userStats = Object.values(userMap);
    userStats.sort((a, b) => b.kgRescued - a.kgRescued);
    res.json({ totalKg, totalUsers, totalTrees, topUsers: userStats.slice(0, 5) });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.patch("/api/admin/trees/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    const tree = JSON.parse(raw);
    const { type, notes, landType, estimatedKg, address, verified } = req.body;
    if (type) tree.type = type;
    if (notes !== undefined) tree.notes = notes;
    if (landType) tree.landType = landType;
    if (estimatedKg !== undefined) tree.estimatedKg = parseFloat(estimatedKg) || 0;
    if (address !== undefined) tree.address = address;
    if (verified !== undefined) tree.verified = !!verified;
    await redis.set(`tree:${tree.id}`, JSON.stringify(tree));
    res.json(publicTree(tree));
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.get("/api/announcements", async (req, res) => {
  try {
    const raw = await redis.get("announcements");
    res.json(raw ? JSON.parse(raw) : []);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/admin/announcements", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: "Title and body required" });
    const raw = await redis.get("announcements");
    const list = raw ? JSON.parse(raw) : [];
    const post = { id: uuidv4(), title: title.trim(), body: body.trim(), postedAt: Date.now() };
    list.unshift(post);
    await redis.set("announcements", JSON.stringify(list));
    res.json(post);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.delete("/api/admin/announcements/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raw = await redis.get("announcements");
    const list = raw ? JSON.parse(raw) : [];
    await redis.set("announcements", JSON.stringify(list.filter(a => a.id !== req.params.id)));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// ---- MAINTENANCE MODE ----
const MAINTENANCE_KEY = "maintenance:status";

// Public, anyone (even logged out) can check whether the app is in maintenance mode
app.get("/api/maintenance", async (req, res) => {
  try {
    const raw = await redis.get(MAINTENANCE_KEY);
    res.json(raw ? JSON.parse(raw) : { enabled: false, message: "" });
  } catch { res.json({ enabled: false, message: "" }); }
});

// Admin only, toggle maintenance mode on/off, with an optional custom message
app.post("/api/admin/maintenance", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { enabled, message } = req.body;
    const status = { enabled: !!enabled, message: (message || "").toString().trim().slice(0, 300), updatedAt: Date.now() };
    await redis.set(MAINTENANCE_KEY, JSON.stringify(status));
    res.json(status);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// ---- WEEKLY ADMIN DIGEST ----
async function buildWeeklyDigest() {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const userKeys = await redis.keys("user:*");
  let totalUsers = 0, pendingCount = 0;
  const newUsers = [];
  for (const key of userKeys) {
    if (key.includes("email")) continue;
    const parts = key.split(":");
    if (parts.length !== 2) continue;
    const u = JSON.parse(await redis.get(key));
    if (!u) continue;
    if (u.status === "pending") { pendingCount++; continue; }
    if (u.status === "rejected") continue;
    totalUsers++;
    if ((u.joinedAt || 0) >= weekAgo) newUsers.push(u.name);
  }
  const treeKeys = await redis.keys("tree:*");
  let totalTrees = 0, newTrees = 0, weekKg = 0, weekPickups = 0, totalKg = 0;
  for (const key of treeKeys) {
    const parts = key.split(":");
    if (parts.length !== 2) continue;
    const t = JSON.parse(await redis.get(key));
    if (!t) continue;
    totalTrees++;
    if ((t.reportedAt || 0) >= weekAgo) newTrees++;
    (t.pickups || []).forEach(p => {
      totalKg += p.kg || 0;
      if ((p.at || 0) >= weekAgo) { weekKg += p.kg || 0; weekPickups++; }
    });
  }
  return { newUsers, pendingCount, totalUsers, newTrees, totalTrees, weekKg, weekPickups, totalKg };
}

function digestEmailHtml(d, appUrl) {
  const row = (icon, label, value) => `<tr><td style="padding:8px 0;color:#8aab85;font-size:0.9rem;">${icon} ${label}</td><td style="padding:8px 0;text-align:right;color:#e8f0e6;font-weight:700;font-size:0.95rem;">${value}</td></tr>`;
  return `
  <div style="margin:0;padding:0;background:#0f1a0e;">
    <div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:36px 30px;background:#111d10;border-radius:18px;color:#e8f0e6;">
      <div style="text-align:center;">
        <img src="${appUrl}/icon-192.png" alt="Windfall" width="64" height="64" style="width:64px;height:64px;object-fit:contain;" />
        <div style="font-size:1.4rem;font-weight:800;letter-spacing:5px;margin:8px 0 2px;">WINDFALL</div>
        <div style="font-size:0.85rem;color:#8aab85;">Your weekly digest 📋</div>
        <div style="height:3px;width:60px;background:linear-gradient(90deg,#7db874,#d4a843);margin:16px auto 20px;border-radius:2px;"></div>
      </div>
      <h2 style="font-size:1rem;color:#d4a843;margin:0 0 6px;">This week</h2>
      <table style="width:100%;border-collapse:collapse;border-bottom:1px solid rgba(74,124,63,0.25);margin-bottom:18px;">
        ${row("🍏", "Fruit rescued", `${d.weekKg.toFixed(1)}kg`)}
        ${row("🧺", "Pickups logged", d.weekPickups)}
        ${row("🌳", "New trees mapped", d.newTrees)}
        ${row("👥", "New members", d.newUsers.length ? esc(d.newUsers.join(", ")) : "none")}
        ${row("⏳", "Awaiting approval", d.pendingCount > 0 ? `<span style="color:#ff8a7a;">${d.pendingCount}, action needed!</span>` : "0")}
      </table>
      <h2 style="font-size:1rem;color:#d4a843;margin:0 0 6px;">All time</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${row("🍎", "Total rescued", `${d.totalKg.toFixed(1)}kg`)}
        ${row("🌳", "Trees on the map", d.totalTrees)}
        ${row("👥", "Community members", d.totalUsers)}
      </table>
      <div style="text-align:center;">
        <a href="${appUrl}" style="display:inline-block;background:#4a7c3f;color:#ffffff;padding:13px 34px;border-radius:12px;text-decoration:none;font-weight:700;font-size:0.95rem;">🍎 Open Windfall</a>
      </div>
    </div>
    <div style="text-align:center;font-size:0.72rem;color:#3a4a37;padding:16px;">Windfall · Weekly admin digest · Sent every Monday morning</div>
  </div>`;
}

// Most recent Monday 09:00 (server time). If we haven't sent since then, a digest is due.
function lastMonday9am() {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 7);
  return d.getTime();
}

async function sendWeeklyDigestIfDue() {
  try {
    const due = lastMonday9am();
    const lastSent = parseInt(await redis.get("digest:lastSent") || "0", 10);
    if (lastSent >= due) return;
    await redis.set("digest:lastSent", String(Date.now())); // claim first so we never double-send
    const d = await buildWeeklyDigest();
    const appUrl = process.env.APP_URL || "https://windfall-app.co.uk";
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `🍎 Windfall weekly digest: ${d.weekKg.toFixed(1)}kg rescued, ${d.newUsers.length} new member${d.newUsers.length === 1 ? "" : "s"}`,
      html: digestEmailHtml(d, appUrl)
    });
    console.log("Weekly digest sent");
  } catch (e) { console.error("Digest error:", e.message); }
}
// Check hourly while awake, and shortly after every boot, so on the free tier
// (which sleeps when idle) the digest goes out on the first wake-up after Monday 9am.
setInterval(sendWeeklyDigestIfDue, 60 * 60 * 1000);
setTimeout(sendWeeklyDigestIfDue, 15000);

// Manual trigger so the admin can test it / get one on demand
app.post("/api/admin/send-digest", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const d = await buildWeeklyDigest();
    const appUrl = process.env.APP_URL || "https://windfall-app.co.uk";
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `🍎 Windfall weekly digest: ${d.weekKg.toFixed(1)}kg rescued this week`,
      html: digestEmailHtml(d, appUrl)
    });
    res.json({ success: true });
  } catch (err) { console.error("Manual digest error:", err); res.status(500).json({ error: "Server error" }); }
});

// ---- AUTOMATED OFF-SITE BACKUP ----
// Dumps every user + tree to a JSON file and emails it to the admin, so the
// data survives even if the Redis database is ever wiped. Photos (large base64
// blobs) are stripped to keep the email well under Resend's size limit, the
// critical data (accounts, tree locations, pickups, comments, stats) is kept.
async function buildBackup() {
  const users = [], trees = [];
  const userKeys = await redis.keys("user:*");
  for (const key of userKeys) {
    if (key.includes("email")) continue;
    if (!key.startsWith("user:")) continue;
    const u = JSON.parse(await redis.get(key));
    if (u) users.push(u);
  }
  const treeKeys = await redis.keys("tree:*");
  for (const key of treeKeys) {
    const parts = key.split(":");
    if (parts.length !== 2) continue;
    const t = JSON.parse(await redis.get(key));
    if (!t) continue;
    trees.push({ ...t, photo: t.photo ? "[photo omitted from backup]" : null });
  }
  const announcementsRaw = await redis.get("announcements");
  return {
    exportedAt: new Date().toISOString(),
    counts: { users: users.length, trees: trees.length },
    users, trees,
    announcements: announcementsRaw ? JSON.parse(announcementsRaw) : []
  };
}

async function emailBackup() {
  const backup = await buildBackup();
  const json = JSON.stringify(backup, null, 2);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  const stamp = new Date().toISOString().slice(0, 10);
  const sizeKb = Math.round(base64.length / 1024);
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f1a0e;color:#e8f0e6;border-radius:16px;">
    <h1 style="color:#d4a843;">🍎 Windfall backup</h1>
    <p>Attached is a full backup of your Windfall data as of ${esc(backup.exportedAt)}.</p>
    <div style="background:rgba(74,124,63,0.15);border:1px solid rgba(74,124,63,0.4);border-radius:10px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 6px;"><strong>${backup.counts.users}</strong> users</p>
      <p style="margin:0;"><strong>${backup.counts.trees}</strong> trees</p>
    </div>
    <p style="font-size:0.85rem;color:#8aab85;">Keep this email safe. If the database is ever lost, this file can restore everything (photos are not included to keep the backup small).</p>
  </div>`;
  return await sendEmail({
    to: ADMIN_EMAIL,
    subject: `🗄️ Windfall backup: ${stamp} (${backup.counts.users} users, ${backup.counts.trees} trees, ${sizeKb}KB)`,
    html,
    attachments: [{ filename: `windfall-backup-${stamp}.json`, content: base64 }]
  });
}

// Daily automatic backup (runs on the first wake-up once 24 hours have passed)
async function sendBackupIfDue() {
  try {
    const last = parseInt(await redis.get("backup:lastSent") || "0", 10);
    if (Date.now() - last < 24 * 3600 * 1000) return;
    await redis.set("backup:lastSent", String(Date.now())); // claim first so we never double-send
    const ok = await emailBackup();
    console.log(ok ? "Weekly backup emailed" : "Weekly backup failed to send");
  } catch (e) { console.error("Backup error:", e.message); }
}
setInterval(sendBackupIfDue, 60 * 60 * 1000);
setTimeout(sendBackupIfDue, 30000);

// Manual trigger so the admin can grab a backup / test it on demand
app.post("/api/admin/send-backup", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const ok = await emailBackup();
    if (ok) { await redis.set("backup:lastSent", String(Date.now())); res.json({ success: true }); }
    else res.status(500).json({ error: "Backup email failed, check server logs" });
  } catch (err) { console.error("Manual backup error:", err); res.status(500).json({ error: "Server error" }); }
});

// ---- LEADERBOARD ----
app.get("/api/leaderboard", async (req, res) => {
  try {
    const season = req.query.period === "season";
    const seasonStart = new Date(new Date().getFullYear(), 0, 1).getTime();

    // Load eligible users
    const userKeys = await redis.keys("user:*");
    const userMap = {};
    for (const key of userKeys) {
      if (key.includes("email")) continue;
      if (!key.startsWith("user:")) continue;
      const u = JSON.parse(await redis.get(key));
      if (u && u.name && u.status !== "pending" && u.status !== "rejected") {
        userMap[u.id] = { id: u.id, name: u.name, email: u.email, badges: u.badges || [], allTimeKg: u.kgRescued || 0, allTimePickups: u.pickups || 0 };
      }
    }

    // Aggregate trees + pickups (respecting the season window when requested)
    const treeKeys = await redis.keys("tree:*");
    const treeCounts = {}, seasonKg = {}, seasonPickups = {};
    for (const key of treeKeys) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const t = JSON.parse(await redis.get(key));
      if (!t) continue;
      if (t.reportedBy && (!season || (t.reportedAt || 0) >= seasonStart)) treeCounts[t.reportedBy] = (treeCounts[t.reportedBy] || 0) + 1;
      (t.pickups || []).forEach(p => {
        if (season && (p.at || 0) < seasonStart) return;
        seasonKg[p.by] = (seasonKg[p.by] || 0) + (p.kg || 0);
        seasonPickups[p.by] = (seasonPickups[p.by] || 0) + 1;
      });
    }

    let users = Object.values(userMap).map(u => ({
      id: u.id, name: u.name, email: u.email, badges: u.badges,
      kgRescued: season ? (seasonKg[u.id] || 0) : u.allTimeKg,
      pickups: season ? (seasonPickups[u.id] || 0) : u.allTimePickups,
      treesReported: treeCounts[u.id] || 0
    }));
    users.sort((a, b) => b.kgRescued - a.kgRescued);
    const totalKg = users.reduce((s, u) => s + u.kgRescued, 0);
    res.json({ users: users.slice(0, 20), totalKg, period: season ? "season" : "all", seasonLabel: String(new Date().getFullYear()) });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

function computeBadges(user) {
  const badges = [];
  if (user.email === ADMIN_EMAIL) {
    badges.push("developer");
    badges.push("admin");
  }
  if (user.treesReported >= 1) badges.push("tree-scout");
  if (user.treesReported >= 10) badges.push("orchard-mapper");
  if (user.kgRescued >= 5) badges.push("apple-saver");
  if (user.kgRescued >= 50) badges.push("animal-hero");
  if (user.kgRescued >= 200) badges.push("windfall-legend");
  if (user.pickups >= 5) badges.push("gleaner");
  const picked = user.pickedTypes || [];
  if (["apple", "pear", "plum", "cherry", "blackberry"].every(t => picked.includes(t))) badges.push("all-rounder");
  if (user.nightOwl) badges.push("night-owl");
  if (user.seasonOpener) badges.push("season-opener");
  return badges;
}

app.post("/api/ai-check", authMiddleware, rateLimit({ scope: "aicheck", by: "user", max: 30, windowSec: 3600, message: "You have used the fruit checker a lot in the last hour. Please try again shortly." }), async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64 || !mediaType) return res.status(400).json({ error: "Missing image data" });
    if (!process.env.OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY is not set");
      return res.status(503).json({ error: "AI checker not configured" });
    }
    const prompt = `You are a fruit quality checker for a community apple rescue app in Rugby, UK. Analyse this photo and respond ONLY in this exact JSON format (no markdown, no extra text):\n{"grade":"good","emoji":"🍎","headline":"one short headline","summary":"2-3 sentences about quality and suitability for animals or humans","tips":"one practical tip"}\nUse grade: good=fresh/ripe/suitable, ok=slightly damaged but usable for animals/cider, bad=rotten/mouldy/unsafe. Use emoji 🍎 for good, ⚠️ for ok, 🚫 for bad.`;
    const models = [
      process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free",
      "nvidia/nemotron-nano-12b-v2-vl:free",
      "google/gemma-4-26b-a4b-it:free",
      "moonshotai/kimi-k2.6:free"
    ];
    let lastError = "AI check failed";
    for (const model of models) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`, "HTTP-Referer": "https://windfall-app.co.uk", "X-Title": "Windfall" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } }, { type: "text", text: prompt }] }], max_tokens: 300 })
        });
        const data = await response.json();
        if (!response.ok) { console.error(`AI model ${model} error:`, JSON.stringify(data)); lastError = data.error?.message || `Model error`; continue; }
        const text = data.choices?.[0]?.message?.content || "";
        if (!text) { lastError = "Empty AI response"; continue; }
        try { return res.json(JSON.parse(text.replace(/```json|```/g, "").trim())); }
        catch { lastError = "Could not parse AI response"; continue; }
      } catch (e) { console.error(`AI model ${model} threw:`, e.message); lastError = e.message; }
    }
    res.status(500).json({ error: lastError });
  } catch (err) { console.error("AI check error:", err); res.status(500).json({ error: "AI check failed" }); }
});

// ---- USER PROFILE (public safe) ----
app.get("/api/users/:id/profile", authMiddleware, async (req, res) => {
  try {
    const user = JSON.parse(await redis.get(`user:${req.params.id}`));
    if (!user || user.status === "pending" || user.status === "rejected") return res.status(404).json({ error: "User not found" });
    res.json({ id: user.id, name: user.name, kgRescued: user.kgRescued || 0, treesReported: user.treesReported || 0, pickups: user.pickups || 0, badges: computeBadges(user), joinedAt: user.joinedAt });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Windfall running on port ${PORT}`));
