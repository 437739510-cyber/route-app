/**
 * 內建導航模組 — 不離開 App，直接在地圖上導航
 * 功能：全螢幕導航、大字轉彎提示、語音播報、GPS 跟隨、偏離偵測
 */

var NAV = {
  active: false,
  route: null,        // {geometry, legs, maneuvers, distance, duration}
  idx: 0,             // 目前走到第幾個 maneuver
  watchId: null,
  lastPos: null,
  offCourse: 0,       // 連續偏離次數
  voiceOn: true,
  spoken: {},         // 已播報過的索引
  speechUnlocked: false,
  wakeLock: null,
  map: null,
  lineLayer: null,
  meMarker: null,
  remaining: 0
};

/* ── 語音播報 ── */
/* 優先用 APK 內的原生 TTS（WebView 的 speechSynthesis 在安卓常失效）*/
function nativeTTS() {
  try {
    if (window.AndroidTTS && typeof window.AndroidTTS.speak === "function"
        && window.AndroidTTS.ready()) return window.AndroidTTS;
  } catch (e) {}
  return null;
}

function speak(text) {
  if (!NAV.voiceOn) return;
  var nat = nativeTTS();
  if (nat) { try { nat.speak(text); return; } catch (e) {} }
  if (!window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW";
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    // 優先找中文語音
    var vs = speechSynthesis.getVoices();
    for (var i = 0; i < vs.length; i++) {
      if (/zh[-_]?(TW|HK|CN)/i.test(vs[i].lang)) { u.voice = vs[i]; break; }
    }
    speechSynthesis.speak(u);
  } catch (e) { /* 忽略 */ }
}

/* Android/iOS 瀏覽器規定：語音要有「使用者動作」才能啟動。
   若沒解鎖，導航全程不會出声。這裡在第一次點任何地方時解鎖。 */
function unlockSpeech() {
  if (NAV.speechUnlocked) return;
  if (nativeTTS()) { NAV.speechUnlocked = true; return; }  // 原生 TTS 不需解鎖
  try {
    var u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    NAV.speechUnlocked = true;
  } catch (e) {}
}
["touchstart", "click", "keydown"].forEach(function (ev) {
  document.addEventListener(ev, unlockSpeech, { passive: true, once: false });
});

/* 螢幕常亮：導航中不能讓手機睡屏 */
function keepAwakeOn() {
  if (!navigator.wakeLock) return;
  navigator.wakeLock.request("screen").then(function (wl) {
    NAV.wakeLock = wl;
    wl.addEventListener("release", function () {
      // 被系統切走會自動釋放，回來時重新要
      if (NAV.active) setTimeout(keepAwakeOn, 1000);
    });
  }).catch(function () {});
}
function keepAwakeOff() {
  if (NAV.wakeLock) { try { NAV.wakeLock.release(); } catch (e) {} NAV.wakeLock = null; }
}
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && NAV.active) keepAwakeOn();
});

/* ── 轉彎指令轉中文（依 Valhalla 實測 type 對照）── */
var TURN_TEXT = {
  0: "繼續前行",
  1: "出發",
  2: "出發",
  3: "出發",
  4: "抵達目的地",
  5: "抵達（目的地在右邊）",
  6: "抵達（目的地在左邊）",
  7: "接續",
  8: "繼續直行",
  9: "微靠右",
  10: "右轉",
  11: "急右轉",
  12: "迴轉",
  13: "迴轉",
  14: "急左轉",
  15: "左轉",
  16: "微靠左",
  17: "上匝道",
  18: "右匝道",
  19: "左匝道",
  20: "右側出口",
  21: "左側出口",
  22: "保持直行",
  23: "靠右",
  24: "靠左",
  25: "匯入",
  26: "進入圓環",
  27: "離開圓環",
  28: "上渡輪",
  29: "下渡輪"
};

/* 依 type 給箭頭 */
var TURN_ICON = {
  1: "🚀", 2: "🚀", 3: "🚀",
  4: "🏁", 5: "🏁", 6: "🏁",
  8: "⬆️", 9: "↗️", 10: "➡️", 11: "⤵️",
  12: "↩️", 13: "↩️", 14: "⤴️", 15: "⬅️", 16: "↖️",
  17: "⬆️", 18: "↗️", 19: "↖️",
  20: "↗️", 21: "↖️",
  22: "⬆️", 23: "➡️", 24: "⬅️", 25: "⬆️",
  26: "🔄", 27: "🔄"
};

function turnText(t) {
  return TURN_TEXT[t] || "繼續前行";
}

/* ── 機車左轉三分法（台灣規則）──
   1) 高架道路：絕對禁止左轉（會跟直行汽車對撞）
   2) 有待轉標誌路口：兩段式左轉
   3) 一般路口無待轉：可直接左轉
   具體判斷放在 leftrule.js 的 LEFT_RULE */
