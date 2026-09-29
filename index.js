// dsh-bg-beautify
// 作者：芝麻 (halosb)
// 邮箱：i@halosb.com
// License: MIT
/**
 * dsh-bg-beautify — Node (host) half.
 *
 * @author 芝麻 (halosb) <i@halosb.com>
 *
 * HTTP endpoints, all on the webserver (no DSH source touched):
 *   GET  /bg/<file>     — serve a background image from ./assets/
 *   POST /bg/upload     — accept an image upload (data: URI), store it in
 *                         ./assets/, return { url: '/bg/<file>' }
 *   GET  /bg/settings   — read the persisted 背景美化 settings (config.json)
 *   POST /bg/settings   — validate and persist the settings
 *   GET  /bg/we/list    — scan the local Wallpaper Engine library (Steam
 *                         Workshop AppID 431960) and list browser-usable
 *                         wallpapers; optional ?path= manual override
 *   GET  /bg/we/preview/<id> — serve a wallpaper's preview thumbnail
 *   GET  /bg/we/media/<id>   — serve a wallpaper's media file (video/image)
 *
 * The WE integration is a pure local-file scan, no third-party API:
 *   Steam install is located via the registry (HKCU\Software\Valve\Steam →
 *   SteamPath) with common-path fallbacks; every Steam library is expanded
 *   from steamapps/libraryfolders.vdf; subscribed wallpapers live in
 *   <library>\steamapps\workshop\content\431960\<id>\ with a project.json
 *   (type/file/title) and a preview image. Only type video/image wallpapers
 *   can render in a browser; scene/web/videostream need the WE renderer and
 *   are listed as unsupported. Files are served read-only from the original
 *   folders (personal local use, nothing copied or redistributed).
 *
 * Persistence lives in this package's own config.json, so the plugin works
 * without the host settings-service allowlist (api-proxy only exposes a fixed
 * namespace list to configuration clients).
 */
import { readFile, writeFile, readdir, access, mkdir, open, rename, copyFile, rm, stat } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync, createReadStream } from 'node:fs'
import { join, normalize, basename, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { probeTextures, parsePkgTable, parseTex } from './we-convert.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const name = 'dsh-bg-beautify'

/** The webserver service is a hard dependency: every route lives on it. */
export const inject = ['webServer']

/** This package's own directory (realpath through the profile link). */
const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** 随包发布的只读资源目录（git 里有 assets/1.png 默认图）。 */
const BUNDLED_ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url))

/**
 * 用户数据目录：<DSH_HOME>/plugin-data/<profile>/dsh-bg-beautify/
 * 刻意放在 pnpm 管理的包目录之外：`dsh plugin update/remove` 会重建包目录，
 * 老版本把 config.json 和用户上传的图片都写在包内，一次更新就全没了。
 */
const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const PROFILE = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== ''
  ? process.env.DSH_PROFILE
  : 'default'
const DATA_DIR = join(DSH_HOME, 'plugin-data', PROFILE, 'dsh-bg-beautify')

/** 用户上传的背景图目录（数据目录内，写入目标）。 */
const ASSETS_DIR = join(DATA_DIR, 'assets')

/** 持久化设置文件（数据目录内）。 */
const CONFIG_PATH = join(DATA_DIR, 'config.json')

/**
 * repkg 转换视频专用目录（用户可见、一键打开管理）：
 * %USERPROFILE%\Pictures\dsh-bg-beautify\we-converted\；取不到用户目录时退回
 * 插件目录下的 converted/。
 */
const CONVERT_DIR = (() => {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return home !== ''
    ? join(home, 'Pictures', 'dsh-bg-beautify', 'we-converted')
    : fileURLToPath(new URL('./converted/', import.meta.url))
})()

/** Defaults (must match the client bundle's DEFAULTS). */
const DEFAULT_CONFIG = {
  image: '',                 // '' = 无图（只做半透明）
  size: 'cover',
  position: 'center',
  fixed: false,
  opacityMain: 0.25,
  opacitySidebar: 0.5,
  opacityCard: 0.7,
  opacityInput: 0.75,
  textColor: 'white',
  scrim: true,
  brandIcon: '',
  welcomeText: '',
  titleSuffix: '',
  glowEnabled: true,       // 输入框呼吸光晕开关（默认开启）
  glowColor: '#e8a8d0',    // 光晕主色
  glowSpeed: 2,            // 光晕速度：一个呼吸周期（秒）
  glowCross: true,         // 使用交叉色（主色 ↔ 交叉色交替）
  glowCrossColor: '#9ec5ff', // 交叉色
  glowStrength: 0.45,      // 光晕强度 0~1.5
  glowMood: false,         // 心情光晕：AI 状态情绪灯
  wePath: '',              // Wallpaper Engine 壁纸库路径（'' = 自动探测）
  wePreview: '',           // 当前 WE 壁纸的预览图 URL（视频壁纸用作 poster）
  weKind: '',              // 当前 WE 壁纸类型：video / image / web / ''（无扩展名媒体 URL 靠它识别）
  videoSpeed: 1,           // 视频壁纸播放速度（0.25～2，1 = 原速）
}

/** Upload cap: 25 MiB. Settings body cap: 64 KiB. */
const MAX_UPLOAD = 25 * 1024 * 1024
const MAX_SETTINGS = 64 * 1024

/** 转换作业表保留条数（只淘汰已结束的作业，正在跑的不动）。 */
const MAX_JOBS = 8

/** Image content types by extension (GET serving). */
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

/** Wallpaper Engine Steam AppID — its workshop content folder name. */
const WE_APPID = '431960'

/** Steam Workshop 公开详情页（场景型壁纸的预览视频来源）。 */
const WE_WORKSHOP_URL = 'https://steamcommunity.com/sharedfiles/filedetails/?id='

/** 预览视频 URL 缓存（会话内有效，避免重复抓页；null = 确认无视频）。 */
const workshopVideoCache = new Map()

/** Media content types: images + videos (WE wallpapers / video backgrounds). */
const MEDIA_TYPES = Object.assign({}, CONTENT_TYPES, {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
})

/** Web-type wallpaper (type:"web") static asset types — iframe-safe whitelist. */
const WEB_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * WE web 型壁纸运行在 WE 内嵌 Chromium，脚本常调用 WE 专有 API
 * （wallpaperRegisterListener / wallpaperPropertyListener 等）。浏览器里没有
 * 这些 API，注入一组 no-op 垫片避免脚本启动即抛错。
 */
const WE_SHIM = '<script>/* dsh-bg-beautify WE web wallpaper shim */'
  + 'window.wallpaperRegisterListener=function(){};'
  + 'window.wallpaperRegisterAudioListener=function(){};'
  + 'window.wallpaperRequestRandomFileForProperty=function(){return "";};'
  + 'window.wallpaperRequestLogLevel=function(){};'
  + 'window.wallpaperPropertyListener=window.wallpaperPropertyListener||{onUserSettingsChanged:function(){}};'
  + '</script>'

