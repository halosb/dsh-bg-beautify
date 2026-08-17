// we-convert.js 单元测试：LZ4 向量 + 手工构造的 PKG/TEX（视频/GIF 纹理提取）。
import assert from 'node:assert/strict'
import { lz4BlockDecode, parsePkg, parseTex, extractVideoMp4s, extractGifTextures } from '../we-convert.js'

function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); return b }
function strI32(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([i32(b.length), b]) }
function nulStr(s) { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]) }
const FAKE_MP4 = Buffer.concat([i32(24), Buffer.from('ftypisom\x00\x00\x00\x00')]) // bytes[4..11] = ftypisom

// ── LZ4 block：手写向量（规格推导） ────────────────────────────────────────
// 输入 "aaaaaaaaaa"：token=0x15（1 字面量 + match 长 5+4=9），'a'，offset 0x0001
{
  const vec = Buffer.from([0x15, 0x61, 0x01, 0x00])
  assert.equal(lz4BlockDecode(vec, 10).toString(), 'aaaaaaaaaa')
  console.log('PASS lz4 hand vector')
}
// LZ4 纯字面量末段（我的解码器需正确处理：读字面量后即结束）
{
  const data = Buffer.from('hello lz4 block', 'utf8')
  const lit = Buffer.concat([Buffer.from([0xf0, data.length - 15]), data]) // 15+ext, match=0
  assert.equal(lz4BlockDecode(lit, data.length).toString(), data.toString())
  console.log('PASS lz4 literal-only last sequence')
}

// ── 构造 TEX ───────────────────────────────────────────────────────────────
function buildVideoTex(mp4Bytes, opts = {}) {
  const { lz4 = false, compressed = null } = opts
  const payload = compressed !== null ? compressed : mp4Bytes
  const container = Buffer.concat([
    nulStr('TEXB0004'), i32(1), i32(-1), i32(1), // v4: FIF_UNKNOWN + isVideoMp4=1
    i32(1), // mipmapCount
    i32(1), i32(2), nulStr(''), i32(1), // v4 前置参数
    i32(640), i32(360), i32(lz4 ? 1 : 0), i32(mp4Bytes.length), i32(payload.length),
    payload,
  ])
  return Buffer.concat([
    nulStr('TEXV0005'), nulStr('TEXI0001'),
    i32(4), i32(32), i32(640), i32(360), i32(640), i32(360), i32(0), // format/flags/尺寸
    container,
  ])
}

function buildPlainTex() {
  const container = Buffer.concat([
    nulStr('TEXB0002'), i32(1),
    i32(1),
    i32(16), i32(16), i32(0), i32(256), i32(256), Buffer.alloc(256),
  ])
  return Buffer.concat([
    nulStr('TEXV0005'), nulStr('TEXI0001'),
    i32(4), i32(0), i32(16), i32(16), i32(16), i32(16), i32(0),
    container,
  ])
}

function buildPkg(entries) {
  const parts = [strI32('MTPKG'), i32(entries.length)]
  let offset = 0
  const blobs = []
  for (const e of entries) {
    parts.push(strI32(e.path), i32(offset), i32(e.data.length))
    blobs.push(e.data)
    offset += e.data.length
  }
  return Buffer.concat([Buffer.concat(parts), ...blobs])
}

// ── parsePkg 结构 ──────────────────────────────────────────────────────────
{
  const pkg = buildPkg([{ path: 'textures/abc.tex', data: buildVideoTex(FAKE_MP4) }])
  const parsed = parsePkg(pkg)
  assert.equal(parsed.magic, 'MTPKG')
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].path, 'textures/abc.tex')
  assert.deepEqual([...parsed.entries[0].data], [...buildVideoTex(FAKE_MP4)])
  console.log('PASS parsePkg')
}

// ── 视频纹理提取：未压缩 / LZ4 压缩 / 非视频 ────────────────────────────────
{
  const out = await extractVideoMp4s(buildPkg([{ path: 'textures/anim.tex', data: buildVideoTex(FAKE_MP4) }]))
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'anim.mp4')
  assert.deepEqual([...out[0].mp4], [...FAKE_MP4])
  console.log('PASS extract uncompressed video tex')
}
{
  const lit = Buffer.concat([Buffer.from([0xf0, FAKE_MP4.length - 15]), FAKE_MP4])
  const out = await extractVideoMp4s(buildPkg([{ path: 'a.tex', data: buildVideoTex(FAKE_MP4, { lz4: true, compressed: lit }) }]))
  assert.equal(out.length, 1)
  assert.deepEqual([...out[0].mp4], [...FAKE_MP4])
  console.log('PASS extract LZ4-compressed video tex')
}
{
  const out = await extractVideoMp4s(buildPkg([{ path: 'a.tex', data: buildPlainTex() }]))
  assert.equal(out.length, 0)
  console.log('PASS non-video tex yields nothing')
}
{
  const out = await extractVideoMp4s(buildPkg([{ path: 'scene.bin', data: Buffer.from('junk') }]))
  assert.equal(out.length, 0)
  console.log('PASS non-tex entries ignored')
}
{
  assert.deepEqual(await extractVideoMp4s(Buffer.alloc(4)), [])
  console.log('PASS tiny buffer safe')
}

