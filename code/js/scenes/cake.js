/* ==========================================================================
   幕 6 · 蛋糕与蜡烛（全站高潮）

   画面主体是一块实时渲染的 3D 蛋糕（js/lib/cake3d.js，零依赖手写 WebGL2）。
   平面蛋糕（CSS）保留在 DOM 里，同时承担三件事：
     1. WebGL2 不可用时的降级
     2. 渲染上下文丢失时的降级（安卓切后台回来偶发）
     3. data-effects="calm" 时只静态渲染一帧的占位

   两个必须处理的浏览器限制：
     1. AudioContext 必须在用户手势之后才能启动
        → 所以这里先有一个「准备好了」按钮，不能直接监听
     2. 微信内置浏览器对 getUserMedia 有限制，授权体验也不一致
        → 检测到微信直接走滑动版；麦克风失败也自动降级
   降级路径要和主路径一样好看，不能让她觉得用了残次版本。
   ========================================================================== */

import { config } from '../config.js';
import { h, isWeChat } from '../lib/dom.js';
import { createConfetti } from '../lib/fx.js';
import { createCake3d } from '../lib/cake3d.js';
import { makeScrollHint } from '../lib/scroll.js';

export function createCake() {
  const cfg = config.cake;

  const flame = h('div', { class: 'flame' });
  const candle = h('div', { class: 'candle' }, flame);
  const cake = h('div', { class: 'cake' }, candle,
    h('div', { class: 'cake__body' }), h('div', { class: 'cake__plate' }));

  // 3D 画布。渲染器建不起来就一直是空的，由 CSS 版顶上
  const stage3d = h('canvas', {
    class: 'cake3d', 'aria-hidden': 'true',
  });

  const eyebrow = h('p', { class: 'cake-eyebrow', text: cfg.eyebrow });
  const prompt = h('p', { class: 'lead', text: cfg.hint });

  const readyBtn = h('button', {
    class: 'btn btn--accent', type: 'button', text: cfg.ready, onClick: begin,
  });

  const micFill = h('div', { class: 'mic-bar__fill' });
  const micBar = h('div', { class: 'mic-bar', style: { display: 'none' } }, micFill);

  const doneBox = h('div', { class: 'stack stack--center stack--gap-8 cake-done', style: { display: 'none' } },
    h('p', { class: 'display display--md', text: cfg.done }),
    h('p', { class: 'lead', text: cfg.doneSub }));

  const hint = makeScrollHint();

  const stage = h('div', { class: 'cake-stage' }, eyebrow, stage3d, cake, prompt, readyBtn, micBar);

  const el = h('section', { class: 'scene', id: 'scene-cake' },
    h('div', { class: 'scene__inner stack stack--center' },
      h('div', { class: 'reveal' }, stage),
      h('div', { class: 'reveal' }, doneBox)),
    hint);

  /* ---------------- 3D 主体 ---------------- */

  const effects = () => document.documentElement.dataset.effects || 'full';
  let cake3d = null;
  let no3d = false;      // 上下文丢失过就不再重试：同一个 canvas 丢失后拿不回新上下文

  /* 能建起来就返回渲染器，建不起来返回 null —— 平面蛋糕还在 DOM 里顶着 */
  function mount3d() {
    if (no3d) return null;
    if (cake3d) return cake3d;
    try {
      cake3d = createCake3d(stage3d, {
        quality: effects() === 'lite' ? 'lite' : 'full',
        model: cfg.model || null,
        modelScale: cfg.modelScale || 1,
        candles: cfg.candles || null,
      });
    } catch (err) {
      console.warn('[cake] 3D 初始化失败，改用平面蛋糕', err);
      cake3d = null;
    }
    if (!cake3d) { no3d = true; return null; }

    stage.classList.add('has-3d');
    // 上下文丢失（安卓切后台回来常见）→ 立刻退回平面蛋糕，不留白屏
    cake3d.onContextLost(() => {
      stage.classList.remove('has-3d');
      cake3d = null;
      no3d = true;
    });
    return cake3d;
  }

  let mode = null;          // 'mic' | 'swipe'
  let audioCtx = null;
  let stream = null;
  let analyser = null;
  let dataArr = null;
  let raf = null;
  let done = false;
  /* 判定用**秒**不用帧（v1.7.9）。
     原来写死 18 帧：60fps 下是 0.3 秒，但她的手机掉到 30fps 时就变成 0.6 秒；
     更糟的是原来「一帧掉下门槛就把连击清零」，而真机上吹气的波形
     （再加上麦克风的自动增益）本来就一帧高一阵低 —— 连击永远攒不满。
     现在改成泄漏式累积：超门槛按时间加，掉下去按更快的速度漏，不清零。 */
  const HOLD_NEED = 0.35;    // 累计「超门槛」0.35 秒才算真的在吹
  const HOLD_LEAK = 1.8;     // 掉出门槛时每秒漏掉多少（>1 才有「占空比」判据）
  const HOLD_CAP = 1.2;      // 上限，免得一口气吹两秒后残留太多
  let hold = 0;
  let lastT = 0;
  /* 兜底：麦克风开着但她就是吹不灭（设备太差、离得太远、环境太吵）。
     8 秒后不再硬等，把「滑一下」这条路一起打开，提示也换掉。 */
  let swipeFallback = 0;

  /* ---------------- 开始 ---------------- */

  /* 她离开了这一幕。
     必须有这个标记：授权弹窗可能挂好几秒，期间她往下滚，
     onLeave 的 stopMic() 先跑（那时 stream 还是 null，什么都没关到），
     随后 getUserMedia 才 resolve —— 麦克风就被真正打开并常驻。 */
  let disposed = false;

  /* 双击保护：`mode` 要等startMic 里才赋值，而移动端双击几乎必然产生 ——
     第二次 tap 落在 await 窗口内时 mode 还是 null，于是并发发起第二次
     getUserMedia。后返回的覆盖 stream/ctx，**先返回的那条既没 stop 也没
     引用**：麦克风指示灯常亮到页面关闭，站点再也关不掉它。 */
  let starting = false;

  async function begin() {
    if (mode || done || starting) return;
    starting = true;
    readyBtn.disabled = true;
    readyBtn.textContent = '…';

    if (isWeChat()) {
      // 微信里麦克风大概率不可用，直接用滑动版，不让她等
      starting = false;
      startSwipe();
      return;
    }

    const ok = await startMic();

    // await 期间已经离开：把刚拿到的流立刻关掉，并且不再接管这一幕
    if (disposed) {
      starting = false;
      stopMic();
      return;
    }
    starting = false;
    if (!ok) startSwipe();
  }

  async function startMic() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('不支持麦克风');

      /* ⚠️ 必须关掉浏览器的三件「优化」，否则吹气根本判不出来（v1.7.9）：
         autoGainControl 会把吹气那股爆发压回和说话差不多的电平，
         noiseSuppression 直接把持续的气流噪声当噪声抹掉 ——
         两个叠起来等于「她真吹了，但麦克风把证据处理掉了」。
         手机上尤其明显（桌面 Chrome 基本不做这些处理），
         这也是「本地怎么吹都行、她手机上吹不灭」的主因。
         老浏览器不认这些字段会忽略，但仍加一层兜底重试。 */
      const rawAudio = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia(rawAudio);
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      /* ⚠️ 拿到流之后**立刻**检查 disposed。之前是等到 begin() 里 await 完
         再检查，而 begin() 的 onLeave 复位在mode 还是 null、按钮还没被藏的
         时刻就跑完了 —— 于是 startMic 随后把 mode 设成 'mic'、把按钮
         display:none，stopMic() 又不还原这些 UI。回来时 begin() 第一行就
         return、按钮不可见、无滑动监听 = 永远吹不灭且无任何提示。 */
      if (disposed) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        return false;
      }

      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('不支持音频分析');

      /* ⚠️ resume() **不能 await**。这个调用发生在 `await getUserMedia` 之后，
         用户手势上下文早就过期了 —— iOS Safari 上无手势的 resume() 返回的
         promise 永不 settle，await 挂死 → startMic 不返回 → begin() 也不返回
         → readyBtn 永久 disabled + 文案停在「…」，整幕无响应。
         create + resume 都挪到 begin() 的同步段（仍在手势内），这里只补一次
         不等待的 resume 兜底。 */
      audioCtx = new AC();
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});

      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);

      /* 用**时域**数据（±128 的振幅）而不是频域字节。
         频域的 getByteFrequencyData 是把 dB 映射到 0..255，而 AnalyserNode 默认
         量程只有 70dB（-100..-30）—— 现实里安静房间 38dB、说话 62dB、
         吹气 78dB 全部 clamp 到 255，**完全分不开**（原来按频域平均值判定，
         阈值 0.16，于是没吹就灭）。
         时域是线性振幅、不 clamp，实测安静 0.012 / 说话 0.10 / 吹气 0.50，
         动态范围差 40 倍，判定才立得住。 */
      /* ⚠️ 必须是 Uint8Array：getByteTimeDomainData 在 WebIDL 里是
         强类型签名（Uint8Array），传 Float32Array 会**抛 TypeError**
         而不是静默降级。而 loop() 的 rAF 排在调用之前，异常不终止循环
         → 每帧抛一次、noiseFloor 永远 null、mode 卡在 'mic' 让
         startSwipe() 兜底也不触发 = 蜡烛永远吹不灭（v1.7.5 修）。 */
      dataArr = new Uint8Array(analyser.fftSize);

      mode = 'mic';
      /* 先给一句「安静一下」：开麦后要花 0.7 秒测环境底噪，
           这段时间进度条是空的、没有反应。不说的话她会以为页面卡住了，
           然后下意识说话/出声 —— 反而把底噪测高。 */
      prompt.textContent = cfg.calibrating || '先安静一下，我在听…';
      readyBtn.style.display = 'none';
      micBar.style.display = '';
      loop();
      return true;
    } catch {
      stopMic();
      return false;
    }
  }

  /* 滑动版监听器要能被摘下来：原来只在「滑够次数」时移除，
     她没吹灭就滚去别的场景的话，监听器就一直挂在 window 上 ——
     之后随便动动鼠标都算吹气，人不在这一幕蜡烛也会被吹灭。 */
  let swipeMove = null;
  /* 滑动也按**距离**累计，不是按事件数。
     原来每来一次 pointermove 就 +1，要求 6 次 —— 一次正常滑动轻松产生
     几十个 move 事件，**手一碰就灭了**；而且转动蛋糕用的也是 pointermove，
     横向拖一下也会被判成吹气。 */
  let swipeDist = 0;
  let swipeLast = null;
  /* ⚠️ swipeLast 必须在下一次**按下**时复位。否则她滑到一半（已累计 200px）
     抬手，走到别处再按下移动一下：dx 是两个相距很远的点之差，一次就超过
     SWIPE_NEED=320，立刻吹灭。滑动版本来就是给不太会对着麦克风吹的人用的，
     这种误触等于功能失效。 */
  let swipeReset = null;
  const SWIPE_NEED = 320;      // 需要累计滑动多少 px（往复约 320px ≈ 一次用力吹）

  function stopSwipe() {
    if (swipeMove) {
      window.removeEventListener('pointermove', swipeMove);
      window.removeEventListener('touchmove', swipeMove);
      swipeMove = null;
    }
    if (swipeReset) {
      window.removeEventListener('pointerdown', swipeReset);
      window.removeEventListener('touchstart', swipeReset);
      swipeReset = null;
    }
    swipeLast = null;
    swipeDist = 0;
  }

  function startSwipe() {
    mode = 'swipe';
    prompt.textContent = cfg.blowBySwipe;
    readyBtn.style.display = 'none';
    micBar.style.display = 'none';
    // 麦克风这条路已经放弃了，流必须关掉（否则指示灯一直亮）
    stopMic();
    attachSwipe();
  }

  /* 只挂监听、不接管 mode。
     兜底路径用：麦克风已经在跑，但 8 秒还没吹灭 —— 这时**两条路一起开着**，
     她用手指滑也能灭，不必先失败一次再换方式。 */
  function attachSwipe() {
    if (swipeMove) return;      // 已经挂着，别重复绑（会双倍累计）
    swipeDist = 0;
    swipeLast = null;

    swipeReset = () => { swipeLast = null; swipeDist = 0; };
    window.addEventListener('pointerdown', swipeReset, { passive: true });
    window.addEventListener('touchstart', swipeReset, { passive: true });

    swipeMove = (ev) => {
      const p = ev.touches ? ev.touches[0] : ev;
      if (swipeLast) {
        const dx = p.clientX - swipeLast[0];
        const dy = p.clientY - swipeLast[1];
        // 只认**横向**的来回（吹气的手势是横着摆的），
        // 纵向的是页面滚动、横向的可能是转蛋糕，都不算吹气。
        if (Math.abs(dx) > Math.abs(dy) * 1.2) swipeDist += Math.abs(dx);
      }
      swipeLast = [p.clientX, p.clientY];
      // 用比例驱动火苗被压弯的程度
      cake3d?.setBreath(Math.min(1, swipeDist / SWIPE_NEED));
      if (swipeDist >= SWIPE_NEED) {
        stopSwipe();
        extinguish();
      }
    };
    window.addEventListener('pointermove', swipeMove, { passive: true });
    window.addEventListener('touchmove', swipeMove, { passive: true });
  }

  /* ---------------- 兜底：吹不灭就滑 ----------------
     差设备 / 离得远 / 环境太吵时，麦克风那条路可能永远走不到。
     等 8 秒仍没吹灭，就把滑动**一起**打开（不关麦克风），提示语改成两条路都给。
     这比「怎么吹都没反应」好得多 —— 后者她只会以为页面坏了。 */
  function startFallback() {
    if (swipeFallback) return;
    swipeFallback = setTimeout(() => {
      swipeFallback = 0;
      if (done || mode !== 'mic') return;
      prompt.textContent = cfg.blowBySwipeFallback || '吹不灭？用手指在屏幕上滑一下也行。';
      attachSwipe();
    }, 8000);
  }

  /* ---------------- 麦克风音量 ----------------
   ⚠️ 这段踩过一个很坑的 bug：**没吹也会灭**。根因不只是阈值填错，
   而是**信号源选错了**：

   原来用 `getByteFrequencyData`（频域）—— 它把 dB 映射到 0..255 字节，
   而 AnalyserNode 默认量程只有 70dB（minDecibels -100 / maxDecibels -30）。
   现实里安静房间约 38dB、正常说话 62dB、用力吹气 78dB，**全部 clamp 到 255**
   → 算出来的 level 恒在 0.85~1.0，而阈值 0.16 → 每一帧都判为吹气，
   7 帧后必灭。说话也过不了阈值，怎么调都不对。

   现在改用 `getByteTimeDomainData`（时域，±128 振幅，线性不 clamp）算 RMS。
   实测安静 0.012 / 说话 0.10 / 吹气 0.50 —— 差 40 倍，判得开。再叠三层：
     ① 开麦先测 0.7 秒底噪取中位数（不同麦克风差 20dB 以上，不能写死）
     ② 判定用「超出底噪的增量」而不是绝对值，稳态环境声不会累积
     ③ **泄漏式累积**（按时间加、掉下去只漏 55%），不再要求连续帧
     ④ 关掉浏览器的 AGC / 降噪 —— 它会把她吹气的那股爆发直接压平（见 startMic）

   v1.7.9 修的是「根本吹不灭」：门槛原来是 `底噪 * 1.8 + 0.06`，
   底噪一旦偏高（手机 AGC 把环境声抬到 0.2~0.3），门槛就爬到 0.4 以上，
   而吹气被 AGC 压过之后到不了 —— 阈值永远够不着。倍数改成**加法余量**。 */
