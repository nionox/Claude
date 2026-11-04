// Service worker: permite abrir la app aunque la conexión sea mala.
// Las llamadas a /api nunca se guardan en caché: los datos siempre van al servidor.
const CACHE = 'tareo-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/logo.png',
  '/admin.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).pathname.startsWith('/api/')) return;

  // Primero red; si no hay conexión, usa la copia guardada
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copia));
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
  );
});
