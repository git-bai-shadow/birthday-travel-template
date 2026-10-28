# -*- coding: utf-8 -*-
"""复算 cake3d.js 的相机与阴影片投影，定位接地阴影在屏幕上的实际位置。
纯数学，不开浏览器 —— 与 tools 里「验 GLB 无需浏览器」同一思路。"""
import struct, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'code/assets/cake.glb'

# ---------- 读 GLB ----------
data = RAW.read_bytes()
off = 12; js = None; bin_ = None
while off + 8 <= len(data):
    ln = struct.unpack_from('<I', data, off)[0]
    ty = data[off+4:off+8]
    if ty == b'JSON': js = json.loads(data[off+8:off+8+ln].decode('utf8'))
    elif ty == b'BIN\x00': bin_ = data[off+8:off+8+ln]
    off += 8 + ln

def acc(i):
    a = js['accessors'][i]; bv = js['bufferViews'][a['bufferView']]
    n = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    ct = {5126:'f',5123:'H',5125:'I'}[a['componentType']]
    sz = struct.struct.calcsize(ct) if False else struct.calcsize(ct)
    stride = bv.get('byteStride') or n*sz
    base = bv.get('byteOffset',0) + a.get('byteOffset',0)
    return [struct.unpack_from('<'+ct*n, bin_, base+k*stride) for k in range(a['count'])]

pr = js['meshes'][0]['primitives'][0]
pos = acc(pr['attributes']['POSITION'])

# ---------- normalizeGeometry(geo, 1.30 * modelScale) ----------
xs=[p[0] for p in pos]; ys=[p[1] for p in pos]; zs=[p[2] for p in pos]
s = 1.30 / max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs))
cx=(min(xs)+max(xs))/2; cz=(min(zs)+max(zs))/2
P=[((p[0]-cx)*s, (p[1]-min(ys))*s, (p[2]-cz)*s) for p in pos]
H = (max(ys)-min(ys))*s
TARGET = [0.0, min(0.78, max(0.5, H*0.5)), 0.0]

# ---------- resize(): camDist ----------
W, Hc = 640, 380          # canvas 属性尺寸（探针实测）
aspect = W / Hc
camDist = 4.15 if aspect < 0.9 else 3.8
elev = 0.22
eye = [0.0, TARGET[1] + camDist*math.sin(elev), camDist*math.cos(elev)]
fov = math.radians(30)

def sub(a,b): return [a[i]-b[i] for i in range(3)]
def norm(v):
    l=math.sqrt(sum(c*c for c in v)) or 1.0
    return [c/l for c in v]
def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def dot(a,b): return sum(a[i]*b[i] for i in range(3))

f = norm(sub(TARGET, eye))
up=[0,1,0]
sV = norm(cross(f, up))
uV = cross(sV, f)
view = [sV[0],sV[1],sV[2], -dot(sV,eye),
        uV[0],uV[1],uV[2], -dot(uV,eye),
        -f[0],-f[1],-f[2],  dot(f,eye),
        0,0,0,1]
t = 1.0/math.tan(fov/2)
proj = [t/aspect,0,0,0, 0,t,0,0, 0,0,(30+0.1)/(0.1-30),-1, 0,0,2*30*0.1/(0.1-30),0]

def project(pt):
    x,y,z = pt
    vx = view[0]*x+view[1]*y+view[2]*z+view[3]
    vy = view[4]*x+view[5]*y+view[6]*z+view[7]
    vz = view[8]*x+view[9]*y+view[10]*z+view[11]
    cx = proj[0]*vx
    cy = proj[5]*vy
    cw = -vz
    if cw <= 0: return None
    ndc_x = cx/cw; ndc_y = cy/cw
    return ( (ndc_x*0.5+0.5)*W, (1-(ndc_y*0.5+0.5))*Hc )

# ---------- 蛋糕实际投影范围 ----------
sx=[]; sy=[]
for p in P:
    r = project(p)
    if r: sx.append(r[0]); sy.append(r[1])
print('蛋糕投影包围盒  x %.0f..%.0f (%.0f..%.0f)   y %.0f..%.0f' %
      (min(sx),max(sx),min(sx),max(sx),min(sy),max(sy)))
print('  占画布宽 %.1f%%  高 %.1f%%' % ((max(sx)-min(sx))/W*100, (max(sy)-min(sy))/Hc*100))
print('  左右留白  左 %.0fpx  右 %.0fpx' % (min(sx), W-max(sx)))
print('  上下留白  上 %.0fpx  下 %.0fpx' % (min(sy), Hc-max(sy)))

# ---------- 阴影片 ----------
# sprite([0,0.030,0], size=[1.58,0.40], right=[1,0,0], up=[0,1,0])
print()
print('接地阴影片 center=[0,0.030,0] size=1.58x0.40（billboard，法向朝相机）')
c = project([0,0.030,0])
half_w = 1.58/2 * W / (2*c[0] if False else 1)   # 直接算角点更稳
corner_l = project([-0.79, 0.030, 0]); corner_r = project([0.79, 0.030, 0])
corner_t = project([0, 0.030+0.20, 0]); corner_b = project([0, 0.030-0.20, 0])
print('  中心      (%.0f, %.0f)' % c)
print('  左右端    x %.0f .. %.0f  (宽 %.0fpx)' % (corner_l[0], corner_r[0], corner_r[0]-corner_l[0]))
print('  上下端    y %.0f .. %.0f  (高 %.0fpx)' % (corner_t[1], corner_b[1], corner_t[1]-corner_b[1]))
print('  蛋糕底边  y=%.0f' % max(sy))
print('  阴影露在蛋糕下的那一条：y %.0f..%.0f（高 %.0fpx）' %
      (max(sy), corner_b[1], max(0, max(sy)-corner_b[1])))
