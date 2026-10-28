/* ==========================================================================
   main.js · 编排
   1. 判断模式（生日叙事 / 日常记录）
   2. 按模式组装各幕
   3. 挂载常驻控件：设置入口、进度点
   4. 接线：解锁 → 音乐、录入抽屉、地图联动、照片大图
   ========================================================================== */

import { config } from './config.js';
import { h, qs, store as ls, sleep, clearOverflow } from './lib/dom.js';
import { initTheme } from './lib/theme.js';
import { isBirthdayMode, birthdayLabel } from './lib/mode.js';
import { startMusic } from './lib/music.js';
import { initReveal, initSceneTracker, scrollToScene, makeScrollHint, registerParallax } from './lib/scroll.js';
import * as data from './lib/store.js';
import { showNotice, maybeShowWeChatTip } from './components/notice.js';
import { createEditor } from './components/editor.js';
import { askPassword, confirmBox } from './components/dialog.js';
import { mountSettings } from './components/settings.js';
import { openPhoto } from './components/lightbox.js';

import { createUnlock } from './scenes/unlock.js';
import { createHero } from './scenes/hero.js';
import { createOpening } from './scenes/opening.js';
import { createFootprints } from './scenes/footprints.js';
import { createScratch } from './scenes/scratch.js';
import { createPuzzle } from './scenes/puzzle.js';
import { createCake } from './scenes/cake.js';
import { createLetter } from './scenes/letter.js';
import { createFireworksScene } from './scenes/fireworks.js';

