# dsh-bg-beautify

> 给 DeepSeek Harness Web UI 加背景图 / 视频壁纸 / Wallpaper Engine 壁纸库 / 半透明面板的美化插件，带分区标签菜单实时调节。
> A background & Wallpaper Engine beautifier for the DeepSeek Harness Web UI, with a tabbed live settings page.

以官方插件机制安装，**不修改任何 DSH 源码**（`apps/web`、`packages/client` 一概不动），也**不需要重新构建前端**。

## 特性

- 🖼️ **背景图**：支持 `/bg/文件名`（插件内置伺服）、`https://` 外链、`data:` URI、本地上传
- 🎞️ **视频壁纸**：背景支持 `.mp4` / `.webm` 视频，静音循环自动播放；**播放速度可调（0.25×～2×）**；标签页隐藏或系统"减少动态效果"时自动暂停（定格预览图）省电
- 🖥️ **Wallpaper Engine 壁纸库**：一键**纯本地扫描**（无任何 API）本机 Steam 库中的 WE 壁纸——注册表定位 Steam → `libraryfolders.vdf` 展开全部库 → `steamapps\workshop\content\431960\` 解析每张壁纸的 `project.json`；缩略图网格点选即用
- 🌐 **网页型壁纸**：web 型（HTML）以**沙箱 iframe** 运行（自动注入 WE 专有 API 垫片；脚本可跑动画，但无同源权限、不抢点击）
- 🎞️ **内置转换器**（纯 Node、零依赖、**无需任何外部工具**）：解析 PKG/TEX（含 LZ4/DXT 解码、GIF89a/LZW 编码）——把**视频纹理**提取为 mp4、把**动画序列纹理**转成动画 GIF，存入专用文件夹；**转换带实时进度条**（作业轮询）；**一键打开文件夹**管理/删除；点选即设为背景
- 🎚️ **四个透明度滑块**：主区 / 侧边栏 / 卡片浮层 / 输入区（0 全透 ～ 1 不透），即时生效
- 💫 **输入框呼吸光晕**：输入框外圈**均匀弥散软光匀速呼吸** + 背后**超大模糊旋转色晕**（双色 abab 环绕柔和流转，无灯带/线条）；颜色 / 速度 / 交叉色 / 强度(0~1.5) 可调；尊重系统"减少动态效果"
- 🎭 **心情光晕模式**：呼吸光晕变 AI 状态情绪灯——思考中=柔蓝慢呼吸、完成=金色一闪、出错=暖红缓闪、空闲=微微星光（DOM 状态信号自动检测）
- 📂 **分区标签菜单**：设置页内部分「背景图 / WE 壁纸 / 转换视频 / 光晕 / 品牌定制」五个标签，顶部常驻**当前背景**状态行（背景来源互斥一目了然）
- 📐 尺寸 / 位置 / 背景固定选项；亮色、暗色主题各一套
- 💾 **持久化**：设置写入插件自己的 `config.json`，重启不丢；不依赖宿主设置服务的白名单
- 🔒 仅监听回环地址（127.0.0.1）；上传文件名白名单 + 路径穿越防护；WE 文件只读伺服原始目录（本地个人使用，不复制不分发）

## 效果预览

![示例图 1](docs/screenshots/demo-1.png)

![示例图 2](docs/screenshots/demo-2.png)

## 工作原理（30 秒）

1. 本插件是一个 DSH **组合包（bundle）**：`package.json` 声明 `dsh.bundle`（贡献一行组合配置）+ `dsh.client`（声明浏览器端 bundle）。
2. 安装进 profile 后，loader 挂载 `bg-beautify` 行；`dsh-client-modules` 把 `/plugins/dsh-bg-beautify/client.js` 编入 `window.__DSH_BOOT__` 引导图，浏览器端运行时加载——**无需构建前端**。
3. 浏览器端 `apply()`：注入 `<style>` 设背景图 + 用官方主题接口 `ctx.theme.overrideTokens(...)` 覆盖面板底色（亮/暗两套）；视频壁纸用 `<video>` 层、网页壁纸用沙箱 `<iframe>` 层。
4. 设置持久化与 WE 库/转换由插件自己的 host 半边完成（`/bg/settings`、`/bg/we/*`、`/bg/conv/*` → 插件目录 `config.json` 与用户图片目录）。

## 环境要求

- DeepSeek Harness（源码运行：Node ≥ 22 + pnpm，或已安装的 `dsh` CLI）
- 浏览器：现代 Chromium / Firefox / WebKit
- Wallpaper Engine 功能需本机已安装 Steam + Wallpaper Engine（并订阅下载了壁纸）

## 安装

```powershell
# 从 GitHub 安装（已安装 CLI）
dsh plugin --profile web add github:halosb/dsh-bg-beautify

# 从 GitHub 安装（源码运行环境）
pnpm dsh plugin --profile web add github:halosb/dsh-bg-beautify

# 或本地目录（两种环境都可以）
dsh plugin --profile web add ./dsh-bg-beautify
pnpm dsh plugin --profile web add ./dsh-bg-beautify
```

安装后**必须重启** `dsh web`（客户端模块的包扫描与引导图在启动时组装）：

```powershell
dsh web            # 默认端口 3080；可用 --port 换端口
pnpm dsh web       # 源码运行环境
```

> 本插件是纯 JS、无构建步骤，git 安装不需要 `prepare`/`allowBuilds`。

## 使用

打开 Web UI → 左下角 **设置** → **背景美化**。分区顶部显示**当前背景**状态，并分为 5 个标签菜单（背景来源互斥，切换即更换背景）：

| 标签 | 内容 |
|---|---|
| **背景图** | 图片 URL / 本地上传 / 图片尺寸位置 / 背景固定 / 视频播放速度 / 四个透明度 / 文字颜色 / 背景纱幕 |
| **WE 壁纸** | 扫描按钮 / 壁纸库路径（自动探测失败时手动填）/ 壁纸缩略图网格 |
| **转换视频** | 打开文件夹 / 刷新 / 实时进度条 / 已转换 mp4·GIF 列表 |
| **光晕** | 呼吸光晕全部设置 |
| **品牌定制** | favicon / 欢迎语 / 标签页标题后缀 |

「恢复默认」按钮常驻分区底部。

### Wallpaper Engine 支持矩阵

| 壁纸类型 | 表现 | 方式 |
|---|---|---|
| video（mp4/webm） | ✅ 动态 | 原生 `<video>` 背景（静音循环、可调速） |
| image | ✅ 静态 | 原生背景图 |
| web（HTML/JS） | ✅ 动态 | 沙箱 `<iframe>`（注入 WE API 垫片，无同源权限） |
| scene（含视频纹理 / 动画序列） | ✅ 动态 | 「转换」按钮 → 内置转换器提取 mp4 / 动画 GIF |
| scene（纯 3D / 粒子） | ⚠️ 静态 | 点击先用预览图，后台尝试其公开预览视频（需联网），失败保留预览图 |
| videostream | ⚠️ 静态 | 同纯 3D 处理 |

> 纯 3D/粒子场景的动画由 WE 私有引擎实时渲染，其场景数据（网格/shader/粒子参数）无公开格式，浏览器与任何第三方工具（含 repkg）都无法直接转成视频——这是格式物理限制，非本插件缺失。

## 默认值

| 字段 | 默认 | 说明 |
|---|---|---|
| `image` | `''` | 默认无背景图（`''` = 只做半透明，可在设置里选图） |
| `size` / `position` / `fixed` | cover / center / false | 图片显示方式 |
| `opacityMain` | 0.25 | 主区 / 聊天区（0 全透 ～ 1 不透） |
| `opacitySidebar` | 0.5 | 侧边栏 |
| `opacityCard` | 0.7 | 卡片 / 浮层 |
| `opacityInput` | 0.75 | 输入区 |
| `textColor` | white | 文字颜色（white / black / auto） |
| `scrim` | true | 背景纱幕（半透明遮罩增强对比） |
| `brandIcon` / `welcomeText` / `titleSuffix` | '' / '' / '' | 品牌定制：favicon、欢迎语、标题后缀 |
| `glowEnabled` | true | 输入框呼吸光晕开关 |
| `glowColor` | `#e8a8d0` | 光晕主色 |
| `glowSpeed` | 2 | 光晕速度：一个呼吸周期秒数（0.3～10） |
| `glowCross` | true | 使用交叉色 |
| `glowCrossColor` | `#9ec5ff` | 交叉色 |
| `glowStrength` | 0.45 | 光晕强度（0～1.5） |
| `glowMood` | false | 心情光晕：AI 状态情绪灯 |
| `wePath` | `''` | WE 壁纸库路径（`''` = 自动探测） |
| `wePreview` | `''` | 当前 WE 壁纸预览图 URL（视频壁纸用作 poster） |
| `weKind` | `''` | 当前 WE 壁纸类型（video / image / web / ''，识别渲染方式） |
| `videoSpeed` | 1 | 视频壁纸播放速度（0.25～2，1 = 原速） |

## 卸载

```powershell
dsh plugin --profile web remove dsh-bg-beautify
# 重启后恢复默认外观；插件目录里的 config.json 一并删除即彻底还原
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面无背景图 | ① 安装后必须重启 `dsh web`；② 浏览器硬刷新 Ctrl+F5 |
| `/bg/xxx.jpg` 404 | 文件名大小写不一致 / 没放进 `assets/` / 格式不支持（jpg/png/gif/webp/avif/svg） |
| WE 扫描不到壁纸 | ① 本机需已安装 Steam + Wallpaper Engine 且壁纸已订阅下载；② 自动探测失败时在"壁纸库路径"手动填 `…\steamapps\workshop\content\431960` 后重新扫描；③ 纯 3D/粒子场景无可用纹理，转换不出动画属正常 |
| 视频壁纸不播放 | 确认文件为 `.mp4`/`.webm`；浏览器自动播放策略要求静音（插件已强制静音）；标签页在后台或系统开启"减少动态效果"时会暂停并定格预览图（属预期省电行为） |
| 网页型壁纸显示不全 | 网页壁纸依赖 WE 专有 JS API（已自动注入 no-op 垫片防崩溃）；个别壁纸用 `fetch()` 读取相对资源会因沙箱无同源权限失败，属预期限制 |
| 转换提示"无纹理" | 无需安装任何外部工具：内置转换器已覆盖视频纹理→mp4、动画序列→GIF；只有纯 3D/粒子场景转不出（格式物理限制） |
| 转换文件夹在哪 | `图片\dsh-bg-beautify\we-converted`，设置页「打开文件夹」一键直达 |
| 背景图发糊 | 大图取消"背景固定"（Chrome 对 fixed 大背景会低分辨率光栅化）；透明度调低让图透出来；视频壁纸始终固定 |

## 仓库结构

```
dsh-bg-beautify/
├── package.json          # dsh.bundle + dsh.client 声明
├── cordis.patch.yml      # 组合层：插入 bg-beautify 行
├── client.js             # 浏览器 bundle（标签菜单设置页 + 视频/iframe 背景层）
├── index.js              # host 半边：/bg、/bg/upload、/bg/settings、/bg/we/*、/bg/conv/* 路由
├── we-convert.js         # 内置转换器：PKG/TEX 解析 + LZ4/DXT 解码 + mp4 提取 + GIF 编码（仿 repkg）
├── assets/               # 背景图（/bg/<文件名> 伺服）
├── config.json           # 运行时生成：设置持久化（已 gitignore）
├── tests/                # 单元/路由测试（we-convert、we-routes）
├── README.md
├── 安装教程-INSTALL.zh.md
└── LICENSE
```

## 开发

- 改 `client.js` 顶部 `DEFAULTS` 可换默认值；改完重启 `dsh web` 生效。
- 客户端 bundle 内容变化需要重启（或 `pnpm run dev:web` 的 HMR watcher 正在运行）。
- 测试：`node tests/we-convert.test.mjs`（LZ4/DXT/GIF/提取）、`node tests/we-routes.test.mjs`（路由端到端，含路径穿越防护）。
- ⚠️ 源码均为 UTF-8（无 BOM）文本，**请勿用 PowerShell `Get-Content`/`Set-Content` 读写**（会按 GBK 重编码导致中文注释乱码）；一律使用 UTF-8 感知的编辑器/工具。
- 提交前请勿包含个人图片/配置（`config.json` 已在 `.gitignore`）。

## 反馈

有问题或建议，欢迎通过邮箱联系作者：

- 📮 **反馈邮箱**：i@halosb.com
- 作者：芝麻 (halosb)

## 许可证

[MIT](./LICENSE)
