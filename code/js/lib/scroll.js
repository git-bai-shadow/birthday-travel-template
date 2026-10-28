/* ==========================================================================
   scroll.js · 入场动画、场景追踪、进度点导航
   ========================================================================== */

import { h, qs, qsa, rafThrottle, clamp } from './dom.js';

/* --------------------------------------------------------------------------
   滚动入场：元素进入视口时加 is-in
   -------------------------------------------------------------------------- */

let revealObserver = null;
let sweepTimer = 0;

export function initReveal(root = document) {
  if (revealObserver) revealObserver.disconnect();

  /* ⚠️ 兜底很重要，不能省。

     IntersectionObserver 只在元素**进入**视口的那一刻回调。以下两种情况
     它永远不会触发，而 .reveal 的初值是 opacity:0 —— 元素就永久消失了：
       ① 用户快速滚动 / 程序化scrollTo 直接跳过（不产生中间过程）；
       ② threshold 0.08 要求「8% 面积可见」，元素太高时（如 3D 画布）
          露出的那一小条不够 8%，于是永远不算isIntersecting。
     站点现在的 reveal 元素里有整屏高的舞台，所以这不是理论风险。

     做法：监听滚动，每 250ms 扫一遍还在视口外、但已经「经过」的元素，
     补上 is-in。IO 负责正常的精细触发，这里只兜底漏掉的。 */
  const sweep = () => {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = 0;
      const vh = window.innerHeight;
      qsa('.reveal:not(.is-in)', root).forEach((el) => {
        const r = el.getBoundingClientRect();
        // 元素顶端已越过视口下沿 → 刚才被跳过了，补上
        if (r.top < vh) {
          el.classList.add('is-in');
          revealObserver?.unobserve(el);
        }
      });
    }, 250);
  };
  window.addEventListener('scroll', sweep, { passive: true });
  /* 存下引用以便重调时摘掉。原来函数开头 disconnect 了 observer 防重复，
     却每次都新加一个 scroll 监听且永不移除 —— 目前只被调用一次所以没炸，
     但重调一次就多一个 sweep 在跑。 */
  if (initReveal._sweep) {
    window.removeEventListener('scroll', initReveal._sweep);
  }
  initReveal._sweep = sweep;

  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-in');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  /* 错峰：同父元素内的 .reveal 按顺序递增 --i，由 CSS 换算成延迟。
     封顶 3 —— 4×70=280ms，再多最后一组会等得太明显。 */
  const counter = new Map();
  qsa('.reveal', root).forEach((el) => {
    const key = el.parentElement || el;
    const i = counter.get(key) || 0;
    counter.set(key, i + 1);
    el.style.setProperty('--i', String(Math.min(i, 3)));
    revealObserver.observe(el);
  });

  /* 开了「减少动效」就直接全部显示，不装观察器。
     注意 @media 只能杀 CSS 动画，杀不掉这里的类切换逻辑 ——
     所以必须在这里也走一条捷径，否则元素会永远停在 opacity:0。 */
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    qsa('.reveal', root).forEach((el) => el.classList.add('is-in'));
    revealObserver.disconnect();
    revealObserver = null;
  } else {
    sweep();
  }
}

export function observeReveal(el) {
  if (revealObserver) revealObserver.observe(el);
  return el;
}

/* --------------------------------------------------------------------------
   场景追踪：哪一幕在视口里 + 右侧进度点
   -------------------------------------------------------------------------- */

/* 视差登记表。
   刻意复用 initSceneTracker 里那个已经做过 rAF 节流的滚动回调，
   不新增第二个 scroll 监听 —— 全项目只该有一个。 */
const parallaxItems = [];

export function registerParallax(el, { depth = 24 } = {}) {
  if (!el) return null;
  // 刻意不设 will-change：它会让这个整屏元素被永久提升为合成层，
  // 白占内存，交给浏览器自己判断更准。
  parallaxItems.push({ el, depth, last: null });
  return el;
}

