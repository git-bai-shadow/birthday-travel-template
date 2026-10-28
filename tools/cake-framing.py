# -*- coding: utf-8 -*-
"""复算蛋糕在画布上的投影范围，定位左右截断。

不用浏览器：直接按 cake3d.js 的相机/投影公式算顶点投影，
再统计「有多少比例的顶点落在画布外」。
"""
import struct
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def read_glb(path):
    d = Path(path).read_bytes()
    off = 12
    js = bin_ = None
    while off + 8 <= len(d):
        ln = struct.unpack_from('<I', d, off)[0]
        ty = d[off + 4:off + 8]
        body = d[off + 8:off + 8 + ln]
        if ty == b'JSON':
            js = json.loads(body.decode('utf-8'))
        elif ty == b'BIN\x00':
            bin_ = body
        off += 8 + ln
    return js, bin_


def accessor(js, bin_, i, nc, comp=np.float32):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    dt = np.dtype(comp)
    arr = np.frombuffer(bin_, dtype=dt, count=(base // dt.itemsize) + a['count'] * nc,
                        offset=base)[:a['count'] * nc]
    return arr.reshape(-1, nc) if nc > 1 else arr


src = sys.argv[1] if len(sys.argv) > 1 else 'code/assets/cake.glb'
modelScale = float(os.environ.get('SCALE', '1'))
print('读取', src)
js, bin_ = read_glb(src)
prim = js['meshes'][0]['primitives'][0]
at = prim['attributes']
P = accessor(js, bin_, at['POSITION'], 3).astype(np.float64)

# normalizeGeometry：XZ 居中 + 最低点贴 y=0 + 最长边缩到 target
sx = P[:, 0].min()
sz = P[:, 2].min()
cx = (P[:, 0].min() + P[:, 0].max()) / 2
cz = (P[:, 2].min() + P[:, 2].max()) / 2
longest = max(P[:, 0].max() - P[:, 0].min(), P[:, 1].max() - P[:, 1].min(),
              P[:, 2].max() - P[:, 2].min())
target = 1.30 * modelScale
s = target / longest
Q = np.stack([(P[:, 0] - cx) * s, (P[:, 1] - P[:, 1].min()) * s, (P[:, 2] - cz) * s], 1)
h = (P[:, 1].max() - P[:, 1].min()) * s
TARGET = [0.0, min(0.78, max(0.5, h * 0.5)), 0.0]

print('归一化：总高 %.3f  XZ ±%.3f  TARGET[1]=%.3f' % (h, target / 2, TARGET[1]))

# 蜡烛顶（程序化蜡烛大约 0.22 高，落在顶面）
W, H = 640, 380


def project(camDist, aspect, elev, W=W, H=H):
    eye = np.array([0.0, TARGET[1] + camDist * math.sin(elev),
                    camDist * math.cos(elev)])
    f = TARGET - eye
    f /= np.linalg.norm(f)
    sV = np.cross(f, [0, 1, 0])
    sV /= np.linalg.norm(sV)
    uV = np.cross(sV, f)
    R = np.stack([sV, uV, -f])
    cam = (Q - eye) @ R.T
    x, y, z = cam[:, 0], cam[:, 1], -cam[:, 2]
    t = 1.0 / math.tan(math.radians(30) / 2)
    ndcx = (t / aspect) * x / z
    ndcy = t * y / z
    return ((ndcx * 0.5 + 0.5) * W, (1 - (ndcy * 0.5 + 0.5)) * H, z)


print()
print('%-28s %-22s %s' % ('相机', '蛋糕 x 范围(px)', '判定'))
for camDist in (3.8, 4.15, 4.6, 5.0, 5.4, 5.8):
    for aspect, tag in ((640/380,'桌面宽'),(420/250,'收矮宽'),(382/344,'手机竖'),(300/380,'窄幅!'),(260/380,'很窄'),(200/380,'极窄')):
        px, py, pz = project(camDist, aspect, 0.22)
        x0, x1 = px.min(), px.max()
        ok = '完整' if (x0 > 4 and x1 < W-4) else '★ 截断'
        print('camDist %.2f %-8s aspect %.2f  x %5.0f..%5.0f / %d  左余%4.0f 右余%4.0f  %s'
              % (camDist, tag, aspect, x0, x1, W, x0, W-1-x1, ok))

# 用当前代码的公式复算：FILL 决定占画布比例
print()
print('=== FILL 对占比的影响（桌面 640x460）===')
halfFovY = 14.5*math.pi/180
MODEL_TOP = 0.796+0.30
MODEL_R = 0.650
TARGET1 = 0.500
for FILL in (0.70, 0.78, 0.84, 0.90):
    for W_,H_,tag in ((560,460,'桌面'),(382,340,'手机'),(500,300,'收矮'),(460,520,'窄高'),(420,540,'很窄高')):
        aspect=W_/H_
        needV = ((MODEL_TOP+0.04)/math.tan(halfFovY))/FILL
        needH = ((MODEL_R+0.03)/(math.tan(halfFovY)*aspect))/FILL
        d = max(needV,needH)+TARGET1*0.30
        px,py,pz = project(d, aspect, 0.22, W_, H_)
        x0,x1,y0,y1=px.min(),px.max(),py.min(),py.max()
        fit = '✓' if (x0>2 and x1<W_-2 and y0>2 and y1<H_-2) else '✗ 裁切'
        print('  FILL %.2f %-4s 占宽 %5.1f%%  占高 %5.1f%%  %s'%(FILL,tag,(x1-x0)/W_*100,(y1-y0)/H_*100,fit))
    print()
print('=== 旧：竖直方向是否切顶（各画布高）===')
for W_,H_,tag in ((640,380,'桌面'),(420,250,'收矮'),(382,344,'手机'),(900,300,'宽而矮')):
    for camDist in (3.8, 4.15, 4.6, 5.0, 5.4):
        px,py,pz = project(camDist, W_/H_, 0.22, W_, H_)
        ok = '✓' if (py.min()>2 and py.max()<H_-2) else '✗ 切顶'
        print('%-6s %dx%-4d camDist %.2f  y %5.0f..%5.0f / %d  %s'%(tag,W_,H_,camDist,py.min(),py.max(),H_,ok))
