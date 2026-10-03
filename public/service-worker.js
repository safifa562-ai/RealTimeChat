const CACHE_NAME = "realtimechat-v1";

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
  );

  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", event => {

  // API और Socket.IO requests को cache मत करो
  if (
    event.request.url.includes("/api/") ||
    event.request.url.includes("/socket.io/")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .catch(() =>
        caches.match(event.request)
      )
  );

});
