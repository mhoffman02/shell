/**
 * @file sw.js
 * @description Universal PWA Shell Service Worker.
 */

const CACHE_NAME = 'universal-pwa-shell-v18';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './pwa.js',
  './bundles.json',
  './vendor/alpine.min.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// bundles.json is the offline-first app snapshot pwa.js mounts by default (see
// checkForFreshBundle() there) — it needs network-first handling so a background freshness
// check actually observes a same-day rebake instead of only ever seeing whatever was precached
// at this SW version's install time. Everything else stays cache-first (below).
const NETWORK_FIRST_PATTERN = /\/bundles\.json(?:$|\?)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.error('[sw] install: precache failed', err && err.stack || err);
        throw err;
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

function cacheFirst(event) {
  return caches.match(event.request).then((cached) => {
    if (cached) return cached;
    return fetch(event.request).catch((err) => {
      console.error('[sw] fetch failed', event.request.url, err && err.stack || err);
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html').then((fallback) => {
          if (fallback) return fallback;
          console.error('[sw] fetch: no cached ./index.html to fall back to for', event.request.url);
          return new Response(
            'Offline and no cached page is available. Reconnect and reload once to populate the cache.',
            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } }
          );
        });
      }
      // Non-navigation requests (fonts, images, etc.) must still resolve to a Response --
      // returning undefined here throws "Failed to convert value to 'Response'".
      return new Response('', { status: 503, statusText: 'Offline' });
    });
  });
}

function networkFirst(event) {
  return fetch(event.request)
    .then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })
    .catch((err) => {
      console.warn('[sw] network-first fetch failed, falling back to cache', event.request.url, err && err.stack || err);
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return new Response('{}', { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'application/json' } });
      });
    });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    NETWORK_FIRST_PATTERN.test(event.request.url) ? networkFirst(event) : cacheFirst(event)
  );
});
