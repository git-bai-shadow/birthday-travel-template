# -*- coding: utf-8 -*-
"""生成分享卡片 code/assets/og.png（1200x630）。

为什么要这个文件：微信/QQ 发链接时显示的预览图读的是 index.html 里的
`og:image`，缺了它预览就是一张空白卡片。

名字与署名从 code/js/config.js 里读，所以**改了名字重跑一次这个脚本就行**：

    python tools/make-og.py

需要 _fontsrc/NotoSerifCJKsc-Regular.otf（与 tools/font-subset.py 共用同一个源字体），
缺了会提示下载命令。
"""

import io
import os
import re

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "code", "js", "config.js")
SRC_FONT = os.path.join(ROOT, "_fontsrc", "NotoSerifCJKsc-Regular.otf")
OUT = os.path.join(ROOT, "code", "assets", "og.png")

W, H = 1200, 630

# 与 css/themes.css 的 clay（日间）一致
BG = (250, 249, 245)
GLOW = (255, 253, 248)
EDGE = (243, 237, 226)
INK = (20, 20, 19)
MUTED = (108, 106, 100)
ACCENT = (204, 120, 92)
ACCENT_STRONG = (179, 95, 66)
LINE = (220, 211, 198)


def read_site():
    """从 config.js 里取名字与署名（不执行 JS，只做正则提取）。"""
    with io.open(CONFIG, "r", encoding="utf-8") as f:
        txt = f.read()

    def grab(key):
        m = re.search(key + r"\s*:\s*'([^']*)'", txt)
        return m.group(1).strip() if m else ""

    her = grab("herName")
    sign = grab("signature")
    # 还是 [占位] 就不画，免得卡片上出现方括号
    if "[" in her:
        her = ""
    if "[" in sign:
        sign = ""
    return her, sign


def vertical_gradient(img, top, bottom):
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        d.line(
            [(0, y), (W, y)],
            fill=(
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )


def radial_glow(img, cx, cy, radius, color, strength=0.55):
    """中心柔光：用一层 RGBA 逐圈画，省得引 numpy。"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 90
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(255 * strength * (1 - i / steps) ** 1.6)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (a,))
    img.alpha_composite(layer)


def draw_heart(draw, cx, cy, size, color):
    """两圆 + 一三角拼一颗心（和信封上的火漆印同一个造型）。"""
    r = size / 4.0
    draw.ellipse([cx - 2 * r, cy - r * 1.5, cx, cy + r * 0.5], fill=color)
    draw.ellipse([cx, cy - r * 1.5, cx + 2 * r, cy + r * 0.5], fill=color)
    draw.polygon(
        [(cx - 2 * r, cy - r * 0.35), (cx + 2 * r, cy - r * 0.35), (cx, cy + r * 1.75)],
        fill=color,
    )


def main():
    if not os.path.exists(SRC_FONT):
        raise SystemExit(
            "缺少源字体：%s\n下载：\n"
            "  curl -L --retry 3 -o \"_fontsrc/NotoSerifCJKsc-Regular.otf\" ^\n"
            "    https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/OTF/"
            "SimplifiedChinese/NotoSerifCJKsc-Regular.otf" % SRC_FONT
        )

    her, sign = read_site()

    img = Image.new("RGBA", (W, H), BG + (255,))
    vertical_gradient(img, GLOW, EDGE)
    radial_glow(img, W // 2, 150, 760, GLOW, 0.85)
    radial_glow(img, W // 2, H + 180, 700, EDGE, 0.5)

    # 火漆印
    seal = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seal)
    sr = 34
    sd.ellipse([W // 2 - sr, 108 - sr, W // 2 + sr, 108 + sr], fill=ACCENT_STRONG + (255,))
    sd.ellipse([W // 2 - sr + 4, 108 - sr + 3, W // 2 + sr - 3, 108 + sr - 4], fill=ACCENT + (255,))
    draw_heart(sd, W // 2, 106, 30, (255, 255, 255, 235))
    img.alpha_composite(seal)

    d = ImageDraw.Draw(img)

    f_big = ImageFont.truetype(SRC_FONT, 96)
    f_name = ImageFont.truetype(SRC_FONT, 62)
    f_small = ImageFont.truetype(SRC_FONT, 30)
    f_sign = ImageFont.truetype(SRC_FONT, 24)

    d.text((W // 2, 262), "生日快乐", font=f_big, fill=INK, anchor="mm")

    name_y = 355
    if her:
        d.text((W // 2, name_y), her, font=f_name, fill=ACCENT, anchor="mm")
        line_y, sub_y, sign_y = 428, 470, 545
    else:
        line_y, sub_y, sign_y = 400, 448, 530

    d.line([(W // 2 - 80, line_y), (W // 2 + 80, line_y)], fill=LINE, width=1)
    d.text((W // 2, sub_y), "这是给你的。", font=f_small, fill=MUTED, anchor="mm")
    if sign:
        d.text((W // 2, sign_y), "—— " + sign, font=f_sign, fill=MUTED, anchor="mm")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.convert("RGB").save(OUT, "PNG", optimize=True)

    size = os.path.getsize(OUT)
    print("og.png 已生成: %s (%d x %d, %.1f KB)" % (OUT, W, H, size / 1024.0))


if __name__ == "__main__":
    main()