async function boot() {
  initTheme();
  applyUiConfig();

  // 标签页标题跟着 config 走（分享卡片的标题在 index.html 里，是静态的）
  if (config.site?.title) document.title = config.site.title;

  // ?still=1：跳过所有过场，直接呈现最终状态（调试和截图用）
  const params = new URLSearchParams(location.search);
  if (params.has('still')) {
    document.documentElement.classList.add('still');
  }

  // 带 ?bday=1 打开时强制进入生日模式，方便在窗口外预览
  if (params.get('bday') === '1') {
    config.debug.forceBirthdayMode = true;
  }

  const app = qs('#app');
  const bootMask = qs('#boot');

  const birthday = isBirthdayMode();
  document.documentElement.dataset.mode = birthday ? 'birthday' : 'daily';

  const scenes = [];

  /* ---------------- 录入抽屉 ---------------- */

  const editor = createEditor({
    onSaved: (trip) => {
      footprints.refresh().then(() => footprints.reveal(trip.id));
    },
  });

  /* ---------------- 幕 0 · 解锁门（仅生日模式） ---------------- */

  /* 首页那一幕的实例。过场要按它的节拍放行，所以先声明在这里 */
  let hero = null;

  let unlock = null;
  if (birthday && config.unlock.enabled) {
    unlock = createUnlock({
      /* 这三件必须在这一下手势里做完 —— 音乐没有用户手势播不出来 */
      onPass: () => {
        startMusic();
        unlockScroll();
      },
      /* 幕布盖住整屏的瞬间直接跳到首页，她看不见任何滚动 */
      onCover: () => { if (hero) scrollToScene(hero.el, { smooth: false }); },
      /* 门开始开的时机 → 到这一刻首页才被允许开始写字 */
      onReveal: () => hero?.release(),
    });
    scenes.push(unlock);
    lockScroll();
  }

  /* ---------------- 幕 1、2 · 生日快乐 + 开场语 ---------------- */

  if (birthday) {
    /* 有解锁门时先按住首页：否则字在她还看不见的时候就写完了 */
    hero = createHero({ hold: Boolean(unlock) });
    scenes.push(hero);
    scenes.push(createOpening());
  }

  /* ---------------- 幕 3 · 旅行足迹（两种模式都有） ---------------- */

  const footprints = createFootprints({
    onAdd: () => editor.open(null),
    onEdit: (trip) => {
      if (!data.isAuthed()) return requestAuth(() => editor.open(trip));
      editor.open(trip);
    },
    onDelete: (trip) => {
      if (!data.isAuthed()) return requestAuth(() => confirmDelete(trip));
      confirmDelete(trip);
    },
  });
  scenes.push(footprints);

  /* ---------------- 幕 4–8 · 仅在生日模式 ---------------- */

  if (birthday) {
    scenes.push(createScratch());
    scenes.push(createPuzzle());
    scenes.push(createCake());
    scenes.push(createLetter());
    scenes.push(createFireworksScene({
      onBackToTrips: () => footprints.locateTrip(data.getTrips()[0]?.id),
    }));
  }

  /* ---------------- 组装 DOM ---------------- */

  /* 全站统一亮色（奶油纸），不再按幕切换明暗。
     原先蛋糕与烟花两幕套的是局部深墨面板，滚过去时整屏颜色跳变，
     配上滚动显得很碎，已按用户要求全部取消。
     明暗现在只由用户自己在主题切换器里决定，不由"当前在哪一幕"决定。

     暖光晕（--halo-warm，极淡的一圈）不改变明暗基调，只是让主体
     「在光下」。v1.7.6 加入情书幕：信封/信纸是那一幕唯一的主体，
     否则近白的纸贴在近白的背景上发飘（用户反馈「氛围不好」）。 */
  const HALO_SCENES = new Set(['scene-hero', 'scene-cake', 'scene-letter', 'scene-fireworks']);

  scenes.forEach((scene) => {
    scene.el.classList.add('scene');
    if (HALO_SCENES.has(scene.el.id)) scene.el.classList.add('scene--halo');
    app.appendChild(scene.el);
  });

  // 有的幕需要异步准备（封面要加载 three.js），统一在这里触发
  scenes.forEach((s) => s.init?.());

  // 日常模式下，如果临近生日，顶部给一个手动入口
  if (!birthday && config.birthday.manualEntryOutsideWindow) {
    const entry = h('button', {
      class: 'btn btn--subtle',
      type: 'button',
      text: `${birthdayLabel()} 有个东西给你`,
      /* ⚠️ 定位用 left+margin 居中，**不能用 transform**：
         .btn 的 hover/active 都写 transform（抬起、按压），
         一旦用 translateX 居中，hover 时按钮会整个跳出去。 */
      style: {
        position: 'fixed',
        left: '0',
        right: '0',
        top: 'calc(14px + env(safe-area-inset-top))',
        margin: '0 auto',
        width: 'fit-content',
        zIndex: '75',
        fontSize: '13px',
        padding: '9px 18px',
      },
      onClick: () => {
        const url = new URL(location.href);
        url.searchParams.set('bday', '1');
        location.href = url.toString();
      },
    });
    // 只在临近生日时出现；判断逻辑在 mode.js 里
    import('./lib/mode.js').then(({ shouldShowManualEntry }) => {
      if (shouldShowManualEntry()) app.appendChild(entry);
    });
  }

  /* ---------------- 常驻控件 ---------------- */

  /* 设置入口挂在 body 上（fixed 定位），但**只在「第一页」那一段可见**：
     生日模式＝首页那一幕，日常模式＝旅行足迹（它就是第一页）。
     不用 absolute 挂进场景：日常模式的第一页是一张很长的页面，
     那样会被推到整页最底部，首屏根本看不见（v1.2.9 就是这么错的）。
     右侧那列进度点已按用户要求整体去掉。 */
  const firstPage = birthday
    ? (scenes.find((s) => s.el.id === 'scene-hero') || scenes[0])
    : scenes[0];
  const firstPageIndex = scenes.indexOf(firstPage);

  const settings = mountSettings(document.body);
  settings?.setVisible(true);

  /* 追踪器仍要创建：幕的 onEnter/onLeave 与视差都靠它那个已节流的滚动回调。
     不传 dotsContainer 就只跟踪、不画点。 */
  initSceneTracker({
    scenes: scenes.map((s) => s.el),
    dotsContainer: null,
    onChange: (i) => {
      scenes.forEach((s, idx) => {
        if (idx === i) s.onEnter?.();
        else s.onLeave?.();
      });
      // 离开第一页就把设置入口收起来
      settings?.setVisible(i === firstPageIndex);
    },
  });

  /* 视差只挂在不会被入场动画占用 transform 的元素上 ——
   .reveal 用 transform 做入场，两者会互相覆盖。 */
  registerParallax(qs('#scene-opening .scene__inner'), { depth: 26 });
  registerParallax(qs('#scene-footprints .fp__head'), { depth: 10 });

  /* ---------------- 入场动画 ---------------- */

  initReveal(app);

  /* ---------------- 数据：后台加载，不挡首屏 ---------------- */

  // 数据加载放在后台，遮罩先撤，避免页面看起来"卡在转圈"
  footprints.refresh({ animateStats: true })
    .catch((err) => console.warn('[data]', err));

  await sleep(220);
  bootMask?.classList.add('is-done');
  window.__appBooted = true;

  maybeShowWeChatTip(ls);
}

