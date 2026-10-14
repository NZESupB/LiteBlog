// 图片/视频存储后端:本地磁盘与 WebDAV 同接口,按每个文件记录的 storage 取用
import { readFile, writeFile, unlink, mkdir, stat, rename, copyFile, link } from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import path from 'node:path'
import { UPLOAD_DIR, db, getSetting, syncFile } from './db.js'
import * as webdav from './webdav.js'
import { configValue } from './config.js'
import { conflictMediaPath, datedMediaPath } from './media-path.js'

export const LOCAL = 'local'
export const WEBDAV = 'webdav'

// 新文件写入哪个后端(历史文件仍按各自记录的 storage 读取)
export function activeBackend() {
  return getSetting('storage_backend', String(configValue('storage.backend', LOCAL))) === WEBDAV ? WEBDAV : LOCAL
}

// 同步占用逻辑名，覆盖图片/视频并发保存到登记数据库之间的窗口。
const reservedNames = new Set()
export function reserveMediaName(candidate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const name = candidate(attempt)
    if (reservedNames.has(name)
      || db.prepare('SELECT 1 FROM pending_uploads WHERE filename = ? LIMIT 1').get(name)
      || db.prepare('SELECT 1 FROM images WHERE filename = ? OR motion_filename = ? OR poster_filename = ? LIMIT 1').get(name, name, name)) continue
    reservedNames.add(name)
    return name
  }
  throw new Error('无法分配不冲突的媒体文件名，请重试')
}

export function releaseMediaName(name) { reservedNames.delete(name) }

// 仅新上传走日期路径与条件写入；历史读取和显式目录调用不重新计算路径。
export async function storeNewMedia(filename, backend, time, write) {
  const originalPath = backend === WEBDAV ? datedMediaPath(filename, time) : filename
  let storagePath = originalPath
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await write(storagePath, { exclusive: true })
      return storagePath
    } catch (error) {
      if (backend !== WEBDAV || error.code !== 'STORAGE_CONFLICT') throw error
      if (attempt === 2) throw new Error('WebDAV 文件名连续冲突，请重试')
      storagePath = conflictMediaPath(originalPath)
    }
  }
}

export async function putImage(filename, buf, contentType, relativePath = filename, forcedBackend = null, options = {}) {
  const backend = forcedBackend || activeBackend()
  if (backend === WEBDAV) {
    if (!webdav.isConnected()) throw new Error('图片存储已设为 WebDAV,但尚未配置凭据')
    await webdav.putImage(filename, buf, contentType, relativePath, undefined, options)
    return WEBDAV
  }
  const localPath = path.join(UPLOAD_DIR, relativePath || filename)
  await mkdir(path.dirname(localPath), { recursive: true })
  await writeFile(localPath, buf, options.exclusive ? { flag: 'wx' } : undefined)
  return LOCAL
}

// 大文件(视频)转存:源是已经落盘的临时文件,全程不把内容读进内存。
// WebDAV 侧带 Content-Length 上传 —— 分块 PUT 在部分网盘(坚果云等)上不可靠。
export async function putFileFromTemp(filename, tempPath, size, contentType, relativePath = filename, forcedBackend = null, signal = undefined, options = {}) {
  signal?.throwIfAborted()
  const backend = forcedBackend || activeBackend()
  if (backend === WEBDAV) {
    if (!webdav.isConnected()) throw new Error('存储已设为 WebDAV,但尚未配置凭据')
    await webdav.putFile(filename, tempPath, size, contentType, relativePath, undefined, signal, options)
    return WEBDAV
  }
  const localPath = path.join(UPLOAD_DIR, relativePath || filename)
  await mkdir(path.dirname(localPath), { recursive: true })
  if (options.exclusive) {
    try {
      await link(tempPath, localPath)
    } catch (error) {
      if (error.code !== 'EXDEV') throw error
      await copyFile(tempPath, localPath, constants.COPYFILE_EXCL)
    }
    // 调用方成功登记后统一 cleanTemp，同盘只建硬链接，不复制整个视频。
  } else {
    try {
      await rename(tempPath, localPath)
    } catch (error) {
      if (error.code !== 'EXDEV') throw error
      await copyFile(tempPath, localPath)
      await unlink(tempPath)
    }
  }
  syncFile(localPath)
  syncFile(path.dirname(localPath))
  return LOCAL
}

export async function verifyStoredFile(filename, backend, relativePath, size, hash, signal) {
  signal?.throwIfAborted()
  if (backend === WEBDAV) return webdav.verifyFile(relativePath || filename, size, hash, signal)
  const target = path.join(UPLOAD_DIR, relativePath || filename)
  try {
    if ((await stat(target)).size !== size) return false
    const digest = createHash('sha256')
    let received = 0
    for await (const chunk of createReadStream(target, { signal })) { received += chunk.length; digest.update(chunk) }
    return received === size && digest.digest('hex') === hash
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
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
    partial: Boolean(range),
  }
}

export async function deleteImage(filename, backend, relativePath = filename) {
  if (backend === WEBDAV) return webdav.deleteImage(filename, relativePath)
  if (backend !== LOCAL) return // 历史 onedrive 等已失效后端无可删,静默
  await unlink(path.join(UPLOAD_DIR, relativePath || filename)).catch(() => {})
}
