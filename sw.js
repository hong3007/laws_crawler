// 오프라인에서도 앱이 열리게: 인터넷 되면 새 파일, 안 되면 저장해 둔 파일. 법제처 API 요청은 건드리지 않음.
const CACHE = "law-app";
const FILES = ["./", "index.html", "engine.js", "worker.js", "sqlite/index.mjs", "sqlite/sqlite3.wasm",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "fonts/NanumSquareRoundR.woff2", "fonts/NanumSquareRoundB.woff2"];

self.oninstall = e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); };
self.onactivate = e => e.waitUntil(self.clients.claim());
self.onfetch = e => {
  if (new URL(e.request.url).origin !== location.origin || e.request.method !== "GET") return;
  // no-cache: 브라우저 HTTP 캐시(최대 10분)를 그대로 쓰지 말고 서버에 바뀌었나 확인 → 화면·일꾼 파일 버전이 섞이지 않게
  e.respondWith(fetch(e.request, { cache: "no-cache" })
    .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
};
