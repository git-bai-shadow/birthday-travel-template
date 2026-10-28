/* ==========================================================================
   notice.js · 顶部提示条
   用于：微信环境提醒、麦克风降级说明、保存成功等一次性提示。
   ========================================================================== */

import { h, sleep } from '../lib/dom.js';

let host = null;
let current = null;
let hideTimer = null;

function ensure() {
  if (host) return host;
  host = h('div', { class: 'notice', role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(host);
  return host;
}

export function showNotice(text, { duration = 3200 } = {}) {
  const node = ensure();
  node.textContent = text;
  node.classList.add('is-on');

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => node.classList.remove('is-on'), duration);
  return node;
}

export function hideNotice() {
  clearTimeout(hideTimer);
  ensure().classList.remove('is-on');
}

/**
 * 微信里一次性提示：如果在微信打开，音频和权限都会受限，
 * 温和地告诉她可以换浏览器打开。只提示一次，不打扰。
 */
export function maybeShowWeChatTip(store) {
  const ua = navigator.userAgent;
  if (!/MicroMessenger/i.test(ua)) return false;
  if (store.get('wx-tip-shown', false)) return false;
  store.set('wx-tip-shown', true);

  setTimeout(() => {
    showNotice('如果音乐没响或有些功能没反应，可以点右上角在浏览器里打开', { duration: 6000 });
  }, 2600);

  return true;
}
