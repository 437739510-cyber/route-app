/**
 * 機車禁行／限制路段（人工維護，Chris 實際跑單經驗逐條累積）
 * ─────────────────────────────────────────
 * 用途：規劃路線時檢查有沒有踩到「機車不能走」的路段，
 *      踩到就顯示紅色警示 + 建議改走哪條。
 *
 * 為什麼不用自動判斷：
 *   公開圖資（OSM/Valhalla）沒有台灣「禁行機車」的完整標記，
 *   照圖資算出來的路可能是汽車走的。所以靠實地經驗建表最可靠。
 *
 * 新增規則格式：
 *   { name: "路段名", lat: 中心緯度, lng: 中心經度, r: 半徑公尺,
 *     avoid: "不要走的路名關鍵字", use: "改走的路名", note: "說明" }
 */
(function (global) {
  "use strict";

  var BAN = [
    // ── 2026-11-06 Chris 提供（中和往圓通路335巷）──
    {
      name: "中和中正路段",
      lat: 24.9938, lng: 121.4890, r: 350,
      avoid: "中正路",
      use: "和城路一段",
      note: "機車走和城路一段，不要走中正路"
    }
  ];

  function distM(la1, lo1, la2, lo2) {
    var R = 6371000, p = Math.PI / 180;
    var dLa = (la2 - la1) * p, dLo = (lo2 - lo1) * p;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(la1 * p) * Math.cos(la2 * p) *
            Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * 掃描路線有沒有踩到禁行路段
   * @param {Array} maneuvers 轉彎點陣列（含 lat/lng/street）
   * @param {Array} geometry  整條路線的座標
   * @return {Array} 踩到的規則（含位置）
   */
  function scan(maneuvers, geometry) {
    var hits = [];
    if (!BAN.length) return hits;

    for (var b = 0; b < BAN.length; b++) {
      var rule = BAN[b];
      var where = null;

      // 先看轉彎點的路名
      for (var i = 0; i < (maneuvers || []).length; i++) {
        var m = maneuvers[i];
        if (m.lat == null) continue;
        if (distM(m.lat, m.lng, rule.lat, rule.lng) > rule.r) continue;
        if (m.street && m.street.indexOf(rule.avoid) >= 0) {
          where = { idx: i, lat: m.lat, lng: m.lng, street: m.street };
          break;
        }
      }

      // 再掃路線座標（轉彎點可能漏）
      if (!where && geometry) {
        for (var g = 0; g < geometry.length; g++) {
          if (distM(geometry[g][0], geometry[g][1], rule.lat, rule.lng) > rule.r) continue;
          where = { idx: -1, lat: geometry[g][0], lng: geometry[g][1], street: "" };
          break;
        }
      }

      if (where) {
        hits.push({ rule: rule, where: where });
      }
    }
    return hits;
  }

  /** 產生一句警示文字 */
  function warnText(hits) {
    if (!hits || !hits.length) return "";
    var h = hits[0];
    return "⛔ " + h.rule.name + " 機車禁行 → 改走 " + h.rule.use;
  }

  global.MOTOR_BAN = {
    list: BAN,
    scan: scan,
    warnText: warnText,
    distM: distM
  };
})(window);
