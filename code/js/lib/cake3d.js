/* ==========================================================================
   cake3d.js · 蛋糕这一幕的实时 3D 渲染（零依赖，手写 WebGL 2）

   为什么不用 three.js：
     最小版单个文件约 660 KB，比全站现有 JS（182 KB）加起来还大一倍多。
     这台站要跑在安卓中端机 + 共享主机上，这一笔开销换不来对应的收益 ——
     这里只需要一个对象、一盏灯、一块柔光背景，手写反而更小更可控。

   画面主体可以有两种来源，运行时二选一、自动回退：
     1. assets/cake.glb —— AI 生成的草莓奶油蛋糕（带 baseColor 贴图，
        tools/convert-cake-glb.py 转制：立起来 / 减面 / 只留一张贴图；
        后台异步加载，成功后换装）
     2. 程序化蛋糕 —— 下面的 lathe/椭球代码直接捏出来的那块
        （模型缺失、404、解析失败时沿用，永远有得画）

   降级策略（必须保住，不能让任何一个环境看到空白）：
     WebGL2 不可用 / 上下文丢失 → 返回 null，cake.js 继续用原来的平面蛋糕
     data-effects="calm"（用户要求减少动效）→ 只渲染一帧，不进动画循环
     data-effects="lite" → 降分辨率与网格密度

   性能：
     全部不透明几何合并成一次 draw call；火苗 / 烟 / 接地阴影按根绘制。
     DPR 上限 1.5（与 fx.js 一致），离开视口即暂停绘制。
   ========================================================================== */

import { onThemeChange } from './theme.js';
import { cssVar } from './fx.js';

/* --------------------------------------------------------------------------
   颜色工具：CSS 里拿到的是 sRGB 十六进制，这里做混合与提亮
   -------------------------------------------------------------------------- */

function hex2rgb(hex) {
  const s = String(hex).trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const scaleRgb = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/** 确定性伪随机：同一台设备每次进入这一幕，糖针的摆位都一样 */
function makeRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* --------------------------------------------------------------------------
   极简矩阵（只用到这几个，不引库）
   -------------------------------------------------------------------------- */

function mat4() { return new Float32Array(16); }

function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/** 只绕 Y 轴旋转的模型矩阵（蛋糕是转台，不需要完整 TRS） */
function rotY(out, rad, ty = 0) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  out[0] = c;  out[1] = 0; out[2] = -s; out[3] = 0;
  out[4] = 0;  out[5] = 1; out[6] = 0;  out[7] = 0;
  out[8] = s;  out[9] = 0; out[10] = c; out[11] = 0;
  out[12] = 0; out[13] = ty; out[14] = 0; out[15] = 1;
  return out;
}

/* --------------------------------------------------------------------------
   几何构建：把整块蛋糕拼成一个顶点缓冲
   顶点布局 [px,py,pz, nx,ny,nz, r,g,b,mat]，stride 40 字节
   mat 是材质编号，决定高光强度与透光 —— 蛋糕胚、奶油、果子如果共用一套高光，
   整体会像一块上过色的塑料，这是「廉价 3D」最常见的来源。
   -------------------------------------------------------------------------- */

const MAT = { sponge: 0, cream: 1, glossy: 2, sugar: 3, photo: 4 };

class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.mat = [];
    this.uv = [];      // 贴图坐标；程序化几何不用贴图，填 (0,0)
    this.idx = [];
  }

  vert(x, y, z, nx, ny, nz, c, mat, uv) {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2]);
    this.mat.push(mat);
    this.uv.push(uv ? uv[0] : 0, uv ? uv[1] : 0);
    return i;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }

  /** 圆锥面：把 (θ, φ) 网格三角化 */
  grid(rows, cols, indexAt) {
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols; c++) {
        const c2 = (c + 1) % cols;
        const a = indexAt(r, c);
        const b = indexAt(r, c2);
        const d = indexAt(r + 1, c);
        const e = indexAt(r + 1, c2);
        this.tri(a, d, b);
        this.tri(b, d, e);
      }
    }
  }

  /** 把另一个 Builder 的内容并进来（模型几何 + 程序化蜡烛拼一块缓冲） */
  merge(other) {
    const base = this.pos.length / 3;
    /* 用循环 push 而不是 push(...arr)：模型顶点一多（6 万顶点时 uv 有 13 万项），
       展开运算符的参数数量会超过引擎上限，直接抛
       "RangeError: Maximum call stack size exceeded"，模型静默不加载。 */
    for (let i = 0; i < other.pos.length; i++) this.pos.push(other.pos[i]);
    for (let i = 0; i < other.nrm.length; i++) this.nrm.push(other.nrm[i]);
    for (let i = 0; i < other.col.length; i++) this.col.push(other.col[i]);
    for (let i = 0; i < other.mat.length; i++) this.mat.push(other.mat[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(base + other.idx[i]);
    return this;
  }

  get triangles() { return this.idx.length / 3; }
}

/** 圆弧采样，用于把直角边做成圆角 */
function arc(cx, cy, r, a0, a1, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** 拼轮廓并去掉相邻重复点 */
function profile(...chunks) {
  const out = [];
  for (const c of chunks) {
    for (const p of c) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
      out.push(p);
    }
  }
  return out;
}

/**
 * 旋转体。profile 是 (半径, 高度) 的点列，顺序必须从下往上、从轴心向外再回到轴心
 * （法线方向由轮廓切向决定，顺序反了会被内表面照亮）。
 * wobble 用来给奶油裱花做出波浪形的花边。
 */
function pushLathe(b, prof, color, { seg = 48, wobble = null, mat = MAT.sponge, axis = [0, 0] } = {}) {
  const rows = prof.length;
  const cols = seg + 1;
  const start = b.pos.length / 3;

  // 轮廓切线 → (r, y) 平面内的二维法线
  const normals = prof.map((_, i) => {
    const a = prof[Math.max(0, i - 1)];
    const z = prof[Math.min(rows - 1, i + 1)];
    let tr = z[0] - a[0];
    let ty = z[1] - a[1];
    const len = Math.hypot(tr, ty) || 1;
    tr /= len; ty /= len;
    return [ty, -tr];
  });

  for (let i = 0; i < rows; i++) {
    const [r0, y] = prof[i];
    const [nr0, ny] = normals[i];
    for (let c = 0; c < cols; c++) {
      const phi = (c / seg) * Math.PI * 2;
      const wob = wobble ? wobble.amp * Math.sin(wobble.lobes * phi) : 0;
      const r = r0 + wob;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      b.vert(axis[0] + r * cp, y, axis[1] + r * sp, nr0 * cp, ny, nr0 * sp, color, mat);
    }
  }

  b.grid(rows, cols, (r, c) => start + r * cols + c);
}

/**
 * 椭球。center 是球心，radii 是三轴半径。
 * rotY 让椭球绕 Y 轴转：糖针要沿蛋糕表面的切向摆，否则侧面那圈会变成一根根戳出来的刺。
 */
function pushSphere(b, center, radii, color, { seg = 12, rings = 7, rotY = 0, mat = MAT.glossy } = {}) {
  const rows = rings + 1;
  const cols = seg + 1;
  const start = b.pos.length / 3;
  const [rx, ry, rz] = radii;
  const cr = Math.cos(rotY);
  const sr = Math.sin(rotY);

  for (let i = 0; i < rows; i++) {
    const v = i / rings;
    /* theta 必须从 π 递减到 0（行方向向上），才能和 pushLathe 的绕序一致。
       写反的话球的三角形是反向绕的，会被背面剔除 ——
       表现是正对相机的球只剩一圈轮廓、中间透出背后的东西，
       而滚圆又小的球看不出异常，极难定位。 */
    const theta = (1 - v) * Math.PI;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let c = 0; c < cols; c++) {
      const phi = (c / seg) * Math.PI * 2;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const nx = st * cp;
      const ny = ct;
      const nz = st * sp;
      // 先把方向转到椭球自己的坐标系，再按半轴拉伸
      const lx = nx * cr + nz * sr;
      const lz = -nx * sr + nz * cr;
      b.vert(
        center[0] + lx * rx, center[1] + ny * ry, center[2] + lz * rz,
        /* 椭球法线 ∝ 位置 / 半轴²。位置分量是 lx·rx，所以法线是 lx/rx ——
           不是 lx/rx²。少消这一次会让越扁的椭球错得越狠：
           奶油滴（0.05 × 0.2 × 0.05）和糖针会整片发黑、只剩一道高光，
           看着像划痕；而滚圆的果子几乎看不出问题，很容易漏掉。 */
        lx / rx, ny / ry, lz / rz,
        color, mat,
      );
    }
  }
  // 归一化法线
  for (let i = start; i < b.pos.length / 3; i++) {
    const o = i * 3;
    const nx = b.nrm[o];
    const ny = b.nrm[o + 1];
    const nz = b.nrm[o + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    b.nrm[o] = nx / l;
    b.nrm[o + 1] = ny / l;
    b.nrm[o + 2] = nz / l;
  }
  b.grid(rows, cols, (r, c) => start + r * cols + c);
}

/* --------------------------------------------------------------------------
   蛋糕模型
   尺寸单位是「蛋糕单位」，盘子半径 0.72，整高约 1.5（含蜡烛）
   -------------------------------------------------------------------------- */

const TIER1 = { y0: 0.062, y1: 0.660, r: 0.550, edge: 0.060 };
const TIER2 = { y0: 0.660, y1: 1.060, r: 0.400, edge: 0.050 };
const CANDLE = { r: 0.027, h: 0.420, wick: 0.030, turns: 2.5 };

/** 程序化蛋糕默认单根居中蜡烛；模型模式下蜡烛位置由 config 给出 */
const DEFAULT_CANDLES = [{ x: 0, z: 0, y0: TIER2.y1 }];

/**
 * 蜡烛柱身：红白**真正的螺旋**斜纹。
 *
 * ⚠️⚠️ 两个必须同时螺旋的量：**颜色和半径（沟槽）**。
 * 上一版只让颜色螺旋、半径却按行预先算好（整行共用一个 r），
 * 结果是「条纹是斜的、凹槽是一圈圈横环」——两套花纹对不上，一眼露馅。
 * 现在半径也用**同一个 phase** 逐顶点算，沟槽才会跟着条纹一起斜着走。
 *
 * 法线用中心差分求两个切向再叉乘，这样沟槽在**轴向和环向的坡度都进法线**，
 * 光扫过时才会出现沿螺旋走向的明暗，而不是整体均匀的柱面。
 */
function pushHelix(b, pal, { y0, y1, r0, r1, turns, seg = 28, rings = 120, groove = 0.30, mat = MAT.glossy, axis = [0, 0] }) {
  const cols = seg + 1;
  const start = b.pos.length / 3;
  const H = y1 - y0;
  const TAU = Math.PI * 2;

  /* 相位：同时含高度项和角度项。
     高度每升一整圈，条纹正好绕完一周 —— 两者缺一就不是螺旋。 */
  const phaseAt = (t, pf) => ((t * turns - pf * turns) % 1 + 1) % 1;
  // 0 在条纹边界，1 在色带中心
  const softAt = (t, pf) => {
    const ph = phaseAt(t, pf);
    const edge = Math.min(ph, 1 - ph) * 2;
    return 0.04 + 0.96 * Math.min(1, edge / 0.20);
  };
  // 半径 = 锥形基半径 × 沟槽（条纹边界处缩进）
  const radiusAt = (t, pf) => {
    const base = r0 + (r1 - r0) * t;
    return base * (1 - groove * (1 - softAt(t, pf)));
  };
  const colorAt = (t, pf) => {
    const ph = phaseAt(t, pf);
    const isRed = ph < 0.5;
    const base = isRed ? pal.candleB : pal.candleA;
    return mix(base, isRed ? pal.candleA : pal.candleB, 1 - softAt(t, pf));
  };

  const ET = 1 / Math.max(1, rings);   // 高度方向差分步长
  const EP = 1 / Math.max(4, seg);     // 环向差分步长（pf 是 0..1 的比例）

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = y0 + t * H;
    for (let c = 0; c < cols; c++) {
      const pf = c / seg;
      const r = radiusAt(t, pf);
      const phi = pf * TAU;
      const cp = Math.cos(phi), sp = Math.sin(phi);

      /* 中心差分求偏导。边界用 clamp，避免端点取到越界值。 */
      const tA = Math.min(1, t + ET), tB = Math.max(0, t - ET);
      const pA = (pf + EP) % 1, pB = (pf - EP + 1) % 1;
      const drdt = (radiusAt(tA, pf) - radiusAt(tB, pf)) / Math.max(1e-6, tA - tB);
      const drdp = (radiusAt(t, pA) - radiusAt(t, pB)) / Math.max(1e-6, 2 * EP * TAU) * TAU;

      // 两个切向：dP/dt 与 dP/dp，再叉乘得外法线
      const a1 = drdp * cp - r * TAU * sp;   // dP/dp 的 x
      const a3 = drdp * sp + r * TAU * cp;   // dP/dp 的 z
      let nx = H * a3;
      let ny = -TAU * r * drdt;
      let nz = -H * a1;
      const nl = Math.hypot(nx, ny, nz) || 1;

      b.vert(axis[0] + r * cp, y, axis[1] + r * sp,
        nx / nl, ny / nl, nz / nl, colorAt(t, pf), mat);
    }
  }
  b.grid(rings + 1, cols, (r, c) => start + r * cols + c);
}

