// Scratch end-to-end test for the Wallpaper Engine routes (NOT shipped).
// Builds a fake Steam library tree, mounts the plugin with a mock webServer,
// and exercises /bg/we/list, /bg/we/preview/<id>, /bg/we/media/<id>,
// path-traversal guards, and the unchanged /bg asset route.
import { mkdir, writeFile, readdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import assert from 'node:assert/strict'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
// 所有落盘路径必须重定向到临时目录。原来 CONFIG 直接指向插件目录里的
// 真实 config.json，测试结束还会把它 rm 掉——在已安装副本里跑测试等于删用户设置。
const SCRATCH = join(tmpdir(), 'dsh-bg-beautify-test-' + process.pid)
process.env.DSH_HOME = join(SCRATCH, 'dsh-home')
process.env.DSH_PROFILE = 'test'
process.env.USERPROFILE = join(SCRATCH, 'profile')
process.env.HOME = process.env.USERPROFILE
const DATA_DIR = join(process.env.DSH_HOME, 'plugin-data', 'test', 'dsh-bg-beautify')
const CONFIG = join(DATA_DIR, 'config.json')
const ASSETS = join(DATA_DIR, 'assets')
const STEAM = join(SCRATCH, 'Steam', 'steamapps')
const CONTENT = join(STEAM, 'workshop', 'content', '431960')

// ── fake tree ─────────────────────────────────────────────────────────────
await mkdir(join(CONTENT, '1001'), { recursive: true })
await mkdir(join(CONTENT, '1002'), { recursive: true })
await writeFile(join(CONTENT, '1001', 'project.json'), JSON.stringify({
  title: 'Aurora Drift', type: 'video', file: 'scene.mp4',
  general: { preview: 'preview.jpg' },
}))
await writeFile(join(CONTENT, '1001', 'scene.mp4'), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])) // fake mp4 header
await writeFile(join(CONTENT, '1001', 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
await writeFile(join(CONTENT, '1002', 'project.json'), JSON.stringify({
  title: 'Scene Only', type: 'scene', file: 's.pkg',
}))
await writeFile(join(CONTENT, '1002', 's.pkg'), Buffer.from([9, 9, 9]))
await writeFile(join(CONTENT, '1002', 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]))
await mkdir(join(CONTENT, '1003'), { recursive: true })
await mkdir(join(CONTENT, '1003', 'assets'), { recursive: true })
await writeFile(join(CONTENT, '1003', 'project.json'), JSON.stringify({
  title: 'Web One', type: 'web', file: 'index.html',
}))
await writeFile(join(CONTENT, '1003', 'index.html'),
  '<!doctype html><html><head><title>t</title></head><body>hello <b>web</b></body></html>')
await writeFile(join(CONTENT, '1003', 'assets', 'bg.png'), Buffer.from([1, 2, 3, 4]))
await writeFile(join(CONTENT, '1003', 'evil.exe'), Buffer.from([0x4d, 0x5a]))
await writeFile(join(CONTENT, '1003', 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 8, 9]))
// 1004：含 GIF 动画序列纹理的场景（scene.pkg 内嵌一个 IsGif TEX）→ 应标记可转换
function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); return b }
function strI32(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([i32(b.length), b]) }
function nulStr(s) { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]) }
function f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v); return b }
await mkdir(join(CONTENT, '1004'), { recursive: true })
await writeFile(join(CONTENT, '1004', 'project.json'), JSON.stringify({
  title: 'Gif Scene', type: 'scene', file: 'scene.json',
}))
{
  const pixels = Buffer.alloc(64)
  for (let i = 0; i < 16; i++) { pixels[i * 4] = 255; pixels[i * 4 + 3] = 255 }
  const tex = Buffer.concat([
    nulStr('TEXV0005'), nulStr('TEXI0001'),
    i32(0), i32(4), i32(4), i32(4), i32(4), i32(4), i32(0),
    nulStr('TEXB0002'), i32(1), i32(1), i32(4), i32(4), i32(0), i32(64), i32(64), pixels,
    nulStr('TEXS0003'), i32(1), i32(4), i32(4), i32(0), f32(0.1), f32(0), f32(0), f32(4), f32(0), f32(0), f32(4),
  ])
  const pkg = Buffer.concat([strI32('MTPKG'), i32(1), strI32('textures/seq.tex'), i32(0), i32(tex.length), tex])
  await writeFile(join(CONTENT, '1004', 'scene.pkg'), pkg)
}
await writeFile(join(CONTENT, '1004', 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 8, 9]))

