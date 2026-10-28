# -*- coding: utf-8 -*-
"""把 AI 生成蛋糕模型上「刻着字的牌子」压平，去掉浮雕文字但保留牌子。

背景：3D 生成器做的蛋糕，牌子上「XXX生日快乐」是**几何浮雕**，
不是贴图 —— 刷贴图、抹像素都没用（实测：贴图刷成品红，字还在）。

做法：
  1. 并查集把网格分成若干连通壳（AI 生成的网格是碎壳的：
     每个草莓、每滴奶油、牌面、每个字各占一个壳）
  2. 在正前方牌子区里挑出这些壳，其中顶点最多的那个是**牌面**
  3. 用牌面自身的顶点拟合平面（PCA）
  4. 把其余壳（刻字的笔画）压到该平面上 → 字没了，牌子还在，也没有洞

用法：
    python tools/flatten-cake-sign.py <输入.glb> <输出.glb>
"""

import json
import struct
import sys

import numpy as np

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

# 牌子区（模型空间，AI 生成的这只蛋糕：正面、蛋糕体上部）
SIGN_BOX = dict(y0=0.365, y1=0.475, xabs=0.25, z0=0.15, z1=0.315)
MAX_SPAN = dict(x=0.46, y=0.115, z=0.135)
MIN_VERTS = 30


def read_glb(path):
    data = open(path, 'rb').read()
    magic, ver, total = struct.unpack_from('<III', data, 0)
    if magic != GLB_MAGIC:
        raise SystemExit('不是 GLB：' + path)
    off, js, bin_ = 12, None, None
    while off < total:
        clen, ctype = struct.unpack_from('<II', data, off)
        payload = data[off + 8:off + 8 + clen]
        if ctype == CHUNK_JSON:
            js = json.loads(payload.decode('utf-8'))
        elif ctype == CHUNK_BIN:
            bin_ = bytearray(payload)
        off += 8 + clen
    return js, bin_


def write_glb(path, js, bin_):
    js['buffers'][0]['byteLength'] = len(bin_)
    jb = json.dumps(js, separators=(',', ':')).encode('utf-8')
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    b = bytes(bin_) + b'\x00' * ((4 - len(bin_) % 4) % 4)
    out = bytearray(struct.pack('<III', GLB_MAGIC, 2, 12 + 8 + len(jb) + 8 + len(b)))
    out += struct.pack('<II', len(jb), CHUNK_JSON) + jb
    out += struct.pack('<II', len(b), CHUNK_BIN) + b
    open(path, 'wb').write(out)
    return len(out)


def get_accessor(js, bin_, i, dtype=np.float32):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    ncomp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]
    dt = np.dtype(dtype).newbyteorder('<')
    arr = np.frombuffer(bytes(bin_[base:base + a['count'] * ncomp * dt.itemsize]), dtype=dt)
    return arr.reshape(a['count'], ncomp) if ncomp > 1 else arr


def components(nV, I):
    parent = np.arange(nV)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for a, b in np.concatenate([I[:, [0, 1]], I[:, [1, 2]], I[:, [2, 0]]]):
        union(int(a), int(b))
    return np.array([find(i) for i in range(nV)])


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]

    js, bin_ = read_glb(src)
    prim = js['meshes'][0]['primitives'][0]
    at = prim['attributes']
    P = get_accessor(js, bin_, at['POSITION']).astype(np.float64)
    N = get_accessor(js, bin_, at['NORMAL']).astype(np.float64)
    UV = get_accessor(js, bin_, at['TEXCOORD_0']).astype(np.float64)
    I = get_accessor(js, bin_, prim['indices'], np.uint32).astype(np.int64).reshape(-1, 3)

    roots = components(len(P), I)
    uniq, counts = np.unique(roots, return_counts=True)

    shells = []
    for r, c in zip(uniq, counts):
        if c < MIN_VERTS:
            continue
        m = roots == r
        v = P[m]
        cen = v.mean(axis=0)
        span = v.max(axis=0) - v.min(axis=0)
        if (SIGN_BOX['y0'] <= cen[1] <= SIGN_BOX['y1'] and
                abs(cen[0]) <= SIGN_BOX['xabs'] and
                SIGN_BOX['z0'] <= cen[2] <= SIGN_BOX['z1'] and
                span[0] <= MAX_SPAN['x'] and span[1] <= MAX_SPAN['y'] and span[2] <= MAX_SPAN['z']):
            shells.append((int(c), m))
    if not shells:
        raise SystemExit('没找到牌子区的壳 —— 模型可能不是这个（调 SIGN_BOX）')
    shells.sort(key=lambda t: -t[0])
    print('牌子区 %d 个壳，牌面是顶点最多的那个（%d 顶点）' % (len(shells), shells[0][0]))

    face_mask = shells[0][1]
    face_v = P[face_mask]

    # 用牌面自身的顶点拟合平面（PCA）
    c0 = face_v.mean(axis=0)
    cov = np.cov((face_v - c0).T)
    vals, vecs = np.linalg.eigh(cov)
    nrm = vecs[:, np.argmin(vals)]           # 最小方差方向 = 平面法线
    nrm /= np.linalg.norm(nrm)
    if nrm @ np.array([0.0, 0.0, 1.0]) < 0:
        nrm = -nrm
    print('牌面平面: 法线 %s  厚度 %.4f' % (np.round(nrm, 3),
          float(((face_v - c0) @ nrm).max() - ((face_v - c0) @ nrm).min())))

    # 其余壳 = 刻字的笔画 → 压到牌面平面
    glyph_mask = np.zeros(len(P), dtype=bool)
    for c, m in shells[1:]:
        glyph_mask |= m
    d = (P - c0) @ nrm
    flat = glyph_mask & (np.abs(d) > 0.0015)
    print('压平笔画顶点 %d 个（凸出最大 %.4f）' % (flat.sum(), np.abs(d[flat]).max() if flat.any() else 0))

    P2 = P.copy()
    N2 = N.astype(np.float64).copy()
    UV2 = UV.copy()
    P2[flat] -= np.outer(d[flat], nrm)
    N2[flat] = nrm
    # ⚠️ 每个刻字都是独立的壳、也各自占一小块 UV（贴图上就是那些字）。
    # 压平几何还不够 —— 还得把它们的 UV 重映射到牌面那块干净的奶油色区域，
    # 否则压平的字仍会采样自己那块「写着字」的贴图。
    face_uv = UV[face_mask]
    clean_uv = np.median(face_uv, axis=0)
    UV2[flat] = clean_uv
    print('刻字 UV 已重映射到牌面干净点 u %.4f v %.4f' % (clean_uv[0], clean_uv[1]))

    def put(idx, arr):
        a = js['accessors'][idx]
        bv = js['bufferViews'][a['bufferView']]
        base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        dt = np.dtype(np.float32).newbyteorder('<')
        data = arr.astype(dt).tobytes()
        bin_[base:base + len(data)] = data

    put(at['POSITION'], P2)
    put(at['NORMAL'], N2)
    put(at['TEXCOORD_0'], UV2)

    size = write_glb(dst, js, bin_)
    print('已写出 %s (%.1f MB)' % (dst, size / 1024.0 / 1024.0))


if __name__ == '__main__':
    main()
