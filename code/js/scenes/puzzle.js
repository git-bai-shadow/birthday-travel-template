/* ==========================================================================
   幕 5 · 拼图
   3×3 拖动交换。给一个「跳过」按钮 —— 卡在这一幕会破坏气氛。
   照片缺失时降级为可玩的数字拼图，不让这一幕开天窗。
   ========================================================================== */

import { config } from '../config.js';
import { h, shuffle } from '../lib/dom.js';
import { createConfetti } from '../lib/fx.js';
import { makeScrollHint } from '../lib/scroll.js';

export function createPuzzle() {
  const cfg = config.puzzle;
  const N = cfg.size;
  const COUNT = N * N;

  const board = h('div', { class: 'puzzle', style: { gridTemplateColumns: `repeat(${N}, minmax(0,1fr))` } });
  const doneBox = h('div', { class: 'stack stack--center stack--gap-8 puzzle__done', style: { display: 'none' } },
    h('p', { class: 'display display--md', text: cfg.done }),
    h('p', { class: 'lead', style: { whiteSpace: 'pre-line' }, text: cfg.doneSub }));
  const burstCanvas = h('canvas', { class: 'canvas-layer', 'aria-hidden': 'true' });

  /* 「把它拼回去 /（点两下方块交换位置）」这一组。
     拼好或跳过后要收起 —— 活儿都干完了还挂着教人怎么玩，很出戏。 */
  const guide = h('div', { class: 'stack stack--center stack--gap-8 puzzle__guide' },
    h('p', { class: 'lead', text: cfg.hint }),
    h('p', { class: 'muted', style: { fontSize: '12.5px' }, text: cfg.subHint }));

  const skipBtn = cfg.allowSkip
    ? h('button', {
        class: 'btn btn--ghost', type: 'button', text: cfg.skip || '跳过',
        style: { marginTop: '18px' },
        onClick: () => finish(false),
      })
    : null;

  const hint = makeScrollHint();

  const el = h('section', { class: 'scene', id: 'scene-puzzle' },
    burstCanvas,
    h('div', { class: 'scene__inner stack stack--center stack--gap-24' },
      h('div', { class: 'reveal' }, guide),
      h('div', { class: 'reveal' }, board),
      h('div', { class: 'reveal' }, doneBox),
      h('div', { class: 'reveal' }, skipBtn)),
    hint);

  let order = [];
  let picked = null;
  let finished = false;
  let confetti = null;
  let imageUrl = null;

  /* ---------------- 构建 ---------------- */

  function build() {
    order = shuffle([...Array(COUNT).keys()]);
    // 避免一开始就是拼好的
    if (order.every((v, i) => v === i)) [order[0], order[1]] = [order[1], order[0]];

    board.replaceChildren();
    order.forEach((piece, slot) => {
      const tile = h('button', {
        class: 'puzzle__tile',
        type: 'button',
        dataset: { slot: String(slot), piece: String(piece) },
        'aria-label': `第 ${slot + 1} 格`,
        onClick: () => onTile(slot),
      });
      paintTile(tile, piece);
      board.appendChild(tile);
    });
  }

  /** 把第 piece 块贴到方块上 */
  function paintTile(tile, piece) {
    const row = Math.floor(piece / N);
    const col = piece % N;
    const px = N > 1 ? (col / (N - 1)) * 100 : 0;
    const py = N > 1 ? (row / (N - 1)) * 100 : 0;

    if (imageUrl) {
      /* ⚠️ 先把"色块降级"那一趟留下的内联样式清干净。
         图片是随后异步加载好、再 repaintAll() 补上的，而第一趟渲染走的是
         else 分支：它写下的数字与 opacity(0.35~0.9) 会一直留着 ——
         表现就是数字浮在照片上、照片还被洗淡一层。 */
      tile.textContent = '';
      tile.style.opacity = '';
      tile.style.background = '';
      tile.style.display = '';
      tile.style.placeItems = '';
      tile.style.fontSize = '';
      tile.style.fontFamily = '';

      tile.style.backgroundImage = `url("${imageUrl}")`;
      tile.style.backgroundSize = `${N * 100}% ${N * 100}%`;
      tile.style.backgroundPosition = `${px}% ${py}%`;
    } else {
      // 无图降级：用色块 + 数字，仍然能玩
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim();
      tile.style.background = piece % 2 ? accent : accent2;
      tile.style.opacity = String(0.35 + (piece / COUNT) * 0.55);
      tile.textContent = String(piece + 1);
      tile.style.display = 'grid';
      tile.style.placeItems = 'center';
      tile.style.fontSize = '18px';
      tile.style.fontFamily = 'var(--mono)';
    }
  }

  function repaintAll() {
    [...board.children].forEach((tile, slot) => {
      paintTile(tile, order[slot]);
      tile.dataset.piece = String(order[slot]);
      tile.classList.toggle('is-picked', picked === slot);
    });
  }

  /* ---------------- 交互 ---------------- */

  function onTile(slot) {
    if (finished) return;

    if (picked === null) {
      picked = slot;
      repaintAll();
      return;
    }
    if (picked === slot) {
      picked = null;
      repaintAll();
      return;
    }

    [order[picked], order[slot]] = [order[slot], order[picked]];
    picked = null;
    repaintAll();
    checkSolved();
  }

  function checkSolved() {
    if (order.every((v, i) => v === i)) finish(true);
  }

  function finish(solved) {
    if (finished) return;
    finished = true;

    skipBtn && (skipBtn.style.display = 'none');
    guide.classList.add('is-gone');            // 提示语收起，位置让给收尾文字

    if (solved) {
      /* 拼好了：**照片留下来** —— 拼出来的那张照片才是这一幕的奖品，
         原来是淡出再 display:none，她一拼完就只剩两行字，像白玩了。
         这里只让它轻轻落定 + 散出一圈暖光。 */
      board.classList.add('is-done', 'is-solved');
      doneBox.style.display = 'flex';
      requestAnimationFrame(() => doneBox.classList.add('is-in'));

      if (!confetti) confetti = createConfetti(burstCanvas, { count: 34 });
      confetti.burst(window.innerWidth / 2, window.innerHeight * 0.45, 38);
      return;
    }

    /* 跳过：没拼出来的照片留着没意义，收掉它，只留收尾文字 */
    board.style.transition = 'opacity var(--dur-slow) ease, transform var(--dur-slow) ease';
    board.style.opacity = '0';
    board.style.transform = 'scale(0.94)';

    setTimeout(() => {
      board.style.display = 'none';
      doneBox.style.display = 'flex';
      requestAnimationFrame(() => doneBox.classList.add('is-in'));
    }, 520);
  }

  /* ---------------- 图片 ---------------- */

  function loadImage() {
    const url = cfg.image;
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      imageUrl = url;
      repaintAll();
    };
    img.onerror = () => {
      imageUrl = null;   // 保持色块降级
      repaintAll();
    };
    img.src = url;
  }

  return {
    el,
    onEnter() {
      if (!order.length) {
        build();
        loadImage();
      }
      if (!cfg.image) repaintAll();
      setTimeout(() => hint.classList.add('is-in'), 2200);
    },
    onLeave() { confetti?.stop(); },
    destroy() { confetti?.destroy(); },
  };
}
