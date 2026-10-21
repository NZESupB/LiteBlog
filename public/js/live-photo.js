// 多端实况统一入口：先检测和提取，再交给图片压缩及视频上传。
import { isImageFile, isVideoFile, mediaStem } from './media.js'
import { NS, PhotoReader, text, uint, decimal, photoError, boxAt, boxes, jpegInfo, heifMetadata, exifIdentifier, parseXmp, videoIdentifier, validateMotion } from './live-photo-binary.js'

const inspectedFiles = new WeakMap()
const warning = (code, message, blocking = true) => ({ code, message, recoverable: true, blocking })
const imageBrands = /^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/
function mergeMetadata(packets) {
  const values = new Map(); let items = []
  for (const packet of packets) {
    const parsed = parseXmp(packet)
    for (const [key, value] of parsed.values) {
      if (values.has(key) && values.get(key) !== value) throw photoError('INVALID_METADATA', '多个 XMP 数据包中的实况字段冲突')
      values.set(key, value)
    }
    if (parsed.items.length) {
      if (items.length && JSON.stringify(items) !== JSON.stringify(parsed.items)) throw photoError('INVALID_METADATA', '多个 XMP 实况目录冲突')
      items = parsed.items
    }
  }
  return { values, items }
}
async function samsungRange(reader) {
  if (reader.size < 20) return null
  const tail = await reader.read(reader.size - 8, 8)
  if (text(tail.subarray(4)) !== 'SEFT') return null
  const length = uint(tail, 0, 4, true), directoryStart = reader.size - 8 - length
  if (length < 12 || length > 65536 || directoryStart < 0) throw photoError('INVALID_METADATA', 'Samsung SEF 目录长度无效')
  const directory = await reader.read(directoryStart, length)
  if (text(directory.subarray(0, 4)) !== 'SEFH') throw photoError('INVALID_METADATA', 'Samsung SEF 目录头无效')
  const count = uint(directory, 8, 4, true)
  if (12 + count * 12 > length) throw photoError('INVALID_METADATA', 'Samsung SEF 目录被截断')
  let range = null, coverEnd = directoryStart
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 12, type = uint(directory, at + 2, 2, true)
    const back = uint(directory, at + 4, 4, true), size = uint(directory, at + 8, 4, true), start = directoryStart - back
    if (start < 0 || size < 8 || size > back) throw photoError('INVALID_RANGE', 'Samsung SEF 数据范围无效')
    coverEnd = Math.min(coverEnd, start)
    if (type !== 0x0a30) continue
    if (range) throw photoError('AMBIGUOUS_MOTION', 'Samsung 文件包含多个实况视频')
    const header = await reader.read(start, 8), nameLength = uint(header, 4, 4, true)
    if (nameLength > 256 || nameLength > size - 8 || text(await reader.read(start + 8, nameLength)) !== 'MotionPhoto_Data') throw photoError('INVALID_METADATA', 'Samsung 实况数据项无效')
    const offset = start + 8 + nameLength, videoLength = size - 8 - nameLength
    if (videoLength === 12) {
      const pointer = await reader.read(offset, 12)
      if (text(pointer.subarray(0, 4)) !== 'mpv2') throw photoError('UNSUPPORTED_LAYOUT', '未知 Samsung 视频指针格式')
      range = { start: uint(pointer, 4), length: uint(pointer, 8) }
    } else range = { start: offset, length: videoLength }
  }
  if (!range) throw photoError('MISSING_MOTION', 'Samsung SEF 中没有可用实况视频')
  return { ...range, coverEnd: Math.min(coverEnd, range.start), format: 'samsung-sef' }
}
async function huaweiRange(reader) {
  if (reader.size < 60) return null
  const tail = text(await reader.read(reader.size - 60, 60))
  if (!/^v\d+_f/.test(tail) || !tail.slice(40).startsWith('LIVE_')) return null
  const match = /^LIVE_(\d+)\s*$/.exec(tail.slice(40))
  if (!match) throw photoError('INVALID_METADATA', '华为/荣耀 LIVE 尾标长度无效')
  const length = decimal(match[1]) - 20
  return { start: reader.size - 60 - length, length, format: 'huawei-live' }
}
async function directoryRange(reader, items, primaryEnd, values, imageType) {
  if (items.length < 2 || items.length > 16 || items[0].Semantic !== 'Primary' || items[0].Mime !== imageType || decimal(items[0].Length, 0) !== 0) throw photoError('UNSUPPORTED_LAYOUT', '不支持此实况目录的主图布局')
  let at = reader.size, video = null
  const ranges = []
  for (let i = items.length - 1; i > 0; i--) {
    const item = items[i], length = decimal(item.Length), padding = decimal(item.Padding, 0)
    at -= padding + length
    if (!length || at < primaryEnd) throw photoError('INVALID_RANGE', '实况目录范围与静态图片重叠')
    ranges.unshift({ ...item, start: at, length })
    if (item.Semantic === 'MotionPhoto') {
      if (video || !['video/mp4', 'video/quicktime'].includes(item.Mime)) throw photoError('AMBIGUOUS_MOTION', '实况目录视频重复或类型不支持')
      video = { start: at, length }
    } else if (item.Semantic !== 'GainMap' || item.Mime !== 'image/jpeg') throw photoError('UNSUPPORTED_LAYOUT', '实况目录包含暂不支持的辅助数据')
  }
  // Primary.Length=0 时保留 JPEG EOI 后的厂商辅助数据（如 Pixel aecDebug），只禁止重叠。
  if (at - decimal(items[0].Padding, 0) < primaryEnd || !video) throw photoError('INVALID_RANGE', '实况目录长度与完整图片边界不一致')
  for (const item of ranges) {
    if (item.Semantic === 'GainMap') {
      if (item.start > video.start || (await jpegInfo(reader, item.start, false)).end !== item.start + item.length) throw photoError('INVALID_IMAGE', 'HDR 增益图边界无效')
    }
  }
  const oplusLength = values.get(`${NS.oplus}|VideoLength`)
  if (oplusLength != null) {
    const length = decimal(oplusLength)
    if (!length || length > video.length) throw photoError('INVALID_RANGE', 'OPPO 实际视频长度超出目录范围')
    video.length = length
  }
  return { ...video, format: oplusLength != null ? 'oplus-container' : 'android-container' }
}

