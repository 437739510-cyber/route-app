/**
 * 離線地圖下載器 — 把指定範圍的地圖磚存進手機
 * 設計重點：
 *  1) 存在獨立 cache（offline-tiles-v1），不跟 App 外殼混，改版不會被清掉
 *  2) 可中斷續傳：已下載的跳過（斷網/關頁都不丟進度）
 *  3) 限速並發 6，避免把免費瓦片服務打掛
 *  4) 進度存 localStorage，重開頁面可續
 */
(function () {
  var TILE_CACHE = "offline-tiles-v1";
  var TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
  var CONCURRENCY = 6;
  var LS_PROG = "offlineTilesProgress";

  /* 區域預設（緯度/經度邊界） */
  var REGIONS = {
    core: {
      name: "中永和·板橋·台北西區",
      latMin: 24.96, latMax: 25.10, lngMin: 121.42, lngMax: 121.58,
      zMin: 13, zMax: 17
    },
    all: {
      name: "雙北全境",
      latMin: 24.75, latMax: 25.35, lngMin: 121.25, lngMax: 122.05,
      zMin: 13, zMax: 16
    }
  };

  function lng2x(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }

  function tileList(reg) {
    var out = [];
    for (var z = reg.zMin; z <= reg.zMax; z++) {
      var x0 = lng2x(reg.lngMin, z), x1 = lng2x(reg.lngMax, z);
      var y0 = lat2y(reg.latMax, z), y1 = lat2y(reg.latMin, z);
      for (var x = x0; x <= x1; x++) {
        for (var y = y0; y <= y1; y++) {
          out.push({ z: z, x: x, y: y });
        }
      }
    }
    return out;
  }

  function tileUrl(t) {
    return TILE_URL.replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y);
  }

  var ST = { running: false, done: 0, total: 0, fail: 0, skip: 0, abort: false };

  function ui() {
    return {
      bar: document.getElementById("offBar"),
      txt: document.getElementById("offTxt"),
      btn: document.getElementById("offStart"),
      cancel: document.getElementById("offCancel"),
      panel: document.getElementById("offPanel")
    };
  }

  function paint() {
    var u = ui();
    if (!u.txt) return;
    var pct = ST.total ? Math.round((ST.done + ST.skip) / ST.total * 100) : 0;
    u.txt.textContent = ST.running
      ? ("下載中 " + (ST.done + ST.skip) + " / " + ST.total + "（" + pct + "%）失敗 " + ST.fail)
      : ("已就緒 " + ST.total + " 張圖（" + Math.round(ST.total * 22 / 1024) + " MB）");
    if (u.bar) u.bar.style.width = pct + "%";
  }

  function saveProg(regionKey, done) {
    try {
      localStorage.setItem(LS_PROG, JSON.stringify({ region: regionKey, done: done, at: Date.now() }));
    } catch (e) {}
  }
  function loadProg() {
    try { return JSON.parse(localStorage.getItem(LS_PROG) || "null"); } catch (e) { return null; }
  }

  /* 核心：並發下載，已存在的跳過 */
  async function download(regionKey) {
    var reg = REGIONS[regionKey];
    if (!reg) return;
    var list = tileList(reg);
    ST.total = list.length;
    ST.done = 0; ST.fail = 0; ST.skip = 0; ST.running = true; ST.abort = false;
    paint();

    var cache = await caches.open(TILE_CACHE);
    var i = 0;

    async function worker() {
      while (i < list.length && !ST.abort) {
        var t = list[i++];
        var url = tileUrl(t);
        try {
          var hit = await cache.match(url);
          if (hit) { ST.skip++; }
          else {
            var r = await fetch(url, { mode: "cors" });
            if (r && r.status === 200) {
              await cache.put(url, r.clone());
              ST.done++;
            } else {
              ST.fail++;
            }
          }
        } catch (e) {
          ST.fail++;
        }
        if ((ST.done + ST.skip) % 20 === 0) { paint(); saveProg(regionKey, i); }
        if ((ST.done + ST.skip) % 200 === 0) await new Promise(function (s) { setTimeout(s, 60); });
      }
    }

    var ws = [];
    for (var k = 0; k < CONCURRENCY; k++) ws.push(worker());
    await Promise.all(ws);

    ST.running = false;
    saveProg(regionKey, i);
    paint();
    var u = ui();
    if (u.btn) u.btn.textContent = "重新檢查";
    if (typeof toast === "function") {
      toast(ST.abort ? "已停止，下次會續傳" : ("離線地圖完成：" + ST.done + " 張新增，失敗 " + ST.fail),
        ST.abort ? 2500 : 4000);
    }
  }

  /* 統計已存多少 */
  async function stats() {
    var cache = await caches.open(TILE_CACHE);
    var keys = await cache.keys();
    return keys.length;
  }

  function bind() {
    var start = document.getElementById("offStart");
    var cancel = document.getElementById("offCancel");
    var sel = document.getElementById("offRegion");
    if (!start) return;

    start.onclick = function () {
      if (ST.running) return;
      var key = (sel && sel.value) || "core";
      start.textContent = "下載中…";
      download(key);
    };
    if (cancel) cancel.onclick = function () { ST.abort = true; };

    // 首次開啟顯示已下載量
    stats().then(function (n) {
      var el = document.getElementById("offStored");
      if (el) el.textContent = n ? ("已存 " + n + " 張圖 ≈ " + Math.round(n * 22 / 1024) + " MB") : "尚未下載";
    });
  }

  window.OFFLINE_MAP = {
    REGIONS: REGIONS,
    download: download,
    stats: stats,
    tileList: tileList,
    ST: ST
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
