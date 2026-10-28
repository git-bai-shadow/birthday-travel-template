/* ==========================================================================
   幕 7 · 情书
   全场最安静的一幕：背景粒子全部撤掉，只留纸质纹理与逐字浮现。

   信封（v1.2.6 → v1.7.6）：
     原来滚到这一幕就直接开始逐字写，少了一个「收到信」的动作。
     现在先看到一只写着收信人名字、盖着火漆印的信封；点开，封盖翻起来，
     信纸升上来，然后才开始写。
     拆开后状态不回退 —— 往回滚再回来不会又被封上。
     打字必须等她点开才开始，所以 onEnter 里不再直接 start()。

     v1.7.6 拆信重排（用户反馈「要像真实打开信封 + 淡淡向下消失」）：
       0ms    火漆印裂成两半，各自向外向下翻落（原来整体缩放消失）
       180ms  封盖 3D 翻开（父级补了 perspective；原来翻到一半就淡出）
       480ms  信纸升起（1300ms，附带 0.985→1 微缩放）
       1250ms 信封整体向下漂 20px + 淡出 —— 「淡淡的向下消失」；
              同时收回预留给信封的 23.75% 占位，情书卡片平滑落定
              （原来这份空间永不归还，卡片下方一大片死区）
       1960ms 开始逐字打字
     拆信前信封有 7s 周期的极轻浮动（CSS env-float）。

   速度换算：config.letter.speed 是「字 / 分钟」，
   420 约等于整封 40-45 秒读完。之前设成 45 是一个错误，
   那意味着每个字要等 1.3 秒、整封六分钟。
   ========================================================================== */

import { config } from '../config.js';
import { h } from '../lib/dom.js';
import { makeScrollHint, prefersCalmMotion } from '../lib/scroll.js';

/* 火漆印上的心用 path 画，不用字符：
   字符的形状跟着字体走，换台设备就可能变成另一颗心。 */
const SEAL_HEART = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path d="M12 20.3 4.7 13a4.7 4.7 0 0 1 6.7-6.6l.6.6.6-.6A4.7 4.7 0 0 1 19.3 13Z"'
  + ' fill="currentColor"/></svg>';

/* --------------------------------------------------------------------------
   删除号（v1.7.7）
   信稿里用 ~~划掉的文字~~ 标记。真信上手写改动就是划一刀，所以渲染成
   <s>（CSS line-through），不是用组合字符凑 —— 组合字符（U+0336）的位置
   跟字体走，衬线字体上经常高低不齐，而且读屏软件会把它读成乱码。
   -------------------------------------------------------------------------- */

const STRIKE_RE = /~~([\s\S]*?)~~/g;

/** 把信稿切成 [{ text, strike }]；没有标记时就是一整段 */
function parseLetter(text) {
  const segs = [];
  let last = 0;
  STRIKE_RE.lastIndex = 0;
  let m;
  while ((m = STRIKE_RE.exec(text)) !== null) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), strike: false });
    if (m[1]) segs.push({ text: m[1], strike: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), strike: false });
  return segs;
}

/** 剥掉标记的纯文本：读屏、复制、以及一切不需要样式的场合 */
function plainLetterText(text) {
  return parseLetter(text).map((s) => s.text).join('');
}

