/**
 * 台灣雙北調撥車道資料庫 v2
 * 重點：★區分方向★  同一條路/橋，早上與下午方向相反
 * 機車規定：一般機車禁行調撥車道（道交規則 §99），誤入罰 600~1800
 */

const DIAOBO = {
  taipei: [
    // ── 早上 07:00-09:00 ──
    { id:"mq_e",   road:"民權東路", area:"台北市", from:"國醫中心", to:"成功路",
      dir:"往西", time:["07:00-09:00"], reverse:"往東" },
    { id:"mq_e2",  road:"民權東路", area:"台北市", from:"成功路", to:"撫遠街",
      dir:"往西", time:["07:00-08:00"], reverse:"往東" },
    { id:"yf_b",   road:"永福橋", area:"雙北", from:"永和端", to:"台北端",
      dir:"進城(永和→台北)", time:["07:00-09:00"], reverse:"台北→永和",
      passable:true, alts:["福和橋","中正橋"],
      note:"調撥車道加開給進城方向；反方向仍有一般車道，走外側非調撥車道即可，不必繞路" },
    { id:"yf_e",   road:"永福橋", area:"雙北", from:"台北端", to:"永和端",
      dir:"下班(台北→永和)", time:["17:00-19:00"], reverse:"永和→台北",
      passable:true, alts:["福和橋","中正橋"],
      note:"傍晚調撥方向相反，改開放台北→永和；反向往台北仍有一般車道但車多壅塞" },
    { id:"zz_b",   road:"中正橋", area:"雙北", from:"永和端", to:"台北端",
      dir:"進城(永和→台北)", time:["07:00-09:00"], reverse:"台北→永和",
      passable:true, alts:["福和橋","永福橋"],
      note:"同永福橋，反方向仍有一般車道；塞可改走福和橋" },
    { id:"sy_r",   road:"水源路", area:"台北市", from:"水源路35巷", to:"師大路口",
      dir:"往北", time:["07:00-09:00","17:00-19:00"], reverse:"往南",
      note:"早晚都有，最危險" },
    { id:"yjy_r",  road:"研究院路", area:"台北市", from:"南港水廠", to:"忠孝東路",
      dir:"往北", time:["07:00-09:00"], reverse:"往南" },
    { id:"ng_r",   road:"南港路", area:"台北市", from:"南港橋頭", to:"研究院路",
      dir:"往西", time:["07:00-09:00"], reverse:"往東" },
    { id:"cd_r",   road:"承德路", area:"台北市", from:"士商路", to:"民族西路",
      dir:"往南", time:["07:00-09:00"], reverse:"往北" },
    { id:"zs_r",   road:"中山北路", area:"台北市", from:"", to:"",
      dir:"往南", time:["07:00-09:00"], reverse:"往北" },
    { id:"ls_r",   road:"羅斯福路", area:"台北市", from:"", to:"",
      dir:"往北", time:["07:00-09:00"], reverse:"往南",
      note:"羅斯福路四段至六段有調撥" },
    { id:"bd_r",   road:"八德路", area:"台北市", from:"", to:"",
      dir:"往西", time:["07:00-09:00"], reverse:"往東" },
    { id:"nj_r",   road:"南京東路", area:"台北市", from:"", to:"",
      dir:"往西", time:["07:00-09:00"], reverse:"往東" },
    { id:"ms_r",   road:"民生東路", area:"台北市", from:"", to:"",
      dir:"往西", time:["07:00-09:00"], reverse:"往東" },
    { id:"zx_r",   road:"忠孝東路", area:"台北市", from:"", to:"",
      dir:"往西", time:["07:00-09:00"], reverse:"往東" },
    { id:"jl_r",   road:"基隆路", area:"台北市", from:"", to:"",
      dir:"往北", time:["07:00-09:00"], reverse:"往南" },
    // ── 傍晚 17:00-19:00（方向相反）──
    { id:"gf_s",   road:"光復南路", area:"台北市", from:"", to:"",
      dir:"往南", time:["17:00-19:00"], reverse:"往北",
      note:"只有傍晚" },
    { id:"bj_e",   road:"濱江街", area:"台北市", from:"濱江街150巷", to:"國道南下入口匝道前",
      dir:"東往西", time:["17:00-19:00"], reverse:"西往東",
      note:"113/12/17 起試辦" },
  ],
  newtaipei: [
    { id:"sw_e",  road:"四維街", area:"中和區", from:"景新街", to:"四維街23巷",
      dir:"", time:["07:00-09:00"], reverse:"" },
    { id:"yh_e",  road:"永和路", area:"永和區", from:"中正路", to:"光復街2巷",
      dir:"", time:["07:00-09:00"], reverse:"" },
    { id:"yy_e",  road:"永元路", area:"永和區", from:"得和路", to:"永利路",
      dir:"", time:["07:00-09:00"], reverse:"" },
  ],
};

