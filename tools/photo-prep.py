# -*- coding: utf-8 -*-
"""
photo-prep.py · 导入前照片预处理

对 图片/ 里的照片做三件事（产物都在 图片/ 子目录里，原图不动）：
  1. 审计 EXIF：有没有 GPS（地址）、有没有拍摄时间，没有的用文件名推断
  2. 压缩到站点导入规格：长边 1800px、JPEG 质量 82 —— 与 js/config.js
     upload.full 的规格一致。EXIF（GPS/时间）与 ICC 色彩配置原样保留，
     方向角烤进像素里（否则导入后某些图会横躺）
  3. 生成 图片/照片汇总.md：哪些有地址、哪些有时间，按日期分组，
     方便在录入抽屉里按天建行程

用压缩版导入时直接在抽屉里选 图片/压缩版/ 里的文件即可，EXIF 聚类照常工作。

用法：  python tools/photo-prep.py
依赖：  Pillow（pip install pillow）
"""

import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "图片"
OUT_DIR = SRC_DIR / "压缩版"
SUMMARY = SRC_DIR / "照片汇总.md"
SPOTS_JS = ROOT / "code" / "js" / "data" / "spots-cn.js"

MAX_EDGE = 1800        # 与 config.upload.full.maxEdge 一致
QUALITY = 82           # 与 config.upload.full.quality 一致
COPY_BELOW_MB = 2.0    # 已经够小且尺寸达标的 JPEG 直接复制，不再多吃一次有损压缩
NEAR_KM = 15           # 离内置景区这么近才算"在某某附近"

IMG_EXIF = 0x8769      # EXIF IFD
GPS_IFD = 0x8825


# --------------------------------------------------------------------------
# 内置景区库：坐标 → 附近地名
# --------------------------------------------------------------------------

def load_spots():
    """从 spots-cn.js 抠出 [名称, 城市, 纬度, 经度] 表，免引 JS 运行时"""
    text = SPOTS_JS.read_text(encoding="utf-8")
    pat = re.compile(r"\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]")
    spots = [(name, city, float(lat), float(lon))
             for name, city, lat, lon in pat.findall(text)]
    return spots


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest_spot(lat, lon, spots):
    best, best_d = None, None
    for name, city, slat, slon in spots:
        d = haversine_km(lat, lon, slat, slon)
        if best_d is None or d < best_d:
            best, best_d = (name, city), d
    return best, (best_d or 1e9)


# --------------------------------------------------------------------------
# EXIF 读取
# --------------------------------------------------------------------------

