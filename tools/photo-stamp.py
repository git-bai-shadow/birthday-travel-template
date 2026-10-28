# -*- coding: utf-8 -*-
"""
photo-stamp.py · 把人工补齐的地点/日期写进压缩版照片的 EXIF

读 图片/待补信息.csv（人工填的），把地点换成 WGS-84 坐标、连同缺失的
拍摄时间一起写进 图片/压缩版/ 里对应照片的 EXIF。之后这些照片在录入
抽屉里就能和原生带定位的照片一样自动聚类、自动上地图。

写入用 piexif 原地替换 APP1 段，不重新编码像素（零画质损失）。

地点 → 坐标 的来源（手工核实）：
  - code/js/data/spots-cn.js 内置库（一律 WGS-84）
  - 其余来自公开资料；高德页面给出的是 GCJ-02，写入前用与 gcj02.js
    同款的算法转成 WGS-84，否则在 DataV 地图上会偏 500m 左右

顺序约定：先跑 photo-prep.py 再跑本脚本；prep 重跑会覆盖压缩版，
GPS 就得重新打一遍。

用法：  python tools/photo-stamp.py
依赖：  Pillow（读）、piexif（写，pip install piexif）
"""

import csv
import math
import re
from datetime import datetime
from pathlib import Path

import piexif
from piexif import GPSIFD

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "图片" / "待补信息.csv"
OUT_DIR = ROOT / "图片" / "压缩版"
SPOTS_JS = ROOT / "code" / "js" / "data" / "spots-cn.js"

# 人工核实的坐标。gcj=True 表示来自高德，需转 WGS-84。
PLACE_COORDS = {
    "景德镇":     (29.2700, 117.1800, False),
    "长沙·杜甫江阁": (28.1930, 112.9700, False),
    "武汉动物园":  (30.541448, 114.242265, True),
    "鄱阳湖大草原": (29.115861, 116.551772, True),
}


# --------------------------------------------------------------------------
# 坐标
# --------------------------------------------------------------------------

def load_spots():
    text = SPOTS_JS.read_text(encoding="utf-8")
    pat = re.compile(r"\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]")
    return {name: (float(lat), float(lon)) for name, city, lat, lon in pat.findall(text)}


def gcj02_to_wgs84(lng, lat):
    """与 lib/gcj02.js / geocode.php 同款算法，两次迭代约 1m 精度"""
    a, ee = 6378245.0, 0.00669342162296594323

    def out_of_china(lng, lat):
        return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)

    def transform_lat(x, y):
        ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
        ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
        ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
        ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
        return ret

    def transform_lng(x, y):
        ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
        ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
        ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
        ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
        return ret

    if out_of_china(lng, lat):
        return lng, lat
    wl, wa = lng, lat
    for _ in range(2):
        rad_lat = wa / 180.0 * math.pi
        magic = 1 - ee * math.sin(rad_lat) ** 2
        sqrt_magic = math.sqrt(magic)
        d_lat = (transform_lat(wl - 105.0, wa - 35.0) * 180.0) / ((a * (1 - ee)) / (magic * sqrt_magic) * math.pi)
        d_lng = (transform_lng(wl - 105.0, wa - 35.0) * 180.0) / ((a / sqrt_magic) * math.cos(rad_lat) * math.pi)
        wl, wa = lng - d_lng, lat - d_lat
    return wl, wa


def resolve_place(place, spots):
    """'长沙·杜甫江阁' / '武汉·东湖' → (lat, lon, 来源说明) | None"""
    place = place.strip()
    candidates = [place]
    if "·" in place:                       # 城市前缀拆开再试
        candidates += [place.split("·", 1)[1], place.split("·", 1)[0]]

    for cand in candidates:
        if cand in PLACE_COORDS:
            lat, lon, is_gcj = PLACE_COORDS[cand]
            if is_gcj:
                lng2, lat2 = gcj02_to_wgs84(lon, lat)
                return lat2, lng2, "人工资料(高德GCJ已转WGS-84)"
            return lat, lon, "人工资料"
        if cand in spots:
            return spots[cand][0], spots[cand][1], "内置景点库"
    return None


