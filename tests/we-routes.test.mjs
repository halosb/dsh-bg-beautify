// Scratch end-to-end test for the Wallpaper Engine routes (NOT shipped).
// Builds a fake Steam library tree, mounts the plugin with a mock webServer,
// and exercises /bg/we/list, /bg/we/preview/<id>, /bg/we/media/<id>,
// path-traversal guards, and the unchanged /bg asset route.
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(PLUGIN_DIR, 'config.json')
const SCRATCH = join(PLUGIN_DIR, 'scratch-we')
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

// persist a manual wePath so media/preview routes resolve
await writeFile(CONFIG, JSON.stringify({ wePath: CONTENT }))

// ── mount plugin with a mock ctx ──────────────────────────────────────────
const routes = new Map()
const ctx = {
  effect(fn) { return fn() },
  webServer: {
    register(cfg) { routes.set(cfg.kind + ':' + cfg.path, cfg.handler) },
  },
}
const plugin = await import('../index.js')
plugin.apply(ctx)
const handler = routes.get('prefix:/bg')
assert.ok(handler !== null, 'prefix /bg handler registered')

function makeRes() {
  return {
    status: 200,
    headers: {},
    body: null,
    writeHead(s, h) { this.status = s; this.headers = h ?? {} },
    end(b) { this.body = b === undefined ? null : b },
  }
}
async function call(method, url, body) {
  const res = makeRes()
  let bodyBytes = null
  if (body !== undefined) bodyBytes = Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method,
    url,
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
  await handler(req, res)
  return res
}

// ── /bg/we/list ───────────────────────────────────────────────────────────
let r = await call('GET', '/bg/we/list?path=' + encodeURIComponent(CONTENT))
assert.equal(r.status, 200)
const list = JSON.parse(r.body.toString('utf8'))
assert.equal(list.ok, true)
assert.equal(list.library, CONTENT)
// 本机若装有真实 Steam + WE，列表会合并真实壁纸；只对模拟条目做存在性断言。
assert.ok(list.count >= 3, 'at least the fake wallpapers are present')
const video = list.wallpapers.find((w) => w.id === '1001')
const scene = list.wallpapers.find((w) => w.id === '1002')
const web = list.wallpapers.find((w) => w.id === '1003')
assert.ok(video !== undefined, 'fake video wallpaper found')
assert.ok(scene !== undefined, 'fake scene wallpaper found')
assert.ok(web !== undefined, 'fake web wallpaper found')
assert.equal(web.type, 'web')
assert.equal(web.supported, true)
assert.equal(web.mediaUrl, '/bg/we/web/1003/')
assert.equal(web.previewUrl, '/bg/we/preview/1003')
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
r = await call('POST', '/bg/we/convert') // 缺 id → 400
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
r = await call('POST', '/bg/we/list')
assert.equal(r.status, 405)
console.log('PASS asset route')

// ── cleanup ───────────────────────────────────────────────────────────────
await rm(CONFIG, { force: true })
await rm(SCRATCH, { recursive: true, force: true })
console.log('ALL PASS — scratch tree + config.json cleaned up')
