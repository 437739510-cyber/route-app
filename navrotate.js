/**
 * 車頭朝前（地圖隨方向旋轉）— v3 幾何正確版
 * ─────────────────────────────────────────
 * 關鍵教訓（每一條都是實測踩出來的）：
 *  1) 直接轉 leaflet-map-pane → Leaflet 每次平移都覆蓋 transform
 *  2) 轉 tilePane → pane 是 0×0，轉完只顯示一條
 *  3) 外面包層 + 改 width/height 放大 → 中心偏移，上半部露空
 *  4) 只旋轉不放大 → 矩形 393×659 轉 90° 變 659×393，垂直方向必然露空
 *
 * 正解：視窗 393×659，旋轉後要有東西蓋住它，內容必須是「對角線尺寸」的正方形
 *      （768×768）。所以：
 *        clip（393×659, overflow:hidden）
 *          └ mapContainer（768×768, 負偏移置中）← 旋轉這一層，Leaflet 只管裡面
 *      Leaflet 以為自己是 768×768 → 自動多載瓦片填滿四角。
 */
(function (global) {
  "use strict";

  var ST = { enabled: true, heading: 0, lastHeading: null, lastPos: null,
             headingBuf: [], clip: null, el: null, built: false, geom: "" };

  function distM(la1, lo1, la2, lo2) {
    if (la1 == null || la2 == null) return Infinity;
    var R = 6371000, p = Math.PI / 180;
    var dLa = (la2 - la1) * p, dLo = (lo2 - lo1) * p;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearing(la1, lo1, la2, lo2) {
    var p = Math.PI / 180;
    var y = Math.sin((lo2 - lo1) * p) * Math.cos(la2 * p);
    var x = Math.cos(la1 * p) * Math.sin(la2 * p) -
            Math.sin(la1 * p) * Math.cos(la2 * p) * Math.cos((lo2 - lo1) * p);
    return (Math.atan2(y, x) / p + 360) % 360;
  }

  function angleDiff(a, b) { return ((b - a + 540) % 360) - 180; }

  function circularMean(list) {
    var x = 0, y = 0;
    for (var i = 0; i < list.length; i++) {
      var r = list[i] * Math.PI / 180;
      x += Math.cos(r); y += Math.sin(r);
    }
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /** 建立 clip 外框，把 Leaflet 容器搬進去 */
  function ensure(map) {
    var c = map.getContainer();
    if (!c) return null;
    if (ST.built && ST.el && ST.el.isConnected && ST.clip && ST.clip.isConnected) return ST.el;
    if (c.parentElement && c.parentElement.classList.contains("nav-clip")) {
      ST.clip = c.parentElement; ST.el = c; ST.built = true; return c;
    }
    var clip = document.createElement("div");
    clip.className = "nav-clip";
    clip.style.cssText =
      "flex:1 1 0%;position:relative;overflow:hidden;min-height:0;background:#1a2332";
    c.parentNode.insertBefore(clip, c);
    clip.appendChild(c);
    c.style.position = "absolute";
    c.style.transformOrigin = "center center";
    c.style.willChange = "transform";
    c.style.transition = "transform .25s ease-out";
    ST.clip = clip; ST.el = c; ST.built = true; ST.geom = "";
    // ★ 建好就立刻給尺寸，不能等後續呼叫（否則 Leaflet 以為自己是 0×0，地圖整片空白）
    var W = clip.clientWidth || window.innerWidth;
    var H = clip.clientHeight || (window.innerHeight - 150);
    var diag = Math.ceil(Math.sqrt(W * W + H * H));
    c.style.width = diag + "px";
    c.style.height = diag + "px";
    c.style.left = Math.round((W - diag) / 2) + "px";
    c.style.top = Math.round((H - diag) / 2) + "px";
    try { map.invalidateSize(false); } catch (e) {}
    return c;
  }

  /** 依旋轉狀態設定尺寸（旋轉時用對角正方形） */
  function geom(map) {
    var c = ST.el, clip = ST.clip;
    if (!c || !clip) return;
    var W = clip.clientWidth, H = clip.clientHeight;
    if (!W || !H) return;
    var diag = Math.ceil(Math.sqrt(W * W + H * H));
    var key = (ST.enabled ? "rot" : "flat") + ":" + W + "x" + H;
    // ★ 除了 key 相同，還要檢查尺寸真的設上去了（否則 0×0 會一直卡住）
    if (ST.geom === key && c.style.width && c.clientWidth > 0) return;
    ST.geom = key;

    if (ST.enabled) {
      c.style.width = diag + "px";
      c.style.height = diag + "px";
      c.style.left = Math.round((W - diag) / 2) + "px";
      c.style.top = Math.round((H - diag) / 2) + "px";
    } else {
      c.style.width = W + "px";
      c.style.height = H + "px";
      c.style.left = "0px";
      c.style.top = "0px";
    }
    c.style.right = "auto";
    c.style.bottom = "auto";
    try { map.invalidateSize(false); } catch (e) {}
  }

  function apply(map) {
    if (!ensure(map)) return;
    geom(map);
    if (!ST.enabled) {
      ST.el.style.transform = "rotate(0deg)";
      setArrow(ST.heading);
      return;
    }
    // 地圖轉 -heading → 車頭朝上
    ST.el.style.transform = "rotate(" + (-ST.heading) + "deg)";
    // 箭頭在地圖內會跟著轉，要反向轉回來才會指向行進方向
    setArrow(ST.heading);
  }

  /** 讓藍點箭頭指向行進方向（抵消地圖旋轉） */
  function setArrow(hdg) {
    var el = document.querySelector(".nav-me-arrow");
    if (!el) return;
    // 地圖整體已轉 -hdg，箭頭本身預設朝上 → 再轉 +hdg 就回到正確方位
    var rel = ST.enabled ? 0 : hdg;
    el.style.transform = "rotate(" + rel + "deg)";
    el.style.transformOrigin = "center center";
  }

  /** 由路線切線設方向（穩，不受 GPS 飄移影響） */
  function setRouteHeading(h) {
    if (h == null || isNaN(h)) return;
    if (!ST.enabled) { ST.lastHeading = h; return; }
    // ★ 第一次一定要套用（建立包裝層、設尺寸），不能因為角度沒變就跳過
    var first = !ST.built;
    var d = Math.abs(angleDiff(ST.heading, h));
    if (!first && d < 6) return;
    ST.heading = h;
    ST.lastHeading = h;
    apply(NAV.map);
  }

  function update(la, lo, pos) {
    if (!NAV.map) return;
    if (!ST.built) ensure(NAV.map);
    if (!ST.enabled) return;

    var hdg = null;
    if (pos && pos.coords && pos.coords.heading != null && !isNaN(pos.coords.heading)) {
      hdg = pos.coords.heading;
    }
    if (hdg == null && ST.lastPos) {
      if (distM(ST.lastPos.lat, ST.lastPos.lng, la, lo) >= 8) {
        hdg = bearing(ST.lastPos.lat, ST.lastPos.lng, la, lo);
      }
    }
    if (!ST.lastPos || distM(ST.lastPos.lat, ST.lastPos.lng, la, lo) >= 8) {
      ST.lastPos = { lat: la, lng: lo };
    }
    if (hdg == null) return;

    ST.headingBuf.push(hdg);
    if (ST.headingBuf.length > 5) ST.headingBuf.shift();
    var avg = circularMean(ST.headingBuf);

    if (Math.abs(angleDiff(ST.heading, avg)) < 12) return;   // 死區防抖
    ST.heading = avg; ST.lastHeading = avg;
    apply(NAV.map);
  }

  function setEnabled(on) {
    ST.enabled = !!on;
    if (on && ST.lastHeading != null) ST.heading = ST.lastHeading;
    if (!on) ST.heading = 0;
    ST.geom = "";                              // 尺寸要重算
    if (ST.el && NAV.map) {
      ST.el.style.transition = "none";
      apply(NAV.map);
      setTimeout(function () { if (ST.el) ST.el.style.transition = "transform .25s ease-out"; }, 60);
    }
  }

  function reset() {
    ST.heading = 0; ST.headingBuf = []; ST.lastPos = null;
    ST.clip = null; ST.el = null; ST.built = false; ST.geom = "";
  }

  global.NAV_ROTATE = {
    update: update, setEnabled: setEnabled,
    setRouteHeading: setRouteHeading,
    isEnabled: function () { return ST.enabled; },
    getHeading: function () { return ST.heading; },
    reset: reset, bearing: bearing,
    _wrap: function () { return ST.el; }
  };
})(window);

function updateHeading(la, lo, pos) {
  try { if (window.NAV_ROTATE) NAV_ROTATE.update(la, lo, pos); } catch (e) {}
}
