/* ==========================================================================
   fx.js · Canvas 特效：星空、彩带、烟花

   颜色全部从 CSS 变量读取，切主题时由 onThemeChange 触发重取。
   亮色主题自动换成柔光与静态飘落 —— 浅色底上放发光粒子和烟花会显得脏。
   这个「柔光还是发光」的判断来自主题的明暗，不是 data-effects：
     data-effects 只管性能档（full / lite），明暗是配色的事。
   ========================================================================== */

import { rand, pick, clamp } from './dom.js';
import { isDarkTheme, onThemeChange } from './theme.js';

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* 调色板缓存。
   原来 palette() 每次调用都做 4 次 getComputedStyle，而 Fireworks.draw()
   在循环体里反复调它 —— 单帧能触发 20 次以上样式重算。
   现在只在切主题时失效重取。 */
let cachedPalette = null;
let cachedFor = null;

function palette() {
  const theme = document.documentElement.dataset.theme || '';
  if (cachedPalette && cachedFor === theme) return cachedPalette;

  cachedPalette = {
    accent: cssVar('--accent') || '#CC785C',
    accent2: cssVar('--accent-2') || '#D9A05B',
    text: cssVar('--text') || '#141413',
    bg: cssVar('--bg') || '#FAF9F5',
  };
  cachedFor = theme;
  return cachedPalette;
}

function softMode() {
  return !isDarkTheme();
}

/* 活着的图层。切主题时挨个通知重新取色 ——
   否则切到夜间后，Canvas 上的粒子还是日间的陶土色，在暖墨底上发暗发脏。 */
const liveLayers = new Set();

onThemeChange(() => {
  cachedPalette = null;
  cachedFor = null;
  liveLayers.forEach((layer) => {
    if (typeof layer.recolor === 'function') layer.recolor();
  });
});

/* --------------------------------------------------------------------------
   基础图层：统一处理 DPR、尺寸、可见性、动画循环
   -------------------------------------------------------------------------- */

/* 效果档。由 main.js 的特性检测写入 <html data-effects>。
     lite 档刻意**不关掉 Canvas** —— 规划里原本写的是关掉，但粒子是这个站点
     的情绪来源，直接砍掉损失太大。折中成"减半 + 降 DPR + 关毛玻璃"，
     真正完全不启动的只有用户主动要求减少动效的 calm 档。 */
function effectsLevel() {
  return document.documentElement.dataset.effects || 'full';
}

function particleScale() {
  const level = effectsLevel();
  if (level === 'calm') return 0;
  if (level === 'lite') return 0.5;
  return 1;
}

/* DPR 上限。
   原来写死 2：安卓中端机 DPR 普遍 2.75-3，一个全屏 Canvas 在 DPR=2 下
   就是约 2160x4800 物理像素，单帧 clearRect 要填 1000 万像素。
   降到 1.5 肉眼几乎看不出差别，填充量直接省掉 44%。
   lite 档再降到 1.25。 */
function dprCap() {
  return document.documentElement.dataset.effects === 'lite' ? 1.25 : 1.5;
}