function pushCandles(b, pal, defs) {
  for (const d of defs) {
    const yBase = d.y0;
    const yTop = d.y0 + CANDLE.h;
    pushHelix(b, pal, {
      y0: yBase, y1: yTop,
      r0: CANDLE.r, r1: CANDLE.r * (1 - 0.10),
      turns: CANDLE.turns,
      seg: 36, rings: 140, groove: 0.24,
      axis: [d.x, d.z],
    });
    // 顶端圆帽（蜡烛总有一圈融化的顶缘）
    pushLathe(b, profile(
      [[0.001, yTop], [CANDLE.r * 0.90 * 0.92, yTop]],
      arc(CANDLE.r * 0.90 * 0.92, yTop + 0.007, 0.007, -Math.PI / 2, 0, 3),
      [[0.001, yTop + 0.010]],
    ), pal.candleA, { seg: 20, mat: MAT.glossy, axis: [d.x, d.z] });
    // 烛芯：细杆
    pushLathe(b, profile(
      [[0.001, yTop + 0.005], [0.005, yTop + 0.007],
        [0.004, yTop + CANDLE.wick], [0.001, yTop + CANDLE.wick]]),
      pal.wick, { seg: 8, mat: MAT.sponge, axis: [d.x, d.z] });
  }
}

/** 烛芯顶端的火苗位置（世界坐标前先随转台旋转，见 frame） */
function flamePosOf(d) {
  // 顶帽比柱身再高 0.010，火苗从烛芯上方 0.050 起 —— 改 CANDLE.h 时这里要跟着走
  return [d.x, d.y0 + CANDLE.h + 0.010 + CANDLE.wick + 0.050, d.z];
}

function buildMesh(pal, quality) {
  const seg = quality === 'lite' ? 32 : 48;
  const b = new Builder();

  /* 盘子：浅口碟，边缘起一道圆唇。
     唇用四分之一圆弧做，直角边会让它显得像塑料 */
  pushLathe(b, profile(
    [[0.001, 0.006], [0.600, 0.006]],
    arc(0.600, 0.030, 0.024, -Math.PI / 2, Math.PI / 2, 4),
    [[0.001, 0.054]],
  ), pal.plate, { seg, mat: MAT.glossy });

  /* 两层蛋糕体。圆角是必须的 —— 直角边缘会让它立刻变回「挤出来的贴图」 */
  const tierProfile = (t) => profile(
    [[0.001, t.y0], [t.r - t.edge, t.y0]],
    arc(t.r - t.edge, t.y0 + t.edge, t.edge, -Math.PI / 2, 0, 3),
    [[t.r, t.y1 - t.edge]],
    arc(t.r - t.edge, t.y1 - t.edge, t.edge, 0, Math.PI / 2, 3),
    [[0.001, t.y1]],
  );
  pushLathe(b, tierProfile(TIER1), pal.sponge, { seg, mat: MAT.sponge });
  pushLathe(b, tierProfile(TIER2), pal.sponge, { seg, mat: MAT.sponge });

  /* 奶油裱花：两个甜甜圈剖面 + 16 道波浪，做出挤花袋的褶 */
  const creamRoll = (rc, yc, rt) => ({
    prof: arc(rc, yc, rt, -Math.PI / 2, Math.PI * 1.5, 14),
    wobble: { lobes: 16, amp: 0.016 },
  });
  const roll1 = creamRoll(TIER1.r - 0.030, TIER1.y1 + 0.012, 0.058);
  pushLathe(b, roll1.prof, pal.cream, { seg, wobble: roll1.wobble, mat: MAT.cream });
  const roll2 = creamRoll(TIER2.r - 0.022, TIER2.y1 + 0.010, 0.046);
  pushLathe(b, roll2.prof, pal.cream, { seg, wobble: roll2.wobble, mat: MAT.cream });

  /* 垂下来的奶油：绕一圈长短不一的椭球，读起来就是流下来的那道边。
     球心要按半轴往外推 —— 只放在半径 +0.006 处的话，
     半个椭球会埋进蛋糕体里，只剩一道月牙露在外面，看着像划痕而不像奶油。 */
  const rand = makeRand(20260521);
  const drips = (count, r, yTop, seedShift) => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + seedShift;
      /* 滴子要短 —— 原来 0.10-0.26 的长度挂满一层侧壁，看着像蜡泪。
          缩到 0.05-0.14 就是「淋面刚挂住」的那一圈，精致感主要来自这里。 */
      const len = 0.052 + rand() * 0.088;
      const y = yTop - len;
      const w = 0.026 + rand() * 0.012;
      const rr = r + w * 0.45;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      pushSphere(b, [ca * rr, y, sa * rr],
        [w, len * 0.85, w], pal.cream, { seg: 8, rings: 5, mat: MAT.cream });
      // 下端补一颗珠子：没有它，滴子是根等粗的圆柱，读起来不像在流
      pushSphere(b, [ca * rr, yTop - len * 1.85, sa * rr],
        [w * 1.5, w * 1.6, w * 1.5], pal.cream, { seg: 10, rings: 6, mat: MAT.cream });
    }
  };
  drips(8, TIER1.r, TIER1.y1 - 0.02, 0.0);
  drips(5, TIER2.r, TIER2.y1 - 0.02, 0.4);

  /* 顶面的构图是这一幕的关键：蜡烛居中，心形插牌在正前方，
     六朵裱花收外圈、隔一朵站一颗果子。每样东西有明确的位置，
     不再是均匀撒一层 —— 均匀撒是「蛋糕模板」，有构图才是「为某个人做的蛋糕」。 */
  const pearlColors = [pal.white, pal.white, pal.gold, pal.cherry];
  const pick1 = () => pearlColors[Math.floor(rand() * pearlColors.length)];

  /** 糖珠贴侧壁（替代原来的长糖针：圆珠读起来是糖珠，细长条读起来是刺） */
  const pearlsOnSide = (r, yMin, yMax, count) => {
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const y = yMin + rand() * (yMax - yMin);
      const s = 0.011 + rand() * 0.005;
      pushSphere(b, [Math.cos(a) * (r + 0.008), y, Math.sin(a) * (r + 0.008)],
        [s, s, s], pick1(), { seg: 8, rings: 5, mat: MAT.glossy });
    }
  };

  /** 糖珠平铺在某个高度的面上 */
  const pearlsOnTop = (rMin, rMax, y, count) => {
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const rr = rMin + rand() * (rMax - rMin);
      const s = 0.010 + rand() * 0.004;
      pushSphere(b, [Math.cos(a) * rr, y, Math.sin(a) * rr],
        [s, s, s], pick1(), { seg: 8, rings: 5, mat: MAT.glossy });
    }
  };

  /** 黄油小花：五瓣奶油 + 一点蜜金花心。y0 是所在面的高度 */
  const flowerAt = (fx, fz, y0) => {
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2 + rand() * 0.5;
      pushSphere(b, [fx + Math.cos(a) * 0.034, y0 + 0.008, fz + Math.sin(a) * 0.034],
        [0.021, 0.009, 0.013], pal.cream, { seg: 8, rings: 5, rotY: -a, mat: MAT.cream });
    }
    pushSphere(b, [fx, y0 + 0.009, fz], [0.011, 0.008, 0.011], pal.gold,
      { seg: 8, rings: 5, mat: MAT.glossy });
  };

  // 侧壁：上下两层各一圈疏疏的糖珠
  pearlsOnSide(TIER1.r, 0.20, 0.58, 16);
  pearlsOnSide(TIER2.r, 0.72, 0.98, 9);
  // 上层顶面：蜡烛根部一圈细珠
  pearlsOnTop(0.075, 0.105, TIER2.y1 + 0.008, 8);
  // 下层露出的窄环：少量糖珠填缝
  pearlsOnTop(0.415, 0.452, TIER1.y1 + 0.006, 8);

  // 顶面外圈：六朵小裱花
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    pushSphere(b, [Math.cos(a) * 0.345, TIER2.y1 + 0.012, Math.sin(a) * 0.345],
      [0.034, 0.019, 0.034], pal.cream, { seg: 10, rings: 6, mat: MAT.cream });
  }

  // 盘面上散三朵小花、几粒糖珠：像是摆盘时随手放下的
  for (let i = 0; i < 3; i++) {
    const a = 0.9 + i * 1.9 + rand() * 0.3;
    const rr = 0.47 + rand() * 0.06;
    flowerAt(Math.cos(a) * rr, Math.sin(a) * rr, 0.004);
  }
  pearlsOnTop(0.47, 0.57, 0.012, 4);

  /* 心形插牌：下半是收尖的旋转体、上面两瓣。
     「送给女朋友」这件事唯一的直白表达，所以尺寸与一颗果子相当（宽约 0.16），
     颜色用玫瑰红而不是果子红。两瓣间距拉开一点 —— 相机是俯视的，
     看到的主要是心的顶面，没有那道 V 形凹口就只是一颗红球。 */
  {
    const hA = Math.PI / 2;
    const hR = 0.20;
    const hBase = TIER2.y1 + 0.006;
    const hStart = b.pos.length / 3;
    pushLathe(b, profile([[0.001, 0], [0.020, 0.015], [0.038, 0.052], [0.001, 0.062]]),
      pal.rose, { seg: 14, mat: MAT.glossy });
    pushSphere(b, [-0.029, 0.064, 0], [0.026, 0.024, 0.021], pal.rose, { seg: 10, rings: 6, mat: MAT.glossy });
    pushSphere(b, [0.029, 0.064, 0], [0.026, 0.024, 0.021], pal.rose, { seg: 10, rings: 6, mat: MAT.glossy });
    // 在原点建好后整体后仰再挪到位。后仰是关键：相机俯视约 13°，
    // 直立的心只能被看到头顶，往后倒才把「脸」转向镜头（法线要跟着一起转）。
    const hEnd = b.pos.length / 3;
    const tilt = -0.30;
    const tc = Math.cos(tilt), ts = Math.sin(tilt);
    for (let v = hStart; v < hEnd; v++) {
      const py = b.pos[v * 3 + 1];
      const pz = b.pos[v * 3 + 2];
      b.pos[v * 3 + 1] = py * tc - pz * ts;
      b.pos[v * 3 + 2] = py * ts + pz * tc;
      const ny = b.nrm[v * 3 + 1];
      const nz = b.nrm[v * 3 + 2];
      b.nrm[v * 3 + 1] = ny * tc - nz * ts;
      b.nrm[v * 3 + 2] = ny * ts + nz * tc;
      b.pos[v * 3] = Math.cos(hA) * hR + b.pos[v * 3] * 1.5;
      b.pos[v * 3 + 1] = hBase + b.pos[v * 3 + 1] * 1.5;
      b.pos[v * 3 + 2] = Math.sin(hA) * hR + b.pos[v * 3 + 2] * 1.5;
    }
  }

  /* 顶上三颗果子 + 微倾的果梗：隔一朵站一颗，坐在裱花顶上 ——
     这是真实生日蛋糕的经典摆法，果子也因此在转台上远看始终「有座」 */
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    const cx = Math.cos(a) * 0.345;
    const cz = Math.sin(a) * 0.345;
    const base = TIER2.y1 + 0.012 + 0.026;   // 裱花顶面
    pushSphere(b, [cx, base + 0.042, cz], [0.050, 0.048, 0.050], pal.cherry, { seg: 12, rings: 7 });

    // 果梗先在原点生成，再整体挪到果子上并向外微倾（笔直的梗看着很假）
    const stemStart = b.pos.length / 3;
    pushLathe(b, profile([[0.001, 0], [0.0045, 0], [0.0032, 0.075], [0.001, 0.075]]),
      pal.stem, { seg: 6 });
    const stemEnd = b.pos.length / 3;
    const leanX = Math.cos(a) * 0.032;
    const leanZ = Math.sin(a) * 0.032;
    for (let v = stemStart; v < stemEnd; v++) {
      const localY = b.pos[v * 3 + 1];
      const k = localY / 0.075;
      b.pos[v * 3] += cx + leanX * k;
      b.pos[v * 3 + 1] = base + 0.055 + localY;
      b.pos[v * 3 + 2] += cz + leanZ * k;
    }
  }

  /* 蜡烛由 pushCandles 统一画（程序化蛋糕默认单根居中，模型模式下的
     多根蜡烛走 buildCandlesOnly），这里只负责蛋糕本体 */
  pushCandles(b, pal, DEFAULT_CANDLES);

  return b;
}

