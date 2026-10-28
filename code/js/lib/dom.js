/* ==========================================================================
   dom.js · 极简 DOM 助手
   不引框架，够用就好。
   ========================================================================== */

/**
 * 创建元素。
 *   h('div', { class: 'card' }, h('p', { text: '你好' }))
 *   h('button', { onClick: fn }, '点我')
 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);

  if (attrs && typeof attrs === 'object' && !isNode(attrs) && !Array.isArray(attrs)) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val === null || val === undefined || val === false) continue;

      if (key === 'class' || key === 'className') node.className = val;
      else if (key === 'text') node.textContent = val;
      else if (key === 'html') node.innerHTML = val;
      else if (key === 'style' && typeof val === 'object') Object.assign(node.style, val);
      else if (key === 'dataset' && typeof val === 'object') Object.assign(node.dataset, val);
      else if (key.startsWith('on') && typeof val === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (val === true) node.setAttribute(key, '');
      else node.setAttribute(key, val);
    }
  } else if (attrs !== undefined) {
    children.unshift(attrs);
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(isNode(child) ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/**
 * 摘掉元素上的 overflow 内联声明（连同长写）。
 *
 * 为什么不能只写 `el.style.overflow = ''`：那只移除简写，
 * 谁要是单独设过 overflow-y / overflow-x，那些声明会留下来继续生效 ——
 * 表现是「门过了 / 面板收起了，页面却滑不动」。
 * 打开弹层时用 `style.overflow = 'hidden'` 锁滚动是没问题的，
 * **关闭时一定要用这个函数收尾**。
 */
export function clearOverflow(el) {
  el.style.removeProperty('overflow');
  el.style.removeProperty('overflow-x');
  el.style.removeProperty('overflow-y');
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function isNode(v) { return v instanceof Node; }

export function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* --------------------------------------------------------------------------
   常用小工具
   -------------------------------------------------------------------------- */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function rand(min, max) { return Math.random() * (max - min) + min; }

export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** Fisher–Yates 洗牌，返回新数组 */
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

export function pad2(n) { return String(n).padStart(2, '0'); }

/** 节流到每帧一次 */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/**
 * 数字滚动递增。
 * 两个保险：动画结束后一定落到最终值；如果浏览器不支持动画或用户要求减少动效，
 * 直接显示最终值 —— 不能出现"永远停在 0"。
 */
export function countUp(node, to, duration = 800) {
  const target = Number(to) || 0;
  const reduce = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce || duration <= 0 || typeof requestAnimationFrame !== 'function') {
    node.textContent = target.toLocaleString('zh-CN');
    return;
  }

  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  let settled = false;

  function finish() {
    if (settled) return;
    settled = true;
    node.textContent = target.toLocaleString('zh-CN');
  }

  function step(now) {
    if (settled) return;
    const t = clamp((now - start) / duration, 0, 1);
    node.textContent = Math.round(target * ease(t)).toLocaleString('zh-CN');
    if (t < 1) requestAnimationFrame(step);
    else settled = true;
  }

  requestAnimationFrame(step);
  setTimeout(finish, duration + 300);
}

/** 本地存储，失败时静默降级（无痕模式等情况） */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  },
};

/** 判断是否在微信内置浏览器 */
export function isWeChat() {
  return /MicroMessenger/i.test(navigator.userAgent);
}

/** 判断是否为移动端 */
export function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}