# --------------------------------------------------------------------------
# EXIF 写入（piexif 原地替换 APP1，不重编码）
# --------------------------------------------------------------------------

def to_rational_triplet(value):
    """十进制度 → ((度,1),(分,1),(秒*10000,10000))"""
    value = abs(value)
    d = int(value)
    m_full = (value - d) * 60
    m = int(m_full)
    s = round((m_full - m) * 60 * 10000)
    return ((d, 1), (m, 1), (s, 10000))


def normalize_date(s):
    """'2026-5-12' / '2026:04:11' / '2026-09-25' → (Y, M, D)"""
    m = re.match(r"\s*(\d{4})[:\-/年](\d{1,2})[:\-/月](\d{1,2})", s.strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        datetime(y, mo, d)
        return y, mo, d
    except ValueError:
        return None


def read_time(exif_dict):
    return (exif_dict["Exif"].get(36867) or exif_dict["0th"].get(306) or b"").decode("utf-8", "ignore").strip()


def stamp(path, lat, lon, date_ymd):
    """写入 GPS；没有拍摄时间的补一个。返回 (之前有GPS, 之前有时间)"""
    data = piexif.load(str(path))
    had_gps = GPSIFD.GPSLatitude in data["GPS"]
    had_time = bool(read_time(data))

    data["GPS"][GPSIFD.GPSVersionID] = (2, 3, 0, 0)
    data["GPS"][GPSIFD.GPSLatitudeRef] = b"N" if lat >= 0 else b"S"
    data["GPS"][GPSIFD.GPSLatitude] = to_rational_triplet(lat)
    data["GPS"][GPSIFD.GPSLongitudeRef] = b"E" if lon >= 0 else b"W"
    data["GPS"][GPSIFD.GPSLongitude] = to_rational_triplet(lon)

    if not had_time and date_ymd:
        y, mo, d = date_ymd
        # 一天里没时刻可考的，取个正午；只用于排序与聚类，不影响展示
        text = f"{y:04d}:{mo:02d}:{d:02d} 12:00:00"
        data["Exif"][36867] = text.encode()
        data["Exif"][36868] = text.encode()
        data["0th"][306] = text.encode()

    piexif.insert(piexif.dump(data), str(path))
    return had_gps, had_time


def verify(path):
    data = piexif.load(str(path))
    return GPSIFD.GPSLatitude in data["GPS"], bool(read_time(data))


def main():
    spots = load_spots()
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))[1:]

    done = skipped = 0
    for row in rows:
        if not any(row):
            continue
        name, date_text, place, _note = (row + [""] * 4)[:4]
        name, place = name.strip(), place.strip()
        if not name or not place:
            skipped += 1
            continue

        src = OUT_DIR / (Path(name).stem + ".jpg")
        if not src.is_file():
            print(f"  ✗ 找不到压缩版: {name}")
            skipped += 1
            continue

        resolved = resolve_place(place, spots)
        if not resolved:
            print(f"  ✗ 地点换不成坐标: {place}（{name}）")
            skipped += 1
            continue
        lat, lon, source = resolved

        date_ymd = normalize_date(date_text) if date_text.strip() else None
        had_gps, had_time = stamp(src, lat, lon, date_ymd)

        ok_gps, ok_time = verify(src)
        if not ok_gps or (not had_time and not ok_time):
            print(f"  ✗ {src.name}: 写入后回读校验失败（gps={ok_gps} time={ok_time}）")
            skipped += 1
            continue

        tag = "补GPS" + ("" if had_time else "+补时间")
        print(f"  ✓ {src.name}: {tag} ({lat:.4f}, {lon:.4f}, {source})")
        done += 1

    print(f"\n完成：写入 {done} 张，跳过/失败 {skipped} 张")


if __name__ == "__main__":
    main()
