# 生日旅行记录网站 · 代码说明

零构建的纯静态站点 + 一组 PHP 接口。没有 npm、没有打包、没有构建步骤 —— 改完文件直接上传就生效。

---

## 目录结构

```
code/
├─ index.html              页面骨架
├─ .htaccess               SPA 回退、缓存、Gzip、MIME
├─ css/
│  ├─ themes.css           两套主题（日/夜）的颜色变量
│  ├─ base.css             重置、分屏容器、通用组件
│  └─ scenes.css           各幕样式
├─ js/
│  ├─ config.js            ★ 唯一需要你改的文件
│  ├─ main.js              编排
│  ├─ lib/                 工具层
│  │  ├─ dom.js            DOM 助手、计数动画、本地存储
│  │  ├─ mode.js           生日模式判断（用浏览器本地时间）
│  │  ├─ theme.js          两套配色的切换与持久化（切换器 UI 在设置面板里）
│  │  ├─ exif.js           读照片的拍摄时间与 GPS
│  │  ├─ image.js          前端压缩（主图 + 缩略图）
│  │  ├─ gcj02.js          火星坐标转换、距离计算
│  │  ├─ cluster.js        按 EXIF 把照片自动分成候选景区
│  │  ├─ store.js          数据层（接口调用 + 假数据）
│  │  ├─ music.js          背景音乐
│  │  ├─ scroll.js         入场动画、进度点
│  │  └─ fx.js             Canvas 特效：星空、彩带、烟花
│  ├─ scenes/              九幕，每幕一个文件
│  ├─ components/          时间线、地图、录入抽屉、设置面板、大图、提示条
│  └─ data/spots-cn.js     内置地点库（约 130 个景区与城市）
├─ assets/                 favicon、og 图、拼图照片、BGM 放这里
│  │                        （蛋糕模型 cake.glb 不随仓库发布，需要时自己放，见 config.js）
├─ api/                    PHP 接口
│  ├─ _boot.php            公共引导
│  ├─ config.php           ★ 口令哈希与高德 key 填这里
│  ├─ auth.php             口令登录
│  ├─ trips.php            读取 / 新增 / 删除
│  ├─ upload.php           照片上传
│  ├─ geocode.php          景区名 → 坐标（代理高德）
│  └─ probe.php            部署自检，用完删掉
├─ data/                   运行时生成，放 trips.json
└─ uploads/                运行时生成，放照片
```

---

## 本地预览

浏览器的模块加载不允许 `file://` 直接打开，需要一个本地服务器。任选一种：

```bash
# 方式一：Python（多数电脑自带）
cd code
python -m http.server 8000
# 打开 http://localhost:8000

# 方式二：VS Code 装 Live Server 插件，右键 index.html → Open with Live Server
```

本地打开时会自动使用内置假数据（三条示例旅行），看不到真实接口的数据 —— 这是刻意的，方便你先把界面调好看。

想在本机预览 `demo/` 里的四段示例旅程与照片（地名日期均为虚构）：

```bash
python tools/import-demo.py    # 在仓库根目录执行，只写本地 code/data 与 code/uploads
```

想在本机看到生日那一整套：网址后面加 `?bday=1`。

---

## 部署到 InfinityFree

### 1. 准备

- 登录 InfinityFree 控制面板（VistaPanel）
- **先启用 SSL**：在控制面板里找到 SSL 证书，申请 Let's Encrypt，等它签发完成
  （这一步必须最先做。证书没生效时麦克风用不了，而且强制 HTTPS 会死循环）
- 用 FTP 或文件管理器进入 `htdocs/`

### 2. 上传

1. 把 `code/` 里的所有内容打包成 zip
2. 通过文件管理器上传 zip 到 `htdocs/`，然后**在线解压**
3. 确认解压后 `htdocs/index.html` 直接可见，而不是 `htdocs/code/index.html`

> 逐个文件 FTP 上传也可以，只是慢很多。

### 3. 目录与权限

确认这两个目录存在且可写（没有就手动建）：

```
htdocs/data/       权限 755
htdocs/uploads/    权限 755
```

`.htaccess` 文件是隐藏文件，上传时要确认它们也在。两个关键文件：

- `htdocs/data/.htaccess` —— 阻止别人下载 `trips.json`
- `htdocs/uploads/.htaccess` —— 阻止上传目录执行脚本

### 4. 跑自检

用**手机浏览器**打开：

```
https://你的域名/api/probe.php
```

六项全绿再继续。有红的先按提示解决掉。

检查完把这个文件删掉。