function isLeftTurn(t) {
  return t === 14 || t === 15 || t === 19 || t === 21 || t === 24;
}

function leftInfo(m) {
  try {
    if (window.LEFT_RULE && window.LEFT_RULE.leftRule) return window.LEFT_RULE.leftRule(m);
  } catch (e) {}
  return isLeftTurn(m.type) ? {
    level: "hook", title: "🔄 兩段式左轉（進待轉區）",
    detail: "先騎進待轉區，等綠燈再左轉",
    speech: "前方請兩段式左轉，先騎進待轉區",
    color: "#b45309"
  } : null;
}

/* 給人看的轉彎指令 */
function turnInstruction(m) {
  var li = leftInfo(m);
  if (li) return li.title;
  return turnText(m.type);
}

/* 語音版本 */
function turnSpeech(m) {
  var li = typeof m === "object" ? leftInfo(m) : null;
  if (li) return li.speech;
  return turnText(typeof m === "object" ? m.type : m);
}


function turnIcon(t) {
  return TURN_ICON[t] || "⬆️";
}

/* ── 距離轉人話 ── */
function humanDist(m) {
  if (m < 30) return "現在";
  if (m < 950) return Math.round(m / 10) * 10 + "公尺";
  return (m / 1000).toFixed(1) + "公里";
}

/* ── 取轉彎清單（Valhalla 不給 maneuver 座標，用 begin_shape_index 從 geometry 取）── */
function extractManeuvers(trip, geometry) {
  var out = [];
  var cum = 0;
  var off = 0;         // 多 leg 時，該 leg 在整條 geometry 中的起點索引

  trip.legs.forEach(function (leg, li) {
    var ms = leg.maneuvers || [];
    ms.forEach(function (m, mi) {
      var street = (m.street_names && m.street_names.length) ? m.street_names[0] : "";
      var ref = "";
      // Valhalla 有時把路號放在 street_names 的其他項或 begin_street_names
      try {
        if (m.begin_street_names && m.begin_street_names.length) {
          for (var si = 0; si < m.begin_street_names.length; si++) {
            if (/^(台|市|縣|省)?\d+/.test(m.begin_street_names[si])) { ref = m.begin_street_names[si]; break; }
          }
        }
        if (!ref && m.street_names) {
          for (var sj = 0; sj < m.street_names.length; sj++) {
            if (/^(台|市|縣|省)?\d+/.test(m.street_names[sj])) { ref = m.street_names[sj]; break; }
          }
        }
      } catch (e) {}
      // 把「快速道路」等關鍵字也併進 street 一起判斷
      var streetFull = street;
      if (m.begin_street_names && m.begin_street_names.length) {
        for (var sk = 0; sk < m.begin_street_names.length; sk++) {
          var sn = m.begin_street_names[sk];
          if (sn && streetFull.indexOf(sn) < 0) streetFull += " " + sn;
        }
      }
      var pt = null;
      if (geometry && geometry.length && m.begin_shape_index != null) {
        // 第一段 leg 不用加偏移；後續 leg 的索引要接在前一段後面
        var gi = m.begin_shape_index + (li > 0 ? off : 0);
        if (gi >= 0 && gi < geometry.length) pt = geometry[gi];
      }
      out.push({
        type: m.type,
        text: turnText(m.type),
        street: streetFull,
        ref: ref,
        length: m.length * 1000,        // 這一段長度（公尺）
        time: m.time,
        begin: m.begin_shape_index,
        end: m.end_shape_index,
        lat: pt ? pt[0] : null,
        lng: pt ? pt[1] : null,
        bearingBefore: (m.bearing_before != null ? m.bearing_before : null),
        bearingAfter: (m.bearing_after != null ? m.bearing_after : null),
        cumStart: cum
      });
      cum += m.length * 1000;
    });
    // 累加本 leg 的 shape 長度，供下一個 leg 加偏移
    if (ms.length) {
      var lastEnd = ms[ms.length - 1].end_shape_index;
      if (lastEnd != null) off += lastEnd;
    }
  });
  return out;
}

