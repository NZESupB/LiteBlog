// 实况照片的有界二进制读取；浏览器与 Node 共用，不依赖 DOM。
export const NS = Object.freeze({
  camera: 'http://ns.google.com/photos/1.0/camera/',
  container: 'http://ns.google.com/photos/1.0/container/',
  item: 'http://ns.google.com/photos/1.0/container/item/',
  oplus: 'http://ns.oplus.com/photos/1.0/camera/',
  note: 'http://ns.adobe.com/xmp/note/',
})
export function photoError(code, message) { return Object.assign(new Error(message), { code }) }
export const text = (bytes) => new TextDecoder().decode(bytes).replace(/\0+$/, '')
export function uint(bytes, offset = 0, size = 4, little = false) {
  if (![0, 1, 2, 4, 8].includes(size) || offset < 0 || offset + size > bytes.length) throw photoError('INVALID_METADATA', '元数据整数越界')
  let value = 0
  for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + (little ? size - i - 1 : i)]
  if (!Number.isSafeInteger(value)) throw photoError('INVALID_RANGE', '元数据数值超出安全整数范围')
  return value
}
export function decimal(value, fallback) {
  if (value == null && fallback !== undefined) return fallback
  if (!/^\d{1,16}$/.test(String(value))) throw photoError('INVALID_METADATA', '实况长度或偏移不是有效非负整数')
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw photoError('INVALID_RANGE', '实况长度或偏移超出安全整数范围')
  return result
}
export class PhotoReader {
  constructor(file, signal) { this.file = file; this.size = file.size; this.signal = signal; this.bytesRead = 0; this.boxCount = 0; this.cache = new Map() }
  async read(start, length) {
    this.signal?.throwIfAborted()
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > this.size) throw photoError('INVALID_RANGE', '实况数据范围超出文件边界')
    if (length > 2 * 1024 * 1024) throw photoError('RESOURCE_LIMIT', '单段实况元数据超过 2MiB')
    const page = Math.floor(start / 65536) * 65536
    if (start + length <= page + 65536) {
      if (!this.cache.has(page)) {
        const count = Math.min(65536, this.size - page)
        this.account(count)
        this.cache.set(page, new Uint8Array(await this.file.slice(page, page + count).arrayBuffer()))
        if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value)
      }
      this.signal?.throwIfAborted()
      return this.cache.get(page).subarray(start - page, start - page + length)
    }
    this.account(length)
    const bytes = new Uint8Array(await this.file.slice(start, start + length).arrayBuffer())
    this.signal?.throwIfAborted()
    return bytes
  }
  account(length) {
    this.bytesRead += length
    if (this.bytesRead > 32 * 1024 * 1024) throw photoError('RESOURCE_LIMIT', '实况解析读取量超过 32MiB，请使用原件重新选择或仅保留静态图')
  }
}
export async function boxAt(reader, start, end = reader.size) {
  if (++reader.boxCount > 8192) throw photoError('RESOURCE_LIMIT', '媒体容器 box 数量过多')
  const head = await reader.read(start, Math.min(16, end - start))
  if (head.length < 8) throw photoError('INVALID_CONTAINER', '媒体容器头被截断')
  const type = text(head.subarray(4, 8))
  let size = uint(head), header = 8
  if (size === 1) { size = uint(head, 8, 8); header = 16 }
  else if (size === 0) size = end - start
  if (!/^[\x20-\x7e]{4}$/.test(type) || size < header || size > end - start) throw photoError('INVALID_CONTAINER', '媒体容器 box 长度无效或文件不完整')
  return { type, start, size, header, data: start + header, end: start + size }
}
export async function boxes(reader, start, end, depth = 0) {
  if (depth > 12) throw photoError('RESOURCE_LIMIT', '媒体容器嵌套过深')
  const result = []
  while (start < end) { const box = await boxAt(reader, start, end); result.push(box); start = box.end }
  return result
}
export function contentId(value) {
  const id = String(value || '').replace(/\0/g, '').trim()
  if (!id || id.length > 128 || !/^[a-z0-9-]+$/i.test(id)) return ''
  return id.toLowerCase()
}

