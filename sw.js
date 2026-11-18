// 台股盤中即時看板 Service Worker
// 策略：
//   1. WebSocket、SSE (/api/stream)、所有 /api/ 端點、報價請求與 data.json 一律走 Network-Only（絕不快取）
//   2. 靜態網頁外殼（HTML / CSS / JS / Manifest / 圖示）採嚴格 Network-First，搭配 skipWaiting + clients.claim 確保每次推版即時生效

const CACHE_NAME = 'cmoney-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

function isNetworkOnlyRequest(request, url) {
  if (request.method !== 'GET') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  // 跨站請求（Cloudflare Worker SSE / 富果代理 / Yahoo 備援 / GitHub API / 氣象與空品代理）完全不攔截
  if (url.origin !== self.location.origin) return true;
  const accept = request.headers?.get?.('accept') || '';
  if (accept.includes('text/event-stream')) return true;
  const p = url.pathname.toLowerCase();
  // 所有 /api/、報價路徑與即時更新的盤後 data.json 絕不快取
  if (p.includes('/api/') || p.endsWith('/data/data.json') || p.includes('/quote')) {
    return true;
  }
  return false;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          APP_SHELL.map((asset) =>
            fetch(asset, { cache: 'no-cache' }).then((res) => {
              if (res && res.ok) return cache.put(asset, res);
            }),
          ),
        ),
      )
      .catch(() => {}),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // 行情、/api/、WebSocket、SSE 與跨站請求直接走網路（Network-Only）
  if (isNetworkOnlyRequest(request, url)) {
    return;
  }

  // 靜態資源（HTML / CSS / JS / Manifest / 圖示）：嚴格 Network-First，離線時才退回快取
  event.respondWith(
    (async () => {
      try {
        const netReq =
          request.mode === 'navigate'
            ? request
            : new Request(request, { cache: 'no-cache' });
        const response = await fetch(netReq);
        if (response && response.ok && !response.redirected) {
          const cacheKey = request.mode === 'navigate' ? './index.html' : request;
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(cacheKey, copy)).catch(() => {}));
        }
        return response;
      } catch {
        const cached =
          (await caches.match(request, { ignoreSearch: request.mode === 'navigate' })) ||
          (request.mode === 'navigate' ? await caches.match('./index.html') : null);
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })(),
  );
});
