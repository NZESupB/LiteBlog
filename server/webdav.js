// WebDAV(坚果云等)媒体存储后端:Basic Auth,PUT/GET/DELETE + 按需建目录
import { createReadStream } from 'node:fs'
import { getSetting } from './db.js'
import { configValue } from './config.js'

export function config() {
  return {
    url: getSetting('webdav_url', String(configValue('storage.webdav.url', ''))),
    username: getSetting('webdav_username', String(configValue('storage.webdav.username', ''))),
    hasPassword: Boolean(getSetting('webdav_password', String(configValue('storage.webdav.password', '')))),
    folder: getSetting('webdav_folder', String(configValue('storage.webdav.folder', 'images'))),
  }
}

function password() {
  return getSetting('webdav_password', String(configValue('storage.webdav.password', '')))
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${config().username}:${password()}`).toString('base64')
}

function pathSegments(value) {
  return String(value || '').split('/').map((s) => s.trim()).filter(Boolean)
}

// 文件绝对 URL:base 去末尾斜杠 + 普通图片目录 + 相对路径,逐段编码
function itemUrl(relativePath, folder = config().folder) {
  const { url } = config()
  const base = url.replace(/\/+$/, '')
  const segs = [...pathSegments(folder), ...pathSegments(relativePath)].map(encodeURIComponent).join('/')
  return `${base}/${segs}`
}

// 已建目录去重(进程内),重启再建无妨——MKCOL 对已存在目录会返回 405/409,按忽略处理
const madeDirs = new Set()

// 逐段 MKCOL 建 folder 目录;已存在的段(405/409)忽略,真失败才抛
async function ensureFolder(relativePath = '', folder = config().folder) {
  const { url } = config()
  const base = url.replace(/\/+$/, '')
  const segs = [...pathSegments(folder), ...pathSegments(relativePath).slice(0, -1)]
  const cacheKey = `${folder}/${segs.join('/')}`
  if (segs.length === 0 || madeDirs.has(cacheKey)) return
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
  madeDirs.add(cacheKey)
}

export function isConnected() {
  const { url, username } = config()
  return Boolean(url && username && password())
}

export async function putImage(filename, buf, contentType, relativePath = filename, folder = config().folder) {
  await ensureFolder(relativePath, folder)
  const res = await fetch(itemUrl(relativePath, folder), {
    method: 'PUT',
    headers: { Authorization: authHeader(), 'Content-Type': contentType },
    body: buf,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV 上传失败 (${res.status}): ${text.slice(0, 200)}`)
  }
}

// 大文件上传:从临时文件流式 PUT,带 Content-Length。部分网盘只接受带长度的 PUT,
// 用 ReadableStream 分块上传会失败,所以这里显式给出长度而不是 chunked。
export async function putFile(filename, tempPath, size, contentType, relativePath = filename, folder = config().folder) {
  await ensureFolder(relativePath, folder)
  const res = await fetch(itemUrl(relativePath, folder), {
    method: 'PUT',
    headers: { Authorization: authHeader(), 'Content-Type': contentType, 'Content-Length': String(size) },
    body: createReadStream(tempPath),
    duplex: 'half',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV 上传失败 (${res.status}): ${text.slice(0, 200)}`)
  }
}

// 视频读取:透传 Range,上游回 206 时原样把 Content-Range 交给调用方。
// 上游不支持 Range(回 200)时退回整段返回,由路由按 200 处理。
export async function openStream(filename, relativePath = filename, rangeHeader = null, folder = config().folder) {
  const headers = { Authorization: authHeader() }
  if (rangeHeader) headers.Range = rangeHeader
  const res = await fetch(itemUrl(relativePath, folder), { headers })
  if (!res.ok && res.status !== 206) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV 读取失败 (${res.status}): ${text.slice(0, 200)}`)
  }
  if (res.status !== 206 || !res.body) {
    return { stream: res.body, start: 0, end: null, total: null, partial: false }
  }
  const contentRange = res.headers.get('content-range') || ''
  const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(contentRange)
  const start = match ? Number(match[1]) : 0
  const end = match ? Number(match[2]) : null
  const total = match && match[3] !== '*' ? Number(match[3]) : null
  return { stream: res.body, start, end, total, partial: true }
}

export async function getImage(filename, relativePath = filename, folder = config().folder) {
  const res = await fetch(itemUrl(relativePath, folder), { headers: { Authorization: authHeader() } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV 读取失败 (${res.status}): ${text.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

export async function deleteImage(filename, relativePath = filename, folder = config().folder) {
  const res = await fetch(itemUrl(relativePath, folder), { method: 'DELETE', headers: { Authorization: authHeader() } })
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
