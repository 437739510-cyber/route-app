/**
 * 路口放大圖（類似高德的 3D 路口指引）
 * ─────────────────────────────────────────
 * 做法：用 Valhalla 提供的 bearing_before / bearing_after 算出轉彎角度，
 *      再用 SVG 畫一個俯瞰的路口示意圖：
 *        - 灰色粗線 = 你現在走的路
 *        - 亮綠色粗線 = 你該走的路（正確的那條）
 *        - 灰色細線 = 其他岔路（不要走錯）
 *        - 箭頭 = 行進方向
 *
 * 為什麼用 SVG 而不是 3D 地圖圖磚：
 *   公開圖資拿不到高德那種 3D 路口圖，硬做會很假。
 *   SVG 示意圖雖然不是實景，但能清楚表達「往哪個方向走」，
 *   而且零流量、斷網也能顯示。
 */
(function (global) {
  "use strict";

  /** 由 before/after bearing 算轉彎角度（-180~180，正=右轉） */
  function turnAngle(before, after) {
    if (before == null || after == null) return 0;
    return ((after - before + 540) % 360) - 180;
  }

  /** 把轉彎類型 + 角度轉成易讀標籤 */
  function turnLabel(type, ang) {
    var a = Math.abs(ang);
    if (type === 12 || type === 13) return "迴轉";
    if (a < 20) return "直行";
    if (a < 45) return ang > 0 ? "微靠右" : "微靠左";
    if (a < 135) return ang > 0 ? "右轉" : "左轉";
    return "迴轉";
  }

  /**
   * 產生路口示意圖 SVG
   * @param {number} ang 轉彎角度（度，正=右轉）
   * @param {string} road 目標路名
   * @param {object} opt  {level: banned|hook|unknown}
   */
  function buildSVG(ang, road, opt) {
    opt = opt || {};
    var W = 120, H = 120, cx = 60, cy = 60;
    var rad = (ang - 90) * Math.PI / 180;   // 上=0°，螢幕座標轉換

    // 主幹道：從下方進來的直線
    var inX = cx, inY = H + 6;
    // 轉彎後方向
    var outLen = 52;
    var outX = cx + Math.cos(rad) * outLen;
    var outY = cy + Math.sin(rad) * outLen;

    var isLeft = ang < -15;
    var isHook = opt.level === "hook";
    var isBanned = opt.level === "banned";
    var mainColor = isBanned ? "#ef4444" : (isHook ? "#f59e0b" : "#22c55e");

    // 其他岔路（灰色，誤導用，表示路口有其他選擇）
    var others = "";
    for (var k = -2; k <= 2; k++) {
      if (k === 0) continue;
      var oa = (k * 72 - 90) * Math.PI / 180;
      var ox = cx + Math.cos(oa) * 38, oy = cy + Math.sin(oa) * 38;
      others += '<line x1="' + cx + '" y1="' + cy + '" x2="' + ox.toFixed(1) + '" y2="' + oy.toFixed(1) +
                '" stroke="#475569" stroke-width="5" stroke-linecap="round" opacity=".55"/>';
    }

    var svg = [
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" ',
      'xmlns="http://www.w3.org/2000/svg" style="display:block">',
      // 背景
      '<rect width="' + W + '" height="' + H + '" rx="10" fill="#0b1220"/>',
      // 路口圓
      '<circle cx="' + cx + '" cy="' + cy + '" r="26" fill="#16202e"/>',
      // 其他岔路
      others,
      // 進來的路（灰）
      '<line x1="' + inX + '" y1="' + inY + '" x2="' + cx + '" y2="' + cy +
      '" stroke="#64748b" stroke-width="9" stroke-linecap="round"/>',
      // 該走的路（亮色）
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + outX.toFixed(1) + '" y2="' + outY.toFixed(1) +
      '" stroke="' + mainColor + '" stroke-width="9" stroke-linecap="round"/>',
      // 路口節點
      '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#fff" opacity=".9"/>',
      // 方向箭頭
      arrow(cx, cy, outX, outY, mainColor),
      // 文字：轉彎方向
      '<text x="' + W / 2 + '" y="16" text-anchor="middle" fill="' + mainColor +
      '" font-size="13" font-weight="800" font-family="sans-serif">',
      esc(turnLabel(opt.type, ang)),
      '</text>'
    ].join("");

    // 待轉提示
    if (isHook) {
      svg += '<text x="' + W / 2 + '" y="' + (H - 6) +
             '" text-anchor="middle" fill="#f59e0b" font-size="10" font-weight="700" font-family="sans-serif">' +
             '進待轉區</text>';
    } else if (isBanned) {
      svg += '<text x="' + W / 2 + '" y="' + (H - 6) +
             '" text-anchor="middle" fill="#ef4444" font-size="10" font-weight="700" font-family="sans-serif">' +
             '禁止左轉</text>';
    }

    svg += '</svg>';
    return svg;
  }

  function arrow(x1, y1, x2, y2, color) {
    var ang = Math.atan2(y2 - y1, x2 - x1);
    var L = 26, sp = 0.5;
    var ax = x2 - Math.cos(ang - sp) * L, ay = y2 - Math.sin(ang - sp) * L;
    var bx = x2 - Math.cos(ang + sp) * L, by = y2 - Math.sin(ang + sp) * L;
    return '<polygon points="' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' ' +
           ax.toFixed(1) + ',' + ay.toFixed(1) + ' ' +
           bx.toFixed(1) + ',' + by.toFixed(1) +
           '" fill="' + color + '" stroke="#0b1220" stroke-width="1.5"/>';
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  global.JUNCTION_VIEW = {
    turnAngle: turnAngle,
    turnLabel: turnLabel,
    buildSVG: buildSVG
  };
})(window);