// 只解释 EXIF 指针与 Apple MakerNote 0x0011，所有偏移均相对其所属 TIFF/Note。
export function exifIdentifier(bytes) {
  let base = text(bytes.subarray(0, 6)) === 'Exif' ? 6 : 0
  if (text(bytes.subarray(base, base + 2)) !== 'II' && text(bytes.subarray(base, base + 2)) !== 'MM') {
    if (bytes.length < 8) return ''
    base = 4 + uint(bytes)
  }
  if (text(bytes.subarray(base, base + 6)) === 'Exif') base += 6
  const order = text(bytes.subarray(base, base + 2))
  if (!['II', 'MM'].includes(order)) throw photoError('INVALID_METADATA', 'EXIF 字节序无效')
  const little = order === 'II'
  if (uint(bytes, base + 2, 2, little) !== 42) throw photoError('INVALID_METADATA', 'EXIF TIFF 标记无效')
  const seen = new Set()
  let identifier = '', entries = 0
  function visit(at, origin, le, apple = false, depth = 0) {
    if (depth > 8 || seen.has(at)) throw photoError('INVALID_METADATA', 'EXIF 指针循环或嵌套过深')
    seen.add(at)
    const count = uint(bytes, at, 2, le)
    entries += count
    if (entries > 2048 || at + 2 + count * 12 > bytes.length) throw photoError('INVALID_METADATA', 'EXIF 目录过大或被截断')
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12, tag = uint(bytes, entry, 2, le), type = uint(bytes, entry + 2, 2, le)
      if (tag === 0x8769 && !apple) { visit(origin + uint(bytes, entry + 8, 4, le), origin, le, false, depth + 1); continue }
      if (tag !== 0x927c && !(apple && tag === 0x11)) continue
      const unit = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 })[type]
      if (!unit) throw photoError('INVALID_METADATA', '实况标识的 EXIF 类型无效')
      const length = uint(bytes, entry + 4, 4, le) * unit
      const offset = length <= 4 ? entry + 8 : origin + uint(bytes, entry + 8, 4, le)
      if (offset < 0 || offset + length > bytes.length) throw photoError('INVALID_METADATA', 'Apple 实况标识范围无效')
      if (apple) {
        const id = contentId(text(bytes.subarray(offset, offset + length)))
        if (!id || (identifier && identifier !== id)) throw photoError('INVALID_METADATA', 'Apple 实况标识无效或互相冲突')
        identifier = id
      } else if (text(bytes.subarray(offset, offset + 10)) === 'Apple iOS') {
        const noteOrder = text(bytes.subarray(offset + 12, offset + 14))
        if (!['II', 'MM'].includes(noteOrder)) throw photoError('INVALID_METADATA', 'Apple MakerNote 字节序无效')
        visit(offset + 14, offset, noteOrder === 'II', true, depth + 1)
      }
    }
  }
  visit(base + uint(bytes, base + 4, 4, little), base, little)
  return identifier
}