class Layer {
  constructor(canvas, { alpha = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha });
    this.items = [];
    this.running = false;
    this.last = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, dprCap());
    this.onScreen = true;      // 视口内才绘制，见 tick()
    this.visCountdown = 0;     // 计数归零时才重新量一次布局
    this.onResize = this.onResize.bind(this);
    this.tick = this.tick.bind(this);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  onResize() {
    // 默认只重算尺寸。
    // 这个默认实现是必需的：Layer 的构造函数与 start()/stop() 都要用 this.onResize，
    // 而子类未必都定义它。之前只有 Starfield 定义了，导致 Confetti 与 Fireworks
    // 在构造时执行 this.onResize.bind 直接抛 TypeError —— 彩带和烟花从来没显示过。
    this.resize();
  }

  start() {
    if (this.running) return;

    // calm 档：直接把画布留空，不进动画循环。
    // 对象照常返回，调用方不必到处判空。
    if (effectsLevel() === 'calm') return;

    this.running = true;
    this.last = performance.now();
    liveLayers.add(this);
    window.addEventListener('resize', this.onResize);
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    liveLayers.delete(this);
    window.removeEventListener('resize', this.onResize);
  }

  /* 切主题时被调用。默认什么也不做，需要重新取色的子类覆盖它。 */
  recolor() {}

  destroy() {
    this.stop();
    this.items = [];
  }

  update() {}

  draw() {}

  tick(now) {
    if (!this.running) return;
    const dt = Math.min(48, now - this.last) / 16.667;
    this.last = now;

    /* 可见性判断。
       原来只判断 document.hidden —— 也就是说滚到别的幕后，这个 Canvas
       照样每帧跑 update + draw。而 puzzle / cake / scratch 三幕又都没有
       onLeave 去停自己的彩带层，于是同时会有四五个粒子层在空转。

       每 6 帧（约 100ms）才量一次布局，避免每帧读 getBoundingClientRect
       反而引起布局抖动。留 200px 余量，滚进视野时能提前恢复。 */
    if (--this.visCountdown <= 0) {
      this.visCountdown = 6;
      const r = this.canvas.getBoundingClientRect();
      this.onScreen = r.bottom > -200 && r.top < window.innerHeight + 200;
    }

    if (!document.hidden && this.canvas.isConnected && this.onScreen) {
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.update(dt);
      this.draw();
    }
    this.raf = requestAnimationFrame(this.tick);
  }
}

/* --------------------------------------------------------------------------
   星空：缓慢上浮的细小光点
   -------------------------------------------------------------------------- */

export class Starfield extends Layer {
  constructor(canvas, count = 48) {
    super(canvas);
    this.count = Math.max(8, Math.round(count * particleScale()));
    this.build();
  }

  build() {
    const { accent, text } = palette();
    this.items = Array.from({ length: this.count }, () => ({
      x: rand(0, this.w),
      y: rand(0, this.h),
      r: rand(0.5, 1.7),
      vy: rand(0.06, 0.28),
      vx: rand(-0.06, 0.06),
      a: rand(0.15, 0.65),
      tw: rand(0, Math.PI * 2),
      color: Math.random() < 0.18 ? accent : text,
    }));
  }

  onResize() { this.resize(); this.build(); }

  /** 切主题：按新调色板重建星点 */
  recolor() { this.build(); }

  update(dt) {
    for (const s of this.items) {
      s.y -= s.vy * dt;
      s.x += s.vx * dt;
      s.tw += 0.02 * dt;
      if (s.y < -4) { s.y = this.h + 4; s.x = rand(0, this.w); }
      if (s.x < -4) s.x = this.w + 4;
      if (s.x > this.w + 4) s.x = -4;
    }
  }

  draw() {
    const { ctx } = this;

    /* 按「颜色 + 透明度档位」分组批量填充。
       原来每个粒子单独 beginPath/arc/fill —— 48 个粒子就是 48 次路径构建，
       而同一帧里大多数粒子的颜色和透明度是重复的。
       把透明度量化成 6 档后，填充次数从 48 降到 10 左右。

       注意每个 arc 前要先 moveTo 到圆弧起点，否则会连出多余的直线。 */
    const buckets = new Map();

    for (const s of this.items) {
      const a = s.a * (0.65 + 0.35 * Math.sin(s.tw));
      const level = Math.max(0, Math.min(5, Math.round(a * 5)));
      const key = s.color + '|' + level;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { color: s.color, alpha: level / 5, pts: [] };
        buckets.set(key, bucket);
      }
      bucket.pts.push(s.x, s.y, s.r);
    }

    for (const { color, alpha, pts } of buckets.values()) {
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i];
        const y = pts[i + 1];
        const r = pts[i + 2];
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }
}

