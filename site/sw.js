// RiverChart's service worker: makes the site installable and keeps the last data for offline use.
// Everything is fetched from the network first and saved; without a network the saved copy is used.
// The chart library never changes (its file name has the version), so it is served from the cache.
const CACHE = "riverchart-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "vendor/echarts-5.6.0.min.js", "favicon.svg", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/vendor/")) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => save(req, res))));
    return;
  }
  event.respondWith(
    fetch(req).then((res) => save(req, res)).catch(() =>
      // app.js and style.css carry a ?v= version; any saved version will do offline.
      caches.match(req).then((hit) => hit || caches.match(req, { ignoreSearch: true }))
        .then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())),
    ),
  );
});

function save(req, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}