// persist a manual wePath so media/preview routes resolve
await mkdir(DATA_DIR, { recursive: true })
await writeFile(CONFIG, JSON.stringify({ wePath: CONTENT }))

// ── mount plugin with a mock ctx ──────────────────────────────────────────
const routes = new Map()
const ctx = {
  effect(fn) { return fn() },
  get() { return undefined }, // 没有 connection 服务 → 走插件自带的回环栅栏
  webServer: {
    register(cfg) { routes.set(cfg.kind + ':' + cfg.path, cfg.handler) },
  },
}
const plugin = await import('../index.js')
plugin.apply(ctx)
const handler = routes.get('prefix:/bg')
const uploadHandler = routes.get('exact:/bg/upload')
const settingsHandler = routes.get('exact:/bg/settings')
assert.ok(handler !== null, 'prefix /bg handler registered')
assert.ok(uploadHandler !== null, 'upload handler registered')
assert.ok(settingsHandler !== null, 'settings handler registered')

// 真实的 http.ServerResponse 是可写流（serveWeFile 现在用 stream.pipe 流式发送，
// 并支持 Range），所以 mock 也必须是 Writable。
function makeRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() },
  })
  res.status = 200
  res.headers = {}
  Object.defineProperty(res, 'body', {
    get() { return chunks.length === 0 ? null : Buffer.concat(chunks) },
  })
  res.writeHead = function (s, h) { this.status = s; this.headers = h ?? {} }
  return res
}
async function call(method, url, body, extraHeaders) {
  return callOn(handler, method, url, body, extraHeaders)
}
async function callOn(target, method, url, body, extraHeaders) {
  const res = makeRes()
  let bodyBytes = null
  if (body !== undefined) bodyBytes = Buffer.from(JSON.stringify(body), 'utf8')
  const headers = Object.assign({ host: '127.0.0.1:3080' }, extraHeaders ?? {})
  if (bodyBytes !== null && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    destroy() {},
    [Symbol.asyncIterator]() {
      let sent = bodyBytes === null
      return {
        next: async () => {
          if (sent) return { done: true }
          sent = true
          return { done: false, value: bodyBytes }
        },
      }
    },
  }
  await target(req, res)
  return res
}

// ── /bg/we/list ───────────────────────────────────────────────────────────
// ?auto=0：关闭扫描自动转换（避免测试把真实库也转一遍）
let r = await call('GET', '/bg/we/list?auto=0&path=' + encodeURIComponent(CONTENT))
assert.equal(r.status, 200)
const list = JSON.parse(r.body.toString('utf8'))
assert.equal(list.ok, true)
assert.equal(list.library, CONTENT)
// 本机若装有真实 Steam + WE，列表会合并真实壁纸；只对模拟条目做存在性断言。
assert.ok(list.count >= 4, 'at least the fake wallpapers are present')
assert.ok(!list.autoJob, 'auto=0 disables auto-convert (autoJob falsy)')
const video = list.wallpapers.find((w) => w.id === '1001')
const scene = list.wallpapers.find((w) => w.id === '1002')
const web = list.wallpapers.find((w) => w.id === '1003')
const gifScene = list.wallpapers.find((w) => w.id === '1004')
assert.ok(video !== undefined, 'fake video wallpaper found')
assert.ok(scene !== undefined, 'fake scene wallpaper found')
assert.ok(web !== undefined, 'fake web wallpaper found')
assert.ok(gifScene !== undefined, 'fake gif scene wallpaper found')
assert.equal(web.type, 'web')
assert.equal(web.supported, true)
assert.equal(web.mediaUrl, '/bg/we/web/1003/')
assert.equal(web.previewUrl, '/bg/we/preview/1003')
// 可转换性探测：1004（含 GIF 纹理）→ true；1002（垃圾 pkg）→ false
assert.equal(gifScene.type, 'scene')
assert.equal(gifScene.convertible, true, 'gif scene is convertible')
assert.equal(scene.convertible, false, 'junk pkg scene not convertible')
assert.equal(video.title, 'Aurora Drift')
assert.equal(video.type, 'video')
assert.equal(video.supported, true)
assert.equal(video.mediaUrl, '/bg/we/media/1001')
assert.equal(video.previewUrl, '/bg/we/preview/1001')
assert.equal(scene.supported, false)
assert.equal(scene.mediaUrl, '')
assert.ok(scene.reason.length > 0)
console.log('PASS /bg/we/list')

