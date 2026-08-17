// we-convert.js — RePKG 的 Node 原生移植（仅"视频纹理→mp4"提取路径）。
//
// 参考 notscuffed/repkg (MIT) 的格式解析：
//   PKG 容器：magic(I32 前缀字符串) + entryCount(i32) + 条目表
//     { path(I32 前缀字符串), offset(i32, 相对数据区), length(i32) } + 数据区(dataStart+offset)
//   TEX 文件："TEXV0005\0" + "TEXI0001\0" + header(6×i32: format/flags/texW/texH/imgW/imgH/unk)
//     + 图像容器("TEXB000X\0" + imageCount + [v3:format i32 | v4:format i32 + isVideoMp4 i32]
//       + 每图像: mipmapCount + 每 mipmap(v2/v3: w,h,lz4,outSize,bytes |
//         v4: 1,2,conditionJson\0,1,w,h,lz4,outSize,bytes))
//   flags: IsGif=4, IsVideoTexture=32；FreeImageFormat: FIF_UNKNOWN=-1, FIF_MP4=35
//
// 视频纹理：第一个图像的第一个 mipmap 的字节就是内嵌 mp4（LZ4 压缩先解压），
// 校验 ftyp 魔数后原样输出——与 repkg 的输出完全一致。纯 3D/粒子场景无视频
// 纹理，本模块返回空（那部分才需要外部 repkg.exe 或 WE 渲染器）。

const MP4_MAGICS = ['ftypisom', 'ftypmsnv', 'ftypmp42']

/** LZ4 block 解压（原始块格式，无 frame 头；K4os 的 LZ4Codec.Decode 同格式）。 */
export function lz4BlockDecode(src, outSize) {
  const out = Buffer.alloc(outSize)
  let ip = 0
  let op = 0
  while (ip < src.length) {
    const token = src[ip++]
    let litLen = token >> 4
    if (litLen === 15) {
      let b
      do { b = src[ip++]; litLen += b } while (b === 255)
    }
    if (litLen > 0) {
      src.copy(out, op, ip, ip + litLen)
      ip += litLen
      op += litLen
    }
    if (ip >= src.length) break // 末段可能只有字面量
    const offset = src[ip] | (src[ip + 1] << 8)
    ip += 2
    let matchLen = (token & 0x0f) + 4
    if ((token & 0x0f) === 15) {
      let b
      do { b = src[ip++]; matchLen += b } while (b === 255)
    }
    if (offset === 0 || offset > op) break // 坏数据保护
    for (let i = 0; i < matchLen; i++) out[op + i] = out[op + i - offset]
    op += matchLen
  }
  return out
}

function readI32(buf, off) {
  return buf.readInt32LE(off)
}

/** I32 前缀字符串：i32 长度 + UTF-8 字节。 */
function readStrI32(buf, off) {
  const n = readI32(buf, off)
  if (n < 0 || off + 4 + n > buf.length) throw new Error('bad i32 string')
  return { v: buf.toString('utf8', off + 4, off + 4 + n), next: off + 4 + n }
}

/** NUL 结尾字符串（读完 NUL）。 */
function readNulStr(buf, off, max) {
  let end = off
  while (end < buf.length && buf[end] !== 0 && (max === undefined || end - off < max)) end++
  return { v: buf.toString('utf8', off, end), next: Math.min(end + 1, buf.length) }
}

/** 解析 PKG 容器；entries 带 path/offset/length/data。 */
export function parsePkg(buf) {
  let off = 0
  const magic = readStrI32(buf, off)
  off = magic.next
  const entryCount = readI32(buf, off)
  off += 4
  const entries = []
  for (let i = 0; i < entryCount; i++) {
    const p = readStrI32(buf, off)
    off = p.next
    const offset = readI32(buf, off)
    off += 4
    const length = readI32(buf, off)
    off += 4
    entries.push({ path: p.v, offset, length })
  }
  const dataStart = off
  for (const e of entries) {
    const s = dataStart + e.offset
    e.data = s >= 0 && s + e.length <= buf.length ? buf.subarray(s, s + e.length) : Buffer.alloc(0)
  }
  return { magic: magic.v, entries }
}

