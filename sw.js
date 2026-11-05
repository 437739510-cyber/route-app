/**
 * Service Worker — 讓 App 可安裝到桌面、離線也能開啟
 * 策略：
 *   - App 本体（index/nav/diaobo/manifest/icon）快取优先，秒开
 *   - API（Valhalla/Photon）不缓存，永远走网络
 *   - 地图砖：先网络后缓存（离线时显示看过的区域）
 */

var CACHE = "route-app-v9";   // ★每次部署代码必须 +1，否则旧缓存永远不更新
var SHELL = [
  "./",
  "./index.html",
  "./nav.js",
  "./diaobo.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(
        SHELL.map(function (u) {
          return c.add(u).catch(function () { /* 单个失败不影响整体 */ });
        })
      );
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);

  // 1) API 一律走网络，不缓存（路线要即时）
  if (/valhalla|photon|nominatim|router\.project-osrm/i.test(url.hostname)) {
    return;
  }

  // 2) 地图砖：先网络，成功就顺手缓存（离线可看走过的地方）
  if (/tile|arcgisonline|openstreetmap|map/i.test(url.hostname) &&
      !/\/route-app\//.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(function (r) {
        if (r && r.status === 200) {
          var cp = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return r;
      }).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }

  // 3) 外部 CDN（Leaflet）：先缓存后网络
  if (/unpkg|jsdelivr|cdnjs/i.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (r) {
          var cp = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
          return r;
        });
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  // 4) 页面导航（开 App）：先网络，离线才用缓存 → 一改就生效，不会卡在旧版
  if (req.mode === "navigate" || /\/route-app\/(index\.html)?$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(function (r) {
        if (r && r.status === 200) {
          var cp = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return r;
      }).catch(function () {
        return caches.match(req).then(function (h) { return h || caches.match("./index.html"); });
      })
    );
    return;
  }

  // 5) 自家资源：先网络（保证一改就生效），断网才用缓存
  e.respondWith(
    fetch(req).then(function (r) {
      if (r && r.status === 200) {
        var cp = r.clone();
        caches.open(CACHE).then(function (c) { c.put(req, cp); });
      }
      return r;
    }).catch(function () {
      return caches.match(req).then(function (h) {
        return h || caches.match("./index.html");
      });
    })
  );
});
