# 🍎 Windfall

> Warwickshire's community apple rescue map. Spot a tree. Pin it. Save the fruit.

Built by **Akhil Akella**, age 13, House Leader, Warwickshire Youth Council member, BBC CWR Young Hero Award winner.

---

## What is Windfall?

Every autumn, hundreds of apple trees across Warwickshire drop fruit onto pavements, rotting, wasted, crushed under car tyres. Windfall lets anyone in the community:

- 📍 **Pin trees** they spot on a live map
- 🔴🟢🔵 **Track status** — Ready to Pick / Picked / Rotten
- 🧺 **Log pickups** and track how many kg of fruit they've rescued
- 🏆 **Compete** on a community leaderboard
- 🎖️ **Earn badges** — Tree Scout, Animal Hero, Windfall Legend...

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | HTML/CSS/JS — installable PWA |
| Map | Leaflet.js + OpenStreetMap (free, no API key) |
| Backend | Node.js + Express |
| Database | Redis |
| Hosting | Render |

---

## Local Development

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/windfall.git
cd windfall

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your Redis URL and a JWT secret

# 4. Run Redis locally (or use Render's Redis)
# On Mac: brew install redis && redis-server
# On Linux: sudo apt install redis-server && redis-server

# 5. Start the dev server
npm run dev

# App runs at http://localhost:3000
```

---

## Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Add a **Redis** service on Render (free tier)
6. Set environment variables:
   - `REDIS_URL` — from your Render Redis instance
   - `JWT_SECRET` — any long random string
7. Deploy!

---

## PWA Install

On mobile, visit the app URL and tap **"Add to Home Screen"**, it works like a native app with no App Store needed.

---

## Badges

| Badge | How to earn |
|-------|-------------|
| 🌱 Tree Scout | Report your first tree |
| 🗺️ Orchard Mapper | Report 10 trees |
| 🍎 Apple Saver | Rescue 5kg of fruit |
| 🐾 Animal Hero | Rescue 50kg of fruit |
| 👑 Windfall Legend | Rescue 200kg of fruit |
| 🧺 Gleaner | Log 5 pickups |

---

## Organisations to Partner With

- 🌿 Warwickshire Eco Hub
- 🍎 Friends of Dunchurch Society (FODS)
- 🌳 Midshires Orchard Group
- 🧺 Harvest Share (Forest of Hearts)
- 🏛️ Warwickshire Youth Council

---

*Made with 🍎 in Rugby, Warwickshire.*