/** 解析 TEX；仅保留转换所需字段；非 TEX 或解析失败返回 null。 */
export function parseTex(buf) {
  let off = 0
  const m1 = readNulStr(buf, off, 16)
  off = m1.next
  if (m1.v !== 'TEXV0005') return null
  const m2 = readNulStr(buf, off, 16)
  off = m2.next
  if (m2.v !== 'TEXI0001') return null
  const format = readI32(buf, off)
  const flags = readI32(buf, off + 4)
  off += 28 // format/flags/texW/texH/imgW/imgH/unk = 7×i32
  const cm = readNulStr(buf, off, 16)
  off = cm.next
  const imageCount = readI32(buf, off)
  off += 4
  const vm = /^TEXB000([1-4])$/.exec(cm.v)
  if (vm === null) return null
  let version = Number(vm[1])
  let imageFormat = -1
  if (version === 3) {
    imageFormat = readI32(buf, off)
    off += 4
  } else if (version === 4) {
    const fmt = readI32(buf, off)
    const isVideo = readI32(buf, off + 4)
    off += 8
    imageFormat = fmt === -1 && isVideo === 1 ? 35 : fmt // FIF_MP4=35
    if (imageFormat !== 35) version = 3
  }
  const images = []
  for (let i = 0; i < imageCount; i++) {
    const mipmapCount = readI32(buf, off)
    off += 4
    const mipmaps = []
    for (let j = 0; j < mipmapCount; j++) {
      let width = 0
      let height = 0
      let lz4 = false
      let outSize = 0
      if (version === 1) {
        width = readI32(buf, off)
        height = readI32(buf, off + 4)
        off += 8
      } else if (version === 2 || version === 3) {
        width = readI32(buf, off)
        height = readI32(buf, off + 4)
        lz4 = readI32(buf, off + 8) === 1
        outSize = readI32(buf, off + 12)
        off += 16
      } else if (version === 4) {
        off += 8 // param1=1, param2=2
        const cj = readNulStr(buf, off)
        off = cj.next
        off += 4 // param3=1
        width = readI32(buf, off)
        height = readI32(buf, off + 4)
        lz4 = readI32(buf, off + 8) === 1
        outSize = readI32(buf, off + 12)
        off += 16
      }
      const n = readI32(buf, off)
      off += 4
      mipmaps.push({
        width,
        height,
        lz4,
        outSize,
        bytes: n > 0 && off + n <= buf.length ? buf.subarray(off, off + n) : Buffer.alloc(0),
      })
      off += n
    }
    images.push({ mipmaps })
  }
  // GIF 动画序列纹理：图像容器之后是 TEXS 帧容器
  let frames = null
  if ((flags & 4) !== 0 && off < buf.length) {
    frames = parseFrameInfo(buf, off)
  }
  return { format, flags, imageFormat, version, images, frames }
}

/**
 * 从场景 PKG 提取全部视频纹理 mp4。
 * @param {Buffer} pkgBuf
 * @param {(done: number, total: number) => void} [onProgress] 逐条目进度回调
 * @returns {Promise<Array<{name: string, mp4: Buffer}>>} 空数组 = 无内嵌视频纹理。
 */
export async function extractVideoMp4s(pkgBuf, onProgress) {
  if (!Buffer.isBuffer(pkgBuf) || pkgBuf.length < 16) return []
  let pkg
  try {
    pkg = parsePkg(pkgBuf)
  } catch {
    return []
  }
  const entries = pkg.entries
  const out = []
  for (let i = 0; i < entries.length; i++) {
    if (i % 4 === 0) await new Promise((r) => setImmediate(r)) // 让事件循环回应进度轮询
    if (onProgress !== undefined) onProgress(i + 1, entries.length)
    const e = entries[i]
    if (!/\.tex$/i.test(e.path) || e.data.length < 8) continue
    let tex
    try {
      tex = parseTex(e.data)
    } catch {
      continue
    }
    if (tex === null) continue
    const isVideo = (tex.flags & 32) !== 0 || tex.imageFormat === 35
    if (!isVideo) continue
    const first = tex.images[0] && tex.images[0].mipmaps[0]
    if (first === undefined) continue
    let bytes = first.bytes
    if (bytes.length < 12) continue
    if (first.lz4) {
      try {
        bytes = lz4BlockDecode(bytes, first.outSize)
      } catch {
        continue
      }
    }
    if (bytes.length < 12) continue
    const magic = bytes.toString('latin1', 4, 12)
    if (!MP4_MAGICS.includes(magic)) continue
    const base = e.path.split(/[\\/]/).pop().replace(/\.tex$/i, '')
    out.push({ name: base + '.mp4', mp4: bytes })
  }
  return out
}

