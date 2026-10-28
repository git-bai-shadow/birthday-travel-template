# -*- coding: utf-8 -*-
"""抹掉 GLB 贴图上的文字，重打包成新的 GLB。

背景：AI 生成的蛋糕模型，贴图里往往带着「XXX生日快乐」这类巧克力字。
模型要开源共享时，这些字就是别人的隐私，必须去掉 —— 但几何网格本身没问题。

做法：只改贴图（baseColor 那张 PNG），把文字区域用邻域中值「抹平」，
再把新的 PNG 塞回 GLB 的 BIN chunk。网格、材质、法线一律不动。

用法：
    python tools/strip-cake-text.py <输入.glb> <输出.glb> <x0> <y0> <x1> <y1>

坐标是贴图像素（贴图 2048×2048），可以用 PIL 裁剪出来目测定位。
注意：文字在 UV 图集里通常是**倒置/镜像**的，定位时以裁剪图为准。
"""

import json
import os
import struct
import sys

from PIL import Image, ImageFilter

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read_glb(path):
    data = open(path, 'rb').read()
    magic, ver, total = struct.unpack_from('<III', data, 0)
    if magic != GLB_MAGIC or ver != 2:
        raise SystemExit('不是 GLB v2：' + path)
    off, js, bin_ = 12, None, None
    while off < total:
        clen, ctype = struct.unpack_from('<II', data, off)
        payload = data[off + 8:off + 8 + clen]
        if ctype == CHUNK_JSON:
            js = json.loads(payload.decode('utf-8'))
        elif ctype == CHUNK_BIN:
            bin_ = payload
        off += 8 + clen
    if js is None or bin_ is None:
        raise SystemExit('GLB 结构异常：缺 JSON 或 BIN chunk')
    return js, bytearray(bin_)


def write_glb(path, js, bin_):
    js['buffers'][0]['byteLength'] = len(bin_)
    jbytes = json.dumps(js, separators=(',', ':')).encode('utf-8')
    jbytes += b' ' * ((4 - len(jbytes) % 4) % 4)
    bin_padded = bytes(bin_) + b'\x00' * ((4 - len(bin_) % 4) % 4)

    out = bytearray()
    out += struct.pack('<III', GLB_MAGIC, 2, 12 + 8 + len(jbytes) + 8 + len(bin_padded))
    out += struct.pack('<II', len(jbytes), CHUNK_JSON) + jbytes
    out += struct.pack('<II', len(bin_padded), CHUNK_BIN) + bin_padded
    open(path, 'wb').write(out)
    return len(out)


def extract_image(js, bin_, index=0):
    img = js['images'][index]
    bv = js['bufferViews'][img['bufferView']]
    off = bv.get('byteOffset', 0)
    return bytes(bin_[off:off + bv['byteLength']]), img


def put_image(js, bin_, index, blob):
    """把新图写回 BIN chunk（放在末尾，简单对齐 4 字节）。"""
    img = js['images'][index]
    bv_idx = img['bufferView']
    bv = js['bufferViews'][bv_idx]
    old = bv.get('byteOffset', 0)
    old_len = bv['byteLength']
    # 抹掉旧数据：置零并从 buffer 末尾接新数据
    for i in range(old, min(old + old_len, len(bin_))):
        bin_[i] = 0
    new_off = len(bin_)
    bin_.extend(blob)
    pad = (4 - len(blob) % 4) % 4
    bin_.extend(b'\x00' * pad)
    bv['byteOffset'] = new_off
    bv['byteLength'] = len(blob)
    if 'target' in bv:
        bv.pop('target', None)
    return new_off


def inpaint_text(im, box, threshold=205):
    """把 box 内的深色文字抹掉。

    做法：**按行**取该行「亮像素」（背景）的 RGB 中位数，
    把行内的深色像素全部替换成它。
    —— 不用模糊：中值核小于笔画宽度时抹不掉字，按行回填能整段抹平，
    同时保留这一行的底色明暗（牌子的横向渐变不会丢）。
    """
    x0, y0, x1, y1 = box
    px = im.load()
    global_bright = []
    for y in range(y0, y1):
        row = [px[x, y] for x in range(x0, x1)]
        brights = [p for p in row if sum(p) / 3 > threshold]
        if brights:
            global_bright.extend(brights)
    if not global_bright:
        return im
    fallback = tuple(int(sum(c[i] for c in global_bright) / len(global_bright)) for i in range(3))

    for y in range(y0, y1):
        row = [px[x, y] for x in range(x0, x1)]
        brights = [p for p in row if sum(p) / 3 > threshold]
        if len(brights) < 8:                      # 亮像素太少就用整体背景色
            fill = fallback
        else:
            fill = tuple(int(sum(p[i] for p in brights) / len(brights)) for i in range(3))
        for i, p in enumerate(row):
            if sum(p) / 3 <= threshold:
                px[x0 + i, y] = fill
    return im


