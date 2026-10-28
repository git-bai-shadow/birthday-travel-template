/* ==========================================================================
   幕 3 · 旅行足迹（核心）
   时间线 ⇄ 地图 双视图，双向联动。
   这一屏高度自适应，不设满屏 —— 它内部有长滚动，
   若参与外层吸附会和手指抢手势。
   ========================================================================== */

import { config } from '../config.js';
import { h, qs, countUp, store } from '../lib/dom.js';
import * as data from '../lib/store.js';
import { createTimeline } from '../components/timeline.js';
import { createMapView } from '../components/mapview.js';
import { showNotice } from '../components/notice.js';

const VIEW_KEY = 'fp-view';

export function createFootprints({ onAdd, onEdit, onDelete, onDeleteRequest }) {
  const cfg = config.footprints;

  const statsEl = h('p', { class: 'fp__stats' });
  const head = h('div', { class: 'fp__head' },
    h('h2', { class: 'fp__title', text: cfg.title }),
    h('span', { class: 'muted', style: { fontSize: '11.5px' }, text: cfg.sortHint }));

  /* ⚠️ ARIA 要完整。原来有 role="tablist"/"tab" 却缺 aria-selected、
     缺 roving tabindex（两个 tab 都在 tab 序列里）、.fp__body 也没有
     role="tabpanel" + aria-labelledby —— 读屏会念「tab」却得不到选中态，
     比不用 role 更糟。视觉零改动，只补语义。 */
  const viewSwitch = cfg.map.enabled
    ? h('div', { class: 'fp__views', role: 'tablist', 'aria-label': '查看方式' },
        h('button', {
          class: 'fp__view is-active', type: 'button', role: 'tab',
          'aria-selected': 'true', 'aria-controls': 'fp-panel',
          tabindex: '0',
          id: 'fp-tab-timeline',
          dataset: { view: 'timeline' }, text: cfg.tabTimeline || '时间线',
        }),
        h('button', {
          class: 'fp__view', type: 'button', role: 'tab',
          'aria-selected': 'false', 'aria-controls': 'fp-panel',
          tabindex: '-1',
          id: 'fp-tab-map',
          dataset: { view: 'map' }, text: cfg.tabMap || '地图',
        }))
    : null;

  /* 方向键在 tablist 内移动（ARIA tabs 的标准行为） */
  if (viewSwitch) {
    viewSwitch.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const order = ['timeline', 'map'];
      const cur = viewSwitch.querySelector('.fp__view.is-active')?.dataset.view;
      const next = order[(order.indexOf(cur) + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      switchView(next);
      viewSwitch.querySelector(`[data-view="${next}"]`)?.focus();
    });
  }

  const timeline = createTimeline({
    trips: [],
    // 传函数：登录状态变化时不用重建，render() 时会取到最新值
    isAuthed: () => data.isAuthed(),
    onAdd,
    onEdit,
    onDelete,
    onLocate: (trip) => {
      if (currentView === 'map' && trip?.spots?.[0]) {
        mapView?.highlight(`${trip.id}:${trip.spots[0].id}`);
      }
    },
  });

  const mapView = cfg.map.enabled
    ? createMapView({
        points: [],
        onPick: (p) => {
          timeline.locate(p.tripId);
        },
        onLocate: (p) => switchView('timeline', { then: () => timeline.locate(p.tripId) }),
      })
    : null;

  const body = h('div', {
    class: 'fp__body',
    id: 'fp-panel',
    role: 'tabpanel',
    'aria-labelledby': 'fp-tab-timeline',
  }, timeline.el);

  const addBtn = h('button', {
    class: 'btn btn--accent fp__add',
    type: 'button',
    html: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>${cfg.addButton}</span>`,
    onClick: () => onAdd?.(),
  });

  const el = h('section', { class: 'scene scene--flow', id: 'scene-footprints' },
    h('div', { class: 'scene__inner' },
      head, statsEl, viewSwitch, body, addBtn));

  // 视图优先级：网址参数 > 上次选择 > 默认时间线
  // 支持 ?view=map 直接打开地图，便于分享定位到地图的链接
  function initialView() {
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'map' || q === 'timeline') return q;
    return store.get(VIEW_KEY, 'timeline');
  }

  let currentView = initialView();
  let statsPlayed = false;
  let allTrips = [];

  /* ---------------- 视图切换 ---------------- */

  function syncTabs() {
    if (!viewSwitch) return;
    ['timeline', 'map'].forEach((v) => {
      const btn = qs(`[data-view="${v}"]`, viewSwitch);
      if (!btn) return;
      const on = currentView === v;
      btn.classList.toggle('is-active', on);
      // roving tabindex：选中的那个可聚焦，另一个移出 tab 序列
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    body?.setAttribute('aria-labelledby', `fp-tab-${currentView}`);
  }

  /* silent 参数原来解构出来但函数体从未使用，三处调用方白传。
     真正需要的是 then（切换完成后定位），保留它、去掉 silent。 */
  function switchView(next, { then } = {}) {
    if (!cfg.map.enabled) return;
    currentView = next;
    store.set(VIEW_KEY, next);
    syncTabs();

    if (next === 'map') {
      if (!mapView.el.isConnected) {
        body.replaceChildren(mapView.el);
        mapView.init();
      } else {
        body.replaceChildren(mapView.el);
      }
      mapView.update(data.mapPoints());
    } else {
      body.replaceChildren(timeline.el);
    }

    then?.();
  }

  viewSwitch?.addEventListener('click', (e) => {
    const btn = e.target.closest('.fp__view');
    if (!btn) return;
    switchView(btn.dataset.view);
  });

  /* ---------------- 统计 ---------------- */

  function renderStats({ animate = false } = {}) {
    const s = data.getStats();
    statsEl.replaceChildren();

    const parts = [
      [s.tripCount, cfg.unitTrips || '段旅程'],
      [s.spotCount, cfg.unitSpots || '个景区'],
    ];

    parts.forEach(([n, unit], i) => {
      if (!n) return;      // 为 0 就不占位，免得显示「0 个景区 ·」
      const num = h('b', { class: 'num', text: animate ? '0' : String(n) });
      statsEl.appendChild(num);
      statsEl.appendChild(document.createTextNode(` ${unit} · `));
      if (animate) setTimeout(() => countUp(num, n, 760), i * 120);
    });

    /* 有里程才显示这一段，没有就别硬凑一个 0 公里出来 */
    if (s.km > 0) {
      const kmNum = h('b', { class: 'num', text: animate ? '0' : String(s.km) });
      statsEl.appendChild(document.createTextNode(cfg.unitKmPrefix || '跨越 '));
      statsEl.appendChild(kmNum);
      statsEl.appendChild(document.createTextNode(' ' + (cfg.unitKm || '公里')));
      if (animate) setTimeout(() => countUp(kmNum, s.km, 900), 240);
    }
  }

  /* ---------------- 数据绑定 ---------------- */

  async function refresh({ animateStats = false } = {}) {
    allTrips = await data.loadTrips();

    /* 加载失败要让用户知道。以前 store 会用假数据顶上，
       现在失败就是空的，得有一句人话解释为什么是空的。
       ⚠️ 原来写的是 `data.state && data.state.error`，而 store.js 里的
       state 根本没export —— 这是一段恒为 false 的死代码，"后端挂了要
       告诉用户"的唯一通路从不执行。改用 store 导出的 getError()。 */
    const err = data.getError();
    if (err) {
      showNotice('记录没加载出来（' + err + '），刷新试试', { duration: 6000 });
    }
    /* 静态部署（无后端）降级出来的示例数据：说一句 + 藏掉写入入口，
       免得访客点了「补上一段」却写不进去。 */
    if (data.isDemoData && data.isDemoData()) {
      showNotice('当前是随包的示例数据（这个版本没有后端，只读）', { duration: 5000 });
      /* ⚠️ 不能用 hidden：.btn 的 display:inline-flex 会覆盖它，
         按钮照样显示（而且还占位）。直接 display:none。 */
      addBtn.style.display = 'none';
    }

    timeline.update(allTrips);

    // 恢复上次选中的视图，并把标签高亮同步过去
    syncTabs();
    if (currentView === 'map' && mapView) {
      if (!mapView.el.isConnected) {
        body.replaceChildren(mapView.el);
        mapView.init();
      }
      mapView.update(data.mapPoints());
    } else {
      body.replaceChildren(timeline.el);
    }

    renderStats({ animate: animateStats });
  }

  /* ⚠️ 必须接住 subscribe 的返回值。store.js 的 subscribe() 是返回
     unsubscribe 的（`() => listeners.delete(fn)`），原来返回值被丢弃、
     下一行写了个空壳 `const unsubscribe = () => {}`，destroy() 里的
     unsubscribe() 什么也不做 —— store 的 listeners 是模块级 Set，
     会永久持有 timeline / mapView / 这整个闭包。一行修复。 */
  const unsubscribe = data.subscribe(() => {
    allTrips = data.getTrips();
    timeline.update(allTrips);
    renderStats({});
  });

  return {
    el,
    refresh,
    switchView,
    /** 新增一条后调用：切到时间线并把新节点标成"刚插入" */
    reveal(tripId) {
      switchView('timeline');
      requestAnimationFrame(() => timeline.markNew(tripId));
    },
    locateTrip(tripId) {
      switchView('timeline');
      requestAnimationFrame(() => timeline.locate(tripId));
    },
    get trips() { return allTrips; },
    onEnter() {
      if (!statsPlayed) {
        statsPlayed = true;
        renderStats({ animate: true });
      }
    },
    destroy() {
      unsubscribe();
      mapView?.destroy();
    },
  };
}
