// Service Worker: оболочка приложения доступна без интернета.
// Запросы к Яндекс.Диску (другой домен) не перехватываются и не кэшируются.

const VERSION = "vellor-46240167d8";
const SHELL = [
  "./", "index.html", "css/app.css", "manifest.webmanifest",
  "js/app.js", "js/config.js", "js/hash.js", "js/store.js", "js/sync.js", "js/yadisk.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сеть в приоритете (чтобы обновления приходили сразу), кэш — если сети нет.
// cache: "no-cache" — всегда сверяться с сервером: GitHub Pages разрешает HTTP-кэш на 10 минут,
// и без этого телефон продолжал выполнять старую версию после публикации исправлений.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
  );
});
