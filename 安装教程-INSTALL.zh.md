# dsh-bg-beautify 安装与使用教程

给 DeepSeek Harness Web UI 加**背景图 + 面板半透明**，全程**不改任何源码**（`apps/web`、`packages/client` 一概不动），也**不需要重新构建前端**。

> 适用环境：**源码运行**（从 `deepseek-harness` 源码目录执行 `pnpm dsh web`）或已安装的 `dsh` CLI。

---

## 0. 前置确认

- Node.js ≥ 22 与 pnpm（`pnpm --version` 有输出即可）。
- 一份 DeepSeek Harness 源码 checkout（源码运行）或已安装的 `dsh`。

```powershell
cd "你的 deepseek-harness 目录"
```

> 插件包就是一个普通目录（本仓库），放在源码目录旁边即可，例如 `..\dsh-bg-beautify`。

---

# 第一部分：安装

## 1. 安装到 profile（官方机制，一行命令）

```powershell
# 方式 A：从 GitHub 安装
pnpm dsh plugin --profile web add github:halosb/dsh-bg-beautify

# 方式 B：本地目录
pnpm dsh plugin --profile web add ../dsh-bg-beautify
```

命令做了三件事（与官方文档 `docs/user/develop/basic/publish.zh.md` 一致）：

1. 在 profile 目录 `%USERPROFILE%\.dsh\profiles\web` 里执行 `pnpm add`，把插件包链接进 `%USERPROFILE%\.dsh\profiles\node_modules`；
2. 因为该包声明了 `dsh.bundle`，自动追加进 `%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 列表；
3. 该 bundle 自带的 `cordis.patch.yml` 层插入一行插件：`id: bg-beautify / name: dsh-bg-beautify`。

装完可以验证配置确实生效（**只打印组合结果，不会启动服务**）：

```powershell
pnpm dsh --profile web --dump-config
```

在输出里应能看到：

```yaml
# == dsh-bg-beautify ==
- insert:
    - id: bg-beautify
      name: dsh-bg-beautify
```

> 本插件是纯 JS、无构建步骤，从 GitHub git 安装时**不需要** pnpm 的 `prepare`/`allowBuilds` 授权。

## 2. 重启 `dsh web`（关键一步）

**必须重启**，原因有二：

- `dsh-client-modules` 的包扫描结果是缓存的（"plugin-set changes take effect on restart"）；
- `window.__DSH_BOOT__` 引导图在启动时组装，`/plugins/dsh-bg-beautify/client.js` 只有在重启后才会进入引导图。

```powershell
pnpm dsh web --port 4000
```

## 3. 验证安装成功

1. 打开 `http://127.0.0.1:4000`（或你用的端口），刷新页面。
2. 应看到：整页有背景图，主区/侧边栏/卡片呈半透明，背景隐约透出。
3. 浏览器开发者工具 → Network 里应能请求到 `GET /plugins/dsh-bg-beautify/client.js?rev=...` 且状态 200。
4. 在 设置 → 外观 里切换 浅色/深色，两边都应该是半透明（插件对亮暗两套都给了值）。

---

# 第二部分：使用（设置页可视化操作）

> 插件自带一个设置分区：**设置 → 背景美化**。所有调整在页面上完成，
> **即时生效、持久保存**（写入插件目录 `config.json`，重启不丢）。

| 设置 | 说明 |
|---|---|
| 背景图（文本框） | 三种写法：`/bg/文件名`（插件 assets 里的本地图）、`https://...` 外链、`data:image/...` 内嵌；留空 = 无图 |
| 上传本地图片 | 选文件后自动上传到插件 `assets\` 目录，并填入 `/bg/文件名`（推荐，大图用这个） |
| 主区 / 侧边栏 / 卡片浮层 / 输入区 透明度 | 4 个滑块，0（全透）～ 1（不透），**越小背景图越明显** |
| 尺寸 | `cover`（铺满裁剪）/ `contain`（完整显示）/ `auto` |
| 位置 | 文本框，如 `center`、`top left`、`right bottom` |
| 背景固定 | 勾选 = 不随页面滚动；**大图建议不勾**（Chrome 对固定大背景会低分辨率光栅化，发糊） |
| 恢复默认 | **只重置四个透明度**到出厂值，背景图与显示方式不变 |

> 修改即生效：拖动滑块、改文本框内容，页面背景实时变化；刷新 / 重启后保持。

## 换背景图（以本地图片为例）

```powershell
# ① 把图片复制进插件的 assets 目录（或用设置页的"上传本地图片"，不用手动复制）
Copy-Item "D:\你的图片\背景.jpg" "dsh-bg-beautify\assets\background.jpg"
```

```text
# ② 打开 设置 → 背景美化，在"背景图"文本框里填：
/bg/background.jpg
```

```text
# ③ 完事——页面立刻生效（想先验证图片被伺服，浏览器直接开：
http://127.0.0.1:4000/bg/background.jpg
```

> 为什么不能直接填 `C:\...` 路径：浏览器禁止 http 页面加载本地路径（`file:///` 会被拦截），所以插件让 DSH 自己把 `assets\` 下的文件伺服为 `/bg/文件名`。支持 jpg/png/gif/webp/avif/svg。