/** 把 shim 注入 HTML：优先 head 开头，其次 html 开头，最后整体前置。 */
function injectWeShim(html) {
  const head = /<head[^>]*>/i.exec(html)
  if (head !== null) return html.slice(0, head.index + head[0].length) + WE_SHIM + html.slice(head.index + head[0].length)
  const root = /<html[^>]*>/i.exec(html)
  if (root !== null) return html.slice(0, root.index + root[0].length) + WE_SHIM + html.slice(root.index + root[0].length)
  return WE_SHIM + html
}

/**
 * 从 Steam Workshop 详情页 HTML 提取第一段预览视频 URL（mp4 优先）。
 * 页面结构会变，用多模式防御式匹配；无结果返回 null。
 * 导出为纯函数便于离线单元测试。
 */
export function extractWorkshopVideo(html) {
  if (typeof html !== 'string' || html === '') return null
  const urls = new Set()
  const add = (u) => {
    if (typeof u === 'string' && /^https?:\/\//.test(u) && /\.(mp4|webm)([?#]|$)/i.test(u)) urls.add(u)
  }
  // ① g_rgFullwidthPreviews / g_rgPreviews JSON 数组里的 url / movie_mp4 / movie_webm
  for (const m of html.matchAll(/g_rg(?:Fullwidth)?Previews\s*=\s*(\[[\s\S]*?\])\s*;/g)) {
    try {
      for (const item of JSON.parse(m[1])) {
        if (item === null || typeof item !== 'object') continue
        add(item.url)
        add(item.movie_mp4)
        add(item.movie_webm)
      }
    } catch {
      // 该 JSON 段损坏，继续其他模式
    }
  }
  // ② <video>/<source> 标签
  for (const m of html.matchAll(/<source[^>]+src="([^"]+)"[^>]*>/gi)) add(m[1])
  for (const m of html.matchAll(/<video[^>]+src="([^"]+)"[^>]*>/gi)) add(m[1])
  // ③ 裸 "url" / "movie_mp4" / "movie_webm" 键
  for (const m of html.matchAll(/"url"\s*:\s*"([^"]+)"/g)) add(m[1])
  for (const m of html.matchAll(/"movie_(?:mp4|webm)"\s*:\s*"([^"]+)"/g)) add(m[1])
  // ④ 页面里直接出现的 http(s) 视频链接
  for (const m of html.matchAll(/https?:\/\/[^"'<>\\\s]+?\.(?:mp4|webm)(?:[?#][^"'<>\\\s]*)?/gi)) add(m[0])
  const list = [...urls]
  return list.find((u) => /\.mp4/i.test(u)) ?? list[0] ?? null
}

/** Mime → extension for uploads coming in as data: URIs. */
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
}

/** Only these extensions are accepted for uploads. */
function allowedExt(name) {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return undefined
  const ext = name.slice(dot).toLowerCase()
  return CONTENT_TYPES[ext] !== undefined ? ext : undefined
}

/** Sanitize a client-provided filename: bare name, safe chars, allowed extension. */
function safeName(name, fallbackExt) {
  const base = String(name)
    .replace(/[\\/]/g, '')
    .replace(/\.\./g, '')
    .replace(/[^\w.\-]/g, '_')
    .slice(0, 80)
  const dot = base.lastIndexOf('.')
  const stem = dot === -1 ? base : base.slice(0, dot)
  const ext = dot === -1 ? undefined : base.slice(dot).toLowerCase()
  const safeStem = stem === '' ? 'background' : stem
  return `${safeStem}${allowedExt(base) ? ext : fallbackExt}`
}

/** 运行期告警（读失败、迁移结果等），随 /bg/settings 回给设置页显示。 */
const warnings = []
function warn(message) {
  if (warnings.length < 20) warnings.push(message)
  console.warn('[dsh-bg-beautify]', message)
}

/** 原子写 JSON：同目录临时文件 + rename；并发写用 settingsWrite 串行化。 */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 2))
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * 老版本把 config.json 和上传的图片都放在包目录（node_modules 内）。
 * 首次启动搬到数据目录；不删除包内自带的 assets/1.png（那是 git 跟踪的默认图），
 * 伺服时用户目录优先、包内目录兜底。
 */
async function migrateLegacyData() {
  await mkdir(ASSETS_DIR, { recursive: true })
  const legacyConfig = join(PACKAGE_DIR, 'config.json')
  try {
    await stat(CONFIG_PATH)
  } catch {
    try {
      await copyFile(legacyConfig, CONFIG_PATH)
      await rm(legacyConfig, { force: true })
      warn('已把 config.json 从插件目录迁移到数据目录')
    } catch { /* 没有老配置 */ }
  }
  let entries = []
  try {
    entries = await readdir(BUNDLED_ASSETS_DIR, { withFileTypes: true })
  } catch {
    return
  }
  let moved = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const target = join(ASSETS_DIR, entry.name)
    try {
      await stat(target)
      continue // 用户目录已有同名文件，保留它
    } catch { /* 目标不存在才复制 */ }
    try {
      await copyFile(join(BUNDLED_ASSETS_DIR, entry.name), target)
      moved += 1
    } catch { /* 忽略单个失败 */ }
  }
  if (moved > 0) warn(`已把 ${moved} 张背景图导入数据目录`)
}

/** 设置缓存：原来每个 WE 路由、每次请求都要读盘 + 解析一次。 */
let settingsCache = null

/** 写入串行化：并发 POST 曾以 truncate + write 交错写坏 JSON。 */
let settingsWrite = Promise.resolve()

/** Read the persisted settings, or the defaults when absent/corrupt. */
async function readSettings() {
  if (settingsCache !== null) return settingsCache
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    settingsCache = sanitizeSettings(parsed)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
      warn(`config.json 读取失败（已回退默认值）：${error instanceof Error ? error.message : String(error)}`)
    }
    settingsCache = Object.assign({}, DEFAULT_CONFIG)
  }
  return settingsCache
}

/**
 * 合并式保存：以当前设置为底，只覆盖请求里带来的字段。
 * 原来整份覆盖 + 非原子写，任何并发或崩溃都会留下半截 JSON（读取时又静默回默认值）。
 * @param {object} patch 请求体里的设置片段。
 * @returns {Promise<object>} 落盘后的完整设置。
 */
async function writeSettings(patch) {
  const current = await readSettings()
  const next = sanitizeSettings(Object.assign({}, current, patch))
  settingsWrite = settingsWrite.catch(() => {}).then(() => writeJsonAtomic(CONFIG_PATH, next))
  await settingsWrite
  settingsCache = next
  return next
}

