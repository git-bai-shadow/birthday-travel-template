/* ==========================================================================
   probe.mjs · 无头浏览器计算样式探针

   为什么需要它：
   "改了 CSS 变量"这件事在 dump-dom 里往往没有任何痕迹 —— DOM 结构没变，
   class 没变，只有计算后的样式变了。要验证视觉改动是否真的生效，
   必须能读到 getComputedStyle 的结果。所以这里直接用 CDP 在页面里求值。

   用法：
     node tools/probe.mjs <config.json>

   config.json 格式：
     {
       "url":     "http://127.0.0.1:8799/?bday=1",
       "out":     "_probe.txt",              // 可选，默认与 config 同名 .out.txt
       "theme":   "clay",                    // 可选，加载后设置 data-theme
       "effects": "lite",                    // 可选，加载后设置 data-effects
       "waitFor": "!!window.__appBooted",    // 可选，轮询直到表达式为真
       "timeout": 20000,
       "fakemic": true,                      // 可选，注入 tools/fakemic.js（伪造麦克风）
       "checks":  [ { "name": "说明", "expr": "JS 表达式" } ]
     }

   每次都用全新的 user-data-dir，避免命中缓存的旧 JS。
   ========================================================================== */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const PORT = 0;   // 0 = 交给 Chrome 自己挑空闲端口，见下方 DevToolsActivePort
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log() {
  /* 只写文件，不回显 —— PowerShell 看不到 stdout */
}

