// 图片/视频存储后端:本地磁盘与 WebDAV 同接口,按每个文件记录的 storage 取用
import { readFile, writeFile, unlink, mkdir, stat, rename, copyFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { UPLOAD_DIR, getSetting } from './db.js'
import * as webdav from './webdav.js'
import { configValue } from './config.js'

export const LOCAL = 'local'
export const WEBDAV = 'webdav'

// 新文件写入哪个后端(历史文件仍按各自记录的 storage 读取)
export function activeBackend() {
  return getSetting('storage_backend', String(configValue('storage.backend', LOCAL))) === WEBDAV ? WEBDAV : LOCAL
}

export async function putImage(filename, buf, contentType, relativePath = filename, forcedBackend = null) {
  const backend = forcedBackend || activeBackend()
  if (backend === WEBDAV) {
    if (!webdav.isConnected()) throw new Error('图片存储已设为 WebDAV,但尚未配置凭据')
    await webdav.putImage(filename, buf, contentType, relativePath)
    return WEBDAV
  }
  const localPath = path.join(UPLOAD_DIR, relativePath || filename)
  await mkdir(path.dirname(localPath), { recursive: true })
  await writeFile(localPath, buf)
  return LOCAL
}

// 大文件(视频)转存:源是已经落盘的临时文件,全程不把内容读进内存。
// WebDAV 侧带 Content-Length 上传 —— 分块 PUT 在部分网盘(坚果云等)上不可靠。
export async function putFileFromTemp(filename, tempPath, size, contentType, relativePath = filename, forcedBackend = null) {
  const backend = forcedBackend || activeBackend()
  if (backend === WEBDAV) {
    if (!webdav.isConnected()) throw new Error('存储已设为 WebDAV,但尚未配置凭据')
    await webdav.putFile(filename, tempPath, size, contentType, relativePath)
    return WEBDAV
  }
  const localPath = path.join(UPLOAD_DIR, relativePath || filename)
  await mkdir(path.dirname(localPath), { recursive: true })
  try {
    await rename(tempPath, localPath)
  } catch {
    // 跨设备或目标已存在时退回复制,复制成功再删临时文件
    await copyFile(tempPath, localPath)
    await unlink(tempPath).catch(() => {})
  }
  return LOCAL
}

export async function getImage(filename, backend, relativePath = filename) {
  if (backend === WEBDAV) return webdav.getImage(filename, relativePath)
  return readFile(path.join(UPLOAD_DIR, relativePath || filename))
}

// 只接受单区间的 bytes=,多区间(逗号分隔)与非法值一律当作整段请求
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match || size <= 0) return null
  const [, rawStart, rawEnd] = match
  let start
  let end
  if (rawStart === '') {
    // 后缀区间 bytes=-500 表示最后 500 字节
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

// 视频读取:支持 HTTP Range。本地区间用 createReadStream 偏移读,WebDAV 把 Range 原样透传给上游。
// 返回 { stream, start, end, total },start/end 是最终实际返回的闭区间字节偏移。
export async function openStream(filename, backend, relativePath = filename, rangeHeader = null) {
  if (backend === WEBDAV) return webdav.openStream(filename, relativePath, rangeHeader)
  const localPath = path.join(UPLOAD_DIR, relativePath || filename)
  const { size } = await stat(localPath)
  const range = parseRange(rangeHeader, size)
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  return {
    stream: Readable.toWeb(createReadStream(localPath, { start, end: Math.max(start, end) })),
    start,
    end: Math.max(start, end),
    total: size,
  }
}

export async function deleteImage(filename, backend, relativePath = filename) {
  if (backend === WEBDAV) return webdav.deleteImage(filename, relativePath)
  if (backend !== LOCAL) return // 历史 onedrive 等已失效后端无可删,静默
  await unlink(path.join(UPLOAD_DIR, relativePath || filename)).catch(() => {})
}