## 出厂默认值

| 区域 | 默认 |
|---|---|
| 背景图 | `/bg/placeholder.svg`（内置占位渐变图） |
| 主区 / 聊天区 | 0（全透） |
| 侧边栏 | 0.3 |
| 卡片 / 浮层 | 0.85 |
| 输入区 | 0.75 |

想改默认值：编辑 `client.js` 顶部 `DEFAULTS`（与 `index.js` 的 `DEFAULT_CONFIG` 保持一致），改完重启 `dsh web`。

---

# 第三部分：卸载与排障

## 卸载

```powershell
pnpm dsh plugin --profile web remove dsh-bg-beautify
pnpm dsh web --port 4000      # 重启后恢复默认外观
```

该命令会同时移除依赖、对应的组合层；插件目录本身保留（`config.json` 是你的设置，一并删除即彻底还原）。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `--dump-config` 里看不到 bg-beautify 行 | 安装失败或包未声明 `dsh.bundle`；确认命令输出没有 `declares no dsh.bundle` 警告 |
| 页面无背景图 | ① 没重启（必须重启）；② 浏览器缓存旧页面，硬刷新 Ctrl+F5 |
| 设置页里改了没变化 | 设置持久化走 `GET/POST /bg/settings`；Network 里看这个请求是否 200，500 说明插件目录不可写 |
| 图片地址是 `C:\...` 或 `file:///...` 不显示 | 浏览器禁止 http 页面加载本地路径；改用 `/bg/<文件名>` |
| `/bg/xxx.jpg` 打开 404 | 文件名大小写不一致 / 没复制进 `assets\` / 格式不支持（支持 jpg/png/gif/webp/avif/svg） |
| 背景图发糊 | ① 大图把"背景固定"取消勾选（Chrome 对 fixed 大背景会模糊）；② 透明度调低让图透出来 |
| Network 里 `/plugins/dsh-bg-beautify/client.js` 404 | `exports["./client"]` 指向的文件不存在或没安装成功；重跑 `pnpm dsh plugin --profile web add` |
| 改了 `client.js` 没变化 | 客户端 bundle 内容变化需要重启（或 `pnpm run dev:web` 的 HMR watcher 正在运行才会热更） |
| 想换端口 | `pnpm dsh web --port 8080`；`--port 0` 让系统自动分配 |

---

# 第四部分：原理（想深究再看）

- 官方插件打包/安装文档：`docs/user/develop/basic/publish.zh.md`（"打包与安装插件"）
- 客户端模块系统：`packages/client/modules/README.md`（bundle 如何编入 `window.__DSH_BOOT__`、`/plugins/<id>/client.js` 如何被伺服）
- 主题覆盖接口：`packages/client/ui-theme/src/client/index.ts` 的 `overrideTokens(source, tokens)`（每个 token 必须给 `{ light, dark }` 两套值）
- 设置持久化：插件自己的 host 半边路由 `GET/POST /bg/settings` 读写 `config.json`，不走宿主 settings 服务的配置客户端白名单（`packages/host/apiproxy/src/api-proxy.ts` 的 `exposedNamespaces()`），所以无需改动任何 DSH 源码

**层优先级**（后应用者胜）：`dsh-base` → `dsh-web-app` → 你安装的各 bundle（按安装顺序）→ profile 自己的 `cordis.patch.yml` → 机器级 `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。所以你的插件层在 `dsh-web-app` 之上，可以放心覆盖主题 token。
