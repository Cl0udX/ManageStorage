// Service Worker: cada versión de la app es un paquete COMPLETO y atómico (cache "shell-<build>").
// El servidor inyecta BUILD (hash del contenido) y FILES (todo lo que descarga el navegador) al servir este archivo,
// así que cualquier cambio de código cambia estos bytes y el navegador instala la versión nueva solo.
// La versión nueva NO se activa a mitad de una venta: la página decide cuándo (mensaje SKIP_WAITING).
// La API (/api/*) nunca se cachea: los datos viven en IndexedDB y se sincronizan con el motor.
const BUILD = '__BUILD__';
const FILES = /*__FILES__*/[];
const CACHE = `shell-${BUILD}`;

self.addEventListener('install', (e) => {
  // 'reload' salta la caché HTTP: se descarga exactamente lo que hay en el servidor. Si algo falla (p. ej. se fue
  // el internet), la instalación aborta y se conserva la versión anterior intacta.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Todo sale del paquete de la versión instalada (consistente y funciona sin internet).
  const key = req.mode === 'navigate' ? '/index.html' : req;
  e.respondWith(caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true })).then((hit) => hit || fetch(req)));
});
