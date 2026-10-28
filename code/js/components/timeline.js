/* ==========================================================================
   timeline.js · 竖向时间线
   方向：自上而下、由近及远。顶部是最近一次旅行，底部是最初。
   主干颜色随时间远去而变淡。
   展开层级：旅行卡片 → 景区列表 → 点照片看大图。
   ========================================================================== */

import { config } from '../config.js';
import { h, qs } from '../lib/dom.js';
import { openGallery } from './lightbox.js';

/* 空状态文案走 config，
   免得同一个词在配置里改不掉、在代码里改不动（两处不一致）。 */
const fpCfg = config.footprints || {};

const DATE_FMT = (iso) => {
  if (!iso) return '';
  const [y, m] = String(iso).split('-');
  return m ? `${y}.${m}` : y;
};

/* 备注里纯「05-10 ~ 05-12」这类日期区间：它不是一句话，
   按正文渲染会很突兀，识别出来后改用日期行的样式排进卡头。 */
const RANGE_RE = /^\s*\d{2,4}[-./]\d{1,2}(?:[-./]\d{1,2})?\s*~+\s*\d{2,4}[-./]\d{1,2}(?:[-./]\d{1,2})?\s*$/;

/* 照片入场时各自歪的角度（度），循环取用 —— 齐刷刷摆好不如刚倒出来一摞的真实 */
const FAN_TILT = [-3, 2.5, -2, 3, -1.5, 2, -2.5, 1.5];
/* 封面小堆的垫底角度：顶张接近摆正，越往下越歪 */
const STACK_TILT = [-2, 4, -6];

/** 越往下（越久远）圆点越淡 */
function fadeLevel(index) {
  if (index === 0) return '0';
  if (index <= 2) return '1';
  return '2';
}