function unescapeXml(value) {
  return value.replace(/&([^;]+);/g, (_, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (Object.hasOwn(known, entity)) return known[entity]
    const n = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN
    if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw photoError('INVALID_METADATA', 'XMP 含不支持的实体')
    return String.fromCodePoint(n)
  })
}
// 限定用途 XML 读取：命名空间按作用域解析，禁用 DTD/实体声明，支持属性及元素写法。
export function parseXmp(xml) {
  if (xml.length > 512 * 1024) throw photoError('RESOURCE_LIMIT', 'XMP 超过 512KiB')
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw photoError('INVALID_METADATA', 'XMP 不允许 DTD 或实体声明')
  const root = { children: [], ns: { xml: 'http://www.w3.org/XML/1998/namespace' } }, stack = [root]
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_](?:"[^"]*"|'[^']*'|[^'"<>])*>|[^<]+/g
  let match, cursor = 0, count = 0
  function name(qname, namespaces, attribute = false) {
    const pair = qname.split(':')
    if (pair.length > 2 || (pair.length === 2 && !namespaces[pair[0]])) throw photoError('INVALID_METADATA', 'XMP 命名空间未声明')
    return pair.length === 2 ? [namespaces[pair[0]], pair[1]] : [attribute ? '' : (namespaces[''] || ''), pair[0]]
  }
  while ((match = token.exec(xml))) {
    if (match.index !== cursor) throw photoError('INVALID_METADATA', 'XMP XML 结构无效')
    const part = match[0]; cursor = token.lastIndex
    if (part.startsWith('<?') || part.startsWith('<!--')) continue
    if (!part.startsWith('<') || part.startsWith('<![CDATA[')) {
      const value = part.startsWith('<![CDATA[') ? part.slice(9, -3) : unescapeXml(part)
      if (stack.length === 1 && value.trim()) throw photoError('INVALID_METADATA', 'XMP 根元素之外含文本')
      stack.at(-1).text = (stack.at(-1).text || '') + value
      continue
    }
    if (part.startsWith('</')) {
      if (stack.length === 1 || part.slice(2, -1).trim() !== stack.at(-1).qname) throw photoError('INVALID_METADATA', 'XMP 标签不匹配')
      stack.pop(); continue
    }
    if (++count > 4096 || stack.length > 32) throw photoError('RESOURCE_LIMIT', 'XMP 节点数量或嵌套超限')
    const head = /^<([\w:.-]+)/.exec(part), raw = part.slice(head[0].length).replace(/\/?\s*>$/, '')
    const attributes = [], pattern = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g
    let attr, end = 0
    while ((attr = pattern.exec(raw))) {
      if (raw.slice(end, attr.index).trim() || attributes.some(([key]) => key === attr[1])) throw photoError('INVALID_METADATA', 'XMP 属性无效或重复')
      attributes.push([attr[1], unescapeXml(attr[2].slice(1, -1))]); end = pattern.lastIndex
    }
    if (raw.slice(end).trim() || attributes.length > 128) throw photoError('INVALID_METADATA', 'XMP 属性结构无效')
    const ns = { ...stack.at(-1).ns }
    for (const [key, value] of attributes) if (key === 'xmlns' || key.startsWith('xmlns:')) ns[key === 'xmlns' ? '' : key.slice(6)] = value
    const [uri, local] = name(head[1], ns)
    const node = { qname: head[1], uri, local, ns, attrs: new Map(), children: [], text: '' }
    for (const [key, value] of attributes) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue
      const [au, al] = name(key, ns, true), full = `${au}|${al}`
      if (node.attrs.has(full)) throw photoError('INVALID_METADATA', 'XMP 同一命名空间属性重复')
      node.attrs.set(full, value)
    }
    stack.at(-1).children.push(node)
    if (!/\/\s*>$/.test(part)) stack.push(node)
  }
  if (cursor !== xml.length || stack.length !== 1 || root.children.length !== 1) throw photoError('INVALID_METADATA', 'XMP 不完整')
  const values = new Map(), directories = []
  function set(key, value) {
    if (values.has(key) && values.get(key) !== value) throw photoError('INVALID_METADATA', 'XMP 实况字段冲突')
    values.set(key, value)
  }
  function visit(node) {
    if ([NS.camera, NS.oplus, NS.note].includes(node.uri) && !node.children.length) set(`${node.uri}|${node.local}`, node.text.trim())
    for (const [key, value] of node.attrs) if ([NS.camera, NS.oplus, NS.note].some((ns) => key.startsWith(`${ns}|`))) set(key, value)
    if (node.uri === NS.container && node.local === 'Directory') directories.push(node)
    node.children.forEach(visit)
  }
  root.children.forEach(visit)
  if (directories.length > 1) throw photoError('INVALID_METADATA', 'XMP 有多个实况目录')
  const items = []
  function collect(node) {
    if (node.uri === NS.container && node.local === 'Item') {
      const item = {}
      for (const [key, value] of node.attrs) if (key.startsWith(`${NS.item}|`)) item[key.slice(NS.item.length + 1)] = value
      for (const child of node.children) if (child.uri === NS.item) {
        if (item[child.local] != null && item[child.local] !== child.text.trim()) throw photoError('INVALID_METADATA', 'XMP 目录字段冲突')
        item[child.local] = child.text.trim()
      }
      items.push(item)
    }
    node.children.forEach(collect)
  }
  directories.forEach(collect)
  return { values, items }
}