/* --------------------------------------------------------------------------
   CDP 客户端
   -------------------------------------------------------------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        const fn = this.handlers.get(msg.method);
        this.handlers.delete(msg.method);
        fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeout);
      this.handlers.set(method, (p) => { clearTimeout(t); resolve(p); });
    });
  }
}

/* --------------------------------------------------------------------------
   主流程
   -------------------------------------------------------------------------- */

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('用法：node tools/probe.mjs <config.json>');
    process.exit(2);
  }

  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  /* 输出默认落在**配置文件旁边**（tools/checks-x.json → tools/checks-x.out.txt）。
     原来不管哪个配置都写 tools/probe.out.txt，于是所有配置互相覆盖；
     而各个 config 里又用 "out" 指到项目根目录的 _xxx.txt ——
     跑几十次之后根目录堆了 40 多个临时文件（2026-10-25 清理过一次）。
     tools/*.out.txt 已在 .gitignore 里。 */
  const outPath = cfg.out
    ? resolve(cfg.out)
    : join(dirname(resolve(configPath)),
        basename(resolve(configPath), '.json') + '.out.txt');

  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) {
    writeFileSync(outPath, '找不到 Chrome，无法验证。\n', 'utf8');
    process.exit(3);
  }

  const profile = mkdtempSync(join(tmpdir(), 'probe-'));
  const lines = [];
  const results = {};
  let child = null;

  try {
    child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: 'ignore' });

    // 等调试端口就绪。
    // 端口不能写死：本机上 9333 被代理工具（verge-mihomo）占着，
    // Chrome 绑定失败却不报错，探针只会看到 fetch 打到一个不认识的套接字，
    // 表现成「调试端口未就绪」，很难查。交给 Chrome 自己挑，
    // 它会把实际端口写进 profile 下的 DevToolsActivePort。
    const portFile = join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let i = 0; i < 120; i++) {
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, 'utf8').split('\n')[0].trim();
        const n = Number(first);
        if (Number.isInteger(n) && n > 0) { port = n; break; }
      }
      await sleep(250);
    }
    if (!port) throw new Error('Chrome 调试端口未就绪（DevToolsActivePort 未生成）');

    let target = null;
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    if (!target) throw new Error('Chrome 调试端口未就绪');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });

    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 手机视口。安卓中端机普遍是 390×844 逻辑分辨率，DPR 取 2 做保守估计。
    if (cfg.viewport) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: cfg.viewport.w,
        height: cfg.viewport.h,
        deviceScaleFactor: cfg.viewport.dpr || 2,
        mobile: true,
      });
    }

    // 收集控制台报错，这是发现 JS 崩溃的主要手段
    const consoleErrors = [];
    cdp.handlers.set('Runtime.exceptionThrown', (p) => {
      consoleErrors.push(p?.exceptionDetails?.exception?.description
        || p?.exceptionDetails?.text || '未知异常');
    });
    cdp.handlers.set('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push((p.args || []).map((a) => a.value ?? a.description).join(' '));
      }
    });

    const loaded = cdp.once('Page.loadEventFired');

    // 在页面任何脚本之前注入。用于预置 localStorage 之类的场景
    // —— 比如验证"首帧主题"必须在导航之前把主题写进存储。
    if (cfg.preScript) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: cfg.preScript });
    }

    await cdp.send('Page.navigate', { url: cfg.url });
    await loaded;

    // 可选：强制主题 / 效果档
    const force = [];
    if (cfg.theme) force.push(`document.documentElement.dataset.theme=${JSON.stringify(cfg.theme)}`);
    if (cfg.effects) force.push(`document.documentElement.dataset.effects=${JSON.stringify(cfg.effects)}`);

    if (force.length) {
      await cdp.send('Runtime.evaluate', { expression: force.join(';') });
      await sleep(400);
    }

    // 等应用启动完成
    if (cfg.waitFor) {
      const deadline = Date.now() + (cfg.timeout || 20000);
      let ok = false;
      while (Date.now() < deadline) {
        const r = await cdp.send('Runtime.evaluate', {
          expression: cfg.waitFor, returnByValue: true, awaitPromise: true,
        });
        if (r.result && r.result.value) { ok = true; break; }
        await sleep(300);
      }
      if (!ok) lines.push(`[警告] waitFor 超时：${cfg.waitFor}`);
    }

    /* 伪造麦克风（cfg.fakemic）。
       为什么要从 tools/ 注入而不是放在 code/ 里：code/ 是要整个传上服务器的，
       测试用的假 AudioContext 不该跟着上线。这里读源码、以 blob module 注入，
       页面里就拿到 window.__mic（.amp 直接设定 RMS）。 */
    if (cfg.fakemic) {
      const fakePath = join(TOOLS_DIR, 'fakemic.js');
      const src = readFileSync(fakePath, 'utf8');
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(async()=>{const u=URL.createObjectURL(new Blob([${JSON.stringify(src)}],{type:'text/javascript'}));const m=await import(u);m.installFakeMic();URL.revokeObjectURL(u);return 'ok';})()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        lines.push('[警告] 伪造麦克风失败：' + (r.exceptionDetails.exception?.description || ''));
      }
    }

    // 跑检查项
    for (const check of cfg.checks || []) {
      let value;
      let err = null;
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: check.expr,
          returnByValue: true,
          awaitPromise: true,
        });
        if (r.exceptionDetails) {
          err = r.exceptionDetails.exception?.description
            || r.exceptionDetails.text || '求值异常';
        } else {
          value = r.result.value;
        }
      } catch (e) {
        err = e.message;
      }

      results[check.name] = err ? { error: err } : value;
      lines.push(`${check.name} = ${err ? 'ERROR: ' + err : JSON.stringify(value)}`);
    }

    // 截屏：给人眼确认用。每一项可以先跑一段 JS（滚到某幕、切主题）再拍。
    if (cfg.shots && cfg.shots.length) {
      const shotDir = cfg.shotDir
        ? resolve(cfg.shotDir)
        : join(dirname(resolve(configPath)), 'shots');
      mkdirSync(shotDir, { recursive: true });

      for (const shot of cfg.shots) {
        if (shot.js) {
          /* shots[].js 与 checks[].expr 共用页面全局作用域：
             重复声明同名 const 会抛 SyntaxError。必须把异常报出来，
             否则表现为「截图没变化」，很难查。所以一律用 IIFE 包起来写。 */
          const r = await cdp.send('Runtime.evaluate', {
            expression: shot.js, awaitPromise: true,
          });
          if (r.exceptionDetails) {
            lines.push(`[截图前脚本报错] ${shot.name}: `
              + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
          }
        }
        await sleep(shot.wait || 900);
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const p = join(shotDir, shot.name + '.png');
        writeFileSync(p, Buffer.from(r.data, 'base64'));
        lines.push(`截图 ${shot.name} -> ${p}`);
      }
    }

    if (consoleErrors.length) {
      lines.push('');
      lines.push('--- 页面控制台报错 ---');
      for (const e of consoleErrors.slice(0, 20)) {
        lines.push(String(e).split('\n')[0]);
      }
    } else {
      lines.push('');
      lines.push('页面控制台无报错');
    }

    ws.close();
  } catch (e) {
    lines.push('探针失败：' + e.message);
  } finally {    try { child?.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  writeFileSync(
    outPath.replace(/\.txt$/, '') + '.json',
    JSON.stringify(results, null, 2),
    'utf8',
  );
}

main();
