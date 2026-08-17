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
import { readFile, writeFile, readdir, access, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractVideoMp4s, extractGifTextures, probeTextures } from './we-convert.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const name = 'dsh-bg-beautify'

/** The webserver service is a hard dependency: every route lives on it. */
export const inject = ['webServer']

/** This package's assets directory (realpath through the profile link). */
const ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url))

/** This package's persisted settings file. */
const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url))

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

/** Read the persisted settings, or the defaults when absent/corrupt. */
async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    return sanitizeSettings(parsed)
  } catch {
    return Object.assign({}, DEFAULT_CONFIG)
  }
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
    if (size > cap) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
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

/** Every Steam library's steamapps directory this machine can see. */
async function detectSteamAppsDirs() {
  const dirs = new Set()
  function addSteam(steamDir) {
    if (typeof steamDir !== 'string' || steamDir === '') return
    const apps = join(steamDir, 'steamapps')
    if (existsSync(apps)) dirs.add(apps)
    const vdf = join(steamDir, 'steamapps', 'libraryfolders.vdf')
    if (existsSync(vdf)) {
      try {
        for (const p of vdfLibraryPaths(readFileSync(vdf, 'utf8'))) {
          const lib = p.replace(/[\\/]+$/, '')
          dirs.add(/steamapps$/i.test(lib) ? lib : join(lib, 'steamapps'))
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
  return [...dirs]
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
  async function addFolder(folder, id) {
    if (await isWallpaperFolder(folder) && !folders.has(folder)) folders.set(folder, id)
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

/** 探测场景包是否含视频纹理 / 动画序列（只读头部、不解码像素）。 */
async function probeConvertible(folder) {
  const cached = convertProbeCache.get(folder)
  if (cached !== undefined) return cached
  const result = { video: false, gif: false }
  try {
    const pkgName = await resolvePkgFile(folder)
    if (pkgName !== null) {
      const pkgBuf = await readFile(join(folder, pkgName))
      Object.assign(result, probeTextures(pkgBuf))
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

/** Serve one WE file (media or preview) with HEAD support. */
function serveWeFile(req, res, filePath) {
  return readFile(filePath).then((body) => {
    const dot = filePath.lastIndexOf('.')
    const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()
    res.writeHead(200, {
      'content-type': MEDIA_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  }).catch(() => {
    res.writeHead(404)
    res.end()
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
    let existing = []
    try { existing = await readdir(CONVERT_DIR) } catch { /* 目录可能不存在 */ }
    for (const w of wallpapers) {
      if (w.type === 'scene' && w.convertible === true && !existing.some((n) => n.startsWith(w.id + '-'))) {
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
    spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', 'Start-Process explorer.exe -ArgumentList ' + JSON.stringify(CONVERT_DIR),
    ], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
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
    json(res, 200, { ok: false, message: '作业不存在或已过期' })
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
  // 上限保留最近 5 个作业，避免内存膨胀
  if (convertJobs.size > 5) {
    const oldest = convertJobs.keys().next().value
    convertJobs.delete(oldest)
  }

  void (async () => {
    try {
      const pkgBuf = await readFile(pkgPath)
      job.message = '提取视频纹理…'
      const videos = await extractVideoMp4s(pkgBuf, (done, total) => {
        job.progress = total > 0 ? Math.round((done / total) * 50) : 0
      })
      job.message = '转换动画序列（GIF）…'
      const gifs = await extractGifTextures(pkgBuf, (done, total) => {
        job.progress = total > 0 ? Math.round(50 + (done / total) * 50) : 50
      })
      const items = [...videos, ...gifs]
      if (items.length === 0) {
        job.state = 'error'
        job.message = '该场景没有可提取的视频纹理或动画序列（纯 3D/粒子场景，内置转换无果）'
        job.progress = 100
        return
      }
      job.message = '写入转换文件夹…'
      job.progress = 95
      const added = []
      let n = 0
      for (const item of items) {
        const isGif = item.gif !== undefined
        const buf = isGif ? item.gif : item.mp4
        const stem = `${id}-${title}${items.length > 1 ? '-' + (++n) : ''}`
        const dest = join(CONVERT_DIR, uniquePath(CONVERT_DIR, safeConvertName(stem, isGif ? '.gif' : '.mp4')))
        try {
          await writeFile(dest, buf)
          added.push({ name: basename(dest), url: '/bg/conv/' + encodeURIComponent(basename(dest)) })
        } catch { /* 单个失败继续 */ }
      }
      job.progress = 100
      if (added.length === 0) {
        job.state = 'error'
        job.message = '转换完成但写入失败'
      } else {
        job.state = 'done'
        job.message = `转换完成：${added.length} 个（视频/动画）`
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
  const pkgBuf = await readFile(join(folder, pkgName))
  const items = [...(await extractVideoMp4s(pkgBuf)), ...(await extractGifTextures(pkgBuf))]
  if (items.length === 0) return null
  const title = proj !== null && typeof proj.title === 'string' && proj.title.trim() !== ''
    ? proj.title.trim().slice(0, 60) : id
  const added = []
  let n = 0
  for (const item of items) {
    const isGif = item.gif !== undefined
    const buf = isGif ? item.gif : item.mp4
    const stem = `${id}-${title}${items.length > 1 ? '-' + (++n) : ''}`
    const dest = join(CONVERT_DIR, uniquePath(CONVERT_DIR, safeConvertName(stem, isGif ? '.gif' : '.mp4')))
    try {
      await writeFile(dest, buf)
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
  if (convertJobs.size > 5) {
    const oldest = convertJobs.keys().next().value
    convertJobs.delete(oldest)
  }
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
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/bg',
    handler: async (req, res) => {
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
      const filePath = join(ASSETS_DIR, rel)
      const normalized = normalize(filePath)
      if (!normalized.startsWith(ASSETS_DIR)) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const body = await readFile(filePath)
        const dot = filePath.lastIndexOf('.')
        const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        })
        if (req.method === 'HEAD') res.end()
        else res.end(body)
      } catch {
        res.writeHead(404)
        res.end()
      }
    },
  }), 'dsh-bg-beautify: /bg asset route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bg/upload',
    handler: async (req, res) => {
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
      const fileName = safeName(name, ext)
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
        const sanitized = sanitizeSettings(parsed)
        try {
          await writeFile(CONFIG_PATH, JSON.stringify(sanitized, null, 2))
        } catch {
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
