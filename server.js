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
    const { lat, lng, type, landType, notes, estimatedKg } = req.body;
    if (!lat || !lng || !type) return res.status(400).json({ error: "lat, lng and type required" });

    const id = uuidv4();
    const tree = {
      id, lat: parseFloat(lat), lng: parseFloat(lng),
      type, landType: landType || "unknown",
      notes: notes || "",
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

    const apiKey = process.env.GEMINI_API_KEY;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mediaType, data: imageBase64 } },
            { text: `You are a fruit quality checker for a community apple rescue app in Rugby, UK. Analyse this photo and respond ONLY in this exact JSON format (no markdown, no extra text):
{"grade":"good","emoji":"🍎","headline":"one short headline","summary":"2-3 sentences about quality and suitability for horses or humans","tips":"one practical tip"}
Use grade: good=fresh/ripe/suitable, ok=slightly damaged but usable for animals/cider, bad=rotten/mouldy/unsafe. Use emoji 🍎 for good, ⚠️ for ok, 🚫 for bad.` }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
      })
    });

    const data = await response.json();
    console.log("Gemini response:", JSON.stringify(data).substring(0, 500));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
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