export function createLetter() {
  const cfg = config.letter;
  const signature = config.site.signature;

  /* 收信人：site.herName 还是 [占位] 时不写，
     免得信封正面出现方括号 —— 那是给做站的人看的，不该给她看。 */
  const herName = String(config.site.herName || '').trim();
  const toName = herName && !herName.includes('[') ? herName : '';

  /* 信的开头先写她的名字。名字由 site.herName 统一提供，
     所以 config 里的正文不用重复写一遍称呼。 */
  const greeting = toName ? `${toName}：\n\n` : '';
  const letterText = greeting + cfg.text;

  const body = h('div', { class: 'letter__body', 'aria-hidden': 'true' });
  const sign = h('div', { class: 'letter__sign', text: `—— ${signature}` });
  // 读屏的人不必等字一个一个出现（也用剥掉 ~~ 标记的纯文本）
  const fullText = h('p', { class: 'sr-only', text: plainLetterText(letterText) });

  const skipBtn = h('button', {
    // 复用 .btn 的形状与交互（抬起/按压/涟漪/焦点环），只保留
    // .letter__skip 自己的淡入逻辑与位置 —— 原来这里手搓了一套
    // 圆角描边按钮，比 .btn 少玻璃、少按压、也没焦点环。
    class: 'btn btn--ghost letter__skip',
    type: 'button',
    text: cfg.skip || '直接看全文',
    onClick: () => finishAll(),
  });

  const paper = h('div', { class: 'letter__paper' });
  const card = h('div', { class: 'letter' }, paper, body, sign, skipBtn, fullText);

  /* ---------------- 信封 ----------------
     层次就是 DOM 顺序（都在 .letter-env 里定位，谁在后面谁在上面）：
       信封底 → 收信人 → 信纸 → 正面（口袋 + 封盖）→ 点击层
     口袋压在信纸下半截上：信纸往上"长"出来时，还留在信封里的那一截
     自然被它挡住 —— 真实信件就是这么出来的，不需要任何裁剪。
     所以信纸是**在正常流里**的（撑起这一页的高度），只是用 transform
     先挪到信封里藏着（--rise-from，开信前量出来）。 */
  const envBack = h('span', { class: 'env__back' });
  const envTo = toName
    ? h('span', { class: 'env__to', text: `${cfg.toLabel || '致'} ${toName}` })
    : null;

  /* 封盖要能"翻过去看到背面"，所以是正反两层：
     正面带火漆印，背面是纸的里侧。转过 90° 之后浏览器显示背面那一层。 */
  const envFlap = h('span', { class: 'env__flap' },
    h('span', { class: 'env__flap-face env__flap-face--front' }),
    h('span', { class: 'env__flap-face env__flap-face--back' }));

  /* 火漆印（v1.7.6 从封盖正面挪到信封上）：
     ① 它原来挂在封盖正面上，封盖一转开就跟着转走、过了 90° 连印带心
        一起消失（backface-visibility），做不了「裂开掉落」；
     ② 真火漆是焊在信封正面、横跨封盖尖与口袋的，拆信时裂开留在原处。
     两半各是完整火漆印的拷贝，被 clip-path 取走一半 ——
     裂痕正好从桃心正中穿过。类名 is-cracking 由 openEnvelope 加。
     ⚠️ 它必须是 .env__front 的子元素，不能直接挂 .letter-env：
        .env__front 的盒子就是信封本身（bottom:0 + aspect-ratio 8/5），
        而 .letter-env 是「信纸 + 给信封的预留占位」的包裹层，高出一大截。
        v1.7.6 第一版挂在包裹层上，bottom:calc(50% - 21px) 按包裹层高算，
        火漆印中心偏到信封顶边下方 16px（V 顶点在 107px）—— 偏了 91px，
        用户截图指出「位置不对」。 */
  const envSeal = h('span', { class: 'env__seal' },
    h('span', { class: 'env__seal-half env__seal-half--l', html: SEAL_HEART }),
    h('span', { class: 'env__seal-half env__seal-half--r', html: SEAL_HEART }));

  /* 信封正面：口袋 + 封盖 + 火漆印。
     ⚠️ 这一层**不能有 z-index** —— 有的话它就自成层叠上下文，
        里面的封盖/火漆印再怎么改 z-index 也翻不到信纸后面去。 */
  const envFront = h('span', { class: 'env__front' },
    h('span', { class: 'env__pocket' }),
    envFlap,
    envSeal);

  /* 点击层：盖住整封信；提示语放在它里面 ——
     「点一下，拆开这封信」这句话本身就该是能点的。 */
  const envHit = h('button', {
    class: 'env__hit',
    type: 'button',
    'aria-label': cfg.openHint || '拆开这封信',
    onClick: openEnvelope,
  },
    h('span', { class: 'env__hint', text: cfg.openHint || '拆开这封信' }));

  /* 火漆印在 .env__front 里（z 7 > 封盖 6）：蜡是压在封盖尖上面的。
     它跟着信封的盒子走，不占包裹层的布局。 */
  const wrap = h('div', { class: 'letter-env' },
    envBack, envTo, card, envFront, envHit);

  const hint = makeScrollHint();

  const el = h('section', { class: 'scene', id: 'scene-letter' },
    h('div', { class: 'scene__inner stack stack--center' },
      h('div', { class: 'reveal' }, wrap)),
    hint);

  // 字号由 config 控制，走 CSS 变量
  el.style.setProperty('--letter-fs', `${cfg.fontSize || 17}px`);

  let opened = false;
  let started = false;
  let done = false;
  let timer = null;
  let cursor = null;
  /* 打字队列：每个元素是 { ch, strike }。strike 的字要包在 <s> 里，
     由 openStrike 记住当前开着的删除段（见 step）。 */
  let chars = [];
  let index = 0;
  let openStrike = null;
  /* 分段结果：finishAll（直接看全文）按它一次性铺完，不走逐字那条路 */
  const segments = parseLetter(letterText);

  const MS_PER_CHAR = 60000 / Math.max(1, cfg.speed);
  const PAUSE = cfg.pauseFactor ?? 1.6;

  /** 减少动效模式：不做过渡，拆开即见全文起点 */
  const isCalm = () => document.documentElement.dataset.effects === 'calm';

  /* ---------------- 拆信 ---------------- */

  /**
   * 量出信纸"藏在信封里"时要往下挪多少，以及要裁掉多高。
   * 用 offsetTop / offsetHeight（布局值，不受 transform 影响），
   * 不能用 getBoundingClientRect —— 那个会把当前 transform 算进去，
   * 量第二遍就偏了。
   *
   * 为什么要裁：信纸通常比信封高（内容多、有最小高度），往下挪之后
   * 下半截会露在信封底边之外 —— 只有口袋是挡不住它的。
   * 按信封底边裁掉，翻上去时裁边同步收掉（同一个 keyframes，见 CSS）。
   */
  function measureRise() {
    // 顶边停在信封顶边之上 2px：露一线纸边，像真有张信纸在里面
    const dy = envBack.offsetTop - card.offsetTop - 2;
    wrap.style.setProperty('--rise-from', `${Math.round(dy)}px`);

    const overflow = card.offsetTop + card.offsetHeight + dy - wrap.offsetHeight;
    wrap.style.setProperty('--clip-from', `${Math.max(0, Math.round(overflow))}px`);
  }

  function openEnvelope() {
    if (opened) return;
    opened = true;

    // 立刻禁用：键盘与点击都不再触发，也退出 Tab 序列
    envHit.disabled = true;
    /* 同时摘掉命中。这层按钮盖着整封信（z 5），不摘的话接下来近两秒里
       她想选中信里的文字、或点到信纸，都会被这层透明按钮吞掉。 */
    envHit.style.pointerEvents = 'none';
    measureRise();                   // 开信前再量一次（字体/宽度变了也不怕）
    /* is-cracking 只服务火漆印两半的飞落（见 .env__seal-half）。
       加上就不摘了 —— 裂开的蜡没有「复原」一说。 */
    wrap.classList.add('is-open', 'is-cracking');

    if (isCalm()) {
      envHit.style.display = 'none';
      start();
      return;
    }

    /* 封盖转到侧面时换层：折回去的封盖贴在信封背面，该落到信纸后面去。
       这一刻它几乎是一条线，换层看不出来。 */
    setTimeout(() => wrap.classList.add('is-flap-back'), 620);

    // 信封淡出干净之后彻底移出无障碍树（这时信纸已经站住了）
    setTimeout(() => { envHit.style.display = 'none'; }, 1950);
    // 信纸升出来、落定之后才开始写字（升纸 480+1300ms，信封退场 1250+700ms）
    setTimeout(start, 1960);
  }

  /* ---------------- 逐字浮现 ---------------- */

  function start() {
    if (started) return;
    started = true;

    // 把分段展开成逐字队列，每个字记住自己属于哪一段
    chars = [];
    for (const seg of segments) {
      for (const ch of seg.text) chars.push({ ch, strike: seg.strike });
    }
    cursor = h('span', { class: 'letter__caret' });   // 竖线块由 CSS 画，不用字符
    body.appendChild(cursor);
    openStrike = null;

    // 打字开始后一会儿再露出跳过按钮，免得一上来就分心
    if (cfg.allowSkip) setTimeout(() => skipBtn.classList.add('is-on'), 2600);

    timer = setTimeout(step, 400);
  }

  function step() {
    if (done) return;

    if (index >= chars.length) {
      finishAll();
      return;
    }

    const item = chars[index++];
    /* 光标永远跟在已打内容的末尾，插入点固定是「光标前一个字符」，
       所以进出删除段只需要搬动光标的位置：
         进段：先插一个 <s>，把光标挪进去 → 之后的字落在 <s> 里
         出段：把光标挪回 body 末尾 → 之后的字落在 <s> 后面
       不用改插入逻辑，光标自己就是插入点。 */
    if (item.strike && !openStrike) {
      openStrike = document.createElement('s');
      cursor.insertAdjacentElement('beforebegin', openStrike);
      openStrike.appendChild(cursor);
    } else if (!item.strike && openStrike) {
      openStrike = null;
      body.appendChild(cursor);
    }
    cursor.insertAdjacentText('beforebegin', item.ch);

    // 只在她看不到正文末尾时才辅助滚动，避免频繁跳动
    if (index % 30 === 0) scrollIfNeeded();

    let delay = MS_PER_CHAR;
    if ('。！？'.includes(item.ch)) delay *= PAUSE * 1.4;
    else if ('，、；：'.includes(item.ch)) delay *= PAUSE;
    else if (item.ch === '\n') delay *= PAUSE * 2;

    timer = setTimeout(step, delay);
  }

  function scrollIfNeeded() {
    const rect = body.getBoundingClientRect();
    const limit = window.innerHeight * 0.86;

    /* 只在「情书正在视口内、且文字底部越过了参考线」时才往下带一点。
       原来只看 rect.bottom —— 她往回滚时情书落到视口下方，
       rect.bottom 变得非常大，条件恒成立，结果每几秒就被强行拽回这一幕，
       前面的幕根本看不了。 */
    if (rect.top < limit && rect.bottom > limit) {
      // 每 30 字触发一次；开了「减少动效」时不该长距离平滑滚动
      body.scrollIntoView({ block: 'end', behavior: prefersCalmMotion() ? 'auto' : 'smooth' });
    }
  }

  /** 一键写完全部 */
  function finishAll() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    timer = null;

    cursor?.remove();
    cursor = null;
    openStrike = null;

    /* 按分段一次性铺完 —— 不能再用 body.textContent = letterText，
       那会把 ~~ 标记当正文打出来，删除号也丢了。 */
    body.textContent = '';
    for (const seg of segments) {
      if (seg.strike) {
        const s = document.createElement('s');
        s.textContent = seg.text;
        body.appendChild(s);
      } else {
        body.appendChild(document.createTextNode(seg.text));
      }
    }

    sign.classList.add('is-in');
    skipBtn.classList.remove('is-on');
    skipBtn.disabled = true;
    skipBtn.style.display = 'none';
  }

  /* 宽度变了（横竖屏、桌面缩放）或字体加载完（行高会变），
     信纸藏进信封的位置都要重算 —— 这两个都会改掉信纸的高度。 */
  const onResize = () => { if (!opened) measureRise(); };
  window.addEventListener('resize', onResize);
  document.fonts?.ready?.then(() => { if (!opened) measureRise(); }).catch(() => {});

  return {
    el,
    onEnter() {
      /* 信纸要先藏进信封里（量一次它该往下挪多少）。
         这一步必须在展开之前做，否则她一眼就看到信纸已经浮在信封上面了。 */
      if (!opened) requestAnimationFrame(measureRise);

      /* 没拆封就什么都不做 —— 写字必须等她点开。
         （拆开那一刻已经排过 start，这里的 / 分支只处理
         「拆开后离开又回来」：开始写，或者接着写。） */
      if (opened && !started) {
        setTimeout(start, 320);
      } else if (started && !done && !timer) {
        timer = setTimeout(step, 600);
      }
      setTimeout(() => hint.classList.add('is-in'), 3000);
    },
    /* 离开就暂停。原来定时器继续跑，scrollIfNeeded 还会在后台拽页面。 */
    onLeave() {
      clearTimeout(timer);
      timer = null;
    },
    destroy() {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    },
  };
}
