/* 测试专用：伪造麦克风。**只在 tools/ 里，别放进 code/**（code/ 要整个传服务器）。
   由 tools/probe.mjs 的 cfg.fakemic 以 blob module 注入页面，

   为什么要伪造：真麦克风在无头浏览器里不可控，而这次要验的恰恰是
   「多大声、持续多久才判定为吹气」——必须能精确设定 RMS。

   用法：探针配置里写 "fakemic": true，接下来 expr 里直接
     window.__mic.amp = 0.5;   // 设定 RMS：0 静音 / 0.1 说话 / 0.5 吹气
*/
export function installFakeMic() {
  const state = { amp: 0, fft: 1024 };

  class FakeAnalyser {
    constructor() {
      this.fftSize = state.fft;
      this.smoothingTimeConstant = 0.6;
    }
    get fftSize() { return state.fft; }
    set fftSize(v) { state.fft = v; }
    /* ±amp 的方波，RMS 正好等于 amp（比正弦更好算）。 */
    getByteTimeDomainData(arr) {
      const a = Math.max(0, Math.min(1, state.amp)) * 128;
      for (let i = 0; i < arr.length; i++) {
        arr[i] = i % 2 ? 128 + a : 128 - a;
      }
    }
  }

  const FakeAC = function () {
    return {
      state: 'running',
      currentTime: 0,
      resume: () => Promise.resolve(),
      close: () => Promise.resolve(),
      createMediaStreamSource: () => ({ connect() {} }),
      createAnalyser: () => new FakeAnalyser(),
      createGain: () => ({ connect() {}, gain: { value: 0 } }),
      createMediaStreamDestination: () => ({ stream: {} }),
    };
  };

  window.AudioContext = FakeAC;
  window.webkitAudioContext = FakeAC;

  navigator.mediaDevices.getUserMedia = async () => ({
    getTracks: () => [{ stop() {} }],
  });

  window.__mic = state;
  return state;
}
