/* ==========================================================================
   幕 8 · 烟花与祝福
   收尾：烟花循环 + 祝福弹幕 + 署名 + 两个出口按钮。
   ========================================================================== */

import { config } from '../config.js';
import { h, rand, pick } from '../lib/dom.js';
import { createFireworks } from '../lib/fx.js';
import { birthdayLabel } from '../lib/mode.js';

export function createFireworksScene({ onBackToTrips }) {
  const cfg = config.fireworks;

  /* 弹幕里带一条喊她名字的。名字取 site.herName，
     不写死在文案里 —— 改名字只要改一处。
     还是 [占位] 时就不加，免得弹幕飘出一对方括号。 */
  const herName = String(config.site.herName || '').trim();
  const blessings = herName && !herName.includes('[')
    ? [`${herName}，生日快乐`, ...(cfg.blessings || [])]
    : (cfg.blessings || []);

  const canvas = h('canvas', { class: 'canvas-layer', 'aria-hidden': 'true' });
  const danmakuLayer = h('div', { class: 'danmaku-layer', 'aria-hidden': 'true' });

  const againBtn = h('button', {
    class: 'btn btn--line', type: 'button', text: cfg.againButton, onClick: () => burstShow(),
  });

  const backBtn = h('button', {
    class: 'btn btn--line', type: 'button', text: cfg.backButton,
    onClick: () => onBackToTrips?.(),
  });

  const el = h('section', { class: 'scene', id: 'scene-fireworks' },
    canvas,
    danmakuLayer,
    h('div', { class: 'scene__inner stack stack--center' },
      h('div', { class: 'reveal' },
        h('p', { class: 'display display--lg', text: cfg.greeting || '生日快乐' })),
      h('div', { class: 'reveal final__foot' },
        h('div', { text: `${cfg.footerNote} ${birthdayLabel()}` }),
        h('div', { class: 'final__sign', text: `—— ${config.site.signature}` })),
      h('div', { class: 'reveal final__btns' }, againBtn, backBtn)));

  let fw = null;
  let danmakuTimer = null;
  let active = false;

  /* ---------------- 弹幕 ---------------- */

  function spawnDanmaku(text) {
    const node = h('div', { class: 'danmaku', text });

    const w = danmakuLayer.clientWidth || window.innerWidth;
    const hh = danmakuLayer.clientHeight || window.innerHeight;
    /* 只在上、下两条带里飞：中间是「生日快乐 / 落款 / 两个按钮」，
       弹幕横穿过去会和正文叠在一起，读不清。 */
    const top = Math.random() < 0.5
      ? rand(hh * 0.08, hh * 0.32)
      : rand(hh * 0.66, hh * 0.86);

    node.style.top = `${top}px`;
    node.style.left = `${w}px`;
    /* ⚠️ will-change 必须在**创建时**加、动画结束时移除，不能写在 CSS 里
       常驻 —— 弹幕节点最多 6 个并存，每次 onEnter 都新建一批，
       常驻 will-change:transform 会留下一堆不吃 GPU 的合成层。 */
    node.style.willChange = 'transform';
    danmakuLayer.appendChild(node);

    const distance = w + node.offsetWidth + 40;
    const duration = rand(9000, 15000);

    const anim = node.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
      { duration, easing: 'linear', fill: 'forwards' }
    );

    anim.onfinish = () => {
      node.style.willChange = 'auto';
      node.remove();
    };
    return anim;
  }

  function startDanmaku() {
    stopDanmaku();
    const loop = () => {
      spawnDanmaku(pick(blessings));
      danmakuTimer = setTimeout(loop, rand(2400, 4200));
    };
    danmakuTimer = setTimeout(loop, 900);
  }

  function stopDanmaku() {
    clearTimeout(danmakuTimer);
    danmakuTimer = null;
  }

  /* ---------------- 烟花 ---------------- */

  /* 「再放一次」。
     ⚠️ 旧版只在常驻自动发射之上追加 6 发：自动发射本来每 0.3~0.6s 就
     自发一枚，多 6 发完全淹没在背景里；加上亮色主题下火星又小又淡
     （26 颗 / ≤0.7 透明度 / 1~2px），点按前后肉眼看不出任何区别 ——
     体感就是「按钮点了没反应」。
     现在改成一场明确的「重放」：先停自动发射、清空天上的存货
     （天空骤然安静本身就是反馈），安静半拍后一轮加密齐射，
     放完再恢复常驻。token 防连点：后一次点击会作废前一次的收尾。 */
  let showToken = 0;

  function burstShow() {
    if (!fw) return;
    /* 场景曾经离开视口时 fw 已 stop()（running=false），此时只改状态
       不画画 —— 必须先拉起来，否则齐射一颗都看不见。 */
    fw.start();

    const token = ++showToken;
    const prevBurst = fw.sparkPerBurst;

    fw.heavy = false;
    fw.autoLaunch = false;
    fw.rockets.length = 0;
    fw.sparks.length = 0;
    /* 齐射密度拉到常驻的近三倍，亮色主题下也能看清「确实重放了一遍」 */
    fw.sparkPerBurst = Math.max(prevBurst * 3, 70);

    const N = 10;
    for (let i = 0; i < N; i++) {
      setTimeout(() => {
        if (!fw || token !== showToken) return;
        fw.launch(rand(0.12, 0.88), rand(0.35, 0.7));
      }, 500 + i * 220);
    }

    setTimeout(() => {
      if (!fw || token !== showToken) return;
      fw.sparkPerBurst = prevBurst;
      fw.autoLaunch = true;
      fw.cooldown = 40;
    }, 500 + N * 220 + 800);
  }

  return {
    el,
    onEnter() {
      active = true;
      if (!fw) fw = createFireworks(canvas, { autoLaunch: true });
      else fw.start();

      if (!danmakuLayer.dataset.started) {
        danmakuLayer.dataset.started = '1';
        // 进场先来一轮密集的
        setTimeout(burstShow, 700);
      }
      startDanmaku();
    },
    onLeave() {
      active = false;
      stopDanmaku();
      // 离开视口就停，省电
      fw?.stop();
    },
    destroy() {
      stopDanmaku();
      fw?.destroy();
    },
  };
}
