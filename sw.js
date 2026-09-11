// Service Worker：让 App 可离线打开、可添加到主屏幕
// v10 改动：改为 network-first，解决「更新后仍显示旧版」问题
const CACHE = 'ds-app-v10';
const ASSETS = ['index.html', 'style.css', 'app.js', 'manifest.webmanifest',
                'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())   // 立即接管，不等旧页面关闭
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // 立即控制已打开的页面
  );
});

self.addEventListener('fetch', e => {
  // 只处理同源 GET
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;

  // network-first：联网时永远拿最新版；断网才回退缓存
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 成功则更新缓存副本
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html')))
  );
});
