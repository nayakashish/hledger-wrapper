// hledger service worker
//
// Two caches:
// - SHELL_CACHE holds the HTML. It is network-first, because new HTML is how
//   a deploy reaches the phone: it points at the new asset hashes.
// - ASSET_CACHE holds /assets/*. Those filenames are content-hashed, so a
//   cached copy is always correct and is served without asking the network.
const SHELL_CACHE = 'hledger-shell-v2';
const ASSET_CACHE = 'hledger-assets';
const CACHES = [SHELL_CACHE, ASSET_CACHE];
const SHELL = ['/'];

// Old builds' files are never requested again. Cache keys keep insertion
// order, so dropping the oldest beyond this cap clears past builds first; a
// current file that gets dropped is simply fetched and cached again.
const MAX_ASSETS = 60;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !CACHES.includes(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function trimAssets(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map(k => cache.delete(k)));
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimAssets(cache);
  }
  return response;
}

async function networkFirst(request) {
  // Every page of the SPA is the same HTML, so navigations share one entry.
  const key = request.mode === 'navigate' ? '/' : request;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(key, response.clone());
    }
    return response;
  } catch (e) {
    const hit = await caches.match(key);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Other origins (the font) use the browser's own HTTP cache.
  if (url.origin !== self.location.origin) return;

  // Always network for API calls
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