function completeXmp(packets, extensions) {
  const references = packets.flatMap((packet) => {
    const id = parseXmp(packet).values.get(`${NS.note}|HasExtendedXMP`)
    return id ? [id.toUpperCase()] : []
  })
  if (!references.length && !extensions.length) return packets
  if (references.length !== 1 || !/^[A-F0-9]{32}$/.test(references[0]) || !extensions.length || extensions.length > 32) throw photoError('INVALID_METADATA', '扩展 XMP 关联不完整或存在多个候选')
  const prefixLength = 'http://ns.adobe.com/xmp/extension/\0'.length
  const parts = extensions.map((bytes) => {
    if (bytes.length < prefixLength + 40 || text(bytes.subarray(prefixLength, prefixLength + 32)).toUpperCase() !== references[0]) throw photoError('INVALID_METADATA', '扩展 XMP GUID 不一致')
    return { total: uint(bytes, prefixLength + 32), start: uint(bytes, prefixLength + 36), data: bytes.subarray(prefixLength + 40) }
  }).sort((a, b) => a.start - b.start)
  const length = parts[0].total
  if (!length || length > 512 * 1024) throw photoError('RESOURCE_LIMIT', '扩展 XMP 超过 512KiB')
  const joined = new Uint8Array(length); let at = 0
  for (const part of parts) {
    if (part.total !== length || part.start !== at || at + part.data.length > length) throw photoError('INVALID_METADATA', '扩展 XMP 分片重叠、缺失或越界')
    joined.set(part.data, at); at += part.data.length
  }
  if (at !== length) throw photoError('INVALID_METADATA', '扩展 XMP 分片未收齐')
  return [...packets, text(joined)]
}

export async function jpegInfo(reader, start = 0, metadata = true) {
  if (uint(await reader.read(start, 2), 0, 2) !== 0xffd8) throw photoError('INVALID_IMAGE', 'JPEG 头无效')
  const xmp = [], exif = [], extensions = []
  let at = start + 2, segments = 0
  while (at < reader.size) {
    if (++segments > 4096) throw photoError('RESOURCE_LIMIT', 'JPEG 段数量过多')
    let head = await reader.read(at, 2)
    if (head[0] !== 255) throw photoError('INVALID_IMAGE', 'JPEG 标记无效')
    while (head[1] === 255) { at++; head = await reader.read(at, 2) }
    const marker = head[1]; at += 2
    if (marker === 0xd9) return { end: at, xmp: completeXmp(xmp, extensions), exif }
    if (marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) throw photoError('INVALID_IMAGE', 'JPEG 段顺序无效')
    const length = uint(await reader.read(at, 2), 0, 2)
    if (length < 2 || at + length > reader.size) throw photoError('INVALID_IMAGE', 'JPEG 段被截断')
    if (metadata && marker === 0xe1) {
      const data = await reader.read(at + 2, length - 2), prefix = text(data.subarray(0, 35))
      if (prefix.startsWith('Exif\0')) exif.push(data.slice())
      else if (prefix.startsWith('http://ns.adobe.com/xap/1.0/\0')) xmp.push(text(data.subarray(29)))
      else if (prefix.startsWith('http://ns.adobe.com/xmp/extension/')) extensions.push(data.slice())
    }
    at += length
    if (marker !== 0xda) continue
    // 熵编码扫描按页进行；跳过转义 FF00 和重启标记，正确处理多扫描 JPEG。
    let found = false
    while (at < reader.size && !found) {
      const data = await reader.read(at, Math.min(65536 - at % 65536, reader.size - at))
      let i = 0
      for (; i < data.length; i++) {
        if (data[i] !== 255) continue
        const next = i + 1 < data.length ? data[i + 1] : (await reader.read(at + i + 1, 1))[0]
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { i++; continue }
        if (next === 255) continue
        at += i; found = true; break
      }
      if (!found) at += i
    }
  }
  throw photoError('INVALID_IMAGE', 'JPEG 缺少结束标记')
}