def inpaint_global(im, dark_thr=160, bright_thr=170):
    """全局抹掉「亮底上的细笔画」。

    为什么需要全局模式：AI 生成的模型贴图是一张 **UV 图集**，
    同一块牌子可能在图集里出现多次、还带旋转（正着的、倒着的、侧着的），
    逐个找坐标不现实。

    判据：暗像素 + 不属于大块暗区（腐蚀后消失）+ 周围 13px 内有亮背景
    → 这正是「写在白牌上的字」的形状；大块巧克力、草莓不会命中。
    代价：草莓的小表情、奶油上的笑脸这类细线条也会被抹平（可接受）。
    """
    g = im.convert('L')
    W, H = g.size
    dark = Image.new('L', (W, H), 0)
    bright = Image.new('L', (W, H), 0)
    gd, bd = dark.load(), bright.load()
    gp = g.load()
    for y in range(H):
        for x in range(W):
            v = gp[x, y]
            if v < dark_thr:
                gd[x, y] = 255
            if v > bright_thr:
                bd[x, y] = 255
    core = dark.filter(ImageFilter.MinFilter(9))        # 厚块暗区的核心
    near_bright = bright.filter(ImageFilter.MaxFilter(13))  # 附近有亮底
    cd, cb = core.load(), near_bright.load()
    px = im.load()
    hits = 0
    for y in range(H):
        for x in range(W):
            if gd[x, y] and not cd[x, y] and cb[x, y]:
                # 用周围亮像素的中位色替换
                rs, gs, bs = [], [], []
                for dy in range(-6, 7, 2):
                    for dx in range(-6, 7, 2):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < W and 0 <= yy < H:
                            p = px[xx, yy]
                            if sum(p) / 3 > bright_thr:
                                rs.append(p[0]); gs.append(p[1]); bs.append(p[2])
                if rs:
                    px[x, y] = (sorted(rs)[len(rs)//2], sorted(gs)[len(gs)//2], sorted(bs)[len(bs)//2])
                    hits += 1
    print('  抹掉细笔画像素 %d 个' % hits)
    return im


def main():
    if len(sys.argv) < 7:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    box = tuple(int(v) for v in (sys.argv[3:7] if len(sys.argv) >= 7 else ['0','0','0','0']))
    # 阈值：低于这个亮度算「字」。越大抹得越狠（连抗锯齿的浅边一起），
    # 但太大会把牌子本身的浅色一起吃掉。
    global_mode = '--global' in sys.argv
    nums = [a for a in sys.argv[3:] if a.lstrip('-').isdigit()]
    threshold = int(nums[4]) if len(nums) > 4 else 205

    js, bin_ = read_glb(src)
    blob, img = extract_image(js, bin_)
    ext = '.png' if 'png' in img.get('mimeType', '') else '.jpg'
    tmp = os.path.join(os.path.dirname(os.path.abspath(dst)), '_strip_tmp' + ext)
    open(tmp, 'wb').write(blob)

    im = Image.open(tmp).convert('RGB')
    print('贴图尺寸:', im.size)
    if global_mode:
        inpaint_global(im)
    else:
        inpaint_text(im, box, threshold)
    im.save(tmp, 'PNG' if ext == '.png' else 'JPEG',
            optimize=True, **({'quality': 92} if ext == '.jpg' else {}))
    new_blob = open(tmp, 'rb').read()
    os.remove(tmp)

    put_image(js, bin_, 0, new_blob)
    size = write_glb(dst, js, bin_)
    print('已写出: %s (%.1f MB)' % (dst, size / 1024.0 / 1024.0))


if __name__ == '__main__':
    main()
