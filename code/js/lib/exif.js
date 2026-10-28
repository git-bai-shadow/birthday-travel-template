/* ==========================================================================
   exif.js · 从 JPEG 里读出拍摄时间与 GPS
   纯手写解析，不依赖任何库。
   只处理 JPEG（安卓相机默认输出 JPEG，本项目无 iOS 设备）。
   顺带做一次格式嗅探，遇到 HEIC 之类给出明确提示而不是静默失败。
   ========================================================================== */

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD  = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME = 0x0132;

const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT     = 0x0002;
const TAG_GPS_LNG_REF = 0x0003;
const TAG_GPS_LNG     = 0x0004;

/** 读取文件头判断真实格式，不信任扩展名与 MIME */
export async function sniffFormat(file) {
  const buf = await file.slice(0, 32).arrayBuffer();
  const b = new Uint8Array(buf);
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

  if (hex.startsWith('ffd8ff')) return 'jpeg';
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'webp';
  if (hex.slice(8, 16).includes('66747970')) {
    // ISO-BMFF：可能是 HEIC / HEIF / AVIF
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/heic|heix|hevc|mif1|msf1/i.test(brand)) return 'heic';
    if (/avif/i.test(brand)) return 'avif';
  }
  return 'unknown';
}

/** 主入口：返回 { takenAt, lat, lon, format } */
export async function readExif(file) {
  const format = await sniffFormat(file);

  if (format === 'heic' || format === 'avif') {
    return { format, unsupported: true };
  }
  if (format !== 'jpeg') {
    return { format };
  }

  try {
    // APP1 段一定在文件最前面，读 256KB 足够
    const slice = file.slice(0, Math.min(file.size, 256 * 1024));
    const buf = await slice.arrayBuffer();
    const parsed = parseJpeg(buf);
    return { format, ...parsed };
  } catch (err) {
    return { format, error: String(err && err.message || err) };
  }
}

/* -------------------------------------------------------------------------- */

function parseJpeg(buffer) {
  const view = new DataView(buffer);
  const len = buffer.byteLength;

  if (view.getUint16(0) !== 0xffd8) throw new Error('不是 JPEG');

  let offset = 2;
  while (offset < len - 4) {
    if (view.getUint8(offset) !== 0xff) { offset++; continue; }
    const marker = view.getUint8(offset + 1);

    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // 图像数据开始，后面没有 EXIF 了
    if (marker === 0xda) break;

    const size = view.getUint16(offset + 2);
    if (marker === 0xe1) {
      const exifStart = offset + 4;
      if (matchesExifHeader(view, exifStart)) {
        return parseTiff(buffer, exifStart + 6);
      }
    }
    offset += 2 + size;
  }
  return {};
}

function matchesExifHeader(view, at) {
  if (at + 6 > view.byteLength) return false;
  return view.getUint32(at) === 0x45786966 && view.getUint16(at + 4) === 0x0000;
}

function parseTiff(buffer, tiffStart) {
  const view = new DataView(buffer);
  const little = view.getUint16(tiffStart) === 0x4949;
  const read16 = (o) => view.getUint16(o, little);
  const read32 = (o) => view.getUint32(o, little);

  if (read16(tiffStart + 2) !== 0x002a) return {};

  const ifd0 = tiffStart + read32(tiffStart + 4);
  const ifd0Entries = readIfd(view, ifd0, read16, read32, tiffStart, little);

  const out = {};

  // 拍摄时间：优先 DateTimeOriginal，退回 IFD0 的 DateTime
  if (ifd0Entries[TAG_DATETIME]) out.takenAt = parseExifDate(ifd0Entries[TAG_DATETIME].ascii);

  if (ifd0Entries[TAG_EXIF_IFD]) {
    const exifIfd = tiffStart + ifd0Entries[TAG_EXIF_IFD].value;
    const exifEntries = readIfd(view, exifIfd, read16, read32, tiffStart, little);
    if (exifEntries[TAG_DATETIME_ORIGINAL]) {
      out.takenAt = parseExifDate(exifEntries[TAG_DATETIME_ORIGINAL].ascii);
    }
  }

  // GPS
  if (ifd0Entries[TAG_GPS_IFD]) {
    const gpsIfd = tiffStart + ifd0Entries[TAG_GPS_IFD].value;
    const gps = readIfd(view, gpsIfd, read16, read32, tiffStart, little);

    const lat = toDegrees(gps[TAG_GPS_LAT]);
    const lng = toDegrees(gps[TAG_GPS_LNG]);
    const latRef = gps[TAG_GPS_LAT_REF] && gps[TAG_GPS_LAT_REF].ascii;
    const lngRef = gps[TAG_GPS_LNG_REF] && gps[TAG_GPS_LNG_REF].ascii;

    if (lat !== null && lng !== null && lat !== 0 && lng !== 0) {
      out.lat = latRef === 'S' ? -lat : lat;
      out.lon = lngRef === 'W' ? -lng : lng;
    }
  }

  return out;
}

function readIfd(view, start, read16, read32, tiffStart, little) {
  const entries = {};
  if (start + 2 > view.byteLength) return entries;

  const count = read16(start);
  for (let i = 0; i < count; i++) {
    const p = start + 2 + i * 12;
    if (p + 12 > view.byteLength) break;

    const tag = read16(p);
    const type = read16(p + 2);
    const num = read32(p + 4);
    const size = typeSize(type) * num;
    const valueAt = size <= 4 ? p + 8 : tiffStart + read32(p + 8);

    const entry = { type, count: num, value: read32(p + 8) };

    if (type === 2) {
      entry.ascii = readAscii(view, valueAt, num);
    } else if (type === 5 || type === 10) {
      entry.rationals = readRationals(view, valueAt, num, type === 10, little);
    } else if (type === 3) {
      entry.shorts = readShorts(view, valueAt, num, little);
    }

    entries[tag] = entry;
  }
  return entries;
}

function typeSize(type) {
  return { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
}

function readAscii(view, at, count) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function readShorts(view, at, count, little) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(view.getUint16(at + i * 2, little));
  return out;
}

/* ⚠️ 必须用传进来的 little。原来写死 `true`（而 read32 形参完全没用上，
   是复制粘贴漏改的痕迹）：parseTiff 认真读了 0x4949(小端)/0x4D4D(大端) 来
   决定字节序，readShorts 也正确传了 little，唯独 GPS 有理数这处忽略它。
   大端（Motorola 顺序）TIFF 的分子分母被逐字节交换 → 经纬度假值
   （30/1 变成天文数字）→ 照片被打点到地图上错误的位置，**且不报任何错**。 */
function readRationals(view, at, count, signed, little) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const num = signed ? view.getInt32(at + i * 8, little) : view.getUint32(at + i * 8, little);
    const den = signed ? view.getInt32(at + i * 8 + 4, little) : view.getUint32(at + i * 8 + 4, little);
    out.push(den === 0 ? 0 : num / den);
  }
  return out;
}

function toDegrees(entry) {
  if (!entry || !entry.rationals || entry.rationals.length < 3) return null;
  const [d, m, s] = entry.rationals;
  return d + m / 60 + s / 3600;
}

/** "2025:05:01 14:32:10" → Date */
function parseExifDate(str) {
  if (!str) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  const date = new Date(y, mo - 1, d, hh, mm, ss);
  return isNaN(date.getTime()) ? null : date;
}
