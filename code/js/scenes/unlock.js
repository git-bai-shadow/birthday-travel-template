/* ==========================================================================
   幕 0 · 解锁门
   目的：仪式感 + 拿到用户手势（音乐需要它才能播放）
   门槛要低：连错三次直接放行，不能让她卡在这一步。

   过场（v1.3.0 重做）：两扇纸门从中间滑开，门缝先透出一线暖光，
   门开的同时首页正好开始逐字写她的名字。
   为此要三件事配合（见 main.js 的接线）：
     onPass   —— 立刻：起音乐、解锁滚动、记下"生日模式来过了"（必须在这一下手势里）
     onCover  —— 幕布盖上的那一瞬：把页面直接跳到首页（她看不见跳动）
     onReveal —— 门开始开、首页进入视口的时机：首页才被允许开始写字
   ========================================================================== */

import { config } from '../config.js';
import { h } from '../lib/dom.js';

export function createUnlock({ onPass, onCover, onReveal }) {
  const cfg = config.unlock;
  let wrongCount = 0;

  const input = h('input', {
    class: 'unlock__input',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: '4',
    placeholder: cfg.placeholder,
    'aria-label': '输入四位数字',
  });

  /* ⚠️ role="status" / aria-live：口令错误的反馈原来对读屏完全不可感知 ——
     hint 会从 cfg.hint → cfg.wrongHint → cfg.forgiveHint 逐级变化，
     而连续输错三次会直接 setTimeout(pass, 900) 放行，
     读屏用户全程不知道发生了什么、也得不到"已放行"的提示。 */
  const hint = h('div', {
    class: 'unlock__hint', role: 'status', 'aria-live': 'polite', text: cfg.hint,
  });

  const goBtn = h('button', {
    class: 'unlock__go',
    type: 'button',
    'aria-label': '确认',
    html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5l7 7-7 7"/></svg>',
    onClick: submit,
  });

  const field = h('div', { class: 'unlock__field' }, input, goBtn);

  const el = h('section', { class: 'scene', id: 'scene-unlock' },
    h('div', { class: 'scene__inner stack stack--center' },
      h('p', { class: 'unlock__q', text: cfg.question }),
      field,
      hint));

  /* 过场的幕布：一整张"封面"，绕左侧书脊翻出去。
     为什么是翻页而不是把屏幕拆成两半：这个站的隐喻是纸（信封、信纸、稿纸线），
     翻页是纸张语言里最有分量的动作，技术上也成熟（CSS 3D 的 rotateY +
     书脊原点 + 正反两面），不必引动画库。
     挂在 body 上：这一幕背后没有"首页"，得先盖幕、跳页、再翻。 */
  const coverFront = h('div', { class: 'gate__face gate__face--front' },
    h('div', { class: 'gate__glow' }));
  const coverBack = h('div', { class: 'gate__face gate__face--back' });
  const page = h('div', { class: 'gate__page' }, coverFront, coverBack);
  const gate = h('div', { class: 'gate', 'aria-hidden': 'true' },
    h('div', { class: 'gate__cast' }),
    page);

  const isCalm = () => document.documentElement.dataset.effects === 'calm';

  function submit() {
    const value = input.value.trim();
    if (!value) { input.focus(); return; }

    /* acceptAny：示例模式放行任意输入（见 config.js 的注释）。
       兜底逻辑（连错三次放行）照旧保留，两种模式互不影响。 */
    if (cfg.acceptAny || value === cfg.code) {
      pass();
      return;
    }

    wrongCount += 1;
    field.classList.remove('is-wrong');
    void field.offsetWidth;          // 强制重排，让动画能重播
    field.classList.add('is-wrong');
    hint.classList.add('is-wrong');

    if (wrongCount >= cfg.forgiveAfter) {
      hint.textContent = cfg.forgiveHint;
      input.value = '';
      setTimeout(pass, 900);
    } else {
      hint.textContent = cfg.wrongHint;
      input.value = '';
      input.focus();
    }
  }

  function pass() {
    if (input.disabled) return;      // 连点两下不重放
    input.disabled = true;
    goBtn.disabled = true;
    goBtn.classList.add('is-ok');    // 先给一下"对了"的反馈

    // 音乐必须趁这一下手势起来，所以 onPass 不参与过场时序
    onPass?.();

    if (isCalm()) {
      onCover?.();
      onReveal?.();
      return;
    }

    document.body.appendChild(gate);
    gate.classList.add('is-on');     // 封面先盖上（不透明，瞬间遮住）

    // 盖稳之后：把页面跳到首页（她看不见），然后封面开始翻
    setTimeout(() => {
      onCover?.();
      gate.classList.add('is-turning');
    }, 240);

    // 封面翻过大半、露出的画面站住的那一刻，首页开始写字
    setTimeout(() => onReveal?.(), 600);

    // 翻完再留一点余量，然后把这个节点整个摘掉
    setTimeout(() => gate.remove(), 2100);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  input.addEventListener('input', () => {
    if (hint.classList.contains('is-wrong')) {
      hint.classList.remove('is-wrong');
      hint.textContent = cfg.hint;
    }
  });

  requestAnimationFrame(() => {
    if (window.matchMedia('(pointer: fine)').matches) input.focus();
  });

  return {
    el,
    onEnter() { /* 不需要额外动作 */ },
    destroy() { gate.remove(); },
  };
}