export function createTimeline({
  trips,
  isAuthed = false,
  onEdit,
  onDelete,
  onLocate,
  onAdd,
} = {}) {
  const el = h('div', { class: 'tl' }, h('div', { class: 'tl__rail' }));
  const openIds = new Set();

  function render() {
    // 重建时只保留主干竖线，其余节点全部清掉。
    // 之前只移除 .tl__item，导致空状态和「起点」标签会在每次重建后累积。
    [...el.children].forEach((node) => {
      if (!node.classList.contains('tl__rail')) node.remove();
    });

    if (!trips.length) {
      el.appendChild(renderEmpty());
      return;
    }

    // 数据已按日期降序，所以年份只会在往下走的时候变小。
    // 加一条年份分隔，翻看时才有"一册一册"的层次，而不是一根到底的长线。
    let lastYear = null;

    trips.forEach((trip, i) => {
      const year = String(trip.date || '').slice(0, 4);
      if (year && year !== lastYear) {
        el.appendChild(h('p', { class: 'tl__year', text: year }));
        lastYear = year;
      }

      const item = renderItem(trip, i);
      // 错峰序号。封顶 6 —— 再往后延迟就超出 400ms，用户会觉得"卡"而不是"有节奏"。
      item.style.setProperty('--i', String(Math.min(i, 6)));
      el.appendChild(item);
    });
  }

  function renderEmpty() {
    return h('div', { class: 'fp__empty' },
      h('div', { class: 'fp__empty-dot' }),
      h('p', { text: fpCfg.emptyState }),
      h('button', {
        class: 'btn', type: 'button',
        text: fpCfg.emptyAddButton || '添加第一段',
        onClick: onAdd,
      }));
  }

  /* ⚠️ 不要把 tripId 拼进 CSS 选择器。原来写的是
     qs(`[data-trip-id="${tripId}"]`)，而 tripId 来自服务端
     （trips.php 的 clean_text 只剔控制字符，**不拦** " 和 ] 等
     选择器元字符，且客户端可以自带 id）—— 一条 id 含 `"` 的行程就会让
     markNew / locate 抛 SyntaxError: Failed to execute 'querySelector'。
     而这两个方法都在 footprints.js 的 requestAnimationFrame 里裸调，
     异常无人接 → 新增行程后"刚插入"的高亮和定位直接失效。
     改成遍历 + 比对 dataset，同时天然免疫任何元字符。 */
  function findTripNode(tripId) {
    if (tripId == null) return null;
    const id = String(tripId);
    return Array.from(el.querySelectorAll('[data-trip-id]'))
      .find((n) => n.dataset.tripId === id)?.closest('.tl__item') || null;
  }

  /* 平滑滚动要尊重「减少动效」偏好 —— CSS 的 scroll-behavior 管不到
     JS 显式传的 behavior:'smooth'（显式值优先级更高）。 */
  function scrollToNode(node) {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
  }

  function renderItem(trip, index) {
    const isOpen = openIds.has(trip.id);

    const noteIsRange = RANGE_RE.test(trip.note || '');
    /* ⚠️ 原来这里无条件渲染一个带 &nbsp; 的空 <p>，用来把卡片「撑」出一行高度。
       注释写的理由是「右上角照片堆按有一行备注的高度摆」——
       但照片堆是 position:absolute (top:12px)，根本不依赖这行，那个理由
       早已不成立。卡头改成两行后主区本来就变高，这行占位成了纯白块。

       更要紧的是：纯日期区间的备注（05-10 ~ 05-12 这种）**已经渲染在
       卡头的 .trip__range 里了**，正文再渲染一遍就是同一个区间出现两次
       （实测截图里「09-25 ~ 09-26」确实上下各有一份）。

       所以：纯区间的备注在正文这一行**完全不出**（它已由卡头承担），
       其他情况也只在真有内容时才渲染。 */
    const noteRaw = (trip.note || '').trim();
    const noteText = noteIsRange ? '' : noteRaw;
    const note = noteText
      ? h('p', { class: 'trip__note', text: noteText })
      : null;

    const covers = tripCoverPhotos(trip);

    /* ⚠️ 原来只有 onClick + CSS 的 cursor:pointer，整张卡不可聚焦 ——
       展开后的 .photo（真 button）和 .trip__action 都在 grid-template-rows:0fr
       的折叠区里，键盘用户**根本触达不到照片网格与灯箱**。
       加 tabindex/role/aria-expanded + Enter/Space 触发，
       再由 toggle() 统一同步 aria-expanded。 */
    const card = h('article', {
      class: `trip${isOpen ? ' is-open' : ''}${covers.length ? ' has-stack' : ''}`,
      dataset: { tripId: trip.id },
      tabindex: '0',
      role: 'button',
      'aria-expanded': isOpen ? 'true' : 'false',
      'aria-label': `${trip.city || trip.title || '未命名'}，${DATE_FMT(trip.date)}`,
      onClick: (e) => {
        if (e.target.closest('button')) return;
        toggle(card, trip);
      },
      onKeydown: (e) => {
        if (e.target !== card) return;          // 让内部按钮自己处理
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle(card, trip);
        }
      },
    },
      h('div', { class: 'trip__main' },
        h('div', { class: 'trip__top' },
          /* 两行排版：第一行地点，第二行时间。
             原来是把日期和城市并排塞进一个 flex 行，读起来是
             「2026.09  屿城」——数字和地名挤在一起，地点的识别度被压低了。
             地点单独一行更像是标题，时间退到下面做次级信息。 */
          h('div', { class: 'trip__place' },
            h('span', { class: 'trip__city', text: trip.city || trip.title || '未命名' }),
            trip.country ? h('span', { class: 'trip__country', text: trip.country }) : null),
          h('div', { class: 'trip__when' },
            h('span', { class: 'trip__date', text: DATE_FMT(trip.date) }),
            noteIsRange ? h('span', { class: 'trip__range', text: noteRaw }) : null)),
        note,
        trip.tags?.length ? h('div', { class: 'trip__tags' }, trip.tags.map((t) => h('span', { class: 'tag', text: t }))) : null),
      covers.length ? renderStack(covers) : null,
      buildMore(trip, isOpen));

    const item = h('div', {
      class: `tl__item${isOpen ? ' is-open' : ''}`,
      dataset: { fade: fadeLevel(index) },
    },
      h('span', { class: 'tl__ripple' }),
      h('span', { class: 'tl__dot' }),
      card);

    return item;

    /* 展开只动被点的这一张卡：翻 is-open 类 + 懒填内容，
       绝不整条时间线重建 —— 那会让所有卡片的重叠入场动画重播一遍（整屏闪）。 */
    function toggle(cardEl, trip) {
      const opening = !openIds.has(trip.id);
      if (opening) openIds.add(trip.id);
      else openIds.delete(trip.id);

      // 状态与 ARIA 同步（键盘路径不会走 onClick）
      cardEl.setAttribute('aria-expanded', opening ? 'true' : 'false');
      const item = cardEl.closest('.tl__item');
      const inner = qs('.trip__more-inner', cardEl);
      if (opening) {
        if (!inner.dataset.filled) {
          inner.append(...[renderSpots(trip), renderActions(trip)].filter(Boolean));
          inner.dataset.filled = '1';
        }
        /* 先在冻结过渡下量出「抽屉展开后」的最终格位，再真正开始展开动画 ——
           不然克隆照着还没展开的旧坐标飞，落点全是错的 */
        const targets = measureExpanded(cardEl);
        cardEl.classList.add('is-open');
        item?.classList.add('is-open');
        scatterToGrid(cardEl, targets);
      } else {
        cardEl.classList.remove('is-open');
        item?.classList.remove('is-open');
        gatherToStack(cardEl);
      }
      onLocate?.(trip);
    }
  }

  /** 展开区：内容装在这里，高度由 CSS 的 grid-rows 0fr→1fr 过渡 */
  function buildMore(trip, isOpen) {
    const inner = h('div', { class: 'trip__more-inner' });
    if (isOpen) {
      inner.append(...[renderSpots(trip), renderActions(trip)].filter(Boolean));
      inner.dataset.filled = '1';
    }
    return h('div', { class: 'trip__more' }, inner);
  }

  /** 卡片封面：按 spots 顺序取前 3 张有图的缩略图，垫在收起卡片右上角 */
  function tripCoverPhotos(trip) {
    const pool = [
      ...(trip.spots || []).flatMap((s) => s.photos || []),
      ...(trip.photos || []),
    ];
    const out = [];
    for (const p of pool) {
      const src = typeof p === 'string' ? p : (p.thumb || p.full || '');
      if (!src) continue;
      out.push({ src });
      if (out.length >= 3) break;
    }
    return out;
  }

  /** 迷你照片堆：像刚洗出来随手叠放的几张，展开时整体转正淡出（纯装饰） */
  function renderStack(photos) {
    return h('div', { class: 'trip__stack', 'aria-hidden': 'true' },
      photos.map((p, i) => {
        const img = h('img', { src: p.src, alt: '', loading: 'lazy', decoding: 'async' });
        img.style.setProperty('--stack-tilt', `${STACK_TILT[i] || 0}deg`);
        return img;
      }));
  }

  /* ---------------- 展开/收起的照片飞行 ----------------
     同一套克隆 FLIP：克隆一张 fixed 层的照片，沿现量的起止 rect 飞，
     真身先藏后揭。展开 = 堆叠撒进网格；收起 = 前三张飞回堆叠。 */

  function reducedMotion() {
    return document.documentElement.dataset.effects === 'calm'
      || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function cancelFlight(cardEl) {
    cardEl.__flightCancel?.();
    cardEl.__flightCancel = null;
  }

  /* 抽屉展开是 430ms 的过渡，直接量 rect 拿到的是「还没展开」的布局。
     这里冻结过渡瞬移到终态量准格位，再瞬移回起点恢复过渡 ——
     全程同步执行、中间不产生绘制，肉眼无感。 */
  function measureExpanded(cardEl) {
    const drawer = qs('.trip__more', cardEl);
    const photos = [...cardEl.querySelectorAll('.photo')];
    if (!drawer || !photos.length) return [];
    const item = cardEl.closest('.tl__item');

    /* is-landing 同时按住 photo-fan：不然 is-open 一加、动画回填的 scale(0.88)
       起始姿势会让量出来的格子是缩小态，克隆照着飞又是错的 */
    photos.forEach((p) => p.classList.add('is-landing'));
    drawer.style.transition = 'none';
    cardEl.classList.add('is-open');
    item?.classList.add('is-open');
    void drawer.offsetHeight;                     // 终态布局
    const rects = photos.map((p) => p.getBoundingClientRect());
    cardEl.classList.remove('is-open');
    item?.classList.remove('is-open');
    void drawer.offsetHeight;                     // 回到起点
    drawer.style.transition = '';                 // 恢复过渡，供真正的展开用
    photos.forEach((p) => p.classList.remove('is-landing'));
    return rects;
  }

  function makeClone(src, rect, cls) {
    const c = h('img', { class: `trip-clone ${cls}`, src, alt: '', draggable: 'false' });
    c.style.left = `${rect.left}px`;
    c.style.top = `${rect.top}px`;
    c.style.width = `${rect.width}px`;
    c.style.height = `${rect.height}px`;
    document.body.appendChild(c);
    return c;
  }

  /** 展开：堆叠里的照片撒进网格 —— **全部照片**都从堆叠的位置起飞，
      交错间隔按张数自动压缩（几十张也不拖沓），落一张揭一张。 */
  function scatterToGrid(cardEl, targets) {
    if (reducedMotion()) return;
    const stack = qs('.trip__stack', cardEl);
    if (!stack) return;
    const flyers = [...cardEl.querySelectorAll('.photo')].filter((p) => p.querySelector('img'));
    if (!flyers.length || !targets.length) return;
    cancelFlight(cardEl);

    const stackRect = stack.getBoundingClientRect();
    const photos = [...cardEl.querySelectorAll('.photo')];
    const n = flyers.length;
    const step = Math.min(70, Math.round(500 / n));
    const timers = [];
    const clones = [];

    flyers.forEach((photo, i) => {
      const rect = targets[photos.indexOf(photo)];
      photo.classList.add('is-landing');

      /* 克隆从堆里起飞时就用目标格子的宽高比：全程等比缩放，
         落地瞬间画面内容和真身完全一致 —— 不然最后一帧会有
         「落地后再调整一次比例」的跳动 */
      const w0 = stackRect.width;
      const h0 = stackRect.width * (rect.height / rect.width);
      const base = {
        left: stackRect.left,
        top: stackRect.top + (stackRect.height - h0) / 2,
        width: w0,
        height: h0,
      };
      const s = rect.width / w0;   // 等比：宽高比一致，横纵系数相同
      const c = makeClone(photo.querySelector('img').getAttribute('src'), base, 'is-plane');
      c.style.zIndex = String(100 - i);
      /* 圆角反向补偿：transform 放大 k 倍时圆角也跟着变大，
         先除回去，落地渲染出来才和真身格子的圆角一致 */
      const cellRadius = parseFloat(getComputedStyle(photo).borderRadius) || 8;
      c.style.borderRadius = `${(cellRadius / s).toFixed(2)}px`;
      /* 起始姿势：堆在 pile 上的一点错位与歪斜；变换列表与终点同构，插值才顺 */
      const ox = ((i % 3) - 1) * 3;
      const oy = ((i % 2) - 0.5) * 3;
      const tilt = FAN_TILT[i % FAN_TILT.length] || 0;
      c.style.transform = `translate(${ox}px, ${oy}px) scale(1, 1) rotate(${tilt}deg)`;
      clones.push(c);

      const dx = (rect.left + rect.width / 2) - (base.left + base.width / 2);
      const dy = (rect.top + rect.height / 2) - (base.top + base.height / 2);
      timers.push(setTimeout(() => {
        c.style.transform = `translate(${dx}px, ${dy}px) scale(${s}, ${s}) rotate(0deg)`;
      }, 60 + i * step));
      timers.push(setTimeout(() => {
        c.remove();
        photo.classList.remove('is-landing');
        photo.classList.add('is-landed');
      }, 60 + i * step + 470));
    });
    void document.body.offsetWidth;   // 先提交起始姿势，过渡才会从堆叠出发

    cardEl.__flightCancel = () => {
      timers.forEach(clearTimeout);
      clones.forEach((c) => c.remove());
      cardEl.querySelectorAll('.photo.is-landing, .photo.is-landed')
        .forEach((p) => p.classList.remove('is-landing', 'is-landed'));
    };
  }

  /** 收起：网格里**全部照片**飞回右上堆叠。
      顶张（网格第 1 张）最后落、压最上；第 4 张起飞到堆上后被"吸收"淡出 ——
      堆叠只留 3 张，其余都收进去。 */
  function gatherToStack(cardEl) {
    if (reducedMotion()) return;
    const stack = qs('.trip__stack', cardEl);
    if (!stack || !stack.children.length) return;
    const flyers = [...cardEl.querySelectorAll('.photo')]
      .filter((b) => b.querySelector('img'));
    if (!flyers.length) return;
    cancelFlight(cardEl);

    /* 终点不能用现场 rect：抽屉收起时卡片高度正在变，量到就过时了。
       堆叠钉在卡片右上角，相对卡片左上角的偏移恒定 —— 用 offset 合成终态坐标。 */
    const cardRect = cardEl.getBoundingClientRect();
    const target = {
      left: cardRect.left + stack.offsetLeft,
      top: cardRect.top + stack.offsetTop,
      width: stack.offsetWidth,
      height: stack.offsetHeight,
    };
    const timers = [];
    const clones = [];

    stack.classList.add('is-held');   // 堆叠先藏着，等克隆落地再露面
    flyers.forEach((b) => b.classList.add('is-landing'));

    const n = flyers.length;
    const step = Math.min(70, Math.round(500 / n));
    let end = 0;

    flyers.forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const c = makeClone(b.querySelector('img').getAttribute('src'), r, 'is-gather');
      c.style.zIndex = String(100 - i);   // 先飞的盖在上面；后飞的塞进堆底
      c.style.transform = 'translate(0px, 0px) rotate(0deg) scale(1, 1)';
      /* 白边/圆角/阴影反向补偿：克隆整体要缩到堆叠那么小，
         transform 会把这三样一起缩成发丝线 —— 先按缩放系数放大写进克隆，
         落地渲染出来才和真身堆一模一样，揭幕不再「阴影一重一轻」地闪 */
      const gs = target.width / r.width;
      c.style.borderWidth = `${(2 / gs).toFixed(2)}px`;
      c.style.borderRadius = `${(6 / gs).toFixed(2)}px`;
      c.style.boxShadow = `0 ${(2 / gs).toFixed(2)}px ${(8 / gs).toFixed(2)}px rgba(0, 0, 0, 0.12)`;
      clones.push(c);

      const tilt = STACK_TILT[i] || 0;
      /* 真身堆的第 2、3 张各带 2~3px 的垫位移（CSS nth-child），
         克隆落点不带的话揭幕瞬间会错位一跳 */
      const ox = i === 1 ? 2 : i === 2 ? -2 : 0;
      const oy = i === 1 ? 2 : i === 2 ? 3 : 0;
      const dx = (target.left + target.width / 2) - (r.left + r.width / 2) + ox;
      const dy = (target.top + target.height / 2) - (r.top + r.height / 2) + oy;
      const sx = target.width / r.width;
      const sy = target.height / r.height;
      const launch = (n - 1 - i) * step;  // 逆序起飞：顶张最后落、压最上
      const land = launch + 430;
      timers.push(setTimeout(() => {
        c.style.transform = `translate(${dx}px, ${dy}px) rotate(${tilt}deg) scale(${sx}, ${sy})`;
      }, launch));

      if (i < stack.children.length) {
        end = Math.max(end, land + 60);   // 前 3 张留到揭幕
      } else {
        /* 堆叠装不下的：落到堆上后淡出 —— 被收进去了 */
        timers.push(setTimeout(() => { c.style.opacity = '0'; }, land));
        timers.push(setTimeout(() => { c.remove(); }, land + 280));
        end = Math.max(end, land + 300);
      }
    });

    /* 揭幕顺序不能反：先让真身堆在克隆脚下淡入，都到位了再撤克隆。
       同帧又撤又揭的话，那一瞬间「克隆没了、真身还是透明」—— 就是那一闪 */
    timers.push(setTimeout(() => {
      stack.classList.remove('is-held');
    }, end));
    timers.push(setTimeout(() => {
      clones.forEach((c) => c.remove());
      flyers.forEach((b) => b.classList.remove('is-landing', 'is-landed'));
    }, end + 340));

    cardEl.__flightCancel = () => {
      timers.forEach(clearTimeout);
      clones.forEach((c) => c.remove());
      stack.classList.remove('is-held');
      cardEl.querySelectorAll('.photo.is-landing, .photo.is-landed')
        .forEach((p) => p.classList.remove('is-landing', 'is-landed'));
    };
  }

  function renderSpots(trip) {
    const spots = trip.spots || [];

    if (!spots.length) {
      return h('div', { class: 'spots' },
        trip.photos?.length
          ? renderPhotoGrid(trip.photos)
          : h('p', { class: 'spot__note', text: '这一段还没有记录地点。' }));
    }

    return h('div', { class: 'spots' }, spots.map((spot) => {
      const photoCount = (spot.photos || []).length;
      return h('div', { class: 'spot' },
        h('div', { class: 'spot__head' },
          h('div', { class: 'spot__name' },
            h('span', { class: 'spot__pin' }),
            spot.name || '未命名地点'),
          h('span', {
            class: 'spot__meta',
            text: photoCount ? `${photoCount} 张` : '暂无照片',
          })),
        photoCount ? renderPhotoGrid(spot.photos) : null);
    }));
  }

  function renderPhotoGrid(photos) {
    const btns = [];
    const grid = h('div', { class: 'photo-grid' }, photos.map((p, i) => {
      const src = typeof p === 'string' ? p : (p.thumb || p.full || '');
      if (!src) {
        return h('div', { class: 'photo photo--placeholder' },
          h('span', { text: (p.name || '·').slice(0, 1) }));
      }
      const btn = h('button', {
        class: 'photo',
        type: 'button',
        'aria-label': '查看大图',
        onClick: (e) => {
          e.stopPropagation();
          // 整组按钮递进去：关闭大图时照片要飞回其中第 i 张的缩略图
          openGallery(photos, i, btns);
        },
      }, h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }));
      /* 入场「散开落位」的参数：--tilt 是起点歪角，--d 是交错延迟序号 */
      btn.style.setProperty('--tilt', `${FAN_TILT[i % FAN_TILT.length]}deg`);
      btn.style.setProperty('--d', String(Math.min(i, 9)));
      btns.push(btn);
      return btn;
    }));
    return grid;
  }

  /* isAuthed 可以传布尔，也可以传函数。
       传函数是为了登录成功后不用重建整个时间线 ——
       下一次 render() 时自然会拿到新的登录状态。 */
  function authed() {
    return typeof isAuthed === 'function' ? !!isAuthed() : !!isAuthed;
  }

  function renderActions(trip) {
    if (!authed()) return null;
    return h('div', { class: 'trip__actions' },
      h('button', {
        class: 'trip__action', type: 'button', text: '编辑',
        onClick: (e) => { e.stopPropagation(); onEdit?.(trip); },
      }),
      h('button', {
        class: 'trip__action trip__action--danger', type: 'button', text: '删除',
        onClick: (e) => { e.stopPropagation(); onDelete?.(trip); },
      }));
  }

  render();

  return {
    el,
    update(nextTrips) {
      trips = nextTrips;
      render();
    },
    /** 新增一条后，把对应节点标成"刚插入"以触发涟漪 */
    markNew(tripId) {
      findTripNode(tripId)?.classList.add('is-new');
    },
    /** 让某一条滚动到视野中央并闪一下 */
    locate(tripId) {
      const node = findTripNode(tripId);
      if (!node) return;
      scrollToNode(node);
      node.classList.add('is-new');
      setTimeout(() => node.classList.remove('is-new'), 1400);
    },
  };
}
