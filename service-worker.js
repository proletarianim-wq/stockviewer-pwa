const CACHE_NAME = "stockviewer-pwa-v3";

const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.svg",
  "./icon-512.svg",
  "./assets/icons/nav/quote-off.png",
  "./assets/icons/nav/quote-on.png",
  "./assets/icons/nav/asset-off.png",
  "./assets/icons/nav/asset-on.png",
  "./assets/icons/nav/weight-off.png",
  "./assets/icons/nav/weight-on.png",
  "./assets/icons/nav/trend-off.png",
  "./assets/icons/nav/trend-on.png",
  "./assets/icons/nav/refresh-off.png",
  "./assets/icons/nav/refresh-on.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => null)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(key => {
    if (key !== CACHE_NAME) return caches.delete(key);
  }))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
