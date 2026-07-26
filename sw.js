const CACHE = "windfall-v15";
const STATIC = ["/", "/index.html", "/style.css", "/app.js", "/manifest.json", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (e.request.url.includes("/api/")) return; // never cache API
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