// ── GIF 动画序列纹理 → GIF（移植自 repkg TexToImageConverter.ConvertToGif）──

/** BC1/BC2/BC3（DXT1/3/5）块解压 → RGBA8888。 */
function dxtBlockDecode(data, width, height, kind) {
  const rgba = Buffer.alloc(width * height * 4)
  const bytesPerBlock = kind === 'dxt1' ? 8 : 16
  const codes = new Uint8Array(16)
  const target = new Uint8Array(64)
  let src = 0
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      if (src + 8 > data.length) break
      // alpha
      if (kind === 'dxt3') {
        for (let i = 0; i < 8; i++) {
          const q = data[src + i]
          target[8 * i + 3] = (q & 0x0f) | ((q & 0x0f) << 4)
          target[8 * i + 7] = (q & 0xf0) | ((q & 0xf0) >> 4)
        }
      } else if (kind === 'dxt5') {
        const a0 = data[src]
        const a1 = data[src + 1]
        const ac = new Uint8Array(8)
        ac[0] = a0
        ac[1] = a1
        if (a0 <= a1) {
          for (let i = 1; i < 5; i++) ac[1 + i] = ((5 - i) * a0 + i * a1) / 5 | 0
          ac[6] = 0
          ac[7] = 255
        } else {
          for (let i = 1; i < 7; i++) ac[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0
        }
        let v = 0
        let pos = 2
        for (let i = 0; i < 2; i++) {
          v = data[src + pos] | (data[src + pos + 1] << 8) | (data[src + pos + 2] << 16)
          pos += 3
          for (let j = 0; j < 8; j++) target[(i * 8 + j) * 4 + 3] = ac[(v >> (3 * j)) & 7]
        }
      }
      // color block offset
      const colorOff = src + (kind === 'dxt1' ? 0 : 8)
      // endpoints
      const v0 = data[colorOff] | (data[colorOff + 1] << 8)
      const v1 = data[colorOff + 2] | (data[colorOff + 3] << 8)
      codes[0] = ((v0 >> 11) & 0x1f) << 3 | ((v0 >> 11) & 0x1f) >> 2
      codes[1] = ((v0 >> 5) & 0x3f) << 2 | ((v0 >> 5) & 0x3f) >> 4
      codes[2] = (v0 & 0x1f) << 3 | (v0 & 0x1f) >> 2
      codes[3] = 255
      codes[4] = ((v1 >> 11) & 0x1f) << 3 | ((v1 >> 11) & 0x1f) >> 2
      codes[5] = ((v1 >> 5) & 0x3f) << 2 | ((v1 >> 5) & 0x3f) >> 4
      codes[6] = (v1 & 0x1f) << 3 | (v1 & 0x1f) >> 2
      codes[7] = 255
      const dxt1Cut = kind === 'dxt1' && v0 <= v1
      for (let i = 0; i < 3; i++) {
        if (dxt1Cut) {
          codes[8 + i] = (codes[i] + codes[4 + i]) >> 1
          codes[12 + i] = 0
        } else {
          codes[8 + i] = (2 * codes[i] + codes[4 + i]) / 3 | 0
          codes[12 + i] = (codes[i] + 2 * codes[4 + i]) / 3 | 0
        }
      }
      codes[11] = 255
      codes[15] = dxt1Cut ? 0 : 255
      // indices
      for (let i = 0; i < 4; i++) {
        const packed = data[colorOff + 4 + i]
        target[(i * 4 + 0) * 4] = codes[(packed & 3) * 4]
        target[(i * 4 + 0) * 4 + 1] = codes[(packed & 3) * 4 + 1]
        target[(i * 4 + 0) * 4 + 2] = codes[(packed & 3) * 4 + 2]
        target[(i * 4 + 0) * 4 + 3] = codes[(packed & 3) * 4 + 3]
        target[(i * 4 + 1) * 4] = codes[((packed >> 2) & 3) * 4]
        target[(i * 4 + 1) * 4 + 1] = codes[((packed >> 2) & 3) * 4 + 1]
        target[(i * 4 + 1) * 4 + 2] = codes[((packed >> 2) & 3) * 4 + 2]
        target[(i * 4 + 1) * 4 + 3] = codes[((packed >> 2) & 3) * 4 + 3]
        target[(i * 4 + 2) * 4] = codes[((packed >> 4) & 3) * 4]
        target[(i * 4 + 2) * 4 + 1] = codes[((packed >> 4) & 3) * 4 + 1]
        target[(i * 4 + 2) * 4 + 2] = codes[((packed >> 4) & 3) * 4 + 2]
        target[(i * 4 + 2) * 4 + 3] = codes[((packed >> 4) & 3) * 4 + 3]
        target[(i * 4 + 3) * 4] = codes[((packed >> 6) & 3) * 4]
        target[(i * 4 + 3) * 4 + 1] = codes[((packed >> 6) & 3) * 4 + 1]
        target[(i * 4 + 3) * 4 + 2] = codes[((packed >> 6) & 3) * 4 + 2]
        target[(i * 4 + 3) * 4 + 3] = codes[((packed >> 6) & 3) * 4 + 3]
      }
      // write
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const sx = x + px
          const sy = y + py
          if (sx < width && sy < height) {
            const o = 4 * (width * sy + sx)
            const s = 4 * (py * 4 + px)
            rgba[o] = target[s]
            rgba[o + 1] = target[s + 1]
            rgba[o + 2] = target[s + 2]
            rgba[o + 3] = target[s + 3]
          }
        }
      }
      src += bytesPerBlock
    }
  }
  return rgba
}