/** 模型模式下只画蜡烛：蛋糕本体由 GLB 提供 */
function buildCandlesOnly(pal, defs) {
  const b = new Builder();
  pushCandles(b, pal, defs);
  return b;
}

/* --------------------------------------------------------------------------
   着色器
   -------------------------------------------------------------------------- */

const SURF_VS = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec4 aAlbedo;        // rgb = 固有色，a = 材质编号
in vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vWorld;
out vec3 vAlbedo;
out float vMat;
out vec2 vUV;
out float vLocalY;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vAlbedo = aAlbedo.rgb;
  vMat = aAlbedo.a;
  vUV = aUV;
  vLocalY = aPos.y;
  gl_Position = uProj * uView * wp;
}`;

const SURF_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vAlbedo;
in float vMat;
in vec2 vUV;
in float vLocalY;
uniform vec3 uEye;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uCandlePos;
uniform vec3 uCandleColor;
uniform float uCandlePower;
uniform sampler2D uTex;
out vec4 outColor;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uEye - vWorld);

  // 材质：蛋糕胚哑光、奶油有油润的高光与一点透光、果子/盘子更亮、糖针最闪；
  // 贴图模型（mat=4）按奶油质感取参数，固有色来自模型自带的 baseColor 贴图
  float shininess = 20.0;
  float spec = 0.10;
  float sss = 0.0;            // 透光量：奶油与糖针微微透出烛光，胚体不透
  bool textured = vMat > 3.5 && vMat < 4.5;
  if (textured) { shininess = 42.0; spec = 0.26; sss = 0.22; }
  else if (vMat > 0.5 && vMat < 1.5) { shininess = 64.0; spec = 0.40; sss = 0.30; }
  else if (vMat > 1.5 && vMat < 2.5) { shininess = 96.0; spec = 0.55; sss = 0.05; }
  else if (vMat > 2.5) { shininess = 140.0; spec = 0.85; sss = 0.45; }

  vec3 albedo = textured ? texture(uTex, vUV).rgb : vAlbedo;

  // 半球环境光：天光偏纸白、地面反光偏暖，够撑起体积又不会脏
  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);

  vec3 L1 = normalize(-uKeyDir);
  float d1 = max(dot(N, L1), 0.0);
  float s1 = pow(max(dot(N, normalize(L1 + V)), 0.0), shininess) * spec;

  vec3 L2 = normalize(-uFillDir);
  float d2 = max(dot(N, L2), 0.0);

  // 烛光：真正的点光源。蜡烛灭了这一幕就只剩环境光
  vec3 toC = uCandlePos - vWorld;
  float dist = max(length(toC), 0.0001);
  vec3 L3 = toC / dist;
  float d3 = max(dot(N, L3), 0.0);
  float atten = 1.0 / (1.0 + 2.2 * dist + 1.4 * dist * dist);
  float s3 = pow(max(dot(N, normalize(L3 + V)), 0.0), shininess * 0.7) * spec * 1.4;

  vec3 col = albedo * (amb + uKeyColor * d1 + uFillColor * d2);
  col += albedo * uCandleColor * (d3 * uCandlePower * atten * 1.35);
  col += uKeyColor * s1;
  col += uCandleColor * (s3 * uCandlePower * atten);
  // 透光：奶油边沿被烛光透出来的那一层暖
  col += albedo * uCandleColor * (sss * uCandlePower * atten * 0.9);

  // 边缘光：让奶油轮廓从纸底上"浮"起来
  col += uSkyColor * pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.16;

  // 接触压暗：越靠近盘子越暗，让它坐在纸上而不是浮着
  col *= mix(0.74, 1.0, smoothstep(0.05, 0.32, vLocalY));

  /* 蛋糕胚加一层很低的斑纹。
     频率刻意压低到约 18 次/单位（屏幕上约 25px 一格）：
     再高就会在转台旋转时闪成噪点，而且大面积平涂是「廉价 3D」最明显的特征。 */
  if (vMat < 0.5) {
    float grain = sin(vWorld.x * 18.0) * sin(vWorld.y * 15.0) * sin(vWorld.z * 17.0);
    col *= 1.0 + grain * 0.035;
  }

  // 轻胶片肩部，避免高光直接切成死白
  col = col / (col + vec3(0.92)) * 1.42;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const SPRITE_VS = `#version 300 es
