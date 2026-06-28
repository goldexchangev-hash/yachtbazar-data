/* Crypto TV Flip — service worker.
   NETWORK-FIRST for same-origin GETs: always tries the network (so ?v= deploys
   are picked up immediately and users never get a stale build online), caching
   each response, and falls back to cache only when offline. Cross-origin
   requests (RPC node, fonts, price API, MetaMask) are left untouched. */
const CACHE = "ctf-v11.73";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // don't touch RPC / fonts / CDNs

  // CACHE-FIRST for immutable, versioned assets (anything carrying a ?v= query, or
  // the /vendor/ libs like three.min.js): these only change when their ?v= is
  // bumped, so a cache hit is always correct AND instant on refresh — this is what
  // makes the big Three.js bundle + lazy 3D modules load fast instead of being
  // re-fetched over the network every time.
  const immutable = url.search.includes("v=") || url.pathname.includes("/vendor/");
  if (immutable) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => new Response("", { status: 503, statusText: "Offline asset unavailable" }))
      )
    );
    return;
  }

  // NETWORK-FIRST for everything else (HTML, unversioned files) so deploys land.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