// ── /bg/we/preview/<id> ───────────────────────────────────────────────────
r = await call('GET', '/bg/we/preview/1001')
assert.equal(r.status, 200)
assert.equal(r.headers['content-type'], 'image/jpeg')
assert.deepEqual([...r.body], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
r = await call('HEAD', '/bg/we/preview/1001')
assert.equal(r.status, 200)
console.log('PASS /bg/we/preview')

// ── /bg/we/media/<id> ─────────────────────────────────────────────────────
r = await call('GET', '/bg/we/media/1001')
assert.equal(r.status, 200)
assert.equal(r.headers['content-type'], 'video/mp4')
assert.deepEqual([...r.body], [0, 0, 0, 24, 102, 116, 121, 112])
// scene wallpaper media must be refused (not browser-usable)
r = await call('GET', '/bg/we/media/1002')
assert.equal(r.status, 404)
// unknown id
r = await call('GET', '/bg/we/media/9999')
assert.equal(r.status, 404)
console.log('PASS /bg/we/media')

// ── /bg/we/web/<id>/ — web wallpaper static serving + shim ─────────────────
r = await call('GET', '/bg/we/web/1003/')
assert.equal(r.status, 200)
assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
const html = r.body.toString('utf8')
assert.ok(html.includes('<body>hello <b>web</b></body>'), 'original html preserved')
assert.ok(html.includes('wallpaperRegisterListener'), 'WE shim injected')
r = await call('GET', '/bg/we/web/1003') // 无尾斜杠也走入口页
assert.equal(r.status, 200)
r = await call('HEAD', '/bg/we/web/1003/')
assert.equal(r.status, 200)
r = await call('GET', '/bg/we/web/1003/assets/bg.png')
assert.equal(r.status, 200)
assert.equal(r.headers['content-type'], 'image/png')
assert.deepEqual([...r.body], [1, 2, 3, 4])
r = await call('GET', '/bg/we/web/1003/preview.jpg') // 白名单内的图可伺服
assert.equal(r.status, 200)
assert.equal(r.headers['content-type'], 'image/jpeg')
r = await call('GET', '/bg/we/web/1003/evil.exe') // 非白名单扩展名拒绝
assert.equal(r.status, 404)
r = await call('GET', '/bg/we/web/1003/%2E%2E%2F%2E%2E%2Fpackage.json') // 编码穿越被 URL 规范化，无法逃出 WE 库
assert.equal(r.status, 404)
r = await call('GET', '/bg/we/web/9999/')
assert.equal(r.status, 404)
console.log('PASS /bg/we/web')

// ── extractWorkshopVideo 纯函数单测（Steam 社区不可达时的防御验证） ────────
{
  const ex = plugin.extractWorkshopVideo
  assert.equal(ex(''), null)
  assert.equal(ex('<html>no video here</html>'), null)
  assert.equal(ex('g_rgFullwidthPreviews = [{"url":"https://cdn.example.com/preview.webm","thumbnail":"x.jpg"}];'),
    'https://cdn.example.com/preview.webm')
  assert.equal(ex('<video controls><source src="https://video.steamstatic.com/a/b.mp4?t=1" type="video/mp4"></video>'),
    'https://video.steamstatic.com/a/b.mp4?t=1')
  assert.equal(ex('window.movie_mp4 = "https://cdn.example.com/movie.mp4"'), 'https://cdn.example.com/movie.mp4')
  // mp4 优先于 webm
  assert.equal(ex('[{"url":"https://x.com/a.webm"},{"url":"https://x.com/b.mp4"}]'), 'https://x.com/b.mp4')
  console.log('PASS extractWorkshopVideo')
}

// ── /bg/we/video/<id> — 场景型壁纸预览视频（本机 Steam 社区不可达 → ok:false）──
r = await call('GET', '/bg/we/video/1002') // scene 壁纸；网络不通走失败分支（约 6s 超时）
assert.equal(r.status, 200)
const v = JSON.parse(r.body.toString('utf8'))
assert.equal(v.ok, false)
assert.ok(typeof v.message === 'string' && v.message.length > 0)
r = await call('GET', '/bg/we/video/9999')
assert.equal(r.status, 404)
r = await call('GET', '/bg/we/video/%2E%2E')
assert.equal(r.status, 404)
console.log('PASS /bg/we/video (offline path)')

// ── 转换视频库：列表 / 文件伺服 / 转换失败路径 / 方法守卫 ────────────────────
const convDir = (process.env.USERPROFILE || process.env.HOME || '')
  ? join(process.env.USERPROFILE || process.env.HOME, 'Pictures', 'dsh-bg-beautify', 'we-converted')
  : join(PLUGIN_DIR, 'converted')
r = await call('GET', '/bg/we/converted')
assert.equal(r.status, 200)
let cv = JSON.parse(r.body.toString('utf8'))
assert.equal(cv.ok, true)
assert.ok(Array.isArray(cv.files))
r = await call('GET', '/bg/we/openfolder') // 只验证方法守卫，不真正打开资源管理器
assert.equal(r.status, 405)
r = await call('POST', '/bg/we/convert', {}) // 缺 id → 400
assert.equal(r.status, 400)
// 启动转换作业（1002 场景无视频/GIF 纹理 → 作业最终 error，轮询验证进度）
r = await call('POST', '/bg/we/convert', { id: '1002' })
assert.equal(r.status, 200)
cv = JSON.parse(r.body.toString('utf8'))
assert.equal(cv.ok, true)
assert.ok(typeof cv.job === 'string' && cv.job.startsWith('conv'), 'job id returned')
const jobId = cv.job
let finalJob = null
for (let i = 0; i < 200; i++) {
  const jr = await call('GET', '/bg/we/job?id=' + encodeURIComponent(jobId))
  assert.equal(jr.status, 200)
  finalJob = JSON.parse(jr.body.toString('utf8'))
  if (finalJob.state === 'done' || finalJob.state === 'error') break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
assert.ok(finalJob !== null && finalJob.ok === true, 'job pollable')
assert.equal(finalJob.state, 'error') // 1002 无视频/GIF 纹理
assert.ok((finalJob.message || '').includes('纹理'), 'message explains missing textures')
r = await call('GET', '/bg/we/job?id=nope')
assert.equal(r.status, 200)
assert.equal(JSON.parse(r.body.toString('utf8')).ok, false)
// 1004（含 GIF 纹理）手动转换 → 产出 GIF 文件（与自动转换同一条提取/写入路径）
r = await call('POST', '/bg/we/convert', { id: '1004' })
assert.equal(r.status, 200)
cv = JSON.parse(r.body.toString('utf8'))
assert.ok(typeof cv.job === 'string')
let job2 = null
for (let i = 0; i < 300; i++) {
  const jr = await call('GET', '/bg/we/job?id=' + encodeURIComponent(cv.job))
  job2 = JSON.parse(jr.body.toString('utf8'))
  if (job2.state === 'done' || job2.state === 'error') break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
if (job2 !== null && job2.state !== 'done') console.error('DIAG job2 =', JSON.stringify(job2))
assert.ok(job2 !== null && job2.state === 'done', 'gif scene converts')
assert.ok(Array.isArray(job2.files) && job2.files.length > 0)
assert.ok(job2.files[0].name.endsWith('.gif'), 'produced a gif')
// 清理测试产物（1004-* 前缀）
for (const n of await readdir(convDir)) {
  if (n.startsWith('1004-')) await rm(join(convDir, n), { force: true })
}
const fakeVid = 'test-convert-check.mp4'
await mkdir(convDir, { recursive: true })
await writeFile(join(convDir, fakeVid), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
r = await call('GET', '/bg/conv/' + encodeURIComponent(fakeVid))
assert.equal(r.status, 200)
assert.equal(r.headers['content-type'], 'video/mp4')
r = await call('GET', '/bg/conv/..%2Fconfig.json')
assert.equal(r.status, 404)
r = await call('GET', '/bg/conv/%2E%2E')
assert.equal(r.status, 404)
await rm(join(convDir, fakeVid), { force: true })
console.log('PASS convert library')

// ── traversal / bad ids ───────────────────────────────────────────────────
for (const bad of ['..%2F..%2Fetc%2Fpasswd', '..%5C..%5Cboot.ini', '%2E%2E', 'a%2Fb']) {
  r = await call('GET', '/bg/we/media/' + bad)
  assert.equal(r.status, 404, 'traversal must 404: ' + bad)
  r = await call('GET', '/bg/we/preview/' + bad)
  assert.equal(r.status, 404, 'traversal must 404: ' + bad)
}
console.log('PASS traversal guards')

// ── asset route unchanged ─────────────────────────────────────────────────
r = await call('GET', '/bg/1.png')
assert.equal(r.status, 200)
assert.equal(r.headers['content-type'], 'image/png')
r = await call('GET', '/bg/1.png/../config.json')
assert.equal(r.status, 404)
r = await call('GET', '/bg/../package.json')
assert.equal(r.status, 404)
r = await call('POST', '/bg/we/list', {}) // 方法守卫：列表只接受 GET
assert.equal(r.status, 405)
console.log('PASS asset route')

// ── 新增：请求准入（原来所有路由零鉴权） ───────────────────────────────────
r = await call('GET', '/bg/settings', undefined, { host: 'evil.example.com' })
assert.equal(r.status, 403, 'non-loopback Host must be rejected')
r = await call('GET', '/bg/settings', undefined, { 'sec-fetch-site': 'cross-site' })
assert.equal(r.status, 403, 'cross-site marker must be rejected')
r = await call('GET', '/bg/settings', undefined, { origin: 'http://evil.example.com' })
assert.equal(r.status, 403, 'cross-origin Origin must be rejected')
r = await callOn(settingsHandler, 'POST', '/bg/settings', undefined, { 'content-type': 'text/plain' })
assert.equal(r.status, 415, 'POST without JSON content-type must be rejected')
console.log('PASS request admission')

// ── 新增：设置写入是合并 + 原子 + 缓存 ─────────────────────────────────────
r = await callOn(settingsHandler, 'POST', '/bg/settings', { opacityMain: 0.5 })
assert.equal(r.status, 200)
let saved = JSON.parse(r.body.toString('utf8'))
assert.equal(saved.opacityMain, 0.5)
assert.equal(saved.opacitySidebar, 0.5, 'unsent fields keep their previous value (merge, not reset)')
r = await callOn(settingsHandler, 'POST', '/bg/settings', { wePath: CONTENT })
saved = JSON.parse(r.body.toString('utf8'))
assert.equal(saved.opacityMain, 0.5, 'merge keeps earlier change')
assert.equal(saved.wePath, CONTENT)
const onDisk = JSON.parse(await readFile(CONFIG, 'utf8'))
assert.equal(onDisk.wePath, CONTENT)
assert.equal(onDisk.opacityMain, 0.5)
console.log('PASS settings merge + atomic write')

// ── 新增：上传同名不再静默覆盖 ─────────────────────────────────────────────
const pngData = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
r = await callOn(uploadHandler, 'POST', '/bg/upload', { name: 'wall.png', data: pngData })
assert.equal(r.status, 200)
const firstUrl = JSON.parse(r.body.toString('utf8')).url
r = await callOn(uploadHandler, 'POST', '/bg/upload', { name: 'wall.png', data: pngData })
assert.equal(r.status, 200)
const secondUrl = JSON.parse(r.body.toString('utf8')).url
assert.notEqual(firstUrl, secondUrl, 'second upload with the same name must not overwrite the first')
// 迁移会把随包的 assets/1.png 复制进来，所以只数本次上传的两个
assert.equal((await readdir(ASSETS)).filter((n) => n.startsWith('wall')).length, 2)
console.log('PASS upload does not overwrite')

// ── 新增：媒体 Range 请求（视频壁纸 seek） ─────────────────────────────────
r = await call('GET', '/bg/we/media/1001', undefined, { range: 'bytes=2-5' })
assert.equal(r.status, 206, 'range request returns 206')
assert.equal(r.headers['content-range'], 'bytes 2-5/8')
assert.deepEqual([...r.body], [0, 24, 102, 116]) // 文件 8 字节：0,0,0,24,102,116,121,112
r = await call('GET', '/bg/we/media/1001')
assert.equal(r.headers['accept-ranges'], 'bytes')
console.log('PASS media range')

// ── 新增：过期作业明确结束轮询（客户端不再无限 400ms 轮询） ────────────────
r = await call('GET', '/bg/we/job?id=conv-does-not-exist')
const gone = JSON.parse(r.body.toString('utf8'))
assert.equal(gone.ok, false)
assert.equal(gone.expired, true, 'missing job reports expired')
console.log('PASS expired job signal')

// ── 新增：SVG 伺服带 CSP（作为独立文档打开时不执行脚本） ───────────────────
await mkdir(ASSETS, { recursive: true })
await writeFile(join(ASSETS, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
r = await call('GET', '/bg/x.svg')
assert.equal(r.status, 200)
assert.ok(String(r.headers['content-security-policy'] ?? '').includes("default-src 'none'"), 'svg gets a locked-down CSP')
assert.equal(r.headers['x-content-type-options'], 'nosniff')
console.log('PASS svg hardening')

// ── cleanup ───────────────────────────────────────────────────────────────
await rm(SCRATCH, { recursive: true, force: true })
console.log('ALL PASS — 全部落在临时目录，用户真实 config.json / 图片未被触碰')