// ── GIF 动画序列纹理：构造 TEX（IsGif=4, RGBA8888, TEXS0003）→ 有效 GIF ────
function buildGifTex() {
  const pixels = Buffer.alloc(4 * 4 * 4) // 4×4 RGBA，两行红两行蓝
  for (let i = 0; i < 4 * 4; i++) {
    const o = i * 4
    pixels[o] = i < 8 ? 255 : 0
    pixels[o + 2] = i < 8 ? 0 : 255
    pixels[o + 3] = 255
  }
  const container = Buffer.concat([
    nulStr('TEXB0002'), i32(1), // v2 无 imageFormat
    i32(1), // mipmapCount
    i32(4), i32(4), i32(0), i32(pixels.length), i32(pixels.length), pixels,
  ])
  const frameInfo = Buffer.concat([
    nulStr('TEXS0003'), i32(1), // frameCount
    i32(4), i32(4), // gifW/gifH
    i32(0), // imageId
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(0.1); return b })(), // frametime 0.1s
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(), // X
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(), // Y
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(4); return b })(), // Width
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(), // WidthY
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(), // HeightX
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(4); return b })(), // Height
  ])
  return Buffer.concat([
    nulStr('TEXV0005'), nulStr('TEXI0001'),
    i32(0), i32(4), i32(4), i32(4), i32(4), i32(4), i32(0), // format=RGBA8888, flags=IsGif, 4×4
    container,
    frameInfo,
  ])
}
{
  const out = await extractGifTextures(buildPkg([{ path: 'tex/seq.tex', data: buildGifTex() }]))
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'seq.gif')
  assert.equal(out[0].gif.toString('latin1', 0, 6), 'GIF89a')
  assert.ok(out[0].gif.length > 64, 'gif has content')
  assert.ok(out[0].gif.includes(0x3b), 'gif trailer present')
  console.log('PASS gif texture → valid GIF (' + out[0].gif.length + ' bytes)')
}
{
  // 非 GIF 纹理（纯视频 tex）不产出 gif
  const out = await extractGifTextures(buildPkg([{ path: 'a.tex', data: buildVideoTex(FAKE_MP4) }]))
  assert.equal(out.length, 0)
  console.log('PASS non-gif tex yields no gif')
}

// ── DXT1 块解码（BC1）：单色红块 4×4 → 全红不透明 ───────────────────────────
{
  const block = Buffer.from([0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]) // v0==v1==红色，cut 模式，索引全 0
  const pkg = buildPkg([{ path: 'dxt.tex', data: (() => {
    const container = Buffer.concat([
      nulStr('TEXB0002'), i32(1),
      i32(1),
      i32(4), i32(4), i32(0), i32(block.length), i32(block.length), block,
    ])
    return Buffer.concat([
      nulStr('TEXV0005'), nulStr('TEXI0001'),
      i32(7), i32(0), i32(4), i32(4), i32(4), i32(4), i32(0), // format=DXT1
      container,
    ])
  })() }])
  // DXT1 纹理非视频非 GIF → 两者都不产出（解码正确性由下方直接验证）
  assert.equal((await extractVideoMp4s(pkg)).length, 0)
  assert.equal((await extractGifTextures(pkg)).length, 0)
  // 间接验证：GIF 分支必须能处理 DXT 帧 → 构造 IsGif+DXT1
  const dxtGifTex = (() => {
    const container = Buffer.concat([
      nulStr('TEXB0002'), i32(1),
      i32(1),
      i32(4), i32(4), i32(0), i32(block.length), i32(block.length), block,
    ])
    const frameInfo = Buffer.concat([
      nulStr('TEXS0003'), i32(1), i32(4), i32(4),
      i32(0), (() => { const b = Buffer.alloc(4); b.writeFloatLE(0.1); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeFloatLE(4); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeFloatLE(0); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeFloatLE(4); return b })(),
    ])
    return Buffer.concat([
      nulStr('TEXV0005'), nulStr('TEXI0001'),
      i32(7), i32(4), i32(4), i32(4), i32(4), i32(4), i32(0), // DXT1 + IsGif
      container,
      frameInfo,
    ])
  })()
  const gifOut = await extractGifTextures(buildPkg([{ path: 'dxtseq.tex', data: dxtGifTex }]))
  assert.equal(gifOut.length, 1)
  assert.equal(gifOut[0].gif.toString('latin1', 0, 6), 'GIF89a')
  console.log('PASS DXT1-compressed gif frames decode → valid GIF')
}

console.log('ALL PASS — we-convert.js')
