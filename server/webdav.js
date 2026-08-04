// WebDAV(坚果云等)图片存储后端:Basic Auth,PUT/GET/DELETE + 按需建目录
import { getSetting } from './db.js'

export function config() {
  return {
    url: getSetting('webdav_url', process.env.WEBDAV_URL || ''),
    username: getSetting('webdav_username', process.env.WEBDAV_USERNAME || ''),
    hasPassword: Boolean(getSetting('webdav_password', process.env.WEBDAV_PASSWORD || '')),
    folder: getSetting('webdav_folder', process.env.WEBDAV_FOLDER || 'images'),
  }
}

function password() {
  return getSetting('webdav_password', process.env.WEBDAV_PASSWORD || '')
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${config().username}:${password()}`).toString('base64')
}

// 文件绝对 URL:base 去末尾斜杠 + folder 各段 + 文件名,逐段编码
function itemUrl(filename) {
  const { url, folder } = config()
  const base = url.replace(/\/+$/, '')
  const segs = folder.split('/').map((s) => s.trim()).filter(Boolean).map(encodeURIComponent).join('/')
  return `${base}/${segs ? `${segs}/` : ''}${encodeURIComponent(filename)}`
}

// 已建目录去重(进程内),重启再建无妨——MKCOL 对已存在目录会返回 405/409,按忽略处理
const madeDirs = new Set()

// 逐段 MKCOL 建 folder 目录;已存在的段(405/409)忽略,真失败才抛
async function ensureFolder() {
  const { url, folder } = config()
  const base = url.replace(/\/+$/, '')
  const segs = folder.split('/').map((s) => s.trim()).filter(Boolean)
  if (segs.length === 0 || madeDirs.has(folder)) return
  let cur = base
  for (const seg of segs) {
    cur = `${cur}/${encodeURIComponent(seg)}`
    if (madeDirs.has(cur)) continue
    const res = await fetch(cur, { method: 'MKCOL', headers: { Authorization: authHeader() } })
    if (!res.ok && res.status !== 405 && res.status !== 409 && res.status !== 301) {
      const text = await res.text().catch(() => '')
      throw new Error(`WebDAV 建目录失败 (${res.status}): ${text.slice(0, 200)}`)
    }
    madeDirs.add(cur)
  }
  madeDirs.add(folder)
}

export function isConnected() {
  const { url, username } = config()
  return Boolean(url && username && password())
}

export async function putImage(filename, buf, contentType) {
  await ensureFolder()
  const res = await fetch(itemUrl(filename), {
    method: 'PUT',
    headers: { Authorization: authHeader(), 'Content-Type': contentType },
    body: buf,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV 上传失败 (${res.status}): ${text.slice(0, 200)}`)
  }
}

export async function getImage(filename) {
  const res = await fetch(itemUrl(filename), { headers: { Authorization: authHeader() } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV 读取失败 (${res.status}): ${text.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

export async function deleteImage(filename) {
  const res = await fetch(itemUrl(filename), { method: 'DELETE', headers: { Authorization: authHeader() } })
  // 404 说明文件已不在,与删除成功等价
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV 删除失败 (${res.status}): ${text.slice(0, 200)}`)
  }
}

// 测试连通性:对根 URL 做一次 PROPFIND(depth 0),验证凭据与可达性,不要求 folder 已存在
export async function testConnection() {
  if (!isConnected()) return { ok: false, message: '请先填写完整的 WebDAV 地址、用户名与密码' }
  const base = config().url.replace(/\/+$/, '/') || '/'
  const res = await fetch(base, {
    method: 'PROPFIND',
    headers: { Authorization: authHeader(), Depth: '0' },
  })
  if (res.ok || res.status === 207) return { ok: true }
  const text = await res.text().catch(() => '')
  return { ok: false, message: `连接失败 (${res.status}): ${text.slice(0, 200)}` }
}
