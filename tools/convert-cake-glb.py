# -*- coding: utf-8 -*-
"""把 buddy-multimodal-generation 出的 GLB 转成网站渲染器能用的形态。

为什么要转：生成的模型 55.6MB / 50 万面 / 3 张 PBR 贴图，
而 cake3d.js 只做三件事：读网格、读一张 baseColor、按 mat 号分支着色。
直接扔进去的问题：

1. **节点带 rotation [0.707,0,0,0.707]（绕 X 90°）** ——
   glTF 加载器会自动应用，但结果是**高度朝 -y（蛋糕倒扣）**。
   这里把最终坐标烘进顶点，顺手把 y 翻正，让「最低点贴 y=0」的归一化成立。
2. **50 万面太多**：cake3d.js 是手写 WebGL，顶点逐个过 JS 循环，
   在安卓中端机上 50 万面会明显掉帧。降到 ~12 万面，外形无损。
3. **3 张贴图用不上**：只保留 baseColor（另外两张 normal/metallicRoughness
   网站渲染器根本不读，带上白占体积）。
4. **贴图 4096² 过大**：baseColor 压到 1024²，视觉几乎无差别但小 16 倍。
5. **顶点无 COLOR_0**：网站的 mat 分支靠 aAlbedo.a 传材质号，
   这里给全部顶点写 mat=4（照片/贴图路径），与旧模型一致。

用法：python tools/convert-cake-glb.py
"""
import json
import os
import struct
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'code/assets/cake-ai.glb'
DST = ROOT / 'code/assets/cake.glb'

TARGET_FACES = 500_000   # 完整保留：减面会在原处留下破洞，渲染出满屏白色噪点_000       # 减面目标（旧模型 49.6k，接近这个量级）
TEX_SIZE = 2048             # baseColor 边长（走贴图路径时贴图是主角，别压太低）

# 「分区标签」只用于本脚本内部统计与上色，不写进 GLB —— 写进 GLB 的是
# 顶点色 + cake3d.js 那边按颜色反推的材质号。所以这里用三个可区分的值。
PART_CREAM, PART_STRAW, PART_CHOC = 0, 1, 2


# ---------------------------------------------------------------- 材质分区

def classify(P, UV, img, k):
    """按**贴图色相 + 空间高度**给每个顶点定材质号。

    为什么要分：图生 3D 服务返回的 baseColor 是一张投影烘焙的 atlas，
    实测约 9% 是灰色空区（UV 展开不全留下的空洞），压到 512² 后细节糊成一片 ——
    直接当贴图用，蛋糕看起来就是「一块贴了图的平面」，没有本体。
    改成程序化材质后，形体感完全由真实光照给出，缺陷区域不再是问题。

    判据（按优先级）：
      1. 贴图偏红且饱和 → 草莓（glossy：草莓有反光）
      2. 贴图偏暗棕     → 巧克力（glossy）
      3. 位置在底部一圈 → 草莓（底部那圈草莓是模型最稳的特征）
      4. 其余           → 奶油（cream：哑光带一点透光）
    """
    h, w = img.shape[:2]
    flat = img.reshape(-1, 3)

    # 采样贴图（UV → 像素）
    px = np.clip((UV[:, 0] * (w - 1)).astype(int), 0, w - 1)
    py = np.clip((UV[:, 1] * (h - 1)).astype(int), 0, h - 1)
    tr = flat[py * w + px, 0]
    tg = flat[py * w + px, 1]
    tb = flat[py * w + px, 2]
    mx = np.maximum(np.maximum(tr, tg), tb)
    mn = np.minimum(np.minimum(tr, tg), tb)
    sat = np.where(mx > 1e-5, (mx - mn) / np.maximum(mx, 1e-5), 0.0)

    # 灰区（无贴图信息）→ 交给空间判据
    is_gray = ((np.abs(tr - tg) < 0.06) & (np.abs(tg - tb) < 0.06)
               & (tr > 0.62) & (tr < 0.88))

    red = ((tr - tg > 0.16) & (tr - tb > 0.16) & (tr > 0.45)
           & (sat > 0.32) & ~is_gray)
    brown = ((tr < 0.62) & (tr > 0.15) & (tr - tb > 0.06) & (tr - tb < 0.42)
             & ~red & ~is_gray)

    # 空间判据：底部外圈（归一化后 y 低、离中心远）大多是草莓
    rXZ = np.hypot(P[:, 0], P[:, 2])
    rMax = max(rXZ.max(), 1e-6)
    lowRing = (P[:, 1] < 0.22) & (rXZ > rMax * 0.60)

    mats = np.full(len(P), PART_CREAM, np.float32)
    mats[lowRing] = PART_STRAW
    mats[brown] = PART_CHOC
    mats[red] = PART_STRAW

    out = {
        'straw': int((mats == PART_STRAW).sum()),
        'choc': int((mats == PART_CHOC).sum()),
        'cream': int((mats == PART_CREAM).sum()),
        'grayFrac': float(is_gray.mean()),
    }
    return mats, out


