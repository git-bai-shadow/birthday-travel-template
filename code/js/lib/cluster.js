/* ==========================================================================
   cluster.js · 按 EXIF 把一批照片自动分成若干"候选景区"
   只有距离单一条件会出错：
     - 西湖这类大景区，照片散在几公里范围 → 被误拆成好几组
     - 同一天在同一城市不同地点 → 可能被误合并
   所以用「距离 + 时间」联合判断，两个条件取或。
   ========================================================================== */

import { distanceKm, centroid } from './gcj02.js';

const DEFAULTS = {
  distKm: 2,        // 组内两点最远距离超过这个值就分新组
  gapHours: 2,      // 距上一张照片超过这么久就强制分新组
};

/**
 * @param {Array<{lat:number, lon:number, takenAt:Date|number|null, file:File}>} items
 * @returns {Array<{photos:Array, centroid:{lng,lat}, from:number, to:number, hasGps:boolean}>}
 */
export function clusterPhotos(items, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  const withGps = [];
  const withoutGps = [];

  items.forEach((item, index) => {
    const rec = { ...item, _index: index };
    if (typeof item.lat === 'number' && typeof item.lon === 'number') withGps.push(rec);
    else withoutGps.push(rec);
  });

  // 有 GPS 的按拍摄时间排序后聚类
  withGps.sort((a, b) => timeOf(a) - timeOf(b));

  const groups = [];
  let current = null;

  for (const rec of withGps) {
    if (!current) {
      current = newGroup(rec);
      continue;
    }

    const center = centroid(current.photos.map((p) => ({ lng: p.lon, lat: p.lat })));
    const farInSpace = distanceKm(center.lng, center.lat, rec.lon, rec.lat) > opts.distKm;
    const farInTime = Math.abs(timeOf(rec) - timeOf(current.photos[current.photos.length - 1]))
                      > opts.gapHours * 3600 * 1000;

    if (farInSpace || farInTime) {
      groups.push(current);
      current = newGroup(rec);
    } else {
      current.photos.push(rec);
    }
  }
  if (current) groups.push(current);

  // 没有 GPS 的归入「待整理」
  if (withoutGps.length) {
    groups.push({
      photos: withoutGps,
      centroid: null,
      hasGps: false,
      from: Math.min(...withoutGps.map(timeOf)),
      to: Math.max(...withoutGps.map(timeOf)),
    });
  }

  return groups;
}

function newGroup(rec) {
  return {
    photos: [rec],
    hasGps: true,
    from: timeOf(rec),
    to: timeOf(rec),
    get centroid() {
      return centroid(this.photos.map((p) => ({ lng: p.lon, lat: p.lat })));
    },
  };
}

function timeOf(rec) {
  if (!rec.takenAt) return 0;
  const t = rec.takenAt instanceof Date ? rec.takenAt.getTime() : new Date(rec.takenAt).getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * 从一组照片里推断一个「旅行日期」：取出现次数最多的那一天
 */
export function dominantDate(photos) {
  const tally = new Map();
  for (const p of photos) {
    if (!p.takenAt) continue;
    const d = p.takenAt instanceof Date ? p.takenAt : new Date(p.takenAt);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  let best = null;
  let max = 0;
  for (const [k, v] of tally) if (v > max) { max = v; best = k; }
  return best;
}

/** 把 GPS 坐标按中国地理反查一个大致的地名提示（仅用于预填，需人工确认） */
export function roughDistrict(lng, lat) {
  if (lng > 115 && lng < 118 && lat > 39 && lat < 41) return '北京';
  if (lng > 120 && lng < 122.5 && lat > 30.5 && lat < 32) return '上海';
  if (lng > 118 && lng < 121 && lat > 29.5 && lat < 31.5) return '杭州';
  if (lng > 103.5 && lng < 104.5 && lat > 30 && lat < 31.5) return '成都';
  if (lng > 108.5 && lng < 109.5 && lat > 33.5 && lat < 35) return '西安';
  return '';
}