/* --------------------------------------------------------------------------
   把 config.ui 的字号与栏宽写进 CSS 变量
   -------------------------------------------------------------------------- */

/* 效果档：只看设备能力与用户意愿，不看当前配色。
   full  默认
   lite  内存或核心数偏低的机器：粒子减半、毛玻璃全关、DPR 降到 1.25
   calm  用户开了「减少动效」：Canvas 完全不启动 */
function detectEffects() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return 'calm';
  }

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && conn.saveData) return 'lite';

  const mem = navigator.deviceMemory;
  if (typeof mem === 'number' && mem <= 4) return 'lite';

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores <= 4) return 'lite';

  return 'full';
}

function applyUiConfig() {
  const root = document.documentElement;
  const ui = config.ui || {};

  const scale = Number(ui.fontScale);
  root.style.setProperty('--fs', String(Number.isFinite(scale) && scale > 0 ? scale : 1));

  const width = Number(ui.maxWidth);
  if (Number.isFinite(width) && width > 0) {
    root.style.setProperty('--col', `${width}px`);
  }

  // 必须在任何 Canvas 层被创建之前设置，fx.js 构造时会读它
  root.dataset.effects = detectEffects();

  syncScrollbarInset(true);
  /* ⚠️ resize 时用 force=false（只读 innerWidth - clientWidth 的差值）。
     force=true 会走 probeScrollbarWidth()：createElement → appendChild(body)
     → 读 offsetWidth → remove()，是典型的**强制同步布局**。移动端滚动时
     地址栏收起/展开会持续派发 resize（虽然有 rAF 节流，但每帧都往 body
     插一个节点再读一次布局），低端安卓上可感知的滚动卡顿。
     而结果只用于更新 --sbw、且只记量到过的最大值 —— 第一次测到之后
     后续所有测量都是白做的。探针只在启动与 load 时用。 */
  window.addEventListener('resize', () => throttledScrollbarInset(false));
  /* 页面一开始可能不够高（日常模式只有一屏），那一刻量到的是 0。
     这两条兜底 + 下面那个滚动探测，保证滚动条真出现时能把宽度记下来：
       1. load 之后再量一次（此时场景都排好版了）
       2. 启动 600ms 再量一次（图片/数据把页面撑高的情形）
       3. 滚动事件触发时量（量到就摘掉监听，之后不再听） */
  window.addEventListener('load', () => throttledScrollbarInset(true));
  setTimeout(() => syncScrollbarInset(true), 600);
  window.addEventListener('scroll', onScrollProbe, { passive: true });
}