export async function heifMetadata(reader, meta) {
  const children = await boxes(reader, meta.data + 4, meta.end)
  const iinf = children.find((b) => b.type === 'iinf'), iloc = children.find((b) => b.type === 'iloc')
  if (!iinf || !iloc) return { exif: [], xmp: [] }
  const h = await reader.read(iinf.data, 8), entries = await boxes(reader, iinf.data + (h[0] ? 8 : 6), iinf.end)
  if (entries.length > 1024) throw photoError('RESOURCE_LIMIT', 'HEIF 项目数量过多')
  const wanted = new Map()
  for (const entry of entries) {
    if (entry.type !== 'infe') continue
    const data = await reader.read(entry.data, entry.end - entry.data), version = data[0]
    if (![2, 3].includes(version)) continue
    const idSize = version === 2 ? 2 : 4, id = uint(data, 4, idSize), type = text(data.subarray(6 + idSize, 10 + idSize))
    if (type === 'Exif' || (type === 'mime' && text(data.subarray(10 + idSize)).includes('application/rdf+xml'))) wanted.set(id, type)
  }
  const data = await reader.read(iloc.data, iloc.end - iloc.data), version = data[0]
  if (![0, 1, 2].includes(version)) throw photoError('UNSUPPORTED_LAYOUT', '暂不支持此 HEIF iloc 版本')
  const offsetSize = data[4] >> 4, lengthSize = data[4] & 15, baseSize = data[5] >> 4, indexSize = version ? data[5] & 15 : 0
  let at = 6
  const itemCount = uint(data, at, version < 2 ? 2 : 4); at += version < 2 ? 2 : 4
  if (itemCount > 2048) throw photoError('RESOURCE_LIMIT', 'HEIF 定位条目过多')
  const result = { exif: [], xmp: [] }
  for (let i = 0; i < itemCount; i++) {
    const id = uint(data, at, version < 2 ? 2 : 4); at += version < 2 ? 2 : 4
    const construction = version ? uint(data, at, 2) & 15 : 0; if (version) at += 2
    const reference = uint(data, at, 2); at += 2
    const base = uint(data, at, baseSize); at += baseSize
    const extentCount = uint(data, at, 2); at += 2
    if (extentCount > 4096) throw photoError('RESOURCE_LIMIT', 'HEIF extent 数量过多')
    const parts = []; let total = 0
    for (let j = 0; j < extentCount; j++) {
      if (indexSize) { uint(data, at, indexSize); at += indexSize }
      const offset = uint(data, at, offsetSize); at += offsetSize
      const length = uint(data, at, lengthSize); at += lengthSize
      if (!wanted.has(id)) continue
      if (reference || construction > 1 || !length || ++total > 8) throw photoError('UNSUPPORTED_LAYOUT', 'HEIF 元数据 extent 不受支持')
      const idat = children.find((b) => b.type === 'idat')
      if (construction === 1 && !idat) throw photoError('INVALID_METADATA', 'HEIF 缺少 idat')
      const start = base + offset + (construction ? idat.data : 0)
      if (construction && start + length > idat.end) throw photoError('INVALID_RANGE', 'HEIF 元数据超出 idat')
      parts.push(await reader.read(start, length))
    }
    if (parts.length) {
      const length = parts.reduce((sum, part) => sum + part.length, 0)
      if (length > 2 * 1024 * 1024) throw photoError('RESOURCE_LIMIT', 'HEIF 元数据过大')
      const joined = new Uint8Array(length); let position = 0
      for (const part of parts) { joined.set(part, position); position += part.length }
      result[wanted.get(id) === 'Exif' ? 'exif' : 'xmp'].push(wanted.get(id) === 'Exif' ? joined : text(joined))
    }
  }
  return result
}

