# -*- coding: utf-8 -*-
"""压缩 GLB：把 BIN chunk 里没被引用的字节（通常是抹图后留下的 0）去掉。

背景：往 GLB 里换贴图时常见做法是「旧数据置零 + 追加新数据」，
文件会平白胖几 MB。��个脚本按 bufferView 重排 BIN chunk，体积立刻回来。

用法：
    python tools/compact-glb.py <输入.glb> <输出.glb>
"""

import json
import struct
import sys

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read_glb(path):
    data = open(path, 'rb').read()
    magic, ver, total = struct.unpack_from('<III', data, 0)
    if magic != GLB_MAGIC:
        raise SystemExit('不是 GLB：' + path)
    off, js, bin_ = 12, None, None
    while off < total:
        clen, ctype = struct.unpack_from('<II', data, off)
        payload = data[off + 8:off + 8 + clen]
        if ctype == CHUNK_JSON:
            js = json.loads(payload.decode('utf-8'))
        elif ctype == CHUNK_BIN:
            bin_ = payload
        off += 8 + clen
    return js, bin_


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    js, bin_ = read_glb(src)

    new = bytearray()
    for bv in js.get('bufferViews', []):
        off = bv.get('byteOffset', 0)
        ln = bv['byteLength']
        bv['byteOffset'] = len(new)
        new.extend(bin_[off:off + ln])
        pad = (4 - len(new) % 4) % 4
        new.extend(b'\x00' * pad)

    js['buffers'][0]['byteLength'] = len(new)
    jb = json.dumps(js, separators=(',', ':')).encode('utf-8')
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    b = bytes(new) + b'\x00' * ((4 - len(new) % 4) % 4)
    out = bytearray(struct.pack('<III', GLB_MAGIC, 2, 12 + 8 + len(jb) + 8 + len(b)))
    out += struct.pack('<II', len(jb), CHUNK_JSON) + jb
    out += struct.pack('<II', len(b), CHUNK_BIN) + b
    open(dst, 'wb').write(out)
    print('%s %.1f MB → %s %.1f MB' % (
        src, len(bin_) / 1048576.0, dst, len(out) / 1048576.0))


if __name__ == '__main__':
    main()