precision highp float;
in vec2 aQuad;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec3 uCenter;
uniform vec2 uSize;
uniform vec3 uRight;
uniform vec3 uUp;
out vec2 vUV;
void main() {
  vec3 wp = uCenter + uRight * (aQuad.x * uSize.x) + uUp * (aQuad.y * uSize.y);
  vUV = aQuad + 0.5;
  gl_Position = uProj * uView * vec4(wp, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform int uKind;        // 0 火苗  1 烟  2 接地阴影
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uAlpha;
uniform float uTime;      // 噪声动画的时间轴（火焰与烟都靠它流动）
uniform float uBend;      // 吹气造成的火焰倒伏量，-1..1
out vec4 outColor;

/* 火焰的形状用 **fBm（分形布朗运动）噪声**塑形，不是画一个椭圆。
   做法参考社区里成熟的实时火焰着色器：几层不同频率的值噪声叠在一起
   （宏观形态 / 热气流涡旋 / 高频跳动 / 边缘细撕），每层往上升方向漂移，
   再乘一个「上窄下宽 + 顶端收尖」的轮廓，最后走色阶（暗红→橙→黄→白）。

   为什么非做不可：原来那版是「一个水滴形状 + 正弦抖动」，
   看起来像贴了张发光的图片 —— 不像火。火之所以像火，是**轮廓在不停地变**：
   边缘的细碎撕裂 + 整体的呼吸起伏，两者是不同频率的运动，叠加才出效果。 */
float hash21(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // 五次插值，比线性插值少一档网格感
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/* 四层：各自负责一件事，这是社区实践里比较稳的分工
   L1 宏观形态（决定火苗胖瘦） · L2 热气流涡旋（0.5× 速度，看着才不呆）
   L3 高频跳动（2× 速度，人眼对高频闪烁敏感，烛火的「呼吸感」靠它）
   L4 边缘细撕（4× 速度，只在轮廓附近起作用） */
float flameFbm(vec2 uv, float t) {
  float n = 0.0;
  n += vnoise(uv * 1.6 + vec2(0.0, -t * 0.55)) * 0.50;
  n += vnoise(uv * 3.7 + vec2(0.0, -t * 1.10) + 7.3) * 0.27;
  n += vnoise(uv * 8.3 + vec2(0.0, -t * 2.30) + 13.1) * 0.15;
  n += vnoise(uv * 17.0 + vec2(0.0, -t * 4.10) + 21.7) * 0.08;
  return n;
}

/* 火色阶：底部最热（白）→ 中段橙 → 顶端暗红熄灭。
   真实烛火是**根部亮、尖端暗**，反过来就假了。 */
vec3 flameRamp(float heat) {
  heat = clamp(heat, 0.0, 1.0);
  vec3 c = mix(vec3(0.85, 0.16, 0.05), vec3(1.00, 0.52, 0.10), smoothstep(0.10, 0.42, heat));
  c = mix(c, vec3(1.00, 0.82, 0.32), smoothstep(0.40, 0.70, heat));
  c = mix(c, vec3(1.00, 0.97, 0.86), smoothstep(0.68, 1.00, heat));
  return c;
}

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float a = 0.0;
  vec3 col = uColor;

  if (uKind == 0) {
    /* 火焰本体。uv.y 从下（-1）到上（+1） */
    float y01 = p.y * 0.5 + 0.5;                 // 0 = 根部，1 = 尖
    // 轮廓：下宽上窄，顶端收成尖
    float width = mix(0.86, 0.06, pow(y01, 0.78));
    // 噪声塑形：只在有火的地方起作用，越往上越强（火尖最容易撕裂）
    float turb = flameFbm(vec2(p.x * 0.55, y01 * 1.15), uTime) - 0.5;
    float xw = p.x + turb * (0.16 + 0.62 * y01);
    // 吹气时整条火焰被压矮、轮廓被吹斜
    xw += uBend * (0.35 + y01 * 0.85);
    float d = abs(xw) / max(width, 0.02);
    float body = smoothstep(1.0, 0.0, d);
    // 根部往上有一段是「内焰」，更亮更实
    float core = smoothstep(0.72, 0.0, d) * smoothstep(0.62, 0.06, y01);
    float heat = body * (0.42 + 0.58 * y01) + core * 0.55;
    col = flameRamp(clamp(heat, 0.0, 1.0));
    a = body * (0.55 + 0.45 * y01) * uAlpha;
    // 顶端直接淡出，避免看到精灵片的硬边
    a *= smoothstep(1.02, 0.72, y01);
    a += core * uAlpha * 0.5;
    /* 精灵是矩形片，只要边缘还有非零 alpha 就会看到一条直边（截图上像块方砖）。
       乘一个「到片中心的距离」衰减把四角彻底收干净 —— 对火苗与外晕都要。 */
    float edge = 1.0 - smoothstep(0.72, 1.0, max(abs(p.x), abs(p.y)));
    a *= edge;
  } else if (uKind == 1) {
    // 烟：软边一团，带一点向上飘的扰动。同样收掉矩形片的四角。
    float turb = vnoise(p * 1.4 + vec2(0.0, -uTime * 0.35)) - 0.5;
    float d = length(vec2((p.x + turb * 0.5) * 1.25, p.y));
    a = smoothstep(1.0, 0.05, d) * uAlpha;
    a *= 1.0 - smoothstep(0.72, 1.0, max(abs(p.x), abs(p.y)));
  } else if (uKind == 2) {
    /* 接地阴影：中心实、边缘虚。
       这是竖直的 billboard（up = [0,1,0]），所以上下方向要压扁一些，
       影子才是「贴着地的一圈」而不是一个正圆。 */
    float d = length(vec2(p.x, p.y * 1.35));
    a = smoothstep(1.0, 0.10, d) * uAlpha;
  } else {
    /* 火光外晕：被烤亮的那圈空气，衰减要比烟更软。
       同样要乘边缘衰减，否则矩形精灵片的四个角会露出直边。 */
    float d = length(p);
    a = pow(smoothstep(1.4, 0.0, d), 2.4) * uAlpha;
    a *= 1.0 - smoothstep(0.70, 1.0, max(abs(p.x), abs(p.y)));
  }

  if (a <= 0.001) discard;
  outColor = vec4(col * a, a);
}`;

/* --------------------------------------------------------------------------
   GLB 模型解析（零依赖）
   只支持本项目的实际需要：静态三角网格 + 内嵌 baseColor 贴图。
   遇到 Draco/meshopt 压缩、蒙皮动画、交错顶点等超出需要的特性就直接抛错，
   调用方静默回退程序化蛋糕 —— 宁可要那块熟悉的蛋糕，也不要半个坏模型。
   -------------------------------------------------------------------------- */

const GLB_COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const GLB_NCOMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const GLB_DIM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function gltfMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const m = new Float32Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = (2 * (x * y + z * w)) * s[0];
  m[2] = (2 * (x * z - y * w)) * s[0];
  m[4] = (2 * (x * y - z * w)) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = (2 * (y * z + x * w)) * s[1];
  m[8] = (2 * (x * z + y * w)) * s[2];
  m[9] = (2 * (y * z - x * w)) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function readGLBAccessor(json, bin, i) {
  const a = json.accessors[i];
  if (!a || a.sparse) throw new Error('稀疏 accessor 暂不支持');
  const T = GLB_COMP[a.componentType];
  if (!T) throw new Error('不支持的分量类型 ' + a.componentType);
  const n = GLB_DIM[a.type];
  const bv = json.bufferViews[a.bufferView];
  const byteLen = GLB_NCOMP[a.componentType] * n;
  if (bv.byteStride && bv.byteStride !== byteLen) throw new Error('交错顶点暂不支持');
  const off = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
  return new T(bin.buffer, off, a.count * n);
}

/** 缺法线时从面法线累加出平滑法线（AI 导出的素坯常没有 NORMAL） */
function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      n[v] += nx; n[v + 1] += ny; n[v + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/**
 * 解析 GLB → { pos, nrm, uv, idx, image }。pos/nrm/uv 是普通数组，idx 是 Uint32Array。
 * image 为 null 表示模型没带 baseColor 贴图（走顶点色/调色板路径）。
 */
function parseGLB(buffer) {
  const head = new DataView(buffer);
  if (head.getUint32(0, true) !== 0x46546C67 || head.getUint32(4, true) !== 2) {
    throw new Error('不是 GLB v2');
  }
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buffer.byteLength) {
    const len = head.getUint32(off, true);
    const type = head.getUint32(off + 4, true);
    const chunk = new Uint8Array(buffer, off + 8, len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004E4942) bin = chunk;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('GLB 缺少 JSON/BIN 块');
  for (const e of json.extensionsRequired || []) {
    if (/draco|meshopt|basis/i.test(e)) throw new Error('不支持的压缩 ' + e);
  }

  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  let image = null;

  function takeImage(materialIdx) {
    if (image || materialIdx === undefined) return;
    const bct = json.materials?.[materialIdx]?.pbrMetallicRoughness?.baseColorTexture;
    if (!bct) return;
    /* 索引要逐层剥，且 source 可能是**数组** —— glTF 2.0 规范里
       `textures[i].source` 是指向 images 的索引数组（为了支持 mipmap 多源），
       写成 `json.images[json.textures[t].source]` 会拿数组当下标 → undefined
       → 贴图从未被取出，蛋糕渲染成纯白、蛋糕上那几个巧克力字全都看不清
       （v1.6.5 修）。旧模型没踩到是因为它的 source 是裸数字。 */
    const tex = json.textures?.[bct.index];
    if (!tex) return;
    let srcIdx = tex.source;
    if (Array.isArray(srcIdx)) srcIdx = srcIdx[0];
    const src = json.images?.[srcIdx];
    if (!src) return;
    if (src.bufferView !== undefined) {
      const bv = json.bufferViews[src.bufferView];
      /* ⚠️ 偏移只能加一次。`bin` 是 new Uint8Array(buffer, off+8, len) 切出来的
         **视图**，它自己的 byteOffset 已经是 chunk 在原 buffer 里的起点；
         `bin.slice(a, b)` 的 a/b 是**视图内相对偏移**。再补一个 bin.byteOffset
         等于多加了一次（本例 1404 字节），切出来的是错位的字节 ——
         PNG 头从 137,80,78,71 变成 50,62,241,108，createImageBitmap 直接抛
         "source image could not be decoded"，整段 loadModel 被 catch 掉、
         静默回退程序化蛋糕（v1.6.5 修）。 */
      const o = bv.byteOffset || 0;
      image = { bytes: bin.slice(o, o + bv.byteLength), type: src.mimeType || 'image/png' };
    } else if (typeof src.uri === 'string' && src.uri.startsWith('data:')) {
      const b64 = src.uri.slice(src.uri.indexOf(',') + 1);
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      image = { bytes, type: src.mimeType || src.uri.slice(5, src.uri.indexOf(';')) };
    }
  }

  function visit(nodeI, parent) {
    const node = json.nodes[nodeI];
    const m = parent ? mat4Mul(parent, gltfMatrix(node)) : gltfMatrix(node);
    if (node.mesh !== undefined && json.meshes[node.mesh]) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        const at = prim.attributes || {};
        if (at.POSITION === undefined) continue;
        const p = readGLBAccessor(json, bin, at.POSITION);
        const base = pos.length / 3;
        for (let i = 0; i < p.length; i += 3) {
          pos.push(
            m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12],
            m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13],
            m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14],
          );
        }
        if (at.NORMAL !== undefined) {
          const nr = readGLBAccessor(json, bin, at.NORMAL);
          for (let i = 0; i < nr.length; i += 3) {
            let nx = m[0] * nr[i] + m[4] * nr[i + 1] + m[8] * nr[i + 2];
            let ny = m[1] * nr[i] + m[5] * nr[i + 1] + m[9] * nr[i + 2];
            let nz = m[2] * nr[i] + m[6] * nr[i + 1] + m[10] * nr[i + 2];
            const l = Math.hypot(nx, ny, nz) || 1;
            nrm.push(nx / l, ny / l, nz / l);
          }
        }
        if (at.TEXCOORD_0 !== undefined) {
          const t = readGLBAccessor(json, bin, at.TEXCOORD_0);
          // 同上：UV 数量 = 顶点 × 2，6 万顶点就是 13 万项，push(...) 会爆栈
          for (let i = 0; i < t.length; i++) uv.push(t[i]);
        }
        if (at.COLOR_0 !== undefined) {
          const c = readGLBAccessor(json, bin, at.COLOR_0);
          const norm = json.accessors[at.COLOR_0].normalized ? 255 : 1;
          const dim = GLB_DIM[json.accessors[at.COLOR_0].type];
          for (let i = 0; i < c.length; i += dim) {
            col.push(c[i] / norm, c[i + 1] / norm, c[i + 2] / norm);
          }
        }
        if (prim.indices !== undefined) {
          const ix = readGLBAccessor(json, bin, prim.indices);
          for (let i = 0; i < ix.length; i++) idx.push(base + ix[i]);
        } else {
          for (let i = 0; i < p.length / 3; i++) idx.push(base + i);
        }
        takeImage(prim.material);
      }
    }
    for (const c of node.children || []) visit(c, m);
  }

  for (const r of json.scenes[json.scene || 0].nodes) visit(r, null);
  if (!pos.length) throw new Error('GLB 里没有可用网格');

  return {
    pos,
    nrm: nrm.length === pos.length ? nrm : null,
    uv: uv.length === (pos.length / 3) * 2 ? uv : null,
    col: col.length === pos.length ? col : null,
    idx,
    image,
  };
}

/** 落地归一化：XZ 居中、最低点贴 y=0、最长边缩放到 target。返回归一化后的总高 */
function normalizeGeometry(geo, target) {
  let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
  for (let i = 0; i < geo.pos.length; i += 3) {
    const x = geo.pos[i], y = geo.pos[i + 1], z = geo.pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const s = target / Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (let i = 0; i < geo.pos.length; i += 3) {
    geo.pos[i] = (geo.pos[i] - cx) * s;
    geo.pos[i + 1] = (geo.pos[i + 1] - minY) * s;
    geo.pos[i + 2] = (geo.pos[i + 2] - cz) * s;
  }
  return (maxY - minY) * s;
}

/** 从正上方对网格射线，返回 (x,z) 处的最高表面高度 —— 蜡烛要贴着任何模型的面 */
function surfaceTopY(geo, x, z) {
  const p = geo.pos;
  const ix = geo.idx;
  let best = -1;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const ax = p[a], az = p[a + 2];
    const d1 = (p[b] - ax) * (z - az) - (p[b + 2] - az) * (x - ax);
    const d2 = (p[c] - p[b]) * (z - p[b + 2]) - (p[c + 2] - p[b + 2]) * (x - p[b]);
    const d3 = (ax - p[c]) * (z - p[c + 2]) - (az - p[c + 2]) * (x - p[c]);
    if (!((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0))) continue;
    const e1x = p[b] - ax, e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - az;
    const e2x = p[c] - ax, e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - az;
    const ny = e1z * e2x - e1x * e2z;
    if (Math.abs(ny) < 1e-9) continue;
    const nx = e1y * e2z - e1z * e2y;
    const nz = e1x * e2y - e1y * e2x;
    const y = p[a + 1] - (nx * (x - ax) + nz * (z - az)) / ny;
    if (y > best) best = y;
  }
  return best;
}

/* ------------------------------------------------------------------------
   渲染器
   ------------------------------------------------------------------------ */

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败：' + log);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('着色器链接失败：' + log);
  }
  return p;
}

function readPalette() {
  const surface = hex2rgb(cssVar('--surface') || '#FFFCF7');
  const accent = hex2rgb(cssVar('--accent') || '#CC785C');
  const accent2 = hex2rgb(cssVar('--accent-2') || '#D9A05B');
  const text = hex2rgb(cssVar('--text') || '#141413');
  const bg = hex2rgb(cssVar('--bg') || '#FAF9F5');

  return {
    /* 蛋糕胚用蜜金压深：原来是 accent2 混底色 0.38，和奶油几乎同色，
       整块蛋糕糊成一片、分不出层次。现在压到 0.12，介于白奶油之间才有对比。 */
    sponge: mix(accent2, bg, 0.12),
    /* 奶油带极淡的陶土底调（5%）：比纯白多一分暖，读起来是「草莓奶油」
       而不是「白蜡」。比例不能再高，否则整块蛋糕会发粉、脱离全站纸感。 */
    cream: mix(mix(surface, [1, 1, 1], 0.45), accent, 0.05),
    plate: mix(surface, text, 0.14),
    accent,
    accent2,
    white: [0.99, 0.97, 0.94],
    // 果子是全站唯一的高饱和红。水果本来就该是红的，这一处跳出配色是刻意的
    cherry: [0.72, 0.17, 0.19],
    // 心形插牌的玫瑰红：果子红提亮两成，区分「水果」和「心意」两种红
    rose: mix([0.72, 0.17, 0.19], [1, 1, 1], 0.20),
    // 裱花心与糖珠的蜜金：accent2 提亮，别和胚体糊在一起
    gold: mix(accent2, [1, 1, 1], 0.30),
    stem: mix(accent2, text, 0.55),
    /* 蜡烛的红白条纹。参照多视图 3D 模型里那根：条纹红是**鲜亮的草莓红**，
       不是站内的陶土 accent（#CC785C 偏暗、偏灰）——蜡烛只有几十像素宽，
       暗红在浅背景上根本读不出「红白相间」，整根看着就是根灰白小棍。
       ⚠️ 这里必须写字面值：对象字面量内部不能引用同级的 cherry
       （会报 ReferenceError: cherry is not defined，且 readPalette 整体抛错
       → 表现为「3D 初始化失败」静默降级成平面蛋糕，极难定位）。*/
    candleA: [0.99, 0.98, 0.96],
    candleB: mix([0.72, 0.17, 0.19], [1, 1, 1], 0.12),
    wick: mix(text, accent2, 0.25),
    flameCore: [1.0, 0.95, 0.78],
    flameOuter: [0.90, 0.48, 0.22],
    flameHalo: [1.0, 0.66, 0.34],
    candleLight: [1.0, 0.72, 0.42],
    skyAmbient: mix(surface, [1, 1, 1], 0.25),
    groundAmbient: mix(bg, accent2, 0.34),
    key: [1.0, 0.96, 0.90],
    fill: mix(surface, accent, 0.22),
    shadow: mix(text, bg, 0.25),
  };
}

/**
 * 建渲染器。返回 null 表示这个环境用不了 WebGL2 —— 调用方继续用平面蛋糕。
 */
export function createCake3d(canvas, { quality = 'full', model: modelUrl = null, modelScale = 1, candles = null } = {}) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: quality !== 'lite',
      depth: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    });
  } catch { /* 下面统一返回 null */ }
  if (!gl) return null;

  let pal = readPalette();
  let progSurf;
  let progSprite;
  try {
    progSurf = program(gl, SURF_VS, SURF_FS);
    progSprite = program(gl, SPRITE_VS, SPRITE_FS);
  } catch (err) {
    console.warn('[cake3d]', err);
    disposeGL();   // 见 disposeGL 注释：不能带着已建好的 program 离开
    return null;
  }

  /* DPR 上限（不是 DPR 本身）。实际值每次 resize 都重新读 ——
     移动端 Safari 地址栏收起/展开、双指缩放都会改 devicePixelRatio。 */
  const MAX_DPR = quality === 'lite' ? 1.25 : 1.5;
  const currentDpr = () => Math.min(window.devicePixelRatio || 1, MAX_DPR);
  let dpr = currentDpr();

  /* ---------- 几何 ---------- */

  /* 蜡烛位置由 config 给（模型归一化空间里的 [x,z]），y 由射线贴面求出。
     没配就退回程序化的单根居中蜡烛。 */
  const candleSrc = (modelUrl && candles && candles.length) ? candles : DEFAULT_CANDLES;
  let candleDefs = candleSrc.map((c) => ({
    x: c[0] ?? c.x,
    z: c[1] ?? c.z,
    y0: c.y0 ?? TIER2.y1,
  }));

  /* 模型几何（归一化后）。null = 还在用程序化蛋糕 */
  let model = null;

  function composeMesh() {
    if (model) {
      const mb = new Builder();
      const n = model.pos.length / 3;
      /* 两条材质路径，取决于模型有没有 COLOR_0：
         ① 有 COLOR_0 → 顶点色 + 真实光照（AI 图生 3D 那张 baseColor 是投影烘焙的
            atlas，实测 6%~25% 是灰色空区，压小后细节糊成一片，蛋糕看着像
            「一块贴了图的平面」）。材质号按颜色反推。
         ② 无 COLOR_0 → 走贴图路径，mat 必须给 MAT.photo(=4)：
            片元着色器里 `bool textured = vMat > 3.5 && vMat < 4.5`，
            漏了它 albedo 恒取 vAlbedo（白），贴图再漂亮也采样不到 ——
            蛋糕上那几个巧克力字全都看不清就是栽在这里（v1.6.5 修）。 */
      const useVcol = !model.textured && model.col && model.col.length >= n * 3;
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        let c = [1, 1, 1];
        let matId = model.textured ? MAT.photo : MAT.cream;
        if (useVcol) {
          c = [model.col[o], model.col[o + 1], model.col[o + 2]];
          const r = c[0], g = c[1], b = c[2];
          if (r - g > 0.20 && r - b > 0.20) matId = MAT.glossy;           // 草莓
          else if (r > 0.15 && r < 0.55 && r - b > 0.06) matId = MAT.glossy; // 巧克力
        }
        mb.vert(model.pos[o], model.pos[o + 1], model.pos[o + 2],
          model.nrm[o], model.nrm[o + 1], model.nrm[o + 2],
          c, matId, model.uv ? [model.uv[i * 2], model.uv[i * 2 + 1]] : null);
      }
      for (let i = 0; i < model.idx.length; i++) mb.idx.push(model.idx[i]);
      return mb.merge(buildCandlesOnly(pal, candleDefs));
    }
    return buildMesh(pal, quality);
  }

  let mesh = composeMesh();
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  const vao = gl.createVertexArray();
  let vertCount = 0;
  let triCount = 0;

  function upload() {
    vertCount = mesh.pos.length / 3;
    triCount = mesh.triangles;
    const stride = 12;
    const data = new Float32Array(vertCount * stride);
    for (let i = 0; i < vertCount; i++) {
      const o = i * stride;
      const s = i * 3;
      data[o] = mesh.pos[s];
      data[o + 1] = mesh.pos[s + 1];
      data[o + 2] = mesh.pos[s + 2];
      data[o + 3] = mesh.nrm[s];
      data[o + 4] = mesh.nrm[s + 1];
      data[o + 5] = mesh.nrm[s + 2];
      data[o + 6] = mesh.col[s];
      data[o + 7] = mesh.col[s + 1];
      data[o + 8] = mesh.col[s + 2];
      data[o + 9] = mesh.mat[i];
      data[o + 10] = mesh.uv[i * 2];
      data[o + 11] = mesh.uv[i * 2 + 1];
    }

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const bpe = 4;
    const aPos = gl.getAttribLocation(progSurf, 'aPos');
    const aNormal = gl.getAttribLocation(progSurf, 'aNormal');
    const aAlbedo = gl.getAttribLocation(progSurf, 'aAlbedo');
    const aUV = gl.getAttribLocation(progSurf, 'aUV');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride * bpe, 0);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, stride * bpe, 3 * bpe);
    gl.enableVertexAttribArray(aAlbedo);
    // vec4：rgb 是固有色，a 是材质编号
    gl.vertexAttribPointer(aAlbedo, 4, gl.FLOAT, false, stride * bpe, 6 * bpe);
    if (aUV >= 0) {
      gl.enableVertexAttribArray(aUV);
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, stride * bpe, 10 * bpe);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const useUint32 = vertCount > 65535;
    const idx = useUint32 ? new Uint32Array(mesh.idx) : new Uint16Array(mesh.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return useUint32;
  }

  let indexType = gl.UNSIGNED_SHORT;
  try {
    indexType = upload() ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  } catch (err) {
    console.warn('[cake3d] 几何上传失败', err);
    disposeGL();   // vbo/ibo/vao 已建，不能泄漏 context
    return null;
  }

  /* ---------- 精灵（火苗 / 烟 / 阴影） ---------- */

  const quadVbo = gl.createBuffer();
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ]), gl.STATIC_DRAW);
  const aQuad = gl.getAttribLocation(progSprite, 'aQuad');
  gl.enableVertexAttribArray(aQuad);
  gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 8, 0);
  gl.bindVertexArray(null);

  const uS = {};
  for (const n of ['uProj', 'uView', 'uModel', 'uEye', 'uKeyDir', 'uKeyColor', 'uFillDir',
    'uFillColor', 'uSkyColor', 'uGroundColor', 'uCandlePos', 'uCandleColor', 'uCandlePower', 'uTex']) {
    uS[n] = gl.getUniformLocation(progSurf, n);
  }
  const uP = {};
  for (const n of ['uProj', 'uView', 'uCenter', 'uSize', 'uRight', 'uUp', 'uKind', 'uColor', 'uColor2', 'uAlpha',
    'uTime', 'uBend']) {
    uP[n] = gl.getUniformLocation(progSprite, n);
  }

  /* ---------- 贴图 ---------- */

  /* 先绑一张 1×1 白：没贴图的绘制也合法，模型到位后整个换掉 */
  let tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  /* ---------- 状态 ---------- */

  const proj = mat4();
  const viewv = mat4();
  const modelMat = mat4();
  const TARGET = [0, 0.76, 0];
  /* 归一化空间里要装进画布的范围。
     FILL 是「画面被蛋糕占掉的比例」——0.8 表示蛋糕最多占 80%，
     剩下的留给上下左右的余量。数字越小蛋糕越大，但要留够呼吸空间：
     竖直方向还要放火苗光晕、接地阴影，水平方向要留转起来时的摆动。 */
  const FILL = 0.97;
  let MODEL_TOP = 1.05;      // 竖直方向要装下的总高（盘底 → 火苗光晕）
  let MODEL_R = 0.66;        // 水平方向要装下的半径（归一化后 XZ）

  let width = 300;
  let height = 300;
  let aspect = 1;
  let camDist = 3.7;

  let angle = 0.6;          // 转台角度
  let spinVel = 0;          // 拖动惯性
  let dragging = false;
  let lastX = 0;

  let breath = 0;           // 0..1 吹气强度
  let blownOut = false;
  let outStart = -1;        // blowOut() 的时刻，逐根错峰熄灭从这里起算
  let time = 0;

  const smoke = [];
  const smokeDone = [];     // 每根蜡烛的烟只冒一次
  let stats = { frames: 0, drawCalls: 0 };

  /* ---------- 尺寸 ---------- */

  /* ---------- 每帧复用的常量缓冲 ----------
     ⚠️ 原来 frame() 每帧 new 出 30+ 个短命数组（sprite 调用点最密集：
     每根蜡烛每帧传 [1,0,0] / [0,1,0] / 位置 / 尺寸共 4 个，单根 5 个
     sprite = 20 个），加上 outT、scaleRgb()×4、uCandlePos 内联、eye、
     flamePosOf()×2 —— 60fps 下 1800+/s 的年轻代分配。单独看每帧几个
     不致命，但这个场景本来就在做最重的顶点变换，低端安卓上和 GC
     抖动叠加会体现为掉帧。
     颜色相关的（scaleRgb）随主题变，不能提到模块级；几何常量可以。 */
  const AXIS_X = new Float32Array([1, 0, 0]);
  const AXIS_Y = new Float32Array([0, 1, 0]);
  const UP_Y = new Float32Array([0, 1, 0]);
  const KEY_DIR = new Float32Array([-0.42, -0.86, -0.52]);
  const FILL_DIR = new Float32Array([0.66, -0.30, 0.62]);
  const SHADOW_POS = new Float32Array([0, -0.02, 0]);
  const SHADOW_SIZE = new Float32Array([2.20, 1.90]);
  const eyeBuf = new Float32Array(3);
  const candlePosBuf = new Float32Array(3);
  /* 逐根蜡烛的熄灭进度，长度按需增长后复用 */
  const outT = [];

  /* 🔴 释放全部 GL 对象 + 放弃 context。
     必须独立成函数，因为构造期有两个失败分支要复用它：
     ① program 编译失败（progSurf 可能已建好，progSprite 的 shader 已被
        compile 删掉但 program 还没建）
     ② 几何上传失败（vbo/ibo/vao/quadVbo/quadVao/tex/两个 program 全在）
     原来这两处直接 `return null`，带着已分配的资源离开，而 canvas 元素
     仍在 DOM 里（cake.js 只是让它保持 display:none）—— WebGL context
     不会被回收。移动端浏览器对同时存活的 WebGL context 有硬上限
     （iOS 更严），泄漏一个就等于少一个可用位。 */
  function disposeGL() {
    for (const b of [vbo, ibo, quadVbo]) if (b) gl.deleteBuffer(b);
    for (const v of [vao, quadVao]) if (v) gl.deleteVertexArray(v);
    for (const p of [progSurf, progSprite]) if (p) gl.deleteProgram(p);
    if (tex) { gl.deleteTexture(tex); tex = null; }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /* 机位求解与尺寸分开。
     ⚠️ 原来取景计算写在 resize() 的尺寸分支里，而 loadModel() 换装完模型后
     调 resize() 想立刻重算 camDist —— 但那时 width/height 已被 start() 里那次
     resize() 赋过同样的值，首行`if (w === width && h === height) return;`
     直接早退 → camDist/proj 保持程序化蛋糕的取值，那整段「按模型实际范围
     取景」在绝大多数情况下是死代码（要等用户真的改窗口大小才生效）。
     现在 resize() 无条件调 updateCamera()，模型换装走同一条路径。 */
  function updateCamera() {
    /* 机位按**两个方向都要装得下**来算，不能只按 aspect 二选一。
       之前是 `aspect < 0.9 ? 4.15 : 3.8`，结果极窄画布（aspect < 0.6）即使
       退到 4.15 盘子两侧仍然出框 —— 蛋糕左右被切断（v1.6.5 修）。
       现在按「模型投影半径 / 该方向可视半高」连续求解：
         竖直：需要装下 0 → 火苗光晕顶端（含盘底余量）
         水平：需要装下 ±R（R = 归一化后 XZ 半径）
       取两者所需距离的较大值，再留一点余量。 */
    const R = MODEL_R;
    const halfFovY = (14.5 * Math.PI) / 180;   // 略小于 15°，留一点安全边
    /* 两个方向各要装下的半跨度，乘 FILL 就是「实际要占画布的比例」。
       除以 FILL 而不是乘 —— 要的是「蛋糕占 84%」，FILL 越小越大。 */
    const needV = ((MODEL_TOP + 0.04) / Math.tan(halfFovY)) / FILL;
    const needH = ((R + 0.03) / (Math.tan(halfFovY) * Math.max(aspect, 0.2))) / FILL;
    camDist = Math.max(needV, needH) + TARGET[1] * 0.30;
    perspective(proj, (30 * Math.PI) / 180, aspect, 0.1, 30);
  }

  function resize() {
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 300;
    /* DPR 不是一成不变的：移动端 Safari 地址栏收起/展开、双指缩放都会改
       devicePixelRatio。原来只在构造时取一次，之后画面按旧 DPR 拉伸发虚。*/
    const d = currentDpr();
    if (w !== width || h !== height || d !== dpr) {
      width = w;
      height = h;
      dpr = d;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      aspect = w / Math.max(1, h);
    }
    updateCamera();
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  /* ---------- 绘制 ---------- */

  function sprite(center, size, right, up, kind, colorA, colorB, alpha, bend) {
    gl.uniform3fv(uP.uCenter, center);
    gl.uniform2fv(uP.uSize, size);
    gl.uniform3fv(uP.uRight, right);
    gl.uniform3fv(uP.uUp, up);
    gl.uniform1i(uP.uKind, kind);
    gl.uniform3fv(uP.uColor, colorA);
    gl.uniform3fv(uP.uColor2, colorB || colorA);
    gl.uniform1f(uP.uAlpha, alpha);
    gl.uniform1f(uP.uTime, time);
    gl.uniform1f(uP.uBend, bend || 0);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    stats.drawCalls += 1;
  }

  function frame(dt) {
    time += dt;
    angle += spinVel * dt;

    // 拖动惯性衰减，停下来后回到匀速自转
    if (!dragging) {
      spinVel += (0.13 - spinVel) * Math.min(1, dt * 1.6);
    } else {
      spinVel *= Math.pow(0.02, dt);
    }

    const cs = Math.sin(angle);
    const cc = Math.cos(angle);
    /* 吹气对火苗的影响分两件事，各管一头：
       gust  —— 火焰**高度**被压矮（空气把热量带走，火苗站不住）
       breath 本身在着色器里当 uBend 用，负责把轮廓**吹歪**。
       只压亮度是最假的一种做法，看起来像有人在调亮度。 */
    const gust = 1 - 0.62 * breath;
    const flicker = 1 + 0.10 * Math.sin(time * 17.0) + 0.05 * Math.sin(time * 29.0 + 1.7);

    /* 逐根蜡烛的熄灭进度：blowOut 后从第 0 根起每 0.16s 压灭一根，
       每根在压灭过半时冒自己的烟。蜡烛灭掉几根，点光就暗几分。 */
    if (outT.length !== candleDefs.length) outT.length = candleDefs.length;
    else outT.fill(0);
    let litSum = 0;
    for (let i = 0; i < candleDefs.length; i++) {
      let o = 0;
      if (blownOut && outStart >= 0) {
        o = Math.min(1, Math.max(0, (time - outStart - i * 0.16) / 0.30));
      }
      outT[i] = o;
      litSum += 1 - o;
      if (o > 0.4 && !smokeDone[i]) {
        smokeDone[i] = true;
        const f = flamePosOf(candleDefs[i]);
        const wx = cc * f[0] + cs * f[2];
        const wz = -cs * f[0] + cc * f[2];
        for (let k = 0; k < 5; k++) {
          smoke.push({
            x: wx + (Math.random() - 0.5) * 0.05,
            y: f[1] + 0.02,
            z: wz + (Math.random() - 0.5) * 0.05,
            life: 1.6 + Math.random() * 0.9,
            max: 1.6 + Math.random() * 0.9,
            rise: Math.random() * 0.22,
            seed: Math.random() * 6.28,
            color: mix(pal.shadow, [1, 1, 1], 0.45),
          });
        }
      }
    }
    const litAvg = candleDefs.length ? litSum / candleDefs.length : 0;
    const candlePower = Math.max(0, litAvg * (1 - 0.75 * breath)) * 0.95 * flicker * 0.55;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // 相机：固定机位、略微俯视。转的是蛋糕本身（转台），相机不动
    const elev = 0.22;
    eyeBuf[0] = 0;
    eyeBuf[1] = TARGET[1] + camDist * Math.sin(elev);
    eyeBuf[2] = camDist * Math.cos(elev);
    const eye = eyeBuf;
    lookAt(viewv, eye, TARGET, UP_Y);
    rotY(modelMat, angle);

    // 蛋糕本体
    gl.useProgram(progSurf);
    gl.uniformMatrix4fv(uS.uProj, false, proj);
    gl.uniformMatrix4fv(uS.uView, false, viewv);
    gl.uniformMatrix4fv(uS.uModel, false, modelMat);
    gl.uniform3fv(uS.uEye, eye);
    /* 贴图路径的光照要压暗一档。
       贴图的 albedo 本身**已经烘焙了明暗**（它是从一张照片/渲染图投影来的），
       再乘一遍同等强度的光等于双重打光 → 通量 > 1.5，深色（巧克力字、红草莓）
       直接过曝成白色，蛋糕上那几个巧克力字就消失在白里（v1.6.5 修）。
       程序化材质没有这个问题 —— 它的固有色是平涂的色值，本来就该被光乘。 */
    const dim = model && model.textured ? 0.72 : 1;
    gl.uniform3fv(uS.uKeyDir, KEY_DIR);
    gl.uniform3fv(uS.uKeyColor, scaleRgb(pal.key, 0.92 * dim));
    gl.uniform3fv(uS.uFillDir, FILL_DIR);
    gl.uniform3fv(uS.uFillColor, scaleRgb(pal.fill, 0.42 * dim));
    gl.uniform3fv(uS.uSkyColor, scaleRgb(pal.skyAmbient, 0.60 * dim));
    gl.uniform3fv(uS.uGroundColor, scaleRgb(pal.groundAmbient, 0.42 * dim));
    // 烛光挂在各火苗的质心上，跟着转台一起转，否则光会「穿过」蜡烛
    let sx = 0, sy = 0, sz = 0;
    for (const d of candleDefs) {
      const f = flamePosOf(d);
      sx += f[0]; sy += f[1]; sz += f[2];
    }
    const cn = Math.max(1, candleDefs.length);
    candlePosBuf[0] = (sx / cn) * cc + (sz / cn) * cs;
    candlePosBuf[1] = sy / cn;
    candlePosBuf[2] = -(sx / cn) * cs + (sz / cn) * cc;
    gl.uniform3fv(uS.uCandlePos, candlePosBuf);
    gl.uniform3fv(uS.uCandleColor, pal.candleLight);
    /* 常驻项刻意压低到 0.22：烛光熄灭时这一项是唯一的暖光来源，
       给太高（原来 0.55）会看不出「吹灭后暗下来」的落差。 */
    gl.uniform1f(uS.uCandlePower, 0.22 + candlePower * 1.5);
    /* 贴图绑定必须用主几何 program 的 uniform（uS 来自 progSurf，含 uTex）。
       命名容易混：uS = Surface（主几何），uP = sPrite（火苗/烟/阴影那些片）。
       漏绑 uS.uTex 时贴图路径下 `texture(uTex, vUV)` 恒采样到 0，
       蛋糕渲染成**纯白**，蛋糕上那几个巧克力字全都看不清（v1.6.5 修）。 */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uS.uTex, 0);
    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, triCount * 3, indexType, 0);
    stats.drawCalls = 1;

    // 精灵：先接地阴影，再火苗与烟
    gl.useProgram(progSprite);
    gl.uniformMatrix4fv(uP.uProj, false, proj);
    gl.uniformMatrix4fv(uP.uView, false, viewv);
    gl.disable(gl.CULL_FACE);      // 精灵是双面片，背面剔除会把它们整片吃掉
    gl.enable(gl.BLEND);

    /* 接地阴影：朝向相机的竖直片（billboard），中心略沉到盘子底面以下。

       为什么不用「平躺在 XZ 平面」：那样俯视确实能把它摊开，但阴影会
       从蛋糕前方一路铺到画面下缘，像一滩水；竖直片才只贴在蛋糕脚下那一圈。
       原来那张片的问题不是朝向，而是尺寸太小（1.58×0.40）又太淡（alpha 0.38）——
       复算下来只有 12px 露在蛋糕底下，叠上 smoothstep 边缘衰减之后基本看不见，
       蛋糕像浮在半空。现在放大到 2.20×1.90 并把 alpha 提到 0.62。

       深度测试开着、但不写深度：蛋糕本体会挡住中间那片，只在四周留一圈柔和的暗，
       正好是「东西放在纸上」该有的样子。y 取 -0.02 让影子中心沉到盘底之下，
       避免与最低那一圈共面时闪出一条亮缝。 */
    gl.depthMask(false);
    /* ⚠️ 必须是预乘 alpha 的混合。着色器输出的是 vec4(col * a, a)，
       context 也开了 premultipliedAlpha:true —— 那 blendFunc(SRC_ALPHA,
       ONE_MINUS_SRC_ALPHA) 会**再乘一遍 alpha**，等效于 a²。
       结果是阴影比上面调好的 0.62 更暗、边缘更硬，和旁边的火焰叠起来
       有一圈明显的「实边」。火焰 pass 用的是 blendFunc(ONE, ONE)，
       那才是预乘的正确用法 —— 两处必须一致。 */
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    sprite(SHADOW_POS, SHADOW_SIZE, AXIS_X, AXIS_Y, 2,
      scaleRgb(pal.shadow, 1), null, 0.62);
    gl.depthMask(true);

    // 火苗与烟要用加色混合，且不参与深度 —— 光不该被蜡烛挡住
    gl.disable(gl.DEPTH_TEST);
    gl.blendFunc(gl.ONE, gl.ONE);

    // 逐根火苗。真实的烛火是**三层**：外焰（暗红、跳动）、
    // 焰体（橙黄）、根部内焰（最亮的小蓝白）。只画一层就是「发光的图片」。
    for (let i = 0; i < candleDefs.length; i++) {
      const f = flamePosOf(candleDefs[i]);
      const wx = cc * f[0] + cs * f[2];
      const wz = -cs * f[0] + cc * f[2];
      const outI = outT[i];
      const flickI = 1 + 0.08 * Math.sin(time * 13.0 + i * 2.1) + 0.04 * Math.sin(time * 31.0 + 1.7 + i * 1.3);
      const power = (1 - outI) * gust * flickI;
      if (power <= 0.02) continue;
      /* 吹气：火焰被吹歪（bend）并且压矮。
         真实的一口气不是「火变暗」，而是**先把整条火焰推倒、轮廓拉长**，
         强度够了才断 —— 只做亮度变化看起来像调光，不像吹。 */
      const bend = breath * 0.55;
      const h = (0.7 + power * 0.42) * (1 - outI * 0.72);
      const wBase = 0.085 * h * (1 + breath * 0.35);
      const wob = Math.sin(time * 7.0 + i * 2.4) * 0.008;

      // 外焰：比焰体大一圈、矮一些，颜色最暗
      sprite([wx + bend * 0.045, f[1] + 0.030 + outI * 0.015, wz + bend * -0.045],
        [wBase * 2.5, 0.135 * h], AXIS_X, AXIS_Y, 0,
        pal.flameOuter, null, 0.30 * power, bend);
      // 外晕：被烤亮的那圈空气，比外焰再大一圈、最软
      sprite([wx, f[1] + 0.02, wz],
        [0.24 * h, 0.26 * h], AXIS_X, AXIS_Y, 3,
        pal.flameHalo, null, 0.16 * power, 0);
      // 焰体：主体
      sprite([wx + bend * 0.030 + wob, f[1] + 0.042 + outI * 0.018, wz + bend * -0.030 - wob],
        [wBase, 0.145 * h], AXIS_X, AXIS_Y, 0,
        pal.flameCore, pal.flameOuter, Math.min(1, power), bend);
      // 根部内焰：贴着烛芯那一小段，最亮 —— 没有它火会「飘」
      sprite([wx + bend * 0.014, f[1] + 0.012, wz + bend * -0.014],
        [wBase * 0.72, 0.045 * h], AXIS_X, AXIS_Y, 0,
        [1.0, 0.95, 0.86], null, 0.75 * power, bend * 0.5);
    }

    /* 吹灭后的几缕烟。真实的烟是**一边上升一边被吹散、越升越淡越宽**，
       不是一团均匀放大的软边 —— 这里让它横向漂移随 breath 加强，
       并用寿命驱动透明度衰减（白烟在暗背景上是慢慢散开的）。 */
    for (const p of smoke) {
      if (p.life <= 0) continue;
      const t = 1 - p.life / p.max;
      const drift = Math.sin(t * 3.4 + p.seed) * 0.05 + breath * 0.10;
      sprite([p.x + drift, p.y + t * 0.10, p.z + drift * -0.6],
        [0.10 + t * 0.34, 0.14 + t * 0.46],
        AXIS_X, AXIS_Y, 1, p.color, null,
        (p.life / p.max) * 0.38 * (1 - t * 0.45));
    }

    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    stats.frames += 1;
  }

  /* ---------- 动画循环 ---------- */

  let raf = null;
  let last = 0;
  let running = false;
  let frameNo = 0;
  let onScreen = true;

  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;

    // 每 6 帧量一次位置：不在视口就跳过绘制（不清屏，滚回来直接接上）
    if (frameNo++ % 6 === 0) {
      const r = canvas.getBoundingClientRect();
      const vh = window.innerHeight || 0;
      onScreen = r.bottom > -200 && r.top < vh + 200;
    }

    if (!document.hidden && onScreen && canvas.isConnected) {
      updateSmoke(dt);
      frame(dt);
    }
  }

  function updateSmoke(dt) {
    for (const p of smoke) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.y += dt * (0.34 + p.rise);
      p.x += Math.sin(p.y * 5.5 + p.seed) * dt * 0.10;
      p.z += Math.cos(p.y * 4.1 + p.seed) * dt * 0.07;
    }
  }

  /* ---------- 交互：左右拖动转蛋糕（纵向留给页面滚动） ---------- */

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    spinVel = 0;
  }

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    angle += dx * 0.010;
    spinVel = Math.max(-2.2, Math.min(2.2, -dx * 0.06));
  }

  function onUp() {
    dragging = false;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onUp);

  // 上下文丢失（安卓上切后台回来偶发）→ 通知调用方退回平面蛋糕
  let onLost = null;
  /* ⚠️ 丢失时必须一并释放订阅，与 destroy() 一致。
     preventDefault() 之后浏览器会尝试恢复，但这里**没有**
     webglcontextrestored 处理器 —— 丢了就等于永久放弃（cake.js 会
     切no3d）。若不释放：
       丢失后任何一次 resize → RO 触发 renderOnce() → 在已丢失的 context
         上跑完整 frame()；
       丢失后切主题 → 主题回调跑 recompose() → **重建整份几何（几万个
         顶点）再 upload 到死context 上**，纯浪费且阻塞主线程。 */
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    running = false;
    cancelAnimationFrame(raf);
    if (roPending) { cancelAnimationFrame(roPending); roPending = 0; }
    ro?.disconnect();
    unsubTheme();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('pointerleave', onUp);
    onLost?.();
  });

  const unsubTheme = onThemeChange(() => {
    pal = readPalette();
    // 蜡烛/程序化蛋糕的颜色编译在顶点里，换主题重建几何
    // （贴图模型的像素不变，变的只是灯光 uniform，重建成本一次几毫秒）
    recompose();
  });

  /* ---------- 模型异步换装 ----------
     进场景时程序化蛋糕先顶着（首帧不等网络），后台把 GLB 拉下来：
     解析 → 落地归一化 → 蜡烛射线贴面 → 重建上传，画一帧静态的立即生效。
     任何一步失败都静默留在程序化蛋糕，绝不让她看到空白。 */

  function recompose() {
    mesh = composeMesh();
    try { indexType = upload() ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT; } catch { /* 保持原样 */ }
    if (!running) renderOnce();
  }

  function decodeImage(bytes, type) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(new Blob([bytes], { type }));
    }
    // 老内核兜底：objectURL + <img>
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  function uploadTexture(src) {
    if (tex) gl.deleteTexture(tex);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    /* 贴图路径的纹理坐标来自模型自带 UV，方向与 <img> 一致（不需要 UNPACK_FLIP_Y，
       烘焙阶段已按 GL 约定生成）。 */
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, max));
    }
    /* ⚠️ ImageBitmap 必须 close()。它背后是独立的 GPU/堆外分配，
       **不属于** WebGL 对象的自动回收范畴 —— 切主题重上传时旧的那张
       会一直占着（老 <img> 兜底路径不需要，img 会被 GC）。
       必须在 texImage2D 之后（数据已拷进纹理）再关。 */
    if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) src.close();
    return t;
  }

  /* 模型走阿里云 OSS（绝对 URL），站点在 InfinityFree 上，两者跨域。
     这里要同时应付三种拦截，两种都踩过：
     ① InfinityFree 的 JS 挑战页：任何请求先返回 856 字节 HTML
        （加载 /aes.js → slowAES 算 __test cookie → 跳 ?i=1），
        fetch 拿到的是 200 + text/html而不是 GLB。
     ② CORS：跨域 fetch 若 OSS 没配 CORS 规则，浏览器直接拒绝
        （TypeError: Failed to fetch，控制台报 ERR_FAILED 200）。
        ⚠️ 用 curl/Node 测**测不出来** —— 它们不受同源策略约束。
        只有真正在浏览器里跑才暴露（v1.6.8 首次接OSS 时踩到）。
     所以顺序是：先 fetch（能被CDN 缓存、能显示进度）；
     抛 TypeError/Failed to fetch 时判定为 CORS → 换 XMLHttpRequest
     拿 ArrayBuffer（XHR 同样受同源策略，但服务端若返回
     Access-Control-Allow-Origin 就能过；OSS 配了 CORS 时走的是这条）。
     无论哪条，成功后都先验 glTF magic 再解析，绝不把 HTML 当模型。 */
  function isCorsError(e) {
    return e instanceof TypeError || /Failed to fetch|NetworkError|load failed/i.test(e && e.message || '');
  }

  async function fetchViaXHR(url) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.responseType = 'arraybuffer';
      x.timeout = 120000;
      x.onload = () => {
        if (x.status >= 200 && x.status < 300 || x.status === 304) {
          resolve(x.response);
        } else {
          reject(new Error('HTTP ' + x.status));
        }
      };
      x.onerror = () => reject(new Error('XHR 网络错误（CORS 未放行？）'));
      x.ontimeout = () => reject(new Error('XHR 超时'));
      x.send();
    });
  }

  /* 取模型二进制：返回 ArrayBuffer。失败时抛带可读信息的 Error。 */
  async function fetchModelBuffer(url) {
    let buf = null;
    let corsBlocked = false;
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      buf = await res.arrayBuffer();
    } catch (e) {
      if (isCorsError(e)) { corsBlocked = true; }
      else throw e;
    }

    if (buf === null) {
      // fetch 被同源策略拦了 → 换 XHR 再试一次
      try {
        buf = await fetchViaXHR(url);
      } catch (e2) {
        if (corsBlocked) {
          throw new Error('模型跨域被拦：请给 OSS 配置 CORS 规则（AllowedOrigin 填 *）');
        }
        throw e2;
      }
    }

    // glTF magic：0x46546C67 ('glTF')
    if (!buf || buf.byteLength < 12 || new DataView(buf).getUint32(0, true) !== 0x46546C67) {
      // 认CDN 挑战页：内容是 <!DOCTYPE/<html
      const head = new TextDecoder().decode(new Uint8Array(buf || new ArrayBuffer(0), 0,
        Math.min(64, buf ? buf.byteLength : 0)));
      if (/<!DOCTYPE|<html/i.test(head)) {
        throw new Error('CDN 挑战页拦截了模型请求（不是 GLB）');
      }
      throw new Error('不是 GLB v2');
    }
    return buf;
  }

  async function loadModel(url) {
    try {
      let buf;
      try {
        buf = await fetchModelBuffer(url);
      } catch (firstErr) {
        // 第一次被挑战页/CORS 拦下 → 带 ?i=1 再试（cookie 到位时通常直接命中真模型）
        const retry = url + (url.includes('?') ? '&' : '?') + 'i=1';
        try {
          buf = await fetchModelBuffer(retry);
        } catch {
          throw firstErr;
        }
      }
      const parsed = parseGLB(buf);
      const geo = {
        pos: parsed.pos,
        nrm: parsed.nrm,
        uv: parsed.uv,
        col: parsed.col,
        idx: parsed.idx,
        image: parsed.image,
        textured: false,
      };
      const h = normalizeGeometry(geo, 1.30 * modelScale);
      // 蜡烛贴着任何模型的表面（牌子/雪人上不去，落点在 config 里避开）
      for (const d of candleDefs) {
        const y = surfaceTopY(geo, d.x, d.z);
        d.y0 = (y > 0 ? y : h) - 0.012;
      }
      if (!geo.nrm) geo.nrm = computeNormals(geo.pos, geo.idx);
      // 相机目标高度跟着模型走，取景不塌
      TARGET[1] = Math.min(0.78, Math.max(0.5, h * 0.5));

      /* 取景要装下的实际范围：从最高顶点往下量，加上蜡烛与光晕。
         之前的 camDist 是写死的经验值，换个模型高度就可能两侧出框。 */
      let maxR = 0;
      for (let i = 0; i < geo.pos.length; i += 3) {
        const dx = geo.pos[i], dz = geo.pos[i + 2];
        const r = Math.hypot(dx, dz);
        if (r > maxR) maxR = r;
      }
      MODEL_R = maxR;
      let topY = 0;
      for (let i = 1; i < geo.pos.length; i += 3) {
        if (geo.pos[i] > topY) topY = geo.pos[i];
      }
      // 蜡烛落在顶面，加上烛身与火焰光晕
      MODEL_TOP = topY + 0.30;   // +0.30：烛焰是 billboard，光晕顶端还要再往上伸一段，
                                        // 少一点就会切顶（实测 0.18 会切）
      resize();               // 模型换了 → 取景范围变了，立刻重算 camDist
      model = geo;
      recompose();
      /* 切贴图路径的判据：**只有模型没带顶点色时**才切。
         带 COLOR_0 的模型（AI 图生 3D 转制来的）一律用顶点色 + 真实光照 ——
         那张 baseColor atlas 实测约 9% 是灰区，糊成一片后蛋糕没有本体感。 */
      if (geo.image && !geo.col) {
        /* 贴图解码失败**只降级材质，不丢模型**。
           原来这行 await 在 try 块里，一张图解不出来就整个 catch 掉、
           静默换成程序化蛋糕 —— 现象是「模型明明是好的却变了个样子」，
           极难定位（v1.6.5 修）。贴图只是「锦上添花」，缺了用纯色也能画。 */
        try {
          const src = await decodeImage(geo.image.bytes, geo.image.type);
          tex = uploadTexture(src);
          geo.textured = true;
        } catch (imgErr) {
          console.warn('[cake3d] 贴图解码失败，模型改用纯色绘制', imgErr);
        }
        recompose();
      }
    } catch (err) {
      console.warn('[cake3d] 模型加载失败，继续用程序化蛋糕', err);
    }
  }

  if (modelUrl) loadModel(modelUrl);

  /* 尺寸监听是必须的，而且必须是它来触发第一帧：
     构造函数里还没有布局（canvas 此时可能还是 display:none），
     投影矩阵会停在零矩阵上 —— 表现是画布彻底空白，很难查。 */
  /* ⚠️ ResizeObserver 必须防抖，否则吹灭收矮那0.7s 里每帧都会触发一次
     （CSS 有 `transition: height 0.7s`）→ 每帧 resize() + renderOnce()
     → 掉帧卡顿，且控制台刷
     「ResizeObserver loop completed with undelivered notifications」
     （浏览器在报告这一帧的观察结果没派发完，下一帧又来了）。
     running 时不重绘：主循环本来就会画，重画是白费。
     用 rAF 合批：一帧内多次尺寸变化只处理最后一次。*/
  let roPending = 0;
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (roPending) return;
        roPending = requestAnimationFrame(() => {
          roPending = 0;
          resize();
          if (!running) renderOnce();
        });
      })
    : null;
  ro?.observe(canvas);

  function renderOnce() {
    resize();
    frame(0.016);
  }

  return {
    start() {
      // 先量一次尺寸：Canvas 的物理尺寸必须由这里决定，
      // 否则会拿默认的 300x150 去拉伸
      resize();
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      raf = null;
      // 掐掉挂起的 ResizeObserver 帧：停后若还有一帧待执行，会白重绘一次
      if (roPending) { cancelAnimationFrame(roPending); roPending = 0; }
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      if (roPending) { cancelAnimationFrame(roPending); roPending = 0; }
      unsubTheme();
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onUp);
      disposeGL();
    },
    /** 减少动效档：只画一帧，不进循环 —— 静态但仍是真 3D */
    renderOnce,
    onContextLost(fn) { onLost = fn; },

    /** 0..1 的吹气强度：压火苗、压烛光 */
    setBreath(v) {
      breath = Math.max(0, Math.min(1, Number(v) || 0));
    },
    blowOut() {
      if (blownOut) return;
      blownOut = true;
      outStart = time;
    },
    /** 重新进入这一幕时把蜡烛点回去 */
    relight() {
      blownOut = false;
      outStart = -1;
      breath = 0;
      smoke.length = 0;
      smokeDone.fill(false);
    },

    /** 供验证用：三角形数、绘制次数、帧数 */
    stats() {
      return {
        triangles: triCount,
        vertices: vertCount,
        drawCalls: stats.drawCalls,
        frames: stats.frames,
        dpr,
        size: [canvas.width, canvas.height],
        webgl2: true,
        model: !!model,
        textured: !!(model && model.textured),
        candles: candleDefs.length,
      };
    },
    /** 供验证用：立刻画一帧并回读像素，判断真的画出了东西 */
    samplePixels() {
      resize();
      frame(0.016);
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let opaque = 0;
      let warm = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] > 8) {
          opaque += 1;
          if (px[i] > px[i + 2] + 12) warm += 1;
        }
      }
      return {
        total: canvas.width * canvas.height,
        opaque,
        warm,
        ratio: +(opaque / (canvas.width * canvas.height)).toFixed(4),
      };
    },
  };
}
