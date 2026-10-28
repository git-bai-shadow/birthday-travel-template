/* ==========================================================================
   lightbox.js · 照片大图
   打开：共享元素转场，从缩略图的位置放大到居中。
   切换：多张照片时不用关掉再点开下一张 —— 左右箭头 / 方向键 / 横滑都行。
   切换的过场取自「扭曲相册」的思路：旧图带一点旋转坠向角落淡出，
   新图从侧后方的 3D 姿势弹回正位，有翻动一摞照片的手感。
   ========================================================================== */

import { h, clearOverflow } from '../lib/dom.js';

let instance = null;
let showToken = 0;

/* 与 scenes.css 里 .lb-img.is-active 的过渡时长保持一致 */
const SWAP_MS = 640;

function ensure() {
  if (instance) return instance;

  /* 两个轮换的 img：一张当正位，一张当来图。
     换图时来图从侧后方的扭曲姿势弹回，旧图坠向另一侧淡出。 */
  const imgA = h('img', { class: 'lb-img', alt: '', draggable: 'false' });
  const imgB = h('img', { class: 'lb-img', alt: '', draggable: 'false' });
  const stage = h('div', { class: 'lightbox__stage' }, imgA, imgB);

  const chevron = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
  const prevBtn = h('button', {
    class: 'lightbox__nav lightbox__nav--prev', type: 'button', 'aria-label': '上一张',
    html: chevron,
    onClick: () => step(-1),
  });
  const nextBtn = h('button', {
    class: 'lightbox__nav lightbox__nav--next', type: 'button', 'aria-label': '下一张',
    html: chevron,
    onClick: () => step(1),
  });

  const counter = h('span', { class: 'lightbox__count', 'aria-live': 'polite' });

  /* 遮罩单独成层：关闭时它自己淡出，飞回缩略图的 img 不能跟着一起变透明 */
  const scrim = h('div', { class: 'lightbox__scrim', 'aria-hidden': 'true' });

  /* 没有关闭按钮：点图片外的任何地方、Esc、手机返回手势都能关。
     照片四角本来就该干干净净的。 */
  const el = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' },
    scrim, stage, prevBtn, nextBtn, counter);

  let list = null;       // [{ full, thumb }] | null
  let origins = null;    // 每张照片对应的缩略图元素，关闭时飞回第 index 张
  let index = 0;
  let slot = 0;          // 当前正位显示的是 imgs[slot]
  let animating = false;
  const imgs = [imgA, imgB];

  /* 关闭：能飞就飞回当前这张的缩略图（镜像打开时的放大），
     缩略图不在视野里（滚走了/网格收了）就退化为普通淡出。 */
  function hide() {
    const token = ++showToken;               // 作废预载与还没跑完的收尾
    const img = imgs[slot];
    const tr = origins?.[index]?.getBoundingClientRect?.() || null;
    const usable = !animating && tr && tr.width > 8
      && tr.bottom > -60 && tr.top < (window.innerHeight || 0) + 60;

    el.classList.add('is-closing');
    el.classList.remove('is-open');
    clearOverflow(document.body);

    const cleanup = () => {
      if (token !== showToken) return;       // 期间又打开了：别动新一幕的样式
      img.style.transition = '';
      img.style.transform = '';
      img.className = 'lb-img is-hidden';    // 落地即藏身：不清这条它会弹回屏幕中央永远挂着
      el.classList.remove('is-closing');
    };

    if (!usable) { setTimeout(cleanup, 380); return; }

    const r = img.getBoundingClientRect();
    const dx = (tr.left + tr.width / 2) - (r.left + r.width / 2);
    const dy = (tr.top + tr.height / 2) - (r.top + r.height / 2);
    const s = tr.width / Math.max(1, r.width);
    img.style.transition = 'transform 380ms cubic-bezier(0.32, 0.72, 0.3, 1), opacity 300ms ease 120ms';
    img.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    setTimeout(cleanup, 400);
  }

  el.addEventListener('click', (e) => {
    if (swallowClick) return;
    /* 点到图片本身或切换按钮不算关；点图片外的任何位置就关 */
    if (e.target.closest('.lb-img, .lightbox__nav, .lightbox__count, button')) return;
    hide();
  });
  document.addEventListener('keydown', (e) => {
    if (!el.classList.contains('is-open')) return;
    if (e.key === 'Escape') hide();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  /* 手势：横向滑动切图，轻点空白处仍然是关闭。
     鼠标走 pointer 事件；触摸必须走 touch 事件 ——
     手指一动浏览器就把手势接管成滚动，pointerup 会被换成 pointercancel，
     只听 pointer 的话手机上永远滑不动。 */
  let swipe = null;
  let swallowClick = false;
  const beginSwipe = (x, y, id) => { swipe = { x, y, id }; };
  const endSwipe = (x, y, id) => {
    if (!swipe || swipe.id !== id) return;
    const dx = x - swipe.x;
    const dy = y - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 80);
      step(dx < 0 ? 1 : -1);
    }
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;   // 触摸由 touch 事件负责
    if (e.target.closest('button')) { swipe = null; return; }
    beginSwipe(e.clientX, e.clientY, e.pointerId);
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    endSwipe(e.clientX, e.clientY, e.pointerId);
  });
  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) { swipe = null; return; }
    const t = e.changedTouches[0];
    beginSwipe(t.clientX, t.clientY, 'touch');
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    endSwipe(t.clientX, t.clientY, 'touch');
  }, { passive: true });

  function updateCounter() {
    counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
  }

  /* 缩略图秒出（网格里刚显示过，缓存里就有），原图在背后预载，好了再无缝换上。 */
  function loadInto(img, photo, token) {
    img.alt = '';
    if (photo.thumb && photo.thumb !== photo.full) {
      img.src = photo.thumb;
      const pre = new Image();
      pre.onload = () => { if (token === showToken) img.src = photo.full; };
      pre.src = photo.full;
    } else {
      img.src = photo.full;
    }
  }

  /* 首次打开：共享元素转场，从缩略图位置放大到居中 */
  function showAt(i, originRect) {
    showToken += 1;
    const token = showToken;
    index = i;

    const img = imgs[slot];
    const other = imgs[1 - slot];
    other.removeAttribute('src');
    other.className = 'lb-img is-hidden';
    img.className = 'lb-img is-active';
    img.removeAttribute('src');
    img.style.transition = '';
    img.style.transform = '';
    el.classList.remove('is-closing');

    el.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    updateCounter();

    if (originRect) {
      const dx = originRect.left + originRect.width / 2 - window.innerWidth / 2;
      const dy = originRect.top + originRect.height / 2 - window.innerHeight / 2;
      img.style.transition = 'none';
      img.style.transform = `translate(${dx}px, ${dy}px) scale(${originRect.width / Math.max(1, img.clientWidth || originRect.width)})`;
      requestAnimationFrame(() => {
        img.style.transition = '';
        img.style.transform = '';
      });
    }

    loadInto(img, list[index], token);
  }

  /* 切换：来图从扭曲姿势弹回正位，旧图坠向另一侧淡出（姿势类见 scenes.css） */
  function step(dir) {
    if (!list || list.length < 2 || animating || !el.classList.contains('is-open')) return;
    animating = true;
    showToken += 1;
    const token = showToken;

    const out = imgs[slot];
    const inn = imgs[1 - slot];
    slot = 1 - slot;
    index = (index + dir + list.length) % list.length;
    updateCounter();

    out.classList.remove('is-active', 'is-out-left', 'is-out-right');
    out.classList.add('is-active');
    out.classList.add(dir > 0 ? 'is-out-left' : 'is-out-right');

    inn.removeAttribute('src');
    inn.className = 'lb-img ' + (dir > 0 ? 'is-in-right' : 'is-in-left');
    loadInto(inn, list[index], token);

    /* 先让起始姿势生效一帧，再切到正位，过渡才会从姿势出发 */
    void inn.offsetWidth;
    inn.classList.remove('is-in-right', 'is-in-left');
    inn.classList.add('is-active');

    setTimeout(() => {
      out.removeAttribute('src');
      out.className = 'lb-img is-hidden';
      animating = false;
    }, SWAP_MS + 40);
  }

  document.body.appendChild(el);
  /* hide / step 原来是 ensure() 里的闭包函数、**没有挂到实例上**，
     而 closePhoto() 调instance?.hide() → 实例存在时 instance.hide 是
     undefined，调用即 TypeError。（之前没炸只因为 closePhoto 全库无人调用，
     但它是个对外 export，任何人接一步就崩。） */
  instance = {
    el,
    hide,
    step,
    isOpen: () => el.classList.contains('is-open'),
    open(photos, i, originEls) {
      list = photos.map((p) => typeof p === 'string'
        ? { full: p, thumb: p }
        : { full: p.full || p.thumb || '', thumb: p.thumb || p.full || '' });
      origins = originEls || null;
      el.classList.toggle('has-multi', list.length > 1);
      const idx = Math.max(0, Math.min(i || 0, list.length - 1));
      const rect = origins?.[idx]?.getBoundingClientRect?.() || null;
      showAt(idx, rect);
    },
  };
  return instance;
}

/** 打开一组照片（元素可以是字符串 URL 或 { full, thumb }），从第 index 张看起。
    originEls：与照片对应的缩略图元素数组 —— 关闭时大图要飞回其中第 index 张。 */
export function openGallery(photos, index = 0, originEls = null) {
  const lb = ensure();
  const els = Array.isArray(originEls) ? originEls : (originEls ? [originEls] : null);
  lb.open(photos, index, els);
}

/** 单张（旧接口，保留兼容） */
export function openPhoto(src, alt = '', originEl = null, previewSrc = '') {
  openGallery([{ full: src, thumb: previewSrc || src }], 0, originEl);
}

export function closePhoto() {
  instance?.hide();
}
