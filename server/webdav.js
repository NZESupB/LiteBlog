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

// 只缓存已创建或确认存在的目录，以完整 URL 隔离不同 WebDAV 地址。
const madeDirs = new Set()

function clearFolderCache(base) {
  for (const url of madeDirs) if (url.startsWith(`${base}/`)) madeDirs.delete(url)
}

async function isCollection(url, authorization, signal) {
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: authorization, Depth: '0', 'Content-Type': 'application/xml' },
    body: '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    signal,
  })
  const xml = await res.text()
  // Depth 0 只返回目标自身；只认可成功 propstat 中的 collection 属性。
  return res.ok && [...xml.matchAll(/<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat\s*>/g)]
    .some(([, prop]) => /<(?:[\w.-]+:)?status\b[^>]*>\s*HTTP\/\S+\s+200\b/.test(prop)
      && /<(?:[\w.-]+:)?resourcetype\b[^>]*>\s*<(?:[\w.-]+:)?collection(?:\s|\/|>)/.test(prop))
}

async function ensureFolder(relativePath, folder, base, authorization, signal) {
  const segs = [...pathSegments(folder), ...pathSegments(relativePath).slice(0, -1)]
  for (let attempt = 0; attempt < 2; attempt++) {
    let cur = base
    let retry = false
    for (const seg of segs) {
      cur = `${cur}/${encodeURIComponent(seg)}`
      if (madeDirs.has(cur)) continue
      const res = await fetch(cur, { method: 'MKCOL', headers: { Authorization: authorization }, signal })
      await res.body?.cancel()
      if (res.status === 409 && attempt === 0) {
        clearFolderCache(base)
        retry = true
        break
      }
      if (!res.ok && !(res.status === 405 && await isCollection(cur, authorization, signal))) {
        throw new Error(`WebDAV 建目录失败 (${res.status})`)
      }
      madeDirs.add(cur)
    }
    if (!retry) return
  }
}

async function upload(relativePath, folder, contentType, bodyFactory, { signal, exclusive = false, size } = {}) {
  const base = config().url.replace(/\/+$/, '')
  const authorization = authHeader()
  const target = `${base}/${[...pathSegments(folder), ...pathSegments(relativePath)].map(encodeURIComponent).join('/')}`
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureFolder(relativePath, folder, base, authorization, signal)
    const body = bodyFactory()
    let res
    try {
      res = await fetch(target, {
        method: 'PUT',
        headers: {
          Authorization: authorization, 'Content-Type': contentType,
          ...(size !== undefined ? { 'Content-Length': String(size) } : {}),
          ...(exclusive ? { 'If-None-Match': '*' } : {}),
        },
        body, ...(size !== undefined ? { duplex: 'half' } : {}), signal,
      })
    } finally { body.destroy?.() }
    // PUT 状态已确认，释放响应体失败不应丢失成功文件的所有权记录。
    void res.body?.cancel().catch(() => {})
    if (res.ok) return
    if (res.status === 409 && attempt === 0) {
      clearFolderCache(base)
      continue
    }
    throw Object.assign(new Error(`WebDAV 上传失败 (${res.status})`), {
      code: exclusive && res.status === 412 ? 'STORAGE_CONFLICT' : 'WEBDAV_UPLOAD_FAILED',
    })
  }
}

export function isConnected() {
  const { url, username } = config()
  return Boolean(url && username && password())
}

export async function putImage(filename, buf, contentType, relativePath = filename, folder = config().folder, options = {}) {
  await upload(relativePath, folder, contentType, () => buf, options)
}