/* --------------------------------------------------------------------------
   彩带：暗色主题用扭转的缎带，亮色主题改成缓慢飘落的柔光片
   -------------------------------------------------------------------------- */

export class Confetti extends Layer {
  constructor(canvas, { count = 60, origin = { x: 0.5, y: -0.05 } } = {}) {
    super(canvas);
    this.count = Math.max(8, Math.round(count * particleScale()));
    this.origin = origin;
    this.soft = softMode();
    this.spawnAll();
  }

  spawnAll() {
    this.items = Array.from({ length: this.count }, (_, i) => this.makePiece(i, true));
    this.colors = [palette().accent, palette().accent2];
  }

  /* 切主题：柔光/发光模式可能变，调色板也变了，整批重建 */
  recolor() {
    this.soft = softMode();
    this.spawnAll();
  }

  makePiece(i = 0, staggered = false) {
    const { accent, accent2 } = palette();
    const color = Math.random() < 0.5 ? accent : accent2;
    return {
      x: rand(0, this.w),
      y: staggered ? rand(-this.h * 0.6, -10) : rand(-40, -6),
      w: rand(5, 9),
      h: rand(9, 16),
      vx: rand(-0.35, 0.35),
      vy: this.soft ? rand(0.25, 0.6) : rand(0.9, 2.0),
      rot: rand(0, Math.PI * 2),
      vr: this.soft ? rand(-0.01, 0.01) : rand(-0.09, 0.09),
      sway: rand(0, Math.PI * 2),
      swayAmp: rand(0.2, 0.9),
      alpha: this.soft ? rand(0.22, 0.5) : rand(0.65, 1),
      color,
      life: 0,
      maxLife: this.soft ? Infinity : rand(240, 420),
    };
  }

  burst(x = this.w / 2, y = -10, n = 40) {
    for (let i = 0; i < n; i++) {
      const p = this.makePiece();
      p.x = x + rand(-40, 40);
      p.y = y;
      p.vy = rand(1.2, 3.2);
      this.items.push(p);
    }
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life += dt;

      p.sway += 0.03 * dt;
      p.x += (p.vx + Math.sin(p.sway) * p.swayAmp * 0.6) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;

      if (!this.soft) p.vy = Math.min(4.2, p.vy + 0.012 * dt);

      if (p.y > this.h + 40 || (p.maxLife !== Infinity && p.life > p.maxLife)) {
        if (this.soft && p.y > this.h + 40) {
          this.items[i] = this.makePiece();
        } else if (this.soft) {
          this.items[i] = this.makePiece();
        } else {
          this.items.splice(i, 1);
        }
      }
    }

