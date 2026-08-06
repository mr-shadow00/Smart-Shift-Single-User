// Bump this whenever shell files change so old caches get cleared out.
const CACHE_VERSION = 'shifts-shell-v2';

// The "app shell" — static files needed to boot the UI without a network
// connection. Actual schedule data always comes fresh from /api/data.
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept writes (PUT/POST)

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Schedule data must always be live — never served from cache.
  if (url.pathname.startsWith('/api/')) return;

  // Saved photo originals are content-addressed by timestamp, so they're
  // safe to cache aggressively once fetched.
  if (url.pathname.startsWith('/photos/')) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
    );
    return;
  }

  // App shell: network-first so users get updates immediately when online,
  // falling back to the cached copy when offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
  );
});
