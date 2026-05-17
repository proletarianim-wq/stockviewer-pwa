/*
  개발 중 service worker 캐시 제거용 파일입니다.

  이 파일은 기존 캐시를 지우고 service worker를 해제합니다.
  개발 중에는 app.js에서 registerServiceWorker()를 주석 처리해두세요.
*/

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then(clients => {
        clients.forEach(client => client.navigate(client.url));
      })
  );
});
