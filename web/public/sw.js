// Exists only so the browser treats this as an installable PWA. It's a live SSH/vault client
// with nothing that should come from a cache, so this deliberately does no caching.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