/** mipmap 格式映射（imageFormat=-1 时按 TexFormat）。 */
function mipmapFormatOf(tex) {
  if (tex.imageFormat !== -1) return tex.imageFormat === 35 ? 'mp4' : 'other'
  switch (tex.format) {
    case 0: return 'rgba8888'
    case 4: return 'dxt5'
    case 6: return 'dxt3'
    case 7: return 'dxt1'
    case 8: return 'rg88'
    case 9: return 'r8'
    default: return 'unknown'
  }
}

/** mipmap → RGBA8888 像素。 */
function decodeMipmapPixels(mip, fmt) {
  let bytes = mip.bytes
  if (mip.lz4) bytes = lz4BlockDecode(bytes, mip.outSize)
  const w = mip.width
  const h = mip.height
  if (fmt === 'dxt1' || fmt === 'dxt3' || fmt === 'dxt5') return dxtBlockDecode(bytes, w, h, fmt)
  if (fmt === 'r8') {
    const out = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) { out[i * 4] = bytes[i]; out[i * 4 + 1] = bytes[i]; out[i * 4 + 2] = bytes[i]; out[i * 4 + 3] = 255 }
    return out
  }
  if (fmt === 'rg88') {
    const out = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) { out[i * 4] = bytes[i * 2]; out[i * 4 + 1] = bytes[i * 2 + 1]; out[i * 4 + 2] = 0; out[i * 4 + 3] = 255 }
    return out
  }
  return Buffer.from(bytes.subarray(0, w * h * 4))
}

