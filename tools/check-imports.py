# -*- coding: utf-8 -*-
"""静态校验 ES 模块的导入/导出是否对得上。

为什么需要它：`node --check` 只验证语法，**不验证导入的名字是否存在** ——
`import { clearOverflow } from './lib/dom.js'` 在目标文件没有这个导出时
语法完全合法，只有浏览器运行到那一刻才抛
`does not provide an export named ...`，而模块图是静态的：**整个页面直接白屏**。
2026-09-21 就这么炸过一次（改动只落在 main.js，dom.js 的导出没跟上/被缓存）。

用法：
    python tools/check-imports.py

只做静态文本匹配，够用即可（本项目全部是 `export function/const/let` 与
`export { a, b }`，没有 `export *` 与动态重导出）。
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "code", "js")

# import { a, b as c } from './x.js'
RE_NAMED = re.compile(r"import\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]")
# import * as ns from './x.js'  /  import x from './x.js'
RE_STAR = re.compile(r"import\s+\*\s+as\s+\w+\s*from\s*['\"]([^'\"]+)['\"]")
RE_DEFAULT = re.compile(r"import\s+(\w+)\s+from\s*['\"]([^'\"]+)['\"]")
# export function foo / export const foo / export let foo / export async function foo
RE_EXPORT_DECL = re.compile(r"export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)")
# export { a, b as c }
RE_EXPORT_LIST = re.compile(r"export\s*\{([^}]*)\}")


def collect_exports(path):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    names = set(RE_EXPORT_DECL.findall(src))
    for group in RE_EXPORT_LIST.findall(src):
        for part in group.split(","):
            part = part.strip()
            if not part:
                continue
            # `a as b` → 对外名字是 b
            name = part.split(" as ")[-1].strip()
            if name:
                names.add(name)
    if "export default" in src:
        names.add("default")
    return names


def main():
    files = []
    for dirpath, _dirnames, filenames in os.walk(JS):
        for fn in filenames:
            if fn.endswith(".js"):
                files.append(os.path.join(dirpath, fn))

    problems = []
    checked = 0

    for path in files:
        with open(path, encoding="utf-8") as f:
            src = f.read()
        rel = os.path.relpath(path, ROOT)

        for spec, names_blob, kind in (
            [(m[1], m[0], "named") for m in RE_NAMED.findall(src)]
            + [(m, "", "star") for m in RE_STAR.findall(src)]
            + [(m, "", "default") for m in RE_DEFAULT.findall(src)]
        ):
            if not spec.startswith("."):
                continue  # 裸模块名不检查
            target = os.path.normpath(os.path.join(os.path.dirname(path), spec))
            if not os.path.exists(target):
                problems.append(f"{rel}: 找不到模块 {spec}")
                continue
            checked += 1
            if kind != "named":
                continue
            exported = collect_exports(target)
            for raw in names_blob.split(","):
                raw = raw.strip()
                if not raw:
                    continue
                # `x as y` → 源文件里必须有 x
                srcname = raw.split(" as ")[0].strip()
                if srcname not in exported:
                    problems.append(
                        f"{rel}: 从 {spec} 导入了 `{srcname}`，但那里没有这个导出"
                    )

    print(f"检查了 {len(files)} 个文件、{checked} 条相对导入")
    if problems:
        print("发现问题：")
        for p in problems:
            print("  -", p)
        return 1
    print("导入/导出全部对得上")
    return 0


if __name__ == "__main__":
    sys.exit(main())