/* ── 建立導航 UI ── */
function buildNavUI() {
  if (document.getElementById("navui")) return;
  if (!document.body) {
    // 腳本比 body 早執行時，等 DOM 就緒
    document.addEventListener("DOMContentLoaded", buildNavUI);
    return;
  }

  var css = document.createElement("style");
  css.textContent = [
    /* ★ 保底：確保 --uiScale 一定有值（主頁可能還沒設） */
    ":root{--uiScale:1.25}",
    "#navui{position:fixed;inset:0;background:#0f1720;z-index:9000;display:none;",
    "flex-direction:column;font-family:-apple-system,'Noto Sans TC',sans-serif}",
    "#navui.on{display:flex}",
    "#navtop{background:#111c26;color:#e8f0f7;padding:6px 10px;",
    "border-bottom:1px solid #1e2b38;display:flex;align-items:center;gap:10px;",
    "max-height:64px;overflow:hidden;flex:0 0 auto}",
    /* ★ 版面压缩：主指令限定一行，绝不换行（换行会把地图挤成一条） */
    "#navturn{font-size:calc(30px * var(--uiScale,1.25));line-height:1;flex:0 0 auto}",
    "#navmain{flex:1;min-width:0;overflow:hidden}",
    "#navtext{font-size:calc(20px * var(--uiScale,1.25));font-weight:900;color:#fff;line-height:1.1;",
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle}",
    "#navstreet{font-size:calc(13px * var(--uiScale,1.25));color:#9fd3ff;margin-left:8px;font-weight:800;",
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle;max-width:58%}",
    "#navdist{font-size:calc(15px * var(--uiScale,1.25));font-weight:900;color:#fde047;margin-left:8px;",
    "letter-spacing:.5px;white-space:nowrap;display:inline-block;vertical-align:middle}",
    /* ★ 路口放大圖：浮在地圖右上角，接近路口才出現 */
    "#navjunc{position:absolute;right:8px;top:8px;width:104px;height:104px;",
    "display:none;z-index:600;opacity:.96;filter:drop-shadow(0 3px 8px rgba(0,0,0,.5))}",
    "#navjunc.on{display:block}",
    "#navjunc svg{width:104px;height:104px;border-radius:12px}",
    "#navmap{flex:1;background:#1a2332;position:relative;min-height:0;overflow:hidden}",
    "#navbottom{background:#111c26;padding:5px 9px 7px;border-top:1px solid #1e2b38;flex:0 0 auto}",
    "#navinfo{font-size:calc(11.5px * var(--uiScale,1.25));color:#9fb3c8;text-align:center;padding:0 0 5px;",
    "letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#navinfo b{color:#e8f0f7;font-size:calc(13px * var(--uiScale,1.25))}",
    "#navinfo .sep{margin:0 6px;color:#3a4a5a}",
    "#navrow{display:flex;gap:8px}",
    "#navrow .navbtn{flex:1}",
    ".navbtn{background:#1e2b38;color:#e8f0f7;border:none;border-radius:10px;min-height:calc(40px * var(--uiScale,1.25));min-width:48px;",
    "padding:9px 10px;font-size:calc(12.5px * var(--uiScale,1.25));font-weight:700;cursor:pointer;flex:0 0 auto}",
    ".navbtn.on{background:#4ade80;color:#0f1720}",
    ".navbtn.end{background:#ef4444;color:#fff}",
    "#navnext{background:#132a20;border-top:1px solid #1e2b38;padding:6px 12px;",
    "font-size:calc(11.5px * var(--uiScale,1.25));color:#86efac;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#navwarn{display:none;background:#7f1d1d;color:#fff;padding:7px 12px;",
    "font-size:calc(12px * var(--uiScale,1.25));font-weight:700;text-align:center}",
    "#navwarn.on{display:block}",
    "#navleftwarn{display:none;background:#b45309;color:#fff;padding:5px 10px;font-weight:800;",
    "font-size:calc(13px * var(--uiScale,1.25));white-space:nowrap;overflow:hidden;",
    "text-overflow:ellipsis;flex:0 0 auto}",
    "#navleftwarn.on{display:block}"
  ].join("");
  document.head.appendChild(css);

  var d = document.createElement("div");
  d.id = "navui";
  d.innerHTML = [
    '<div id="navwarn"></div>',
    '<div id="navleftwarn" style="display:none"></div>',
    '<div id="navtop">',
    '  <div id="navturn">➡️</div>',
    '  <div id="navmain">',
    '    <span id="navtext">準備出發</span><span id="navstreet"></span><span id="navdist">—</span>',
    "  </div>",
    "</div>",
    '<div id="navmap"></div>',
    '<div id="navnext">下一步：—</div>',
    '<div id="navbottom">',
    '  <div id="navinfo">剩 <b>—</b><span class="sep">·</span><span id="naveta">—</span></div>',
    '  <div id="navrow">',
    '    <button class="navbtn on" id="btnVoice">🔊 語音</button>',
    '    <button class="navbtn on" id="btnRotate">🧭 車頭朝前</button>',
    '    <button class="navbtn" id="btnRecenter">◎ 回正</button>',
    '    <button class="navbtn end" id="btnEnd">結束</button>',
    "  </div>",
    "</div>"
  ].join("");
  document.body.appendChild(d);
}

