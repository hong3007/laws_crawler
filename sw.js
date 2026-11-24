// 오프라인에서도 앱이 열리게: 인터넷 되면 새 파일, 안 되면 저장해 둔 파일. 법제처 API 요청은 건드리지 않음.
const CACHE = "law-app";
const FILES = ["./", "index.html", "engine.js", "worker.js", "sqlite/index.mjs", "sqlite/sqlite3.wasm",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "fonts/NanumSquareRoundR.woff2", "fonts/NanumSquareRoundB.woff2"];

self.oninstall = e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); };
self.onactivate = e => e.waitUntil(self.clients.claim());
self.onfetch = e => {
  if (new URL(e.request.url).origin !== location.origin || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request)
    .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
};