function cropRgba(src, sw, sh, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4)
  for (let j = 0; j < h; j++) {
    const sy = y + j
    if (sy < 0 || sy >= sh) continue
    for (let i = 0; i < w; i++) {
      const sx = x + i
      if (sx < 0 || sx >= sw) continue
      const so = 4 * (sy * sw + sx)
      const o = 4 * (j * w + i)
      out[o] = src[so]
      out[o + 1] = src[so + 1]
      out[o + 2] = src[so + 2]
      out[o + 3] = src[so + 3]
    }
  }
  return out
}

/** 90° 倍旋转（GIF 帧的 rotationAngle 只产生 0/90/180/270）。 */
function rotateRgba(src, w, h, angle) {
  const deg = ((angle % 360) + 360) % 360
  if (deg === 0) return src
  if (deg === 180) {
    const out = Buffer.alloc(w * h * 4)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const o = 4 * (j * w + i)
      const s = 4 * ((h - 1 - j) * w + (w - 1 - i))
      out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = src[s + 3]
    }
    return out
  }
  // 90/270：宽高互换
  const nw = h
  const nh = w
  const out = Buffer.alloc(nw * nh * 4)
  for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
    const o = 4 * (j * nw + i)
    // CW: dst[j][i] = src[i][w-1-j]；CCW: dst[j][i] = src[h-1-i][j]
    const s = deg === 90
      ? 4 * (i * w + (w - 1 - j))
      : 4 * ((h - 1 - i) * w + j)
    out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = src[s + 3]
  }
  return out
}

/** TEXS 帧容器解析（GIF 动画帧布局）。 */
function parseFrameInfo(buf, off) {
  const m = readNulStr(buf, off, 16)
  off = m.next
  const ver = /^TEXS000([1-3])$/.exec(m.v)
  if (ver === null) return null
  const frameCount = readI32(buf, off)
  off += 4
  let gifWidth = 0
  let gifHeight = 0
  if (ver[1] === '3') {
    gifWidth = readI32(buf, off)
    gifHeight = readI32(buf, off + 4)
    off += 8
  }
  const isInt = ver[1] === '1'
  const frames = []
  for (let i = 0; i < frameCount; i++) {
    const f = { imageId: readI32(buf, off), frametime: buf.readFloatLE(off + 4) }
    off += 8
    if (isInt) {
      f.x = readI32(buf, off); f.y = readI32(buf, off + 4)
      f.width = readI32(buf, off + 8); f.widthY = readI32(buf, off + 12)
      f.heightX = readI32(buf, off + 16); f.height = readI32(buf, off + 20)
      off += 24
    } else {
      f.x = buf.readFloatLE(off); f.y = buf.readFloatLE(off + 4)
      f.width = buf.readFloatLE(off + 8); f.widthY = buf.readFloatLE(off + 12)
      f.heightX = buf.readFloatLE(off + 16); f.height = buf.readFloatLE(off + 20)
      off += 24
    }
    frames.push(f)
  }
  if (gifWidth === 0 || gifHeight === 0) {
    gifWidth = Math.abs(Math.round(frames[0] !== undefined ? frames[0].width : 0))
    gifHeight = Math.abs(Math.round(frames[0] !== undefined ? frames[0].height : 0))
  }
  return { gifWidth, gifHeight, frames }
}