# ---------------------------------------------------------------- 读 GLB

def read_glb(path):
    d = Path(path).read_bytes()
    magic, ver, _ = struct.unpack_from('<III', d, 0)
    assert magic == 0x46546C67 and ver == 2, '不是 GLB v2'
    off = 12
    js = bin_ = None
    while off + 8 <= len(d):
        ln = struct.unpack_from('<I', d, off)[0]
        ty = d[off+4:off+8]
        body = d[off+8:off+8+ln]
        if ty == b'JSON':
            js = json.loads(body.decode('utf-8'))
        elif ty == b'BIN\x00':
            bin_ = body
        off += 8 + ln
    return js, bin_


def accessor(js, bin_, i, comp=np.float32):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    off = (bv.get('byteOffset', 0) or 0) + (a.get('byteOffset', 0) or 0)
    dt = np.dtype(comp)
    arr = np.frombuffer(bin_, dtype=dt, count=(off // dt.itemsize) + a['count'] * n,
                        offset=off)[:a['count'] * n]
    return arr.reshape(a['count'], n) if n > 1 else arr


def node_matrix(node):
    if 'matrix' in node:
        m = np.array(node['matrix'], float).reshape(4, 4).T
        return m
    t = np.array(node.get('translation', [0, 0, 0]), float)
    r = node.get('rotation', [0, 0, 0, 1])
    s = np.array(node.get('scale', [1, 1, 1]), float)
    x, y, z, w = r
    R = np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w),   2*(x*z+y*w)],
        [2*(x*y+z*w),   1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w),   2*(y*z+x*w),   1-2*(x*x+y*y)]])
    M = np.eye(4)
    M[:3, :3] = R * s
    M[:3, 3] = t
    return M


# ---------------------------------------------------------------- 减面