/** Validate and normalize one settings object; unknown keys are dropped. */
function sanitizeSettings(input) {
  const out = Object.assign({}, DEFAULT_CONFIG)
  if (input === null || typeof input !== 'object') return out
  if (typeof input.image === 'string') out.image = input.image
  if (typeof input.size === 'string') out.size = input.size
  if (typeof input.position === 'string') out.position = input.position
  if (typeof input.fixed === 'boolean') out.fixed = input.fixed
  for (const key of ['opacityMain', 'opacitySidebar', 'opacityCard', 'opacityInput']) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) {
      out[key] = Math.min(1, Math.max(0, input[key]))
    }
  }
  if (input.textColor === 'white' || input.textColor === 'black' || input.textColor === 'auto') {
    out.textColor = input.textColor
  }
  if (typeof input.scrim === 'boolean') out.scrim = input.scrim
  if (typeof input.brandIcon === 'string') out.brandIcon = input.brandIcon
  if (typeof input.welcomeText === 'string') out.welcomeText = input.welcomeText
  if (typeof input.titleSuffix === 'string') out.titleSuffix = input.titleSuffix
  if (typeof input.glowEnabled === 'boolean') out.glowEnabled = input.glowEnabled
  if (typeof input.glowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.glowColor)) out.glowColor = input.glowColor
  if (typeof input.glowSpeed === 'number' && Number.isFinite(input.glowSpeed)) {
    out.glowSpeed = Math.min(10, Math.max(0.3, input.glowSpeed))
  }
  if (typeof input.glowCross === 'boolean') out.glowCross = input.glowCross
  if (typeof input.glowCrossColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.glowCrossColor)) out.glowCrossColor = input.glowCrossColor
  if (typeof input.glowStrength === 'number' && Number.isFinite(input.glowStrength)) {
    out.glowStrength = Math.min(1.5, Math.max(0, input.glowStrength))
  }
  if (typeof input.glowMood === 'boolean') out.glowMood = input.glowMood
  if (typeof input.wePath === 'string') out.wePath = input.wePath.slice(0, 300)
  if (typeof input.wePreview === 'string') out.wePreview = input.wePreview.slice(0, 300)
  if (input.weKind === 'video' || input.weKind === 'image' || input.weKind === 'web') out.weKind = input.weKind
  if (typeof input.videoSpeed === 'number' && Number.isFinite(input.videoSpeed)) {
    out.videoSpeed = Math.min(2, Math.max(0.25, input.videoSpeed))
  }
  return out
}

/** Collect a request body up to a byte cap; null on overflow. */
async function readBody(req, cap) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) {
      req.destroy() // 超限要断开，否则客户端还在发、socket 悬挂
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

// ── 请求准入 ───────────────────────────────────────────────────────────────

function isLoopbackAddress(address) {
  const value = address.toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

function isLoopbackHostname(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || value.startsWith('127.')
}

/**
 * 请求准入。优先用编排里的 `connection` 服务（Host/Origin 栅栏 + 浏览器会话认证，
 * 与官方 open-in-app 等路由属主同一套策略）；服务不可用时退化为自带的回环栅栏。
 * 没有这道闸门时，本机任何进程都能改设置、上传文件、触发任意目录扫描。
 * @returns 拒绝时返回 HTTP 状态码，放行返回 undefined。
 */
function requestRejection(ctx, req) {
  try {
    const connection = ctx.get('connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      const code = connection.requestRejection(req)
      if (code !== undefined) return code
      return undefined
    }
  } catch {
    // 服务不可用，走自带栅栏
  }
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return 403
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 403
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return 403
  if (req.headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403
    } catch {
      return 403
    }
  }
  const remote = req.socket === null || req.socket === undefined ? undefined : req.socket.remoteAddress
  if (typeof remote === 'string' && remote !== '' && !isLoopbackAddress(remote)) return 403
  return undefined
}

/** 写请求必须声明 JSON：阻止浏览器用简单请求跨站提交（免预检的那类）。 */
function contentTypeAllowed(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().includes('application/json')
}

/**
 * 统一的入口闸门：先过准入，再要求写请求声明 JSON。
 * @returns true 表示已经回写了拒绝响应，调用方应立即返回。
 */
function rejected(ctx, req, res) {
  const rejection = requestRejection(ctx, req)
  if (rejection !== undefined) {
    json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return true
  }
  if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && !contentTypeAllowed(req)) {
    json(res, 415, { error: 'expected application/json' })
    return true
  }
  return false
}

// ── Wallpaper Engine 壁纸库（纯本地扫描，无第三方 API） ─────────────────────
// 壁纸存放在 Steam 库的 steamapps/workshop/content/431960/<workshop_id>/，
// 每张壁纸一个目录：project.json（type/file/title）+ preview 缩略图 + 媒体文件。
// 探测流程：注册表 SteamPath → libraryfolders.vdf 展开全部库 → 常见默认路径。
// 仅 type 为 video / image 的壁纸浏览器可渲染；scene/web/videostream 需要
// WE 自己的渲染器，列表中标为"不支持"。文件只读伺服原始目录，不复制不分发。

const execFileP = promisify(execFile)

/** Query one REG_SZ value, e.g. SteamPath under HKCU\Software\Valve\Steam. */
async function regQuery(key, valueName) {
  try {
    const { stdout } = await execFileP('reg', ['query', key, '/v', valueName], {
      timeout: 2000,
      windowsHide: true,
      encoding: 'utf8',
    })
    const m = /REG_SZ\s+(\S.*)$/m.exec(stdout)
    return m !== null ? m[1].trim() : null
  } catch {
    return null
  }
}

/** Parse every "path" entry out of a Steam libraryfolders.vdf. */
function vdfLibraryPaths(text) {
  const out = []
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    out.push(m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'))
  }
  return out
}

/** Every Steam library's steamapps directory this machine can see.
 * 用 realpath + 小写键去重：同一库可能经注册表 / 常见路径 / vdf 以不同大小写
 * 拼写被发现，Windows 路径大小写不敏感，必须规范化否则每张壁纸会列两遍。 */
async function detectSteamAppsDirs() {
  const dirs = new Map() // 小写规范化路径 → 真实路径
  function addApps(p) {
    if (typeof p !== 'string' || p === '') return
    let real = p
    try { real = realpathSync.native(p) } catch { /* 目录不存在则用原样 */ }
    dirs.set(real.toLowerCase(), real)
  }
  function addSteam(steamDir) {
    if (typeof steamDir !== 'string' || steamDir === '') return
    const apps = join(steamDir, 'steamapps')
    if (existsSync(apps)) addApps(apps)
    const vdf = join(steamDir, 'steamapps', 'libraryfolders.vdf')
    if (existsSync(vdf)) {
      try {
        for (const p of vdfLibraryPaths(readFileSync(vdf, 'utf8'))) {
          const lib = p.replace(/[\\/]+$/, '')
          addApps(/steamapps$/i.test(lib) ? lib : join(lib, 'steamapps'))
        }
      } catch {
        // unreadable vdf — keep going with what we have
      }
    }
  }
  const reg = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')
  if (reg !== null) addSteam(reg)
  const pf = process.env.ProgramFiles
  const pfx = process.env['ProgramFiles(x86)']
  const candidates = [
    pfx !== undefined ? join(pfx, 'Steam') : '',
    pf !== undefined ? join(pf, 'Steam') : '',
    'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam',
    'C:\\Steam', 'D:\\Steam', 'E:\\Steam',
    'C:\\SteamLibrary', 'D:\\SteamLibrary', 'E:\\SteamLibrary',
  ]
  for (const c of candidates) if (c !== '') addSteam(c)
  return [...dirs.values()]
}

