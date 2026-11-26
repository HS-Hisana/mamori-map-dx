/* まもりマップ DX - Service Worker (PWA) v1
 * 戦略:
 *  - アプリ本体(index/manifest/アイコン): Cache First（オフラインで即起動）
 *  - CDN (Tailwind/Leaflet/FontAwesome/Google Fonts): Stale-While-Revalidate
 *  - 地図タイル (OpenStreetMap): Cache First（上限あり、古いものから削除）
 *  - それ以外: ネットワーク優先、失敗時はキャッシュ
 * 注意: Firebase / 投稿データはオンライン時のみ同期されます。
 * ログイン状態は localStorage に保存済みなので、オフラインでも維持されます。
 */
const CACHE_VERSION = "mamori-map-dx-v15";
const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-180.png",
  "./icons/icon-maskable-512.png"];
const CDN_CACHE = "mamori-map-dx-cdn-v1";
const TILE_CACHE = "mamori-map-dx-tiles-v1";
const MAX_TILES = 300;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => ![CACHE_VERSION, CDN_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});
function isTile(url) { return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) || url.pathname.includes("/tile/"); }
function isCDN(url) {
  return ["cdn.tailwindcss.com", "cdnjs.cloudflare.com", "unpkg.com",
          "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname);
}
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}
async function cacheFirst(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    if (maxEntries) trimCache(cacheName, maxEntries);
    return res;
  } catch (e) { return hit || Response.error(); }
}
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || network;
}
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // 同一オリジン: アプリ本体は Cache First、ナビゲーションは index.html にフォールバック
    event.respondWith((async () => {
      if (req.mode === "navigate") {
        const cached = await caches.match("./index.html");
        try { const res = await fetch(req); if (res.ok) { const c = await caches.open(CACHE_VERSION); c.put("./index.html", res.clone()); } return res; }
        catch (e) { return cached || Response.error(); }
      }
      return cacheFirst(req, CACHE_VERSION);
    })());
    return;
  }
  if (isTile(url)) { event.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES)); return; }
  if (isCDN(url)) { event.respondWith(staleWhileRevalidate(req, CDN_CACHE)); return; }
  // その他外部 (警察・消防HP等): ネットワーク優先
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
