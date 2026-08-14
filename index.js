// dsh-bg-beautify
// 作者：芝麻 (halosb)
// 邮箱：i@halosb.com
// License: MIT
/**
 * dsh-bg-beautify — Node (host) half.
 *
 * @author 芝麻 (halosb) <i@halosb.com>
 *
 * Three HTTP endpoints, all on the webserver (no DSH source touched):
 *   GET  /bg/<file>     — serve a background image from ./assets/
 *   POST /bg/upload     — accept an image upload (data: URI), store it in
 *                         ./assets/, return { url: '/bg/<file>' }
 *   GET  /bg/settings   — read the persisted 背景美化 settings (config.json)
 *   POST /bg/settings   — validate and persist the settings
 *
 * Persistence lives in this package's own config.json, so the plugin works
 * without the host settings-service allowlist (api-proxy only exposes a fixed
 * namespace list to configuration clients).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-bg-beautify'

/** The webserver service is a hard dependency: every route lives on it. */
export const inject = ['webServer']

/** This package's assets directory (realpath through the profile link). */
const ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url))

/** This package's persisted settings file. */
const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url))

/** Defaults (must match the client bundle's DEFAULTS). */
const DEFAULT_CONFIG = {
  image: '/bg/placeholder.svg',
  size: 'cover',
  position: 'center',
  fixed: false,
  opacityMain: 0,
  opacitySidebar: 0.3,
  opacityCard: 0.85,
  opacityInput: 0.75,
  textProtect: true,
  textStrength: 0.5,
  scrim: false,
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
  if (typeof input.textProtect === 'boolean') out.textProtect = input.textProtect
  if (typeof input.scrim === 'boolean') out.scrim = input.scrim
  if (typeof input.textStrength === 'number' && Number.isFinite(input.textStrength)) {
    out.textStrength = Math.min(1, Math.max(0, input.textStrength))
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

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/bg',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      const rel = pathname.slice('/bg/'.length)
      // Only a bare filename is allowed — no separators, no '..' (path traversal guard).
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
