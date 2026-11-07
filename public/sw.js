// Minimal service worker: caches the app shell so the icon/launch screen
// works offline, but always goes to the network for data (/api, /photos)
// so schedules and photos are never served stale.
const CACHE = 'smart-shift-shell-v2';
const SHELL_FILES = [
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or photo uploads — always hit the network.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/photos')) {
    return;
  }

  // Only cache successful responses (never a login redirect page as the app shell)
  const isNav = event.request.mode === 'navigate';

  // App shell: try the network first (to pick up updates), fall back to cache
  // when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && !res.redirected && !(isNav && res.url.indexOf('login') !== -1)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
