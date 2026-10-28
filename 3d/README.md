# 草莓奶油生日蛋糕 · 3D 模型

用 `buddy-multimodal-generation` 技能，以 `code/assets/ChatGPT Image 2026年10月4日 22_01_34.png`
（3D Generator 出的蛋糕图）为参考生成的 3D 模型。

## 交付物

| 文件 | 大小 | 说明 |
|---|---|---|
| **`out/cake.glb`** | 55.6 MB | **主交付物**，glTF 2.0 二进制，可直接拖进 Blender / three.js / model-viewer |
| `out/cake_obj.zip` | 44.3 MB | OBJ + 4 张 PBR 贴图（baseColor / normal / roughness / metallic） |
| `out/preview.png` | 124 KB | 云端返回的预览图 |
| `out/model_viewer.html` | 3 KB | 网页预览页，把 GLB 拖进去即可 360° 看 |
| `../code/assets/cake-ai.glb` | 55.6 MB | 同一份文件的副本，放在站点资产目录备用 |

## 模型规格

```
格式        glTF 2.0（GLB）
生成器      Khronos glTF Blender I/O v4.0.43
三角面      500,000
顶点数      294,288
顶点属性    POSITION / NORMAL / TEXCOORD_0
材质        1 个，PBR：baseColor + normal + metallicRoughness
贴图        3 张，baseColor 4096×4096
包围盒      x 1.025 · y 1.025 · z 0.628
            （z 是高度轴 —— 这批模型是「躺着」导出的，导入后需绕 X 转 -90° 立起来）
extensions  KHR_materials_specular
```

## 符合要求的部分

- 单层圆柱形蛋糕，纯白奶油表面，有刮刀纹理与柔软边缘
- 底部外围整齐环绕一圈大颗红草莓（有草莓籽与高光）
- 顶部 5 个草莓雪人（红草莓身 + 白奶油脸 + 黑巧克力眼睛笑嘴 + 粉腮红），
  大小相近且有高低层次，牢固坐在蛋糕顶面
- 正面中央白色巧克力牌（**文字已抹除**，用 `tools/strip-cake-text.py` 处理，公开仓库不带名字）
- 正面中央奶油上有黑色笑脸（两只圆眼 + 弧形笑嘴 + 粉色腮红）
- 背面与侧面无重复的笑脸与文字
- 材质是高精度写实食物风格，贴图 4096²

## ⚠️ 一处没做到：生日蜡烛

**模型里没有蜡烛。** 顶部中央与外围的高度完全一致（实测最高点 z 都是 0），
不存在细长圆柱体。

原因：技能的接口限制 —— **提示词与参考图不能同时传**
（报错 `Prompt和ImageBase64、ImageUrl不能同时存在`）。
参考图本身没有蜡烛，所以只能走「纯图生 3D」，模型完全跟随参考图，
我无法用文字追加一根蜡烛。

### 如果一定要加蜡烛，有两条路

1. **先补一张带蜡烛的参考图**（保持同一张图的其他要素不变，
   顶部中央加一根未点燃的白色/草莓红螺旋蜡烛），再走一次图生 3D。
   这是最稳的 —— 图生 3D 对参考图的还原度远高于纯文字。
2. **在 Blender 里手工加**：新建圆柱体（半径约 0.02、高约 0.18），
   放在顶面中央，用白色 + 草莓红螺旋条纹材质。顶部再加一小段白色圆柱当蜡芯。
   不用火焰、不用烟雾。

如果要第 1 条，把图给我，我再跑一次。

## 用到的脚本

| 脚本 | 作用 |
|---|---|
| `gen.py` | 调用技能生成。**必须 import 不能 subprocess** —— 参考图 base64 有 2.6MB，Windows 命令行上限 32K，直接拼参数会报 `Argument list too long` / `WinError 206` |
| `inspect-glb.py` | 纯 Python 读 GLB：面数、顶点属性、材质、包围盒。不需要任何三方库 |
| `render-views.py` | 自制光栅器出五视角正交图。**有缺陷，仅供内部排查**，不要作为验收依据 |

### 踩过的坑

1. **接口不允许图文并存** —— 想「按参考图生成 + 文字追加要求」做不到，只能二选一。
2. **Windows 命令行 32K 上限** —— 参考图 base64 传不进命令行，必须同进程 import。
3. **这批模型 z 是高度轴** —— 从包围盒看 x/y 跨度 1.025、z 只有 0.628，
   说明是躺着导出的。渲染或导入时先绕 X 轴转 -90°。
4. **依赖**：managed python 缺 `requests`，先
   `python -m pip install -i https://pypi.org/simple requests`。

## 复现命令

```bash
PY="C:/Users/31417/.workbuddy/binaries/python/versions/3.13.12/python.exe"

# 生成（token 需临时获取）
"$PY" 3d/gen.py --token ck_t_xxx --face-count 500000

# 检查产物
"$PY" 3d/inspect-glb.py 3d/out/cake.glb

# 本地预览
cd 3d/out && python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/model_viewer.html
```