/* ── 重畫起終點/轉彎點標記 ── */
function redrawMarkers(res) {
  if (!NAV.map) return;
  (NAV.markers || []).forEach(function (m) { NAV.map.removeLayer(m); });
  NAV.markers = [];
  var g = res.geometry || [];
  if (!g.length) return;
  NAV.markers.push(L.circleMarker(g[0], { radius: 9, color: "#fff", weight: 3,
    fillColor: "#3b82f6", fillOpacity: 1 }).addTo(NAV.map));
  NAV.markers.push(L.circleMarker(g[g.length - 1], { radius: 9, color: "#fff", weight: 3,
    fillColor: "#ef4444", fillOpacity: 1 }).addTo(NAV.map));
  (res.maneuvers || []).forEach(function (m) {
    if (m.lat == null || m.type === 1 || m.type === 4 || m.type === 5 || m.type === 6) return;
    NAV.markers.push(L.circleMarker([m.lat, m.lng], { radius: 5, color: "#0f1720",
      weight: 2, fillColor: "#fbbf24", fillOpacity: 1 }).addTo(NAV.map));
  });
}

/* ── 調撥车道語音預警（不用看螢幕）── */
function warnDiaoboOnRoute(names) {
  if (typeof checkRouteDetail !== "function") return;
  var res = checkRouteDetail(names, new Date(), null);
  if (!res.warn) return;
  var msg = res.hits.map(function (h) {
    return h.road + "有調撥車道，" + (h.passable ? "走外側" : "禁行請改道");
  }).join("，");
  setTimeout(function () {
    speak("注意，" + msg);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }, 1800);
}

