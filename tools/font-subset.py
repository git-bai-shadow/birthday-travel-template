# -*- coding: utf-8 -*-
"""生成自托管衬线子集字体。

背景：安卓系统不带中文衬线字体，`--serif` 里写 "Songti SC" / "Noto Serif SC"
在安卓上都会落空，所有中文一律渲染成无衬线 —— 整套「文学排版」的意图在目标
设备上等于不存在。唯一解法是把衬线字体内嵌进站点。

策略：从 code/ 里抽出**实际用到的所有字符**，再叠加一份常用字安全表
（用户之后会改 config.js 的文案，安全表能接住大部分改写）。
缺字时浏览器会沿 font-family 链往后退到无衬线，**不会出现方框**，
所以是「个别字不衬线」而不是「坏掉」。

用法：
    python tools/font-subset.py

需要源字体 `_fontsrc/NotoSerifCJKsc-Regular.otf`（23.4 MB，只用来生成子集，
生成完就不再需要，可以随时删掉腾空间）。缺失时用下面这条重新下载：

    curl -L --retry 3 -o "_fontsrc/NotoSerifCJKsc-Regular.otf" ^
      https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-Regular.otf

（Windows 的 cmd/PowerShell 里用 ^ 续行；Git Bash 里换成反斜杠。）
需要一个装了 fonttools + brotli 的 Python：
    pip install fonttools brotli -i https://pypi.org/simple
"""

import io
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = os.path.join(ROOT, "code")
SRC_FONT = os.path.join(ROOT, "_fontsrc", "NotoSerifCJKsc-Regular.otf")
OUT_FONT = os.path.join(CODE, "assets", "NotoSerifSC-subset.woff2")

# 手写体：只给情书正文用（v1.7.9）。
# 源字体是马善政毛笔楷书（Google Fonts，SIL OFL 1.1）。
# 缺失时用下面这条重新下载（jsDelivr 墙内可用，Google Fonts 不可用）：
#
#   curl -L --retry 3 -o "_fontsrc/MaShanZheng-Regular.woff2" \
#     https://cdn.jsdelivr.net/npm/@fontsource/ma-shan-zheng@5.3.0/files/ma-shan-zheng-chinese-simplified-400-normal.woff2
#
# 想换手写体风格只改这两行 + base.css 的 @font-face 名。
# 另一款备选（行书、更潦草）：@fontsource/zhi-mang-xing，同样的路径。
SRC_HAND = os.path.join(ROOT, "_fontsrc", "MaShanZheng-Regular.woff2")
OUT_HAND = os.path.join(CODE, "assets", "LetterHand-subset.woff2")

# 跳过这些目录：第三方资料、运行时数据、上传的照片
SKIP_DIRS = {"awesome-design-md-main", "data", "uploads", "node_modules", ".git"}

# 常用字安全表。用户改文案时能接住大部分新增字符。
SAFETY = (
    # 最高频字
    "的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自"
    "会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看"
    "学进种将还分此心前面又定见只主没公从问但门无明力思理点间情知性本实前些很最把被让给"
    "样别东西南北内外表声名色高长写走带住让找感意义路风花水山海云雨雪光夜早前"
    # 生日与情感
    "生日快乐愿望蛋糕蜡烛火焰吹灭许祝幸福温暖陪伴想念恋爱喜欢记忆忘记记得珍重"
    "轻重点亮惊喜礼物秘密信件署名写下全文直接看完愿你想要得到永远一直辛苦新年岁"
    # 旅行
    "旅行足迹照片相册城市景区地方景点地图时间线起点终点跨越公里段个景点"
    "机场车站酒店民宿海边沙滩日出日落古镇街道巷子步行"
    # 界面
    "这个页面需要开启才能打开如果还是这样多半是目录没有完整上传刷新一次先"
    "保存取消确定编辑删除添加修改关闭返回上一地下一步完成提交加载中请稍候"
    "提示注意错误成功失败重试请选择输入口令密码答案今天什么日子月份日期四位数字"
    "还没有任何记录补上一段旅行的名字备注标签添加照片拖到此处或者点击选择"
    "登录退出管理员视图时间线地图切换主题配色日间夜间音乐播放暂停静音声音"
    "直接看全文准备好了开始跳过继续下一步刮开涂层面纱拼图打乱重来"
    # 标点与符号
    "，。！？、；：（）《》〈〉「」『』【】…—～·　“”‘’·％℃°"
    "0123456789"
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    ".,!?;:'\"()[]{}<>@#$&*+-=/_\\|~^%"
    "·×÷±≥≤≠→←↑↓∞"
)


def strip_js(src):
    """去掉 JS 里的注释与字符串以外的内容？

    其实不用那么精细：代码里的标识符全是 ASCII，对中文字符集没有贡献。
    真正需要剔除的是**注释** —— 这个项目的注释是中文写的，量很大，
    但注释永远不会渲染。所以只要把注释干掉即可。
    """
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        # 行注释
        if c == "/" and nxt == "/":
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue

        # 块注释
        if c == "/" and nxt == "*":
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue

        # 字符串：原样保留（这里才是有意义的文案）
        if c in "\"'`":
            quote = c
            out.append(c)
            i += 1
            while i < n:
                if src[i] == "\\":
                    out.append(src[i:i + 2])
                    i += 2
                    continue
                out.append(src[i])
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            continue

        out.append(c)
        i += 1
    return "".join(out)


def strip_html(src):
    """只保留 HTML 的文本节点：去掉 script、style、注释和标签。"""
    src = re.sub(r"<script\b.*?</script>", " ", src, flags=re.S | re.I)
    src = re.sub(r"<style\b.*?</style>", " ", src, flags=re.S | re.I)
    src = re.sub(r"<!--.*?-->", " ", src, flags=re.S)
    src = re.sub(r"<[^>]+>", " ", src)
    return src