def rational(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def gps_to_degrees(raw):
    """EXIF 的 GPS 是 (度, 分, 秒) 三个有理数"""
    if not raw or len(raw) < 3:
        return None
    d, m, s = (rational(x) for x in raw[:3])
    if d is None:
        return None
    return d + (m or 0) / 60 + (s or 0) / 3600


def read_exif(path):
    """返回 {gps: (lat, lon) | None, taken: str | None, w, h}"""
    out = {"gps": None, "taken": None, "w": 0, "h": 0}
    try:
        with Image.open(path) as im:
            out["w"], out["h"] = im.size
            exif = im.getexif()
            if not exif:
                return out

            # 拍摄时间：优先 DateTimeOriginal（EXIF IFD），退回 IFD0 的 DateTime
            taken = (exif.get_ifd(IMG_EXIF).get(36867)
                     or exif.get(306))
            if isinstance(taken, str) and taken.strip():
                out["taken"] = taken.strip()

            gps = exif.get_ifd(GPS_IFD)
            lat = gps_to_degrees(gps.get(2))
            lon = gps_to_degrees(gps.get(4))
            if lat is not None and lon is not None:
                if str(gps.get(1, "")).upper() == "S":
                    lat = -lat
                if str(gps.get(3, "")).upper() == "W":
                    lon = -lon
                if lat != 0 or lon != 0:
                    out["gps"] = (round(lat, 6), round(lon, 6))
    except Exception as e:
        out["error"] = str(e)
    return out


# --------------------------------------------------------------------------
# 文件名推断时间（微信图/修图导出通常被抹掉 EXIF）
# --------------------------------------------------------------------------

def guess_time_from_name(name):
    """返回 (时间字符串, 依据说明)；推不出来返回 (None, None)。
    模式从具体到一般：IMG_20251101_095756 → 13 位毫秒时间戳 → 任意 20260517_133639。
    8+6 的泛匹配要过一道日期合理性检查，免得把长数字串（时间戳）误读成日期。"""
    m = re.search(r"IMG[_-]?(\d{8})[_-]?(\d{6})", name)
    if m:
        d, t = m.group(1), m.group(2)
        return f"{d[:4]}-{d[4:6]}-{d[6:8]} {t[:2]}:{t[2:4]}:{t[4:6]}", "文件名"
    m = re.search(r"(\d{13})", name)          # 毫秒时间戳（image_/mmexport 类）
    if not m:
        m = re.search(r"(1\d{9})", name)      # 秒时间戳
    if m:
        val = int(m.group(1))
        if val > 1e12:
            val /= 1000
        try:
            return datetime.fromtimestamp(val).strftime("%Y-%m-%d %H:%M:%S"), "文件名时间戳"
        except (ValueError, OSError):
            pass
    m = re.search(r"(\d{8})[_T]?(\d{6})", name)
    if m:
        d, t = m.group(1), m.group(2)
        try:
            datetime.strptime(d, "%Y%m%d")
            return f"{d[:4]}-{d[4:6]}-{d[6:8]} {t[:2]}:{t[2:4]}:{t[4:6]}", "文件名"
        except ValueError:
            pass
    return None, None


def day_of(taken):
    """'2025:11:01 09:57:56' / '2025-11-01 …' → '2025-11-01'；解析不了返回原文"""
    if not taken:
        return "未知日期"
    m = re.match(r"(\d{4})[:\-/](\d{2})[:\-/](\d{2})", taken)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else taken[:10]


# --------------------------------------------------------------------------
# 压缩（保留 EXIF / ICC / 方向）
# --------------------------------------------------------------------------

def compress_one(src, dst):
    """返回 (输出字节大小, 复制还是重编码)"""
    size_mb = src.stat().st_size / 1024 / 1024
    with Image.open(src) as im:
        w, h = im.size

        # 已达标的小 JPEG 不再重编码：省一次有损生成
        if (src.suffix.lower() in (".jpg", ".jpeg")
                and max(w, h) <= MAX_EDGE and size_mb <= COPY_BELOW_MB):
            dst.write_bytes(src.read_bytes())
            return dst.stat().st_size, "copy"

        im = ImageOps.exif_transpose(im)   # 方向烤进像素，EXIF 里的方向角同步清掉
        exif_bytes = im.info.get("exif")
        icc = im.info.get("icc_profile")

        if im.mode != "RGB":
            if "A" in im.getbands() or im.mode == "P":
                base = Image.new("RGB", im.size, (255, 255, 255))
                rgba = im.convert("RGBA")
                base.paste(rgba, mask=rgba.split()[-1])
                im = base
            else:
                im = im.convert("RGB")

        if max(im.size) > MAX_EDGE:
            im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)

        kwargs = {"quality": QUALITY, "optimize": True, "progressive": True}
        if exif_bytes:
            kwargs["exif"] = exif_bytes
        if icc:
            kwargs["icc_profile"] = icc
        im.save(dst, "JPEG", **kwargs)
        return dst.stat().st_size, "reencode"


# --------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------

def fmt_size(n):
    return f"{n / 1024 / 1024:.1f}M" if n >= 1024 * 1024 else f"{max(1, n // 1024)}K"


def human_addr(gps, spots):
    if not gps:
        return "—"
    lat, lon = gps
    (name, city), d = nearest_spot(lat, lon, spots)
    if d <= NEAR_KM:
        return f"{name}（{city}）附近"
    return f"{lat:.4f}, {lon:.4f}"


def main():
    if not SRC_DIR.is_dir():
        sys.exit("找不到 图片/ 目录")
    spots = load_spots()
    OUT_DIR.mkdir(exist_ok=True)

    files = sorted(p for p in SRC_DIR.iterdir()
                   if p.is_file()
                   and p.suffix.lower() in (".jpg", ".jpeg", ".png"))

    rows = []
    total_src = total_out = 0
    for p in files:
        meta = read_exif(p)
        out_path = OUT_DIR / (p.stem + ".jpg")
        try:
            out_size, how = compress_one(p, out_path)
        except Exception as e:
            rows.append({"name": p.name, "error": str(e)})
            print(f"  ✗ {p.name}: {e}")
            continue

        # 复核：压缩产物里 GPS 和时间还在不在（重编码丢元数据是最容易踩的坑）
        out_meta = read_exif(out_path)
        gps_ok = (meta["gps"] is None) == (out_meta["gps"] is None)
        time_ok = (meta["taken"] is None) == (out_meta["taken"] is None)
        if not (gps_ok and time_ok):
            print(f"  ⚠ {p.name}: 元数据有变化 gps_ok={gps_ok} time_ok={time_ok}")

        taken, basis = meta["taken"], "EXIF"
        if not taken:
            taken, basis = guess_time_from_name(p.name)
            if not taken:
                basis = "—"

        rows.append({
            "name": p.name,
            "taken": taken,
            "basis": basis,
            "gps": meta["gps"],
            "addr": human_addr(meta["gps"], spots),
            "w": meta["w"], "h": meta["h"],
            "src": p.stat().st_size,
            "out": out_size,
            "how": how,
        })
        total_src += p.stat().st_size
        total_out += out_size
        print(f"  ✓ {p.name}: {fmt_size(p.stat().st_size)} -> {fmt_size(out_size)}"
              f"{'（原样复制）' if how == 'copy' else ''}")

    write_summary(rows, spots, total_src, total_out)
    print(f"\n完成：{len(rows)} 个文件，{fmt_size(total_src)} -> {fmt_size(total_out)}"
          f"\n压缩版：{OUT_DIR}\n汇总：{SUMMARY}")