/** A folder is a WE wallpaper when it contains project.json. */
async function isWallpaperFolder(folder) {
  try {
    await access(join(folder, 'project.json'))
    return true
  } catch {
    return false
  }
}

/**
 * Every wallpaper folder reachable now: the manual path first (either a
 * wallpaper folder itself, or a content root whose subfolders are wallpapers),
 * then each Steam library's WE workshop content. Returns Map<folderPath, id>.
 */
async function listWallpaperFolders(manual, steamAppsDirs) {
  const folders = new Map()
  const seenIds = new Set() // 按壁纸 id 兜底去重（同一张壁纸不因路径拼写重复出现）
  async function addFolder(folder, id) {
    if (await isWallpaperFolder(folder) && !seenIds.has(id)) {
      seenIds.add(id)
      folders.set(folder, id)
    }
  }
  async function addRoot(root) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) await addFolder(join(root, e.name), e.name)
    }
  }
  if (manual !== '') {
    if (await isWallpaperFolder(manual)) folders.set(manual, basename(manual))
    else await addRoot(manual)
  }
  for (const apps of steamAppsDirs) {
    await addRoot(join(apps, 'workshop', 'content', WE_APPID))
  }
  return folders
}

/** Parse a wallpaper folder's project.json (null when absent/corrupt). */
async function readProject(folder) {
  try {
    return JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'))
  } catch {
    return null
  }
}

/** The wallpaper folder for a picker id (null = not found / unsafe id). */
async function resolveWallpaperFolder(id, manual) {
  if (typeof id !== 'string' || id === '' || id.includes('..') || id.includes('/') || id.includes('\\')) {
    return null
  }
  if (manual !== '') {
    if (await isWallpaperFolder(manual) && basename(manual) === id) return manual
    const sub = join(manual, id)
    if (await isWallpaperFolder(sub)) return sub
  }
  const dirs = await detectSteamAppsDirs()
  for (const apps of dirs) {
    const f = join(apps, 'workshop', 'content', WE_APPID, id)
    if (await isWallpaperFolder(f)) return f
  }
  return null
}

/** First existing preview file name in a wallpaper folder (or null). */
async function findPreviewFile(folder, proj) {
  const candidates = []
  if (proj !== null && proj.general !== null && typeof proj.general === 'object'
    && typeof proj.general.preview === 'string' && proj.general.preview !== '') {
    candidates.push(basename(proj.general.preview))
  }
  candidates.push('preview.jpg', 'preview.png', 'preview.webp', 'preview.jpeg')
  for (const name of candidates) {
    try {
      await access(join(folder, name))
      return name
    } catch {
      // try next candidate
    }
  }
  return null
}

/** 定位壁纸目录里的包文件：优先 scene.pkg，否则目录内任意 .pkg。 */
async function resolvePkgFile(folder) {
  if (existsSync(join(folder, 'scene.pkg'))) return 'scene.pkg'
  try {
    const entries = await readdir(folder, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && /\.pkg$/i.test(e.name)) return e.name
    }
  } catch { /* 忽略 */ }
  return null
}

/** 可转换性探测缓存（会话内；scene.pkg 基本不变）。 */
const convertProbeCache = new Map()

/** 头部探测上限：条目表最多读这么多；单个 TEX 只读头部这么多。 */
const PROBE_TABLE_MAX = 4 * 1024 * 1024
const PROBE_TEX_BYTES = 64 * 1024

/**
 * 头部级探测：解析 PKG 条目表 + 每个 .tex 的头部，不把整个包读进内存。
 * 原来扫描时对每张场景壁纸整包 readFile（scene.pkg 常见上百 MB），注释却写"只读头部"。
 * 头部不足以判断时返回 null，由调用方退回整包探测，保证不漏判。
 * @param {string} pkgPath scene.pkg 路径
 * @returns {Promise<{video: boolean, gif: boolean}|null>}
 */
async function probePkgHeader(pkgPath) {
  const handle = await open(pkgPath, 'r')
  try {
    let table = null
    let size = 64 * 1024
    for (;;) {
      const want = Math.min(size, PROBE_TABLE_MAX)
      const buf = Buffer.alloc(want)
      const { bytesRead } = await handle.read(buf, 0, want, 0)
      try {
        table = parsePkgTable(buf.subarray(0, bytesRead))
        break
      } catch {
        if (bytesRead < want || want >= PROBE_TABLE_MAX) return null
        size *= 2
      }
    }
    const result = { video: false, gif: false }
    for (const entry of table.entries) {
      if (!/\.tex$/i.test(entry.path) || entry.length < 8) continue
      const position = table.dataStart + entry.offset
      if (position < 0) return null
      const want = Math.min(entry.length, PROBE_TEX_BYTES)
      const buf = Buffer.alloc(want)
      const { bytesRead } = await handle.read(buf, 0, want, position)
      let tex
      try {
        tex = parseTex(buf.subarray(0, bytesRead))
      } catch {
        return null // 头部不够解析 → 交给整包路径
      }
      if (tex === null) continue
      if ((tex.flags & 32) !== 0 || tex.imageFormat === 35) result.video = true
      else if ((tex.flags & 4) !== 0) result.gif = true
      if (result.video && result.gif) break
    }
    return result
  } finally {
    await handle.close()
  }
}

/** 探测场景包是否含视频纹理 / 动画序列（只读头部、不解码像素）。 */
async function probeConvertible(folder) {
  const cached = convertProbeCache.get(folder)
  if (cached !== undefined) return cached
  const result = { video: false, gif: false }
  try {
    const pkgName = await resolvePkgFile(folder)
    if (pkgName !== null) {
      const pkgPath = join(folder, pkgName)
      let probed = null
      try {
        probed = await probePkgHeader(pkgPath)
      } catch {
        probed = null
      }
      if (probed === null) probed = probeTextures(await readFile(pkgPath))
      Object.assign(result, probed)
    }
  } catch { /* 保持 false */ }
  convertProbeCache.set(folder, result)
  return result
}