def collect_chars():
    """扫描 code/ 下真正会被渲染的文字，收集字符集。

    注意：只取「会显示出来」的字。源码注释里的大量中文不参与 ——
    这是把子集从 204KB 压下来的关键。

    另外也扫 demo/trips.sample.json：示例行程里的景点名（栖湖、灯笼巷……）
    导入后会变成 code/data/trips.json 里的地名，那些字同样会渲染出来，
    而 data/ 目录是被跳过扫描的。
    """
    found = set()

    for dirpath, dirnames, filenames in os.walk(CODE):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in {".js", ".html"}:
                continue
            p = os.path.join(dirpath, fn)
            try:
                t = io.open(p, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue

            if ext == ".js":
                t = strip_js(t)
            else:
                t = strip_html(t)

            # 去掉 BOM：它不是会被渲染的字符
            found.update(t.lstrip("\ufeff"))

    # 示例行程数据（导入后即渲染）
    demo = os.path.join(ROOT, "demo", "trips.sample.json")
    if os.path.exists(demo):
        try:
            found.update(io.open(demo, encoding="utf-8").read())
        except (UnicodeDecodeError, OSError):
            pass

    return found


def letter_chars():
    """情书幕真正用到的字：正文 + 署名 + 收信人 + 跳过按钮。

    ⚠️ 手写体**不能**带上整份安全表：马善政毛笔楷笔画复杂，
    889 字的子集要 169KB，而只取这一幕的字只要 60KB ——
    它只在情书一幕用，多出来的 900 字永远渲染不到。
    代价是改文案后这里要重跑（脚本会自动跟着 config.js 走）。
    """
    s = io.open(os.path.join(CODE, "js", "config.js"), encoding="utf-8").read()
    m = re.search(r"    text: `([\s\S]*?)`,\n  \},", s)
    body = m.group(1) if m else ""
    extra = ""
    for key in ("signature", "herName", "toLabel", "skip", "openHint"):
        mm = re.search(key + r":\s*'([^']*)'", s)
        if mm:
            extra += mm.group(1)
    return set(body + extra) | set("：，。！？、“”‘’…— ")


def main():
    if not os.path.exists(SRC_FONT):
        print("找不到源字体：" + SRC_FONT)
        return 2

    actual = collect_chars()
    text = "".join(sorted(actual | set(SAFETY)))
    # 去掉控制字符
    text = "".join(c for c in text if c.isprintable() or c == " ")

    chars_file = os.path.join(ROOT, "_fontchars.txt")
    io.open(chars_file, "w", encoding="utf-8").write(text)

    os.makedirs(os.path.dirname(OUT_FONT), exist_ok=True)

    cmd = [
        sys.executable, "-m", "fontTools.subset", SRC_FONT,
        "--text-file=" + chars_file,
        "--output-file=" + OUT_FONT,
        "--flavor=woff2",
        "--no-hinting",
        # CFF 字体去掉子程序（subroutine）能省约 12%：实测 118.4KB → 103.9KB
        "--desubroutinize",
        # 保留 kerning：拉丁字距靠它，只省 2.6KB 不值得丢
        "--layout-features=kern,liga",
        "--drop-tables+=DSIG",
    ]
    r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")

    # ---- 手写体（情书正文专用）----
    hand_report = ""
    if os.path.exists(SRC_HAND):
        hchars = letter_chars()
        hchars_file = os.path.join(ROOT, "_fonthandchars.txt")
        io.open(hchars_file, "w", encoding="utf-8").write("".join(sorted(hchars)))
        cmd_hand = [
            sys.executable, "-m", "fontTools.subset", SRC_HAND,
            "--text-file=" + hchars_file,
            "--output-file=" + OUT_HAND,
            "--flavor=woff2",
            "--no-hinting",
            "--layout-features=",     # 中文不需要 kern/liga，留着反而多几 KB
            "--drop-tables+=DSIG",
        ]
        r2 = subprocess.run(cmd_hand, capture_output=True, encoding="utf-8",
                            errors="replace")
        hand_report = "手写体字符数: %d / 返回码 %d" % (len(hchars), r2.returncode)
        if r2.returncode != 0:
            hand_report += "\n手写体 stderr: " + (r2.stderr or "")[-800:]
        elif os.path.exists(OUT_HAND):
            hand_report += " / %.1f KB" % (os.path.getsize(OUT_HAND) / 1024)
            # 缺字检查：手写体缺字会静默退到衬线，一封信混两种字
            from fontTools.ttLib import TTFont
            cmap = set(TTFont(OUT_HAND).getBestCmap().keys())
            miss = sorted(c for c in hchars if not c.isspace() and ord(c) not in cmap)
            hand_report += "\n手写体缺字: " + ("".join(miss) if miss else "无")
    else:
        hand_report = "跳过手写体：找不到 " + SRC_HAND

    lines = [
        "源字体: %.2f MB" % (os.path.getsize(SRC_FONT) / 1024 / 1024),
        "实际用到的字符种类: %d" % len(actual),
        "字符表总计（含安全表）: %d" % len(text),
        "pyftsubset 返回码: %d" % r.returncode,
    ]
    if r.returncode != 0:
        lines.append("stderr: " + (r.stderr or "")[-1500:])
    elif os.path.exists(OUT_FONT):
        kb = os.path.getsize(OUT_FONT) / 1024
        lines.append("产出: %.1f KB" % kb)
        lines.append("产出路径: " + OUT_FONT)

    io.open(os.path.join(ROOT, "_fontsub.txt"), "w", encoding="utf-8").write(
        "\n".join(lines) + "\n" + hand_report + "\n")
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
