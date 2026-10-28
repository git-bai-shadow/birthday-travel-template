# -*- coding: utf-8 -*-
"""校验子集字体的字符覆盖。

为什么需要这个：
浏览器对缺字是**静默回落**到下一个字体的 —— 不会报错、不会显示方框，
只会让那个字变成无衬线。肉眼很难逐个发现，所以必须离线比对 cmap。

用法：
    python tools/font-check.py
"""
import io, os, sys, importlib.util
from fontTools.ttLib import TTFont

ROOT = r"D:\0Claude\生日网站"
TOOLS = os.path.join(ROOT, "tools")
sys.path.insert(0, TOOLS)

spec = importlib.util.spec_from_file_location("fontsubset", os.path.join(TOOLS, "font-subset.py"))
fs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fs)

SUBSET = os.path.join(ROOT, "code", "assets", "NotoSerifSC-subset.woff2")

actual = fs.collect_chars()

font = TTFont(SUBSET)
covered = set()
for table in font["cmap"].tables:
    covered.update(chr(c) for c in table.cmap.keys())

missing = sorted(c for c in actual if c not in covered and c.isprintable())

lines = [
    "子集体积: %.1f KB" % (os.path.getsize(SUBSET) / 1024),
    "字体收录字符: %d" % len(covered),
    "站内实际会渲染的字符: %d" % len(actual),
    "",
]

if missing:
    lines.append("缺失 %d 个字符（这些字在安卓上会退化成无衬线）：" % len(missing))
    lines.append("  " + "".join(missing))
    lines.append("")
    lines.append("处理：在 tools/font-subset.py 里补进安全表，或在 config.js 里改掉这些字，然后重跑。")
else:
    lines.append("OK：站内所有会渲染的字符都已收录，安卓上不会有字退化成无衬线。")

io.open(os.path.join(ROOT, "_fontcheck.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("ok" if not missing else "missing %d" % len(missing))
