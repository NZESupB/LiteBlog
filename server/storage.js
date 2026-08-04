// 图片存储后端:本地磁盘与 WebDAV 同接口,按每张图记录的 storage 取用
import { readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { UPLOAD_DIR, getSetting } from './db.js'
import * as webdav from './webdav.js'

export const LOCAL = 'local'
export const WEBDAV = 'webdav'

// 新图片写入哪个后端(历史图片仍按各自记录的 storage 读取)
export function activeBackend() {
  return getSetting('storage_backend', process.env.STORAGE_BACKEND || LOCAL) === WEBDAV ? WEBDAV : LOCAL
}

export async function putImage(filename, buf, contentType) {
  const backend = activeBackend()
  if (backend === WEBDAV) {
    if (!webdav.isConnected()) throw new Error('图片存储已设为 WebDAV,但尚未配置凭据')
    await webdav.putImage(filename, buf, contentType)
    return WEBDAV
  }
  await writeFile(path.join(UPLOAD_DIR, filename), buf)
  return LOCAL
}

export async function getImage(filename, backend) {
  if (backend === WEBDAV) return webdav.getImage(filename)
  return readFile(path.join(UPLOAD_DIR, filename))
}

export async function deleteImage(filename, backend) {
  if (backend === WEBDAV) return webdav.deleteImage(filename)
  if (backend !== LOCAL) return // 历史 onedrive 等已失效后端无可删,静默
  await unlink(path.join(UPLOAD_DIR, filename)).catch(() => {})
}