/** One picker entry for a wallpaper folder. */
async function buildWeEntry(folder, id) {
  const proj = await readProject(folder)
  const rawType = proj !== null && typeof proj.type === 'string' ? proj.type.toLowerCase() : ''
  let type = 'unknown'
  if (rawType === 'video') type = 'video'
  else if (rawType === 'image') type = 'image'
  else if (rawType === 'scene') type = 'scene'
  else if (rawType === 'web') type = 'web'
  else if (rawType === 'videostream') type = 'videostream'
  else if (rawType !== '') type = 'other'
  const file = proj !== null && typeof proj.file === 'string' && proj.file !== ''
    ? basename(proj.file) : ''
  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot).toLowerCase()
  // video/image → 媒体文件；web → 沙箱 iframe 静态目录（index.html 入口）。
  let supported = false
  let mediaUrl = ''
  if (type === 'video' || type === 'image') {
    supported = MEDIA_TYPES[ext] !== undefined
    if (supported) mediaUrl = '/bg/we/media/' + encodeURIComponent(id)
  } else if (type === 'web') {
    supported = file !== ''
    if (supported) mediaUrl = '/bg/we/web/' + encodeURIComponent(id) + '/'
  }
  // scene 型：探测是否含可转换纹理（视频纹理/动画序列），供自动转换与按钮显隐。
  let convertible = false
  if (type === 'scene') {
    const probe = await probeConvertible(folder)
    convertible = probe.video || probe.gif
  }
  const title = proj !== null && typeof proj.title === 'string' && proj.title.trim() !== ''
    ? proj.title.trim().slice(0, 80) : id
  const preview = await findPreviewFile(folder, proj)
  return {
    id,
    title,
    type,
    supported,
    convertible,
    reason: supported ? '' : (type === 'scene' || type === 'videostream'
      ? '需要 Wallpaper Engine 渲染器' : '缺少可用的媒体文件'),
    previewUrl: preview !== null ? '/bg/we/preview/' + encodeURIComponent(id) : '',
    mediaUrl,
  }
}

/**
 * Serve one WE file (media or preview) with HEAD support.
 * 流式 + Range：原来整片 readFile 进内存，视频壁纸无法 seek 也没法边下边播。
 */