// 视频以可重建的文件流上传，显式携带长度，目录缓存失效重试时重新打开源文件。
export async function putFile(filename, tempPath, size, contentType, relativePath = filename, folder = config().folder, signal = undefined, options = {}) {
  await upload(relativePath, folder, contentType, () => createReadStream(tempPath), { ...options, signal, size })
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

export function resetDirectoryCache() { madeDirs.clear() }

// 备份在整个操作中固定连接配置，避免用户改设置后清理另一个目录。
export function backupStorage() {
  const cfg = config()
  const secret = password()
  if (!cfg.url || !cfg.username || !secret) throw Object.assign(new Error('请先在图片存储中配置完整的 WebDAV 连接'), { status: 400 })
  const root = new URL(cfg.url)
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password) throw new Error('WebDAV 地址无效')
  const segments = pathSegments(cfg.folder)
  if (segments.some((part) => part === '.' || part === '..')) throw new Error('WebDAV 目录不能包含相对路径')
  const base = root.href.replace(/\/+$/, '')
  const directory = `${base}/${segments.map(encodeURIComponent).join('/')}${segments.length ? '/' : ''}`
  const authorization = 'Basic ' + Buffer.from(`${cfg.username}:${secret}`).toString('base64')
  const request = async (url, options = {}) => {
    try {
      return await fetch(url, { ...options, headers: { Authorization: authorization, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(30000) })
    } catch { throw new Error('WebDAV 请求失败或超时，请检查连接') }
  }
  const nameUrl = (name) => {
    if (!/^blog-backup-\d{8}-\d{6}\.db$/.test(name)) throw new Error('备份文件名无效')
    return directory + encodeURIComponent(name)
  }
  return {
    async upload(name, filename, size) {
      let current = base
      for (const segment of segments) {
        current += '/' + encodeURIComponent(segment)
        const response = await request(current, { method: 'MKCOL' })
        await response.body?.cancel()
        if (!response.ok && ![301, 405, 409].includes(response.status)) throw new Error(`WebDAV 建目录失败 (${response.status})`)
      }
      const stream = createReadStream(filename)
      try {
        const response = await request(nameUrl(name), {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'If-None-Match': '*' },
          body: stream, duplex: 'half',
        })
        await response.body?.cancel()
        if (response.status === 412) throw Object.assign(new Error('同名备份已存在'), { status: 412 })
        if (!response.ok) throw new Error(`WebDAV 上传失败 (${response.status})`)
      } finally { stream.destroy() }
    },
    async list() {
      const response = await request(directory, { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`WebDAV 列目录失败 (${response.status})`) }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('WebDAV 目录响应为空')
      const chunks = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 2 * 1024 * 1024) throw new Error('WebDAV 目录响应过大')
          chunks.push(value)
        }
      } catch (error) { await reader.cancel(); throw error } finally { reader.releaseLock() }
      return parseBackupListing(Buffer.concat(chunks).toString('utf8'), directory)
    },
    async remove(name) {
      const response = await request(nameUrl(name), { method: 'DELETE' })
      await response.body?.cancel()
      if (!response.ok && response.status !== 404) throw new Error(`WebDAV 清理失败 (${response.status})`)
    },
  }
}

// 只解析 PROPFIND 所需的元素；验证结构，不接受 DTD 或外部实体。
export function parseBackupListing(xml, directory) {
  const invalid = () => { throw new Error('WebDAV 返回了无效的目录响应') }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) invalid()
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) || []
  if (tokens.join('') !== xml) invalid()
  const stack = [], hrefs = []
  let rootSeen = false, response = null, href = null
  const decode = (text) => text.replace(/&([^;]*);/g, (_, entity) => {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity in entities) return entities[entity]
    if (/^#(?:\d+|x[\da-f]+)$/i.test(entity)) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code)
    }
    return invalid()
  })
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue
    if (token.startsWith('<![CDATA[')) { if (href !== null) href += token.slice(9, -3); continue }
    if (!token.startsWith('<')) {
      if (!stack.length && token.trim()) invalid()
      if (href !== null) href += decode(token)
      continue
    }
    const match = /^<(\/)?([\w.-]+(?::[\w.-]+)?)(?:\s[^<>]*?)?\s*(\/?)>$/.exec(token)
    if (!match) invalid()
    const [, closing, name, selfClosing] = match
    const local = name.split(':').pop()
    if (closing) {
      if (stack.pop() !== name || selfClosing) invalid()
      if (local === 'href' && href !== null) { response?.hrefs.push(href.trim()); href = null }
      if (local === 'response' && response) { if (!response.collection) hrefs.push(...response.hrefs); response = null }
    } else {
      if (!stack.length) { if (rootSeen || local !== 'multistatus') invalid(); rootSeen = true }
      if (local === 'response') { if (response) invalid(); response = { hrefs: [], collection: false } }
      if (local === 'collection' && response) response.collection = true
      if (local === 'href') { if (href !== null || !response) invalid(); href = '' }
      if (!selfClosing) stack.push(name)
      else if (local === 'href') href = null
    }
  }
  if (!rootSeen || stack.length || response || href !== null) invalid()
  const base = new URL(directory), names = new Set()
  for (const value of hrefs) {
    let item
    try { item = new URL(value, base) } catch { invalid() }
    if (item.origin !== base.origin || item.search || item.hash) continue
    let pathname, parent
    try { pathname = decodeURIComponent(item.pathname); parent = decodeURIComponent(base.pathname) } catch { invalid() }
    if (!pathname.startsWith(parent)) continue
    const name = pathname.slice(parent.length)
    if (/^blog-backup-\d{8}-\d{6}\.db$/.test(name)) names.add(name)
  }
  return [...names].sort()
}
