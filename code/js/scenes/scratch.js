/* ==========================================================================
   幕 4 · 刮刮卡
   Canvas 涂层，手指擦除。擦掉超过一定比例自动全部揭开。
   ========================================================================== */

import { config } from '../config.js';
import { h } from '../lib/dom.js';
import { createConfetti } from '../lib/fx.js';
import { birthdayLabel } from '../lib/mode.js';
import { makeScrollHint } from '../lib/scroll.js';

export function createScratch() {
  const cfg = config.scratch;

  const canvas = h('canvas', { class: 'scratch__canvas', 'aria-label': '刮刮卡' });
  /* 券面从一开始就"印"在纸上（虚线框、标签、印章、正文都在），
     涂层盖在上面 —— 刮开哪里就露出哪里，而不是全揭开才看到内容。 */
  const prize = h('div', { class: 'scratch__prize' },
    h('span', { class: 'scratch__seal', 'aria-hidden': 'true', text: birthdayLabel() }),
    h('p', { class: 'scratch__label', text: cfg.ticketTitle || '旅 行 兑 换 券' }),
    h('p', { class: 'scratch__text', text: cfg.content }),
    h('p', { class: 'scratch__foot', text: cfg.footnote }));

  const card = h('div', { class: 'scratch' }, prize, canvas);
  /* 键盘/读屏替代路径。刮卡唯一能揭示内容的方式是 pointer 驱动的
     checkProgress，而 canvas 没有 tabindex、touch-action:none 又切断了
     该区域滚动 —— 纯键盘的视力用户**永远刮不开**。
     对照：puzzle 有「跳过」、letter 有「直接看全文」。 */
  const skipBtn = h('button', {
    class: 'btn btn--ghost scratch__skip',
    type: 'button',
    text: cfg.skip || '直接揭开',
    onClick: () => revealAll(),
  });
  /* 操作提示同理：券面已经露出来了，"（用手指刮开）" 就是过期信息。
     桌面（鼠标）上「手指」这个词也不对 —— 按指针类型换措辞：
     触屏保持 config 原文，鼠标换成「按住鼠标刮开」。
     （pointer: coarse 只在擦除开始的那一下判定就够，不用监听变化——
     一台设备不会中途从手机变成电脑。） */
  const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const subHintEl = h('p', {
    class: 'muted scratch__subhint',
    text: isTouch ? cfg.subHint : String(cfg.subHint || '').replace(/用手指/, '按住鼠标'),
  });

  /* 这两块各自单独包一层 .reveal：揭开后要连**占位一起**收掉。
     visibility:hidden 只是看不见，元素仍占布局空间（按钮仍有 49px 高），
     所以要 collapse 到父层 —— 记下来给 revealAll 用。 */
  const subHintRow = h('div', { class: 'reveal' }, subHintEl);
  const skipRow = h('div', { class: 'reveal' }, skipBtn);

  const hint = makeScrollHint();
  const burstCanvas = h('canvas', { class: 'canvas-layer', 'aria-hidden': 'true' });

  const el = h('section', { class: 'scene', id: 'scene-scratch' },
    burstCanvas,
    h('div', { class: 'scene__inner stack stack--center stack--gap-24' },
      h('div', { class: 'reveal' }, h('p', { class: 'lead', text: cfg.hint })),
      h('div', { class: 'reveal' }, card),
      subHintRow,
      skipRow),
    hint);

  /* willReadFrequently: 这张画布每260ms 就要 getImageData 抽样统计擦除进度
     （见 checkProgress），浏览器会警告「多次回读建议开启」。
     开启后画布走 CPU 侧存储 —— 对我们是对的：这张图一直在被反复回读，
     放GPU 反而要来回搬数据。 */
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let dpr = 1;
  let painted = false;   // 涂层是否已铺。不能用 canvas.width 判断 —— 它默认是 300，永远为真
  let drawing = false;
  let revealed = false;
  let confetti = null;
  let checkTimer = null;
  let resizeTimer = null;

  function sizeCanvas() {
    if (revealed) return;   // 已揭开的卡不再重铺涂层
    const rect = card.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const hh = Math.round(rect.height * dpr);
    if (canvas.width === w && canvas.height === hh) return;

    // 改位图尺寸会把画布清空：先把旧涂层（含已刮开的部分）整体缩放拷贝回来，
    // 刮到一半旋转手机不至于从头再来。
    let keep = null;
    if (painted && canvas.width) {
      keep = document.createElement('canvas');
      keep.width = canvas.width;
      keep.height = canvas.height;
      keep.getContext('2d').drawImage(canvas, 0, 0);
    }
    canvas.width = w;
    canvas.height = hh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (keep) {
      // keep 是旧位图（设备像素），按卡片 CSS 尺寸铺回 —— 写 w/hh 会再放大一倍
      ctx.drawImage(keep, 0, 0, rect.width, rect.height);
    } else {
      paintCoating(rect.width, rect.height);
      painted = true;
    }
  }

  function paintCoating(w, hh) {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#CC785C';
    const accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#D9A05B';
    const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#141413';
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#FAF9F5';

    // 斜向三段渐变：中间留一道高光，刮起来才像一张有厚度的涂层卡，
    // 而不是一坨平涂的色块。
    const grad = ctx.createLinearGradient(0, 0, w, hh);
    grad.addColorStop(0.00, accent2);
    grad.addColorStop(0.42, accent);
    grad.addColorStop(0.52, accent2);
    grad.addColorStop(1.00, accent);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, hh);

    // 一点磨砂质感
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = bg;
    for (let i = 0; i < 420; i++) {
      const x = Math.random() * w;
      const y = Math.random() * hh;
      ctx.fillRect(x, y, 1.6, 1.6);
    }

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = text;
    ctx.font = `500 ${Math.round(Math.min(w, hh) * 0.088)}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cfg.coatText || '刮开看看', w / 2, hh / 2);
    ctx.restore();

    revealed = false;
  }

  /* ---------------- 擦除 ---------------- */

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function erase(from, to) {
    // 三层 destination-out 叠出羽化边缘，再沿路敲随机碎屑点 ——
    // 真实刮涂层是毛边 + 掉屑，不是一条生硬的圆头线。
    const passes = [
      { w: 58, a: 0.15 },   // 最外圈淡淡的虚边
      { w: 46, a: 0.32 },   // 中间过渡
      { w: 34, a: 0.88 },   // 核心，基本擦穿
    ];
    for (const { w, a } of passes) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = a;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
    }

    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const n = Math.max(1, Math.round(d / 5));
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      const x = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * 34;
      const y = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * 34;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 0.3 + Math.random() * 0.55;
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + Math.random() * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  let last = null;

  function onDown(e) {
    if (revealed) return;
    /* ⚠️ 必须防重入。原来没有守卫、也没先 clearInterval：
       双指触摸时第二次 pointerdown 直接**覆盖** checkTimer 引用，
       第一个 interval 的句柄就此丢失 → 每 260ms 一次全画布
       getImageData（dpr2 下约 760×470 = 35.7 万像素）**永久运行、永不停止**。 */
    if (drawing) return;
    if (!painted) {
      sizeCanvas();          // 兜底：场景首次进入时的铺层万一被跳过，落笔前补上
      if (!painted) return;
    }
    drawing = true;
    last = pos(e);
    erase(last, { x: last.x + 0.1, y: last.y + 0.1 });
    canvas.setPointerCapture?.(e.pointerId);

    clearInterval(checkTimer);
    checkTimer = setInterval(checkProgress, 260);
  }

  function onMove(e) {
    if (!drawing || revealed) return;
    const p = pos(e);
    erase(last, p);
    last = p;
  }

  function onUp() {
    drawing = false;
    last = null;
    clearInterval(checkTimer);
    checkTimer = null;
    checkProgress();
  }

  function checkProgress() {
    if (revealed) return;
    const { width, height } = canvas;
    if (!width) return;

    // 位图尺寸和卡片对不上（比如刮的途中窗口/缩放变了）说明涂层状态不明，
    // 先重铺再跳过这次统计 —— 否则会把"还没铺满"误判成"全刮开了"。
    const rect = card.getBoundingClientRect();
    if (rect.width && width !== Math.round(rect.width * dpr)) {
      sizeCanvas();
      return;
    }

    const step = 6;
    const data = ctx.getImageData(0, 0, width, height).data;
    let clear = 0;
    let total = 0;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        total++;
        const alpha = data[(y * width + x) * 4 + 3];
        // 毛边擦除会留下一圈半透明过渡带，过半透明的就算已刮开
        if (alpha < 110) clear++;
      }
    }

    if (total && clear / total >= cfg.autoRevealAt) revealAll();
  }

  function revealAll() {
    if (revealed) return;
    revealed = true;
    clearInterval(checkTimer);
    checkTimer = null;

    canvas.style.transition = 'opacity var(--dur-slow) ease';
    canvas.style.opacity = '0';
    card.classList.add('is-revealed');
    /* 收掉「直接揭开」与操作提示（v1.7.5 修：券面都露出来了按钮还杵着）。
       三层缺一不可：
         ① 子元素 is-gone → opacity+visibility:hidden（移出 tab 序列）
         ② 父层 .reveal is-collapsed → grid-template-rows:0fr，
            因为 visibility:hidden **仍然占布局空间**（实测 49px 高）
         ③ 不能用 hidden 属性 —— .btn 的 display:inline-flex 会覆盖
            [hidden] 的浏览器默认 display:none */
    skipBtn.classList.add('is-gone');
    skipRow.classList.add('is-collapsed');
    subHintEl.classList.add('is-gone');
    subHintRow.classList.add('is-collapsed');

    if (!confetti) confetti = createConfetti(burstCanvas, { count: 40 });
    confetti.burst(window.innerWidth / 2, window.innerHeight * 0.42, 46);
  }

  /* ---------------- 事件 ---------------- */

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onUp);

  /* 旋转/改窗口大小会改变卡片尺寸，涂层跟着重铺（进度保留在上面）。
     必须具名：原来用匿名箭头函数，destroy() 里只 clearTimeout，
     监听器永久留在 window 上 —— 对照 letter.js 的 onResize 就是正确写法，
     同一个项目里两种做法。任何 createScratch() 的销毁/重建都会成倍累积。 */
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sizeCanvas, 150);
  };
  window.addEventListener('resize', onResize);

  return {
    el,
    onEnter() {
      if (!card.getBoundingClientRect().width) return;
      sizeCanvas();
      setTimeout(() => hint.classList.add('is-in'), 2400);
    },
    onLeave() { confetti?.stop(); },
    destroy() {
      clearInterval(checkTimer);
      checkTimer = null;
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      confetti?.destroy();
    },
  };
}
