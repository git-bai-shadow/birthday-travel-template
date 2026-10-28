/* ==========================================================================
   mapview.js · 抽象足迹地图
   中国为主、世界为衬，只画景区光点。

   合规要点（不要改）：
     - 中国轮廓必须用符合官方标准画法的数据源（当前用阿里 DataV）
     - 不用 OSM 等国际数据源，其边界画法与中国官方标准不一致
     - 默认视野 = 完整版图（含台湾与南海诸岛）；放大后一旦看不全版图，
       右下角必须补一块「南海诸岛」附图 —— 这是国标地图处理放大与裁切的
       标准做法，不允许「放大到看不见就不画」
     - 缩放上限由 config 的跨度下限约束，不让人放到只剩一条省界

   性能：
     版图几何构建成 Path2D 缓存在 (lng, lat) 空间，绘制时只把 Canvas 变换
     设成该空间的仿射矩阵。拖拽平移要逐帧重画，三万多点逐点 lineTo 在
     安卓中端机上会掉帧；缓存之后每帧只是 fill/stroke 一个现成路径。
   ========================================================================== */

import { config } from '../config.js';
import { h, clamp } from '../lib/dom.js';
import { cssVar as cssColorVar } from '../lib/fx.js';

/** 完整中国版图的范围（含南海诸岛）。默认视野与平移范围都以它为准 */
const CHINA_BOX = { minLng: 73, maxLng: 136, minLat: 3, maxLat: 54 };
const LAT0 = 30;                                  // 投影基准纬度
const K = Math.cos((LAT0 * Math.PI) / 180);       // 经度压缩系数

/** 附图范围：必须同时装下台湾（lat 21.9~25.9）与南海诸岛（低至 lat 3.4） */
const INSET_BOX = { minLng: 104, maxLng: 126, minLat: 2.5, maxLat: 27 };
const INSET_W = 78;
const INSET_H = 104;
const INSET_HEAD = 16;                            // 附图顶部标题条高度

const BOX_SPAN_LNG = CHINA_BOX.maxLng - CHINA_BOX.minLng;
const BOX_SPAN_LAT = CHINA_BOX.maxLat - CHINA_BOX.minLat;

let geoCache = null;

