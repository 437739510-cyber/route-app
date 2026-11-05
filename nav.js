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
function speak(text) {
  if (!NAV.voiceOn) return;
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
      var pt = null;
      if (geometry && geometry.length && m.begin_shape_index != null) {
        // 第一段 leg 不用加偏移；後續 leg 的索引要接在前一段後面
        var gi = m.begin_shape_index + (li > 0 ? off : 0);
        if (gi >= 0 && gi < geometry.length) pt = geometry[gi];
      }
      out.push({
        type: m.type,
        text: turnText(m.type),
        street: street,
        length: m.length * 1000,        // 這一段長度（公尺）
        time: m.time,
        begin: m.begin_shape_index,
        end: m.end_shape_index,
        lat: pt ? pt[0] : null,
        lng: pt ? pt[1] : null,
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
    "#navui{position:fixed;inset:0;background:#0f1720;z-index:9000;display:none;",
    "flex-direction:column;font-family:-apple-system,'Noto Sans TC',sans-serif}",
    "#navui.on{display:flex}",
    "#navtop{background:#111c26;color:#e8f0f7;padding:12px 16px;",
    "border-bottom:1px solid #1e2b38;display:flex;align-items:center;gap:16px}",
    "#navturn{font-size:calc(46px * var(--uiScale,1.25));line-height:1;flex:0 0 auto}",
    "#navmain{flex:1;min-width:0}",
    /* 層級對調：轉彎動作最大，距離改小字放右邊 */
    "#navtext{font-size:calc(33px * var(--uiScale,1.25));font-weight:900;color:#fff;line-height:1.05}",
    "#navstreet{font-size:calc(17px * var(--uiScale,1.25));color:#9fb3c8;margin-top:3px;font-weight:700;",
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#navdist{font-size:calc(15px * var(--uiScale,1.25));font-weight:800;color:#4ade80;margin-top:5px;",
    "letter-spacing:.5px}",
    "#navmap{flex:1;background:#1a2332;position:relative}",
    "#navbottom{background:#111c26;padding:8px 12px 10px;border-top:1px solid #1e2b38}",
    "#navinfo{font-size:calc(13px * var(--uiScale,1.25));color:#9fb3c8;text-align:center;padding:2px 0 8px;",
    "letter-spacing:.3px}",
    "#navinfo b{color:#e8f0f7;font-size:calc(15px * var(--uiScale,1.25))}",
    "#navinfo .sep{margin:0 10px;color:#3a4a5a}",
    "#navrow{display:flex;gap:10px}",
    "#navrow .navbtn{flex:1}",
    ".navbtn{background:#1e2b38;color:#e8f0f7;border:none;border-radius:10px;min-height:calc(48px * var(--uiScale,1.25));min-width:56px;",
    "padding:13px 16px;font-size:calc(14px * var(--uiScale,1.25));font-weight:700;cursor:pointer;flex:0 0 auto}",
    ".navbtn.on{background:#4ade80;color:#0f1720}",
    ".navbtn.end{background:#ef4444;color:#fff}",
    "#navnext{background:#132a20;border-top:1px solid #1e2b38;padding:9px 16px;",
    "font-size:calc(12.5px * var(--uiScale,1.25));color:#86efac}",
    "#navwarn{display:none;background:#7f1d1d;color:#fff;padding:9px 16px;",
    "font-size:calc(13px * var(--uiScale,1.25));font-weight:700;text-align:center}",
    "#navwarn.on{display:block}"
  ].join("");
  document.head.appendChild(css);

  var d = document.createElement("div");
  d.id = "navui";
  d.innerHTML = [
    '<div id="navwarn"></div>',
    '<div id="navtop">',
    '  <div id="navturn">➡️</div>',
    '  <div id="navmain">',
    '    <div id="navtext">準備出發</div>',
    '    <div id="navstreet"></div>',
    '    <div id="navdist">—</div>',
    "  </div>",
    "</div>",
    '<div id="navmap"></div>',
    '<div id="navnext">下一步：—</div>',
    '<div id="navbottom">',
    '  <div id="navinfo">剩 <b>—</b><span class="sep">·</span><span id="naveta">—</span></div>',
    '  <div id="navrow">',
    '    <button class="navbtn on" id="btnVoice">🔊 語音</button>',
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

  // 導航專用地圖
  if (NAV.map) { NAV.map.remove(); NAV.map = null; }
  NAV.map = L.map("navmap", {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    tap: false
  }).setView([25.03, 121.51], 16);

  L.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(NAV.map);

  // 記錄「使用者自己拖過地圖」的時間點 → 10 秒後才恢復自動跟隨
  NAV.map.on("dragstart", function () { NAV.manualPanAt = Date.now(); });
  NAV.map.on("zoomstart", function () { NAV.manualPanAt = Date.now(); });

  // 畫路線
  if (routeData.geometry && routeData.geometry.length) {
    NAV.lineLayer = L.polyline(routeData.geometry, {
      color: "#4ade80", weight: 7, opacity: 0.95, lineCap: "round"
    }).addTo(NAV.map);

    // 起點 / 終點 / 轉彎點標記
    NAV.markers = [];
    redrawMarkers(routeData);

    NAV.map.fitBounds(NAV.lineLayer.getBounds(), { padding: [50, 50] });
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

  updateNavUI();
  speak("開始導航");
  warnDiaoboOnRoute(routeData.names || []);
}

/* ── 導航中：位置更新 ── */
function onNavPos(pos) {
  var la = pos.coords.latitude, lo = pos.coords.longitude;
  var acc = pos.coords.accuracy || 999;

  NAV.lastPos = { lat: la, lng: lo };

  // 我的位置標記
  if (!NAV.meMarker) {
    NAV.meMarker = L.circleMarker([la, lo], {
      radius: 8, color: "#fff", weight: 3, fillColor: "#3b82f6", fillOpacity: 1
    }).addTo(NAV.map);
  } else {
    NAV.meMarker.setLatLng([la, lo]);
  }

  // 地圖跟隨：若使用者拖過地圖，10 秒後自動跟回（不必再按按鈕）
  if (Date.now() - (NAV.manualPanAt || 0) > 10000) {
    NAV.map.setView([la, lo], Math.max(NAV.map.getZoom(), 17), { animate: true });
  }

  if (!NAV.route || !NAV.route.maneuvers) return;
  var ms = NAV.route.maneuvers;

  // 找最近的 maneuver 點，推進進度
  var best = NAV.idx, bestD = Infinity;
  for (var i = NAV.idx; i < Math.min(ms.length, NAV.idx + 4); i++) {
    if (ms[i].lat == null) continue;
    var d = haversine(la, lo, ms[i].lat, ms[i].lng);
    if (d < bestD) { bestD = d; best = i; }
  }

  // 到達轉彎點（30 公尺內）
  if (bestD < 30 && best === NAV.idx && NAV.idx < ms.length - 1) {
    NAV.idx++;
    updateNavUI();
    speakNext();
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
      color: "#4ade80", weight: 7, opacity: 0.95, lineCap: "round"
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
        break;
      }
    }
  }

  document.getElementById("navdist").textContent = humanDist(distToNext);
  document.getElementById("navtext").textContent = showText;
  document.getElementById("navstreet").textContent = showStreet;
  document.getElementById("navturn").textContent = showIcon;

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
  s += nx.text;
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
  if (window.speechSynthesis) speechSynthesis.cancel();
  var el = document.getElementById("navui");
  if (el) el.classList.remove("on");
  if (NAV.map) { NAV.map.remove(); NAV.map = null; }
  NAV.meMarker = null;
  NAV.lineLayer = null;
  hideNavWarn();
}

/* ── 綁定按鈕 ── */
document.addEventListener("click", function (e) {
  var t = e.target;
  if (!t || !t.id) return;
  if (t.id === "btnEnd") { endNav(); toast("已結束導航", 1500); }
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
});

/* ── 字體倍率變更時重繪（由 index.html 的 AA 按鈕呼叫）── */
NAV.refreshUi = function () {
  try {
    if (NAV.active && NAV.map && NAV.map.invalidateSize) NAV.map.invalidateSize();
    if (typeof redrawMarkers === "function") redrawMarkers();
  } catch (e) {}
};
window.NAV = NAV;
