# tools/

开发与验证脚本。**这些都不是站点运行时的依赖** —— `code/` 单独拿走就能跑，本目录只是做素材处理和回归验证用的。

## 验证探针

| 文件 | 用途 |
|---|---|
| `probe.mjs` | 无头浏览器探针：按 JSON 清单在页面里求值、读计算样式、截图。用法见文件头注释 |
| `fakemic.js` | 伪造麦克风（注入 `getUserMedia`），用来回归「吹灭蜡烛」的判定 |
| `sim-blow.mjs` | 吹气信号模拟：不接麦克风也能验判定曲线 |

探针清单（`checks-*.json`）**不在本仓库**：它们断言的是作者本机的内部状态，换个代码版本就是错结论，留着自己用更合适。想写自己的清单，照 `probe.mjs` 头部格式来即可。

```bash
# 起本地服务（根目录双击 启动预览.bat 也可以）
cd code && python -m http.server 8080 --bind 127.0.0.1
# 跑探针
node tools/probe.mjs my-checks.json
```

## 字体

| 文件 | 用途 |
|---|---|
| `font-subset.py` | 按项目里实际出现的字重新生成两个 woff2 子集（衬线 + 手写体）。**改完文案必须重跑**，否则新字会静默退化 |
| `font-check.py` | 检查子集覆盖：页面上用到的字有没有缺字形 |

```bash
pip install fonttools brotli -i https://pypi.org/simple
python tools/font-subset.py --serif --hand
```

## 素材 / 3D 模型

| 文件 | 用途 |
|---|---|
| `photo-prep.py` | 照片压缩到 webp（长边/质量可调），顺带生成列表页用的缩略图 |
| `photo-stamp.py` | 给照片压日期角标（早期玩法，保留备查） |
| `make-og.py` | 生成分享卡片 `og.png` |
| `import-demo.py` | 把 `demo/trips.sample.json` + `demo/photos/` 灌进站点数据 |
| `check-imports.py` | 检查导入后的数据引用是否完整（缺图、缺字段） |
| `convert-cake-glb.py` | 模型转制/清洗入口（单位、朝向、贴图烘焙） |
| `compact-glb.py` | 重排 GLB 的 BIN chunk，压体积 |
| `strip-cake-text.py` | 抹掉模型贴图上的文字（按行亮像素中值回填） |
| `flatten-cake-sign.py` | 压平模型牌子上刻的几何浮雕文字 |
| `cake-framing.py` / `cake-geometry.py` | 取景与几何关系的试验脚本 |

模型相关脚本默认读 `3d/out/` 下的中间产物，见 `3d/README.md`。
