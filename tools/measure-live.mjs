// 用真实 Chrome（能执行 CDN 的 JS 挑战）实测 dearhuan.ct.ws 的真实下载速度。
// 用法：node tools/measure-live.mjs [url]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET = process.argv[2] || 'https://dearhuan.ct.ws/assets/cake.glb';
const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'speedtest-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-proxy-server',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', (d) => {
  const s = d.toString();
  if (/error|fail|cannot|denied/i.test(s)) process.stderr.write('[chrome] ' + s);
});

// 端口从 profile 目录的 DevToolsActivePort 文件读（stderr 常混其他日志，正则不可靠）
function getPort() {
  return new Promise((resolve, reject) => {
    const f = join(profile, 'DevToolsActivePort');
    const t0 = Date.now();
    const tick = () => {
      try {
        const txt = readFileSync(f, 'utf-8');
        const line = txt.split('\n')[0].trim();
        if (line) return resolve(Number(line));
      } catch {}
      if (Date.now() - t0 > 30000) return reject(new Error('timeout: no DevToolsActivePort'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

let ws, msgId = 0;
const pending = new Map();
const events = [];

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

try {
  const port = await getPort();
  const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
  ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/`);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Network.enable');
  await S('Page.enable');
  // 清缓存，确保测的是真实下载
  await S('Network.clearBrowserCache');
  await S('Network.setCacheDisabled', { cacheDisabled: true });

  console.log('navigating:', TARGET);
  const t0 = Date.now();
  await S('Page.navigate', { url: TARGET });

  // 等网络安静（挑战页 -> cookie -> 真实文件）
  let quiet = 0, elapsed = 0;
  const realReqs = new Map();
  while (elapsed < 90000) {
    await sleep(500);
    elapsed = Date.now() - t0;
    // 收集已完成请求
    for (const e of events) {
      if (e.method === 'Network.loadingFinished') {
        realReqs.set(e.params.requestId, e.params.encodedDataLength);
      }
    }
    const inflight = events.some((e) =>
      e.method === 'Network.requestWillBeSent' &&
      !realReqs.has(e.params.requestId));
    quiet = inflight ? 0 : quiet + 1;
    if (quiet >= 6) break;
  }
  const totalMs = Date.now() - t0;

  // 汇总
  const rows = [];
  for (const e of events) {
    if (e.method !== 'Network.responseReceived') continue;
    const u = e.params.response.url;
    if (!u.includes('cake.glb') && !u.endsWith('/')) continue;
    const len = realReqs.get(e.params.requestId) || 0;
    rows.push({ u: u.replace(TARGET.split('/assets')[0], ''), status: e.params.response.status, bytes: len });
  }
  console.log('\n=== 结果（无代理、无缓存，真实网络）===');
  for (const r of rows) {
    const mb = r.bytes / 1048576;
    const mbps = mb / (totalMs / 1000);
    console.log(`  ${r.status}  ${r.u}  ->  ${mb.toFixed(2)} MB  用时 ${(totalMs/1000).toFixed(2)}s  =>  ${mbps.toFixed(2)} MB/s (${(mbps*8).toFixed(0)} Mbps)`);
  }
  console.log(`\n  总耗时 ${(totalMs/1000).toFixed(2)}s`);
} catch (e) {
  console.error('ERR', e.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