export async function inspectLivePhoto(file, { signal } = {}) {
  signal?.throwIfAborted()
  if (!file || typeof file.slice !== 'function') throw new TypeError('需要 File 或 Blob 输入')
  const reader = new PhotoReader(file, signal)
  const result = { kind: isVideoFile(file) ? 'video' : 'image', imageType: file.type || '', format: 'plain', identifier: '', motionRange: null, stillEnd: file.size, warnings: [], metadataInvalid: false, videoValid: false }
  inspectedFiles.set(result, file)
  try {
    const head = await reader.read(0, Math.min(32, file.size))
    const jpeg = head[0] === 255 && head[1] === 216
    const bmff = text(head.subarray(4, 8)) === 'ftyp'
    const brandAt = bmff && uint(head) === 1 ? 16 : 8
    const brand = bmff ? text(head.subarray(brandAt, brandAt + 4)) : ''
    if (!jpeg && !(bmff && imageBrands.test(brand))) {
      if (bmff) {
        result.kind = 'video'
        await validateMotion(reader, 0, file.size); result.videoValid = true
        result.identifier = await videoIdentifier(reader, await boxes(reader, 0, file.size))
      } else if (!isImageFile(file) && !isVideoFile(file)) throw photoError('UNSUPPORTED_FORMAT', '不支持此文件类型，请选择图片、MOV 或 MP4 原件')
      if (result.kind === 'image' && !result.imageType) {
        if (head[0] === 137 && text(head.subarray(1, 4)) === 'PNG') result.imageType = 'image/png'
        else if (text(head.subarray(0, 3)) === 'GIF') result.imageType = 'image/gif'
        else if (text(head.subarray(0, 4)) === 'RIFF' && text(head.subarray(8, 12)) === 'WEBP') result.imageType = 'image/webp'
      }
      return result
    }
    result.kind = 'image'
    result.imageType = jpeg ? 'image/jpeg' : /^avi/.test(brand) ? 'image/avif' : 'image/heic'
    result.format = jpeg ? 'jpeg' : 'heif'
    let metadata = { exif: [], xmp: [] }, primaryEnd = 0, mpvd = null, appended = null
    if (jpeg) {
      const info = await jpegInfo(reader)
      primaryEnd = info.end; metadata = info
    } else {
      let at = 0
      while (at < reader.size) {
        // 华为 HEIF 的视频以第二个 ftyp 开始，厂商尾部不属于图片容器。
        if (at && reader.size - at >= 8 && text((await reader.read(at, 8)).subarray(4)) === 'ftyp') { appended = at; break }
        if (reader.size - at === 60 && /^v\d+_f/.test(text(await reader.read(at, 8)))) break
        const box = await boxAt(reader, at)
        if (box.type === 'meta') metadata = await heifMetadata(reader, box)
        if (box.type === 'mpvd') {
          if (mpvd || box.end !== reader.size) throw photoError('UNSUPPORTED_LAYOUT', 'HEIF 实况 mpvd 必须唯一且位于文件尾部')
          mpvd = box; break
        }
        if (box.type === 'sefd') { appended = at; break }
        at = box.end; primaryEnd = at
      }
    }
    for (const exif of metadata.exif) {
      const id = exifIdentifier(exif)
      if (id && result.identifier && id !== result.identifier) throw photoError('INVALID_METADATA', '静态图实况标识冲突')
      result.identifier ||= id
    }
    const { values, items } = mergeMetadata(metadata.xmp)
    const value = (key) => values.get(`${NS.camera}|${key}`)
    for (const key of ['MotionPhoto', 'MicroVideo']) if (value(key) != null && !['0', '1'].includes(value(key))) throw photoError('INVALID_METADATA', '实况开关值无效')
    if (value('MotionPhoto') === '0' || (value('MotionPhoto') == null && value('MicroVideo') === '0')) {
      result.motionDisabled = true
      return result
    }
    let candidate = null
    const proprietary = !mpvd && !items.length ? await samsungRange(reader) || await huaweiRange(reader) : null
    if (mpvd) {
      if (items.length && (items.length !== 2 || items[0].Semantic !== 'Primary' || items[0].Mime !== result.imageType || decimal(items[0].Length, 0) !== 0 || decimal(items[0].Padding, 0) !== mpvd.header || items[1].Semantic !== 'MotionPhoto' || items[1].Mime !== 'video/mp4' || decimal(items[1].Length) !== mpvd.end - mpvd.data || decimal(items[1].Padding, 0) !== 0)) throw photoError('INVALID_METADATA', 'HEIF 实况目录与 mpvd 数据范围不一致')
      candidate = { start: mpvd.data, length: mpvd.end - mpvd.data, coverEnd: mpvd.start, format: 'heif-mpvd' }
    }
    else if (items.length) {
      if (!jpeg) throw photoError('UNSUPPORTED_LAYOUT', 'HEIF 标准实况缺少 mpvd box')
      candidate = await directoryRange(reader, items, primaryEnd, values, result.imageType)
    } else if (proprietary) candidate = proprietary
    else if (value('MicroVideoOffset') != null) {
      const length = decimal(value('MicroVideoOffset'))
      candidate = { start: reader.size - length, length, format: 'microvideo-offset' }
    } else {
      // 只在完整静态容器外尝试，不在像素、EXIF 或 HEIC mdat 内搜索。
      let at = appended ?? primaryEnd
      if (jpeg) {
        for (let i = 0; i < 8 && at + 2 <= reader.size && uint(await reader.read(at, 2), 0, 2) === 0xffd8; i++) at = (await jpegInfo(reader, at, false)).end
      }
      if (at < reader.size) {
        const suffix = await reader.read(at, Math.min(65536, reader.size - at))
        const marker = text(suffix.subarray(0, 11)) === 'cameralbum!' ? 11 : 0
        let skip = marker
        while (skip < Math.min(suffix.length, 4096) && text(suffix.subarray(skip + 4, skip + 8)) !== 'ftyp' && suffix[skip] === 0) skip++
        if (text(suffix.subarray(skip + 4, skip + 8)) === 'ftyp') candidate = { start: at + skip, length: reader.size - at - skip, format: 'appended-mp4' }
        else if (reader.size > at + 16) result.warnings.push(warning('UNKNOWN_TRAILER', '图片含无法识别的尾部数据；请重选原件，或确认仅保留静态图'))
      }
    }
    if (!candidate) {
      if (value('MotionPhoto') === '1' || value('MicroVideo') === '1') throw photoError('MISSING_MOTION', '有实况标记，但没有收到完整动态分量')
      return result
    }
    const coverEnd = candidate.coverEnd ?? candidate.start
    if (candidate.start < primaryEnd || coverEnd < primaryEnd || coverEnd > candidate.start) throw photoError('INVALID_RANGE', '动态分量与静态图片范围重叠')
    result.motionRange = await validateMotion(reader, candidate.start, candidate.length)
    result.kind = 'live'; result.format = candidate.format; result.stillEnd = coverEnd
    if (candidate.format === 'appended-mp4') result.warnings.push(warning('RECOVERED_MOTION', '动态分量由完整图片外的视频容器定位，未依赖厂商标记', false))
  } catch (error) {
    if (signal?.aborted) throw error
    result.metadataInvalid = true
    result.warnings.push(warning(error.code || 'READ_ERROR', error.message || '读取实况照片失败'))
  }
  return result
}