/* --------------------------------------------------------------------------
   滚动条宽度 → --sbw
   右侧固定的进度点与设置入口是相对**窗口外缘**定位的（实测 right = innerWidth - 偏移），
   而桌面浏览器的滚动条正好占着最外侧那一竖条：只写 right: 14px 会被它压住，
   滚动条一出现/消失还会把这列点推来推去。
   量出实际宽度交给 CSS 让位，位置就稳定了。

   ⚠️ 只记「量到过的最大值」：滚动条不在场时（解锁门锁滚动、页面还短）
      量到的是 0，若照它让位，滚动条一出现这列点又会挪一次。
   -------------------------------------------------------------------------- */

let sbwKnown = 0;
let sbRaf = null;

/** 只读差值，不改页面状态 */
function readScrollbarWidth() {
  return Math.max(0, Math.round(window.innerWidth - document.documentElement.clientWidth));
}

/**
 * 量平台滚动条的宽度（覆盖层滚动条量到 0，等于不需要让位）。
 *
 * ⚠️ 用一次性离屏元素来量，**绝不能去改 documentElement 的 overflowY**：
 *    改完再「恢复」会把 `overflow-y: hidden` 留成一条独立的内联声明，
 *    而解锁门解锁执行的是 `style.overflow = ''` —— 只清得掉简写，
 *    清不掉那条长写，于是过了登录门页面就再也滑不动（v1.2.4 的线上事故）。
 */
function probeScrollbarWidth() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:100px;height:100px;overflow-y:scroll;';
  document.body.appendChild(probe);
  const w = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return Math.max(0, Math.round(w));
}

function syncScrollbarInset(force = false) {
  const w = force ? probeScrollbarWidth() : readScrollbarWidth();
  if (w > sbwKnown) {
    sbwKnown = w;
    document.documentElement.style.setProperty('--sbw', `${w}px`);
  }
}

function throttledScrollbarInset(force = false) {
  if (sbRaf) return;
  sbRaf = requestAnimationFrame(() => {
    sbRaf = null;
    syncScrollbarInset(force);
  });
}

function onScrollProbe() {
  if (sbwKnown > 0) {
    window.removeEventListener('scroll', onScrollProbe);
    return;
  }
  throttledScrollbarInset();
}

/* --------------------------------------------------------------------------
   解锁前锁住滚动
   直接在 onPass 里解锁，不用 MutationObserver —— 观察者只监听"将来"的变化，
   万一她在初始化完成之前就输入正确，会永远锁死滚动。
   -------------------------------------------------------------------------- */

/** 清掉 overflow 的三个内联声明。
    只写 `style.overflow = ''` 是不够的：它只移除简写，
    别人若单独设过 overflow-x / overflow-y，那些声明会留下来继续生效 ——
    表现就是「登录门过了却滑不动」。实现在 lib/dom.js，几处弹层共用。 */
function lockScroll() {
  document.documentElement.classList.add('is-locked');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
}

function unlockScroll() {
  document.documentElement.classList.remove('is-locked');
  clearOverflow(document.documentElement);
  clearOverflow(document.body);
}

/* --------------------------------------------------------------------------
   鉴权：写操作前弹一次口令
   -------------------------------------------------------------------------- */

async function requestAuth(then) {
  const pwd = await askPassword();
  if (!pwd) return;
  try {
    await data.login(pwd);
  } catch {
    showNotice('口令不对');
    return;
  }
  // 登录状态变了，时间线要重渲染一次编辑/删除按钮才会出现
  footprints.refresh().then(then).catch(then);
}

async function confirmDelete(trip) {
  const label = trip.city || trip.title || '这一段';
  const ok = await confirmBox(`删除「${label}」？`, { confirmText: '删除' });
  if (!ok) return;
  data.deleteTrip(trip.id).then(() => showNotice('已删除'));
}

/* --------------------------------------------------------------------------
   启动
   -------------------------------------------------------------------------- */

boot().catch((err) => {
  console.error('[boot]', err);
  const mask = qs('#boot');
  if (mask) mask.classList.add('is-done');
  showNotice('页面加载出了点问题，刷新试试');
});

window.addEventListener('error', (e) => {
  console.error('[error]', e.error || e.message);
});
