/* ==========================================================================
   幕 1 · 生日快乐
   主视觉。名字逐字浮现，彩带粒子落下。
   不自动跳转 —— 让她自己决定什么时候往下翻。
   ========================================================================== */

import { config } from '../config.js';
import { h } from '../lib/dom.js';
import { createConfetti } from '../lib/fx.js';
import { makeScrollHint, inViewport } from '../lib/scroll.js';
import { birthdayLabel } from '../lib/mode.js';

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.hold] 先按住入场动画，等解锁门的幕布打开时由
 *                              main.js 调 release() 放行 —— 否则字会在她
 *                              还看不见的时候写完（见 unlock.js 的过场时序）。
 */
export function createHero({ hold = false } = {}) {
  const { heading, sub } = config.hero;
  const name = config.site.herName;

  const canvas = h('canvas', { class: 'canvas-layer', 'aria-hidden': 'true' });
  const hint = makeScrollHint();
  let held = hold;

  /* 日期当首屏的锚点：三行字原来孤零零悬在正中，上下各空 300px。
     两侧带细线的小字（与蛋糕幕的 eyebrow 同一套做法）把视觉顶起来。 */
  const eyebrow = h('p', { class: 'hero__eyebrow', text: birthdayLabel() });

  const titleEl = h('h1', { class: 'display display--xl', 'aria-label': heading });
  const nameEl = h('p', { class: 'hero__name' });
  const subEl = h('p', { class: 'hero__sub', text: sub });

  const el = h('section', { class: 'scene', id: 'scene-hero' },
    canvas,
    h('div', { class: 'scene__inner stack stack--center' },
      eyebrow,
      titleEl,
      nameEl,
      subEl),
    hint);

  let confetti = null;
  let played = false;
  let hintTimer = null;

  /** 逐字浮现 */
  function typeLetters(node, text, { delay = 0, step = 120 } = {}) {
    node.textContent = '';
    [...text].forEach((ch, i) => {
      const span = h('span', {
        class: 'hero__letter',
        text: ch === ' ' ? '\u00A0' : ch,
      });
      span.style.animationDelay = `${delay + i * step}ms`;
      node.appendChild(span);
    });
    return delay + text.length * step;
  }

  function play() {
    if (played) return;
    played = true;

    // 日期先落位，再开始逐字写「生日快乐」
    requestAnimationFrame(() => eyebrow.classList.add('is-in'));

    const titleDone = typeLetters(titleEl, heading, { delay: 200, step: 60 });

    setTimeout(() => {
      const nameDone = typeLetters(nameEl, name, { delay: 0, step: 110 });
      setTimeout(() => subEl.classList.add('is-in'), nameDone + 300);
    }, titleDone + 220);

    // 彩带从 54 降到 32：安卓中端机上每片都是一个独立路径，
    // 数量减半带来的流畅度提升比"更热闹"更值。
    confetti = createConfetti(canvas, { count: 32 });

    // 4 秒后提示可以往下翻
    hintTimer = setTimeout(() => hint.classList.add('is-in'), 4000);
  }

  return {
    el,
    play,
    /** 解锁门的幕布打开时调用：从这一刻起才开始写字 */
    release() {
      held = false;
      play();
    },
    onEnter() {
      if (held) return;              // 还在幕布后面：先别把字写完
      play();
      if (!confetti) confetti = createConfetti(canvas, { count: 32 });
      else confetti.start();
    },
    onLeave() {
      // 离开视口就停掉，省电
      if (confetti && !inViewport(el, -200)) confetti.stop();
    },
    destroy() {
      clearTimeout(hintTimer);
      confetti?.destroy();
    },
  };
}