def write_summary(rows, spots, total_src, total_out):
    ok = [r for r in rows if "error" not in r]
    bad = [r for r in rows if "error" in r]

    def time_key(r):
        return r["taken"] or "9999"
    ok.sort(key=time_key)

    n_gps_time = sum(1 for r in ok if r["gps"] and r["taken"])
    n_gps = sum(1 for r in ok if r["gps"] and not r["taken"])
    n_time = sum(1 for r in ok if not r["gps"] and r["taken"])
    n_none = sum(1 for r in ok if not r["gps"] and not r["taken"])

    lines = []
    lines.append("# 照片汇总（导入准备）")
    lines.append("")
    lines.append(f"> 生成于 {datetime.now().strftime('%Y-%m-%d %H:%M')}，"
                 f"共 {len(ok)} 张（{fmt_size(total_src)} → 压缩版 {fmt_size(total_out)}）。"
                 "原图未动，导入时选 **`压缩版/`** 里的文件。")
    lines.append("")
    lines.append("## 一眼结论")
    lines.append("")
    lines.append("| 情况 | 张数 |")
    lines.append("|---|---|")
    lines.append(f"| 有地址 + 有时间（导入后自动定位） | {n_gps_time} |")
    lines.append(f"| 只有时间，没地址（要手动填地点） | {n_time} |")
    lines.append(f"| 只有地址，没时间（少见） | {n_gps} |")
    lines.append(f"| 都没有（时间靠文件名推断，地址要手动填） | {n_none} |")
    if bad:
        lines.append(f"| 读取失败 | {len(bad)} |")
    lines.append("")
    over = [r for r in ok if r["src"] > 8 * 1024 * 1024]
    if over:
        lines.append(f"⚠️ 原图超过 8MB 上限的有 **{len(over)}** 张"
                     f"（{'、'.join(r['name'] for r in over[:5])}"
                     f"{'…' if len(over) > 5 else ''}）——直接选原图会被录入抽屉拒收，必须用压缩版。")
        lines.append("")
    lines.append("导入提示：录入抽屉按「距离 + 拍摄时间」自动分组，一次选同一天的几张效果最好；"
                 "一处地点最多挂 12 张。")
    lines.append("")

    # 按天分组（行程就是按天建的）。
    # 一天的 GPS 收敛成一个中心点 + 半径，可读性比甩九对坐标好得多。
    lines.append("## 按拍摄日期分组")
    lines.append("")
    by_day = {}
    for r in ok:
        by_day.setdefault(day_of(r["taken"]), []).append(r)
    for day in sorted(by_day):
        rs = by_day[day]
        pts = [r["gps"] for r in rs if r["gps"]]
        if pts:
            names = sorted({r["addr"] for r in rs if r["gps"] and "附近" in r["addr"]})
            if names:
                where = "、".join(names)
            else:
                clat = sum(p[0] for p in pts) / len(pts)
                clon = sum(p[1] for p in pts) / len(pts)
                spread = max(haversine_km(clat, clon, p[0], p[1]) for p in pts)
                where = f"{clat:.3f}, {clon:.3f} 一带（±{spread:.1f}km，内置景点库未覆盖，录入时手动填地点）"
            note = f"{len(pts)}/{len(rs)} 张有定位 · {where}"
        else:
            note = "无定位（需手动填地点）"
        no_time = sum(1 for r in rs if not r["taken"])
        if no_time:
            note += f"；{no_time} 张时间缺失"
        lines.append(f"### {day} · {len(rs)} 张 · {note}")
        lines.append("")

    # 全量明细
    lines.append("## 明细（按时间排序）")
    lines.append("")
    lines.append("| 文件 | 拍摄时间 | 时间依据 | 地址 | 尺寸 | 原大小 → 压缩后 |")
    lines.append("|---|---|---|---|---|---|")
    for r in ok:
        taken = r["taken"] or "（没有）"
        if r["basis"].startswith("文件名"):
            taken += " ⚠️"
        size = f"{fmt_size(r['src'])} → {fmt_size(r['out'])}"
        dims = f"{r['w']}×{r['h']}"
        lines.append(f"| {r['name']} | {taken} | {r['basis']} | {r['addr']} | {dims} | {size} |")
    for r in bad:
        lines.append(f"| {r['name']} | 读取失败：{r['error']} | | | | |")
    lines.append("")
    lines.append("时间带 ⚠️ 的是 EXIF 缺失、按文件名推断的（微信图和修图导出常被抹掉元数据）。")
    lines.append("")

    SUMMARY.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
