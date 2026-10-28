/* ==========================================================================
   gcj02.js · 火星坐标转换
   高德返回 GCJ-02，阿里 DataV 的地图是 WGS-84，两者相差 500–800 米。
   不转换的话，放大到省市级时点会明显飘走。
   这里用公开算法本地实现，零配额消耗、离线可用。
   ========================================================================== */

const PI = Math.PI;
const A = 6378245.0;                 // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323;   // 偏心率平方

/** 粗略判断是否在中国境外（境外不做偏移） */
export function outOfChina(lng, lat) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y
          + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y
          + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

function offset(lng, lat) {
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);

  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);

  return { dLat, dLng };
}

/** GCJ-02 → WGS-84，迭代两次，精度约 1 米 */
export function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];

  let wgsLng = lng;
  let wgsLat = lat;

  for (let i = 0; i < 2; i++) {
    const { dLat, dLng } = offset(wgsLng, wgsLat);
    wgsLng = lng - dLng;
    wgsLat = lat - dLat;
  }
  return [wgsLng, wgsLat];
}

/** WGS-84 → GCJ-02（反向用，一般用不到） */
export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const { dLat, dLng } = offset(lng, lat);
  return [lng + dLng, lat + dLat];
}

/* --------------------------------------------------------------------------
   测地线距离（用于统计"累计多少公里"与照片聚类）
   -------------------------------------------------------------------------- */

const R = 6371.0088; // 地球平均半径，公里

export function distanceKm(lng1, lat1, lng2, lat2) {
  const toRad = (v) => (v * PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 一组坐标的中心点 */
export function centroid(points) {
  if (!points.length) return { lng: 0, lat: 0 };
  let lng = 0;
  let lat = 0;
  for (const p of points) { lng += p.lng; lat += p.lat; }
  return { lng: lng / points.length, lat: lat / points.length };
}

/** 路径总长度（公里），按数组顺序 */
export function pathLengthKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceKm(points[i - 1].lng, points[i - 1].lat, points[i].lng, points[i].lat);
  }
  return total;
}