const NOISE_FRAMES = 42;      // 测底噪的帧数（约 0.7 秒）
const noiseBuf = [];          // 底噪采样
let noiseFloor = null;        // 底噪基准（RMS 0..1），测完才有
let smoothLevel = 0;          // 平滑后的当前 RMS
let blowGate = 0;             // 实际生效的门槛（绝对值）

function loop(now) {
  if (mode !== 'mic' || done) return;
  raf = requestAnimationFrame(loop);
  if (!analyser) return;

  /* 帧间隔自己算：她手机掉到 30fps 时，0.4 秒的要求不该变成 0.8 秒。
     上限 50ms —— 切后台再回来 now 会跳一大截，不能一口气把 hold 加满。 */
  const t = typeof now === 'number' ? now : performance.now();
  const dt = lastT ? Math.min(0.05, Math.max(0.001, (t - lastT) / 1000)) : 0.016;
  lastT = t;

  /* 时域 RMS：全幅 128 为满刻度。吹气是低频持续的能量，
     RMS 比峰值稳、比平均值更能反映「有多大劲」。 */
  analyser.getByteTimeDomainData(dataArr);
  let acc = 0;
  for (let i = 0; i < dataArr.length; i++) {
    const v = (dataArr[i] - 128) / 128;
    acc += v * v;
  }
  const raw = Math.sqrt(acc / dataArr.length);

  // 还在测底噪：先安静一会儿
  if (noiseFloor === null) {
    noiseBuf.push(raw);
    if (noiseBuf.length < NOISE_FRAMES) {
      micFill.style.setProperty('--level', '0');
      return;
    }
    // 取中位数：偶发的关门声、键盘声不会把基准拉高
    noiseBuf.sort((a, b) => a - b);
    noiseFloor = noiseBuf[noiseBuf.length >> 1];
    /* 门槛 = 底噪 + **加法余量**（v1.7.9）：
         余量 0.045 起，底噪越高给得越多（0.10 封顶），再与 cfg.micGate 取大
         （麦克风特别钝时保底）。环境越吵余量越大，但永远留出可达空间。
       ⚠️ 别改回 `noiseFloor * 1.8 + 0.06` —— 乘法在底噪 0.3 时要电平 0.6，
       而手机吹气被 AGC 压过之后到不了 0.6，实况就是「怎么吹都不灭」。 */
    const margin = Math.max(0.045, Math.min(0.10, noiseFloor * 0.45));
    blowGate = Math.max(noiseFloor + margin, cfg.micGate);
    prompt.textContent = cfg.blowByMic;
    startFallback();
  }

    // 指数平滑：吹气是持续的低频，用它看趋势；直接用瞬时值会一帧一个跳
    smoothLevel += (raw - smoothLevel) * (raw > smoothLevel ? 0.5 : 0.10);

    /* 判定用「超出底噪的增量」而不是绝对值 —— 稳态环境声（空调、风扇）
       不会累积成吹气。
       ⚠️ 系数 0.85 是**实测调出来的**（v1.7.9）：写 0.45 时，
       0.10 的说话（离门噪 0.012 的安静房间）也能越过门槛，
       再靠占空比去分辨就晚了 —— 5 秒内必灭。 */
    const span = Math.max(0.05, blowGate - noiseFloor);
    const rise = smoothLevel - noiseFloor;
    const over = rise >= span * 0.85;

    /* 累积：超门槛按 1.0 倍速加，掉下去按 1.8 倍速漏。
       涨慢漏快是故意的 —— 这样「占空比」成为真正的判据：
         吹气（连续）       ≈ 100% → 每秒 +1.0 → 0.35 秒就够
         说话（音节断续）   ≈ 50~60% → 每秒 -0.1~-0.4 → 永远攒不起来
       为什么不用「连续 N 帧」：真机上吹气的 RMS 本来就是一帧高一阵低，
       单帧回落就把连击清零 → 永远攒不满（这正是 v1.7.8「吹不灭」的实况）。
       也不能让「涨」比「漏」快：那是 v1.7.9 第一版的写法，实测说话
       在 12 秒内照样把蜡烛吹灭了。 */
    if (over) hold = Math.min(HOLD_CAP, hold + dt);
    else hold = Math.max(0, hold - dt * HOLD_LEAK);

    const pct = Math.min(100, Math.round((rise / span) * 100));
    micFill.style.setProperty('--level', String(Math.min(1, pct / 100)));

    // 吹气强度同时驱动 3D 的火苗高度、烛光强度与火苗被压弯的幅度
    cake3d?.setBreath(Math.min(1, Math.max(0, rise / span)));

    /* 火焰随累计进度减弱，给她「我真的吹到了」的实感。
       3D 在跑时这一步由渲染器自己做，不必再写一遍 DOM 样式
       （也避免每帧触发样式重算）。 */
    if (!cake3d) {
      const weaken = Math.max(0.15, 1 - hold / HOLD_NEED);
      flame.style.transform = `translateX(-50%) scale(${0.7 + weaken * 0.4})`;
      flame.style.opacity = String(0.45 + weaken * 0.55);
    }

    if (hold >= HOLD_NEED) extinguish();
  }

  /* ---------------- 吹灭 ---------------- */

  function extinguish() {
    if (done) return;
    done = true;

    flame.classList.add('is-out');
    cake3d?.blowOut();
    stopMic();

    /* 不再从屏幕中间撒彩带（反馈：那种飘落体验很差）。
       庆祝感交给画面本身：画布收矮把版面让给结尾那句，
       蛋糕身后亮起一圈烛光余晕，文字从下方缓缓升起。 */
    setTimeout(() => {
      stage.classList.add('is-done');
      doneBox.style.display = 'flex';
    }, 460);
  }

  function stopMic() {
    cancelAnimationFrame(raf);
    raf = null;
    if (swipeFallback) {
      clearTimeout(swipeFallback);
      swipeFallback = 0;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    analyser = null;
  }

  return {
    el,
    onEnter() {
      disposed = false;
      setTimeout(() => hint.classList.add('is-in'), 2400);

      /* 3D 在这里才建：这一幕是整屏的，等它进视野再上传几何，
         首屏就少一次几万个点的构建。
         构建本身要几十毫秒，推到下一帧做，不卡住正在滚动的这一帧。 */
      requestAnimationFrame(() => {
        if (disposed) return;
        const c = mount3d();
        if (!c) return;
        // 已经吹过了就别重新点上蜡烛
        if (!done) c.relight();
        if (effects() === 'calm') c.renderOnce();
        else c.start();
      });
    },
    onLeave() {
      disposed = true;
      stopMic();
      stopSwipe();

      /* 只停麦克风还不够 —— mode 必须复位。
         否则重进这一幕时 readyBtn 已经隐藏、mode 还是 'mic'，
         却没有音频分析也没有滑动监听：蜡烛吹不灭也滑不灭，卡死在这里。
         ⚠️ 必须连**UI 一起**复位。startMic 是在 await 之后才设mode='mic'
         并隐藏按钮的，而上面的 stopMic 只关流、不碰 DOM —— 授权弹窗期间
         离开就会留下「mode='mic' + 按钮不可见」的死亡组合。 */
      if (!done) {
        mode = null;
        starting = false;
        readyBtn.disabled = false;
        readyBtn.textContent = cfg.ready;
        readyBtn.style.display = '';
        micBar.style.display = 'none';
        micFill.style.setProperty('--level', '0');
        /* 底噪标定状态也必须复位：它是闭包里的持久变量，第二次进这一幕时
           noiseFloor !== null 会**跳过 0.7 秒标定**，直接沿用上一次会话的
           blowGate —— 中间换过环境（安静房间↔街上、插拔耳机）阈值就明显偏了。
           smoothLevel 还会带着上次的电平，进度条第一帧就跳到莫名其妙的值。 */
        noiseBuf.length = 0;
        noiseFloor = null;
        smoothLevel = 0;
        blowGate = 0;
        hold = 0;
        lastT = 0;
      }

      // 离开这一幕就停掉 3D 循环（画面保留最后一帧，滚回来直接续上）
      cake3d?.stop();
    },
    destroy() {
      disposed = true;
      stopMic();
      stopSwipe();
      cake3d?.destroy();
      cake3d = null;
    },
  };
}
