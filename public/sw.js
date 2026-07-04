/* Crypto TV Flip — service worker.
   NETWORK-FIRST for same-origin GETs: always tries the network (so ?v= deploys
   are picked up immediately and users never get a stale build online), caching
   each response, and falls back to cache only when offline. Cross-origin
   requests (RPC node, fonts, price API, MetaMask) are left untouched. */
const CACHE = "ctf-v13.69";
// P1: the vendor libs (PIXI/Three/PlayCanvas/ethers, ~3.9MB) NEVER change between deploys, yet the old
// single-cache design deleted them on every version bump → returning players re-downloaded the lot each deploy.
// Keep them in a SEPARATE long-lived cache that the activate purge whitelists; paired with library-pinned ?v
// tokens (e.g. ?v=three-1) on the vendor URLs so a build bump can't cache-bust them. Bump ctf-vendor-vN only
// when an actual file in /vendor/ is replaced.
const VENDOR_CACHE = "ctf-vendor-v1";
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== VENDOR_CACHE).map((k) => caches.delete(k)))) // P1: keep the long-lived vendor cache across deploys
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
  const isVendor = url.pathname.includes("/vendor/"); // P1: route these to the long-lived VENDOR_CACHE
  const immutable = /[?&]v=/.test(url.search) || isVendor; // v6 #15: anchor v= to a query-param boundary so ?nav=/?rev= don't false-match as immutable → stale-cache forever
  if (immutable) {
    const store = isVendor ? VENDOR_CACHE : CACHE;
    e.respondWith(
      caches.match(req).then((hit) => // caches.match() searches ALL caches, so a vendor hit is found regardless of which store it's in
        hit || fetch(req).then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(store).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => new Response("", { status: 503, statusText: "Offline asset unavailable" }))
      )
    );
    return;
  }

  // Never cache API responses — they're live state (e.g. bridge/status, balances); a
  // cached copy would serve stale data after the network comes back.
  const isApi = url.pathname.startsWith("/api/");

  // NETWORK-FIRST for everything else (HTML, unversioned files) so deploys land.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic" && !isApi) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