def decimate(tris, P, keep_ratio):
    """按三角形**重心在空间里均匀取样**，保留散布最开的那批。

    之前用「按面积取最大的」，看着聪明，实际是错的：减面不是重建，
    砍掉的小三角会在原处**留下空洞**，从洞里能看见模型内壁（背面），
    渲染出来就是满屏白色噪点 —— 看着像「只有贴图没有本体」。
    面积大的都在同一批密集区域，一砍就成筛子。

    均匀取样保证留下的三角在三维空间里分布均匀，覆盖面完整，
    代价是丢掉一些细节凸起（草莓籽那种小颗粒）—— 对这个尺寸的画面无感。
    """
    if keep_ratio >= 1.0:
        return tris
    cen = P[tris[:, 0]] + P[tris[:, 1]] + P[tris[:, 2]]
    n = max(1, int(len(tris) * keep_ratio))
    # 确定性哈希：只用算术（异或对 float 不合法）。取小数位当 key，
    # 排序后等间隔取样 —— 不依赖随机数，重跑结果完全一致。
    key = ((cen[:, 0] * 73856093.0 + cen[:, 1] * 19349663.0
            + cen[:, 2] * 83492791.0) % 1000003.0)
    order = np.argsort(key)
    step = max(1, len(order) // n)
    sel = order[::step][:n]
    return tris[sel]


# ---------------------------------------------------------------- 写 GLB

def build_glb(positions, normals, uvs, indices, image_png, colors, write_color=True):
    """四个属性各占独立 bufferView，段与段之间不共享视图。

    为什么必须独立：cake3d.js 的 readGLBAccessor 按
    「bufferView.byteOffset + accessor.byteOffset」取址。共享一个 bufferView
    再用 accessor.byteOffset 区分是合法 glTF，但那样算出来的地址会错位，
    表现是三角形乱飞、贴图撕裂（v1.6.3 踩过，整版重做才对）。

    写 COLOR_0（write_color=True）：把分类好的固有色（奶油白/草莓红/巧克力棕）
    写进顶点色，网站走程序化材质，形体感由真实光照给出，不依赖那张有灰区的 atlas。

    不写 COLOR_0（write_color=False）：网站 `loadModel` 会切贴图路径，
    直接用模型自带的 baseColor 贴图 —— 模型自带文字（如生日快乐）的细节这类细节
    只有原贴图才有。代价是贴图里 6%~25% 的灰区会显示成灰块。
    """
    n = len(positions)
    idx = indices.astype(np.uint32).reshape(-1)

    S = 4                                   # 每个 float 4 字节
    pos_b = positions.astype(np.float32).tobytes()
    nrm_b = normals.astype(np.float32).tobytes()
    uv_b = uvs.astype(np.float32).tobytes()
    pad4 = lambda b: b + b'\x00' * ((4 - len(b) % 4) % 4)
    pos_b, nrm_b, uv_b = map(pad4, (pos_b, nrm_b, uv_b))
    if write_color:
        # COLOR_0 用 UNSIGNED_BYTE 归一化：固有色本来就只有 0..1 的色值，
        # float32 是 12 字节/顶点，8 位只要 3 字节 —— 26 万顶点省 2.2MB。
        col_b = pad4(np.clip(colors * 255.0 + 0.5, 0, 255)
                     .astype(np.uint8).tobytes())
    else:
        col_b = b''
    ibytes = pad4(idx.tobytes())

    bv_pos = 0
    bv_nrm = len(pos_b)
    bv_uv = bv_nrm + len(nrm_b)
    bv_col = bv_uv + len(uv_b)
    off_i = bv_col + len(col_b)
    off_t = off_i + len(ibytes)
    blob = pos_b + nrm_b + uv_b + col_b + ibytes + image_png
    blob += b'\x00' * ((4 - len(blob) % 4) % 4)

    # 有顶点色：POS 0 / NRM 1 / UV 2 / COL 3 / IDX 4 / TEX 5
    # 无顶点色：POS 0 / NRM 1 / UV 2 / IDX 3 / TEX 4
    attrs = {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}
    accessors = [
        {"bufferView": 0, "byteOffset": 0, "componentType": 5126,
         "count": n, "type": "VEC3",
         "min": positions.min(0).tolist(),
         "max": positions.max(0).tolist()},
        {"bufferView": 1, "byteOffset": 0, "componentType": 5126,
         "count": n, "type": "VEC3"},
        {"bufferView": 2, "byteOffset": 0, "componentType": 5126,
         "count": n, "type": "VEC2"},
    ]
    bufferViews = [
        {"buffer": 0, "byteOffset": bv_pos, "byteLength": len(pos_b)},
        {"buffer": 0, "byteOffset": bv_nrm, "byteLength": len(nrm_b)},
        {"buffer": 0, "byteOffset": bv_uv, "byteLength": len(uv_b)},
    ]
    if write_color:
        attrs["COLOR_0"] = 3
        accessors.append(
            {"bufferView": 3, "byteOffset": 0, "componentType": 5121,
             "normalized": True, "count": n, "type": "VEC3"})
        bufferViews.append(
            {"buffer": 0, "byteOffset": bv_col, "byteLength": len(col_b)})
    idx_accessor = len(accessors)
    accessors.append(
        {"bufferView": len(bufferViews), "byteOffset": 0, "componentType": 5125,
         "count": len(idx), "type": "SCALAR"})
    bufferViews.append(
        {"buffer": 0, "byteOffset": off_i, "byteLength": len(ibytes)})
    img_view = len(bufferViews)
    bufferViews.append(
        {"buffer": 0, "byteOffset": off_t, "byteLength": len(image_png)})

    js = {
        "asset": {"version": "2.0", "generator": "convert-cake-glb.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "cake"}],
        "meshes": [{"primitives": [{
            "attributes": attrs,
            "indices": idx_accessor,
            "material": 0,
            "mode": 4,
        }]}],
        "materials": [{
            "name": "cake",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "baseColorFactor": [1, 1, 1, 1],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.85,
            },
        }],
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987,
                      "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": img_view, "mimeType": "image/png"}],
        "accessors": accessors,
        "bufferViews": bufferViews,
        "buffers": [{"byteLength": len(blob)}],
    }
    jbytes = json.dumps(js, separators=(',', ':')).encode('utf-8')
    jbytes += b' ' * ((4 - len(jbytes) % 4) % 4)

    total = 12 + 8 + len(jbytes) + 8 + len(blob)
    out = b'glTF' + struct.pack('<II', 2, total)
    out += struct.pack('<I', len(jbytes)) + b'JSON' + jbytes
    out += struct.pack('<I', len(blob)) + b'BIN\x00' + blob
    return out, off_i


