// 吹气判定逻辑的离线验证（与 code/js/scenes/cake.js 同一套参数与公式）。
// 用途：无头环境拿不到麦克风权限，没法端到端测；把真实量级的 RMS 序列
// 喂进判定逻辑，看「静默/说话/咳嗽会不会误触发」与「吹气几帧能灭」。
// 换阈值或改公式后重跑：node tools/sim-blow.mjs
// 期望：静默/说话/咳嗽一律「不灭」，吹气/轻吹在 20~30 帧之间灭。
const BLOW_FRAMES=18, NOISE_FRAMES=42, GATE_MIN=0.16, MIN_RUN=6;
function sim(samples){
  const sorted=samples.slice(0,NOISE_FRAMES).sort((a,b)=>a-b);
  const floor=sorted[sorted.length>>1];
  const gate=Math.min(0.45, Math.max(floor+0.12, GATE_MIN));
  let smooth=0,count=0,out=-1,run=0;
  for(let i=NOISE_FRAMES;i<samples.length;i++){
    const lvl=samples[i];
    smooth += (lvl-smooth)*(lvl>smooth?0.45:0.12);
    const rise=smooth-floor;
    const over = rise > (gate-floor)*0.55;
    if(over) run++; else run=0;
    const isBlow = over && run>=MIN_RUN;
    if(isBlow) count++; else if(count>0) count=Math.max(0,count-1.6);
    if(count>=BLOW_FRAMES && out<0) out=i-NOISE_FRAMES;
  }
  return {底噪:+floor.toFixed(4), 门槛:+gate.toFixed(3), 结果: out<0?'不灭 ✓':'第'+out+'帧灭'+(out<18?'（太快！）':' ✓')};
}
const A=(n,v)=>Array(n).fill(v);
// 真实语音：基频有起伏，音节间有低谷
const speech=(n,base,amp,period)=>Array.from({length:n},(_,i)=>base+amp*Math.sin(i/period));
const cases = {
  '安静房 静默(不该灭)': sim(A(150,0.012)),
  '安静房 说话(不该灭)': sim([...A(42,0.012), ...speech(70,0.10,0.04,3.5)]),
  '安静房 吹气(该灭)':   sim([...A(42,0.012), ...A(60,0.50)]),
  '安静房 轻吹(该灭)':   sim([...A(42,0.012), ...A(40,0.30)]),
  '有空调 静默(不该灭)': sim(A(150,0.045)),
  '有空调 说话(不该灭)': sim([...A(42,0.045), ...speech(70,0.11,0.045,3.2)]),
  '有空调 吹气(该灭)':   sim([...A(42,0.045), ...A(60,0.50)]),
  '嘈杂 静默(不该灭)':   sim(A(150,0.10)),
  '嘈杂 吹气(该灭)':     sim([...A(42,0.10), ...A(60,0.55)]),
  '咳嗽一下(不该灭)':    sim([...A(42,0.012),0.35,...A(8,0.012),...A(90,0.012)]),
  '说「啊——」拉长音(不该灭)': sim([...A(42,0.012), ...speech(80,0.13,0.05,6)]),
};
for (const [k,v] of Object.entries(cases)) console.log(k.padEnd(26), JSON.stringify(v));
