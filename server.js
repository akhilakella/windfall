const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "windfall-secret-key-change-in-prod";

// -------------------- Redis --------------------
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  tls: redisUrl.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
});
redis.on("error", (err) => console.error("Redis error:", err));
redis.on("connect", () => console.log("Redis connected"));

// -------------------- Middleware --------------------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname)));

// Uploads folder
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const ADMIN_EMAIL = "akhilakella@outlook.com";

// -------------------- Auth Middleware --------------------
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.email !== ADMIN_EMAIL) return res.status(403).json({ error: "Admin only" });
  next();
}

// -------------------- Auth Routes --------------------
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "All fields required" });

    const existing = await redis.get(`user:email:${email.toLowerCase()}`);
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    const user = {
      id, name, email: email.toLowerCase(),
      password: hash,
      kgRescued: 0,
      treesReported: 0,
      pickups: 0,
      badges: [],
      joinedAt: Date.now(),
    };
    await redis.set(`user:${id}`, JSON.stringify(user));
    await redis.set(`user:email:${email.toLowerCase()}`, id);

    const token = jwt.sign({ id, name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id, name, email: user.email, kgRescued: 0, treesReported: 0, pickups: 0, badges: [] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "All fields required" });

    const userId = await redis.get(`user:email:${email.toLowerCase()}`);
    if (!userId) return res.status(401).json({ error: "Invalid email or password" });

    const user = JSON.parse(await redis.get(`user:${userId}`));
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, kgRescued: user.kgRescued, treesReported: user.treesReported, pickups: user.pickups, badges: user.badges }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ id: user.id, name: user.name, email: user.email, kgRescued: user.kgRescued, treesReported: user.treesReported, pickups: user.pickups, badges: user.badges });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Tree Routes --------------------
app.get("/api/trees", async (req, res) => {
  try {
    const keys = await redis.keys("tree:*");
    const trees = [];
    for (const key of keys) {
      const parts = key.split(":");
      if (parts.length !== 2) continue; // skip any nested keys
      const t = await redis.get(key);
      if (t) trees.push(JSON.parse(t));
    }
    res.json(trees);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/trees", authMiddleware, upload.single("photo"), async (req, res) => {
  try {
    const { lat, lng, type, landType, notes, estimatedKg, address } = req.body;
    if (!lat || !lng || !type) return res.status(400).json({ error: "lat, lng and type required" });

    const id = uuidv4();
    const tree = {
      id, lat: parseFloat(lat), lng: parseFloat(lng),
      type, landType: landType || "unknown",
      notes: notes || "",
      address: address || "",
      estimatedKg: parseFloat(estimatedKg) || 0,
      status: "active", // active | picked | rotten
      photo: req.file ? `/uploads/${req.file.filename}` : null,
      reportedBy: req.user.id,
      reportedByName: req.user.name,
      reportedAt: Date.now(),
      pickups: [],
    };
    await redis.set(`tree:${id}`, JSON.stringify(tree));

    // Update user stats
    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    user.treesReported = (user.treesReported || 0) + 1;
    user.badges = computeBadges(user);
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));

    res.json(tree);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/api/trees/:id/pickup", authMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    const tree = JSON.parse(raw);
    const { kg } = req.body;
    const kgNum = parseFloat(kg) || 0;

    tree.pickups.push({ by: req.user.id, byName: req.user.name, kg: kgNum, at: Date.now() });
    tree.status = "picked";
    await redis.set(`tree:${tree.id}`, JSON.stringify(tree));

    // Update user stats
    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    user.kgRescued = (user.kgRescued || 0) + kgNum;
    user.pickups = (user.pickups || 0) + 1;
    user.badges = computeBadges(user);
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));

    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/api/trees/:id/status", authMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    const tree = JSON.parse(raw);
    tree.status = req.body.status || tree.status;
    await redis.set(`tree:${tree.id}`, JSON.stringify(tree));
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Forgot password - send reset email
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const userId = await redis.get(`user:email:${email.toLowerCase()}`);
    if (!userId) return res.json({ success: true }); // Don't reveal if email exists

    const resetToken = uuidv4();
    await redis.set(`reset:${resetToken}`, userId, "EX", 3600); // 1 hour expiry

    const resetUrl = `${process.env.APP_URL || "https://windfall-jvc3.onrender.com"}/reset-password?token=${resetToken}`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: "Windfall <onboarding@resend.dev>",
        to: email.toLowerCase(),
        subject: "Reset your Windfall password",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f1a0e;color:#e8f0e6;border-radius:16px;">
            <h1 style="font-size:1.8rem;margin-bottom:8px;">🍎 Windfall</h1>
            <p style="color:#8aab85;margin-bottom:24px;">Rugby's Apple Rescue Map</p>
            <h2 style="font-size:1.2rem;margin-bottom:12px;">Reset your password</h2>
            <p style="margin-bottom:24px;line-height:1.6;">Click the button below to reset your password. This link expires in 1 hour.</p>
            <a href="${resetUrl}" style="display:inline-block;background:#4a7c3f;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;margin-bottom:24px;">Reset Password</a>
            <p style="font-size:0.8rem;color:#556b52;">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `
      })
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Reset password with token
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
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Change password (logged in user - no current password needed)
app.post("/api/change-password", authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: "New password required" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const user = JSON.parse(await redis.get(`user:${req.user.id}`));
    if (!user) return res.status(404).json({ error: "User not found" });

    user.password = await bcrypt.hash(newPassword, 10);
    await redis.set(`user:${req.user.id}`, JSON.stringify(user));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Admin Routes --------------------
app.get("/api/admin/check", authMiddleware, (req, res) => {
  res.json({ isAdmin: req.user.email === ADMIN_EMAIL });
});

app.delete("/api/trees/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    await redis.del(`tree:${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Admin: edit tree
app.patch("/api/admin/trees/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const raw = await redis.get(`tree:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Tree not found" });
    const tree = JSON.parse(raw);
    const { type, notes, landType, estimatedKg, address } = req.body;
    if (type) tree.type = type;
    if (notes !== undefined) tree.notes = notes;
    if (landType) tree.landType = landType;
    if (estimatedKg !== undefined) tree.estimatedKg = parseFloat(estimatedKg) || 0;
    if (address !== undefined) tree.address = address;
    await redis.set(`tree:${tree.id}`, JSON.stringify(tree));
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Admin: reset all stats
app.post("/api/admin/reset-stats", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const keys = await redis.keys("user:*");
    for (const key of keys) {
      if (key.includes("email")) continue;
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const u = JSON.parse(await redis.get(key));
      if (u) {
        u.kgRescued = 0;
        u.pickups = 0;
        u.treesReported = 0;
        u.badges = [];
        await redis.set(key, JSON.stringify(u));
      }
    }
    // Also reset all tree pickup history
    const treeKeys = await redis.keys("tree:*");
    for (const key of treeKeys) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const t = JSON.parse(await redis.get(key));
      if (t) {
        t.pickups = [];
        t.status = "active";
        await redis.set(key, JSON.stringify(t));
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Admin: analytics
app.get("/api/admin/analytics", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userKeys = await redis.keys("user:*");
    const treeKeys = await redis.keys("tree:*");
    let totalKg = 0, totalUsers = 0, totalTrees = 0, totalPickups = 0;
    const userStats = [];

    for (const key of userKeys) {
      if (key.includes("email")) continue;
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const u = JSON.parse(await redis.get(key));
      if (u && u.name) {
        totalUsers++;
        totalKg += u.kgRescued || 0;
        totalPickups += u.pickups || 0;
        userStats.push({ name: u.name, kgRescued: u.kgRescued || 0, treesReported: u.treesReported || 0, pickups: u.pickups || 0 });
      }
    }

    for (const key of treeKeys) {
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      totalTrees++;
    }

    userStats.sort((a, b) => b.kgRescued - a.kgRescued);
    res.json({ totalKg, totalUsers, totalTrees, totalPickups, topUsers: userStats.slice(0, 5) });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Admin: post/get announcement
app.post("/api/admin/announcement", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      await redis.del("announcement");
      return res.json({ success: true, cleared: true });
    }
    const announcement = { message, postedAt: Date.now() };
    await redis.set("announcement", JSON.stringify(announcement));
    res.json(announcement);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/announcement", async (req, res) => {
  try {
    const raw = await redis.get("announcement");
    res.json(raw ? JSON.parse(raw) : null);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Leaderboard --------------------
app.get("/api/leaderboard", async (req, res) => {
  try {
    const keys = await redis.keys("user:*");
    const users = [];
    for (const key of keys) {
      if (key.includes("email")) continue;
      const parts = key.split(":");
      if (parts.length !== 2) continue;
      const u = JSON.parse(await redis.get(key));
      if (u && u.name) users.push({ name: u.name, kgRescued: u.kgRescued || 0, treesReported: u.treesReported || 0, pickups: u.pickups || 0, badges: u.badges || [] });
    }
    users.sort((a, b) => b.kgRescued - a.kgRescued);
    res.json(users.slice(0, 20));
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Badges --------------------
function computeBadges(user) {
  const badges = [];
  if (user.treesReported >= 1) badges.push("tree-scout");
  if (user.treesReported >= 10) badges.push("orchard-mapper");
  if (user.kgRescued >= 5) badges.push("apple-saver");
  if (user.kgRescued >= 50) badges.push("horse-hero");
  if (user.kgRescued >= 200) badges.push("windfall-legend");
  if (user.pickups >= 5) badges.push("gleaner");
  return badges;
}

// -------------------- AI Fruit Checker --------------------
app.post("/api/ai-check", authMiddleware, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64 || !mediaType) return res.status(400).json({ error: "Missing image data" });

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://windfall-jvc3.onrender.com",
        "X-Title": "Windfall"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
            { type: "text", text: `You are a fruit quality checker for a community apple rescue app in Rugby, UK. Analyse this photo and respond ONLY in this exact JSON format (no markdown, no extra text):
{"grade":"good","emoji":"🍎","headline":"one short headline","summary":"2-3 sentences about quality and suitability for horses or humans","tips":"one practical tip"}
Use grade: good=fresh/ripe/suitable, ok=slightly damaged but usable for animals/cider, bad=rotten/mouldy/unsafe. Use emoji 🍎 for good, ⚠️ for ok, 🚫 for bad.` }
          ]
        }],
        max_tokens: 300
      })
    });

    const data = await response.json();
    console.log("OpenRouter response:", JSON.stringify(data).substring(0, 500));
    const text = data.choices?.[0]?.message?.content || "";
    try {
      const result = JSON.parse(text.replace(/```json|```/g, "").trim());
      res.json(result);
    } catch {
      res.status(500).json({ error: "Could not parse AI response" });
    }
  } catch (err) {
    console.error("AI check error:", err);
    res.status(500).json({ error: "AI check failed" });
  }
});

// -------------------- Serve App --------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => console.log(`Windfall running on port ${PORT}`));
