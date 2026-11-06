/**
 * 台灣機車左轉規則（三層判斷）+ 高架機車限制
 * ─────────────────────────────────────────
 * 依 Chris 實際跑單經驗 + 台灣交通法規：
 *
 *  1) 高架道路（環河快速道路那種）：❌ 絕對禁止直接左轉
 *     原因：左轉會跟直行汽車對撞，是高危險行為。
 *
 *  2) 有待轉標誌 / 待轉區的路口：❌ 不能直接左轉
 *     做法：先進待轉區，等橫向綠燈再左轉（兩段式）。
 *
 *  3) 沒有可信資料的一般路口：⚠️ 誠實告知「自行判斷」
 *     公開圖資沒有待轉標誌資料，不裝懂。
 */
(function (global) {
  "use strict";

  // 已知「有紅綠燈 + 待轉區」的高風險路口（人工維護，可持續補充）
  var TURN_BOX = [
    { lat: 25.0194, lng: 121.5156, r: 120, name: "中正橋永和端" },
    { lat: 25.0115, lng: 121.5233, r: 150, name: "環河東路沿線" },
    { lat: 25.0130, lng: 121.5060, r: 130, name: "永和中山路口" },
    { lat: 24.9990, lng: 121.5110, r: 130, name: "中和景平路口" },
    { lat: 25.0330, lng: 121.5654, r: 150, name: "台北車站周邊" }
  ];

  // 高架/快速道路關鍵字（這些路上嚴禁直接左轉）
  var ELEVATED_PAT = /快速道路|高架|環河快|新生高架|建國高架|市民大道|台64|台65|台1線高架|東西向快速/;

  // 橋下平面道路（雖然名字像環河，但其實是平面，可以左轉）
  var SURFACE_PAT = /環河東路|環河西路|環河路|水門|堤外|平面/;

  /** 是否為高架道路 */
  function isElevated(street, ref) {
    var s = (street || "") + " " + (ref || "");
    if (!s.trim()) return false;
    if (SURFACE_PAT.test(s)) return false;
    return ELEVATED_PAT.test(s);
  }

  /** 是否為左轉動作（Valhalla type: 14急左 15左 19左匝道 21左側出口 24靠左）*/
  function isLeft(type) {
    return type === 14 || type === 15 || type === 19 || type === 21 || type === 24;
  }

  /** 這個座標是否在已知需待轉的路口範圍內 */
  function needsHookTurn(lat, lng) {
    if (lat == null || lng == null) return null;
    for (var i = 0; i < TURN_BOX.length; i++) {
      var b = TURN_BOX[i];
      if (distM(lat, lng, b.lat, b.lng) <= (b.r || 120)) return b;
    }
    return null;
  }

  function distM(la1, lo1, la2, lo2) {
    if (la1 == null || lo1 == null || la2 == null || lo2 == null) return Infinity;
    var R = 6371000, p = Math.PI / 180;
    var dLa = (la2 - la1) * p, dLo = (lo2 - lo1) * p;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /** 主判斷 */
  function leftRule(m) {
    if (!m || !isLeft(m.type)) return null;

    // 1) 高架上 → 絕對禁止
    if (isElevated(m.street, m.ref)) {
      return {
        level: "banned",
        title: "⛔ 高架上禁止左轉",
        detail: "直行，從合法出口下去再處理",
        speech: "注意，高架道路禁止左轉，請繼續往前，從下一個出口下去再處理",
        color: "#b91c1c"
      };
    }

    // 2) 已知需待轉的路口
    var box = needsHookTurn(m.lat, m.lng);
    if (box) {
      return {
        level: "hook",
        title: "🔄 兩段式左轉（進待轉區）",
        detail: "先騎進待轉區，等橫向綠燈再左轉",
        speech: "前方路口請兩段式左轉，先騎進待轉區，等綠燈再走",
        color: "#b45309"
      };
    }

    // 3) 沒有可信資料 → 誠實說不確定
    return {
      level: "unknown",
      title: "↰ 左轉・請自行判斷",
      detail: "無待轉資料｜沒待轉格且車少可直接轉，有紅綠燈或待轉標誌就要進待轉區",
      speech: "前方左轉，請自行確認這個路口要不要待轉。沒有待轉標誌且車流少才可以直接左轉",
      color: "#0369a1"
    };
  }

  /**
   * ★ 掃描整條路線：找出會上高架的路段
   * 這是「機車不能進高架」的主動警告，比左轉判斷更關鍵。
   * @returns [{index, street, length, sample}] 或 []
   */
  function scanElevated(maneuvers) {
    var hits = [];
    if (!maneuvers || !maneuvers.length) return hits;
    for (var i = 0; i < maneuvers.length; i++) {
      var m = maneuvers[i];
      // 只在下匝道/一般道路的「進入」動作檢查，避免把「已在橋上」重複算
      if (isElevated(m.street, m.ref)) {
        // 排除「左轉/右轉離開高架」的情況（那是要下去）
        hits.push({
          index: i,
          street: m.street || m.ref || "高架道路",
          length: Math.round(m.length || 0),
          type: m.type
        });
      }
    }
    return hits;
  }

  global.LEFT_RULE = {
    isElevated: isElevated,
    isLeft: isLeft,
    needsHookTurn: needsHookTurn,
    leftRule: leftRule,
    scanElevated: scanElevated,
    TURN_BOX: TURN_BOX,
    distM: distM
  };
})(window);
