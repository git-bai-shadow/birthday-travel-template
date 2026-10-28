/* ==========================================================================
   music.js · 背景音乐
   要点：
     1. 浏览器要求用户手势之后才能播放，所以由解锁门的点击来触发
     2. 不要"啪"地响起 —— 首播音量压低，2 秒淡入
     3. 她可能在办公室或地铁上打开，音乐开关与音量都要能改，且记住选择
   音量与开关都在「设置」面板里（components/settings.js），
   这里只负责状态与播放，不建 DOM。
   ========================================================================== */

import { config } from '../config.js';
import { store } from './dom.js';

const MUTED_KEY = 'music-muted';
const VOLUME_KEY = 'music-volume';

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

let audio = null;
let fadeTimer = null;
let muted = store.get(MUTED_KEY, false);

/* 音频文件拿不到时（比如 assets/bgm.mp3 还没放上去）置为 false，
   设置面板据此把音乐那一行收起来 —— 免得留一个按了没反应的开关。 */
let available = true;
const availabilityWatchers = new Set();

export function isAvailable() {
  return available;
}

/** 订阅"音频不可用"。已经不可用的话会立刻回调一次。 */
export function onUnavailable(cb) {
  availabilityWatchers.add(cb);
  if (!available) cb();
}

/* 音量：她调过就用她的值，没调过用配置里的首播音量。
   注意 startVolume 的语义是「首次播放故意压低」，不该覆盖她的选择。 */
const savedVolume = store.get(VOLUME_KEY, null);
let volume = savedVolume === null ? clamp01(config.music.startVolume) : clamp01(savedVolume);

let started = false;

function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.src = config.music.src;
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = 0;

  audio.addEventListener('error', () => {
    if (!available) return;
    available = false;
    console.warn(`[music] ${config.music.src} 加载失败，已把音乐设置从面板里收起`);
    availabilityWatchers.forEach((cb) => cb());
  });

  return audio;
}

/** 由用户手势调用（解锁门点击时） */
export async function startMusic() {
  if (!config.music.enabled) return false;
  if (muted || started) return false;

  const el = ensureAudio();
  try {
    el.volume = 0;
    cancelPendingPause();
    /* ⚠️ started 必须在 await **之前**置位。原来它在 await 之后，
       两次并发调用（比如解锁门的 input.disabled 还没生效的窗口）会都
       通过 `if (started) return` 检查，造成双重播放。 */
    started = true;
    await el.play();
    fadeTo(volume, config.music.fadeInMs);
    return true;
  } catch {
    // 自动播放被拒，静默失败即可，不打扰她
    started = false;
    return false;
  }
}

function fadeTo(target, duration) {
  if (!audio) return;
  clearInterval(fadeTimer);

  const from = audio.volume;
  const steps = Math.max(12, Math.round(duration / 50));
  let i = 0;

  fadeTimer = setInterval(() => {
    i += 1;
    const t = i / steps;
    audio.volume = Math.max(0, Math.min(1, from + (target - from) * t));

    if (i >= steps) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }, 50);
}

/* ⚠️ 延迟 pause 必须存句柄。原来的 setTimeout 既不保存也不取消：
   切到别的标签页（排了一个 420ms 的 pause）→ 300ms 内切回来 → resumeMusic()
   播了 → **420ms 那个旧定时器照常执行 audio.pause()**。UI 显示「音乐开」、
   实际已静音，而且再也不会恢复。快速把静音开关拨回「开」同样会被旧定时器打掉。
   手机上进/出 App 切换太容易触发了。 */
let pendingPause = null;

function schedulePause(delay) {
  clearTimeout(pendingPause);
  pendingPause = setTimeout(() => {
    pendingPause = null;
    audio?.pause();
  }, delay);
}

function cancelPendingPause() {
  clearTimeout(pendingPause);
  pendingPause = null;
}

export function pauseMusic() {
  if (audio && !audio.paused) {
    fadeTo(0, 400);
    schedulePause(420);
  }
}

export function resumeMusic() {
  if (!audio || muted) return;
  cancelPendingPause();   // 抢在旧的 pause 定时器前面
  audio.play().then(() => fadeTo(volume, 800)).catch(() => {});
}

export function isMuted() {
  return muted;
}

export function setMuted(next) {
  muted = Boolean(next);
  if (config.music.rememberChoice) store.set(MUTED_KEY, muted);

  if (muted) {
    fadeTo(0, 360);
    schedulePause(380);
  } else {
    cancelPendingPause();   // 抢在旧的 pause 定时器前面，否则刚恢复就被打掉
    startMusic().then((ok) => {
      if (!ok) resumeMusic();
    });
  }
  return muted;
}

/** 当前音量（0-1） */
export function getVolume() {
  return volume;
}

/** 设定音量（0-1）。正在播就立即过渡过去，不打断听感。 */
export function setVolume(next) {
  volume = clamp01(next);
  if (config.music.rememberChoice) store.set(VOLUME_KEY, volume);
  if (audio && !audio.paused && !muted) fadeTo(volume, 180);
  return volume;
}

/* --------------------------------------------------------------------------
   后台暂停：切走时淡出收声，回来续上。
   挂在模块级而不是某个按钮上 —— 它是音乐自己的行为，与 UI 无关。
   -------------------------------------------------------------------------- */

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseMusic();
  else resumeMusic();
});