/** 单帧中位切割调色板（≤maxColors 色）；返回 { palette, indexOf, hasAlpha }。 */
function quantize(rgba, w, h, maxColors) {
  const counts = new Map()
  let hasAlpha = false
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    if (rgba[o + 3] < 128) { hasAlpha = true; continue }
    const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const boxes = [{ colors: [...counts.entries()] }]
  while (boxes.length < maxColors) {
    let bi = -1
    let best = 1
    boxes.forEach((b, i) => { if (b.colors.length > best) { best = b.colors.length; bi = i } })
    if (bi === -1) break
    const box = boxes[bi]
    let chan = 0
    let maxRange = -1
    for (let c = 0; c < 3; c++) {
      const shift = 16 - c * 8
      let mn = 255, mx = 0
      for (const [col] of box.colors) {
        const v = (col >> shift) & 255
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      if (mx - mn > maxRange) { maxRange = mx - mn; chan = c }
    }
    if (maxRange === 0) break
    const shift = 16 - chan * 8
    box.colors.sort((a, b) => ((a[0] >> shift) & 255) - ((b[0] >> shift) & 255))
    const mid = box.colors.length >> 1
    boxes.splice(bi, 1, { colors: box.colors.slice(0, mid) }, { colors: box.colors.slice(mid) })
  }
  const palette = []
  const indexOf = new Map()
  for (const b of boxes) {
    let r = 0, g = 0, bl = 0, n = 0
    for (const [col, cnt] of b.colors) {
      r += ((col >> 16) & 255) * cnt
      g += ((col >> 8) & 255) * cnt
      bl += (col & 255) * cnt
      n += cnt
    }
    const idx = palette.length
    palette.push([(r / n) | 0, (g / n) | 0, (bl / n) | 0])
    for (const [col] of b.colors) indexOf.set(col, idx)
  }
  return { palette, indexOf, hasAlpha }
}

/** GIF-LZW 编码（minCodeSize=8）。 */
function gifLzw(indices) {
  const minCodeSize = 8
  const clear = 256
  const eoi = 257
  let codeSize = 9
  let next = 258
  const table = new Map()
  const bits = []
  const put = (code, size) => { for (let i = 0; i < size; i++) bits.push((code >> i) & 1) }
  put(clear, codeSize)
  let prev = -1
  for (const k of indices) {
    if (prev === -1) { prev = k; continue }
    const key = (prev << 8) | k
    const code = table.get(key)
    if (code !== undefined) { prev = code; continue }
    put(prev, codeSize)
    if (next < 4096) {
      table.set(key, next)
      next++
      if (next === (1 << codeSize) && codeSize < 12) codeSize++
    }
    prev = k
  }
  if (prev !== -1) put(prev, codeSize)
  put(eoi, codeSize)
  const bytes = []
  let acc = 0
  let nbits = 0
  for (const b of bits) {
    acc |= b << nbits
    nbits++
    if (nbits === 8) { bytes.push(acc); acc = 0; nbits = 0 }
  }
  if (nbits > 0) bytes.push(acc)
  return { minCodeSize, data: bytes }
}

/** 编码 GIF89a：每帧本地调色板 + LZW。 */
function gifEncode(frames, canvasW, canvasH) {
  const chunks = [Buffer.from('GIF89a')]
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(canvasW, 0)
  lsd.writeUInt16LE(canvasH, 2)
  lsd[4] = 0 // 无全局调色板
  lsd[5] = 0
  lsd[6] = 0
  chunks.push(lsd)
  for (const fr of frames) {
    const w = fr.width
    const h = fr.height
    const q = quantize(fr.rgba, w, h, fr.transparent ? 255 : 256)
    // GCE：packed(bit0=透明标志) + delay(1/100s, offset 4-5) + 透明索引
    const gce = Buffer.from([0x21, 0xf9, 0x04, q.hasAlpha ? 0x01 : 0x00, 0, 0, q.hasAlpha ? 0x00 : 0x00, 0x00])
    gce.writeUInt16LE(Math.min(65535, Math.max(2, fr.delay)), 4)
    chunks.push(gce)
    // 图像描述符
    const id = Buffer.alloc(10)
    id[0] = 0x2c
    id.writeUInt16LE(0, 1) // left
    id.writeUInt16LE(0, 3) // top
    id.writeUInt16LE(w, 5)
    id.writeUInt16LE(h, 7)
    id[9] = 0x87 // 本地调色板，2^(7+1)=256
    chunks.push(id)
    // 调色板 256 项
    const pal = Buffer.alloc(256 * 3)
    for (let i = 0; i < 256; i++) {
      const c = q.palette[i]
      if (c !== undefined) { pal[i * 3] = c[0]; pal[i * 3 + 1] = c[1]; pal[i * 3 + 2] = c[2] }
    }
    chunks.push(pal)
    // 像素 → 索引
    const indices = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      if (fr.transparent && fr.rgba[o + 3] < 128) { indices[i] = 0; continue }
      const key = (fr.rgba[o] << 16) | (fr.rgba[o + 1] << 8) | fr.rgba[o + 2]
      indices[i] = q.indexOf.get(key) !== undefined ? q.indexOf.get(key) + (fr.transparent ? 1 : 0) : 0
    }
    // LZW 数据：minCodeSize 一次 + 数据子块（≤255） + 块结束
    const lzw = gifLzw(indices)
    chunks.push(Buffer.from([lzw.minCodeSize]))
    const blocks = []
    for (let i = 0; i < lzw.data.length; i += 255) {
      const sub = Buffer.from(lzw.data.slice(i, i + 255))
      blocks.push(Buffer.from([sub.length]), sub)
    }
    chunks.push(Buffer.concat(blocks))
    chunks.push(Buffer.from([0x00]))
  }
  chunks.push(Buffer.from([0x3b]))
  return Buffer.concat(chunks)
}

