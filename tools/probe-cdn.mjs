// 复刻 CDN 的 JS 挑战：slowAES.decrypt(c, 2, a, b) → __test cookie，
// 再带 cookie 请求 /assets/cake.glb?i=1，验证能否拿到真 GLB。
// 用法：node tools/probe-cdn.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const HOST = 'dearhuan.ct.ws';
const PORT = 443;

function httpsGet(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${HOST}`,
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept: */*',
      'Accept-Language: zh-CN,zh;q=0.9',
      cookie ? `Cookie: ${cookie}` : '',
      'Connection: close',
      '', '',
    ].filter(Boolean).join('\r\n');

    const sock = tls.connect({ host: HOST, port: PORT, servername: HOST }, () => {
      sock.write(req);
    });
    const chunks = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => resolve(Buffer.concat(chunks)));
    sock.on('error', reject);
    sock.setTimeout(60000, () => { sock.destroy(); reject(new Error('timeout')); });
  });
}

function split(resp) {
  const i = resp.indexOf('\r\n\r\n');
  if (i < 0) return { head: resp.toString(), body: Buffer.alloc(0) };
  return { head: resp.slice(0, i).toString(), body: resp.slice(i + 4) };
}

// ---- 1. 拿挑战页，解出 a/b/c
const r1 = await httpsGet('/assets/cake.glb', null);
const p1 = split(r1);
const html = p1.body.toString('utf-8');
const m = html.match(/toNumbers\("([0-9a-f]+)"\)/g) || [];
const hexes = m.map((s) => s.match(/"([0-9a-f]+)"/)[1]);
console.log('challenge args:', hexes.length);
if (hexes.length < 3) { console.log('no challenge; head=', p1.head.split('\r\n')[0]); process.exit(1); }
const a = Buffer.from(hexes[0], 'hex');
const b = Buffer.from(hexes[1], 'hex');
const c = Buffer.from(hexes[2], 'hex');
console.log('a=', a.toString('hex'), '\nb=', b.toString('hex'), '\nc=', c.toString('hex'));

// ---- 2. 加载 slowAES 并在沙箱里执行，拿到 cookie 值
const js = readFileSync('3d/out/aes.js', 'utf-8');
const vm = await import('node:vm');
const ctx = { document: { cookie: '' }, window: {}, console };
vm.createContext(ctx);
vm.runInContext(js + '\n;globalThis.__dec = slowAES.decrypt;', ctx);
const dec = ctx.__dec;
console.log('slowAES loaded, decrypt type:', typeof dec);

// slowAES.decrypt(c: number[], mode, a, b)
let plain;
try {
  plain = Buffer.from(dec(Array.from(c), 2, Array.from(a), Array.from(b)));
  console.log('decrypted:', JSON.stringify(plain.toString('utf-8')));
} catch (e) {
  console.log('decrypt failed:', e.message);
  process.exit(2);
}
const cookie = '__test=' + plain.toString('hex');
console.log('cookie:', cookie);

// ---- 3. 带 cookie 请求 ?i=1
for (const path of ['/assets/cake.glb?i=1', '/assets/cake.glb']) {
  const t0 = Date.now();
  const r = await httpsGet(path, cookie);
  const el = (Date.now() - t0) / 1000;
  const p = split(r);
  const status = p.head.split('\r\n')[0];
  const cl = (p.head.match(/Content-Length: (\d+)/i) || [])[1];
  const ct = (p.head.match(/Content-Type: ([^\r\n]+)/i) || [])[1];
  const magic = p.body.length >= 4 ? p.body.readUInt32LE(0).toString(16) : '-';
  console.log(`\n${path}\n  ${status}  CT=${ct}  CL=${cl}  got=${(p.body.length/1048576).toFixed(2)}MB  ${el.toFixed(2)}s`);
  console.log(`  magic=${magic} ${magic === '674c5446' ? '=> 真 GLB ✓' : '=> 不是 GLB'}`);
  if (magic === '674c5446') {
    const mb = p.body.length / 1048576;
    console.log(`  速度 ≈ ${mb.toFixed(1)}MB / ${el.toFixed(1)}s = ${(mb/el).toFixed(2)} MB/s (${(mb*8/el).toFixed(0)} Mbps)`);
    writeFileSync('3d/out/live_cake.glb', p.body);
    console.log('  saved -> 3d/out/live_cake.glb');
  }
}
process.exit(0);