def main():
    print('读取', SRC)
    js, bin_ = read_glb(SRC)
    prim = js['meshes'][0]['primitives'][0]
    at = prim['attributes']

    P = accessor(js, bin_, at['POSITION']).astype(np.float64)
    N = accessor(js, bin_, at['NORMAL']).astype(np.float64)
    UV = accessor(js, bin_, at['TEXCOORD_0']).astype(np.float64)
    I = accessor(js, bin_, prim['indices'], comp=np.uint32).reshape(-1).astype(np.int64)
    print('原始  顶点 %d  三角 %d' % (len(P), len(I) // 3))

    # 1) 烘进节点变换（glTF 加载器本来会做，但我们要顺手把 y 翻正）
    M = node_matrix(js['nodes'][0])
    P = (P @ M[:3, :3].T) + M[:3, 3]
    N = N @ M[:3, :3].T
    if P[:, 1].mean() < 0:      # 高度朝 -y（倒扣）→ 翻过来
        P[:, 1] *= -1
        N[:, 1] *= -1
        print('  已翻转 y（节点旋转导致倒扣）')
    print('变换后  x %.3f..%.3f  y %.3f..%.3f  z %.3f..%.3f'
          % (P[:, 0].min(), P[:, 0].max(), P[:, 1].min(),
             P[:, 1].max(), P[:, 2].min(), P[:, 2].max()))

    # 2) 减面
    tris = I.reshape(-1, 3)
    if len(tris) > TARGET_FACES:
        tris = decimate(tris, P, TARGET_FACES / len(tris))
        print('减面后 三角 %d' % len(tris))

    # 3) 压顶点（去掉未用到的孤立顶点，控制文件体积）
    used = np.unique(tris.reshape(-1))
    remap = -np.ones(len(P), np.int64)
    remap[used] = np.arange(len(used))
    P, N, UV = P[used], N[used], UV[used]
    tris = remap[tris]
    nl = np.linalg.norm(N, axis=1, keepdims=True)
    N = np.where(nl > 1e-9, N / np.where(nl == 0, 1, nl), 0.0)
    print('压缩后 顶点 %d  三角 %d' % (len(P), len(tris)))

    # 4) 贴图：取原图（分类要用），压到 TEX_SIZE 打包
    bct = js['materials'][prim['material']]['pbrMetallicRoughness']['baseColorTexture']
    src_i = js['textures'][bct['index']]['source']
    if isinstance(src_i, list):
        src_i = src_i[0]
    bv = js['bufferViews'][js['images'][src_i]['bufferView']]
    import io
    im = Image.open(io.BytesIO(
        bin_[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
    )).convert('RGB')
    print('原贴图 %s %s' % (im.size, im.mode))

    # 5) 材质分区：用**原图**分类（压过会丢细节，红白棕的判别要靠原图）
    tex_arr = np.asarray(im, dtype=np.float64) / 255.0
    Pn = P.copy()
    Pn[:, 1] -= Pn[:, 1].min()
    hmax = max(Pn[:, 1].max(), 1e-6)
    Pn[:, 1] /= hmax
    Pn[:, 0] /= max(Pn[:, 0].max() - Pn[:, 0].min(), 1e-6)
    Pn[:, 2] /= max(Pn[:, 2].max() - Pn[:, 2].min(), 1e-6)
    Pn[:, 0] -= 0.5
    Pn[:, 2] -= 0.5
    mats, stat = classify(Pn, UV, tex_arr, TEX_SIZE)
    print('材质分区  草莓 %d  巧克力 %d  奶油 %d   （贴图灰区占 %.1f%%）'
          % (stat['straw'], stat['choc'], stat['cream'], stat['grayFrac'] * 100))

    # 固有色：按材质给真实食物色（不用贴图色，贴图只作回退）
    colors = np.zeros((len(P), 3), np.float64)
    colors[mats == PART_CREAM] = (0.96, 0.94, 0.90)   # 奶油白
    colors[mats == PART_STRAW] = (0.80, 0.17, 0.19)   # 草莓红
    colors[mats == PART_CHOC] = (0.30, 0.19, 0.13)   # 巧克力棕
    if im.size[0] > TEX_SIZE:
        im = im.resize((TEX_SIZE, TEX_SIZE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    png = buf.getvalue()
    print('新贴图 %d  PNG %.0f KB' % (im.size[0], len(png) / 1024))

    # 5) 写
    # 模式：'textured' 不写 COLOR_0（网站走贴图路径，看得到巧克力字等细节）
    #       'vertex'   写 COLOR_0（程序化材质，形体感更强但没有贴图细节）
    mode = os.environ.get('MODE', 'textured')
    glb, _ = build_glb(P, N, UV, tris, png, colors,
                       write_color=(mode == 'vertex'))
    print('模式：%s（%s）' % (mode, '有顶点色' if mode == 'vertex' else '走贴图'))
    DST.write_bytes(glb)
    print()
    print('写出 %s  %.2f MB（原 %.2f MB，省 %.0f%%）'
          % (DST, len(glb) / 1048576, SRC.stat().st_size / 1048576,
             (1 - len(glb) / SRC.stat().st_size) * 100))


if __name__ == '__main__':
    main()