function updateParallax() {
  if (!parallaxItems.length) return;
  const vh = window.innerHeight;

  for (const item of parallaxItems) {
    const r = item.el.getBoundingClientRect();
    // 离视口太远的直接跳过，省掉无意义的布局读取
    if (r.bottom < -vh * 0.25 || r.top > vh * 1.25) continue;

    // -1 = 刚从下方进入，0 = 正中，1 = 已滑向上方
    const half = vh / 2 + r.height / 2;
    const t = clamp((r.top + r.height / 2 - vh / 2) / half, -1, 1);
    // 量化到 0.1px：一来避免每帧写入相同值，二来肉眼分辨不出差别
    const y = Math.round(-t * item.depth * 10) / 10;

    // 值没变就跳过。原来每帧无条件写一次内联样式，
    // 即使值相同也会让浏览器重算一遍这个整屏元素的样式。
    if (y === item.last) continue;
    item.last = y;
    item.el.style.transform = `translate3d(0, ${y}px, 0)`;
  }
}

export function initSceneTracker({ scenes, dotsContainer, onChange }) {
  const dots = dotsContainer ? scenes.map((scene, i) => {
    const btn = h('button', {
      class: 'dots__i',
      type: 'button',
      'aria-label': `第 ${i + 1} 屏`,
      onClick: () => scrollToScene(scene),
    });
    dotsContainer.appendChild(btn);
    return btn;
  }) : [];

  let activeIndex = -1;

  const update = rafThrottle(() => {
    const mid = window.innerHeight * 0.42;
    let best = 0;
    let bestDist = Infinity;

    scenes.forEach((scene, i) => {
      const rect = scene.getBoundingClientRect();
      // 场景覆盖 mid 线，或中心最接近 mid
      const center = rect.top + rect.height / 2;
      const dist = Math.abs(center - mid);
      if (rect.top <= mid && rect.bottom >= mid) {
        best = i;
        bestDist = -1;
      } else if (bestDist !== -1 && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });

    updateParallax();

    if (best !== activeIndex) {
      activeIndex = best;
      dots.forEach((d, i) => d.classList.toggle('is-active', i === best));
      onChange?.(best, scenes[best]);
    }
  });

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();

  return {
    dots,
    get activeIndex() { return activeIndex; },
    refresh: update,
  };
}

/* --------------------------------------------------------------------------
   滚动到某一幕
   -------------------------------------------------------------------------- */

export function scrollToScene(scene, { smooth = true } = {}) {
  if (!scene) return;
  const top = scene.getBoundingClientRect().top + window.scrollY;
  /* ⚠️ 不平滑时必须写 'instant'：'auto' 的含义是"跟 CSS 走"，
     而 html 上写着 scroll-behavior: smooth，'auto' 照样会慢慢滚过去。
     ⚠️ 而 JS 显式传的 behavior **优先级高于 CSS** —— base.css 的
     reduced-motion 块只把 html{scroll-behavior} 改成 auto，管不到这里。
     开了「减少动效」的用户仍然会看到长距离平滑滚动，正是该偏好要避免的。 */
  const calm = prefersCalmMotion();
  window.scrollTo({ top, behavior: calm || !smooth ? 'instant' : 'smooth' });
}

export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: prefersCalmMotion() ? 'instant' : 'smooth' });
}

/** 用户是否要求减少动效。JS 的行为选择必须自己判断，CSS 的媒体查询管不到。 */
export function prefersCalmMotion() {
  try {
    return Boolean(window.matchMedia)
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
   往下滑的提示：底部一个呼吸的箭头
   -------------------------------------------------------------------------- */

export function makeScrollHint(label = '') {
  return h('div', { class: 'scroll-hint', 'aria-hidden': 'true' }, [
    label ? h('span', { class: 'scroll-hint__label', text: label }) : null,
    h('div', { class: 'scroll-hint__arrow' },
      h('svg', {
        width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.8',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        html: '<path d="M12 5v14M5 12l7 7 7-7"/>',
      })),
  ]);
}

/* --------------------------------------------------------------------------
   页面可见性（用于暂停粒子等）
   -------------------------------------------------------------------------- */

export function onVisibilityChange(fn) {
  document.addEventListener('visibilitychange', () => fn(!document.hidden));
}

/* --------------------------------------------------------------------------
   元素是否在视口内
   -------------------------------------------------------------------------- */

export function inViewport(el, margin = 0) {
  const r = el.getBoundingClientRect();
  return r.bottom > -margin && r.top < window.innerHeight + margin;
}

/** 当前滚动进度 0-1 */
export function scrollProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max <= 0 ? 0 : clamp(window.scrollY / max, 0, 1);
}
