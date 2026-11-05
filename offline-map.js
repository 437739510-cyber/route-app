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
    /* ★ 你的真实跑单走廊：中永和 ⇄ 台北市（含所有跨河桥） */
    corridor: {
      name: "中永和 ⇄ 台北市（含所有跨河橋）",
      boxes: [
        { latMin: 24.965, latMax: 25.035, lngMin: 121.465, lngMax: 121.535 },  // 中和+永和
        { latMin: 24.945, latMax: 25.215, lngMin: 121.465, lngMax: 121.675 }   // 台北市12区
      ],
      zMin: 13, zMax: 17
    },
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
    var boxes = reg.boxes || [reg];
    var seen = {}, out = [];
    for (var bi = 0; bi < boxes.length; bi++) {
      var b = boxes[bi];
      for (var z = reg.zMin; z <= reg.zMax; z++) {
        var x0 = lng2x(b.lngMin, z), x1 = lng2x(b.lngMax, z);
        var y0 = lat2y(b.latMax, z), y1 = lat2y(b.latMin, z);
        for (var x = x0; x <= x1; x++) {
          for (var y = y0; y <= y1; y++) {
            var k = z + "/" + x + "/" + y;
            if (seen[k]) continue;      // ★ 多個框重疊處去重
            seen[k] = 1;
            out.push({ z: z, x: x, y: y });
          }
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

  /* 核心：並發下載，已存在的跳過，失敗自動重試 */
  async function download(regionKey) {
    var reg = REGIONS[regionKey];
    if (!reg) return;
    var list = tileList(reg);
    ST.total = list.length;
    ST.done = 0; ST.fail = 0; ST.skip = 0; ST.running = true; ST.abort = false;
    ST.attempted = 0;
    paint();

    var cache = await caches.open(TILE_CACHE);
    var idx = 0;
    var MAX_RETRY = 2;

    async function fetchOne(t) {
      var url = tileUrl(t);
      try {
        var hit = await cache.match(url);
        if (hit) { ST.skip++; return; }
      } catch (e) { /* 读缓存失败就当没命中 */ }

      for (var attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
          var cleanUrl = url;    // 地图取图用的干净地址（缓存键必须是这个）
          var dlUrl = url + (url.indexOf("?") < 0 ? "?" : "&") + "_dl=1";
          var r = await fetch(dlUrl, { mode: "cors", cache: "no-store" });
          if (r && r.status === 200) {
            var blob = await r.blob();
            if (blob && blob.size > 0) {
              // ★ 用 cleanUrl 当键，地图正常取图时才命中
              await cache.put(new Request(cleanUrl), new Response(blob, {
                headers: { "Content-Type": "image/png" }
              }));
              ST.done++;
              return;
            }
          }
          if (r && r.status === 404) { ST.fail++; return; }   // 该级没这张图，正常
        } catch (e) { /* 重试 */ }
        if (attempt < MAX_RETRY) {
          await new Promise(function (s) { setTimeout(s, 350 * (attempt + 1)); });
        }
      }
      ST.fail++;
    }

    async function worker() {
      while (true) {
        var my = idx++;
        if (my >= list.length || ST.abort) return;
        await fetchOne(list[my]);
        ST.attempted++;
        if (ST.attempted % 10 === 0) paint();
        if (ST.attempted % 10 === 0) saveProg(regionKey, ST.attempted);
        if (ST.attempted % 120 === 0) {
          await new Promise(function (s) { setTimeout(s, 120); });  // 温柔一点
        }
      }
    }

    var ws = [];
    for (var k = 0; k < CONCURRENCY; k++) ws.push(worker());
    await Promise.all(ws);

    ST.running = false;
    saveProg(regionKey, ST.attempted);
    paint();
    var u = ui();
    if (u.btn) u.btn.textContent = "繼續下載（可重複點）";
    if (typeof toast === "function") {
      toast(ST.abort ? ("已停止，下次會續傳（已完成 " + (ST.done + ST.skip) + " 張）")
                     : ("離線地圖完成：新增 " + ST.done + " 張，失敗 " + ST.fail + " 張"),
        ST.abort ? 3000 : 4500);
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