export async function extractLivePhoto(file, inspection, { signal } = {}) {
  signal?.throwIfAborted()
  if (!inspection || inspectedFiles.get(inspection) !== file) inspection = await inspectLivePhoto(file, { signal })
  const source = { format: inspection.format, originalName: file.name || 'photo', pairing: inspection.motionRange ? 'embedded' : null, motionRange: inspection.motionRange }
  const output = { kind: inspection.kind, original: file, still: null, motion: null, video: null, source, warnings: [...inspection.warnings] }
  if (inspection.kind === 'video') output.video = file
  else {
    const stem = String(file.name || 'photo').replace(/\.[^.]+$/, ''), type = inspection.imageType
    output.still = inspection.motionRange || (type && type !== file.type)
      ? new File([file.slice(0, inspection.stillEnd)], `${stem}.${({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' })[type] || 'heic'}`, { type, lastModified: file.lastModified }) : file
    if (inspection.motionRange) {
      const { start, length, type: videoType } = inspection.motionRange
      output.motion = new File([file.slice(start, start + length)], `${stem}.motion.${videoType === 'video/quicktime' ? 'mov' : 'mp4'}`, { type: videoType, lastModified: file.lastModified })
    }
  }
  signal?.throwIfAborted()
  return output
}

export async function normalizeMediaFiles(files, { signal, onProgress } = {}) {
  const list = [...new Set(files)], records = []
  // 顺序解析限制内存和读取并发；每个文件返回结构化错误，不吞掉其他文件。
  for (const file of list) {
    signal?.throwIfAborted()
    const inspection = await inspectLivePhoto(file, { signal })
    records.push({ file, inspection, output: await extractLivePhoto(file, inspection, { signal }), pair: null })
    onProgress?.({ completed: records.length, total: list.length })
  }
  const stills = records.filter((r) => r.output.still && !r.output.motion && !r.inspection.motionDisabled)
  const videos = records.filter((r) => r.output.video)
  function mark(rows, code, message) { for (const row of rows) if (!row.output.warnings.some((w) => w.code === code)) row.output.warnings.push(warning(code, message, false)) }
  function pair(still, video, method) {
    still.pair = video; video.pair = still
    still.output.motion = video.output.video; still.output.kind = 'live'; still.output.source.pairing = method
    still.output.warnings.push(...video.output.warnings)
  }
  const ids = new Set(stills.map((r) => r.inspection.identifier).filter(Boolean))
  for (const id of ids) {
    const images = stills.filter((r) => r.inspection.identifier === id), motions = videos.filter((r) => r.inspection.identifier === id)
    if (images.length === 1 && motions.length === 1 && !images[0].inspection.metadataInvalid && !motions[0].inspection.metadataInvalid && motions[0].inspection.videoValid) pair(images[0], motions[0], 'identifier')
    else if (motions.length) mark([...images, ...motions], 'AMBIGUOUS_PAIR', '同一内容标识有多个或无效候选，已保留为独立媒体')
  }
  const stems = new Set(stills.filter((r) => !r.pair).map((r) => mediaStem(r.file.name)).filter(Boolean))
  for (const stem of stems) {
    const images = stills.filter((r) => !r.pair && mediaStem(r.file.name) === stem), motions = videos.filter((r) => !r.pair && mediaStem(r.file.name) === stem)
    if (!motions.length) continue
    if (images.length !== 1 || motions.length !== 1) { mark([...images, ...motions], 'AMBIGUOUS_PAIR', '同名文件有多个候选，已保留为独立媒体'); continue }
    const [still] = images, [video] = motions
    const a = still.inspection, b = video.inspection
    if (a.identifier && b.identifier && a.identifier !== b.identifier) { mark([still, video], 'PAIR_ID_CONFLICT', '照片与视频内容标识不一致，未自动配对'); continue }
    if (a.metadataInvalid || b.metadataInvalid || !b.videoValid) continue
    if (still.output.warnings.some((w) => w.code === 'AMBIGUOUS_PAIR') || video.output.warnings.some((w) => w.code === 'AMBIGUOUS_PAIR')) continue
    pair(still, video, 'filename')
  }
  for (const still of stills) if (!still.pair && still.inspection.identifier && !still.output.warnings.some((w) => w.blocking)) still.output.warnings.push(warning('MISSING_PAIRED_VIDEO', '此照片有 Live Photo 标识，但没有收到唯一的配对视频；请同时选择原照片和 MOV，或仅保留静态图'))
  const emitted = new Set(), output = []
  for (const row of records) {
    const image = row.output.video && row.pair ? row.pair : row
    if (emitted.has(image)) continue
    emitted.add(image); output.push(image.output)
  }
  return output
}