    // 暗色主题下保持总量，循环补充
    if (!this.soft && this.items.length < this.count && Math.random() < 0.06) {
      this.items.push(this.makePiece());
    }
  }

  draw() {
    const { ctx } = this;
    const d = this.dpr;

    /* 用一次 setTransform 完成「DPR + 平移 + 旋转」，
       替代每片一次的 save/translate/rotate/restore。
       32 片就是省下 32 组变换栈操作。 */
    for (const p of this.items) {
      const cos = Math.cos(p.rot);
      const sin = Math.sin(p.rot);

      ctx.setTransform(d * cos, d * sin, -d * sin, d * cos, d * p.x, d * p.y);
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;

      if (this.soft) {
        ctx.beginPath();
        ctx.ellipse(0, 0, p.w * 0.7, p.h * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 缎带：用扭折制造翻转感
        const twist = Math.sin(p.rot * 2);
        ctx.beginPath();
        ctx.moveTo(-p.w / 2, -p.h / 2);
        ctx.lineTo(p.w / 2 * twist, -p.h / 6);
        ctx.lineTo(-p.w / 2 * twist, p.h / 6);
        ctx.lineTo(p.w / 2, p.h / 2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 还原成 DPR 基准变换，否则同一 Canvas 上后续的绘制会错位
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.globalAlpha = 1;
  }
}

/* --------------------------------------------------------------------------
   烟花：先升空再炸开
   -------------------------------------------------------------------------- */

export class Fireworks extends Layer {
  constructor(canvas, { autoLaunch = true } = {}) {
    super(canvas);
    this.autoLaunch = autoLaunch;
    this.soft = softMode();
    this.rockets = [];
    this.sparks = [];
    this.cooldown = 0;
    this.heavy = false;

    // 亮色主题降低密度，避免脏
    this.rate = this.soft ? 0.006 : 0.016;
    this.sparkPerBurst = Math.max(10, Math.round((this.soft ? 26 : 62) * particleScale()));
  }

  /* 切主题：明暗变了，密度与速度要跟着变，否则亮底上会糊成一片 */
  recolor() {
    this.soft = softMode();
    this.rate = this.soft ? 0.006 : 0.016;
    this.sparkPerBurst = Math.max(10, Math.round((this.soft ? 26 : 62) * particleScale()));
  }

  launch(xRatio = null, yRatio = 0.72) {
    const x = this.w * (xRatio ?? rand(0.2, 0.8));
    const targetY = this.h * (yRatio + rand(-0.1, 0.1));
    this.rockets.push({
      x,
      y: this.h + 10,
      targetY,
      vy: rand(-2.4, -3.4) * (this.h / 600),
      trail: [],
    });
  }

  burst(x, y, count) {
    const { accent, accent2, text } = palette();
    const colors = [accent, accent2, text];
    const color = pick(colors);
    const speedBase = this.soft ? 2.0 : 3.6;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + rand(-0.05, 0.05);
      const speed = rand(0.35, 1) * speedBase * (this.h / 600);
      this.sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: rand(48, 96),
        color: Math.random() < 0.78 ? color : pick(colors),
        r: rand(1.1, 2.3),
      });
    }
  }

  update(dt) {
    const gravity = 0.026 * (this.h / 600);

    // 火箭
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.y += r.vy * dt;
      r.vy += 0.014 * dt;
      r.trail.push({ x: r.x, y: r.y });
      if (r.trail.length > 12) r.trail.shift();

      if (r.y <= r.targetY || r.vy >= 0) {
        this.burst(r.x, r.y, this.sparkPerBurst);
        this.rockets.splice(i, 1);
      }
    }

    // 火星
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += gravity * dt;
      s.vx *= 0.985;
      s.vy *= 0.985;
      s.life += dt;
      if (s.life > s.maxLife) this.sparks.splice(i, 1);
    }

    // 自动发射
    if (this.autoLaunch) {
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        this.launch();
        if (this.heavy) this.launch();
        this.cooldown = 1 / this.rate * rand(0.6, 1.4) * 0.16;
      }
    }
  }

  draw() {
    const { ctx } = this;
    /* 加色混合（lighter）只在暗底上成立 —— 它把颜色推向白，
       奶油底上等于把烟花擦掉。亮底改用普通叠加，靠粒子自身的
       陶土/蜜金/墨色与底色拉开对比。 */
    ctx.globalCompositeOperation = this.soft ? 'source-over' : 'lighter';

    for (const r of this.rockets) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = palette().accent;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.moveTo(r.trail[0]?.x ?? r.x, r.trail[0]?.y ?? r.y);
      for (const p of r.trail) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = palette().accent;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    for (const s of this.sparks) {
      const t = 1 - s.life / s.maxLife;
      ctx.globalAlpha = clamp(t * t, 0, 1) * (this.soft ? 0.7 : 1);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (0.4 + t * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

/* --------------------------------------------------------------------------
   便捷工厂
   -------------------------------------------------------------------------- */

export function createStarfield(canvas, count) {
  const layer = new Starfield(canvas, count);
  layer.start();
  return layer;
}

export function createConfetti(canvas, opts) {
  const layer = new Confetti(canvas, opts);
  layer.start();
  return layer;
}

export function createFireworks(canvas, opts) {
  const layer = new Fireworks(canvas, opts);
  layer.start();
  return layer;
}