/**
 * 从场景 PKG 提取全部 GIF 动画序列纹理。
 * @param {Buffer} pkgBuf
 * @param {(done: number, total: number) => void} [onProgress] 逐条目进度回调
 * @returns {Promise<Array<{name: string, gif: Buffer}>>}
 */
export async function extractGifTextures(pkgBuf, onProgress) {
  if (!Buffer.isBuffer(pkgBuf) || pkgBuf.length < 16) return []
  let pkg
  try { pkg = parsePkg(pkgBuf) } catch { return [] }
  const entries = pkg.entries
  const out = []
  for (let i = 0; i < entries.length; i++) {
    if (i % 4 === 0) await new Promise((r) => setImmediate(r))
    if (onProgress !== undefined) onProgress(i + 1, entries.length)
    const e = entries[i]
    if (!/\.tex$/i.test(e.path) || e.data.length < 8) continue
    let tex
    try { tex = parseTex(e.data) } catch { continue }
    if (tex === null || (tex.flags & 4) === 0 || !tex.frames || tex.frames.frames.length === 0) continue
    const fmt = mipmapFormatOf(tex)
    if (fmt === 'mp4' || fmt === 'other' || fmt === 'unknown') continue
    const cells = []
    for (const img of tex.images) {
      const mip = img.mipmaps[0]
      if (mip === undefined) { cells.push(null); continue }
      try { cells.push(decodeMipmapPixels(mip, fmt)) } catch { cells.push(null) }
    }
    const frames = []
    for (const fi of tex.frames.frames) {
      const cell = cells[fi.imageId]
      if (cell === undefined || cell === null) continue
      const mip = tex.images[fi.imageId] !== undefined ? tex.images[fi.imageId].mipmaps[0] : undefined
      if (mip === undefined) continue
      const cw = mip.width
      const ch = mip.height
      const width = fi.width !== 0 ? fi.width : fi.heightX
      const height = fi.height !== 0 ? fi.height : fi.widthY
      const x = Math.min(fi.x, fi.x + width)
      const y = Math.min(fi.y, fi.y + height)
      const angle = Math.round(-(Math.atan2(Math.sign(height), Math.sign(width)) - Math.PI / 4) * 180 / Math.PI)
      const crop = cropRgba(cell, cw, ch, Math.floor(x), Math.floor(y), Math.abs(Math.round(width)), Math.abs(Math.round(height)))
      const rot90 = (angle % 180) !== 0
      const fw = rot90 ? Math.abs(Math.round(height)) : Math.abs(Math.round(width))
      const fh = rot90 ? Math.abs(Math.round(width)) : Math.abs(Math.round(height))
      const rotated = rotateRgba(crop, Math.abs(Math.round(width)), Math.abs(Math.round(height)), angle)
      frames.push({
        rgba: rotated,
        width: fw,
        height: fh,
        delay: Math.round(fi.frametime * 100),
        transparent: true,
      })
    }
    if (frames.length === 0) continue
    let gif
    try {
      gif = gifEncode(frames, tex.frames.gifWidth, tex.frames.gifHeight)
    } catch { continue }
    const base = e.path.split(/[\\/]/).pop().replace(/\.tex$/i, '')
    out.push({ name: base + '.gif', gif })
  }
  return out
}
