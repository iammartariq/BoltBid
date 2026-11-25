// ============================================================================
// client/sw.js — Progressive Web App Service Worker
// ============================================================================
// Caches the app shell for instant load & offline resilience while always
// keeping WebSocket traffic and live admin/auction APIs network-live.
// ============================================================================

const CACHE_NAME = 'boltbid-v1';
const SHELL_ASSETS = [
  '/styles.css',
  '/admin.css',
  '/auth.css',
  '/app.js',
  '/admin.js',
  '/login.js',
  '/admin-login.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/api/admin/') ||
    url.pathname.startsWith('/api/auth/') ||
    url.pathname === '/' ||
    url.pathname === '/login' ||
    url.pathname === '/signup' ||
    url.pathname === '/admin' ||
    url.pathname === '/admin/' ||
    url.pathname === '/admin/login' ||
    request.mode === 'navigate'
  ) {
    return;
  }

  // Network-first for public API snapshots
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Stale-while-revalidate for static CSS/JS/icons
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