/* ═══════════ 時段判斷 ═══════════ */
function parseWindow(t) {
  const [s, e] = t.split("-");
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  return [sh * 60 + sm, eh * 60 + em];
}

function nowMinutes(d) {
  return d.getHours() * 60 + d.getMinutes();
}

/* 回傳目前生效的調撥路段（含方向） */
function activeSegments(now) {
  if (!now) now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return [];      // 週末不實施
  const cur = nowMinutes(now);
  const out = [];
  const all = [].concat(DIAOBO.taipei, DIAOBO.newtaipei);
  all.forEach(d => {
    d.time.forEach(t => {
      const [a, b] = parseWindow(t);
      if (cur >= a && cur < b) out.push({ seg: d, window: t });
    });
  });
  return out;
}

/* ═══════════ 路線檢查（含方向）═══════════ */
/**
 * 判斷路線是否碰到調撥路段
 * @param {string[]} names  路線經過的路名
 * @param {Date} now
 * @param {string} heading  行進方向（"N","S","E","W" 或空）
 */
function checkRouteDetail(names, now, heading) {
  const act = activeSegments(now);
  if (!act.length) return { warn: false, hits: [], active: [] };

  const hits = [];
  const seen = new Set();

  names.forEach((n, i) => {
    if (!n) return;
    act.forEach(({ seg, window }) => {
      const base = seg.road.replace(/[一二三四五六七八九十]+段$/, "");
      const nm = n.replace(/[一二三四五六七八九十]+段$/, "");
      // 路名匹配（互相包含，但要求至少 2 字）
      const match = (nm.length >= 2 && base.length >= 2) &&
                    (nm.indexOf(base) === 0 || base.indexOf(nm) === 0 ||
                     nm === base);
      if (!match) return;
      if (seen.has(seg.id)) return;
      seen.add(seg.id);

      // 方向判斷：seg.dir 是「調撥方向」，你的 heading 是實際行進方向
      //   heading 與 seg.dir 同向 → 你正要走進調撥車道（會被對向車撞）
      //   heading 與 seg.dir 反向 → 你走的是被調撥掉的方向（車道被別人佔用）
      //   兩種都危險，但敘述不同
      let dirWarn = "unknown";
      if (heading && seg.dir) {
        const map = { "N": "北", "S": "南", "E": "東", "W": "西" };
        const want = map[heading] || "";
        // seg.dir 可能是「往西」「永和→台北」等，抽出方位字
        const segDirStr = seg.dir;
        if (want && segDirStr) {
          const same = segDirStr.indexOf("往" + want) >= 0;
          const opp = /往[北南東西]/.test(segDirStr) && !same;
          if (same) dirWarn = "same";
          else if (opp) dirWarn = "opposite";
        }
        // 橋樑特殊：seg.dir 用「A→B」描述
        if (/→/.test(segDirStr)) {
          dirWarn = "bridge";   // 橋樑方向需人工確認
        }
      }

      hits.push({
        road: n,
        rule: seg,
        window: window,
        dirWarn: dirWarn,
        passable: !!seg.passable,
        alts: seg.alts || [],
        note: seg.note || "",
        // passable=true：仍有一般車道可走 → 降為提醒
        // 否則：真的禁行 → 高風險
        level: seg.passable ? "caution" :
               ((dirWarn === "same" || dirWarn === "opposite" || dirWarn === "bridge") ? "high" : "medium")
      });
    });
  });

  return { warn: hits.length > 0, hits, active: act };
}

/* 簡化版（向後相容） */
function checkRoute(names, now) {
  return checkRouteDetail(names, now, null);
}

/* ═══════════ 準備避開的座標點 ═══════════ */
/**
 * 回傳需要避開的座標（給 Valhalla avoid_locations 用）
 * @param {object} coordsMap  {id: {lat,lng}}
 */