async function serveWeFile(req, res, filePath) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (!info.isFile()) {
    res.writeHead(404)
    res.end()
    return
  }
  const dot = filePath.lastIndexOf('.')
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()
  const headers = {
    'content-type': MEDIA_TYPES[ext] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  }
  // SVG 作为独立文档打开时可能带脚本：锁死其能力（作为 <img>/CSS 背景使用时本来就不执行脚本）。
  if (ext === '.svg') {
    headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  }
  let start = 0
  let end = info.size - 1
  let status = 200
  const range = req.headers.range
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null && (match[1] !== '' || match[2] !== '')) {
      if (match[1] === '') {
        start = Math.max(0, info.size - Number(match[2]))
        end = info.size - 1
      } else {
        start = Number(match[1])
        end = match[2] === '' ? info.size - 1 : Math.min(Number(match[2]), info.size - 1)
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` })
        res.end()
        return
      }
      status = 206
      headers['content-range'] = `bytes ${start}-${end}/${info.size}`
    }
  }
  headers['content-length'] = String(end - start + 1)
  res.writeHead(status, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await new Promise((resolve) => {
    const stream = createReadStream(filePath, { start, end })
    stream.on('error', () => { res.destroy(); resolve() })
    stream.on('close', resolve)
    stream.pipe(res)
  })
}

/** GET /bg/we/list — scan and list wallpapers; ?path= overrides settings. */
async function handleWeList(req, res, query) {
  const settings = await readSettings()
  let manual = typeof settings.wePath === 'string' ? settings.wePath.trim() : ''
  const qp = query.get('path')
  if (qp !== null && qp !== '') manual = qp
  // ?auto=0 关闭自动转换（测试/调试用）
  const autoConvert = query.get('auto') !== '0'
  const dirs = await detectSteamAppsDirs()
  const folders = await listWallpaperFolders(manual, dirs)
  const wallpapers = []
  const idToFolder = new Map()
  for (const [folder, id] of folders) {
    idToFolder.set(id, folder)
    wallpapers.push(await buildWeEntry(folder, id))
  }
  wallpapers.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'))
  // 自动转换：扫描到"含可用纹理的场景壁纸"且尚未转换过的，后台自动转出
  // mp4/GIF（跳过已转换的，避免重复产出）。
  let autoJob = null
  if (autoConvert) {
    const pending = []
    const seenPending = new Set()
    let existing = []
    try { existing = await readdir(CONVERT_DIR) } catch { /* 目录可能不存在 */ }
    for (const w of wallpapers) {
      if (w.type === 'scene' && w.convertible === true
        && !seenPending.has(w.id)
        && !existing.some((n) => n.startsWith(w.id + '-'))) {
        seenPending.add(w.id)
        pending.push(w.id)
      }
    }
    if (pending.length > 0) autoJob = startAutoConvertJob(pending, idToFolder)
  }
  let library = manual !== '' && existsSync(manual) ? manual : ''
  if (library === '') {
    for (const d of dirs) {
      const content = join(d, 'workshop', 'content', WE_APPID)
      if (existsSync(content)) {
        library = content
        break
      }
    }
  }
  json(res, 200, { ok: true, library, count: wallpapers.length, wallpapers, autoJob })
}

/** GET /bg/we/preview/<id> or /bg/we/media/<id> — serve one wallpaper file. */
async function handleWeFile(req, res, kind, id) {
  if (id === '' || id.includes('..') || id.includes('/') || id.includes('\\')) {
    res.writeHead(404)
    res.end()
    return
  }
  const settings = await readSettings()
  const manual = typeof settings.wePath === 'string' ? settings.wePath.trim() : ''
  const folder = await resolveWallpaperFolder(id, manual)
  if (folder === null) {
    res.writeHead(404)
    res.end()
    return
  }
  const proj = await readProject(folder)
  if (kind === 'preview') {
    const preview = await findPreviewFile(folder, proj)
    if (preview === null) {
      res.writeHead(404)
      res.end()
      return
    }
    await serveWeFile(req, res, join(folder, preview))
    return
  }
  // kind === 'media': only project.json's own media file, strictly inside the folder.
  const file = proj !== null && typeof proj.file === 'string' && proj.file !== '' ? basename(proj.file) : ''
  const filePath = join(folder, file)
  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot).toLowerCase()
  if (file === '' || MEDIA_TYPES[ext] === undefined
    || !normalize(filePath).startsWith(normalize(folder) + sep)) {
    res.writeHead(404)
    res.end()
    return
  }
  await serveWeFile(req, res, filePath)
}

/**
 * GET /bg/we/web/<id>/[<sub path>] — web 型壁纸静态伺服（沙箱 iframe 的入口与
 * 资源）。sub 为空时伺服 project.json 指定的入口页（默认 index.html）；
 * 仅放行扩展名白名单内的静态资源，子路径逐段拒绝 '..'，整体严格限制在壁纸
 * 目录内。HTML 响应注入 WE 专有 API 的 no-op 垫片。
 */
async function handleWeWebFile(req, res, id, sub) {
  if (id === '' || id.includes('..') || id.includes('/') || id.includes('\\')) {
    res.writeHead(404)
    res.end()
    return
  }
  if (sub.includes('\\')) {
    res.writeHead(404)
    res.end()
    return
  }
  const settings = await readSettings()
  const manual = typeof settings.wePath === 'string' ? settings.wePath.trim() : ''
  const folder = await resolveWallpaperFolder(id, manual)
  if (folder === null) {
    res.writeHead(404)
    res.end()
    return
  }
  const proj = await readProject(folder)
  let rel = ''
  if (sub !== '') {
    const parts = sub.split('/')
    for (const p of parts) {
      if (p === '' || p === '.' || p === '..') {
        res.writeHead(404)
        res.end()
        return
      }
    }
    rel = parts.join(sep)
  }
  let fileName = rel
  if (fileName === '') {
    fileName = proj !== null && typeof proj.file === 'string' && proj.file !== '' ? basename(proj.file) : 'index.html'
  }
  const filePath = join(folder, fileName)
  const dot = fileName.lastIndexOf('.')
  const ext = dot === -1 ? '' : fileName.slice(dot).toLowerCase()
  if (WEB_TYPES[ext] === undefined
    || !normalize(filePath).startsWith(normalize(folder) + sep)) {
    res.writeHead(404)
    res.end()
    return
  }
  let body
  try {
    body = await readFile(filePath)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (ext === '.html' || ext === '.htm') {
    body = Buffer.from(injectWeShim(body.toString('utf8')), 'utf8')
  }
  res.writeHead(200, {
    'content-type': WEB_TYPES[ext],
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

/**
 * GET /bg/we/video/<id> — 场景型壁纸的 Workshop 公开预览视频 URL。
 * 仅对 Workshop 订阅壁纸生效（本地自建/手动路径壁纸无公开页）；结果按 id
 * 缓存。Steam 社区不可达或页面无视频时返回 ok:false，客户端回退预览图。
 */
async function handleWeVideo(req, res, id) {
  if (id === '' || id.includes('..') || id.includes('/') || id.includes('\\')) {
    res.writeHead(404)
    res.end()
    return
  }
  const settings = await readSettings()
  const manual = typeof settings.wePath === 'string' ? settings.wePath.trim() : ''
  const folder = await resolveWallpaperFolder(id, manual)
  if (folder === null) {
    res.writeHead(404)
    res.end()
    return
  }
  const marker = ['workshop', 'content', WE_APPID, ''].join(sep)
  if (!folder.includes(marker)) {
    json(res, 200, { ok: false, message: '本地自建壁纸没有 Workshop 预览页' })
    return
  }
  if (workshopVideoCache.has(id)) {
    const cached = workshopVideoCache.get(id)
    if (cached === null) json(res, 200, { ok: false, message: '该壁纸没有公开预览视频' })
    else json(res, 200, { ok: true, url: cached, id })
    return
  }
  let pageRes
  try {
    pageRes = await fetch(WE_WORKSHOP_URL + id, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-bg-beautify/0.3' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    })
  } catch {
    json(res, 200, { ok: false, message: '无法访问 Steam 社区（网络不通或超时）' })
    return
  }
  if (!pageRes.ok) {
    json(res, 200, { ok: false, message: `Steam 社区返回 HTTP ${pageRes.status}` })
    return
  }
  const html = await pageRes.text()
  const url = extractWorkshopVideo(html)
  if (url === null) {
    workshopVideoCache.set(id, null)
    json(res, 200, { ok: false, message: '该壁纸没有公开预览视频' })
    return
  }
  workshopVideoCache.set(id, url)
  json(res, 200, { ok: true, url, id })
}

// ── 场景→mp4/GIF 转换（纯内置，Node 原生，无需任何外部工具） ───────────────

/** 转换作业注册表（进度条轮询用）。 */
const convertJobs = new Map()
let convertJobSeq = 0

/**
 * 淘汰最旧的**已结束**作业。原来按条数 FIFO 无条件删最旧，
 * 正在跑的作业被删掉后客户端永远查不到结果，进度条卡在 400ms 无限轮询。
 */
function pruneJobs() {
  if (convertJobs.size <= MAX_JOBS) return
  for (const [key, value] of convertJobs) {
    if (convertJobs.size <= MAX_JOBS) break
    if (value.state === 'running') continue
    convertJobs.delete(key)
  }
}

/**
 * 在 worker 线程里跑一次转换，避免阻塞宿主事件循环。
 * 原来整包 readFile + LZ4/DXT 解码 + GIF 编码全同步跑在 host 主线程上，
 * 转换期间 Agent 与 HTTP 服务一起卡住，大场景还会把宿主内存顶爆。
 * @param {string} pkgPath scene.pkg 路径
 * @param {(done: number, total: number, phase: string) => void} onProgress 进度回调
 * @returns {Promise<Array<{kind: 'mp4'|'gif', name: string, bytes: Buffer}>>}
 */
function convertInWorker(pkgPath, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./convert-worker.js', import.meta.url), {
      workerData: { pkgPath },
    })
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      void worker.terminate()
      fn(value)
    }
    worker.on('message', (message) => {
      if (message === null || typeof message !== 'object') return
      if (message.type === 'progress') {
        if (onProgress !== undefined) onProgress(message.done, message.total, message.phase)
        return
      }
      if (message.type === 'items') {
        finish(resolve, message.items.map(item => ({
          kind: item.kind,
          name: item.name,
          bytes: Buffer.from(item.bytes),
        })))
        return
      }
      if (message.type === 'error') finish(reject, new Error(message.message))
    })
    worker.on('error', error => finish(reject, error))
    worker.on('exit', (code) => {
      if (!settled && code !== 0) finish(reject, new Error(`转换进程异常退出（code ${code}）`))
    })
  })
}

/** 转换输出文件名：<id>-<标题>，去掉 Windows 非法字符。 */
function safeConvertName(stem, ext) {
  const s = String(stem)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return (s === '' ? 'wallpaper' : s) + ext.toLowerCase()
}

/** 目标已存在时追加 -2/-3… 序号。 */
function uniquePath(dir, base) {
  const dot = base.lastIndexOf('.')
  const stem = dot === -1 ? base : base.slice(0, dot)
  const ext = dot === -1 ? '' : base.slice(dot)
  let name = base
  let i = 2
  while (existsSync(join(dir, name))) {
    name = `${stem}-${i}${ext}`
    i++
  }
  return name
}

/** GET /bg/we/converted — 列出转换视频库里的视频文件。 */
async function handleWeConvertedList(req, res) {
  const files = []
  let entries
  try { entries = await readdir(CONVERT_DIR, { withFileTypes: true }) } catch { entries = [] }
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!/\.(mp4|webm|m4v|mov|gif)$/i.test(e.name)) continue
    files.push({ name: e.name, url: '/bg/conv/' + encodeURIComponent(e.name) })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  json(res, 200, { ok: true, dir: CONVERT_DIR, files })
}

/** POST /bg/we/openfolder — 资源管理器打开转换文件夹（用户管理/删除）。
 * 注：DSH host 里 spawn('explorer.exe') 会抛错；改用 powershell Start-Process
 * （与桌宠同一已验证可用的机制）。 */
async function handleWeOpenFolder(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
  try { await mkdir(CONVERT_DIR, { recursive: true }) } catch { /* 目录建失败也继续尝试打开 */ }
  try {
    if (process.platform === 'win32') {
      // 路径经环境变量传给 PowerShell：拼进 -Command 文本时，路径里的引号或
      // $(...) 会改变脚本语义（用户名含单引号即可触发）。
      await execFileP('powershell', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-Command', 'Start-Process explorer.exe -ArgumentList $env:BG_OPEN_DIR',
      ], { windowsHide: true, env: Object.assign({}, process.env, { BG_OPEN_DIR: CONVERT_DIR }) })
    } else {
      await execFileP(process.platform === 'darwin' ? 'open' : 'xdg-open', [CONVERT_DIR], {})
    }
    // 注：原实现调用的是从未导入的 spawn，每次必抛 ReferenceError 并被 catch 吞成 ok:false。
    json(res, 200, { ok: true, dir: CONVERT_DIR })
  } catch {
    json(res, 200, { ok: false, message: '无法打开资源管理器' })
  }
}

/** GET /bg/we/job?id= — 轮询转换作业进度（进度条）。 */
async function handleWeJob(req, res, query) {
  const id = query.get('id') ?? ''
  const job = convertJobs.get(id)
  if (job === undefined) {
    // 明确告知"已过期"，客户端据此停止轮询（原来只当"还在跑"，400ms 无限续期）。
    json(res, 200, { ok: false, expired: true, message: '作业不存在或已过期' })
    return
  }
  json(res, 200, {
    ok: true,
    state: job.state,
    progress: job.progress,
    message: job.message,
    files: job.files !== null ? job.files : undefined,
  })
}

/**
 * POST /bg/we/convert — 启动转换作业：纯内置（Node 原生、零外部依赖）解析
 * PKG/TEX，抽出视频纹理 mp4 或把 GIF 动画序列转成动画 GIF，写入转换视频库。
 * 返回作业 id，客户端轮询 /bg/we/job 获取进度。
 */
async function handleWeConvert(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
  const body = await readBody(req, 16 * 1024)
  let id = ''
  if (body !== null) {
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      if (typeof parsed.id === 'string') id = parsed.id
    } catch { /* 默认空 */ }
  }
  if (id === '' || id.includes('..') || id.includes('/') || id.includes('\\')) {
    json(res, 400, { ok: false, message: '无效的壁纸 id' })
    return
  }
  const settings = await readSettings()
  const manual = typeof settings.wePath === 'string' ? settings.wePath.trim() : ''
  const folder = await resolveWallpaperFolder(id, manual)
  if (folder === null) {
    json(res, 404, { ok: false, message: '壁纸目录不存在' })
    return
  }
  const proj = await readProject(folder)
  // WE 的 project.json 里 file 字段是场景定义（scene.json），不是包文件本体；
  // 实际包固定叫 scene.pkg（兜底：目录里找 .pkg 文件）。
  const pkgName = await resolvePkgFile(folder)
  if (pkgName === null) {
    json(res, 200, { ok: false, message: '壁纸目录里没有可转换的 pkg 文件' })
    return
  }
  const title = proj !== null && typeof proj.title === 'string' && proj.title.trim() !== ''
    ? proj.title.trim().slice(0, 60) : id
  const pkgPath = join(folder, pkgName)

  const jobId = `conv${++convertJobSeq}`
  const job = { state: 'running', progress: 0, message: '准备转换…', files: null }
  convertJobs.set(jobId, job)
  pruneJobs()

  void (async () => {
    try {
      job.message = '提取视频纹理…'
      // 解码在 worker 线程里跑：宿主事件循环不再被 LZ4/DXT/GIF 编码占住。
      const items = await convertInWorker(pkgPath, (done, total, phase) => {
        if (phase === 'video') job.progress = total > 0 ? Math.round((done / total) * 50) : 0
        else job.progress = total > 0 ? Math.round(50 + (done / total) * 50) : 50
        if (phase === 'gif') job.message = '转换动画序列（GIF）…'
      })
      if (items.length === 0) {
        job.state = 'error'
        job.message = '该场景没有可提取的视频纹理或动画序列（纯 3D/粒子场景，内置转换无果）'
        job.progress = 100
        return
      }
      job.message = '写入转换文件夹…'
      job.progress = 95
      // 目录必须先建：原来只有"打开文件夹"会 mkdir，首次转换直接写盘会失败
      // （在用户机器上被早已存在的目录掩盖了）。
      await mkdir(CONVERT_DIR, { recursive: true })
      const added = []
      let skipped = 0
      let n = 0
      for (const item of items) {
        const isGif = item.kind === 'gif'
        const stem = `${id}-${title}${items.length > 1 ? '-' + (++n) : ''}`
        const dest = join(CONVERT_DIR, safeConvertName(stem, isGif ? '.gif' : '.mp4'))
        if (existsSync(dest)) { skipped++; continue } // 已存在：跳过，不再产生 -N 副本
        try {
          await writeFile(dest, item.bytes)
          added.push({ name: basename(dest), url: '/bg/conv/' + encodeURIComponent(basename(dest)) })
        } catch { /* 单个失败继续 */ }
      }
      job.progress = 100
      if (added.length === 0) {
        job.state = 'error'
        job.message = skipped > 0 ? '这些内容已经转换过了（已跳过重复）' : '转换完成但写入失败'
      } else {
        job.state = 'done'
        job.message = `转换完成：${added.length} 个（视频/动画）${skipped > 0 ? `，跳过 ${skipped} 个已存在` : ''}`
        job.files = added
      }
    } catch (e) {
      job.state = 'error'
      job.message = `转换失败：${e instanceof Error ? e.message : String(e)}`
      job.progress = 100
    }
  })()

  json(res, 200, { ok: true, job: jobId, dir: CONVERT_DIR })
}

/** 自动转换单张场景壁纸（跳过逻辑在调用方）；返回产出文件名数组或 null。 */
async function autoConvertOne(id, idToFolder) {
  const folder = idToFolder !== undefined && idToFolder !== null ? idToFolder.get(id) : undefined
  if (folder === undefined) return null
  const proj = await readProject(folder)
  const pkgName = await resolvePkgFile(folder)
  if (pkgName === null) return null
  const items = await convertInWorker(join(folder, pkgName))
  if (items.length === 0) return null
  const title = proj !== null && typeof proj.title === 'string' && proj.title.trim() !== ''
    ? proj.title.trim().slice(0, 60) : id
  await mkdir(CONVERT_DIR, { recursive: true })
  const added = []
  let n = 0
  for (const item of items) {
    const isGif = item.kind === 'gif'
    const stem = `${id}-${title}${items.length > 1 ? '-' + (++n) : ''}`
    const dest = join(CONVERT_DIR, safeConvertName(stem, isGif ? '.gif' : '.mp4'))
    // 已存在则跳过：不再产生 -N 重复副本（去重核心）
    if (existsSync(dest)) continue
    try {
      await writeFile(dest, item.bytes)
      added.push(basename(dest))
    } catch { /* 单个失败继续 */ }
  }
  return added.length > 0 ? added : null
}

/** 启动"扫描后自动转换"后台作业（逐张转换、带进度，客户端轮询 /bg/we/job）。 */
function startAutoConvertJob(ids, idToFolder) {
  const jobId = `conv${++convertJobSeq}`
  const job = { state: 'running', progress: 0, message: '自动转换中…', files: null }
  convertJobs.set(jobId, job)
  pruneJobs()
  const total = ids.length
  void (async () => {
    let done = 0
    for (const id of ids) {
      try {
        await autoConvertOne(id, idToFolder)
      } catch { /* 单张失败继续 */ }
      done++
      job.progress = Math.round((done / total) * 100)
      job.message = `自动转换 ${done}/${total}…`
      await new Promise((r) => setImmediate(r))
    }
    job.state = 'done'
    job.message = `自动转换完成：${done}/${total} 张，可在「转换视频」标签查看`
    job.progress = 100
  })()
  return jobId
}

export function apply(ctx) {
  // 首次启动：把老版本写在包目录里的 config.json / 上传图片搬到数据目录。
  void migrateLegacyData().then(() => readSettings()).catch(() => {})

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/bg',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      let pathname
      let query
      try {
        const u = new URL(req.url ?? '/', 'http://x')
        pathname = decodeURIComponent(u.pathname)
        query = u.searchParams
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      // POST 专用路由先分流（转换 / 打开文件夹），各自校验方法；
      // 其余路由受下面的 GET/HEAD 通用守卫约束。
      if (pathname === '/bg/we/convert') {
        await handleWeConvert(req, res)
        return
      }
      if (pathname === '/bg/we/openfolder') {
        await handleWeOpenFolder(req, res)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      // Wallpaper Engine 壁纸库：列表 / 预览 / 媒体（先于资产路由分流）
      if (pathname === '/bg/we/list') {
        await handleWeList(req, res, query)
        return
      }
      if (pathname.startsWith('/bg/we/preview/')) {
        await handleWeFile(req, res, 'preview', pathname.slice('/bg/we/preview/'.length))
        return
      }
      if (pathname.startsWith('/bg/we/media/')) {
        await handleWeFile(req, res, 'media', pathname.slice('/bg/we/media/'.length))
        return
      }
      if (pathname.startsWith('/bg/we/web/')) {
        const rest = pathname.slice('/bg/we/web/'.length)
        const slash = rest.indexOf('/')
        const id = slash === -1 ? rest : rest.slice(0, slash)
        const sub = slash === -1 ? '' : rest.slice(slash + 1)
        await handleWeWebFile(req, res, id, sub)
        return
      }
      if (pathname.startsWith('/bg/we/video/')) {
        await handleWeVideo(req, res, pathname.slice('/bg/we/video/'.length))
        return
      }
      if (pathname === '/bg/we/converted') {
        await handleWeConvertedList(req, res)
        return
      }
      if (pathname === '/bg/we/job') {
        await handleWeJob(req, res, query)
        return
      }
      // 转换视频库文件伺服（/bg/conv/<name>）
      if (pathname.startsWith('/bg/conv/')) {
        const name = pathname.slice('/bg/conv/'.length)
        if (name === '' || name.includes('..') || name.includes('/') || name.includes('\\')) {
          res.writeHead(404)
          res.end()
          return
        }
        const filePath = join(CONVERT_DIR, name)
        if (!normalize(filePath).startsWith(normalize(CONVERT_DIR) + sep)) {
          res.writeHead(404)
          res.end()
          return
        }
        await serveWeFile(req, res, filePath)
        return
      }
      // 资产路由：只允许裸文件名，无分隔符、无 '..'（路径穿越防护）
      const rel = pathname.slice('/bg/'.length)
      if (rel === '' || rel.includes('..') || rel.includes('/') || rel.includes('\\')) {
        res.writeHead(404)
        res.end()
        return
      }
      // 用户目录优先，随包资源兜底（老版本把上传图片放在包内 assets/，
      // 迁移时不删除包内文件，避免误删 git 跟踪的默认图）。
      const userPath = join(ASSETS_DIR, rel)
      const bundledPath = join(BUNDLED_ASSETS_DIR, rel)
      let filePath = null
      try {
        await access(userPath)
        filePath = userPath
      } catch {
        try {
          await access(bundledPath)
          filePath = bundledPath
        } catch {
          filePath = null
        }
      }
      if (filePath === null) {
        res.writeHead(404)
        res.end()
        return
      }
      await serveWeFile(req, res, filePath)
    },
  }), 'dsh-bg-beautify: /bg asset route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bg/upload',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const body = await readBody(req, MAX_UPLOAD)
      if (body === null) {
        json(res, 413, { error: 'file too large (max 25 MiB)' })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        json(res, 400, { error: 'invalid JSON' })
        return
      }
      const { name, data } = parsed ?? {}
      if (typeof name !== 'string' || typeof data !== 'string' || data === '') {
        json(res, 400, { error: 'name and data required' })
        return
      }
      // Decode: data URI ("data:<mime>;base64,<b64>") or raw base64.
      let buffer
      let ext
      const uriMatch = /^data:([^;,]*)?(?:;base64)?,(.*)$/s.exec(data)
      if (uriMatch !== null) {
        const mime = (uriMatch[1] ?? '').toLowerCase()
        ext = MIME_EXT[mime] ?? allowedExt(name) ?? '.png'
        buffer = Buffer.from(uriMatch[2] ?? '', 'base64')
      } else {
        ext = allowedExt(name) ?? '.png'
        buffer = Buffer.from(data, 'base64')
      }
      if (buffer.length === 0) {
        json(res, 400, { error: 'empty image data' })
        return
      }
      // 同名文件不再静默覆盖用户已有的背景图：已存在则自动追加 -2/-3 序号。
      await mkdir(ASSETS_DIR, { recursive: true })
      const fileName = uniquePath(ASSETS_DIR, safeName(name, ext))
      try {
        await writeFile(join(ASSETS_DIR, fileName), buffer)
      } catch {
        json(res, 500, { error: 'write failed' })
        return
      }
      json(res, 200, { url: `/bg/${fileName}` })
    },
  }), 'dsh-bg-beautify: /bg/upload route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bg/settings',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method === 'GET' || req.method === 'HEAD') {
        const settings = await readSettings()
        json(res, 200, settings)
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req, MAX_SETTINGS)
        if (body === null) {
          json(res, 413, { error: 'settings too large' })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          json(res, 400, { error: 'invalid JSON' })
          return
        }
        const sanitized = await writeSettings(parsed).catch(() => null)
        if (sanitized === null) {
          json(res, 500, { error: 'write failed' })
          return
        }
        json(res, 200, sanitized)
        return
      }
      res.writeHead(405)
      res.end()
    },
  }), 'dsh-bg-beautify: /bg/settings route')
}
