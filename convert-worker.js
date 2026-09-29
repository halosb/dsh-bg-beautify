// convert-worker.js — 场景包解码 worker。
//
// 作者：芝麻 (halosb) <i@halosb.com>
// License: MIT
//
// 把 PKG/TEX 解析（含 LZ4/DXT 解码与 GIF 编码）从宿主主线程挪到 worker 线程：
// 原来整包 readFile + 全帧 RGBA + 逐 bit LZW 都在 host 事件循环上同步执行，
// 一张 4K 场景壁纸就能让 Agent 与 HTTP 服务一起卡住甚至 OOM。
//
// 协议（worker → 主线程）：
//   { type: 'progress', phase: 'video'|'gif', done, total }
//   { type: 'items', items: [{ kind: 'mp4'|'gif', name, bytes: Uint8Array }] }
//   { type: 'error', message }
import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { extractVideoMp4s, extractGifTextures } from './we-convert.js'

const pkgPath = workerData !== null && typeof workerData === 'object' ? workerData.pkgPath : undefined

function post(message) {
  if (parentPort !== null) parentPort.postMessage(message)
}

async function run() {
  if (typeof pkgPath !== 'string' || pkgPath === '') {
    post({ type: 'error', message: '缺少包路径' })
    return
  }
  const pkgBuf = await readFile(pkgPath)
  const videos = await extractVideoMp4s(pkgBuf, (done, total) => {
    post({ type: 'progress', phase: 'video', done, total })
  })
  const gifs = await extractGifTextures(pkgBuf, (done, total) => {
    post({ type: 'progress', phase: 'gif', done, total })
  })
  const items = []
  for (const item of videos) {
    items.push({ kind: 'mp4', name: typeof item.name === 'string' ? item.name : '', bytes: item.mp4 })
  }
  for (const item of gifs) {
    items.push({ kind: 'gif', name: typeof item.name === 'string' ? item.name : '', bytes: item.gif })
  }
  // Buffer 走结构化克隆会退化成 Uint8Array，主线程用 Buffer.from 还原。
  post({ type: 'items', items })
}

run().catch((error) => {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
})
