# -*- coding: utf-8 -*-
"""把 demo/ 示例内容导入站点（复制照片 + 写入 trips.json）。

用途：刚部署、还没有任何旅行数据时，跑一次这个脚本，站点就会带上
三段示例旅程（杭州 / 厦门 / 成都）与对应照片，先把界面撑起来。
之后用站内「补上一段」正常增删即可，示例数据也可以在站内删掉。

用法：
    python tools/import-demo.py            # trips.json 不存在时才写入
    python tools/import-demo.py --force    # 覆盖已有的 trips.json（慎用）

⚠️ 线上已有真实数据时不要跑 --force —— 它会把 data/trips.json 整个换掉。
"""

import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_PHOTOS = os.path.join(ROOT, "demo", "photos")
DEMO_TRIPS = os.path.join(ROOT, "demo", "trips.sample.json")
UPLOADS = os.path.join(ROOT, "code", "uploads")
DATA = os.path.join(ROOT, "code", "data")
TRIPS = os.path.join(DATA, "trips.json")


def main():
    force = "--force" in sys.argv

    # 1. 照片
    os.makedirs(UPLOADS, exist_ok=True)
    n = 0
    for fn in sorted(os.listdir(DEMO_PHOTOS)):
        if not fn.endswith(".webp"):
            continue
        shutil.copy2(os.path.join(DEMO_PHOTOS, fn), os.path.join(UPLOADS, fn))
        n += 1
    print("照片已复制 %d 个 -> code/uploads/" % n)

    # 2. 行程数据
    os.makedirs(DATA, exist_ok=True)
    if os.path.exists(TRIPS) and not force:
        print("code/data/trips.json 已存在，跳过（要覆盖请加 --force）")
        return 0
    with open(TRIPS, "w", encoding="utf-8", newline="\n") as f:
        f.write(io_open_read(DEMO_TRIPS))
    print("行程数据已写入 -> code/data/trips.json")
    return 0


def io_open_read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


if __name__ == "__main__":
    sys.exit(main())
