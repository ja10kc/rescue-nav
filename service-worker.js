/* =========================================================
 * service-worker.js — オフライン対応
 *   アプリ本体 : 事前キャッシュ（更新時は CACHE_VERSION を上げる）
 *   地図タイル : キャッシュ優先（一度表示/保存した範囲はオフラインでも表示）
 *   標高API    : ネットワーク優先 → 失敗時キャッシュ
 * ========================================================= */
const CACHE_VERSION = 'v1.5.0';
const APP_CACHE = `rescue-nav-app-${CACHE_VERSION}`;
const TILE_CACHE = 'rescue-nav-tiles';
const DATA_CACHE = 'rescue-nav-data';
const TILE_LIMIT = 4000;

const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './geo.js',
  './points.js',
  './touroku-template.xlsx',
  './app.js',
  './manifest.json',
  './nosleep.mp4',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './leaflet.js',
  './leaflet.css',
  './leaflet-rotate.js',
];
// 存在しなくてもインストールを失敗させないもの（Leaflet：同梱 or CDN）
const OPTIONAL_FILES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet-rotate@0.6.2/dist/leaflet-rotate.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(APP_FILES);
    await Promise.all(OPTIONAL_FILES.map(async (u) => {
      try {
        const res = await fetch(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin' });
        if (res.ok) await cache.put(u, res);
      } catch (e) { /* 無視 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('rescue-nav-app-') && k !== APP_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isTile = (url) =>
  /cyberjapandata\.gsi\.go\.jp\/xyz\//.test(url) || /tile\.openstreetmap\.org\//.test(url);
const isElev = (url) => /cyberjapandata2\.gsi\.go\.jp\/general\/dem\//.test(url);

let trimming = false;
async function trimTiles() {
  if (trimming) return;
  trimming = true;
  try {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    if (keys.length > TILE_LIMIT) {
      await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
    }
  } finally { trimming = false; }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // 地図タイル：キャッシュ優先
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(url, res.clone()).then(() => { if (Math.random() < 0.02) trimTiles(); });
        }
        return res;
      } catch (e) {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  // 標高API：ネットワーク優先 → キャッシュ
  if (isElev(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(url, res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match(url);
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  // アプリ本体・Leaflet：キャッシュ優先（裏で更新）
  const sameOrigin = new URL(url).origin === self.location.origin;
  if (sameOrigin || url.startsWith('https://unpkg.com/leaflet')) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { event.waitUntil(net); return hit; }
      const res = await net;
      if (res) return res;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('offline', { status: 503 });
    })());
  }
});