### 5. 设置口令

1. 在服务器上临时建一个文件 `htdocs/sethash.php`，内容：

```php
<?php echo password_hash('你想用的口令', PASSWORD_DEFAULT);
```

2. 浏览器打开 `https://你的域名/sethash.php`，复制输出的那一长串
3. 粘贴到 `htdocs/api/config.php` 的 `'password_hash' => ''` 里
4. **删掉 `sethash.php`**

不设置的话，新增和删除都用不了（读取不受影响，她能正常看）。

### 6. 高德 key（可选）

不配置也能用，只是地点联想会退回内置的约 130 个地点。

配置方法：

1. 到 [高德开放平台](https://lbs.amap.com/) 注册，完成**个人实名认证**
2. 控制台 → 应用管理 → 创建应用 → 添加 Key → 服务平台选 **Web 服务**
3. 把 key 填到 `htdocs/api/config.php` 的 `'amap_key' => ''` 里

key 只存在服务端，不会出现在网页源码里。

配额（个人认证，每日）：输入提示 5000 次、地理编码 5000 次、关键字搜索 100 次。
查询结果会写缓存，同一个景区第二次不再消耗额度。

### 7. 最后一步：启用强制 HTTPS

打开 `htdocs/.htaccess`，把文件末尾那三行注释掉的规则取消注释：

```apache
<IfModule mod_rewrite.c>
  RewriteCond %{HTTPS} off
  RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
</IfModule>
```

**只有在 `https://` 已经能正常打开之后才做这一步**，否则整站会打不开。

---

## 改文案

所有文案都在 `js/config.js` 一个文件里。改完上传覆盖即可。

最常改的几处：

| 位置 | 说明 |
|---|---|
| `site.herName` | 她的名字 |
| `site.signature` | 你的署名 |
| `unlock.code` | 解锁答案，默认 `0521`。⚠️ 示例仓库里 `unlock.acceptAny: true`，放行任意输入；自己部署时改成 `false` 才真正校验答案 |
| `letter.text` | 情书正文 |
| `letter.speed` | **情书打字速度，单位「字 / 分钟」。默认 420（约 48 秒读完）。想快调大，想慢调小** |
| `letter.fontSize` | **情书正文字号，默认 18px** |
| `ui.fontScale` | **全局字号缩放。默认 1.1；还嫌小就 1.2，嫌大就 1.0** |
| `ui.maxWidth` | 内容列最大宽度，默认 640px |
| `scratch.content` | 刮刮卡里藏的承诺 |
| `cake.*` / `fireworks.blessings` | 蛋糕文案与祝福语 |
| `puzzle.image` | 拼图用的合照，放 `assets/` 里 |
| `music.src` | BGM，放 `assets/` 里 |

### 3D 星球

这一版已移除（`vendor/` 目录和 three.js 依赖一并清掉了）。当前地图视图是中国轮廓 + 光点，见 `设计蓝图.md` 第 14 节。

### 字号怎么调

只有一个旋钮：`ui.fontScale`，**现在默认是 1.1**。

| 设置 | 效果 |
|---|---|
| `1.0` | 原始大小 |
| `1.1` | **当前默认**，整体放大 10% |
| `1.2` | 再大 10%，手机上会比较明显 |

字号放大后内容列宽也一起放宽了（640px）。想再宽改 `ui.maxWidth`。

情书字号单独控制：`letter.fontSize`（默认 18px）。

### 情书速度怎么调

`letter.speed` 是「每分钟写多少字」：

| 设置 | 效果 |
|---|---|
| `300` | 偏慢，约 70 秒 |
| `420` | **默认**，约 48 秒 |
| `600` | 偏快，约 35 秒 |
| `900` | 很快，接近逐行出现 |

另外 `letter.pauseFactor` 控制标点处的停顿（默认 1.6）。设成 `1` 就是完全均匀的速度。

她不想等的话，打字过程中会有一个「直接看全文」的按钮，点一下立刻显示全部。不想给这个按钮就把 `letter.allowSkip` 设为 `false`。

**情书里有两处必须你自己填**：`[第一次一起旅行的地方]` 和 `[一件她做过的小事]`。
第二处是整封信的胜负手 —— 写具体的小事，不要写"你对我很好"。

---

## 预置旅行数据

### 方式一：在网页里录（推荐先试这个）

她看不到这个入口。你自己打开网站，划到旅行足迹那一段，点「补上一段」。

录入流程是**以照片为中心**的：

1. 一次勾选这次旅行拍的几十张照片
2. 系统读 EXIF，按 GPS 自动分成几个候选景区组，并自动填好日期
3. 你给每组起个名字（输入景区名会自动联想定位）
4. 保存

**一个景区定位一次、挂多张照片**，不是每张照片填一次位置。

注意用**相册原图**，微信转发过的照片会丢失位置信息。

### 方式二：批量导入（预置多年历史数据）

直接在电脑上编辑 `htdocs/data/trips.json`：

```json
{
  "version": 1,
  "trips": [
    {
      "id": "任意唯一字符串",
      "date": "2025-05-01",
      "city": "云栖镇",
      "country": "中国",
      "note": "在湖边坐到天黑",
      "tags": ["湖"],
      "spots": [
        { "id": "sp1", "name": "栖湖", "lat": 30.05, "lon": 119.72,
          "source": "builtin", "photos": [] }
      ],
      "photos": []
    }
  ]
}
```

坐标用 **WGS-84**（照片 EXIF 里的就是 WGS-84，可以直接用）。

照片则用 FTP 传到 `htdocs/uploads/`，然后在 `photos` 里引用相对路径：

```json
{ "id": "p1", "full": "uploads/abc123.webp", "thumb": "uploads/abc123_t.webp", "w": 1800, "h": 1200 }
```

路径写 `uploads/xxx.webp` 这种相对形式，不要写 `../uploads/`，接口会把后者拦掉。

改之前先把旧的 `trips.json` 下载一份留底，写错了能立刻换回来。

---

## 换主题

右下角「设置」入口 → 面板里的「配色」，两套配色随时切：

| 配色 | 场合 | 底色 | 主色 |
|---|---|---|---|
| 陶土纸 `clay` | 日间（默认） | 奶油纸 #FAF9F5 | 陶土红 #CC785C |
| 烛光墨 `clay-night` | 夜晚 | 暖墨 #181715 | 烛光橙 #E08D6B |

默认配色写在 `config.js` 的 `theme.default`。把 `theme.allowSwitch` 设为 `false`，
面板里就不再出现这一组。

**明暗只由配色决定，和动效无关**：跑不跑 Canvas 由设备能力决定，
见 `main.js` 的 `detectEffects()`（`data-effects` 的 full / lite / calm 三档）。
减少动效是系统设置与设备的事，不是配色的事。

---

## 生日模式

每年 **10-28 至 11-10** 自动切换到完整的生日叙事；其余时间直接进入旅行记录。

- 判断用的是**浏览器本地时间**，不是服务器时间（机房在英国，用服务器时间必然错位）
- **模板默认任何时候都是完整九幕**（`config.js` 的 `debug.forceBirthdayMode: true`）。
  想改成「只在生日那几天切换成九幕」：把它改成 false，
  再把 `birthday.month` / `day` / `windowFrom` / `windowTo` 换成 TA 的生日
- 窗口前后天数在 `config.js` 的 `birthday.windowFrom` / `windowTo` 里改
- 窗口之外，如果临近生日，顶部会出现一个「生日当天，有个东西给你」的手动入口
- 想随时预览：网址后面加 `?bday=1`

---

## 备份

服务器不提供任何自动备份。**每次录入完旅行，顺手把 `htdocs/data/` 整个下载一份**，几秒钟的事。

照片原图本来就在手机相册里，不用担心；只有 `trips.json` 里的文字信息需要这份备份兜底。

---

## 常见问题

**照片上传失败**
先看 `api/probe.php` 里 `uploads 目录可写` 那一项。共享主机最常见的就是目录权限问题，改成 755 或 775。

**她打开后照片显示不出来**
确认 `htdocs/uploads/` 里的文件真实存在，且 `uploads/.htaccess` 没有误拦图片。

**地图不显示**
地图轮廓从阿里 DataV 实时加载（`js/config.js` 里的 `footprints.map.geojsonUrl`）。加载失败时只是地图空白，时间线不受影响。

**音乐不响**
浏览器要求用户手势之后才能播放，所以必须点过解锁门上的按钮才会响。
另外微信内置浏览器对音频限制较多；右下角「设置」里可以开关音乐、调音量，她会自己选的值会被记住。

**吹蜡烛没反应**
麦克风需要 HTTPS 且要授权。安卓微信里麦克风通常不可用，此时会自动切换成"在屏幕上滑一下"，不需要她做任何选择。

**改了文案但看不到变化**
`index.html` 已经设为不缓存，但 `js` 和 `css` 有缓存。手机上下拉刷新，或者在网址后面加个 `?v=2`。
