# -*- coding: utf-8 -*-
"""复刻 CDN 的 JS 挑战，验证 ?i=1 + __test cookie 能否取到真 GLB。
分三步（本机 Node TLS 直连被沙箱拦，Python 直连可用）：
  1) 取挑战页 + aes.js
  2) 把密文和 aes.js 交给 Node 算 cookie
  3) 带 cookie 请求 ?i=1，验 magic 并测速
"""
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time

HOST = "dearhuan.ct.ws"
OUT = r"D:\0Claude\生日网站\3d\out"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def get(path, cookie=None, limit=None, timeout=120):
    s = socket.create_connection((HOST, 443), timeout=15)
    ss = ssl.create_default_context().wrap_socket(s, server_hostname=HOST)
    ss.settimeout(timeout)
    ck = ("Cookie: %s\r\n" % cookie) if cookie else ""
    req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: %s\r\n"
           "Accept: */*\r\nAccept-Language: zh-CN,zh;q=0.9\r\n%s"
           "Connection: close\r\n\r\n" % (path, HOST, UA, ck))
    t0 = time.time()
    ss.sendall(req.encode())
    data = b""
    while True:
        try:
            c = ss.recv(262144)
        except Exception:
            break
        if not c:
            break
        data += c
        if limit and len(data) >= limit + 4096:
            break
    el = time.time() - t0
    try:
        ss.close()
    except Exception:
        pass
    i = data.find(b"\r\n\r\n")
    head = data[:i].decode("utf-8", "replace") if i >= 0 else ""
    body = data[i + 4:] if i >= 0 else b""
    return head, body, el


def main():
    os.makedirs(OUT, exist_ok=True)

    # 1) 挑战页 + aes.js
    head, body, _ = get("/assets/cake.glb")
    html = body.decode("utf-8", "replace")
    hexes = re.findall(r'toNumbers\("([0-9a-f]+)"\)', html)
    print("challenge args:", len(hexes))
    if len(hexes) < 3:
        print("no challenge. status:", head.split("\r\n")[0] if head else "?")
        print(head[:400])
        return
    _, js_body, _ = get("/aes.js")
    js = js_body.decode("utf-8", "replace")
    with open(os.path.join(OUT, "aes.js"), "w", encoding="utf-8") as f:
        f.write(js)
    print("aes.js bytes:", len(js))

    # 2) 交给 Node 算 cookie
    payload = {"hexes": hexes, "js": js}
    pj = os.path.join(OUT, "_chal.json")
    with open(pj, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    node_src = r"""
const fs=require('fs');
const vm=require('vm');
const {hexes,js}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const ctx={document:{cookie:''},console};
vm.createContext(ctx);
vm.runInContext(js+'\n;globalThis.__d=slowAES.decrypt;',ctx);
const a=Buffer.from(hexes[0],'hex'),b=Buffer.from(hexes[1],'hex'),c=Buffer.from(hexes[2],'hex');
try{
  const p=Buffer.from(ctx.__d(Array.from(c),2,Array.from(a),Array.from(b)));
  console.log(JSON.stringify({ok:true,hex:p.toString('hex'),utf8:p.toString('utf-8')}));
}catch(e){console.log(JSON.stringify({ok:false,err:e.message}));}
"""
    nj = os.path.join(OUT, "_chal.js")
    with open(nj, "w", encoding="utf-8") as f:
        f.write(node_src)
    r = subprocess.run(["node", nj, pj], capture_output=True, text=True, timeout=60)
    line = (r.stdout or "").strip().splitlines()[-1] if r.stdout.strip() else ""
    if not line:
        print("node failed:", r.stdout[-500:], r.stderr[-500:])
        return
    res = json.loads(line)
    if not res.get("ok"):
        print("decrypt failed:", res.get("err"))
        return
    cookie = "__test=" + res["hex"]
    print("cookie:", cookie[:60] + "...")
    print("decrypted utf8:", repr(res.get("utf8", ""))[:80])

    # 3) 带 cookie 验证
    for path in ["/assets/cake.glb?i=1", "/assets/cake.glb"]:
        head, body, el = get(path, cookie=cookie, limit=8 * 1024 * 1024)
        status = head.split("\r\n")[0] if head else "?"
        ct = (re.search(r"Content-Type: ([^\r\n]+)", head, re.I) or [None, "-"])[1]
        cl = (re.search(r"Content-Length: (\d+)", head, re.I) or [None, "-"])[1]
        magic = body[:4].hex() if len(body) >= 4 else "-"
        is_glb = magic == "674c5446"
        print("\n%s\n  %s  CT=%s  CL=%s" % (path, status, ct, cl))
        print("  got %.2f MB in %.2fs  magic=%s  %s" % (
            len(body) / 1048576.0, el, magic, "=> 真 GLB" if is_glb else "=> 不是 GLB"))
        if is_glb:
            print("  速度 = %.2f MB/s (%.0f Mbps)" % (
                len(body) / 1048576.0 / max(el, .001),
                len(body) * 8 / max(el, .001) / 1e6))
            with open(os.path.join(OUT, "live_cake.glb"), "wb") as f:
                f.write(body)
            print("  saved -> 3d/out/live_cake.glb")


if __name__ == "__main__":
    main()
