/* ==========================================================================
   设置面板（二级界面）

   原来右下角常驻两个悬浮按钮（音乐静音 + 配色切换），在九幕之间一直飘着：
   占视线、说不清各管什么、还容易被当成装饰。现在收成**一个入口**，
   音乐（开关 + 音量）与配色都进面板 —— 想改再打开，平时不占地方。

   沿用录入抽屉的形态（底部滑出 + 遮罩），保持同一套语言。

   ⚠️ 打开时要记下 body 原来的 overflow 再恢复，不能直接置空：
      解锁门那屏由 lockScroll() 把 body 的 overflow 设成了 hidden，
      直接清空等于顺手把登录门的滚动锁给解了。
   ========================================================================== */

import { config } from '../config.js';
import { h, clearOverflow } from '../lib/dom.js';
import { THEMES, setTheme, currentTheme } from '../lib/theme.js';
import { isMuted, setMuted, getVolume, setVolume, onUnavailable } from '../lib/music.js';

const ICON_GEAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.1a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03z"/></svg>';

export function mountSettings(container) {
  const showMusic = !!config.music.enabled;
  const showTheme = !!config.theme.allowSwitch;
  if (!showMusic && !showTheme) return null;

  const cfg = config.settings || {};

  /* ---------------- 骨架 ---------------- */

  const title = h('h3', { class: 'drawer__title', text: cfg.title || '设置' });

  const closeBtn = h('button', {
    class: 'btn btn--ghost', type: 'button', text: cfg.close || '收起', onClick: close,
  });

  const sections = [];

  /* ---------------- 音乐 ---------------- */

  let switchBtn = null;
  let volInput = null;
  let volNum = null;
  let volRow = null;

  if (showMusic) {
    switchBtn = h('button', {
      class: 'switch', type: 'button', role: 'switch',
      'aria-label': cfg.musicLabel || '音乐',
      onClick: () => {
        const next = setMuted(!isMuted());
        syncMusic(next);
      },
    });

    volInput = h('input', {
      class: 'range', type: 'range',
      min: '0', max: '100', step: '1',
      'aria-label': cfg.volumeLabel || '音量',
      onInput: () => {
        const v = Number(volInput.value) / 100;
        setVolume(v);
        volNum.textContent = `${Math.round(v * 100)}%`;
        volInput.style.setProperty('--fill', `${Math.round(v * 100)}%`);
      },
    });

    volNum = h('span', { class: 'set-row__num' });

    volRow = h('div', { class: 'set-row set-row--stack' },
      h('div', { class: 'set-row__head' },
        h('span', { class: 'set-row__label', text: cfg.volumeLabel || '音量' }),
        volNum),
      volInput);

    const musicGroup = h('div', { class: 'set-group' },
      h('div', { class: 'set-row' },
        h('span', { class: 'set-row__label', text: cfg.musicLabel || '音乐' }),
        switchBtn),
      volRow);

    /* 音频文件拿不到（比如 bgm.mp3 还没放上去）就把这一组收起来：
       留一个按了没反应的开关比没有开关更让人困惑。 */
    onUnavailable(() => { musicGroup.hidden = true; });

    sections.push(musicGroup);
  }

  /* ---------------- 配色 ---------------- */

  let syncSwatches = () => {};

  if (showTheme) {
    const items = THEMES.map((t) => {
      const swatch = h('span', { class: `swatch swatch--${t.id}` });
      const btn = h('button', {
        class: 'set-opt', type: 'button',
        'aria-label': t.name,
        'aria-pressed': String(currentTheme() === t.id),
        onClick: () => {
          setTheme(t.id);
          syncSwatches();
        },
      }, swatch, h('span', { class: 'set-opt__name', text: t.name }));
      return { theme: t, btn };
    });

    syncSwatches = () => {
      items.forEach(({ theme, btn }) => {
        btn.setAttribute('aria-pressed', String(currentTheme() === theme.id));
      });
    };

    sections.push(h('div', { class: 'set-group' },
      h('div', { class: 'set-row' },
        h('span', { class: 'set-row__label', text: cfg.themeLabel || '配色' })),
      h('div', { class: 'set-opts' }, items.map((i) => i.btn))));
  }

  const panel = h('div', { class: 'drawer__panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': cfg.title || '设置' },
    h('div', { class: 'drawer__head' }, title, closeBtn),
    ...sections);

  const scrim = h('div', { class: 'drawer__scrim', onClick: close });

  /* id 是必要的：录入抽屉也用 .drawer* 这套类名，
     没有唯一选择器的话（自动化验证、将来加功能）很容易取错那一个。 */
  const el = h('div', { class: 'drawer', id: 'settings-sheet' }, scrim, panel);

  const entry = h('button', {
    class: 'dock__btn', type: 'button',
    'aria-label': cfg.title || '设置',
    'aria-expanded': 'false',
    html: ICON_GEAR,
    onClick: () => (el.classList.contains('is-open') ? close() : open()),
  });

  /* dock 挂在 body 上（position: fixed），可见性由 main.js 控制：
     只在「第一页」那一段显示，离开就收起。
     不用 absolute 挂进场景 —— 日常模式的第一页是一张很长的页面，
     那样会被推到整页最底部，首屏根本看不见。 */
  const dock = h('div', { class: 'dock' });
  dock.appendChild(entry);
  container.appendChild(dock);
  document.body.appendChild(el);

  let visible = true;

  /** 由 main.js 按"当前是不是第一页"调用 */
  function setVisible(next) {
    const v = !!next;
    if (v === visible) return;
    visible = v;
    dock.classList.toggle('is-hidden', !v);
  }

  /* ---------------- 状态同步 ---------------- */

  function syncMusic(off) {
    const mutedNow = off === undefined ? isMuted() : !!off;
    switchBtn.setAttribute('aria-checked', String(!mutedNow));
    switchBtn.classList.toggle('is-off', mutedNow);
    volRow.classList.toggle('is-off', mutedNow);

    const v = Math.round(getVolume() * 100);
    volInput.value = String(v);
    volInput.disabled = mutedNow;
    volNum.textContent = `${v}%`;
    /* 已填充的一段用主色画。原生 range 在 -webkit-appearance:none 下不会自己填色，
       只能把百分比交给 CSS（见 base.css 的 .range） */
    volInput.style.setProperty('--fill', `${v}%`);
  }

  if (showMusic) syncMusic();

  /* ---------------- 开关 ---------------- */

  function open() {
    if (showMusic) syncMusic();
    if (showTheme) syncSwatches();

    document.body.style.overflow = 'hidden';
    entry.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => el.classList.add('is-open'));
  }

  function close() {
    el.classList.remove('is-open');
    entry.setAttribute('aria-expanded', 'false');
    /* 不还原"打开时记下的那个值" —— 它可能已经过期：
       万一在面板打开期间解锁门被放行（或反过来上了锁），把旧值写回去
       就会多锁一次/少锁一次，表现是「面板收起了却滑不动」。
       按**此刻的真实状态**决定：门还锁着就保持锁，否则清干净。 */
    if (document.documentElement.classList.contains('is-locked')) {
      document.body.style.overflow = 'hidden';
    } else {
      clearOverflow(document.body);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('is-open')) close();
  });

  return { el, entry, open, close, setVisible, isOpen: () => el.classList.contains('is-open') };
}
