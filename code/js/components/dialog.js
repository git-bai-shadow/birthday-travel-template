/* ==========================================================================
   dialog.js · 站内小弹窗
   替换 window.prompt / window.confirm：系统弹窗是灰白的，
   和全站的奶油纸风格差着一个次元。支持两种形态：
     askText  —— 口令输入（口令不对时让调用方自己再弹一次）
     confirm  —— 删除等危险操作的二次确认
   ========================================================================== */

import { h, clearOverflow } from '../lib/dom.js';

/* 弹层可以叠加（确认框里再弹一个），而每个对话框都各自
   document.body.style.overflow = 'hidden'并在 settle 里 clearOverflow。
   两层叠加时关掉内层会把外层的滚动锁一并解掉 —— 页面在确认框还开着
   的情况下就能滚了。用一个计数而不是「各自设各自清」。 */
let openCount = 0;
let bodyOverflowBefore = '';

function lockScroll() {
  if (openCount === 0) {
    bodyOverflowBefore = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  openCount += 1;
}

function unlockScroll() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) {
    /* 按此刻的真实状态决定，而不是还原打开前的旧值 —— 中途可能有人
       打开了别的锁（见 MEMORY 的 overflow 三条铁律）。 */
    if (document.documentElement.classList.contains('is-locked')) return;
    document.body.style.overflow = bodyOverflowBefore || '';
  }
}

function openDialog({ title, input = false, type = 'text', confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let done = false;

    const inputEl = input
      ? h('input', { class: 'field__input', type, placeholder: '····' })
      : null;

    /* 无输入型也要有可聚焦元素，否则焦点留在 body ——
       keydown 挂在 el 上，事件根本冒不到（confirmBox 原来只能点按钮关）。 */
    const cancelBtn = h('button', { class: 'btn', type: 'button', text: '取消', onClick: () => settle(null) });
    const okBtn = h('button', {
      class: `btn btn--accent${danger ? ' dlg__danger' : ''}`,
      type: 'button', text: confirmText, onClick: () => settle(true),
    });

    const panel = h('div', { class: 'dlg__panel' },
      h('p', { class: 'dlg__title', text: title }),
      inputEl,
      h('div', { class: 'dlg__row' }, cancelBtn, okBtn));

    const scrim = h('div', { class: 'dlg__scrim', onClick: () => settle(null) });
    const el = h('div', {
      class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    }, scrim, panel);
    document.body.appendChild(el);
    lockScroll();
    requestAnimationFrame(() => el.classList.add('is-open'));

    function settle(value) {
      if (done) return;
      done = true;
      const out = input
        ? (value === true ? (inputEl.value || null) : null)
        : (value === true);
      el.classList.remove('is-open');
      document.removeEventListener('keydown', onKeydown, true);
      unlockScroll();
      // 等淡出动画走完再摘节点，不然 scrim 的过渡会被截断
      setTimeout(() => el.remove(), 260);
      resolve(out);
    }

    /* ⚠️ 监听挂 document 而不是 el。原来源码挂在 el 上：口令框会 focus
       inputEl（事件能冒到 el），但 confirmBox 不会 focus 任何元素，
       焦点留在 body → Esc 根本不冒到 el → **确认框只能点按钮关**。
       还要在 settle 里摘掉（监听在 document 上、removeEventListener
       才不会泄漏）。 */
    function onKeydown(e) {
      if (done) return;
      if (e.key === 'Escape') { e.preventDefault(); settle(null); }
      // 口令框里回车直接提交，别让「确认」要按两下
      if (e.key === 'Enter' && input) { e.preventDefault(); settle(true); }
    }
    document.addEventListener('keydown', onKeydown, true);

    requestAnimationFrame(() => (inputEl || cancelBtn).focus());
  });
}

/** 弹一个口令输入框。取消或空提交返回 null。 */
export function askPassword() {
  return openDialog({ title: '输入口令', input: true, type: 'password' });
}

/** 弹一个确认框。确定返回 true。 */
export function confirmBox(message, { confirmText = '确定' } = {}) {
  return openDialog({ title: message, confirmText });
}
