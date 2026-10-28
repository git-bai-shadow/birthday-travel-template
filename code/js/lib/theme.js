/* ==========================================================================
   theme.js · 两套主题的切换与持久化
   clay      陶土纸（日间默认）→ 关闭粒子，改用柔光扩散与静态飘落
   clay-night 烛光墨（夜间）  → 允许彩带粒子、烟花、发光点

   效果类型写在 <html data-effects> 上，各场景读取它来决定用哪种表现。
   ⚠️ 主题 id 与 css/themes.css 的选择器、css/base.css 的 .swatch--* 类名三处必须同步，
      漏改任何一处都会导致配色或切换器样式失效。
   ========================================================================== */

import { config } from '../config.js';
import { qs, store } from './dom.js';

const STORAGE_KEY = 'theme';

/* effects 字段已移除：
   性能档（full / lite / calm）现在由 main.js 做特性检测决定，
   和配色完全解耦 —— 明暗是配色的事，跑不跑 Canvas 是设备的事。 */
export const THEMES = [
  { id: 'clay',       name: '陶土纸', dark: false },
  { id: 'clay-night', name: '烛光墨', dark: true },
];

const listeners = new Set();

export function currentTheme() {
  return document.documentElement.dataset.theme || config.theme.default;
}

export function isDarkTheme() {
  const t = THEMES.find((x) => x.id === currentTheme());
  return t ? !!t.dark : false;
}

export function setTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  const root = document.documentElement;

  root.dataset.theme = theme.id;

  const meta = qs('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }

  store.set(STORAGE_KEY, theme.id);
  listeners.forEach((fn) => fn(theme));

  return theme;
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 读取保存的主题，没有就用默认 */
export function initTheme() {
  const saved = store.get(STORAGE_KEY, null);
  const valid = saved && THEMES.some((t) => t.id === saved);
  return setTheme(valid ? saved : config.theme.default);
}

/* 配色切换器不在这里建 DOM ——
   它和音乐开关一起放在「设置」面板里（components/settings.js），
   本模块只负责主题状态，保持可被任意 UI 复用。 */