function avoidPoints(now, coordsMap) {
  const act = activeSegments(now);
  if (!act.length || !coordsMap) return [];
  const out = [];
  act.forEach(({ seg }) => {
    if (seg.passable) return;          // 仍可通行 → 不強制避開
    const c = coordsMap[seg.id] || coordsMap[seg.road];
    if (c && c.lat && c.lng) {
      out.push({ id: seg.id, road: seg.road, lat: c.lat, lng: c.lng,
                 radius: 80 });
    }
  });
  return out;
}

/* ═══════════ 替代橋樑 ═══════════ */
function altBridges(now) {
  const act = activeSegments(now);
  const set = {};
  act.forEach(({ seg }) => {
    (seg.alts || []).forEach(a => { set[a] = true; });
  });
  return Object.keys(set);
}

/* ═══════════ 文字敘述 ═══════════ */
function timeWarnText(now) {
  if (!now) now = new Date();
  const h = now.getHours();
  if (h >= 6 && h < 7)   return "⚠️ 再 1 小時內進入早調撥（07:00-09:00）";
  if (h >= 7 && h < 9)   return "🚨 現在是早調撥時段（07:00-09:00）";
  if (h >= 16 && h < 17) return "⚠️ 再 1 小時內進入晚調撥（17:00-19:00）";
  if (h >= 17 && h < 19) return "🚨 現在是晚調撥時段（17:00-19:00）";
  return "";
}

/* 方向說明（給 UI 用） */
function dirText(d, hit) {
  const passable = hit && hit.passable;
  if (passable) {
    if (d === "bridge") return "調撥方向加開，反方向仍可走外側一般車道";
    return "仍有一般車道可走外側";
  }
  if (d === "same") return "同向 · 車道被調走，你會被逼到對向";
  if (d === "opposite") return "反向 · 對向是千軍萬馬";
  if (d === "bridge") return "橋樑 · 單向調撥，反向禁行機車";
  return "方向未判定";
}

/* 給 UI 的完整建議句 */
function adviceText(hit) {
  if (!hit) return "";
  if (hit.passable) {
    let s = "✅ 可以走，但走外側非調撥車道";
    if (hit.alts && hit.alts.length)
      s += "；若壅塞可改走" + hit.alts.join("或");
    return s;
  }
  return "⛔ 機車禁行，必須改道";
}

if (typeof module !== 'undefined') {
  module.exports = { DIAOBO, activeSegments, checkRouteDetail, checkRoute,
                     avoidPoints, timeWarnText, dirText, adviceText, altBridges };
}

/* ══════════ 自測 ══════════ */
if (typeof require !== 'undefined' && require.main === module) {
  const T = (h, min) => new Date(2026, 10, 5, h, min || 0);   // 週四
  console.log("═══ 時段判斷 ═══");
  [ [7,0], [8,30], [14,0], [17,30], [20,0] ].forEach(([h,m]) => {
    const a = activeSegments(T(h,m));
    console.log(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} → ${a.length} 處調撥`);
  });
  console.log("週六 08:00 →", activeSegments(new Date(2026,10,7,8,0)).length, "處（應為0）");

  console.log("\n═══ 永福橋往返（你的實際案例）═══");
  const morning = T(8, 0);
  console.log("\n【早上 08:00】");
  const back = checkRouteDetail(
    ["汀州路三段","思源街","永福橋","竹林路"], morning, "S");
  console.log("  台北→永和 走永福橋:", back.warn ? "⚠️ 警告" : "✅ 安全");
  back.hits.forEach(h => console.log(`     ${h.road} 調撥方向:${h.rule.dir} → ${dirText(h.dirWarn)}`));

  const go = checkRouteDetail(
    ["福和路","永福橋","汀州路三段"], morning, "N");
  console.log("  永和→台北 走永福橋:", go.warn ? "⚠️ 警告" : "✅ 安全");
  go.hits.forEach(h => console.log(`     ${h.road} 調撥方向:${h.rule.dir} → ${dirText(h.dirWarn)}`));

  console.log("\n【下午 18:00】");
  const aft = checkRouteDetail(["汀州路三段","永福橋","竹林路"], T(18,0), "S");
  console.log("  台北→永和:", aft.warn ? "⚠️ 警告" : "✅ 安全");
  const aft2 = checkRouteDetail(["福和路","永福橋","汀州路"], T(18,0), "N");
  console.log("  永和→台北:", aft2.warn ? "⚠️ 警告" : "✅ 安全");
  aft2.hits.forEach(h => console.log(`     ${h.road} → ${adviceText(h)}`));
  console.log("  替代橋樑:", altBridges(T(18,0)).join("、"));
}