async function movieIdentifier(reader, parent, depth = 0) {
  let identifier = ''
  for (const box of await boxes(reader, parent.data + (parent.type === 'meta' ? 4 : 0), parent.end, depth)) {
    if (['moov', 'udta', 'meta'].includes(box.type)) {
      const id = await movieIdentifier(reader, box, depth + 1)
      if (id) { if (identifier && id !== identifier) throw photoError('INVALID_METADATA', '视频实况标识冲突'); identifier = id }
    }
    if (box.type !== 'keys' || parent.type !== 'meta') continue
    const keyBytes = await reader.read(box.data, box.end - box.data), count = uint(keyBytes, 4)
    if (count > 1024) throw photoError('RESOURCE_LIMIT', 'QuickTime keys 过多')
    let at = 8, index = -1
    for (let i = 1; i <= count; i++) {
      const length = uint(keyBytes, at)
      if (length < 8 || at + length > keyBytes.length) throw photoError('INVALID_METADATA', 'QuickTime keys 被截断')
      if (text(keyBytes.subarray(at + 8, at + length)) === 'com.apple.quicktime.content.identifier') index = i
      at += length
    }
    if (index < 0) continue
    const ilst = (await boxes(reader, parent.data + 4, parent.end, depth)).find((b) => b.type === 'ilst')
    if (!ilst) continue
    // ilst 的项目类型是数值索引，不是 ASCII fourcc。
    for (let p = ilst.data; p < ilst.end;) {
      const head = await reader.read(p, 8), size = uint(head)
      if (size < 8 || p + size > ilst.end) throw photoError('INVALID_METADATA', 'QuickTime ilst 长度无效')
      if (uint(head, 4) === index) {
        for (const value of await boxes(reader, p + 8, p + size, depth + 1)) if (value.type === 'data') {
          const id = contentId(text(await reader.read(value.data + 8, value.end - value.data - 8)))
          if (!id || (identifier && identifier !== id)) throw photoError('INVALID_METADATA', '视频实况标识无效或冲突')
          identifier = id
        }
      }
      p += size
    }
  }
  return identifier
}
export async function videoIdentifier(reader, top) {
  const ids = []
  for (const box of top) if (box.type === 'moov') ids.push(await movieIdentifier(reader, box))
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length > 1) throw photoError('INVALID_METADATA', '视频有多个实况标识')
  return unique[0] || ''
}
export async function validateMotion(reader, start, length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 24 || start + length > reader.size) throw photoError('INVALID_RANGE', '动态分量长度或范围无效')
  const top = await boxes(reader, start, start + length)
  if (top[0]?.type !== 'ftyp' || top[0].size < 16 || !top.some((b) => b.type === 'mdat' && b.size > b.header)) throw photoError('INVALID_VIDEO', '动态分量缺少有效视频容器')
  const brand = text(await reader.read(top[0].data, 4))
  if (/^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/.test(brand)) throw photoError('INVALID_VIDEO', '图片容器不能作为动态视频')
  let videoTrack = false
  for (const moov of top.filter((b) => b.type === 'moov')) {
    for (const trak of (await boxes(reader, moov.data, moov.end)).filter((b) => b.type === 'trak')) {
      for (const mdia of (await boxes(reader, trak.data, trak.end)).filter((b) => b.type === 'mdia')) {
        for (const hdlr of (await boxes(reader, mdia.data, mdia.end)).filter((b) => b.type === 'hdlr')) {
          if (hdlr.end - hdlr.data >= 12 && text(await reader.read(hdlr.data + 8, 4)) === 'vide') videoTrack = true
        }
      }
    }
  }
  if (!videoTrack) throw photoError('INVALID_VIDEO', '动态分量没有视频轨道，或初始化信息不完整')
  return { start, length, type: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' }
}