export function createMapView({ points = [], onPick, onLocate } = {}) {
  const cfg = (config.footprints && config.footprints.map) || {};

  /* 缩放下限来自 config：跨度不小于它，避免放大到看不出省份轮廓。
     注意真正保证「领土不被裁掉」的是下面那块附图，不是这个跨度 ——
     台湾与南海诸岛纬度相差约 22°，任何有意义的放大都会裁掉其中之一。 */
  const minSpanLng = Number(cfg.minSpanLng) > 0 ? Number(cfg.minSpanLng) : 14;
  const minSpanLat = Number(cfg.minSpanLat) > 0 ? Number(cfg.minSpanLat) : 9;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = clamp(
    Math.min(BOX_SPAN_LNG / minSpanLng, BOX_SPAN_LAT / minSpanLat), 1.5, 12);

  /* 放大到这个倍率后，光点旁边直接标地名（放不下会自动跳过，见 drawSmallLabel） */
  const LABEL_ZOOM = 2.4;

  const canvas = h('canvas');
  const tip = h('div', { class: 'map__tip' });
  const badge = h('div', { class: 'map__hint', text: '点击光点定位' });

  const zoomIn = h('button', {
    class: 'map__zb', type: 'button', 'aria-label': '放大地图', text: '+',
    onClick: () => setZoom(zoom * 1.7, null),
  });
  const zoomOut = h('button', {
    class: 'map__zb', type: 'button', 'aria-label': '缩小地图', text: '\u2212',
    onClick: () => setZoom(zoom / 1.7, null),
  });
  const zoomReset = h('button', {
    class: 'map__zb map__zb--reset', type: 'button', 'aria-label': '回到全国范围',
    text: '全国', onClick: () => resetView(),
  });

  const zbox = h('div', { class: 'map__zoom' }, zoomIn, zoomOut, zoomReset);
  const wrap = h('div', { class: 'mapwrap' }, canvas, zbox, badge, tip);

  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let view = null;
  let selected = null;
  let geo = null;
  let geoBase = '';                // 当前生效的数据源目录，省级数据必须用同一个版本
  let geoPath = null;             // 缓存的版图路径，坐标是 (lng, lat)
  let hitPoints = [];
  let geoFailed = false;

  let zoom = 1;
  let centerLng = (CHINA_BOX.minLng + CHINA_BOX.maxLng) / 2;
  let centerLat = (CHINA_BOX.minLat + CHINA_BOX.maxLat) / 2;
  let baseScale = 1;              // zoom = 1 时的像素/度

  /* 地级市图层：省份清单（adcode + 外接矩形）与已取的市级路径缓存。
     数据仍来自 DataV（每省一个 {adcode}_full.json，同一合规数据源），
     全国 300+ 市一次拉完要几十 MB，所以只在放大后按视野逐省懒加载。 */
  let provinces = [];
  const CITY_ZOOM = 2;
  const cityCache = new Map();    // adcode -> Path2D | 'loading'

  /* 点位布局的记忆化凭据：
     pointsVersion —— 数据每更新一次 +1（update() 里做）
     layoutEpoch—— 缩放/平移导致的重新布局次数，用来在数据没变时也失效缓存 */
  let pointsVersion = 0;
  let layoutEpoch = 0;

  /* ---------------- 视图与投影 ---------------- */

  function resize() {
    const w = wrap.clientWidth || 320;
    // 中国版图宽高比约 63:51，留一点上下留白
    const h2 = Math.round(w * (51 / 63) * 1.02);
    wrap.style.height = `${h2}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h2 * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h2}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    baseScale = Math.min(w / (BOX_SPAN_LNG * K), h2 / BOX_SPAN_LAT) * 0.94;
    computeView();
    draw();
  }

  function computeView() {
    const w = wrap.clientWidth || 320;
    const hh = canvas.height / dpr;
    const scale = baseScale * zoom;

    const spanLng = w / (scale * K);
    const spanLat = hh / scale;
    // 留一点边距，让边缘的点不至于贴死边框
    const padLng = 1.5;
    const padLat = 1.2;

    // 视野大于版图时锁定居中（zoom = 1 就是这种状态，与旧版渲染完全一致）
    centerLng = spanLng >= BOX_SPAN_LNG + padLng * 2
      ? (CHINA_BOX.minLng + CHINA_BOX.maxLng) / 2
      : clamp(centerLng,
          CHINA_BOX.minLng + spanLng / 2 - padLng,
          CHINA_BOX.maxLng - spanLng / 2 + padLng);

    centerLat = spanLat >= BOX_SPAN_LAT + padLat * 2
      ? (CHINA_BOX.minLat + CHINA_BOX.maxLat) / 2
      : clamp(centerLat,
          CHINA_BOX.minLat + spanLat / 2 - padLat,
          CHINA_BOX.maxLat - spanLat / 2 + padLat);

    view = { lng: centerLng, lat: centerLat, scale, w, h: hh, spanLng, spanLat };
  }

  function project(lng, lat, v = view) {
    return {
      x: (lng - v.lng) * v.scale * K + v.w / 2,
      y: (v.lat - lat) * v.scale + v.h / 2,
    };
  }

  function unproject(x, y) {
    return {
      lng: view.lng + (x - view.w / 2) / (view.scale * K),
      lat: view.lat - (y - view.h / 2) / view.scale,
    };
  }

  /* 把 Canvas 变换直接设成 (lng, lat) → 设备像素 的仿射矩阵。
     ox / oy 用于把同一套投影画到附图那个小框里。 */
  function applyProjection(v, ox = 0, oy = 0) {
    ctx.setTransform(
      dpr * v.scale * K, 0,
      0, -dpr * v.scale,
      dpr * (ox + v.w / 2 - v.lng * v.scale * K),
      dpr * (oy + v.h / 2 + v.lat * v.scale),
    );
  }

  /* ---------------- 数据 ---------------- */

  async function loadGeo() {
    if (geo) return geo;
    if (geoCache) { geo = geoCache; buildGeoPath(); return geo; }

    /* DataV 的 areas_v2 / areas_v3 轮流失效（2026-10 实测 v3 的省级数据
       已整体 404）。所以不写死单一 URL：按候选列表依次尝试，
       第一个能用的就用它，并把「当前可用的版本」记下来，
       省级数据跟着用同一个版本 —— 否则会出现国界是 v2、省界是 v3
       这种版本错配（两套坐标细节略有差异，接缝处会错位）。 */
    const cands = geoCandidates();
    let lastErr = null;
    for (const base of cands) {
      try {
        const res = await fetch(`${base}100000_full.json`, { cache: 'force-cache' });
        if (!res.ok) { lastErr = new Error(`（${res.status}）`); continue; }
        const gj = await res.json();
        geoBase = base;
        geoCache = gj;
        geo = gj;
        buildGeoPath();
        return geo;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`地图数据加载失败 ${lastErr ? lastErr.message : ''}`);
  }

  /** 候选数据源：优先配置的版本，其次另一个版本兜底。 */
  function geoCandidates() {
    const configured = String(cfg.geojsonUrl || '');
    const dir = configured.replace(/[^/]*\.json$/, '');
    const list = [dir];
    if (dir.indexOf('/areas_v3/') >= 0) list.push(dir.replace('/areas_v3/', '/areas_v2/'));
    else if (dir.indexOf('/areas_v2/') >= 0) list.push(dir.replace('/areas_v2/', '/areas_v3/'));
    return list;
  }

  function appendGeomToPath(path, geom) {
    const polygons = geom.type === 'Polygon' ? [geom.coordinates]
                   : geom.type === 'MultiPolygon' ? geom.coordinates
                   : [];
    for (const poly of polygons) {
      for (const ring of poly) {
        if (!ring.length) continue;
        path.moveTo(ring[0][0], ring[0][1]);
        for (let i = 1; i < ring.length; i++) path.lineTo(ring[i][0], ring[i][1]);
        path.closePath();
      }
    }
  }

  /** 整块版图构建成一个 Path2D，之后每帧只做 fill / stroke */
  function buildGeoPath() {
    const p = new Path2D();
    for (const f of geo.features || []) {
      if (f.geometry) appendGeomToPath(p, f.geometry);
    }
    geoPath = p;
    collectProvinces();
  }

  /** 记下每个省的 adcode 与外接矩形：放大后判断哪些省的市级边界要拉取 */
  function collectProvinces() {
    provinces = [];
    for (const f of geo.features || []) {
      const adcode = f.properties && f.properties.adcode;
      const geom = f.geometry;
      if (!adcode || !geom) continue;
      let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
      const polys = geom.type === 'Polygon' ? [geom.coordinates]
                  : geom.type === 'MultiPolygon' ? geom.coordinates
                  : [];
      for (const poly of polys) {
        for (const ring of poly) {
          for (const [lng, lat] of ring) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
      }
      provinces.push({ adcode: String(adcode), bbox: { minLng, maxLng, minLat, maxLat } });
    }
  }

  /** 遍历一个 geometry 的所有坐标环，每环回调一次 (min[lon,lat], max[lon,lat]) */
  function collectBBox(geom, cb) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
                : geom.type === 'MultiPolygon' ? geom.coordinates
                : [];
    for (const poly of polys) {
      for (const ring of poly) {
        let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
        for (const [lng, lat] of ring) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
        cb([minLng, minLat], [maxLng, maxLat]);
      }
    }
  }

  /* ---------------- 绘制 ---------------- */

  function draw() {
    if (!view) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);

    drawGraticule(view);
    drawChina(view);
    ensureCityLayer();
    drawCities(view);
    drawPoints();

    const inset = zoom > 1.001;
    wrap.classList.toggle('has-inset', inset);
    if (inset) drawInset();

    syncControls();
  }

  /** 极淡的经纬网，暗示"世界"，不涉及任何边界画法 */
  function drawGraticule(v) {
    ctx.save();
    ctx.strokeStyle = cssColorVar('--text-3') || '#666';
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 0.5;

    // 放大后线要跟着变密，否则整屏只剩一两条
    const step = v.spanLat > 34 ? 10 : v.spanLat > 18 ? 5 : v.spanLat > 8 ? 2 : 1;

    const lngFrom = Math.floor((v.lng - v.spanLng / 2) / step) * step;
    const lngTo = v.lng + v.spanLng / 2;
    for (let lng = lngFrom; lng <= lngTo; lng += step) {
      const a = project(lng, CHINA_BOX.minLat, v);
      const b = project(lng, CHINA_BOX.maxLat, v);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    const latFrom = Math.floor((v.lat - v.spanLat / 2) / step) * step;
    const latTo = v.lat + v.spanLat / 2;
    for (let lat = latFrom; lat <= latTo; lat += step) {
      const a = project(CHINA_BOX.minLng, lat, v);
      const b = project(CHINA_BOX.maxLng, lat, v);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawChina(v, { ox = 0, oy = 0, fillAlpha = 0.18, strokeAlpha = 0.58, lineWidth = 0.9 } = {}) {
    if (!geoPath) return;
    const accent = cssColorVar('--accent') || '#CC785C';

    ctx.save();
    applyProjection(v, ox, oy);

    // 陆地填充
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = accent;
    ctx.fill(geoPath);

    // 省界。线宽要在投影空间里换算，否则放大后边界会跟着变成粗黑线
    ctx.globalAlpha = strokeAlpha;
    ctx.strokeStyle = accent;
    ctx.lineWidth = lineWidth / v.scale;
    ctx.stroke(geoPath);

    ctx.restore();
  }

  /* ⚠️ 斥力解算要记忆化。resolveOverlap 是 26 轮双重循环，而 drawPoints
     在每次 pointermove（onMove → draw()）都触发 —— n=100 时约 13 万次
     运算/帧。而结果**只取决于数据与投影**（zoom/center），平移时虽会变，
     但一帧内算一次就够，没必要每帧重算。
     缓存键用 (数据版本, 缩放, 中心经纬, 画布尺寸) —— 任一变化即失效。 */
  let layoutCache = null;

  function placedPoints() {
    const valid = points.filter((p) => typeof p.lng === 'number' && typeof p.lat === 'number');
    const key = [
      pointsVersion, layoutEpoch,
      zoom.toFixed(4), centerLng.toFixed(4), centerLat.toFixed(4),
      view.w, view.h,
    ].join('|');
    if (layoutCache && layoutCache.key === key) return layoutCache.value;
    const value = resolveOverlap(valid);
    layoutCache = { key, value };
    return value;
  }

  function drawPoints() {
    const accent = cssColorVar('--accent') || '#CC785C';
    const bg = cssColorVar('--bg') || '#FAF9F5';
    const text = cssColorVar('--text') || '#141413';

    const placed = placedPoints();
    hitPoints = placed;
    let selRect = null;

    // 第一遍：全部光点（含光晕与选中环）
    for (const p of placed) {
      // 画在视野外的点不必走绘制流程
      if (p.x < -40 || p.y < -40 || p.x > view.w + 40 || p.y > view.h + 40) continue;

      const isSel = selected && selected.id === p.id;
      const r = isSel ? 5.5 : 3.6;

      // 光晕
      ctx.save();
      ctx.globalAlpha = isSel ? 0.5 : 0.26;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 实心点
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = bg;
      ctx.stroke();

      if (isSel) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        selRect = drawLabel(p, { accent, bg, text });
      }
    }

    // 第二遍：高倍率时给其余点标地名。文字底衬用纸色 halo，
    // 位置先试点上方、再试下方，和已放置的标签或光点重叠就跳过 ——
    // 宁可少标也不遮挡。
    if (zoom >= LABEL_ZOOM) {
      const used = [];
      if (typeof selRect !== 'undefined' && selRect) used.push(selRect);
      const dotHalf = 8;
      for (const p of placed) {
        if (p.x < -40 || p.y < -40 || p.x > view.w + 40 || p.y > view.h + 40) continue;
        used.push({ x: p.x - dotHalf, y: p.y - dotHalf, w: dotHalf * 2, h: dotHalf * 2 });
      }
      for (const p of placed) {
        if (selected && p.id === selected.id) continue;
        if (!p.name) continue;
        if (p.x < 0 || p.y < 0 || p.x > view.w || p.y > view.h) continue;
        drawSmallLabel(p, { bg, text }, used);
      }
    }
  }

  /** 高倍率下的小标签：无底框，纸色描边保证可读；与已放置内容重叠就换位/放弃 */
  function drawSmallLabel(p, { bg, text }, used) {
    ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(p.name).width + 12;
    const h = 15;

    const candidates = [
      { x: p.x - w / 2, y: p.y - 13 - h },   // 上方
      { x: p.x - w / 2, y: p.y + 11 },       // 下方
    ];
    for (const c of candidates) {
      const rect = {
        x: clamp(c.x, 2, view.w - w - 2),
        y: clamp(c.y, 2, view.h - h - 2),
        w, h,
      };
      if (used.some((q) => rect.x < q.x + q.w && rect.x + rect.w > q.x
                        && rect.y < q.y + q.h && rect.y + rect.h > q.y)) continue;

      const cx = rect.x + w / 2;
      const cy = rect.y + h / 2;
      ctx.lineWidth = 3;
      ctx.strokeStyle = bg;
      ctx.globalAlpha = 0.9;
      ctx.strokeText(p.name, cx, cy);
      ctx.globalAlpha = 1;
      ctx.fillStyle = text;
      ctx.fillText(p.name, cx, cy);
      used.push(rect);
      return;
    }
  }

  /* 放大后确保视野内省份的市级边界已取（取到即重画，渐进显现） */
  function ensureCityLayer() {
    if (!provinces.length || !view || zoom < CITY_ZOOM) return;
    const v = view;
    const w = {
      minLng: v.lng - v.spanLng / 2, maxLng: v.lng + v.spanLng / 2,
      minLat: v.lat - v.spanLat / 2, maxLat: v.lat + v.spanLat / 2,
    };
    /* 用当前生效的版本目录（geoBase），而不是从配置重新推导——
       配置里写的那版可能已404，降级后若还用它取省界就会
       出现「国界 v2、省界 v3」的版本错配，接缝处错位。 */
    const base = geoBase || String(cfg.geojsonUrl).replace(/[^/]*\.json$/, '');
    for (const prov of provinces) {
      const b = prov.bbox;
      const intersects = b.minLng <= w.maxLng && b.maxLng >= w.minLng
                      && b.minLat <= w.maxLat && b.maxLat >= w.minLat;
      if (!intersects || cityCache.has(prov.adcode)) continue;
      cityCache.set(prov.adcode, 'loading');
      fetch(`${base}${prov.adcode}_full.json`, { cache: 'force-cache' })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
        .then((gj) => {
          const path = new Path2D();
          /* 顺便记下 (lng,lat) 空间的包围盒，drawCities 用来按视野剔除 ——
             Path2D 本身不提供 bbox，漫游全国后累积数百个缓存，
             每帧全stroke 一遍在中端安卓上会明显掉帧。 */
          let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
          for (const f of gj.features || []) {
            appendGeomToPath(path, f.geometry);
            collectBBox(f.geometry, (lo, hi) => {
              if (lo[0] < minLng) minLng = lo[0];
              if (hi[0] > maxLng) maxLng = hi[0];
              if (lo[1] < minLat) minLat = lo[1];
              if (hi[1] > maxLat) maxLat = hi[1];
            });
          }
          path.__bbox = [minLng, minLat, maxLng, maxLat];
          cityCache.set(prov.adcode, path);
          draw();
        })
        .catch(() => cityCache.delete(prov.adcode));   // 失败的下回进视野再试
    }
  }

  /** 地级市界：比省界细一档、淡一档，只做层次提示不抢戏 */
  function drawCities(v) {
    if (zoom < CITY_ZOOM) return;
    const accent = cssColorVar('--accent') || '#CC785C';
    ctx.save();
    applyProjection(v);
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 0.6 / v.scale;
    /* ⚠️ 按当前视野过滤。cityCache 累积到漫游全国后有数百个省的 Path2D，
       每帧全部 stroke 一遍；实际只有落在视野里的才看得见。
       Path2D 存在 (lng,lat) 空间，投影是仿射矩阵，所以可以直接用
       经纬度范围粗筛 —— 宁可多画几个，也不要漏。 */
    const mx = v.w / v.scale / 2 + 6 / v.scale;   // 视野外扩，别在边缘抖
    const my = v.h / v.scale / 2 + 6 / v.scale;
    const x0 = v.lng - mx;
    const x1 = v.lng + mx;
    const y0 = v.lat - my;
    const y1 = v.lat + my;
    for (const path of cityCache.values()) {
      if (path === 'loading') continue;
      // Path2D 不提供 bbox，用建路径时记下的那个粗筛
      const bb = path.__bbox;
      if (bb && (bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1)) continue;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /* --------------------------------------------------------------------------
     南海诸岛附图
     放大之后主图必然看不全版图。国标地图的做法是补一块附图把南海诸岛画全，
     这里把台湾一并纳入范围，于是「放大后仍有领土被裁掉」这件事不会发生。
     -------------------------------------------------------------------------- */

  function drawInset() {
    const x0 = view.w - 10 - INSET_W;
    const y0 = view.h - 10 - INSET_H;
    const mapH = INSET_H - INSET_HEAD;

    const spanLng = INSET_BOX.maxLng - INSET_BOX.minLng;
    const spanLat = INSET_BOX.maxLat - INSET_BOX.minLat;
    const s = Math.min(INSET_W / (spanLng * K), mapH / spanLat) * 0.92;

    const iv = {
      lng: (INSET_BOX.minLng + INSET_BOX.maxLng) / 2,
      lat: (INSET_BOX.minLat + INSET_BOX.maxLat) / 2,
      scale: s,
      w: INSET_W,
      h: mapH,
    };

    ctx.save();

    // 背板 + 标题条
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssColorVar('--bg-soft') || '#F5F0E8';
    roundRect(ctx, x0, y0, INSET_W, INSET_H, 6);
    ctx.fill();
    ctx.strokeStyle = cssColorVar('--line-strong') || 'rgba(0,0,0,.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = cssColorVar('--text-3') || '#6C6A64';
    ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('南海诸岛', x0 + INSET_W / 2, y0 + INSET_HEAD / 2 + 0.5);

    // 版图裁进附图框内（裁剪区在设备空间，之后改变换不会把它带走）
    ctx.beginPath();
    ctx.rect(x0 + 1, y0 + INSET_HEAD, INSET_W - 2, mapH - 1);
    ctx.clip();
    drawChina(iv, { ox: x0, oy: y0 + INSET_HEAD, fillAlpha: 0.24, strokeAlpha: 0.7, lineWidth: 0.55 });

    ctx.restore();
  }

  function drawLabel(p, { accent, bg, text }) {
    const label = p.name || '';
    if (!label) return;

    ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const w = ctx.measureText(label).width + 16;
    const hgt = 22;
    let x = p.x - w / 2;
    let y = p.y - hgt - 10;

    x = clamp(x, 4, view.w - w - 4);
    if (y < 4) y = p.y + 10;

    ctx.save();
    ctx.globalAlpha = 0.94;
    ctx.fillStyle = bg;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 0.8;
    roundRect(ctx, x, y, w, hgt, 6);
    ctx.fill();
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + hgt / 2 + 0.5);
    ctx.restore();
    return { x, y, w, h: hgt };
  }

  function roundRect(c, x, y, w, hgt, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + hgt, r);
    c.arcTo(x + w, y + hgt, x, y + hgt, r);
    c.arcTo(x, y + hgt, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** 完全重合的点会叠在一起，做一点轻微的斥力偏移，保证都能看到 */
  function resolveOverlap(list) {
    const out = list.map((p) => {
      const s = project(p.lng, p.lat);
      return { ...p, x: s.x, y: s.y };
    });

    for (let iter = 0; iter < 26; iter++) {
      let moved = false;
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i];
          const b = out[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          const min = 13;
          if (d < min && d >= 0) {
            const push = (min - d) / 2 + 0.4;
            const ux = d === 0 ? Math.cos(i) : dx / d;
            const uy = d === 0 ? Math.sin(i) : dy / d;
            a.x -= ux * push; a.y -= uy * push;
            b.x += ux * push; b.y += uy * push;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return out;
  }

  /* ---------------- 缩放与平移 ---------------- */

  function localXY(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** next 是目标倍率；anchor 是要按住不动的画布坐标（null = 保持中心不动） */
  function setZoom(next, anchor) {
    const target = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(target - zoom) < 0.0005) return;

    const fixed = anchor ? unproject(anchor.x, anchor.y) : null;
    zoom = target;

    if (fixed && anchor) {
      const scale = baseScale * zoom;
      centerLng = fixed.lng - (anchor.x - view.w / 2) / (scale * K);
      centerLat = fixed.lat + (anchor.y - view.h / 2) / scale;
    }

    computeView();
    draw();
  }

  function resetView() {
    zoom = 1;
    centerLng = (CHINA_BOX.minLng + CHINA_BOX.maxLng) / 2;
    centerLat = (CHINA_BOX.minLat + CHINA_BOX.maxLat) / 2;
    computeView();
    draw();
  }

  function syncControls() {
    zoomIn.disabled = zoom >= MAX_ZOOM - 0.001;
    zoomOut.disabled = zoom <= MIN_ZOOM + 0.001;
    zoomReset.hidden = zoom <= MIN_ZOOM + 0.001;
    wrap.classList.toggle('is-zoomed', zoom > 1.001);

    if (geoFailed) return;
    badge.textContent = zoom > 1.001
      ? '拖拽平移 · 双击复位'
      : '点击光点定位 · 双击放大';
  }

  /* ---------------- 交互 ---------------- */

  function pickAt(x, y) {
    let best = null;
    let bestD = 26;
    for (const p of hitPoints) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function selectPoint(p) {
    if (!p) {
      selected = null;
      tip.classList.remove('is-on');
      draw();
      return;
    }

    selected = p;
    tip.innerHTML = '';
    tip.appendChild(h('strong', { text: p.name || '某个地方' }));
    if (p.sub) tip.appendChild(document.createTextNode(` · ${p.sub}`));
    if (p.date) tip.appendChild(document.createTextNode(` · ${p.date}`));
    tip.appendChild(h('div', {
      style: { marginTop: '6px', color: 'var(--text-3)', fontSize: '11.5px' },
      text: '点这里查看这一段 →',
    }));
    tip.classList.add('is-on');
    draw();

    onPick?.(p);
    onLocate?.(p);
  }

  let lastTap = null;

  function handleTap(px) {
    // 双击：放大；已到最大倍率则回到全国
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320
        && Math.hypot(px.x - lastTap.x, px.y - lastTap.y) < 28) {
      lastTap = null;
      if (zoom >= MAX_ZOOM - 0.001) resetView();
      else setZoom(zoom * 1.9, px);
      return;
    }
    lastTap = { t: now, x: px.x, y: px.y };
    selectPoint(pickAt(px.x, px.y));
  }

  const pointers = new Map();
  let panStart = null;    // 单指平移基准
  let pinchStart = null;  // 双指捏合基准
  let downPos = null;
  let moved = false;

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 指针可能已经释放（或来自合成事件），捕获失败不该中断手势
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* noop */ }

    const p = localXY(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 1) {
      downPos = p;
      moved = false;
      panStart = { x: p.x, y: p.y, lng: centerLng, lat: centerLat };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinchStart = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom,
        fixed: unproject(mid.x, mid.y),
      };
      panStart = null;
      moved = true;      // 双指不算点选
    }
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localXY(e);
    pointers.set(e.pointerId, p);

    // 双指捏合
    if (pointers.size >= 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      zoom = clamp(pinchStart.zoom * (dist / pinchStart.dist), MIN_ZOOM, MAX_ZOOM);
      const scale = baseScale * zoom;
      // 起手时按住的经纬度始终落在两指中点下方，手感才不飘
      centerLng = pinchStart.fixed.lng - (mid.x - view.w / 2) / (scale * K);
      centerLat = pinchStart.fixed.lat + (mid.y - view.h / 2) / scale;

      computeView();
      draw();
      return;
    }

    // 单指平移（未放大时没有可平移的余量）
    if (pointers.size === 1 && panStart) {
      const dx = p.x - panStart.x;
      const dy = p.y - panStart.y;
      if (!moved && Math.hypot(dx, dy) > 6) moved = true;
      if (!moved || zoom <= 1.001) return;

      centerLng = panStart.lng - dx / (view.scale * K);
      centerLat = panStart.lat + dy / view.scale;
      computeView();
      draw();
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localXY(e);
    pointers.delete(e.pointerId);

    if (pointers.size === 1) {
      // 双指变单指：重设基准，否则会跳一下
      pinchStart = null;
      const q = [...pointers.values()][0];
      panStart = { x: q.x, y: q.y, lng: centerLng, lat: centerLat };
      downPos = null;
      return;
    }

    if (pointers.size > 0) return;

    const wasPinch = !!pinchStart;
    const tap = !wasPinch && !moved && downPos
      && Math.hypot(p.x - downPos.x, p.y - downPos.y) < 9;

    pinchStart = null;
    panStart = null;
    downPos = null;
    moved = false;

    if (tap) handleTap(p);
  }

  function onWheel(e) {
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.0022), localXY(e));
  }

  // 用 AbortController 统一回收，destroy 时不会残留监听
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  canvas.addEventListener('pointerdown', onDown, sig);
  canvas.addEventListener('pointermove', onMove, sig);
  canvas.addEventListener('pointerup', onUp, sig);
  canvas.addEventListener('pointercancel', onUp, sig);
  canvas.addEventListener('wheel', onWheel, { passive: false, signal: ac.signal });

  tip.addEventListener('click', () => {
    if (selected) onLocate?.(selected);
  }, sig);

  /* ---------------- 生命周期 ---------------- */

  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => resize())
    : null;

  async function init() {
    resize();
    if (ro) ro.observe(wrap);

    try {
      await loadGeo();
      draw();
    } catch (err) {
      geoFailed = true;
      badge.textContent = '地图暂时加载不出来';
      console.warn('[map]', err);
    }
  }

  return {
    el: wrap,
    init,
    update(nextPoints) {
      points = nextPoints;
      pointsVersion += 1;      // 数据变了 → 布局缓存失效
      selected = null;
      tip.classList.remove('is-on');
      draw();
    },
    highlight(pointId) {
      const p = hitPoints.find((q) => q.id === pointId)
             || points.find((q) => q.id === pointId)
             || null;
      selected = p;

      /* 从时间线点「定位」过来时若地图正处于放大状态，该点可能落在视野外 ——
         那样用户会看不到任何反馈，像是定位失灵。这里把它挪进视野（不改倍率）。 */
      if (p && typeof p.lng === 'number' && view) {
        const s = project(p.lng, p.lat);
        const m = 24;
        if (s.x < m || s.y < m || s.x > view.w - m || s.y > view.h - m) {
          centerLng = p.lng;
          centerLat = p.lat;
          computeView();
        }
      }

      draw();
    },
    destroy() {
      ac.abort();
      ro?.disconnect();
    },
  };
}