/* ── 開始導航 ── */
function startNav(routeData, tripRaw) {
  buildNavUI();

  NAV.route = routeData;
  NAV.idx = 0;
  NAV.spoken = {};
  NAV.offCourse = 0;
  NAV.active = true;
  NAV.remaining = routeData.distance;
  NAV.rerouting = false;
  NAV.rerouteTries = 0;            // 每次開始導航重設重算次數

  // 記住終點與途經點（走錯路重算時要用）
  var g0 = routeData.geometry || [];
  if (g0.length) {
    NAV.dest = { lat: g0[g0.length - 1][0], lng: g0[g0.length - 1][1] };
  }
  NAV.waypoints = (routeData.waypoints || []);
  NAV.cfg = routeData.cfg || {};

  document.getElementById("navui").classList.add("on");
  keepAwakeOn();                      // 導航中螢幕不睡

  // ★ 啟動 Android 常駐前台服務：切到熊貓/鎖屏，導航與 GPS 都不中斷
  try {
    if (window.AndroidTTS && window.AndroidTTS.startNavForeground) {
      window.AndroidTTS.startNavForeground();
    }
  } catch (e) {}

  // ★ 主動警告：這條路線會不會讓機車上高架
  try {
    if (window.LEFT_RULE && LEFT_RULE.scanElevated) {
      var elv = LEFT_RULE.scanElevated(routeData.maneuvers);
      var wb = document.getElementById("navwarn");
      if (elv.length && wb) {
        var names = [];
        for (var ei = 0; ei < Math.min(elv.length, 3); ei++) {
          if (names.indexOf(elv[ei].street) < 0) names.push(elv[ei].street);
        }
        wb.className = "on";
        wb.textContent = "⚠️ 此路線會上高架：" + names.join("、") +
                         "（機車若禁行請改走平面）";
        // 語音提醒一次
        setTimeout(function () {
          speak("注意，這條路線會上高架道路，如果機車不能走，請改走平面道路");
        }, 1200);
      } else if (wb) {
        wb.className = "";
        wb.textContent = "";
      }
    }
  } catch (e) {}

  // 導航專用地圖
  if (NAV.map) { NAV.map.remove(); NAV.map = null; }
  NAV.map = L.map("navmap", {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    tap: false
  }).setView([25.03, 121.51], 16);

  // 底圖：OpenStreetMap 標準圖（免 key、穩定）
  L.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(NAV.map);

  // 記錄「使用者自己拖過地圖」的時間點 → 10 秒後才恢復自動跟隨
  NAV.map.on("dragstart", function () { NAV.manualPanAt = Date.now(); });
  // 使用者「手動」縮放才記錄（程式自己改的不算，否則自動縮放會誤鎖住跟隨）
  NAV.map.on("zoomstart", function () {
    if (NAV.autoZooming) return;              // 程式觸發的縮放不算使用者操作
    NAV.manualPanAt = Date.now();
  });

  // 畫路線
  if (routeData.geometry && routeData.geometry.length) {
    NAV.lineLayer = L.polyline(routeData.geometry, {
      color: "#22c55e", weight: 9, opacity: 1, lineCap: "round", lineJoin: "round"
    }).addTo(NAV.map);

    // 起點 / 終點 / 轉彎點標記
    NAV.markers = [];
    redrawMarkers(routeData);

    // ★ 不要一次縮到看完整條路線（7 公里路線會縮到看不見街道）
    // 改成：定位到人車附近、街道級縮放；只有拿不到 GPS 才顯示全線
    if (NAV.lastPos) {
      NAV.map.setView([NAV.lastPos.lat, NAV.lastPos.lng], 16, { animate: false });
    } else if (g0.length) {
      NAV.map.setView(g0[0], 16, { animate: false });
    } else {
      NAV.map.fitBounds(NAV.lineLayer.getBounds(), { padding: [50, 50] });
    }
    NAV.manualPanAt = 0;
  }

  // GPS 跟隨
  if (navigator.geolocation) {
    NAV.watchId = navigator.geolocation.watchPosition(function (pos) {
      onNavPos(pos);
    }, function (err) {
      toast("定位失敗：" + err.message, 4000);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  } else {
    toast("此裝置不支援定位", 3000);
  }

  // ★ 從熊貓切回來時，用原生常駐服務的位置補上（避免定位斷層）
  startNativeGpsBridge();

  updateNavUI();
  speak("開始導航");
  warnDiaoboOnRoute(routeData.names || []);
}

/* ★ 原生 GPS 橋接：每 2 秒檢查原生服務的位置，
   當網頁 GPS 停更（切到別的 App、或 WebView 被暫停）時用它續上。 */
var NAV_GPS_TIMER = null;
function startNativeGpsBridge() {
  stopNativeGpsBridge();
  NAV_GPS_TIMER = setInterval(function () {
    if (!NAV.active) return;
    try {
      if (!window.AndroidTTS || !window.AndroidTTS.getLastLocation) return;
      var raw = window.AndroidTTS.getLastLocation();
      if (!raw) return;
      var p = raw.split(",");
      if (p.length < 4) return;
      var la = parseFloat(p[0]), lo = parseFloat(p[1]);
      var acc = parseFloat(p[2]), t = parseInt(p[3], 10);
      if (!isFinite(la) || !isFinite(lo) || la === 0) return;
      // 比網頁自己的 GPS 新才採用
      var mine = NAV.lastPos ? (NAV.lastPos.ts || 0) : 0;
      if (t <= mine) return;
      onNavPos({
        coords: { latitude: la, longitude: lo, accuracy: acc > 0 ? acc : 30 },
        timestamp: t
      });
    } catch (e) {}
  }, 2000);
}

function stopNativeGpsBridge() {
  if (NAV_GPS_TIMER) { clearInterval(NAV_GPS_TIMER); NAV_GPS_TIMER = null; }
}

/* ── 導航中：位置更新 ── */
function onNavPos(pos) {
  var la = pos.coords.latitude, lo = pos.coords.longitude;
  var acc = pos.coords.accuracy || 999;

  NAV.lastPos = { lat: la, lng: lo, ts: pos.timestamp || Date.now() };

  // 我的位置標記
  if (!NAV.meMarker) {
    NAV.meMarker = L.circleMarker([la, lo], {
      radius: 8, color: "#fff", weight: 3, fillColor: "#3b82f6", fillOpacity: 1
    }).addTo(NAV.map);
  } else {
    NAV.meMarker.setLatLng([la, lo]);
  }

  // ★ 車頭朝前：算出騎行方向，把地圖轉成「你正面朝上」
  updateHeading(la, lo, pos);

  // 地圖跟隨：人走了就讓地圖跟上（原本只判斷 zoom，導致人騎出螢幕也不跟）
  // 規則：使用者沒手動拖地圖時，人偏離畫面中心超過 90m 就平滑跟上
  if (Date.now() - (NAV.manualPanAt || 0) > 10000) {
    var c = NAV.map.getCenter();
    var offCenter = NAV.map.distance([c.lat, c.lng], [la, lo]);
    if (offCenter > 90) {
      NAV.map.panTo([la, lo], { animate: true, duration: 0.5 });
    }
  }

  if (!NAV.route || !NAV.route.maneuvers) return;
  var ms = NAV.route.maneuvers;

  // 找最近的 maneuver 點，推進進度
  // ★ 原本用「靠近轉彎點 30m」推進 → 騎過頭就永遠卡住（永遠停在「出發」）
  // 改成：沿路線已走距離超過這段的累計終點，就推進（騎過頭也能正確前進）
  var best = NAV.idx, bestD = Infinity;
  for (var i = NAV.idx; i < Math.min(ms.length, NAV.idx + 4); i++) {
    if (ms[i].lat == null) continue;
    var d = haversine(la, lo, ms[i].lat, ms[i].lng);
    if (d < bestD) { bestD = d; best = i; }
  }

  // 用「離路線最近點」估算已走進度，推進 maneuver
  if (NAV.lineLayer) {
    var pts0 = NAV.lineLayer.getLatLngs();
    var nearIdx = 0, nearD = Infinity;
    for (var q = 0; q < pts0.length; q++) {
      var dq = haversine(la, lo, pts0[q].lat, pts0[q].lng);
      if (dq < nearD) { nearD = dq; nearIdx = q; }
    }
    // 已走到近路線的第 nearIdx 點 → 找出所有 end <= nearIdx 的 maneuver
    var advanced = false;
    while (NAV.idx < ms.length - 1 && ms[NAV.idx].end != null && ms[NAV.idx].end <= nearIdx) {
      NAV.idx++;
      advanced = true;
    }
    if (advanced) { updateNavUI(); speakNext(); }
  }

  // 備援：真的到達轉彎點 30 公尺內也推進
  if (bestD < 30 && best === NAV.idx && NAV.idx < ms.length - 1) {
    NAV.idx++;
    updateNavUI();
    speakNext();
  }

  // ★ 轉彎前自動放大：快到路口時拉近到 18，過彎後回到 16
  //    （騎車時最需要看清的就是「下一個路口長什麼樣」）
  if (NAV.map && Date.now() - (NAV.manualPanAt || 0) > 10000) {
    var nextLen = (ms[NAV.idx] && ms[NAV.idx].length) || 9999;
    var wantZoom = (nextLen < 120) ? 18 : 16;
    if (NAV.map.getZoom() !== wantZoom) {
      NAV.autoZooming = true;                 // 標記：這是程式縮放，不是使用者操作
      NAV.map.setZoom(wantZoom, { animate: true });
      setTimeout(function () { NAV.autoZooming = false; }, 900);
    }
  }

  // 剩餘距離與時間
  var rem = 0;
  for (var j = NAV.idx; j < ms.length; j++) rem += ms[j].length;
  NAV.remaining = rem;

  // 偏離偵測（離路線 > 60 公尺）
  if (NAV.lineLayer) {
    var n = 0, near = Infinity;
    for (var k = 0; k < NAV.lineLayer.getLatLngs().length; k++) {
      var p = NAV.lineLayer.getLatLngs()[k];
      var dd = haversine(la, lo, p.lat, p.lng);
      if (dd < near) near = dd;
      if (n++ > 400) break;
    }
    if (near > 80 && acc < 35) {
      NAV.offCourse = (NAV.offCourse || 0) + 1;
      // 連續 8 次（約 15~25 秒騎車時間）偏離才重算 → 避開路口繞攤販/等紅燈的誤判
      if (NAV.offCourse >= 8 && !NAV.rerouting && (NAV.rerouteTries || 0) < 3) {
        NAV.rerouteTries = (NAV.rerouteTries || 0) + 1;
        doReroute(la, lo);
      } else if (NAV.offCourse >= 8 && (NAV.rerouteTries || 0) >= 3) {
        showNavWarn("⚠️ 無法自動重算，請手動選路線");
      }
    } else {
      // 回到路線上了
      if (NAV.offCourse > 0 && !NAV.rerouting) {
        hideNavWarn();
        toast("✅ 已回到路線上", 1500);
      }
      NAV.offCourse = 0;
      NAV.rerouting = false;
    }
  }

  updateNavUI();
}

/* ── 自動重新規劃（走錯路時）── */
function doReroute(la, lo) {
  if (NAV.rerouting) return;          // 避免重複觸發
  NAV.rerouting = true;

  var dest = NAV.dest;
  if (!dest) {
    showNavWarn("⚠️ 偏離路線，請回到綠色路線上");
    speak("偏離路線，請回到綠色路線上");
    return;
  }

  showNavWarn("🔄 走錯路了，正在重新規劃…");
  speak("走錯路了，重新規劃路線");

  var locs = [{ lat: la, lng: lo }];
  // 保留還沒到的途經點
  (NAV.waypoints || []).forEach(function (w) { locs.push(w); });
  locs.push(dest);

  vRoute(locs, NAV.cfg || {}).then(function (res) {
    if (!res || !res.geometry) throw new Error("重算失敗");

    // 換掉路線資料
    NAV.route = {
      distance: res.distance,
      duration: res.duration,
      geometry: res.geometry,
      maneuvers: res.maneuvers || [],
      names: res.names || []
    };
    NAV.idx = 0;
    NAV.remaining = res.distance;
    NAV.offCourse = 0;
    NAV.rerouting = false;

    // 重畫路線
    if (NAV.lineLayer) NAV.map.removeLayer(NAV.lineLayer);
    NAV.lineLayer = L.polyline(res.geometry, {
      color: "#22c55e", weight: 9, opacity: 1, lineCap: "round", lineJoin: "round"
    }).addTo(NAV.map);

    // 重畫終點
    var g = res.geometry;
    if (NAV.endMarker) NAV.map.removeLayer(NAV.endMarker);
    NAV.endMarker = L.circleMarker(g[g.length - 1], {
      radius: 9, color: "#fff", weight: 3,
      fillColor: "#ef4444", fillOpacity: 1
    }).addTo(NAV.map);

    // 套用到外部 route（結束導航後列表仍一致）
    if (typeof route !== "undefined" && route) {
      route.geometry = res.geometry;
      route.maneuvers = res.maneuvers;
      route.distance = res.distance;
      route.duration = res.duration;
    }

    hideNavWarn();
    redrawMarkers(res);
    updateNavUI();
    speak("已重新規劃，" + (res.maneuvers[1] ? res.maneuvers[1].text : "繼續前行"));

    // 震一下提醒（有支援才震）
    if (navigator.vibrate) navigator.vibrate(200);
  }).catch(function (e) {
    NAV.rerouting = false;
    showNavWarn("⚠️ 重新規劃失敗，請手動回到路線");
    speak("重新規劃失敗，請回到原本的路線");
    console.warn("[reroute]", e);
  });
}

/* ── 更新導航畫面 ── */
function updateNavUI() {
  var ms = NAV.route && NAV.route.maneuvers;
  if (!ms || !ms.length) return;

  var cur = ms[Math.min(NAV.idx, ms.length - 1)];
  var next = ms[NAV.idx + 1];

  var distToNext = cur.length;
  var showText = cur.text, showStreet = cur.street || "";
  var showIcon = turnIcon(cur.type);
  var showType = cur.type;

  // 出發/直行等「沒有指令價值」的段落 → 往前找第一個真正要做的動作
  var NO_INFO = [1,2,3,7,8,21,22];
  if (NO_INFO.indexOf(cur.type) >= 0) {
    for (var j = NAV.idx + 1; j < Math.min(NAV.idx + 4, ms.length); j++) {
      var nx = ms[j];
      if (NO_INFO.indexOf(nx.type) < 0 && nx.type !== 4 && nx.type !== 5 && nx.type !== 6) {
        // 累加：從目前位置到那個動作點的全部長度
        distToNext = 0;
        for (var q2 = NAV.idx; q2 <= j; q2++) distToNext += ms[q2].length;
        showText = nx.text;
        showStreet = nx.street || "";
        showIcon = turnIcon(nx.type);
        showType = nx.type;
        break;
      }
    }
  }

  // ★ 機車左轉三分法：高架禁止 / 待轉區 / 可直接左轉
  var li = leftInfo({ type: showType, street: cur.street, ref: cur.ref, lat: cur.lat, lng: cur.lng });
  var leftWarn = !!li;
  // ★ 主指令只放「左轉」，不要塞長句（塞了會被撐成三行，把地圖擠掉）
  if (li) {
    if (li.level === "banned") showText = "禁止左轉";
    else if (li.level === "hook") showText = "兩段式左轉";
    else showText = "左轉";
  }

  document.getElementById("navdist").textContent = humanDist(distToNext);
  document.getElementById("navtext").textContent = showText;
  document.getElementById("navstreet").textContent = showStreet;
  document.getElementById("navturn").textContent = showIcon;

  // 左轉規則提示條（★ 一行為限，短句，不要吃掉地圖空間）
  var lw = document.getElementById("navleftwarn");
  if (lw) {
    if (li) {
      lw.style.display = "block";
      lw.style.background = li.color;
      if (li.level === "banned") lw.textContent = "⛔ 高架禁左轉・直行走出口";
      else if (li.level === "hook") lw.textContent = "🔄 進待轉區等綠燈";
      else lw.textContent = "↰ 無待轉資訊・看現場標誌";
    } else {
      lw.style.display = "none";
    }
  }

  // ★ 路口放大圖：接近路口（<200m）才顯示，讓你看清往哪走
  try {
    var jb = document.getElementById("navjunc");
    var mapEl = document.getElementById("navmap");
    if (!jb && mapEl) {
      // 動態插入地圖容器內，才會浮在地圖上（放外面會被地圖層蓋住）
      jb = document.createElement("div");
      jb.id = "navjunc";
      mapEl.appendChild(jb);
    }
    if (jb && window.JUNCTION_VIEW) {
      var ang = JUNCTION_VIEW.turnAngle(cur.bearingBefore, cur.bearingAfter);
      // ★ 250m 內且有轉彎才顯示（200m 太晚，騎 40km/h 只剩 18 秒）
      var needJunc = distToNext <= 250 && Math.abs(ang) >= 20;
      if (needJunc) {
        if (jb.dataset.ang !== String(Math.round(ang))) {
          jb.innerHTML = JUNCTION_VIEW.buildSVG(ang, showStreet, li || {});
          jb.dataset.ang = String(Math.round(ang));
        }
        jb.className = "on";
      } else {
        jb.className = "";
        jb.innerHTML = "";
        delete jb.dataset.ang;
      }
    }
  } catch (e) {}

  document.getElementById("navnext").textContent = next
    ? "下一步：" + next.text + (next.street ? " → " + next.street : "")
    : "即將抵達目的地";

  var remTxt = NAV.remaining > 0 ? humanDist(NAV.remaining) : "快到";
  var eta = new Date(Date.now() + (NAV.route.duration || 0) * 1000);
  var hh = eta.getHours(), mm = eta.getMinutes();
  document.getElementById("navinfo").querySelector("b").textContent = remTxt;
  document.getElementById("naveta").textContent =
    "預計 " + hh + ":" + (mm < 10 ? "0" : "") + mm + " 抵達";
}

/* ── 播報下一個指令 ── */
function speakNext() {
  var ms = NAV.route.maneuvers;
  var nx = ms[NAV.idx];
  if (!nx) { speak("已抵達目的地"); return; }
  var s = "";
  if (nx.length > 200) s += "再走 " + humanDist(nx.length) + "，";
  // ★ 左轉改用三分法說法
  s += turnSpeech(nx);
  if (nx.street) s += "，進入" + nx.street;
  speak(s);
}

function showNavWarn(t) {
  var el = document.getElementById("navwarn");
  el.textContent = t;
  el.classList.add("on");
}
function hideNavWarn() {
  document.getElementById("navwarn").classList.remove("on");
}

/* ── 距離計算 ── */
function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── 結束導航 ── */
function endNav() {
  NAV.active = false;
  keepAwakeOff();
  if (NAV.watchId != null) {
    navigator.geolocation.clearWatch(NAV.watchId);
    NAV.watchId = null;
  }
  // ★ 停止 Android 常駐服務
  try {
    if (window.AndroidTTS && window.AndroidTTS.stopNavForeground) {
      window.AndroidTTS.stopNavForeground();
    }
  } catch (e) {}
  if (window.speechSynthesis) speechSynthesis.cancel();
  // 停止原生語音
  try { if (window.AndroidTTS && window.AndroidTTS.stop) window.AndroidTTS.stop(); } catch (e) {}
  stopNativeGpsBridge();
  var el = document.getElementById("navui");
  if (el) el.classList.remove("on");
  if (NAV.map) { NAV.map.remove(); NAV.map = null; }
  NAV.meMarker = null;
  NAV.lineLayer = null;
  // ★ 旋轉包裝層綁在舊地圖上，地圖銷毀後一定要清掉，否則下次導航拿到失效參照
  try { if (window.NAV_ROTATE) NAV_ROTATE.reset(); } catch (e) {}
  var ow = document.querySelector(".nav-rot-wrap");
  if (ow) ow.remove();
  hideNavWarn();
}

/* ── 綁定按鈕 ── */
document.addEventListener("click", function (e) {
  var t = e.target;
  if (!t || !t.id) return;
  if (t.id === "btnEnd") {
    // ★ 二次確認：避免騎車誤觸直接關掉導航
    if (t.dataset.confirm === "1") { endNav(); toast("已結束導航", 1500); return; }
    t.dataset.confirm = "1";
    t.textContent = "再按一次結束";
    toast("再按一次「結束」才會關閉", 2500);
    setTimeout(function () {
      if (t.dataset.confirm === "1") {
        t.dataset.confirm = "";
        t.textContent = "結束";
      }
    }, 4000);
    return;
  }
  if (t.id === "btnVoice") {
    NAV.voiceOn = !NAV.voiceOn;
    t.classList.toggle("on", NAV.voiceOn);
    t.textContent = NAV.voiceOn ? "🔊 語音" : "🔇 靜音";
    if (NAV.voiceOn) speak("語音已開啟");
  }
  if (t.id === "btnRecenter" && NAV.lastPos) {
    NAV.manualPanAt = 0;             // 取消 10 秒等待，立刻跟回
    NAV.map.setView([NAV.lastPos.lat, NAV.lastPos.lng], 17, { animate: true });
  }
  if (t.id === "btnRotate") {
    var on = !(window.NAV_ROTATE && NAV_ROTATE.isEnabled());
    if (window.NAV_ROTATE) NAV_ROTATE.setEnabled(on);
    t.classList.toggle("on", on);
    t.textContent = on ? "🧭 車頭朝前" : "🗺️ 上北下南";
    speak(on ? "已切換為車頭朝前" : "已切換為上北下南");
  }
});

/* ── 字體倍率變更時重繪（由 index.html 的 AA 按鈕呼叫）── */
NAV.refreshUi = function () {
  try {
    if (NAV.active && NAV.map && NAV.map.invalidateSize) NAV.map.invalidateSize();
    if (typeof redrawMarkers === "function") redrawMarkers();
  } catch (e) {}
};
window.NAV = NAV;
